export type WorkflowDefinition = {
  name: string;
  description: string;
  instructions: string;
  trigger: {
    kind: 'manual' | 'once' | 'cron';
    cron: string | null;
    at: string | null;
    timezone: string;
  };
  steps: {
    id: string;
    title: string;
    specialist: string;
    instruction: string;
    dependsOn: string[];
    permissions: {
      tool: string;
      constraints: Record<string, (string | number | boolean)[]>;
    }[];
  }[];
};
export type Workflow = {
  id: number;
  name: string;
  description: string;
  plan: string;
  enabled: boolean;
  lifecycle: string;
  activeRevision: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  last_status?: string;
  definition: WorkflowDefinition | null;
  preview?: string[];
  connectionIssues?: string[];
};
export type Run = {
  id: number;
  status: string;
  trigger: string;
  ran_at: string;
  scheduled_for: string | null;
  output: string | null;
  error: string | null;
  definition?: WorkflowDefinition;
  steps?: {
    step_id: string;
    status: string;
    output: string | null;
    error: string | null;
  }[];
};
export const WORKFLOWS_URL = `${(import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3005').replace(/\/$/, '')}/workflows`;
export async function workflowApi<T>(
  path = '',
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${WORKFLOWS_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status})`);
  return result as T;
}
export function scheduleLabel(w: Workflow) {
  const trigger = w.definition?.trigger;
  if (!trigger || trigger.kind === 'manual') return 'On demand';
  if (trigger.kind === 'once')
    return `Once · ${new Date(trigger.at!).toLocaleString()} · ${trigger.timezone}`;
  const [minute, hour, day, month, weekday] = (trigger.cron ?? '').split(' ');
  if (
    /^\d+$/.test(hour ?? '') &&
    /^\d+$/.test(minute ?? '') &&
    day === '*' &&
    month === '*'
  ) {
    const time = hour!.padStart(2, '0') + ':' + minute!.padStart(2, '0');
    if (weekday === '*') return `Every day at ${time} · ${trigger.timezone}`;
    if (weekday === '1-5') return `Weekdays at ${time} · ${trigger.timezone}`;
  }
  return `${trigger.cron} · ${trigger.timezone}`;
}
export const formatTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : '—';
