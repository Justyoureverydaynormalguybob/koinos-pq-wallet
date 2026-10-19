import { describe, expect, it } from "vitest";
import {
  PAD_BLOCK, SLOT_COUNT, decoySlotFor, decryptVault, encryptVault, fillerSlot, newFile, openVault, opens, toFile, withSlot, type EncryptedVault, type VaultData,
} from "../src/core/vault";

const IT = 20_000; // fewer PBKDF2 iterations: test speed only
const data: VaultData = {
  version: 1,
  seedHex: "00".repeat(32),
  accounts: [{ label: "pqwallet account", mode: "pqwallet", address: "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t" }],
  createdAt: "2026-10-18T00:00:00.000Z",
  role: "main",
};
const decoy: VaultData = { version: 1, seedHex: "11".repeat(32), accounts: [], createdAt: "2026-10-19T00:00:00.000Z", role: "decoy" };

describe("vault", () => {
  it("encrypts and decrypts with the passphrase", async () => {
    const enc = await encryptVault(data, "correct horse battery", IT);
    expect(enc.kdf).toBe("PBKDF2-SHA256");
    expect(enc.ciphertextHex).not.toContain(data.seedHex);
    const back = await decryptVault(enc, "correct horse battery");
    expect(back).toEqual(data);
  });

  it("rejects a wrong passphrase and a short one", async () => {
    const enc = await encryptVault(data, "correct horse battery", IT);
    await expect(decryptVault(enc, "correct horse batterx")).rejects.toThrow(/wrong passphrase/);
    await expect(encryptVault(data, "short", IT)).rejects.toThrow(/at least/);
  });

  it("uses a fresh salt and iv every time", async () => {
    const a = await encryptVault(data, "correct horse battery", IT);
    const b = await encryptVault(data, "correct horse battery", IT);
    expect(a.saltHex).not.toBe(b.saltHex);
    expect(a.ivHex).not.toBe(b.ivHex);
    expect(a.ciphertextHex).not.toBe(b.ciphertextHex);
  });

  it("pads every slot to the same size, filler included, so sizes reveal nothing", async () => {
    const small = await encryptVault({ ...data, accounts: [] }, "correct horse battery", IT);
    const bigger = await encryptVault({ ...data, accounts: Array.from({ length: 12 }, (_, i) => ({ label: `account ${i}`, mode: "pqwallet" as const, address: "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t" })) }, "correct horse battery", IT);
    const filler = await fillerSlot(IT);
    const ctLen = (e: EncryptedVault) => e.ciphertextHex.length / 2 - 16; // minus the GCM tag
    expect(ctLen(small)).toBe(PAD_BLOCK);
    expect(ctLen(bigger)).toBe(PAD_BLOCK);
    expect(ctLen(filler)).toBe(PAD_BLOCK);
    expect(Object.keys(filler).sort()).toEqual(Object.keys(small).sort());
  });
});

describe("duress mode (slots)", () => {
  it("a new file has SLOT_COUNT same-shaped slots and only the right passphrase opens the wallet", async () => {
    const { file, slot } = await newFile(data, "correct horse battery", IT);
    expect(file.v).toBe(2);
    expect(file.slots.length).toBe(SLOT_COUNT);
    const o = await openVault(file, "correct horse battery");
    expect(o.slot).toBe(slot);
    expect(o.data).toEqual(data);
    await expect(openVault(file, "not the passphrase at all")).rejects.toThrow(/wrong passphrase/);
  });

  it("filler never opens: no passphrase decrypts it to a vault", async () => {
    const filler = await fillerSlot(IT);
    await expect(decryptVault(filler, "correct horse battery")).rejects.toThrow(/wrong passphrase/);
    expect(await opens(filler, "")).toBe(false);
  });

  it("a decoy with its own passphrase opens its own slot; the main passphrase still opens the main one", async () => {
    const { file, slot } = await newFile(data, "correct horse battery", IT);
    const target = decoySlotFor(slot, "main");
    expect(target).not.toBe(slot);
    const withDecoy = withSlot(file, target, await encryptVault(decoy, "a different passphrase", IT));
    const asMain = await openVault(withDecoy, "correct horse battery");
    expect(asMain.slot).toBe(slot);
    expect(asMain.data.role).toBe("main");
    const asDecoy = await openVault(withDecoy, "a different passphrase");
    expect(asDecoy.slot).toBe(target);
    expect(asDecoy.data.role).toBe("decoy");
    expect(asDecoy.data.seedHex).not.toBe(data.seedHex);
    // main slot bytes untouched by adding the decoy
    expect(withDecoy.slots[slot]).toEqual(file.slots[slot]);
  });

  it("from a decoy, 'set up a duress wallet' targets the decoy's own slot, never the main one", () => {
    expect(decoySlotFor(0, "decoy")).toBe(0);
    expect(decoySlotFor(1, "decoy")).toBe(1);
    expect(decoySlotFor(0, "main")).toBe(1);
    expect(decoySlotFor(1, "main")).toBe(0);
  });

  it("refuses to tell a decoy passphrase from the main one (same passphrase check)", async () => {
    const { file, slot } = await newFile(data, "correct horse battery", IT);
    expect(await opens(file.slots[slot]!, "correct horse battery")).toBe(true);
    expect(await opens(file.slots[slot]!, "a different passphrase")).toBe(false);
  });

  it("upgrades a pre-duress single-slot store value into a file that still opens", async () => {
    const legacy = await encryptVault({ version: 1, seedHex: data.seedHex, accounts: data.accounts, createdAt: data.createdAt }, "correct horse battery", IT);
    const file = await toFile(legacy);
    expect(file.slots.length).toBe(SLOT_COUNT);
    expect(file.slots[0]).toEqual(legacy);
    const o = await openVault(file, "correct horse battery");
    expect(o.slot).toBe(0);
    expect(o.data.role).toBeUndefined(); // old wallets have no role: treated as main
    expect(await toFile(file)).toBe(file);
  });

  it("withSlot rejects an index outside the file", async () => {
    const { file } = await newFile(data, "correct horse battery", IT);
    expect(() => withSlot(file, SLOT_COUNT, file.slots[0]!)).toThrow(/no such slot/);
  });
});
