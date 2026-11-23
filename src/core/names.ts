// The names a user gives the wallet's accounts ("Savings" instead of "Account 2"). Kept per wallet in its
// sealed side store, like the address book: on this device only, never sent anywhere, never shown to a
// dapp (dapps get the neutral names). The 24 words bring the accounts back, not their names.
import type { BookStore } from "./addressbook";

export const MAX_ACCOUNT_NAME = 32;

/** A name as it is stored and shown: no control or text-direction characters, trimmed, capped. */
export function cleanAccountName(input: string): string {
  return input
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ACCOUNT_NAME);
}

export class AccountNames {
  private readonly key: string;
  private names: Record<string, string>;

  constructor(namespace: string, private readonly store: BookStore) {
    this.key = `koinos-pq-wallet/names/${namespace}`;
    this.names = this.read();
  }
  private read(): Record<string, string> {
    try {
      const raw = this.store.get(this.key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [address, name] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof name === "string" && cleanAccountName(name)) out[address] = cleanAccountName(name);
      }
      return out;
    } catch {
      return {};
    }
  }
  get(address: string): string | null {
    return this.names[address] ?? null;
  }
  /** Names the account; an empty name takes the account back to its default one. */
  set(address: string, name: string) {
    const clean = cleanAccountName(name);
    if (clean) this.names[address] = clean;
    else delete this.names[address];
    this.store.set(this.key, JSON.stringify(this.names));
  }
}
