import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { SimliClient } from "simli-client";

/**
 * EXPERIMENTAL — real-person lip-sync avatar (Simli), branch experiment/gpt-live.
 *
 * Maya's GPT-Live audio track is streamed to Simli, which returns a video of the chosen face
 * speaking in sync; we show that video and mute the raw GPT-Live playback. Only MAYA's voice goes
 * to Simli — the candidate's audio never does.
 *
 * Safety design (the candidate must never lose Maya's voice or face because of this layer):
 *  - The raw GPT-Live audio keeps playing until Simli reports "start" (video visibly rendering);
 *    only then do we call onActiveChange(true) so the parent mutes it.
 *  - Any failure (denied by guardrails, mint error, startup error, 10 s timeout, mid-session error/stop)
 *    calls onActiveChange(false) immediately → raw audio unmutes, the static photo shows again.
 *  - Spend is capped by the server ledger AND by Simli's own maxSessionLength in the token.
 */

export type SimliPhase = "off" | "connecting" | "active" | "failed";

interface Options {
  interviewToken: string;
  /** Maya's incoming GPT-Live audio track; the avatar starts once this exists. */
  audioTrack: MediaStreamTrack | null;
  /** Only true while the interview is running on the GPT-Live engine. */
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement>;
  audioRef: RefObject<HTMLAudioElement>;
  onActiveChange: (active: boolean) => void;
  onTelemetry?: (eventName: string, attrs?: Record<string, unknown>) => void;
  /** Simli's speaking/silent events — what the candidate is still seeing and hearing. */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Extra context (what Maya was doing) attached to the "provider stopped us" diagnostic event. */
  getDebugContext?: () => Record<string, unknown>;
}

const START_TIMEOUT_MS = 10_000;
/** How many of Simli's most recent server messages to keep for the stop diagnostic. */
const LAST_MESSAGES_KEPT = 6;
/**
 * Silent-avatar watchdog. We mute the raw GPT-Live voice once the avatar is on screen, so if the avatar
 * then produced NO sound, the candidate would hear nothing from Maya. If Maya has been audibly speaking
 * for this long while the avatar's own audio output stayed silent the whole time, drop the avatar
 * (raw voice comes straight back). Chosen well above the avatar's normal ~0.3–1 s audio delay.
 */
