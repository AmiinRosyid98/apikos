import { S3Client } from '@aws-sdk/client-s3';
import { env, r2Configured } from './env';

/**
 * Cloudflare R2 (S3-compatible) client. Lazily constructed so the app still boots when R2 is not
 * configured (presign falls back to the documented stub). R2 uses a single global region alias
 * `auto`; `forcePathStyle` keeps URLs as `<endpoint>/<bucket>/<key>` which R2 supports.
 *
 * R2_ENDPOINT is the account S3 API endpoint, e.g. `https://<accountid>.r2.cloudflarestorage.com`.
 */
let client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (!r2Configured) {
    throw new Error('R2 is not configured (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_ENDPOINT)');
  }
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
      },
    });
  }
  return client;
}

export const R2_BUCKET = env.R2_BUCKET;
