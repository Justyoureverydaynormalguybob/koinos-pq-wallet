// How a dapp request is shown before approval: the same words in the extension window and the in-app
// sheet. Everything rendered goes through esc()/addressStrip().
import { cleanLabel, decodeFields, formatKoin, TOKEN_ENTRY, type Network } from "koinos-pq-core";
import { utils } from "koilib";
import { allTokens, findToken, formatUnits, type CustomTokens } from "../core/tokens";
import { NFT_ENTRY } from "../core/nfts";
import { strictTransfer, type CallContract, type Plan } from "../core/approval";
import { addressStrip, card, esc, list, listRow, notice, stat } from "./components";
import { t as tr } from "../i18n";

/** sha256("approve")[0:4], sha256("burn")[0:4]: the KCS-4 entry points besides transfer that move value or rights. */
const TOKEN_APPROVE = 0x74e21680, TOKEN_BURN = 0x859facc5;

function fieldBytes(f: Map<number, Array<bigint | Uint8Array>>, n: number): Uint8Array | null {
  const v = f.get(n)?.[0];
  return v instanceof Uint8Array ? v : null;
}
function fieldUint(f: Map<number, Array<bigint | Uint8Array>>, n: number): bigint | null {
  const v = f.get(n)?.[0];
  return typeof v === "bigint" ? v : null;
}
const addr = (b: Uint8Array | null) => (b && b.length === 25 ? utils.encodeBase58(b) : null);

/** The raw arguments, so a call the wallet cannot decode is still visible rather than invisible. */
function rawArgs(argsB64: string): string {
  let bytes: Uint8Array;
  try {
    bytes = utils.decodeBase64url(argsB64);
  } catch {
    return `<span class="warn-inline">${tr("arguments unreadable")}</span>`;
  }
  const hex = utils.toHexString(bytes);
  const shown = hex.length > 160 ? `${hex.slice(0, 160)}…` : hex;
  return `<code class="address addr sm" style="color:var(--mute)">${esc(shown)}</code> <span class="mute">(${esc(bytes.length)} ${tr("bytes")})</span>`;
}

/**
 * One operation in words. `custom` is the open wallet's own token list (null in the extension's
 * approval window, which may run before the passphrase). Anything not understood is labelled as such
 * and shown raw: a call the wallet cannot explain must never look like a harmless one.
 */
export function describeOperation(cc: CallContract, net: Network, signer: string, custom: CustomTokens | null = null): string {
  const token = findToken(allTokens(net.name, custom), cc.contract_id);
  const symbol = token?.symbol;
  if (token && cc.entry_point === TOKEN_ENTRY.transfer) {
    const xfer = strictTransfer(cc.args);
    if (xfer) {
      const fromNote = xfer.from === signer ? "" : ` <span class="warn-inline">${tr("from a different account, {from},", { from: esc(xfer.from) })}</span>`;
      return tr("Send <strong class=\"mono\">{amount} {symbol}</strong>{note} to {to}", { amount: esc(formatUnits(xfer.value, token.decimals)), symbol: esc(token.symbol), note: fromNote, to: addressStrip(xfer.to, { size: "sm" }) });
    }
    return `<span class="warn-inline">${tr("Unusual {symbol} transfer encoding: the amount and recipient cannot be shown reliably.", { symbol: esc(symbol) })}</span> ${tr("Call to {contract}", { contract: addressStrip(cc.contract_id, { size: "sm" }) })}`;
  }
  let fields: Map<number, Array<bigint | Uint8Array>> | null = null;
  try {
    fields = decodeFields(utils.decodeBase64url(cc.args));
  } catch {
    fields = null;
  }
  if (token && fields && cc.entry_point === TOKEN_APPROVE) {
    // approve { owner = 1, spender = 2, value = 3 }: a standing permission for someone else to spend
    const owner = addr(fieldBytes(fields, 1)), spender = addr(fieldBytes(fields, 2)), value = fieldUint(fields, 3);
    if (owner && spender && value !== null) {
      return `<span class="warn-inline">${tr("Allow {spender} to spend up to <strong class=\"mono\">{amount} {symbol}</strong> from {owner}, any time, until revoked", { spender: addressStrip(spender, { size: "sm" }), amount: esc(formatUnits(value, token.decimals)), symbol: esc(token.symbol), owner: owner === signer ? tr("your account") : addressStrip(owner, { size: "sm" }) })}</span>`;
    }
  }
  if (token && fields && cc.entry_point === TOKEN_BURN) {
    const from = addr(fieldBytes(fields, 1)), value = fieldUint(fields, 2);
    if (from && value !== null) return `<span class="warn-inline">${tr("Burn (destroy) <strong class=\"mono\">{amount} {symbol}</strong> from {from}", { amount: esc(formatUnits(value, token.decimals)), symbol: esc(token.symbol), from: from === signer ? tr("your account") : addressStrip(from, { size: "sm" }) })}</span>`;
  }
  if (fields && cc.entry_point === NFT_ENTRY.transfer) {
    // KCS-5 transfer { from = 1, to = 2, token_id = 3 }
    const from = addr(fieldBytes(fields, 1)), to = addr(fieldBytes(fields, 2)), id = fieldBytes(fields, 3);
    if (from && to && id) return tr("Send collectible <code>{id}</code> of {contract} from {from} to {to}", { id: esc(utils.toHexString(id)), contract: addressStrip(cc.contract_id, { size: "sm" }), from: from === signer ? tr("your account") : addressStrip(from, { size: "sm" }), to: addressStrip(to, { size: "sm" }) });
  }
  return `${tr("Call contract {contract}{symbol}, entry point <code>{entry}</code>", { contract: addressStrip(cc.contract_id, { size: "sm" }), symbol: symbol ? ` (${esc(symbol)})` : "", entry: `0x${cc.entry_point.toString(16)}` })}
    <div class="fine" style="margin-top:4px"><span class="warn-inline">${tr("The wallet cannot tell what this call does.")}</span> ${rawArgs(cc.args)}</div>`;
}

