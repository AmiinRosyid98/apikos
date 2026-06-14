import type { WaTemplateType } from '@prisma/client';

/**
 * Default Indonesian WhatsApp templates per type (PRD §6.9). Used to seed sensible defaults and as
 * the fallback body when a tenant has not configured a template for a type. Placeholders use the
 * {variabel} syntax rendered by `renderTemplate`:
 *   {nama_penyewa} {nomor_kamar} {jumlah_tagihan} {jatuh_tempo} {nama_kos}
 */
export const DEFAULT_TEMPLATES: Record<
  Exclude<WaTemplateType, 'custom'>,
  { name: string; body: string }
> = {
  invoice_new: {
    name: 'Tagihan Baru',
    body:
      'Halo {nama_penyewa}, tagihan sewa kamar {nomor_kamar} di {nama_kos} sebesar ' +
      '{jumlah_tagihan} telah terbit. Mohon dibayar sebelum {jatuh_tempo}. Terima kasih.',
  },
  reminder_due: {
    name: 'Pengingat Jatuh Tempo',
    body:
      'Halo {nama_penyewa}, ini pengingat tagihan sewa kamar {nomor_kamar} di {nama_kos} sebesar ' +
      '{jumlah_tagihan} yang jatuh tempo pada {jatuh_tempo}. Mohon segera dibayar. Terima kasih.',
  },
  reminder_overdue: {
    name: 'Pengingat Tunggakan',
    body:
      'Halo {nama_penyewa}, tagihan sewa kamar {nomor_kamar} di {nama_kos} sebesar ' +
      '{jumlah_tagihan} telah melewati jatuh tempo ({jatuh_tempo}). Mohon segera melakukan ' +
      'pembayaran untuk menghindari denda. Terima kasih.',
  },
  payment_received: {
    name: 'Pembayaran Diterima',
    body:
      'Halo {nama_penyewa}, pembayaran sewa kamar {nomor_kamar} di {nama_kos} sebesar ' +
      '{jumlah_tagihan} telah kami terima. Terima kasih atas pembayaran Anda.',
  },
  contract_expiry: {
    name: 'Kontrak Akan Berakhir',
    body:
      'Halo {nama_penyewa}, masa sewa kamar {nomor_kamar} di {nama_kos} akan berakhir pada ' +
      '{jatuh_tempo}. Mohon konfirmasi perpanjangan sewa. Terima kasih.',
  },
  broadcast: {
    name: 'Pengumuman',
    body: 'Halo {nama_penyewa}, ada pengumuman dari pengelola {nama_kos}: ',
  },
};

/** All recognized placeholder variable names (for documentation/validation). */
export const TEMPLATE_VARIABLES = [
  'nama_penyewa',
  'nomor_kamar',
  'jumlah_tagihan',
  'jatuh_tempo',
  'nama_kos',
] as const;

export type TemplateVars = Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string>>;

/**
 * Substitute {var} placeholders in a template body. Unknown/missing variables are left as the
 * literal placeholder so misconfiguration is visible rather than silently producing empty text.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
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
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}
