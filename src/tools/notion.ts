import { tool } from 'langchain';
import { z } from 'zod';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { db } from '../db/client.ts';
import { connections } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

const NOTION_API = 'https://api.notion.com/v1';

async function getNotionToken(): Promise<string> {
  const [conn] = await db
    .select()
    .from(connections)
    .where(eq(connections.name, 'notion'))
    .limit(1);

  if (conn?.oauthConnected && conn.accessToken) {
    return conn.accessToken;
  }

  // Fallback to environment variable
  return config.NOTION_TOKEN;
}

const headers = async () => ({
  Authorization: `Bearer ${await getNotionToken()}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function richText(content: string) {
  return [{ type: 'text', text: { content } }];
}

function extractBlockText(block: Record<string, unknown>): string {
  const type = block.type as string;
  const inner = block[type] as
    | { rich_text?: Array<{ plain_text?: string }> }
    | undefined;
  return inner?.rich_text?.map((t) => t.plain_text ?? '').join('') ?? '';
}

function flattenBlocks(blocks: Record<string, unknown>[]): string {
  return blocks
    .map((b) => {
      const type = b.type as string;
      const text = extractBlockText(b);
      const prefix: Record<string, string> = {
        heading_1: '# ',
        heading_2: '## ',
        heading_3: '### ',
        bulleted_list_item: '• ',
        numbered_list_item: '1. ',
        to_do: `[${(b.to_do as { checked?: boolean })?.checked ? 'x' : ' '}] `,
        code: '```\n',
        quote: '> ',
        callout: '💡 ',
        divider: '---',
      };
      if (type === 'divider') return '---';
      return `${prefix[type] ?? ''}${text}${type === 'code' ? '\n```' : ''}`;
    })
    .join('\n');
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export const searchNotion = tool(
  async ({ query, filterType, pageSize }) => {
    try {
      const body: Record<string, unknown> = {
        query,
        page_size: pageSize ?? 20,
      };
      if (filterType && filterType !== 'all') {
        body.filter = {
          value: filterType,
          property: 'object',
        };
      }
      const res = await fetch(`${NOTION_API}/search`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) return `Search failed (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as {
        results: Array<{
          id: string;
          object: string;
          url: string;
          properties?: Record<
            string,
            {
              title?: Array<{
                plain_text: string;
              }>;
            }
          >;
          title?: Array<{ plain_text: string }>;
        }>;
        has_more: boolean;
        next_cursor: string | null;
      };
      const results = data.results.map((r) => {
        const titleProp = r.properties
          ? Object.values(r.properties).find((p) => p.title)?.title?.[0]
              ?.plain_text
          : r.title?.[0]?.plain_text;
        return {
          id: r.id,
          type: r.object,
          title: titleProp ?? 'Untitled',
          url: r.url,
        };
      });
      return JSON.stringify({
        results,
        has_more: data.has_more,
        next_cursor: data.next_cursor,
      });
    } catch (error) {
      logger.error('[notion] searchNotion', error);
      return `Error searching Notion: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_notion',
    description:
      'Search for pages and databases in the Notion workspace by keyword.',
    schema: z.object({
      query: z.string().describe('Search query'),
      filterType: z
        .enum(['page', 'database', 'all'])
        .optional()
        .describe('Filter by object type (default: all)'),
      pageSize: z
        .number()
        .optional()
        .describe('Number of results to return (default 20, max 100)'),
    }),
  },
);

export const getNotionPage = tool(
  async ({ pageId }) => {
    try {
      const [pageRes, blocksRes] = await Promise.all([
        fetch(`${NOTION_API}/pages/${pageId}`, {
          headers: await headers(),
        }),
        fetch(`${NOTION_API}/blocks/${pageId}/children?page_size=100`, {
          headers: await headers(),
        }),
      ]);
      if (!pageRes.ok)
        return `Failed to get page (${pageRes.status}): ${await pageRes.text()}`;
      if (!blocksRes.ok)
        return `Failed to get blocks (${blocksRes.status}): ${await blocksRes.text()}`;

      const page = (await pageRes.json()) as {
        id: string;
        url: string;
        created_time: string;
        last_edited_time: string;
        properties: Record<string, unknown>;
      };
      const blocks = (await blocksRes.json()) as {
        results: Record<string, unknown>[];
      };

      const titleProp = Object.values(page.properties).find(
        (
          p,
        ): p is {
          title: Array<{ plain_text: string }>;
        } => typeof p === 'object' && p !== null && 'title' in p,
      );
      const title = titleProp?.title?.[0]?.plain_text ?? 'Untitled';
      const content = flattenBlocks(blocks.results);

      return JSON.stringify({
        id: page.id,
        title,
        url: page.url,
        created: page.created_time,
        last_edited: page.last_edited_time,
        properties: page.properties,
        content,
      });
    } catch (error) {
      logger.error('[notion] getNotionPage', error);
      return `Error retrieving page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_notion_page',
    description:
      "Retrieve a Notion page's properties and content. Returns flattened text content for easy reading.",
    schema: z.object({
      pageId: z.string().describe('Notion page ID (UUID)'),
    }),
  },
);

export const createNotionPage = tool(
  async ({ title, parentId, parentType, icon, children }) => {
    try {
      const parent =
        parentType === 'database_id'
          ? { database_id: parentId }
          : { page_id: parentId };
      const properties =
        parentType === 'database_id'
          ? {
              Name: {
                title: [
                  {
                    text: {
                      content: title,
                    },
                  },
                ],
              },
            }
          : {
              title: {
                title: [
                  {
                    text: {
                      content: title,
                    },
                  },
                ],
              },
            };

      let parsedChildren: unknown[] | undefined;
      if (children) {
        try {
          parsedChildren = JSON.parse(children);
        } catch {
          return 'Invalid children JSON array';
        }
      }

      const res = await fetch(`${NOTION_API}/pages`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({
          parent,
          properties,
          ...(icon
            ? {
                icon: {
                  type: 'emoji',
                  emoji: icon,
                },
              }
            : {}),
          ...(parsedChildren ? { children: parsedChildren } : {}),
        }),
      });
      if (!res.ok)
        return `Failed to create page (${res.status}): ${await res.text()}`;
      const page = (await res.json()) as {
        id: string;
        url: string;
      };
      return JSON.stringify({
        id: page.id,
        url: page.url,
        message: `Page "${title}" created`,
      });
    } catch (error) {
      logger.error('[notion] createNotionPage', error);
      return `Error creating page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'create_notion_page',
    description: `Create a new Notion page under a parent page or database, optionally with inline content.

If children are provided, the page is created with content in a single call.
Otherwise, use append_notion_blocks after creation to add content.

Common block shapes for children:
- paragraph:           {"type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"text"}}]}}
- heading_1/2/3:       {"type":"heading_1","heading_1":{"rich_text":[{"type":"text","text":{"content":"title"}}]}}
- bulleted_list_item:  {"type":"bulleted_list_item","bulleted_list_item":{"rich_text":[{"type":"text","text":{"content":"item"}}]}}
- numbered_list_item:  {"type":"numbered_list_item","numbered_list_item":{"rich_text":[{"type":"text","text":{"content":"item"}}]}}
- to_do:               {"type":"to_do","to_do":{"rich_text":[{"type":"text","text":{"content":"task"}}],"checked":false}}
- code:                {"type":"code","code":{"rich_text":[{"type":"text","text":{"content":"code"}}],"language":"typescript"}}
- quote:               {"type":"quote","quote":{"rich_text":[{"type":"text","text":{"content":"quote"}}]}}
- divider:             {"type":"divider","divider":{}}
- callout:             {"type":"callout","callout":{"rich_text":[{"type":"text","text":{"content":"note"}}],"icon":{"emoji":"💡"}}}`,
    schema: z.object({
      title: z.string().describe('Page title'),
      parentId: z.string().describe('Parent page or database ID (UUID)'),
      parentType: z
        .enum(['page_id', 'database_id'])
        .describe('Whether the parent is a page or database'),
      icon: z
        .string()
        .optional()
        .describe("Optional emoji icon (e.g. '📝', '✅')"),
      children: z
        .string()
        .optional()
        .describe(
          'Optional JSON array of Notion block objects to include as page content',
        ),
    }),
  },
);

export const updateNotionPageProperties = tool(
  async ({ pageId, properties, icon, archived }) => {
    try {
      let parsed: Record<string, unknown> | undefined;
      if (properties) {
        try {
          parsed = JSON.parse(properties);
        } catch {
          return 'Invalid properties JSON';
        }
      }
      const body: Record<string, unknown> = {};
      if (parsed) body.properties = parsed;
      if (icon) body.icon = { type: 'emoji', emoji: icon };
      if (archived !== undefined) body.archived = archived;

      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok)
        return `Failed to update page (${res.status}): ${await res.text()}`;
      const page = (await res.json()) as { url: string };
      return `Page updated — ${page.url}`;
    } catch (error) {
      logger.error('[notion] updateNotionPageProperties', error);
      return `Error updating page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'update_notion_page_properties',
    description: "Update a Notion page's properties, icon, or archived state.",
    schema: z.object({
      pageId: z.string().describe('Notion page ID (UUID)'),
      properties: z
        .string()
        .optional()
        .describe(
          'JSON string of properties to update, e.g. \'{"Status":{"select":{"name":"Done"}}}\'',
        ),
      icon: z.string().optional().describe('New emoji icon'),
      archived: z
        .boolean()
        .optional()
        .describe('Set to true to trash the page, false to restore'),
    }),
  },
);

export const trashNotionPage = tool(
  async ({ pageId }) => {
    try {
      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify({
          archived: true,
        }),
      });
      if (!res.ok)
        return `Failed to trash page (${res.status}): ${await res.text()}`;
      return `Page ${pageId} moved to trash`;
    } catch (error) {
      logger.error('[notion] trashNotionPage', error);
      return `Error trashing page: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'trash_notion_page',
    description: 'Move a Notion page to trash.',
    schema: z.object({
      pageId: z.string().describe('Notion page ID (UUID)'),
    }),
  },
);

// ─── Blocks ──────────────────────────────────────────────────────────────────

export const getBlockChildren = tool(
  async ({ blockId, cursor }) => {
    try {
      const url = new URL(`${NOTION_API}/blocks/${blockId}/children`);
      url.searchParams.set('page_size', '100');
      if (cursor) url.searchParams.set('start_cursor', cursor);

      const res = await fetch(url.toString(), {
        headers: await headers(),
      });
      if (!res.ok)
        return `Failed to get block children (${res.status}): ${await res.text()}`;

      const data = (await res.json()) as {
        results: Record<string, unknown>[];
        has_more: boolean;
        next_cursor: string | null;
      };

      const simplified = data.results.map((b) => ({
        id: b.id,
        type: b.type,
        text: extractBlockText(b),
        has_children: b.has_children,
      }));

      return JSON.stringify({
        blocks: simplified,
        has_more: data.has_more,
        next_cursor: data.next_cursor,
      });
    } catch (error) {
      logger.error('[notion] getBlockChildren', error);
      return `Error getting block children: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_block_children',
    description:
      'Get the child blocks of a page or block. Supports pagination for long pages.',
    schema: z.object({
      blockId: z.string().describe('Page or block ID (UUID)'),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous call's next_cursor"),
    }),
  },
);

export const appendNotionBlocks = tool(
  async ({ blockId, blocks }) => {
    try {
      let parsed: unknown[];
      try {
        parsed = JSON.parse(blocks);
      } catch {
        return 'Invalid blocks JSON array';
      }

      const res = await fetch(`${NOTION_API}/blocks/${blockId}/children`, {
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify({
          children: parsed,
        }),
      });
      if (!res.ok)
        return `Failed to append blocks (${res.status}): ${await res.text()}`;
      return `Blocks appended to ${blockId}`;
    } catch (error) {
      logger.error('[notion] appendNotionBlocks', error);
      return `Error appending blocks: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'append_notion_blocks',
    description: `Append blocks to a Notion page or block. Blocks must be a JSON array of Notion block objects.

Common block shapes:
- paragraph:           {"type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"text"}}]}}
- heading_1/2/3:       {"type":"heading_1","heading_1":{"rich_text":[{"type":"text","text":{"content":"title"}}]}}
- bulleted_list_item:  {"type":"bulleted_list_item","bulleted_list_item":{"rich_text":[{"type":"text","text":{"content":"item"}}]}}
- numbered_list_item:  {"type":"numbered_list_item","numbered_list_item":{"rich_text":[{"type":"text","text":{"content":"item"}}]}}
- to_do:               {"type":"to_do","to_do":{"rich_text":[{"type":"text","text":{"content":"task"}}],"checked":false}}
- code:                {"type":"code","code":{"rich_text":[{"type":"text","text":{"content":"code"}}],"language":"typescript"}}
- quote:               {"type":"quote","quote":{"rich_text":[{"type":"text","text":{"content":"quote"}}]}}
- divider:             {"type":"divider","divider":{}}
- callout:             {"type":"callout","callout":{"rich_text":[{"type":"text","text":{"content":"note"}}],"icon":{"emoji":"💡"}}}`,
    schema: z.object({
      blockId: z.string().describe('Page or block ID to append to (UUID)'),
      blocks: z.string().describe('JSON array of Notion block objects'),
    }),
  },
);

export const updateBlock = tool(
  async ({ blockId, block }) => {
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(block);
      } catch {
        return 'Invalid block JSON';
      }

      const res = await fetch(`${NOTION_API}/blocks/${blockId}`, {
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify(parsed),
      });
      if (!res.ok)
        return `Failed to update block (${res.status}): ${await res.text()}`;
      return `Block ${blockId} updated`;
    } catch (error) {
      logger.error('[notion] updateBlock', error);
      return `Error updating block: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'update_notion_block',
    description:
      'Update the content of an existing Notion block. The block JSON must include the block type and its content.',
    schema: z.object({
      blockId: z.string().describe('Block ID (UUID)'),
      block: z
        .string()
        .describe(
          'JSON block object, e.g. \'{"paragraph":{"rich_text":[{"type":"text","text":{"content":"updated text"}}]}}\'',
        ),
    }),
  },
);

export const deleteBlock = tool(
  async ({ blockId }) => {
    try {
      const res = await fetch(`${NOTION_API}/blocks/${blockId}`, {
        method: 'DELETE',
        headers: await headers(),
      });
      if (!res.ok)
        return `Failed to delete block (${res.status}): ${await res.text()}`;
      return `Block ${blockId} deleted`;
    } catch (error) {
      logger.error('[notion] deleteBlock', error);
      return `Error deleting block: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'delete_notion_block',
    description: 'Permanently delete a Notion block.',
    schema: z.object({
      blockId: z.string().describe('Block ID to delete (UUID)'),
    }),
  },
);

// ─── Databases ───────────────────────────────────────────────────────────────

export const getNotionDatabase = tool(
  async ({ databaseId }) => {
    try {
      const res = await fetch(`${NOTION_API}/databases/${databaseId}`, {
        headers: await headers(),
      });
      if (!res.ok)
        return `Failed to get database (${res.status}): ${await res.text()}`;
      const db = (await res.json()) as {
        id: string;
        url: string;
        title: Array<{ plain_text: string }>;
        properties: Record<string, { type: string; name: string }>;
      };
      return JSON.stringify({
        id: db.id,
        title: db.title?.[0]?.plain_text ?? 'Untitled',
        url: db.url,
        properties: Object.fromEntries(
          Object.entries(db.properties).map(([, p]) => [p.name, p.type]),
        ),
      });
    } catch (error) {
      logger.error('[notion] getNotionDatabase', error);
      return `Error getting database: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_notion_database',
    description:
      "Retrieve a Notion database's schema — its title and all property names with their types.",
    schema: z.object({
      databaseId: z.string().describe('Notion database ID (UUID)'),
    }),
  },
);

export const createNotionDatabase = tool(
  async ({ parentId, title, properties }) => {
    try {
      const dbProperties: Record<string, unknown> = {
        Name: { title: {} },
      };
      if (properties) {
        let parsed: Array<{
          name: string;
          type: string;
          options?: string[];
        }>;
        try {
          parsed = JSON.parse(properties);
        } catch {
          return 'Invalid properties JSON array';
        }
        for (const prop of parsed) {
          if (prop.type === 'select' || prop.type === 'multi_select') {
            dbProperties[prop.name] = {
              [prop.type]: {
                options: (prop.options ?? []).map((o) => ({
                  name: o,
                })),
              },
            };
          } else {
            dbProperties[prop.name] = {
              [prop.type]: {},
            };
          }
        }
      }
      const res = await fetch(`${NOTION_API}/databases`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({
          parent: { page_id: parentId },
          title: [{ text: { content: title } }],
          properties: dbProperties,
        }),
      });
      if (!res.ok)
        return `Failed to create database (${res.status}): ${await res.text()}`;
      const db = (await res.json()) as {
        id: string;
        url: string;
      };
      return JSON.stringify({
        id: db.id,
        url: db.url,
        message: `Database "${title}" created`,
      });
    } catch (error) {
      logger.error('[notion] createNotionDatabase', error);
      return `Error creating database: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'create_notion_database',
    description:
      'Create a new Notion database (inline table) under a parent page.',
    schema: z.object({
      parentId: z.string().describe('Parent page ID (UUID)'),
      title: z.string().describe('Database title'),
      properties: z
        .string()
        .optional()
        .describe(
          'JSON array of property definitions, e.g. \'[{"name":"Status","type":"select","options":["Todo","In Progress","Done"]},{"name":"Due","type":"date"}]\'. Always has a default "Name" title column.',
        ),
    }),
  },
);

export const updateNotionDatabase = tool(
  async ({ databaseId, title, properties }) => {
    try {
      const body: Record<string, unknown> = {};
      if (title) body.title = [{ text: { content: title } }];
      if (properties) {
        try {
          body.properties = JSON.parse(properties);
        } catch {
          return 'Invalid properties JSON';
        }
      }
      const res = await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok)
        return `Failed to update database (${res.status}): ${await res.text()}`;
      return `Database ${databaseId} updated`;
    } catch (error) {
      logger.error('[notion] updateNotionDatabase', error);
      return `Error updating database: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'update_notion_database',
    description:
      "Update a Notion database's title or add/update its properties.",
    schema: z.object({
      databaseId: z.string().describe('Notion database ID (UUID)'),
      title: z.string().optional().describe('New database title'),
      properties: z
        .string()
        .optional()
        .describe('JSON object of property schema changes'),
    }),
  },
);

export const queryNotionDatabase = tool(
  async ({ databaseId, filter, sorts, pageSize, cursor }) => {
    try {
      const body: Record<string, unknown> = {
        page_size: pageSize ?? 50,
      };
      if (filter) {
        try {
          body.filter = JSON.parse(filter);
        } catch {
          return 'Invalid filter JSON';
        }
      }
      if (sorts) {
        try {
          body.sorts = JSON.parse(sorts);
        } catch {
          return 'Invalid sorts JSON';
        }
      }
      if (cursor) body.start_cursor = cursor;

      const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok)
        return `Failed to query database (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as {
        results: Array<{
          id: string;
          url: string;
          properties: Record<
            string,
            {
              type: string;
              title?: Array<{
                plain_text: string;
              }>;
              rich_text?: Array<{
                plain_text: string;
              }>;
              select?: {
                name: string;
              } | null;
              multi_select?: Array<{
                name: string;
              }>;
              date?: {
                start: string;
                end: string | null;
              } | null;
              checkbox?: boolean;
              number?: number | null;
              url?: string | null;
              email?: string | null;
              phone_number?: string | null;
              status?: {
                name: string;
              } | null;
            }
          >;
        }>;
        has_more: boolean;
        next_cursor: string | null;
      };

      const rows = data.results.map((r) => {
        const props: Record<string, unknown> = {
          _id: r.id,
          _url: r.url,
        };
        for (const [key, val] of Object.entries(r.properties)) {
          switch (val.type) {
            case 'title':
              props[key] = val.title?.map((t) => t.plain_text).join('') ?? '';
              break;
            case 'rich_text':
              props[key] =
                val.rich_text?.map((t) => t.plain_text).join('') ?? '';
              break;
            case 'select':
              props[key] = val.select?.name ?? null;
              break;
            case 'status':
              props[key] = val.status?.name ?? null;
              break;
            case 'multi_select':
              props[key] = val.multi_select?.map((s) => s.name) ?? [];
              break;
            case 'date':
              props[key] = val.date ?? null;
              break;
            case 'checkbox':
              props[key] = val.checkbox;
              break;
            case 'number':
              props[key] = val.number;
              break;
            case 'url':
              props[key] = val.url;
              break;
            case 'email':
              props[key] = val.email;
              break;
            case 'phone_number':
              props[key] = val.phone_number;
              break;
            default:
              props[key] = `(${val.type})`;
          }
        }
        return props;
      });

      return JSON.stringify({
        rows,
        has_more: data.has_more,
        next_cursor: data.next_cursor,
      });
    } catch (error) {
      logger.error('[notion] queryNotionDatabase', error);
      return `Error querying database: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'query_notion_database',
    description:
      'Query a Notion database. Returns flattened rows with property values. Always call get_notion_database first to understand the schema.',
    schema: z.object({
      databaseId: z.string().describe('Database ID (UUID)'),
      filter: z
        .string()
        .optional()
        .describe(
          'JSON Notion filter object, e.g. \'{"property":"Status","select":{"equals":"Done"}}\'',
        ),
      sorts: z
        .string()
        .optional()
        .describe(
          'JSON sorts array, e.g. \'[{"property":"Due","direction":"ascending"}]\'',
        ),
      pageSize: z
        .number()
        .optional()
        .describe('Rows to return per page (default 50, max 100)'),
      cursor: z
        .string()
        .optional()
        .describe('Pagination cursor from a previous call'),
    }),
  },
);

export const createDatabaseEntry = tool(
  async ({ databaseId, properties }) => {
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(properties);
      } catch {
        return 'Invalid properties JSON';
      }

      const res = await fetch(`${NOTION_API}/pages`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: parsed,
        }),
      });
      if (!res.ok)
        return `Failed to create entry (${res.status}): ${await res.text()}`;
      const page = (await res.json()) as {
        id: string;
        url: string;
      };
      return JSON.stringify({
        id: page.id,
        url: page.url,
        message: 'Entry created',
      });
    } catch (error) {
      logger.error('[notion] createDatabaseEntry', error);
      return `Error creating entry: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'create_database_entry',
    description:
      'Add a new row to a Notion database. Always call get_notion_database first to get the exact property names and types.',
    schema: z.object({
      databaseId: z.string().describe('Database ID (UUID)'),
      properties: z
        .string()
        .describe(
          'JSON properties matching the database schema. e.g. \'{"Name":{"title":[{"text":{"content":"My task"}}]},"Status":{"select":{"name":"Todo"}},"Due":{"date":{"start":"2026-04-15"}}}\'',
        ),
    }),
  },
);

// ─── Comments ────────────────────────────────────────────────────────────────

export const getNotionComments = tool(
  async ({ blockId }) => {
    try {
      const url = new URL(`${NOTION_API}/comments`);
      url.searchParams.set('block_id', blockId);
      const res = await fetch(url.toString(), {
        headers: await headers(),
      });
      if (!res.ok)
        return `Failed to get comments (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as {
        results: Array<{
          id: string;
          created_time: string;
          created_by: { name?: string };
          rich_text: Array<{
            plain_text: string;
          }>;
        }>;
      };
      const comments = data.results.map((c) => ({
        id: c.id,
        author: c.created_by?.name ?? 'Unknown',
        created: c.created_time,
        text: c.rich_text.map((t) => t.plain_text).join(''),
      }));
      return JSON.stringify(comments);
    } catch (error) {
      logger.error('[notion] getNotionComments', error);
      return `Error getting comments: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_notion_comments',
    description: 'List all comments on a Notion page or block.',
    schema: z.object({
      blockId: z.string().describe('Page or block ID (UUID)'),
    }),
  },
);

export const createNotionComment = tool(
  async ({ pageId, text }) => {
    try {
      const res = await fetch(`${NOTION_API}/comments`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({
          parent: { page_id: pageId },
          rich_text: richText(text),
        }),
      });
      if (!res.ok)
        return `Failed to create comment (${res.status}): ${await res.text()}`;
      const comment = (await res.json()) as { id: string };
      return `Comment created on page ${pageId}. Comment ID: ${comment.id}`;
    } catch (error) {
      logger.error('[notion] createNotionComment', error);
      return `Error creating comment: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'create_notion_comment',
    description: 'Add a comment to a Notion page.',
    schema: z.object({
      pageId: z.string().describe('Page ID to comment on (UUID)'),
      text: z.string().describe('Comment text'),
    }),
  },
);

// ─── Users ───────────────────────────────────────────────────────────────────

export const listNotionUsers = tool(
  async () => {
    try {
      const res = await fetch(`${NOTION_API}/users`, {
        headers: await headers(),
      });
      if (!res.ok)
        return `Failed to list users (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as {
        results: Array<{
          id: string;
          name: string;
          type: string;
          avatar_url?: string;
        }>;
      };
      return JSON.stringify(
        data.results.map((u) => ({
          id: u.id,
          name: u.name,
          type: u.type,
        })),
      );
    } catch (error) {
      logger.error('[notion] listNotionUsers', error);
      return `Error listing users: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'list_notion_users',
    description:
      'List all users in the Notion workspace. Useful for getting user IDs for mentions or assignments.',
    schema: z.object({}),
  },
);

// ─── Export ──────────────────────────────────────────────────────────────────

export const notionTools = [
  // Search & read
  searchNotion,
  getNotionPage,
  getBlockChildren,
  getNotionDatabase,
  getNotionComments,
  // Pages
  createNotionPage,
  updateNotionPageProperties,
  trashNotionPage,
  // Blocks
  appendNotionBlocks,
  updateBlock,
  deleteBlock,
  // Databases
  createNotionDatabase,
  updateNotionDatabase,
  queryNotionDatabase,
  createDatabaseEntry,
  // Comments & users
  createNotionComment,
  listNotionUsers,
];
