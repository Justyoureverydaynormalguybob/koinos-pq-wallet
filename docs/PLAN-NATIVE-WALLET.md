# Plan: the native Koinos wallet, post-quantum first (Konio parity and beyond)

*Researched and written 2026-10-19 on the phone session; to be built on the laptop. Every claim below
names its source so it can be re-checked. Start at section 2 for the order of work.*

## 0. Why this and not a Konio fork

Konio (github.com/konio-io/konio-mobile, GPL-3.0, Adriano Foschi) was the native Koinos wallet: React
Native 0.72 + Expo 49, koilib 5.6, last release v2.5.0 on 2024-02-09, 7 open issues, no commits since.
Its token list (45 entries), dapp list and collection list are separate repos **without a licence**, so
they cannot be copied; the koindx token-list repo is MIT and can. Forking Konio would mean upgrading
two years of React Native/Expo drift and rewriting every secp256k1 signing path anyway, under GPL, and
under someone else's brand. Our wallet already has the reviewed vault, ML-DSA-44 accounts, duress mode,
address-poisoning checks, watch-only, the `window.kondor` dapp interface (extension), one code base for
web, Android and iOS, and CI that ships a signed APK. So: grow ours to Konio parity, credit Konio, and
ask Adriano (github.com/adrianofoschi) whether he wants to be involved or to license the lists.

Konio's screens, for parity tracking: Assets, Coin, NewCoin, Nft, NewNft, Deposit, Withdraw, WithdrawToScan,
Browser, Discovery (dapp list), Wc* (WalletConnect pair/sessions), NewContact, EditAccount, ImportAccount,
NewNetwork/ChangeNetwork, Security, ChangePassword, ChangeAutolock, ChangeLocale (14 languages), ChangeTheme,
ShowSeed/ShowPrivateKeys, Logs, Faq, About.

## 1. Facts the work depends on

**Standards.** KCS-4 tokens expose (koilib `utils.tokenAbi`, entry points): `name 0x82a3537f`,
`symbol 0xb76a7ca1`, `decimals 0xee80fd2f`, `get_info 0xbd7f6850`, `total_supply 0xb0da3934`,
`balance_of 0x5c721497`, `allowance 0x32f09fa1`, `get_allowances 0x8fa16456`, `approve 0x74e21680`,
`transfer 0x27f576ca`, `mint`, `burn`. Our `abi-lite` already encodes `balance_of` and `transfer`; the
read-only string/uint64 results need two small decoders. KCS-5 NFTs (koinos/koinos-proto
`koinos/standards/kcs5.proto`; koinosbox's `contracts/nft` implements it): `name`, `symbol`, `uri`,
`token_uri`, `get_info`, `owner`, `total_supply`, `royalties`, `balance_of`, `owner_of`, `metadata_of`,
`get_tokens`, `get_tokens_by_owner`, `get_approved`, `is_approved_for_all`, `transfer`, `approve`,
`set_approval_for_all`, `mint`, `burn`. Older collections follow KCS-2 (docs.koinos.io NFT guide);
support KCS-5 first, KCS-2 read-only if a tester needs it.

**Discovery.** There is no public REST indexer of per-address token holdings that we could confirm:
api.koinosscan.com answers only a title page, and api.koinosblocks.com is a JSON-RPC gateway, not a REST
API. So holdings come from a curated token list plus on-chain `balance_of` reads per token (what Konio
did: its CoinStore calls `balance_of`, `symbol`, `decimals`). Token list sources: koindx/token-list
(MIT, mainnet + harbinger, with logos) as the seed, then our own additions; entry format to keep is
Konio's (`chainId, address, symbol, name, logo, priceUrl, pricePath, priceUnit`) plus `decimals`.
Prices, if wanted, via CoinGecko simple price for KOIN as Konio did; everything else unpriced.

**Native shell.** The project is on Capacitor 6. Every maintained plugin now targets Capacitor 8
(`@capacitor/barcode-scanner 3.1.3`, `@capacitor/inappbrowser 4.1.0`, `@aparajita/capacitor-biometric-auth
10.0.0`, `@aparajita/capacitor-secure-storage 8.0.1`, all peer `@capacitor/core >= 8`). Capacitor 8 needs
Node 22, Android minSdk 24 / compileSdk 36 / AGP 8.13.0 / Gradle 8.14.3, iOS 15 deployment target and
**Xcode 26**; migrate with `npm i -D @capacitor/cli@latest && npx cap migrate`. GitHub runners: ubuntu-24.04
has Android SDK 36; macOS runners have Xcode 26.x installed but default to 16.4, so the iOS job must
`sudo xcode-select -s /Applications/Xcode_26.3.app`.

**Dapp browser.** The official `@capacitor/inappbrowser` cannot inject JavaScript or pass messages
(only page-loaded/navigation events and request headers), so it cannot host `window.kondor`. Two
options: (a) `cordova-plugin-inappbrowser 7.0.0` (Apache-2.0, works under Capacitor): `executeScript`
on `loadstop` to inject our provider, page→app messages via `webkit.messageHandlers.cordova_iab.postMessage`
(iOS) / the plugin's `message` event (Android); quick, but Cordova is a dependency with a limited future.
(b) A small in-house Capacitor plugin: Android `WebView` with `addJavascriptInterface` and
`evaluateJavascript`, iOS `WKWebView` with `WKUserScript` (document start) and `WKScriptMessageHandler`.
About 300 lines of Kotlin/Swift, no third-party code in the signing path, same provider bridge as the
extension (`src/ext/inpage.ts` and the approval screen already exist). Recommendation: (a) to validate
the UX in a day, (b) before any release, because the signing bridge must be ours.

**Reference for the provider surface.** The extension already implements Kondor's `window.kondor`
(getAccounts, signer.signTransaction/sendTransaction/prepareTransaction/signMessage, provider.*) with
the "what you see is what you sign" rules from docs/SECURITY.md. The dapp browser reuses it unchanged.


## 1b. UI redesign: the RawByte look (do this right after the Capacitor 8 migration)

The app's present look is a placeholder. Every later step adds screens, so the design system comes
first and the new screens are built on it, not retrofitted. The brand is RawByte's own (rawbyte.ie,
`src/app/globals.css` and `layout.tsx` in the rawbyte repo, read 2026-10-19).

