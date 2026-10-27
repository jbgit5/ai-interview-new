/**
 * Turns the machine reason the room falls back from GPT-Live (e.g. "live_session_429:live_voice_concurrency_cap")
 * into a sentence a human can act on. Shown in the room's debug header so nobody has to dig through logs to
 * learn WHY they got the standard engine. Pure, so it is regression-tested.
 */
export function describeLiveFallback(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("unreachable")) return "couldn't reach OpenAI — check your internet connection";
  if (r.includes("timeout") || r.includes("timed out")) return "OpenAI took too long to answer";
  if (r.includes("concurrency_cap")) return "another GPT-Live session is still counted as open (concurrency cap) — retry in a few minutes";
  if (r.includes("daily_budget")) return "today's GPT-Live budget is used up";
  if (r.includes("interview_cap")) return "this interview already used its allowed GPT-Live sessions";
  if (r.includes("not_allowed") || r.includes("disabled")) return "GPT-Live is switched off for this job or on this server";
  if (r.includes("not_in_progress") || r.includes("session_expired")) return "the interview session isn't active";
  if (r.includes("provider_error")) return "OpenAI rejected the request (check the dev-server log and your key's access to gpt-live-1)";
  if (r.includes("maya_silent")) return "the voice model connected but never started speaking";
  if (r.includes("opening_")) return "our server couldn't produce the opening line";
  if (r.includes("session.started timeout")) return "the voice connection never became ready";
  if (r.includes("notallowederror") || r.includes("permission")) return "the microphone was blocked";
  return reason;
}
