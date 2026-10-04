import { Hono, type Context } from 'hono';
import { workflowRoutes } from './workflows/routes.js';
import { cors } from 'hono/cors';
import {
  runBriefing,
  handleMessage,
  type AgentStreamEvent,
} from './agent.js';
import { sendTelegramMessage } from './delivery/telegram.js';
import { runMemoryCleanup } from './memory-cleanup.js';
import { runMaintenance } from './memory/heal.js';
import { logger } from './logger.js';
import { db } from './db/client.js';
import {
  chatHistory,
  chatSessions,
  graphNodes,
  graphEdges,
  connections,
} from './db/schema.js';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  buildAuthUrl,
  handleCallback,
  disconnectOAuth,
  getAppUrl,
  OAUTH_CONFIGS,
} from './oauth.js';
import { config } from './config.js';
import { voiceLlmHandler } from './voice/llm-adapter.js';
import { createVoiceBridge } from './voice/proxy.js';
import { createBunWebSocket } from 'hono/bun';
import { kiviaHonoMiddleware } from '@kivia/sdk';

const { upgradeWebSocket, websocket } = createBunWebSocket();
export { websocket };
const API_KEY_CONNECTIONS = new Set(['clickup']);
const REMOVED_CONNECTIONS = new Set(['linkedin']);
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

const kivia = kiviaHonoMiddleware({ apiKey: config.KIVIA_API_KEY });

app.use(kivia);

import { Oluso } from 'oluso';

const oluso = process.env.OLUSO_API_KEY
  ? new Oluso({
      apiKey: process.env.OLUSO_API_KEY,
      environment: 'development',
    })
  : undefined;

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
    const cause =
      error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const causeText =
      cause instanceof Error
        ? `\nCaused by: ${cause.stack ?? cause.message}`
        : cause !== undefined
          ? `\nCaused by: ${typeof cause === 'string' ? cause : JSON.stringify(cause)}`
          : '';
    logger.error(
      `[sessions.list] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}${causeText}`,
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
        id: graphNodes.id,
        key: graphNodes.key,
        value: graphNodes.value,
        classification: graphNodes.classification,
        tier: graphNodes.tier,
        importance: graphNodes.importance,
        createdAt: graphNodes.createdAt,
        updatedAt: graphNodes.updatedAt,
      })
      .from(graphNodes)
      .where(
        and(eq(graphNodes.kind, 'memory'), eq(graphNodes.status, 'active')),
      )
      .orderBy(desc(graphNodes.updatedAt));

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
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const value = typeof body.value === 'string' ? body.value.trim() : '';
    if (!value) return c.json({ error: 'value is required' }, 400);

    const [updated] = await db
      .update(graphNodes)
      .set({ value, updatedAt: new Date() })
      .where(and(eq(graphNodes.id, id), eq(graphNodes.kind, 'memory')))
      .returning();

    if (!updated) return c.json({ error: 'Memory not found' }, 404);
    return c.json({ memory: updated });
  } catch (error) {
    logger.error('[memories.patch]', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to update memory',
      },
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
      .delete(graphNodes)
      .where(and(eq(graphNodes.id, id), eq(graphNodes.kind, 'memory')))
      .returning({ id: graphNodes.id });
    if (result.length === 0) return c.json({ error: 'Memory not found' }, 404);
    return c.json({ success: true });
  } catch (error) {
    logger.error('[memories.delete]', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete memory',
      },
      500,
    );
  }
});

app.post('/memories/cleanup', async (c) => {
  let body: { dryRun?: unknown; concurrency?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine; defaults apply
  }

  const dryRun = body.dryRun === undefined ? false : Boolean(body.dryRun);
  const concurrency =
    typeof body.concurrency === 'number' && body.concurrency > 0
      ? Math.min(Math.floor(body.concurrency), 8)
      : 4;

  try {
    const summary = await runMemoryCleanup({ dryRun, concurrency });
    return c.json({ dryRun, ...summary });
  } catch (error) {
    logger.error('[memories.cleanup]', error);
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to run memory cleanup',
      },
      500,
    );
  }
});

/* ─── Connections ───────────────────────────────────────────────────────────── */

