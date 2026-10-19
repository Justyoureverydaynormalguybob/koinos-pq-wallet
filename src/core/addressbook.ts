// Address book and address-poisoning protection.
//
// Poisoning: an attacker makes an address whose first and last characters match one you use, sends you
// dust from it so it appears in your history, and waits for you to copy it by mistake. The defence is to
// know which addresses you have actually used, and to shout when a new one merely resembles one of them.
//
// The book lives in localStorage under a namespace derived from the wallet's seed, so each wallet (and a
// duress decoy) sees only its own contacts, and the namespace itself says nothing about the seed.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { utils } from "koilib";

export interface Contact {
  address: string;
  name: string;
  addedAt: string;
  /** successful sends from this wallet */
  sends: number;
  lastSentAt?: string;
}

export type RecipientKind = "invalid" | "own" | "known" | "lookalike" | "new";

export interface Assessment {
  kind: RecipientKind;
  /** for "known": the contact; for "lookalike": the contact it resembles */
  match?: Contact;
}

export const MAX_CONTACTS = 500;
export const MAX_NAME = 40;

export function addressBookNamespace(seed: Uint8Array): string {
  const h = sha256(new Uint8Array([...utf8ToBytes("koinos-pq-wallet/addressbook/1"), ...seed]));
  return bytesToHex(h).slice(0, 24);
}

/** A valid Koinos address with a correct checksum. */
export function isValidAddress(s: string): boolean {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{25,36}$/.test(s) && utils.isChecksumAddress(s);
  } catch {
    return false;
  }
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Does `candidate` resemble `known` closely enough to be a poisoning attempt? Every Koinos address starts
 * with "1", so the first character never counts. Matching 4+ more at the start AND 4+ at the end, or 7+
 * at either end alone, is far beyond chance for base58 (58^-8) and is exactly what poisoners craft.
 */
export function looksLike(candidate: string, known: string): boolean {
  if (candidate === known) return false;
  const p = commonPrefix(candidate.slice(1), known.slice(1));
  const s = commonSuffix(candidate, known);
  return (p >= 4 && s >= 4) || p >= 7 || s >= 7;
}

export interface BookStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const localStore: BookStore = {
  get(k) {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* a blocked store means the book does not persist; the wallet still works */
    }
  },
};

export class AddressBook {
  private readonly key: string;
  private contacts: Contact[];

  constructor(namespace: string, private readonly store: BookStore = localStore) {
    this.key = `koinos-pq-wallet/book/${namespace}`;
    this.contacts = this.read();
  }

  private read(): Contact[] {
    try {
      const raw = this.store.get(this.key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((c): c is Contact => !!c && typeof c === "object" && typeof (c as Contact).address === "string").slice(0, MAX_CONTACTS);
    } catch {
      return [];
    }
  }
  private write() {
    this.store.set(this.key, JSON.stringify(this.contacts));
  }

  list(): Contact[] {
    return [...this.contacts].sort((a, b) => (b.lastSentAt ?? b.addedAt).localeCompare(a.lastSentAt ?? a.addedAt));
  }
  get(address: string): Contact | undefined {
    return this.contacts.find((c) => c.address === address);
  }
  /** Adds or renames. Names are trimmed and capped; an empty name keeps the old one. */
  upsert(address: string, name = ""): Contact {
    const clean = name.trim().slice(0, MAX_NAME);
    let c = this.get(address);
    if (c) {
      if (clean) c.name = clean;
    } else {
      if (this.contacts.length >= MAX_CONTACTS) this.contacts.shift();
      c = { address, name: clean, addedAt: new Date().toISOString(), sends: 0 };
      this.contacts.push(c);
    }
    this.write();
    return c;
  }
  remove(address: string) {
    this.contacts = this.contacts.filter((c) => c.address !== address);
    this.write();
  }
  /** Called after a send is accepted by the chain. */
  recordSend(address: string, name = "") {
    const c = this.upsert(address, name);
    c.sends += 1;
    c.lastSentAt = new Date().toISOString();
    this.write();
  }

  /** What to tell the user about a recipient before they confirm. */
  assess(address: string, ownAddresses: string[] = []): Assessment {
    if (!isValidAddress(address)) return { kind: "invalid" };
    if (ownAddresses.includes(address)) return { kind: "own" };
    const known = this.get(address);
    if (known) return { kind: "known", match: known };
    for (const c of this.contacts) if (looksLike(address, c.address)) return { kind: "lookalike", match: c };
    for (const own of ownAddresses) if (looksLike(address, own)) return { kind: "lookalike", match: { address: own, name: "your own account", addedAt: "", sends: 0 } };
    return { kind: "new" };
  }
}