**Tokens, copied from the site, not approximated**

| token | light | dark | use |
|---|---|---|---|
| `--paper` | `#e9e6df` | `#0f0f0e` | page background |
| `--panel` | `#dfdbd2` | `#181816` | cards, inputs, bottom bar |
| `--ink` | `#0f0f0e` | `#e9e6df` | text, icons, primary button fill |
| `--mute` | `#5c5850` | `#98938a` | secondary text, borders, labels |
| `--signal` | `#ff4a1c` | `#ff4a1c` | the one accent: primary actions, focus rings, live states |
| `--on-signal` | `#0f0f0e` | `#0f0f0e` | text on signal |
| `--grain-opacity` | `0.09` | `0.06` | the paper-grain overlay (pointer-events none) |

Add wallet-only semantic tokens on top, never new hues: `--ok` (balance up, mined) = ink on panel with a
signal underline rather than green; `--danger` for look-alike warnings and the duress/lock actions =
signal at full strength with a thick 2px border; `--warn` = mute text on paper with a signal left rule.
Keeping one accent is the point of the brand; the wallet's "stop" moments get weight from size and
rule thickness, not from a second colour.

**Type.** Archivo for everything (the site uses its width axis: `font-stretch: 125%` for display
numerals and the wordmark, `75%` for dense labels) and JetBrains Mono for addresses, amounts, hashes,
transaction ids, the hex motif and anything the user must compare character by character. Both are
Google Fonts with open licences (OFL); **bundle the woff2 files in `public/fonts/` and declare them with
`@font-face`**, because the CSP is `default-src 'self'` and a wallet must not load fonts from a CDN.
Scale: 13 / 15 / 17 / 22 / 28 / 40 px; line height 1.35; balances at 40 px Archivo 125% with the unit at
15 px mute; addresses at 15 px mono, grouped in blocks of four characters with the first and last four
in ink and the middle in mute (this is the address-poisoning defence made visual).

