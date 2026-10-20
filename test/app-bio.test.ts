// @vitest-environment jsdom
// Biometric unlock through the screens: Settings offers it on native only, turning it on asks for the
// passphrase, the unlock screen then shows the biometric button, which opens the wallet after the
// (fake) device prompt; a saved change keeps it working; turning it off removes it.
import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { Biometry, BlobStore, KeyStore } from "../src/core/biometrics";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");

const MAIN = "main passphrase 1234";
const ISSUER = "1JZ2fwcuwRPLSJd3cdNpwLGkLAPktVUkqp";
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
  if (!f) throw new Error(`no form ${form}; screen: ${root.querySelector("h1")?.textContent}`);
  for (const [k, v] of Object.entries(fields)) f.querySelector<HTMLInputElement>(`[name="${k}"]`)!.value = v;
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
const h1 = (root: HTMLElement) => root.querySelector("h1")?.textContent ?? "";
const text = (root: HTMLElement) => root.textContent ?? "";

function fakes() {
  let blobs: string[] | null = null;
  let kwk: Uint8Array | null = null;
  let prompts = 0, pass = true;
  const blobStore: BlobStore = { load: () => (blobs ? [...blobs] : null), save: (b) => void (blobs = [...b]), clear: () => void (blobs = null) };
  const keys: KeyStore = {
    get: async () => {
      prompts++; // the keystore shows the prompt itself
      if (!pass) throw new Error("Cancelled; use your passphrase.");
      return kwk ? new Uint8Array(kwk) : null;
    },
    set: async (k) => void (kwk = new Uint8Array(k)),
    remove: async () => void (kwk = null),
  };
  const biometry: Biometry = { available: async () => true };
  return { blobs: blobStore, keys, biometry, state: { get prompts() { return prompts; }, set pass(v: boolean) { pass = v; }, get blobs() { return blobs; } } };
}

async function createWallet(root: HTMLElement) {
  click(root, "create");
  const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
  click(root, "wrote-down");
  const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
  await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]! });
  await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
}

describe("biometric unlock through the screens (jsdom)", () => {
  it("native: on from Settings with the passphrase, opens from the unlock screen, survives a saved change, off again", async () => {
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    localStorage.setItem("koinos-pq-wallet/devnet-rpc", "http://127.0.0.1:1/");
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    const f = fakes();
    new App(root, { native: true, bio: f });
    await createWallet(root);
    click(root, "settings");
    expect(text(root)).toMatch(/Turn biometric unlock on/);
    click(root, "bio-enable");
    expect(h1(root)).toBe("Biometric unlock");
    await submit(root, "bio-enable", { passphrase: "not the passphrase" });
    expect(text(root)).toMatch(/wrong passphrase/);
    await submit(root, "bio-enable", { passphrase: MAIN });
    expect(h1(root)).toBe("Settings");
    expect(text(root)).toMatch(/Biometric unlock is on/);
    expect(f.state.blobs?.length).toBe(2);
    // lock: the unlock screen offers biometrics; a cancelled prompt leaves the passphrase field
    click(root, "lock");
    await settle();
    expect(h1(root)).toBe("Unlock");
    expect(root.querySelector('[data-action="bio-unlock"]')).not.toBeNull();
    f.state.pass = false;
    click(root, "bio-unlock");
    await settle();
    expect(h1(root)).toBe("Unlock");
    expect(text(root)).toMatch(/Cancelled; use your passphrase/);
    f.state.pass = true;
    click(root, "bio-unlock");
    await settle();
    expect(h1(root)).not.toBe("Unlock");
    expect(f.state.prompts).toBe(2);
    // a saved change re-encrypts the slot; biometrics must still open it
    click(root, "settings");
    await submit(root, "watch", { address: ISSUER, label: "cold" });
    await submit(root, "save", { passphrase: MAIN });
    expect(text(root)).toMatch(/Saved/);
    click(root, "lock");
    await settle();
    click(root, "bio-unlock");
    await settle();
    expect(h1(root)).not.toBe("Unlock");
    expect(text(root)).toMatch(/cold/);
    // off again
    click(root, "settings");
    click(root, "bio-disable");
    await settle();
    expect(text(root)).toMatch(/Biometric unlock is off/);
    click(root, "lock");
    await settle();
    expect(root.querySelector('[data-action="bio-unlock"]')).toBeNull();
  }, 120_000);

  it("web: Settings never offers it", async () => {
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    localStorage.setItem("koinos-pq-wallet/devnet-rpc", "http://127.0.0.1:1/");
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root, { native: false, bio: fakes() });
    await createWallet(root);
    click(root, "settings");
    expect(text(root)).not.toMatch(/biometric/i);
  }, 60_000);
});
