// Extension build, part 2 of 3: the content script as one classic (non-module) file.
import { defineConfig } from "vite";

export default defineConfig({
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
