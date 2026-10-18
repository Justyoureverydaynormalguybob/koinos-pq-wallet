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

## Not yet

- A Content Security Policy without `'unsafe-eval'`: koilib's protobuf layer compiles encoders
  with `new Function`, so the page allows eval for its own scripts. The page loads no third-party
  code and escapes everything it renders, which keeps the exposure small, but the clean fix is
  precompiled protobuf code (koilib's static modules or a hand-written serializer for the few
  messages a transfer needs).
- Creating a pqwallet account from inside the wallet (upload + register); use the koinos-pq CLI.
- Dapp connection (a Kondor-style provider).
- The phone app (Flutter) with the same rules and the vendored C verifier over FFI.

MIT.
