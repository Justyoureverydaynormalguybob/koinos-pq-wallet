// What a dapp may ask the wallet to do, and the rules that keep "what you see is what you sign" true.
// Shared by the extension's approval window and the in-app dapp browser, so both refuse the same
// things and sign the same bytes (from the 2026-10-18 security review):
//   - a transaction is rebuilt HERE from validated fields: operations are re-created field by field,
//     the merkle root and the id are recomputed by koilib, never taken from the page, and the
//     prepared copy is exactly what gets signed after approval;
//   - the prepared transaction's chain id must be the wallet's current network;
//   - only contract calls are accepted; uploads, system operations and any call to one of the
//     wallet's own accounts (which could change the key that controls it) are refused outright;
//   - a token transfer is described as a transfer only when its encoding is canonical (each field
//     exactly once), so the screen and the chain read the same recipient and amount;
//   - raw hash signing is refused: a signed hash is a signature over an unseen transaction;
//   - messages are signed under their own context (koinos-pq-core), never usable as a transaction.
import { Transaction, utils } from "koilib";
import { hexToBytes } from "@noble/hashes/utils.js";
import { Chain, PqSigner, bootstrapAddress, decodeFields, type Network, type PqKeys } from "koinos-pq-core";
import { detectAccount, walletAccounts, type WalletAccount } from "./accounts";
import type { AccountRecord } from "./vault";

export interface DappRequest {
  id: string;
  command: string;
  args: Record<string, unknown> | null;
  origin: string;
}
export interface Header {
  chain_id?: string;
  rc_limit?: string;
  nonce?: string;
  payer?: string;
  payee?: string;
}
export interface CallContract {
  contract_id: string;
  entry_point: number;
  args: string;
}
export interface Tx {
  id?: string;
  header?: Header & { operation_merkle_root?: string };
  operations?: Array<{ call_contract: CallContract }>;
  signatures?: string[];
}

export const APPROVAL_COMMANDS = new Set(["getAccounts", "signer:signHash", "signer:signMessage", "signer:signTransaction", "signer:sendTransaction", "signer:prepareTransaction"]);

/** Bytes arrive as a Uint8Array, a JSON-ified one ({"0":18,...}), an array, hex or base64url. */
export function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v.map((x) => Number(x) & 255));
  if (typeof v === "string") return /^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0 ? hexToBytes(v) : utils.decodeBase64url(v);
  if (v && typeof v === "object") {
    const keys = Object.keys(v).map(Number).sort((x, y) => x - y);
    return Uint8Array.from(keys.map((k) => Number((v as Record<string, number>)[k]) & 255));
  }
  throw new Error("unreadable bytes in request");
}

export const isAddress = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{25,36}$/.test(s);
const isUint = (s: unknown): s is string => typeof s === "string" && /^\d{1,20}$/.test(s);
// koilib writes base64url with "=" padding, so up to two trailing "=" are allowed
const isB64url = (s: unknown): s is string => typeof s === "string" && s.length <= 262_144 && /^[A-Za-z0-9_-]*={0,2}$/.test(s);

/** The page's transaction reduced to fields a page may set, each validated; operations rebuilt field by field. */
export function sanitiseTx(raw: unknown): Tx {
  if (!raw || typeof raw !== "object") throw new Error("malformed transaction");
  const t = raw as { header?: unknown; operations?: unknown };
  const h = (t.header && typeof t.header === "object" ? t.header : {}) as Record<string, unknown>;
  const header: Header = {};
  if (h.chain_id !== undefined) {
    if (!isB64url(h.chain_id) || h.chain_id.length > 128) throw new Error("malformed chain_id");
    header.chain_id = h.chain_id;
  }
  if (h.rc_limit !== undefined) {
    if (!isUint(h.rc_limit)) throw new Error("malformed rc_limit");
    header.rc_limit = h.rc_limit;
  }
  if (h.nonce !== undefined) {
    if (!isB64url(h.nonce) || h.nonce.length > 64) throw new Error("malformed nonce");
    header.nonce = h.nonce;
  }
  if (h.payer !== undefined) {
    if (!isAddress(h.payer)) throw new Error("malformed payer");
    header.payer = h.payer;
  }
  if (h.payee !== undefined) {
    if (!isAddress(h.payee)) throw new Error("malformed payee");
    header.payee = h.payee;
  }
  const ops = t.operations === undefined ? [] : t.operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 32) throw new Error("a transaction needs 1 to 32 operations");
  const operations = ops.map((op) => {
    if (!op || typeof op !== "object" || Array.isArray(op)) throw new Error("malformed operation");
    const keys = Object.keys(op);
    if (keys.length !== 1 || keys[0] !== "call_contract") throw new Error(`only contract calls can be signed from a site; refused "${String(keys[0] ?? "?").slice(0, 40)}"`);
    const cc = (op as { call_contract: Record<string, unknown> }).call_contract;
    if (!cc || typeof cc !== "object") throw new Error("malformed contract call");
    if (!isAddress(cc.contract_id)) throw new Error("malformed contract id");
    const ep = cc.entry_point;
    if (typeof ep !== "number" || !Number.isInteger(ep) || ep < 0 || ep > 0xffffffff) throw new Error("malformed entry point");
    const args = cc.args === undefined ? "" : cc.args;
    if (!isB64url(args)) throw new Error("malformed contract arguments");
    return { call_contract: { contract_id: cc.contract_id, entry_point: ep, args } };
  });
  return { header, operations };
}

