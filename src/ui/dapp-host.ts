// The app's side of the in-app dapp browser: drives the native plugin (open, navigate, close, frame),
// answers the kondor protocol like the extension's background worker does (provider:* straight away,
// approvals one at a time through the app's sheet), and keeps the page from ever seeing a key.
// It is also the one queue every other source of requests goes through (WalletConnect sessions submit
// theirs with submit()), so there is one sheet, one order, one set of rules whoever is asking.
import type { PluginListenerHandle } from "@capacitor/core";
import type { Network, PqKeys } from "koinos-pq-core";
import { APPROVAL_COMMANDS, executePlan, planRequest, type DappRequest, type Plan } from "../core/approval";
import { handleProvider } from "../core/provider-calls";
import type { SitePermissions } from "../core/permissions";
import type { AccountRecord } from "../core/vault";
import { buildBridgeScript, serialiseResult } from "./dapp-bridge";
import type { NavigationEvent, PqBrowserPlugin } from "../native/pq-browser";

export type Outcome = { result?: unknown; error?: string };
export type Respond = (o: Outcome) => Promise<void> | void;

export interface PendingApproval {
  key: string;
  req: DappRequest;
  /** where the request came from: the page in the browser, or a WalletConnect session */
  source: "page" | "wc";
  /** a short label for the sheet when the source is not the page (the dapp's name) */
  via?: string;
  /** shown on the sheet when the source could not be verified (WalletConnect's verify result) */
  unverified?: boolean;
  /** WalletConnect's verify result was INVALID: the request does not come from the domain it names. A danger notice, not a footnote. */
  mismatch?: boolean;
  /** WalletConnect: the origin of the page in the in-app browser whose link started this pairing, when one did */
  startedBy?: string;
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
  /** the open page's "connect" button led to a WalletConnect pairing link: pair with it (the proposal then comes to the sheet) */
  onWcLink?(uri: string, from: { origin: string; gesture: boolean }): void;
}

/** a page gets one pairing attempt per this many ms, so a script cannot keep the wallet pairing */
export const WC_LINK_GAP_MS = 3000;
/** how long before a pairing link the page itself must have reported a real tap for the link to count as tapped */
export const WC_TAP_WINDOW_MS = 3000;

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
/** Everything waiting from WalletConnect together: a proposal names its own origin, so a per-origin cap alone can be walked around. */
const MAX_WAITING_WC = 3;
const EXPIRY_MS = 10 * 60_000;
/** provider:* calls a page may make per origin in a 10 s window (reads for a dapp's UI; not a relay for abuse) */
const PROVIDER_CALLS_PER_WINDOW = 60;
const PROVIDER_WINDOW_MS = 10_000;
/** provider commands a page is never allowed to issue through the wallet */
const PROVIDER_DENIED = new Set(["provider:submitBlock", "provider:invokeSystemCall"]);

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};
/** http is tolerated only for a developer's own machine; everything else must be https. */
export function isAcceptableOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  const h = u.hostname;
  return h === "localhost" || h === "127.0.0.1" || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

interface Queued {
  key: string;
  req: DappRequest;
  createdAt: number;
  source: "page" | "wc";
  respond?: Respond;
  alwaysAsk?: boolean;
  via?: string;
  unverified?: boolean;
  mismatch?: boolean;
  startedBy?: string;
}

