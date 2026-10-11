import * as SQLite from 'expo-sqlite';
import { getAccountBalance, getAccountBalancesBulk } from '@/accounting/AccountingEngine';
import { getTrialBalance as getTrialBalanceImpl, getLedger as getLedgerImpl } from '@/accounting/Ledger';
import type { TrialBalanceRow, TrialBalanceResult, LedgerLine } from '@/accounting/Ledger';
import { classifyTransaction, AktivitasKas } from '@/accounting/CashFlowClassification';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { getPenyajianAmortizedCostPerTanggal } from '@/accounting/EirPresentationReadModel';
import { hitungRealisasiKasSaldoAwal } from '@/accounting/SaldoAwalRealisasiKas';
import { Rupiah, sum } from '@/utils/money';
import { AKUN_OCI, SUMBER_JURNAL_OCI, type KelompokOci } from '@/config/ociPolicy';

import { getKebijakanAkuntansiNarasi } from '@/services/AccountingPolicyService';
import { listAsetDenganNilaiBuku } from '@/services/AsetService';
import { listInvestasi } from '@/services/InvestasiService';
import { listUtang, getSaldoUtangBunga } from '@/services/UtangService';
import { getSaldoUtangImbalanKerja } from '@/services/ImbalanKerjaService';
import { getTotalPenyisihanTarget } from '@/services/LoanImpairmentService';
import { getTotalImpairmentInvestasi, getNilaiTercatatInvestasi } from '@/services/InvestasiImpairmentService';

/**
 * Akun kontra/klering "SHU Tahun Berjalan" (kode 3-4000, mapping
 * SHU_DISTRIBUSI/DEBIT_SHU_BERJALAN — lihat ShuService.bagikanSHU &
 * defaultCOA.ts). Akun ini TIDAK PERNAH dikredit oleh transaksi lain
 * -- satu-satunya jurnal yang menyentuhnya adalah jurnal distribusi
 * SHU (DEBIT akun ini sebesar total_shu). Karena itu akun ini murni
 * berfungsi sebagai "penyeimbang teknis" terhadap labaBerjalan yang
 * dihitung on-the-fly (lihat penjelasan panjang di getPosisiKeuangan
 * di bawah) — TIDAK boleh ditampilkan sebagai baris ekuitas biasa ke
 * pengguna karena akan membingungkan (muncul sebagai "ekuitas
 * negatif" yang tidak ada artinya bagi user awam).
 */
const SHU_BERJALAN_ACCOUNT_KODE = '3-4000';

/**
 * Batas bawah rentang "sejak awal ledger" untuk hasil usaha KUMULATIF
 * di Posisi Keuangan (lihat komentar panjang di getPosisiKeuangan).
 * Sengaja tanggal kalender yang pasti lebih awal dari transaksi mana
 * pun, BUKAN query MIN(tanggal) tambahan — supaya tidak ada round-trip
 * database ekstra dan hasilnya deterministik.
 */
const AWAL_LEDGER = '1900-01-01';

/**
 * Semua fungsi di sini MEMBACA LANGSUNG dari journal/journal_entry
 * (lewat getTrialBalance/getAccountBalance/getLedger, atau query
 * langsung dengan pola yang sama) — TIDAK ADA data dummy, dan TIDAK
 * ADA saldo yang dihitung terpisah dari jurnal (PRD §24-27).
 */

async function getPeriodBounds(
  db: SQLite.SQLiteDatabase,
  tanggal: string
): Promise<{ periodeMulai: string; periodeSelesai: string; tahunBuku: number } | null> {
  const row = await db.getFirstAsync<{ periode_mulai: string; periode_selesai: string; tahun_buku: number }>(
    `SELECT periode_mulai, periode_selesai, tahun_buku FROM accounting_period
     WHERE ? BETWEEN periode_mulai AND periode_selesai
     ORDER BY periode_mulai DESC LIMIT 1`,
    tanggal
  );
  return row
    ? { periodeMulai: row.periode_mulai, periodeSelesai: row.periode_selesai, tahunBuku: row.tahun_buku }
    : null;
}

/** ID accounting_period yang menaungi satu tanggal — dipakai CALK untuk kunci `calk_note.period_id`. */
export async function resolveAccountingPeriodId(db: SQLite.SQLiteDatabase, tanggal: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM accounting_period WHERE ? BETWEEN periode_mulai AND periode_selesai ORDER BY periode_mulai DESC LIMIT 1`,
    tanggal
  );
  return row?.id ?? null;
}

/** Status siklus SHU untuk tahun buku yang menaungi asOfDate — dipakai
 * getPosisiKeuangan untuk menentukan label & nilai "SHU/Laba Tahun
 * Berjalan" yang benar secara akuntansi (lihat komentar panjang di
 * getPosisiKeuangan). BELUM_DIHITUNG dipakai baik saat konfigurasi
 * SHU belum ada sama sekali MAUPUN saat masih berstatus DRAFT
 * (persentase disimpan tapi belum dihitung) — dari sudut pandang
 * Posisi Keuangan, keduanya sama-sama berarti "belum ada penutupan
 * apa pun terhadap laba periode berjalan". */
export type ShuPeriodStatus = 'BELUM_DIHITUNG' | 'DIHITUNG' | 'DIBAGIKAN';

async function getShuStatusUntukTahunBuku(
  db: SQLite.SQLiteDatabase,
  tahunBuku: number
): Promise<ShuPeriodStatus> {
  const row = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM shu_konfigurasi WHERE tahun_buku = ?`,
    tahunBuku
  );
  if (!row) return 'BELUM_DIHITUNG';
  if (row.status === 'DIBAGIKAN') return 'DIBAGIKAN';
  if (row.status === 'DIHITUNG') return 'DIHITUNG';
  return 'BELUM_DIHITUNG'; // status DRAFT
}

// ============================================================
// 1. NERACA SALDO — reuse getTrialBalance (Ledger.ts), sudah benar dan
//    langsung dari journal_entry.
// ============================================================
export const getTrialBalance = getTrialBalanceImpl;
export type { TrialBalanceRow, TrialBalanceResult };

// ============================================================
// 2. BUKU BESAR — reuse getLedger (Ledger.ts).
// ============================================================
export const getLedger = getLedgerImpl;
export type { LedgerLine };

// ============================================================
// 3. LAPORAN POSISI KEUANGAN (PRD §24)
// ============================================================
export interface PosisiKeuanganRow {
  kode: string;
  nama: string;
  saldo: Rupiah;
}

export interface PosisiKeuanganResult {
  asOfDate: string;
  aset: PosisiKeuanganRow[];
  liabilitas: PosisiKeuanganRow[];
  ekuitas: PosisiKeuanganRow[];
  labaBerjalan: Rupiah; // SHU/laba tahun berjalan yang belum ditutup ke ekuitas
  labaBerjalanLabel: string; // label yang sudah memperhitungkan status SHU (belum dihitung/dihitung/dibagikan)
  shuStatus: ShuPeriodStatus | null; // null jika asOfDate tidak masuk periode akuntansi manapun
  tahunBuku: number | null;
  totalAset: Rupiah;
  totalLiabilitas: Rupiah;
  totalEkuitas: Rupiah; // termasuk labaBerjalan
  isBalanced: boolean;
  selisih: Rupiah;
  /**
   * Audit ulang (permintaan pengguna §8/§11): true kalau laporan ini
   * memasukkan baris Saldo Awal yang MASIH DRAFT (belum diposting —
   * `saldo_awal_akun.journal_id IS NULL`) ke dalam angka Aset/
   * Liabilitas/Ekuitas di atas. Hanya true kalau caller SECARA
   * EKSPLISIT meminta lewat `opts.sertakanSaldoAwalDraft` DAN memang
   * ada draft yang tergabung — UI WAJIB menampilkan indikator "Termasuk
   * Saldo Awal Draft" saat true, supaya pengguna tahu laporan ini
   * belum final (draft BUKAN jurnal POSTED — lihat SaldoAwalAkunService.ts).
   */
  termasukSaldoAwalDraft: boolean;
  /**
   * RC-S133.6.2 — rincian baris SHU (angka TIDAK berubah; hanya dipecah):
   *   shuTahunBerjalan    = hasil usaha awal tahun buku s.d. tanggal laporan
   *                         (= Laporan Hasil Usaha periode yang sama);
   *   shuTahunSebelumnya  = sisa hasil usaha tahun-tahun buku sebelumnya
   *                         yang belum dibagikan (= labaBerjalan − shuTahunBerjalan).
   * Jumlah keduanya SELALU = labaBerjalan. null bila tanggal laporan di luar
   * periode akuntansi (tidak ada batas tahun buku untuk memecahnya).
   */
  rincianLabaBerjalan?: { tahunBuku: number; shuTahunSebelumnya: Rupiah; shuTahunBerjalan: Rupiah } | null;
}

/** RC-S133.6.2 — label baris SHU bila komponen tahun sebelumnya ikut tergabung. */
export const LABEL_SHU_GABUNGAN = 'SHU Tahun Sebelumnya yang Belum Dibagikan dan SHU Tahun Berjalan';
export const LABEL_SHU_TAHUN_SEBELUMNYA = 'SHU Tahun Sebelumnya yang Belum Dibagikan';

export interface GetPosisiKeuanganOpts {
  /**
   * Audit ulang (permintaan pengguna §8/§11): kalau true, baris Saldo
   * Awal yang MASIH DRAFT (`saldo_awal_akun.journal_id IS NULL`) ikut
   * digabungkan ke Aset/Liabilitas/Ekuitas — supaya pengguna bisa
   * melihat posisi sementara SEBELUM saldo awal diposting. Default
   * false (perilaku lama tidak berubah kalau opts tidak diisi) — draft
   * TIDAK PERNAH memengaruhi Laba Rugi/Arus Kas/Buku Besar/Neraca
   * Saldo/jurnal POSTED, HANYA laporan ini & HANYA kalau diminta
   * eksplisit (§11: "kecuali laporan tersebut secara eksplisit
   * memiliki mode 'termasuk draft'").
   */
  sertakanSaldoAwalDraft?: boolean;
}

