// How hard a chosen passphrase is to guess. Used only where a passphrase is newly chosen (a new wallet,
// a duress wallet): never at unlock, so a wallet made before this check still opens with what it has.
//
// The vault is PBKDF2-SHA256 at 600,000 iterations, so someone who copies it guesses offline at roughly
// 10^4 to 10^5 tries a second per graphics card. 45 bits is then years of one card; 30 bits is hours.
//
// Two estimates, combined (see `passphraseStrength`):
//
// 1. zxcvbn (the open-source estimator Dropbox wrote, here the maintained @zxcvbn-ts build), with its
//    English, Spanish and Portuguese dictionaries: common passwords, words, names, keyboard walks,
//    dates, l33t. It is the standard tool, and it is what tells a word from letters that only look
//    like one. Loaded on first use (`loadDictionaries`), because the dictionaries are megabytes.
// 2. The wallet's own count, which splits the passphrase into runs of letters, digits and symbols and
//    prices each the way a guesser would try them (a common word, a year, "1234", "aaaa", a keyboard
//    row are cheap; unrelated words and length are what add up). zxcvbn prices a phrase of several
//    words too kindly; this count does not.
//
// Both follow NIST SP 800-63B in rewarding length and never demanding symbols. Until the dictionaries
// have loaded (or if they cannot be), the wallet's own count is used alone.

/** Below this the wallet refuses a newly chosen passphrase. */
export const MIN_PASSPHRASE_BITS = 45;

export interface PassphraseStrength {
  /** estimated guessing work, in bits (0 for a passphrase refused outright) */
  bits: number;
  /** 0 very weak, 1 weak, 2 fair (accepted from here), 3 good, 4 strong */
  score: 0 | 1 | 2 | 3 | 4;
  /** why it is refused or weak, as an English sentence that is also the translation key */
  warning?: string;
}

export const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"] as const;

// Passwords and words a guesser tries first. Matched on the whole passphrase with digits and symbols
// stripped and look-alike characters undone ("P@ssw0rd123!" is "password"), and on each word inside it.
const COMMON = new Set(
  (
    "password passphrase passwort contrasena contraseña senha secret secure security login admin administrator root user guest master default " +
    "qwerty qwertyuiop azerty asdfgh asdfghjkl zxcvbn zxcvbnm qazwsx letmein welcome hello iloveyou loveyou love monkey dragon sunshine princess " +
    "football baseball soccer liverpool arsenal chelsea barcelona superman batman pokemon starwars shadow killer hunter ninja freedom whatever " +
    "trustno computer internet samsung google iphone android abc abcd abcdef test testing changeme temp pass access " +
    "wallet koinos koin sparan sparán crypto bitcoin ethereum blockchain money mywallet quantum " +
    "january february march april june july august september october november december monday tuesday wednesday thursday friday saturday sunday " +
    "ireland dublin cavan"
  ).split(" "),
);

// ---- the dictionaries ----
interface ZxMatch {
  pattern: string;
  token: string;
}
interface Zx {
  check(pw: string): { guesses: number; sequence: ZxMatch[] };
}
let zx: Zx | null = null;
let settled = false;
let loading: Promise<boolean> | null = null;

/** True once `loadDictionaries` has finished, whether or not it worked. */
export const dictionariesSettled = (): boolean => settled;

/**
 * Loads zxcvbn and its dictionaries, once. Resolves false if they cannot be loaded; the check then
 * falls back to the wallet's own count. Nothing is fetched from the network: the files ship with the app.
 */
export function loadDictionaries(): Promise<boolean> {
  loading ??= (async () => {
    try {
      const [core, common, en, es, pt] = await Promise.all([
        import("@zxcvbn-ts/core"),
        import("@zxcvbn-ts/language-common"),
        import("@zxcvbn-ts/language-en"),
        import("@zxcvbn-ts/language-es-es"),
        import("@zxcvbn-ts/language-pt-br"),
      ]);
      zx = new core.ZxcvbnFactory({
        translations: en.translations,
        graphs: common.adjacencyGraphs,
        dictionary: { ...common.dictionary, ...en.dictionary, ...es.dictionary, ...pt.dictionary, wallet: [...COMMON] },
      }) as unknown as Zx;
      return true;
    } catch {
      zx = null;
      return false;
    } finally {
      settled = true;
    }
  })();
  return loading;
}

