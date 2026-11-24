// Accounts a wallet can show, and the subset it can sign for; shared by the web app and the extension.
import { PQWALLET_ENTRY, bootstrapAddress, decodeGetInfoResult, deriveAccountKeys, isRefusal, registeredPublicKey, wipe, type Chain, type PqKeys } from "koinos-pq-core";

/**
 * Wallets built before 2026-10-19 derived their account address from a wiped (all-zero) seed when the
 * account was activated in the session that created the wallet, so they all used this address. The
 * contract there belongs to whichever key registered first; a wallet whose key that is must still find it.
 */
export const LEGACY_COLLISION_ADDRESS = "14PpxNmUVA7qeAw1cyASMfJFUd2xDkPUBR";
import type { WalletMode } from "./vault";

/**
 * Labels the wallet itself used to store ("pqwallet account (testnet)" and the like). The address is the
 * same on every network, so a network name in the label was misleading; show those as "Your account".
 */
export function displayLabel(label: string): string {
  return /^pqwallet account( \([^)]*\))?$/i.test(label.trim()) ? "Your account" : label;
}

export interface WalletAccount {
  name: string;
  address: string;
  mode: WalletMode;
  /** which of the wallet's keys signs for it: 0 is the key of the 24 words themselves, n the key of account n */
  key: number;
}

/** An account found on the chain from the 24 words: its address and the number of the key that controls it. */
export interface FoundAccount {
  address: string;
  key: number;
}

/** How many unused account numbers in a row end the search for more accounts. */
export const ACCOUNT_GAP = 2;
/** The most accounts a wallet looks for or creates from one set of words. */
export const MAX_DERIVED_ACCOUNTS = 24;

/** What a found account is called until the user names it: "Your account", then "Account 2", "Account 3", ... */
export const accountName = (key: number): string => (key === 0 ? "Your account" : `Account ${key + 1}`);

/** Watch-only accounts are shown but never offered to dapps or used to sign. */
export const canSign = (a: { mode: WalletMode }): boolean => a.mode !== "watch";

/**
 * The account this wallet activates lives at an address derived from the seed, so it can be found on
 * any network without being stored. Returns it when the contract there has this wallet's key registered.
 * Throws when the node cannot be reached, so "unreachable" is never mistaken for "no account".
 */
// The keys of accounts 1, 2, ... are derived from the master seed (koinos-pq-core keys.ts has the rule) and
// kept only as long as the master keys object they belong to: locking wipes them with it.
const rings = new WeakMap<PqKeys, Map<number, PqKeys>>();

/** The keys that sign for account number `key` of this wallet. Account 0's are the wallet's own. */
export function accountKeys(master: PqKeys, key: number): PqKeys {
  if (key === 0) return master;
  if (keysWiped(master)) throw new Error("the wallet is locked");
  let ring = rings.get(master);
  if (!ring) rings.set(master, (ring = new Map()));
  let k = ring.get(key);
  if (!k) {
    k = deriveAccountKeys(master.seed, key);
    ring.set(key, k);
  }
  return k;
}

/** Zeroes every derived account key of this wallet. Call it before wiping the master keys. */
export function wipeAccountKeys(master: PqKeys): void {
  const ring = rings.get(master);
  if (!ring) return;
  for (const k of ring.values()) wipe(k.secretKey, k.seed);
  ring.clear();
}

/**
 * A read that is tried again when the node gives no answer. The public nodes turn bursts away, and a read
 * that failed must never be taken for "nothing there": an account would drop out of the wallet for the
 * whole session. Only the node's own verdict ("contract does not exist") is passed on at once.
 */
