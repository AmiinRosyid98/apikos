/**
 * Contract template variable-render helper (PRD §6.15). Mirrors the WhatsApp template `{var}` render
 * approach (src/modules/whatsapp/whatsapp.templates.ts) so the two stay consistent. Placeholders use
 * the {variabel} syntax substituted from resident/room/property context. Unknown/missing variables
 * are left as the literal placeholder so misconfiguration is visible rather than silently empty.
 */

/** All recognized contract placeholder variable names (for documentation/validation/UI hints). */
export const TEMPLATE_VARIABLES = [
  'nama_penyewa',
  'nik',
  'nomor_kamar',
  'nama_kos',
  'alamat',
  'harga_sewa',
  'tanggal_masuk',
  'tanggal_keluar',
  'tanggal_hari_ini',
] as const;

export type ContractVars = Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string>>;

/** Substitute {var} placeholders. Unknown variables left literal (visible misconfiguration). */
export function renderTemplate(body: string, vars: ContractVars): string {
  return body.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = (vars as Record<string, string | undefined>)[key];
    return v !== undefined && v !== null ? v : match;
  });
}

/** Format an IDR amount as e.g. "Rp800.000". */
export function formatRupiah(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString('id-ID')}`;
}

/** Format a Date (or date string) as Indonesian "8 Juni 2026"; null-safe. */
export function formatTanggal(value: Date | string | null | undefined): string {
  if (!value) return '-';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * A sensible Indonesian default contract template (used to seed a tenant default and as the fallback
 * body when no template is configured). Demonstrates every supported placeholder.
 */
export const DEFAULT_CONTRACT_TEMPLATE = {
  name: 'Kontrak Sewa Kamar Kos (Default)',
  body: [
    'SURAT PERJANJIAN SEWA KAMAR KOS',
    '',
    'Pada hari ini, {tanggal_hari_ini}, yang bertanda tangan di bawah ini menyepakati perjanjian sewa kamar kos dengan ketentuan sebagai berikut:',
    '',
    'PIHAK PENYEWA',
    'Nama       : {nama_penyewa}',
    'NIK        : {nik}',
    '',
    'OBJEK SEWA',
    'Nama Kos   : {nama_kos}',
    'Alamat     : {alamat}',
    'Nomor Kamar: {nomor_kamar}',
    '',
    'KETENTUAN SEWA',
    '1. Harga sewa per bulan sebesar {harga_sewa}.',
    '2. Masa sewa dimulai pada {tanggal_masuk} sampai dengan {tanggal_keluar}.',
    '3. Pembayaran sewa dilakukan setiap bulan sesuai tanggal yang disepakati.',
    '4. Penyewa wajib menjaga kebersihan dan ketertiban serta mematuhi peraturan kos.',
    '5. Kerusakan yang disebabkan oleh penyewa menjadi tanggung jawab penyewa.',
    '',
    'Demikian perjanjian ini dibuat dengan sebenarnya untuk dipatuhi oleh kedua belah pihak.',
  ].join('\n'),
};
