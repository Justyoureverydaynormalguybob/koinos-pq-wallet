// Several accounts from one seed, on a real chain (the private devnet): accounts 0, 1 and 2 of a new seed
// are each activated with their own key, found again from nothing but the seed, and each one moves KOIN
// only with its own key (another account's key, and the wallet's first key, are refused by the chain).
//
// Needs the devnet up (koinos-pq: docker compose -f devnet/docker-compose.yml up -d && node devnet/run.mjs).
//
//   KOINOS_PQ_DIR=../koinos-pq node --experimental-strip-types scripts/devnet-accounts.mjs
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Chain, NETWORKS, bootstrapAddress, deriveKeys, formatKoin, setupPqwalletAccount } from "koinos-pq-core";
import { accountKeys, detectAccounts, nextAccountKey } from "../src/core/accounts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const pqDir = resolve(here, "..", process.env.KOINOS_PQ_DIR ?? "../koinos-pq");
const chain = new Chain(NETWORKS.devnet);
const ONE_KOIN = 100_000_000n;
const SINK = "1Hdt37BAtLnsssHvzj2Yo5r3YsCCY3Fatn"; // devnet genesis account

let failed = false;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed = true;
}
function run(args) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { cwd: pqDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`${args.join(" ")} exited ${code}: ${out}`))));
  });
}
const blocks = spawn(process.execPath, ["devnet/auto-blocks.mjs", "--always"], { cwd: pqDir, stdio: "ignore" });
process.on("exit", () => blocks.kill());

const seed = new Uint8Array(randomBytes(32));
const master = deriveKeys(seed);
check("a new seed has no account yet", (await detectAccounts(chain, master)).length === 0);

// activate accounts 0, 1, 2 in the order a wallet would offer them
for (let round = 0; round < 3; round++) {
  const found = await detectAccounts(chain, master);
  const key = nextAccountKey(found);
  check(`the next account to create is number ${round}`, key === round, `got ${key}`);
  const keys = accountKeys(master, key);
  const result = await setupPqwalletAccount(chain, keys, () => undefined);
  check(`account ${key} activated at the address its own key gives`, result.account === bootstrapAddress(keys), result.account);
}

// the seed alone brings all three back (a fresh keys object, as after typing the 24 words on another device)
const again = deriveKeys(Uint8Array.from(seed));
const found = await detectAccounts(chain, again);
check("the seed alone finds all three accounts", JSON.stringify(found.map((f) => f.key)) === "[0,1,2]", JSON.stringify(found));
check("three different addresses", new Set(found.map((f) => f.address)).size === 3);
const [a0, a1, a2] = found.map((f) => f.address);

// fund account 1 and send from it with its own key
await run(["devnet/mint.mjs", a1, "5"]);
for (let i = 0; i < 30 && (await chain.balance(a1)) < 5n * ONE_KOIN; i++) await new Promise((r) => setTimeout(r, 1000));
check("account 1 holds the 5 KOIN minted to it", (await chain.balance(a1)) === 5n * ONE_KOIN, formatKoin(await chain.balance(a1)));
const sinkBefore = await chain.balance(SINK);
const sent = await chain.sendKoin({ from: a1, to: SINK, valueBase: ONE_KOIN, keys: accountKeys(again, 1), mode: "pqwallet" });
await chain.waitMined(sent.txId);
check("account 1 sends 1 KOIN signed with its own key", (await chain.balance(a1)) === 4n * ONE_KOIN && (await chain.balance(SINK)) - sinkBefore === ONE_KOIN, `tx ${sent.txId.slice(0, 18)}…`);

// no other key of the same wallet moves account 1
for (const [label, key] of [["the wallet's first key", 0], ["account 2's key", 2]]) {
  let refused = "";
  try {
    await chain.sendKoin({ from: a1, to: SINK, valueBase: ONE_KOIN, keys: accountKeys(again, key), mode: "pqwallet" });
  } catch (e) {
    refused = String(e.message ?? e).slice(0, 110);
  }
  check(`${label} cannot move account 1`, refused !== "", refused || "the chain accepted it");
}
check("account 1 still holds 4 KOIN", (await chain.balance(a1)) === 4n * ONE_KOIN);
console.log(`accounts: 0 ${a0}  1 ${a1}  2 ${a2}`);
console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
blocks.kill();
process.exit(failed ? 1 : 0);
