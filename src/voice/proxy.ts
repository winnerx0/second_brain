import { config } from '../config.js';
import { logger } from '../logger.js';

const VOICE_AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';

function buildSettings(sessionId: number | undefined) {
  const base = (config.PUBLIC_API_URL ?? '').replace(/\/$/, '');
  const thinkUrl = `${base}/voice/llm/chat/completions?sessionId=${sessionId ?? ''}`;
  return {
    type: 'Settings',
    audio: {
      input: { encoding: 'linear16', sample_rate: 16000 },
      output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
    },
    agent: {
      language: 'en',
      listen: { provider: { type: 'deepgram', model: 'nova-3' } },
      think: {
        provider: { type: 'open_ai', model: 'aira' },
        endpoint: {
          url: thinkUrl,
          headers: config.VOICE_LLM_SECRET
            ? { authorization: `Bearer ${config.VOICE_LLM_SECRET}` }
            : {},
        },
      },
      speak: { provider: { type: 'deepgram', model: 'aura-2-amalthea-en' } },
      greeting: "Hey, I'm Aira. What's on your mind?",
    },
  };
}

/**
 * A minimal interface matching Hono's Bun WSContext (the bits we use).
 */
interface ClientWS {
  send: (data: string | ArrayBuffer | Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
}

/**
 * Creates the per-connection handlers that bridge a browser client WS to a
 * freshly-opened, authenticated Deepgram Voice Agent WS.
 */
export function createVoiceBridge(sessionId: number | undefined) {
  let upstream: WebSocket | null = null;
  let upstreamReady = false;
  let clientClosed = false;
  const pending: (string | ArrayBuffer | Uint8Array)[] = [];

  const openUpstream = (client: ClientWS) => {
    if (!config.DEEPGRAM_API_KEY) {
      logger.error('[voice.proxy] DEEPGRAM_API_KEY not configured');
      client.close(1011, 'voice not configured');
      return;
    }

    upstream = new WebSocket(VOICE_AGENT_URL, [
      'token',
      config.DEEPGRAM_API_KEY,
    ]);
    upstream.binaryType = 'arraybuffer';

    upstream.onopen = () => {
      upstreamReady = true;
      upstream?.send(JSON.stringify(buildSettings(sessionId)));
      // Flush any mic frames that arrived before Deepgram was ready.
      for (const msg of pending) upstream?.send(msg as never);
      pending.length = 0;
    };

    upstream.onmessage = (e: MessageEvent) => {
      if (clientClosed) return;
      try {
        client.send(e.data as string | ArrayBuffer);
      } catch (err) {
        logger.error('[voice.proxy] client send failed', err);
      }
    };

    upstream.onerror = () => {
      logger.error('[voice.proxy] upstream error');
    };

    upstream.onclose = (e: CloseEvent) => {
      if (!clientClosed) client.close(e.code === 1000 ? 1000 : 1011, e.reason);
    };
  };

  return {
    onClientOpen(client: ClientWS) {
      openUpstream(client);
    },
    onClientMessage(data: string | ArrayBuffer | Uint8Array) {
      if (upstream && upstreamReady) {
        upstream.send(data as never);
      } else {
        pending.push(data);
      }
    },
    onClientClose() {
      clientClosed = true;
      try {
        upstream?.close();
      } catch {
        /* ignore */
      }
      upstream = null;
    },
  };
}
