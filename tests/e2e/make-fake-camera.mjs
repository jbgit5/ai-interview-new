// Builds a fake-webcam video (raw .y4m, the format Chrome's --use-file-for-fake-video-capture plays) from
// a still photo, so the e2e test has a stable camera with a real face in it (needed for proctoring
// checks, and Chrome's built-in generated test camera disappeared mid-run in headless mode).
//
//   node tests/e2e/make-fake-camera.mjs [image] [out.y4m] [--blank]
// Defaults: public/avatars/maya-real.webp → <tmp>/screeno-e2e/face.y4m.  --blank = grey frame, no face.
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const blank = process.argv.includes("--blank");
const image = resolve(argv[0] ?? "public/avatars/maya-real.webp");
const outDir = join(tmpdir(), "screeno-e2e");
mkdirSync(outDir, { recursive: true });
const out = resolve(argv[1] ?? join(outDir, blank ? "blank.y4m" : "face.y4m"));
const W = 640, H = 480, FRAMES = 4;

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
const mime = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }[extname(image)] ?? "image/png";
const dataUrl = blank ? null : `data:${mime};base64,${readFileSync(image).toString("base64")}`;

// Draw the photo centred ("cover") on a 640×480 canvas and return RGBA pixels.
const rgba = await page.evaluate(
  async ({ dataUrl, W, H }) => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    g.fillStyle = "#808080";
    g.fillRect(0, 0, W, H);
    if (dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const s = Math.max(W / img.width, H / img.height);
      const w = img.width * s, h = img.height * s;
      g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    }
    return Array.from(g.getImageData(0, 0, W, H).data);
  },
  { dataUrl, W, H }
);
await browser.close();

// RGBA → I420 (BT.601).
const Y = Buffer.alloc(W * H), U = Buffer.alloc((W / 2) * (H / 2)), V = Buffer.alloc((W / 2) * (H / 2));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    Y[y * W + x] = Math.max(0, Math.min(255, Math.round(0.257 * r + 0.504 * g + 0.098 * b + 16)));
    if (y % 2 === 0 && x % 2 === 0) {
      const j = (y / 2) * (W / 2) + x / 2;
      U[j] = Math.max(0, Math.min(255, Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128)));
      V[j] = Math.max(0, Math.min(255, Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128)));
    }
  }
}
const fd = openSync(out, "w");
writeSync(fd, `YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`);
for (let f = 0; f < FRAMES; f++) {
  writeSync(fd, "FRAME\n");
  writeSync(fd, Y);
  writeSync(fd, U);
  writeSync(fd, V);
}
closeSync(fd);
console.log(`fake camera written: ${out} (${blank ? "blank" : image})`);
