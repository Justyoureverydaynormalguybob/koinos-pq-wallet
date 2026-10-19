// Languages. Every user-facing string in the UI goes through t(): the key is the English text itself,
// with {name} placeholders for values, so src/i18n/en.json is the list of keys and es.json / pt.json
// the translations. A missing translation falls back to English, never to a blank. The language
// follows the device unless Settings says otherwise.
import en from "./en.json";
import es from "./es.json";
import pt from "./pt.json";

export type Lang = "en" | "es" | "pt";
export const LANGUAGES: Array<{ code: Lang; name: string }> = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "pt", name: "Português" },
];
const DICTS: Record<Lang, Record<string, string>> = { en: en as Record<string, string>, es: es as Record<string, string>, pt: pt as Record<string, string> };
const PREF_LANG = "koinos-pq-wallet/lang";

let current: Lang = "en";

export function isLang(x: unknown): x is Lang {
  return x === "en" || x === "es" || x === "pt";
}

/** The device language when it is one we have, else English. */
export function detectLanguage(navLang: string | undefined = globalThis.navigator?.language): Lang {
  const code = (navLang ?? "en").slice(0, 2).toLowerCase();
  return isLang(code) ? code : "en";
}

/** The saved choice, else the device's. Call once at start-up. */
export function initLanguage(): Lang {
  let saved: string | null = null;
  try {
    saved = globalThis.localStorage?.getItem(PREF_LANG) ?? null;
  } catch {
    /* no store */
  }
  setLanguage(isLang(saved) ? saved : detectLanguage(), false);
  return current;
}

export function setLanguage(lang: Lang, remember = true) {
  current = lang;
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  if (remember) {
    try {
      globalThis.localStorage?.setItem(PREF_LANG, lang);
    } catch {
      /* the choice lasts the session */
    }
  }
}

export const currentLanguage = (): Lang => current;

/** The translated text, with {placeholders} filled in. Unknown keys come back as given (English). */
export function t(key: string, vars?: Record<string, string | number>): string {
  const text = DICTS[current][key] ?? DICTS.en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export const dictionaries = DICTS;
