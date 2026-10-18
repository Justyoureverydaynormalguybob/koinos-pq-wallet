# koinos-pq-wallet

A post-quantum wallet for Koinos. The account is controlled by an **ML-DSA-44** key (NIST FIPS 204)
instead of secp256k1. This repo is the browser app and the browser extension, both built on
[koinos-pq-core](https://github.com/Justyoureverydaynormalguybob/koinos-pq-core), the signing rules
the phone app will mirror.

Status: working on mainnet, Harbinger and the devnet; not audited. Companion to
[koinos-pq](https://github.com/Justyoureverydaynormalguybob/koinos-pq) (the account contract, the
native node change, the measurements).

```
koinos-pq-core          keys (24 words <-> seed -> key -> address), the two signature formats, chain reads,
                        account setup, a koilib-compatible PqSigner, a protobuf-lite encoder (no eval)
src/core/vault.ts       encrypted at rest: PBKDF2-SHA256 (600k) + AES-256-GCM, WebCrypto only
src/ui/app.ts           the screens, no framework (web app and extension popup alike)
src/ext/inpage.ts       window.kondor for web pages (kondor-js, MIT)
src/ext/content.ts      relays page <-> extension messages
src/ext/background.ts   answers provider calls; queues anything that needs a signature
src/ext/approve.ts      the approval window: shows the request, takes the passphrase, signs, wipes
extension/manifest.json Manifest V3, plus the icons
demo/index.html         a test dapp: uses window.kondor and nothing else
scripts/                end-to-end test of the extension (devnet), CSP smoke test of the web app, icons
test/                   vectors shared with the koinos-chain tests, signature formats, vault round trip
```

**Live:** https://wallet.koinosproof.com (the web wallet), https://wallet.koinosproof.com/demo/ (the
test dapp for the extension), https://wallet.koinosproof.com/version.json (what is deployed).

