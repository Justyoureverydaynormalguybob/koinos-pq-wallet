// The approval window: shows what a dapp is asking for, takes the passphrase, signs with the
// post-quantum key, and hands the answer back to the background. Keys exist only in this page,
// only after the passphrase, and are wiped as soon as the answer is sent.
//
// Rules that keep "what you see is what you sign" true (from the 2026-10-18 security review):
//   - a transaction is rebuilt HERE from validated fields: operations are re-created field by field,
//     the merkle root and the id are recomputed by koilib, never taken from the page, and the
//     prepared copy is exactly what gets signed after approval;
//   - the prepared transaction's chain id must be the wallet's current network;
//   - only contract calls are accepted; uploads, system operations and any call to one of the
//     wallet's own accounts (which could change the key that controls it) are refused outright;
//   - a token transfer is described as a transfer only when its encoding is canonical (each field
//     exactly once), so the screen and the chain read the same recipient and amount;
//   - raw hash signing is refused: a signed hash is a signature over an unseen transaction;
//   - messages are signed under their own context (koinos-pq-core), never usable as a transaction;
//   - everything rendered goes through esc().
import "../ui/tokens.css";
import { Transaction, utils } from "koilib";
import { hexToBytes } from "@noble/hashes/utils.js";
import { Chain, NETWORKS, PqSigner, bootstrapAddress, deriveKeys, decodeFields, formatKoin, wipe, TOKEN_ENTRY, type Network, type PqKeys } from "koinos-pq-core";
import { localVaultStore, openVault, toFile } from "../core/vault";
import { detectAccount, walletAccounts } from "../core/accounts";
import { addressStrip, button, card, field, header, input, list, listRow, notice, stat, ticker } from "../ui/components";
import { allTokens, findToken, formatUnits } from "../core/tokens";
import { applyTheme } from "../ui/app";

interface Request {
  id: string;
  command: string;
  args: Record<string, unknown> | null;
  origin: string;
}
interface Header {
  chain_id?: string;
  rc_limit?: string;
  nonce?: string;
  payer?: string;
  payee?: string;
}
interface CallContract {
  contract_id: string;
  entry_point: number;
  args: string;
}
interface Tx {
  id?: string;
  header?: Header & { operation_merkle_root?: string };
  operations?: Array<{ call_contract: CallContract }>;
  signatures?: string[];
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const root = document.getElementById("app")!;
applyTheme((pref("theme") as "light" | "dark" | "system" | null) ?? "system");
const reqId = new URLSearchParams(location.search).get("req") ?? "";
let busy = false;

function pref(key: string): string | null {
  try {
    return localStorage.getItem(`koinos-pq-wallet/${key}`);
  } catch {
    return null;
  }
}

/** The network the wallet pages are set to (same localStorage as the wallet, same extension origin). */
function currentNetwork(): Network {
  const name = pref("network");
  const n = (name && NETWORKS[name]) || NETWORKS.mainnet!;
  if (n.name === "devnet") {
    const rpc = pref("devnet-rpc");
    if (rpc) return { ...n, rpc: [rpc] };
  }
  return n;
}

/** Bytes arrive as a Uint8Array, a JSON-ified one ({"0":18,...}), an array, hex or base64url. */
function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v.map((x) => Number(x) & 255));
  if (typeof v === "string") return /^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0 ? hexToBytes(v) : utils.decodeBase64url(v);
  if (v && typeof v === "object") {
    const keys = Object.keys(v).map(Number).sort((x, y) => x - y);
    return Uint8Array.from(keys.map((k) => Number((v as Record<string, number>)[k]) & 255));
  }
  throw new Error("unreadable bytes in request");
}

const isAddress = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{25,36}$/.test(s);
const isUint = (s: unknown): s is string => typeof s === "string" && /^\d{1,20}$/.test(s);
// koilib writes base64url with "=" padding, so up to two trailing "=" are allowed
const isB64url = (s: unknown): s is string => typeof s === "string" && s.length <= 262_144 && /^[A-Za-z0-9_-]*={0,2}$/.test(s);

