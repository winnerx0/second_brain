import { createAgent, tool } from "langchain";
import { model } from "../shared";
import { mcpTools } from "../shared";
// import { notionTools } from "../tools/notion";
import { getCurrentDateTime } from "../tools/miscellaneous";
import z from "zod";

function flattenAllOf(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  if (Array.isArray(schema.allOf)) {
    const merged = schema.allOf.reduce(
      (acc: any, sub: any) => {
        const flat = flattenAllOf(sub);
        return {
          ...acc,
          ...flat,
          properties: { ...acc.properties, ...flat.properties },
          required: [...new Set([...(acc.required || []), ...(flat.required || [])])],
        };
      },
      { type: "object", properties: {}, required: [] },
    );

    const { allOf, ...rest } = schema;
    return flattenAllOf({ ...merged, ...rest });
  }

  if (schema.properties) {
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([k, v]) => [k, flattenAllOf(v)]),
      ),
    };
  }

  if (schema.items) {
    return { ...schema, items: flattenAllOf(schema.items) };
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return {
      ...schema,
      additionalProperties: flattenAllOf(schema.additionalProperties),
    };
  }

  return schema;
}

const notionMcpTools = mcpTools
  .filter((tool) => tool.name.startsWith("API-"))
  .map((tool) => {
    if (tool.schema && typeof tool.schema === "object") {
      tool.schema = flattenAllOf(tool.schema);
    }
    return tool;
  });

const NOTION_SYSTEM_PROMPT = `You are a Notion Workspace Assistant with full access to the user's Notion workspace through Notion MCP tools.

Available operations are provided by the MCP toolset for pages, blocks, databases, users, comments, and search.

How to work correctly:

CREATING PAGES WITH CONTENT (always two steps):
1. Create the page first and get the page ID
2. Append children blocks in a second call
Do not try to create a page with full children payload in one step when it fails schema validation.

ADDING CONTENT:
Pass a JSON array of block objects. Use the block shapes documented in the tool description.
Example for a structured page:
[
  {"type":"heading_1","heading_1":{"rich_text":[{"type":"text","text":{"content":"Title"}}]}},
  {"type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"Body text"}}]}},
  {"type":"to_do","to_do":{"rich_text":[{"type":"text","text":{"content":"Task"}}],"checked":false}}
]

READING DATABASE ENTRIES (always two steps):
1. Read database schema first to understand exact property names and types
2. Query the database rows

ADDING DATABASE ROWS:
1. Read database schema
2. Create a row with matching property JSON

BEST PRACTICES:
- Always search first before creating pages to avoid duplicates
- For "that page" or vague references, search first
- Prefer page retrieval tools before block-level traversal when possible
- For deep/nested content, use get_block_children with pagination
- Confirm before trashing or deleting blocks
- Use get_current_datetime when any date/time context is needed`;

const notionAgent = createAgent({
  model,
  // tools: [...notionTools, getCurrentDateTime],
  tools: [...notionMcpTools, getCurrentDateTime],
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
