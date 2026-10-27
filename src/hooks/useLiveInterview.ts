import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { SessionTelemetryApi } from "@/lib/telemetry/types";
import { DELIVERED_THRESHOLD, deliveryRatio, shouldForceTurn, shouldMergeLateSpeech } from "@/lib/live/turnTaking";
import { buildNudgeEvent, buildSpokenEvent } from "@/lib/live/events";
import type {
  AIStatus,
  CandidateListeningPhase,
  ConversationTurnPhase,
  InterviewState,
  LogEntry,
  TranscriptEntry,
  TurnOrchestrationState,
} from "./useInterview";

/**
 * EXPERIMENTAL — GPT-Live voice engine (branch experiment/gpt-live).
 *
 * Drop-in alternative to `useInterview`: same return shape, so the room page,
 * proctoring (`useProctor`) and recording (`useVideoRecorder`) are untouched.
 *
 *   mic (LiveKit track) ──WebRTC──► GPT-Live ◄──► candidate hears Maya
 *                                      │ session.delegation.created
 *                                      ▼
 *            our /api/sessions/[token]/turn  (unchanged brain: next | probe | close)
 *                                      │ session.commentary.append (question text)
 *                                      ▼
 *                                  GPT-Live speaks it
 *
 * Spend safety (all enforced server-side in /api/live/session, plus client timers here):
 *   - hard duration cap granted by the server (max_seconds); we stop at max_seconds - 20s
 *   - idle watchdog: no audio/transcript activity for IDLE_TIMEOUT_MS → end session
 *   - empty-answer guard: noise never triggers an LLM turn
 *   - ledger settled on close / unmount / pagehide
 * If the live session can't start (denied, provider error, Maya never speaks) the
 * hook calls `onFallback` so the caller starts the legacy Deepgram + TTS pipeline.
 */

interface UseLiveInterviewOptions {
  sessionToken: string;
  telemetry?: SessionTelemetryApi;
  /** Current LiveKit mic track — shared with the recorder so no second mic prompt. */
  getMicTrack: () => MediaStreamTrack | null;
  /** Live voice could not start before the interview began — run the legacy engine. */
  onFallback: (reason: string) => void;
}

type LiveEvent = { type: string; [key: string]: unknown };

const TURN_MAX_RETRIES = 2;
/** Stop this long before the granted cap so billable time never exceeds it. */
const CAP_SAFETY_MS = 20_000;
/** No candidate/Maya activity for this long → assume the candidate left. */
const IDLE_TIMEOUT_MS = 180_000;
/** Opening line must start playing within this window, else escalate then fall back. */
const OPENING_WAIT_MS = 7_000;
/** Treat Maya as "speaking" until transcript deltas stop for this long. */
const SPEAKING_QUIET_MS = 1_500;
/** Candidate "speaking" indicator hold time after the last transcript delta. */
const CANDIDATE_QUIET_MS = 900;
/** After a delegation fires, wait for trailing input transcript deltas to settle. */
const TRANSCRIPT_SETTLE_QUIET_MS = 350;
const TRANSCRIPT_SETTLE_MAX_MS = 1_200;
/** Hard ceiling on interview turns even if the server never says "close". */
const MAX_CLIENT_TURNS = 16;
/** Consecutive empty candidate turns before we stop paying for silence. */
const MAX_EMPTY_TURNS = 4;
const ICE_GATHER_TIMEOUT_MS = 3_000;
/**
 * OUR end-of-turn fallback. GPT-Live decides on its own when the candidate is done and, on real
 * interviews, kept waiting until the candidate said "…yeah, that's all". If the candidate has been
 * silent this long after a real answer (and Maya isn't speaking), we hand the turn to our brain
 * ourselves. Trailing off mid-thought ("…and", "…um") earns extra time. Override per link for tuning:
 * `?turnms=3000`, or disable with `?force=off`.
 */
const FORCE_TURN_BASE_MS = 4_000;
const FORCE_TURN_TRAIL_EXTRA_MS = 2_500;
const FORCE_TURN_MIN_WORDS = 4;
/** Maya must have been quiet (transcript AND audio) this long before we step in. */
const FORCE_TURN_MAYA_QUIET_MS = 1_500;
/** Candidate speaks again within this long of a forced turn → we cut them off; log it for tuning. */
const FORCE_REGRET_WINDOW_MS = 5_000;
/** A model delegation this soon after a turn we already handled is a duplicate, not a new answer. */
const STRAY_DELEGATION_WINDOW_MS = 20_000;
/** If our brain is still thinking after this long, tell Maya (silently) to keep waiting — she improvises otherwise. */
const SLOW_TURN_HINT_MS = 3_000;
/** Delivery check: she has been quiet this long without saying the intended line → nudge once. */
const DELIVERY_QUIET_NUDGE_MS = 4_500;
/** Give up verifying delivery of a normal question after this long. */
const DELIVERY_MAX_WAIT_MS = 16_000;
/** After a nudge, wait this long for the line to be spoken before giving up. */
const DELIVERY_AFTER_NUDGE_MS = 10_000;
/**
 * Output audio level (0..1 RMS) above which we consider Maya audibly speaking. Speech is
 * typically 0.05–0.2; an idle stream is ~0. We meter the real audio because her transcript
 * text streams out FASTER than the audio plays — using "no new text for N seconds" as the
 * end-of-speech signal ended the interview mid-sentence (goodbye cut off after ~6s).
 */
const AUDIBLE_RMS = 0.012;
/** Silence required after her goodbye audio before we close (natural pauses are < ~1s). */
const CLOSING_SILENCE_MS = 1_800;
/** Never wait longer than this for the goodbye to be delivered and finish, whatever the meter says. */
const CLOSING_MAX_WAIT_MS = 35_000;
/** Small tail so the last syllable isn't clipped by the connection closing. */
const CLOSING_TAIL_MS = 600;
/**
 * When a lip-sync avatar renders Maya, what the candidate sees/hears runs behind the raw GPT-Live
 * audio we meter (render + network latency, typically < 1s). Wait this much longer before closing.
 */
const AVATAR_EXTRA_TAIL_MS = 1_800;

// NOTE on the "Mm-hm" acknowledgement: it is voiced by the MODEL (see instructions.ts), never sent by
// us as a commentary. We tried sending it as a commentary: GPT-Live treats a delegation's first
// commentary as its RESULT, so the real question that followed was not spoken (see events.ts).

