// WalletConnect for Koinos dapps (KoinDX, Vortex Bridge and anything on @armana/walletconnect-koinos-sdk-js),
// the pure part: which chains and methods the wallet speaks, and how each WalletConnect request becomes
// the same DappRequest the in-app browser and the extension already validate, describe and sign. The
// network part (relay, sessions) is src/ui/wc-bridge.ts; nothing here touches a key.
import { utils } from "koilib";
import type { DappRequest } from "./approval";

/**
 * CAIP-2 chain ids as the dapp SDK sends them: "koinos:" + the first 32 characters of the chain id.
 * The SDK's Harbinger id is the one from before the 2025 testnet reset; it is what every dapp built on
 * the SDK sends for testnet, so it is accepted as this wallet's testnet.
 */
export const WC_CHAINS: Record<string, string> = {
  "koinos:EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3e": "mainnet",
  "koinos:EiBncD4pKRIQWco_WRqo5Q-xnXR7JuO3": "testnet",
};
export const WC_NAMESPACE = "koinos";

export function wcChainFor(networkName: string): string | null {
  for (const [chain, net] of Object.entries(WC_CHAINS)) if (net === networkName) return chain;
  return null;
}

/** Every method the SDK knows; the wallet answers them all except the two it refuses on principle. */
export const WC_METHODS = [
  "koinos_signMessage", "koinos_signHash", "koinos_signTransaction", "koinos_signAndSendTransaction", "koinos_prepareTransaction",
  "koinos_waitForTransaction", "koinos_JsonRpcCall", "koinos_getNonce", "koinos_getNextNonce", "koinos_getAccountRc",
  "koinos_getTransactionsById", "koinos_getBlocksById", "koinos_getHeadInfo", "koinos_getChainId", "koinos_getBlocks", "koinos_getBlock",
  "koinos_sendTransaction", "koinos_readContract", "koinos_submitBlock",
];

