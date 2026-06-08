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
