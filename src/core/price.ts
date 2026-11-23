// What KOIN is worth in dollars, read from the chain itself: the reserves of KoinDX's KOIN/vUSD pool, one
// contract read through the node the wallet already talks to. No price server, nobody new learns anything.
// (Kondor reads the same pool.) It is a spot price from a small pool, good for "about how much is this",
// not for anything precise; the wallet says "≈" and never uses it to compute an amount.
import { decodeFields, type Chain } from "koinos-pq-core";

/** KoinDX pair contracts by network: reserve A is KOIN, reserve B is vUSD, both with 8 decimals (checked on mainnet 2026-11-23). */
export const KOIN_USD_PAIR: Record<string, string> = {
  mainnet: "1E8AjPZxKLJGFouXtNNkPcYxAgsTh4AUTN",
};
/** core.get_reserves */
const GET_RESERVES = 0x6d0c5abf;

/** get_reserves_result { string kLast = 1; uint64 reserveA = 2; uint64 reserveB = 3; uint64 blockTime = 4; } -> dollars per KOIN */
export function priceFromReserves(result: Uint8Array): number | null {
  const f = decodeFields(result);
  const a = f.get(2)?.[0], b = f.get(3)?.[0];
  if (typeof a !== "bigint" || typeof b !== "bigint" || a <= 0n || b <= 0n) return null;
  const price = Number(b) / Number(a);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Dollars per KOIN on this network, or null where there is no pool (testnets) or it cannot be read. */
export async function koinUsd(chain: Chain): Promise<number | null> {
  const pair = KOIN_USD_PAIR[chain.net.name];
  if (!pair) return null;
  try {
    return priceFromReserves(await chain.read(pair, GET_RESERVES));
  } catch {
    return null;
  }
}

/** "$12.34", "$1,234", "$0.0191" (small prices keep four significant digits), "<$0.01" never: an amount is shown as it is. */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v) || v < 0) return "$?";
  if (v === 0) return "$0";
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${Number(v.toPrecision(3))}`;
}

/** The dollar value of an amount in KOIN base units (8 decimals). */
export function usdValue(base: bigint, price: number): number {
  return (Number(base) / 1e8) * price;
}

/** Mana comes back in a straight line, from empty to full in five days (the KOIN contract's mana_regen_time). */
export const MANA_REGEN_MS = 5 * 24 * 60 * 60 * 1000;

/** How long until the account's mana is full again, in ms; 0 when it is, null when unknown. */
export function manaFullIn(balance: bigint | null, mana: bigint | null): number | null {
  if (balance === null || mana === null) return null;
  if (balance <= 0n || mana >= balance) return 0;
  return Number(((balance - mana) * BigInt(MANA_REGEN_MS)) / balance);
}

/** "under a minute", "25 min", "3 h 10 min", "2 d 4 h" */
export function fmtDuration(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min <= 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