/** The page's transaction reduced to fields a page may set, each validated; operations rebuilt field by field. */
function sanitiseTx(raw: unknown): Tx {
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
function strictTransfer(argsB64: string): { from: string; to: string; value: bigint } | null {
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

function describeOperation(cc: CallContract, net: Network, signer: string): string {
  // the curated list only: the approval window runs before the passphrase, so a wallet's own additions are not known here
  const token = findToken(allTokens(net.name, null), cc.contract_id);
  const symbol = token?.symbol;
  if (token && cc.entry_point === TOKEN_ENTRY.transfer) {
    const t = strictTransfer(cc.args);
    if (t) {
      const fromNote = t.from === signer ? "" : ` <span class="warn-inline">from a different account, ${esc(t.from)},</span>`;
      return `Send <strong class="mono">${esc(formatUnits(t.value, token.decimals))} ${esc(token.symbol)}</strong>${fromNote} to ${addressStrip(t.to, { size: "sm" })}`;
    }
    return `<span class="warn-inline">Unusual ${esc(symbol)} transfer encoding: the amount and recipient cannot be shown reliably.</span> Call to ${addressStrip(cc.contract_id, { size: "sm" })}`;
  }
  return `Call contract ${addressStrip(cc.contract_id, { size: "sm" })}${symbol ? ` (${esc(symbol)})` : ""}, entry point <code>0x${cc.entry_point.toString(16)}</code>`;
}

function render(html: string, net: Network = currentNetwork()) {
  root.innerHTML = `<div class="shell">${header('<span class="hexstrip">request</span>')}${ticker(net.name, null, false, "what you see is what you sign")}<div class="content plain">${html}<p class="foot">Keys never leave this window · a test build, not audited</p></div></div>`;
}
const refuse = (origin: string, why: string) =>
  render(`<h1 style="font-size:22px">${esc(origin)}</h1>${notice("danger", `This site sent a request the wallet will not sign. ${esc(why)}`)}<div class="row">${button("Close", { variant: "ghost", attrs: "data-refuse" })}</div>`);

// ---- what will be signed, fixed before the passphrase is asked for ----
interface Plan {
  req: Request;
  net: Network;
  signerAddress: string | null;
  prepared?: Tx;
  message?: string | Uint8Array;
}

async function plan(req: Request, net: Network): Promise<Plan> {
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

function describe(p: Plan): string {
  const who = p.signerAddress ? addressStrip(p.signerAddress, { size: "sm" }) : "<strong>?</strong>";
  switch (p.req.command) {
    case "getAccounts":
      return `<p>wants to <strong>see your account addresses</strong>. No signature is involved.</p>`;
    case "signer:signMessage":
      return `<p>wants ${who} to sign this message:</p>${card(`<code class="address addr sm" style="color:var(--ink)">${esc(typeof p.message === "string" ? p.message : utils.toHexString(p.message!))}</code>`)}
        <p class="fine" style="margin-top:8px">A signed message cannot be used as a transaction signature (it is made under a separate context), and no public key can be recovered from it.</p>`;
    default: {
      const tx = p.prepared!;
      const h = tx.header!;
      const verb = p.req.command === "signer:sendTransaction" ? "sign and send" : p.req.command === "signer:prepareTransaction" ? "prepare" : "sign";
      const siteSetLimit = ((p.req.args?.transaction as { header?: { rc_limit?: unknown } } | undefined)?.header?.rc_limit ?? undefined) !== undefined;
      const rows = [
        stat("Network", `<strong>${esc(p.net.name)}</strong>`),
        h.payee ? stat("Payee", `<span class="mono">${esc(h.payee)}</span>`) : "",
        stat("Mana limit", `<strong>${esc(formatKoin(BigInt(h.rc_limit ?? "0"), 2))}</strong>${siteSetLimit ? "" : ' <span class="mute">(the site set no limit: all the mana the account has)</span>'}`),
        stat("Transaction", esc((tx.id ?? "").slice(0, 22)) + "…"),
      ].join("");
      const payerNote = h.payer !== p.signerAddress ? notice("warn", `Mana paid by another account: <span class="mono">${esc(h.payer)}</span>`) : "";
      return `<p>wants ${who} to <strong>${verb}</strong> a transaction:</p>
        ${card(`${list(tx.operations!.map((op, i) => listRow(`<span class="lbl">Operation ${i + 1} of ${tx.operations!.length}</span>${describeOperation(op.call_contract, p.net, p.signerAddress ?? "")}`)).join(""))}<div style="margin-top:8px">${rows}</div>`)}${payerNote ? `<div style="margin-top:12px">${payerNote}</div>` : ""}`;
    }
  }
}

async function main() {
  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-reject]")) void finish({ error: "rejected by the user" });
    if (el.closest("[data-refuse]")) void finish({ error: "refused by the wallet" });
    if (el.closest("[data-open]")) void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
  });
  if (!reqId) return render(`<p>Nothing to approve.</p>`);
  const req = (await chrome.runtime.sendMessage({ type: "pq:get", id: reqId })) as Request | null;
  if (!req || typeof req.command !== "string" || typeof req.origin !== "string") return render(`<p>This request has already been answered or has expired.</p><div class="row">${button("Close", { variant: "primary", attrs: "data-reject" })}</div>`);
  if (!localVaultStore.load()) {
    render(`<h1>No wallet yet</h1><p>This extension has no wallet. Open it, create or import one, then try again from the site.</p><div class="row">${button("Open the wallet", { variant: "primary", attrs: "data-open" })}${button("Reject", { variant: "ghost", attrs: "data-reject" })}</div>`);
    return;
  }
  render(`<h1 style="font-size:22px">${esc(req.origin)}</h1>${notice("busy", "Checking the request…")}`);
  let p: Plan;
  try {
    p = await plan(req, currentNetwork());
  } catch (e) {
    refuse(req.origin, (e as Error).message);
    return;
  }
  render(`
    <h1 style="font-size:22px">${esc(req.origin)}</h1>
    ${describe(p)}
    <form data-form="approve">
      ${field("Passphrase", input({ name: "passphrase", type: "password", required: true, autofocus: true, autocomplete: "off" }))}
      <div class="row">${button("Approve", { variant: "primary" })}${button("Reject", { variant: "ghost", attrs: "data-reject" })}</div>
    </form>
    <p id="status" class="mute"></p>`, p.net);
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) return;
    const pass = String(new FormData(e.target as HTMLFormElement).get("passphrase") ?? "");
    void approve(p, pass);
  });
}

