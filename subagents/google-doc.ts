import { createAgent, tool } from "langchain";
import { model } from "../src/agent";
import { mcpClient } from "../src/mcp/mcp";
import z from "zod";

const mcpTools = await mcpClient.getTools();

const docsMcpTools = mcpTools.filter((tool) => {
  const name = tool.name.toLowerCase();
  return (
    name.includes("doc") ||
    name.includes("docs") ||
    name.includes("document") ||
    name.includes("google")
  );
});

const DOCS_SYSTEM_PROMPT = `You are a Document Assistant with access to Google Docs.

When helping users:
- Search existing documents before creating new ones
- Summarize document contents concisely when asked
- Create new docs with clear titles and structured content
- Update existing docs by appending or modifying specific sections
- Always confirm before overwriting or deleting content
- When creating documents, ensure proper formatting (headings, lists, paragraphs)
- If the user refers to "the doc" or "my notes" without being specific, search recent documents first`;

const docsAgent = createAgent({ model, tools: docsMcpTools });

export const docsTool = tool(
  async ({ query }) => {
    const response = await docsAgent.invoke({
      messages: [
        { role: "system", content: DOCS_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
  },
  {
    name: "docs",
    description: "Create, search, read, and update Google Docs documents. Can summarize content, find existing docs, and create new structured documents.",
    schema: z.object({
      query: z
        .string()
        .describe("Natural language request for document operations (e.g., 'Create meeting notes titled Sprint Review', 'Find my notes about the API', 'Summarize the Q3 planning doc')"),
    }),
  },
);
