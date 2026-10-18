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
