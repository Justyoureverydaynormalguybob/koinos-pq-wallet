// Turning the wallet's key into a pqwallet account on a network: the one-time setup that the
// koinos-pq CLI does with `deploy --lock` and `register`, done in the browser.
//
//   1. The account is the address of the bootstrap secp256k1 key (derived from the seed). The user
//      funds it; mana is what the upload costs.
//   2. Upload the pqwallet contract to that address with call, transaction and upload authority all
//      governed by the contract from block one ("locked"); signed by the bootstrap key.
//   3. Register the ML-DSA-44 public key with a proof of possession; signed by the bootstrap key,
//      which the contract's legacy fallback accepts only while no key is registered.
//   4. Check the registered key is ours. From then on the account answers only to ML-DSA-44.
import { Contract, Transaction, utils } from "koilib";
import type { Chain } from "./chain";
import { bootstrapSigner, type PqKeys } from "./keys";
import { proofOfPossession } from "./sign";
import { loadPqwalletBytecode, pqwalletAbi } from "../contract";

export type SetupStep = "checking" | "uploading" | "registering" | "verifying" | "done";
export interface SetupStatus {
  step: SetupStep;
  message: string;
  txId?: string;
}
export interface SetupResult {
  account: string;
  uploadTx: string | null;
  registerTx: string | null;
}
export interface SetupCosts {
  deployRc: bigint;
  registerRc: bigint;
  /** mana the account should hold before starting (base units, 1e-8 KOIN) */
  requiredMana: bigint;
}

const ONE_KOIN = 100_000_000n;

/**
 * rc limits with headroom. Upload: 470 M on Harbinger. Register: the contract verifies the proof of
 * possession in interpreted WASM (about 6 M ticks, like a pqwallet transfer at 6.1 M), which is about
 * 40 M rc on Harbinger. The devnet charges 1 rc per tick and caps every account at 10 M, and its mempool
 * keeps each transaction's rc_limit reserved until the block is irreversible, so both must fit under 10 M.
 */
export function setupCosts(networkName: string): SetupCosts {
  if (networkName === "devnet") return { deployRc: 1_500_000n, registerRc: 8_000_000n, requiredMana: 9_500_000n };
  const deployRc = 6n * ONE_KOIN, registerRc = 60_000_000n;
  return { deployRc, registerRc, requiredMana: deployRc + registerRc };
}

export function bootstrapAddress(keys: PqKeys): string {
  return bootstrapSigner(keys.seed).getAddress();
}

export interface PqwalletInfo {
  deployed: boolean;
  keyRegistered: boolean;
}

/** get_info on the account; any failure to read it counts as "no contract there". */
export async function pqwalletInfo(chain: Chain, account: string): Promise<PqwalletInfo> {
  const c = new Contract({ id: account, abi: pqwalletAbi, provider: chain.provider });
  try {
    const { result } = await c.functions.get_info!({});
    return { deployed: true, keyRegistered: Boolean((result as { key_registered?: boolean } | undefined)?.key_registered) };
  } catch {
    return { deployed: false, keyRegistered: false };
  }
}

export async function registeredPublicKey(chain: Chain, account: string): Promise<Uint8Array | null> {
  const c = new Contract({ id: account, abi: pqwalletAbi, provider: chain.provider });
  const { result } = await c.functions.get_public_key!({});
  const pk = (result as { value?: string } | undefined)?.value; // get_public_key_result { bytes value = 1; }
  return pk ? utils.decodeBase64url(pk) : null;
}

export async function setupPqwalletAccount(chain: Chain, keys: PqKeys, onStatus: (s: SetupStatus) => void): Promise<SetupResult> {
  const signer = bootstrapSigner(keys.seed);
  signer.provider = chain.provider;
  const account = signer.getAddress();
  const costs = setupCosts(chain.net.name);
  let uploadTx: string | null = null;
  let registerTx: string | null = null;

  onStatus({ step: "checking", message: "Checking the account" });
  let info = await pqwalletInfo(chain, account);

  if (!info.deployed) {
    const mana = await chain.mana(account);
    if (mana < costs.deployRc) throw new Error(`the account needs more mana for the upload (has ${mana}, needs ${costs.deployRc} base units)`);
    onStatus({ step: "uploading", message: "Uploading the account contract, locked from the start" });
    const bytecode = await loadPqwalletBytecode();
    const c = new Contract({ id: account, abi: pqwalletAbi, provider: chain.provider, signer, bytecode });
    const { transaction } = await c.deploy({
      abi: JSON.stringify(pqwalletAbi),
      authorizesCallContract: true,
      authorizesTransactionApplication: true,
      authorizesUploadContract: true,
      rcLimit: costs.deployRc.toString(),
    });
    uploadTx = transaction!.id!;
    onStatus({ step: "uploading", message: "Upload submitted, waiting for a block", txId: uploadTx });
    await chain.waitMined(uploadTx);
    info = await pqwalletInfo(chain, account);
    if (!info.deployed) throw new Error("the contract was mined but cannot be read back; stop here and check the account");
  }

  if (!info.keyRegistered) {
    onStatus({ step: "registering", message: "Registering the post-quantum key" });
    const c = new Contract({ id: account, abi: pqwalletAbi, provider: chain.provider });
    const proof = proofOfPossession(utils.decodeBase58(account), keys);
    const { operation } = await c.functions.set_public_key!(
      { public_key: utils.encodeBase64url(keys.publicKey), proof: utils.encodeBase64url(proof) },
      { onlyOperation: true },
    );
    const tx: Record<string, unknown> = { header: { payer: account, rc_limit: costs.registerRc.toString() }, operations: [operation], signatures: [] };
    await Transaction.prepareTransaction(tx as never, chain.provider, account);
    const signed = await signer.signTransaction(tx as never); // bootstrap signature: the contract's legacy fallback, valid only before a key is registered
    await chain.provider.sendTransaction(signed);
    registerTx = (signed as { id: string }).id;
    onStatus({ step: "registering", message: "Registration submitted, waiting for a block", txId: registerTx });
    await chain.waitMined(registerTx);
    info = await pqwalletInfo(chain, account);
    if (!info.keyRegistered) throw new Error("registration was mined but the contract reports no key; stop here and check the account");
  }

  onStatus({ step: "verifying", message: "Checking the registered key is this wallet's" });
  const pk = await registeredPublicKey(chain, account);
  if (!pk || pk.length !== keys.publicKey.length || !pk.every((b, i) => b === keys.publicKey[i])) {
    throw new Error("this account is registered to a different post-quantum key; it was not added");
  }

  onStatus({ step: "done", message: "The account answers only to this wallet's ML-DSA-44 key" });
  return { account, uploadTx, registerTx };
}
