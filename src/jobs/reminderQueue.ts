import { Queue, type JobsOptions } from 'bullmq';
import { BULLMQ_CONNECTION, QUEUE_NAMES } from '../config/redis';
import { env } from '../config/env';
import type { ReminderJobData } from './reminderSender';

/**
 * BullMQ queue for the Reminder Otomatis sweep (PRD §6.10). A single repeatable (cron) job drives
 * the daily sweep (default 08:00 WIB, env REMINDER_CRON); an on-demand job (same processor) can be
 * enqueued for ops/tests. Mirrors src/jobs/queue.ts + bookingQueue.ts.
 */

export const REMINDER_REPEATABLE_JOB_NAME = 'reminder-sweep-run';
export const REMINDER_ONDEMAND_JOB_NAME = 'reminder-sweep';

let queue: Queue<ReminderJobData> | undefined;

export function getReminderQueue(): Queue<ReminderJobData> {
  if (!queue) {
    queue = new Queue<ReminderJobData>(QUEUE_NAMES.reminderSweep, {
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

/** Register the repeatable reminder sweep. Idempotent (BullMQ keys the repeat by pattern + jobId). */
export async function scheduleReminderSweep(): Promise<void> {
  const q = getReminderQueue();
  await q.add(
    REMINDER_REPEATABLE_JOB_NAME,
    { source: 'cron' },
    {
      repeat: { pattern: env.REMINDER_CRON, tz: env.INVOICE_CRON_TZ },
      jobId: REMINDER_REPEATABLE_JOB_NAME,
    },
  );
}

/** Enqueue an on-demand reminder sweep (ops / tests). Returns the BullMQ job id. */
export async function enqueueReminderSweep(
  data: ReminderJobData = {},
  opts: JobsOptions = {},
): Promise<string> {
  const q = getReminderQueue();
  const job = await q.add(REMINDER_ONDEMAND_JOB_NAME, { source: 'ops-trigger', ...data }, opts);
  return job.id as string;
}

export async function closeReminderQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
