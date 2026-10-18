# Make yourself a post-quantum Koinos account (mainnet tester guide)

*Written 2026-10-18. Plain steps, about 15 minutes. Read "Before you start" first; it's the part that matters.*

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

- **This is test software.** Built with an AI coding assistant, reviewed, tested on a private chain,
  on Harbinger and on mainnet, but **not audited by a third party**. Use an amount you could lose.
- **Your 24 words are the account.** The wallet shows them once at creation. Write them on paper.
  Lose them and the account is gone for good: there is no secp256k1 key to fall back on, by design.
  The passphrase you choose only protects the wallet in your browser; it does not replace the words.
- **You need about 65 KOIN parked for a minute or two.** Creating the account uploads a small
  contract to it, and uploads are paid with *mana*. At today's mainnet prices the upload needs about
  60 KOIN of mana and the registration about 5. Mana is not spent KOIN: it regenerates over five
  days and the KOIN stays yours, in the new account. The wallet reads the live price and tells you
  the exact figure. Prices move; expect roughly this.
- **The setup is permanent for that address.** From the first block, the contract governs the
  account and the ordinary key that created it has no power over it. That is the point, but it
  means there is no "switch back".
- **Dapps:** anything that just asks "did this account sign?" works. Anything that tries to
  *recover a public key from your signature* (some older integrations do) will not. Kondor cannot
  sign for this account; the wallet below is the wallet.
- **Don't send KOIN to the address on the home screen.** That is the account's *native*
  post-quantum address, for a node change that is not on mainnet yet. KOIN sent there is safe but
  stuck until then. Fund only the address the **setup screen** shows.

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

2. **Create a wallet.** "Create a new wallet". Write the 24 words down, in order, on paper.
   Confirm the three words it asks for. Choose a passphrase of at least 10 characters.

3. **Switch to mainnet** with the selector at the top right.

4. **Start the account setup.** On the home screen you'll see a yellow box about the native
   address; click **Create a pqwallet account for mainnet** (also under Settings). The screen shows
   a QR code and a *one-time funding address*. **Copy that address.** It is not the one on the
   home screen.

5. **Fund it from Kondor.** Send about 70 KOIN to the funding address. Within a few seconds the
   line under the QR code changes to "Mana now: 70 (enough)".

6. **Upload and register.** Tick the box, type your passphrase, click **Upload and register**.
   Two transactions follow, each waiting for a block. If you see "waiting for the network to
   release the upload's mana hold", that is normal: after the upload the network keeps its budget on
   hold for about three minutes, and the wallet waits it out. Total: one to four minutes. Keep the
   tab open.

7. **"Account ready".** Click **Go to the account**. The home screen now shows the new account
   with its KOIN balance. You're done. The account answers only to your 24 words from here on.

8. **Prove it to yourself.** **Send** 1 KOIN back to your Kondor address, then look the
   transaction up on https://koinosblocks.com. You will see one signature of 2,420 bytes and no
   secp256k1 anywhere.

## If something goes wrong

- **"insufficient pending account resources"**: the mempool hold described in step 6. The wallet
  retries by itself; if you closed the tab, open the setup again. It skips what is already done.
- **The button stays grey**: the funding address does not yet hold enough mana. Check the amount
  and that you sent to the *setup screen's* address.
- **"Balance unavailable from this node"**: a node hiccup; mana and the head block still show.
  Refresh in a minute.
- **Auto-lock**: the wallet locks after 10 minutes idle (Settings changes it). Unlock with the
  passphrase.
- **Lost the passphrase**: Settings > Delete wallet, then "Import 24 words".
- **Moving to another computer**: import the 24 words there and add the account address under
  Settings > pqwallet accounts (or run the setup again; it will find it already done).

## What to report back

The transaction id of your first send, your browser and operating system, and anything that was
unclear or felt wrong. Screenshots help. Open an issue on the repo or post in the chat where you
found this.

## For the curious

- Why it works without changing the chain: Koinos lets an account install its own authority rule.
  The uploaded contract checks an ML-DSA-44 signature over the transaction id instead of secp256k1.
  Details: https://github.com/Justyoureverydaynormalguybob/koinos-pq (`HANDOVER.md`).
- Why it is not slower: https://github.com/Justyoureverydaynormalguybob/koinos-pq/blob/master/docs/THROUGHPUT.md
- The native version (the node verifies ML-DSA itself, no contract, cheaper): a koinos-chain branch
  with tests and a devnet run, waiting on review before a pull request.

## Using it with dapps (browser extension)

The same wallet also builds as a browser extension that gives web pages `window.kondor`, the
interface Koinos dapps already use for Kondor. A dapp asks for a signature, a small wallet window
opens, you read what is being signed, type your passphrase, and your post-quantum account signs.
There is no store listing yet: build it with `npm run build:ext` and load `dist-extension/` through
`chrome://extensions` (Developer mode, "Load unpacked"). The extension keeps its own wallet, so
import your 24 words into it and add your pqwallet account address in Settings.
