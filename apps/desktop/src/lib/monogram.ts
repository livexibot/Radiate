import { hashString } from "./hash";

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

/** Three-character monogram for a logo tile, e.g. "Arena Sports 2" -> "AR2", "Terra Documentary" -> "TRR". */
export function monogram(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  if (!clean) return "?";
  const words = clean.split(/\s+/);
  const first = (words[0] ?? "").toUpperCase();
  const last = words[words.length - 1] ?? "";
  const num = words.length > 1 && /^\d{1,2}$/.test(last) ? last : "";
  let out = first[0] ?? "";
  for (const ch of first.slice(1)) {
    if (out.length >= 3) break;
    if (!VOWELS.has(ch) && ch !== out[out.length - 1]) out += ch;
  }
  for (const ch of first.slice(1)) {
    if (out.length >= 3) break;
    if (!out.includes(ch)) out += ch;
  }
  if (num) out = out.slice(0, 3 - num.length) + num;
  return out.slice(0, 3);
}

/** One of the eight gradient tiles (g1..g8), stable for a given name. */
export function tone(name: string): string {
  return `g${(hashString(name) % 8) + 1}`;
}
