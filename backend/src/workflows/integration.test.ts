import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  spyOn,
} from 'bun:test';
import { readFile } from 'node:fs/promises';
import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { Definition } from './types.js';

const database = process.env.WORKFLOW_TEST_DATABASE_URL;
// Integration tests never use DATABASE_URL or the developer's normal database.
if (database) {
  const url = new URL(database);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/workflow_test'
  )
    throw new Error('Tests require an isolated local workflow_test database');
  process.env.DATABASE_URL = database;
  for (const key of [
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'GITHUB_USERNAME',
    'GOOGLE_CALENDAR_ID',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'NOTION_TOKEN',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_API_KEY',
    'KIVIA_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
    'XAI_API_KEY',
    'TAVILY_API_KEY',
  ])
    process.env[key] = 'test-placeholder';
}
const suite = database ? describe : describe.skip;
suite('persistent workflow engine (isolated Postgres)', () => {
  let pool: (typeof import('../db/client.js'))['pool'];
  let service: typeof import('./service.js');
  let engine: typeof import('./engine.js');
  const definition: Definition = {
    name: 'Test workflow',
    description: 'Integration fixture',
    instructions: 'Summarize provided evidence',
    trigger: {
      kind: 'cron',
      cron: '* * * * *',
      at: null,
      timezone: 'Africa/Lagos',
    },
    steps: [
      {
        id: 'summary',
        title: 'Summary',
        specialist: 'synthesis',
        instruction: 'Summarize',
        dependsOn: [],
        permissions: [],
      },
    ],
  };
  beforeAll(async () => {
    ({ pool } = await import('../db/client.js'));
    service = await import('./service.js');
    engine = await import('./engine.js');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    // Test the upgrade from existing manual workflows, including interrupted legacy runs.
    for (const file of [
      '0000_late_quentin_quire',
      '0001_memories_keyed',
      '0002_charming_omega_flight',
      '0003_smart_sabra',
      '0004_classy_vanisher',
      '0005_fast_mercury',
    ])
      await pool.query(
        await readFile(
          new URL('../../drizzle/' + file + '.sql', import.meta.url),
          'utf8',
        ),
      );
    await pool.query(
      `INSERT INTO workflows(name,plan) VALUES('Legacy','Original plan'); INSERT INTO workflow_runs(workflow_id,status) VALUES(1,'running'),(1,'running');`,
    );
    await pool.query(
      await readFile(
        new URL('../../drizzle/0006_scheduled_workflows.sql', import.meta.url),
        'utf8',
      ),
    );
  });
  afterAll(async () => {
    await pool?.end();
  });
  test('upgrade retains manual plans and closes interrupted legacy runs', async () => {
    const w = await service.getWorkflow(1);
    expect(w.plan).toBe('Original plan');
    expect(w.definition).toBeNull();
    expect(w.nextRunAt).toBeNull();
    const runs = await pool.query(
      'SELECT status FROM workflow_runs WHERE workflow_id=1',
    );
    expect(runs.rows.every((r) => r.status === 'failed')).toBe(true);
  });
  test('concurrent schedulers create exactly one latest catch-up occurrence', async () => {
    const id = await service.saveWorkflow(definition);
    await pool.query(
      `UPDATE workflows SET next_run_at=now()-interval '2 days' WHERE id=$1`,
      [id],
    );
    await Promise.all([
      engine.scheduleDue(),
      engine.scheduleDue(),
      engine.scheduleDue(),
    ]);
    const runs = await pool.query(
      'SELECT * FROM workflow_runs WHERE workflow_id=$1',
      [id],
    );
    expect(runs.rows).toHaveLength(1);
    expect(
      Date.now() - new Date(runs.rows[0].scheduled_for).getTime(),
    ).toBeLessThan(60_000);
    await service.setEnabled(id, false);
  });
  test('manual runs deduplicate and pause cancels queued scheduled runs', async () => {
    const id = await service.saveWorkflow(definition);
    const ids = await Promise.all([service.enqueue(id), service.enqueue(id)]);
    expect(ids[0]).toBe(ids[1]);
    await pool.query(
      `UPDATE workflow_runs SET status='cancelled' WHERE workflow_id=$1`,
      [id],
    );
    await pool.query(
      `UPDATE workflows SET next_run_at=now()-interval '1 minute' WHERE id=$1`,
      [id],
    );
    await engine.scheduleDue();
    await service.setEnabled(id, false);
    const queued = await pool.query(
      `SELECT id FROM workflow_runs WHERE workflow_id=$1 AND status='queued'`,
      [id],
    );
    expect(queued.rowCount).toBe(0);
  });
  test('revision conflicts preserve current plan and historical run snapshots', async () => {
    const id = await service.saveWorkflow(definition);
    const runId = await service.enqueue(id);
    await service.saveWorkflow({ ...definition, name: 'Updated' }, id, 1);
    await expect(service.saveWorkflow(definition, id, 1)).rejects.toThrow(
      'Revision conflict',
    );
    expect((await service.getRun(runId)).definition as { name: string }).toHaveProperty('name', 'Test workflow');
    await pool.query(
      `UPDATE workflow_runs SET status='cancelled' WHERE id=$1`,
      [runId],
    );
    await service.setEnabled(id, false);
  });
  test('lease recovery queues reads but does not repeat uncertain writes', async () => {
    const id = await service.saveWorkflow(definition);
    const runId = await service.enqueue(id);
    await pool.query(
      `UPDATE workflow_runs SET status='running',lease_owner='dead',heartbeat_at=now()-interval '5 minutes' WHERE id=$1`,
      [runId],
    );
    await pool.query(
      `INSERT INTO workflow_actions(run_id,step_id,tool,fingerprint,status) VALUES($1,'summary','send_email','test','started')`,
      [runId],
    );
    await engine.claimRun('recovery');
    expect((await service.getRun(runId)).status).toBe('needs_attention');
    await service.setEnabled(id, false);
  });
  test('claims are exclusive and successful execution persists steps and events', async () => {
    const id = await service.saveWorkflow(definition);
    const runId = await service.enqueue(id);
    const claims = await Promise.all([
      engine.claimRun('one'),
      engine.claimRun('two'),
    ]);
    expect(claims.filter((r) => r?.id === runId)).toHaveLength(1);
    const owner = claims[0]?.id === runId ? 'one' : 'two';
    const { model } = await import('../shared.js');
    const mock = spyOn(model, 'invoke').mockResolvedValue(
      new AIMessageChunk('Verified summary'),
    );
    try {
      await engine.executeRun(
        claims.find((r) => r?.id === runId)!,
        owner,
        new AbortController().signal,
      );
    } finally {
      mock.mockRestore();
    }
    const run = await service.getRun(runId);
    expect(run.status).toBe('completed');
    expect(run.steps[0]?.output).toBe('Verified summary');
    expect(
      (
        await pool.query('SELECT id FROM workflow_events WHERE run_id=$1', [
          runId,
        ])
      ).rowCount,
    ).toBeGreaterThan(2);
    await service.setEnabled(id, false);
  });
  test('proposals require acceptance and stale proposals cannot overwrite edits', async () => {
    const id = await service.saveWorkflow(definition);
    const result = await pool.query(
      `INSERT INTO workflow_proposals(workflow_id,base_revision,reason,definition) VALUES($1,1,'User feedback',$2) RETURNING id`,
      [id, JSON.stringify({ ...definition, name: 'Improved' })],
    );
    expect((await service.getWorkflow(id)).name).toBe('Test workflow');
    await service.acceptProposal(result.rows[0].id);
    expect((await service.getWorkflow(id)).name).toBe('Improved');
    const stale = await pool.query(
      `INSERT INTO workflow_proposals(workflow_id,base_revision,reason,definition) VALUES($1,1,'Stale',$2) RETURNING id`,
      [id, JSON.stringify(definition)],
    );
    await expect(service.acceptProposal(stale.rows[0].id)).rejects.toThrow(
      'Revision conflict',
    );
    await service.setEnabled(id, false);
  });
  test('deleting a workflow removes its own revisions and history', async () => {
    const id = await service.saveWorkflow(definition);
    const runId = await service.enqueue(id);
    await pool.query('DELETE FROM workflows WHERE id=$1', [id]);
    expect(
      (await pool.query('SELECT id FROM workflow_runs WHERE id=$1', [runId]))
        .rowCount,
    ).toBe(0);
  });
  test('global concurrency is capped and safe expired work is reclaimed', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => service.saveWorkflow(definition)),
    );
    for (const id of ids) await service.enqueue(id);
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, i) => engine.claimRun('capacity-' + i)),
    );
    expect(claims.filter(Boolean)).toHaveLength(4);
    const expired = claims.find(Boolean)!;
    await pool.query(
      `UPDATE workflow_runs SET heartbeat_at=now()-interval '5 minutes' WHERE id=$1`,
      [expired.id],
    );
    expect((await engine.claimRun('replacement'))?.id).toBe(expired.id);
    await pool.query(
      `UPDATE workflow_runs SET status='cancelled' WHERE workflow_id=ANY($1::int[])`,
      [ids],
    );
    for (const id of ids) await service.setEnabled(id, false);
  });
  test('write checkpoints prevent a changed generated body from causing a duplicate send', async () => {
    const id = await service.saveWorkflow(definition);
    const runId = await service.enqueue(id);
    await pool.query(
      `UPDATE workflow_runs SET status='running',lease_owner='policy' WHERE id=$1`,
      [runId],
    );
    const { executionContext, workflowPolicy } = await import('./policy.js');
    const step = {
      ...definition.steps[0]!,
      permissions: [
        { tool: 'send_email', constraints: { to: ['alice@example.com'] } },
      ],
    };
    let sends = 0;
    const context = {
      runId,
      step,
      signal: new AbortController().signal,
      failures: [] as string[],
      owner: 'policy',
      toolCalls: 0,
    };
    await executionContext.run(context, async () => {
      const call = (to: string, body: string) =>
        workflowPolicy.wrapToolCall!(
          {
            toolCall: {
              name: 'send_email',
              id: 'test-call',
              args: { to, body },
            },
          } as never,
          async () => {
            sends++;
            return new ToolMessage({
              content: 'Sent',
              tool_call_id: 'test-call',
            });
          },
        );
      await call('alice@example.com', 'First version');
      await call('alice@example.com', 'Regenerated version');
      expect(sends).toBe(1);
      await expect(
        Promise.resolve(call('bob@example.com', 'Unauthorized')),
      ).rejects.toThrow('Unauthorized target');
      expect(sends).toBe(1);
    });
    await pool.query(
      `UPDATE workflow_runs SET status='completed' WHERE id=$1`,
      [runId],
    );
    await service.setEnabled(id, false);
  });
  test('recovery cancels an outdated scheduled revision instead of leaving it queued', async () => {
    const id = await service.saveWorkflow(definition);
    await pool.query(`UPDATE workflows SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [id]);
    await engine.scheduleDue(); const claimed = await engine.claimRun('old-revision'); expect(claimed).not.toBeNull();
    await service.saveWorkflow({ ...definition, name: 'New revision' }, id, 1);
    await pool.query(`UPDATE workflow_runs SET heartbeat_at=now()-interval '5 minutes' WHERE id=$1`, [claimed!.id]);
    await engine.claimRun('recovery'); expect((await service.getRun(claimed!.id)).status).toBe('cancelled');
    await service.setEnabled(id, false);
  });
  test('natural-language tool asks for clarification or activates a validated plan', async () => {
    const { model } = await import('../shared.js');
    const context = await import('../memory/context.js');
    const recall = spyOn(context, 'buildRecallContext').mockResolvedValue('');
    let answer: unknown = { clarifications: ['What time should it run?'], definition: null };
    const structured = spyOn(model, 'withStructuredOutput').mockReturnValue({ invoke: async () => answer } as never);
    try {
      const { workflowTools } = await import('./tools.js');
      const before = (await pool.query('SELECT count(*)::int AS count FROM workflows')).rows[0].count;
      const ambiguous = JSON.parse(await workflowTools[0]!.invoke({ instructions: 'Summarize my work regularly' }) as string);
      expect(ambiguous.clarifications).toHaveLength(1);
      expect((await pool.query('SELECT count(*)::int AS count FROM workflows')).rows[0].count).toBe(before);
      answer = { clarifications: [], definition };
      const created = JSON.parse(await workflowTools[0]!.invoke({ instructions: 'Summarize every minute' }) as string);
      expect(created.workflow.enabled).toBe(true); expect(created.workflow.nextRunAt).not.toBeNull();
      await service.setEnabled(created.workflow.id, false);
    } finally { recall.mockRestore(); structured.mockRestore(); }
  });
  test('reflection saves evidence and proposals without silently changing the workflow', async () => {
    await pool.query('UPDATE workflow_runs SET learned=true');
    const id = await service.saveWorkflow(definition); const runId = await service.enqueue(id);
    await pool.query(`UPDATE workflow_runs SET status='completed',feedback='Make the summary shorter' WHERE id=$1`, [runId]);
    const { model } = await import('../shared.js');
    const structured = spyOn(model, 'withStructuredOutput').mockReturnValue({ invoke: async () => ({ lessons: ['The user prefers a shorter summary.'], reason: 'Explicit feedback requested brevity.', proposal: { ...definition, description: 'Shorter summary' } }) } as never);
    try {
      const { learnOneRun } = await import('./learning.js'); await learnOneRun();
      expect((await service.getWorkflow(id)).activeRevision).toBe(1);
      const lessons = await pool.query('SELECT * FROM workflow_lessons WHERE workflow_id=$1', [id]); expect(lessons.rows[0].run_id).toBe(runId);
      const proposals = await pool.query('SELECT * FROM workflow_proposals WHERE workflow_id=$1', [id]); expect(proposals.rows[0].status).toBe('pending');
      await pool.query('UPDATE workflow_lessons SET active=false WHERE workflow_id=$1', [id]);
      await pool.query('UPDATE workflow_runs SET learned=false WHERE id=$1', [runId]); await learnOneRun();
      expect((await pool.query('SELECT id FROM workflow_lessons WHERE workflow_id=$1 AND active', [id])).rowCount).toBe(0);
    } finally { structured.mockRestore(); await service.setEnabled(id, false); }
  });
  test('run API returns immediately and SSE emits before execution finishes', async () => {
    const { workflowRoutes } = await import('./routes.js');
    const id = await service.saveWorkflow(definition);
    const response = await workflowRoutes.request('/' + id + '/run', {
      method: 'POST',
    });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: number };
    await service.event(runId, { type: 'status', status: 'queued' });
    const streaming = await workflowRoutes.request(
      '/runs/' + runId + '/events',
    );
    const reader = streaming.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('queued');
    expect((await service.getRun(runId)).status).toBe('queued');
    await pool.query(
      `UPDATE workflow_runs SET status='completed' WHERE id=$1`,
      [runId],
    );
    await service.event(runId, { type: 'final', text: 'Done' });
    while (!(await reader.read()).done) {
      /* drain the completed stream */
    }
    const events = await pool.query(
      'SELECT id FROM workflow_events WHERE run_id=$1 ORDER BY id',
      [runId],
    );
    const replay = await workflowRoutes.request(
      '/runs/' + runId + '/events?after=' + events.rows[0].id,
    );
    const text = await replay.text();
    expect(text).toContain('Done');
    expect(text).not.toContain('queued');
    await service.setEnabled(id, false);
  });
});
