// @vitest-environment jsdom
// The Android back button through the screens: a sub-screen returns to its tab root, an onboarding step
// cancels, a tab root asks to minimise, and an open page in the dapp browser goes back or closes.
import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { PqBrowserPlugin } from "../src/native/pq-browser";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");

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
const h1 = (root: HTMLElement) => root.querySelector("h1")?.textContent ?? "";

function fakeBrowser(canGoBack: boolean) {
  const calls: string[] = [];
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const plugin: PqBrowserPlugin = {
    async open(o) {
      calls.push("open");
      for (const fn of listeners.navigation ?? []) fn({ url: o.url, title: "", canGoBack: false });
    },
    async navigate() {},
    async back() {
      calls.push("back");
      return { canGoBack };
    },
    async close() {
      calls.push("close");
      for (const fn of listeners.closed ?? []) fn({});
    },
    async show() {},
    async hide() {},
    async setFrame() {},
    async reply() {},
    addListener: (async (event: string, fn: (e: unknown) => void) => {
      (listeners[event] ??= []).push(fn);
      return { remove: async () => undefined };
    }) as PqBrowserPlugin["addListener"],
    async removeAllListeners() {},
  };
  return { plugin, calls };
}

describe("the back button (jsdom)", () => {
  it("cancels onboarding, returns sub-screens to their tab, minimises at a root, and drives the dapp page", async () => {
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    localStorage.setItem("koinos-pq-wallet/devnet-rpc", "http://127.0.0.1:1/");
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    const fb = fakeBrowser(false);
    const app = new App(root, { native: true, browser: fb.plugin, bridgeScript: async () => "" });
    expect(await app.handleBack()).toBe("minimize"); // welcome is a root
    click(root, "create");
    expect(await app.handleBack()).toBe("screen"); // an onboarding step cancels
    expect(h1(root)).toMatch(/quantum computer/);
    click(root, "create");
    const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
    click(root, "wrote-down");
    const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
    await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]! });
    await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
    expect(await app.handleBack()).toBe("minimize"); // home is a root
    click(root, "send");
    expect(h1(root)).toMatch(/^Send/);
    expect(await app.handleBack()).toBe("screen");
    expect(root.querySelector('[data-action="send"]')).not.toBeNull(); // back on the account
    click(root, "settings");
    click(root, "contacts");
    expect(h1(root)).toBe("Contacts");
    expect(await app.handleBack()).toBe("screen");
    expect(h1(root)).toBe("Settings");
    expect(await app.handleBack()).toBe("minimize"); // settings is a root
    // the dapp page: back goes back in the page when it can, else closes it
    click(root, "tab-dapps");
    await submit(root, "dapp-open", { url: "dapp.example" });
    expect(root.querySelector("#dapp-area")).not.toBeNull();
    expect(await app.handleBack()).toBe("page");
    expect(fb.calls).toEqual(["open", "back", "close"]);
    await settle();
    expect(root.querySelector("#dapp-area")).toBeNull();
    expect(await app.handleBack()).toBe("minimize"); // the dapps list is a root
  }, 60_000);
});
