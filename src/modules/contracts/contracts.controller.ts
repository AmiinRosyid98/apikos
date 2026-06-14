import { Request, Response } from 'express';
import { ok, okPaged, buildMeta } from '../../utils/response';
import { vquery } from '../../middleware/validate';
import { assertPropertyAccess } from '../../middleware/rbacGuard';
import { writeAudit } from '../../services/audit.service';
import * as svc from './contracts.service';
import { generateContractPdf } from './contracts.pdf';
import type {
  ListTemplateQuery,
  ListContractQuery,
  ListDocumentByResidentQuery,
  ExpiringDocumentQuery,
} from './contracts.validators';

// ─────────────────────────── Templates ───────────────────────────
export async function listTemplates(req: Request, res: Response) {
  const q = vquery<ListTemplateQuery>(req);
  const { rows, total } = await svc.listTemplates(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function createTemplate(req: Request, res: Response) {
  if (req.body.propertyId) assertPropertyAccess(req, req.body.propertyId);
  const created = await svc.createTemplate(req.auth!.tenantId, req.body);
  await writeAudit(req, {
    action: 'contract_template.create',
    entityType: 'contract_template',
    entityId: created.id,
    newValue: { id: created.id, name: created.name, propertyId: created.propertyId },
  });
  return ok(res, created, 201);
}

export async function updateTemplate(req: Request, res: Response) {
  if (req.body.propertyId) assertPropertyAccess(req, req.body.propertyId);
  const updated = await svc.updateTemplate(req.params.id, req.body);
  await writeAudit(req, {
    action: 'contract_template.update',
    entityType: 'contract_template',
    entityId: updated.id,
    newValue: { name: updated.name, isActive: updated.isActive, propertyId: updated.propertyId },
  });
  return ok(res, updated);
}

export async function deleteTemplate(req: Request, res: Response) {
  const result = await svc.deleteTemplate(req.params.id);
  await writeAudit(req, {
    action: 'contract_template.delete',
    entityType: 'contract_template',
    entityId: req.params.id,
  });
  return ok(res, result);
}

// ─────────────────────────── Contracts ───────────────────────────
async function guardContract(req: Request) {
  const propertyId = await svc.getContractPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

async function guardResident(req: Request) {
  const propertyId = await svc.getResidentPropertyId(req.params.id);
  assertPropertyAccess(req, propertyId);
}

export async function listContracts(req: Request, res: Response) {
  const q = vquery<ListContractQuery>(req);
  const { rows, total } = await svc.listContracts(q, req.propertyScope);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function contractDetail(req: Request, res: Response) {
  await guardContract(req);
  const data = await svc.getContractDetail(req.params.id);
  return ok(res, data);
}

export async function createContract(req: Request, res: Response) {
  // Scope check via the resident's property.
  const propertyId = await svc.getResidentPropertyId(req.body.residentId);
  assertPropertyAccess(req, propertyId);

  const created = await svc.createContract(req.auth!.tenantId, req.auth!.userId, req.body);
  await writeAudit(req, {
    action: 'contract.create',
    entityType: 'contract',
    entityId: created.id,
    newValue: {
      id: created.id,
      contractNumber: created.contractNumber,
      residentId: created.residentId,
      status: created.status,
    },
  });
  return ok(res, created, 201);
}

export async function createContractForResident(req: Request, res: Response) {
  await guardResident(req);
  const created = await svc.createContractForResident(
    req.auth!.tenantId,
    req.auth!.userId,
    req.params.id,
    req.body,
  );
  await writeAudit(req, {
    action: 'contract.create',
    entityType: 'contract',
    entityId: created.id,
    newValue: {
      id: created.id,
      contractNumber: created.contractNumber,
      residentId: created.residentId,
      status: created.status,
    },
  });
  return ok(res, created, 201);
}

export async function signContract(req: Request, res: Response) {
  await guardContract(req);
  const updated = await svc.signContract(req.params.id, req.body);
  await writeAudit(req, {
    action: 'contract.sign',
    entityType: 'contract',
    entityId: updated.id,
    newValue: { status: updated.status, signedAt: updated.signedAt },
  });
  return ok(res, updated);
}

export async function changeContractStatus(req: Request, res: Response) {
  await guardContract(req);
  const updated = await svc.changeContractStatus(req.params.id, req.body);
  await writeAudit(req, {
    action: 'contract.status',
    entityType: 'contract',
    entityId: updated.id,
    newValue: { status: updated.status },
  });
  return ok(res, updated);
}

export async function contractPdf(req: Request, res: Response) {
  await guardContract(req);
  const ctx = await svc.getContractForPdf(req.params.id);
  const buffer = await generateContractPdf(ctx);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader(
    'Content-Disposition',
    `inline; filename="kontrak-${ctx.contract.contractNumber}.pdf"`,
  );
  return res.status(200).end(buffer);
}

// ─────────────────────────── Documents ───────────────────────────
export async function listDocumentsByResident(req: Request, res: Response) {
  await guardResident(req);
  const q = vquery<ListDocumentByResidentQuery>(req);
  const { rows, total } = await svc.listDocumentsByResident(req.params.id, q);
  return okPaged(res, rows, buildMeta(q.page, q.limit, total));
}

export async function createDocumentForResident(req: Request, res: Response) {
  await guardResident(req);
  const created = await svc.createDocumentForResident(
    req.auth!.tenantId,
    req.auth!.userId,
    req.params.id,
    req.body,
  );
  await writeAudit(req, {
    action: 'document.create',
    entityType: 'document',
    entityId: created.id,
    newValue: { id: created.id, type: created.type, name: created.name, expiresAt: created.expiresAt },
  });
  return ok(res, created, 201);
}

export async function deleteDocument(req: Request, res: Response) {
  // Scope via the document's effective property (own or its resident's). null → tenant-wide; the
  // Prisma tenant-guard already isolates, and assertPropertyAccess with undefined scope is a no-op.
  const propertyId = await svc.getDocumentPropertyId(req.params.id);
  if (propertyId) assertPropertyAccess(req, propertyId);
  const result = await svc.deleteDocument(req.params.id);
  await writeAudit(req, {
    action: 'document.delete',
    entityType: 'document',
    entityId: req.params.id,
  });
  return ok(res, result);
}

export async function listExpiringDocuments(req: Request, res: Response) {
  const q = vquery<ExpiringDocumentQuery>(req);
  const { rows, total, windowDays } = await svc.listExpiringDocuments(q, req.propertyScope);
  return okPaged(res, rows, { ...buildMeta(q.page, q.limit, total), windowDays } as never);
}
