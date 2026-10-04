import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createMiddleware, ToolMessage } from 'langchain';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workflowActions, workflowRuns } from '../db/schema.js';
import { checkPermission, isReadTool, isTarget, type Step } from './types.js';
import { event } from './service.js';

export const executionContext = new AsyncLocalStorage<{
  runId: number;
  step: Step;
  signal: AbortSignal;
  failures: string[];
  owner: string;
  toolCalls: number;
}>();
export const workflowPolicy = createMiddleware({
  name: 'workflow-permissions-and-checkpoints',
  wrapToolCall: async (request, handler) => {
    const ctx = executionContext.getStore();
    if (!ctx) return handler(request);
    const call = request.toolCall;
    ctx.toolCalls++;
    ctx.signal.throwIfAborted();
    try {
      checkPermission(ctx.step, call.name, call.args);
    } catch (error) {
      ctx.failures.push(String(error));
      throw error;
    }
    const [state] = await db
      .select({
        status: workflowRuns.status,
        cancelRequested: workflowRuns.cancelRequested,
        leaseOwner: workflowRuns.leaseOwner,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, ctx.runId));
    if (
      state?.status !== 'running' ||
      state.cancelRequested ||
      state.leaseOwner !== ctx.owner
    ) {
      ctx.failures.push('Run is no longer active');
      throw new Error('Run is no longer active');
    }
    const read = isReadTool(call.name);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          call.name,
          Object.entries(call.args)
            .filter(([key]) => isTarget(key))
            .sort(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      .digest('hex');
    if (!read) {
      const [inserted] = await db
        .insert(workflowActions)
        .values({
          runId: ctx.runId,
          stepId: ctx.step.id,
          tool: call.name,
          fingerprint,
          status: 'started',
        })
        .onConflictDoNothing()
        .returning({ id: workflowActions.id });
      if (!inserted) {
        const [old] = await db
          .select()
          .from(workflowActions)
          .where(
            and(
              eq(workflowActions.runId, ctx.runId),
              eq(workflowActions.stepId, ctx.step.id),
              eq(workflowActions.fingerprint, fingerprint),
            ),
          );
        if (old?.status === 'completed')
          return new ToolMessage({
            content: typeof old.output === 'string' ? old.output : JSON.stringify(old.output ?? ''),
            tool_call_id: call.id!,
            name: call.name,
          });
        ctx.failures.push(
          `Needs attention: previous ${call.name} outcome is uncertain`,
        );
        throw new Error(
          `Needs attention: previous ${call.name} outcome is uncertain`,
        );
      }
    }
    await event(ctx.runId, {
      type: 'tool_start',
      stepId: ctx.step.id,
      toolCallId: call.id,
      tool: call.name,
    });
    try {
      let result: Awaited<ReturnType<typeof handler>> | undefined;
      for (let attempt = 0; attempt < (read ? 2 : 1); attempt++) {
        try {
          result = await handler(request);
          if (
            result instanceof ToolMessage &&
            (result.status === 'error' ||
              /^(error|failed)|"success"\s*:\s*false/i.test(
                String(result.content),
              ))
          )
            throw new Error(String(result.content));
          break;
        } catch (error) {
          if (
            !read ||
            attempt === 1 ||
            !/429|50[234]|timeout|network|fetch/i.test(String(error))
          )
            throw error;
        }
      }
      if (!result) throw new Error('Tool returned no result');
      if (!read)
        await db
          .update(workflowActions)
          .set({
            status: 'completed',
            output: { content: result instanceof ToolMessage ? result.content : '' },
          })
          .where(
            and(
              eq(workflowActions.runId, ctx.runId),
              eq(workflowActions.stepId, ctx.step.id),
              eq(workflowActions.fingerprint, fingerprint),
            ),
          );
      await event(ctx.runId, {
        type: 'tool_end',
        stepId: ctx.step.id,
        toolCallId: call.id,
        tool: call.name,
        success: true,
      });
      return result;
    } catch (error) {
      ctx.failures.push(String(error));
      await event(ctx.runId, {
        type: 'tool_end',
        stepId: ctx.step.id,
        toolCallId: call.id,
        tool: call.name,
        success: false,
        error: String(error),
      });
      throw error;
    }
  },
});
