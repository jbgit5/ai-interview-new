/**
 * k6 Load Test — AI Interview Platform
 * Tests: staged ramp 10 → 50 → 100 → 200 parallel interviews
 *
 * Run:
 *   k6 run scripts/load-test.js --env BASE_URL=http://localhost:3000
 *
 * Install k6: https://k6.io/docs/get-started/installation/
 *
 * Vendor limits to confirm BEFORE running at 200:
 *   LiveKit participant limit (Build plan: 100 max — need Scale plan for 200+)
 *   AssemblyAI session-start rate (free: 5/min, paid: 100+/min)
 *   Gladia live concurrency (paid: 30, enterprise: on-demand)
 *   OpenAI RPM/TPM for your account tier (check platform.openai.com/settings/organization/limits)
 *
 * Safe run order:
 *   1. smoke (1 VU, 2min) — verify the test itself works
 *   2. stage-25 (25 VUs) — first real concurrency check
 *   3. stage-50 → stage-100 → stage-200 — ramp only if previous stage passes
 *
 * Success thresholds:
 *   http_req_duration p95 < 3000ms for /turn
 *   http_req_duration p95 < 1000ms for /start
 *   http_req_failed   < 1%
 */

import http from "k6/http";
import { sleep, check } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

// ── Custom metrics ─────────────────────────────────────────────────────────
const turnLatency    = new Trend("turn_latency_ms", true);
const startLatency   = new Trend("start_latency_ms", true);
const speakLatency   = new Trend("speak_latency_ms", true);
const turnErrors     = new Rate("turn_error_rate");
const interviewsDone = new Counter("interviews_completed");

// ── Options ────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    smoke: {
      executor: "constant-vus",
      vus: 1,
      duration: "2m",
      tags: { scenario: "smoke" },
      env: { SCENARIO: "smoke" },
    },
    stage_25: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 25 },
        { duration: "2m",  target: 25 },
        { duration: "30s", target: 0  },
      ],
      tags: { scenario: "stage_25" },
      startTime: "3m",
      env: { SCENARIO: "stage_25" },
    },
    stage_50: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 50 },
        { duration: "3m",  target: 50 },
        { duration: "30s", target: 0  },
      ],
      tags: { scenario: "stage_50" },
      startTime: "9m",
      env: { SCENARIO: "stage_50" },
    },
    stage_100: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m",  target: 100 },
        { duration: "4m",  target: 100 },
        { duration: "1m",  target: 0   },
      ],
      tags: { scenario: "stage_100" },
      startTime: "16m",
      env: { SCENARIO: "stage_100" },
    },
    stage_200: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m",  target: 200 },
        { duration: "5m",  target: 200 },
        { duration: "2m",  target: 0   },
      ],
      tags: { scenario: "stage_200" },
      startTime: "26m",
      env: { SCENARIO: "stage_200" },
    },
  },
  thresholds: {
    // Turn API p95 must be under 3 seconds
    "turn_latency_ms{scenario:stage_200}": ["p(95)<3000"],
    // Start API p95 under 1 second
    "start_latency_ms{scenario:stage_200}": ["p(95)<1000"],
    // Error rate below 1%
    "turn_error_rate{scenario:stage_200}": ["rate<0.01"],
    // HTTP errors across all routes below 2%
    http_req_failed: ["rate<0.02"],
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

/**
 * Simulates one complete interview session (start → turns → end).
 * Uses a synthetic session token — in a real test environment you would
 * pre-seed the DB with valid tokens and pull from a shared-array data source.
 *
 * To use real tokens:
 *   import { SharedArray } from "k6/data";
 *   const tokens = new SharedArray("tokens", () => JSON.parse(open("./test-tokens.json")));
 *   const token = tokens[__VU % tokens.length];
 */
function runInterview(token) {
  const headers = {
    "Content-Type": "application/json",
    "x-session-token": token,
  };

  // 1. Start session
  const startRes = http.post(
    `${BASE_URL}/api/sessions/${token}/start`,
    "{}",
    { headers, tags: { endpoint: "start" } }
  );
  startLatency.add(startRes.timings.duration);
  check(startRes, { "start 200": (r) => r.status === 200 });

  if (startRes.status !== 200) return;

  sleep(0.5); // candidate sees the opening question

  // 2. Simulate 5 interview turns
  const sampleAnswers = [
    "I have about 4 years of experience with React and Node.js, mostly in fintech startups.",
    "In my last role I led a team of 3 engineers and we shipped a real-time notifications system.",
    "I would break the problem into smaller pieces, first identify the bottleneck then measure.",
    "I don't have direct experience with Kubernetes but I've worked with Docker Compose extensively.",
    "My biggest strength is communication — I keep stakeholders informed early when scope changes.",
  ];

  for (let i = 0; i < sampleAnswers.length; i++) {
    const turnRes = http.post(
      `${BASE_URL}/api/sessions/${token}/turn`,
      JSON.stringify({
        candidate_answer: sampleAnswers[i],
        turn_index: i + 1,
        timestamp_ms: Date.now(),
      }),
      { headers, tags: { endpoint: "turn" } }
    );

    turnLatency.add(turnRes.timings.duration);
    turnErrors.add(turnRes.status !== 200);
    check(turnRes, { "turn 200": (r) => r.status === 200 });

    if (turnRes.status !== 200) break;

    // Simulate TTS playback pause (candidate listens then answers)
    sleep(Math.random() * 4 + 3); // 3–7s think + speak time
  }

  // 3. End session
  const endRes = http.post(
    `${BASE_URL}/api/sessions/${token}/end`,
    JSON.stringify({ integrity_score: 95 }),
    { headers, tags: { endpoint: "end" } }
  );
  check(endRes, { "end 200": (r) => r.status === 200 });

  interviewsDone.add(1);
}

// ── Default function ───────────────────────────────────────────────────────
export default function () {
  // Each VU uses its own token index.
  // Replace with SharedArray tokens for real sessions.
  const token = `load-test-token-vu${__VU}-iter${__ITER}`;
  runInterview(token);
}
