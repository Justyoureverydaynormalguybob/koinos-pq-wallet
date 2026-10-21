# koinos-pq-wallet

The app is called **Sparán** (spuh-RAWN, the Irish word for a purse). The repository, package and application
id keep their original names so existing installs update in place.

A post-quantum wallet for Koinos. The account is controlled by an **ML-DSA-44** key (NIST FIPS 204)
instead of secp256k1. This repo is the browser app and the browser extension, both built on
[koinos-pq-core](https://github.com/Justyoureverydaynormalguybob/koinos-pq-core), the signing rules
the phone app will mirror.

Status: a showcase, purely for testing. It works on mainnet, Harbinger and the devnet, and it is
not audited. The point is to show Koinos can have post-quantum accounts now, years ahead of any real
quantum threat, with no change to the chain. The code is MIT: the Koinos Foundation and any Koinos
developer are welcome to use it, share it or build on it. Companion to
[koinos-pq](https://github.com/Justyoureverydaynormalguybob/koinos-pq) (the account contract, the
native node change, the measurements).

Since 0.4.0 (2026-10-19): **duress mode** (a second passphrase opens a separate decoy wallet; the stored
file always has two same-sized slots, so nothing shows whether a decoy exists), **address-poisoning
protection** (first-time recipients must be confirmed; an address that merely resembles one you have used
is flagged with the differing characters marked and needs its last six characters typed), **watch-only
accounts**, **lock when the tab is hidden**, and a **timed clipboard wipe** after copying an address.
`docs/SECURITY.md` has the design notes and limits of each.

Since 0.7.0: **KCS-4 tokens**. The Account tab lists the network's tokens (a curated list in `src/data/`,
every entry checked against the chain) with balances read per contract, a token can be added by its
contract address (name, symbol and decimals are read from the contract), and Send has a token picker;
a token transfer is the same signed operation as a KOIN transfer with a different contract id.

Since 0.8.0, on Android and iOS: **QR scanning** of a recipient address on Send (the code must be a
checksum-valid Koinos address or a `koinos:` URI, nothing else is pasted), and **biometric unlock**: the
wallet's slot key wrapped under a key the device keystore releases only to a strong biometric that
passes (since 0.15.0 through the wallet's own `plugins/pq-bio`: bound to the enrolment, so a new
fingerprint or face kills the key); the passphrase is never stored and always works. See
`docs/SECURITY.md` for what that protects against and what it does not.

Since 0.15.0: **WalletConnect**. Dapps on another device or browser (KoinDX, Vortex Bridge, anything on
the Koinos WalletConnect SDK) pair by QR code or a pasted `wc:` link from the Dapps tab; a `wc:` link
opened on the phone lands in the app. Every request a session sends goes through the same approval
sheet and the same rules as the in-app browser. It needs a WalletConnect project id, free from
cloud.reown.com. The repo's `.env` bakes one in (a public identifier, not a secret); Settings ›
WalletConnect overrides it. `WC_PROJECT_ID=… WC_LIVE_DIR=$(mktemp -d) npx vitest run test/wc-live.test.ts`
in one shell and `… test/wc-live-dapp.test.ts` in another run a real round trip over the relay. Also since 0.15.0 the side stores (contacts, added tokens,
allowed sites, collections) are sealed under the open wallet's slot key.

Since 0.9.0, on Android and iOS: an **in-app dapp browser** (the Dapps tab). It is the wallet's own
Capacitor plugin (`plugins/pq-browser`, about 150 lines of Java and of Swift, no third-party code): a
second WebView over the app's, with the extension's `window.kondor` script injected at document
start and a JSON channel to the app. Requests are validated, described and signed by the same code
as the extension's approval window (`src/core/approval.ts`), with the same refusals; a site is
remembered once you let it see your accounts, every signature is approved on its own.

Since 0.10.0: **collectibles (KCS-5 NFTs)**. Add a collection by its contract address (name and symbol
are read from the contract), see the tokens the account holds (`get_tokens_by_owner`) with their
names and pictures from `token_uri` metadata, fetched only through a short list of IPFS and Arweave
gateways, and send one through the same recipient checks and the same signing path as a token.

Since 0.11.0: **languages**. Every string the app shows is a key in `src/i18n/en.json` with Spanish
(`es.json`) and Portuguese (`pt.json`) lines; the language follows the device unless Settings says
otherwise, and a missing line falls back to English. To add a language, copy `en.json`, translate the
values (keep the `{placeholders}` and inline tags), and list it in `src/i18n/index.ts`.

