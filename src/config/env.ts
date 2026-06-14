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

  // Booking auto-release cron (PRD §6.13): expire pending+unpaid bookings past their feeDueAt and
  // release the held room. Default every 15 minutes. Same TZ as invoices (Asia/Jakarta, A9).
  BOOKING_RELEASE_CRON: z.string().default('*/15 * * * *'),

  // Reminder Otomatis cron (PRD §6.10): daily sweep that sends due/overdue + contract-expiry
  // WhatsApp reminders. Default 08:00 daily, Asia/Jakarta (reuses INVOICE_CRON_TZ).
  REMINDER_CRON: z.string().default('0 8 * * *'),

  // WhatsApp provider seam (PRD §6.9). WA_PROVIDER selects the implementation: 'stub' (default,
  // no network — demo mode) or 'fonnte'. FONNTE_TOKEN is the real Fonnte API token; when it is
  // set the factory uses the Fonnte provider regardless of WA_PROVIDER. Empty by default → Stub.
  WA_PROVIDER: z.enum(['stub', 'fonnte']).default('stub'),
  FONNTE_TOKEN: z.string().optional().default(''),

  // Payment gateway provider seam (PRD §6.8). When MIDTRANS_SERVER_KEY is set the factory uses the
  // real Midtrans provider; otherwise the Stub provider (no real money — demo mode). All optional /
  // empty by default → Stub. Going live is config-only (set the server/client keys + restart).
  MIDTRANS_SERVER_KEY: z.string().optional().default(''),
  MIDTRANS_CLIENT_KEY: z.string().optional().default(''),
  MIDTRANS_IS_PRODUCTION: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),

  // Payment reconciliation cron (PRD §6.8): a daily per-tenant sweep that logs matched vs
  // unmatched gateway txns / payments / invoices. Default 01:00 daily, Asia/Jakarta (A9).
  RECON_CRON: z.string().default('0 1 * * *'),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // 32 bytes hex = 64 chars → AES-256-GCM key
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  BCRYPT_COST: z.coerce.number().int().min(12).max(15).default(12),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // Public (unauthenticated) anti-spam limits — PRD §6.2/§6.13. Separate from the global limiter.
  // READ (landing): default 60 / 5 min / IP. BOOKING (submission): default 5 / hour / IP (strict).
  PUBLIC_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60_000),
  PUBLIC_READ_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  PUBLIC_BOOKING_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  PUBLIC_BOOKING_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

  // Public API (PRD Modul 22) per-API-key rate limit — stricter than the global IP limiter and
  // keyed by the API key (not the IP), so each tenant's key gets its own budget. Default 120 req/min.
  API_KEY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  API_KEY_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

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
