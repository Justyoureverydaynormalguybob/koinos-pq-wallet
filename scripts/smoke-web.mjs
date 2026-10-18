// Browser smoke test of the built web wallet with its Content-Security-Policy in force (no eval):
// a throwaway vault is unlocked on testnet and on mainnet, and the KOIN balance, mana and head block
// must all load with no CSP violation or page error. Run against `vite preview` (default port 4173).
//
//   PLAYWRIGHT_DIR=../memorymantle-premier node --experimental-strip-types scripts/smoke-web.mjs [url]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveKeys } from "koinos-pq-core";
import { encryptVault } from "../src/core/vault.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(here, "..", process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier", "node_modules/playwright"));
const url = process.argv[2] ?? "http://127.0.0.1:4173/";
const PASS = "web-smoke-passphrase";

const seed = new Uint8Array(randomBytes(32));
const keys = deriveKeys(seed);
const vault = await encryptVault({ version: 1, seedHex: bytesToHex(seed), accounts: [], createdAt: new Date().toISOString() }, PASS);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(`console ${m.type()}: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));

let failed = false;
try {
  await page.goto(url);
  await page.evaluate((v) => localStorage.setItem("koinos-pq-wallet/vault", v), JSON.stringify(vault));
  for (const network of ["testnet", "mainnet"]) {
    await page.evaluate((n) => localStorage.setItem("koinos-pq-wallet/network", n), network);
    await page.reload();
    await page.fill('form[data-form="unlock"] input[name="passphrase"]', PASS);
    await page.click('form[data-form="unlock"] button[type="submit"]');
    await page.waitForFunction(() => {
      const cells = [...document.querySelectorAll(".stats strong")].map((e) => e.textContent?.trim());
      return cells.length === 3 && cells.every((c) => c && c !== "…");
    }, null, { timeout: 45_000 });
    const cells = await page.$$eval(".stats strong", (els) => els.map((e) => e.textContent?.trim()));
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    console.log(`PASS  ${network}: KOIN ${cells[0]}, mana ${cells[1]}, head ${cells[2]}${wide ? "  (WARNING: horizontal scroll at 360px)" : ""}`);
    if (wide) problems.push(`${network}: page wider than 360px`);
  }
} catch (e) {
  failed = true;
  console.log(`FAIL  ${e.message.slice(0, 300)}`);
} finally {
  await browser.close();
}
if (problems.length) {
  failed = true;
  console.log("problems:");
  for (const p of problems) console.log(`  - ${p}`);
}
console.log(failed ? "WEB SMOKE FAILED" : `WEB SMOKE PASSED (account ${keys.address}, CSP without eval)`);
process.exit(failed ? 1 : 0);
