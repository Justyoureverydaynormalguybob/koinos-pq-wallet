// The mana limit of a dapp's transaction (0.19.5). KoinDX caps a swap at 1 KOIN of mana, which no swap
// fits in, and a post-quantum signature check costs more than that by itself: the node answered
// "insufficient rc", the wallet showed that raw, and the site was left waiting for an answer.
// Now the wallet sets the limit of a transaction its own account pays for: after approval the transaction
// is tried on the node without being sent on, and the limit becomes what it used plus a margin.
// The node is a small HTTP server in this process (koilib fetches through node-fetch, which no stub reaches).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { utils } from "koilib";
import { NETWORKS, TOKEN_ENTRY, concat, deriveKeys, fieldBytes, fieldVarint, verifyEntry, type Network } from "koinos-pq-core";
import { executePlan, explainFailure, fitLimit, planRequest, type DappRequest } from "../src/core/approval";
import { describePlan } from "../src/ui/approval-view";

const DEVNET_ID = Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.alloc(32, 7)]).toString("base64url") + "==";
const keys = deriveKeys(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ME = keys.address;
const OTHER = "1sXttKzfrzH8amTpfRHX8SXT7kynjNpMX";
const KOIN = NETWORKS.devnet!.koin;
const K = 100_000_000n; // one KOIN of mana

type Sent = { broadcast: boolean; limit: bigint; id: string; signatures: string[] };
/** what the fake node says; each test sets what it needs */
const node = {
  mana: 20n * K,
  /** what a trial (broadcast false) answers: mana used, or the chain's refusal */
  trial: { used: 620_000_000n } as { used: bigint } | { refuse: string } | { reverted: string } | { down: true },
  /** what the real send answers */
  send: null as null | { refuse: string },
  sent: [] as Sent[],
};
const nonceOf = (n: number) => utils.encodeBase64url(fieldVarint(5, BigInt(n)));
let server: Server;
let net: Network;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { id: number; method: string; params: { broadcast?: boolean; transaction?: { id: string; header: { rc_limit: string }; signatures: string[] } } };
      res.setHeader("content-type", "application/json");
      const ok = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
      const refuse = (message: string) => res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32603, message, data: JSON.stringify({ code: 1, logs: [] }) } }));
      if (r.method === "chain.submit_transaction") {
        const t = r.params.transaction!;
        const broadcast = r.params.broadcast !== false;
        node.sent.push({ broadcast, limit: BigInt(t.header.rc_limit), id: t.id, signatures: t.signatures });
        if (!broadcast) {
          const a = node.trial;
          if ("down" in a) {
            res.statusCode = 502;
            return res.end("bad gateway");
          }
          if ("refuse" in a) return refuse(a.refuse);
          if ("reverted" in a) return ok({ receipt: { id: t.id, rc_used: "1000", reverted: true, logs: [a.reverted] } });
          // the chain's own rule: a transaction that needs more than its limit is refused
          if (a.used > BigInt(t.header.rc_limit)) return refuse("insufficient rc");
          return ok({ receipt: { id: t.id, rc_limit: t.header.rc_limit, rc_used: a.used.toString() } });
        }
        if (node.send) return refuse(node.send.refuse);
        return ok({ receipt: { id: t.id, rc_limit: t.header.rc_limit, rc_used: "1" } });
      }
      ok(
        r.method === "chain.get_chain_id" ? { chain_id: DEVNET_ID }
        : r.method === "chain.get_account_nonce" ? { nonce: nonceOf(4) }
        : r.method === "chain.get_account_rc" ? { rc: node.mana.toString() }
        : r.method === "chain.get_head_info" ? { head_topology: { height: "9" } }
        : r.method === "chain.read_contract" ? { result: "" }
        : {},
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  net = { ...NETWORKS.devnet!, rpc: [`http://127.0.0.1:${(server.address() as { port: number }).port}/`] };
});
afterAll(() => void server.close());
beforeEach(() => {
  node.mana = 20n * K;
  node.trial = { used: 620_000_000n };
  node.send = null;
  node.sent = [];
});

