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
// A wallet does not know which of the two it is. Nothing inside a slot says "main" or "decoy", and no
// screen of an open wallet can write the other slot: the decoy is chosen when the file is made (a wallet
// created or imported on this device) and at no other time. Until 0.18 an open wallet could set up or
// replace the duress wallet, which meant it had to know its own role (stored in the slot), and a decoy
// asked to do it could only overwrite itself: its passphrase then stopped working, which told whoever
// was holding the phone that it was the decoy (external review 2026-11-27, item 4). Two slots cannot
// make that operation look the same from both wallets, so the operation is gone.
//
// A slot's salt is kept for the life of its passphrase. The slot's key is what the biometric wrap and the
// side stores' key are made from; a save under a fresh salt changed that key and left the side stores
// (contacts, tokens, allowed sites, names) unreadable at the next unlock (same review, item 3). A save
// takes a fresh IV only. The salt changes when the passphrase does, and the stores are sealed again then.
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

export interface VaultData {
  version: 1;
  seedHex: string;
  accounts: AccountRecord[];
  createdAt: string;
  /** legacy (written until 0.18): which of the two wallets this is. Never written now and removed at the next unlock: it told a decoy apart for anyone with its passphrase and the stored file. */
  role?: "main" | "decoy";
  /** legacy (written until 0.13): a main wallet once recorded that it had a decoy. Never written now; removed at the next unlock. */
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

async function encryptBytes(plaintext: Uint8Array, passphrase: string, iterations: number, salt: Uint8Array = randomBytes(16)): Promise<EncryptedVault> {
  const iv = randomBytes(12);
  const key = await deriveAesKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource));
  plaintext.fill(0);
  return { v: 1, kdf: "PBKDF2-SHA256", iterations, saltHex: bytesToHex(salt), ivHex: bytesToHex(iv), ciphertextHex: bytesToHex(ct) };
}

/** What is written into a slot: the wallet without the legacy fields that told a main wallet from a decoy. */
function stored(data: VaultData): string {
  const { role: _role, hasDecoy: _hasDecoy, ...clean } = data;
  return JSON.stringify(clean);
}

/** A slot for a NEW passphrase (a new wallet, or a changed passphrase): fresh salt, so a new slot key. */
export async function encryptVault(data: VaultData, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<EncryptedVault> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  return encryptBytes(padded(stored(data)), passphrase, iterations);
}

/**
 * The same slot with new contents, under the SAME passphrase: its salt and iteration count are kept, so
 * the slot key (and with it the biometric wrap and the side stores' key) stays what it was; only the IV is
 * new. This is what every save of an open wallet uses.
 */
export async function reencryptVault(previous: EncryptedVault, data: VaultData, passphrase: string): Promise<EncryptedVault> {
  if (previous.v !== 1 || previous.kdf !== "PBKDF2-SHA256") throw new Error("unknown vault format");
  return encryptBytes(padded(stored(data)), passphrase, previous.iterations, hexToBytes(previous.saltHex));
}

/**
 * True when an opened slot should be written again as it is (reencryptVault): it still carries a legacy
 * field, or it is not the size slots have now (4 KiB until 0.14). Done at unlock for whichever wallet
 * opened, so nothing a wallet was written with in an older version stays behind to tell it apart.
 */
export function needsRewrite(enc: EncryptedVault, data: VaultData): boolean {
  return data.role !== undefined || data.hasDecoy !== undefined || enc.ciphertextHex.length !== 2 * (PAD_BLOCK + 16);
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

/**
 * A new file for a fresh wallet: the wallet in a random slot; in the other, the duress wallet when one was
 * chosen, else filler. This is the only place a duress wallet is ever written.
 */
export async function newFile(
  data: VaultData,
  passphrase: string,
  iterations = PBKDF2_ITERATIONS,
  duress?: { data: VaultData; passphrase: string },
): Promise<{ file: VaultFile; slot: number; key: Uint8Array }> {
  if (duress && duress.passphrase.normalize("NFKD") === passphrase.normalize("NFKD")) throw new Error("the duress passphrase must differ from the main one");
  const slot = randomBytes(1)[0]! % SLOT_COUNT;
  const slots: EncryptedVault[] = [];
  let duressPlaced = false;
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (i === slot) slots.push(await encryptVault(data, passphrase, iterations));
    else if (duress && !duressPlaced) {
      slots.push(await encryptVault(duress.data, duress.passphrase, iterations));
      duressPlaced = true;
    } else slots.push(await fillerSlot(iterations));
  }
  const key = await deriveSlotKeyBytes(slots[slot]!, passphrase);
  return { file: { v: 2, slots }, slot, key };
}

/** The same file with one slot replaced (the others are untouched: their passphrases are not known here). */
export function withSlot(file: VaultFile, index: number, slot: EncryptedVault): VaultFile {
  if (index < 0 || index >= file.slots.length) throw new Error("no such slot");
  return { v: 2, slots: file.slots.map((s, i) => (i === index ? slot : s)) };
}

/** True when the passphrase opens the given slot. */
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
