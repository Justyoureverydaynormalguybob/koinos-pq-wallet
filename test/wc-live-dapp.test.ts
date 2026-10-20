// Live WalletConnect round trip, dapp side: a SignClient proposing a session exactly as the Koinos
// WalletConnect SDK does, writing its pairing URI for the wallet-side process, then checking the
// approved namespace, a read answered by the wallet and a raw hash refused with the wallet's reason.
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WC_METHODS } from "../src/core/walletconnect";

const PROJECT_ID = process.env.WC_PROJECT_ID ?? "", DIR = process.env.WC_LIVE_DIR ?? "";
const MAIN = "koinos:EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3e";
const ACCOUNT = "1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ";
const closers: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const c of closers) await c().catch(() => undefined);
});

describe.skipIf(!PROJECT_ID || !DIR)("walletconnect live relay: dapp side", () => {
  it("gets the wallet's account on mainnet, a chain id, and a refusal for a raw hash", async () => {
    const { SignClient } = await import("@walletconnect/sign-client");
    const dapp = await SignClient.init({ projectId: PROJECT_ID, storageOptions: { database: join(DIR, "dapp.db") }, metadata: { name: "Live test dapp", description: "sdk shape", url: "https://app.koindx.com", icons: [] } });
    closers.push(() => dapp.core.relayer.transportClose());
    const { uri, approval } = await dapp.connect({ requiredNamespaces: { koinos: { chains: [MAIN], methods: WC_METHODS, events: [] } } });
    expect(uri).toMatch(/^wc:[0-9a-f]{64}@2\?/);
    writeFileSync(join(DIR, "uri.txt"), uri!);
    try {
      const session = await approval();
      expect(session.namespaces.koinos!.accounts).toEqual([`${MAIN}:${ACCOUNT}`]);
      expect(session.namespaces.koinos!.methods).toEqual(WC_METHODS);
      const chainId = await dapp.request<string>({ topic: session.topic, chainId: MAIN, request: { method: "koinos_getChainId", params: {} } });
      expect(chainId).toBe("EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==");
      await expect(dapp.request({ topic: session.topic, chainId: MAIN, request: { method: "koinos_signHash", params: { address: ACCOUNT, hash: "AA==" } } })).rejects.toThrow(/Raw hash signing/);
      await dapp.disconnect({ topic: session.topic, reason: { code: 6000, message: "test over" } });
    } finally {
      writeFileSync(join(DIR, "dapp-done.txt"), "done");
    }
  }, 120_000);
});
