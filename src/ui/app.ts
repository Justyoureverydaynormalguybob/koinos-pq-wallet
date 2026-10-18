// The whole UI: a small state machine rendering HTML strings into #app, no framework.
import QRCode from "qrcode";
import { Chain, NETWORKS, formatKoin, parseKoin, isAddress, short, type HistoryItem, type Network } from "../core/chain";
import { deriveKeys, mnemonicToSeed, newMnemonic, parseSeedInput, seedToMnemonic, bytesToHex, hexToBytes, wipe, type PqKeys } from "../core/keys";
import type { AccountMode } from "../core/sign";
import { decryptVault, encryptVault, localVaultStore, MIN_PASSPHRASE_LENGTH, type AccountRecord, type EncryptedVault, type VaultData } from "../core/vault";

type Screen = "welcome" | "create" | "confirm" | "passphrase" | "import" | "unlock" | "home" | "send" | "sent" | "receive" | "history" | "settings" | "export";

interface Account extends AccountRecord {
  index: number;
}

interface State {
  screen: Screen;
  enc: EncryptedVault | null;
  vault: VaultData | null;
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
}

const PREF_NETWORK = "koinos-pq-wallet/network";
const PREF_DEVNET_RPC = "koinos-pq-wallet/devnet-rpc";
const PREF_AUTOLOCK = "koinos-pq-wallet/autolock-minutes";

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

  constructor(root: HTMLElement) {
    this.root = root;
    const enc = localVaultStore.load();
    this.s = {
      screen: enc ? "unlock" : "welcome",
      enc,
      vault: null,
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
    };
    if (!NETWORKS[this.s.networkName]) this.s.networkName = "testnet";
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("change", (e) => this.onChange(e));
    for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, () => this.touch(), { passive: true });
    this.render();
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
  private accounts(): Account[] {
    const out: Account[] = [];
    if (this.s.keys) out.push({ index: 0, label: "Post-quantum address (native)", mode: "native", address: this.s.keys.address });
    for (const a of this.s.vault?.accounts ?? []) out.push({ index: out.length, ...a });
    return out;
  }
  private account(): Account | null {
    const list = this.accounts();
    return list[this.s.accountIndex] ?? list[0] ?? null;
  }

  // ---------- lifecycle ----------
  private touch() {
    if (!this.s.keys) return;
    window.clearTimeout(this.lockTimer);
    this.lockTimer = window.setTimeout(() => this.lock("Locked after inactivity."), this.s.autolockMinutes * 60_000);
  }
  private lock(notice?: string) {
    if (this.s.keys) wipe(this.s.keys.secretKey, this.s.keys.seed);
    if (this.s.pendingSeed) wipe(this.s.pendingSeed);
    this.s.keys = null;
    this.s.vault = null;
    this.s.pendingSeed = null;
    this.s.pendingMnemonic = null;
    this.s.exportWords = null;
    this.s.balance = this.s.mana = null;
    this.s.history = null;
    this.s.sent = null;
    this.s.enc = localVaultStore.load();
    this.s.screen = this.s.enc ? "unlock" : "welcome";
    this.s.notice = notice ?? null;
    this.s.error = null;
    window.clearTimeout(this.lockTimer);
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
    const a = this.account();
    if (!a) return;
    const chain = this.chain();
    const [balance, mana, head] = await Promise.all([chain.balance(a.address), chain.mana(a.address), chain.headHeight()]);
    this.s.balance = balance;
    this.s.mana = mana;
    this.s.head = head;
  }
  private async finishSetup(passphrase: string) {
    const seed = this.s.pendingSeed;
    if (!seed) throw new Error("nothing to save");
    const vault: VaultData = { version: 1, seedHex: bytesToHex(seed), accounts: this.s.pendingAccounts, createdAt: new Date().toISOString() };
    const enc = await encryptVault(vault, passphrase);
    if (!localVaultStore.save(enc)) throw new Error("this browser blocks local storage; the wallet cannot be saved here");
    this.s.enc = enc;
    this.s.vault = vault;
    this.s.keys = deriveKeys(seed);
    this.s.pendingSeed = null;
    this.s.pendingMnemonic = null;
    this.s.pendingAccounts = [];
    this.s.accountIndex = this.s.vault.accounts.length ? 1 : 0; // prefer a pqwallet account when one was imported
    this.s.screen = "home";
    this.s.notice = null;
    this.touch();
    await this.refresh();
  }
  private async resave() {
    // vault contents changed (account list): re-encrypt under the same passphrase is impossible without it,
    // so we keep the passphrase out of memory and ask for it.
    const pass = window.prompt("Enter your passphrase to save the change");
    if (pass === null) throw new Error("not saved");
    if (!this.s.enc || !this.s.vault) throw new Error("no vault");
    await decryptVault(this.s.enc, pass); // verifies the passphrase
    const enc = await encryptVault(this.s.vault, pass);
    if (!localVaultStore.save(enc)) throw new Error("could not write to local storage");
    this.s.enc = enc;
  }

  // ---------- events ----------
  private onChange(e: Event) {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLSelectElement && t.name === "network") {
      this.s.networkName = t.value;
      pref.set(PREF_NETWORK, t.value);
      this.s.balance = this.s.mana = this.s.head = null;
      this.s.history = null;
      void this.run("Loading", () => this.refresh());
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
        this.go("create");
        break;
      }
      case "wrote-down": {
        const idx = new Set<number>();
        while (idx.size < 3) idx.add(Math.floor(Math.random() * 24));
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
        void navigator.clipboard?.writeText(text).then(
          () => {
            this.s.notice = "Copied.";
            this.render();
            window.setTimeout(() => {
              this.s.notice = null;
              this.render();
            }, 1500);
          },
          () => {
            this.s.error = "Could not copy; select the text instead.";
            this.render();
          },
        );
        break;
      }
      case "remove-account": {
        const i = Number(el.dataset.index);
        void this.run("Saving", async () => {
          if (!this.s.vault) return;
          this.s.vault.accounts.splice(i - 1, 1); // index 0 is the native address, not stored
          await this.resave();
          if (this.s.accountIndex >= this.accounts().length) this.s.accountIndex = 0;
        });
        break;
      }
      case "delete-wallet": {
        const typed = window.prompt("This deletes the wallet from this browser. Your 24 words are the only way back in.\nType DELETE to confirm.");
        if (typed === "DELETE") {
          localVaultStore.clear();
          this.lock("Wallet deleted from this browser.");
        }
        break;
      }
      case "export": {
        this.go("export");
        break;
      }
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
            if (!isAddress(pq)) throw new Error("the pqwallet account address is not a valid Koinos address");
            accounts.push({ label: "pqwallet account", mode: "pqwallet", address: pq });
          }
          this.s.pendingSeed = seed;
          this.s.pendingAccounts = accounts;
          this.s.screen = "passphrase";
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
          if (!this.s.enc) throw new Error("no wallet in this browser");
          const vault = await decryptVault(this.s.enc, field("passphrase"));
          this.s.vault = vault;
          this.s.keys = deriveKeys(hexToBytes(vault.seedHex));
          this.s.accountIndex = vault.accounts.length ? 1 : 0;
          this.s.screen = "home";
          this.touch();
          await this.refresh();
        });
        break;
      }
      case "send": {
        void this.run("Signing and sending", async () => {
          const a = this.account();
          if (!a || !this.s.keys) throw new Error("locked");
          const to = field("to").trim();
          const valueBase = parseKoin(field("amount"));
          const chain = this.chain();
          const res = await chain.sendKoin({ from: a.address, to, valueBase, keys: this.s.keys, mode: a.mode });
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
        });
        break;
      }
      case "add-account": {
        void this.run("Saving", async () => {
          const addr = field("address").trim();
          if (!isAddress(addr)) throw new Error("not a valid Koinos address");
          if (!this.s.vault) throw new Error("locked");
          this.s.vault.accounts.push({ label: field("label").trim() || "pqwallet account", mode: "pqwallet", address: addr });
          await this.resave();
        });
        break;
      }
      case "export": {
        void this.run("Checking passphrase", async () => {
          if (!this.s.enc) throw new Error("no vault");
          const vault = await decryptVault(this.s.enc, field("passphrase"));
          this.s.exportWords = seedToMnemonic(hexToBytes(vault.seedHex));
        });
        break;
      }
      case "autolock": {
        const m = Math.max(1, Math.min(120, Number(field("minutes")) || 10));
        this.s.autolockMinutes = m;
        pref.set(PREF_AUTOLOCK, String(m));
        this.touch();
        this.s.notice = `Auto-lock set to ${m} minutes.`;
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
      sent: () => this.vSent(),
      receive: () => this.vReceive(),
      history: () => this.vHistory(),
      settings: () => this.vSettings(),
      export: () => this.vExport(),
    }[s.screen]();
    this.root.innerHTML = `
      <header class="top">
        <div class="brand">Koinos PQ Wallet <span class="tag">ML-DSA-44</span></div>
        ${s.keys ? `<div class="topright"><select name="network" aria-label="Network">${Object.keys(NETWORKS).map((n) => `<option value="${n}" ${n === s.networkName ? "selected" : ""}>${n}</option>`).join("")}</select><button class="ghost" data-action="lock">Lock</button></div>` : ""}
      </header>
      ${s.busy ? `<div class="busy" role="status">${esc(s.busy)}…</div>` : ""}
      ${s.error ? `<div class="error" role="alert">${esc(s.error)}</div>` : ""}
      ${s.notice ? `<div class="notice" role="status">${esc(s.notice)}</div>` : ""}
      <section class="card">${body}</section>
      <footer class="foot">Keys never leave this browser. Not audited. Testnet first.</footer>`;
    const canvas = this.root.querySelector<HTMLCanvasElement>("canvas#qr");
    if (canvas) {
      const a = this.account();
      if (a) void QRCode.toCanvas(canvas, a.address, { width: 220, margin: 1 });
    }
    this.root.querySelector<HTMLElement>("[autofocus]")?.focus();
  }

  private vWelcome() {
    return `
      <h1>A wallet that a quantum computer cannot pick</h1>
      <p>Your account is controlled by an <strong>ML-DSA-44</strong> key (NIST FIPS 204) instead of secp256k1. The key lives only in this browser, encrypted with a passphrase you choose, and is backed up by 24 words.</p>
      <div class="row">
        <button class="primary" data-action="create">Create a new wallet</button>
        <button data-action="import">Import 24 words or a seed</button>
      </div>
      <p class="muted">Two kinds of account are supported: a <em>pqwallet</em> account (an existing address running the koinos-pq contract, works on mainnet and Harbinger now) and a <em>native</em> post-quantum address (works on nodes running the ml-dsa-44 branch).</p>`;
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
        <div class="row"><button class="primary" type="submit">Continue</button><button class="ghost" type="button" data-action="create">Show the words again</button></div>
      </form>`;
  }

  private vPassphrase() {
    return `
      <h1>Choose a passphrase</h1>
      <p>It encrypts the wallet in this browser. It does not replace the 24 words: if you forget it, import the words again.</p>
      <form data-form="passphrase">
        <label>Passphrase (${MIN_PASSPHRASE_LENGTH}+ characters)<input name="p1" type="password" minlength="${MIN_PASSPHRASE_LENGTH}" required autofocus></label>
        <label>Repeat it<input name="p2" type="password" minlength="${MIN_PASSPHRASE_LENGTH}" required></label>
        <div class="row"><button class="primary" type="submit">Create wallet</button><button class="ghost" type="button" data-action="welcome">Cancel</button></div>
      </form>`;
  }

  private vImport() {
    return `
      <h1>Import</h1>
      <form data-form="import">
        <label>24 words, or the 64-character seed from the koinos-pq CLI key file
          <textarea name="seed" rows="4" autocomplete="off" autocapitalize="none" spellcheck="false" required autofocus></textarea></label>
        <label>pqwallet account address (optional: the account that runs the contract with this key)
          <input name="pqwallet" autocomplete="off" placeholder="1…"></label>
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
    const list = this.accounts();
    const cur = this.account();
    if (list.length <= 1) return "";
    return `<fieldset class="accounts"><legend>Account</legend>${list
      .map(
        (a) =>
          `<label class="acct"><input type="radio" name="account" value="${a.index}" ${cur && a.index === cur.index ? "checked" : ""}><span>${esc(a.label)} <code>${esc(short(a.address))}</code> <small>${a.mode}</small></span></label>`,
      )
      .join("")}</fieldset>`;
  }

  private nativeWarning(a: Account | null) {
    if (!a || a.mode !== "native" || this.network.name === "devnet") return "";
    return `<p class="warn">This is a native post-quantum address. Today's ${esc(this.network.name)} nodes do not verify ML-DSA-44 yet; sends from it will be refused until the ml-dsa-44 change is adopted. Use a pqwallet account for ${esc(this.network.name)}.</p>`;
  }

  private vHome() {
    const a = this.account();
    const s = this.s;
    return `
      ${this.accountPicker()}
      <div class="addr"><div class="label">${esc(a?.label ?? "")}</div>
        <code class="address">${esc(a?.address ?? "")}</code>
        <button class="ghost" data-action="copy" data-copy="${esc(a?.address ?? "")}">Copy</button></div>
      ${this.nativeWarning(a)}
      <div class="stats">
        <div><span class="label">KOIN</span><strong>${s.balance === null ? "…" : esc(formatKoin(s.balance))}</strong></div>
        <div><span class="label">Mana</span><strong>${s.mana === null ? "…" : esc(formatKoin(s.mana, 2))}</strong></div>
        <div><span class="label">Head block</span><strong>${s.head === null ? "…" : esc(s.head)}</strong></div>
      </div>
      <div class="row">
        <button class="primary" data-action="send">Send</button>
        <button data-action="receive">Receive</button>
        <button data-action="history" ${this.network.rest ? "" : "disabled title='no history service on this network'"}>History</button>
        <button data-action="settings">Settings</button>
        <button class="ghost" data-action="refresh">Refresh</button>
      </div>`;
  }

  private vSend() {
    const a = this.account();
    return `
      <h1>Send KOIN</h1>
      <p class="muted">From ${esc(a?.label ?? "")} <code>${esc(short(a?.address))}</code> on ${esc(this.network.name)}. Signed with ML-DSA-44 (${a?.mode === "native" ? "3,733-byte native entry" : "2,420-byte pqwallet signature"}).</p>
      ${this.nativeWarning(a)}
      <form data-form="send">
        <label>To<input name="to" autocomplete="off" required placeholder="1…" autofocus></label>
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
      <p class="muted">Signature entry ${t.bytes} bytes; rc used ${esc(t.rcUsed)}${t.block ? `; block ${esc(t.block)}` : ""}.${this.network.autoBlocks ? "" : " This network only makes blocks when the devnet script produces one."}</p>
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
    const list = this.accounts().filter((a) => a.mode === "pqwallet");
    return `
      <h1>Settings</h1>
      <h2>pqwallet accounts</h2>
      <p class="muted">An existing address that runs the koinos-pq contract with this wallet's key registered. Add it here to send from it.</p>
      ${list.length ? `<ul class="plain">${list.map((a) => `<li><code>${esc(a.address)}</code> ${esc(a.label)} <button class="link" data-action="remove-account" data-index="${a.index}">remove</button></li>`).join("")}</ul>` : ""}
      <form data-form="add-account" class="inline">
        <input name="address" placeholder="1…" autocomplete="off" required><input name="label" placeholder="label (optional)" autocomplete="off"><button type="submit">Add</button>
      </form>
      <h2>Backup</h2>
      <p class="muted">Show the 24 words again (asks for the passphrase).</p>
      <div class="row"><button data-action="export">Show recovery words</button></div>
      <h2>Auto-lock</h2>
      <form data-form="autolock" class="inline"><input name="minutes" type="number" min="1" max="120" value="${this.s.autolockMinutes}"> minutes <button type="submit">Save</button></form>
      <h2>Devnet RPC</h2>
      <form data-form="devnet-rpc" class="inline"><input name="rpc" value="${esc(pref.get(PREF_DEVNET_RPC) ?? "http://127.0.0.1:8080/")}"><button type="submit">Save</button></form>
      <h2>Danger</h2>
      <div class="row"><button class="danger" data-action="delete-wallet">Delete wallet from this browser</button><button class="ghost" data-action="back-home">Back</button></div>`;
  }

  private vExport() {
    if (this.s.exportWords) {
      return `
        <h1>Your 24 words</h1>
        <ol class="words">${this.s.exportWords.split(" ").map((w) => `<li>${esc(w)}</li>`).join("")}</ol>
        <p class="muted">Seed (hex, for the CLI key file): <code class="address">${esc(this.s.vault?.seedHex ?? "")}</code></p>
        <div class="row"><button class="primary" data-action="back-home">Done</button></div>`;
    }
    return `
      <h1>Show recovery words</h1>
      <form data-form="export">
        <label>Passphrase<input name="passphrase" type="password" required autofocus></label>
        <div class="row"><button class="primary" type="submit">Show</button><button class="ghost" type="button" data-action="back-home">Back</button></div>
      </form>`;
  }
}

export type { AccountMode };
