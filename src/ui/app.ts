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
  Chain, NETWORKS, formatKoin, parseKoin, isAddress, short, type HistoryItem, type Network, deriveKeys, mnemonicToSeed, newMnemonic, parseSeedInput,
  seedToMnemonic, bytesToHex, hexToBytes, wipe, type PqKeys, bootstrapAddress, estimateSetupCosts, pqwalletInfo, setupPqwalletAccount,
  type SetupCosts, type SetupResult, type SetupStatus,
} from "koinos-pq-core";
import {
  decoySlotFor, decryptVault, encryptVault, localVaultStore, MIN_PASSPHRASE_LENGTH, newFile, openVault, roleOf, toFile, withSlot,
  type AccountRecord, type VaultData, type VaultFile,
} from "../core/vault";
import { canSign, detectAccount, displayLabel } from "../core/accounts";
import { AddressBook, addressBookNamespace, type Assessment } from "../core/addressbook";
import { CLIPBOARD_WIPE_SECONDS, copyWithWipe } from "../core/clipboard";
import {
  addressStrip, balance, button, card, check, esc, field, fmtAmount, header, hexStrip, input, linkButton, list, listRow, notice, section, shortAddr, stat, tabBar,
  ticker, tile, words, type Tab,
} from "./components";
import { isNative } from "./platform";

type Screen =
  | "welcome" | "create" | "confirm" | "passphrase" | "import" | "unlock" | "home" | "send" | "send-confirm" | "sent" | "receive" | "history"
  | "dapps" | "settings" | "export" | "setup" | "save" | "contacts" | "duress" | "duress-words";

/** Screens that live under the tab bar, and which tab they belong to. */
const TAB_OF: Partial<Record<Screen, string>> = {
  home: "account", send: "account", "send-confirm": "account", sent: "account", receive: "account", setup: "account",
  history: "activity",
  dapps: "dapps",
  settings: "settings", export: "settings", save: "settings", contacts: "settings", duress: "settings", "duress-words": "settings",
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
  assessment: Assessment;
}

type Theme = "system" | "light" | "dark";

interface State {
  screen: Screen;
  /** the stored file (all slots); null when no wallet is saved in this browser */
  file: VaultFile | null;
  /** which slot the current passphrase opened */
  slot: number;
  vault: VaultData | null;
  book: AddressBook | null;
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
  sent: { txId: string; bytes: number; rcUsed: string; block: string | null; waiting: boolean } | null;
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

export class App {
  private s: State;
  private root: HTMLElement;
  private lockTimer: number | undefined;
  private hideTimer: number | undefined;