/** A canonical token transfer (fields 1, 2, 3 exactly once, 25-byte addresses, varint value) or null. */
export function strictTransfer(argsB64: string): { from: string; to: string; value: bigint } | null {
  try {
    const f = decodeFields(utils.decodeBase64url(argsB64));
    if (f.size !== 3) return null;
    for (const k of [1, 2, 3]) if (f.get(k)?.length !== 1) return null;
    const from = f.get(1)![0], to = f.get(2)![0], value = f.get(3)![0];
    if (!(from instanceof Uint8Array) || !(to instanceof Uint8Array) || typeof value !== "bigint") return null;
    if (from.length !== 25 || to.length !== 25 || value <= 0n) return null;
    return { from: utils.encodeBase58(from), to: utils.encodeBase58(to), value };
  } catch {
    return null;
  }
}

/** What will be signed, fixed before the user is asked. */
export interface Plan {
  req: DappRequest;
  net: Network;
  signerAddress: string | null;
  prepared?: Tx;
  message?: string | Uint8Array;
}

/** Validates the request against the network; throws with the reason to show when it is refused. */
export async function planRequest(req: DappRequest, net: Network): Promise<Plan> {
  const a = req.args ?? {};
  const signerAddress = isAddress(a.signerAddress) ? a.signerAddress : null;
  const p: Plan = { req, net, signerAddress };
  switch (req.command) {
    case "getAccounts":
      return p;
    case "signer:signHash":
      throw new Error("Raw hash signing is turned off in this wallet: a signed hash authorises a transaction you cannot see.");
    case "signer:signMessage":
      p.message = typeof a.message === "string" ? a.message : toBytes(a.message);
      return p;
    case "signer:signTransaction":
    case "signer:sendTransaction":
    case "signer:prepareTransaction": {
      if (!signerAddress) throw new Error("No signer address.");
      const tx = sanitiseTx(a.transaction);
      for (const op of tx.operations!) {
        if (op.call_contract.contract_id === signerAddress) throw new Error("It calls the account's own contract, which could change the key that controls it. Account changes are only made from the wallet itself.");
      }
      const chain = new Chain(net);
      // koilib fills nonce, rc_limit and chain id when missing, then recomputes the merkle root and the id
      await Transaction.prepareTransaction(tx as never, chain.provider, signerAddress);
      const expected = await chain.provider.getChainId();
      if (tx.header?.chain_id !== expected) throw new Error(`It is for a different network than ${net.name}.`);
      p.prepared = tx;
      return p;
    }
    default:
      throw new Error("This kind of request is not supported.");
  }
}

/** Only the transaction fields a dapp needs back. */
export function plainTx(tx: Tx): Record<string, unknown> {
  return { id: tx.id, header: tx.header, operations: tx.operations, signatures: tx.signatures ?? [] };
}

export type Outcome = { result: unknown } | { error: string; status?: string };

/**
 * Carries out an approved plan with the wallet's keys. `accounts` are the stored ones (watch-only
 * excluded here); the detected account is looked up. Refuses, again, anything that touches one of the
 * wallet's own accounts. Never throws for a user-facing refusal; the outcome says what happened.
 */
export async function executePlan(p: Plan, keys: PqKeys, stored: AccountRecord[], onStatus: (s: string) => void = () => undefined): Promise<Outcome> {
  const chain = new Chain(p.net);
  const detected = await detectAccount(chain, keys).catch(() => null);
  const accounts: WalletAccount[] = walletAccounts(keys, stored, p.net.name, detected);
  if (p.req.command === "getAccounts") return { result: accounts.map((x) => ({ name: x.name, address: x.address, signers: [] })) };
  const acct = accounts.find((x) => x.address === p.signerAddress);
  if (!acct) return { error: "request failed in the wallet", status: "This wallet has no such account on this network." };
  // no operation may touch any account of this wallet (its key, allow-list or code)
  const own = new Set([...accounts.map((x) => x.address), bootstrapAddress(keys), keys.address]);
  if (p.prepared?.operations?.some((op) => own.has(op.call_contract.contract_id))) return { error: "refused by the wallet", status: "Refused: the transaction calls one of this wallet's own accounts." };
  const signer = acct.mode === "native" ? PqSigner.native(keys, chain.provider) : PqSigner.pqwallet(keys, acct.address, chain.provider);
  onStatus("Signing…");
  switch (p.req.command) {
    case "signer:signMessage":
      return { result: utils.encodeBase64url(await signer.signMessage(p.message!)) };
    case "signer:prepareTransaction":
      return { result: plainTx(p.prepared!) };
    case "signer:signTransaction":
    case "signer:sendTransaction": {
      const tx = structuredClone(p.prepared!);
      const entry = await signer.signHash(utils.toUint8Array(tx.id!.replace(/^0x/, "")));
      tx.signatures = [utils.encodeBase64url(entry)];
      if (p.req.command === "signer:signTransaction") return { result: plainTx(tx) };
      onStatus("Sending…");
      const broadcast = (p.req.args?.optsSend as { broadcast?: boolean } | undefined)?.broadcast !== false;
      const { receipt } = await chain.provider.sendTransaction(tx as never, broadcast);
      return { result: { receipt, transaction: plainTx(tx) } };
    }
    default:
      return { error: "unsupported request" };
  }
}
