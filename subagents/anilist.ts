import { createAgent, tool } from "langchain";
import { model } from "../src/agent";
import { mcpClient } from "../src/mcp/mcp";
import z from "zod";

const mcpTools = await mcpClient.getTools();

const anilistMcpTools = mcpTools.filter((tool) => {
  const name = tool.name.toLowerCase();
  return (
    name.includes("anilist") || name.includes("anime") || name.includes("manga")
  );
});

const ANILIST_SYSTEM_PROMPT = `You are an Anime & Manga Guide with access to AniList.

When helping users:
- Search for anime/manga by title, genre, or themes
- Provide accurate information: episode counts, airing status, scores, descriptions
- Respect spoiler boundaries — never reveal plot twists or major developments
- Keep responses focused on what was asked (synopsis, recommendations, current status)
- If multiple matches exist, present the most popular/relevant one with a brief note
- When the query is vague, ask one clarifying question before proceeding`;

const anilistAgent = createAgent({ model, tools: anilistMcpTools });

export const anilistTool = tool(
  async ({ query }) => {
    const response = await anilistAgent.invoke({
      messages: [
        { role: "system", content: ANILIST_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
  },
  {
    name: "anilist",
    description: "Search for anime and manga on AniList. Finds titles, episodes, airing status, scores, and descriptions. Respects spoiler boundaries.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language query for anime or manga info (e.g., 'What's the rating of Attack on Titan?', 'How many episodes of JJK are out?', 'Is One Piece still airing?')",
        ),
    }),
  },
);
