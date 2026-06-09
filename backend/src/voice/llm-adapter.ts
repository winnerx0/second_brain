import type { Context } from 'hono';
import { handleMessage } from '../agent.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

type OpenAIMessage = { role: string; content: unknown };
type OpenAIRequest = { messages?: OpenAIMessage[]; stream?: boolean };

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : typeof part === 'string'
            ? part
            : '',
      )
      .join('');
  }
  return '';
}

function chunk(content: string | null, finish: 'stop' | null): string {
  const payload = {
    id: `chatcmpl-aira-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'aira',
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { content },
        finish_reason: finish,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function voiceLlmHandler(c: Context): Promise<Response> {

  if (config.VOICE_LLM_SECRET) {
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${config.VOICE_LLM_SECRET}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

  const sessionIdRaw = c.req.query('sessionId');
  const sessionId = sessionIdRaw ? Number(sessionIdRaw) : undefined;

  const body = await c.req.json<OpenAIRequest>().catch(() => ({}) as OpenAIRequest);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = messageText(lastUser?.content).trim();

  logger.info(`[voice.llm] session=${sessionId ?? 'none'} input: ${text}`);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      if (!text) {
        safeEnqueue(chunk('Sorry, I did not catch that.', null));
        safeEnqueue(chunk(null, 'stop'));
        safeEnqueue('data: [DONE]\n\n');
        close();
        return;
      }

      // Open the assistant message.
      safeEnqueue(chunk('', null));

      handleMessage(text, {
        sessionId,
        signal: c.req.raw.signal,
        onEvent: (event) => {
          // Forward only assistant text; tool/status events are internal.
          if (event.type === 'assistant_delta' && event.delta) {
            safeEnqueue(chunk(event.delta, null));
          }
        },
      })
        .then(() => {
          safeEnqueue(chunk(null, 'stop'));
          safeEnqueue('data: [DONE]\n\n');
          close();
        })
        .catch((error) => {
          logger.error('[voice.llm] handleMessage failed', error);
          safeEnqueue(
            chunk(' Sorry, something went wrong on my end.', null),
          );
          safeEnqueue(chunk(null, 'stop'));
          safeEnqueue('data: [DONE]\n\n');
          close();
        });

      c.req.raw.signal.addEventListener('abort', () => close());
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
