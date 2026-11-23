// Passphrase strength: a small, dependency-free estimate used only when a passphrase is CHOSEN
// (new wallet, duress wallet) — never at unlock, so an existing wallet with a weak passphrase still
// opens. It is deliberately conservative and is NOT zxcvbn: it rewards length (a long multi-word
// passphrase is the goal, per NIST SP 800-63B), and it hard-rejects the weak shapes that matter —
// too short, a single repeated character, a plain sequence, a short block repeated, or a well-known
// password. It does not catch dictionary-word-with-substitution ("Tr0ub4dor&3"), which charset
// entropy overrates; the length reward and the common-list are the backstop.

export const MIN_PASSPHRASE_BITS = 45;

export type StrengthScore = 0 | 1 | 2 | 3 | 4;
export interface Strength {
  bits: number;
  score: StrengthScore;
  label: string;
  /** a specific reason it is weak, when there is one */
  warning?: string;
  /** false when it must be refused at a choice point */
  ok: boolean;
}

// A short list of the most-guessed passwords and roots. Compared after lower-casing and stripping
// trailing digits/punctuation, so "Password1!" and "qwerty123" are caught too.
const COMMON = new Set([
  "password", "passphrase", "123456", "12345678", "1234567890", "qwerty", "qwertyuiop", "asdfgh",
  "asdfghjkl", "zxcvbn", "zxcvbnm", "letmein", "iloveyou", "admin", "welcome", "monkey", "dragon",
  "football", "baseball", "superman", "batman", "master", "sunshine", "princess", "trustno",
  "whatever", "abcdef", "abcabc", "login", "root", "koinos", "bitcoin", "ethereum", "satoshi",
  "seedphrase", "walletpass", "changeme", "secret", "qazwsx", "1q2w3e4r", "zaq12wsx",
]);

const LABELS = ["very weak", "weak", "fair", "strong", "very strong"] as const;

function poolSize(pw: string): number {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33; // symbols, spaces, anything else — one conservative bucket
  return pool || 1;
}

/** Length discounted for adjacent runs and sequences: "aaaa" and "abcd" buy far less than random. */
function effectiveLength(pw: string): number {
  let eff = 0;
  for (let i = 0; i < pw.length; i++) {
    if (i > 0) {
      const d = pw.charCodeAt(i) - pw.charCodeAt(i - 1);
      if (d === 0) { eff += 0.15; continue; }         // repeated character
      if (d === 1 || d === -1) { eff += 0.4; continue; } // ascending/descending run
    }
    eff += 1;
  }
  return eff;
}

/** The smallest block that, repeated, makes up the whole string ("abcabcabc" -> "abc"). */
function shortestPeriod(pw: string): number {
  for (let p = 1; p <= pw.length >> 1; p++) {
    if (pw.length % p !== 0) continue;
    let ok = true;
    for (let i = p; i < pw.length && ok; i++) if (pw[i] !== pw[i - p]) ok = false;
    if (ok) return p;
  }
  return pw.length;
}

function looksCommon(pw: string): boolean {
  const low = pw.toLowerCase();
  if (COMMON.has(low)) return true;
  const root = low.replace(/[^a-z]+$/g, "").replace(/^[^a-z]+/g, ""); // strip leading/trailing non-letters
  if (root.length >= 3 && COMMON.has(root)) return true;
  return false;
}

export function estimateBits(passphrase: string): number {
  const pw = passphrase.normalize("NFKD");
  if (pw.length === 0) return 0;
  if (looksCommon(pw)) return 8;
  const period = shortestPeriod(pw);
  // A repeated block is worth roughly one block plus a little for the repetition count.
  const base = period < pw.length ? pw.slice(0, period) : pw;
  const eff = effectiveLength(base) + (period < pw.length ? Math.log2(pw.length / period) : 0);
  return eff * Math.log2(poolSize(pw));
}

export function passphraseStrength(passphrase: string): Strength {
  const bits = estimateBits(passphrase);
  const score: StrengthScore = bits < 28 ? 0 : bits < MIN_PASSPHRASE_BITS ? 1 : bits < 66 ? 2 : bits < 90 ? 3 : 4;
  let warning: string | undefined;
  if (looksCommon(passphrase.normalize("NFKD"))) warning = "common";
  else if (shortestPeriod(passphrase.normalize("NFKD")) < passphrase.normalize("NFKD").length) warning = "repeated";
  else if (/^[a-z]+$/.test(passphrase) || /^[0-9]+$/.test(passphrase)) warning = "one-kind";
  return { bits: Math.round(bits), score, label: LABELS[score], warning, ok: bits >= MIN_PASSPHRASE_BITS };
}