/** An unknown word: about what one word out of a few thousand is worth, a little more when long. */
const wordBits = (n: number): number => Math.min(4.7 * n, 7 + 0.9 * Math.min(n, 8) + 1.5 * Math.max(0, n - 8));

/**
 * What the dictionaries make of a run of letters: one entry as it stands (`whole`), or the price of its
 * pieces, where each dictionary word inside it costs what a word costs and every stretch no dictionary
 * knows costs ten guesses a character (zxcvbn's own figure). Null when the dictionaries are not loaded.
 */
function dictionaryPrice(lower: string): { whole: boolean; bits: number } | null {
  if (!zx) return null;
  const seq = zx.check(lower).sequence;
  if (seq.length === 1 && seq[0]!.pattern === "dictionary") return { whole: true, bits: 0 };
  let bits = 0;
  for (const m of seq) {
    const n = [...m.token].length;
    bits += m.pattern === "bruteforce" ? 3.32 * n : Math.min(3.32 * n, m.pattern === "dictionary" ? wordBits(n) : 4);
  }
  return { whole: false, bits };
}

const LEET: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", "!": "i" };
const ROWS = ["abcdefghijklmnopqrstuvwxyz", "qwertyuiop", "asdfghjkl", "zxcvbnm", "qwertzuiop", "azertyuiop"];
const SEPARATORS = " -_.,/";

const isLetter = (c: string) => c.toLowerCase() !== c.toUpperCase();
const isDigit = (c: string) => c >= "0" && c <= "9";
const reverse = (s: string) => [...s].reverse().join("");

/** True when the run is a stretch of the alphabet or of a keyboard row, forwards or backwards. */
function isRow(lower: string): boolean {
  return lower.length >= 3 && ROWS.some((r) => r.includes(lower) || r.includes(reverse(lower)));
}

/** Digits counting up or down by one ("1234", "9876"), or all the same. */
function isDigitPattern(d: string): boolean {
  if (d.length < 2) return false;
  const steps = new Set<number>();
  for (let i = 1; i < d.length; i++) steps.add(d.charCodeAt(i) - d.charCodeAt(i - 1));
  return steps.size === 1 && [...steps].every((s) => s === 0 || s === 1 || s === -1);
}

/** The whole text is one short piece said over and over ("abcabcabc", "hahahaha"). */
function isRepeated(s: string): boolean {
  for (let p = 1; p <= s.length / 2; p++) {
    if (s.length % p === 0 && s.slice(0, p).repeat(s.length / p) === s) return true;
  }
  return false;
}

// The 320 letter pairs that make up 99% of the pairs inside real words: counted over the BIP-39 word lists
// in English, Spanish, Portuguese, French and Italian, the 5,000 most used English, Spanish and Portuguese
// words, and a sample of Irish. A word is almost entirely these pairs; in letters picked at random fewer
// than half are.
const COMMON_PAIRS = new Set(
  (
    "abacadaeafagahaiajakalamanaoapaqarasatauavawaxayazbabbbebhbiblbobrbsbucacccechcickclcocrcsctcucydadd" +
    "dedidodrdsdudvdyeaebecedeeefegeiejelemeneoepeqereseteuevewexeyezfafefffiflfofrftfugageggghgiglgngogr" +
    "gsguhahehihohrhthuiaibicidieifigijiliminioipiqirisitiuivixizjajejojukakekikslalcldlelflglhlilllmlolp" +
    "lsltlulvlymambmemimmmompmsmumynancndnenfngnhninjnknlnnnonsntnunvnynzoaobocodoeofogoiojokolomonooopoq" +
    "orosotouovowoxoyozpapephpiplpoppprpsptpuqurarbrcrdrerfrgrirkrlrmrnrorprrrsrtrurvryrzsasbscsesfshsisk" +
    "slsmsospsqssstsusytatctethtitltotrtstttutyuaubucudueufuguiujulumunuoupurusutuvuxuzvavevivovrvuwawewh" +
    "wiwnwoxaxcxexixoxpxtyayeyoysyuzazezizozz"
  ).match(/../g),
);

