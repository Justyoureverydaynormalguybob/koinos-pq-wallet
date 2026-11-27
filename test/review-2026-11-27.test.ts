// The external review of 2026-11-27 (issue #1), pinned where the rules live: what a dapp may have signed,
// what the sheet says about it, and what the stored side stores look like from outside.
//   item 2   the chain id is the wallet's own, never the node's word alone
//   item 6   a transaction numbered ahead of the account's next one is not signed
//   item 8   the token standard's memo is read and shown, not called an unusual encoding
//   item 9   a request to see the accounts is answered with the addresses passed in, nothing more
//   item 11  signatures already on a transaction are kept and the wallet's is added
//   item 12  every side store entry has one size, also those written with the old padding
// The node is a small HTTP server in this process (koilib fetches through node-fetch, which no stub reaches).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { utils } from "koilib";
import { NETWORKS, TOKEN_ENTRY, concat, deriveKeys, fieldBytes, fieldVarint, verifyEntry, type Network } from "koinos-pq-core";
import { MAX_PAGE_SIGNATURES, executePlan, nonceValue, planRequest, sanitiseTx, strictTransfer, type DappRequest } from "../src/core/approval";
import { describeOperation, describePlan } from "../src/ui/approval-view";
import { LEGACY_SEAL_BLOCK, SEAL_BLOCK, SealedStore, fillerValue, lengthen, seal, storeKeyFrom, unseal } from "../src/core/sealed-store";
import type { BookStore } from "../src/core/addressbook";

const MAINNET_ID = NETWORKS.mainnet!.chainId!;
const DEVNET_ID = Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.alloc(32, 7)]).toString("base64url") + "==";
const keys = deriveKeys(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ME = keys.address; // on the devnet the key's own (native) address is an account the wallet signs for
const OTHER = "1sXttKzfrzH8amTpfRHX8SXT7kynjNpMX";
const KOIN = NETWORKS.devnet!.koin;

/** what the fake node says; each test sets what it needs */
const node = { chainId: DEVNET_ID, nonce: 4, calls: [] as string[] };
/** koinos.chain.value_type { uint64_value = 5 } */
const nonceOf = (n: number) => utils.encodeBase64url(fieldVarint(5, BigInt(n)));
let server: Server;
let net: Network;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { id: number; method: string };
      node.calls.push(r.method);
      const result =
        r.method === "chain.get_chain_id" ? { chain_id: node.chainId }
        : r.method === "chain.get_account_nonce" ? { nonce: nonceOf(node.nonce) }
        : r.method === "chain.get_account_rc" ? { rc: "1000000000" }
        : r.method === "chain.get_head_info" ? { head_topology: { height: "9" } }
        : r.method === "chain.read_contract" ? { result: "" }
        : {};
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  net = { ...NETWORKS.devnet!, rpc: [`http://127.0.0.1:${(server.address() as { port: number }).port}/`] };
});
afterAll(() => void server.close());

const transferArgs = (value: bigint, extra: Uint8Array[] = []) =>
  utils.encodeBase64url(concat([fieldBytes(1, utils.decodeBase58(ME)), fieldBytes(2, utils.decodeBase58(OTHER)), fieldVarint(3, value), ...extra]));
const transferOp = (args = transferArgs(100_000_000n)) => ({ call_contract: { contract_id: KOIN, entry_point: TOKEN_ENTRY.transfer as number, args } });
const sign = (transaction: Record<string, unknown>, command = "signer:signTransaction"): DappRequest => ({ id: "r1", command, args: { signerAddress: ME, transaction }, origin: "https://dapp.example" });

