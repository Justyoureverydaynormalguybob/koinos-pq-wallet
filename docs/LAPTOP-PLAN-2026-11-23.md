# Laptop plan — 2026-11-23: pen-test write-up, repeatable attack test, 0.17.2 re-test, passphrase gate

Written on the phone for the laptop session (phone memory does not travel). Four tasks. 1–3 are the
security follow-ups from the 2026-11-22 outsider pen-test; 4 is the passphrase strength gate.

## STATUS 2026-11-23 — most of this was then done on the phone

Done and pushed (noreply): **Task 1** — SECURITY.md sections in both repos
(`koinos-pq` 4974541, wallet section in the 0.18.0 doc commit). **Task 2** — `koinos-pq/cli/attack-outsider.mjs`
(`npm run attack`), ran green against Harbinger (4fa71b5). **Task 4** — passphrase gate
`src/core/passphrase.ts` + approval-sheet authority warnings, 0.18.0, en/es/pt, tests; tsc clean, 97 pass
(wallet 647abfd). **Task 3** — re-ran on current code: verifier suite green, attacker test HELD, live web
headers + `npm audit` unchanged (all build tooling), and the new-surface review found and fixed the
approval-sheet gap (set_allowed_caller / set_public_key were opaque — now explained).

Left for the laptop (needs a browser or the signed build, or spends testnet value):
- `npm run build` + `railway up` to deploy 0.18.0, then `gh run download` the signed APK (same keystore).
- Phone note: the wallet's `node_modules/koinos-pq-core` was a stale Oct-20 install; it was rebuilt
  (`node node_modules/typescript/bin/tsc -p tsconfig.json` in `~/koinos-pq-core`) and its `dist` copied in.
  On the laptop a clean `npm install` of the git dep should pick up ec206c7; verify `burnKoin` is in
  `node_modules/koinos-pq-core/dist/chain.js` before trusting a build.
- Optional: a live strength meter on the two choose-a-passphrase screens (the gate itself is on submit).
- The live burn allow-list check from Task 3 below (a real Harbinger burn, then assert PoB is off the
  allowed list) — needs the account keys; do it with `koinos-pq-core/scripts/testnet-burn.mjs`.
- e2e:ext / smoke:web in a real browser.

The rest of this document is the original plan, kept for reference.

Commit in all three repos as GitHub noreply only:
`Justyoureverydaynormalguybob <142058369+Justyoureverydaynormalguybob@users.noreply.github.com>`
(the phone clones are set this way; set it on the laptop too). All three repos are PUBLIC. The signing
keystore lives outside the repo at `~/.koinos-pq-wallet-signing/` — never commit it.

## Background: what the 2026-11-22 pen-test did and found (all from the phone, black-box, no seed)

Target of the on-chain part: the live Harbinger account `1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t`
(locked pqwallet, ML-DSA key `d1a8aaf5…`, ~67 tKOIN). Everything held:

1. **Verifier (the one trust anchor), `koinos-pq wasm/dilithium.wasm`.** 5035 adversarial checks vs the
   noble reference as oracle: context confusion (tx ctx `koinos/pqwallet/1` vs pop ctx
   `koinos/pqwallet/1/pop`), tx-id substitution, key replay, degenerate sigs, 4000 random + structured
   mutations. 0 false-accepts, 0 divergences. Now committed as `wasm/test/adv-verify.test.mjs`
   (koinos-pq commit 8f21fb7, in `test:wasm`, CI green).
2. **On-chain gate, live Harbinger.** With a FRESH ML-DSA key (never had the seed): a drain
   (transfer victim→attacker) and a takeover (`set_public_key` rotating to the attacker key, with a valid
   proof-of-possession) were both rejected: `account … has not authorized transaction`. Balance untouched.
3. **Web surface (wallet.koinosproof.com).** Strong CSP (`script-src 'self'`, no inline), HSTS,
   `X-Frame-Options: DENY`, `frame-ancestors 'none'`, no-referrer, nosniff. No source maps served, no
   secrets in the bundle. `npm audit`: 10 findings, ALL build/test tooling (vitest, tinypool, xcode,
   minimatch, uuid, @capacitor/cli) — none reachable in the served app. Runtime deps clean.
