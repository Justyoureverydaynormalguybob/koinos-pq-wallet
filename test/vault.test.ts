import { describe, expect, it } from "vitest";
import { decryptVault, encryptVault, type VaultData } from "../src/core/vault";

const data: VaultData = {
  version: 1,
  seedHex: "00".repeat(32),
  accounts: [{ label: "pqwallet account", mode: "pqwallet", address: "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t" }],
  createdAt: "2026-10-18T00:00:00.000Z",
};

describe("vault", () => {
  it("encrypts and decrypts with the passphrase", async () => {
    const enc = await encryptVault(data, "correct horse battery", 20_000); // fewer iterations: test speed only
    expect(enc.kdf).toBe("PBKDF2-SHA256");
    expect(enc.ciphertextHex).not.toContain(data.seedHex);
    const back = await decryptVault(enc, "correct horse battery");
    expect(back).toEqual(data);
  });

  it("rejects a wrong passphrase and a short one", async () => {
    const enc = await encryptVault(data, "correct horse battery", 20_000);
    await expect(decryptVault(enc, "correct horse batterx")).rejects.toThrow(/wrong passphrase/);
    await expect(encryptVault(data, "short", 20_000)).rejects.toThrow(/at least/);
  });

  it("uses a fresh salt and iv every time", async () => {
    const a = await encryptVault(data, "correct horse battery", 20_000);
    const b = await encryptVault(data, "correct horse battery", 20_000);
    expect(a.saltHex).not.toBe(b.saltHex);
    expect(a.ivHex).not.toBe(b.ivHex);
    expect(a.ciphertextHex).not.toBe(b.ciphertextHex);
  });
});
