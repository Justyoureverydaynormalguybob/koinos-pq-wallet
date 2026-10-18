// The vault: the seed and the account list, encrypted at rest with a passphrase.
//
//   key  = PBKDF2-SHA256(passphrase, salt, 600,000 iterations) -> 256-bit AES key
//   blob = AES-256-GCM(key, iv, JSON(vault))
//
// WebCrypto only, no custom crypto. The decrypted seed lives in memory while unlocked and is wiped on lock.
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { AccountMode } from "koinos-pq-core";

export interface AccountRecord {
  label: string;
  mode: AccountMode;
  /** native: the key's own address; pqwallet: the account that runs the contract with this key */
  address: string;
}

export interface VaultData {
  version: 1;
  seedHex: string;
  accounts: AccountRecord[];
  createdAt: string;
}

export interface EncryptedVault {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  saltHex: string;
  ivHex: string;
  ciphertextHex: string;
}

export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this environment");
  return s;
};

async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", utf8ToBytes(passphrase.normalize("NFKD")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVault(data: VaultData, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<EncryptedVault> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(passphrase, salt, iterations);
  const plaintext = utf8ToBytes(JSON.stringify(data));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource));
  plaintext.fill(0);
  return { v: 1, kdf: "PBKDF2-SHA256", iterations, saltHex: bytesToHex(salt), ivHex: bytesToHex(iv), ciphertextHex: bytesToHex(ct) };
}

/** Throws on a wrong passphrase (GCM authentication fails). */
export async function decryptVault(enc: EncryptedVault, passphrase: string): Promise<VaultData> {
  if (enc.v !== 1 || enc.kdf !== "PBKDF2-SHA256") throw new Error("unknown vault format");
  const key = await deriveAesKey(passphrase, hexToBytes(enc.saltHex), enc.iterations);
  let pt: ArrayBuffer;
  try {
    pt = await subtle().decrypt({ name: "AES-GCM", iv: hexToBytes(enc.ivHex) as BufferSource }, key, hexToBytes(enc.ciphertextHex) as BufferSource);
  } catch {
    throw new Error("wrong passphrase");
  }
  const data = JSON.parse(new TextDecoder().decode(pt)) as VaultData;
  if (data.version !== 1 || typeof data.seedHex !== "string" || !Array.isArray(data.accounts)) throw new Error("vault contents are not valid");
  return data;
}

// ---- storage (browser localStorage; every call guarded so a blocked store degrades to "no vault") ----
const STORAGE_KEY = "koinos-pq-wallet/vault";

export interface VaultStore {
  load(): EncryptedVault | null;
  save(enc: EncryptedVault): boolean;
  clear(): void;
}

export const localVaultStore: VaultStore = {
  load() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as EncryptedVault) : null;
    } catch {
      return null;
    }
  },
  save(enc) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(enc));
      return true;
    } catch {
      return false;
    }
  },
  clear() {
    try {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
  },
};
