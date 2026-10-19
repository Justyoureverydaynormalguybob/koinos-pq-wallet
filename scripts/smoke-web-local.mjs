// Serves dist/ with `vite preview` and runs the web smoke test against it, then stops the server.
//   npm run build && node scripts/smoke-web-local.mjs
// PORT=<n> picks the preview port (default 4173); SHOTS=<dir> also saves screenshots of the activation and home screens (see smoke-web.mjs).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const port = process.env.PORT ?? "4173";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const preview = spawn(npx, ["vite", "preview", "--host", "127.0.0.1", "--port", port, "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
let ready = false;
preview.stdout.on("data", (d) => {
  if (String(d).includes(port)) ready = true;
});
preview.stderr.on("data", (d) => process.stderr.write(d));
const deadline = Date.now() + 30_000;
while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
if (!ready) {
  preview.kill();
  throw new Error("vite preview did not start");
}
const smoke = spawn(process.execPath, ["--experimental-strip-types", resolve(root, "scripts/smoke-web.mjs"), `http://127.0.0.1:${port}/`], { cwd: root, stdio: "inherit", env: process.env });
const code = await new Promise((r) => smoke.on("exit", r));
// vite preview spawns its own node under a shell on Windows; kill the tree
if (process.platform === "win32") spawn("taskkill", ["/pid", String(preview.pid), "/t", "/f"], { stdio: "ignore" });
else preview.kill();
process.exit(code ?? 1);
