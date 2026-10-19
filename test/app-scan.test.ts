// @vitest-environment jsdom
// The QR scan button on Send: shown only in a native shell, fills "To" in place with a checksum-valid
// address, refuses anything else without touching the field, and does nothing on cancel.
import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");

const A = "1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ";
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
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`)!;
  for (const [k, v] of Object.entries(fields)) f.querySelector<HTMLInputElement>(`[name="${k}"]`)!.value = v;
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
/** A wallet on the (unreachable) devnet: home shows the native account, Send is available. */
async function openSend(scan: () => Promise<string | null>, native: boolean) {
  localStorage.clear();
  localStorage.setItem("koinos-pq-wallet/network", "devnet");
  localStorage.setItem("koinos-pq-wallet/devnet-rpc", "http://127.0.0.1:1/"); // nothing listens: every read fails fast
  document.body.innerHTML = `<div id="app"></div>`;
  const root = document.getElementById("app")!;
  new App(root, { scanner: scan, native });
  click(root, "create");
  const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
  click(root, "wrote-down");
  const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
  await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]! });
  await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
  click(root, "send");
  return root;
}
const toField = (root: HTMLElement) => root.querySelector<HTMLInputElement>('form[data-form="send"] input[name="to"]')!;

describe("QR scan on Send (jsdom)", () => {
  it("native: a good scan fills the field, a bad one is refused, cancel leaves it alone", async () => {
    let next: string | null = `koinos:${A}`;
    const root = await openSend(async () => next, true);
    expect(root.querySelector('[data-action="scan"]')).not.toBeNull();
    click(root, "scan");
    await settle();
    expect(toField(root).value).toBe(A);
    next = "not an address";
    click(root, "scan");
    await settle();
    expect(root.textContent).toMatch(/not a Koinos address/);
    expect(toField(root).value).toBe(""); // the error re-rendered the form; nothing was pasted
    next = null;
    toField(root).value = "typed";
    click(root, "scan");
    await settle();
    expect(toField(root).value).toBe("typed");
  }, 60_000);

  it("web: no scan button, and no Dapps tab", async () => {
    const root = await openSend(async () => A, false);
    expect(root.querySelector('[data-action="scan"]')).toBeNull();
    expect(root.querySelector('[data-action="tab-dapps"]')).toBeNull();
  }, 60_000);
});