async function steady<T>(read: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await read();
    } catch (e) {
      if (isRefusal(e) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}
/** Is the pqwallet contract at this address, with a key registered? "No" only on the node's word; throws when it cannot be asked. */
async function contractAt(chain: Chain, address: string): Promise<{ deployed: boolean; keyRegistered: boolean }> {
  try {
    const info = decodeGetInfoResult(await steady(() => chain.read(address, PQWALLET_ENTRY.get_info)));
    return { deployed: info.publicKeyBytes === 1312, keyRegistered: info.keyRegistered };
  } catch (e) {
    if (isRefusal(e)) return { deployed: false, keyRegistered: false }; // the node judged: no such contract
    throw e;
  }
}

async function activeWith(chain: Chain, address: string, keys: PqKeys): Promise<boolean> {
  const info = await contractAt(chain, address);
  if (!info.deployed || !info.keyRegistered) return false;
  const pk = await steady(() => registeredPublicKey(chain, address));
  return !!pk && pk.length === keys.publicKey.length && pk.every((b, i) => b === keys.publicKey[i]);
}

/**
 * Every account of this wallet that is active on the network: account 0 as detectAccount finds it, then
 * accounts 1, 2, ... at the addresses their own keys give, until ACCOUNT_GAP numbers in a row are unused
 * (a wallet only offers a new account once the ones before it are active, so a gap means the end).
 * Throws when the node cannot be reached, like detectAccount.
 */
export async function detectAccounts(chain: Chain, master: PqKeys, max = MAX_DERIVED_ACCOUNTS): Promise<FoundAccount[]> {
  const out: FoundAccount[] = [];
  const first = await detectAccount(chain, master);
  if (first) out.push({ address: first, key: 0 });
  let misses = 0;
  for (let key = 1; key < max && misses < ACCOUNT_GAP; key++) {
    const keys = accountKeys(master, key); // throws once the wallet has locked
    const address = bootstrapAddress(keys);
    if (await activeWith(chain, address, keys)) {
      out.push({ address, key });
      misses = 0;
    } else misses++;
  }
  return out;
}

/** The number a new account would get: the first one not active yet (0 when the wallet has no account here). */
export function nextAccountKey(found: ReadonlyArray<FoundAccount>): number {
  let key = 0;
  while (found.some((f) => f.key === key)) key++;
  return key;
}

export async function detectAccount(chain: Chain, keys: PqKeys): Promise<string | null> {
  if (keysWiped(keys)) throw new Error("the wallet is locked");
  const bootstrap = bootstrapAddress(keys); // before any await: a lock during the wait zeroes the seed
  await chain.headHeight();
  for (const address of [bootstrap, LEGACY_COLLISION_ADDRESS]) {
    const info = await contractAt(chain, address);
    if (!info.deployed || !info.keyRegistered) continue;
    const pk = await steady(() => registeredPublicKey(chain, address));
    if (pk && pk.length === keys.publicKey.length && pk.every((b, i) => b === keys.publicKey[i])) return address;
  }
  return null;
}

/**
 * The accounts to offer for signing: stored ones (watch-only excluded), the detected one, and the native
 * address only on the devnet (today's mainnet and Harbinger nodes cannot verify a native ML-DSA-44
 * signature, so it cannot spend there).
 */
/** True once lock() has zeroed the key material; nothing may be derived or signed from it then. */
export function keysWiped(keys: PqKeys): boolean {
  return !keys.seed.some((b) => b !== 0) || !keys.secretKey.some((b) => b !== 0);
}

export function walletAccounts(keys: PqKeys, stored: Array<{ label: string; address: string; mode: WalletMode }>, networkName: string, detected: ReadonlyArray<FoundAccount> | string | null): WalletAccount[] {
  const out: WalletAccount[] = [];
  const found: ReadonlyArray<FoundAccount> = typeof detected === "string" ? [{ address: detected, key: 0 }] : detected ?? [];
  if (networkName === "devnet") out.push({ name: "Post-quantum address (native)", address: keys.address, mode: "native", key: 0 });
  // an account added by address works only with the wallet's own key registered on it, unless it is one of the found ones
  for (const a of stored) if (canSign(a) && !out.some((x) => x.address === a.address)) out.push({ name: displayLabel(a.label), address: a.address, mode: a.mode, key: found.find((f) => f.address === a.address)?.key ?? 0 });
  for (const f of found) if (!out.some((x) => x.address === f.address)) out.push({ name: accountName(f.key), address: f.address, mode: "pqwallet", key: f.key });
  return out;
}
