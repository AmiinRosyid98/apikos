import { Router } from 'express';
import * as ctrl from './contracts.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { rbacGuard, ALL, ADMIN_PLUS, MANAGER_PLUS, loadPropertyScope } from '../../middleware/rbacGuard';
import {
  createTemplateSchema,
  updateTemplateSchema,
  listTemplateQuery,
  createContractSchema,
  createContractForResidentSchema,
  listContractQuery,
  signContractSchema,
  contractStatusSchema,
  createDocumentSchema,
  listDocumentByResidentQuery,
  expiringDocumentQuery,
} from './contracts.validators';

/**
 * Dokumen & Kontrak Module routes (PRD §6.15). RBAC (PRD §13 — mapped, no explicit Dokumen row):
 *   Templates config (create/edit/delete) → Manager+ (like WA template config); view → ALL.
 *   Contracts: generate/edit → Admin+; sign / change status → Manager+; view + PDF → ALL.
 *   Documents: add → Admin+; delete → Manager+; view + expiring → ALL.
 * No plan gate (Dokumen & Kontrak is not in the §12.2 plan matrix → available on all plans).
 */

// ── /api/v1/contract-templates ──
export const contractTemplatesRouter = Router();
contractTemplatesRouter.use(loadPropertyScope);
contractTemplatesRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listTemplateQuery, 'query'),
  asyncHandler(ctrl.listTemplates),
);
contractTemplatesRouter.post(
  '/',
  rbacGuard(MANAGER_PLUS),
  validate(createTemplateSchema),
  asyncHandler(ctrl.createTemplate),
);
contractTemplatesRouter.put(
  '/:id',
  rbacGuard(MANAGER_PLUS),
  validate(updateTemplateSchema),
  asyncHandler(ctrl.updateTemplate),
);
contractTemplatesRouter.delete('/:id', rbacGuard(MANAGER_PLUS), asyncHandler(ctrl.deleteTemplate));

// ── /api/v1/contracts ──
export const contractsRouter = Router();
contractsRouter.use(loadPropertyScope);
contractsRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listContractQuery, 'query'),
  asyncHandler(ctrl.listContracts),
);
contractsRouter.post(
  '/',
  rbacGuard(ADMIN_PLUS),
  validate(createContractSchema),
  asyncHandler(ctrl.createContract),
);
contractsRouter.get('/:id', rbacGuard(ALL), asyncHandler(ctrl.contractDetail));
contractsRouter.get('/:id/pdf', rbacGuard(ALL), asyncHandler(ctrl.contractPdf));
contractsRouter.patch(
  '/:id/sign',
  rbacGuard(MANAGER_PLUS),
  validate(signContractSchema),
  asyncHandler(ctrl.signContract),
);
contractsRouter.patch(
  '/:id/status',
  rbacGuard(MANAGER_PLUS),
  validate(contractStatusSchema),
  asyncHandler(ctrl.changeContractStatus),
);

// ── /api/v1/documents ──
export const documentsRouter = Router();
documentsRouter.use(loadPropertyScope);
// GET /documents/expiring?days=30 (renewal-notification seam) — All roles.
documentsRouter.get(
  '/expiring',
  rbacGuard(ALL),
  validate(expiringDocumentQuery, 'query'),
  asyncHandler(ctrl.listExpiringDocuments),
);
documentsRouter.delete('/:id', rbacGuard(MANAGER_PLUS), asyncHandler(ctrl.deleteDocument));

// ── Nested under /residents/:id : /contract, /documents (mergeParams to read :id) ──
export const residentContractRouter = Router({ mergeParams: true });
residentContractRouter.use(loadPropertyScope);
// POST /residents/:id/contract — convenience generate (Admin+).
residentContractRouter.post(
  '/',
  rbacGuard(ADMIN_PLUS),
  validate(createContractForResidentSchema),
  asyncHandler(ctrl.createContractForResident),
);

export const residentDocumentsRouter = Router({ mergeParams: true });
residentDocumentsRouter.use(loadPropertyScope);
residentDocumentsRouter.get(
  '/',
  rbacGuard(ALL),
  validate(listDocumentByResidentQuery, 'query'),
  asyncHandler(ctrl.listDocumentsByResident),
);
residentDocumentsRouter.post(
  '/',
  rbacGuard(ADMIN_PLUS),
  validate(createDocumentSchema),
  asyncHandler(ctrl.createDocumentForResident),
);
