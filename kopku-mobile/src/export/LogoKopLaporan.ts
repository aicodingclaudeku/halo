import * as FileSystem from 'expo-file-system/legacy'; // SDK 54: API lama ada di path /legacy

/**
 * RC-S100 — MEMBACA LOGO UNTUK KOP LAPORAN.
 *
 * ============================================================
 * KENAPA TERPISAH DARI `LogoKoperasiService`
 * ============================================================
 * `LogoKoperasiService` memakai `expo-image-picker` untuk memilih gambar
 * dari galeri. Paket itu di-ship sebagai ESM murni dan tidak punya
 * transformer di lingkungan test, sehingga BERKAS APA PUN yang
 * mengimpornya tidak bisa dimuat oleh Jest.
 *
 * Versi pertama perubahan ini menaruh pembaca logo di berkas yang sama,
 * lalu `ExportService` mengimpornya — akibatnya dua suite yang sama sekali
 * tidak berhubungan (`ExportService.test.ts` dan `AkadUlangRcS82.test.ts`)
 * GAGAL DIMUAT. Itu bukan sekadar masalah test: lapisan export memang
 * tidak punya urusan dengan pemilih gambar, jadi ketergantungannya salah
 * tempat sejak awal.
 *
 * Berkas ini karena itu HANYA menyentuh `expo-file-system` (yang sudah
 * dipetakan ke mock di jest.config.js), konvensi yang sama dengan
 * `BackupValidator` vs `BackupService` dan `EksekusiImportDataAwal` vs
 * `ImportDataAwalService`.
 */

/** Ekstensi dari URI, dibatasi ke format gambar yang pasti bisa dirender. */
export function ekstensiLogo(uri: string): 'png' | 'jpg' {
  return /\.(jpe?g)($|\?)/i.test(uri) ? 'jpg' : 'png';
}

/**
 * Baca logo sebagai `data:` URI base64.
 *
 * Dipakai export PDF: HTML-nya dirender `expo-print` di WebView yang
 * TIDAK punya akses ke `file://` milik aplikasi, sehingga `<img src>`
 * dengan URI berkas akan tampil kosong. Menyisipkannya sebagai data URI
 * membuat gambarnya menjadi bagian dari dokumen itu sendiri.
 *
 * Mengembalikan `null` — TIDAK melempar — bila logo belum diatur, tidak
 * ada, atau tidak terbaca: laporan wajib tetap bisa dicetak tanpa logo
 * (kebijakan yang sudah tertulis di layar Identitas Koperasi).
 */
export async function muatLogoSebagaiDataUri(logoUri: string | null | undefined): Promise<string | null> {
  if (!logoUri) return null;
  try {
    const info = await FileSystem.getInfoAsync(logoUri);
    if (!info.exists) return null;
    const b64 = await FileSystem.readAsStringAsync(logoUri, { encoding: FileSystem.EncodingType.Base64 });
    if (!b64) return null;
    const mime = ekstensiLogo(logoUri) === 'jpg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}
