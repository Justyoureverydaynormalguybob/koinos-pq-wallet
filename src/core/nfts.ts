// KCS-5 NFT collections (koinos/koinos-proto koinos/standards/kcs5.proto): reads per collection with
// the wallet's own protobuf-lite encoders, a per-wallet list of collections added by address, token
// metadata from token_uri with an allowlist of IPFS gateways, and the transfer arguments for sending
// a token through the one signing path (Chain.sendCall). Entry points are the first four bytes of
// sha256(method name), as for KCS-4.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { utils } from "koilib";
import { concat, decodeFields, decodeStringResult, fieldBytes, fieldVarint, type Chain } from "koinos-pq-core";
import { isValidAddress, type BookStore } from "./addressbook";

const entry = (name: string): number => {
  const h = sha256(utf8ToBytes(name));
  return ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
};
export const NFT_ENTRY = {
  name: entry("name"),
  symbol: entry("symbol"),
  uri: entry("uri"),
  total_supply: entry("total_supply"),
  balance_of: entry("balance_of"),
  owner_of: entry("owner_of"),
  token_uri: entry("token_uri"),
  metadata_of: entry("metadata_of"),
  get_tokens_by_owner: entry("get_tokens_by_owner"),
  transfer: entry("transfer"),
} as const;

export interface Collection {
  address: string;
  name: string;
  symbol: string;
  /** the collection's base uri (may be "") */
  uri: string;
  custom?: boolean;
}

export interface NftToken {
  collection: string;
  /** the token id as hex (KCS-5 token ids are bytes) */
  idHex: string;
  /** a readable form: the id as a decimal number when it is small, else the hex */
  label: string;
}

export interface NftMetadata {
  name: string;
  description: string;
  /** an http(s) URL the app may load, or null when the metadata points nowhere allowed */
  image: string | null;
}

// ---- protobuf-lite for the KCS-5 messages used here ----
/** get_tokens_by_owner_arguments { bytes owner = 1; bytes start = 2; int32 limit = 3; bool descending = 4; } */
export function encodeTokensByOwnerArgs(owner: string, limit: number, start: Uint8Array = new Uint8Array(0), descending = false): Uint8Array {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error("bad limit");
  return concat([fieldBytes(1, utils.decodeBase58(owner)), fieldBytes(2, start), fieldVarint(3, limit), descending ? fieldVarint(4, 1) : new Uint8Array(0)]);
}
/** get_tokens_by_owner_result { repeated bytes values = 1; } */
export function decodeTokenIds(b: Uint8Array): Uint8Array[] {
  return (decodeFields(b).get(1) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map((v) => Uint8Array.from(v));
}
/** token_uri_arguments / owner_of_arguments / metadata_of_arguments { bytes token_id = 1; } */
export const encodeTokenIdArg = (idHex: string): Uint8Array => fieldBytes(1, hexToBytes(idHex));
/** owner_of_result { bytes value = 1; } -> address or null */
export function decodeAddressResult(b: Uint8Array): string | null {
  const v = decodeFields(b).get(1)?.[0];
  return v instanceof Uint8Array && v.length ? utils.encodeBase58(v) : null;
}
/** transfer_arguments { bytes from = 1 (deprecated); bytes to = 2; bytes token_id = 3; optional string memo = 4; } */
export function encodeNftTransferArgs(from: string, to: string, idHex: string): Uint8Array {
  return concat([fieldBytes(1, utils.decodeBase58(from)), fieldBytes(2, utils.decodeBase58(to)), fieldBytes(3, hexToBytes(idHex))]);
}

/** A readable token id: small ids as decimals ("42"), anything else as "0x…". */
export function tokenLabel(idHex: string): string {
  if (idHex.length <= 16 && /^[0-9a-f]*$/.test(idHex)) {
    const n = BigInt(`0x${idHex || "0"}`);
    if (n < 1_000_000_000_000n) return n.toString();
  }
  return `0x${idHex.length > 12 ? `${idHex.slice(0, 6)}…${idHex.slice(-4)}` : idHex}`;
}

// ---- reads ----
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** name, symbol and base uri; throws when the contract does not answer like a KCS-5 collection. */
export async function collectionInfo(chain: Chain, address: string): Promise<Omit<Collection, "address">> {
  const name = decodeStringResult(await chain.read(address, NFT_ENTRY.name));
  const symbol = decodeStringResult(await chain.read(address, NFT_ENTRY.symbol));
  let uri = "";
  try {
    uri = decodeStringResult(await chain.read(address, NFT_ENTRY.uri));
  } catch {
    /* uri is optional in older contracts */
  }
  if (!name && !symbol) throw new Error("this contract does not answer like an NFT collection");
  return { name, symbol, uri };
}

/** The tokens `owner` holds in a collection, up to `limit`, as hex ids. */
export async function tokensOf(chain: Chain, collection: string, owner: string, limit = 50): Promise<NftToken[]> {
  const ids = decodeTokenIds(await chain.read(collection, NFT_ENTRY.get_tokens_by_owner, encodeTokensByOwnerArgs(owner, limit)));
  return ids.map((id) => {
    const idHex = bytesToHex(id);
    return { collection, idHex, label: tokenLabel(idHex) };
  });
}

/** The token_uri of a token (often an ipfs:// or https:// link to JSON), or "" when the contract has none. */
export async function tokenUri(chain: Chain, collection: string, idHex: string): Promise<string> {
  try {
    return decodeStringResult(await chain.read(collection, NFT_ENTRY.token_uri, encodeTokenIdArg(idHex)));
  } catch {
    return "";
  }
}

/** metadata_of: JSON kept on chain by some contracts (KCS-5 optional), or "". */
export async function metadataOf(chain: Chain, collection: string, idHex: string): Promise<string> {
  try {
    return decodeStringResult(await chain.read(collection, NFT_ENTRY.metadata_of, encodeTokenIdArg(idHex)));
  } catch {
    return "";
  }
}

export async function ownerOf(chain: Chain, collection: string, idHex: string): Promise<string | null> {
  return decodeAddressResult(await chain.read(collection, NFT_ENTRY.owner_of, encodeTokenIdArg(idHex)));
}

// ---- metadata and images: only through gateways the wallet trusts ----
export const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/", "https://dweb.link/ipfs/"] as const;
const ALLOWED_HOSTS = ["ipfs.io", "cloudflare-ipfs.com", "dweb.link", "arweave.net"];

/** ipfs://CID/path -> the first gateway; an https URL on an allowed host as is; anything else null. */
export function resolveAssetUrl(u: string): string | null {
  const t = u.trim();
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)(\/.*)?$/.exec(t);
  if (ipfs) return `${IPFS_GATEWAYS[0]}${ipfs[1]}${ipfs[2] ?? ""}`;
  try {
    const url = new URL(t);
    if (url.protocol !== "https:") return null;
    const host = url.hostname;
    const ok = ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || /(^|\.)ipfs\.[a-z.]+$/.test(host);
    return ok ? url.href : null;
  } catch {
    return null;
  }
}

