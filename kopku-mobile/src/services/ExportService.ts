import * as FileSystem from 'expo-file-system/legacy'; // SDK 54: API lama (documentDirectory, getInfoAsync, dst.) sekarang di path /legacy
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx-js-style';
import { getDb } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { DataLaporanExport, FormatExport } from '@/export/ExportTypes';
import { buildCsv } from '@/export/CsvExporter';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import { muatLogoSebagaiDataUri } from '@/export/LogoKopLaporan';
import { buildSheetSeksi } from '@/export/ExcelSeksiBuilder';
import { alamatSel, bangunSheetLaporan, gayaiSheetSeksi, type SheetExcelLaporan } from '@/export/ExcelLaporanBuilder';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { toTanggalLokal } from '@/utils/tanggal';
import { DokumenAkadUlang } from '@/export/AkadUlangDocumentBuilder';
import { buildAkadUlangHtml } from '@/export/AkadUlangHtmlBuilder';
import { DokumenAkadAwal } from '@/export/AkadAwalDocumentBuilder';
import { buildAkadAwalHtml } from '@/export/AkadAwalHtmlBuilder';
import { getWaktuSekarang } from '@/services/DevClockService';
import { getSusunanPengurusInti, JABATAN_PENGURUS_INTI, LABEL_JABATAN_PENGURUS } from '@/services/KoperasiMasterService';

/**
 * Export laporan ke PDF/Excel/CSV (PRD §36, fase 6). HANYA MEMBACA data
 * yang sudah diambil layar pemanggil dari repository/service yang ada
 * (`DataLaporanExport`) — tidak pernah menulis/mengubah apapun ke
 * database (fase 6: "jangan mengubah data database saat export").
 *
 * File disimpan di folder privat aplikasi (`documentDirectory/exports/`)
 * — pola & alasan yang SAMA dengan `BackupService.ts` (fase 5): tidak
 * butuh permission READ/WRITE_EXTERNAL_STORAGE, dibagikan keluar lewat
 * `expo-sharing` (share sheet Android/iOS bawaan, kompatibel dengan
 * Android modern tanpa dialog permission runtime).
 */

const EXPORT_DIR = `${FileSystem.documentDirectory}exports/`;

export interface ExportedFile {
  fileName: string;
  uri: string;
  format: FormatExport;
}

async function ensureExportDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(EXPORT_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
  }
}

/**
 * Bersihkan nama file dari karakter yang tidak aman di filesystem
 * Android/iOS (update pasca-Phase 18/19, permintaan pengguna §V —
 * bugfix export Bukti Bayar Piutang & audit menyeluruh). Dipakai
 * SECARA GLOBAL di `buildFileName()` di bawah — jadi berlaku untuk
 * SEMUA laporan, bukan cuma Bukti Bayar Piutang. Risiko nyata (bukan
 * cuma teoretis): beberapa `namaFileDasar` di `ReportTableBuilders.ts`
 * memuat data yang BISA diubah user (mis. nama akun lewat
 * `AccountRepository.updateAccount()` — Buku Besar memakai
 * `buku-besar-${namaAkun}`), jadi karakter seperti `/` bisa masuk ke
 * nama file kalau tidak dibersihkan.
 */
