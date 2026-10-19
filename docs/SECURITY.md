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
