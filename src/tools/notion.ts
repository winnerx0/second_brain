import { tool } from "langchain";
import { z } from "zod";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

const headers = {
  Authorization: `Bearer ${config.NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

const NOTION_API = "https://api.notion.com/v1";

function textToBlocks(content: string): Array<Record<string, unknown>> {
  return content.split("\n\n").map((paragraph) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: paragraph } }],
    },
  }));
}

const createNotionPage = tool(
  async ({ title, parentId, parentType, content }) => {
    try {
      const children = content ? textToBlocks(content) : [];
      const parent = { [parentType]: parentId };
      const properties =
        parentType === "database_id"
          ? { Name: { title: [{ text: { content: title } }] } }
          : { title: { title: [{ text: { content: title } }] } };

      const res = await fetch(`${NOTION_API}/pages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent,
          properties,
          ...(children.length ? { children } : {}),
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to create page (${res.status}): ${err}`;
      }

      const page = (await res.json()) as { id: string; url: string };
      return `Page created: "${title}" — ${page.url}`;
    } catch (error) {
      logger.error("[notion]", error);
      return `Error creating page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "create_notion_page",
    description:
      "Create a new Notion page under a parent page or database. Content is plain text — separate paragraphs with double newlines.",
    schema: z.object({
      title: z.string().describe("Page title"),
      parentId: z
        .string()
        .describe(
          "Parent page or database ID (UUID). Use search_notion to find it.",
        ),
      parentType: z
        .enum(["page_id", "database_id"])
        .describe("Whether the parent is a page or a database"),
      content: z
        .string()
        .optional()
        .describe("Page body text. Separate paragraphs with double newlines."),
    }),
  },
);

const appendNotionContent = tool(
  async ({ pageId, content }) => {
    try {
      const children = textToBlocks(content);
      const res = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ children }),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to append content (${res.status}): ${err}`;
      }

      return `Content appended to page ${pageId}`;
    } catch (error) {
      logger.error("[notion]", error);
      return `Error appending content: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "append_notion_content",
    description:
      "Append paragraph blocks to an existing Notion page. Separate paragraphs with double newlines.",
    schema: z.object({
      pageId: z
        .string()
        .describe("The Notion page ID to append content to (UUID)"),
      content: z
        .string()
        .describe(
          "Text content to append. Separate paragraphs with double newlines.",
        ),
    }),
  },
);

const deleteNotionPage = tool(
  async ({ pageId }) => {
    try {
      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ archived: true }),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to archive page (${res.status}): ${err}`;
      }

      return `Page ${pageId} archived successfully`;
    } catch (error) {
      logger.error("[notion]", error);
      return `Error archiving page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "delete_notion_page",
    description: "Archive (soft-delete) a Notion page.",
    schema: z.object({
      pageId: z.string().describe("The Notion page ID to archive (UUID)"),
    }),
  },
);

