// Per-site permission memory for the in-app dapp browser: which origins this wallet has allowed to see
// its account addresses (getAccounts). Signing is never remembered; every signature is approved on its
// own. Kept per wallet under a seed namespace, like the address book and the added tokens.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { BookStore } from "./addressbook";

export const MAX_SITES = 200;

export function permissionsNamespace(seed: Uint8Array): string {
  const h = sha256(new Uint8Array([...utf8ToBytes("koinos-pq-wallet/sites/1"), ...seed]));
  return bytesToHex(h).slice(0, 24);
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
      /* nothing persists; every site asks again */
    }
  },
};

export interface SiteGrant {
  origin: string;
  allowedAt: string;
}

/** Only an https origin (or http on localhost / a plain IP, for the test dapp) can be remembered. */
export function isRememberableOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.origin !== origin) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname));
  } catch {
    return false;
  }
}

export class SitePermissions {
  private readonly key: string;
  private grants: SiteGrant[];

  constructor(namespace: string, private readonly store: BookStore = localStore) {
    this.key = `koinos-pq-wallet/sites/${namespace}`;
    this.grants = this.read();
  }
  private read(): SiteGrant[] {
    try {
      const raw = this.store.get(this.key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((g): g is SiteGrant => !!g && typeof g === "object" && typeof (g as SiteGrant).origin === "string" && isRememberableOrigin((g as SiteGrant).origin)).slice(0, MAX_SITES);
    } catch {
      return [];
    }
  }
  private write() {
    this.store.set(this.key, JSON.stringify(this.grants));
  }
  list(): SiteGrant[] {
    return [...this.grants].sort((a, b) => b.allowedAt.localeCompare(a.allowedAt));
  }
  isAllowed(origin: string): boolean {
    return this.grants.some((g) => g.origin === origin);
  }
  allow(origin: string) {
    if (!isRememberableOrigin(origin)) return;
    if (this.isAllowed(origin)) return;
    if (this.grants.length >= MAX_SITES) this.grants.shift();
    this.grants.push({ origin, allowedAt: new Date().toISOString() });
    this.write();
  }
  revoke(origin: string) {
    this.grants = this.grants.filter((g) => g.origin !== origin);
    this.write();
  }
  revokeAll() {
    this.grants = [];
    this.write();
  }
}
