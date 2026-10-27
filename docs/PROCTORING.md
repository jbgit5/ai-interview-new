# Proctoring

Warn + record, never auto-end: the candidate sees a short warning, the event is stored (with a camera
snapshot for camera-based events), the integrity score drops, and the recruiter decides afterwards.

## What is detected

| Event | How | When it fires (`src/lib/proctor/rules.ts`) | Penalty |
|---|---|---|---|
| `no_face` | AI face model (MediaPipe FaceLandmarker) | nobody in frame ≥ 10 s | 8 |
| `multi_face` | AI face model | ≥ 2 faces in 3 consecutive looks (~1/s) | 15 |
| `gaze_away` | AI head pose, **relative to the candidate's own calibrated pose** (median of their first 5 looks) | turned > 35° or tilted > 28° from that pose for ≥ 8 s | 3 |
| `phone_detected` | AI object detector (EfficientDet-Lite0, COCO "cell phone") every 3 s | phone in 2 of the last 3 checks | 20 |
| `tab_switch` / `window_blur` | browser events | immediately | 10 / 5 |
| `fullscreen_exit` | browser event (fullscreen is requested on Start) | immediately | 5 |
| `multiple_monitors` | `screen.isExtended` (Chrome/Edge, no permission prompt) — checked at start, on display change, and every 5 s | once each time the desktop becomes extended (a 2nd monitor is not allowed). Firefox/Safari can't expose this; recorded as telemetry `proctor.monitors.unsupported` | 15 |
| `paste_detected` / `right_click` / `devtools_open` | browser events + window-size heuristic | immediately | 5 / 2 / 20 |

Each type fires once per episode, then waits 30 s (cooldown). Thresholds are deliberately
conservative: a thinking glance, a laptop camera above the screen, or a short absence is never flagged.

## How it runs (and why it can't break the interview)

- `useAiProctor` loads the models from Google's hosted files (WASM from jsDelivr, pinned to the
  installed `@mediapipe/tasks-vision` version) **while the candidate is on the "Ready?" screen**.
- ~1 look/second in the candidate's browser; skipped while the tab is hidden; GPU with CPU fallback.
- If the models can't load (blocked CDN, old browser) or detection errors 5× in a row → status
  `unavailable` and the older pixel heuristics take over (fail-open). Debug mode shows the status.
- No video leaves the browser. Only a 320 px JPEG snapshot is uploaded **when a camera-based
  violation is recorded** (max 60 per interview, JPEG-validated, ≤ 150 KB) to
  `recordings/<sessionId>/proctor/`. Make sure your candidate consent text mentions this.

## Integrity score

`computeIntegrityScore` (same file) = 100 − penalties, floored at 0. It is used by the live room,
by `/api/sessions/[token]/end` (which now computes and stores it from the recorded events — the
browser-sent value is ignored), and by the report. Previously the stored score was always 100.

## Where to see it

- Report → Proctoring panel: grouped events, integrity score, **Evidence** thumbnails
  (`/api/proctor/snapshot/[eventId]`, recruiter-only).
- Dashboard → Diagnostics: proctoring events on the timeline.

## Tests

`npm run test:proctor` — rules, calibration (camera above the screen, ±180° pose conventions),
cooldowns, phone voting, scoring, and that `/end` no longer trusts the browser's score.

## Migrations

`017_proctor_snapshots.sql` (snapshot path). Without it events are still recorded, just without images.