async function approve(p: Plan, passphrase: string) {
  const status = document.getElementById("status")!;
  const button = root.querySelector<HTMLButtonElement>("button[type=submit]");
  let keys: PqKeys | null = null;
  busy = true;
  if (button) button.disabled = true;
  try {
    status.textContent = "Unlocking…";
    const stored = localVaultStore.load();
    if (!stored) throw new Error("no wallet in this extension");
    const { data: vault } = await openVault(await toFile(stored), passphrase); // whichever wallet this passphrase opens (duress mode)
    keys = deriveKeys(hexToBytes(vault.seedHex));
    const chain = new Chain(p.net);
    const detected = await detectAccount(chain, keys).catch(() => null);
    const accounts = walletAccounts(keys, vault.accounts, p.net.name, detected);
    if (p.req.command === "getAccounts") {
      await finish({ result: accounts.map((x) => ({ name: x.name, address: x.address, signers: [] })) });
      return;
    }
    const acct = accounts.find((x) => x.address === p.signerAddress);
    if (!acct) {
      status.textContent = "This wallet has no such account on this network.";
      await finish({ error: "request failed in the wallet" });
      return;
    }
    // no operation may touch any account of this wallet (its key, allow-list or code)
    const own = new Set([...accounts.map((x) => x.address), bootstrapAddress(keys), keys.address]);
    if (p.prepared?.operations?.some((op) => own.has(op.call_contract.contract_id))) {
      status.textContent = "Refused: the transaction calls one of this wallet's own accounts.";
      await finish({ error: "refused by the wallet" });
      return;
    }
    const signer = acct.mode === "native" ? PqSigner.native(keys, chain.provider) : PqSigner.pqwallet(keys, acct.address, chain.provider);
    status.textContent = "Signing…";
    switch (p.req.command) {
      case "signer:signMessage":
        await finish({ result: utils.encodeBase64url(await signer.signMessage(p.message!)) });
        return;
      case "signer:prepareTransaction":
        await finish({ result: plainTx(p.prepared!) });
        return;
      case "signer:signTransaction":
      case "signer:sendTransaction": {
        const tx = structuredClone(p.prepared!);
        const entry = await signer.signHash(utils.toUint8Array(tx.id!.replace(/^0x/, "")));
        tx.signatures = [utils.encodeBase64url(entry)];
        if (p.req.command === "signer:signTransaction") {
          await finish({ result: plainTx(tx) });
          return;
        }
        status.textContent = "Sending…";
        const broadcast = (p.req.args?.optsSend as { broadcast?: boolean } | undefined)?.broadcast !== false;
        const { receipt } = await chain.provider.sendTransaction(tx as never, broadcast);
        await finish({ result: { receipt, transaction: plainTx(tx) } });
        return;
      }
      default:
        await finish({ error: "unsupported request" });
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/wrong passphrase/.test(msg)) {
      status.textContent = "Wrong passphrase.";
      busy = false;
      if (button) button.disabled = false;
      return;
    }
    status.textContent = `Failed: ${msg}`;
    await finish({ error: "request failed in the wallet" });
  } finally {
    if (keys) wipe(keys.secretKey, keys.seed);
  }
}

/** Only the transaction fields a dapp needs back. */
function plainTx(tx: Tx): Record<string, unknown> {
  return { id: tx.id, header: tx.header, operations: tx.operations, signatures: tx.signatures ?? [] };
}

async function finish(message: { result?: unknown; error?: string }) {
  await chrome.runtime.sendMessage({ type: "pq:resolve", id: reqId, ...message });
  window.close();
}

void main().catch((e) => refuse("This request", `It could not be read: ${(e as Error).message}`));
