// Extension build, part 1 of 3: the HTML pages (wallet, popup, approval) and the background
// service worker as ES modules, plus everything in extension/ (manifest, icons) copied as-is.
// Output: dist-extension/. Parts 2 and 3 (content.js, inpage.js) are single-file IIFE builds.
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: "./",
  publicDir: "extension",
  build: {
    outDir: "dist-extension",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: {
        index: `${here}index.html`,
        popup: `${here}popup.html`,
        approve: `${here}approve.html`,
        background: `${here}src/ext/background.ts`,
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