/**
 * A run of letters nobody would say, priced as random: almost no vowels, five consonants in a row, or
 * (the usual case) too few of its letter pairs are ones that occur inside words. Without the last test
 * a random run that happens to hold a few vowels was priced as one dictionary word, and about three in
 * ten truly random 15-character passphrases were refused as weak. Checked against word lists: under 2%
 * of real words, and of two or three words run together, are taken for random; of random letters, 93%
 * of 8-letter runs and 97% of 12-letter runs are caught (the rest are priced as a word, which is safe).
 */
function looksRandom(lower: string): boolean {
  const plain = lower.normalize("NFD").replace(/\p{M}/gu, "");
  const letters = [...plain];
  if (letters.length < 3) return false;
  let vowels = 0, streak = 0, longest = 0;
  for (const c of letters) {
    if ("aeiouy".includes(c)) {
      vowels++;
      streak = 0;
    } else longest = Math.max(longest, ++streak);
  }
  if (letters.length >= 4 && (vowels / letters.length < 0.15 || longest >= 5)) return true;
  let common = 0;
  for (let i = 0; i + 1 < letters.length; i++) if (COMMON_PAIRS.has(letters[i]! + letters[i + 1]!)) common++;
  return common / (letters.length - 1) < 0.75;
}

/** CamelCase: an optional lower-case start, then capitals each followed by at least two small letters. */
const HUMPS = /^\p{Ll}*(\p{Lu}\p{Ll}{2,})+$/u;

/** Every other letter a capital, starting with either ("pAsSwOrD", "PaSsWoRd"). */
function isAlternating(run: string): boolean {
  const up = [...run].map((c) => c !== c.toLowerCase());
  return up.every((u, i) => i === 0 || u !== up[i - 1]);
}

/**
 * `inPhrase`: the run is one of several space-separated words. There a run that reads like a word is
 * priced as a word in whatever language. In a passphrase written as one piece, a run is a word only if
 * a dictionary has it; letters that merely could be a word are priced as zxcvbn prices what it does
 * not know, ten guesses a character (3.32 bits), and words run together are priced word by word.
 * Pricing letters no dictionary knows as one word is what refused strong passphrases in 0.19.0 and 0.19.1.
 */
function letterBits(run: string, seen: Set<string>, inPhrase: boolean): number {
  const lower = run.toLowerCase();
  const n = [...run].length;
  if (seen.has(lower)) return 1; // the same word again
  seen.add(lower);
  const upper = [...run].filter((c) => c !== c.toLowerCase()).length;
  const caseBits = upper === 0 || upper === n ? 0 : upper === 1 && run[0] !== run[0]!.toLowerCase() ? 1 : 2;
  // Capitals where people put them (CamelCase, eVeRy OtHeR) are one of a few patterns. Anywhere else,
  // each letter's case is a choice of its own and a guesser has to try them all.
  const scattered = caseBits === 2 && !HUMPS.test(run) && !isAlternating(run);
  if (new Set(lower).size === 1) return 3 + caseBits; // "aaaa"
  if (isRow(lower)) return 4 + caseBits;
  if (COMMON.has(lower)) return 6 + caseBits;
  const dict = n >= 3 && !inPhrase ? dictionaryPrice(lower) : null;
  if (!dict?.whole && looksRandom(lower)) return 4.2 * n + (scattered ? 0.8 * n : caseBits);
  if (dict && !dict.whole) return dict.bits + (scattered ? Math.min(0.8 * n, n - 1) : caseBits);
  return wordBits(n) + (scattered ? n - 1 : caseBits);
}

function digitBits(run: string, seen: Set<string>): number {
  if (seen.has(run)) return 1;
  seen.add(run);
  if (isDigitPattern(run)) return 3;
  if (/^(19|20)\d\d$/.test(run)) return 6; // a year
  return 3.32 * run.length;
}

const scoreOf = (bits: number): 0 | 1 | 2 | 3 | 4 => (bits < 25 ? 0 : bits < MIN_PASSPHRASE_BITS ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4);