describe("item 2: which chain a signature is for", () => {
  it("a devnet node that answers with mainnet's chain id gets nothing signed", async () => {
    node.chainId = MAINNET_ID;
    // the scenario from the review: "try it on our devnet", a KOIN transfer, the node says it is mainnet
    await expect(planRequest(sign({ operations: [transferOp()] }), net)).rejects.toThrow(/chain id of mainnet/);
    // also when the page spells the chain id out itself
    await expect(planRequest(sign({ header: { chain_id: MAINNET_ID }, operations: [transferOp()] }), net)).rejects.toThrow(/chain id of mainnet/);
    node.chainId = DEVNET_ID;
  });

  it("on a pinned network the node's answer is not what decides: a lying node is refused, and the page's own chain id must be the pin", async () => {
    const testnet: Network = { ...NETWORKS.testnet!, rpc: net.rpc };
    node.chainId = MAINNET_ID; // a Harbinger node that says "mainnet"
    await expect(planRequest(sign({ operations: [transferOp()] }), testnet)).rejects.toThrow(/refusing/);
    node.chainId = NETWORKS.testnet!.chainId!;
    await expect(planRequest(sign({ header: { chain_id: MAINNET_ID }, operations: [transferOp()] }), testnet)).rejects.toThrow(/different network/);
    const ok = await planRequest(sign({ operations: [transferOp()] }), testnet);
    expect(ok.prepared?.header?.chain_id).toBe(NETWORKS.testnet!.chainId);
    node.chainId = DEVNET_ID;
  });

  it("a page's chain id for another network is refused on the devnet too, and an honest devnet still signs", async () => {
    await expect(planRequest(sign({ header: { chain_id: MAINNET_ID }, operations: [transferOp()] }), net)).rejects.toThrow(/different network/);
    const p = await planRequest(sign({ operations: [transferOp()] }), net);
    expect(p.prepared?.header?.chain_id).toBe(DEVNET_ID);
    const out = await executePlan(p, keys, []);
    if ("error" in out) throw new Error(out.status ?? out.error);
    const tx = out.result as { id: string; signatures: string[] };
    expect(tx.signatures).toHaveLength(1);
    expect(verifyEntry(utils.decodeBase64url(tx.signatures[0]!), tx.id, keys.publicKey, "native")).toBe(true);
  });

  it("if the node changes its story between the sheet and the signature, nothing is signed", async () => {
    const p = await planRequest(sign({ operations: [transferOp()] }), net);
    node.chainId = MAINNET_ID;
    const out = await executePlan(p, keys, []);
    expect("error" in out && out.status).toMatch(/chain id of mainnet/);
    node.chainId = DEVNET_ID;
  });
});

describe("item 6: the transaction's number", () => {
  it("reads a nonce as the chain writes it, and nothing else", () => {
    expect(nonceValue(nonceOf(7))).toBe(7n);
    expect(nonceValue("KAo=")).toBe(10n);
    expect(nonceValue(undefined)).toBeNull();
    expect(nonceValue(utils.encodeBase64url(fieldVarint(3, 7n)))).toBeNull(); // another field
    expect(nonceValue(utils.encodeBase64url(concat([fieldVarint(5, 7n), fieldVarint(5, 9n)])))).toBeNull(); // given twice
  });

  it("the number is on the sheet; one ahead of the account's next is refused, the next one and an old one are not", async () => {
    node.nonce = 4; // the account's next transaction is number 5
    const mine = await planRequest(sign({ operations: [transferOp()] }), net);
    expect(mine.nonce).toBe(5n);
    expect(describePlan(mine)).toMatch(/Number \(nonce\)[\s\S]*<strong>5<\/strong>/);
    const next = await planRequest(sign({ header: { nonce: nonceOf(5) }, operations: [transferOp()] }), net);
    expect(next.nonce).toBe(5n);
    // "pay 100" at n+2, held until the same payment at n+1 has landed: never signed
    await expect(planRequest(sign({ header: { nonce: nonceOf(6) }, operations: [transferOp()] }), net)).rejects.toThrow(/numbered 6, but the next transaction of that account is number 5/);
    await expect(planRequest(sign({ header: { nonce: nonceOf(600) }, operations: [transferOp()] }), net)).rejects.toThrow(/numbered 600/);
    // a number already used cannot go through at all; that is the chain's to say
    expect((await planRequest(sign({ header: { nonce: nonceOf(2) }, operations: [transferOp()] }), net)).nonce).toBe(2n);
    await expect(planRequest(sign({ header: { nonce: utils.encodeBase64url(fieldVarint(3, 5n)) }, operations: [transferOp()] }), net)).rejects.toThrow(/not in the form the chain uses/);
  });
});

