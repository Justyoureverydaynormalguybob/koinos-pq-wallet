// Key rules shared by the browser wallet and the phone app. Keep this file boring and exact: it is the spec.
//
//   24 words  <->  32-byte seed  ->  ML-DSA-44 key pair (FIPS 204 KeyGen with that seed)  ->  address
//
// - The 24 words are a BIP-39 mnemonic whose entropy IS the seed, so a seed from the koinos-pq CLI
//   (`pq.seedHex` in .keys.<network>.json) can be shown as words and words can be turned back into
//   that exact seed. No passphrase, no derivation path: one seed, one key.
// - The address is derived from the 1312-byte public key exactly as Koinos derives it from a
//   secp256k1 key (0x00 || ripemd160(sha256(key)) || checksum, base58), which is what koilib's
//   bitcoinAddress() computes and what the native node path (koinos-chain ml-dsa-44) checks.
// - Accounts that use the contract route (pqwallet) needed a secp256k1 key once, to upload the
//   contract. That key is derived from the same seed with a domain tag so the seed stays the one
//   thing to back up.
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { generateMnemonic, mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Signer, utils } from "koilib";

export const SEED_BYTES = 32;
export const PK_BYTES = 1312;
export const SK_BYTES = 2560;
export const SIG_BYTES = 2420;

export interface PqKeys {
  seed: Uint8Array;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** base58 Koinos address of the ML-DSA-44 key (the native-path account) */
  address: string;
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256); // 24 words, 32 bytes of entropy
}

export function normalizeMnemonic(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function isMnemonic(input: string): boolean {
  const m = normalizeMnemonic(input);
  return m.split(" ").length === 24 && validateMnemonic(m, wordlist);
}

export function mnemonicToSeed(mnemonic: string): Uint8Array {
  const m = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(m, wordlist)) throw new Error("not a valid 24-word phrase");
  const seed = mnemonicToEntropy(m, wordlist);
  if (seed.length !== SEED_BYTES) throw new Error("phrase must have 24 words");
  return seed;
}

export function seedToMnemonic(seed: Uint8Array): string {
  if (seed.length !== SEED_BYTES) throw new Error("seed must be 32 bytes");
  return entropyToMnemonic(seed, wordlist);
}

/** Accepts the CLI's 64-hex seed or a 24-word phrase. */
export function parseSeedInput(input: string): Uint8Array {
  const t = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return hexToBytes(t.replace(/^0x/, "").toLowerCase());
  return mnemonicToSeed(t);
}

export function deriveKeys(seed: Uint8Array): PqKeys {
  if (seed.length !== SEED_BYTES) throw new Error("seed must be 32 bytes");
  const k = ml_dsa44.keygen(seed);
  if (k.publicKey.length !== PK_BYTES || k.secretKey.length !== SK_BYTES) throw new Error("unexpected ML-DSA-44 key size");
  return { seed, publicKey: k.publicKey, secretKey: k.secretKey, address: utils.bitcoinAddress(k.publicKey) };
}

/** Address for any ML-DSA-44 public key, the same bytes the node derives. */
export function addressOf(publicKey: Uint8Array): string {
  return utils.bitcoinAddress(publicKey);
}

/**
 * The one-time secp256k1 key a contract-route (pqwallet) account is created with. Derived from the
 * seed through a domain tag so it can never be confused with the seed itself. Only needed to upload
 * and register; after `lock` it has no power over the account.
 */
export function bootstrapSigner(seed: Uint8Array): Signer {
  return Signer.fromSeed(`${bytesToHex(seed)}:koinos-pq:secp256k1`);
}

export function wipe(...arrays: Uint8Array[]): void {
  for (const a of arrays) a.fill(0);
}

export { bytesToHex, hexToBytes };
