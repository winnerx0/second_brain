import { createAgent, tool } from "langchain";
import { model } from "../shared";
import { notionTools } from "../tools/notion";
import { getCurrentDateTime } from "../tools/miscellaneous";
import z from "zod";

const NOTION_SYSTEM_PROMPT = `You are a Notion Workspace Assistant with full access to the user's pages, databases, blocks, and comments.

Available operations:
- Search: search_notion — find pages and databases by keyword
- Pages: get_notion_page, create_notion_page, update_notion_page_properties, trash_notion_page
- Blocks: get_block_children, append_notion_blocks, update_notion_block, delete_notion_block
- Databases: get_notion_database, create_notion_database, update_notion_database, query_notion_database, create_database_entry
- Comments: get_notion_comments, create_notion_comment
- Users: list_notion_users

How to work correctly:

CREATING PAGES WITH CONTENT (always two steps):
1. create_notion_page → get the page ID
2. append_notion_blocks with the page ID → add content
Never pass content directly to create_notion_page.

ADDING CONTENT (append_notion_blocks):
Pass a JSON array of block objects. Use the block shapes documented in the tool description.
Example for a structured page:
[
  {"type":"heading_1","heading_1":{"rich_text":[{"type":"text","text":{"content":"Title"}}]}},
  {"type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"Body text"}}]}},
  {"type":"to_do","to_do":{"rich_text":[{"type":"text","text":{"content":"Task"}}],"checked":false}}
]

READING DATABASE ENTRIES (always two steps):
1. get_notion_database → understand the exact property names and types
2. query_notion_database → fetch rows

ADDING DATABASE ROWS:
1. get_notion_database → get schema
2. create_database_entry with matching property JSON

BEST PRACTICES:
- Always search_notion before creating pages to avoid duplicates
- For "that page" or vague references, search first
- When reading a page, use get_notion_page (returns flattened content)
- For deep/nested content, use get_block_children with pagination
- Confirm before trashing or deleting blocks
- Use get_current_datetime when any date/time context is needed`;

const notionAgent = createAgent({
  model,
  tools: [...notionTools, getCurrentDateTime],
});

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
    description:
      "Full Notion workspace access — search, read, create, and edit pages, databases, blocks, and comments.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for Notion operations (e.g., 'Create a meeting notes page', 'Add a task to my Sprint board', 'Find my project tracker database', 'List all Done items in my todo database')",
        ),
    }),
  },
);
