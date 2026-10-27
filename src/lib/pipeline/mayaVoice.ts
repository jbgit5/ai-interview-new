/**
 * Maya's voice for the pipeline engine — browser only.
 *
 * Everything Maya says goes through ONE WebAudio graph:
 *
 *   PCM chunks / ack clips → voice bus ─┬→ speaker gain → speakers   (muted while the avatar plays her)
 *                                       ├→ MediaStream track          (fed to the Simli lip-sync avatar)
 *                                       └→ analyser                   (is she REALLY audible right now?)
 *
 * Why: in earlier rounds the screen, the avatar and the "she finished" logic each guessed from different
 * signals (transcript text, a separate <audio> element), which caused goodbyes cut off mid-sentence and
 * captions that ran ahead of her voice. Here "started" and "finished" are the actual scheduled audio.
 *
 * Audio is raw 24 kHz 16-bit mono PCM streamed from /api/speak (format "pcm"): no decoder start-up and
 * playback begins after ~120 ms of audio has arrived.
 */

import { MicMeter } from "./micMeter";

export const PCM_RATE = 24_000;
/** Audio buffered before the first sample plays (absorbs network jitter on the first chunks). */
const PRIME_SECONDS = 0.12;
/** Output level (RMS 0..1) that counts as "Maya audible". */
const AUDIBLE_RMS = 0.01;

export interface PlayResult {
  aborted: boolean;
  failed?: string;
  provider?: string;
  /** /api/speak request → first audio sample actually playing. */
  firstAudioMs?: number;
  /** Times the stream fell behind playback (a gap the candidate could hear). */
  underruns?: number;
  durationMs?: number;
}

export interface PlayOptions {
  sessionToken: string;
  traceId?: string;
  kind: string;
  signal?: AbortSignal;
  /** Fires when the first sample is actually coming out of the graph. */
  onStart?: () => void;
}

type Ctx = AudioContext;

export class MayaVoice {
  private ctx: Ctx | null = null;
  private bus: GainNode | null = null;
  private speaker: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterBuf: Uint8Array<ArrayBuffer> | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private live = new Set<AudioBufferSourceNode>();
  private lastAudibleAt = 0;
  private speakerMuted = false;

  /** Must be called synchronously inside the Start click (browser autoplay policy). */
  unlock(): void {
    if (!this.ctx) {
      const C =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = new C();
      const bus = ctx.createGain();
      const speaker = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      bus.connect(speaker);
      speaker.connect(ctx.destination);
      bus.connect(dest);
      bus.connect(analyser);
      speaker.gain.value = this.speakerMuted ? 0 : 1;
      this.ctx = ctx;
      this.bus = bus;
      this.speaker = speaker;
      this.dest = dest;
      this.analyser = analyser;
      this.meterBuf = new Uint8Array(analyser.fftSize);
      this.meterTimer = setInterval(() => this.sampleMeter(), 100);
    }
    void this.ctx.resume().catch(() => {});
  }

  get contextState(): string {
    return this.ctx?.state ?? "none";
  }

  /** Level meter on the candidate's mic, sharing this (already unlocked) audio context. */
  createMicMeter(stream: MediaStream): MicMeter | null {
    if (!this.ctx) return null;
    try {
      return new MicMeter(this.ctx, stream);
    } catch {
      return null;
    }
  }

  /** Maya's voice as a live track (for the lip-sync avatar). Null until unlock(). */
  get track(): MediaStreamTrack | null {
    return this.dest?.stream.getAudioTracks()[0] ?? null;
  }

