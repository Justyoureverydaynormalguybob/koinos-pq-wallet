// KCS-5 NFTs: the wallet's encoders and decoders against koilib's serializer fed the standard's own
// message definitions, token labels, the asset allowlist, metadata parsing, and the collection store.
import { describe, expect, it } from "vitest";
import { Serializer } from "koilib";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  Collections, IPFS_GATEWAYS, NFT_ENTRY, collectionsNamespace, decodeAddressResult, decodeTokenIds, encodeNftTransferArgs, encodeTokenIdArg, encodeTokensByOwnerArgs,
  loadMetadata, parseMetadata, resolveAssetUrl, tokenLabel,
} from "../src/core/nfts";
import type { BookStore } from "../src/core/addressbook";

// koinos/standards/kcs5.proto, the messages used here, as a protobufjs JSON descriptor with the
// koinos.btype options the real contracts carry (addresses as base58, token ids as 0x-hex)
const ADDRESS = { "(koinos.btype)": "ADDRESS" }, HEX = { "(koinos.btype)": "HEX" };
const kcs5 = {
  nested: {
    get_tokens_by_owner_arguments: { fields: { owner: { type: "bytes", id: 1, options: ADDRESS }, start: { type: "bytes", id: 2, options: HEX }, limit: { type: "int32", id: 3 }, descending: { type: "bool", id: 4 } } },
    get_tokens_by_owner_result: { fields: { values: { rule: "repeated", type: "bytes", id: 1, options: HEX } } },
    token_uri_arguments: { fields: { token_id: { type: "bytes", id: 1, options: HEX } } },
    owner_of_result: { fields: { value: { type: "bytes", id: 1, options: ADDRESS } } },
    transfer_arguments: { fields: { from: { type: "bytes", id: 1, options: ADDRESS }, to: { type: "bytes", id: 2, options: ADDRESS }, token_id: { type: "bytes", id: 3, options: HEX }, memo: { type: "string", id: 4, options: { proto3_optional: true } } } },
  },
};
const A = "1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ", B = "1sXttKzfrzH8amTpfRHX8SXT7kynjNpMX";

describe("KCS-5 messages agree with koilib's serializer", () => {
  const ser = new Serializer(kcs5);
  it("entry points are the first four bytes of sha256(name)", () => {
    expect(NFT_ENTRY.transfer).toBe(0x27f576ca); // the same as KCS-4's
    expect(NFT_ENTRY.balance_of).toBe(0x5c721497);
    expect(NFT_ENTRY.owner_of).toBe(0xed61c847);
    expect(NFT_ENTRY.get_tokens_by_owner).toBe(0xfc13eb75);
    expect(NFT_ENTRY.token_uri).toBe(0x40456c8e);
  });
  it("arguments encode to the same bytes", async () => {
    expect(bytesToHex(encodeTokensByOwnerArgs(A, 50))).toBe(bytesToHex(await ser.serialize({ owner: A, limit: 50 }, "get_tokens_by_owner_arguments")));
    expect(bytesToHex(encodeTokensByOwnerArgs(A, 5, Uint8Array.from([1, 2]), true))).toBe(bytesToHex(await ser.serialize({ owner: A, start: "0x0102", limit: 5, descending: true }, "get_tokens_by_owner_arguments")));
    expect(bytesToHex(encodeTokenIdArg("002a"))).toBe(bytesToHex(await ser.serialize({ token_id: "0x002a" }, "token_uri_arguments")));
    expect(bytesToHex(encodeNftTransferArgs(A, B, "0001"))).toBe(bytesToHex(await ser.serialize({ from: A, to: B, token_id: "0x0001" }, "transfer_arguments")));
    expect(() => encodeTokensByOwnerArgs(A, 0)).toThrow(/limit/);
  });
  it("results decode what koilib encodes", async () => {
    const ids = decodeTokenIds(await ser.serialize({ values: ["0x01", "0x00ff", "0xdeadbeef"] }, "get_tokens_by_owner_result"));
    expect(ids.map(bytesToHex)).toEqual(["01", "00ff", "deadbeef"]);
    expect(decodeTokenIds(new Uint8Array(0))).toEqual([]);
    expect(decodeAddressResult(await ser.serialize({ value: B }, "owner_of_result"))).toBe(B);
    expect(decodeAddressResult(new Uint8Array(0))).toBeNull();
  });
});

