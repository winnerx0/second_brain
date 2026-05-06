import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { runBriefing, handleMessage, runWorkflow, type AgentStreamEvent } from './agent.js';
import { logger } from './logger.js';
import { db } from './db/client.js';
import {
  chatHistory,
  chatSessions,
  memories,
  connections,
  workflows,
  workflowRuns,
} from './db/schema.js';
import { asc, desc, eq } from 'drizzle-orm';
import {
  buildAuthUrl,
  handleCallback,
  disconnectOAuth,
  getAppUrl,
  OAUTH_CONFIGS,
} from './oauth.js';
import { config } from './config.js';
import {kiviaHonoMiddleware} from "@kivia/sdk"
const API_KEY_CONNECTIONS = new Set(['clickup']);
// MCP OAuth imports - disabled, using traditional OAuth instead
// import {
//   startMcpOAuthFlow,
//   completeMcpOAuthFlow,
//   usesMcpOAuth,
// } from './mcp/oauth.js';

/* ─── Built-in connections seed ─────────────────────────────────────────────── */
const BUILT_IN_CONNECTIONS = [
  { name: 'github', label: 'GitHub' },
  { name: 'gmail', label: 'Gmail' },
  { name: 'google_calendar', label: 'Google Calendar' },
  { name: 'notion', label: 'Notion' },
  { name: 'anilist', label: 'AniList' },
  { name: 'google_docs', label: 'Google Docs' },
  { name: 'knowledge_graph', label: 'Knowledge Graph' },
  { name: 'spotify', label: 'Spotify' },
  { name: 'clickup', label: 'ClickUp' },
  { name: 'todoist', label: 'Todoist' },
  { name: 'twitter', label: 'Twitter / X' },
] as const;

