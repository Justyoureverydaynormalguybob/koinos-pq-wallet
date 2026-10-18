// Renders the icon set with headless Chromium: a navy rounded square with "PQ".
//   extension/icons/{16,32,48,128}.png   (manifest.json)
//   public/icons/{32,192,512}.png        (favicon and the web manifest)
//
//   PLAYWRIGHT_DIR=../memorymantle-premier node scripts/make-icons.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(here, "..", process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier", "node_modules/playwright"));

const targets = [
  ["extension/icons", [16, 32, 48, 128]],
  ["public/icons", [32, 192, 512]],
];
const html = (s) => `<!doctype html><html><body style="margin:0;background:transparent">
  <div style="width:${s}px;height:${s}px;border-radius:${Math.round(s * 0.22)}px;background:#0f172a;box-sizing:border-box;
              border:${Math.max(1, Math.round(s * 0.025))}px solid #475569;display:flex;align-items:center;justify-content:center">
    <span style="font:700 ${Math.round(s * 0.5)}px/1 'Segoe UI',system-ui,Arial,sans-serif;color:#fff;letter-spacing:-0.05em;margin-top:${Math.round(s * 0.02)}px">PQ</span>
  </div></body></html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [dir, sizes] of targets) {
  mkdirSync(resolve(here, "..", dir), { recursive: true });
  for (const s of sizes) {
    await page.setViewportSize({ width: s, height: s });
    await page.setContent(html(s));
    const path = resolve(here, "..", dir, `${s}.png`);
    await page.screenshot({ path, omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
    console.log(path);
  }
}
await browser.close();
