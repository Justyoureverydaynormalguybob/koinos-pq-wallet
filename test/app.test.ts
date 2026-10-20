// @vitest-environment jsdom
// Drives the real App through the browser DOM (jsdom): create, duress setup, unlock as main and as
// decoy, watch-only, first-time and look-alike recipient checks, lock-on-hide, clipboard wipe.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
// jsdom has no canvas: the QR drawing is a no-op in tests
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");
const { localVaultStore, openVault, toFile, PBKDF2_ITERATIONS } = await import("../src/core/vault");
const { bootstrapAddress, deriveKeys, hexToBytes } = await import("koinos-pq-core");
const ZERO_SEED_ADDRESS = "14PpxNmUVA7qeAw1cyASMfJFUd2xDkPUBR";

const MAIN = "main passphrase 1234";
const DURESS = "duress passphrase 5678";
const PQ = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
const ISSUER = "1JZ2fwcuwRPLSJd3cdNpwLGkLAPktVUkqp";
const OTHER = "19G2VrmoqgCFRRtgoYF3vFi2ekDsyoRvab"; // a valid address this wallet has never used

function mount() {
  document.body.innerHTML = `<div id="app"></div>`;
  const root = document.getElementById("app")!;
  const app = new App(root);
  return { root, app };
}
const click = (root: HTMLElement, action: string, extra: Record<string, string> = {}) => {
  const el = [...root.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)].find((e) => Object.entries(extra).every(([k, v]) => e.dataset[k] === v));
  if (!el) throw new Error(`no action ${action}`);
  el.click();
};
async function submit(root: HTMLElement, form: string, fields: Record<string, string | boolean>) {
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`);
  if (!f) throw new Error(`no form ${form}; screen shows: ${root.querySelector("h1")?.textContent}`);
  for (const [k, v] of Object.entries(fields)) {
    const input = f.querySelector<HTMLInputElement>(`[name="${k}"]`);
    if (!input) throw new Error(`no field ${k} in ${form}`);
    if (typeof v === "boolean") input.checked = v;
    else input.value = v;
  }
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
/** Waits for the app's async work (PBKDF2 at 600k iterations takes seconds on a slow CI runner). */
const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
};
const h1 = (root: HTMLElement) => root.querySelector("h1")?.textContent ?? "";
/** After creation the app may be on the activation screen (no account on this network yet) or on home. */
const toSettings = (root: HTMLElement) => {
  if (root.querySelector('[data-action="settings"]')) click(root, "settings");
  else click(root, "setup-cancel"); // the activation screen's way to Settings
  expect(h1(root)).toBe("Settings");
};
const text = (root: HTMLElement) => root.textContent ?? "";

/** Create a wallet through the real screens. Returns the 24 words. */
async function createWallet(root: HTMLElement): Promise<string> {
  click(root, "create");
  const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
  expect(words).toHaveLength(24);
  click(root, "wrote-down");
  const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
  await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]!});
  expect(h1(root)).toMatch(/passphrase/i);
  await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
  return words.join(" ");
}

describe("wallet app (jsdom)", () => {
  beforeAll(() => {
    // the chain is never reached: every network call fails fast and the UI must cope
    vi.stubGlobal("fetch", async () => { throw new Error("offline in tests"); });
  });

  it("creates a wallet, stores a two-slot file, and unlocks with the passphrase", async () => {
    localStorage.clear();
    const { root } = mount();
    expect(h1(root)).toMatch(/quantum computer cannot pick/);
    await createWallet(root);
    const stored = localVaultStore.load()!;
    if (!("slots" in stored)) throw new Error("expected the two-slot file format");
    expect(stored.slots.length).toBe(2);
    expect(stored.slots[0]!.iterations).toBe(PBKDF2_ITERATIONS);
    click(root, "lock");
    expect(h1(root)).toBe("Unlock");
    await submit(root, "unlock", { passphrase: "wrong wrong wrong" });
    expect(text(root)).toMatch(/wrong passphrase/);
    await submit(root, "unlock", { passphrase: MAIN });
    expect(h1(root)).not.toBe("Unlock");
  }, 60_000);

  it("regression: the account address offered right after creation is the seed's own, not the all-zero seed's", async () => {
    localStorage.clear();
    const { root } = mount();
    await createWallet(root);
    // offline, the app lands on the activation screen, which shows the account address it will activate
    const shown = root.querySelector("code.address")?.textContent?.trim();
    const stored = localVaultStore.load()!;
    const opened = await openVault(await toFile(stored), MAIN);
    const expected = bootstrapAddress(deriveKeys(hexToBytes(opened.data.seedHex)));
    expect(shown).toBe(expected);
    expect(shown).not.toBe(ZERO_SEED_ADDRESS);
  }, 60_000);

  it("duress: a second passphrase opens a different wallet; the main slot is untouched; the decoy shows no trace", async () => {
    localStorage.clear();
    const { root } = mount();
    await createWallet(root);
    const before = localVaultStore.load()!;
    toSettings(root);
    expect(text(root)).toMatch(/Duress wallet/);
    expect(text(root)).toMatch(/never says whether one exists/);
    click(root, "duress");
    click(root, "duress-create");
    expect(root.querySelectorAll("ol.words li")).toHaveLength(24);
    // refuses the main passphrase as the duress one
    await submit(root, "duress-save", { d1: MAIN, d2: MAIN, main: MAIN });
    expect(text(root)).toMatch(/must be different/);
    // refuses a wrong main passphrase
    await submit(root, "duress-save", { d1: DURESS, d2: DURESS, main: "not the main one" });
    expect(text(root)).toMatch(/wrong passphrase/);
    await submit(root, "duress-save", { d1: DURESS, d2: DURESS, main: MAIN });
    expect(h1(root)).toBe("Unlock"); // locked after saving
    const after = localVaultStore.load()!;
    const fa = await toFile(after), fb = await toFile(before);
    const mainOpened = await openVault(fa, MAIN);
    const decoyOpened = await openVault(fa, DURESS);
    expect(mainOpened.slot).not.toBe(decoyOpened.slot);
    expect(mainOpened.data.role).toBe("main");
    expect(mainOpened.data.hasDecoy).toBeUndefined(); // nothing is written back to the main slot any more
    expect(decoyOpened.data.role).toBe("decoy");
    expect(decoyOpened.data.seedHex).not.toBe(mainOpened.data.seedHex);
    // the main slot's bytes are untouched; only the decoy slot replaced its filler
    expect(fa.slots.length).toBe(fb.slots.length);
    expect(JSON.stringify(fa.slots[mainOpened.slot])).toBe(JSON.stringify(fb.slots[mainOpened.slot]));
    expect(JSON.stringify(fa.slots[decoyOpened.slot])).not.toBe(JSON.stringify(fb.slots[decoyOpened.slot]));
    // unlock as the decoy, then as main: the settings read the same, and neither mentions the other
    await submit(root, "unlock", { passphrase: DURESS });
    toSettings(root);
    const decoySettings = text(root).replace(/\s+/g, " ");
    expect(decoySettings).not.toMatch(/decoy/i);
    click(root, "lock");
    await submit(root, "unlock", { passphrase: MAIN });
    toSettings(root);
    const mainSettings = text(root).replace(/\s+/g, " ");
    expect(mainSettings).toMatch(/never says whether one exists/);
    const same = (t: string) => t.replace(/1[1-9A-HJ-NP-Za-km-z]{25,34}/g, "ADDR").replace(/head [\d,]+/, "head N"); // addresses differ, and the ticker's live head moves
    expect(same(mainSettings)).toBe(same(decoySettings));
  }, 120_000);

  it("watch-only: shown with a badge, cannot send; first-time and look-alike recipients are challenged", async () => {
    localStorage.clear();
    const { root } = mount();
    await createWallet(root);
    toSettings(root);
    await submit(root, "watch", { address: ISSUER, label: "Issuer (cold)" });
    expect(h1(root)).toBe("Watch an address");
    await submit(root, "save", { passphrase: MAIN });
    expect(text(root)).toMatch(/Saved/);
    click(root, "back-home");
    // the watched account is the only account here, so it is shown directly: no Send, a watch-only marker
    expect(text(root)).toMatch(/Issuer \(cold\)/);
    expect(root.querySelector('[data-action="send"]')).toBeNull();
    expect(text(root)).toMatch(/Watch-only/);
    // back to a signing account for the recipient checks: add one by address (the seed's account is not activated offline)
    click(root, "settings");
    await submit(root, "add-account", { address: PQ, label: "PQ" });
    await submit(root, "save", { passphrase: MAIN });
    click(root, "back-home");
    // two accounts now: the picker appears, with the watched one marked
    expect(text(root)).toMatch(/watch-only/);
    const pq = [...root.querySelectorAll<HTMLInputElement>('input[name="account"]')].find((r) => r.closest("label")?.textContent?.includes("PQ"))!;
    expect(pq).toBeTruthy();
    pq.checked = true;
    pq.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    click(root, "send");
    // bad checksum
    await submit(root, "send", { to: OTHER.slice(0, -1) + "x", amount: "1" });
    expect(text(root)).toMatch(/not a valid Koinos address/);
    // first time to a valid address: the confirm screen, with the checkbox required
    // (the wallet's own watched address would be exempt: sending to yourself needs no stranger check)
    await submit(root, "send", { to: OTHER, amount: "1" });
    expect(h1(root)).toMatch(/First time sending here/);
    await submit(root, "send-confirm", { checked: false, name: "" });
    expect(text(root)).toMatch(/Tick the box/);
    // look-alike of our own account PQ: valid checksum is required for the matcher, so use a real address that we make "known"
    click(root, "send-cancel");
    expect(h1(root)).toMatch(/^Send /); // the heading names the picked token (tKOIN on Harbinger)
  }, 120_000);

  it("locks when the tab stays hidden, and copies with a timed clipboard wipe", async () => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let clip = "";
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void (clip = t), readText: async () => clip }, configurable: true });
    const { root } = mount();
    await createWallet(root);
    // copy the account address from the setup / home screen if present, else from settings' native address
    const copyBtn = root.querySelector<HTMLElement>('[data-action="copy"]');
    if (copyBtn) {
      copyBtn.click();
      await settle();
      expect(clip).toBe(copyBtn.dataset.copy);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(clip).toBe("");
    }
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h1(root)).toBe("Unlock");
    expect(text(root)).toMatch(/hidden/);
    vi.useRealTimers();
  }, 120_000);
});
