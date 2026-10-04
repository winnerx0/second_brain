import { db } from '../db/client.js';
import { connections } from '../db/schema.js';
import { config } from '../config.js';
import type { Definition } from './types.js';

export async function connectionIssues(
  definition: Definition | null,
): Promise<string[]> {
  if (!definition) return [];
  const rows = await db.select({ name: connections.name, oauthConnected: connections.oauthConnected }).from(connections);
  const connected = new Set(
    rows.filter((r) => r.oauthConnected).map((r) => r.name),
  );
  const available: Record<string, boolean> = {
    github: connected.has('github') || !!config.GITHUB_TOKEN,
    notion: connected.has('notion') || !!config.NOTION_TOKEN,
    calendar: connected.has('google_calendar'),
    docs:
      connected.has('google_docs') || !!process.env.GOOGLE_DOCS_REFRESH_TOKEN,
    gmail: connected.has('gmail') || !!config.GMAIL_REFRESH_TOKEN,
    clickup: connected.has('clickup'),
    spotify: connected.has('spotify'),
    twitter: connected.has('twitter'),
    web_search: !!config.TAVILY_API_KEY,
    telegram: !!config.TELEGRAM_BOT_TOKEN && !!config.TELEGRAM_CHAT_ID,
    synthesis: true,
    knowledge_graph: true,
    anilist: true, // Public AniList reads do not require authorization.
  };
  const issues = [
    ...new Set(
      definition.steps
        .filter((s) => !available[s.specialist])
        .map((s) => `Connect ${s.specialist} before running this workflow.`),
    ),
  ];
  if (
    definition.steps.some(
      (s) => s.specialist === 'anilist' && s.permissions.length,
    ) &&
    !connected.has('anilist') &&
    !config.ANILIST_TOKEN
  )
    issues.push('Connect AniList before running account actions.');
  return issues;
}
