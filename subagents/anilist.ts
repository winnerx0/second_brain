import { createAgent, tool } from "langchain";
import z from "zod";
import { mcpTools, model } from "../src/shared";

const anilistMcpTools = mcpTools.filter((tool) => {
  const name = tool.name.toLowerCase();
  return [
    "get_genres",
    "get_media_tags",
    "get_site_statistics",
    "get_studio",
    "favourite_studio",
    "delete_activity",
    "get_activity",
    "get_user_activity",
    "post_message_activity",
    "post_text_activity",
    "get_user_anime_list",
    "get_user_manga_list",
    "add_list_entry",
    "remove_list_entry",
    "update_list_entry",
    "get_anime",
    "get_manga",
    "favourite_anime",
    "favourite_manga",
    "get_character",
    "get_staff",
    "favourite_character",
    "favourite_staff",
    "get_todays_birthday_characters",
    "get_todays_birthday_staff",
    "get_recommendation",
    "get_recommendations_for_media",
    "search_activity",
    "search_anime",
    "search_manga",
    "search_character",
    "search_staff",
    "search_studio",
    "search_user",
    "get_thread",
    "get_thread_comments",
    "delete_thread",
    "get_user_profile",
    "get_user_stats",
    "get_full_user_info",
    "get_user_recent_activity",
    "get_authorized_user",
    "follow_user",
    "update_user",
  ].includes(name);
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
    console.log("[anilist] Received query:", query);
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
    description:
      "Search for anime and manga on AniList. Finds titles, episodes, airing status, scores, and descriptions. Respects spoiler boundaries.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language query for anime or manga info (e.g., 'What's the rating of Attack on Titan?', 'How many episodes of JJK are out?', 'Is One Piece still airing?')",
        ),
    }),
  },
);