describe("item 8: a memo is part of the standard", () => {
  const memo = (text: string | Uint8Array, field = 4) => fieldBytes(field, typeof text === "string" ? utf8ToBytes(text) : text);

  it("a transfer with a memo is a transfer: amount, recipient and the memo, cleaned", () => {
    expect(strictTransfer(transferArgs(150_000_000n))).toEqual({ from: ME, to: OTHER, value: 150_000_000n, memo: null });
    expect(strictTransfer(transferArgs(150_000_000n, [memo("invoice 42")]))?.memo).toBe("invoice 42");
    const html = describeOperation(transferOp(transferArgs(150_000_000n, [memo("invoice 42")])).call_contract, net, ME);
    expect(html).toMatch(/Send <strong class="mono">1\.5 KOIN<\/strong>/);
    expect(html).toMatch(/invoice 42/);
    expect(html).not.toMatch(/Unusual/);
    // markup and direction-changing characters in a memo never reach the sheet as they came
    const nasty = describeOperation(transferOp(transferArgs(1n, [memo("<b>refund</b>‮evil")])).call_contract, net, ME);
    expect(nasty).not.toMatch(/<b>refund/);
    expect(nasty).toMatch(/&lt;b&gt;refund/);
    expect(nasty).not.toContain("‮");
    expect(nasty).toMatch(/hidden characters removed/);
  });

  it("still not a plain transfer: a memo given twice, one that is not text, an overlong one, any other field, a value given twice", () => {
    expect(strictTransfer(transferArgs(1n, [memo("a"), memo("b")]))).toBeNull();
    expect(strictTransfer(transferArgs(1n, [memo(Uint8Array.from([0xff, 0xfe]))]))).toBeNull();
    expect(strictTransfer(transferArgs(1n, [memo("x".repeat(257))]))).toBeNull();
    expect(strictTransfer(transferArgs(1n, [fieldVarint(4, 1n)]))).toBeNull(); // field 4 that is not bytes
    expect(strictTransfer(transferArgs(1n, [fieldBytes(5, utf8ToBytes("x"))]))).toBeNull();
    expect(strictTransfer(transferArgs(1n, [fieldVarint(3, 999n)]))).toBeNull();
    expect(describeOperation(transferOp(transferArgs(1n, [memo("a"), memo("b")])).call_contract, net, ME)).toMatch(/Unusual KOIN transfer encoding/);
  });

  it("approve and burn with a memo are described; with the memo twice they are not", () => {
    const APPROVE = 0x74e21680, BURN = 0x859facc5;
    const a = (extra: Uint8Array[]) => ({ contract_id: KOIN, entry_point: APPROVE, args: utils.encodeBase64url(concat([fieldBytes(1, utils.decodeBase58(ME)), fieldBytes(2, utils.decodeBase58(OTHER)), fieldVarint(3, 500_000_000n), ...extra])) });
    const b = (extra: Uint8Array[]) => ({ contract_id: KOIN, entry_point: BURN, args: utils.encodeBase64url(concat([fieldBytes(1, utils.decodeBase58(ME)), fieldVarint(2, 500_000_000n), ...extra])) });
    const approve = describeOperation(a([memo("for the pool")]), net, ME);
    expect(approve).toMatch(/to spend up to <strong class="mono">5 KOIN<\/strong>/);
    expect(approve).toMatch(/for the pool/);
    expect(approve).not.toMatch(/Do not approve/);
    expect(describeOperation(a([memo("x"), memo("y")]), net, ME)).toMatch(/Do not approve/);
    const burn = describeOperation(b([memo("bye", 3)]), net, ME);
    expect(burn).toMatch(/Burn \(destroy\) <strong class="mono">5 KOIN<\/strong>/);
    expect(burn).toMatch(/bye/);
    expect(describeOperation(b([memo("x", 3), memo("y", 3)]), net, ME)).toMatch(/Do not approve/);
  });
});

describe("item 9: only the accounts that were shown", () => {
  it("a request to see the accounts is answered with the addresses passed in, and with none when none were", async () => {
    const p = await planRequest({ id: "g", command: "getAccounts", args: null, origin: "https://dapp.example" }, net);
    const all = await executePlan(p, keys, [{ label: "cold", mode: "pqwallet", address: OTHER }]);
    expect(("result" in all ? (all.result as Array<{ address: string }>) : []).map((x) => x.address).sort()).toEqual([ME, OTHER].sort());
    const one = await executePlan(p, keys, [{ label: "cold", mode: "pqwallet", address: OTHER }], undefined, [ME]);
    expect(("result" in one ? (one.result as Array<{ address: string }>) : []).map((x) => x.address)).toEqual([ME]);
    const none = await executePlan(p, keys, [{ label: "cold", mode: "pqwallet", address: OTHER }], undefined, []);
    expect("result" in none ? none.result : null).toEqual([]);
  });
});

