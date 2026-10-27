/**
 * Pure decision helpers for the GPT-Live interview engine. No React / browser imports so they are
 * unit-testable against real recorded interviews.
 *
 * Why these exist (measured on real interviews):
 *  1. GPT-Live decides "the candidate is done" on its own and waited for explicit closure
 *     ("…yeah, that's all") before handing the turn to our brain → we add our own silence
 *     fallback (shouldForceTurn).
 *  2. GPT-Live paraphrases AND improvises: it invented a question that wasn't in the bank and
 *     never spoke the goodbye while the screen already showed it → we measure how much of the
 *     intended line was actually spoken (deliveryRatio) and nudge when it wasn't.
 */

/** Words too common to prove a line was delivered. */
const STOPWORDS = new Set([
  "that", "this", "with", "will", "have", "been", "your", "they", "them", "what", "when", "were",
  "from", "into", "also", "about", "there", "their", "would", "could", "should", "which", "while",
  "these", "those", "than", "then", "some", "such", "very", "just", "like", "more", "most", "over",
  "does", "doing", "being", "here", "each", "other", "again", "where", "because", "before",
]);

/** Cheap stemmer: "margins"→"margin", "impacts"→"impact", "elaborating"→"elaborat". */
function stem(w: string): string {
  return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
}

/** Unique, lower-cased, stemmed content words (≥ 4 letters, not stopwords). */
export function contentWords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/)) {
    const w = raw.replace(/^['-]+|['-]+$/g, "");
    if (w.length >= 4 && !STOPWORDS.has(w)) out.add(stem(w));
  }
  return Array.from(out);
}

/**
 * Fraction (0..1) of the intended line's content words that appear in what was actually spoken.
 * Tolerates paraphrase ("margins, borders" vs "margin, border") but not a different question.
 * Returns 1 when the intended text has nothing to check.
 */
export function deliveryRatio(intended: string, spoken: string): number {
  const want = contentWords(intended);
  if (want.length === 0) return 1;
  const have = new Set(contentWords(spoken));
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return hit / want.length;
}

/** The line counts as delivered when at least this much of it was spoken. */
export const DELIVERED_THRESHOLD = 0.5;

const TRAILING_JOINERS = new Set([
  "and", "but", "so", "because", "like", "um", "uh", "hmm", "mm", "then", "also", "or", "the", "a",
  "an", "to", "of", "in", "that", "which", "is", "are", "was", "with", "for", "as", "if", "yeah",
]);

/** True when the answer sounds unfinished ("…and", "…um", trailing comma/ellipsis) → wait longer. */
export function trailsOff(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(,|\.\.\.|…|-)$/.test(t)) return true;
  const last = t.toLowerCase().replace(/[^a-z\s']/g, " ").trim().split(/\s+/).pop() ?? "";
  return TRAILING_JOINERS.has(last);
}

/** At most this many times per turn do we fold late speech back into the answer (each costs a /turn call). */
export const MAX_LATE_MERGES = 2;

/**
 * The candidate kept talking AFTER we took their answer but BEFORE Maya was handed the next question
 * (real case: "…I don't know" arrived 40 ms before hand-off and ended up as the answer to the NEXT
 * question). If they said at least two words, that speech belongs to the CURRENT answer: drop the
 * brain's reply, merge, and resubmit. Noise ("mm") doesn't count.
 */
export function shouldMergeLateSpeech(lateText: string, mergesSoFar: number): boolean {
  const words = lateText.trim().split(/\s+/).filter(Boolean).length;
  return words >= 2 && mergesSoFar < MAX_LATE_MERGES;
}

export interface ForceInput {
  /** Candidate's transcript so far this turn. */
  text: string;
  /** ms since the last new transcript text arrived. */
  silenceMs: number;
  /** ms since Maya last made any sound (audible or transcript). Forcing while she speaks would cut in. */
  mayaQuietMs: number;
  /** Base silence required before we step in. */
  baseMs: number;
  minWords: number;
  /** Extra wait when the answer sounds unfinished. */
  trailExtraMs: number;
  /** Maya must have been quiet at least this long. */
  mayaQuietNeededMs: number;
}

/**
 * Should WE end the candidate's turn because GPT-Live hasn't? Only when there's a real answer, Maya
 * isn't speaking, and the candidate has been silent long enough (longer if they trailed off mid-thought).
 */
export function shouldForceTurn(i: ForceInput): { force: boolean; needMs: number } {
  const words = i.text.trim().split(/\s+/).filter(Boolean).length;
  const needMs = i.baseMs + (trailsOff(i.text) ? i.trailExtraMs : 0);
  if (words < i.minWords) return { force: false, needMs };
  if (i.mayaQuietMs < i.mayaQuietNeededMs) return { force: false, needMs };
  return { force: i.silenceMs >= needMs, needMs };
}
