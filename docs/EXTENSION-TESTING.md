# Testing the Koinos PQ Wallet browser extension

A developer preview. It is not on the Chrome Web Store yet and it has not been audited, so use
small amounts and an account you would not mind losing.

What it is: the same post-quantum wallet as the web app, as a browser extension. Web pages get
`window.kondor`, the interface Koinos dapps already use for Kondor, so a dapp that works with
Kondor should work with a post-quantum account without any change on the dapp's side. When a dapp
asks for a signature, a small wallet window opens, shows what is being signed, and signs only after
you type your passphrase.

## You need

- Chrome, Brave or Edge on a computer (not a phone).
- The extension zip, `koinos-pq-wallet-extension-<version>.zip`, from
  https://github.com/Justyoureverydaynormalguybob/koinos-pq-wallet/releases (or the repo built with
  `npm run build:ext`).
- A post-quantum account with some KOIN (mainnet) or tKOIN (Harbinger). If you do not have one,
  the wallet's setup screen creates one; see `TESTER-GUIDE.md` for what that costs.
- If you have Kondor installed, **switch it off** for the test (`chrome://extensions`, the toggle on
  Kondor's card). Two wallets answering the same page confuses both. Switch it back on afterwards.

## Install

1. Unzip the file somewhere you will keep it (Chrome loads it from that folder every time).
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and
   pick the unzipped folder (the one that contains `manifest.json`).
3. Click the puzzle-piece icon in the toolbar and pin **Koinos PQ Wallet**.

## Set up the wallet inside the extension

The extension has its own storage. A wallet you made in the web app is not there automatically.

1. Click the toolbar icon. Create a new wallet, or import your 24 words.
2. Settings: pick the network (mainnet or Harbinger). If you already have a pqwallet account, add
   its address there. The wallet also shows your native post-quantum address; on mainnet that one
   cannot sign yet (it needs the node change), so use the pqwallet account for sends.
3. Closing the popup locks the wallet. That is intended.

## Try it on the test page

The test page is a plain web page with no wallet code of its own, so it shows exactly what a real
dapp sees. It is at https://wallet.koinosproof.com/demo/ (or locally with `npm run dev` at
http://localhost:5173/demo/).

1. The page should say "Koinos PQ Wallet extension found". If it says no wallet was found, reload
   the page once after loading the extension.
2. **Connect wallet.** A small window opens naming the page and asking for your passphrase. After
   it, the page lists your addresses. This is what a dapp's "connect" button does.
3. **Head block.** Reads the chain through the extension; no window, nothing to approve.
4. **Sign a message.** Opens the window again; you should get a signature of 2,420 bytes (pqwallet
   account) or 3,733 bytes (native address).
5. **Send KOIN.** Put in an address you control and a small amount. The window should read
   "Send 0.1 KOIN to 1…" in plain words, with the mana limit under it. Approve, and the page shows
   the transaction id and a link to the explorer. Try it once more and press **Reject**: the page
   should show "rejected by the user" and nothing is sent.

Then try a real dapp that supports Kondor. Start with connect only, then something small.

## What to look for

- The approval window should always name the site that asked, and describe a KOIN transfer in
  words, not bytes. If a transfer shows as "Call contract …" instead, the page is using a different
  network from the wallet.
- A wrong passphrase should say so and let you try again, not fail the request.
- Nothing should happen in the page before you approve.

## Report back

The transaction id, your browser, which dapp or page, and anything unclear or wrong. Screenshots
help. Post in the chat where you found this or open an issue on the repo.

## Known limits

- `signMessage` gives a signature no public key can be recovered from. Dapps that check a signed
  message by recovering a secp256k1 key will not accept it.
- `invokeSystemCall` through the provider is not supported (use `provider.call`). Block production
  is not possible from a post-quantum account yet.
- No per-site permissions yet: every `getAccounts` call asks you.
- Firefox is not supported yet.
