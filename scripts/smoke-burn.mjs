// Browser check of "Burn KOIN for VHP" in the built web wallet, at phone width, with the CSP in force, on
// Harbinger: a wallet holding a real pqwallet test account opens the burn screen (no horizontal scroll, no
// CSP violation, no page error) and, with --send, burns the amount through the screen and reports what the
// node said. Run against `vite preview` (port 4173).
//
//   PQ_KEYFILE=../koinos-pq/.keys.testnet.json PLAYWRIGHT_DIR=../memorymantle-premier \
//     node --experimental-strip-types scripts/smoke-burn.mjs [--send 1] [--shots <dir>] [url]
//
// The key file is a koinos-pq CLI one in plain text (a testnet account; never a mainnet one).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { encryptVault } from "../src/core/vault.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(here, "..", process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier", "node_modules/playwright"));
const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const send = take("--send"), shots = take("--shots");
const url = args[0] ?? "http://127.0.0.1:4173/";
const PASS = "burn-smoke-passphrase";

if (!process.env.PQ_KEYFILE) throw new Error("set PQ_KEYFILE to a plain-text testnet key file from the koinos-pq CLI");
const k = JSON.parse(readFileSync(process.env.PQ_KEYFILE, "utf8"));
if (k.network !== "testnet") throw new Error("this script only runs with a testnet key file");
if (!k.pq?.seedHex) throw new Error("the key file is encrypted; this script needs a plain-text testnet one");
const account = k.contractId ?? k.account.address;
const vault = await encryptVault({ version: 1, seedHex: k.pq.seedHex, accounts: [{ label: "pqwallet account", mode: "pqwallet", address: account }], createdAt: new Date().toISOString() }, PASS);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
const problems = [];
page.on("console", (m) => {
  // WalletConnect's usage telemetry is not on the CSP's connect list on purpose; the browser logs each refusal
  if (/pulse.walletconnect.org/.test(m.text())) return;
  if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(`console ${m.type()}: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
const checkWidth = async (what) => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (wide) problems.push(`${what}: page wider than 360px`);
};
const shot = async (name) => {
  if (shots) await page.screenshot({ path: resolve(shots, `${name}.png`), fullPage: true });
};

try {
  await page.goto(url);
  await page.evaluate(({ v }) => {
    localStorage.setItem("koinos-pq-wallet/vault", v);
    localStorage.setItem("koinos-pq-wallet/network", "testnet");
    localStorage.setItem("koinos-pq-wallet/lang", "en");
  }, { v: JSON.stringify(vault) });
  await page.reload();
  await page.fill('form[data-form="unlock"] input[name="passphrase"]', PASS);
  await page.click('form[data-form="unlock"] button[type="submit"]');
  await page.waitForSelector('[data-action="burn"]', { timeout: 60_000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector("#home-mana")?.textContent ?? ""), null, { timeout: 60_000 });
  await checkWidth("home");
  await shot("burn-1-home");
  console.log(`home: ${(await page.textContent("#home-balance"))?.replace(/\s+/g, " ").trim()}, mana ${await page.textContent("#home-mana")}`);

  await page.click('[data-action="burn"]');
  await page.waitForSelector('form[data-form="burn"]');
  await checkWidth("burn");
  await shot("burn-2-form");
  console.log(`burn screen: "${await page.textContent("h1")}", most you can burn now: ${await page.textContent("#burn-most")}`);

  if (send) {
    await page.fill('form[data-form="burn"] input[name="amount"]', send);
    await page.check('form[data-form="burn"] input[name="understood"]');
    await page.click('form[data-form="burn"] button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form[data-form="burn"]') || document.querySelector(".notice.danger"), null, { timeout: 120_000 });
    await checkWidth("after burn");
    await shot("burn-3-result");
    const h1 = await page.textContent("h1");
    const tx = await page.locator("code.address").first().textContent().catch(() => null);
    const err = await page.locator(".notice.danger").first().textContent().catch(() => null);
    console.log(`after submit: "${h1}"${tx ? `, tx ${tx.trim()}` : ""}${err ? `, notice: ${err.trim().slice(0, 300)}` : ""}`);
    if (!/Burned|Mined|Submitted/.test(h1 ?? "")) problems.push(`the burn did not go through: ${h1}`);
  }
} catch (e) {
  problems.push(`script: ${String(e.message ?? e).slice(0, 300)}`);
  await shot("burn-error");
} finally {
  await browser.close();
}
if (problems.length) {
  console.log("PROBLEMS:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("OK: no CSP violation, page error or horizontal scroll at 360px");
