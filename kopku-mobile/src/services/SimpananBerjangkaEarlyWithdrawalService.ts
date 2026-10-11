import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { TenorSimpananBerjangka } from '@/accounting/SimpananBerjangkaTenor';
import {
  buatJadwalBungaSimpananBerjangka,
  periodeYangSudahEarned,
} from '@/accounting/SimpananBerjangkaBunga';
import {
  KebijakanEarlyWithdrawal,
  KebijakanEarlyWithdrawalDraft,
  KebijakanEarlyWithdrawalError,
  HasilEvaluasiKebijakan,
  evaluasiKebijakanEarlyWithdrawal,
  isKebijakanLengkap,
} from '@/accounting/EarlyWithdrawalPolicy';
import {
  HasilSettlementDini,
  calculateEarlyWithdrawalSettlement,
  breakdownSettlement,
} from '@/accounting/EarlyWithdrawalCalculation';
import {
  prosesAkrualBungaKontrakPadaDb,
  getTotalBungaDitransferPadaDb,
} from '@/services/SimpananBerjangkaLifecycleService';
import { StatusSimpananBerjangka } from '@/services/SimpananBerjangkaService';

/**
 * ============================================================
 * PENARIKAN DINI SIMPANAN BERJANGKA — SERVICE (S21)
 * ============================================================
 *
 * Modul ini TIDAK memutuskan apa pun tentang penalti, bunga hangus,
 * biaya admin, atau rate. Seluruh keputusan berasal dari
 * `EarlyWithdrawalPolicy.ts`; seluruh angka berasal dari
 * `calculateEarlyWithdrawalSettlement()`. Tugas modul ini murni:
 * memvalidasi keadaan kontrak, menyelesaikan akrual, menuliskan jurnal,
 * dan mencatat jejak audit — semuanya dalam SATU transaksi.
 *
 * JURNAL (setiap komponen dapat ditelusuri, §L):
 *
 *   Dr 2-1210 Simpanan Anggota (Berjangka)  pokok bruto
 *   Dr 2-1710 Utang Bunga Simpanan Berjangka bunga terakru (rate kontrak)
 *   Cr 5-1955 Beban Bunga Simpanan Berjangka bunga hangus & pengurangan rate
 *   Cr <akun penalti kebijakan>              penalti
 *   Cr <akun biaya admin kebijakan>          biaya administrasi
 *   Cr Kas / Bank                            total payout
 *
 * KENAPA SISI DEBIT SELALU POKOK PENUH + BUNGA TERAKRU PENUH:
 * dua akun itulah kewajiban koperasi yang tercatat di buku. Penalti dan
 * biaya admin BUKAN pengurang kewajiban — keduanya pendapatan yang
 * diselesaikan dengan cara memotong pembayaran (offset), bukan dengan
 * membuat kewajiban lenyap. Kalau pokok didebit sebesar "pokok setelah
 * potongan", saldo 2-1210 akan menyisakan phantom balance sebesar
 * penalti untuk kontrak yang sudah ditutup.
 *
 * KENAPA BUNGA HANGUS MEMBALIK BEBAN, BUKAN MENJADI PENDAPATAN:
 * bunga yang dibatalkan berarti bebannya tidak pernah benar-benar
 * terjadi. Mengkreditkannya ke akun pendapatan akan menggelembungkan
 * pendapatan usaha dengan angka yang tidak pernah diterima siapa pun
 * (§AE). Akun yang dibalik adalah akun yang SAMA dengan yang dipakai
 * jurnal akrualnya.
 */

export const TRANSAKSI_PENCAIRAN_DINI = 'SIMPANAN_BERJANGKA_PENCAIRAN_DINI';

export const PESAN_SUDAH_JATUH_TEMPO_PAKAI_NORMAL =
  'Kontrak sudah mencapai jatuh tempo — gunakan pencairan normal, bukan penarikan dini.';
export const PESAN_SUDAH_DICAIRKAN_DINI = 'Simpanan berjangka ini sudah dicairkan.';

// ============================================================
// KEBIJAKAN
// ============================================================

function mapKebijakan(r: any): KebijakanEarlyWithdrawalDraft {
  return {
    versi: r.versi,
    berlakuMulai: r.berlaku_mulai,
    diizinkan: !!r.diizinkan,
    jenisPenalti: r.jenis_penalti,
    nilaiPenalti: r.nilai_penalti ?? null,
    basisPenalti: r.basis_penalti ?? null,
    akunPenaltiId: r.akun_penalti_id ?? null,
    jenisForfeiture: r.jenis_forfeiture,
    nilaiForfeiture: r.nilai_forfeiture ?? null,
    jenisBiayaAdmin: r.jenis_biaya_admin,
    nilaiBiayaAdmin: r.nilai_biaya_admin ?? null,
    basisBiayaAdmin: r.basis_biaya_admin ?? null,
    akunBiayaAdminId: r.akun_biaya_admin_id ?? null,
    rateDini: r.rate_dini ?? null,
    jenisPenyesuaianRate: r.jenis_penyesuaian_rate,
    cakupanPenyesuaianRate: r.cakupan_penyesuaian_rate ?? null,
    perlakuanPokok: r.perlakuan_pokok,
    perlakuanBunga: r.perlakuan_bunga,
    dasarPenetapan: r.dasar_penetapan ?? null,
    ditetapkanOleh: r.ditetapkan_oleh ?? null,
  };
}

