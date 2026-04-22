import { CronJob } from 'cron';
import { logger } from './logger.ts';
import { runMemoryLifecycleReview } from './tools/memory.ts';
import app from './app.ts';

const cron = new CronJob('4 9 * * *', async () => {
  try {
    logger.info('Running briefing cron job');
    await runMemoryLifecycleReview();
  } catch (error) {
    logger.error('[cron]', error);
  }
});

cron.start();

export default {
  fetch: app.fetch.bind(app),
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 0,
};
