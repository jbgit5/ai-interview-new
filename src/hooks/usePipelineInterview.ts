import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSpeechCapture, type AddLog } from "./useSpeechCapture";
import type {
  AIStatus,
  CandidateListeningPhase,
  ConversationTurnPhase,
  InterviewState,
  LogEntry,
  TranscriptEntry,
  TurnOrchestrationState,
} from "./useInterview";
import type { SessionTelemetryApi } from "@/lib/telemetry/types";
import { isPlainIgnoranceNoProbePhrases } from "@/lib/weakAnswerSignals";
import { shouldMergeLateSpeech } from "@/lib/live/turnTaking";
import {
  ACK_LINES,
  NUDGE_AFTER_MS,
  NUDGE_LINE,
  decideCommit,
  ANSWER_REQUEST_REPLY,
  isAckEcho,
  isAnswerRequest,
  isRepeatRequest,
  pickAck,
  shouldAck,
  stripLeadingAck,
  wordCount,
  type CommitReason,
} from "@/lib/pipeline/endOfTurn";
import { MayaVoice, type PlayResult } from "@/lib/pipeline/mayaVoice";
import type { MicMeter } from "@/lib/pipeline/micMeter";

/**
 * "Pipeline" interview engine — the default voice engine.
 *
 *   candidate speech → Deepgram (live STT) → our turn rules → /turn brain (bank-guarded) → Deepgram
 *   Aura streaming voice (OpenAI fallback) → speakers + lip-sync avatar
 *
 * Every step is ours, so Maya says EXACTLY the brain's line (no improvising, unlike GPT-Live), and
 * the waits are short and measured:
 *   - end of answer: Deepgram end-of-speech + ~0.9 s (longer if the answer trails off) instead of the
 *     standard engine's fixed 7.2 s;
 *   - an instant pre-loaded "Okay." the moment the answer is taken, so there is no dead air while the
 *     brain thinks;
 *   - if the candidate keeps talking before Maya's next line starts, the brain's reply is dropped and
 *     their words are merged into the answer (late-speech merge);
 *   - captions/transcript show a line only when its audio actually starts.
 * Same return shape as useInterview, plus the avatar hooks used by the room.
 */

let logId = 0;
function timestamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TICK_MS = 100;
const TURN_MAX_ATTEMPTS = 3;
/** The avatar plays Maya ~0.3–1 s behind our audio; don't open the mic onto her last words. */
const AVATAR_TAIL_MS = 700;

/**
 * Barge-in: the candidate speaks over Maya's question. Needs clearly speech-level sound (well above the
 * room and above any echo of Maya through the speakers) for BARGE_TICKS × 100 ms, and never in the first
 * BARGE_GRACE_MS of a line (start-up transients). Disable with ?barge=off on the link.
 */
const BARGE_MIN_RMS = 0.05;
const BARGE_FLOOR_MULTIPLE = 8;
const BARGE_TICKS = 5;
const BARGE_GRACE_MS = 1_200;

type Phase = "idle" | "intro" | "speaking" | "listening" | "thinking" | "completed" | "error";

interface TurnReply {
  action: "next" | "probe" | "close";
  question: string;
  turn_index: number;
  is_closing: boolean;
  trace_id?: string;
}

interface Options {
  sessionToken: string;
  telemetry?: SessionTelemetryApi;
}

