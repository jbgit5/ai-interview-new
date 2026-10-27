// Regression tests for the GPT-Live interview engine's decision logic.
// Run:  npm run test:live
//
// These encode failures observed in REAL interviews (see docs/GPT-LIVE-EXPERIMENT.md §4e), so if a
// future change brings one back, this fails. They use only pure functions — no browser, DB or API
// calls, so they cost nothing and run in under a second.
import {
  deliveryRatio,
  trailsOff,
  shouldForceTurn,
  DELIVERED_THRESHOLD,
} from "../src/lib/live/turnTaking.ts";
import { diagnoseSession } from "../src/lib/diagnostics/diagnoseSession.ts";
import { buildNudgeEvent, buildSpokenEvent } from "../src/lib/live/events.ts";
import { buildLiveInstructions } from "../src/lib/live/instructions.ts";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failures++;
};

// ── 1. Did Maya actually say what we told her to? (measured on real spoken text) ──────────────
const ratio = deliveryRatio;
check(
  "paraphrased probe counts as delivered",
  ratio(
    "Could you elaborate on how the CSS box model, including elements like margin, border, padding, and content, impacts the layout of a webpage?",
    "Okay, let me ask the next question. Could you elaborate on how the CSS box model—like margins, borders, padding, and content—impact the layout of a webpage?"
  ) >= DELIVERED_THRESHOLD
);
check(
  "an INVENTED question is not delivered (she asked about accessibility instead of the bank question)",
  ratio(
    "What is your favorite JavaScript framework or library, and why do you prefer it over others?",
    "Sure. Got it. How do you ensure your web applications are accessible to all users, including those with disabilities?"
  ) < DELIVERED_THRESHOLD
);
check(
  "goodbye is NOT delivered when she asked a new question instead",
  ratio(
    "Thank you, das! That brings us to the end of our questions for today. We appreciate your time and will be in touch with next steps soon.",
    "All right, I'll just check in for the next one. Mm-hm. Can you talk about a time when you worked closely with designers or backend developers to deliver a feature?"
  ) < DELIVERED_THRESHOLD
);
check(
  "a paraphrased goodbye IS delivered",
  ratio(
    "Thank you, das! That brings us to the end of our questions for today. We appreciate your time and will be in touch with next steps soon.",
    "Thank you so much, das. That brings us to the end of our questions for today, and we appreciate your time. We'll be in touch with the next steps soon."
  ) >= DELIVERED_THRESHOLD
);

// ── 2. Don't wait for "that's all": we end the turn ourselves after a real silence ─────────────
const base = { baseMs: 4000, minWords: 4, trailExtraMs: 2500, mayaQuietNeededMs: 1500 };
const answers = [
  "CSS is flex, can be work for HTML and CSS. Even we can do it in the real time. Um, but some of them we can see. It's needed more like yeah. First, the first thing HTML can do that and CSS, flex, for for styling purpose",
  "Hmm. CSS box can do, but, and its different kind of things. Yeah, that's all",
  "Um, a result very easily Yeah. Yeah, that's all",
];
answers.forEach((text, i) => {
  check(`answer ${i + 1}: 4.5s of silence -> we end the turn`, shouldForceTurn({ ...base, text, silenceMs: 4500, mayaQuietMs: 9000 }).force);
  check(`answer ${i + 1}: a 1.5s pause -> keep listening`, !shouldForceTurn({ ...base, text, silenceMs: 1500, mayaQuietMs: 9000 }).force);
});
check("never ends a turn while Maya is speaking", !shouldForceTurn({ ...base, text: answers[1], silenceMs: 9000, mayaQuietMs: 300 }).force);
check("never ends a turn on noise (2 words)", !shouldForceTurn({ ...base, text: "uh yeah", silenceMs: 9000, mayaQuietMs: 9000 }).force);
check("an answer that trails off gets extra time", !shouldForceTurn({ ...base, text: "it is needed more like yeah", silenceMs: 4500, mayaQuietMs: 9000 }).force && trailsOff("it is needed more like yeah"));

// ── 3. Diagnostics recognise the whole failure signature of the bad interview ─────────────────
const t0 = Date.parse("2026-10-23T10:20:02Z");
const at = (s) => new Date(t0 + s * 1000).toISOString();
const ev = (s, event_name, attrs = {}, turn_index = null) => ({ occurred_at: at(s), source: "client", event_name, turn_index, attrs });
const turns = [
  { turn_index: 1, role: "interviewer", content: "Hello, welcome! I'm Maya... can you explain the box model in CSS?", created_at: at(5) },
  { turn_index: 3, role: "interviewer", content: "What is your favorite JavaScript framework or library, and why do you prefer it over others?", created_at: at(100) },
  { turn_index: 4, role: "interviewer", content: "Thank you, das! That brings us to the end of our questions for today. We appreciate your time and will be in touch with next steps soon.", created_at: at(262) },
];
const session = (done) => ({ status: "completed", exit_type: "normal", started_at: at(0), completed_at: at(done), integrity_score: 100 });

