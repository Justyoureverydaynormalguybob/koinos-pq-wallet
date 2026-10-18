// Talking to a Koinos node: balances, mana, building and sending a KOIN transfer, history.
import { Contract, Provider, Transaction, utils } from "koilib";
import type { PqKeys } from "./keys";
import { signTxId, verifyEntry, type AccountMode } from "./sign";

export interface Network {
  name: string;
  rpc: string[];
  /** REST base for account history, or null when the node has none */
  rest: string | null;
  koin: string;
  explorerTx: ((id: string) => string) | null;
  /** blocks arrive on their own (false on the hand-driven devnet) */
  autoBlocks: boolean;
}

export const NETWORKS: Record<string, Network> = {
  mainnet: {
    name: "mainnet",
    rpc: ["https://api.koinos.io/jsonrpc"],
    rest: "https://api.koinos.io/v1",
    // KOIN moved to this contract; the original 15DJN4a8SgrbGhhGksSBASiSYjGnMU8dGL still answers name/symbol but
    // every state read on it fails with "user code cannot access system space" (checked 2026-10-18).
    koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK",
    explorerTx: (id) => `https://koinosblocks.com/tx/${id}`,
    autoBlocks: true,
  },
  testnet: {
    name: "testnet",
    rpc: ["https://testnet.koinosfoundation.org/jsonrpc"],
    rest: "https://testnet.koinosfoundation.org/v1",
    koin: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju",
    explorerTx: (id) => `https://harbinger.koinosblocks.com/tx/${id}`,
    autoBlocks: true,
  },
  devnet: {
    name: "devnet",
    rpc: ["http://127.0.0.1:8080/"],
    rest: null,
    koin: "1BRmrUgtSQVUggoeE9weG4f7nidyydnYfQ",
    explorerTx: null,
    autoBlocks: false,
  },
};

export const KOIN_DECIMALS = 8;
const ONE_KOIN = 10n ** BigInt(KOIN_DECIMALS);

export function formatKoin(base: bigint, places = 8): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const whole = v / ONE_KOIN;
  const frac = (v % ONE_KOIN).toString().padStart(KOIN_DECIMALS, "0").slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** "1.5" -> 150000000n; rejects anything that is not a plain decimal with at most 8 places */
export function parseKoin(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!m) throw new Error("amount must be a number with at most 8 decimal places");
  return BigInt(m[1]!) * ONE_KOIN + BigInt((m[2] ?? "").padEnd(KOIN_DECIMALS, "0"));
}

export function isAddress(s: string): boolean {
  try {
    const b = utils.decodeBase58(s.trim());
    return b.length === 25 && utils.isChecksumAddress(s.trim());
  } catch {
    return false;
  }
}

export interface SendResult {
  txId: string;
  receipt: Record<string, unknown>;
  entryBytes: number;
}

export interface HistoryItem {
  seq: string;
  txId: string | null;
  blockHeight: string | null;
  summary: string;
}

export class Chain {
  readonly provider: Provider;
  readonly koin: Contract;

  constructor(readonly net: Network) {
    this.provider = new Provider(net.rpc);
    this.koin = new Contract({ id: net.koin, abi: utils.tokenAbi, provider: this.provider });
  }

  async balance(address: string): Promise<bigint> {
    const { result } = await this.koin.functions.balanceOf!({ owner: address });
    return BigInt((result as { value?: string } | undefined)?.value ?? "0");
  }

  async mana(address: string): Promise<bigint> {
    return BigInt(await this.provider.getAccountRc(address));
  }

  async headHeight(): Promise<string> {
    const h = (await this.provider.getHeadInfo()) as { head_topology?: { height?: string } };
    return h.head_topology?.height ?? "0";
  }

