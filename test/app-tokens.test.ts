// @vitest-environment jsdom
// The token parts of the UI: the Account tab lists the network's tokens with balances read per contract,
// "hide zero balances" and "add a token by address" work, and Send offers a token picker whose decimals
// decide what an amount means. The node is a small HTTP server in this process, reached through the
// devnet's configurable RPC address (koilib fetches through node-fetch, which no global stub reaches).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));

const { App } = await import("../src/ui/app");
const { NETWORKS } = await import("koinos-pq-core");

// A fake node: KOIN balance 5 (8 decimals), mana 5, head 100. "NEW" answers like a 3-decimal token called X
// with a balance of 250,000; "ZERO" like a 0-decimal token called Z with nothing. Answers are base64url
// protobuf, as the real node sends them.
const KOIN = NETWORKS.devnet!.koin;
const NEW = "19G2VrmoqgCFRRtgoYF3vFi2ekDsyoRvab";
const ZERO = "1JZ2fwcuwRPLSJd3cdNpwLGkLAPktVUkqp";
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
const str = (s: string) => b64([0x0a, s.length, ...Buffer.from(s)]);
const calls: string[] = [];
function answer(req: { method: string; params: Record<string, unknown> }): unknown {
  if (req.method === "chain.get_head_info") return { head_topology: { height: "100" } };
  if (req.method === "chain.get_account_rc") return { rc: "500000000" };
  if (req.method === "chain.get_chain_id") return { chain_id: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==" };
  if (req.method === "chain.read_contract") {
    const { contract_id, entry_point } = req.params as { contract_id: string; entry_point: number };
    calls.push(`${contract_id}:${entry_point.toString(16)}`);
    if (entry_point === 0x5c721497) return { result: uint64(contract_id === KOIN ? 500000000n : contract_id === NEW ? 250000000n : 0n) };
    if (entry_point === 0x82a3537f) return { result: str(contract_id === ZERO ? "Zero token" : "A token") };
    if (entry_point === 0xb76a7ca1) return { result: str(contract_id === ZERO ? "Z" : "X") };
    if (entry_point === 0xee80fd2f) return { result: contract_id === ZERO ? "" : b64([0x08, 3]) };
    return { result: "" };
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
async function submit(root: HTMLElement, form: string, fields: Record<string, string>) {
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`);
  if (!f) throw new Error(`no form ${form}; screen shows: ${root.querySelector("h1")?.textContent}`);
  for (const [k, v] of Object.entries(fields)) {
    const input = f.querySelector<HTMLInputElement>(`[name="${k}"]`);
    if (!input) throw new Error(`no field ${k} in ${form}`);
    input.value = v;
  }
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
const text = (root: HTMLElement) => root.textContent ?? "";
const rowAmount = (root: HTMLElement, contract: string) => root.querySelector(`[data-token="${contract}"] .amt`)?.textContent?.trim();

describe("tokens on the Account tab and in Send (jsdom, a fake node over HTTP)", () => {
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
    const addr = server.address() as { port: number };
    rpc = `http://127.0.0.1:${addr.port}/`;
  });
  afterAll(() => server.close());

  it("lists the network's tokens with balances read per contract, hides zeros, adds a token by address, picks a token to send", async () => {
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
    // on the devnet the native address is the account; its KOIN balance comes from the fake node
    expect(root.querySelector("h1")).toBeNull();
    expect(rowAmount(root, KOIN)).toBe("5");
    expect(calls.some((c) => c === `${KOIN}:5c721497`)).toBe(true);

    // add two tokens by address: name, symbol and decimals come from the contracts; balances are read in each token's decimals
    await submit(root, "add-token", { address: NEW });
    expect(text(root)).toMatch(/Added X \(A token\)/);
    await submit(root, "add-token", { address: ZERO });
    expect(text(root)).toMatch(/Added Z \(Zero token\)/);
    await new Promise((r) => setTimeout(r, 400));
    expect(rowAmount(root, NEW)).toBe("250,000"); // 250000000 base units at 3 decimals
    // Z holds nothing and "hide zero balances" is on by default, so its row is gone once the balance is known
    click(root, "refresh");
    await settle();
    await new Promise((r) => setTimeout(r, 400));
    expect(root.querySelector(`[data-token="${ZERO}"]`)).toBeNull();
    const hide = root.querySelector<HTMLInputElement>('input[name="hideZero"]')!;
    hide.checked = false;
    hide.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(rowAmount(root, ZERO)).toBe("0");
    expect(localStorage.getItem("koinos-pq-wallet/hide-zero")).toBe("0");
    // the additions are stored under this wallet's namespace
    const key = Object.keys(localStorage).find((k) => k.startsWith("koinos-pq-wallet/tokens/"))!;
    expect(localStorage.getItem(key)).toMatch(/19G2Vrmo/);
    // a bad address is refused before any read
    await submit(root, "add-token", { address: "nonsense" });
    expect(text(root)).toMatch(/not a valid Koinos contract address/);

    // Send: the picker lists KOIN first; amounts are parsed in the chosen token's decimals
    click(root, "send");
    const select = root.querySelector<HTMLSelectElement>('select[name="token"]')!;
    expect(select.options[0]!.value).toBe(KOIN);
    expect([...select.options].map((o) => o.value)).toContain(NEW);
    expect(root.querySelector("h1")?.textContent).toBe("Send KOIN");
    select.value = NEW;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(root.querySelector("h1")?.textContent).toBe("Send X");
    expect(root.querySelector("#amount-label")?.textContent).toBe("Amount (X)");
    const form = root.querySelector<HTMLFormElement>('form[data-form="send"]')!;
    form.querySelector<HTMLInputElement>('[name="to"]')!.value = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
    form.querySelector<HTMLInputElement>('[name="amount"]')!.value = "1.2345"; // four places: too many for a 3-decimal token
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(text(root)).toMatch(/3 decimal places at most/);
    // the error re-rendered the screen (the picked token kept), so the form is a new element
    const form2 = root.querySelector<HTMLFormElement>('form[data-form="send"]')!;
    expect(form2.querySelector<HTMLSelectElement>('[name="token"]')!.value).toBe(NEW);
    form2.querySelector<HTMLInputElement>('[name="to"]')!.value = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
    form2.querySelector<HTMLInputElement>('[name="amount"]')!.value = "1.5";
    form2.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    // a first-time recipient: the confirmation names the token; nothing has been signed
    expect(root.querySelector("h1")?.textContent).toMatch(/First time sending here/);
    expect(text(root)).toMatch(/1\.5 X/);
    expect(calls.some((c) => c.includes(":27f576ca"))).toBe(false);

    // remove an added token again
    click(root, "send-cancel");
    click(root, "back-home");
    await settle();
    click(root, "token-remove");
    expect(root.querySelector(`[data-token="${NEW}"]`)).toBeNull();
    expect(root.querySelector(`[data-token="${ZERO}"]`)).not.toBeNull();
  }, 120_000);
});
