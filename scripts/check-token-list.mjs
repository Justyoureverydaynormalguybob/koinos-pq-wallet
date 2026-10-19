// Checks src/data/tokens.*.json against the chain: for every entry, reads name, symbol and decimals from
// the contract and reports any difference, plus the chain id of the node answering. Run before changing
// a list, and after; the lists must say what the chain says.
//   node scripts/check-token-list.mjs            # both networks
//   node scripts/check-token-list.mjs mainnet    # one network (mainnet | testnet | harbinger)
//   node scripts/check-token-list.mjs --fix      # rewrite the files with the chain's answers
import { readFileSync, writeFileSync } from "node:fs";
import { Chain, NETWORKS, TOKEN_ENTRY, decodeStringResult, decodeDecimalsResult, decodeUint64Result } from "koinos-pq-core";

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const only = args.find((a) => !a.startsWith("--"));
const FILES = { mainnet: "src/data/tokens.mainnet.json", testnet: "src/data/tokens.harbinger.json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// api.koinos.io answers HTML when asked too fast; one read at a time, with a pause and a retry
async function readSlow(chain, address, entry) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await chain.read(address, entry);
      await sleep(150);
      return r;
    } catch (e) {
      const msg = String(e.message ?? e);
      if (attempt < 4 && /invalid json|<html|429|503/i.test(msg)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

let problems = 0;
for (const [net, file] of Object.entries(FILES)) {
  if (only && only !== net && !(only === "harbinger" && net === "testnet")) continue;
  const list = JSON.parse(readFileSync(file, "utf8"));
  const chain = new Chain(NETWORKS[net]);
  const chainId = await chain.provider.getChainId();
  if (chainId !== list.chainId) {
    problems++;
    console.log(`${file}: chainId ${list.chainId} but the node says ${chainId}`);
    if (fix) list.chainId = chainId;
  }
  const seen = new Set();
  for (const t of list.tokens) {
    if (seen.has(t.address)) {
      problems++;
      console.log(`${file}: ${t.address} listed twice`);
    }
    seen.add(t.address);
    let name, symbol, decimals;
    try {
      name = decodeStringResult(await readSlow(chain, t.address, TOKEN_ENTRY.name));
      symbol = decodeStringResult(await readSlow(chain, t.address, TOKEN_ENTRY.symbol));
      decimals = decodeDecimalsResult(await readSlow(chain, t.address, TOKEN_ENTRY.decimals));
      // a contract that answers name/symbol but cannot read its own state is a stale copy (mainnet KOIN and
      // VHP both moved; the old addresses fail with "user code cannot access system space")
      decodeUint64Result(await readSlow(chain, t.address, TOKEN_ENTRY.total_supply));
    } catch (e) {
      problems++;
      console.log(`${file}: ${t.symbol} ${t.address}: read failed: ${String(e.message ?? e).slice(0, 100)}`);
      continue;
    }
    if (!name || !symbol) {
      problems++;
      console.log(`${file}: ${t.address} answers no name/symbol (not a KCS-4 token?)`);
      continue;
    }
    const diffs = [];
    if (name !== t.name) diffs.push(`name "${t.name}" -> "${name}"`);
    if (symbol !== t.symbol) diffs.push(`symbol "${t.symbol}" -> "${symbol}"`);
    if (decimals !== t.decimals) diffs.push(`decimals ${t.decimals} -> ${decimals}`);
    if (diffs.length) {
      problems++;
      console.log(`${file}: ${t.address}: ${diffs.join(", ")}`);
      if (fix) Object.assign(t, { name, symbol, decimals });
    }
  }
  if (fix) {
    list.checked = new Date().toISOString().slice(0, 10);
    writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
  }
  console.log(`${file}: ${list.tokens.length} tokens checked against ${NETWORKS[net].rpc[0]}`);
}
if (problems && !fix) {
  console.log(`${problems} problem(s); run with --fix to take the chain's answers`);
  process.exit(1);
}
