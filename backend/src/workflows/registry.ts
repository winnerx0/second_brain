import { githubTool } from '../subagents/github.js';
import { calendarTool } from '../subagents/calendar.js';
import { gmailTool } from '../subagents/gmail.js';
import { docsTool } from '../subagents/google-docs.js';
import { notionTool } from '../subagents/notion.js';
import { clickupTool } from '../subagents/clickup.js';
import { spotifyTool } from '../subagents/spotify.js';
import { twitterTool } from '../subagents/twitter.js';
import { anilistTool } from '../subagents/anilist.js';
import { knowledgeGraphTool } from '../subagents/knowledge-graph.js';
import { tavilyTool } from '../subagents/tavily.js';

export const specialists = {
  github: githubTool,
  calendar: calendarTool,
  gmail: gmailTool,
  docs: docsTool,
  notion: notionTool,
  clickup: clickupTool,
  spotify: spotifyTool,
  twitter: twitterTool,
  anilist: anilistTool,
  knowledge_graph: knowledgeGraphTool,
  web_search: tavilyTool,
};
