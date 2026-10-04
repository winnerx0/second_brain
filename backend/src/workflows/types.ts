import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';

export const specialistNames = [
  'github',
  'calendar',
  'gmail',
  'docs',
  'notion',
  'clickup',
  'spotify',
  'twitter',
  'anilist',
  'knowledge_graph',
  'web_search',
  'synthesis',
  'telegram',
] as const;

export const definitionSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000),
  instructions: z.string().min(1).max(20000),
  trigger: z.object({
    kind: z.enum(['manual', 'once', 'cron']),
    cron: z.string().nullable(),
    at: z.string().nullable(),
    timezone: z.string(),
  }),
  steps: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        title: z.string().min(1),
        specialist: z.enum(specialistNames),
        instruction: z.string().min(1),
        dependsOn: z.array(z.string()),
        permissions: z.array(
          z.object({
            tool: z.string(),
            constraints: z.record(
              z.string(),
              z.array(z.union([z.string(), z.number(), z.boolean()])),
            ),
          }),
        ),
      }),
    )
    .min(1)
    .max(30),
});
export type Definition = z.infer<typeof definitionSchema>;

export type Step = Definition['steps'][number];
export function validateDefinition(input: unknown): Definition {
  const value = definitionSchema.parse(input);
  new Intl.DateTimeFormat('en', { timeZone: value.trigger.timezone });
  if (value.trigger.kind === 'cron') {
    if (value.trigger.cron?.trim().split(/\s+/).length !== 5)
      throw new Error('Use a five-field cron expression');
    CronExpressionParser.parse(value.trigger.cron!, {
      tz: value.trigger.timezone,
    }).next();
  }
  if (
    value.trigger.kind === 'once' &&
    (!value.trigger.at ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(value.trigger.at) ||
      !Number.isFinite(Date.parse(value.trigger.at)))
  )
    throw new Error('A valid one-time date is required');
  const ids = new Set(value.steps.map((s) => s.id));
  if (ids.size !== value.steps.length)
    throw new Error('Step IDs must be unique');
  const visited = new Set<string>();
  while (visited.size < ids.size) {
    const ready = value.steps.filter(
      (s) => !visited.has(s.id) && s.dependsOn.every((id) => visited.has(id)),
    );
    if (!ready.length)
      throw new Error('Step dependencies contain a cycle or unknown step');
    ready.forEach((s) => visited.add(s.id));
  }
  return value;
}
export function nextOccurrence(
  trigger: Definition['trigger'],
  after = new Date(),
): Date | null {
  if (trigger.kind === 'manual') return null;
  if (trigger.kind === 'once')
    return trigger.at && new Date(trigger.at) > after
      ? new Date(trigger.at)
      : null;
  return CronExpressionParser.parse(trigger.cron!, {
    tz: trigger.timezone,
    currentDate: after,
  })
    .next()
    .toDate();
}
export function latestOccurrence(
  trigger: Definition['trigger'],
  now = new Date(),
): Date {
  if (trigger.kind === 'once') return new Date(trigger.at!);
  return CronExpressionParser.parse(trigger.cron!, {
    tz: trigger.timezone,
    currentDate: new Date(now.getTime() + 1),
  })
    .prev()
    .toDate();
}
export function preview(trigger: Definition['trigger']): string[] {
  const dates: string[] = [];
  let date = new Date();
  for (let i = 0; i < 5; i++) {
    const next = nextOccurrence(trigger, date);
    if (!next) break;
    dates.push(next.toISOString());
    date = next;
  }
  return dates;
}
export function isReadTool(name: string): boolean {
  return (
    /^(get_|list_|search_|discover_|fetch_|recall_|calculate|twitter_get_|twitter_search_|spotify_get_|spotify_search|clickup_get_|clickup_search)/.test(
      name,
    ) ||
    name === 'tavily_search' ||
    [
      'tavily_extract',
      'readDocument',
      'searchDocuments',
      'query_notion_database',
    ].includes(name)
  );
}
export function checkPermission(
  step: Step,
  tool: string,
  args: Record<string, unknown>,
) {
  if (isReadTool(tool)) return;
  const permission = step.permissions.find((p) => p.tool === tool);
  if (!permission)
    throw new Error(`Action ${tool} is outside this workflow's authorization`);
  for (const [key, allowed] of Object.entries(permission.constraints)) {
    const actual = args[key];
    const values = Array.isArray(actual) ? actual : [actual];
    if (!values.length || values.some((v) => !allowed.includes(v as string)))
      throw new Error(`Unauthorized target: ${tool}.${key}`);
  }
  for (const key of Object.keys(args)) {
    if (isTarget(key) && args[key] != null && !permission.constraints[key])
      throw new Error(
        `Missing authorization for target ${tool}.${key}; clarify the workflow first`,
      );
  }
}
export const isTarget = (key: string) =>
  /(^to$|^cc$|^bcc$|id$|ids$|^repo$|^owner$|^username$|^url$|number$|^attendees$|^recipients$|^parent$)/i.test(
    key,
  );
