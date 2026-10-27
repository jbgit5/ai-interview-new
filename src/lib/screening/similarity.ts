import { normalizeForMatch } from "./citations";

// Near-duplicate CV text detection (MinHash over 5-word shingles). Used only to tell HR
// "large parts of this CV are identical to another CV in this job" — a prompt to look, never a
// plagiarism verdict, and never scored. Exact duplicate files are already blocked on upload.

export const SIGNATURE_SIZE = 64;
const SHINGLE_WORDS = 5;
/** Estimated share of identical 5-word sequences above which HR is told to compare the CVs. */
export const SIMILAR_THRESHOLD = 0.5;

function fnv1a(str: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 64 signed 32-bit ints (fits Postgres INT[]). Empty array when the text is too short to compare. */
export function textSignature(text: string): number[] {
  const words = normalizeForMatch(text)
    // drop masked contacts and very common short tokens so layout/contact lines don't dominate
    .split(" ")
    .filter((w) => w.length > 2 && !w.startsWith("[email") && !w.startsWith("[phone"));
  if (words.length < SHINGLE_WORDS * 4) return [];
  const sig = new Array<number>(SIGNATURE_SIZE).fill(0xffffffff);
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    const shingle = words.slice(i, i + SHINGLE_WORDS).join(" ");
    for (let k = 0; k < SIGNATURE_SIZE; k++) {
      const h = fnv1a(shingle, k * 0x9e3779b1);
      if (h < sig[k]) sig[k] = h;
    }
  }
  return sig.map((h) => h | 0);
}

/** Estimated Jaccard similarity (0..1) of two signatures; 0 if either is empty. */
export function signatureSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}
