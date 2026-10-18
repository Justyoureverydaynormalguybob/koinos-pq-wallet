// Writes dist/version.json after a build, so /version.json on the live site says what is deployed.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
let commit = process.env.RAILWAY_GIT_COMMIT_SHA || null;
if (!commit) {
  try {
    commit = execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    commit = null;
  }
}
const out = { name: pkg.name, version: pkg.version, commit, builtAt: new Date().toISOString() };
writeFileSync(resolve(root, "dist", "version.json"), JSON.stringify(out) + "\n");
console.log(`dist/version.json: ${JSON.stringify(out)}`);
