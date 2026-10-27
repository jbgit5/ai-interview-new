/**
 * Proctoring decision rules + integrity scoring. Pure (no browser / DB / React) so they are
 * regression-tested (tests/proctor.regression.mjs) and shared by the browser and the server.
 *
 * Philosophy (chosen with the recruiter): warn + record, never auto-end. So the rules are tuned to
 * avoid false positives — a candidate glancing at notes or thinking with their eyes up must NOT be
 * flagged; only sustained, unambiguous situations are.
 */

export type ProctorEventType =
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
  | "phone_detected"
  | "multiple_monitors";

/** Integrity points deducted per event. ONE table, used by the live in-room score and by the server. */
export const PENALTY: Record<ProctorEventType, number> = {
  tab_switch: 10,
  window_blur: 5,
  window_focus: 0,
  multi_face: 15,
  no_face: 8,
  gaze_away: 3,
  paste_detected: 5,
  right_click: 2,
  devtools_open: 20,
  fullscreen_exit: 5,
  phone_detected: 20,
  /** An extended desktop (second monitor) is not allowed — recruiter policy. */
  multiple_monitors: 15,
};

/** 100 minus penalties, floored at 0. Unknown event types cost nothing (never crash scoring). */
export function computeIntegrityScore(events: Array<{ event_type: string }>): number {
  let score = 100;
  for (const e of events) score -= PENALTY[e.event_type as ProctorEventType] ?? 0;
  return Math.max(0, Math.min(100, score));
}

/** One AI look at the candidate's camera. */
export interface FrameObservation {
  /** ms timestamp */
  t: number;
  /** faces found in the frame */
  faces: number;
  /** head turn left/right in degrees (absolute value is used), when exactly one face */
  yawDeg?: number | null;
  /** head tilt up/down in degrees (absolute value is used), when exactly one face */
  pitchDeg?: number | null;
  /** phone detector result for this frame; undefined when the phone detector didn't run */
  phone?: boolean;
}

export interface ProctorFinding {
  type: Extract<ProctorEventType, "no_face" | "multi_face" | "gaze_away" | "phone_detected">;
  meta: Record<string, unknown>;
}

export const RULES = {
  /** Nobody in frame this long (stepping away, camera covered). */
  NO_FACE_MS: 10_000,
  /** Two or more faces in this many consecutive looks (~1/s) — someone else in the room. */
  MULTI_FACE_STREAK: 3,
  /** Head turned beyond these angles … */
  YAW_LIMIT_DEG: 35,
  PITCH_LIMIT_DEG: 28,
  /** … continuously this long. A thinking glance away is a few seconds; reading something else isn't. */
  GAZE_AWAY_MS: 8_000,
  /** Phone seen in at least this many of the last PHONE_WINDOW phone checks. */
  PHONE_HITS: 2,
  PHONE_WINDOW: 3,
  /** The same violation type is not recorded again within this long (one episode = one event). */
  COOLDOWN_MS: 30_000,
  /**
   * Gaze is measured RELATIVE to this candidate's own "looking at the screen" pose: the median of the
   * first N single-face looks. This absorbs camera placement (a laptop camera above the screen makes
   * everyone look slightly down) and any axis-convention offset in the face model's pose output.
   */
  CALIBRATION_SAMPLES: 5,
} as const;

/** Smallest signed difference between two angles, in degrees (handles wrap-around at ±180°). */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Stateful debouncer: feed it observations in time order; it returns the findings to record.
 * Each rule fires once per episode and then waits for COOLDOWN_MS before it can fire again.
 */
export class ProctorRules {
  private noFaceSince = 0;
  private multiStreak = 0;
  private gazeAwaySince = 0;
  private phoneHistory: boolean[] = [];
  private lastFired: Partial<Record<ProctorFinding["type"], number>> = {};
  private calib: Array<{ yaw: number; pitch: number }> = [];
  private baseline: { yaw: number; pitch: number } | null = null;

