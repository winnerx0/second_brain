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
app.post("/chat", async (c) => {

  const messages = new Set<string>()

  const body = await c.req.json<{ message: { text: string }, update_id: string }>();
  const { message, update_id } = body;

  if (messages.has(update_id)) {
    logger.warn(`[chat] duplicate message received with update_id: ${update_id}`);
    return c.json({ success: false, error: "Duplicate message" });
  }
  messages.add(update_id)

  logger.info(`[chat] received: ${message.text}`);

  const reply = await handleMessage(message.text);
  await sendTelegramMessage(reply);

  return c.json({ success: true });
});

export default app;
