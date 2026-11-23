// @vitest-environment jsdom
// "Reset this site": the host sends one command through the page's own relay, and the relay clears what
// that origin stored (and nothing else it could not already clear itself), then reloads. Requests and
// answers keep flowing through the same relay as before.
import { describe, expect, it, vi } from "vitest";
import { DappHost } from "../src/ui/dapp-host";
import { RELAY_SHIM } from "../src/ui/dapp-bridge";
import type { PqBrowserPlugin } from "../src/native/pq-browser";

describe("resetting a site in the in-app browser", () => {
  it("the host sends the clear command only while a page is open", async () => {
    const sent: string[] = [];
    const plugin = {
      async open() {},
      async close() {},
      async reply(o: { json: string }) {
        sent.push(o.json);
      },
      addListener: (async () => ({ remove: async () => undefined })) as PqBrowserPlugin["addListener"],
    } as unknown as PqBrowserPlugin;
    const host = new DappHost(
      plugin,
      { onNavigation: () => undefined, onClosed: () => undefined, onApproval: () => undefined },
      { network: () => ({}) as never, keys: () => null, accounts: () => [], permissions: () => null, bridgeScript: async () => "/* bridge */" },
    );
    await host.resetSite();
    expect(sent).toEqual([]); // nothing open: nothing to reset
    await host.open("https://app.example/", { top: 0, bottom: 0 });
    await host.resetSite();
    expect(sent.map((j) => JSON.parse(j))).toEqual([{ pqCommand: "clear-site-data" }]);
  });

  it("the relay clears the page's storage on that command and still delivers ordinary answers", async () => {
    const w = window as unknown as { __pqRelay?: boolean; __pqDeliver: (json: string) => void };
    delete w.__pqRelay;
    new Function(RELAY_SHIM)();
    localStorage.setItem("WALLETCONNECT_DEEPLINK_CHOICE", "stale");
    sessionStorage.setItem("s", "1");
    const deleted: string[] = [];
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: {
        databases: async () => [{ name: "WALLET_CONNECT_V2_INDEXED_DB" }, { name: "other" }],
        deleteDatabase: (name: string) => {
          deleted.push(name);
          const q: { onsuccess?: () => void } = {};
          setTimeout(() => q.onsuccess?.(), 0);
          return q;
        },
      },
    });

    // an ordinary answer goes to the page as a window message, and clears nothing
    const got: unknown[] = [];
    window.addEventListener("message", (e) => got.push(e.data));
    w.__pqDeliver(JSON.stringify({ id: "abc", result: 7 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([{ id: "abc", result: 7 }]);
    expect(localStorage.getItem("WALLETCONNECT_DEEPLINK_CHOICE")).toBe("stale");

    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined); // jsdom cannot navigate; it says so
    w.__pqDeliver(JSON.stringify({ pqCommand: "clear-site-data" }));
    await new Promise((r) => setTimeout(r, 50));
    quiet.mockRestore();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(deleted.sort()).toEqual(["WALLET_CONNECT_V2_INDEXED_DB", "other"]);
    expect(got.length).toBe(1); // the command itself is not passed to the page
  });
});
