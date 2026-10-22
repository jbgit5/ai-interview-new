/** Public worklet served from `/public/audio/` — must stay plain JS for `addModule`. */
export function getPcmCaptureWorkletUrl(): string {
  if (typeof window === "undefined") return "/audio/pcm-capture-processor.js";
  return new URL("/audio/pcm-capture-processor.js", window.location.origin).href;
}
