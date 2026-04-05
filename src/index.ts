import { Hono } from "hono";
import { runBriefing, handleMessage } from "./agent.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { CronJob } from "cron";
import { logger } from "./logger.ts";

const app = new Hono();

app.use((c, next) => {
  const start = Date.now();
  return next().then(() => {
    const end = Date.now();
    logger.info(`[latency] ${end - start}ms`);
  });
});

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
  const { message } = await c.req.json<{ message: { text: string } }>();
  logger.info(`[chat] received: ${message.text}`);

  // Respond immediately so Telegram doesn't retry the webhook
  handleMessage(message.text)
    .then((content) => sendTelegramMessage(content))
    .catch((err) => logger.error("[chat]", err));

  return c.json({ ok: true });
});

export default app;
