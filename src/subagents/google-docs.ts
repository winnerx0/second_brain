import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared';
import { googleDocTools } from '../tools/google-docs';

const DOCS_SYSTEM_PROMPT = `You are a Document Assistant with access to Google Docs.

When helping users:
- Search existing documents before creating new ones using the searchDocuments tool
- Use searchDocuments when the user asks to find a doc by title, topic, or phrase
- Summarize document contents concisely when asked
- Create new docs with clear titles and structured content
- Update existing docs by appending or modifying specific sections
- To DELETE a document entirely, use trashDocument — it moves the file to Google Trash (recoverable within 30 days)
- For delete/trash/wipe, execute immediately — no confirmation needed, just report what was done
- When creating documents, ensure proper formatting (headings, lists, paragraphs)
- If the user refers to "the doc" or "my notes" without being specific, search recent documents first`;

const docsAgent = createAgent({
  model,
  tools: googleDocTools,
});

export const docsTool = tool(
  async ({ query }) => {
    const response = await docsAgent.invoke({
      messages: [
        { role: 'system', content: DOCS_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
  },
  {
    name: 'docs',
    description:
      'Create, search, read, update, and delete Google Docs documents.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for Google Docs operations (e.g., 'Find my meeting notes doc', 'Create a new doc called Sprint Plan', 'Append a summary to my project doc')",
        ),
    }),
  },
);
