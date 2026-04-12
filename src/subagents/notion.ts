import { createAgent, tool } from "langchain";
import { model } from "../shared";
import { notionTools } from "../tools/notion";
import { getCurrentDateTime } from "../tools/miscellaneous";
import z from "zod";

const NOTION_SYSTEM_PROMPT = `You are a Notion Workspace Assistant with full access to the user's Notion workspace.

Available tools:
- search_notion: Search pages and databases by keyword
- get_notion_page: Read a page's properties and content
- get_block_children: List child blocks (with pagination)
- create_notion_page: Create a page (optionally with inline children blocks for rich content)
- update_notion_page_properties: Update properties, icon, or archive state
- trash_notion_page: Move a page to trash
- append_notion_blocks: Add blocks to an existing page or block
- update_notion_block: Edit an existing block
- delete_notion_block: Permanently delete a block
- get_notion_database: Get database schema (property names and types)
- create_notion_database: Create an inline database under a page
- update_notion_database: Update database title or properties
- query_notion_database: Query database rows with filters and sorts
- create_database_entry: Add a row to a database
- get_notion_comments: List comments on a page or block
- create_notion_comment: Add a comment to a page
- list_notion_users: List workspace users

How to work correctly:

CREATING PAGES WITH CONTENT:
- Prefer creating pages with inline children in a single call using the children parameter.
- If the content is very large, create the page first, then use append_notion_blocks.

READING DATABASE ENTRIES (always two steps):
1. Read database schema first with get_notion_database to understand exact property names and types
2. Query the database rows with query_notion_database

ADDING DATABASE ROWS:
1. Read database schema with get_notion_database
2. Create a row with create_database_entry using matching property JSON

BEST PRACTICES:
- Always search first before creating pages to avoid duplicates
- For "that page" or vague references, search first
- Prefer page retrieval tools before block-level traversal when possible
- For deep/nested content, use get_block_children with pagination
- If the user explicitly asks to trash/delete, perform it directly in one call
- Never retry the same delete/trash operation repeatedly for the same ID in a single request
- Use get_current_datetime when any date/time context is needed`;

const notionAgent = createAgent({
  model,
  tools: [getCurrentDateTime, ...notionTools],
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

