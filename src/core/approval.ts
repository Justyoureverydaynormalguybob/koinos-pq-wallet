// What a dapp may ask the wallet to do, and the rules that keep "what you see is what you sign" true.
// Shared by the extension's approval window and the in-app dapp browser, so both refuse the same
// things and sign the same bytes (from the 2026-10-18 security review):
//   - a transaction is rebuilt HERE from validated fields: operations are re-created field by field,
//     the merkle root and the id are recomputed by koilib, never taken from the page, and the
//     prepared copy is exactly what gets signed after approval;
//   - the chain id is the wallet's own pinned one for the current network (koinos-pq-core's Chain.chainId):
//     never the node's answer alone, and a network with no pin may not be one of the pinned chains;
//   - a transaction numbered ahead of the account's next one is refused: its signature could be kept
//     and used after later transactions have gone through;
//   - signatures the page already has on the transaction (a payer's) are kept and the wallet's is added;
//   - only contract calls are accepted; uploads, system operations and any call to one of the
//     wallet's own accounts (which could change the key that controls it) are refused outright;
//   - a token transfer is described as a transfer only when its encoding is canonical (each field
//     exactly once), so the screen and the chain read the same recipient and amount;
//   - raw hash signing is refused: a signed hash is a signature over an unseen transaction;
//   - messages are signed under their own context (koinos-pq-core), never usable as a transaction.
import { Transaction, utils } from "koilib";
import { hexToBytes } from "@noble/hashes/utils.js";
import { Chain, PqSigner, bootstrapAddress, decodeFields, type Network, type PqKeys } from "koinos-pq-core";
import { accountKeys, detectAccounts, keysWiped, walletAccounts, type FoundAccount, type WalletAccount } from "./accounts";
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
/** Signatures a page may bring on a transaction (a payer's, a co-signer's), before the wallet adds its own. */
export const MAX_PAGE_SIGNATURES = 4;

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
  const t = raw as { header?: unknown; operations?: unknown; signatures?: unknown };
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
  // Signatures already on the transaction: a payer who sponsors the mana signs first, and dropping that
  // signature made every sponsored transaction fail. They are carried along as they are. They cannot change
  // what this wallet signs (the id covers the header and the operations, not the signatures), and the sheet
  // says how many there are. Each is at most a native ML-DSA-44 entry (3,733 bytes).
  const sigs = t.signatures === undefined || t.signatures === null ? [] : t.signatures;
  if (!Array.isArray(sigs) || sigs.length > MAX_PAGE_SIGNATURES) throw new Error(`a transaction may bring at most ${MAX_PAGE_SIGNATURES} signatures`);
  const signatures = sigs.map((x) => {
    if (!isB64url(x) || x.length === 0 || x.length > 5120) throw new Error("malformed signature");
    return x;
  });
  return { header, operations, ...(signatures.length ? { signatures } : {}) };
}

/** A transaction nonce (koinos.chain.value_type { uint64_value = 5 }) as a number, or null when it is not one. */
export function nonceValue(nonceB64: string | undefined): bigint | null {
  if (!nonceB64) return null;
  try {
    const f = decodeFields(utils.decodeBase64url(nonceB64));
    const v = f.get(5);
    if (f.size !== 1 || v?.length !== 1 || typeof v[0] !== "bigint") return null;
    return v[0];
  } catch {
    return null;
  }
}

/** The longest memo put into words; a longer one is not a plain call. */
export const MAX_MEMO_BYTES = 256;
/** A KCS-4 memo field (`optional string memo`) as text: valid UTF-8 of a sane length, or null. */
export function memoText(v: bigint | Uint8Array | undefined): string | null {
  if (!(v instanceof Uint8Array) || v.length > MAX_MEMO_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(v);
  } catch {
    return null;
  }
}

/**
 * A canonical token transfer or null: fields 1, 2, 3 exactly once (25-byte addresses, varint value), and
 * the standard's optional memo (kcs4.proto: `optional string memo = 4`) at most once. `memo` is null when
 * there is none. Anything else in the arguments, or a field given twice, is not a plain transfer.
 */
