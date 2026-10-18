import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { deriveKeys } from "../src/core/keys";
import { CONTEXT_NATIVE, CONTEXT_PQWALLET, NATIVE_ENTRY_BYTES, NATIVE_TAG, signTxId, txIdBytes, verifyEntry } from "../src/core/sign";

const keys = deriveKeys(sha256(utf8ToBytes("koinos-pq native vector key A")));
const txId = "0x1220" + bytesToHex(sha256(utf8ToBytes("koinos-pq native vector tx 1")));

describe("signing", () => {
  it("native entry: 0x01 || pk || sig, 3733 bytes, verifies under koinos/tx/1 only", () => {
    const entry = signTxId(txId, keys, "native");
    expect(entry.length).toBe(NATIVE_ENTRY_BYTES);
    expect(entry[0]).toBe(NATIVE_TAG);
    expect(bytesToHex(entry.subarray(1, 1313))).toBe(bytesToHex(keys.publicKey));
    const sig = entry.subarray(1313);
    expect(ml_dsa44.verify(sig, txIdBytes(txId), keys.publicKey, { context: CONTEXT_NATIVE })).toBe(true);
    expect(ml_dsa44.verify(sig, txIdBytes(txId), keys.publicKey, { context: CONTEXT_PQWALLET })).toBe(false);
    expect(verifyEntry(entry, txId, keys.publicKey, "native")).toBe(true);
    const bad = Uint8Array.from(entry);
    bad[1400] = (bad[1400] ?? 0) ^ 1;
    expect(verifyEntry(bad, txId, keys.publicKey, "native")).toBe(false);
  });

  it("pqwallet signature: raw 2420 bytes under koinos/pqwallet/1 only", () => {
    const sig = signTxId(txId, keys, "pqwallet");
    expect(sig.length).toBe(2420);
    expect(verifyEntry(sig, txId, keys.publicKey, "pqwallet")).toBe(true);
    expect(ml_dsa44.verify(sig, txIdBytes(txId), keys.publicKey, { context: CONTEXT_NATIVE })).toBe(false);
    const otherId = "0x1220" + bytesToHex(sha256(utf8ToBytes("another tx")));
    expect(verifyEntry(sig, otherId, keys.publicKey, "pqwallet")).toBe(false);
  });

  it("refuses a transaction id that is not a sha2-256 multihash", () => {
    expect(() => signTxId("0x" + "ab".repeat(32), keys, "native")).toThrow();
    expect(() => signTxId("0x1220" + "ab".repeat(31), keys, "native")).toThrow();
  });
});
