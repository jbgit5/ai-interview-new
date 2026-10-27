/**
 * Honest "how long will this take" estimate, derived from the real question count.
 *
 * Previously the landing page promised "15–20 minutes" and Maya's opening said
 * "10–15 minutes" regardless of the job, while a 3-question interview actually took ~4.
 * Both now use this one function so the candidate hears a single, believable number.
 *
 * ~1.5–2.5 minutes per question covers a typical answer plus the occasional follow-up probe.
 */
export function estimateInterviewMinutes(questionCount: number): { low: number; high: number } {
  if (!Number.isFinite(questionCount) || questionCount <= 0) {
    return { low: 10, high: 15 }; // no bank info → previous generic wording
  }
  const low = Math.max(3, Math.round(questionCount * 1.5));
  const high = Math.max(low + 2, Math.round(questionCount * 2.5));
  return { low, high };
}

/** e.g. "5 to 8 minutes" — worded for speech. */
export function spokenDuration(questionCount: number): string {
  const { low, high } = estimateInterviewMinutes(questionCount);
  return `${low} to ${high} minutes`;
}
