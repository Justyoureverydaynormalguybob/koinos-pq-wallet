// Biometric unlock (native shells): the slot's AES key, wrapped under a random 32-byte key-wrapping key
// (KWK) that the platform keystore releases only to a biometric that passes: the KWK sits behind a
// keystore key with user authentication required and invalidation on enrolment change (Android: an RSA
// key that decrypts only inside a BiometricPrompt CryptoObject; iOS: a Keychain item guarded by
// biometryCurrentSet). The passphrase is never stored; biometrics open the slot with the same key the
// passphrase derives. A new fingerprint or face enrolled on the device kills the key: back to the passphrase.
//
// Duress mode stays indistinguishable: the stored blobs cover every slot, one real wrap and the others
// random bytes of the same length. Enabling biometrics from a wallet wraps that wallet's slot and
// replaces the other slots' blobs with filler, so biometrics open exactly one wallet, the last one that
// enabled them, and the stored bytes say nothing about which. A wallet re-encrypted with a fresh salt
// (every saved change) gets its wrap refreshed with the passphrase that saved it.
//
// Fail closed: any error, missing key or unknown blob falls back to the passphrase.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { SLOT_COUNT, decryptVaultWithKeyBytes, deriveSlotKeyBytes, type EncryptedVault, type Opened, type VaultFile } from "./vault";

/** Where the KWK lives: the device keystore, which shows the biometric prompt itself on get() (the plugin on native; fakes in tests). */
export interface KeyStore {
  /** null when no key is stored; rejects with a readable message when the prompt fails or the key was invalidated */
  get(reason: string): Promise<Uint8Array | null>;
  set(kwk: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}
export interface Biometry {
  /** whether the device has a strong biometric enrolled that the keystore can bind to */
  available(): Promise<boolean>;
  /** after available() said no: "enrol" when the device needs a (strong) biometric added, else a short reason */
  lastReason?: string | null;
}
/** The wrapped blobs, next to the vault in localStorage. */
export interface BlobStore {
  load(): string[] | null;
  save(blobs: string[]): void;
  clear(): void;
}

const IV = 12, KEY = 32, TAG = 16, SLOT_TAG = 32;
/** iv + wrapped key + GCM tag, then an HMAC of the slot key (says "this wrap is for this slot" to whoever holds the slot key, nothing to anyone else) */
const BLOB_BYTES = IV + KEY + TAG + SLOT_TAG;
const BLOBS_KEY = "koinos-pq-wallet/bio";
const slotTag = (slotKey: Uint8Array): Uint8Array => hmac(sha256, slotKey, utf8ToBytes("koinos-pq-wallet/bio-tag/1"));

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this environment");
  return s;
};

export const localBlobStore: BlobStore = {
  load() {
    try {
      const raw = globalThis.localStorage?.getItem(BLOBS_KEY);
      const v = raw ? (JSON.parse(raw) as { v: 1; blobs: string[] }) : null;
      return v && v.v === 1 && Array.isArray(v.blobs) && v.blobs.length === SLOT_COUNT && v.blobs.every((b) => typeof b === "string" && b.length === BLOB_BYTES * 2) ? v.blobs : null;
    } catch {
      return null;
    }
  },
  save(blobs) {
    try {
      globalThis.localStorage?.setItem(BLOBS_KEY, JSON.stringify({ v: 1, blobs }));
    } catch {
      /* no store: biometrics simply stay off */
    }
  },
  clear() {
    try {
      globalThis.localStorage?.removeItem(BLOBS_KEY);
    } catch {
      /* nothing to do */
    }
  },
};

async function kwkKey(kwk: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (kwk.length !== KEY) throw new Error("bad key-wrapping key");
  return subtle().importKey("raw", kwk as BufferSource, { name: "AES-GCM" }, false, [usage]);
}
async function wrap(kwk: Uint8Array, slotKey: Uint8Array): Promise<string> {
  const iv = randomBytes(IV);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await kwkKey(kwk, "encrypt"), slotKey as BufferSource));
  const out = new Uint8Array(BLOB_BYTES);
  out.set(iv);
  out.set(ct, IV);
  out.set(slotTag(slotKey), IV + ct.length);
  return bytesToHex(out);
}
async function unwrap(kwk: Uint8Array, blobHex: string): Promise<Uint8Array | null> {
  try {
    const b = hexToBytes(blobHex);
    if (b.length !== BLOB_BYTES) return null;
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: b.subarray(0, IV) as BufferSource }, await kwkKey(kwk, "decrypt"), b.subarray(IV, IV + KEY + TAG) as BufferSource);
    return new Uint8Array(pt);
  } catch {
    return null; // filler, or a blob from another KWK
  }
}
/** Whether a blob's tag is the one this slot key makes (constant-time compare). */
function tagged(blobHex: string, slotKey: Uint8Array): boolean {
  const b = hexToBytes(blobHex);
  if (b.length !== BLOB_BYTES) return false;
  const want = slotTag(slotKey), got = b.subarray(IV + KEY + TAG);
  let diff = 0;
  for (let i = 0; i < SLOT_TAG; i++) diff |= want[i]! ^ got[i]!;
  return diff === 0;
}
const filler = (): string => bytesToHex(randomBytes(BLOB_BYTES));

export interface BioDeps {
  blobs: BlobStore;
  keys: KeyStore;
  biometry: Biometry;
}

/** True when a wrapped key is stored on this device (for any slot). */
export const biometricsEnabled = (blobs: BlobStore): boolean => blobs.load() !== null;

