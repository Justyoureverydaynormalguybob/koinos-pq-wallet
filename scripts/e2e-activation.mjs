// End-to-end check of hands-free account activation in the web wallet, on the private devnet.
//
// A brand-new wallet opens the activation screen on the seed's own account address. The test then
// clicks nothing: once the address has enough mana the wallet must install the contract, register the
// key and say "Account ready" by itself. (The devnet's test KOIN gives every address mana; the live-network
// half, waiting for funds, is checked by scripts/smoke-web.mjs.) Then the account is checked on chain,
// shown as "Your account", funded, and a 1 KOIN transfer is sent from it through the UI and mined.
//
// Needs: the web app served (npm run build && vite preview, port 4173), the devnet up
// (koinos-pq: docker compose -f devnet/docker-compose.yml up -d && node devnet/run.mjs), Playwright.
//
//   PLAYWRIGHT_DIR=../memorymantle-premier KOINOS_PQ_DIR=../koinos-pq node --experimental-strip-types scripts/e2e-activation.mjs [url]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Chain, NETWORKS, bootstrapAddress, deriveKeys, formatKoin } from "koinos-pq-core";
import { encryptVault } from "../src/core/vault.ts";
import { detectAccount } from "../src/core/accounts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(here, "..", process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier", "node_modules/playwright"));
const pqDir = resolve(here, "..", process.env.KOINOS_PQ_DIR ?? "../koinos-pq");
const url = process.argv[2] ?? "http://127.0.0.1:4173/";
const PASS = "activation-e2e-passphrase";
const RECIPIENT = "1Hdt37BAtLnsssHvzj2Yo5r3YsCCY3Fatn"; // devnet genesis account
const chain = new Chain(NETWORKS.devnet);
const ONE_KOIN = 100_000_000n;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) throw new Error(`check failed: ${name} ${detail}`);
}
function run(args) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { cwd: pqDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`${args.join(" ")} exited ${code}: ${out}`))));
  });
}

const blocks = spawn(process.execPath, ["devnet/auto-blocks.mjs", "--always"], { cwd: pqDir, stdio: "ignore" });
process.on("exit", () => blocks.kill());

const seed = new Uint8Array(randomBytes(32));
const keys = deriveKeys(seed);
const account = bootstrapAddress(keys);
const vault = await encryptVault({ version: 1, seedHex: bytesToHex(seed), accounts: [], createdAt: new Date().toISOString() }, PASS);
console.log(`new wallet; its account address: ${account}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const problems = [];
page.on("pageerror", (e) => problems.push(e.message));
try {
  await page.goto(url);
  await page.evaluate((v) => {
    localStorage.setItem("koinos-pq-wallet/vault", v);
    localStorage.setItem("koinos-pq-wallet/network", "devnet");
  }, JSON.stringify(vault));
  await page.reload();
  await page.fill('form[data-form="unlock"] input[name="passphrase"]', PASS);
  await page.click('form[data-form="unlock"] button[type="submit"]');
  await page.waitForSelector(".stats", { timeout: 30_000 });
  await page.click('[data-action="settings"]');
  const t0 = Date.now();
  await page.click('[data-action="setup"]');
  // The devnet's test KOIN gives every address 100 mana, so here the wallet has enough at once and starts
  // by itself. On Harbinger and mainnet a new address has none, and scripts/smoke-web.mjs checks that the
  // screen then waits, asking for the amount, without starting anything.
  await page.waitForFunction(() => /Activating your account|Account ready/.test(document.querySelector("h1")?.textContent ?? ""), null, { timeout: 45_000 });
  const shown = await page.$eval("code.address", (e) => e.textContent?.trim());
  check("activation runs on the seed's own account address", shown === account, shown);
  await page.waitForFunction(() => /Account ready/.test(document.querySelector("h1")?.textContent ?? ""), null, { timeout: 240_000 });
  check("the wallet activated the account by itself, no clicks", true, `${Math.round((Date.now() - t0) / 1000)} s`);

  const ready = (await page.innerText(".card")).replace(/\s+/g, " ");
  check("the ready screen reports a single activation transaction", /in one transaction/.test(ready), ready.slice(0, 160));
  const found = await detectAccount(chain, keys);
  const nonce = Number(await chain.provider.getNonce(account));
  check("on chain: contract installed, this wallet's key registered, in one transaction (nonce 1)", found === account && nonce === 1, `nonce ${nonce}`);

  await page.click('[data-action="setup-done"]');
  await page.waitForFunction(() => /Your account/.test(document.querySelector(".hero .label")?.textContent ?? ""), null, { timeout: 30_000 });
  const label = await page.$eval(".hero .label", (e) => e.textContent?.trim());
  check("home shows it as \"Your account\"", /^Your account · devnet$/.test(label ?? ""), label);

  await run(["devnet/mint.mjs", account, "10"]);
  for (let i = 0; i < 30 && (await chain.balance(account)) < 10n * ONE_KOIN; i++) await new Promise((r) => setTimeout(r, 1000));
  const before = await chain.balance(RECIPIENT);
  await page.click('[data-action="send"]');
  await page.fill('form[data-form="send"] input[name="to"]', RECIPIENT);
  await page.fill('form[data-form="send"] input[name="amount"]', "1");
  await page.click('form[data-form="send"] button[type="submit"]');
  // the wallet says "Submitted" on the devnet (blocks come from auto-blocks.mjs, not a producer it can wait on)
  await page.waitForFunction(() => /Mined|Submitted|waiting for a block/.test(document.querySelector("h1")?.textContent ?? "") || !!document.querySelector(".error"), null, { timeout: 120_000 });
  const err = await page.$eval(".error", (e) => e.textContent).catch(() => null);
  if (err) throw new Error(`send failed in the wallet: ${err}`);
  const bytes = (await page.innerText(".card")).match(/Signature entry (\d+) bytes/)?.[1];
  let after = before;
  for (let i = 0; i < 60 && after === before; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    after = await chain.balance(RECIPIENT);
  }
  check("1 KOIN sent from the new account with a 2,420-byte signature and mined", after - before === ONE_KOIN && bytes === "2420", `${formatKoin(before)} -> ${formatKoin(after)}, entry ${bytes} bytes`);
  check("no page errors", problems.length === 0, problems.join("; "));
  console.log(`\nALL ${results.length} ACTIVATION CHECKS PASSED`);
} finally {
  await browser.close();
  blocks.kill();
}
