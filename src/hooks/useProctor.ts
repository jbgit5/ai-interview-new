"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { PENALTY, type ProctorEventType } from "@/lib/proctor/rules";
import { useAiProctor, type AiProctorStatus } from "@/hooks/useAiProctor";

export type ProctoringEventType = ProctorEventType;

/** Camera-based violations get a snapshot as evidence for the recruiter. */
const SNAPSHOT_TYPES = new Set<ProctoringEventType>(["no_face", "multi_face", "gaze_away", "phone_detected"]);
const SNAPSHOT_WIDTH = 320;

export type ProctoringViolation = {
  id: string;
  type: ProctoringEventType;
  message: string;
  timestamp: number; // ms since interview started
  severity: "low" | "medium" | "high";
};

export type FocusStatus = "focused" | "blurred" | "tab_hidden";

interface UseProctoringOptions {
  sessionToken: string;
  videoRef: React.RefObject<HTMLVideoElement>;
  enabled: boolean;
  /** Room is ready (candidate on the "Ready?" screen): start downloading the AI models now. */
  aiPreload?: boolean;
  onTelemetry?: (eventName: string, attrs?: Record<string, unknown>) => void;
}

// PENALTY now comes from src/lib/proctor/rules.ts — the same table the server uses to compute the
// final integrity score, so the live number and the stored one can't drift apart.

const SEVERITY: Record<ProctoringEventType, "low" | "medium" | "high"> = {
  tab_switch:       "medium",
  window_blur:      "low",
  window_focus:     "low",
  multi_face:       "high",
  no_face:          "medium",
  gaze_away:        "low",
  paste_detected:   "low",
  right_click:      "low",
  devtools_open:    "high",
  fullscreen_exit:  "medium",
  phone_detected:   "high",
  multiple_monitors: "high",
};

const MSG: Record<ProctoringEventType, string> = {
  tab_switch:       "You switched to another tab",
  window_blur:      "Interview window lost focus",
  window_focus:     "Window focused",
  multi_face:       "Multiple people detected",
  no_face:          "Face not visible — please stay in frame",
  gaze_away:        "Please keep looking at the screen",
  paste_detected:   "Pasting text is not allowed",
  right_click:      "Right-click is disabled during the interview",
  devtools_open:    "Developer tools detected",
  fullscreen_exit:  "Please stay in fullscreen mode",
  phone_detected:   "Secondary device detected",
  multiple_monitors: "A second monitor was detected — please disconnect extra displays",
};

/** A small JPEG of the candidate's camera at this moment, or undefined if unavailable. */
function captureSnapshot(video: HTMLVideoElement | null): string | undefined {
  try {
    if (!video || video.readyState < 2 || !video.videoWidth) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = SNAPSHOT_WIDTH;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * SNAPSHOT_WIDTH);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  }
}

