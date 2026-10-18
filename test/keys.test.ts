import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { addressOf, bootstrapSigner, bytesToHex, deriveKeys, isMnemonic, mnemonicToSeed, newMnemonic, parseSeedInput, seedToMnemonic, SEED_BYTES } from "koinos-pq-core";

// The same deterministic keys koinos-chain's tests/include/koinos/tests/mldsa_vectors.hpp was generated from
// (koinos-pq cli/gen-native-vectors.mjs): seed = sha256(label). The node derives these addresses too.
const VECTORS = [
  { label: "koinos-pq native vector key A", address: "16MstbbgjE4fd9MWcpRi7S2gar5irDAXcy" },
  { label: "koinos-pq native vector key B", address: "1Ga8JAHF9A5psBsCt2f6hpDpX1S4XAyWuE" },
];

describe("keys", () => {
  it("derives the same addresses as the chain test vectors", () => {
    for (const v of VECTORS) {
      const k = deriveKeys(sha256(utf8ToBytes(v.label)));
      expect(k.address).toBe(v.address);
      expect(addressOf(k.publicKey)).toBe(v.address);
      expect(k.publicKey.length).toBe(1312);
      expect(k.secretKey.length).toBe(2560);
    }
  });

  it("round-trips 24 words <-> 32-byte seed, and accepts the CLI hex form", () => {
    const m = newMnemonic();
    expect(m.split(" ").length).toBe(24);
    expect(isMnemonic(m)).toBe(true);
    const seed = mnemonicToSeed(m);
    expect(seed.length).toBe(SEED_BYTES);
    expect(seedToMnemonic(seed)).toBe(m);
    expect(bytesToHex(parseSeedInput(bytesToHex(seed)))).toBe(bytesToHex(seed));
    expect(bytesToHex(parseSeedInput("0x" + bytesToHex(seed).toUpperCase()))).toBe(bytesToHex(seed));
    expect(bytesToHex(parseSeedInput("  " + m.toUpperCase().replace(/ /g, "   ") + "\n"))).toBe(bytesToHex(seed));
  });

  it("rejects bad phrases and bad seeds", () => {
    expect(() => mnemonicToSeed("abandon ".repeat(24).trim())).toThrow();
    expect(() => parseSeedInput("deadbeef")).toThrow();
    expect(isMnemonic("not a phrase")).toBe(false);
    expect(() => deriveKeys(new Uint8Array(31))).toThrow();
  });

  it("derives a deterministic secp256k1 bootstrap key that differs from the seed", () => {
    const seed = sha256(utf8ToBytes("koinos-pq native vector key A"));
    const a = bootstrapSigner(seed), b = bootstrapSigner(seed);
    expect(a.getAddress()).toBe(b.getAddress());
    expect(a.getPrivateKey("hex")).not.toBe(bytesToHex(seed));
    expect(a.getAddress()).not.toBe(deriveKeys(seed).address);
  });
});
