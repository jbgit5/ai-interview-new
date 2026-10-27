import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  useSpeechCapture,
  type AddLog,
} from "./useSpeechCapture";
import { useAudioPlayer } from "./useAudioPlayer";
import { isPlainIgnoranceNoProbePhrases } from "@/lib/weakAnswerSignals";
import type { SessionTelemetryApi } from "@/lib/telemetry/types";
import { createMicEnergyBargeGate } from "@/hooks/useMicEnergyBargeGate";

// ─── Types ────────────────────────────────────────────────────────────────────

export type InterviewState =
  | "idle"        // not started
  | "intro"       // fetching + playing opening question
  | "listening"   // candidate speaking / Deepgram active
  | "processing"  // waiting for GPT-4o turn response
  | "speaking"    // AI TTS playing
  | "completed"   // interview finished
  | "error";

export type AIStatus = "waiting" | "listening" | "thinking" | "speaking";

/** Candidate microphone phase while AI is listening (distinct from aiStatus.thinking). */
export type CandidateListeningPhase = "idle" | "speaking" | "pause" | "committing";

/**
 * Minimal client orchestration (transport uses its own timers).
 * AI_SPEAKING — Maya TTS; LISTENING — STT active; FINALIZING — silence committed, LLM in flight.
 */
export type TurnOrchestrationState = "AI_SPEAKING" | "LISTENING" | "FINALIZING";

/**
 * Canonical realtime conversation phase for observability / UI.
 * See docs in commit: maps interview transport state + finer listening hints.
 */
export type ConversationTurnPhase =
  | "LISTENING_IDLE"
  | "CANDIDATE_SPEAKING"
  | "CANDIDATE_THINKING"
  | "CANDIDATE_FINISHED"
  | "AI_DECIDING"
  | "AI_SPEAKING"
  | "BARGE_IN_HANDLING";

export interface TranscriptEntry {
  role: "interviewer" | "candidate";
  content: string;
  turnIndex: number;
}

export interface LogEntry {
  id: number;
  time: string;
  level: "info" | "success" | "error" | "warn";
  step: string;
  message: string;
}

