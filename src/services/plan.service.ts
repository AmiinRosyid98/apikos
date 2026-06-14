import type { PaymentGatewayMethod } from '@prisma/client';
import { prisma } from '../config/database';
import { Errors } from '../utils/errors';

export type PlanResource = 'property' | 'room' | 'user';

/** Plan → feature flags (PRD §12.2). Centralized so the subscription endpoint and feature
 *  guards agree. `meterUtility` (electricity/water meter readings) is Pro+ only. */
export type PlanFeature =
  | 'whatsapp'
  | 'paymentGateway'
  | 'reports'
  | 'meterUtility'
  | 'depositManagement'
  | 'checkinOut'
  // Public API + API-key management (PRD Modul 22). PREMIUM-ONLY: Basic ❌ / Pro ❌ / Premium ✅.
  // Gates BOTH the management endpoints (POST /api-keys) AND the external API (/api/ext/v1):
  // downgrading off Premium instantly disables every key (enforced in apiKeyAuth).
  | 'apiAccess'
  // White-label branding (PRD Modul 23). PREMIUM-ONLY: Basic ❌ / Pro ❌ / Premium ✅. Gates ONLY the
  // SETTER (PUT /branding). Serving branding (GET /branding) and applying existing branding on the
  // public landing is plan-independent at the GET layer — but the PUBLIC landing only surfaces
  // branding for a Premium tenant (so a downgraded tenant's public page reverts to default).
  | 'whiteLabel'
  // Integrasi Akuntansi (PRD Modul 21 — Jurnal.id/Accurate). PREMIUM-ONLY: Basic ❌ / Pro ❌ /
  // Premium ✅. Gates the CONFIG setter (PUT /accounting/config). Status/sync/entries are reachable
  // by owner/manager/finance but a non-Premium tenant can never enable a provider (config is gated),
  // so sync runs through the Stub only — going live requires Premium + a real provider key.
  | 'accountingIntegration';

export const PLAN_FEATURES: Record<string, Record<PlanFeature, boolean>> = {
  basic: {
    whatsapp: false,
    paymentGateway: false,
    reports: false,
    meterUtility: false,
    depositManagement: false,
    checkinOut: false,
    apiAccess: false,
    whiteLabel: false,
    accountingIntegration: false,
  },
  pro: {
    whatsapp: true,
    paymentGateway: false,
    reports: true,
    meterUtility: true,
    depositManagement: true,
    checkinOut: true,
    apiAccess: false,
    whiteLabel: false,
    accountingIntegration: false,
  },
  premium: {
    whatsapp: true,
    paymentGateway: true,
    reports: true,
    meterUtility: true,
    depositManagement: true,
    checkinOut: true,
    apiAccess: true,
    whiteLabel: true,
    accountingIntegration: true,
  },
};

export function featuresForPlan(plan: string): Record<PlanFeature, boolean> {
  return PLAN_FEATURES[plan] ?? PLAN_FEATURES.basic;
}

/**
 * Monthly WhatsApp send quota per plan (PRD §12.2): Basic 100/mo, Pro 500/mo, Premium unlimited
 * (null). The `whatsapp` FEATURE is in all plans (so we do NOT hard-block by feature) — the plans
 * differ only by this monthly quota. `null` = unlimited.
 */
export const WA_MONTHLY_QUOTA: Record<string, number | null> = {
  basic: 100,
  pro: 500,
  premium: null,
};

export function waQuotaForPlan(plan: string): number | null {
  return plan in WA_MONTHLY_QUOTA ? WA_MONTHLY_QUOTA[plan] : WA_MONTHLY_QUOTA.basic;
}

/**
 * Payment-gateway methods available per plan (PRD §12.2 / §6.8):
 *   - Basic   → QRIS only
 *   - Pro     → QRIS + all Virtual Accounts (va_*)
 *   - Premium → all methods (QRIS + VA + e-wallets)
 *
 * This REPLACES the misleading `features.paymentGateway` boolean as the source of truth for what a
 * tenant can charge with: the boolean said "false on Basic" even though Basic gets QRIS. The
 * subscription endpoint now exposes this method LIST (see featuresForPlan consumers / GET
 * /payments/methods), and createCharge validates `method ∈ allowedMethodsForPlan(plan)`.
 */
const VA_METHODS: PaymentGatewayMethod[] = [
  'va_bca',
  'va_bni',
  'va_bri',
  'va_mandiri',
  'va_permata',
];
const EWALLET_METHODS: PaymentGatewayMethod[] = ['gopay', 'ovo', 'dana', 'shopeepay', 'linkaja'];

