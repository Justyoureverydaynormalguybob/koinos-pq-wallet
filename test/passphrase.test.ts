// @vitest-environment jsdom
// The passphrase strength gate: what the estimate refuses and accepts, that the screens refuse a weak
// passphrase where one is CHOSEN (new wallet, duress wallet), and that a wallet saved under a weak
// passphrase before the gate existed still unlocks (the gate is never asked at unlock).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");
const { MIN_PASSPHRASE_BITS, assertStrong, passphraseStrength } = await import("../src/core/passphrase");
const { encryptVault, localVaultStore } = await import("../src/core/vault");

describe("passphrase strength estimate", () => {
  it("refuses the passwords anyone would try first, however they are dressed up", () => {
    for (const pw of ["password12", "Password1!", "P@ssw0rd123!", "qwertyuiop", "letmein2024", "iloveyou123", "Passphrase!!", "koinos2026!", "sparan1234"]) {
      const s = passphraseStrength(pw);
      expect(s.score, pw).toBe(0);
      expect(s.warning, pw).toBeTruthy();
      expect(() => assertStrong(pw), pw).toThrow();
    }
  });

  it("refuses digits alone, one character over and over, and a short piece repeated", () => {
    expect(passphraseStrength("1234567890").warning).toMatch(/Numbers alone/);
    expect(passphraseStrength("8301746592").warning).toMatch(/Numbers alone/);
    expect(passphraseStrength("aaaaaaaaaaaa").score).toBe(0);
    expect(passphraseStrength("abcdeabcdeabcde").warning).toMatch(/repeated/);
  });

  it("is not fooled by length made of common words, years and runs", () => {
    for (const pw of ["main passphrase 1234", "koinos wallet 1", "summer2024!!", "mydogrex2019", "wallet wallet wallet wallet", "qwerty asdfgh zxcvbn 123", "correct horse battery"]) {
      expect(passphraseStrength(pw).bits, pw).toBeLessThan(MIN_PASSPHRASE_BITS);
      expect(() => assertStrong(pw), pw).toThrow();
    }
  });

  it("accepts several unrelated words, with or without symbols, and long random strings", () => {
    for (const pw of ["correct horse battery staple", "main kettle orbit plank", "kettle-orbit-plank-moth-9", "tá an lá go breá inniu", "I walk the dog at 7 every morning", "qzkvwpxjrmtb", "G7k2pQ9xLm4vB8"]) {
      const s = passphraseStrength(pw);
      expect(s.bits, pw).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
      expect(s.score, pw).toBeGreaterThanOrEqual(2);
      expect(() => assertStrong(pw), pw).not.toThrow();
    }
  });

  it("never rates a passphrase lower for having another unrelated word added", () => {
    const words = ["kettle", "orbit", "plank", "moth", "gravel", "lantern", "thistle"];
    let last = -1;
    for (let n = 1; n <= words.length; n++) {
      const bits = passphraseStrength(words.slice(0, n).join(" ")).bits;
      expect(bits, `${n} words`).toBeGreaterThan(last);
      last = bits;
    }
    expect(passphraseStrength("").score).toBe(0);
  });
});

const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
};
const click = (root: HTMLElement, action: string) => {
  const el = root.querySelector<HTMLElement>(`[data-action="${action}"]`);
  if (!el) throw new Error(`no action ${action}; screen shows: ${root.querySelector("h1")?.textContent}`);
  el.click();
};
async function submit(root: HTMLElement, form: string, fields: Record<string, string>) {
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`);
  if (!f) throw new Error(`no form ${form}; screen shows: ${root.querySelector("h1")?.textContent}`);
  for (const [k, v] of Object.entries(fields)) f.querySelector<HTMLInputElement>(`[name="${k}"]`)!.value = v;
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
const h1 = (root: HTMLElement) => root.querySelector("h1")?.textContent ?? "";
const STRONG = "main kettle orbit plank";

describe("the gate on the screens (jsdom)", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline in tests");
    });
  });

  it("a new wallet and a duress wallet refuse a weak passphrase, say why, and take a strong one", async () => {
    localStorage.clear();
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    click(root, "create");
    const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
    click(root, "wrote-down");
    const asked = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
    await submit(root, "confirm", { w0: words[asked[0]!]!, w1: words[asked[1]!]!, w2: words[asked[2]!]! });
    expect(h1(root)).toMatch(/passphrase/i);

    // the line under the field follows the typing
    const p1 = root.querySelector<HTMLInputElement>('input[name="p1"]')!;
    p1.value = "Password1!";
    p1.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector("#pw-strength")?.textContent).toMatch(/Very weak/);
    p1.value = STRONG;
    p1.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector("#pw-strength")?.textContent).toMatch(/Fair|Good|Strong/);

    for (const weak of ["Password1!", "main passphrase 1234", "summer2024!!"]) {
      await submit(root, "passphrase", { p1: weak, p2: weak });
      expect(root.textContent, weak).toMatch(/too easy to guess/);
      expect(h1(root), weak).toMatch(/passphrase/i);
      expect(localVaultStore.load(), weak).toBeNull();
    }
    await submit(root, "passphrase", { p1: STRONG, p2: STRONG });
    expect(localVaultStore.load()).not.toBeNull();

    // the duress wallet's passphrase goes through the same gate
    click(root, root.querySelector('[data-action="settings"]') ? "settings" : "setup-cancel");
    click(root, "duress");
    click(root, "duress-create");
    const before = JSON.stringify(localVaultStore.load());
    await submit(root, "duress-save", { d1: "duress passphrase 5678", d2: "duress passphrase 5678", main: STRONG });
    expect(root.textContent).toMatch(/too easy to guess/);
    expect(JSON.stringify(localVaultStore.load())).toBe(before);
    await submit(root, "duress-save", { d1: "duress lantern gravel moth", d2: "duress lantern gravel moth", main: STRONG });
    expect(h1(root)).toBe("Unlock");
    expect(JSON.stringify(localVaultStore.load())).not.toBe(before);
  }, 120_000);

  it("a wallet saved under a weak passphrase before the gate still unlocks, and its settings still save", async () => {
    const OLD = "password12"; // ten characters: allowed before 0.18.0
    expect(() => assertStrong(OLD)).toThrow();
    localStorage.clear();
    const vault = await encryptVault({ version: 1, seedHex: "07".repeat(32), accounts: [], createdAt: new Date().toISOString() }, OLD);
    localStorage.setItem("koinos-pq-wallet/vault", JSON.stringify(vault));
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    expect(h1(root)).toBe("Unlock");
    await submit(root, "unlock", { passphrase: OLD });
    expect(h1(root)).not.toBe("Unlock");
    expect(root.textContent).not.toMatch(/too easy to guess/);
  }, 120_000);
});