const searchNotion = tool(
  async ({ query, filterType }) => {
    try {
      const body: Record<string, unknown> = { query, page_size: 10 };
      if (filterType !== "all") {
        body.filter = { value: filterType, property: "object" };
      }

      const res = await fetch(`${NOTION_API}/search`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Notion search failed (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        results: Array<{
          id: string;
          object: string;
          url: string;
          properties?: Record<
            string,
            { title?: Array<{ plain_text: string }> }
          >;
        }>;
      };

      return JSON.stringify(
        data.results.map((r) => {
          const titleProp = Object.values(r.properties ?? {}).find(
            (p) => p.title,
          );
          const title = titleProp?.title?.[0]?.plain_text ?? "Untitled";
          return { id: r.id, type: r.object, title, url: r.url };
        }),
      );
    } catch (error) {
      logger.error("[notion]", error);
      return `Error searching Notion: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "search_notion",
    description:
      "Search for pages and databases in the Notion workspace by keyword.",
    schema: z.object({
      query: z.string().describe("Search query"),
      filterType: z
        .enum(["page", "database", "all"])
        .describe("Filter results by type"),
    }),
  },
);

const getNotionPage = tool(
  async ({ pageId }) => {
    try {
      const [pageRes, blocksRes] = await Promise.all([
        fetch(`${NOTION_API}/pages/${pageId}`, { headers }),
        fetch(`${NOTION_API}/blocks/${pageId}/children`, { headers }),
      ]);

      if (!pageRes.ok) {
        const err = await pageRes.text();
        return `Failed to retrieve page (${pageRes.status}): ${err}`;
      }

      if (!blocksRes.ok) {
        const err = await blocksRes.text();
        return `Failed to retrieve page blocks (${blocksRes.status}): ${err}`;
      }

      const page = (await pageRes.json()) as {
        id: string;
        url: string;
        properties: Record<string, unknown>;
      };
      const blocks = (await blocksRes.json()) as { results: Array<unknown> };

      return JSON.stringify({
        id: page.id,
        url: page.url,
        properties: page.properties,
        blocks: blocks.results,
      });
    } catch (error) {
      logger.error("[notion]", error);
      return `Error retrieving page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "get_notion_page",
    description: "Retrieve a Notion page's properties and content blocks.",
    schema: z.object({
      pageId: z.string().describe("The Notion page ID (UUID)"),
    }),
  },
);

const updateNotionPageTitle = tool(
  async ({ pageId, newTitle }) => {
    try {
      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            title: { title: [{ text: { content: newTitle } }] },
          },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to update page title (${res.status}): ${err}`;
      }

      const page = (await res.json()) as { url: string };
      return `Page title updated to "${newTitle}" — ${page.url}`;
    } catch (error) {
      logger.error("[notion]", error);
      return `Error updating page title: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "update_notion_page_title",
    description: "Update the title of a Notion page.",
    schema: z.object({
      pageId: z.string().describe("The Notion page ID to update (UUID)"),
      newTitle: z.string().describe("The new title for the page"),
    }),
  },
);

const createNotionDatabase = tool(
  async ({ parentId, title, properties }) => {
    try {
      const dbProperties: Record<string, unknown> = { Name: { title: {} } };
      if (properties) {
        for (const prop of properties) {
          dbProperties[prop.name] = { [prop.type]: {} };
        }
      }

      const res = await fetch(`${NOTION_API}/databases`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent: { page_id: parentId },
          title: [{ text: { content: title } }],
          properties: dbProperties,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to create database (${res.status}): ${err}`;
      }

      const db = (await res.json()) as { id: string; url: string };
      return `Database created: "${title}" — ${db.url}`;
    } catch (error) {
      logger.error("[notion]", error);
      return `Error creating database: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "create_notion_database",
    description:
      "Create a new Notion database under a parent page with custom properties.",
    schema: z.object({
      parentId: z.string().describe("Parent page ID (UUID)"),
      title: z.string().describe("Database title"),
      properties: z
        .array(
          z.object({
            name: z.string().describe("Property name"),
            type: z
              .string()
              .describe(
                'Property type: "rich_text", "number", "select", "multi_select", "date", "checkbox", "url", "email"',
              ),
          }),
        )
        .optional()
        .describe("Additional properties beyond the default Name/title column"),
    }),
  },
);

const queryNotionDatabase = tool(
  async ({ databaseId, filter, sorts }) => {
    try {
      const body: Record<string, unknown> = {};
      if (filter) {
        try {
          body.filter = JSON.parse(filter);
        } catch {
          return "Invalid filter JSON string";
        }
      }
      if (sorts) {
        try {
          body.sorts = JSON.parse(sorts);
        } catch {
          return "Invalid sorts JSON string";
        }
      }

      const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to query database (${res.status}): ${err}`;
      }

      const data = (await res.json()) as { results: Array<unknown> };
      return JSON.stringify(data.results);
    } catch (error) {
      logger.error("[notion]", error);
      return `Error querying database: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "query_notion_database",
    description:
      "Query a Notion database with optional filter and sorts. Filter and sorts must be valid JSON strings matching the Notion API format.",
    schema: z.object({
      databaseId: z.string().describe("The database ID to query (UUID)"),
      filter: z
        .string()
        .optional()
        .describe(
          'JSON string of a Notion filter object, e.g. \'{"property":"Status","select":{"equals":"Done"}}\'',
        ),
      sorts: z
        .string()
        .optional()
        .describe(
          'JSON string of a Notion sorts array, e.g. \'[{"property":"Created","direction":"descending"}]\'',
        ),
    }),
  },
);

const createNotionDatabaseEntry = tool(
  async ({ databaseId, properties }) => {
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(properties);
      } catch {
        return "Invalid properties JSON string";
      }

      const res = await fetch(`${NOTION_API}/pages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: parsed,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to create database entry (${res.status}): ${err}`;
      }

      const page = (await res.json()) as { url: string };
      return `Database entry created — ${page.url}`;
    } catch (error) {
      logger.error("[notion]", error);
      return `Error creating database entry: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "create_notion_database_entry",
    description:
      "Create a new row in a Notion database. Properties must be a JSON string matching the database schema.",
    schema: z.object({
      databaseId: z.string().describe("The database ID to add a row to (UUID)"),
      properties: z
        .string()
        .describe(
          'JSON string of Notion page properties, e.g. \'{"Name":{"title":[{"text":{"content":"My Entry"}}]},"Status":{"select":{"name":"In Progress"}}}\'',
        ),
    }),
  },
);

const updateNotionPageProperties = tool(
  async ({ pageId, properties }) => {
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(properties);
      } catch {
        return "Invalid properties JSON string";
      }

      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: parsed }),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to update page properties (${res.status}): ${err}`;
      }

      const page = (await res.json()) as { url: string };
      return `Page properties updated — ${page.url}`;
    } catch (error) {
      logger.error("[notion]", error);
      return `Error updating page properties: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "update_notion_page_properties",
    description:
      "Update properties on a Notion page. Properties must be a JSON string matching the Notion API format.",
    schema: z.object({
      pageId: z.string().describe("The Notion page ID to update (UUID)"),
      properties: z
        .string()
        .describe(
          'JSON string of properties to update, e.g. \'{"Status":{"select":{"name":"Done"}}}\'',
        ),
    }),
  },
);

export const notionTools = [
  createNotionPage,
  appendNotionContent,
  deleteNotionPage,
  searchNotion,
  getNotionPage,
  updateNotionPageTitle,
  createNotionDatabase,
  queryNotionDatabase,
  createNotionDatabaseEntry,
  updateNotionPageProperties,
];
