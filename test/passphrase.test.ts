// @vitest-environment jsdom
// The passphrase strength gate: what the estimate refuses and accepts, that the screens refuse a weak
// passphrase where one is CHOSEN (new wallet, duress wallet), and that a wallet saved under a weak
// passphrase before the gate existed still unlocks (the gate is never asked at unlock).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
vi.mock("qrcode", () => ({ default: { toCanvas: async () => undefined } }));
const { App } = await import("../src/ui/app");
const { MIN_PASSPHRASE_BITS, assertStrong, dictionariesSettled, loadDictionaries, passphraseStrength } = await import("../src/core/passphrase");
const { encryptVault, localVaultStore } = await import("../src/core/vault");

describe("before the dictionaries are in", () => {
  it("the wallet's own count stands alone: common passwords refused, four unrelated words accepted", () => {
    expect(dictionariesSettled()).toBe(false);
    expect(passphraseStrength("Password1!").score).toBe(0);
    expect(passphraseStrength("kettle orbit").bits).toBeLessThan(MIN_PASSPHRASE_BITS);
    expect(passphraseStrength("correct horse battery staple").score).toBeGreaterThanOrEqual(2);
  });
});

describe("passphrase strength estimate", () => {
  beforeAll(async () => {
    expect(await loadDictionaries()).toBe(true);
    expect(dictionariesSettled()).toBe(true);
  });

  it("refuses the passwords anyone would try first, however they are dressed up", () => {
    for (const pw of ["password12", "Password1!", "P@ssw0rd123!", "qwertyuiop", "letmein2024", "iloveyou123", "Passphrase!!", "koinos2026!", "sparan1234"]) {
      const s = passphraseStrength(pw);
      expect(s.score, pw).toBe(0);
      expect(s.warning, pw).toBeTruthy();
      expect(() => assertStrong(pw), pw).toThrow();
    }
  });

  it("refuses digits alone, one character over and over, and a short piece repeated", () => {
    expect(passphraseStrength("1234567890").warning).toMatch(/Numbers alone/);
    expect(passphraseStrength("8301746592").warning).toMatch(/Numbers alone/);
    expect(passphraseStrength("aaaaaaaaaaaa").score).toBe(0);
    expect(passphraseStrength("abcdeabcdeabcde").warning).toMatch(/repeated/);
  });

  it("is not fooled by length made of common words, years and runs", () => {
    for (const pw of ["main passphrase 1234", "koinos wallet 1", "summer2024!!", "Michael1985!", "Dublin2024!ab", "wallet wallet wallet wallet", "qwerty asdfgh zxcvbn 123", "kettle orbit"]) {
      expect(passphraseStrength(pw).bits, pw).toBeLessThan(MIN_PASSPHRASE_BITS);
      expect(() => assertStrong(pw), pw).toThrow();
    }
  });

  it("accepts several unrelated words, with or without symbols, and long random strings", () => {
    for (const pw of ["correct horse battery", "correct horse battery staple", "main kettle orbit plank", "kettle-orbit-plank-moth-9", "tá an lá go breá inniu", "I walk the dog at 7 every morning", "qzkvwpxjrmtb", "G7k2pQ9xLm4vB8"]) {
      const s = passphraseStrength(pw);
      expect(s.bits, pw).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
      expect(s.score, pw).toBeGreaterThanOrEqual(2);
      expect(() => assertStrong(pw), pw).not.toThrow();
    }
  });

  it("accepts random letters and digits even when the letters happen to hold vowels", () => {
    // Each of these was made by a random generator and was refused as weak by 0.19.0, which priced a
    // random run of letters with a few vowels in it as one dictionary word. The last three 0.19.1
    // still refused.
    for (const pw of ["X2WNyfLDiaIdEXO", "ft39OZPeENoI5a5", "YiFSkINigRZBiFa", "zegcoSJzYCMG761", "UtmEyTNoRzohcty", "smui6e4umjirgbt", "wmUfnhXoudZF735", "sXOhJPHIyJxj934", "UnPVHORFaegIDVv", "q7kuuundt2edjmc", "yie33BYsszj9dvE", "vkfkoyiatxju"]) {
      const s = passphraseStrength(pw);
      expect(s.bits, pw).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
      expect(() => assertStrong(pw), pw).not.toThrow();
    }
  });

  it("accepts made-up syllables no dictionary knows, the kind people invent and password tools make", () => {
    // 0.19.0 refused every one of these and 0.19.1 about half: letters that read like a word were
    // priced as one word although no dictionary has them.
    for (const pw of ["Kav7Rin3Tol9Mep", "TavorimekulaNo42", "Rlb4gtrmoAeaeXL", "gowsup-Nybhe3-xafmek", "BodkezVumgasPil7", "zuvapelodrimtak9"]) {
      const s = passphraseStrength(pw);
      expect(s.bits, pw).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
      expect(() => assertStrong(pw), pw).not.toThrow();
    }
  });

  it("refuses what zxcvbn recognises and the wallet's own count does not: keyboard walks, l33t words", () => {
    for (const pw of ["1qaz2wsx3edc4rfv", "Tr0ub4dor&3", "zaq12wsxcde34rfv", "Jennifer1987Smith"]) {
      expect(passphraseStrength(pw).bits, pw).toBeLessThan(MIN_PASSPHRASE_BITS);
      expect(() => assertStrong(pw), pw).toThrow();
    }
  });

  it("draws the line where zxcvbn's top score starts: hand-made passwords it calls strong are accepted", () => {
    // Until 0.19.2 the line was 45 bits, which refused every one of these. They are generated examples
    // of what people make: a word or surname, a symbol, digits and a few stray letters, 14 characters.
    expect(MIN_PASSPHRASE_BITS).toBeCloseTo(Math.log2(1e10), 1);
    for (const pw of ["Stup1d@443jri0", "Selby%7853MZzp", "NLripped&3390x", "kettle orbit plank"]) {
      const s = passphraseStrength(pw);
      expect(s.bits, pw).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
      expect(s.bits, pw).toBeLessThan(45);
      expect(s.score, pw).toBe(3); // "Good"
      expect(s.warning, pw).toMatch(/Longer is safer/); // accepted, with advice
      expect(() => assertStrong(pw), pw).not.toThrow();
    }
    // from 45 bits it is "Strong" and there is nothing to add
    expect(passphraseStrength("Oz7u8Z?ppsklFc")).toMatchObject({ score: 4 });
    expect(passphraseStrength("Oz7u8Z?ppsklFc").warning).toBeUndefined();
  });

  it("says what it recognised in a passphrase it refuses", () => {
    expect(passphraseStrength("Ailina2001@xq1").found).toEqual(["a name", "a year"]);
    expect(passphraseStrength("Ailina2001@xq1").score).toBe(1);
    expect(passphraseStrength("Jennifer1987Smith").found).toContain("a name");
    expect(passphraseStrength("1qaz2wsx3edc4rfv").found).toEqual(["a common password"]);
    expect(passphraseStrength("Oz7u8Z?ppsklFc").found).toBeUndefined();
  });

  it("still prices words as words, run together or with capitals in them", () => {
    for (const pw of ["correcthorse", "CorrectHorse42", "sunshinebattery", "CoRrEcThOrSe", "cOrReCtHoRsE1", "contraseñasegura", "minhacasabonita"]) {
      expect(passphraseStrength(pw).bits, pw).toBeLessThan(MIN_PASSPHRASE_BITS);
      expect(() => assertStrong(pw), pw).toThrow();
    }
    // capitals scattered through a word add one bit a letter, not the price of random letters
    expect(passphraseStrength("corREctIoN").bits).toBeLessThan(30);
    expect(passphraseStrength("corREctIoN").bits).toBeGreaterThan(passphraseStrength("Correction").bits);
  });

  it("never rates a passphrase lower for having another unrelated word added", () => {
    const words = ["kettle", "orbit", "plank", "moth", "gravel", "lantern", "thistle"];
    let last = -1;
    for (let n = 1; n <= words.length; n++) {
      const bits = passphraseStrength(words.slice(0, n).join(" ")).bits;
      expect(bits, `${n} words`).toBeGreaterThan(last);
      last = bits;
    }
    expect(passphraseStrength("").score).toBe(0);
  });
});