export type Translated =
  | { kind: "approval"; req: DappRequest }
  | { kind: "provider"; command: string; args: Record<string, unknown> }
  | { kind: "refuse"; reason: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One WalletConnect request -> what the wallet does with it. `id` is the request id; `origin` the dapp's. */
export function translateRequest(id: string, method: string, params: unknown, origin: string, networkName: string): Translated {
  const p = obj(params);
  const provider = (command: string, args: Record<string, unknown>): Translated => ({ kind: "provider", command, args: { ...args, network: networkName } });
  switch (method) {
    case "koinos_signMessage":
      return { kind: "approval", req: { id, command: "signer:signMessage", args: { signerAddress: p.address, message: p.message }, origin } };
    case "koinos_signHash":
      return { kind: "refuse", reason: "Raw hash signing is turned off in this wallet: a signed hash authorises a transaction you cannot see." };
    case "koinos_signTransaction":
      return { kind: "approval", req: { id, command: "signer:signTransaction", args: { signerAddress: p.address, transaction: p.transaction }, origin } };
    case "koinos_signAndSendTransaction":
      return { kind: "approval", req: { id, command: "signer:sendTransaction", args: { signerAddress: p.address, transaction: p.transaction, optsSend: p.options }, origin } };
    case "koinos_prepareTransaction":
      return { kind: "approval", req: { id, command: "signer:prepareTransaction", args: { signerAddress: p.address, transaction: p.transaction }, origin } };
    case "koinos_waitForTransaction":
      return provider("provider:wait", { txId: p.transactionId, type: p.type, timeout: p.timeout });
    case "koinos_JsonRpcCall":
      return provider("provider:call", { method: p.method, params: p.params });
    case "koinos_getNonce":
      return provider("provider:getNonce", { account: p.address });
    case "koinos_getNextNonce":
      return provider("provider:getNextNonce", { account: p.address });
    case "koinos_getAccountRc":
      return provider("provider:getAccountRc", { account: p.address });
    case "koinos_getTransactionsById":
      return provider("provider:getTransactionsById", { transactionIds: p.transactionIds });
    case "koinos_getBlocksById":
      return provider("provider:getBlocksById", { blockIds: p.blockIds });
    case "koinos_getHeadInfo":
      return provider("provider:getHeadInfo", {});
    case "koinos_getChainId":
      return provider("provider:getChainId", {});
    case "koinos_getBlocks":
      return provider("provider:getBlocks", { height: p.height, numBlocks: p.numBlocks, idRef: p.idRef });
    case "koinos_getBlock":
      return provider("provider:getBlock", { height: p.height });
    case "koinos_sendTransaction":
      return provider("provider:sendTransaction", { transaction: p.transaction, broadcast: p.broadcast });
    case "koinos_readContract":
      return provider("provider:readContract", { operation: p.operation });
    case "koinos_submitBlock":
      return { kind: "refuse", reason: "Submitting blocks is not available through the wallet." };
    default:
      return { kind: "refuse", reason: `${method} is not a Koinos WalletConnect method this wallet knows.` };
  }
}

/** The wallet's answer in the form the dapp SDK expects (signatures as standard base64, like koilib's). */
export function translateResult(method: string, result: unknown): unknown {
  if (method === "koinos_signMessage" && typeof result === "string") return utils.encodeBase64(utils.decodeBase64url(result));
  return result;
}

export interface WcProposalSummary {
  name: string;
  url: string;
  origin: string;
  /** the chains the dapp asked for, as networks this wallet knows ("mainnet", "testnet"); unknown ones listed raw */
  chains: string[];
  requiredChains: string[];
  methods: string[];
  verified: "VALID" | "INVALID" | "UNKNOWN";
}

/** A session proposal reduced to what the sheet shows and the approval needs. Throws when it cannot be served. */
export function summariseProposal(
  params: { proposer: { metadata: { name?: string; url?: string } }; requiredNamespaces?: Record<string, { chains?: string[]; methods?: string[] }>; optionalNamespaces?: Record<string, { chains?: string[]; methods?: string[] }> },
  verified: WcProposalSummary["verified"],
): WcProposalSummary {
  const meta = params.proposer.metadata;
  let origin: string;
  try {
    const u = new URL(meta.url ?? "");
    if (u.protocol !== "https:") throw new Error("not https");
    origin = u.origin;
  } catch {
    throw new Error("The dapp did not give a valid https address.");
  }
  const req = params.requiredNamespaces?.[WC_NAMESPACE], opt = params.optionalNamespaces?.[WC_NAMESPACE];
  const other = Object.keys(params.requiredNamespaces ?? {}).filter((k) => k !== WC_NAMESPACE);
  if (other.length) throw new Error(`The dapp requires ${other.join(", ")} accounts, which this wallet does not have.`);
  const chainsRaw = [...new Set([...(req?.chains ?? []), ...(opt?.chains ?? [])])];
  if (!chainsRaw.length) throw new Error("The dapp did not ask for a Koinos chain.");
  const requiredChains = (req?.chains ?? []).map((c) => WC_CHAINS[c] ?? c);
  const methods = [...new Set([...(req?.methods ?? []), ...(opt?.methods ?? [])])];
  const unknown = (req?.methods ?? []).filter((m) => !WC_METHODS.includes(m));
  if (unknown.length) throw new Error(`The dapp requires methods this wallet does not know: ${unknown.slice(0, 3).join(", ")}.`);
  return { name: String(meta.name ?? origin).slice(0, 80), url: meta.url ?? origin, origin, chains: chainsRaw.map((c) => WC_CHAINS[c] ?? c), requiredChains, methods, verified };
}

/**
 * The namespace the session is approved with: the wallet's accounts on the chain of its current network,
 * every method the dapp may call (the refused ones answer with a refusal, so the dapp learns why), no events.
 * Throws when the dapp requires a chain the wallet is not on.
 */
export function approvedNamespace(summary: WcProposalSummary, networkName: string, addresses: string[]): { chains: string[]; accounts: string[]; methods: string[]; events: string[] } {
  const chain = wcChainFor(networkName);
  if (!chain) throw new Error(`There is no WalletConnect chain for ${networkName}.`);
  const requiredOff = summary.requiredChains.filter((c) => c !== networkName);
  if (requiredOff.length) throw new Error(`The dapp requires ${requiredOff.join(" and ")}; the wallet is on ${networkName}. Switch network in Settings and connect again.`);
  if (!summary.chains.includes(networkName)) throw new Error(`The dapp works on ${summary.chains.join(", ")}; the wallet is on ${networkName}.`);
  if (!addresses.length) throw new Error("This wallet has no account that can sign on this network yet.");
  return { chains: [chain], accounts: addresses.map((a) => `${chain}:${a}`), methods: summary.methods.length ? summary.methods : WC_METHODS, events: [] };
}

/** The network a request's chain names, if the wallet is on it. */
export function networkForChain(chainId: string, networkName: string): string | null {
  const net = WC_CHAINS[chainId];
  return net && net === networkName ? net : null;
}