Since 0.12.0: **ready for the stores**. The app mark (an ink square, "PQ" in Archivo at its widest, one
signal pixel) as icons and splash screens on both platforms, the Android back button mapped, theme
colours by day and night, a [privacy page](https://wallet.koinosproof.com/privacy.html), and CI
producing the signed AAB Play wants. `docs/STORE.md` lists what the repo provides and the steps that
need a Play Console or Apple Developer account.

```
koinos-pq-core          keys (24 words <-> seed -> key -> address), the two signature formats, chain reads,
                        account setup, a koilib-compatible PqSigner, a protobuf-lite encoder (no eval)
src/core/vault.ts       encrypted at rest: PBKDF2-SHA256 (600k) + AES-256-GCM, WebCrypto only; two fixed slots (duress)
src/core/addressbook.ts contacts per wallet, address-poisoning (look-alike) detection
src/core/clipboard.ts   copy with a timed wipe
src/ui/app.ts           the screens, no framework (web app, native shells and extension popup alike)
src/ui/components.ts    the building blocks those screens are made of (address strip, card, tab bar, ...)
src/ui/tokens.css       the design system: tokens, type, controls; bundled Archivo and JetBrains Mono (OFL)
src/data/               the token and dapp lists, checked against the chain (scripts/check-token-list.mjs)
src/i18n/               the languages: en.json is the key list, es.json and pt.json the translations
design/                 the screens as static HTML, reviewed before they were ported (scripts/design-shots.mjs)
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

## Where this is going

`docs/PLAN-NATIVE-WALLET.md`: the researched plan that took this to Konio parity and beyond (Capacitor 8,
tokens, QR, biometrics, in-app dapp browser, NFTs, languages, store polish), with the standards, plugins and
sources. Every step shipped between 0.5.0 and 0.12.0; `docs/STORE.md` has what is left for the store accounts.

## Android and iOS

The same wallet packaged as native apps with Capacitor (`capacitor.config.ts`, `android/`, `ios/`): no
second code base, so the vault, signing, duress mode and recipient checks are the reviewed web code
byte for byte, running in the system WebView against the same nodes. Every push builds them in CI
(`.github/workflows/mobile.yml`): a release APK signed with the project key (artifact `android-apk`,
with its sha256) and an unsigned iOS app (artifact `ios-app-unsigned`; installing on an iPhone needs an
Apple developer account to sign it). Locally: `npm run build && npx cap sync`, then open `android/` in
Android Studio or `ios/App/App.xcworkspace` in Xcode. Capacitor 8 (since 0.5.0) needs Node 22, JDK 21
(Android Studio's bundled one does), Android SDK 36 and Xcode 26; the app runs on Android 8 (API 26, the QR scanner's floor) and
iOS 15 or newer. The Android signing key lives outside the repo;
its SHA-256 fingerprint is `DC:7D:CE:C9:60:76:30:58:F8:5B:FE:1A:DD:87:6B:72:46:39:18:E8:67:0A:21:96:F6:4A:A9:3A:24:66:63:FF`.
Android keeps the encrypted vault in the app's WebView storage; uninstalling the app deletes it, so the
24 words remain the only backup.

## Run it

```
npm install
npm test            # key vectors, signature formats, vault
npm run dev         # web app at http://localhost:5173
npm run build       # web app as a static site in dist/, serve from anywhere
npm run build:ext   # browser extension in dist-extension/
node scripts/smoke-web-local.mjs   # serves dist/ and drives it in a real browser with the CSP in force (needs Playwright, see the script)
```

To use the extension: Chrome (or Brave, Edge) → `chrome://extensions` → Developer mode → "Load
unpacked" → pick `dist-extension/` (or the unzipped `koinos-pq-wallet-extension-<version>.zip` from
a GitHub release; CI builds it as the `extension-zip` artifact). The extension has the same tabs as
the phone app; under Dapps each site opens in a new browser tab and finds the wallet through
`window.kondor`, and WalletConnect pairing works from the wallet page while it stays open. The toolbar button opens the wallet; web pages get
`window.kondor`. A test dapp lives at `/demo/` (http://localhost:5173/demo/ under `npm run dev`,
`dist/demo/` in the build): connect, read the head block, sign a message, send KOIN, all through
`window.kondor` with no library. Tester instructions: [docs/EXTENSION-TESTING.md](docs/EXTENSION-TESTING.md).

```
npm run e2e:ext         # the extension against the devnet: 14 functional checks + 9 attacks that must fail
npm run e2e:activation  # a brand-new wallet activates itself on the devnet, then sends
npm run smoke:web       # the built site on Harbinger and mainnet: CSP, onboarding, an existing account
npm run icons           # re-render extension/icons and public/icons
```

Security: see [docs/SECURITY.md](docs/SECURITY.md) for the 2026-10-18 review, what it fixed and
the known limits.

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
- The approval window rebuilds the transaction from validated fields and lets koilib recompute
  its id, so what it shows is exactly what it signs. It shows the origin, the account, each
  operation in plain words ("Send 1 KOIN to …" for a canonical transfer, the contract and entry
  point otherwise), the network, who pays the mana and the mana limit. It decrypts the vault with
  the passphrase **for that one request**, signs, wipes the key material and closes. Nothing
  unlocked survives between requests, and the background holds no keys.
