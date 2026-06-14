import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { Errors } from '../../utils/errors';
import { dateOnly, iso } from '../../utils/serialize';
import { decryptNullable } from '../../utils/crypto';
import { presignDownloadIfExists } from '../files/files.service';
import {
  renderTemplate,
  formatRupiah,
  formatTanggal,
  DEFAULT_CONTRACT_TEMPLATE,
  type ContractVars,
} from './contracts.templates';
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  ListTemplateQuery,
  CreateContractInput,
  CreateContractForResidentInput,
  ListContractQuery,
  SignContractInput,
  ContractStatusInput,
  CreateDocumentInput,
  ListDocumentByResidentQuery,
  ExpiringDocumentQuery,
} from './contracts.validators';

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type TemplateRow = Prisma.ContractTemplateGetPayload<object>;
type ContractRow = Prisma.ContractGetPayload<object>;
type DocumentRow = Prisma.DocumentRecordGetPayload<object>;

/**
 * Allowed contract status transitions (PRD §6.15). `expired` and `terminated` are terminal.
 *   draft → active | terminated
 *   active → signed | expired | terminated
 *   signed → active | expired | terminated   (re-activate a fully signed contract is allowed)
 * `sign` is a separate operation (PATCH /sign) that moves any non-terminal contract → `signed`.
 * Anything not listed here for PATCH /status → 409 CONFLICT.
 */
const STATUS_TRANSITIONS: Record<ContractRow['status'], ContractRow['status'][]> = {
  draft: ['active', 'terminated'],
  active: ['signed', 'expired', 'terminated'],
  signed: ['active', 'expired', 'terminated'],
  expired: [],
  terminated: [],
};

// ─────────────────────────── Serializers ───────────────────────────
export function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id,
    propertyId: t.propertyId,
    name: t.name,
    body: t.body,
    isActive: t.isActive,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export function serializeContract(c: ContractRow) {
  return {
    id: c.id,
    residentId: c.residentId,
    propertyId: c.propertyId,
    roomId: c.roomId,
    templateId: c.templateId,
    contractNumber: c.contractNumber,
    body: c.body,
    status: c.status,
    startDate: dateOnly(c.startDate),
    endDate: dateOnly(c.endDate),
    signedAt: iso(c.signedAt),
    residentSignatureKey: c.residentSignatureKey,
    ownerSignatureKey: c.ownerSignatureKey,
    notes: c.notes,
    createdByUserId: c.createdByUserId,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

export function serializeDocument(d: DocumentRow) {
  return {
    id: d.id,
    residentId: d.residentId,
    propertyId: d.propertyId,
    type: d.type,
    name: d.name,
    fileKey: d.fileKey,
    expiresAt: dateOnly(d.expiresAt),
    notes: d.notes,
    uploadedByUserId: d.uploadedByUserId,
    createdAt: iso(d.createdAt),
  };
}

// ─────────────────────────── Lookups ───────────────────────────
async function getTemplate(id: string): Promise<TemplateRow> {
  const t = await prisma.contractTemplate.findFirst({ where: { id } });
  if (!t) throw Errors.notFound('Contract template not found');
  return t;
}

async function getContract(id: string): Promise<ContractRow> {
  const c = await prisma.contract.findFirst({ where: { id } });
  if (!c) throw Errors.notFound('Contract not found');
  return c;
}

async function getResident(id: string) {
  const r = await prisma.resident.findFirst({ where: { id } });
  if (!r) throw Errors.notFound('Resident not found');
  return r;
}

export async function getContractPropertyId(id: string): Promise<string> {
  return (await getContract(id)).propertyId;
}

export async function getResidentPropertyId(id: string): Promise<string> {
  return (await getResident(id)).propertyId;
}

async function getDocument(id: string): Promise<DocumentRow> {
  const d = await prisma.documentRecord.findFirst({ where: { id } });
  if (!d) throw Errors.notFound('Document not found');
  return d;
}

/** A document's effective property for scope checks (own propertyId, else its resident's). */
export async function getDocumentPropertyId(id: string): Promise<string | null> {
  const d = await getDocument(id);
  if (d.propertyId) return d.propertyId;
  if (d.residentId) {
    const r = await prisma.resident.findFirst({ where: { id: d.residentId } });
    return r?.propertyId ?? null;
  }
  return null;
}

// ─────────────────────────── Templates CRUD ───────────────────────────
export async function listTemplates(q: ListTemplateQuery, scope: string[] | undefined) {
  const where: Prisma.ContractTemplateWhereInput = {};
  if (q.is_active !== undefined) where.isActive = q.is_active;

  // Property filter: tenant-default templates (propertyId null) are always returned (apply to all
  // properties); a property filter additionally includes that property's specific templates.
  if (q.property_id) {
    where.OR = [{ propertyId: null }, { propertyId: q.property_id }];
  }
  // Property-scope restriction (manager/admin/finance limited to user_property_access). Tenant
  // defaults (null) are visible to everyone; property-specific templates only for in-scope props.
  if (scope !== undefined) {
    where.AND = [{ OR: [{ propertyId: null }, { propertyId: { in: scope } }] }];
  }

  const [rows, total] = await Promise.all([
    prisma.contractTemplate.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.contractTemplate.count({ where }),
  ]);
  return { rows: rows.map(serializeTemplate), total };
}

export async function createTemplate(tenantId: string, input: CreateTemplateInput) {
  if (input.propertyId) {
    const p = await prisma.property.findFirst({ where: { id: input.propertyId } });
    if (!p) throw Errors.notFound('Property not found');
  }
  const created = await prisma.contractTemplate.create({
    data: {
      tenantId,
      propertyId: input.propertyId ?? null,
      name: input.name,
      body: input.body,
      isActive: input.isActive,
    },
  });
  return serializeTemplate(created);
}

export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  await getTemplate(id);
  if (input.propertyId) {
    const p = await prisma.property.findFirst({ where: { id: input.propertyId } });
    if (!p) throw Errors.notFound('Property not found');
  }
  const data: Prisma.ContractTemplateUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.body !== undefined) data.body = input.body;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.propertyId !== undefined) {
    data.property = input.propertyId
      ? { connect: { id: input.propertyId } }
      : { disconnect: true };
  }
  const updated = await prisma.contractTemplate.update({ where: { id }, data });
  return serializeTemplate(updated);
}

