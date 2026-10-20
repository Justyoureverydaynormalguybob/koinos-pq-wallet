// The vault: the seed and the account list, encrypted at rest with a passphrase.
//
//   key  = PBKDF2-SHA256(passphrase, salt, 600,000 iterations) -> 256-bit AES key
//   blob = AES-256-GCM(key, iv, JSON(vault) padded to a 4 KiB multiple)
//
// Storage holds a FILE of exactly SLOT_COUNT slots, each a blob of the same shape and size. One slot is
// your wallet. The other is either random filler encrypted under a key nobody knows, or a DECOY wallet
// with its own seed and passphrase (duress mode). Unlocking tries every slot with the passphrase typed,
// always doing all the key derivations, so neither the stored bytes nor the unlock time say whether a
// decoy exists or which slot it is. What opens is whatever the passphrase opens.
//
// WebCrypto only, no custom crypto. The decrypted seed lives in memory while unlocked and is wiped on lock.
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { AccountMode } from "koinos-pq-core";

/** "watch" is an address the wallet shows but cannot sign for. */
export type WalletMode = AccountMode | "watch";

export interface AccountRecord {
  label: string;
  mode: WalletMode;
  /** native: the key's own address; pqwallet: the account that runs the contract with this key; watch: any address */
  address: string;
}

export type VaultRole = "main" | "decoy";

export interface VaultData {
  version: 1;
  seedHex: string;
  accounts: AccountRecord[];
  createdAt: string;
  /** absent in wallets saved before duress mode existed: treated as "main" */
  role?: VaultRole;
  /** main wallet only: a decoy has been written to the other slot (shown in Settings; a decoy never has this) */
  /** legacy (written until 0.13): a main wallet once recorded that it had a decoy; never written or read now, since it told the two apart */
  hasDecoy?: boolean;
}

/** One encrypted slot (also the whole stored value in the pre-duress format, v1). */
export interface EncryptedVault {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  saltHex: string;
  ivHex: string;
  ciphertextHex: string;
}

/** What is stored: a fixed number of same-shaped slots. */
export interface VaultFile {
  v: 2;
  slots: EncryptedVault[];
}

export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;
export const SLOT_COUNT = 2;
/** Plaintexts are padded to a multiple of this before encryption, so slot sizes reveal nothing. */
export const PAD_BLOCK = 8192;
/** Accounts per wallet, so the encrypted JSON always fits one pad block (slot sizes stay identical). */
export const MAX_ACCOUNTS = 24;

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

/** JSON followed by spaces up to a PAD_BLOCK multiple; JSON.parse ignores trailing whitespace. */
function padded(json: string): Uint8Array {
  const raw = utf8ToBytes(json);
  const total = Math.ceil((raw.length + 1) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total).fill(0x20);
  out.set(raw, 0);
  return out;
}

async function encryptBytes(plaintext: Uint8Array, passphrase: string, iterations: number): Promise<EncryptedVault> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource));
  plaintext.fill(0);
  return { v: 1, kdf: "PBKDF2-SHA256", iterations, saltHex: bytesToHex(salt), ivHex: bytesToHex(iv), ciphertextHex: bytesToHex(ct) };
}

export async function encryptVault(data: VaultData, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<EncryptedVault> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  return encryptBytes(padded(JSON.stringify(data)), passphrase, iterations);
}

/**
 * A slot that opens with no passphrase anyone knows: random bytes of a vault's padded size, encrypted
 * under a random 32-byte passphrase that is forgotten at once. Indistinguishable from a real slot.
 */
export async function fillerSlot(iterations = PBKDF2_ITERATIONS): Promise<EncryptedVault> {
  const throwaway = bytesToHex(randomBytes(32));
  return encryptBytes(randomBytes(PAD_BLOCK), throwaway, iterations);
}

/** Throws on a wrong passphrase (GCM authentication fails). */
export async function decryptVault(enc: EncryptedVault, passphrase: string): Promise<VaultData> {
  if (enc.v !== 1 || enc.kdf !== "PBKDF2-SHA256") throw new Error("unknown vault format");
  const key = await deriveAesKey(passphrase, hexToBytes(enc.saltHex), enc.iterations);
  return decryptWith(enc, key);
}

/**
 * The slot's AES key as raw bytes (the same PBKDF2 derivation decryptVault uses), for wrapping under a
 * device-held key so biometrics can open the slot without the passphrase. Wipe the result when done.
 */
export async function deriveSlotKeyBytes(enc: EncryptedVault, passphrase: string): Promise<Uint8Array> {
  if (enc.v !== 1 || enc.kdf !== "PBKDF2-SHA256") throw new Error("unknown vault format");
  const base = await subtle().importKey("raw", utf8ToBytes(passphrase.normalize("NFKD")), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(enc.saltHex) as BufferSource, iterations: enc.iterations }, base, 256);
  return new Uint8Array(bits);
}

