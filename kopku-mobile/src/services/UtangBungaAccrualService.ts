import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermissionAtauSystemTrigger } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah, roundToRupiah } from '@/utils/money';
import { tanggalAkhirPeriode, tambahBulan, isValidPeriode, toPeriode } from '@/accounting/PeriodeUtil';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getGapAkrualBungaUtangPadaDb, replayBungaUtang, JenisBunga, JenisPemberi } from '@/services/UtangService';

/**
 * ============================================================
 * RC-S55 — MESIN AKRUAL BUNGA UTANG OTOMATIS
 * ============================================================
 *
 * PERUBAHAN KONSEP. Sebelumnya bunga utang hanya bisa masuk buku kalau
 * pengurus membuka form dan MENGETIK nominalnya
 * (`UtangService.akruiBungaUtang`). Gap control RC-S53/S54 sudah benar
 * dan kuat, tetapi ia mengunci gap terhadap TARGET YANG DIINPUT MANUSIA —
 * tanpa input, tidak ada akrual sama sekali, dan beban bunga periode
 * berjalan diam-diam hilang.
 *
 * Modul ini menjadi sumber kebenaran TUNGGAL untuk proses otomatis:
 * ia menghitung target dari KONTRAK, bukan dari ketikan, lalu menyerahkan
 * pembukuannya ke `createJournal()` yang sama seperti jalur manual.
 * `akruiBungaUtang()` TIDAK dihapus dan TIDAK diubah perilakunya — ia
 * turun pangkat menjadi jalur PENYESUAIAN MANUAL/EXCEPTION (§16).
 *
 * KENAPA TIDAK ADA SUBSYSTEM JURNAL BARU. Seluruh jurnal di sini lewat
 * `createJournal()` dengan `sumberTransaksi: 'UTANG_BUNGA'` dan
 * `sumberId: utangId` — identitas yang SAMA yang sudah dibaca oleh
 * `getGapAkrualBungaUtangPadaDb`, `replayBungaUtang`,
 * `getKontrolGapUtangBunga`, dan diagnostik historis. Konsekuensinya:
 * jurnal otomatis dan jurnal manual saling terlihat, sehingga tidak ada
 * rupiah yang bisa diakui dua kali oleh dua jalur yang berbeda.
 *
 * ARUS KAS. `CashFlowClassification` sudah memetakan
 * `UTANG_BUNGA: 'NON_KAS'` sejak sebelum sesi ini — akrual tidak pernah
 * menyentuh kas/bank dan tidak muncul di laporan arus kas. Tidak ada
 * perubahan klasifikasi yang diperlukan, dan memang tidak ada yang dibuat.
 */

/** Basis kontraktual suku bunga. NULL di database = belum ditentukan. */
export type BasisBunga = 'TAHUNAN' | 'BULANAN';

export const TIPE_AKRUAL_BUNGA_UTANG = 'BUNGA_BULANAN' as const;

/**
 * ============================================================
 * RC-S56 §5 — KEBIJAKAN PERIODISASI, DIFORMALKAN
 * ============================================================
 *
 * Perilaku ini SUDAH berlaku sejak RC-S55 dan TIDAK diubah di sini. Yang
 * ditambahkan adalah statusnya: ia sekarang KEBIJAKAN AKUNTANSI yang
 * dinyatakan, bukan sifat kebetulan dari implementasi.
 *
 * WHOLE_MONTH berarti:
 *   - tidak ada prorata harian (tidak ada day-count convention);
 *   - sebuah bulan hanya diakru bila utang berlaku sejak tanggal 1;
 *   - pelunasan di tengah bulan TIDAK mengurangi akrual bulan berjalan.
 *
 * Kenapa diformalkan dan bukan dibuat konfigurasi: memilih prorata harian
 * adalah keputusan kebijakan koperasi yang memerlukan dasar tertulis, dan
 * repository ini belum memilikinya untuk utang. Menyediakan sakelarnya
 * sekarang justru mengundang perubahan basis akuntansi tanpa dasar. Narasinya
 * ikut terbit di CALK lewat `AccountingPolicyService.getKebijakanAkuntansiNarasi()`
 * (area `bunga_utang`), sehingga pembaca laporan tahu dasar angkanya.
 */
export const KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG = 'WHOLE_MONTH' as const;

/**
 * Kenapa `MANUAL_REVIEW_REQUIRED` TIDAK menjadi kolom di tabel `utang`
 * (jawaban atas §10).
 *
 * Ia sepenuhnya TURUNAN dari data kontraktual yang sudah ada:
 * `basis_bunga IS NULL`, `jenis_bunga = 'LAINNYA'`, persen <= 0, dsb.
 * Menyimpannya sebagai kolom berarti dua sumber kebenaran yang bisa
 * berbeda — mis. pengurus mengisi basis bunga tetapi kolom status lupa
 * di-update, lalu utang yang sudah sah TETAP tidak pernah diakru, dan
 * penyebabnya tidak terlihat di mana pun. Karena itu status dihitung
 * ulang setiap kali dari kontrak, dan satu-satunya yang dipersistensi
 * adalah FAKTA kontraktualnya (`basis_bunga`) beserta jejak siapa yang
 * mengisinya dan kapan.
 */
export type StatusEligibilitas =
  | 'ELIGIBLE'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'TIDAK_BERBUNGA'
  | 'LUNAS';

export type AlasanTidakEligible =
  | 'BASIS_BUNGA_BELUM_DITENTUKAN'
  | 'JENIS_BUNGA_LAINNYA'
  | 'PERSEN_BUNGA_NOL'
  | 'UTANG_USAHA_TANPA_BUNGA'
  | 'POKOK_TIDAK_DIKETAHUI'
  | 'TANGGAL_MULAI_TIDAK_VALID'
  | 'SUDAH_LUNAS';

/** Pesan yang ditampilkan ke pengurus — eksplisit, bukan error generik (§5/§18). */
export const PESAN_ALASAN: Record<AlasanTidakEligible, string> = {
  BASIS_BUNGA_BELUM_DITENTUKAN: 'Basis bunga belum ditentukan.',
  JENIS_BUNGA_LAINNYA:
    'Jenis bunga "Lainnya" tidak memiliki formula kontraktual yang pasti — akrual harus dihitung manual.',
  PERSEN_BUNGA_NOL: 'Utang ini tidak berbunga.',
  UTANG_USAHA_TANPA_BUNGA: 'Utang usaha (pembelian aset kredit) tidak memiliki komponen bunga.',
  POKOK_TIDAK_DIKETAHUI: 'Pokok pinjaman tidak diketahui atau tidak valid.',
  TANGGAL_MULAI_TIDAK_VALID: 'Tanggal mulai utang tidak valid.',
  SUDAH_LUNAS: 'Utang sudah lunas.',
};

export interface KontrakBungaUtang {
  readonly utangId: string;
  readonly nomorUtang: string;
  readonly namaPemberi: string;
  readonly jenisPemberi: JenisPemberi;
  readonly jenisBunga: JenisBunga;
  readonly persenBunga: number;
  readonly basisBunga: BasisBunga | null;
  readonly pokokPinjaman: Rupiah;
  readonly tanggalMulai: string;
  readonly status: 'AKTIF' | 'LUNAS';
  readonly eligibilitas: StatusEligibilitas;
  readonly alasan: AlasanTidakEligible | null;
  readonly pesanAlasan: string | null;
}

