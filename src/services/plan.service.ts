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
  | 'checkinOut';

export const PLAN_FEATURES: Record<string, Record<PlanFeature, boolean>> = {
  basic: {
    whatsapp: false,
    paymentGateway: false,
    reports: false,
    meterUtility: false,
    depositManagement: false,
    checkinOut: false,
  },
  pro: {
    whatsapp: true,
    paymentGateway: false,
    reports: true,
    meterUtility: true,
    depositManagement: true,
    checkinOut: true,
  },
  premium: {
    whatsapp: true,
    paymentGateway: true,
    reports: true,
    meterUtility: true,
    depositManagement: true,
    checkinOut: true,
  },
};

export function featuresForPlan(plan: string): Record<PlanFeature, boolean> {
  return PLAN_FEATURES[plan] ?? PLAN_FEATURES.basic;
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
    throw Errors.forbidden(
      `The "${feature}" feature is not available on the ${tenant.subscriptionPlan} plan. Upgrade to Pro or Premium.`,
    );
  }
}

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