export async function getPosisiKeuangan(
  db: SQLite.SQLiteDatabase,
  asOfDate: string,
  opts: GetPosisiKeuanganOpts = {}
): Promise<PosisiKeuanganResult> {
  const trial = await getTrialBalanceImpl(db, asOfDate);

  const accounts = await db.getAllAsync<{ id: string; kode: string; kategori: string; normal_balance: string }>(
    `SELECT id, kode, kategori, normal_balance FROM account`
  );
  const accountInfoById = new Map(
    accounts.map((a) => [a.id, { kode: a.kode, kategori: a.kategori, normalBalance: a.normal_balance }])
  );

  const aset: PosisiKeuanganRow[] = [];
  const liabilitas: PosisiKeuanganRow[] = [];
  const ekuitas: PosisiKeuanganRow[] = [];

  // Saldo akun klering "SHU Tahun Berjalan" (3-4000) — DIKELUARKAN dari
  // baris ekuitas normal (lihat komentar SHU_BERJALAN_ACCOUNT_KODE di
  // atas), tapi tetap dihitung untuk dipakai menetralkan labaBerjalan
  // di bawah.
  let shuBerjalanSaldo = 0;

  for (const row of trial.rows) {
    const info = accountInfoById.get(row.accountId);
    if (!info) continue;
    const { kode, kategori, normalBalance } = info;

    // BUG FIX (dilaporkan user): akun kontra (mis. "Akumulasi Penyusutan
    // Aset Tetap" & "Penyisihan Piutang Tak Tertagih" — kategori ASET
    // tapi normal_balance KREDIT) sebelumnya diambil nilainya lewat
    // `row.debit > 0 ? row.debit : row.kredit` — cuma mengambil sisi
    // mana pun yang tidak nol TANPA memperhatikan bahwa akun ini
    // seharusnya MENGURANGI total aset, bukan menambahnya. Akibatnya
    // akumulasi penyusutan yang tercatat justru ikut DIJUMLAHKAN ke
    // Total Aset alih-alih mengurangi nilai buku aset tetap.
    //
    // Fix: bandingkan normal_balance akun tsb dengan ekspektasi normal
    // kategorinya (ASET->DEBIT, LIABILITAS/EKUITAS->KREDIT). Kalau
    // cocok (akun biasa) -> saldo positif seperti biasa. Kalau BERTOLAK
    // BELAKANG (akun kontra) -> saldo NEGATIF, supaya otomatis
    // mengurangi total seksi tempat dia ditampilkan (tetap ditampilkan
    // di seksi ASET seperti "Akumulasi Penyusutan Aset Tetap: (Rp...)",
    // bukan disembunyikan — transparan sebagai pengurang, bukan
    // dipindah ke seksi lain).
    let saldo: number;
    if (kategori === 'ASET') {
      saldo = normalBalance === 'DEBIT' ? row.debit : -row.kredit;
    } else if (kategori === 'LIABILITAS' || kategori === 'EKUITAS') {
      saldo = normalBalance === 'KREDIT' ? row.kredit : -row.debit;
    } else {
      continue; // PENDAPATAN/BEBAN tidak masuk posisi keuangan
    }

    if (kategori === 'EKUITAS' && kode === SHU_BERJALAN_ACCOUNT_KODE) {
      shuBerjalanSaldo = saldo;
      continue; // jangan ditampilkan sebagai baris ekuitas biasa
    }

    const target: PosisiKeuanganRow = { kode: row.kode, nama: row.nama, saldo };
    if (kategori === 'ASET') aset.push(target);
    else if (kategori === 'LIABILITAS') liabilitas.push(target);
    else if (kategori === 'EKUITAS') ekuitas.push(target);
  }

  // ============================================================
  // SHU/Laba Tahun Berjalan — PERBAIKAN AKUNTANSI (lihat Prioritas 1
  // instruksi perbaikan).
  //
  // Konsep: karena akun Pendapatan/Beban TIDAK pernah ditutup
  // (closing entry) oleh aplikasi ini, `getLabaRugi(periodeMulai,
  // asOfDate)` SELALU mengembalikan total hasil usaha kumulatif tahun
  // buku ybs, TERLEPAS dari apakah SHU tahun buku itu sudah
  // dihitung/dibagikan atau belum ("labaBerjalan mentah").
  //
  // Sebelum ada jurnal distribusi SHU, labaBerjalan mentah ITU SUDAH
  // BENAR untuk ditampilkan sebagai "SHU/Laba Tahun Berjalan (belum
  // dibagikan)" — supaya Aset = Liabilitas + Ekuitas tetap valid
  // sebelum penutupan formal.
  //
  // Begitu SHU dibagikan (bagikanSHU() di ShuService.ts), jurnal
  // distribusi men-DEBIT akun klering "SHU Tahun Berjalan" (3-4000)
  // sebesar total_shu — akun ini tidak pernah dikredit oleh transaksi
  // lain, jadi begitu didebit ia bersaldo NEGATIF sebesar -total_shu.
  // Nilai itulah (shuBerjalanSaldo) yang dipakai untuk MENETRALKAN
  // labaBerjalan mentah — BUKAN dengan memaksa labaBerjalan = 0.
  //
  // Hasilnya:
  //  - Belum dihitung/belum dibagikan -> shuBerjalanSaldo = 0 ->
  //    labaBerjalanEfektif = labaBerjalan mentah (tidak berubah dari
  //    perilaku sebelumnya).
  //  - Sudah dibagikan & tidak ada transaksi pendapatan/beban baru
  //    setelah itu untuk tahun buku yg sama -> labaBerjalan mentah
  //    persis sama dengan total_shu yang didistribusikan ->
  //    labaBerjalanEfektif = 0 secara ALAMIAH dari matematika ledger,
  //    BUKAN karena di-hardcode. Nilai itu sudah "pindah" ke Cadangan/
  //    Ekuitas Lainnya/Simpanan Sukarela lewat jurnal distribusi.
  //  - Sudah dibagikan TAPI ada transaksi pendapatan/beban baru
  //    sesudahnya (mis. koreksi/transaksi terlambat) -> residualnya
  //    TETAP TAMPIL apa adanya (tidak disembunyikan), sebagai sinyal
  //    yang perlu ditelusuri user (lihat labaBerjalanLabel).
  //  - Tahun buku BERIKUTNYA (periode baru) -> getPeriodBounds sudah
  //    otomatis mengganti periodeMulai ke awal tahun buku baru,
  //    sehingga labaBerjalan mentah tahun baru TIDAK tersentuh oleh
  //    status distribusi SHU tahun sebelumnya sama sekali.
  // ============================================================
  // BUG FIX (audit v49 — "tahun buku ke-3 tidak rekonsiliasi" &
  // "labaBerjalan -20.000.000 setelah SHU dibagikan"):
  // `labaBerjalanMentah` SEBELUMNYA dihitung dari AWAL TAHUN BUKU
  // BERJALAN saja (`bounds.periodeMulai`), sedangkan `shuBerjalanSaldo`
  // (akun kliring 3-4000) bersifat KUMULATIF SEPANJANG MASA — akun itu
  // tidak pernah di-nol-kan. Dua besaran dengan cakupan periode berbeda
  // itu lalu dijumlahkan, sehingga sejak tahun buku KEDUA hasilnya
  // salah.
  //
  // Buktinya dari ledger (fixture dua tahun, per 2027-04-01):
  //   Kas                 40.000.000 (5jt modal + 20jt laba 2025 + 15jt laba 2026)
  //   Simpanan Sukarela   14.000.000 (liabilitas hasil distribusi)
  //   Simpanan Pokok       5.000.000
  //   Cadangan             7.000.000 (4jt + 3jt)
  //   Ekuitas Lainnya     14.000.000 (8jt + 6jt)
  //   3-4000             (35.000.000) kumulatif (20jt + 15jt)
  // Dengan rumus lama: laba 2027 (=0) + (35.000.000) = (35.000.000),
  // total ekuitas jadi (9.000.000) dan Aset 40jt != 14jt + (9jt).
  //
  // Sebabnya: KOPKU TIDAK PERNAH membuat closing entry, jadi laba
  // tahun-tahun SEBELUMNYA tidak pernah pindah ke akun ekuitas
  // permanen. Yang berpindah hanyalah bagian yang DIDISTRIBUSIKAN
  // (lewat jurnal SHU_DISTRIBUSI: debit 3-4000, kredit Cadangan/
  // Ekuitas Lainnya/Simpanan). Karena itu, angka yang benar untuk
  // baris ini adalah HASIL USAHA KUMULATIF SEPANJANG MASA DIKURANGI
  // seluruh yang sudah didistribusikan — yaitu sisa hasil usaha yang
  // BELUM dibagikan. Cakupan kedua besaran kini SAMA (kumulatif),
  // sehingga Aset = Liabilitas + Ekuitas kembali seimbang di tahun
  // buku ke berapa pun:
  //   35.000.000 (laba kumulatif) + (35.000.000) = 0
  //   Ekuitas = 5jt + 7jt + 14jt + 0 = 26jt; 40jt = 14jt + 26jt  OK
  //
  // TIDAK ADA rumus akuntansi baru yang dibuat: `getLabaRugi()` yang
  // SAMA tetap dipakai, hanya rentang tanggalnya yang diperbaiki agar
  // konsisten dengan sifat kumulatif akun kliring. Laporan Laba Rugi
  // sendiri (per tahun buku) TIDAK tersentuh sama sekali.
  const bounds = await getPeriodBounds(db, asOfDate);
  let shuStatus: ShuPeriodStatus | null = null;
  let tahunBuku: number | null = null;

  const labaRugiKumulatif = await getLabaRugi(db, AWAL_LEDGER, asOfDate);
  const labaBerjalanMentah = labaRugiKumulatif.hasilUsaha;

  if (bounds) {
    tahunBuku = bounds.tahunBuku;
    shuStatus = await getShuStatusUntukTahunBuku(db, bounds.tahunBuku);
  }

  const labaBerjalan = labaBerjalanMentah + shuBerjalanSaldo;

  // RC-S133.6.2 — rincian baris SHU. Penyajian saja: labaBerjalan (angka &
  // rumus) tidak berubah, tidak ada jurnal penutup. Hasil usaha tahun berjalan
  // diambil dari getLabaRugi() yang SAMA dengan Laporan Hasil Usaha; sisanya
  // adalah SHU tahun-tahun sebelumnya yang belum dibagikan.
  let rincianLabaBerjalan: PosisiKeuanganResult['rincianLabaBerjalan'] = null;
  if (bounds) {
    const shuTahunBerjalan = (await getLabaRugi(db, bounds.periodeMulai, asOfDate)).hasilUsaha;
    rincianLabaBerjalan = {
      tahunBuku: bounds.tahunBuku,
      shuTahunBerjalan,
      shuTahunSebelumnya: labaBerjalan - shuTahunBerjalan,
    };
  }

  let labaBerjalanLabel: string;
  if (!bounds || shuStatus === 'BELUM_DIHITUNG') {
    // Kasus khusus yang sebelumnya salah label: tahun buku BERJALAN
    // memang belum menghitung SHU, TETAPI seluruh SHU tahun-tahun
    // sebelumnya SUDAH didistribusikan (jurnal SHU_DISTRIBUSI ada,
    // shuBerjalanSaldo != 0) dan sisanya nihil. Menyebutnya "belum
    // dibagikan" akan menyesatkan — yang benar: tidak ada sisa hasil
    // usaha yang menunggu pembagian.
    labaBerjalanLabel =
      labaBerjalan === 0 && shuBerjalanSaldo !== 0
        ? 'SHU/Laba Tahun Berjalan: nihil (seluruh SHU tahun buku sebelumnya sudah dibagikan)'
        : 'SHU/Laba Tahun Berjalan (belum dihitung, belum dibagikan)';
    // RC-S133.6.2 (temuan T-07, keputusan pengguna: PERBAIKI LABEL SAJA) —
    // baris ini kerap memuat SHU tahun buku sebelumnya yang belum dibagikan
    // DITAMBAH hasil usaha tahun berjalan. Label "Tahun Berjalan" hanya
    // dipakai bila memang hanya komponen tahun berjalan yang ada.
    if (rincianLabaBerjalan && rincianLabaBerjalan.shuTahunSebelumnya !== 0) {
      labaBerjalanLabel =
        rincianLabaBerjalan.shuTahunBerjalan !== 0 ? LABEL_SHU_GABUNGAN : LABEL_SHU_TAHUN_SEBELUMNYA;
    }
  } else if (shuStatus === 'DIHITUNG') {
    labaBerjalanLabel = 'SHU Tahun Berjalan (sudah dihitung, menunggu pembagian setelah RAT)';
  } else {
    // DIBAGIKAN
    if (labaBerjalan === 0) {
      labaBerjalanLabel = `SHU Tahun Buku ${tahunBuku} (sudah dibagikan — telah dialokasikan ke Cadangan/Ekuitas Lainnya/Simpanan Anggota)`;
    } else {
      // RC-S133.6 (AUDIT F-3) — status DIBAGIKAN di shu_konfigurasi adalah
      // status HARI INI, sedangkan laporan ini per `asOfDate`. Bila jurnal
      // distribusi tahun buku ini bertanggal SESUDAH tanggal laporan, sisa
      // hasil usaha per tanggal itu memang belum dialokasikan — bukan
      // "transaksi baru setelah distribusi yang perlu ditelusuri".
      // Angka tidak berubah; hanya label yang mengikuti tanggal laporan.
      const distribusi = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM journal
         WHERE sumber_transaksi = 'SHU_DISTRIBUSI' AND status IN ('POSTED','REVERSED')
           AND reversal_of_id IS NULL AND tanggal <= ?
           AND (sumber_id IS NULL OR sumber_id IN (SELECT id FROM shu_konfigurasi WHERE tahun_buku = ?))`,
        asOfDate,
        tahunBuku
      );
      labaBerjalanLabel =
        (distribusi?.n ?? 0) === 0
          ? `SHU Tahun Buku ${tahunBuku} (pembagiannya dicatat sesudah tanggal laporan ini)`
          : `Laba Tahun Berjalan Setelah Distribusi SHU ${tahunBuku} (transaksi pendapatan/beban baru tercatat setelah SHU dibagikan — perlu ditelusuri)`;
    }
  }

  const totalAsetPosted = sum(aset.map((r) => r.saldo));
  const totalLiabilitasPosted = sum(liabilitas.map((r) => r.saldo));
  const totalEkuitasPosted = sum(ekuitas.map((r) => r.saldo)) + labaBerjalan;

  // Audit ulang (permintaan pengguna §8/§11, diperbarui lagi di audit
  // ulang request baru §1): gabungkan baris Saldo Awal yang MASIH
  // DRAFT (journal_id IS NULL) HANYA kalau diminta eksplisit lewat
  // opts. Sejak request baru §1, `tambahSaldoAwalAkun` SEKARANG
  // mengizinkan draft untuk SEMUA kategori COA (termasuk PENDAPATAN/
  // BEBAN, bukan cuma akun neraca lagi) — TAPI laporan Posisi Keuangan
  // ini SECARA STRUKTURAL tidak punya tempat untuk baris Pendapatan/
  // Beban (itu tempatnya Laba Rugi, bukan di sini), jadi draft
  // berkategori PENDAPATAN/BEBAN SENGAJA DILEWATI (`continue` di
  // bawah) dari laporan INI — bukan hilang datanya, hanya belum
  // relevan ditampilkan di Posisi Keuangan selama masih draft. Setelah
  // benar-benar diposting (`postingSaldoAwal`), baris tersebut jadi
  // jurnal ledger sungguhan dan otomatis muncul di Laba Rugi/Buku
  // Besar/Neraca Saldo seperti transaksi biasa (laporan-laporan itu
  // ledger-based, bukan draft-aware) — konsisten dengan aturan §8/§11
  // sebelumnya: draft TIDAK PERNAH masuk ke Laba Rugi kecuali lewat
  // jurnal POSTED sungguhan.
  let termasukSaldoAwalDraft = false;
  if (opts.sertakanSaldoAwalDraft) {
    const draftRows = await db.getAllAsync<{ kode: string; nama: string; kategori: string; normal_balance: string; saldo: number }>(
      `SELECT a.kode, a.nama, a.kategori, a.normal_balance, s.saldo
       FROM saldo_awal_akun s JOIN account a ON a.id = s.account_id
       WHERE s.journal_id IS NULL`
    );
    if (draftRows.length > 0) {
      let adaDraftNeraca = false;
      for (const d of draftRows) {
        // Kontribusi bertanda — pola SAMA PERSIS dengan loop trial
        // balance di atas & `kontribusiBertanda` di SaldoAwalAkunService.ts
        // (akun kontra normal_balance berlawanan MENGURANGI, bukan menambah).
        let kontribusi: number;
        let daftar: PosisiKeuanganRow[];
        if (d.kategori === 'ASET') {
          kontribusi = d.normal_balance === 'DEBIT' ? d.saldo : -d.saldo;
          daftar = aset;
        } else if (d.kategori === 'LIABILITAS') {
          kontribusi = d.normal_balance === 'KREDIT' ? d.saldo : -d.saldo;
          daftar = liabilitas;
        } else if (d.kategori === 'EKUITAS') {
          kontribusi = d.normal_balance === 'KREDIT' ? d.saldo : -d.saldo;
          daftar = ekuitas;
        } else {
          continue; // PENDAPATAN/BEBAN — bukan bagian Posisi Keuangan, lihat komentar di atas
        }
        adaDraftNeraca = true;
        const existingRow = daftar.find((r) => r.kode === d.kode);
        if (existingRow) {
          existingRow.saldo += kontribusi;
        } else {
          daftar.push({ kode: d.kode, nama: d.nama, saldo: kontribusi });
        }
      }
      termasukSaldoAwalDraft = adaDraftNeraca;
    }
  }

  const totalAset = termasukSaldoAwalDraft ? sum(aset.map((r) => r.saldo)) : totalAsetPosted;
  const totalLiabilitas = termasukSaldoAwalDraft ? sum(liabilitas.map((r) => r.saldo)) : totalLiabilitasPosted;
  const totalEkuitas = termasukSaldoAwalDraft ? sum(ekuitas.map((r) => r.saldo)) + labaBerjalan : totalEkuitasPosted;
  const selisih = totalAset - (totalLiabilitas + totalEkuitas);

  return {
    asOfDate,
    aset,
    liabilitas,
    ekuitas,
    labaBerjalan,
    labaBerjalanLabel,
    shuStatus,
    tahunBuku,
    totalAset,
    totalLiabilitas,
    totalEkuitas,
    isBalanced: selisih === 0,
    selisih,
    termasukSaldoAwalDraft,
    rincianLabaBerjalan,
  };
}

// ============================================================
// 3b. AUDIT SELISIH NERACA (Prioritas 2/D) — diagnostic murni,
//     TIDAK PERNAH mengubah data. Menelusuri akar penyebab selisih
//     Aset ≠ Liabilitas+Ekuitas kalau ada, sampai ke tingkat akun &
//     jurnal individual — bukan cuma melaporkan angka selisihnya.
// ============================================================
export interface AuditBalanceAkunPenyebab {
  kode: string;
  nama: string;
  kategori: string;
  isActive: boolean;
  saldo: Rupiah;
  keterangan: string;
}

export interface AuditBalanceJournalPenyebab {
  journalId: string;
  nomorJurnal: string;
  tanggal: string;
  status: string;
  totalDebit: Rupiah;
  totalKredit: Rupiah;
  keterangan: string;
}

export interface AuditBalanceResult {
  asOfDate: string;
  totalAset: Rupiah;
  totalLiabilitas: Rupiah;
  totalEkuitas: Rupiah;
  expected: Rupiah; // totalLiabilitas + totalEkuitas
  selisih: Rupiah;  // totalAset - expected
  isBalanced: boolean;
  akunPenyebab: AuditBalanceAkunPenyebab[];
  journalPenyebab: AuditBalanceJournalPenyebab[];
}

/**
 * Audit sumber selisih Posisi Keuangan. Tidak pernah menyembunyikan
 * atau "meratakan" selisih (§AA) — hanya menelusuri & melaporkan.
 * Selalu jalan (bukan cuma saat isBalanced=false) supaya bisa dipakai
 * juga sebagai pemeriksaan rutin/test invariant.
 */
export async function auditBalancePosisiKeuangan(
  db: SQLite.SQLiteDatabase,
  asOfDate: string
): Promise<AuditBalanceResult> {
  const posisi = await getPosisiKeuangan(db, asOfDate);
  const akunPenyebab: AuditBalanceAkunPenyebab[] = [];
  const journalPenyebab: AuditBalanceJournalPenyebab[] = [];

  if (posisi.selisih !== 0) {
    // 1) Akun nonaktif dengan saldo historis — sejak fix Prioritas
    //    2/D, ini SUDAH ikut dihitung di getPosisiKeuangan, tapi tetap
    //    ditandai di sini secara eksplisit karena rawan jadi penyebab
    //    kalau ada laporan/turunan lain yang lupa mengikuti pola yang
    //    sama di masa depan.
    const inactiveWithBalance = await db.getAllAsync<{
      kode: string;
      nama: string;
      kategori: string;
      normal_balance: string;
      d: number;
      k: number;
    }>(
      `SELECT a.kode, a.nama, a.kategori, a.normal_balance,
              COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
       FROM account a
       JOIN journal_entry je ON je.account_id = a.id
       JOIN journal j ON j.id = je.journal_id
       WHERE a.is_active = 0 AND j.status IN ('POSTED','REVERSED') AND j.tanggal <= ?
       GROUP BY a.id`,
      asOfDate
    );
    for (const r of inactiveWithBalance) {
      const saldo = r.normal_balance === 'DEBIT' ? r.d - r.k : r.k - r.d;
      if (saldo === 0) continue;
      akunPenyebab.push({
        kode: r.kode,
        nama: r.nama,
        kategori: r.kategori,
        isActive: false,
        saldo,
        keterangan:
          'Akun nonaktif dengan saldo historis — pastikan seluruh laporan (bukan hanya Posisi Keuangan) ikut membacanya.',
      });
    }

    // 2) journal_entry "yatim" — account_id yang tidak ada lagi di
    //    tabel account (SQLite FK tidak di-enforce secara default di
    //    app ini — lihat db.ts, tidak ada PRAGMA foreign_keys=ON).
    //    Aplikasi tidak pernah menghapus akun (setAccountActive hanya
    //    soft-delete), jadi ini seharusnya SELALU kosong; kalau
    //    muncul berarti ada data korup dari sumber luar (mis. restore
    //    backup yang tidak lengkap).
    const orphanAccountEntries = await db.getAllAsync<{
      journal_id: string;
      account_id: string;
      debit: number;
      kredit: number;
    }>(
      `SELECT je.journal_id, je.account_id, je.debit, je.kredit
       FROM journal_entry je
       LEFT JOIN account a ON a.id = je.account_id
       JOIN journal j ON j.id = je.journal_id
       WHERE a.id IS NULL AND j.status IN ('POSTED','REVERSED') AND j.tanggal <= ?`,
      asOfDate
    );
    for (const r of orphanAccountEntries) {
      akunPenyebab.push({
        kode: '?',
        nama: `(akun tidak ditemukan, id=${r.account_id})`,
        kategori: '?',
        isActive: false,
        saldo: r.debit - r.kredit,
        keterangan: `journal_entry yatim mereferensikan account_id yang tidak ada di tabel account (journal_id=${r.journal_id}). Kemungkinan data korup — telusuri manual, JANGAN dihapus otomatis.`,
      });
    }

    // 3) journal_entry "yatim" — journal_id yang tidak ada lagi di
    //    tabel journal. Seharusnya juga selalu kosong.
    const orphanJournalEntries = await db.getAllAsync<{
      id: string;
      journal_id: string;
      account_id: string;
      debit: number;
      kredit: number;
    }>(
      `SELECT je.id, je.journal_id, je.account_id, je.debit, je.kredit
       FROM journal_entry je
       LEFT JOIN journal j ON j.id = je.journal_id
       WHERE j.id IS NULL`
    );
    for (const r of orphanJournalEntries) {
      journalPenyebab.push({
        journalId: r.journal_id,
        nomorJurnal: '(tidak ditemukan)',
        tanggal: '?',
        status: 'ORPHAN',
        totalDebit: r.debit,
        totalKredit: r.kredit,
        keterangan: `journal_entry (id=${r.id}) mereferensikan journal_id yang tidak ada di tabel journal. Data korup — telusuri manual.`,
      });
    }

    // 4) Jurnal individual (POSTED/REVERSED) yang debit≠kredit —
    //    seharusnya mustahil lewat createJournal() (§validateLines +
    //    isBalanced), jadi kalau ketemu berarti ada baris yang masuk
    //    lewat jalur di luar AccountingEngine (pelanggaran §"SELALU
    //    gunakan ... accounting engine ... pola transaksi existing").
    const unbalancedJournals = await db.getAllAsync<{
      id: string;
      nomor_jurnal: string;
      tanggal: string;
      status: string;
      d: number;
      k: number;
    }>(
      `SELECT j.id, j.nomor_jurnal, j.tanggal, j.status,
              COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
       FROM journal j JOIN journal_entry je ON je.journal_id = j.id
       WHERE j.status IN ('POSTED','REVERSED') AND j.tanggal <= ?
       GROUP BY j.id
       HAVING ABS(d - k) > 0`,
      asOfDate
    );
    for (const r of unbalancedJournals) {
      journalPenyebab.push({
        journalId: r.id,
        nomorJurnal: r.nomor_jurnal,
        tanggal: r.tanggal,
        status: r.status,
        totalDebit: r.d,
        totalKredit: r.k,
        keterangan: 'Jurnal tidak balance (debit ≠ kredit) — seharusnya tidak mungkin lewat AccountingEngine.createJournal(). Telusuri asal jurnal ini.',
      });
    }

    // 5) Akun dengan kategori di luar 5 kategori standar (ASET/
    //    LIABILITAS/EKUITAS/PENDAPATAN/BEBAN) — dijamin CHECK
    //    constraint di schema, tapi tetap diperiksa sebagai jaring
    //    pengaman kalau ada migrasi data lama yang lolos.
    const badCategoryEntries = await db.getAllAsync<{
      kode: string;
      nama: string;
      kategori: string;
      normal_balance: string;
      d: number;
      k: number;
    }>(
      `SELECT a.kode, a.nama, a.kategori, a.normal_balance,
              COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
       FROM account a
       JOIN journal_entry je ON je.account_id = a.id
       JOIN journal j ON j.id = je.journal_id
       WHERE a.kategori NOT IN ('ASET','LIABILITAS','EKUITAS','PENDAPATAN','BEBAN')
         AND j.status IN ('POSTED','REVERSED') AND j.tanggal <= ?
       GROUP BY a.id`,
      asOfDate
    );
    for (const r of badCategoryEntries) {
      const saldo = r.normal_balance === 'DEBIT' ? r.d - r.k : r.k - r.d;
      akunPenyebab.push({
        kode: r.kode,
        nama: r.nama,
        kategori: r.kategori,
        isActive: true,
        saldo,
        keterangan: 'Kategori akun tidak dikenali — tidak masuk perhitungan Posisi Keuangan manapun.',
      });
    }
  }

  return {
    asOfDate,
    totalAset: posisi.totalAset,
    totalLiabilitas: posisi.totalLiabilitas,
    totalEkuitas: posisi.totalEkuitas,
    expected: posisi.totalLiabilitas + posisi.totalEkuitas,
    selisih: posisi.selisih,
    isBalanced: posisi.isBalanced,
    akunPenyebab,
    journalPenyebab,
  };
}

// ============================================================
// 4. LAPORAN HASIL USAHA / LABA RUGI (PRD §25)
// ============================================================
export interface LabaRugiRow {
  kode: string;
  nama: string;
  jumlah: Rupiah;
}

/**
 * RC-S88 — satu pos Penghasilan Komprehensif Lain (OCI) pada periode.
 * `jumlah` positif = menambah ekuitas (mis. kenaikan surplus revaluasi),
 * negatif = mengurangi (penurunan yang dibebankan ke surplus).
 */
export interface OciRow {
  kode: string;
  nama: string;
  kelompok: KelompokOci;
  jumlah: Rupiah;
}

export interface LabaRugiResult {
  tanggalMulai: string;
  tanggalSelesai: string;
  pendapatan: LabaRugiRow[];
  beban: LabaRugiRow[];
  totalPendapatan: Rupiah;
  totalBeban: Rupiah;
  hasilUsaha: Rupiah; // SHU/Laba sebelum penghasilan komprehensif lain
  /**
   * Penghasilan Komprehensif Lain (OCI) — RC-S88. Sumbernya kini NYATA:
   * revaluasi aset tetap (SAK EP Bab 17) yang dijurnal lewat Penyesuaian
   * Nilai Wajar. Angkanya DIBACA dari mutasi akun ekuitas cadangan OCI
   * (lihat `src/config/ociPolicy.ts`) yang bersumber dari jurnal OCI
   * dalam periode — tidak pernah dikarang. Tanpa transaksi OCI nilainya
   * 0 dan UI menyatakannya eksplisit (§G: "Jika tidak ada transaksi
   * OCI: jangan membuat angka fiktif").
   */
  penghasilanKomprehensifLain: Rupiah;
  /** Rincian pos OCI periode ini (hanya pos yang bermutasi). */
  penghasilanKomprehensifLainRows: OciRow[];
  totalPenghasilanKomprehensif: Rupiah; // hasilUsaha + penghasilanKomprehensifLain
}

/**
 * Berbeda dari Neraca Saldo (kumulatif sejak awal), Pendapatan & Beban
 * adalah akun ARUS (flow) — dihitung HANYA dari mutasi journal_entry
 * dalam rentang [tanggalMulai, tanggalSelesai], bukan kumulatif.
 */
export async function getLabaRugi(
  db: SQLite.SQLiteDatabase,
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<LabaRugiResult> {
  // BUG FIX (Prioritas 2/D, sama seperti getTrialBalance di Ledger.ts):
  // filter `is_active = 1` sebelumnya bisa membuat Laba Rugi periode
  // LAMA berubah nilainya begitu sebuah akun Pendapatan/Beban
  // dinonaktifkan di masa sekarang — padahal transaksi historisnya
  // tetap sah. Laporan periode yang sudah lewat tidak boleh berubah
  // hanya karena status aktif akun berubah hari ini.
  const accounts = await db.getAllAsync<{
    id: string;
    kode: string;
    nama: string;
    kategori: string;
    normal_balance: string;
  }>(`SELECT id, kode, nama, kategori, normal_balance FROM account
      WHERE kategori IN ('PENDAPATAN','BEBAN') ORDER BY kode ASC`);

  const pendapatan: LabaRugiRow[] = [];
  const beban: LabaRugiRow[] = [];

  for (const acc of accounts) {
    const s = await db.getFirstAsync<{ d: number; k: number }>(
      // PENTING (bug fix, lihat AUDIT_INTERNAL.md §3.5): jurnal REVERSED
      // harus ikut dihitung, SAMA seperti getAccountBalance() &
      // Ledger.ts — jurnal asal yang di-reversal statusnya jadi
      // REVERSED (bukan POSTED lagi), tapi entrinya tetap fakta
      // historis yang valid & sudah dinetralkan oleh jurnal reversal-
      // nya sendiri (yang berstatus POSTED). Filter 'POSTED' saja
      // sebelumnya membuat Laba Rugi HANYA menghitung sisi reversal-nya
      // (bukan net nol) untuk periode yang mengandung koreksi —
      // salah hitung & tidak cocok dengan Neraca Saldo/Buku Besar.
      `SELECT COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') AND j.tanggal BETWEEN ? AND ?`,
      acc.id,
      tanggalMulai,
      tanggalSelesai
    );
    const totalD = s?.d ?? 0;
    const totalK = s?.k ?? 0;
    const jumlah = acc.normal_balance === 'DEBIT' ? totalD - totalK : totalK - totalD;
    if (jumlah === 0) continue;

    const row = { kode: acc.kode, nama: acc.nama, jumlah };
    if (acc.kategori === 'PENDAPATAN') pendapatan.push(row);
    else beban.push(row);
  }

  const totalPendapatan = sum(pendapatan.map((r) => r.jumlah));
  const totalBeban = sum(beban.map((r) => r.jumlah));
  const hasilUsaha = totalPendapatan - totalBeban;
  const penghasilanKomprehensifLainRows = await getMutasiOci(db, tanggalMulai, tanggalSelesai);
  const penghasilanKomprehensifLain = sum(penghasilanKomprehensifLainRows.map((r) => r.jumlah));

  return {
    tanggalMulai,
    tanggalSelesai,
    pendapatan,
    beban,
    totalPendapatan,
    totalBeban,
    hasilUsaha,
    penghasilanKomprehensifLain,
    penghasilanKomprehensifLainRows,
    totalPenghasilanKomprehensif: hasilUsaha + penghasilanKomprehensifLain,
  };
}