export async function deleteTemplate(id: string): Promise<{ id: string }> {
  await getTemplate(id);
  await prisma.contractTemplate.delete({ where: { id } });
  return { id };
}

// ─────────────────────────── Render helper ───────────────────────────
/**
 * Build the variable map from resident/room/property context (PRD §6.15 placeholders). NIK is
 * decrypted from the resident's `nikEnc` (consistent with resident detail). Date placeholders use
 * the contract's own start/end + today. Exported so the controller/tests can render a template
 * against a resident without persisting a contract (preview).
 */
export async function buildContractVars(
  residentId: string,
  startDate: Date,
  endDate: Date,
): Promise<ContractVars> {
  const resident = await getResident(residentId);
  const [property, room] = await Promise.all([
    prisma.property.findFirst({ where: { id: resident.propertyId } }),
    resident.roomId ? prisma.room.findFirst({ where: { id: resident.roomId } }) : Promise.resolve(null),
  ]);

  return {
    nama_penyewa: resident.fullName,
    nik: decryptNullable(resident.nikEnc) ?? '-',
    nomor_kamar: room?.roomNumber ?? '-',
    nama_kos: property?.name ?? '-',
    alamat: property ? `${property.address}, ${property.city}, ${property.province}` : '-',
    harga_sewa: formatRupiah(Number(resident.monthlyRent)),
    tanggal_masuk: formatTanggal(startDate),
    tanggal_keluar: formatTanggal(endDate),
    tanggal_hari_ini: formatTanggal(new Date()),
  };
}

/** Render an arbitrary template body against a resident's context (preview, no persistence). */
export async function renderForResident(
  residentId: string,
  body: string,
  startDate: Date,
  endDate: Date,
): Promise<string> {
  const vars = await buildContractVars(residentId, startDate, endDate);
  return renderTemplate(body, vars);
}

/**
 * Resolve the body to render for a contract: explicit templateId → that template; else the
 * property-specific active template; else the tenant-default active template; else the built-in
 * DEFAULT_CONTRACT_TEMPLATE. Returns { templateId, body } (templateId null when falling back to
 * the built-in default).
 */
