import {
  BarisBerjangka,
  BarisPinjaman,
  BarisSimpanan,
  JenisSheetImport,
  LABEL_SHEET,
  RingkasanParse,
  URUTAN_PROSES,
  BarisAset,
  BarisJasa,
  BarisSaldoAwalAkun,
  pilihRekeningBankImport,
} from '@/import/ExcelDataAwalParser';
import { jalankanMigrasiBerjangka, KETERBATASAN_SALDO_AWAL_BERJANGKA } from '@/import/EksekusiMigrasiBerjangka';
import { PEMETAAN_POS, type PosSaldoAwalOtomatis } from '@/import/SaldoAwalOtomatisPlan';
import { tambahSaldoAwalAkun, aturBagianTunaiSaldoAwal } from '@/services/SaldoAwalAkunService';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import {
  simpanJasaDataAwal,
  hariSebelum,
  rekonsiliasiJasaDataAwal,
  type RekonsiliasiJasaDataAwal,
} from '@/services/PartisipasiDataAwalService';
import { createAnggota } from '@/repositories/AnggotaRepository';
import { catatDataAwalSimpanan } from '@/services/SimpananService';
import {
  jalankanMigrasiSimpanan,
  KETERBATASAN_SALDO_AWAL_SIMPANAN,
} from '@/import/EksekusiMigrasiSimpanan';
import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran, batalkanPinjaman } from '@/services/PinjamanService';
import type * as SQLite from 'expo-sqlite';
import type { Rupiah } from '@/utils/money';
import { getDb } from '@/database/db';
import {
  catatRiwayatImport,
  catatSidikBaris,
  muatSidikTercatat,
  tautkanSidikKeRiwayat,
} from '@/import/RiwayatImportRepository';
import { hitungSidikBerkas, kunciSidik, type JenisSidik, type SidikTercatat } from '@/import/SidikImport';
import {
  jalankanMigrasiPinjaman,
  rekonsiliasiUlangMigrasi,
  ValidasiMigrasiGagalError,
  type HasilMigrasiPinjaman,
} from '@/import/EksekusiMigrasiPinjaman';
import type { BarisMigrasiPinjaman } from '@/import/MigrasiPinjamanPlan';
import {
  jalankanMigrasiAset,
  hitungHasilAset,
  ValidasiMigrasiAsetGagalError,
  type HasilMigrasiAset,
} from '@/import/EksekusiMigrasiAset';
import { isiSaldoAwalOtomatis, journalIdSaldoAwal } from '@/import/EksekusiSaldoAwalOtomatis';
import type { TotalPerPos, HasilSaldoAwalOtomatis } from '@/import/SaldoAwalOtomatisPlan';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  lengkapiBarisMigrasi,
  pinjamanSudahTidakBersaldo,
  PESAN_SUDAH_LUNAS,
  KETERBATASAN_TURUNAN,
  type HasilTurunanMigrasi,
  type KolomDiturunkan,
} from '@/import/TurunanMigrasiPinjaman';

/**
 * EksekusiImportDataAwal — MENJALANKAN import data awal ke database.
 *
 * ============================================================
 * KENAPA TERPISAH DARI `ImportDataAwalService`
 * ============================================================
 * Berkas ini SENGAJA tidak menyentuh `expo-file-system`,
 * `expo-document-picker`, `expo-sharing`, maupun `xlsx`. Modul-modul itu
 * di-ship sebagai ESM murni dan tidak punya transformer di lingkungan
 * test, sehingga berkas apa pun yang mengimpornya TIDAK BISA diimpor
 * oleh test (alasan identik dengan `@/backup/BackupValidator` yang
 * dipisah dari `BackupService` — lihat HardeningRcS51).
 *
 * Karena bagian INILAH yang menulis jurnal & saldo koperasi, bagian ini
 * yang paling wajib diuji secara FUNGSIONAL, bukan struktural. Pemisahan
 * ini membuatnya bisa dijalankan sungguhan di atas database uji
 * (`ImportDataAwalRcS96`). Yang tinggal di `ImportDataAwalService` hanya
 * urusan berkas: membuat template, memilih berkas, membacanya.
 *
 * ============================================================
 * TIDAK ADA MESIN AKUNTANSI BARU DI BERKAS INI
 * ============================================================
 * Setiap baris Excel dieksekusi lewat service yang SUDAH ADA dan sudah
 * teruji:
 *
 *   Anggota    -> `createAnggota()`
 *   Simpanan   -> `catatDataAwalSimpanan()`        (Pokok+Wajib+Sukarela, satu jurnal)
 *   Berjangka  -> `setorSimpananBerjangka()`
 *   Pinjaman   -> `ajukanPinjaman()` + `cairkanPinjaman()` + `bayarAngsuran()` xN
 *
 * Konsekuensinya penting: SELURUH aturan yang berlaku saat pengguna
 * mengetik manual tetap berlaku saat import — jurnal ganda-masuk,
 * pemetaan COA, kelayakan pinjaman, pemeriksaan likuiditas, aturan
 * Simpanan Pokok sekali saja, periode akuntansi yang tertutup, sampai
 * pemeriksaan hak akses. Import TIDAK BOLEH menjadi pintu belakang yang
 * menghasilkan data yang tidak mungkin dibuat lewat layar biasa.
 *
 * ============================================================
 * KENAPA PINJAMAN DIBUAT ULANG DARI AWAL, BUKAN DIISI SISA POKOKNYA
 * ============================================================
 * Pengguna hanya mengisi data akad (tanggal, jumlah, tenor, jasa) dan
 * BERAPA ANGSURAN yang sudah dibayar. Aplikasi lalu mencairkan pinjaman
 * pada tanggal historisnya, lalu membayar angsuran ke-1..ke-N lewat
 * `bayarAngsuran()`. Sisa pokok, jadwal, aging/kolektibilitas, piutang
 * jasa, dan seluruh jurnalnya karena itu terbentuk dari mesin yang sama
 * dengan operasi sehari-hari — bukan angka sisa yang ditempel dan bisa
 * bertentangan dengan buku besar. Pola ini sudah dibuktikan test
 * historis yang ada (`HistoricalLoanRepayment`).
 *
 * ============================================================
 * URUTAN & ISOLASI GALAT
 * ============================================================
 * Urutan `URUTAN_PROSES` (anggota -> simpanan -> berjangka -> pinjaman)
 * BUKAN kosmetik: simpanan menambah kas, pencairan pinjaman mengurangi
 * kas dan ditolak bila kas tidak cukup.
 *
 * Setiap baris dieksekusi lewat transaksinya SENDIRI (service yang
 * dipanggil membuka `withTransaction` masing-masing). Baris yang gagal
 * karena itu tidak membatalkan baris yang sudah berhasil, dan tetap
 * dilaporkan lengkap dengan nomor barisnya. Ini pilihan yang SENGAJA
 * diambil untuk import: setiap baris adalah satu transaksi yang utuh
 * dan seimbang, jadi keberhasilan sebagian tetap menghasilkan buku yang
 * benar — jauh lebih baik daripada 500 baris dibatalkan karena baris
 * ke-497 bermasalah. Pengguna melihat ringkasannya dan bisa memperbaiki
 * lalu mengimpor ulang HANYA baris yang gagal.
 */

// ===========================================================================
// EKSEKUSI
// ===========================================================================

export interface GagalImport {
  jenis: JenisSheetImport;
  baris: number;
  keterangan: string;
  pesan: string;
}

/**
 * RC-S100 — satu baris yang BERHASIL diproses.
 *
 * Sebelumnya keberhasilan hanya dihitung jumlahnya per sheet, sehingga
 * "log berhasil" yang diminta pengguna tidak mungkin ditampilkan: tidak
 * ada catatan baris mana saja yang masuk. Bentuknya dibuat sejajar
 * dengan `GagalImport` (tanpa `pesan`) supaya keduanya bisa disajikan
 * dalam satu daftar yang sama di layar riwayat.
 */
export interface BerhasilImport {
  jenis: JenisSheetImport;
  baris: number;
  keterangan: string;
  /**
   * RC-S133.6.4 — syarat pinjaman yang TIDAK terpenuhi pada tanggal pinjaman
   * ini. Baris tetap BERHASIL (pinjaman historis sudah terjadi); alasan ini
   * dicatat di hasil dan Riwayat Import agar pengurus dapat menelusurinya.
   */
  peringatan?: string[];
}

export interface HasilPerSheet {
  jenis: JenisSheetImport;
  label: string;
  berhasil: number;
  gagal: number;
  /** RC-S133.6.2 — baris yang dilewati karena sudah pernah diimpor (sidik isi sama). */
  dilewati?: number;
  /** RC-S133.6.2 — rinciannya, disimpan di ringkasan riwayat (kolom log v74 hanya mengenal BERHASIL/GAGAL). */
  rincianDilewati?: { baris: number; keterangan: string; pesan: string }[];
}

