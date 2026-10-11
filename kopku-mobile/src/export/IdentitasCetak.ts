/**
 * IDENTITAS CETAK — satu sumber untuk baris penutup SEMUA hasil export
 * PDF & Excel (laporan standar, format contoh Juklat SOM 2025, dokumen
 * berseksi, dokumen akad, dan seluruh sheet Excel).
 *
 *   Dicetak dengan KOPKU Finance · Aplikasi Akuntansi KSP/USP berdasarkan SAK EP
 *
 * CSV sengaja tidak diberi baris ini (data mentah untuk diolah aplikasi lain).
 */
export const NAMA_APLIKASI_CETAK = 'KOPKU Finance';
export const KETERANGAN_APLIKASI_CETAK = 'Aplikasi Akuntansi KSP/USP berdasarkan SAK EP';
export const TEKS_IDENTITAS_CETAK = `Dicetak dengan ${NAMA_APLIKASI_CETAK} · ${KETERANGAN_APLIKASI_CETAK}`;

/** CSS baris identitas cetak — disisipkan ke <style> tiap template HTML. */
export const CSS_IDENTITAS_CETAK = `
  .identitas-cetak { margin-top: 22px; border-top: 0.75px solid #c9d1d9; padding-top: 6px;
    font-family: Helvetica, Arial, sans-serif; font-size: 7.5pt; color: #6b7681; line-height: 1.4;
    break-inside: avoid; page-break-inside: avoid; }
  .identitas-cetak table { width: 100%; border-collapse: collapse; border: none; }
  .identitas-cetak td { border: none; padding: 0; vertical-align: top; font-size: 7.5pt; color: #6b7681; }
  .identitas-cetak td.ic-kanan { text-align: right; white-space: nowrap; padding-left: 12px; }
  .identitas-cetak .ic-nama { font-weight: 700; color: #1B5E20; letter-spacing: 0.2px; }
  .identitas-cetak .ic-tambahan { display: block; margin-top: 1px; }
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Baris identitas cetak: kiri = aplikasi (+ keterangan tambahan opsional),
 * kanan = waktu cetak. `tambahan` sudah berupa teks biasa (di-escape di sini).
 */
export function htmlIdentitasCetak(dicetakPada: string, tambahan?: string | null): string {
  return `<div class="identitas-cetak"><table><tr>
    <td class="ic-kiri">Dicetak dengan <span class="ic-nama">${esc(NAMA_APLIKASI_CETAK)}</span> · ${esc(KETERANGAN_APLIKASI_CETAK)}${
      tambahan ? `<span class="ic-tambahan">${esc(tambahan)}</span>` : ''
    }</td>
    <td class="ic-kanan">Dicetak pada ${esc(dicetakPada)}</td>
  </tr></table></div>`;
}