/**
 * Kebijakan yang BERLAKU sekarang, atau `null` bila belum ditetapkan.
 *
 * `null` adalah keadaan bawaan aplikasi dan BUKAN kesalahan: ia berarti
 * POLICY_REQUIRED, dan pemanggil wajib memperlakukannya sebagai
 * penolakan — bukan sebagai izin memakai nilai nol.
 */
export async function getKebijakanDiniAktifPadaDb(
  db: SQLite.SQLiteDatabase
): Promise<KebijakanEarlyWithdrawalDraft | null> {
  const row = await db.getFirstAsync<any>(
    `SELECT * FROM simpanan_berjangka_kebijakan_dini WHERE status = 'AKTIF'`
  );
  return row ? mapKebijakan(row) : null;
}

export async function getKebijakanDiniAktif(): Promise<KebijakanEarlyWithdrawalDraft | null> {
  const db = await getDb();
  return getKebijakanDiniAktifPadaDb(db);
}

/** Status kebijakan siap pakai untuk UI & guard service. */
export async function getStatusKebijakanDini(): Promise<HasilEvaluasiKebijakan> {
  return evaluasiKebijakanEarlyWithdrawal(await getKebijakanDiniAktif());
}

// ============================================================
// AKUN PENDAPATAN BAKU PENARIKAN DINI (TERKUNCI)
// ============================================================
// Keputusan pengguna: penalti penarikan dini SELALU dicatat ke 4-1150
// "Pendapatan Penalti Pelunasan" dan biaya administrasinya SELALU ke
// 4-1100 "Pendapatan Administrasi". Keduanya BUKAN pilihan pengurus
// lagi — layar menampilkannya read-only, dan service ini menegakkannya
// sendiri (bukan hanya layar), sehingga pemanggil mana pun tidak dapat
// menyimpan versi kebijakan dengan akun lain.
//
// Hanya berlaku untuk versi kebijakan yang DISIMPAN SETELAH ini. Versi
// lama tetap membawa akun yang ditetapkan saat itu (histori settlement
// menunjuk versi tersebut); versi baru otomatis memakai akun baku.
export const KODE_AKUN_PENALTI_DINI = '4-1150';
export const KODE_AKUN_BIAYA_ADMIN_DINI = '4-1100';

export interface AkunTetapKebijakanDini {
  id: string;
  kode: string;
  nama: string;
}

async function bacaAkunTetap(db: SQLite.SQLiteDatabase, kode: string): Promise<AkunTetapKebijakanDini | null> {
  const r = await db.getFirstAsync<{ id: string; kode: string; nama: string }>(
    `SELECT id, kode, nama FROM account WHERE kode = ? AND is_active = 1 LIMIT 1`,
    kode
  );
  return r ? { id: r.id, kode: r.kode, nama: r.nama } : null;
}

/** Akun penalti & biaya administrasi baku (null bila akunnya tidak ada/nonaktif di COA). */
export async function getAkunTetapKebijakanDiniPadaDb(
  db: SQLite.SQLiteDatabase
): Promise<{ penalti: AkunTetapKebijakanDini | null; biayaAdmin: AkunTetapKebijakanDini | null }> {
  const [penalti, biayaAdmin] = await Promise.all([
    bacaAkunTetap(db, KODE_AKUN_PENALTI_DINI),
    bacaAkunTetap(db, KODE_AKUN_BIAYA_ADMIN_DINI),
  ]);
  return { penalti, biayaAdmin };
}

export async function getAkunTetapKebijakanDini() {
  return getAkunTetapKebijakanDiniPadaDb(await getDb());
}

/** Apakah jenis penalti/biaya ini menghasilkan nominal yang harus dijurnal ke akun pendapatan? */
function butuhAkun(jenis: string | null): boolean {
  return jenis !== null && jenis !== 'TIDAK_ADA';
}

export interface SimpanKebijakanDiniInput extends KebijakanEarlyWithdrawalDraft {
  createdBy: string;
}

