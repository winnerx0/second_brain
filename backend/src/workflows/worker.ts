import { db } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { workflowWorkers } from '../db/schema.js';
import { logger } from '../logger.js';
import { scheduleDue, claimRun, executeRun, workerId } from './engine.js';
import { learnOneRun } from './learning.js';

const shutdown = new AbortController();
const active = new Set<Promise<void>>();
let learning = false;
let learningTask: Promise<unknown> | undefined;
process.on('SIGTERM', () => shutdown.abort());
process.on('SIGINT', () => shutdown.abort());
logger.info(`[workflows] worker ${workerId} started`);
try {
  while (!shutdown.signal.aborted) {
    try {
      await db.insert(workflowWorkers).values({ id: workerId }).onConflictDoUpdate({ target: workflowWorkers.id, set: { heartbeatAt: new Date() } });
      await scheduleDue();
      while (active.size < 4 && !shutdown.signal.aborted) {
        const run = await claimRun(workerId);
        if (!run) break;
        const promise = executeRun(run, workerId, shutdown.signal)
          .catch((error) => logger.error('[workflow.execute]', error))
          .then(() => {
            active.delete(promise);
          });
        active.add(promise);
      }
      if (!learning && process.env.WORKFLOW_LEARNING_ENABLED !== 'false') {
        learning = true;
        learningTask = learnOneRun()
          .catch((error) => logger.error('[workflow.learn]', error))
          .finally(() => {
            learning = false;
          });
      }
    } catch (error) {
      logger.error('[workflow.worker]', error);
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        shutdown.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 15_000);
      shutdown.signal.addEventListener('abort', done, { once: true });
      if (shutdown.signal.aborted) done();
    });
  }
} finally {
  await Promise.allSettled(active);
  await learningTask;
  await db.delete(workflowWorkers).where(eq(workflowWorkers.id, workerId));
}
