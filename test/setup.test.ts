import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { utils } from "koilib";
import { deriveKeys } from "../src/core/keys";
import { CONTEXT_POP, CONTEXT_PQWALLET, proofOfPossession } from "../src/core/sign";
import { bootstrapAddress, setupCosts } from "../src/core/setup";
import { PQWALLET_WASM_SHA256 } from "../src/contract/provenance";
import abi from "../src/contract/pqwallet.abi.json";

const keys = deriveKeys(sha256(utf8ToBytes("koinos-pq native vector key A")));

describe("pqwallet account setup", () => {
  it("proof of possession signs the 25 address bytes under koinos/pqwallet/1/pop only", () => {
    const account = bootstrapAddress(keys);
    const addr = utils.decodeBase58(account);
    expect(addr.length).toBe(25);
    const proof = proofOfPossession(addr, keys);
    expect(proof.length).toBe(2420);
    expect(ml_dsa44.verify(proof, addr, keys.publicKey, { context: CONTEXT_POP })).toBe(true);
    expect(ml_dsa44.verify(proof, addr, keys.publicKey, { context: CONTEXT_PQWALLET })).toBe(false);
    expect(() => proofOfPossession(addr.subarray(0, 24), keys)).toThrow();
  });

  it("bootstrap address is deterministic and is not the post-quantum address", () => {
    expect(bootstrapAddress(keys)).toBe(bootstrapAddress(keys));
    expect(bootstrapAddress(keys)).not.toBe(keys.address);
    expect(utils.isChecksumAddress(bootstrapAddress(keys))).toBe(true);
  });

  it("bundled contract matches its recorded hash and the ABI is koilib-shaped", () => {
    const wasm = readFileSync(new URL("../src/contract/pqwallet.wasm", import.meta.url));
    expect(bytesToHex(sha256(new Uint8Array(wasm)))).toBe(PQWALLET_WASM_SHA256);
    const methods = (abi as { methods: Record<string, { entry_point?: number; read_only?: boolean }> }).methods;
    expect(methods.set_public_key?.entry_point).toBe(0x4cc6c61b);
    expect(methods.get_info?.read_only).toBe(true);
    expect(methods.get_public_key?.entry_point).toBe(0x96634f68);
  });

  it("costs: devnet fits under its 10 M mana cap, real networks need about 6.6 KOIN", () => {
    const d = setupCosts("devnet");
    expect(d.deployRc + d.registerRc).toBeLessThanOrEqual(10_000_000n);
    const t = setupCosts("testnet");
    expect(t.requiredMana).toBe(660_000_000n);
    expect(setupCosts("mainnet")).toEqual(t);
  });
});
