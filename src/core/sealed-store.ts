// The side stores (contacts, added tokens, allowed sites, collections) sealed under a key that only the
// open wallet has: AES-256-GCM from noble (synchronous, so the stores keep their plain get/set), the
// JSON padded to a 1 KiB multiple, a fresh nonce on every write. The key comes from the vault slot's own
// key through HKDF, so whoever can read local storage but not open the slot reads nothing: not the
// contacts, not which sites were allowed, not how many entries there are beyond the kilobyte.
//
// Every slot has an entry for every store from the first unlock on. The slots whose key is not at hand
// get filler (random bytes of a sealed empty store's size); a slot's wallet replaces its own filler the
// first time it writes. A value from before 0.15 is plain JSON: it is read once and sealed on the spot.
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { BookStore } from "./addressbook";

export const SEAL_BLOCK = 1024;
const NONCE = 12, TAG = 16, LEN = 4;
const PREFIX = "sealed1:";

/** The store key for a wallet: HKDF-SHA256 of its slot key, bound to this purpose. Wipe when the wallet locks. */
export function storeKeyFrom(slotKey: Uint8Array): Uint8Array {
  if (slotKey.length !== 32) throw new Error("bad slot key");
  return hkdf(sha256, slotKey, undefined, utf8ToBytes("koinos-pq-wallet/stores/1"), 32);
}

function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** A 4-byte length, the bytes, zeros up to a block boundary. */
function pad(data: Uint8Array): Uint8Array {
  const total = Math.ceil((LEN + data.length) / SEAL_BLOCK) * SEAL_BLOCK;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, LEN);
  return out;
}
function unpad(b: Uint8Array): Uint8Array {
  if (b.length < LEN) throw new Error("short");
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
  if (LEN + n > b.length) throw new Error("bad length");
  return b.subarray(LEN, LEN + n);
}

export function seal(key: Uint8Array, text: string): string {
  const nonce = randomBytes(NONCE);
  const ct = gcm(key, nonce).encrypt(pad(utf8ToBytes(text)));
  const out = new Uint8Array(NONCE + ct.length);
  out.set(nonce);
  out.set(ct, NONCE);
  return PREFIX + b64(out);
}
/** The text, or null when the value is not sealed under this key (filler, or another wallet's). */
export function unseal(key: Uint8Array, value: string): string | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const b = unb64(value.slice(PREFIX.length));
    if (b.length < NONCE + TAG + LEN) return null;
    return new TextDecoder().decode(unpad(gcm(key, b.subarray(0, NONCE)).decrypt(b.subarray(NONCE))));
  } catch {
    return null;
  }
}
export const isSealed = (v: string | null): boolean => typeof v === "string" && v.startsWith(PREFIX);
/** Random bytes of exactly a sealed empty store's size: what the slots without a key at hand hold. */
export function fillerValue(): string {
  return PREFIX + b64(randomBytes(NONCE + SEAL_BLOCK + TAG));
}

export class SealedStore implements BookStore {
  constructor(
    private readonly key: Uint8Array,
    private readonly inner: BookStore,
  ) {}
  get(k: string): string | null {
    const raw = this.inner.get(k);
    if (raw === null) return null;
    if (isSealed(raw)) return unseal(this.key, raw);
    // plain JSON from before 0.15: sealed now, so it does not stay readable a moment longer
    this.inner.set(k, seal(this.key, raw));
    return raw;
  }
  set(k: string, v: string): void {
    this.inner.set(k, seal(this.key, v));
  }
}
