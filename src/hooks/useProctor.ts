"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type ProctoringEventType =
  | "tab_switch"
  | "window_blur"
  | "window_focus"
  | "multi_face"
  | "no_face"
  | "gaze_away"
  | "paste_detected"
  | "right_click"
  | "devtools_open"
  | "fullscreen_exit"
  | "phone_detected";

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
}

const PENALTY: Record<ProctoringEventType, number> = {
  tab_switch:       10,
  window_blur:       5,
  window_focus:      0,
  multi_face:       15,
  no_face:           8,
  gaze_away:         3,
  paste_detected:    5,
  right_click:       2,
  devtools_open:    20,
  fullscreen_exit:   5,
  phone_detected:   20,
};

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
};

const MSG: Record<ProctoringEventType, string> = {
  tab_switch:       "You switched to another tab",
  window_blur:      "Interview window lost focus",
  window_focus:     "Window focused",
  multi_face:       "Multiple people detected",
  no_face:          "Face not visible — please stay in frame",
  gaze_away:        "Please look at the camera",
  paste_detected:   "Pasting text is not allowed",
  right_click:      "Right-click is disabled during the interview",
  devtools_open:    "Developer tools detected",
  fullscreen_exit:  "Please stay in fullscreen mode",
  phone_detected:   "Secondary device detected",
};

export function useProctor({ sessionToken, videoRef, enabled }: UseProctoringOptions) {
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
        }),
      });
    } catch {
      // Non-fatal — proctoring continues even if server is unreachable
    }
  }, [enabled, sessionToken]);

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
  };
}
