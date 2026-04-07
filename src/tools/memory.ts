import { tool } from "langchain";
import { z } from "zod";
import { db } from "../db/client.ts";
import { memories } from "../db/schema.ts";
import { sql } from "drizzle-orm";
import { logger } from "../logger.ts";

async function ensureRow() {
  await db.execute(sql`INSERT INTO memories (id, data, updated_at) VALUES (1, '{}', now()) ON CONFLICT (id) DO NOTHING`);
}

export const storeMemory = tool(
  async ({ key, value }) => {
    try {
      await ensureRow();
      await db.execute(
        sql`UPDATE memories SET data = jsonb_set(data, ${`{${key}}`}::text[], to_jsonb(${value}::text)), updated_at = now() WHERE id = 1`,
      );
      return `Memory stored: "${key}" = ${value}`;
    } catch (error) {
      logger.error("[memory]", error);
      return `Error storing memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "store_memory",
    description:
      "Store or update a memory by key. If the key already exists it will be overwritten. Use for preferences, facts, or anything worth remembering about the user.",
    schema: z.object({
      key: z.string().describe("Unique key for this memory (e.g. 'full_name', 'preferred_language')"),
      value: z.string().describe("The value to store"),
    }),
  },
);

export const recallMemories = tool(
  async ({ query }) => {
    try {
      await ensureRow();

      if (!query) {
        const result = await db.execute(sql`SELECT data FROM memories WHERE id = 1`);
        const data = (result as { data: Record<string, string> }[])?.[0]?.data ?? {};
        return Object.keys(data).length ? JSON.stringify(data) : "No memories stored.";
      }

      // Use ILIKE on JSONB keys and values for case-insensitive matching
      // Split query into words and match any part of key or value
      const searchPattern = `%${query}%`;
      const result = await db.execute(sql`
        SELECT key, value
        FROM memories,
        LATERAL jsonb_each_text(data)
        WHERE id = 1
          AND (key ILIKE ${searchPattern} OR value ILIKE ${searchPattern})
      `);

      const entries = result as { key: string; value: string }[];
      const filtered = Object.fromEntries(entries.map((row) => [row.key, row.value]));

      return Object.keys(filtered).length
        ? JSON.stringify(filtered)
        : `No memories found matching "${query}".`;
    } catch (error) {
      logger.error("[memory]", error);
      return `Error recalling memories: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "recall_memories",
    description:
      "Retrieve stored memories. Pass a keyword to fuzzy-search across keys and values, or empty string to retrieve all.",
    schema: z.object({
      query: z.string().describe("Keyword to search across memory keys and values, or empty string to retrieve all"),
    }),
  },
);

export const deleteMemory = tool(
  async ({ key }) => {
    try {
      await ensureRow();
      await db.execute(sql`UPDATE memories SET data = data - ${key}, updated_at = now() WHERE id = 1`);
      return `Deleted memory: "${key}"`;
    } catch (error) {
      logger.error("[memory]", error);
      return `Error deleting memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "delete_memory",
    description: "Remove a key from stored memories.",
    schema: z.object({
      key: z.string().describe("The key to remove"),
    }),
  },
);
