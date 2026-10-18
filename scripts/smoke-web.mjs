// Browser smoke test of the built web wallet with its Content-Security-Policy in force (no eval), on
// testnet and mainnet, at phone width:
//   - a throwaway new wallet must land on "Activate your account", showing the seed's own account
//     address and a price read from the live resource market;
//   - a wallet holding the live account 1LQY… (stored under the old "(testnet)" label) must open on
//     its balance, mana and head block, labelled "Your account";
// with no CSP violation, page error or horizontal scroll. Run against `vite preview` (port 4173) or the live site.
//
//   PLAYWRIGHT_DIR=../memorymantle-premier node --experimental-strip-types scripts/smoke-web.mjs [url]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { bootstrapAddress, deriveKeys } from "koinos-pq-core";
import { encryptVault } from "../src/core/vault.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(here, "..", process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier", "node_modules/playwright"));
const url = process.argv[2] ?? "http://127.0.0.1:4173/";
const PASS = "web-smoke-passphrase";

const seed = new Uint8Array(randomBytes(32));
const keys = deriveKeys(seed);
const vault = await encryptVault({ version: 1, seedHex: bytesToHex(seed), accounts: [], createdAt: new Date().toISOString() }, PASS);
const bootstrap = bootstrapAddress(keys);
// the live account's key is not ours, but the home screen only reads public balances for it
const vaultWithAccount = await encryptVault(
  { version: 1, seedHex: bytesToHex(seed), accounts: [{ label: "pqwallet account (testnet)", mode: "pqwallet", address: "1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ" }], createdAt: new Date().toISOString() },
  PASS,
);

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
  const unlockWith = async (v, network) => {
    await page.evaluate(({ v, n }) => {
      localStorage.setItem("koinos-pq-wallet/vault", v);
      localStorage.setItem("koinos-pq-wallet/network", n);
    }, { v, n: network });
    await page.reload();
    await page.fill('form[data-form="unlock"] input[name="passphrase"]', PASS);
    await page.click('form[data-form="unlock"] button[type="submit"]');
  };
  const checkWidth = async (what) => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (wide) problems.push(`${what}: page wider than 360px`);
  };
  for (const network of ["testnet", "mainnet"]) {
    // a brand-new wallet lands on "Activate your account", priced from the live resource market
    await unlockWith(JSON.stringify(vault), network);
    await page.waitForFunction(() => {
      const h = document.querySelector("h1")?.textContent ?? "";
      const mana = document.querySelector("#setup-mana")?.textContent ?? "";
      return /Activate your account/.test(h) && /Mana now/.test(mana) && !/checking/.test(mana);
    }, null, { timeout: 45_000 });
    const shown = await page.$eval("code.address", (e) => e.textContent?.trim());
    const need = await page.$eval("#setup-mana", (e) => e.textContent?.trim());
    if (shown !== bootstrap) throw new Error(`${network}: activation shows ${shown}, expected the seed's account ${bootstrap}`);
    console.log(`PASS  ${network}: a new wallet goes straight to activation (${need})`);
    // unfunded, it must wait: past the next mana poll (every 6 s) it is still asking, nothing submitted
    await page.waitForTimeout(8_000);
    const still = await page.$eval("h1", (e) => e.textContent?.trim());
    if (still !== "Activate your account") throw new Error(`${network}: an unfunded wallet moved on to "${still}"`);
    console.log(`PASS  ${network}: unfunded, it waits and submits nothing`);
    await checkWidth(`${network} activation`);

    // a wallet holding the live account (saved under the old "(testnet)" label) opens on its balance
    await unlockWith(JSON.stringify(vaultWithAccount), network);
    await page.waitForFunction(() => {
      const cells = [...document.querySelectorAll(".stats strong")].map((e) => e.textContent?.trim());
      return cells.length === 3 && cells.every((c) => c && !c.startsWith("…"));
    }, null, { timeout: 45_000 });
    const cells = await page.$$eval(".stats strong", (els) => els.map((e) => e.textContent?.trim()));
    const label = await page.$eval(".hero .label", (e) => e.textContent?.trim());
    if (!/^Your account/.test(label ?? "") || /\(testnet\)/.test(label ?? "")) throw new Error(`${network}: account label is "${label}"`);
    console.log(`PASS  ${network}: ${label}, balance ${cells[0]}, mana ${cells[1]}, head ${cells[2]}`);
    await checkWidth(`${network} home`);
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
