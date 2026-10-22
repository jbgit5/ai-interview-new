"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import {
  Mic,
  MicOff,
  RotateCcw,
  Zap,
  CheckCircle2,
  AlertCircle,
  Info,
} from "lucide-react";

// ─── STT Configurations to test ───────────────────────────────────────────────

interface STTConfig {
  id: string;
  vendor: "deepgram" | "webspeech" | "assemblyai";
  label: string;
  description: string;
  model?: string;
  endpointing?: number;
  utterance_end_ms?: number;
  language?: string;
}

const CONFIGS: STTConfig[] = [
  {
    id: "nova3-300",
    vendor: "deepgram",
    label: "Deepgram nova-3 (default)",
    description: "Current production config. nova-3 model, 300ms endpointing, 1500ms utterance end.",
    model: "nova-3",
    endpointing: 300,
    utterance_end_ms: 1500,
    language: "en-US",
  },
  {
    id: "nova3-150",
    vendor: "deepgram",
    label: "Deepgram nova-3 (fast, 150ms)",
    description: "nova-3 with aggressive 150ms endpointing — faster responses, may cut off mid-sentence.",
    model: "nova-3",
    endpointing: 150,
    utterance_end_ms: 1000,
    language: "en-US",
  },
  {
    id: "nova3-500",
    vendor: "deepgram",
    label: "Deepgram nova-3 (relaxed, 500ms)",
    description: "nova-3 with 500ms endpointing — lets you pause without cutting off. Good for thinking.",
    model: "nova-3",
    endpointing: 500,
    utterance_end_ms: 2000,
    language: "en-US",
  },
  {
    id: "nova3-conv",
    vendor: "deepgram",
    label: "Deepgram nova-2-conversationalai",
    description: "Tuned specifically for conversational AI. May handle interview speech patterns better.",
    model: "nova-2-conversationalai",
    endpointing: 300,
    utterance_end_ms: 1500,
    language: "en",
  },
  {
    id: "nova2-300",
    vendor: "deepgram",
    label: "Deepgram nova-2 (legacy)",
    description: "Previous generation model. Comparison baseline.",
    model: "nova-2",
    endpointing: 300,
    utterance_end_ms: 1500,
    language: "en-US",
  },
  {
    id: "webspeech",
    vendor: "webspeech",
    label: "Browser Web Speech API",
    description: "Built-in browser speech recognition (free, no API key). Works offline. Compare vs Deepgram.",
  },
  {
    id: "assemblyai-pro",
    vendor: "assemblyai",
    label: "🔵 AssemblyAI Universal Streaming",
    description: "AssemblyAI's highest accuracy streaming model. Per-word confidence + smart end-of-turn detection. Free tier available at assemblyai.com.",
    model: "universal-streaming-english",
    endpointing: 700,
  },
  {
    id: "assemblyai-whisper",
    vendor: "assemblyai",
    label: "🔵 AssemblyAI Whisper RT",
    description: "Whisper architecture in real-time. Excellent for accented English and technical vocabulary. Needs ASSEMBLYAI_API_KEY.",
    model: "whisper-rt",
    endpointing: 700,
  },
];

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Word {
  word: string;
  confidence: number;
}

interface TranscriptChunk {
  id: number;
  text: string;
  words: Word[];
  isFinal: boolean;
  isSpeechFinal: boolean;
  avgConfidence: number;
  timestamp: string;
}

