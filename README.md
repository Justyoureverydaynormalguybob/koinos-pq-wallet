# koinos-pq-wallet

A post-quantum wallet for Koinos. The account is controlled by an **ML-DSA-44** key (NIST FIPS 204)
instead of secp256k1. This repo is the browser app plus the signing rules the phone app will mirror.

Status: first working version, testnet first, not audited. Companion to
[koinos-pq](https://github.com/Justyoureverydaynormalguybob/koinos-pq) (the account contract, the
native node change, the measurements).

```
src/core/keys.ts    24 words <-> 32-byte seed -> ML-DSA-44 key -> address      (the spec, keep it exact)
src/core/sign.ts    the two signature formats: pqwallet (contract route) and native (koinos-chain branch)
src/core/vault.ts   encrypted at rest: PBKDF2-SHA256 (600k) + AES-256-GCM, WebCrypto only
src/core/chain.ts   balances, mana, build + sign + send a KOIN transfer, history
src/ui/app.ts       the screens, no framework
test/               vectors shared with the koinos-chain tests, signature formats, vault round trip
```

Want to try it? Read [docs/TESTER-GUIDE.md](docs/TESTER-GUIDE.md) first: what it costs, what to back up,
and the steps for a mainnet account.

## Run it

```
npm install
npm test          # key vectors, signature formats, vault
npm run dev       # http://localhost:5173
npm run build     # static site in dist/, serve from anywhere
```

Everything happens in the browser. There is no server and nothing leaves the page except JSON-RPC
calls to the node you pick (mainnet, Harbinger testnet, or a local devnet).

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

- Create a wallet (24 words, confirmation, passphrase) or import words / a CLI seed, optionally
  with the address of a pqwallet account that already uses the key.
- Shows the native post-quantum address with a QR code, KOIN balance, mana and head block, for
  mainnet, Harbinger or a devnet (RPC configurable).
- Sends KOIN from either kind of account, checks the signature locally before broadcasting, shows
  the transaction id, waits for the block, links to the explorer.
- History from the public REST service where one exists.
- Settings: add/remove pqwallet accounts, show the words again (passphrase required), auto-lock
  time, delete the wallet.
- **Create a pqwallet account** on the current network, in the browser: shows the one-time
  secp256k1 funding address (derived from the seed), waits for mana, uploads the bundled account
  contract (hash-checked, call + transaction + upload authority locked to the contract from block
  one), registers the ML-DSA-44 key with a proof of possession, checks the registered key is this
  wallet's, and saves the account. Same steps as the CLI's `deploy --lock` and `register`.

## Not yet

- A Content Security Policy without `'unsafe-eval'`: koilib's protobuf layer compiles encoders
  with `new Function`, so the page allows eval for its own scripts. The page loads no third-party
  code and escapes everything it renders, which keeps the exposure small, but the clean fix is
  precompiled protobuf code (koilib's static modules or a hand-written serializer for the few
  messages a transfer needs).
- Dapp connection (a Kondor-style provider).
- The phone app (Flutter) with the same rules and the vendored C verifier over FFI.

MIT.
