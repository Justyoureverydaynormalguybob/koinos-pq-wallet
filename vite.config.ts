/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: "./", // static site, servable from any path
  build: {
    target: "es2022",
    sourcemap: false,
    // the wallet, and the test dapp at /demo/ (uses window.kondor from the extension, no library)
    rollupOptions: { input: { main: "index.html", demo: "demo/index.html" } },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
