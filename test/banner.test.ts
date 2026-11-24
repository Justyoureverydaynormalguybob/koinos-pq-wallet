// @vitest-environment jsdom
// The rule: every message in the banner at the top goes away by itself after a few seconds, without the
// code that set it having to ask, and without the screen being drawn again (a form being typed in stays).
import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App, bannerMs } = await import("../src/ui/app");

describe("banner messages hide themselves", () => {
  it("stays 6 to 12 seconds by length, an error 3 seconds longer", () => {
    expect(bannerMs("Copied.", "notice")).toBe(6000);
    expect(bannerMs("x".repeat(90), "notice")).toBe(8500);
    expect(bannerMs("x".repeat(500), "notice")).toBe(12000);
    expect(bannerMs("Copied.", "error")).toBe(9000);
    expect(bannerMs("x".repeat(500), "error")).toBe(15000);
  });

  it("an error nobody asked to hide is gone after its time, and what was typed is still there", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline in tests");
    });
    localStorage.clear();
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    vi.useFakeTimers();
    try {
      root.querySelector<HTMLElement>('[data-action="import"]')!.click();
      const form = root.querySelector<HTMLFormElement>('form[data-form="import"]')!;
      form.querySelector<HTMLTextAreaElement | HTMLInputElement>('[name="seed"]')!.value = "not a seed";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(200);
      const banner = () => root.querySelector('[data-banner="error"]');
      expect(banner(), root.textContent?.slice(0, 200)).not.toBeNull();
      const field = root.querySelector<HTMLTextAreaElement | HTMLInputElement>('form[data-form="import"] [name="seed"]')!;
      field.value = "typing a correction";
      await vi.advanceTimersByTimeAsync(5000);
      expect(banner()).not.toBeNull(); // still readable
      await vi.advanceTimersByTimeAsync(11_000);
      expect(banner()).toBeNull();
      // the same field element, with what was typed: the screen was not drawn again
      expect(root.querySelector('form[data-form="import"] [name="seed"]')).toBe(field);
      expect(field.value).toBe("typing a correction");
    } finally {
      vi.useRealTimers();
    }
  });
});