const transferOp = () => ({
  call_contract: { contract_id: KOIN, entry_point: TOKEN_ENTRY.transfer as number, args: utils.encodeBase64url(concat([fieldBytes(1, utils.decodeBase58(ME)), fieldBytes(2, utils.decodeBase58(OTHER)), fieldVarint(3, 100_000_000n)])) },
});
/** the way KoinDX asks: its own limit of 1 KOIN of mana, this account as payer */
const ask = (command: string, header: Record<string, unknown> = { rc_limit: K.toString(), payer: ME }, extra: Record<string, unknown> = {}): DappRequest => ({
  id: "r1",
  command,
  args: { signerAddress: ME, transaction: { header, operations: [transferOp()] }, ...extra },
  origin: "https://app.koindx.com",
});
const signedBy = (s: Sent | { id: string; signatures: string[] }) => verifyEntry(utils.decodeBase64url(s.signatures[s.signatures.length - 1]!), s.id, keys.publicKey, "native");

describe("the limit a transaction is sent with", () => {
  it("is a quarter more than the trial used plus half a KOIN, never under the site's figure, never over the ceiling", () => {
    expect(fitLimit(620_000_000n, K, 20n * K)).toBe(825_000_000n);
    expect(fitLimit(620_000_000n, null, 20n * K)).toBe(825_000_000n);
    expect(fitLimit(300_000_000n, 15n * K, 20n * K)).toBe(15n * K); // the site asked for more than it needs: kept
    expect(fitLimit(620_000_000n, K, 7n * K)).toBe(7n * K); // the account has little more than it needs
    expect(fitLimit(0n, null, 20n * K)).toBe(K / 2n);
  });
});

describe("a swap from KoinDX, whose own limit is 1 KOIN of mana", () => {
  it("is tried first, then sent with what it used plus a margin; the sheet said so", async () => {
    const p = await planRequest(ask("signer:sendTransaction"), net);
    expect(p.mana).toEqual({ site: K, avail: 20n * K });
    expect(p.prepared?.header?.rc_limit).toBe((20n * K).toString());
    const sheet = describePlan(p);
    expect(sheet).toMatch(/Mana limit[\s\S]*at most 20/);
    expect(sheet).toMatch(/the site asked for 1[\s\S]*tries the transaction first/);
    expect(sheet).not.toMatch(/0x1220/); // no id on the sheet: it is only known once the limit is

    const steps: string[] = [];
    const out = await executePlan(p, keys, [], (s) => steps.push(s));
    if ("error" in out) throw new Error(out.status ?? out.error);
    expect(steps).toEqual(["Signing…", "Checking what it costs…", "Signing…", "Sending…"]);
    expect(node.sent.map((s) => [s.broadcast, s.limit])).toEqual([
      [false, 20n * K], // the trial: the most it may use, not sent on
      [true, 825_000_000n], // the real one
    ]);
    expect(node.sent.every(signedBy)).toBe(true);
    expect(node.sent[0]!.id).not.toBe(node.sent[1]!.id);
    const { transaction } = out.result as { transaction: { id: string; header: { rc_limit: string }; signatures: string[] } };
    expect(transaction.header.rc_limit).toBe("825000000");
    expect(transaction.id).toBe(node.sent[1]!.id);
    expect(transaction.signatures).toHaveLength(1); // the trial's signature is not on the one that was sent
  });

  it("that needs more mana than the account has is not sent, and both the user and the site are told", async () => {
    node.mana = 4n * K; // a post-quantum swap needs about 6
    const p = await planRequest(ask("signer:sendTransaction"), net);
    const out = await executePlan(p, keys, []);
    expect(out).toEqual({ error: "insufficient rc", status: expect.stringMatching(/Not sent: it needs more mana than this account has now \(4\.00\)/) });
    expect(node.sent.map((s) => s.broadcast)).toEqual([false]); // only the trial
  });

  it("that the chain would refuse or revert is not sent either, with the chain's reason", async () => {
    node.trial = { refuse: "account 'x' has insufficient balance" };
    let out = await executePlan(await planRequest(ask("signer:sendTransaction"), net), keys, []);
    expect(out).toEqual({ error: "account 'x' has insufficient balance", status: "Not sent: the chain would refuse it: account 'x' has insufficient balance" });
    node.trial = { reverted: "slippage" };
    out = await executePlan(await planRequest(ask("signer:sendTransaction"), net), keys, []);
    expect("error" in out && out.status).toMatch(/Not sent: the chain would refuse it: it would be reverted: slippage/);
    expect(node.sent.every((s) => !s.broadcast)).toBe(true);
  });

  it("is not sent when the node gives no answer to the trial", async () => {
    node.trial = { down: true };
    const out = await executePlan(await planRequest(ask("signer:sendTransaction"), net), keys, []);
    expect("error" in out && out.error).toBe("no answer from the node");
    expect("error" in out && out.status).toMatch(/Nothing was sent/);
    expect(node.sent.some((s) => s.broadcast)).toBe(false);
  });

  it("uses no more than the account has by the time it is approved", async () => {
    const p = await planRequest(ask("signer:sendTransaction"), net);
    node.mana = 7n * K; // mana went elsewhere while the sheet was open
    const out = await executePlan(p, keys, []);
    if ("error" in out) throw new Error(out.status ?? out.error);
    expect(node.sent.map((s) => s.limit)).toEqual([7n * K, 7n * K]); // 8.25 wanted, 7 is all there is
  });

  it("a failed send is an answer, not an exception: the site stops waiting", async () => {
    node.send = { refuse: "insufficient pending account resources" };
    const out = await executePlan(await planRequest(ask("signer:sendTransaction"), net), keys, []);
    expect(out).toEqual({ error: "insufficient pending account resources", status: expect.stringMatching(/earlier transaction of this account is still waiting/) });
  });

  it("an account with no mana is told so on the sheet, before anything is signed", async () => {
    node.mana = 0n;
    await expect(planRequest(ask("signer:sendTransaction"), net)).rejects.toThrow(/has no mana/);
  });
});

