# Make yourself a post-quantum Koinos account (mainnet tester guide)

*Updated 2026-10-18 for wallet 0.3.1. Plain steps, about 10 minutes. Read "Before you start" first; it's the part that matters.*

## What you end up with

A Koinos mainnet account that only an **ML-DSA-44** key can move. ML-DSA is the lattice signature
scheme NIST standardised in 2024 (FIPS 204); large quantum computers are not known to break it,
while the secp256k1 keys every normal Koinos account uses are expected to fall to one. Your account
works with the Koinos you already know: same addresses, same KOIN, same explorer. It just answers to a
different kind of key, held in a small wallet that runs entirely in your browser.

One account on mainnet already works this way: `1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ`, and its first
post-quantum-signed transfer is transaction
`0x12206b839a6fa5c9ac9a0a90ba4fc7a2cd3fb2786bc4927f3d59ab448a45d3726244` (block 40,318,335).

## Before you start

- **This is a showcase for testing.** Built with an AI coding assistant, given a security review
  with the findings fixed, tested on a private chain, on Harbinger and on mainnet, but **not audited
  by a third party**. Use an amount you could lose.
- **Your 24 words are the account.** The wallet shows them once at creation. Write them on paper.
  Lose them and the account is gone for good: there is no secp256k1 key to fall back on, by design.
  The passphrase you choose only protects the wallet in your browser; it does not replace the words.
- **You need about 65 KOIN for a few minutes.** Activating the account installs a small contract
  on it, which is paid with *mana*. At today's mainnet prices that is about 60 KOIN of mana for the
  install and 5 for registering your key. Mana is not spent KOIN: it refills over five days and the
  KOIN stays yours, in the account. The wallet reads the live price and shows the exact figure.
- **Activation is permanent for that address.** From the first block the contract governs the
  account, and the ordinary key that created it has no power over it. That is the point, but it
  means there is no "switch back".
- **Dapps:** anything that just asks "did this account sign?" works. Anything that tries to
  *recover a public key from your signature* (some older integrations do) will not. Kondor cannot
  sign for this account; use this wallet or its browser extension.

## You need

- A current browser on a computer.
- Some KOIN in Kondor (about 70 to be comfortable).

## Steps

1. **Open the wallet:** https://wallet.koinosproof.com. Nothing leaves the page except calls to the
   Koinos node; the site is static files and keeps nothing of yours. If you would rather run it
   yourself (Node.js 20 or newer and git):
   ```
   git clone https://github.com/Justyoureverydaynormalguybob/koinos-pq-wallet
   cd koinos-pq-wallet
   npm install
   npm run dev
   ```
   and open http://localhost:5173.

2. **Pick mainnet** with the selector at the top right once the wallet is open (it starts on
   Harbinger, the test network, which is a free way to try everything first).

3. **Create a wallet.** "Create a new wallet". Write the 24 words down, in order, on paper.
   Confirm the three words it asks for. Choose a passphrase of at least 10 characters.

4. **"Activate your account".** The wallet goes straight to this screen. It shows your account's
   address, a QR code and how much to send. **Copy the address.**

5. **Send KOIN to it from Kondor**, at least the amount shown. Then wait with the tab open. Within
   a few seconds the wallet sees the mana and **activates the account by itself**: it installs the
   contract and registers your key together, in one transaction. Usually under a minute.

6. **"Account ready".** Click **Go to the account**. The home screen shows "Your account" with its
   KOIN balance. You're done. The account answers only to your 24 words from here on.

7. **Prove it to yourself.** **Send** 1 KOIN back to your Kondor address, then look the
   transaction up on https://koinosblocks.com. You will see one signature of 2,420 bytes and no
   secp256k1 anywhere.

## If something goes wrong

- **It keeps saying "needs …"**: the address does not hold enough mana yet. Check the amount you sent.
- **"Activation stopped"**: press **Try again**. It checks the chain first and skips what is already
  done, so nothing is paid twice.
- **"Balance unavailable from this node"**: a node hiccup; mana and the head block still show.
  Refresh in a minute.
- **Auto-lock**: the wallet locks after 10 minutes idle (Settings changes it), but never in the
  middle of an activation. Unlock with the passphrase.
- **Lost the passphrase**: Settings > Delete wallet, then "Import 24 words".
- **Moving to another computer**: import the 24 words there. The wallet finds your account by
  itself, on every network it was activated on.

## What to report back

The transaction id of your first send, your browser and operating system, and anything that was
unclear or felt wrong. Screenshots help. Open an issue on the repo or post in the chat where you
found this.

## For the curious

- Why it works without changing the chain: Koinos lets an account install its own authority rule.
  The installed contract checks an ML-DSA-44 signature over the transaction id instead of secp256k1.
  Details: https://github.com/Justyoureverydaynormalguybob/koinos-pq (`HANDOVER.md`).
- Why it is not slower: https://github.com/Justyoureverydaynormalguybob/koinos-pq/blob/master/docs/THROUGHPUT.md
- The native version (the node verifies ML-DSA itself, no contract, cheaper): a koinos-chain branch
  with tests and a devnet run, waiting on review before a pull request.
- The security review and what it changed: [SECURITY.md](SECURITY.md).

## Using it with dapps (browser extension)

The same wallet also comes as a browser extension that gives web pages `window.kondor`, the
interface Koinos dapps already use for Kondor. A dapp asks for a signature, a small wallet window
opens, you read what is being signed, type your passphrase, and your post-quantum account signs.
Download it from https://github.com/Justyoureverydaynormalguybob/koinos-pq-wallet/releases/latest
and follow [EXTENSION-TESTING.md](EXTENSION-TESTING.md). The extension keeps its own wallet: import
your 24 words into it and it finds your account.


## New in 0.4.0: things to try

- **Duress wallet.** Settings → Duress wallet → create. Then lock and unlock with the duress passphrase:
  you should see a different, empty wallet with no mention of the main one. Activate and fund it a little
  if you want it to look real.
- **Sending to a new address** asks you to tick that you compared the whole address. Sending to an address
  that looks like one you used before (same start and end) shows both with the differences marked and
  asks for its last six characters.
- **Watch an address** (Settings) to keep an eye on an account without its key.
- The tab now locks 60 s after you switch away from it, and the clipboard clears 60 s after you copy an
  address. Both can be turned off in Settings → Locking and clipboard.

## Android app

Download `koinos-pq-wallet-<version>.apk` from the latest `mobile` workflow run (Actions tab, artifact
`android-apk`), check its sha256 against the `.sha256` file next to it, and install it (Android asks you
to allow installs from this source). It is the web wallet in an app: same screens, same rules. The
vault lives inside the app; uninstalling deletes it, and the 24 words are the only way back.
