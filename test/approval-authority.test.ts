// The approval sheet must EXPLAIN the two operations that hand over account authority — granting a
// contract the right to act for the account (set_allowed_caller) and replacing the signing key
// (set_public_key) — rather than show them as an opaque "cannot tell what this call does". A dapp could
// otherwise slip either past a user. The legitimate burn's own allow/forbid lines read the same way.
import { describe, expect, it } from "vitest";
import { utils } from "koilib";
import { NETWORKS, PQWALLET_ENTRY, encodeSetAllowedCallerArgs, encodeSetPublicKeyArgs } from "koinos-pq-core";
import { describeOperation } from "../src/ui/approval-view";

const net = NETWORKS.mainnet!;
const ME = "1FqXVbjZnMo2cUNj56LNCrc8R22RWDmq1t";
const OTHER = "1KprFLVQnXpaS9BnU38FaexvrzJhCuaUPy";
const b64 = (u: Uint8Array) => utils.encodeBase64url(u);

describe("approval sheet explains account-authority operations", () => {
  it("warns when a call grants a contract authority over the account", () => {
    const cc = { contract_id: ME, entry_point: PQWALLET_ENTRY.set_allowed_caller, args: b64(encodeSetAllowedCallerArgs(OTHER, true)) };
    const html = describeOperation(cc, net, ME).toLowerCase();
    expect(html).toContain("warn-inline");
    expect(html).toContain("act for");
    expect(html).not.toContain("cannot tell what this call does");
  });

  it("names forbidding a contract without a scare warning", () => {
    const cc = { contract_id: ME, entry_point: PQWALLET_ENTRY.set_allowed_caller, args: b64(encodeSetAllowedCallerArgs(OTHER, false)) };
    const html = describeOperation(cc, net, ME).toLowerCase();
    expect(html).toContain("stop");
    expect(html).not.toContain("cannot tell what this call does");
  });

  it("warns when a call replaces the account's signing key", () => {
    const pk = new Uint8Array(1312), proof = new Uint8Array(2420);
    const cc = { contract_id: ME, entry_point: PQWALLET_ENTRY.set_public_key, args: b64(encodeSetPublicKeyArgs(pk, proof)) };
    const html = describeOperation(cc, net, ME).toLowerCase();
    expect(html).toContain("warn-inline");
    expect(html).toContain("signing key");
    expect(html).not.toContain("cannot tell what this call does");
  });

  it("still shows a genuinely unknown call as unknown", () => {
    const cc = { contract_id: OTHER, entry_point: 0x12345678, args: b64(new Uint8Array([1, 2, 3])) };
    const html = describeOperation(cc, net, ME).toLowerCase();
    expect(html).toContain("cannot tell what this call does");
  });
});