Want to try it? Read [docs/TESTER-GUIDE.md](docs/TESTER-GUIDE.md) first: what it costs, what to back up,
and the steps for a mainnet account. For the extension: [docs/EXTENSION-TESTING.md](docs/EXTENSION-TESTING.md),
with the zip on the [releases page](https://github.com/Justyoureverydaynormalguybob/koinos-pq-wallet/releases).

## Run it

```
npm install
npm test            # key vectors, signature formats, vault
npm run dev         # web app at http://localhost:5173
npm run build       # web app as a static site in dist/, serve from anywhere
npm run build:ext   # browser extension in dist-extension/
```

To use the extension: Chrome (or Brave, Edge) → `chrome://extensions` → Developer mode → "Load
unpacked" → pick `dist-extension/`. The toolbar button opens the wallet; web pages get
`window.kondor`. A test dapp lives at `/demo/` (http://localhost:5173/demo/ under `npm run dev`,
`dist/demo/` in the build): connect, read the head block, sign a message, send KOIN, all through
`window.kondor` with no library. Tester instructions: [docs/EXTENSION-TESTING.md](docs/EXTENSION-TESTING.md).

```
npm run e2e:ext     # the extension in headless Chromium against the devnet (see the script header)
npm run smoke:web   # the built web app under its CSP on testnet and mainnet
npm run icons       # re-render extension/icons and public/icons
```

Everything happens in the browser. There is no server and nothing leaves the page except JSON-RPC
calls to the node you pick (mainnet, Harbinger testnet, or a local devnet).

Hosting: the `Dockerfile` builds the site and serves it with nginx. It runs on Railway (project
`koinosproof`, service `wallet`) and deploys with `railway up` from this folder; DNS for
wallet.koinosproof.com is on Cloudflare.

## The browser extension

Koinos dapps talk to a wallet through `window.kondor` (`getAccounts`, `getSigner(address)`,
`getProvider(network)`), the interface of the Kondor extension, published as kondor-js under MIT.
This extension provides the same object, so **existing dapps work with post-quantum accounts without
a code change**: the dapp asks for a signature, the wallet window opens, you read what is being
signed, type the passphrase, and the account signs with ML-DSA-44.

How it is put together:

- `inpage.js` runs in the page and is nothing but kondor-js: it posts messages to the window.
- `content.js` relays those messages to the extension and the answers back. Provider calls
  (`provider:*`) are answered by the background straight away. `getAccounts` and `signer:*` are
  queued and a small window opens (`approve.html`).
- The approval window shows the origin, the account, and a plain reading of each operation
  (a KOIN transfer is shown as "Send 1 KOIN to …"; anything else as the contract and entry
  point). It decrypts the vault with the passphrase **for that one request**, signs, wipes the key
  material and closes. Nothing unlocked survives between requests, and the background holds no keys.
- Results that are bytes (`signHash`) cross the extension boundary as base64url and are turned
  back into a `Uint8Array` before the page sees them, as kondor-js expects.

Permissions: `storage`, `tabs`, `windows`; no host permissions. The content script runs on
http/https pages only to inject `inpage.js` and relay messages; it reads nothing from the page.
Extension pages run under `script-src 'self'`, no eval.

What a dapp gets from a post-quantum account:

- `getAccounts()`: the native address and every pqwallet account in the vault.
- `getSigner(address).signTransaction / sendTransaction / signHash / signMessage`: works. A pqwallet
  account's signature is accepted on mainnet today; the native address needs nodes running the
  koinos-chain `ml-dsa-44` branch.
- `signMessage` returns a signature no public key can be recovered from. Dapps that verify a
  message by recovering a secp256k1 key will not accept it; they need the account's registered key.
- Not supported: `invokeSystemCall` (kondor-js passes a serializer object, which cannot cross a
  message boundary; use `provider.call`), block production (`prepareBlock`, `signBlock`).

## The rules the phone app must match

1. **Seed.** 32 random bytes. Shown to the user as a 24-word BIP-39 phrase whose entropy *is* the
   seed (no BIP-39 passphrase, no derivation path). The koinos-pq CLI's `pq.seedHex` is the same seed,
   so the two can import each other.
2. **Key.** `ML-DSA-44.KeyGen(seed)` (FIPS 204 KeyGen_internal), public key 1,312 bytes, secret key
   2,560 bytes. Library here: `@noble/post-quantum`; the node uses the PQ-Crystals reference C.
3. **Address.** `base58check( 0x00 || ripemd160( sha256( publicKey ) ) )`, the same bytes Koinos
   derives for a secp256k1 key. koilib: `utils.bitcoinAddress(publicKey)`.
4. **Signing, pqwallet route** (an existing account running the koinos-pq contract with this key
   registered; works on mainnet and Harbinger today): the signature entry is the raw 2,420-byte
   ML-DSA-44 signature over the 34-byte transaction id, context string `koinos/pqwallet/1`.
5. **Signing, native route** (nodes running the koinos-chain `ml-dsa-44` branch): the entry is
   `0x01 || publicKey || signature`, 3,733 bytes, over the 34-byte transaction id, context
   `koinos/tx/1`. The account is the key's own address.
6. **Bootstrap key** for creating a pqwallet account: secp256k1 from
   `Signer.fromSeed(hex(seed) + ":koinos-pq:secp256k1")`. Needed once, to upload and register; dead
   weight after `lock`.
7. **At rest.** Seed and account list encrypted with a user passphrase: PBKDF2-SHA256, 600,000
   iterations, 16-byte salt, AES-256-GCM with a 12-byte IV. Passphrase minimum 10 characters. The
   decrypted seed is wiped on lock; auto-lock after 10 minutes by default.

Test vectors: `test/keys.test.ts` derives the same two addresses as
`koinos-chain/tests/include/koinos/tests/mldsa_vectors.hpp`, so a port that passes the same vectors
agrees with the node.

## Proven so far (2026-10-18)

- Headless browser at phone width: create (24 words, confirmation, passphrase), lock and unlock,
  QR, import of the chain test vector gives the expected address, balances and mana from Harbinger.
- Native route, end to end: imported the devnet post-quantum account, picked the devnet, sent
  1 KOIN; the node accepted the 3,733-byte entry (rc used 537,122), block 8 mined it
  (compute 519,646, network 3,980 bytes), and the recipient's balance moved.
  Transaction `0x1220ca1d283f34b40a6784d03b3d4e407fbc5c2a0be1382e6372f84c7d9e3dffb5be`.
- Account creation, end to end on the devnet from a fresh seed: the setup screen uploaded the
  contract (block 9), registered the key with its proof of possession (block 10) and reported
  "Account ready" after 4 seconds; 100 KOIN minted to the account; then a 1.5 KOIN send from it,
  signed in the browser with the 2,420-byte pqwallet signature, was accepted (rc used 5,868,293)
  and mined in block 12; balances 98.5 and 1.5 afterwards. A second run on the same seed took the
  idempotent path ("upload already done, registration already done").
- Harbinger, by a person in the browser (2026-10-18): account `1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ`
  created from the setup screen (upload rc 506,697,901; registration rc 34,855,788; the contract
  reports `key_registered: true`), then a 20 tKOIN send from it to `1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t`
  signed only with the 2,420-byte pqwallet signature, mined (rc 39,287,060). The first attempt
  surfaced three fixes now in the code: the setup form was being wiped by the mana poll, the
  registration must wait out the mempool's hold on the upload's budget, and funding the native
  address by mistake needed a louder warning and a button in the right place.
- **The extension, end to end on the devnet** (`npm run e2e:ext`, headless Chromium with the
  extension loaded, 13 checks): a plain web page with no wallet library of its own called
  `window.kondor.getAccounts()` (approved in the wallet window), read the head block through
  `getProvider("devnet")`, had a request rejected and saw the error, got a 3,733-byte
  `signMessage` result, and sent 1 KOIN with `getSigner(address).sendTransaction(...)`. The
  wallet window showed "Send 1 KOIN to 1Hdt…", signed after the passphrase, the entry was the
  3,733-byte native form, block 11 mined it (rc used 540,441) and the KOIN arrived.
- **CSP without eval** (`npm run smoke:web`): the built web app under `script-src 'self'` unlocks
  a throwaway vault on testnet and on mainnet and loads balance, mana and head block with no CSP
  violation and no page error, at 360px wide with no horizontal scroll.

## Mainnet (2026-10-18)

Account `1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ`, created from the setup screen on mainnet: upload mined with
4,488,437,429 rc used (44.9 KOIN of mana, budget 60.2), registration with 290,236,322 rc used (2.9 KOIN),
contract reports `key_registered: true`. Then a 1 KOIN transfer to `1sXttKzfrzH8amTpfRHX8SXT7kynjNpMX`,
signed in the browser with one 2,420-byte ML-DSA-44 signature and nothing else:
transaction `0x12206b839a6fa5c9ac9a0a90ba4fc7a2cd3fb2786bc4927f3d59ab448a45d3726244`, block 40,318,335,
mana used 316,332,332 (3.16 KOIN), compute 6,071,053 ticks, 2,668 bytes, succeeded. As far as we know the
first transfer on Koinos mainnet authorised by a post-quantum signature.

Lessons from that run, all fixed in the code: mainnet KOIN lives at `19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK`
(the address in most examples is the superseded contract and refuses state reads); the REST history
endpoint has no CORS, so history goes through the JSON-RPC gateway; and a retry loop must re-read the
chain, because a step can succeed while the mempool still reports a hold.

## What it does today

- Create a wallet (24 words, confirmation, passphrase) or import words / a CLI seed, optionally
  with the address of a pqwallet account that already uses the key.
- Shows the native post-quantum address with a QR code, KOIN balance, mana and head block, for
  mainnet, Harbinger or a devnet (RPC configurable).
- Sends KOIN from either kind of account, checks the signature locally before broadcasting, shows
  the transaction id, waits for the block, links to the explorer.
- History through the JSON-RPC gateway's account history service.
- Settings: add/remove pqwallet accounts, show the words again (passphrase required), auto-lock
  time, delete the wallet.
- **Create a pqwallet account** on the current network, in the browser: shows the one-time
  secp256k1 funding address (derived from the seed), waits for mana, uploads the bundled account
  contract (hash-checked, call + transaction + upload authority locked to the contract from block
  one), registers the ML-DSA-44 key with a proof of possession, checks the registered key is this
  wallet's, and saves the account. Same steps as the CLI's `deploy --lock` and `register`.
- **As an extension**: all of the above from the toolbar, plus `window.kondor` for dapps.

## Why not fork Kondor

Kondor 2 (the one on the Chrome Web Store) is not open source; the public joticajulian/kondor repo is
the superseded 1.x. What is open is the protocol, kondor-js, so this extension speaks it instead.

## Not yet

- Icons and a store listing; Firefox (Manifest V3 there wants `background.scripts`).
- Per-site permissions (remembering which origins may call `getAccounts` without asking each time).
- The phone app (Flutter) with the same rules and the vendored C verifier over FFI.

MIT.
