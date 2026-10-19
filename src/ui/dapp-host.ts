// The app's side of the in-app dapp browser: drives the native plugin (open, navigate, close, frame),
// answers the kondor protocol like the extension's background worker does (provider:* straight away,
// approvals one at a time through the app's sheet), and keeps the page from ever seeing a key.
import type { PluginListenerHandle } from "@capacitor/core";
import type { Network, PqKeys } from "koinos-pq-core";
import { APPROVAL_COMMANDS, executePlan, planRequest, type DappRequest, type Plan } from "../core/approval";
import { handleProvider } from "../core/provider-calls";
import type { SitePermissions } from "../core/permissions";
import type { AccountRecord } from "../core/vault";
import { buildBridgeScript, serialiseResult } from "./dapp-bridge";
import type { NavigationEvent, PqBrowserPlugin } from "../native/pq-browser";

export interface PendingApproval {
  key: string;
  req: DappRequest;
  /** what will be done if approved; null when the request was refused (see `refused`) */
  plan: Plan | null;
  refused: string | null;
  /** set while executing, for the sheet's status line */
  status: string | null;
}

export interface HostEvents {
  onNavigation(e: NavigationEvent): void;
  onClosed(): void;
  /** the request waiting for the user (the sheet to show), or null when there is none */
  onApproval(p: PendingApproval | null): void;
}

export interface HostDeps {
  network: () => Network;
  keys: () => PqKeys | null;
  /** the stored accounts of the open wallet (watch-only ones are filtered by the executor) */
  accounts: () => AccountRecord[];
  permissions: () => SitePermissions | null;
  /** rpc endpoints that differ from the defaults (the devnet's configurable node) */
  rpcOverride?: () => Record<string, string[]> | undefined;
  /** the inpage (window.kondor) part of the injected script; the built bundle by default (tests pass a string) */
  bridgeScript?: () => Promise<string>;
}

const MAX_WAITING_PER_ORIGIN = 3;
const EXPIRY_MS = 10 * 60_000;

interface Queued {
  key: string;
  req: DappRequest;
  createdAt: number;
}

export class DappHost {
  private handles: PluginListenerHandle[] = [];
  private queue: Queued[] = [];
  private current: PendingApproval | null = null;
  private opened = false;
  url = "";
  title = "";
  canGoBack = false;

  constructor(private readonly plugin: PqBrowserPlugin, private readonly events: HostEvents, private readonly deps: HostDeps) {}

  get isOpen(): boolean {
    return this.opened;
  }