/**
 * RC-S88 — mutasi OCI dalam [tanggalMulai, tanggalSelesai]. Per akun
 * cadangan OCI (`AKUN_OCI`): kredit − debit dari jurnal bersumber
 * transaksi OCI (`SUMBER_JURNAL_OCI`). REVERSED ikut dihitung (pola sama
 * dengan getLabaRugi di atas) — jurnal pembaliknya membawa sumber yang
 * sama, sehingga koreksi netto nol. Pos tanpa mutasi tidak ditampilkan.
 */
export async function getMutasiOci(
  db: SQLite.SQLiteDatabase,
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<OciRow[]> {
  const hasil: OciRow[] = [];
  const placeholderSumber = SUMBER_JURNAL_OCI.map(() => '?').join(',');
  for (const pos of AKUN_OCI) {
    const r = await db.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
         FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
         JOIN account a ON a.id = je.account_id
        WHERE a.kode = ? AND j.status IN ('POSTED','REVERSED')
          AND j.tanggal BETWEEN ? AND ?
          AND j.sumber_transaksi IN (${placeholderSumber})`,
      pos.kode,
      tanggalMulai,
      tanggalSelesai,
      ...SUMBER_JURNAL_OCI
    );
    const jumlah = (r?.k ?? 0) - (r?.d ?? 0);
    if (jumlah === 0) continue;
    hasil.push({ kode: pos.kode, nama: pos.labelLaporan, kelompok: pos.kelompok, jumlah });
  }
  return hasil;
}

// ============================================================
// 4b. LHU — LAPORAN HASIL USAHA (Revisi LHU KOPKU)
// ============================================================
// Struktur FINAL (Bagian A), dibangun di ATAS getLabaRugi() yang sudah
// ada di atas — BUKAN query ledger kedua yang terpisah. Setiap baris
// pendapatan/beban dari getLabaRugi() di-regroup memakai
// `account.lhu_klasifikasi` (Bagian G: otomatis dari mapping akun,
// bukan dipilih ulang oleh user setiap laporan dibuat). Karena ini
// murni PENGELOMPOKAN ULANG baris yang sama (bukan angka baru), SHU
// Neto hasil laporan ini SELALU identik dengan `hasilUsaha` dari
// getLabaRugi() untuk rentang tanggal yang sama — dibuktikan test
// (lihat FinancialReports.test.ts).
//
// "Pendapatan Jasa Pinjaman" (4-1000) & "Beban Pajak Penghasilan"
// (5-2200) SENGAJA dibaca langsung by kode (baris tersendiri, Bagian
// N & T) — TIDAK lewat klasifikasi LHU (keduanya sengaja tidak
// diklasifikasikan, lihat defaultCOA.ts).
export interface LhuRow {
  kode: string;
  nama: string;
  jumlah: Rupiah;
  /**
   * Akun Pendapatan/Beban yang punya saldo pada periode ini tapi BELUM
   * diklasifikasikan (mis. akun baru dibuat lewat Input Akun, belum
   * sempat diatur klasifikasi LHU-nya). TIDAK dihilangkan dari laporan
   * (Bagian V: jangan menyembunyikan angka) — dimasukkan ke kelompok
   * default yang paling netral (Pendapatan Lain / Beban Usaha) supaya
   * total tetap rekonsiliasi dengan getLabaRugi().hasilUsaha, DAN
   * ditandai di sini supaya UI bisa memberi peringatan eksplisit
   * ("Akun ini belum diklasifikasikan untuk LHU").
   */
  belumDiklasifikasikan?: boolean;
}

export interface LhuResult {
  tanggalMulai: string;
  tanggalSelesai: string;

  pendapatanJasaPinjaman: Rupiah;
  pendapatanUsahaLain: LhuRow[];
  totalPendapatanUsahaLain: Rupiah;
  jumlahPartisipasiAnggota: Rupiah;

  bebanUsaha: LhuRow[];
  jumlahBebanUsaha: Rupiah;

  shuBruto: Rupiah;

  hasilInvestasi: LhuRow[];
  totalHasilInvestasi: Rupiah;

  /**
   * RC-S98 — BEBAN PERKOPERASIAN sebagai BARIS TERSENDIRI.
   *
   * Juklat SOM No. 3/2025, Lampiran "CONTOH PERHITUNGAN HASIL USAHA
   * UNTUK KSP", menempatkan "Beban perkoperasian" SETELAH "Hasil
   * investasi" dan SEBELUM band "PENDAPATAN & BEBAN LAIN" — jadi di
   * naskah beban ini BUKAN bagian dari "Jumlah beban usaha". Dibuktikan
   * dari aritmatika contoh 2021 pada naskah:
   *   88.375.000 - 13.600.000                  = 74.775.000 (SHU Bruto)
   *   74.775.000 + 12.500.000 - 5.000.000
   *              + 4.000.000 -    550.000      = 85.725.000 (SHU sebelum pajak)
   * yaitu 13.600.000 TIDAK memuat 5.000.000 beban perkoperasian.
   *
   * Sebelumnya akun 5-1900 ikut terhitung di `bebanUsaha`, sehingga
   * "Jumlah Beban Usaha" & "SHU Bruto" menyimpang dari naskah. Sekarang
   * akun ini dikeluarkan lebih dulu dengan pola yang SAMA PERSIS seperti
   * 4-1000 (Pendapatan Jasa Pinjaman) dan 5-2200 (Beban Pajak
   * Penghasilan) — dikenali dari KODE akun, bukan dari
   * `lhu_klasifikasi` — karena ketiganya adalah baris baku LHU, bukan
   * kelompok akun. Konsekuensinya TIDAK ADA perubahan schema/CHECK.
   *
   * SHU SEBELUM PAJAK & SHU NETO TIDAK BERUBAH: beban ini dulu dikurangi
   * lewat `jumlahBebanUsaha`, sekarang dikurangi lewat barisnya sendiri.
   * Yang bergeser HANYA penyajian "Jumlah Beban Usaha" dan "SHU Bruto",
   * dan justru bergeser MENJADI sesuai naskah.
   */
  bebanPerkoperasian: LhuRow[];
  totalBebanPerkoperasian: Rupiah;

  pendapatanLain: LhuRow[];
  totalPendapatanLain: Rupiah;
  bebanLain: LhuRow[];
  totalBebanLain: Rupiah;
  pendapatanBebanLainNeto: Rupiah;

  shuSebelumPajak: Rupiah;
  bebanPajakPenghasilan: Rupiah;
  shuNeto: Rupiah;

  /**
   * RC-S88 — PENGHASILAN KOMPREHENSIF LAIN (SAK EP: satu laporan laba
   * rugi & penghasilan komprehensif lain). Dibaca dari getLabaRugi()
   * (satu sumber), dikelompokkan sesuai `src/config/ociPolicy.ts`.
   * TIDAK memengaruhi SHU Neto — SHU tetap angka yang dibagikan.
   */
  ociTidakDireklasifikasi: LhuRow[];
  ociDireklasifikasi: LhuRow[];
  totalOci: Rupiah;
  /** SHU Neto + total OCI. */
  totalPenghasilanKomprehensif: Rupiah;
}

const KODE_PENDAPATAN_JASA_PINJAMAN = '4-1000';
const KODE_BEBAN_PAJAK_PENGHASILAN = '5-2200';
/** RC-S98 — baris baku "Beban perkoperasian" (Juklat SOM 3/2025 Lampiran 1), lihat LhuResult.bebanPerkoperasian. */
const KODE_BEBAN_PERKOPERASIAN = '5-1900';

export async function getLHU(
  db: SQLite.SQLiteDatabase,
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<LhuResult> {
  const labaRugi = await getLabaRugi(db, tanggalMulai, tanggalSelesai);

  const klasifikasiRows = await db.getAllAsync<{ kode: string; lhu_klasifikasi: string | null }>(
    `SELECT kode, lhu_klasifikasi FROM account WHERE kategori IN ('PENDAPATAN','BEBAN')`
  );
  const klasifikasiByKode = new Map(klasifikasiRows.map((r) => [r.kode, r.lhu_klasifikasi]));

  let pendapatanJasaPinjaman = 0;
  const pendapatanUsahaLain: LhuRow[] = [];
  const hasilInvestasi: LhuRow[] = [];
  const pendapatanLain: LhuRow[] = [];

  for (const row of labaRugi.pendapatan) {
    if (row.kode === KODE_PENDAPATAN_JASA_PINJAMAN) {
      pendapatanJasaPinjaman = row.jumlah;
      continue;
    }
    const klas = klasifikasiByKode.get(row.kode);
    if (klas === 'PENDAPATAN_USAHA_LAIN') {
      pendapatanUsahaLain.push({ kode: row.kode, nama: row.nama, jumlah: row.jumlah });
    } else if (klas === 'HASIL_INVESTASI') {
      hasilInvestasi.push({ kode: row.kode, nama: row.nama, jumlah: row.jumlah });
    } else {
      // PENDAPATAN_LAIN atau belum diklasifikasikan (default paling
      // netral, lihat komentar LhuRow.belumDiklasifikasikan).
      pendapatanLain.push({ kode: row.kode, nama: row.nama, jumlah: row.jumlah, belumDiklasifikasikan: klas !== 'PENDAPATAN_LAIN' });
    }
  }

  let bebanPajakPenghasilan = 0;
  const bebanUsaha: LhuRow[] = [];
  const bebanPerkoperasian: LhuRow[] = [];
  const bebanLain: LhuRow[] = [];

  for (const row of labaRugi.beban) {
    if (row.kode === KODE_BEBAN_PAJAK_PENGHASILAN) {
      bebanPajakPenghasilan = row.jumlah;
      continue;
    }
    // RC-S98 — baris baku, dikeluarkan SEBELUM klasifikasi dibaca
    // (lihat LhuResult.bebanPerkoperasian).
    if (row.kode === KODE_BEBAN_PERKOPERASIAN) {
      bebanPerkoperasian.push({ kode: row.kode, nama: row.nama, jumlah: row.jumlah });
      continue;
    }
    const klas = klasifikasiByKode.get(row.kode);
    if (klas === 'BEBAN_LAIN') {
      bebanLain.push({ kode: row.kode, nama: row.nama, jumlah: row.jumlah });
    } else {
      // BEBAN_USAHA atau belum diklasifikasikan (default paling netral).
      bebanUsaha.push({ kode: row.kode, nama: row.nama, jumlah: row.jumlah, belumDiklasifikasikan: klas !== 'BEBAN_USAHA' });
    }
  }

  const totalPendapatanUsahaLain = sum(pendapatanUsahaLain.map((r) => r.jumlah));
  const jumlahPartisipasiAnggota = pendapatanJasaPinjaman + totalPendapatanUsahaLain;

  const jumlahBebanUsaha = sum(bebanUsaha.map((r) => r.jumlah));
  const shuBruto = jumlahPartisipasiAnggota - jumlahBebanUsaha;

  const totalHasilInvestasi = sum(hasilInvestasi.map((r) => r.jumlah));
  const totalBebanPerkoperasian = sum(bebanPerkoperasian.map((r) => r.jumlah));

  const totalPendapatanLain = sum(pendapatanLain.map((r) => r.jumlah));
  const totalBebanLain = sum(bebanLain.map((r) => r.jumlah));
  const pendapatanBebanLainNeto = totalPendapatanLain - totalBebanLain;

  // RC-S98 — urutan penjumlahan mengikuti naskah Juklat: SHU Bruto +
  // hasil investasi - beban perkoperasian + pendapatan/(beban) lain neto.
  const shuSebelumPajak = shuBruto + totalHasilInvestasi - totalBebanPerkoperasian + pendapatanBebanLainNeto;
  const shuNeto = shuSebelumPajak - bebanPajakPenghasilan;

  const ociTidakDireklasifikasi: LhuRow[] = labaRugi.penghasilanKomprehensifLainRows
    .filter((r) => r.kelompok === 'TIDAK_DIREKLASIFIKASI')
    .map((r) => ({ kode: r.kode, nama: r.nama, jumlah: r.jumlah }));
  const ociDireklasifikasi: LhuRow[] = labaRugi.penghasilanKomprehensifLainRows
    .filter((r) => r.kelompok === 'DIREKLASIFIKASI')
    .map((r) => ({ kode: r.kode, nama: r.nama, jumlah: r.jumlah }));
  const totalOci = labaRugi.penghasilanKomprehensifLain;

  return {
    tanggalMulai,
    tanggalSelesai,
    pendapatanJasaPinjaman,
    pendapatanUsahaLain,
    totalPendapatanUsahaLain,
    jumlahPartisipasiAnggota,
    bebanUsaha,
    jumlahBebanUsaha,
    shuBruto,
    hasilInvestasi,
    totalHasilInvestasi,
    bebanPerkoperasian,
    totalBebanPerkoperasian,
    pendapatanLain,
    totalPendapatanLain,
    bebanLain,
    totalBebanLain,
    pendapatanBebanLainNeto,
    shuSebelumPajak,
    bebanPajakPenghasilan,
    shuNeto,
    ociTidakDireklasifikasi,
    ociDireklasifikasi,
    totalOci,
    totalPenghasilanKomprehensif: shuNeto + totalOci,
  };
}

// ============================================================
// 5. LAPORAN PERUBAHAN EKUITAS / MODAL (PRD §26)
// ============================================================
export interface PerubahanEkuitasRow {
  kode: string;
  nama: string;
  saldoAwal: Rupiah;
  mutasi: Rupiah;
  saldoAkhir: Rupiah;
  /** RC-S133.6.1 — bagian `mutasi` yang berasal dari jurnal distribusi SHU dalam periode (mis. Cadangan). */
  mutasiDistribusiShu?: Rupiah;
}

/**
 * RC-S133.6.1 — RINCIAN baris SHU/Hasil Usaha (keputusan pengguna setelah
 * audit manual-vs-impor; TANPA closing entry). Jumlah ketiga kolom seluruh
 * rincian SAMA PERSIS dengan baris SHU/Hasil Usaha (saldoAwalHasilUsaha /
 * hasilUsahaPeriode − saldoAwalHasilUsaha / hasilUsahaPeriode), sehingga
 * rincian ini tidak menambah angka apa pun ke total.
 *   SHU_LALU   — sisa hasil usaha tahun buku sebelumnya yang belum dibagikan
 *                per H-1 tanggal mulai, dikurangi distribusi SHU dalam periode.
 *   HU_PERIODE — hasil usaha periode berjalan = Laporan Hasil Usaha periode
 *                yang sama (getLabaRugi(tanggalMulai, tanggalSelesai)).
 *   SELISIH    — hanya muncul bila ada mutasi akun kliring SHU di luar
 *                jurnal distribusi (tidak disembunyikan; perlu ditelusuri).
 */
export interface RincianHasilUsahaEkuitas {
  kunci: 'SHU_LALU' | 'HU_PERIODE' | 'SELISIH';
  nama: string;
  saldoAwal: Rupiah;
  mutasi: Rupiah;
  saldoAkhir: Rupiah;
}

export interface PerubahanEkuitasResult {
  tanggalMulai: string;
  tanggalSelesai: string;
  rows: PerubahanEkuitasRow[];
  totalSaldoAwal: Rupiah;
  totalMutasi: Rupiah;
  hasilUsahaPeriode: Rupiah; // SALDO AKHIR baris SHU/Hasil Usaha (= labaBerjalan Posisi Keuangan per tanggalSelesai) — SUDAH dinetralkan thd distribusi SHU (lihat komentar di bawah)
  hasilUsahaPeriodeLabel: string; // label status SHU, konsisten dengan getPosisiKeuangan().labaBerjalanLabel
  totalSaldoAkhir: Rupiah;   // termasuk hasilUsahaPeriode
  /**
   * RC-S133.6 (AUDIT F-4) — baris SHU/Hasil Usaha diperlakukan seperti akun
   * ekuitas lain: saldoAwalHasilUsaha + hasilUsahaPeriodeBerjalan −
   * shuDibagikanPeriode = hasilUsahaPeriode (saldo akhir baris itu).
   * totalSaldoAwal SUDAH termasuk saldoAwalHasilUsaha, sehingga sama dengan
   * total ekuitas Posisi Keuangan per H-1 tanggalMulai.
   */
  saldoAwalHasilUsaha?: Rupiah;      // sisa hasil usaha belum dibagikan per H-1 tanggalMulai
  hasilUsahaPeriodeBerjalan?: Rupiah; // hasil usaha periode ini (= LHU periode)
  shuDibagikanPeriode?: Rupiah;       // SHU yang dibagikan (jurnal distribusi) dalam periode
  /** RC-S133.6.1 — hasil usaha periode langsung dari Laporan Hasil Usaha (getLabaRugi periode yang sama). */
  lhuPeriode?: Rupiah;
  /** RC-S133.6.1 — distribusi SHU dalam periode yang masuk akun EKUITAS (Cadangan, dst). */
  distribusiShuKeEkuitas?: Rupiah;
  /** RC-S133.6.1 — distribusi SHU dalam periode yang keluar dari ekuitas (dana-dana/liabilitas, simpanan anggota). */
  distribusiShuKeLuarEkuitas?: Rupiah;
  /** RC-S133.6.1 — rincian baris SHU/Hasil Usaha; kosong bila tidak ada saldo awal SHU maupun distribusi (tahun pertama). */
  rincianHasilUsaha?: RincianHasilUsahaEkuitas[];
}

export async function getPerubahanEkuitas(
  db: SQLite.SQLiteDatabase,
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<PerubahanEkuitasResult> {
  // Saldo awal = posisi SEHARI SEBELUM tanggalMulai (kumulatif sejak awal berdirinya koperasi).
  const hariSebelumMulai = new Date(tanggalMulai);
  hariSebelumMulai.setDate(hariSebelumMulai.getDate() - 1);
  const tanggalAwal = hariSebelumMulai.toISOString().slice(0, 10);

  const trialAwal = await getTrialBalanceImpl(db, tanggalAwal);
  const trialAkhir = await getTrialBalanceImpl(db, tanggalSelesai);

  // BUG FIX (pola sama dengan getTrialBalance/getLabaRugi di atas):
  // filter `is_active = 1` sebelumnya bisa membuat akun EKUITAS yang
  // sudah dinonaktifkan hilang dari Perubahan Ekuitas walau saldonya
  // masih ada di Posisi Keuangan (yang sudah tidak filter is_active),
  // sehingga totalnya bisa tidak sama persis satu sama lain.
  const accounts = await db.getAllAsync<{ id: string; kode: string; nama: string }>(
    `SELECT id, kode, nama FROM account WHERE kategori = 'EKUITAS' ORDER BY kode ASC`
  );

  // TrialBalanceRow sudah menempatkan saldo pada kolom debit ATAU
  // kredit sesuai normal_balance akun; untuk EKUITAS (normal KREDIT)
  // saldo positif selalu ada di kolom kredit.
  const saldoAwalByAccount = new Map(trialAwal.rows.map((r) => [r.accountId, r.kredit]));
  const saldoAkhirByAccount = new Map(trialAkhir.rows.map((r) => [r.accountId, r.kredit]));

  // BUG FIX (Prioritas 4/F — konsistensi dengan getPosisiKeuangan,
  // Prioritas 1/C): akun kliring "SHU Tahun Berjalan" (3-4000)
  // dikeluarkan dari daftar akun ekuitas biasa (sama seperti Posisi
  // Keuangan) — sebelumnya baris ini ikut tampil DI SAMPING baris
  // terpisah "SHU/Hasil Usaha Periode", membingungkan (begitu SHU
  // dibagikan akun ini bersaldo negatif, seolah "ekuitas negatif" yang
  // tidak ada artinya bagi user).
  //
  // PENTING (percobaan fix pertama yang SALAH, dicatat supaya tidak
  // terulang): awalnya nilai penetral dihitung sebagai MUTASI baris
  // 3-4000 dalam rentang [tanggalMulai, tanggalSelesai] saja (saldoAkhir
  // - saldoAwal periode ini). Itu SALAH untuk tahun buku ke-2 dst:
  // saldo 3-4000 itu KUMULATIF SEPANJANG MASA (akun ini tidak pernah
  // di-nol-kan/ditutup), sementara akun ekuitas lain (Cadangan, Ekuitas
  // Lainnya) yang jadi lawannya JUGA kumulatif — jadi penetralnya HARUS
  // memakai saldo KUMULATIF 3-4000 per tanggalSelesai (persis seperti
  // `shuBerjalanSaldo` di getPosisiKeuangan), BUKAN delta dalam window
  // laporan ini saja, supaya total laporan ini selalu identik dengan
  // getPosisiKeuangan(tanggalSelesai).totalEkuitas — §F: "Pastikan
  // total akhir laporan perubahan ekuitas sama dengan total ekuitas
  // pada Posisi Keuangan". Solusi paling aman: PANGGIL LANGSUNG
  // getPosisiKeuangan(tanggalSelesai) dan pakai labaBerjalan-nya —
  // satu sumber kebenaran, tidak ada rumus kedua yang bisa menyimpang.
  const rows: PerubahanEkuitasRow[] = [];
  for (const acc of accounts) {
    if (acc.kode === SHU_BERJALAN_ACCOUNT_KODE) continue;
    const saldoAwal = saldoAwalByAccount.get(acc.id) ?? 0;
    const saldoAkhir = saldoAkhirByAccount.get(acc.id) ?? 0;
    if (saldoAwal === 0 && saldoAkhir === 0) continue;
    rows.push({ kode: acc.kode, nama: acc.nama, saldoAwal, mutasi: saldoAkhir - saldoAwal, saldoAkhir });
  }

  const [posisiAwal, posisiAkhir] = await Promise.all([
    getPosisiKeuangan(db, tanggalAwal),
    getPosisiKeuangan(db, tanggalSelesai),
  ]);
  const hasilUsahaPeriode = posisiAkhir.labaBerjalan;
  const hasilUsahaPeriodeLabel = posisiAkhir.labaBerjalanLabel;

  // RC-S133.6 (AUDIT F-4) — KESINAMBUNGAN ANTAR-TAHUN, TANPA closing entry.
  //
  // Dulu baris "SHU/Hasil Usaha" selalu bersaldo awal 0 dan totalSaldoAwal
  // hanya menjumlah akun ekuitas permanen. Karena aplikasi tidak menutup
  // akun pendapatan/beban, SHU tahun lalu yang belum dibagikan per tanggal
  // awal laporan HILANG dari saldo awal lalu muncul lagi sebagai "hasil
  // usaha periode" — saldo awal tahun N+1 ≠ ekuitas akhir tahun N (selisih
  // persis SHU yang belum dibagikan), dan "hasil usaha periode" ≠ LHU.
  //
  // Sekarang baris itu diperlakukan seperti akun ekuitas lain:
  //   saldo awal  = sisa hasil usaha belum dibagikan per H-1 (Posisi
  //                 Keuangan per tanggal itu — sumber yang SAMA)
  //   + hasil usaha periode berjalan (= LHU periode)
  //   − SHU yang dibagikan dalam periode (mutasi akun kliring 3-4000)
  //   = saldo akhir (= labaBerjalan Posisi Keuangan per tanggalSelesai).
  // Jurnal, saldo akun, dan Posisi Keuangan TIDAK berubah; totalSaldoAkhir
  // tetap identik dengan Posisi Keuangan.
  const saldoKliring = (tb: typeof trialAwal): number => {
    const row = tb.rows.find((r) => r.kode === SHU_BERJALAN_ACCOUNT_KODE);
    return row ? row.kredit - row.debit : 0;
  };
  const saldoAwalHasilUsaha = posisiAwal.labaBerjalan;
  const shuDibagikanPeriode = saldoKliring(trialAwal) - saldoKliring(trialAkhir);
  const hasilUsahaPeriodeBerjalan = hasilUsahaPeriode - saldoAwalHasilUsaha + shuDibagikanPeriode;

  // RC-S133.6.1 — PENYAJIAN (keputusan pengguna, tanpa closing entry):
  // saldo awal = ekuitas akhir tahun lalu (sudah, F-4); hasil usaha periode
  // = LHU periode (dihitung LANGSUNG, bukan sisa); distribusi SHU tampil
  // sebagai mutasi tersendiri; SHU tahun lalu yang belum dibagikan tidak
  // dihitung dua kali (ia hanya ada di saldo awal rincian SHU_LALU, dan
  // berkurang sebesar distribusinya). Angka total & saldo akun TIDAK berubah.
  const lhuPeriode = (await getLabaRugi(db, tanggalMulai, tanggalSelesai)).hasilUsaha;
  const distribusi = await db.getAllAsync<{ kode: string; kategori: string; debit: number; kredit: number }>(
    `SELECT a.kode, a.kategori, je.debit, je.kredit
       FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       JOIN account a ON a.id = je.account_id
      WHERE j.sumber_transaksi = 'SHU_DISTRIBUSI' AND j.status IN ('POSTED','REVERSED')
        AND j.tanggal >= ? AND j.tanggal <= ?`,
    tanggalMulai,
    tanggalSelesai
  );
  const mutasiDistribusiPerKode = new Map<string, number>();
  let distribusiShuKeEkuitas = 0;
  let distribusiShuKeLuarEkuitas = 0;
  let distribusiDariKliring = 0; // debit akun kliring oleh jurnal distribusi (bersih pembalik)
  for (const d of distribusi) {
    if (d.kode === SHU_BERJALAN_ACCOUNT_KODE) {
      distribusiDariKliring += d.debit - d.kredit;
      continue;
    }
    const kredit = d.kredit - d.debit;
    if (d.kategori === 'EKUITAS') {
      distribusiShuKeEkuitas += kredit;
      mutasiDistribusiPerKode.set(d.kode, (mutasiDistribusiPerKode.get(d.kode) ?? 0) + kredit);
    } else {
      distribusiShuKeLuarEkuitas += kredit;
    }
  }
  for (const r of rows) {
    const m = mutasiDistribusiPerKode.get(r.kode);
    if (m) r.mutasiDistribusiShu = m;
  }
  const rincianHasilUsaha: RincianHasilUsahaEkuitas[] = [];
  if (saldoAwalHasilUsaha !== 0 || shuDibagikanPeriode !== 0 || distribusiDariKliring !== 0) {
    rincianHasilUsaha.push({
      kunci: 'SHU_LALU',
      nama: distribusiDariKliring !== 0 ? 'SHU tahun buku sebelumnya — dikurangi SHU yang dibagikan' : 'SHU tahun buku sebelumnya (belum dibagikan)',
      saldoAwal: saldoAwalHasilUsaha,
      mutasi: 0 - distribusiDariKliring,
      saldoAkhir: saldoAwalHasilUsaha - distribusiDariKliring,
    });
    rincianHasilUsaha.push({ kunci: 'HU_PERIODE', nama: 'Hasil usaha periode berjalan (Laporan Hasil Usaha)', saldoAwal: 0, mutasi: lhuPeriode, saldoAkhir: lhuPeriode });
    // Sisa yang tidak dijelaskan jurnal distribusi maupun LHU (mis. jurnal umum ke akun kliring).
    const selisih = hasilUsahaPeriodeBerjalan - lhuPeriode - (shuDibagikanPeriode - distribusiDariKliring);
    if (selisih !== 0) {
      rincianHasilUsaha.push({ kunci: 'SELISIH', nama: 'Mutasi akun kliring SHU di luar distribusi (perlu ditelusuri)', saldoAwal: 0, mutasi: selisih, saldoAkhir: selisih });
    }
  }

  const totalSaldoAwal = sum(rows.map((r) => r.saldoAwal)) + saldoAwalHasilUsaha;
  const totalMutasi = sum(rows.map((r) => r.mutasi));
  const totalSaldoAkhir = sum(rows.map((r) => r.saldoAkhir)) + hasilUsahaPeriode;

  return {
    tanggalMulai,
    tanggalSelesai,
    rows,
    totalSaldoAwal,
    totalMutasi,
    hasilUsahaPeriode,
    hasilUsahaPeriodeLabel,
    totalSaldoAkhir,
    saldoAwalHasilUsaha,
    hasilUsahaPeriodeBerjalan,
    shuDibagikanPeriode,
    lhuPeriode,
    distribusiShuKeEkuitas,
    distribusiShuKeLuarEkuitas,
    rincianHasilUsaha,
  };
}

// ============================================================
// 6. LAPORAN ARUS KAS (PRD §27)
// ============================================================
export interface ArusKasResult {
  tanggalMulai: string;
  tanggalSelesai: string;
  operasi: Rupiah;
  investasi: Rupiah;
  pendanaan: Rupiah;
  kasAwal: Rupiah;
  perubahanKas: Rupiah;
  kasAkhirDihitung: Rupiah;   // kasAwal + perubahanKas (dari klasifikasi jurnal)
  kasAkhirAktual: Rupiah;     // saldo kas/bank aktual per tanggalSelesai (rekonsiliasi)
  terekonsiliasi: boolean;
  selisihRekonsiliasi: Rupiah;
  /**
   * RC-S104 — `sumberTransaksi` DITAMBAHKAN (aditif; `deskripsi` tetap
   * ada apa adanya). Tanpa ini laporan hanya bisa menampilkan
   * deskripsi jurnal mentah — satu baris per jurnal — sehingga baris
   * bernama seperti pada contoh Juklat mustahil disusun. Penamaan &
   * pengelompokannya ada di `ArusKasJuklat.susunBagianArusKas()`.
   */
  rincian: { aktivitas: AktivitasKas; sumberTransaksi: string; deskripsi: string; jumlah: Rupiah }[];
  /** RC-S133.4.5 — bagian kas awal yang berasal dari jurnal saldo awal bertanggal di dalam periode (bukan arus kas). */
  kasAwalDariSaldoAwal?: Rupiah;
}

/**
 * Metode langsung: menelusuri setiap journal_entry yang menyentuh akun
 * Kas/Bank dalam rentang tanggal, diklasifikasikan berdasarkan
 * sumber_transaksi jurnalnya (CashFlowClassification.ts). Kas
 * awal/akhir dihitung via getAccountBalance() (AccountingEngine.ts) —
 * sumber kebenaran yang sama dengan Neraca Saldo, sehingga hasilnya
 * bisa direkonsiliasi (PRD §27).
 */
/**
 * BUG-04 — DEFINISI AKUN KAS/BANK UNTUK PELAPORAN HISTORIS.
 *
 * Root cause: `getArusKas()` dan `getInformasiShuRat()` sebelumnya
 * membatasi himpunan akun kas/bank dengan `bank_account WHERE aktif = 1`.
 * Begitu sebuah rekening dinonaktifkan (rekening ditutup, ganti bank,
 * salah input), SELURUH transaksi historisnya lenyap dari Arus Kas —
 * termasuk kas awal & kas akhir. Laporan periode yang sudah dicetak
 * bulan lalu berubah angkanya hari ini hanya karena status aktif
 * rekening diubah, dan Arus Kas tidak lagi bisa direkonsiliasi dengan
 * Neraca Saldo.
 *
 * WHY: "boleh dipakai untuk transaksi baru" (is_active/aktif) adalah
 * pertanyaan yang BERBEDA dengan "pernah punya transaksi pada periode
 * ini" (eksistensi akuntansi historis). Pelaporan historis hanya boleh
 * bergantung pada journal_entry + tanggal jurnal, tidak pada status
 * aktif hari ini. Penyaringan `aktif = 1` tetap berlaku di picker
 * transaksi (lihat resolveKasBankAccountId di AccountMapping.ts) —
 * di sanalah tempatnya, bukan di laporan.
 *
 * Fungsi ini adalah SATU-SATUNYA definisi "akun kas/bank" untuk
 * seluruh laporan, supaya Arus Kas & Informasi SHU RAT mustahil
 * memakai himpunan akun yang berbeda.
 */
export async function getAkunKasBankUntukLaporan(
  db: SQLite.SQLiteDatabase
): Promise<{ id: string; nama: string }[]> {
  return db.getAllAsync<{ id: string; nama: string }>(
    `SELECT DISTINCT a.id, a.nama FROM account a
     WHERE a.id IN (
       SELECT account_id FROM account_mapping WHERE transaction_type = 'KAS_UMUM'
       UNION
       -- TANPA filter aktif (BUG-04): rekening yang sudah ditutup pun
       -- tetap membawa histori kas yang sah pada periode lampau.
       SELECT account_id FROM bank_account
     )`
  );
}

export async function getArusKas(
  db: SQLite.SQLiteDatabase,
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<ArusKasResult> {
  const kasBankAccounts = await getAkunKasBankUntukLaporan(db);
  const kasBankIds = kasBankAccounts.map((a) => a.id);

  const hariSebelumMulai = new Date(tanggalMulai);
  hariSebelumMulai.setDate(hariSebelumMulai.getDate() - 1);
  const tanggalAwal = hariSebelumMulai.toISOString().slice(0, 10);

  // BUG-15: dua query agregat untuk SEMUA akun, bukan 2 panggilan
  // getAccountBalance() per akun di dalam loop (4N query).
  const [saldoAwalPerAkun, saldoAkhirPerAkun] = await Promise.all([
    getAccountBalancesBulk(db, kasBankIds, tanggalAwal),
    getAccountBalancesBulk(db, kasBankIds, tanggalSelesai),
  ]);
  let kasAwal = 0;
  let kasAkhirAktual = 0;
  for (const acc of kasBankAccounts) {
    kasAwal += saldoAwalPerAkun.get(acc.id) ?? 0;
    kasAkhirAktual += saldoAkhirPerAkun.get(acc.id) ?? 0;
  }

  const rincian: { aktivitas: AktivitasKas; sumberTransaksi: string; deskripsi: string; jumlah: Rupiah }[] = [];
  let kasAwalDariSaldoAwal = 0;
  let operasi = 0;
  let investasi = 0;
  let pendanaan = 0;

  if (kasBankIds.length > 0) {
    const placeholders = kasBankIds.map(() => '?').join(',');
    const entries = await db.getAllAsync<{
      journal_id: string;
      sumber_transaksi: string;
      deskripsi: string;
      debit: number;
      kredit: number;
    }>(
      // Sama seperti getLabaRugi di atas — REVERSED harus ikut (lihat
      // AUDIT_INTERNAL.md §3.5), supaya rincian arus kas konsisten
      // dengan kasAwal/kasAkhirAktual (dihitung via getAccountBalance
      // yang sudah include REVERSED sejak awal).
      `SELECT j.id as journal_id, j.sumber_transaksi, j.deskripsi, je.debit, je.kredit
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id IN (${placeholders}) AND j.status IN ('POSTED','REVERSED')
         AND j.tanggal BETWEEN ? AND ?
       ORDER BY j.tanggal ASC`,
      ...kasBankIds,
      tanggalMulai,
      tanggalSelesai
    );

    // AUDIT F-2 — `catatDataAwalSimpanan` (impor "Transaksi baru" & setor
    // simpanan gabungan) membukukan pokok+wajib+sukarela dalam SATU jurnal
    // bersumber SIMPANAN_DATA_AWAL yang seluruhnya diklasifikasikan
    // PENDANAAN. Padahal sejak RC-S104 simpanan sukarela = OPERASI (setor
    // sukarela biasa lewat menu manual sudah OPERASI), sehingga Arus Kas
    // hasil impor berbeda dari input manual untuk data yang sama. Bagian
    // sukarela diambil dari buku pembantu simpanan_transaksi (jurnal yang
    // sama) dan disajikan sebagai SIMPANAN_SUKARELA/OPERASI; sisanya tetap
    // SIMPANAN_DATA_AWAL/PENDANAAN. Total kas tidak berubah.
    //
    // RC-S133.6 — jurnal PEMBALIK (reverseJournal: sumber_transaksi sama,
    // `reversal_of_id` = jurnal asal, gerak kas NEGATIF) dipecah dengan
    // porsi sukarela jurnal ASAL-nya, supaya pasangan asal+pembalik saling
    // meniadakan per aktivitas (bukan Operasi +S / Pendanaan −S).
    const sukarelaPerJurnal = new Map<string, number>();
    const jurnalDataAwal = [...new Set(entries.filter((x) => x.sumber_transaksi === 'SIMPANAN_DATA_AWAL').map((x) => x.journal_id))];
    if (jurnalDataAwal.length > 0) {
      const ph = jurnalDataAwal.map(() => '?').join(',');
      const asalRows = await db.getAllAsync<{ id: string; asal: string }>(
        `SELECT id, COALESCE(reversal_of_id, id) AS asal FROM journal WHERE id IN (${ph})`,
        ...jurnalDataAwal
      );
      const asalIds = [...new Set(asalRows.map((r) => r.asal))];
      const phAsal = asalIds.map(() => '?').join(',');
      const baris = asalIds.length
        ? await db.getAllAsync<{ journal_id: string; n: number }>(
            `SELECT journal_id, SUM(nominal) AS n FROM simpanan_transaksi
             WHERE jenis = 'SUKARELA' AND tipe = 'SETOR' AND journal_id IN (${phAsal})
             GROUP BY journal_id`,
            ...asalIds
          )
        : [];
      const sukarelaAsal = new Map<string, number>(baris.map((b): [string, number] => [b.journal_id, b.n]));
      for (const r of asalRows) {
        const n = sukarelaAsal.get(r.asal) ?? 0;
        if (n > 0) sukarelaPerJurnal.set(r.id, n);
      }
    }

    for (const e of entries) {
      const netMovement = e.debit - e.kredit; // kas bertambah jika debit > kredit
      if (netMovement === 0) continue;
      if (e.sumber_transaksi === 'SIMPANAN_DATA_AWAL') {
        const porsiSukarela = sukarelaPerJurnal.get(e.journal_id) ?? 0;
        if (porsiSukarela > 0) {
          // Bertanda sama dengan gerak kas: positif untuk setoran, negatif untuk pembaliknya.
          const bagianSukarela = Math.sign(netMovement) * Math.min(Math.abs(netMovement), porsiSukarela);
          operasi += bagianSukarela;
          rincian.push({ aktivitas: 'OPERASI', sumberTransaksi: 'SIMPANAN_SUKARELA', deskripsi: e.deskripsi, jumlah: bagianSukarela });
          const sisa = netMovement - bagianSukarela;
          if (sisa !== 0) {
            pendanaan += sisa;
            rincian.push({ aktivitas: 'PENDANAAN', sumberTransaksi: e.sumber_transaksi, deskripsi: e.deskripsi, jumlah: sisa });
          }
          continue;
        }
      }
      // RC-S133.4.5 — SALDO AWAL BUKAN ARUS KAS. Jurnal saldo awal
      // (dan koreksinya) yang bertanggal di dalam periode adalah posisi
      // kas pembukaan koperasi yang mulai memakai aplikasi, bukan uang
      // yang masuk dari kegiatan pendanaan. Dulu ia ikut "pendanaan",
      // sehingga Arus Kas tahun cut-off menampilkan kas awal Rp0 dan
      // pendanaan sebesar seluruh saldo kas pembukaan. Sekarang ditambahkan
      // ke kas awal (kas akhir dihitung tetap sama dengan kas akhir aktual).
      if (SUMBER_SALDO_AWAL_KAS.has(e.sumber_transaksi)) {
        kasAwal += netMovement;
        kasAwalDariSaldoAwal += netMovement;
        continue;
      }
      const aktivitas = classifyTransaction(e.sumber_transaksi);
      if (aktivitas === 'OPERASI') operasi += netMovement;
      else if (aktivitas === 'INVESTASI') investasi += netMovement;
      else pendanaan += netMovement;
      rincian.push({ aktivitas, sumberTransaksi: e.sumber_transaksi, deskripsi: e.deskripsi, jumlah: netMovement });
    }
  }

  const perubahanKas = operasi + investasi + pendanaan;
  const kasAkhirDihitung = kasAwal + perubahanKas;
  const selisihRekonsiliasi = kasAkhirAktual - kasAkhirDihitung;

  return {
    tanggalMulai,
    tanggalSelesai,
    operasi,
    investasi,
    pendanaan,
    kasAwal,
    perubahanKas,
    kasAkhirDihitung,
    kasAkhirAktual,
    terekonsiliasi: selisihRekonsiliasi === 0,
    selisihRekonsiliasi,
    rincian,
    kasAwalDariSaldoAwal,
  };
}

/** RC-S133.4.5 — sumber jurnal yang merupakan posisi pembukaan, bukan arus kas. */
const SUMBER_SALDO_AWAL_KAS = new Set(['SALDO_AWAL_AKUN', 'KOREKSI_SALDO_AWAL', 'SALDO_AWAL_REKENING']);

// ============================================================
// 7. CALK — Catatan Atas Laporan Keuangan (Prioritas 12/N)
// ============================================================
export interface CalkSection {
  sectionKey: string;
  judul: string;
  konten: string;
}

export interface CalkResult {
  tanggalMulai: string;
  tanggalSelesai: string;
  sections: CalkSection[];
}

/**
 * Menghasilkan draf CALK OTOMATIS PENUH dari data koperasi + laporan
 * yang sudah dihitung dari jurnal/ledger — TIDAK ADA data statis/
 * hardcode. Fungsi ini SELALU menghasilkan versi terbaru berdasarkan
 * data aktual; penggabungan dengan edit manual pengguna (calk_note)
 * ada di `getCalkDenganEditManual()` di bawah — dipisah supaya fungsi
 * ini tetap murni (pure function of ledger data), gampang dites.
 *
 * PERBAIKAN BESAR (Prioritas 12/N) dari versi sebelumnya:
 *  - 7 section -> 21 section, mencakup seluruh daftar minimal yang
 *    diminta (kas, piutang, penyisihan piutang, aset tetap, penyusutan,
 *    aset tak berwujud, amortisasi, investasi, utang, simpanan anggota,
 *    ekuitas, pendapatan, beban, SHU, arus kas, imbalan kerja, biaya
 *    pinjaman, OCI, komparatif — plus informasi umum & dasar penyusunan
 *    yang sudah ada sebelumnya).
 *  - "Kebijakan Akuntansi" SEBELUMNYA cuma satu kalimat generik ("perlu
 *    direview akuntan") — SEKARANG memakai
 *    `getKebijakanAkuntansiNarasi()` (Prioritas 11/M), teks yang benar-
 *    benar diaudit ke tiap service terkait.
 *  - SHU: SEBELUMNYA section ini TIDAK ADA SAMA SEKALI dan CALK versi
 *    lama pernah berkomentar literal "modul SHU belum tersedia" (sudah
 *    dihapus sejak Prioritas 1/C) — sekarang section SHU membaca
 *    `shu_konfigurasi` langsung dan menyatakan status apa adanya
 *    (belum dihitung/sudah dihitung/sudah dibagikan beserta rinciannya).
 */
/**
 * RC-S54 TAHAP 15 (#14) — akun piutang HASIL INVESTASI (KEPUTUSAN 01-A).
 * Dipakai CALK untuk memisahkannya dari catatan piutang pinjaman anggota.
 */
export const KODE_PIUTANG_HASIL_INVESTASI: readonly string[] = ['1-1220', '1-1240', '1-1250'];

export async function generateCALK(
  db: SQLite.SQLiteDatabase,
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<CalkResult> {
  const koperasi = await db.getFirstAsync<{
    nama: string;
    nomor_badan_hukum: string | null;
    alamat: string | null;
    tanggal_berdiri: string | null;
    standar_akuntansi: string;
  }>(
    `SELECT nama, nomor_badan_hukum, alamat, tanggal_berdiri, standar_akuntansi
     FROM koperasi ORDER BY created_at DESC LIMIT 1`
  );
  // §35 (audit duplikasi default SAK_EP): sebelumnya baris ini memakai
  // literal 'SAK_EP' sendiri. Sekarang memakai konstanta kanonik yang
  // SAMA dengan setup/service lain, supaya tidak ada dua sumber default
  // yang bisa menyimpang. Nilai yang SUDAH tersimpan tetap dipakai apa
  // adanya — ini murni fallback label untuk baris yang kosong, dan
  // TIDAK mengubah nilai akuntansi apa pun (hanya narasi CALK).
  // RC-S39 follow-up: nama standar TIDAK lagi dibaca dari database untuk
  // dicetak di laporan. Nilai kolom hanya metadata; teks laporan memakai
  // konstanta kanonik agar tidak ada data lama yang bisa muncul di CALK.


  const posisi = await getPosisiKeuangan(db, tanggalSelesai);
  const labaRugi = await getLabaRugi(db, tanggalMulai, tanggalSelesai);
  const arusKas = await getArusKas(db, tanggalMulai, tanggalSelesai);

  const findRow = (rows: PosisiKeuanganRow[], keyword: string) =>
    rows.filter((r) => r.nama.toLowerCase().includes(keyword.toLowerCase()));

  const kasBankRows = [...findRow(posisi.aset, 'kas'), ...findRow(posisi.aset, 'bank')];
  // RC-S54 TAHAP 15 (#14, temuan T12-A5) — piutang HASIL INVESTASI
  // (KEPUTUSAN 01-A: 1-1220/1-1240/1-1250) bukan piutang pinjaman anggota.
  // Sebelumnya ikut tersaring kata kunci 'piutang' dan tampil di catatan
  // "5. Piutang Pinjaman Anggota". Dikenali lewat KODE (bukan nama), lalu
  // diungkapkan di catatan "11. Investasi". Murni penyajian CALK: saldo,
  // jurnal, dan Posisi Keuangan tidak berubah.
  const piutangHasilInvestasiRows = posisi.aset.filter((r) => KODE_PIUTANG_HASIL_INVESTASI.includes(r.kode));
  const piutangRows = findRow(posisi.aset, 'piutang').filter(
    (r) => !r.nama.toLowerCase().includes('penyisihan') && !KODE_PIUTANG_HASIL_INVESTASI.includes(r.kode)
  );
  const penyisihanRows = findRow(posisi.aset, 'penyisihan');
  const simpananPokokWajibRows = [...findRow(posisi.ekuitas, 'simpanan pokok'), ...findRow(posisi.ekuitas, 'simpanan wajib')];
  const simpananSukarelaRows = findRow(posisi.liabilitas, 'simpanan sukarela');

  const fmt = (n: number) => n.toLocaleString('id-ID');
  const tidakAda = (label: string) => `Tidak ada ${label} yang tercatat pada periode ini.`;
  const listRows = (rows: PosisiKeuanganRow[]) => rows.map((r) => `${r.nama}: Rp${fmt(r.saldo)}`).join('; ') + '.';

  // ---- Aset tetap / tak berwujud / penyusutan / amortisasi ----
  // Prioritas 17/§4: propagasi asOfDate (=tanggalSelesai laporan ini)
  // ke ketiga fungsi ini — SEBELUMNYA memakai kondisi SEKARANG
  // (current DB state) walau laporan yang diminta untuk tanggal masa
  // lalu, membuat CALK periode lama diam-diam ikut berubah kalau ada
  // transaksi aset/investasi/utang baru sesudahnya. Sekarang historis
  // per tanggalSelesai, konsisten dengan seluruh laporan lain di CALK
  // ini (Posisi Keuangan, Laba Rugi, dst — semuanya sudah asOfDate-aware).
  const semuaAset = await listAsetDenganNilaiBuku(tanggalSelesai);
  // PENTING: TIDAK menyaring lagi berdasar `status !== 'DIHAPUS'` di
  // sini seperti sebelumnya — `listAsetDenganNilaiBuku(asOfDate)` SUDAH
  // menyaring di level SQL berdasar KONDISI HISTORIS (apakah aset
  // masih dimiliki per tanggalSelesai), BUKAN status kolom mentah yang
  // mencerminkan kondisi SEKARANG. Aset yang dihapus SETELAH
  // tanggalSelesai tetap benar muncul di sini walau kolom `status`-nya
  // saat ini (hari ini, saat laporan dijalankan) sudah 'DIHAPUS' —
  // menyaring ulang pakai `status` mentah di sini akan MENGHILANGKAN
  // aset itu secara keliru, membatalkan perbaikan date-scoping-nya.
  const asetTetap = semuaAset.filter((a) => a.jenisAset !== 'TAK_BERWUJUD');
  const asetTakBerwujud = semuaAset.filter((a) => a.jenisAset === 'TAK_BERWUJUD');
  const totalNilaiPerolehanTetap = sum(asetTetap.map((a) => a.nilaiPerolehan));
  const totalAkumulasiPenyusutan = sum(asetTetap.map((a) => a.akumulasiPenyusutan));
  const totalNilaiBukuTetap = sum(asetTetap.map((a) => a.nilaiBuku));
  // RC-S88 — revaluasi aset tetap (SAK EP Bab 17).
  const totalSelisihRevaluasiTetap = sum(asetTetap.map((a) => a.selisihRevaluasi ?? 0));
  const jumlahAsetDirevaluasi = asetTetap.filter((a) => (a.selisihRevaluasi ?? 0) !== 0).length;
  const totalNilaiPerolehanTBW = sum(asetTakBerwujud.map((a) => a.nilaiPerolehan));
  const totalAkumulasiAmortisasi = sum(asetTakBerwujud.map((a) => a.akumulasiPenyusutan));
  const totalNilaiBukuTBW = sum(asetTakBerwujud.map((a) => a.nilaiBuku));

  // ---- Investasi ----
  // asOfDate=tanggalSelesai — sama seperti aset di atas, filter
  // status='AKTIF' di JS SUDAH TIDAK PERLU/SALAH kalau dipakai
  // berdampingan dengan asOfDate (listInvestasi(asOfDate) sendiri
  // sudah menghitung "aktif per tanggal tsb" secara historis, apapun
  // status kolom mentahnya hari ini).
  const daftarInvestasi = await listInvestasi(tanggalSelesai);
  // Phase 17 §10: disclosure impairment investasi — HANYA ditampilkan
  // kalau memang ada impairment yang tercatat (§10: "Jika tidak ada
  // impairment: jangan membuat angka"). try/catch: tabel
  // investasi_impairment/mapping IMPAIRMENT_INVESTASI baru ada sejak
  // Phase 17 — instalasi yang belum pernah pakai fitur ini sama sekali
  // tidak boleh membuat CALK gagal (pola sama dengan Phase 12).
  let totalImpairmentInvestasi = 0;
  try {
    totalImpairmentInvestasi = await getTotalImpairmentInvestasi(db, tanggalSelesai);
    // RC-S54 TAHAP 16 (#20): penurunan nilai investasi yang SUDAH DILEPAS per
    // tanggalSelesai sudah dibersihkan oleh jurnal pelepasan (Dr 1-1900), jadi
    // tidak lagi dikurangkan dari nilai tercatat investasi aktif. Investasi
    // DIBATALKAN warisan tidak disentuh (saldo ledger-nya memang masih ada).
    const aktifPerTanggal = new Set(daftarInvestasi.map((i) => i.id));
    for (const inv of (await listInvestasi()).filter((i) => i.status === 'DILEPAS' && !aktifPerTanggal.has(i.id))) {
      totalImpairmentInvestasi -= (await getNilaiTercatatInvestasi(db, inv.id, tanggalSelesai)).akumulasiImpairment;
    }
  } catch {
    totalImpairmentInvestasi = 0;
  }
  const totalInvestasi = sum(daftarInvestasi.map((i) => i.jumlah));
  // RC-S54 TAHAP 15 (#14) — POLICY 03 = MODEL BIAYA: nilai tercatat
  // properti investasi = perolehan − akumulasi penyusutan (1-1670) −
  // penurunan nilai. Sebelumnya catatan 11 hanya mengurangkan penurunan
  // nilai, sehingga nilai tercatat yang diungkapkan lebih tinggi dari
  // Posisi Keuangan begitu properti investasi disusutkan. Akumulasi
  // penyusutan diambil per properti investasi AKTIF per tanggalSelesai
  // lewat fungsi existing getNilaiTercatatInvestasi (register
  // investasi_penyusutan, filter tanggal <= asOfDate) — satu sumber rumus
  // yang sama dengan batas atas impairment. try/catch: tabel v64.
  let totalPenyusutanPropertiInvestasi = 0;
  try {
    for (const inv of daftarInvestasi.filter((i) => i.jenisInvestasi === 'PROPERTI_INVESTASI')) {
      totalPenyusutanPropertiInvestasi += (await getNilaiTercatatInvestasi(db, inv.id, tanggalSelesai)).akumulasiPenyusutan;
    }
  } catch {
    totalPenyusutanPropertiInvestasi = 0;
  }

  // RC-S54 TAHAP 16 (#14-C) — KEPUTUSAN PENYAJIAN OPSI C. Akun Pendapatan
  // Diterima Dimuka memuat komponen EIR bertanda (Tahap 9: Piutang − komponen
  // EIR = amortized cost). Pada model FLAT komponen itu dapat bersaldo debit,
  // sehingga liabilitas tersaji negatif. Keputusan T16: saldo DISAJIKAN APA
  // ADANYA (Posisi Keuangan = Neraca Saldo, dapat dihitung per tanggal mana
  // pun) dan DIUNGKAPKAN di catatan piutang. Tidak ada reklasifikasi, tidak
  // ada perubahan pengukuran. Akun dicari lewat mapping (titik resolusi yang
  // sama dengan rekonsiliasi deferred income), bukan kode literal.
  // Pengungkapan hanya muncul bila saldo per tanggalSelesai debit.
  let saldoDimukaDebit = 0;
  try {
    const akunDimuka = await resolveAccountId(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA');
    const saldoDimuka = await getAccountBalance(db, akunDimuka, tanggalSelesai);
    saldoDimukaDebit = saldoDimuka < 0 ? -saldoDimuka : 0;
  } catch {
    saldoDimukaDebit = 0;
  }
  // RC-S54 TAHAP 16 GAP 7: rincian kuantitatif per tanggal dari read model
  // (EirPresentationReadModel) — proyeksi read-only atas jurnal EIR yang POSTED
  // sampai tanggalSelesai; Posisi Keuangan tetap OPSI C (= Neraca Saldo).
  let rincianAmortizedCost = '';
  if (saldoDimukaDebit > 0) {
    try {
      const rm = await getPenyajianAmortizedCostPerTanggal(db, tanggalSelesai);
      rincianAmortizedCost =
        ` Per ${tanggalSelesai}: piutang pinjaman kontraktual Rp${fmt(rm.piutangKontraktual)}, komponen penyesuaian EIR ` +
        `${rm.komponenEir < 0 ? 'debit' : 'kredit'} Rp${fmt(Math.abs(rm.komponenEir))}, nilai tercatat piutang pinjaman ` +
        `(biaya perolehan diamortisasi) Rp${fmt(rm.amortizedCost)}.`;
    } catch {
      rincianAmortizedCost = '';
    }
  }
  const pengungkapanDimukaDebit =
    saldoDimukaDebit > 0
      ? ` Pendapatan Diterima Dimuka per ${tanggalSelesai} bersaldo debit Rp${fmt(saldoDimukaDebit)} dan disajikan apa adanya ` +
        `(bernilai negatif) pada liabilitas. Saldo debit ini berasal dari komponen penyesuaian suku bunga efektif pinjaman ` +
        `(bunga efektif yang telah diakui melebihi sisa fee integral), bukan kewajiban kepada pihak lain. Nilai tercatat ` +
        `piutang pinjaman menurut biaya perolehan diamortisasi memperhitungkan komponen tersebut, sehingga jumlah aset ` +
        `dan liabilitas yang disajikan sama-sama lebih rendah sebesar komponen itu tanpa mengubah ekuitas maupun SHU.` +
        rincianAmortizedCost
      : '';

  // ---- Utang & biaya pinjaman ----
  // asOfDate=tanggalSelesai, status dihitung historis oleh listUtang
  // sendiri (bukan kolom mentah) — lihat komentar panjang di
  // UtangService.listUtang.
  const daftarUtangAktif = (await listUtang({ status: 'AKTIF', asOfDate: tanggalSelesai })).filter(
    (u) => u.jenisPemberi !== 'UTANG_USAHA'
  );
  const totalUtangBerbunga = sum(daftarUtangAktif.map((u) => u.sisaPokok));
  // try/catch: mapping UTANG_BUNGA bersifat OPSIONAL (baru dipakai
  // kalau koperasi pernah pakai fitur akrual bunga, Prioritas 10/L) —
  // kalau belum pernah dipakai sama sekali, anggap saja 0 (memang
  // tidak ada), JANGAN sampai CALK gagal total karena satu bagian
  // opsional ini.
  let saldoUtangBunga = 0;
  try {
    saldoUtangBunga = await getSaldoUtangBunga(tanggalSelesai);
  } catch {
    saldoUtangBunga = 0;
  }

  // ---- Imbalan kerja ----
  let saldoUtangImbalanKerja = 0;
  try {
    saldoUtangImbalanKerja = await getSaldoUtangImbalanKerja(db, tanggalSelesai);
  } catch {
    saldoUtangImbalanKerja = 0;
  }

  // ---- Penyisihan piutang: target (hasil klasifikasi terkini) vs tercatat (ledger) ----
  const targetPenyisihan = await getTotalPenyisihanTarget(db, tanggalSelesai);
  const tercatatPenyisihan = sum(penyisihanRows.map((r) => Math.abs(r.saldo)));

  // ---- SHU ----
  const bounds = await getPeriodBounds(db, tanggalSelesai);
  const shuKonfig = bounds
    ? await db.getFirstAsync<{ status: string; total_shu: number | null }>(
        `SELECT status, total_shu FROM shu_konfigurasi WHERE tahun_buku = ?`,
        bounds.tahunBuku
      )
    : null;

  let shuNarasi: string;
  if (!bounds) {
    shuNarasi = 'Periode akuntansi untuk tanggal laporan ini belum diatur, status SHU tidak dapat ditentukan.';
  } else if (!shuKonfig || shuKonfig.status === 'DRAFT') {
    shuNarasi = `SHU tahun buku ${bounds.tahunBuku} belum dihitung.`;
  } else if (shuKonfig.status === 'DIHITUNG') {
    shuNarasi = `SHU tahun buku ${bounds.tahunBuku} telah dihitung sebesar Rp${fmt(
      shuKonfig.total_shu ?? 0
    )}, menunggu pengesahan dan pembagian setelah Rapat Anggota Tahunan (RAT).`;
  } else {
    shuNarasi = `SHU tahun buku ${bounds.tahunBuku} sebesar Rp${fmt(
      shuKonfig.total_shu ?? 0
    )} telah disahkan dan dibagikan sesuai persentase yang ditetapkan RAT, dialokasikan ke Cadangan, Ekuitas Lainnya, dan Simpanan Sukarela anggota.`;
  }

  // ---- Informasi komparatif: periode yang sama tahun sebelumnya, kalau datanya ada ----
  let komparatifNarasi: string;
  try {
    const tahunSebelumnya = new Date(tanggalSelesai);
    tahunSebelumnya.setFullYear(tahunSebelumnya.getFullYear() - 1);
    const tglPembanding = tahunSebelumnya.toISOString().slice(0, 10);
    const boundsPembanding = await getPeriodBounds(db, tglPembanding);
    if (boundsPembanding) {
      const posisiPembanding = await getPosisiKeuangan(db, tglPembanding);
      komparatifNarasi = `Total Aset per ${tglPembanding} (periode pembanding): Rp${fmt(
        posisiPembanding.totalAset
      )}, dibandingkan Rp${fmt(posisi.totalAset)} pada ${tanggalSelesai} (perubahan Rp${fmt(
        posisi.totalAset - posisiPembanding.totalAset
      )}).`;
    } else {
      komparatifNarasi = 'Data periode pembanding (tahun sebelumnya) belum tersedia untuk disajikan secara komparatif.';
    }
  } catch {
    komparatifNarasi = 'Data periode pembanding (tahun sebelumnya) belum tersedia untuk disajikan secara komparatif.';
  }

  const kebijakan = getKebijakanAkuntansiNarasi();
  const cariKebijakan = (area: string) => kebijakan.find((k) => k.area === area)?.narasi ?? '';

  const sections: CalkSection[] = [
    {
      sectionKey: 'informasi_umum',
      judul: '1. Informasi Umum',
      konten: koperasi
        ? `${koperasi.nama}${koperasi.nomor_badan_hukum ? `, badan hukum ${koperasi.nomor_badan_hukum}` : ''}${
            koperasi.alamat ? `, berkedudukan di ${koperasi.alamat}` : ''
          }${koperasi.tanggal_berdiri ? `, didirikan pada ${koperasi.tanggal_berdiri}` : ''}.`
        : 'Data koperasi belum diisi.',
    },
    {
      sectionKey: 'dasar_penyusunan',
      judul: '2. Dasar Penyusunan Laporan Keuangan',
      konten: cariKebijakan('basis_akuntansi') + ' ' + cariKebijakan('periode_pelaporan') + ' ' + cariKebijakan('mata_uang'),
    },
    {
      sectionKey: 'kebijakan_akuntansi',
      judul: '3. Ikhtisar Kebijakan Akuntansi Penting',
      konten: kebijakan.map((k) => `${k.judul}: ${k.narasi}`).join('\n\n'),
    },
    {
      sectionKey: 'kas',
      judul: '4. Kas dan Bank',
      konten: (kasBankRows.length > 0 ? listRows(kasBankRows) : tidakAda('saldo kas/bank')) + ' ' + cariKebijakan('kas_setara_kas'),
    },
    {
      sectionKey: 'piutang',
      judul: '5. Piutang Pinjaman Anggota',
      konten: (piutangRows.length > 0 ? listRows(piutangRows) : tidakAda('saldo piutang')) + ' ' + cariKebijakan('piutang') + pengungkapanDimukaDebit,
    },
    {
      sectionKey: 'penyisihan_piutang',
      judul: '6. Penyisihan Penurunan Nilai Piutang',
      konten:
        `Saldo penyisihan tercatat per ${tanggalSelesai}: Rp${fmt(tercatatPenyisihan)}. ` +
        `Target penyisihan hasil klasifikasi kolektibilitas terkini: Rp${fmt(targetPenyisihan)}` +
        (tercatatPenyisihan === targetPenyisihan
          ? ' (sudah sesuai).'
          : ` (selisih Rp${fmt(targetPenyisihan - tercatatPenyisihan)} — perlu penyesuaian lewat menu Kolektibilitas Piutang).`) +
        ' ' +
        cariKebijakan('penyisihan_piutang'),
    },
    {
      sectionKey: 'aset_tetap',
      judul: '7. Aset Tetap',
      konten:
        asetTetap.length > 0
          ? `Nilai perolehan: Rp${fmt(totalNilaiPerolehanTetap)}; akumulasi penyusutan: Rp${fmt(
              totalAkumulasiPenyusutan
            )}${
              jumlahAsetDirevaluasi > 0
                ? `; selisih revaluasi: ${totalSelisihRevaluasiTetap < 0 ? '(' : ''}Rp${fmt(Math.abs(totalSelisihRevaluasiTetap))}${totalSelisihRevaluasiTetap < 0 ? ')' : ''}`
                : ''
            }; nilai buku: Rp${fmt(totalNilaiBukuTetap)}.${
              jumlahAsetDirevaluasi > 0
                ? ` ${jumlahAsetDirevaluasi} aset diukur dengan model revaluasi (SAK EP Bab 17): nilai tercatat = nilai revaluasi dikurangi akumulasi penyusutan setelah tanggal revaluasi; kenaikan diakui di penghasilan komprehensif lain (surplus revaluasi).`
                : ''
            } ${cariKebijakan('aset_tetap')}`
          : `${tidakAda('aset tetap')} ${cariKebijakan('aset_tetap')}`,
    },
    {
      sectionKey: 'penyusutan',
      judul: '8. Penyusutan',
      konten: cariKebijakan('penyusutan'),
    },
    {
      sectionKey: 'aset_tak_berwujud',
      judul: '9. Aset Tak Berwujud',
      konten:
        asetTakBerwujud.length > 0
          ? `Nilai perolehan: Rp${fmt(totalNilaiPerolehanTBW)}; akumulasi amortisasi: Rp${fmt(
              totalAkumulasiAmortisasi
            )}; nilai buku: Rp${fmt(totalNilaiBukuTBW)}. ${cariKebijakan('aset_tak_berwujud')}`
          : `${tidakAda('aset tak berwujud')} ${cariKebijakan('aset_tak_berwujud')}`,
    },
    {
      sectionKey: 'amortisasi',
      judul: '10. Amortisasi',
      konten: cariKebijakan('amortisasi'),
    },
    {
      sectionKey: 'investasi',
      judul: '11. Investasi',
      konten:
        (totalPenyusutanPropertiInvestasi > 0
          ? (daftarInvestasi.length > 0
              ? `Total investasi aktif (biaya perolehan): Rp${fmt(totalInvestasi)} (${daftarInvestasi.length} penempatan). `
              : `${tidakAda('investasi')} `) +
            `Akumulasi penyusutan properti investasi: Rp${fmt(totalPenyusutanPropertiInvestasi)}. ` +
            (totalImpairmentInvestasi > 0
              ? `Penurunan nilai investasi: Rp${fmt(totalImpairmentInvestasi)}. Nilai tercatat setelah akumulasi penyusutan dan penurunan nilai: Rp${fmt(
                  totalInvestasi - totalPenyusutanPropertiInvestasi - totalImpairmentInvestasi
                )}. `
              : `Tidak ada penurunan nilai investasi yang tercatat pada periode ini. Nilai tercatat setelah akumulasi penyusutan: Rp${fmt(
                  totalInvestasi - totalPenyusutanPropertiInvestasi
                )}. `)
          : (daftarInvestasi.length > 0
              ? `Total investasi aktif (nilai tercatat sebelum penurunan nilai): Rp${fmt(totalInvestasi)} (${daftarInvestasi.length} penempatan). `
              : `${tidakAda('investasi')} `) +
            (totalImpairmentInvestasi > 0
              ? `Penurunan nilai investasi: Rp${fmt(totalImpairmentInvestasi)}. Nilai tercatat setelah penurunan nilai: Rp${fmt(
                  totalInvestasi - totalImpairmentInvestasi
                )}. `
              : 'Tidak ada penurunan nilai investasi yang tercatat pada periode ini. ')) +
        (piutangHasilInvestasiRows.length > 0 ? `Piutang hasil investasi: ${listRows(piutangHasilInvestasiRows)} ` : '') +
        cariKebijakan('investasi'),
    },
    {
      sectionKey: 'utang',
      judul: '12. Utang',
      konten:
        (daftarUtangAktif.length > 0
          ? `Sisa pokok utang bank/pihak lain: Rp${fmt(totalUtangBerbunga)} (${daftarUtangAktif.length} fasilitas). `
          : 'Tidak ada utang bank/pihak lain aktif pada periode ini. ') +
        (saldoUtangBunga > 0 ? `Bunga terutang (sudah diakrual, belum dibayar): Rp${fmt(saldoUtangBunga)}. ` : '') +
        cariKebijakan('utang'),
    },
    // RC-S49 (permintaan pengguna) — URUTAN SECTION saja. "Imbalan
    // Kerja" (Utang Imbalan Kerja) & "Biaya Pinjaman" (Utang Bunga)
    // sebelumnya berada di urutan 19-20, SETELAH Arus Kas — padahal
    // keduanya rincian LIABILITAS. Keduanya dipindah ke sini, tepat
    // setelah "Utang", supaya kelompok liabilitas menyatu sesuai pola
    // penyajian SAK EP. `sectionKey` TIDAK diubah sama sekali (kunci
    // `calk_note.section_key`: seluruh catatan manual yang sudah
    // tersimpan tetap terpasang pada section-nya). `konten` juga tidak
    // disentuh — hanya posisi dalam array & nomor urut pada `judul`.
    {
      sectionKey: 'imbalan_kerja',
      judul: '13. Imbalan Kerja',
      konten:
        (saldoUtangImbalanKerja > 0
          ? `Kewajiban imbalan kerja yang telah diakrual namun belum dibayar per ${tanggalSelesai}: Rp${fmt(saldoUtangImbalanKerja)}. `
          : 'Tidak ada kewajiban imbalan kerja yang belum dibayar (akrual) pada periode ini. ') +
        cariKebijakan('imbalan_kerja'),
    },
    {
      sectionKey: 'biaya_pinjaman',
      judul: '14. Biaya Pinjaman',
      konten:
        (saldoUtangBunga > 0
          ? `Bunga utang yang telah diakrual namun belum dibayar per ${tanggalSelesai}: Rp${fmt(saldoUtangBunga)}. `
          : 'Tidak ada bunga utang yang belum dibayar (akrual) pada periode ini. ') +
        cariKebijakan('biaya_pinjaman'),
    },
    {
      sectionKey: 'simpanan_anggota',
      judul: '15. Simpanan Anggota',
      konten:
        (simpananPokokWajibRows.length > 0 ? listRows(simpananPokokWajibRows) + ' ' : '') +
        (simpananSukarelaRows.length > 0 ? listRows(simpananSukarelaRows) + ' ' : '') +
        cariKebijakan('simpanan_anggota'),
    },
    {
      sectionKey: 'ekuitas',
      judul: '16. Ekuitas',
      konten:
        (posisi.ekuitas.length > 0 ? listRows(posisi.ekuitas) + ' ' : '') +
        `${posisi.labaBerjalanLabel}: Rp${fmt(posisi.labaBerjalan)}. ` +
        cariKebijakan('ekuitas'),
    },
    {
      sectionKey: 'pendapatan',
      judul: '17. Pendapatan',
      konten:
        (labaRugi.pendapatan.length > 0
          ? labaRugi.pendapatan.map((r) => `${r.nama}: Rp${fmt(r.jumlah)}`).join('; ') + `. Total: Rp${fmt(labaRugi.totalPendapatan)}. `
          : `${tidakAda('pendapatan')} `) + cariKebijakan('pendapatan'),
    },
    {
      sectionKey: 'beban',
      judul: '18. Beban',
      konten:
        (labaRugi.beban.length > 0
          ? labaRugi.beban.map((r) => `${r.nama}: Rp${fmt(r.jumlah)}`).join('; ') + `. Total: Rp${fmt(labaRugi.totalBeban)}. `
          : `${tidakAda('beban')} `) + cariKebijakan('beban'),
    },
    {
      sectionKey: 'penghasilan_komprehensif_lain',
      judul: '19. Penghasilan Komprehensif Lain',
      konten:
        labaRugi.penghasilanKomprehensifLainRows.length === 0
          ? 'Tidak terdapat penghasilan komprehensif lain pada periode ini (tidak ada revaluasi aset tetap yang diakui di ekuitas).'
          : 'Penghasilan komprehensif lain periode ini terdiri dari: ' +
            labaRugi.penghasilanKomprehensifLainRows
              .map((r) => `${r.nama} ${r.jumlah < 0 ? '(' : ''}Rp${fmt(Math.abs(r.jumlah))}${r.jumlah < 0 ? ')' : ''}`)
              .join('; ') +
            `; jumlah ${labaRugi.penghasilanKomprehensifLain < 0 ? '(' : ''}Rp${fmt(Math.abs(labaRugi.penghasilanKomprehensifLain))}${labaRugi.penghasilanKomprehensifLain < 0 ? ')' : ''}. ` +
            'Aset tetap yang direvaluasi diukur sebesar nilai revaluasi dikurangi akumulasi penyusutan setelahnya (SAK EP Bab 17). ' +
            'Kenaikan diakui sebagai surplus revaluasi di ekuitas, kecuali sebesar pemulihan penurunan yang dahulu dibebankan ke laba rugi; ' +
            'penurunan dibebankan ke surplus revaluasi aset yang sama lebih dahulu, sisanya ke laba rugi. ' +
            'Pos ini tidak akan direklasifikasi ke laba rugi dan tidak termasuk SHU yang dibagikan. ' +
            `Total penghasilan komprehensif periode ini ${labaRugi.totalPenghasilanKomprehensif < 0 ? '(' : ''}Rp${fmt(Math.abs(labaRugi.totalPenghasilanKomprehensif))}${labaRugi.totalPenghasilanKomprehensif < 0 ? ')' : ''}.`,
    },
    {
      sectionKey: 'shu',
      judul: '20. Sisa Hasil Usaha (SHU)',
      konten: shuNarasi + ' ' + cariKebijakan('shu'),
    },
    {
      sectionKey: 'arus_kas',
      judul: '21. Arus Kas',
      konten: `Kas awal periode Rp${fmt(arusKas.kasAwal)}, kas akhir periode Rp${fmt(arusKas.kasAkhirAktual)}. ${
        arusKas.terekonsiliasi
          ? 'Rekonsiliasi arus kas sesuai dengan saldo kas/bank.'
          : `Terdapat selisih rekonsiliasi sebesar Rp${fmt(arusKas.selisihRekonsiliasi)} yang perlu ditelusuri.`
      }`,
    },
    {
      sectionKey: 'informasi_komparatif',
      judul: '22. Informasi Komparatif',
      konten: komparatifNarasi,
    },
  ];

  return { tanggalMulai, tanggalSelesai, sections };
}

// ============================================================
// 7b. CALK — penggabungan dengan edit manual pengguna (calk_note).
// Prioritas 12/N: "Tetap pertahankan calk_note agar pengguna dapat
// mengedit catatan manual... Jika user sudah mengedit manual: jangan
// menimpa isi manual secara otomatis tanpa konfirmasi."
// ============================================================
export interface CalkSectionGabungan extends CalkSection {
  kontenOtomatis: string; // versi auto-generated murni, untuk ditampilkan sebagai referensi/pembanding saat mode edit
  isManualEdit: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CalkGabunganResult {
  tanggalMulai: string;
  tanggalSelesai: string;
  periodId: string | null; // null kalau tanggalSelesai tidak masuk periode akuntansi manapun — edit manual tidak bisa disimpan
  sections: CalkSectionGabungan[];
}

/**
 * Versi CALK yang SIAP dipakai layar (CalkScreen): auto-generate lalu
 * timpa per-section dengan isi manual dari `calk_note` KALAU ADA —
 * auto-generate TIDAK PERNAH menimpa balik edit manual yang sudah
 * disimpan user (itulah kenapa `generateCALK()` murni & fungsi ini
 * yang melakukan penggabungannya, terpisah).
 */
export async function getCalkDenganEditManual(
  db: SQLite.SQLiteDatabase,
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<CalkGabunganResult> {
  const otomatis = await generateCALK(db, tanggalMulai, tanggalSelesai);
  const periodId = await resolveAccountingPeriodId(db, tanggalSelesai);

  const catatanManual = periodId
    ? await db.getAllAsync<{ section_key: string; konten: string; is_manual_edit: number; updated_at: string; updated_by: string | null }>(
        `SELECT section_key, konten, is_manual_edit, updated_at, updated_by FROM calk_note WHERE period_id = ?`,
        periodId
      )
    : [];
  const manualBySection = new Map(catatanManual.map((c) => [c.section_key, c]));

  const sections: CalkSectionGabungan[] = otomatis.sections.map((s) => {
    const manual = manualBySection.get(s.sectionKey);
    const isManualEdit = !!manual && manual.is_manual_edit === 1;
    return {
      ...s,
      kontenOtomatis: s.konten,
      konten: isManualEdit ? manual!.konten : s.konten,
      isManualEdit,
      updatedAt: isManualEdit ? manual!.updated_at : null,
      updatedBy: isManualEdit ? manual!.updated_by : null,
    };
  });

  return { tanggalMulai, tanggalSelesai, periodId, sections };
}

/** Simpan/timpa catatan manual satu section. Butuh periodId valid (lihat resolveAccountingPeriodId). */
export async function simpanCalkManual(
  db: SQLite.SQLiteDatabase,
  params: { periodId: string; sectionKey: string; konten: string; updatedBy: string }
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO calk_note (id, period_id, section_key, konten, is_manual_edit, updated_by, updated_at)
     VALUES (?,?,?,?,1,?,?)
     ON CONFLICT(period_id, section_key) DO UPDATE SET
       konten = excluded.konten, is_manual_edit = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    `${params.periodId}-${params.sectionKey}`,
    params.periodId,
    params.sectionKey,
    params.konten,
    params.updatedBy,
    now
  );
}

/** Hapus edit manual satu section — kembali memakai versi auto-generate mulai saat ini. */
export async function resetCalkKeOtomatis(
  db: SQLite.SQLiteDatabase,
  params: { periodId: string; sectionKey: string }
): Promise<void> {
  await db.runAsync(`DELETE FROM calk_note WHERE period_id = ? AND section_key = ?`, params.periodId, params.sectionKey);
}

// ============================================================
// 7c. LAPORAN KOMPARATIF (Prioritas 13/O) — murni MEMBUNGKUS fungsi
// yang sudah ada & sudah teruji, tidak ada logika perhitungan baru.
// Konvensi: "sekarang" dibandingkan ke "pembanding" (delta = sekarang
// - pembanding), sesuai penyajian laporan komparatif yang lazim
// (periode berjalan vs periode sebelumnya).
// ============================================================

/**
 * Validasi kesetaraan dua rentang periode (§O: "Jangan membandingkan
 * periode yang tidak setara. Contoh: 2026 vs 2025, bukan 2026 YTD vs
 * 2025 full year kecuali user memang memilih periode yang sama").
 * TIDAK memblokir (business call ada di tangan user — mis. membanding
 * YTD dgn YTD tahun lalu itu valid & lazim), hanya memberi peringatan
 * eksplisit yang bisa ditampilkan UI kalau rentang harinya beda jauh.
 */
export function validasiKesetaraanPeriode(
  periodeSekarang: { mulai: string; selesai: string },
  periodePembanding: { mulai: string; selesai: string }
): { setara: boolean; peringatan: string | null } {
  const hariSekarang =
    (new Date(periodeSekarang.selesai).getTime() - new Date(periodeSekarang.mulai).getTime()) / 86_400_000;
  const hariPembanding =
    (new Date(periodePembanding.selesai).getTime() - new Date(periodePembanding.mulai).getTime()) / 86_400_000;
  const selisihHari = Math.abs(hariSekarang - hariPembanding);

  if (selisihHari <= 3) return { setara: true, peringatan: null }; // toleransi kecil (tahun kabisat, dst)

  return {
    setara: false,
    peringatan: `Rentang periode berbeda jauh (${Math.round(hariSekarang)} hari vs ${Math.round(
      hariPembanding
    )} hari) — pastikan ini disengaja (mis. membandingkan periode berjalan/YTD dengan periode lengkap tahun sebelumnya bisa menyesatkan).`,
  };
}

export interface PosisiKeuanganKomparatif {
  sekarang: PosisiKeuanganResult;
  pembanding: PosisiKeuanganResult;
  perubahanTotalAset: Rupiah;
  perubahanTotalLiabilitas: Rupiah;
  perubahanTotalEkuitas: Rupiah;
  peringatanPeriode: string | null;
}

/** Posisi Keuangan dua titik tanggal berdampingan (mis. akhir tahun ini vs akhir tahun lalu). */
export async function getPosisiKeuanganKomparatif(
  db: SQLite.SQLiteDatabase,
  tanggalSekarang: string,
  tanggalPembanding: string
): Promise<PosisiKeuanganKomparatif> {
  const [sekarang, pembanding] = await Promise.all([
    getPosisiKeuangan(db, tanggalSekarang),
    getPosisiKeuangan(db, tanggalPembanding),
  ]);
  // Posisi Keuangan itu sendiri titik-waktu (bukan rentang), jadi
  // kesetaraan yang relevan bukan rentang hari melainkan "apakah
  // sama-sama akhir periode akuntansi" — cek sederhana lewat bounds.
  const boundsSekarang = await getPeriodBounds(db, tanggalSekarang);
  const boundsPembanding = await getPeriodBounds(db, tanggalPembanding);
  const peringatanPeriode =
    boundsSekarang && boundsPembanding && boundsSekarang.periodeSelesai !== tanggalSekarang
      ? null // bukan akhir periode -> validasi rentang tidak relevan, biarkan user yang menilai
      : boundsSekarang && boundsPembanding
      ? validasiKesetaraanPeriode(
          { mulai: boundsSekarang.periodeMulai, selesai: tanggalSekarang },
          { mulai: boundsPembanding.periodeMulai, selesai: tanggalPembanding }
        ).peringatan
      : null;

  return {
    sekarang,
    pembanding,
    perubahanTotalAset: sekarang.totalAset - pembanding.totalAset,
    perubahanTotalLiabilitas: sekarang.totalLiabilitas - pembanding.totalLiabilitas,
    perubahanTotalEkuitas: sekarang.totalEkuitas - pembanding.totalEkuitas,
    peringatanPeriode,
  };
}

export interface LabaRugiKomparatif {
  sekarang: LabaRugiResult;
  pembanding: LabaRugiResult;
  perubahanTotalPendapatan: Rupiah;
  perubahanTotalBeban: Rupiah;
  perubahanHasilUsaha: Rupiah;
  peringatanPeriode: string | null;
}

// ============================================================
// INFORMASI SHU RAT (basis KAS/realisasi) — audit ulang (permintaan
// pengguna, request baru §2/§3/§10/§14): laporan TAMBAHAN/INFORMASI
// untuk membantu RAT menentukan jumlah SHU yang akan dibagikan.
//
// PRINSIP UTAMA (§14, aturan paling penting permintaan ini): laporan
// keuangan (getLabaRugi di atas) TETAP basis AKRUAL, TIDAK DIUBAH sama
// sekali oleh fungsi ini. Fungsi ini murni laporan TAMBAHAN yang
// membaca jurnal yang SAMA dari accounting engine (§3 — "SATU
// TRANSAKSI -> accounting engine -> laporan akrual -> laporan kas/RAT"),
// TIDAK membuat transaksi/jurnal baru sama sekali.
//
// DEFINISI "realisasi kas" (§2 — "pendapatan dan beban yang benar-benar
// telah direalisasikan melalui kas/bank"): sebuah jurnal dianggap
// "kas-real" untuk baris Pendapatan/Beban di dalamnya JIKA:
//  (a) jurnal yang SAMA (journal_id yang sama) juga punya baris yang
//      menyentuh akun Kas/Bank (definisi akun kas/bank SAMA PERSIS
//      dengan yang dipakai getArusKas — mapping KAS_UMUM + seluruh
//      bank_account aktif) — menangkap SELURUH pola transaksi
//      kas-langsung (angsuran jasa/denda dibayar tunai, penerimaan/
//      pengeluaran lain, dst); ATAU
//  (b) [PHASE 6 FINAL FIX §1] jurnal ini adalah jurnal PENGAKUAN
//      pendapatan/biaya diterima/dibayar dimuka
//      (pendapatan_dimuka_pengakuan/biaya_dimuka_pengakuan) yang bisa
//      ditelusuri balik lewat FK yang SUDAH ADA di skema ke jurnal
//      PENERIMAAN/PEMBAYARAN ASLI-nya (pendapatan_diterima_dimuka.
//      journal_id/biaya_dibayar_dimuka.journal_id), DAN jurnal asli
//      itu TERBUKTI menyentuh Kas/Bank. Linkage EKSPLISIT dari data
//      yang sudah tersimpan — BUKAN estimasi/tebakan.
//
// KETERBATASAN YANG MASIH ADA (didokumentasikan, bukan disembunyikan):
// jalur (b) HANYA mencakup pengakuan bertahap yang lewat mekanisme
// register dimuka existing (pendapatan_diterima_dimuka/
// biaya_dibayar_dimuka — dipakai menu Penerimaan Dimuka & Biaya
// Dibayar Dimuka). Pola "kas diterima/dibayar dulu, pendapatan/beban
// diakui belakangan" yang DICATAT MANUAL lewat jurnal umum TANPA
// melalui kedua register ini TIDAK dapat ditelusuri linkage-nya secara
// reliable — baris tsb TIDAK dihitung sebagai realisasi kas pada
// periode pengakuannya (bukan diabaikan sewenang-wenang, murni karena
// tidak ada linkage tersimpan untuk dibuktikan — §1 permintaan
// pengguna: "jangan membuat estimasi... dokumentasikan limitation").
// ============================================================
export interface InformasiShuRatResult {
  periodeMulai: string;
  periodeSelesai: string;
  /** SHU Laporan Keuangan (Akrual) — SAMA PERSIS dengan getLabaRugi(...).hasilUsaha, HANYA disalin ke sini untuk kemudahan tampilan perbandingan (§10). */
  shuLaporanKeuanganAkrual: Rupiah;
  /** Pendapatan yang benar-benar diterima kas/bank dalam periode (lihat definisi "realisasi kas" di atas). */
  pendapatanRealisasiKas: Rupiah;
  /** Beban yang benar-benar dibayar kas/bank dalam periode. */
  bebanRealisasiKas: Rupiah;
  /** Informasi SHU RAT (basis kas) = pendapatanRealisasiKas - bebanRealisasiKas. */
  shuInformasiRat: Rupiah;
  /** Selisih antara SHU akrual & SHU kas — BOLEH berbeda, BUKAN error (§2). */
  selisihAkrualVsKas: Rupiah;
  /**
   * PHASE 6 §I (permintaan pengguna) — bridge rekonsiliasi 4-baris.
   * SEMUA dihitung dari data yang SUDAH diambil di atas (totalPendapatan/
   * totalBeban dari getLabaRugi, pendapatanRealisasiKas/bebanRealisasiKas
   * dari query yang sama) — TIDAK ADA query/rumus akrual-vs-kas baru,
   * murni pemecahan selisih yang sudah ada menjadi 4 komponen bertanda:
   *
   *   SHU Akrual
   *   - pendapatanAkrualBelumKas
   *   + pendapatanKasBelumAkrual
   *   + bebanAkrualBelumKas
   *   - bebanKasBelumAkrual
   *   = SHU Kas   (identitas aljabar, diverifikasi lewat test)
   *
   * Dengan metodologi "realisasi kas" existing (satu jurnal yang SAMA
   * menyentuh baris Kas/Bank), `pendapatanKasBelumAkrual`/
   * `bebanKasBelumAkrual` SECARA STRUKTURAL akan bernilai 0 pada
   * hampir semua kasus nyata di aplikasi ini (kas tidak pernah
   * "mendahului" pengakuan akrual dalam definisi ini) — TETAP
   * dihitung (bukan di-hardcode 0) untuk kebenaran identitas
   * aljabar & supaya kalau suatu saat ada pola transaksi baru yang
   * menghasilkan nilai != 0, itu otomatis tertangkap tanpa perlu
   * mengubah rumus ini.
   */
  pendapatanAkrualBelumKas: Rupiah;
  pendapatanKasBelumAkrual: Rupiah;
  bebanAkrualBelumKas: Rupiah;
  bebanKasBelumAkrual: Rupiah;
  /**
   * RC-S133.4.3 (jalur 5) — bagian dari `pendapatanRealisasiKas` yang
   * berasal dari SALDO AWAL akun pendapatan (dicatat sebelum memakai
   * aplikasi, dianggap sudah diterima tunai kecuali dinyatakan belum).
   */
  pendapatanSaldoAwalTunai: Rupiah;
  /** RC-S133.4.3 (jalur 5) — sama untuk beban (bagian dari `bebanRealisasiKas`). */
  bebanSaldoAwalTunai: Rupiah;
}

export async function getInformasiShuRAT(
  db: SQLite.SQLiteDatabase,
  periodeMulai: string,
  periodeSelesai: string
): Promise<InformasiShuRatResult> {
  const labaRugi = await getLabaRugi(db, periodeMulai, periodeSelesai);
  const shuLaporanKeuanganAkrual = labaRugi.hasilUsaha;

  // Akun Kas/Bank — definisi SAMA PERSIS dengan getArusKas() di atas
  // (satu sumber kebenaran untuk "apa itu akun kas/bank" di app ini).
  const kasBankAccounts = await getAkunKasBankUntukLaporan(db);
  const kasBankIds = kasBankAccounts.map((a) => a.id);

  if (kasBankIds.length === 0) {
    return {
      periodeMulai,
      periodeSelesai,
      shuLaporanKeuanganAkrual,
      pendapatanRealisasiKas: 0,
      bebanRealisasiKas: 0,
      shuInformasiRat: 0,
      selisihAkrualVsKas: shuLaporanKeuanganAkrual,
      pendapatanAkrualBelumKas: Math.max(0, labaRugi.totalPendapatan),
      pendapatanKasBelumAkrual: 0,
      bebanAkrualBelumKas: Math.max(0, labaRugi.totalBeban),
      bebanKasBelumAkrual: 0,
      pendapatanSaldoAwalTunai: 0,
      bebanSaldoAwalTunai: 0,
    };
  }

  const placeholders = kasBankIds.map(() => '?').join(',');
  // PHASE 6 FINAL FIX §1 (permintaan pengguna): "realisasi kas" untuk
  // baris Pendapatan/Beban sekarang diakui lewat DUA jalur, BUKAN
  // hanya satu:
  //
  //  1. (EXISTING, tidak diubah) jurnal INI juga punya baris yang
  //     menyentuh Kas/Bank secara langsung.
  //
  //  2/3. (BARU) jurnal ini adalah jurnal PENGAKUAN pendapatan/biaya
  //     diterima/dibayar dimuka (`pendapatan_dimuka_pengakuan` /
  //     `biaya_dimuka_pengakuan`, TABEL YANG SUDAH ADA sejak sebelum
  //     Phase 6 — bukan tabel baru), DAN jurnal PENERIMAAN/PEMBAYARAN
  //     ASLI-nya (`pendapatan_diterima_dimuka.journal_id` /
  //     `biaya_dibayar_dimuka.journal_id`) TERBUKTI menyentuh Kas/Bank.
  //     Ini LINKAGE EKSPLISIT lewat FK yang sudah ada di skema — BUKAN
  //     estimasi. Contoh persis dari instruksi: kas diterima tanggal 1
  //     (Dr Kas / Cr Pendapatan Diterima Dimuka — TIDAK menyentuh akun
  //     PENDAPATAN sama sekali, jadi TIDAK pernah terhitung di jalur
  //     manapun pada tanggal itu), lalu jurnal pengakuan tanggal 2
  //     (Dr Pendapatan Diterima Dimuka / Cr Pendapatan Jasa — TIDAK
  //     menyentuh Kas/Bank) kini ikut terhitung sebagai realisasi kas
  //     lewat jalur 2, karena bisa ditelusuri balik ke penerimaan kas
  //     ASLI-nya. TIDAK ADA kas yang dihitung dua kali: fungsi ini
  //     tidak pernah menjumlahkan baris Kas itu sendiri sama sekali
  //     (hanya baris Pendapatan/Beban), jadi "kas baru" pada tanggal 2
  //     tidak pernah ada untuk digandakan — baris Rp100.000 pada
  //     tanggal 2 HANYA muncul SATU KALI di sini (jurnal tanggal 1
  //     tidak match kategori PENDAPATAN/BEBAN sama sekali).
  //
  // KETERBATASAN YANG MASIH ADA (didokumentasikan eksplisit, bukan
  // estimasi): linkage ini HANYA mencakup mekanisme
  // pendapatan_diterima_dimuka/biaya_dibayar_dimuka yang sudah ada di
  // aplikasi (dipakai menu Penerimaan Dimuka & Biaya Dibayar Dimuka).
  // Kalau ada pola "kas dulu, pendapatan diakui belakangan" LAIN yang
  // TIDAK lewat kedua mekanisme ini (mis. dicatat manual lewat jurnal
  // umum tanpa melalui register dimuka), sistem TIDAK dapat menelusuri
  // linkage-nya secara reliable — baris tsb TETAP dianggap bukan
  // realisasi kas pada periode pengakuannya (bukan diabaikan, hanya
  // tidak bisa dibuktikan tanpa linkage eksplisit yang tersimpan).
  const rows = await db.getAllAsync<{ kategori: string; debit: number; kredit: number }>(
    `SELECT a.kategori, je.debit, je.kredit
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     JOIN account a ON a.id = je.account_id
     WHERE j.status IN ('POSTED','REVERSED')
       AND j.tanggal BETWEEN ? AND ?
       AND a.kategori IN ('PENDAPATAN','BEBAN')
       AND (
         je.journal_id IN (
           SELECT je2.journal_id FROM journal_entry je2 WHERE je2.account_id IN (${placeholders})
         )
         OR je.journal_id IN (
           SELECT pdp.journal_id
           FROM pendapatan_dimuka_pengakuan pdp
           JOIN pendapatan_diterima_dimuka pd ON pd.id = pdp.pendapatan_dimuka_id
           WHERE pd.journal_id IN (
             SELECT je3.journal_id FROM journal_entry je3 WHERE je3.account_id IN (${placeholders})
           )
         )
         OR je.journal_id IN (
           SELECT bdp.journal_id
           FROM biaya_dimuka_pengakuan bdp
           JOIN biaya_dibayar_dimuka bd ON bd.id = bdp.biaya_dimuka_id
           WHERE bd.journal_id IN (
             SELECT je4.journal_id FROM journal_entry je4 WHERE je4.account_id IN (${placeholders})
           )
         )
       )`,
    periodeMulai,
    periodeSelesai,
    ...kasBankIds,
    ...kasBankIds,
    ...kasBankIds
  );

  let pendapatanRealisasiKas = 0;
  let bebanRealisasiKas = 0;
  for (const r of rows) {
    if (r.kategori === 'PENDAPATAN') pendapatanRealisasiKas += r.kredit - r.debit;
    else if (r.kategori === 'BEBAN') bebanRealisasiKas += r.debit - r.kredit;
  }

  // JALUR 4 (fix konsistensi v49, permintaan pengguna §4): PENAGIHAN
  // PIUTANG JASA yang pendapatannya SUDAH diakui secara akrual pada
  // periode SEBELUMNYA.
  //
  // Bentuk jurnalnya:
  //     Dr Kas / Bank
  //     Cr Piutang Jasa Pinjaman
  // TANPA baris Pendapatan sama sekali — karena pendapatannya memang
  // sudah diakui saat akrual (Dr Piutang Jasa / Cr Pendapatan Jasa).
  // Akibatnya jalur 1-3 di atas TIDAK PERNAH melihat penerimaan kas
  // ini, sehingga SHU basis kas melaporkan 0 padahal kasnya benar-benar
  // masuk. SHU AKRUAL tidak boleh bertambah lagi di periode penagihan
  // (dan memang tidak: `labaRugi` di atas tidak menyentuh baris ini),
  // tetapi SHU KAS harus mencerminkannya.
  //
  // BUKAN heuristik "semua Dr Kas / Cr Piutang dianggap pendapatan":
  // akun yang dipakai HANYA akun yang benar-benar dipetakan sebagai
  // Piutang Jasa lewat mapping EXISTING
  // `AKRUAL_JASA_PINJAMAN / DEBIT_PIUTANG_JASA` — yaitu akun yang
  // menurut model aplikasi ini HANYA terisi lewat pengakuan pendapatan
  // jasa akrual. Piutang POKOK (mapping PENCAIRAN_PINJAMAN /
  // DEBIT_PIUTANG) SENGAJA TIDAK ikut: penagihan pokok bukan
  // pendapatan.
  //
  // Anti-double-count:
  //  - Jurnal ini tidak punya baris PENDAPATAN, jadi tidak mungkin
  //    tercatat lewat jalur 1.
  //  - Kalau satu jurnal pembayaran mengandung KEDUANYA (sebagian jasa
  //    sudah diakru, sebagian belum), jalur 1 menghitung porsi
  //    Pendapatan-nya dan jalur ini menghitung porsi Piutang Jasa-nya —
  //    dua potongan pendapatan yang BERBEDA, bukan angka yang sama
  //    dihitung dua kali.
  //  - Dihitung NET (kredit - debit) supaya jurnal reversal penagihan
  //    (Dr Piutang Jasa / Cr Kas) otomatis mengurangi kembali, bukan
  //    menggantung.
  //  - Write-off (Dr Penyisihan / Cr Piutang Jasa) TIDAK ikut karena
  //    jurnalnya tidak menyentuh Kas/Bank sama sekali.
  const piutangJasaAccounts = await db.getAllAsync<{ account_id: string }>(
    `SELECT account_id FROM account_mapping
     WHERE transaction_type = 'AKRUAL_JASA_PINJAMAN' AND role = 'DEBIT_PIUTANG_JASA'`
  );
  if (piutangJasaAccounts.length > 0) {
    const pjPlaceholders = piutangJasaAccounts.map(() => '?').join(',');
    const pjIds = piutangJasaAccounts.map((a) => a.account_id);
    const penagihanRows = await db.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT je.debit, je.kredit
       FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       WHERE j.status IN ('POSTED','REVERSED')
         AND j.tanggal BETWEEN ? AND ?
         AND je.account_id IN (${pjPlaceholders})
         AND je.journal_id IN (
           SELECT je5.journal_id FROM journal_entry je5
           WHERE je5.account_id IN (${placeholders}) AND je5.debit > 0
         )`,
      periodeMulai,
      periodeSelesai,
      ...pjIds,
      ...kasBankIds
    );
    for (const r of penagihanRows) {
      pendapatanRealisasiKas += r.kredit - r.debit;
    }
  }

  // JALUR 5 (RC-S133.4.3): SALDO AWAL akun Pendapatan/Beban. Koperasi
  // yang mulai memakai aplikasi di tengah tahun buku memasukkan
  // pendapatan/beban Jan–cut-off lewat Saldo Awal Akun (lawan akun
  // kliring 3-5000, bukan Kas) — kasnya sudah ada di saldo awal Kas,
  // sehingga jalur 1–4 tidak pernah melihatnya dan SHU Basis Kas
  // keliru menjadi Rp0. Dianggap sudah tunai KECUALI bagian yang
  // dinyatakan belum tunai di layar Saldo Awal. Jurnal saldo awal yang
  // sudah menyentuh Kas/Bank dikecualikan (sudah dihitung jalur 1).
  // Lihat src/accounting/SaldoAwalRealisasiKas.ts.
  const saldoAwalTunai = await hitungRealisasiKasSaldoAwal(db, periodeMulai, periodeSelesai, kasBankIds);
  pendapatanRealisasiKas += saldoAwalTunai.pendapatan;
  bebanRealisasiKas += saldoAwalTunai.beban;

  const shuInformasiRat = pendapatanRealisasiKas - bebanRealisasiKas;

  // §I: bridge 4-baris — turunan langsung dari totalPendapatan/
  // totalBeban (basis akrual, dari getLabaRugi di atas) vs
  // pendapatanRealisasiKas/bebanRealisasiKas (basis kas, dihitung di
  // atas) — TIDAK ADA query tambahan.
  const pendapatanAkrualBelumKas = Math.max(0, labaRugi.totalPendapatan - pendapatanRealisasiKas);
  const pendapatanKasBelumAkrual = Math.max(0, pendapatanRealisasiKas - labaRugi.totalPendapatan);
  const bebanAkrualBelumKas = Math.max(0, labaRugi.totalBeban - bebanRealisasiKas);
  const bebanKasBelumAkrual = Math.max(0, bebanRealisasiKas - labaRugi.totalBeban);

  return {
    periodeMulai,
    periodeSelesai,
    shuLaporanKeuanganAkrual,
    pendapatanRealisasiKas,
    bebanRealisasiKas,
    shuInformasiRat,
    selisihAkrualVsKas: shuLaporanKeuanganAkrual - shuInformasiRat,
    pendapatanAkrualBelumKas,
    pendapatanKasBelumAkrual,
    bebanAkrualBelumKas,
    bebanKasBelumAkrual,
    pendapatanSaldoAwalTunai: saldoAwalTunai.pendapatan,
    bebanSaldoAwalTunai: saldoAwalTunai.beban,
  };
}

