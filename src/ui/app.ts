// The whole UI: a small state machine rendering HTML strings into #app, no framework. The markup comes
// from components.ts on the design system in tokens.css.
//
// Flow for a new user: create (24 words, check, passphrase) -> "Activate your account": one address
// to fund; once it holds enough, the wallet installs the post-quantum contract and registers the key
// by itself -> home. The account's address is derived from the seed, so importing the 24 words finds
// it again on any network with no extra input.
//
// Signed-in screens sit under a four-tab bar: Account, Activity, Dapps (native shells only, the
// extension plays that role on the web) and Settings. Onboarding and unlock are a linear flow without it.
import QRCode from "qrcode";
import {
  Chain, NETWORKS, formatKoin, isAddress, short, type HistoryItem, type Network, deriveKeys, mnemonicToSeed, newMnemonic, parseSeedInput,
  seedToMnemonic, bytesToHex, hexToBytes, wipe, type PqKeys, bootstrapAddress, estimateSetupCosts, pqwalletInfo, setupPqwalletAccount,
  type SetupCosts, type SetupResult, type SetupStatus,
} from "koinos-pq-core";
import {
  decoySlotFor, decryptVault, encryptVault, localVaultStore, MAX_ACCOUNTS, MIN_PASSPHRASE_LENGTH, newFile, openVault, roleOf, SLOT_COUNT, toFile, withSlot,
  type AccountRecord, type VaultData, type VaultFile,
} from "../core/vault";
import { canSign, detectAccount, displayLabel, walletAccounts } from "../core/accounts";
import { AddressBook, addressBookNamespace, localBookStore, type Assessment } from "../core/addressbook";
import { SealedStore, fillerValue, storeKeyFrom } from "../core/sealed-store";
import { WcBridge, type WcSession } from "./wc-bridge";
import { CLIPBOARD_WIPE_SECONDS, copyWithWipe } from "../core/clipboard";
import { CustomTokens, allTokens, customTokensNamespace, findToken, formatUnits, parseUnits, type Token } from "../core/tokens";
import {
  addressStrip, balance, button, card, check, esc, field, fmtAmount, header, hexStrip, input, linkButton, list, listRow, notice, section, shortAddr, stat, tabBar,
  ticker, tile, words, type Tab,
} from "./components";
import { isNative } from "./platform";
import { LANGUAGES, currentLanguage, initLanguage, isLang, setLanguage, t as tr } from "../i18n";
import { scanAddress, type Scanner } from "./scan";
import { biometricUnlock, biometricsEnabled, disableBiometrics, enableBiometrics, localBlobStore, nativeBiometry, nativeKeyStore, refreshWrappedKey, type BioDeps } from "../core/biometrics";
import { SitePermissions, permissionsNamespace } from "../core/permissions";
import { Collections, NFT_ENTRY, collectionInfo, collectionsNamespace, encodeNftTransferArgs, loadMetadata, metadataOf, tokenUri, tokensOf, type Collection, type NftMetadata, type NftToken } from "../core/nfts";
import { DappHost, type PendingApproval } from "./dapp-host";
import { describePlan } from "./approval-view";
import { PqBrowser, type PqBrowserPlugin } from "../native/pq-browser";
import dappList from "../data/dapps.json";

type Screen =
  | "welcome" | "create" | "confirm" | "passphrase" | "import" | "unlock" | "home" | "send" | "send-confirm" | "sent" | "receive" | "history"
  | "dapps" | "settings" | "export" | "setup" | "save" | "contacts" | "duress" | "duress-words" | "bio-enable" | "nfts" | "nft" | "nft-send";

/** Screens that live under the tab bar, and which tab they belong to. */
const TAB_OF: Partial<Record<Screen, string>> = {
  home: "account", send: "account", "send-confirm": "account", sent: "account", receive: "account", setup: "account", nfts: "account", nft: "account", "nft-send": "account",
  history: "activity",
  dapps: "dapps",
  settings: "settings", export: "settings", save: "settings", contacts: "settings", duress: "settings", "duress-words": "settings", "bio-enable": "settings",
};

interface SetupState {
  account: string;
  network: string;
  /** live-priced budgets, null until the node has answered */
  costs: SetupCosts | null;
  /** the contract is already on the address (an interrupted activation): only the registration is left */
  deployed: boolean;
  mana: bigint | null;
  status: SetupStatus | null;
  result: SetupResult | null;
  running: boolean;
  failed: string | null;
  timer: number | undefined;
}

interface Account extends AccountRecord {
  index: number;
  /** found from the seed on this network, not stored in the vault */
  derived?: boolean;
}

/** A change to the stored vault, applied only after the passphrase has been typed (and checked). */
interface PendingChange {
  title: string;
  detail: string;
  apply: (v: VaultData) => void;
}

/** A send waiting for the user to confirm the recipient (first-time or look-alike address). */
interface SendCheck {
  to: string;
  amount: string;
  token: Token;
  /** set when it is a collectible being sent (amount is then "1") */
  nft?: NftToken;
  assessment: Assessment;
}

interface NftState {
  /** per collection address: the tokens the current account holds (null: not loaded) */
  tokens: Record<string, NftToken[] | null>;
  /** per "collection:idHex": the token's metadata (null: none or not allowed) */
  meta: Record<string, NftMetadata | null | undefined>;
  collection: string | null;
  token: NftToken | null;
}
const emptyNft = (): NftState => ({ tokens: {}, meta: {}, collection: null, token: null });

type Theme = "system" | "light" | "dark";

interface DappState {
  open: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
  /** desktop layout requested for the page (a way out of phone layouts that cannot be used) */
  desktop: boolean;
  approval: PendingApproval | null;
}
const emptyDapp = (): DappState => ({ open: false, url: "", title: "", canGoBack: false, desktop: false, approval: null });

interface State {
  screen: Screen;
  /** the stored file (all slots); null when no wallet is saved in this browser */
  file: VaultFile | null;
  /** which slot the current passphrase opened */
  slot: number;
  vault: VaultData | null;
  book: AddressBook | null;
  /** tokens added by address on this wallet */
  tokens: CustomTokens | null;
  /** per listed token (by contract): base-unit balance, null when the read failed, missing when not read yet */
  balances: Record<string, bigint | null>;
  /** which network:account the balances belong to */
  balancesFor: string;
  hideZero: boolean;
  /** the token picked on the Send screen (contract address), "" for KOIN */
  sendToken: string;
  /** sites allowed to see this wallet's accounts (in-app browser) */
  sites: SitePermissions | null;
  dapp: DappState;
  /** WalletConnect sessions of the open wallet (for the Dapps tab) */
  wcSessions: WcSession[];
  /** the key the side stores are sealed under (from the slot key); wiped on lock */
  storeKey: Uint8Array | null;
  /** NFT collections added by address on this wallet */
  collections: Collections | null;
  nft: NftState;
  keys: PqKeys | null;
  networkName: string;
  accountIndex: number;
  busy: string | null;
  error: string | null;
  notice: string | null;
  pendingMnemonic: string | null;
  pendingSeed: Uint8Array | null;
  pendingAccounts: AccountRecord[];
  confirmIdx: number[];
  balance: bigint | null;
  mana: bigint | null;
  head: string | null;
  history: HistoryItem[] | null;
  sent: { txId: string; bytes: number; rcUsed: string; block: string | null; waiting: boolean; amount: string; symbol: string } | null;
  exportWords: string | null;
  autolockMinutes: number;
  lockOnHide: boolean;
  clipboardWipe: boolean;
  theme: Theme;
  /** 24 words of a decoy wallet being set up */
  pendingDecoy: string | null;
  sendCheck: SendCheck | null;
  setup: SetupState | null;
  /** per network: the activated account found from the seed (null: none; missing: not checked yet) */
  detected: Record<string, string | null>;
  change: PendingChange | null;
}

const PREF_NETWORK = "koinos-pq-wallet/network";
const PREF_DEVNET_RPC = "koinos-pq-wallet/devnet-rpc";
const PREF_AUTOLOCK = "koinos-pq-wallet/autolock-minutes";
const PREF_LOCK_ON_HIDE = "koinos-pq-wallet/lock-on-hide";
const PREF_CLIPBOARD_WIPE = "koinos-pq-wallet/clipboard-wipe";
const PREF_THEME = "koinos-pq-wallet/theme";
const PREF_HIDE_ZERO = "koinos-pq-wallet/hide-zero";
const PREF_WC_PROJECT = "koinos-pq-wallet/wc-project-id";
/** the Reown project id (a public identifier, not a secret): VITE_WC_PROJECT_ID at build time, else the project's own; Settings overrides it */
const WC_PROJECT_DEFAULT = ((import.meta.env?.VITE_WC_PROJECT_ID as string | undefined) || "d43868eb23db2fcc678234dc12a60eea").trim();
/** how long after the approval sheet appears before Approve accepts a tap (a tap meant for the page must not land on it) */
const APPROVE_DELAY_MS = 800;

// The per-wallet side stores (contacts, added tokens, allowed sites, collections) are kept per vault slot,
// sealed under that slot's key (src/core/sealed-store.ts), and every slot's entries exist from the first
// unlock on as filler of the same size, so local storage looks the same whether one wallet lives on the
// device or two, and says nothing about either. (Until 0.14 they were plain JSON keyed by a hash of the
// seed: readable by anyone with the storage, and a second key set was a tell that a duress wallet existed.)
type StoreKind = "book" | "tokens" | "sites" | "collections";
const STORE_KINDS: StoreKind[] = ["book", "tokens", "sites", "collections"];
const emptyStore = (_kind: StoreKind) => fillerValue();
const storeKey = (kind: StoreKind, ns: string) => `koinos-pq-wallet/${kind}/${ns}`;
function ensureStored(key: string, empty: string) {
  try {
    if (globalThis.localStorage?.getItem(key) === null) globalThis.localStorage?.setItem(key, empty);
  } catch {
    /* a blocked store: nothing persists, the wallet still works */
  }
}
function moveStored(from: string, to: string) {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    const v = ls.getItem(from);
    if (v === null) return;
    if (ls.getItem(to) === null) ls.setItem(to, v);
    ls.removeItem(from);
  } catch {
    /* as above */
  }
}
function resetStored(key: string, empty: string) {
  try {
    globalThis.localStorage?.setItem(key, empty);
  } catch {
    /* as above */
  }
}
/** Deleting the wallet takes every slot's side stores with it; preferences (language, theme, node) stay. */
function clearWalletStores() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    const doomed: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && /^koinos-pq-wallet\/(book|tokens|sites|collections)\//.test(k)) doomed.push(k);
    }
    for (const k of doomed) ls.removeItem(k);
  } catch {
    /* as above */
  }
}
/** how long a hidden tab may stay unlocked */
const HIDDEN_LOCK_SECONDS = 60;

const pref = {
  get(k: string): string | null {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

/** Light and dark follow the system unless Settings says otherwise; the choice is a data attribute tokens.css reads. */
export function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === "system") delete el.dataset.theme;
  else el.dataset.theme = theme;
}

export interface AppOptions {
  /** the camera scanner to use (tests pass a fake); the plugin by default */
  scanner?: Scanner;
  /** the keystore and biometric prompt (tests pass fakes); the plugins by default */
  bio?: Partial<BioDeps>;
  /** the dapp browser plugin (tests pass a fake) and the script it injects (the built inpage bundle by default) */
  browser?: PqBrowserPlugin;
  bridgeScript?: () => Promise<string>;
  /** whether to show what only a native shell has (the Dapps tab, the QR scan button); detected by default */
  native?: boolean;
  /** ms after the approval sheet appears before Approve takes a tap; tests pass 0 */
  approveDelayMs?: number;
}

export class App {
  private s: State;
  private root: HTMLElement;
  private lockTimer: number | undefined;
  private hideTimer: number | undefined;
  private readonly scanner: Scanner | undefined;
  private readonly native: boolean;
  private readonly bio: BioDeps;
  /** whether the device offers biometrics (checked once per unlock screen on native) */
  private bioAvailable: boolean | null = null;
  private readonly browser: PqBrowserPlugin;
  private readonly bridgeScript: (() => Promise<string>) | undefined;
  private host: DappHost | null = null;
  private readonly wc = new WcBridge();
  /** a wc: link that arrived while locked, paired once the wallet opens */
  private pendingWcUri: string | null = null;
  private approveDelayMs: number;
  /** the approval the sheet currently shows and when it appeared */
  private sheetKey = "";
  private sheetShownAt = 0;

