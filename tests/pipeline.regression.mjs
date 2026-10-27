// Regression tests for the pipeline interview engine (the default voice engine).
// Run:  npm run test:pipeline
//
// Pure logic + source guards only: no browser, DB or paid API calls. Each case encodes a requirement
// from real interviews ("no 10 s dead air", "don't cut me off when I pause after 'and'",
// "captions must not run ahead of Maya's voice", "a reply for a superseded answer must not be saved").
import {
  decideCommit,
  isUnfinished,
  isRepeatRequest,
  isAnswerRequest,
  ANSWER_REQUEST_REPLY,
  shouldAck,
  stripLeadingAck,
  isAckEcho,
  pickAck,
  ACK_LINES,
  QUIET_AFTER_ENDPOINT_MS,
} from "../src/lib/pipeline/endOfTurn.ts";
import { pcm16ToFloat } from "../src/lib/pipeline/mayaVoice.ts";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failures++;
};

/**
 * Replay a candidate's speech as Deepgram would report it and return when we commit (ms after the
 * last spoken word), or null if we never commit within `untilMs`.
 * segments: [{ at, text, final, speechFinal }] — times in ms from turn start. `vad` = SpeechStarted times.
 */
function replay(segments, { untilMs = 15_000, tick = 100, vad = [], finalizeAnswersInMs = null, loud = undefined } = {}) {
  // loud: [[from, to], …] — when the candidate's mic is at speech level (undefined = no meter).
  const lastLoudAtFor = (now) =>
    loud === undefined ? undefined : Math.max(0, ...loud.filter(([a]) => a <= now).map(([, b]) => Math.min(b, now)));
  segments = segments.map((s) => ({ ...s }));
  let finalText = "", interimText = "", lastTextAt = 0, lastEndpointAt = 0, lastVadAt = 0;
  let si = 0, vi = 0, finalizeRequested = false, finalizedAt = null;
  for (let now = 0; now <= untilMs; now += tick) {
    while (si < segments.length && segments[si].at <= now) {
      const s = segments[si++];
      if (s.utteranceEnd) { lastEndpointAt = s.at; continue; }
      if (s.final) {
        finalText = `${finalText} ${s.text}`.trim();
        interimText = "";
        lastTextAt = s.at;
        if (s.speechFinal || finalizeRequested) lastEndpointAt = s.at;
        finalizeRequested = false;
      } else {
        if (s.text === interimText) continue; // a repeat is not new speech (same rule as the hook)
        interimText = s.text;
        lastTextAt = s.at;
        finalizeRequested = false;
      }
    }
    while (vi < vad.length && vad[vi] <= now) lastVadAt = vad[vi++];
    const d = decideCommit({ now, finalText, interimText, lastTextAt, lastEndpointAt, lastVadAt, lastLoudAt: lastLoudAtFor(now) });
    if (d.commit) return { at: now, reason: d.reason, text: d.text, finalizedAt };
    if (d.finalize && !finalizeRequested && finalizeAnswersInMs != null) {
      // Deepgram answers a Finalize with the pending words as a final, and then has nothing pending
      // (the repeats and its own late final for those words never come).
      finalizeRequested = true;
      finalizedAt = now;
      // (Deepgram's smart_format punctuates finals.)
      const finalised = /[.!?]$/.test(interimText) ? interimText : `${interimText}.`;
      segments = segments.slice(0, si).concat([{ at: now + finalizeAnswersInMs, text: finalised, final: true }]);
    }
  }
  return null;
}

// Deepgram sends speech_final ~520 ms after the last word (our endpointing setting).
const EP = 520;

// ── 1. A normal answer is taken quickly (the old engine waited 7.2 s + 4.8 s) ──────────────────
{
  const lastWord = 4_000;
  const r = replay([
    { at: 1_000, text: "I would use", final: false },
    { at: 2_500, text: "I would use Redis for caching", final: false },
    { at: lastWord + EP, text: "I would use Redis for caching the sessions.", final: true, speechFinal: true },
  ]);
  const after = r ? r.at - lastWord : null;
  check("finished sentence is taken 2.0–2.8 s after the last word (not sooner)", r && after >= 2_000 && after <= 2_800 && r.reason === "endpoint", `(${after} ms, ${r?.reason})`);
}

