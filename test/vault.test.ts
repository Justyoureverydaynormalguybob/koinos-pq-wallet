import { describe, expect, it } from "vitest";
import {
  PAD_BLOCK, SLOT_COUNT, decryptVault, deriveSlotKeyBytes, encryptVault, fillerSlot, needsRewrite, newFile, openVault, opens, reencryptVault, toFile, withSlot, type EncryptedVault, type VaultData,
} from "../src/core/vault";

const IT = 20_000; // fewer PBKDF2 iterations: test speed only
const data: VaultData = {
  version: 1,
  seedHex: "00".repeat(32),
  accounts: [{ label: "pqwallet account", mode: "pqwallet", address: "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t" }],
  createdAt: "2026-10-18T00:00:00.000Z",
};
const decoy: VaultData = { version: 1, seedHex: "11".repeat(32), accounts: [], createdAt: "2026-10-19T00:00:00.000Z" };

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

  it("a duress wallet is written when the file is made, into the other slot; each passphrase opens its own", async () => {
    const { file, slot } = await newFile(data, "correct horse battery", IT, { data: decoy, passphrase: "a different passphrase" });
    expect(file.slots.length).toBe(SLOT_COUNT);
    const asMain = await openVault(file, "correct horse battery");
    expect(asMain.slot).toBe(slot);
    expect(asMain.data.seedHex).toBe(data.seedHex);
    const asDecoy = await openVault(file, "a different passphrase");
    expect(asDecoy.slot).not.toBe(slot);
    expect(asDecoy.data.seedHex).toBe(decoy.seedHex);
    // the same passphrase for both would make the second wallet unreachable: refused
    await expect(newFile(data, "correct horse battery", IT, { data: decoy, passphrase: "correct horse battery" })).rejects.toThrow(/differ/);
  });

  it("nothing in a slot says which wallet it is: the two decrypt to the same fields, and a legacy role is never written", async () => {
    const { file } = await newFile({ ...data, role: "main", hasDecoy: true }, "correct horse battery", IT, { data: { ...decoy, role: "decoy" }, passphrase: "a different passphrase" });
    const a = (await openVault(file, "correct horse battery")).data, b = (await openVault(file, "a different passphrase")).data;
    expect(Object.keys(a).sort()).toEqual(["accounts", "createdAt", "seedHex", "version"]);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  });

  it("a save under the same passphrase keeps the slot's salt, so its key stays the same (external review 2026-11-27, item 3)", async () => {
    const { file, slot } = await newFile(data, "correct horse battery", IT);
    const before = file.slots[slot]!;
    const after = await reencryptVault(before, { ...data, accounts: [] }, "correct horse battery");
    expect(after.saltHex).toBe(before.saltHex);
    expect(after.iterations).toBe(before.iterations);
    expect(after.ivHex).not.toBe(before.ivHex);
    expect(after.ciphertextHex).not.toBe(before.ciphertextHex);
    const k1 = await deriveSlotKeyBytes(before, "correct horse battery"), k2 = await deriveSlotKeyBytes(after, "correct horse battery");
    expect(Buffer.from(k2).toString("hex")).toBe(Buffer.from(k1).toString("hex"));
    expect((await decryptVault(after, "correct horse battery")).accounts).toEqual([]);
    // a new passphrase is a new slot: fresh salt, another key
    const changed = await encryptVault(data, "another passphrase here", IT);
    expect(changed.saltHex).not.toBe(before.saltHex);
  });

  it("a slot written by an older version is written again at unlock: legacy role, or the 4 KiB size", async () => {
    const now = await encryptVault(data, "correct horse battery", IT);
    expect(needsRewrite(now, await decryptVault(now, "correct horse battery"))).toBe(false);
    expect(needsRewrite(now, { ...data, role: "decoy" })).toBe(true);
    expect(needsRewrite(now, { ...data, hasDecoy: true })).toBe(true);
    const old = { ...now, ciphertextHex: "00".repeat(4096 + 16) };
    expect(needsRewrite(old, data)).toBe(true);
    // rewriting keeps the key and drops the mark
    const again = await reencryptVault(now, { ...data, role: "decoy" }, "correct horse battery");
    expect((await decryptVault(again, "correct horse battery")).role).toBeUndefined();
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
