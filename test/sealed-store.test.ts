// The sealed side stores: sealed under the slot key, padded to a block, unreadable under another key or
// without one, filler of the same size, and pre-0.15 plain JSON sealed on first read.
import { describe, expect, it } from "vitest";
import { SEAL_BLOCK, SealedStore, fillerValue, isSealed, seal, storeKeyFrom, unseal } from "../src/core/sealed-store";
import { AddressBook, type BookStore } from "../src/core/addressbook";

const mem = (): BookStore & { raw: Map<string, string> } => {
  const raw = new Map<string, string>();
  return { raw, get: (k) => raw.get(k) ?? null, set: (k, v) => void raw.set(k, v) };
};
const k1 = storeKeyFrom(new Uint8Array(32).fill(1)), k2 = storeKeyFrom(new Uint8Array(32).fill(2));

describe("sealed store", () => {
  it("round-trips, hides length within a block, and opens under its key only", () => {
    const a = seal(k1, "[]"), b = seal(k1, JSON.stringify([{ address: "1".repeat(30), name: "x".repeat(200) }]));
    expect(a.length).toBe(b.length); // both inside one block
    expect(a.length).toBe(fillerValue().length);
    expect(unseal(k1, a)).toBe("[]");
    expect(unseal(k2, a)).toBeNull();
    expect(unseal(k1, fillerValue())).toBeNull();
    expect(isSealed(a)).toBe(true);
    expect(isSealed("[]")).toBe(false);
    expect(seal(k1, "[]")).not.toBe(a); // fresh nonce every time
    const big = seal(k1, "x".repeat(SEAL_BLOCK * 2));
    expect(unseal(k1, big)).toBe("x".repeat(SEAL_BLOCK * 2));
    expect(() => storeKeyFrom(new Uint8Array(16))).toThrow();
  });

  it("the address book works through it, storage holds only sealed values, plain legacy JSON is sealed on first read", () => {
    const inner = mem();
    inner.raw.set("koinos-pq-wallet/book/slot0", JSON.stringify([{ address: "1JZ2fwcuwRPLSJd3cdNpwLGkLAPktVUkqp", name: "issuer", usedAt: "2026-10-20" }]));
    const book = new AddressBook("slot0", new SealedStore(k1, inner));
    expect(book.list().map((c) => c.name)).toEqual(["issuer"]); // the legacy record was readable once
    expect(isSealed(inner.raw.get("koinos-pq-wallet/book/slot0")!)).toBe(true); // and is sealed now
    book.upsert("19G2VrmoqgCFRRtgoYF3vFi2ekDsyoRvab", "second");
    expect(unseal(k1, inner.raw.get("koinos-pq-wallet/book/slot0")!)).toMatch(/second/);
    expect(unseal(k2, inner.raw.get("koinos-pq-wallet/book/slot0")!)).toBeNull();
    // another wallet's key reads the same entry as empty, never as the first wallet's contacts
    const other = new AddressBook("slot0", new SealedStore(k2, inner));
    expect(other.list()).toEqual([]);
  });
});
