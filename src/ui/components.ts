// The building blocks of the UI, rendered as HTML strings on the design system in tokens.css: card,
// balance, stat, address strip, buttons, fields, list rows, tab bar, notices, section labels, header
// and ticker. Everything that reaches the DOM goes through esc(); callers pass already-escaped HTML
// only where a parameter is named `html`.
import { utils } from "koilib";

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** 1LQY…HwkQ */
export const shortAddr = (a: string | undefined | null): string => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");

/**
 * An address in groups of four, the first and last four characters in ink and the middle in mute, so a
 * poisoned look-alike (same ends, different middle) stands out. With `diffFrom`, every character that
 * differs from that reference is marked. The element's textContent is the plain address.
 */
export function addressStrip(address: string, opts: { size?: "sm"; box?: boolean; diffFrom?: string; attrs?: string } = {}): string {
  const a = address ?? "";
  const n = a.length;
  const ch = (c: string, i: number) => {
    const inner = esc(c);
    const marked = opts.diffFrom !== undefined && opts.diffFrom[i] !== c ? `<mark>${inner}</mark>` : inner;
    return i >= 4 && i < n - 4 ? marked : `<b class="k">${marked}</b>`;
  };
  const groups: string[] = [];
  for (let i = 0; i < n; i += 4) {
    const chars = [...a.slice(i, i + 4)].map((c, j) => ch(c, i + j)).join("");
    groups.push(`<span class="g">${chars}</span>`);
  }
  const cls = ["address", "addr", opts.size === "sm" ? "sm" : "", opts.box ? "box" : ""].filter(Boolean).join(" ");
  return `<code class="${cls}" ${opts.attrs ?? ""}>${groups.join("")}</code>`;
}

/** The first five bytes of the decoded address as a hex strip (the account's "dump"), or "" if it is not an address. */
export function hexStrip(address: string | null | undefined): string {
  if (!address) return "";
  try {
    const b = utils.decodeBase58(address).subarray(0, 5);
    return `<span class="hexstrip" aria-hidden="true">${[...b].map((x) => x.toString(16).padStart(2, "0")).join(" ")}</span>`;
  } catch {
    return "";
  }
}

/** `[01] ACCOUNT` with an optional right-hand note (html). */
export function section(n: string | null, title: string, rightHtml = ""): string {
  return `<h2 class="sec"><span>${n ? `<span class="n">[${esc(n)}]</span> ` : ""}${esc(title)}</span>${rightHtml ? `<span>${rightHtml}</span>` : ""}</h2>`;
}

export const card = (html: string, attrs = ""): string => `<section class="card" ${attrs}>${html}</section>`;

export function balance(value: string | null, unit: string): string {
  return `<div class="bal"><span class="v">${value === null ? "…" : esc(value)}</span><span class="u">${esc(unit)}</span></div>`;
}

export const stat = (k: string, vHtml: string): string => `<div class="stat"><span class="k">${esc(k)}</span><span class="v">${vHtml}</span></div>`;

