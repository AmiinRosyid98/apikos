import IORedis, { type RedisOptions } from 'ioredis';
import { env } from './env';

/**
 * Shared Redis connection config for BullMQ (queue + worker) and any other Redis use.
 *
 * BullMQ bundles its own nested `ioredis`; passing our top-level ioredis *instance* to
 * BullMQ trips a TS structural-type mismatch between the two copies. To avoid coupling to
 * a specific ioredis instance, we hand BullMQ a plain `ConnectionOptions` object (parsed
 * from REDIS_URL) and let it construct its own internal connection. `maxRetriesPerRequest`
 * MUST be null for the blocking worker connection.
 *
 * Redis is LIVE on localhost:6379 (REDIS_URL). See BACKEND_STATUS.md "Job infrastructure".
 */

function parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
  const u = new URL(url);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
  };
}

/** Connection options handed to BullMQ Queue/Worker (`{ connection: BULLMQ_CONNECTION }`). */
export const BULLMQ_CONNECTION: RedisOptions = {
  ...parseRedisUrl(env.REDIS_URL),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/** Direct ioredis client (non-BullMQ use, e.g. ad-hoc checks). */
export function createRedisConnection(): IORedis {
  const conn = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  conn.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[redis] connection error:', err.message);
  });
  return conn;
}

/** Namespaced BullMQ queue names live here so producers/consumers agree on the key. */
export const QUEUE_NAMES = {
  invoiceGeneration: 'invoice-generation',
} as const;
