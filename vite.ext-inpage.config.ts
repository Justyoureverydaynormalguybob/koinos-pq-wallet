// Extension build, part 3 of 3: the page-world script (window.kondor) as one classic file.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  build: {
    outDir: "dist-extension",
    emptyOutDir: false,
    target: "es2022",
    sourcemap: false,
    lib: { entry: "src/ext/inpage.ts", formats: ["iife"], name: "koinosPqInpage", fileName: () => "inpage.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