export interface ButtonOpts {
  action?: string;
  type?: "button" | "submit";
  variant?: "primary" | "danger" | "ghost";
  mini?: boolean;
  block?: boolean;
  disabled?: boolean;
  title?: string;
  data?: Record<string, string | number>;
  attrs?: string;
}
export function button(label: string, o: ButtonOpts = {}): string {
  const cls = ["btn", o.variant ?? "", o.mini ? "mini" : "", o.block ? "block" : ""].filter(Boolean).join(" ");
  const data = Object.entries(o.data ?? {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
  return `<button class="${cls}" type="${o.type ?? (o.action ? "button" : "submit")}"${o.action ? ` data-action="${esc(o.action)}"` : ""}${data}${o.disabled ? " disabled" : ""}${o.title ? ` title="${esc(o.title)}"` : ""} ${o.attrs ?? ""}>${label}</button>`;
}
export const linkButton = (label: string, action: string, data: Record<string, string | number> = {}): string =>
  `<button class="link" type="button" data-action="${esc(action)}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("")}>${esc(label)}</button>`;

/** A labelled control. `controlHtml` is the input/select/textarea markup. */
export const field = (label: string, controlHtml: string, attrs = ""): string => `<label class="field" ${attrs}><span>${esc(label)}</span>${controlHtml}</label>`;

export function input(attrs: Record<string, string | number | boolean | undefined>): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}="${esc(v)}"`))
    .join(" ");
  return `<input ${a}>`;
}

export const check = (name: string, label: string, checked: boolean, extra = ""): string =>
  `<label class="check"><input type="checkbox" name="${esc(name)}" ${checked ? "checked" : ""} ${extra}> ${esc(label)}</label>`;

/** A row of the list component: `mainHtml` grows, `rightHtml` sits at the end. */
export const listRow = (mainHtml: string, rightHtml = "", attrs = ""): string => `<li ${attrs}><span class="grow">${mainHtml}</span>${rightHtml}</li>`;
export const list = (rowsHtml: string): string => `<ul class="list">${rowsHtml}</ul>`;

/** The symbol tile shown instead of a logo. */
export const tile = (symbol: string): string => `<span class="tile" aria-hidden="true">${esc(symbol.replace(/^t/, "").slice(0, 4))}</span>`;

export type NoticeKind = "busy" | "ok" | "warn" | "danger";
export function notice(kind: NoticeKind, html: string, role = kind === "danger" ? "alert" : "status"): string {
  return `<div class="note ${kind}" role="${role}">${html}</div>`;
}

export const words = (list: string[]): string => `<ol class="words">${list.map((w) => `<li>${esc(w)}</li>`).join("")}</ol>`;

export interface Tab {
  id: string;
  label: string;
  action: string;
}
const ICONS: Record<string, string> = {
  account: `<rect x="3" y="5" width="18" height="14"/><circle cx="16" cy="12" r="1.5"/>`,
  activity: `<polyline points="3 14 8 14 10 7 14 17 16 11 21 11"/>`,
  dapps: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>`,
  settings: `<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`,
};
export function tabBar(tabs: Tab[], current: string): string {
  return `<nav class="tabs" aria-label="Sections">${tabs
    .map(
      (t) =>
        `<button type="button" data-action="${esc(t.action)}" ${t.id === current ? 'aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t.id] ?? ""}</svg>${esc(t.label)}</button>`,
    )
    .join("")}</nav>`;
}

/** The wordmark: a signal pixel, "Sparán" wide, and its UTF-8 hex dump. */
export const mark = (): string => `<span class="mark"><span class="px" aria-hidden="true"></span>Sparán <span class="hex" aria-hidden="true">53 70 61 72 c3 a1 6e</span><span class="sr-only">Sparán wallet</span></span>`;

export const header = (rightHtml = ""): string => `<header class="hdr">${mark()}${rightHtml ? `<span class="hdr-right">${rightHtml}</span>` : ""}</header>`;

/** The live line: network on the left (with a blinking signal square when blocks arrive), head block on the right. */
export function ticker(network: string, head: string | null, live = true, rightHtml?: string): string {
  const h = head === null ? "head …" : `head ${esc(fmtInt(head))}`;
  return `<div class="ticker"><span>${live ? '<span class="live" aria-hidden="true"></span>' : ""}${esc(network)}</span><span id="ticker-head">${rightHtml ?? h}</span></div>`;
}

/** 24118402 -> 24,118,402 (strings only; amounts keep their own formatting). */
export function fmtInt(s: string | number): string {
  const t = String(s);
  return /^\d+$/.test(t) ? t.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : t;
}

/** A decimal amount string with thousands separators in the integer part: "1234.5678" -> "1,234.5678". */
export function fmtAmount(s: string): string {
  const [i, f] = s.split(".");
  return fmtInt(i ?? "0") + (f ? `.${f}` : "");
}