/**
 * Wraps `slot`'s key (derived from the passphrase, which is checked by the derivation fitting the slot)
 * under the device KWK, creating the KWK if there is none; every other slot gets filler.
 */
export async function enableBiometrics(file: VaultFile, slot: number, passphrase: string, deps: Omit<BioDeps, "biometry">): Promise<void> {
  const enc = file.slots[slot];
  if (!enc) throw new Error("no such slot");
  const slotKey = await deriveSlotKeyBytes(enc, passphrase);
  try {
    await decryptVaultWithKeyBytes(enc, slotKey); // the passphrase must open this slot, not merely derive something
    // a fresh KWK every time biometrics are turned on: no prompt here, and whatever an older enrolment held is gone
    const kwk = randomBytes(KEY);
    await deps.keys.set(kwk);
    const blobs: string[] = [];
    for (let i = 0; i < file.slots.length; i++) blobs.push(i === slot ? await wrap(kwk, slotKey) : filler());
    deps.blobs.save(blobs);
    kwk.fill(0);
  } finally {
    slotKey.fill(0);
  }
}

/** Removes the wrapped keys and the device key. */
export async function disableBiometrics(deps: Omit<BioDeps, "biometry">): Promise<void> {
  deps.blobs.clear();
  try {
    await deps.keys.remove();
  } catch {
    /* the keystore entry may already be gone */
  }
}

/**
 * After a slot was re-encrypted (new salt) with the passphrase that opened it: if biometrics are on for
 * that slot, wrap the new key, else leave everything as it is. Never enables anything by itself.
 * With `previous` (the file as it was before the change) the question "are biometrics this slot's?" is
 * answered by the old slot key's tag and the wrap is renewed under a fresh device key, so no prompt;
 * without it the device key is fetched, which prompts.
 */
export async function refreshWrappedKey(file: VaultFile, slot: number, passphrase: string, deps: Omit<BioDeps, "biometry">, previous?: VaultFile): Promise<void> {
  const blobs = deps.blobs.load();
  if (!blobs) return;
  if (previous?.slots[slot]) {
    const oldKey = await deriveSlotKeyBytes(previous.slots[slot]!, passphrase);
    const mine = tagged(blobs[slot]!, oldKey);
    oldKey.fill(0);
    if (mine) await enableBiometrics(file, slot, passphrase, deps);
    return;
  }
  const kwk = await deps.keys.get("Keep biometric unlock working after this change").catch(() => null);
  if (!kwk) return;
  try {
    const current = await unwrap(kwk, blobs[slot]!);
    if (!current) return; // biometrics belong to another slot: nothing to refresh
    current.fill(0);
    const enc = file.slots[slot]!;
    const slotKey = await deriveSlotKeyBytes(enc, passphrase);
    blobs[slot] = await wrap(kwk, slotKey);
    slotKey.fill(0);
    deps.blobs.save(blobs);
  } finally {
    kwk.fill(0);
  }
}

/** When a slot is overwritten by something the current passphrase does not open (a new decoy): its blob becomes filler. */
export function forgetSlot(slot: number, blobs: BlobStore): void {
  const list = blobs.load();
  if (!list) return;
  list[slot] = filler();
  blobs.save(list);
}

/**
 * The biometric unlock: the OS prompt, then the KWK, then every blob is tried against its slot (all of
 * them, whatever happens, so the time taken does not say which slot is real). Returns null when
 * biometrics are not enabled; throws with a readable message when they are but did not open anything.
 */
export async function biometricUnlock(file: VaultFile, deps: BioDeps, reason = "Unlock the wallet"): Promise<Opened | null> {
  const blobs = deps.blobs.load();
  if (!blobs) return null;
  const kwk = await deps.keys.get(reason); // the OS prompt happens in here; a key the enrolment no longer matches is gone
  if (!kwk) throw new Error("The device key is gone; unlock with your passphrase and turn biometrics on again.");
  try {
    const results = await Promise.allSettled(
      file.slots.map(async (enc: EncryptedVault, i: number) => {
        const key = await unwrap(kwk, blobs[i]!);
        if (!key) throw new Error("filler");
        try {
          return { data: await decryptVaultWithKeyBytes(enc, key), key: Uint8Array.from(key) };
        } finally {
          key.fill(0);
        }
      }),
    );
    let opened: Opened | null = null;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status !== "fulfilled") continue;
      if (!opened) opened = { data: r.value.data, slot: i, key: r.value.key };
      else r.value.key.fill(0);
    }
    if (opened) return opened;
    throw new Error("Biometrics no longer match this wallet; unlock with your passphrase and turn them on again.");
  } finally {
    kwk.fill(0);
  }
}

// ---- the native plugin (plugins/pq-bio), loaded on demand so web bundles never carry it ----
export const nativeKeyStore: KeyStore = {
  async get(reason) {
    const { PqBio } = await import("../native/pq-bio");
    const r = await PqBio.get({ reason, title: "Sparán", cancel: "Use passphrase" });
    return typeof r.hex === "string" && /^[0-9a-f]{64}$/.test(r.hex) ? hexToBytes(r.hex) : null;
  },
  async set(kwk) {
    const { PqBio } = await import("../native/pq-bio");
    await PqBio.set({ hex: bytesToHex(kwk) });
  },
  async remove() {
    const { PqBio } = await import("../native/pq-bio");
    await PqBio.remove();
  },
};

export const nativeBiometry: Biometry = {
  lastReason: null,
  async available() {
    const { PqBio } = await import("../native/pq-bio");
    const r = await PqBio.available();
    nativeBiometry.lastReason = r.available ? null : (r.reason ?? "unavailable");
    return r.available;
  },
};
