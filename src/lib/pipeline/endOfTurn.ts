/**
 * Pure turn-taking rules for the pipeline engine (Deepgram STT → our brain → TTS). No React/browser
 * imports, so tests/pipeline.regression.mjs can replay real timings against them.
 *
 * Why these numbers: the standard engine waited a fixed 7.2 s of silence (+4.8 s after every sentence
 * end) before even asking the brain — ~10–12 s of dead air per answer. Here we use Deepgram's own
 * end-of-speech signal (speech_final after ~0.5 s of silence, or UtteranceEnd) plus a short quiet
 * window, and only wait longer when the answer sounds unfinished. A candidate who resumes after we
 * committed is NOT lost: until Maya's next question actually starts playing, their extra words are
 * merged back into the answer (see shouldMergeLateSpeech in src/lib/live/turnTaking.ts).
 */
import { trailsOff } from "../live/turnTaking";

/**
 * The decision is "finished, or just thinking?" and silence alone can't tell. So the wait depends on
 * WHAT was said (real interview, 2026-10-25: "In CSS, the box model and…" + a 4 s think was taken as a
 * finished answer and Maya moved on):
 *   - ends like a finished sentence (. ? !)   → QUIET_AFTER_ENDPOINT_MS
 *   - no sentence ending                      → QUIET_AFTER_ENDPOINT_OPEN_MS
 *   - ends mid-thought ("…and", "…whether")   → UNFINISHED_WAIT_MS (practically never cut; the
 *                                               candidate can also press "Done answering")
 */
export const QUIET_AFTER_ENDPOINT_MS = 1_800;
export const QUIET_AFTER_ENDPOINT_OPEN_MS = 3_500;
export const UNFINISHED_WAIT_MS = 10_000;
/** Quiet needed when Deepgram never flagged an end of speech (noisy room, odd endpointing). */
export const QUIET_NO_ENDPOINT_MS = 3_000;
/**
 * Unfinished (interim) text unchanged this long → ask Deepgram to finalise it now. Measured on a real
 * run: Deepgram re-sent the same unfinished phrase for ~5 s after the candidate stopped, which held the
 * turn open. (Callers must only refresh lastTextAt when the text actually CHANGES.)
 */
export const FINALIZE_AFTER_MS = 1_000;
/** Safety net if finalising doesn't produce a final: treat the unchanged interim as final. */
export const STALE_INTERIM_MS = 4_000;
/** A VAD "speech started" with no transcript holds the commit for at most this long (noise guard). */
export const VAD_HOLD_MS = 1_500;
/**
 * Microphone level (src/lib/pipeline/micMeter.ts): the candidate must have been audibly quiet this long
 * before we finalise or commit. Measured on a real run: Deepgram's updates paused >1 s mid-sentence and
 * a transcript-only rule took the answer while they were still talking.
 */
export const MIC_QUIET_MS = 600;
/** The mic can only make us wait this much longer (a noisy room must never block the turn). */
export const MIC_MAX_EXTRA_WAIT_MS = 1_800;

export interface CommitInput {
  now: number;
  /** Finalised answer text so far this turn. */
  finalText: string;
  /** Current interim (not yet finalised) text, "" if none. */
  interimText: string;
  /** Last time any transcript text (interim or final) arrived. 0 = never. */
  lastTextAt: number;
  /** Last time Deepgram signalled end of speech (speech_final or UtteranceEnd). 0 = never. */
  lastEndpointAt: number;
  /** Last VAD SpeechStarted. 0 = never. */
  lastVadAt: number;
  /** Last time the candidate's mic was at speech level. Omit when no meter is available. */
  lastLoudAt?: number;
}

export type CommitReason = "endpoint" | "endpoint_open" | "endpoint_trailing" | "silence" | "stale_interim" | "button";

/** Words that, as the LAST word, mean the speaker is clearly mid-thought. */
const MID_THOUGHT_WORDS = new Set([
  "and", "but", "so", "because", "or", "then", "also", "like", "um", "uh", "umm", "hmm", "mm", "er",
  "the", "a", "an", "to", "of", "in", "on", "at", "for", "with", "that", "which", "who", "is", "are",
  "was", "were", "be", "it", "its", "their", "my", "our", "your", "as", "if", "whether", "when",
  "where", "while", "how", "what", "why", "about", "from", "by", "into", "than", "yeah", "basically",
  "actually", "maybe", "i", "we", "you", "they", "this", "these", "those", "can", "could", "would",
  "should", "will", "have", "has", "had", "do", "does", "not", "no",
]);

