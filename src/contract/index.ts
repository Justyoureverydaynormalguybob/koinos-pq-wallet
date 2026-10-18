// Loads the bundled pqwallet contract and checks it against the recorded hash before any upload.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Abi } from "koilib";
import wasmUrl from "./pqwallet.wasm?url";
import abiJson from "./pqwallet.abi.json";
import { PQWALLET_WASM_SHA256 } from "./provenance";

export const pqwalletAbi = abiJson as unknown as Abi;

export async function loadPqwalletBytecode(): Promise<Uint8Array> {
  const r = await fetch(wasmUrl);
  if (!r.ok) throw new Error(`could not load the contract (HTTP ${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const digest = bytesToHex(sha256(bytes));
  if (digest !== PQWALLET_WASM_SHA256) throw new Error("bundled contract does not match its recorded hash; refusing to upload");
  return bytes;
}
