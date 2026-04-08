import { createAgent, tool } from "langchain";
import { model } from "../src/agent";
import { mcpClient } from "../src/mcp/mcp";
import z from "zod";

const mcpTools = await mcpClient.getTools();

const notionMcpTools = mcpTools.filter((tool) => {
  const name = tool.name.toLowerCase();
  return (
    name.includes("notion") ||
    name.includes("page") ||
    name.includes("database") ||
    name.includes("block")
  );
});

const NOTION_SYSTEM_PROMPT = `You are a Notion Workspace Assistant with access to pages, databases, and content blocks.

When helping users:
- Search existing pages/databases before creating new ones to avoid duplicates
- When creating pages, use clear titles and structure content with proper headings
- For databases: understand the schema before adding entries
- Summarize page contents when asked, preserving key details
- When updating content, append or edit without overwriting important data
- Always confirm destructive actions (deleting pages, trashing databases)
- If the user refers to "that page" or "my notes" without specifics, search recent items first
- Respect Notion's block structure — content is organized as blocks, not just plain text`;

const notionAgent = createAgent({ model, tools: notionMcpTools });

export const notionTool = tool(
  async ({ query }) => {
    const response = await notionAgent.invoke({
      messages: [
        { role: "system", content: NOTION_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
  },
  {
    name: "notion",
    description: "Create, search, read, and update Notion pages and databases. Can manage structured content, query databases, and organize workspace information.",
    schema: z.object({
      query: z
        .string()
        .describe("Natural language request for Notion operations (e.g., 'Create a page titled Meeting Notes', 'Find my sprint planning database', 'Add a task to my todo list')"),
    }),
  },
);
