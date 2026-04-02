import { Hono } from "hono";
import { runBriefing, handleMessage } from "./agent.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});

app.post("/cron", async (c) => {
  try {
    const briefing = await runBriefing();
    return c.json({ success: true, briefing });
  } catch (error) {
    console.error("[cron]", error);
    return c.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

app.post("/chat", async (c) => {
  const { message } = await c.req.json<{ message: string }>();
  const content = await handleMessage(message);
  await sendTelegramMessage(content).catch((err) => console.error("[telegram]", err));
  return c.json({ content });
});

export default app;