/** Parses metadata JSON (ERC-721-style name/description/image). Never throws. */
export function parseMetadata(json: string): NftMetadata {
  try {
    const m = JSON.parse(json) as { name?: unknown; description?: unknown; image?: unknown; image_url?: unknown };
    const image = typeof m.image === "string" ? m.image : typeof m.image_url === "string" ? m.image_url : "";
    return { name: typeof m.name === "string" ? m.name.slice(0, 80) : "", description: typeof m.description === "string" ? m.description.slice(0, 500) : "", image: image ? resolveAssetUrl(image) : null };
  } catch {
    return { name: "", description: "", image: null };
  }
}

/** Fetches and parses a token's metadata through an allowed gateway; null when there is none or it is not allowed. */
export async function loadMetadata(uri: string, fetchFn: typeof fetch = fetch): Promise<NftMetadata | null> {
  if (uri.startsWith("data:application/json")) {
    const i = uri.indexOf(",");
    if (i < 0) return null;
    const body = uri.slice(i + 1);
    try {
      return parseMetadata(/;base64/.test(uri.slice(0, i)) ? atob(body) : decodeURIComponent(body));
    } catch {
      return null;
    }
  }
  const url = resolveAssetUrl(uri);
  if (!url) return null;
  try {
    const r = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length > 200_000) return null;
    return parseMetadata(text);
  } catch {
    return null;
  }
}

// ---- the per-wallet collection list ----
export const MAX_COLLECTIONS = 100;

export function collectionsNamespace(seed: Uint8Array): string {
  const h = sha256(new Uint8Array([...utf8ToBytes("koinos-pq-wallet/collections/1"), ...seed]));
  return bytesToHex(h).slice(0, 24);
}

const localStore: BookStore = {
  get(k) {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* nothing persists */
    }
  },
};

export class Collections {
  private readonly key: string;
  private data: Record<string, Collection[]>;

  constructor(namespace: string, private readonly store: BookStore = localStore) {
    this.key = `koinos-pq-wallet/collections/${namespace}`;
    this.data = this.read();
  }
  private read(): Record<string, Collection[]> {
    try {
      const raw = this.store.get(this.key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, Collection[]> = {};
      for (const [net, list] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        out[net] = list
          .filter((c): c is Collection => !!c && typeof c === "object" && isValidAddress(String((c as Collection).address)))
          .slice(0, MAX_COLLECTIONS)
          .map((c) => ({ address: c.address, name: String(c.name ?? "").slice(0, 60), symbol: String(c.symbol ?? "").slice(0, 12), uri: String(c.uri ?? "").slice(0, 200), custom: true }));
      }
      return out;
    } catch {
      return {};
    }
  }
  private write() {
    this.store.set(this.key, JSON.stringify(this.data));
  }
  list(networkName: string): Collection[] {
    return [...(this.data[networkName] ?? [])];
  }
  add(networkName: string, c: Collection): Collection {
    if (!isValidAddress(c.address)) throw new Error("not a valid contract address");
    const list = this.data[networkName] ?? [];
    const existing = list.find((x) => x.address === c.address);
    if (existing) return existing;
    if (list.length >= MAX_COLLECTIONS) throw new Error(`at most ${MAX_COLLECTIONS} collections per network`);
    const item: Collection = { address: c.address, name: c.name.slice(0, 60), symbol: c.symbol.slice(0, 12), uri: c.uri.slice(0, 200), custom: true };
    list.push(item);
    this.data[networkName] = list;
    this.write();
    return item;
  }
  remove(networkName: string, address: string) {
    this.data[networkName] = (this.data[networkName] ?? []).filter((c) => c.address !== address);
    this.write();
  }
}
