import { Queue, type JobsOptions } from 'bullmq';
import { BULLMQ_CONNECTION, QUEUE_NAMES } from '../config/redis';
import { env } from '../config/env';
import type { BookingReleaseJobData } from './bookingReleaser';

/**
 * BullMQ queue for booking auto-release (PRD §6.13). A single repeatable (cron) job drives the
 * periodic release (default every 15 min, env BOOKING_RELEASE_CRON); an on-demand job (same
 * processor) can be enqueued for ops/tests. Mirrors src/jobs/queue.ts (invoice generation).
 */

export const RELEASE_REPEATABLE_JOB_NAME = 'booking-release-run';
export const RELEASE_ONDEMAND_JOB_NAME = 'booking-release';

let queue: Queue<BookingReleaseJobData> | undefined;

export function getBookingReleaseQueue(): Queue<BookingReleaseJobData> {
  if (!queue) {
    queue = new Queue<BookingReleaseJobData>(QUEUE_NAMES.bookingRelease, {
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

/** Register the repeatable release job. Idempotent (BullMQ keys the repeat by pattern + jobId). */
export async function scheduleBookingRelease(): Promise<void> {
  const q = getBookingReleaseQueue();
  await q.add(
    RELEASE_REPEATABLE_JOB_NAME,
    { source: 'cron' },
    {
      repeat: { pattern: env.BOOKING_RELEASE_CRON, tz: env.INVOICE_CRON_TZ },
      jobId: RELEASE_REPEATABLE_JOB_NAME,
    },
  );
}

/** Enqueue an on-demand release run (ops / tests). Returns the BullMQ job id. */
export async function enqueueBookingRelease(
  data: BookingReleaseJobData = {},
  opts: JobsOptions = {},
): Promise<string> {
  const q = getBookingReleaseQueue();
  const job = await q.add(RELEASE_ONDEMAND_JOB_NAME, { source: 'ops-trigger', ...data }, opts);
  return job.id as string;
}

export async function closeBookingReleaseQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
