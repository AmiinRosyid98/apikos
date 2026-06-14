import { JwtRole } from '../utils/jwt';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      auth?: {
        userId: string;
        tenantId: string;
        role: JwtRole;
      };
      /** Property ids the caller may access (owner = all → undefined means "all"). */
      propertyScope?: string[] | undefined;
      /**
       * Public API (PRD Modul 22) auth context — set by apiKeyAuth on the /api/ext/v1 surface.
       * Mutually exclusive with `auth` (which is JWT/dashboard). Carries the resolved tenant +
       * the key's granted scopes for requireScope() checks.
       */
      apiAuth?: {
        apiKeyId: string;
        tenantId: string;
        scopes: string[];
      };
      /** Captured by audit middleware for log entries. */
      auditContext?: {
        action?: string;
        entityType?: string;
        entityId?: string;
        oldValue?: unknown;
        newValue?: unknown;
      };
    }
  }
}

export {};
