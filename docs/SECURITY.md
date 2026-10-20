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
slot, never the main one (`decoySlotFor`). Limits: balances are public on chain, so the decoy only
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


