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

describe("leaving a site clears what it stored", () => {
  function setup() {
    const order: string[] = [];
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const plugin = {
      async open() {},
      async close() {
        order.push("close");
      },
      async navigate(o: { url: string }) {
        order.push("navigate " + o.url);
      },
      async reply(o: { json: string }) {
        order.push("reply " + o.json);
      },
      addListener: (async (event: string, fn: (e: unknown) => void) => {
        (listeners[event] ??= []).push(fn);
        return { remove: async () => undefined };
      }) as PqBrowserPlugin["addListener"],
    } as unknown as PqBrowserPlugin;
    const host = new DappHost(
      plugin,
      { onNavigation: () => undefined, onClosed: () => void order.push("onClosed"), onApproval: () => undefined },
      { network: () => ({}) as never, keys: () => null, accounts: () => [], permissions: () => null, bridgeScript: async () => "/* bridge */" },
    );
    const pageSays = (command: string, mainFrame = true) => (listeners.message ?? []).forEach((fn) => fn({ json: JSON.stringify({ id: "pq-site-cleared", command }), origin: "https://app.example", mainFrame }));
    return { host, order, pageSays };
  }
  const QUIET = 'reply {"pqCommand":"clear-site-data-quiet"}';

  it("closing a page clears its site first and closes once the page says it is done", async () => {
    const { host, order, pageSays } = setup();
    await host.open("https://app.example/", { top: 0, bottom: 0 });
    const closing = host.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([QUIET]); // asked to clear, not closed yet
    pageSays("pq:site-cleared", false); // a frame's word does not count
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([QUIET]);
    pageSays("pq:site-cleared");
    await closing;
    expect(order).toEqual([QUIET, "close", "onClosed"]);
  });

  it("a page that never answers is closed all the same, after a short wait", async () => {
    const { host, order } = setup();
    await host.open("https://app.example/", { top: 0, bottom: 0 });
    const t0 = Date.now();
    await host.close();
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(order).toEqual([QUIET, "close", "onClosed"]);
    await host.close(); // nothing open now: nothing is sent
    expect(order.filter((x) => x === QUIET)).toHaveLength(1);
  });

  it("typing another site's address clears the one being left; moving within a site does not", async () => {
    const { host, order, pageSays } = setup();
    await host.open("https://app.example/", { top: 0, bottom: 0 });
    await host.navigate("https://app.example/pools");
    expect(order).toEqual(["navigate https://app.example/pools"]);
    const going = host.navigate("https://other.example/");
    await new Promise((r) => setTimeout(r, 30));
    pageSays("pq:site-cleared");
    await going;
    expect(order).toEqual(["navigate https://app.example/pools", QUIET, "navigate https://other.example/"]);
  });

  it("the relay clears storage, cookies and databases without reloading, and reports back", async () => {
    const w = window as unknown as { __pqRelay?: boolean; __pqDeliver: (json: string) => void; PqBridge?: { postMessage: (j: string) => void } };
    delete w.__pqRelay;
    const told: Array<{ command?: string; origin?: string }> = [];
    w.PqBridge = { postMessage: (j) => void told.push(JSON.parse(j)) };
    new Function(RELAY_SHIM)();
    localStorage.setItem("wc@2:client:0.3//session", "stale");
    sessionStorage.setItem("s", "1");
    document.cookie = "connected=1; path=/";
    const deleted: string[] = [];
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: {
        databases: async () => [{ name: "WALLET_CONNECT_V2_INDEXED_DB" }],
        deleteDatabase: (name: string) => {
          deleted.push(name);
          const q: { onsuccess?: () => void } = {};
          setTimeout(() => q.onsuccess?.(), 0);
          return q;
        },
      },
    });
    w.__pqDeliver(JSON.stringify({ pqCommand: "clear-site-data-quiet" }));
    await new Promise((r) => setTimeout(r, 80));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(deleted).toEqual(["WALLET_CONNECT_V2_INDEXED_DB"]);
    expect(document.cookie).not.toMatch(/connected=1/);
    expect(told.filter((m) => m.command === "pq:site-cleared")).toHaveLength(1);
    delete w.PqBridge;
  });
});
