import { NAMA_BULAN } from '@/utils/reportPeriod';

/**
 * TEKS KELUARAN PDF (MURNI, string in -> string out).
 * ============================================================
 * Dipakai HANYA oleh renderer HTML->PDF (`HtmlReportBuilder`,
 * `DokumenSeksiHtml`). CSV/Excel, layar, dan service TIDAK melewati
 * modul ini, sehingga data & logika akuntansi tidak berubah.
 *
 *  1. Branding standar ("SAK EP", "SAK Entitas Privat") tidak dicetak
 *     di PDF. Logika SAK EP di service tetap utuh — yang dibersihkan
 *     hanya teks keluarannya.
 *  2. Tanggal ISO (YYYY-MM-DD) di dalam teks dicetak "D MMMM YYYY",
 *     mis. "4 Oktober 2026". Tanggal yang menempel pada kode/nomor
 *     dokumen (mis. "PJM-2026-01-15-001") TIDAK diubah.
 */

const FRASA_PENGGANTI = 'standar akuntansi keuangan yang berlaku';

export function hapusLabelStandarAkuntansi(teks: string): string {
  return teks
    // "(SAK EP)", "(SAK EP Bab 17)", "(MODEL ... SAK EP 16)" -> dihapus beserta spasinya
    .replace(/\s*\(\s*SAK EP(?:\s+Bab)?(?:\s+\d+)?\s*\)/g, '')
    // "SAK Entitas Privat" -> frasa netral
    .replace(/SAK Entitas Privat/g, FRASA_PENGGANTI)
    // sisa "SAK EP" / "SAK EP Bab 16" yang tidak dalam kurung
    .replace(/SAK EP(?:\s+Bab)?(?:\s+\d+)?/g, FRASA_PENGGANTI)
    .replace(/[ \t]{2,}/g, ' ');
}

export function formatTanggalIsoDalamTeks(teks: string): string {
  return teks.replace(/(^|[^\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g, (asli, awal: string, y: string, m: string, d: string) => {
    const bulan = Number(m);
    const hari = Number(d);
    if (bulan < 1 || bulan > 12 || hari < 1 || hari > 31) return asli;
    return `${awal}${hari} ${NAMA_BULAN[bulan - 1]} ${y}`;
  });
}

/** Satu pintu untuk seluruh teks yang dicetak ke PDF laporan. */
export function teksPdf(teks: string): string {
  return formatTanggalIsoDalamTeks(hapusLabelStandarAkuntansi(teks));
}
