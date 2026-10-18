// The approval window: shows what a dapp is asking for, takes the passphrase, signs with the
// post-quantum key, and hands the answer back to the background. Keys exist only in this page,
// only after the passphrase, and are wiped as soon as the answer is sent.
import "../style.css";
import { utils } from "koilib";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  Chain, NETWORKS, PqSigner, deriveKeys, decodeFields, formatKoin, short, wipe, TOKEN_ENTRY,
  type AccountMode, type Network, type PqKeys,
} from "koinos-pq-core";
import { decryptVault, localVaultStore } from "../core/vault";

interface Request {
  id: string;
  command: string;
  args: Record<string, unknown> | null;
  origin: string;
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const root = document.getElementById("app")!;
const reqId = new URLSearchParams(location.search).get("req") ?? "";

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
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (typeof v === "string") return /^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0 ? hexToBytes(v) : utils.decodeBase64url(v);
  if (v && typeof v === "object") {
    const keys = Object.keys(v).map(Number).sort((x, y) => x - y);
    return Uint8Array.from(keys.map((k) => Number((v as Record<string, number>)[k])));
  }
  throw new Error("unreadable bytes in request");
}

function describeOperation(op: Record<string, unknown>, net: Network): string {
  const cc = op.call_contract as { contract_id?: string; entry_point?: number; args?: string } | undefined;
  if (cc) {
    if (cc.contract_id === net.koin && cc.entry_point === TOKEN_ENTRY.transfer && cc.args) {
      try {
        const f = decodeFields(utils.decodeBase64url(cc.args));
        const to = f.get(2)?.[0], value = f.get(3)?.[0];
        return `Send <strong>${esc(formatKoin(typeof value === "bigint" ? value : 0n))} KOIN</strong> to <code>${esc(to instanceof Uint8Array ? utils.encodeBase58(to) : "?")}</code>`;
      } catch {
        /* not a plain transfer; fall through to the generic line */
      }
    }
    return `Call contract <code>${esc(short(cc.contract_id))}</code>, entry point <code>0x${(cc.entry_point ?? 0).toString(16)}</code>`;
  }
  if (op.upload_contract) {
    const u = op.upload_contract as { contract_id?: string };
    return `<strong>Upload a contract</strong> to <code>${esc(short(u.contract_id))}</code>`;
  }
  if (op.set_system_call || op.set_system_contract) return `<strong>System operation</strong> (${esc(Object.keys(op)[0])})`;
  return `Operation <code>${esc(Object.keys(op)[0] ?? "?")}</code>`;
}

function render(html: string) {
  root.innerHTML = `<header class="top"><div class="brand">Koinos PQ Wallet <span class="tag">request</span></div></header><section class="card">${html}</section><footer class="foot">Keys never leave this window. Not audited.</footer>`;
}

async function main() {
  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-reject]")) void finish({ error: "rejected by the user" });
    if (el.closest("[data-close]")) window.close();
    if (el.closest("[data-open]")) void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
  });

  if (!reqId) return render(`<p>Nothing to approve.</p>`);
  const req = (await chrome.runtime.sendMessage({ type: "pq:get", id: reqId })) as Request | null;
  if (!req) return render(`<p>This request has already been answered or has expired.</p><div class="row"><button class="primary" data-close>Close</button></div>`);
  if (!localVaultStore.load()) {
    render(`<h1>No wallet yet</h1><p>This extension has no wallet. Open it, create or import one, then try again from the site.</p><div class="row"><button class="primary" data-open>Open the wallet</button><button class="ghost" data-reject>Reject</button></div>`);
    return;
  }
  const net = currentNetwork();
  const a = req.args ?? {};
  const signerAddress = typeof a.signerAddress === "string" ? a.signerAddress : null;

  let what = "";
  switch (req.command) {
    case "getAccounts":
      what = `<p>wants to <strong>see your account addresses</strong>. No signature is involved.</p>`;
      break;
    case "signer:signTransaction":
    case "signer:sendTransaction":
    case "signer:prepareTransaction": {
      const tx = (a.transaction ?? {}) as { operations?: Array<Record<string, unknown>>; header?: { rc_limit?: string; payer?: string } };
      const ops = tx.operations ?? [];
      const verb = req.command === "signer:sendTransaction" ? "sign and send" : req.command === "signer:prepareTransaction" ? "prepare" : "sign";
      what = `<p>wants <strong>${esc(short(signerAddress ?? "?"))}</strong> to ${verb} a transaction on <strong>${esc(net.name)}</strong>:</p>
        <ul class="plain">${ops.map((op) => `<li>${describeOperation(op, net)}</li>`).join("") || "<li class='muted'>no operations</li>"}</ul>
        ${tx.header?.rc_limit ? `<p class="muted">Mana limit ${esc(formatKoin(BigInt(tx.header.rc_limit), 2))}</p>` : ""}`;
      break;
    }
    case "signer:signHash":
      what = `<p class="warn">wants <strong>${esc(short(signerAddress ?? "?"))}</strong> to sign a raw hash. You cannot see what it means; approve only if you trust this site completely.</p><code class="address">${esc(utils.toHexString(toBytes(a.hash)))}</code>`;
      break;
    case "signer:signMessage":
      what = `<p>wants <strong>${esc(short(signerAddress ?? "?"))}</strong> to sign this message:</p><code class="address">${esc(typeof a.message === "string" ? a.message : utils.toHexString(toBytes(a.message)))}</code><p class="muted">A post-quantum signature cannot be used to recover a public key; sites that rely on that will not accept it.</p>`;
      break;
    default:
      what = `<p>sent an unsupported request (${esc(req.command)}).</p>`;
  }

  render(`
    <h1>${esc(req.origin)}</h1>
    ${what}
    <form data-form="approve">
      <label>Passphrase<input name="passphrase" type="password" required autofocus autocomplete="current-password"></label>
      <div class="row"><button class="primary" type="submit">Approve</button><button class="ghost" type="button" data-reject>Reject</button></div>
    </form>
    <p id="status" class="muted"></p>`);

  root.addEventListener("submit", (e) => {
    e.preventDefault();
    const pass = String(new FormData(e.target as HTMLFormElement).get("passphrase") ?? "");
    void approve(req, pass, net, signerAddress);
  });
}

