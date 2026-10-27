"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { FaceLandmarker, ObjectDetector } from "@mediapipe/tasks-vision";
import { ProctorRules, headPoseFromMatrix, type ProctorFinding } from "@/lib/proctor/rules";

/**
 * In-browser AI proctoring (Google MediaPipe). Detects: nobody in frame, more than one person,
 * sustained looking away, and a phone in view. Runs entirely in the candidate's browser — no video
 * leaves the device and nothing is billed; only a small snapshot is uploaded when a violation is recorded.
 *
 * Built so it cannot break the interview:
 *  - Models are PRELOADED while the candidate is on the "Ready?" screen, not during the interview.
 *  - ~1 look per second (phone every 3 s), skipped while the tab is hidden; GPU with CPU fallback.
 *  - Any load failure or repeated detection errors → status "unavailable"; the caller then keeps
 *    its older lightweight checks (fail-open). Detection exceptions are always caught.
 *  - Decisions (how long, how many frames) live in the pure, tested ProctorRules.
 */

// Pinned to the installed @mediapipe/tasks-vision version; models are Google's official hosted files.
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const PHONE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite";

/**
 * Performance budget (round 5: an interview lagged, the candidate's camera froze and nothing was
 * recorded right after AI proctoring was added — GPU detection competes with video decode/encode):
 *  - CPU only (no WebGL context fighting the video pipeline),
 *  - detection starts DETECT_START_DELAY_MS after the interview starts (not during the busy start),
 *  - the interval backs off when a look is slow, and AI proctoring switches itself off if the
 *    machine can't keep up (the basic checks remain).
 */
const FACE_EVERY_MS = 1_500;
const SLOW_FACE_EVERY_MS = 3_000;
const PHONE_EVERY_MS = 6_000;
const DETECT_START_DELAY_MS = 20_000;
/** A single look slower than this makes us back off to SLOW_FACE_EVERY_MS. */
const SLOW_LOOK_MS = 120;
/** This many looks slower than TOO_SLOW_LOOK_MS → switch AI proctoring off for this interview. */
const TOO_SLOW_LOOK_MS = 400;
const MAX_TOO_SLOW_LOOKS = 3;
/** Give up (fail open) after this many consecutive detection errors. */
const MAX_CONSECUTIVE_ERRORS = 5;
const PERF_REPORT_EVERY_MS = 30_000;

/** `?proctor=off` on the interview link disables AI proctoring (basic checks stay) — for A/B comparison. */
function aiDisabledByUrl(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("proctor") === "off";
  } catch {
    return false;
  }
}

export type AiProctorStatus = "off" | "loading" | "ready" | "unavailable";

interface Options {
  videoRef: RefObject<HTMLVideoElement>;
  /** Start downloading the models (room is ready; candidate hasn't started yet). */
  preload: boolean;
  /** Run detection (interview in progress). */
  enabled: boolean;
  onFinding: (finding: ProctorFinding) => void;
  onTelemetry?: (eventName: string, attrs?: Record<string, unknown>) => void;
}

