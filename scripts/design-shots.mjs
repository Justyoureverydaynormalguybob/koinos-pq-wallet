// Screenshots of the static design screens in design/ at phone width, light and dark, so they can be
// looked at without a phone. Needs the Playwright install from memorymantle-premier (see stack notes).
//   PLAYWRIGHT_DIR=../memorymantle-premier node scripts/design-shots.mjs [outDir]
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync, readdirSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(root, process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier", "node_modules/playwright"));
const out = resolve(process.argv[2] ?? resolve(root, "design", "shots"));
mkdirSync(out, { recursive: true });

const files = readdirSync(resolve(root, "design")).filter((f) => f.endsWith(".html")).sort();
const browser = await chromium.launch({ headless: true });
let problems = 0;
for (const scheme of ["light", "dark"]) {
  for (const f of files) {
    const wide = f.startsWith("popup") ? 400 : 360;
    const page = await browser.newPage({ viewport: { width: wide, height: 740 }, colorScheme: scheme });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(pathToFileURL(resolve(root, "design", f)).href);
    await page.evaluate(() => document.fonts.ready);
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scrollW > wide) { problems++; console.log(`${f} (${scheme}): horizontal scroll, ${scrollW}px wide`); }
    for (const e of errors) { problems++; console.log(`${f} (${scheme}): ${e}`); }
    // what the phone shows first, then the whole page with the fixed bars taken out of the flow
    await page.screenshot({ path: resolve(out, `${f.replace(".html", "")}-${scheme}.png`) });
    await page.addStyleTag({ content: ".tabs, .sheet, .scrim { position: static !important; }" });
    await page.screenshot({ path: resolve(out, `${f.replace(".html", "")}-${scheme}-full.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();
console.log(`${files.length} screens x 2 schemes -> ${out}${problems ? `, ${problems} problem(s)` : ""}`);
process.exit(problems ? 1 : 0);