async function approve(req: Request, passphrase: string, net: Network, signerAddress: string | null) {
  const status = document.getElementById("status")!;
  let keys: PqKeys | null = null;
  try {
    status.textContent = "Unlocking…";
    const enc = localVaultStore.load();
    if (!enc) throw new Error("no wallet in this extension");
    const vault = await decryptVault(enc, passphrase);
    keys = deriveKeys(hexToBytes(vault.seedHex));
    const accounts: Array<{ name: string; address: string; mode: AccountMode }> = [
      { name: "Post-quantum address (native)", address: keys.address, mode: "native" },
      ...vault.accounts.map((x) => ({ name: x.label, address: x.address, mode: x.mode })),
    ];
    const a = req.args ?? {};

    if (req.command === "getAccounts") {
      await finish({ result: accounts.map((x) => ({ name: x.name, address: x.address, signers: [] })) });
      return;
    }
    const acct = accounts.find((x) => x.address === signerAddress);
    if (!acct) throw new Error(`this wallet has no account ${signerAddress ?? "(none given)"}`);
    const chain = new Chain(net);
    const signer = acct.mode === "native" ? PqSigner.native(keys, chain.provider) : PqSigner.pqwallet(keys, acct.address, chain.provider);

    status.textContent = "Signing…";
    switch (req.command) {
      case "signer:signHash": {
        const sig = await signer.signHash(toBytes(a.hash));
        await finish({ result: { __u8: utils.encodeBase64url(sig) } });
        return;
      }
      case "signer:signMessage": {
        const sig = await signer.signMessage(typeof a.message === "string" ? a.message : toBytes(a.message));
        await finish({ result: utils.encodeBase64url(sig) });
        return;
      }
      case "signer:prepareTransaction": {
        const tx = await signer.prepareTransaction((a.transaction ?? {}) as never);
        await finish({ result: plainTx(tx) });
        return;
      }
      case "signer:signTransaction": {
        const tx = await signer.signTransaction((a.transaction ?? {}) as never);
        await finish({ result: plainTx(tx) });
        return;
      }
      case "signer:sendTransaction": {
        status.textContent = "Signing and sending…";
        const { receipt, transaction } = await signer.sendTransaction((a.transaction ?? {}) as never, (a.optsSend ?? {}) as { broadcast?: boolean });
        await finish({ result: { receipt, transaction: plainTx(transaction) } });
        return;
      }
      default:
        throw new Error(`unsupported command ${req.command}`);
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/wrong passphrase/.test(msg)) {
      status.textContent = "Wrong passphrase.";
      return;
    }
    await finish({ error: msg });
  } finally {
    if (keys) wipe(keys.secretKey, keys.seed);
  }
}

/** Only the transaction fields a dapp needs back (koilib hangs a wait() function off the object; it cannot cross). */
function plainTx(tx: { id?: string; header?: unknown; operations?: unknown; signatures?: unknown }): Record<string, unknown> {
  const { id, header, operations, signatures } = tx;
  return { id, header, operations, signatures };
}

async function finish(message: { result?: unknown; error?: string }) {
  await chrome.runtime.sendMessage({ type: "pq:resolve", id: reqId, ...message });
  window.close();
}

void main();
