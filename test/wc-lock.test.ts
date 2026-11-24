// @vitest-environment jsdom
// WalletConnect sessions never outlive an unlocked wallet. The client keeps its records unencrypted
// (session topics and keys, the dapps' names, the account addresses shared with them), so on lock every
// session and pairing is ended and the records are removed, and at start anything left over goes too.
// Otherwise the storage at rest names a wallet's addresses, also to someone shown only the decoy.
import { describe, expect, it } from "vitest";
import { WC_DB, WcBridge, wipeWcStorage } from "../src/ui/wc-bridge";

/** A stand-in for the browser's IndexedDB holding one database with one store. */
function fakeIdb(o: { exists: boolean; records?: Record<string, string> }) {
  const records = new Map(Object.entries(o.records ?? {}));
  const opened: string[] = [];
  const idb = {
    databases: async () => (o.exists ? [{ name: WC_DB }, { name: "something-else" }] : [{ name: "something-else" }]),
    open(name: string) {
      opened.push(name);
      const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: ["keyvaluestorage"],
          close() {},
          transaction() {
            const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => { clear: () => void } } = {
              objectStore: () => ({ clear: () => records.clear() }),
            };
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
          },
        };
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  return { idb, records, opened };
}
const withIdb = async (idb: unknown, fn: () => Promise<void>) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: idb });
  try {
    await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "indexedDB", had);
    else delete (globalThis as { indexedDB?: unknown }).indexedDB;
  }
};

describe("WalletConnect leaves nothing at rest", () => {
  it("wipes the client's records and its local storage entries, and nothing else", async () => {
    localStorage.clear();
    localStorage.setItem("wc@2:client:0.3//session", '[{"topic":"abc","namespaces":{"koinos":{"accounts":["koinos:x:1G2U"]}}}]');
    localStorage.setItem("WALLETCONNECT_DEEPLINK_CHOICE", "x");
    localStorage.setItem("koinos-pq-wallet/vault", "the wallet itself");
    const f = fakeIdb({ exists: true, records: { "wc@2:client:0.3//session": "addresses and keys", "wc@2:core:0.3//keychain": "keys" } });
    await withIdb(f.idb, wipeWcStorage);
    expect(f.records.size).toBe(0);
    expect(f.opened).toEqual([WC_DB]);
    expect(Object.keys(localStorage)).toEqual(["koinos-pq-wallet/vault"]);
  });

  it("does not open (and so create) the database when the client never made one", async () => {
    const f = fakeIdb({ exists: false });
    await withIdb(f.idb, wipeWcStorage);
    expect(f.opened).toEqual([]);
    await withIdb(undefined, wipeWcStorage); // no IndexedDB at all: nothing to do, no throw
  });

  it("on lock: every session and pairing is ended, the records are wiped, and the next start waits for that", async () => {
    const order: string[] = [];
    const f = fakeIdb({ exists: true, records: { session: "x" } });
    const kit = {
      getActiveSessions: () => ({ a: { topic: "s1" }, b: { topic: "s2" } }),
      disconnectSession: async (o: { topic: string }) => void order.push("end " + o.topic),
      core: {
        pairing: { getPairings: () => [{ topic: "p1" }], disconnect: async (o: { topic: string }) => void order.push("unpair " + o.topic) },
        relayer: { transportClose: async () => void order.push("relay closed") },
      },
    };
    const bridge = new WcBridge();
    const inner = bridge as unknown as { kit: unknown; utils: unknown; ending: Promise<void> | null };
    inner.kit = kit;
    inner.utils = { getSdkError: () => ({ code: 6000, message: "User disconnected." }) };
    await withIdb(f.idb, async () => {
      const ending = bridge.endAll();
      expect(inner.kit).toBeNull(); // nothing more is served through the old client, at once
      expect(bridge.endAll()).toBe(ending); // a second lock joins the first tidy-up
      await ending;
    });
    expect(order).toEqual(["end s1", "end s2", "unpair p1"]); // the relay connection itself is left to the client
    expect(f.records.size).toBe(0);
    expect(inner.ending).toBeNull();
    expect(await bridge.sessions()).toEqual([]);
  });

  it("a bridge that never started still wipes what an earlier run left", async () => {
    const f = fakeIdb({ exists: true, records: { session: "from before" } });
    await withIdb(f.idb, () => new WcBridge().endAll());
    expect(f.records.size).toBe(0);
  });
});
