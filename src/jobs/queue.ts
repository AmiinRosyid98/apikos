import { Queue, type JobsOptions } from 'bullmq';
import { BULLMQ_CONNECTION, QUEUE_NAMES } from '../config/redis';
import { env } from '../config/env';

/**
 * BullMQ queue for invoice generation. A single repeatable (cron) job drives the daily
 * billing-day run; an on-demand job (same processor) can be enqueued for testing/admin.
 *
 * The `daily-invoice-run` repeatable job is registered with a fixed jobId so re-registering
 * on every boot is idempotent (BullMQ upserts the repeat schedule, no duplicates).
 */

export interface InvoiceJobData {
  /**
   * The "as-of" date the run evaluates billing days against. Defaults to "now" inside the
   * processor when omitted (the real daily cron). Tests pass an explicit date to simulate a
   * specific billing day deterministically.
   */
  asOf?: string; // ISO date
  /** Restrict the run to a single tenant (admin on-demand trigger). Omit = all tenants. */
  tenantId?: string;
  /** Free-form label for logs (e.g. "cron", "admin-trigger", "test"). */
  source?: string;
}

export const REPEATABLE_JOB_NAME = 'daily-invoice-run';
export const ONDEMAND_JOB_NAME = 'invoice-run';

let queue: Queue<InvoiceJobData> | undefined;

export function getInvoiceQueue(): Queue<InvoiceJobData> {
  if (!queue) {
    queue = new Queue<InvoiceJobData>(QUEUE_NAMES.invoiceGeneration, {
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

/**
 * Register the daily repeatable job. Idempotent: BullMQ keys the repeat by its cron pattern
 * + name, so calling this on every worker boot does not stack duplicates.
 */
export async function scheduleDailyInvoiceRun(): Promise<void> {
  const q = getInvoiceQueue();
  await q.add(
    REPEATABLE_JOB_NAME,
    { source: 'cron' },
    {
      repeat: { pattern: env.INVOICE_CRON, tz: env.INVOICE_CRON_TZ },
      jobId: REPEATABLE_JOB_NAME, // stable id for the repeat scheduler entry
    },
  );
}

/** Enqueue an on-demand run (admin trigger / tests). Returns the BullMQ job id. */
export async function enqueueInvoiceRun(
  data: InvoiceJobData = {},
  opts: JobsOptions = {},
): Promise<string> {
  const q = getInvoiceQueue();
  const job = await q.add(ONDEMAND_JOB_NAME, { source: 'admin-trigger', ...data }, opts);
  return job.id as string;
}

export async function closeInvoiceQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
