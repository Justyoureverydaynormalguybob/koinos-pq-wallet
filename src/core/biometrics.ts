// Biometric unlock (native shells): the slot's AES key, wrapped under a random 32-byte key-wrapping key
// (KWK) that lives in the platform keystore and is handed over only after the OS biometric prompt. The
// passphrase is never stored; biometrics open the slot with the same key the passphrase derives.
//
// Duress mode stays indistinguishable: the stored blobs cover every slot, one real wrap and the others
// random bytes of the same length. Enabling biometrics from a wallet wraps that wallet's slot and
// replaces the other slots' blobs with filler, so biometrics open exactly one wallet, the last one that
// enabled them, and the stored bytes say nothing about which. A wallet re-encrypted with a fresh salt
// (every saved change) gets its wrap refreshed with the passphrase that saved it.
//
// Fail closed: any error, missing key or unknown blob falls back to the passphrase.
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { SLOT_COUNT, decryptVaultWithKeyBytes, deriveSlotKeyBytes, type EncryptedVault, type Opened, type VaultFile } from "./vault";

/** Where the KWK lives: the device keystore behind the biometric prompt (the plugins on native; fakes in tests). */
export interface KeyStore {
  get(): Promise<Uint8Array | null>;
  set(kwk: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}
export interface Biometry {
  available(): Promise<boolean>;
  /** resolves when the user passed the OS prompt; rejects (with a readable message) otherwise */
  authenticate(reason: string): Promise<void>;
}
/** The wrapped blobs, next to the vault in localStorage. */
export interface BlobStore {
  load(): string[] | null;
  save(blobs: string[]): void;
  clear(): void;
}

const IV = 12, KEY = 32, TAG = 16;
const BLOB_BYTES = IV + KEY + TAG;
const BLOBS_KEY = "koinos-pq-wallet/bio";

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
  const out = new Uint8Array(IV + ct.length);
  out.set(iv);
  out.set(ct, IV);
  return bytesToHex(out);
}
async function unwrap(kwk: Uint8Array, blobHex: string): Promise<Uint8Array | null> {
  try {
    const b = hexToBytes(blobHex);
    if (b.length !== BLOB_BYTES) return null;
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: b.subarray(0, IV) as BufferSource }, await kwkKey(kwk, "decrypt"), b.subarray(IV) as BufferSource);
    return new Uint8Array(pt);
  } catch {
    return null; // filler, or a blob from another KWK
  }
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
    let kwk = await deps.keys.get();
    if (!kwk || kwk.length !== KEY) {
      kwk = randomBytes(KEY);
      await deps.keys.set(kwk);
    }
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
 */
export async function refreshWrappedKey(file: VaultFile, slot: number, passphrase: string, deps: Omit<BioDeps, "biometry">): Promise<void> {
  const blobs = deps.blobs.load();
  const kwk = blobs ? await deps.keys.get().catch(() => null) : null;
  if (!blobs || !kwk) return;
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
  await deps.biometry.authenticate(reason);
  const kwk = await deps.keys.get();
  if (!kwk) throw new Error("The device key is gone; unlock with your passphrase and turn biometrics on again.");
  try {
    const results = await Promise.allSettled(
      file.slots.map(async (enc: EncryptedVault, i: number) => {
        const key = await unwrap(kwk, blobs[i]!);
        if (!key) throw new Error("filler");
        try {
          return await decryptVaultWithKeyBytes(enc, key);
        } finally {
          key.fill(0);
        }
      }),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled") return { data: r.value, slot: i };
    }
    throw new Error("Biometrics no longer match this wallet; unlock with your passphrase and turn them on again.");
  } finally {
    kwk.fill(0);
  }
}

// ---- the native plugins, loaded on demand so web bundles never carry them ----
const KWK_ITEM = "kwk";

export const nativeKeyStore: KeyStore = {
  async get() {
    const { SecureStorage, KeychainAccess } = await import("@aparajita/capacitor-secure-storage");
    await SecureStorage.setSynchronize(false); // never to iCloud
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly); // never into a backup restored elsewhere
    const v = await SecureStorage.get(KWK_ITEM);
    return typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? hexToBytes(v) : null;
  },
  async set(kwk) {
    const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
    await SecureStorage.setSynchronize(false);
    await SecureStorage.set(KWK_ITEM, bytesToHex(kwk));
  },
  async remove() {
    const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
    await SecureStorage.setSynchronize(false);
    await SecureStorage.remove(KWK_ITEM);
  },
};

export const nativeBiometry: Biometry = {
  async available() {
    const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
    const r = await BiometricAuth.checkBiometry();
    return r.isAvailable;
  },
  async authenticate(reason) {
    const { BiometricAuth, BiometryErrorType, AndroidBiometryStrength } = await import("@aparajita/capacitor-biometric-auth");
    try {
      await BiometricAuth.authenticate({
        reason,
        cancelTitle: "Use passphrase",
        allowDeviceCredential: false, // the device PIN is not the wallet's passphrase
        androidBiometryStrength: AndroidBiometryStrength.strong, // class 3 only: no camera-only face unlock
        iosFallbackTitle: "",
        androidTitle: "Sparán",
        androidSubtitle: reason,
        androidConfirmationRequired: false,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === BiometryErrorType.userCancel || code === BiometryErrorType.systemCancel || code === BiometryErrorType.appCancel) throw new Error("Cancelled; use your passphrase.");
      throw new Error(`Biometrics did not succeed (${(e as Error).message || code || "unknown"}); use your passphrase.`);
    }
  },
};
