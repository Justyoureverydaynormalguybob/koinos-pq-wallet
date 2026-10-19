// @vitest-environment jsdom
// Languages through the screens: a saved choice renders Spanish from the first screen, the Settings
// picker switches to Portuguese and persists it, and the document's lang follows.
import { afterAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");
const { setLanguage } = await import("../src/i18n");

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

describe("languages through the screens (jsdom)", () => {
  afterAll(() => setLanguage("en", false));

  it("a saved choice renders Spanish; the Settings picker switches to Portuguese and keeps it", async () => {
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/lang", "es");
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    localStorage.setItem("koinos-pq-wallet/devnet-rpc", "http://127.0.0.1:1/");
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    expect(document.documentElement.lang).toBe("es");
    expect(h1(root)).toBe("Una cartera que un ordenador cuántico no puede forzar");
    expect(root.querySelector('[data-action="create"]')?.textContent).toBe("Crear una cartera nueva");
    click(root, "create");
    expect(h1(root)).toBe("Anota estas 24 palabras");
    const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
    click(root, "wrote-down");
    const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Palabra número (\d+)/.exec(l.textContent!)![1]) - 1);
    expect(labels).toHaveLength(3);
    await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]! });
    expect(h1(root)).toBe("Elige una contraseña");
    await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
    // the tab bar and Settings in Spanish
    expect(root.querySelector('.tabs [data-action="settings"]')?.textContent).toBe("Ajustes");
    click(root, "settings");
    expect(h1(root)).toBe("Ajustes");
    const picker = root.querySelector<HTMLSelectElement>('select[name="lang"]')!;
    expect(picker.value).toBe("es");
    picker.value = "pt";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(h1(root)).toBe("Definições");
    expect(document.documentElement.lang).toBe("pt");
    expect(localStorage.getItem("koinos-pq-wallet/lang")).toBe("pt");
    click(root, "lock");
    await settle();
    expect(h1(root)).toBe("Desbloquear");
  }, 60_000);

  it("falls back to English when nothing is saved and the device language is unknown here", async () => {
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    // jsdom reports en-US
    expect(document.documentElement.lang).toBe("en");
    expect(h1(root)).toBe("A wallet that a quantum computer cannot pick");
  });
});