/** Opens a slot with its raw AES key (from deriveSlotKeyBytes, unwrapped). Throws "wrong passphrase" if it does not fit. */
export async function decryptVaultWithKeyBytes(enc: EncryptedVault, keyBytes: Uint8Array): Promise<VaultData> {
  if (enc.v !== 1 || keyBytes.length !== 32) throw new Error("wrong passphrase");
  const key = await subtle().importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
  return decryptWith(enc, key);
}

async function decryptWith(enc: EncryptedVault, key: CryptoKey): Promise<VaultData> {
  let pt: ArrayBuffer;
  try {
    pt = await subtle().decrypt({ name: "AES-GCM", iv: hexToBytes(enc.ivHex) as BufferSource }, key, hexToBytes(enc.ciphertextHex) as BufferSource);
  } catch {
    throw new Error("wrong passphrase");
  }
  let data: VaultData;
  try {
    data = JSON.parse(new TextDecoder().decode(pt)) as VaultData;
  } catch {
    throw new Error("wrong passphrase"); // filler decrypts under its own key only; anything else is not JSON
  }
  if (data.version !== 1 || typeof data.seedHex !== "string" || !Array.isArray(data.accounts)) throw new Error("vault contents are not valid");
  return data;
}

export const roleOf = (v: VaultData): VaultRole => v.role ?? "main";

/** A legacy single-slot store value becomes a file by adding filler for the missing slots. */
export async function toFile(stored: VaultFile | EncryptedVault): Promise<VaultFile> {
  if ("slots" in stored && stored.v === 2) return stored;
  const legacy = stored as EncryptedVault;
  const slots: EncryptedVault[] = [legacy];
  while (slots.length < SLOT_COUNT) slots.push(await fillerSlot(legacy.iterations));
  return { v: 2, slots };
}

export interface Opened {
  data: VaultData;
  /** which slot the passphrase opened */
  slot: number;
  /** that slot's raw AES key (32 bytes): the sealed stores derive theirs from it. Wipe on lock. */
  key: Uint8Array;
}

/**
 * Tries the passphrase on every slot. All derivations run whatever happens, so the time taken does not
 * depend on which slot matched (or on none matching). Throws "wrong passphrase" when nothing opens.
 */
export async function openVault(file: VaultFile, passphrase: string): Promise<Opened> {
  const keys = await Promise.all(file.slots.map((s) => deriveSlotKeyBytes(s, passphrase).catch(() => new Uint8Array(32))));
  const results = await Promise.allSettled(file.slots.map((s, i) => decryptVaultWithKeyBytes(s, keys[i]!)));
  let opened: Opened | null = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled" && !opened) opened = { data: r.value, slot: i, key: keys[i]! };
    else keys[i]!.fill(0);
  }
  if (!opened) throw new Error("wrong passphrase");
  return opened;
}

/** A new file for a fresh wallet: the wallet in a random slot, filler in the others. */
export async function newFile(data: VaultData, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<{ file: VaultFile; slot: number; key: Uint8Array }> {
  const slot = randomBytes(1)[0]! % SLOT_COUNT;
  const slots: EncryptedVault[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) slots.push(i === slot ? await encryptVault(data, passphrase, iterations) : await fillerSlot(iterations));
  const key = await deriveSlotKeyBytes(slots[slot]!, passphrase);
  return { file: { v: 2, slots }, slot, key };
}

/** The same file with one slot replaced (the others are untouched: their passphrases are not known here). */
export function withSlot(file: VaultFile, index: number, slot: EncryptedVault): VaultFile {
  if (index < 0 || index >= file.slots.length) throw new Error("no such slot");
  return { v: 2, slots: file.slots.map((s, i) => (i === index ? slot : s)) };
}

/**
 * Which slot a decoy goes into. From the main wallet: the other slot (never its own). From a decoy: its
 * own slot, so a "set up duress wallet" done under duress looks and works the same but can never touch
 * the main wallet.
 */
export function decoySlotFor(openedSlot: number, role: VaultRole): number {
  if (role === "decoy") return openedSlot;
  return (openedSlot + 1) % SLOT_COUNT;
}

/** True when the passphrase opens the given slot (used to refuse a decoy passphrase equal to the main one). */
export async function opens(slot: EncryptedVault, passphrase: string): Promise<boolean> {
  try {
    await decryptVault(slot, passphrase);
    return true;
  } catch {
    return false;
  }
}

// ---- storage (browser localStorage; every call guarded so a blocked store degrades to "no vault") ----
const STORAGE_KEY = "koinos-pq-wallet/vault";

export interface VaultStore {
  /** v2 file, or a v1 single slot from a wallet saved before duress mode */
  load(): VaultFile | EncryptedVault | null;
  save(file: VaultFile): boolean;
  clear(): void;
}

export const localVaultStore: VaultStore = {
  load() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as VaultFile | EncryptedVault) : null;
    } catch {
      return null;
    }
  },
  save(file) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(file));
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
