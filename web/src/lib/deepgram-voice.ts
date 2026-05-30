/**
 * Browser client for a live voice conversation with Aira via Deepgram's
 * Voice Agent API.
 *
 * The browser does NOT talk to Deepgram directly — it connects to our backend's
 * /voice/agent WebSocket, which proxies to Deepgram with the server-held API key
 * (Deepgram's ephemeral grant tokens are ASR-scoped and rejected by the Voice
 * Agent endpoint, and the long-lived key must never reach the browser). The
 * backend also sends the Settings message, so no secrets live client-side.
 *
 * Deepgram owns the real-time hard parts: speech-to-text, text-to-speech, turn
 * detection (knowing when you've finished speaking) and barge-in (when you talk
 * over Aira). Aira is the agent's "think" LLM via our OpenAI-compatible
 * /voice/llm endpoint, so the full agent — tools, memory, history — is reused.
 *
 * Audio in:  mic -> AudioContext(16 kHz) -> worklet (noise gate) -> linear16 PCM
 * Audio out: ws binary frames (linear16 24 kHz) -> queued Web Audio playback
 *
 * To stop background noise from being mistaken for speech, the capture worklet
 * applies a look-ahead noise gate: audio below an energy threshold is replaced
 * with silence before it reaches Deepgram, so only real speech triggers it.
 */

export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface VoiceCallbacks {
  onState?: (state: VoiceState) => void;
  onTranscript?: (role: 'user' | 'assistant', text: string) => void;
  onError?: (message: string) => void;
}

/** Noise-gate tuning. Higher threshold = less sensitive to background noise. */
export interface NoiseGateOptions {
  /** RMS level (0–1) that must be exceeded to open the gate. Default 0.022. */
  openThreshold?: number;
  /** RMS level the signal must fall below to start closing. Default 0.012. */
  closeThreshold?: number;
  /** How long (ms) the gate stays open after speech drops. Default 700. */
  holdMs?: number;
  /** Look-ahead (ms) so word onsets aren't clipped. Default 200. */
  prerollMs?: number;
}

interface VoiceConfig {
  enabled: boolean;
  publicApiConfigured: boolean;
}

export class VoiceSession {
  private apiBase: string;
  private sessionId: number;
  private cb: VoiceCallbacks;
  private gate: NoiseGateOptions;

  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;

  private playing = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private stopped = false;

  constructor(
    apiBase: string,
    sessionId: number,
    cb: VoiceCallbacks,
    gate: NoiseGateOptions = {},
  ) {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.sessionId = sessionId;
    this.cb = cb;
    this.gate = gate;
  }

  private setState(s: VoiceState) {
    this.cb.onState?.(s);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.setState('connecting');

    const cfg = await this.fetchJson<VoiceConfig>('/voice/config');
    if (!cfg.enabled) {
      throw new Error('Voice is not configured (missing DEEPGRAM_API_KEY).');
    }
    if (!cfg.publicApiConfigured) {
      throw new Error(
        'PUBLIC_API_URL is not set — Deepgram needs a public URL to reach Aira.',
      );
    }

    // Microphone capture at 16 kHz (no client-side resampling needed).
    // The browser's own noise suppression runs first; our gate is the backstop.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.inputCtx = new AudioContext({ sampleRate: 16000 });
    await this.inputCtx.audioWorklet.addModule('/voice-recorder-worklet.js');
    const source = this.inputCtx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.inputCtx, 'recorder-processor', {
      processorOptions: {
        openThreshold: this.gate.openThreshold ?? 0.022,
        closeThreshold: this.gate.closeThreshold ?? 0.012,
        holdMs: this.gate.holdMs ?? 700,
        prerollMs: this.gate.prerollMs ?? 200,
      },
    });
    source.connect(this.worklet);
    // Intentionally not connected to destination (avoids local echo).

    this.outputCtx = new AudioContext({ sampleRate: 24000 });
    await this.outputCtx.resume();

    this.worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(e.data);
      }
    };

    // Connect to our backend proxy (it holds the Deepgram key + sends Settings).
    const wsBase = this.apiBase.replace(/^http/, 'ws');
    this.ws = new WebSocket(`${wsBase}/voice/agent?sessionId=${this.sessionId}`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.setState('listening');
    };

    this.ws.onmessage = (e) => this.onMessage(e);

    this.ws.onerror = () => {
      if (this.stopped) return;
      this.cb.onError?.('Voice connection error.');
      this.setState('error');
    };

    this.ws.onclose = () => {
      if (!this.stopped) this.setState('idle');
    };
  }

  /** Adjust gate sensitivity live (e.g. from a UI slider). */
  setSensitivity(gate: NoiseGateOptions) {
    this.gate = { ...this.gate, ...gate };
    this.worklet?.port.postMessage({ type: 'gate', ...this.gate });
  }

  private onMessage(e: MessageEvent) {
    if (typeof e.data === 'string') {
      let event: { type?: string; role?: string; content?: string };
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handleEvent(event);
      return;
    }
    // Binary = agent TTS audio (linear16 24 kHz).
    if (e.data instanceof ArrayBuffer) this.enqueueAudio(e.data);
  }

  private handleEvent(event: {
    type?: string;
    role?: string;
    content?: string;
  }) {
    switch (event.type) {
      case 'UserStartedSpeaking':
        // Barge-in: stop Aira immediately so it listens.
        this.flushPlayback();
        this.setState('listening');
        break;
      case 'AgentThinking':
        this.setState('thinking');
        break;
      case 'AgentStartedSpeaking':
        this.setState('speaking');
        break;
      case 'AgentAudioDone':
        if (this.playing.size === 0) this.setState('listening');
        break;
      case 'ConversationText':
        if (
          (event.role === 'user' || event.role === 'assistant') &&
          event.content
        ) {
          this.cb.onTranscript?.(event.role, event.content);
        }
        break;
      case 'Error':
        this.cb.onError?.(event.content || 'Deepgram error');
        break;
      default:
        break;
    }
  }

  private enqueueAudio(data: ArrayBuffer) {
    const ctx = this.outputCtx;
    if (!ctx) return;

    const pcm = new Int16Array(data);
    if (pcm.length === 0) return;
    const buffer = ctx.createBuffer(1, pcm.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 0x8000;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, this.nextStartTime);
    src.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.playing.add(src);
    this.setState('speaking');
    src.onended = () => {
      this.playing.delete(src);
      if (this.playing.size === 0 && !this.stopped) this.setState('listening');
    };
  }

  private flushPlayback() {
    for (const src of this.playing) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.playing.clear();
    this.nextStartTime = 0;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`);
    if (!res.ok) throw new Error(`${path} failed (${res.status})`);
    return (await res.json()) as T;
  }

  stop() {
    this.stopped = true;
    this.flushPlayback();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (this.worklet) this.worklet.port.onmessage = null;
    this.worklet?.disconnect();
    this.worklet = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.inputCtx?.close();
    void this.outputCtx?.close();
    this.inputCtx = null;
    this.outputCtx = null;
    this.setState('idle');
  }
}
