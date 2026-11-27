// @vitest-environment jsdom
// The external review of 2026-11-27 (issue #1), through the real screens (jsdom):
//   item 3   a saved change no longer empties the side stores at the next unlock
//   item 14  the passphrase can be changed, and the side stores follow it
//   item 13  the lock deadlines hold by the clock when the timers never fired (a suspended web view)
//   item 12  an unlock brings a slot and the stores written by an older version to today's form
import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");
const { localVaultStore, openVault, toFile, encryptVault, deriveSlotKeyBytes, PAD_BLOCK } = await import("../src/core/vault");
const { fillerValue } = await import("../src/core/sealed-store");

const MAIN = "main kettle orbit plank";
const NEXT = "next harbour violin crate";
const COLD = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
const SECOND = "1JZ2fwcuwRPLSJd3cdNpwLGkLAPktVUkqp";

function mount() {
  document.body.innerHTML = `<div id="app"></div>`;
  const root = document.getElementById("app")!;
  new App(root);
  return root;
}
const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
};
const click = (root: HTMLElement, action: string, extra: Record<string, string> = {}) => {
  const el = [...root.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)].find((e) => Object.entries(extra).every(([k, v]) => e.dataset[k] === v));
  if (!el) throw new Error(`no action ${action}; screen shows: ${root.querySelector("h1")?.textContent}`);
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
const h1 = (root: HTMLElement) => root.querySelector("h1")?.textContent ?? "";
const text = (root: HTMLElement) => (root.textContent ?? "").replace(/\s+/g, " ");
const toSettings = (root: HTMLElement) => {
  if (root.querySelector('[data-action="settings"]')) click(root, "settings");
  else click(root, "setup-cancel");
  expect(h1(root)).toBe("Settings");
};
async function createWallet(root: HTMLElement) {
  click(root, "create");
  const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
  click(root, "wrote-down");
  const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
  await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]! });
  await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
}
/** Watch an address (a change saved into the vault with the passphrase), then give it a name (kept in a side store). */
async function watch(root: HTMLElement, address: string, pass: string) {
  await submit(root, "watch", { address, label: "" });
  expect(h1(root)).toBe("Watch an address");
  await submit(root, "save", { passphrase: pass });
  expect(h1(root)).toBe("Settings");
}
async function name(root: HTMLElement, address: string, value: string) {
  click(root, "account-rename", { address });
  await submit(root, "account-rename", { name: value });
}
const storeSizes = () =>
  Object.keys(localStorage)
    .filter((k) => /^koinos-pq-wallet\/(book|tokens|sites|collections|names)\/slot\d$/.test(k))
    .map((k) => localStorage.getItem(k)!.length);

