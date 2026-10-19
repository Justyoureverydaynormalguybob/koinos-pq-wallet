// The approval window: shows what a dapp is asking for, takes the passphrase, signs with the
// post-quantum key, and hands the answer back to the background. Keys exist only in this page,
// only after the passphrase, and are wiped as soon as the answer is sent. The validation, the
// description and the signing itself live in src/core/approval.ts and src/ui/approval-view.ts,
// shared with the in-app dapp browser, so both refuse the same things and sign the same bytes.
import "../ui/tokens.css";
import { NETWORKS, deriveKeys, wipe, type Network, type PqKeys } from "koinos-pq-core";
import { hexToBytes } from "@noble/hashes/utils.js";
import { localVaultStore, openVault, toFile } from "../core/vault";
import { executePlan, planRequest, type DappRequest, type Plan } from "../core/approval";
import { describePlan } from "../ui/approval-view";
import { button, field, header, input, notice, ticker } from "../ui/components";
import { applyTheme } from "../ui/app";
import { initLanguage } from "../i18n";

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const root = document.getElementById("app")!;
applyTheme((pref("theme") as "light" | "dark" | "system" | null) ?? "system");
initLanguage();
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

function render(html: string, net: Network = currentNetwork()) {
  root.innerHTML = `<div class="shell">${header('<span class="hexstrip">request</span>')}${ticker(net.name, null, false, "what you see is what you sign")}<div class="content plain">${html}<p class="foot">Keys never leave this window · a test build, not audited</p></div></div>`;
}
const refuse = (origin: string, why: string) =>
  render(`<h1 style="font-size:22px">${esc(origin)}</h1>${notice("danger", `This site sent a request the wallet will not sign. ${esc(why)}`)}<div class="row">${button("Close", { variant: "ghost", attrs: "data-refuse" })}</div>`);

async function main() {
  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-reject]")) void finish({ error: "rejected by the user" });
    if (el.closest("[data-refuse]")) void finish({ error: "refused by the wallet" });
    if (el.closest("[data-open]")) void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
  });
  if (!reqId) return render(`<p>Nothing to approve.</p>`);
  const req = (await chrome.runtime.sendMessage({ type: "pq:get", id: reqId })) as DappRequest | null;
  if (!req || typeof req.command !== "string" || typeof req.origin !== "string") return render(`<p>This request has already been answered or has expired.</p><div class="row">${button("Close", { variant: "primary", attrs: "data-reject" })}</div>`);
  if (!localVaultStore.load()) {
    render(`<h1>No wallet yet</h1><p>This extension has no wallet. Open it, create or import one, then try again from the site.</p><div class="row">${button("Open the wallet", { variant: "primary", attrs: "data-open" })}${button("Reject", { variant: "ghost", attrs: "data-reject" })}</div>`);
    return;
  }
  render(`<h1 style="font-size:22px">${esc(req.origin)}</h1>${notice("busy", "Checking the request…")}`);
  let p: Plan;
  try {
    p = await planRequest(req, currentNetwork());
  } catch (e) {
    refuse(req.origin, (e as Error).message);
    return;
  }
  render(`
    <h1 style="font-size:22px">${esc(req.origin)}</h1>
    ${describePlan(p)}
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
    const outcome = await executePlan(p, keys, vault.accounts, (s) => {
      status.textContent = s;
    });
    if ("error" in outcome) {
      if (outcome.status) status.textContent = outcome.status;
      await finish({ error: outcome.error });
      return;
    }
    await finish({ result: outcome.result });
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

async function finish(message: { result?: unknown; error?: string }) {
  await chrome.runtime.sendMessage({ type: "pq:resolve", id: reqId, ...message });
  window.close();
}

void main().catch((e) => refuse("This request", `It could not be read: ${(e as Error).message}`));