  /** Mute the speakers only (the avatar track keeps flowing) — used while the avatar plays her voice. */
  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted;
    if (this.speaker && this.ctx) this.speaker.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
  }

  /** ms since Maya's output was last audible (Infinity if never). */
  msSinceAudible(): number {
    return this.lastAudibleAt ? Date.now() - this.lastAudibleAt : Infinity;
  }

  isPlaying(): boolean {
    return this.live.size > 0;
  }

  /** Stop everything Maya is saying right now. */
  stopAll(): void {
    for (const s of Array.from(this.live)) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.live.clear();
  }

  close(): void {
    this.stopAll();
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.bus = this.speaker = this.analyser = null;
    this.dest = null;
    if (ctx) void ctx.close().catch(() => {});
  }

  /**
   * Download a short line (ack clips) as samples. Needs no audio context, so it can run on the
   * "Ready?" screen before the Start click; playClip() then plays it instantly.
   */
  static async fetchClip(text: string, sessionToken: string): Promise<Float32Array<ArrayBuffer> | null> {
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, session_token: sessionToken, format: "pcm", kind: "ack" }),
      });
      if (!res.ok) return null;
      const floats = pcm16ToFloat(new Uint8Array(await res.arrayBuffer()), null).samples;
      return floats.length > 0 ? floats : null;
    } catch {
      return null;
    }
  }

  /** Play a downloaded clip. Resolves when it has finished (or was stopped). */
  playClip(samples: Float32Array<ArrayBuffer>, signal?: AbortSignal): Promise<PlayResult> {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return Promise.resolve({ aborted: false, failed: "no_audio_context" });
    const buf = ctx.createBuffer(1, samples.length, PCM_RATE);
    buf.copyToChannel(samples, 0);
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(bus);
      this.live.add(src);
      const t0 = Date.now();
      let done = false;
      const finish = (aborted: boolean) => {
        if (done) return;
        done = true;
        this.live.delete(src);
        resolve({ aborted, durationMs: Date.now() - t0 });
      };
      src.onended = () => finish(!!signal?.aborted);
      signal?.addEventListener(
        "abort",
        () => {
          try {
            src.stop();
          } catch {
            /* ignore */
          }
          finish(true);
        },
        { once: true }
      );
      src.start();
    });
  }

  /**
   * Stream a line from /api/speak and play it as it arrives. Resolves when the LAST sample has
   * actually played (not when the download finished), or immediately on abort/failure.
   */
  async speak(text: string, opts: PlayOptions): Promise<PlayResult> {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return { aborted: false, failed: "no_audio_context" };
    if (ctx.state !== "running") await ctx.resume().catch(() => {});

    const t0 = Date.now();
    const signal = opts.signal;
    const mine = new Set<AudioBufferSourceNode>();
    let underruns = 0;
    let startedAt = 0;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    const stopMine = () => {
      if (startTimer) clearTimeout(startTimer);
      for (const s of Array.from(mine)) {
        try {
          s.stop();
        } catch {
          /* ignore */
        }
        this.live.delete(s);
      }
      mine.clear();
    };
    signal?.addEventListener("abort", stopMine, { once: true });

    let res: Response;
    try {
      res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          session_token: opts.sessionToken,
          trace_id: opts.traceId,
          format: "pcm",
          kind: opts.kind,
        }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return { aborted: true };
      return { aborted: false, failed: `fetch: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120) };
    }
    if (!res.ok || !res.body) {
      return { aborted: false, failed: `http_${res.status}` };
    }
    const provider = res.headers.get("X-TTS-Provider") ?? "unknown";

    const reader = res.body.getReader();
    let carry: number | null = null; // odd trailing byte between chunks
    let pending: Float32Array<ArrayBuffer>[] = [];
    let pendingLen = 0;
    let nextTime = 0;
    let scheduledAny = false;

    const schedule = (samples: Float32Array<ArrayBuffer>) => {
      if (samples.length === 0 || signal?.aborted) return;
      const buf = ctx.createBuffer(1, samples.length, PCM_RATE);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(bus);
      const earliest = ctx.currentTime + 0.02;
      if (scheduledAny && nextTime < earliest) underruns++;
      const at = Math.max(nextTime, earliest);
      src.start(at);
      if (!scheduledAny) {
        scheduledAny = true;
        startTimer = setTimeout(() => {
          startedAt = Date.now();
          opts.onStart?.();
        }, Math.max(0, (at - ctx.currentTime) * 1000));
      }
      nextTime = at + buf.duration;
      mine.add(src);
      this.live.add(src);
      src.onended = () => {
        mine.delete(src);
        this.live.delete(src);
      };
    };

    const flushPending = () => {
      if (pendingLen === 0) return;
      const all = new Float32Array(pendingLen);
      let o = 0;
      for (const p of pending) {
        all.set(p, o);
        o += p.length;
      }
      pending = [];
      pendingLen = 0;
      schedule(all);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal?.aborted) {
          void reader.cancel().catch(() => {});
          stopMine();
          return { aborted: true, provider };
        }
        if (done) break;
        if (!value || value.length === 0) continue;
        const { samples, carry: c } = pcm16ToFloat(value, carry);
        carry = c;
        if (!scheduledAny) {
          pending.push(samples);
          pendingLen += samples.length;
          if (pendingLen >= PRIME_SECONDS * PCM_RATE) flushPending();
        } else {
          schedule(samples);
        }
      }
      flushPending();
    } catch (err) {
      if (signal?.aborted) {
        stopMine();
        return { aborted: true, provider };
      }
      // Stream broke mid-line: let what was scheduled finish, report the failure.
      flushPending();
      if (!scheduledAny) {
        return { aborted: false, failed: `stream: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120), provider };
      }
    }

    if (!scheduledAny) return { aborted: false, failed: "empty_audio", provider };

    // Wait until the last scheduled sample has played.
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (signal?.aborted || !this.ctx) return resolve();
        const left = nextTime - ctx.currentTime;
        if (left <= 0.01) return resolve();
        setTimeout(tick, Math.min(250, Math.max(20, left * 1000)));
      };
      tick();
    });
    signal?.removeEventListener("abort", stopMine);
    if (signal?.aborted) return { aborted: true, provider };
    return {
      aborted: false,
      provider,
      firstAudioMs: startedAt ? startedAt - t0 : undefined,
      underruns,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    };
  }

  private sampleMeter(): void {
    const a = this.analyser;
    const buf = this.meterBuf;
    if (!a || !buf) return;
    a.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    if (Math.sqrt(sum / buf.length) > AUDIBLE_RMS) this.lastAudibleAt = Date.now();
  }
}

/** Little-endian signed 16-bit PCM → float samples. Carries an odd trailing byte to the next chunk. */
export function pcm16ToFloat(
  bytes: Uint8Array,
  carry: number | null
): { samples: Float32Array<ArrayBuffer>; carry: number | null } {
  let data = bytes;
  if (carry !== null) {
    data = new Uint8Array(bytes.length + 1);
    data[0] = carry;
    data.set(bytes, 1);
  }
  const n = Math.floor(data.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = data[2 * i];
    const hi = data[2 * i + 1];
    let v = (hi << 8) | lo;
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 0x8000;
  }
  return { samples: out, carry: data.length % 2 === 1 ? data[data.length - 1] : null };
}
