// Runs in the page's own JavaScript world. Provides `window.kondor` with the same surface as the
// Kondor extension (kondor-js, MIT, Julián González): getAccounts, getSigner, getProvider, provider.
// All of it talks to the extension by posting messages to the window; content.ts relays them.
import { getAccounts, getProvider, getSigner, KondorSigner, provider } from "kondor-js";

declare global {
  interface Window {
    kondor?: unknown;
    koinosPq?: { version: string; postQuantum: true };
  }
}

if (!window.kondor) {
  window.kondor = { provider, getProvider, KondorSigner, getSigner, getAccounts };
}
window.koinosPq = { version: "0.2.1", postQuantum: true };