/** RC-S133.6.2 — satu baris yang dilewati karena isinya sudah pernah diimpor. */
export interface DilewatiImport {
  jenis: JenisSheetImport;
  baris: number;
  keterangan: string;
  pesan: string;
}

export interface HasilImportDataAwal {
  perSheet: HasilPerSheet[];
  gagal: GagalImport[];
  /** RC-S100 — rincian baris yang berhasil, untuk "log berhasil" di riwayat. */
  berhasil: BerhasilImport[];
  totalBerhasil: number;
  totalGagal: number;
  /**
   * RC-S133.6.2 — baris yang DILEWATI karena sidik isinya sudah tercatat
   * (berkas yang sama/berisi baris yang sama pernah diimpor). Tidak dihitung
   * berhasil maupun gagal. Opsional supaya pemanggil lama tetap valid.
   */
  dilewati?: DilewatiImport[];
  totalDilewati?: number;
  /** RC-S133.6.2 — sidik isi seluruh berkas (lihat SidikImport). */
  sidikBerkas?: string | null;
  /**
   * RC-S102 — hasil jalur MIGRASI SALDO AWAL, bila ada pinjaman berakad
   * sebelum cut-off. `null` bila cut-off tidak diisi atau tidak ada
   * pinjaman lama. Memuat rekonsiliasi ke saldo awal buku besar, yang
   * WAJIB dibaca pengguna: migrasi tidak menjurnal apa pun, jadi sisi
   * buku besarnya belum tentu sudah diisi.
   */
  migrasi: HasilMigrasiPinjaman | null;
  /**
   * RC-S103 — keterbatasan yang berlaku karena sebagian kolom migrasi
   * DITURUNKAN, bukan dibaca dari berkas. Kosong bila berkas memuat
   * seluruh kolomnya sendiri. Harus ditampilkan ke pengguna: angka
   * turunan membuat import bisa jalan, tetapi tidak menggantikan
   * rekonsiliasi terhadap pembukuan koperasi.
   */
  keterbatasanTurunan: string[];
  /** RC-S107 — hasil migrasi aset tetap; null bila sheet Aset kosong. */
  aset: HasilMigrasiAset | null;
  /**
   * RC-S107 — hasil pengisian Saldo Awal Akun otomatis; null bila tidak
   * ada pos yang perlu diisi atau pengisiannya gagal seluruhnya.
   */
  saldoAwal: HasilSaldoAwalOtomatis | null;
  /**
   * RC-S133.4.3 — hasil sheet "6. Jasa Dibayar": total jasa per anggota
   * yang kini tersimpan & rekonsiliasinya ke saldo awal Pendapatan Jasa
   * Pinjaman. null bila sheet itu kosong / tidak ada baris yang tersimpan.
   */
  jasaDataAwal: RekonsiliasiJasaDataAwal | null;
  /**
   * RC-S133.4.6 — hasil sheet "7. Saldo Awal Akun" (null bila sheet itu
   * tidak ada / kosong). Tidak ikut `perSheet` & riwayat per jenis karena
   * sheet ini tidak menunjuk anggota; ditampilkan tersendiri di layar.
   */
  saldoAwalAkun?: HasilSheetSaldoAwalAkun | null;
}

/** RC-S133.4.6 — ringkasan pengisian sheet "7. Saldo Awal Akun". */
export interface HasilSheetSaldoAwalAkun {
  berhasil: { baris: number; kodeAkun: string; namaAkun: string; saldo: Rupiah; bagianTunai: Rupiah | null }[];
  gagal: { baris: number; kodeAkun: string; pesan: string }[];
  /**
   * Saldo akun kliring "Saldo Awal Belum Sesuai" (3-5000) setelah seluruh
   * saldo awal terisi: debit − kredit. 0 berarti saldo awal seimbang.
   */
  saldoKliring: Rupiah | null;
}

/** Pesan untuk baris sheet 7 pada import "transaksi baru" (tanpa cut-off). */
export const PESAN_SALDO_AWAL_AKUN_TANPA_CUTOFF =
  'Sheet "7. Saldo Awal Akun" hanya dipakai untuk data saldo lama (dengan cut-off). Pada transaksi baru, saldo akun terbentuk dari transaksinya.';

/** Pesan untuk baris sheet Jasa Dibayar pada import "transaksi baru" (tanpa cut-off). */
export const PESAN_JASA_TANPA_CUTOFF =
  'Sheet "6. Jasa Dibayar" hanya dipakai untuk data saldo lama (dengan cut-off). Pada transaksi baru, jasa sudah tercatat dari pembayaran angsuran.';

/**
 * AUDIT F-1 — Template impor menawarkan Sumber Dana KAS/BANK, tetapi
 * layanan hilir (catatDataAwalSimpanan / setorSimpananBerjangka /
 * cairkanPinjaman / bayarAngsuran) mewajibkan `bankAccountId` bila sumber
 * dana = BANK, dan eksekutor tidak pernah mengirimkannya sehingga setiap
 * baris BANK gagal ("bankAccountId wajib diisi jika sumber dana = BANK.").
 *
 * RC-S133.6.1 — kolom opsional "Rekening Bank" (nomor rekening). Aturan
 * pemilihan ada di `pilihRekeningBankImport` (dipakai juga oleh pratinjau):
 * kolom kosong + tepat satu rekening aktif -> rekening itu; kolom kosong +
 * lebih dari satu -> galat; kolom diisi -> harus cocok dengan rekening
 * aktif. Galat dilempar SEBELUM tulis apa pun (supaya pinjaman tidak
 * tertinggal berstatus DIAJUKAN).
 */
async function bankUntukImport(
  db: SQLite.SQLiteDatabase,
  sumberDana: 'KAS' | 'BANK',
  rekeningBank?: string
): Promise<{ bankAccountId?: string }> {
  if (sumberDana !== 'BANK') return {};
  const rows = await db.getAllAsync<{ id: string; nama_bank: string; nomor_rekening: string }>(
    `SELECT id, nama_bank, nomor_rekening FROM bank_account WHERE aktif = 1 ORDER BY id`
  );
  const p = pilihRekeningBankImport(
    rekeningBank,
    rows.map((r) => ({ id: r.id, namaBank: r.nama_bank, nomorRekening: r.nomor_rekening }))
  );
  if ('id' in p) return { bankAccountId: p.id };
  throw new Error(p.galat);
}

function pesanGalat(e: unknown): string {
  return e instanceof Error ? e.message : 'Terjadi kesalahan yang tidak diketahui.';
}

export interface OpsiImport {
  createdBy: string;
  /** Dipanggil setiap satu baris selesai diproses — untuk indikator kemajuan di layar. */
  onKemajuan?: (selesai: number, total: number) => void;
  /** RC-S100 — nama berkas Excel, disimpan di riwayat agar bisa dikenali lagi. */
  namaBerkas?: string | null;
  /**
   * RC-S102 — TANGGAL CUT-OFF PEMBUKUAN (opsional).
   *
   * Bila diisi, pinjaman yang berakad SEBELUM tanggal ini TIDAK
   * dicairkan ulang lewat kas: ia masuk jalur MIGRASI SALDO AWAL
   * (`EksekusiMigrasiPinjaman`) yang tidak menjurnal apa pun. Pinjaman
   * pada/setelah cut-off tetap melewati `cairkanPinjaman()` beserta
   * SELURUH pemeriksaan kelayakan, likuiditas, dan saldo rekeningnya.
   *
   * Tanpa cut-off, perilakunya PERSIS seperti sebelumnya (seluruh
   * pinjaman lewat jalur pencairan normal) — berkas & alur lama tidak
   * berubah.
   */
  tanggalCutOff?: string;
  /**
   * RC-S102 — database untuk jalur migrasi. Sama alasannya dengan
   * `dbRiwayat`: produksi jatuh ke `getDb()`, test mengisinya dengan
   * database ujinya sendiri supaya jalur migrasi benar-benar dijalankan.
   */
  dbMigrasi?: SQLite.SQLiteDatabase;
  /**
   * RC-S100 — database tempat riwayat dicatat. Produksi TIDAK mengisinya
   * (jatuh ke `getDb()`); test mengisinya dengan database ujinya sendiri
   * supaya jalur pencatatan benar-benar DIJALANKAN dan hasilnya bisa
   * diperiksa. Tanpa parameter ini, `getDb()` di lingkungan test melempar
   * (mock expo-sqlite sengaja begitu) dan pencatatannya akan tertelan
   * oleh try/catch di bawah — jalur yang paling perlu diuji justru tidak
   * pernah tersentuh.
   */
  dbRiwayat?: SQLite.SQLiteDatabase;
}

/**
 * Jalankan import. HANYA baris yang lolos pratinjau (`RingkasanParse`)
 * yang diproses — fungsi ini tidak membaca berkas lagi, sehingga yang
 * diimpor PERSIS yang ditampilkan di pratinjau.
 */