/**
 * Tetapkan kebijakan penarikan dini yang baru.
 *
 * Kebijakan lama TIDAK dihapus — statusnya menjadi NONAKTIF sehingga
 * settlement lama tetap bisa menjelaskan aturan yang dipakai saat itu
 * (`policy_versi` pada baris settlement menunjuk ke versinya).
 *
 * Kebijakan yang belum lengkap TETAP BOLEH disimpan — pengurus mungkin
 * mengisinya bertahap — tetapi statusnya dievaluasi apa adanya dan
 * pencairan tetap ditolak sampai lengkap. Yang tidak boleh adalah
 * aplikasi mengisi kekosongan itu sendiri.
 */
export async function simpanKebijakanDini(input: SimpanKebijakanDiniInput): Promise<{
  id: string;
  evaluasi: HasilEvaluasiKebijakan;
}> {
  if (!input.versi || !input.versi.trim()) {
    throw new Error('Versi kebijakan wajib diisi.');
  }
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'pengaturan', 'edit');
    const now = new Date().toISOString();

    // AKUN TERKUNCI — akun pendapatan penalti & biaya administrasi
    // ditentukan service, bukan diambil dari masukan. Bila penalti/biaya
    // tidak ada, akunnya dikosongkan (tidak ada yang perlu dijurnal).
    const akunTetap = await getAkunTetapKebijakanDiniPadaDb(db);
    const perluPenalti = input.diizinkan && butuhAkun(input.jenisPenalti);
    const perluBiaya = input.diizinkan && butuhAkun(input.jenisBiayaAdmin);
    if (perluPenalti && !akunTetap.penalti) {
      throw new Error(
        `Akun ${KODE_AKUN_PENALTI_DINI} Pendapatan Penalti Pelunasan tidak ditemukan atau nonaktif di Daftar Akun.`
      );
    }
    if (perluBiaya && !akunTetap.biayaAdmin) {
      throw new Error(
        `Akun ${KODE_AKUN_BIAYA_ADMIN_DINI} Pendapatan Administrasi tidak ditemukan atau nonaktif di Daftar Akun.`
      );
    }
    input = {
      ...input,
      akunPenaltiId: perluPenalti ? akunTetap.penalti!.id : null,
      akunBiayaAdminId: perluBiaya ? akunTetap.biayaAdmin!.id : null,
    };

    // ================================================================
    // URUTAN OPERASI — EVALUASI DULU, BARU PROMOSI (RC-S44c)
    // ================================================================
    //
    // Versi sebelumnya menonaktifkan kebijakan AKTIF sebagai LANGKAH
    // PERTAMA, sebelum kebijakan baru dievaluasi. Sejak RC-S44b
    // kebijakan boleh disimpan bertahap dan sah berstatus
    // POLICY_REQUIRED — jadi menyimpan draft yang belum lengkap ikut
    // MEMATIKAN kebijakan lama yang masih benar dan sedang dipakai.
    //
    // Akibatnya nyata: koperasi yang sudah punya kebijakan berlaku
    // kehilangan kemampuan mencairkan simpanan berjangka hanya karena
    // pengurus membuka form penetapan dan menyimpan setengah jalan.
    // Tidak ada pesan kesalahan — kebijakannya sekadar berhenti
    // berlaku.
    //
    // Sekarang urutannya dibalik: kebijakan baru MASUK SEBAGAI DRAFT,
    // dievaluasi, dan hanya bila hasilnya AKTIF barulah kebijakan lama
    // dinonaktifkan lalu yang baru dipromosikan — semuanya di dalam
    // transaksi yang sama, sehingga tidak pernah ada saat di mana
    // koperasi kehilangan kebijakan yang berlaku.
    //
    // DRAFT di sini murni status siklus hidup versi kebijakan. Ia BUKAN
    // aturan akuntansi dan tidak muncul di perhitungan mana pun.
    const evaluasi = evaluasiKebijakanEarlyWithdrawal(input);
    const bolehDipromosikan = evaluasi.status === 'AKTIF';

    const id = newId();
    await db.runAsync(
      `INSERT INTO simpanan_berjangka_kebijakan_dini
        (id, versi, berlaku_mulai, diizinkan,
         jenis_penalti, nilai_penalti, basis_penalti, akun_penalti_id,
         jenis_forfeiture, nilai_forfeiture,
         jenis_biaya_admin, nilai_biaya_admin, basis_biaya_admin, akun_biaya_admin_id,
         rate_dini, jenis_penyesuaian_rate, cakupan_penyesuaian_rate,
         perlakuan_pokok, perlakuan_bunga,
         dasar_penetapan, ditetapkan_oleh, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?)`,
      id,
      input.versi,
      input.berlakuMulai,
      input.diizinkan ? 1 : 0,
      input.jenisPenalti,
      input.nilaiPenalti,
      input.basisPenalti,
      input.akunPenaltiId,
      input.jenisForfeiture,
      input.nilaiForfeiture,
      input.jenisBiayaAdmin,
      input.nilaiBiayaAdmin,
      input.basisBiayaAdmin,
      input.akunBiayaAdminId,
      input.rateDini,
      input.jenisPenyesuaianRate,
      input.cakupanPenyesuaianRate,
      input.perlakuanPokok,
      input.perlakuanBunga,
      input.dasarPenetapan ?? null,
      input.ditetapkanOleh ?? null,
      input.createdBy,
      now,
      now
    );

    if (bolehDipromosikan) {
      // Nonaktifkan dulu, baru promosikan. Urutan ini WAJIB: indeks
      // unik parsial `idx_sb_kebijakan_dini_aktif` hanya mengizinkan
      // satu baris berstatus AKTIF, jadi mempromosikan lebih dulu akan
      // melanggar constraint dan membatalkan seluruh transaksi.
      await db.runAsync(
        `UPDATE simpanan_berjangka_kebijakan_dini
           SET status = 'NONAKTIF', updated_at = ?
         WHERE status = 'AKTIF'`,
        now
      );
      await db.runAsync(
        `UPDATE simpanan_berjangka_kebijakan_dini
           SET status = 'AKTIF', updated_at = ?
         WHERE id = ?`,
        now,
        id
      );
    }
    // Bila TIDAK dipromosikan, baris baru tetap tersimpan sebagai DRAFT
    // dan kebijakan lama tidak tersentuh sama sekali. Kebijakan lama
    // TIDAK PERNAH dihapus dalam kondisi apa pun — settlement historis
    // merujuk `policy_versi`-nya.

    return { id, evaluasi };
  });
}

