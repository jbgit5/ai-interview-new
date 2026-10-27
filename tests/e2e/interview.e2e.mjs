// End-to-end interview test in a real (headless) Chrome — the check that unit tests can't do.
//
//   node tests/e2e/interview.e2e.mjs --token <interview token> [--base http://localhost:3000] [--headed]
//
// What it does:
//   - opens the real interview room with a fake camera;
//   - replaces the microphone with a sound source this script controls, and plays a pre-recorded
//     "candidate" answer each time the room says Maya is LISTENING (like a person waiting their turn);
//   - deliberately includes the hard cases: a thinking pause after "and then" (must NOT be cut off) and
//     a candidate who keeps talking right after their answer was taken (must be MERGED, not lost);
//   - measures what the candidate experiences: last word → Maya's acknowledgement / next question.
// It spends real (small) money: brain calls, Deepgram, LiveKit, and Simli if the recruiter uses the
// real-person avatar. The token must be a fresh (not completed) interview.
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, [])
);
const TOKEN = args.token;
const BASE = args.base ?? "http://localhost:3000";
const OUT = args.out ?? join(tmpdir(), "screeno-e2e");
if (!TOKEN) {
  console.error("usage: node tests/e2e/interview.e2e.mjs --token <interview token>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

// The candidate's answers. Arrays = spoken parts with a pause (ms) between them.
const ANSWERS = [
  { label: "plain answer", parts: ["Sure. I have about four years of experience building web applications with React and TypeScript. Most recently I owned the component library and the performance work for a logistics dashboard."] },
  { label: "thinking pause after 'and then'", parts: ["I usually start by measuring with the browser performance tools, and then", 1800, "I look at bundle size, lazy loading and unnecessary re-renders. That cut our load time roughly in half."] },
  { label: "keeps talking after the answer was taken", lateAddition: "Oh, and I would also add monitoring so we catch regressions early.", parts: ["I would agree on the edge cases with the designer early, and ship it in small pieces behind a feature flag."] },
  { label: "follow-up answer", parts: ["For example, on the reports page we used memoization and code splitting, and we tracked the results in our monitoring."] },
  { label: "follow-up answer 2", parts: ["I think clear communication and small, reviewable pull requests matter most to me in a team."] },
  { label: "follow-up answer 3", parts: ["That is all I would add, thank you."] },
];

// ── Candidate voice clips (generated once through the app's own speech endpoint, cached) ──────
async function clip(text) {
  const file = join(OUT, `clip-${createHash("sha1").update(text).digest("hex").slice(0, 12)}.pcm`);
  if (existsSync(file)) return readFileSync(file).toString("base64");
  const res = await fetch(`${BASE}/api/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, session_token: TOKEN, format: "pcm", kind: "e2e_candidate" }),
  });
  if (!res.ok) throw new Error(`clip synthesis failed: HTTP ${res.status} ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf.toString("base64");
}

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...m) => console.log(ts(), ...m);

console.log(`Chrome: ${CHROME}\nRoom:   ${BASE}/interview/${TOKEN}/room\nOut:    ${OUT}\n`);
for (const a of ANSWERS) {
  for (const p of a.parts) if (typeof p === "string") await clip(p);
  if (a.lateAddition) await clip(a.lateAddition);
}
log("candidate clips ready");

// --camera <file.y4m>: stable fake webcam from a video file (tests/e2e/make-fake-camera.mjs builds one
// with a real face). Without it Chrome's generated test camera is used, which vanished mid-run in
// headless mode ("Requested device not found") — fine for voice tests, not for camera/proctoring.
const cameraFile = typeof args.camera === "string" ? args.camera : null;
if (cameraFile && !existsSync(cameraFile)) {
  console.error(`camera file not found: ${cameraFile} (run: node tests/e2e/make-fake-camera.mjs)`);
  process.exit(2);
}
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: args.headed ? false : "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    ...(cameraFile ? [`--use-file-for-fake-video-capture=${cameraFile}`] : []),
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1366,800",
  ],
  defaultViewport: { width: 1366, height: 800 },
});
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

