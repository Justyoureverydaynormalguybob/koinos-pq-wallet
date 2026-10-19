// How a dapp request is shown before approval: the same words in the extension window and the in-app
// sheet. Everything rendered goes through esc()/addressStrip().
import { formatKoin, TOKEN_ENTRY, type Network } from "koinos-pq-core";
import { utils } from "koilib";
import { allTokens, findToken, formatUnits } from "../core/tokens";
import { strictTransfer, type CallContract, type Plan } from "../core/approval";
import { addressStrip, card, esc, list, listRow, notice, stat } from "./components";
import { t as tr } from "../i18n";

export function describeOperation(cc: CallContract, net: Network, signer: string): string {
  // the curated list only: an approval may run before the passphrase, so a wallet's own additions are not known here
  const token = findToken(allTokens(net.name, null), cc.contract_id);
  const symbol = token?.symbol;
  if (token && cc.entry_point === TOKEN_ENTRY.transfer) {
    const xfer = strictTransfer(cc.args);
    if (xfer) {
      const fromNote = xfer.from === signer ? "" : ` <span class="warn-inline">${tr("from a different account, {from},", { from: esc(xfer.from) })}</span>`;
      return tr("Send <strong class=\"mono\">{amount} {symbol}</strong>{note} to {to}", { amount: esc(formatUnits(xfer.value, token.decimals)), symbol: esc(token.symbol), note: fromNote, to: addressStrip(xfer.to, { size: "sm" }) });
    }
    return `<span class="warn-inline">${tr("Unusual {symbol} transfer encoding: the amount and recipient cannot be shown reliably.", { symbol: esc(symbol) })}</span> ${tr("Call to {contract}", { contract: addressStrip(cc.contract_id, { size: "sm" }) })}`;
  }
  return tr("Call contract {contract}{symbol}, entry point <code>{entry}</code>", { contract: addressStrip(cc.contract_id, { size: "sm" }), symbol: symbol ? ` (${esc(symbol)})` : "", entry: `0x${cc.entry_point.toString(16)}` });
}

/** The request as a sentence and a card: who wants what, with every operation and the header facts. */
export function describePlan(p: Plan): string {
  const who = p.signerAddress ? addressStrip(p.signerAddress, { size: "sm" }) : "<strong>?</strong>";
  switch (p.req.command) {
    case "getAccounts":
      return `<p>${tr("wants to <strong>see your account addresses</strong>. No signature is involved.")}</p>`;
    case "signer:signMessage":
      return `<p>${tr("wants {who} to sign this message:", { who })}</p>${card(`<code class="address addr sm" style="color:var(--ink)">${esc(typeof p.message === "string" ? p.message : utils.toHexString(p.message!))}</code>`)}
        <p class="fine" style="margin-top:8px">${tr("A signed message cannot be used as a transaction signature (it is made under a separate context), and no public key can be recovered from it.")}</p>`;
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
        ${card(`${list(tx.operations!.map((op, i) => listRow(`<span class="lbl">${tr("Operation {i} of {n}", { i: i + 1, n: tx.operations!.length })}</span>${describeOperation(op.call_contract, p.net, p.signerAddress ?? "")}`)).join(""))}<div style="margin-top:8px">${rows}</div>`)}${payerNote ? `<div style="margin-top:12px">${payerNote}</div>` : ""}`;
    }
  }
}