export class DappHost {
  private handles: PluginListenerHandle[] = [];
  private queue: Queued[] = [];
  private current: (PendingApproval & { respond?: Respond }) | null = null;
  private opened = false;
  /** bumped by close(): work that was awaiting something when the page closed must not touch the new session */
  private generation = 0;
  private providerCalls = new Map<string, number[]>();
  private lastWcLink = 0;
  /** when the page itself (main frame, the open page's origin) last reported a real tap; see the relay script */
  private lastPageTap = 0;
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
      await this.plugin.addListener("message", (e) => void this.onMessage(e.json, e.origin, e.mainFrame)),
      await this.plugin.addListener("navigation", (e) => {
        if (originOf(this.url) !== originOf(e.url)) this.dropPageRequests();
        this.url = e.url;
        this.title = e.title;
        this.canGoBack = e.canGoBack;
        this.events.onNavigation(e);
      }),
      await this.plugin.addListener("closed", () => {
        this.opened = false;
        this.events.onClosed();
      }),
      await this.plugin.addListener("wcLink", (e) => {
        // The native view dropped the navigation and reports the link. Only a well-formed v2 pairing code
        // from the page that is open goes on, and pairing alone gives a dapp nothing: its proposal still
        // has to be approved on the sheet.
        const uri = typeof e?.url === "string" ? e.url : "";
        const now = Date.now();
        if (!this.opened || !/^wc:[0-9a-f]{64}@2\?/i.test(uri) || now - this.lastWcLink < WC_LINK_GAP_MS) return;
        this.lastWcLink = now;
        let origin = "";
        try {
          origin = new URL(this.url).origin;
        } catch {
          /* no page address yet: the app is told so, and asks before pairing */
        }
        // gesture: only an explicit true counts as a tap, and only when the page itself reported one just
        // before. The native "a gesture started this" is also true for a tap inside a frame embedded in the
        // page (Android cannot say which frame started a top-level navigation) and for a script's click() on
        // a link (iOS); neither is the user tapping the page's own button, and for both the app asks first.
        const tapped = e?.gesture === true && now - this.lastPageTap < WC_TAP_WINDOW_MS;
        this.events.onWcLink?.(uri, { origin, gesture: tapped });
      }),
    );
  }
  async navigate(url: string): Promise<void> {
    if (!/^https?:\/\//.test(url)) throw new Error("only http(s) pages can be opened");
    // typing another site's address into the bar leaves this one: its stored data goes first
    try {
      if (this.url && new URL(url).origin !== new URL(this.url).origin) await this.clearSite();
    } catch {
      /* an address that does not parse is refused by the view itself */
    }
    await this.plugin.navigate({ url });
  }
  async back(): Promise<boolean> {
    return (await this.plugin.back()).canGoBack;
  }
  async setFrame(frame: { top: number; bottom: number }): Promise<void> {
    if (this.opened) await this.plugin.setFrame(frame);
  }
  /** The page view is shown only on the Dapps screen with no sheet up; the app decides when (placeDapp), never the host. */
  async show(): Promise<void> {
    if (this.opened && !this.current) await this.plugin.show().catch(() => undefined);
  }
  async setDesktop(on: boolean): Promise<void> {
    if (this.opened) await this.plugin.setDesktop({ on });
  }
  /** True while a request is being planned or shown: the page must stay hidden under the sheet. */
  get busy(): boolean {
    return this.current !== null;
  }
  async hide(): Promise<void> {
    if (this.opened) await this.plugin.hide().catch(() => undefined);
  }
  /**
   * Clears what the open page's site has stored on this device and reloads it (the relay script does the
   * work inside the page, so only that origin is touched). For a site whose own saved connection state has
   * gone stale and will not connect again.
   */
  async resetSite(): Promise<void> {
    if (!this.opened) return;
    await this.plugin.reply({ json: JSON.stringify({ pqCommand: "clear-site-data" }) });
  }
  private cleared: (() => void) | null = null;
  /**
   * Leaving a site: what it stored on this device (local and session storage, IndexedDB, caches, the
   * cookies a script can reach) is cleared first, by the relay script inside the page, so only that origin
   * is touched. A dapp's saved connection state is what stops it connecting again on the next visit, so no
   * visit leaves any behind. Waits for the page to say it is done, but never long: a page that does not
   * answer is closed all the same.
   */
  async clearSite(waitMs = 1500): Promise<void> {
    if (!this.opened) return;
    const done = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, waitMs);
      this.cleared = () => {
        clearTimeout(t);
        resolve();
      };
    });
    try {
      await this.plugin.reply({ json: JSON.stringify({ pqCommand: "clear-site-data-quiet" }) });
    } catch {
      this.cleared?.(); // the view is already gone: nothing to wait for
    }
    await done;
    this.cleared = null;
  }
  /**
   * The page moved to another site: what the old one asked is dropped unanswered (there is nobody left to
   * answer; an answer sent now would land in the new site's page), and work in flight for it is disowned.
   */
  private dropPageRequests() {
    this.generation++;
    this.queue = this.queue.filter((q) => q.source !== "page");
    if (this.current?.source === "page") {
      this.current = null;
      this.events.onApproval(null);
      void this.pump();
    }
  }
  /** Closes the page, clearing what its site stored first; everything still waiting is answered "rejected". */
  async close(): Promise<void> {
    await this.clearSite();
    this.generation++;
    for (const q of this.queue) if (q.source === "page") void this.reply(q.req.id, { error: "rejected by the user" });
    this.queue = this.queue.filter((q) => q.source !== "page");
    if (this.current?.source === "page") {
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
  private async reply(id: string, outcome: Outcome) {
    const json = JSON.stringify(outcome.error !== undefined ? { id, error: outcome.error } : { id, result: serialiseResult(outcome.result ?? null) });
    await this.plugin.reply({ json }).catch(() => undefined);
  }
  /** Answers whoever asked: the page through the plugin, another source through its own callback. */
  private async answer(q: { req: DappRequest; respond?: Respond }, outcome: Outcome) {
    if (q.respond) {
      try {
        await q.respond(outcome);
      } catch {
        /* the session may be gone; nothing else to do */
      }
    } else await this.reply(q.req.id, outcome);
  }

  /**
   * A request from outside the page (a WalletConnect session): same queue, same rules, same sheet.
   * `respond` carries the answer back. `alwaysAsk` shows the sheet even for a site already allowed
   * (a new pairing is always a decision). Resolves once queued; the answer comes through `respond`.
   */
  async submit(req: DappRequest, respond: Respond, o: { alwaysAsk?: boolean; via?: string; unverified?: boolean; mismatch?: boolean; startedBy?: string } = {}): Promise<void> {
    if (!APPROVAL_COMMANDS.has(req.command)) {
      await respond({ error: `unsupported command ${req.command}` });
      return;
    }
    const waiting = this.queue.filter((q) => q.req.origin === req.origin).length + (this.current?.req.origin === req.origin ? 1 : 0);
    const waitingWc = this.queue.filter((q) => q.source === "wc").length + (this.current?.source === "wc" ? 1 : 0);
    if (waiting >= MAX_WAITING_PER_ORIGIN || waitingWc >= MAX_WAITING_WC) {
      await respond({ error: "too many requests waiting for approval" });
      return;
    }
    this.queue.push({ key: crypto.randomUUID(), req, createdAt: Date.now(), source: "wc", respond, alwaysAsk: o.alwaysAsk, via: o.via, unverified: o.unverified, mismatch: o.mismatch, startedBy: o.startedBy });
    void this.pump();
  }
  /** A read for another source, under the page's denylist and rate limit. */
  async provider(origin: string, command: string, args: Record<string, unknown>): Promise<Outcome> {
    if (PROVIDER_DENIED.has(command)) return { error: `${command} is not available to dapps` };
    if (!this.providerAllowed(origin)) return { error: "too many requests; slow down" };
    try {
      return { result: (await handleProvider(command, args, this.deps.rpcOverride?.())) ?? null };
    } catch (e) {
      return { error: (e as Error).message || "request failed" };
    }
  }
  /** Answers everything a source has waiting (its session ended) without touching the page's requests. */
  dropSource(source: "wc", error = "the session ended") {
    for (const q of this.queue) if (q.source === source) void this.answer(q, { error });
    this.queue = this.queue.filter((q) => q.source !== source);
    if (this.current?.source === source && this.current.status !== "Working…") {
      void this.answer(this.current, { error });
      this.current = null;
      this.events.onApproval(null);
      void this.pump();
    }
  }

  private async onMessage(json: string, nativeOrigin: string, mainFrame: boolean) {
    let m: { id?: unknown; command?: unknown; args?: unknown };
    try {
      m = JSON.parse(json) as typeof m;
    } catch {
      return;
    }
    if (!m || typeof m.id !== "string" || m.id.length > 128 || typeof m.command !== "string") return;
    if (m.command === "pq:tap") {
      if (mainFrame && nativeOrigin !== "" && nativeOrigin === originOf(this.url)) this.lastPageTap = Date.now();
      return; // nothing is answered
    }
    if (m.command === "pq:site-cleared") {
      if (mainFrame) this.cleared?.(); // the relay script's word that the site's data is gone; nothing is answered
      return;
    }
    // Only the page itself, never an iframe inside it; and only the origin the WebView attributes to it.
    // Whatever the message body claims about its origin is ignored.
    if (!mainFrame) {
      await this.reply(m.id, { error: "requests from frames are not accepted" });
      return;
    }
    const origin = nativeOrigin;
    if (!isAcceptableOrigin(origin)) {
      await this.reply(m.id, { error: "requests are accepted from https pages only" });
      return;
    }
    const args = m.args && typeof m.args === "object" && !Array.isArray(m.args) ? (m.args as Record<string, unknown>) : null;
    const req: DappRequest = { id: m.id, command: m.command, args, origin };
    if (req.command === "ping") {
      await this.reply(req.id, { result: "pong" });
      return;
    }
    if (req.command.startsWith("provider:")) {
      if (PROVIDER_DENIED.has(req.command) || !this.providerAllowed(origin)) {
        await this.reply(req.id, { error: PROVIDER_DENIED.has(req.command) ? `${req.command} is not available to pages` : "too many requests; slow down" });
        return;
      }
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
      this.queue.push({ key: crypto.randomUUID(), req, createdAt: Date.now(), source: "page" });
      void this.pump();
      return;
    }
    await this.reply(req.id, { error: `unsupported command ${req.command}` });
  }

  private providerAllowed(origin: string): boolean {
    const now = Date.now();
    const recent = (this.providerCalls.get(origin) ?? []).filter((t) => now - t < PROVIDER_WINDOW_MS);
    if (recent.length >= PROVIDER_CALLS_PER_WINDOW) {
      this.providerCalls.set(origin, recent);
      return false;
    }
    recent.push(now);
    this.providerCalls.set(origin, recent);
    return true;
  }

  /** Takes the oldest waiting request: answers it silently when it may be, else hands it to the sheet. */
  private async pump() {
    if (this.current) return;
    const now = Date.now();
    this.queue = this.queue.filter((q) => {
      if (now - q.createdAt > EXPIRY_MS) {
        void this.answer(q, { error: "request expired" });
        return false;
      }
      return true;
    });
    const next = this.queue.shift();
    if (!next) return; // idle: the app re-renders on onApproval(null) and places the page view itself
    // Claim the slot before anything asynchronous: a second message arriving while this one is being
    // planned must queue behind it, never replace the sheet under the user's finger.
    const claim: PendingApproval & { respond?: Respond } = { key: next.key, req: next.req, source: next.source, via: next.via, unverified: next.unverified, mismatch: next.mismatch, startedBy: next.startedBy, respond: next.respond, plan: null, refused: null, status: "planning" };
    this.current = claim;
    const gen = this.generation;
    const closedMeanwhile = () => (next.source === "page" ? gen !== this.generation : false) || this.current !== claim;
    if (this.opened) await this.plugin.hide().catch(() => undefined);
    const net = this.deps.network();
    let plan: Plan | null = null, refused: string | null = null;
    try {
      plan = await planRequest(next.req, net);
    } catch (e) {
      refused = (e as Error).message || String(e);
    }
    if (closedMeanwhile()) return; // the page closed meanwhile; close() already answered it
    // A page may ask an account to sign only after the user has shown that account to that site. Another
    // account of this wallet (its address is usually findable on the chain) must not reach the sheet as if
    // it were the connected one, and a site that never connected, was revoked, or holds a grant from before
    // there was a list has been shown nothing: without this rule it could name any address and learn from
    // the answer whether it belongs to this wallet.
    if (plan && next.source === "page" && next.req.command !== "getAccounts") {
      const shown = this.deps.permissions()?.accountsFor(next.req.origin);
      if (!plan.signerAddress || !shown?.includes(plan.signerAddress)) {
        plan = null;
        refused = "This site was not shown that account. Connect it to the site first.";
      }
    }
    // a site already allowed to see the accounts is answered without asking again
    // A grant from before there was a choice has no list, and used to mean "every account, also ones made
    // later". Such a site is simply asked again, once, and the answer is then remembered with its list.
    const remembered = this.deps.permissions()?.accountsFor(next.req.origin);
    if (plan && !next.alwaysAsk && next.req.command === "getAccounts" && this.deps.permissions()?.isAllowed(next.req.origin) && remembered) {
      await this.execute(claim, plan, remembered, () => !closedMeanwhile()).catch(() => undefined); // the same accounts as were chosen then
      if (closedMeanwhile()) return;
      this.current = null;
      this.events.onApproval(null);
      void this.pump();
      return;
    }
    claim.plan = plan;
    claim.refused = refused;
    claim.status = null;
    this.events.onApproval(claim);
  }

  /**
   * `alive`: false once the page that asked has gone to another site. Its answer is then not sent at all:
   * the reply channel is the page view, and whatever is in it now is a different site.
   */
  private async execute(q: { req: DappRequest; respond?: Respond }, plan: Plan, only?: ReadonlyArray<string>, alive: () => boolean = () => true): Promise<string[] | undefined> {
    const req = q.req;
    const keys = this.deps.keys();
    if (!keys) {
      await this.answer(q, { error: "the wallet is locked" });
      return undefined;
    }
    const outcome = await executePlan(plan, keys, this.deps.accounts(), (s) => {
      if (this.current?.req.id === req.id) {
        this.current.status = s;
        this.events.onApproval(this.current);
      }
    }, only);
    if (!alive()) return undefined;
    await this.answer(q, "error" in outcome ? { error: outcome.error } : { result: outcome.result });
    if ("error" in outcome && outcome.status) throw new Error(outcome.status); // the asker got its answer; the user sees why it failed
    // for a request to see the accounts: the addresses that were in the answer
    if (!("error" in outcome) && req.command === "getAccounts" && Array.isArray(outcome.result)) return (outcome.result as Array<{ address: string }>).map((x) => x.address);
    return undefined;
  }

  /**
   * The user's decision on the request the sheet shows. Resolves when the page has been answered.
   * `only`: for a request to see the accounts, the addresses the user ticked (absent: all of them).
   */
  async decide(key: string, approve: boolean, only?: ReadonlyArray<string>): Promise<void> {
    const c = this.current;
    if (!c || c.key !== key) return;
    if (c.status === "planning") return; // nothing to decide yet
    if (c.status !== null) return; // already executing: a late Reject cannot undo a broadcast, so it is ignored rather than lied about
    if (!approve || !c.plan) {
      await this.answer(c, { error: c.refused ? "refused by the wallet" : "rejected by the user" });
      this.current = null;
      this.events.onApproval(null);
      void this.pump();
      return;
    }
    c.status = "Working…";
    this.events.onApproval(c);
    const gen = this.generation;
    const stillHere = () => (c.source === "page" ? gen === this.generation : true);
    try {
      const shown = await this.execute(c, c.plan, c.req.command === "getAccounts" ? only : undefined, stillHere);
      // what is remembered is exactly the accounts that were shown, never an open-ended "all"
      if (stillHere() && c.source === "page" && c.req.command === "getAccounts" && shown) this.deps.permissions()?.allow(c.req.origin, shown);
    } finally {
      if (stillHere() && this.current === c) {
        this.current = null;
        this.events.onApproval(null);
        void this.pump();
      }
    }
  }
}
