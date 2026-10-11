import * as FileSystem from 'expo-file-system/legacy'; // SDK 54: API lama (documentDirectory, getInfoAsync, dst.) sekarang di path /legacy
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx-js-style';
import {
  JenisSheetImport,
  RingkasanParse,
  SheetMentah,
  parseBerkasDataAwal,
  cocokkanJenisSheet,
  cocokkanSheetSaldoAwalAkun,
  normalkanSelPersen,
  type RekeningBankAktif,
} from '@/import/ExcelDataAwalParser';
import type { JenisTemplateDataAwal } from '@/import/TemplateDataAwal';
import { bangunWorkbookTemplate } from '@/import/TemplateWorkbook';
import { getDb } from '@/database/db';
import { muatSidikTercatat } from '@/import/RiwayatImportRepository';
import { hitungSidikBerkas, type SidikTercatat } from '@/import/SidikImport';
import {
  daftarRiwayatImport,
  logRiwayatImport,
  jumlahRiwayatImport,
} from '@/import/RiwayatImportRepository';
import type { BarisLogRiwayat, RingkasanRiwayatImport } from '@/import/RiwayatImportPlan';

// RC-S106 — diteruskan supaya pemanggil lama (layar & test) tidak perlu
// tahu bahwa penyusunnya pindah modul.
export { bangunWorkbookTemplate };

/**
 * ImportDataAwalService — URUSAN BERKAS untuk Import Data Awal: membuat
 * & membagikan template Excel, memilih berkas dari perangkat, dan
 * membacanya menjadi pratinjau.
 *
 * EKSEKUSI ke database ADA DI MODUL LAIN
 * (`@/import/EksekusiImportDataAwal`) karena berkas ini mengimpor
 * `expo-file-system`/`expo-document-picker`/`expo-sharing`/`xlsx` yang
 * tidak dapat dimuat di lingkungan test — lihat komentar di modul itu.
 * Layar mengimpor keduanya; `jalankanImportDataAwal` juga diteruskan di
 * bagian bawah berkas ini supaya pemanggil tidak perlu tahu pemisahan
 * teknis tersebut.
 */

const IMPORT_DIR = `${FileSystem.documentDirectory}import/`;
const NAMA_FILE_TEMPLATE = 'Template-Import-Data-Awal-Koperasi.xlsx';
/** RC-S133.4.6 — template terpisah untuk pilihan "Transaksi baru". */
const NAMA_FILE_TEMPLATE_TRANSAKSI_BARU = 'Template-Import-Transaksi-Baru-Koperasi.xlsx';

async function pastikanImportDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(IMPORT_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(IMPORT_DIR, { intermediates: true });
}

// ===========================================================================
// TEMPLATE
// ===========================================================================

export interface BerkasTemplate {
  fileName: string;
  uri: string;
}

/** Tulis template ke penyimpanan aplikasi, lalu (bila tersedia) buka dialog bagikan/simpan. */
export async function unduhTemplateDataAwal(jenis: JenisTemplateDataAwal = 'SALDO_LAMA'): Promise<BerkasTemplate> {
  await pastikanImportDir();
  const b64 = XLSX.write(bangunWorkbookTemplate(jenis), { type: 'base64', bookType: 'xlsx', compression: true });
  const namaBerkas = jenis === 'TRANSAKSI_BARU' ? NAMA_FILE_TEMPLATE_TRANSAKSI_BARU : NAMA_FILE_TEMPLATE;
  const uri = `${IMPORT_DIR}${namaBerkas}`;
  await FileSystem.writeAsStringAsync(uri, b64, { encoding: FileSystem.EncodingType.Base64 });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dialogTitle: 'Simpan Template Import Data Awal',
      UTI: 'com.microsoft.excel.xlsx',
    });
  }
  return { fileName: namaBerkas, uri };
}

// ===========================================================================
// PEMBACAAN BERKAS
// ===========================================================================

// RC-S108 — `cocokkanJenisSheet` DIPINDAH ke ExcelDataAwalParser agar
// dapat diuji (berkas ini mengimpor modul native, jadi tidak pernah
// tersentuh test). Diteruskan di sini supaya pemanggil lama tidak
// berubah.
export { cocokkanJenisSheet };

/**
 * Ubah workbook menjadi array baris per jenis sheet.
 *
 * `raw: true` + `defval: null`: nilai sel diambil APA ADANYA (tanggal
 * tetap berupa angka serial, nominal tetap berupa angka) dan sel kosong
 * menjadi `null`, sehingga posisi kolom tidak bergeser pada baris yang
 * sebagian selnya kosong. Penafsirannya diserahkan sepenuhnya kepada
 * `ExcelDataAwalParser` — satu tempat, bisa diuji.
 */
export function workbookKeSheetMentah(wb: XLSX.WorkBook): SheetMentah {
  const hasil: SheetMentah = {};
  for (const nama of wb.SheetNames) {
    // RC-S133.4.6 — sheet "7. Saldo Awal Akun" diperiksa lebih dulu.
    if (cocokkanSheetSaldoAwalAkun(nama)) {
      const wsA = wb.Sheets[nama];
      if (wsA && !hasil.SALDO_AWAL_AKUN) {
        hasil.SALDO_AWAL_AKUN = XLSX.utils.sheet_to_json<unknown[]>(normalkanSelPersen(wsA), { header: 1, raw: true, defval: null });
      }
      continue;
    }
    const jenis = cocokkanJenisSheet(nama);
    if (!jenis || hasil[jenis]) continue;
    const ws = wb.Sheets[nama];
    if (!ws) continue;
    // RC-S133.6 (AUDIT B-2) — sel berformat persen dibaca sebagai teks persennya.
    hasil[jenis] = XLSX.utils.sheet_to_json<unknown[]>(normalkanSelPersen(ws), { header: 1, raw: true, defval: null });
  }
  return hasil;
}