export async function jalankanImportDataAwal(
  ringkasan: RingkasanParse,
  opsi: OpsiImport
): Promise<HasilImportDataAwal> {
  const { anggota, simpanan, pinjaman, berjangka, aset } = ringkasan.hasil;
  // RC-S133.4.3 — sheet baru; `?? []` menjaga pemanggil lama yang menyusun RingkasanParse sendiri.
  const barisJasa: BarisJasa[] = (ringkasan.hasil.jasa?.baris ?? []) as BarisJasa[];
  // RC-S133.4.6 — sheet "7. Saldo Awal Akun" (opsional).
  const barisAkun: BarisSaldoAwalAkun[] = (ringkasan.hasil.saldoAwalAkun?.baris ?? []) as BarisSaldoAwalAkun[];
  const gagal: GagalImport[] = [];
  const berhasil: BerhasilImport[] = [];
  const dilewati: DilewatiImport[] = [];
  const hitung: Record<JenisSheetImport, { berhasil: number; gagal: number; dilewati: number }> = {
    ANGGOTA: { berhasil: 0, gagal: 0, dilewati: 0 },
    SIMPANAN: { berhasil: 0, gagal: 0, dilewati: 0 },
    BERJANGKA: { berhasil: 0, gagal: 0, dilewati: 0 },
    PINJAMAN: { berhasil: 0, gagal: 0, dilewati: 0 },
    ASET: { berhasil: 0, gagal: 0, dilewati: 0 },
    JASA: { berhasil: 0, gagal: 0, dilewati: 0 },
  };

  // ============================================================
  // RC-S133.6.2 — PENCEGAHAN IMPORT GANDA (SIDIK ISI BARIS, v81)
  // ============================================================
  // Sidik dihitung dari ISI baris (lihat SidikImport) dan dibandingkan dengan
  // sidik yang tersimpan PERMANEN di import_data_awal_sidik. Baris yang
  // sidiknya sudah tercatat DILEWATI — walau nama berkas berbeda, dan walau
  // anggota tanpa NIK. Ini juga yang membuat import gagal sebagian dapat
  // dilanjutkan: impor ulang berkas yang sama hanya memproses baris yang
  // belum masuk. Sidik dibaca SEBELUM baris pertama ditulis; bila tabelnya
  // tidak dapat dibaca, import berhenti di sini (gagal tertutup), bukan
  // berjalan tanpa perlindungan.
  const sidikBerkas = hitungSidikBerkas(ringkasan.hasil);
  const dbSidik = opsi.dbRiwayat ?? opsi.dbMigrasi ?? (await getDb());
  const sidikTercatat = await muatSidikTercatat(
    dbSidik,
    sidikBerkas.perBaris.map((b) => b.sidik)
  );
  const sidikDicatat: string[] = [];
  const sidikBaris = (jenis: JenisSidik, baris: number): string | null => sidikBerkas.peta.get(kunciSidik(jenis, baris)) ?? null;
  const sudahDiimpor = (jenis: JenisSidik, baris: number): SidikTercatat | null => {
    const sd = sidikBaris(jenis, baris);
    return sd ? sidikTercatat.get(sd) ?? null : null;
  };
  const catatDilewati = (jenis: JenisSheetImport, baris: number, keterangan: string, c: SidikTercatat) => {
    hitung[jenis].dilewati += 1;
    const tgl = c.createdAt.slice(0, 10);
    dilewati.push({
      jenis,
      baris,
      keterangan,
      pesan:
        `Sudah diimpor ${tgl}${c.namaBerkas ? ` dari berkas "${c.namaBerkas}"` : ''}` +
        (c.status === 'SEBAGIAN' ? ' (pinjaman sudah cair; angsurannya dilengkapi lewat menu Pinjaman)' : '') +
        ' — dilewati agar tidak tercatat dua kali.',
    });
  };
  /**
   * Catat sidik SESUDAH baris berhasil tertulis. Ditulis per baris (bukan di
   * akhir import) supaya import yang terhenti di tengah tetap meninggalkan
   * catatan atas baris yang sudah masuk. Kegagalan pencatatan sidik tidak
   * membatalkan baris yang sudah tertulis (tidak mungkin di-rollback lagi);
   * dicatat ke console.
   */
  const simpanSidik = async (
    jenis: JenisSidik,
    baris: number,
    keterangan: string,
    status: 'BERHASIL' | 'SEBAGIAN',
    entitasTabel: string | null,
    entitasId: string | null
  ) => {
    const sd = sidikBaris(jenis, baris);
    if (!sd) return;
    try {
      await catatSidikBaris(dbSidik, {
        sidik: sd,
        jenisSheet: jenis,
        status,
        entitasTabel,
        entitasId,
        baris,
        keterangan,
        namaBerkas: opsi.namaBerkas ?? null,
        sidikBerkas: sidikBerkas.sidikBerkas,
        createdBy: opsi.createdBy,
        waktu: new Date(),
      });
      sidikDicatat.push(sd);
    } catch (e) {
      console.error('[ImportDataAwal] gagal mencatat sidik baris:', e);
    }
  };

  const total =
    anggota.baris.length +
    simpanan.baris.length +
    berjangka.baris.length +
    pinjaman.baris.length +
    aset.baris.length +
    barisJasa.length +
    barisAkun.length;
  let selesai = 0;
  const majukan = () => {
    selesai += 1;
    opsi.onKemajuan?.(selesai, total);
  };

  const catatGagal = (jenis: JenisSheetImport, baris: number, keterangan: string, e: unknown) => {
    hitung[jenis].gagal += 1;
    gagal.push({ jenis, baris, keterangan, pesan: pesanGalat(e) });
  };

  /**
   * RC-S100 — pasangan `catatGagal` untuk baris yang berhasil. Menaikkan
   * penghitung DAN mencatat rinciannya dalam satu langkah, supaya jumlah
   * di `perSheet` dan panjang daftar `berhasil` mustahil divergen (dulu
   * penghitung dinaikkan langsung di enam tempat berbeda).
   */
  const catatBerhasil = (jenis: JenisSheetImport, baris: number, keterangan: string, peringatan?: string[]) => {
    hitung[jenis].berhasil += 1;
    berhasil.push(peringatan && peringatan.length > 0 ? { jenis, baris, keterangan, peringatan } : { jenis, baris, keterangan });
  };

  /**
   * Kode Anggota (huruf besar) -> anggota yang BERHASIL dibuat. Baris
   * simpanan/pinjaman/berjangka milik anggota yang GAGAL dibuat otomatis
   * tidak diproses — dilaporkan sebagai galat dengan sebab yang jelas,
   * bukan menimbulkan galat susulan "anggota tidak ditemukan".
   */
  const petaAnggota = new Map<string, { id: string; nomorAnggota: string; nama: string }>();

  /**
   * RC-S103 — tanggal cut-off yang dipakai jalur SIMPANAN. Sama nilainya
   * dengan yang dipakai jalur pinjaman; dideklarasikan di sini karena
   * tahap SIMPANAN berjalan lebih dulu daripada tahap PINJAMAN.
   */
  const cutOffSimpanan = opsi.tanggalCutOff;
  let adaSaldoAwalSimpanan = false;

  /**
   * RC-S107 — total per pos neraca yang dikumpulkan SELAMA import, lalu
   * dipakai mengisi Saldo Awal Akun otomatis di akhir. Dikumpulkan di
   * sini, bukan dihitung ulang dari database sesudahnya: yang harus
   * masuk saldo awal adalah persis yang BARU SAJA diimpor, bukan
   * seluruh isi tabel (yang mungkin memuat data lama).
   */
  const totalPos: TotalPerPos = {};

  // ---- 1. ANGGOTA ----
  for (const r of anggota.baris) {
    // RC-S133.6.2 — anggota yang sudah pernah diimpor (sidik sama) dan masih
    // ada TIDAK dibuat lagi; baris simpanan/pinjamannya dipetakan ke anggota itu.
    const tercatatA = sudahDiimpor('ANGGOTA', r.baris);
    if (tercatatA?.entitasId) {
      const ada = await dbSidik.getFirstAsync<{ id: string; nomor_anggota: string; nama_lengkap: string }>(
        'SELECT id, nomor_anggota, nama_lengkap FROM anggota WHERE id = ?',
        tercatatA.entitasId
      );
      if (ada) {
        petaAnggota.set(r.kode.toUpperCase(), { id: ada.id, nomorAnggota: ada.nomor_anggota, nama: ada.nama_lengkap });
        catatDilewati('ANGGOTA', r.baris, `${ada.nomor_anggota} — ${ada.nama_lengkap}`, tercatatA);
        majukan();
        continue;
      }
    }
    try {
      const dibuat = await createAnggota(opsi.createdBy, {
        namaLengkap: r.namaLengkap,
        nik: r.nik ?? undefined,
        jenisKelamin: r.jenisKelamin ?? undefined,
        tempatLahir: r.tempatLahir ?? undefined,
        tanggalLahir: r.tanggalLahir ?? undefined,
        alamat: r.alamat ?? undefined,
        nomorHp: r.nomorHp ?? undefined,
        pekerjaan: r.pekerjaan ?? undefined,
        tanggalBergabung: r.tanggalBergabung,
      } as Parameters<typeof createAnggota>[1]);
      petaAnggota.set(r.kode.toUpperCase(), {
        id: dibuat.id,
        nomorAnggota: dibuat.nomorAnggota,
        nama: r.namaLengkap,
      });
      catatBerhasil('ANGGOTA', r.baris, `${dibuat.nomorAnggota} — ${r.namaLengkap}`);
      await simpanSidik('ANGGOTA', r.baris, `${dibuat.nomorAnggota} — ${r.namaLengkap}`, 'BERHASIL', 'anggota', dibuat.id);
    } catch (e) {
      // RC-S133.6.1 — temuan audit: pesan mentah database ("UNIQUE constraint
      // failed: anggota.nik") diterjemahkan menjadi pesan yang dapat ditindaklanjuti.
      const nikGanda = e instanceof Error && /UNIQUE constraint failed: anggota\.nik/.test(e.message);
      catatGagal(
        'ANGGOTA',
        r.baris,
        `${r.kode} — ${r.namaLengkap}`,
        nikGanda ? new Error(`NIK ${r.nik ?? ''} sudah terdaftar pada anggota lain. Satu NIK hanya untuk satu anggota.`) : e
      );
    }
    majukan();
  }

  /** Cari anggota hasil tahap 1; bila tidak ada, catat galat & kembalikan null. */
  const anggotaUntuk = (
    jenis: JenisSheetImport,
    r: { baris: number; kode: string }
  ): { id: string; nomorAnggota: string; nama: string } | null => {
    const a = petaAnggota.get(r.kode.toUpperCase());
    if (!a) {
      catatGagal(
        jenis,
        r.baris,
        r.kode,
        new Error(`Anggota berkode "${r.kode}" gagal dibuat pada tahap Anggota, baris ini dilewati.`)
      );
      majukan();
      return null;
    }
    return a;
  };

  // ---- 2. SIMPANAN ----
  //
  // RC-S103 — DUA JALUR, ATURANNYA SAMA DENGAN PINJAMAN.
  //
  // `catatDataAwalSimpanan()` MENJURNAL debit Kas/Bank sebesar total
  // simpanan. Itu benar untuk setoran yang uangnya baru diterima, tetapi
  // untuk SALDO pada tanggal cut-off ia menciptakan KAS FIKTIF: uang
  // simpanan anggota sudah lama diterima dan sebagian besar sudah
  // berputar keluar menjadi pinjaman. Pada data koperasi yang memicu
  // perbaikan ini, jalur lama menambah kas Rp166.486.465 yang tidak
  // pernah ada.
  //
  // Karena itu simpanan bertanggal SEBELUM cut-off masuk jalur SALDO
  // AWAL (`EksekusiMigrasiSimpanan`) yang tidak menjurnal apa pun.
  // Simpanan pada/setelah cut-off tetap lewat `catatDataAwalSimpanan()`
  // apa adanya — fungsi itu, beserta menu Setor Simpanan yang
  // memakainya, TIDAK diubah sama sekali.
  const semuaSimpanan = simpanan.baris as BarisSimpanan[];
  for (const r of semuaSimpanan) {
    const tercatatS = sudahDiimpor('SIMPANAN', r.baris);
    if (tercatatS) {
      const aS = petaAnggota.get(r.kode.toUpperCase());
      catatDilewati('SIMPANAN', r.baris, aS ? `${aS.nomorAnggota} — ${aS.nama}` : r.kode, tercatatS);
      majukan();
      continue;
    }
    const a = anggotaUntuk('SIMPANAN', r);
    if (!a) continue;
    const saldoAwal = cutOffSimpanan !== undefined && r.tanggal < cutOffSimpanan;
    let journalSimpanan: string | null = null;
    try {
      if (saldoAwal) {
        const dbSimpanan = opsi.dbMigrasi ?? (await getDb());
        await jalankanMigrasiSimpanan(dbSimpanan, {
          anggotaId: a.id,
          tanggal: r.tanggal,
          pokok: r.pokok,
          wajib: r.wajib,
          sukarela: r.sukarela,
          sumberDana: r.sumberDana,
          keterangan: 'Saldo awal simpanan (import Excel)',
          createdBy: opsi.createdBy,
        });
        adaSaldoAwalSimpanan = true;
        // RC-S107 — dikumpulkan untuk pengisian saldo awal otomatis.
        totalPos.SIMPANAN_POKOK = (totalPos.SIMPANAN_POKOK ?? 0) + r.pokok;
        totalPos.SIMPANAN_WAJIB = (totalPos.SIMPANAN_WAJIB ?? 0) + r.wajib;
        totalPos.SIMPANAN_SUKARELA = (totalPos.SIMPANAN_SUKARELA ?? 0) + r.sukarela;
      } else {
        const bankS = await bankUntukImport(opsi.dbMigrasi ?? (await getDb()), r.sumberDana, r.rekeningBank);
        const hS = await catatDataAwalSimpanan({
          anggotaId: a.id,
          tanggal: r.tanggal,
          pokok: r.pokok,
          wajib: r.wajib,
          sukarela: r.sukarela,
          sumberDana: r.sumberDana,
          ...bankS,
          keterangan: 'Data awal (import Excel)',
          createdBy: opsi.createdBy,
        });
        journalSimpanan = hS?.journalId ?? null;
      }
      catatBerhasil(
        'SIMPANAN',
        r.baris,
        `${a.nomorAnggota} — ${a.nama}${saldoAwal ? ' (saldo awal, tanpa jurnal kas)' : ''}`
      );
      await simpanSidik('SIMPANAN', r.baris, `${a.nomorAnggota} — ${a.nama}`, 'BERHASIL', journalSimpanan ? 'journal' : null, journalSimpanan);
    } catch (e) {
      catatGagal('SIMPANAN', r.baris, `${a.nomorAnggota} — ${a.nama}`, e);
    }
    majukan();
  }

  // ---- 3. SIMPANAN BERJANGKA ----
  //
  // RC-S133.4.6 — DUA JALUR, ATURANNYA SAMA DENGAN SIMPANAN & PINJAMAN.
  // Penempatan bertanggal SEBELUM cut-off adalah saldo lama: masuk jalur
  // migrasi (`EksekusiMigrasiBerjangka`) tanpa jurnal kas, saldo awal
  // 2-1210 diisi otomatis, dan bunga periode sebelum cut-off tidak diakru
  // ulang. Uji setara RC-S133.4.5 membuktikan jalur lama (setor biasa)
  // menambah kas fiktif sebesar nominalnya dan menggandakan bunga.
  // Penempatan pada/setelah cut-off tetap lewat `setorSimpananBerjangka()`.
  let adaSaldoAwalBerjangka = false;
  for (const r of berjangka.baris as BarisBerjangka[]) {
    const tercatatB = sudahDiimpor('BERJANGKA', r.baris);
    if (tercatatB) {
      const aB = petaAnggota.get(r.kode.toUpperCase());
      catatDilewati('BERJANGKA', r.baris, aB ? `${aB.nomorAnggota} — ${aB.nama}` : r.kode, tercatatB);
      majukan();
      continue;
    }
    const a = anggotaUntuk('BERJANGKA', r);
    if (!a) continue;
    if (cutOffSimpanan !== undefined && r.tanggal < cutOffSimpanan) {
      try {
        const dbB = opsi.dbMigrasi ?? (await getDb());
        const m = await jalankanMigrasiBerjangka(dbB, {
          anggotaId: a.id,
          tanggal: r.tanggal,
          nominal: r.nominal,
          tenorBulan: r.tenorBulan,
          sukuBungaPerTahun: r.sukuBungaPerTahun,
          sumberDana: r.sumberDana,
          createdBy: opsi.createdBy,
          tanggalCutOff: cutOffSimpanan,
        });
        adaSaldoAwalBerjangka = true;
        totalPos.SIMPANAN_BERJANGKA = (totalPos.SIMPANAN_BERJANGKA ?? 0) + r.nominal;
        await simpanSidik('BERJANGKA', r.baris, `${a.nomorAnggota} — ${a.nama} (saldo awal)`, 'BERHASIL', null, null);
        catatBerhasil(
          'BERJANGKA',
          r.baris,
          `${a.nomorAnggota} — ${a.nama} (saldo awal, tanpa jurnal kas` +
            (m.periodeBungaSebelumCutOff > 0
              ? `; bunga ${m.periodeBungaSebelumCutOff} periode sebelum cut-off Rp${m.bungaSebelumCutOff.toLocaleString('id-ID')} dianggap sudah di sukarela)`
              : ')')
        );
      } catch (e) {
        catatGagal('BERJANGKA', r.baris, `${a.nomorAnggota} — ${a.nama}`, e);
      }
      majukan();
      continue;
    }
    try {
      const bankB = await bankUntukImport(opsi.dbMigrasi ?? (await getDb()), r.sumberDana, r.rekeningBank);
      const hB = await setorSimpananBerjangka({
        anggotaId: a.id,
        nominal: r.nominal,
        tanggal: r.tanggal,
        tenorBulan: r.tenorBulan,
        sukuBungaPerTahun: r.sukuBungaPerTahun,
        sumberDana: r.sumberDana,
        ...bankB,
        keterangan: 'Data awal (import Excel)',
        createdBy: opsi.createdBy,
      });
      catatBerhasil('BERJANGKA', r.baris, `${a.nomorAnggota} — ${a.nama}`);
      const idB = (hB as { id?: string } | undefined)?.id ?? null;
      await simpanSidik('BERJANGKA', r.baris, `${a.nomorAnggota} — ${a.nama}`, 'BERHASIL', idB ? 'simpanan_berjangka' : null, idB);
    } catch (e) {
      catatGagal('BERJANGKA', r.baris, `${a.nomorAnggota} — ${a.nama}`, e);
    }
    majukan();
  }

  // ============================================================
  // ---- 4. PINJAMAN ----
  // ============================================================
  //
  // RC-S102 — DUA JALUR YANG TERPISAH TEGAS.
  //
  // Sebelum ini SELURUH pinjaman, termasuk pinjaman lama yang masih
  // berjalan, dimasukkan lewat ajukanPinjaman() -> cairkanPinjaman() ->
  // bayarAngsuran(). Akibatnya pokok pinjaman historis DICAIRKAN ULANG
  // hari ini: kas/bank berkurang untuk uang yang sudah keluar
  // bertahun-tahun lalu, pemeriksaan likuiditas dijalankan terhadap
  // saldo kas SEKARANG sehingga koperasi berkas kecil tidak bisa migrasi
  // sama sekali, dan pendapatan jasa historis diakui ulang.
  //
  // Sekarang: pinjaman berakad SEBELUM cut-off masuk jalur MIGRASI yang
  // tidak menjurnal apa pun (lihat MigrasiPinjamanPlan). Pinjaman
  // pada/setelah cut-off tetap lewat jalur pencairan normal di bawah,
  // BESERTA SELURUH pemeriksaannya — tidak ada satu pun yang dilonggarkan.
  // RC-S133.6.2 — baris pinjaman yang sudah pernah diimpor dilewati sebelum
  // dipilah ke jalur migrasi / pencairan.
  const semuaPinjaman = (pinjaman.baris as BarisPinjaman[]).filter((r) => {
    const c = sudahDiimpor('PINJAMAN', r.baris);
    if (!c) return true;
    const aP = petaAnggota.get(r.kode.toUpperCase());
    catatDilewati('PINJAMAN', r.baris, aP ? `${aP.nomorAnggota} — ${aP.nama}` : r.kode, c);
    majukan();
    return false;
  });
  const cutOff = opsi.tanggalCutOff;
  const barisMigrasi = cutOff ? semuaPinjaman.filter((r) => r.tanggal < cutOff) : [];
  const barisPencairanBaru = cutOff ? semuaPinjaman.filter((r) => r.tanggal >= cutOff) : semuaPinjaman;

  // RC-S103 — KOLOM MIGRASI DILENGKAPI OTOMATIS.
  //
  // RC-S102 mewajibkan berkas memuat Nomor Pinjaman Lama, Sisa Pokok, dan
  // Angsuran Tersisa; tanpa ketiganya validator menolak seluruh baris.
  // Akibatnya koperasi harus menyusun ulang berkasnya secara manual lebih
  // dulu — pekerjaan yang justru menimbulkan salah rumus dan salah
  // pembulatan. Ketiganya sekarang DITURUNKAN dari kolom yang sudah wajib
  // ada (Jumlah Pinjaman, Tenor, Angsuran Sudah Dibayar), lihat
  // `TurunanMigrasiPinjaman`. Nilai yang SUDAH diisi di berkas tetap
  // menang atas hasil turunan.
  const turunanPerBaris = new Map<number, HasilTurunanMigrasi>();
  const barisMigrasiBersaldo: BarisPinjaman[] = [];
  const kolomTurunanTerpakai = new Set<KolomDiturunkan>();
  for (const r of barisMigrasi) {
    const t = lengkapiBarisMigrasi({
      baris: r.baris,
      kode: r.kode,
      jumlahPinjaman: r.jumlahPinjaman,
      tenor: r.tenor,
      angsuranSudahDibayar: r.angsuranSudahDibayar,
      nomorPinjamanLama: r.nomorPinjamanLama,
      sisaPokok: r.sisaPokok,
      angsuranTersisa: r.angsuranTersisa,
      metodeJasa: r.metodeJasa,
      persentaseJasa: r.persentaseJasa,
    });
    for (const k of t.diturunkan) kolomTurunanTerpakai.add(k);
    // Pinjaman yang sudah habis angsurannya dilewati dengan sebab yang
    // jelas — bukan dibiarkan jatuh ke validator dan muncul sebagai
    // "sisa pokok harus lebih besar dari 0", pesan yang tidak
    // menerangkan apa pun bagi pengguna.
    if (pinjamanSudahTidakBersaldo(t)) {
      catatGagal('PINJAMAN', r.baris, `${r.kode} — migrasi saldo awal`, new Error(PESAN_SUDAH_LUNAS));
      majukan();
      continue;
    }
    turunanPerBaris.set(r.baris, t);
    barisMigrasiBersaldo.push(r);
  }
  const keterbatasanTurunan = [
    ...(adaSaldoAwalSimpanan ? KETERBATASAN_SALDO_AWAL_SIMPANAN : []),
    ...(adaSaldoAwalBerjangka ? KETERBATASAN_SALDO_AWAL_BERJANGKA : []),
    ...(kolomTurunanTerpakai.size > 0 ? KETERBATASAN_TURUNAN : []),
  ];

  let migrasi: HasilMigrasiPinjaman | null = null;
  if (cutOff && barisMigrasiBersaldo.length > 0) {
    try {
      const dbMigrasi = opsi.dbMigrasi ?? (await getDb());
      migrasi = await jalankanMigrasiPinjaman(
        dbMigrasi,
        barisMigrasiBersaldo.map((r): BarisMigrasiPinjaman => {
          const t = turunanPerBaris.get(r.baris) as HasilTurunanMigrasi;
          return {
            baris: r.baris,
            kodeAnggota: r.kode,
            nomorPinjamanAsli: t.nomorPinjamanLama,
            tanggalAkad: r.tanggal,
            jumlahPinjamanAsli: r.jumlahPinjaman,
            sisaPokok: t.sisaPokok,
            angsuranTersisa: t.angsuranTersisa,
            satuanTenor: r.satuanTenor,
            metodeJasa: r.metodeJasa,
            persentaseJasa: r.persentaseJasa,
            tunggakanPokok: r.tunggakanPokok,
            piutangJasa: r.piutangJasa,
            // RC-S133.4.5 — tenor akad: jadwal dibangun ulang dari akad.
            tenorAsli: r.tenor,
          };
        }),
        {
          tanggalCutOff: cutOff,
          createdBy: opsi.createdBy,
          petaAnggota,
          onKemajuan: () => majukan(),
        }
      );
      for (const b of migrasi.berhasil) {
        catatBerhasil('PINJAMAN', b.baris, b.keterangan);
        await simpanSidik('PINJAMAN', b.baris, `${b.nomorPinjaman} — migrasi saldo awal`, 'BERHASIL', null, null);
      }
      // RC-S107 — sisi buku besar piutang, untuk saldo awal otomatis.
      totalPos.PIUTANG_PINJAMAN = (totalPos.PIUTANG_PINJAMAN ?? 0) + migrasi.totalSisaPokok;
      const piutangJasa = migrasi.rekonsiliasi.totalPiutangJasaBukuPembantu;
      if (piutangJasa > 0) totalPos.PIUTANG_JASA = (totalPos.PIUTANG_JASA ?? 0) + piutangJasa;
      if ((migrasi.totalJasaDimuka ?? 0) > 0) totalPos.PENDAPATAN_DIMUKA = (totalPos.PENDAPATAN_DIMUKA ?? 0) + (migrasi.totalJasaDimuka ?? 0);
      // Baris yang dilewati (sudah pernah dimigrasikan) dilaporkan sebagai
      // GAGAL agar terlihat di log, bukan hilang tanpa jejak — datanya
      // sendiri sengaja TIDAK diubah.
      for (const d of migrasi.dilewati) catatGagal('PINJAMAN', d.baris, d.pesan, new Error(d.pesan));
    } catch (e) {
      // Validasi gagal -> TIDAK ADA baris migrasi yang ditulis. Seluruh
      // baris migrasi dilaporkan gagal dengan sebab per baris.
      if (e instanceof ValidasiMigrasiGagalError) {
        // SATU baris rusak dihitung SATU kegagalan, walau validator
        // menemukan beberapa kesalahan pada baris itu. Versi pertama
        // mencatat per-kesalahan, sehingga satu baris tanpa nomor lama &
        // tanpa sisa pokok dilaporkan sebagai 3 baris gagal — jumlah yang
        // tidak cocok dengan jumlah baris di berkas dan membingungkan
        // pengguna saat mencocokkan ke Excel-nya.
        const perBaris = new Map<number, string[]>();
        for (const g of e.galat) {
          const daftar = perBaris.get(g.baris) ?? [];
          daftar.push(g.pesan);
          perBaris.set(g.baris, daftar);
        }
        for (const [nomorBaris, pesan] of perBaris) {
          catatGagal('PINJAMAN', nomorBaris, 'Migrasi saldo awal', new Error(pesan.join(' ')));
        }
      } else {
        for (const r of barisMigrasiBersaldo) catatGagal('PINJAMAN', r.baris, 'Migrasi saldo awal', e);
      }
      // Kemajuan tetap dimajukan supaya indikator di layar tidak tertahan.
      for (let i = 0; i < barisMigrasiBersaldo.length; i++) majukan();
    }
  }

  for (const r of barisPencairanBaru) {
    const a = anggotaUntuk('PINJAMAN', r);
    if (!a) continue;
    let pinjamanId: string | null = null;
    let peringatanSyarat: string[] = [];
    try {
      // AUDIT F-1b — tentukan rekening SEBELUM ajukanPinjaman agar kegagalan
      // tidak meninggalkan pinjaman DIAJUKAN yatim.
      const bankP = await bankUntukImport(opsi.dbMigrasi ?? (await getDb()), r.sumberDana, r.rekeningBank);
      ({ id: pinjamanId, peringatanSyarat } = await ajukanPinjaman({
        anggotaId: a.id,
        tanggal: r.tanggal,
        jumlahPinjaman: r.jumlahPinjaman,
        tenor: r.tenor,
        satuanTenor: r.satuanTenor,
        metodeJasa: r.metodeJasa,
        persentaseJasa: r.persentaseJasa,
        biayaAdminTipe: 'TIDAK_ADA',
        biayaAdminNilai: 0,
        dendaAktif: false,
        createdBy: opsi.createdBy,
        // RC-S133.6.4 — syarat pinjaman dinilai pada tanggal pinjaman (bukan
        // hari ini) dan, untuk import data awal, hanya MEMPERINGATKAN: pinjaman
        // historis sudah terjadi, jadi menolaknya hanya menghalangi pemindahan data.
        modeEligibilitas: 'PERINGATAN',
      } as Parameters<typeof ajukanPinjaman>[0]));

      await cairkanPinjaman({
        pinjamanId,
        sumberDana: r.sumberDana,
        ...bankP,
        approvedBy: opsi.createdBy,
        tanggalPencairan: r.tanggal,
      });

      // Angsuran yang sudah dibayar dicatat satu per satu pada tanggal
      // jatuh temponya masing-masing — bukan sekaligus pada satu
      // tanggal — supaya jadwal, aging, dan pengakuan jasa per periode
      // terbentuk seperti pembayaran yang sesungguhnya.
      if (r.angsuranSudahDibayar > 0) {
        const jadwal = await getJadwalAngsuran(pinjamanId);
        const urut = jadwal
          .slice()
          .sort((x, y) => x.nomorAngsuran - y.nomorAngsuran)
          .slice(0, r.angsuranSudahDibayar);
        for (const j of urut) {
          const sisa = j.total - j.pokokTerbayar - j.jasaTerbayar - j.dendaTerbayar;
          if (sisa <= 0) continue;
          await bayarAngsuran({
            pinjamanId,
            jadwalId: j.id,
            tanggal: j.tanggalJatuhTempo,
            nominal: sisa,
            sumberDana: r.sumberDana,
            ...bankP,
            createdBy: opsi.createdBy,
          });
        }
      }

      catatBerhasil('PINJAMAN', r.baris, `${a.nomorAnggota} — ${a.nama}`, peringatanSyarat);
      await simpanSidik('PINJAMAN', r.baris, `${a.nomorAnggota} — ${a.nama}`, 'BERHASIL', 'pinjaman', pinjamanId);
    } catch (e) {
      // RC-S133.6 (sisa AUDIT F-1b) — kegagalan SESUDAH ajukanPinjaman (mis.
      // saldo kas/bank tidak cukup saat pencairan) dulu meninggalkan pinjaman
      // berstatus DIAJUKAN beserta jadwalnya: tampil sebagai pengajuan yang
      // menunggu, dan impor ulang baris yang sama menggandakannya. Pinjaman
      // yang BELUM cair kini dibatalkan lewat jalur resmi (batalkanPinjaman →
      // DITOLAK, sama dengan penolakan manual; tanpa jurnal). Pinjaman yang
      // SUDAH cair (gagal di tengah pencatatan angsuran) tidak disentuh —
      // pesannya menjelaskan agar baris itu tidak diimpor ulang.
      let galat: unknown = e;
      if (pinjamanId) {
        const st = await (await getDb()).getFirstAsync<{ status: string; nomor_pinjaman: string | null }>(
          'SELECT status, nomor_pinjaman FROM pinjaman WHERE id = ?',
          pinjamanId
        );
        if (st && (st.status === 'DIAJUKAN' || st.status === 'DISETUJUI')) {
          try {
            await batalkanPinjaman({ pinjamanId, alasan: `Import data awal gagal: ${pesanGalat(e)}`, actingUserId: opsi.createdBy });
          } catch {
            // Tidak menutupi galat asli; pinjaman tetap DIAJUKAN dan terlihat di menu Pinjaman.
          }
        } else if (st) {
          // RC-S133.6.2 — pinjaman yang sudah cair dicatat sidiknya (SEBAGIAN),
          // sehingga impor ulang berkas yang sama MELEWATI baris ini dan tidak
          // mencairkannya dua kali.
          galat = new Error(
            `${pesanGalat(e)} Pinjaman ${st.nomor_pinjaman ?? ''} SUDAH tercatat cair; lengkapi angsurannya lewat menu Pinjaman. ` +
              'Bila berkas ini diimpor ulang, baris ini otomatis dilewati.'
          );
          await simpanSidik('PINJAMAN', r.baris, `${a.nomorAnggota} — ${a.nama} (${st.nomor_pinjaman ?? ''})`, 'SEBAGIAN', 'pinjaman', pinjamanId);
        }
      }
      catatGagal('PINJAMAN', r.baris, `${a.nomorAnggota} — ${a.nama}`, galat);
    }
    majukan();
  }

  // ============================================================
  // ---- 5. ASET TETAP ----
  // ============================================================
  //
  // RC-S107 — TANPA JURNAL PEMBELIAN. `beliAset()` menjurnal Kredit
  // Kas/Bank; benar untuk aset yang memang baru dibeli, tetapi untuk
  // aset lama itu mengurangi kas hari ini atas uang yang keluar
  // bertahun-tahun lalu — kesalahan yang SAMA kelasnya dengan
  // pencairan ulang pinjaman dan kas fiktif dari simpanan. Karena itu
  // jalur ini memakai `EksekusiMigrasiAset` yang hanya menulis buku
  // pembantu. Lihat MigrasiAsetPlan untuk alasan lengkapnya.
  let hasilAset: HasilMigrasiAset | null = null;
  // RC-S133.6.2 — aset SUDAH punya penjaga import ulang sendiri (nomor aset
  // yang sudah ada dilewati oleh jalankanMigrasiAset dan dilaporkan), jadi
  // baris aset TIDAK disaring di sini. Yang disaring hanya total untuk saldo
  // awal otomatis: aset yang sidiknya sudah tercatat tidak dijumlahkan lagi.
  const barisAset = aset.baris as BarisAset[];
  const barisAsetBaru = barisAset.filter((r) => !sudahDiimpor('ASET', r.baris));
  if (barisAsetBaru.length > 0) {
    const cutOffAset = opsi.tanggalCutOff ?? getTanggalLokalHariIni();
    const perkiraan = hitungHasilAset(
      barisAsetBaru.map((r) => ({
        baris: r.baris,
        nomorAset: r.nomorAset,
        namaAset: r.namaAset,
        tanggalPerolehan: r.tanggalPerolehan,
        nilaiPerolehan: r.nilaiPerolehan,
        masaManfaatBulan: r.masaManfaatBulan,
        nilaiResidu: r.nilaiResidu,
        kelompokAset: r.kelompokAset,
        subKelompokAset: r.subKelompokAset,
      })),
      cutOffAset
    );
    totalPos.ASET_TETAP = (totalPos.ASET_TETAP ?? 0) + perkiraan.totalNilaiPerolehan;
    if (perkiraan.totalAkumulasiPenyusutan > 0) {
      totalPos.AKUMULASI_PENYUSUTAN =
        (totalPos.AKUMULASI_PENYUSUTAN ?? 0) + perkiraan.totalAkumulasiPenyusutan;
    }
  }

  // ============================================================
  // ---- 6. SALDO AWAL AKUN OTOMATIS ----
  // ============================================================
  //
  // Dijalankan SETELAH seluruh buku pembantu terisi, karena angkanya
  // berasal dari sana. Kegagalannya TIDAK menggagalkan import yang
  // datanya sudah masuk — dilaporkan per pos supaya pengguna tahu mana
  // yang perlu diisi manual.
  let saldoAwal: HasilSaldoAwalOtomatis | null = null;
  const cutOffSaldo = opsi.tanggalCutOff ?? getTanggalLokalHariIni();
  if (Object.keys(totalPos).length > 0) {
    try {
      const dbSaldo = opsi.dbMigrasi ?? (await getDb());
      saldoAwal = await isiSaldoAwalOtomatis(dbSaldo, totalPos, {
        tanggalCutOff: cutOffSaldo,
        createdBy: opsi.createdBy,
      });
    } catch (e) {
      console.error('[ImportDataAwal] gagal mengisi saldo awal otomatis:', e);
    }
  }
  // RC-S133.4.5 — rekonsiliasi dihitung ULANG setelah saldo awal terisi
  // otomatis (dulu menyatakan "belum diisi" padahal sudah).
  if (migrasi) {
    try {
      const dbRek = opsi.dbMigrasi ?? (await getDb());
      migrasi.rekonsiliasi = await rekonsiliasiUlangMigrasi(
        dbRek,
        migrasi.rekonsiliasi.totalSisaPokokBukuPembantu,
        migrasi.rekonsiliasi.totalPiutangJasaBukuPembantu
      );
    } catch (e) {
      console.error('[ImportDataAwal] gagal merekonsiliasi ulang migrasi:', e);
    }
  }

  // Aset ditulis SESUDAH saldo awal, karena periode penyusutan masa
  // lalu merujuk jurnal saldo awal Akumulasi Penyusutan.
  if (barisAset.length > 0) {
    const cutOffAset = opsi.tanggalCutOff ?? getTanggalLokalHariIni();
    try {
      const dbAset = opsi.dbMigrasi ?? (await getDb());
      const journalIdAkumulasi = await journalIdSaldoAwal(dbAset, 'PENYUSUTAN_ASET', 'KREDIT_AKUMULASI');
      hasilAset = await jalankanMigrasiAset(
        dbAset,
        barisAset.map((r) => ({
          baris: r.baris,
          nomorAset: r.nomorAset,
          namaAset: r.namaAset,
          tanggalPerolehan: r.tanggalPerolehan,
          nilaiPerolehan: r.nilaiPerolehan,
          masaManfaatBulan: r.masaManfaatBulan,
          nilaiResidu: r.nilaiResidu,
          kelompokAset: r.kelompokAset,
          subKelompokAset: r.subKelompokAset,
        })),
        { tanggalCutOff: cutOffAset, createdBy: opsi.createdBy, journalIdAkumulasi }
      );
      for (const b of hasilAset.berhasil) {
        catatBerhasil('ASET', b.baris, `${b.nomorAset} — ${b.namaAset}`);
        await simpanSidik('ASET', b.baris, `${b.nomorAset} — ${b.namaAset}`, 'BERHASIL', null, null);
      }
      for (const d of hasilAset.dilewati) catatGagal('ASET', d.baris, 'Migrasi aset', new Error(d.pesan));
    } catch (e) {
      if (e instanceof ValidasiMigrasiAsetGagalError) {
        const perBaris = new Map<number, string[]>();
        for (const g of e.galat) {
          const daftar = perBaris.get(g.baris) ?? [];
          daftar.push(g.pesan);
          perBaris.set(g.baris, daftar);
        }
        for (const [nomorBaris, pesan] of perBaris) {
          catatGagal('ASET', nomorBaris, 'Migrasi aset', new Error(pesan.join(' ')));
        }
      } else {
        for (const r of barisAset) catatGagal('ASET', r.baris, 'Migrasi aset', e);
      }
    }
    for (let i = 0; i < barisAset.length; i++) majukan();
  }

  // ============================================================
  // ---- 7. SALDO AWAL AKUN (RC-S133.4.6) ----
  // ============================================================
  //
  // Mengisi Saldo Awal Akun dari sheet 7 lewat `tambahSaldoAwalAkun()` —
  // service yang SAMA dengan menu Saldo Awal (jurnal berpasangan dengan
  // akun kliring 3-5000, audit log, kunci saldo awal tetap dihormati).
  // Dijalankan SETELAH saldo awal otomatis & aset (pos dari buku pembantu
  // sudah ada, sehingga baris sheet 7 yang menunjuk akun yang sama ditolak
  // dengan pesan jelas, bukan menggandakan) dan SEBELUM sheet 6, supaya
  // rekonsiliasi jasa dibayar membaca saldo awal Pendapatan Jasa dari sheet 7.
  let saldoAwalAkun: HasilSheetSaldoAwalAkun | null = null;
  if (barisAkun.length > 0) {
    saldoAwalAkun = { berhasil: [], gagal: [], saldoKliring: null };
    if (!opsi.tanggalCutOff) {
      for (const r of barisAkun) {
        saldoAwalAkun.gagal.push({ baris: r.baris, kodeAkun: r.kodeAkun, pesan: PESAN_SALDO_AWAL_AKUN_TANPA_CUTOFF });
        majukan();
      }
    } else {
      const dbA = opsi.dbMigrasi ?? (await getDb());
      let kliringId: string | null = null;
      try {
        kliringId = await resolveAccountId(dbA, 'KOREKSI_SALDO_AWAL', 'KLIRING');
      } catch {
        kliringId = null;
      }
      // Akun yang saldo awalnya diisi OTOMATIS oleh import ini.
      const otomatis = new Map<string, string>();
      for (const pos of Object.keys(totalPos) as PosSaldoAwalOtomatis[]) {
        try {
          const m = PEMETAAN_POS[pos];
          otomatis.set(await resolveAccountId(dbA, m.tipeTransaksi, m.peran), `${m.label} (${m.asal})`);
        } catch {
          // pemetaan tidak ada: biarkan tambahSaldoAwalAkun yang menilai
        }
      }
      for (const r of barisAkun) {
        try {
          const akun = await dbA.getFirstAsync<{ id: string; kode: string; nama: string; kategori: string }>(
            `SELECT id, kode, nama, kategori FROM account WHERE kode = ?`,
            r.kodeAkun.trim()
          );
          if (!akun) {
            throw new Error(`Kode akun "${r.kodeAkun}" tidak ada di Daftar Akun aplikasi. Periksa kodenya di sheet "Daftar Akun" atau menu Akuntansi › Daftar Akun.`);
          }
          if (kliringId && akun.id === kliringId) {
            throw new Error(`"${akun.nama}" adalah akun penyeimbang saldo awal dan terisi sendiri — hapus baris ini.`);
          }
          const asal = otomatis.get(akun.id);
          if (asal) {
            throw new Error(`Saldo awal "${akun.nama}" sudah diisi otomatis dari ${asal} — hapus baris ini dari sheet 7.`);
          }
          if (r.bagianTunai !== null && akun.kategori !== 'PENDAPATAN' && akun.kategori !== 'BEBAN') {
            throw new Error('Kolom Bagian Tunai hanya untuk akun Pendapatan atau Beban — kosongkan untuk akun ini.');
          }
          await tambahSaldoAwalAkun({ accountId: akun.id, tanggal: opsi.tanggalCutOff, saldo: r.saldo, createdBy: opsi.createdBy });
          if (r.bagianTunai !== null) {
            await aturBagianTunaiSaldoAwal({ accountId: akun.id, bagianTunai: r.bagianTunai, actingUserId: opsi.createdBy });
          }
          saldoAwalAkun.berhasil.push({ baris: r.baris, kodeAkun: akun.kode, namaAkun: akun.nama, saldo: r.saldo, bagianTunai: r.bagianTunai });
        } catch (e) {
          saldoAwalAkun.gagal.push({ baris: r.baris, kodeAkun: r.kodeAkun, pesan: pesanGalat(e) });
        }
        majukan();
      }
      if (kliringId) {
        const k = await dbA.getFirstAsync<{ s: number }>(
          `SELECT COALESCE(SUM(je.debit - je.kredit), 0) AS s FROM journal_entry je JOIN journal j ON j.id = je.journal_id
           WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
          kliringId
        );
        saldoAwalAkun.saldoKliring = Number(k?.s ?? 0);
      }
    }
  }

  // ============================================================
  // ---- 6. JASA DIBAYAR SEBELUM CUT-OFF (RC-S133.4.3) ----
  // ============================================================
  //
  // Jalur saldo lama tidak mencatat angsuran yang sudah dibayar, jadi
  // jasa Jan–cut-off tidak ada di angsuran_pembayaran dan hilang dari
  // dasar SHU jasa usaha. Sheet ini mengisinya per anggota — TANPA
  // jurnal (sisi buku besarnya = saldo awal Pendapatan Jasa Pinjaman).
  //
  // Kode boleh berupa Kode Anggota di sheet 1 berkas ini ATAU nomor
  // anggota yang sudah ada di aplikasi, supaya koperasi yang SUDAH
  // mengimpor data awal cukup mengunggah sheet ini saja.
  let jasaDataAwal: RekonsiliasiJasaDataAwal | null = null;
  // RC-S133.4.5 — DASAR SHU JASA USAHA DARI RIWAYAT ANGSURAN. Angsuran
  // yang sudah dibayar kini tercatat di jadwal (LUNAS), jadi jasa yang
  // dibayar tiap anggota pada tahun buku berjalan sampai cut-off bisa
  // dihitung langsung (tanggal bayar = jatuh tempo, atau sehari sebelum
  // cut-off bila dibayar di muka) — sama seperti bila angsuran itu
  // dibayar lewat menu Pinjaman. Sheet 6 tetap MENGGANTI angka ini per
  // anggota (sheet 6 memuat juga pinjaman yang sudah lunas).
  if (opsi.tanggalCutOff && migrasi && migrasi.berhasil.length > 0) {
    try {
      const dbJ = opsi.dbMigrasi ?? (await getDb());
      const hariTerakhir = hariSebelum(opsi.tanggalCutOff);
      const awalTahun = `${hariTerakhir.slice(0, 4)}-01-01`;
      const nomorList = migrasi.berhasil.map((b) => b.nomorPinjaman);
      const per = new Map<string, number>();
      for (let i = 0; i < nomorList.length; i += 400) {
        const potong = nomorList.slice(i, i + 400);
        const rows = await dbJ.getAllAsync<{ anggota_id: string; tgl: string; jasa: number }>(
          `SELECT p.anggota_id, CASE WHEN j.tanggal_jatuh_tempo < ? THEN j.tanggal_jatuh_tempo ELSE ? END AS tgl, j.jasa
           FROM angsuran_jadwal j JOIN pinjaman p ON p.id = j.pinjaman_id
           WHERE j.status = 'LUNAS' AND j.jasa > 0 AND p.nomor_pinjaman IN (${potong.map(() => '?').join(',')})`,
          opsi.tanggalCutOff,
          hariTerakhir,
          ...potong
        );
        for (const r of rows) if (r.tgl >= awalTahun && r.tgl <= hariTerakhir) per.set(r.anggota_id, (per.get(r.anggota_id) ?? 0) + Number(r.jasa));
      }
      for (const [anggotaId, jasa] of per) await simpanJasaDataAwal(dbJ, { anggotaId, tanggal: hariTerakhir, jasa });
      if (per.size > 0 && barisJasa.length === 0) jasaDataAwal = await rekonsiliasiJasaDataAwal(dbJ);
    } catch (e) {
      console.error('[ImportDataAwal] gagal menghitung jasa dibayar dari riwayat angsuran:', e);
    }
  }
  if (barisJasa.length > 0) {
    if (!opsi.tanggalCutOff) {
      for (const r of barisJasa) {
        catatGagal('JASA', r.baris, r.kode, new Error(PESAN_JASA_TANPA_CUTOFF));
        majukan();
      }
    } else {
      const tanggalJasa = hariSebelum(opsi.tanggalCutOff);
      let dbJasa: SQLite.SQLiteDatabase | null = null;
      try {
        dbJasa = opsi.dbMigrasi ?? (await getDb());
        await requirePermission(dbJasa, opsi.createdBy, 'shu', 'create');
      } catch (e) {
        for (const r of barisJasa) {
          catatGagal('JASA', r.baris, r.kode, e);
          majukan();
        }
        dbJasa = null;
      }
      if (dbJasa) {
        let adaTersimpan = false;
        for (const r of barisJasa) {
          try {
            let a = petaAnggota.get(r.kode.toUpperCase()) ?? null;
            if (!a) {
              const row = await dbJasa.getFirstAsync<{ id: string; nomor_anggota: string; nama_lengkap: string }>(
                `SELECT id, nomor_anggota, nama_lengkap FROM anggota WHERE UPPER(nomor_anggota) = ?`,
                r.kode.toUpperCase()
              );
              if (row) a = { id: row.id, nomorAnggota: row.nomor_anggota, nama: row.nama_lengkap };
            }
            if (!a) {
              throw new Error(
                `Anggota "${r.kode}" tidak ditemukan — isi dengan Kode Anggota di sheet 1 berkas ini, atau nomor anggota yang sudah ada di aplikasi (mis. A00001).`
              );
            }
            await simpanJasaDataAwal(dbJasa, { anggotaId: a.id, tanggal: tanggalJasa, jasa: r.jasa });
            adaTersimpan = true;
            catatBerhasil('JASA', r.baris, `${a.nomorAnggota} — ${a.nama} · jasa Rp${r.jasa.toLocaleString('id-ID')}`);
          } catch (e) {
            catatGagal('JASA', r.baris, r.nama ? `${r.kode} — ${r.nama}` : r.kode, e);
          }
          majukan();
        }
        if (adaTersimpan) {
          try {
            jasaDataAwal = await rekonsiliasiJasaDataAwal(dbJasa);
          } catch (e) {
            console.error('[ImportDataAwal] gagal merekonsiliasi jasa data awal:', e);
          }
        }
      }
    }
  }

  const perSheet: HasilPerSheet[] = URUTAN_PROSES.map((jenis) => {
    const ps: HasilPerSheet = {
      jenis,
      label: LABEL_SHEET[jenis],
      berhasil: hitung[jenis].berhasil,
      gagal: hitung[jenis].gagal,
    };
    // RC-S133.6.2 — hanya diisi bila ada, supaya bentuk ringkasan import tanpa
    // baris dilewati tetap sama persis dengan sebelumnya.
    if (hitung[jenis].dilewati > 0) {
      ps.dilewati = hitung[jenis].dilewati;
      ps.rincianDilewati = dilewati
        .filter((d) => d.jenis === jenis)
        .map((d) => ({ baris: d.baris, keterangan: d.keterangan, pesan: d.pesan }));
    }
    return ps;
  });

  const hasil: HasilImportDataAwal = {
    perSheet,
    gagal,
    berhasil,
    totalBerhasil: perSheet.reduce((t, s) => t + s.berhasil, 0),
    totalGagal: perSheet.reduce((t, s) => t + s.gagal, 0),
    dilewati,
    totalDilewati: dilewati.length,
    sidikBerkas: sidikBerkas.sidikBerkas,
    migrasi,
    keterbatasanTurunan,
    aset: hasilAset,
    saldoAwal,
    jasaDataAwal,
    saldoAwalAkun,
  };

  // RC-S100 — CATAT RIWAYAT.
  //
  // Dilakukan di sini, bukan di layar, supaya riwayat tetap tersimpan
  // walau pengguna langsung menutup layar setelah import selesai —
  // justru pada import yang banyak gagal, itulah yang biasanya terjadi.
  //
  // Kegagalan pencatatan TIDAK boleh menggagalkan import yang datanya
  // SUDAH masuk: yang dikembalikan tetap `hasil` yang benar, dan
  // kesalahannya dicatat ke console. Melempar di sini akan membuat layar
  // menampilkan "import gagal" padahal barisnya sudah tertulis ke
  // database — kesalahan yang jauh lebih mahal daripada kehilangan satu
  // entri riwayat.
  try {
    const db = opsi.dbRiwayat ?? (await getDb());
    const riwayatId = await catatRiwayatImport(db, hasil, {
      dijalankanOleh: opsi.createdBy,
      namaBerkas: opsi.namaBerkas ?? null,
      // Jam ASLI, bukan jam simulasi — lihat KonteksCatatRiwayat.
      dijalankanPada: new Date(),
    });
    if (sidikDicatat.length > 0) await tautkanSidikKeRiwayat(db, sidikDicatat, riwayatId);
  } catch (e) {
    console.error('[ImportDataAwal] gagal mencatat riwayat import:', e);
  }

  return hasil;
}