/** Laba Rugi dua rentang periode berdampingan (mis. bulan ini vs bulan lalu, atau tahun ini vs tahun lalu). */
export async function getLabaRugiKomparatif(
  db: SQLite.SQLiteDatabase,
  periodeSekarang: { mulai: string; selesai: string },
  periodePembanding: { mulai: string; selesai: string }
): Promise<LabaRugiKomparatif> {
  const [sekarang, pembanding] = await Promise.all([
    getLabaRugi(db, periodeSekarang.mulai, periodeSekarang.selesai),
    getLabaRugi(db, periodePembanding.mulai, periodePembanding.selesai),
  ]);

  return {
    sekarang,
    pembanding,
    perubahanTotalPendapatan: sekarang.totalPendapatan - pembanding.totalPendapatan,
    perubahanTotalBeban: sekarang.totalBeban - pembanding.totalBeban,
    perubahanHasilUsaha: sekarang.hasilUsaha - pembanding.hasilUsaha,
    peringatanPeriode: validasiKesetaraanPeriode(periodeSekarang, periodePembanding).peringatan,
  };
}

/**
 * PHASE 6 §D (permintaan pengguna) — komparatif untuk `getLHU()`
 * (bukan `getLabaRugi()` — LabaRugiScreen.tsx/LHU yang ditampilkan ke
 * pengguna memakai `getLHU`, struktur klasifikasi khas koperasi
 * "Partisipasi Anggota / Beban Usaha / Hasil Investasi / dst", BUKAN
 * struktur generik `getLabaRugi`). Pola SAMA PERSIS dengan
 * `getLabaRugiKomparatif`/`getPosisiKeuanganKomparatif` di atas — panggil
 * `getLHU()` yang SUDAH ADA dua kali, TIDAK ADA rumus/query akuntansi
 * baru sama sekali.
 */
