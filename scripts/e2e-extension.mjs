// End-to-end check of the browser extension in headless Chromium against the private devnet.
//
// What it proves: a plain web page with no wallet library of its own uses `window.kondor` (provided by
// the extension) to list accounts, read the chain through the extension, and send a KOIN transfer that
// the wallet signs with ML-DSA-44 after the user approves it in the wallet window. The devnet mines it
// with the 3733-byte native signature entry. A rejected request errors cleanly in the page.
//
// Needs:
//   - `npm run build:ext` done (dist-extension/)
//   - the devnet up: in koinos-pq, `docker compose -f devnet/docker-compose.yml up -d && node devnet/run.mjs`
//   - Playwright with a Chromium build somewhere: PLAYWRIGHT_DIR is a folder whose node_modules has it
//
//   PLAYWRIGHT_DIR=../memorymantle-premier KOINOS_PQ_DIR=../koinos-pq node --experimental-strip-types scripts/e2e-extension.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Transaction } from "koilib";
import { Chain, NETWORKS, TOKEN_ENTRY, callContractOperation, deriveKeys, encodeTransferArgs, formatKoin, verifyEntry, verifyMessageEntry } from "koinos-pq-core";
import { encryptVault } from "../src/core/vault.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const pwDir = resolve(here, "..", process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier");
const { chromium } = require(resolve(pwDir, "node_modules/playwright"));
const pqDir = resolve(here, "..", process.env.KOINOS_PQ_DIR ?? "../koinos-pq");
const ext = resolve(here, "..", process.env.EXT_DIR ?? "dist-extension");
const profile = resolve(here, "../.e2e-profile");
const PASS = "extension-e2e-passphrase";
const RECIPIENT = "1Hdt37BAtLnsssHvzj2Yo5r3YsCCY3Fatn"; // the devnet genesis account
const PORT = 4590;
const net = NETWORKS.devnet;
const chain = new Chain(net);
const ONE_KOIN = 100_000_000n;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok && !process.env.E2E_KEEP_GOING) throw new Error(`check failed: ${name} ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(args, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`${args.join(" ")} exited ${code}: ${out}`))));
  });
}

// ---- devnet: blocks every 2 s while this runs, and KOIN for the account under test ----
const blocks = spawn(process.execPath, ["devnet/auto-blocks.mjs", "--always"], { cwd: pqDir, stdio: "ignore" });
process.on("exit", () => blocks.kill());

const seed = new Uint8Array(randomBytes(32));
const keys = deriveKeys(seed);
const vault = await encryptVault({ version: 1, seedHex: bytesToHex(seed), accounts: [], createdAt: new Date().toISOString() }, PASS);
console.log(`account under test (native ML-DSA-44): ${keys.address}`);
await run(["devnet/mint.mjs", keys.address, "50"], pqDir);
for (let i = 0; i < 30 && (await chain.balance(keys.address)) < 50n * ONE_KOIN; i++) await sleep(1000);
check("devnet minted 50 KOIN to the account", (await chain.balance(keys.address)) >= 50n * ONE_KOIN);
const recipientBefore = await chain.balance(RECIPIENT);

// ---- a dapp page: no library, just window.kondor as the extension provides it ----
const server = createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>PQ test dapp</title><h1>PQ test dapp</h1>`);
}).listen(PORT, "127.0.0.1");

