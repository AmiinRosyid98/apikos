import PDFDocument from 'pdfkit';
import type { HandoverPdfContext } from './handovers.service';

/**
 * Generate the "Berita Acara Serah Terima" PDF on the fly with pdfkit (pure-JS, no headless
 * browser). Returns a Promise<Buffer> so the controller can set Content-Length and stream it.
 *
 * Layout: header (property/room/resident/date/type) → inventory table (item/condition/notes)
 * → photo reference list → signature line (image if a presigned signature URL is available)
 * → notes.
 */
const TYPE_LABEL: Record<string, string> = {
  checkin: 'Serah Terima Masuk (Check-in)',
  checkout: 'Serah Terima Keluar (Check-out)',
};
const CONDITION_LABEL: Record<string, string> = {
  good: 'Baik',
  damaged: 'Rusak',
  missing: 'Hilang',
};

export function generateHandoverPdf(ctx: HandoverPdfContext): Promise<Buffer> {
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

function renderDocument(doc: PDFKit.PDFDocument, ctx: HandoverPdfContext): void {
  const { handover, resident, property, room } = ctx;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;

  // ── Header ──
  doc.fontSize(18).font('Helvetica-Bold').text('BERITA ACARA SERAH TERIMA', { align: 'center' });
  doc
    .fontSize(11)
    .font('Helvetica')
    .text(TYPE_LABEL[handover.type] ?? handover.type, { align: 'center' });
  doc.moveDown(1);

  // ── Meta box ──
  const meta: Array<[string, string]> = [
    ['Properti', property?.name ?? '-'],
    ['Alamat', property ? `${property.address}, ${property.city}` : '-'],
    ['Kamar', room ? `${room.roomNumber} (${room.roomType})` : '-'],
    ['Penghuni', resident?.fullName ?? '-'],
    ['No. HP', resident?.phone ?? '-'],
    ['Tanggal', handover.date ?? '-'],
    ['Jenis', TYPE_LABEL[handover.type] ?? handover.type],
  ];
  if (handover.type === 'checkin' && handover.initialMeterElectricity !== null) {
    meta.push(['Meteran Listrik Awal', `${handover.initialMeterElectricity} kWh`]);
  }

  doc.fontSize(10).font('Helvetica');
  for (const [label, value] of meta) {
    const y = doc.y;
    doc.font('Helvetica-Bold').text(`${label}`, left, y, { width: 140 });
    doc.font('Helvetica').text(value, left + 150, y, { width: contentWidth - 150 });
    doc.moveDown(0.3);
  }
  doc.moveDown(0.7);

  // ── Inventory table ──
  doc.fontSize(12).font('Helvetica-Bold').text('Inventaris & Kondisi');
  doc.moveDown(0.3);

  const colItemW = contentWidth * 0.45;
  const colCondW = contentWidth * 0.2;
  const colNotesW = contentWidth * 0.35;
  const colItemX = left;
  const colCondX = left + colItemW;
  const colNotesX = left + colItemW + colCondW;

  // table header
  let rowY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('Item', colItemX, rowY, { width: colItemW });
  doc.text('Kondisi', colCondX, rowY, { width: colCondW });
  doc.text('Catatan', colNotesX, rowY, { width: colNotesW });
  doc.moveDown(0.2);
  drawHr(doc, left, right);

  doc.font('Helvetica');
  if (handover.inventory.length === 0) {
    doc.moveDown(0.3).text('(Tidak ada item inventaris)', colItemX);
  } else {
    for (const it of handover.inventory) {
      ensureSpace(doc, 24);
      rowY = doc.y + 2;
      const cond = CONDITION_LABEL[it.condition] ?? it.condition;
      doc.text(it.item, colItemX, rowY, { width: colItemW - 6 });
      const afterItemY = doc.y;
      doc.text(cond, colCondX, rowY, { width: colCondW - 6 });
      doc.text(it.notes ?? '-', colNotesX, rowY, { width: colNotesW });
      doc.y = Math.max(doc.y, afterItemY);
      doc.moveDown(0.2);
      drawHr(doc, left, right, 0.5);
    }
  }
  doc.moveDown(0.8);

  // ── Photo references ──
  doc.fontSize(12).font('Helvetica-Bold').text('Dokumentasi Foto');
  doc.fontSize(10).font('Helvetica');
  if (handover.photoKeys.length === 0) {
    doc.text('(Tidak ada foto terlampir)');
  } else {
    handover.photoKeys.forEach((key, i) => {
      ensureSpace(doc, 16);
      doc.text(`${i + 1}. ${key}`);
    });
  }
  doc.moveDown(0.8);

  // ── Notes ──
  if (handover.notes) {
    doc.fontSize(12).font('Helvetica-Bold').text('Catatan');
    doc.fontSize(10).font('Helvetica').text(handover.notes, { width: contentWidth });
    doc.moveDown(0.8);
  }

  // ── Signature ──
  ensureSpace(doc, 110);
  doc.moveDown(1);
  doc.fontSize(10).font('Helvetica');
  const sigY = doc.y;
  doc.text('Tanda Tangan Penghuni:', left, sigY);
  // Signature image is referenced by key on the handover; the rendered key is noted so the
  // document records which signature asset applies. (Image embedding needs the raw bytes which
  // the file stub does not return; we draw a signature line + the key reference instead.)
  doc.moveTo(left, sigY + 55).lineTo(left + 200, sigY + 55).stroke();
  doc
    .fontSize(8)
    .text(
      handover.signatureKey ? `Signature key: ${handover.signatureKey}` : '(belum ditandatangani)',
      left,
      sigY + 60,
      { width: 240 },
    );

  doc.fontSize(10).text(resident?.fullName ?? '', left, sigY + 78, { width: 200 });

  // Footer timestamp
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

function drawHr(doc: PDFKit.PDFDocument, x1: number, x2: number, width = 1): void {
  doc.save().lineWidth(width).strokeColor('#cccccc').moveTo(x1, doc.y).lineTo(x2, doc.y).stroke().restore();
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}