**Motifs that say RawByte.** The hex-dump wordmark treatment (`52 41 57 42 59 54 45` next to "RawByte")
becomes the app mark: `50 51` beside "PQ", and an account's header shows the first bytes of its
address as a hex strip. Numbered section labels in brackets (`[01] ACCOUNT`, `[02] ACTIVITY`) in mono
uppercase at 13 px mute. Colour-on-hover from the site becomes colour-on-press on touch: controls are
ink on panel at rest and flash signal while pressed. A thin live-clock-style line in the header shows
the head block and network in mono, ticking as blocks arrive. Grain overlay on `body` as on the site,
below 0.1 so text stays crisp.

**Shape and space.** Radius 6 px on controls, 10 px on cards, 0 on the bottom bar; 1 px borders in
mute at 40 % opacity rather than shadows; 4 px grid, 16 px gutters, 24 px between sections; safe-area
insets already handled. Touch targets 48 px. Dark and light follow the system by default with a
switch in Settings (the site does the same with `prefers-color-scheme`).

**Information architecture (native and web alike).** Bottom bar with four tabs: **Account** (balance
card, tokens list, send/receive), **Activity** (history with the transfer summaries we already build),
**Dapps** (the browser and the curated list; hidden on web where the extension serves that role),
**Settings** (security, duress, contacts, watch-only, networks, language, about). Onboarding (create,
words, check, passphrase, activate) stays a linear flow without the bar. The extension popup is the
Account tab at 400 px; the approval window is a single card with the request, the account strip and
the passphrase field, same tokens. The unlock screen is paper, the wordmark, one field and one button.

**Screens to design before coding** (as static HTML in `design/` first, reviewed on a phone, then
ported): unlock; account home with balance card and token rows; send with the recipient check states
(new, look-alike with marked differences, known); receive with QR on panel; activity list; settings
index and the duress flow; dapp browser chrome with the approval sheet; the extension popup and
approval window. Ten screens.

**Implementation.** Keep the current approach (TypeScript rendering HTML strings, no framework): it
is small, auditable, CSP-clean and already tested in jsdom. Add `src/ui/tokens.css` (the table above),
`src/ui/components.ts` with the dozen building blocks (card, stat, address strip, button variants,
field, list row, tab bar, sheet, notice, section label), and migrate `app.ts` screen by screen behind
the existing tests. Remove the old `style.css` palette entirely at the end; no two palettes in the tree.
Accessibility: 4.5:1 contrast on every text/background pair in both modes (check `--mute` on
`--panel` in light mode, it is borderline; use `--ink` at 70 % if it fails), visible focus (signal
2 px), reduced-motion respected, every icon with a label.

**Credit line.** Footer and About: "Koinos PQ Wallet, by RawByte, Cavan and Cuenca. Open source, MIT."
with the hex strip. The app icon: ink square, "PQ" in Archivo 125 % in paper, a single signal pixel.

Effort: 2 days for the design pass as static screens, 3–4 days to port the app, extension popup and
approval window onto the new system with the tests kept green.

## 2. Order of work (each step ends in a tagged release and a CI-built APK)

