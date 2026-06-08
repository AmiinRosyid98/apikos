import { Prisma } from '@prisma/client';

/** Convert Prisma Decimal → number for JSON responses. Null-safe. */
export function dec(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

/** Convert Date → ISO date (YYYY-MM-DD) for @db.Date columns. */
export function dateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

/** Convert Date → full ISO timestamp. */
export function iso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString();
}
