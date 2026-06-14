/**
 * Canonical API-key scopes (PRD Modul 22). A key's `scopes` (string[]) restrict which external
 * endpoints it can reach. requireScope(x) → 403 FORBIDDEN when the key lacks x.
 */
export const API_SCOPES = [
  'properties:read',
  'rooms:read',
  'residents:read',
  'invoices:read',
  'bookings:read',
  'bookings:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Default scope set offered when a key is created without an explicit list (all read scopes). */
export const DEFAULT_READ_SCOPES: ApiScope[] = [
  'properties:read',
  'rooms:read',
  'residents:read',
  'invoices:read',
  'bookings:read',
];