export function useAiProctor({ videoRef, preload, enabled, onFinding, onTelemetry }: Options) {
  const [status, setStatus] = useState<AiProctorStatus>("off");
  const faceRef = useRef<FaceLandmarker | null>(null);
  const phoneRef = useRef<ObjectDetector | null>(null);
  const loadStartedRef = useRef(false);
  const unmountedRef = useRef(false);
  const onFindingRef = useRef(onFinding);
  onFindingRef.current = onFinding;
  const onTelemetryRef = useRef(onTelemetry);
  onTelemetryRef.current = onTelemetry;

  // ── Load the models once, ahead of the interview ───────────────────────────
  useEffect(() => {
    if (!preload || loadStartedRef.current) return;
    loadStartedRef.current = true;
    if (aiDisabledByUrl()) {
      setStatus("unavailable");
      onTelemetryRef.current?.("proctor.ai.unavailable", { stage: "disabled_by_url" });
      return;
    }
    setStatus("loading");
    const t0 = Date.now();
    (async () => {
      try {
        // Loaded on demand: browser-only code, kept out of the initial page bundle.
        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
        // CPU delegate on purpose — see the performance budget note at the top of this file.
        const face = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: "CPU" },
          runningMode: "VIDEO",
          numFaces: 3,
          outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
        });
        // The phone detector is optional: face rules still work without it.
        let phone: ObjectDetector | null = null;
        try {
          phone = await vision.ObjectDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: PHONE_MODEL, delegate: "CPU" },
            runningMode: "VIDEO",
            scoreThreshold: 0.45,
            maxResults: 3,
            categoryAllowlist: ["cell phone"],
          });
        } catch {
          phone = null;
        }
        if (unmountedRef.current) {
          face.close();
          phone?.close();
          return;
        }
        faceRef.current = face;
        phoneRef.current = phone;
        setStatus("ready");
        onTelemetryRef.current?.("proctor.ai.ready", { load_ms: Date.now() - t0, phone_detector: !!phone });
      } catch (err) {
        if (unmountedRef.current) return;
        setStatus("unavailable");
        onTelemetryRef.current?.("proctor.ai.unavailable", {
          stage: "load",
          error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
        });
      }
    })();
  }, [preload]);

  // ── Detection loop while the interview runs ─────────────────────────────────
  useEffect(() => {
    if (!enabled || status !== "ready") return;
    const rules = new ProctorRules();
    let lastPhoneAt = 0;
    let lastTs = 0;
    let consecutiveErrors = 0;
    let everyMs = FACE_EVERY_MS;
    let tooSlow = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Performance stats, reported periodically so lag can be attributed (or ruled out).
    let looks = 0;
    let lookMsTotal = 0;
    let lookMsMax = 0;
    let lastReportAt = Date.now();

    const stop = (why: string, extra: Record<string, unknown> = {}) => {
      stopped = true;
      if (timer) clearTimeout(timer);
      setStatus("unavailable"); // caller falls back to its lightweight checks
      onTelemetryRef.current?.("proctor.ai.unavailable", { stage: why, ...extra });
    };

    const tick = () => {
      if (stopped) return;
      timer = setTimeout(tick, everyMs);
      if (document.hidden) return; // the tab-switch rule already covers this; save CPU
      const video = videoRef.current;
      const face = faceRef.current;
      if (!video || !face || video.readyState < 2 || video.videoWidth === 0) return;
      // MediaPipe requires strictly increasing timestamps per task.
      const ts = Math.max(performance.now(), lastTs + 1);
      lastTs = ts;
      const t0 = performance.now();
      try {
        const res = face.detectForVideo(video, ts);
        const faces = res.faceLandmarks?.length ?? 0;
        const matrix = faces === 1 ? res.facialTransformationMatrixes?.[0]?.data : undefined;
        const pose = matrix ? headPoseFromMatrix(matrix) : { yawDeg: null, pitchDeg: null };

        let phone: boolean | undefined;
        if (phoneRef.current && Date.now() - lastPhoneAt >= PHONE_EVERY_MS) {
          lastPhoneAt = Date.now();
          const det = phoneRef.current.detectForVideo(video, ts);
          phone = (det.detections ?? []).some((d) =>
            (d.categories ?? []).some((c) => c.categoryName === "cell phone")
          );
        }

        consecutiveErrors = 0;
        for (const finding of rules.observe({ t: Date.now(), faces, ...pose, phone })) {
          onFindingRef.current(finding);
        }

        // Self-throttle: never let proctoring make the interview laggy.
        const ms = performance.now() - t0;
        looks++;
        lookMsTotal += ms;
        lookMsMax = Math.max(lookMsMax, ms);
        if (ms > SLOW_LOOK_MS) everyMs = SLOW_FACE_EVERY_MS;
        if (ms > TOO_SLOW_LOOK_MS && ++tooSlow >= MAX_TOO_SLOW_LOOKS) {
          stop("too_slow", { look_ms: Math.round(ms) });
          return;
        }
        if (Date.now() - lastReportAt >= PERF_REPORT_EVERY_MS) {
          onTelemetryRef.current?.("proctor.ai.perf", {
            looks,
            avg_ms: Math.round(lookMsTotal / looks),
            max_ms: Math.round(lookMsMax),
            every_ms: everyMs,
          });
          lastReportAt = Date.now();
          looks = 0;
          lookMsTotal = 0;
          lookMsMax = 0;
        }
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          stop("detect", { error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
        }
      }
    };

    // Don't add load during the busy interview start (voice + avatar connecting).
    timer = setTimeout(tick, DETECT_START_DELAY_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, status, videoRef]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      try { faceRef.current?.close(); } catch { /* ignore */ }
      try { phoneRef.current?.close(); } catch { /* ignore */ }
      faceRef.current = null;
      phoneRef.current = null;
    };
  }, []);

  return { status };
}
