import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pool } from '../db/client.js';
import type { PoolClient } from 'pg';
import {
  workflowEvents,
  workflowProposals,
  workflowRevisions,
  workflowRuns,
  workflowSteps,
  workflows,
} from '../db/schema.js';
import {
  validateDefinition,
  nextOccurrence,
  preview,
  type Definition,
} from './types.js';
import { validateCapabilities } from './catalog.js';
import { connectionIssues } from './connections.js';

export async function transaction<T>(
  fn: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as typeof db));
}
export async function sqlTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function event(runId: number, data: Record<string, unknown>) {
  await db.insert(workflowEvents).values({ runId, event: data });
}
export async function getWorkflow(id: number) {
  const [w] = await db.select().from(workflows).where(eq(workflows.id, id));
  if (!w) throw new Error('Workflow not found');
  const [revision] = w.activeRevision
    ? await db
        .select()
        .from(workflowRevisions)
        .where(
          and(
            eq(workflowRevisions.workflowId, id),
            eq(workflowRevisions.version, w.activeRevision),
          ),
        )
    : [];
  const definition = (revision?.definition as Definition | null) ?? null;
  return {
    ...w,
    definition,
    preview: definition ? preview(definition.trigger) : [],
    connectionIssues: await connectionIssues(definition),
  };
}

export async function saveWorkflow(
  input: unknown,
  id?: number,
  expectedRevision?: number,
  enabled = true,
  txDb: typeof db = db,
): Promise<number> {
  const definition = validateDefinition(input);
  validateCapabilities(definition);
  if (
    enabled &&
    definition.trigger.kind === 'once' &&
    !nextOccurrence(definition.trigger)
  )
    throw new Error('One-time execution must be in the future');
  return txDb.transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db;
    let workflowId = id;
    let version = 1;
    if (workflowId) {
      const [existing] = await tx
        .select()
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .for('update');
      if (!existing) throw new Error('Workflow not found');
      if (expectedRevision !== existing.activeRevision)
        throw new Error('Revision conflict; reload before editing');
      version = existing.activeRevision + 1;
      await tx
        .update(workflowRuns)
        .set({
          status: 'cancelled',
          finishedAt: new Date(),
          error: 'Superseded workflow revision',
        })
        .where(
          and(
            eq(workflowRuns.workflowId, workflowId),
            eq(workflowRuns.status, 'queued'),
            eq(workflowRuns.trigger, 'schedule'),
          ),
        );
    } else {
      const [created] = await tx
        .insert(workflows)
        .values({
          name: definition.name,
          description: definition.description,
          plan: definition.instructions,
        })
        .returning({ id: workflows.id });
      workflowId = created!.id;
    }
    await tx
      .insert(workflowRevisions)
      .values({ workflowId: workflowId!, version, definition });
    await tx
      .update(workflows)
      .set({
        name: definition.name,
        description: definition.description,
        plan: definition.instructions,
        enabled,
        activeRevision: version,
        nextRunAt: enabled ? nextOccurrence(definition.trigger) : null,
        lifecycle: enabled
          ? definition.trigger.kind === 'manual'
            ? 'manual'
            : 'active'
          : 'paused',
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, workflowId!));
    return workflowId!;
  });
}

export async function setEnabled(id: number, enabled: boolean) {
  await transaction(async (tx) => {
    const [w] = await tx
      .select()
      .from(workflows)
      .where(eq(workflows.id, id))
      .for('update');
    if (!w) throw new Error('Workflow not found');
    const [revision] = w.activeRevision
      ? await tx
          .select()
          .from(workflowRevisions)
          .where(
            and(
              eq(workflowRevisions.workflowId, id),
              eq(workflowRevisions.version, w.activeRevision),
            ),
          )
      : [];
    const definition = revision?.definition as Definition | undefined;
    if (
      enabled &&
      definition?.trigger.kind === 'once' &&
      !nextOccurrence(definition.trigger)
    )
      throw new Error('Update the past one-time date before resuming');
    await tx
      .update(workflows)
      .set({
        enabled,
        nextRunAt:
          enabled && definition ? nextOccurrence(definition.trigger) : null,
        lifecycle: enabled
          ? definition?.trigger.kind === 'manual' || !definition
            ? 'manual'
            : 'active'
          : 'paused',
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, id));
    if (!enabled)
      await tx
        .update(workflowRuns)
        .set({
          status: 'cancelled',
          finishedAt: new Date(),
          error: 'Workflow paused',
        })
        .where(
          and(
            eq(workflowRuns.workflowId, id),
            eq(workflowRuns.status, 'queued'),
            eq(workflowRuns.trigger, 'schedule'),
          ),
        );
  });
}
export async function enqueue(id: number) {
  return transaction(async (tx) => {
    const [w] = await tx
      .select()
      .from(workflows)
      .where(eq(workflows.id, id))
      .for('update');
    if (!w) throw new Error('Workflow not found');
    const [revision] = await tx
      .select()
      .from(workflowRevisions)
      .where(
        and(
          eq(workflowRevisions.workflowId, id),
          eq(workflowRevisions.version, w.activeRevision),
        ),
      );
    if (!revision)
      throw new Error('Convert this legacy text plan before running it');
    const [active] = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowId, id),
          inArray(workflowRuns.status, ['queued', 'running']),
        ),
      );
    if (active) return active.id;
    const [run] = await tx
      .insert(workflowRuns)
      .values({ workflowId: id, revisionId: revision.id, status: 'queued' })
      .returning({ id: workflowRuns.id });
    return run!.id;
  });
}
export async function getRun(id: number) {
  const [result] = await db
    .select({ run: workflowRuns, definition: workflowRevisions.definition })
    .from(workflowRuns)
    .leftJoin(
      workflowRevisions,
      eq(workflowRevisions.id, workflowRuns.revisionId),
    )
    .where(eq(workflowRuns.id, id));
  if (!result) throw new Error('Run not found');
  const steps = await db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.runId, id))
    .orderBy(asc(workflowSteps.startedAt), asc(workflowSteps.stepId));
  return { ...result.run, definition: result.definition, steps };
}
export async function acceptProposal(id: number) {
  return transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(workflowProposals)
      .where(
        and(
          eq(workflowProposals.id, id),
          eq(workflowProposals.status, 'pending'),
        ),
      )
      .for('update');
    if (!proposal) throw new Error('Pending proposal not found');
    const [w] = await tx
      .select({ enabled: workflows.enabled })
      .from(workflows)
      .where(eq(workflows.id, proposal.workflowId));
    await saveWorkflow(
      proposal.definition,
      proposal.workflowId,
      proposal.baseRevision,
      w!.enabled,
      tx as unknown as typeof db,
    );
    await tx
      .update(workflowProposals)
      .set({ status: 'accepted' })
      .where(eq(workflowProposals.id, id));
    return proposal.workflowId;
  });
}
