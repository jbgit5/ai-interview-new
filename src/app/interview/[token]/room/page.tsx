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
} from "lucide-react";
import { useLiveKit } from "@/hooks/useLiveKit";
import { useSessionTelemetry } from "@/hooks/useSessionTelemetry";
import { useVideoRecorder } from "@/hooks/useVideoRecorder";
import { useInterview } from "@/hooks/useInterview";
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
    startInterview,
    endEarly,
    reset: resetInterview,
  } = useInterview({ sessionToken: params.token, telemetry: sessionTelemetry });

  // ─── Proctoring ──────────────────────────────────────────────────────────
  const { integrityScore, violations, activeWarning, dismissWarning, focusStatus } = useProctor({
    sessionToken: params.token,
    videoRef,
    enabled: interviewState !== "idle" && interviewState !== "completed",
  });

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
  const { connectionState, localVideoTrack, localAudioTrack, isConnected, isReconnecting, error: livekitError, disconnect } =
    useLiveKit({
      url: livekitUrl,
      token: livekitToken ?? "",
      onTelemetry: onLiveKitTelemetry,
    });

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
  useEffect(() => {
    if (!localVideoTrack || !videoRef.current) return;
    const el = videoRef.current;
    localVideoTrack.attach(el);
    return () => { localVideoTrack.detach(el); };
  }, [localVideoTrack]);

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
      setCloseCountdown(5);
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

  return (
    <div className="fixed inset-0 flex h-dvh max-h-dvh flex-col overflow-hidden overscroll-none bg-gray-950 text-white">
      {/* Reconnecting banner */}
      {isReconnecting && (
        <div className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reconnecting… your interview will resume automatically
        </div>
      )}

      {/* ─── Proctoring warning overlay ────────────────────────────────── */}
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
              {activeWarning.severity === "high" ? "🚨 Integrity Violation" :
               activeWarning.severity === "medium" ? "⚠️ Warning" : "Notice"}
            </p>
            <p className="text-sm mt-0.5 opacity-90">{activeWarning.message}</p>
            <p className="text-xs mt-1.5 opacity-60">This event has been recorded and flagged for recruiter review.</p>
          </div>
          <button onClick={dismissWarning} className="shrink-0 opacity-50 hover:opacity-100 mt-0.5">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Main area — min-h-0 lets flex children shrink so the bottom bar never gets pushed off-screen */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Video feed */}
        <div className="relative flex min-h-0 min-w-0 flex-1 bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className={`h-full w-full object-cover transition-opacity ${camOff ? "opacity-0" : "opacity-100"}`}
            style={{ transform: "scaleX(-1)" }}
          />

          {camOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gray-700">
                <VideoOff className="h-8 w-8 text-gray-400" />
              </div>
            </div>
          )}

          {/* Recording indicator */}
          {isRecording && (
            <div className="absolute left-4 top-4 flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs font-medium">
              <Circle className="h-2.5 w-2.5 fill-red-500 text-red-500" />
              REC
            </div>
          )}

          {/* ── Prominent focus / proctoring status bar ── */}
          {interviewState !== "idle" && (
            <div className={`absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold shadow-lg backdrop-blur-sm transition-all duration-500 ${
              focusStatus === "tab_hidden"
                ? "bg-red-600/90 text-white border border-red-400"
                : focusStatus === "blurred"
                ? "bg-amber-500/90 text-white border border-amber-300"
                : "bg-black/50 text-green-400 border border-green-500/40"
            }`}>
              <span className={`h-2 w-2 rounded-full ${
                focusStatus === "tab_hidden" ? "bg-red-200 animate-ping" :
                focusStatus === "blurred"    ? "bg-amber-200 animate-pulse" :
                                              "bg-green-400 animate-pulse"
              }`} />
              {focusStatus === "tab_hidden"
                ? "⚠ Tab hidden — return to interview now"
                : focusStatus === "blurred"
                ? "⚠ Window not in focus"
                : "● Being monitored"}
              <span className="opacity-60">|</span>
              <Shield className="h-3 w-3" />
              <span className={
                integrityScore >= 80 ? "text-green-400" :
                integrityScore >= 60 ? "text-amber-300" : "text-red-300"
              }>{integrityScore}</span>
            </div>
          )}

          {/* Elapsed time */}
          {isConnected && (
            <div className="absolute right-4 top-4 rounded-full bg-black/60 px-3 py-1 text-xs font-mono">
              {formatTime(elapsedSeconds)}
            </div>
          )}

          {/* Live transcript overlay while candidate is speaking */}
          {interviewState === "listening" && transcript && (
            <div className="absolute bottom-6 left-1/2 w-3/4 -translate-x-1/2 rounded-xl bg-black/70 px-4 py-3 text-center text-sm text-white backdrop-blur-sm">
              {transcript}
            </div>
          )}

          {/* Start Interview button — shown before interview begins */}
          {interviewState === "idle" && phase === "ready" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/50">
              <p className="text-lg font-semibold text-white">
                Room connected. Ready to begin?
              </p>
              <button
                onClick={startInterview}
                className="flex items-center gap-2 rounded-xl bg-blue-600 px-8 py-3 text-base font-semibold text-white shadow-lg hover:bg-blue-700"
              >
                <PlayCircle className="h-5 w-5" />
                Start Interview
              </button>
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="flex h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden border-l border-white/10 bg-gray-900">
          {/* Header */}
          <div className="border-b border-white/10 p-4">
            <h2 className="text-sm font-semibold text-white">Interview</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Turn {turnIndex} •{" "}
              <span
                className={`font-medium ${CONV_PHASE_COLOR_TEXT[conversationTurnPhase]}`}
                title="Conversation state machine phase (telemetry)"
              >
                {CONV_PHASE_LABEL[conversationTurnPhase]}
              </span>
              {" "}
              •{" "}
              <span className={`font-medium ${AI_STATUS_COLOR_TEXT[aiStatus]}`}>
                {AI_STATUS_LABEL[aiStatus]}
              </span>
              {interviewState === "listening" && (
                <>
                  {" "}
                  •{" "}
                  <span
                    className={`font-medium ${CANDIDATE_PHASE_COLOR_TEXT[candidateListeningPhase]}`}
                  >
                    You: {CANDIDATE_PHASE_LABEL[candidateListeningPhase]}
                  </span>
                </>
              )}
            </p>
          </div>

          {/* Maya AI Avatar */}
          <div className="flex items-center justify-center border-b border-white/10 py-5">
            <MayaAvatar
              status={aiStatus}
              size="md"
              serverAvatarId={serverInterviewerAvatar}
            />
          </div>

          {/* Current question — capped height so long intros don’t steal layout from transcript + footer */}
          {currentQuestion && (
            <div className="max-h-[min(38vh,320px)] shrink-0 overflow-y-auto border-b border-white/10 bg-blue-600/10 px-4 py-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-blue-400">
                Current Question
              </p>
              <p className="text-sm leading-relaxed text-white">
                {currentQuestion}
              </p>
            </div>
          )}

          {/* Conversation transcript */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2">
            {turns.length === 0 && (
              <p className="py-4 text-center text-xs text-gray-500">
                Conversation will appear here
              </p>
            )}
            {turns.map((turn, i) => (
              <div
                key={i}
                className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  turn.role === "interviewer"
                    ? "bg-gray-800 text-gray-200"
                    : "ml-2 bg-blue-600/20 text-blue-100"
                }`}
              >
                <span
                  className={`mb-0.5 block text-[10px] font-semibold uppercase tracking-wide ${
                    turn.role === "interviewer" ? "text-gray-400" : "text-blue-400"
                  }`}
                >
                  {turn.role === "interviewer" ? "AI Interviewer" : "You"}
                </span>
                {turn.content}
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>

          {/* Footer — connection + integrity */}
          <div className="border-t border-white/10 p-3 space-y-2">
            {/* Live focus status */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Focus</span>
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-2 py-0.5 ${
                focusStatus === "focused"    ? "bg-green-900/60 text-green-400" :
                focusStatus === "blurred"   ? "bg-amber-900/60 text-amber-400" :
                                              "bg-red-900/60 text-red-400"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${
                  focusStatus === "focused"    ? "bg-green-400 animate-pulse" :
                  focusStatus === "blurred"   ? "bg-amber-400" :
                                                "bg-red-400"
                }`} />
                {focusStatus === "focused"    ? "On screen" :
                 focusStatus === "blurred"   ? "Window unfocused" :
                                               "Tab hidden"}
              </span>
            </div>

            {/* Integrity score */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1 text-xs text-gray-400">
                  <Shield className="h-3 w-3" />
                  Integrity Score
                </div>
                <span className={`text-xs font-bold ${
                  integrityScore >= 80 ? "text-green-400" :
                  integrityScore >= 60 ? "text-amber-400" : "text-red-400"
                }`}>{integrityScore}/100</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-gray-700">
                <div
                  className={`h-1.5 rounded-full transition-all duration-500 ${
                    integrityScore >= 80 ? "bg-green-500" :
                    integrityScore >= 60 ? "bg-amber-500" : "bg-red-500"
                  }`}
                  style={{ width: `${integrityScore}%` }}
                />
              </div>
              {violations.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-500">{violations.length} event{violations.length !== 1 ? "s" : ""} recorded</p>
              )}
            </div>
            {/* Connection */}
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
      </div>

      {/* Bottom: mic / cam / leave only — monitoring + REC + timer stay on the video overlay */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-white/10 bg-gray-900 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap items-center justify-center gap-3">
        <ControlButton
          onClick={toggleMic}
          active={!micMuted}
          activeIcon={<Mic className="h-5 w-5" />}
          inactiveIcon={<MicOff className="h-5 w-5" />}
          label={micMuted ? "Unmute" : "Mute"}
        />
        <ControlButton
          onClick={toggleCam}
          active={!camOff}
          activeIcon={<Video className="h-5 w-5" />}
          inactiveIcon={<VideoOff className="h-5 w-5" />}
          label={camOff ? "Show Camera" : "Hide Camera"}
        />
        <button
          onClick={async () => {
            await endEarly();
            disconnect();
            router.push(`/interview/${params.token}`);
          }}
          className="rounded-full bg-red-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-700"
        >
          Leave
        </button>
        </div>
      </div>

      {/* ─── Debug log panel ──────────────────────────────────────── */}
      <div className="shrink-0 border-t border-white/10 bg-gray-950">
        {/* Header */}
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
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

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
