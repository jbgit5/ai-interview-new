"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Wifi,
  WifiOff,
  Circle,
  Loader2,
  PlayCircle,
  Shield,
  AlertTriangle,
  X,
  Captions,
  CaptionsOff,
  PhoneOff,
  ShieldCheck,
  Check,
} from "lucide-react";
import { useLiveKit } from "@/hooks/useLiveKit";
import { useSessionTelemetry } from "@/hooks/useSessionTelemetry";
import { useVideoRecorder } from "@/hooks/useVideoRecorder";
import { useCameraHealth } from "@/hooks/useCameraHealth";
import { useInterview } from "@/hooks/useInterview";
import { useLiveInterview } from "@/hooks/useLiveInterview";
import { usePipelineInterview } from "@/hooks/usePipelineInterview";
import { describeLiveFallback } from "@/lib/live/fallbackReason";
import type {
  AIStatus,
  CandidateListeningPhase,
  ConversationTurnPhase,
  LogEntry,
} from "@/hooks/useInterview";
import { useProctor } from "@/hooks/useProctor";
import MayaAvatar from "@/components/interview/MayaAvatar";
import {
  normalizeInterviewerAvatarId,
  type InterviewerAvatarId,
} from "@/lib/interviewerAvatar";

type RoomPhase = "loading" | "connecting" | "ready" | "error";

async function readApiErrorBody(res: Response): Promise<string | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    const data = JSON.parse(text) as { error?: string; message?: string };
    return data.error ?? data.message ?? null;
  } catch {
    if (text.length > 200) return `${text.slice(0, 200)}…`;
    return text.trim() || null;
  }
}