export function strictTransfer(argsB64: string): { from: string; to: string; value: bigint; memo: string | null } | null {
  try {
    const f = decodeFields(utils.decodeBase64url(argsB64));
    for (const k of f.keys()) if (k < 1 || k > 4) return null;
    for (const k of [1, 2, 3]) if (f.get(k)?.length !== 1) return null;
    const from = f.get(1)![0], to = f.get(2)![0], value = f.get(3)![0];
    if (!(from instanceof Uint8Array) || !(to instanceof Uint8Array) || typeof value !== "bigint") return null;
    if (from.length !== 25 || to.length !== 25 || value <= 0n) return null;
    let memo: string | null = null;
    if (f.has(4)) {
      if (f.get(4)!.length !== 1) return null;
      memo = memoText(f.get(4)![0]);
      if (memo === null) return null;
    }
    return { from: utils.encodeBase58(from), to: utils.encodeBase58(to), value, memo };
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
  /** the transaction's number, for the sheet (null when it does not read as one) */
  nonce?: bigint | null;
  /** how many signatures the page brought on the transaction; the wallet's is added after them */
  coSignatures?: number;
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
      // The chain id is the wallet's own for this network (pinned for mainnet and testnet; on a devnet the
      // node's answer, which may not be a pinned chain's id). The node is never the one that says which
      // chain a signature is for: the same key has the same address on every network, so a node that
      // answered "mainnet" while the sheet says "devnet" would otherwise collect a mainnet signature.
      const expected = await chain.chainId();
      if (tx.header!.chain_id !== undefined && tx.header!.chain_id !== expected) throw new Error(`It is for a different network than ${net.name}.`);
      tx.header!.chain_id = expected;
      const pageNonce = tx.header!.nonce;
      // koilib fills nonce and rc_limit when missing, then recomputes the merkle root and the id
      await Transaction.prepareTransaction(tx as never, chain.provider, signerAddress);
      if (tx.header?.chain_id !== expected) throw new Error(`It is for a different network than ${net.name}.`);
      // A page may number the transaction itself. One numbered AHEAD of the account's next cannot go through
      // now, but its signature stays good: a site could say "that failed", have the same payment signed again
      // with the right number, and use the first signature once that one has landed. So it is not signed.
      // (koilib numbers from the chain's own count, so an honest dapp never asks for a later number.)
      p.nonce = nonceValue(tx.header?.nonce);
      if (pageNonce !== undefined) {
        if (p.nonce === null) throw new Error("Its transaction number (nonce) is not in the form the chain uses.");
        const next = nonceValue(await chain.provider.getNextNonce(tx.header!.payee || tx.header!.payer!));
        if (next === null) throw new Error(`The ${net.name} node did not say what the account's next transaction number is.`);
        if (p.nonce > next) throw new Error(`It is numbered ${p.nonce}, but the next transaction of that account is number ${next}. A signature for a later number could be kept and used after your next transactions have gone through, so the wallet does not give one.`);
      }
      p.coSignatures = tx.signatures?.length ?? 0;
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
/**
 * The name every account carries when a dapp is shown it. The wallet's own names ("Account 3", or a label
 * the user typed) would tell a site how many accounts there are, or something the user wrote for themselves.
 */
export const DAPP_ACCOUNT_NAME = "Sparán account";

/**
 * `only`: for a request to see the accounts, the addresses to answer with. The in-app sheet ALWAYS passes
 * the ones it showed the user, so an account found on the chain after the sheet was drawn is never given
 * out unseen. Absent (the extension's window, which shows no list): all the wallet can sign for here.
 */
export async function executePlan(p: Plan, keys: PqKeys, stored: AccountRecord[], onStatus: (s: string) => void = () => undefined, only?: ReadonlyArray<string>): Promise<Outcome> {
  const chain = new Chain(p.net);
  if (keysWiped(keys)) return { error: "request failed in the wallet", status: "The wallet locked." };
  const bootstrap = bootstrapAddress(keys), native = keys.address; // derived before any await
  const detected = await detectAccounts(chain, keys).catch(() => [] as FoundAccount[]);
  if (keysWiped(keys)) return { error: "request failed in the wallet", status: "The wallet locked." };
  const accounts: WalletAccount[] = walletAccounts(keys, stored, p.net.name, detected);
  // `only`: the accounts the user chose to show this site (absent: all the wallet can sign for here)
  if (p.req.command === "getAccounts") return { result: accounts.filter((x) => !only || only.includes(x.address)).map((x) => ({ name: DAPP_ACCOUNT_NAME, address: x.address, signers: [] })) };
  const acct = accounts.find((x) => x.address === p.signerAddress);
  if (!acct) return { error: "request failed in the wallet", status: "This wallet has no such account on this network." };
  // no operation may touch any account of this wallet (its key, allow-list or code)
  const own = new Set([...accounts.map((x) => x.address), bootstrap, native]);
  if (p.prepared?.operations?.some((op) => own.has(op.call_contract.contract_id))) return { error: "refused by the wallet", status: "Refused: the transaction calls one of this wallet's own accounts." };
  // each account signs with its own key: the wallet's for account 0, a derived one for the rest.
  // The signer is made for the wallet's own chain id and refuses a transaction that names another.
  let chainId: string | undefined;
  if (p.prepared) {
    try {
      chainId = await chain.chainId();
    } catch (e) {
      return { error: "request failed in the wallet", status: (e as Error).message || "The node could not be asked which chain it is." };
    }
    if (keysWiped(keys)) return { error: "request failed in the wallet", status: "The wallet locked." };
  }
  const signer = acct.mode === "native" ? PqSigner.native(keys, chain.provider, chainId) : PqSigner.pqwallet(accountKeys(keys, acct.key), acct.address, chain.provider, chainId);
  if (keysWiped(keys)) return { error: "request failed in the wallet", status: "The wallet locked." };
  onStatus("Signing…");
  switch (p.req.command) {
    case "signer:signMessage":
      return { result: utils.encodeBase64url(await signer.signMessage(p.message!)) };
    case "signer:prepareTransaction":
      return { result: plainTx(p.prepared!) };
    case "signer:signTransaction":
    case "signer:sendTransaction": {
      const tx = structuredClone(p.prepared!);
      // signTransaction works the id out again from the header and operations (never signs a number it was
      // handed), checks the chain id, and adds this account's signature after any the page brought
      try {
        await signer.signTransaction(tx as never);
      } catch (e) {
        return { error: "refused by the wallet", status: `Refused: ${(e as Error).message || "the transaction could not be checked"}.` };
      }
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
