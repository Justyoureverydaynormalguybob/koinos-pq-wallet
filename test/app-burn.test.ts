// @vitest-environment jsdom
// Burn KOIN for VHP: the Account tab offers it only where the network has a proof-of-burn contract, the
// screen keeps 2 KOIN back, nothing is signed until the "cannot be undone" box is ticked, and what reaches
// the node is one pob.burn call for exactly the amount typed, from and to the account itself.
// The node is a small HTTP server in this process (see app-tokens.test.ts for why).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
// jsdom brings its own Uint8Array, while Buffer and TextEncoder hand out Node's; koilib's hashing then refuses the
// bytes ("Uint8Array expected") when it builds a transaction id. A browser has one realm, so use one here too.
globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor;
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));

const { App } = await import("../src/ui/app");
const { NETWORKS, POB_ENTRY, decodeFields } = await import("koinos-pq-core");
const { utils } = await import("koilib");

const KOIN = NETWORKS.devnet!.koin;
const POB = "1MAbK5pYkhp9yHnfhYamC3tfSLmVRTDjd9", VHP = "17n12ktwN79sR6ia9DDgCfmw77EgpbTyBi";
const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64url");
const uint64 = (v: bigint) => {
  const out = [0x08];
  let x = v;
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x > 0n) b |= 0x80;
    out.push(b);
  } while (x > 0n);
  return b64(out);
};
type Tx = { header: { payer: string }; operations: Array<{ call_contract: { contract_id: string; entry_point: number; args: string } }>; signatures: string[] };
const submitted: Tx[] = [];
// KOIN balance 5, mana 5: with 2 kept back, 3 can be burned
function answer(req: { method: string; params: Record<string, unknown> }): unknown {
  if (req.method === "chain.get_head_info") return { head_topology: { height: "100" } };
  if (req.method === "chain.get_account_rc") return { rc: "500000000" };
  if (req.method === "chain.get_account_nonce") return { nonce: "" };
  if (req.method === "chain.get_chain_id") return { chain_id: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==" };
  if (req.method === "chain.read_contract") {
    const { contract_id, entry_point } = req.params as { contract_id: string; entry_point: number };
    if (entry_point === 0x5c721497) return { result: uint64(contract_id === KOIN ? 500000000n : 0n) };
    return { result: "" };
  }
  if (req.method === "chain.submit_transaction") {
    submitted.push((req.params as { transaction: Tx }).transaction);
    return { receipt: { rc_used: "78193386" } };
  }
  return {};
}
let server: Server;
let rpc = "";

const MAIN = "main passphrase 1234";
const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 150));
};
const click = (root: HTMLElement, action: string) => {
  const el = root.querySelector<HTMLElement>(`[data-action="${action}"]`);
  if (!el) throw new Error(`no action ${action}`);
  el.click();
};
async function submit(root: HTMLElement, form: string, fields: Record<string, string>, tick: string[] = []) {
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`);
  if (!f) throw new Error(`no form ${form}; screen shows: ${root.querySelector("h1")?.textContent}`);
  for (const [k, v] of Object.entries(fields)) {
    const input = f.querySelector<HTMLInputElement>(`[name="${k}"]`);
    if (!input) throw new Error(`no field ${k} in ${form}`);
    input.value = v;
  }
  for (const name of tick) f.querySelector<HTMLInputElement>(`[name="${name}"]`)!.checked = true;
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
const text = (root: HTMLElement) => root.textContent ?? "";

async function newWallet(): Promise<HTMLElement> {
  localStorage.clear();
  localStorage.setItem("koinos-pq-wallet/network", "devnet");
  localStorage.setItem("koinos-pq-wallet/devnet-rpc", rpc);
  document.body.innerHTML = `<div id="app"></div>`;
  const root = document.getElementById("app")!;
  new App(root);
  click(root, "create");
  const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
  click(root, "wrote-down");
  const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
  await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]! });
  await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
  await new Promise((r) => setTimeout(r, 300));
  return root;
}

describe("burn KOIN for VHP (jsdom, a fake node over HTTP)", () => {
  const devnet = NETWORKS.devnet!;
  const saved = { pob: devnet.pob, vhp: devnet.vhp };
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const r = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: answer(r) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });
  afterAll(() => {
    server.close();
    Object.assign(devnet, saved);
  });

  it("is not offered on a network with no proof-of-burn contract", async () => {
    Object.assign(devnet, { pob: null, vhp: null });
    const root = await newWallet();
    expect(root.querySelector('[data-action="send"]')).not.toBeNull();
    expect(root.querySelector('[data-action="burn"]')).toBeNull();
  }, 120_000);

  it("keeps 2 KOIN back, wants the box ticked, and sends one pob.burn for the amount typed", async () => {
    Object.assign(devnet, { pob: POB, vhp: VHP });
    const root = await newWallet();
    click(root, "burn");
    expect(root.querySelector("h1")?.textContent).toBe("Burn KOIN for VHP");
    expect(text(root)).toMatch(/cannot be undone/);
    expect(root.querySelector("#burn-most")?.textContent).toBe("3 KOIN");

    // the box is not ticked: nothing is signed
    await submit(root, "burn", { amount: "1" });
    expect(text(root)).toMatch(/Tick the box once you understand/);
    expect(submitted.length).toBe(0);

    // more than balance less the 2 kept back: refused before signing
    await submit(root, "burn", { amount: "3.5" }, ["understood"]);
    expect(text(root)).toMatch(/The most this account can burn right now is 3 KOIN/);
    expect(submitted.length).toBe(0);

    // not a number
    await submit(root, "burn", { amount: "lots" }, ["understood"]);
    expect(submitted.length).toBe(0);
    expect(root.querySelector('form[data-form="burn"]')).not.toBeNull();

    await submit(root, "burn", { amount: "1.25" }, ["understood"]);
    expect(submitted.length, root.querySelector(".notice.danger, [role=alert]")?.textContent ?? text(root).slice(0, 300)).toBe(1);
    const tx = submitted[0]!;
    // a native account needs no allow/forbid pair: the burn is the only operation
    expect(tx.operations.length).toBe(1);
    const op = tx.operations[0]!.call_contract;
    expect(op.contract_id).toBe(POB);
    expect(op.entry_point).toBe(POB_ENTRY.burn);
    const f = decodeFields(utils.decodeBase64url(op.args));
    expect(f.get(1)?.[0]).toBe(125000000n);
    const me = tx.header.payer;
    expect(utils.encodeBase58(f.get(2)![0] as Uint8Array)).toBe(me);
    expect(utils.encodeBase58(f.get(3)![0] as Uint8Array)).toBe(me);
    expect(tx.signatures.length).toBe(1);

    expect(root.querySelector("h1")?.textContent).toBe("Submitted");
    expect(text(root)).toMatch(/Burned for the same amount of VHP/);
    expect(text(root)).toMatch(/1\.25/);
    // Android back from the result goes home
    click(root, "back-home");
    await settle();
    expect(root.querySelector('[data-action="burn"]')).not.toBeNull();
  }, 120_000);
});