export function useProctor({ sessionToken, videoRef, enabled, aiPreload = false, onTelemetry }: UseProctoringOptions) {
  const [integrityScore, setIntegrityScore] = useState(100);
  const [violations, setViolations] = useState<ProctoringViolation[]>([]);
  const [activeWarning, setActiveWarning] = useState<ProctoringViolation | null>(null);
  const [focusStatus, setFocusStatus] = useState<FocusStatus>("focused");

  const startTimeRef = useRef(Date.now());
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const faceCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noFaceCountRef = useRef(0);
  const phoneCountRef = useRef(0);
  const devtoolsRef = useRef(false);

  const logViolation = useCallback(async (type: ProctoringEventType, meta?: Record<string, unknown>) => {
    if (!enabled) return;

    const timestampMs = Date.now() - startTimeRef.current;
    const severity = SEVERITY[type];
    const penalty = PENALTY[type];
    const message = MSG[type];

    const violation: ProctoringViolation = {
      id: `${type}-${timestampMs}`,
      type,
      message,
      timestamp: timestampMs,
      severity,
    };

    setIntegrityScore((prev) => Math.max(0, prev - penalty));
    setViolations((prev) => [...prev, violation]);

    // Show warning overlay (auto-dismiss after 4s)
    setActiveWarning(violation);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    warningTimerRef.current = setTimeout(() => setActiveWarning(null), 4000);

    // Evidence: a snapshot of the camera for camera-based violations.
    const snapshot = SNAPSHOT_TYPES.has(type) ? captureSnapshot(videoRef.current) : undefined;

    // Send to server (non-blocking)
    try {
      await fetch(`/api/sessions/${sessionToken}/proctor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: type,
          timestamp_ms: timestampMs,
          severity,
          metadata: meta ?? {},
          ...(snapshot ? { snapshot } : {}),
        }),
      });
    } catch {
      // Non-fatal — proctoring continues even if server is unreachable
    }
  }, [enabled, sessionToken, videoRef]);

  // ── AI detection (face / people / looking away / phone) ────────────────────
  const { status: aiStatus } = useAiProctor({
    videoRef,
    preload: aiPreload || enabled,
    enabled,
    onFinding: (f) => void logViolation(f.type, { ...f.meta, source: "ai" }),
    onTelemetry,
  });
  const aiStatusRef = useRef<AiProctorStatus>(aiStatus);
  aiStatusRef.current = aiStatus;

  // ── Tab/window visibility ──────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    let firstFocus = true;
    const onVisibilityChange = () => {
      if (document.hidden) {
        setFocusStatus("tab_hidden");
        logViolation("tab_switch");
      } else {
        setFocusStatus("focused");
      }
    };
    const onBlur = () => {
      if (firstFocus) { firstFocus = false; return; } // ignore initial focus
      setFocusStatus("blurred");
      logViolation("window_blur");
    };
    const onFocus = () => {
      setFocusStatus("focused");
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, logViolation]);

  // ── Extended desktop (second monitor) ──────────────────────────────────────
  // Chromium (Chrome, Edge) exposes `screen.isExtended` without a permission prompt. Checked when the
  // interview starts, whenever the display setup changes, and every 5 s as a backstop; ONE violation
  // per "became extended" transition (not one per poll). Firefox/Safari don't expose it, so there it
  // can't be detected — recorded once as telemetry so the recruiter knows the check didn't run.
  useEffect(() => {
    if (!enabled) return;
    const scr = window.screen as unknown as EventTarget & { isExtended?: boolean };
    if (typeof scr.isExtended !== "boolean") {
      onTelemetry?.("proctor.monitors.unsupported", {});
      return;
    }
    let wasExtended = false;
    const check = () => {
      const now = scr.isExtended === true;
      if (now && !wasExtended) logViolation("multiple_monitors", { source: "screen.isExtended" });
      wasExtended = now;
    };
    check();
    scr.addEventListener("change", check);
    const poll = setInterval(check, 5000);
    return () => {
      scr.removeEventListener("change", check);
      clearInterval(poll);
    };
  }, [enabled, logViolation, onTelemetry]);

  // ── Paste detection ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      logViolation("paste_detected");
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [enabled, logViolation]);

  // ── Right-click ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      logViolation("right_click");
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [enabled, logViolation]);

  // ── Keyboard shortcuts that might open devtools ────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const isDevTools =
        e.key === "F12" ||
        (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key)) ||
        (e.ctrlKey && e.key === "U");
      if (isDevTools) {
        e.preventDefault();
        logViolation("devtools_open");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, logViolation]);

  // ── DevTools size-based detection ─────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      const widthThreshold = window.outerWidth - window.innerWidth > 160;
      const heightThreshold = window.outerHeight - window.innerHeight > 160;
      if ((widthThreshold || heightThreshold) && !devtoolsRef.current) {
        devtoolsRef.current = true;
        logViolation("devtools_open");
      } else if (!widthThreshold && !heightThreshold) {
        devtoolsRef.current = false;
      }
    };
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, [enabled, logViolation]);

  // ── Fullscreen exit ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        logViolation("fullscreen_exit");
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [enabled, logViolation]);

  // ── Face detection via canvas pixel analysis ───────────────────────────────
  // Uses skin-tone pixel ratio as a lightweight proxy (no ML model needed)
  useEffect(() => {
    if (!enabled || !videoRef.current) return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = 80;
    canvas.height = 60;

    faceCheckIntervalRef.current = setInterval(() => {
      // These pixel heuristics are only the FALLBACK: while the AI detector is running it owns
      // face / phone detection (the skin-tone and bright-patch guesses are unreliable).
      if (aiStatusRef.current === "ready") return;
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      ctx.drawImage(video, 0, 0, 80, 60);
      const data = ctx.getImageData(0, 0, 80, 60).data;

      let skinPixels = 0;
      let totalPixels = 0;

      // Divide frame into a 2×2 grid of quadrants to detect localised brightness.
      // A phone screen = one quadrant very bright while others are not.
      // A bright window/background = ALL quadrants bright equally → NOT a phone.
      const W = 80, H = 60;
      const qBright = [0, 0, 0, 0]; // bright pixel count per quadrant [TL, TR, BL, BR]
      const qTotal  = [0, 0, 0, 0];

      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const i = (py * W + px) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          totalPixels++;

          // Skin tone detection (rough range)
          if (r > 95 && g > 40 && b > 20 &&
              r > g && r > b &&
              Math.max(r, g, b) - Math.min(r, g, b) > 15 &&
              Math.abs(r - g) > 15) {
            skinPixels++;
          }

          const qi = (py < H / 2 ? 0 : 2) + (px < W / 2 ? 0 : 1);
          qTotal[qi]++;
          if (r > 220 && g > 220 && b > 220) qBright[qi]++;
        }
      }

      const skinRatio = skinPixels / totalPixels;

      // Per-quadrant bright ratios
      const qRatios = qBright.map((b, i) => b / qTotal[i]);
      const maxQ = Math.max(...qRatios);
      const otherAvg = qRatios.reduce((s, v) => (v === maxQ ? s : s + v), 0) / 3;

      // Phone heuristic: ONE quadrant is significantly brighter than the rest.
      // Stricter thresholds + 6 hits @ 5s reduce false "secondary device" from lamps / windows.
      const phoneHit =
        maxQ > 0.58 &&
        otherAvg < 0.08 &&
        maxQ - otherAvg > 0.42;

      // skinRatio < 0.01 = almost completely absent from frame (not just looking sideways).
      // Requires 6 consecutive detections at 5s interval = 30 continuous seconds before flagging.
      // This prevents false positives when candidate glances at the chat or looks slightly away.
      if (skinRatio < 0.01) {
        noFaceCountRef.current++;
        if (noFaceCountRef.current >= 5) {
          logViolation("no_face", { skinRatio });
          noFaceCountRef.current = 0;
        }
      } else {
        noFaceCountRef.current = 0;
      }

      if (phoneHit) {
        phoneCountRef.current = (phoneCountRef.current ?? 0) + 1;
        if (phoneCountRef.current >= 6) {
          logViolation("phone_detected", { maxQ: +maxQ.toFixed(3), otherAvg: +otherAvg.toFixed(3) });
          phoneCountRef.current = 0;
        }
      } else {
        phoneCountRef.current = 0;
      }
    }, 5000); // check every 5 seconds

    return () => {
      if (faceCheckIntervalRef.current) clearInterval(faceCheckIntervalRef.current);
    };
  }, [enabled, videoRef, logViolation]);

  // Cleanup warning timer on unmount
  useEffect(() => {
    return () => {
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    };
  }, []);

  const dismissWarning = useCallback(() => setActiveWarning(null), []);

  return {
    integrityScore,
    violations,
    activeWarning,
    dismissWarning,
    focusStatus,
    /** "ready" = AI detection running; "unavailable" = fell back to the lightweight checks. */
    aiStatus,
  };
}