// ============================================================
// KONTRAK & KELAYAKAN
// ============================================================

interface KontrakRow {
  id: string;
  anggota_id: string;
  nomor_transaksi: string;
  tanggal_mulai: string;
  tanggal_jatuh_tempo: string;
  nominal: number;
  tenor_bulan: number;
  suku_bunga: number;
  status: StatusSimpananBerjangka;
  bunga_terakru: number;
  bunga_dibayar: number;
  journal_id: string | null;
}

async function ambilKontrak(db: SQLite.SQLiteDatabase, id: string): Promise<KontrakRow> {
  const row = await db.getFirstAsync<KontrakRow>(
    `SELECT * FROM simpanan_berjangka WHERE id = ?`,
    id
  );
  if (!row) throw new Error('Kontrak simpanan berjangka tidak ditemukan.');
  return row;
}

/** Bunga yang SEHARUSNYA earned pada rate kontrak sampai tanggal tertentu. */
function bungaEarnedKontrak(k: KontrakRow, sampaiTanggal: string): Rupiah {
  if (k.suku_bunga <= 0) return 0;
  const jadwal = buatJadwalBungaSimpananBerjangka(
    k.nominal,
    k.suku_bunga,
    k.tenor_bulan as TenorSimpananBerjangka,
    k.tanggal_mulai
  );
  return periodeYangSudahEarned(jadwal, sampaiTanggal).reduce((a, p) => a + p.bunga, 0);
}

/**
 * Alasan kontrak TIDAK boleh ditarik dini pada tanggal tertentu, atau
 * `null` bila boleh. Dipakai UI (untuk menyembunyikan/menonaktifkan
 * tombol) DAN service (sebagai guard sesungguhnya) — satu aturan, dua
 * pemakai, mustahil berselisih.
 */