interface UseInterviewOptions {
  sessionToken: string; // URL token — passed to all /api/sessions/[token]/* routes
  /** Batched client telemetry (see docs/OBSERVABILITY.md) */
  telemetry?: SessionTelemetryApi;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let logId = 0;

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Retry budget for transient network errors on the turn API.
// Back-off: attempt 2 waits 1 s, attempt 3 waits 2 s.
const TURN_MAX_RETRIES = 3;

/** After last transcript activity, wait this long before considering the turn done (comfort > latency). */
const SILENCE_COMMIT_MS = 7_200;
/**
 * After Deepgram `speech_final` (end-of-utterance), block commit for this extra window so
 * slow follow-on finals / continued speech are not cut off.
 */
const POST_SPEECH_FINAL_PAD_MS = 4_800;

/** Base ms for mic barge‑in suppression after real audio starts (scaled per utterance in speakWithMicBarge). */
const INTERRUPT_GRACE_BASE_MS = 1_800;
/** Log when candidate dwells paused without committing */
const LONG_THINKING_TELEMETRY_MS = 9_000;
/** Short flash for BARGE phase in derivations */
const BARGE_PHASE_FLASH_MS = 520;

/**
 * If Deepgram keeps a non-empty interim across many silence windows, commit never runs.
 * After this many stalled checks, discard the stale interim and continue (live finals kept).
 */
const MAX_INTERIM_STALL_CYCLES = 4;

type SpeakWithBargeFn = (text: string) => Promise<{ aborted: boolean }>;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useInterview({ sessionToken, telemetry }: UseInterviewOptions) {
  const [state, setState] = useState<InterviewState>("idle");
  const [aiStatus, setAIStatus] = useState<AIStatus>("waiting");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [transcript, setTranscript] = useState(""); // live candidate speech
  const [turns, setTurns] = useState<TranscriptEntry[]>([]);
  const [turnIndex, setTurnIndex] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [candidateListeningPhase, setCandidateListeningPhase] =
    useState<CandidateListeningPhase>("idle");
  const [turnState, setTurnState] = useState<TurnOrchestrationState>("LISTENING");

  // Refs — stable across renders, safe to read inside async callbacks
  const turnIndexRef = useRef(0);
  const liveTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const isProcessingRef = useRef(false);
  /** Single deterministic silence → commit timer (orchestration only). */
  const silenceCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Earliest wall-clock time we may commit (raised after each speech_final). */
  const minCommitNotBeforeMsRef = useRef(0);
  const thinTailSameRef = useRef("");
  const thinTailRetriesRef = useRef(0);
  /** Counts consecutive silence-commit attempts blocked only by non-empty interim (STT stall). */
  const interimStallCyclesRef = useRef(0);
  const stateRef = useRef<InterviewState>("idle");
  const micBargeCleanupRef = useRef<(() => void) | null>(null);
  /** Epoch ms — recent ⇒ derivation reports BARGE_IN_HANDLING briefly */
  const lastBargeInAtMsRef = useRef<number>(0);
  /** Correlates STT → /turn → TTS for one candidate answer */
  const traceIdRef = useRef<string | null>(null);
  /** Observability: counts WS reconnects emitted by the persistent session */
  const wsReconnectCountRef = useRef(0);
  /** Observability: wall-clock when LLM request was sent (for E2E latency calc) */
  const turnLlmStartMsRef = useRef(0);
  /** Observability: last time STT produced text — the true "candidate stopped talking" proxy */
  const lastTranscriptActivityMsRef = useRef(0);
  const prevInterviewStateRef = useRef<InterviewState>("idle");
  /** Fresh reference so async Deepgram callbacks don’t enqueue with stale telemetry */
  const telemetryRef = useRef(telemetry);
  telemetryRef.current = telemetry;

  const enqueueSpeechTelemetry = useCallback(
    (ev: { event_name: string; attrs?: Record<string, unknown> }) => {
      // Track WebSocket reconnect count for observability dashboard
      if (ev.event_name === "stt.deepgram.reconnect_attempt") {
        wsReconnectCountRef.current++;
      }
      telemetryRef.current?.enqueue({
        ...ev,
        trace_id: traceIdRef.current,
        turn_index: turnIndexRef.current,
        interview_state: stateRef.current,
        ...(ev.event_name === "stt.deepgram.reconnect_attempt"
          ? { attrs: { ...ev.attrs, cumulative_reconnect_count: wsReconnectCountRef.current } }
          : {}),
      });
    },
    []
  );

  const getTraceIdForAudio = useCallback(
    () => traceIdRef.current ?? undefined,
    []
  );

  const addLog: AddLog = useCallback((level, step, message) => {
    setLogs((prev) => [
      ...prev,
      { id: ++logId, time: timestamp(), level, step, message },
    ]);
  }, []);

  // ── Audio player ───────────────────────────────────────────────────────────
  const { speak, stop: stopAudio, unlockAudio, abortPlayback } = useAudioPlayer(
    addLog,
    {
      sessionToken,
      getTraceId: getTraceIdForAudio,
    }
  );

  /** Bumps `conversationTurnPhase` after barge so BARGE_IN_HANDLING flashes in UI */
  const [conversationPhaseBump, setConversationPhaseBump] = useState(0);

  // ── helpers that mutate refs + state together ──────────────────────────────
  const setStateSynced = useCallback((s: InterviewState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const setTurnStateSynced = useCallback((s: TurnOrchestrationState) => {
    setTurnState(s);
  }, []);

  const setTurnIndexSynced = useCallback((n: number) => {
    turnIndexRef.current = n;
    setTurnIndex(n);
  }, []);

  const skipFirstStateEmitRef = useRef(true);
  /** Ends when telemetry emits interview.state_change — measures how long candidate stayed in *from* state */
  const wallClockLastStateEmittedRef = useRef<number>(Date.now());
  /** Set when candidate leaves idle — dashboards use elapsed ms as one horizontal timeline */
  const interviewTimelineAnchorRef = useRef<number | null>(null);

  useEffect(() => {
    if (!telemetry) return;
    if (skipFirstStateEmitRef.current) {
      skipFirstStateEmitRef.current = false;
      prevInterviewStateRef.current = state;
      wallClockLastStateEmittedRef.current = Date.now();
      return;
    }
    const now = Date.now();
    const duration_in_previous_state_ms = now - wallClockLastStateEmittedRef.current;
    wallClockLastStateEmittedRef.current = now;

    if (
      prevInterviewStateRef.current === "idle" &&
      state !== "idle" &&
      interviewTimelineAnchorRef.current === null
    ) {
      interviewTimelineAnchorRef.current = now;
    }

    let interview_elapsed_ms_at_transition: number | undefined;
    if (interviewTimelineAnchorRef.current != null) {
      interview_elapsed_ms_at_transition = now - interviewTimelineAnchorRef.current;
    }

    telemetry.enqueue({
      event_name: "interview.state_change",
      attrs: {
        from: prevInterviewStateRef.current,
        to: state,
        duration_in_previous_state_ms,
        ...(interview_elapsed_ms_at_transition != null
          ? { interview_elapsed_ms_at_transition }
          : {}),
      },
      interview_state: state,
    });
    prevInterviewStateRef.current = state;
  }, [state, telemetry]);

  const appendTurn = useCallback(
    (role: "interviewer" | "candidate", content: string, idx: number) => {
      setTurns((prev) => [...prev, { role, content, turnIndex: idx }]);
    },
    []
  );

  const handleSilenceRef = useRef<() => Promise<void>>(async () => {});
  const scheduleSilenceCommitRef = useRef<() => void>(() => {});
  const tryCommitAfterSilenceRef = useRef<() => void>(() => {});

  const clearSilenceCommitTimer = useCallback(() => {
    if (silenceCommitTimerRef.current) {
      clearTimeout(silenceCommitTimerRef.current);
      silenceCommitTimerRef.current = null;
    }
  }, []);

  /** Clears the silence→commit timer (barge-in, TTS, processing, new turns). */
  const cancelListeningTimers = useCallback(() => {
    clearSilenceCommitTimer();
  }, [clearSilenceCommitTimer]);

  const tryCommitAfterSilence = useCallback(() => {
    if (stateRef.current !== "listening" || isProcessingRef.current) return;
    if (interimTranscriptRef.current.trim()) {
      interimStallCyclesRef.current += 1;
      if (interimStallCyclesRef.current < MAX_INTERIM_STALL_CYCLES) {
        addLog("info", "FLOW", "Deferring commit — STT is still producing interim text");
        scheduleSilenceCommitRef.current();
        return;
      }
      addLog(
        "warn",
        "FLOW",
        "Interim transcript stale — discarding partial so the interview can continue"
      );
      telemetryRef.current?.enqueue({
        event_name: "interview.interim_stall_cleared",
        attrs: { cycles: MAX_INTERIM_STALL_CYCLES },
        trace_id: traceIdRef.current,
        turn_index: turnIndexRef.current,
        interview_state: stateRef.current,
      });
      interimTranscriptRef.current = "";
      interimStallCyclesRef.current = 0;
      setTranscript(liveTranscriptRef.current.trim());
    } else {
      interimStallCyclesRef.current = 0;
    }

    const merged = (liveTranscriptRef.current + " " + interimTranscriptRef.current).trim();
    if (!merged) {
      scheduleSilenceCommitRef.current();
      return;
    }
    const now = Date.now();
    if (now < minCommitNotBeforeMsRef.current) {
      clearSilenceCommitTimer();
      const wait = Math.max(120, minCommitNotBeforeMsRef.current - now + 40);
      addLog("info", "FLOW", `Deferring commit — post-utterance quiet buffer (${wait}ms)`);
      silenceCommitTimerRef.current = setTimeout(() => {
        silenceCommitTimerRef.current = null;
        tryCommitAfterSilenceRef.current();
      }, wait);
      return;
    }
    const wc = merged.split(/\s+/).filter(Boolean).length;
    if (wc <= 2 && merged.length < 18 && !isPlainIgnoranceNoProbePhrases(merged)) {
      if (thinTailSameRef.current === merged) thinTailRetriesRef.current += 1;
      else {
        thinTailSameRef.current = merged;
        thinTailRetriesRef.current = 0;
      }
      if (thinTailRetriesRef.current < 6) {
        addLog(
          "warn",
          "FLOW",
          "Deferring commit — segment is very short (possible clipped STT tail); waiting for more speech…"
        );
        scheduleSilenceCommitRef.current();
        return;
      }
    }
    thinTailSameRef.current = "";
    thinTailRetriesRef.current = 0;

    addLog("info", "FLOW", `Quiet for ${SILENCE_COMMIT_MS}ms after last activity — committing turn`);
    setCandidateListeningPhase("committing");
    setTurnStateSynced("FINALIZING");
    void handleSilenceRef.current();
  }, [addLog, clearSilenceCommitTimer, setTurnStateSynced]);

  const scheduleSilenceCommit = useCallback(() => {
    clearSilenceCommitTimer();
    if (stateRef.current !== "listening" || isProcessingRef.current) return;
    silenceCommitTimerRef.current = setTimeout(() => {
      silenceCommitTimerRef.current = null;
      tryCommitAfterSilenceRef.current();
    }, SILENCE_COMMIT_MS);
  }, [clearSilenceCommitTimer]);

  tryCommitAfterSilenceRef.current = tryCommitAfterSilence;
  scheduleSilenceCommitRef.current = scheduleSilenceCommit;

  const conversationTurnPhase: ConversationTurnPhase = useMemo(() => {
    void conversationPhaseBump;
    const now = Date.now();
    if (lastBargeInAtMsRef.current > 0 && now - lastBargeInAtMsRef.current < BARGE_PHASE_FLASH_MS) {
      return "BARGE_IN_HANDLING";
    }
    if (state === "processing" || turnState === "FINALIZING") return "AI_DECIDING";
    if (state === "speaking") return "AI_SPEAKING";
    if (
      state === "idle" ||
      state === "intro" ||
      state === "completed" ||
      state === "error"
    ) {
      return "LISTENING_IDLE";
    }
    // listening only from here:
    switch (candidateListeningPhase) {
      case "speaking":
        return "CANDIDATE_SPEAKING";
      case "pause":
        return "CANDIDATE_THINKING";
      case "committing":
        return "CANDIDATE_FINISHED";
      case "idle":
      default:
        return "LISTENING_IDLE";
    }
  }, [state, turnState, candidateListeningPhase, conversationPhaseBump]);

  const thinkingTelemetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!telemetry) return;
    if (thinkingTelemetryTimerRef.current) {
      clearTimeout(thinkingTelemetryTimerRef.current);
      thinkingTelemetryTimerRef.current = null;
    }
    if (state === "listening" && candidateListeningPhase === "pause") {
      thinkingTelemetryTimerRef.current = setTimeout(() => {
        if (stateRef.current !== "listening") return;
        telemetry.enqueue({
          event_name: "interview.candidate.thinking_stall",
          attrs: { dwell_ms_approx: LONG_THINKING_TELEMETRY_MS },
          trace_id: traceIdRef.current,
          turn_index: turnIndexRef.current,
          interview_state: "listening",
        });
      }, LONG_THINKING_TELEMETRY_MS);
    }
    return () => {
      if (thinkingTelemetryTimerRef.current) {
        clearTimeout(thinkingTelemetryTimerRef.current);
        thinkingTelemetryTimerRef.current = null;
      }
    };
  }, [state, candidateListeningPhase, telemetry]);