/** The request as a sentence and a card: who wants what, with every operation and the header facts. */
export function describePlan(p: Plan, custom: CustomTokens | null = null): string {
  const who = p.signerAddress ? addressStrip(p.signerAddress, { size: "sm" }) : "<strong>?</strong>";
  switch (p.req.command) {
    case "getAccounts":
      return `<p>${tr("wants to <strong>see your account addresses</strong>. No signature is involved.")}</p>`;
    case "signer:signMessage":
      {
        // text is cleaned of control and bidi characters and capped, with its true length shown, so what is
        // displayed cannot differ in reading order or hide beyond the fold from what is signed
        const raw = typeof p.message === "string" ? p.message : utils.toHexString(p.message!);
        const size = typeof p.message === "string" ? new TextEncoder().encode(p.message).length : p.message!.length;
        const shown = cleanLabel(raw, 2000);
        return `<p>${tr("wants {who} to sign this message:", { who })}</p>${card(`<code class="address addr sm" style="color:var(--ink)">${esc(shown)}${raw.length > 2000 ? "…" : ""}</code><div class="fine" style="margin-top:6px">${esc(size)} ${tr("bytes")}${shown !== raw ? ` · <span class="warn-inline">${tr("hidden characters removed from this display")}</span>` : ""}</div>`)}
        <p class="fine" style="margin-top:8px">${tr("A signed message cannot be used as a transaction signature (it is made under a separate context), and no public key can be recovered from it.")}</p>`;
      }
    default: {
      const tx = p.prepared!;
      const h = tx.header!;
      const verb = p.req.command === "signer:sendTransaction" ? tr("sign and send") : p.req.command === "signer:prepareTransaction" ? tr("prepare") : tr("sign");
      const siteSetLimit = ((p.req.args?.transaction as { header?: { rc_limit?: unknown } } | undefined)?.header?.rc_limit ?? undefined) !== undefined;
      const rows = [
        stat(tr("Network"), `<strong>${esc(p.net.name)}</strong>`),
        h.payee ? stat(tr("Payee"), `<span class="mono">${esc(h.payee)}</span>`) : "",
        stat(tr("Mana limit"), `<strong>${esc(formatKoin(BigInt(h.rc_limit ?? "0"), 2))}</strong>${siteSetLimit ? "" : ` <span class="mute">${tr("(the site set no limit: all the mana the account has)")}</span>`}`),
        stat(tr("Transaction"), esc((tx.id ?? "").slice(0, 22)) + "…"),
      ].join("");
      const payerNote = h.payer !== p.signerAddress ? notice("warn", tr("Mana paid by another account: {payer}", { payer: `<span class="mono">${esc(h.payer)}</span>` })) : "";
      return `<p>${tr("wants {who} to <strong>{verb}</strong> a transaction:", { who, verb })}</p>
        ${card(`${list(tx.operations!.map((op, i) => listRow(`<span class="lbl">${tr("Operation {i} of {n}", { i: i + 1, n: tx.operations!.length })}</span>${describeOperation(op.call_contract, p.net, p.signerAddress ?? "", custom)}`)).join(""))}<div style="margin-top:8px">${rows}</div>`)}${payerNote ? `<div style="margin-top:12px">${payerNote}</div>` : ""}`;
    }
  }
}
