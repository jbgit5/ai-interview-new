"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowRight,
  Mic,
  MicOff,
  Volume2,
  Wifi,
  AlertTriangle,
} from "lucide-react";
import { useSpeechCapture, type SpeechEndMeta } from "@/hooks/useSpeechCapture";
import {
  getMediaDevicesBlockedMessage,
  isMediaDevicesAvailable,
  requestUserMedia,
} from "@/lib/mediaDevices";

// Sentence shown to candidate; we score word-match against STT output
const REFERENCE_SENTENCE =
  "My name is clearly coming through and my microphone is working well";
const REFERENCE_WORDS = REFERENCE_SENTENCE.toLowerCase()
  .replace(/[^a-z\s]/g, "")
  .split(" ");

function wordMatchScore(sttText: string): number {
  if (!sttText.trim()) return 0;
  const heard = sttText.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/);
  let matched = 0;
  for (const w of REFERENCE_WORDS) {
    if (heard.includes(w)) matched++;
  }
  return Math.round((matched / REFERENCE_WORDS.length) * 100);
}

type CheckStatus = "pending" | "checking" | "pass" | "fail";
interface Check {
  label: string;
  status: CheckStatus;
  detail: string | null;
}

type MicTestState = "idle" | "preparing" | "ready" | "listening" | "done";
type MicQuality = "excellent" | "good" | "fair" | "poor" | null;

