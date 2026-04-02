import { tool } from "langchain";
import { z } from "zod";
import { db } from "../db/client.ts";
import { memories } from "../db/schema.ts";
import { sql } from "drizzle-orm";

export const storeMemory = tool(
  async ({ content, category }) => {
    try {
      await db.insert(memories).values({ content, category });
      return `Memory stored: "${content}" [${category}]`;
    } catch (error) {
      console.error("[memory]", error);
      return `Error storing memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "store_memory",
    description:
      "Store a piece of information for future recall. Use for preferences, patterns, facts, or anything worth remembering.",
    schema: z.object({
      content: z.string().describe("The information to remember"),
      category: z
        .string()
        .describe(
          'Category: "preference", "pattern", "fact", or a custom label',
        ),
    }),
  },
);

export const recallMemories = tool(
  async ({ query }) => {
    try {
      const results = await db
        .select()
        .from(memories)
        .where(sql`${memories.content} ILIKE ${"%" + query + "%"}`)
        .orderBy(sql`${memories.createdAt} DESC`)
        .limit(10);

      if (results.length === 0) {
        return "No memories found matching that query.";
      }

      return JSON.stringify(
        results.map((m) => ({
          content: m.content,
          category: m.category,
          createdAt: m.createdAt,
        })),
      );
    } catch (error) {
      console.error("[memory]", error);
      return `Error recalling memories: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "recall_memories",
    description:
      "Search stored memories by keyword. Returns matching memories ordered by most recent.",
    schema: z.object({
      query: z.string().describe("Keyword to search for in stored memories"),
    }),
  },
);
