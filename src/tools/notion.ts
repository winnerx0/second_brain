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

export const searchNotion = tool(
  async ({ query }) => {
    try {
      const res = await fetch(`${NOTION_API}/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query,
          page_size: 10,
        }),
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
          properties?: Record<string, { title?: Array<{ plain_text: string }> }>;
        }>;
      };

      return JSON.stringify(
        data.results.map((r) => {
          const titleProp = Object.values(r.properties ?? {}).find((p) => p.title);
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
    description: "Search for pages and databases in Notion by keyword.",
    schema: z.object({
      query: z.string().describe("Search query"),
    }),
  },
);

export const getNotionPage = tool(
  async ({ page_id }) => {
    try {
      const res = await fetch(`${NOTION_API}/pages/${page_id}`, { headers });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to retrieve page (${res.status}): ${err}`;
      }

      const page = (await res.json()) as {
        id: string;
        url: string;
        properties: Record<string, unknown>;
      };
      return JSON.stringify({ id: page.id, url: page.url, properties: page.properties });
    } catch (error) {
      logger.error("[notion]", error);
      return `Error retrieving page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "get_notion_page",
    description: "Retrieve a Notion page by its ID.",
    schema: z.object({
      page_id: z.string().describe("The Notion page ID (UUID format)"),
    }),
  },
);

export const createNotionPage = tool(
  async ({ parent_id, title, content }) => {
    try {
      const children: Array<Record<string, unknown>> = [];
      if (content) {
        for (const paragraph of content.split("\n\n")) {
          children.push({
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: paragraph } }],
            },
          });
        }
      }

      const res = await fetch(`${NOTION_API}/pages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent: { page_id: parent_id },
          properties: {
            title: { title: [{ text: { content: title } }] },
          },
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
      "Create a new Notion page under a parent page. Content is plain text — separate paragraphs with double newlines.",
    schema: z.object({
      parent_id: z
        .string()
        .describe('Parent page ID to create under (UUID format). Use search_notion to find it first.'),
      title: z.string().describe("Page title"),
      content: z
        .string()
        .optional()
        .describe("Page body text. Separate paragraphs with double newlines."),
    }),
  },
);

export const updateNotionPage = tool(
  async ({ page_id, title }) => {
    try {
      const body: Record<string, unknown> = {};
      if (title) {
        body.properties = {
          title: { title: [{ text: { content: title } }] },
        };
      }

      const res = await fetch(`${NOTION_API}/pages/${page_id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Failed to update page (${res.status}): ${err}`;
      }

      const page = (await res.json()) as { id: string; url: string };
      return `Page updated: ${page.url}`;
    } catch (error) {
      logger.error("[notion]", error);
      return `Error updating page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "update_notion_page",
    description: "Update a Notion page's title.",
    schema: z.object({
      page_id: z.string().describe("The Notion page ID to update"),
      title: z.string().optional().describe("New page title"),
    }),
  },
);

export const createNotionDatabase = tool(
  async ({ parent_id, title, properties }) => {
    try {
      const dbProperties: Record<string, unknown> = {
        Name: { title: {} },
      };

      if (properties) {
        for (const prop of properties) {
          dbProperties[prop.name] = { [prop.type]: {} };
        }
      }

      const res = await fetch(`${NOTION_API}/databases`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent: { page_id: parent_id },
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
      parent_id: z.string().describe("Parent page ID (UUID format)"),
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
