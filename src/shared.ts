import { config } from "./config";
import { mcpClient } from "./mcp/mcp";
import { ChatOpenRouter } from "@langchain/openrouter";
import { ChatOpenAI } from "@langchain/openai";

export const mcpTools = await mcpClient.getTools();

// export const model = new ChatOpenRouter({
//   apiKey: config.OPENROUTER_API_KEY,
//   model: "deepseek/deepseek-v3.2",
//   baseURL: config.OPENROUTER_BASE_URL,
//   temperature: 1,
//   maxRetries: 3,
// });

export const model = new ChatOpenAI({
  apiKey: config.OPENAI_API_KEY,
  model: "gpt-4.1-nano",
  temperature: 1,
  maxRetries: 3,
});