// ── 2. Thinking pause after "and" is NOT cut off ───────────────────────────────────────────────
{
  const r = replay([
    { at: 3_000, text: "First I'd profile the query and", final: true, speechFinal: true },
    // 2 s pause (thinking), then continues
    { at: 5_000, text: "then add an index", final: false },
    { at: 6_200, text: "then add an index on the user id.", final: true, speechFinal: true },
  ]);
  check("pause after a trailing 'and' keeps listening", r && r.text.includes("index on the user id"), `(${r?.at} ms)`);
}

// ── 3. A finished sentence + 1.2 s pause IS committed (the late-merge covers a resume) ──────────
{
  const r = replay([{ at: 2_000, text: "That's how I handled it.", final: true, speechFinal: true }], { untilMs: 2_000 + QUIET_AFTER_ENDPOINT_MS + 200 });
  check("finished sentence commits after the short quiet window", !!r && r.reason === "endpoint");
}

// ── 4. No end-of-speech flag from Deepgram (noisy room): fall back to plain silence ─────────────
{
  const r = replay([{ at: 2_000, text: "I think microservices.", final: true }]);
  check("commits on silence when no endpoint arrives (3 s)", r && r.reason === "silence" && r.at - 2_000 >= 3_000 && r.at - 2_000 <= 3_200, `(${r?.at})`);
}

// ── 5. Interim text that never finalises doesn't hang the interview ──────────────────────────
{
  const r = replay([{ at: 1_000, text: "um so basically the", final: false }]);
  check("stale interim is committed (no stuck turn)", r && r.reason === "stale_interim", `(${r?.at})`);
}

// ── 6. VAD says speech started again → hold, but a noise blip can't hold forever ─────────────
{
  const held = replay([{ at: 2_000, text: "Yes, I have.", final: true, speechFinal: true }], { vad: [2_700], untilMs: 3_400 });
  check("fresh VAD speech-start holds the commit", held === null);
  const later = replay([{ at: 2_000, text: "Yes, I have.", final: true, speechFinal: true }], { vad: [2_700] });
  check("…but only briefly (noise can't block the turn)", later && later.at <= 2_700 + 1_600, `(${later?.at})`);
}

// ── 7. UtteranceEnd counts as end of speech ──────────────────────────────────────────────────
{
  const r = replay([{ at: 2_000, text: "We used Postgres.", final: true }, { at: 3_000, utteranceEnd: true }]);
  check("UtteranceEnd counts as end of speech (commit 1.8 s after it)", r && r.reason === "endpoint" && r.at >= 4_700 && r.at <= 4_900, `(${r?.at})`);
}

// ── 7b. REAL RUN (e2e, 2026-10-25): Deepgram re-sent the same unfinished phrase for ~5 s after the
//        candidate stopped, so the answer was taken 7 s late. Repeats must not count as speech, and we
//        ask Deepgram to finalise.
{
  // While talking, Deepgram sends a growing interim every ~0.5 s; after the last word it repeats it.
  const words = "that cut our load time roughly in half".split(" ");
  const lastChange = 2_000 + (words.length - 1) * 500;
  const speaking = words.map((_, i) => ({ at: 2_000 + i * 500, text: words.slice(0, i + 1).join(" "), final: false }));
  const repeats = [];
  for (let at = lastChange + 500; at < lastChange + 5_000; at += 500) repeats.push({ at, text: words.join(" "), final: false });
  const segs = [
    ...speaking,
    ...repeats,
    { at: lastChange + 5_200, text: `${words.join(" ")}.`, final: true, speechFinal: true },
  ];
  const r = replay(segs, { finalizeAnswersInMs: 250 });
  check("repeated unfinished text doesn't hold the turn: Finalize → taken 2.5–3.5 s after the last new word", r && r.at - lastChange >= 2_500 && r.at - lastChange <= 3_500 && r.reason === "endpoint" && r.text.includes("in half"),`(${r ? r.at - lastChange : "never"} ms, finalize at +${r?.finalizedAt != null ? r.finalizedAt - lastChange : "?"} ms)`);
  const noFinalize = replay(segs);
  check("…and even if Finalize does nothing, the stale-text safety net takes it at ~4 s", noFinalize && noFinalize.at - lastChange >= 3_900 && noFinalize.at - lastChange <= 4_100 && noFinalize.text.includes("in half"),`(${noFinalize ? noFinalize.at - lastChange : "never"} ms, ${noFinalize?.reason})`);
}

