// What gets injected into a dapp page at document start: the relay (page <-> native bridge, the role
// content.ts plays in the extension) followed by the extension's own inpage script (window.kondor).
// Same protocol as the extension: the page posts { id, command, to, args } to its window; the relay
// forwards { id, command, args, origin } as JSON to the app; the app's answer { id, result | error }
// comes back through window.__pqDeliver and is posted to the window for kondor-js to pick up.

/** Runs before any page script. Uses whichever native bridge the platform provides. */
export const RELAY_SHIM = `(() => {
  if (window.__pqRelay) return;
  window.__pqRelay = true;
  const seen = new Set();
  const send = (obj) => {
    const json = JSON.stringify(obj);
    if (window.PqBridge && typeof window.PqBridge.postMessage === "function") window.PqBridge.postMessage(json);
    else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.PqBridge) window.webkit.messageHandlers.PqBridge.postMessage(json);
  };
  const revive = (result) => {
    if (result && typeof result === "object" && typeof result.__u8 === "string") {
      const b64 = result.__u8.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return result;
  };
  window.__pqDeliver = (json) => {
    try {
      const m = JSON.parse(json);
      if (!m || typeof m.id !== "string") return;
      if (m.error !== undefined) window.postMessage({ id: m.id, error: String(m.error) }, "*");
      else window.postMessage({ id: m.id, result: revive(m.result) }, "*");
    } catch (e) {
      /* not ours */
    }
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || typeof d !== "object" || typeof d.id !== "string" || typeof d.command !== "string") return;
    if (d.to !== "popup" && d.to !== "background") return;
    if (seen.has(d.id)) return;
    seen.add(d.id);
    if (seen.size > 2000) seen.clear();
    send({ id: d.id, command: d.command, args: d.args === undefined ? null : d.args, origin: window.location.origin });
  });
})();`;

/** The complete document-start script. The inpage bundle is built by \`npm run build:inpage\` (dist-extension/inpage.js). */
export async function buildBridgeScript(inpage?: string): Promise<string> {
  const src = inpage ?? (await import("../../dist-extension/inpage.js?raw")).default;
  return `${RELAY_SHIM}\n${src}`;
}

/** Results cross the bridge as JSON; a Uint8Array is carried as { __u8: base64url } and revived by the relay. */
export function serialiseResult(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    let bin = "";
    for (const b of v) bin += String.fromCharCode(b);
    return { __u8: btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
  }
  if (Array.isArray(v)) return v.map(serialiseResult);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = serialiseResult(x);
    return out;
  }
  return v;
}
