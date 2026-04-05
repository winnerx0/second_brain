import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { config } from "../config";

export const mcpClient = new MultiServerMCPClient({
  throwOnLoadError: true,

  useStandardContentBlocks: true,

  mcpServers: {
    notion: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: {
        OPENAPI_MCP_HEADERS: `{"Authorization":"Bearer ${config.NOTION_TOKEN}","Notion-Version":"2025-09-03"}`,
      },
      restart: {
        enabled: true,
        maxAttempts: 3,
        delayMs: 1000,
      },
    },

    "google-docs": {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@a-bonus/google-docs-mcp"],
      env: {
        GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: config.GOOGLE_CLIENT_SECRET,
      },
      restart: {
        enabled: true,
        maxAttempts: 3,
        delayMs: 1000,
      },
    },
  },
});
