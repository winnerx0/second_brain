import { tool } from 'langchain';
import { z } from 'zod';
import { planWorkflow } from './planner.js';
import { saveWorkflow, getWorkflow, setEnabled, enqueue } from './service.js';
import { db } from '../db/client.js';
import { asc } from 'drizzle-orm';
import { workflows } from '../db/schema.js';
import { config } from '../config.js';

export const workflowTools = [
  tool(
    async ({ instructions, workflowId, expectedRevision }) => {
      const planned = await planWorkflow(instructions);
      if (!planned.definition) return JSON.stringify(planned);
      const enabled = workflowId
        ? (await getWorkflow(workflowId)).enabled
        : true;
      const id = await saveWorkflow(
        planned.definition,
        workflowId,
        expectedRevision,
        enabled,
      );
      return JSON.stringify({
        workflow: await getWorkflow(id),
        url: `${config.APP_URL}/workflows/${id}`,
        message: enabled
          ? 'Saved and activated. The specified recurring actions are authorized.'
          : 'Saved; the workflow remains paused.',
      });
    },
    {
      name: 'schedule_workflow',
      description:
        'Create or edit a persistent workflow from the user’s explicit automation request. Include their full instructions and clarification answers. A clear request activates immediately; returns questions if ambiguous. Editing requires current ID and revision from list_workflows.',
      schema: z.object({
        instructions: z.string(),
        workflowId: z.number().int().positive().optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      }),
    },
  ),
  tool(
    async () =>
      JSON.stringify(
        await db.select({ id: workflows.id, name: workflows.name, enabled: workflows.enabled, lifecycle: workflows.lifecycle, active_revision: workflows.activeRevision, next_run_at: workflows.nextRunAt, plan: workflows.plan }).from(workflows).orderBy(asc(workflows.updatedAt)),
      ),
    {
      name: 'list_workflows',
      description:
        'List saved automations, current revision, instructions and schedules.',
      schema: z.object({}),
    },
  ),
  tool(
    async ({ id, action }) => {
      if (action === 'run') return JSON.stringify({ runId: await enqueue(id) });
      await setEnabled(id, action === 'resume');
      return JSON.stringify(await getWorkflow(id));
    },
    {
      name: 'manage_workflow',
      description: 'Pause, resume or run an existing workflow when requested.',
      schema: z.object({
        id: z.number().int().positive(),
        action: z.enum(['pause', 'resume', 'run']),
      }),
    },
  ),
] as const;