interface UtangRow {
  id: string;
  nomor_utang: string;
  nama_pemberi: string;
  jenis_pemberi: JenisPemberi;
  jenis_bunga: JenisBunga;
  persen_bunga: number;
  basis_bunga: string | null;
  pokok_pinjaman: number;
  tanggal: string;
  status: 'AKTIF' | 'LUNAS';
}

const SELECT_UTANG_KONTRAK = `
  SELECT id, nomor_utang, nama_pemberi, jenis_pemberi, jenis_bunga, persen_bunga,
         basis_bunga, pokok_pinjaman, tanggal, status
    FROM utang`;

/**
 * ACCEPTANCE RULE (§6) — satu-satunya tempat "boleh diakru otomatis atau
 * tidak" diputuskan. Dipakai bersama oleh layar monitoring dan oleh mesin
 * posting, supaya yang DITAMPILKAN dan yang DIJURNAL tidak pernah berbeda.
 *
 * Urutan pemeriksaan disengaja: kondisi yang paling MENJELASKAN
 * didahulukan, supaya utang usaha tidak dilaporkan sebagai "basis bunga
 * belum ditentukan" (benar secara teknis, menyesatkan secara makna).
 */
export function nilaiKontrakBunga(row: UtangRow): KontrakBungaUtang {
  const dasar = {
    utangId: row.id,
    nomorUtang: row.nomor_utang,
    namaPemberi: row.nama_pemberi,
    jenisPemberi: row.jenis_pemberi,
    jenisBunga: row.jenis_bunga,
    persenBunga: row.persen_bunga,
    basisBunga: (row.basis_bunga === 'TAHUNAN' || row.basis_bunga === 'BULANAN'
      ? row.basis_bunga
      : null) as BasisBunga | null,
    pokokPinjaman: row.pokok_pinjaman,
    tanggalMulai: row.tanggal,
    status: row.status,
  };

  const tolak = (
    eligibilitas: StatusEligibilitas,
    alasan: AlasanTidakEligible
  ): KontrakBungaUtang => ({ ...dasar, eligibilitas, alasan, pesanAlasan: PESAN_ALASAN[alasan] });

  if (row.jenis_pemberi === 'UTANG_USAHA') return tolak('TIDAK_BERBUNGA', 'UTANG_USAHA_TANPA_BUNGA');
  if (!Number.isFinite(row.persen_bunga) || row.persen_bunga <= 0) {
    return tolak('TIDAK_BERBUNGA', 'PERSEN_BUNGA_NOL');
  }
  // §8: LAINNYA tidak punya formula kontraktual yang dapat dibuktikan dari
  // data yang tersimpan. Mengarang rumus untuknya persis yang dilarang.
  if (row.jenis_bunga === 'LAINNYA') return tolak('MANUAL_REVIEW_REQUIRED', 'JENIS_BUNGA_LAINNYA');
  if (dasar.basisBunga === null) {
    return tolak('MANUAL_REVIEW_REQUIRED', 'BASIS_BUNGA_BELUM_DITENTUKAN');
  }
  if (!Number.isFinite(row.pokok_pinjaman) || row.pokok_pinjaman <= 0) {
    return tolak('MANUAL_REVIEW_REQUIRED', 'POKOK_TIDAK_DIKETAHUI');
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(row.tanggal ?? '')) {
    return tolak('MANUAL_REVIEW_REQUIRED', 'TANGGAL_MULAI_TIDAK_VALID');
  }

  /*
   * LUNAS diperiksa TERAKHIR, dan sengaja BUKAN sebagai penolakan kontrak.
   *
   * `utang.status` mencerminkan kondisi HARI INI. Kalau ia dipakai untuk
   * menolak lebih awal, utang yang baru dilunasi bulan ini akan membuat
   * SELURUH periode sebelumnya — ketika bunganya jelas masih berjalan —
   * tidak pernah bisa dikejar oleh catch-up. Beban bunga periode-periode
   * itu hilang permanen.
   *
   * Karena itu status ini hanya menjadi LABEL untuk layar monitoring;
   * keputusan per periode diserahkan ke `lunasSebelumPeriode()`, yang
   * membaca `utang_pembayaran` dan karena itu menjawab dengan benar
   * secara historis untuk setiap periode, bukan hanya untuk hari ini.
   */
  if (row.status === 'LUNAS') {
    return { ...dasar, eligibilitas: 'LUNAS', alasan: 'SUDAH_LUNAS', pesanAlasan: PESAN_ALASAN.SUDAH_LUNAS };
  }

  return { ...dasar, eligibilitas: 'ELIGIBLE', alasan: null, pesanAlasan: null };
}

/**
 * KONVERSI RATE KE BASIS BULANAN (§7).
 *
 * Akrual otomatis berperiode BULANAN, jadi rate kontraktual harus
 * dinyatakan per bulan:
 *   BULANAN -> dipakai apa adanya;
 *   TAHUNAN -> dibagi 12.
 *
 * TIDAK ADA day-count convention (Actual/365, 30/360, dsb.) yang
 * diperkenalkan di sini. Itu keputusan KEBIJAKAN, dan repository belum
 * memilikinya untuk utang — `ATURAN_BISNIS.md` mendokumentasikan basis
 * hari hanya untuk EIR pinjaman & simpanan berjangka. Memakai salah
 * satunya di sini berarti mengarang kebijakan koperasi.
 *
 * Konsekuensi yang DISENGAJA dan harus dipahami: bulan yang tidak utuh
 * TIDAK diprorata harian — ia tidak diakru sama sekali (lihat
 * `periodePertamaEligible`). Jadi mesin ini tidak pernah mengakui bunga
 * untuk waktu yang belum berjalan penuh, dan tidak pernah menebak berapa
 * bagian bulan yang menjadi hak pemberi pinjaman.
 */
export function rateBulanan(persenBunga: number, basis: BasisBunga): number {
  const rate = persenBunga / 100;
  return basis === 'BULANAN' ? rate : rate / 12;
}

/**
 * PERIODE AKRUAL PERTAMA YANG SAH.
 *
 * Aturannya deterministik dan tidak memerlukan day count: sebuah bulan
 * hanya diakru kalau utangnya SUDAH ADA sejak HARI PERTAMA bulan itu.
 *
 *   mulai 2026-01-01 -> periode pertama 2026-01 (bulan penuh)
 *   mulai 2026-01-15 -> periode pertama 2026-02 (Januari tidak utuh)
 *
 * Ini menjawab dua larangan sekaligus: tidak ada akrual sebelum kewajiban
 * kontraktual berjalan, dan tidak ada bulan parsial yang diakui sebagai
 * bulan penuh.
 */
export function periodePertamaEligible(tanggalMulai: string): string {
  const periodeMulai = toPeriode(tanggalMulai);
  const hari = tanggalMulai.slice(8, 10);
  return hari === '01' ? periodeMulai : tambahBulan(periodeMulai, 1);
}

/**
 * DASAR PERHITUNGAN per jenis bunga (§8).
 *
 *   FLAT    -> pokok KONTRAKTUAL (pokok_pinjaman). Itulah arti flat:
 *              bunga tidak mengecil mengikuti pelunasan pokok.
 *   EFEKTIF -> outstanding principal pada AWAL periode, yaitu pokok
 *              dikurangi seluruh angsuran pokok yang tanggalnya SEBELUM
 *              periode ini dimulai. Angsuran yang terjadi DI TENGAH
 *              periode tidak mengurangi dasar periode berjalan — itu
 *              akan menjadi prorata harian, yang justru tidak boleh
 *              diperkenalkan tanpa kebijakan.
 */