  async open(url: string, frame: { top: number; bottom: number }): Promise<void> {
    if (!/^https?:\/\//.test(url)) throw new Error("only http(s) pages can be opened");
    await this.listen();
    const script = await buildBridgeScript(this.deps.bridgeScript ? await this.deps.bridgeScript() : undefined); // the relay, then window.kondor
    await this.plugin.open({ url, script, top: frame.top, bottom: frame.bottom });
    this.opened = true;
    this.url = url;
  }
  private async listen() {
    if (this.handles.length) return;
    this.handles.push(
      await this.plugin.addListener("message", (e) => void this.onMessage(e.json)),
      await this.plugin.addListener("navigation", (e) => {
        this.url = e.url;
        this.title = e.title;
        this.canGoBack = e.canGoBack;
        this.events.onNavigation(e);
      }),
      await this.plugin.addListener("closed", () => {
        this.opened = false;
        this.events.onClosed();
      }),
    );
  }
  async navigate(url: string): Promise<void> {
    if (!/^https?:\/\//.test(url)) throw new Error("only http(s) pages can be opened");
    await this.plugin.navigate({ url });
  }
  async back(): Promise<boolean> {
    return (await this.plugin.back()).canGoBack;
  }
  async setFrame(frame: { top: number; bottom: number }): Promise<void> {
    if (this.opened) await this.plugin.setFrame(frame);
  }
  /** The page view is shown only on the Dapps screen with no sheet up; elsewhere it stays loaded but hidden. */
  async show(): Promise<void> {
    if (this.opened && !this.current) await this.plugin.show().catch(() => undefined);
  }
  async hide(): Promise<void> {
    if (this.opened) await this.plugin.hide().catch(() => undefined);
  }
  /** Closes the page; everything still waiting is answered "rejected". */
  async close(): Promise<void> {
    for (const q of this.queue) void this.reply(q.req.id, { error: "rejected by the user" });
    this.queue = [];
    if (this.current) {
      void this.reply(this.current.req.id, { error: "rejected by the user" });
      this.current = null;
      this.events.onApproval(null);
    }
    this.opened = false;
    await this.plugin.close().catch(() => undefined);
    for (const h of this.handles) await h.remove().catch(() => undefined);
    this.handles = [];
    this.events.onClosed();
  }

  // ---- the protocol ----
  private async reply(id: string, outcome: { result?: unknown; error?: string }) {
    const json = JSON.stringify(outcome.error !== undefined ? { id, error: outcome.error } : { id, result: serialiseResult(outcome.result ?? null) });
    await this.plugin.reply({ json }).catch(() => undefined);
  }

  private async onMessage(json: string) {
    let m: { id?: unknown; command?: unknown; args?: unknown; origin?: unknown };
    try {
      m = JSON.parse(json) as typeof m;
    } catch {
      return;
    }
    if (!m || typeof m.id !== "string" || m.id.length > 128 || typeof m.command !== "string" || typeof m.origin !== "string") return;
    // the origin a page claims must be the page the user is looking at
    let pageOrigin = "";
    try {
      pageOrigin = new URL(this.url).origin;
    } catch {
      /* no page yet */
    }
    if (m.origin !== pageOrigin) {
      await this.reply(m.id, { error: "request from an unexpected origin" });
      return;
    }
    const args = m.args && typeof m.args === "object" && !Array.isArray(m.args) ? (m.args as Record<string, unknown>) : null;
    const req: DappRequest = { id: m.id, command: m.command, args, origin: m.origin };
    if (req.command === "ping") {
      await this.reply(req.id, { result: "pong" });
      return;
    }
    if (req.command.startsWith("provider:")) {
      try {
        await this.reply(req.id, { result: (await handleProvider(req.command, args ?? {}, this.deps.rpcOverride?.())) ?? null });
      } catch (e) {
        await this.reply(req.id, { error: (e as Error).message || "request failed" });
      }
      return;
    }
    if (APPROVAL_COMMANDS.has(req.command)) {
      const waiting = this.queue.filter((q) => q.req.origin === req.origin).length + (this.current?.req.origin === req.origin ? 1 : 0);
      if (waiting >= MAX_WAITING_PER_ORIGIN) {
        await this.reply(req.id, { error: "too many requests waiting for approval from this site" });
        return;
      }
      this.queue.push({ key: crypto.randomUUID(), req, createdAt: Date.now() });
      void this.pump();
      return;
    }
    await this.reply(req.id, { error: `unsupported command ${req.command}` });
  }

  /** Takes the oldest waiting request: answers it silently when it may be, else hands it to the sheet. */
  private async pump() {
    if (this.current) return;
    const now = Date.now();
    this.queue = this.queue.filter((q) => {
      if (now - q.createdAt > EXPIRY_MS) {
        void this.reply(q.req.id, { error: "request expired" });
        return false;
      }
      return true;
    });
    const next = this.queue.shift();
    if (!next) {
      await this.plugin.show().catch(() => undefined);
      return;
    }
    const net = this.deps.network();
    let plan: Plan | null = null, refused: string | null = null;
    try {
      plan = await planRequest(next.req, net);
    } catch (e) {
      refused = (e as Error).message || String(e);
    }
    // a site already allowed to see the accounts is answered without asking again
    if (plan && next.req.command === "getAccounts" && this.deps.permissions()?.isAllowed(next.req.origin)) {
      await this.execute(next.req, plan);
      void this.pump();
      return;
    }
    this.current = { key: next.key, req: next.req, plan, refused, status: null };
    await this.plugin.hide().catch(() => undefined);
    this.events.onApproval(this.current);
  }

  private async execute(req: DappRequest, plan: Plan) {
    const keys = this.deps.keys();
    if (!keys) {
      await this.reply(req.id, { error: "the wallet is locked" });
      return;
    }
    try {
      const outcome = await executePlan(plan, keys, this.deps.accounts(), (s) => {
        if (this.current?.req.id === req.id) {
          this.current.status = s;
          this.events.onApproval(this.current);
        }
      });
      await this.reply(req.id, "error" in outcome ? { error: outcome.error } : { result: outcome.result });
      if ("error" in outcome && outcome.status) throw new Error(outcome.status);
    } catch (e) {
      // the page got its answer; the user sees why it failed
      throw e;
    }
  }

  /** The user's decision on the request the sheet shows. Resolves when the page has been answered. */
  async decide(key: string, approve: boolean): Promise<void> {
    const c = this.current;
    if (!c || c.key !== key) return;
    if (!approve || !c.plan) {
      await this.reply(c.req.id, { error: c.refused ? "refused by the wallet" : "rejected by the user" });
      this.current = null;
      this.events.onApproval(null);
      void this.pump();
      return;
    }
    c.status = "Working…";
    this.events.onApproval(c);
    try {
      await this.execute(c.req, c.plan);
      if (c.req.command === "getAccounts") this.deps.permissions()?.allow(c.req.origin);
    } finally {
      this.current = null;
      this.events.onApproval(null);
      void this.pump();
    }
  }
}
