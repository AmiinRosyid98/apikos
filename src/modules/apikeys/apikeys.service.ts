import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { iso } from '../../utils/serialize';
import { assertPlanFeature } from '../../services/plan.service';
import { generateApiKey } from './apikeys.keygen';
import type { CreateApiKeyInput } from './apikeys.validators';

type ApiKeyRow = Prisma.ApiKeyGetPayload<object>;

/** Computed status for the dashboard list (never exposes the secret/hash). */
function keyStatus(k: ApiKeyRow): 'active' | 'revoked' | 'expired' {
  if (k.revokedAt || !k.isActive) return 'revoked';
  if (k.expiresAt && k.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'active';
}

/** Safe serializer — prefix + name + scopes + status, NEVER the secret or keyHash. */
export function serializeApiKey(k: ApiKeyRow) {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    scopes: (k.scopes as string[]) ?? [],
    status: keyStatus(k),
    isActive: k.isActive,
    lastUsedAt: iso(k.lastUsedAt),
    expiresAt: iso(k.expiresAt),
    revokedAt: iso(k.revokedAt),
    createdByUserId: k.createdByUserId,
    createdAt: iso(k.createdAt),
  };
}

export async function listApiKeys(tenantId: string) {
  await assertPlanFeature(tenantId, 'apiAccess');
  const rows = await prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(serializeApiKey);
}

/**
 * Create a key (Premium-only). Generates a secret, stores ONLY its sha256 hash + a display prefix,
 * and returns the FULL plaintext key ONCE (caller must surface it — it can never be retrieved again).
 */
export async function createApiKey(
  tenantId: string,
  userId: string,
  input: CreateApiKeyInput,
) {
  await assertPlanFeature(tenantId, 'apiAccess');

  const { fullKey, keyPrefix, keyHash } = generateApiKey();

  const created = await prisma.apiKey.create({
    data: {
      tenantId,
      name: input.name,
      keyPrefix,
      keyHash,
      scopes: input.scopes as Prisma.InputJsonValue,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdByUserId: userId,
    },
  });

  return {
    ...serializeApiKey(created),
    // Shown ONCE — never stored in plaintext, never returned again.
    key: fullKey,
  };
}

async function getOwnedKey(id: string): Promise<ApiKeyRow> {
  const k = await prisma.apiKey.findFirst({ where: { id } });
  if (!k) throw Errors.notFound('API key not found');
  return k;
}

export async function revokeApiKey(tenantId: string, id: string) {
  await assertPlanFeature(tenantId, 'apiAccess');
  const existing = await getOwnedKey(id);
  if (existing.revokedAt) return serializeApiKey(existing); // idempotent
  const updated = await prisma.apiKey.update({
    where: { id: existing.id },
    data: { isActive: false, revokedAt: new Date() },
  });
  return serializeApiKey(updated);
}

export async function deleteApiKey(tenantId: string, id: string) {
  await assertPlanFeature(tenantId, 'apiAccess');
  const existing = await getOwnedKey(id);
  await prisma.apiKey.delete({ where: { id: existing.id } });
  return { id: existing.id, deleted: true };
}
