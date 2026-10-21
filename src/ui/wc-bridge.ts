// WalletConnect sessions for Sparán: pairing from a scanned or pasted `wc:` URI, session proposals and
// requests turned into the wallet's own DappRequests and put through the DappHost's queue (one sheet,
// one set of rules), answers sent back over the relay. The relay (Reown WalletKit) is loaded on demand
// and needs a project id (free, cloud.reown.com); without one the feature says so and does nothing.
//
// What a session can and cannot do is exactly what a page in the in-app browser can: reads answered at
// once under the same rate limit, every signature approved on the sheet, raw hash signing refused.
// Sessions are checked against the open wallet on every attach: one whose accounts are not this
// wallet's (another wallet on the same device, or a duress wallet looking at the main's) is ended, so
// nothing about another wallet is served or shown.
import type { DappHost, Outcome } from "./dapp-host";
import { approvedNamespace, networkForChain, summariseProposal, translateRequest, translateResult, WC_NAMESPACE, type WcProposalSummary } from "../core/walletconnect";
import { executePlan, planRequest } from "../core/approval";
import type { Network, PqKeys } from "koinos-pq-core";
import type { AccountRecord } from "../core/vault";

type WalletKitModule = typeof import("@reown/walletkit");
type UtilsModule = typeof import("@walletconnect/utils");
type Kit = Awaited<ReturnType<WalletKitModule["WalletKit"]["init"]>>;

export interface WcSession {
  topic: string;
  name: string;
  url: string;
  origin: string;
  accounts: string[];
  expiry: number;
}

export interface WcDeps {
  projectId: () => string;
  network: () => Network;
  keys: () => PqKeys | null;
  accounts: () => AccountRecord[];
  /** the addresses the open wallet can sign for on its network (what a session is approved with) */
  signingAddresses: () => Promise<string[]>;
  onSessionsChanged: () => void;
  /** a readable notice for the user (a proposal refused before the sheet, a dapp disconnecting) */
  notify: (text: string) => void;
  /** one line per step, for the Dapps tab's WalletConnect log (what the relay did, what the dapp asked) */
  log?: (text: string) => void;
}

export const WC_METADATA = {
  name: "Sparán",
  description: "Post-quantum wallet for Koinos",
  url: "https://wallet.koinosproof.com",
  icons: ["https://wallet.koinosproof.com/icons/icon-192.png"],
};

export class WcBridge {
  private kit: Kit | null = null;
  private utils: UtilsModule | null = null;
  private host: DappHost | null = null;
  private deps: WcDeps | null = null;
  private starting: Promise<Kit> | null = null;
  /** topics the open wallet owns; everything else is ended on attach */
  private owned = new Set<string>();

  get configured(): boolean {
    return !!this.deps?.projectId();
  }

  /** The open wallet takes over: its host, its keys, its sessions. Called on every unlock. */
  attach(host: DappHost, deps: WcDeps) {
    this.host = host;
    this.deps = deps;
    if (this.kit) void this.reconcile();
  }
  /** The wallet locked: pending requests are answered, nothing more is served until the next attach. */
  detach() {
    this.host?.dropSource("wc", "the wallet locked");
    this.host = null;
    this.deps = null;
    this.owned.clear();
  }