// ── 7c. REAL RUN (e2e #3): Deepgram's updates paused 1.6 s while the candidate was STILL TALKING; the
//        transcript-only rule finalised and took the answer mid-sentence. The mic level must prevent it.
{
  const speechEnd = 7_000;
  const segs = [
    { at: 1_000, text: "I look at", final: false },
    { at: 2_000, text: "I look at bundle size", final: false },
    { at: 3_000, text: "I look at bundle size lazy loading", final: false },
    // ── 1.6 s with no update from Deepgram, candidate still talking ──
    { at: 4_600, text: "I look at bundle size lazy loading and unnecessary", final: false },
    { at: 5_600, text: "I look at bundle size lazy loading and unnecessary re-renders that cut", final: false },
    { at: 6_800, text: "I look at bundle size lazy loading and unnecessary re-renders that cut load time in half", final: false },
    { at: speechEnd + 520, text: "I look at bundle size, lazy loading and unnecessary re-renders. That cut load time in half.", final: true, speechFinal: true },
  ];
  const r = replay(segs, { finalizeAnswersInMs: 250, loud: [[900, speechEnd]] });
  check("mid-sentence recogniser pause (mic still loud) does NOT end the answer", r && r.at > speechEnd && r.text.includes("in half"), `(taken ${r ? r.at - speechEnd : "never"} ms after speech ended)`);
  check("…and the answer is still taken once they stop (≤ 2.6 s)", r && r.at - speechEnd <= 2_600, `(${r ? r.at - speechEnd : "never"} ms)`);
}
{
  // Noisy room: the mic never reads as quiet. The mic may only delay a commit, never block it.
  const r = replay([{ at: 2_000, text: "That's my answer.", final: true, speechFinal: true }], { loud: [[0, 60_000]] });
  check("constant background noise can't block the turn (≤ 1.8 s extra)", r && r.at - 2_000 <= 1_800 + 1_800 + 100, `(${r ? r.at - 2_000 : "never"} ms)`);
}

// ── 7d. REAL INTERVIEW (2026-10-25, user's log): the candidate said "In CSS, the box model and…" and
//        paused to think. We took it as a finished answer after 4.8 s ("stale_interim"), played "Got it.",
//        and Maya replied "your explanation got cut off". An UNFINISHED sentence must never be taken that
//        early, on ANY path (interim-only, finalised, or no endpoint flag).
{
  const cases = [
    { name: "interim only (the exact path that cut the user)", segs: [{ at: 1_000, text: "In CSS, the", final: false }, { at: 2_000, text: "In CSS, the box model and", final: false }], last: 2_000 },
    { name: "Deepgram finalised it (…and,)", segs: [{ at: 1_000, text: "In CSS, the box model and", final: false }, { at: 1_600, text: "In CSS, the box model and,", final: true, speechFinal: true }], last: 1_600 },
    { name: "ends on 'Whether' (second cut in the log)", segs: [{ at: 1_000, text: "I was telling you are stopped in between what I have to do. Whether", final: true, speechFinal: true }], last: 1_000 },
    { name: "no end-of-speech flag at all", segs: [{ at: 1_000, text: "In CSS, the box model and", final: true }], last: 1_000 },
  ];
  for (const c of cases) {
    const r = replay(c.segs, { finalizeAnswersInMs: 250, untilMs: 30_000, loud: [[0, c.last]] });
    check(`unfinished answer is NOT taken before 9 s: ${c.name}`, r && r.at - c.last >= 9_000, `(taken ${r ? r.at - c.last : "never"} ms after the last words, ${r?.reason})`);
  }
  // …and when they finish their thought after a 4 s think, it is ONE complete answer.
  const r = replay(
    [
      { at: 1_000, text: "In CSS, the box model and", final: true, speechFinal: true },
      { at: 5_200, text: "it decides how big every element really is.", final: true, speechFinal: true },
    ],
    { loud: [[0, 1_000], [5_000, 5_200]] }
  );
  check("a 4 s thinking pause mid-answer: ONE complete answer, not two", r && r.text === "In CSS, the box model and it decides how big every element really is.", `(${r?.text})`);
  const short = replay([{ at: 1_520, text: "I don't know.", final: true, speechFinal: true }]);
  check("a short finished answer ('I don't know.') is still taken in ~2.3 s", short && short.at - 1_000 >= 2_000 && short.at - 1_000 <= 2_600, `(${short ? short.at - 1_000 : "never"} ms)`);
  const open = replay([{ at: 1_000, text: "Mostly React", final: true, speechFinal: true }]);
  check("a final without a sentence ending waits longer (3.5 s)", open && open.reason === "endpoint_open" && open.at - 1_000 >= 3_400, `(${open ? open.at - 1_000 : "never"} ms)`);
}
check("isUnfinished: joiners/fillers/commas yes, finished sentences no",
  ["box model and", "It depends on whether", "I think, um", "we used React,", "so the", "Whether"].every((t) => isUnfinished(t)) &&
  ["I don't know.", "No idea.", "That cut our load time in half.", "Is that right?", "Yes, I have."].every((t) => !isUnfinished(t)));
