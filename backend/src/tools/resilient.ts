import { tool } from 'langchain';
import { logger } from '../logger.js';

// A minimal structural view of a LangChain tool so the decorator stays generic.
interface ToolLike {
  name: string;
  description?: string;
  schema?: unknown;
  invoke: (input: unknown, config?: unknown) => Promise<unknown>;
}

const TRANSIENT_HINTS = [
  'timeout',
  'timed out',
  'rate limit',
  'rate-limit',
  '429',
  '500',
  '502',
  '503',
  '504',
  'econnreset',
  'etimedout',
  'socket hang up',
  'network',
  'temporarily',
  'try again',
  'overloaded',
];

/** A tool result is a "soft failure" worth one retry only if it looks transient. */
function isTransientResult(out: unknown): boolean {
  if (typeof out !== 'string') return false;
  const s = out.toLowerCase();
  const looksLikeError = s.startsWith('error') || s.includes('failed');
  return looksLikeError && TRANSIENT_HINTS.some((h) => s.includes(h));
}

function isTransientError(err: unknown): boolean {
  const s = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_HINTS.some((h) => s.includes(h)) || s.includes('fetch');
}

export interface ResilientOptions {
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Generic decorator that wraps any LangChain tool with retry + uniform error handling.
 * Thrown errors retry with linear backoff; transient-looking error strings retry once;
 * deterministic failures pass straight through. After exhausting retries the failure is
 * normalised into a single "Error: ..." string so the agent always gets a clean signal.
 */
export function resilientTool<T extends ToolLike>(
  original: T,
  opts: ResilientOptions = {},
): T {
  const retries = opts.retries ?? 1;
  const baseDelay = opts.baseDelayMs ?? 400;

  const wrapped = tool(
    async (input: unknown, config: unknown) => {
      let lastResult: unknown = `Error: ${original.name} produced no result`;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const out = await original.invoke(input, config);
          if (attempt < retries && isTransientResult(out)) {
            logger.warn(
              `[resilient] ${original.name} transient failure (attempt ${attempt + 1}/${retries + 1}); retrying`,
            );
            lastResult = out;
          } else {
            return out;
          }
        } catch (err) {
          lastResult = `Error: ${original.name} failed: ${err instanceof Error ? err.message : String(err)}`;
          if (attempt >= retries || !isTransientError(err)) {
            logger.error(`[resilient] ${original.name} error (no further retries)`, err);
            return lastResult;
          }
          logger.warn(
            `[resilient] ${original.name} threw (attempt ${attempt + 1}/${retries + 1}); retrying`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, baseDelay * (attempt + 1)));
      }
      return lastResult;
    },
    {
      name: original.name,
      description: original.description ?? '',
      // Reuse the original schema so the agent sees an identical tool contract.
      schema: original.schema as never,
    },
  );

  return wrapped as unknown as T;
}
