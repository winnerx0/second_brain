import { Hono } from "hono";
import { runBriefing, handleMessage } from "./agent.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { CronJob } from "cron";
import { createLogger, format, transports } from "winston";

const app = new Hono();

export const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
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
  const content = await handleMessage(message.text);
  await sendTelegramMessage(content).catch((err) =>
    logger.error("[telegram]", err),
  );
  return c.json({ content });
});

export default app;