// --trace-stops: print a stack trace whenever page code stops a camera track (media-bug hunting).
if (args["trace-stops"]) {
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("TRACK_STOP")) console.log(t.split("\n").slice(0, 4).join("\n"));
    if (t.startsWith("GUM") || t.startsWith("DEVICECHANGE") || t.startsWith("SELFVIEW")) console.log(t);
  });
  await page.evaluateOnNewDocument(() => {
    const orig = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      if (this.kind === "video") console.log(`TRACK_STOP video ${this.id.slice(0, 8)} t=${Math.round(performance.now())}\n${new Error().stack}`);
      return orig.call(this);
    };
    const md = navigator.mediaDevices;
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const t = Math.round(performance.now());
      try {
        const s = await gum(c);
        console.log(`GUM t=${t} ok ${JSON.stringify(c).slice(0, 120)} → ${s.getTracks().map((x) => `${x.kind}:${x.id.slice(0, 8)}`).join(",")}`);
        return s;
      } catch (e) {
        console.log(`GUM t=${t} FAILED ${JSON.stringify(c).slice(0, 120)} → ${e?.name}: ${e?.message}`);
        throw e;
      }
    };
    md.addEventListener("devicechange", () => console.log(`DEVICECHANGE t=${Math.round(performance.now())}`));
    setInterval(() => {
      const v = document.querySelector("video[muted], video");
      const tr = v?.srcObject?.getVideoTracks?.()[0];
      console.log(`SELFVIEW t=${Math.round(performance.now())} ${tr ? `${tr.id.slice(0, 8)} ${tr.readyState}` : "no source"}`);
    }, 3000);
  });
}

// Replace the microphone with a WebAudio source we control (camera stays the fake device).
// --no-mic-patch: keep Chrome's own fake mic (no candidate answers possible; for isolating media bugs).
if (!args["no-mic-patch"]) await page.evaluateOnNewDocument(() => {
  const w = window;
  w.__e2e = { ctx: null, dest: null, speaking: false };
  const md = navigator.mediaDevices;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    if (c && c.audio) {
      if (!w.__e2e.ctx) {
        w.__e2e.ctx = new AudioContext({ sampleRate: 48000 });
        w.__e2e.dest = w.__e2e.ctx.createMediaStreamDestination();
      }
      s.getAudioTracks().forEach((t) => {
        s.removeTrack(t);
        t.stop();
      });
      s.addTrack(w.__e2e.dest.stream.getAudioTracks()[0].clone());
    }
    return s;
  };
  w.__e2eSay = async (b64) => {
    const e = w.__e2e;
    await e.ctx.resume();
    const bin = atob(b64);
    const n = Math.floor(bin.length / 2);
    const buf = e.ctx.createBuffer(1, n, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 0x8000;
    }
    const src = e.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(e.dest);
    e.speaking = true;
    await new Promise((r) => {
      src.onended = r;
      src.start();
    });
    e.speaking = false;
    return buf.duration;
  };
});

// Network timing of the brain calls: when the browser issued each /turn request vs. when it finished.
page.on("request", (r) => {
  if (r.url().includes("/turn")) log(`   → /turn request issued`);
});
page.on("requestfinished", (r) => {
  if (r.url().includes("/turn")) {
    const tm = r.response()?.timing();
    const queued = tm ? Math.round(tm.sendStart) : null; // ms from request start until actually sent
    log(`   ← /turn finished (browser queueing before send: ${queued ?? "?"} ms)`);
  }
});

await page.goto(`${BASE}/interview/${TOKEN}/room`, { waitUntil: "domcontentloaded" });
const startBtn = await page.waitForSelector("xpath/.//button[contains(., 'Start interview')]", { timeout: 60_000 });
await page.screenshot({ path: join(OUT, "1-ready.png") });
// A person reads the "Ready?" screen for a few seconds (the room prepares speech recognition meanwhile).
const READY_WAIT_MS = Number(args["ready-wait"] ?? 6_000);
await new Promise((r) => setTimeout(r, READY_WAIT_MS));
await startBtn.click();
log(`clicked Start interview (after ${READY_WAIT_MS} ms on the Ready screen)`);

