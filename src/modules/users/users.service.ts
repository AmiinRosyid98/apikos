import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { runUnscoped } from '../../config/tenantStore';
import { Errors } from '../../utils/errors';
import { sha256, randomToken } from '../../utils/crypto';
import { hashPassword } from '../../utils/password';
import { signAccessToken, signRefreshToken } from '../../utils/jwt';
import { assertPlanCapacity } from '../../services/plan.service';
import { sendInviteEmail } from '../../services/email.service';
import { iso } from '../../utils/serialize';
import type { InviteUserInput, ListUserQuery } from './users.validators';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type UserWithAccess = Prisma.UserGetPayload<{
  include: { propertyAccess: { include: { property: { select: { id: true; name: true } } } } };
}>;

function serializeUser(u: UserWithAccess) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    propertyAccess: u.propertyAccess.map((pa) => ({
      propertyId: pa.propertyId,
      propertyName: pa.property.name,
    })),
    lastLoginAt: iso(u.lastLoginAt),
  };
}

const withAccess = {
  propertyAccess: { include: { property: { select: { id: true, name: true } } } },
} as const;

export async function listUsers(q: ListUserQuery) {
  const where: Prisma.UserWhereInput = {};
  if (q.role) where.role = q.role;
  if (q.is_active !== undefined) where.isActive = q.is_active;

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: withAccess,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.user.count({ where }),
  ]);
  return { rows: rows.map(serializeUser), total };
}

export async function getUser(id: string) {
  const u = await prisma.user.findFirst({ where: { id }, include: withAccess });
  if (!u) throw Errors.notFound('User not found');
  return serializeUser(u);
}

export async function inviteUser(tenantId: string, invitedBy: string, input: InviteUserInput) {
  await assertPlanCapacity(tenantId, 'user');
  if (input.role === 'owner') throw Errors.validation('Cannot invite another owner');

  // Email uniqueness is global (users.email unique). Check unscoped.
  const emailTaken = await runUnscoped(() =>
    prisma.user.findUnique({ where: { email: input.email } }),
  );
  if (emailTaken) throw Errors.conflict('Email already registered');

  const token = randomToken(24);
  const invite = await prisma.invite.create({
    data: {
      tenantId,
      email: input.email,
      fullName: input.fullName,
      role: input.role,
      tokenHash: sha256(token),
      propertyIds: input.propertyIds,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedBy,
    },
  });
  await sendInviteEmail(input.email, token);

  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    inviteStatus: 'pending' as const,
    // Surfaced for dev/testing since email is console-stubbed (MVP-1).
    _devToken: token,
  };
}

export async function acceptInvite(token: string, password: string) {
  return runUnscoped(async () => {
    const tokenHash = sha256(token);
    const invite = await prisma.invite.findFirst({ where: { tokenHash } });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw Errors.validation('Invalid or expired invite token');
    }
    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    if (existing) throw Errors.conflict('Email already registered');

    const passwordHash = await hashPassword(password);
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          tenantId: invite.tenantId,
          email: invite.email,
          passwordHash,
          fullName: invite.fullName,
          role: invite.role,
          isActive: true,
        },
      });
      if (invite.propertyIds.length) {
        await tx.userPropertyAccess.createMany({
          data: invite.propertyIds.map((pid) => ({
            tenantId: invite.tenantId,
            userId: u.id,
            propertyId: pid,
          })),
          skipDuplicates: true,
        });
      }
      await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      return u;
    });

    const accessToken = await signAccessToken({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
    });
    const jti = randomToken(16);
    const refreshToken = await signRefreshToken({ userId: user.id, tenantId: user.tenantId, jti });
    await prisma.refreshToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: sha256(jti),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { accessToken, refreshToken };
  });
}

export async function changeRole(id: string, role: InviteUserInput['role']) {
  const u = await prisma.user.findFirst({ where: { id } });
  if (!u) throw Errors.notFound('User not found');
  if (u.role === 'owner') throw Errors.validation('Cannot change the owner role');
  if (role === 'owner') throw Errors.validation('Cannot promote to owner');
  await prisma.user.update({ where: { id }, data: { role } });
  return getUser(id);
}

export async function setPropertyAccess(tenantId: string, id: string, propertyIds: string[]) {
  const u = await prisma.user.findFirst({ where: { id } });
  if (!u) throw Errors.notFound('User not found');

  // Validate properties belong to tenant (tenant-guard scopes this).
  const valid = await prisma.property.findMany({
    where: { id: { in: propertyIds } },
    select: { id: true },
  });
  const validIds = new Set(valid.map((p) => p.id));
  const filtered = propertyIds.filter((pid) => validIds.has(pid));

  await prisma.$transaction([
    prisma.userPropertyAccess.deleteMany({ where: { userId: id } }),
    prisma.userPropertyAccess.createMany({
      data: filtered.map((pid) => ({ tenantId, userId: id, propertyId: pid })),
      skipDuplicates: true,
    }),
  ]);
  return getUser(id);
}

export async function setActive(id: string, isActive: boolean) {
  const u = await prisma.user.findFirst({ where: { id } });
  if (!u) throw Errors.notFound('User not found');
  if (u.role === 'owner') throw Errors.validation('Cannot deactivate the owner');
  await prisma.user.update({ where: { id }, data: { isActive } });
  if (!isActive) {
    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  return getUser(id);
}
