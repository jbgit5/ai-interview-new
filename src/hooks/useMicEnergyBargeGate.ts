/**
 * Lightweight client-side energy gate for barge-in detection during TTS.
 *
 * Changed from v1: accepts an `externalStream` option so it can reuse the
 * MediaStream already held by useSpeechCapture. This eliminates the third
 * getUserMedia() call (useSpeechCapture owns one, LiveKit owns one — this
 * hook no longer opens a third). When an external stream is provided the
 * gate does NOT stop its tracks on cleanup (the stream owner controls lifecycle).
 */

export interface MicEnergyBargeGateOptions {
  /** Normalized RMS-ish level [0,1] — tune with room noise */
  rmsThreshold?: number;
  /** Frames above threshold before firing */
  consecutiveAbove?: number;
  onBarge: () => void;
  /**
   * Reuse an existing MediaStream (from useSpeechCapture.getSharedStream()).
   * When provided, the gate reads audio from this stream but never stops its
   * tracks — ownership stays with the caller.
   */
  externalStream?: MediaStream | null;
}

export function createMicEnergyBargeGate(opts: MicEnergyBargeGateOptions) {
  const rmsThreshold    = opts.rmsThreshold    ?? 0.024;
  const consecutiveAbove = opts.consecutiveAbove ?? 4;

  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let rafId: number | null = null;
  let running   = false;
  let consec    = 0;
  let disposed  = false;
  let suppressUntil = 0;
  /** True when we own the stream and must stop its tracks on cleanup */
  let ownStream = false;

  const setSuppressPlaybackGraceMs = (ms: number) => {
    suppressUntil = typeof performance !== "undefined" ? performance.now() + ms : 0;
  };

  const stopInternal = () => {
    disposed = true;
    running  = false;
    consec   = 0;
    if (rafId != null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    try { analyser?.disconnect(); } catch { /* noop */ }
    try {
      if (audioCtx?.state !== "closed") audioCtx?.close().catch(() => {});
    } catch { /* noop */ }
    analyser = null;
    audioCtx  = null;

    // Only stop tracks when we opened the stream ourselves
    if (ownStream && stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    stream    = null;
    ownStream = false;
  };

  const tick = () => {
    if (disposed || !running || !analyser || !audioCtx) return;
    const nowClock =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    const bufLen = analyser.fftSize;
    const buf    = new Float32Array(bufLen);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < bufLen; i++) {
      sum += buf[i] * buf[i];
    }
    const rms = Math.sqrt(sum / bufLen);

    if (nowClock < suppressUntil) {
      consec = 0;
    } else if (rms >= rmsThreshold) {
      consec++;
      if (consec >= consecutiveAbove) {
        consec  = 0;
        running = false;
        opts.onBarge();
        stopInternal();
        return;
      }
    } else {
      consec = 0;
    }

    rafId = requestAnimationFrame(tick);
  };

  const start = async () => {
    stopInternal();
    disposed = false;

    if (opts.externalStream?.active) {
      // Reuse the capture stream — zero additional getUserMedia calls
      stream    = opts.externalStream;
      ownStream = false;
    } else {
      // Fallback: open our own stream (original behaviour)
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      ownStream = true;
    }

    audioCtx = new AudioContext();
    analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 512;

    const src  = audioCtx.createMediaStreamSource(stream);
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    src.connect(analyser);
    analyser.connect(mute);
    mute.connect(audioCtx.destination);

    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }

    running = true;
    rafId   = requestAnimationFrame(tick);
  };

  return {
    start,
    stop: stopInternal,
    setSuppressPlaybackGraceMs,
  };
}
