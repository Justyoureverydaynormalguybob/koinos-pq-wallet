# Security review, 2026-10-18

Three independent reviews before opening the wallet to testers: the browser extension, the wallet
core and web app, and the account contract (koinos-pq). This is not a third-party audit. Everything
below marked fixed is in wallet 0.3.0 and koinos-pq-core 889c63f, and each attack is replayed by an
automated test that fails against the previous release (0.2.1) and passes now. The activation window
(last row of the table) was closed afterwards, in wallet 0.3.1 and koinos-pq-core 0b2a251.

## The short version

- **The contract held up.** No way was found for anyone to move an account without its current
  ML-DSA-44 key. After registration the old secp256k1 key has no power; registration cannot be
  front-run; signatures for one purpose cannot be replayed as another.
- **The extension's approval window could be fooled** into signing something other than what it
  showed. That was the serious part, and it is fixed: the window now builds the transaction it
  shows and signs exactly that, and refuses requests it cannot show honestly.
- Nobody but the author had installed the extension before the fixes, and the web app's own send
  path (build the transfer locally, then sign) was not affected.

## Fixed

| What could happen | Fix |
|---|---|
| A site sent its own transaction id next to harmless-looking operations; the wallet signed the id, which belonged to a different transaction (critical) | The approval window rebuilds the transaction from validated fields; koilib recomputes the merkle root and id; the id the page sent is discarded |
| `signMessage` signed under the transaction context, so a "message" could be a transaction header and the signature a valid transaction signature (high) | Messages are signed under their own context, `koinos/message/1` (`signMessageEntry`), and can never verify as a transaction |
| `signHash` gave a signature over any 32 bytes, which is a blind transaction signature (high) | Refused |
| A string `entry_point` was rendered unescaped in the approval window, so a site could restyle it or overlay a fake form (high) | Operations are rebuilt field by field with strict types; everything rendered is escaped; the extension pages' CSP now forbids frames and forms |
| A KOIN transfer with each field twice showed the first recipient and amount; the chain uses the last (high) | A transfer is shown as one only when every field appears exactly once; anything else is flagged "unusual" |
| A site could ask the account to call its own contract (`set_public_key`, `set_allowed_caller`) or upload code, shown as a generic call: one approval could hand over the account (high) | Calls to any of the wallet's own accounts, uploads and system operations are refused outright |
| The window named the wallet's network, but the chain id came from the page: a "testnet" approval could sign a mainnet transaction (high) | The prepared transaction's chain id must match the wallet's network or it is refused |
| Mana payer, payee and a missing mana limit (which defaults to all the account's mana) were not shown (medium) | All shown, with a note when the site set no limit |
| Unlimited approval windows, focus stealing (medium); requests lost when the browser put the background to sleep (medium); answers delivered to whatever page the tab had moved on to (low); request ids chosen by the page (low) | One window at a time, at most three waiting per site; pending requests in session storage; answers go only to the document that asked; ids made by the wallet; closing the window rejects the request |
| Web app: re-saving settings took the passphrase through an unmasked browser prompt; "Show the words again" made new words; no auto-lock while the words were on screen; one unescaped field (low) | A passphrase form; the same words; auto-lock covers the creation screens; escaped |
| Amounts above 2^64−1 would wrap on the chain (info) | Refused |
| Site headers: no CSP header, `/health` without the security headers (info) | CSP header with `frame-ancestors 'none'`; headers on every path |
| Activation took two transactions. Between them (one block on a quiet network, a few minutes on mainnet because of the mempool's mana hold) the contract was installed while the bootstrap key, whose public key the first transaction revealed, still controlled the account (low) | One transaction installs the contract and registers the key: both land in the same block or neither does. Checked on the devnet: one transaction carrying both operations, the account's nonce at 1, the bootstrap key refused afterwards (`npm run devnet:activation` in koinos-pq-core) |

## Known limits (by design, or for a later contract version)

Two of these concern the contract. After weighing them on 2026-10-18, neither justifies changing
the contract that guards live accounts: neither can move funds, and the second cannot be fully
fixed inside a contract at all.

- **Allow-list scope.** `set_allowed_caller` trusts a contract for every contract and entry point
  that asks the account, keeps working through other contracts, and survives a key rotation. It
  can only ever *refuse*: an allow-listed contract still needs a transaction signed by the
  account's current key (`Pqwallet.ts`, `authorize`: the allow-list returns false or falls through
  to the signature check). So at worst it is less strict than intended, never weaker than a
  normal Koinos account, where any contract reached by a signed transaction can act for it. The
  wallet never sets it and the extension refuses to; only the command-line tool can.
- **Signature padding.** Signatures are not covered by the transaction id, and the contract tries
  every 2,420-byte entry, each a full ML-DSA check (about 6M ticks in interpreted WebAssembly);
  more than six overflow its buffer and fail closed. No funds are at risk. Two costs remain:
  a block producer could pad a pending transaction in which this account signs but does not pay,
  so it reverts; and anyone can send nodes transactions naming such an account as payer with
  junk signatures, making them run checks that are never charged because the transaction is
  rejected. A contract cap could cut the second from six checks to one per transaction, at the
  price of breaking transactions with more than one post-quantum signer, but never to zero: one
  check in interpreted WebAssembly is the floor for any authority contract. The real fix is the
  proposed node change, where the node verifies ML-DSA-44 natively at about the cost of today's
  secp256k1 recovery.
- **Re-upload by the key holder** can switch the authority flags off, which would hand the account
  back to the quantum-vulnerable bootstrap key. Only the holder of the ML-DSA key can do it; the
  wallet never does and the extension refuses uploads.
- **Vault strength** is PBKDF2-SHA256 at 600,000 iterations with a 10-character minimum, the
  strongest WebCrypto offers. A weak passphrase on a copied browser profile can be guessed offline.
- **Strings cannot be wiped.** The seed's hex form and the passphrase live as JavaScript strings
  until garbage collection; the key bytes themselves are zeroed on lock.
- **getAccounts asks for the passphrase** every time (no per-site memory yet).

## How to re-run the checks

```
npm test                 # unit tests, including message and transaction contexts kept apart
npm run e2e:ext          # the extension against the devnet: 14 functional + 9 attack checks
npm run e2e:activation   # hands-free activation of a new wallet on the devnet, then a send
npm run smoke:web        # the built site on Harbinger and mainnet: CSP, onboarding, an existing account
```

`E2E_KEEP_GOING=1 EXT_DIR=<folder>` runs the extension checks against any build, for example an
unzipped older release, and lists every failure instead of stopping at the first.


## Added 2026-10-19 (wallet 0.4.0): duress mode, recipient checks, watch-only, locking

Design notes, so a reviewer knows what each feature promises and what it does not.

**Duress mode** (`src/core/vault.ts`). The stored value is now a file of exactly two slots. Every slot
is AES-256-GCM under a PBKDF2 key with its own salt, over a plaintext padded to a 4 KiB multiple, so
all slots are the same size and shape. A fresh wallet goes into a random slot; the other holds
random bytes encrypted under a 32-byte passphrase that is forgotten at once. Setting up a decoy
replaces that filler with a second wallet (its own 24 words, its own passphrase, `role: "decoy"`).
Unlocking derives a key for every slot whatever happens and opens whichever one authenticates, so
neither the bytes at rest nor the time to unlock reveal whether a decoy exists or where it is. The
extension's approval window opens the file the same way, so a dapp signature requested under duress
is made with the decoy's key. From inside a decoy, "set up a duress wallet" writes to the decoy's own
slot, never the main one (`decoySlotFor`). (**Changed in 0.19.0:** a duress wallet is chosen when the
wallet is created or imported and at no other time, and a slot no longer records a role; see "External
review 2026-11-27", items 4 and 12.) Limits: balances are public on chain, so the decoy only
helps against someone who does not already know the main address; a decoy must be funded and used
to be believable; an attacker who copies the stored file before and after setup can see that one
slot changed (not which wallet it is); the main slot records `hasDecoy` so Settings can show it,
which an attacker in possession of the main passphrase can read, but then they already have
everything. Pre-0.4.0 wallets are wrapped into the two-slot file on their next unlock.

**Address-poisoning protection** (`src/core/addressbook.ts`). The wallet keeps, per wallet (namespace
derived from the seed, so a decoy sees only its own), the addresses it has sent to. Before signing:
an invalid checksum is refused; a first-time recipient must be ticked as compared; a recipient that
matches a used address (or one of the wallet's own) in 4+ leading and 4+ trailing characters, or 7+
at either end, is shown next to the real one with the differing characters marked and needs its last
six characters typed. Contacts live in localStorage in the clear (addresses are public; names are
yours), not in the encrypted vault, because recording a send must not require the passphrase.

**Watch-only accounts** (`src/core/accounts.ts`). Stored in the vault with `mode: "watch"`; shown
with balance, mana and history; excluded from everything that signs, including the extension's
`getAccounts` answer to dapps (`walletAccounts` filters them, `canSign` guards the send path).

**Locking and clipboard** (`src/ui/app.ts`, `src/core/clipboard.ts`). Besides the inactivity timer,
an unlocked tab that becomes hidden (another tab, minimised, screen off) locks after 60 s, unless an
activation is mid-flight. Copying an address schedules a wipe after 60 s: the clipboard is cleared
if it still holds what the wallet put there, or, where the browser refuses to read it back,
regardless. Both are switches in Settings, on by default.

Tests: `test/vault.test.ts` (slots, padding, filler, decoy targeting, legacy upgrade),
`test/addressbook.test.ts`, `test/accounts.test.ts`, and `test/app.test.ts`, which drives the real
screens in jsdom: create, duress setup and both unlocks, watch-only, recipient challenges,
lock-on-hide, clipboard wipe. The browser end-to-end suites (`e2e:ext`, `smoke:web`) still need a
real browser and were not run from the phone session that wrote this.


## Incident 2026-10-19: in-session wallets all derived the same account address (fixed in 0.4.1)

**What happened.** From 0.3.0 (2026-10-18, 21:43) to 0.4.0, `finishSetup` wiped the seed buffer right
after `deriveKeys(seed)`, and `deriveKeys` (koinos-pq-core) kept a reference to that same buffer in
`keys.seed`. Any wallet that was created or imported and then activated *in the same session* derived
its account address with `bootstrapSigner(keys.seed)` from 32 zero bytes. That address is the same for
everyone: `14PpxNmUVA7qeAw1cyASMfJFUd2xDkPUBR`. After a lock and unlock the seed was re-read from the
vault and the address was correct, which is why the first mainnet account (`1LQYsd…`, created before
0.3.0) and later unlocks were fine while a fresh create-and-activate was not.

**Effect.** One wallet registered its ML-DSA-44 key on that shared address on mainnet (contract
installed and key registered on 2026-10-18, funded with 61 KOIN, one transfer made). Every later
wallet that activated in-session reached the same address and was correctly refused: "registered to a
different post-quantum key". No funds were lost and nobody but the first registrant can spend from
that address, because the contract answers only to the registered key. Had a second person *funded*
the address before noticing, they would have paid into the first registrant's account; the chain
history shows only the one funding transaction.

**Fix.** koinos-pq-core `83fc6ac`: `deriveKeys` returns its own copy of the seed. Wallet 0.4.1: the
buffer is wiped only when the keys do not share it, `detectAccount` also looks at the legacy address
and claims it when its registered key is this wallet's (so the first registrant's wallet shows the
account and its 61 KOIN again automatically), and a jsdom regression test asserts the address shown
after creation is the seed's own and not the zero-seed one.

**What the first registrant should do.** Unlock the wallet whose Settings → Advanced "Native
post-quantum address" reads `18JGRZQ9HgQZrf4n7xUZKh6EiCZw4oL8et` in 0.4.1 or later; the account appears
as "Your account". Its 24 words are the only backup, as always.

**Lesson.** A test compared the address the UI showed with the one derived independently from the
stored seed only after the bug; it should have existed from the first activation flow. The devnet
end-to-end run did not catch it because the zero-seed account is perfectly functional: it only
collides.


## Added 2026-10-19 (wallet 0.8.0): QR scanning and biometric unlock (native shells)

**QR scanning** (`src/ui/scan.ts`). The camera plugin returns text; only a checksum-valid Koinos address,
bare or as `koinos:<address>`, reaches the "To" field. Anything else is refused with a message and the
field is left as it was. The scan fills the field only: the recipient checks (first-time, look-alike)
run on submit exactly as for a typed address. The web app and the extension have no scan button and
load none of the camera code (the plugin is imported on demand).

**Biometric unlock** (`src/core/biometrics.ts`). What is stored: the slot's AES key (the same key the
passphrase derives, taken with `deriveBits`) encrypted under a random 32-byte key-wrapping key (KWK)
with AES-GCM, in localStorage next to the vault; the KWK itself in the platform keystore
(`@aparajita/capacitor-secure-storage`: Android KeyStore + EncryptedSharedPreferences, iOS Keychain
with iCloud sync off). The passphrase and the 24 words are never stored. The OS biometric prompt
(`@aparajita/capacitor-biometric-auth`, device PIN fallback disabled) gates the app's read of the KWK.
Every failure (cancel, no key, a blob that does not unwrap, a slot that does not open) falls back to
the passphrase field; nothing is retried silently.

Duress mode stays indistinguishable: the stored blobs cover every slot, one real wrap and the rest
random bytes of the same length; all slots are tried on every biometric unlock, whatever the outcome.
Biometrics belong to one wallet at a time: turning them on from a wallet wraps that wallet's slot and
turns the other slots' blobs into filler, so under pressure the decoy's user can take them over and
the owner can turn them off. A saved change re-encrypts the slot with a fresh salt, so the wrap is
refreshed with the passphrase that saved it; a decoy written over a slot forgets that slot's wrap.

Limits. The KWK is protected by the device keystore, not by the biometric sensor itself: an attacker
with root on an unlocked device can read it and the blob, which is the same trust the OS places in app
data. Biometrics are a convenience over the passphrase, not a second factor; the passphrase remains the
thing to protect. The jsdom tests drive the real screens with a fake keystore and prompt; the plugins
themselves are exercised only on a device.


## Added 2026-10-19 (wallet 0.9.0): the in-app dapp browser (native shells)

**Shape.** `plugins/pq-browser` is the wallet's own Capacitor plugin: a second WebView (Android
`WebView`, iOS `WKWebView` with a non-persistent data store) laid over the app's between the url bar
and the tab bar. It injects one script at document start (`src/ui/dapp-bridge.ts`: a relay, then the
extension's inpage bundle, so the page gets exactly the `window.kondor` the extension provides) and
carries JSON both ways: the page posts through a native bridge object (`PqBridge`), the app answers
through `window.__pqDeliver`. Only http(s) pages load; other schemes are dropped; there are no popups.
No third-party code sits in that path.

**The protocol host** (`src/ui/dapp-host.ts`) plays the extension background's part: `provider:*`
answered from a koilib Provider with no keys; approval commands queued (three per origin, ten-minute
expiry), one sheet at a time. Validation, description and signing are `src/core/approval.ts` and
`src/ui/approval-view.ts`, the same code the extension window runs, so the refusals are identical:
uploads and system operations, calls to any of the wallet's own accounts, raw hash signing, a
transaction for another network, a non-canonical transfer encoding. A request's origin must equal the
origin of the page shown; anything else is answered with an error and never reaches the sheet.

**Permission memory.** Once the user lets a site see the accounts (getAccounts), that origin is
remembered per wallet (seed namespace, like contacts) and not asked again; Settings and the Dapps tab
list the sites and forget them. Nothing about signing is ever remembered.

**No passphrase on the in-app sheet.** The app is already unlocked when a page asks; the tap on
Approve is the consent, as it is for the wallet's own Send. The extension window keeps its passphrase
field because it holds no keys until then.

**Limits.** (Updated 0.14.0.) On both platforms a message now arrives with the origin and the
main-frame flag the WebView itself attributes to it (Android `WebMessageListener`, iOS `WKFrameInfo`);
frames are refused and the message body's own claim about its origin is ignored, see the 2026-10-20
section. The page view is hidden while the sheet is up, so a page cannot draw over the approval. Pages cannot reach the app's WebView, its storage or the vault:
they run at their own origins. The plugin is exercised only on a device; the jsdom tests drive the
screens and the protocol with a fake of it.


## Added 2026-10-19 (wallet 0.10.0): collectibles (KCS-5)

`src/core/nfts.ts` encodes the KCS-5 messages it needs with the same protobuf-lite the KOIN transfer
uses (checked against koilib's serializer fed the standard's definitions) and sends a token through
`Chain.sendCall`, the one signing path: one `call_contract` operation, built, signed, verified locally,
submitted; the recipient checks (first-time, look-alike) run before it exactly as for KOIN.

What the wallet fetches from outside the chain: a token's metadata and picture. Only an `ipfs://` link
(through ipfs.io) or an https link on ipfs.io, cloudflare-ipfs.com, dweb.link or arweave.net is
followed; anything else is shown without a picture. Metadata bigger than 200 kB is dropped. The CSP
of the web app, the site headers and the extension list exactly those hosts for images and fetches;
nothing else can be loaded. There is no curated collection list yet: the lists the plan compared were
unlicensed, so collections are added by address and kept per wallet, like tokens.


## Security audit 2026-10-20 (wallet 0.13.0 → 0.14.0): three independent reviews

Three reviewers (separate agents, no shared notes) read the whole wallet: the vault and duress
design, the native shells, the in-app browser and its protocol, the approval screen, tokens and
collectibles, storage, CI. Everything below was reproduced before it was fixed. What they agreed on:
the key material handling and the signing path are sound; the weak spots were around the keys, not
in them.

### Fixed in 0.14.0

**In-app browser: who is asking.** A page's request carried its origin inside the message body, and
the Android bridge object was callable from any frame. Now the native side reports the origin and
whether the sender is the main frame (`WebMessageListener` with its `sourceOrigin` on Android,
`WKFrameInfo.securityOrigin` and `isMainFrame` on iOS); the host ignores the body's claim, refuses
frames, and accepts `https` only (plain `http` for localhost and private addresses, for developers).
Navigation is reported at commit time so the url bar can never show a page that has not yet loaded.
Media capture is denied, link previews are off.

**One sheet, no substitution.** The request queue was re-entrant: a second message arriving while the
first was being prepared could replace the sheet under the user's finger. The host now claims the
slot before any await, a generation counter invalidates work from a closed page, and a Reject that
lands while a transaction is already being broadcast is ignored rather than reported as a success.
Approve takes no tap for 800 ms after the sheet appears (a tap meant for the page cannot land on
it); tapping the dimmed page rejects; the actions are pinned at the bottom of a scrollable sheet so a
long request cannot push them off screen; the site's host is shown in bold with an `unencrypted`
badge for `http`. `provider:*` calls are rate-limited per origin (60 per 10 s) and `submitBlock` is
not available to pages. A request that arrives after the wallet locked is rejected unseen.

**What the approval screen says.** A call the wallet could not decode was described as a bare
"call contract X" and looked no different from a harmless read. Now: KCS-4 `approve` (a standing
allowance) and `burn`, and KCS-5 `transfer`, are decoded and worded; transfers of tokens the user
added are decoded like curated ones; anything else is labelled *"The wallet cannot tell what this
call does"* with the raw arguments and their length shown. Messages to sign are cleaned of control
and bidi characters for display, capped, and their true byte length is shown.

**Chain id pinned** (core 2003e16). The transaction header's chain id came from the node. Each
network now pins its id; the client refuses a node that reports another, and every header carries the
pinned value, so no node can have the wallet sign for a different chain.

**Duress mode told itself apart.** The main wallet recorded `hasDecoy`, rewrote its own slot and
refreshed its biometric wrap when a decoy was made, while a decoy did none of that; the side stores
(contacts, tokens, sites, collections) were keyed by a hash of the seed, so a second set of keys
appearing in storage was a tell. Now creating a decoy does identical work from either wallet: nothing
is written back to the current slot, biometrics are turned off for every slot, Settings shows the same
text to both and never says whether a decoy exists. Side stores are keyed by slot and every slot's
entries exist from the first unlock on (older seed-keyed stores are moved over once). Deleting the
wallet removes every slot's stores. The padding block grew to 8 KiB so the account count is hidden in
a wider band, and a vault keeps at most 24 accounts.

**Keys after a lock.** A request in flight while the wallet locked could derive an address, or sign,
from a zeroed seed. `detectAccount` and `executePlan` derive what they need before any await and
abort if the key material has been wiped. The seed buffer is wiped after key derivation on every
unlock path, and the recovery words never survive a change of screen.

**Tokens.** A user-added token whose symbol matches a listed one is refused (a look-alike "KOIN"
cannot be added); labels from the chain are cleaned of control and bidi characters and capped (core);
sending to an address that is itself a token or collection contract is refused; a token picked in
Send that cannot be resolved is an error, never a silent fall-back to KOIN; a malformed amount from the
indexer cannot blank the activity list.

**Native shells.** Android: `allowBackup=false` with backup and data-extraction rules that exclude
everything, `FLAG_SECURE` (no screenshots, no recents thumbnail) while the 24 words are on screen and,
when the "Block screenshots" setting is on, all the time (0.15.1; before that it was always on and
would not let the owner screenshot their own address), biometrics restricted to class 3
("strong"), the Keychain item `whenUnlockedThisDeviceOnly` on iOS, a blur cover when the app resigns
active on iOS. Collectible pictures load from ipfs.io, dweb.link and arweave.net only (cloudflare's
gateway was retired); the site sends `Referrer-Policy: no-referrer`.

**CI.** Workflow permissions reduced to `contents: read`; the keystore secret is scoped to the one
step that decodes it; every action is pinned by commit SHA.

### Accepted for now (documented, not fixed)

- ~~Biometric unlock not bound to the enrolment~~ and ~~side stores in plaintext~~: both done in
  0.15.0, see the next section.
- The in-app browser's "desktop site" mode (added for pages whose phone layout cannot be used)
  changes the user agent and layout only; it does not change what the page may ask for.
- Development-only advisories remain in vitest's dependency tree; they do not ship.


## Added 2026-10-20 (wallet 0.15.0): WalletConnect, enrolment-bound biometrics, sealed side stores

**WalletConnect** (`src/core/walletconnect.ts` pure, `src/ui/wc-bridge.ts` the relay side). Dapps
built on `@armana/walletconnect-koinos-sdk-js` (KoinDX, Vortex Bridge) pair through the Reown relay
from a scanned or pasted `wc:` URI, or a `wc:` link opened on the phone. Nothing new is trusted: a
session proposal becomes the same `getAccounts` request the in-app browser makes (always shown, never
remembered), every `koinos_*` method is translated into the DappRequest the wallet already validates,
describes and signs, reads go through the same denylist and per-origin rate limit, and
`koinos_signHash` / `koinos_submitBlock` are refused with the reason. The sheet names the dapp and
shows a warning when the relay's verify step could not confirm the request's origin; a proposal the
relay flags as a scam is refused before any sheet. A request may only name a signer the session was
approved with, and only on the chain the wallet is currently on (the SDK's Harbinger id, from before
the testnet reset, is accepted as this wallet's testnet because it is what dapps send). On every
unlock the sessions on the device are checked against the open wallet's addresses; any session that is
not this wallet's is ended, so a duress wallet neither serves nor shows the main wallet's dapps. The
relay needs a project id (public, free at cloud.reown.com); the wallet does nothing over WalletConnect
until one is entered in Settings or baked in with `VITE_WC_PROJECT_ID`. The WalletConnect packages
(`@reown/walletkit`, `@walletconnect/core`, `@walletconnect/utils`) are loaded on demand and sit
outside the signing path: they see requests and answers, never a key.

**Biometrics bound to the enrolment** (`plugins/pq-bio`, replacing the two third-party plugins).
Android: the key-wrapping key is encrypted under an RSA-2048 key in the AndroidKeyStore created with
user authentication required for every use, `AUTH_BIOMETRIC_STRONG` only (no weak face unlock, no
device PIN) and `setInvalidatedByBiometricEnrollment(true)`; decryption runs only inside a
`BiometricPrompt` `CryptoObject`, so the OS decides whether the finger passed, and a rooted device with
the app's files still cannot unwrap. iOS: a Keychain item under
`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` with `.biometryCurrentSet`, read with the system
prompt. Enrolling or removing a fingerprint or face kills the key on both platforms; the wallet says so
and asks for the passphrase. Each wrapped blob now carries an HMAC of its slot key, so a saved change
(new salt) renews the wrap under a fresh device key without a prompt; filler blobs carry random tags of
the same length. Blobs from before 0.15 are not readable: biometrics are simply off until turned on
again.

**Side stores sealed** (`src/core/sealed-store.ts`). Contacts, added tokens, allowed sites and
collections are AES-256-GCM under a key derived (HKDF-SHA256) from the open slot's own key, padded to
1 KiB blocks with a fresh nonce per write. Every slot has an entry for every store from the first
unlock on; the slots whose key is not at hand hold random filler of exactly a sealed empty store's
size. Someone with the storage but not a passphrase reads nothing: not a contact, not which sites were
allowed, not whether a second wallet exists. Records from 0.14 (plain JSON) are sealed on first read.
Deleting the wallet removes every slot's entries.

**Hand-over items now open.** None of the audit's findings remain. What is left is product work:
the koinos-chain pull request (`~/koinos-pq/docs/PR-koinos-chain.md`), store listings
(`docs/STORE.md`), and a WalletConnect project id of the wallet's own.

## Outsider pen-test 2026-11-22 (wallet 0.17.2), fixes in 0.18.0

A black-box look from two sides: a remote attacker hitting the served app, and a local attacker who has
the phone, the localStorage at rest, or DOM access. No way in was found; two weak points were noted and
one is now fixed.

**Web surface (wallet.koinosproof.com).** Strict CSP (`script-src 'self'`, no inline script), HSTS,
`X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`. No source maps served, no secrets in the bundle. `npm audit` reports
10 findings (8 moderate, 2 critical) and every one is build or test tooling (vitest, tinypool, xcode,
minimatch, uuid, @capacitor/cli); none ship in the served app. The runtime imports are
`@noble/*`, `koilib`, `koinos-pq-core`, `kondor-js`, `qrcode` — none with an advisory.

**Local-attacker pass.** The vault is AES-256-GCM under PBKDF2-SHA256 600k with a per-slot salt and IV,
padded to 8 KiB so slot sizes reveal nothing; the two-slot constant-work unlock makes filler and a hidden
duress decoy indistinguishable at rest. Lock zeroes the key buffers; a hidden tab locks after 60 s;
the clipboard is wiped after 60 s; nothing writes a seed or passphrase to the console or sessionStorage.
The duress tests confirm the decoy leaves no trace. Two weak points:

- *The decrypted seed is held as a JavaScript string* (`vault.seedHex`). Strings are immutable, so on lock
  the key buffers are zeroed but that string lingers until garbage collection. An attacker with a memory
  dump of the unlocked (or just-locked) process could recover it. This is inherent to any browser/JS
  wallet; the window is narrowed, not closed. **Accepted.**
- *Passphrase strength was length-only (10+ characters).* The one at-rest attack that matters is offline
  brute-force of an extracted vault, where a weak passphrase is the weak link. **Fixed in 0.18.0:** a
  strength gate (`src/core/passphrase.ts`) refuses weak passphrases when one is chosen (new wallet, duress
  wallet) — rewarding length, rejecting common passwords, repeats, sequences and single-class — while
  never gating unlock, so an existing wallet still opens.

**New surface since the earlier run — burn and the allowed-caller list (0.16–0.17.2).** A burn gives the
PoB contract authority over the account for one nested call. `Chain.burnKoin` does this atomically —
allow PoB, burn, forbid PoB in a single transaction, all-or-none — and leaves PoB off the allowed list.
The dapp-side risk is a page getting the user to approve its own `set_allowed_caller` (grant a contract
authority) or `set_public_key` (rotate the signing key); both were previously shown on the approval sheet
only as an opaque "the wallet cannot tell what this call does". **Fixed in 0.18.0:** the approval sheet
now renders both in plain words, naming the contract and warning what it grants, so neither can be
slipped past the signer (`src/ui/approval-view.ts`, test `test/approval-authority.test.ts`).

Result: no break. The on-chain gate was re-confirmed with the `koinos-pq` `attack-outsider` negative test
against the current contract; see that repo's SECURITY.md for the chain side.

## Pen test 2026-11-23 (wallet 0.18.0), fixes in 0.18.1

A second, wider pass on the day 0.18.0 was built, aimed at everything added since 0.15.0 that no review
had read: the burn, several accounts from one set of words, the `wc:` link catch, "Reset this site", the
on-chain price, account names, and the 0.18.0 passphrase gate itself. Three parts: two independent
reviewers reading the code as attackers (one on the wallet, one on koinos-pq-core and the contract),
live attacks on the chain (koinos-pq `cli/attack-outsider.mjs`, see that repo's SECURITY.md), and the
web surface again. Not a third-party audit.

**Result.** Nobody without the key moved an account. Five things were wrong and are fixed in 0.18.1; each has a test in `test/pentest-2026-11.test.ts` or `test/passphrase.test.ts` that fails on
0.18.0.

### Fixed in 0.18.1

| What could happen | Fix |
|---|---|
| **A dapp sent a field twice** (high). Protobuf, and so the chain, uses the last occurrence; the approval sheet read the first. A KOIN `approve` with value 0.00000001 followed by a second value of 2^64−1 was shown as "spend up to 0.00000001 KOIN" while the chain would grant everything. The same held for the spender, for a token burn's amount, for a collectible's recipient, and for the 0.18.0 wording of `set_allowed_caller` (forbid then allow read "Stop…") and `set_public_key`. Plain transfers were never affected (`strictTransfer`, 0.3.0). Seen on the sheet in a probe; the chain half rests on protobuf's last-wins rule and was not sent to a node. | `exactly()` in `src/ui/approval-view.ts`: a call is put into words only when its arguments are exactly the expected fields, each once and of the right kind, with nothing else. Anything else is shown raw with "cannot be shown reliably. Do not approve it." |
| **The 0.18.0 passphrase gate counted characters times alphabet** (medium), which the plan had warned against. It accepted `P@ssw0rd123!` (rated 65 bits), `Summer2024!`, `mywallet2026`, `liverpool1892`, `main passphrase 1234` (106 bits) and `wallet wallet wallet wallet` (139 bits). | `src/core/passphrase.ts` rewritten: the passphrase is split into runs of letters, digits and symbols and each is priced as a guesser would try it (a common word, a year, "1234", a keyboard row are cheap; unrelated words and length add up); well-known passwords are refused however they are dressed up. All of the above are refused; four unrelated words, or twelve random characters, pass. A line under the field shows the rating as you type. Still only where a passphrase is chosen, never at unlock. |
| **A site shown one account could ask another to sign** (medium). In the in-app browser the list of accounts a site may see was applied to `getAccounts` only. A site shown account A could name account B (usually findable on the chain, since A paid for its activation) as signer; the request reached the sheet with B's address and no warning. WalletConnect already checked this. | `DappHost` refuses a page request whose signer is not among the accounts that site was shown. |
| **A page could start a WalletConnect pairing without a tap** (medium). The native view reported any main-frame navigation to `wc:…`, a script's or a redirect's included, every three seconds, also for a page put aside. The proposal sheet's heading was the proposer's own claim, not the page that started it, and the three-per-site cap keyed on that claim (a probe queued 39 sheets under 39 claimed origins). | Android reports whether a tap started the navigation and drops redirects; iOS takes it only from the page's own main frame. With a tap the wallet pairs as before. Without one it pairs nothing and shows "wants to connect through WalletConnect" with Connect and Ignore. Links from a page that is not on screen are ignored. The pairing remembers the page it came from, and the sheet warns when the proposal claims another site. At most three WalletConnect requests wait in all. The native half was built by CI but **not run on a device**. |
| **A burn could go out twice after an unclear answer from the node** (medium/low). If the node took the transaction but answered with an error, the wallet reported a failure; pressing Burn again signed a second one, and a burn cannot be undone. | koinos-pq-core `bc018d8`: after an answer that is not the node's own refusal, the transaction id is looked for before anything is reported. Found: it succeeded. Not found: `UnconfirmedSendError`, and the wallet then refuses another burn from that account until the first is found on the chain (shown as done, nothing new signed) or ten minutes have passed. Sends go through the same path. A node that withholds a signed transaction could still broadcast it later, until the account's next transaction uses its nonce; that remains. |
| **`burnKoin` had no test** (medium, as a regression risk). | koinos-pq-core `test/burn.test.ts`: allow PoB, burn, forbid PoB in that order in one transaction, the pinned addresses, the bare burn when PoB is already allowed, the mana limit. |

### Found, not fixed yet

- **A site allowed before 0.17 sees every account, including ones made later** (low): a grant without a
  list means "all".
- **The account name sent to a dapp gives the count away** (low): "Account 3" tells a site there are at
  least three.
- **An answer is not tied to the page that asked** (low, from 0.9): if the page navigates while a reply
  is being prepared, the reply lands in the new page.
- **Lock pressed during an activation** wipes the keys under it (low): the activation would then fail and
  spend its mana. No funds at risk.
- **Two wallets can show in store sizes** (low): a side store over 1 KiB in both slots says both are
  real. Pad every store to one larger size.
- **The dollar figure is whatever the node or the pool says** (info): display only, never used in an
  amount. No markup, NaN or Infinity gets through.

### Checked and found sound

- A dapp cannot get the allow, call, forbid sandwich signed for a contract of its own: a call to the
  signer's own account is refused before the sheet, each derived account has its own key, and the
  contract takes those two calls only as direct operations signed by that account.
- Burn: the VHP always goes to the sender, the PoB address is a constant per network (no name lookup a
  node could answer), the three operations are one transaction, and no link, dapp or WalletConnect
  input reaches it. PoB is off the allowed list of the mainnet account that has burned twice.
- Account derivation (`accountSeed`): separated from every other use of the seed; one account's seed
  gives neither the master nor a sibling; bad account numbers throw; buffers are copied.
- Derived keys are wiped on every lock path. Account names are sealed, escaped wherever shown, and never
  sent to dapps. Activity rows and the WalletConnect log are escaped.
- "Reset this site" can be triggered only by the wallet, and clears only that site's own storage.
- Web surface on wallet.koinosproof.com: the same headers as before, no source maps, no stray files.
  The site still serves **0.15.10** (it deploys by hand), so none of 0.16 to 0.18 is live there.
  `npm audit --omit=dev`: 6 moderate findings, all under `@capacitor/cli` (glob, minimatch, uuid), build
  tooling that does not ship.

## Follow-up 2026-11-24 (wallet 0.18.2): the rest of the pen-test list

Everything left in "Found, not fixed yet" above, taken in turn. Tests: the last block of
`test/pentest-2026-11.test.ts`, `test/dapp-reset.test.ts`, `test/banner.test.ts`, and koinos-pq-core
`test/abi-lite.test.ts`, `test/history.test.ts`.

**Fixed**

- *A site allowed before 0.17 saw every account, including later ones.* A grant is now remembered with
  exactly the accounts that were shown. A grant with no list is no longer answered silently: the site is
  asked again once.
- *The account name sent to a dapp gave the count away.* Every account is called "Sparán account" to a
  dapp; the wallet's own names and numbers stay in the wallet.
- *An answer was not tied to the page that asked.* When the page moves to another site, the old site's
  waiting requests are dropped unanswered and work in flight for them is disowned.
- *Lock during an activation.* Refused, with the reason, until the activation has finished.
- *A balance read for one account could show on another for a few seconds.* `refresh()` discards reads
  when the account or network changed while they were out, as `liveTick` already did.
- *The dollar figure.* A price outside 0.000001 to 10,000 dollars is not shown, and small figures are
  written out in full, never with an exponent.
- *Core:* the argument encoders refuse anything that is not a 25-byte checksummed address; a bool sent
  twice reads as its last value; one unreadable history row is listed as a plain transaction instead of
  blanking the list; `scripts/testnet-burn.mjs` needs `--mainnet` to run there and counts only the
  chain's own refusal as a pass.

**Also in 0.18.2**

- *Leaving a site clears what it stored.* Closing a page, opening another dapp, or typing another site's
  address clears the old site's local and session storage, IndexedDB, caches and script-readable cookies
  first (the relay script does it inside the page, so only that origin is touched), and ends any
  WalletConnect session that page started. A dapp's stale saved connection is what stopped it connecting
  on the next visit. Switching between the wallet's own tabs, or putting the page aside with the list
  button, leaves the page open and clears nothing.
- *Banner messages hide themselves* after 6 to 12 seconds by length (errors 3 seconds longer).

**Left as they are, with the reason**

- *Two wallets can show in side-store sizes.* (**Closed in 0.19.0**, "External review 2026-11-27", item 12.) Fixing it means one fixed size for every store in every
  slot, and entries that belong to the other slot cannot be re-sealed without its key. That is a change
  of storage format to the part that keeps duress mode honest, and it wants its own design and tests
  rather than a line in a batch. The exposure needs a decoy with more than a kilobyte in one store
  (about thirteen named accounts).
- *WalletConnect's own storage is not encrypted.* Closed in 0.18.3, see below.
- *The legacy shared address is taken on the node's word.* Every read is; a second node to cross-check
  would be the fix, for one address that one wallet owns.
- *A node that withholds a signed burn can still broadcast it* until the account's next transaction.
  The wallet now blocks a second burn and finds the first; it cannot recall a signature.

## 0.18.3 (2026-11-24): WalletConnect leaves nothing at rest; account detection survives a node that does not answer

**WalletConnect.** The client library keeps its records in the app's own IndexedDB, unencrypted: session
and pairing topics with their keys, the dapps' names, and the account addresses shared with them. At rest
that named a wallet's dapps and addresses to anyone with the app's data, including someone shown only the
decoy, which duress mode promises cannot happen. Sealing the library's storage would mean replacing its
storage layer, so the rule is instead that a session never outlives an unlocked wallet: on every lock
all sessions and pairings are ended (the dapps are told) and the client's records are cleared, and at
every start anything left over (the app was killed while unlocked, or an older version kept sessions) is
cleared before anything reads it (`WcBridge.endAll`, `wipeWcStorage`, test `test/wc-lock.test.ts`). The
cost: a dapp connected through WalletConnect is connected again after each unlock. The records are
cleared, not the database deleted, because that works while the client still has it open; the client's
own identity key may be written back while it runs and names nothing. Checked against a stand-in for
IndexedDB, not yet on a device.

**Account detection.** A read the node did not answer was taken for "no contract there", so an account
could drop out of the wallet for the whole session when a public node turned a burst away (it showed up
as a test that failed now and then). Detection now tries an unanswered read three times, accepts "no"
only as the node's own verdict, and is tried again in the background when it could not be done
(`src/core/accounts.ts`, test in `test/multi-account.test.ts`). The activation path keeps its own reads
as they were.

## External review 2026-11-27 (wallet 0.18.3), fixes in 0.19.0

A reader outside the project (GitHub user **interfecto**) read the source of the 0.18.3 release: this
repository at `868cffe`, koinos-pq-core at `8b3b04c` and koinos-pq at `13b28d5`, and wrote it up as
[issue #1](https://github.com/Justyoureverydaynormalguybob/koinos-pq-wallet/issues/1). Nothing was run;
every point came from reading. Each point was checked against the code before anything was changed, and
all of them held. The numbers below are the review's own. The command-line tool, the contract build and
the pen-test script are in koinos-pq, whose `docs/SECURITY.md` has the matching section (items 1, 15, 16
and 17).

The core changes are koinos-pq-core `c753ac4`, which this version pins.

Tests: `test/review-2026-11-27.test.ts` (the rules), `test/review-2026-11-27-app.test.ts` (through the
screens), the last test in `test/app-burn.test.ts`, the changed tests in `test/vault.test.ts`,
`test/app.test.ts`, `test/pentest-2026-11.test.ts`, and koinos-pq-core `test/review-2026-11-27.test.ts`
and `test/signer.test.ts`.

### Medium

- **2. The chain id came from the node alone on the dapp path.** A page could say "try it on our
  devnet", point the wallet at its own node, have that node answer with mainnet's chain id, and collect a
  signature mainnet accepts, since an account has the same address and key on every network.
  *Now:* `planRequest` takes the chain id from `Chain.chainId()` (the pin for mainnet and testnet), puts it
  into the header itself, and refuses a page that names another. On a network with no pin (the devnet)
  `Chain.chainId()` refuses a node that answers with a pinned chain's id. The signer is made for that
  chain id and refuses any other (`PqSigner`'s new `chainId`), and it is asked again when the signature
  is made, so a node that changes its story between the sheet and the signature gets nothing. The
  extension goes through the same code.
- **3. Saving any change to the vault emptied the side stores at the next unlock.** "Add account",
  "Watch an address" and "Remove account" wrote the slot under a fresh salt. That changed the slot's
  key, and the key the contacts, tokens, allowed sites, collections and account names are sealed under is
  made from it. After a lock and an unlock they read as empty and the first write overwrote them. That
  also reset the contacts the look-alike address check compares against. This was a real loss of data
  for anyone who used those three screens on 0.15 to 0.18.3, and nothing can bring those entries back.
  *Now:* a save keeps the slot's salt and takes a fresh IV only (`reencryptVault`), so the key stays the
  same. The salt changes only with the passphrase (item 14), and the stores are sealed again in that
  same step.
- **4. Setting up a duress wallet from inside the decoy gave the decoy away.** A decoy could only
  overwrite itself, so the passphrase the coercer had been given stopped working, a test that takes a
  minute and no tools. The review suggested three slots with a pointer in each. Worked through, that only
  moves the tell one step (the coercer sets up a second one from the new wallet), and the pointer itself
  marks the decoy for anyone with its passphrase and the stored file: any design in which an open wallet
  can add a duress wallet has to store something that makes a decoy behave differently from a main
  wallet, and whatever the app can read, so can they.
  *Now:* the operation is gone. A duress wallet is chosen on the passphrase screen when a wallet is
  created or imported on the device, written in the same step as the main one, and at no other time.
  No screen of an open wallet can add, replace or reveal one, so there is nothing to try and nothing
  stored that says which wallet is which (see item 12). The cost: to add or change a duress wallet later,
  delete the wallet from the device and import the 24 words again; what is kept only on the device
  (contacts, added tokens, allowed sites, names) starts empty after that. A wallet that already has a
  duress wallet keeps it.

### Low

- **5. A site could ask an account to sign without ever having been shown it.** The check ran only for
  a site that held a grant with a list. A site that never connected, was revoked, or held a grant from
  before 0.17 could name any address and learn from the answer whether it is this wallet's.
  *Now:* in the app a page may ask an account to sign only if the user showed that account to that site
  (`DappHost.pump`). The sheet also names the account the way the user knows it, not only by address.
  The extension has no grants (every request asks for the passphrase) and is as it was.
- **6. The page picked the transaction's number and the sheet did not show it.** A signature for a
  number ahead of the account's next one cannot go through now, but stays good: a site could say "that
  failed", get the same payment signed again, and use the first signature once the second had landed.
  *Now:* the number is on the sheet, and a transaction a page has numbered ahead of the account's next
  one is refused. koilib numbers from the chain's own count, so an honest dapp never asks for a later
  number; a dapp that signs a chain of transactions in advance would have to put them into one
  transaction instead.
- **7. Send had no hold after an unclear answer from the node.** Burn had one. *Now:* one hold for
  Send, a collectible send and Burn (`settleEarlier`, `held`): after a submission the node gave no clear
  answer to, nothing else that moves value is signed from that account until the earlier transaction is
  found in a block (it is then shown and nothing new is signed) or ten minutes have passed and the node
  says it is in no block. "The node could not be asked" no longer counts as "it is not there"
  (`Chain.txStatus`). The hold lives in memory: closing the app forgets it.
- **8. A KCS-4 memo made normal calls look wrong.** The token standard has an optional memo on
  transfer, approve and burn; the sheet called such a transfer an unusual encoding and told the user not
  to approve such an approve or burn. *Now:* a memo given once, as valid text of at most 256 bytes, is
  part of the plain form and is shown, cleaned of control and direction characters and marked as the
  site's own words. Anything else is still not put into words.
- **9. The account picker could be skipped.** With one known account no list was shown, and the answer
  went out with every account the wallet could find, including one found a moment later. *Now:* the
  answer carries exactly the addresses the sheet showed, and with one account the sheet names it.
- **10. WalletConnect attribution.** A verify result of INVALID is now a danger notice on the sheet, not
  the same footnote as "unknown". For a pairing link from a page: the native "a gesture started this" is
  true also for a tap inside a frame embedded in the page (Android cannot say which frame started a
  top-level navigation) and for a script's `click()` on a link (iOS). The relay script now reports real
  taps in the page itself (`isTrusted`, top frame only), and a link counts as tapped only when both
  agree; otherwise the app asks before pairing. *Needs a device:* that the tap report arrives before the
  link on both platforms. If it does not, the only effect is the extra question.
- **11. Signatures already on a transaction were dropped,** so a transaction a payer had signed first
  failed. *Now:* up to four are kept as they came and the wallet's is added after them; the sheet says
  how many there are. They cannot change what the wallet signs.
- **12. The decoy could be recognised with its passphrase and the stored file.** Three signs, all closed:
  the slot no longer says `role` (nothing in a slot says which wallet it is, and nothing needs to since
  item 4); every side store entry is 16 KiB whatever it holds, where it used to grow past 1 KiB after
  about seven recipients (a store past roughly a hundred contacts or sites takes a second block and does
  show); and a slot or a store entry written by an older version is brought to today's form the first
  time its wallet is unlocked with the passphrase, with the other slot's store entries lengthened to the
  same size at the same moment (that needs no key). Until each wallet has been unlocked once on 0.19 its
  slot keeps what the older version wrote. An unlock by biometrics does not rewrite the slot; the next
  one by passphrase does.
- **13. The lock timers were only timers.** A suspended web view does not run them, and on resume the
  hide timer was cleared. *Now:* both deadlines are clock times (`lockIfOverdue`), checked when the page
  becomes visible, when the app resumes, on the first tap, and on every poll, so an overdue wallet locks
  at the first moment the app runs again. *Needs a device* to confirm the resume events arrive as jsdom
  says they do.
- **14. There was no way to change the passphrase,** so one chosen before the strength check stayed
  weak. *Now:* Settings › Security › Change the passphrase. The same strength check as a new wallet; the
  slot gets a new salt, the side stores are sealed again under the new key, biometrics follow if they
  were this wallet's, and the wallet locks.
- **18. CI exposed the keystore to every step.** *Now:* the job has only a yes/no for the `if:`; the
  keystore is in the environment of the one step that restores it. The workflow has
  `permissions: contents: read`, as this document already claimed.
- **19. iOS shell.** The web view's storage is marked "not for backup" at every launch and when the app
  goes to the background (as `allowBackup="false"` does on Android). The privacy cover for the app
  switcher moved to the scene delegate, where UIKit calls it in a scene-based app. *Needs a device:* the
  iOS app is built unsigned by CI and has never been run.

### Small things

- *`PqSigner.signTransaction` signed an id it was handed.* It now works the id out again from the header
  and the operations and refuses a mismatch; the wallet's dapp path signs through it. `signHash` still
  signs any digest, because koilib's signer interface has it; its comment now says what that means.
- *The activation path still took a failed read for "no contract".* `pqwalletInfo` tries three times and
  then throws; "no contract" is the node's own word only.
- *History showed the first transfer event.* It now shows the KOIN contract's event when there is one,
  and says when a transaction has more than one transfer that names the account.
- *Activating on one network publishes the bootstrap key for all of them.* Said on the activation screen.
- *The words were typed without the screenshot block.* It is now on for the import screen and the
  three-word check.
- *The extension showed no "not encrypted" badge.* It does now.
- *An answer could be sent after the page had moved to another site.* It is now dropped, as this
  document already said.
- *Release files were uploaded by hand.* A tag now publishes its own release from the files that run
  built, with the run and the hashes in the notes (`.github/workflows/mobile.yml`, job `release`).
  **Still open:** the hosted web wallet is deployed from a local tree with `railway up`, so nothing ties
  wallet.koinosproof.com to a commit. Deploying it from CI needs a Railway token as a repository secret.

### Not yet run

Everything above passes its tests on the phone it was written on (jsdom and a fake node). Not run: the
browser suites (`e2e:ext`, `smoke:web`), the Android and iOS builds (CI does those), and anything on a
real device, which the three "needs a device" notes above depend on.

## Passphrase check: random passphrases refused as weak (fixed in 0.19.1)

Reported by the owner on 2026-11-27 from the new "Change the passphrase" screen: a 15-character
passphrase of mixed capitals, small letters and digits with no word in it was refused as weak.

*Cause.* The estimate (`src/core/passphrase.ts`) prices a run of letters either as random letters or as
one word. It called a run random only when it had almost no vowels or five consonants in a row. A random
run that happened to hold a few vowels was therefore priced as a single dictionary word: about 20 bits
for twelve letters that are really worth 56 or more. Measured on generated passphrases, 0.19.0 refused
29% of 15 random mixed-case letters and digits (89 bits) and a third of 12 random small letters.

*Now.* Three changes, none of which touches unlock (the check is still asked only where a passphrase is
chosen):

- A run is also random when fewer than three quarters of its letter pairs are among the 320 pairs that
  make up 99% of the pairs inside real words (counted over the BIP-39 lists in five languages, the 5,000
  most used English, Spanish and Portuguese words and a sample of Irish). The test starts at three
  letters.
- Capitals scattered through a run (not CamelCase, not every other letter) count one bit a letter,
  because each is a separate choice a guesser has to try. They used to count two bits in all.
- Nothing else in the pricing changed: words, years, keyboard rows, repeats and the refused list are as
  they were.

*Measured, 20,000 generated passphrases of each kind, accepted before and after:* 15 random mixed
letters and digits 71% to 98%; 12 random mixed letters plus three digits 67% to 96%; 12 random small
letters 67% to 96%. Weak shapes stay refused: two words run together 0.2% to 0.3%, two capitalised words
plus two digits 0.7% to 1.0%, three words run together 1.7% to 1.9%. Four words with spaces: 97% both.

*Limit.* About one random 15-character passphrase in forty still lands a little under the line, when
its letters happen to read like a word. Adding one more character clears it. The price is an estimate
made without a dictionary; it errs towards refusing.

Tests: `test/passphrase.test.ts` ("accepts random letters and digits even when the letters happen to
hold vowels", "still prices words as words, run together or with capitals in them").