async function seedConnections() {
  try {
    const existing = await db
      .select({ name: connections.name })
      .from(connections);
    const existingNames = new Set(existing.map((r) => r.name));
    const toInsert = BUILT_IN_CONNECTIONS.filter(
      (c) => !existingNames.has(c.name),
    );
    if (toInsert.length > 0) {
      await db.insert(connections).values(
        toInsert.map((c) => ({
          name: c.name,
          label: c.label,
        })),
      );
      logger.info(`[connections] seeded ${toInsert.length} connection(s)`);
    }
  } catch (err) {
    logger.warn(
      `[connections] seed skipped — table may not exist yet: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
await seedConnections();

const app = new Hono({});

function formatSseEvent(event: AgentStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

app.use('*', cors({ origin: [config.APP_URL] }));

const kivia = kiviaHonoMiddleware({apiKey: config.KIVIA_API_KEY})

app.use(kivia)

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/sessions', async (c) => {
  try {
    const sessions = await db
      .select()
      .from(chatSessions)
      .orderBy(desc(chatSessions.updatedAt));

    return c.json({ sessions });
  } catch (error) {
    const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const causeText =
      cause instanceof Error
        ? `\nCaused by: ${cause.stack ?? cause.message}`
        : cause !== undefined
          ? `\nCaused by: ${typeof cause === 'string' ? cause : JSON.stringify(cause)}`
          : '';
    logger.error(
      `[sessions.list] ${error instanceof Error ? error.stack ?? error.message : String(error)}${causeText}`,
    );
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to list sessions',
      },
      500,
    );
  }
});

app.post('/sessions', async (c) => {
  try {
    const body = await c.req.json<unknown>().catch(() => ({}));
    const title =
      typeof body === 'object' &&
      body !== null &&
      'title' in body &&
      typeof (body as { title?: unknown }).title === 'string'
        ? (body as { title: string }).title.trim() || 'New Chat'
        : 'New Chat';

    const [created] = await db
      .insert(chatSessions)
      .values({
        title,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return c.json({ session: created }, 201);
  } catch (error) {
    logger.error('[sessions.create]', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to create session',
      },
      500,
    );
  }
});

app.delete('/sessions/:id', async (c) => {
  const idParam = c.req.param('id');
  const sessionId = Number(idParam);

  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return c.json({ error: 'Invalid session id' }, 400);
  }

  try {
    await db.delete(chatHistory).where(eq(chatHistory.sessionId, sessionId));
    await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
    return c.json({ success: true });
  } catch (error) {
    logger.error('[sessions.delete]', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete session',
      },
      500,
    );
  }
});

app.get('/sessions/:id/history', async (c) => {
  const idParam = c.req.param('id');
  const sessionId = Number(idParam);

  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return c.json({ error: 'Invalid session id' }, 400);
  }

  try {
    const rows = await db
      .select()
      .from(chatHistory)
      .where(eq(chatHistory.sessionId, sessionId))
      .orderBy(asc(chatHistory.id));

    return c.json({ messages: rows });
  } catch (error) {
    logger.error('[sessions.history]', error);
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load chat history',
      },
      500,
    );
  }
});

app.get('/memories', async (c) => {
  try {
    const rows = await db
      .select({
        id: memories.id,
        key: memories.key,
        value: memories.value,
        classification: memories.classification,
        tier: memories.tier,
        importance: memories.importance,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .orderBy(desc(memories.updatedAt));

    return c.json({ memories: rows });
  } catch (error) {
    logger.error('[memories]', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to fetch memories',
      },
      500,
    );
  }
});

app.patch('/memories/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid memory id' }, 400);
  }

  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const value = typeof body.value === 'string' ? body.value.trim() : '';
    if (!value) return c.json({ error: 'value is required' }, 400);

    const [updated] = await db
      .update(memories)
      .set({ value, updatedAt: new Date() })
      .where(eq(memories.id, id))
      .returning();

    if (!updated) return c.json({ error: 'Memory not found' }, 404);
    return c.json({ memory: updated });
  } catch (error) {
    logger.error('[memories.patch]', error);
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to update memory' },
      500,
    );
  }
});

app.delete('/memories/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid memory id' }, 400);
  }

  try {
    const result = await db
      .delete(memories)
      .where(eq(memories.id, id))
      .returning({ id: memories.id });
    if (result.length === 0) return c.json({ error: 'Memory not found' }, 404);
    return c.json({ success: true });
  } catch (error) {
    logger.error('[memories.delete]', error);
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to delete memory' },
      500,
    );
  }
});

/* ─── Connections ───────────────────────────────────────────────────────────── */

app.get('/connections', async (c) => {
  try {
    const rows = await db
      .select({
        id: connections.id,
        name: connections.name,
        label: connections.label,
        enabled: connections.enabled,
        oauthConnected: connections.oauthConnected,
        accessToken: connections.accessToken,
        createdAt: connections.createdAt,
        updatedAt: connections.updatedAt,
      })
      .from(connections)
      .orderBy(asc(connections.id));

    const oauthSupported = Object.keys(OAUTH_CONFIGS);
    return c.json({
      connections: rows.map(({ accessToken, ...r }) => ({
        ...r,
        oauthSupported: oauthSupported.includes(r.name),
        oauthConfigured: Boolean(
          process.env[OAUTH_CONFIGS[r.name]?.clientIdEnv ?? ''],
        ),
        apiKeySupported: API_KEY_CONNECTIONS.has(r.name),
        apiKeyConnected: API_KEY_CONNECTIONS.has(r.name) && Boolean(accessToken),
      })),
    });
  } catch (error) {
    logger.error('[connections.list]', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to list connections',
      },
      500,
    );
  }
});

app.patch('/connections/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ error: 'Invalid id' }, 400);

  try {
    const rawBody = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (typeof rawBody.enabled !== 'boolean')
      return c.json({ error: 'enabled must be a boolean' }, 400);
    const enabled = rawBody.enabled;

    const [updated] = await db
      .update(connections)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(connections.id, id))
      .returning();

    if (!updated) return c.json({ error: 'Connection not found' }, 404);
    return c.json({ connection: updated });
  } catch (error) {
    logger.error('[connections.patch]', error);
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to update connection',
      },
      500,
    );
  }
});

app.post('/connections', async (c) => {
  try {
    const rawBody = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const name = typeof rawBody.name === 'string' ? rawBody.name : '';
    const label = typeof rawBody.label === 'string' ? rawBody.label : '';
    if (!name || !label)
      return c.json({ error: 'name and label are required' }, 400);

    const [created] = await db
      .insert(connections)
      .values({ name: name.toLowerCase(), label })
      .returning();

    return c.json({ connection: created }, 201);
  } catch (error) {
    logger.error('[connections.create]', error);
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to create connection',
      },
      500,
    );
  }
});

/* ─── API key connections ────────────────────────────────────────────────────── */

app.put('/connections/:name/apikey', async (c) => {
  const name = c.req.param('name');
  if (!API_KEY_CONNECTIONS.has(name))
    return c.json({ error: `${name} does not use API key auth` }, 400);

  try {
    const rawBody = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const apiKey = typeof rawBody.apiKey === 'string' ? rawBody.apiKey.trim() : '';
    if (!apiKey) return c.json({ error: 'apiKey is required' }, 400);

    await db
      .update(connections)
      .set({ accessToken: apiKey, oauthConnected: true, enabled: true, updatedAt: new Date() })
      .where(eq(connections.name, name));

    logger.info(`[connections] ${name} api key saved`);
    return c.json({ ok: true });
  } catch (error) {
    logger.error('[connections.apikey.put]', error);
    return c.json({ error: error instanceof Error ? error.message : 'Failed to save API key' }, 500);
  }
});

app.delete('/connections/:name/apikey', async (c) => {
  const name = c.req.param('name');
  if (!API_KEY_CONNECTIONS.has(name))
    return c.json({ error: `${name} does not use API key auth` }, 400);

  try {
    await db
      .update(connections)
      .set({ accessToken: null, oauthConnected: false, updatedAt: new Date() })
      .where(eq(connections.name, name));

    logger.info(`[connections] ${name} api key removed`);
    return c.json({ ok: true });
  } catch (error) {
    logger.error('[connections.apikey.delete]', error);
    return c.json({ error: error instanceof Error ? error.message : 'Failed to remove API key' }, 500);
  }
});

/* ─── OAuth ─────────────────────────────────────────────────────────────────── */

// Traditional OAuth start (redirects directly)
app.get('/connections/:name/oauth/start', (c) => {
  const name = c.req.param('name');

  const result = buildAuthUrl(name);
  if ('error' in result) return c.json({ error: result.error }, 400);
  return c.redirect(result.url);
});

// MCP OAuth endpoints - disabled, using traditional OAuth instead
// app.get('/connections/:name/mcp-oauth/start', async (c) => {
//   const name = c.req.param('name');
//   const result = await startMcpOAuthFlow(name);
//
//   if ('error' in result) {
//     return c.json({ error: result.error }, 400);
//   }
//
//   return c.json({
//     authorizationUrl: result.url,
//     state: result.state,
//   });
// });

// OAuth callback - traditional OAuth only
app.get('/oauth/callback', async (c) => {
  const { code, state, error } = c.req.query();
  const appUrl = getAppUrl();

  if (error) {
    return c.redirect(
      `${appUrl}/connections?oauth_error=${encodeURIComponent(error)}`,
    );
  }
  if (!code || !state) {
    return c.redirect(`${appUrl}/connections?oauth_error=missing_params`);
  }

  // Traditional OAuth flow only
  const result = await handleCallback(code, state);
  if ('error' in result) {
    return c.redirect(
      `${appUrl}/connections?oauth_error=${encodeURIComponent(result.error)}`,
    );
  }
  return c.redirect(
    `${appUrl}/connections?oauth_connected=${result.connectionName}`,
  );
});

app.delete('/connections/:name/oauth', async (c) => {
  const name = c.req.param('name');
  try {
    await disconnectOAuth(name);
    return c.json({ success: true });
  } catch (error) {
    logger.error('[connections.oauth.disconnect]', error);
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to disconnect',
      },
      500,
    );
  }
});

const processedUpdateIds = new Set<number>();

app.post('/chat', async (c) => {
  const body = await c.req.json<{
    message: { text: string };
    update_id: number;
  }>();
  const { message, update_id } = body;

  if (processedUpdateIds.has(update_id)) {
    logger.warn(`[chat] duplicate message received with update_id: ${update_id}`);
    return c.json({ success: false, error: 'Duplicate message' });
  }
  processedUpdateIds.add(update_id);
  if (processedUpdateIds.size > 10_000) processedUpdateIds.clear();

  logger.info(`[chat] received: ${message.text}`);

  const reply = await handleMessage(message.text);

  return c.json({ success: true, reply });
});

app.post('/chat/stream', async (c) => {
  const body = await c.req.json<{
    message?: string;
    text?: string;
    sessionId?: number;
  }>();
  const text = body.message ?? body.text ?? '';
  const sessionId = body.sessionId;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // ignore
        }
      }, 5000);

      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      const sendEvent = (event: AgentStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        } catch {
          closeStream();
        }
      };

      handleMessage(text, {
        onEvent: sendEvent,
        signal: c.req.raw.signal,
        sessionId,
      })
        .then(() => closeStream())
        .catch((error) => {
          sendEvent({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
          closeStream();
        });

      c.req.raw.signal.addEventListener('abort', () => closeStream());
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
});

function authorizeCron(c: Context) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error('[cron.authorize] CRON_SECRET is not set');
    return false;
  }
  return c.req.header('authorization') === `Bearer ${secret}`;
}

app.post('/cron/briefing', async (c) => {
  if (!authorizeCron(c)) return c.json({ error: 'Unauthorized' }, 401);

  try {
    logger.info('Running briefing via cron endpoint');
    await runBriefing();
    return c.json({ success: true });
  } catch (error) {
    logger.error('[cron.briefing]', error);
    return c.json(
      { error: error instanceof Error ? error.message : 'Cron job failed' },
      500,
    );
  }
});

/* ─── Workflows ──────────────────────────────────────────────────────────── */

app.get('/workflows', async (c) => {
  try {
    const wfs = await db.select().from(workflows).orderBy(desc(workflows.updatedAt));
    return c.json({ workflows: wfs });
  } catch (error) {
    logger.error('[workflows.list]', error);
    return c.json({ error: 'Failed to list workflows' }, 500);
  }
});

app.post('/workflows', async (c) => {
  try {
    const body = await c.req.json() as { name: string; description?: string; plan: string };
    if (!body.name || !body.plan) return c.json({ error: 'Missing name or plan' }, 400);

    const [inserted] = await db
      .insert(workflows)
      .values({
        name: body.name,
        description: body.description || '',
        plan: body.plan,
      })
      .returning();

    return c.json(inserted, 201);
  } catch (error) {
    logger.error('[workflows.create]', error);
    return c.json({ error: 'Failed to create workflow' }, 500);
  }
});

app.patch('/workflows/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json() as { name?: string; description?: string; plan?: string; enabled?: boolean };

    const [updated] = await db
      .update(workflows)
      .set({
        ...body,
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, id))
      .returning();

    return c.json(updated);
  } catch (error) {
    logger.error('[workflows.update]', error);
    return c.json({ error: 'Failed to update workflow' }, 500);
  }
});

app.delete('/workflows/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    await db.delete(workflows).where(eq(workflows.id, id));
    return c.json({ success: true });
  } catch (error) {
    logger.error('[workflows.delete]', error);
    return c.json({ error: 'Failed to delete workflow' }, 500);
  }
});

app.get('/workflows/:id/runs', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    const runs = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, id))
      .orderBy(desc(workflowRuns.ranAt))
      .limit(20);

    return c.json({ runs });
  } catch (error) {
    logger.error('[workflows.runs.list]', error);
    return c.json({ error: 'Failed to list runs' }, 500);
  }
});

app.post('/workflows/:id/run', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    const [wf] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, id));

    if (!wf) return c.json({ error: 'Workflow not found' }, 404);

    const [run] = await db
      .insert(workflowRuns)
      .values({ workflowId: id, status: 'running' })
      .returning();

    if (!run) return c.json({ error: 'Failed to create run' }, 500);

    const chunks: string[] = [];
    let output = '';

    try {
      output = await runWorkflow(id, wf.plan, {
        onEvent: (event) => {
          chunks.push(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        },
      });

      await db
        .update(workflowRuns)
        .set({ status: 'completed', output })
        .where(eq(workflowRuns.id, run.id));

      await db
        .update(workflows)
        .set({ lastRunAt: new Date() })
        .where(eq(workflows.id, id));

      chunks.push('event: done\ndata: null\n\n');
    } catch (error) {
      logger.error('[workflows.run]', error);
      await db
        .update(workflowRuns)
        .set({ status: 'failed' })
        .where(eq(workflowRuns.id, run.id));

      chunks.push(
        `event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : 'Run failed' })}\n\n`,
      );
    }

    return new Response(chunks.join(''), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    logger.error('[workflows.run]', error);
    return c.json({ error: 'Failed to run workflow' }, 500);
  }
});

export default app;
