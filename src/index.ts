import { CronJob } from 'cron';
import { logger } from './logger.ts';
import { runMemoryLifecycleReview } from './tools/memory.ts';
import { runBriefing } from './agent.ts';
import app from './app.ts';

const cron = new CronJob('4 9 * * *', async () => {
  try {
    logger.info('Running daily briefing');
    await runBriefing();
  } catch (error) {
    logger.error('[cron.briefing]', error);
  }
});

const memoryCron = new CronJob('0 3 * * *', async () => {
  try {
    logger.info('Running memory lifecycle review');
    await runMemoryLifecycleReview();
  } catch (error) {
    logger.error('[cron.memory]', error);
  }
});

cron.start();
memoryCron.start();

export default {
  fetch: app.fetch.bind(app),
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 0,
};