  constructor(root: HTMLElement) {
    this.root = root;
    const stored = localVaultStore.load();
    const theme = (pref.get(PREF_THEME) ?? "system") as Theme;
    this.s = {
      screen: stored ? "unlock" : "welcome",
      file: null,
      slot: 0,
      vault: null,
      book: null,
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
      detected: {},
      change: null,
    };
    if (!NETWORKS[this.s.networkName]) this.s.networkName = "testnet";
    applyTheme(this.s.theme);
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
    if (this.s.keys) wipe(this.s.keys.secretKey, this.s.keys.seed);
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
      this.s.notice = `Balance unavailable from this ${this.network.name} node right now (${(balance.reason as Error).message?.slice(0, 120) ?? "error"}). Mana and head block are live.`;
    }
    if (mana.status === "rejected" && head.status === "rejected") throw new Error(`cannot reach the ${this.network.name} node: ${(head.reason as Error).message}`);
  }
  /** Home, or straight to activation when this network has no account for the wallet yet. */
  private async enterHome() {
    this.s.screen = "home";
    await this.refresh();
    if (!this.account() && this.network.name !== "devnet" && this.s.detected[this.network.name] !== undefined) this.startSetup();
  }
  private async finishSetup(passphrase: string) {
    const seed = this.s.pendingSeed;
    if (!seed) throw new Error("nothing to save");
    const vault: VaultData = { version: 1, seedHex: bytesToHex(seed), accounts: this.s.pendingAccounts, createdAt: new Date().toISOString(), role: "main" };
    const { file, slot } = await newFile(vault, passphrase);
    if (!localVaultStore.save(file)) throw new Error("this browser blocks local storage; the wallet cannot be saved here");
    this.s.file = file;
    this.s.slot = slot;
    this.s.vault = vault;
    this.s.keys = deriveKeys(seed);
    this.s.book = new AddressBook(addressBookNamespace(seed));
    // Wipe our buffer only if the keys hold their own copy (koinos-pq-core >= 2026-10-19). Before that fix the
    // keys shared it, and wiping zeroed keys.seed: every in-session wallet then derived the account address
    // of an all-zero seed and collided on 14PpxNmUVA7qeAw1cyASMfJFUd2xDkPUBR.
    if (this.s.keys.seed !== seed) wipe(seed);
    this.s.pendingSeed = null;
    this.s.pendingMnemonic = null;
    this.s.pendingAccounts = [];
    this.s.accountIndex = this.s.vault.accounts.length ? 1 : 0;
    this.s.notice = null;
    this.touch();
    await this.enterHome();
  }
  /** The passphrase must open the slot this session was unlocked from; anything else is "wrong". */
  private async reopenCurrent(passphrase: string): Promise<VaultData> {
    if (!this.s.file) throw new Error("no wallet");
    return decryptVault(this.s.file.slots[this.s.slot]!, passphrase);
  }
  private async saveChange(passphrase: string) {
    const change = this.s.change;
    if (!change || !this.s.file) throw new Error("nothing to save");
    const vault = await this.reopenCurrent(passphrase); // also checks the passphrase
    change.apply(vault);
    const file = withSlot(this.s.file, this.s.slot, await encryptVault(vault, passphrase));
    if (!localVaultStore.save(file)) throw new Error("could not write to local storage");
    this.s.file = file;
    this.s.vault = vault;
    this.s.change = null;
    this.s.screen = "settings";
    this.s.notice = "Saved.";
  }
  /**
   * Duress mode: writes a decoy wallet (its own seed, its own passphrase) into the slot decoySlotFor()
   * picks. The main passphrase is required so only the owner can do it; the decoy passphrase must open
   * nothing that exists. The session locks afterwards so the same thing happens whichever wallet did it.
   */
  private async saveDecoy(mainPass: string, decoyPass: string) {
    const file = this.s.file, words = this.s.pendingDecoy, vault = this.s.vault;
    if (!file || !words || !vault) throw new Error("nothing to save");
    const current = await this.reopenCurrent(mainPass);
    let taken = false;
    try {
      await openVault(file, decoyPass);
      taken = true;
    } catch {
      /* good: the decoy passphrase opens nothing yet */
    }
    if (taken) throw new Error("The duress passphrase must be different from any passphrase this wallet already uses.");
    const seed = mnemonicToSeed(words);
    const decoy: VaultData = { version: 1, seedHex: bytesToHex(seed), accounts: [], createdAt: new Date().toISOString(), role: "decoy" };
    wipe(seed);
    const target = decoySlotFor(this.s.slot, roleOf(current));
    let next = withSlot(file, target, await encryptVault(decoy, decoyPass));
    if (roleOf(current) === "main") {
      current.hasDecoy = true;
      next = withSlot(next, this.s.slot, await encryptVault(current, mainPass));
    }
    if (!localVaultStore.save(next)) throw new Error("could not write to local storage");
    this.lock("Duress wallet saved. Unlock with either passphrase: each opens its own wallet.");
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
        this.s.error = `Could not price the activation from the ${this.network.name} node: ${(e as Error).message}`;
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
    if (mana === null) return `Mana now: checking… (needs ${need})`;
    return `Mana now: ${formatKoin(mana, 2)} ${mana >= required ? "(enough, activating)" : `(needs ${need})`}`;
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
    if (!st || !this.s.keys) throw new Error("locked");
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

  /** Signs and submits a KOIN transfer from the current account, then remembers the recipient. */
  private async doSend(to: string, amount: string, name = "") {
    const a = this.account();
    if (!a || !this.s.keys || !canSign(a)) throw new Error("locked");
    const valueBase = parseKoin(amount);
    const chain = this.chain();
    const res = await chain.sendKoin({ from: a.address, to, valueBase, keys: this.s.keys, mode: a.mode as "native" | "pqwallet" });
    this.s.book?.recordSend(to, name);
    this.s.sendCheck = null;
    this.s.sent = { txId: res.txId, bytes: res.entryBytes, rcUsed: String(res.receipt.rc_used ?? "?"), block: null, waiting: this.network.autoBlocks };
    this.s.screen = "sent";
    this.render();
    if (this.network.autoBlocks) {
      try {
        const block = await chain.waitMined(res.txId);
        this.s.sent = { ...this.s.sent, block, waiting: false };
      } catch (err) {
        this.s.sent = { ...this.s.sent, waiting: false };
        this.s.error = `Sent, but still waiting for a block: ${(err as Error).message}`;
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
        this.s.error = "Wait until the activation has finished before switching network.";
        this.render();
        return;
      }
      this.s.networkName = t.value;
      pref.set(PREF_NETWORK, t.value);
      this.endSetup();
      this.s.balance = this.s.mana = this.s.head = null;
      this.s.history = null;
      void this.run("Loading", () => this.enterHome());
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
  }

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const action = el.dataset.action!;
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
            this.s.notice = secs ? `Copied. The clipboard clears itself in ${secs} s.` : "Copied.";
            this.render();
            window.setTimeout(() => {
              this.s.notice = null;
              this.render();
            }, 2500);
          },
          () => {
            this.s.error = "Could not copy; select the text instead.";
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
          title: acct.mode === "watch" ? "Stop watching" : "Remove account",
          detail: `Remove ${acct.address} from this wallet's list. Nothing changes on chain, and you can add it back any time.`,
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
          this.s.notice = `Native address on ${this.network.name}: ${formatKoin(b)} ${this.unit()}.`;
        });
        break;
      case "delete-wallet": {
        const typed = window.prompt("This deletes the wallet from this device. Your 24 words are the only way back in.\nType DELETE to confirm.");
        if (typed === "DELETE") {
          localVaultStore.clear();
          this.lock("Wallet deleted from this device.");
        }
        break;
      }
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
          this.s.error = "One of the words does not match. Check your note and try again.";
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
            if (!isAddress(pq)) throw new Error("the account address is not a valid Koinos address");
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
          this.s.error = `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
          this.render();
          return;
        }
        if (p1 !== p2) {
          this.s.error = "The two passphrases differ.";
          this.render();
          return;
        }
        void this.run("Encrypting", () => this.finishSetup(p1));
        break;
      }
      case "unlock": {
        void this.run("Unlocking", async () => {
          const stored = localVaultStore.load();
          if (!stored) throw new Error("no wallet in this browser");
          const file = await toFile(stored);
          const opened = await openVault(file, field("passphrase"));
          if (!("slots" in stored)) localVaultStore.save(file); // a pre-duress wallet: store it in the slot format from now on
          this.s.file = file;
          this.s.slot = opened.slot;
          this.s.vault = opened.data;
          const seed = hexToBytes(opened.data.seedHex);
          this.s.keys = deriveKeys(seed);
          this.s.book = new AddressBook(addressBookNamespace(seed));
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
        const a = this.account();
        if (!a || !canSign(a)) {
          this.s.error = "This account is watch-only; it has no key here.";
          this.render();
          return;
        }
        try {
          parseKoin(amount);
        } catch (err) {
          this.s.error = (err as Error).message;
          this.render();
          return;
        }
        const assessment = this.s.book?.assess(to, this.ownAddresses()) ?? { kind: "new" as const };
        if (assessment.kind === "invalid") {
          this.s.error = "That is not a valid Koinos address (check every character; the checksum does not match).";
          this.render();
          return;
        }
        if (assessment.kind === "known" || assessment.kind === "own") {
          void this.run("Signing and sending", () => this.doSend(to, amount));
          return;
        }
        this.s.sendCheck = { to, amount, assessment };
        this.go("send-confirm");
        break;
      }
      case "send-confirm": {
        const sc = this.s.sendCheck;
        if (!sc) return;
        if (sc.assessment.kind === "lookalike") {
          const typed = field("tail").trim();
          if (typed !== sc.to.slice(-6)) {
            this.s.error = "The last six characters you typed do not match the address.";
            this.render();
            return;
          }
        } else if (!data.get("checked")) {
          this.s.error = "Tick the box once you have compared the whole address.";
          this.render();
          return;
        }
        const name = field("name").trim();
        void this.run("Signing and sending", () => this.doSend(sc.to, sc.amount, name));
        break;
      }
      case "contact-rename": {
        const addr = field("address"), name = field("name");
        if (this.s.book && addr) this.s.book.upsert(addr, name);
        this.s.notice = "Saved.";
        this.render();
        break;
      }
      case "watch": {
        const addr = field("address").trim();
        if (!isAddress(addr)) {
          this.s.error = "That is not a valid Koinos address.";
          this.render();
          return;
        }
        const label = field("label").trim().slice(0, 60) || "Watched address";
        this.s.change = {
          title: "Watch an address",
          detail: `Show ${addr} (${label}) in this wallet: balance, mana and history only. This wallet holds no key for it and cannot spend from it.`,
          apply: (v) => {
            if (!v.accounts.some((x) => x.address === addr)) v.accounts.push({ label, mode: "watch", address: addr });
          },
        };
        this.go("save");
        break;
      }
      case "duress-save": {
        const d1 = field("d1"), d2 = field("d2");
        if (d1.length < MIN_PASSPHRASE_LENGTH) {
          this.s.error = `Use at least ${MIN_PASSPHRASE_LENGTH} characters for the duress passphrase.`;
          this.render();
          return;
        }
        if (d1 !== d2) {
          this.s.error = "The two duress passphrases differ.";
          this.render();
          return;
        }
        void this.run("Saving the duress wallet", () => this.saveDecoy(field("main"), d1));
        break;
      }
      case "add-account": {
        const addr = field("address").trim();
        if (!isAddress(addr)) {
          this.s.error = "That is not a valid Koinos address.";
          this.render();
          return;
        }
        const label = field("label").trim().slice(0, 60) || "Post-quantum account";
        this.s.change = {
          title: "Add account",
          detail: `Add ${addr} (${label}) to this wallet. It only works if that account's contract has this wallet's key registered.`,
          apply: (v) => {
            if (!v.accounts.some((x) => x.address === addr)) v.accounts.push({ label, mode: "pqwallet", address: addr });
          },
        };
        this.go("save");
        break;
      }
      case "save":
        void this.run("Saving", () => this.saveChange(field("passphrase")));
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
        this.s.notice = `Auto-lock after ${m} minutes${this.s.lockOnHide ? `, and ${HIDDEN_LOCK_SECONDS} s after the tab is hidden` : ""}. Clipboard wipe ${this.s.clipboardWipe ? "on" : "off"}.`;
        this.render();
        break;
      }
      case "devnet-rpc": {
        pref.set(PREF_DEVNET_RPC, field("rpc").trim() || "http://127.0.0.1:8080/");
        this.s.notice = "Devnet RPC saved.";
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
      { id: "account", label: "Account", action: "back-home" },
      { id: "activity", label: "Activity", action: "history" },
    ];
    if (isNative()) t.push({ id: "dapps", label: "Dapps", action: "tab-dapps" });
    t.push({ id: "settings", label: "Settings", action: "settings" });
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
        ${header(inApp ? button("Lock", { action: "lock", variant: "ghost", mini: true }) : s.keys ? "" : `<span class="hexstrip">ML-DSA-44</span>`)}
        ${inApp ? ticker(this.network.name, s.head, this.network.autoBlocks) : ""}
        <div class="content ${inApp ? "" : "plain"}">
          ${notes}
          ${body}
          ${inApp ? "" : `<p class="foot">Koinos PQ Wallet · open source, MIT · a test build, not audited</p>`}
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
  }

  private vWelcome() {
    return `
      <h1 class="wide" style="margin-top:24px">A wallet that a quantum computer cannot pick</h1>
      <p>Your account is controlled by an <strong>ML-DSA-44</strong> key (the NIST post-quantum standard, FIPS 204) instead of secp256k1. The key lives only on this device, encrypted with a passphrase you choose, and is backed up by 24 words.</p>
      <div class="row">${button("Create a new wallet", { action: "create", variant: "primary" })}${button("Import 24 words", { action: "import" })}</div>
      <p class="fine" style="margin-top:16px">After you create it, send some KOIN to your new account and the wallet activates it by itself. This is a test build: use small amounts.</p>`;
  }

  private vCreate() {
    const w = this.s.pendingMnemonic!.split(" ");
    return `
      <h1>Write these 24 words down</h1>
      <p>On paper, in order. They are the only way to recover the wallet. Anyone who has them has your funds. Do not screenshot them.</p>
      ${card(words(w))}
      <div class="row">${button("I have written them down", { action: "wrote-down", variant: "primary" })}${button("Cancel", { action: "welcome", variant: "ghost" })}</div>`;
  }

  private vConfirm() {
    return `
      <h1>Check your note</h1>
      <form data-form="confirm">
        ${this.s.confirmIdx.map((i, k) => field(`Word number ${i + 1}`, input({ name: `w${k}`, class: "mono", autocomplete: "off", autocapitalize: "none", spellcheck: "false", required: true, autofocus: k === 0 }))).join("")}
        <div class="row">${button("Continue", { variant: "primary" })}${button("Show the words again", { action: "show-words", variant: "ghost" })}</div>
      </form>`;
  }

  private vPassphrase() {
    return `
      <h1>Choose a passphrase</h1>
      <p>It encrypts the wallet on this device. It does not replace the 24 words: if you forget it, import the words again.</p>
      <form data-form="passphrase">
        ${field(`Passphrase (${MIN_PASSPHRASE_LENGTH}+ characters)`, input({ name: "p1", type: "password", minlength: MIN_PASSPHRASE_LENGTH, required: true, autofocus: true, autocomplete: "new-password" }))}
        ${field("Repeat it", input({ name: "p2", type: "password", minlength: MIN_PASSPHRASE_LENGTH, required: true, autocomplete: "new-password" }))}
        <div class="row">${button("Create wallet", { variant: "primary" })}${button("Cancel", { action: "welcome", variant: "ghost" })}</div>
      </form>`;
  }

  private vImport() {
    return `
      <h1>Import</h1>
      <form data-form="import">
        ${field("Your 24 words", `<textarea name="seed" rows="4" autocomplete="off" autocapitalize="none" spellcheck="false" required autofocus></textarea>`)}
        <p class="fine">An account this wallet activated is found again automatically.</p>
        <details class="adv"><summary>Advanced</summary>
          ${field("The 64-character seed from the koinos-pq command-line tool also works in the box above. For an account set up with that tool, give its address:", input({ name: "pqwallet", class: "mono", autocomplete: "off", placeholder: "1…" }))}
        </details>
        <div class="row">${button("Continue", { variant: "primary" })}${button("Cancel", { action: "welcome", variant: "ghost" })}</div>
      </form>`;
  }

  private vUnlock() {
    return `
      <h1 class="wide" style="margin-top:40px">Unlock</h1>
      <form data-form="unlock">
        ${field("Passphrase", input({ name: "passphrase", type: "password", required: true, autofocus: true, autocomplete: "current-password" }))}
        <div class="row">${button("Unlock", { variant: "primary", block: true })}</div>
      </form>
      <p class="fine" style="margin-top:24px">Lost the passphrase? ${linkButton("Delete this wallet", "delete-wallet")} and import your 24 words again.</p>`;
  }

  private accountPicker() {
    const items = this.visibleAccounts();
    const cur = this.account();
    if (items.length <= 1) return "";
    return `<ul class="accts">${items
      .map(
        (a) =>
          `<li><label><input type="radio" name="account" value="${a.index}" ${cur && a.index === cur.index ? "checked" : ""}><span class="grow">${esc(a.label)} <span class="s mono">${esc(shortAddr(a.address))}</span>${a.mode === "native" ? ` <span class="s">native</span>` : a.mode === "watch" ? ` <span class="s">watch-only</span>` : ""}</span></label></li>`,
      )
      .join("")}</ul>`;
  }

  private vHome() {
    const a = this.account();
    const s = this.s;
    if (!a) {
      return `
        ${section("01", "Account")}
        <h1>Activate your account</h1>
        <p>Your wallet has its post-quantum key. To use it on <strong>${esc(this.network.name)}</strong>, send some ${esc(this.unit())} to your account's address and the wallet activates it.</p>
        <div class="row">${button("Show my account's address", { action: "setup", variant: "primary" })}${button("Settings", { action: "settings" })}</div>`;
    }
    const unit = this.unit();
    const sig = a.mode === "native" ? "ML-DSA-44 · 3,733 B" : "ML-DSA-44 · 2,420 B";
    return `
      ${section("01", "Account", hexStrip(a.address))}
      ${this.accountPicker()}
      ${card(`
        <span class="lbl">${esc(a.label)} · ${esc(this.network.name)}</span>
        ${addressStrip(a.address)}
        <div class="row tight">${button("Copy", { action: "copy", mini: true, data: { copy: a.address } })}${button("Refresh", { action: "refresh", variant: "ghost", mini: true })}</div>
        <div style="margin-top:20px">${balance(s.balance === null ? null : fmtAmount(formatKoin(s.balance)), unit)}</div>
        <div style="margin-top:12px">
          ${stat("Mana", s.mana === null ? "…" : esc(fmtAmount(formatKoin(s.mana, 2))))}
          ${stat("Signature", canSign(a) ? esc(sig) : "none here (watch-only)")}
        </div>
        <div class="actions">
          ${canSign(a) ? button("Send", { action: "send", variant: "primary" }) : button("Watch-only", { type: "button", disabled: true, title: "Watch-only: this wallet has no key for this address" })}
          ${button("Receive", { action: "receive" })}
        </div>`)}
      ${section("02", "Tokens")}
      ${list(`<li data-token="koin">${tile(unit)}<span class="grow"><span class="t">${esc(unit === "tKOIN" ? "Test Koin" : "Koin")}</span><br><span class="s">${esc(unit)}</span></span><span class="amt">${s.balance === null ? "…" : esc(fmtAmount(formatKoin(s.balance)))}</span></li>`)}`;
  }

  private vSend() {
    const a = this.account();
    const unit = this.unit();
    return `
      ${section("01", "Send", `from <span class="mono">${esc(shortAddr(a?.address))}</span>`)}
      <h1>Send KOIN</h1>
      <form data-form="send">
        ${field("To", input({ name: "to", class: "mono", autocomplete: "off", required: true, placeholder: "1…", autofocus: true, list: "contacts" }))}
        <datalist id="contacts">${(this.s.book?.list() ?? []).map((c) => `<option value="${esc(c.address)}">${esc(c.name || short(c.address))}</option>`).join("")}</datalist>
        ${field(`Amount (${unit})`, input({ name: "amount", class: "mono", inputmode: "decimal", autocomplete: "off", required: true, placeholder: "0.5" }))}
        <p class="fine">From ${esc(a?.label ?? "")} on ${esc(this.network.name)}, signed here with ML-DSA-44 (${a?.mode === "native" ? "3,733-byte native entry" : "2,420-byte signature"}). A first-time or look-alike recipient asks you to confirm it before anything is signed.</p>
        <div class="row">${button("Sign and send", { variant: "primary" })}${button("Back", { action: "back-home", variant: "ghost" })}</div>
      </form>`;
  }

  private vSent() {
    const t = this.s.sent!;
    const link = this.network.explorerTx?.(t.txId);
    return `
      ${section("01", "Send", t.waiting ? "waiting" : t.block ? "mined" : "submitted")}
      <h1>${t.waiting ? "Sent, waiting for a block" : t.block ? "Mined" : "Submitted"}</h1>
      ${card(`<span class="lbl">Transaction</span><code class="address addr sm box" style="color:var(--ink)">${esc(t.txId)}</code>
        <div style="margin-top:12px">${stat("Signature entry", `${esc(t.bytes)} B`)}${stat("Mana used", esc(t.rcUsed))}${t.block ? stat("Block", esc(fmtAmount(t.block))) : ""}</div>`)}
      ${this.network.autoBlocks ? "" : `<p class="fine" style="margin-top:12px">This network only makes blocks when the devnet script produces one.</p>`}
      ${link ? `<p style="margin-top:12px"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open in explorer</a></p>` : ""}
      <div class="row">${button("Done", { action: "back-home", variant: "primary" })}</div>`;
  }

  private vReceive() {
    const a = this.account();
    return `
      ${section("01", "Receive", esc(a?.label ?? ""))}
      ${card(`
        <canvas id="qr" class="qr" width="220" height="220" aria-label="QR code of the address"></canvas>
        ${addressStrip(a?.address ?? "", { box: true })}
        <div class="row">${button("Copy address", { action: "copy", variant: "primary", data: { copy: a?.address ?? "" } })}${button("Back", { action: "back-home", variant: "ghost" })}</div>
        ${this.s.clipboardWipe ? `<p class="fine" style="margin-top:12px">The clipboard clears itself ${CLIPBOARD_WIPE_SECONDS} s after copying.</p>` : ""}`, `style="text-align:center"`)}`;
  }

  private vActivity() {
    const a = this.account();
    const h = this.s.history ?? [];
    const rows = h
      .map((i) => {
        const m = /^(received|sent) (\S+) (from|to) (.+?)( \(reverted\))?$/.exec(i.summary);
        const main = m
          ? `<span class="t">${esc(m[1] === "sent" ? "Sent" : "Received")} ${esc(fmtAmount(m[2]!))} ${esc(this.unit())}</span> <span class="s">${esc(m[3])} ${esc(m[4])}${m[5] ? " (reverted)" : ""}</span>`
          : `<span class="t">${esc(i.summary)}</span>`;
        const meta = [i.txId ? esc(short(i.txId)) : "", i.blockHeight ? `block ${esc(fmtAmount(i.blockHeight))}` : ""].filter(Boolean).join(" · ");
        const amt = m ? `<span class="amt">${m[1] === "sent" ? "−" : "+"}${esc(fmtAmount(m[2]!))}</span>` : "";
        return listRow(`${main}<br><span class="s mono">${meta}</span>`, amt);
      })
      .join("");
    return `
      ${section("02", "Activity", `<span class="mono">${esc(shortAddr(a?.address))}</span>`)}
      ${!a ? `<p class="mute">No account on ${esc(this.network.name)} yet.</p>` : h.length ? list(rows) : `<p class="mute">Nothing yet.</p>`}
      <div class="row tight">${button("Refresh", { action: "history", variant: "ghost", mini: true })}</div>`;
  }

  private vDapps() {
    return `
      ${section("03", "Dapps")}
      <p class="mute">The in-app dapp browser arrives in a later build. Until then, Koinos sites work with the browser extension on a computer, through the same window.kondor interface.</p>`;
  }

  private vSettings() {
    const net = this.network.name;
    const items = this.accounts().filter((a) => a.mode === "pqwallet" || a.mode === "watch");
    const hasHere = this.visibleAccounts().some((a) => a.mode === "pqwallet");
    const sel = (name: string, options: Array<[string, string]>, current: string) =>
      `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    return `
      ${section("04", "Settings", esc(__APP_VERSION__))}
      <h1>Settings</h1>
      ${section(null, "Accounts")}
      ${
        items.length
          ? list(items.map((a) => listRow(`<span class="t">${esc(a.label)}</span>${a.mode === "watch" ? ` <span class="s">watch-only</span>` : ""}<br><span class="s mono">${esc(a.address)}</span>`, a.derived ? `<span class="s">found from your 24 words</span>` : linkButton("remove", "remove-account", { index: a.index }))).join(""))
          : `<p class="mute">No account on ${esc(net)} yet.</p>`
      }
      ${hasHere ? "" : `<div class="row tight">${button(`Activate your account on ${esc(net)}`, { action: "setup", variant: "primary" })}</div>`}
      <form data-form="watch" class="field inline">
        <label><span>Watch an address</span>${input({ name: "address", class: "mono", placeholder: "1…", autocomplete: "off", required: true })}</label>
        <label><span>Label</span>${input({ name: "label", placeholder: "optional", autocomplete: "off" })}</label>
        ${button("Watch")}
      </form>
      <p class="fine">See the balance, mana and activity of any address (your cold account, a friend's). No key, no sending.</p>

      ${section(null, "Security")}
      <form data-form="autolock">
        ${check("lockOnHide", `Lock ${HIDDEN_LOCK_SECONDS} s after this tab is hidden or the screen goes off`, this.s.lockOnHide)}
        ${check("clipboardWipe", `Clear the clipboard ${CLIPBOARD_WIPE_SECONDS} s after copying an address`, this.s.clipboardWipe)}
        ${field("Auto-lock after minutes without activity", input({ name: "minutes", class: "mono", type: "number", min: 1, max: 120, value: this.s.autolockMinutes, style: "max-width:7em" }))}
        <div class="row tight">${button("Save")}</div>
      </form>

      ${section(null, "Backup")}
      <p class="mute">Show the 24 words again (asks for the passphrase).</p>
      <div class="row tight">${button("Show recovery words", { action: "export" })}</div>

      ${section(null, "Contacts", `${this.s.book?.list().length ?? 0} saved`)}
      <p class="mute">Sending to an address you have never used, or one that merely resembles one you have, asks you to check it first.</p>
      <div class="row tight">${button("Open contacts", { action: "contacts" })}</div>

      ${section(null, "Duress wallet", this.s.vault?.hasDecoy ? "set up" : "not set up")}
      <p class="mute">${this.s.vault?.hasDecoy ? "Set up. A second passphrase opens a separate, small wallet." : "Not set up. A second passphrase would open a separate, small wallet to show under pressure."}</p>
      <div class="row tight">${button(this.s.vault?.hasDecoy ? "Replace the duress wallet" : "Set up a duress wallet", { action: "duress" })}</div>

      ${section(null, "Network")}
      ${field("Node", sel("network", Object.keys(NETWORKS).map((n) => [n, n === "testnet" ? "testnet (Harbinger)" : n]), this.s.networkName))}
      ${net === "devnet" ? `<form data-form="devnet-rpc" class="field inline"><label><span>Devnet RPC</span>${input({ name: "rpc", class: "mono", value: pref.get(PREF_DEVNET_RPC) ?? "http://127.0.0.1:8080/" })}</label>${button("Save")}</form>` : ""}

      ${section(null, "Appearance")}
      ${field("Theme", sel("theme", [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]], this.s.theme))}

      ${section(null, "About")}
      <p class="mute">Koinos PQ Wallet ${esc(__APP_VERSION__)}. Open source, MIT. Accounts are controlled by an ML-DSA-44 key (FIPS 204). Keys never leave this device. A test build, not audited.</p>

      <details class="adv"><summary>Advanced</summary>
        ${section(null, "Add an account by address")}
        <p class="fine">Only for an account set up with the koinos-pq command-line tool. Accounts this wallet activates are found automatically.</p>
        <form data-form="add-account" class="field inline">
          <label><span>Address</span>${input({ name: "address", class: "mono", placeholder: "1…", autocomplete: "off", required: true })}</label>
          <label><span>Label</span>${input({ name: "label", placeholder: "optional", autocomplete: "off" })}</label>
          ${button("Add")}
        </form>
        ${section(null, "Native post-quantum address")}
        <p class="fine">The address of the key itself. It needs nodes that verify ML-DSA-44 directly, a proposed node change that runs on the devnet only. On mainnet and Harbinger it can receive but cannot spend, so do not send to it.</p>
        ${addressStrip(this.s.keys?.address ?? "", { size: "sm", box: true })}
        <div class="row tight">${button(`Check its balance on ${esc(net)}`, { action: "native-balance", mini: true })}</div>
      </details>

      ${section(null, "Danger")}
      <div class="row tight">${button("Delete wallet from this device", { action: "delete-wallet", variant: "danger" })}</div>`;
  }

  private vSetup() {
    const st = this.s.setup;
    if (!st) return `<p>Nothing to activate.</p>`;
    const unit = this.unit();
    if (st.result) {
      const r = st.result;
      const link = (id: string | null) => (id && this.network.explorerTx ? `<a href="${esc(this.network.explorerTx(id))}" target="_blank" rel="noopener noreferrer">${esc(short(id))}</a>` : id ? `<code>${esc(short(id))}</code>` : "already done");
      return `
        ${section("01", "Account", "ready")}
        <h1>Account ready</h1>
        ${addressStrip(r.account, { box: true })}
        <p style="margin-top:12px">${r.uploadTx && r.uploadTx === r.registerTx ? `Contract installed and key registered in one transaction, ${link(r.uploadTx)}.` : `Contract installed ${link(r.uploadTx)}, key registered ${link(r.registerTx)}.`} From now on only this wallet's post-quantum key can move this account.</p>
        <div class="row">${button("Go to the account", { action: "setup-done", variant: "primary" })}</div>`;
    }
    if (st.running) {
      return `
        ${section("01", "Account", "activating")}
        <h1>Activating your account</h1>
        ${addressStrip(st.account, { box: true })}
        ${notice("busy", `${esc(st.status?.message ?? "Starting")}${st.status?.txId ? ` <code>${esc(short(st.status.txId))}</code>` : ""}`)}
        <p class="fine">One transaction, waiting for its block; usually under a minute. Keep this page open.${this.network.autoBlocks ? "" : " On the devnet, produce blocks with devnet/produce-block.mjs."}</p>`;
    }
    const need = this.needed(st);
    const funded = need !== null && st.mana !== null && st.mana >= need;
    return `
      ${section("01", "Account", "activate")}
      <h1>Activate your account</h1>
      <p>This is your account's address on <strong>${esc(this.network.name)}</strong>. Send at least <strong class="mono">${need === null ? "…" : esc(formatKoin(need, 2))} ${esc(unit)}</strong> to it.</p>
      ${card(`
        <canvas id="qr-setup" class="qr" width="180" height="180" aria-label="QR code of your account's address"></canvas>
        ${addressStrip(st.account, { box: true })}
        <div class="row tight">${button("Copy address", { action: "copy", data: { copy: st.account } })}</div>`, `style="text-align:center"`)}
      <p id="setup-mana" class="${funded ? "note ok" : "mute"}" style="margin-top:12px">${need !== null ? esc(this.manaLine(st.mana, need)) : "Pricing the activation from the node…"}</p>
      ${st.failed ? `${notice("danger", `Activation stopped: ${esc(st.failed)}`)}<div class="row tight">${button("Try again", { action: "setup-retry", variant: "primary" })}</div>` : ""}
      <p class="fine" style="margin-top:12px">As soon as it holds enough, the wallet activates it by itself: it installs the post-quantum check on the account and registers your key, together in one transaction signed here. From then on only your 24 words can move the account. The ${esc(unit)} stays yours; activation is paid with the account's mana, which refills over five days. Keep this page open until it says the account is ready.</p>
      <div class="row">${button("Settings", { action: "setup-cancel", variant: "ghost" })}</div>`;
  }

  private vSendConfirm() {
    const sc = this.s.sendCheck;
    if (!sc) return `<p>Nothing to confirm.</p>`;
    const look = sc.assessment.kind === "lookalike";
    const m = sc.assessment.match;
    const unit = this.unit();
    return `
      ${section("01", "Send", look ? "stop" : "first time")}
      <h1>${look ? "Stop: this address looks like one you use" : "First time sending here"}</h1>
      ${
        look && m
          ? notice("danger", `<p><strong>Typed</strong></p>${addressStrip(sc.to, { diffFrom: m.address })}
               <p style="margin-top:8px"><strong>Known: ${esc(m.name || short(m.address))}</strong></p>${addressStrip(m.address)}
               <p style="margin-top:8px">It shares its first and last characters, which is how address-poisoning attacks work: the attacker hopes you copied theirs from your history by mistake.</p>`)
          : `${card(addressStrip(sc.to))}<p style="margin-top:12px">You have not sent to this address from this wallet before. Compare <em>every</em> character with the address the recipient gave you, not only the first and last few. Transfers cannot be undone.</p>`
      }
      <p class="mute" style="margin-top:8px">Amount <strong class="mono">${esc(sc.amount)} ${esc(unit)}</strong> on ${esc(this.network.name)}.</p>
      <form data-form="send-confirm">
        ${
          look
            ? field("If you are certain, type the last six characters of the address you want to pay", input({ name: "tail", class: "mono", autocomplete: "off", required: true, autofocus: true, maxlength: 6, style: "max-width:9em" }))
            : `${check("checked", "I have compared the whole address", false, "required")}
               ${field("Save as a contact (optional)", input({ name: "name", autocomplete: "off", placeholder: "name", maxlength: 40 }))}`
        }
        <div class="row">${button(look ? "Send anyway" : "Sign and send", { variant: look ? "danger" : "primary" })}${button("Back", { action: "send-cancel", variant: "ghost" })}</div>
      </form>`;
  }

  private vContacts() {
    const items = this.s.book?.list() ?? [];
    return `
      ${section("04", "Settings", "contacts")}
      <h1>Contacts</h1>
      <p class="mute">Addresses this wallet has sent to, with the names you gave them. Kept on this device only, separately for each wallet.</p>
      ${
        items.length
          ? list(
              items
                .map(
                  (c) =>
                    `<li><form data-form="contact-rename" class="grow"><input type="hidden" name="address" value="${esc(c.address)}">
                       ${addressStrip(c.address, { size: "sm" })}
                       <div class="withbtn" style="margin-top:6px">${input({ name: "name", class: "in", value: c.name, placeholder: "name", maxlength: 40 })}${button("Save", { mini: true })}${button("Remove", { action: "contact-remove", variant: "ghost", mini: true, data: { address: c.address } })}</div>
                       <span class="s">${c.sends} send${c.sends === 1 ? "" : "s"}${c.lastSentAt ? `, last ${esc(c.lastSentAt.slice(0, 10))}` : ""}</span></form></li>`,
                )
                .join(""),
            )
          : `<p class="mute">No contacts yet. The first successful send to an address adds it.</p>`
      }
      <div class="row">${button("Back", { action: "settings", variant: "ghost" })}</div>`;
  }

  private vDuress() {
    return `
      ${section("04", "Settings", "duress")}
      <h1>Duress wallet</h1>
      <p>A second, separate wallet with its own 24 words and its own passphrase. If someone forces you to unlock, you type the duress passphrase and they see that wallet, with whatever small amount you keep in it. Nothing on this device shows that another wallet exists, and unlocking takes the same time either way.</p>
      <p><strong>What it cannot do.</strong> Balances are public on the chain. Anyone who already knows your main address can look it up. The decoy protects you from someone who does not, and only if it looks lived-in: give it a little KOIN and use it now and then.</p>
      <p class="fine">Setting it up asks for your main passphrase (so only you can), and a new passphrase for the decoy. The decoy's 24 words are shown once; write them down if you want to recover it, otherwise just note that losing them loses only the decoy.</p>
      <div class="row">${button("Create the duress wallet", { action: "duress-create", variant: "primary" })}${button("Back", { action: "duress-cancel", variant: "ghost" })}</div>`;
  }

  private vDuressWords() {
    const w = (this.s.pendingDecoy ?? "").split(" ");
    return `
      ${section("04", "Settings", "duress")}
      <h1>The duress wallet's 24 words</h1>
      ${card(words(w))}
      <form data-form="duress-save">
        ${field(`Duress passphrase (${MIN_PASSPHRASE_LENGTH}+ characters, different from your main one)`, input({ name: "d1", type: "password", minlength: MIN_PASSPHRASE_LENGTH, required: true, autofocus: true, autocomplete: "new-password" }))}
        ${field("Repeat it", input({ name: "d2", type: "password", minlength: MIN_PASSPHRASE_LENGTH, required: true, autocomplete: "new-password" }))}
        ${field("Your main passphrase (to confirm)", input({ name: "main", type: "password", required: true, autocomplete: "off" }))}
        <p class="fine">After saving, the wallet locks. Unlock with your main passphrase as usual; the duress passphrase opens the decoy, where you can activate its account and fund it like any new wallet.</p>
        <div class="row">${button("Save duress wallet", { variant: "danger" })}${button("Cancel", { action: "duress-cancel", variant: "ghost" })}</div>
      </form>`;
  }

  private vSave() {
    const c = this.s.change;
    if (!c) return `<p>Nothing to save.</p>`;
    return `
      ${section("04", "Settings", "confirm")}
      <h1>${esc(c.title)}</h1>
      <p>${esc(c.detail)}</p>
      <form data-form="save">
        ${field("Passphrase (to save the change)", input({ name: "passphrase", type: "password", required: true, autofocus: true, autocomplete: "off" }))}
        <div class="row">${button("Save", { variant: "primary" })}${button("Cancel", { action: "change-cancel", variant: "ghost" })}</div>
      </form>`;
  }

  private vExport() {
    if (this.s.exportWords) {
      return `
        ${section("04", "Settings", "backup")}
        <h1>Your 24 words</h1>
        ${card(words(this.s.exportWords.split(" ")))}
        <p class="fine" style="margin-top:12px">Seed (hex, for the command-line tool's key file):</p>
        <code class="address addr sm box">${esc(this.s.vault?.seedHex ?? "")}</code>
        <div class="row">${button("Done", { action: "settings", variant: "primary" })}</div>`;
    }
    return `
      ${section("04", "Settings", "backup")}
      <h1>Show recovery words</h1>
      <form data-form="export">
        ${field("Passphrase", input({ name: "passphrase", type: "password", required: true, autofocus: true, autocomplete: "off" }))}
        <div class="row">${button("Show", { variant: "primary" })}${button("Back", { action: "settings", variant: "ghost" })}</div>
      </form>`;
  }
}