export const PLAN_PAYMENT_METHODS: Record<string, PaymentGatewayMethod[]> = {
  basic: ['qris'],
  pro: ['qris', ...VA_METHODS],
  premium: ['qris', ...VA_METHODS, ...EWALLET_METHODS],
};

export function allowedMethodsForPlan(plan: string): PaymentGatewayMethod[] {
  return PLAN_PAYMENT_METHODS[plan] ?? PLAN_PAYMENT_METHODS.basic;
}

/**
 * Feature gate (PRD §12.2). Throws FORBIDDEN (403) when the tenant's plan does not include
 * the feature. Call inside the relevant flow BEFORE doing work. Demo tenant is `pro` → passes.
 */
export async function assertPlanFeature(tenantId: string, feature: PlanFeature): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionPlan: true },
  });
  if (!tenant) throw Errors.notFound('Tenant not found');
  if (!featuresForPlan(tenant.subscriptionPlan)[feature]) {
    // apiAccess + whiteLabel + accountingIntegration are Premium-only; the others are Pro+. Tailor the hint.
    const premiumOnly =
      feature === 'apiAccess' || feature === 'whiteLabel' || feature === 'accountingIntegration';
    const upgradeTo = premiumOnly ? 'Premium' : 'Pro or Premium';
    throw Errors.forbidden(
      `The "${feature}" feature is not available on the ${tenant.subscriptionPlan} plan. Upgrade to ${upgradeTo}.`,
    );
  }
}

/**
 * Resolve a tenant's current plan (used by the API-key auth path which has no JWT/req.auth).
 */
export async function getTenantPlan(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionPlan: true },
  });
  if (!tenant) throw Errors.notFound('Tenant not found');
  return tenant.subscriptionPlan;
}

/**
 * apiAccess gate for the EXTERNAL API (PRD Modul 22). Unlike assertPlanFeature (which throws
 * FORBIDDEN/403), this throws PLAN_LIMIT_EXCEEDED (403) so a downgraded tenant's key surfaces a
 * clear "your plan no longer includes API access" signal. Called inside apiKeyAuth on every
 * request, so flipping off Premium disables all keys immediately.
 */
export async function assertApiAccessPlan(tenantId: string): Promise<void> {
  const plan = await getTenantPlan(tenantId);
  if (!featuresForPlan(plan)[apiAccessFeature]) {
    throw Errors.planLimit(
      `The Public API is a Premium-plan feature; your tenant is on the ${plan} plan. Upgrade to Premium to use API keys.`,
    );
  }
}

const apiAccessFeature: PlanFeature = 'apiAccess';

/**
 * B2.7 — planGuard. Compares live usage against the tenant's caps and throws
 * PLAN_LIMIT_EXCEEDED (403) when usage >= cap. Call inside create flows BEFORE inserting.
 *
 * `additional` lets callers reserve N slots (e.g. room clone count) in one check.
 */
export async function assertPlanCapacity(
  tenantId: string,
  resource: PlanResource,
  additional = 1,
): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { maxProperties: true, maxRooms: true, maxUsers: true },
  });
  if (!tenant) throw Errors.notFound('Tenant not found');

  let current = 0;
  let cap = 0;
  let label = '';

  switch (resource) {
    case 'property':
      current = await prisma.property.count({ where: { isActive: true } });
      cap = tenant.maxProperties;
      label = 'properties';
      break;
    case 'room':
      current = await prisma.room.count();
      cap = tenant.maxRooms;
      label = 'rooms';
      break;
    case 'user':
      current = await prisma.user.count({ where: { isActive: true } });
      cap = tenant.maxUsers;
      label = 'users';
      break;
  }

  if (current + additional > cap) {
    throw Errors.planLimit(
      `Plan limit reached: ${label} (${current}/${cap}). Upgrade your plan to add more.`,
    );
  }
}

export async function getUsageAndLimits(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      subscriptionPlan: true,
      subscriptionStatus: true,
      subscriptionExpiresAt: true,
      maxProperties: true,
      maxRooms: true,
      maxUsers: true,
    },
  });
  if (!tenant) throw Errors.notFound('Tenant not found');

  const [properties, rooms, users] = await Promise.all([
    prisma.property.count({ where: { isActive: true } }),
    prisma.room.count(),
    prisma.user.count({ where: { isActive: true } }),
  ]);

  return {
    plan: tenant.subscriptionPlan,
    status: tenant.subscriptionStatus,
    expiresAt: tenant.subscriptionExpiresAt,
    limits: {
      maxProperties: tenant.maxProperties,
      maxRooms: tenant.maxRooms,
      maxUsers: tenant.maxUsers,
    },
    usage: { properties, rooms, users },
  };
}
