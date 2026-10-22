/**
 * Realtime mono capture → target sample rate (default 16 kHz) via sample accumulation,
 * batched as linear16 (Int16) frames. Output is zeroed to avoid audible feedback.
 *
 * processorOptions:
 *   - targetSampleRate: number (default 16000)
 *   - frameMs: batch size in ms (default 40, clamped 20–100 in host)
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = (options && options.processorOptions) || {};
    this.dstRate = po.targetSampleRate || 16000;
    const frameMs = typeof po.frameMs === "number" ? po.frameMs : 40;
    this.frameSamples = Math.max(
      Math.floor((this.dstRate * 20) / 1000),
      Math.min(Math.floor((this.dstRate * frameMs) / 1000), Math.floor((this.dstRate * 100) / 1000))
    );
    this.srcRate = sampleRate;
    /** Output samples produced per one input sample (fractional accumulator) */
    this.phase = 0;
    this._frame = new Float32Array(this.frameSamples);
    this._framePtr = 0;
  }

  _emitFrame() {
    const int16 = new Int16Array(this.frameSamples);
    for (let i = 0; i < this.frameSamples; i++) {
      let s = this._frame[i];
      s = Math.max(-1, Math.min(1, s));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(
      {
        type: "pcm",
        sampleRate: this.dstRate,
        samples: this.frameSamples,
        buffer: int16.buffer,
      },
      [int16.buffer]
    );
    this._framePtr = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const outCh = outputs[0] && outputs[0][0];
    if (outCh) outCh.fill(0);

    if (!input || !input[0]) return true;
    const ch0 = input[0];
    const step = this.dstRate / this.srcRate;

    for (let i = 0; i < ch0.length; i++) {
      const sample = ch0[i];
      this.phase += step;
      while (this.phase >= 1) {
        this.phase -= 1;
        this._frame[this._framePtr++] = sample;
        if (this._framePtr >= this.frameSamples) {
          this._emitFrame();
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
