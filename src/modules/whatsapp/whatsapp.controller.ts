import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import * as svc from './whatsapp.service';
import type {
  ListTemplateQuery,
  ListLogsQuery,
  SendInvoiceWaInput,
} from './whatsapp.validators';

// ── Templates ──
export async function listTemplates(req: Request, res: Response) {
  const q = vquery<ListTemplateQuery>(req);
  const { rows, total } = await svc.listTemplates(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function createTemplate(req: Request, res: Response) {
  // Property-scope: if scoped to a specific property, enforce access.
  if (req.body.propertyId) assertPropertyAccess(req, req.body.propertyId);
  const created = await svc.createTemplate(req.auth!.tenantId, req.body);
  await writeAudit(req, {
    action: 'wa_template.create',
    entityType: 'wa_template',
    entityId: created.id,
    newValue: { type: created.type, name: created.name, propertyId: created.propertyId },
  });
  return ok(res, created, 201);
}

export async function updateTemplate(req: Request, res: Response) {
  const propertyId = await svc.getTemplatePropertyId(req.params.id);
  if (propertyId) assertPropertyAccess(req, propertyId);
  const updated = await svc.updateTemplate(req.params.id, req.body);
  await writeAudit(req, {
    action: 'wa_template.update',
    entityType: 'wa_template',
    entityId: updated.id,
    newValue: { name: updated.name, isActive: updated.isActive },
  });
  return ok(res, updated);
}

export async function deleteTemplate(req: Request, res: Response) {
  const propertyId = await svc.getTemplatePropertyId(req.params.id);
  if (propertyId) assertPropertyAccess(req, propertyId);
  const result = await svc.deleteTemplate(req.params.id);
  await writeAudit(req, {
    action: 'wa_template.delete',
    entityType: 'wa_template',
    entityId: req.params.id,
  });
  return ok(res, result);
}

// ── Send invoice via WA ──
export async function sendInvoiceWa(req: Request, res: Response) {
  const propertyId = await svc.getInvoicePropertyIdForWa(req.params.id);
  assertPropertyAccess(req, propertyId);
  const input = (req.body ?? { templateType: 'invoice_new' }) as SendInvoiceWaInput;
  const msg = await svc.sendInvoiceWa(
    req.auth!.tenantId,
    req.params.id,
    input.templateType,
    req.auth!.userId,
  );
  await writeAudit(req, {
    action: 'wa.send_invoice',
    entityType: 'wa_message',
    entityId: msg.id,
    newValue: { invoiceId: req.params.id, status: msg.status, templateType: input.templateType },
  });
  return ok(res, msg, 201);
}

// ── Broadcast ──
export async function broadcast(req: Request, res: Response) {
  assertPropertyAccess(req, req.body.propertyId);
  const result = await svc.broadcast(req.auth!.tenantId, req.body, req.auth!.userId);
  await writeAudit(req, {
    action: 'wa.broadcast',
    entityType: 'wa_message',
    entityId: req.body.propertyId,
    newValue: { propertyId: req.body.propertyId, sent: result.sent, recipients: result.recipients },
  });
  return ok(res, result, 201);
}

// ── Logs ──
export async function listLogs(req: Request, res: Response) {
  const q = vquery<ListLogsQuery>(req);
  const { rows, total } = await svc.listLogs(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

// ── Status / quota ──
export async function status(req: Request, res: Response) {
  const data = await svc.getStatus(req.auth!.tenantId);
  return ok(res, data);
}

// ── Reminder config (mounted under /properties/:id/reminder-config) ──
export async function getReminderConfig(req: Request, res: Response) {
  assertPropertyAccess(req, req.params.id);
  const data = await svc.getReminderConfig(req.params.id);
  return ok(res, data);
}

export async function updateReminderConfig(req: Request, res: Response) {
  assertPropertyAccess(req, req.params.id);
  const data = await svc.updateReminderConfig(req.params.id, req.body);
  await writeAudit(req, {
    action: 'property.reminder_config.update',
    entityType: 'property',
    entityId: req.params.id,
    newValue: data,
  });
  return ok(res, data);
}
