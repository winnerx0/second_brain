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
      env: { ...process.env, OPENAPI_MCP_HEADERS: `{"Authorization":"Bearer ${config.NOTION_TOKEN}","Notion-Version":"2022-06-28"}` },
      restart: {
        enabled: true,
        maxAttempts: 3,
        delayMs: 1000,
      },
    },
  },
});
