import { Client, StdioClientTransport } from "@modelcontextprotocol/client";
import { env } from "bun";

export class NotionMcpClient {
  client: Client;

  transport: StdioClientTransport;

  constructor() {
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { ...process.env, NOTION_TOKEN: env.NOTION_TOKEN },
    });
    this.client = new Client({ name: "notion", version: "1.0.0" });
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async load() {
    return await this.client.listTools();
  }
}