4. **Local-attacker pass (attacker has the phone / localStorage / DOM).** Vault = AES-256-GCM under
   PBKDF2-SHA256 600k, per-slot salt+iv, 8 KiB padding; two-slot constant-work unlock makes filler and a
   hidden decoy indistinguishable at rest. Lock zeroes the key buffers; hidden-tab lock 60 s; clipboard
   wipe 60 s; no seed/pass to console or sessionStorage. Two weak points (below).

The tests predate the 0.16–0.17.2 pull (burn + multi-account), so they did NOT cover burn/allow-list.

## Task 1 — document the pen-test in both SECURITY.md files

Add a dated section `## Outsider pen-test 2026-11-22` to:
- `koinos-pq/docs/SECURITY.md` (latest section is 2026-11-07) — cover items 1 and 2 above.
- `koinos-pq-wallet/docs/SECURITY.md` (latest is 2026-10-20) — cover items 3 and 4, and the two weak
  points in Task 4.

State plainly: what was attacked, how, the result, and that the on-chain txs were rejected pre-mining so
there is no chain trace. Keep the hand-over tone (tested + documented).

## Task 2 — commit the live attack as a repeatable negative test

New file `koinos-pq/cli/attack-outsider.mjs`: the attacker never loads the victim's keys; it reads only
the public address (take it as `argv[2]`, default the Harbinger account above). It must be a NEGATIVE test
(exit non-zero if any attacker tx is accepted). This mirrors the existing negative tests
(`cli/send.mjs --bad-sig/--no-sig`, `koinos-pq-core scripts/testnet-burn.mjs`).

All helpers below are exported from `cli/lib.mjs` (confirmed on the phone 2026-11-23):
`network, koinContract, pqContract, pqKeysFromSeed, pqProofOfPossession, buildTransaction, submit,
pqSignTxId, pqVerifyTxId, b64url, Signer, balance, fmtKoin, hex`.

Skeleton (the exact logic that ran on the phone):

```js
import { randomBytes, createHash } from "node:crypto";
import { network, koinContract, pqContract, pqKeysFromSeed, pqProofOfPossession,
  buildTransaction, submit, pqSignTxId, b64url, Signer, balance, fmtKoin, hex } from "./lib.mjs";

const net = network(); // KOINOS_NETWORK, default testnet — DO NOT run against mainnet
const VICTIM = process.argv[2] || "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
const attacker = pqKeysFromSeed(hex(randomBytes(32)));          // fresh key, never had the seed
const sink = Signer.fromSeed(hex(randomBytes(32))).getAddress();
let anyAccepted = false;

// 1) drain: transfer victim -> sink, signed by the attacker's key over the real tx id
{
  const { operation } = await koinContract(net).functions.transfer(
    { from: VICTIM, to: sink, value: String(10 * 1e8) }, { onlyOperation: true });
  const tx = await buildTransaction(net, VICTIM, [operation], process.env.RC_LIMIT);
  tx.signatures = [b64url(pqSignTxId(tx.id, attacker.secretKey))];
  try { await submit(net, tx); anyAccepted = true; console.log("[1] ACCEPTED — BROKEN"); }
  catch (e) { console.log("[1] rejected as expected:", String(e.message || e).split("\n")[0].slice(0,160)); }
}
// 2) takeover: set_public_key on the victim's contract -> attacker key, valid proof-of-possession
{
  const proof = pqProofOfPossession(VICTIM, attacker.secretKey);
  const { operation } = await pqContract(net, VICTIM).functions.set_public_key(
    { public_key: b64url(attacker.publicKey), proof: b64url(proof) }, { onlyOperation: true });
  const tx = await buildTransaction(net, VICTIM, [operation], process.env.RC_LIMIT);
  tx.signatures = [b64url(pqSignTxId(tx.id, attacker.secretKey))];
  try { await submit(net, tx); anyAccepted = true; console.log("[2] ACCEPTED — BROKEN"); }
  catch (e) { console.log("[2] rejected as expected:", String(e.message || e).split("\n")[0].slice(0,160)); }
}
process.exit(anyAccepted ? 1 : 0);
```