async function hitungDasarPerhitungan(
  db: SQLite.SQLiteDatabase,
  kontrak: KontrakBungaUtang,
  periode: string
): Promise<Rupiah> {
  if (kontrak.jenisBunga === 'FLAT') return kontrak.pokokPinjaman;

  const awalPeriode = `${periode}-01`;
  const terbayar = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(pokok), 0) AS total FROM utang_pembayaran
      WHERE utang_id = ? AND tanggal < ?`,
    kontrak.utangId,
    awalPeriode
  );
  return Math.max(0, kontrak.pokokPinjaman - (terbayar?.total ?? 0));
}

export function hitungNominalBunga(dasar: Rupiah, rateBulan: number): Rupiah {
  if (dasar <= 0 || rateBulan <= 0) return 0;
  return roundToRupiah(dasar * rateBulan);
}

// ============================================================================
// EKSEKUSI
// ============================================================================

export type HasilPeriode =
  | 'DIBUKUKAN'
  | 'SUDAH_DIPROSES'
  | 'TIDAK_ADA_GAP'
  | 'PERIODE_TERTUTUP'
  | 'NOMINAL_NOL'
  | 'LUNAS_SEBELUM_PERIODE'
  /** RC-S56: akrual periode ini pernah dibukukan lalu DIBALIK. Lihat StatusLifecyclePeriode. */
  | 'AKRUAL_DIREVERSAL';

/**
 * ============================================================
 * RC-S56 §1 — LIFECYCLE AKRUAL PER PERIODE
 * ============================================================
 *
 * MASALAH YANG DIPERBAIKI. RC-S55 memutuskan "periode ini sudah diproses"
 * hanya dari KEBERADAAN baris `utang_bunga_akrual`. Itu boolean yang terlalu
 * naif: ia tidak bisa membedakan akrual yang MASIH AKTIF dari akrual yang
 * sudah DIBALIK lewat `reverseJournal()`. Akibatnya setelah reversal, mesin
 * diam-diam menganggap periode itu beres, padahal di buku besar beban &
 * liabilitasnya sudah kembali nol — bunga periode itu hilang tanpa jejak
 * peringatan apa pun.
 *
 * SUMBER KEBENARAN SEKARANG ADALAH LEDGER, bukan keberadaan baris.
 * `getGapAkrualBungaUtangPadaDb()` sudah menghitung akrual BERSIH per periode
 * (kredit - debit, dengan jurnal pembalik diatribusikan ke periode jurnal
 * ASAL lewat `reversal_of_id` — RC-S54 Fix A). Baris subledger tetap SATU per
 * periode sebagai IDENTITAS periode (UNIQUE tidak disentuh, tidak ada baris
 * duplikat yang dibuat demi reversal); STATUSNYA yang diturunkan dari ledger.
 */
export type StatusLifecyclePeriode =
  /** Belum pernah diproses mesin. */
  | 'BELUM_DIPROSES'
  /** Pernah diproses & akrualnya masih aktif di buku besar. */
  | 'AKTIF'
  /** Pernah diproses tetapi tidak ada yang perlu dibukukan (gap sudah 0 saat itu). */
  | 'NIHIL'
  /** Pernah dibukukan lalu DIBALIK — akrual aktif kembali nol. */
  | 'DIREVERSAL';

export interface HasilAkrualPeriode {
  readonly utangId: string;
  readonly nomorUtang: string;
  readonly namaPemberi: string;
  readonly periode: string;
  readonly hasil: HasilPeriode;
  readonly target: Rupiah;
  readonly dibukukan: Rupiah;
  readonly journalId: string | null;
  readonly keterangan: string | null;
}

export interface ExceptionAkrual {
  readonly utangId: string;
  readonly nomorUtang: string;
  readonly namaPemberi: string;
  readonly periode: string | null;
  readonly kode: AlasanTidakEligible | 'PERIODE_TERTUTUP' | 'KEGAGALAN_TEKNIS' | 'AKRUAL_DIREVERSAL';
  readonly pesan: string;
}

export interface HasilProsesAkrualOtomatis {
  readonly dijalankan: boolean;
  readonly periodeDiproses: readonly HasilAkrualPeriode[];
  readonly exception: readonly ExceptionAkrual[];
  readonly totalDibukukan: Rupiah;
  readonly jumlahJurnalBaru: number;
}

/** Kunci idempotensi deterministik (§12). Identitas: utang + periode + tipe. */
export function idempotencyKeyAkrual(utangId: string, periode: string): string {
  return `UTANG_BUNGA:${utangId}:${periode}:${TIPE_AKRUAL_BUNGA_UTANG}`;
}

/**
 * Daftar periode yang HARUS dipertimbangkan untuk satu utang: dari periode
 * pertama yang sah sampai periode berjalan (inklusif). Masa depan tidak
 * pernah masuk daftar — bukan karena disaring belakangan, tetapi karena
 * batas atasnya memang periode berjalan.
 */
/**
 * ============================================================
 * RC-S58 — INTEGRITAS TEMPORAL: POSTING DI AKHIR PERIODE
 * ============================================================
 *
 * Periode PENUH terakhir yang tanggal akhirnya <= `tanggalSekarang`.
 *   2026-09-19 -> '2026-08'   (September belum selesai)
 *   2026-09-30 -> '2026-09'   (hari terakhir: September selesai hari ini)
 *   2026-10-01 -> '2026-09'
 *
 * Sampai RC-S57 mesin memproses sampai DAN TERMASUK bulan berjalan dengan
 * tanggal jurnal = akhir bulan, sehingga pada 19 Sep terbentuk jurnal
 * bertanggal 30 Sep — peristiwa akuntansi sebelum tanggal postingnya.
 * Itu tidak konsisten di dalam aplikasi sendiri: neraca saldo, LHU, posisi
 * keuangan, dan arus kas memfilter `tanggal <= asOf` (jurnal masa depan
 * tidak tampil), sedangkan `replayBungaUtang`, `getRekonsiliasiBungaUtang`,
 * dan `getKontrolGapUtangBunga` tidak memfilter tanggal (jurnal masa depan
 * ikut terhitung). Outstanding Utang Bunga "hari ini" jadi memuat bunga
 * yang belum diakui di buku besar hari ini.
 *
 * Keputusan RC-S58 (Opsi A): bulan berjalan TIDAK diposting; ia berstatus
 * menunggu akhir periode dan diposting oleh pemicu pertama pada/sesudah
 * tanggal akhirnya. Formula WHOLE_MONTH tidak berubah — yang berubah hanya
 * KAPAN sebuah bulan boleh dibukukan. Catch-up bulan lampau tetap berjalan.
 */
export function periodeTerakhirSelesai(tanggalSekarang: string): string {
  const periode = toPeriode(tanggalSekarang);
  return tanggalSekarang.slice(0, 10) >= tanggalAkhirPeriode(periode) ? periode : tambahBulan(periode, -1);
}

export function daftarPeriodeKandidat(tanggalMulai: string, periodeSekarang: string): string[] {
  const hasil: string[] = [];
  let p = periodePertamaEligible(tanggalMulai);
  // Batas keras: melindungi dari tanggal kontrak yang rusak (mis. tahun
  // 1900) yang kalau tidak dibatasi akan membuat loop ribuan iterasi
  // setiap kali aplikasi dibuka.
  let pengaman = 0;
  while (p <= periodeSekarang && pengaman < 600) {
    hasil.push(p);
    p = tambahBulan(p, 1);
    pengaman++;
  }
  return hasil;
}

/**
 * Apakah periode akuntansi yang memuat `tanggal` masih OPEN?
 *
 * Membaca `accounting_period` LANGSUNG (read-only) dan TIDAK memakai
 * `assertAccountingPeriodOpen`, karena fungsi itu MEMBUAT periode baru
 * kalau belum ada. Mesin otomatis yang berjalan tiap kali aplikasi dibuka
 * tidak boleh punya efek samping membuat baris periode hanya karena ia
 * bertanya. Pembuatan periode tetap terjadi secara sah di `createJournal()`
 * pada saat jurnal benar-benar ditulis.
 */
async function periodeAkuntansiTerbuka(
  db: SQLite.SQLiteDatabase,
  tanggal: string
): Promise<boolean> {
  const period = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM accounting_period
      WHERE ? BETWEEN periode_mulai AND periode_selesai
      ORDER BY periode_mulai DESC LIMIT 1`,
    tanggal
  );
  // Belum ada baris periode = belum pernah ditutup = boleh diproses.
  return period ? period.status !== 'CLOSED' : true;
}