/** Pilih berkas Excel dari penyimpanan perangkat. `null` bila dibatalkan pengguna. */
export async function pilihBerkasExcel(): Promise<{ uri: string; nama: string } | null> {
  const hasil = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (hasil.canceled || !hasil.assets?.[0]) return null;
  const aset = hasil.assets[0];
  return { uri: aset.uri, nama: aset.name ?? 'berkas.xlsx' };
}

/**
 * PRATINJAU — baca & periksa berkas TANPA menulis apa pun ke database.
 * Inilah yang membuat import aman: seluruh kesalahan ketahuan lebih dulu.
 */
export async function pratinjauBerkasDataAwal(uri: string): Promise<RingkasanParse> {
  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const wb = XLSX.read(b64, { type: 'base64' });
  return parseBerkasDataAwal(workbookKeSheetMentah(wb));
}

// ===========================================================================
// PENERUSAN
// ===========================================================================
//
// Layar cukup mengimpor dari satu tempat; pemisahan teknis (native vs
// dapat-diuji) tidak perlu merembet ke lapisan UI.
export {
  jalankanImportDataAwal,
  type BerhasilImport,
  type GagalImport,
  type HasilImportDataAwal,
  type HasilPerSheet,
  type OpsiImport,
} from '@/import/EksekusiImportDataAwal';
export { JUDUL_SHEET, LABEL_SHEET } from '@/import/ExcelDataAwalParser';
export type { RingkasanParse } from '@/import/ExcelDataAwalParser';

// RC-S100 — RIWAYAT IMPORT. Aturan penyajiannya (status, label, filter)
// ada di modul murni `RiwayatImportPlan`, pembacaan database di
// `RiwayatImportRepository`; keduanya diteruskan dari sini supaya layar
// tetap mengimpor dari satu tempat.
export {
  LABEL_STATUS_RIWAYAT,
  KETERANGAN_STATUS_RIWAYAT,
  LABEL_FILTER_LOG,
  saringLogRiwayat,
  turunkanStatusRiwayat,
  type BarisLogRiwayat,
  type FilterLogRiwayat,
  type RingkasanRiwayatImport,
  type StatusRiwayatImport,
} from '@/import/RiwayatImportPlan';

/** Daftar riwayat import (terbaru lebih dulu) — memakai koneksi database aplikasi. */
export async function ambilDaftarRiwayatImport(batas?: number): Promise<RingkasanRiwayatImport[]> {
  return daftarRiwayatImport(await getDb(), batas);
}

/** Seluruh baris log satu riwayat import (berhasil & gagal). */
export async function ambilLogRiwayatImport(riwayatId: string): Promise<BarisLogRiwayat[]> {
  return logRiwayatImport(await getDb(), riwayatId);
}

/**
 * RC-S133.6.1 — rekening bank aktif, untuk pemeriksaan kolom "Rekening
 * Bank" di pratinjau (`periksaSebelumImport`). Kueri sama dengan eksekutor.
 */
export async function ambilRekeningBankAktif(): Promise<RekeningBankAktif[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; nama_bank: string; nomor_rekening: string }>(
    `SELECT id, nama_bank, nomor_rekening FROM bank_account WHERE aktif = 1 ORDER BY id`
  );
  return rows.map((r) => ({ id: r.id, namaBank: r.nama_bank, nomorRekening: r.nomor_rekening }));
}

/** RC-S133.6.1 — NIK anggota yang sudah ada (pemeriksaan pratinjau `periksaSebelumImport`). */
export async function ambilNikTerdaftar(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ nik: string }>(`SELECT nik FROM anggota WHERE nik IS NOT NULL AND TRIM(nik) <> ''`);
  return rows.map((r) => r.nik);
}

/**
 * RC-S133.6.2 — sidik baris yang sudah tersimpan untuk berkas yang sedang
 * dipratinjau (pemeriksaan import ganda; lihat SidikImport).
 */
export async function ambilSidikTercatat(ringkasan: RingkasanParse): Promise<Map<string, SidikTercatat>> {
  const sb = hitungSidikBerkas(ringkasan.hasil);
  return muatSidikTercatat(await getDb(), sb.perBaris.map((b) => b.sidik));
}

/** RC-S133.6.2 — anggota yang sudah ada (untuk peringatan anggota tanpa NIK yang mirip). */
export async function ambilAnggotaTerdaftar(): Promise<{ nomorAnggota: string; nama: string; tanggalBergabung: string | null }[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ nomor_anggota: string; nama_lengkap: string; tanggal_bergabung: string | null }>(
    `SELECT nomor_anggota, nama_lengkap, tanggal_bergabung FROM anggota`
  );
  return rows.map((r) => ({ nomorAnggota: r.nomor_anggota, nama: r.nama_lengkap, tanggalBergabung: r.tanggal_bergabung }));
}

/** Jumlah riwayat tersimpan — dipakai lencana pada ikon riwayat. */
export async function ambilJumlahRiwayatImport(): Promise<number> {
  return jumlahRiwayatImport(await getDb());
}