const settle = async () => {
  const root = document.getElementById("app")!;
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 50));
  while (root.querySelector(".busy") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
};
const click = (root: HTMLElement, action: string) => {
  const el = root.querySelector<HTMLElement>(`[data-action="${action}"]`);
  if (!el) throw new Error(`no action ${action}; screen shows: ${root.querySelector("h1")?.textContent}`);
  el.click();
};
async function submit(root: HTMLElement, form: string, fields: Record<string, string>) {
  const f = root.querySelector<HTMLFormElement>(`form[data-form="${form}"]`);
  if (!f) throw new Error(`no form ${form}; screen shows: ${root.querySelector("h1")?.textContent}`);
  for (const [k, v] of Object.entries(fields)) f.querySelector<HTMLInputElement>(`[name="${k}"]`)!.value = v;
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
const h1 = (root: HTMLElement) => root.querySelector("h1")?.textContent ?? "";
const STRONG = "main kettle orbit plank";

describe("the gate on the screens (jsdom)", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline in tests");
    });
  });

  it("a new wallet and its duress wallet refuse a weak passphrase, say why, and take a strong one", async () => {
    localStorage.clear();
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    click(root, "create");
    const words = [...root.querySelectorAll("ol.words li")].map((li) => li.textContent!.trim());
    click(root, "wrote-down");
    const asked = [...root.querySelectorAll<HTMLLabelElement>("form[data-form=confirm] label")].map((l) => Number(/Word number (\d+)/.exec(l.textContent!)![1]) - 1);
    await submit(root, "confirm", { w0: words[asked[0]!]!, w1: words[asked[1]!]!, w2: words[asked[2]!]! });
    expect(h1(root)).toMatch(/passphrase/i);

    // the line under the field follows the typing
    const p1 = root.querySelector<HTMLInputElement>('input[name="p1"]')!;
    p1.value = "Password1!";
    p1.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector("#pw-strength")?.textContent).toMatch(/Very weak/);
    p1.value = STRONG;
    p1.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector("#pw-strength")?.textContent).toMatch(/Fair|Good|Strong/);

    for (const weak of ["Password1!", "main passphrase 1234", "summer2024!!"]) {
      await submit(root, "passphrase", { p1: weak, p2: weak });
      expect(root.textContent, weak).toMatch(/too easy to guess/);
      expect(h1(root), weak).toMatch(/passphrase/i);
      expect(localVaultStore.load(), weak).toBeNull();
    }
    // the duress wallet's passphrase, chosen on the same screen, goes through the same gate
    await submit(root, "passphrase", { p1: STRONG, p2: STRONG, d1: "duress passphrase 5678", d2: "duress passphrase 5678" });
    expect(root.textContent).toMatch(/too easy to guess/);
    expect(localVaultStore.load()).toBeNull();
    await submit(root, "passphrase", { p1: STRONG, p2: STRONG, d1: "short", d2: "short" });
    expect(root.textContent).toMatch(/at least \d+ characters for the duress passphrase/);
    expect(localVaultStore.load()).toBeNull();
    await submit(root, "passphrase", { p1: STRONG, p2: STRONG, d1: "duress lantern gravel moth", d2: "duress lantern gravel moth" });
    expect(h1(root)).toBe("The duress wallet's 24 words");
    expect(localVaultStore.load()).not.toBeNull();
  }, 120_000);

  it("a wallet saved under a weak passphrase before the gate still unlocks, and its settings still save", async () => {
    const OLD = "password12"; // ten characters: allowed before 0.18.0
    expect(() => assertStrong(OLD)).toThrow();
    localStorage.clear();
    const vault = await encryptVault({ version: 1, seedHex: "07".repeat(32), accounts: [], createdAt: new Date().toISOString() }, OLD);
    localStorage.setItem("koinos-pq-wallet/vault", JSON.stringify(vault));
    document.body.innerHTML = `<div id="app"></div>`;
    const root = document.getElementById("app")!;
    new App(root);
    expect(h1(root)).toBe("Unlock");
    await submit(root, "unlock", { passphrase: OLD });
    expect(h1(root)).not.toBe("Unlock");
    expect(root.textContent).not.toMatch(/too easy to guess/);
  }, 120_000);
});
