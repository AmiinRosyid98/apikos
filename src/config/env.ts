import 'dotenv/config';
import { z } from 'zod';

/**
 * Zod-validated environment. Fails fast on boot if anything is missing/invalid.
 * Secrets only ever come from process.env — never hardcoded. (PLAN B0.2)
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  DATABASE_URL: z.string().url(),

  // Redis (BullMQ queue/worker + future rate-limiter store). LIVE on localhost:6379.
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Invoice-generation cron schedule (node-cron / BullMQ repeat pattern). Default 00:30 daily.
  // Timezone is pinned to Asia/Jakarta (WIB) per A9.
  INVOICE_CRON: z.string().default('30 0 * * *'),
  INVOICE_CRON_TZ: z.string().default('Asia/Jakarta'),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // 32 bytes hex = 64 chars → AES-256-GCM key
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  BCRYPT_COST: z.coerce.number().int().min(12).max(15).default(12),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // R2 / S3 — optional in MVP-1 (presign falls back to placeholder when absent)
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().optional(),

  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  EMAIL_FROM: z.string().default('KosManager <no-reply@kosmanager.id>'),
  RESEND_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const r2Configured = Boolean(
  env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_ENDPOINT,
);