describe("what the wallet leaves alone", () => {
  it("a transaction that already carries a signature: a changed limit would break it", async () => {
    const req = ask("signer:sendTransaction");
    (req.args!.transaction as { signatures?: string[] }).signatures = [utils.encodeBase64url(new Uint8Array(65).fill(9))];
    const p = await planRequest(req, net);
    expect(p.mana).toBeUndefined();
    expect(p.prepared?.header?.rc_limit).toBe(K.toString());
    expect(describePlan(p)).toMatch(/Mana limit[\s\S]*<strong>1<\/strong>|Mana limit[\s\S]*<strong>1\.00<\/strong>/);
    await executePlan(p, keys, []);
    expect(node.sent.map((s) => [s.broadcast, s.limit])).toEqual([[true, K]]);
  });

  it("a transaction another account pays for", async () => {
    const p = await planRequest(ask("signer:sendTransaction", { rc_limit: K.toString(), payer: OTHER, payee: ME }), net);
    expect(p.mana).toBeUndefined();
    expect(p.prepared?.header?.rc_limit).toBe(K.toString());
  });

  it("a request that is itself only a dry run, and one that only prepares", async () => {
    const dry = await planRequest(ask("signer:sendTransaction", undefined, { optsSend: { broadcast: false } }), net);
    expect(dry.mana).toBeUndefined();
    await executePlan(dry, keys, []);
    expect(node.sent.map((s) => [s.broadcast, s.limit])).toEqual([[false, K]]);
    expect((await planRequest(ask("signer:prepareTransaction"), net)).mana).toBeUndefined();
  });
});

describe("a transaction the site sends itself (sign only)", () => {
  it("comes back with the fitted limit and one signature over it", async () => {
    const out = await executePlan(await planRequest(ask("signer:signTransaction"), net), keys, []);
    if ("error" in out) throw new Error(out.status ?? out.error);
    const tx = out.result as { id: string; header: { rc_limit: string }; signatures: string[] };
    expect(tx.header.rc_limit).toBe("825000000");
    expect(tx.signatures).toHaveLength(1);
    expect(signedBy(tx)).toBe(true);
    expect(node.sent.map((s) => s.broadcast)).toEqual([false]);
  });

  it("is signed as the site asked when the trial fails: others may still have to sign it", async () => {
    node.trial = { refuse: "account has not authorized transaction" };
    const out = await executePlan(await planRequest(ask("signer:signTransaction"), net), keys, []);
    if ("error" in out) throw new Error(out.status ?? out.error);
    const tx = out.result as { id: string; header: { rc_limit: string }; signatures: string[] };
    expect(tx.header.rc_limit).toBe(K.toString());
    expect(signedBy(tx)).toBe(true);
  });
});

describe("a failure in words", () => {
  it("says what happened and whether anything was sent", () => {
    const chain = (m: string) => new Error(JSON.stringify({ error: m, code: 1, logs: [] }));
    expect(explainFailure(chain("insufficient rc"), 825_000_000n, false).status).toMatch(/used more mana than its limit of 8\.25/);
    expect(explainFailure(chain("payer does not have the rc to cover transaction rc limit"), K, true).status).toMatch(/mana fell/);
    expect(explainFailure(new Error("fetch failed"), K, false)).toEqual({ error: "no clear answer from the node", status: expect.stringMatching(/may still go through/) });
  });
});
