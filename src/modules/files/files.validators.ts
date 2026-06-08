import { z } from 'zod';

export const purposeEnum = z.enum(['ktp', 'selfie', 'room_photo', 'payment_proof']);

// Whitelist: images jpeg/png/webp + pdf. Max 10MB.
export const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export const MAX_SIZE_BYTES = 10 * 1024 * 1024;

export const presignUploadSchema = z.object({
  purpose: purposeEnum,
  contentType: z.enum(ALLOWED_CONTENT_TYPES, {
    errorMap: () => ({ message: 'Unsupported content type. Allowed: jpeg, png, webp, pdf' }),
  }),
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive().max(MAX_SIZE_BYTES, 'File exceeds 10MB limit'),
});

export const presignDownloadSchema = z.object({
  key: z.string().min(1),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
