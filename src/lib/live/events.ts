/**
 * Builders for the client→GPT-Live events we send. Pure, so the rules below are regression-tested
 * (tests/live-engine.regression.mjs). Each rule was learned from a real interview:
 *
 *  1. The REAL reply to a delegation must be the FIRST and ONLY `commentary.append` for it.
 *     GPT-Live treats a delegation's first commentary as its result. We once sent a tiny "Mm-hm."
 *     commentary first; the real question then arrived after the delegation was "complete", so Maya
 *     didn't say it (and had to be nudged). The acknowledgement is now voiced by the model itself
 *     (see instructions.ts), never sent as a commentary.
 *
 *  2. A re-send ("nudge") must NOT use `session.instructions.append`. Appended instructions are
 *     permanent, session-wide guidance: each nudge was replayed on the NEXT turn, so Maya kept
 *     asking the previous question while the screen showed the current one. A nudge is a plain
 *     `commentary.append` with no delegation id — the same channel that reliably spoke the opening.
 */

export interface SpokenEvent {
  type: "session.commentary.append";
  event_id: string;
  delegation_id: string | null;
  content: string;
}

const MAX_CONTENT_CHARS = 1_800;

/** Text for Maya to say. With a delegation id it is that delegation's result; with null it is a general say-this. */
export function buildSpokenEvent(
  delegationId: string | null,
  content: string,
  eventId: string
): SpokenEvent {
  return {
    type: "session.commentary.append",
    event_id: eventId,
    delegation_id: delegationId,
    content: content.slice(0, MAX_CONTENT_CHARS),
  };
}

/**
 * Re-send a line Maya didn't say. Deliberately the bare line — commentary text is what she speaks,
 * so wrapping it in "Please ask…" would risk her reading the wrapper aloud — and deliberately
 * NOT an instructions event (permanent; see rule 2).
 */
export function buildNudgeEvent(text: string, eventId: string): SpokenEvent {
  return buildSpokenEvent(null, text, eventId);
}
