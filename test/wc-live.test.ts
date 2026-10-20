// Live WalletConnect round trip, wallet side (skipped unless WC_PROJECT_ID and WC_LIVE_DIR are set; run
// together with wc-live-dapp.test.ts in a second process, since one process can hold one WalletConnect
// core). This side waits for the dapp's pairing URI in WC_LIVE_DIR, pairs, approves the proposal on
// mainnet with one account through this repo's translation, answers a read and refuses a raw hash.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedNamespace, summariseProposal, translateRequest, WC_NAMESPACE } from "../src/core/walletconnect";
import { handleProvider } from "../src/core/provider-calls";

const PROJECT_ID = process.env.WC_PROJECT_ID ?? "", DIR = process.env.WC_LIVE_DIR ?? "";
const ACCOUNT = "1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const c of closers) await c().catch(() => undefined);
});

describe.skipIf(!PROJECT_ID || !DIR)("walletconnect live relay: wallet side", () => {
  it("pairs, approves on mainnet, answers koinos_getChainId and refuses koinos_signHash", async () => {
    const [{ Core }, { WalletKit }, utils] = await Promise.all([import("@walletconnect/core"), import("@reown/walletkit"), import("@walletconnect/utils")]);
    const core = new Core({ projectId: PROJECT_ID, storageOptions: { database: join(DIR, "wallet.db") } });
    const kit = await WalletKit.init({ core, metadata: { name: "Sparán (test)", description: "wallet side", url: "https://wallet.koinosproof.com", icons: [] } });
    closers.push(() => core.relayer.transportClose());
    const saw: string[] = [];
    kit.on("session_proposal", (e) => {
      void (async () => {
        const summary = summariseProposal(e.params as never, e.verifyContext.verified.validation);
        saw.push(`proposal from ${summary.origin} chains=${summary.chains.join(",")} verified=${summary.verified}`);
        const ns = approvedNamespace(summary, "mainnet", [ACCOUNT]);
        const namespaces = utils.buildApprovedNamespaces({ proposal: e.params as never, supportedNamespaces: { [WC_NAMESPACE]: ns } });
        await kit.approveSession({ id: e.id, namespaces });
      })().catch((err) => saw.push(`proposal error ${(err as Error).message}`));
    });
    kit.on("session_request", (e) => {
      void (async () => {
        const t = translateRequest(String(e.id), e.params.request.method, e.params.request.params, "https://app.koindx.com", "mainnet");
        saw.push(`request ${e.params.request.method} -> ${t.kind}`);
        const response =
          t.kind === "provider"
            ? { id: e.id, jsonrpc: "2.0" as const, result: await handleProvider(t.command, t.args) }
            : { id: e.id, jsonrpc: "2.0" as const, error: { code: 5000, message: t.kind === "refuse" ? t.reason : "approval needed" } };
        await kit.respondSessionRequest({ topic: e.topic, response });
      })().catch((err) => saw.push(`request error ${(err as Error).message}`));
    });
    const uriFile = join(DIR, "uri.txt"), doneFile = join(DIR, "dapp-done.txt");
    const deadline = Date.now() + 90_000;
    while (!existsSync(uriFile) && Date.now() < deadline) await sleep(250);
    expect(existsSync(uriFile)).toBe(true);
    await kit.pair({ uri: readFileSync(uriFile, "utf8").trim() });
    while (!existsSync(doneFile) && Date.now() < deadline) await sleep(250);
    writeFileSync(join(DIR, "wallet-log.json"), JSON.stringify(saw));
    expect(saw).toEqual([
      "proposal from https://app.koindx.com chains=mainnet verified=UNKNOWN",
      "request koinos_getChainId -> provider",
      "request koinos_signHash -> refuse",
    ]);
  }, 120_000);
});
