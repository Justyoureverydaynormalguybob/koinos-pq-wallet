// A WalletConnect pairing link met inside the in-app browser: the native view drops the navigation and
// reports it, and the host passes on only a well-formed v2 code from the page that is open, at most one
// every few seconds. (Pairing itself, and the proposal reaching the approval sheet, is wc-bridge's part.)
import { describe, expect, it, vi } from "vitest";
import { DappHost, WC_LINK_GAP_MS } from "../src/ui/dapp-host";
import type { PqBrowserPlugin } from "../src/native/pq-browser";

const URI = `wc:${"ab".repeat(32)}@2?relay-protocol=irn&symKey=${"cd".repeat(32)}`;

function setup() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const emit = (event: string, e: unknown) => {
    for (const fn of listeners[event] ?? []) fn(e);
  };
  const plugin = {
    async open() {},
    async close() {
      emit("closed", {});
    },
    addListener: (async (event: string, fn: (e: unknown) => void) => {
      (listeners[event] ??= []).push(fn);
      return { remove: async () => undefined };
    }) as PqBrowserPlugin["addListener"],
  } as unknown as PqBrowserPlugin;
  const got: string[] = [];
  const host = new DappHost(
    plugin,
    { onNavigation: () => undefined, onClosed: () => undefined, onApproval: () => undefined, onWcLink: (uri) => void got.push(uri) },
    { network: () => ({}) as never, keys: () => null, accounts: () => [], permissions: () => null, bridgeScript: async () => "/* bridge */" },
  );
  return { host, emit, got };
}

describe("wc: links from the in-app browser", () => {
  it("passes on a pairing code from the open page, once per gap, and nothing else", async () => {
    vi.useFakeTimers();
    try {
      const { host, emit, got } = setup();
      await host.open("https://app.example/", { top: 0, bottom: 0 });

      // not pairing codes: another scheme's link, a v1 code, a short topic, no url at all
      for (const url of ["metamask://wc?uri=x", `wc:${"ab".repeat(32)}@1?bridge=x`, "wc:abcd@2?relay-protocol=irn", undefined]) emit("wcLink", { url });
      expect(got).toEqual([]);

      emit("wcLink", { url: URI });
      expect(got).toEqual([URI]);

      // a page that keeps navigating to codes gets one attempt per gap
      emit("wcLink", { url: URI.replace("ab", "ef") });
      expect(got.length).toBe(1);
      vi.advanceTimersByTime(WC_LINK_GAP_MS + 1);
      emit("wcLink", { url: URI.toUpperCase().replace("WC:", "wc:").replace("@2?RELAY", "@2?relay") });
      expect(got.length).toBe(2);

      // once the page is closed nothing is passed on
      await host.close();
      vi.advanceTimersByTime(WC_LINK_GAP_MS + 1);
      emit("wcLink", { url: URI });
      expect(got.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
