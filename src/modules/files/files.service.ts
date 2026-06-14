import { randomUUID } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { env, r2Configured } from '../../config/env';
import { getR2Client, R2_BUCKET } from '../../config/r2';
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
 * B3.4 — presign upload. When R2 is configured this returns a REAL presigned PUT URL (15 min TTL)
 * the client uploads to directly. `ContentType` is part of the signed command, so the client MUST
 * send the same `Content-Type` header on the PUT (the frontend does). When R2 is absent we fall
 * back to a DOCUMENTED PLACEHOLDER url so the contract/flow stays exercisable in demo mode.
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

  if (!r2Configured) {
    return {
      uploadUrl: `https://PLACEHOLDER.r2.local/upload?key=${encodeURIComponent(key)}&__stub=1`,
      key,
      expiresIn: PRESIGN_TTL_SECONDS,
      _note: 'STUB: R2 not configured. uploadUrl is a placeholder — no real upload happens. Set R2_* env to go live.',
    };
  }

  const uploadUrl = await getSignedUrl(
    getR2Client(),
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: input.contentType }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  return { uploadUrl, key, expiresIn: PRESIGN_TTL_SECONDS, _note: undefined as string | undefined };
}

/**
 * Presign download. Authorizes that the key belongs to the caller's tenant (the Prisma
 * tenant-guard scopes findFirst to tenantId). For PUBLIC files (room_photo/logo) a permanent
 * CDN URL is returned when R2_PUBLIC_BASE_URL is set; otherwise a short-lived presigned GET URL.
 */
export async function presignDownload(key: string) {
  const file = await prisma.fileObject.findFirst({ where: { key } });
  if (!file) throw Errors.notFound('File not found');

  if (!r2Configured) {
    return {
      downloadUrl: `https://PLACEHOLDER.r2.local/download?key=${encodeURIComponent(key)}&__stub=1`,
      expiresIn: PRESIGN_TTL_SECONDS,
      _note: 'STUB: R2 not configured. downloadUrl is a placeholder. Set R2_* env to go live.',
    };
  }

  // Public objects can be served straight from the bucket's public/CDN base if one is configured.
  if (!file.isPrivate && env.R2_PUBLIC_BASE_URL) {
    const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');
    return { downloadUrl: `${base}/${key}`, expiresIn: 0, _note: undefined as string | undefined };
  }

  const downloadUrl = await getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  return { downloadUrl, expiresIn: PRESIGN_TTL_SECONDS, _note: undefined as string | undefined };
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
