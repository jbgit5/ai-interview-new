/**
 * Deterministic weak-answer signals for the interview brain + telemetry.
 * Complements the LLM; all flags are explainable from phrase/word rules.
 */

export type WeakAnswerKind =
  | "admits_ignorance"
  | "limited_knowledge"
  | "avoidance"
  | "very_short"
  | "generic_template";

export interface WeakAnswerAnalysis {
  kinds: WeakAnswerKind[];
  /** 0 = strong / neutral, 1 = multiple weak cues */
  weaknessScore: number;
  /** Short line for prompts (no PII) */
  summaryLine: string;
}

export function normalizeAnswerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** After `normalizeAnswerText`, collapse common STT/punctuation splits (e.g. "don t" → "dont"). */
export function normalizeAnswerTextLoose(text: string): string {
  let s = normalizeAnswerText(text);
  const fixes: [RegExp, string][] = [
    // Common Deepgram splits / mis-hears of "idea"
    [/\bi dea\b/g, "idea"],
    [/\bno dea\b/g, "idea"],
    [/don t/g, "dont"],
    [/doesn t/g, "doesnt"],
    [/didn t/g, "didnt"],
    [/won t/g, "wont"],
    [/can t/g, "cant"],
    [/couldn t/g, "couldnt"],
    [/shouldn t/g, "shouldnt"],
    [/haven t/g, "havent"],
    [/hasn t/g, "hasnt"],
    [/isn t/g, "isnt"],
    [/wasn t/g, "wasnt"],
    [/i m/g, "im"],
    [/you re/g, "youre"],
    [/they re/g, "theyre"],
    [/we re/g, "were"],
  ];
  for (const [re, rep] of fixes) s = s.replace(re, rep);
  return s.replace(/\s+/g, " ").trim();
}

const ADMITS_IGNORANCE_PHRASES = [
  "i don't know",
  "i dont know",
  "i do not know",
  "i don't have idea",
  "i dont have idea",
  "dont have idea",
  "dont have that much",
  "dont have much idea",
  "not much idea",
  "i dont have that much",
  "no experience with",
  "not my area",
  "i have no idea",
  "no idea",
  "not sure",
  "i'm not sure",
  "im not sure",
  "unsure",
  "can't say",
  "cant say",
  "couldn't tell you",
  "couldnt tell you",
  "haven't thought about",
  "havent thought about",
  "no clue",
  "beats me",
];

const LIMITED_KNOWLEDGE_PHRASES = [
  "limited knowledge",
  "limited exposure",
  "limited experience",
  "not deeply familiar",
  "not familiar with",
  "superficial knowledge",
  "only surface level",
  "surface level",
  "basic understanding",
  "don't have much experience",
  "dont have much experience",
  "not something i've done",
  "not something ive done",
  "never worked with",
  "never used",
];

const AVOIDANCE_PHRASES = [
  "rather not say",
  "prefer not to",
  "skip this question",
  "skip that",
  "next question please",
  "can we skip",
  "don't want to answer",
  "dont want to answer",
  "pass on this",
  "rather not answer",
];

/** Stock / filler claims with little specificity */
const GENERIC_PHRASES = [
  "team player",
  "hard worker",
  "fast learner",
  "quick learner",
  "passionate about",
  "love learning",
  "always willing to learn",
  "give one hundred ten percent",
  "good communication skills",
  "good problem solver",
  "attention to detail",
  "positive attitude",
];

const VAGUE_TOKENS = new Set([
  "stuff",
  "things",
  "basically",
  "generally",
  "usually",
  "somehow",
  "whatever",
  "something",
]);

function wordCount(normalised: string): number {
  return normalised ? normalised.split(" ").filter(Boolean).length : 0;
}

function includesAny(normalised: string, phrases: string[]): boolean {
  return phrases.some((p) => normalised.includes(p));
}

/** True when the answer is boilerplate-heavy relative to length. */
function genericTemplateScore(normalised: string, wc: number): number {
  if (!normalised || wc === 0) return 0;
  let hits = 0;
  for (const p of GENERIC_PHRASES) {
    if (normalised.includes(p)) hits++;
  }
  const tokens = normalised.split(" ").filter(Boolean);
  let vague = 0;
  for (const t of tokens) {
    if (VAGUE_TOKENS.has(t)) vague++;
  }
  const density = vague / Math.max(tokens.length, 1);
  let score = 0;
  if (hits >= 2) score += 0.55;
  else if (hits === 1) score += 0.35;
  if (wc <= 18 && density >= 0.12) score += 0.25;
  if (wc <= 12 && hits >= 1) score += 0.2;
  return Math.min(1, score);
}