export default function SystemCheckPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [checks, setChecks] = useState<Check[]>([
    { label: "Camera", status: "pending", detail: null },
    { label: "Microphone", status: "pending", detail: null },
    { label: "Internet", status: "pending", detail: null },
  ]);
  const [allPassed, setAllPassed] = useState(false);

  const [micTestState, setMicTestState] = useState<MicTestState>("idle");
  const [micQuality, setMicQuality] = useState<MicQuality>(null);
  const [micScore, setMicScore] = useState(0);
  const [micTranscript, setMicTranscript] = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [micError, setMicError] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);

  // Stream/AudioContext refs for level meter (separate from STT hook)
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const meterStreamRef = useRef<MediaStream | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);

  const transcriptRef = useRef("");
  /** Hard cap so the mic test cannot run forever */
  const maxMicTestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** After STT signals end-of-utterance, wait this long with no new audio/text before scoring (lets readers pause mid-sentence) */
  const speechIdleFinishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const MIC_TEST_IDLE_AFTER_SPEECH_MS = 3_500;
  const MIC_TEST_MAX_DURATION_MS = 15_000;

  function clearSpeechIdleFinishTimer() {
    if (speechIdleFinishTimerRef.current) {
      clearTimeout(speechIdleFinishTimerRef.current);
      speechIdleFinishTimerRef.current = null;
    }
  }

  function clearMaxMicTestTimer() {
    if (maxMicTestTimerRef.current) {
      clearTimeout(maxMicTestTimerRef.current);
      maxMicTestTimerRef.current = null;
    }
  }

  // ─── STT hook (Deepgram → Web Speech fallback) ────────────────────────────
  const onTranscript = useCallback((text: string, isFinal: boolean) => {
    // Any new hypothesis means the user may still be reading — cancel auto-finish countdown
    clearSpeechIdleFinishTimer();
    if (isFinal) {
      transcriptRef.current = (transcriptRef.current + " " + text).trim();
      setMicTranscript(transcriptRef.current);
      setLiveTranscript("");
    } else {
      setLiveTranscript(text);
    }
  }, []);

  const onSpeechEnd = useCallback((_avgConfidence: number, _meta: SpeechEndMeta) => {
    void _avgConfidence;
    void _meta;
    // Deepgram uses ~300ms endpointing in interview mode; here we use relaxed settings + a long idle window
    clearSpeechIdleFinishTimer();
    speechIdleFinishTimerRef.current = setTimeout(() => {
      speechIdleFinishTimerRef.current = null;
      finishTest(transcriptRef.current);
    }, MIC_TEST_IDLE_AFTER_SPEECH_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onError = useCallback((err: Error) => {
    setMicError(err.message);
    setMicTestState("idle");
    cleanupMeter();
  }, []);

  const capture = useSpeechCapture({
    sessionToken: params.token,
    onTranscript,
    onSpeechEnd,
    onError,
    addLog: undefined,
    // Longer pauses while reading the reference sentence aloud (default 300ms was ending the utterance too early)
    liveEndpointingMs: 1_200,
    liveUtteranceEndMs: 4_500,
    webSpeechPostFinalMs: 2_800,
  });

  function updateCheck(index: number, update: Partial<Check>) {
    setChecks((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...update };
      return next;
    });
  }

  useEffect(() => {
    runChecks();
    return () => {
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      cleanupMeter();
      capture.stop();
      clearMaxMicTestTimer();
      clearSpeechIdleFinishTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const done = checks.every((c) => c.status === "pass" || c.status === "fail");
    const passed = checks.every((c) => c.status === "pass");
    if (done) setAllPassed(passed);
  }, [checks]);

  async function runChecks() {
    updateCheck(0, { status: "checking" });
    updateCheck(1, { status: "checking" });

    if (!isMediaDevicesAvailable()) {
      const msg = getMediaDevicesBlockedMessage();
      updateCheck(0, { status: "fail", detail: msg });
      updateCheck(1, { status: "fail", detail: msg });
      updateCheck(2, { status: "checking" });
      try {
        const start = Date.now();
        await fetch("/", { method: "HEAD", cache: "no-store" });
        const ms = Date.now() - start;
        updateCheck(2, { status: "pass", detail: `${ms}ms response time` });
      } catch {
        updateCheck(2, { status: "fail", detail: "Could not reach the server" });
      }
      return;
    }

    try {
      const stream = await requestUserMedia({
        video: true,
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
      cameraStreamRef.current = stream;

      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0) {
        if (videoRef.current) videoRef.current.srcObject = stream;
        updateCheck(0, { status: "pass", detail: videoTracks[0].label || "Camera detected" });
      } else {
        updateCheck(0, { status: "fail", detail: "No camera detected" });
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        updateCheck(1, { status: "pass", detail: audioTracks[0].label || "Microphone detected" });
      } else {
        updateCheck(1, { status: "fail", detail: "No microphone detected" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Permission denied";
      updateCheck(0, { status: "fail", detail: msg });
      updateCheck(1, { status: "fail", detail: msg });
    }

    updateCheck(2, { status: "checking" });
    try {
      const start = Date.now();
      await fetch("/", { method: "HEAD", cache: "no-store" });
      const ms = Date.now() - start;
      updateCheck(2, { status: "pass", detail: `${ms}ms response time` });
    } catch {
      updateCheck(2, { status: "fail", detail: "Could not reach the server" });
    }
  }

  // ─── Audio level meter (independent from STT capture) ─────────────────────
  async function startMeter() {
    try {
      const stream = await requestUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true, sampleRate: 16000 },
      });
      meterStreamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      meterCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setAudioLevel(Math.min(1, avg / 70));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      /* meter is non-critical */
    }
  }

  function cleanupMeter() {
    cancelAnimationFrame(rafRef.current);
    meterStreamRef.current?.getTracks().forEach((t) => t.stop());
    meterStreamRef.current = null;
    meterCtxRef.current?.close().catch(() => {});
    meterCtxRef.current = null;
  }

  // ─── Mic test sequence ────────────────────────────────────────────────────
  async function startMicTest() {
    setMicTestState("preparing");
    setMicTranscript("");
    setLiveTranscript("");
    setMicError("");
    setMicQuality(null);
    transcriptRef.current = "";
    clearMaxMicTestTimer();
    clearSpeechIdleFinishTimer();

    void startMeter();

    try {
      // Start STT — resolves once Deepgram is fully ready
      await capture.start();
      // Activate immediately (no TTS gating in mic test)
      capture.activate();
      setMicTestState("listening");

      // Safety timeout: always stop after max duration (separate from post-speech idle debounce)
      maxMicTestTimerRef.current = setTimeout(() => {
        maxMicTestTimerRef.current = null;
        finishTest(transcriptRef.current);
      }, MIC_TEST_MAX_DURATION_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMicError(`Could not start: ${msg}`);
      setMicTestState("idle");
      cleanupMeter();
    }
  }

  function finishTest(text: string) {
    clearMaxMicTestTimer();
    clearSpeechIdleFinishTimer();
    capture.stop();
    cleanupMeter();

    const score = wordMatchScore(text);
    setMicScore(score);
    setMicTranscript(text);
    setLiveTranscript("");
    setMicTestState("done");

    if (score >= 70) setMicQuality("excellent");
    else if (score >= 50) setMicQuality("good");
    else if (score >= 30) setMicQuality("fair");
    else setMicQuality("poor");
  }

  function stopMicTest() {
    finishTest(transcriptRef.current);
  }

  const qualityConfig = {
    excellent: { label: "Excellent", color: "text-emerald-600", bg: "bg-emerald-50 border-emerald-200", bar: "bg-emerald-500", tip: null },
    good: { label: "Good", color: "text-blue-600", bg: "bg-blue-50 border-blue-200", bar: "bg-blue-500", tip: "Audio is clear enough for the interview. Make sure you're in a quiet space." },
    fair: { label: "Fair — needs improvement", color: "text-amber-600", bg: "bg-amber-50 border-amber-200", bar: "bg-amber-400", tip: "We're missing some words. Try: move closer to mic, reduce background noise, or use headphones." },
    poor: { label: "Poor — interview will be affected", color: "text-red-600", bg: "bg-red-50 border-red-200", bar: "bg-red-500", tip: "Significant audio issues detected. Recommendations: use a headset/earphones, close windows, move to a quieter room, check mic settings in System Preferences." },
  };

  const canStartInterview =
    allPassed && (micQuality === "excellent" || micQuality === "good" || micQuality === "fair");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white text-xl font-bold">
            AI
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="mb-2 text-xl font-semibold text-gray-900">System Check</h1>
          <p className="mb-6 text-sm text-gray-500">
            Making sure everything is ready before your interview.
          </p>

          {/* Camera preview */}
          <div className="mb-6 overflow-hidden rounded-lg bg-black aspect-video">
            <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
          </div>

          {/* Basic checks */}
          <div className="mb-6 space-y-3">
            {checks.map((check, i) => {
              const Icon =
                check.status === "pass"
                  ? CheckCircle2
                  : check.status === "fail"
                  ? XCircle
                  : check.status === "checking"
                  ? Loader2
                  : check.label === "Camera"
                  ? Volume2
                  : check.label === "Microphone"
                  ? Mic
                  : Wifi;
              return (
                <div key={i} className="flex items-center gap-3">
                  <Icon
                    className={`h-5 w-5 shrink-0 ${
                      check.status === "pass"
                        ? "text-emerald-500"
                        : check.status === "fail"
                        ? "text-red-500"
                        : check.status === "checking"
                        ? "text-blue-500 animate-spin"
                        : "text-gray-300"
                    }`}
                  />
                  <span className="text-sm font-medium text-gray-700">{check.label}</span>
                  <span className="ml-auto text-xs text-gray-400">{check.detail}</span>
                </div>
              );
            })}
          </div>

          {/* ── Mic quality test ─────────────────────────────────────────── */}
          <div className="border-t border-gray-100 pt-6">
            <h2 className="mb-1 text-sm font-semibold text-gray-800">Microphone Quality Test</h2>
            <p className="mb-4 text-xs text-gray-500">
              Read the sentence below aloud so we can verify your audio quality before the interview starts.
            </p>

            <div className="mb-4 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3">
              <p className="text-xs text-blue-500 mb-1 font-medium uppercase tracking-wide">Read this aloud:</p>
              <p className="text-sm font-medium text-blue-900 leading-relaxed">
                &ldquo;{REFERENCE_SENTENCE}&rdquo;
              </p>
            </div>

            {/* Preparing state */}
            {micTestState === "preparing" && (
              <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 flex items-center gap-3">
                <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
                <p className="text-sm text-blue-900">Connecting to speech service…</p>
              </div>
            )}

            {/* Audio level meter (during listening) */}
            {micTestState === "listening" && (
              <>
                <div className="mb-2 flex items-center justify-between rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    <span className="text-xs font-medium text-emerald-700">Ready — speak now</span>
                  </div>
                  <span className="text-xs text-emerald-600">
                    {audioLevel > 0.05 ? "● Hearing you" : "silence"}
                  </span>
                </div>

                <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full transition-all duration-75 ${
                      audioLevel > 0.7 ? "bg-red-500" : audioLevel > 0.4 ? "bg-amber-400" : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.round(audioLevel * 100)}%` }}
                  />
                </div>

                <div className="mb-4 min-h-[52px] rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-400 mb-1">Hearing:</p>
                  <p className="text-sm text-gray-700">
                    {micTranscript}
                    {liveTranscript && <span className="text-gray-400 italic"> {liveTranscript}</span>}
                    {!micTranscript && !liveTranscript && (
                      <span className="text-gray-300 italic">Speak the sentence above…</span>
                    )}
                  </p>
                </div>
              </>
            )}

            {/* Result */}
            {micTestState === "done" && micQuality && (
              <div className={`mb-4 rounded-lg border px-4 py-3 ${qualityConfig[micQuality].bg}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-sm font-semibold ${qualityConfig[micQuality].color}`}>
                    {qualityConfig[micQuality].label}
                  </span>
                  <span className={`text-sm font-bold ${qualityConfig[micQuality].color}`}>
                    {micScore}% words matched
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-white/60 mb-2">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${qualityConfig[micQuality].bar}`}
                    style={{ width: `${micScore}%` }}
                  />
                </div>
                {micTranscript && (
                  <p className="text-xs text-gray-500 mb-1">
                    <span className="font-medium">We heard:</span> &ldquo;{micTranscript}&rdquo;
                  </p>
                )}
                {qualityConfig[micQuality].tip && (
                  <div className="mt-2 flex gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
                    <p className="text-xs text-gray-600">{qualityConfig[micQuality].tip}</p>
                  </div>
                )}
                {micQuality === "poor" && (
                  <button
                    onClick={() => setMicTestState("idle")}
                    className="mt-3 text-xs text-blue-600 underline"
                  >
                    Try again after fixing your microphone
                  </button>
                )}
              </div>
            )}

            {micError && <p className="mb-4 text-xs text-red-600">{micError}</p>}

            {/* Controls */}
            {micTestState === "idle" && (
              <button
                onClick={startMicTest}
                disabled={
                  checks.some((c) => c.status === "checking") ||
                  checks.some((c) => c.status === "pending")
                }
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              >
                <Mic className="h-4 w-4" />
                Start Microphone Test
              </button>
            )}
            {micTestState === "preparing" && (
              <button
                disabled
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-400 py-2.5 text-sm font-medium text-white"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting…
              </button>
            )}
            {micTestState === "listening" && (
              <button
                onClick={stopMicTest}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-700 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
              >
                <MicOff className="h-4 w-4" />
                Stop Recording
              </button>
            )}
            {micTestState === "done" && micQuality !== "poor" && (
              <button
                onClick={() => setMicTestState("idle")}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Test Again
              </button>
            )}
          </div>

          {/* Continue button */}
          <div className="mt-6 border-t border-gray-100 pt-5">
            {!canStartInterview && micQuality === null && (
              <p className="mb-3 text-center text-xs text-gray-400">
                Complete the microphone test above before starting your interview.
              </p>
            )}
            <button
              onClick={() => router.push(`/interview/${params.token}/room`)}
              disabled={!canStartInterview}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Start Interview
              <ArrowRight className="h-4 w-4" />
            </button>
            {micQuality === "poor" && (
              <p className="mt-2 text-center text-xs text-red-600">
                Please fix your microphone first — poor audio quality will affect your interview results.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