  /** Builds, signs with the ML-DSA key for the account's mode, checks the signature locally, submits. */
  async sendKoin(opts: { from: string; to: string; valueBase: bigint; keys: PqKeys; mode: AccountMode; rcLimit?: bigint }): Promise<SendResult> {
    const { from, to, valueBase, keys, mode } = opts;
    if (!isAddress(to)) throw new Error("recipient is not a valid Koinos address");
    if (valueBase <= 0n) throw new Error("amount must be positive");
    const { operation } = await this.koin.functions.transfer!({ from, to, value: valueBase.toString() }, { onlyOperation: true });

    let rcLimit = opts.rcLimit;
    if (rcLimit === undefined) {
      // the mempool reserves each pending tx's rc_limit, so never ask for everything
      const avail = await this.mana(from);
      const cap = 10n * ONE_KOIN;
      rcLimit = avail / 2n < cap ? avail / 2n : cap;
      if (rcLimit <= 0n) throw new Error("this account has no mana");
    }

    const tx: Record<string, unknown> = { header: { payer: from, rc_limit: rcLimit.toString() }, operations: [operation], signatures: [] };
    await Transaction.prepareTransaction(tx as never, this.provider, from);
    const txId = (tx as { id: string }).id;

    const entry = signTxId(txId, keys, mode);
    if (!verifyEntry(entry, txId, keys.publicKey, mode)) throw new Error("local signature check failed; nothing was sent");
    (tx as { signatures: string[] }).signatures = [utils.encodeBase64url(entry)];

    const { receipt } = await this.provider.sendTransaction(tx as never);
    return { txId, receipt: (receipt ?? {}) as unknown as Record<string, unknown>, entryBytes: entry.length };
  }

  /** Resolves with the block height once the transaction is in a block (or throws on timeout). */
  async waitMined(txId: string, timeoutMs = 90_000): Promise<string> {
    const r = (await this.provider.wait(txId, "byBlock", timeoutMs)) as unknown;
    if (typeof r === "object" && r !== null) {
      const o = r as { blockNumber?: number | string; blockId?: string };
      return String(o.blockNumber ?? o.blockId ?? JSON.stringify(r));
    }
    return String(r);
  }

  /**
   * Account history through the JSON-RPC gateway (account_history.get_account_history). The REST
   * /v1/account/{a}/history carries the same data but sends no CORS headers, so a browser cannot read it.
   */
  async history(address: string, limit = 20): Promise<HistoryItem[]> {
    const r = (await this.provider.call("account_history.get_account_history", { address, limit, ascending: false, irreversible: false })) as {
      values?: Array<Record<string, unknown>>;
    };
    return (r.values ?? []).map((row) => summarizeHistory(row, address));
  }
}

// token transfer_event { bytes from = 1; bytes to = 2; uint64 value = 3 }, base64url on the JSON-RPC
function decodeTransferEvent(data: string): { from?: string; to?: string; value?: string } {
  const b = utils.decodeBase64url(data);
  const out: { from?: string; to?: string; value?: string } = {};
  let i = 0;
  const varint = (): bigint => {
    let v = 0n, s = 0n;
    for (;;) {
      const c = b[i++];
      if (c === undefined) throw new Error("truncated event");
      v |= BigInt(c & 0x7f) << s;
      s += 7n;
      if (c < 0x80) return v;
    }
  };
  while (i < b.length) {
    const tag = varint();
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 2) {
      const len = Number(varint());
      const bytes = b.subarray(i, i + len);
      i += len;
      if (field === 1) out.from = utils.encodeBase58(bytes);
      if (field === 2) out.to = utils.encodeBase58(bytes);
    } else if (wire === 0) {
      const v = varint();
      if (field === 3) out.value = v.toString();
    } else {
      break;
    }
  }
  return out;
}

function summarizeHistory(row: Record<string, unknown>, me: string): HistoryItem {
  const seq = String(row.seq_num ?? "");
  const trx = row.trx as { transaction?: { id?: string }; receipt?: { events?: Array<Record<string, unknown>>; reverted?: boolean } } | undefined;
  const block = row.block as { header?: { height?: string } } | undefined;
  const txId = trx?.transaction?.id ?? null;
  const events = trx?.receipt?.events ?? [];
  let summary = block ? "block produced" : "transaction";
  for (const ev of events) {
    if (typeof ev.name !== "string" || !/(^|.)transfer_event$/.test(ev.name)) continue; // mainnet and Harbinger name it differently
    let d: { from?: string; to?: string; value?: string } = {};
    try {
      d = typeof ev.data === "string" ? decodeTransferEvent(ev.data) : ((ev.data ?? {}) as typeof d);
    } catch {
      continue;
    }
    const amount = d.value ? formatKoin(BigInt(d.value)) : "?";
    if (d.to === me) summary = `received ${amount} from ${short(d.from)}`;
    else if (d.from === me) summary = `sent ${amount} to ${short(d.to)}`;
    else continue;
    break;
  }
  if (trx?.receipt?.reverted) summary += " (reverted)";
  return { seq, txId, blockHeight: block?.header?.height ?? null, summary };
}

export function short(a: string | undefined): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?";
}
