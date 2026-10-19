// Accounts a wallet can show, and the subset it can sign for; shared by the web app and the extension.
import { bootstrapAddress, pqwalletInfo, registeredPublicKey, type Chain, type PqKeys } from "koinos-pq-core";
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
}

/** Watch-only accounts are shown but never offered to dapps or used to sign. */
export const canSign = (a: { mode: WalletMode }): boolean => a.mode !== "watch";

/**
 * The account this wallet activates lives at an address derived from the seed, so it can be found on
 * any network without being stored. Returns it when the contract there has this wallet's key registered.
 * Throws when the node cannot be reached, so "unreachable" is never mistaken for "no account".
 */
export async function detectAccount(chain: Chain, keys: PqKeys): Promise<string | null> {
  await chain.headHeight();
  const address = bootstrapAddress(keys);
  const info = await pqwalletInfo(chain, address);
  if (!info.deployed || !info.keyRegistered) return null;
  const pk = await registeredPublicKey(chain, address);
  return pk && pk.length === keys.publicKey.length && pk.every((b, i) => b === keys.publicKey[i]) ? address : null;
}

/**
 * The accounts to offer for signing: stored ones (watch-only excluded), the detected one, and the native
 * address only on the devnet (today's mainnet and Harbinger nodes cannot verify a native ML-DSA-44
 * signature, so it cannot spend there).
 */
export function walletAccounts(keys: PqKeys, stored: Array<{ label: string; address: string; mode: WalletMode }>, networkName: string, detected: string | null): WalletAccount[] {
  const out: WalletAccount[] = [];
  if (networkName === "devnet") out.push({ name: "Post-quantum address (native)", address: keys.address, mode: "native" });
  for (const a of stored) if (canSign(a) && !out.some((x) => x.address === a.address)) out.push({ name: displayLabel(a.label), address: a.address, mode: a.mode });
  if (detected && !out.some((x) => x.address === detected)) out.push({ name: "Your account", address: detected, mode: "pqwallet" });
  return out;
}
