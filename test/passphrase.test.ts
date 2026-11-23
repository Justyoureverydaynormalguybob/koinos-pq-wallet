import { describe, expect, it } from "vitest";
import { MIN_PASSPHRASE_BITS, estimateBits, passphraseStrength } from "../src/core/passphrase";

describe("passphrase strength", () => {
  const weak = [
    "password",            // common
    "password12",          // common root + digits
    "qwerty1234",          // common root
    "aaaaaaaaaa",          // one char repeated
    "abcabcabca",          // short block repeated
    "abcdefghij",          // a sequence
    "1234567890",          // a numeric sequence
    "0000000000",          // one digit repeated
  ];
  const strong = [
    "correct horse battery staple",
    "7xQ!vm2Lp9wZ",
    "river-lamp-tango-ember",
    "Bk9#tR4wQ2zL",
  ];

  it("rejects weak passphrases at a choice point", () => {
    for (const p of weak) {
      const s = passphraseStrength(p);
      expect(s.ok, `${p} (${s.bits} bits, ${s.label}) should be rejected`).toBe(false);
      expect(s.bits).toBeLessThan(MIN_PASSPHRASE_BITS);
    }
  });

  it("accepts strong passphrases", () => {
    for (const p of strong) {
      const s = passphraseStrength(p);
      expect(s.ok, `${p} (${s.bits} bits, ${s.label}) should be accepted`).toBe(true);
      expect(s.bits).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
    }
  });

  it("gives a reason for the common weak shapes", () => {
    expect(passphraseStrength("password").warning).toBe("common");
    expect(passphraseStrength("ababababab").warning).toBe("repeated"); // period 2, cleanly repeated
    expect(passphraseStrength("aaaaaaaaaa").warning).toBe("repeated"); // a 1-char period is still a repeat
    expect(passphraseStrength("loweronlyletters").warning).toBe("one-kind");
  });

  it("scores longer passphrases at least as high", () => {
    const a = passphraseStrength("river-lamp");
    const b = passphraseStrength("river-lamp-tango-ember");
    expect(b.bits).toBeGreaterThan(a.bits);
    expect(b.score).toBeGreaterThanOrEqual(a.score);
  });

  it("empty is zero", () => {
    expect(estimateBits("")).toBe(0);
    expect(passphraseStrength("").ok).toBe(false);
  });
});
