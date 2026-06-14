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
import {
  scheduleBookingRelease,
  closeBookingReleaseQueue,
} from './bookingQueue';
import {
  runBookingRelease,
  disconnectBookingReleaser,
  type BookingReleaseJobData,
  type BookingReleaseSummary,
} from './bookingReleaser';
import {
  scheduleReminderSweep,
  closeReminderQueue,
} from './reminderQueue';
import {
  runReminderSweep,
  disconnectReminderSender,
  type ReminderJobData,
  type ReminderSweepSummary,
} from './reminderSender';
import {
  schedulePaymentReconcile,
  closePaymentReconcileQueue,
} from './paymentReconcileQueue';
import {
  runPaymentReconcile,
  disconnectPaymentReconciler,
  type ReconcileJobData,
  type ReconcileSummary,
} from './paymentReconciler';

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

  // ── Booking auto-release worker (PRD §6.13) — same Redis, separate queue ──
  const bookingWorker = new Worker<BookingReleaseJobData, BookingReleaseSummary>(
    QUEUE_NAMES.bookingRelease,
    async (job: Job<BookingReleaseJobData>) => {
      return runBookingRelease({ source: job.name, ...job.data });
    },
    { connection: BULLMQ_CONNECTION, concurrency: 1 },
  );

  bookingWorker.on('completed', (job, result) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        job: 'booking-release',
        event: 'job.completed',
        jobId: job.id,
        name: job.name,
        totalReleased: result?.totalReleased,
        tenantsScanned: result?.tenantsScanned,
      }),
    );
  });

  bookingWorker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        job: 'booking-release',
        event: 'job.failed',
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      }),
    );
  });

  bookingWorker.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[booking-worker] error:', err.message);
  });

  // ── Reminder Otomatis sweep worker (PRD §6.10) — same Redis, separate queue ──
  const reminderWorker = new Worker<ReminderJobData, ReminderSweepSummary>(
    QUEUE_NAMES.reminderSweep,
    async (job: Job<ReminderJobData>) => {
      return runReminderSweep({ source: job.name, ...job.data });
    },
    { connection: BULLMQ_CONNECTION, concurrency: 1 },
  );

  reminderWorker.on('completed', (job, result) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        job: 'reminder-sweep',
        event: 'job.completed',
        jobId: job.id,
        name: job.name,
        totalSent: result?.totalSent,
        totalSkipped: result?.totalSkipped,
        tenantsScanned: result?.tenantsScanned,
      }),
    );
  });

  reminderWorker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        job: 'reminder-sweep',
        event: 'job.failed',
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      }),
    );
  });

  reminderWorker.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[reminder-worker] error:', err.message);
  });

  // ── Payment reconciliation sweep worker (PRD §6.8) — same Redis, separate queue ──
  const reconWorker = new Worker<ReconcileJobData, ReconcileSummary>(
    QUEUE_NAMES.paymentReconcile,
    async (job: Job<ReconcileJobData>) => {
      return runPaymentReconcile({ source: job.name, ...job.data });
    },
    { connection: BULLMQ_CONNECTION, concurrency: 1 },
  );

  reconWorker.on('completed', (job, result) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        job: 'payment-reconcile',
        event: 'job.completed',
        jobId: job.id,
        name: job.name,
        tenantsScanned: result?.tenantsScanned,
        tenantsWithMismatch: result?.tenantsWithMismatch,
      }),
    );
  });

  reconWorker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        job: 'payment-reconcile',
        event: 'job.failed',
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      }),
    );
  });

  reconWorker.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[recon-worker] error:', err.message);
  });

  await scheduleDailyInvoiceRun();
  await scheduleBookingRelease();
  await scheduleReminderSweep();
  await schedulePaymentReconcile();

  // eslint-disable-next-line no-console
  console.log(
    `🛠  Invoice worker started — queue "${QUEUE_NAMES.invoiceGeneration}", ` +
      `schedule "${env.INVOICE_CRON}" (${env.INVOICE_CRON_TZ}), Redis ${env.REDIS_URL}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `🛠  Booking-release worker started — queue "${QUEUE_NAMES.bookingRelease}", ` +
      `schedule "${env.BOOKING_RELEASE_CRON}" (${env.INVOICE_CRON_TZ})`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `🛠  Reminder-sweep worker started — queue "${QUEUE_NAMES.reminderSweep}", ` +
      `schedule "${env.REMINDER_CRON}" (${env.INVOICE_CRON_TZ})`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `🛠  Payment-reconcile worker started — queue "${QUEUE_NAMES.paymentReconcile}", ` +
      `schedule "${env.RECON_CRON}" (${env.INVOICE_CRON_TZ})`,
  );

  const shutdown = async (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n${sig} received — shutting down worker...`);
    await worker.close();
    await bookingWorker.close();
    await reminderWorker.close();
    await reconWorker.close();
    await closeInvoiceQueue();
    await closeBookingReleaseQueue();
    await closeReminderQueue();
    await closePaymentReconcileQueue();
    await disconnectInvoiceGenerator();
    await disconnectBookingReleaser();
    await disconnectReminderSender();
    await disconnectPaymentReconciler();
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
