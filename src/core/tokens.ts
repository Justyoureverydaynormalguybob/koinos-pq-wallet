// KCS-4 tokens: the curated list per network (src/data, checked against the chain), the tokens a wallet
// adds by address, and amounts in a token's own decimals. Balances are read per token with balance_of;
// there is no indexer of holdings, so the list is what the Account tab shows.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { NETWORKS } from "koinos-pq-core";
import mainnet from "../data/tokens.mainnet.json";
import harbinger from "../data/tokens.harbinger.json";
import { isValidAddress, type BookStore } from "./addressbook";

export interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** KOIN and VHP: the chain's own tokens, always shown */
  system?: boolean;
  website?: string | null;
  /** added by the user on this wallet, not from the curated list */
  custom?: boolean;
}

interface TokenFile {
  chainId: string;
  network: string;
  tokens: Array<Token & { logo?: string | null; priceUrl?: string | null; pricePath?: string | null; priceUnit?: string | null }>;
}

const FILES: Record<string, TokenFile> = { mainnet: mainnet as TokenFile, testnet: harbinger as TokenFile };

/** The curated tokens of a network, KOIN first. The devnet has only its KOIN contract. */
export function listedTokens(networkName: string): Token[] {
  const net = NETWORKS[networkName];
  if (!net) return [];
  const file = FILES[networkName];
  if (!file) return [{ address: net.koin, symbol: "KOIN", name: "Koin", decimals: 8, system: true }];
  return file.tokens.map(({ address, symbol, name, decimals, system, website }) => ({ address, symbol, name, decimals, system, website: website ?? null }));
}

/** The token a contract address refers to on a network, if listed or added. */
export function findToken(tokens: Token[], address: string): Token | undefined {
  return tokens.find((t) => t.address === address);
}

export const MAX_DECIMALS = 18;
const MAX_UINT64 = 0xffffffffffffffffn;

/** Base units -> a plain decimal string with up to `places` fraction digits, trailing zeros dropped. */
export function formatUnits(base: bigint, decimals: number, places = decimals): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw new Error("bad decimals");
  const neg = base < 0n;
  const v = neg ? -base : base;
  const one = 10n ** BigInt(decimals);
  const whole = v / one;
  const frac = decimals ? (v % one).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** "1.5" with 8 decimals -> 150000000n; a plain decimal with at most `decimals` places, within uint64. */
export function parseUnits(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw new Error("bad decimals");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error("amount must be a plain number");
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(decimals ? `this token has ${decimals} decimal places at most` : "this token has no decimal places");
  const v = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (v > MAX_UINT64) throw new Error("amount is larger than the chain can represent");
  return v;
}

export const MAX_CUSTOM_TOKENS = 100;

/** Like the address book: a namespace from the seed, so each wallet (and a decoy) keeps its own additions. */
export function customTokensNamespace(seed: Uint8Array): string {
  const h = sha256(new Uint8Array([...utf8ToBytes("koinos-pq-wallet/tokens/1"), ...seed]));
  return bytesToHex(h).slice(0, 24);
}

const localStore: BookStore = {
  get(k) {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* a blocked store means additions do not persist; the wallet still works */
    }
  },
};

type Stored = Record<string, Token[]>;

/** Tokens the user added by address, per network, kept in localStorage under the wallet's namespace. */
export class CustomTokens {
  private readonly key: string;
  private data: Stored;

  constructor(namespace: string, private readonly store: BookStore = localStore) {
    this.key = `koinos-pq-wallet/tokens/${namespace}`;
    this.data = this.read();
  }
  private read(): Stored {
    try {
      const raw = this.store.get(this.key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Stored = {};
      for (const [net, list] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        out[net] = list
          .filter((t): t is Token => !!t && typeof t === "object" && isValidAddress(String((t as Token).address)) && typeof (t as Token).symbol === "string" && Number.isInteger((t as Token).decimals))
          .slice(0, MAX_CUSTOM_TOKENS)
          .map((t) => ({ address: t.address, symbol: String(t.symbol).slice(0, 12), name: String(t.name ?? "").slice(0, 60), decimals: t.decimals, custom: true }));
      }
      return out;
    } catch {
      return {};
    }
  }
  private write() {
    this.store.set(this.key, JSON.stringify(this.data));
  }
  list(networkName: string): Token[] {
    return [...(this.data[networkName] ?? [])];
  }
  add(networkName: string, token: Token): Token {
    if (!isValidAddress(token.address)) throw new Error("not a valid contract address");
    const list = this.data[networkName] ?? [];
    const existing = list.find((t) => t.address === token.address);
    if (existing) return existing;
    if (list.length >= MAX_CUSTOM_TOKENS) throw new Error(`at most ${MAX_CUSTOM_TOKENS} added tokens per network`);
    const t: Token = { address: token.address, symbol: token.symbol.slice(0, 12), name: token.name.slice(0, 60), decimals: token.decimals, custom: true };
    list.push(t);
    this.data[networkName] = list;
    this.write();
    return t;
  }
  remove(networkName: string, address: string) {
    this.data[networkName] = (this.data[networkName] ?? []).filter((t) => t.address !== address);
    this.write();
  }
}

/** The curated list plus this wallet's additions, additions last; a listed address is never duplicated. */
export function allTokens(networkName: string, custom: CustomTokens | null): Token[] {
  const listed = listedTokens(networkName);
  const extra = (custom?.list(networkName) ?? []).filter((t) => !findToken(listed, t.address));
  return [...listed, ...extra];
}