  constructor(root: HTMLElement, opts: AppOptions = {}) {
    this.root = root;
    this.approveDelayMs = opts.approveDelayMs ?? APPROVE_DELAY_MS;
    this.scanner = opts.scanner;
    this.native = opts.native ?? isNative();
    this.bio = { blobs: opts.bio?.blobs ?? localBlobStore, keys: opts.bio?.keys ?? nativeKeyStore, biometry: opts.bio?.biometry ?? nativeBiometry };
    this.browser = opts.browser ?? PqBrowser;
    this.bridgeScript = opts.bridgeScript;
    const stored = localVaultStore.load();
    const theme = (pref.get(PREF_THEME) ?? "system") as Theme;
    this.s = {
      screen: stored ? "unlock" : "welcome",
      file: null,
      slot: 0,
      vault: null,
      book: null,
      tokens: null,
      balances: {},
      balancesFor: "",
      hideZero: pref.get(PREF_HIDE_ZERO) !== "0",
      sendToken: "",
      sites: null,
      dapp: emptyDapp(),
      collections: null,
      nft: emptyNft(),
      keys: null,
      networkName: pref.get(PREF_NETWORK) ?? "testnet",
      accountIndex: 0,
      busy: null,
      error: null,
      notice: null,
      pendingMnemonic: null,
      pendingSeed: null,
      pendingAccounts: [],
      confirmIdx: [],
      balance: null,
      mana: null,
      head: null,
      history: null,
      sent: null,
      exportWords: null,
      autolockMinutes: Number(pref.get(PREF_AUTOLOCK) ?? 10) || 10,
      lockOnHide: pref.get(PREF_LOCK_ON_HIDE) !== "0",
      clipboardWipe: pref.get(PREF_CLIPBOARD_WIPE) !== "0",
      theme: ["light", "dark"].includes(theme) ? theme : "system",
      pendingDecoy: null,
      sendCheck: null,
      setup: null,
      wcSessions: [],
      storeKey: null,
      detected: {},
      change: null,
    };
    if (!NETWORKS[this.s.networkName]) this.s.networkName = "testnet";
    applyTheme(this.s.theme);
    initLanguage();
    if (this.native) {
      // the hardware back button on Android (no-op elsewhere); the plugin is loaded on demand
      void import("@capacitor/app").then(({ App: CapApp }) => {
        void CapApp.addListener("backButton", () => {
          void this.handleBack().then((r) => {
            if (r === "minimize") void CapApp.minimizeApp();
          });
        });
        // a WalletConnect link from a dapp or a QR app: paired now, or right after the next unlock
        void CapApp.addListener("appUrlOpen", ({ url }) => {
          if (!/^wc:/i.test(url)) return;
          if (this.unlocked() && this.s.keys) void this.run("Connecting", () => this.pairWc(url));
          else this.pendingWcUri = url;
        });
      }).catch(() => undefined);
    }
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("change", (e) => this.onChange(e));
    for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, () => this.touch(), { passive: true });
    // a tab that is hidden (another tab, minimised, screen off) locks after HIDDEN_LOCK_SECONDS
    document.addEventListener("visibilitychange", () => {
      window.clearTimeout(this.hideTimer);
      if (document.visibilityState === "hidden" && this.s.lockOnHide && this.unlocked()) {
        this.hideTimer = window.setTimeout(() => {
          if (document.visibilityState === "hidden" && !this.s.setup?.running) this.lock("Locked while the tab was hidden.");
        }, HIDDEN_LOCK_SECONDS * 1000);
      }
    });
    this.render();
  }
  private unlocked(): boolean {
    return !!(this.s.keys || this.s.pendingMnemonic || this.s.pendingSeed);
  }
  /** Addresses that belong to this wallet (for the recipient check). */
  private ownAddresses(): string[] {
    return this.accounts().map((a) => a.address);
  }

  // ---------- derived ----------
  private get network(): Network {
    const n = NETWORKS[this.s.networkName]!;
    if (n.name === "devnet") {
      const rpc = pref.get(PREF_DEVNET_RPC);
      if (rpc) return { ...n, rpc: [rpc] };
    }
    return n;
  }
  private chain(): Chain {
    return new Chain(this.network);
  }
  /** Every account the wallet knows (index 0 is the native address of the key). */
  private accounts(): Account[] {
    const out: Account[] = [];
    if (this.s.keys) out.push({ index: 0, label: "Post-quantum address (native)", mode: "native", address: this.s.keys.address });
    for (const a of this.s.vault?.accounts ?? []) out.push({ index: out.length, ...a, label: displayLabel(a.label) });
    const found = this.s.detected[this.network.name];
    if (found && !out.some((a) => a.address === found)) out.push({ index: out.length, label: "Your account", mode: "pqwallet", address: found, derived: true });
    return out;
  }
  /** What the user is offered: the native address only on the devnet, since today's nodes cannot spend from it. */
  private visibleAccounts(): Account[] {
    return this.accounts().filter((a) => a.mode !== "native" || this.network.name === "devnet");
  }
  private account(): Account | null {
    const vis = this.visibleAccounts();
    return vis.find((a) => a.index === this.s.accountIndex) ?? vis[0] ?? null;
  }
  private unit(): string {
    return this.network.name === "testnet" ? "tKOIN" : "KOIN";
  }
  /** The curated tokens of this network plus the wallet's additions; KOIN first. */
  private tokenList(): Token[] {
    return allTokens(this.network.name, this.s.tokens);
  }
  private koinToken(): Token {
    return this.tokenList()[0]!;
  }
  private currentSendToken(): Token {
    return findToken(this.tokenList(), this.s.sendToken) ?? this.koinToken();
  }
  /** A token's balance for the current account: KOIN's comes with the main refresh, the rest from fillTokenBalances. */
  private tokenBalance(t: Token): bigint | null | undefined {
    return t.address === this.network.koin ? this.s.balance ?? undefined : this.s.balances[t.address];
  }
  private tokenAmount(t: Token): string {
    const v = this.tokenBalance(t);
    return v === undefined ? "…" : v === null ? "?" : fmtAmount(formatUnits(v, t.decimals));
  }

  // ---------- lifecycle ----------
  private touch() {
    // the 24 words on the create screens count as unlocked too
    if (!this.s.keys && !this.s.pendingMnemonic && !this.s.pendingSeed) return;
    window.clearTimeout(this.lockTimer);
    this.lockTimer = window.setTimeout(() => {
      if (this.s.setup?.running) return this.touch(); // never pull the key out from under an activation
      this.lock("Locked after inactivity.");
    }, this.s.autolockMinutes * 60_000);
  }
  private lock(notice?: string) {
    this.wc.detach();
    if (this.s.keys) wipe(this.s.keys.secretKey, this.s.keys.seed);
    if (this.s.storeKey) wipe(this.s.storeKey);
    this.s.storeKey = null;
    this.s.wcSessions = [];
    if (this.s.pendingSeed) wipe(this.s.pendingSeed);
    this.s.keys = null;
    this.s.vault = null;
    this.s.pendingSeed = null;
    this.s.pendingMnemonic = null;
    this.s.pendingAccounts = [];
    this.s.exportWords = null;
    this.s.balance = this.s.mana = null;
    this.s.history = null;
    this.s.sent = null;
    this.s.detected = {};
    this.s.change = null;
    this.s.book = null;
    this.s.tokens = null;
    this.s.balances = {};
    this.s.balancesFor = "";
    this.s.sendToken = "";
    this.s.sites = null;
    this.s.collections = null;
    this.s.nft = emptyNft();
    if (this.host?.isOpen) void this.host.close();
    this.s.dapp = emptyDapp();
    this.s.file = null;
    this.s.pendingDecoy = null;
    this.s.sendCheck = null;
    this.endSetup();
    this.s.screen = localVaultStore.load() ? "unlock" : "welcome";
    this.s.notice = notice ?? null;
    this.s.error = null;
    window.clearTimeout(this.lockTimer);
    window.clearTimeout(this.hideTimer);
    this.render();
  }
  private go(screen: Screen) {
    this.s.screen = screen;
    this.s.exportWords = null; // the recovery words never outlive the screen they were shown on
    this.s.error = null;
    this.s.notice = null;
    this.render();
  }
  private async run(label: string, fn: () => Promise<void>) {
    this.s.busy = label;
    this.s.error = null;
    this.render();
    try {
      await fn();
    } catch (e) {
      this.s.error = (e as Error).message || String(e);
    } finally {
      this.s.busy = null;
      this.render();
    }
  }
  private async refresh() {
    const chain = this.chain();
    const net = this.network.name;
    if (this.s.keys && this.s.detected[net] === undefined) {
      try {
        this.s.detected[net] = await detectAccount(chain, this.s.keys);
      } catch {
        /* node unreachable: look again on the next refresh */
      }
    }
    const a = this.account();
    if (!a) {
      this.s.balance = this.s.mana = null;
      this.s.head = await chain.headHeight().catch(() => null);
      return;
    }
    const [balance, mana, head] = await Promise.allSettled([chain.balance(a.address), chain.mana(a.address), chain.headHeight()]);
    this.s.mana = mana.status === "fulfilled" ? mana.value : null;
    this.s.head = head.status === "fulfilled" ? head.value : null;
    if (balance.status === "fulfilled") {
      this.s.balance = balance.value;
    } else {
      // A failed balance read must not take the whole screen down (seen on mainnet 2026-10-18: the public
      // nodes answered "user code cannot access system space" to every KOIN balance_of while mana still read).
      this.s.balance = null;
      this.s.notice = tr("Balance unavailable from this {net} node right now ({why}). Mana and head block are live.", { net: this.network.name, why: (balance.reason as Error).message?.slice(0, 120) ?? "error" });
    }
    if (mana.status === "rejected" && head.status === "rejected") throw new Error(tr("cannot reach the {net} node: {why}", { net: this.network.name, why: (head.reason as Error).message }));
    void this.fillTokenBalances(a.address);
  }
  /**
   * balance_of on every listed token but KOIN, three at a time (the public nodes answer HTML to bursts),
   * patching the token rows in place as answers arrive; one render at the end applies "hide zero balances".
   */
  private async fillTokenBalances(address: string) {
    const key = `${this.network.name}:${address}`;
    if (this.s.balancesFor !== key) {
      this.s.balances = {};
      this.s.balancesFor = key;
    }
    const chain = this.chain();
    const todo = this.tokenList().filter((t) => t.address !== this.network.koin && this.s.balances[t.address] === undefined);
    if (!todo.length) return;
    const worker = async () => {
      for (;;) {
        const t = todo.shift();
        if (!t) return;
        let v: bigint | null = null;
        try {
          v = await chain.tokenBalance(t.address, address);
        } catch {
          v = null;
        }
        await new Promise((r) => setTimeout(r, 120)); // api.koinos.io answers HTML to bursts
        if (this.s.balancesFor !== key) return;
        this.s.balances[t.address] = v;
        const el = this.root.querySelector<HTMLElement>(`[data-token="${t.address}"] .amt`);
        if (el) el.textContent = this.tokenAmount(t);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (this.s.balancesFor === key && this.s.screen === "home" && !this.s.busy) this.render();
  }
  /** Home, or straight to activation when this network has no account for the wallet yet. */
  private async enterHome() {
    this.s.screen = "home";
    await this.refresh();
    if (!this.account() && this.network.name !== "devnet" && this.s.detected[this.network.name] !== undefined) this.startSetup();
  }
  private async finishSetup(passphrase: string) {
    const seed = this.s.pendingSeed;
    if (!seed) throw new Error(tr("nothing to save"));
    const vault: VaultData = { version: 1, seedHex: bytesToHex(seed), accounts: this.s.pendingAccounts, createdAt: new Date().toISOString(), role: "main" };
    const { file, slot, key } = await newFile(vault, passphrase);
    if (!localVaultStore.save(file)) throw new Error(tr("this browser blocks local storage; the wallet cannot be saved here"));
    this.s.file = file;
    this.s.slot = slot;
    this.s.vault = vault;
    this.startSession(seed, key);
    this.s.pendingSeed = null;
    this.s.pendingMnemonic = null;
    this.s.pendingAccounts = [];
    this.s.accountIndex = this.s.vault.accounts.length ? 1 : 0;
    this.s.notice = null;
    this.touch();
    await this.enterHome();
  }
  /**
   * Keys and side stores for the wallet just opened (see STORE_KINDS). Older seed-keyed stores are moved
   * to the slot's keys once. The seed buffer is wiped unless the keys alias it (koinos-pq-core before
   * 2026-10-19 shared it; wiping then zeroed keys.seed and every wallet collided on one address).
   */
  private startSession(seed: Uint8Array, slotKey: Uint8Array) {
    this.s.keys = deriveKeys(seed);
    const ns = `slot${this.s.slot}`;
    const legacy: Record<StoreKind, string> = { book: addressBookNamespace(seed), tokens: customTokensNamespace(seed), sites: permissionsNamespace(seed), collections: collectionsNamespace(seed) };
    for (const kind of STORE_KINDS) moveStored(storeKey(kind, legacy[kind]), storeKey(kind, ns));
    for (let i = 0; i < SLOT_COUNT; i++) for (const kind of STORE_KINDS) ensureStored(storeKey(kind, `slot${i}`), emptyStore(kind));
    this.s.storeKey = storeKeyFrom(slotKey);
    wipe(slotKey);
    const sealed = new SealedStore(this.s.storeKey, localBookStore);
    this.s.book = new AddressBook(ns, sealed);
    this.s.tokens = new CustomTokens(ns, sealed);
    this.s.sites = new SitePermissions(ns, sealed);
    this.s.collections = new Collections(ns, sealed);
    if (this.s.keys.seed !== seed) wipe(seed);
    this.wc.attach(this.dappHost(), {
      projectId: () => this.wcProjectId(),
      network: () => this.network,
      keys: () => this.s.keys,
      accounts: () => this.s.vault?.accounts ?? [],
      signingAddresses: async () => {
        const keys = this.s.keys;
        if (!keys) return [];
        const detected = await detectAccount(this.chain(), keys).catch(() => null);
        return walletAccounts(keys, this.s.vault?.accounts ?? [], this.network.name, detected).map((a) => a.address);
      },
      onSessionsChanged: () => {
        void this.wc.sessions().then((list) => {
          this.s.wcSessions = list;
          if (this.s.screen === "dapps") this.render();
        });
      },
      notify: (text) => {
        this.s.notice = text;
        this.render();
      },
    });
    void this.wc.resume();
    if (this.pendingWcUri) {
      const uri = this.pendingWcUri;
      this.pendingWcUri = null;
      void this.run("Connecting", () => this.pairWc(uri));
    }
  }
  private wcProjectId(): string {
    return (pref.get(PREF_WC_PROJECT) ?? "").trim() || WC_PROJECT_DEFAULT;
  }
  /** Pairs with a dapp from a wc: URI; the proposal then arrives on the approval sheet. */
  private async pairWc(uri: string) {
    if (!this.wcProjectId()) throw new Error(tr("WalletConnect needs a project id first: Settings › WalletConnect."));
    await this.wc.pair(uri);
    this.s.screen = "dapps";
    this.s.notice = tr("Connected to the relay. The dapp's request appears here in a moment.");
  }
  /** The passphrase must open the slot this session was unlocked from; anything else is "wrong". */
  private async reopenCurrent(passphrase: string): Promise<VaultData> {
    if (!this.s.file) throw new Error(tr("no wallet"));
    return decryptVault(this.s.file.slots[this.s.slot]!, passphrase);
  }
  private async saveChange(passphrase: string) {
    const change = this.s.change;
    if (!change || !this.s.file) throw new Error(tr("nothing to save"));
    const vault = await this.reopenCurrent(passphrase); // also checks the passphrase
    change.apply(vault);
    const previous = this.s.file;
    const file = withSlot(this.s.file, this.s.slot, await encryptVault(vault, passphrase));
    if (!localVaultStore.save(file)) throw new Error(tr("could not write to local storage"));
    await refreshWrappedKey(file, this.s.slot, passphrase, this.bio, previous).catch(() => undefined); // biometrics, if on for this slot, follow the new salt (no prompt)
    this.s.file = file;
    this.s.vault = vault;
    this.s.change = null;
    this.s.screen = "settings";
    this.s.notice = tr("Saved.");
  }
  /**
   * Duress mode: writes a decoy wallet (its own seed, its own passphrase) into the slot decoySlotFor()
   * picks. The main passphrase is required so only the owner can do it; the decoy passphrase must open
   * nothing that exists. The session locks afterwards so the same thing happens whichever wallet did it.
   */
  private async saveDecoy(mainPass: string, decoyPass: string) {
    const file = this.s.file, words = this.s.pendingDecoy, vault = this.s.vault;
    if (!file || !words || !vault) throw new Error(tr("nothing to save"));
    const current = await this.reopenCurrent(mainPass);
    let taken = false;
    try {
      await openVault(file, decoyPass);
      taken = true;
    } catch {
      /* good: the decoy passphrase opens nothing yet */
    }
    if (taken) throw new Error(tr("The duress passphrase must be different from any passphrase this wallet already uses."));
    const seed = mnemonicToSeed(words);
    const decoy: VaultData = { version: 1, seedHex: bytesToHex(seed), accounts: [], createdAt: new Date().toISOString(), role: "decoy" };
    wipe(seed);
    const target = decoySlotFor(this.s.slot, roleOf(current));
    const next = withSlot(file, target, await encryptVault(decoy, decoyPass));
    if (!localVaultStore.save(next)) throw new Error(tr("could not write to local storage"));
    for (const kind of STORE_KINDS) resetStored(storeKey(kind, `slot${target}`), emptyStore(kind)); // nothing of a previous decoy carries over
    // Exactly the same work whichever wallet did this: nothing is written back to the current slot, and
    // biometrics go off for every slot (the owner turns them on again from the wallet they should open).
    // Nothing stored says which slot is which.
    await disableBiometrics(this.bio).catch(() => undefined);
    this.lock("Duress wallet saved. Unlock with either passphrase: each opens its own wallet. Biometric unlock is off; turn it on again from the wallet it should open.");
  }

  // ---------- account activation (the pqwallet contract on the seed's own address) ----------
  private startSetup() {
    if (!this.s.keys) return;
    this.endSetup();
    const account = bootstrapAddress(this.s.keys);
    const st0: SetupState = { account, network: this.network.name, costs: null, deployed: false, mana: null, status: null, result: null, running: false, failed: null, timer: undefined };
    this.s.setup = st0;
    // price the two transactions from the live resource market; nothing runs until that is known
    void Promise.all([estimateSetupCosts(this.chain()), pqwalletInfo(this.chain(), account)])
      .then(([costs, info]) => {
        if (this.s.setup !== st0) return;
        st0.costs = costs;
        st0.deployed = info.deployed;
        if (this.s.screen === "setup" && !st0.running) this.render(); // the amount to send is known now
        void poll();
      })
      .catch((e) => {
        if (this.s.setup !== st0) return;
        this.s.error = tr("Could not price the activation from the {net} node: {why}", { net: this.network.name, why: (e as Error).message });
        if (this.s.screen === "setup") this.render();
      });
    const poll = async () => {
      const st = this.s.setup;
      if (!st || st.running || st.result) return;
      try {
        st.mana = await this.chain().mana(st.account);
      } catch {
        st.mana = null;
      }
      if (this.s.setup !== st || st.running || st.result) return;
      const need = this.needed(st);
      const funded = need !== null && st.mana !== null && st.mana >= need;
      if (funded && !st.failed && this.s.keys) {
        void this.run("Activating your account", () => this.runSetup());
        return;
      }
      if (this.s.screen !== "setup") return;
      const manaEl = this.root.querySelector<HTMLElement>("#setup-mana");
      if (manaEl && need !== null) {
        manaEl.className = funded ? "note ok" : "mute";
        manaEl.textContent = this.manaLine(st.mana, need);
      } else {
        this.render();
      }
    };
    void poll();
    st0.timer = window.setInterval(() => void poll(), 6000);
    this.go("setup");
  }
  private needed(st: SetupState): bigint | null {
    if (!st.costs) return null;
    return st.deployed ? st.costs.registerRc : st.costs.requiredMana;
  }
  private manaLine(mana: bigint | null, required: bigint): string {
    const need = formatKoin(required, 2);
    if (mana === null) return tr("Mana now: checking… (needs {need})", { need });
    return tr("Mana now: {mana} {state}", { mana: formatKoin(mana, 2), state: mana >= required ? tr("(enough, activating)") : tr("(needs {need})", { need }) });
  }
  private endSetup() {
    if (this.s.setup?.timer) window.clearInterval(this.s.setup.timer);
    this.s.setup = null;
  }
  /** Leaving the activation screen by a tab stops its polling, unless the activation itself is running. */
  private leaveSetup() {
    if (this.s.setup && !this.s.setup.running) this.endSetup();
  }
  private async runSetup() {
    const st = this.s.setup;
    if (!st || !this.s.keys) throw new Error(tr("locked"));
    if (st.running || st.result) return;
    st.running = true;
    st.failed = null;
    this.s.screen = "setup";
    const net = st.network;
    try {
      const result = await setupPqwalletAccount(this.chain(), this.s.keys, (status) => {
        st.status = status;
        if (this.s.setup === st) this.render();
      });
      st.result = result;
      this.s.detected[net] = result.account;
      this.s.accountIndex = this.accounts().find((a) => a.address === result.account)?.index ?? 0;
    } catch (e) {
      st.failed = (e as Error).message || String(e);
      throw e;
    } finally {
      st.running = false;
    }
  }

  /** Signs and submits a token transfer (KOIN or any listed KCS-4 token) from the current account, then remembers the recipient. */
  private async doSend(to: string, amount: string, name = "", token: Token = this.koinToken()) {
    const a = this.account();
    if (!a || !this.s.keys || !canSign(a)) throw new Error(tr("locked"));
    const valueBase = parseUnits(amount, token.decimals);
    const chain = this.chain();
    const contract = token.address === this.network.koin ? undefined : token.address;
    const res = await chain.sendKoin({ from: a.address, to, valueBase, keys: this.s.keys, mode: a.mode as "native" | "pqwallet", contract });
    this.s.book?.recordSend(to, name);
    this.s.sendCheck = null;
    if (contract) delete this.s.balances[contract]; // read again on the next refresh
    this.s.sent = { txId: res.txId, bytes: res.entryBytes, rcUsed: String(res.receipt.rc_used ?? "?"), block: null, waiting: this.network.autoBlocks, amount, symbol: token.symbol };
    this.s.screen = "sent";
    this.render();
    if (this.network.autoBlocks) {
      try {
        const block = await chain.waitMined(res.txId);
        this.s.sent = { ...this.s.sent, block, waiting: false };
      } catch (err) {
        this.s.sent = { ...this.s.sent, waiting: false };
        this.s.error = tr("Sent, but still waiting for a block: {why}", { why: (err as Error).message });
      }
      await this.refresh();
    }
  }
  /** Opens whatever slot the device key unwraps, after the OS prompt; any failure falls back to the passphrase field. */
  private async unlockWithBiometrics() {
    const stored = localVaultStore.load();
    if (!stored) throw new Error(tr("no wallet on this device"));
    const file = await toFile(stored);
    const opened = await biometricUnlock(file, this.bio);
    if (!opened) throw new Error(tr("Biometrics are not set up for this wallet."));
    this.s.file = file;
    this.s.slot = opened.slot;
    this.s.vault = opened.data;
    const seed = hexToBytes(opened.data.seedHex);
          this.startSession(seed, opened.key);
    this.s.accountIndex = opened.data.accounts.length ? 1 : 0;
    this.touch();
    await this.enterHome();
  }
  /** The in-app browser's host, made on first use; its callbacks drive the Dapps screen and the approval sheet. */
  private dappHost(): DappHost {
    if (this.host) return this.host;
    this.host = new DappHost(
      this.browser,
      {
        onNavigation: (e) => {
          this.s.dapp.url = e.url;
          this.s.dapp.title = e.title;
          this.s.dapp.canGoBack = e.canGoBack;
          const bar = this.root.querySelector<HTMLInputElement>('form[data-form="dapp-go"] input[name="url"]');
          if (bar && document.activeElement !== bar) bar.value = e.url;
        },
        onClosed: () => {
          this.s.dapp = emptyDapp();
          if (this.s.screen === "dapps") this.render();
        },
        onApproval: (p) => {
          if (p && !this.s.keys) {
            void this.host?.decide(p.key, false); // locked meanwhile: nothing is shown or signed
            return;
          }
          if (p && p.key !== this.sheetKey) {
            this.sheetKey = p.key;
            this.sheetShownAt = Date.now();
            window.setTimeout(() => {
              if (this.s.dapp.approval?.key === p.key) this.render(); // Approve becomes live
            }, this.approveDelayMs + 30);
          }
          this.s.dapp.approval = p;
          if (p && this.s.screen !== "dapps") this.s.screen = "dapps";
          this.render();
        },
      },
      {
        network: () => this.network,
        keys: () => this.s.keys,
        accounts: () => this.s.vault?.accounts ?? [],
        permissions: () => this.s.sites,
        rpcOverride: () => {
          const rpc = pref.get(PREF_DEVNET_RPC);
          return rpc ? { devnet: [rpc] } : undefined;
        },
        bridgeScript: this.bridgeScript,
      },
    );
    return this.host;
  }
  /** Where the native page view goes: the empty area between the url bar and the tab bar, in CSS px from the viewport edges. */
  private dappFrame(): { top: number; bottom: number } {
    const area = this.root.querySelector<HTMLElement>("#dapp-area");
    if (!area) return { top: 0, bottom: 0 };
    const r = area.getBoundingClientRect();
    return { top: Math.max(0, Math.round(r.top)), bottom: Math.max(0, Math.round(window.innerHeight - r.bottom)) };
  }
  private async openDapp(url: string) {
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    try {
      new URL(url);
    } catch {
      throw new Error(tr("That is not a web address."));
    }
    this.s.dapp = { ...emptyDapp(), open: true, url };
    this.s.screen = "dapps";
    this.render();
    await this.dappHost().open(url, this.dappFrame());
  }
  /** After every render: the native page view follows the Dapps screen (shown there, hidden elsewhere). */
  private placeDapp() {
    const host = this.host;
    if (!host?.isOpen) return;
    if (this.s.screen === "dapps" && !this.s.dapp.approval && !host.busy) {
      void host.setFrame(this.dappFrame()).then(() => host.show());
    } else {
      void host.hide();
    }
  }
  private collectionList(): Collection[] {
    return this.s.collections?.list(this.network.name) ?? [];
  }
  /** The tokens the current account holds in a collection, then their metadata in the background. */
  private async loadCollection(address: string) {
    const a = this.account();
    if (!a) throw new Error(tr("no account"));
    this.s.nft.collection = address;
    this.s.nft.tokens[address] = await tokensOf(this.chain(), address, a.address);
    this.s.screen = "nfts";
    void this.fillNftMetadata(address);
  }
  private async fillNftMetadata(address: string) {
    const chain = this.chain();
    for (const t of this.s.nft.tokens[address] ?? []) {
      const key = `${address}:${t.idHex}`;
      if (this.s.nft.meta[key] !== undefined) continue;
      let meta: NftMetadata | null = null;
      try {
        const uri = await tokenUri(chain, address, t.idHex);
        meta = uri ? await loadMetadata(uri) : null;
        if (!meta) {
          const inline = await metadataOf(chain, address, t.idHex);
          if (inline) meta = (await loadMetadata(`data:application/json,${encodeURIComponent(inline)}`)) ?? null;
        }
      } catch {
        meta = null;
      }
      this.s.nft.meta[key] = meta;
      const tile = this.root.querySelector<HTMLElement>(`[data-nft="${t.idHex}"]`);
      if (tile && this.s.nft.collection === address) tile.outerHTML = this.nftTile(t, meta);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  /** One collectible, through the one signing path, then the recipient is remembered like any other. */
  private async doSendNft(to: string, name: string, token: NftToken) {
    const a = this.account();
    if (!a || !this.s.keys || !canSign(a)) throw new Error(tr("locked"));
    const chain = this.chain();
    const res = await chain.sendCall({ from: a.address, contract: token.collection, entryPoint: NFT_ENTRY.transfer, args: encodeNftTransferArgs(a.address, to, token.idHex), keys: this.s.keys, mode: a.mode as "native" | "pqwallet" });
    this.s.book?.recordSend(to, name);
    this.s.sendCheck = null;
    this.s.nft.tokens[token.collection] = null; // read again next time
    const col = this.collectionList().find((c) => c.address === token.collection);
    this.s.sent = { txId: res.txId, bytes: res.entryBytes, rcUsed: String(res.receipt.rc_used ?? "?"), block: null, waiting: this.network.autoBlocks, amount: "1", symbol: `${col?.symbol ?? "NFT"} #${token.label}` };
    this.s.screen = "sent";
    this.render();
    if (this.network.autoBlocks) {
      try {
        const block = await chain.waitMined(res.txId);
        this.s.sent = { ...this.s.sent, block, waiting: false };
      } catch (err) {
        this.s.sent = { ...this.s.sent, waiting: false };
        this.s.error = tr("Sent, but still waiting for a block: {why}", { why: (err as Error).message });
      }
      await this.refresh();
    }
  }
  private loadActivity() {
    void this.run("Loading activity", async () => {
      const a = this.account();
      this.s.screen = "history";
      if (!a) return;
      this.s.history = await this.chain().history(a.address);
    });
  }

  // ---------- events ----------
  private onChange(e: Event) {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLSelectElement && t.name === "network") {
      if (this.s.setup?.running) {
        t.value = this.s.networkName;
        this.s.error = tr("Wait until the activation has finished before switching network.");
        this.render();
        return;
      }
      this.s.networkName = t.value;
      pref.set(PREF_NETWORK, t.value);
      this.endSetup();
      this.s.balance = this.s.mana = this.s.head = null;
      this.s.history = null;
      this.s.balances = {};
      this.s.balancesFor = "";
      this.s.sendToken = "";
      this.s.nft = emptyNft();
      void this.run("Loading", () => this.enterHome());
    }
    if (t instanceof HTMLSelectElement && t.name === "lang") {
      if (isLang(t.value)) setLanguage(t.value);
      this.render();
    }
    if (t instanceof HTMLSelectElement && t.name === "theme") {
      const theme = (["light", "dark"].includes(t.value) ? t.value : "system") as Theme;
      this.s.theme = theme;
      pref.set(PREF_THEME, theme);
      applyTheme(theme);
    }
    if (t instanceof HTMLInputElement && t.name === "account") {
      this.s.accountIndex = Number(t.value);
      this.s.balance = this.s.mana = null;
      this.s.history = null;
      void this.run("Loading", () => this.refresh());
    }
    if (t instanceof HTMLInputElement && t.name === "hideZero") {
      this.s.hideZero = t.checked;
      pref.set(PREF_HIDE_ZERO, t.checked ? "1" : "0");
      this.render();
    }
    if (t instanceof HTMLSelectElement && t.name === "token") {
      // no re-render: the user may have typed the recipient already; only the labels change
      this.s.sendToken = t.value;
      const tok = this.currentSendToken();
      const sym = this.root.querySelector<HTMLElement>("#send-sym");
      if (sym) sym.textContent = tok.symbol;
      const lbl = this.root.querySelector<HTMLElement>("#amount-label");
      if (lbl) lbl.textContent = tr("Amount ({symbol})", { symbol: tok.symbol });
    }
  }

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!el) return;
    this.act(el.dataset.action!, el);
  }

  /**
   * The Android back button: a sheet is a rejection, a page in the browser goes back or closes, a
   * screen under a tab goes to the tab's root, an onboarding step cancels, and a root minimises the app.
   */
  async handleBack(): Promise<"sheet" | "page" | "screen" | "minimize"> {
    const s = this.s;
    if (s.dapp.approval) {
      await this.dappHost().decide(s.dapp.approval.key, false);
      return "sheet";
    }
    if (s.screen === "dapps" && this.host?.isOpen) {
      const went = await this.host.back();
      if (!went) await this.host.close();
      return "page";
    }
    const none = document.createElement("span");
    const toSettings: Screen[] = ["export", "save", "contacts", "duress", "duress-words", "bio-enable"];
    const toHome: Screen[] = ["send", "send-confirm", "sent", "receive", "nfts", "nft", "nft-send"];
    const toWelcome: Screen[] = ["create", "confirm", "passphrase", "import"];
    if (toSettings.includes(s.screen)) this.act("settings", none);
    else if (toHome.includes(s.screen)) this.act("back-home", none);
    else if (toWelcome.includes(s.screen)) this.act("welcome", none);
    else return "minimize";
    return "screen";
  }

  private act(action: string, el: HTMLElement) {
    switch (action) {
      case "create": {
        this.s.pendingMnemonic = newMnemonic();
        this.touch();
        this.go("create");
        break;
      }
      case "show-words":
        this.go("create"); // the same words; only "create" makes new ones
        break;
      case "wrote-down": {
        const idx = new Set<number>();
        const r = new Uint32Array(1);
        while (idx.size < 3) {
          crypto.getRandomValues(r);
          idx.add(r[0]! % 24);
        }
        this.s.confirmIdx = [...idx].sort((a, b) => a - b);
        this.go("confirm");
        break;
      }
      case "import":
        this.go("import");
        break;
      case "back-home":
        this.s.sent = null;
        this.s.exportWords = null;
        if (this.s.setup?.running) this.go("setup"); // an activation in progress: back to its progress view
        else {
          this.leaveSetup();
          this.go("home");
        }
        break;
      case "welcome":
        if (this.s.pendingSeed) wipe(this.s.pendingSeed);
        this.s.pendingMnemonic = null;
        this.s.pendingSeed = null;
        this.go("welcome");
        break;
      case "lock":
        this.lock();
        break;
      case "refresh":
        void this.run("Refreshing", () => this.refresh());
        break;
      case "send":
        this.s.sent = null;
        this.go("send");
        break;
      case "receive":
        this.go("receive");
        break;
      case "history":
        this.leaveSetup();
        this.loadActivity();
        break;
      case "tab-dapps":
        this.leaveSetup();
        this.go("dapps");
        break;
      case "settings":
        this.leaveSetup();
        this.s.exportWords = null;
        this.go("settings");
        break;
      case "copy": {
        const text = el.dataset.copy ?? "";
        const secs = this.s.clipboardWipe ? CLIPBOARD_WIPE_SECONDS : 0;
        void copyWithWipe(text, secs).then(
          () => {
            this.s.notice = secs ? tr("Copied. The clipboard clears itself in {s} s.", { s: secs }) : tr("Copied.");
            this.render();
            window.setTimeout(() => {
              this.s.notice = null;
              this.render();
            }, 2500);
          },
          () => {
            this.s.error = tr("Could not copy; select the text instead.");
            this.render();
          },
        );
        break;
      }
      case "contacts":
        this.go("contacts");
        break;
      case "contact-remove":
        this.s.book?.remove(el.dataset.address ?? "");
        this.render();
        break;
      case "scan": {
        // fills the "To" field in place; the user may have typed the amount already
        void scanAddress(this.scanner).then(
          (address) => {
            if (!address) return;
            const to = this.root.querySelector<HTMLInputElement>('form[data-form="send"] input[name="to"], form[data-form="nft-send"] input[name="to"]');
            if (to) {
              to.value = address;
              to.focus();
            }
          },
          (e: Error) => {
            this.s.error = e.message || String(e);
            this.render();
          },
        );
        break;
      }
      case "dapp-open":
        void this.run("Opening", () => this.openDapp(el.dataset.url ?? ""));
        break;
      case "dapp-close":
        void this.dappHost().close();
        break;
      case "dapp-back":
        void this.dappHost().back();
        break;
      case "wc-scan":
        void this.run("Scanning", async () => {
          const text = await this.scanner?.();
          if (!text) return;
          await this.pairWc(text.trim());
        });
        break;
      case "wc-disconnect":
        void this.run("Disconnecting", async () => {
          await this.wc.disconnect(el.dataset.topic ?? "");
          this.s.notice = tr("Disconnected.");
        });
        break;
      case "dapp-desktop":
        this.s.dapp.desktop = !this.s.dapp.desktop;
        void this.dappHost().setDesktop(this.s.dapp.desktop).catch(() => undefined);
        this.render();
        break;
      case "dapp-approve":
      case "dapp-reject":
        if (action === "dapp-approve" && Date.now() - this.sheetShownAt < this.approveDelayMs) break; // a tap meant for the page
        void this.dappHost()
          .decide(el.dataset.key ?? "", action === "dapp-approve")
          .catch((e: Error) => {
            this.s.error = e.message || String(e);
            this.render();
          });
        break;
      case "site-revoke":
        this.s.sites?.revoke(el.dataset.origin ?? "");
        this.render();
        break;
      case "nft-collection":
        void this.run("Loading the collection", () => this.loadCollection(el.dataset.address ?? ""));
        break;
      case "nft-open": {
        const list = this.s.nft.tokens[this.s.nft.collection ?? ""] ?? [];
        this.s.nft.token = list.find((t) => t.idHex === el.dataset.id) ?? null;
        if (this.s.nft.token) this.go("nft");
        break;
      }
      case "nft-send":
        this.go("nft-send");
        break;
      case "nft-back":
        this.go(this.s.nft.collection ? "nfts" : "home");
        break;
      case "nft-token-back":
        this.go("nft");
        break;
      case "collection-remove": {
        const addr = el.dataset.address ?? "";
        this.s.collections?.remove(this.network.name, addr);
        delete this.s.nft.tokens[addr];
        this.render();
        break;
      }
      case "token-remove": {
        const addr = el.dataset.address ?? "";
        this.s.tokens?.remove(this.network.name, addr);
        delete this.s.balances[addr];
        if (this.s.sendToken === addr) this.s.sendToken = "";
        this.render();
        break;
      }
      case "duress":
        this.go("duress");
        break;
      case "duress-create":
        this.s.pendingDecoy = newMnemonic();
        this.go("duress-words");
        break;
      case "duress-cancel":
        this.s.pendingDecoy = null;
        this.go("settings");
        break;
      case "send-cancel":
        this.s.sendCheck = null;
        this.go("send");
        break;
      case "remove-account": {
        const acct = this.accounts().find((a) => a.index === Number(el.dataset.index));
        if (!acct || acct.derived || acct.mode === "native") break;
        this.s.change = {
          title: acct.mode === "watch" ? tr("Stop watching") : tr("Remove account"),
          detail: tr("Remove {address} from this wallet's list. Nothing changes on chain, and you can add it back any time.", { address: acct.address }),
          apply: (v) => {
            v.accounts = v.accounts.filter((x) => x.address !== acct.address);
          },
        };
        this.go("save");
        break;
      }
      case "change-cancel":
        this.s.change = null;
        this.go("settings");
        break;
      case "native-balance":
        void this.run("Checking", async () => {
          if (!this.s.keys) return;
          const b = await this.chain().balance(this.s.keys.address);
          this.s.notice = tr("Native address on {net}: {amount} {unit}.", { net: this.network.name, amount: formatKoin(b), unit: this.unit() });
        });
        break;
      case "delete-wallet": {
        const typed = window.prompt(tr("This deletes the wallet from this device. Your 24 words are the only way back in.\nType DELETE to confirm."));
        if (typed === "DELETE") {
          localVaultStore.clear();
          clearWalletStores();
          void disableBiometrics(this.bio).catch(() => undefined);
          this.lock("Wallet deleted from this device.");
        }
        break;
      }
      case "bio-unlock":
        void this.run("Waiting for the device", () => this.unlockWithBiometrics());
        break;
      case "bio-enable":
        this.go("bio-enable");
        break;
      case "bio-disable":
        void this.run("Turning biometrics off", async () => {
          await disableBiometrics(this.bio);
          this.s.screen = "settings";
          this.s.notice = tr("Biometric unlock is off. The passphrase is the only way in.");
        });
        break;
      case "bio-cancel":
        this.go("settings");
        break;
      case "export":
        this.go("export");
        break;
      case "setup":
        this.startSetup();
        break;
      case "setup-retry":
        if (this.s.setup) {
          this.s.setup.failed = null;
          void this.run("Activating your account", () => this.runSetup());
        }
        break;
      case "setup-cancel":
        this.endSetup();
        this.go("settings");
        break;
      case "setup-done":
        this.endSetup();
        void this.run("Loading", () => this.enterHome());
        break;
      default:
        break;
    }
  }

  private onSubmit(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const field = (n: string) => String(data.get(n) ?? "");
    switch (form.dataset.form) {
      case "confirm": {
        const words = this.s.pendingMnemonic!.split(" ");
        const ok = this.s.confirmIdx.every((i, k) => field(`w${k}`).trim().toLowerCase() === words[i]);
        if (!ok) {
          this.s.error = tr("One of the words does not match. Check your note and try again.");
          this.render();
          return;
        }
        this.s.pendingSeed = mnemonicToSeed(this.s.pendingMnemonic!);
        this.s.pendingAccounts = [];
        this.go("passphrase");
        break;
      }
      case "import": {
        void this.run("Checking", async () => {
          const seed = parseSeedInput(field("seed"));
          const pq = field("pqwallet").trim();
          const accounts: AccountRecord[] = [];
          if (pq) {
            if (!isAddress(pq)) throw new Error(tr("the account address is not a valid Koinos address"));
            accounts.push({ label: "Post-quantum account", mode: "pqwallet", address: pq });
          }
          this.s.pendingSeed = seed;
          this.s.pendingAccounts = accounts;
          this.s.screen = "passphrase";
          this.touch();
        });
        break;
      }
      case "passphrase": {
        const p1 = field("p1"), p2 = field("p2");
        if (p1.length < MIN_PASSPHRASE_LENGTH) {
          this.s.error = tr("Use at least {n} characters.", { n: MIN_PASSPHRASE_LENGTH });
          this.render();
          return;
        }
        if (p1 !== p2) {
          this.s.error = tr("The two passphrases differ.");
          this.render();
          return;
        }
        void this.run("Encrypting", () => this.finishSetup(p1));
        break;
      }
      case "unlock": {
        void this.run("Unlocking", async () => {
          const stored = localVaultStore.load();
          if (!stored) throw new Error(tr("no wallet in this browser"));
          const file = await toFile(stored);
          const opened = await openVault(file, field("passphrase"));
          if (!("slots" in stored)) localVaultStore.save(file); // a pre-duress wallet: store it in the slot format from now on
          this.s.file = file;
          this.s.slot = opened.slot;
          this.s.vault = opened.data;
          const seed = hexToBytes(opened.data.seedHex);
          this.startSession(seed, opened.key);
          this.s.accountIndex = opened.data.accounts.length ? 1 : 0;
          this.touch();
          await this.enterHome();
        });
        break;
      }
      case "send": {
        // Step one: look at the recipient before anything is signed.
        const to = field("to").trim();
        const amount = field("amount").trim();
        const picked = field("token");
        const token = picked ? findToken(this.tokenList(), picked) : this.koinToken();
        if (!token) {
          this.s.error = tr("Choose a token from the list.");
          this.render();
          return;
        }
        this.s.sendToken = token.address === this.network.koin ? "" : token.address;
        const a = this.account();
        if (!a || !canSign(a)) {
          this.s.error = tr("This account is watch-only; it has no key here.");
          this.render();
          return;
        }
        try {
          parseUnits(amount, token.decimals);
        } catch (err) {
          this.s.error = (err as Error).message;
          this.render();
          return;
        }
        const assessment = this.s.book?.assess(to, this.ownAddresses()) ?? { kind: "new" as const };
        if (assessment.kind === "invalid") {
          this.s.error = tr("That is not a valid Koinos address (check every character; the checksum does not match).");
          this.render();
          return;
        }
        if (findToken(this.tokenList(), to) || this.collectionList().some((c) => c.address === to)) {
          this.s.error = tr("That address is a token or collection contract, not someone's account. Anything sent to it is lost.");
          this.render();
          return;
        }
        if (assessment.kind === "known" || assessment.kind === "own") {
          void this.run("Signing and sending", () => this.doSend(to, amount, "", token));
          return;
        }
        this.s.sendCheck = { to, amount, token, assessment };
        this.go("send-confirm");
        break;
      }
      case "send-confirm": {
        const sc = this.s.sendCheck;
        if (!sc) return;
        if (sc.assessment.kind === "lookalike") {
          const typed = field("tail").trim();
          if (typed !== sc.to.slice(-6)) {
            this.s.error = tr("The last six characters you typed do not match the address.");
            this.render();
            return;
          }
        } else if (!data.get("checked")) {
          this.s.error = tr("Tick the box once you have compared the whole address.");
          this.render();
          return;
        }
        const name = field("name").trim();
        if (sc.nft) void this.run("Signing and sending", () => this.doSendNft(sc.to, name, sc.nft!));
        else void this.run("Signing and sending", () => this.doSend(sc.to, sc.amount, name, sc.token));
        break;
      }
      case "add-collection": {
        const addr = field("address").trim();
        if (!isAddress(addr)) {
          this.s.error = tr("That is not a valid Koinos contract address.");
          this.render();
          return;
        }
        void this.run("Reading the collection", async () => {
          if (this.collectionList().some((c) => c.address === addr)) {
            this.s.notice = tr("That collection is already in the list.");
            return;
          }
          const info = await collectionInfo(this.chain(), addr);
          this.s.collections?.add(this.network.name, { address: addr, ...info });
          this.s.notice = tr("Added {name}.", { name: info.name || info.symbol });
        });
        break;
      }
      case "nft-send": {
        const to = field("to").trim();
        const token = this.s.nft.token;
        const a = this.account();
        if (!token || !a || !canSign(a)) {
          this.s.error = tr("This account is watch-only; it has no key here.");
          this.render();
          return;
        }
        const assessment = this.s.book?.assess(to, this.ownAddresses()) ?? { kind: "new" as const };
        if (assessment.kind === "invalid") {
          this.s.error = tr("That is not a valid Koinos address (check every character; the checksum does not match).");
          this.render();
          return;
        }
        if (assessment.kind === "known" || assessment.kind === "own") {
          void this.run("Signing and sending", () => this.doSendNft(to, "", token));
          return;
        }
        const col = this.collectionList().find((c) => c.address === token.collection);
        this.s.sendCheck = { to, amount: "1", token: { address: token.collection, symbol: col?.symbol ?? "NFT", name: col?.name ?? "", decimals: 0 }, nft: token, assessment };
        this.go("send-confirm");
        break;
      }
      case "add-token": {
        const addr = field("address").trim();
        if (!isAddress(addr)) {
          this.s.error = tr("That is not a valid Koinos contract address.");
          this.render();
          return;
        }
        void this.run("Reading the token", async () => {
          if (findToken(this.tokenList(), addr)) {
            this.s.notice = tr("That token is already in the list.");
            return;
          }
          const info = await this.chain().tokenInfo(addr);
          const clash = this.tokenList().find((t) => t.symbol.toLowerCase() === info.symbol.toLowerCase());
          if (clash) throw new Error(tr("A token called {symbol} is already in the list ({address}). This is a different contract using the same name, so it is not added.", { symbol: clash.symbol, address: short(clash.address) }));
          this.s.tokens?.add(this.network.name, { address: addr, ...info });
          this.s.notice = tr("Added {symbol} ({name}).", { symbol: info.symbol, name: info.name });
          const a = this.account();
          if (a) void this.fillTokenBalances(a.address);
        });
        break;
      }
      case "contact-rename": {
        const addr = field("address"), name = field("name");
        if (this.s.book && addr) this.s.book.upsert(addr, name);
        this.s.notice = tr("Saved.");
        this.render();
        break;
      }
      case "watch": {
        const addr = field("address").trim();
        if (!isAddress(addr)) {
          this.s.error = tr("That is not a valid Koinos address.");
          this.render();
          return;
        }
        const label = field("label").trim().slice(0, 60) || tr("Watched address");
        this.s.change = {
          title: tr("Watch an address"),
          detail: tr("Show {address} ({label}) in this wallet: balance, mana and history only. This wallet holds no key for it and cannot spend from it.", { address: addr, label }),
          apply: (v) => {
            if (v.accounts.some((x) => x.address === addr)) return;
            if (v.accounts.length >= MAX_ACCOUNTS) throw new Error(tr("This wallet already keeps {n} accounts, the most it holds.", { n: MAX_ACCOUNTS }));
            v.accounts.push({ label, mode: "watch", address: addr });
          },
        };
        this.go("save");
        break;
      }
      case "duress-save": {
        const d1 = field("d1"), d2 = field("d2");
        if (d1.length < MIN_PASSPHRASE_LENGTH) {
          this.s.error = tr("Use at least {n} characters for the duress passphrase.", { n: MIN_PASSPHRASE_LENGTH });
          this.render();
          return;
        }
        if (d1 !== d2) {
          this.s.error = tr("The two duress passphrases differ.");
          this.render();
          return;
        }
        void this.run("Saving the duress wallet", () => this.saveDecoy(field("main"), d1));
        break;
      }
      case "add-account": {
        const addr = field("address").trim();
        if (!isAddress(addr)) {
          this.s.error = tr("That is not a valid Koinos address.");
          this.render();
          return;
        }
        const label = field("label").trim().slice(0, 60) || tr("Post-quantum account");
        this.s.change = {
          title: tr("Add account"),
          detail: tr("Add {address} ({label}) to this wallet. It only works if that account's contract has this wallet's key registered.", { address: addr, label }),
          apply: (v) => {
            if (v.accounts.some((x) => x.address === addr)) return;
            if (v.accounts.length >= MAX_ACCOUNTS) throw new Error(tr("This wallet already keeps {n} accounts, the most it holds.", { n: MAX_ACCOUNTS }));
            v.accounts.push({ label, mode: "pqwallet", address: addr });
          },
        };
        this.go("save");
        break;
      }
      case "save":
        void this.run("Saving", () => this.saveChange(field("passphrase")));
        break;
      case "dapp-open":
        void this.run("Opening", () => this.openDapp(field("url").trim()));
        break;
      case "wc-pair":
        void this.run("Connecting", () => this.pairWc(field("uri")));
        break;
      case "wc-project": {
        const id = field("projectId").trim();
        if (id && !/^[0-9a-f]{32}$/i.test(id)) {
          this.s.error = tr("A project id is 32 hexadecimal characters.");
          this.render();
          return;
        }
        pref.set(PREF_WC_PROJECT, id);
        this.s.notice = id ? tr("Saved. WalletConnect is on.") : tr("Saved. WalletConnect is off.");
        this.render();
        break;
      }
      case "dapp-go":
        void this.run("Loading", async () => {
          let url = field("url").trim();
          if (!/^https?:\/\//.test(url)) url = `https://${url}`;
          if (this.host?.isOpen) await this.host.navigate(url);
          else await this.openDapp(url);
        });
        break;
      case "bio-enable":
        void this.run("Setting up", async () => {
          if (!this.s.file) throw new Error(tr("no wallet"));
          await enableBiometrics(this.s.file, this.s.slot, field("passphrase"), this.bio);
          this.s.screen = "settings";
          this.s.notice = tr("Biometric unlock is on for this wallet.");
        });
        break;
      case "export": {
        void this.run("Checking passphrase", async () => {
          const vault = await this.reopenCurrent(field("passphrase"));
          this.s.exportWords = seedToMnemonic(hexToBytes(vault.seedHex));
        });
        break;
      }
      case "autolock": {
        const m = Math.max(1, Math.min(120, Number(field("minutes")) || 10));
        this.s.autolockMinutes = m;
        pref.set(PREF_AUTOLOCK, String(m));
        this.s.lockOnHide = !!data.get("lockOnHide");
        pref.set(PREF_LOCK_ON_HIDE, this.s.lockOnHide ? "1" : "0");
        this.s.clipboardWipe = !!data.get("clipboardWipe");
        pref.set(PREF_CLIPBOARD_WIPE, this.s.clipboardWipe ? "1" : "0");
        this.touch();
        this.s.notice = tr("Auto-lock after {m} minutes{hide}. Clipboard wipe {wipe}.", { m, hide: this.s.lockOnHide ? tr(", and {s} s after the tab is hidden", { s: HIDDEN_LOCK_SECONDS }) : "", wipe: this.s.clipboardWipe ? tr("on") : tr("off") });
        this.render();
        break;
      }
      case "devnet-rpc": {
        pref.set(PREF_DEVNET_RPC, field("rpc").trim() || "http://127.0.0.1:8080/");
        this.s.notice = tr("Devnet RPC saved.");
        this.render();
        break;
      }
      default:
        break;
    }
  }

  // ---------- views ----------
  private tabs(): Tab[] {
    const t: Tab[] = [
      { id: "account", label: tr("Account"), action: "back-home" },
      { id: "activity", label: tr("Activity"), action: "history" },
    ];
    if (this.native) t.push({ id: "dapps", label: tr("Dapps"), action: "tab-dapps" });
    t.push({ id: "settings", label: tr("Settings"), action: "settings" });
    return t;
  }

  private render() {
    const s = this.s;
    const body = {
      welcome: () => this.vWelcome(),
      create: () => this.vCreate(),
      confirm: () => this.vConfirm(),
      passphrase: () => this.vPassphrase(),
      import: () => this.vImport(),
      unlock: () => this.vUnlock(),
      home: () => this.vHome(),
      send: () => this.vSend(),
      "send-confirm": () => this.vSendConfirm(),
      sent: () => this.vSent(),
      receive: () => this.vReceive(),
      history: () => this.vActivity(),
      dapps: () => this.vDapps(),
      settings: () => this.vSettings(),
      export: () => this.vExport(),
      setup: () => this.vSetup(),
      save: () => this.vSave(),
      contacts: () => this.vContacts(),
      duress: () => this.vDuress(),
      "duress-words": () => this.vDuressWords(),
      "bio-enable": () => this.vBioEnable(),
      nfts: () => this.vNfts(),
      nft: () => this.vNft(),
      "nft-send": () => this.vNftSend(),
    }[s.screen]();
    const tab = TAB_OF[s.screen];
    const inApp = !!tab && !!s.keys;
    const notes = [
      s.busy ? notice("busy", `${esc(s.busy)}…`) : "",
      s.error ? notice("danger", esc(s.error)) : "",
      s.notice ? notice("ok", esc(s.notice)) : "",
    ].join("");
    this.root.innerHTML = `
      <div class="shell">
        ${header(inApp ? button(tr("Lock"), { action: "lock", variant: "ghost", mini: true }) : s.keys ? "" : `<span class="hexstrip">ML-DSA-44</span>`)}
        ${inApp ? ticker(this.network.name, s.head, this.network.autoBlocks) : ""}
        <div class="content ${inApp ? "" : "plain"}">
          ${notes}
          ${body}
          ${inApp ? "" : `<p class="foot">${tr("Sparán · open source, MIT · a test build, not audited")}</p>`}
        </div>
        ${inApp ? tabBar(this.tabs(), tab) : ""}
      </div>`;
    const canvas = this.root.querySelector<HTMLCanvasElement>("canvas#qr");
    if (canvas) {
      const a = this.account();
      if (a) void QRCode.toCanvas(canvas, a.address, { width: 220, margin: 1 });
    }
    const setupCanvas = this.root.querySelector<HTMLCanvasElement>("canvas#qr-setup");
    if (setupCanvas && this.s.setup) void QRCode.toCanvas(setupCanvas, this.s.setup.account, { width: 180, margin: 1 });
    this.root.querySelector<HTMLElement>("[autofocus]")?.focus();
    this.placeDapp();
  }

  private vWelcome() {
    return `
      <h1 class="wide" style="margin-top:24px">${tr("A wallet that a quantum computer cannot pick")}</h1>
      <p>${tr("Your account is controlled by an <strong>ML-DSA-44</strong> key (the NIST post-quantum standard, FIPS 204) instead of secp256k1. The key lives only on this device, encrypted with a passphrase you choose, and is backed up by 24 words.")}</p>
      <div class="row">${button(tr("Create a new wallet"), { action: "create", variant: "primary" })}${button(tr("Import 24 words"), { action: "import" })}</div>
      <p class="fine" style="margin-top:16px">${tr("After you create it, send some KOIN to your new account and the wallet activates it by itself. This is a test build: use small amounts.")}</p>`;
  }

  private vCreate() {
    const w = this.s.pendingMnemonic!.split(" ");
    return `
      <h1>${tr("Write these 24 words down")}</h1>
      <p>${tr("On paper, in order. They are the only way to recover the wallet. Anyone who has them has your funds. Do not screenshot them.")}</p>
      ${card(words(w))}
      <div class="row">${button(tr("I have written them down"), { action: "wrote-down", variant: "primary" })}${button(tr("Cancel"), { action: "welcome", variant: "ghost" })}</div>`;
  }

  private vConfirm() {
    return `
      <h1>${tr("Check your note")}</h1>
      <form data-form="confirm">
        ${this.s.confirmIdx.map((i, k) => field(tr("Word number {n}", { n: i + 1 }), input({ name: `w${k}`, class: "mono", autocomplete: "off", autocapitalize: "none", spellcheck: "false", required: true, autofocus: k === 0 }))).join("")}
        <div class="row">${button(tr("Continue"), { variant: "primary" })}${button(tr("Show the words again"), { action: "show-words", variant: "ghost" })}</div>
      </form>`;
  }

  private vPassphrase() {
    return `
      <h1>${tr("Choose a passphrase")}</h1>
      <p>${tr("It encrypts the wallet on this device. It does not replace the 24 words: if you forget it, import the words again.")}</p>
      <form data-form="passphrase">
        ${field(tr("Passphrase ({n}+ characters)", { n: MIN_PASSPHRASE_LENGTH }), input({ name: "p1", type: "password", minlength: MIN_PASSPHRASE_LENGTH, required: true, autofocus: true, autocomplete: "new-password" }))}
        ${field(tr("Repeat it"), input({ name: "p2", type: "password", minlength: MIN_PASSPHRASE_LENGTH, required: true, autocomplete: "new-password" }))}
        <div class="row">${button(tr("Create wallet"), { variant: "primary" })}${button(tr("Cancel"), { action: "welcome", variant: "ghost" })}</div>
      </form>`;
  }

  private vImport() {
    return `
      <h1>${tr("Import")}</h1>
      <form data-form="import">
        ${field(tr("Your 24 words"), `<textarea name="seed" rows="4" autocomplete="off" autocapitalize="none" spellcheck="false" required autofocus></textarea>`)}
        <p class="fine">${tr("An account this wallet activated is found again automatically.")}</p>
        <details class="adv"><summary>Advanced</summary>
          ${field(tr("The 64-character seed from the koinos-pq command-line tool also works in the box above. For an account set up with that tool, give its address:"), input({ name: "pqwallet", class: "mono", autocomplete: "off", placeholder: "1…" }))}
        </details>
        <div class="row">${button(tr("Continue"), { variant: "primary" })}${button(tr("Cancel"), { action: "welcome", variant: "ghost" })}</div>
      </form>`;
  }

  private vUnlock() {
    const bio = this.native && biometricsEnabled(this.bio.blobs);
    if (bio && this.bioAvailable === null) {
      this.bioAvailable = false;
      void this.bio.biometry.available().then((ok) => {
        this.bioAvailable = ok;
        if (ok && this.s.screen === "unlock") this.render();
      }, () => undefined);
    }
    return `
      <h1 class="wide" style="margin-top:40px">${tr("Unlock")}</h1>
      ${bio && this.bioAvailable ? `<div class="row" style="margin-top:0">${button(tr("Unlock with fingerprint or face"), { action: "bio-unlock", variant: "primary", block: true })}</div><p class="fine" style="margin:12px 0 0">${tr("Or type the passphrase.")}</p>` : ""}
      <form data-form="unlock">
        ${field(tr("Passphrase"), input({ name: "passphrase", type: "password", required: true, autofocus: !(bio && this.bioAvailable), autocomplete: "current-password" }))}
        <div class="row">${button(tr("Unlock"), { variant: bio && this.bioAvailable ? undefined : "primary", block: true })}</div>
      </form>
      <p class="fine" style="margin-top:24px">Lost the passphrase? ${linkButton(tr("Delete this wallet"), "delete-wallet")} and import your 24 words again.</p>`;
  }

  private accountPicker() {
    const items = this.visibleAccounts();
    const cur = this.account();
    if (items.length <= 1) return "";
    return `<ul class="accts">${items
      .map(
        (a) =>
          `<li><label><input type="radio" name="account" value="${a.index}" ${cur && a.index === cur.index ? "checked" : ""}><span class="grow">${esc(a.label)} <span class="s mono">${esc(shortAddr(a.address))}</span>${a.mode === "native" ? ` <span class="s">${tr("native")}</span>` : a.mode === "watch" ? ` <span class="s">${tr("watch-only")}</span>` : ""}</span></label></li>`,
      )
      .join("")}</ul>`;
  }

  private vHome() {
    const a = this.account();
    const s = this.s;
    if (!a) {
      return `
        ${section("01", tr("Account"))}
        <h1>${tr("Activate your account")}</h1>
        <p>${tr("Your wallet has its post-quantum key. To use it on <strong>{net}</strong>, send some {unit} to your account's address and the wallet activates it.", { net: esc(this.network.name), unit: esc(this.unit()) })}</p>
        <div class="row">${button(tr("Show my account's address"), { action: "setup", variant: "primary" })}${button(tr("Settings"), { action: "settings" })}</div>`;
    }
    const unit = this.unit();
    const sig = a.mode === "native" ? "ML-DSA-44 · 3,733 B" : "ML-DSA-44 · 2,420 B";
    return `
      ${section("01", tr("Account"), hexStrip(a.address))}
      ${this.accountPicker()}
      ${card(`
        <span class="lbl">${esc(a.label)} · ${esc(this.network.name)}</span>
        ${addressStrip(a.address)}
        <div class="row tight">${button(tr("Copy"), { action: "copy", mini: true, data: { copy: a.address } })}${button(tr("Refresh"), { action: "refresh", variant: "ghost", mini: true })}${this.network.explorerAddress ? `<a class="btn ghost mini" href="${esc(this.network.explorerAddress(a.address))}" target="_blank" rel="noopener noreferrer">${tr("Explorer")}</a>` : ""}</div>
        <div style="margin-top:20px">${balance(s.balance === null ? null : fmtAmount(formatKoin(s.balance)), unit)}</div>
        <div style="margin-top:12px">
          ${stat(tr("Mana"), s.mana === null ? "…" : esc(fmtAmount(formatKoin(s.mana, 2))))}
          ${stat(tr("Signature"), canSign(a) ? esc(sig) : "none here (watch-only)")}
        </div>
        <div class="actions">
          ${canSign(a) ? button(tr("Send"), { action: "send", variant: "primary" }) : button(tr("Watch-only"), { type: "button", disabled: true, title: tr("Watch-only: this wallet has no key for this address") })}
          ${button(tr("Receive"), { action: "receive" })}
        </div>`)}
      ${this.vTokens()}
      ${this.vCollectibles()}`;
  }

  private vCollectibles(): string {
    const cols = this.collectionList();
    const rows = cols
      .map((c) => {
        const held = this.s.nft.tokens[c.address];
        const count = held === undefined || held === null ? "" : `<span class="s">${tr("{n} held", { n: held.length })}</span>`;
        return `<li>${tile(c.symbol || c.name)}<span class="grow"><span class="t">${esc(c.name || c.symbol)}</span> ${count}<br><span class="s">${esc(c.symbol)} · ${linkButton(tr("remove"), "collection-remove", { address: c.address })}</span></span>${button(tr("Open"), { action: "nft-collection", mini: true, data: { address: c.address } })}</li>`;
      })
      .join("");
    return `
      ${section("03", tr("Collectibles"), cols.length === 1 ? tr("1 collection") : tr("{n} collections", { n: cols.length }))}
      ${cols.length ? list(rows) : `<p class="mute">${tr("No collections yet. Add one by its contract address (KCS-5).")}</p>`}
      <form data-form="add-collection" class="field inline">
        <label><span>Add a collection by its contract address</span>${input({ name: "address", class: "mono", placeholder: "1…", autocomplete: "off", required: true })}</label>
        ${button(tr("Add"), { mini: true })}
      </form>`;
  }

  private nftTile(t: NftToken, meta: NftMetadata | null | undefined): string {
    const pic = meta?.image ? `<img src="${esc(meta.image)}" alt="" loading="lazy">` : `#${esc(t.label)}`;
    return `<button class="nft" type="button" data-action="nft-open" data-id="${esc(t.idHex)}" data-nft="${esc(t.idHex)}"><span class="pic">${pic}</span><span class="cap">${esc(meta?.name || `#${t.label}`)}<span class="s">#${esc(t.label)}</span></span></button>`;
  }

  private vNfts() {
    const addr = this.s.nft.collection ?? "";
    const col = this.collectionList().find((c) => c.address === addr);
    const held = this.s.nft.tokens[addr] ?? [];
    return `
      ${section("03", tr("Collectibles"), esc(col?.symbol ?? ""))}
      <h1>${esc(col?.name || col?.symbol || tr("Collection"))}</h1>
      ${held.length ? `<div class="nfts">${held.map((t) => this.nftTile(t, this.s.nft.meta[`${addr}:${t.idHex}`])).join("")}</div>` : `<p class="mute">${tr("This account holds nothing in this collection.")}</p>`}
      <div class="row">${button(tr("Back"), { action: "back-home", variant: "ghost" })}</div>`;
  }

  private vNft() {
    const t = this.s.nft.token;
    if (!t) return `<p>${tr("Nothing to show.")}</p>`;
    const col = this.collectionList().find((c) => c.address === t.collection);
    const meta = this.s.nft.meta[`${t.collection}:${t.idHex}`];
    const a = this.account();
    return `
      ${section("03", tr("Collectibles"), esc(col?.symbol ?? ""))}
      <div class="nft-hero">${meta?.image ? `<img src="${esc(meta.image)}" alt="">` : `#${esc(t.label)}`}</div>
      <h1>${esc(meta?.name || `#${t.label}`)}</h1>
      ${meta?.description ? `<p class="mute">${esc(meta.description)}</p>` : ""}
      <div style="margin-top:12px">${stat(tr("Collection"), esc(col?.name || shortAddr(t.collection)))}${stat(tr("Token id"), `#${esc(t.label)}`)}${stat(tr("Contract"), esc(shortAddr(t.collection)))}</div>
      <div class="row">${a && canSign(a) ? button(tr("Send"), { action: "nft-send", variant: "primary" }) : ""}${button(tr("Back"), { action: "nft-back", variant: "ghost" })}</div>`;
  }

  private vNftSend() {
    const t = this.s.nft.token;
    if (!t) return `<p>${tr("Nothing to send.")}</p>`;
    const col = this.collectionList().find((c) => c.address === t.collection);
    const meta = this.s.nft.meta[`${t.collection}:${t.idHex}`];
    return `
      ${section("03", tr("Send"), esc(col?.symbol ?? ""))}
      <h1>${tr("Send {what}", { what: esc(meta?.name || `#${t.label}`) })}</h1>
      <form data-form="nft-send">
        <label class="field"><span>To</span><div class="withbtn">${input({ name: "to", class: "mono", autocomplete: "off", required: true, placeholder: "1…", autofocus: true, list: "contacts" })}${
          this.native ? button(`<span class="sr-only">Scan a QR code</span><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="stroke:currentColor;fill:none;stroke-width:1.75"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8" y="8" width="8" height="8"/></svg>`, { action: "scan", mini: true, title: tr("Scan a QR code") }) : ""
        }</div></label>
        <datalist id="contacts">${(this.s.book?.list() ?? []).map((c) => `<option value="${esc(c.address)}">${esc(c.name || short(c.address))}</option>`).join("")}</datalist>
        <p class="fine">${tr("The collectible leaves this account for good once the transaction is in a block. A first-time or look-alike recipient asks you to confirm it before anything is signed.")}</p>
        <div class="row">${button(tr("Sign and send"), { variant: "primary" })}${button(tr("Back"), { action: "nft-token-back", variant: "ghost" })}</div>
      </form>`;
  }

  private vTokens(): string {
    const s = this.s;
    const tokens = this.tokenList();
    const shown = tokens.filter((t) => {
      if (t.address === this.network.koin || !s.hideZero) return true;
      const v = this.tokenBalance(t);
      return v === undefined || v === null || v > 0n;
    });
    const rows = shown
      .map(
        (t) =>
          `<li data-token="${esc(t.address)}">${tile(t.symbol)}<span class="grow"><span class="t">${esc(t.name)}</span><br><span class="s">${esc(t.symbol)}${t.custom ? ` · ${tr("added")} ${linkButton(tr("remove"), "token-remove", { address: t.address })}` : ""}</span></span><span class="amt">${esc(this.tokenAmount(t))}</span></li>`,
      )
      .join("");
    return `
      ${section("02", tr("Tokens"), tr("{a} of {b}", { a: shown.length, b: tokens.length }))}
      ${list(rows)}
      <label class="check"><input type="checkbox" name="hideZero" ${s.hideZero ? "checked" : ""}> ${tr("Hide zero balances")}</label>
      <form data-form="add-token" class="field inline">
        <label><span>Add a token by its contract address</span>${input({ name: "address", class: "mono", placeholder: "1…", autocomplete: "off", required: true })}</label>
        ${button(tr("Add"), { mini: true })}
      </form>
      <p class="fine">${tr("Name, symbol and decimals are read from the contract itself. The list is this wallet's own; nothing is fetched from anyone's server.")}</p>`;
  }

  private vSend() {
    const a = this.account();
    const tokens = this.tokenList();
    const tok = this.currentSendToken();
    return `
      ${section("01", tr("Send"), `from <span class="mono">${esc(shortAddr(a?.address))}</span>`)}
      <h1>Send <span id="send-sym">${esc(tok.symbol)}</span></h1>
      <form data-form="send">
        ${field(tr("Token"), `<select name="token">${tokens.map((t) => `<option value="${esc(t.address)}" ${t.address === tok.address ? "selected" : ""}>${esc(t.symbol)} · ${esc(this.tokenAmount(t))}</option>`).join("")}</select>`)}
        <label class="field"><span>To</span><div class="withbtn">${input({ name: "to", class: "mono", autocomplete: "off", required: true, placeholder: "1…", autofocus: true, list: "contacts" })}${
          this.native
            ? button(`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="stroke:currentColor;fill:none;stroke-width:1.75"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8" y="8" width="8" height="8"/></svg><span class="sr-only">Scan a QR code</span>`, { action: "scan", mini: true, title: tr("Scan a QR code") })
            : ""
        }</div></label>
        <datalist id="contacts">${(this.s.book?.list() ?? []).map((c) => `<option value="${esc(c.address)}">${esc(c.name || short(c.address))}</option>`).join("")}</datalist>
        <label class="field"><span id="amount-label">${tr("Amount ({symbol})", { symbol: esc(tok.symbol) })}</span>${input({ name: "amount", class: "mono", inputmode: "decimal", autocomplete: "off", required: true, placeholder: "0.5" })}</label>
        <p class="fine">${tr("From {label} on {net}, signed here with ML-DSA-44 ({sig}). A first-time or look-alike recipient asks you to confirm it before anything is signed.", { label: esc(a?.label ?? ""), net: esc(this.network.name), sig: a?.mode === "native" ? tr("3,733-byte native entry") : tr("2,420-byte signature") })}</p>
        <div class="row">${button(tr("Sign and send"), { variant: "primary" })}${button(tr("Back"), { action: "back-home", variant: "ghost" })}</div>
      </form>`;
  }

  private vSent() {
    const t = this.s.sent!;
    const link = this.network.explorerTx?.(t.txId);
    return `
      ${section("01", tr("Send"), t.waiting ? tr("waiting") : t.block ? tr("mined") : tr("submitted"))}
      <h1>${t.waiting ? tr("Sent, waiting for a block") : t.block ? tr("Mined") : tr("Submitted")}</h1>
      ${card(`<span class="lbl">Sent</span><div class="bal" style="margin-bottom:12px"><span class="v" style="font-size:28px">${esc(fmtAmount(t.amount))}</span><span class="u">${esc(t.symbol)}</span></div><span class="lbl">Transaction</span><code class="address addr sm box" style="color:var(--ink)">${esc(t.txId)}</code>
        <div style="margin-top:12px">${stat(tr("Signature entry"), `${esc(t.bytes)} B`)}${stat(tr("Mana used"), esc(t.rcUsed))}${t.block ? stat(tr("Block"), esc(fmtAmount(t.block))) : ""}</div>`)}
      ${this.network.autoBlocks ? "" : `<p class="fine" style="margin-top:12px">${tr("This network only makes blocks when the devnet script produces one.")}</p>`}
      ${link ? `<p style="margin-top:12px"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${tr("Open in explorer")}</a></p>` : ""}
      <div class="row">${button(tr("Done"), { action: "back-home", variant: "primary" })}</div>`;
  }

  private vReceive() {
    const a = this.account();
    return `
      ${section("01", tr("Receive"), esc(a?.label ?? ""))}
      ${card(`
        <canvas id="qr" class="qr" width="220" height="220" aria-label="QR code of the address"></canvas>
        ${addressStrip(a?.address ?? "", { box: true })}
        <div class="row">${button(tr("Copy address"), { action: "copy", variant: "primary", data: { copy: a?.address ?? "" } })}${button(tr("Back"), { action: "back-home", variant: "ghost" })}</div>
        ${this.s.clipboardWipe ? `<p class="fine" style="margin-top:12px">The clipboard clears itself ${CLIPBOARD_WIPE_SECONDS} s after copying.</p>` : ""}`, `style="text-align:center"`)}`;
  }

  private vActivity() {
    const a = this.account();
    const h = this.s.history ?? [];
    const tokens = this.tokenList();
    const rows = h
      .map((i) => {
        let main = `<span class="t">${esc(i.summary)}</span>`;
        let amt = "";
        if (i.direction && i.valueBase) {
          const t = i.contract ? findToken(tokens, i.contract) : undefined;
          let value: string;
          try {
            value = t ? fmtAmount(formatUnits(BigInt(i.valueBase), t.decimals)) : fmtAmount(i.valueBase);
          } catch {
            value = "?";
          }
          const sym = t ? t.symbol : i.contract ? `${tr("units of")} ${shortAddr(i.contract)}` : "?";
          const who = i.counterparty ? this.s.book?.get(i.counterparty)?.name || shortAddr(i.counterparty) : "?";
          main = `<span class="t">${i.direction === "out" ? tr("Sent") : tr("Received")} ${esc(value)} ${esc(sym)}</span> <span class="s">${i.direction === "out" ? tr("to") : tr("from")} ${esc(who)}${i.reverted ? " " + tr("(reverted)") : ""}</span>`;
          amt = `<span class="amt">${i.direction === "out" ? "−" : "+"}${esc(value)}</span>`;
        }
        const meta = [i.txId ? esc(short(i.txId)) : "", i.blockHeight ? `block ${esc(fmtAmount(i.blockHeight))}` : ""].filter(Boolean).join(" · ");
        return listRow(`${main}<br><span class="s mono">${meta}</span>`, amt);
      })
      .join("");
    return `
      ${section("02", tr("Activity"), `<span class="mono">${esc(shortAddr(a?.address))}</span>`)}
      ${!a ? `<p class="mute">${tr("No account on {net} yet.", { net: esc(this.network.name) })}</p>` : h.length ? list(rows) : `<p class="mute">${tr("Nothing yet.")}</p>`}
      <div class="row tight">${button(tr("Refresh"), { action: "history", variant: "ghost", mini: true })}</div>`;
  }

  private vWalletConnect(): string {
    const on = !!this.wcProjectId();
    const sessions = this.s.wcSessions;
    const scanBtn = this.native && this.scanner ? button(`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="stroke:currentColor;fill:none;stroke-width:1.75"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8" y="8" width="8" height="8"/></svg><span class="sr-only">${tr("Scan a WalletConnect code")}</span>`, { action: "wc-scan", mini: true, title: tr("Scan a WalletConnect code") }) : "";
    return `
      ${section(null, tr("WalletConnect"), on ? tr("on") : tr("off"))}
      <p class="fine">${tr("For dapps on another device or in another browser (KoinDX, Vortex Bridge): choose WalletConnect on the dapp, then scan its code here or paste the wc: link. Every request still comes to this wallet's approval sheet.")}</p>
      ${
        on
          ? `<form data-form="wc-pair" class="field inline">
              <label><span>${tr("Pairing link")}</span>${input({ name: "uri", class: "mono", autocomplete: "off", placeholder: "wc:…", required: true })}</label>
              ${scanBtn}${button(tr("Connect"), { mini: true })}
            </form>
            ${sessions.length ? `${section(null, tr("Connected dapps"))}${list(sessions.map((w) => listRow(`<span class="t">${esc(w.name)}</span><br><span class="s mono">${esc(w.origin)}</span>`, linkButton(tr("disconnect"), "wc-disconnect", { topic: w.topic }))).join(""))}` : `<p class="mute">${tr("No dapp connected through WalletConnect.")}</p>`}`
          : `<p class="mute">${tr("Needs a free project id from cloud.reown.com, entered once under Settings › WalletConnect.")}</p>`
      }`;
  }
  /** The approval sheet, on top of whatever the Dapps tab shows (a page, or the list when a WalletConnect request comes in). */
  private approvalSheet(): string {
    const a = this.s.dapp.approval;
    if (!a) return "";
    const wc = (a.req.args?.wc ?? null) as { name?: string; chains?: string[] } | null;
    return `<div class="scrim" data-action="dapp-reject" data-key="${esc(a.key)}"></div><section class="sheet" role="dialog" aria-labelledby="req">
              <div class="grab" aria-hidden="true"></div>
              <div class="sheet-body">
                ${section(">", tr("Request"), esc(this.network.name))}
                ${this.originHeading(a.req.origin)}
                ${a.source === "wc" ? `<p class="fine">${tr("Through WalletConnect, as <strong>{name}</strong>.", { name: esc(a.via ?? "") })}${a.unverified ? ` <span class="warn-inline">${tr("The relay could not verify that this request really comes from that site. Check the address above against the dapp you are using.")}</span>` : ""}</p>` : ""}
                ${wc?.chains?.length ? `<p class="fine">${tr("The dapp asks for: {chains}.", { chains: esc(wc.chains.join(", ")) })}</p>` : ""}
                ${a.plan ? describePlan(a.plan, this.s.tokens) : notice("danger", tr("This site sent a request the wallet will not sign. {why}", { why: esc(a.refused ?? "") }))}
              </div>
              <div class="sheet-actions">
                ${
                  a.plan
                    ? a.status
                      ? notice("busy", esc(a.status))
                      : `<div class="row">${button(tr("Approve"), { action: "dapp-approve", variant: "primary", data: { key: a.key }, disabled: Date.now() - this.sheetShownAt < this.approveDelayMs })}${button(tr("Reject"), { action: "dapp-reject", variant: "ghost", data: { key: a.key } })}</div>`
                    : `<div class="row">${button(tr("Close"), { action: "dapp-reject", variant: "ghost", data: { key: a.key } })}</div>`
                }
              </div>
            </section>`;
  }

  private vDapps() {
    const d = this.s.dapp;
    if (!d.open) {
      const sites = this.s.sites?.list() ?? [];
      return `
        ${section("03", tr("Dapps"), tr("curated"))}
        ${list((dappList as { dapps: Array<{ id: string; name: string; summary: string; url: string }> }).dapps.map((x) => `<li>${tile(x.name)}<span class="grow"><span class="t">${esc(x.name)}</span><br><span class="s">${esc(x.summary)}</span></span>${button(tr("Open"), { action: "dapp-open", mini: true, data: { url: x.url } })}</li>`).join(""))}
        <form data-form="dapp-open" class="field inline">
          <label><span>Or any address</span>${input({ name: "url", class: "mono", inputmode: "url", autocomplete: "off", placeholder: "https://…", required: true })}</label>
          ${button(tr("Go"), { mini: true })}
        </form>
        <p class="fine">${tr("Sites see your account address only after you allow it, and every signature is approved here in the wallet, never on the page. The list is this wallet's own.")}</p>
        ${this.vWalletConnect()}
        ${sites.length ? `${section(null, tr("Sites allowed to see your accounts"))}${list(sites.map((g) => listRow(`<span class="t mono">${esc(g.origin)}</span><br><span class="s">${tr("since {date}", { date: esc(g.allowedAt.slice(0, 10)) })}</span>`, linkButton(tr("forget"), "site-revoke", { origin: g.origin }))).join(""))}` : ""}
        ${this.approvalSheet()}`;
    }
    return `
      <div class="urlbar">
        ${button(tr("&larr;"), { action: "dapp-back", mini: true, title: tr("Back"), disabled: !d.canGoBack })}
        <form data-form="dapp-go" class="grow" style="flex:1 1 auto">${input({ name: "url", class: "in", inputmode: "url", autocomplete: "off", value: d.url, "aria-label": "Address" })}</form>
        ${button(tr("PC"), { action: "dapp-desktop", mini: true, title: tr("Desktop version of the page"), attrs: `aria-pressed="${d.desktop ? "true" : "false"}"` })}
        ${button(tr("&times;"), { action: "dapp-close", mini: true, title: tr("Close the page") })}
      </div>
      <div id="dapp-area" style="height:calc(100vh - 220px)"></div>
      ${this.approvalSheet()}`;
  }

  /** The requesting site: its host in bold, the scheme muted, and a badge when it is not encrypted. */
  private originHeading(origin: string): string {
    let host = origin, scheme = "";
    try {
      const u = new URL(origin);
      host = u.host;
      scheme = u.protocol;
    } catch {
      /* shown as it came */
    }
    return `<h1 id="req" style="font-size:22px"><span class="rest">${esc(scheme ? `${scheme}//` : "")}</span><span class="host">${esc(host)}</span>${scheme === "http:" ? `<span class="badge-http">${tr("not encrypted")}</span>` : ""}</h1>`;
  }

  private vSettings() {
    const net = this.network.name;
    const items = this.accounts().filter((a) => a.mode === "pqwallet" || a.mode === "watch");
    const hasHere = this.visibleAccounts().some((a) => a.mode === "pqwallet");
    const sel = (name: string, options: Array<[string, string]>, current: string) =>
      `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    return `
      ${section("04", tr("Settings"), esc(__APP_VERSION__))}
      <h1>${tr("Settings")}</h1>
      ${section(null, tr("Accounts"))}
      ${
        items.length
          ? list(items.map((a) => listRow(`<span class="t">${esc(a.label)}</span>${a.mode === "watch" ? ` <span class="s">${tr("watch-only")}</span>` : ""}<br><span class="s mono">${esc(a.address)}</span>`, a.derived ? `<span class="s">${tr("found from your 24 words")}</span>` : linkButton(tr("remove"), "remove-account", { index: a.index }))).join(""))
          : `<p class="mute">${tr("No account on {net} yet.", { net: esc(net) })}</p>`
      }
      ${hasHere ? "" : `<div class="row tight">${button(tr("Activate your account on {net}", { net: esc(net) }), { action: "setup", variant: "primary" })}</div>`}
      <form data-form="watch" class="field inline">
        <label><span>Watch an address</span>${input({ name: "address", class: "mono", placeholder: "1…", autocomplete: "off", required: true })}</label>
        <label><span>Label</span>${input({ name: "label", placeholder: "optional", autocomplete: "off" })}</label>
        ${button(tr("Watch"))}
      </form>
      <p class="fine">${tr("See the balance, mana and activity of any address (your cold account, a friend's). No key, no sending.")}</p>

      ${section(null, tr("Security"))}
      ${
        this.native
          ? biometricsEnabled(this.bio.blobs)
            ? `<p class="mute">${tr("Biometric unlock is on. It opens the wallet that turned it on last; the passphrase always works too.")}</p><div class="row tight">${button(tr("Turn biometric unlock off"), { action: "bio-disable" })}</div>`
            : `<p class="mute">${tr("Unlock with fingerprint or face instead of typing the passphrase. The device keeps a wrapped copy of this wallet's key, never the passphrase or the words.")}</p><div class="row tight">${button(tr("Turn biometric unlock on"), { action: "bio-enable" })}</div>`
          : ""
      }
      <form data-form="autolock">
        ${check("lockOnHide", tr("Lock {s} s after this tab is hidden or the screen goes off", { s: HIDDEN_LOCK_SECONDS }), this.s.lockOnHide)}
        ${check("clipboardWipe", tr("Clear the clipboard {s} s after copying an address", { s: CLIPBOARD_WIPE_SECONDS }), this.s.clipboardWipe)}
        ${field(tr("Auto-lock after minutes without activity"), input({ name: "minutes", class: "mono", type: "number", min: 1, max: 120, value: this.s.autolockMinutes, style: "max-width:7em" }))}
        <div class="row tight">${button(tr("Save"))}</div>
      </form>

      ${section(null, tr("Backup"))}
      <p class="mute">${tr("Show the 24 words again (asks for the passphrase).")}</p>
      <div class="row tight">${button(tr("Show recovery words"), { action: "export" })}</div>

      ${section(null, tr("Contacts"), tr("{n} saved", { n: this.s.book?.list().length ?? 0 }))}
      <p class="mute">${tr("Sending to an address you have never used, or one that merely resembles one you have, asks you to check it first.")}</p>
      <div class="row tight">${button(tr("Open contacts"), { action: "contacts" })}</div>

      ${section(null, tr("Duress wallet"))}
      <p class="mute">${tr("A second passphrase opens a separate, small wallet to show under pressure. This screen never says whether one exists.")}${this.native ? ` ${tr("Setting one up turns biometric unlock off for every wallet on this device.")}` : ""}</p>
      <div class="row tight">${button(tr("Set up or replace the duress wallet"), { action: "duress" })}</div>

      ${section(null, tr("WalletConnect"), this.wcProjectId() ? tr("on") : tr("off"))}
      <p class="mute">${tr("Connects dapps on other devices (KoinDX, Vortex Bridge) through the WalletConnect relay. It needs a project id: create a free one at cloud.reown.com and paste it here. The id is a public identifier, not a secret.")}</p>
      <form data-form="wc-project" class="field inline">
        <label><span>${tr("Project id")}</span>${input({ name: "projectId", class: "mono", autocomplete: "off", spellcheck: "false", value: pref.get(PREF_WC_PROJECT) ?? "", placeholder: WC_PROJECT_DEFAULT ? tr("built-in id in use") : "" })}</label>
        ${button(tr("Save"), { mini: true })}
      </form>

      ${section(null, tr("Network"))}
      ${field(tr("Node"), sel("network", Object.keys(NETWORKS).map((n) => [n, n === "testnet" ? "testnet (Harbinger)" : n]), this.s.networkName))}
      ${net === "devnet" ? `<form data-form="devnet-rpc" class="field inline"><label><span>Devnet RPC</span>${input({ name: "rpc", class: "mono", value: pref.get(PREF_DEVNET_RPC) ?? "http://127.0.0.1:8080/" })}</label>${button(tr("Save"))}</form>` : ""}

      ${section(null, tr("Appearance"))}
      ${field(tr("Theme"), sel("theme", [["system", tr("Follow the system")], ["light", tr("Light")], ["dark", tr("Dark")]], this.s.theme))}
      ${field(tr("Language"), sel("lang", LANGUAGES.map((l) => [l.code, l.name]), currentLanguage()))}

      ${section(null, tr("About"))}
      <p class="mute">${tr("Sparán {version}, a post-quantum wallet for Koinos. Open source, MIT. Accounts are controlled by an ML-DSA-44 key (FIPS 204). Keys never leave this device. A test build, not audited.", { version: esc(__APP_VERSION__) })}</p>
      <p class="fine"><a href="https://wallet.koinosproof.com/privacy.html" target="_blank" rel="noopener noreferrer">${tr("Privacy")}</a> · <a href="https://github.com/Justyoureverydaynormalguybob/koinos-pq-wallet" target="_blank" rel="noopener noreferrer">${tr("Source code")}</a></p>

      <details class="adv"><summary>Advanced</summary>
        ${section(null, tr("Add an account by address"))}
        <p class="fine">${tr("Only for an account set up with the koinos-pq command-line tool. Accounts this wallet activates are found automatically.")}</p>
        <form data-form="add-account" class="field inline">
          <label><span>Address</span>${input({ name: "address", class: "mono", placeholder: "1…", autocomplete: "off", required: true })}</label>
          <label><span>Label</span>${input({ name: "label", placeholder: "optional", autocomplete: "off" })}</label>
          ${button(tr("Add"))}
        </form>
        ${section(null, tr("Native post-quantum address"))}
        <p class="fine">${tr("The address of the key itself. It needs nodes that verify ML-DSA-44 directly, a proposed node change that runs on the devnet only. On mainnet and Harbinger it can receive but cannot spend, so do not send to it.")}</p>
        ${addressStrip(this.s.keys?.address ?? "", { size: "sm", box: true })}
        <div class="row tight">${button(tr("Check its balance on {net}", { net: esc(net) }), { action: "native-balance", mini: true })}</div>
      </details>

      ${(this.s.sites?.list().length ?? 0) > 0 ? `${section(null, tr("Sites allowed to see your accounts"))}${list(this.s.sites!.list().map((g) => listRow(`<span class="t mono">${esc(g.origin)}</span><br><span class="s">${tr("since {date}", { date: esc(g.allowedAt.slice(0, 10)) })}</span>`, linkButton(tr("forget"), "site-revoke", { origin: g.origin }))).join(""))}` : ""}

      ${section(null, tr("Danger"))}
      <div class="row tight">${button(tr("Delete wallet from this device"), { action: "delete-wallet", variant: "danger" })}</div>`;
  }

  private vSetup() {
    const st = this.s.setup;
    if (!st) return `<p>${tr("Nothing to activate.")}</p>`;
    const unit = this.unit();
    if (st.result) {
      const r = st.result;
      const link = (id: string | null) => (id && this.network.explorerTx ? `<a href="${esc(this.network.explorerTx(id))}" target="_blank" rel="noopener noreferrer">${esc(short(id))}</a>` : id ? `<code>${esc(short(id))}</code>` : "already done");
      return `
        ${section("01", tr("Account"), "ready")}
        <h1>${tr("Account ready")}</h1>
        ${addressStrip(r.account, { box: true })}
        <p style="margin-top:12px">${r.uploadTx && r.uploadTx === r.registerTx ? tr("Contract installed and key registered in one transaction, {tx}.", { tx: link(r.uploadTx) }) : tr("Contract installed {tx1}, key registered {tx2}.", { tx1: link(r.uploadTx), tx2: link(r.registerTx) })} ${tr("From now on only this wallet's post-quantum key can move this account.")}</p>
        <div class="row">${button(tr("Go to the account"), { action: "setup-done", variant: "primary" })}</div>`;
    }
    if (st.running) {
      return `
        ${section("01", tr("Account"), "activating")}
        <h1>${tr("Activating your account")}</h1>
        ${addressStrip(st.account, { box: true })}
        ${notice("busy", `${esc(st.status?.message ?? tr("Starting"))}${st.status?.txId ? ` <code>${esc(short(st.status.txId))}</code>` : ""}`)}
        <p class="fine">${tr("One transaction, waiting for its block; usually under a minute. Keep this page open.")}${this.network.autoBlocks ? "" : " " + tr("On the devnet, produce blocks with devnet/produce-block.mjs.")}</p>`;
    }
    const need = this.needed(st);
    const funded = need !== null && st.mana !== null && st.mana >= need;
    return `
      ${section("01", tr("Account"), "activate")}
      <h1>${tr("Activate your account")}</h1>
      <p>${tr("This is your account's address on <strong>{net}</strong>. Send at least <strong class=\"mono\">{need} {unit}</strong> to it.", { net: esc(this.network.name), need: need === null ? "…" : esc(formatKoin(need, 2)), unit: esc(unit) })}</p>
      ${card(`
        <canvas id="qr-setup" class="qr" width="180" height="180" aria-label="QR code of your account's address"></canvas>
        ${addressStrip(st.account, { box: true })}
        <div class="row tight">${button(tr("Copy address"), { action: "copy", data: { copy: st.account } })}</div>`, `style="text-align:center"`)}
      <p id="setup-mana" class="${funded ? "note ok" : "mute"}" style="margin-top:12px">${need !== null ? esc(this.manaLine(st.mana, need)) : tr("Pricing the activation from the node…")}</p>
      ${st.failed ? `${notice("danger", tr("Activation stopped: {why}", { why: esc(st.failed) }))}<div class="row tight">${button(tr("Try again"), { action: "setup-retry", variant: "primary" })}</div>` : ""}
      <p class="fine" style="margin-top:12px">${tr("As soon as it holds enough, the wallet activates it by itself: it installs the post-quantum check on the account and registers your key, together in one transaction signed here. From then on only your 24 words can move the account. The {unit} stays yours; activation is paid with the account's mana, which refills over five days. Keep this page open until it says the account is ready.", { unit: esc(unit) })}</p>
      <div class="row">${button(tr("Settings"), { action: "setup-cancel", variant: "ghost" })}</div>`;
  }

  private vSendConfirm() {
    const sc = this.s.sendCheck;
    if (!sc) return `<p>${tr("Nothing to confirm.")}</p>`;
    const look = sc.assessment.kind === "lookalike";
    const m = sc.assessment.match;
    const unit = sc.token.symbol;
    return `
      ${section("01", tr("Send"), look ? tr("stop") : tr("first time"))}
      <h1>${look ? tr("Stop: this address looks like one you use") : tr("First time sending here")}</h1>
      ${
        look && m
          ? notice("danger", `<p>${tr("<strong>Typed</strong>")}</p>${addressStrip(sc.to, { diffFrom: m.address })}
               <p style="margin-top:8px"><strong>${tr("Known: {name}", { name: esc(m.name || short(m.address)) })}</strong></p>${addressStrip(m.address)}
               <p style="margin-top:8px">${tr("It shares its first and last characters, which is how address-poisoning attacks work: the attacker hopes you copied theirs from your history by mistake.")}</p>`)
          : `${card(addressStrip(sc.to))}<p style="margin-top:12px">${tr("You have not sent to this address from this wallet before. Compare <em>every</em> character with the address the recipient gave you, not only the first and last few. Transfers cannot be undone.")}</p>`
      }
      <p class="mute" style="margin-top:8px">${sc.nft ? tr("Collectible <strong class=\"mono\">{unit} #{id}</strong>", { unit: esc(unit), id: esc(sc.nft.label) }) : tr("Amount <strong class=\"mono\">{amount} {unit}</strong>", { amount: esc(sc.amount), unit: esc(unit) })} ${tr("on {net}.", { net: esc(this.network.name) })}</p>
      <form data-form="send-confirm">
        ${
          look
            ? field(tr("If you are certain, type the last six characters of the address you want to pay"), input({ name: "tail", class: "mono", autocomplete: "off", required: true, autofocus: true, maxlength: 6, style: "max-width:9em" }))
            : `${check("checked", tr("I have compared the whole address"), false, "required")}
               ${field(tr("Save as a contact (optional)"), input({ name: "name", autocomplete: "off", placeholder: "name", maxlength: 40 }))}`
        }
        <div class="row">${button(look ? tr("Send anyway") : tr("Sign and send"), { variant: look ? "danger" : "primary" })}${button(tr("Back"), { action: "send-cancel", variant: "ghost" })}</div>
      </form>`;
  }

  private vContacts() {
    const items = this.s.book?.list() ?? [];
    return `
      ${section("04", tr("Settings"), "contacts")}
      <h1>${tr("Contacts")}</h1>
      <p class="mute">${tr("Addresses this wallet has sent to, with the names you gave them. Kept on this device only, separately for each wallet.")}</p>
      ${
        items.length
          ? list(
              items
                .map(
                  (c) =>
                    `<li><form data-form="contact-rename" class="grow"><input type="hidden" name="address" value="${esc(c.address)}">
                       ${addressStrip(c.address, { size: "sm" })}
                       <div class="withbtn" style="margin-top:6px">${input({ name: "name", class: "in", value: c.name, placeholder: "name", maxlength: 40 })}${button(tr("Save"), { mini: true })}${button(tr("Remove"), { action: "contact-remove", variant: "ghost", mini: true, data: { address: c.address } })}</div>
                       <span class="s">${c.sends === 1 ? tr("1 send") : tr("{n} sends", { n: c.sends })}${c.lastSentAt ? tr(", last {date}", { date: esc(c.lastSentAt.slice(0, 10)) }) : ""}</span></form></li>`,
                )
                .join(""),
            )
          : `<p class="mute">${tr("No contacts yet. The first successful send to an address adds it.")}</p>`
      }
      <div class="row">${button(tr("Back"), { action: "settings", variant: "ghost" })}</div>`;
  }

  private vDuress() {
    return `
      ${section("04", tr("Settings"), "duress")}
      <h1>${tr("Duress wallet")}</h1>
      <p>${tr("A second, separate wallet with its own 24 words and its own passphrase. If someone forces you to unlock, you type the duress passphrase and they see that wallet, with whatever small amount you keep in it. Nothing on this device shows that another wallet exists, and unlocking takes the same time either way.")}</p>
      <p>${tr("<strong>What it cannot do.</strong> Balances are public on the chain. Anyone who already knows your main address can look it up. The decoy protects you from someone who does not, and only if it looks lived-in: give it a little KOIN and use it now and then.")}</p>
      <p class="fine">${tr("Setting it up asks for your main passphrase (so only you can), and a new passphrase for the decoy. The decoy's 24 words are shown once; write them down if you want to recover it, otherwise just note that losing them loses only the decoy.")}</p>
      <div class="row">${button(tr("Create the duress wallet"), { action: "duress-create", variant: "primary" })}${button(tr("Back"), { action: "duress-cancel", variant: "ghost" })}</div>`;
  }

  private vDuressWords() {
    const w = (this.s.pendingDecoy ?? "").split(" ");
    return `
      ${section("04", tr("Settings"), "duress")}
      <h1>${tr("The duress wallet's 24 words")}</h1>
      ${card(words(w))}
      <form data-form="duress-save">
        ${field(tr("Duress passphrase ({n}+ characters, different from your main one)", { n: MIN_PASSPHRASE_LENGTH }), input({ name: "d1", type: "password", minlength: MIN_PASSPHRASE_LENGTH, required: true, autofocus: true, autocomplete: "new-password" }))}
        ${field(tr("Repeat it"), input({ name: "d2", type: "password", minlength: MIN_PASSPHRASE_LENGTH, required: true, autocomplete: "new-password" }))}
        ${field(tr("Your main passphrase (to confirm)"), input({ name: "main", type: "password", required: true, autocomplete: "off" }))}
        <p class="fine">${tr("After saving, the wallet locks. Unlock with your main passphrase as usual; the duress passphrase opens the decoy, where you can activate its account and fund it like any new wallet.")}</p>
        <div class="row">${button(tr("Save duress wallet"), { variant: "danger" })}${button(tr("Cancel"), { action: "duress-cancel", variant: "ghost" })}</div>
      </form>`;
  }

  private vBioEnable() {
    return `
      ${section("04", tr("Settings"), "biometrics")}
      <h1>${tr("Biometric unlock")}</h1>
      <p>${tr("Your passphrase, once, so this wallet's key can be wrapped under a key kept by the device and released by its fingerprint or face check.")}</p>
      <p class="fine">${tr("What is stored: the wrapped key, on this device only, never the passphrase or the 24 words. Biometrics open the wallet that turned them on last, whichever passphrase it has. Under pressure, turn them off or let the other wallet turn them on.")}</p>
      <form data-form="bio-enable">
        ${field(tr("Passphrase"), input({ name: "passphrase", type: "password", required: true, autofocus: true, autocomplete: "current-password" }))}
        <div class="row">${button(tr("Turn on"), { variant: "primary" })}${button(tr("Cancel"), { action: "bio-cancel", variant: "ghost" })}</div>
      </form>`;
  }

  private vSave() {
    const c = this.s.change;
    if (!c) return `<p>${tr("Nothing to save.")}</p>`;
    return `
      ${section("04", tr("Settings"), "confirm")}
      <h1>${esc(c.title)}</h1>
      <p>${esc(c.detail)}</p>
      <form data-form="save">
        ${field(tr("Passphrase (to save the change)"), input({ name: "passphrase", type: "password", required: true, autofocus: true, autocomplete: "off" }))}
        <div class="row">${button(tr("Save"), { variant: "primary" })}${button(tr("Cancel"), { action: "change-cancel", variant: "ghost" })}</div>
      </form>`;
  }

  private vExport() {
    if (this.s.exportWords) {
      return `
        ${section("04", tr("Settings"), "backup")}
        <h1>${tr("Your 24 words")}</h1>
        ${card(words(this.s.exportWords.split(" ")))}
        <p class="fine" style="margin-top:12px">${tr("Seed (hex, for the command-line tool's key file):")}</p>
        <code class="address addr sm box">${esc(this.s.vault?.seedHex ?? "")}</code>
        <div class="row">${button(tr("Done"), { action: "settings", variant: "primary" })}</div>`;
    }
    return `
      ${section("04", tr("Settings"), "backup")}
      <h1>${tr("Show recovery words")}</h1>
      <form data-form="export">
        ${field(tr("Passphrase"), input({ name: "passphrase", type: "password", required: true, autofocus: true, autocomplete: "off" }))}
        <div class="row">${button(tr("Show"), { variant: "primary" })}${button(tr("Back"), { action: "settings", variant: "ghost" })}</div>
      </form>`;
  }
}
