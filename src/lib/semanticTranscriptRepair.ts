/**
 * Lightweight, conservative repairs for common STT intent glitches before sending text to the LLM.
 * Not a full ASR model — only high-precision patterns.
 */

export interface SemanticRepairResult {
  text: string;
  /** Stable labels for logs / telemetry */
  repairs: string[];
}

function normWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** "I know X" with a real object — do not rewrite */
function hasKnowObjectPhrase(lower: string): boolean {
  return /\bi know (how|what|when|where|why|if|that|you|the|a|an|this|those|these|about|which|who)\b/i.test(
    lower
  );
}

/** Looks like "I know <proper noun-ish token>" e.g. React, Kubernetes */
function hasKnowFollowedByToken(lower: string): boolean {
  const m = lower.match(/\bi know\s+([a-z0-9]+)\b/i);
  if (!m) return false;
  const w = m[1];
  if (w.length >= 4 && !/^(the|and|but|for|you|him|her|our|all|not|yes|no|um|uh)$/i.test(w)) {
    return true;
  }
  return false;
}

/**
 * Common mishear: "I don't know" → "I know". Repair only when ambiguity is low.
 */
export function applyLikelySttIntentRepairs(raw: string): SemanticRepairResult {
  const repairs: string[] = [];
  let text = raw.trim();
  if (!text) return { text, repairs };

  const lower = text.toLowerCase();
  const words = normWords(text);
  const wc = words.length;

  const stripped = lower.replace(/[.,!?]+/g, " ").replace(/\s+/g, " ").trim();

  if (!hasKnowObjectPhrase(lower) && !hasKnowFollowedByToken(lower)) {
    // Whole line is basically "I know" / "Yeah I know"
    if (
      wc <= 6 &&
      /^(yeah|yes|no|well|um|uh|like)\s+i\s+know$/i.test(stripped)
    ) {
      text = "I don't know";
      repairs.push("yeah_i_know_to_i_dont_know");
      return { text, repairs };
    }
    if (wc <= 3 && /^i\s+know$/i.test(stripped)) {
      text = "I don't know";
      repairs.push("i_know_only_to_i_dont_know");
      return { text, repairs };
    }
    // Short tail ending in "i know" without object
    if (wc <= 10 && /\bi know\s*[.,]?\s*$/i.test(lower) && !/\bdon'?t know\b/.test(lower)) {
      text = text.replace(/\bi know\b\s*[.,]?\s*$/i, "I don't know");
      repairs.push("trailing_i_know_to_i_dont_know");
    }
  }

  return { text, repairs };
}
