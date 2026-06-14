import ExcelJS from 'exceljs';
import type { Worksheet } from 'exceljs';
import * as svc from './reports.service';
import type { ExportReportQuery, ReportType } from './reports.validators';

const RP_FMT = '#,##0';
const TITLE = 'KosManager';
const STATUS_LABEL: Record<string, string> = {
  unpaid: 'Belum Bayar',
  partial: 'Sebagian',
  paid: 'Lunas',
  overdue: 'Terlambat',
  cancelled: 'Dibatalkan',
};

interface BuildResult {
  buffer: Buffer;
  filename: string;
}

/** Apply the standard title block (title + report name + property/period header) to a sheet. */
function writeHeader(ws: Worksheet, reportName: string, header: string, lastCol: number) {
  const lastColLetter = ws.getColumn(lastCol).letter;
  ws.mergeCells(`A1:${lastColLetter}1`);
  ws.getCell('A1').value = `${TITLE} — ${reportName}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.mergeCells(`A2:${lastColLetter}2`);
  ws.getCell('A2').value = header;
  ws.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF555555' } };
  ws.getCell('A2').alignment = { wrapText: true };
}

/** Style a header row (bold + light fill + bottom border). */
function styleHeaderRow(ws: Worksheet, rowNumber: number) {
  const row = ws.getRow(rowNumber);
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBBBBBB' } } };
  });
}

function styleTotalsRow(ws: Worksheet, rowNumber: number) {
  const row = ws.getRow(rowNumber);
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.border = { top: { style: 'thin', color: { argb: 'FF999999' } } };
  });
}

async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr as ArrayBuffer);
}

function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = TITLE;
  wb.created = new Date();
  return wb;
}

// ─────────────────────────── Per-type builders ───────────────────────────
async function buildInvoices(q: ExportReportQuery, scope: string[] | undefined, propName: string) {
  const data = await svc.invoicesReport({ property_id: q.property_id, month: q.month, year: q.year }, scope);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Tagihan');
  ws.columns = [
    { key: 'invoiceNumber', width: 20 },
    { key: 'residentName', width: 24 },
    { key: 'roomNumber', width: 10 },
    { key: 'period', width: 12 },
    { key: 'total', width: 16 },
    { key: 'paid', width: 16 },
    { key: 'outstanding', width: 16 },
    { key: 'status', width: 14 },
    { key: 'dueDate', width: 14 },
  ];
  writeHeader(ws, 'Laporan Tagihan', `Properti: ${propName} · Periode: ${q.month}/${q.year}`, 9);
  const headerRow = ws.addRow(['No. Invoice', 'Penghuni', 'Kamar', 'Periode', 'Total', 'Dibayar', 'Sisa', 'Status', 'Jatuh Tempo']);
  styleHeaderRow(ws, headerRow.number);
  for (const r of data.rows) {
    const row = ws.addRow([
      r.invoiceNumber,
      r.residentName,
      r.roomNumber ?? '—',
      r.period,
      r.total,
      r.paid,
      r.total - r.paid,
      STATUS_LABEL[r.status] ?? r.status,
      r.dueDate ?? '—',
    ]);
    [5, 6, 7].forEach((c) => (row.getCell(c).numFmt = RP_FMT));
  }
  const totalRow = ws.addRow([
    'TOTAL', '', '', '', data.totalInvoiced, data.totalPaid, data.totalOutstanding, '', '',
  ]);
  [5, 6, 7].forEach((c) => (totalRow.getCell(c).numFmt = RP_FMT));
  styleTotalsRow(ws, totalRow.number);
  return wb;
}

async function buildResidents(q: ExportReportQuery, scope: string[] | undefined, propName: string) {
  const data = await svc.residentsReport({ property_id: q.property_id, month: q.month, year: q.year }, scope);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Penghuni');
  ws.columns = [
    { key: 'name', width: 26 },
    { key: 'roomNumber', width: 10 },
    { key: 'status', width: 14 },
    { key: 'checkInDate', width: 14 },
    { key: 'checkOutDate', width: 14 },
  ];
  writeHeader(
    ws,
    'Laporan Penghuni',
    `Properti: ${propName} · Periode: ${q.month}/${q.year} · Masuk: ${data.movedIn} · Keluar: ${data.movedOut} · Aktif: ${data.active}`,
    5,
  );
  const headerRow = ws.addRow(['Nama', 'Kamar', 'Status', 'Tgl Masuk', 'Tgl Keluar']);
  styleHeaderRow(ws, headerRow.number);
  for (const r of data.rows) {
    ws.addRow([r.name, r.roomNumber ?? '—', r.status, r.checkInDate ?? '—', r.checkOutDate ?? '—']);
  }
  return wb;
}

async function buildOccupancy(q: ExportReportQuery, scope: string[] | undefined, propName: string) {
  const rows = await svc.occupancyReport({ property_id: q.property_id, months: q.months }, scope);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Okupansi');
  ws.columns = [
    { key: 'month', width: 14 },
    { key: 'totalRooms', width: 14 },
    { key: 'occupied', width: 14 },
    { key: 'rate', width: 14 },
  ];
  writeHeader(ws, 'Laporan Okupansi', `Properti: ${propName} · ${q.months} bulan terakhir`, 4);
  const headerRow = ws.addRow(['Bulan', 'Total Kamar', 'Terisi', 'Okupansi (%)']);
  styleHeaderRow(ws, headerRow.number);
  for (const r of rows) {
    const row = ws.addRow([r.month, r.totalRooms, r.occupied, r.rate]);
    row.getCell(4).numFmt = '0.00';
  }
  return wb;
}

async function buildRevenue(q: ExportReportQuery, scope: string[] | undefined, propName: string) {
  const data = await svc.revenueReport({ property_id: q.property_id, year: q.year }, scope);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Pendapatan');
  ws.columns = [
    { key: 'month', width: 14 },
    { key: 'realized', width: 18 },
    { key: 'target', width: 18 },
    { key: 'achievement', width: 16 },
  ];
  writeHeader(ws, 'Laporan Pendapatan', `Properti: ${propName} · Tahun: ${q.year}`, 4);
  const headerRow = ws.addRow(['Bulan', 'Realisasi', 'Target', 'Capaian (%)']);
  styleHeaderRow(ws, headerRow.number);
  for (const r of data.rows) {
    const ach = r.target > 0 ? Math.round((r.realized / r.target) * 10000) / 100 : 0;
    const row = ws.addRow([r.month, r.realized, r.target, ach]);
    row.getCell(2).numFmt = RP_FMT;
    row.getCell(3).numFmt = RP_FMT;
    row.getCell(4).numFmt = '0.00';
  }
  const totalAch = data.totalTarget > 0 ? Math.round((data.totalRealized / data.totalTarget) * 10000) / 100 : 0;
  const totalRow = ws.addRow(['TOTAL', data.totalRealized, data.totalTarget, totalAch]);
  totalRow.getCell(2).numFmt = RP_FMT;
  totalRow.getCell(3).numFmt = RP_FMT;
  totalRow.getCell(4).numFmt = '0.00';
  styleTotalsRow(ws, totalRow.number);
  return wb;
}

async function buildRoomTypes(q: ExportReportQuery, scope: string[] | undefined, propName: string) {
  const rows = await svc.roomTypesReport({ property_id: q.property_id }, scope);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Tipe Kamar');
  ws.columns = [
    { key: 'roomType', width: 20 },
    { key: 'count', width: 12 },
    { key: 'occupied', width: 12 },
    { key: 'occupancyRate', width: 16 },
    { key: 'revenue', width: 18 },
  ];
  writeHeader(ws, 'Laporan Performa Tipe Kamar', `Properti: ${propName}`, 5);
  const headerRow = ws.addRow(['Tipe Kamar', 'Jumlah', 'Terisi', 'Okupansi (%)', 'Pendapatan (tahun ini)']);
  styleHeaderRow(ws, headerRow.number);
  let totalCount = 0;
  let totalOccupied = 0;
  let totalRevenue = 0;
  for (const r of rows) {
    totalCount += r.count;
    totalOccupied += r.occupied;
    totalRevenue += r.revenue;
    const row = ws.addRow([r.roomType, r.count, r.occupied, r.occupancyRate, r.revenue]);
    row.getCell(4).numFmt = '0.00';
    row.getCell(5).numFmt = RP_FMT;
  }
  const totalRate = totalCount > 0 ? Math.round((totalOccupied / totalCount) * 10000) / 100 : 0;
  const totalRow = ws.addRow(['TOTAL', totalCount, totalOccupied, totalRate, totalRevenue]);
  totalRow.getCell(4).numFmt = '0.00';
  totalRow.getCell(5).numFmt = RP_FMT;
  styleTotalsRow(ws, totalRow.number);
  return wb;
}

async function buildTax(q: ExportReportQuery, scope: string[] | undefined, propName: string) {
  const data = await svc.taxReport({ property_id: q.property_id, year: q.year, rate: q.rate }, scope);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Pajak (PPh)');
  ws.columns = [
    { key: 'month', width: 14 },
    { key: 'grossIncome', width: 22 },
    { key: 'pphEstimate', width: 22 },
  ];
  const ratePct = Math.round(data.rate * 10000) / 100;
  writeHeader(
    ws,
    'Laporan Pajak Sewa (PPh Final 4(2))',
    `Properti: ${propName} · Tahun: ${data.year} · Tarif PPh: ${ratePct}% · Dasar: pendapatan diterima (cash basis)`,
    3,
  );
  const headerRow = ws.addRow(['Bulan', 'Penghasilan Bruto (diterima)', `Estimasi PPh (${ratePct}%)`]);
  styleHeaderRow(ws, headerRow.number);
  for (const r of data.rows) {
    const row = ws.addRow([r.month, r.grossIncome, r.pphEstimate]);
    row.getCell(2).numFmt = RP_FMT;
    row.getCell(3).numFmt = RP_FMT;
  }
  const totalRow = ws.addRow(['TOTAL', data.totalGross, data.totalPph]);
  totalRow.getCell(2).numFmt = RP_FMT;
  totalRow.getCell(3).numFmt = RP_FMT;
  styleTotalsRow(ws, totalRow.number);
  return wb;
}

async function buildRoi(q: ExportReportQuery, scope: string[] | undefined, propName: string) {
  const data = await svc.roiReport({ property_id: q.property_id, year: q.year }, scope);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('ROI');
  ws.columns = [
    { key: 'propertyName', width: 26 },
    { key: 'investmentValue', width: 20 },
    { key: 'revenue', width: 18 },
    { key: 'expense', width: 18 },
    { key: 'netIncome', width: 18 },
    { key: 'roiPercent', width: 14 },
    { key: 'paybackYears', width: 16 },
  ];
  writeHeader(ws, 'Laporan ROI Properti', `Properti: ${propName} · Tahun: ${data.year}`, 7);
  const headerRow = ws.addRow([
    'Properti', 'Nilai Investasi', 'Pendapatan', 'Biaya', 'Laba Bersih', 'ROI (%)', 'Payback (tahun)',
  ]);
  styleHeaderRow(ws, headerRow.number);
  for (const r of data.rows) {
    const row = ws.addRow([
      r.propertyName,
      r.investmentValue ?? '—',
      r.revenue,
      r.expense,
      r.netIncome,
      r.roiPercent ?? '—',
      r.paybackYears ?? '—',
    ]);
    if (r.investmentValue !== null) row.getCell(2).numFmt = RP_FMT;
    row.getCell(3).numFmt = RP_FMT;
    row.getCell(4).numFmt = RP_FMT;
    row.getCell(5).numFmt = RP_FMT;
    if (r.roiPercent !== null) row.getCell(6).numFmt = '0.00';
    if (r.paybackYears !== null) row.getCell(7).numFmt = '0.00';
  }
  const t = data.totals;
  const totalRow = ws.addRow([
    'TOTAL',
    t.investmentValue ?? '—',
    t.revenue,
    t.expense,
    t.netIncome,
    t.roiPercent ?? '—',
    t.paybackYears ?? '—',
  ]);
  if (t.investmentValue !== null) totalRow.getCell(2).numFmt = RP_FMT;
  totalRow.getCell(3).numFmt = RP_FMT;
  totalRow.getCell(4).numFmt = RP_FMT;
  totalRow.getCell(5).numFmt = RP_FMT;
  if (t.roiPercent !== null) totalRow.getCell(6).numFmt = '0.00';
  if (t.paybackYears !== null) totalRow.getCell(7).numFmt = '0.00';
  styleTotalsRow(ws, totalRow.number);
  return wb;
}

// ─────────────────────────── Dispatcher ───────────────────────────
/**
 * Build the requested report's .xlsx workbook and return the buffer + a download filename.
 * Honors the caller's property scope (passed straight through to each report's service fn).
 */
export async function buildReportExcel(
  type: ReportType,
  q: ExportReportQuery,
  scope: string[] | undefined,
): Promise<BuildResult> {
  const propName = await svc.propertyLabel(q.property_id, scope);

  let wb: ExcelJS.Workbook;
  let period: string;
  switch (type) {
    case 'invoices':
      wb = await buildInvoices(q, scope, propName);
      period = `${q.year}-${String(q.month).padStart(2, '0')}`;
      break;
    case 'residents':
      wb = await buildResidents(q, scope, propName);
      period = `${q.year}-${String(q.month).padStart(2, '0')}`;
      break;
    case 'occupancy':
      wb = await buildOccupancy(q, scope, propName);
      period = `${q.months}bln`;
      break;
    case 'revenue':
      wb = await buildRevenue(q, scope, propName);
      period = `${q.year}`;
      break;
    case 'room-types':
      wb = await buildRoomTypes(q, scope, propName);
      period = `${new Date().getFullYear()}`;
      break;
    case 'tax':
      wb = await buildTax(q, scope, propName);
      period = `${q.year}`;
      break;
    case 'roi':
      wb = await buildRoi(q, scope, propName);
      period = `${q.year}`;
      break;
  }

  const buffer = await workbookToBuffer(wb);
  return { buffer, filename: `laporan-${type}-${period}.xlsx` };
}