export function passphraseStrength(pw: string): PassphraseStrength {
  const chars = [...pw];
  const refuse = (warning: string): PassphraseStrength => ({ bits: 0, score: 0, warning });
  if (chars.length === 0) return { bits: 0, score: 0 };

  // ---- refused outright, whatever the count below would say ----
  const lower = pw.toLowerCase();
  const unleet = [...lower].map((c) => LEET[c] ?? c).join("");
  const lettersOnly = (s: string) => [...s].filter(isLetter).join("");
  const stripped = [...lower].filter((c) => !isDigit(c) && isLetter(c)).join(""); // "password" of "Password123!"
  // digits and symbols around the word dropped first, so the "1" and "!" of "P@ssw0rd1!" are not read as letters
  const core = chars.map((c) => c.toLowerCase());
  while (core.length && !isLetter(core[core.length - 1]!)) core.pop();
  while (core.length && !isLetter(core[0]!) && !(core[0]! in LEET && core.length > 1 && isLetter(core[1]!))) core.shift();
  const coreWord = lettersOnly(core.map((c) => LEET[c] ?? c).join(""));
  if (COMMON.has(stripped) || COMMON.has(lettersOnly(unleet)) || COMMON.has(coreWord) || COMMON.has(lower)) return refuse("This is one of the first passwords anyone would try.");
  if (chars.every(isDigit)) return refuse("Numbers alone are quick to guess.");
  if (new Set(lower).size < 5) return refuse("Too few different characters.");
  if (isRepeated(lower)) return refuse("The same thing repeated is quick to guess.");

  // ---- priced run by run ----
  let bits = 0;
  let separators = 0;
  let patterned = 0; // characters that sit in a cheap pattern
  const seen = new Set<string>();
  let i = 0;
  let lastSymbol = "";
  const inPhrase = pw.trim().split(/\s+/).length >= 3;
  while (i < chars.length) {
    const c = chars[i]!;
    let j = i + 1;
    if (isLetter(c)) {
      while (j < chars.length && isLetter(chars[j]!)) j++;
      const run = chars.slice(i, j).join("");
      const b = letterBits(run, new Set(seen), inPhrase);
      if (b <= 6 + 2) patterned += j - i;
      bits += letterBits(run, seen, inPhrase);
      lastSymbol = "";
    } else if (isDigit(c)) {
      while (j < chars.length && isDigit(chars[j]!)) j++;
      const run = chars.slice(i, j).join("");
      if (isDigitPattern(run) || /^(19|20)\d\d$/.test(run)) patterned += j - i;
      bits += digitBits(run, seen);
      lastSymbol = "";
    } else if (SEPARATORS.includes(c)) {
      bits += separators++ < 6 ? 1 : 0.2;
      lastSymbol = "";
    } else {
      bits += c === lastSymbol ? 1 : 4.5;
      lastSymbol = c;
    }
    i = j;
  }
  // zxcvbn's verdict. Where it recognised something (a third of the characters or more sit in a word,
  // a keyboard walk, a date, a repeat), the lower of the two estimates stands. Where it recognised
  // nothing, its ten guesses a character is a floor, and the count above may say more (random letters).
  // A phrase of words is never priced above the wallet's own count.
  let recognised = false;
  if (zx) {
    const z = zx.check(pw);
    const zbits = Math.log2(Math.max(1, z.guesses));
    const found = z.sequence.reduce((a, m) => (m.pattern === "bruteforce" || m.pattern === "separator" ? a : a + [...m.token].length), 0);
    recognised = found >= chars.length / 3;
    if (inPhrase || recognised) {
      if (zbits < bits && recognised) patterned = chars.length;
      bits = Math.min(bits, zbits);
    } else bits = Math.max(bits, zbits);
  }
  bits = Math.round(bits * 10) / 10;
  const score = scoreOf(bits);
  if (score >= 2) return { bits, score };
  const warning =
    patterned > chars.length / 2
      ? "Mostly common words or patterns. Add unrelated words."
      : chars.length < 14
        ? "Too short. Four or more unrelated words work well."
        : "Add another unrelated word or two.";
  return { bits, score, warning };
}

/** Throws, with the reason, when a newly chosen passphrase is too easy to guess. */
export function assertStrong(pw: string): void {
  const s = passphraseStrength(pw);
  if (s.score < 2) throw new Error(s.warning ?? "This passphrase is too easy to guess.");
}
