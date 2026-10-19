// Extension build, part 2 of 3: the content script as one classic (non-module) file.
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  publicDir: false,
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: "dist-extension",
    emptyOutDir: false,
    target: "es2022",
    sourcemap: false,
    lib: { entry: "src/ext/content.ts", formats: ["iife"], name: "koinosPqContent", fileName: () => "content.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