Add an `npm run attack` script (and a one-line mention in HANDOVER.md). Guard it so it refuses mainnet
unless an explicit env flag is set.

## Task 3 — re-run the pen-test against 0.17.2, focused on the NEW surface

Re-run the three parts above on current code, then add burn/multi-account cases, because the burn
briefly puts the PoB contract on the account's allowed list:

- **Allow-list abuse.** `Chain.burnKoin` (koinos-pq-core 089d201) sends one tx that allows PoB, calls
  `pob.burn`, then forbids PoB — nothing stays allowed. Confirm from the dapp side that:
  - a dapp CANNOT get the user to approve an "allow X, call X, forbid X" tx where X is some OTHER contract
    (the approval sheet must make the allow/forbid legible — check `src/ui/approval-view.ts`);
  - after any burn, `get_allowed_caller(pob)` is false on-chain (the testnet-burn script already checks
    this — extend it to assert it a second time after a mixed/failed tx);
  - PoB addresses are the node-resolved ones in `koinos-pq-core/src/chain.ts`
    (mainnet `159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv`, Harbinger `1MAbK5pYkhp9yHnfhYamC3tfSLmVRTDjd9`) and
    re-verify via the node's `get_contract_address` before trusting them.
- **Multi-account.** A fresh attacker key must not move ANY account derived from the seed (run Task 2's
  attack against a second derived account address too).
- Re-check web headers on the deployed 0.17.2 and re-run `npm audit`.

Record the results in the SECURITY.md sections from Task 1 (date 0.17.2).

## Task 4 — passphrase strength gate (NOT built as of 0.17.2)

Goal: reject weak passphrases when one is CHOSEN, never at unlock, so existing wallets still open.

Design (kept dependency-free on purpose — tight bundle, strict CSP):
1. New `src/core/passphrase.ts`: `passphraseStrength(pw): { bits: number; score: 0..4; warning?: string }`
   and `MIN_PASSPHRASE_BITS` (suggest reject below score 2 / ~45 bits; a long multi-word passphrase should
   pass easily — follow NIST: reward length, do not force symbols). Also hard-reject a small built-in list
   of common passwords and obvious patterns (all-same, sequences, repeats) regardless of computed bits.
   NOTE: a naive charset-entropy count overrates things like "Password1!"; add the pattern penalties.
2. DO NOT gate inside `encryptVault` unconditionally — `app.ts:985 saveChange()` re-encrypts under the
   EXISTING (already-accepted, maybe legacy-weak) passphrase on any settings change; gating there would
   lock those users out. Instead call an `assertStrong(pw)` only where a passphrase is newly set/changed:
   - the `"passphrase"` case (new wallet, ~app.ts:1577, right after the length check),
   - the duress case (~app.ts:1765, saveDecoy at app.ts:1015),
   - the change-passphrase flow (there is one — `grep -ni change.?pass src/ui/app.ts`).
   Keep `MIN_PASSPHRASE_LENGTH` too.
3. UI: a live strength meter on the two choose-a-passphrase screens (render blocks ~app.ts:1988 and the
   duress screen ~2560) is nice-to-have; at minimum block submit with a specific message + current rating.
   Add the strings to `src/i18n/{en,es,pt}.json`.
4. Tests in `test/` (vitest): weak passphrases rejected at creation/duress/change; unlock of an existing
   weak-passphrase wallet still works (ungated); score monotonicity sanity. Run `npm test`.
5. Bump version (0.18.0), `vite build` AFTER the bump (About line bakes `__APP_VERSION__`), commit, and
   redeploy wallet.koinosproof.com with `railway up`; the signed APK comes from CI.

## Release recipe (from memory, verify against current scripts)
tests → bump version → `vite build` → commit/push → `railway up --detach` → `gh run watch` →
`gh run download <id> -n android-apk` → copy to Downloads. Updates keep the vault only if signed with the
SAME keystore and the Capacitor hostname/androidScheme are unchanged.
