import { tool } from "langchain";
import { z } from "zod";
import { db } from "../db/client.ts";
import { memories } from "../db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { logger } from "../logger.ts";

export const storeMemory = tool(
  async ({ key, value, category }) => {
    try {
      await db
        .insert(memories)
        .values({ key, value, category })
        .onConflictDoUpdate({
          target: memories.key,
          set: { value, category, updatedAt: new Date() },
        });
      return `Memory stored: "${key}" = ${JSON.stringify(value)} [${category}]`;
    } catch (error) {
      logger.error("[memory]", error);
      return `Error storing memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "store_memory",
    description:
      "Store or update a memory by key. If the key already exists it will be overwritten. Use for preferences, facts, or anything worth remembering.",
    schema: z.object({
      key: z.string().describe("Unique identifier for this memory (e.g. 'preferred_language', 'github_username')"),
      value: z.record(z.unknown()).describe("The data to store as key-value pairs"),
      category: z.string().describe('Category: "preference", "pattern", "fact", or a custom label'),
    }),
  },
);

export const recallMemories = tool(
  async ({ query }) => {
    try {
      const results = await db
        .select()
        .from(memories)
        .where(sql`${memories.key} ILIKE ${"%" + query + "%"} OR ${memories.value}::text ILIKE ${"%" + query + "%"}`)
        .orderBy(sql`${memories.updatedAt} DESC`)
        .limit(10);

      if (results.length === 0) return "No memories found matching that query.";

      return JSON.stringify(
        results.map((m) => ({ key: m.key, value: m.value, category: m.category, updatedAt: m.updatedAt })),
      );
    } catch (error) {
      logger.error("[memory]", error);
      return `Error recalling memories: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "recall_memories",
    description: "Search stored memories by key or value keyword.",
    schema: z.object({
      query: z.string().describe("Keyword to search for in memory keys or values"),
    }),
  },
);

export const deleteMemory = tool(
  async ({ key }) => {
    try {
      const result = await db.delete(memories).where(eq(memories.key, key));
      return result.rowCount ? `Deleted memory: "${key}"` : `No memory found with key "${key}"`;
    } catch (error) {
      logger.error("[memory]", error);
      return `Error deleting memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "delete_memory",
    description: "Delete a stored memory by its key.",
    schema: z.object({
      key: z.string().describe("The key of the memory to delete"),
    }),
  },
);
