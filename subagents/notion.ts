import { createAgent, tool } from "langchain";
import { mcpTools, model } from "../src/shared";
import { notionTools } from "../src/tools/notion";
import z from "zod";

const notionMcpTools = mcpTools.filter((tool) => tool.name.includes("API-"));

const NOTION_SYSTEM_PROMPT = `You are a Notion Workspace Assistant with access to pages, databases, and content blocks.

When helping users:
- Search existing pages/databases before creating new ones to avoid duplicates
- When creating pages, use clear titles and structure content with proper headings
- For databases: understand the schema before adding entries
- Summarize page contents when asked, preserving key details
- When updating content, append or edit without overwriting important data
- Always confirm destructive actions (deleting pages, trashing databases)
- If the user refers to "that page" or "my notes" without specifics, search recent items first
- Respect Notion's block structure — content is organized as blocks, not just plain text

IMPORTANT - Creating Pages with Content (Two-Step Process):
There is a known bug where API-post-page's "children" parameter has an incorrect schema. To work around this:

1. FIRST: Create the page WITHOUT any children (only title and parent)
2. THEN: Use API-patch-block-children with the new page ID as block_id to add content

When using API-patch-block-children, prefer the minimal block shape first:
{
  "block_id": "the-page-id-from-step-1",
  "children": [
    {
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "type": "text", "text": { "content": "your text here" } }]
      }
    }
  ]
}

Do NOT include extra fields unless required by the current schema.

Common block types: paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, to_do.
NEVER pass "children" to API-post-page - always add content separately using API-patch-block-children.`;

const SCHEMA_ERROR_RECOVERY = `
If any Notion API tool fails with schema validation:
- Retry once with a simpler payload (remove optional fields and unknown keys)
- For append-block operations, try children blocks without "object"
- If API-post-page rejects children, create page without children then append in a second call
- If MCP API-* schema remains blocked, use fallback local tools:
  - create_notion_page
  - append_notion_content
  - search_notion
Always complete the user intent whenever possible instead of asking for manual Notion edits.
`;

const notionAgent = createAgent({ model, tools: [...notionMcpTools, ...notionTools] });

export const notionTool = tool(
  async ({ query }) => {
    const response = await notionAgent.invoke({
      messages: [
        { role: "system", content: `${NOTION_SYSTEM_PROMPT}\n${SCHEMA_ERROR_RECOVERY}` },
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
