// Biometric unlock: the slot key wrapped under a device key, filler for the other slots, refresh after a
// re-encrypt, and the duress rules (one wallet at a time, nothing stored says which).
import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { biometricUnlock, biometricsEnabled, disableBiometrics, enableBiometrics, forgetSlot, refreshWrappedKey, type Biometry, type BlobStore, type KeyStore } from "../src/core/biometrics";
import { decoySlotFor, encryptVault, newFile, openVault, withSlot, type VaultData } from "../src/core/vault";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const ITER = 1000; // fast derivations in tests; the format is the same
const MAIN = "main passphrase 1234", DECOY = "decoy passphrase 5678";
const mainData: VaultData = { version: 1, seedHex: "11".repeat(32), accounts: [], createdAt: "2026-10-19", role: "main" };
const decoyData: VaultData = { version: 1, seedHex: "22".repeat(32), accounts: [], createdAt: "2026-10-19", role: "decoy" };

function fakes(opts: { available?: boolean; passPrompt?: boolean } = {}) {
  let blobs: string[] | null = null;
  let kwk: Uint8Array | null = null;
  let prompts = 0;
  const blobStore: BlobStore = { load: () => (blobs ? [...blobs] : null), save: (b) => void (blobs = [...b]), clear: () => void (blobs = null) };
  const keys: KeyStore = {
    get: async () => {
      prompts++; // the keystore shows the prompt itself
      if (opts.passPrompt === false) throw new Error("Cancelled; use your passphrase.");
      return kwk ? new Uint8Array(kwk) : null;
    },
    set: async (k) => void (kwk = new Uint8Array(k)),
    remove: async () => void (kwk = null),
  };
  const biometry: Biometry = { available: async () => opts.available ?? true };
  return { blobs: blobStore, keys, biometry, state: { get blobs() { return blobs; }, get kwk() { return kwk; }, get prompts() { return prompts; } } };
}

describe("biometric unlock", () => {
  it("enables for the opened slot, opens it after the prompt, and the other slot's blob is filler of the same size", async () => {
    const f = fakes();
    const { file, slot } = await newFile(mainData, MAIN, ITER);
    expect(biometricsEnabled(f.blobs)).toBe(false);
    expect(await biometricUnlock(file, f)).toBeNull(); // not enabled: no prompt, no error
    expect(f.state.prompts).toBe(0);
    await expect(enableBiometrics(file, slot, "wrong passphrase 000", f)).rejects.toThrow(/wrong passphrase/);
    expect(biometricsEnabled(f.blobs)).toBe(false);
    await enableBiometrics(file, slot, MAIN, f);
    expect(biometricsEnabled(f.blobs)).toBe(true);
    expect(f.state.blobs!.length).toBe(2);
    expect(f.state.blobs![0]!.length).toBe(f.state.blobs![1]!.length);
    expect(f.state.kwk!.length).toBe(32);
    const opened = await biometricUnlock(file, f);
    expect(opened?.slot).toBe(slot);
    expect(opened?.data.seedHex).toBe(mainData.seedHex);
    expect(opened?.key.length).toBe(32);
    expect(f.state.prompts).toBe(1); // enabling asked nothing; the unlock asked once
  });

  it("fails closed: a cancelled prompt, a missing device key or a foreign blob never opens anything", async () => {
    const { file, slot } = await newFile(mainData, MAIN, ITER);
    const cancelled = fakes({ passPrompt: false });
    await enableBiometrics(file, slot, MAIN, cancelled);
    await expect(biometricUnlock(file, cancelled)).rejects.toThrow(/Cancelled/);
    const lost = fakes();
    await enableBiometrics(file, slot, MAIN, lost);
    await lost.keys.remove();
    await expect(biometricUnlock(file, lost)).rejects.toThrow(/device key is gone/);
    // a different KWK (another device's blobs copied over): nothing unwraps
    const other = fakes();
    await enableBiometrics(file, slot, MAIN, other);
    await other.keys.set(new Uint8Array(32).fill(9));
    await expect(biometricUnlock(file, other)).rejects.toThrow(/no longer match/);
    // a re-encrypted slot (fresh salt) without a refresh: the old wrap no longer fits
    const stale = fakes();
    await enableBiometrics(file, slot, MAIN, stale);
    const reencrypted = withSlot(file, slot, await encryptVault(mainData, MAIN, ITER));
    await expect(biometricUnlock(reencrypted, stale)).rejects.toThrow(/no longer match/);
    // ... and with the refresh a saved change keeps biometrics working
    await refreshWrappedKey(reencrypted, slot, MAIN, stale);
    expect((await biometricUnlock(reencrypted, stale))?.slot).toBe(slot);
    await disableBiometrics(stale);
    expect(biometricsEnabled(stale.blobs)).toBe(false);
    expect(await biometricUnlock(reencrypted, stale)).toBeNull();
  });

  it("duress: biometrics belong to one wallet at a time; enabling from the decoy switches them to the decoy; a new decoy forgets its slot", async () => {
    const f = fakes();
    const { file: f0, slot: mainSlot } = await newFile(mainData, MAIN, ITER);
    const decoySlot = decoySlotFor(mainSlot, "main");
    const file = withSlot(f0, decoySlot, await encryptVault(decoyData, DECOY, ITER));
    expect((await openVault(file, DECOY)).slot).toBe(decoySlot);
    await enableBiometrics(file, mainSlot, MAIN, f);
    expect((await biometricUnlock(file, f))?.data.role).toBe("main");
    // refreshing the decoy's slot does nothing (biometrics are not its): the main still opens
    await refreshWrappedKey(file, decoySlot, DECOY, f);
    expect((await biometricUnlock(file, f))?.data.role).toBe("main");
    // under duress the decoy's user enables biometrics: now only the decoy opens, and the main's blob became filler
    const before = f.state.blobs![mainSlot];
    await enableBiometrics(file, decoySlot, DECOY, f);
    expect((await biometricUnlock(file, f))?.data.role).toBe("decoy");
    expect(f.state.blobs![mainSlot]).not.toBe(before);
    expect(f.state.blobs![mainSlot]!.length).toBe(f.state.blobs![decoySlot]!.length);
    // a decoy written over the slot that held biometrics: that slot is forgotten, nothing opens
    forgetSlot(decoySlot, f.blobs);
    await expect(biometricUnlock(file, f)).rejects.toThrow(/no longer match/);
  });
});