export function usePipelineInterview({ sessionToken, telemetry }: Options) {
  const [state, setState] = useState<InterviewState>("idle");
  const [aiStatus, setAIStatus] = useState<AIStatus>("waiting");
  const [candidateListeningPhase, setCandidateListeningPhase] = useState<CandidateListeningPhase>("idle");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [transcript, setTranscript] = useState("");
  const [turns, setTurns] = useState<TranscriptEntry[]>([]);
  const [turnIndex, setTurnIndex] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [remoteAudioTrack, setRemoteAudioTrack] = useState<MediaStreamTrack | null>(null);

  const voiceRef = useRef<MayaVoice | null>(null);
  if (!voiceRef.current && typeof window !== "undefined") voiceRef.current = new MayaVoice();

  const phaseRef = useRef<Phase>("idle");
  /** Bumped whenever the current async step is superseded (merge, end, reset). */
  const genRef = useRef(0);
  const turnIndexRef = useRef(0);
  const traceIdRef = useRef<string | null>(null);
  const telemetryRef = useRef(telemetry);
  telemetryRef.current = telemetry;

  // Current answer
  const finalRef = useRef("");
  const interimRef = useRef("");
  const lastTextAtRef = useRef(0);
  const lastEndpointAtRef = useRef(0);
  const lastVadAtRef = useRef(0);
  /** We asked Deepgram to finalise pending words; the next final counts as end of speech. */
  const finalizeRequestedRef = useRef(false);
  /** Candidate mic level — "still audibly talking?" (see src/lib/pipeline/micMeter.ts). */
  const micMeterRef = useRef<MicMeter | null>(null);
  const listenStartedAtRef = useRef(0);
  const nudgedRef = useRef(false);
  const busyNudgingRef = useRef(false);

  // Between "answer taken" and "Maya's next line audible"
  const committedTextRef = useRef("");
  const committedAtRef = useRef(0);
  const lateFinalRef = useRef("");
  const lateInterimRef = useRef("");
  const lateLastAtRef = useRef(0);
  const lateEndpointAtRef = useRef(0);
  const mergesRef = useRef(0);
  const turnAbortRef = useRef<AbortController | null>(null);

  // Speech recognition connection started on the "Ready?" screen (or at Start, if not prewarmed).
  const sttPrepareRef = useRef<Promise<void> | null>(null);
  // Ack / nudge clips (downloaded one at a time on the "Ready?" screen)
  const clipsRef = useRef<Map<string, Float32Array<ArrayBuffer>>>(new Map());
  const clipsLoadingRef = useRef(false);
  const lastAckRef = useRef<string | null>(null);
  const ackPlayingRef = useRef<string | null>(null);
  const avatarActiveRef = useRef(false);

  // What the screen showed before the current question started — to undo it on a barge-in.
  // Non-null only while a normal question (not the opening / goodbye) is being spoken.
  const speakingUndoRef = useRef<{ hadCandidate: boolean; prevTurnIndex: number; prevQuestion: string } | null>(null);
  const speakStartedAtRef = useRef(0);
  const bargeTicksRef = useRef(0);
  const currentQuestionRef = useRef("");
  /** Times the candidate asked Maya to repeat the current question (reset when a new question starts). */
  const repeatCountRef = useRef(0);
  /** Times the candidate asked Maya to answer for them on the current question (reset per question). */
  const helpCountRef = useRef(0);

  const addLog: AddLog = useCallback((level, step, message) => {
    setLogs((prev) => [...prev.slice(-400), { id: ++logId, time: timestamp(), level, step, message }]);
  }, []);

  const track = useCallback((event_name: string, attrs: Record<string, unknown> = {}) => {
    telemetryRef.current?.enqueue({
      event_name,
      attrs,
      trace_id: traceIdRef.current,
      turn_index: turnIndexRef.current,
      interview_state: phaseRef.current,
    });
  }, []);

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    const mapped: InterviewState =
      p === "thinking" ? "processing" : p === "idle" ? "idle" : (p as InterviewState);
    setState(mapped);
    setAIStatus(
      p === "speaking" ? "speaking" : p === "listening" ? "listening" : p === "thinking" || p === "intro" ? "thinking" : "waiting"
    );
  }, []);

  // interview.state_change — same event the other engines emit (dashboards/diagnostics timeline).
  const prevStateRef = useRef<InterviewState>("idle");
  const prevStateAtRef = useRef(Date.now());
  useEffect(() => {
    if (state === prevStateRef.current) return;
    const now = Date.now();
    telemetryRef.current?.enqueue({
      event_name: "interview.state_change",
      attrs: { from: prevStateRef.current, to: state, duration_in_previous_state_ms: now - prevStateAtRef.current, engine: "pipeline" },
      interview_state: state,
    });
    prevStateRef.current = state;
    prevStateAtRef.current = now;
  }, [state]);

  // ── Speech capture (Deepgram, Web Speech fallback) ────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captureRef = useRef<any>(null);
  const doMergeRef = useRef<() => void>(() => {});

  const onTranscript = useCallback((text: string, isFinal: boolean, speechFinal?: boolean) => {
    const now = Date.now();
    const p = phaseRef.current;
    if (p === "listening" && !busyNudgingRef.current) {
      if (isFinal) {
        finalRef.current = `${finalRef.current} ${text}`.trim();
        interimRef.current = "";
        lastTextAtRef.current = now;
        // A final produced by our Finalize request is an end of speech too.
        if (speechFinal || finalizeRequestedRef.current) lastEndpointAtRef.current = now;
        finalizeRequestedRef.current = false;
      } else {
        // Deepgram re-sends the same unfinished text during silence: a repeat is NOT the candidate talking.
        if (text === interimRef.current) return;
        interimRef.current = text;
        lastTextAtRef.current = now;
        finalizeRequestedRef.current = false;
      }
      setTranscript(`${finalRef.current} ${interimRef.current}`.trim());
      setCandidateListeningPhase("speaking");
      return;
    }
    if (p === "thinking") {
      // The ack clip coming back through the speakers is not the candidate.
      if (ackPlayingRef.current && isAckEcho(text, ackPlayingRef.current)) return;
      if (isFinal) {
        lateFinalRef.current = `${lateFinalRef.current} ${text}`.trim();
        lateInterimRef.current = "";
      } else {
        if (text === lateInterimRef.current) return; // repeat during silence
        lateInterimRef.current = text;
      }
      lateLastAtRef.current = now;
      if (speechFinal) lateEndpointAtRef.current = now;
      const late = `${lateFinalRef.current} ${lateInterimRef.current}`.trim();
      if (shouldMergeLateSpeech(late, mergesRef.current)) doMergeRef.current();
    }
  }, []);

  const onUtteranceEnd = useCallback(() => {
    const now = Date.now();
    if (phaseRef.current === "listening" && lastTextAtRef.current) lastEndpointAtRef.current = now;
    if (phaseRef.current === "thinking" && lateLastAtRef.current) lateEndpointAtRef.current = now;
  }, []);

  const onVadSpeechStarted = useCallback(() => {
    if (phaseRef.current === "listening") lastVadAtRef.current = Date.now();
  }, []);

  const onSttError = useCallback(
    (err: Error) => {
      track("stt.error", { message: err.message.slice(0, 400), fatal: err.message.startsWith("STT unavailable") });
      addLog("error", "STT", err.message);
      if (err.message.startsWith("STT unavailable")) {
        genRef.current++;
        setPhase("error");
      }
    },
    [addLog, setPhase, track]
  );

  const enqueueSpeechTelemetry = useCallback(
    (ev: { event_name: string; attrs?: Record<string, unknown> }) => track(ev.event_name, ev.attrs ?? {}),
    [track]
  );

  const capture = useSpeechCapture({
    sessionToken,
    onTranscript,
    onUtteranceEnd,
    onVadSpeechStarted,
    onError: onSttError,
    addLog,
    enqueueSpeechTelemetry,
    // UtteranceEnd at 1 s of word-level silence: a second end-of-speech signal that still works in
    // noisy rooms where speech_final (energy based) may not fire.
    liveUtteranceEndMs: 1_000,
  });
  captureRef.current = capture;

  // ── Listening ─────────────────────────────────────────────────────────────
  const beginListening = useCallback(
    async (gen: number) => {
      if (avatarActiveRef.current) await sleep(AVATAR_TAIL_MS);
      if (gen !== genRef.current) return;
      finalRef.current = "";
      interimRef.current = "";
      lastTextAtRef.current = 0;
      lastEndpointAtRef.current = 0;
      lastVadAtRef.current = 0;
      finalizeRequestedRef.current = false;
      mergesRef.current = 0;
      nudgedRef.current = false;
      busyNudgingRef.current = false;
      traceIdRef.current = null;
      setTranscript("");
      try {
        // A connection started earlier (Ready screen / Start) may still be finishing — never open a second.
        const prepared = sttPrepareRef.current;
        sttPrepareRef.current = null;
        if (prepared) await prepared;
        if (gen !== genRef.current) return;
        if (!captureRef.current.isSessionAlive()) {
          addLog("warn", "STT", "Speech session not alive — reconnecting");
          await captureRef.current.start();
        }
        if (gen !== genRef.current) return;
        captureRef.current.activate();
        // (Re)attach the mic level meter to the stream speech recognition is using.
        const stream: MediaStream | null = captureRef.current.getSharedStream?.() ?? null;
        if (stream && micMeterRef.current?.stream !== stream) {
          micMeterRef.current?.close();
          micMeterRef.current = voiceRef.current?.createMicMeter(stream) ?? null;
          track("pipeline.mic_meter", { attached: !!micMeterRef.current });
        }
      } catch (err) {
        addLog("error", "STT", `Could not start listening: ${err instanceof Error ? err.message : String(err)}`);
        track("pipeline.listen.failed", { error: String(err).slice(0, 160) });
        setPhase("error");
        return;
      }
      listenStartedAtRef.current = Date.now();
      setCandidateListeningPhase("pause");
      setPhase("listening");
      addLog("success", "MIC", "Listening");
    },
    [addLog, setPhase, track]
  );

  // ── Speaking a brain line ─────────────────────────────────────────────────
  const finishInterview = useCallback(
    (gen: number) => {
      if (gen !== genRef.current) return;
      genRef.current++;
      captureRef.current?.destroy();
      setPhase("completed");
      track("pipeline.completed", {});
      fetch(`/api/sessions/${sessionToken}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).catch(() => {});
    },
    [sessionToken, setPhase, track]
  );

  /**
   * Say one brain line. Nothing about the line (caption, transcript, turn index) is shown until its
   * audio actually starts — that moment is also the point of no return for late-speech merges.
   */
  const deliverLine = useCallback(
    async (gen: number, reply: TurnReply, ac: AbortController, opts: { candidateAnswer: string | null; ackDone: Promise<unknown> | null }) => {
      const closing = reply.action === "close" || reply.is_closing;
      const line = stripLeadingAck(reply.question ?? "", closing) || reply.question || "";
      if (opts.ackDone) await opts.ackDone;
      if (gen !== genRef.current) return;

      let started = false;
      const markStarted = (how: "audio" | "text_only") => {
        if (started || gen !== genRef.current) return;
        started = true;
        phaseRef.current = "speaking";
        captureRef.current?.stop(); // mic muted while Maya talks (no echo into the next answer)
        speakStartedAtRef.current = Date.now();
        bargeTicksRef.current = 0;
        repeatCountRef.current = 0;
        helpCountRef.current = 0;
        speakingUndoRef.current =
          opts.candidateAnswer && !closing
            ? {
                hadCandidate: true,
                prevTurnIndex: turnIndexRef.current,
                prevQuestion: currentQuestionRef.current,
              }
            : null;
        if (opts.candidateAnswer) {
          setTurns((prev) => [...prev, { role: "candidate", content: opts.candidateAnswer as string, turnIndex: turnIndexRef.current }]);
        }
        setTurns((prev) => [...prev, { role: "interviewer", content: line, turnIndex: reply.turn_index }]);
        turnIndexRef.current = reply.turn_index;
        setTurnIndex(reply.turn_index);
        currentQuestionRef.current = line;
        setCurrentQuestion(line);
        setTranscript("");
        setCandidateListeningPhase("idle");
        setPhase("speaking");
        const now = Date.now();
        track("pipeline.voice.started", {
          kind: closing ? "closing" : opts.candidateAnswer ? "question" : "opening",
          how,
          action: reply.action,
          commit_to_voice_ms: committedAtRef.current ? now - committedAtRef.current : null,
          last_word_to_voice_ms: opts.candidateAnswer && lastTextAtRef.current ? now - lastTextAtRef.current : null,
          merges: mergesRef.current,
        });
      };

      const voice = voiceRef.current;
      let result: PlayResult = { aborted: false, failed: "no_voice" };
      if (voice) {
        result = await voice.speak(line, {
          sessionToken,
          traceId: traceIdRef.current ?? undefined,
          kind: closing ? "closing" : "question",
          signal: ac.signal,
          onStart: () => markStarted("audio"),
        });
      }
      if (gen !== genRef.current || result.aborted) return;

      if (result.failed) {
        // No voice at all: never leave the candidate stuck. Show the line and give reading time.
        addLog("error", "TTS", `Maya's voice failed (${result.failed}) — showing the question as text`);
        track("pipeline.tts.failed", { error: result.failed, started });
        markStarted("text_only");
        await sleep(Math.min(9_000, Math.max(2_500, wordCount(line) * 330)));
        if (gen !== genRef.current) return;
      } else {
        track("pipeline.voice.finished", {
          kind: closing ? "closing" : "question",
          provider: result.provider,
          first_audio_ms: result.firstAudioMs,
          duration_ms: result.durationMs,
          underruns: result.underruns,
        });
      }

      speakingUndoRef.current = null; // line finished: too late to barge in
      if (closing) {
        addLog("success", "FLOW", "Goodbye finished — ending interview");
        finishInterview(gen);
      } else {
        await beginListening(gen);
      }
    },
    [addLog, beginListening, finishInterview, sessionToken, setPhase, track]
  );

  /** POST /turn with retry on network/5xx. Returns null when superseded/aborted. */
  const postTurn = useCallback(
    async (body: Record<string, unknown>, ac: AbortController): Promise<TurnReply | null> => {
      for (let attempt = 1; attempt <= TURN_MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) await sleep((attempt - 1) * 1000);
        if (ac.signal.aborted) return null;
        try {
          const res = await fetch(`/api/sessions/${sessionToken}/turn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ac.signal,
          });
          if (res.ok) return (await res.json()) as TurnReply;
          const errText = (await res.text().catch(() => "")).slice(0, 200);
          addLog("error", "LLM", `Turn API ${res.status}: ${errText}`);
          if (res.status < 500) throw new Error(`turn_${res.status}`);
        } catch (err) {
          if (ac.signal.aborted) return null;
          if (err instanceof Error && err.message.startsWith("turn_")) throw err;
          if (attempt === TURN_MAX_ATTEMPTS) throw new Error("Turn API unreachable after retries");
        }
      }
      return null;
    },
    [addLog, sessionToken]
  );

  /**
   * The candidate asked something that isn't an answer — "repeat the question" or "can you answer that
   * for me?". Maya replies (repeating the question, or explaining she can't answer), then keeps
   * listening for the real answer. Nothing is scored and the question doesn't advance.
   */
  const repeatQuestion = useCallback(
    (heard: string, kind: "repeat" | "help" = "repeat") => {
      const gen = ++genRef.current;
      if (kind === "repeat") repeatCountRef.current += 1;
      else helpCountRef.current += 1;
      const line = kind === "repeat" ? `Of course. ${currentQuestionRef.current}` : ANSWER_REQUEST_REPLY;
      phaseRef.current = "speaking";
      speakingUndoRef.current = null;
      captureRef.current?.stop();
      finalRef.current = "";
      interimRef.current = "";
      lastTextAtRef.current = 0;
      setTranscript("");
      setCandidateListeningPhase("idle");
      setPhase("speaking");
      addLog("info", "FLOW", kind === "repeat"
        ? `Candidate asked for the question again: "${heard.slice(0, 60)}" — repeating it`
        : `Candidate asked Maya to answer: "${heard.slice(0, 60)}" — explaining she can't`);
      track(kind === "repeat" ? "pipeline.repeat_request" : "pipeline.help_request", {
        heard: heard.slice(0, 80),
        count: kind === "repeat" ? repeatCountRef.current : helpCountRef.current,
      });
      const ac = new AbortController();
      turnAbortRef.current?.abort();
      turnAbortRef.current = ac;
      void (async () => {
        const voice = voiceRef.current;
        let result: PlayResult = { aborted: false, failed: "no_voice" };
        if (voice) {
          result = await voice.speak(line, {
            sessionToken,
            traceId: traceIdRef.current ?? undefined,
            kind,
            signal: ac.signal,
          });
        }
        if (gen !== genRef.current || result.aborted) return;
        if (result.failed) {
          track("pipeline.tts.failed", { error: result.failed, repeat: true });
          await sleep(Math.min(9_000, Math.max(2_500, wordCount(line) * 330)));
          if (gen !== genRef.current) return;
        }
        await beginListening(gen);
      })();
    },
    [addLog, beginListening, sessionToken, setPhase, track]
  );

  // ── Answer taken → ack + brain → next line ───────────────────────────────
  const commitTurn = useCallback(
    (text: string, reason: CommitReason, quietMs: number, micQuietMs: number | null) => {
      if (isRepeatRequest(text) && currentQuestionRef.current && repeatCountRef.current < 3) {
        repeatQuestion(text, "repeat");
        return;
      }
      // Asked once per question: Maya explains. Asked again → falls through, the brain moves on.
      if (isAnswerRequest(text) && currentQuestionRef.current && helpCountRef.current < 1) {
        repeatQuestion(text, "help");
        return;
      }
      const gen = ++genRef.current;
      const now = Date.now();
      speakingUndoRef.current = null;
      phaseRef.current = "thinking";
      committedTextRef.current = text;
      committedAtRef.current = now;
      lateFinalRef.current = "";
      lateInterimRef.current = "";
      lateLastAtRef.current = 0;
      lateEndpointAtRef.current = 0;
      traceIdRef.current ||= crypto.randomUUID();
      setCandidateListeningPhase("committing");
      setPhase("thinking");
      addLog("info", "FLOW", `Answer taken (${reason}, ${quietMs}ms quiet): "${text.slice(0, 80)}"`);
      track("pipeline.turn.committed", {
        reason,
        quiet_ms: quietMs,
        mic_quiet_ms: micQuietMs,
        words: wordCount(text),
        merges: mergesRef.current,
      });

      // "I heard you": an instant pre-loaded clip, while the brain thinks — only when we're confident the
      // answer is complete (not after a stall or an unfinished-sounding answer).
      let ackDone: Promise<unknown> | null = null;
      const voice = voiceRef.current;
      const ack = pickAck(lastAckRef.current);
      const clip = clipsRef.current.get(ack);
      if (voice && clip && shouldAck(reason)) {
        lastAckRef.current = ack;
        ackPlayingRef.current = ack;
        ackDone = voice.playClip(clip).finally(() => {
          // Echo of the clip can arrive a moment after it ends.
          setTimeout(() => {
            if (ackPlayingRef.current === ack) ackPlayingRef.current = null;
          }, 400);
        });
        track("pipeline.ack.played", { ack, commit_to_ack_ms: Date.now() - now });
      }

      const ac = new AbortController();
      turnAbortRef.current?.abort();
      turnAbortRef.current = ac;
      const tSend = Date.now();
      void (async () => {
        try {
          const reply = await postTurn(
            {
              candidate_answer: text,
              turn_index: turnIndexRef.current,
              timestamp_ms: Date.now(),
              trace_id: traceIdRef.current,
              client_admits_no_knowledge: isPlainIgnoranceNoProbePhrases(text),
            },
            ac
          );
          if (!reply || gen !== genRef.current) return;
          if (typeof reply.trace_id === "string") traceIdRef.current = reply.trace_id;
          const brainMs = Date.now() - tSend;
          addLog("success", "LLM", `${reply.action} (${brainMs}ms): "${(reply.question ?? "").slice(0, 80)}"`);
          // Same event + fields as the other engines, so live-metrics.sql / diagnostics compare them.
          track("llm.turn.completed", {
            engine: "pipeline",
            action: reply.action,
            llm_roundtrip_ms: brainMs,
            last_transcript_to_question_ms: lastTextAtRef.current ? Date.now() - lastTextAtRef.current : null,
            merges: mergesRef.current,
          });
          await deliverLine(gen, reply, ac, { candidateAnswer: text, ackDone });
        } catch (err) {
          if (gen !== genRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          addLog("error", "FLOW", `Turn failed: ${msg}`);
          track("pipeline.turn.failed", { error: msg.slice(0, 160) });
          genRef.current++;
          setPhase("error");
        }
      })();
    },
    [addLog, deliverLine, postTurn, repeatQuestion, setPhase, track]
  );

  /** Candidate kept talking before Maya's next line started: their words belong to THIS answer. */
  const doMerge = useCallback(() => {
    if (phaseRef.current !== "thinking") return;
    genRef.current++;
    turnAbortRef.current?.abort();
    turnAbortRef.current = null;
    voiceRef.current?.stopAll(); // cut the ack
    ackPlayingRef.current = null;
    mergesRef.current += 1;
    const late = `${lateFinalRef.current} ${lateInterimRef.current}`.trim();
    finalRef.current = `${committedTextRef.current} ${lateFinalRef.current}`.trim();
    interimRef.current = lateInterimRef.current;
    lastTextAtRef.current = lateLastAtRef.current || Date.now();
    lastEndpointAtRef.current = lateEndpointAtRef.current >= lastTextAtRef.current ? lateEndpointAtRef.current : 0;
    lastVadAtRef.current = 0;
    finalizeRequestedRef.current = false;
    phaseRef.current = "listening";
    setPhase("listening");
    setCandidateListeningPhase("speaking");
    setTranscript(`${finalRef.current} ${interimRef.current}`.trim());
    addLog("warn", "FLOW", `Candidate kept talking — merged into the answer: "${late.slice(0, 60)}"`);
    track("pipeline.late_merge", { late_words: wordCount(late), merges: mergesRef.current, ms_after_commit: Date.now() - committedAtRef.current });
  }, [addLog, setPhase, track]);
  doMergeRef.current = doMerge;

  /** The candidate presses "Done answering" (or Space): take the answer right now. */
  const finishAnswer = useCallback((): boolean => {
    if (phaseRef.current !== "listening" || busyNudgingRef.current) return false;
    const text = `${finalRef.current} ${interimRef.current}`.trim();
    if (!text) return false;
    track("pipeline.done_pressed", { words: wordCount(text) });
    commitTurn(text, "button", lastTextAtRef.current ? Date.now() - lastTextAtRef.current : 0, null);
    return true;
  }, [commitTurn, track]);

  /**
   * The candidate started talking while Maya was speaking her question. Stop her, undo what the screen
   * showed for that question, and carry on THE SAME answer: the words already taken plus whatever they
   * say next. (The server accepts a re-sent turn: it replaces the earlier answer and the unspoken reply.)
   */
  const bargeIn = useCallback(
    (rms: number) => {
      const undo = speakingUndoRef.current;
      if (!undo || phaseRef.current !== "speaking") return;
      const gen = ++genRef.current;
      const msIntoLine = Date.now() - speakStartedAtRef.current;
      turnAbortRef.current?.abort();
      turnAbortRef.current = null;
      voiceRef.current?.stopAll();
      speakingUndoRef.current = null;
      setTurns((prev) => prev.slice(0, Math.max(0, prev.length - (undo.hadCandidate ? 2 : 1))));
      turnIndexRef.current = undo.prevTurnIndex;
      setTurnIndex(undo.prevTurnIndex);
      currentQuestionRef.current = undo.prevQuestion;
      setCurrentQuestion(undo.prevQuestion);

      const now = Date.now();
      finalRef.current = committedTextRef.current;
      interimRef.current = "";
      lastTextAtRef.current = now;
      lastEndpointAtRef.current = 0;
      lastVadAtRef.current = 0;
      finalizeRequestedRef.current = false;
      mergesRef.current += 1;
      listenStartedAtRef.current = now;
      setTranscript(finalRef.current);
      setCandidateListeningPhase("speaking");
      setPhase("listening");
      addLog("warn", "FLOW", "Candidate spoke over Maya — she stopped; continuing the same answer");
      track("pipeline.barge_in", { rms: Math.round(rms * 1000) / 1000, ms_into_line: msIntoLine, merges: mergesRef.current });
      void (async () => {
        try {
          if (!captureRef.current.isSessionAlive()) await captureRef.current.start();
          if (gen !== genRef.current) return;
          captureRef.current.activate();
        } catch {
          /* STT errors are reported by the capture hook */
        }
      })();
    },
    [addLog, setPhase, track]
  );

  // ── The listening clock ───────────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      // Barge-in watch while Maya speaks a question.
      if (phaseRef.current === "speaking" && speakingUndoRef.current) {
        const m = micMeterRef.current;
        if (m && !(typeof window !== "undefined" && new URLSearchParams(window.location.search).get("barge") === "off")) {
          m.sample(Date.now());
          const threshold = Math.max(BARGE_MIN_RMS, m.noiseFloor * BARGE_FLOOR_MULTIPLE);
          if (Date.now() - speakStartedAtRef.current > BARGE_GRACE_MS && m.lastRms > threshold) {
            bargeTicksRef.current += 1;
            if (bargeTicksRef.current >= BARGE_TICKS) {
              bargeTicksRef.current = 0;
              bargeIn(m.lastRms);
            }
          } else {
            bargeTicksRef.current = 0;
          }
        }
        return;
      }
      if (phaseRef.current !== "listening" || busyNudgingRef.current) return;
      const now = Date.now();
      const meter = micMeterRef.current;
      meter?.sample(now);
      const d = decideCommit({
        now,
        finalText: finalRef.current,
        interimText: interimRef.current,
        lastTextAt: lastTextAtRef.current,
        lastEndpointAt: lastEndpointAtRef.current,
        lastVadAt: lastVadAtRef.current,
        lastLoudAt: meter ? meter.lastLoudAt : undefined,
      });
      if (d.commit && d.text) {
        commitTurn(d.text, d.reason ?? "silence", d.quietMs, meter && meter.lastLoudAt ? now - meter.lastLoudAt : null);
        return;
      }
      if (d.finalize && !finalizeRequestedRef.current) {
        finalizeRequestedRef.current = captureRef.current?.finalize?.() === true;
      }
      if (lastTextAtRef.current && d.quietMs > 700) setCandidateListeningPhase((p) => (p === "speaking" ? "pause" : p));

      // Long silence after a question: one gentle prompt (mic muted while she says it).
      if (!lastTextAtRef.current && !nudgedRef.current && listenStartedAtRef.current && now - listenStartedAtRef.current > NUDGE_AFTER_MS) {
        nudgedRef.current = true;
        const clip = clipsRef.current.get(NUDGE_LINE);
        const voice = voiceRef.current;
        if (!clip || !voice) return;
        busyNudgingRef.current = true;
        const gen = genRef.current;
        captureRef.current?.stop();
        track("pipeline.nudge", { after_ms: now - listenStartedAtRef.current });
        void voice.playClip(clip).then(async () => {
          await sleep(300);
          busyNudgingRef.current = false;
          if (gen !== genRef.current || phaseRef.current !== "listening") return;
          try {
            if (!captureRef.current.isSessionAlive()) await captureRef.current.start();
            captureRef.current.activate();
          } catch {
            /* the next tick keeps waiting; STT errors are reported by the capture hook */
          }
        });
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [commitTurn, bargeIn, track]);

  // ── Public API ────────────────────────────────────────────────────────────
  /** Download the short clips one at a time (never crowd out the brain request). Idempotent. */
  const loadClips = useCallback(async () => {
    if (clipsLoadingRef.current) return;
    clipsLoadingRef.current = true;
    const lines = [...ACK_LINES, NUDGE_LINE];
    for (const l of lines) {
      if (clipsRef.current.has(l)) continue;
      const samples = await MayaVoice.fetchClip(l, sessionToken);
      if (samples) clipsRef.current.set(l, samples);
    }
    track("pipeline.clips.loaded", { loaded: clipsRef.current.size, wanted: lines.length });
  }, [sessionToken, track]);

  /**
   * Called while the candidate is on the "Ready?" screen: connect speech recognition (muted — no
   * audio is sent or billed until listening) and download the ack clips, so the Start click only waits
   * for Maya's opening line. Measured: doing this at the click delayed her first words by ~4 s.
   */
  const prewarm = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    if (!sttPrepareRef.current) {
      sttPrepareRef.current = captureRef.current.start().catch((err: unknown) => {
        addLog("warn", "STT", `Pre-connect failed (will retry when listening): ${String(err)}`);
      });
    }
    void loadClips();
  }, [addLog, loadClips]);

  const startInterview = useCallback(async () => {
    // Autoplay policy: the audio graph must be unlocked synchronously inside the click.
    const voice = voiceRef.current;
    voice?.unlock();
    setRemoteAudioTrack(voice?.track ?? null);
    const gen = ++genRef.current;
    setTurns([]);
    setTranscript("");
    setCurrentQuestion("");
    turnIndexRef.current = 0;
    setTurnIndex(0);
    committedAtRef.current = 0;
    lastTextAtRef.current = 0;
    setPhase("intro");
    traceIdRef.current = crypto.randomUUID();
    track("pipeline.started", { audio_context: voice?.contextState ?? "none" });
    addLog("info", "FLOW", "Starting interview (pipeline engine)");

    // The opening request goes out FIRST. Speech recognition + clips were normally started on the
    // Ready screen (prewarm); if not, start them now — the clips only after the opening request.
    const ac = new AbortController();
    turnAbortRef.current = ac;
    const openingReq = postTurn(
      { candidate_answer: "__opening__", turn_index: 0, timestamp_ms: Date.now(), trace_id: traceIdRef.current },
      ac
    );
    if (!sttPrepareRef.current) {
      sttPrepareRef.current = captureRef.current.start().catch((err: unknown) => {
        addLog("warn", "STT", `Pre-connect failed (will retry when listening): ${String(err)}`);
      });
    }
    try {
      const t0 = Date.now();
      const reply = await openingReq;
      void loadClips();
      if (!reply || gen !== genRef.current) return;
      addLog("success", "LLM", `Opening ready (${Date.now() - t0}ms)`);
      // Compare with the server's ai.brain.completed total_ms/pre_ms to see where startup time goes.
      track("pipeline.opening.ready", { roundtrip_ms: Date.now() - t0 });
      await deliverLine(gen, { ...reply, action: "next", is_closing: false }, ac, { candidateAnswer: null, ackDone: null });
    } catch (err) {
      if (gen !== genRef.current) return;
      addLog("error", "FLOW", `Could not start: ${err instanceof Error ? err.message : String(err)}`);
      track("pipeline.turn.failed", { opening: true, error: String(err).slice(0, 160) });
      setPhase("error");
    }
  }, [addLog, deliverLine, loadClips, postTurn, setPhase, track]);

  const stopEverything = useCallback(() => {
    genRef.current++;
    speakingUndoRef.current = null;
    micMeterRef.current?.close();
    micMeterRef.current = null;
    turnAbortRef.current?.abort();
    turnAbortRef.current = null;
    voiceRef.current?.stopAll();
    captureRef.current?.destroy();
  }, []);

  const endEarly = useCallback(async () => {
    addLog("warn", "FLOW", "Interview ended early — saving partial session");
    track("pipeline.ended_early", {});
    stopEverything();
    setPhase("completed");
    try {
      await fetch(`/api/sessions/${sessionToken}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ early_exit: true }),
      });
    } catch {
      /* best-effort */
    }
  }, [addLog, sessionToken, setPhase, stopEverything, track]);

  const reset = useCallback(() => {
    stopEverything();
    voiceRef.current?.close();
    voiceRef.current = typeof window !== "undefined" ? new MayaVoice() : null;
    sttPrepareRef.current = null;
    setRemoteAudioTrack(null);
    turnIndexRef.current = 0;
    setTurnIndex(0);
    setTurns([]);
    setTranscript("");
    setCurrentQuestion("");
    setCandidateListeningPhase("idle");
    setPhase("idle");
  }, [setPhase, stopEverything]);

  // ── Avatar hooks (same names as the GPT-Live engine) ──────────────────────
  const setPlaybackMuted = useCallback((muted: boolean) => {
    avatarActiveRef.current = muted;
    voiceRef.current?.setSpeakerMuted(muted);
    track(muted ? "pipeline.playback.muted_for_avatar" : "pipeline.playback.unmuted", {});
  }, [track]);
  const setAvatarSpeaking = useCallback((_speaking: boolean) => {
    /* the pipeline never waits on the avatar: its own audio graph is the source of truth */
  }, []);
  const getAudioDebug = useCallback(
    () => ({
      engine: "pipeline",
      phase: phaseRef.current,
      ms_since_maya_audible: voiceRef.current?.msSinceAudible() ?? null,
      maya_playing: voiceRef.current?.isPlaying() ?? false,
      audio_context: voiceRef.current?.contextState ?? "none",
    }),
    []
  );

  // Unmount: stop paying for anything still running.
  useEffect(() => {
    return () => {
      genRef.current++;
      turnAbortRef.current?.abort();
      voiceRef.current?.close();
    };
  }, []);

  const turnState: TurnOrchestrationState =
    state === "speaking" ? "AI_SPEAKING" : state === "processing" ? "FINALIZING" : "LISTENING";

  const conversationTurnPhase: ConversationTurnPhase = useMemo(() => {
    if (state === "processing") return "AI_DECIDING";
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
  }, [state, candidateListeningPhase]);

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
    startInterview,
    prewarm,
    finishAnswer,
    endEarly,
    reset,
    // avatar
    remoteAudioTrack,
    setPlaybackMuted,
    setAvatarSpeaking,
    getAudioDebug,
  };
}