/**
 * Words that can NEVER end a sentence. Even if the recogniser put a full stop after one ("…the box model
 * and."), the speaker was mid-thought. (Words like "do", "it", "have", "no", "how" can end a sentence —
 * "Yes, I do." — so they only count when there is no sentence ending.)
 */
// Kept deliberately SHORT. Real interview (2026-10-25): "…we can do terminal also." was judged unfinished
// and waited the full 10 s, because "also" (and "so", "then", "on", "with"…) were in this set — but all of
// those can end a sentence ("I think so.", "that's what we work on."). Only conjunctions, articles,
// fillers and possessives qualify.
const NEVER_ENDS_SENTENCE = new Set([
  "and", "but", "because", "or", "um", "uh", "umm", "hmm", "er", "the", "a", "an", "which", "whether",
  "my", "our", "your", "their", "its",
]);

const lastWordOf = (t: string) => t.toLowerCase().replace(/[^a-z\s']/g, " ").trim().split(/\s+/).pop() ?? "";

/** True when the answer sounds unfinished: ends with a joiner/filler word, a comma, or an ellipsis. */
export function isUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(,|\.\.\.|…|-|—|:)$/.test(t)) return true;
  const last = lastWordOf(t);
  if (/[.!?]["')\]]?$/.test(t)) return NEVER_ENDS_SENTENCE.has(last); // sentence ending: only a dangling joiner counts
  return MID_THOUGHT_WORDS.has(last) || trailsOff(t);
}

/** True when the text ends like a finished sentence. */
export function endsSentence(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim());
}

export interface CommitDecision {
  commit: boolean;
  /** Ask the recogniser to finalise its pending interim text now (Deepgram `Finalize`). */
  finalize?: boolean;
  reason?: CommitReason;
  /** The text to submit when commit is true (interim folded in when it went stale). */
  text?: string;
  /** How long the candidate has been quiet (ms), for telemetry. */
  quietMs: number;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function decideCommit(i: CommitInput): CommitDecision {
  const merged = `${i.finalText} ${i.interimText}`.trim();
  if (!merged || i.lastTextAt === 0) return { commit: false, quietMs: 0 };

  // A fresh VAD "speech started" means they are probably starting another sentence — hold briefly.
  const vadHolding = i.lastVadAt > i.lastTextAt && i.now - i.lastVadAt < VAD_HOLD_MS;
  const quietMs = i.now - i.lastTextAt;
  if (vadHolding) return { commit: false, quietMs };

  // Audibly still talking? (No meter → treated as quiet; the transcript rules alone apply.)
  const micQuiet = i.lastLoudAt == null || i.now - i.lastLoudAt >= MIC_QUIET_MS;

  // Judged on EVERYTHING heard so far (final + interim) on every path — the earlier version only looked
  // at the final text on the endpoint path and cut "…the box model and" via the stale-interim path.
  const unfinished = isUnfinished(merged);

  if (i.interimText.trim()) {
    // Words still being recognised. Only give up on them once they have clearly stalled.
    const need = unfinished ? UNFINISHED_WAIT_MS : STALE_INTERIM_MS;
    if (quietMs >= need && (micQuiet || quietMs >= need + MIC_MAX_EXTRA_WAIT_MS)) {
      return { commit: true, reason: "stale_interim", text: merged, quietMs };
    }
    return { commit: false, finalize: quietMs >= FINALIZE_AFTER_MS && micQuiet, quietMs };
  }

  const endpointSeen = i.lastEndpointAt >= i.lastTextAt && i.lastEndpointAt > 0;
  if (endpointSeen) {
    const need = unfinished
      ? UNFINISHED_WAIT_MS
      : endsSentence(i.finalText)
        ? QUIET_AFTER_ENDPOINT_MS
        : QUIET_AFTER_ENDPOINT_OPEN_MS;
    // Measured from the end-of-speech signal, which itself arrives after ~0.5 s of silence.
    const since = i.now - i.lastEndpointAt;
    if (since >= need && (micQuiet || since >= need + MIC_MAX_EXTRA_WAIT_MS)) {
      return {
        commit: true,
        reason: unfinished ? "endpoint_trailing" : endsSentence(i.finalText) ? "endpoint" : "endpoint_open",
        text: merged,
        quietMs,
      };
    }
    return { commit: false, quietMs };
  }

  const need = unfinished ? UNFINISHED_WAIT_MS : QUIET_NO_ENDPOINT_MS;
  if (quietMs >= need && (micQuiet || quietMs >= need + MIC_MAX_EXTRA_WAIT_MS)) {
    return { commit: true, reason: "silence", text: merged, quietMs };
  }
  return { commit: false, quietMs };
}

/**
 * "Can you repeat the question?" is not an answer. Real interview (2026-10-25): it was scored as one,
 * Maya moved on to the NEXT question, and the interview ended with two questions never answered.
 * Short utterances only (a long answer that happens to contain "again" is still an answer).
 */
const REPEAT_PATTERNS = [
  /\b(can|could|would|will) you (please )?(repeat|say|ask)\b/,
  /\brepeat (that|it|the question|my question|your question|again|once)\b/,
  /\b(say|ask) (that|it|the question) (one more time |once more )?again\b/,
  /\bone more time\b/,
  /\bone same question\b/,
  /\bcome again\b/,
  /\bpardon\b/,
  /\b(didn'?t|did not|couldn'?t|could not|can'?t) (hear|catch|understand) (you|that|the question|what)\b/,
  /\bsorry,? (what|could you|can you)\b/,
];
export function isRepeatRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!t || wordCount(t) > 30) return false;
  return REPEAT_PATTERNS.some((p) => p.test(t));
}

/**
 * "Can you answer that question?" / "give me a hint" — the candidate asks Maya to answer for them.
 * Real interview (2026-10-25): it was scored as an answer and Maya just moved on, as if nothing was
 * asked. She should say what she is and can't do, then keep listening.
 */
const HELP_PATTERNS = [
  /\bcan you (please )?(answer|tell me the answer|give me the answer|help me (answer|with))\b/,
  /\b(could|would|will) you (please )?(answer|tell me the answer|give me the answer)\b/,
  /\b(answer|tell) (it|that|this|the question) (for|to) me\b/,
  /\banswer for (that|this|it|me)\b/,
  /\bwhat('?s| is) the (correct |right )?answer\b/,
  /\bgive me (a |the )?(hint|clue|answer)\b/,
  /\btell me (the |that |this )?answer\b/,
  /\bany (hint|clue)\b/,
];
export function isAnswerRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!t || wordCount(t) > 25) return false;
  return HELP_PATTERNS.some((p) => p.test(t));
}

