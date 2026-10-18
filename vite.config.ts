/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // static site, servable from any path
  build: {
    target: "es2022",
    sourcemap: false,
    // the wallet, and the test dapp at /demo/ (uses window.kondor from the extension, no library)
    rollupOptions: { input: { main: "index.html", demo: "demo/index.html" } },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