describe("item 11: signatures the page brought", () => {
  const payer = utils.encodeBase64url(randomBytes(65)); // a secp256k1 payer's signature

  it("are kept, and the wallet's goes after them", async () => {
    expect(sanitiseTx({ operations: [transferOp()], signatures: [payer] }).signatures).toEqual([payer]);
    expect(sanitiseTx({ operations: [transferOp()] }).signatures).toBeUndefined();
    const p = await planRequest(sign({ header: { payer: OTHER }, operations: [transferOp()], signatures: [payer] }), net);
    expect(p.coSignatures).toBe(1);
    expect(describePlan(p)).toMatch(/1 already on it from the site; yours is added/);
    const out = await executePlan(p, keys, []);
    if ("error" in out) throw new Error(out.status ?? out.error);
    const tx = out.result as { id: string; signatures: string[] };
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0]).toBe(payer);
    expect(verifyEntry(utils.decodeBase64url(tx.signatures[1]!), tx.id, keys.publicKey, "native")).toBe(true);
    // the plan the sheet showed is not changed by signing it
    expect(p.prepared?.signatures).toEqual([payer]);
  });

  it("but not any number of them, and not anything that is not a signature", () => {
    expect(() => sanitiseTx({ operations: [transferOp()], signatures: Array.from({ length: MAX_PAGE_SIGNATURES + 1 }, () => payer) })).toThrow(/at most/);
    expect(() => sanitiseTx({ operations: [transferOp()], signatures: "abc" })).toThrow(/at most/);
    expect(() => sanitiseTx({ operations: [transferOp()], signatures: [{ r: 1 }] })).toThrow(/malformed signature/);
    expect(() => sanitiseTx({ operations: [transferOp()], signatures: [""] })).toThrow(/malformed signature/);
    expect(() => sanitiseTx({ operations: [transferOp()], signatures: ["A".repeat(6000)] })).toThrow(/malformed signature/);
  });
});

describe("item 12: one size for every side store entry", () => {
  const k1 = storeKeyFrom(new Uint8Array(32).fill(1)), k2 = storeKeyFrom(new Uint8Array(32).fill(2));
  /** a value as versions before 0.19 sealed it: the same format, padded to 1 KiB */
  function sealOld(key: Uint8Array, text: string): string {
    const data = utf8ToBytes(text);
    const plain = new Uint8Array(Math.ceil((4 + data.length) / LEGACY_SEAL_BLOCK) * LEGACY_SEAL_BLOCK);
    new DataView(plain.buffer).setUint32(0, data.length);
    plain.set(data, 4);
    const nonce = randomBytes(12);
    return "sealed1:" + Buffer.concat([nonce, gcm(key, nonce).encrypt(plain)]).toString("base64");
  }
  const contacts = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ address: "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t", name: `recipient ${i}`, sends: 1, usedAt: "2026-11-20T10:00:00.000Z" })));

  it("an empty store, a store with nine recipients and one with eighty are the same length, and so is filler", () => {
    const sizes = [seal(k1, "[]"), seal(k1, contacts(9)), seal(k1, contacts(80)), fillerValue()].map((v) => v.length);
    expect(new Set(sizes).size).toBe(1);
    expect(contacts(9).length).toBeGreaterThan(LEGACY_SEAL_BLOCK); // what used to tip a store into a second block
    expect(sealOld(k1, contacts(9)).length).toBeGreaterThan(sealOld(k1, "[]").length);
    expect(contacts(80).length).toBeLessThan(SEAL_BLOCK);
  });

  it("values written with the old padding all become that one length without any key, and their owner still reads them", () => {
    const small = sealOld(k1, "[]"), used = sealOld(k1, contacts(20)), oldFiller = "sealed1:" + Buffer.from(randomBytes(12 + LEGACY_SEAL_BLOCK + 16)).toString("base64");
    expect(used.length).toBeGreaterThan(small.length); // the tell
    const now = [small, used, oldFiller].map(lengthen);
    expect(new Set(now.map((v) => v.length)).size).toBe(1);
    expect(now[0]!.length).toBe(fillerValue().length);
    expect(unseal(k1, now[0]!)).toBe("[]");
    expect(unseal(k1, now[1]!)).toBe(contacts(20));
    expect(unseal(k1, now[2]!)).toBeNull();
    expect(unseal(k2, now[1]!)).toBeNull(); // another wallet's key opens nothing
    // already the right size, or not sealed at all: left alone
    const current = seal(k1, "[]");
    expect(lengthen(current)).toBe(current);
    expect(lengthen("[]")).toBe("[]");
  });

  it("the wallet that owns a lengthened value seals it again in the current form the first time it reads it", () => {
    const raw = new Map<string, string>([["k", lengthen(sealOld(k1, contacts(20)))]]);
    const inner: BookStore = { get: (k) => raw.get(k) ?? null, set: (k, v) => void raw.set(k, v) };
    const before = raw.get("k")!;
    expect(new SealedStore(k2, inner).get("k")).toBeNull(); // not its own: untouched
    expect(raw.get("k")).toBe(before);
    expect(new SealedStore(k1, inner).get("k")).toBe(contacts(20));
    expect(raw.get("k")).not.toBe(before);
    expect(raw.get("k")!.length).toBe(before.length);
    // an old value that was never lengthened (read before the app got to it) is handled the same way
    raw.set("j", sealOld(k1, contacts(3)));
    expect(new SealedStore(k1, inner).get("j")).toBe(contacts(3));
    expect(raw.get("j")!.length).toBe(fillerValue().length);
  });
});