export default function InterviewRoomPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<RoomPhase>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [livekitToken, setLivekitToken] = useState<string | null>(null);
  const [livekitUrl] = useState(process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "");
  const [micMuted, setMicMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  const [serverInterviewerAvatar, setServerInterviewerAvatar] =
    useState<InterviewerAvatarId | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number | null>(null);

  // ─── Observability (client batch → DB via /api/sessions/[token]/telemetry) ─
  const sessionTelemetry = useSessionTelemetry(params.token);

  const onLiveKitTelemetry = useCallback(
    (eventName: string, attrs: Record<string, unknown>) => {
      sessionTelemetry.enqueue({ event_name: eventName, attrs });
    },
    [sessionTelemetry]
  );

  // ─── AI Interview engine ─────────────────────────────────────────────────
  // Three interchangeable engines with the same shape:
  //   pipeline — DEFAULT. Deepgram STT → our brain → Deepgram Aura voice, short measured waits,
  //              instant ack, late-speech merge (src/hooks/usePipelineInterview.ts).
  //   legacy   — the original engine (fixed 7.2 s silence window). `?engine=legacy`.
  //   live     — GPT-Live experiment. `?engine=live` AND the job/server allow it; falls back to
  //              the pipeline if it cannot start.
  // Proctoring + recording are engine-independent.
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const [liveEligible, setLiveEligible] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  const [engineChoice, setEngineChoice] = useState<"pipeline" | "legacy" | "live">("pipeline");
  // Why we're (not) on GPT-Live — surfaced in the debug header, because the live hook's own logs vanish
  // the moment the room falls back to another engine.
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [forcedLegacy, setForcedLegacy] = useState(false);
  // Recruiter's Settings → Debug mode (from /start). Off = clean Meet-style room for candidates.
  const [debugMode, setDebugMode] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);

  const legacyEngine = useInterview({ sessionToken: params.token, telemetry: sessionTelemetry });
  const legacyStartInterview = legacyEngine.startInterview;
  const pipelineEngine = usePipelineInterview({ sessionToken: params.token, telemetry: sessionTelemetry });
  const pipelineStartInterview = pipelineEngine.startInterview;
  const liveEngine = useLiveInterview({
    sessionToken: params.token,
    telemetry: sessionTelemetry,
    getMicTrack: () => micTrackRef.current,
    onFallback: (reason) => {
      setFallbackReason(reason);
      setLiveActive(false);
      setEngineChoice("pipeline");
      void pipelineStartInterview();
    },
  });

  const engine = liveActive ? liveEngine : engineChoice === "legacy" ? legacyEngine : pipelineEngine;
  const {
    state: interviewState,
    aiStatus,
    candidateListeningPhase,
    conversationTurnPhase,
    currentQuestion,
    transcript,
    turns,
    turnIndex,
    logs,
    endEarly,
  } = engine;
  const liveStartInterview = liveEngine.startInterview;
  const startInterview = useCallback(() => {
    // Start the voice engine FIRST (the standard engine must unlock audio synchronously inside this
    // click), then ask for fullscreen (also needs the click; skipped in debug mode). Best-effort: a
    // refusal never blocks the interview; leaving fullscreen later is recorded and a button appears.
    let started: Promise<void>;
    if (engineChoice === "live") {
      setLiveActive(true);
      started = liveStartInterview();
    } else if (engineChoice === "legacy") {
      started = legacyStartInterview();
    } else {
      started = pipelineStartInterview();
    }
    if (!debugMode && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
    return started;
  }, [debugMode, engineChoice, liveStartInterview, legacyStartInterview, pipelineStartInterview]);
  // "Done answering": ends the candidate's answer immediately (pipeline engine only). The silence rule is
  // just the fallback — silence alone can't tell "finished" from "thinking".
  const pipelineActive = engineChoice === "pipeline" && !liveActive;
  const finishAnswer = pipelineEngine.finishAnswer;
  const canFinishAnswer =
    pipelineActive && interviewState === "listening" && transcript.trim().length > 0;
  useEffect(() => {
    if (!pipelineActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.isContentEditable)) return;
      if (finishAnswer()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pipelineActive, finishAnswer]);

  // Lip-sync avatar ↔ Maya's voice: mute the raw voice only while the avatar is rendering it.
  // The avatar runs on the pipeline (default) and GPT-Live engines; the legacy engine has no voice track.
  const avatarEngine = liveActive ? liveEngine : pipelineEngine;
  const avatarAvailable = liveActive || engineChoice === "pipeline";
  const setLivePlaybackMuted = avatarEngine.setPlaybackMuted;
  const setAvatarSpeaking = avatarEngine.setAvatarSpeaking;
  const getAudioDebug = avatarEngine.getAudioDebug;
  const onAvatarTelemetry = useCallback(
    (eventName: string, attrs?: Record<string, unknown>) => {
      sessionTelemetry.enqueue({ event_name: eventName, attrs });
    },
    [sessionTelemetry]
  );
  const legacyReset = legacyEngine.reset;
  const liveReset = liveEngine.reset;
  const pipelineReset = pipelineEngine.reset;
  const resetInterview = useCallback(() => {
    legacyReset();
    liveReset();
    pipelineReset();
  }, [legacyReset, liveReset, pipelineReset]);

  // ─── Proctoring ──────────────────────────────────────────────────────────
  const { integrityScore, violations, activeWarning, dismissWarning, focusStatus, aiStatus: proctorAiStatus } = useProctor({
    sessionToken: params.token,
    videoRef,
    enabled: interviewState !== "idle" && interviewState !== "completed",
    // Download the AI models while the candidate is on the "Ready?" screen, not mid-interview.
    aiPreload: phase === "ready",
    onTelemetry: onAvatarTelemetry,
  });

  // Fullscreen state (proctoring): a "Return to full screen" button appears if the candidate leaves it.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ─── Cleanup on unmount (back button, navigation, tab close) ────────────
  useEffect(() => {
    return () => {
      resetInterview();
    };
  // resetInterview is stable (useCallback with no deps that change)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Step 1: Start session + get LiveKit token ───────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Start or rejoin the session
        const startRes = await fetch(`/api/sessions/${params.token}/start`, {
          method: "POST",
        });

        if (!startRes.ok) {
          const status = startRes.status;
          // 409 = already completed, 410 = expired → redirect to landing page
          if (status === 409 || status === 410) {
            router.replace(`/interview/${params.token}`);
            return;
          }
          const detail = await readApiErrorBody(startRes);
          setErrorMsg(
            detail ??
              (status === 404
                ? "Interview link not found or invalid."
                : `Could not start session (HTTP ${status}). Check the dev server terminal for errors.`)
          );
          setPhase("error");
          return;
        }

        const startData = await startRes.json();
        if (cancelled) return;
        setSessionId(startData.session_id);
        // `?engine=legacy` / `?engine=live` are per-link switches for A/B comparison and support.
        const engineParam = new URLSearchParams(window.location.search).get("engine");
        const forceLegacy = engineParam === "legacy";
        const liveOk = startData.live_voice_eligible === true && engineParam === "live";
        setLiveEligible(liveOk);
        setForcedLegacy(forceLegacy);
        setEngineChoice(forceLegacy ? "legacy" : liveOk ? "live" : "pipeline");
        setDebugMode(startData.debug_mode === true);
        if (typeof startData.interviewer_avatar_id === "string") {
          setServerInterviewerAvatar(
            normalizeInterviewerAvatarId(startData.interviewer_avatar_id)
          );
        }

        // Get LiveKit room token
        const tokenRes = await fetch("/api/livekit/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: startData.livekit_room,
            participant_name: `candidate-${startData.session_id}`,
            role: "candidate",
          }),
        });

        if (!tokenRes.ok) {
          const detail = await readApiErrorBody(tokenRes);
          setErrorMsg(
            detail ??
              "Could not join video room. For local dev set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and NEXT_PUBLIC_LIVEKIT_URL in `.env.local` (see `.env.example`)."
          );
          setPhase("error");
          return;
        }

        const tokenData = await tokenRes.json();
        if (!tokenData.token) {
          setErrorMsg("LiveKit token response missing token.");
          setPhase("error");
          return;
        }
        if (cancelled) return;
        setLivekitToken(tokenData.token);
        setPhase("connecting");
      } catch (err: unknown) {
        if (!cancelled) {
          const hint =
            err instanceof Error ? err.message : "Unexpected error loading room.";
          setErrorMsg(
            `Unable to reach the app or parse the server response: ${hint} If the API returned an error page, check PostgreSQL / LiveKit env in the terminal.`
          );
          setPhase("error");
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
    // Important: Do not depend on `router` — identity churn re-runs init, gets 409 after
    // completion, and `router.replace` navigates to a second “Interview complete” screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- token only
  }, [params.token]);

  // ─── Step 2: LiveKit ─────────────────────────────────────────────────────
  const { connectionState, localVideoTrack, localAudioTrack, isConnected, isReconnecting, error: livekitError, disconnect, mediaVersion } =
    useLiveKit({
      url: livekitUrl,
      token: livekitToken ?? "",
      onTelemetry: onLiveKitTelemetry,
    });

  // Share LiveKit's mic track with the live voice engine (no second mic prompt).
  micTrackRef.current = localAudioTrack?.mediaStreamTrack ?? null;

  // Handle LiveKit errors
  useEffect(() => {
    if (livekitError) {
      setErrorMsg(livekitError);
      setPhase("error");
    }
  }, [livekitError]);

  // Move to ready when connected
  useEffect(() => {
    if (isConnected && phase === "connecting") {
      setPhase("ready");
    }
  }, [isConnected, phase]);

  // While the candidate reads the "Ready?" screen: connect speech recognition (muted, nothing billed)
  // and download Maya's short clips, so clicking Start only waits for her opening line.
  const pipelinePrewarm = pipelineEngine.prewarm;
  useEffect(() => {
    if (phase === "ready" && engineChoice === "pipeline" && interviewState === "idle") pipelinePrewarm();
  }, [phase, engineChoice, interviewState, pipelinePrewarm]);

  // Interview clock starts only after the candidate clicks "Start Interview" (intro),
  // not when the room / LiveKit connects.
  useEffect(() => {
    if (interviewState === "idle") {
      startTimeRef.current = null;
      setElapsedSeconds(0);
      return;
    }
    if (interviewState === "intro") {
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);
    }
  }, [interviewState]);

  // ─── Step 3: Attach local video to <video> element ────────────────────────
  // Also re-runs when the room screen appears (phase): if the camera track arrived while the
  // loading screen was still showing, there was no <video> to attach to and the tile stayed empty.
  // And after a camera swap (mediaVersion — see useLiveKit), so the self-view shows the new camera.
  useEffect(() => {
    if (!localVideoTrack || !videoRef.current) return;
    const el = videoRef.current;
    localVideoTrack.attach(el);
    return () => { localVideoTrack.detach(el); };
  }, [localVideoTrack, phase, mediaVersion]);

  // ─── Step 4: Video recording ─────────────────────────────────────────────
  const { isRecording, chunksUploaded } = useVideoRecorder({
    sessionId,
    videoTrack: localVideoTrack,
    audioTrack: localAudioTrack,
    enabled:
      isConnected &&
      !!sessionId &&
      interviewState !== "idle" &&
      interviewState !== "completed" &&
      interviewState !== "error",
    onTelemetry: onAvatarTelemetry,
    mediaVersion,
  });

  // Self-view health: records freezes / blank tile / camera ending, and re-binds the camera once.
  useCameraHealth({
    videoRef,
    videoTrack: localVideoTrack,
    enabled: isConnected && interviewState !== "idle" && interviewState !== "completed",
    onTelemetry: onAvatarTelemetry,
    mediaVersion,
  });

  // ─── Elapsed timer (only while interview is active) ───────────────────────
  useEffect(() => {
    if (
      !isConnected ||
      interviewState === "idle" ||
      interviewState === "completed" ||
      interviewState === "error" ||
      !startTimeRef.current
    )
      return;
    const interval = setInterval(() => {
      if (startTimeRef.current) {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isConnected, interviewState]);

  // ─── Auto-scroll logs ───────────────────────────────────────────────
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // ─── Auto-scroll transcript ───────────────────────────────────────────────
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, transcript]);

  // ─── Mic / cam toggle ────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (!localAudioTrack) return;
    if (micMuted) {
      localAudioTrack.unmute();
    } else {
      localAudioTrack.mute();
    }
    setMicMuted((v) => !v);
  }, [localAudioTrack, micMuted]);

  const toggleCam = useCallback(() => {
    if (!localVideoTrack) return;
    if (camOff) {
      localVideoTrack.unmute();
    } else {
      localVideoTrack.mute();
    }
    setCamOff((v) => !v);
  }, [localVideoTrack, camOff]);

  // ─── Auto-cleanup when interview completes normally ──────────────────────
  const [closeCountdown, setCloseCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (interviewState === "completed") {
      // Proctoring is already off here, so leaving fullscreen is not recorded as a violation.
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      disconnect();
      // Stop all active media tracks so camera/mic light turns off immediately
      navigator.mediaDevices.enumerateDevices().catch(() => {});
      [localVideoTrack, localAudioTrack].forEach((track) => {
        try { (track as { mediaStreamTrack?: MediaStreamTrack })?.mediaStreamTrack?.stop(); } catch { /* ignore */ }
      });
      // Also stop any lingering getUserMedia streams on the page
      document.querySelectorAll("video, audio").forEach((el) => {
        const media = el as HTMLVideoElement | HTMLAudioElement;
        try { media.srcObject = null; } catch { /* ignore */ }
      });
      setCloseCountdown(3);
    }
  }, [interviewState, disconnect, localVideoTrack, localAudioTrack]);

  useEffect(() => {
    if (closeCountdown === null) return;
    if (closeCountdown <= 0) {
      // window.close() only works when the tab was opened programmatically.
      // Most browsers block it for user-opened tabs — we just try it silently
      // and leave the completed screen visible as the fallback.
      try { window.close(); } catch { /* ignore */ }
      return;
    }
    const t = setTimeout(() => setCloseCountdown((n) => (n ?? 1) - 1), 1000);
    return () => clearTimeout(t);
  }, [closeCountdown]);

  // ─── Guards ───────────────────────────────────────────────────────────────
  if (phase === "error") {
    return <ErrorScreen message={errorMsg ?? "Something went wrong."} />;
  }

  if (phase === "loading" || phase === "connecting") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 text-white gap-4">
        <Loader2 className="h-10 w-10 animate-spin text-blue-400" />
        <p className="text-gray-400">
          {phase === "loading" ? "Starting your session…" : "Connecting to interview room…"}
        </p>
        {phase === "connecting" && (
          <p className="text-xs text-gray-600">
            Connection state: {connectionState}
          </p>
        )}
      </div>
    );
  }

  // ─── Completed screen ────────────────────────────────────────────────────
  if (interviewState === "completed") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 px-6 text-white">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-500/20">
            <span className="text-4xl">✓</span>
          </div>
          <h1 className="mb-3 text-2xl font-bold">Interview Complete</h1>
          <p className="text-gray-400">
            Thank you for completing the interview. Your responses have been
            recorded and will be reviewed shortly.
          </p>
          <p className="mt-6 rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm text-gray-400">
            {closeCountdown !== null && closeCountdown > 0
              ? `You can close this tab in ${closeCountdown} second${closeCountdown !== 1 ? "s" : ""}…`
              : "You can now safely close this tab."}
          </p>
        </div>
      </div>
    );
  }

  // ─── Meet-style room ──────────────────────────────────────────────────────
  // Candidates see two video tiles (Maya + themselves), optional captions and a control bar —
  // like a real video interview. Developer panels (debug logs, engine, transcript, integrity score)
  // appear only when the recruiter turned on Settings → Debug mode.
  const started = interviewState !== "idle";
  const mayaSpeaking = aiStatus === "speaking";
  const youSpeaking = interviewState === "listening" && candidateListeningPhase === "speaking";
  const captionLine =
    interviewState === "listening" && transcript
      ? { who: "You", text: transcript }
      : currentQuestion
        ? { who: "Maya", text: currentQuestion }
        : null;

  return (
    <div
      className="fixed inset-0 flex h-dvh max-h-dvh flex-col overflow-hidden overscroll-none bg-[#202124] text-white"
      // Read by the end-to-end browser test (tests/e2e) to follow the interview without scraping text.
      data-interview-state={interviewState}
      data-ai-status={aiStatus}
      data-engine={liveActive ? "live" : engineChoice}
    >
      {/* Reconnecting banner */}
      {isReconnecting && (
        <div className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reconnecting… your interview will resume automatically
        </div>
      )}

      {/* ─── Proctoring warning (candidates always see these) ─────────── */}
      {activeWarning && (
        <div className={`fixed top-4 left-1/2 z-50 -translate-x-1/2 flex items-start gap-3 rounded-2xl px-5 py-4 shadow-2xl w-full max-w-md border-2 ${
          activeWarning.severity === "high"
            ? "bg-red-950/98 border-red-500 text-red-100 shadow-red-500/30"
            : activeWarning.severity === "medium"
            ? "bg-amber-950/98 border-amber-400 text-amber-100 shadow-amber-500/20"
            : "bg-gray-900/98 border-gray-600 text-gray-100"
        }`}>
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            activeWarning.severity === "high" ? "bg-red-500/20" :
            activeWarning.severity === "medium" ? "bg-amber-500/20" : "bg-gray-700"
          }`}>
            <AlertTriangle className={`h-5 w-5 ${
              activeWarning.severity === "high" ? "text-red-400" :
              activeWarning.severity === "medium" ? "text-amber-400" : "text-gray-400"
            }`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold tracking-wide">
              {activeWarning.severity === "high" ? "Integrity warning" :
               activeWarning.severity === "medium" ? "Warning" : "Notice"}
            </p>
            <p className="text-sm mt-0.5 opacity-90">{activeWarning.message}</p>
            <p className="text-xs mt-1.5 opacity-60">This event has been recorded for the recruiter&apos;s review.</p>
          </div>
          <button onClick={dismissWarning} className="shrink-0 opacity-50 hover:opacity-100 mt-0.5" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Main area */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Stage: two tiles, side by side (stacked on narrow screens) */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-3 p-3 md:grid-cols-2 md:grid-rows-1">
            <Tile name="Maya · AI Interviewer" speaking={mayaSpeaking}>
              {serverInterviewerAvatar ? (
                <MayaAvatar
                  status={aiStatus}
                  size="md"
                  variant="tile"
                  serverAvatarId={serverInterviewerAvatar}
                  simli={{
                    interviewToken: params.token,
                    audioTrack: avatarEngine.remoteAudioTrack,
                    // Lip-sync runs on the pipeline (default) and GPT-Live engines. It starts at the Start
                    // click (not when Maya's audio arrives), so her live face is ready by her first word.
                    // On completion this whole screen is replaced, which unmounts the avatar and stops Simli.
                    enabled: avatarAvailable && started && interviewState !== "error",
                    interviewStarted: started,
                    onActiveChange: setLivePlaybackMuted,
                    onTelemetry: onAvatarTelemetry,
                    onSpeakingChange: setAvatarSpeaking,
                    getDebugContext: getAudioDebug,
                  }}
                />
              ) : (
                // Saved avatar not known until /start answers — never flash a different face meanwhile.
                <div className="h-full w-full animate-pulse bg-white/5" aria-hidden />
              )}
            </Tile>

            <Tile name="You" speaking={youSpeaking} micOff={micMuted}>
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className={`h-full w-full object-cover transition-opacity ${camOff ? "opacity-0" : "opacity-100"}`}
                style={{ transform: "scaleX(-1)" }}
              />
              {camOff && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#3c4043]">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gray-600">
                    <VideoOff className="h-8 w-8 text-gray-300" />
                  </div>
                </div>
              )}
            </Tile>
          </div>

          {/* Captions */}
          {captionsOn && started && captionLine && (
            <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center px-6">
              <div className="max-w-3xl rounded-lg bg-black/80 px-4 py-2 text-center text-[15px] leading-snug shadow-lg">
                <span className="mr-1.5 font-semibold text-[#8ab4f8]">{captionLine.who}:</span>
                <span className="line-clamp-3">{captionLine.text}</span>
              </div>
            </div>
          )}

          {/* Start — shown before the interview begins */}
          {interviewState === "idle" && phase === "ready" && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/60 px-6 text-center">
              <p className="text-xl font-semibold text-white">Ready to begin your interview?</p>
              <p className="max-w-md text-sm text-gray-300">
                Maya, your AI interviewer, will ask a few questions. Take your time to think — when you&apos;ve
                finished an answer, press <b>Done answering</b> (or Space), or just pause for a moment.
                This session is recorded and monitored
                {!debugMode && <> — your screen will switch to full screen when you start</>}.
              </p>
              <button
                onClick={startInterview}
                className="flex items-center gap-2 rounded-full bg-[#8ab4f8] px-8 py-3 text-base font-semibold text-[#202124] shadow-lg hover:bg-[#aecbfa]"
              >
                <PlayCircle className="h-5 w-5" />
                Start interview
              </button>
            </div>
          )}
        </div>

        {/* ─── Debug side panel (Settings → Debug mode only) ─────────────── */}
        {debugMode && (
          <div className="flex h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden border-l border-white/10 bg-gray-900">
            <div className="shrink-0 border-b border-white/10 p-4">
              <h2 className="text-sm font-semibold text-white">Debug · Interview</h2>
              <p className="mt-0.5 text-xs text-gray-400">
                Turn {turnIndex} •{" "}
                <span className={`font-medium ${CONV_PHASE_COLOR_TEXT[conversationTurnPhase]}`}>
                  {CONV_PHASE_LABEL[conversationTurnPhase]}
                </span>{" "}
                •{" "}
                <span className={`font-medium ${AI_STATUS_COLOR_TEXT[aiStatus]}`}>{AI_STATUS_LABEL[aiStatus]}</span>
                {interviewState === "listening" && (
                  <>
                    {" "}•{" "}
                    <span className={`font-medium ${CANDIDATE_PHASE_COLOR_TEXT[candidateListeningPhase]}`}>
                      You: {CANDIDATE_PHASE_LABEL[candidateListeningPhase]}
                    </span>
                  </>
                )}
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {currentQuestion && (
                <div className="sticky top-0 z-10 bg-gray-900">
                  <div className="max-h-[32vh] overflow-y-auto border-b border-white/10 bg-blue-600/10 px-4 py-3">
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-blue-400">Current Question</p>
                    <p className="text-sm leading-relaxed text-white">{currentQuestion}</p>
                  </div>
                </div>
              )}
              <div className="space-y-2 p-3">
                {turns.length === 0 && (
                  <p className="py-4 text-center text-xs text-gray-500">Conversation will appear here</p>
                )}
                {turns.map((turn, i) => (
                  <div
                    key={i}
                    className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
                      turn.role === "interviewer" ? "bg-gray-800 text-gray-200" : "ml-2 bg-blue-600/20 text-blue-100"
                    }`}
                  >
                    <span className={`mb-0.5 block text-[10px] font-semibold uppercase tracking-wide ${
                      turn.role === "interviewer" ? "text-gray-400" : "text-blue-400"
                    }`}>
                      {turn.role === "interviewer" ? "AI Interviewer" : "You"}
                    </span>
                    {turn.content}
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
            </div>

            <div className="shrink-0 space-y-2 border-t border-white/10 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Focus</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  focusStatus === "focused" ? "bg-green-900/60 text-green-400" :
                  focusStatus === "blurred" ? "bg-amber-900/60 text-amber-400" : "bg-red-900/60 text-red-400"
                }`}>
                  {focusStatus === "focused" ? "On screen" : focusStatus === "blurred" ? "Window unfocused" : "Tab hidden"}
                </span>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-1 text-xs text-gray-400">
                    <Shield className="h-3 w-3" />
                    Integrity Score
                  </div>
                  <span className={`text-xs font-bold ${
                    integrityScore >= 80 ? "text-green-400" : integrityScore >= 60 ? "text-amber-400" : "text-red-400"
                  }`}>{integrityScore}/100</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-gray-700">
                  <div
                    className={`h-1.5 rounded-full transition-all duration-500 ${
                      integrityScore >= 80 ? "bg-green-500" : integrityScore >= 60 ? "bg-amber-500" : "bg-red-500"
                    }`}
                    style={{ width: `${integrityScore}%` }}
                  />
                </div>
                {violations.length > 0 && (
                  <p className="mt-1 text-[10px] text-gray-500">{violations.length} event{violations.length !== 1 ? "s" : ""} recorded</p>
                )}
                <p className="mt-1 text-[10px] text-gray-500">
                  AI proctoring:{" "}
                  <span className={
                    proctorAiStatus === "ready" ? "text-green-400" :
                    proctorAiStatus === "unavailable" ? "text-amber-400" : "text-gray-400"
                  }>
                    {proctorAiStatus === "ready" ? "active" :
                     proctorAiStatus === "loading" ? "loading models…" :
                     proctorAiStatus === "unavailable" ? "unavailable — basic checks only" : "off"}
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                {isConnected ? (
                  <><Wifi className="h-3.5 w-3.5 text-green-500" /><span className="text-green-400">Connected</span></>
                ) : (
                  <><WifiOff className="h-3.5 w-3.5 text-amber-500" /><span className="text-amber-400">Reconnecting…</span></>
                )}
                {isRecording && (
                  <span className="ml-auto text-gray-500">{chunksUploaded} chunk{chunksUploaded !== 1 ? "s" : ""} saved</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── Bottom control bar ─────────────────────────────────────────── */}
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex min-w-0 items-center gap-3 text-sm text-gray-300">
          {isConnected && <span className="font-mono">{formatTime(elapsedSeconds)}</span>}
          {isRecording && (
            <span className="flex items-center gap-1.5 text-xs">
              <Circle className="h-2.5 w-2.5 fill-red-500 text-red-500" />
              Recording
            </span>
          )}
        </div>

        <div className="flex items-center justify-center gap-3">
          <ControlButton
            onClick={toggleMic}
            active={!micMuted}
            activeIcon={<Mic className="h-5 w-5" />}
            inactiveIcon={<MicOff className="h-5 w-5" />}
            label={micMuted ? "Turn on microphone" : "Turn off microphone"}
          />
          <ControlButton
            onClick={toggleCam}
            active={!camOff}
            activeIcon={<Video className="h-5 w-5" />}
            inactiveIcon={<VideoOff className="h-5 w-5" />}
            label={camOff ? "Turn on camera" : "Turn off camera"}
          />
          {pipelineActive && started && (
            <button
              onClick={() => finishAnswer()}
              disabled={!canFinishAnswer}
              title="Press when you've finished your answer (or press Space)"
              className={`flex h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors ${
                canFinishAnswer
                  ? "bg-[#8ab4f8] text-[#202124] hover:bg-[#aecbfa]"
                  : "cursor-not-allowed bg-white/10 text-gray-500"
              }`}
            >
              <Check className="h-4 w-4" />
              Done answering
            </button>
          )}
          <ControlButton
            onClick={() => setCaptionsOn((v) => !v)}
            active={captionsOn}
            activeIcon={<Captions className="h-5 w-5" />}
            inactiveIcon={<CaptionsOff className="h-5 w-5" />}
            label={captionsOn ? "Turn off captions" : "Turn on captions"}
          />
          <button
            onClick={async () => {
              await endEarly();
              disconnect();
              router.push(`/interview/${params.token}`);
            }}
            title="Leave interview"
            className="flex h-11 w-14 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-700"
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-w-0 items-center justify-end gap-2">
          {started && !debugMode && !isFullscreen && typeof document !== "undefined" && document.fullscreenEnabled && (
            <button
              onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}
              className="rounded-full bg-[#8ab4f8] px-3 py-1 text-xs font-semibold text-[#202124] hover:bg-[#aecbfa]"
            >
              Return to full screen
            </button>
          )}
          {started && (
            <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
              focusStatus === "tab_hidden"
                ? "bg-red-600/90 text-white"
                : focusStatus === "blurred"
                ? "bg-amber-500/90 text-white"
                : "bg-white/10 text-gray-200"
            }`}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {focusStatus === "tab_hidden"
                ? "Return to the interview tab"
                : focusStatus === "blurred"
                ? "Interview window not in focus"
                : "Monitored"}
            </span>
          )}
        </div>
      </div>

      {/* ─── Debug log panel (Settings → Debug mode only) ──────────────── */}
      {debugMode && (
      <div className="shrink-0 border-t border-white/10 bg-gray-950">
        <button
          onClick={() => setShowLogs((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-2 text-left"
        >
          <div className="flex items-center gap-2">
            <div
              className={`h-2 w-2 rounded-full ${
                interviewState === "error" ? "bg-red-500"
                : interviewState === "listening" ? "bg-green-500"
                : "bg-gray-500"
              }`}
            />
            <span className="text-xs font-bold uppercase tracking-widest text-gray-300">
              Debug Logs
            </span>
            <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300 border border-gray-600">
              {logs.length}
            </span>
            <span className="text-xs text-gray-500">
              FLOW &bull; LLM &bull; TTS &bull; STT &bull; MIC
            </span>
            {/* Which voice engine is running, and if it isn't GPT-Live, why not. */}
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                liveActive
                  ? "bg-violet-900/60 text-violet-300"
                  : fallbackReason
                    ? "bg-amber-900/60 text-amber-300"
                    : liveEligible
                      ? "bg-violet-900/40 text-violet-300"
                      : "bg-gray-800 text-gray-300"
              }`}
              title={fallbackReason ?? undefined}
            >
              {liveActive
                ? "Engine: GPT-Live"
                : fallbackReason
                  ? `Engine: Pipeline — GPT-Live failed: ${describeLiveFallback(fallbackReason)}`
                  : forcedLegacy
                    ? "Engine: Standard (forced by ?engine=legacy)"
                    : liveEligible
                      ? "Engine: GPT-Live ready — click Start"
                      : "Engine: Pipeline (Deepgram + Aura voice)"}
            </span>
          </div>
          <span className="text-xs text-gray-400">{showLogs ? "▼" : "▶"}</span>
        </button>

        {showLogs && (
          <div className="h-44 overflow-y-auto bg-black/40 font-mono">
            {logs.length === 0 ? (
              <p className="px-4 py-3 text-xs text-gray-500">
                No logs yet — click Start Interview to begin.
              </p>
            ) : (
              logs.map((e: LogEntry) => (
                <div
                  key={e.id}
                  className={`grid gap-1.5 px-4 py-0.5 ${
                    e.level === "error" ? "border-l-2 border-red-500/40 bg-red-500/5" :
                    e.level === "warn"  ? "border-l-2 border-amber-500/40" :
                    "border-l-2 border-transparent"
                  }`}
                  style={{ gridTemplateColumns: "72px 48px 48px 1fr" }}
                >
                  <span className="text-[10px] text-gray-500 pt-px">{e.time}</span>
                  <span className={`text-[10px] font-bold ${
                    e.step === "FLOW" ? "text-purple-400" :
                    e.step === "LLM"  ? "text-emerald-400" :
                    e.step === "TTS"  ? "text-orange-400" :
                    e.step === "STT"  ? "text-sky-400" :
                    "text-pink-400"
                  }`}>[{e.step}]</span>
                  <span className={`text-[9px] px-1 py-px rounded text-center self-start ${
                    e.level === "error"   ? "bg-red-500/20 text-red-300" :
                    e.level === "warn"    ? "bg-amber-500/20 text-amber-300" :
                    e.level === "success" ? "bg-green-500/20 text-green-300" :
                    "bg-gray-700 text-gray-400"
                  }`}>{e.level.toUpperCase()}</span>
                  <span className={`text-[11px] leading-relaxed break-words ${
                    e.level === "error"   ? "text-red-300" :
                    e.level === "warn"    ? "text-amber-300" :
                    e.level === "success" ? "text-green-300" :
                    "text-gray-400"
                  }`}>{e.message}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/** A Meet-style participant tile: blue ring while speaking, name label bottom-left. */
function Tile({
  name,
  speaking,
  micOff,
  children,
}: {
  name: string;
  speaking: boolean;
  micOff?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`relative min-h-0 overflow-hidden rounded-2xl bg-[#3c4043] ring-[3px] transition-shadow duration-200 ${
        speaking ? "ring-[#8ab4f8]" : "ring-transparent"
      }`}
    >
      {children}
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-0.5 text-xs font-medium text-white">
        {micOff && <MicOff className="h-3 w-3 text-red-400" />}
        {name}
      </div>
    </div>
  );
}

function ControlButton({
  onClick,
  active,
  activeIcon,
  inactiveIcon,
  label,
}: {
  onClick: () => void;
  active: boolean;
  activeIcon: React.ReactNode;
  inactiveIcon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
        active
          ? "bg-white/10 text-white hover:bg-white/20"
          : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
      }`}
    >
      {active ? activeIcon : inactiveIcon}
    </button>
  );
}

const CONV_PHASE_LABEL: Record<ConversationTurnPhase, string> = {
  LISTENING_IDLE: "Idle",
  CANDIDATE_SPEAKING: "You speaking",
  CANDIDATE_THINKING: "You thinking",
  CANDIDATE_FINISHED: "Answer settling",
  AI_DECIDING: "AI deciding",
  AI_SPEAKING: "AI speaking",
  BARGE_IN_HANDLING: "Interrupted",
};

const CONV_PHASE_COLOR_TEXT: Record<ConversationTurnPhase, string> = {
  LISTENING_IDLE: "text-gray-400",
  CANDIDATE_SPEAKING: "text-emerald-400",
  CANDIDATE_THINKING: "text-amber-400",
  CANDIDATE_FINISHED: "text-sky-400",
  AI_DECIDING: "text-amber-400",
  AI_SPEAKING: "text-blue-400",
  BARGE_IN_HANDLING: "text-orange-400",
};

const AI_STATUS_LABEL: Record<AIStatus, string> = {
  waiting: "Waiting to start",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const CANDIDATE_PHASE_LABEL: Record<CandidateListeningPhase, string> = {
  idle: "Mic off",
  speaking: "Speaking…",
  pause: "Paused / thinking…",
  committing: "Finishing answer…",
};

const CANDIDATE_PHASE_COLOR_TEXT: Record<CandidateListeningPhase, string> = {
  idle: "text-gray-400",
  speaking: "text-emerald-400",
  pause: "text-amber-400",
  committing: "text-sky-400",
};

const AI_STATUS_COLOR_TEXT: Record<AIStatus, string> = {
  waiting: "text-gray-400",
  listening: "text-green-400",
  thinking: "text-amber-400",
  speaking: "text-blue-400",
};

const AI_STATUS_COLORS: Record<AIStatus, string> = {
  waiting: "bg-gray-600",
  listening: "bg-green-500",
  thinking: "bg-amber-500",
  speaking: "bg-blue-500",
};

// Legacy status indicator (replaced by MayaAvatar)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _AIStatusIndicator({ status }: { status: AIStatus }) {
  return (
    <div
      className={`flex h-14 w-14 items-center justify-center rounded-full ${AI_STATUS_COLORS[status]} ${
        status !== "waiting" ? "animate-pulse" : ""
      }`}
    >
      <span className="text-xl font-bold text-white">AI</span>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 px-4 text-white">
      <div className="max-w-sm text-center">
        <WifiOff className="mx-auto mb-4 h-12 w-12 text-red-400" />
        <h1 className="mb-2 text-lg font-semibold">Connection Failed</h1>
        <p className="mb-6 text-sm text-gray-400">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
