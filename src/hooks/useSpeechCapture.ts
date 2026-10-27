import { useRef, useCallback } from "react";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { getPcmCaptureWorkletUrl } from "@/lib/pcmWorkletUrl";

export type AddLog = (
  level: "info" | "success" | "error" | "warn",
  step: string,
  message: string
) => void;

export type SpeechCaptureProvider = "deepgram" | "webspeech";

/** Passed on each Deepgram speech_final / Web Speech end heuristic */
export interface SpeechEndMeta {
  segmentText: string;
  provider: SpeechCaptureProvider;
}

interface Options {
  sessionToken: string;
  onTranscript: (text: string, isFinal: boolean, speechFinal?: boolean) => void;
  onSpeechEnd?: (avgConfidence: number, meta: SpeechEndMeta) => void;
  onUtteranceEnd?: () => void;
  onVadSpeechStarted?: () => void;
  onVadSpeechStopped?: () => void;
  onError: (err: Error) => void;
  addLog?: AddLog;
  enqueueSpeechTelemetry?: (ev: {
    event_name: string;
    attrs?: Record<string, unknown>;
  }) => void;
  /** Deepgram `endpointing` (ms silence before `speech_final`). Interview uses default 300; mic check should pass a higher value. */
  liveEndpointingMs?: number;
  /** Deepgram `utterance_end_ms`. Optional override when longer pauses are acceptable (e.g. system check). */
  liveUtteranceEndMs?: number;
  /** Web Speech: ms of silence after a `isFinal` result before `onSpeechEnd`. Default 800; raise for read-aloud phrases. */
  webSpeechPostFinalMs?: number;
}

// ─── Tunables ────────────────────────────────────────────────────────────────
/** Silence before Deepgram marks `speech_final` — higher = fewer mid-sentence cuts (interview comfort). */
export const DG_ENDPOINTING_MS = 520;
/** Server-side utterance gap before UtteranceEnd — higher = fewer false “utterance done” during thinking pauses. */
export const DG_UTTERANCE_END_MS = 2_600;

/** Deepgram live streaming expects raw linear16 at this rate (Hz). */
export const DG_PCM_SAMPLE_RATE = 16_000;
/** Batch PCM frames to the websocket (20–100 ms @ 16 kHz mono). */
export const DG_PCM_FRAME_MS = 40;

/** Override with `NEXT_PUBLIC_DEEPGRAM_STT_MODEL` (e.g. `nova-2`, `nova-3`). */
const DEEPGRAM_STT_MODEL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_DEEPGRAM_STT_MODEL?.trim()) || "nova-3";

/** e.g. `en-US`, `en-IN`, `en-GB` — set `NEXT_PUBLIC_DEEPGRAM_STT_LANGUAGE` for better regional accuracy. */
const DEEPGRAM_STT_LANGUAGE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_DEEPGRAM_STT_LANGUAGE?.trim()) || "en-US";

/** Boost tech terms common in Laravel interviews (colon + integer weight 1–5). Nova-2 / Base only — see `buildLiveBoostTerms`. */
const DEEPGRAM_KEYTERMS: string[] = [
  "Laravel:4",
  "Eloquent:4",
  "Blade:3",
  "Artisan:3",
  "PHPUnit:3",
  "Pest:3",
  "MVC:4",
  "ORM:3",
  "middleware:3",
  "migration:3",
  "controller:3",
  "Livewire:3",
  "Inertia:3",
  "composer:2",
  "redis:2",
  "mysql:2",
  "postgres:2",
  "typescript:3",
  "javascript:2",
];

/**
 * Nova-3 / Flux reject legacy `keywords=word:intensity` — they use `keyterm` instead (no intensity suffix).
 * @see https://developers.deepgram.com/docs/keywords — Nova-2 only for keywords
 * @see https://developers.deepgram.com/docs/keyterm — Nova-3
 */
function buildLiveBoostTerms(model: string, staticKeywords: string[], serverTerms: string[]): { keywords?: string[]; keyterm?: string[] } {
  const useKeyterm = /^nova-3/i.test(model) || /\bflux\b/i.test(model);
  const stripBoost = (t: string) => t.replace(/:\d+(\.\d+)?$/i, "").trim();
  const strippedStatic = staticKeywords.map(stripBoost).filter(Boolean);
  const strippedServer = serverTerms.map(stripBoost).filter(Boolean);
  const merged = useKeyterm
    ? [...strippedStatic, ...strippedServer]
    : [
        ...staticKeywords,
        ...serverTerms.map((t) => {
          const u = String(t).trim();
          return u.includes(":") ? u : `${stripBoost(u)}:3`;
        }),
      ];
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const raw of merged) {
    const t = useKeyterm ? stripBoost(raw) : raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
    if (uniq.length >= 100) break;
  }
  if (useKeyterm) {
    return { keyterm: uniq };
  }
  return { keywords: uniq };
}

/** Only used while WS not yet OPEN (race before `connReady`). Never buffer muted+open (TTS) — that poisons the next utterance. */
const PREROLL_PCM_MAX_CHUNKS = 24;
const KEEPALIVE_INTERVAL_MS = 8_000;
const DG_CONNECT_TIMEOUT_MS = 8_000;
/** No PCM frame dispatched to Deepgram during ACTIVE_CAPTURE */
const CHUNK_GAP_WARN_MS = 1_500;
const PCM_TRANSPORT_WATCHDOG_MS = 5_000;
const THROUGHPUT_LOG_EVERY_N_FRAMES = 50;

type DgCloseFields = { code?: number; reason?: string; wasClean?: boolean; type?: string };

