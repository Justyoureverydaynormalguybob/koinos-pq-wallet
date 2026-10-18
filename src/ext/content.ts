// Content script (isolated world). Two jobs:
//   1. inject inpage.js into the page so `window.kondor` exists for dapps that expect the extension
//      to provide it (dapps that bundle kondor-js themselves post the same messages anyway);
//   2. relay kondor-protocol messages: page -> extension (requests) and extension -> page (responses).
//
// Protocol (kondor-js Messenger): the page posts { id, command, to: "popup" | "background", args } to
// window; the answer is posted back as { id, result } or { id, error }. Provider calls are answered
// straight away; approval commands are answered later, when the user has decided, through a message
// from the background to this tab. Nothing else crosses.
const seen = new Set<string>();

function inject() {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inpage.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch {
    /* some pages forbid it; dapps bundling kondor-js still work through the relay */
  }
}
inject();

/** Results cross chrome messaging as JSON; a Uint8Array is carried as { __u8: base64url } and restored here. */
function revive(result: unknown): unknown {
  if (result && typeof result === "object" && typeof (result as { __u8?: unknown }).__u8 === "string") {
    const b64 = (result as { __u8: string }).__u8.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return result;
}

function reply(message: { id: string; result?: unknown; error?: string }) {
  if (message.error !== undefined) window.postMessage({ id: message.id, error: message.error }, "*");
  else window.postMessage({ id: message.id, result: revive(message.result) }, "*");
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as { id?: string; command?: string; to?: string; args?: unknown } | null;
  if (!data || typeof data !== "object" || typeof data.id !== "string" || typeof data.command !== "string") return;
  if (data.to !== "popup" && data.to !== "background") return;
  const id = data.id;
  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > 2000) seen.clear();

  chrome.runtime.sendMessage(
    { id, command: data.command, to: data.to, args: data.args ?? null, origin: window.location.origin },
    (response: { id: string; result?: unknown; error?: string; deferred?: boolean } | undefined) => {
      const err = chrome.runtime.lastError;
      if (err || !response) {
        reply({ id, error: err?.message || "no response from the wallet" });
        return;
      }
      if (response.deferred) return; // the approval window answers later
      reply(response);
    },
  );
});

// answers that arrive later (after the user approved or rejected in the wallet window)
chrome.runtime.onMessage.addListener((message: { id?: string; result?: unknown; error?: string }) => {
  if (message && typeof message.id === "string" && ("result" in message || "error" in message)) reply(message as { id: string; result?: unknown; error?: string });
});
