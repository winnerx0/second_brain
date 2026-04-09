import { Hono } from "hono";
import { runBriefing, handleMessage } from "./agent.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { CronJob } from "cron";
import { logger } from "./logger.ts";
import { KiviaClient } from "@kivia/sdk"
import { env } from "bun";
const app = new Hono();

const kivia = new KiviaClient({
  apiKey: env.KIVIA_API_KEY!,
});
app.use("*", kivia.logHono());

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});

const cron = new CronJob("0 0 * * *", async () => {
  try {
    logger.info("Running briefing cron job");
    await runBriefing();
  } catch (error) {
    logger.error("[cron]", error);
  }
});

cron.start();

const processedUpdates = new Set<number>();

app.post("/chat", async (c) => {
  const body = await c.req.json<{ update_id: number; message: { text: string } }>();
  const { update_id, message } = body;

  if (processedUpdates.has(update_id)) {
    logger.info(`[chat] skipping duplicate update_id=${update_id}`);
    return c.json({ success: true });
  }
  processedUpdates.add(update_id);

  logger.info(`[chat] received: ${message.text}`);

  const reply = await handleMessage(message.text);
  await sendTelegramMessage(reply);

  return c.json({ success: true });
});

export default app;
