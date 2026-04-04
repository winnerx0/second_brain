import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { config } from "../config";

export const client = new MultiServerMCPClient({
  throwOnLoadError: true,

  useStandardContentBlocks: true,

  mcpServers: {
    notion: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { ...process.env, NOTION_TOKEN: config.NOTION_TOKEN },
      restart: {
        enabled: true,
        maxAttempts: 3,
        delayMs: 1000,
      },
    },
  },
});
