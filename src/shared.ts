import { config } from "./config";
import { mcpClient } from "./mcp/mcp";
import { ChatOpenAI } from "@langchain/openai";

export const mcpTools = await mcpClient.getTools();

export const model = new ChatOpenAI({
  apiKey: config.OPENAI_API_KEY,
  model: "gpt-4.1-mini",
  temperature: 1,
  maxRetries: 3,
});