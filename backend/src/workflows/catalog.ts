import { z } from 'zod';
import { gmailTools } from '../tools/gmail.js';
import { calendarTools } from '../tools/calendar.js';
import { googleDocTools } from '../tools/google-docs.js';
import { notionTools } from '../tools/notion.js';
import { clickupTools } from '../tools/clickup.js';
import { spotifyTools } from '../tools/spotify.js';
import { twitterTools } from '../tools/twitter.js';
import { anilistTools } from '../tools/anilist.js';
import { knowledgeGraphTools } from '../tools/knowledge-graph.js';
import { tavilyTools } from '../tools/tavily.js';
import {
  getOpenPRs,
  getAssignedIssues,
  getCommits,
  createIssue,
  closeIssue,
  deleteIssue,
  createPullRequest,
  getPullRequest,
  mergePullRequest,
} from '../tools/github.js';
import { isReadTool, type Definition } from './types.js';

const toolGroups = {
  github: [
    getOpenPRs,
    getAssignedIssues,
    getCommits,
    createIssue,
    closeIssue,
    deleteIssue,
    createPullRequest,
    getPullRequest,
    mergePullRequest,
  ],
  gmail: gmailTools,
  calendar: calendarTools,
  docs: googleDocTools,
  notion: notionTools,
  clickup: clickupTools,
  spotify: spotifyTools,
  twitter: twitterTools,
  anilist: anilistTools,
  knowledge_graph: knowledgeGraphTools,
  web_search: tavilyTools,
};
export function capabilityCatalog() {
  return Object.entries(toolGroups).map(([specialist, tools]) => ({
    specialist,
    tools: tools.map((t) => {
      let parameters: unknown;
      try {
        parameters = z.toJSONSchema(t.schema as z.ZodType, {
          unrepresentable: 'any',
        });
      } catch {
        parameters = 'Consult the tool description';
      }
      return {
        name: t.name,
        description: t.description,
        readOnly: isReadTool(t.name),
        parameters,
      };
    }),
  }));
}
export function validateCapabilities(definition: Definition) {
  for (const step of definition.steps) {
    const names =
      step.specialist === 'telegram'
        ? ['send_telegram_message']
        : step.specialist === 'synthesis'
          ? []
          : toolGroups[step.specialist].map((t) => t.name);
    for (const permission of step.permissions)
      if (!names.includes(permission.tool as never))
        throw new Error(
          `Unknown ${step.specialist} capability: ${permission.tool}`,
        );
    if (
      step.specialist === 'telegram' &&
      (!step.dependsOn.length ||
        !step.permissions.some((p) => p.tool === 'send_telegram_message'))
    )
      throw new Error(
        'Telegram requires an authorized delivery action and an input step',
      );
  }
}
