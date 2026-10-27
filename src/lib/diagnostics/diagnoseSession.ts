/**
 * Turns the raw telemetry of ONE interview into a plain-language story:
 *   - how it ended (verdict)
 *   - what went wrong, with a likely cause and what to do about it (issues)
 *   - a single merged timeline (what Maya said, what the candidate said, system events)
 *
 * Pure function: no DB / React imports, so it is unit-testable against recorded sessions.
 * All data already exists (transcript_turns, session_telemetry_events, proctoring_events,
 * live_voice_sessions) — nothing new is written to diagnose an interview.
 */

export interface DiagEvent {
  occurred_at: Date | string;
  source: string;
  event_name: string;
  turn_index: number | null;
  attrs: Record<string, unknown>;
}
export interface DiagTurn {
  turn_index: number;
  role: "interviewer" | "candidate";
  content: string;
  created_at: Date | string;
}
export interface DiagProctor {
  event_type: string;
  severity: string | null;
  timestamp_ms: number | null;
  created_at: Date | string;
}
export interface DiagInput {
  session: {
    status: string;
    exit_type: string | null;
    started_at: Date | string | null;
    completed_at: Date | string | null;
    integrity_score: number | null;
  };
  turns: DiagTurn[];
  events: DiagEvent[];
  proctor: DiagProctor[];
  ledger: { max_seconds: number; usage_seconds: number | null; close_reason: string | null } | null;
  questionCount: number;
}

export type Severity = "high" | "medium" | "low";
export interface Issue {
  severity: Severity;
  title: string;
  /** What happened, in plain words. */
  detail: string;
  /** What to do about it. */
  fix: string;
  /** ms since interview start, for jumping to the moment in the timeline. */
  atMs?: number;
}
export type Tone = "ok" | "warn" | "bad";
export type TimelineKind =
  | "maya" // what the interviewer line says (intended)
  | "maya_said" // what Maya actually said (live engine transcript)
  | "candidate"
  | "system"
  | "latency"
  | "proctor"
  | "error";
export interface TimelineItem {
  atMs: number;
  kind: TimelineKind;
  label: string;
  text?: string;
}
export interface Diagnosis {
  engine: "live" | "legacy" | "pipeline";
  verdict: { tone: Tone; title: string; detail: string };
  stats: { durationMin: number | null; answers: number; spendUsd: number | null };
  issues: Issue[];
  timeline: TimelineItem[];
}

const t = (d: Date | string | null | undefined): number | null =>
  d ? new Date(d).getTime() : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Events that are noise for a human reader. */
const NOISE = new Set(["interview.state_change"]);

const CLOSE_REASON_TEXT: Record<string, string> = {
  complete: "the interview finished normally",
  early: "the candidate pressed Leave",
  cap: "the session hit its maximum duration",
  idle: "no one spoke for 3 minutes",
  stalled: "the voice connection stopped responding",
  turn_failed: "the AI server failed twice in a row",
  delegation_error: "an unexpected error occurred during a turn",
  pagehide: "the candidate closed or reloaded the browser tab",
  reset: "the page was reset or navigated away",
  fallback: "live voice could not start, so the standard engine took over",
};