app.get('/connections', async (c) => {
  try {
    const rows = (
      await db
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
        .orderBy(asc(connections.id))
    ).filter((row) => !REMOVED_CONNECTIONS.has(row.name));

    const oauthSupported = Object.keys(OAUTH_CONFIGS);
    return c.json({
      connections: rows.map(({ accessToken, ...r }) => ({
        ...r,
        oauthSupported: oauthSupported.includes(r.name),
        oauthConfigured: Boolean(
          process.env[OAUTH_CONFIGS[r.name]?.clientIdEnv ?? ''],
        ),
        apiKeySupported: API_KEY_CONNECTIONS.has(r.name),
        apiKeyConnected:
          API_KEY_CONNECTIONS.has(r.name) && Boolean(accessToken),
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
    if (REMOVED_CONNECTIONS.has(name.toLowerCase()))
      return c.json({ error: `"${name}" is no longer supported` }, 400);

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
    const rawBody = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const apiKey =
      typeof rawBody.apiKey === 'string' ? rawBody.apiKey.trim() : '';
    if (!apiKey) return c.json({ error: 'apiKey is required' }, 400);

    await db
      .update(connections)
      .set({
        accessToken: apiKey,
        oauthConnected: true,
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(connections.name, name));

    logger.info(`[connections] ${name} api key saved`);
    return c.json({ ok: true });
  } catch (error) {
    logger.error('[connections.apikey.put]', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to save API key',
      },
      500,
    );
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
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to remove API key',
      },
      500,
    );
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

type TelegramMessage = {
  text?: string;
  chat?: { id?: string | number };
};

type ChatRequestBody = {
  message?: string | TelegramMessage;
  text?: string;
  update_id?: number;
};

function getIncomingChatText(body: ChatRequestBody): string {
  if (typeof body.text === 'string') return body.text;
  if (typeof body.message === 'string') return body.message;
  if (
    typeof body.message === 'object' &&
    body.message !== null &&
    typeof body.message.text === 'string'
  ) {
    return body.message.text;
  }
  return '';
}

function isTelegramUpdate(body: ChatRequestBody): body is ChatRequestBody & {
  message: TelegramMessage;
} {
  return typeof body.message === 'object' && body.message !== null;
}

function isAllowedTelegramChat(message: TelegramMessage): boolean {
  const chatId = message.chat?.id;
  if (chatId === undefined || chatId === null) return false;
  return String(chatId) === String(config.TELEGRAM_CHAT_ID);
}

function isDuplicateUpdate(updateId: number | undefined): boolean {
  if (typeof updateId !== 'number') return false;
  if (processedUpdateIds.has(updateId)) return true;

  processedUpdateIds.add(updateId);
  if (processedUpdateIds.size > 10_000) processedUpdateIds.clear();
  return false;
}

app.post('/chat', async (c) => {
  const body = await c.req.json<ChatRequestBody>();
  const text = getIncomingChatText(body).trim();

  if (!text)
    return c.json({ success: false, error: 'Message text required' }, 400);

  if (isDuplicateUpdate(body.update_id)) {
    logger.warn(
      `[chat] duplicate message received with update_id: ${body.update_id}`,
    );
    return c.json({ success: false, error: 'Duplicate message' });
  }

  if (isTelegramUpdate(body) && !isAllowedTelegramChat(body.message)) {
    logger.warn('[telegram] ignored message from unauthorized chat');
    return c.json({ success: false, error: 'Unauthorized Telegram chat' }, 403);
  }

  logger.info(`[chat] received: ${text}`);

  const reply = await handleMessage(text);

  if (isTelegramUpdate(body)) {
    await sendTelegramMessage(reply);
  }

  return c.json({ success: true, reply });
});

app.post('/telegram/webhook', async (c) => {
  const body = await c.req.json<ChatRequestBody>();
  const text = getIncomingChatText(body).trim();

  if (!text) return c.json({ success: true, ignored: true });
  if (isDuplicateUpdate(body.update_id)) {
    logger.warn(
      `[telegram] duplicate update received with update_id: ${body.update_id}`,
    );
    return c.json({ success: true, duplicate: true });
  }

  if (isTelegramUpdate(body) && !isAllowedTelegramChat(body.message)) {
    logger.warn('[telegram] ignored message from unauthorized chat');
    return c.json({ success: true, ignored: true });
  }

  logger.info(`[telegram] received: ${text}`);

  const reply = await handleMessage(text);
  await sendTelegramMessage(reply);

  return c.json({ success: true });
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

app.post('/cron/maintenance', async (c) => {
  if (!authorizeCron(c)) return c.json({ error: 'Unauthorized' }, 401);

  try {
    logger.info('Running memory-graph maintenance via cron endpoint');
    const summary = await runMaintenance();
    return c.json({ success: true, summary });
  } catch (error) {
    logger.error('[cron.maintenance]', error);
    return c.json(
      { error: error instanceof Error ? error.message : 'Maintenance failed' },
      500,
    );
  }
});

/* ─── Memory graph ───────────────────────────────────────────────────────── */

app.get('/graph', async (c) => {
  try {
    const kind = c.req.query('kind');
    const status = c.req.query('status') ?? 'active';

    const conditions = [] as ReturnType<typeof eq>[];
    if (status !== 'all') conditions.push(eq(graphNodes.status, status));
    if (kind) conditions.push(eq(graphNodes.kind, kind));

    const nodes = await db
      .select({
        id: graphNodes.id,
        kind: graphNodes.kind,
        name: graphNodes.name,
        key: graphNodes.key,
        value: graphNodes.value,
        classification: graphNodes.classification,
        tier: graphNodes.tier,
        importance: graphNodes.importance,
        status: graphNodes.status,
        recallCount: graphNodes.recallCount,
        source: graphNodes.source,
        confidence: graphNodes.confidence,
      })
      .from(graphNodes)
      .where(conditions.length ? and(...conditions) : undefined);

    const nodeIds = new Set(nodes.map((n) => n.id));
    const allEdges = await db
      .select({
        id: graphEdges.id,
        fromNodeId: graphEdges.fromNodeId,
        toNodeId: graphEdges.toNodeId,
        relation: graphEdges.relation,
        weight: graphEdges.weight,
        confidence: graphEdges.confidence,
        createdBy: graphEdges.createdBy,
      })
      .from(graphEdges);
    // Only return edges whose endpoints are both in the returned node set.
    const edges = allEdges.filter(
      (e) => nodeIds.has(e.fromNodeId) && nodeIds.has(e.toNodeId),
    );

    return c.json({ nodes, edges });
  } catch (error) {
    logger.error('[graph]', error);
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load graph',
      },
      500,
    );
  }
});

app.post('/graph/maintenance', async (c) => {
  let body: { dryRun?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine
  }
  const dryRun = Boolean(body.dryRun);

  try {
    const summary = await runMaintenance({ dryRun });
    return c.json({ dryRun, summary });
  } catch (error) {
    logger.error('[graph.maintenance]', error);
    return c.json(
      { error: error instanceof Error ? error.message : 'Maintenance failed' },
      500,
    );
  }
});

/* ─── Workflows ──────────────────────────────────────────────────────────── */

app.route('/workflows', workflowRoutes);

/* ─── Voice (Deepgram Voice Agent) ──────────────────────────────────────────── */

// Lets the voice screen know whether voice is usable before connecting.
app.get('/voice/config', (c) => {
  return c.json({
    enabled: Boolean(config.DEEPGRAM_API_KEY),
    publicApiConfigured: Boolean(config.PUBLIC_API_URL),
  });
});

// Browser <-> Deepgram Voice Agent proxy. We hold the authenticated Deepgram
// connection (the long-lived key never reaches the browser), and the Settings
// message — including the think-endpoint secret — is built server-side.
app.get(
  '/voice/agent',
  upgradeWebSocket((c) => {
    const sessionIdRaw = c.req.query('sessionId');
    const sessionId = sessionIdRaw ? Number(sessionIdRaw) : undefined;
    const bridge = createVoiceBridge(sessionId);

    return {
      onOpen(_evt, ws) {
        bridge.onClientOpen({
          send: (data) => ws.send(data as never),
          close: (code, reason) => ws.close(code, reason),
        });
      },
      onMessage(evt) {
        bridge.onClientMessage(evt.data as string | ArrayBuffer | Uint8Array);
      },
      onClose() {
        bridge.onClientClose();
      },
    };
  }),
);

// OpenAI-compatible "think" endpoint Deepgram calls server-to-server.
// Aliased with /v1 in case Deepgram appends the version segment.
app.post('/voice/llm/chat/completions', voiceLlmHandler);
app.post('/voice/llm/v1/chat/completions', voiceLlmHandler);

app.onError((error, c) => {
  logger.error('[http]', error);
  void oluso
    ?.captureException(error, { method: c.req.method, path: c.req.path })
    .catch((reportError) => logger.error('[error-reporting]', reportError));
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