  // Forward declaration — assigned after capture + startListeningPreWarm exist
  const speakWithMicBargeRef = useRef<SpeakWithBargeFn>(async () => ({ aborted: false }));

  // Ref so handleSilence can call capture.stop() without a forward-declaration issue
  // (capture is initialised below, but handleSilence is declared first)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captureRef = useRef<any>(null);

  /** In-flight `capture.start()` kicked off in parallel with LLM/TTS so activate() is instant. */
  const sttPreparePromiseRef = useRef<Promise<void> | null>(null);

  // Ref so handleSilence can call startListeningPreWarm without a forward-declaration
  // cycle (startListeningPreWarm depends on capture which comes after handleSilence)
  const startListeningPreWarmRef = useRef<() => Promise<() => void>>(async () => () => {});

  // ─── Core: commit turn after client silence timer (transport stays unchanged) ─
  const handleSilence = useCallback(async () => {
    // Don't process if interview is already done or errored
    if (stateRef.current === "completed" || stateRef.current === "error") {
      addLog("warn", "MIC", `handleSilence skipped — state is ${stateRef.current}`);
      return;
    }
    if (isProcessingRef.current) {
      addLog("warn", "MIC", "Already processing — ignoring duplicate silence");
      return;
    }

    const mergedRaw = (liveTranscriptRef.current + " " + interimTranscriptRef.current).trim();
    if (!mergedRaw) {
      addLog("warn", "MIC", "Silence but empty transcript — ignoring");
      return;
    }

    const finalTranscript = mergedRaw;

    isProcessingRef.current = true;
    cancelListeningTimers();
    setCandidateListeningPhase("idle");
    setTurnStateSynced("FINALIZING");
    addLog(
      "info",
      "MIC",
      `Captured: "${finalTranscript.slice(0, 80)}${finalTranscript.length > 80 ? "…" : ""}"`
    );

    captureRef.current?.stop();
    sttPreparePromiseRef.current = null;
    sttPreparePromiseRef.current = captureRef.current
      .start()
      .catch((err: unknown) => {
        sttPreparePromiseRef.current = null;
        throw err;
      });
    setStateSynced("processing");
    setAIStatus("thinking");

    const currentTurnIdx = turnIndexRef.current;
    appendTurn("candidate", finalTranscript, currentTurnIdx);
    liveTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setTranscript("");

    const traceForTurn = traceIdRef.current;
    const silenceToLlmStart = Date.now();
    const lastActivityAtCommit = lastTranscriptActivityMsRef.current;

    try {
      // Retry loop — retries on network failures and 5xx errors only.
      // 4xx (bad request, expired session) are not retried.
      let res: Response | null = null;
      for (let attempt = 1; attempt <= TURN_MAX_RETRIES; attempt++) {
        if (attempt > 1) {
          const delayMs = (attempt - 1) * 1000;
          addLog("warn", "LLM", `Turn API retry ${attempt - 1}/${TURN_MAX_RETRIES - 1} — waiting ${delayMs}ms…`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
        addLog("info", "LLM", `POST /api/sessions/${sessionToken}/turn (attempt ${attempt}/${TURN_MAX_RETRIES})`);
        turnLlmStartMsRef.current = Date.now();
        try {
          res = await fetch(`/api/sessions/${sessionToken}/turn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              candidate_answer: finalTranscript,
              turn_index: currentTurnIdx,
              timestamp_ms: Date.now(),
              trace_id: traceForTurn,
              client_admits_no_knowledge: isPlainIgnoranceNoProbePhrases(finalTranscript),
            }),
          });
          // Success or client error (4xx) — stop retrying
          if (res.ok || res.status < 500) break;
          // 5xx server error — retry if budget remains
        } catch {
          if (attempt === TURN_MAX_RETRIES) {
            throw new Error("Turn API unreachable after retries — check your connection");
          }
        }
      }

      if (!res || !res.ok) {
        const errText = res
          ? await res.text().catch(() => res!.statusText)
          : "Network error";
        addLog("error", "LLM", `Turn API failed — ${res?.status ?? "network"}: ${errText.slice(0, 200)}`);
        setStateSynced("error");
        isProcessingRef.current = false;
        setTurnStateSynced("LISTENING");
        return;
      }

      const data = await res.json();
      if (typeof data.trace_id === "string") traceIdRef.current = data.trace_id;
      const { action, question: nextQuestion, turn_index: nextIdx } = data;
      const llmRoundtripMs = Date.now() - turnLlmStartMsRef.current;
      addLog(
        "success",
        "LLM",
        `Action: ${action} — "${(nextQuestion ?? "").slice(0, 80)}" (${llmRoundtripMs}ms)`
      );
      telemetry?.enqueue({
        event_name: "llm.turn.completed",
        attrs: {
          action,
          llm_roundtrip_ms: llmRoundtripMs,
          silence_to_llm_start_ms: turnLlmStartMsRef.current - silenceToLlmStart,
          // Comparable to live's last_candidate_delta_to_commentary_ms: last STT text → next
          // question text ready (includes the fixed silence-commit wait that the field above omits).
          engine: "legacy",
          last_transcript_to_question_ms:
            lastActivityAtCommit > 0 ? Date.now() - lastActivityAtCommit : null,
          ws_reconnect_count: wsReconnectCountRef.current,
        },
        trace_id: traceIdRef.current,
        turn_index: turnIndexRef.current,
        interview_state: stateRef.current,
      });

      setCurrentQuestion(nextQuestion ?? "");
      setTurnIndexSynced(nextIdx ?? currentTurnIdx + 1);

      if (action === "close" || data.is_closing) {
        // Closing: speak then end — no need to pre-warm
        setStateSynced("speaking");
        setAIStatus("speaking");
        appendTurn("interviewer", nextQuestion ?? "", nextIdx ?? currentTurnIdx + 1);
        await speakWithMicBargeRef.current(nextQuestion ?? "");

        addLog("success", "FLOW", "Interview closing — ending session");
        setStateSynced("completed");
        setAIStatus("waiting");
        isProcessingRef.current = false;
        setTurnStateSynced("LISTENING");

        fetch(`/api/sessions/${sessionToken}/end`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ integrity_score: 100 }),
        }).catch((err) => console.error("End session failed:", err));
      } else {
        // Prepare activator (resets transcript state) then play TTS,
        // start STT fresh after TTS finishes — avoids AssemblyAI 3006 idle timeout.
        const activateListening = await startListeningPreWarmRef.current();

        setStateSynced("speaking");
        setAIStatus("speaking");
        appendTurn("interviewer", nextQuestion ?? "", nextIdx ?? currentTurnIdx + 1);
        const fullQ = (nextQuestion ?? "").trim();
        let ttsDone = await speakWithMicBargeRef.current(nextQuestion ?? "");
        if (ttsDone.aborted && fullQ) {
          addLog("info", "FLOW", "TTS interrupted — repeating the question once");
          ttsDone = await speakWithMicBargeRef.current(`Sorry, I was cut off. ${fullQ}`);
          if (ttsDone.aborted) {
            addLog(
              "warn",
              "FLOW",
              "TTS interrupted again — please answer using the question text on screen; listening is on."
            );
          }
        }

        addLog("info", "FLOW", "TTS done — starting STT");
        await activateListening();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog("error", "FLOW", `handleSilence error: ${msg}`);
      setStateSynced("error");
      isProcessingRef.current = false;
      setTurnStateSynced("LISTENING");
    }
  }, [
    sessionToken,
    appendTurn,
    addLog,
    setStateSynced,
    setTurnIndexSynced,
    cancelListeningTimers,
    setTurnStateSynced,
    telemetry,
  ]);

  handleSilenceRef.current = handleSilence;

  // ─── Transcript callbacks (stable, given to useSpeechCapture) ─────────────
  const onTranscript = useCallback(
    (text: string, isFinal: boolean, speechFinal?: boolean) => {
      if (isProcessingRef.current) return;

      traceIdRef.current ||= crypto.randomUUID();

      const sf = speechFinal === true;
      if (sf) {
        minCommitNotBeforeMsRef.current = Date.now() + POST_SPEECH_FINAL_PAD_MS;
      } else if (!isFinal) {
        minCommitNotBeforeMsRef.current = 0;
      } else {
        minCommitNotBeforeMsRef.current = 0;
      }

      if (!isFinal || text.trim().split(/\s+/).filter(Boolean).length >= 3) {
        thinTailRetriesRef.current = 0;
        thinTailSameRef.current = "";
      }

      if (isFinal) {
        interimTranscriptRef.current = "";
        interimStallCyclesRef.current = 0;
        liveTranscriptRef.current = (liveTranscriptRef.current + " " + text).trim();
        setTranscript(liveTranscriptRef.current);
        addLog("success", "STT", `Final: "${text}"`);
      } else {
        interimTranscriptRef.current = text;
        setTranscript((liveTranscriptRef.current + " " + text).trim());
      }
      setCandidateListeningPhase("speaking");
      setTurnStateSynced("LISTENING");
      lastTranscriptActivityMsRef.current = Date.now();
      scheduleSilenceCommit();
    },
    [addLog, scheduleSilenceCommit, setTurnStateSynced]
  );

  const onVadSpeechStarted = useCallback(() => {
    if (stateRef.current === "speaking") {
      telemetry?.enqueue({
        event_name: "interview.vad.interruption",
        attrs: { during: "maya_speaking" },
        trace_id: traceIdRef.current,
        turn_index: turnIndexRef.current,
        interview_state: "speaking",
      });
    }
    if (stateRef.current === "listening" && !isProcessingRef.current) {
      clearSilenceCommitTimer();
      setCandidateListeningPhase("speaking");
      setTurnStateSynced("LISTENING");
    }
  }, [clearSilenceCommitTimer, telemetry, setTurnStateSynced]);

  const onVadSpeechStopped = useCallback(() => {
    if (stateRef.current !== "listening" || isProcessingRef.current) return;
    setCandidateListeningPhase("pause");
    setTurnStateSynced("LISTENING");
    scheduleSilenceCommit();
  }, [scheduleSilenceCommit, setTurnStateSynced]);

  const onError = useCallback(
    (err: Error) => {
      telemetry?.enqueue({
        event_name: "stt.error",
        attrs: {
          message: err.message.slice(0, 400),
          fatal: err.message.startsWith("STT unavailable"),
        },
        trace_id: traceIdRef.current,
        turn_index: turnIndexRef.current,
        interview_state: stateRef.current,
      });
      const isTotalFailure = err.message.startsWith("STT unavailable");
      addLog(
        "error",
        "STT",
        isTotalFailure
          ? `Speech recognition is unavailable — Deepgram/Web Speech failed. ` +
            `Please check your microphone and internet connection, then reload the page to try again. ` +
            `(Detail: ${err.message})`
          : `STT error: ${err.message}`
      );
      setStateSynced("error");
      isProcessingRef.current = false;
      setTurnStateSynced("LISTENING");
    },
    [addLog, setStateSynced, telemetry, setTurnStateSynced]
  );

  // ─── Speech capture ────────────────────────────────────────────────────────
  const capture = useSpeechCapture({
    sessionToken,
    onTranscript,
    onVadSpeechStarted,
    onVadSpeechStopped,
    onError,
    addLog,
    enqueueSpeechTelemetry,
  });
  captureRef.current = capture;

  // ─── Start listening: resets state during TTS, starts STT fresh after ────────
  // Called before TTS plays; the returned activator is called when TTS finishes.
  const startListeningPreWarm = useCallback(async (): Promise<() => void> => {
    cancelListeningTimers();
    minCommitNotBeforeMsRef.current = 0;
    thinTailSameRef.current = "";
    thinTailRetriesRef.current = 0;
    // Reset transcript state immediately (while TTS is still playing)
    liveTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setTranscript("");
    isProcessingRef.current = false;

    // Deepgram: `capture.start()` is kicked off in parallel with LLM/TTS (see handleSilence /
    // startInterview). Here we await that in-flight connection then `activate()` so audio flows
    // immediately — avoids losing the candidate’s first words after Maya speaks.
    return async () => {
      traceIdRef.current = null;
      interimStallCyclesRef.current = 0;
      addLog("info", "MIC", "TTS done — starting STT…");
      cancelListeningTimers();
      minCommitNotBeforeMsRef.current = 0;
      thinTailSameRef.current = "";
      thinTailRetriesRef.current = 0;
      try {
        const prepared = sttPreparePromiseRef.current;
        sttPreparePromiseRef.current = null;
        try {
          if (prepared) await prepared;
          else await capture.start();
        } catch {
          addLog("warn", "MIC", "STT pre-connect failed — retrying fresh capture…");
          await capture.start();
        }
        // Pre-warm can finish minutes before TTS ends; Deepgram may idle-close with no audio sent.
        if (!capture.isSessionAlive()) {
          addLog("warn", "MIC", "STT session ended during Maya audio — reconnecting Deepgram…");
          await capture.start();
        }
        capture.activate();
        setStateSynced("listening");
        setAIStatus("listening");
        setCandidateListeningPhase("pause");
        setTurnStateSynced("LISTENING");
        addLog("success", "MIC", "STT active — listening for candidate");
        scheduleSilenceCommit();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog("error", "MIC", `Failed to start listening: ${msg}`);
        setStateSynced("error");
        isProcessingRef.current = false;
      }
    };
  }, [capture, addLog, setStateSynced, cancelListeningTimers, setTurnStateSynced, scheduleSilenceCommit]);

  // Populate the ref now that startListeningPreWarm is defined
  startListeningPreWarmRef.current = startListeningPreWarm;

  const speakWithMicBarge = useCallback(
    async (text: string): Promise<{ aborted: boolean }> => {
      micBargeCleanupRef.current?.();
      micBargeCleanupRef.current = null;

      let bargeConsumed = false;
      let utteranceDisposed = false;
      let gateArmPromise: Promise<void> | null = null;

      const graceMs = Math.min(
        6_200,
        Math.max(INTERRUPT_GRACE_BASE_MS, INTERRUPT_GRACE_BASE_MS + Math.min(text.length, 420) * 7)
      );

      const armBargeGateOnce = (): Promise<void> => {
        if (gateArmPromise) return gateArmPromise;
        gateArmPromise = (async () => {
          try {
            const gate = createMicEnergyBargeGate({
              consecutiveAbove: 22,
              rmsThreshold: 0.064,
              // Reuse the persistent capture stream — eliminates 3rd getUserMedia
              externalStream: captureRef.current?.getSharedStream?.() ?? null,
              onBarge: () => {
                if (bargeConsumed) return;
                bargeConsumed = true;
                abortPlayback();
                lastBargeInAtMsRef.current = Date.now();
                setConversationPhaseBump((n) => n + 1);
                enqueueSpeechTelemetry({
                  event_name: "interview.barge_in",
                  attrs: {
                    detector: "mic_energy_rms",
                    interrupt_grace_applied_ms: graceMs,
                  },
                });
                addLog("warn", "FLOW", "Barge-in — Maya audio stopped for candidate speech");
                micBargeCleanupRef.current?.();
                micBargeCleanupRef.current = null;
              },
            });
            await gate.start();
            if (utteranceDisposed) {
              gate.stop();
              return;
            }
            gate.setSuppressPlaybackGraceMs(graceMs);
            micBargeCleanupRef.current = () => {
              gate.stop();
            };
          } catch (err: unknown) {
            gateArmPromise = null;
            const msg = err instanceof Error ? err.message : String(err);
            addLog(
              "warn",
              "MIC",
              `Parallel mic monitor unavailable — barge-in disabled for this utterance: ${msg}`
            );
          }
        })();
        return gateArmPromise;
      };

      try {
        setTurnStateSynced("AI_SPEAKING");
        return await speak(text, {
          onPlaybackStarted: () => {
            void armBargeGateOnce();
          },
        });
      } finally {
        utteranceDisposed = true;
        // Gate is armed asynchronously; TS cannot see that here — assert for cleanup.
        const stopGate = micBargeCleanupRef.current as (() => void) | null;
        micBargeCleanupRef.current = null;
        stopGate?.();
      }
    },
    [speak, abortPlayback, addLog, enqueueSpeechTelemetry, setTurnStateSynced]
  );

  speakWithMicBargeRef.current = speakWithMicBarge;
  const startInterview = useCallback(async () => {
    // Unlock browser autoplay IMMEDIATELY — must happen synchronously before
    // any async work so the browser still counts this as a user gesture.
    unlockAudio();
    addLog("info", "FLOW", "Starting interview — fetching opening question");
    capture.stop();
    sttPreparePromiseRef.current = null;
    sttPreparePromiseRef.current = capture
      .start()
      .catch((err: unknown) => {
        sttPreparePromiseRef.current = null;
        throw err;
      });
    cancelListeningTimers();
    minCommitNotBeforeMsRef.current = 0;
    thinTailSameRef.current = "";
    thinTailRetriesRef.current = 0;
    setCandidateListeningPhase("idle");
    setStateSynced("intro");
    setAIStatus("thinking");
    isProcessingRef.current = false;
    liveTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setTranscript("");
    setTurnIndexSynced(0);
    setTurns([]);

    try {
      traceIdRef.current = crypto.randomUUID();
      // First turn: send empty answer to get opening question from GPT-4o
      const res = await fetch(`/api/sessions/${sessionToken}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate_answer: "__opening__",
          turn_index: 0,
          timestamp_ms: Date.now(),
          trace_id: traceIdRef.current,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        addLog("error", "LLM", `Opening turn failed — ${res.status}: ${errText}`);
        capture.stop();
        sttPreparePromiseRef.current = null;
        setStateSynced("error");
        return;
      }

      const data = await res.json();
      if (typeof data.trace_id === "string") traceIdRef.current = data.trace_id;
      const openingQuestion: string = data.question ?? "Tell me about yourself.";
      addLog("success", "LLM", `Opening: "${openingQuestion.slice(0, 80)}"`);

      setCurrentQuestion(openingQuestion);
      setTurnIndexSynced(data.turn_index ?? 1);

      // Pre-warm STT while opening question TTS is playing
      const activateListening = await startListeningPreWarmRef.current();

      setStateSynced("speaking");
      setAIStatus("speaking");
      appendTurn("interviewer", openingQuestion, data.turn_index ?? 1);
      const openingTrimmed = openingQuestion.trim();
      let openingTts = await speakWithMicBargeRef.current(openingQuestion);
      if (openingTts.aborted && openingTrimmed) {
        addLog("info", "FLOW", "Opening TTS interrupted — repeating once");
        openingTts = await speakWithMicBargeRef.current(`Sorry, I was cut off. ${openingQuestion}`);
        if (openingTts.aborted) {
          addLog(
            "warn",
            "FLOW",
            "Opening interrupted again — please read the question on screen; listening will start next."
          );
        }
      }

      addLog("info", "FLOW", "Opening question done — starting STT");
      await activateListening();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog("error", "FLOW", `startInterview failed: ${msg}`);
      capture.stop();
      sttPreparePromiseRef.current = null;
      setStateSynced("error");
    }
  }, [
    sessionToken,
    capture,
    unlockAudio,
    appendTurn,
    addLog,
    setStateSynced,
    setTurnIndexSynced,
    cancelListeningTimers,
  ]);

  // ─── Public: endEarly (leave button / tab close) ───────────────────────────
  // Stops all audio/STT and calls the end API with whatever turns we have,
  // so the dashboard always has a partial report even if interview was abandoned.
  const endEarly = useCallback(async () => {
    addLog("warn", "FLOW", "Interview ended early — saving partial session");
    micBargeCleanupRef.current?.();
    micBargeCleanupRef.current = null;
    stopAudio();
    // destroy() fully closes WS + recorder + stream (persistent session cleanup)
    capture.destroy();
    sttPreparePromiseRef.current = null;
    cancelListeningTimers();
    isProcessingRef.current = false;
    minCommitNotBeforeMsRef.current = 0;
    thinTailSameRef.current = "";
    thinTailRetriesRef.current = 0;
    setCandidateListeningPhase("idle");
    setStateSynced("completed");
    setAIStatus("waiting");

    try {
      await fetch(`/api/sessions/${sessionToken}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrity_score: 50, early_exit: true }),
      });
    } catch { /* best-effort */ }
  }, [
    sessionToken,
    stopAudio,
    capture,
    addLog,
    setStateSynced,
    cancelListeningTimers,
  ]);

  // ─── Public: reset ─────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    micBargeCleanupRef.current?.();
    micBargeCleanupRef.current = null;
    stopAudio();
    // destroy() fully closes WS + recorder + stream (persistent session cleanup)
    capture.destroy();
    sttPreparePromiseRef.current = null;
    cancelListeningTimers();
    traceIdRef.current = null;
    isProcessingRef.current = false;
    minCommitNotBeforeMsRef.current = 0;
    thinTailSameRef.current = "";
    thinTailRetriesRef.current = 0;
    liveTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    interimStallCyclesRef.current = 0;
    lastBargeInAtMsRef.current = 0;
    setTurnIndexSynced(0);
    setTurns([]);
    setCurrentQuestion("");
    setTranscript("");
    setCandidateListeningPhase("idle");
    setAIStatus("waiting");
    setTurnStateSynced("LISTENING");
    setStateSynced("idle");
    setLogs([
      {
        id: ++logId,
        time: timestamp(),
        level: "info",
        step: "FLOW",
        message: "Interview reset",
      },
    ]);
  }, [stopAudio, capture, setStateSynced, setTurnIndexSynced, cancelListeningTimers, setTurnStateSynced]);

  return {
    // State
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

    // Actions
    startInterview,
    endEarly,
    reset,
  };
}
