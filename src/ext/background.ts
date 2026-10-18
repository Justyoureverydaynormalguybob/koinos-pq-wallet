// Service worker. Answers the kondor protocol on behalf of dapps:
//   provider:*   -> a koilib Provider for the requested network, no user interaction
//   getAccounts, signer:* -> queued, an approval window opens, the approval page answers
// Nothing secret lives here: keys are only ever decrypted inside the approval page, by passphrase.
import { Provider } from "koilib";
import { NETWORKS } from "koinos-pq-core";

interface Req {
  id: string;
  command: string;
  to: "popup" | "background";
  args: Record<string, unknown> | null;
  origin: string;
}
interface Pending extends Req {
  tabId: number | undefined;
  windowId: number | undefined;
  createdAt: number;
}

const pending = new Map<string, Pending>();
const PREF_NETWORK = "koinos-pq-wallet/network";

function providerFor(network: unknown): Provider {
  const n = typeof network === "string" && network ? network : "mainnet";
  const net = NETWORKS[n];
  if (net) return new Provider(net.rpc);
  if (/^https?:\/\//.test(n)) return new Provider([n]);
  throw new Error(`unknown network ${n}`);
}

async function handleProvider(req: Req): Promise<unknown> {
  const a = req.args ?? {};
  const p = providerFor(a.network);
  switch (req.command) {
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
    case "provider:invokeSystemCall":
      // kondor-js passes a koilib Serializer, which cannot cross a JSON message boundary
      throw new Error("invokeSystemCall is not supported by Koinos PQ Wallet; use provider.call");
    case "provider:invokeGetContractMetadata":
      return p.invokeGetContractMetadata(a.contractId as string);
    default:
      throw new Error(`unsupported command ${req.command}`);
  }
}

const APPROVAL_COMMANDS = new Set(["getAccounts", "signer:signHash", "signer:signMessage", "signer:signTransaction", "signer:sendTransaction", "signer:prepareTransaction"]);

async function openApproval(req: Pending): Promise<void> {
  const url = chrome.runtime.getURL(`approve.html?req=${encodeURIComponent(req.id)}`);
  const w = await chrome.windows.create({ url, type: "popup", width: 440, height: 760, focused: true });
  req.windowId = w?.id;
}

function finish(id: string, message: { id: string; result?: unknown; error?: string }) {
  const req = pending.get(id);
  pending.delete(id);
  if (!req) return;
  if (req.tabId !== undefined) chrome.tabs.sendMessage(req.tabId, message).catch(() => {});
  if (req.windowId !== undefined) chrome.windows.remove(req.windowId).catch(() => {});
}

// drop approvals nobody answered within 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, req] of pending) if (req.createdAt < cutoff) finish(id, { id, error: "request expired" });
}, 60_000);

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, sender, sendResponse) => {
  // --- messages from the approval page ---
  if (msg.type === "pq:get") {
    const req = pending.get(msg.id as string);
    sendResponse(req ? { id: req.id, command: req.command, args: req.args, origin: req.origin, network: pref() } : null);
    return false;
  }
  if (msg.type === "pq:resolve") {
    const id = msg.id as string;
    finish(id, msg.error ? { id, error: String(msg.error) } : { id, result: msg.result });
    sendResponse(true);
    return false;
  }
  if (msg.type === "pq:ping") {
    sendResponse("pong");
    return false;
  }

  // --- messages relayed from a page by content.ts ---
  const req = msg as unknown as Req;
  if (typeof req.id !== "string" || typeof req.command !== "string") return false;
  if (req.command === "ping") {
    sendResponse({ id: req.id, result: "pong" });
    return false;
  }
  if (req.command.startsWith("provider:")) {
    handleProvider(req)
      .then((result) => sendResponse({ id: req.id, result: result ?? null }))
      .catch((e) => sendResponse({ id: req.id, error: (e as Error).message || String(e) }));
    return true; // async
  }
  if (APPROVAL_COMMANDS.has(req.command)) {
    const p: Pending = { ...req, tabId: sender.tab?.id, windowId: undefined, createdAt: Date.now() };
    pending.set(req.id, p);
    sendResponse({ id: req.id, deferred: true }); // the real answer arrives via chrome.tabs.sendMessage
    void openApproval(p).catch((e) => finish(req.id, { id: req.id, error: `could not open the approval window: ${(e as Error).message}` }));
    return false;
  }
  sendResponse({ id: req.id, error: `unsupported command ${req.command}` });
  return false;
});

function pref(): string {
  // the wallet pages store the chosen network in localStorage, which a service worker cannot read;
  // the approval page reads it itself. This default only matters for provider calls without a network.
  return "mainnet";
}

chrome.runtime.onInstalled.addListener(() => {
  console.log(`Koinos PQ Wallet background ready (${PREF_NETWORK} is read by pages)`);
});