| # | Step | Scope | Effort |
|---|---|---|---|
| 1 | **Capacitor 8 migration** | `npx cap migrate`; Android SDK 36 / AGP 8.13 / Gradle 8.14.3; iOS 15 + Xcode 26 in CI; `@capacitor/app` 8; re-run `mobile.yml`; APK 0.5.0 | half a day |
| 1b | **UI redesign, RawByte look** (section 1b) | tokens, type, components, bottom-tab IA; ten screens as static HTML first, then the port; extension popup and approval window included; APK 0.6.0 | 5–6 days |
| 2 | **Tokens (KCS-4)** | token list in `src/data/tokens.<network>.json` (seeded from koindx, MIT); `Chain.tokenBalance(contract, address)`, `tokenInfo` (name/symbol/decimals via abi-lite decoders); Assets screen listing KOIN, VHP and listed tokens with balances; Send with a token picker (same transfer entry point, different contract id, amount scaled by `decimals`); "Add token by address" (reads name/symbol/decimals from chain); hide zero balances toggle | 1–2 days |
| 3 | **QR scanning** | `@capacitor/barcode-scanner` behind a `scanAddress()` helper; Send "To" field gets a scan button on native, hidden on web; accept `koinos:<address>` and bare addresses; checksum-validate before filling | half a day |
| 4 | **Biometric unlock** | `@aparajita/capacitor-biometric-auth` + `@aparajita/capacitor-secure-storage`: after a passphrase unlock, offer "Unlock with biometrics"; store a random 32-byte key-wrapping key in the platform keystore (biometry-gated), wrap the vault's AES key, never the passphrase; biometric unlock fails closed to the passphrase; disabled automatically when a duress wallet exists unless each slot gets its own wrapped key (do that: wrap per slot so the decoy stays indistinguishable) | 1–2 days |
| 5 | **In-app dapp browser** | option (a) spike then (b) plugin; address bar + curated dapp list (`src/data/dapps.json`, Konio's format `id,icon,name,summary,description,url,tags`, our own entries); inject the provider at document start; approvals through the existing approval screen rendered in-app; per-site permission memory; block uploads and calls to own accounts exactly as the extension does | 3–4 days |
| 6 | **NFTs (KCS-5)** | `get_tokens_by_owner` per listed collection + "Add collection by address"; gallery with `token_uri` metadata (image, name), IPFS gateway with allowlist; send NFT (`transfer`) through the same recipient checks | 2 days |
| 7 | **Languages** | extract strings from `app.ts` into `src/i18n/en.json`; add Spanish and Portuguese first (largest Koinos communities after English), then whatever testers offer; language picker in Settings | 1 day + translations |
| 8 | **Polish for store listing** | app icons from `public/icons` via `@capacitor/assets`, splash, Android back button mapping, edge-to-edge system bars (Capacitor 8 System Bars plugin), privacy policy page, Play Store internal testing track; iOS needs an Apple developer account | 1–2 days |

Left out on purpose: push notifications and a news feed (third-party services inside a privacy wallet),
WalletConnect (Koinos dapps use `window.kondor`; revisit if a dapp asks), in-app swaps (no venue worth
the attack surface yet).

## 3. Rules that carry over from the security review

- Nothing new in the signing path: tokens and NFTs reuse `Chain.sendKoin`'s build-sign-verify-submit
  shape with a different contract id and arguments; the recipient checks run for every transfer.
- The dapp browser's provider is the extension's, with the same refusals (own-account calls, uploads,
  raw hash signing, chain-id mismatch) and the same approval screen; the browser never sees keys.
- Biometrics unlock a wrapped key, never store the passphrase or seed; a duress wallet must stay
  indistinguishable, so wrap per slot or offer biometrics for neither.
- Token and dapp lists are data files in the repo, reviewed in pull requests; no remote list fetching
  at runtime until there is a signed-manifest story.
- Every step adds tests: abi-lite decoders against koilib's serializer, jsdom screen tests for new
  screens, and the regression that the shown account address equals the independently derived one.

## 4. What to do before step 1

1. Message Adriano Foschi (Konio) and the Koinos Telegram: lineage, credit, lists, testers.
2. Open the koindx/token-list repo, copy the mainnet and harbinger entries we want into
   `src/data/`, with their MIT notice.
3. Confirm the two mainnet accounts that exist today still open in 0.4.1 (1LQYsd…, and 14Ppx… for
   whoever holds its key), then start the Capacitor 8 branch.

## 5. Sources

Konio repos and site (github.com/konio-io, konio.io), koindx/token-list (MIT), koilib `utils.tokenAbi`,
koinos/koinos-proto `koinos/standards/kcs5.proto`, docs.koinos.io NFT guide (KCS-2), Capacitor 8 upgrade
guide (capacitorjs.com/docs/updating/8-0), npm registry metadata for the plugins named above (checked
2026-10-19), ionic-team/capacitor-os-inappbrowser README, actions/runner-images macOS and Ubuntu
readmes, api.koinosscan.com and api.koinosblocks.com probes (2026-10-19).
