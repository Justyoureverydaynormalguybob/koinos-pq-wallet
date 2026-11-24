// How hard a chosen passphrase is to guess. Used only where a passphrase is newly chosen (a new wallet,
// a duress wallet): never at unlock, so a wallet made before this check still opens with what it has.
//
// The vault is PBKDF2-SHA256 at 600,000 iterations, so someone who copies it guesses offline at roughly
// 10^4 to 10^5 tries a second per graphics card. 45 bits is then years of one card; 30 bits is hours.
//
// No dependency and no word list worth the name: the estimate splits the passphrase into runs of
// letters, digits and symbols and prices each the way a guesser would try them (a common word, a year,
// "1234", "aaaa", a keyboard row are cheap; unrelated words and length are what add up). It follows
// NIST SP 800-63B in rewarding length and never demanding symbols. A plain "characters x alphabet"
// count would call "Password1!" strong, which is why the patterns are priced and the well-known
// passwords refused outright.

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

/** A run of letters nobody would say: almost no vowels, or five consonants in a row. Priced as random. */
function looksRandom(lower: string): boolean {
  if (lower.length < 4) return false;
  let vowels = 0, streak = 0, longest = 0;
  for (const c of lower) {
    if ("aeiouyáéíóúàèìòùâêîôûäëïöüãõ".includes(c)) {
      vowels++;
      streak = 0;
    } else longest = Math.max(longest, ++streak);
  }
  return vowels / lower.length < 0.15 || longest >= 5;
}

function letterBits(run: string, seen: Set<string>): number {
  const lower = run.toLowerCase();
  const n = [...run].length;
  if (seen.has(lower)) return 1; // the same word again
  seen.add(lower);
  const upper = [...run].filter((c) => c !== c.toLowerCase()).length;
  const caseBits = upper === 0 || upper === n ? 0 : upper === 1 && run[0] !== run[0]!.toLowerCase() ? 1 : 2;
  if (new Set(lower).size === 1) return 3 + caseBits; // "aaaa"
  if (isRow(lower)) return 4 + caseBits;
  if (COMMON.has(lower)) return 6 + caseBits;
  if (looksRandom(lower)) return 4.2 * n + (caseBits === 2 ? 0.8 * n : caseBits);
  // an unknown word: about what one word out of a few thousand is worth, a little more when long
  return Math.min(4.7 * n, 7 + 0.9 * Math.min(n, 8) + 1.5 * Math.max(0, n - 8)) + caseBits;
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
  while (i < chars.length) {
    const c = chars[i]!;
    let j = i + 1;
    if (isLetter(c)) {
      while (j < chars.length && isLetter(chars[j]!)) j++;
      const run = chars.slice(i, j).join("");
      const b = letterBits(run, new Set(seen));
      if (b <= 6 + 2) patterned += j - i;
      bits += letterBits(run, seen);
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
