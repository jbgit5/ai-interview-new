/**
 * Candidate microphone level → "are they audibly talking right now?" (browser only).
 *
 * Why: the transcript is a poor clock for "still talking". Measured on a real run: Deepgram's live
 * updates paused for >1 s while the candidate was mid-sentence, so a transcript-only rule took the
 * answer too early. Sound level is the direct signal. The noise floor adapts (fans, hum, AGC), so
 * steady background noise is not counted as speech. The turn rules only use this to WAIT longer —
 * with a cap — so a noisy room can delay a commit a little but never block it.
 */

/** Speech must be this many times louder than the background noise… */
const FLOOR_MULTIPLIER = 3;
/** …and at least this loud (RMS 0..1). */
const MIN_SPEECH_RMS = 0.012;

export class MicMeter {
  private analyser: AnalyserNode;
  private source: MediaStreamAudioSourceNode;
  private buf: Float32Array<ArrayBuffer>;
  private floor = 0.004;
  /** Last time the level was above the speech threshold (0 = never). */
  lastLoudAt = 0;
  lastRms = 0;

  readonly stream: MediaStream;

  constructor(ctx: AudioContext, stream: MediaStream) {
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser); // analysis only — never routed to the speakers
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  /** Current estimate of the room's background level (RMS), for thresholds relative to the room. */
  get noiseFloor(): number {
    return this.floor;
  }

  /** Take one reading; call every ~100 ms. Returns true while speech-level sound is present. */
  sample(now = Date.now()): boolean {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    this.lastRms = rms;
    // Floor follows quiet readings down quickly and creeps up slowly (so speech doesn't become "floor").
    this.floor = rms < this.floor ? rms * 0.5 + this.floor * 0.5 : this.floor * 1.002;
    const loud = rms > Math.max(MIN_SPEECH_RMS, this.floor * FLOOR_MULTIPLIER);
    if (loud) this.lastLoudAt = now;
    return loud;
  }

  close(): void {
    try {
      this.source.disconnect();
    } catch {
      /* ignore */
    }
  }
}