// REAL INTERVIEW (2026-10-25): "Synaptic we can do terminal also." waited 10 s (taken after 11.0 s of quiet)
// because "also" was treated as a word that can't end a sentence.
check("sentences that end on also / so / on / with / then are FINISHED (the 14 s wait)",
  ["Synaptic we can do terminal also.", "I think so.", "That's what we are working on.", "That's the library I worked with.", "I did it then.", "We use React as well as Vue, yes sure.", "I'd do the same thing too."].every((t) => !isUnfinished(t)));
check("…but a dangling 'and.' / 'the.' / 'whether.' is still unfinished", ["the box model and.", "it depends on the.", "I was not sure whether."].every(isUnfinished));
check("ack only when confident (finished sentence or the Done button)",
  shouldAck("endpoint") && shouldAck("button") && !shouldAck("stale_interim") && !shouldAck("endpoint_trailing") && !shouldAck("silence") && !shouldAck("endpoint_open"));

// ── 7e. REAL INTERVIEW (2026-10-25): "Can you repeat again my question?" was scored as an answer and
//        Maya moved on, so two questions were never answered. A repeat request must not advance.
check("repeat requests are recognised (the user's actual sentences)",
  ["Can you repeat again my question?", "Can you repeat again one same question?", "Could you say that again?", "Sorry, what was the question?",
   "Yeah. I'm ready. So I can don't know that much about margin, but margin I can do it. Can you repeat again one same question?", "Pardon?", "I didn't catch that."].every(isRepeatRequest));
check("real answers are NOT mistaken for repeat requests",
  ["I don't know.", "No idea.", "Yes, I have used flexbox for layout.", "I would repeat the test again after each change and measure the load time of every page in detail across several browsers and devices before shipping anything to production at all."].every((t) => !isRepeatRequest(t)));

// ── 7f. REAL INTERVIEW (2026-10-25): "Can you answer that question?" / "I don't know the answer. Can you
//        answer for that?" were scored as answers and Maya moved on without responding. She must say she
//        is an AI interviewer who can't answer, and keep listening.
check("'answer it for me' requests are recognised (the user's actual sentences)",
  ["Can you answer that question?", "I don't know the answer. Can you answer for that?", "Can you answer for me?", "What is the answer?",
   "Tell me the answer", "Could you give me a hint?", "Any hint?"].every(isAnswerRequest));
check("real answers are NOT mistaken for answer requests",
  ["I don't know.", "No idea.", "The answer is that margin sits outside the border.", "Yes, I can answer that, flexbox is one-dimensional.", "I would answer the customer first and then investigate the bug."].every((t) => !isAnswerRequest(t)));