const bad = diagnoseSession({
  session: session(272), turns, proctor: [], ledger: { max_seconds: 300, usage_seconds: 272, close_reason: "complete" }, questionCount: 3,
  events: [
    ev(5, "live.session.started", { setup_ms: 5678 }),
    ev(47, "avatar.simli.started", { setup_ms: 5057 }),
    ev(50, "avatar.simli.stopped", { kind: "stop", since_start_ms: 43700, ws_close_code: 1000, ws_close_reason: "", last_messages: ["STOP"], ms_since_maya_audible: 26000 }),
    ev(110, "live.turn.delivery", { ratio: 0, delivered: false, nudged: true, spoken: "Sure. Got it. How do you ensure your web applications are accessible to all users?" }, 3),
    ev(120, "live.turn.forced", { silence_ms: 4300, words: 22 }, 3),
    ev(121, "live.turn.force_regret", { since_force_ms: 1800 }, 3),
    ev(262, "live.turn.completed", { action: "close", last_candidate_delta_to_commentary_ms: 9986 }, 4),
    ev(268, "live.closing.audio", { ended_by: "undelivered", delivered: false, delivery_ratio: 0.2, nudged: true, spoken: "All right, I'll just check in for the next one. Can you talk about a time when you worked with designers?" }, 4),
    ev(270, "live.session.closed", { reason: "complete", usage_seconds: 272 }, 4),
  ],
});
const titles = bad.issues.map((i) => i.title);
check("diagnostics: flags goodbye never said", titles.some((x) => /never said the goodbye/i.test(x)));
check("diagnostics: flags question not asked as intended", titles.some((x) => /didn't ask the intended question/i.test(x)));
check("diagnostics: flags avatar stopped by Simli, with evidence", bad.issues.some((i) => /stopped by Simli/i.test(i.title) && /STOP/.test(i.detail)));
check("diagnostics: flags candidate cut off", titles.some((x) => /cut off mid-thought/i.test(x)));
check("diagnostics: flags answers ended by our timer", titles.some((x) => /ended by our silence timer/i.test(x)));
check("diagnostics: verdict is 'serious problems'", bad.verdict.tone === "bad");

const good = diagnoseSession({
  session: session(200), turns, proctor: [], ledger: { max_seconds: 300, usage_seconds: 200, close_reason: "complete" }, questionCount: 8,
  events: [
    ev(5, "live.session.started", { setup_ms: 4000 }),
    ev(47, "avatar.simli.started", { setup_ms: 3000 }),
    ev(100, "live.turn.delivery", { ratio: 0.9, delivered: true, nudged: false }, 3),
    ev(262, "live.turn.completed", { action: "close", last_candidate_delta_to_commentary_ms: 3000 }, 4),
    ev(270, "live.closing.audio", { ended_by: "silence", delivered: true, delivery_ratio: 1, nudged: false }, 4),
    ev(271, "live.session.closed", { reason: "complete", usage_seconds: 200 }, 4),
  ],
});
check("diagnostics: a clean interview stays clean", good.verdict.tone === "ok", good.issues.map((i) => i.title).join("; "));

// ── 4. Round-2 lessons: Maya was ONE QUESTION BEHIND (asked the previous question each turn) ──
// Cause: (a) a client-sent "Mm-hm." commentary completed the delegation, so the real question that
// followed was not spoken; (b) the nudge used instructions.append, which is PERMANENT, so every nudge
// was replayed on the next turn.
const nudge = buildNudgeEvent("What is your favorite JavaScript framework?", "e1");
check("a nudge is a commentary.append (never instructions.append)", nudge.type === "session.commentary.append");
check("a nudge has no delegation id (the channel that reliably speaks the opening)", nudge.delegation_id === null);
check("a nudge is the bare line (no wrapper text Maya could read aloud)", nudge.content === "What is your favorite JavaScript framework?");
const result = buildSpokenEvent("deleg-1", "Describe a bug.", "e2");
check("the real reply carries the delegation id (it is that delegation's result)", result.delegation_id === "deleg-1" && result.type === "session.commentary.append");
check("long content is capped", buildSpokenEvent(null, "x".repeat(5000), "e3").content.length === 1800);

const hookSrc = readFileSync(new URL("../src/hooks/useLiveInterview.ts", import.meta.url), "utf8");
const codeOnly = hookSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // ignore comments
check("hook never SENDS session.instructions.append (permanent instructions caused stale questions)", !/["']session\.instructions\.append["']/.test(codeOnly));
check("hook never sends a client-side 'Mm-hm' commentary (it completed the delegation)", !/ACK_PHRASES|Mm-hm/.test(codeOnly));
check("fallback speech is plain speech, not an instruction Maya would read aloud", !/Politely ask|Apologise briefly/.test(codeOnly));

const instr = buildLiveInstructions({ jobTitle: "Frontend Developer" });
check('instructions never say "be patient with pauses" (it made her wait for "that\'s all")', !/patient with pauses/i.test(instr));
check("instructions tell her to ALWAYS say the backend reply, even after an acknowledgement", /ALWAYS say it/.test(instr));
check("instructions tell her to stay silent while waiting and never invent questions", /stay completely silent/i.test(instr) && /Never ask any question the backend did not give you/.test(instr));
check("instructions limit repeating a question to once", /ONCE/.test(instr));

// ── 5. Layout: the avatar block must never be squeezable (a long first question covered half the face) ──
const roomSrc = readFileSync(new URL("../src/app/interview/[token]/room/page.tsx", import.meta.url), "utf8");
// (Round 4 replaced the side panel with Meet-style tiles; these guard the new layout.)
check("Maya has her own full video tile (can't be squeezed by a long question)", /<Tile name="Maya/.test(roomSrc) && /variant="tile"/.test(roomSrc));
check("no avatar is drawn until the saved choice is known (no cartoon flash)", /serverInterviewerAvatar \? \(/.test(roomSrc));
check("debug side panel only renders in debug mode", /\{debugMode && \(\s*<div className="flex h-full min-h-0 w-80/.test(roomSrc));
check("debug logs only render in debug mode", /\{debugMode && \(\s*<div className="shrink-0 border-t border-white\/10 bg-gray-950">/.test(roomSrc));
check("integrity score is not shown to candidates outside debug mode", (roomSrc.split("Debug side panel")[0] ?? "").indexOf("{integrityScore}") === -1);

// ── 8. Avatar start: Simli starts at the Start click (before Maya's audio), placeholder until live ──
const simliSrc = readFileSync(new URL("../src/hooks/useSimliAvatar.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const startDeps = simliSrc.match(/\}, \[enabled, videoRef, audioRef, shutdown, plugMayaIntoMixer\]\)/);
check("Simli start effect does NOT depend on audioTrack (its arrival would cancel the start)", !!startDeps);
check("Simli start does not wait for Maya's audio track", /if \(!enabled \|\| startedRef\.current\) return;/.test(simliSrc));
const avatarSrc = readFileSync(new URL("../src/components/interview/MayaAvatar.tsx", import.meta.url), "utf8");
check("still photo is only a fallback (failed, or standard engine)", /showPhoto = !rendering && \(phase === "failed" \|\| \(started && !simli\?\.enabled\)\)/.test(avatarSrc));

// ── 6. Round-3 incident: "GPT-Live isn't enabled / no Simli avatar" ──────────────────────────────
// Real sequence: attempt 1 hit a network blip (live_session_502 … unreachable) and LEFT ITS LEDGER ROW OPEN;
// the retry 53 s later was refused (live_session_429 … concurrency_cap) because of that leftover row, so the
// room silently ran the standard engine — with no hint to the user as to why.
import { describeLiveFallback } from "../src/lib/live/fallbackReason.ts";
check("reason text: the network failure from the real log reads as 'check your internet'", /internet/i.test(describeLiveFallback("live_session_502:live_voice_unreachable")));
check("reason text: the retry refusal from the real log reads as a concurrency cap", /concurrency cap/i.test(describeLiveFallback("live_session_429:live_voice_concurrency_cap")));
check("reason text: budget / per-interview / disabled / timeout are all explained", [
  "live_session_429:live_voice_daily_budget",
  "live_session_429:live_voice_interview_cap",
  "live_session_403:live_voice_disabled",
  "live_session_504:live_voice_timeout",
].every((r) => describeLiveFallback(r) !== r));
check("reason text: an unknown reason is passed through unchanged (never hidden)", describeLiveFallback("something_new") === "something_new");

const routeSrc = readFileSync(new URL("../src/app/api/live/session/route.ts", import.meta.url), "utf8");
check("route: a fast network failure RELEASES the ledger row (reason 'unreachable')", /reason:\s*"unreachable"/.test(routeSrc) && /live_voice_unreachable/.test(routeSrc));
check("route: a timeout keeps the row open (the session may exist) and says so", /AbortError/.test(routeSrc) && /live_voice_timeout/.test(routeSrc));
const avatarRouteSrc = readFileSync(new URL("../src/app/api/avatar/simli/session/route.ts", import.meta.url), "utf8");
check("avatar route: same — fast failure releases the row, timeout keeps it", /reason:\s*"unreachable"/.test(avatarRouteSrc) && /avatar_timeout/.test(avatarRouteSrc));
const guardSrc = readFileSync(new URL("../src/lib/live/guardrails.ts", import.meta.url), "utf8");
check("ledger: a retry for the SAME interview supersedes its own abandoned row", /close_reason = 'superseded'/.test(guardSrc) && /interview_session_id = \$1 AND closed_at IS NULL/.test(guardSrc));
check("ledger: only attempts that created no real session are exempt from the per-interview limit", /NOT IN \('create_failed', 'no_sdp', 'unreachable'\)/.test(guardSrc));
check("room: the debug header always says which engine is running and why", /Engine: GPT-Live/.test(roomSrc) && /describeLiveFallback/.test(roomSrc));

// ── 7. Goodbye took 37.5 s to close: it waited for a Simli "silent" event that never comes ──
const goodbyeBlock = codeOnly.split("const awaitGoodbye")[1]?.split("const resolveStray")[0] ?? "";
check("goodbye close does not depend on Simli's speaking/silent events", !/avatarSpeakingRef|avatarSilentSinceRef/.test(goodbyeBlock));

// ── 9. Round 5: lag, frozen self-view, no recording, "I don't know" carried into the next question ──
import { shouldMergeLateSpeech, MAX_LATE_MERGES } from "../src/lib/live/turnTaking.ts";
// Real case: our silence timer took the answer, then "I don't know" arrived 40 ms before hand-off.
check("late 'I don't know' (2+ words) re-opens the CURRENT answer instead of going to the next question", shouldMergeLateSpeech("I don't know", 0));
check("a late 'mm' (noise) does not re-open the answer", !shouldMergeLateSpeech("mm", 0));
check("re-opening is capped (each costs a /turn call)", !shouldMergeLateSpeech("I don't know", MAX_LATE_MERGES));
check("hook re-opens the answer before handing Maya the next line", /shouldMergeLateSpeech\(lateSpeech/.test(codeOnly) && codeOnly.indexOf("shouldMergeLateSpeech(lateSpeech") < codeOnly.indexOf("setTurnIndexSynced(nextIdx)"));
const turnRouteSrc = readFileSync(new URL("../src/app/api/sessions/[token]/turn/route.ts", import.meta.url), "utf8");
check("server keeps ONE score per answer (a re-opened answer replaces its partial score)", /DELETE FROM question_scores WHERE session_id = \$1 AND turn_index = \$2/.test(turnRouteSrc));

const aiSrc = readFileSync(new URL("../src/hooks/useAiProctor.ts", import.meta.url), "utf8");
check("AI proctoring runs on CPU (GPU detection fought the video pipeline)", !/delegate: "GPU"/.test(aiSrc) && /delegate: "CPU"/.test(aiSrc));
check("AI proctoring waits before its first look (not during the busy start)", /setTimeout\(tick, DETECT_START_DELAY_MS\)/.test(aiSrc));
check("AI proctoring switches itself off if the machine is too slow", /stop\("too_slow"/.test(aiSrc));
check("?proctor=off disables AI proctoring for A/B comparison", /get\("proctor"\) === "off"/.test(aiSrc));
const recSrc = readFileSync(new URL("../src/hooks/useVideoRecorder.ts", import.meta.url), "utf8");
check("recorder prefers VP8 (VP9 software encoding is CPU-hungry)", /MIME_PREFERENCE = \["video\/webm;codecs=vp8,opus"/.test(recSrc));
check("recorder reports why it didn't start / failed (it used to fail silently)", /recorder\.not_started/.test(recSrc) && /recorder\.error/.test(recSrc));
check("camera is re-attached when the room screen appears (not only when the track arrives)", /\}, \[localVideoTrack, phase, mediaVersion\]\);/.test(roomSrc));
check("camera is opened by us as a user-provided track (LiveKit stops/re-opens its own on devicechange)", /publishTrack\(cam\.getVideoTracks\(\)\[0\]/.test(readFileSync(new URL("../src/hooks/useLiveKit.ts", import.meta.url), "utf8")));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