const getState = () =>
  page.evaluate(() => {
    const el = document.querySelector("[data-interview-state]");
    return el
      ? { state: el.getAttribute("data-interview-state"), ai: el.getAttribute("data-ai-status"), engine: el.getAttribute("data-engine") }
      : { state: document.body.innerText.includes("Interview Complete") ? "completed" : "unknown" };
  });

const say = async (text) => page.evaluate((b64) => window.__e2eSay(b64), await clip(text));

const results = [];
let answerIdx = 0;
let prev = "";
let lastWordAt = 0;
let pendingMeasure = null;
const deadline = Date.now() + 8 * 60_000;
let screenshotTaken = false;

while (Date.now() < deadline) {
  const s = await getState();
  const key = `${s.state}/${s.ai}`;
  if (key !== prev) {
    log(`state → ${key}${s.engine ? ` (engine ${s.engine})` : ""}`);
    if (pendingMeasure && s.state === "processing" && !pendingMeasure.committedAt) pendingMeasure.committedAt = Date.now();
    if (pendingMeasure && s.state === "speaking") {
      pendingMeasure.mayaAt = Date.now();
      results.push(pendingMeasure);
      log(`  ⏱  last word → answer taken ${pendingMeasure.committedAt ? pendingMeasure.committedAt - pendingMeasure.lastWordAt : "?"} ms, → Maya speaking ${pendingMeasure.mayaAt - pendingMeasure.lastWordAt} ms`);
      pendingMeasure = null;
    }
    prev = key;
  }
  if (s.state === "speaking" && !screenshotTaken) {
    screenshotTaken = true;
    await page.screenshot({ path: join(OUT, "2-maya-speaking.png") });
    // --opening-only: measure Start → Maya's first word and stop (cheap: one small brain call).
    if (args["opening-only"]) break;
  }
  if (s.state === "completed" || s.state === "error") break;

  if (s.state === "listening" && !pendingMeasure && answerIdx < ANSWERS.length) {
    const a = ANSWERS[answerIdx++];
    await new Promise((r) => setTimeout(r, 900)); // human reaction time
    log(`🎤 candidate: ${a.label}`);
    for (const p of a.parts) {
      if (typeof p === "number") await new Promise((r) => setTimeout(r, p));
      else await say(p);
    }
    lastWordAt = Date.now();
    pendingMeasure = { label: a.label, lastWordAt };
    if (a.lateAddition) {
      // Wait until the answer is taken, then keep talking (like a real candidate remembering something).
      const until = Date.now() + 6_000;
      while (Date.now() < until && (await getState()).state !== "processing") await new Promise((r) => setTimeout(r, 50));
      const taken = (await getState()).state === "processing";
      log(`  answer taken: ${taken} — now adding a late sentence`);
      await new Promise((r) => setTimeout(r, 400));
      await say(a.lateAddition);
      pendingMeasure = { label: `${a.label} (merged)`, lastWordAt: Date.now(), lateMergeExpected: true };
    }
    if (answerIdx === 2) await page.screenshot({ path: join(OUT, "3-after-answer.png") });
    continue;
  }
  await new Promise((r) => setTimeout(r, 100));
}

const final = await getState();
await page.screenshot({ path: join(OUT, "4-end.png") });
log(`final state: ${final.state}`);
await new Promise((r) => setTimeout(r, 3_000)); // let telemetry flush
await browser.close();

console.log("\n── Candidate-experienced latency ──");
for (const r of results) {
  console.log(
    `${r.label.padEnd(45)} answer taken ${String(r.committedAt ? r.committedAt - r.lastWordAt : "?").padStart(5)} ms   Maya's next line ${String(r.mayaAt - r.lastWordAt).padStart(5)} ms`
  );
}
console.log(`\nconsole errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 15).forEach((e) => console.log("  ", e));
writeFileSync(join(OUT, "result.json"), JSON.stringify({ final, results, consoleErrors }, null, 2));
process.exit(final.state === "completed" ? 0 : 1);
