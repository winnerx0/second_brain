import { Client, StdioClientTransport } from "@modelcontextprotocol/client";
import { tool } from "langchain/tools";
import { z } from "zod";
import { config } from "../config";

export class NotionMcpClient {
  client: Client;

  transport: StdioClientTransport;

  constructor() {
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { ...process.env, NOTION_TOKEN: config.NOTION_TOKEN },
    });
    this.client = new Client({ name: "notion", version: "1.0.0" });
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async load() {
    const { tools } = await this.client.listTools();
    return tools;
  }

  async getTools(names: string[]) {
    const { tools: mcpTools } = await this.client.listTools();
    return mcpTools
      .filter((t) => names.includes(t.name))
      .map((t) =>
        tool(
          async (input: Record<string, unknown>) => {
            const result = await this.client.callTool({ name: t.name, arguments: input });
            return JSON.stringify(result.content);
          },
          {
            name: t.name,
            description: t.description ?? t.name,
            schema: z.record(z.any()),
          },
        ),
      );
  }
}
