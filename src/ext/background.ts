// Service worker. Answers the kondor protocol on behalf of dapps:
//   provider:*             -> a koilib Provider for a known network, no user interaction
//   getAccounts, signer:*  -> queued; one approval window at a time; the approval page answers
//
// Nothing secret lives here: keys are only ever decrypted inside the approval page, by passphrase.
// Pending requests are kept in chrome.storage.session (survives the worker being put to sleep,
// gone when the browser closes), keyed by an id this worker generates, never by the page's id.
import { Provider } from "koilib";
import { NETWORKS } from "koinos-pq-core";

interface Pending {
  key: string; // ours
  pageId: string; // the page's request id, echoed back in the answer
  command: string;
  args: Record<string, unknown> | null;
  origin: string;
  tabId?: number;
  documentId?: string;
  frameId?: number;
  windowId?: number; // set once an approval window is open for it
  createdAt: number;
}

const STORE_KEY = "pending";
const EXPIRY_MS = 10 * 60_000;
const MAX_PER_ORIGIN = 3;
const APPROVAL_COMMANDS = new Set(["getAccounts", "signer:signHash", "signer:signMessage", "signer:signTransaction", "signer:sendTransaction", "signer:prepareTransaction"]);
const NETWORK_ALIASES: Record<string, string> = { harbinger: "testnet", koinos: "mainnet", main: "mainnet" };
const EXT_ORIGIN = new URL(chrome.runtime.getURL("")).origin;

// ---- the pending store, serialised so concurrent messages cannot lose entries ----
let chain: Promise<unknown> = Promise.resolve();
function withStore<T>(fn: (all: Record<string, Pending>) => Promise<T> | T): Promise<T> {
  const run = async () => {
    const got = await chrome.storage.session.get(STORE_KEY);
    const all = ((got[STORE_KEY] as Record<string, Pending> | undefined) ?? {}) as Record<string, Pending>;
    const result = await fn(all);
    await chrome.storage.session.set({ [STORE_KEY]: all });
    return result;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

// ---- answering the page ----
function deliver(req: Pending, message: { id: string; result?: unknown; error?: string }) {
  if (req.tabId === undefined) return;
  // only the document that asked gets the answer; if it navigated away, nobody does
  const target = req.documentId ? { documentId: req.documentId } : { frameId: req.frameId ?? 0 };
  chrome.tabs.sendMessage(req.tabId, message, target).catch(() => {});
}

async function finish(key: string, outcome: { result?: unknown; error?: string }) {
  const req = await withStore((all) => {
    const r = all[key];
    delete all[key];
    return r;
  });
  if (!req) return;
  deliver(req, outcome.error !== undefined ? { id: req.pageId, error: outcome.error } : { id: req.pageId, result: outcome.result ?? null });
  if (req.windowId !== undefined) chrome.windows.remove(req.windowId).catch(() => {});
  void pump();
}

/** Opens an approval window for the oldest waiting request if none is open. */
async function pump() {
  const next = await withStore((all) => {
    const now = Date.now();
    for (const [k, r] of Object.entries(all)) {
      if (now - r.createdAt > EXPIRY_MS) {
        delete all[k];
        deliver(r, { id: r.pageId, error: "request expired" });
        if (r.windowId !== undefined) chrome.windows.remove(r.windowId).catch(() => {});
      }
    }
    if (Object.values(all).some((r) => r.windowId !== undefined)) return null;
    const oldest = Object.values(all).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) return null;
    oldest.windowId = -1; // claimed; replaced by the real id below
    return oldest.key;
  });
  if (!next) return;
  try {
    const w = await chrome.windows.create({ url: chrome.runtime.getURL(`approve.html?req=${encodeURIComponent(next)}`), type: "popup", width: 440, height: 780, focused: true });
    await withStore((all) => {
      if (all[next]) all[next]!.windowId = w?.id;
    });
    if (w?.id === undefined) await finish(next, { error: "could not open the approval window" });
  } catch {
    await finish(next, { error: "could not open the approval window" });
  }
}

// the user closed the approval window with the window's own close button
chrome.windows.onRemoved.addListener((windowId) => {
  void withStore((all) => Object.values(all).find((r) => r.windowId === windowId)?.key ?? null).then((key) => {
    if (key) void finish(key, { error: "rejected by the user" });
  });
});

// ---- provider calls (read-only chain access, no approval) ----
function providerFor(network: unknown): Provider {
  const raw = typeof network === "string" && network ? network.toLowerCase() : "mainnet";
  const net = NETWORKS[NETWORK_ALIASES[raw] ?? raw];
  if (!net) throw new Error(`unknown network ${raw}; use mainnet, testnet (harbinger) or devnet`);
  return new Provider(net.rpc);
}

async function handleProvider(command: string, a: Record<string, unknown>): Promise<unknown> {
  const p = providerFor(a.network);
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

// ---- messages ----
chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, sender, sendResponse) => {
  // the approval window is an extension page in its own tab; content scripts carry the web page's origin
  const fromApprovalPage = sender.id === chrome.runtime.id && sender.origin === EXT_ORIGIN && (sender.url ?? "").startsWith(`${EXT_ORIGIN}/approve.html`);

  // --- from the approval page (and only from there) ---
  if (msg.type === "pq:get" || msg.type === "pq:resolve") {
    if (!fromApprovalPage || typeof msg.id !== "string") {
      sendResponse(null);
      return false;
    }
    const key = msg.id;
    if (msg.type === "pq:get") {
      void withStore((all) => all[key] ?? null).then((r) => sendResponse(r ? { id: r.key, command: r.command, args: r.args, origin: r.origin } : null));
      return true;
    }
    void finish(key, msg.error !== undefined ? { error: String(msg.error) } : { result: msg.result }).then(() => sendResponse(true));
    return true;
  }

  // --- relayed from a web page by content.ts ---
  if (!sender.tab || sender.origin === EXT_ORIGIN) return false; // not a content script
  const id = msg.id, command = msg.command, origin = msg.origin;
  if (typeof id !== "string" || id.length > 128 || typeof command !== "string" || typeof origin !== "string") return false;
  const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? (msg.args as Record<string, unknown>) : null;

  if (command === "ping") {
    sendResponse({ id, result: "pong" });
    return false;
  }
  if (command.startsWith("provider:")) {
    handleProvider(command, args ?? {})
      .then((result) => sendResponse({ id, result: result ?? null }))
      .catch((e) => sendResponse({ id, error: (e as Error).message || "request failed" }));
    return true;
  }
  if (APPROVAL_COMMANDS.has(command)) {
    const entry: Pending = {
      key: crypto.randomUUID(),
      pageId: id,
      command,
      args,
      origin,
      tabId: sender.tab.id,
      documentId: (sender as { documentId?: string }).documentId,
      frameId: sender.frameId,
      createdAt: Date.now(),
    };
    void withStore((all) => {
      const waiting = Object.values(all).filter((r) => r.origin === origin).length;
      if (waiting >= MAX_PER_ORIGIN) return false;
      all[entry.key] = entry;
      return true;
    }).then((accepted) => {
      if (!accepted) {
        sendResponse({ id, error: "too many requests waiting for approval from this site" });
        return;
      }
      sendResponse({ id, deferred: true }); // the real answer arrives via chrome.tabs.sendMessage
      void pump();
    });
    return true;
  }
  sendResponse({ id, error: `unsupported command ${command}` });
  return false;
});

// the worker may have been asleep while a window was open: pick up where we left off
void pump();