/**
 * Sudah lunas SEBELUM periode ini dimulai? Kalau ya, tidak ada lagi
 * kewajiban bunga yang berjalan untuk periode itu.
 *
 * Dibaca dari `utang_pembayaran` (bukan kolom `utang.status`, yang hanya
 * mencerminkan kondisi HARI INI) supaya catch-up periode lama tetap
 * menghasilkan jawaban yang benar secara historis.
 */
async function lunasSebelumPeriode(
  db: SQLite.SQLiteDatabase,
  kontrak: KontrakBungaUtang,
  periode: string
): Promise<boolean> {
  const awalPeriode = `${periode}-01`;
  const terbayar = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(pokok), 0) AS total FROM utang_pembayaran
      WHERE utang_id = ? AND tanggal < ?`,
    kontrak.utangId,
    awalPeriode
  );
  return (terbayar?.total ?? 0) >= kontrak.pokokPinjaman;
}

export interface LifecyclePeriode {
  readonly status: StatusLifecyclePeriode;
  /** Akrual BERSIH periode ini di buku besar (kredit - debit, reversal ikut). */
  readonly akrualAktif: Rupiah;
  /** `nominal_target` yang tercatat di subledger saat diproses. 0 bila belum pernah. */
  readonly targetTercatat: Rupiah;
  /** `nominal_dibukukan` yang tercatat di subledger. */
  readonly dibukukanTercatat: Rupiah;
  /** Jurnal akrual asli (kalau ada). */
  readonly journalId: string | null;
}

/**
 * Status lifecycle satu (utang, periode) — diturunkan dari LEDGER, bukan dari
 * keberadaan baris subledger. Lihat catatan panjang di `StatusLifecyclePeriode`.
 *
 * Kenapa `akrualAktif` dibaca lewat `getGapAkrualBungaUtangPadaDb` dan bukan
 * query sendiri: fungsi itu SUDAH menangani atribusi jurnal pembalik ke periode
 * jurnal ASAL (`reversal_of_id`, RC-S54 Fix A). Reversal yang dilakukan di
 * bulan BERBEDA karena itu tetap mengurangi periode asalnya, bukan periode
 * dilakukannya reversal. Menyalin logikanya ke sini akan membuat dua sumber
 * kebenaran yang bisa berbeda diam-diam.
 */
export async function getStatusLifecyclePeriode(
  db: SQLite.SQLiteDatabase,
  utangId: string,
  periode: string
): Promise<LifecyclePeriode> {
  const baris = await db.getFirstAsync<{
    nominal_target: number;
    nominal_dibukukan: number;
    journal_id: string | null;
  }>(
    `SELECT nominal_target, nominal_dibukukan, journal_id FROM utang_bunga_akrual
      WHERE utang_id = ? AND periode = ? AND tipe_akrual = ?`,
    utangId,
    periode,
    TIPE_AKRUAL_BUNGA_UTANG
  );

  // target 0 hanya untuk membaca komponen; sisaGap tidak dipakai di sini.
  const gap = await getGapAkrualBungaUtangPadaDb(db, utangId, periode, 0);
  const akrualAktif = gap.akrualBersih;

  if (!baris) {
    return {
      status: 'BELUM_DIPROSES',
      akrualAktif,
      targetTercatat: 0,
      dibukukanTercatat: 0,
      journalId: null,
    };
  }

  const dasar = {
    akrualAktif,
    targetTercatat: baris.nominal_target,
    dibukukanTercatat: baris.nominal_dibukukan,
    journalId: baris.journal_id ?? null,
  };

  // Pernah diproses tetapi memang tidak ada yang dibukukan (gap sudah tertutup
  // oleh akrual manual sebelumnya) — bukan reversal, dan tidak perlu diulang.
  if (baris.nominal_dibukukan <= 0) return { status: 'NIHIL', ...dasar };

  // Pernah membukukan sesuatu, tetapi di buku besar akrual bersih periode ini
  // sudah habis -> jurnalnya dibalik.
  if (akrualAktif <= 0) return { status: 'DIREVERSAL', ...dasar };

  return { status: 'AKTIF', ...dasar };
}

/**
 * PROSES SATU (utang, periode) — atomik.
 *
 * URUTAN DI DALAM TRANSAKSI DISENGAJA:
 *   1. INSERT baris subledger lebih dulu. Kalau ada pemicu lain yang
 *      sudah memproses pasangan yang sama, UNIQUE constraint menolak di
 *      sini — SEBELUM satu baris jurnal pun ditulis. Inilah yang membuat
 *      dua trigger bersamaan menghasilkan tepat satu akrual, bukan boolean
 *      di React state.
 *   2. Baru hitung gap & tulis jurnal.
 *   3. UPDATE baris subledger dengan journal_id & nominal aktual.
 * Kalau langkah 2/3 gagal, seluruh transaksi rollback termasuk langkah 1 —
 * tidak ada metadata tanpa jurnal, dan tidak ada jurnal tanpa metadata.
 */
async function prosesSatuPeriode(
  db: SQLite.SQLiteDatabase,
  kontrak: KontrakBungaUtang,
  periode: string,
  createdBy: string
): Promise<HasilAkrualPeriode> {
  const identitas = {
    utangId: kontrak.utangId,
    nomorUtang: kontrak.nomorUtang,
    namaPemberi: kontrak.namaPemberi,
    periode,
  };

  const lifecycle = await getStatusLifecyclePeriode(db, kontrak.utangId, periode);

  if (lifecycle.status === 'AKTIF' || lifecycle.status === 'NIHIL') {
    return { ...identitas, hasil: 'SUDAH_DIPROSES', target: 0, dibukukan: 0, journalId: null, keterangan: null };
  }

  if (lifecycle.status === 'DIREVERSAL') {
    /*
     * KEBIJAKAN RC-S56: REVERSAL BERSIFAT FINAL BAGI MESIN OTOMATIS.
     *
     * Mesin TIDAK memposting ulang akrual yang sudah dibalik manusia. Dua
     * alasannya sama-sama menentukan:
     *
     *  1. Reversal adalah tindakan akuntansi yang DISENGAJA oleh pengurus,
     *     hampir selalu karena angka atau kontraknya memang dipersoalkan.
     *     Kalau mesin langsung memposting ulang angka yang sama, ia
     *     membatalkan koreksi itu — dan pada pembukaan aplikasi berikutnya
     *     membatalkannya lagi. Yang terbentuk adalah lingkaran
     *     reversal-repost yang tidak pernah selesai dan mengotori buku besar
     *     dengan pasangan jurnal tak berujung.
     *  2. Mesin tidak tahu MENGAPA dibalik. Kalau alasannya "kontraknya
     *     ternyata berbeda", angka pengganti yang benar hanya diketahui
     *     manusia.
     *
     * Jadi ia menjadi EXCEPTION YANG EKSPLISIT, bukan kesenyapan. Penggantian
     * dilakukan lewat jalur penyesuaian manual terkontrol
     * (`penyesuaianManualBungaUtang`), yang memang menghitung delta terhadap
     * posisi akuntansi AKTUAL — setelah reversal, akrual aktif = 0, sehingga
     * target manual dibukukan penuh dan hasil akhirnya tepat.
     */
    return {
      ...identitas,
      hasil: 'AKRUAL_DIREVERSAL',
      target: lifecycle.targetTercatat,
      dibukukan: 0,
      journalId: null,
      keterangan:
        `Akrual periode ${periode} pernah dibukukan (${lifecycle.dibukukanTercatat}) lalu dibalik. ` +
        `Mesin otomatis tidak memposting ulang; gunakan penyesuaian manual bila bunga periode ini masih terutang.`,
    };
  }

  if (await lunasSebelumPeriode(db, kontrak, periode)) {
    return {
      ...identitas,
      hasil: 'LUNAS_SEBELUM_PERIODE',
      target: 0,
      dibukukan: 0,
      journalId: null,
      keterangan: 'Pokok sudah lunas sebelum periode ini dimulai.',
    };
  }

  const tanggalJurnal = tanggalAkhirPeriode(periode);
  if (!(await periodeAkuntansiTerbuka(db, tanggalJurnal))) {
    return {
      ...identitas,
      hasil: 'PERIODE_TERTUTUP',
      target: 0,
      dibukukan: 0,
      journalId: null,
      keterangan: 'Periode akuntansi sudah ditutup — akrual tidak diposting otomatis.',
    };
  }

  const dasar = await hitungDasarPerhitungan(db, kontrak, periode);
  const target = hitungNominalBunga(dasar, rateBulanan(kontrak.persenBunga, kontrak.basisBunga!));
  if (target <= 0) {
    return { ...identitas, hasil: 'NOMINAL_NOL', target: 0, dibukukan: 0, journalId: null, keterangan: null };
  }

  const now = new Date().toISOString();
  const barisId = newId();
  // Langkah 1 — lihat catatan urutan di atas.
  await db.runAsync(
    `INSERT INTO utang_bunga_akrual
      (id, utang_id, periode, tipe_akrual, mode, basis_bunga, jenis_bunga, persen_bunga,
       dasar_perhitungan, nominal_target, nominal_dibukukan, tanggal_jurnal, journal_id,
       idempotency_key, keterangan, created_by, created_at)
     VALUES (?,?,?,?,'AUTO',?,?,?,?,?,0,?,NULL,?,NULL,?,?)`,
    barisId,
    kontrak.utangId,
    periode,
    TIPE_AKRUAL_BUNGA_UTANG,
    kontrak.basisBunga,
    kontrak.jenisBunga,
    kontrak.persenBunga,
    dasar,
    target,
    tanggalJurnal,
    idempotencyKeyAkrual(kontrak.utangId, periode),
    createdBy,
    now
  );

  /*
   * GAP CONTROL RC-S53/S54 DIPERTAHANKAN, BUKAN DIGANTI.
   *
   * Yang dibukukan adalah SELISIH antara target kontraktual dan yang
   * SUDAH diakui untuk periode ini — termasuk akrual manual yang dibuat
   * lewat `akruiBungaUtang()` DAN bunga yang terlanjur dibebankan saat
   * dibayar (`dibebankanSaatBayar`). Tanpa ini, koperasi yang sudah
   * memakai form manual bulan lalu akan mendapat beban ganda begitu
   * mesin otomatis menyala.
   */
  const gap = await getGapAkrualBungaUtangPadaDb(db, kontrak.utangId, periode, target);
  if (gap.sisaGap <= 0) {
    return {
      ...identitas,
      hasil: 'TIDAK_ADA_GAP',
      target,
      dibukukan: 0,
      journalId: null,
      keterangan: 'Bunga periode ini sudah diakui sebelumnya — tidak ada yang perlu dibukukan.',
    };
  }

  const bebanBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'DEBIT_BEBAN');
  const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');
  const nomorTransaksi = await nextSequence(db, 'AKB', Number(periode.slice(0, 4)));

  const { journalId } = await createJournal(db, {
    tanggal: tanggalJurnal,
    sumberTransaksi: 'UTANG_BUNGA',
    sumberId: kontrak.utangId,
    nomorReferensi: nomorTransaksi,
    deskripsi: `Akrual bunga utang ${kontrak.namaPemberi} periode ${periode} (otomatis) - ${nomorTransaksi}`,
    createdBy,
    lines: [
      { accountId: bebanBungaAccountId, debit: gap.sisaGap, kredit: 0 },
      { accountId: utangBungaAccountId, debit: 0, kredit: gap.sisaGap },
    ],
  });

  await db.runAsync(
    `UPDATE utang_bunga_akrual SET nominal_dibukukan = ?, journal_id = ? WHERE id = ?`,
    gap.sisaGap,
    journalId,
    barisId
  );

  return { ...identitas, hasil: 'DIBUKUKAN', target, dibukukan: gap.sisaGap, journalId, keterangan: null };
}

/**
 * MESIN UTAMA. Aman dipanggil berkali-kali: hasil database tetap sama.
 *
 * Setiap (utang, periode) diproses dalam transaksinya SENDIRI, bukan satu
 * transaksi raksasa. Alasannya: satu utang yang bermasalah tidak boleh
 * membatalkan akrual seluruh utang lain, dan transaksi pendek mengurangi
 * waktu kunci pada koneksi SQLite tunggal yang dipakai bersama layar lain.
 * Atomisitas yang dijanjikan adalah per-akrual (jurnal + metadata),
 * dan itulah unit yang memang harus all-or-nothing.
 */
export async function prosesAkrualBungaUtangOtomatis(params: {
  createdBy: string;
  tanggalSekarang?: string;
  utangId?: string;
  systemTrigger?: boolean;
}): Promise<HasilProsesAkrualOtomatis> {
  const db = await getDb();
  const tanggalSekarang = params.tanggalSekarang ?? getTanggalLokalHariIni();
  const periodeSelesai = periodeTerakhirSelesai(tanggalSekarang);

  const rows = await db.getAllAsync<UtangRow>(
    params.utangId
      ? `${SELECT_UTANG_KONTRAK} WHERE id = ?`
      : `${SELECT_UTANG_KONTRAK} WHERE jenis_pemberi <> 'UTANG_USAHA' AND persen_bunga > 0 ORDER BY tanggal ASC, id ASC`,
    ...(params.utangId ? [params.utangId] : [])
  );

  const periodeDiproses: HasilAkrualPeriode[] = [];
  const exception: ExceptionAkrual[] = [];
  let totalDibukukan = 0;
  let jumlahJurnalBaru = 0;

  for (const row of rows) {
    const kontrak = nilaiKontrakBunga(row);
    const identitas = {
      utangId: kontrak.utangId,
      nomorUtang: kontrak.nomorUtang,
      namaPemberi: kontrak.namaPemberi,
    };

    if (kontrak.eligibilitas === 'MANUAL_REVIEW_REQUIRED') {
      exception.push({
        ...identitas,
        periode: null,
        kode: kontrak.alasan!,
        pesan: kontrak.pesanAlasan!,
      });
      continue;
    }
    /*
     * 'LUNAS' ikut diproses: kontraknya sah, hanya sudah selesai. Periode
     * yang memang sudah lewat pelunasan disaring per periode di
     * `prosesSatuPeriode` (LUNAS_SEBELUM_PERIODE), bukan di sini.
     */
    if (kontrak.eligibilitas !== 'ELIGIBLE' && kontrak.eligibilitas !== 'LUNAS') continue;

    // RC-S58: hanya periode yang SUDAH selesai — bukan bulan berjalan.
    for (const periode of daftarPeriodeKandidat(kontrak.tanggalMulai, periodeSelesai)) {
      try {
        const hasil = await withTransaction(async (tx) => {
          await requirePermissionAtauSystemTrigger(
            tx,
            params.createdBy,
            'kas_bank',
            'create',
            params.systemTrigger ?? true
          );
          return prosesSatuPeriode(tx, kontrak, periode, params.createdBy);
        });
        if (hasil.hasil === 'DIBUKUKAN') {
          totalDibukukan += hasil.dibukukan;
          jumlahJurnalBaru += 1;
        }
        if (hasil.hasil === 'PERIODE_TERTUTUP') {
          exception.push({
            ...identitas,
            periode,
            kode: 'PERIODE_TERTUTUP',
            pesan:
              `Periode ${periode} sudah ditutup. Bunga periode ini belum diakru dan memerlukan ` +
              `penyesuaian periode tertutup lewat jurnal koreksi yang sah.`,
          });
        }
        if (hasil.hasil === 'AKRUAL_DIREVERSAL') {
          exception.push({
            ...identitas,
            periode,
            kode: 'AKRUAL_DIREVERSAL',
            pesan: hasil.keterangan ?? 'Akrual periode ini pernah dibalik.',
          });
        }
        if (hasil.hasil !== 'SUDAH_DIPROSES') periodeDiproses.push(hasil);
      } catch (e) {
        /*
         * Kegagalan di sini hampir selalu berarti pemicu LAIN memenangkan
         * balapan dan UNIQUE constraint menolak baris kedua — itu justru
         * bukti idempotensi bekerja, bukan kesalahan. Karena itu ia tidak
         * dilempar ke atas: mesin lanjut ke periode berikutnya, dan hasil
         * akhirnya tetap satu akrual.
         */
        const pesan = e instanceof Error ? e.message : String(e);
        const duplikat = /UNIQUE|constraint/i.test(pesan);
        if (!duplikat) {
          exception.push({ ...identitas, periode, kode: 'KEGAGALAN_TEKNIS', pesan });
        }
      }
    }
  }

  return { dijalankan: true, periodeDiproses, exception, totalDibukukan, jumlahJurnalBaru };
}

// ============================================================================
// GERBANG EKSEKUSI TUNGGAL (§13)
// ============================================================================

/**
 * Satu eksekusi yang sedang berjalan dipakai ULANG oleh pemanggil
 * berikutnya, bukan dijalankan paralel. Ini mencegah dua transaksi
 * tumpang-tindih pada koneksi SQLite tunggal — masalah yang persis sama
 * yang sudah didokumentasikan di `StartupTasks.ts`.
 *
 * Ini BUKAN pengganti idempotensi database, melainkan pelengkapnya: gerbang
 * ini hanya hidup di dalam satu proses, sedangkan UNIQUE constraint berlaku
 * selamanya dan untuk semua jalur.
 */
let eksekusiBerjalan: Promise<HasilProsesAkrualOtomatis> | null = null;

/**
 * RC-S71 — hasil eksekusi mesin TERAKHIR dalam proses aplikasi ini.
 * Dibaca layar Daftar Utang (status bunga per utang) tanpa memicu mesin.
 * Bukan sumber kebenaran akuntansi — jurnal & subledger tetap sumbernya.
 */
let hasilTerakhir: HasilProsesAkrualOtomatis | null = null;

export function getHasilAkrualBungaUtangTerakhir(): HasilProsesAkrualOtomatis | null {
  return hasilTerakhir;
}

/** Nilai `audit_log.entity` untuk exception teknis mesin akrual bunga utang. */
export const ENTITAS_AUDIT_EXCEPTION_AKRUAL = 'utang_bunga_akrual_exception' as const;

/**
 * RC-S71 §28 — kegagalan TEKNIS mesin tidak boleh hilang di console saja.
 * Dicatat ke `audit_log` (action SYSTEM_EXCEPTION, user = pemicu). Hanya
 * kegagalan nyata (mesin gagal / KEGAGALAN_TEKNIS per periode) yang dicatat;
 * kondisi data (kontrak belum lengkap, periode tertutup, akrual dibalik)
 * adalah STATUS yang dihitung ulang setiap kali dan tidak ditulis berulang.
 * Best-effort: kegagalan menulis log tidak menghentikan startup.
 */
async function catatExceptionTeknis(
  createdBy: string,
  entityId: string | null,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const db = await getDb();
    const now = new Date();
    await db.runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sesudah, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(),
      createdBy || 'SYSTEM',
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      'SYSTEM_EXCEPTION',
      ENTITAS_AUDIT_EXCEPTION_AKRUAL,
      entityId,
      JSON.stringify({ trigger: 'SYSTEM', ...data }),
      now.toISOString()
    );
  } catch (e) {
    console.warn('[UtangBungaAccrual] gagal mencatat exception:', e);
  }
}

export async function jalankanAkrualBungaUtangJikaPerlu(
  createdBy: string,
  tanggalSekarang?: string
): Promise<HasilProsesAkrualOtomatis> {
  if (eksekusiBerjalan) return eksekusiBerjalan;

  const berjalan = prosesAkrualBungaUtangOtomatis({
    createdBy,
    tanggalSekarang,
    systemTrigger: true,
  })
    .catch(async (e): Promise<HasilProsesAkrualOtomatis> => {
      console.warn('[UtangBungaAccrual] gagal:', e);
      await catatExceptionTeknis(createdBy, null, {
        kode: 'MESIN_GAGAL',
        pesan: e instanceof Error ? e.message : String(e),
      });
      return {
        dijalankan: false,
        periodeDiproses: [],
        exception: [],
        totalDibukukan: 0,
        jumlahJurnalBaru: 0,
      };
    })
    .then(async (hasil) => {
      for (const ex of hasil.exception) {
        if (ex.kode === 'KEGAGALAN_TEKNIS') {
          await catatExceptionTeknis(createdBy, ex.utangId, { kode: ex.kode, periode: ex.periode, pesan: ex.pesan });
        }
      }
      hasilTerakhir = hasil;
      return hasil;
    })
    .finally(() => {
      if (eksekusiBerjalan === berjalan) eksekusiBerjalan = null;
    });

  eksekusiBerjalan = berjalan;
  return berjalan;
}

/** Hanya untuk test — mengosongkan gerbang antar-skenario. */
export function _resetGerbangAkrualUntukTest(): void {
  eksekusiBerjalan = null;
  hasilTerakhir = null;
}

// ============================================================================
// READ MODEL UNTUK LAYAR "AKRUAL & KONTROL BUNGA UTANG" (§17/§18)
// ============================================================================

export interface BarisMonitorAkrual {
  readonly utangId: string;
  readonly nomorUtang: string;
  readonly namaPemberi: string;
  readonly jenisBunga: JenisBunga;
  readonly persenBunga: number;
  readonly basisBunga: BasisBunga | null;
  readonly eligibilitas: StatusEligibilitas;
  readonly pesanAlasan: string | null;
  readonly periodeTerakhirDiproses: string | null;
  readonly totalTerakru: Rupiah;
  readonly outstandingBunga: Rupiah;
  readonly periodeBelumDiproses: readonly string[];
}

export interface RingkasanMonitorAkrual {
  readonly periodeBerjalan: string;
  readonly periodeTerakhirDiproses: string | null;
  readonly jumlahUtangBerbunga: number;
  readonly jumlahEligible: number;
  readonly jumlahPerluReview: number;
  readonly totalTerakru: Rupiah;
  readonly outstandingBunga: Rupiah;
  readonly baris: readonly BarisMonitorAkrual[];
}

/**
 * Read-only. Tidak menulis apa pun — layar memanggil
 * `jalankanAkrualBungaUtangJikaPerlu()` secara terpisah sebelum membaca ini,
 * supaya "menampilkan" dan "memproses" tidak pernah tercampur dalam satu
 * fungsi yang sulit diuji.
 */
export async function getMonitorAkrualBungaUtang(
  tanggalSekarang?: string
): Promise<RingkasanMonitorAkrual> {
  const db = await getDb();
  const tanggalAcuan = tanggalSekarang ?? getTanggalLokalHariIni();
  const periodeBerjalan = toPeriode(tanggalAcuan);
  // RC-S58: "belum diproses" hanya untuk periode yang SUDAH selesai; bulan
  // berjalan belum jatuh tempo pembukuan sehingga bukan tunggakan.
  const periodeSelesaiMonitor = periodeTerakhirSelesai(tanggalAcuan);

  const rows = await db.getAllAsync<UtangRow>(
    `${SELECT_UTANG_KONTRAK} WHERE jenis_pemberi <> 'UTANG_USAHA' ORDER BY tanggal ASC, id ASC`
  );

  /*
   * RC-S56 §16 — AGREGASI TERBATAS, BUKAN N+1.
   *
   * Sebelumnya layar monitor menjalankan TIGA query per utang (agregat
   * subledger, daftar periode, lalu replay). Untuk koperasi dengan banyak
   * utang itu tumbuh linear dan dijalankan setiap kali layar dibuka.
   *
   * Dua di antaranya sekarang menjadi SATU query agregat untuk SELURUH utang
   * sekaligus (`GROUP BY utang_id`) plus satu query daftar periode untuk semua
   * utang, keduanya dibaca dari peta di memori.
   *
   * `replayBungaUtang` per utang SENGAJA DIPERTAHANKAN: ia bukan agregasi SQL
   * melainkan pemutaran ulang kejadian berurutan dengan aturan
   * `bagiPembayaranBunga` — satu-satunya sumber kebenaran outstanding bunga.
   * Menuliskannya ulang sebagai SQL akan menciptakan sumber kebenaran kedua
   * yang bisa menyimpang diam-diam dari yang dipakai `bayarUtang()`. Biaya
   * benarnya lebih murah daripada risiko itu.
   */
  const agregatRows = await db.getAllAsync<{ utang_id: string; terakhir: string | null; total: number }>(
    `SELECT utang_id, MAX(periode) AS terakhir, COALESCE(SUM(nominal_dibukukan), 0) AS total
       FROM utang_bunga_akrual GROUP BY utang_id`
  );
  const agregatByUtang = new Map(agregatRows.map((r) => [r.utang_id, r]));

  const periodeRows = await db.getAllAsync<{ utang_id: string; periode: string }>(
    `SELECT utang_id, periode FROM utang_bunga_akrual`
  );
  const periodeByUtang = new Map<string, Set<string>>();
  for (const r of periodeRows) {
    if (!periodeByUtang.has(r.utang_id)) periodeByUtang.set(r.utang_id, new Set());
    periodeByUtang.get(r.utang_id)!.add(r.periode);
  }

  const baris: BarisMonitorAkrual[] = [];
  let totalTerakruGlobal = 0;
  let outstandingGlobal = 0;
  let jumlahEligible = 0;
  let jumlahPerluReview = 0;
  let periodeTerakhirGlobal: string | null = null;

  for (const row of rows) {
    const kontrak = nilaiKontrakBunga(row);
    if (kontrak.eligibilitas === 'ELIGIBLE') jumlahEligible++;
    if (kontrak.eligibilitas === 'MANUAL_REVIEW_REQUIRED') jumlahPerluReview++;

    const agregat = agregatByUtang.get(row.id) ?? null;
    const replay = await replayBungaUtang(db, row.id);

    const sudahSet = periodeByUtang.get(row.id) ?? new Set<string>();
    const belum =
      kontrak.eligibilitas === 'ELIGIBLE'
        ? daftarPeriodeKandidat(kontrak.tanggalMulai, periodeSelesaiMonitor).filter((p) => !sudahSet.has(p))
        : [];

    const outstanding = replay.outstanding > 0 ? replay.outstanding : 0;
    totalTerakruGlobal += replay.totalAkrual;
    outstandingGlobal += outstanding;
    if (agregat?.terakhir && (!periodeTerakhirGlobal || agregat.terakhir > periodeTerakhirGlobal)) {
      periodeTerakhirGlobal = agregat.terakhir;
    }

    baris.push({
      utangId: kontrak.utangId,
      nomorUtang: kontrak.nomorUtang,
      namaPemberi: kontrak.namaPemberi,
      jenisBunga: kontrak.jenisBunga,
      persenBunga: kontrak.persenBunga,
      basisBunga: kontrak.basisBunga,
      eligibilitas: kontrak.eligibilitas,
      pesanAlasan: kontrak.pesanAlasan,
      periodeTerakhirDiproses: agregat?.terakhir ?? null,
      totalTerakru: replay.totalAkrual,
      outstandingBunga: outstanding,
      periodeBelumDiproses: belum,
    });
  }

  return {
    periodeBerjalan,
    periodeTerakhirDiproses: periodeTerakhirGlobal,
    jumlahUtangBerbunga: rows.filter((r) => r.persen_bunga > 0).length,
    jumlahEligible,
    jumlahPerluReview,
    totalTerakru: totalTerakruGlobal,
    outstandingBunga: outstandingGlobal,
    baris,
  };
}

export interface JejakAkrualBungaUtang {
  readonly periode: string;
  readonly mode: 'AUTO' | 'MANUAL_ADJUSTMENT';
  readonly basisBunga: string;
  readonly jenisBunga: string;
  readonly persenBunga: number;
  readonly dasarPerhitungan: Rupiah;
  readonly nominalTarget: Rupiah;
  readonly nominalDibukukan: Rupiah;
  readonly tanggalJurnal: string;
  readonly journalId: string | null;
  readonly nomorJurnal: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  /** RC-S56 §13: status jurnal akrual ini di buku besar ('POSTED' | 'REVERSED'). */
  readonly statusJurnal: string | null;
  /** Jurnal pembalik, bila akrual ini pernah dibalik. Relasi lewat `reversed_by_id`. */
  readonly reversalJournalId: string | null;
  readonly reversalNomorJurnal: string | null;
  readonly reversalTanggal: string | null;
  /** Akrual BERSIH periode ini di buku besar setelah memperhitungkan reversal. */
  readonly akrualAktif: Rupiah;
  readonly statusLifecycle: StatusLifecyclePeriode;
}

/** Audit trail per utang (§17): siapa/apa yang memicu, kapan, untuk periode apa, jurnal mana. */
export async function getJejakAkrualBungaUtang(utangId: string): Promise<JejakAkrualBungaUtang[]> {
  const db = await getDb();
  /*
   * RC-S56 §13 — RANTAI AUDIT LENGKAP DALAM SATU QUERY.
   *
   * Relasi ke jurnal pembalik diambil lewat `j.reversed_by_id`, BUKAN dengan
   * mencocokkan tanggal atau nominal. Itu penting karena `reverseJournal()`
   * memberi jurnal pembalik tanggal HARI INI — reversal lintas bulan tidak
   * akan pernah cocok berdasarkan tanggal.
   */
  const rows = await db.getAllAsync<any>(
    `SELECT a.*, j.nomor_jurnal, j.status AS status_jurnal,
            rev.id AS rev_id, rev.nomor_jurnal AS rev_nomor, rev.tanggal AS rev_tanggal
       FROM utang_bunga_akrual a
       LEFT JOIN journal j ON j.id = a.journal_id
       LEFT JOIN journal rev ON rev.id = j.reversed_by_id
      WHERE a.utang_id = ? ORDER BY a.periode ASC`,
    utangId
  );
  const hasil: JejakAkrualBungaUtang[] = [];
  for (const r of rows) {
    const lifecycle = await getStatusLifecyclePeriode(db, utangId, r.periode);
    hasil.push({
      periode: r.periode,
      mode: r.mode,
      basisBunga: r.basis_bunga,
      jenisBunga: r.jenis_bunga,
      persenBunga: r.persen_bunga,
      dasarPerhitungan: r.dasar_perhitungan,
      nominalTarget: r.nominal_target,
      nominalDibukukan: r.nominal_dibukukan,
      tanggalJurnal: r.tanggal_jurnal,
      journalId: r.journal_id ?? null,
      nomorJurnal: r.nomor_jurnal ?? null,
      createdBy: r.created_by,
      createdAt: r.created_at,
      statusJurnal: r.status_jurnal ?? null,
      reversalJournalId: r.rev_id ?? null,
      reversalNomorJurnal: r.rev_nomor ?? null,
      reversalTanggal: r.rev_tanggal ?? null,
      akrualAktif: lifecycle.akrualAktif,
      statusLifecycle: lifecycle.status,
    });
  }
  return hasil;
}

/** Validasi periode dipakai layar sebelum meminta pemrosesan satu periode. */
export function assertPeriodeValid(periode: string): void {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
}


// ============================================================================
// RC-S71 — STATUS BUNGA PER UTANG (read model untuk Daftar Utang)
// ============================================================================
//
// Empat status sederhana untuk pengurus. Diturunkan dari read model monitor
// (subledger + replay) dan hasil eksekusi mesin terakhir — TIDAK menulis
// apa pun dan TIDAK memicu mesin. Istilah teknis (gap, subledger,
// idempotensi) tidak pernah ditampilkan.

export type StatusBungaUtang = 'TERKENDALI' | 'MENUNGGU_PERIODE' | 'KONTRAK_BELUM_LENGKAP' | 'PERLU_PERHATIAN';

export const LABEL_STATUS_BUNGA_UTANG: Record<StatusBungaUtang, string> = {
  // RC-S71.1 §26 — teks label diselaraskan dengan spesifikasi. Hanya teks;
  // penentuan status (`tentukanStatusBungaUtang`) tidak berubah.
  TERKENDALI: 'Terkendali',
  MENUNGGU_PERIODE: 'Menunggu Periode',
  KONTRAK_BELUM_LENGKAP: 'Kontrak Belum Lengkap',
  PERLU_PERHATIAN: 'Perlu Perhatian',
};

export interface StatusBungaUtangDetail {
  readonly utangId: string;
  readonly status: StatusBungaUtang;
  /** Tanggal jurnal akrual terakhir (akhir periode), null bila belum pernah. */
  readonly akrualTerakhirTanggal: string | null;
  readonly outstandingBunga: Rupiah;
  /** Kalimat untuk pengurus; null bila TERKENDALI. */
  readonly pesan: string | null;
  /** true bila kontrak dapat dilengkapi dengan memilih basis bunga. */
  readonly bisaLengkapiBasis: boolean;
}

/** Murni — dipakai layar & test. */
export function tentukanStatusBungaUtang(
  baris: BarisMonitorAkrual,
  exceptionTerakhir: readonly ExceptionAkrual[] = []
): StatusBungaUtangDetail {
  const umum = {
    utangId: baris.utangId,
    akrualTerakhirTanggal: baris.periodeTerakhirDiproses ? tanggalAkhirPeriode(baris.periodeTerakhirDiproses) : null,
    outstandingBunga: baris.outstandingBunga,
  };
  if (baris.eligibilitas === 'MANUAL_REVIEW_REQUIRED') {
    const bisaLengkapiBasis = baris.basisBunga === null && baris.jenisBunga !== 'LAINNYA';
    return {
      ...umum,
      status: 'KONTRAK_BELUM_LENGKAP',
      pesan: bisaLengkapiBasis
        ? 'Kontrak bunga belum lengkap. Lengkapi basis bunga untuk mengaktifkan perhitungan otomatis.'
        : `${baris.pesanAlasan ?? 'Data kontrak bunga belum lengkap.'} Akrual otomatis tidak dijalankan untuk utang ini.`,
      bisaLengkapiBasis,
    };
  }
  const ex = exceptionTerakhir.filter((e) => e.utangId === baris.utangId && e.periode !== null);
  if (baris.periodeBelumDiproses.length > 0 || ex.length > 0) {
    const bagian: string[] = [];
    if (baris.periodeBelumDiproses.length > 0) {
      bagian.push(`Bunga periode ${baris.periodeBelumDiproses.join(', ')} belum tercatat.`);
    }
    for (const e of ex) {
      if (e.kode === 'PERIODE_TERTUTUP') bagian.push(`Periode ${e.periode} sudah ditutup — perlu koreksi resmi.`);
      else if (e.kode === 'AKRUAL_DIREVERSAL') bagian.push(`Akrual periode ${e.periode} pernah dibatalkan.`);
      else bagian.push(`Pemrosesan periode ${e.periode} gagal dan akan dicoba lagi otomatis.`);
    }
    return { ...umum, status: 'PERLU_PERHATIAN', pesan: [...new Set(bagian)].join(' '), bisaLengkapiBasis: false };
  }
  if (baris.eligibilitas === 'ELIGIBLE' && baris.periodeTerakhirDiproses === null) {
    return {
      ...umum,
      status: 'MENUNGGU_PERIODE',
      pesan: 'Akrual pertama dibukukan otomatis setelah bulan pertama utang berakhir.',
      bisaLengkapiBasis: false,
    };
  }
  return { ...umum, status: 'TERKENDALI', pesan: null, bisaLengkapiBasis: false };
}

/**
 * Status seluruh utang berbunga (bukan UTANG_USAHA), dipetakan per utangId.
 * Read-only: memakai `getMonitorAkrualBungaUtang` + hasil mesin terakhir.
 */
export async function getStatusBungaSemuaUtang(tanggalSekarang?: string): Promise<Map<string, StatusBungaUtangDetail>> {
  const monitor = await getMonitorAkrualBungaUtang(tanggalSekarang);
  const exceptionTerakhir = hasilTerakhir?.exception ?? [];
  const peta = new Map<string, StatusBungaUtangDetail>();
  for (const b of monitor.baris) {
    if (b.persenBunga <= 0 || b.eligibilitas === 'TIDAK_BERBUNGA') continue;
    peta.set(b.utangId, tentukanStatusBungaUtang(b, exceptionTerakhir));
  }
  return peta;
}