async function resolveTemplateBody(
  propertyId: string,
  templateId: string | null | undefined,
): Promise<{ templateId: string | null; body: string }> {
  if (templateId) {
    const t = await getTemplate(templateId);
    return { templateId: t.id, body: t.body };
  }
  const propertySpecific = await prisma.contractTemplate.findFirst({
    where: { propertyId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  if (propertySpecific) return { templateId: propertySpecific.id, body: propertySpecific.body };

  const tenantDefault = await prisma.contractTemplate.findFirst({
    where: { propertyId: null, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  if (tenantDefault) return { templateId: tenantDefault.id, body: tenantDefault.body };

  return { templateId: null, body: DEFAULT_CONTRACT_TEMPLATE.body };
}

// ─────────────────────────── Contract numbering (KTR-{YEAR}-{SEQ}) ───────────────────────────
/** Per-tenant sequential contract numbering, mirrors the invoice/maintenance counter pattern. */
async function nextContractNumber(tx: TxClient, tenantId: string, year: number): Promise<string> {
  const counter = await tx.tenantCounter.findUnique({ where: { tenantId } });
  let seq: number;
  if (!counter) {
    await tx.tenantCounter.create({
      data: { tenantId, contractSeqYear: year, contractSeq: 1 },
    });
    seq = 1;
  } else if (counter.contractSeqYear !== year) {
    await tx.tenantCounter.update({
      where: { tenantId },
      data: { contractSeqYear: year, contractSeq: 1 },
    });
    seq = 1;
  } else {
    const updated = await tx.tenantCounter.update({
      where: { tenantId },
      data: { contractSeq: { increment: 1 } },
    });
    seq = updated.contractSeq;
  }
  return `KTR-${year}-${String(seq).padStart(4, '0')}`;
}

// ─────────────────────────── Contracts ───────────────────────────
export async function listContracts(q: ListContractQuery, scope: string[] | undefined) {
  const where: Prisma.ContractWhereInput = {};
  if (q.resident_id) where.residentId = q.resident_id;
  if (q.status) where.status = q.status;
  if (q.property_id) where.propertyId = q.property_id;
  if (scope !== undefined) {
    where.propertyId =
      q.property_id && scope.includes(q.property_id)
        ? q.property_id
        : { in: q.property_id ? ['__none__'] : scope };
  }

  const [rows, total] = await Promise.all([
    prisma.contract.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.contract.count({ where }),
  ]);
  return { rows: rows.map(serializeContract), total };
}

/** Contract detail + presigned signature URLs (resident + owner). */
export async function getContractDetail(id: string) {
  const c = await getContract(id);
  const [residentSignatureUrl, ownerSignatureUrl] = await Promise.all([
    presignDownloadIfExists(c.residentSignatureKey),
    presignDownloadIfExists(c.ownerSignatureKey),
  ]);
  return { ...serializeContract(c), residentSignatureUrl, ownerSignatureUrl };
}

/**
 * Generate a contract for a resident. Resolves the template body, renders it against the resident's
 * context into a STABLE snapshot, allocates a sequential contractNumber, stores it as `draft`.
 */
export async function createContract(
  tenantId: string,
  userId: string,
  input: CreateContractInput,
) {
  const resident = await getResident(input.residentId);
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);

  const { templateId, body } = await resolveTemplateBody(resident.propertyId, input.templateId);
  const vars = await buildContractVars(resident.id, start, end);
  const renderedBody = renderTemplate(body, vars);

  const year = start.getUTCFullYear();
  const created = await prisma.$transaction(async (tx) => {
    const contractNumber = await nextContractNumber(tx, tenantId, year);
    return tx.contract.create({
      data: {
        tenantId,
        residentId: resident.id,
        propertyId: resident.propertyId,
        roomId: resident.roomId,
        templateId,
        contractNumber,
        body: renderedBody,
        status: 'draft',
        startDate: start,
        endDate: end,
        notes: input.notes,
        createdByUserId: userId,
      },
    });
  });
  return serializeContract(created);
}

/**
 * Convenience generate (POST /residents/:id/contract). Defaults: startDate = resident.checkInDate,
 * endDate = resident.contractEndDate (or startDate + 1 year if none). Reuses createContract.
 */
export async function createContractForResident(
  tenantId: string,
  userId: string,
  residentId: string,
  input: CreateContractForResidentInput,
) {
  const resident = await getResident(residentId);

  const start = input.startDate
    ? new Date(input.startDate)
    : new Date(resident.checkInDate);
  let end: Date;
  if (input.endDate) {
    end = new Date(input.endDate);
  } else if (resident.contractEndDate) {
    end = new Date(resident.contractEndDate);
  } else {
    end = new Date(start);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  }
  if (end.getTime() <= start.getTime()) {
    throw Errors.validation('Resolved endDate must be after startDate; provide explicit dates');
  }

  return createContract(tenantId, userId, {
    residentId,
    templateId: input.templateId ?? undefined,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    notes: input.notes,
  });
}

/** Sign a contract (Manager+): stores signature keys, sets status `signed` + signedAt. */
export async function signContract(id: string, input: SignContractInput) {
  const c = await getContract(id);
  if (c.status === 'terminated' || c.status === 'expired') {
    throw Errors.conflict(`Cannot sign a contract with status '${c.status}'`);
  }
  const updated = await prisma.contract.update({
    where: { id },
    data: {
      status: 'signed',
      signedAt: new Date(),
      residentSignatureKey: input.residentSignatureKey,
      ownerSignatureKey: input.ownerSignatureKey ?? c.ownerSignatureKey,
    },
  });
  return serializeContract(updated);
}

/** Change contract status (Manager+) with valid-transition enforcement → 409 on invalid. */
export async function changeContractStatus(id: string, input: ContractStatusInput) {
  const c = await getContract(id);
  if (c.status === input.status) {
    throw Errors.conflict(`Contract is already '${input.status}'`);
  }
  const allowed = STATUS_TRANSITIONS[c.status];
  if (!allowed.includes(input.status)) {
    throw Errors.conflict(`Invalid status transition '${c.status}' → '${input.status}'`);
  }
  const data: Prisma.ContractUpdateInput = { status: input.status };
  if (input.notes !== undefined) data.notes = input.notes;
  const updated = await prisma.contract.update({ where: { id }, data });
  return serializeContract(updated);
}

/** Load the context the PDF generator needs (resident/property/room + the contract). */
export async function getContractForPdf(id: string) {
  const c = await getContract(id);
  const [resident, property, room, residentSignatureUrl, ownerSignatureUrl] = await Promise.all([
    prisma.resident.findFirst({ where: { id: c.residentId } }),
    prisma.property.findFirst({ where: { id: c.propertyId } }),
    c.roomId ? prisma.room.findFirst({ where: { id: c.roomId } }) : Promise.resolve(null),
    presignDownloadIfExists(c.residentSignatureKey),
    presignDownloadIfExists(c.ownerSignatureKey),
  ]);
  const owner = await prisma.user.findFirst({
    where: { tenantId: c.tenantId, role: 'owner' },
    orderBy: { createdAt: 'asc' },
  });

  return {
    contract: serializeContract(c),
    resident: resident
      ? { id: resident.id, fullName: resident.fullName, phone: resident.phone }
      : null,
    property: property
      ? {
          id: property.id,
          name: property.name,
          address: property.address,
          city: property.city,
          province: property.province,
        }
      : null,
    room: room ? { id: room.id, roomNumber: room.roomNumber, roomType: room.roomType } : null,
    owner: owner ? { fullName: owner.fullName } : null,
    residentSignatureUrl,
    ownerSignatureUrl,
  };
}

export type ContractPdfContext = Awaited<ReturnType<typeof getContractForPdf>>;

// ─────────────────────────── Documents ───────────────────────────
export async function listDocumentsByResident(
  residentId: string,
  q: ListDocumentByResidentQuery,
) {
  await getResident(residentId);
  const where: Prisma.DocumentRecordWhereInput = { residentId };
  if (q.type) where.type = q.type;

  const [rows, total] = await Promise.all([
    prisma.documentRecord.findMany({
      where,
      orderBy: { createdAt: q.sort_order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.documentRecord.count({ where }),
  ]);
  // Presign each fileKey for the detail/list view.
  const withUrls = await Promise.all(
    rows.map(async (d) => ({
      ...serializeDocument(d),
      fileUrl: await presignDownloadIfExists(d.fileKey),
    })),
  );
  return { rows: withUrls, total };
}

export async function createDocumentForResident(
  tenantId: string,
  userId: string,
  residentId: string,
  input: CreateDocumentInput,
) {
  const resident = await getResident(residentId);
  if (input.propertyId) {
    const p = await prisma.property.findFirst({ where: { id: input.propertyId } });
    if (!p) throw Errors.notFound('Property not found');
  }
  const created = await prisma.documentRecord.create({
    data: {
      tenantId,
      residentId,
      // Default the document's property to the resident's when not explicitly supplied.
      propertyId: input.propertyId ?? resident.propertyId,
      type: input.type,
      name: input.name,
      fileKey: input.fileKey,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      notes: input.notes,
      uploadedByUserId: userId,
    },
  });
  return serializeDocument(created);
}

export async function deleteDocument(id: string): Promise<{ id: string }> {
  await getDocument(id);
  await prisma.documentRecord.delete({ where: { id } });
  return { id };
}

/**
 * Documents whose `expiresAt` is within the next N days (PRD §6.15 renewal-notification seam). Only
 * documents with a non-null expiresAt, expiring between today and today+days (inclusive). This is
 * the hook point where the WhatsApp `contract_expiry`/reminder sweep would source rows to notify.
 */
export async function listExpiringDocuments(
  q: ExpiringDocumentQuery,
  scope: string[] | undefined,
) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const until = new Date(today);
  until.setUTCDate(until.getUTCDate() + q.days);

  const where: Prisma.DocumentRecordWhereInput = {
    expiresAt: { not: null, gte: today, lte: until },
  };
  if (q.property_id) where.propertyId = q.property_id;
  if (scope !== undefined) {
    // Limit to in-scope properties; documents with a null propertyId are tenant-wide → included.
    where.OR = [{ propertyId: null }, { propertyId: { in: q.property_id && scope.includes(q.property_id) ? [q.property_id] : scope } }];
  }

  const [rows, total] = await Promise.all([
    prisma.documentRecord.findMany({
      where,
      orderBy: { expiresAt: 'asc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.documentRecord.count({ where }),
  ]);
  return { rows: rows.map(serializeDocument), total, windowDays: q.days };
}
