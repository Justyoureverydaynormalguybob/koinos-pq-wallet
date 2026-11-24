// @vitest-environment jsdom
// Several accounts from one set of 24 words: which accounts a wallet finds on the chain, that each signs
// with its own key, and that the screens offer them (the picker, Send, "Create another account").
// The node is a small HTTP server in this process (see app-tokens.test.ts for why).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
// one Uint8Array realm, as in a browser (see app-burn.test.ts)
globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor;
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));

const { App } = await import("../src/ui/app");
const core = await import("koinos-pq-core");
const { NETWORKS, PQWALLET_ENTRY, bootstrapAddress, bytesToHex, concat, deriveAccountKeys, deriveKeys, fieldBytes, fieldString, fieldVarint, verifyEntry } = core;
const { ACCOUNT_GAP, accountKeys, detectAccounts, nextAccountKey, walletAccounts, wipeAccountKeys } = await import("../src/core/accounts");
const { utils } = await import("koilib");

const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const keyOf = (n: number) => deriveAccountKeys(SEED, n);
const addressOf = (n: number) => bootstrapAddress(keyOf(n));
const b64 = (u: Uint8Array) => utils.encodeBase64url(u);
// what the pqwallet contract answers: get_info with a registered 1312-byte key, and the key itself
const infoResult = b64(concat([fieldString(1, "ML-DSA-44 (FIPS 204), pure mode"), fieldVarint(2, 1312), fieldVarint(3, 2420), fieldString(4, "koinos/pqwallet/1"), fieldVarint(5, 1)]));
const keyResult = (pk: Uint8Array) => b64(concat([fieldBytes(1, pk)]));

/** address -> the public key registered on the pqwallet contract there */
let active = new Map<string, Uint8Array>();
const activate = (...numbers: number[]) => {
  active = new Map(numbers.map((n) => [addressOf(n), keyOf(n).publicKey]));
};

/** address -> mana the node reports for it; anything else has 5 */
const manaOf = new Map<string, string>();