const SILENT_AVATAR_TRIP_MS = 3_000;
/** Output level (RMS 0..1) that counts as the avatar making sound. */
const AVATAR_AUDIBLE_RMS = 0.01;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function useSimliAvatar({
  interviewToken,
  audioTrack,
  enabled,
  videoRef,
  audioRef,
  onActiveChange,
  onTelemetry,
  onSpeakingChange,
  getDebugContext,
}: Options): { phase: SimliPhase } {
  const [phase, setPhase] = useState<SimliPhase>("off");
  const clientRef = useRef<SimliClient | null>(null);
  const ledgerIdRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const activeRef = useRef(false);
  /** Set once a start attempt has been made for this interview (no retry loops that spend money). */
  const startedRef = useRef(false);
  const closedRef = useRef(false);
  /**
   * Audio "mixer": Simli is started at the Start click, BEFORE Maya's voice exists, so it is fed from
   * an (initially silent) WebAudio destination. Maya's GPT-Live track is plugged into it the moment it
   * arrives. This is what lets her live face be ready by her first word instead of switching mid-sentence.
   */
  const mixCtxRef = useRef<AudioContext | null>(null);
  const mixDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const mixSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const mixedTrackRef = useRef<MediaStreamTrack | null>(null);
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const onTelemetryRef = useRef(onTelemetry);
  onTelemetryRef.current = onTelemetry;
  const onSpeakingRef = useRef(onSpeakingChange);
  onSpeakingRef.current = onSpeakingChange;
  const debugContextRef = useRef(getDebugContext);
  debugContextRef.current = getDebugContext;
  /** Silent-avatar watchdog resources (see SILENT_AVATAR_TRIP_MS). */
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogCtxRef = useRef<AudioContext | null>(null);
  /** Simli's most recent raw server messages — the evidence for WHY it ended a session. */
  const lastMessagesRef = useRef<string[]>([]);
  const wsCloseRef = useRef<{ code: number; reason: string } | null>(null);
  const tokenRef = useRef(interviewToken);
  tokenRef.current = interviewToken;

  const audioTrackRef = useRef(audioTrack);
  audioTrackRef.current = audioTrack;
  /** Connect Maya's track to the mixer once both exist. Idempotent; safe to call on every render. */
  const plugMayaIntoMixer = useCallback(() => {
    const ctx = mixCtxRef.current;
    const dest = mixDestRef.current;
    const track = audioTrackRef.current;
    if (!ctx || !dest || !track || mixedTrackRef.current === track) return;
    try {
      mixSourceRef.current?.disconnect();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      src.connect(dest);
      mixSourceRef.current = src;
      mixedTrackRef.current = track;
      onTelemetryRef.current?.("avatar.simli.audio_connected", {
        since_start_ms: startedAtRef.current ? Date.now() - startedAtRef.current : null,
      });
    } catch {
      /* the silent-avatar watchdog will hand audio back to GPT-Live if this ever fails */
    }
  }, []);

  /** Stop the avatar, hand audio back to GPT-Live, and settle the spend ledger. Idempotent. */
  const shutdown = useCallback((reason: string, finalPhase: SimliPhase) => {
    if (closedRef.current) return;
    closedRef.current = true;

    if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current);
    watchdogTimerRef.current = null;
    const wctx = watchdogCtxRef.current;
    watchdogCtxRef.current = null;
    if (wctx) void wctx.close().catch(() => {});

    try { mixSourceRef.current?.disconnect(); } catch { /* ignore */ }
    mixSourceRef.current = null;
    mixedTrackRef.current = null;
    mixDestRef.current = null;
    const mctx = mixCtxRef.current;
    mixCtxRef.current = null;
    if (mctx) void mctx.close().catch(() => {});

    if (activeRef.current) {
      activeRef.current = false;
      onActiveChangeRef.current(false); // raw GPT-Live audio audible again
    }
    const client = clientRef.current;
    clientRef.current = null;
    if (client) void client.stop().catch(() => {});

    const id = ledgerIdRef.current;
    ledgerIdRef.current = null;
    if (id) {
      const usage = startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0;
      void fetch(`/api/avatar/simli/session/${id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenRef.current, usage_seconds: usage, reason }),
        keepalive: true,
      }).catch(() => {});
      onTelemetryRef.current?.("avatar.simli.closed", { reason, usage_seconds: usage });
    }
    setPhase(finalPhase);
  }, []);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    closedRef.current = false;
    let cancelled = false;

    (async () => {
      const t0 = Date.now();
      setPhase("connecting");
      try {
        // Started at the Start click, so the GPT-Live voice session (which the server requires to be
        // open before it will mint an avatar token) may still be a second away. Its ledger row is
        // written within ~0.5 s of the click, so retry briefly on exactly that answer — nothing else.
        let res: Response | null = null;
        const mintDeadline = Date.now() + 10_000;
        for (;;) {
          res = await fetch("/api/avatar/simli/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tokenRef.current }),
          });
          if (res.ok || cancelled) break;
          const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
          if (res.status !== 409 || body.error !== "avatar_no_live_session" || Date.now() > mintDeadline) break;
          await sleep(700);
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(`mint_${res.status}:${(body as { error?: string }).error ?? "unknown"}`);
        }
        const data = (await res.json()) as {
          session_token: string;
          avatar_session_id: string;
          max_seconds: number;
        };
        ledgerIdRef.current = data.avatar_session_id;
        startedAtRef.current = Date.now();
        if (cancelled) throw new Error("cancelled");

        const video = videoRef.current;
        const audio = audioRef.current;
        if (!video || !audio) throw new Error("no_media_elements");

        // Loaded on demand: the SDK touches browser-only APIs and must never run during SSR.
        const { SimliClient: Client, LogLevel } = await import("simli-client");
        const client = new Client(data.session_token, video, audio, null, LogLevel.ERROR, "livekit");
        clientRef.current = client;

        // Register handlers BEFORE start() so no early event is missed.
        let started: () => void = () => {};
        let failed: (e: Error) => void = () => {};
        const startedPromise = new Promise<void>((resolve, reject) => {
          started = resolve;
          failed = reject;
        });
        client.on("start", () => started());
        client.on("startup_error", (m) => failed(new Error(`startup_error:${m}`)));
        // Simli ending a session unexpectedly is the single most important thing to understand, so
        // record the evidence: how long it ran, what Maya was doing, and Simli's last messages.
        const reportProviderEnd = (kind: string, detail: string) => {
          // Snapshot Maya's state NOW, but send shortly after: the socket's close code arrives a
          // moment after Simli's STOP message and is the most useful clue.
          const sinceStartMs = startedAtRef.current ? Date.now() - startedAtRef.current : null;
          const context = debugContextRef.current?.() ?? {};
          setTimeout(() => {
            onTelemetryRef.current?.("avatar.simli.stopped", {
              kind,
              detail: detail.slice(0, 120),
              since_start_ms: sinceStartMs,
              ws_close_code: wsCloseRef.current?.code ?? null,
              ws_close_reason: wsCloseRef.current?.reason?.slice(0, 120) ?? null,
              last_messages: lastMessagesRef.current.slice(-LAST_MESSAGES_KEPT),
              ...context,
            });
          }, 500);
        };
        client.on("error", (m) => {
          if (activeRef.current) {
            reportProviderEnd("error", String(m));
            shutdown(`error:${String(m).slice(0, 60)}`, "failed");
          } else failed(new Error(`error:${m}`));
        });
        client.on("stop", () => {
          if (activeRef.current) {
            reportProviderEnd("stop", "server sent STOP/ENDFRAME");
            shutdown("provider_stop", "failed");
          }
        });
        client.on("speaking", () => onSpeakingRef.current?.(true));
        client.on("silent", () => onSpeakingRef.current?.(false));

        await client.start();

        // Diagnostic-only peek at Simli's signalling socket (SDK internals, so strictly best-effort and
        // wrapped in try/catch): capture its close code/reason and last text messages.
        try {
          const ws = (
            client as unknown as {
              connection?: { signalingConnection?: { wsConnection?: WebSocket } };
            }
          ).connection?.signalingConnection?.wsConnection;
          lastMessagesRef.current = [];
          wsCloseRef.current = null;
          ws?.addEventListener("message", (m: MessageEvent) => {
            if (typeof m.data === "string") {
              lastMessagesRef.current.push(m.data.slice(0, 100));
              if (lastMessagesRef.current.length > 20) lastMessagesRef.current.shift();
            }
          });
          ws?.addEventListener("close", (e: CloseEvent) => {
            wsCloseRef.current = { code: e.code, reason: e.reason };
          });
        } catch {
          /* diagnostics must never break the avatar */
        }
        await Promise.race([
          startedPromise,
          sleep(START_TIMEOUT_MS).then(() => {
            throw new Error("start_timeout");
          }),
        ]);
        if (cancelled) throw new Error("cancelled");

        // Simli listens to our mixer (silent until Maya's GPT-Live track is plugged in — see the effect
        // below). handleSilence=false was requested in the token because we stream continuously.
        const Mix =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        const mixCtx = new Mix();
        void mixCtx.resume().catch(() => {});
        const dest = mixCtx.createMediaStreamDestination();
        mixCtxRef.current = mixCtx;
        mixDestRef.current = dest;
        plugMayaIntoMixer();
        client.listenToMediastreamTrack(dest.stream.getAudioTracks()[0]);
        activeRef.current = true;
        onActiveChangeRef.current(true); // video is visible — now safe to mute the raw audio
        setPhase("active");

        // Watchdog (see SILENT_AVATAR_TRIP_MS): the raw voice is now muted, so make sure the avatar
        // is really producing sound whenever Maya is speaking.
        try {
          const outStream = audio.srcObject as MediaStream | null;
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (outStream && Ctx) {
            const ctx = new Ctx();
            watchdogCtxRef.current = ctx;
            void ctx.resume().catch(() => {});
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            ctx.createMediaStreamSource(outStream).connect(analyser); // analysis only, not routed to speakers
            const buf = new Uint8Array(analyser.fftSize);
            let avatarLastAudibleAt = Date.now();
            let mayaStreakStart = 0;
            watchdogTimerRef.current = setInterval(() => {
              analyser.getByteTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
              }
              const now = Date.now();
              if (Math.sqrt(sum / buf.length) > AVATAR_AUDIBLE_RMS) avatarLastAudibleAt = now;
              const sinceMaya = debugContextRef.current?.().ms_since_maya_audible;
              const mayaAudibleNow = typeof sinceMaya === "number" && sinceMaya < 400;
              if (!mayaAudibleNow) {
                mayaStreakStart = 0; // she paused: restart the count
                return;
              }
              if (!mayaStreakStart) mayaStreakStart = now;
              const mayaSpokeFor = now - mayaStreakStart;
              if (mayaSpokeFor >= SILENT_AVATAR_TRIP_MS && now - avatarLastAudibleAt >= SILENT_AVATAR_TRIP_MS) {
                onTelemetryRef.current?.("avatar.simli.silent_audio", { maya_spoke_ms: mayaSpokeFor });
                shutdown("avatar_audio_silent", "failed"); // raw voice unmutes, still photo returns
              }
            }, 500);
          }
        } catch {
          /* the watchdog is best-effort; never let it break the avatar */
        }
        onTelemetryRef.current?.("avatar.simli.started", {
          setup_ms: Date.now() - t0,
          max_seconds: data.max_seconds,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onTelemetryRef.current?.("avatar.simli.failed", { reason: msg.slice(0, 100) });
        shutdown(msg === "cancelled" ? "cancelled" : "start_failed", "failed");
      }
    })();

    return () => {
      cancelled = true;
    };
    // audioTrack is deliberately NOT a dependency: Simli now starts before Maya's track exists, and
    // re-running this effect when it arrives would cancel the start in progress. The track is wired in
    // by plugMayaIntoMixer (effect below) instead.
  }, [enabled, videoRef, audioRef, shutdown, plugMayaIntoMixer]);

  // Maya's GPT-Live track arrived (or the mixer just came up): connect it to what Simli listens to.
  useEffect(() => {
    plugMayaIntoMixer();
  });

  // Leaving the room / interview finishing / falling back to the standard engine: stop paying immediately.
  useEffect(() => {
    if (!enabled && startedRef.current) {
      shutdown("interview_ended", "off");
      startedRef.current = false;
    }
  }, [enabled, shutdown]);

  useEffect(() => {
    const onPageHide = () => shutdown("pagehide", "off");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      shutdown("unmount", "off");
    };
  }, [shutdown]);

  return { phase };
}
