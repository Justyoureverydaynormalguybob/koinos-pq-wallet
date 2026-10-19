// The whole UI: a small state machine rendering HTML strings into #app, no framework.
//
// Flow for a new user: create (24 words, check, passphrase) -> "Activate your account": one address
// to fund; once it holds enough, the wallet installs the post-quantum contract and registers the key
// by itself -> home. The account's address is derived from the seed, so importing the 24 words finds
// it again on any network with no extra input.
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

type Screen =
  | "welcome" | "create" | "confirm" | "passphrase" | "import" | "unlock" | "home" | "send" | "send-confirm" | "sent" | "receive" | "history"
  | "settings" | "export" | "setup" | "save" | "contacts" | "duress" | "duress-words";

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

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export class App {
  private s: State;
  private root: HTMLElement;
  private lockTimer: number | undefined;
  private hideTimer: number | undefined;

  constructor(root: HTMLElement) {
    this.root = root;
    const stored = localVaultStore.load();
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
      pendingDecoy: null,
      sendCheck: null,
      setup: null,
      detected: {},
      change: null,
    };
    if (!NETWORKS[this.s.networkName]) this.s.networkName = "testnet";
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
    wipe(seed);
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
        manaEl.className = funded ? "notice" : "muted";
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
        this.go("home");
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
        void this.run("Loading history", async () => {
          const a = this.account();
          if (!a) return;
          this.s.history = await this.chain().history(a.address);
          this.s.screen = "history";
        });
        break;
      case "settings":
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
          this.s.notice = `Native address on ${this.network.name}: ${formatKoin(b)} KOIN.`;
        });
        break;
      case "delete-wallet": {
        const typed = window.prompt("This deletes the wallet from this browser. Your 24 words are the only way back in.\nType DELETE to confirm.");
        if (typed === "DELETE") {
          localVaultStore.clear();
          this.lock("Wallet deleted from this browser.");
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
      history: () => this.vHistory(),
      settings: () => this.vSettings(),
      export: () => this.vExport(),
      setup: () => this.vSetup(),
      save: () => this.vSave(),
      contacts: () => this.vContacts(),
      duress: () => this.vDuress(),
      "duress-words": () => this.vDuressWords(),
    }[s.screen]();
    this.root.innerHTML = `
      <header class="top">
        <div class="brand"><span class="mark" aria-hidden="true">PQ</span>Koinos PQ Wallet <span class="tag">ML-DSA-44</span></div>
        ${s.keys ? `<div class="topright"><select name="network" aria-label="Network">${Object.keys(NETWORKS).map((n) => `<option value="${esc(n)}" ${n === s.networkName ? "selected" : ""}>${esc(n)}</option>`).join("")}</select><button class="ghost" data-action="lock">Lock</button></div>` : ""}
      </header>
      ${s.busy ? `<div class="busy" role="status">${esc(s.busy)}…</div>` : ""}
      ${s.error ? `<div class="error" role="alert">${esc(s.error)}</div>` : ""}
      ${s.notice ? `<div class="notice" role="status">${esc(s.notice)}</div>` : ""}
      <section class="card">${body}</section>
      <footer class="foot">Keys never leave this browser. A test build, not audited.</footer>`;
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
      <h1>A wallet that a quantum computer cannot pick</h1>
      <p>Your account is controlled by an <strong>ML-DSA-44</strong> key (the NIST post-quantum standard, FIPS 204) instead of secp256k1. The key lives only in this browser, encrypted with a passphrase you choose, and is backed up by 24 words.</p>
      <div class="row">
        <button class="primary" data-action="create">Create a new wallet</button>
        <button data-action="import">Import 24 words</button>
      </div>
      <p class="muted">After you create it, send some KOIN to your new account and the wallet activates it by itself. This is a test build: use small amounts.</p>`;
  }

  private vCreate() {
    const words = this.s.pendingMnemonic!.split(" ");
    return `
      <h1>Write these 24 words down</h1>
      <p>On paper, in order. They are the only way to recover the wallet. Anyone who has them has your funds. Do not screenshot them.</p>
      <ol class="words">${words.map((w) => `<li>${esc(w)}</li>`).join("")}</ol>
      <div class="row"><button class="primary" data-action="wrote-down">I have written them down</button><button class="ghost" data-action="welcome">Cancel</button></div>`;
  }

  private vConfirm() {
    return `
      <h1>Check your note</h1>
      <form data-form="confirm">
        ${this.s.confirmIdx.map((i, k) => `<label>Word number ${i + 1}<input name="w${k}" autocomplete="off" autocapitalize="none" spellcheck="false" required ${k === 0 ? "autofocus" : ""}></label>`).join("")}
        <div class="row"><button class="primary" type="submit">Continue</button><button class="ghost" type="button" data-action="show-words">Show the words again</button></div>
      </form>`;
  }

  private vPassphrase() {
    return `
      <h1>Choose a passphrase</h1>
      <p>It encrypts the wallet in this browser. It does not replace the 24 words: if you forget it, import the words again.</p>
      <form data-form="passphrase">
        <label>Passphrase (${MIN_PASSPHRASE_LENGTH}+ characters)<input name="p1" type="password" minlength="${MIN_PASSPHRASE_LENGTH}" required autofocus autocomplete="new-password"></label>
        <label>Repeat it<input name="p2" type="password" minlength="${MIN_PASSPHRASE_LENGTH}" required autocomplete="new-password"></label>
        <div class="row"><button class="primary" type="submit">Create wallet</button><button class="ghost" type="button" data-action="welcome">Cancel</button></div>
      </form>`;
  }

  private vImport() {
    return `
      <h1>Import</h1>
      <form data-form="import">
        <label>Your 24 words
          <textarea name="seed" rows="4" autocomplete="off" autocapitalize="none" spellcheck="false" required autofocus></textarea></label>
        <p class="muted">An account this wallet activated is found again automatically.</p>
        <details class="adv"><summary>Advanced</summary>
          <label>The 64-character seed from the koinos-pq command-line tool also works in the box above. For an account set up with that tool, give its address:
            <input name="pqwallet" autocomplete="off" placeholder="1…"></label>
        </details>
        <div class="row"><button class="primary" type="submit">Continue</button><button class="ghost" type="button" data-action="welcome">Cancel</button></div>
      </form>`;
  }

  private vUnlock() {
    return `
      <h1>Unlock</h1>
      <form data-form="unlock">
        <label>Passphrase<input name="passphrase" type="password" required autofocus></label>
        <div class="row"><button class="primary" type="submit">Unlock</button></div>
      </form>
      <p class="muted">Lost the passphrase? <button class="link" data-action="delete-wallet">Delete this wallet</button> and import your 24 words again.</p>`;
  }

  private accountPicker() {
    const list = this.visibleAccounts();
    const cur = this.account();
    if (list.length <= 1) return "";
    return `<fieldset class="accounts"><legend>Account</legend>${list
      .map(
        (a) =>
          `<label class="acct"><input type="radio" name="account" value="${a.index}" ${cur && a.index === cur.index ? "checked" : ""}><span>${esc(a.label)} <code>${esc(short(a.address))}</code>${a.mode === "native" ? " <small>native</small>" : a.mode === "watch" ? " <small>watch-only</small>" : ""}</span></label>`,
      )
      .join("")}</fieldset>`;
  }

  private vHome() {
    const a = this.account();
    const s = this.s;
    if (!a) {
      return `
        <h1>Activate your account</h1>
        <p>Your wallet has its post-quantum key. To use it on <strong>${esc(this.network.name)}</strong>, send some KOIN to your account's address and the wallet activates it.</p>
        <div class="row"><button class="primary" data-action="setup">Show my account's address</button><button data-action="settings">Settings</button></div>
        <p class="muted">Head block ${s.head === null ? "…" : esc(s.head)}</p>`;
    }
    return `
      ${this.accountPicker()}
      <div class="hero">
        <span class="label">${esc(a.label)} · ${esc(this.network.name)}</span>
        <div class="chip"><code>${esc(a.address)}</code><button class="mini" data-action="copy" data-copy="${esc(a.address)}">Copy</button></div>
        <div class="stats">
          <div class="stat main"><span class="label">Balance</span><strong>${s.balance === null ? "…" : esc(formatKoin(s.balance))}<span class="unit">KOIN</span></strong></div>
          <div class="stat"><span class="label">Mana</span><strong>${s.mana === null ? "…" : esc(formatKoin(s.mana, 2))}</strong></div>
          <div class="stat"><span class="label">Head block</span><strong>${s.head === null ? "…" : esc(s.head)}</strong></div>
        </div>
      </div>
      <div class="tiles">
        ${canSign(a) ? `<button class="primary" data-action="send">Send</button>` : `<button disabled title="Watch-only: this wallet has no key for this address">Watch-only</button>`}
        <button data-action="receive">Receive</button>
        <button data-action="history">History</button>
        <button data-action="settings">Settings</button>
      </div>
      <div class="row"><button class="ghost mini" data-action="refresh">Refresh</button></div>`;
  }

  private vSend() {
    const a = this.account();
    return `
      <h1>Send KOIN</h1>
      <p class="muted">From ${esc(a?.label ?? "")} <code>${esc(short(a?.address))}</code> on ${esc(this.network.name)}. Signed with ML-DSA-44 (${a?.mode === "native" ? "3,733-byte native entry" : "2,420-byte signature"}).</p>
      <form data-form="send">
        <label>To<input name="to" autocomplete="off" required placeholder="1…" autofocus list="contacts"></label>
        <datalist id="contacts">${(this.s.book?.list() ?? []).map((c) => `<option value="${esc(c.address)}">${esc(c.name || short(c.address))}</option>`).join("")}</datalist>
        <label>Amount (KOIN)<input name="amount" inputmode="decimal" autocomplete="off" required placeholder="0.5"></label>
        <div class="row"><button class="primary" type="submit">Sign and send</button><button class="ghost" type="button" data-action="back-home">Back</button></div>
      </form>`;
  }

  private vSent() {
    const t = this.s.sent!;
    const link = this.network.explorerTx?.(t.txId);
    return `
      <h1>${t.waiting ? "Sent, waiting for a block" : t.block ? "Mined" : "Submitted"}</h1>
      <p>Transaction <code class="address">${esc(t.txId)}</code></p>
      <p class="muted">Signature entry ${esc(t.bytes)} bytes; rc used ${esc(t.rcUsed)}${t.block ? `; block ${esc(t.block)}` : ""}.${this.network.autoBlocks ? "" : " This network only makes blocks when the devnet script produces one."}</p>
      ${link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open in explorer</a></p>` : ""}
      <div class="row"><button class="primary" data-action="back-home">Done</button></div>`;
  }

  private vReceive() {
    const a = this.account();
    return `
      <h1>Receive</h1>
      <canvas id="qr" width="220" height="220" aria-label="QR code of the address"></canvas>
      <code class="address">${esc(a?.address ?? "")}</code>
      <div class="row"><button data-action="copy" data-copy="${esc(a?.address ?? "")}">Copy address</button><button class="ghost" data-action="back-home">Back</button></div>`;
  }

  private vHistory() {
    const h = this.s.history ?? [];
    return `
      <h1>History</h1>
      ${h.length ? `<ul class="hist">${h.map((i) => `<li><span>${esc(i.summary)}</span>${i.txId ? `<code>${esc(short(i.txId))}</code>` : ""}${i.blockHeight ? `<small>block ${esc(i.blockHeight)}</small>` : ""}</li>`).join("")}</ul>` : "<p class='muted'>Nothing yet.</p>"}
      <div class="row"><button class="ghost" data-action="back-home">Back</button></div>`;
  }

  private vSettings() {
    const net = this.network.name;
    const list = this.accounts().filter((a) => a.mode === "pqwallet");
    const hasHere = this.visibleAccounts().some((a) => a.mode === "pqwallet");
    return `
      <h1>Settings</h1>
      <h2>Accounts</h2>
      ${
        list.length
          ? `<ul class="plain">${list.map((a) => `<li><code>${esc(a.address)}</code> ${esc(a.label)}${a.derived ? " <small>found from your 24 words</small>" : ` <button class="link" data-action="remove-account" data-index="${a.index}">remove</button>`}</li>`).join("")}</ul>`
          : `<p class="muted">No account on ${esc(net)} yet.</p>`
      }
      ${hasHere ? "" : `<div class="row"><button class="primary" data-action="setup">Activate your account on ${esc(net)}</button></div>`}
      <h2>Backup</h2>
      <p class="muted">Show the 24 words again (asks for the passphrase).</p>
      <div class="row"><button data-action="export">Show recovery words</button></div>
      <h2>Contacts</h2>
      <p class="muted">${this.s.book?.list().length ?? 0} saved. Sending to an address you have never used, or one that merely resembles one you have, asks you to check it first.</p>
      <div class="row"><button data-action="contacts">Open contacts</button></div>
      <h2>Watch an address</h2>
      <p class="muted">See the balance, mana and history of any address (your cold account, a friend's). No key, no sending.</p>
      <form data-form="watch" class="inline"><input name="address" placeholder="1…" autocomplete="off" required><input name="label" placeholder="label (optional)" autocomplete="off"><button type="submit">Watch</button></form>
      <h2>Duress wallet</h2>
      <p class="muted">${this.s.vault?.hasDecoy ? "Set up. A second passphrase opens a separate, small wallet." : "Not set up. A second passphrase would open a separate, small wallet to show under pressure."}</p>
      <div class="row"><button data-action="duress">${this.s.vault?.hasDecoy ? "Replace the duress wallet" : "Set up a duress wallet"}</button></div>
      <h2>Locking and clipboard</h2>
      <form data-form="autolock">
        <label class="check">Auto-lock after <input name="minutes" type="number" min="1" max="120" value="${esc(this.s.autolockMinutes)}" style="width:5em"> minutes without activity</label>
        <label class="check"><input type="checkbox" name="lockOnHide" ${this.s.lockOnHide ? "checked" : ""}> Lock ${HIDDEN_LOCK_SECONDS} s after this tab is hidden or the screen goes off</label>
        <label class="check"><input type="checkbox" name="clipboardWipe" ${this.s.clipboardWipe ? "checked" : ""}> Clear the clipboard ${CLIPBOARD_WIPE_SECONDS} s after copying an address</label>
        <div class="row"><button type="submit">Save</button></div>
      </form>
      <details class="adv"><summary>Advanced</summary>
        <h2>Add an account by address</h2>
        <p class="muted">Only for an account set up with the koinos-pq command-line tool. Accounts this wallet activates are found automatically.</p>
        <form data-form="add-account" class="inline">
          <input name="address" placeholder="1…" autocomplete="off" required><input name="label" placeholder="label (optional)" autocomplete="off"><button type="submit">Add</button>
        </form>
        <h2>Native post-quantum address</h2>
        <p class="muted">The address of the key itself. It needs nodes that verify ML-DSA-44 directly, a proposed node change that runs on the devnet only. On mainnet and Harbinger it can receive but cannot spend, so do not send to it.</p>
        <code class="address">${esc(this.s.keys?.address ?? "")}</code>
        <div class="row"><button data-action="native-balance">Check its balance on ${esc(net)}</button></div>
        <h2>Devnet RPC</h2>
        <form data-form="devnet-rpc" class="inline"><input name="rpc" value="${esc(pref.get(PREF_DEVNET_RPC) ?? "http://127.0.0.1:8080/")}"><button type="submit">Save</button></form>
      </details>
      <h2>Danger</h2>
      <div class="row"><button class="danger" data-action="delete-wallet">Delete wallet from this browser</button><button class="ghost" data-action="back-home">Back</button></div>`;
  }

  private vSetup() {
    const st = this.s.setup;
    if (!st) return `<p>Nothing to activate.</p>`;
    const unit = this.network.name === "mainnet" ? "KOIN" : "tKOIN";
    if (st.result) {
      const r = st.result;
      const link = (id: string | null) => (id && this.network.explorerTx ? `<a href="${esc(this.network.explorerTx(id))}" target="_blank" rel="noopener noreferrer">${esc(short(id))}</a>` : id ? `<code>${esc(short(id))}</code>` : "already done");
      return `
        <h1>Account ready</h1>
        <p><code class="address">${esc(r.account)}</code></p>
        <p>${r.uploadTx && r.uploadTx === r.registerTx ? `Contract installed and key registered in one transaction, ${link(r.uploadTx)}.` : `Contract installed ${link(r.uploadTx)}, key registered ${link(r.registerTx)}.`} From now on only this wallet's post-quantum key can move this account.</p>
        <div class="row"><button class="primary" data-action="setup-done">Go to the account</button></div>`;
    }
    if (st.running) {
      return `
        <h1>Activating your account</h1>
        <p><code class="address">${esc(st.account)}</code></p>
        <p>${esc(st.status?.message ?? "Starting")}${st.status?.txId ? ` <code>${esc(short(st.status.txId))}</code>` : ""}</p>
        <p class="muted">One transaction, waiting for its block; usually under a minute. Keep this page open.${this.network.autoBlocks ? "" : " On the devnet, produce blocks with devnet/produce-block.mjs."}</p>`;
    }
    const need = this.needed(st);
    const funded = need !== null && st.mana !== null && st.mana >= need;
    return `
      <h1>Activate your account</h1>
      <p>This is your account's address on <strong>${esc(this.network.name)}</strong>. Send at least <strong>${need === null ? "…" : esc(formatKoin(need, 2))} ${unit}</strong> to it.</p>
      <canvas id="qr-setup" width="180" height="180" aria-label="QR code of your account's address"></canvas>
      <code class="address">${esc(st.account)}</code>
      <div class="row"><button data-action="copy" data-copy="${esc(st.account)}">Copy address</button></div>
      <p id="setup-mana" class="${funded ? "notice" : "muted"}">${need !== null ? esc(this.manaLine(st.mana, need)) : "Pricing the activation from the node…"}</p>
      ${st.failed ? `<p class="error">Activation stopped: ${esc(st.failed)}</p><div class="row"><button class="primary" data-action="setup-retry">Try again</button></div>` : ""}
      <p class="muted">As soon as it holds enough, the wallet activates it by itself: it installs the post-quantum check on the account and registers your key, together in one transaction signed here in this page. From then on only your 24 words can move the account. The ${unit} stays yours; activation is paid with the account's mana, which refills over five days. Keep this page open until it says the account is ready.</p>
      <div class="row"><button class="ghost" data-action="setup-cancel">Settings</button></div>`;
  }

  /** Characters of `addr` that differ from `ref` are marked, so the eye lands on them. */
  private diffMarked(addr: string, ref: string): string {
    return [...addr].map((ch, i) => (ch === ref[i] ? esc(ch) : `<mark>${esc(ch)}</mark>`)).join("");
  }

  private vSendConfirm() {
    const sc = this.s.sendCheck;
    if (!sc) return `<p>Nothing to confirm.</p>`;
    const look = sc.assessment.kind === "lookalike";
    const m = sc.assessment.match;
    return `
      <h1>${look ? "Stop: this address looks like one you use" : "First time sending here"}</h1>
      ${
        look && m
          ? `<div class="error" role="alert">
               <p><strong>${esc(sc.to)}</strong> is not <strong>${esc(m.name || short(m.address))}</strong>. It shares its first and last characters, which is how address-poisoning attacks work: the attacker hopes you copied theirs from your history by mistake.</p>
               <p class="muted">Typed: <code class="address">${this.diffMarked(sc.to, m.address)}</code><br>Known: <code class="address">${esc(m.address)}</code></p>
             </div>`
          : `<p>You have not sent to <code class="address">${esc(sc.to)}</code> from this wallet before. Compare <em>every</em> character with the address the recipient gave you, not only the first and last few. Transfers cannot be undone.</p>`
      }
      <p class="muted">Amount: <strong>${esc(sc.amount)} KOIN</strong> on ${esc(this.network.name)}.</p>
      <form data-form="send-confirm">
        ${
          look
            ? `<label>If you are certain, type the last six characters of the address you want to pay: <input name="tail" autocomplete="off" required autofocus maxlength="6" style="width:8em"></label>`
            : `<label class="check"><input type="checkbox" name="checked" required> I have compared the whole address</label>
               <label>Save as a contact (optional)<input name="name" autocomplete="off" placeholder="name" maxlength="40"></label>`
        }
        <div class="row"><button class="${look ? "danger" : "primary"}" type="submit">${look ? "Send anyway" : "Sign and send"}</button><button class="ghost" type="button" data-action="send-cancel">Back</button></div>
      </form>`;
  }

  private vContacts() {
    const list = this.s.book?.list() ?? [];
    return `
      <h1>Contacts</h1>
      <p class="muted">Addresses this wallet has sent to, with the names you gave them. Kept in this browser only, separately for each wallet.</p>
      ${
        list.length
          ? `<ul class="plain">${list
              .map(
                (c) => `<li><form data-form="contact-rename" class="inline"><input type="hidden" name="address" value="${esc(c.address)}"><code>${esc(short(c.address))}</code><input name="name" value="${esc(c.name)}" placeholder="name" maxlength="40"><button type="submit">Save</button><button type="button" class="link" data-action="contact-remove" data-address="${esc(c.address)}">remove</button></form><small>${c.sends} send${c.sends === 1 ? "" : "s"}${c.lastSentAt ? `, last ${esc(c.lastSentAt.slice(0, 10))}` : ""}</small></li>`,
              )
              .join("")}</ul>`
          : "<p class='muted'>No contacts yet. The first successful send to an address adds it.</p>"
      }
      <div class="row"><button class="ghost" data-action="settings">Back</button></div>`;
  }

  private vDuress() {
    return `
      <h1>Duress wallet</h1>
      <p>A second, separate wallet with its own 24 words and its own passphrase. If someone forces you to unlock, you type the duress passphrase and they see that wallet, with whatever small amount you keep in it. Nothing on this device shows that another wallet exists, and unlocking takes the same time either way.</p>
      <p><strong>What it cannot do.</strong> Balances are public on the chain. Anyone who already knows your main address can look it up. The decoy protects you from someone who does not, and only if it looks lived-in: give it a little KOIN and use it now and then.</p>
      <p class="muted">Setting it up asks for your main passphrase (so only you can), and a new passphrase for the decoy. The decoy's 24 words are shown once; write them down if you want to recover it, otherwise just note that losing them loses only the decoy.</p>
      <div class="row"><button class="primary" data-action="duress-create">Create the duress wallet</button><button class="ghost" data-action="duress-cancel">Back</button></div>`;
  }

  private vDuressWords() {
    const words = (this.s.pendingDecoy ?? "").split(" ");
    return `
      <h1>The duress wallet's 24 words</h1>
      <ol class="words">${words.map((w) => `<li>${esc(w)}</li>`).join("")}</ol>
      <form data-form="duress-save">
        <label>Duress passphrase (${MIN_PASSPHRASE_LENGTH}+ characters, different from your main one)<input name="d1" type="password" minlength="${MIN_PASSPHRASE_LENGTH}" required autofocus autocomplete="new-password"></label>
        <label>Repeat it<input name="d2" type="password" minlength="${MIN_PASSPHRASE_LENGTH}" required autocomplete="new-password"></label>
        <label>Your main passphrase (to confirm)<input name="main" type="password" required autocomplete="off"></label>
        <p class="muted">After saving, the wallet locks. Unlock with your main passphrase as usual; the duress passphrase opens the decoy, where you can activate its account and fund it like any new wallet.</p>
        <div class="row"><button class="primary" type="submit">Save duress wallet</button><button class="ghost" type="button" data-action="duress-cancel">Cancel</button></div>
      </form>`;
  }

  private vSave() {
    const c = this.s.change;
    if (!c) return `<p>Nothing to save.</p>`;
    return `
      <h1>${esc(c.title)}</h1>
      <p>${esc(c.detail)}</p>
      <form data-form="save">
        <label>Passphrase (to save the change)<input name="passphrase" type="password" required autofocus autocomplete="off"></label>
        <div class="row"><button class="primary" type="submit">Save</button><button class="ghost" type="button" data-action="change-cancel">Cancel</button></div>
      </form>`;
  }

  private vExport() {
    if (this.s.exportWords) {
      return `
        <h1>Your 24 words</h1>
        <ol class="words">${this.s.exportWords.split(" ").map((w) => `<li>${esc(w)}</li>`).join("")}</ol>
        <p class="muted">Seed (hex, for the command-line tool's key file): <code class="address">${esc(this.s.vault?.seedHex ?? "")}</code></p>
        <div class="row"><button class="primary" data-action="back-home">Done</button></div>`;
    }
    return `
      <h1>Show recovery words</h1>
      <form data-form="export">
        <label>Passphrase<input name="passphrase" type="password" required autofocus autocomplete="off"></label>
        <div class="row"><button class="primary" type="submit">Show</button><button class="ghost" type="button" data-action="back-home">Back</button></div>
      </form>`;
  }
}
