// @vitest-environment jsdom
// WalletConnect through the real screens with a dapp page open in the in-app browser, the way KoinDX is
// used on a phone (its phone layout offers WalletConnect, not Kondor): the page's wc: link pairs, the
// proposal comes up on the sheet, and a signing request from the session comes up on the sheet too, with
// the page hidden under it. And the reason this file exists: after a lock and an unlock in the same run
// the app must still have ONE WalletConnect client. Until 0.19.3 it made a second, the library delivered
// everything twice, and a dapp that had connected sent a transaction that never reached the sheet.
// The WalletConnect client itself is a stand-in here; test/wc-live*.test.ts covers the real relay.
import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { PqBrowserPlugin } from "../src/native/pq-browser";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));

type Handler = (e: unknown) => void;
interface FakeKit {
  on(ev: string, fn: Handler): void;
  emit(ev: string, e: unknown): void;
  paired: string[];
  responses: Array<{ topic: string; response: { id: number; result?: unknown; error?: { message: string } } }>;
  sessions: Record<string, { topic: string }>;
}
const wc = vi.hoisted(() => ({ clients: 0, kit: null as unknown }));
vi.mock("@walletconnect/core", () => ({
  Core: class {
    relayer = { on() {} };
    pairing = { getPairings: () => [], disconnect: async () => undefined };
  },
}));
vi.mock("@reown/walletkit", () => ({
  WalletKit: {
    init: async ({ core }: { core: unknown }) => {
      wc.clients++;
      const handlers: Record<string, Handler[]> = {};
      const sessions: Record<string, { topic: string }> = {};
      const kit = {
        core,
        sessions,
        paired: [] as string[],
        responses: [] as unknown[],
        on: (ev: string, fn: Handler) => void (handlers[ev] ??= []).push(fn),
        emit: (ev: string, e: unknown) => (handlers[ev] ?? []).forEach((fn) => fn(e)),
        pair: async ({ uri }: { uri: string }) => void kit.paired.push(uri),
        approveSession: async ({ id, namespaces }: { id: number; namespaces: unknown }) => {
          const s = { topic: `topic-${id}`, pairingTopic: "ab".repeat(32), peer: { metadata: { name: "KoinDX", url: "https://app.koindx.com" } }, namespaces, expiry: 9e9 };
          sessions[s.topic] = s;
          return s;
        },
        rejectSession: async () => undefined,
        respondSessionRequest: async (o: unknown) => void kit.responses.push(o),
        getActiveSessions: () => sessions,
        disconnectSession: async ({ topic }: { topic: string }) => void delete sessions[topic],
      };
      wc.kit = kit;
      return kit;
    },
  },
}));
vi.mock("@walletconnect/utils", () => ({
  buildApprovedNamespaces: ({ supportedNamespaces }: { supportedNamespaces: unknown }) => supportedNamespaces,
  getSdkError: () => ({ code: 6000, message: "User disconnected." }),
}));
// The wallet's account exists on the chain as far as this test goes (the node is not reachable here).
vi.mock("../src/core/accounts", async (original) => {
  const real = await original<typeof import("../src/core/accounts")>();
  const { bootstrapAddress } = await import("koinos-pq-core");
  return { ...real, detectAccounts: async (_chain: unknown, keys: Parameters<typeof bootstrapAddress>[0]) => [{ address: bootstrapAddress(keys), key: 0 }] };
});
const { App } = await import("../src/ui/app");

