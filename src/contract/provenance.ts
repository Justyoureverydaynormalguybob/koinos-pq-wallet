// The koinos-pq account contract bundled with the wallet, byte for byte the artefact in
// koinos-pq/dist (github.com/Justyoureverydaynormalguybob/koinos-pq, dist/SHA256SUMS), which is the
// build that ran the Harbinger life cycle in that repo's docs/TESTING.md. The wallet verifies the
// hash before uploading, so a corrupted or swapped file can never reach the chain.
export const PQWALLET_WASM_SHA256 = "8b1175cd70c58a015e6f2acee794bf30f5cefa584b25e5963742e9c5e5b3861a";
export const PQWALLET_SOURCE = "koinos-pq dist/pqwallet.wasm (contract/assembly/Pqwallet.ts + wasm/dilithium.wasm, verify-only ML-DSA-44)";
