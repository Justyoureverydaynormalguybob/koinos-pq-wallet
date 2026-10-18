// Transaction signing, both routes. Mirror this exactly in the phone app.
//
//   pqwallet (contract route, live on Harbinger and usable on mainnet today):
//     signature entry = ML-DSA-44 signature (2420 bytes) over the 34-byte tx id, context "koinos/pqwallet/1"
//     the account is an address that runs the koinos-pq `pqwallet` contract with this key registered
//
//   native (koinos-chain fork, branch ml-dsa-44; devnet today, mainnet once adopted):
//     signature entry = 0x01 || public key (1312) || ML-DSA-44 signature (2420) = 3733 bytes,
//     over the 34-byte tx id, context "koinos/tx/1"; the account is the key's own address
//
// Different contexts mean a signature made for one route can never be replayed on the other.
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { PK_BYTES, SIG_BYTES, type PqKeys } from "./keys";

export type AccountMode = "native" | "pqwallet";

export const CONTEXT_PQWALLET = utf8ToBytes("koinos/pqwallet/1");
export const CONTEXT_POP = utf8ToBytes("koinos/pqwallet/1/pop");
export const CONTEXT_NATIVE = utf8ToBytes("koinos/tx/1");

/**
 * Proof of possession for registering the key on a pqwallet account: the ML-DSA key signs the
 * account's 25 address bytes under its own context, so a public key can only be registered by
 * whoever holds the matching secret key, and the proof cannot be reused as a transaction signature.
 */
export function proofOfPossession(accountAddressBytes: Uint8Array, keys: PqKeys): Uint8Array {
  if (accountAddressBytes.length !== 25) throw new Error("account address must be 25 bytes");
  return ml_dsa44.sign(accountAddressBytes, keys.secretKey, { context: CONTEXT_POP });
}
export const NATIVE_TAG = 0x01;
export const NATIVE_ENTRY_BYTES = 1 + PK_BYTES + SIG_BYTES; // 3733

export function txIdBytes(txIdHex: string): Uint8Array {
  const id = hexToBytes(txIdHex.replace(/^0x/, ""));
  if (id.length !== 34 || id[0] !== 0x12 || id[1] !== 0x20) throw new Error("transaction id is not a sha2-256 multihash");
  return id;
}

/** Bytes to put in `transaction.signatures` for this account mode. */
export function signTxId(txIdHex: string, keys: PqKeys, mode: AccountMode): Uint8Array {
  const id = txIdBytes(txIdHex);
  if (mode === "pqwallet") {
    const sig = ml_dsa44.sign(id, keys.secretKey, { context: CONTEXT_PQWALLET });
    if (sig.length !== SIG_BYTES) throw new Error("unexpected signature size");
    return sig;
  }
  const sig = ml_dsa44.sign(id, keys.secretKey, { context: CONTEXT_NATIVE });
  const entry = new Uint8Array(NATIVE_ENTRY_BYTES);
  entry[0] = NATIVE_TAG;
  entry.set(keys.publicKey, 1);
  entry.set(sig, 1 + PK_BYTES);
  return entry;
}

/** Local check before broadcasting: the entry verifies under the right context and no other. */
export function verifyEntry(entry: Uint8Array, txIdHex: string, publicKey: Uint8Array, mode: AccountMode): boolean {
  const id = txIdBytes(txIdHex);
  if (mode === "pqwallet") {
    return entry.length === SIG_BYTES && ml_dsa44.verify(entry, id, publicKey, { context: CONTEXT_PQWALLET });
  }
  if (entry.length !== NATIVE_ENTRY_BYTES || entry[0] !== NATIVE_TAG) return false;
  const pk = entry.subarray(1, 1 + PK_BYTES);
  const sig = entry.subarray(1 + PK_BYTES);
  if (pk.length !== publicKey.length || !pk.every((b, i) => b === publicKey[i])) return false;
  return ml_dsa44.verify(sig, id, pk, { context: CONTEXT_NATIVE });
}
