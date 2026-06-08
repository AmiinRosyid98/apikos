import { Worker, type Job } from 'bullmq';
import { BULLMQ_CONNECTION, QUEUE_NAMES } from '../config/redis';
import { env } from '../config/env';
import {
  scheduleDailyInvoiceRun,
  closeInvoiceQueue,
  type InvoiceJobData,
} from './queue';
import {
  runInvoiceGeneration,
  disconnectInvoiceGenerator,
  type InvoiceRunSummary,
} from './invoiceGenerator';

/**
 * Standalone BullMQ worker process (run via `npm run worker`). Kept SEPARATE from the API
 * server (`npm run dev`/`npm start`) so billing jobs cannot be starved by HTTP load and can
 * be scaled/deployed independently.
 *
 * On boot it registers the daily repeatable invoice-generation job, then processes:
 *   - `daily-invoice-run` (cron) and `invoice-run` (on-demand/admin/test) — both call the
 *     same `runInvoiceGeneration` and return a per-run summary (generated vs skipped).
 */

async function main() {
  const worker = new Worker<InvoiceJobData, InvoiceRunSummary>(
    QUEUE_NAMES.invoiceGeneration,
    async (job: Job<InvoiceJobData>) => {
      return runInvoiceGeneration({ source: job.name, ...job.data });
    },
    {
      connection: BULLMQ_CONNECTION,
      concurrency: 1, // billing runs are serial per worker — avoids racing the same period
    },
  );

  worker.on('completed', (job, result) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        job: 'invoice-generation',
        event: 'job.completed',
        jobId: job.id,
        name: job.name,
        totalGenerated: result?.totalGenerated,
        totalSkipped: result?.totalSkipped,
        propertiesMatched: result?.propertiesMatched,
      }),
    );
  });

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        job: 'invoice-generation',
        event: 'job.failed',
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      }),
    );
  });

  worker.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[worker] error:', err.message);
  });

  await scheduleDailyInvoiceRun();

  // eslint-disable-next-line no-console
  console.log(
    `🛠  Invoice worker started — queue "${QUEUE_NAMES.invoiceGeneration}", ` +
      `schedule "${env.INVOICE_CRON}" (${env.INVOICE_CRON_TZ}), Redis ${env.REDIS_URL}`,
  );

  const shutdown = async (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n${sig} received — shutting down worker...`);
    await worker.close();
    await closeInvoiceQueue();
    await disconnectInvoiceGenerator();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal worker boot error:', e);
  process.exit(1);
});
