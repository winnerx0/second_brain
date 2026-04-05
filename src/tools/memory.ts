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
      if (query) {
        // Retrieve a specific key
        const result = await db.execute(sql`SELECT data->>${query} AS value FROM memories WHERE id = 1`);
        const value = (result.rows[0] as { value: string | null })?.value;
        return value !== null ? `${query}: ${value}` : `No memory found for key "${query}".`;
      }
      // Return all memories
      const result = await db.execute(sql`SELECT data FROM memories WHERE id = 1`);
      const data = (result.rows[0] as { data: Record<string, string> })?.data ?? {};
      return Object.keys(data).length ? JSON.stringify(data) : "No memories stored.";
    } catch (error) {
      logger.error("[memory]", error);
      return `Error recalling memories: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "recall_memories",
    description:
      "Retrieve stored memories. Call with no query to get all memories, or pass a keyword to filter by key or value.",
    schema: z.object({
      query: z.string().describe("Keyword to filter memories, or empty string to retrieve all"),
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
