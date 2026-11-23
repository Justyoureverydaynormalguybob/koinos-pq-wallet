// @vitest-environment jsdom
// What came with several accounts: the account dropdown, names, "Max" on Send, which accounts a site is
// shown, how long until mana is full, and KOIN's dollar value read from the chain.
// The node is a small HTTP server in this process (see app-tokens.test.ts for why); the page is a fake of
// the in-app browser plugin (as in app-dapps.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor; // one realm, as in a browser
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));

const { App } = await import("../src/ui/app");
const core = await import("koinos-pq-core");
const { NETWORKS, PQWALLET_ENTRY, bootstrapAddress, bytesToHex, concat, deriveAccountKeys, fieldBytes, fieldString, fieldVarint } = core;
const { KOIN_USD_PAIR, fmtDuration, fmtUsd, manaFullIn, priceFromReserves, usdValue } = await import("../src/core/price");
const { AccountNames, cleanAccountName } = await import("../src/core/names");
const { SitePermissions } = await import("../src/core/permissions");
const { utils } = await import("koilib");
import type { PqBrowserPlugin } from "../src/native/pq-browser";

const b64 = (u: Uint8Array) => utils.encodeBase64url(u);
// the KOIN/vUSD pool's answer as mainnet gave it on 2026-11-23: 300,632.1 KOIN against 5,744.4 vUSD
const RESERVES = concat([fieldString(1, "0"), fieldVarint(2, 30063210648393n), fieldVarint(3, 574440282864n), fieldVarint(4, 1795377122270n)]);
const memory = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
};

describe("price, mana and names", () => {
  it("reads dollars per KOIN from the pool's reserves and formats money plainly", () => {
    const price = priceFromReserves(RESERVES)!;
    expect(price).toBeCloseTo(0.0191077, 6);
    expect(fmtUsd(price)).toBe("$0.0191");
    expect(fmtUsd(usdValue(9300000000n, price))).toBe("$1.78"); // 93 KOIN
    expect(fmtUsd(1234.5)).toBe("$1,235");
    expect(fmtUsd(0)).toBe("$0");
    // an empty pool, or an answer that is not the pool's, gives no price rather than a wrong one
    expect(priceFromReserves(concat([fieldVarint(2, 0n), fieldVarint(3, 5n)]))).toBeNull();
    expect(priceFromReserves(new Uint8Array(0))).toBeNull();
  });

  it("says how long until mana is full: a straight line, five days from empty", () => {
    expect(manaFullIn(null, 5n)).toBeNull();
    expect(manaFullIn(500000000n, 500000000n)).toBe(0);
    expect(manaFullIn(500000000n, 0n)).toBe(5 * 24 * 3600 * 1000);
    expect(fmtDuration(manaFullIn(500000000n, 400000000n)!)).toBe("1 d 0 h"); // a fifth to go: one day
    expect(fmtDuration(manaFullIn(10000000000n, 9690000000n)!)).toBe("3 h 44 min"); // 3.1 of 100 spent
    expect(fmtDuration(30_000)).toBe("under a minute");
    expect(fmtDuration(25 * 60_000)).toBe("25 min");
  });

  it("keeps account names clean and per wallet", () => {
    expect(cleanAccountName("  Savings ‮ evil\u0000 ")).toBe("Savings evil");
    expect(cleanAccountName("x".repeat(80)).length).toBe(32);
    const store = memory();
    const names = new AccountNames("slot0", store);
    names.set("1A", "Savings");
    expect(new AccountNames("slot0", store).get("1A")).toBe("Savings");
    expect(new AccountNames("slot1", store).get("1A")).toBeNull();
    names.set("1A", "   ");
    expect(new AccountNames("slot0", store).get("1A")).toBeNull();
  });

  it("remembers which accounts a site was shown", () => {
    const store = memory();
    const sites = new SitePermissions("slot0", store);
    sites.allow("https://old.example"); // a grant from before there was a choice
    sites.allow("https://dapp.example", ["1B"]);
    expect(sites.accountsFor("https://old.example")).toBeUndefined();
    expect(sites.accountsFor("https://dapp.example")).toEqual(["1B"]);
    sites.allow("https://dapp.example", ["1A", "1B"]); // connecting again replaces the choice
    expect(new SitePermissions("slot0", store).accountsFor("https://dapp.example")).toEqual(["1A", "1B"]);
    expect(new SitePermissions("slot0", store).list().length).toBe(2);
  });
});