  /** The calibrated "looking at the screen" pose, once known (for diagnostics). */
  get poseBaseline() {
    return this.baseline;
  }

  private fire(type: ProctorFinding["type"], t: number, meta: Record<string, unknown>, out: ProctorFinding[]) {
    const last = this.lastFired[type];
    if (last !== undefined && t - last < RULES.COOLDOWN_MS) return;
    this.lastFired[type] = t;
    out.push({ type, meta });
  }

  observe(o: FrameObservation): ProctorFinding[] {
    const out: ProctorFinding[] = [];

    // No face
    if (o.faces === 0) {
      if (!this.noFaceSince) this.noFaceSince = o.t;
      if (o.t - this.noFaceSince >= RULES.NO_FACE_MS) {
        this.fire("no_face", o.t, { absent_ms: o.t - this.noFaceSince }, out);
      }
    } else {
      this.noFaceSince = 0;
    }

    // Multiple faces
    if (o.faces >= 2) {
      this.multiStreak++;
      if (this.multiStreak >= RULES.MULTI_FACE_STREAK) this.fire("multi_face", o.t, { faces: o.faces }, out);
    } else {
      this.multiStreak = 0;
    }

    // Looking away (only with exactly one face and a pose estimate), measured from the calibrated baseline
    const hasPose = o.faces === 1 && typeof o.yawDeg === "number" && typeof o.pitchDeg === "number";
    if (hasPose && !this.baseline) {
      this.calib.push({ yaw: o.yawDeg as number, pitch: o.pitchDeg as number });
      if (this.calib.length >= RULES.CALIBRATION_SAMPLES) {
        this.baseline = { yaw: median(this.calib.map((c) => c.yaw)), pitch: median(this.calib.map((c) => c.pitch)) };
      }
    }
    const yaw = hasPose && this.baseline ? Math.abs(angleDiff(o.yawDeg as number, this.baseline.yaw)) : 0;
    const pitch = hasPose && this.baseline ? Math.abs(angleDiff(o.pitchDeg as number, this.baseline.pitch)) : 0;
    const away = hasPose && !!this.baseline && (yaw > RULES.YAW_LIMIT_DEG || pitch > RULES.PITCH_LIMIT_DEG);
    if (away) {
      if (!this.gazeAwaySince) this.gazeAwaySince = o.t;
      if (o.t - this.gazeAwaySince >= RULES.GAZE_AWAY_MS) {
        this.fire("gaze_away", o.t, { yaw_deg: Math.round(yaw), pitch_deg: Math.round(pitch), away_ms: o.t - this.gazeAwaySince }, out);
      }
    } else {
      this.gazeAwaySince = 0;
    }

    // Phone (only when the phone detector ran on this frame)
    if (o.phone !== undefined) {
      this.phoneHistory.push(o.phone);
      if (this.phoneHistory.length > RULES.PHONE_WINDOW) this.phoneHistory.shift();
      const hits = this.phoneHistory.filter(Boolean).length;
      if (hits >= RULES.PHONE_HITS) this.fire("phone_detected", o.t, { hits, window: this.phoneHistory.length }, out);
    }

    return out;
  }
}

/**
 * Head yaw/pitch (degrees) from MediaPipe's 4×4 facial transformation matrix (column-major).
 * The rules only use the DEVIATION from each candidate's calibrated baseline, so a constant offset
 * or sign convention in these angles cannot cause false "looking away" flags.
 */
export function headPoseFromMatrix(data: ArrayLike<number>): { yawDeg: number; pitchDeg: number } {
  const r20 = data[2], r21 = data[6], r22 = data[10];
  const toDeg = 180 / Math.PI;
  return {
    yawDeg: Math.atan2(-r20, Math.hypot(r21, r22)) * toDeg,
    pitchDeg: Math.atan2(r21, r22) * toDeg,
  };
}
