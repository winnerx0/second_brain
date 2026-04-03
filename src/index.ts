import { Hono } from "hono";
import { runBriefing, handleMessage } from "./agent.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { CronJob } from "cron";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});

const cron = new CronJob("0 0 * * *", async () => {
  try {
    await runBriefing();
  } catch (error) {
    console.error("[cron]", error);
  }
});

cron.start();

app.post("/chat", async (c) => {
  const { message } = await c.req.json<{ message: { text: string } }>();
  const content = await handleMessage(message.text);
  await sendTelegramMessage(content).catch((err) =>
    console.error("[telegram]", err),
  );
  return c.json({ content });
});

export default app;
