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

export interface ResourcePrices {
  /** rc per byte of state written */
  disk: bigint;
  /** rc per byte of transaction */
  network: bigint;
  /** rc per compute tick */
  compute: bigint;
}

/**
 * What the two transactions use, from the Harbinger run (upload: 62,266 B bytecode + 3 KB ABI stored
 * and carried; register: the 1,312 B key stored, a 4 KB transaction, about 6.5 M ticks to verify the
 * proof of possession in interpreted WASM). Priced from the live resource market with a 25% margin:
 * the model gives 5.45 / 0.54 tKOIN where Harbinger charged 5.07 / 0.35.
 */
const UPLOAD_USAGE = { disk: 66_000n, network: 66_500n, compute: 2_500_000n };
const REGISTER_USAGE = { disk: 1_600n, network: 4_000n, compute: 6_500_000n };

export function setupCostsFromPrices(p: ResourcePrices): SetupCosts {
  const price = (u: { disk: bigint; network: bigint; compute: bigint }) => ((u.disk * p.disk + u.network * p.network + u.compute * p.compute) * 125n) / 100n;
  const deployRc = price(UPLOAD_USAGE), registerRc = price(REGISTER_USAGE);
  return { deployRc, registerRc, requiredMana: deployRc + registerRc };
}

/** Live prices from the node's resource market (chain.get_resource_limits). */
export async function estimateSetupCosts(chain: Chain): Promise<SetupCosts> {
  const r = (await chain.provider.call("chain.get_resource_limits", {})) as { resource_limit_data?: Record<string, string> };
  const l = r.resource_limit_data ?? {};
  const prices: ResourcePrices = { disk: BigInt(l.disk_storage_cost ?? "0"), network: BigInt(l.network_bandwidth_cost ?? "0"), compute: BigInt(l.compute_bandwidth_cost ?? "0") };
  if (prices.disk <= 0n || prices.network <= 0n || prices.compute <= 0n) throw new Error("could not read resource prices from the node");
  return setupCostsFromPrices(prices);
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

/**
 * The mempool keeps a transaction's whole rc_limit on hold until its block is irreversible (about
 * three minutes on mainnet and Harbinger) and the chain refuses a new transaction that would exceed
 * mana minus that hold with "insufficient pending account resources". After the upload this is
 * normal, so wait it out instead of failing.
 */
async function withManaHoldRetry<T>(fn: () => Promise<T>, onWait: (attempt: number) => void, tries = 36, delayMs = 10_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (!/insufficient pending account resources/.test(msg) || attempt >= tries) throw e;
      onWait(attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function setupPqwalletAccount(chain: Chain, keys: PqKeys, onStatus: (s: SetupStatus) => void): Promise<SetupResult> {
  const signer = bootstrapSigner(keys.seed);
  signer.provider = chain.provider;
  const account = signer.getAddress();
  const costs = await estimateSetupCosts(chain);
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
    const { transaction } = await withManaHoldRetry(
      () =>
        c.deploy({
          abi: JSON.stringify(pqwalletAbi),
          authorizesCallContract: true,
          authorizesTransactionApplication: true,
          authorizesUploadContract: true,
          rcLimit: costs.deployRc.toString(),
        }),
      (n) => onStatus({ step: "uploading", message: `Waiting for the network to release an earlier mana hold (try ${n}, up to a few minutes)` }),
    );
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
    await withManaHoldRetry(
      () => chain.provider.sendTransaction(signed),
      (n) => onStatus({ step: "registering", message: `Upload done. Waiting for the network to release the upload's mana hold before registering (try ${n}, up to a few minutes)` }),
    );
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