// ---- through the screens ----
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const keyOf = (n: number) => deriveAccountKeys(SEED, n);
const addressOf = (n: number) => bootstrapAddress(keyOf(n));
const infoResult = b64(concat([fieldString(1, "ML-DSA-44 (FIPS 204), pure mode"), fieldVarint(2, 1312), fieldVarint(3, 2420), fieldString(4, "koinos/pqwallet/1"), fieldVarint(5, 1)]));
const PAIR = "1E8AjPZxKLJGFouXtNNkPcYxAgsTh4AUTN";
const active = new Map<string, Uint8Array>([0, 1].map((n) => [addressOf(n), keyOf(n).publicKey]));
// every account: 20 KOIN, 16 mana (a fifth of five days to go)
function answer(req: { method: string; params: Record<string, unknown> }): unknown {
  if (req.method === "chain.get_head_info") return { head_topology: { height: "100" } };
  if (req.method === "chain.get_account_rc") return { rc: "1600000000" };
  if (req.method === "chain.get_account_nonce") return { nonce: "" };
  if (req.method === "chain.get_chain_id") return { chain_id: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==" };
  if (req.method === "chain.read_contract") {
    const { contract_id, entry_point } = req.params as { contract_id: string; entry_point: number };
    const pk = active.get(contract_id);
    if (contract_id === PAIR) return { result: b64(RESERVES) };
    if (entry_point === PQWALLET_ENTRY.get_info) return { result: pk ? infoResult : "" };
    if (entry_point === PQWALLET_ENTRY.get_public_key) return { result: pk ? b64(concat([fieldBytes(1, pk)])) : "" };
    if (entry_point === 0x5c721497) return { result: b64(concat([fieldVarint(1, 2000000000n)])) };
    return { result: "" };
  }
  return {};
}
let server: Server;
let rpc = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: answer(r) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  KOIN_USD_PAIR.devnet = PAIR; // the devnet has no pool; the fake node answers for one
});
afterAll(() => {
  server.close();
  delete KOIN_USD_PAIR.devnet;
});

function fakeBrowser() {
  const replies: Array<{ id: string; result?: unknown; error?: string }> = [];
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const emit = (event: string, e: unknown) => {
    for (const fn of listeners[event] ?? []) fn(e);
  };
  const plugin = {
    async open(o: { url: string }) {
      emit("navigation", { url: o.url, title: "Page", canGoBack: false });
    },
    async navigate() {},
    async back() {
      return { canGoBack: false };
    },
    async close() {
      emit("closed", {});
    },
    async show() {},
    async hide() {},
    async setDesktop() {},
    async setFrame() {},
    async setSecure() {},
    async reply(o: { json: string }) {
      replies.push(JSON.parse(o.json));
    },
    addListener: (async (event: string, fn: (e: unknown) => void) => {
      (listeners[event] ??= []).push(fn);
      return { remove: async () => void (listeners[event] = listeners[event]!.filter((f) => f !== fn)) };
    }) as PqBrowserPlugin["addListener"],
    async removeAllListeners() {},
  } as unknown as PqBrowserPlugin;
  const pageSends = (id: string, command: string, origin = "https://dapp.example") => emit("message", { json: JSON.stringify({ id, command, args: null }), origin, mainFrame: true });
  return { plugin, replies, pageSends };
}

const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 250));
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
const addresses = (reply: { result?: unknown } | undefined) => ((reply?.result as Array<{ address: string; name: string }>) ?? []).map((a) => a.address);