export function sanitizeFileNamePart(s: string): string {
  const dibersihkan = (s || 'laporan')
    .replace(/[\/\\:*?"<>|]+/g, '-') // karakter terlarang filesystem
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return dibersihkan || 'laporan';
}

/** Nama file otomatis dengan tanggal — fase 6: "nama file otomatis dengan tanggal/periode". */
function buildFileName(namaFileDasar: string, ekstensi: string): string {
  // RC-S95 — stempel nama file = jam aplikasi, konsisten dengan isi laporan.
  // (Nama file BACKUP sengaja tetap jam asli — lihat BackupService.)
  const now = getWaktuSekarang();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
  return `${sanitizeFileNamePart(namaFileDasar)}_${stamp}.${ekstensi}`;
}

/** Export ke CSV — data apa adanya, format Rupiah pada kolom nominal. */
export async function exportToCsv(data: DataLaporanExport): Promise<ExportedFile> {
  await ensureExportDir();
  const csv = buildCsv(data);
  const fileName = buildFileName(data.namaFileDasar, 'csv');
  const uri = `${EXPORT_DIR}${fileName}`;
  await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
  return { fileName, uri, format: 'CSV' };
}

/**
 * Export ke PDF lewat expo-print (render HTML -> PDF). File hasil
 * printToFileAsync ada di cache sementara, dipindah ke folder exports/
 * privat aplikasi supaya konsisten dengan format lain & riwayat backup.
 */
export async function exportToPdf(data: DataLaporanExport): Promise<ExportedFile> {
  await ensureExportDir();
  const html = buildReportHtml(data);
  // RC-S83 — dokumen berseksi dicetak A4 portrait (sama dengan dokumen
  // kontrak). Laporan tabel lama tetap memakai ukuran default.
  const { uri: tempUri } = await Print.printToFileAsync(
    data.seksi && data.seksi.length > 0 ? { html, base64: false, ...UKURAN_A4_PORTRAIT } : { html, base64: false }
  );

  const fileName = buildFileName(data.namaFileDasar, 'pdf');
  const destUri = `${EXPORT_DIR}${fileName}`;
  await FileSystem.moveAsync({ from: tempUri, to: destUri });

  return { fileName, uri: destUri, format: 'PDF' };
}

/**
 * Export ke Excel (.xlsx) lewat SheetJS. Sheet data + baris ringkasan
 * di bawahnya; baris metadata koperasi/judul/periode ditulis sebagai
 * baris pertama (mirip CSV) supaya informasi koperasi & periode ikut
 * terbawa di file Excel juga (fase 6).
 */
/**
 * Terjemahkan tata letak murni (`ExcelLaporanBuilder`) menjadi worksheet
 * `xlsx-js-style`: nilai, gaya, format angka, sel gabungan, lebar kolom,
 * tinggi baris, dan filter otomatis. Tidak ada keputusan tampilan di sini.
 */
function worksheetDariTataLetak(spek: SheetExcelLaporan): XLSX.WorkSheet {
  const aoa = spek.sel.map((row) => (row ?? []).map((c) => (c ? c.v : '')));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  spek.sel.forEach((row, r) =>
    (row ?? []).forEach((c, ci) => {
      if (!c) return;
      const alamat = alamatSel(r, ci);
      const sel = (ws[alamat] ?? { t: 's', v: '' }) as XLSX.CellObject & { s?: unknown };
      if (c.s) sel.s = c.s;
      if (c.z) sel.z = c.z;
      ws[alamat] = sel;
    })
  );
  ws['!merges'] = spek.merges;
  ws['!cols'] = spek.lebarKolom.map((wch) => ({ wch }));
  ws['!rows'] = Array.from({ length: spek.sel.length }, (_, r) => spek.tinggiBaris[r] ?? {});
  if (spek.autofilter) ws['!autofilter'] = { ref: spek.autofilter };
  return ws;
}

function tanggalCetakExcel(): string {
  const sekarang = getWaktuSekarang();
  const jamMenit = `${String(sekarang.getHours()).padStart(2, '0')}.${String(sekarang.getMinutes()).padStart(2, '0')}`;
  return `${formatTanggalIndonesia(toTanggalLokal(sekarang))} pukul ${jamMenit}`;
}

export async function exportToExcel(data: DataLaporanExport): Promise<ExportedFile> {
  await ensureExportDir();

  // Tampilan Excel profesional: kop, bar judul kolom hijau, nominal sebagai
  // angka berformat ribuan, hierarki laporan, ringkasan & catatan bergaya.
  // RC-S83 — dokumen berseksi (mis. Detail Anggota) memakai gaya yang sama.
  const spek =
    data.seksi && data.seksi.length > 0
      ? gayaiSheetSeksi(buildSheetSeksi(data), data.judulLaporan, tanggalCetakExcel())
      : bangunSheetLaporan(data, tanggalCetakExcel());

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheetDariTataLetak(spek), spek.namaSheet);
  const base64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });

  const fileName = buildFileName(data.namaFileDasar, 'xlsx');
  const uri = `${EXPORT_DIR}${fileName}`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });

  return { fileName, uri, format: 'EXCEL' };
}

/**
 * Poin 13/14 — isi nama Ketua/Sekretaris/Bendahara untuk blok tanda tangan
 * laporan keuangan dari data Pengurus (`koperasi_personel`) yang menjabat
 * pada tanggal acuan laporan. HANYA MEMBACA. Gagal membaca tidak
 * menggagalkan export: blok tetap dicetak dengan jabatan & ruang tanda
 * tangan, nama dibiarkan kosong (tidak pernah nama karangan).
 */
async function isiPenandaTanganLaporan(data: DataLaporanExport): Promise<DataLaporanExport> {
  const lk = data.laporanKeuangan;
  if (!lk || (lk.penandaTangan && lk.penandaTangan.length > 0)) return data;
  let susunan: Awaited<ReturnType<typeof getSusunanPengurusInti>> | null = null;
  try {
    susunan = await getSusunanPengurusInti(lk.tanggalAcuan);
  } catch {
    susunan = null;
  }
  const penandaTangan = JABATAN_PENGURUS_INTI.map((j) => ({
    jabatan: LABEL_JABATAN_PENGURUS[j],
    nama: susunan?.[j]?.nama ?? null,
  }));
  return { ...data, laporanKeuangan: { ...lk, penandaTangan } };
}

