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
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Chain, NETWORKS, TOKEN_ENTRY, callContractOperation, deriveKeys, encodeTransferArgs, formatKoin } from "koinos-pq-core";
import { encryptVault } from "../src/core/vault.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const pwDir = resolve(here, "..", process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier");
const { chromium } = require(resolve(pwDir, "node_modules/playwright"));
const pqDir = resolve(here, "..", process.env.KOINOS_PQ_DIR ?? "../koinos-pq");
const ext = resolve(here, "../dist-extension");
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
  if (!ok) throw new Error(`check failed: ${name} ${detail}`);
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

  /** Runs a page action that needs approval, then approves or rejects it in the wallet window. */
  async function withApproval(action, decide = "approve") {
    const popupP = context.waitForEvent("page", { timeout: 30_000 });
    const resultP = action().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.message || String(e) }));
    const w = await popupP;
    await w.waitForSelector("form[data-form=approve]", { timeout: 30_000 });
    if (decide === "approve") {
      await w.fill("input[name=passphrase]", PASS);
      await w.click("button[type=submit]");
    } else {
      await w.click("[data-reject]");
    }
    return resultP;
  }

  const accounts = await withApproval(() => dapp.evaluate(() => window.kondor.getAccounts()));
  check("getAccounts after approval lists the post-quantum address", accounts.ok && accounts.v.some((a) => a.address === keys.address), JSON.stringify(accounts.v ?? accounts.e));

  const head = await dapp.evaluate(() => window.kondor.getProvider("devnet").getHeadInfo());
  check("provider calls go through the background to the devnet", Number(head?.head_topology?.height) > 0, `height ${head?.head_topology?.height}`);

  const rejected = await withApproval(() => dapp.evaluate(() => window.kondor.getAccounts()), "reject");
  check("a rejected request errors in the page", !rejected.ok && /rejected by the user/.test(rejected.e), rejected.e);

  const sig = await withApproval(() => dapp.evaluate(async (addr) => Array.from(await window.kondor.getSigner(addr).signMessage("hello from a dapp")).length, keys.address));
  check("signMessage returns a 3733-byte native ML-DSA-44 entry", sig.ok && sig.v === 3733, String(sig.v ?? sig.e));

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
  check("sendTransaction returns an id and receipt", sent.ok && /^0x1220/.test(sent.v.id) && sent.v.signatures?.length === 1, sent.ok ? sent.v.id : sent.e);
  const entry = Buffer.from(sent.v.signatures[0], "base64url");
  check("the signature entry is the 3733-byte native ML-DSA-44 form", entry.length === 3733 && entry[0] === 0x01, `${entry.length} bytes`);
  const block = await chain.waitMined(sent.v.id, 60_000);
  check("the devnet mined it", !!block, `block ${block}, rc used ${sent.v.rcUsed}`);
  const recipientAfter = await chain.balance(RECIPIENT);
  check("1 KOIN arrived", recipientAfter - recipientBefore === ONE_KOIN, `${formatKoin(recipientBefore)} -> ${formatKoin(recipientAfter)}`);

  console.log(`\nALL ${results.length} EXTENSION CHECKS PASSED`);
} finally {
  await context.close().catch(() => {});
  server.close();
  blocks.kill();
}