describe("the account features through the screens (jsdom, a fake node and a fake page)", () => {
  it("dropdown, mana and price lines, a name, Max, and a site shown only the accounts ticked", async () => {
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    localStorage.setItem("koinos-pq-wallet/devnet-rpc", rpc);
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    const fb = fakeBrowser();
    new App(root, { native: true, browser: fb.plugin, bridgeScript: async () => "/* inpage */", approveDelayMs: 0 });
    click(root, "import");
    await submit(root, "import", { seed: bytesToHex(SEED) });
    await submit(root, "passphrase", { p1: "main passphrase 1234", p2: "main passphrase 1234" });
    await new Promise((r) => setTimeout(r, 800));

    // one dropdown instead of a list of rows
    const picker = () => root.querySelector<HTMLSelectElement>('select[name="account"]')!;
    const options = () => [...picker().options].map((o) => o.textContent!.replace(/\s+/g, " ").trim());
    expect(root.querySelector("ul.accts")).toBeNull();
    expect(options().some((o) => /^Account 2 · /.test(o))).toBe(true);
    const choose = async (re: RegExp) => {
      picker().value = [...picker().options].find((o) => re.test(o.textContent!.trim()))!.value;
      picker().dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    };
    await choose(/^Your account/);

    // 20 KOIN with 16 mana: a fifth of five days until full; and the dollar value from the pool
    expect(root.querySelector("#home-mana")?.textContent).toBe("16");
    expect(root.querySelector("#home-mana-full")?.textContent).toBe("full in 1 d 0 h");
    await new Promise((r) => setTimeout(r, 400));
    expect(root.querySelector("#home-usd")?.textContent).toBe("≈ $0.382 · $0.0191 per KOIN");

    // Max on Send: mana less the 4 kept for the fee, typed into the field without losing the recipient
    click(root, "send");
    const send = () => root.querySelector<HTMLFormElement>('form[data-form="send"]')!;
    send().querySelector<HTMLInputElement>('[name="to"]')!.value = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
    click(root, "send-max");
    expect(send().querySelector<HTMLInputElement>('[name="amount"]')!.value).toBe("12");
    expect(send().querySelector<HTMLInputElement>('[name="to"]')!.value).toBe("1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t");
    click(root, "back-home");
    await settle();

    // a name for the second account: in Settings, then everywhere the account is listed
    click(root, "settings");
    await settle();
    const renameLink = [...root.querySelectorAll<HTMLElement>('[data-action="account-rename"]')].find((b) => b.dataset.address === addressOf(1))!;
    renameLink.click();
    await submit(root, "account-rename", { name: "  Savings  " });
    expect(root.textContent).toContain("Savings");
    click(root, "back-home");
    await settle();
    expect(options().some((o) => /^Savings · /.test(o))).toBe(true);
    expect(options().some((o) => /^Account 2/.test(o))).toBe(false);

    // a site asks to see the accounts: the sheet lists them, the one in use ticked
    click(root, "tab-dapps");
    await submit(root, "dapp-open", { url: "dapp.example" });
    fb.pageSends("a1", "getAccounts");
    await settle();
    const boxes = () => [...root.querySelectorAll<HTMLInputElement>('.sheet input[name="dapp-acct"]')];
    expect(boxes().map((b) => [b.value, b.checked])).toEqual(expect.arrayContaining([[addressOf(0), true], [addressOf(1), false]]));
    expect(root.querySelector(".sheet")!.textContent).toContain("Savings");
    // nothing ticked: refused here, nothing sent to the page
    for (const b of boxes()) {
      if (b.checked) {
        b.checked = false;
        b.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    click(root, "dapp-approve");
    await settle();
    expect(root.textContent).toMatch(/Choose at least one account/);
    expect(fb.replies.find((r) => r.id === "a1")).toBeUndefined();
    // tick only the second account and approve: the site gets that one, under its neutral name
    const second = boxes().find((b) => b.value === addressOf(1))!;
    second.checked = true;
    second.dispatchEvent(new Event("change", { bubbles: true }));
    click(root, "dapp-approve");
    await settle();
    const first = fb.replies.find((r) => r.id === "a1");
    expect(addresses(first)).toEqual([addressOf(1)]);
    expect(JSON.stringify(first)).not.toContain("Savings");
    // asked again, the site is answered without a sheet, with the same account and no more
    fb.pageSends("a2", "getAccounts");
    await settle();
    expect(root.querySelector(".sheet")).toBeNull();
    expect(addresses(fb.replies.find((r) => r.id === "a2"))).toEqual([addressOf(1)]);
    click(root, "lock");
  }, 120_000);
});