export interface LhuKomparatif {
  sekarang: LhuResult;
  pembanding: LhuResult;
  perubahanJumlahPartisipasiAnggota: Rupiah;
  perubahanJumlahBebanUsaha: Rupiah;
  perubahanShuBruto: Rupiah;
  perubahanShuSebelumPajak: Rupiah;
  perubahanShuNeto: Rupiah;
  peringatanPeriode: string | null;
}

export async function getLHUKomparatif(
  db: SQLite.SQLiteDatabase,
  periodeSekarang: { mulai: string; selesai: string },
  periodePembanding: { mulai: string; selesai: string }
): Promise<LhuKomparatif> {
  const [sekarang, pembanding] = await Promise.all([
    getLHU(db, periodeSekarang.mulai, periodeSekarang.selesai),
    getLHU(db, periodePembanding.mulai, periodePembanding.selesai),
  ]);

  return {
    sekarang,
    pembanding,
    perubahanJumlahPartisipasiAnggota: sekarang.jumlahPartisipasiAnggota - pembanding.jumlahPartisipasiAnggota,
    perubahanJumlahBebanUsaha: sekarang.jumlahBebanUsaha - pembanding.jumlahBebanUsaha,
    perubahanShuBruto: sekarang.shuBruto - pembanding.shuBruto,
    perubahanShuSebelumPajak: sekarang.shuSebelumPajak - pembanding.shuSebelumPajak,
    perubahanShuNeto: sekarang.shuNeto - pembanding.shuNeto,
    peringatanPeriode: validasiKesetaraanPeriode(periodeSekarang, periodePembanding).peringatan,
  };
}

