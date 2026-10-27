"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { LocalVideoTrack } from "livekit-client";

/**
 * Watches the candidate's own camera tile. Added after an interview where the self-view froze, then
 * went blank, and no recording was saved — with no trace of why. It records:
 *  - camera.track_ended / camera.track_muted / camera.track_unmuted (the camera itself)
 *  - camera.frozen   — no new video frames for FROZEN_AFTER_MS while the interview runs
 *  - camera.recovered — frames flowing again (with how long it was frozen)
 * On a freeze it re-attaches the camera to the <video> element once (fixes a lost element binding).
 */

const FROZEN_AFTER_MS = 5_000;
const CHECK_EVERY_MS = 2_000;

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function useCameraHealth({
  videoRef,
  videoTrack,
  enabled,
  onTelemetry,
  mediaVersion = 0,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  videoTrack: LocalVideoTrack | null;
  enabled: boolean;
  onTelemetry?: (eventName: string, attrs?: Record<string, unknown>) => void;
  /** useLiveKit's mediaVersion: watch the new camera after a swap. */
  mediaVersion?: number;
}) {
  const telemetryRef = useRef(onTelemetry);
  telemetryRef.current = onTelemetry;

  // The camera track's own state changes.
  useEffect(() => {
    const t = videoTrack?.mediaStreamTrack;
    if (!t) return;
    const ended = () => telemetryRef.current?.("camera.track_ended", {});
    const muted = () => telemetryRef.current?.("camera.track_muted", {});
    const unmuted = () => telemetryRef.current?.("camera.track_unmuted", {});
    t.addEventListener("ended", ended);
    t.addEventListener("mute", muted);
    t.addEventListener("unmute", unmuted);
    return () => {
      t.removeEventListener("ended", ended);
      t.removeEventListener("mute", muted);
      t.removeEventListener("unmute", unmuted);
    };
  }, [videoTrack, mediaVersion]);

  // Frame watchdog on the self-view element.
  useEffect(() => {
    if (!enabled) return;
    const video = videoRef.current as VideoWithRvfc | null;
    if (!video || typeof video.requestVideoFrameCallback !== "function") return;

    let lastFrameAt = Date.now();
    let frozenSince = 0;
    let reattached = false;
    let handle = 0;
    let alive = true;
    const onFrame = () => {
      if (!alive) return;
      lastFrameAt = Date.now();
      handle = video.requestVideoFrameCallback!(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);

    const timer = setInterval(() => {
      if (document.hidden) return; // browsers pause video in hidden tabs; not a freeze
      const now = Date.now();
      const stalledMs = now - lastFrameAt;
      if (stalledMs >= FROZEN_AFTER_MS && !frozenSince) {
        frozenSince = now - stalledMs;
        const t = videoTrack?.mediaStreamTrack;
        telemetryRef.current?.("camera.frozen", {
          stalled_ms: stalledMs,
          track_state: t?.readyState ?? "none",
          track_muted: t?.muted ?? null,
          track_enabled: t?.enabled ?? null,
          video_ready_state: video.readyState,
          video_width: video.videoWidth,
          has_src: !!video.srcObject,
        });
        // One recovery attempt: rebind the camera to the element (cheap, harmless if not needed).
        if (!reattached && videoTrack && t?.readyState === "live") {
          reattached = true;
          try {
            videoTrack.detach(video);
            videoTrack.attach(video);
          } catch {
            /* ignore */
          }
        }
      } else if (stalledMs < FROZEN_AFTER_MS && frozenSince) {
        telemetryRef.current?.("camera.recovered", { frozen_ms: now - frozenSince, reattached });
        frozenSince = 0;
      }
    }, CHECK_EVERY_MS);

    return () => {
      alive = false;
      clearInterval(timer);
      try {
        video.cancelVideoFrameCallback?.(handle);
      } catch {
        /* ignore */
      }
    };
  }, [enabled, videoRef, videoTrack, mediaVersion]);
}