function describeDeepgramEvent(ev: unknown): string {
  if (ev == null) return "(null)";
  if (typeof ev === "string") return ev.slice(0, 480);
  if (ev instanceof Error) return `${ev.name}: ${ev.message}`;
  if (typeof ev === "object") {
    const o = ev as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof o.type === "string") bits.push(`type=${o.type}`);
    if ("code" in o && (typeof o.code === "number" || typeof o.code === "string"))
      bits.push(`code=${o.code}`);
    if (typeof o.reason === "string" && o.reason) bits.push(`reason=${o.reason.slice(0, 140)}`);
    if (typeof o.message === "string" && o.message) bits.push(`message=${o.message.slice(0, 140)}`);
    if ("wasClean" in o && typeof o.wasClean === "boolean") bits.push(`clean=${o.wasClean}`);
    const nested =
      typeof o.error === "object" && o.error
        ? describeDeepgramEvent(o.error)
        : typeof o.details !== "undefined"
          ? describeDeepgramEvent(o.details)
          : null;
    if (nested && nested !== "()") bits.push(`details=${nested.slice(0, 200)}`);
    if (bits.length) return bits.join(" ");
    try { return JSON.stringify(ev); } catch { return "[object]"; }
  }
  return String(ev);
}

// ─── Hook ────────────────────────────────────────────────────────────────────
/**
 * Persistent Deepgram session with **linear16 PCM** from AudioWorklet (no MediaRecorder/WebM).
 * Mic → AudioContext → AudioWorklet → Int16 frames → `connection.send(ArrayBuffer)`.
 */
