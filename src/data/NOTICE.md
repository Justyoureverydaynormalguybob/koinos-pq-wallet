# Token and dapp lists

These are the wallet's own lists, kept as data files in the repo and changed only through reviewed
commits. The app never fetches a list at runtime.

- `tokens.mainnet.json`, `tokens.harbinger.json`: KCS-4 tokens shown on the Account tab. The first
  set of contract addresses was taken from the KoinDX default token list
  (https://github.com/koindx/token-list, `package.json` licence: MIT, read 2026-10-19). Every entry's
  name, symbol and decimals were then read from the contract itself on 2026-10-19 with
  `node scripts/check-token-list.mjs`, and the file holds what the chain answered, not what any list
  said. Logos are not copied; the wallet draws a symbol tile instead.
- Added 2026-10-20 from the KoinDX explorer API (https://api.koindx.com/v2/tokens, every token that has
  ever had a KoinDX pool, 154 at the time): the eight tokens with at least $100 of pool liquidity and
  50 trades whose symbol does not collide with an entry already here, each re-read from its contract
  (name, symbol, decimals) before being added. Left out on purpose: two unofficial "ETH" and two
  "USDT" contracts (the bridged ones here are Vortex's vETH and vUSDT; a second token with the same
  symbol is exactly the confusion the recipient checks exist to stop), and the long tail under $100
  of liquidity. Any token can still be added by its address in the app.
- Entry fields follow the shape Konio used (`chainId`, `address`, `symbol`, `name`, `logo`,
  `priceUrl`, `pricePath`, `priceUnit`) plus `decimals` and `website`. `logo` stays `null` until a
  project supplies its own mark under a licence that allows redistribution.

MIT licence of the KoinDX token list (koindx/token-list, author ederaleng):

    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
    associated documentation files (the "Software"), to deal in the Software without restriction,
    including without limitation the rights to use, copy, modify, merge, publish, distribute,
    sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions: The above copyright notice and this
    permission notice shall be included in all copies or substantial portions of the Software.
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
