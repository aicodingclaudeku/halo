import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, MissingAccountMappingError } from '@/accounting/AccountMapping';
import { requirePermission, requirePermissionAtauSystemTrigger } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah, roundToRupiah } from '@/utils/money';
import { toPeriode, tanggalAkhirPeriode, selisihBulan, isValidPeriode, tambahBulan } from '@/accounting/PeriodeUtil';
import { getTanggalLokalHariIni, toTanggalLokal } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * Penyusutan Aset Tetap & Amortisasi Aset Tak Berwujud — metode GARIS
 * LURUS, dijalankan bulanan (dipicu dari UI atau dari lifecycle saat
 * aplikasi dibuka, bukan cron/background job — app ini offline-first
 * tanpa server, jadi prosesnya "hitung & catat untuk periode X" selalu
 * terpicu oleh aksi/pemakaian, BUKAN jalan sendiri di background).
 *
 * PERIODE YANG TERLEWAT DIKEJAR MUNDUR (catch-up). Trigger saat aplikasi
 * dibuka memproses SELURUH periode yang sudah jatuh tempo sejak tanggal
 * perolehan tiap aset — bukan hanya bulan berjalan — sehingga aset yang
 * dicatat dengan tanggal perolehan mundur, atau bulan-bulan saat
 * aplikasi tidak dibuka, tetap diakui. Batasnya: sebuah periode baru
 * diproses setelah bulannya BERAKHIR (lihat blok "KEBIJAKAN PERIODE
 * PENYUSUTAN" di bawah) — tidak ada posting bulan berjalan yang belum
 * genap, dan tidak ada posting periode masa depan.
 *
 * Rumus: nilai penyusutan bulanan = (nilai perolehan - nilai residu) / masa manfaat (bulan).
 * Jurnal per periode per aset:
 *   DEBIT  Beban Penyusutan
 *   KREDIT Akumulasi Penyusutan Aset Tetap
 *
 * ANTI-DUPLIKASI dua lapis:
 *  1. Cek dulu apakah (aset_id, periode) sudah ada di aset_penyusutan
 *     sebelum membuat jurnal (menghindari kerja & nomor jurnal
 *     terbuang untuk kasus umum).
 *  2. UNIQUE(aset_id, periode) di level database (lihat schema.ts) —
 *     kalau ada race condition/bug, INSERT akan gagal, bukan membuat
 *     baris dobel. Jurnal yang sudah terlanjur dibuat sebelum gagal
 *     insert ini tetap batal karena satu withTransaction (rollback).
 *
 * TIDAK PERNAH mengubah/menghapus jurnal atau baris aset_penyusutan
 * yang sudah ada — proses ini HANYA menambah baris baru untuk periode
 * yang belum diproses.
 */

export interface AsetPenyusutanRow {
  id: string;
  asetId: string;
  namaAset: string;
  nomorAset: string;
  periode: string;
  tanggal: string;
  nilaiPenyusutan: Rupiah;
  journalId: string;
  nomorJurnal: string | null;
}

/** Hitung nilai penyusutan bulanan garis lurus. Tidak pernah negatif (aset dengan residu >= perolehan tidak disusutkan). */
export function hitungPenyusutanBulanan(
  nilaiPerolehan: Rupiah,
  nilaiResidu: Rupiah,
  masaManfaatBulan: number
): Rupiah {
  if (masaManfaatBulan <= 0) return 0;
  const dasar = nilaiPerolehan - nilaiResidu;
  if (dasar <= 0) return 0;
  return roundToRupiah(dasar / masaManfaatBulan);
}

// ============================================================
// RC-S88 — DASAR PENYUSUTAN SETELAH REVALUASI (SAK EP Bab 17)
// ============================================================
// Setelah aset tetap direvaluasi, nilai tercatatnya = nilai revaluasi.
// Penyusutan berikutnya dihitung PROSPEKTIF: (nilai revaluasi − residu)
// dibagi SISA masa manfaat, mulai periode pertama yang berakhir SETELAH
// tanggal revaluasi. Masa manfaat total tidak berubah, sehingga status
// SELESAI (idx >= masa manfaat) tetap sama. Penyusutan periode sebelum
// tanggal revaluasi sudah wajib lengkap saat revaluasi diposting
// (dijaga PenyesuaianNilaiWajarService), jadi tidak ada periode lama
// yang tercampur dengan dasar baru.
//
// Revaluasi dibaca langsung dari register `penyesuaian_nilai_wajar`
// (status DIPOSTING, objek ASET_TETAP) — bukan import service, supaya
// tidak ada ketergantungan melingkar.

export interface DasarPenyusutanAset {
  /** Nilai yang disusutkan: biaya perolehan, atau nilai revaluasi terakhir. */
  nilaiDasar: Rupiah;
  nilaiResidu: Rupiah;
  /** Indeks bulan (dari bulan perolehan) periode pertama yang memakai dasar ini. */
  mulaiIdx: number;
  /** Jumlah bulan penyusutan yang tersisa sejak `mulaiIdx`. */
  sisaBulan: number;
  /** Tanggal revaluasi terakhir yang diposting, atau null bila belum pernah. */
  tanggalRevaluasi: string | null;
  /** Penyusutan bulanan menurut dasar ini (0 bila tidak ada lagi yang disusutkan). */
  nilaiBulanan: Rupiah;
}

interface AsetUntukDasar {
  id: string;
  nilai_perolehan: number;
  nilai_residu: number | null;
  masa_manfaat_bulan: number;
  tanggal_perolehan: string;
}

/** Revaluasi terakhir yang DIPOSTING untuk sebuah aset (opsional: s.d. tanggal tertentu). */
export async function getRevaluasiTerakhirAsetPadaDb(
  db: SQLite.SQLiteDatabase,
  asetId: string,
  sampaiTanggal?: string
): Promise<{ tanggal: string; nilaiWajar: Rupiah } | null> {
  try {
    const r = await db.getFirstAsync<{ tanggal: string; nilai_wajar: number }>(
      `SELECT tanggal, nilai_wajar FROM penyesuaian_nilai_wajar
        WHERE objek = 'ASET_TETAP' AND aset_tetap_id = ? AND status = 'DIPOSTING'
          ${sampaiTanggal ? 'AND tanggal <= ?' : ''}
        ORDER BY tanggal DESC, diposting_at DESC LIMIT 1`,
      ...(sampaiTanggal ? [asetId, sampaiTanggal] : [asetId])
    );
    return r ? { tanggal: r.tanggal, nilaiWajar: r.nilai_wajar } : null;
  } catch (e) {
    // Database yang belum dimigrasi ke v73 belum mengenal revaluasi.
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

/** Dasar penyusutan efektif sebuah aset — biaya perolehan, atau nilai revaluasi terakhir. */
export async function getDasarPenyusutanAsetPadaDb(
  db: SQLite.SQLiteDatabase,
  aset: AsetUntukDasar
): Promise<DasarPenyusutanAset> {
  const nilaiResidu = aset.nilai_residu ?? 0;
  const reval = await getRevaluasiTerakhirAsetPadaDb(db, aset.id);
  if (!reval) {
    return {
      nilaiDasar: aset.nilai_perolehan,
      nilaiResidu,
      mulaiIdx: 0,
      sisaBulan: aset.masa_manfaat_bulan,
      tanggalRevaluasi: null,
      nilaiBulanan: hitungPenyusutanBulanan(aset.nilai_perolehan, nilaiResidu, aset.masa_manfaat_bulan),
    };
  }
  const periodeReval = toPeriode(reval.tanggal);
  const idxReval = indeksBulanPenyusutan(aset.tanggal_perolehan, periodeReval);
  // Bulan revaluasi ikut dasar LAMA hanya bila bulannya sudah berakhir
  // pada tanggal revaluasi (revaluasi tepat di akhir bulan).
  const mulaiIdx = Math.max(tanggalAkhirPeriode(periodeReval) <= reval.tanggal ? idxReval + 1 : idxReval, 0);
  const sisaBulan = Math.max(aset.masa_manfaat_bulan - mulaiIdx, 0);
  return {
    nilaiDasar: reval.nilaiWajar,
    nilaiResidu,
    mulaiIdx,
    sisaBulan,
    tanggalRevaluasi: reval.tanggal,
    nilaiBulanan: sisaBulan > 0 ? hitungPenyusutanBulanan(reval.nilaiWajar, nilaiResidu, sisaBulan) : 0,
  };
}

/**
 * Indeks bulan ke berapa (0-based) periode ini dari bulan perolehan.
 * < 0 berarti sebelum aset diperoleh (belum mulai disusutkan).
 * >= masaManfaatBulan berarti sudah lewat masa manfaat (selesai disusutkan).
 */
function indeksBulanPenyusutan(tanggalPerolehan: string, periode: string): number {
  return selisihBulan(toPeriode(tanggalPerolehan), periode);
}

// ============================================================
// KEBIJAKAN PERIODE PENYUSUTAN — SATU SUMBER, DIPAKAI SEMUA JALUR
// ------------------------------------------------------------
// Dua aturan berbeda yang sering tertukar; keduanya didefinisikan
// HANYA di sini supaya status layar, trigger otomatis, catch-up,
// proses manual, dan tutup periode tidak pernah memakai policy yang
// berbeda-beda:
//
// 1. PERIODE PERTAMA (bulan perolehan dihitung PENUH).
//    Ini kebijakan yang MEMANG SUDAH BERLAKU sejak awal lewat
//    `indeksBulanPenyusutan` di atas (idx 0 = bulan perolehan), dipakai
//    `getStatusPenyusutanPeriode` & `prosesPenyusutanAset`. TIDAK
//    DIUBAH oleh perbaikan ini. Perolehan 2026-07-01 MAUPUN 2026-07-15
//    sama-sama mulai disusutkan pada periode '2026-07' sebesar satu
//    bulan penuh (tidak ada proporsi harian di mana pun di aplikasi
//    ini), dan masa manfaat dihitung dari periode itu.
//
// 2. JATUH TEMPO PENGAKUAN (cutoff bulan penuh). BARU — inilah inti
//    perbaikan retroaktif. Sebuah periode baru boleh DIAKUI setelah
//    bulannya benar-benar BERAKHIR, yaitu ketika
//    `tanggalAkhirPeriode(periode) <= tanggalLaporan`. Pada 2026-09-02,
//    '2026-07' & '2026-08' sudah jatuh tempo, '2026-09' BELUM (jurnal
//    penuh September pada tanggal 2 September = future posting).
//
// Aturan 2 mengatur KAPAN proses otomatis berjalan, bukan berapa
// nilainya — nominal tetap dari `hitungPenyusutanBulanan()` dan jurnal
// tetap dari `prosesPenyusutanAset()`, tidak ada engine kedua.
// ============================================================

/**
 * Apakah periode 'YYYY-MM' sudah BERAKHIR pada `tanggalLaporan`
 * (kebijakan bulan penuh, aturan 2 di atas)?
 */
export function periodePenyusutanSudahJatuhTempo(periode: string, tanggalLaporan: string): boolean {
  return tanggalAkhirPeriode(periode) <= tanggalLaporan.slice(0, 10);
}

/**
 * Daftar periode ('YYYY-MM', kronologis) yang SEHARUSNYA sudah diakui
 * untuk satu aset per `tanggalLaporan` — dasar catch-up retroaktif.
 *
 * Contoh (kasus pengguna):
 *   getPeriodePenyusutanYangSeharusnyaDiproses('2026-07-01', '2026-09-02', 12)
 *   -> ['2026-07', '2026-08']          // '2026-09' BELUM jatuh tempo
 *
 * Fungsi ini MURNI (tidak menyentuh database) dan TIDAK peduli periode
 * mana yang sudah tercatat — penyaringan "sudah ada di aset_penyusutan"
 * dilakukan terpisah (lihat `getPeriodePenyusutanTertunggak`), supaya
 * "apa yang seharusnya" dan "apa yang sudah ada" bisa dibandingkan
 * untuk keperluan audit/rekonsiliasi.
 *
 * `masaManfaatBulan` membatasi jumlah periode (§18: perolehan
 * 2026-07-01 masa manfaat 12 -> maksimum '2026-07'..'2027-06', TIDAK
 * PERNAH '2027-07'). Sengaja opsional supaya bisa dipakai untuk
 * pertanyaan "periode apa saja yang sudah lewat" tanpa data aset.
 */
export function getPeriodePenyusutanYangSeharusnyaDiproses(
  tanggalPerolehan: string,
  tanggalLaporan: string,
  masaManfaatBulan?: number
): string[] {
  const periodeAwal = toPeriode(tanggalPerolehan);
  if (!isValidPeriode(periodeAwal)) return [];
  const batas = masaManfaatBulan === undefined ? Number.POSITIVE_INFINITY : masaManfaatBulan;
  if (!(batas > 0)) return [];

  const hasil: string[] = [];
  for (let idx = 0; idx < batas; idx++) {
    const periode = tambahBulan(periodeAwal, idx);
    // Periode disusun kronologis: begitu satu periode belum jatuh
    // tempo, seluruh periode sesudahnya pasti juga belum.
    if (!periodePenyusutanSudahJatuhTempo(periode, tanggalLaporan)) break;
    hasil.push(periode);
  }
  return hasil;
}

/**
 * Periode TERAKHIR yang sudah jatuh tempo pada `tanggalLaporan` —
 * yaitu bulan berjalan kalau `tanggalLaporan` tepat hari terakhir
 * bulan itu, selain itu bulan sebelumnya. Dipakai untuk pelaporan
 * ("catch-up sampai periode X"), bukan untuk menghitung nominal.
 */
export function getPeriodePenyusutanCutoff(tanggalLaporan: string): string {
  const periodeBerjalan = toPeriode(tanggalLaporan);
  return periodePenyusutanSudahJatuhTempo(periodeBerjalan, tanggalLaporan)
    ? periodeBerjalan
    : tambahBulan(periodeBerjalan, -1);
}

export type StatusPenyusutanAset =
  | 'BELUM_MULAI' // periode sebelum tanggal perolehan
  | 'SUDAH_DIPROSES' // periode ini sudah punya jurnal penyusutan
  | 'SIAP_DIPROSES' // dalam masa manfaat, periode ini belum diproses
  | 'SELESAI' // sudah melewati masa manfaat (habis disusutkan)
  | 'DIHENTIKAN'; // aset sudah dihapus/nonaktif — tidak disusutkan lagi

export interface StatusPenyusutanItem {
  asetId: string;
  namaAset: string;
  nomorAset: string;
  nilaiPerolehan: Rupiah;
  nilaiResidu: Rupiah;
  masaManfaatBulan: number;
  nilaiPenyusutanBulanan: Rupiah;
  status: StatusPenyusutanAset;
  /** Prioritas 8/J — 'TAK_BERWUJUD' dipakai layar untuk label "Amortisasi" bukan "Penyusutan". */
  jenisAset: 'TETAP' | 'TAK_BERWUJUD';
  /**
   * Apakah periode ini sudah BERAKHIR per `tanggalLaporan` (kebijakan
   * bulan penuh). `false` berarti periode belum jatuh tempo: trigger
   * OTOMATIS tidak akan menyentuhnya. Proses MANUAL untuk periode yang
   * dipilih user SENGAJA tidak diblokir oleh flag ini (semantik tombol
   * existing tidak diubah) — flag ini hanya membuat kebijakan cutoff
   * terlihat dari satu tempat yang sama dengan trigger otomatis.
   */
  sudahJatuhTempo: boolean;
}

/**
 * Status tiap aset untuk satu periode tertentu — dasar layar "Status
 * Periode" DAN penyaring batch `jalankanPenyusutanPeriode`.
 *
 * `tanggalLaporan` (opsional, default hari ini menurut kalender lokal)
 * HANYA mengisi flag `sudahJatuhTempo`; klasifikasi status lain tidak
 * bergantung padanya, jadi tampilan layar existing tidak berubah.
 */
export async function getStatusPenyusutanPeriode(
  periode: string,
  tanggalLaporan: string = getTanggalLokalHariIni()
): Promise<StatusPenyusutanItem[]> {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
  const db = await getDb();
  const asetRows = await db.getAllAsync<any>(`SELECT * FROM aset_tetap ORDER BY tanggal_perolehan ASC`);
  const sudahDiproses = await db.getAllAsync<{ aset_id: string }>(
    `SELECT aset_id FROM aset_penyusutan WHERE periode = ?`,
    periode
  );
  const sudahDiprosesSet = new Set(sudahDiproses.map((r) => r.aset_id));

  const hasil: StatusPenyusutanItem[] = [];
  for (const r of asetRows) {
    const idx = indeksBulanPenyusutan(r.tanggal_perolehan, periode);
    const dasar = await getDasarPenyusutanAsetPadaDb(db, r);
    let status: StatusPenyusutanAset;
    if (sudahDiprosesSet.has(r.id)) status = 'SUDAH_DIPROSES';
    // §27-O: aset yang sudah dihapus/nonaktif TIDAK BOLEH mendapat
    // penyusutan BARU (histori periode yang terlanjur diposting tetap
    // tampil apa adanya lewat cabang SUDAH_DIPROSES di atas — jurnal
    // lama tidak pernah disentuh).
    else if ((r.status ?? 'AKTIF') === 'DIHAPUS') status = 'DIHENTIKAN';
    else if (idx < 0) status = 'BELUM_MULAI';
    else if (idx < r.masa_manfaat_bulan) status = 'SIAP_DIPROSES';
    else status = 'SELESAI';

    hasil.push({
      asetId: r.id,
      namaAset: r.nama_aset,
      nomorAset: r.nomor_aset,
      nilaiPerolehan: r.nilai_perolehan,
      nilaiResidu: r.nilai_residu ?? 0,
      masaManfaatBulan: r.masa_manfaat_bulan,
      // RC-S88: dasar efektif — setelah revaluasi, dari nilai revaluasi & sisa masa manfaat.
      nilaiPenyusutanBulanan: dasar.nilaiBulanan,
      status,
      jenisAset: r.jenis_aset ?? 'TETAP',
      sudahJatuhTempo: periodePenyusutanSudahJatuhTempo(periode, tanggalLaporan),
    });
  }
  return hasil;
}

/**
 * Proses penyusutan SATU aset untuk SATU periode. Idempoten: kalau
 * periode ini sudah diproses untuk aset ini, return info baris yang
 * sudah ada (bukan bikin baru, bukan error) — supaya batch runner di
 * bawah bisa dipanggil berkali-kali dengan aman.
 */
export async function prosesPenyusutanAset(params: {
  asetId: string;
  periode: string;
  createdBy: string;
  /**
   * PHASE 5 FINAL FIX (permintaan pengguna) — HANYA boleh `true` dari
   * trusted internal lifecycle trigger (lihat
   * `jalankanPenyusutanOtomatisJikaPerlu`). Default `false`/tidak
   * diisi = PERSIS perilaku sebelumnya (requirePermission RBAC penuh)
   * — SETIAP pemanggil UI manual (layar Status Periode Penyusutan,
   * dst.) TIDAK mengisi field ini, jadi TIDAK ADA perubahan perilaku
   * untuk aksi manual apa pun.
   */
  systemTrigger?: boolean;
  /**
   * BUG-05 — tanggal acuan "hari ini" untuk menentukan apakah sebuah
   * periode masih di masa depan. Default = tanggal LOKAL hari ini
   * (bukan UTC — lihat `getTanggalLokalHariIni`). Parameter ini ada
   * supaya perilaku batas periode dapat diuji secara deterministik,
   * BUKAN supaya pemanggil bisa melewati guard: nilainya tetap
   * dibandingkan dengan aturan yang sama.
   */
  tanggalLaporan?: string;
}): Promise<{ dibuat: boolean; row: AsetPenyusutanRow }> {
  if (!isValidPeriode(params.periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');

  // ============================================================
  // BUG-05 — PENYUSUTAN TIDAK BOLEH DIPOSTING KE PERIODE MASA DEPAN
  // ============================================================
  // Fungsi ini sudah memvalidasi: format periode, aset ada, aset tidak
  // dihapus, periode >= tanggal perolehan, masih dalam masa manfaat,
  // dan akumulasi tidak melampaui dasar penyusutan. Satu hal yang
  // TIDAK pernah diperiksa: apakah periodenya sudah benar-benar
  // berjalan.
  //
  // Tanpa penjaga ini, memanggil dengan periode '2030-01' membuat
  // `tanggalAkhirPeriode()` menghasilkan 2030-01-31, lalu
  // `createJournal` -> `getOrCreatePeriodeUntukTanggal` MEMBUAT periode
  // akuntansi 2030 yang berstatus OPEN, dan jurnal penyusutan
  // benar-benar terposting ke masa depan. Beban periode mendatang
  // muncul di buku hari ini.
  //
  // Periode BERJALAN tetap diizinkan (tidak diubah): batasnya adalah
  // periode yang belum dimulai sama sekali. Penolakan periode TERTUTUP
  // tetap ditangani guard terpusat di `createJournal`.
  const periodeSaatIni = toPeriode(params.tanggalLaporan ?? getTanggalLokalHariIni());
  if (params.periode > periodeSaatIni) {
    throw new Error(
      `Periode ${params.periode} belum berjalan (periode saat ini ${periodeSaatIni}) — ` +
        `penyusutan tidak boleh diposting ke periode masa depan.`
    );
  }

  return withTransaction(async (db) => {
    await requirePermissionAtauSystemTrigger(db, params.createdBy, 'kas_bank', 'create', params.systemTrigger ?? false);

    // Lapis 1 anti-duplikasi: cek dulu sebelum kerja apa pun.
    const existing = await db.getFirstAsync<any>(
      `SELECT ap.*, j.nomor_jurnal, a.nama_aset, a.nomor_aset
       FROM aset_penyusutan ap
       JOIN journal j ON j.id = ap.journal_id
       JOIN aset_tetap a ON a.id = ap.aset_id
       WHERE ap.aset_id = ? AND ap.periode = ?`,
      params.asetId,
      params.periode
    );
    if (existing) {
      return {
        dibuat: false,
        row: {
          id: existing.id,
          asetId: existing.aset_id,
          namaAset: existing.nama_aset,
          nomorAset: existing.nomor_aset,
          periode: existing.periode,
          tanggal: existing.tanggal,
          nilaiPenyusutan: existing.nilai_penyusutan,
          journalId: existing.journal_id,
          nomorJurnal: existing.nomor_jurnal,
        },
      };
    }

    const aset = await db.getFirstAsync<any>(`SELECT * FROM aset_tetap WHERE id = ?`, params.asetId);
    if (!aset) throw new Error('Aset tidak ditemukan.');

    // §27-O/§33: gerbang backend, bukan sekadar penyaring di layar —
    // aset yang sudah dihapus/nonaktif tidak boleh mendapat penyusutan
    // baru lewat jalur mana pun (manual, otomatis, tutup periode).
    if ((aset.status ?? 'AKTIF') === 'DIHAPUS') {
      throw new Error(`Aset "${aset.nama_aset}" sudah dihapus/nonaktif — tidak ada lagi penyusutan baru untuk aset ini.`);
    }

    const idx = indeksBulanPenyusutan(aset.tanggal_perolehan, params.periode);
    if (idx < 0) {
      throw new Error(
        `Aset "${aset.nama_aset}" baru diperoleh pada ${aset.tanggal_perolehan} — periode ${params.periode} sebelum tanggal perolehan.`
      );
    }
    if (idx >= aset.masa_manfaat_bulan) {
      throw new Error(
        `Aset "${aset.nama_aset}" sudah melewati masa manfaat (${aset.masa_manfaat_bulan} bulan) — tidak ada lagi penyusutan untuk periode ${params.periode}.`
      );
    }

    // RC-S88: dasar efektif — biaya perolehan, atau nilai revaluasi
    // terakhir dibagi sisa masa manfaat (prospektif, SAK EP Bab 17).
    const dasar = await getDasarPenyusutanAsetPadaDb(db, aset);
    const nilaiResidu = dasar.nilaiResidu;
    const nilaiBulanan = dasar.nilaiBulanan;
    if (nilaiBulanan <= 0) {
      throw new Error(
        dasar.tanggalRevaluasi
          ? `Aset "${aset.nama_aset}" tidak memiliki nilai penyusutan (nilai revaluasi ${dasar.tanggalRevaluasi} sudah sama/lebih kecil dari nilai residu).`
          : `Aset "${aset.nama_aset}" tidak memiliki nilai penyusutan (nilai perolehan sudah sama/lebih kecil dari nilai residu).`
      );
    }

    // §17/§33: akumulasi TIDAK BOLEH melampaui dasar penyusutan
    // (perolehan - residu), sehingga nilai buku tidak pernah turun di
    // bawah nilai residu. Tanpa penjaga ini, pembulatan ke rupiah bisa
    // membuat total n bulan sedikit melebihi dasar (mis. dasar 200 /
    // 3 bulan -> 67 x 3 = 201). Yang dibatasi adalah JURNAL-nya, bukan
    // tampilan laporan — laporan tetap membaca GL apa adanya.
    // RC-S88: setelah revaluasi, yang dibatasi adalah akumulasi SEJAK
    // tanggal revaluasi terhadap (nilai revaluasi − residu).
    const akumulasiTercatat = dasar.tanggalRevaluasi
      ? ((
          await db.getFirstAsync<{ total: number }>(
            `SELECT COALESCE(SUM(nilai_penyusutan), 0) as total FROM aset_penyusutan WHERE aset_id = ? AND tanggal > ?`,
            params.asetId,
            dasar.tanggalRevaluasi
          )
        )?.total ?? 0)
      : await getTotalPenyusutan(db, params.asetId);
    const sisaDasar = dasar.nilaiDasar - nilaiResidu - akumulasiTercatat;
    if (sisaDasar <= 0) {
      throw new Error(
        `Aset "${aset.nama_aset}" sudah tersusut penuh (akumulasi sudah mencapai nilai perolehan dikurangi nilai residu) — tidak ada penyusutan untuk periode ${params.periode}.`
      );
    }
    const nilaiPenyusutan = Math.min(nilaiBulanan, sisaDasar);

    const isTakBerwujud = (aset.jenis_aset ?? 'TETAP') === 'TAK_BERWUJUD';
    const mappingType = isTakBerwujud ? 'AMORTISASI_ASET_TAK_BERWUJUD' : 'PENYUSUTAN_ASET';
    const bebanPenyusutanAccountId = await resolveAccountId(db, mappingType, 'DEBIT_BEBAN');
    const akumulasiAccountId = await resolveAccountId(db, mappingType, 'KREDIT_AKUMULASI');
    const tanggal = tanggalAkhirPeriode(params.periode);
    const kataKerja = isTakBerwujud ? 'Amortisasi' : 'Penyusutan';

    const year = new Date(tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, isTakBerwujud ? 'AMR' : 'PNY', year);

    const { journalId, nomorJurnal } = await createJournal(db, {
      tanggal,
      sumberTransaksi: mappingType,
      sumberId: aset.id,
      nomorReferensi: nomorTransaksi,
      deskripsi: `${kataKerja} aset ${aset.nama_aset} (${aset.nomor_aset}) periode ${params.periode} - ${nomorTransaksi}`,
      createdBy: params.createdBy,
      lines: [
        { accountId: bebanPenyusutanAccountId, debit: nilaiPenyusutan, kredit: 0 },
        { accountId: akumulasiAccountId, debit: 0, kredit: nilaiPenyusutan },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    // Lapis 2 anti-duplikasi: UNIQUE(aset_id, periode) di schema —
    // kalau ada race condition, INSERT ini gagal & seluruh transaksi
    // (termasuk jurnal di atas) rollback otomatis.
    await db.runAsync(
      `INSERT INTO aset_penyusutan (id, aset_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      params.asetId,
      params.periode,
      tanggal,
      nilaiPenyusutan,
      journalId,
      params.createdBy,
      now
    );

    return {
      dibuat: true,
      row: {
        id,
        asetId: params.asetId,
        namaAset: aset.nama_aset,
        nomorAset: aset.nomor_aset,
        periode: params.periode,
        tanggal,
        nilaiPenyusutan,
        journalId,
        nomorJurnal,
      },
    };
  });
}

export interface HasilBatchPenyusutan {
  periode: string;
  diproses: AsetPenyusutanRow[];
  dilewati: { asetId: string; namaAset: string; alasan: string }[];
}

/**
 * Jalankan penyusutan untuk SEMUA aset yang siap diproses pada satu
 * periode. Tiap aset diproses independen (try/catch per-aset) supaya
 * satu aset bermasalah tidak menggagalkan aset lain dalam batch yang
 * sama.
 *
 * `systemTrigger` (PHASE 5 FINAL FIX, permintaan pengguna) — diteruskan
 * apa adanya ke `prosesPenyusutanAset` per aset. Default `false`:
 * SELURUH pemanggil UI manual existing (tidak mengisi parameter ini)
 * TIDAK berubah perilakunya sama sekali.
 */
export async function jalankanPenyusutanPeriode(
  periode: string,
  createdBy: string,
  /**
   * BUG-05 — `tanggalLaporan` DITERUSKAN ke `prosesPenyusutanAset`.
   *
   * WHY: runner ini sudah tahu "per tanggal berapa" ia dijalankan
   * (catch-up historis, penutupan tahun buku, trigger otomatis).
   * Kalau guard periode masa depan memakai jam sistem sendiri
   * sementara runner memakai tanggal acuannya, ada DUA jam dalam satu
   * operasi — dan catch-up historis yang sah akan ditolak. Satu
   * operasi, satu acuan waktu.
   */
  opts: { systemTrigger?: boolean; tanggalLaporan?: string } = {}
): Promise<HasilBatchPenyusutan> {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
  const status = await getStatusPenyusutanPeriode(periode);
  const diproses: AsetPenyusutanRow[] = [];
  const dilewati: { asetId: string; namaAset: string; alasan: string }[] = [];

  for (const item of status) {
    if (item.status === 'SUDAH_DIPROSES') {
      dilewati.push({ asetId: item.asetId, namaAset: item.namaAset, alasan: 'Periode ini sudah diproses sebelumnya.' });
      continue;
    }
    if (item.status === 'BELUM_MULAI') {
      dilewati.push({ asetId: item.asetId, namaAset: item.namaAset, alasan: 'Belum memasuki tanggal perolehan.' });
      continue;
    }
    if (item.status === 'SELESAI') {
      dilewati.push({ asetId: item.asetId, namaAset: item.namaAset, alasan: 'Sudah melewati masa manfaat.' });
      continue;
    }
    if (item.status === 'DIHENTIKAN') {
      dilewati.push({ asetId: item.asetId, namaAset: item.namaAset, alasan: 'Aset sudah dihapus/nonaktif.' });
      continue;
    }
    try {
      const hasil = await prosesPenyusutanAset({
        asetId: item.asetId,
        periode,
        createdBy,
        systemTrigger: opts.systemTrigger,
        tanggalLaporan: opts.tanggalLaporan,
      });
      if (hasil.dibuat) diproses.push(hasil.row);
      else dilewati.push({ asetId: item.asetId, namaAset: item.namaAset, alasan: 'Periode ini sudah diproses sebelumnya.' });
    } catch (e) {
      dilewati.push({
        asetId: item.asetId,
        namaAset: item.namaAset,
        alasan: e instanceof Error ? e.message : 'Gagal memproses.',
      });
    }
  }

  return { periode, diproses, dilewati };
}

/** Daftar jurnal penyusutan yang sudah tercatat — untuk layar "Jurnal Penyusutan". */
export async function listJurnalPenyusutan(opts: { asetId?: string; periode?: string } = {}): Promise<AsetPenyusutanRow[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: string[] = [];
  if (opts.asetId) {
    filters.push('ap.aset_id = ?');
    params.push(opts.asetId);
  }
  if (opts.periode) {
    filters.push('ap.periode = ?');
    params.push(opts.periode);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = await db.getAllAsync<any>(
    `SELECT ap.*, j.nomor_jurnal, a.nama_aset, a.nomor_aset
     FROM aset_penyusutan ap
     JOIN journal j ON j.id = ap.journal_id
     JOIN aset_tetap a ON a.id = ap.aset_id
     ${where}
     ORDER BY ap.periode DESC, a.nama_aset ASC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    asetId: r.aset_id,
    namaAset: r.nama_aset,
    nomorAset: r.nomor_aset,
    periode: r.periode,
    tanggal: r.tanggal,
    nilaiPenyusutan: r.nilai_penyusutan,
    journalId: r.journal_id,
    nomorJurnal: r.nomor_jurnal,
  }));
}

/** Total akumulasi penyusutan yang sudah tercatat untuk satu aset (untuk hitung nilai buku). */
export async function getTotalPenyusutan(db: SQLite.SQLiteDatabase, asetId: string): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(nilai_penyusutan), 0) as total FROM aset_penyusutan WHERE aset_id = ?`,
    asetId
  );
  return row?.total ?? 0;
}

export interface RingkasanAsetPenyusutan {
  asetId: string;
  nomorAset: string;
  namaAset: string;
  nilaiPerolehan: Rupiah;
  nilaiResidu: Rupiah;
  masaManfaatBulan: number;
  tanggalPerolehan: string;
  nilaiPenyusutanBulanan: Rupiah;
  akumulasiPenyusutan: Rupiah;
  nilaiBuku: Rupiah;
  jumlahPeriodeDiproses: number;
  /** Permintaan pengguna §12 — dipakai layar untuk label "Amortisasi" vs "Penyusutan". */
  jenisAset: 'TETAP' | 'TAK_BERWUJUD';
}

/** Ringkasan tiap aset + akumulasi penyusutan/amortisasi & nilai buku saat ini — untuk layar "Daftar Penyusutan". */
export async function listRingkasanPenyusutanAset(): Promise<RingkasanAsetPenyusutan[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT a.*,
            COALESCE(SUM(ap.nilai_penyusutan), 0) as akumulasi,
            COUNT(ap.id) as jumlah_periode
     FROM aset_tetap a
     LEFT JOIN aset_penyusutan ap ON ap.aset_id = a.id
     GROUP BY a.id
     ORDER BY a.tanggal_perolehan DESC`
  );
  const hasil: RingkasanAsetPenyusutan[] = [];
  for (const r of rows) {
    const nilaiResidu = r.nilai_residu ?? 0;
    const dasar = await getDasarPenyusutanAsetPadaDb(db, r);
    const selisihRevaluasi = await getSelisihRevaluasiAsetPadaDb(db, r.id);
    hasil.push({
      asetId: r.id,
      nomorAset: r.nomor_aset,
      namaAset: r.nama_aset,
      nilaiPerolehan: r.nilai_perolehan,
      nilaiResidu,
      masaManfaatBulan: r.masa_manfaat_bulan,
      tanggalPerolehan: r.tanggal_perolehan,
      nilaiPenyusutanBulanan: dasar.nilaiBulanan,
      akumulasiPenyusutan: r.akumulasi,
      // RC-S88: nilai buku = perolehan + selisih revaluasi − akumulasi.
      nilaiBuku: r.nilai_perolehan + selisihRevaluasi - r.akumulasi,
      jumlahPeriodeDiproses: r.jumlah_periode,
      jenisAset: r.jenis_aset ?? 'TETAP',
    });
  }
  return hasil;
}

/**
 * RC-S88 — akumulasi selisih revaluasi yang DIPOSTING untuk satu aset
 * (jumlah seluruh `selisih` penilaian berstatus DIPOSTING, opsional s.d.
 * tanggal). Inilah saldo akun penyesuai 1-1520 milik aset tsb.
 */
export async function getSelisihRevaluasiAsetPadaDb(
  db: SQLite.SQLiteDatabase,
  asetId: string,
  sampaiTanggal?: string
): Promise<Rupiah> {
  try {
    const r = await db.getFirstAsync<{ t: number }>(
      `SELECT COALESCE(SUM(selisih), 0) AS t FROM penyesuaian_nilai_wajar
        WHERE objek = 'ASET_TETAP' AND aset_tetap_id = ? AND status = 'DIPOSTING'
          ${sampaiTanggal ? 'AND tanggal <= ?' : ''}`,
      ...(sampaiTanggal ? [asetId, sampaiTanggal] : [asetId])
    );
    return r?.t ?? 0;
  } catch (e) {
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return 0;
    throw e;
  }
}

// ============================================================
// MODE PENYUSUTAN — OTOMATIS / MANUAL (update pasca-Phase 18/19,
// permintaan pengguna §F)
// ============================================================

export type ModePenyusutan = 'OTOMATIS' | 'MANUAL';

const APP_CONFIG_KEY_MODE_PENYUSUTAN = 'setting.penyusutan_mode';

/**
 * §F: mode penyusutan — OTOMATIS (default) atau MANUAL. Disimpan di
 * `app_config`, tabel key-value generik yang SUDAH ADA sejak awal
 * (dipakai `AccountingPolicyService`) — audit dulu sebelum bikin tabel
 * baru menemukan ini adalah persis "struktur setting existing" yang
 * diminta instruksi, jadi TIDAK dibuat tabel `app_settings` terpisah.
 *
 * - OTOMATIS: `PeriodCloseService.tutupPeriode()` otomatis menjalankan
 *   `jalankanPenyusutanPeriode()` untuk seluruh bulan dalam tahun buku
 *   yang belum diproses, SEBELUM periode benar-benar ditutup — supaya
 *   penyusutan tahun berjalan sudah lengkap sebelum dikunci. TIDAK ADA
 *   cron/background job (app ini offline-first) — "otomatis" berarti
 *   terpicu bersamaan dengan aksi user (tutup periode), bukan berjalan
 *   sendiri tanpa aksi apa pun.
 * - MANUAL: proses penyusutan HARUS dijalankan sendiri oleh user lewat
 *   tombol di layar Status Periode Penyusutan (`jalankanPenyusutanPeriode`
 *   yang sudah ada, TIDAK diubah) — `tutupPeriode()` tidak memicu apa
 *   pun secara otomatis.
 *
 * Kedua mode memakai `jalankanPenyusutanPeriode()` yang SAMA — sudah
 * idempoten (anti-duplikasi 2 lapis) & tetap menghormati
 * UNIQUE(aset_id, periode), jadi tidak ada risiko jurnal penyusutan
 * ganda di mode manapun.
 */
export async function getModePenyusutan(): Promise<ModePenyusutan> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key = ?`, APP_CONFIG_KEY_MODE_PENYUSUTAN);
  return row?.value === 'MANUAL' ? 'MANUAL' : 'OTOMATIS';
}

export async function setModePenyusutan(mode: ModePenyusutan, actingUserId: string): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'pengaturan', 'edit');
    if (mode !== 'OTOMATIS' && mode !== 'MANUAL') {
      throw new Error('Mode penyusutan harus OTOMATIS atau MANUAL.');
    }
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      APP_CONFIG_KEY_MODE_PENYUSUTAN,
      mode,
      now
    );
  });
}

/**
 * Dipanggil `PeriodCloseService.tutupPeriode()` saat mode OTOMATIS —
 * menjalankan `jalankanPenyusutanPeriode()` (fungsi publik yang SAMA
 * dipakai tombol manual di Status Periode Penyusutan, TIDAK diubah)
 * untuk SETIAP bulan dalam rentang periode akuntansi (tahun buku) yang
 * belum diproses. SENGAJA dipanggil TANPA transaksi bersama (setiap
 * panggilan `jalankanPenyusutanPeriode` per bulan sudah membuka
 * transaksinya sendiri lewat `prosesPenyusutanAset`) — expo-sqlite
 * tidak mendukung transaksi bersarang, jadi fungsi ini harus dipanggil
 * SEBELUM `tutupPeriode()` membuka transaksinya sendiri, bukan di
 * dalamnya. Aman dipanggil berkali-kali (setiap panggilan bulanan
 * sudah idempoten sendiri).
 */
export async function jalankanPenyusutanOtomatisUntukTahunBuku(
  periodeMulai: string,
  periodeSelesai: string,
  createdBy: string
): Promise<HasilBatchPenyusutan[]> {
  const hasil: HasilBatchPenyusutan[] = [];
  let kursor = new Date(periodeMulai);
  const akhir = new Date(periodeSelesai);
  while (kursor <= akhir) {
    const periode = toPeriode(toTanggalLokal(kursor));
    // BUG-05: acuan waktu = AKHIR tahun buku yang sedang ditutup.
    // Menutup tahun buku adalah pernyataan bahwa tahun itu sudah
    // berakhir, jadi seluruh bulan di dalamnya bukan "masa depan" —
    // memakai jam sistem di sini akan menolak bulan-bulan yang sah
    // ketika penutupan dijalankan sebelum kalender melewatinya.
    hasil.push(await jalankanPenyusutanPeriode(periode, createdBy, { tanggalLaporan: periodeSelesai }));
    kursor = new Date(kursor.getFullYear(), kursor.getMonth() + 1, 1);
  }
  return hasil;
}

// ============================================================
// CATCH-UP RETROAKTIF (perbaikan bug penyusutan yang terlewat)
// ============================================================

export interface PeriodeTertunggakAset {
  asetId: string;
  nomorAset: string;
  namaAset: string;
  jenisAset: 'TETAP' | 'TAK_BERWUJUD';
  nilaiPerolehan: Rupiah;
  nilaiResidu: Rupiah;
  masaManfaatBulan: number;
  tanggalPerolehan: string;
  /** Nilai penyusutan/amortisasi bulanan (garis lurus) — dari `hitungPenyusutanBulanan()`, tidak dihitung ulang. */
  nilaiPenyusutanBulanan: Rupiah;
  /** Periode yang SEHARUSNYA sudah diakui per tanggal laporan (kronologis). */
  periodeSeharusnya: string[];
  /** Periode yang sudah tercatat di `aset_penyusutan`. */
  periodeSudahAda: string[];
  /** Selisihnya — periode yang masih perlu diproses (kronologis). */
  periodeTertunggak: string[];
}

/**
 * READ-ONLY: periode penyusutan/amortisasi yang seharusnya sudah
 * diakui per `tanggalLaporan` tetapi belum ada di `aset_penyusutan`.
 *
 * TIDAK membuat jurnal apa pun. Dipakai oleh catch-up di bawah (untuk
 * menentukan periode mana yang perlu disentuh) dan oleh
 * `auditRekonsiliasiPenyusutan` (untuk melaporkan selisih tanpa
 * mengubah data).
 *
 * Aset berstatus DIHAPUS sengaja TIDAK diikutkan (§27-O) — sejalan
 * dengan status 'DIHENTIKAN' di `getStatusPenyusutanPeriode` dan
 * gerbang di `prosesPenyusutanAset`, jadi ketiganya memakai kebijakan
 * yang sama persis.
 */
export async function getPeriodePenyusutanTertunggak(
  tanggalLaporan: string = getTanggalLokalHariIni()
): Promise<PeriodeTertunggakAset[]> {
  const db = await getDb();
  const asetRows = await db.getAllAsync<any>(
    `SELECT * FROM aset_tetap WHERE COALESCE(status, 'AKTIF') = 'AKTIF' ORDER BY tanggal_perolehan ASC`
  );
  const tercatat = await db.getAllAsync<{ aset_id: string; periode: string }>(
    `SELECT aset_id, periode FROM aset_penyusutan`
  );

  const periodePerAset = new Map<string, Set<string>>();
  for (const row of tercatat) {
    const set = periodePerAset.get(row.aset_id) ?? new Set<string>();
    set.add(row.periode);
    periodePerAset.set(row.aset_id, set);
  }

  return asetRows.map((r) => {
    const sudahAda = periodePerAset.get(r.id) ?? new Set<string>();
    const seharusnya = getPeriodePenyusutanYangSeharusnyaDiproses(
      r.tanggal_perolehan,
      tanggalLaporan,
      r.masa_manfaat_bulan
    );
    const nilaiResidu = r.nilai_residu ?? 0;
    return {
      asetId: r.id,
      nomorAset: r.nomor_aset,
      namaAset: r.nama_aset,
      jenisAset: (r.jenis_aset ?? 'TETAP') as 'TETAP' | 'TAK_BERWUJUD',
      nilaiPerolehan: r.nilai_perolehan,
      nilaiResidu,
      masaManfaatBulan: r.masa_manfaat_bulan,
      tanggalPerolehan: r.tanggal_perolehan,
      nilaiPenyusutanBulanan: hitungPenyusutanBulanan(r.nilai_perolehan, nilaiResidu, r.masa_manfaat_bulan),
      periodeSeharusnya: seharusnya,
      periodeSudahAda: [...sudahAda].sort(),
      periodeTertunggak: seharusnya.filter((p) => !sudahAda.has(p)),
    };
  });
}

export interface HasilCatchUpPenyusutan {
  /** Tanggal laporan/cutoff yang dipakai. */
  tanggalLaporan: string;
  /** Periode terakhir yang sudah jatuh tempo pada tanggal itu. */
  periodeCutoff: string;
  /** Periode yang benar-benar tertunggak & dikerjakan, kronologis. */
  periodeDiproses: string[];
  /** Hasil batch per periode (urut kronologis) — bentuk yang sama dengan proses manual. */
  hasilPerPeriode: HasilBatchPenyusutan[];
}

/**
 * Kejar SELURUH periode penyusutan/amortisasi yang sudah jatuh tempo
 * sampai `tanggalLaporan` tetapi belum tercatat.
 *
 * BUKAN engine baru: nominal tetap dari `hitungPenyusutanBulanan()`,
 * jurnal tetap dari `prosesPenyusutanAset()`, dan batch per periode
 * tetap lewat `jalankanPenyusutanPeriode()` — fungsi PUBLIK yang SAMA
 * dipakai tombol manual & tutup periode. Yang ditambahkan di sini
 * HANYA pemilihan periode.
 *
 * Sifat:
 *  - Kronologis (periode lama diproses lebih dulu) — penting supaya
 *    penjaga sisa dasar penyusutan di `prosesPenyusutanAset` menutup
 *    periode terakhir dengan benar.
 *  - Idempoten: hanya periode yang BELUM ada di `aset_penyusutan` yang
 *    disentuh, plus UNIQUE(aset_id, periode) + transaksi per periode
 *    sebagai lapis kedua. Dipanggil dua kali berturut-turut, panggilan
 *    kedua menghasilkan 0 jurnal baru.
 *  - Tidak pernah future: batas atas selalu periode yang bulannya
 *    sudah berakhir (lihat `periodePenyusutanSudahJatuhTempo`).
 *  - Satu aset gagal (mapping akun hilang, periode CLOSED, dst.) TIDAK
 *    menggagalkan aset lain — `jalankanPenyusutanPeriode` menangkap
 *    error per aset dan melaporkannya lewat `dilewati`.
 *
 * PERIODE CLOSED (§31): TIDAK ada mekanisme koreksi baru dibuat di
 * sini. Jurnal ke periode CLOSED sudah ditolak oleh
 * `AccountingEngine.createJournal` (ClosedPeriodError) — penolakan itu
 * muncul sebagai baris `dilewati` berisi alasan, jadi periode tertutup
 * tetap tidak berubah dan selisihnya terlihat lewat
 * `auditRekonsiliasiPenyusutan`, untuk ditangani dengan mekanisme
 * koreksi/pembukaan periode yang sudah ada.
 */
export async function jalankanPenyusutanCatchUp(
  createdBy: string,
  tanggalLaporan: string = getTanggalLokalHariIni(),
  opts: { systemTrigger?: boolean } = {}
): Promise<HasilCatchUpPenyusutan> {
  const cutoff = getPeriodePenyusutanCutoff(tanggalLaporan);
  const tertunggak = await getPeriodePenyusutanTertunggak(tanggalLaporan);

  // Kumpulkan periode unik yang benar-benar punya tunggakan, lalu urut
  // kronologis. Hanya periode ini yang disentuh — aset yang sudah
  // lengkap tidak menghasilkan kerja apa pun (dan tidak membanjiri
  // `dilewati` dengan baris "sudah diproses").
  const periodeSet = new Set<string>();
  for (const aset of tertunggak) {
    for (const periode of aset.periodeTertunggak) periodeSet.add(periode);
  }
  const periodeDiproses = [...periodeSet].sort();

  const hasilPerPeriode: HasilBatchPenyusutan[] = [];
  for (const periode of periodeDiproses) {
    // BUG-05: acuan waktu catch-up diteruskan supaya guard periode
    // masa depan memakai jam yang SAMA dengan penentuan cutoff di atas.
    hasilPerPeriode.push(await jalankanPenyusutanPeriode(periode, createdBy, { ...opts, tanggalLaporan }));
  }

  return {
    tanggalLaporan: tanggalLaporan.slice(0, 10),
    periodeCutoff: cutoff,
    periodeDiproses,
    hasilPerPeriode,
  };
}

export interface HasilPenyusutanOtomatis {
  dijalankan: boolean;
  /** Periode KALENDER saat trigger dipanggil — belum tentu diproses (lihat `periodeCutoff`). */
  periode: string;
  /** Periode terakhir yang sudah jatuh tempo (bulan penuh) pada tanggal trigger. */
  periodeCutoff?: string;
  /** Periode yang benar-benar tertunggak & dikerjakan, kronologis. */
  periodeDiproses?: string[];
  /** Hasil batch per periode. */
  hasilPerPeriode?: HasilBatchPenyusutan[];
  /** Ringkasan gabungan seluruh periode catch-up (bentuk lama, untuk pemanggil yang cuma butuh totalnya). */
  hasil?: HasilBatchPenyusutan;
  error?: string;
}

/**
 * Trigger "otomatis" saat aplikasi dibuka — dipanggil dari bootstrap
 * (`app/index.tsx`, saat phase berubah jadi READY: login/unlock/kembali
 * dari background/restore). BUKAN dari React render, BUKAN polling,
 * BUKAN cron (app ini offline-first; "otomatis" berarti "terpicu saat
 * aplikasi dipakai", bukan "berjalan sendiri walau app tertutup").
 *
 * PERBAIKAN BUG RETROAKTIF: sebelumnya fungsi ini hanya menjalankan
 * `toPeriode(tanggalSekarang)` — satu periode, yaitu BULAN BERJALAN.
 * Akibatnya dua kesalahan sekaligus:
 *  1. Bulan-bulan yang terlewat (aplikasi tidak dibuka, atau aset
 *     dicatat dengan tanggal perolehan mundur) TIDAK PERNAH dikejar,
 *     sehingga akumulasi penyusutan kurang dari yang seharusnya.
 *  2. Bulan berjalan diposting PENUH walau bulannya belum berakhir
 *     (jurnal satu bulan penuh dibuat pada tanggal 2) — future posting.
 *
 * Sekarang: cari SELURUH periode yang sudah jatuh tempo (bulannya
 * sudah berakhir) sejak tanggal perolehan masing-masing aset, proses
 * yang belum tercatat secara kronologis, dan JANGAN sentuh bulan
 * berjalan sampai bulan itu benar-benar berakhir.
 *
 * Contoh (kasus pengguna) — trigger pada 2026-09-02, aset diperoleh
 * 2026-07-01 masa manfaat 12 bulan:
 *   '2026-07' -> diproses (kalau belum ada)
 *   '2026-08' -> diproses (kalau belum ada)
 *   '2026-09' -> TIDAK diproses (September belum genap satu bulan)
 *
 * Mode MANUAL: fungsi ini TIDAK melakukan apa pun — user menjalankan
 * sendiri lewat layar Status Periode Penyusutan (tombol satu periode,
 * semantiknya TIDAK diubah).
 *
 * `tanggalSekarang` opsional (default `getWaktuSekarang()` — jam aplikasi, lihat RC-S94) — untuk injeksi
 * tanggal di test, pola yang sama dipakai `tanggalLaporan` di
 * AkrualJasaPinjamanService.
 *
 * TIDAK PERNAH melempar error ke pemanggil: kegagalan penyusutan
 * otomatis tidak boleh memblokir login/pemakaian aplikasi. Kegagalan
 * total dilaporkan lewat field `error`, kegagalan per aset lewat
 * `dilewati` pada hasil batch.
 */
export async function jalankanPenyusutanOtomatisJikaPerlu(
  createdBy: string,
  // RC-S94 — default = JAM APLIKASI (`getWaktuSekarang`), BUKAN `new Date()`.
  // Dengan `new Date()`, fungsi ini — yang dipanggil StartupTasks TANPA
  // argumen — mengabaikan Mode Pengujian Waktu: setelah developer
  // melompatkan "hari ini", periode yang sudah jatuh tempo menurut jam
  // simulasi tidak pernah diproses (mis. jasa diterima di muka tidak
  // pernah pindah ke Laporan Hasil Usaha). Saat mode pengujian MATI,
  // `getWaktuSekarang()` PERSIS `new Date()`, jadi perilaku produksi tidak
  // berubah. Tanggal eksplisit dari pemanggil (test) tetap dihormati.
  tanggalSekarang: Date = getWaktuSekarang()
): Promise<HasilPenyusutanOtomatis> {
  const tanggalLaporan = toTanggalLokal(tanggalSekarang);
  const periode = toPeriode(tanggalLaporan);
  try {
    const mode = await getModePenyusutan();
    if (mode !== 'OTOMATIS') {
      return { dijalankan: false, periode };
    }
    // PHASE 5 FINAL FIX (permintaan pengguna §1/§2): `systemTrigger:
    // true` HANYA di titik pemanggilan INI — satu-satunya trusted
    // lifecycle path (dipanggil dari app/index.tsx saat phase READY,
    // BUKAN dari aksi/tombol UI mana pun). User yang sedang login
    // tetap harus ada & aktif (audit trail `created_by` tetap valid),
    // TAPI automatic period maintenance ini TIDAK BOLEH gagal senyap
    // hanya karena role user yang kebetulan sedang login belum
    // diberi izin `kas_bank`/`create` — lihat komentar lengkap di
    // PermissionService.requirePermissionAtauSystemTrigger.
    const catchUp = await jalankanPenyusutanCatchUp(createdBy, tanggalLaporan, { systemTrigger: true });

    // Ringkasan gabungan: bentuk `HasilBatchPenyusutan` yang sama
    // dipakai proses manual, supaya pemanggil yang hanya butuh "berapa
    // yang diproses" tidak perlu tahu ada berapa periode.
    const hasil: HasilBatchPenyusutan = {
      periode: catchUp.periodeCutoff,
      diproses: catchUp.hasilPerPeriode.flatMap((h) => h.diproses),
      dilewati: catchUp.hasilPerPeriode.flatMap((h) => h.dilewati),
    };

    return {
      dijalankan: true,
      periode,
      periodeCutoff: catchUp.periodeCutoff,
      periodeDiproses: catchUp.periodeDiproses,
      hasilPerPeriode: catchUp.hasilPerPeriode,
      hasil,
    };
  } catch (e) {
    return { dijalankan: false, periode, error: e instanceof Error ? e.message : 'Gagal menjalankan penyusutan otomatis.' };
  }
}

// ============================================================
// AUDIT / REKONSILIASI (READ-ONLY, §30)
// ============================================================

export interface AuditPenyusutanAsetItem {
  asetId: string;
  nomorAset: string;
  namaAset: string;
  jenisAset: 'TETAP' | 'TAK_BERWUJUD';
  periodeSeharusnya: number;
  periodeTersedia: number;
  periodeHilang: string[];
  periodeDuplikat: string[];
  /** Periode yang tercatat padahal belum jatuh tempo / di luar masa manfaat. */
  periodeTidakSah: string[];
  totalSubledger: Rupiah;
  /** Selisih nilai akibat periode yang hilang (perkiraan pada tarif bulanan). */
  variance: Rupiah;
}

export interface AuditRekonsiliasiPenyusutan {
  asOfDate: string;
  periodeCutoff: string;
  jumlahAset: number;
  totalPeriodeSeharusnya: number;
  totalPeriodeTersedia: number;
  /** SUM(aset_penyusutan.nilai_penyusutan) untuk aset TETAP. */
  totalSubledgerPenyusutan: Rupiah;
  /** Saldo akun GL akumulasi penyusutan aset tetap. */
  totalGlPenyusutan: Rupiah;
  /** SUM(aset_penyusutan.nilai_penyusutan) untuk aset TAK_BERWUJUD. */
  totalSubledgerAmortisasi: Rupiah;
  /** Saldo akun GL akumulasi amortisasi aset tak berwujud. */
  totalGlAmortisasi: Rupiah;
  variancePenyusutan: Rupiah;
  varianceAmortisasi: Rupiah;
  seimbang: boolean;
  aset: AuditPenyusutanAsetItem[];
}

/**
 * §30 — audit rekonsiliasi penyusutan/amortisasi. MURNI READ-ONLY:
 * TIDAK membuat, mengubah, atau menghapus jurnal maupun baris
 * `aset_penyusutan` apa pun. Fungsi ini menjawab "apakah subledger dan
 * GL cocok, dan periode mana yang hilang" — bukan menambal laporan.
 *
 * Saldo GL dibaca dari `journal_entry` akun akumulasi (KREDIT - DEBIT),
 * yaitu sumber yang sama dengan laporan posisi keuangan — bukan dari
 * subledger — supaya selisih di antara keduanya benar-benar terlihat.
 */
export async function auditRekonsiliasiPenyusutan(
  asOfDate: string = getTanggalLokalHariIni()
): Promise<AuditRekonsiliasiPenyusutan> {
  const db = await getDb();
  const tanggal = asOfDate.slice(0, 10);
  const tertunggak = await getPeriodePenyusutanTertunggak(tanggal);

  const barisSubledger = await db.getAllAsync<{
    aset_id: string;
    periode: string;
    nilai_penyusutan: number;
    jenis_aset: string | null;
    tanggal_perolehan: string;
    masa_manfaat_bulan: number;
  }>(
    `SELECT ap.aset_id, ap.periode, ap.nilai_penyusutan, a.jenis_aset, a.tanggal_perolehan, a.masa_manfaat_bulan
     FROM aset_penyusutan ap
     JOIN aset_tetap a ON a.id = ap.aset_id
     WHERE ap.tanggal <= ?`,
    tanggal
  );

  let totalSubledgerPenyusutan = 0;
  let totalSubledgerAmortisasi = 0;
  const perAset = new Map<string, { total: number; periode: string[] }>();
  for (const row of barisSubledger) {
    if ((row.jenis_aset ?? 'TETAP') === 'TAK_BERWUJUD') totalSubledgerAmortisasi += row.nilai_penyusutan;
    else totalSubledgerPenyusutan += row.nilai_penyusutan;
    const entry = perAset.get(row.aset_id) ?? { total: 0, periode: [] };
    entry.total += row.nilai_penyusutan;
    entry.periode.push(row.periode);
    perAset.set(row.aset_id, entry);
  }

  /**
   * BUG-14 — REKONSILIASI TIDAK BOLEH SILENT ZERO.
   *
   * Sebelumnya fungsi ini membungkus `resolveAccountId` dengan
   * `catch { return 0; }`. Akibatnya, kalau mapping COA akumulasi
   * penyusutan HILANG, saldo GL dilaporkan 0 — dan bila subledger
   * kebetulan juga 0 (mis. koperasi baru, atau seluruh jurnal
   * penyusutan gagal terposting), audit ini menyimpulkan
   * `seimbang: true`. Rekonsiliasi yang seharusnya MENDETEKSI masalah
   * konfigurasi justru menyembunyikannya dan mengembalikan angka valid
   * palsu.
   *
   * Yang dibedakan di sini:
   *   - LEGITIMATE EMPTY: tidak ada satupun aset/subledger pada kategori
   *     tersebut (mis. koperasi tanpa aset tak berwujud). Mapping
   *     memang tidak relevan, saldo 0 adalah jawaban yang benar.
   *   - CONFIGURATION FAILURE: ada aktivitas pada kategori tersebut
   *     tetapi mappingnya tidak ada. Ini WAJIB gagal keras.
   */
  async function saldoAkumulasiGl(mappingType: string, adaAktivitas: boolean): Promise<Rupiah> {
    let accountId: string;
    try {
      accountId = await resolveAccountId(db, mappingType, 'KREDIT_AKUMULASI');
    } catch (err) {
      if (!adaAktivitas && err instanceof MissingAccountMappingError) {
        // Tidak ada apa pun untuk direkonsiliasi pada kategori ini.
        return 0;
      }
      throw new Error(
        `Rekonsiliasi penyusutan gagal: akun akumulasi penyusutan belum memiliki mapping COA ` +
          `"${mappingType}" (role: KREDIT_AKUMULASI). ` +
          `Buka Pengaturan > Chart of Accounts > Mapping Transaksi untuk mengaturnya, ` +
          `lalu jalankan rekonsiliasi ulang.`
      );
    }
    const row = await db.getFirstAsync<{ saldo: number }>(
      `SELECT COALESCE(SUM(jl.kredit - jl.debit), 0) as saldo
       FROM journal_entry jl
       JOIN journal j ON j.id = jl.journal_id
       WHERE jl.account_id = ? AND j.status = 'POSTED' AND j.tanggal <= ?`,
      accountId,
      tanggal
    );
    return row?.saldo ?? 0;
  }

  // "Ada aktivitas" ditentukan dari subledger MAUPUN daftar aset yang
  // seharusnya disusutkan — supaya kasus "jurnal tidak pernah terposting
  // karena mappingnya hilang" (subledger 0, tapi asetnya ada) tetap
  // terdeteksi sebagai kegagalan konfigurasi, bukan dilaporkan seimbang.
  const adaAktivitasPenyusutan =
    totalSubledgerPenyusutan > 0 || tertunggak.some((t) => (t.jenisAset ?? 'TETAP') !== 'TAK_BERWUJUD');
  const adaAktivitasAmortisasi =
    totalSubledgerAmortisasi > 0 || tertunggak.some((t) => (t.jenisAset ?? 'TETAP') === 'TAK_BERWUJUD');

  const totalGlPenyusutan = await saldoAkumulasiGl('PENYUSUTAN_ASET', adaAktivitasPenyusutan);
  const totalGlAmortisasi = await saldoAkumulasiGl('AMORTISASI_ASET_TAK_BERWUJUD', adaAktivitasAmortisasi);

  const aset: AuditPenyusutanAsetItem[] = tertunggak.map((t) => {
    const entry = perAset.get(t.asetId) ?? { total: 0, periode: [] };
    const hitungan = new Map<string, number>();
    for (const p of entry.periode) hitungan.set(p, (hitungan.get(p) ?? 0) + 1);
    const periodeDuplikat = [...hitungan.entries()].filter(([, n]) => n > 1).map(([p]) => p);
    const sahSet = new Set(t.periodeSeharusnya);
    const periodeTidakSah = [...hitungan.keys()].filter((p) => !sahSet.has(p)).sort();
    return {
      asetId: t.asetId,
      nomorAset: t.nomorAset,
      namaAset: t.namaAset,
      jenisAset: t.jenisAset,
      periodeSeharusnya: t.periodeSeharusnya.length,
      periodeTersedia: t.periodeSudahAda.length,
      periodeHilang: t.periodeTertunggak,
      periodeDuplikat,
      periodeTidakSah,
      totalSubledger: entry.total,
      variance: t.periodeTertunggak.length * t.nilaiPenyusutanBulanan,
    };
  });

  const variancePenyusutan = totalSubledgerPenyusutan - totalGlPenyusutan;
  const varianceAmortisasi = totalSubledgerAmortisasi - totalGlAmortisasi;

  return {
    asOfDate: tanggal,
    periodeCutoff: getPeriodePenyusutanCutoff(tanggal),
    jumlahAset: tertunggak.length,
    totalPeriodeSeharusnya: tertunggak.reduce((n, t) => n + t.periodeSeharusnya.length, 0),
    totalPeriodeTersedia: tertunggak.reduce((n, t) => n + t.periodeSudahAda.length, 0),
    totalSubledgerPenyusutan,
    totalGlPenyusutan,
    totalSubledgerAmortisasi,
    totalGlAmortisasi,
    variancePenyusutan,
    varianceAmortisasi,
    seimbang: variancePenyusutan === 0 && varianceAmortisasi === 0,
    aset,
  };
}

