// QR scanning: what a scanned code may contain, and that nothing but a checksum-valid address gets through.
import { describe, expect, it } from "vitest";
import { parseScannedAddress, scanAddress } from "../src/ui/scan";

const A = "1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ";

describe("scanned codes", () => {
  it("accepts a bare address and the koinos: URI forms, trims, ignores a query", () => {
    expect(parseScannedAddress(A)).toBe(A);
    expect(parseScannedAddress(`  ${A}\n`)).toBe(A);
    expect(parseScannedAddress(`koinos:${A}`)).toBe(A);
    expect(parseScannedAddress(`koinos://${A}`)).toBe(A);
    expect(parseScannedAddress(`koinos:${A}?amount=1`)).toBe(A);
  });
  it("refuses anything else, including an address with a wrong checksum", () => {
    expect(parseScannedAddress(A.slice(0, -1) + "x")).toBeNull();
    expect(parseScannedAddress("https://example.com/" + A)).toBeNull();
    expect(parseScannedAddress("")).toBeNull();
    expect(parseScannedAddress("koinos:")).toBeNull();
    expect(parseScannedAddress(`${A} ${A}`)).toBeNull();
    expect(parseScannedAddress("0x" + "ab".repeat(20))).toBeNull();
  });
  it("scanAddress: null on cancel, the address on a good scan, an error on a bad one", async () => {
    expect(await scanAddress(async () => null)).toBeNull();
    expect(await scanAddress(async () => `koinos:${A}`)).toBe(A);
    await expect(scanAddress(async () => "hello")).rejects.toThrow(/not a Koinos address/);
  });
});
