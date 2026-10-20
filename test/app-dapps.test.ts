// @vitest-environment jsdom
// The in-app dapp browser through the screens, with a fake native plugin: open a page, the page asks
// for the accounts (sheet, approve, answered; the site is remembered and not asked again), a raw hash
// signing request is refused with the reason on the sheet, an origin the page does not have is
// dropped, and closing answers everything left. The page is a simulated kondor-js client.
import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { PqBrowserPlugin, NavigationEvent } from "../src/native/pq-browser";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");

const MAIN = "main passphrase 1234";
const PQ = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
const ORIGIN = "https://dapp.example";

/** A fake of the native plugin: records calls, lets the test play the page. */
function fakeBrowser() {
  const calls: string[] = [];
  const replies: Array<{ id: string; result?: unknown; error?: string }> = [];
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  let script = "";
  const plugin: PqBrowserPlugin = {
    async open(o) {
      calls.push(`open ${o.url} top=${o.top} bottom=${o.bottom}`);
      script = o.script;
      emit("navigation", { url: o.url, title: "Page", canGoBack: false });
    },
    async navigate(o) {
      calls.push(`navigate ${o.url}`);
      emit("navigation", { url: o.url, title: "Page 2", canGoBack: true });
    },
    async back() {
      calls.push("back");
      return { canGoBack: false };
    },
    async close() {
      calls.push("close");
      emit("closed", {});
    },
    async show() {
      calls.push("show");
    },
    async hide() {
      calls.push("hide");
    },
    async setDesktop(o) {
      calls.push(`desktop ${o.on}`);
    },
    async setFrame(o) {
      calls.push(`frame top=${o.top} bottom=${o.bottom}`);
    },
    async reply(o) {
      replies.push(JSON.parse(o.json));
    },
    addListener: (async (event: string, fn: (e: unknown) => void) => {
      (listeners[event] ??= []).push(fn);
      return { remove: async () => void (listeners[event] = listeners[event]!.filter((f) => f !== fn)) };
    }) as PqBrowserPlugin["addListener"],
    async removeAllListeners() {},
  };
  const emit = (event: string, e: unknown) => {
    for (const fn of listeners[event] ?? []) fn(e);
  };
  /** what the relay would send for a page message, with the origin and frame the WebView itself attributes to it */
  const pageSends = (m: { id: string; command: string; args?: unknown; origin?: string; mainFrame?: boolean }) =>
    emit("message", { json: JSON.stringify({ id: m.id, command: m.command, args: m.args ?? null, origin: "https://whatever-the-page-claims.example" }), origin: m.origin ?? ORIGIN, mainFrame: m.mainFrame ?? true });
  return { plugin, calls, replies, pageSends, get script() { return script; } };
}

