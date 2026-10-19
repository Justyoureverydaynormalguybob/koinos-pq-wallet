// @vitest-environment jsdom
// Collectibles through the screens against a fake node: add a collection by address (name and symbol
// read from the contract), open it (tokens by owner), the gallery fills names from token_uri metadata
// (an inline data: URI here, so nothing leaves the process), open one token, start a send to a
// first-time address and land on the recipient check without anything being signed.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");
const { NETWORKS } = await import("koinos-pq-core");

const KOIN = NETWORKS.devnet!.koin;
const COLLECTION = "1GNkfsZp9ySg314QFVZAAew1VDbjGNZrZP";
const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64url");
const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const str = (s: string) => {
  const bytes = [...Buffer.from(s)];
  return b64([0x0a, ...varint(bytes.length), ...bytes]);
};
const uint64 = (v: number) => b64([0x08, v]);
const META = (n: string) => `data:application/json,${encodeURIComponent(JSON.stringify({ name: n, description: "a goat", image: "ipfs://Qmgoat" }))}`;
const calls: string[] = [];
function answer(req: { method: string; params: Record<string, unknown> }): unknown {
  if (req.method === "chain.get_head_info") return { head_topology: { height: "100" } };
  if (req.method === "chain.get_account_rc") return { rc: "500000000" };
  if (req.method === "chain.get_chain_id") return { chain_id: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==" };
  if (req.method === "chain.read_contract") {
    const { contract_id, entry_point, args } = req.params as { contract_id: string; entry_point: number; args: string };
    calls.push(`${contract_id}:${entry_point.toString(16)}`);
    if (contract_id === KOIN && entry_point === 0x5c721497) return { result: uint64(5) };
    if (contract_id === COLLECTION) {
      if (entry_point === 0x82a3537f) return { result: str("Koinos Garden") };
      if (entry_point === 0xb76a7ca1) return { result: str("GOAT") };
      if (entry_point === 0x70e5d7b6) return { result: str("ipfs://Qmbase/") };
      if (entry_point === 0xfc13eb75) return { result: b64([0x0a, 1, 0x07, 0x0a, 2, 0x01, 0x2c]) }; // ids 0x07 and 0x012c (300)
      if (entry_point === 0x40456c8e) {
        const id = Buffer.from(args, "base64url").subarray(2).toString("hex");
        const uri = META(id === "07" ? "Goat #7" : "Goat #300");
        return { result: str(uri) };
      }
    }
    return { result: "" };
  }
  return {};
}
let server: Server;
let rpc = "";
const MAIN = "main passphrase 1234";
const OTHER = "19G2VrmoqgCFRRtgoYF3vFi2ekDsyoRvab";
const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 150));
};
const click = (root: HTMLElement, action: string, extra: Record<string, string> = {}) => {
  const el = [...root.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)].find((e) => Object.entries(extra).every(([k, v]) => e.dataset[k] === v));
  if (!el) throw new Error(`no action ${action}; screen: ${root.querySelector("h1")?.textContent}`);
  el.click();
};
async function submit(root: HTMLElement, form: string, fields: Record<string, string>) {
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`);
  if (!f) throw new Error(`no form ${form}; screen: ${root.querySelector("h1")?.textContent}`);
  for (const [k, v] of Object.entries(fields)) f.querySelector<HTMLInputElement>(`[name="${k}"]`)!.value = v;
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
const text = (root: HTMLElement) => root.textContent ?? "";
const h1 = (root: HTMLElement) => root.querySelector("h1")?.textContent ?? "";

describe("collectibles (jsdom, a fake node over HTTP)", () => {
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
  afterAll(() => server.close());

  it("adds a collection, shows the account's tokens with their names, opens one, and checks a first-time recipient before sending", async () => {
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
    expect(text(root)).toMatch(/No collections yet/);
    await submit(root, "add-collection", { address: "nonsense" });
    expect(text(root)).toMatch(/not a valid Koinos contract address/);
    await submit(root, "add-collection", { address: COLLECTION });
    expect(text(root)).toMatch(/Added Koinos Garden/);
    expect(text(root)).toMatch(/GOAT/);
    expect(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("koinos-pq-wallet/collections/"))!)).toMatch(/Koinos Garden/);
    // open: two tokens, then their names arrive from the metadata
    click(root, "nft-collection", { address: COLLECTION });
    await settle();
    expect(h1(root)).toBe("Koinos Garden");
    expect(root.querySelectorAll(".nft")).toHaveLength(2);
    expect(calls.some((c) => c === `${COLLECTION}:fc13eb75`)).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(text(root)).toMatch(/Goat #7/);
    expect(text(root)).toMatch(/Goat #300/);
    expect(root.querySelector<HTMLImageElement>('[data-nft="012c"] img')?.src).toBe("https://ipfs.io/ipfs/Qmgoat");
    // one token
    click(root, "nft-open", { id: "012c" });
    expect(h1(root)).toBe("Goat #300");
    expect(text(root)).toMatch(/a goat/);
    expect(text(root)).toMatch(/#300/);
    // send to a first-time address: the recipient check, nothing signed
    click(root, "nft-send");
    expect(h1(root)).toBe("Send Goat #300");
    await submit(root, "nft-send", { to: OTHER.slice(0, -1) + "x" });
    expect(text(root)).toMatch(/not a valid Koinos address/);
    await submit(root, "nft-send", { to: OTHER });
    expect(h1(root)).toMatch(/First time sending here/);
    expect(text(root)).toMatch(/GOAT #300/);
    expect(calls.some((c) => c.endsWith(":27f576ca"))).toBe(false);
    click(root, "send-cancel");
    // back on the account: the collection row shows the count
    click(root, "back-home");
    await settle();
    expect(text(root)).toMatch(/2 held/);
    click(root, "collection-remove");
    expect(text(root)).toMatch(/No collections yet/);
  }, 120_000);
});
