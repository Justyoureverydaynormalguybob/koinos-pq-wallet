import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveKeys } from "koinos-pq-core";
import { canSign, walletAccounts } from "../src/core/accounts";
import { copyWithWipe, wipeIfOurs } from "../src/core/clipboard";

const keys = deriveKeys(sha256(utf8ToBytes("accounts test key")));
const W = "1JZ2fwcuwRPLSJd3cdNpwLGkLAPktVUkqp";
const P = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";

describe("watch-only accounts", () => {
  it("are never offered for signing, on any network", () => {
    const stored = [
      { label: "Cold", mode: "watch" as const, address: W },
      { label: "pqwallet account", mode: "pqwallet" as const, address: P },
    ];
    for (const net of ["mainnet", "testnet", "devnet"]) {
      const offered = walletAccounts(keys, stored, net, null);
      expect(offered.map((a) => a.address)).not.toContain(W);
      expect(offered.find((a) => a.address === P)?.name).toBe("Your account");
    }
    expect(canSign({ mode: "watch" })).toBe(false);
    expect(canSign({ mode: "pqwallet" })).toBe(true);
    expect(canSign({ mode: "native" })).toBe(true);
  });

  it("native address only on the devnet; a detected account is added once", () => {
    expect(walletAccounts(keys, [], "mainnet", null)).toEqual([]);
    expect(walletAccounts(keys, [], "devnet", null)[0]?.mode).toBe("native");
    const list = walletAccounts(keys, [{ label: "x", mode: "pqwallet", address: P }], "mainnet", P);
    expect(list.filter((a) => a.address === P)).toHaveLength(1);
  });
});

describe("clipboard wipe", () => {
  it("clears the clipboard after the delay only if it still holds our text", async () => {
    vi.useFakeTimers();
    let content = "";
    const clip = { writeText: async (t: string) => void (content = t), readText: async () => content } as unknown as Clipboard;
    await copyWithWipe("1abc", 1, clip);
    expect(content).toBe("1abc");
    content = "user copied something else";
    await vi.advanceTimersByTimeAsync(1100);
    expect(content).toBe("user copied something else");
    await copyWithWipe("1abc", 1, clip);
    await vi.advanceTimersByTimeAsync(1100);
    expect(content).toBe("");
    vi.useRealTimers();
  });

  it("clears regardless when it cannot read the clipboard back", async () => {
    let content = "x";
    const clip = { writeText: async (t: string) => void (content = t), readText: async () => { throw new Error("denied"); } } as unknown as Clipboard;
    expect(await wipeIfOurs("x", clip)).toBe(true);
    expect(content).toBe("");
  });
});