/** Titik masuk tunggal — dipanggil UI berdasarkan format yang dipilih user (fase 8: proteksi izin export). */
export async function exportLaporan(
  actingUserId: string,
  data: DataLaporanExport,
  format: FormatExport,
  /**
   * RC-S100 — URI berkas logo koperasi (`koperasi.logo_uri`), opsional.
   *
   * Diberikan pemanggil (ExportButton) dan dibaca dari berkas DI SINI,
   * bukan di builder: builder laporan wajib tetap murni tanpa I/O.
   * Hanya berpengaruh pada PDF — Excel & CSV tidak punya kop bergambar,
   * dan menyisipkan base64 ke dalam sel justru merusak datanya.
   */
  logoUri?: string | null
): Promise<ExportedFile> {
  const db = await getDb();
  await requirePermission(db, actingUserId, 'export', 'export');

  if (format === 'PDF') {
    // Gagal membaca logo TIDAK menggagalkan export: `muatLogoSebagaiDataUri`
    // mengembalikan null dan laporan dicetak tanpa logo — kebijakan yang
    // sudah tertulis di layar Identitas Koperasi ("laporan tetap dapat
    // dicetak tanpa logo").
    const logoDataUri = await muatLogoSebagaiDataUri(logoUri);
    const denganTtd = await isiPenandaTanganLaporan(data);
    return exportToPdf(logoDataUri ? { ...denganTtd, logoDataUri } : denganTtd);
  }
  if (format === 'EXCEL') return exportToExcel(data);
  return exportToCsv(data);
}

/** A4 portrait dalam point (72 PPI) + margin iOS ~18/16 mm — dipakai HANYA dokumen akad ulang. */
export const UKURAN_A4_PORTRAIT = {
  width: 595,
  height: 842,
  margins: { top: 51, bottom: 45, left: 51, right: 45 },
} as const;

/**
 * RC-S82 — export PDF "Dokumen Akad Ulang Pinjaman" (ADDITIVE).
 *
 * Jalur TERPISAH dari `exportLaporan()` karena dokumen akad ulang bukan
 * laporan tabel: ia memakai renderer HTML khususnya sendiri
 * (`buildAkadUlangHtml`). Pipeline PDF/Excel/CSV laporan existing TIDAK
 * berubah sama sekali.
 *
 * Izin memakai mekanisme yang SAMA dengan seluruh export lain —
 * `requirePermission(db, userId, 'export', 'export')` — dan dicek
 * SEBELUM file apa pun dibuat. Hanya MEMBACA view model yang sudah
 * dibangun; tidak pernah menulis ke database.
 */
export async function exportDokumenAkadUlangPdf(actingUserId: string, dokumen: DokumenAkadUlang): Promise<ExportedFile> {
  return cetakDokumenKontrakPdf(actingUserId, () => buildAkadUlangHtml(dokumen), dokumen.namaFileDasar);
}

/**
 * RC-S82 (lanjutan) — export PDF "Dokumen Akad Pinjaman" (akad AWAL),
 * tersedia TANPA akad ulang. Jalur, izin, dan ukuran kertas identik
 * dengan dokumen akad ulang.
 */
export async function exportDokumenAkadAwalPdf(actingUserId: string, dokumen: DokumenAkadAwal): Promise<ExportedFile> {
  return cetakDokumenKontrakPdf(actingUserId, () => buildAkadAwalHtml(dokumen), dokumen.namaFileDasar);
}

/**
 * RC-S128 — cetak dokumen HTML (bukti penempatan / pencairan simpanan
 * berjangka) lewat jalur cetak dokumen kontrak yang SAMA: izin `export`
 * dicek sebelum file dibuat, kertas A4, tidak ada tulis ke database.
 */
export async function exportDokumenHtmlPdf(actingUserId: string, bangunHtml: () => string, namaFileDasar: string): Promise<ExportedFile> {
  return cetakDokumenKontrakPdf(actingUserId, bangunHtml, namaFileDasar);
}

/**
 * Jalur cetak bersama dokumen kontrak. Izin `export` diperiksa SEBELUM
 * HTML dibangun atau file apa pun dibuat; tidak ada tulis ke database.
 */
async function cetakDokumenKontrakPdf(actingUserId: string, bangunHtml: () => string, namaFileDasar: string): Promise<ExportedFile> {
  const db = await getDb();
  await requirePermission(db, actingUserId, 'export', 'export');

  await ensureExportDir();
  const html = bangunHtml();
  // A4 portrait eksplisit: default expo-print adalah US Letter (612x792).
  // `margins` hanya dipakai iOS; Android memakai `@page` di CSS dokumen.
  const { uri: tempUri } = await Print.printToFileAsync({ html, base64: false, ...UKURAN_A4_PORTRAIT });

  const fileName = buildFileName(namaFileDasar, 'pdf');
  const destUri = `${EXPORT_DIR}${fileName}`;
  await FileSystem.moveAsync({ from: tempUri, to: destUri });

  return { fileName, uri: destUri, format: 'PDF' };
}

/** Bagikan file hasil export lewat share sheet Android/iOS bawaan. */
export async function shareExportedFile(file: ExportedFile): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Fitur berbagi file tidak tersedia di perangkat ini.');
  }
  const mimeType =
    file.format === 'PDF'
      ? 'application/pdf'
      : file.format === 'EXCEL'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv';
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: `Bagikan ${file.fileName}` });
}
