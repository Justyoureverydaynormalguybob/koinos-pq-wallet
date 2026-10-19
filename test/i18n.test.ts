// Languages: every English key has a Spanish and a Portuguese line with the same placeholders, the
// dictionaries carry no stray keys, and t() fills values, falls back and follows the device.
import { afterEach, describe, expect, it } from "vitest";
import { detectLanguage, dictionaries, isLang, setLanguage, t } from "../src/i18n";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

describe("dictionaries", () => {
  it("cover every key, keep the placeholders, and keep the inline tags", () => {
    const en = dictionaries.en;
    expect(Object.keys(en).length).toBeGreaterThan(250);
    for (const [code, dict] of [["es", dictionaries.es], ["pt", dictionaries.pt]] as const) {
      for (const k of Object.keys(en)) {
        expect(dict[k], `${code}: ${k.slice(0, 50)}`).toBeTypeOf("string");
        expect(dict[k]!.length, `${code} empty: ${k.slice(0, 50)}`).toBeGreaterThan(0);
        expect(placeholders(dict[k]!), `${code} placeholders: ${k.slice(0, 50)}`).toBe(placeholders(k));
        // tags that carry meaning (<strong>, <em>, <code>) must survive translation
        const tags = (s: string) => (s.match(/<\/?(strong|em|code)[^>]*>/g) ?? []).join("");
        expect(tags(dict[k]!), `${code} tags: ${k.slice(0, 50)}`).toBe(tags(k));
      }
      for (const k of Object.keys(dict)) expect(k in en, `${code} stray: ${k.slice(0, 50)}`).toBe(true);
    }
    // English maps every key to itself
    for (const [k, v] of Object.entries(en)) expect(v).toBe(k);
  });
});

describe("t()", () => {
  afterEach(() => setLanguage("en", false));
  it("fills placeholders, translates, and falls back to English for unknown keys and missing lines", () => {
    expect(t("Word number {n}", { n: 7 })).toBe("Word number 7");
    expect(t("Not a key at all")).toBe("Not a key at all");
    setLanguage("es", false);
    expect(t("Settings")).toBe("Ajustes");
    expect(t("Word number {n}", { n: 7 })).toBe("Palabra número 7");
    expect(t("Not a key at all")).toBe("Not a key at all");
    setLanguage("pt", false);
    expect(t("Unlock")).toBe("Desbloquear");
    expect(t("Amount ({symbol})", { symbol: "KOIN" })).toBe("Quantia (KOIN)");
  });
  it("detects the device language, English for anything else", () => {
    expect(detectLanguage("es-ES")).toBe("es");
    expect(detectLanguage("pt-BR")).toBe("pt");
    expect(detectLanguage("en-IE")).toBe("en");
    expect(detectLanguage("de")).toBe("en");
    expect(detectLanguage(undefined)).toBe("en");
    expect(isLang("fr")).toBe(false);
  });
});