/** What Maya says (once per question) when asked for the answer; a second ask falls through to "move on". */
export const ANSWER_REQUEST_REPLY =
  "I'm an AI interviewer, so I can't give you the answer. Please share whatever you know, in your own words, even a partial answer helps. And if you'd rather move on, just say so.";

/**
 * Only say "Okay." when we're confident the answer is complete. After a low-confidence commit (a stall,
 * or an unfinished-sounding answer) an ack would feel like Maya talking over a thinking candidate.
 */
export function shouldAck(reason: CommitReason): boolean {
  return reason === "endpoint" || reason === "button";
}

// ── Speaking helpers ─────────────────────────────────────────────────────────

/** Short "I heard you" lines played the instant an answer is committed (pre-synthesised at start). */
export const ACK_LINES = ["Okay.", "Got it.", "Thank you.", "Alright.", "I see.", "Thanks."] as const;

/** Said once per turn if the candidate stays silent this long after a question. */
export const NUDGE_AFTER_MS = 20_000;
export const NUDGE_LINE = "Take your time — whenever you're ready.";

/** Pick an ack different from the previous one (deterministic given rnd for tests). */
export function pickAck(previous: string | null, rnd: number = Math.random()): string {
  const pool = ACK_LINES.filter((a) => a !== previous);
  return pool[Math.min(pool.length - 1, Math.floor(rnd * pool.length))];
}

/**
 * We already said "Okay." — drop a brain line's own one-to-three-word opener ("Great!", "Thank you.")
 * so Maya doesn't say "Okay. Great! …". Longer openers ("Thanks for explaining the caching layer.")
 * carry meaning and are kept. Closing lines are never trimmed.
 */
export function stripLeadingAck(text: string, isClosing: boolean): string {
  if (isClosing) return text.trim();
  const t = text.trim();
  const m = t.match(/^([^.!?]{1,40}[.!?])\s+([\s\S]+)$/);
  if (!m) return t;
  const first = m[1];
  if (wordCount(first) > 3) return t;
  if (!/^(great|good|thanks|thank you|got it|okay|ok|alright|all right|perfect|excellent|wonderful|awesome|nice|i see|understood|sure|right)\b/i.test(first)) {
    return t;
  }
  return m[2].trim();
}

/**
 * True when a transcript heard while Maya's ack clip was playing is just the ack itself leaking back
 * through the speakers (echo), not the candidate.
 */
export function isAckEcho(heard: string, ack: string | null): boolean {
  if (!ack) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const h = norm(heard);
  const a = new Set(norm(ack));
  return h.length > 0 && h.length <= 3 && h.every((w) => a.has(w));
}