export async function alasanTidakBolehTarikDini(
  db: SQLite.SQLiteDatabase,
  k: KontrakRow,
  tanggal: string
): Promise<string | null> {
  if (k.status === 'DICAIRKAN') return PESAN_SUDAH_DICAIRKAN_DINI;
  if (k.status === 'DIBATALKAN') return 'Simpanan berjangka ini sudah dibatalkan.';
  if (k.status === 'JATUH_TEMPO') return PESAN_SUDAH_JATUH_TEMPO_PAKAI_NORMAL;
  if (k.status !== 'AKTIF') return 'Status kontrak tidak memungkinkan penarikan dini.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return 'Tanggal pencairan tidak valid.';
  if (tanggal < k.tanggal_mulai) return 'Tanggal pencairan tidak boleh mendahului tanggal penempatan.';
  // §W — penarikan dini TIDAK BOLEH mengalahkan jalur jatuh tempo
  // normal. Pada/ setelah tanggal jatuh tempo, jalur yang benar adalah
  // pencairan normal.
  if (tanggal >= k.tanggal_jatuh_tempo) return PESAN_SUDAH_JATUH_TEMPO_PAKAI_NORMAL;

  // Jurnal penempatan yang sudah dibalik berarti kontraknya tidak lagi
  // berdiri di atas dasar yang sah.
  if (k.journal_id) {
    const j = await db.getFirstAsync<{ status: string }>(
      `SELECT status FROM journal WHERE id = ?`,
      k.journal_id
    );
    if (j && j.status !== 'POSTED') {
      return 'Jurnal penempatan kontrak ini tidak berstatus POSTED (dibalik/void) — pencairan dini ditolak.';
    }
  }

  const sudah = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM simpanan_berjangka_pencairan_dini WHERE simpanan_berjangka_id = ?`,
    k.id
  );
  if (sudah) return PESAN_SUDAH_DICAIRKAN_DINI;

  return null;
}

// ============================================================
// PREVIEW (§AI)
// ============================================================

export interface PreviewPencairanDini {
  kontrakId: string;
  nomorTransaksi: string;
  anggotaId: string;
  tanggalMulai: string;
  tanggalJatuhTempo: string;
  tanggalPencairan: string;
  sudahJatuhTempo: boolean;
  statusKebijakan: HasilEvaluasiKebijakan;
  /** null bila belum bisa dihitung (kebijakan/kelayakan bermasalah). */
  settlement: HasilSettlementDini | null;
  breakdown: { label: string; nilai: number; tanda: '+' | '-' | '=' }[];
  /** null = boleh dicairkan dini. */
  alasanTidakBoleh: string | null;
  /** Bunga yang masih harus diakru sebelum pencairan dieksekusi. */
  bungaBelumDiakru: Rupiah;
}

/**
 * Hitung preview TANPA mengubah apa pun.
 *
 * Angka yang dipakai adalah bunga yang SEHARUSNYA earned pada tanggal
 * pencairan — bukan isi kolom `bunga_terakru` saat ini. Eksekusi
 * menyelesaikan akrual lebih dulu di dalam transaksinya, sehingga
 * keduanya bertemu di angka yang sama. Inilah yang membuat
 * preview === eksekusi secara struktural, bukan secara kebetulan.
 */
export async function previewPencairanDini(
  kontrakId: string,
  tanggalPencairan: string
): Promise<PreviewPencairanDini> {
  const db = await getDb();
  return previewPencairanDiniPadaDb(db, kontrakId, tanggalPencairan);
}

export async function previewPencairanDiniPadaDb(
  db: SQLite.SQLiteDatabase,
  kontrakId: string,
  tanggalPencairan: string
): Promise<PreviewPencairanDini> {
  const k = await ambilKontrak(db, kontrakId);
  const kebijakan = await getKebijakanDiniAktifPadaDb(db);
  const statusKebijakan = evaluasiKebijakanEarlyWithdrawal(kebijakan);
  const alasan = await alasanTidakBolehTarikDini(db, k, tanggalPencairan);

  const dasar: PreviewPencairanDini = {
    kontrakId: k.id,
    nomorTransaksi: k.nomor_transaksi,
    anggotaId: k.anggota_id,
    tanggalMulai: k.tanggal_mulai,
    tanggalJatuhTempo: k.tanggal_jatuh_tempo,
    tanggalPencairan,
    sudahJatuhTempo: tanggalPencairan >= k.tanggal_jatuh_tempo,
    statusKebijakan,
    settlement: null,
    breakdown: [],
    alasanTidakBoleh: alasan ?? (statusKebijakan.status !== 'AKTIF' ? statusKebijakan.pesan : null),
    bungaBelumDiakru: 0,
  };

  // `isKebijakanLengkap` menyempitkan Draft -> kebijakan lengkap. Tanpa
  // ini, kebijakan yang keputusannya masih null bisa lolos ke kalkulasi
  // dan diperlakukan seolah pengurus sudah memutuskan.
  if (dasar.alasanTidakBoleh || !isKebijakanLengkap(kebijakan)) return dasar;

  const earned = bungaEarnedKontrak(k, tanggalPencairan);
  // POLICY EW-BUNGA-01 — bunga yang sudah dipindahkan ke Simpanan
  // Sukarela dibaca dari JURNAL di database, bukan dari jadwal atau
  // status layar. Ia sudah menjadi hak anggota dan sudah keluar dari
  // 2-1710, jadi settlement penarikan dini hanya menyelesaikan sisanya.
  const bungaSudahDitransfer = await getTotalBungaDitransferPadaDb(db, k.id);
  const settlement = calculateEarlyWithdrawalSettlement({
    pokok: k.nominal,
    tanggalMulai: k.tanggal_mulai,
    tanggalJatuhTempo: k.tanggal_jatuh_tempo,
    tanggalPencairan,
    tenorBulan: k.tenor_bulan as TenorSimpananBerjangka,
    rateKontrak: k.suku_bunga,
    bungaAkrual: earned,
    bungaSudahDitransfer,
    kebijakan,
  });

  return {
    ...dasar,
    settlement,
    breakdown: breakdownSettlement(settlement),
    bungaBelumDiakru: earned - k.bunga_terakru,
  };
}

// ============================================================
// EKSEKUSI
// ============================================================

export interface CairkanDiniInput {
  kontrakId: string;
  /** Tanggal BISNIS pencairan — bukan tanggal input UI (§X). */
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  /** Alasan pencairan dini, disimpan untuk audit trail (§AJ). */
  alasan?: string;
  keterangan?: string;
  idempotencyKey?: string;
  createdBy: string;
}

export interface HasilCairkanDini {
  kontrakId: string;
  settlementId: string | null;
  journalId: string | null;
  duplikat: boolean;
  settlement: HasilSettlementDini | null;
}

export async function cairkanSimpananBerjangkaDini(
  input: CairkanDiniInput
): Promise<HasilCairkanDini> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'simpanan', 'create');

    // ---- IDEMPOTENSI (§AA) ----
    // Dicek di dalam transaksi dan diperkuat unique index parsial
    // `idx_sb_dini_idempotency`, sehingga dua submit bersamaan pun
    // tidak bisa lolos berdua.
    if (input.idempotencyKey) {
      const sudah = await db.getFirstAsync<{
        id: string;
        simpanan_berjangka_id: string;
        journal_id: string | null;
      }>(
        `SELECT id, simpanan_berjangka_id, journal_id
         FROM simpanan_berjangka_pencairan_dini WHERE idempotency_key = ?`,
        input.idempotencyKey
      );
      if (sudah) {
        return {
          kontrakId: sudah.simpanan_berjangka_id,
          settlementId: sudah.id,
          journalId: sudah.journal_id,
          duplikat: true,
          settlement: null,
        };
      }
    }

    const k = await ambilKontrak(db, input.kontrakId);

    // ---- VALIDASI KELAYAKAN (§K) ----
    const alasanTolak = await alasanTidakBolehTarikDini(db, k, input.tanggal);
    if (alasanTolak) throw new Error(alasanTolak);

    // ---- KEBIJAKAN WAJIB LENGKAP — TIDAK ADA FALLBACK (§K/§AL) ----
    const kebijakan = await getKebijakanDiniAktifPadaDb(db);
    const evaluasi = evaluasiKebijakanEarlyWithdrawal(kebijakan);
    if (evaluasi.status !== 'AKTIF' || !isKebijakanLengkap(kebijakan)) {
      throw new KebijakanEarlyWithdrawalError(evaluasi);
    }

    // ---- SELESAIKAN AKRUAL DI DALAM TRANSAKSI YANG SAMA ----
    // Sama seperti pencairan normal: bunga harus lengkap diakui sampai
    // tanggal pencairan sebelum diselesaikan, dan tidak boleh ada
    // jurnal akrual yang commit kalau pencairannya gagal.
    await prosesAkrualBungaKontrakPadaDb(db, k.id, input.tanggal, input.createdBy);
    const kSegar = await ambilKontrak(db, k.id);

    // ---- POLICY EW-BUNGA-01 — bunga yang sudah dipindahkan ke Sukarela ----
    // RC-S54 TAHAP 6 (bug dibuktikan E2E `EwBungaTransferDatabaseRcS54`):
    // Tahap 4 hanya meneruskan angka ini di PREVIEW. Eksekusi memanggil
    // kalkulator tanpa field ini (default 0), sehingga 2-1710 didebit
    // sebesar SELURUH earned walaupun sebagian sudah didebit oleh jurnal
    // transfer — saldo 2-1710 menjadi negatif sebesar total transfer,
    // kas dibayar ganda, dan preview != eksekusi. Dibaca dari jurnal di
    // dalam transaksi yang sama, dengan fungsi yang sama dengan preview.
    const bungaSudahDitransfer = await getTotalBungaDitransferPadaDb(db, kSegar.id);

    // ---- SATU-SATUNYA SUMBER ANGKA ----
    const settlement = calculateEarlyWithdrawalSettlement({
      pokok: kSegar.nominal,
      tanggalMulai: kSegar.tanggal_mulai,
      tanggalJatuhTempo: kSegar.tanggal_jatuh_tempo,
      tanggalPencairan: input.tanggal,
      tenorBulan: kSegar.tenor_bulan as TenorSimpananBerjangka,
      rateKontrak: kSegar.suku_bunga,
      bungaAkrual: kSegar.bunga_terakru,
      bungaSudahDitransfer,
      kebijakan,
    });

    // ---- JURNAL (§L) ----
    const kasBankAccountId = await resolveKasBankAccountId(
      db,
      input.sumberDana,
      input.bankAccountId
    );
    // Akun pokok & utang bunga memakai mapping pencairan yang SUDAH ADA
    // — penarikan dini menyelesaikan kewajiban yang sama, jadi tidak
    // ada mapping baru yang perlu dikonfigurasi ulang oleh koperasi.
    const pokokAccountId = await resolveAccountId(
      db,
      'SIMPANAN_BERJANGKA_PENCAIRAN',
      'DEBIT_POKOK'
    );

    const lines: { accountId: string; debit: number; kredit: number; keterangan?: string }[] = [
      {
        accountId: pokokAccountId,
        debit: settlement.pokokBruto,
        kredit: 0,
        keterangan: 'Pelunasan pokok simpanan berjangka (penarikan dini)',
      },
    ];

    if (settlement.bungaAkrualKontrak > 0) {
      const utangBungaAccountId = await resolveAccountId(
        db,
        'SIMPANAN_BERJANGKA_PENCAIRAN',
        'DEBIT_UTANG_BUNGA'
      );
      lines.push({
        accountId: utangBungaAccountId,
        debit: settlement.bungaAkrualKontrak,
        kredit: 0,
        keterangan: 'Penyelesaian utang bunga simpanan berjangka',
      });
    }

    // Bunga yang tidak pernah menjadi hak anggota: bunga hangus DAN
    // pengurangan akibat rate dini. Keduanya membalik BEBAN yang dulu
    // diakui, di akun yang sama dengan jurnal akrualnya. Netto, supaya
    // tidak ada dua baris berlawanan pada akun yang sama.
    const netPembalikanBeban = settlement.bungaHangus - settlement.penyesuaianRate;
    if (netPembalikanBeban !== 0) {
      const bebanAccountId = await resolveAccountId(
        db,
        'SIMPANAN_BERJANGKA_BUNGA_AKRUAL',
        'DEBIT_BEBAN'
      );
      lines.push({
        accountId: bebanAccountId,
        debit: netPembalikanBeban < 0 ? -netPembalikanBeban : 0,
        kredit: netPembalikanBeban > 0 ? netPembalikanBeban : 0,
        keterangan:
          netPembalikanBeban > 0
            ? 'Pembalikan beban bunga yang dibatalkan (bunga hangus / penyesuaian rate)'
            : 'Tambahan beban bunga akibat rate penarikan dini',
      });
    }

    if (settlement.penalti > 0) {
      lines.push({
        accountId: kebijakan.akunPenaltiId!,
        debit: 0,
        kredit: settlement.penalti,
        keterangan: `Penalti penarikan dini (kebijakan ${kebijakan.versi})`,
      });
    }

    if (settlement.biayaAdmin > 0) {
      lines.push({
        accountId: kebijakan.akunBiayaAdminId!,
        debit: 0,
        kredit: settlement.biayaAdmin,
        keterangan: `Biaya administrasi penarikan dini (kebijakan ${kebijakan.versi})`,
      });
    }

    if (settlement.totalPayout > 0) {
      lines.push({
        accountId: kasBankAccountId,
        debit: 0,
        kredit: settlement.totalPayout,
        keterangan: 'Pembayaran penarikan dini kepada anggota',
      });
    }

    const tahun = parseInt(input.tanggal.slice(0, 4), 10);
    const nomor = await nextSequence(db, 'SPB-DINI', tahun);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: TRANSAKSI_PENCAIRAN_DINI,
      nomorReferensi: nomor,
      sumberId: kSegar.id,
      deskripsi:
        `Pencairan dini simpanan berjangka ${kSegar.nomor_transaksi} - ${nomor} ` +
        `(kebijakan ${kebijakan.versi})`,
      createdBy: input.createdBy,
      lines,
    });

    // ---- SUBLEDGER (§M) ----
    // Kolom kontrak yang SUDAH ADA dipakai apa adanya; rincian
    // settlement disimpan di tabel eventnya sendiri supaya kontrak
    // tidak perlu tumbuh enam kolom baru.
    await db.runAsync(
      `UPDATE simpanan_berjangka
         SET status = 'DICAIRKAN', bunga_dibayar = ?, tanggal_pencairan = ?,
             journal_pencairan_id = ?, updated_at = ?
       WHERE id = ?`,
      settlement.bungaDibayar,
      input.tanggal,
      journalId,
      new Date().toISOString(),
      kSegar.id
    );

    const settlementId = newId();
    await db.runAsync(
      `INSERT INTO simpanan_berjangka_pencairan_dini
        (id, simpanan_berjangka_id, tanggal_pencairan, policy_versi,
         pokok_bruto, bunga_akrual_kontrak, penyesuaian_rate, bunga_bruto, bunga_hangus,
         penalti, biaya_admin, penyesuaian_pokok, penyesuaian_bunga,
         pokok_dibayar, bunga_dibayar, total_payout, rate_kontrak, rate_efektif,
         alasan, journal_id, idempotency_key, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      settlementId,
      kSegar.id,
      input.tanggal,
      settlement.policyVersi,
      settlement.pokokBruto,
      settlement.bungaAkrualKontrak,
      settlement.penyesuaianRate,
      settlement.bungaBruto,
      settlement.bungaHangus,
      settlement.penalti,
      settlement.biayaAdmin,
      settlement.penyesuaianPokok,
      settlement.penyesuaianBunga,
      settlement.pokokDibayar,
      settlement.bungaDibayar,
      settlement.totalPayout,
      settlement.rateKontrak,
      settlement.rateEfektif,
      input.alasan ?? null,
      journalId,
      input.idempotencyKey ?? null,
      input.createdBy,
      new Date().toISOString()
    );

    return {
      kontrakId: kSegar.id,
      settlementId,
      journalId,
      duplikat: false,
      settlement,
    };
  });
}

