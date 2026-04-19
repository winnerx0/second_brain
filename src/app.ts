import { Hono } from "hono";
import { cors } from "hono/cors";
import { runBriefing, handleMessage, type AgentStreamEvent } from "./agent.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { logger } from "./logger.ts";
import { runMemoryLifecycleReview } from "./tools/memory.ts";
import { db } from "./db/client.ts";
import { chatHistory, chatSessions, memories, memoryCleanupRuns } from "./db/schema.ts";
import { asc, desc, eq } from "drizzle-orm";

const app = new Hono();

function formatSseEvent(event: AgentStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

app.use("*", cors({ origin: "*" }));

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});

app.get("/sessions", async (c) => {
  try {
    const sessions = await db
      .select()
      .from(chatSessions)
      .orderBy(desc(chatSessions.updatedAt));

    return c.json({ sessions });
  } catch (error) {
    logger.error("[sessions.list]", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to list sessions" },
      500,
    );
  }
});

app.post("/sessions", async (c) => {
  try {
    const body = await c.req.json<unknown>().catch(() => ({}));
    const title =
      typeof body === "object" &&
        body !== null &&
        "title" in body &&
        typeof (body as { title?: unknown }).title === "string"
        ? ((body as { title: string }).title.trim() || "New Chat")
        : "New Chat";

    const [created] = await db
      .insert(chatSessions)
      .values({ title, createdAt: new Date(), updatedAt: new Date() })
      .returning();

    return c.json({ session: created }, 201);
  } catch (error) {
    logger.error("[sessions.create]", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to create session" },
      500,
    );
  }
});

app.delete("/sessions/:id", async (c) => {
  const idParam = c.req.param("id");
  const sessionId = Number(idParam);

  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return c.json({ error: "Invalid session id" }, 400);
  }

  try {
    await db.delete(chatHistory).where(eq(chatHistory.sessionId, sessionId));
    await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
    return c.json({ success: true });
  } catch (error) {
    logger.error("[sessions.delete]", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to delete session" },
      500,
    );
  }
});

app.get("/sessions/:id/history", async (c) => {
  const idParam = c.req.param("id");
  const sessionId = Number(idParam);

  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return c.json({ error: "Invalid session id" }, 400);
  }

  try {
    const rows = await db
      .select()
      .from(chatHistory)
      .where(eq(chatHistory.sessionId, sessionId))
      .orderBy(asc(chatHistory.id));

    return c.json({ messages: rows });
  } catch (error) {
    logger.error("[sessions.history]", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to load chat history" },
      500,
    );
  }
});

app.get("/memories", async (c) => {
  try {
    const [rows, cleanupRuns] = await Promise.all([
      db.select().from(memories).orderBy(desc(memories.updatedAt)),
      db.select().from(memoryCleanupRuns).orderBy(desc(memoryCleanupRuns.ranAt)).limit(25),
    ]);

    return c.json({
      memories: rows.map((row) => ({
        id: row.id,
        content: row.content,
        classification: row.classification,
        tier: row.tier,
        importance: row.importance,
        accessCount: row.accessCount,
        createdAt: row.createdAt,
        lastAccessedAt: row.lastAccessedAt,
        expiresAt: row.expiresAt,
        promotedAt: row.promotedAt,
        debateHistory: row.debateHistory,
        metadata: row.metadata,
        updatedAt: row.updatedAt,
      })),
      cleanupRuns: cleanupRuns.map((run) => ({
        id: run.id,
        ranAt: run.ranAt,
        reviewedRows: run.reviewedRows,
        mergedRows: run.mergedRows,
        deletedRows: run.deletedRows,
        promotedRows: run.promotedRows,
      })),
    });
  } catch (error) {
    logger.error("[memories]", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to fetch memories" },
      500,
    );
  }
});

const processedUpdateIds = new Set<string>();

app.post("/chat", async (c) => {
  const body = await c.req.json<{ message: { text: string }; update_id: string }>();
  const { message, update_id } = body;

  if (processedUpdateIds.has(update_id)) {
    logger.warn(`[chat] duplicate message received with update_id: ${update_id}`);
    return c.json({ success: false, error: "Duplicate message" });
  }
  processedUpdateIds.add(update_id);

  logger.info(`[chat] received: ${message.text}`);

  const reply = await handleMessage(message.text);
  await sendTelegramMessage(reply);

  return c.json({ success: true });
});

app.post("/chat/stream", async (c) => {
  const body = await c.req.json<{ message?: string; text?: string; sessionId?: number }>();
  const text = body.message ?? body.text ?? "";
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

      void handleMessage(text, {
        onEvent: sendEvent,
        signal: c.req.raw.signal,
        sessionId,
      })
        .then(() => closeStream())
        .catch((error) => {
          sendEvent({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          closeStream();
        });

      c.req.raw.signal.addEventListener("abort", () => closeStream());
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

app.post("/cron/briefing", async (c) => {
  const authHeader = c.req.header("authorization");
  const secret = process.env.CRON_SECRET;
  if (secret && authHeader !== `Bearer ${secret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    logger.info("Running briefing via cron endpoint");
    await runMemoryLifecycleReview();
    return c.json({ success: true });
  } catch (error) {
    logger.error("[cron.briefing]", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Cron job failed" },
      500,
    );
  }
});

export default app;
