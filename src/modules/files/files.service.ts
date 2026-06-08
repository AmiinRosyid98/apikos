import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { env, r2Configured } from '../../config/env';
import type { PresignUploadInput } from './files.validators';

const PRESIGN_TTL_SECONDS = 900; // 15 min

function extFromContentType(ct: string): string {
  switch (ct) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

// ktp/selfie are PRIVATE; room_photo/payment_proof tracked but still served via presign in MVP-1.
function isPrivatePurpose(purpose: string): boolean {
  return purpose === 'ktp' || purpose === 'selfie';
}

/**
 * B3.4 — presign upload. If R2 is configured, a real presigned PUT URL would be generated
 * here via @aws-sdk/s3-request-presigner. In MVP-1 with no R2 creds we return a DOCUMENTED
 * PLACEHOLDER url (clearly marked) so the contract/flow is exercisable end-to-end.
 *   TODO(MVP-2): wire @aws-sdk/client-s3 + getSignedUrl against R2.
 */
export async function presignUpload(tenantId: string, userId: string, input: PresignUploadInput) {
  const ext = extFromContentType(input.contentType);
  const key = `tenants/${tenantId}/${input.purpose}/${randomUUID()}.${ext}`;
  const isPrivate = isPrivatePurpose(input.purpose);

  // Track the intended upload so presign-download can authorize by tenant later.
  await prisma.fileObject.create({
    data: {
      tenantId,
      key,
      purpose: input.purpose,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      uploadedBy: userId,
      isPrivate,
    },
  });

  const uploadUrl = r2Configured
    ? buildRealUploadPlaceholder(key) // replace with getSignedUrl in MVP-2
    : `https://PLACEHOLDER.r2.local/upload?key=${encodeURIComponent(key)}&__stub=1`;

  return {
    uploadUrl,
    key,
    expiresIn: PRESIGN_TTL_SECONDS,
    _note: r2Configured
      ? undefined
      : 'STUB: R2 not configured. uploadUrl is a placeholder — no real upload happens. TODO wire R2 in MVP-2.',
  };
}

/**
 * Presign download. Authorizes that the key belongs to the caller's tenant (the Prisma
 * tenant-guard scopes findFirst to tenantId). Returns a short-lived GET URL (placeholder in MVP-1).
 */
export async function presignDownload(key: string) {
  const file = await prisma.fileObject.findFirst({ where: { key } });
  if (!file) throw Errors.notFound('File not found');

  const downloadUrl = r2Configured
    ? buildRealDownloadPlaceholder(key)
    : `https://PLACEHOLDER.r2.local/download?key=${encodeURIComponent(key)}&__stub=1`;

  return {
    downloadUrl,
    expiresIn: PRESIGN_TTL_SECONDS,
    _note: r2Configured
      ? undefined
      : 'STUB: R2 not configured. downloadUrl is a placeholder. TODO wire R2 in MVP-2.',
  };
}

// These would be replaced by real presigners; kept as functions to mark the seam.
function buildRealUploadPlaceholder(key: string): string {
  return `${env.R2_ENDPOINT}/${env.R2_BUCKET}/${key}?X-Amz-SignedHeaders=host&__todo=presign`;
}
function buildRealDownloadPlaceholder(key: string): string {
  return `${env.R2_ENDPOINT}/${env.R2_BUCKET}/${key}?X-Amz-SignedHeaders=host&__todo=presign`;
}

/** Used by residents module to presign KTP/selfie keys for detail view. Null-safe. */
export async function presignDownloadIfExists(key: string | null | undefined) {
  if (!key) return null;
  try {
    const { downloadUrl } = await presignDownload(key);
    return downloadUrl;
  } catch {
    return null;
  }
}
