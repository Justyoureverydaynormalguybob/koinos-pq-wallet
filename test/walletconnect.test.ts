// WalletConnect translation: the SDK's methods become the wallet's own requests, refusals stay refusals,
// proposals are summarised and approved only on the wallet's network with its own accounts.
import { describe, expect, it } from "vitest";
import { approvedNamespace, networkForChain, summariseProposal, translateRequest, translateResult, wcChainFor, WC_CHAINS, WC_METHODS } from "../src/core/walletconnect";

const ORIGIN = "https://app.koindx.com";
const MAIN = "koinos:EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3e";
type Proposal = Parameters<typeof summariseProposal>[0];
const proposal = (chains: string[], methods = WC_METHODS, optional: string[] = []): Proposal => ({
  proposer: { metadata: { name: "KoinDX", url: `${ORIGIN}/swap` } },
  requiredNamespaces: { koinos: { chains, methods } },
  optionalNamespaces: optional.length ? { koinos: { chains: optional, methods } } : {},
});

describe("walletconnect translation", () => {
  it("maps signing methods to approvals with the SDK's parameter names, reads to provider calls, and refuses what the wallet refuses", () => {
    const sign = translateRequest("7", "koinos_signTransaction", { address: "1abc", transaction: { header: {} }, options: { abis: {} } }, ORIGIN, "mainnet");
    expect(sign).toMatchObject({ kind: "approval", req: { id: "7", command: "signer:signTransaction", origin: ORIGIN, args: { signerAddress: "1abc", transaction: { header: {} } } } });
    const send = translateRequest("8", "koinos_signAndSendTransaction", { address: "1abc", transaction: {}, options: { broadcast: false } }, ORIGIN, "mainnet");
    expect(send).toMatchObject({ kind: "approval", req: { command: "signer:sendTransaction", args: { optsSend: { broadcast: false } } } });
    expect(translateRequest("9", "koinos_signMessage", { address: "1abc", message: "hi" }, ORIGIN, "mainnet")).toMatchObject({ kind: "approval", req: { command: "signer:signMessage", args: { message: "hi" } } });
    expect(translateRequest("1", "koinos_signHash", { address: "1abc", hash: "AA==" }, ORIGIN, "mainnet")).toMatchObject({ kind: "refuse", reason: /Raw hash signing/ });
    expect(translateRequest("2", "koinos_submitBlock", {}, ORIGIN, "mainnet")).toMatchObject({ kind: "refuse" });
    expect(translateRequest("3", "koinos_getNonce", { address: "1abc" }, ORIGIN, "testnet")).toEqual({ kind: "provider", command: "provider:getNonce", args: { account: "1abc", network: "testnet" } });
    expect(translateRequest("4", "koinos_waitForTransaction", { transactionId: "0x1", type: "byBlock", timeout: 5 }, ORIGIN, "mainnet")).toMatchObject({ kind: "provider", command: "provider:wait", args: { txId: "0x1", type: "byBlock", timeout: 5 } });
    expect(translateRequest("5", "koinos_readContract", { _: "", operation: { contract_id: "1x" } }, ORIGIN, "mainnet")).toMatchObject({ kind: "provider", command: "provider:readContract", args: { operation: { contract_id: "1x" } } });
    expect(translateRequest("6", "koinos_JsonRpcCall", { method: "chain.get_head_info", params: {} }, ORIGIN, "mainnet")).toMatchObject({ kind: "provider", command: "provider:call" });
    expect(translateRequest("0", "koinos_somethingElse", {}, ORIGIN, "mainnet")).toMatchObject({ kind: "refuse" });
    // results: a signature goes back as standard base64 (koilib decodeBase64), everything else untouched
    expect(translateResult("koinos_signMessage", "-_8")).toBe("+/8=");
    expect(translateResult("koinos_signTransaction", { id: "0x1" })).toEqual({ id: "0x1" });
  });

  it("summarises a proposal and approves it only on the wallet's own network with its accounts", () => {
    const s = summariseProposal(proposal([MAIN]), "VALID");
    expect(s).toMatchObject({ name: "KoinDX", origin: ORIGIN, chains: ["mainnet"], requiredChains: ["mainnet"], verified: "VALID" });
    expect(approvedNamespace(s, "mainnet", ["1abc", "1def"])).toEqual({ chains: [MAIN], accounts: [`${MAIN}:1abc`, `${MAIN}:1def`], methods: WC_METHODS, events: [] });
    expect(() => approvedNamespace(s, "testnet", ["1abc"])).toThrow(/requires mainnet/);
    expect(() => approvedNamespace(s, "mainnet", [])).toThrow(/no account/);
    // the SDK's (pre-reset) Harbinger id is this wallet's testnet; optional chains are offered, not required
    const both = summariseProposal(proposal([], WC_METHODS, Object.keys(WC_CHAINS)), "UNKNOWN");
    expect(both.chains.sort()).toEqual(["mainnet", "testnet"]);
    expect(both.requiredChains).toEqual([]);
    expect(approvedNamespace(both, "testnet", ["1abc"]).chains).toEqual([wcChainFor("testnet")]);
    expect(networkForChain(MAIN, "mainnet")).toBe("mainnet");
    expect(networkForChain(MAIN, "testnet")).toBeNull();
    // refusals before any sheet: http dapps, other namespaces, methods the wallet has never heard of
    expect(() => summariseProposal({ ...proposal([MAIN]), proposer: { metadata: { name: "x", url: "http://evil.example" } } }, "VALID")).toThrow(/https/);
    expect(() => summariseProposal({ ...proposal([MAIN]), requiredNamespaces: { koinos: { chains: [MAIN], methods: WC_METHODS }, eip155: { chains: ["eip155:1"], methods: [] } } }, "VALID")).toThrow(/eip155/);
    expect(() => summariseProposal(proposal([MAIN], ["koinos_mintEverything"]), "VALID")).toThrow(/does not know/);
  });
});