let logId = 0;
function timestamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function useLiveInterview({
  sessionToken,
  telemetry,
  getMicTrack,
  onFallback,
}: UseLiveInterviewOptions) {
  const [state, setState] = useState<InterviewState>("idle");
  const [aiStatus, setAIStatus] = useState<AIStatus>("waiting");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [transcript, setTranscript] = useState("");
  const [turns, setTurns] = useState<TranscriptEntry[]>([]);
  const [turnIndex, setTurnIndex] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [candidateListeningPhase, setCandidateListeningPhase] =
    useState<CandidateListeningPhase>("idle");
  const [turnState, setTurnState] = useState<TurnOrchestrationState>("LISTENING");

  // Everything async reads refs, never stale closure state.
  const stateRef = useRef<InterviewState>("idle");
  const turnIdxRef = useRef(0);
  const traceIdRef = useRef<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const ownedMicRef = useRef<MediaStream | null>(null);
  const liveSessionIdRef = useRef<string | null>(null);
  const maxSecondsRef = useRef(0);
  const sessionStartedAtRef = useRef(0);
  const usageSecondsRef = useRef(0);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastActivityRef = useRef(0);
  const inputBufferRef = useRef("");
  const lastInputDeltaAtRef = useRef(0);
  const lastOutputDeltaAtRef = useRef(0);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlingDelegationRef = useRef(false);
  const emptyTurnsRef = useRef(0);
  const turnFailuresRef = useRef(0);
  const clientTurnsRef = useRef(0);
  const closingRef = useRef(false);
  const finishedRef = useRef(false);
  const teardownDoneRef = useRef(false);
  const seenEventTypesRef = useRef<Set<string>>(new Set());
  const errorCountRef = useRef(0);
  const clickAtRef = useRef(0);
  const lastCandidateDeltaForTurnRef = useRef(0);
  /** Per-turn timing so we can log how long the candidate waited before hearing ANY reply. */
  const turnTimingRef = useRef<{
    delegationAt: number;
    lastCandidateDeltaAt: number;
    ack: boolean;
    logged: boolean;
    audibleLogged: boolean;
  } | null>(null);
  const setupPhasesRef = useRef<Record<string, number>>({});
  // Real playback meter on Maya's incoming audio (see AUDIBLE_RMS).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAudibleAtRef = useRef(0);
  /** True once the meter has actually heard audio this session (so we know it works). */
  const meterHeardRef = useRef(false);
  /** What Maya actually said (her output transcript) — differs from what our server intended. */
  const spokenBufferRef = useRef("");
  /** Maya's incoming audio track — handed to the lip-sync avatar (Simli) when one is active. */
  const [remoteAudioTrack, setRemoteAudioTrack] = useState<MediaStreamTrack | null>(null);
  /** True while a lip-sync avatar is the thing the candidate sees/hears (raw audio muted). */
  const avatarRenderingRef = useRef(false);
  /** Simli's own "speaking/silent" events — the truth about what the candidate is still hearing. */
  const avatarSpeakingRef = useRef(false);
  const avatarSilentSinceRef = useRef(0);
  /** Every output-transcript chunk with its time, so we can ask "what did she say since T?". */
  const spokenLogRef = useRef<Array<{ t: number; text: string }>>([]);
  /** Our silence-based end-of-turn watcher (see FORCE_TURN_*). */
  const turnWatcherRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTurnHandledAtRef = useRef(0);
  /** How many times the current answer has been re-opened because the candidate kept talking. */
  const lateMergesRef = useRef(0);
  const forcedAtRef = useRef(0);
  const forceRegretLoggedRef = useRef(true);
  const sessionReadyRef = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const openingPendingRef = useRef(false);
  const telemetryRef = useRef(telemetry);
  telemetryRef.current = telemetry;
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;
  const getMicTrackRef = useRef(getMicTrack);
  getMicTrackRef.current = getMicTrack;
  const sessionTokenRef = useRef(sessionToken);
  sessionTokenRef.current = sessionToken;

  const addLog = useCallback((level: LogEntry["level"], step: string, message: string) => {
    setLogs((prev) => [...prev, { id: ++logId, time: timestamp(), level, step, message }]);
  }, []);

  const setStateSynced = useCallback((s: InterviewState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const setTurnIndexSynced = useCallback((n: number) => {
    turnIdxRef.current = n;
    setTurnIndex(n);
  }, []);

  const track = useCallback(
    (event_name: string, attrs?: Record<string, unknown>) => {
      telemetryRef.current?.enqueue({
        event_name,
        attrs: { engine: "live", ...attrs },
        trace_id: traceIdRef.current,
        turn_index: turnIdxRef.current,
        interview_state: stateRef.current,
      });
    },
    []
  );

  /** Persist what Maya really said (her transcript), so a debugger can compare it to what we intended. */
  const flushSpoken = useCallback(
    (label: string) => {
      const text = spokenBufferRef.current.replace(/\s+/g, " ").trim();
      spokenBufferRef.current = "";
      if (text) track("live.maya.said", { text: text.slice(0, 900), label });
    },
    [track]
  );

  const stopMeter = useCallback(() => {
    if (meterTimerRef.current) clearInterval(meterTimerRef.current);
    meterTimerRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) void ctx.close().catch(() => {});
  }, []);

  /** Analyse Maya's incoming audio level (analysis only — not routed to speakers, so no double playback). */
  const startMeter = useCallback(
    (stream: MediaStream) => {
      try {
        stopMeter();
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        audioCtxRef.current = ctx;
        void ctx.resume().catch(() => {});
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        meterTimerRef.current = setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          if (Math.sqrt(sum / buf.length) <= AUDIBLE_RMS) return;
          const now = Date.now();
          lastAudibleAtRef.current = now;
          meterHeardRef.current = true;
          // The truthful "how long was the candidate in silence" number: first AUDIBLE reply sound
          // after the delegation (transcript text arrives slightly before the audio is heard).
          const tt = turnTimingRef.current;
          if (tt && !tt.audibleLogged) {
            tt.audibleLogged = true;
            track("live.maya.first_audible", {
              since_delegation_ms: now - tt.delegationAt,
              since_last_candidate_delta_ms: tt.lastCandidateDeltaAt ? now - tt.lastCandidateDeltaAt : null,
              ack: tt.ack,
            });
          }
        }, 100);
      } catch {
        /* meter is best-effort — closing falls back to a duration estimate */
      }
    },
    [stopMeter, track]
  );

  const appendTurn = useCallback(
    (role: "interviewer" | "candidate", content: string, idx: number) => {
      setTurns((prev) => [...prev, { role, content, turnIndex: idx }]);
    },
    []
  );

  const sendEvent = useCallback((event: Record<string, unknown>): boolean => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return false;
    try {
      dc.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (capTimerRef.current) clearTimeout(capTimerRef.current);
    if (idleTimerRef.current) clearInterval(idleTimerRef.current);
    if (turnWatcherRef.current) clearInterval(turnWatcherRef.current);
    if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
    if (candidateTimerRef.current) clearTimeout(candidateTimerRef.current);
    capTimerRef.current = null;
    idleTimerRef.current = null;
    turnWatcherRef.current = null;
    speakingTimerRef.current = null;
    candidateTimerRef.current = null;
  }, []);

  /** Settle the spend ledger. keepalive so it still goes out during page unload. */
  const settleLedger = useCallback((reason: string) => {
    const id = liveSessionIdRef.current;
    if (!id) return;
    liveSessionIdRef.current = null;
    const usage =
      usageSecondsRef.current ||
      (sessionStartedAtRef.current
        ? Math.round((Date.now() - sessionStartedAtRef.current) / 1000)
        : 0);
    void fetch(`/api/live/session/${id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: sessionTokenRef.current, usage_seconds: usage, reason }),
      keepalive: true,
    }).catch(() => {});
    track("live.session.closed", { reason, usage_seconds: usage });
  }, [track]);

  /**
   * Idempotent. Politely closes the provider session (so final usage is reported and
   * billing stops), then drops the transport and settles our ledger.
   */
  const teardown = useCallback(
    async (reason: string) => {
      if (teardownDoneRef.current) return;
      teardownDoneRef.current = true;
      flushSpoken("teardown");
      clearTimers();
      stopMeter();
      sessionReadyRef.current = null;

      // Ask the provider to close so billing stops immediately and usage is final.
      sendEvent({ type: "session.close" });
      const dc = dcRef.current;
      if (dc && dc.readyState === "open") {
        await Promise.race([
          new Promise<void>((resolve) => {
            const onMsg = (m: MessageEvent) => {
              try {
                if ((JSON.parse(m.data) as LiveEvent).type === "session.closed") {
                  dc.removeEventListener("message", onMsg);
                  resolve();
                }
              } catch {
                /* ignore */
              }
            };
            dc.addEventListener("message", onMsg);
          }),
          sleep(2_000),
        ]);
      }

      try { dcRef.current?.close(); } catch { /* ignore */ }
      try { pcRef.current?.close(); } catch { /* ignore */ }
      dcRef.current = null;
      pcRef.current = null;
      if (audioElRef.current) {
        try { audioElRef.current.pause(); audioElRef.current.srcObject = null; } catch { /* ignore */ }
        audioElRef.current = null;
      }
      // Only stop a mic stream WE opened; the LiveKit track belongs to the room.
      ownedMicRef.current?.getTracks().forEach((t) => t.stop());
      ownedMicRef.current = null;
      setRemoteAudioTrack(null);
      avatarRenderingRef.current = false;
      settleLedger(reason);
    },
    [clearTimers, flushSpoken, sendEvent, settleLedger, stopMeter]
  );

  const postEnd = useCallback((earlyExit: boolean, integrity: number) => {
    return fetch(`/api/sessions/${sessionTokenRef.current}/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        earlyExit ? { integrity_score: integrity, early_exit: true } : { integrity_score: integrity }
      ),
    }).catch((err) => console.error("End session failed:", err));
  }, []);

  /** Single exit path: stop paying, mark completed, save the report. */
  const finishInterview = useCallback(
    async (kind: "complete" | "cap" | "idle" | "early" | "stalled") => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      closingRef.current = true;
      addLog(kind === "complete" ? "success" : "warn", "FLOW", `Interview finishing (${kind})`);
      setStateSynced("completed");
      setAIStatus("waiting");
      setCandidateListeningPhase("idle");
      // Mirrors the legacy engine: normal finish = 100, candidate-pressed leave = 50.
      // System-caused stops (cap / idle / stalled) are not the candidate's fault → 100.
      const endPromise =
        kind === "complete"
          ? postEnd(false, 100)
          : kind === "early"
            ? postEnd(true, 50)
            : postEnd(true, 100);
      await teardown(kind);
      await endPromise;
    },
    [addLog, postEnd, setStateSynced, teardown]
  );

  // ─── Transcript / activity bookkeeping ─────────────────────────────────────

  const markActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  const noteMayaSpeaking = useCallback(() => {
    const now = Date.now();
    lastOutputDeltaAtRef.current = now;
    markActivity();
    // The headline UX number: how long did the candidate sit in silence before hearing ANY reply
    // (the acknowledgement if enabled, otherwise the question itself)? Measured from the last
    // transcript text we received, so it slightly under-counts true silence (STT lags audio).
    const tt = turnTimingRef.current;
    if (tt && !tt.logged) {
      tt.logged = true;
      track("live.maya.first_audio", {
        since_delegation_ms: now - tt.delegationAt,
        since_last_candidate_delta_ms: tt.lastCandidateDeltaAt ? now - tt.lastCandidateDeltaAt : null,
        ack: tt.ack,
      });
    }
    if (stateRef.current !== "completed" && stateRef.current !== "error") {
      setStateSynced("speaking");
      setAIStatus("speaking");
      setTurnState("AI_SPEAKING");
      setCandidateListeningPhase("idle");
    }
    if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
    speakingTimerRef.current = setTimeout(() => {
      if (stateRef.current === "speaking" && !closingRef.current && !handlingDelegationRef.current) {
        setStateSynced("listening");
        setAIStatus("listening");
        setTurnState("LISTENING");
      }
    }, SPEAKING_QUIET_MS);
  }, [markActivity, setStateSynced, track]);

  const noteCandidateSpeaking = useCallback(
    (delta: string) => {
      const now = Date.now();
      // Did we just cut the candidate off? (They started talking again right after a forced turn.)
      if (!forceRegretLoggedRef.current && forcedAtRef.current && now - forcedAtRef.current < FORCE_REGRET_WINDOW_MS) {
        forceRegretLoggedRef.current = true;
        track("live.turn.force_regret", { since_force_ms: now - forcedAtRef.current });
      }
      lastInputDeltaAtRef.current = now;
      lastCandidateDeltaForTurnRef.current = now;
      markActivity();
      inputBufferRef.current += delta;
      setTranscript(inputBufferRef.current.replace(/\s+/g, " ").trim());
      setCandidateListeningPhase("speaking");
      if (candidateTimerRef.current) clearTimeout(candidateTimerRef.current);
      candidateTimerRef.current = setTimeout(() => {
        setCandidateListeningPhase("pause");
      }, CANDIDATE_QUIET_MS);
    },
    [markActivity, track]
  );

  /** Transcription lags audio — wait until trailing input deltas stop before reading the answer. */
  const settleInputTranscript = useCallback(async () => {
    const start = Date.now();
    while (Date.now() - start < TRANSCRIPT_SETTLE_MAX_MS) {
      if (Date.now() - lastInputDeltaAtRef.current >= TRANSCRIPT_SETTLE_QUIET_MS) break;
      await sleep(80);
    }
  }, []);

  // ─── Delegation: the candidate finished a turn → our brain decides ─────────

  const sendSpoken = useCallback(
    (delegationId: string | null, content: string): boolean =>
      sendEvent({ ...buildSpokenEvent(delegationId, content, crypto.randomUUID()) }),
    [sendEvent]
  );

  /** Everything Maya has said since `ts` (her output transcript, which leads the audio). */
  const spokenSince = useCallback((ts: number): string => {
    let out = "";
    for (const c of spokenLogRef.current) if (c.t >= ts) out += c.text;
    return out;
  }, []);

  /**
   * Re-send a line Maya didn't say, as a plain commentary with no delegation id (the channel that
   * reliably speaks the opening). NEVER via instructions.append: that is permanent, and each nudge
   * was replayed on the next turn, so she kept asking the previous question. See events.ts.
   */
  const nudgeToSay = useCallback(
    (kind: "question" | "goodbye", text: string) => {
      addLog("warn", "LIVE", `Maya did not say the ${kind} — nudging once`);
      track("live.question.nudged", { kind });
      sendEvent({ ...buildNudgeEvent(text, crypto.randomUUID()) });
    },
    [addLog, sendEvent, track]
  );

  /**
   * GPT-Live may paraphrase, improvise, or ignore the line we hand it (it once invented a question
   * and never said the goodbye). So after handing over a question we check what was ACTUALLY said:
   * delivered = enough of the intended words were spoken. If she goes quiet without saying it, nudge once.
   */
  const verifyDelivery = useCallback(
    async (sentAt: number, question: string, reveal: () => void) => {
      // The question appears in the right-hand panel only once Maya has actually started saying it
      // (or verification ends). Showing it the moment our server produced it made the panel and her
      // voice disagree whenever she was late or said something else. `reveal` runs exactly once.
      let revealed = false;
      const revealOnce = () => {
        if (revealed) return;
        revealed = true;
        reveal();
      };
      const start = Date.now();
      let nudgedAt = 0;
      let ratio = 0;
      let candidateSpoke = false;
      try {
        while (Date.now() - start < DELIVERY_MAX_WAIT_MS) {
          await sleep(250);
          if (finishedRef.current || teardownDoneRef.current) return;
          const now = Date.now();
          ratio = deliveryRatio(question, spokenSince(sentAt + 200));
          if (ratio >= DELIVERED_THRESHOLD) break;
          // The candidate started answering — they heard enough (or interrupted); stop policing.
          if (lastInputDeltaAtRef.current > sentAt + 800) {
            candidateSpoke = true;
            break;
          }
          const quietFor = now - lastOutputDeltaAtRef.current;
          if (!nudgedAt && quietFor > DELIVERY_QUIET_NUDGE_MS && now - start > 2_000) {
            nudgedAt = now;
            nudgeToSay("question", question);
          } else if (nudgedAt && now - nudgedAt > DELIVERY_AFTER_NUDGE_MS && quietFor > 3_000) {
            break;
          }
        }
        // Reveal once she has started saying it (ratio) — the loop's `break` lands here; while
        // she is still silent the panel keeps showing the PREVIOUS question, matching what's heard.
        revealOnce();
        track("live.turn.delivery", {
          ratio: Number(ratio.toFixed(2)),
          delivered: ratio >= DELIVERED_THRESHOLD,
          nudged: nudgedAt > 0,
          ...(candidateSpoke ? { candidate_spoke: true } : {}),
          spoken: spokenSince(sentAt + 200).slice(0, 300),
        });
      } finally {
        // Whatever happened (timeout, finish, teardown) the intended question must end up on screen.
        revealOnce();
      }
    },
    [nudgeToSay, spokenSince, track]
  );

  /**
   * Hold the connection open until the goodbye has really been said AND heard. Both must be true:
   *   1. delivered — enough of the goodbye's words appear in what she said (not an improvised question);
   *   2. finished  — her audio (and the avatar's, if one is rendering her) has been silent a moment.
   * If she goes quiet without saying it, nudge once. Always bounded by CLOSING_MAX_WAIT_MS.
   */
  const awaitGoodbye = useCallback(
    async (tSent: number, text: string) => {
      const waitStart = Date.now();
      const words = text.split(/\s+/).filter(Boolean).length;
      const estimateMs = 2_500 + words * 400;
      const meterWorks = meterHeardRef.current; // it already heard her opening/questions
      let nudgedAt = 0;
      let ratio = 0;
      let endedBy: "silence" | "estimate" | "undelivered" | "max_wait" = "max_wait";

      while (Date.now() - waitStart < CLOSING_MAX_WAIT_MS) {
        await sleep(200);
        const now = Date.now();
        ratio = deliveryRatio(text, spokenSince(tSent + 200));
        const delivered = ratio >= DELIVERED_THRESHOLD;
        const quietFor = now - lastOutputDeltaAtRef.current;

        if (!delivered) {
          if (!nudgedAt && quietFor > DELIVERY_QUIET_NUDGE_MS && now - waitStart > 2_500) {
            nudgedAt = now;
            nudgeToSay("goodbye", text);
          } else if (nudgedAt && now - nudgedAt > DELIVERY_AFTER_NUDGE_MS && quietFor > 3_000) {
            endedBy = "undelivered"; // she still won't say it; don't hang the candidate forever
            break;
          }
          continue;
        }

        const audioQuiet = meterWorks
          ? now - lastAudibleAtRef.current > CLOSING_SILENCE_MS
          : now - waitStart > estimateMs;
        // NOTE: we deliberately do NOT wait for Simli's "silent" event — in streaming mode Simli never
        // sent it, so every goodbye sat until CLOSING_MAX_WAIT_MS (37.5 s measured). The avatar's lag
        // behind the raw audio is covered by AVATAR_EXTRA_TAIL_MS below instead.
        if (audioQuiet) {
          endedBy = meterWorks ? "silence" : "estimate";
          break;
        }
      }
      await sleep(CLOSING_TAIL_MS + (avatarRenderingRef.current ? AVATAR_EXTRA_TAIL_MS : 0));
      const delivered = ratio >= DELIVERED_THRESHOLD;
      track("live.closing.audio", {
        avatar: avatarRenderingRef.current,
        ended_by: endedBy,
        meter_works: meterWorks,
        delivered,
        delivery_ratio: Number(ratio.toFixed(2)),
        nudged: nudgedAt > 0,
        waited_ms: Date.now() - waitStart,
        estimate_ms: estimateMs,
        words,
        spoken: spokenSince(tSent + 200).slice(0, 300),
      });
      return { delivered, endedBy };
    },
    [nudgeToSay, spokenSince, track]
  );

  /**
   * GPT-Live handed us a delegation we can't process right now (a turn is already in flight, or we
   * already handled that answer via our own silence timer). Leaving it unanswered can leave the model
   * waiting forever, so resolve it with a silent no-op.
   */
  const resolveStray = useCallback(
    (delegationId: string, why: string) => {
      track("live.delegation.stray", { why });
      sendEvent({
        type: "session.thinking.append",
        event_id: crypto.randomUUID(),
        delegation_id: delegationId,
        content: "This request was already handled and the next line has been given. Say nothing for it.",
      });
    },
    [sendEvent, track]
  );

  /**
   * One candidate turn → our brain → Maya.
   * `delegationId` is GPT-Live's request; it is null when WE ended the turn (silence timer), in which
   * case `forced` carries how long the candidate had been silent.
   */
  const handleDelegation = useCallback(
    async (delegationId: string | null, forced?: { silenceMs: number }) => {
      if (finishedRef.current || closingRef.current) return;
      if (handlingDelegationRef.current) {
        if (delegationId) resolveStray(delegationId, "turn_in_flight");
        return;
      }
      // A delegation for an answer we already took ourselves (silence timer), with no new speech
      // since: resolve it silently instead of treating it as an empty turn.
      if (
        delegationId &&
        !inputBufferRef.current.trim() &&
        Date.now() - lastTurnHandledAtRef.current < STRAY_DELEGATION_WINDOW_MS &&
        Date.now() - lastInputDeltaAtRef.current > 1_500
      ) {
        resolveStray(delegationId, "already_handled");
        return;
      }
      handlingDelegationRef.current = true;
      const tDelegation = Date.now();
      turnTimingRef.current = {
        delegationAt: tDelegation,
        lastCandidateDeltaAt: lastInputDeltaAtRef.current,
        ack: false,
        logged: false,
        audibleLogged: false,
      };
      flushSpoken("before_turn"); // what Maya said since the last delegation (her ack + question)
      try {
        setStateSynced("processing");
        setAIStatus("thinking");
        setTurnState("FINALIZING");
        setCandidateListeningPhase("committing");
        await settleInputTranscript();

        const answer = inputBufferRef.current.replace(/\s+/g, " ").trim();
        inputBufferRef.current = "";
        setTranscript("");

        if (answer.length < 2) {
          emptyTurnsRef.current += 1;
          addLog("warn", "STT", `Empty candidate turn (${emptyTurnsRef.current}/${MAX_EMPTY_TURNS}) — no LLM call`);
          track("live.turn.empty", { count: emptyTurnsRef.current });
          if (emptyTurnsRef.current >= MAX_EMPTY_TURNS) {
            void finishInterview("stalled");
            return;
          }
          // Plain speech, not an instruction: commentary is what Maya says, so she'd read a meta-line aloud.
          sendSpoken(delegationId, "Sorry, I didn't catch that. Could you say your answer again?");
          return;
        }
        emptyTurnsRef.current = 0;
        clientTurnsRef.current += 1;
        if (clientTurnsRef.current > MAX_CLIENT_TURNS) {
          addLog("warn", "FLOW", "Client turn ceiling reached — ending interview");
          void finishInterview("cap");
          return;
        }
        lastTurnHandledAtRef.current = Date.now();
        if (forced) {
          forcedAtRef.current = Date.now();
          forceRegretLoggedRef.current = false;
          addLog("info", "FLOW", `Ending the candidate's turn ourselves after ${(forced.silenceMs / 1000).toFixed(1)}s of silence`);
          track("live.turn.forced", {
            silence_ms: Math.round(forced.silenceMs),
            words: answer.split(/\s+/).filter(Boolean).length,
          });
        }

        const currentIdx = turnIdxRef.current;
        appendTurn("candidate", answer, currentIdx);
        addLog("info", "STT", `Candidate: "${answer.slice(0, 100)}"`);

        // No client-sent acknowledgement here: the real reply must be the FIRST and ONLY commentary
        // for this delegation (see events.ts). The model voices its own "Mm-hm" (instructions.ts).
        const ackSent = false;

        let res: Response | null = null;
        const tLlm = Date.now();
        // If our brain is slow, GPT-Live fills the silence by improvising (it once asked an invented
        // question during a 7s wait). Tell it, silently, to keep waiting.
        const slowHint = setTimeout(() => {
          sendEvent({
            type: "session.thinking.append",
            event_id: crypto.randomUUID(),
            delegation_id: delegationId,
            content: "The backend is still preparing the next line. Stay silent and do not ask or say anything until it arrives.",
          });
          track("live.turn.slow_hint");
        }, SLOW_TURN_HINT_MS);
        try {
          for (let attempt = 1; attempt <= TURN_MAX_RETRIES; attempt++) {
            if (attempt > 1) await sleep(800);
            try {
              res = await fetch(`/api/sessions/${sessionTokenRef.current}/turn`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  candidate_answer: answer,
                  turn_index: currentIdx,
                  timestamp_ms: Date.now(),
                  trace_id: traceIdRef.current,
                }),
              });
              if (res.ok || res.status < 500) break;
            } catch {
              /* retry */
            }
          }
        } finally {
          clearTimeout(slowHint);
        }

        if (!res || !res.ok) {
          turnFailuresRef.current += 1;
          addLog("error", "LLM", `Turn API failed (${res?.status ?? "network"})`);
          if (turnFailuresRef.current >= 2) {
            setStateSynced("error");
            void teardown("turn_failed");
            return;
          }
          sendSpoken(delegationId, "Sorry, something went wrong on our side. Could you repeat your last answer?");
          return;
        }
        turnFailuresRef.current = 0;

        const data = await res.json();
        if (typeof data.trace_id === "string") traceIdRef.current = data.trace_id;
        const action: string = data.action;
        const question: string = data.question ?? "";
        const nextIdx: number = data.turn_index ?? currentIdx + 1;
        const llmMs = Date.now() - tLlm;
        addLog("success", "LLM", `Action: ${action} — "${question.slice(0, 80)}" (${llmMs}ms)`);

        const isClosing = action === "close" || data.is_closing === true;

        // The candidate kept talking after we took their answer and before Maya got the next line
        // (e.g. "…I don't know" said right after our silence timer fired). That speech belongs to THIS
        // answer: discard the brain's reply, fold the earlier part back in, and wait for them to finish.
        // The next submit reuses the same turn index, so the server overwrites the answer (and its score).
        const lateSpeech = inputBufferRef.current.replace(/\s+/g, " ").trim();
        if (shouldMergeLateSpeech(lateSpeech, lateMergesRef.current)) {
          lateMergesRef.current += 1;
          inputBufferRef.current = `${answer} ${inputBufferRef.current}`;
          setTranscript(inputBufferRef.current.replace(/\s+/g, " ").trim());
          setTurns((prev) =>
            prev.length && prev[prev.length - 1].role === "candidate" ? prev.slice(0, -1) : prev
          );
          if (delegationId) resolveStray(delegationId, "answer_reopened");
          addLog("info", "FLOW", "Candidate kept talking — merging with their previous words, not moving on yet");
          track("live.turn.answer_reopened", {
            forced: !!forced,
            late_words: lateSpeech.split(/\s+/).length,
            discarded_action: action,
          });
          setStateSynced("listening");
          setAIStatus("listening");
          setTurnState("LISTENING");
          return; // turnIdxRef is unchanged, so the merged answer resubmits under the same turn
        }
        lateMergesRef.current = 0;

        setTurnIndexSynced(nextIdx);
        // Neither a question nor the goodbye is shown in the panel yet: each appears once Maya has
        // actually started saying it (verifyDelivery / awaitGoodbye below), so what the candidate
        // reads always matches what they hear.
        if (isClosing) closingRef.current = true;

        const sent = sendSpoken(delegationId, question);
        const tSent = Date.now();
        track("live.turn.completed", {
          action,
          ack: ackSent,
          llm_roundtrip_ms: llmMs,
          delegation_to_commentary_ms: tSent - tDelegation,
          // candidate's last transcript word → we hand Maya the next line
          last_candidate_delta_to_commentary_ms: lastCandidateDeltaForTurnRef.current
            ? tSent - lastCandidateDeltaForTurnRef.current
            : null,
        });
        if (!sent) {
          addLog("error", "FLOW", "Live data channel closed before the reply could be sent");
          setStateSynced("error");
          return;
        }

        if (!isClosing) {
          void verifyDelivery(tSent, question, () => {
            setCurrentQuestion(question);
            appendTurn("interviewer", question, nextIdx);
          });
        }

        if (isClosing) {
          // Close only after the goodbye has really been said AND heard (see awaitGoodbye).
          const result = await awaitGoodbye(tSent, question);
          if (result.delivered) {
            setCurrentQuestion(question);
            appendTurn("interviewer", question, nextIdx);
          }
          await finishInterview("complete");
        }
      } catch (err) {
        addLog("error", "FLOW", `handleDelegation error: ${err instanceof Error ? err.message : String(err)}`);
        setStateSynced("error");
        void teardown("delegation_error");
      } finally {
        handlingDelegationRef.current = false;
      }
    },
    [
      addLog,
      appendTurn,
      finishInterview,
      flushSpoken,
      sendSpoken,
      setStateSynced,
      setTurnIndexSynced,
      settleInputTranscript,
      teardown,
      track,
      verifyDelivery,
      awaitGoodbye,
      resolveStray,
      sendEvent,
    ]
  );

  // ─── Provider event stream ─────────────────────────────────────────────────

  const handleEvent = useCallback(
    (ev: LiveEvent) => {
      // Log each distinct event type once — makes the real event stream visible while piloting.
      if (!seenEventTypesRef.current.has(ev.type)) {
        seenEventTypesRef.current.add(ev.type);
        addLog("info", "LIVE", `event: ${ev.type}`);
      }
      switch (ev.type) {
        case "session.started":
          sessionReadyRef.current?.resolve();
          sessionReadyRef.current = null;
          break;
        case "session.input_transcript.delta": {
          const delta = typeof ev.delta === "string" ? ev.delta : "";
          if (delta) noteCandidateSpeaking(delta);
          break;
        }
        case "session.output_transcript.delta": {
          openingPendingRef.current = false;
          const said = typeof ev.delta === "string" ? ev.delta : "";
          if (said) {
            spokenBufferRef.current += said;
            const log = spokenLogRef.current;
            log.push({ t: Date.now(), text: said });
            if (log.length > 600) log.splice(0, log.length - 600); // bounded memory on long interviews
          }
          noteMayaSpeaking();
          break;
        }
        case "session.delegation.created": {
          const d = ev.delegation as { id?: string; target?: string } | undefined;
          markActivity();
          if (d?.id && (d.target === "client" || d.target === undefined)) {
            void handleDelegation(d.id);
          }
          break;
        }
        case "session.usage.updated": {
          const u = ev.usage as { seconds?: number } | undefined;
          if (typeof u?.seconds === "number") usageSecondsRef.current = u.seconds;
          break;
        }
        case "session.closed": {
          const u = ev.usage as { seconds?: number } | undefined;
          if (typeof u?.seconds === "number") usageSecondsRef.current = u.seconds;
          if (!finishedRef.current && !teardownDoneRef.current) {
            addLog("warn", "LIVE", `Provider closed the session (reason: ${String(ev.reason)})`);
            void finishInterview("stalled");
          }
          break;
        }
        case "error": {
          errorCountRef.current += 1;
          const e = ev.error as { code?: string; message?: string } | undefined;
          addLog("error", "LIVE", `Provider error: ${e?.code ?? ""} ${e?.message ?? JSON.stringify(ev).slice(0, 200)}`);
          track("live.error", { code: e?.code ?? null });
          if (errorCountRef.current >= 3 && !finishedRef.current) void finishInterview("stalled");
          break;
        }
        default:
          break;
      }
    },
    [addLog, finishInterview, handleDelegation, markActivity, noteCandidateSpeaking, noteMayaSpeaking, track]
  );

  // ─── Connection ────────────────────────────────────────────────────────────

  const connect = useCallback(async (): Promise<void> => {
    // Cumulative milestone timestamps (ms since connect began) — the gaps between them show which
    // step of the ~4s setup is slow: mic → offer → ICE gathering → server/OpenAI create → ready.
    const t0 = Date.now();
    const phases: Record<string, number> = {};
    setupPhasesRef.current = phases;

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    const audio = new Audio();
    audio.autoplay = true;
    audioElRef.current = audio;
    pc.addEventListener("track", (e) => {
      const remote = new MediaStream([e.track]);
      audio.srcObject = remote;
      // The lip-sync avatar now starts at the Start click and can be on screen before Maya's audio
      // arrives; if so it plays her voice, so the raw element must start muted (no double audio).
      audio.muted = avatarRenderingRef.current;
      setRemoteAudioTrack(e.track);
      startMeter(remote);
      audio.play().catch(() => addLog("warn", "TTS", "Browser blocked audio autoplay for Maya"));
    });

    // Mic: share the LiveKit track (also what the recorder uses). Fall back to our own stream.
    let mic = getMicTrackRef.current();
    if (!mic || mic.readyState !== "live") {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      ownedMicRef.current = stream;
      mic = stream.getAudioTracks()[0];
    }
    pc.addTrack(mic, new MediaStream([mic]));
    phases.mic_at_ms = Date.now() - t0;

    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    dc.addEventListener("message", (m) => {
      try {
        handleEvent(JSON.parse(m.data) as LiveEvent);
      } catch {
        /* non-JSON frame */
      }
    });
    dc.addEventListener("close", () => {
      if (!finishedRef.current && !teardownDoneRef.current && stateRef.current !== "idle") {
        addLog("warn", "LIVE", "Data channel closed");
      }
    });

    const ready = new Promise<void>((resolve, reject) => {
      sessionReadyRef.current = { resolve, reject };
    });

    await pc.setLocalDescription(await pc.createOffer());
    phases.offer_at_ms = Date.now() - t0;
    if (pc.iceGatheringState !== "complete") {
      await Promise.race([
        new Promise<void>((resolve) => {
          pc.addEventListener("icegatheringstatechange", () => {
            if (pc.iceGatheringState === "complete") resolve();
          });
        }),
        sleep(ICE_GATHER_TIMEOUT_MS),
      ]);
    }
    phases.ice_at_ms = Date.now() - t0;

    const res = await fetch("/api/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: sessionTokenRef.current, sdp: pc.localDescription?.sdp }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`live_session_${res.status}:${(body as { error?: string }).error ?? "unknown"}`);
    }
    const data = (await res.json()) as { sdp: string; live_session_id: string; max_seconds: number };
    liveSessionIdRef.current = data.live_session_id;
    maxSecondsRef.current = data.max_seconds;
    sessionStartedAtRef.current = Date.now();
    phases.create_at_ms = Date.now() - t0;
    await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });

    // Hard cap — independent of anything the model or candidate does.
    const capMs = Math.max(30_000, data.max_seconds * 1_000 - CAP_SAFETY_MS);
    capTimerRef.current = setTimeout(() => {
      addLog("warn", "FLOW", `Live session duration cap reached (${data.max_seconds}s)`);
      void finishInterview("cap");
    }, capMs);

    // Our own end-of-turn fallback (see FORCE_TURN_*): if GPT-Live hasn't ended the candidate's turn
    // but they have clearly finished, we hand it to our brain ourselves.
    const params = new URLSearchParams(window.location.search);
    const forceOff = params.get("force") === "off";
    const overrideMs = parseInt(params.get("turnms") ?? "", 10);
    const baseMs = Number.isFinite(overrideMs) && overrideMs >= 1_000 ? overrideMs : FORCE_TURN_BASE_MS;
    if (!forceOff) {
      turnWatcherRef.current = setInterval(() => {
        if (finishedRef.current || closingRef.current || handlingDelegationRef.current) return;
        if (openingPendingRef.current) return;
        const text = inputBufferRef.current.replace(/\s+/g, " ").trim();
        if (!text) return;
        const now = Date.now();
        const audioQuietMs = meterHeardRef.current ? now - lastAudibleAtRef.current : Infinity;
        const decision = shouldForceTurn({
          text,
          silenceMs: now - lastInputDeltaAtRef.current,
          // Quiet means BOTH her transcript and her audible output have stopped.
          mayaQuietMs: Math.min(now - lastOutputDeltaAtRef.current, audioQuietMs),
          baseMs,
          minWords: FORCE_TURN_MIN_WORDS,
          trailExtraMs: FORCE_TURN_TRAIL_EXTRA_MS,
          mayaQuietNeededMs: FORCE_TURN_MAYA_QUIET_MS,
        });
        if (decision.force) {
          void handleDelegation(null, { silenceMs: now - lastInputDeltaAtRef.current });
        }
      }, 250);
    }

    // Idle watchdog — stop paying if the candidate walked away.
    lastActivityRef.current = Date.now();
    idleTimerRef.current = setInterval(() => {
      if (handlingDelegationRef.current) return;
      if (Date.now() - lastActivityRef.current > IDLE_TIMEOUT_MS) {
        addLog("warn", "FLOW", "No activity — ending live session to stop billing");
        void finishInterview("idle");
      }
    }, 10_000);

    await Promise.race([
      ready,
      sleep(10_000).then(() => {
        throw new Error("session.started timeout");
      }),
    ]);
    phases.ready_at_ms = Date.now() - t0;
  }, [addLog, finishInterview, handleDelegation, handleEvent, startMeter]);

  // ─── Public API ────────────────────────────────────────────────────────────

  const startInterview = useCallback(async () => {
    clickAtRef.current = Date.now();
    teardownDoneRef.current = false;
    finishedRef.current = false;
    closingRef.current = false;
    handlingDelegationRef.current = false;
    emptyTurnsRef.current = 0;
    turnFailuresRef.current = 0;
    clientTurnsRef.current = 0;
    errorCountRef.current = 0;
    inputBufferRef.current = "";
    usageSecondsRef.current = 0;
    meterHeardRef.current = false;
    lastAudibleAtRef.current = 0;
    spokenBufferRef.current = "";
    spokenLogRef.current = [];
    lastTurnHandledAtRef.current = 0;
    forcedAtRef.current = 0;
    forceRegretLoggedRef.current = true;
    avatarSpeakingRef.current = false;
    avatarSilentSinceRef.current = 0;
    seenEventTypesRef.current = new Set();
    setTranscript("");
    setTurns([]);
    setTurnIndexSynced(0);
    setStateSynced("intro");
    setAIStatus("thinking");
    addLog("info", "FLOW", "Starting interview (GPT-Live engine)");
    traceIdRef.current = crypto.randomUUID();

    const fallback = async (reason: string) => {
      addLog("warn", "FLOW", `Live voice unavailable (${reason}) — falling back to standard engine`);
      track("live.fallback", { reason });
      await teardown("fallback");
      clearTimers();
      setStateSynced("idle");
      setAIStatus("waiting");
      teardownDoneRef.current = false;
      onFallbackRef.current(reason);
    };

    // Opening line and live connection run in parallel to hide setup latency.
    const openingPromise = fetch(`/api/sessions/${sessionTokenRef.current}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidate_answer: "__opening__",
        turn_index: 0,
        timestamp_ms: Date.now(),
        trace_id: traceIdRef.current,
      }),
    });

    try {
      const tConnect = Date.now();
      await connect();
      track("live.session.started", {
        setup_ms: Date.now() - tConnect,
        max_seconds: maxSecondsRef.current,
        ...setupPhasesRef.current,
      });
      addLog("success", "LIVE", `Session ready in ${Date.now() - tConnect}ms (cap ${maxSecondsRef.current}s)`);
    } catch (err) {
      void openingPromise.catch(() => {});
      await fallback(err instanceof Error ? err.message : "connect_failed");
      return;
    }

    let opening: string;
    try {
      const res = await openingPromise;
      if (!res.ok) throw new Error(`opening_${res.status}`);
      const data = await res.json();
      if (typeof data.trace_id === "string") traceIdRef.current = data.trace_id;
      opening = String(data.question ?? "").trim() || "Hello, I'm Maya. Tell me a little about yourself.";
      setCurrentQuestion(opening);
      setTurnIndexSynced(data.turn_index ?? 1);
      appendTurn("interviewer", opening, data.turn_index ?? 1);
    } catch (err) {
      await fallback(err instanceof Error ? err.message : "opening_failed");
      return;
    }

    // Hand Maya her first line. Escalate once if she stays silent, then give up (bounded cost).
    const waitForOpeningSpeech = async () => {
      const start = Date.now();
      while (openingPendingRef.current && !finishedRef.current && Date.now() - start < OPENING_WAIT_MS) {
        await sleep(200);
      }
    };
    openingPendingRef.current = true;
    sendSpoken(null, `Greet the candidate and say this: ${opening}`);
    await waitForOpeningSpeech();
    if (openingPendingRef.current && !finishedRef.current) {
      // Retry once through the same safe channel (never instructions.append — it is permanent).
      addLog("warn", "LIVE", "Maya silent after the opening — re-sending once");
      sendEvent({ ...buildNudgeEvent(opening, crypto.randomUUID()) });
      await waitForOpeningSpeech();
      if (openingPendingRef.current && !finishedRef.current) {
        await fallback("maya_silent");
        return;
      }
    }
    track("live.opening.spoken", { ms_from_click: Date.now() - clickAtRef.current });
    markActivity();
  }, [
    addLog,
    appendTurn,
    clearTimers,
    connect,
    markActivity,
    sendEvent,
    sendSpoken,
    setStateSynced,
    setTurnIndexSynced,
    teardown,
    track,
  ]);

  const endEarly = useCallback(async () => {
    addLog("warn", "FLOW", "Interview ended early — saving partial session");
    await finishInterview("early");
  }, [addLog, finishInterview]);

  const reset = useCallback(() => {
    finishedRef.current = true; // suppress any in-flight completion paths
    void teardown("reset");
    inputBufferRef.current = "";
    handlingDelegationRef.current = false;
    closingRef.current = false;
    turnIdxRef.current = 0;
    traceIdRef.current = null;
    setTurnIndex(0);
    setTurns([]);
    setCurrentQuestion("");
    setTranscript("");
    setCandidateListeningPhase("idle");
    setAIStatus("waiting");
    setTurnState("LISTENING");
    stateRef.current = "idle";
    setState("idle");
    setLogs([{ id: ++logId, time: timestamp(), level: "info", step: "FLOW", message: "Interview reset" }]);
  }, [teardown]);

  // Tab close / navigation: stop billing and settle the ledger.
  useEffect(() => {
    const onPageHide = () => {
      if (pcRef.current && !teardownDoneRef.current) {
        sendEvent({ type: "session.close" });
        settleLedger("pagehide");
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [sendEvent, settleLedger]);

  /**
   * Called by the lip-sync avatar: mute the raw GPT-Live audio ONLY once the avatar is visibly
   * rendering Maya (so there is never a moment of silence), and unmute instantly if it fails.
   */
  const setPlaybackMuted = useCallback(
    (muted: boolean) => {
      avatarRenderingRef.current = muted;
      if (audioElRef.current) audioElRef.current.muted = muted;
      track(muted ? "live.playback.muted_for_avatar" : "live.playback.unmuted");
    },
    [track]
  );

  /** Simli's speaking/silent events — what the candidate is still SEEING and hearing from the avatar. */
  const setAvatarSpeaking = useCallback((speaking: boolean) => {
    avatarSpeakingRef.current = speaking;
    if (!speaking) avatarSilentSinceRef.current = Date.now();
  }, []);

  /** Snapshot for diagnostics when something external (the avatar provider) stops unexpectedly. */
  const getAudioDebug = useCallback(() => {
    const now = Date.now();
    return {
      ms_since_maya_audible: lastAudibleAtRef.current ? now - lastAudibleAtRef.current : null,
      ms_since_maya_transcript: lastOutputDeltaAtRef.current ? now - lastOutputDeltaAtRef.current : null,
      ms_since_candidate_delta: lastInputDeltaAtRef.current ? now - lastInputDeltaAtRef.current : null,
      interview_state: stateRef.current,
    };
  }, []);

  const conversationTurnPhase: ConversationTurnPhase = useMemo(() => {
    if (state === "processing" || turnState === "FINALIZING") return "AI_DECIDING";
    if (state === "speaking") return "AI_SPEAKING";
    if (state !== "listening") return "LISTENING_IDLE";
    switch (candidateListeningPhase) {
      case "speaking":
        return "CANDIDATE_SPEAKING";
      case "pause":
        return "CANDIDATE_THINKING";
      case "committing":
        return "CANDIDATE_FINISHED";
      default:
        return "LISTENING_IDLE";
    }
  }, [state, turnState, candidateListeningPhase]);

  return {
    state,
    aiStatus,
    candidateListeningPhase,
    conversationTurnPhase,
    currentQuestion,
    transcript,
    turns,
    turnIndex,
    logs,
    turnState,
    /** Maya's incoming audio — for the lip-sync avatar. Null until the voice session connects. */
    remoteAudioTrack,
    setPlaybackMuted,
    setAvatarSpeaking,
    getAudioDebug,
    startInterview,
    endEarly,
    reset,
  };
}
