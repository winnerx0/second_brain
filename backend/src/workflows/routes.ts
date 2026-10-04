import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { planWorkflow } from './planner.js';
import {
  saveWorkflow,
  getWorkflow,
  setEnabled,
  enqueue,
  getRun,
  acceptProposal,
  sqlTransaction,
} from './service.js';

export const workflowRoutes = new Hono();
const idOf = (value: string) => z.coerce.number().int().positive().parse(value);
workflowRoutes.onError((error, c) =>
  c.json(
    { error: error.message },
    /not found/i.test(error.message)
      ? 404
      : /conflict|active run/i.test(error.message)
        ? 409
        : 400,
  ),
);
workflowRoutes.get('/health', async (c) => {
  const result = await pool.query(
    `SELECT count(*)::int AS workers FROM workflow_workers WHERE heartbeat_at>now()-interval '45 seconds'`,
  );
  const counts = await pool.query(
    `SELECT status,count(*)::int FROM workflow_runs GROUP BY status`,
  );
  const overdue = await pool.query(
    'SELECT count(*)::int AS count FROM workflows WHERE enabled AND next_run_at<now()',
  );
  return c.json({
    workers: result.rows[0].workers,
    schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
    runs: counts.rows,
    overdue: overdue.rows[0].count,
  });
});
workflowRoutes.post('/plan', async (c) => {
  const body = z
    .object({ instructions: z.string().min(1).max(20000) })
    .parse(await c.req.json());
  return c.json(await planWorkflow(body.instructions));
});
workflowRoutes.get('/', async (c) => {
  const rows = await pool.query(
    `SELECT w.*,r.definition,(SELECT status FROM workflow_runs WHERE workflow_id=w.id ORDER BY id DESC LIMIT 1) AS last_status FROM workflows w LEFT JOIN workflow_revisions r ON r.workflow_id=w.id AND r.version=w.active_revision ORDER BY w.updated_at DESC`,
  );
  return c.json({
    workflows: rows.rows.map((w) => ({
      ...w,
      activeRevision: w.active_revision,
      nextRunAt: w.next_run_at,
      lastRunAt: w.last_run_at,
    })),
  });
});
workflowRoutes.post('/', async (c) => {
  const body = z
    .object({ definition: z.unknown(), enabled: z.boolean().default(true) })
    .parse(await c.req.json());
  return c.json(
    await getWorkflow(
      await saveWorkflow(body.definition, undefined, undefined, body.enabled),
    ),
    201,
  );
});
workflowRoutes.get('/runs/:runId', async (c) =>
  c.json(await getRun(idOf(c.req.param('runId')))),
);
workflowRoutes.post('/runs/:runId/cancel', async (c) => {
  const id = idOf(c.req.param('runId'));
  await pool.query(
    `UPDATE workflow_runs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE id=$1 AND status IN ('queued','running')`,
    [id],
  );
  return c.json(await getRun(id));
});
workflowRoutes.post('/runs/:runId/feedback', async (c) => {
  const body = z
    .object({ feedback: z.string().min(1).max(4000) })
    .parse(await c.req.json());
  await pool.query(
    'UPDATE workflow_runs SET feedback=$2,learned=false WHERE id=$1',
    [idOf(c.req.param('runId')), body.feedback],
  );
  return c.json({ success: true });
});
workflowRoutes.get('/runs/:runId/events', async (c) => {
  const id = idOf(c.req.param('runId'));
  await getRun(id);
  let cursor = z.coerce
    .number()
    .int()
    .nonnegative()
    .parse(c.req.header('Last-Event-ID') || c.req.query('after') || 0);
  return streamSSE(c, async (stream) => {
    while (!stream.aborted) {
      const result = await pool.query(
        'SELECT id,event FROM workflow_events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 100',
        [id, cursor],
      );
      for (const row of result.rows) {
        await stream.writeSSE({
          id: String(row.id),
          data: JSON.stringify(row.event),
        });
        cursor = row.id;
      }
      const run = await pool.query(
        'SELECT status FROM workflow_runs WHERE id=$1',
        [id],
      );
      if (
        !['queued', 'running'].includes(run.rows[0]?.status) &&
        result.rows.length < 100
      ) {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ status: run.rows[0]?.status }),
        });
        break;
      }
      await stream.writeSSE({ event: 'heartbeat', data: '{}' });
      await stream.sleep(1000);
    }
  });
});
workflowRoutes.post('/proposals/:proposalId/accept', async (c) =>
  c.json(
    await getWorkflow(await acceptProposal(idOf(c.req.param('proposalId')))),
  ),
);
workflowRoutes.post('/proposals/:proposalId/reject', async (c) => {
  await pool.query(
    `UPDATE workflow_proposals SET status='rejected' WHERE id=$1 AND status='pending'`,
    [idOf(c.req.param('proposalId'))],
  );
  return c.json({ success: true });
});
workflowRoutes.patch('/lessons/:lessonId', async (c) => {
  const body = z
    .object({
      lesson: z.string().min(1).max(4000).optional(),
      active: z.boolean().optional(),
    })
    .parse(await c.req.json());
  await pool.query(
    'UPDATE workflow_lessons SET lesson=COALESCE($2,lesson),active=COALESCE($3,active),confidence=1 WHERE id=$1',
    [idOf(c.req.param('lessonId')), body.lesson, body.active],
  );
  return c.json({ success: true });
});
workflowRoutes.get('/:id', async (c) =>
  c.json(await getWorkflow(idOf(c.req.param('id')))),
);
workflowRoutes.patch('/:id', async (c) => {
  const id = idOf(c.req.param('id'));
  const body = z
    .object({
      definition: z.unknown().optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .parse(await c.req.json());
  if (body.definition)
    await saveWorkflow(
      body.definition,
      id,
      body.expectedRevision,
      body.enabled ?? (await getWorkflow(id)).enabled,
    );
  else if (body.enabled !== undefined) await setEnabled(id, body.enabled);
  return c.json(await getWorkflow(id));
});
workflowRoutes.delete('/:id', async (c) => {
  await sqlTransaction(async (client) => {
    const id = idOf(c.req.param('id'));
    await client.query('SELECT id FROM workflows WHERE id=$1 FOR UPDATE', [id]);
    const active = await client.query(
      `SELECT id FROM workflow_runs WHERE workflow_id=$1 AND status='running'`,
      [id],
    );
    if (active.rowCount)
      throw new Error('Cancel the active run before deleting this workflow');
    await client.query('DELETE FROM workflows WHERE id=$1', [id]);
  });
  return c.json({ success: true });
});
workflowRoutes.post('/:id/run', async (c) =>
  c.json({ runId: await enqueue(idOf(c.req.param('id'))) }, 202),
);
workflowRoutes.get('/:id/runs', async (c) => {
  const before = z.coerce
    .number()
    .int()
    .positive()
    .parse(c.req.query('before') || 2147483647);
  const rows = await pool.query(
    'SELECT * FROM workflow_runs WHERE workflow_id=$1 AND id<$2 ORDER BY id DESC LIMIT 30',
    [idOf(c.req.param('id')), before],
  );
  return c.json({ runs: rows.rows });
});
workflowRoutes.get('/:id/learning', async (c) => {
  const id = idOf(c.req.param('id'));
  const [lessons, proposals, revisions] = await Promise.all([
    pool.query(
      'SELECT * FROM workflow_lessons WHERE workflow_id=$1 AND active ORDER BY id DESC',
      [id],
    ),
    pool.query(
      'SELECT * FROM workflow_proposals WHERE workflow_id=$1 ORDER BY id DESC',
      [id],
    ),
    pool.query(
      'SELECT * FROM workflow_revisions WHERE workflow_id=$1 ORDER BY version DESC',
      [id],
    ),
  ]);
  return c.json({
    lessons: lessons.rows,
    proposals: proposals.rows,
    revisions: revisions.rows,
  });
});