const MAIN = "main kettle orbit plank";
const CHAIN = "koinos:EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3e";
const URI = `wc:${"ab".repeat(32)}@2?relay-protocol=irn&symKey=${"cd".repeat(32)}`;
const KOINDX = "https://app.koindx.com";
// the swap KoinDX asks for (0.1 KOIN to vUSDT), as its page prepares it: an allowance, then the swap
const SWAP = {
  operations: [
    { call_contract: { contract_id: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", entry_point: 1960973952, args: "ChkA1N6QMhQOk9mv4MJnGx69EG7wAw-HQl0tEhkASNDWYZdHeig_Rn8I4UqOfj5cUzyaJtMCGICt4gQ=" } },
    { call_contract: { contract_id: "17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s", entry_point: 2335548678, args: "ChkA1N6QMhQOk9mv4MJnGx69EG7wAw-HQl0tEhkA1N6QMhQOk9mv4MJnGx69EG7wAw-HQl0tGICt4gQgkOkLKgRrb2luKiIxMlZvSHo0MWE0SHRmaXloVFdiZzlSWHFHTVJiWWs2cFho" } },
  ],
  header: { chain_id: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", rc_limit: "100000000", nonce: "KAk=", operation_merkle_root: "EiAzwXg93ZIi5uUuh1-pmLzdpnWP1uqX9Nc5w0UK--ftGw==", payer: "" },
  id: "0x12208e83e57eb388c9e770e3af4900d409b8acc18b6ff38993877aca827b31d4c3cd",
};

function fakeBrowser() {
  const calls: string[] = [];
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const emit = (event: string, e: unknown) => (listeners[event] ?? []).forEach((fn) => fn(e));
  const plugin = {
    async open(o: { url: string }) {
      calls.push(`open ${o.url}`);
      emit("navigation", { url: o.url, title: "KoinDX", canGoBack: false });
    },
    async navigate() {},
    async back() {
      return { canGoBack: false };
    },
    async close() {
      calls.push("close");
      emit("closed", {});
    },
    async show() {
      calls.push("show");
    },
    async hide() {
      calls.push("hide");
    },
    async setDesktop() {},
    async setFrame() {},
    async setSecure() {},
    async reply(o: { json: string }) {
      if (JSON.parse(o.json).pqCommand === "clear-site-data-quiet") emit("message", { json: JSON.stringify({ id: "pq-site-cleared", command: "pq:site-cleared", args: null }), origin: KOINDX, mainFrame: true });
    },
    addListener: (async (event: string, fn: (e: unknown) => void) => {
      (listeners[event] ??= []).push(fn);
      return { remove: async () => void (listeners[event] = listeners[event]!.filter((f) => f !== fn)) };
    }) as PqBrowserPlugin["addListener"],
    async removeAllListeners() {},
  } as unknown as PqBrowserPlugin;
  return { plugin, calls, emit };
}

const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
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
const text = (root: HTMLElement) => root.textContent ?? "";
const sheet = (root: HTMLElement) => root.querySelector(".sheet");

describe("WalletConnect with a dapp page open in the app (jsdom, a stand-in client)", () => {
  it("one client for the whole run; after a lock and unlock the page pairs, connects, and its transaction reaches the sheet", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline in this test");
    });
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "mainnet");
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    const fb = fakeBrowser();
    new App(root, { native: true, browser: fb.plugin, bridgeScript: async () => "/* inpage */", approveDelayMs: 0, livePollMs: 0 });
    click(root, "create");
    const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
    click(root, "wrote-down");
    const labels = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
    await submit(root, "confirm", { w0: words[labels[0]!]!, w1: words[labels[1]!]!, w2: words[labels[2]!]! });
    await submit(root, "passphrase", { p1: MAIN, p2: MAIN });
    await settle();
    expect(wc.clients).toBe(1); // started at the first unlock

    // a lock and an unlock, as after changing the passphrase or an auto-lock
    click(root, "lock");
    await settle();
    await submit(root, "unlock", { passphrase: MAIN });
    await settle();
    expect(wc.clients, "a second WalletConnect client was made").toBe(1);
    const kit = wc.kit as FakeKit;

    // KoinDX open in the in-app browser; its WalletConnect button navigates to the pairing link after a real tap
    click(root, "tab-dapps");
    await submit(root, "dapp-open", { url: "app.koindx.com" });
    expect(fb.calls.some((c) => c.startsWith(`open ${KOINDX}`))).toBe(true);
    fb.emit("message", { json: JSON.stringify({ id: "pq-tap", command: "pq:tap", args: null }), origin: KOINDX, mainFrame: true });
    fb.emit("wcLink", { url: URI, gesture: true });
    await settle();
    expect(kit.paired).toEqual([URI]);

    // the dapp's proposal: on the sheet, page hidden; approved with the wallet's account
    kit.emit("session_proposal", {
      id: 7,
      params: { pairingTopic: "ab".repeat(32), proposer: { metadata: { name: "KoinDX", url: KOINDX } }, requiredNamespaces: { koinos: { chains: [CHAIN], methods: ["koinos_signAndSendTransaction", "koinos_prepareTransaction"], events: [] } } },
      verifyContext: { verified: { validation: "UNKNOWN" } },
    });
    await settle();
    expect(sheet(root), "the connection request is not on the sheet").not.toBeNull();
    expect(text(root)).toMatch(/app\.koindx\.com/);
    click(root, "dapp-approve");
    await settle();
    const topic = Object.keys(kit.sessions)[0];
    expect(topic, "the session was not approved").toBe("topic-7");
    expect(sheet(root)).toBeNull();
    const address = ((kit.sessions[topic!] as unknown as { namespaces: { koinos: { accounts: string[] } } }).namespaces.koinos.accounts[0] ?? "").split(":")[2]!;

    // the swap: exactly one request, and it must come up on the sheet with the page hidden under it
    const hidesBefore = fb.calls.filter((c) => c === "hide").length;
    kit.emit("session_request", {
      id: 8,
      topic,
      params: { chainId: CHAIN, request: { method: "koinos_signAndSendTransaction", params: { address, transaction: { ...SWAP, header: { ...SWAP.header, payer: address } } } } },
      verifyContext: { verified: { validation: "UNKNOWN" } },
    });
    await settle();
    expect(sheet(root), "the transaction did not reach the approval sheet").not.toBeNull();
    expect(root.querySelector("#req")?.textContent).toMatch(/app\.koindx\.com/);
    expect(fb.calls.filter((c) => c === "hide").length).toBeGreaterThan(hidesBefore);
    expect(kit.responses).toEqual([]); // nothing is answered before the user decides

    // rejecting answers the dapp, once, through the same client
    click(root, "dapp-reject");
    await settle();
    expect(kit.responses.length).toBe(1);
    expect(kit.responses[0]!.topic).toBe(topic);
    expect(kit.responses[0]!.response.id).toBe(8);
    expect(kit.responses[0]!.response.error?.message).toMatch(/rejected by the user|refused by the wallet/);
    expect(sheet(root)).toBeNull();
    vi.unstubAllGlobals();
  }, 120_000);
});