// ============================================================
// PEMBACAAN UNTUK RIWAYAT & LAPORAN (§AG/§AJ)
// ============================================================

export interface SettlementDiniRow {
  id: string;
  kontrakId: string;
  nomorTransaksi: string;
  anggotaId: string;
  tanggalPencairan: string;
  policyVersi: string;
  pokokBruto: Rupiah;
  bungaAkrualKontrak: Rupiah;
  penyesuaianRate: number;
  bungaBruto: Rupiah;
  bungaHangus: Rupiah;
  penalti: Rupiah;
  biayaAdmin: Rupiah;
  penyesuaianPokok: Rupiah;
  penyesuaianBunga: Rupiah;
  pokokDibayar: Rupiah;
  bungaDibayar: Rupiah;
  totalPayout: Rupiah;
  rateKontrak: number;
  rateEfektif: number;
  alasan: string | null;
  journalId: string | null;
  createdBy: string;
  createdAt: string;
}

function mapSettlement(r: any): SettlementDiniRow {
  return {
    id: r.id,
    kontrakId: r.simpanan_berjangka_id,
    nomorTransaksi: r.nomor_transaksi,
    anggotaId: r.anggota_id,
    tanggalPencairan: r.tanggal_pencairan,
    policyVersi: r.policy_versi,
    pokokBruto: r.pokok_bruto,
    bungaAkrualKontrak: r.bunga_akrual_kontrak,
    penyesuaianRate: r.penyesuaian_rate,
    bungaBruto: r.bunga_bruto,
    bungaHangus: r.bunga_hangus,
    penalti: r.penalti,
    biayaAdmin: r.biaya_admin,
    penyesuaianPokok: r.penyesuaian_pokok,
    penyesuaianBunga: r.penyesuaian_bunga,
    pokokDibayar: r.pokok_dibayar,
    bungaDibayar: r.bunga_dibayar,
    totalPayout: r.total_payout,
    rateKontrak: r.rate_kontrak,
    rateEfektif: r.rate_efektif,
    alasan: r.alasan ?? null,
    journalId: r.journal_id ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

const SQL_SETTLEMENT =
  `SELECT d.*, k.nomor_transaksi, k.anggota_id
   FROM simpanan_berjangka_pencairan_dini d
   JOIN simpanan_berjangka k ON k.id = d.simpanan_berjangka_id`;

/** Riwayat pencairan dini seorang anggota (atau seluruh anggota). */
export async function listPencairanDini(anggotaId?: string): Promise<SettlementDiniRow[]> {
  const db = await getDb();
  const rows = anggotaId
    ? await db.getAllAsync<any>(
        `${SQL_SETTLEMENT} WHERE k.anggota_id = ? ORDER BY d.tanggal_pencairan DESC`,
        anggotaId
      )
    : await db.getAllAsync<any>(`${SQL_SETTLEMENT} ORDER BY d.tanggal_pencairan DESC`);
  return rows.map(mapSettlement);
}

/** Settlement satu kontrak, atau null bila kontraknya cair normal. */
export async function getPencairanDiniKontrak(
  kontrakId: string
): Promise<SettlementDiniRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `${SQL_SETTLEMENT} WHERE d.simpanan_berjangka_id = ?`,
    kontrakId
  );
  return row ? mapSettlement(row) : null;
}

/**
 * Total penalti & biaya admin penarikan dini pada satu rentang —
 * dipakai rekonsiliasi untuk membandingkan subledger settlement dengan
 * saldo GL akun pendapatan yang ditunjuk kebijakan (§AD).
 */
export async function getTotalPendapatanDiniPadaDb(
  db: SQLite.SQLiteDatabase
): Promise<{ penalti: Rupiah; biayaAdmin: Rupiah; bungaHangus: Rupiah }> {
  const row = await db.getFirstAsync<{ p: number; b: number; f: number }>(
    `SELECT COALESCE(SUM(penalti),0) p, COALESCE(SUM(biaya_admin),0) b,
            COALESCE(SUM(bunga_hangus),0) f
     FROM simpanan_berjangka_pencairan_dini`
  );
  return {
    penalti: row?.p ?? 0,
    biayaAdmin: row?.b ?? 0,
    bungaHangus: row?.f ?? 0,
  };
}