rmSync(profile, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  const extId = new URL(sw.url()).host;
  check("extension loaded, background service worker running", /^[a-p]{32}$/.test(extId), extId);

  // the wallet pages share one origin; the vault and the network choice live in its localStorage
  const wallet = await context.newPage();
  await wallet.goto(`chrome-extension://${extId}/index.html`);
  await wallet.evaluate(
    ({ vault, rpc }) => {
      localStorage.setItem("koinos-pq-wallet/vault", vault);
      localStorage.setItem("koinos-pq-wallet/network", "devnet");
      localStorage.setItem("koinos-pq-wallet/devnet-rpc", rpc);
    },
    { vault: JSON.stringify(vault), rpc: net.rpc[0] },
  );
  await wallet.reload();
  await wallet.waitForSelector("input[type=password]", { timeout: 15_000 });
  check("wallet page runs inside the extension and asks to unlock", true);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector("input[type=password]", { timeout: 15_000 });
  check("toolbar popup runs the wallet", true);
  await popup.close();

  const dapp = await context.newPage();
  await dapp.goto(`http://127.0.0.1:${PORT}/`);
  await dapp.waitForFunction(() => !!(window.kondor && window.koinosPq), null, { timeout: 15_000 });
  check("page got window.kondor from the content script", true);

  // approval windows, in the order they open (the wallet shows one at a time)
  const pageQueue = [];
  const waiters = [];
  context.on("page", (p) => (waiters.length ? waiters.shift()(p) : pageQueue.push(p)));
  const nextWindow = (ms = 30_000) =>
    pageQueue.length
      ? Promise.resolve(pageQueue.shift())
      : new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("no approval window opened")), ms);
          waiters.push((p) => (clearTimeout(t), res(p)));
        });

  /**
   * Runs a page action that needs the wallet, then answers in the wallet window: "approve" (passphrase),
   * "reject" (button), "close" (closes the window). A request the wallet refuses is closed with its own
   * button whatever `decide` says. Returns the page's outcome plus the window's text.
   */
  async function withApproval(action, decide = "approve") {
    const resultP = action().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.message || String(e) }));
    const w = await nextWindow();
    await w.waitForSelector("form[data-form=approve], [data-refuse]", { timeout: 30_000 });
    const text = await w.innerText("body");
    if (await w.$("[data-refuse]")) await w.click("[data-refuse]");
    else if (decide === "approve") {
      await w.fill("input[name=passphrase]", PASS);
      await w.click("button[type=submit]");
    } else if (decide === "reject") await w.click("[data-reject]");
    else await w.close();
    return { ...(await resultP), text };
  }
  const signer = (fn, arg) => () => dapp.evaluate(fn, arg);

  const accounts = await withApproval(() => dapp.evaluate(() => window.kondor.getAccounts()));
  check("getAccounts after approval lists the post-quantum address", accounts.ok && accounts.v.some((a) => a.address === keys.address), JSON.stringify(accounts.v ?? accounts.e));

  const head = await dapp.evaluate(() => window.kondor.getProvider("devnet").getHeadInfo());
  check("provider calls go through the background to the devnet", Number(head?.head_topology?.height) > 0, `height ${head?.head_topology?.height}`);

  const rejected = await withApproval(() => dapp.evaluate(() => window.kondor.getAccounts()), "reject");
  check("a rejected request errors in the page", !rejected.ok && /rejected by the user/.test(rejected.e), rejected.e);

  const MSG = "hello from a dapp";
  const sig = await withApproval(() => dapp.evaluate(async ({ addr, msg }) => Array.from(await window.kondor.getSigner(addr).signMessage(msg)), { addr: keys.address, msg: MSG }));
  const sigBytes = sig.ok ? Uint8Array.from(sig.v) : new Uint8Array(0);
  check("signMessage returns a 3733-byte entry that verifies as a signed message", sigBytes.length === 3733 && verifyMessageEntry(sigBytes, new TextEncoder().encode(MSG), keys.publicKey, "native"), String(sig.ok ? sigBytes.length : sig.e));
  const msgAsTxId = "0x1220" + createHash("sha256").update(MSG).digest("hex");
  check("a signed message is not valid as a transaction signature", !verifyEntry(sigBytes, msgAsTxId, keys.publicKey, "native"));

  const op = callContractOperation(net.koin, TOKEN_ENTRY.transfer, encodeTransferArgs(keys.address, RECIPIENT, ONE_KOIN));
  const sent = await withApproval(() =>
    dapp.evaluate(
      async ({ addr, op }) => {
        const signer = window.kondor.getSigner(addr);
        const { transaction, receipt } = await signer.sendTransaction({ header: { rc_limit: "1500000" }, operations: [op] });
        return { id: transaction.id, payer: transaction.header.payer, signatures: transaction.signatures, rcUsed: receipt?.rc_used };
      },
      { addr: keys.address, op },
    ),
  );
  check("sendTransaction returns an id and receipt", sent.ok && /^0x1220/.test(sent.v.id) && sent.v.signatures?.length === 1, sent.ok ? sent.v.id : `${sent.e} | ${(sent.text || "").replace(/\s+/g, " ").slice(0, 400)}`);
  const entry = Buffer.from(sent.v.signatures[0], "base64url");
  check("the signature entry is the 3733-byte native ML-DSA-44 form", entry.length === 3733 && entry[0] === 0x01, `${entry.length} bytes`);
  const block = await chain.waitMined(sent.v.id, 60_000);
  check("the devnet mined it", !!block, `block ${block}, rc used ${sent.v.rcUsed}`);
  const recipientAfter = await chain.balance(RECIPIENT);
  check("1 KOIN arrived", recipientAfter - recipientBefore === ONE_KOIN, `${formatKoin(recipientBefore)} -> ${formatKoin(recipientAfter)}`);

  // ---------- attacks from the 2026-10-18 security review: each must fail ----------
  console.log("\nsecurity checks");
  const tenth = callContractOperation(net.koin, TOKEN_ENTRY.transfer, encodeTransferArgs(keys.address, RECIPIENT, ONE_KOIN / 10n));

  // 1. the page sends its own transaction id next to harmless-looking operations
  const forged = "0x1220" + "ab".repeat(32);
  const st = await withApproval(
    signer(async ({ addr, op, forged }) => {
      const tx = await window.kondor.getSigner(addr).signTransaction({ id: forged, header: { rc_limit: "1500000" }, operations: [op] });
      return { id: tx.id, header: tx.header, signatures: tx.signatures };
    }, { addr: keys.address, op: tenth, forged }),
  );
  const recomputed = st.ok ? Transaction.computeTransactionId(st.v.header) : null;
  const stEntry = st.ok ? new Uint8Array(Buffer.from(st.v.signatures[0], "base64url")) : new Uint8Array(0);
  check(
    "a page-supplied transaction id is ignored; the wallet signs the id of what it showed",
    st.ok && st.v.id !== forged && st.v.id === recomputed && verifyEntry(stEntry, st.v.id, keys.publicKey, "native") && !verifyEntry(stEntry, forged, keys.publicKey, "native"),
    st.ok ? `signed ${st.v.id.slice(0, 18)}…, not ${forged.slice(0, 18)}…` : st.e,
  );

  // 2. raw hash signing
  const sh = await withApproval(signer(async (addr) => Array.from(await window.kondor.getSigner(addr).signHash(new Uint8Array(32).fill(7))), keys.address));
  check("raw hash signing is refused", !sh.ok && /refused/.test(sh.e) && /Raw hash signing is turned off/.test(sh.text), sh.e);

  // 3. markup smuggled in an operation field
  const markup = { call_contract: { contract_id: net.koin, entry_point: '<img src=x><h1>Send 0.1 KOIN</h1>', args: "" } };
  const inj = await withApproval(signer(({ addr, op }) => window.kondor.getSigner(addr).signTransaction({ operations: [op] }), { addr: keys.address, op: markup }));
  check("markup in an operation is refused, never rendered", !inj.ok && /refused/.test(inj.e) && /malformed entry point/.test(inj.text) && !/Send 0\.1 KOIN/.test(inj.text), inj.e);

  // 4. a call to the account's own contract (could replace its key)
  const own = { call_contract: { contract_id: keys.address, entry_point: 0x4cc6c61b, args: "" } };
  const ownR = await withApproval(signer(({ addr, op }) => window.kondor.getSigner(addr).signTransaction({ operations: [op] }), { addr: keys.address, op: own }));
  check("a call to the wallet's own account contract is refused", !ownR.ok && /refused/.test(ownR.e) && /own contract/.test(ownR.text), ownR.e);

  // 5. a contract upload
  const up = { upload_contract: { contract_id: keys.address, bytecode: "AGFzbQEAAAA" } };
  const upR = await withApproval(signer(({ addr, op }) => window.kondor.getSigner(addr).signTransaction({ operations: [op] }), { addr: keys.address, op: up }));
  check("a contract upload is refused", !upR.ok && /refused/.test(upR.e) && /only contract calls/.test(upR.text), upR.e);

  // 6. a transaction for another chain while the wallet is on the devnet
  const otherChain = Buffer.from(randomBytes(34)).toString("base64url");
  const cid = await withApproval(signer(({ addr, op, cid }) => window.kondor.getSigner(addr).signTransaction({ header: { chain_id: cid, rc_limit: "1500000", nonce: "KAE" }, operations: [op] }), { addr: keys.address, op: tenth, cid: otherChain }));
  check("a transaction for a different chain is refused", !cid.ok && /refused/.test(cid.e) && /different network/.test(cid.text), cid.e);

  // 7. a transfer with every field twice: the screen must not show the first pair while the chain uses the last
  const dupArgs = Buffer.concat([Buffer.from(encodeTransferArgs(keys.address, RECIPIENT, ONE_KOIN / 10n)), Buffer.from(encodeTransferArgs(keys.address, "1BRmrUgtSQVUggoeE9weG4f7nidyydnYfQ", 40n * ONE_KOIN))]).toString("base64url");
  const dup = { call_contract: { contract_id: net.koin, entry_point: TOKEN_ENTRY.transfer, args: dupArgs } };
  const dupR = await withApproval(signer(({ addr, op }) => window.kondor.getSigner(addr).signTransaction({ header: { rc_limit: "1500000" }, operations: [op] }), { addr: keys.address, op: dup }), "reject");
  check("a transfer with duplicated fields is flagged, not shown as a plain transfer", /Unusual KOIN transfer encoding/.test(dupR.text) && !/Send 0\.1/.test(dupR.text) && !dupR.ok, dupR.text.split("\n").find((l) => /Unusual/.test(l)) ?? dupR.e);

  // 8. closing the window with its own close button counts as a rejection
  const closed = await withApproval(signer(() => window.kondor.getAccounts()), "close");
  check("closing the approval window rejects the request", !closed.ok && /rejected by the user/.test(closed.e), closed.e);

  // 9. a flood: one window at a time, at most three waiting per site
  const many = [0, 1, 2, 3].map(() => dapp.evaluate(() => window.kondor.getAccounts()).then(() => ({ ok: true }), (e) => ({ ok: false, e: e.message })));
  const openCounts = [];
  for (let i = 0; i < 3; i++) {
    const w = await nextWindow();
    await w.waitForSelector("form[data-form=approve]", { timeout: 30_000 });
    openCounts.push(context.pages().filter((p) => p.url().includes("approve.html") && !p.isClosed()).length);
    await w.click("[data-reject]");
  }
  const outcomes = await Promise.all(many);
  check(
    "a burst of requests: one window at a time, the fourth refused straight away",
    openCounts.every((n) => n === 1) && outcomes.filter((r) => !r.ok && /too many/.test(r.e)).length === 1 && outcomes.filter((r) => !r.ok && /rejected/.test(r.e)).length === 3,
    `windows open at once: ${openCounts.join(",")}`,
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n${failed.length} OF ${results.length} EXTENSION CHECKS FAILED`);
    process.exitCode = 1;
  } else console.log(`\nALL ${results.length} EXTENSION CHECKS PASSED`);
} finally {
  await context.close().catch(() => {});
  server.close();
  blocks.kill();
}