- One approval window at a time, at most three waiting per site; closing the window rejects.

Permissions: `storage` only; no host permissions. The content script runs on http/https pages only
to inject `inpage.js` and relay messages; it reads nothing from the page. Extension pages run under
`script-src 'self'`, no eval, no frames.

What a dapp gets from a post-quantum account:

- `getAccounts()`: the wallet's accounts on the current network (the native address only on the devnet).
- `getSigner(address).signTransaction / sendTransaction`: contract calls only, for the wallet's
  network. Uploads, system operations and calls to one of the wallet's own accounts are refused.
- `signMessage`: an ML-DSA-44 signature over the message under the `koinos/message/1` context,
  never valid as a transaction signature. No public key can be recovered from it; verify it with
  `verifyMessageEntry` from koinos-pq-core against the account's registered key.
- Refused: `signHash` (a blind transaction signature). Not supported: `invokeSystemCall` (use
  `provider.call`), block production.

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
- **Security fixes, 0.3.0** (see `docs/SECURITY.md`): the extension test now replays nine attacks
  (a forged transaction id, a message that is really a transaction, raw hash signing, markup in an
  operation, a call to the account's own contract, an upload, another chain's transaction, a
  transfer with duplicated fields, a flood of requests). All nine succeed against 0.2.1 and all are
  stopped in 0.3.0; 23 of 23 checks pass.
- **Hands-free activation** (`npm run e2e:activation`): a brand-new wallet on the devnet activated
  its account with no clicks, showed it as "Your account" and sent 1 KOIN from it with a 2,420-byte
  signature. On Harbinger and mainnet an unfunded new wallet waits and submits nothing, asking for
  7.49 tKOIN and 65.82 KOIN respectively (smoke test, live prices).
- **Activation in one transaction, 0.3.1**: the install and the key registration travel together,
  so there is no moment when the contract is installed but the throwaway key still rules the
  account. On the devnet it took 1 second; the chain shows one transaction carrying both
  operations, the account's nonce at 1, and the throwaway key refused afterwards.

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

- Create a wallet (24 words, confirmation, passphrase) or import words / a CLI seed.
- **Activates the account by itself.** A new wallet goes straight to "Activate your account": one
  address (the seed's own account, so it is the same on every network) and the amount to send,
  priced from the live resource market. Once the address holds enough mana the wallet, in one transaction, installs the
  bundled contract (hash-checked, call + transaction + upload authority locked to the contract from
  block one), registers the ML-DSA-44 key with a proof of possession and checks the registered key
  is this wallet's. Same steps as the CLI's `deploy --lock` and `register`. Interrupted activations
  resume where they stopped.
- **Finds the account again** from the 24 words on any network, with nothing stored.
- Balance, mana and head block for mainnet, Harbinger or a devnet (RPC configurable); QR code.
  While the wallet is unlocked and on screen they refresh every 10 s (three small reads, about
  1 MB an hour); the activity list and token rows are re-read only when the balance moved. Nothing
  runs in the background or while locked. Once a minute a one-row read of the activity list
  notices anything that arrived without moving the KOIN balance (a token, a collectible).
- **Collectibles find themselves.** Any contract that sent something to the account and is not a
  listed token is asked for the account's tokens (KCS-5 `get_tokens_by_owner`); one that answers is
  added to the Collectibles list. A collection can still be added by its contract address.
- Sends KOIN, checks the signature locally before broadcasting, shows the transaction id, waits for
  the block, links to the explorer. History through the JSON-RPC gateway.
- Settings: show the words again, auto-lock time, delete the wallet; under Advanced, accounts set
  up with the command-line tool, the native post-quantum address, the devnet RPC. Changes to the
  stored vault ask for the passphrase in the page, never in a browser prompt.
- **As an extension**: all of the above from the toolbar, plus `window.kondor` for dapps.

## Kondor, and why this is not a fork of it

The dapp side of this extension is `window.kondor`, the interface Julián González (joticajulian)
created for the Kondor wallet and published as [kondor-js](https://github.com/joticajulian/kondor-js)
under MIT. Kondor 2 (the one on the Chrome Web Store) is not open source and the public 1.x repo is
superseded, so there was nothing to fork; what is open is the protocol, and this extension speaks it.
Because of that clean, open interface, every dapp written for Kondor works with a post-quantum
account without changing a line. Credit to Kondor's creators for that. Kondor remains the wallet for
everyday secp256k1 accounts; this is an addition, not a replacement.

## Not yet

- A store listing; Firefox (Manifest V3 there wants `background.scripts`).
- Per-site permissions (remembering which origins may call `getAccounts` without asking each time).
- The phone app (Flutter) with the same rules and the vendored C verifier over FFI.

MIT.
