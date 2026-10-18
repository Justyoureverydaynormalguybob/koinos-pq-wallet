/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // static site, servable from any path
  build: { target: "es2022", sourcemap: false },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
