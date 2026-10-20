// Renders the app mark with headless Chromium: an ink square, "PQ" in Archivo at its widest in paper,
// and a single signal pixel (the plan's icon). Outputs:
//   extension/icons/{16,32,48,128}.png   (manifest.json)
//   public/icons/{32,192,512}.png        (favicon and the web manifest)
//   assets/icon-only.png, icon-foreground.png, icon-background.png (1024), splash.png, splash-dark.png (2732)
//                                        (sources for `npx @capacitor/assets generate`, see docs/STORE.md)
//
//   PLAYWRIGHT_DIR=../memorymantle-premier node scripts/make-icons.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(root, process.env.PLAYWRIGHT_DIR ?? "../memorymantle-premier", "node_modules/playwright"));

const INK = "#0f0f0e", PAPER = "#e9e6df", SIGNAL = "#ff4a1c";
// inlined: a page set with setContent() has no origin, so a file:// font would not load
const font = `data:font/woff2;base64,${readFileSync(resolve(root, "src/ui/fonts/archivo-latin.woff2")).toString("base64")}`;
void pathToFileURL;
const css = `@font-face { font-family: Archivo; font-weight: 100 900; font-stretch: 62% 125%; src: url("${font}") format("woff2"); }
  html, body { margin: 0; background: transparent; }`;

/** The mark at `s` px: the square (or transparent, for the adaptive foreground), the letters, the pixel. */
const mark = (s, { square = true, radius = 0.18, scale = 1, color = PAPER } = {}) => {
  const size = Math.round(s * scale), off = Math.round((s - size) / 2);
  const fs = Math.round(size * 0.46), px = Math.max(1, Math.round(size * 0.07));
  return `<div style="position:absolute;left:${off}px;top:${off}px;width:${size}px;height:${size}px;border-radius:${square ? Math.round(size * radius) : 0}px;background:${square ? INK : "transparent"};overflow:hidden">
    <span style="position:absolute;left:0;right:0;top:50%;transform:translateY(-54%);text-align:center;font:900 ${fs}px/1 Archivo;font-stretch:125%;letter-spacing:-0.04em;color:${color}">PQ</span>
    <span style="position:absolute;right:${Math.round(size * 0.16)}px;bottom:${Math.round(size * 0.16)}px;width:${px}px;height:${px}px;background:${SIGNAL}"></span>
  </div>`;
};
const page_ = (s, inner, bg = "transparent") => `<!doctype html><html><head><style>${css}</style></head><body style="background:${bg}"><div style="position:relative;width:${s}px;height:${s}px">${inner}</div></body></html>`;

const jobs = [
  ...[16, 32, 48, 128].map((s) => ({ path: `extension/icons/${s}.png`, size: s, html: page_(s, mark(s)) })),
  ...[32, 192, 512].map((s) => ({ path: `public/icons/${s}.png`, size: s, html: page_(s, mark(s)) })),
  // Android adaptive icons keep the middle 66%: the letters sit inside that; the background is the plain ink
  { path: "assets/icon-only.png", size: 1024, html: page_(1024, mark(1024, { radius: 0 })) },
  { path: "assets/icon-foreground.png", size: 1024, html: page_(1024, mark(1024, { square: false, scale: 0.66 })) },
  { path: "assets/icon-background.png", size: 1024, html: page_(1024, `<div style="width:1024px;height:1024px;background:${INK}"></div>`) },
  { path: "assets/splash.png", size: 2732, html: page_(2732, mark(2732, { scale: 0.18 }), PAPER) },
  { path: "assets/splash-dark.png", size: 2732, html: page_(2732, `<div style="position:absolute;inset:0;background:${INK}"></div>${mark(2732, { square: false, scale: 0.18 })}`, INK) },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const j of jobs) {
  mkdirSync(resolve(root, j.path, ".."), { recursive: true });
  await page.setViewportSize({ width: j.size, height: j.size });
  await page.setContent(j.html);
  await page.evaluate(() => document.fonts.ready);
  const transparent = !/splash/.test(j.path);
  await page.screenshot({ path: resolve(root, j.path), omitBackground: transparent, clip: { x: 0, y: 0, width: j.size, height: j.size } });
  console.log(j.path);
}
await browser.close();