const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 150));
};
const click = (root: HTMLElement, action: string) => {
  const el = root.querySelector<HTMLElement>(`[data-action="${action}"]`);
  if (!el) throw new Error(`no action ${action}; screen: ${root.querySelector("h1")?.textContent}`);
  el.click();
};
async function submit(root: HTMLElement, form: string, fields: Record<string, string>) {
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`);
  if (!f) throw new Error(`no form ${form}`);
  for (const [k, v] of Object.entries(fields)) f.querySelector<HTMLInputElement>(`[name="${k}"]`)!.value = v;
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
const text = (root: HTMLElement) => root.textContent ?? "";
const sheet = (root: HTMLElement) => root.querySelector(".sheet");

describe("in-app dapp browser (jsdom, fake plugin)", () => {
  it("opens a page, answers getAccounts after approval and silently the second time, refuses hash signing, drops a foreign origin, closes", async () => {
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    localStorage.setItem("koinos-pq-wallet/devnet-rpc", "http://127.0.0.1:1/");
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    const fb = fakeBrowser();
    new App(root, { native: true, browser: fb.plugin, bridgeScript: async () => "/* inpage */", approveDelayMs: 0 });
    click(root, "create");
    const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
    click(root, "wrote-down");
    const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
    await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]! });
    await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
    // the Dapps tab: the curated list, then open a page
    click(root, "tab-dapps");
    expect(text(root)).toMatch(/Test dapp/);
    await submit(root, "dapp-open", { url: "dapp.example" });
    expect(fb.calls[0]).toMatch(/^open https:\/\/dapp\.example/);
    expect(fb.script).toMatch(/__pqDeliver/);
    expect(fb.script).toMatch(/\/\* inpage \*\//);
    expect(root.querySelector("#dapp-area")).not.toBeNull();

    // ping needs nobody
    fb.pageSends({ id: "p1", command: "ping" });
    await settle();
    expect(fb.replies.find((r) => r.id === "p1")?.result).toBe("pong");

    // getAccounts: the sheet, hidden page; approve -> the accounts, and the site is remembered
    fb.pageSends({ id: "a1", command: "getAccounts" });
    await settle();
    expect(sheet(root)).not.toBeNull();
    expect(text(root)).toMatch(/dapp\.example/);
    expect(text(root)).toMatch(/see your account addresses/);
    expect(fb.calls).toContain("hide");
    const key = root.querySelector<HTMLElement>('[data-action="dapp-approve"]')!.dataset.key!;
    click(root, "dapp-approve");
    await settle();
    const a1 = fb.replies.find((r) => r.id === "a1")!;
    expect(a1.error).toBeUndefined();
    const accounts = a1.result as Array<{ address: string; name: string }>;
    expect(accounts.length).toBeGreaterThanOrEqual(1); // the native address on the devnet
    expect(sheet(root)).toBeNull();
    expect(key.length).toBeGreaterThan(0);
    fb.pageSends({ id: "a2", command: "getAccounts" });
    await settle();
    expect(sheet(root)).toBeNull(); // remembered: no sheet
    expect((fb.replies.find((r) => r.id === "a2")!.result as unknown[]).length).toBe(accounts.length);

    // a raw hash: refused, with the reason on the sheet; closing it answers the page
    fb.pageSends({ id: "h1", command: "signer:signHash", args: { signerAddress: accounts[0]!.address, hash: "00" } });
    await settle();
    expect(text(root)).toMatch(/Raw hash signing is turned off/);
    click(root, "dapp-reject");
    await settle();
    expect(fb.replies.find((r) => r.id === "h1")?.error).toBe("refused by the wallet");

    // a message from a frame inside the page, or from an unencrypted origin, is answered with an error and nothing else
    fb.pageSends({ id: "x1", command: "getAccounts", mainFrame: false });
    await settle();
    expect(fb.replies.find((r) => r.id === "x1")?.error).toMatch(/frames/);
    expect(sheet(root)).toBeNull();
    fb.pageSends({ id: "x2", command: "getAccounts", origin: "http://evil.example" });
    await settle();
    expect(fb.replies.find((r) => r.id === "x2")?.error).toMatch(/https/);
    expect(sheet(root)).toBeNull();
    // the sheet names the WebView's origin, whatever the message body claimed
    fb.pageSends({ id: "x3", command: "signer:signMessage", args: { signerAddress: accounts[0]!.address, message: "hi" }, origin: "https://other.example" });
    await settle();
    expect(root.querySelector("#req")?.textContent).toMatch(/other\.example/);
    expect(text(root)).not.toMatch(/whatever-the-page-claims/);
    click(root, "dapp-reject");
    await settle();
    expect(fb.replies.find((r) => r.id === "x3")?.error).toBe("rejected by the user");

    // a signing request without a signer is refused; a reject answers "rejected by the user" for a real one
    fb.pageSends({ id: "s1", command: "signer:signMessage", args: { signerAddress: accounts[0]!.address, message: "hello" } });
    await settle();
    expect(text(root)).toMatch(/sign this message/);
    click(root, "dapp-reject");
    await settle();
    expect(fb.replies.find((r) => r.id === "s1")?.error).toBe("rejected by the user");

    // Settings lists the site; forgetting it means the next getAccounts asks again
    click(root, "settings");
    expect(text(root)).toMatch(/dapp\.example/);
    click(root, "site-revoke");
    click(root, "tab-dapps");
    await settle();
    fb.pageSends({ id: "a3", command: "getAccounts" });
    await settle();
    expect(sheet(root)).not.toBeNull();
    // closing the page answers what is still waiting
    click(root, "dapp-close");
    await settle();
    expect(fb.replies.find((r) => r.id === "a3")?.error).toBe("rejected by the user");
    expect(fb.calls).toContain("close");
    expect(text(root)).toMatch(/Test dapp/); // back to the list
    expect(PQ.length).toBe(34);
  }, 120_000);
});
