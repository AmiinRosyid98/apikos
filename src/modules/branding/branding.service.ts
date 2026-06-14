import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { assertPlanFeature } from '../../services/plan.service';
import { presignDownloadIfExists } from '../files/files.service';
import type { UpdateBrandingInput } from './branding.validators';

/**
 * White-label branding service (PRD Modul 23 — Premium).
 *
 * Branding lives on the `tenants` row (`brandName`, `brandColor`, `logoKey`). The SETTER
 * (updateBranding) is Premium-gated via assertPlanFeature('whiteLabel'); the GETTER serves whatever
 * is stored regardless of plan (so the dashboard can theme itself; a downgraded tenant keeps its
 * stored values — we do NOT wipe them on downgrade, see BACKEND_STATUS for the rationale/seam).
 *
 * `logoUrl` is presigned from `logoKey`; in the R2 stub it degrades to a clearly-marked placeholder
 * (or null when the key is untracked) — never throws.
 *
 * NOTE: every read/write here runs inside the request's tenant context (AsyncLocalStorage), so the
 * Prisma tenant-guard scopes the tenant lookup. We additionally pass tenantId explicitly to be
 * exact about WHICH tenant's branding we touch.
 */

export interface BrandingPayload {
  brandName: string;
  brandColor: string | null;
  logoUrl: string | null;
}

/** Resolve a tenant's effective brandName: override → tenant.name → "KosManager". */
function resolveBrandName(brandName: string | null, tenantName: string | null): string {
  return brandName?.trim() || tenantName?.trim() || 'KosManager';
}

/**
 * Build the public branding payload from already-loaded tenant fields. Shared by GET /branding and
 * the public landing (so both render identically). Presigns the logo (null in stub when untracked).
 */
export async function buildBrandingPayload(tenant: {
  name: string | null;
  brandName: string | null;
  brandColor: string | null;
  logoKey: string | null;
}): Promise<BrandingPayload> {
  return {
    brandName: resolveBrandName(tenant.brandName, tenant.name),
    brandColor: tenant.brandColor ?? null,
    logoUrl: await presignDownloadIfExists(tenant.logoKey),
  };
}

/** GET /branding — All authenticated roles. Returns defaults when nothing is set. */
export async function getBranding(tenantId: string): Promise<BrandingPayload> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: { name: true, brandName: true, brandColor: true, logoKey: true },
  });
  if (!tenant) throw Errors.notFound('Tenant not found');
  return buildBrandingPayload(tenant);
}

/**
 * PUT /branding — Owner-only, Premium-gated. Partial update; `null` clears a field. Validates that a
 * supplied `logoKey` is an uploaded `logo`-purpose file owned by this tenant (the file-guard scopes
 * by tenant) → 422 otherwise so a caller can't point the logo at an arbitrary/foreign key.
 */
export async function updateBranding(
  tenantId: string,
  input: UpdateBrandingInput,
): Promise<BrandingPayload> {
  // Premium gate — Basic/Pro → 403 FORBIDDEN.
  await assertPlanFeature(tenantId, 'whiteLabel');

  // When SETTING a logoKey (not clearing), require it to be a tracked `logo` file in this tenant.
  if (input.logoKey != null) {
    const file = await prisma.fileObject.findFirst({
      where: { key: input.logoKey, purpose: 'logo' },
      select: { id: true },
    });
    if (!file) {
      throw Errors.validation(
        'logoKey does not reference an uploaded logo file for this tenant. Upload via /files/presign-upload with purpose "logo" first.',
        [{ field: 'logoKey', message: 'unknown or non-logo file key' }],
      );
    }
  }

  // Only touch the keys actually present in the body (partial update). `null` is a real value here
  // (clear), so we distinguish "key present" via `in input`.
  const data: { brandName?: string | null; brandColor?: string | null; logoKey?: string | null } =
    {};
  if ('brandName' in input) data.brandName = input.brandName ?? null;
  if ('brandColor' in input) data.brandColor = input.brandColor ?? null;
  if ('logoKey' in input) data.logoKey = input.logoKey ?? null;

  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data,
    select: { name: true, brandName: true, brandColor: true, logoKey: true },
  });
  return buildBrandingPayload(updated);
}
