// The side stores (contacts, added tokens, allowed sites, collections, account names) sealed under a key
// that only the open wallet has: AES-256-GCM from noble (synchronous, so the stores keep their plain
// get/set), the JSON padded to a 16 KiB multiple, a fresh nonce on every write. The key comes from the
// vault slot's own key through HKDF, so whoever can read local storage but not open the slot reads
// nothing: not the contacts, not which sites were allowed, not how many entries there are.
//
// Every slot has an entry for every store from the first unlock on. The slots whose key is not at hand
// get filler (random bytes of a sealed empty store's size); a slot's wallet replaces its own filler the
// first time it writes. A value from before 0.15 is plain JSON: it is read once and sealed on the spot.
//
// ONE SIZE. Until 0.18 the padding was 1 KiB, and a store grew past it after a handful of entries (every
// send records a contact: about seven recipients). A used wallet's stores were therefore larger than an
// unused wallet's or filler, which told the two slots apart to anyone who could read storage (external
// review 2026-11-27, item 12). A store is now 16 KiB whatever it holds, up to roughly a hundred contacts
// or allowed sites; only past that does it take a second block and show. Values written with the old
// padding are brought to the new size at the first unlock: the open wallet's own are sealed again, and
// every other entry (filler, or the other wallet's, which cannot be told apart or opened here) gets random
// bytes appended up to the same length. The wallet that owns such an entry still reads it (the old
// ciphertext is its beginning) and seals it again properly the next time it is opened.
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { BookStore } from "./addressbook";

export const SEAL_BLOCK = 16384;
/** the padding before 0.19: such values are still read, and rewritten at the current size */
export const LEGACY_SEAL_BLOCK = 1024;
const NONCE = 12, TAG = 16, LEN = 4;
/** bytes of one sealed block: every store entry is this long unless it holds more than a block */
const ONE_BLOCK = NONCE + SEAL_BLOCK + TAG;
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
function open(key: Uint8Array, b: Uint8Array): string | null {
  try {
    return new TextDecoder().decode(unpad(gcm(key, b.subarray(0, NONCE)).decrypt(b.subarray(NONCE))));
  } catch {
    return null;
  }
}
/**
 * The text and whether the value is in the current form, or null when it is not sealed under this key
 * (filler, or another wallet's). A value from the 1 KiB padding that was lengthened with random bytes
 * (see lengthen) is found by trying the old sizes it could have had: its ciphertext is the beginning.
 */
function unsealAny(key: Uint8Array, value: string): { text: string; current: boolean } | null {
  if (!value.startsWith(PREFIX)) return null;
  let b: Uint8Array;
  try {
    b = unb64(value.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (b.length < NONCE + TAG + LEN) return null;
  const whole = open(key, b);
  if (whole !== null) return { text: whole, current: (b.length - NONCE - TAG) % SEAL_BLOCK === 0 };
  for (let n = LEGACY_SEAL_BLOCK; NONCE + n + TAG < b.length; n += LEGACY_SEAL_BLOCK) {
    const text = open(key, b.subarray(0, NONCE + n + TAG));
    if (text !== null) return { text, current: false };
  }
  return null;
}
/** The text, or null when the value is not sealed under this key (filler, or another wallet's). */
export function unseal(key: Uint8Array, value: string): string | null {
  return unsealAny(key, value)?.text ?? null;
}
export const isSealed = (v: string | null): boolean => typeof v === "string" && v.startsWith(PREFIX);
/** Random bytes of exactly a sealed empty store's size: what the slots without a key at hand hold. */
export function fillerValue(): string {
  return PREFIX + b64(randomBytes(ONE_BLOCK));
}
/**
 * A sealed value shorter than one block (written with the 1 KiB padding), made one block long by adding
 * random bytes after it; anything else is returned as it is. Needs no key, so it is done for every slot's
 * entries, and afterwards they are all the same length whoever they belong to.
 */
export function lengthen(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  let b: Uint8Array;
  try {
    b = unb64(value.slice(PREFIX.length));
  } catch {
    return value;
  }
  if (b.length >= ONE_BLOCK) return value;
  const out = new Uint8Array(ONE_BLOCK);
  out.set(b);
  out.set(randomBytes(ONE_BLOCK - b.length), b.length);
  return PREFIX + b64(out);
}

export class SealedStore implements BookStore {
  constructor(
    private readonly key: Uint8Array,
    private readonly inner: BookStore,
  ) {}
  get(k: string): string | null {
    const raw = this.inner.get(k);
    if (raw === null) return null;
    if (isSealed(raw)) {
      const got = unsealAny(this.key, raw);
      if (!got) return null;
      if (!got.current) this.inner.set(k, seal(this.key, got.text)); // written with the old padding: now at the current size
      return got.text;
    }
    // plain JSON from before 0.15: sealed now, so it does not stay readable a moment longer
    this.inner.set(k, seal(this.key, raw));
    return raw;
  }
  set(k: string, v: string): void {
    this.inner.set(k, seal(this.key, v));
  }
}