  private async start(): Promise<Kit> {
    if (this.kit) return this.kit;
    if (this.starting) return this.starting;
    const projectId = this.deps?.projectId();
    if (!projectId) throw new Error("WalletConnect needs a project id: Settings › WalletConnect.");
    this.starting = (async () => {
      const [{ Core }, { WalletKit }, utils] = await Promise.all([import("@walletconnect/core"), import("@reown/walletkit"), import("@walletconnect/utils")]);
      this.utils = utils;
      this.deps?.log?.("starting the relay connection");
      const core = new Core({ projectId });
      const kit = await WalletKit.init({ core, metadata: WC_METADATA });
      core.relayer.on("relayer_connect", () => this.deps?.log?.("relay connected"));
      core.relayer.on("relayer_disconnect", () => this.deps?.log?.("relay disconnected"));
      core.relayer.on("relayer_error", (err: unknown) => this.deps?.log?.(`relay error: ${(err as Error)?.message ?? String(err)}`));
      kit.on("session_proposal", (e) => void this.onProposal(e));
      kit.on("session_request", (e) => void this.onRequest(e));
      kit.on("session_delete", () => {
        this.deps?.log?.("a dapp ended its session");
        this.deps?.onSessionsChanged();
      });
      this.kit = kit;
      await this.reconcile();
      return kit;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** Pairs with a dapp from its URI (scanned or pasted). The proposal then arrives as an event. */
  async pair(uri: string): Promise<void> {
    const u = uri.trim();
    if (!/^wc:[0-9a-f]{64}@2\?/i.test(u)) throw new Error("That is not a WalletConnect code.");
    const kit = await this.start();
    this.deps?.log?.("pairing with the dapp's code");
    try {
      await kit.pair({ uri: u });
    } catch (err) {
      const m = (err as Error).message ?? String(err);
      this.deps?.log?.(`pairing failed: ${m}`);
      throw new Error(/expired/i.test(m) ? "That code has expired: ask the dapp for a fresh one and scan it straight away." : /already|exists/i.test(m) ? "That code was already used; ask the dapp for a fresh one." : m);
    }
    this.deps?.log?.("paired; waiting for the dapp's proposal");
  }

  /** The sessions that belong to the open wallet, for the Dapps tab. */
  async sessions(): Promise<WcSession[]> {
    if (!this.kit || !this.deps) return [];
    return Object.values(this.kit.getActiveSessions())
      .filter((s) => this.owned.has(s.topic))
      .map((s) => this.describe(s));
  }
  /** True once the relay has been started in this app session (so the list is worth rendering). */
  get started(): boolean {
    return this.kit !== null;
  }
  /** Starts the relay if sessions exist from an earlier run, so a dapp's requests reach the wallet. */
  async resume(): Promise<void> {
    if (!this.deps?.projectId()) return;
    try {
      await this.start();
    } catch {
      /* no network: the user can still pair later */
    }
  }

  async disconnect(topic: string): Promise<void> {
    if (!this.kit || !this.utils) return;
    await this.kit.disconnectSession({ topic, reason: this.utils.getSdkError("USER_DISCONNECTED") }).catch(() => undefined);
    this.owned.delete(topic);
    this.deps?.onSessionsChanged();
  }

  private describe(s: { topic: string; peer: { metadata: { name: string; url: string } }; namespaces: Record<string, { accounts: string[] }>; expiry: number }): WcSession {
    let origin = s.peer.metadata.url;
    try {
      origin = new URL(s.peer.metadata.url).origin;
    } catch {
      /* shown as given */
    }
    const accounts = (s.namespaces[WC_NAMESPACE]?.accounts ?? []).map((a) => a.split(":")[2]!).filter(Boolean);
    return { topic: s.topic, name: s.peer.metadata.name, url: s.peer.metadata.url, origin, accounts: [...new Set(accounts)], expiry: s.expiry };
  }

  /** Keeps the sessions of this wallet, ends the rest (another wallet's on this device). */
  private async reconcile() {
    if (!this.kit || !this.deps || !this.utils) return;
    const mine = new Set(await this.deps.signingAddresses().catch(() => [] as string[]));
    this.owned.clear();
    for (const s of Object.values(this.kit.getActiveSessions())) {
      const d = this.describe(s);
      if (d.accounts.length && d.accounts.every((a) => mine.has(a))) this.owned.add(s.topic);
      else await this.kit.disconnectSession({ topic: s.topic, reason: this.utils.getSdkError("USER_DISCONNECTED") }).catch(() => undefined);
    }
    this.deps.onSessionsChanged();
  }

  private async onProposal(e: { id: number; params: Parameters<typeof summariseProposal>[0]; verifyContext: { verified: { validation: "VALID" | "INVALID" | "UNKNOWN"; isScam?: boolean } } }) {
    const kit = this.kit, utils = this.utils, deps = this.deps, host = this.host;
    if (!kit || !utils) return;
    const reject = (message: string) => kit.rejectSession({ id: e.id, reason: { code: 5000, message } }).catch(() => undefined);
    if (!deps || !host) {
      await reject("the wallet is locked");
      return;
    }
    if (e.verifyContext.verified.isScam) {
      await reject("refused");
      deps.notify("A dapp flagged as a scam tried to connect; it was refused.");
      return;
    }
    let summary: WcProposalSummary;
    try {
      summary = summariseProposal(e.params, e.verifyContext.verified.validation);
    } catch (err) {
      deps.log?.(`proposal refused: ${(err as Error).message}`);
      await reject((err as Error).message);
      deps.notify((err as Error).message);
      return;
    }
    deps.log?.(`proposal from ${summary.name} (${summary.origin}): ${summary.chains.join(", ")}, ${summary.methods.length} methods, verify ${summary.verified}`);
    const net = deps.network();
    // the same sheet a page's getAccounts gets, always shown (a pairing is a decision every time)
    const req = { id: `wc-proposal-${e.id}`, command: "getAccounts", args: { wc: { name: summary.name, chains: summary.chains, methods: summary.methods.length } }, origin: summary.origin };
    await host.submit(
      req,
      async (outcome: Outcome) => {
        if (outcome.error !== undefined) {
          deps.log?.(`proposal rejected here: ${outcome.error}`);
          await reject(outcome.error);
          return;
        }
        try {
          const addresses = ((outcome.result as Array<{ address: string }>) ?? []).map((a) => a.address);
          const ns = approvedNamespace(summary, net.name, addresses);
          const namespaces = utils.buildApprovedNamespaces({ proposal: e.params as never, supportedNamespaces: { [WC_NAMESPACE]: ns } });
          const session = await kit.approveSession({ id: e.id, namespaces });
          this.owned.add(session.topic);
          deps.log?.(`session approved with ${summary.name}`);
          deps.onSessionsChanged();
        } catch (err) {
          deps.log?.(`approval failed: ${(err as Error).message}`);
          await reject((err as Error).message);
          deps.notify((err as Error).message);
        }
      },
      { alwaysAsk: true, via: summary.name, unverified: summary.verified !== "VALID" },
    );
  }

  private async onRequest(e: { id: number; topic: string; params: { request: { method: string; params: unknown }; chainId: string }; verifyContext: { verified: { validation: "VALID" | "INVALID" | "UNKNOWN" } } }) {
    const kit = this.kit;
    this.deps?.log?.(`request ${e.params.request.method} on ${e.params.chainId}`);
    if (!kit) return;
    const respond = (o: Outcome) =>
      kit
        .respondSessionRequest({
          topic: e.topic,
          response: o.error !== undefined ? { id: e.id, jsonrpc: "2.0", error: { code: 5000, message: o.error } } : { id: e.id, jsonrpc: "2.0", result: translateResult(e.params.request.method, o.result ?? null) },
        })
        .catch(() => undefined);
    const deps = this.deps, host = this.host;
    if (!deps || !host || !this.owned.has(e.topic)) {
      await respond({ error: "the wallet is locked" });
      return;
    }
    const session = kit.getActiveSessions()[e.topic];
    if (!session) {
      await respond({ error: "unknown session" });
      return;
    }
    const d = this.describe(session);
    const net = deps.network();
    if (!networkForChain(e.params.chainId, net.name)) {
      await respond({ error: `the wallet is on ${net.name}, not the chain this request names` });
      return;
    }
    const t = translateRequest(String(e.id), e.params.request.method, e.params.request.params, d.origin, net.name);
    if (t.kind === "refuse") {
      await respond({ error: t.reason });
      return;
    }
    if (t.kind === "provider") {
      await respond(await host.provider(d.origin, t.command, t.args));
      return;
    }
    // a signer the session was not approved with is not this session's to use
    const signer = t.req.args?.signerAddress;
    if (typeof signer !== "string" || !d.accounts.includes(signer)) {
      await respond({ error: "that account is not part of this session" });
      return;
    }
    await host.submit(t.req, respond, { via: d.name, unverified: e.verifyContext.verified.validation !== "VALID" });
  }
}

/** For tests and the extension: the same translation without a relay (a request answered directly). */
export async function answerDirect(req: Parameters<typeof planRequest>[0], net: Network, keys: PqKeys, accounts: AccountRecord[]) {
  const plan = await planRequest(req, net);
  return executePlan(plan, keys, accounts);
}