export function analyzeWeakAnswer(raw: string): WeakAnswerAnalysis {
  const normalised = normalizeAnswerText(raw);
  const loose = normalizeAnswerTextLoose(raw);
  const wc = wordCount(normalised);
  const kinds: WeakAnswerKind[] = [];

  if (includesAny(loose, ADMITS_IGNORANCE_PHRASES)) {
    kinds.push("admits_ignorance");
  }
  if (includesAny(loose, LIMITED_KNOWLEDGE_PHRASES)) {
    kinds.push("limited_knowledge");
  }
  if (includesAny(normalised, AVOIDANCE_PHRASES)) {
    kinds.push("avoidance");
  }
  if (wc > 0 && wc <= 6 && !kinds.includes("admits_ignorance")) {
    kinds.push("very_short");
  }
  const gen = genericTemplateScore(normalised, wc);
  if (gen >= 0.45) {
    kinds.push("generic_template");
  }

  const unique = Array.from(new Set(kinds));

  let weaknessScore = 0;
  for (const k of unique) {
    if (k === "avoidance") weaknessScore += 0.38;
    else if (k === "admits_ignorance") weaknessScore += 0.42;
    else if (k === "limited_knowledge") weaknessScore += 0.32;
    else if (k === "very_short") weaknessScore += 0.22;
    else if (k === "generic_template") weaknessScore += 0.28;
  }
  weaknessScore = Math.min(1, weaknessScore + gen * 0.15);

  const summaryParts: string[] = [];
  if (unique.includes("admits_ignorance")) summaryParts.push("states uncertainty or lack of knowledge");
  if (unique.includes("limited_knowledge")) summaryParts.push("signals shallow or bounded experience");
  if (unique.includes("avoidance")) summaryParts.push("avoids answering or requests to skip");
  if (unique.includes("very_short")) summaryParts.push("very brief (few words)");
  if (unique.includes("generic_template")) summaryParts.push("mostly generic boilerplate");

  const summaryLine =
    summaryParts.length > 0
      ? `Detected signals: ${summaryParts.join("; ")}.`
      : weaknessScore >= 0.25
        ? "Some vague or thin-content cues — use judgment."
        : "No strong automated weak-answer flags.";

  return {
    kinds: unique,
    weaknessScore,
    summaryLine,
  };
}

/**
 * Plain “I don’t know / not sure” style answers — client + server use this to skip
 * follow-up probes and move on with a warm acknowledgment (minimal orchestration).
 */
const PLAIN_IGNORANCE_NO_PROBE_PHRASES = [
  "i dont know",
  "i do not know",
  "dont have idea",
  "dont have that much",
  "dont have that much idea",
  "have that much idea",
  "that much idea",
  "dont have much idea",
  "not much idea",
  "no idea",
  "i dont have idea",
  "i dont have that much",
  "not sure",
  "i have no idea",
  "im not sure",
  "no clue",
  "not familiar",
  "havent used",
  "no experience with",
  "not my area",
];

export function isPlainIgnoranceNoProbePhrases(text: string): boolean {
  const n = normalizeAnswerTextLoose(text);
  return includesAny(n, PLAIN_IGNORANCE_NO_PROBE_PHRASES);
}

/** For client flows: explicit uncertainty / ignorance (and close variants). */
export function isUncertainOrIgnorantAnswer(text: string): boolean {
  const loose = normalizeAnswerTextLoose(text);
  return includesAny(loose, ADMITS_IGNORANCE_PHRASES) || includesAny(loose, LIMITED_KNOWLEDGE_PHRASES);
}

/** Continuation UI: treat like "no idea" for moving on */
export function isAvoidanceOrRefusal(text: string): boolean {
  return includesAny(normalizeAnswerText(text), AVOIDANCE_PHRASES);
}

export function formatWeakAnswerForPrompt(analysis: WeakAnswerAnalysis): string | undefined {
  if (analysis.kinds.length === 0 && analysis.weaknessScore < 0.28) return undefined;
  return `Automated answer-quality signals (heuristic): ${analysis.summaryLine} Kinds: [${analysis.kinds.join(", ") || "none"}]. Weakness score (0-1): ${analysis.weaknessScore.toFixed(2)}.`;
}
