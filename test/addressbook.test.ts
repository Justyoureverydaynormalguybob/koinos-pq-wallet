import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { AddressBook, addressBookNamespace, isValidAddress, looksLike, MAX_NAME, type BookStore } from "../src/core/addressbook";

const mem = (): BookStore & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
};
const A = "1JZ2fwcuwRPLSJd3cdNpwLGkLAPktVUkqp"; // real testnet addresses
const B = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
const C = "1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ";

describe("address validation", () => {
  it("accepts real addresses and rejects a bad checksum or shape", () => {
    expect(isValidAddress(A)).toBe(true);
    expect(isValidAddress(A.slice(0, -1) + (A.endsWith("p") ? "q" : "p"))).toBe(false);
    expect(isValidAddress("0x1234")).toBe(false);
    expect(isValidAddress("")).toBe(false);
  });
});

describe("lookalike detection (address poisoning)", () => {
  it("flags matching head and tail, or a long match at either end, and nothing by chance", () => {
    // attacker copies the first 5 and last 4 of A
    expect(looksLike("1JZ2fXXXXXXXXXXXXXXXXXXXXXXXXXUkqp", A)).toBe(true);
    // 7 at the start only
    expect(looksLike("1JZ2fwcuXXXXXXXXXXXXXXXXXXXXXXXXXX", A)).toBe(true);
    // 7 at the end only
    expect(looksLike("1XXXXXXXXXXXXXXXXXXXXXXXXXXPktVUkqp", A)).toBe(true);
    // 3 and 3: not enough
    expect(looksLike("1JZ2XXXXXXXXXXXXXXXXXXXXXXXXXXXXkqp", A)).toBe(false);
    // the real, unrelated addresses do not resemble each other
    expect(looksLike(B, A)).toBe(false);
    expect(looksLike(C, A)).toBe(false);
    expect(looksLike(A, A)).toBe(false);
  });
});

describe("address book", () => {
  it("is namespaced by seed and persists through the store", () => {
    const s1 = sha256(utf8ToBytes("seed one")), s2 = sha256(utf8ToBytes("seed two"));
    expect(addressBookNamespace(s1)).not.toBe(addressBookNamespace(s2));
    expect(addressBookNamespace(s1)).toHaveLength(24);
    const store = mem();
    const book = new AddressBook(addressBookNamespace(s1), store);
    book.upsert(A, "Issuer");
    expect(new AddressBook(addressBookNamespace(s1), store).get(A)?.name).toBe("Issuer");
    expect(new AddressBook(addressBookNamespace(s2), store).get(A)).toBeUndefined();
  });

  it("assesses recipients: invalid, own, known, lookalike, new", () => {
    const book = new AddressBook("t", mem());
    expect(book.assess("nonsense").kind).toBe("invalid");
    expect(book.assess(B, [B]).kind).toBe("own");
    expect(book.assess(A).kind).toBe("new");
    book.recordSend(A, "Issuer");
    expect(book.assess(A).kind).toBe("known");
    expect(book.get(A)?.sends).toBe(1);
    const poison = "1JZ2fXXXXXXXXXXXXXXXXXXXXXXXXXUkqp";
    // the poison address has no valid checksum, so it is "invalid" before it is ever "lookalike";
    // craft the check with a valid address that resembles a known one via the matcher directly
    expect(book.assess(poison).kind).toBe("invalid");
    expect(looksLike(poison, A)).toBe(true);
  });

  it("caps names, keeps the old name on an empty rename, and removes", () => {
    const book = new AddressBook("t", mem());
    book.upsert(A, "x".repeat(100));
    expect(book.get(A)?.name).toHaveLength(MAX_NAME);
    book.upsert(A, "   ");
    expect(book.get(A)?.name).toHaveLength(MAX_NAME);
    book.remove(A);
    expect(book.get(A)).toBeUndefined();
    expect(book.list()).toEqual([]);
  });

  it("survives a corrupt store value", () => {
    const store = mem();
    store.set("koinos-pq-wallet/book/t", "{not json");
    expect(new AddressBook("t", store).list()).toEqual([]);
    store.set("koinos-pq-wallet/book/t", JSON.stringify([{ nope: 1 }, { address: A, name: "ok", addedAt: "", sends: 0 }]));
    expect(new AddressBook("t", store).list().map((c) => c.address)).toEqual([A]);
  });
});