check("Maya's reply says she is an AI interviewer and can't give the answer", /AI interviewer/.test(ANSWER_REQUEST_REPLY) && /can't give you the answer/.test(ANSWER_REQUEST_REPLY));
// ── 8. Nothing said → never commit (no empty answers to the brain) ──────────────────────────
check("silence with no words never commits", replay([]) === null);

// ── 9. Speaking helpers ──────────────────────────────────────────────────────────────────────
check("drops a pure 'Great!' opener after our ack", stripLeadingAck("Great! Can you tell me about indexing?", false) === "Can you tell me about indexing?");
check("keeps a meaningful opener", stripLeadingAck("Thanks for explaining the caching layer. How did you invalidate it?", false).startsWith("Thanks for explaining"));
check("never trims the goodbye", stripLeadingAck("Thank you! That brings us to the end.", true) === "Thank you! That brings us to the end.");
check("a single-sentence line is untouched", stripLeadingAck("What is a closure?", false) === "What is a closure?");
check("ack echo is recognised", isAckEcho("got it", "Got it.") && isAckEcho("Okay", "Okay."));
check("real speech during the ack is not mistaken for echo", !isAckEcho("okay so the second part", "Okay."));
check("ack never repeats twice in a row", ACK_LINES.every((a) => [0, 0.5, 0.99].every((r) => pickAck(a, r) !== a)));

// ── 10. PCM decoding (Maya's voice) survives chunks split on an odd byte ────────────────────
{
  const samples = [0, 1000, -1000, 32767, -32768];
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((s, i) => { const v = s < 0 ? s + 0x10000 : s; bytes[2 * i] = v & 0xff; bytes[2 * i + 1] = v >> 8; });
  const a = pcm16ToFloat(bytes.subarray(0, 3), null);
  const b = pcm16ToFloat(bytes.subarray(3), a.carry);
  const out = [...a.samples, ...b.samples].map((x) => Math.round(x * 0x8000));
  check("PCM split on an odd byte decodes exactly", JSON.stringify(out) === JSON.stringify(samples), JSON.stringify(out));
}

// ── 11. Source guards: properties that must not regress ─────────────────────────────────────
const hook = readFileSync(new URL("../src/hooks/usePipelineInterview.ts", import.meta.url), "utf8");
const turnRoute = readFileSync(new URL("../src/app/api/sessions/[token]/turn/route.ts", import.meta.url), "utf8");
const room = readFileSync(new URL("../src/app/interview/[token]/room/page.tsx", import.meta.url), "utf8");
const speak = readFileSync(new URL("../src/app/api/speak/route.ts", import.meta.url), "utf8");

// Every call that SHOWS a question (anything but clearing it to "") must be the one in markStarted.
const setQ = (hook.match(/setCurrentQuestion\((?!"")/g) ?? []).length;
const markStartedBody = hook.slice(hook.indexOf("const markStarted"), hook.indexOf("const voice = voiceRef.current;\n      let result"));
// Exactly one place shows the NEW line (markStarted); the other is the barge-in undo restoring the old one.
const showsNewLine = hook.split("setCurrentQuestion(line)").length - 1;
check("caption/question is shown only when Maya's audio starts", showsNewLine === 1 && setQ === 2 && markStartedBody.includes("setCurrentQuestion(line)"), `(${setQ} showing calls)`);
check("mic is muted while Maya speaks (no echo answers)", markStartedBody.includes("captureRef.current?.stop()"));
check("late speech before Maya's next line is merged, not lost", hook.includes("shouldMergeLateSpeech(late, mergesRef.current)") && hook.includes("turnAbortRef.current?.abort()"));
check("voice failure never strands the candidate (text fallback)", hook.includes('markStarted("text_only")'));
check("turn route: a superseded reply is not saved", turnRoute.includes('error: "superseded"'));
check("turn route: resubmission doesn't see its own stale answer", turnRoute.includes("NOT (turn_index = $2 AND role = 'candidate')"));
check("turn route: probe not double-counted on resubmission", turnRoute.includes("probe_counted_for"));
check("room has a 'Done answering' button + Space shortcut", room.includes("Done answering") && room.includes('e.code !== "Space"'));
check("engine: Done button takes the answer immediately", hook.includes('commitTurn(text, "button"'));
check("engine: candidate speaking over Maya stops her and keeps the same answer", hook.includes("const bargeIn") && hook.includes("pipeline.barge_in") && hook.includes("speakingUndoRef.current = null"));
check("engine: barge-in never applies to the opening or the goodbye", hook.includes("opts.candidateAnswer && !closing"));
check("engine: a repeat request replays the question without calling the brain", hook.includes("const repeatQuestion") && /if \(isRepeatRequest\(text\)[\s\S]{0,160}repeatQuestion\(text, "repeat"\);\s*return;/.test(hook));
check("engine: asking for the answer gets the explanation once per question, then the brain moves on",
  hook.includes("isAnswerRequest(text) && currentQuestionRef.current && helpCountRef.current < 1") && hook.includes("helpCountRef.current = 0"));
check("engine: ack is gated on confidence", hook.includes("shouldAck(reason)"));
check("pipeline is the default engine in the room", room.includes('useState<"pipeline" | "legacy" | "live">("pipeline")'));
check("speech endpoint requires a live interview token for PCM", speak.includes("session_token required"));

console.log(failures ? `\n${failures} FAILED` : "\nall pipeline checks passed");
process.exit(failures ? 1 : 0);

