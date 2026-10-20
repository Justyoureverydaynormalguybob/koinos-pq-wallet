import { generateKeyPair, signJWT } from "@walletconnect/relay-auth";
import WebSocket from "ws";
const projectId = process.argv[2];
const origins = ["https://wallet.koinosproof.com", "https://localhost", "capacitor://localhost", "https://evil.example", null];
for (const origin of origins) {
  const kp = generateKeyPair();
  const jwt = await signJWT("relay.walletconnect.org", "wss://relay.walletconnect.org", 3600, kp);
  const url = `wss://relay.walletconnect.org/?projectId=${projectId}&auth=${jwt}&ua=wc-2%2Fjs-2.25.0%2Fnode`;
  const r = await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: origin ? { Origin: origin } : {} });
    const t = setTimeout(() => { ws.terminate(); resolve("timeout"); }, 10000);
    ws.on("open", () => { clearTimeout(t); ws.close(); resolve("open"); });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(t); let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve(`${res.statusCode} ${body.slice(0, 120)}`)); });
    ws.on("error", (e) => { clearTimeout(t); resolve(`error ${e.message}`); });
  });
  console.log(`${origin ?? "(no origin)"} -> ${r}`);
}