/**
 * BARU (Prioritas 13/O — sebelumnya belum ada sama sekali, hanya
 * Posisi Keuangan & Laba Rugi yang punya versi komparatif). Sama
 * persis polanya: murni membungkus `getPerubahanEkuitas()` dua kali.
 */
export interface PerubahanEkuitasKomparatif {
  sekarang: PerubahanEkuitasResult;
  pembanding: PerubahanEkuitasResult;
  perubahanTotalSaldoAkhir: Rupiah;
  peringatanPeriode: string | null;
}

export async function getPerubahanEkuitasKomparatif(
  db: SQLite.SQLiteDatabase,
  periodeSekarang: { mulai: string; selesai: string },
  periodePembanding: { mulai: string; selesai: string }
): Promise<PerubahanEkuitasKomparatif> {
  const [sekarang, pembanding] = await Promise.all([
    getPerubahanEkuitas(db, periodeSekarang.mulai, periodeSekarang.selesai),
    getPerubahanEkuitas(db, periodePembanding.mulai, periodePembanding.selesai),
  ]);

  return {
    sekarang,
    pembanding,
    perubahanTotalSaldoAkhir: sekarang.totalSaldoAkhir - pembanding.totalSaldoAkhir,
    peringatanPeriode: validasiKesetaraanPeriode(periodeSekarang, periodePembanding).peringatan,
  };
}

/**
 * BARU (Prioritas 13/O). Murni membungkus `getArusKas()` dua kali —
 * "jika struktur existing mendukung" (memang mendukung, getArusKas
 * sudah menerima rentang tanggal bebas sejak awal).
 */
export interface ArusKasKomparatif {
  sekarang: ArusKasResult;
  pembanding: ArusKasResult;
  perubahanKasAkhir: Rupiah;
  peringatanPeriode: string | null;
}

export async function getArusKasKomparatif(
  db: SQLite.SQLiteDatabase,
  periodeSekarang: { mulai: string; selesai: string },
  periodePembanding: { mulai: string; selesai: string }
): Promise<ArusKasKomparatif> {
  const [sekarang, pembanding] = await Promise.all([
    getArusKas(db, periodeSekarang.mulai, periodeSekarang.selesai),
    getArusKas(db, periodePembanding.mulai, periodePembanding.selesai),
  ]);

  return {
    sekarang,
    pembanding,
    perubahanKasAkhir: sekarang.kasAkhirAktual - pembanding.kasAkhirAktual,
    peringatanPeriode: validasiKesetaraanPeriode(periodeSekarang, periodePembanding).peringatan,
  };
}
