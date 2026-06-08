import { Request } from 'express';
import { prisma } from '../config/database';

export interface AuditEntry {
  action: string; // e.g. 'property.create'
  entityType: string; // e.g. 'property'
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * B2.5 — writes an immutable audit log entry. Called from services on every mutation.
 * audit_logs has no update/delete route (append-only). Failures are swallowed (logged) so
 * an audit write never breaks the primary mutation, but they should be monitored.
 */
export async function writeAudit(req: Request, entry: AuditEntry): Promise<void> {
  try {
    if (!req.auth) return;
    let userName: string | undefined;
    try {
      const u = await prisma.user.findUnique({
        where: { id: req.auth.userId },
        select: { fullName: true },
      });
      userName = u?.fullName;
    } catch {
      /* ignore */
    }
    await prisma.auditLog.create({
      data: {
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        userName,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        oldValue: entry.oldValue === undefined ? undefined : (entry.oldValue as any),
        newValue: entry.newValue === undefined ? undefined : (entry.newValue as any),
        ipAddress: req.ip,
        userAgent: req.header('user-agent') ?? undefined,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write audit log:', (e as Error).message);
  }
}
