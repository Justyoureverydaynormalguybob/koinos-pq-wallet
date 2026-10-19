// The read-only side of the kondor protocol (provider:*): a koilib Provider for a known network, no
// user interaction, no keys. Shared by the extension's background worker and the in-app dapp browser.
import { Provider } from "koilib";
import { NETWORKS } from "koinos-pq-core";

const NETWORK_ALIASES: Record<string, string> = { harbinger: "testnet", koinos: "mainnet", main: "mainnet" };

export function providerFor(network: unknown, rpcOverride?: Record<string, string[]>): Provider {
  const raw = typeof network === "string" && network ? network.toLowerCase() : "mainnet";
  const name = NETWORK_ALIASES[raw] ?? raw;
  const net = NETWORKS[name];
  if (!net) throw new Error(`unknown network ${raw}; use mainnet, testnet (harbinger) or devnet`);
  return new Provider(rpcOverride?.[name] ?? net.rpc);
}

export async function handleProvider(command: string, a: Record<string, unknown>, rpcOverride?: Record<string, string[]>): Promise<unknown> {
  const p = providerFor(a.network, rpcOverride);
  switch (command) {
    case "provider:call":
      return p.call(a.method as string, a.params as Record<string, unknown>);
    case "provider:getNonce":
      return p.getNonce(a.account as string);
    case "provider:getNextNonce":
      return p.getNextNonce(a.account as string);
    case "provider:getAccountRc":
      return p.getAccountRc(a.account as string);
    case "provider:getTransactionsById":
      return p.getTransactionsById(a.transactionIds as string[]);
    case "provider:getBlocksById":
      return p.getBlocksById(a.blockIds as string[], a.opts as never);
    case "provider:getHeadInfo":
      return p.getHeadInfo();
    case "provider:getChainId":
      return p.getChainId();
    case "provider:getBlocks":
      return p.getBlocks(a.height as number, a.numBlocks as number, a.idRef as string, a.opts as never);
    case "provider:getBlock":
      return p.getBlock(a.height as number, a.opts as never);
    case "provider:wait":
      return p.wait(a.txId as string, a.type as never, a.timeout as number);
    case "provider:sendTransaction":
      return p.sendTransaction(a.transaction as never, a.broadcast as boolean);
    case "provider:submitBlock":
      return p.submitBlock(a.block as never);
    case "provider:readContract":
      return p.readContract(a.operation as never);
    case "provider:getForkHeads":
      return (p as unknown as { getForkHeads: () => Promise<unknown> }).getForkHeads();
    case "provider:getResourceLimits":
      return (p as unknown as { getResourceLimits: () => Promise<unknown> }).getResourceLimits();
    case "provider:invokeGetContractMetadata":
      return p.invokeGetContractMetadata(a.contractId as string);
    case "provider:invokeSystemCall":
      // kondor-js passes a koilib Serializer, which cannot cross a JSON message boundary
      throw new Error("invokeSystemCall is not supported by Koinos PQ Wallet; use provider.call");
    default:
      throw new Error(`unsupported command ${command}`);
  }
}