interface EventLogEntry {
  id: number;
  time: string;
  type: "open" | "transcript" | "speech_final" | "utterance_end" | "close" | "error" | "info";
  message: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

let chunkId = 0;
let logId = 0;

function now() {
  const d = new Date();
  return `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function confidenceColor(c: number): string {
  if (c >= 0.92) return "text-emerald-600";
  if (c >= 0.8) return "text-yellow-600";
  if (c >= 0.65) return "text-orange-500";
  return "text-red-600";
}

function confidenceBg(c: number): string {
  if (c >= 0.92) return "bg-emerald-100";
  if (c >= 0.8) return "bg-yellow-100";
  if (c >= 0.65) return "bg-orange-100";
  return "bg-red-100";
}

// ─── Audio Level Hook ───────────────────────────────────────────────────────────

function useAudioLevel(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!stream) {
      setLevel(0);
      return;
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);
    ctxRef.current = ctx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      setLevel(Math.min(1, avg / 80));
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      src.disconnect();
      ctx.close().catch(() => {});
    };
  }, [stream]);

  return level;
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function VoiceTestPage() {
  const [configId, setConfigId] = useState("nova3-300");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [interimText, setInterimText] = useState("");
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [audioFormat, setAudioFormat] = useState("");
  const [micReady, setMicReady] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [stats, setStats] = useState({
    wordsCaptured: 0,
    avgConfidence: 0,
    speechFinalCount: 0,
    utteranceEndCount: 0,
    chunksSent: 0,
  });
  const [stream, setStream] = useState<MediaStream | null>(null);

  const level = useAudioLevel(stream);

  // Refs for cleanup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connectionRef = useRef<any>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Pre-warmed mic stream — requested on page mount so button click is instant
  const warmMicRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webSpeechRef = useRef<any>(null);
  // AssemblyAI-specific refs
  const aaiWsRef = useRef<WebSocket | null>(null);
  const aaiCtxRef = useRef<AudioContext | null>(null);
  const aaiProcRef = useRef<ScriptProcessorNode | null>(null);
  const chunksSentRef = useRef(0);
  const allConfidencesRef = useRef<number[]>([]);
  const allWordCountRef = useRef(0);

  // Pre-request mic access on page mount — removes getUserMedia delay on "Start"
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    }).then((s) => {
      warmMicRef.current = s;
      setMicReady(true);
    }).catch((err) => {
      setMicError(err instanceof Error ? err.message : "Mic access denied");
    });
    return () => {
      warmMicRef.current?.getTracks().forEach((t) => t.stop());
      warmMicRef.current = null;
    };
  }, []);

  const addLog = useCallback(
    (type: EventLogEntry["type"], message: string) => {
      setEventLog((prev) => [
        { id: ++logId, time: now(), type, message },
        ...prev.slice(0, 99),
      ]);
    },
    []
  );

  const config = CONFIGS.find((c) => c.id === configId)!;

  // ── Stop ──────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;

    try { connectionRef.current?.finish(); } catch { /* ignore */ }
    connectionRef.current = null;

    if (webSpeechRef.current) {
      try { webSpeechRef.current.stop(); } catch { /* ignore */ }
      webSpeechRef.current = null;
    }

    // AssemblyAI cleanup
    if (aaiProcRef.current) {
      try { aaiProcRef.current.disconnect(); } catch { /* ignore */ }
      aaiProcRef.current = null;
    }
    if (aaiWsRef.current && aaiWsRef.current.readyState !== WebSocket.CLOSED) {
      try {
        aaiWsRef.current.send(JSON.stringify({ type: "Terminate" }));
        aaiWsRef.current.close();
      } catch { /* ignore */ }
      aaiWsRef.current = null;
    }
    if (aaiCtxRef.current) {
      try { aaiCtxRef.current.close(); } catch { /* ignore */ }
      aaiCtxRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setStream(null);
    setRunning(false);
    setStatus("idle");
    setInterimText("");
    addLog("info", "Stopped");
  }, [addLog]);

  // ── Start AssemblyAI v3 (PCM WebSocket) ─────────────────────────────────
  const startAssemblyAI = useCallback(
    async (cfg: STTConfig) => {
      setStatus("connecting");
      setStatusMsg("Connecting…");
      addLog("info", `Starting AssemblyAI: ${cfg.label}`);

      // ── Step 1: mic + AudioContext + token fetch ALL in parallel ──────────
      // Reuse pre-warmed mic stream if available, otherwise request fresh
      const micStream = warmMicRef.current ?? await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
      warmMicRef.current = null; // consumed
      streamRef.current = micStream;
      setStream(micStream);

      // Create AudioContext and ScriptProcessor IMMEDIATELY — don't wait for WS
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      aaiCtxRef.current = audioCtx;
      const sampleRate = audioCtx.sampleRate;
      setAudioFormat(`PCM Int16 ${sampleRate}Hz mono (noise-suppressed)`);
      addLog("info", `AudioContext: ${sampleRate}Hz — buffering audio while connecting`);

      // Start capturing into a pre-buffer right now so no speech is lost
      const preBuffer: ArrayBuffer[] = [];
      const src = audioCtx.createMediaStreamSource(micStream);
      const proc = audioCtx.createScriptProcessor(2048, 1, 1);
      const silencer = audioCtx.createGain();
      silencer.gain.value = 0;
      aaiProcRef.current = proc;

      let wsReady = false;
      let wsRef: WebSocket | null = null;

      proc.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        if (!wsReady || !wsRef || wsRef.readyState !== WebSocket.OPEN) {
          // Buffer until WebSocket is ready (cap at ~3s worth)
          if (preBuffer.length < 90) preBuffer.push(int16.buffer.slice(0));
          return;
        }
        wsRef.send(int16.buffer);
        chunksSentRef.current++;
        setStats((s) => ({ ...s, chunksSent: chunksSentRef.current }));
      };

      src.connect(proc);
      proc.connect(silencer);
      silencer.connect(audioCtx.destination);

      // ── Step 2: fetch token (runs while audio is already buffering) ───────
      setStatusMsg("Fetching token…");
      const tokenRes = await fetch("/api/assemblyai/token", { method: "POST" });
      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({ error: "Token fetch failed" }));
        proc.disconnect(); src.disconnect();
        throw new Error((err as { error?: string }).error || "AssemblyAI token failed");
      }
      const { token } = (await tokenRes.json()) as { token: string };

      const wsUrl = `wss://streaming.assemblyai.com/v3/ws?token=${encodeURIComponent(token)}&sample_rate=${sampleRate}&speech_model=${cfg.model ?? "universal-streaming-english"}&format_turns=true`;
      setStatusMsg("Opening WebSocket…");

      const ws = new WebSocket(wsUrl);
      aaiWsRef.current = ws;
      wsRef = ws;

      await new Promise<void>((resolve, reject) => {
        const connTimeout = setTimeout(
          () => reject(new Error("AssemblyAI WebSocket connect timeout")),
          12000
        );

        ws.onerror = () => {
          clearTimeout(connTimeout);
          reject(new Error("AssemblyAI WebSocket error — check ASSEMBLYAI_API_KEY"));
        };

        ws.onclose = () => addLog("close", "AssemblyAI WebSocket closed");

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as {
              type: string;
              id?: string;
              end_of_turn?: boolean;
              transcript?: string;
              end_of_turn_confidence?: number;
              words?: Array<{ text: string; confidence: number; word_is_final: boolean }>;
            };

            if (msg.type === "Begin") {
              clearTimeout(connTimeout);
              addLog("open", `AssemblyAI ready: ${(msg.id ?? "").slice(0, 8)}… — flushing ${preBuffer.length} buffered chunks`);

              // Flush pre-buffered audio so the first words aren't lost
              for (const chunk of preBuffer) {
                if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
              }
              preBuffer.length = 0;
              wsReady = true;

              setStatus("ready");
              setStatusMsg(`${cfg.label} — listening`);
              addLog("open", "AssemblyAI ready — speak now");
              resolve();

            } else if (msg.type === "Turn") {
              const text = (msg.transcript ?? "").trim();
              if (!text) return;
              const isFinal = msg.end_of_turn === true;
              const words: Word[] = (msg.words ?? []).map((w) => ({
                word: w.text,
                confidence: w.confidence ?? 1,
              }));
              const avgConf =
                words.length > 0
                  ? words.reduce((a, b) => a + b.confidence, 0) / words.length
                  : (msg.end_of_turn_confidence ?? 1);

              if (isFinal) {
                allWordCountRef.current += text.split(" ").length;
                allConfidencesRef.current.push(avgConf);
                const globalAvg =
                  allConfidencesRef.current.reduce((a, b) => a + b, 0) /
                  allConfidencesRef.current.length;
                setChunks((prev) => [
                  ...prev,
                  { id: ++chunkId, text, words, isFinal: true, isSpeechFinal: true, avgConfidence: avgConf, timestamp: now() },
                ]);
                setInterimText("");
                setStats((s) => ({
                  ...s,
                  wordsCaptured: allWordCountRef.current,
                  avgConfidence: Math.round(globalAvg * 100),
                  speechFinalCount: s.speechFinalCount + 1,
                }));
                addLog("speech_final", `[END-OF-TURN] "${text.slice(0, 60)}" (${Math.round(avgConf * 100)}%)`);
              } else {
                setInterimText(text);
              }
            } else if (msg.type === "Termination") {
              addLog("info", "AssemblyAI session terminated");
            } else if (msg.type === "error" || msg.type === "Error") {
              addLog("error", `AssemblyAI error: ${JSON.stringify(msg)}`);
              setStatus("error");
              setStatusMsg("AssemblyAI error — see event log");
            }
          } catch { /* ignore parse errors */ }
        };
      });
    },
    [addLog]
  );

  // ── Start Web Speech API ──────────────────────────────────────────────────
  const startWebSpeech = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRec = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      setStatus("error");
      setStatusMsg("Web Speech API not supported in this browser. Try Chrome.");
      addLog("error", "Web Speech API not available");
      return;
    }

    // Still get mic stream for the level meter
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    });
    streamRef.current = micStream;
    setStream(micStream);

    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    webSpeechRef.current = rec;

    rec.onstart = () => {
      setStatus("ready");
      setStatusMsg("Web Speech API listening…");
      addLog("open", "Web Speech API started");
    };

    rec.onresult = (event: Event & { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; [i: number]: { transcript: string; confidence: number } } } }) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        const conf = result[0].confidence ?? 1;
        if (result.isFinal) {
          allWordCountRef.current += text.split(" ").length;
          allConfidencesRef.current.push(conf);
          const avgConf =
            allConfidencesRef.current.reduce((a, b) => a + b, 0) /
            allConfidencesRef.current.length;
          setChunks((prev) => [
            ...prev,
            {
              id: ++chunkId,
              text,
              words: text.split(" ").map((w: string) => ({ word: w, confidence: conf })),
              isFinal: true,
              isSpeechFinal: true,
              avgConfidence: conf,
              timestamp: now(),
            },
          ]);
          setInterimText("");
          setStats((s) => ({
            ...s,
            wordsCaptured: allWordCountRef.current,
            avgConfidence: Math.round(avgConf * 100),
            speechFinalCount: s.speechFinalCount + 1,
          }));
          addLog("speech_final", `[FINAL] "${text}" (conf: ${Math.round(conf * 100)}%)`);
        } else {
          interim += text;
        }
      }
      setInterimText(interim);
    };

    rec.onerror = (e: Event) => {
      const err = (e as Event & { error: string }).error;
      addLog("error", `Web Speech error: ${err}`);
      setStatus("error");
      setStatusMsg(`Web Speech error: ${err}`);
    };

    rec.start();
  }, [addLog]);

  // ── Start Deepgram ────────────────────────────────────────────────────────
  const startDeepgram = useCallback(
    async (cfg: STTConfig) => {
      setStatus("connecting");
      setStatusMsg("Fetching Deepgram token…");
      addLog("info", `Starting with config: ${cfg.label}`);

      const tokenRes = await fetch("/api/deepgram/test-token");
      if (!tokenRes.ok) {
        setStatus("error");
        setStatusMsg("Failed to get Deepgram token — are you signed in?");
        addLog("error", "Token fetch failed");
        setRunning(false);
        return;
      }
      const { key } = await tokenRes.json();

      setStatusMsg("Requesting microphone…");
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
      streamRef.current = micStream;
      setStream(micStream);

      addLog("info", "Mic granted — connecting to Deepgram…");
      setStatusMsg("Connecting to Deepgram…");

      const deepgram = createClient(key);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = {
        model: cfg.model,
        language: cfg.language,
        smart_format: true,
        interim_results: true,
        vad_events: true,
      };
      if (cfg.endpointing && cfg.endpointing > 0) opts.endpointing = cfg.endpointing;
      if (cfg.utterance_end_ms) opts.utterance_end_ms = cfg.utterance_end_ms;

      const connection = deepgram.listen.live(opts);
      connectionRef.current = connection;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Deepgram connect timeout")), 8000);

        connection.on(LiveTranscriptionEvents.Open, () => {
          clearTimeout(timeout);
          setStatus("ready");
          setStatusMsg(`${cfg.label} — listening`);
          addLog("open", `Deepgram WebSocket open (${cfg.model})`);

          // Detect audio format
          const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : "default";
          setAudioFormat(mimeType);
          addLog("info", `Audio format: ${mimeType}`);

          const recorder = new MediaRecorder(
            micStream,
            mimeType !== "default" ? { mimeType } : {}
          );
          recorderRef.current = recorder;

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0 && connection.getReadyState() === 1) {
              connection.send(e.data);
              chunksSentRef.current++;
              setStats((s) => ({ ...s, chunksSent: chunksSentRef.current }));
            }
          };

          recorder.start(250);
          addLog("info", "MediaRecorder started (250ms chunks)");
          resolve();
        });

        connection.on(LiveTranscriptionEvents.Transcript, (data) => {
          const alt = data.channel?.alternatives?.[0];
          if (!alt?.transcript) return;

          const isFinal = data.is_final ?? false;
          const isSpeechFinal = data.speech_final ?? false;
          const words: Word[] = (alt.words ?? []).map(
            (w: { word: string; confidence: number }) => ({
              word: w.word,
              confidence: w.confidence ?? 1,
            })
          );
          const avgConf =
            words.length > 0
              ? words.reduce((a, b) => a + b.confidence, 0) / words.length
              : 1;

          if (isFinal) {
            allWordCountRef.current += alt.transcript.split(" ").length;
            allConfidencesRef.current.push(avgConf);
            const globalAvg =
              allConfidencesRef.current.reduce((a, b) => a + b, 0) /
              allConfidencesRef.current.length;

            setChunks((prev) => [
              ...prev,
              {
                id: ++chunkId,
                text: alt.transcript,
                words,
                isFinal: true,
                isSpeechFinal,
                avgConfidence: avgConf,
                timestamp: now(),
              },
            ]);
            setInterimText("");

            if (isSpeechFinal) {
              setStats((s) => ({
                ...s,
                wordsCaptured: allWordCountRef.current,
                avgConfidence: Math.round(globalAvg * 100),
                speechFinalCount: s.speechFinalCount + 1,
              }));
              addLog(
                "speech_final",
                `speech_final ✓ "${alt.transcript.slice(0, 60)}" (conf: ${Math.round(avgConf * 100)}%)`
              );
            } else {
              setStats((s) => ({
                ...s,
                wordsCaptured: allWordCountRef.current,
                avgConfidence: Math.round(globalAvg * 100),
              }));
              addLog("transcript", `[final] "${alt.transcript.slice(0, 60)}"`);
            }
          } else {
            setInterimText(alt.transcript);
          }
        });

        connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
          setStats((s) => ({ ...s, utteranceEndCount: s.utteranceEndCount + 1 }));
          addLog("utterance_end", "UtteranceEnd received");
        });

        connection.on(LiveTranscriptionEvents.Error, (err) => {
          clearTimeout(timeout);
          addLog("error", `Deepgram error: ${JSON.stringify(err)}`);
          setStatus("error");
          setStatusMsg("Deepgram error — see event log");
          reject(new Error("Deepgram error"));
        });

        connection.on(LiveTranscriptionEvents.Close, () => {
          addLog("close", "Deepgram WebSocket closed");
        });
      });
    },
    [addLog]
  );

  // ── Start (dispatch to vendor) ────────────────────────────────────────────
  const start = useCallback(async () => {
    // Reset stats
    chunksSentRef.current = 0;
    allConfidencesRef.current = [];
    allWordCountRef.current = 0;
    setChunks([]);
    setInterimText("");
    setEventLog([]);
    setStats({ wordsCaptured: 0, avgConfidence: 0, speechFinalCount: 0, utteranceEndCount: 0, chunksSent: 0 });
    setRunning(true);

    try {
      if (config.vendor === "webspeech") {
        await startWebSpeech();
      } else if (config.vendor === "assemblyai") {
        await startAssemblyAI(config);
      } else {
        await startDeepgram(config);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus("error");
      setStatusMsg(msg);
      addLog("error", msg);
      setRunning(false);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
  }, [config, startDeepgram, startWebSpeech, startAssemblyAI, addLog]);

  // Cleanup on unmount
  useEffect(() => () => { stop(); }, [stop]);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const qualityColor =
    stats.avgConfidence >= 88
      ? "text-emerald-600"
      : stats.avgConfidence >= 70
      ? "text-yellow-600"
      : stats.avgConfidence >= 50
      ? "text-orange-500"
      : "text-red-600";

  const qualityLabel =
    stats.avgConfidence >= 88
      ? "Excellent"
      : stats.avgConfidence >= 70
      ? "Good"
      : stats.avgConfidence >= 50
      ? "Fair"
      : stats.avgConfidence > 0
      ? "Poor"
      : "—";

  const LOG_COLORS: Record<EventLogEntry["type"], string> = {
    open: "text-emerald-600",
    transcript: "text-gray-500",
    speech_final: "text-blue-600 font-semibold",
    utterance_end: "text-purple-600",
    close: "text-gray-500",
    error: "text-red-600 font-semibold",
    info: "text-gray-500",
  };

  // Consolidate visible transcript: all final chunks + current interim
  const finalText = chunks
    .filter((c) => c.isFinal)
    .map((c) => c.text)
    .join(" ");

  return (
    <div className="p-7">
      <div>
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Voice Capture Lab</h1>
          <p className="mt-1 text-sm text-gray-500">
            Test and compare STT accuracy, confidence scores, and end-of-speech detection across different configs.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* ── Left: Config + Controls ──────────────────────────────────── */}
          <div className="space-y-4 lg:col-span-1">
            {/* Config picker */}
            <div className="rounded-xl border border-[#e2e4ec] bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-gray-600 uppercase tracking-wide">
                Configuration
              </h2>
              <div className="space-y-2">
                {CONFIGS.map((c) => (
                  <label
                    key={c.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                      configId === c.id
                        ? "border-blue-500 bg-blue-50"
                        : "border-[#e2e4ec] hover:border-gray-300 hover:bg-gray-50"
                    } ${running ? "cursor-not-allowed opacity-50" : ""}`}
                  >
                    <input
                      type="radio"
                      name="config"
                      value={c.id}
                      checked={configId === c.id}
                      onChange={() => !running && setConfigId(c.id)}
                      className="mt-0.5 h-4 w-4 text-blue-600"
                      disabled={running}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 leading-tight">{c.label}</p>
                      <p className="mt-0.5 text-xs text-gray-500 leading-tight">{c.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Mic pre-warm status */}
            {micError ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
                ⚠ Mic access denied: {micError}. Please allow microphone access and refresh.
              </div>
            ) : !micReady ? (
              <div className="flex items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                Requesting mic access…
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Mic ready — click Start Listening to begin
              </div>
            )}

            {/* Start / Stop */}
            <div className="flex gap-3">
              {!running ? (
                <button
                  onClick={start}
                  disabled={!micReady}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 py-3 text-sm font-semibold text-white hover:bg-violet-700 active:bg-violet-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Mic className="h-4 w-4" />
                  Start Listening
                </button>
              ) : (
                <button
                  onClick={stop}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white hover:bg-red-700 active:bg-red-800 transition-colors"
                >
                  <MicOff className="h-4 w-4" />
                  Stop
                </button>
              )}
              <button
                onClick={() => {
                  stop();
                  setChunks([]);
                  setEventLog([]);
                  setStats({ wordsCaptured: 0, avgConfidence: 0, speechFinalCount: 0, utteranceEndCount: 0, chunksSent: 0 });
                  setInterimText("");
                  setAudioFormat("");
                }}
                className="rounded-xl border border-[#e2e4ec] bg-white px-4 py-3 text-gray-500 hover:bg-gray-50"
                title="Reset"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>

            {/* Status */}
            <div
              className={`rounded-xl border px-4 py-3 text-sm ${
                status === "ready"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : status === "connecting"
                  ? "border-blue-200 bg-blue-50 text-blue-700"
                  : status === "error"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-[#e2e4ec] bg-white text-gray-500"
              }`}
            >
              <div className="flex items-center gap-2">
                {status === "ready" && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                {status === "error" && <AlertCircle className="h-4 w-4 shrink-0" />}
                {status === "connecting" && (
                  <div className="h-4 w-4 shrink-0 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                )}
                {status === "idle" && <Info className="h-4 w-4 shrink-0" />}
                <span className="font-medium">{statusMsg || (status === "idle" ? "Select a config and start" : status)}</span>
              </div>
            </div>

            {/* Audio level meter */}
            {running && (
              <div className="rounded-xl border border-[#e2e4ec] bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Mic Level</p>
                  {level > 0.05 ? (
                    <span className="text-xs text-emerald-600 font-medium">● Live</span>
                  ) : (
                    <span className="text-xs text-gray-500">silence</span>
                  )}
                </div>
                <div className="h-4 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full transition-all duration-75 ${
                      level > 0.7
                        ? "bg-red-500"
                        : level > 0.4
                        ? "bg-amber-400"
                        : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.round(level * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-right text-xs text-gray-500">{Math.round(level * 100)}%</p>
              </div>
            )}

            {/* Stats */}
            <div className="rounded-xl border border-[#e2e4ec] bg-white p-4">
              <h2 className="mb-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Stats</h2>
              <div className="space-y-2">
                <StatRow label="Accuracy / Quality" value={
                  <span className={`font-bold ${qualityColor}`}>
                    {stats.avgConfidence > 0 ? `${stats.avgConfidence}% — ${qualityLabel}` : "—"}
                  </span>
                } />
                <StatRow label="Words captured" value={stats.wordsCaptured || "—"} />
                <StatRow
                  label="speech_final events"
                  value={
                    <span className="font-semibold text-blue-600">{stats.speechFinalCount}</span>
                  }
                />
                <StatRow
                  label="UtteranceEnd events"
                  value={
                    <span className="font-semibold text-purple-600">{stats.utteranceEndCount}</span>
                  }
                />
                <StatRow label="Audio chunks sent" value={stats.chunksSent || "—"} />
                {audioFormat && (
                  <StatRow label="Audio format" value={<code className="text-xs">{audioFormat}</code>} />
                )}
              </div>
            </div>

            {/* Quality bar */}
            {stats.avgConfidence > 0 && (
              <div className="rounded-xl border border-[#e2e4ec] bg-white p-4">
                <div className="mb-2 flex justify-between text-xs">
                  <span className="font-medium text-gray-500 uppercase tracking-wide">Overall Quality</span>
                  <span className={`font-bold ${qualityColor}`}>{stats.avgConfidence}%</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      stats.avgConfidence >= 88
                        ? "bg-emerald-500"
                        : stats.avgConfidence >= 70
                        ? "bg-yellow-400"
                        : stats.avgConfidence >= 50
                        ? "bg-orange-400"
                        : "bg-red-500"
                    }`}
                    style={{ width: `${stats.avgConfidence}%` }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-xs text-gray-400">
                  <span>0</span>
                  <span className="text-orange-400">50 Fair</span>
                  <span className="text-yellow-500">70 Good</span>
                  <span className="text-emerald-500">90 Excellent</span>
                </div>
              </div>
            )}
          </div>

          {/* ── Right: Transcript + Events ───────────────────────────────── */}
          <div className="space-y-4 lg:col-span-2">
            {/* Live Transcript */}
            <div className="rounded-xl border border-[#e2e4ec] bg-white">
              <div className="flex items-center justify-between border-b border-[#e2e4ec] px-5 py-3">
                <h2 className="text-sm font-semibold text-gray-600">Live Transcript</h2>
                <div className="flex items-center gap-3 text-xs">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    ≥92% excellent
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-yellow-400" />
                    ≥80% good
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-orange-400" />
                    ≥65% fair
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    &lt;65% poor
                  </span>
                </div>
              </div>

              <div className="min-h-[180px] p-5">
                {chunks.length === 0 && !interimText && (
                  <p className="text-sm text-gray-400 italic">
                    {running ? "Speak into your microphone…" : "Start listening to see transcript here"}
                  </p>
                )}

                {/* Word-level confidence display */}
                <div className="flex flex-wrap gap-1 mb-3">
                  {chunks.map((chunk) =>
                    chunk.words.length > 0
                      ? chunk.words.map((w, i) => (
                          <span
                            key={`${chunk.id}-${i}`}
                            title={`${Math.round(w.confidence * 100)}%`}
                            className={`rounded px-1 py-0.5 text-sm ${confidenceBg(w.confidence)} ${confidenceColor(w.confidence)}`}
                          >
                            {w.word}
                          </span>
                        ))
                      : (
                          <span
                            key={chunk.id}
                            className={`rounded px-1 py-0.5 text-sm ${confidenceBg(chunk.avgConfidence)} ${confidenceColor(chunk.avgConfidence)}`}
                          >
                            {chunk.text}
                          </span>
                        )
                  )}
                  {interimText && (
                    <span className="text-sm text-gray-500 italic">{interimText}</span>
                  )}
                </div>

                {/* Plain text view */}
                {(finalText || interimText) && (
                  <div className="mt-3 border-t border-[#e2e4ec] pt-3">
                    <p className="text-xs text-gray-500 mb-1">Plain text</p>
                    <p className="text-sm text-gray-600 leading-relaxed">
                      {finalText}
                      {interimText && (
                        <span className="text-gray-500 italic"> {interimText}</span>
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Per-utterance breakdown */}
            {chunks.filter((c) => c.isSpeechFinal).length > 0 && (
              <div className="rounded-xl border border-[#e2e4ec] bg-white">
                <div className="border-b border-[#e2e4ec] px-5 py-3">
                  <h2 className="text-sm font-semibold text-gray-600">
                    Utterance Breakdown{" "}
                    <span className="ml-1 text-xs font-normal text-gray-500">(speech_final boundaries)</span>
                  </h2>
                </div>
                <div className="divide-y divide-gray-100 max-h-[200px] overflow-y-auto">
                  {chunks
                    .filter((c) => c.isSpeechFinal)
                    .slice(-10)
                    .reverse()
                    .map((c) => (
                      <div key={c.id} className="flex items-start gap-3 px-5 py-3">
                        <span className="shrink-0 text-xs text-gray-400 mt-0.5 font-mono">{c.timestamp}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-900">{c.text}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <span
                            className={`text-xs font-semibold ${confidenceColor(c.avgConfidence)}`}
                          >
                            {Math.round(c.avgConfidence * 100)}%
                          </span>
                          <div className="mt-1 h-1 w-16 rounded-full bg-gray-100">
                            <div
                              className={`h-full rounded-full ${
                                c.avgConfidence >= 0.92
                                  ? "bg-emerald-500"
                                  : c.avgConfidence >= 0.8
                                  ? "bg-yellow-400"
                                  : c.avgConfidence >= 0.65
                                  ? "bg-orange-400"
                                  : "bg-red-500"
                              }`}
                              style={{ width: `${Math.round(c.avgConfidence * 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Event Log */}
            <div className="rounded-xl border border-[#e2e4ec] bg-white">
              <div className="flex items-center justify-between border-b border-[#e2e4ec] px-5 py-3">
                <h2 className="text-sm font-semibold text-gray-600">
                  Event Log{" "}
                  <span className="ml-1 text-xs font-normal text-gray-500">
                    (real-time Deepgram events)
                  </span>
                </h2>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span className="text-blue-600 font-semibold">speech_final</span>
                  <span className="text-purple-600">utterance_end</span>
                  <span className="text-red-600">error</span>
                </div>
              </div>
              <div className="max-h-[240px] overflow-y-auto p-4 font-mono text-xs">
                {eventLog.length === 0 && (
                  <p className="text-gray-400">Events will appear here when listening…</p>
                )}
                {eventLog.map((e) => (
                  <div key={e.id} className="flex gap-2 mb-1">
                    <span className="shrink-0 text-gray-400">{e.time}</span>
                    <span className={`flex-1 ${LOG_COLORS[e.type]}`}>
                      {e.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Tips */}
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
              <div className="flex gap-2">
                <Zap className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
                <div className="space-y-1">
                  <p className="font-semibold">How to interpret results:</p>
                  <p>• Word confidence ≥ 90% = well-captured. &lt;70% = poor (background noise, accent, low mic volume, wrong language).</p>
                  <p>• <span className="font-semibold text-blue-700">speech_final</span> should fire when you pause after speaking — this is the AI response trigger.</p>
                  <p>• If speech_final never fires, check: is `endpointing` set? Is the mic capturing audio (level meter should move)?</p>
                  <p>• Hover any coloured word to see its exact confidence percentage.</p>
                  <p>• Use <strong>nova-3</strong> for best accuracy. Try <strong>nova-2-conversationalai</strong> if accuracy is still poor — it&apos;s tuned for conversational speech.</p>
                  <p>• Compare with <strong>Web Speech API</strong> to determine if the issue is Deepgram or your microphone/environment.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-xs text-gray-900">{value}</span>
    </div>
  );
}