type Tx = { id: string; header: { payer: string }; operations: unknown[]; signatures: string[] };
const submitted: Tx[] = [];
const reads: string[] = [];
function answer(req: { method: string; params: Record<string, unknown> }): unknown {
  if (req.method === "chain.get_head_info") return { head_topology: { height: "100" } };
  if (req.method === "chain.get_account_rc") return { rc: manaOf.get((req.params as { account: string }).account) ?? "500000000" };
  if (req.method === "chain.get_account_nonce") return { nonce: "" };
  if (req.method === "chain.get_chain_id") return { chain_id: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==" };
  if (req.method === "chain.get_resource_limits") return { resource_limit_data: { disk_storage_cost: "10", network_bandwidth_cost: "5", compute_bandwidth_cost: "1" } };
  if (req.method === "chain.read_contract") {
    const { contract_id, entry_point } = req.params as { contract_id: string; entry_point: number };
    reads.push(`${contract_id}:${entry_point.toString(16)}`);
    const pk = active.get(contract_id);
    if (entry_point === PQWALLET_ENTRY.get_info) return { result: pk ? infoResult : "" };
    if (entry_point === PQWALLET_ENTRY.get_public_key) return { result: pk ? keyResult(pk) : "" };
    if (entry_point === 0x5c721497) return { result: b64(concat([fieldVarint(1, 500000000n)])) };
    return { result: "" };
  }
  if (req.method === "chain.submit_transaction") {
    submitted.push((req.params as { transaction: Tx }).transaction);
    return { receipt: { rc_used: "1" } };
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
});
afterAll(() => server.close());
const chain = () => new core.Chain({ ...NETWORKS.devnet!, rpc: [rpc] });

describe("finding a wallet's accounts", () => {
  it("finds account 0, 1, 2, ... at the addresses their own keys give, and stops after a gap", async () => {
    const master = deriveKeys(SEED);
    activate();
    expect(await detectAccounts(chain(), master)).toEqual([]);
    activate(0);
    expect(await detectAccounts(chain(), master)).toEqual([{ address: addressOf(0), key: 0 }]);
    activate(0, 1, 2);
    expect(await detectAccounts(chain(), master)).toEqual([0, 1, 2].map((key) => ({ address: addressOf(key), key })));
    // one unused number in between is stepped over; ACCOUNT_GAP in a row end the search
    activate(0, 2);
    expect((await detectAccounts(chain(), master)).map((f) => f.key)).toEqual([0, 2]);
    activate(0, 1 + ACCOUNT_GAP);
    expect((await detectAccounts(chain(), master)).map((f) => f.key)).toEqual([0]);
    // a contract at account 1's address with someone else's key registered is not this wallet's account
    activate(0, 1);
    active.set(addressOf(1), keyOf(5).publicKey);
    expect((await detectAccounts(chain(), master)).map((f) => f.key)).toEqual([0]);
    // the addresses are the rule's, not the node's say-so
    expect(addressOf(1)).not.toBe(addressOf(0));
    expect(new Set([0, 1, 2, 3].map(addressOf)).size).toBe(4);
  });

  it("keeps one key pair per account for as long as the wallet is open, and wipes them with it", () => {
    const master = deriveKeys(SEED);
    expect(accountKeys(master, 0)).toBe(master);
    const one = accountKeys(master, 1);
    expect(accountKeys(master, 1)).toBe(one);
    expect(bytesToHex(one.publicKey)).toBe(bytesToHex(keyOf(1).publicKey));
    expect(bytesToHex(one.publicKey)).not.toBe(bytesToHex(master.publicKey));
    wipeAccountKeys(master);
    expect(one.secretKey.every((b) => b === 0)).toBe(true);
    expect(one.seed.every((b) => b === 0)).toBe(true);
    // a fresh pair after the wipe, and none once the wallet itself has been wiped
    expect(accountKeys(master, 1)).not.toBe(one);
    wipeAccountKeys(master);
    master.seed.fill(0);
    master.secretKey.fill(0);
    expect(() => accountKeys(master, 1)).toThrow(/locked/);
  });

  it("offers them by name with the number of the key that signs, and numbers the next one", () => {
    const master = deriveKeys(SEED);
    const found = [0, 1, 2].map((key) => ({ address: addressOf(key), key }));
    expect(walletAccounts(master, [], "mainnet", found)).toEqual([
      { name: "Your account", address: addressOf(0), mode: "pqwallet", key: 0 },
      { name: "Account 2", address: addressOf(1), mode: "pqwallet", key: 1 },
      { name: "Account 3", address: addressOf(2), mode: "pqwallet", key: 2 },
    ]);
    // a found account that is also stored keeps its stored label and gets the right key
    const stored = [{ label: "Savings", mode: "pqwallet" as const, address: addressOf(1) }];
    expect(walletAccounts(master, stored, "mainnet", found).find((a) => a.address === addressOf(1))).toEqual({ name: "Savings", address: addressOf(1), mode: "pqwallet", key: 1 });
    expect(nextAccountKey([])).toBe(0);
    expect(nextAccountKey(found)).toBe(3);
    expect(nextAccountKey([found[0]!, found[2]!])).toBe(1);
  });
});

const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
};
const click = (root: HTMLElement, action: string) => {
  const el = root.querySelector<HTMLElement>(`[data-action="${action}"]`);
  if (!el) throw new Error(`no action ${action}; screen shows: ${root.querySelector("h1")?.textContent}`);
  el.click();
};
async function submit(root: HTMLElement, form: string, fields: Record<string, string>, tick: string[] = []) {
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`);
  if (!f) throw new Error(`no form ${form}; screen shows: ${root.querySelector("h1")?.textContent}`);
  for (const [k, v] of Object.entries(fields)) f.querySelector<HTMLInputElement>(`[name="${k}"]`)!.value = v;
  for (const name of tick) f.querySelector<HTMLInputElement>(`[name="${name}"]`)!.checked = true;
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

describe("several accounts through the screens (jsdom, a fake node over HTTP)", () => {
  it("lists the accounts found from the words, sends from the second with its own key, and offers a third", async () => {
    activate(0, 1);
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    localStorage.setItem("koinos-pq-wallet/devnet-rpc", rpc);
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    click(root, "import");
    await submit(root, "import", { seed: bytesToHex(SEED) });
    await submit(root, "passphrase", { p1: "main kettle orbit plank", p2: "main kettle orbit plank" });
    // the accounts are found by reads that take longer on a loaded machine: wait for the picker, not a fixed time
    for (let i = 0; i < 100 && ![...root.querySelectorAll('select[name="account"] option')].some((o) => /^Account 2/.test(o.textContent!.trim())); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));

    // the picker: the native address (devnet only), the first account and "Account 2"
    const picker = () => root.querySelector<HTMLSelectElement>('select[name="account"]')!;
    const labels = () => [...picker().options].map((o) => o.textContent!.replace(/\s+/g, " ").trim());
    expect(labels().some((l) => /^Your account/.test(l))).toBe(true);
    expect(labels().some((l) => /^Account 2/.test(l))).toBe(true);
    expect(labels().some((l) => /^Account 3/.test(l))).toBe(false);

    // choose Account 2 and send from it
    picker().value = [...picker().options].find((o) => /^Account 2/.test(o.textContent!.trim()))!.value;
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(root.textContent).toContain(addressOf(1).slice(0, 4));
    click(root, "send");
    await submit(root, "send", { to: "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t", amount: "1" });
    expect(root.querySelector("h1")?.textContent).toMatch(/First time sending here/);
    await submit(root, "send-confirm", {}, ["checked"]);
    expect(submitted.length, root.querySelector(".notice.danger")?.textContent ?? "").toBe(1);
    const tx = submitted[0]!;
    expect(tx.header.payer).toBe(addressOf(1));
    const entry = utils.decodeBase64url(tx.signatures[0]!);
    // signed by account 2's own key; the wallet's first key would not pass on that account
    expect(verifyEntry(entry, tx.id, keyOf(1).publicKey, "pqwallet")).toBe(true);
    expect(verifyEntry(entry, tx.id, keyOf(0).publicKey, "pqwallet")).toBe(false);

    // Settings offers a further account: the next number, at the address its own key gives
    click(root, "back-home");
    await settle();
    click(root, "settings");
    await settle();
    expect(root.textContent).toContain("Account 2");
    click(root, "new-account");
    await settle();
    expect(root.querySelector("h1")?.textContent).toBe("Activate account 3");
    expect(root.textContent!.replace(/\s+/g, "")).toContain(addressOf(2));
    expect(root.textContent!.replace(/\s+/g, "")).not.toContain(addressOf(0));
    click(root, "lock");
  }, 120_000);

  it("says when the next account holds funds but was never activated, and goes back to its screen after sending to it", async () => {
    activate(0);
    manaOf.clear();
    manaOf.set(addressOf(1), "0");
    submitted.length = 0;
    localStorage.clear();
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
    localStorage.setItem("koinos-pq-wallet/devnet-rpc", rpc);
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    click(root, "import");
    await submit(root, "import", { seed: bytesToHex(SEED) });
    await submit(root, "passphrase", { p1: "main kettle orbit plank", p2: "main kettle orbit plank" });
    await new Promise((r) => setTimeout(r, 600));
    const pick = () => {
      const p = root.querySelector<HTMLSelectElement>('select[name="account"]')!;
      p.value = [...p.options].find((o) => /^Your account/.test(o.textContent!.trim()))!.value;
      p.dispatchEvent(new Event("change", { bubbles: true }));
    };
    pick();
    await settle();
    // account 2 holds nothing: the Account tab says nothing about it
    expect(root.textContent).not.toContain("is not activated yet");

    // start account 2, send to it from the first account, and tap Done: back on its activation screen, not Home
    click(root, "settings");
    await settle();
    click(root, "new-account");
    await settle();
    expect(root.querySelector("h1")?.textContent).toBe("Activate account 2");
    click(root, "send-to");
    await settle();
    await submit(root, "send", { amount: "1" });
    if (/First time sending here/.test(root.querySelector("h1")?.textContent ?? "")) await submit(root, "send-confirm", {}, ["checked"]);
    expect(submitted.length, root.querySelector(".notice.danger")?.textContent ?? "").toBe(1);
    manaOf.set(addressOf(1), "100"); // the payment arrived, too little to activate with
    click(root, "back-home");
    await settle();
    expect(root.querySelector("h1")?.textContent).toBe("Activate account 2");

    // leave it for the Account tab: the wallet says where the funds are and offers to finish
    click(root, "setup-cancel");
    await settle();
    click(root, "back-home");
    await settle();
    await new Promise((r) => setTimeout(r, 400));
    click(root, "refresh");
    await settle();
    expect(root.textContent).toContain("Account 2 holds");
    expect(root.textContent).toContain("is not activated yet");
    const finish = [...root.querySelectorAll<HTMLElement>('[data-action="new-account"]')].find((b) => /Finish activating account 2/.test(b.textContent ?? ""));
    expect(finish).toBeTruthy();
    finish!.click();
    await settle();
    expect(root.querySelector("h1")?.textContent).toBe("Activate account 2");
    expect(root.textContent!.replace(/\s+/g, "")).toContain(addressOf(1));
    click(root, "setup-cancel");
    await settle();
    click(root, "lock");
    manaOf.clear();
  }, 120_000);
});
