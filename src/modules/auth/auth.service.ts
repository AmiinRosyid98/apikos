import { prisma } from '../../config/database';
import { runUnscoped } from '../../config/tenantStore';
import { Errors } from '../../utils/errors';
import { hashPassword, verifyPassword } from '../../utils/password';
import { sha256, randomToken } from '../../utils/crypto';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../utils/jwt';
import { slugify } from '../../utils/slug';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../services/email.service';
import { env } from '../../config/env';
import type { RegisterInput, LoginInput } from './auth.validators';

const TRIAL_DAYS = 14;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

// Basic plan caps for the trial tenant (PLAN A3).
const BASIC_CAPS = { maxProperties: 1, maxRooms: 20, maxUsers: 2 };

async function issueTokens(userId: string, tenantId: string, role: string) {
  const accessToken = await signAccessToken({ userId, tenantId, role: role as any });
  const jti = randomToken(16);
  const refreshToken = await signRefreshToken({ userId, tenantId, jti });
  await prisma.refreshToken.create({
    data: {
      tenantId,
      userId,
      tokenHash: sha256(jti),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { accessToken, refreshToken };
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base);
  let candidate = root;
  let n = 1;
  // runs unscoped (tenant table has no tenant_id)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const exists = await prisma.tenant.findUnique({ where: { slug: candidate } });
    if (!exists) return candidate;
    candidate = `${root}-${n++}`;
  }
}

export async function register(input: RegisterInput) {
  return runUnscoped(async () => {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw Errors.conflict('Email already registered');

    const slug = await uniqueSlug(input.businessName);
    const passwordHash = await hashPassword(input.password);
    const expiresAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: input.businessName,
          slug,
          subscriptionPlan: 'basic',
          subscriptionStatus: 'active',
          subscriptionExpiresAt: expiresAt,
          ...BASIC_CAPS,
          counter: { create: {} },
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          phone: input.phone,
          role: 'owner',
          isActive: true,
        },
      });
      return { tenant, user };
    });

    await sendVerificationEmail(input.email);
    const tokens = await issueTokens(result.user.id, result.tenant.id, 'owner');

    return {
      tenant: { id: result.tenant.id, slug: result.tenant.slug, name: result.tenant.name },
      user: { id: result.user.id, email: result.user.email, role: 'owner' as const },
      ...tokens,
    };
  });
}

export async function login(input: LoginInput) {
  return runUnscoped(async () => {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !user.isActive) throw Errors.unauthenticated('Invalid email or password');
    const okPw = await verifyPassword(input.password, user.passwordHash);
    if (!okPw) throw Errors.unauthenticated('Invalid email or password');

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const tokens = await issueTokens(user.id, user.tenantId, user.role);

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      },
      ...tokens,
    };
  });
}

export async function refresh(refreshToken: string) {
  return runUnscoped(async () => {
    const claims = await verifyRefreshToken(refreshToken);
    const tokenHash = sha256(claims.jti);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      // Reuse / revoked / expired → reject (and revoke any matching to be safe).
      if (stored && !stored.revokedAt) {
        await prisma.refreshToken.update({
          where: { id: stored.id },
          data: { revokedAt: new Date() },
        });
      }
      throw Errors.unauthenticated('Refresh token invalid or already used');
    }

    // Rotation: revoke old, issue new.
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const user = await prisma.user.findUnique({ where: { id: claims.userId } });
    if (!user || !user.isActive) throw Errors.unauthenticated('User inactive');

    return issueTokens(user.id, user.tenantId, user.role);
  });
}

export async function logout(refreshToken: string) {
  return runUnscoped(async () => {
    try {
      const claims = await verifyRefreshToken(refreshToken);
      const tokenHash = sha256(claims.jti);
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      /* idempotent logout — ignore invalid token */
    }
    return { loggedOut: true };
  });
}

export async function forgotPassword(email: string) {
  return runUnscoped(async () => {
    const user = await prisma.user.findUnique({ where: { email } });
    // Always 200, no enumeration (§3.1).
    if (user) {
      const token = randomToken(24);
      await prisma.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      });
      await sendPasswordResetEmail(email, token);
    }
    return { sent: true };
  });
}

export async function resetPassword(token: string, newPassword: string) {
  return runUnscoped(async () => {
    const tokenHash = sha256(token);
    const reset = await prisma.passwordReset.findUnique({ where: { tokenHash } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw Errors.validation('Invalid or expired reset token');
    }
    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      // Revoke all refresh tokens on password reset.
      prisma.refreshToken.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { reset: true };
  });
}

export async function getMe(userId: string) {
  // runs inside tenant context
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      propertyAccess: { include: { property: { select: { id: true, name: true } } } },
      tenant: {
        select: {
          subscriptionPlan: true,
          subscriptionStatus: true,
          subscriptionExpiresAt: true,
        },
      },
    },
  });
  if (!user) throw Errors.notFound('User not found');
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    tenantId: user.tenantId,
    propertyAccess: user.propertyAccess.map((pa) => ({
      propertyId: pa.propertyId,
      propertyName: pa.property.name,
    })),
    subscription: {
      plan: user.tenant.subscriptionPlan,
      status: user.tenant.subscriptionStatus,
      expiresAt: user.tenant.subscriptionExpiresAt,
    },
  };
}

export const __ttls = { TRIAL_DAYS, REFRESH_TTL_MS, RESET_TTL_MS, jwtAccess: env.JWT_ACCESS_TTL };
