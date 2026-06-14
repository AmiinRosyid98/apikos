import { Queue, type JobsOptions } from 'bullmq';
import { BULLMQ_CONNECTION, QUEUE_NAMES } from '../config/redis';
import { env } from '../config/env';
import type { ReconcileJobData } from './paymentReconciler';

/**
 * BullMQ queue for the daily payment reconciliation sweep (PRD §6.8). A single repeatable (cron) job
 * drives the daily reconcile (default 01:00 WIB, env RECON_CRON); an on-demand job (same processor)
 * can be enqueued for ops/tests. Mirrors reminderQueue.ts / bookingQueue.ts.
 */

export const RECON_REPEATABLE_JOB_NAME = 'payment-reconcile-run';
export const RECON_ONDEMAND_JOB_NAME = 'payment-reconcile';

let queue: Queue<ReconcileJobData> | undefined;

export function getPaymentReconcileQueue(): Queue<ReconcileJobData> {
  if (!queue) {
    queue = new Queue<ReconcileJobData>(QUEUE_NAMES.paymentReconcile, {
      connection: BULLMQ_CONNECTION,
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    });
  }
  return queue;
}

/** Register the repeatable reconcile job. Idempotent (BullMQ keys the repeat by pattern + jobId). */
export async function schedulePaymentReconcile(): Promise<void> {
  const q = getPaymentReconcileQueue();
  await q.add(
    RECON_REPEATABLE_JOB_NAME,
    { source: 'cron' },
    {
      repeat: { pattern: env.RECON_CRON, tz: env.INVOICE_CRON_TZ },
      jobId: RECON_REPEATABLE_JOB_NAME,
    },
  );
}

/** Enqueue an on-demand reconcile run (ops / tests). Returns the BullMQ job id. */
export async function enqueuePaymentReconcile(
  data: ReconcileJobData = {},
  opts: JobsOptions = {},
): Promise<string> {
  const q = getPaymentReconcileQueue();
  const job = await q.add(RECON_ONDEMAND_JOB_NAME, { source: 'ops-trigger', ...data }, opts);
  return job.id as string;
}

export async function closePaymentReconcileQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