describe("labels, assets and metadata", () => {
  it("token ids read as numbers when small", () => {
    expect(tokenLabel("2a")).toBe("42");
    expect(tokenLabel("")).toBe("0");
    expect(tokenLabel("0000000000000001")).toBe("1");
    expect(tokenLabel("deadbeefdeadbeefdeadbeef")).toBe("0xdeadbe…beef");
  });
  it("only ipfs:// (through our gateway) and https on allowed hosts resolve", () => {
    expect(resolveAssetUrl("ipfs://bafyabc/1.png")).toBe(`${IPFS_GATEWAYS[0]}bafyabc/1.png`);
    expect(resolveAssetUrl("ipfs://ipfs/Qm123")).toBe(`${IPFS_GATEWAYS[0]}Qm123`);
    expect(resolveAssetUrl("https://ipfs.io/ipfs/Qm123")).toBe("https://ipfs.io/ipfs/Qm123");
    expect(resolveAssetUrl("https://gateway.ipfs.io/ipfs/Qm123")).toBe("https://gateway.ipfs.io/ipfs/Qm123");
    expect(resolveAssetUrl("https://arweave.net/abc")).toBe("https://arweave.net/abc");
    expect(resolveAssetUrl("http://ipfs.io/ipfs/Qm123")).toBeNull();
    expect(resolveAssetUrl("https://evil.example/x.png")).toBeNull();
    expect(resolveAssetUrl("javascript:alert(1)")).toBeNull();
    expect(resolveAssetUrl("")).toBeNull();
  });
  it("metadata: name, description and an allowed image; junk gives empty fields", async () => {
    expect(parseMetadata(JSON.stringify({ name: "Goat #1", description: "a goat", image: "ipfs://Qmimg" }))).toEqual({ name: "Goat #1", description: "a goat", image: `${IPFS_GATEWAYS[0]}Qmimg` });
    expect(parseMetadata(JSON.stringify({ name: 5, image: "https://evil.example/x" }))).toEqual({ name: "", description: "", image: null });
    expect(parseMetadata("not json")).toEqual({ name: "", description: "", image: null });
    expect(await loadMetadata(`data:application/json;base64,${Buffer.from(JSON.stringify({ name: "inline" })).toString("base64")}`)).toMatchObject({ name: "inline" });
    expect(await loadMetadata("https://evil.example/meta.json")).toBeNull();
    let asked = "";
    const fakeFetch = (async (u: string) => {
      asked = u;
      return new Response(JSON.stringify({ name: "fetched", image: "https://dweb.link/ipfs/Qmx" }));
    }) as unknown as typeof fetch;
    expect(await loadMetadata("ipfs://Qmmeta", fakeFetch)).toEqual({ name: "fetched", description: "", image: "https://dweb.link/ipfs/Qmx" });
    expect(asked).toBe(`${IPFS_GATEWAYS[0]}Qmmeta`);
  });
});

describe("collections added by address", () => {
  it("are kept per wallet and per network, deduplicated, removable", () => {
    const data = new Map<string, string>();
    const store: BookStore = { get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
    const ns = collectionsNamespace(new Uint8Array(32).fill(3));
    const c = new Collections(ns, store);
    const goats = { address: "1GNkfsZp9ySg314QFVZAAew1VDbjGNZrZP", name: "Koinos Garden", symbol: "GOAT", uri: "ipfs://Qmbase/" };
    c.add("mainnet", goats);
    c.add("mainnet", goats);
    expect(c.list("mainnet")).toEqual([{ ...goats, custom: true }]);
    expect(c.list("testnet")).toEqual([]);
    expect(new Collections(ns, store).list("mainnet")[0]?.name).toBe("Koinos Garden");
    expect(() => c.add("mainnet", { ...goats, address: "nope" })).toThrow(/valid/);
    c.remove("mainnet", goats.address);
    expect(c.list("mainnet")).toEqual([]);
  });
});

describe("collections found from the activity list", () => {
  it("names each unknown contract once, in order, skipping listed tokens and collections", async () => {
    const { collectionCandidates } = await import("../src/core/nfts");
    const h = [
      { contract: "1Koin", direction: "in" as const },
      { contract: "1Nft", direction: "in" as const },
      { contract: "1Nft", direction: "out" as const },
      { contract: null, direction: null },
      { contract: "1Other", direction: null },
      { contract: "1Listed", direction: "in" as const },
      { contract: "1More", direction: "out" as const },
    ];
    expect(collectionCandidates(h, ["1Koin", "1Listed"])).toEqual(["1Nft", "1More"]);
  });
});
