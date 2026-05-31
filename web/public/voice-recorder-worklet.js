/**
 * AudioWorklet that captures mono microphone audio and posts it to the main
 * thread as 16-bit PCM (linear16) ArrayBuffers, ready to send to Deepgram.
 *
 * The owning AudioContext is created with { sampleRate: 16000 }, so the input
 * blocks are already at 16 kHz and no resampling is needed here — we only
 * convert Float32 [-1, 1] to Int16 and batch into ~128 ms frames.
 *
 * NOISE GATE: background noise was being mistaken for speech. To stop that, we
 * gate the signal by short-term energy (RMS) before sending it on. The gate
 * only opens once the level clears `openThreshold`, and stays open until the
 * level drops below `closeThreshold` for `holdMs` (hysteresis avoids choppy
 * cut-outs between words). While closed we emit true silence, so Deepgram's
 * voice-activity detection never sees the room tone / fan / typing.
 *
 * A small look-ahead ring buffer (`prerollMs`) is kept so that when the gate
 * opens we also emit the few frames right before the onset — otherwise the
 * first phoneme of a word would be clipped.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this._openThreshold = o.openThreshold ?? 0.045;
    this._closeThreshold = o.closeThreshold ?? 0.025;
    this._holdSamples = Math.round(((o.holdMs ?? 700) / 1000) * sampleRate);
    this._prerollSamples = Math.round(
      ((o.prerollMs ?? 200) / 1000) * sampleRate,
    );

    this._frame = []; // accumulates samples for the outgoing ~128 ms frame
    this._target = 2048; // ~128 ms at 16 kHz

    this._open = false;
    this._belowFor = 0; // samples spent below closeThreshold while open

    // Look-ahead ring buffer of recent raw samples (pre-gate).
    this._preroll = new Float32Array(this._prerollSamples);
    this._prerollLen = 0;
    this._prerollHead = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'gate') {
        if (typeof d.openThreshold === 'number')
          this._openThreshold = d.openThreshold;
        if (typeof d.closeThreshold === 'number')
          this._closeThreshold = d.closeThreshold;
        if (typeof d.holdMs === 'number')
          this._holdSamples = Math.round((d.holdMs / 1000) * sampleRate);
      }
    };
  }

  _pushPreroll(sample) {
    if (this._prerollSamples === 0) return;
    this._preroll[this._prerollHead] = sample;
    this._prerollHead = (this._prerollHead + 1) % this._prerollSamples;
    if (this._prerollLen < this._prerollSamples) this._prerollLen++;
  }

  _flushPrerollToFrame() {
    // Emit the buffered look-ahead samples in chronological order.
    const n = this._prerollLen;
    const start =
      (this._prerollHead - n + this._prerollSamples) % this._prerollSamples;
    for (let i = 0; i < n; i++) {
      this._frame.push(this._preroll[(start + i) % this._prerollSamples]);
    }
    this._prerollLen = 0;
  }

  _emitFrames() {
    while (this._frame.length >= this._target) {
      const slice = this._frame.splice(0, this._target);
      const pcm = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    // Short-term RMS for this render quantum (~128 samples).
    let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    const rms = Math.sqrt(sum / channel.length);

    if (!this._open) {
      // Closed: watch for an onset, keep filling the look-ahead buffer.
      if (rms >= this._openThreshold) {
        this._open = true;
        this._belowFor = 0;
        this._flushPrerollToFrame(); // include audio just before the onset
        for (let i = 0; i < channel.length; i++) this._frame.push(channel[i]);
      } else {
        for (let i = 0; i < channel.length; i++) this._pushPreroll(channel[i]);
      }
    } else {
      // Open: pass audio through, track how long we've been quiet.
      for (let i = 0; i < channel.length; i++) this._frame.push(channel[i]);
      if (rms < this._closeThreshold) {
        this._belowFor += channel.length;
        if (this._belowFor >= this._holdSamples) {
          this._open = false;
          this._belowFor = 0;
        }
      } else {
        this._belowFor = 0;
      }
    }

    this._emitFrames();
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