export function diagnoseSession(input: DiagInput): Diagnosis {
  const events = input.events
    .filter((e) => !NOISE.has(e.event_name))
    .map((e) => ({ ...e, ms: t(e.occurred_at) ?? 0 }))
    .sort((a, b) => a.ms - b.ms);

  const isLive = events.some((e) => e.event_name === "live.session.started");
  const isPipeline = events.some((e) => e.event_name === "pipeline.started");
  const engine: Diagnosis["engine"] = isLive ? "live" : isPipeline ? "pipeline" : "legacy";

  const startMs =
    t(input.session.started_at) ??
    events[0]?.ms ??
    t(input.turns[0]?.created_at) ??
    0;
  const rel = (ms: number) => Math.max(0, ms - startMs);

  const byName = (name: string) => events.filter((e) => e.event_name === name);
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);

  const answers = input.turns.filter((x) => x.role === "candidate").length;
  const lastInterviewer = [...input.turns].reverse().find((x) => x.role === "interviewer");

  // ── How did it end? ───────────────────────────────────────────────────────
  const closed = byName("live.session.closed").at(-1);
  const closeReason = typeof closed?.attrs.reason === "string" ? (closed.attrs.reason as string) : null;
  const closingAudio = byName("live.closing.audio").at(-1);
  const closeTurn = byName("live.turn.completed").filter((e) => e.attrs.action === "close").at(-1);

  // ── Goodbye cut off ───────────────────────────────────────────────────────
  // New sessions record how the wait ended; older ones are inferred from timestamps.
  // Newer sessions record whether the goodbye's words were actually spoken. GPT-Live once asked an
  // invented question instead and never said it, while the screen already showed the goodbye.
  if (closingAudio && closingAudio.attrs.delivered === false) {
    add({
      severity: "high",
      title: "Maya never said the goodbye",
      detail: `Only ${Math.round((num(closingAudio.attrs.delivery_ratio) ?? 0) * 100)}% of the goodbye's words were spoken${
        closingAudio.attrs.nudged ? " even after we re-sent it" : ""
      }. What she said instead: “${String(closingAudio.attrs.spoken ?? "").slice(0, 200)}”`,
      fix: "GPT-Live paraphrases and sometimes improvises instead of reading our line. Check the 'Maya actually said' lines; if it recurs, the voice engine may not be suitable for a strict script.",
      atMs: rel(closingAudio.ms),
    });
  }
  if (isLive && closeTurn && closed && closeReason === "complete" && closingAudio?.attrs.delivered !== false) {
    const words = (lastInterviewer?.content ?? "").split(/\s+/).filter(Boolean).length;
    const needMs = 1_000 + words * 400; // ~150 wpm plus a moment to start speaking
    const gotMs = closed.ms - closeTurn.ms;
    const endedBy = closingAudio?.attrs.ended_by;
    const measured = closingAudio != null;
    const cut = measured
      ? endedBy !== "silence" && endedBy !== "estimate"
      : gotMs < needMs * 0.8;
    if (cut) {
      add({
        severity: "high",
        title: "Maya's goodbye was probably cut off",
        detail: measured
          ? `The interview closed without hearing Maya go quiet (ended by: ${String(endedBy)}).`
          : `The connection closed ${secs(gotMs)} after the goodbye was handed to Maya, but a ${words}-word goodbye needs about ${secs(needMs)} to speak. The candidate most likely heard only part of it.`,
        fix: "Fixed in code by waiting for Maya's real audio to finish. If it still happens on new interviews, check the 'live.closing.audio' event.",
        atMs: rel(closeTurn.ms),
      });
    }
  }

  // ── Slow turns ────────────────────────────────────────────────────────────
  const brainEvents = byName("ai.brain.completed").filter((e) => e.attrs.opening !== true);
  for (const lt of byName("live.turn.completed")) {
    const wait = num(lt.attrs.last_candidate_delta_to_commentary_ms);
    if (wait == null || wait < 7_000) continue;
    const nearest = brainEvents
      .filter((b) => Math.abs(b.ms - lt.ms) < 4_000)
      .sort((a, b) => Math.abs(a.ms - lt.ms) - Math.abs(b.ms - lt.ms))[0];
    const brainMs = num(nearest?.attrs.brain_ms) ?? num(nearest?.attrs.llm_ms);
    const scorerMs = num(nearest?.attrs.scorer_ms);
    add({
      severity: wait >= 10_000 ? "high" : "medium",
      title: `Slow reply (${secs(wait)} of waiting)`,
      detail: `After the candidate stopped talking it took ${secs(wait)} before Maya had the next question.${
        brainMs != null ? ` The AI decision took ${secs(brainMs)}` : ""
      }${scorerMs != null ? ` and the answer scoring ${secs(scorerMs)}` : ""}${
        brainMs != null ? "." : ""
      }`,
      fix: "Usually OpenAI latency variance. Check 'brain_fallbacks' in the metrics report; consider a faster brain model.",
      atMs: rel(lt.ms),
    });
  }
  // Legacy engine: same idea from llm.turn.completed
  for (const lt of byName("llm.turn.completed")) {
    if (lt.attrs.engine === "pipeline") continue; // judged below on what the candidate actually heard
    const wait = num(lt.attrs.last_transcript_to_question_ms);
    if (wait == null || wait < 12_000) continue;
    add({
      severity: wait >= 18_000 ? "high" : "medium",
      title: `Slow reply (${secs(wait)} of waiting)`,
      detail: `The standard engine waited ${secs(wait)} from the candidate's last words to having the next question (it includes a fixed 7.2s silence window).`,
      fix: "Expected with the standard engine; GPT-Live voice removes most of this wait.",
      atMs: rel(lt.ms),
    });
  }

  // ── Pipeline engine (default): what the candidate actually experienced ────
  for (const v of byName("pipeline.voice.started")) {
    const wait = num(v.attrs.last_word_to_voice_ms);
    if (wait == null || wait < 7_000) continue;
    const nearest = brainEvents
      .filter((b) => b.ms <= v.ms && v.ms - b.ms < 15_000)
      .sort((a, b) => b.ms - a.ms)[0];
    const brainMs = num(nearest?.attrs.brain_ms) ?? num(nearest?.attrs.llm_ms);
    const scorerMs = num(nearest?.attrs.scorer_ms);
    add({
      severity: wait >= 10_000 ? "high" : "medium",
      title: `Slow reply (${secs(wait)} until Maya spoke)`,
      detail: `The candidate heard an acknowledgement, but Maya's next line started ${secs(wait)} after their last word.${
        brainMs != null ? ` AI decision: ${secs(brainMs)}` : ""
      }${scorerMs != null ? `, answer scoring: ${secs(scorerMs)}` : ""}${brainMs != null ? "." : ""}`,
      fix: "Usually OpenAI latency. The turn waits for the slower of brain and scorer; if scoring is the slow one, it can be moved off the critical path.",
      atMs: rel(v.ms),
    });
  }
  for (const e of byName("pipeline.tts.failed")) {
    add({
      severity: "high",
      title: "Maya's voice failed — the question was shown as text",
      detail: `Speech generation failed (${String(e.attrs.error ?? "unknown")}), so the candidate had to read the line on screen.`,
      fix: "Check the 'tts.error' server event: both Deepgram Aura and the OpenAI fallback failed (keys, credits, or network).",
      atMs: rel(e.ms),
    });
  }
  for (const e of [...byName("pipeline.turn.failed"), ...byName("pipeline.listen.failed")]) {
    add({
      severity: "high",
      title: e.event_name === "pipeline.listen.failed" ? "Listening could not start" : "The AI turn failed",
      detail: `${String(e.attrs.error ?? "unknown error")}${e.attrs.opening ? " (at the opening)" : ""}. The interview stopped with an error.`,
      fix: "Check the server log at this time (OpenAI / database / Deepgram errors).",
      atMs: rel(e.ms),
    });
  }
  const merges = byName("pipeline.late_merge");
  if (merges.length > 0) {
    add({
      severity: merges.length >= 3 ? "medium" : "low",
      title: `Candidate kept talking after their answer was taken (${merges.length}×) — merged`,
      detail: "Their extra words were added to the same answer before Maya's next line started, so nothing was lost.",
      fix: merges.length >= 3
        ? "Happening often: this candidate pauses a lot. Raise QUIET_AFTER_ENDPOINT_MS in src/lib/pipeline/endOfTurn.ts if it's common."
        : "Informational — this is the safety net working.",
      atMs: rel(merges[0].ms),
    });
  }
  const barges = byName("pipeline.barge_in");
  if (barges.length >= 2) {
    add({
      severity: "medium",
      title: `Maya was stopped by the candidate's microphone ${barges.length}×`,
      detail: `Mic levels at the moment: ${barges.map((b) => String(b.attrs.rms)).join(", ")}. If the candidate wasn't actually interrupting, this is Maya's own voice echoing into the mic (speakers, no headphones).`,
      fix: "Ask for headphones, or raise BARGE_MIN_RMS in usePipelineInterview.ts; ?barge=off on the link turns it off.",
      atMs: rel(barges[0].ms),
    });
  }
  const staleCommits = byName("pipeline.turn.committed").filter((e) => e.attrs.reason === "stale_interim");
  if (staleCommits.length > 0) {
    add({
      severity: "low",
      title: `Speech recognition stalled on ${staleCommits.length} answer${staleCommits.length === 1 ? "" : "s"}`,
      detail: "Deepgram never finished recognising the last words, so we took the unfinished text after a safety wait.",
      fix: "Informational. If frequent, check the candidate's network (stt.* events).",
      atMs: rel(staleCommits[0].ms),
    });
  }
  const clips = byName("pipeline.clips.loaded")[0];
  if (clips && (num(clips.attrs.loaded) ?? 0) < (num(clips.attrs.wanted) ?? 0)) {
    add({
      severity: "low",
      title: "Some acknowledgement clips didn't load",
      detail: `${String(clips.attrs.loaded)} of ${String(clips.attrs.wanted)} short clips loaded, so some answers had no instant "Okay." while Maya thought.`,
      fix: "Check tts.error events around the start of the interview.",
    });
  }
  const pStart = byName("pipeline.started")[0];
  const pOpening = byName("pipeline.voice.started").find((e) => e.attrs.kind === "opening");
  if (pStart && pOpening && pOpening.ms - pStart.ms > 6_000) {
    add({
      severity: "medium",
      title: `Slow start (${secs(pOpening.ms - pStart.ms)} before Maya spoke)`,
      detail: "The candidate waited this long between clicking Start and hearing Maya's first words.",
      fix: "Compare pipeline.opening.ready (browser) with the opening ai.brain.completed total_ms/pre_ms (server) to find the slow step.",
      atMs: 0,
    });
  }

  // ── AI / server problems ──────────────────────────────────────────────────
  for (const b of brainEvents) {
    if (b.attrs.brain_fallback === true) {
      add({
        severity: "medium",
        title: "AI timed out — a fallback question was used",
        detail: `The AI decision call failed or exceeded its time limit${
          typeof b.attrs.brain_error === "string" ? ` (${b.attrs.brain_error})` : ""
        }, so the next unasked bank question was asked without adaptive follow-up.`,
        fix: "Occasional is fine. If frequent, raise TURN_BRAIN_TIMEOUT_MS or check OpenAI status.",
        atMs: rel(b.ms),
      });
    }
    if (b.attrs.scorer_failed === true) {
      add({
        severity: "medium",
        title: "An answer was not scored",
        detail: "The scoring call failed, so this answer has no score in the report (no fake score is saved).",
        fix: "The overall score for this interview is based on fewer answers. Check OpenAI errors in the server log.",
        atMs: rel(b.ms),
      });
    }
  }

  // ── Voice / audio problems ────────────────────────────────────────────────
  const empties = byName("live.turn.empty");
  if (empties.length > 0) {
    add({
      severity: empties.length >= 3 ? "high" : "medium",
      title: `Candidate's voice wasn't captured ${empties.length}×`,
      detail: "The voice model thought the candidate finished, but no words were transcribed (mic too quiet, background noise, or the candidate said nothing).",
      fix: "Check the mic check step, ask candidates to use headphones/a quiet room.",
      atMs: rel(empties[0].ms),
    });
  }
  // ── Did Maya actually ask what our server told her to ask? ────────────────
  for (const e of byName("live.turn.delivery")) {
    if (e.attrs.delivered !== false || e.attrs.candidate_spoke === true) continue;
    const intended = input.turns.find((x) => x.role === "interviewer" && x.turn_index === e.turn_index)?.content;
    add({
      severity: "medium",
      title: "Maya didn't ask the intended question",
      detail: `Only ${Math.round((num(e.attrs.ratio) ?? 0) * 100)}% of the intended words were spoken${
        e.attrs.nudged ? " even after a nudge" : ""
      }.${intended ? ` Intended: “${intended.slice(0, 140)}”.` : ""} She said: “${String(e.attrs.spoken ?? "").slice(0, 200)}”`,
      fix: "She improvised or paraphrased too loosely. The screen shows the intended question, so what the candidate saw and heard disagreed.",
      atMs: rel(e.ms),
    });
  }
  const forced = byName("live.turn.forced");
  if (forced.length > 0) {
    const secsList = forced.map((e) => ((num(e.attrs.silence_ms) ?? 0) / 1000).toFixed(1)).join("s, ");
    add({
      severity: "low",
      title: `${forced.length} answer${forced.length === 1 ? "" : "s"} ended by our silence timer`,
      detail: `GPT-Live hadn't decided the candidate was finished, so after ${secsList}s of silence we moved on ourselves. This is the fix for "it waits until I say that's all".`,
      fix: "Informational. If candidates complain of being cut off, raise the wait with ?turnms=5000 on the link (or see 'cut off' issues below).",
    });
  }
  for (const e of byName("live.turn.force_regret")) {
    add({
      severity: "medium",
      title: "Candidate was cut off mid-thought",
      detail: `They started speaking again ${secs(num(e.attrs.since_force_ms) ?? 0)} after we ended their turn, so the rest of that answer went to the next question.`,
      fix: "Raise the silence wait (?turnms=5500) or the trailing-off allowance if this repeats.",
      atMs: rel(e.ms),
    });
  }
  for (const e of byName("avatar.simli.stopped")) {
    const msgs = Array.isArray(e.attrs.last_messages) ? (e.attrs.last_messages as unknown[]).join(" | ") : "";
    add({
      severity: "medium",
      title: `Avatar was stopped by Simli after ${secs(num(e.attrs.since_start_ms) ?? 0)}`,
      detail: `Simli ended the avatar session itself (${String(e.attrs.kind)}). Socket close: ${String(e.attrs.ws_close_code ?? "?")} ${String(e.attrs.ws_close_reason ?? "")}. Maya was last audible ${
        num(e.attrs.ms_since_maya_audible) != null ? secs(num(e.attrs.ms_since_maya_audible) as number) : "?"
      } before. Last Simli messages: ${msgs || "none captured"}.`,
      fix: "Compare this with your Simli dashboard (plan limits, session logs). If it happens during the candidate's silent stretches it is likely an idle rule; if at a fixed time, a plan/session limit.",
      atMs: rel(e.ms),
    });
  }
  // ── Recording / camera / proctoring performance (round 5: lag, frozen self-view, no recording) ──
  const recStarted = byName("recorder.started");
  const recFirstChunk = byName("recorder.first_chunk");
  const recProblems = [...byName("recorder.not_started"), ...byName("recorder.error"), ...byName("recorder.upload_failed")];
  // Only judge sessions that carry the new recorder telemetry (older ones never sent it).
  const hasRecorderTelemetry = recStarted.length + recProblems.length > 0;
  if (hasRecorderTelemetry && recFirstChunk.length === 0) {
    const why = recProblems[0];
    add({
      severity: "high",
      title: "No video was recorded",
      detail: why
        ? `The recorder reported: ${why.event_name.replace("recorder.", "")} ${JSON.stringify(why.attrs).slice(0, 140)}.`
        : "The recorder started but no video chunk was ever uploaded.",
      fix: "Check the camera events below; a frozen or ended camera, or an overloaded browser, stops recording.",
      atMs: why ? rel(why.ms) : undefined,
    });
  } else if (recProblems.length > 0) {
    add({
      severity: "medium",
      title: `Recording had ${recProblems.length} problem${recProblems.length === 1 ? "" : "s"}`,
      detail: recProblems.map((e) => `${e.event_name.replace("recorder.", "")} ${JSON.stringify(e.attrs).slice(0, 80)}`).join("; "),
      fix: "The video may have gaps.",
      atMs: rel(recProblems[0].ms),
    });
  }
  const frozen = byName("camera.frozen");
  const camEnded = byName("camera.track_ended");
  if (frozen.length > 0 || camEnded.length > 0) {
    const f = frozen[0] ?? camEnded[0];
    add({
      severity: "high",
      title: camEnded.length > 0 ? "The candidate's camera stopped" : `The candidate's video froze ${frozen.length}×`,
      detail: `${JSON.stringify(f.attrs).slice(0, 180)}. Recovered: ${byName("camera.recovered").length}×.`,
      fix: "Usually an overloaded browser or another app taking the camera. Compare with ?proctor=off on the link to rule out AI proctoring.",
      atMs: rel(f.ms),
    });
  }
  for (const e of byName("proctor.ai.unavailable")) {
    if (e.attrs.stage === "disabled_by_url") continue;
    add({
      severity: e.attrs.stage === "too_slow" ? "medium" : "low",
      title: e.attrs.stage === "too_slow" ? "AI proctoring switched itself off (machine too slow)" : "AI proctoring unavailable — basic checks only",
      detail: `Reason: ${String(e.attrs.stage)} ${e.attrs.error ? `(${String(e.attrs.error)})` : ""}${e.attrs.look_ms ? ` — one look took ${String(e.attrs.look_ms)} ms` : ""}.`,
      fix: "Face/phone checks fell back to the lightweight version for this interview; tab/paste/fullscreen checks still ran.",
      atMs: rel(e.ms),
    });
  }
  const reopened = byName("live.turn.answer_reopened");
  if (reopened.length > 0) {
    add({
      severity: "low",
      title: `Candidate kept talking after their turn was taken (${reopened.length}×) — answer merged`,
      detail: "Their extra words were folded into the same answer instead of being attributed to the next question.",
      fix: "Informational. Frequent → raise the silence wait (?turnms=5500).",
      atMs: rel(reopened[0].ms),
    });
  }
  const nudges = byName("live.question.nudged");
  if (nudges.length > 0) {
    add({
      severity: "medium",
      title: `Maya had to be nudged ${nudges.length}×`,
      detail: "Maya did not speak the next question within 6 seconds of being given it, so we re-sent it.",
      fix: "Occasional is expected; if it happens on most turns, GPT-Live is ignoring the line we hand it — check the 'Maya actually said' lines for what she said instead.",
      atMs: rel(nudges[0].ms),
    });
  }
  for (const e of byName("live.error")) {
    add({
      severity: "high",
      title: "Voice provider reported an error",
      detail: `OpenAI GPT-Live sent an error${typeof e.attrs.code === "string" ? ` (${e.attrs.code})` : ""}.`,
      fix: "Check the server log around this time and OpenAI status.",
      atMs: rel(e.ms),
    });
  }
  for (const e of byName("live.fallback")) {
    add({
      severity: "medium",
      title: "Live voice could not start — standard engine used",
      detail: `Reason: ${String(e.attrs.reason ?? "unknown")}. The interview continued with Deepgram + TTS.`,
      fix: "denied/budget reasons mean a spend guardrail blocked it (expected); provider or timeout reasons need a look.",
      atMs: rel(e.ms),
    });
  }
  for (const e of byName("avatar.simli.failed")) {
    add({
      severity: "medium",
      title: "Realistic avatar could not start — still photo shown",
      detail: `Reason: ${String(e.attrs.reason ?? "unknown")}. Maya's normal voice kept playing, so the interview itself was not affected.`,
      fix: "'mint_403/429/409' reasons are spend guardrails working (expected). 'start_failed' or provider errors: check the Simli key, face id and remaining minutes.",
      atMs: rel(e.ms),
    });
  }
  const setup = byName("live.session.started")[0];
  const opening = byName("live.opening.spoken")[0];
  const openMs = num(opening?.attrs.ms_from_click);
  if (openMs != null && openMs > 8_000) {
    add({
      severity: "medium",
      title: `Slow start (${secs(openMs)} before Maya spoke)`,
      detail: "The candidate waited this long between clicking Start and hearing Maya.",
      fix: "See the setup phases (mic/offer/ice/create/ready) in the metrics report to find the slow step.",
      atMs: 0,
    });
  } else if (setup && num(setup.attrs.setup_ms) != null && (num(setup.attrs.setup_ms) as number) > 7_000) {
    add({
      severity: "low",
      title: `Connection setup took ${secs(num(setup.attrs.setup_ms) as number)}`,
      detail: "Connecting to the voice service was slower than usual.",
      fix: "Check the candidate's network; see setup phases in the metrics report.",
      atMs: 0,
    });
  }

  // ── Network ──────────────────────────────────────────────────────────────
  const endMs = closed?.ms ?? t(input.session.completed_at) ?? Infinity;
  const lkDrops = events.filter(
    (e) =>
      e.event_name.startsWith("livekit.") &&
      /disconnect|reconnect|failed/i.test(e.event_name) &&
      e.ms < endMs - 5_000
  );
  if (lkDrops.length > 0) {
    add({
      severity: "high",
      title: `Video connection dropped ${lkDrops.length}×`,
      detail: "The candidate's video/mic connection to the room dropped during the interview.",
      fix: "Recording may have gaps. Ask the candidate to retry on a stable network.",
      atMs: rel(lkDrops[0].ms),
    });
  }

  // ── How it ended ──────────────────────────────────────────────────────────
  if (closeReason && !["complete", "early"].includes(closeReason)) {
    add({
      severity: closeReason === "pagehide" || closeReason === "reset" ? "medium" : "high",
      title: "Interview ended unexpectedly",
      detail: `It ended because ${CLOSE_REASON_TEXT[closeReason] ?? closeReason}.`,
      fix:
        closeReason === "idle"
          ? "The candidate stopped responding for 3 minutes."
          : closeReason === "cap"
            ? "The session hit the spend cap; raise LIVE_VOICE_MAX_SESSION_SECONDS if interviews legitimately run long."
            : "Check the timeline just before the end for the trigger.",
      atMs: closed ? rel(closed.ms) : undefined,
    });
  }
  if (input.session.exit_type === "early_exit") {
    add({
      severity: "low",
      title: "Candidate left early",
      detail: `The candidate pressed Leave after ${answers} answer${answers === 1 ? "" : "s"}.`,
      fix: "Review the last few turns for a reason (confusion, lag, frustration).",
    });
  }
  if (input.session.status === "in_progress") {
    const ageMin = (Date.now() - startMs) / 60_000;
    if (ageMin > 30) {
      add({
        severity: "high",
        title: "Interview never finished",
        detail: `It started ${Math.round(ageMin)} minutes ago and was never marked complete (the browser likely closed or crashed).`,
        fix: "No report was generated. The candidate may need a fresh invite.",
      });
    }
  }
  if (input.ledger?.usage_seconds != null && input.ledger.usage_seconds >= input.ledger.max_seconds - 30) {
    add({
      severity: "medium",
      title: "Voice session hit its time cap",
      detail: `Used ${input.ledger.usage_seconds}s of a ${input.ledger.max_seconds}s limit.`,
      fix: "Raise LIVE_VOICE_MAX_SESSION_SECONDS if interviews legitimately run this long.",
    });
  }

  // ── Content / setup ───────────────────────────────────────────────────────
  if (input.questionCount > 0 && input.questionCount < 5) {
    add({
      severity: "low",
      title: `Only ${input.questionCount} questions in this job`,
      detail: "Interviews for this job will be short (a few minutes).",
      fix: "Add more questions on the job's Questions tab if you want a longer interview.",
    });
  }
  const weak = byName("interview.weak_answer.signals").length;
  if (weak > 0) {
    add({
      severity: "low",
      title: `${weak} weak or "don't know" answer${weak === 1 ? "" : "s"}`,
      detail: "The candidate gave short, vague or 'I don't know' answers. This affects scoring, not the system.",
      fix: "Nothing to fix — informational.",
    });
  }

  // ── Proctoring ────────────────────────────────────────────────────────────
  const hi = input.proctor.filter((p) => p.severity === "high");
  if (input.proctor.length > 0) {
    const groups = input.proctor.reduce<Record<string, number>>((m, p) => {
      m[p.event_type] = (m[p.event_type] ?? 0) + 1;
      return m;
    }, {});
    add({
      severity: hi.length > 0 ? "high" : "low",
      title: `${input.proctor.length} proctoring event${input.proctor.length === 1 ? "" : "s"}`,
      detail: Object.entries(groups)
        .map(([k, n]) => `${k.replace(/_/g, " ")} ×${n}`)
        .join(", "),
      fix: "Review in the report's integrity panel.",
    });
    if ((input.session.integrity_score ?? 100) === 100) {
      add({
        severity: "low",
        title: "Integrity score doesn't reflect these events",
        detail: `The stored integrity score is ${input.session.integrity_score ?? 100}, but ${input.proctor.length} violation(s) were recorded. The score is set by the browser at the end (100 for a normal finish), not calculated from events.`,
        fix: "Known limitation: rely on the event list, or compute the score from events on the server.",
      });
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const highs = issues.filter((i) => i.severity === "high");
  const completed = input.session.status === "completed";
  let verdict: Diagnosis["verdict"];
  if (!completed) {
    verdict = {
      tone: input.session.status === "in_progress" ? "warn" : "warn",
      title: input.session.status === "in_progress" ? "Not finished" : `Status: ${input.session.status}`,
      detail: "This interview has not completed, so no report exists yet.",
    };
  } else if (highs.length > 0) {
    verdict = {
      tone: "bad",
      title: "Finished — with serious problems",
      detail: highs.map((h) => h.title).join("; "),
    };
  } else if (input.session.exit_type === "early_exit") {
    verdict = {
      tone: "warn",
      title: "Candidate left early",
      detail: `The candidate pressed Leave after ${answers} answer${answers === 1 ? "" : "s"}; the report is based on a partial interview.`,
    };
  } else if (issues.some((i) => i.severity === "medium")) {
    verdict = {
      tone: "warn",
      title: "Finished — with some hiccups",
      detail: "Nothing broke, but the candidate experience wasn't perfect. See issues below.",
    };
  } else {
    verdict = {
      tone: "ok",
      title: "Finished normally",
      detail: closeReason ? `Ended because ${CLOSE_REASON_TEXT[closeReason] ?? closeReason}.` : "No problems detected.",
    };
  }

  // ── Timeline ──────────────────────────────────────────────────────────────
  const timeline: TimelineItem[] = [];
  for (const turn of input.turns) {
    timeline.push({
      atMs: rel(t(turn.created_at) ?? startMs),
      kind: turn.role === "interviewer" ? "maya" : "candidate",
      label: turn.role === "interviewer" ? "Maya (intended line)" : "Candidate",
      text: turn.content,
    });
  }
  for (const e of events) {
    const at = rel(e.ms);
    switch (e.event_name) {
      case "live.maya.said":
        timeline.push({ atMs: at, kind: "maya_said", label: "Maya actually said", text: String(e.attrs.text ?? "") });
        break;
      case "live.session.started":
        timeline.push({ atMs: at, kind: "system", label: `Live voice connected (${secs(num(e.attrs.setup_ms) ?? 0)})` });
        break;
      case "live.opening.spoken":
        timeline.push({ atMs: at, kind: "latency", label: `Maya started speaking ${secs(num(e.attrs.ms_from_click) ?? 0)} after Start` });
        break;
      case "live.maya.first_audible": {
        const w = num(e.attrs.since_last_candidate_delta_ms);
        if (w != null) timeline.push({ atMs: at, kind: "latency", label: `Candidate heard a reply after ${secs(w)} of silence${e.attrs.ack ? " (acknowledgement)" : ""}` });
        break;
      }
      case "live.turn.completed": {
        const w = num(e.attrs.last_candidate_delta_to_commentary_ms);
        if (w != null) timeline.push({ atMs: at, kind: "latency", label: `Next question ready ${secs(w)} after the candidate stopped (${String(e.attrs.action)})` });
        break;
      }
      case "llm.turn.completed": {
        const w = num(e.attrs.last_transcript_to_question_ms);
        if (w != null) timeline.push({ atMs: at, kind: "latency", label: `Next question ready ${secs(w)} after the candidate's last words (${String(e.attrs.action)})` });
        break;
      }
      case "live.closing.audio":
        timeline.push({
          atMs: at,
          kind: e.attrs.delivered === false ? "error" : "system",
          label: `Waited ${secs(num(e.attrs.waited_ms) ?? 0)} for the goodbye (ended by ${String(e.attrs.ended_by)}${
            e.attrs.delivered === false ? " — goodbye NOT said" : e.attrs.delivered === true ? " — goodbye said" : ""
          })`,
        });
        break;
      case "live.turn.forced":
        timeline.push({ atMs: at, kind: "system", label: `We ended the candidate's turn after ${secs(num(e.attrs.silence_ms) ?? 0)} of silence (GPT-Live was still waiting)` });
        break;
      case "live.turn.force_regret":
        timeline.push({ atMs: at, kind: "error", label: "Candidate resumed speaking right after we ended their turn" });
        break;
      case "live.turn.delivery":
        if (e.attrs.delivered === false && e.attrs.candidate_spoke !== true) {
          timeline.push({ atMs: at, kind: "error", label: `Maya did NOT ask the intended question (${Math.round((num(e.attrs.ratio) ?? 0) * 100)}% of its words spoken)` });
        }
        break;
      case "live.delegation.stray":
        timeline.push({ atMs: at, kind: "system", label: `Ignored a duplicate request from GPT-Live (${String(e.attrs.why ?? "")})` });
        break;
      case "camera.frozen":
        timeline.push({ atMs: at, kind: "error", label: `Candidate video froze (${String(e.attrs.track_state)}, muted=${String(e.attrs.track_muted)})` });
        break;
      case "camera.recovered":
        timeline.push({ atMs: at, kind: "system", label: `Candidate video recovered after ${secs(num(e.attrs.frozen_ms) ?? 0)}` });
        break;
      case "camera.track_ended":
        timeline.push({ atMs: at, kind: "error", label: "Candidate camera stopped (track ended)" });
        break;
      case "recorder.started":
        timeline.push({ atMs: at, kind: "system", label: `Recording started (${String(e.attrs.mime)})` });
        break;
      case "recorder.not_started":
      case "recorder.error":
      case "recorder.upload_failed":
        timeline.push({ atMs: at, kind: "error", label: `Recording problem: ${e.event_name.replace("recorder.", "")} ${JSON.stringify(e.attrs).slice(0, 80)}` });
        break;
      case "proctor.ai.perf":
        timeline.push({ atMs: at, kind: "system", label: `AI proctoring: ${String(e.attrs.looks)} looks, avg ${String(e.attrs.avg_ms)} ms, max ${String(e.attrs.max_ms)} ms` });
        break;
      case "live.turn.answer_reopened":
        timeline.push({ atMs: at, kind: "system", label: "Candidate kept talking — answer re-opened and merged" });
        break;
      case "avatar.simli.stopped":
        timeline.push({ atMs: at, kind: "error", label: `Simli stopped the avatar (${String(e.attrs.kind)}, close ${String(e.attrs.ws_close_code ?? "?")})` });
        break;
      case "live.session.closed":
        timeline.push({ atMs: at, kind: "system", label: `Voice session closed — ${CLOSE_REASON_TEXT[String(e.attrs.reason)] ?? String(e.attrs.reason)} (${String(e.attrs.usage_seconds ?? "?")}s billed)` });
        break;
      case "live.question.nudged":
        timeline.push({ atMs: at, kind: "error", label: "Maya didn't speak the question — nudged" });
        break;
      case "live.turn.empty":
        timeline.push({ atMs: at, kind: "error", label: "Candidate's answer was empty / not captured" });
        break;
      case "live.error":
        timeline.push({ atMs: at, kind: "error", label: `Voice provider error ${String(e.attrs.code ?? "")}` });
        break;
      case "live.fallback":
        timeline.push({ atMs: at, kind: "error", label: `Live voice unavailable → standard engine (${String(e.attrs.reason ?? "")})` });
        break;
      case "avatar.simli.started":
        timeline.push({ atMs: at, kind: "system", label: `Realistic avatar rendering (started in ${secs(num(e.attrs.setup_ms) ?? 0)})` });
        break;
      case "avatar.simli.failed":
        timeline.push({ atMs: at, kind: "error", label: `Realistic avatar failed → still photo (${String(e.attrs.reason ?? "")})` });
        break;
      case "avatar.simli.closed":
        timeline.push({ atMs: at, kind: "system", label: `Avatar session closed — ${String(e.attrs.reason ?? "")} (${String(e.attrs.usage_seconds ?? "?")}s billed)` });
        break;
      case "ai.brain.completed":
        if (e.attrs.brain_fallback === true) timeline.push({ atMs: at, kind: "error", label: "AI timed out — fallback question used" });
        break;
      case "pipeline.turn.committed":
        timeline.push({
          atMs: at,
          kind: "system",
          label: `Answer taken (${String(e.attrs.reason)}, ${String(e.attrs.words)} words, quiet ${secs(num(e.attrs.quiet_ms) ?? 0)})`,
        });
        break;
      case "pipeline.ack.played":
        timeline.push({ atMs: at, kind: "maya_said", label: "Maya acknowledged instantly", text: String(e.attrs.ack ?? "") });
        break;
      case "pipeline.voice.started": {
        const w = num(e.attrs.last_word_to_voice_ms);
        timeline.push({
          atMs: at,
          kind: "latency",
          label:
            e.attrs.kind === "opening"
              ? "Maya started speaking (opening)"
              : `Maya's ${e.attrs.kind === "closing" ? "goodbye" : "next line"} started ${w != null ? `${secs(w)} after the candidate's last word` : ""}${
                  e.attrs.how === "text_only" ? " — TEXT ONLY (voice failed)" : ""
                }`,
        });
        break;
      }
      case "pipeline.late_merge":
        timeline.push({ atMs: at, kind: "system", label: `Candidate kept talking — ${String(e.attrs.late_words)} more words merged into the answer` });
        break;
      case "pipeline.barge_in":
        timeline.push({ atMs: at, kind: "system", label: `Candidate spoke over Maya ${secs((num(e.attrs.ms_into_line) ?? 0))} into her question — she stopped, same answer continued (mic level ${String(e.attrs.rms)})` });
        break;
      case "pipeline.repeat_request":
        timeline.push({ atMs: at, kind: "system", label: `Candidate asked Maya to repeat the question (“${String(e.attrs.heard ?? "")}”) — repeated, not scored` });
        break;
      case "pipeline.help_request":
        timeline.push({ atMs: at, kind: "system", label: `Candidate asked Maya to answer (“${String(e.attrs.heard ?? "")}”) — she explained she's an AI interviewer and kept listening` });
        break;
      case "pipeline.done_pressed":
        timeline.push({ atMs: at, kind: "system", label: `Candidate pressed “Done answering” (${String(e.attrs.words)} words)` });
        break;
      case "pipeline.nudge":
        timeline.push({ atMs: at, kind: "system", label: "Long silence — Maya said “Take your time”" });
        break;
      case "pipeline.tts.failed":
        timeline.push({ atMs: at, kind: "error", label: `Maya's voice failed (${String(e.attrs.error ?? "")}) — text shown` });
        break;
      case "pipeline.turn.failed":
      case "pipeline.listen.failed":
        timeline.push({ atMs: at, kind: "error", label: `${e.event_name === "pipeline.listen.failed" ? "Listening" : "AI turn"} failed: ${String(e.attrs.error ?? "")}` });
        break;
      default:
        if (e.event_name.startsWith("livekit.")) {
          timeline.push({ atMs: at, kind: /disconnect|fail|reconnect/i.test(e.event_name) ? "error" : "system", label: e.event_name.replace("livekit.", "Video: ").replace(/\./g, " ") });
        } else if (e.event_name === "interview.vad.interruption") {
          timeline.push({ atMs: at, kind: "system", label: "Candidate interrupted Maya" });
        }
    }
  }
  for (const p of input.proctor) {
    timeline.push({
      atMs: rel(t(p.created_at) ?? startMs),
      kind: "proctor",
      label: `Proctor: ${p.event_type.replace(/_/g, " ")}${p.severity ? ` (${p.severity})` : ""}`,
    });
  }
  timeline.sort((a, b) => a.atMs - b.atMs);

  const durationMin =
    t(input.session.completed_at) != null && t(input.session.started_at) != null
      ? ((t(input.session.completed_at) as number) - (t(input.session.started_at) as number)) / 60_000
      : null;
  const spendUsd =
    input.ledger?.usage_seconds != null ? (input.ledger.usage_seconds / 60) * 0.05 : null;

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.atMs ?? 0) - (b.atMs ?? 0));

  return { engine, verdict, stats: { durationMin, answers, spendUsd }, issues, timeline };
}
