import app, { websocket } from './app.js';
import { logger } from './logger.js';
import { startWorkflowWorker } from './workflows/worker.js';

const workflowWorker = startWorkflowWorker();
const server = Bun.serve({
  fetch: app.fetch.bind(app),
  websocket,
  port: Number(process.env.PORT ?? 3005),
  idleTimeout: 0,
});
let shutdown: Promise<void> | undefined;
const stop = (signal: string) => {
  shutdown ??= (async () => {
    const forceHttpShutdown = setTimeout(() => {
      void server
        .stop(true)
        .catch((error) =>
          logger.error('Failed to force-stop HTTP server', error),
        );
    }, 80_000);
    try {
      await Promise.all([server.stop(), workflowWorker.stop()]);
      logger.info(`Received ${signal}; workflow worker stopped`);
      process.exit(0);
    } catch (error) {
      logger.error(`Failed to stop workflow worker after ${signal}`, error);
      process.exit(1);
    } finally {
      clearTimeout(forceHttpShutdown);
    }
  })();
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

export { server };