export function useSpeechCapture({
  sessionToken,
  onTranscript,
  onSpeechEnd,
  onUtteranceEnd,
  onVadSpeechStarted,
  onVadSpeechStopped,
  onError,
  addLog,
  enqueueSpeechTelemetry,
  liveEndpointingMs,
  liveUtteranceEndMs,
  webSpeechPostFinalMs,
}: Options) {
  const endpointingMs = liveEndpointingMs ?? DG_ENDPOINTING_MS;
  const utteranceEndMs = liveUtteranceEndMs ?? DG_UTTERANCE_END_MS;
  const webSpeechEndMs = webSpeechPostFinalMs ?? 800;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connectionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webSpeechRef = useRef<any>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const zeroGainRef = useRef<GainNode | null>(null);
  /** Stream the current PCM graph was built from (recreate if stream identity changes). */
  const pcmGraphStreamRef = useRef<MediaStream | null>(null);

  const activeRef = useRef(false);
  const sessionIdRef = useRef(0);
  const connReadyRef = useRef(false);
  const preRollPcmRef = useRef<ArrayBuffer[]>([]);

  const keepAliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dgTokenRef = useRef<string | null>(null);
  /** Job-derived terms from `/api/deepgram/token` — merged into `keyterm` (Nova-3) or `keywords` (Nova-2). */
  const dgServerBoostTermsRef = useRef<string[]>([]);
  const turnSttT0Ref = useRef<number>(0);
  const firstInterimEmittedRef = useRef(false);
  const webSpeechLastFinalRef = useRef("");

  const chunkSeqRef = useRef(0);
  const lastChunkDispatchAtRef = useRef(0);
  const lastChunkSentAtRef = useRef(0);
  const bytesSentRef = useRef(0);
  const sendFailureCountRef = useRef(0);
  const keepaliveSentRef = useRef(0);
  const keepaliveFailRef = useRef(0);
  const lastThroughputEmitAtRef = useRef(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connectionSnapshotRef = useRef<any>(null);
  const chunkGapWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pcmTransportWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activateRef = useRef<() => void>(() => {});
  const lastPcmFromWorkletAtRef = useRef(0);
  /** Latest `start()` — used by Close-handler reconnect to avoid a stale `start` closure. */
  const startRef = useRef<() => Promise<void>>(async () => {});

  const clearChunkGapWatchdog = useCallback(() => {
    if (chunkGapWatchdogRef.current !== null) {
      clearTimeout(chunkGapWatchdogRef.current);
      chunkGapWatchdogRef.current = null;
    }
  }, []);

  const armChunkGapWatchdog = useCallback(() => {
    clearChunkGapWatchdog();
    if (!activeRef.current) return;
    chunkGapWatchdogRef.current = setTimeout(() => {
      if (!activeRef.current) return;
      const lastSent = lastChunkSentAtRef.current;
      const gapMs = lastSent > 0 ? Date.now() - lastSent : -1;
      const wsState = connectionRef.current?.getReadyState?.() ?? -1;
      const tracksOk = streamRef.current?.getTracks().every((t) => t.readyState === "live") ?? false;
      const msSinceWorklet = lastPcmFromWorkletAtRef.current > 0 ? Date.now() - lastPcmFromWorkletAtRef.current : -1;
      if (lastSent <= 0) {
        addLog?.(
          "warn",
          "STT",
          `⚠ PCM gap watchdog: no audio frames sent since activate | WS:${wsState} worklet_age:${msSinceWorklet}ms tracks:${tracksOk}`
        );
        enqueueSpeechTelemetry?.({
          event_name: "stt.audio_stream_stall",
          attrs: {
            audio_stream_stall: true,
            time_since_last_chunk: -1,
            gap_ms: -1,
            no_chunks_yet: true,
            websocket_ready_state: wsState,
            ws_ready_state: wsState,
            recorder_state: "pcm_worklet",
            ms_since_worklet_frame: msSinceWorklet,
            tracks_live: tracksOk,
            bytes_sent: bytesSentRef.current,
            bytes_sent_total: bytesSentRef.current,
            send_failures: sendFailureCountRef.current,
            chunk_id: chunkSeqRef.current,
            chunk_seq: chunkSeqRef.current,
          },
        });
        return;
      }
      addLog?.(
        "warn",
        "STT",
        `⚠ PCM gap watchdog: ${gapMs}ms since last send | WS:${wsState} worklet_age:${msSinceWorklet}ms tracks:${tracksOk}`
      );
      enqueueSpeechTelemetry?.({
        event_name: "stt.audio_stream_stall",
        attrs: {
          audio_stream_stall: true,
          time_since_last_chunk: gapMs,
          gap_ms: gapMs,
          websocket_ready_state: wsState,
          ws_ready_state: wsState,
          recorder_state: "pcm_worklet",
          ms_since_worklet_frame: msSinceWorklet,
          tracks_live: tracksOk,
          bytes_sent: bytesSentRef.current,
          bytes_sent_total: bytesSentRef.current,
          send_failures: sendFailureCountRef.current,
          chunk_id: chunkSeqRef.current,
          chunk_seq: chunkSeqRef.current,
        },
      });
    }, CHUNK_GAP_WARN_MS);
  }, [addLog, enqueueSpeechTelemetry, clearChunkGapWatchdog]);

  const stopPcmTransportWatchdog = useCallback(() => {
    if (pcmTransportWatchdogRef.current !== null) {
      clearInterval(pcmTransportWatchdogRef.current);
      pcmTransportWatchdogRef.current = null;
    }
  }, []);

  const startPcmTransportWatchdog = useCallback(() => {
    stopPcmTransportWatchdog();
    pcmTransportWatchdogRef.current = setInterval(() => {
      const wsState = connectionRef.current?.getReadyState?.() ?? -1;
      const ctxState = audioCtxRef.current?.state ?? "none";
      if (ctxState !== "running" && ctxState !== "closed") {
        addLog?.("warn", "STT", `⚠ PCM transport: AudioContext state '${ctxState}' | WS:${wsState}`);
        enqueueSpeechTelemetry?.({
          event_name: "stt.recorder_state_drift",
          attrs: {
            expected: "running",
            recorder_state: `audio_context:${ctxState}`,
            actual: ctxState,
            active: activeRef.current,
            websocket_ready_state: wsState,
            ws_ready_state: wsState,
            bytes_sent: bytesSentRef.current,
            send_failures: sendFailureCountRef.current,
          },
        });
      }
      if (activeRef.current && lastPcmFromWorkletAtRef.current > 0) {
        const age = Date.now() - lastPcmFromWorkletAtRef.current;
        if (age > CHUNK_GAP_WARN_MS) {
          enqueueSpeechTelemetry?.({
            event_name: "stt.pcm_worklet_stall",
            attrs: {
              ms_since_worklet_frame: age,
              websocket_ready_state: wsState,
              audio_context_state: ctxState,
            },
          });
        }
      }
    }, PCM_TRANSPORT_WATCHDOG_MS);
  }, [addLog, enqueueSpeechTelemetry, stopPcmTransportWatchdog]);

  const stopKeepalive = useCallback(() => {
    if (keepAliveIntervalRef.current !== null) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }
  }, []);

  const startKeepalive = useCallback(() => {
    stopKeepalive();
    keepAliveIntervalRef.current = setInterval(() => {
      const wsState = connectionRef.current?.getReadyState?.();
      if (wsState === 1) {
        try {
          connectionRef.current.keepAlive();
          keepaliveSentRef.current++;
          addLog?.("info", "STT", `Keepalive #${keepaliveSentRef.current} sent`);
          enqueueSpeechTelemetry?.({
            event_name: "stt.keepalive_sent",
            attrs: {
              keepalive_sent: keepaliveSentRef.current,
              count: keepaliveSentRef.current,
              keepalive_ack: true,
              websocket_ready_state: wsState,
              ws_ready_state: wsState,
            },
          });
        } catch (err) {
          keepaliveFailRef.current++;
          const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
          addLog?.("warn", "STT", `Keepalive failed: ${msg}`);
          enqueueSpeechTelemetry?.({
            event_name: "stt.keepalive_failed",
            attrs: { keepalive_ack: false, fail_count: keepaliveFailRef.current, error: msg },
          });
          stopKeepalive();
        }
      } else {
        enqueueSpeechTelemetry?.({
          event_name: "stt.keepalive_dropped",
          attrs: { keepalive_ack: false, websocket_ready_state: wsState ?? -1, count: keepaliveSentRef.current },
        });
        stopKeepalive();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }, [addLog, enqueueSpeechTelemetry, stopKeepalive]);

  const teardownPcmPipeline = useCallback(() => {
    try { workletNodeRef.current?.port.close(); } catch { /* ignore */ }
    try { mediaSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { workletNodeRef.current?.disconnect(); } catch { /* ignore */ }
    try { zeroGainRef.current?.disconnect(); } catch { /* ignore */ }
    try {
      if (audioCtxRef.current?.state !== "closed") void audioCtxRef.current?.close();
    } catch { /* ignore */ }
    workletNodeRef.current = null;
    mediaSourceRef.current = null;
    zeroGainRef.current = null;
    audioCtxRef.current = null;
    pcmGraphStreamRef.current = null;
    lastPcmFromWorkletAtRef.current = 0;
  }, []);

  const cleanupDeepgramConnectionOnly = useCallback(() => {
    stopKeepalive();
    clearChunkGapWatchdog();
    if (connectionRef.current) {
      try { connectionRef.current.requestClose(); } catch { /* ignore */ }
      try { connectionRef.current.disconnect(); } catch { /* ignore */ }
      connectionRef.current = null;
    }
    connReadyRef.current = false;
    connectionSnapshotRef.current = null;
  }, [stopKeepalive, clearChunkGapWatchdog]);

  const cleanupAll = useCallback(() => {
    stopKeepalive();
    stopPcmTransportWatchdog();
    clearChunkGapWatchdog();
    teardownPcmPipeline();
    if (connectionRef.current) {
      try { connectionRef.current.requestClose(); } catch { /* ignore */ }
      try { connectionRef.current.disconnect(); } catch { /* ignore */ }
      connectionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    connReadyRef.current = false;
    connectionSnapshotRef.current = null;
    preRollPcmRef.current = [];
  }, [stopKeepalive, stopPcmTransportWatchdog, clearChunkGapWatchdog, teardownPcmPipeline]);

  const startWebSpeech = useCallback(
    (mySession: number, fallbackPerfStartMs?: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const SR = typeof window !== "undefined" && (w.SpeechRecognition || w.webkitSpeechRecognition);
      if (!SR) throw new Error("Browser SpeechRecognition not supported");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sr: any = new SR();
      sr.lang = "en-US";
      sr.continuous = true;
      sr.interimResults = true;
      sr.maxAlternatives = 1;
      webSpeechRef.current = sr;

      let pendingFinalTimer: ReturnType<typeof setTimeout> | null = null;
      let fallbackReadyEmitted = false;

      sr.onresult = (event: {
        results: { isFinal: boolean; 0: { transcript: string } }[];
      }) => {
        if (sessionIdRef.current !== mySession) { sr.stop(); return; }
        if (!fallbackReadyEmitted && fallbackPerfStartMs != null) {
          fallbackReadyEmitted = true;
          enqueueSpeechTelemetry?.({
            event_name: "stt.fallback.ready",
            attrs: {
              ms_until_first_transcript_hypothesis: Math.round(
                performance.now() - fallbackPerfStartMs
              ),
            },
          });
        }
        const last = event.results[event.results.length - 1];
        const text = last[0].transcript.trim();
        const isFinal = last.isFinal;
        onTranscript(text, isFinal);
        if (isFinal) {
          webSpeechLastFinalRef.current = text;
          addLog?.("success", "STT", `[Web Speech] "${text}"`);
          if (pendingFinalTimer) clearTimeout(pendingFinalTimer);
          pendingFinalTimer = setTimeout(() => {
            if (sessionIdRef.current !== mySession) return;
            onSpeechEnd?.(0.85, {
              segmentText: webSpeechLastFinalRef.current || text,
              provider: "webspeech",
            });
          }, webSpeechEndMs);
        }
      };
      sr.onerror = (ev: { error: string }) => {
        if (sessionIdRef.current !== mySession) return;
        if (ev.error === "no-speech") return;
        addLog?.("error", "STT", `Web Speech error: ${ev.error}`);
        onError(new Error(`Web Speech API error: ${ev.error}`));
      };
      sr.onend = () => {
        if (sessionIdRef.current !== mySession) return;
        if (activeRef.current) { try { sr.start(); } catch { /* ignore */ } }
      };
      sr.start();
      addLog?.("info", "STT", "Web Speech API started");
    },
    [onTranscript, onSpeechEnd, onError, addLog, enqueueSpeechTelemetry, webSpeechEndMs]
  );

  const handleEndOfTurn = useCallback(
    (transcript: string, avgConf: number) => {
      const segWords = transcript.trim().split(/\s+/).filter(Boolean).length;
      addLog?.("info", "STT", `End-of-utterance (${segWords} words, conf ${Math.round(avgConf * 100)}%)`);
      onSpeechEnd?.(avgConf, { segmentText: transcript, provider: "deepgram" });
    },
    [addLog, onSpeechEnd]
  );

  /**
   * Route one linear16 PCM frame (raw ArrayBuffer from worklet).
   * Must not capture `mySession` from graph creation: the PCM graph is reused across
   * websocket reconnects while `sessionIdRef` advances — only refs drive gating.
   */
  const ingestPcmFrame = useCallback((pcmBuffer: ArrayBuffer) => {
      const chunkId = ++chunkSeqRef.current;
      const now = Date.now();
      const byteLen = pcmBuffer.byteLength;

      lastPcmFromWorkletAtRef.current = now;

      const gapSinceLastDispatch =
        lastChunkDispatchAtRef.current > 0 ? now - lastChunkDispatchAtRef.current : 0;
      lastChunkDispatchAtRef.current = now;

      if (gapSinceLastDispatch > 1_000) {
        enqueueSpeechTelemetry?.({
          event_name: "stt.chunk.gap_detected",
          attrs: {
            chunk_id: chunkId,
            chunk_timestamp: now,
            chunk_size: byteLen,
            time_since_last_chunk: gapSinceLastDispatch,
            gap_ms: gapSinceLastDispatch,
            recorder_state: "pcm_worklet",
            active: activeRef.current,
            websocket_ready_state: connectionRef.current?.getReadyState?.() ?? -1,
            encoding: "linear16",
            sample_rate: DG_PCM_SAMPLE_RATE,
          },
        });
      }

      if (!connReadyRef.current) {
        preRollPcmRef.current.push(pcmBuffer.slice(0));
        while (preRollPcmRef.current.length > PREROLL_PCM_MAX_CHUNKS) preRollPcmRef.current.shift();
        return;
      }

      // Muted but WS already open (TTS / between turns): **do not** pre-roll — that audio is
      // speaker bleed and room noise. Flushing it on activate() made Deepgram see garbage
      // before the candidate spoke ("NVC", "show", low confidence, false "disconnect" feel).
      if (!activeRef.current) return;

      const conn = connectionRef.current;
      const wsState = conn?.getReadyState?.() ?? -1;
      const recState = "pcm_worklet";

      if (conn !== connectionSnapshotRef.current && connectionSnapshotRef.current !== null) {
        addLog?.("warn", "STT", `Stale WS ref on PCM frame #${chunkId} — connection swapped after activate()`);
        enqueueSpeechTelemetry?.({
          event_name: "stt.stale_reference_detected",
          attrs: {
            chunk_id: chunkId,
            chunk_timestamp: now,
            chunk_size: byteLen,
            websocket_ready_state: wsState,
            recorder_state: recState,
          },
        });
        connectionSnapshotRef.current = conn;
      }

      if (wsState !== 1) {
        sendFailureCountRef.current++;
        enqueueSpeechTelemetry?.({
          event_name: "stt.chunk.send_failed",
          attrs: {
            chunk_id: chunkId,
            chunk_timestamp: now,
            chunk_size: byteLen,
            websocket_ready_state: wsState,
            recorder_state: recState,
            reason: "ws_not_open_during_active",
            send_failures: sendFailureCountRef.current,
          },
        });
        armChunkGapWatchdog();
        return;
      }

      try {
        conn.send(pcmBuffer);
        bytesSentRef.current += byteLen;
        lastChunkSentAtRef.current = now;
        armChunkGapWatchdog();

        if (chunkId % THROUGHPUT_LOG_EVERY_N_FRAMES === 0) {
          const tSince = lastThroughputEmitAtRef.current > 0 ? now - lastThroughputEmitAtRef.current : 0;
          lastThroughputEmitAtRef.current = now;
          enqueueSpeechTelemetry?.({
            event_name: "stt.pcm_throughput",
            attrs: {
              chunk_id: chunkId,
              chunk_timestamp: now,
              bytes_sent: bytesSentRef.current,
              send_failures: sendFailureCountRef.current,
              time_since_last_chunk: tSince,
              websocket_ready_state: wsState,
              recorder_state: recState,
              encoding: "linear16",
              sample_rate: DG_PCM_SAMPLE_RATE,
            },
          });
        }
      } catch (err) {
        sendFailureCountRef.current++;
        const msg = err instanceof Error ? err.message : String(err);
        addLog?.("warn", "STT", `PCM send() threw #${chunkId}: ${msg}`);
        enqueueSpeechTelemetry?.({
          event_name: "stt.chunk.send_failed",
          attrs: {
            chunk_id: chunkId,
            chunk_size: byteLen,
            error: msg.slice(0, 200),
            send_failures: sendFailureCountRef.current,
          },
        });
      }
  }, [addLog, enqueueSpeechTelemetry, armChunkGapWatchdog]);

  const ensurePcmPipeline = useCallback(
    async (stream: MediaStream) => {
      if (
        pcmGraphStreamRef.current === stream &&
        audioCtxRef.current &&
        audioCtxRef.current.state !== "closed" &&
        workletNodeRef.current
      ) {
        if (audioCtxRef.current.state === "suspended") {
          await audioCtxRef.current.resume().catch(() => {});
        }
        addLog?.("info", "STT", "PCM pipeline — reusing existing AudioWorklet graph");
        return;
      }

      teardownPcmPipeline();

      const AudioContextCtor =
        typeof window !== "undefined"
          ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : null;
      if (!AudioContextCtor) throw new Error("Web Audio API not available");

      const ctx = new AudioContextCtor() as AudioContext;
      audioCtxRef.current = ctx;

      const workletHref = getPcmCaptureWorkletUrl();
      await ctx.audioWorklet.addModule(workletHref);

      const workletNode = new AudioWorkletNode(ctx, "pcm-capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          targetSampleRate: DG_PCM_SAMPLE_RATE,
          frameMs: DG_PCM_FRAME_MS,
        },
      });
      workletNodeRef.current = workletNode;

      workletNode.port.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (!d || d.type !== "pcm" || !(d.buffer instanceof ArrayBuffer)) return;
        ingestPcmFrame(d.buffer);
      };

      const src = ctx.createMediaStreamSource(stream);
      mediaSourceRef.current = src;
      const zero = ctx.createGain();
      zero.gain.value = 0;
      zeroGainRef.current = zero;
      src.connect(workletNode);
      workletNode.connect(zero);
      zero.connect(ctx.destination);

      await ctx.resume().catch(() => {});

      pcmGraphStreamRef.current = stream;
      startPcmTransportWatchdog();
      addLog?.(
        "info",
        "STT",
        `PCM capture live (ctx ${ctx.sampleRate} Hz → linear16 @ ${DG_PCM_SAMPLE_RATE} Hz, ~${DG_PCM_FRAME_MS} ms frames)`
      );
      enqueueSpeechTelemetry?.({
        event_name: "stt.pcm_pipeline_ready",
        attrs: {
          context_sample_rate: ctx.sampleRate,
          target_sample_rate: DG_PCM_SAMPLE_RATE,
          frame_ms: DG_PCM_FRAME_MS,
          encoding: "linear16",
        },
      });
    },
    [addLog, enqueueSpeechTelemetry, ingestPcmFrame, startPcmTransportWatchdog, teardownPcmPipeline]
  );

  const start = useCallback(async () => {
    if (connectionRef.current?.getReadyState() === 1 && streamRef.current?.active) {
      activeRef.current = false;
      preRollPcmRef.current = [];
      firstInterimEmittedRef.current = false;
      addLog?.("info", "STT", `Session alive — reusing WS | bytes=${bytesSentRef.current}`);
      enqueueSpeechTelemetry?.({
        event_name: "stt.session.reused",
        attrs: { type: "persistent_no_reconnect", transport: "linear16_pcm", bytes_sent: bytesSentRef.current },
      });
      return;
    }

    const mySession = ++sessionIdRef.current;
    activeRef.current = false;
    connReadyRef.current = false;
    preRollPcmRef.current = [];
    firstInterimEmittedRef.current = false;
    sendFailureCountRef.current = 0;
    bytesSentRef.current = 0;
    keepaliveSentRef.current = 0;
    keepaliveFailRef.current = 0;
    lastChunkSentAtRef.current = 0;
    lastThroughputEmitAtRef.current = 0;

    const connectStartMs = Date.now();

    try {
      let token = dgTokenRef.current;
      if (!token) {
        addLog?.("info", "STT", "Fetching Deepgram token…");
        const tokenRes = await fetch("/api/deepgram/token", {
          method: "POST",
          headers: { "x-session-token": sessionToken },
        });
        if (sessionIdRef.current !== mySession) return;
        if (!tokenRes.ok) {
          const errData = await tokenRes.json().catch(() => ({ error: `HTTP ${tokenRes.status}` }));
          throw new Error(errData.error || "Deepgram token failed");
        }
        const data = await tokenRes.json();
        if (!data.token) throw new Error("Deepgram token missing in response");
        dgTokenRef.current = data.token;
        dgServerBoostTermsRef.current = Array.isArray(data.keywords)
          ? (data.keywords as unknown[]).map((x) => String(x).trim()).filter(Boolean)
          : [];
        token = data.token;
      }

      let stream = streamRef.current;
      const previousStream = streamRef.current;
      if (!stream?.active) {
        addLog?.("info", "STT", "Requesting mic access…");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
        });
        if (sessionIdRef.current !== mySession) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (previousStream && previousStream !== stream) teardownPcmPipeline();
        addLog?.("success", "STT", "Mic granted");
      } else {
        addLog?.("info", "STT", "Reusing MediaStream");
      }

      await ensurePcmPipeline(stream);
      if (sessionIdRef.current !== mySession) return;

      addLog?.("info", "STT", "Connecting Deepgram WebSocket (linear16)…");
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const deepgram = createClient(token!);
      const connection = deepgram.listen.live({
        model: DEEPGRAM_STT_MODEL,
        language: DEEPGRAM_STT_LANGUAGE,
        smart_format: true,
        interim_results: true,
        vad_events: true,
        punctuate: true,
        endpointing: endpointingMs,
        utterance_end_ms: utteranceEndMs,
        encoding: "linear16",
        sample_rate: DG_PCM_SAMPLE_RATE,
        channels: 1,
        ...buildLiveBoostTerms(DEEPGRAM_STT_MODEL, DEEPGRAM_KEYTERMS, dgServerBoostTermsRef.current),
      } as Parameters<typeof deepgram.listen.live>[0]);
      connectionRef.current = connection;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Deepgram connect timeout (8s)"));
        }, DG_CONNECT_TIMEOUT_MS);

        connection.on(LiveTranscriptionEvents.Open, () => {
          if (sessionIdRef.current !== mySession) return;
          clearTimeout(timeout);
          connReadyRef.current = true;
          const connectMs = Date.now() - connectStartMs;
          addLog?.("success", "STT", `Deepgram WS open (${connectMs}ms) — linear16 @ ${DG_PCM_SAMPLE_RATE} Hz`);
          enqueueSpeechTelemetry?.({
            event_name: "stt.session.connected",
            attrs: {
              connect_ms: connectMs,
              transport: "linear16_pcm",
              sample_rate: DG_PCM_SAMPLE_RATE,
            },
          });
          if (!activeRef.current) {
            startKeepalive();
            addLog?.("info", "STT", "Keepalive armed on Open (muted)");
            enqueueSpeechTelemetry?.({ event_name: "stt.keepalive_armed_on_open", attrs: { connect_ms: connectMs } });
          }
          resolve();
        });

        connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
          if (sessionIdRef.current !== mySession || !activeRef.current) return;
          addLog?.("info", "STT", "UtteranceEnd (server silence threshold)");
          onUtteranceEnd?.();
        });

        const metaKey = (LiveTranscriptionEvents as unknown as Record<string, string>).Metadata;
        if (typeof metaKey === "string") {
          connection.on(metaKey, (payload: unknown) => {
            if (sessionIdRef.current !== mySession || !activeRef.current) return;
            let metaType: string | undefined;
            if (typeof payload === "object" && payload !== null && "type" in payload) {
              metaType = String((payload as { type: unknown }).type);
            } else if (typeof payload === "string") {
              try { metaType = (JSON.parse(payload) as { type?: string }).type; } catch { /* ignore */ }
            }
            if (metaType === "SpeechStarted") { addLog?.("info", "STT", "VAD: SpeechStarted"); onVadSpeechStarted?.(); }
            if (metaType === "SpeechEnded" || metaType === "EndOfSpeech" || metaType === "UtteranceEnd") {
              addLog?.("info", "STT", `VAD/metadata: ${metaType}`); onVadSpeechStopped?.();
            }
          });
        }

        connection.on(LiveTranscriptionEvents.Transcript, (dgData: unknown) => {
          if (sessionIdRef.current !== mySession || !activeRef.current) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const d = dgData as any;
          const alt = d?.channel?.alternatives?.[0];
          const transcript = (alt?.transcript ?? "").trim();
          const isFinal = d?.is_final ?? false;
          const speechFinal = d?.speech_final ?? false;
          const confidence = alt?.confidence ?? 1;
          if (!transcript) return;

          if (!firstInterimEmittedRef.current && turnSttT0Ref.current > 0) {
            firstInterimEmittedRef.current = true;
            enqueueSpeechTelemetry?.({
              event_name: "stt.first_interim",
              attrs: { latency_ms: Math.round(performance.now() - turnSttT0Ref.current), is_final: isFinal },
            });
          }
          onTranscript(transcript, isFinal, speechFinal);
          if (isFinal) {
            addLog?.(speechFinal ? "success" : "info", "STT",
              `${speechFinal ? "[END_OF_UTTERANCE]" : "[final]"} "${transcript}"`);
            if (speechFinal) {
              if (turnSttT0Ref.current > 0) {
                enqueueSpeechTelemetry?.({
                  event_name: "stt.final_latency",
                  attrs: {
                    latency_ms: Math.round(performance.now() - turnSttT0Ref.current),
                    confidence: Math.round(confidence * 100),
                    bytes_sent: bytesSentRef.current,
                    chunk_seq: chunkSeqRef.current,
                  },
                });
              }
              handleEndOfTurn(transcript, confidence);
            }
          }
        });

        connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
          const detail = describeDeepgramEvent(err);
          addLog?.("error", "STT", `Deepgram SDK error: ${detail}`);
          enqueueSpeechTelemetry?.({ event_name: "stt.deepgram.error", attrs: { detail: detail.slice(0, 500) } });
        });

        connection.on(LiveTranscriptionEvents.Close, (ev: unknown) => {
          clearTimeout(timeout);
          const e = ev as DgCloseFields;
          const code = e?.code ?? "unknown";
          const reason = e?.reason || "Connection closed";
          const detail = describeDeepgramEvent(ev);
          const hint =
            typeof code === "number" && code === 1006
              ? " — WS 1006 = abnormal close."
              : typeof code === "number" && code === 1000
                ? " — WS 1000 = normal close."
                : "";

          const closeContext = {
            deepgram_code: String(code),
            reason: reason.slice(0, 200),
            active_at_close: activeRef.current,
            bytes_sent: bytesSentRef.current,
            send_failures: sendFailureCountRef.current,
            chunk_seq: chunkSeqRef.current,
            keepalives_sent: keepaliveSentRef.current,
            keepalive_fails: keepaliveFailRef.current,
            transport: "linear16_pcm",
            ms_since_last_chunk:
              lastChunkSentAtRef.current > 0 ? Date.now() - lastChunkSentAtRef.current : -1,
          };

          clearChunkGapWatchdog();

          if (!connReadyRef.current) {
            addLog?.("warn", "STT", `Deepgram closed before OPEN: ${detail}${hint}`);
            reject(new Error(`Deepgram connection failed (${code}): ${reason || detail}${hint}`));
            return;
          }

          if (sessionIdRef.current !== mySession) return;

          enqueueSpeechTelemetry?.({ event_name: "stt.websocket.closed", attrs: closeContext });

          if (activeRef.current) {
            addLog?.("warn", "STT", `DG closed during ACTIVE_CAPTURE (code:${code})${hint}`);
            cleanupDeepgramConnectionOnly();
            const reconnectStartMs = Date.now();
            enqueueSpeechTelemetry?.({
              event_name: "stt.deepgram.reconnect_attempt",
              attrs: { ...closeContext, trigger: "active_close", reconnect_reason: "server_close_active" },
            });
            void (async () => {
              try {
                await startRef.current();
                activateRef.current();
                const reconnectMs = Date.now() - reconnectStartMs;
                addLog?.("success", "STT", `Reconnected in ${reconnectMs}ms`);
                enqueueSpeechTelemetry?.({
                  event_name: "stt.reconnect.completed",
                  attrs: {
                    reconnect_duration_ms: reconnectMs,
                    reconnect_ms: reconnectMs,
                    reconnect_reason: "server_close_active",
                    close_code: String(code),
                  },
                });
              } catch (reconnErr) {
                const reconnMs = Date.now() - reconnectStartMs;
                const errMsg = reconnErr instanceof Error ? reconnErr.message.slice(0, 200) : String(reconnErr);
                addLog?.("warn", "STT", `Reconnect failed: ${errMsg}`);
                enqueueSpeechTelemetry?.({
                  event_name: "stt.reconnect.failed",
                  attrs: {
                    reconnect_duration_ms: reconnMs,
                    reconnect_ms: reconnMs,
                    reconnect_reason: "server_close_active",
                    error: errMsg,
                    close_code: String(code),
                  },
                });
                const fbT0 = performance.now();
                try {
                  startWebSpeech(mySession, fbT0);
                  enqueueSpeechTelemetry?.({
                    event_name: "stt.fallback",
                    attrs: { from: "deepgram", to: "webspeech", stage: "active_disconnect_retry_failed", deepgram_code: String(code) },
                  });
                } catch (fe: unknown) {
                  const feMsg = fe instanceof Error ? fe.message : String(fe);
                  onError(new Error(`STT unavailable. Deepgram: ${reason}. WebSpeech: ${feMsg}`));
                }
              }
            })();
            return;
          }

          addLog?.("warn", "STT", `DG closed while muted (code:${code})${hint}`);
          cleanupDeepgramConnectionOnly();
        });
      });

      addLog?.("success", "STT", "Speech capture ready (PCM + persistent session)");
    } catch (err: unknown) {
      cleanupAll();
      if (sessionIdRef.current !== mySession) return;
      const dgMsg = err instanceof Error ? err.message : String(err);
      addLog?.("warn", "STT", `Deepgram init failed: ${dgMsg} — Web Speech fallback…`);
      try {
        const fbT0 = performance.now();
        startWebSpeech(mySession, fbT0);
        enqueueSpeechTelemetry?.({
          event_name: "stt.fallback",
          attrs: { from: "deepgram", to: "webspeech", stage: "connect_failed", detail: dgMsg.slice(0, 500) },
        });
      } catch (wsErr: unknown) {
        const wsMsg = wsErr instanceof Error ? wsErr.message : String(wsErr);
        addLog?.("error", "STT", `All STT providers failed: ${wsMsg}`);
        onError(new Error(`STT unavailable. Deepgram: ${dgMsg}. WebSpeech: ${wsMsg}`));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionToken,
    onTranscript,
    onUtteranceEnd,
    onVadSpeechStarted,
    onVadSpeechStopped,
    onError,
    addLog,
    enqueueSpeechTelemetry,
    startWebSpeech,
    handleEndOfTurn,
    cleanupDeepgramConnectionOnly,
    cleanupAll,
    startKeepalive,
    stopKeepalive,
    armChunkGapWatchdog,
    clearChunkGapWatchdog,
    ensurePcmPipeline,
    ingestPcmFrame,
    teardownPcmPipeline,
    endpointingMs,
    utteranceEndMs,
  ]);
  startRef.current = start;

  const activate = useCallback(() => {
    stopKeepalive();
    stopPcmTransportWatchdog();
    clearChunkGapWatchdog();

    activeRef.current = true;
    firstInterimEmittedRef.current = false;
    turnSttT0Ref.current = performance.now();
    connectionSnapshotRef.current = connectionRef.current;

    const buffered = preRollPcmRef.current.splice(0);
    let flushedBytes = 0;
    let flushFailures = 0;
    for (const buf of buffered) {
      const wsState = connectionRef.current?.getReadyState?.() ?? -1;
      if (wsState !== 1) { flushFailures++; continue; }
      try {
        connectionRef.current.send(buf);
        flushedBytes += buf.byteLength;
        bytesSentRef.current += buf.byteLength;
        lastChunkSentAtRef.current = Date.now();
      } catch (err) {
        flushFailures++;
        sendFailureCountRef.current++;
        addLog?.("warn", "STT", `PCM pre-roll flush failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (buffered.length > 0) {
      addLog?.("info", "STT", `PCM pre-open flush: ${buffered.length} frames, ${flushedBytes} B | failures:${flushFailures}`);
    } else {
      addLog?.("info", "STT", "PCM activate — no pre-open frames (TTS-period audio was not buffered)");
    }

    void audioCtxRef.current?.resume().catch(() => {});
    startPcmTransportWatchdog();
    armChunkGapWatchdog();

    addLog?.("success", "STT", `Capture activated (PCM) | bytes_sent=${bytesSentRef.current}`);
  }, [
    addLog,
    stopKeepalive,
    stopPcmTransportWatchdog,
    clearChunkGapWatchdog,
    armChunkGapWatchdog,
    startPcmTransportWatchdog,
  ]);

  activateRef.current = activate;

  const stop = useCallback(() => {
    activeRef.current = false;
    webSpeechLastFinalRef.current = "";
    clearChunkGapWatchdog();
    preRollPcmRef.current = [];

    enqueueSpeechTelemetry?.({
      event_name: "stt.session.muted",
      attrs: {
        bytes_sent: bytesSentRef.current,
        send_failures: sendFailureCountRef.current,
        chunk_seq: chunkSeqRef.current,
        keepalives_sent: keepaliveSentRef.current,
        transport: "linear16_pcm",
      },
    });

    if (connectionRef.current?.getReadyState() === 1) {
      startKeepalive();
      addLog?.("info", "STT", "Capture muted — keepalive armed");
    } else {
      addLog?.("info", "STT", "Capture muted (WS not open)");
    }

    if (webSpeechRef.current) {
      try { webSpeechRef.current.stop(); } catch { /* ignore */ }
      webSpeechRef.current = null;
    }
  }, [addLog, enqueueSpeechTelemetry, startKeepalive, clearChunkGapWatchdog]);

  const destroy = useCallback(() => {
    sessionIdRef.current++;
    activeRef.current = false;
    dgTokenRef.current = null;
    dgServerBoostTermsRef.current = [];
    webSpeechLastFinalRef.current = "";
    cleanupAll();
    stopPcmTransportWatchdog();
    if (webSpeechRef.current) {
      try { webSpeechRef.current.stop(); } catch { /* ignore */ }
      webSpeechRef.current = null;
    }
    addLog?.("info", "STT", `Session destroyed | bytes=${bytesSentRef.current}`);
  }, [addLog, cleanupAll, stopPcmTransportWatchdog]);

  const isSessionAlive = useCallback((): boolean => {
    if (webSpeechRef.current !== null) return true;
    if (connectionRef.current === null) return false;
    return connectionRef.current.getReadyState() === 1;
  }, []);

  const getSharedStream = useCallback((): MediaStream | null => streamRef.current, []);

  /**
   * Ask Deepgram to finalise the words it is still holding as "interim" right now (its `Finalize`
   * control message). Used when the candidate has gone quiet but Deepgram hasn't closed the phrase —
   * measured: it kept re-sending the same unfinished text for ~5 s. Returns false if not possible
   * (Web Speech fallback, socket not open, muted).
   */
  const finalize = useCallback((): boolean => {
    const conn = connectionRef.current;
    if (!activeRef.current || !conn || conn.getReadyState?.() !== 1) return false;
    try {
      if (typeof conn.finalize === "function") conn.finalize();
      else conn.send(JSON.stringify({ type: "Finalize" }));
      enqueueSpeechTelemetry?.({ event_name: "stt.finalize_requested", attrs: {} });
      return true;
    } catch {
      return false;
    }
  }, [enqueueSpeechTelemetry]);

  return { start, activate, stop, destroy, isSessionAlive, getSharedStream, finalize };
}
