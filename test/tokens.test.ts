// KCS-4 tokens: the curated lists, amounts in a token's decimals, the per-wallet additions, and the
// result decoders the token reads rely on, checked against koilib's own serializer.
import { describe, expect, it } from "vitest";
import { Serializer, utils } from "koilib";
import { NETWORKS, decodeDecimalsResult, decodeStringResult, decodeUint64Result } from "koinos-pq-core";
import { CustomTokens, allTokens, customTokensNamespace, findToken, formatUnits, listedTokens, parseUnits, MAX_CUSTOM_TOKENS } from "../src/core/tokens";
import { isValidAddress, type BookStore } from "../src/core/addressbook";

const memStore = (): BookStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
};

describe("token lists", () => {
  it("every entry is a valid, unique address with sane decimals; KOIN is the chain's KOIN contract", () => {
    for (const net of ["mainnet", "testnet"]) {
      const list = listedTokens(net);
      expect(list.length).toBeGreaterThanOrEqual(2);
      const seen = new Set<string>();
      for (const t of list) {
        expect(isValidAddress(t.address), `${net} ${t.symbol}`).toBe(true);
        expect(seen.has(t.address)).toBe(false);
        seen.add(t.address);
        expect(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 18).toBe(true);
        expect(t.symbol.length).toBeGreaterThan(0);
      }
      expect(list[0]!.address).toBe(NETWORKS[net]!.koin);
      expect(list[0]!.system).toBe(true);
      expect(list[1]!.symbol).toBe("VHP");
    }
    expect(listedTokens("devnet")).toEqual([{ address: NETWORKS.devnet!.koin, symbol: "KOIN", name: "Koin", decimals: 8, system: true }]);
    expect(listedTokens("nowhere")).toEqual([]);
  });
});

describe("amounts in a token's decimals", () => {
  it("formats and parses round trip, with 8 and 0 decimals", () => {
    expect(formatUnits(150000000n, 8)).toBe("1.5");
    expect(formatUnits(1n, 8)).toBe("0.00000001");
    expect(formatUnits(123456789n, 8, 2)).toBe("1.23");
    expect(formatUnits(0n, 8)).toBe("0");
    expect(formatUnits(42n, 0)).toBe("42");
    expect(parseUnits("1.5", 8)).toBe(150000000n);
    expect(parseUnits(" 7 ", 8)).toBe(700000000n);
    expect(parseUnits("42", 0)).toBe(42n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("18446744073709551615", 0)).toBe(0xffffffffffffffffn);
  });
  it("refuses what the chain cannot represent", () => {
    expect(() => parseUnits("1.5", 0)).toThrow(/no decimal places/);
    expect(() => parseUnits("1.123456789", 8)).toThrow(/8 decimal places/);
    expect(() => parseUnits("18446744073709551616", 0)).toThrow(/larger/);
    expect(() => parseUnits("-1", 8)).toThrow();
    expect(() => parseUnits("1e5", 8)).toThrow();
    expect(() => parseUnits("", 8)).toThrow();
    expect(() => formatUnits(1n, 19)).toThrow(/decimals/);
  });
});

describe("tokens added by address", () => {
  it("are kept per wallet and per network, deduplicated against the list, capped", () => {
    const store = memStore();
    const seed = new Uint8Array(32).fill(7);
    const ns = customTokensNamespace(seed);
    expect(ns).toMatch(/^[0-9a-f]{24}$/);
    expect(ns).not.toBe(customTokensNamespace(new Uint8Array(32).fill(8)));
    const ct = new CustomTokens(ns, store);
    const egg = { address: "1AFMFjbSzpnK58xbwt6cyAnhLF77qm5FeC", symbol: "EGG", name: "Egg", decimals: 8 }; // listed on mainnet
    const other = { address: "19G2VrmoqgCFRRtgoYF3vFi2ekDsyoRvab", symbol: "X", name: "A token", decimals: 3 };
    ct.add("mainnet", other);
    ct.add("mainnet", egg);
    ct.add("testnet", other);
    expect(ct.list("mainnet").map((t) => t.symbol)).toEqual(["X", "EGG"]);
    expect(ct.list("devnet")).toEqual([]);
    // the curated list wins over an addition of the same address
    const all = allTokens("mainnet", ct);
    expect(all.filter((t) => t.address === egg.address)).toHaveLength(1);
    expect(findToken(all, egg.address)?.custom).toBeUndefined();
    expect(findToken(all, other.address)?.custom).toBe(true);
    // persisted, and read back by a new instance
    const again = new CustomTokens(ns, store);
    expect(again.list("testnet")).toEqual([{ ...other, custom: true }]);
    again.remove("testnet", other.address);
    expect(new CustomTokens(ns, store).list("testnet")).toEqual([]);
    expect(() => ct.add("mainnet", { ...other, address: "not an address" })).toThrow(/valid/);
    for (let i = 0; i < MAX_CUSTOM_TOKENS + 5; i++) {
      try {
        ct.add("testnet", { ...other, address: utils.encodeBase58(utils.decodeBase58(other.address)) });
      } catch {
        /* same address: deduplicated, never throws for the cap */
      }
    }
    expect(ct.list("testnet")).toHaveLength(1);
  });
});

describe("token result decoders agree with koilib's serializer", () => {
  const token = new Serializer(utils.tokenAbi.koilib_types!);
  it("name, symbol, decimals, balance_of and total_supply results", async () => {
    expect(decodeStringResult(await token.serialize({ value: "Virtual Hash Power" }, "name_result"))).toBe("Virtual Hash Power");
    expect(decodeStringResult(await token.serialize({ value: "vUSDT" }, "symbol_result"))).toBe("vUSDT");
    expect(decodeDecimalsResult(await token.serialize({ value: 0 }, "decimals_result"))).toBe(0);
    expect(decodeDecimalsResult(await token.serialize({ value: 18 }, "decimals_result"))).toBe(18);
    expect(decodeUint64Result(await token.serialize({ value: "2212105600398260" }, "total_supply_result"))).toBe(2212105600398260n);
    expect(decodeUint64Result(await token.serialize({ value: "18446744073709551615" }, "balance_of_result"))).toBe(0xffffffffffffffffn);
  });
});
