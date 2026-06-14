import PDFDocument from 'pdfkit';
import type { ContractPdfContext } from './contracts.service';

/**
 * Generate the contract PDF on the fly with pdfkit (pure-JS, no headless browser) — copies the
 * handover PDF approach. Returns a Promise<Buffer> so the controller can set Content-Length and
 * stream it.
 *
 * Layout: header (title + contract number) → parties (kos/owner ↔ resident) + period meta block →
 * the rendered contract body → signature lines (image bytes are not embedded because the file layer
 * is a presign stub; we draw a line + the signature key reference, same as the handover PDF).
 */
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draf',
  active: 'Aktif',
  signed: 'Ditandatangani',
  expired: 'Kedaluwarsa',
  terminated: 'Diakhiri',
};

export function generateContractPdf(ctx: ContractPdfContext): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      renderDocument(doc, ctx);
      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}

function renderDocument(doc: PDFKit.PDFDocument, ctx: ContractPdfContext): void {
  const { contract, resident, property, room, owner } = ctx;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;

  // ── Header ──
  doc.fontSize(16).font('Helvetica-Bold').text('SURAT PERJANJIAN SEWA / KONTRAK', { align: 'center' });
  doc
    .fontSize(11)
    .font('Helvetica')
    .text(`Nomor: ${contract.contractNumber}`, { align: 'center' });
  doc
    .fontSize(9)
    .font('Helvetica-Oblique')
    .text(`Status: ${STATUS_LABEL[contract.status] ?? contract.status}`, { align: 'center' });
  doc.moveDown(1);

  // ── Parties + period meta ──
  const meta: Array<[string, string]> = [
    ['Properti / Kos', property?.name ?? '-'],
    ['Alamat', property ? `${property.address}, ${property.city}, ${property.province}` : '-'],
    ['Pengelola', owner?.fullName ?? '-'],
    ['Penghuni', resident?.fullName ?? '-'],
    ['No. HP Penghuni', resident?.phone ?? '-'],
    ['Kamar', room ? `${room.roomNumber} (${room.roomType})` : '-'],
    ['Mulai Sewa', contract.startDate ?? '-'],
    ['Akhir Sewa', contract.endDate ?? '-'],
  ];
  doc.fontSize(10).font('Helvetica');
  for (const [label, value] of meta) {
    const y = doc.y;
    doc.font('Helvetica-Bold').text(`${label}`, left, y, { width: 150 });
    doc.font('Helvetica').text(value, left + 160, y, { width: contentWidth - 160 });
    doc.moveDown(0.3);
  }
  doc.moveDown(0.6);
  drawHr(doc, left, right);
  doc.moveDown(0.6);

  // ── Rendered body ──
  doc.fontSize(11).font('Helvetica').text(contract.body, left, doc.y, {
    width: contentWidth,
    align: 'left',
    lineGap: 2,
  });
  doc.moveDown(1.2);

  // ── Signatures ──
  ensureSpace(doc, 130);
  doc.moveDown(0.5);
  const sigTop = doc.y;
  const colW = contentWidth / 2;

  // Penghuni (left) and Pengelola (right) signature blocks.
  drawSignatureBlock(doc, left, sigTop, colW - 20, 'Penghuni', resident?.fullName ?? '', contract.residentSignatureKey);
  drawSignatureBlock(
    doc,
    left + colW + 20,
    sigTop,
    colW - 20,
    'Pengelola',
    owner?.fullName ?? '',
    contract.ownerSignatureKey,
  );

  if (contract.signedAt) {
    doc.y = sigTop + 105;
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .text(`Ditandatangani pada: ${contract.signedAt}`, left, doc.y, { width: contentWidth });
  }

  // Footer timestamp.
  doc
    .fontSize(8)
    .font('Helvetica-Oblique')
    .text(
      `Dokumen dibuat otomatis oleh KosManager • ${new Date().toISOString()}`,
      left,
      doc.page.height - doc.page.margins.bottom - 12,
      { width: contentWidth, align: 'center' },
    );
}

function drawSignatureBlock(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  role: string,
  name: string,
  signatureKey: string | null,
): void {
  doc.fontSize(10).font('Helvetica').text(`Tanda Tangan ${role}:`, x, y, { width });
  // Signature line. Image bytes are not embedded (file layer is a presign stub); we draw a line +
  // the signature key reference (same as the handover PDF).
  doc.moveTo(x, y + 55).lineTo(x + Math.min(width, 200), y + 55).stroke();
  doc
    .fontSize(8)
    .font('Helvetica')
    .text(signatureKey ? `Signature key: ${signatureKey}` : '(belum ditandatangani)', x, y + 60, {
      width,
    });
  doc.fontSize(10).text(name, x, y + 78, { width });
}

function drawHr(doc: PDFKit.PDFDocument, x1: number, x2: number, width = 1): void {
  doc.save().lineWidth(width).strokeColor('#cccccc').moveTo(x1, doc.y).lineTo(x2, doc.y).stroke().restore();
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}