describe("external review 2026-11-27, through the screens", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline in tests");
    });
  });

  it("item 3 and 14: what the wallet remembers survives a saved change, a lock, and a new passphrase", async () => {
    localStorage.clear();
    const root = mount();
    await createWallet(root);
    toSettings(root);
    await watch(root, COLD, MAIN);
    await name(root, COLD, "Cold storage");
    expect(text(root)).toMatch(/Cold storage/);
    const saltBefore = (await toFile(localVaultStore.load()!)).slots.map((s) => s.saltHex);

    // the test the review asked for: another saved change, lock, unlock: the name is still there
    await watch(root, SECOND, MAIN);
    expect((await toFile(localVaultStore.load()!)).slots.map((s) => s.saltHex)).toEqual(saltBefore); // a save keeps the slot's salt
    click(root, "lock");
    await submit(root, "unlock", { passphrase: MAIN });
    toSettings(root);
    expect(text(root)).toMatch(/Cold storage/);
    expect(text(root)).toContain(SECOND);

    // changing the passphrase: every refusal leaves the file as it is
    const before = JSON.stringify(localVaultStore.load());
    click(root, "change-pass");
    expect(h1(root)).toBe("Change the passphrase");
    await submit(root, "change-pass", { current: "not the passphrase", p1: NEXT, p2: NEXT });
    expect(text(root)).toMatch(/wrong passphrase/);
    await submit(root, "change-pass", { current: MAIN, p1: "password12", p2: "password12" });
    expect(text(root)).toMatch(/too easy to guess/);
    await submit(root, "change-pass", { current: MAIN, p1: NEXT, p2: NEXT + "x" });
    expect(text(root)).toMatch(/two passphrases differ/);
    await submit(root, "change-pass", { current: MAIN, p1: MAIN, p2: MAIN });
    expect(text(root)).toMatch(/must be different from any passphrase this wallet already uses/);
    expect(JSON.stringify(localVaultStore.load())).toBe(before);

    await submit(root, "change-pass", { current: MAIN, p1: NEXT, p2: NEXT });
    expect(h1(root)).toBe("Unlock");
    expect(text(root)).toMatch(/Passphrase changed/);
    const file = await toFile(localVaultStore.load()!);
    await expect(openVault(file, MAIN)).rejects.toThrow(/wrong passphrase/);
    const opened = await openVault(file, NEXT);
    expect(file.slots[opened.slot]!.saltHex).not.toBe(saltBefore[opened.slot]); // a new passphrase is a new slot key
    expect(file.slots[1 - opened.slot]!.saltHex).toBe(saltBefore[1 - opened.slot]); // the other slot is untouched
    await submit(root, "unlock", { passphrase: MAIN });
    expect(text(root)).toMatch(/wrong passphrase/);
    await submit(root, "unlock", { passphrase: NEXT });
    toSettings(root);
    // the accounts (in the vault) and the name (in a side store, sealed again under the new key) are all there
    expect(text(root)).toContain(COLD);
    expect(text(root)).toContain(SECOND);
    expect(text(root)).toMatch(/Cold storage/);
    // every side store entry of every slot is the one size, used or not
    const sizes = storeSizes();
    expect(sizes).toHaveLength(10);
    expect(new Set(sizes)).toEqual(new Set([fillerValue().length]));
  }, 180_000);

  it("item 12: a wallet written by an older version is brought to today's form by unlocking it", async () => {
    localStorage.clear();
    // a file as 0.18 left it: the slot carries role "decoy", and two stores use the 1 KiB padding at different sizes
    const old = await encryptVault({ version: 1, seedHex: "07".repeat(32), accounts: [], createdAt: "2026-11-01T00:00:00.000Z", role: "decoy" }, MAIN);
    localVaultStore.save({ v: 2, slots: [old, await encryptVault({ version: 1, seedHex: "08".repeat(32), accounts: [], createdAt: "2026-11-01T00:00:00.000Z" }, "the other passphrase 99")] });
    const b64 = (n: number) => "sealed1:" + Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("base64");
    localStorage.setItem("koinos-pq-wallet/book/slot0", b64(12 + 1024 + 16));
    localStorage.setItem("koinos-pq-wallet/book/slot1", b64(12 + 3072 + 16)); // "a used wallet lives in slot 1"
    const keyBefore = Buffer.from(await deriveSlotKeyBytes(old, MAIN)).toString("hex");
    const root = mount();
    await submit(root, "unlock", { passphrase: MAIN });
    expect(h1(root)).not.toBe("Unlock");
    const file = await toFile(localVaultStore.load()!);
    const opened = await openVault(file, MAIN);
    expect(opened.slot).toBe(0);
    expect(opened.data.role).toBeUndefined(); // the mark is gone from the stored slot
    expect(Buffer.from(opened.key).toString("hex")).toBe(keyBefore); // same key: nothing sealed under it is lost
    expect(file.slots[0]!.ciphertextHex.length).toBe(2 * (PAD_BLOCK + 16));
    // the other slot cannot be opened here and is not touched
    expect(JSON.stringify(file.slots[1])).toBe(JSON.stringify((await toFile(localVaultStore.load()!)).slots[1]));
    // and the stores say nothing any more: one size, both slots
    const sizes = storeSizes();
    expect(sizes).toHaveLength(10);
    expect(new Set(sizes)).toEqual(new Set([fillerValue().length]));
  }, 120_000);

  it("item 13: hidden longer than the limit, or unused longer than the auto-lock time, locks at the next moment the app runs, timers or not", async () => {
    localStorage.clear();
    const root = mount();
    await createWallet(root);
    expect(h1(root)).not.toBe("Unlock");
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      // The app goes to the background and the web view is suspended: no timer fires. Two minutes pass.
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      skew += 120_000;
      expect(h1(root)).not.toBe("Unlock"); // nothing has run yet
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(h1(root)).toBe("Unlock");
      expect(text(root)).toMatch(/Locked while the tab was hidden/);

      // a short absence does not lock
      await submit(root, "unlock", { passphrase: MAIN });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      skew += 20_000;
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(h1(root)).not.toBe("Unlock");

      // in view but untouched past the auto-lock time, with the timer never having fired: the first tap locks
      skew += 11 * 60_000;
      document.dispatchEvent(new Event("pointerdown"));
      expect(h1(root)).toBe("Unlock");
      expect(text(root)).toMatch(/Locked after inactivity/);
    } finally {
      clock.mockRestore();
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  }, 120_000);
});
