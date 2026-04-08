import { tool } from "langchain";
import { z } from "zod";
import { db } from "../db/client.ts";
import { sql } from "drizzle-orm";
import { logger } from "../logger.ts";
import { OpenAI } from "openai";
import { env } from "bun";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { memories } from "../db/schema.ts";

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });


// const vectorStore = await PGVectorStore.initialize(embeddings, {columns: {vectorColumnName: "vector"}, tableName: "memories", dimensions: 1536, postgresConnectionOptions: {
//   connectionString: env.DATABASE_URL,
// }});

async function ensureRow() {
  await db.execute(
    sql`INSERT INTO memories (id, data, updated_at) VALUES (1, '{}', now()) ON CONFLICT (id) DO NOTHING`,
  );
}

export const storeMemory = tool(
  async ({ value, query }) => {
    try {

      logger.info(`[memory] Storing memory ${value}, query: ${query}`);

      const embeddings = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: value
      });

      await db.execute(sql`INSERT INTO memories (content, vector) VALUES (${value}, ${JSON.stringify(embeddings.data[0]!.embedding)}::vector)`)

      return `Memory stored: ${value}`;
    } catch (error) {
      logger.error("[memory]", error);
      return `Error storing memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "store_memory",
    description:
      "Store a memory. Use for preferences, facts, or anything worth remembering about the user or what the user wants you to remember.",
    schema: z.object({
      value: z.string().describe("The value to store"),
      query: z.string().describe("The user query to embed")
    }),
  },
);

export const recallMemories = tool(
  async ({ query }) => {
    try {

      logger.info(`[memory] Recalling memories for query: ${query}`);

      // const result = await vectorStore.similaritySearch(query, 1);

      const embeddings = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: query
      });

      const result = await db.select().from(memories).where(sql`vector <=> ${JSON.stringify(embeddings.data[0]!.embedding)}::vector < 0.5`).limit(5);
      
      return {
        memories: result.map(r => r.content)
      }
    } catch (error) {
      logger.error("[memory]", error);
      return `Error recalling memories: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "recall_memories",
    description:
      "Retrieve stored memories. Pass a keyword to vector-search across memory keys and values, and return the most relevant memories.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "Keyword to search across memory keys and values",
        ),
    }),
  },
);

export const deleteMemory = tool(
  async ({ key }) => {
    try {
      await ensureRow();
      await db.execute(
        sql`UPDATE memories SET data = data - ${key}, updated_at = now() WHERE id = 1`,
      );
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
