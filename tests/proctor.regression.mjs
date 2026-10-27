// Regression tests for the proctoring rules and integrity scoring.
// Run:  npm run test:proctor
// Pure functions only — no camera, browser or database needed.
import { ProctorRules, RULES, computeIntegrityScore, angleDiff, PENALTY } from "../src/lib/proctor/rules.ts";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failures++;
};
/** Feed one observation per second; return all findings with their second. */
const run = (frames, rules = new ProctorRules()) => {
  const out = [];
  frames.forEach((f, i) => rules.observe({ t: i * 1000, ...f }).forEach((x) => out.push({ s: i, ...x })));
  return out;
};
const looking = (n, pose = { yawDeg: 2, pitchDeg: -3 }) => Array.from({ length: n }, () => ({ faces: 1, ...pose }));

// ── Integrity score (server and room use the same table) ──
check("no events → 100", computeIntegrityScore([]) === 100);
check("tab switch + phone → 70", computeIntegrityScore([{ event_type: "tab_switch" }, { event_type: "phone_detected" }]) === 70);
check("score never goes below 0", computeIntegrityScore(Array(20).fill({ event_type: "devtools_open" })) === 0);
check("unknown event types cost nothing (scoring never crashes)", computeIntegrityScore([{ event_type: "something_new" }]) === 100);
check("window_focus is free", PENALTY.window_focus === 0);
check("a second monitor costs integrity points (not allowed)", PENALTY.multiple_monitors > 0);
{
  // Every event type the browser can send must be accepted by the route AND the DB constraint, or the
  // violation is silently lost (that is how a new type goes missing from reports).
  const { readFileSync, readdirSync } = await import("node:fs");
  const route = readFileSync(new URL("../src/app/api/sessions/[token]/proctor/route.ts", import.meta.url), "utf8");
  const migDir = new URL("../db/migrations/", import.meta.url);
  const latest = readdirSync(migDir).filter((f) => /proctor.*types|multiple_monitors/.test(f)).sort().pop();
  const mig = readFileSync(new URL(latest, migDir), "utf8");
  const missingRoute = Object.keys(PENALTY).filter((t) => !route.includes(`"${t}"`));
  const missingDb = Object.keys(PENALTY).filter((t) => !mig.includes(`'${t}'`));
  check("every proctor event type is accepted by the API route", missingRoute.length === 0, missingRoute.join(","));
  check(`every proctor event type is allowed by the DB constraint (${latest})`, missingDb.length === 0, missingDb.join(","));
  const hook = readFileSync(new URL("../src/hooks/useProctor.ts", import.meta.url), "utf8");
  check("second-monitor check is wired (screen.isExtended, once per transition)", hook.includes("typeof scr.isExtended") && hook.includes("wasExtended") && hook.includes('logViolation("multiple_monitors"'));
}

// ── No face ──
const absent9 = run([...looking(3), ...Array(9).fill({ faces: 0 }), ...looking(3)]);
check("away from camera 9 s → nothing", !absent9.some((f) => f.type === "no_face"));
const absent25 = run([...looking(3), ...Array(25).fill({ faces: 0 })]);
const nf = absent25.filter((f) => f.type === "no_face");
check("away 10 s+ → one no_face", nf.length === 1, JSON.stringify(nf.map((f) => f.s)));
check("one long absence is ONE event (cooldown), not one per second", nf.length === 1);

// ── Multiple faces ──
check("2 faces for 2 looks → nothing (someone walked past)", !run([...looking(3), { faces: 2 }, { faces: 2 }, ...looking(3)]).some((f) => f.type === "multi_face"));
check("2 faces for 3 looks → multi_face", run([...looking(3), { faces: 2 }, { faces: 2 }, { faces: 2 }]).some((f) => f.type === "multi_face"));

// ── Looking away — calibrated per candidate ──
check("a 5 s thinking glance away → nothing", !run([...looking(6), ...looking(5, { yawDeg: 50, pitchDeg: -3 }), ...looking(5)]).some((f) => f.type === "gaze_away"));
const longAway = run([...looking(6), ...looking(12, { yawDeg: 50, pitchDeg: -3 })]);
check("head turned away 8 s+ → gaze_away", longAway.some((f) => f.type === "gaze_away"), JSON.stringify(longAway));
// Laptop camera above the screen: this candidate's normal pose is 20° "down". Must NOT be flagged.
const camAbove = { yawDeg: 0, pitchDeg: -32 };
check("camera above the screen (constant -32° pitch) is NOT looking away", !run(looking(40, camAbove)).some((f) => f.type === "gaze_away"));
// Model reports 'straight ahead' as ~180° (axis convention) — wrap-around must not cause flags.
const flipped = Array.from({ length: 30 }, (_, i) => ({ faces: 1, yawDeg: i % 2 ? 179 : -179, pitchDeg: 178 }));
check("pose reported around ±180° (convention offset) is NOT looking away", !run(flipped).some((f) => f.type === "gaze_away"));
check("no gaze flags before calibration completes", !run([{ faces: 1, yawDeg: 80, pitchDeg: 0 }, { faces: 1, yawDeg: 80, pitchDeg: 0 }]).some((f) => f.type === "gaze_away"));
check("angleDiff wraps correctly (179 vs -179 = 2°)", Math.abs(angleDiff(179, -179) + 2) < 1e-9 || Math.abs(angleDiff(179, -179) - 2) < 1e-9);

// ── Phone ──
check("phone seen in 2 of 3 checks → phone_detected", run([{ faces: 1, phone: true }, { faces: 1, phone: false }, { faces: 1, phone: true }]).some((f) => f.type === "phone_detected"));
check("phone seen once (a glint) → nothing", !run([{ faces: 1, phone: true }, { faces: 1, phone: false }, { faces: 1, phone: false }]).some((f) => f.type === "phone_detected"));
check("frames where the phone detector didn't run don't count", !run([{ faces: 1, phone: true }, { faces: 1 }, { faces: 1 }, { faces: 1 }]).some((f) => f.type === "phone_detected"));

// ── Cooldown lets a NEW episode be recorded later ──
const twoEpisodes = run([...looking(2), ...Array(12).fill({ faces: 0 }), ...looking(30), ...Array(12).fill({ faces: 0 })]);
check("a second absence after the cooldown is recorded again", twoEpisodes.filter((f) => f.type === "no_face").length === 2);
check("rules are tuned to avoid false positives (documented thresholds)", RULES.NO_FACE_MS >= 10000 && RULES.GAZE_AWAY_MS >= 8000);

// ── Server: the integrity score is computed from recorded events, not trusted from the browser ──
const endSrc = readFileSync(new URL("../src/app/api/sessions/[token]/end/route.ts", import.meta.url), "utf8");
check("/end computes integrity from proctoring events (computeIntegrityScore)", /computeIntegrityScore/.test(endSrc));
check("/end no longer trusts body.integrity_score", !/body\.integrity_score/.test(endSrc));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
