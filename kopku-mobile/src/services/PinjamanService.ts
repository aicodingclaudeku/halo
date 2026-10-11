import * as SQLite from 'expo-sqlite';
import {
  sqlJadwalCurrent,
  sqlJadwalMasihTertagih,
  sqlJadwalBukanObsolete,
  isObsoleteRepaymentSchedule,
  isCurrentRepaymentSchedule,
  isScheduleObsoleteForRestructuring,
} from '@/accounting/ScheduleLifecycle';
import { getDb, withTransaction } from '@/database/db';
import { assertAccountingPeriodOpen, createJournal, reverseJournal, JournalLineInput } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import {
  hitungJadwalAngsuran,
  hitungDenda,
  hitungTotalBarisCustom,
  validasiJadwalCustom,
  BarisAngsuranCustomInput,
  MetodeJasa,
  SatuanTenor,
} from '@/accounting/PinjamanCalculator';
import { checkLiquiditasPencairan, checkSaldoAkunCukup } from '@/services/LiquidityService';
import { checkEligibilitasPinjaman } from '@/services/LoanEligibilityService';
import { checkBelumDicairkan, checkPembayaranTidakMelebihiOutstanding, checkAnggotaAktif, validateAll } from '@/validators/BusinessRuleEngine';
import { requirePermission } from '@/services/PermissionService';
import { getKlasifikasiPinjamanAktif } from '@/services/LoanImpairmentService';
import {
  alokasikanPembayaranJasa,
  terapkanPembayaranKePiutangJasa,
  catatFeeIntegralPendingEir,
  hitungOutstandingPiutangJasa,
  hitungSaldoPiutangPokokGL,
  hitungSaldoPenyisihanGL,
  terapkanWriteOffKePiutangJasa,
} from '@/services/AkrualJasaPinjamanService';
import { inisiasiEirPinjaman, tandaiEirPendingRestrukturisasi, deselesaikanFeeEirDiDalamTransaksi } from '@/services/EirAccountingService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { differenceInCalendarDays } from 'date-fns';
import {
  calculateInstallmentDate,
  calculateMaturityDate,
} from '@/accounting/InstallmentDate';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { urutkanEventAkadUlang, jatuhTempoAkhir } from '@/services/AkadUlangPresentasi';
import { getSusunanPengurusInti } from '@/services/KoperasiMasterService';
import type { SusunanPengurusInti } from '@/services/PengurusInti';

/**
 * REQUIREMENT 7 — klasifikasi akuntansi biaya administrasi pencairan.
 * Nilainya PERSIS nilai CHECK constraint kolom
 * `pinjaman.biaya_admin_klasifikasi` (schema.ts) — TIDAK ada nilai baru
 * yang dikarang.
 *   SEPARATE_SERVICE ("Jasa Terpisah")  -> fee diakui langsung sebagai
 *       Pendapatan Administrasi (4-1100) pada tanggal pencairan.
 *   INTEGRAL_FINANCIAL_INSTRUMENT ("Jasa Integral") -> fee adalah
 *       bagian dari pengukuran instrumen keuangan: TIDAK diakui sebagai
 *       pendapatan langsung, dibukukan sebagai Pendapatan Diterima
 *       Dimuka (2-1300) lalu diamortisasi lewat EIR sungguhan
 *       (EirAccountingService). Lihat cairkanPinjaman().
 */
export type BiayaAdminKlasifikasi = 'SEPARATE_SERVICE' | 'INTEGRAL_FINANCIAL_INSTRUMENT';

/**
 * REQUIREMENT 7 — normalisasi & validasi klasifikasi biaya admin.
 * Aturan: kalau TIDAK ADA biaya administrasi sama sekali
 * (biayaAdminTipe === 'TIDAK_ADA'), klasifikasi dipaksa
 * 'SEPARATE_SERVICE' — bukan karena "lebih aman", tapi karena
 * klasifikasi integral tanpa fee tidak punya arti akuntansi apa pun
 * (tidak ada yang diamortisasi) dan hanya akan membuat
 * `eir_measurement_status` bergeser tanpa sebab.
 */
function normalisasiBiayaAdminKlasifikasi(
  biayaAdminTipe: 'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA',
  klasifikasi: BiayaAdminKlasifikasi | undefined
): BiayaAdminKlasifikasi {
  if (biayaAdminTipe === 'TIDAK_ADA') return 'SEPARATE_SERVICE';
  const nilai = klasifikasi ?? 'SEPARATE_SERVICE';
  if (nilai !== 'SEPARATE_SERVICE' && nilai !== 'INTEGRAL_FINANCIAL_INSTRUMENT') {
    throw new Error('Klasifikasi biaya administrasi tidak valid.');
  }
  return nilai;
}

/** RC-S54 item 24 — pilihan tujuan pinjaman. */
export type TujuanPinjaman = 'MODAL_KERJA' | 'INVESTASI' | 'KONSUMTIF' | 'LAINNYA';

export const LABEL_TUJUAN_PINJAMAN: Readonly<Record<TujuanPinjaman, string>> = Object.freeze({
  MODAL_KERJA: 'Modal Kerja',
  INVESTASI: 'Investasi',
  KONSUMTIF: 'Konsumtif',
  LAINNYA: 'Lainnya',
});

/** RC-S54 item 25 — jenis agunan. */
export type JenisAgunan =
  | 'TANAH'
  | 'TANAH_DAN_BANGUNAN'
  | 'KENDARAAN'
  | 'DEPOSITO'
  | 'TABUNGAN'
  | 'BARANG_BERGERAK_LAINNYA';

export const LABEL_JENIS_AGUNAN: Readonly<Record<JenisAgunan, string>> = Object.freeze({
  TANAH: 'Tanah',
  TANAH_DAN_BANGUNAN: 'Tanah dan Bangunan',
  KENDARAAN: 'Kendaraan',
  DEPOSITO: 'Deposito',
  TABUNGAN: 'Tabungan',
  BARANG_BERGERAK_LAINNYA: 'Barang Bergerak Lainnya',
});

export interface AgunanInput {
  jenisAgunan: JenisAgunan;
  pemilik: string;
  nomorDokumen: string;
  nilaiAgunan: Rupiah;
  keterangan?: string;
}

export interface AgunanRow extends AgunanInput {
  id: string;
  pinjamanId: string;
}

export interface AjukanPinjamanInput {
  anggotaId: string;
  tanggal: string;
  jumlahPinjaman: Rupiah;
  tenor: number;
  satuanTenor: SatuanTenor;
  metodeJasa: MetodeJasa;
  persentaseJasa: number;
  biayaAdminTipe: 'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA';
  biayaAdminNilai: number;
  /**
   * REQUIREMENT 7 (permintaan pengguna) — "Jasa Terpisah" vs "Jasa
   * Integral" untuk biaya administrasi pencairan. Ini BUKAN konsep
   * baru: kolom `pinjaman.biaya_admin_klasifikasi` sudah ada sejak
   * migration v43 dan SUDAH dipakai `cairkanPinjaman()` untuk memilih
   * akun kredit yang berbeda (Pendapatan Administrasi 4-1100 vs
   * Pendapatan Diterima Dimuka 2-1300 + inisiasi EIR). Yang HILANG
   * sebelumnya adalah jalan bagi petugas untuk MEMILIHNYA — form
   * pengajuan tidak pernah mengirim field ini sehingga SELALU jatuh ke
   * default 'SEPARATE_SERVICE'. Field ini menutup celah itu.
   *
   * Opsional; kalau tidak diisi tetap 'SEPARATE_SERVICE' (perilaku
   * lama persis, tidak ada regresi untuk caller existing).
   */
  biayaAdminKlasifikasi?: BiayaAdminKlasifikasi;
  /**
   * RC-S54 item 24 — tujuan pinjaman. WAJIB untuk pengajuan baru.
   * Opsional pada tipe karena pinjaman lama memang tidak punya nilai
   * ini; `ajukanPinjaman()` menolak bila kosong.
   */
  tujuanPinjaman?: TujuanPinjaman;
  /** Wajib HANYA bila `tujuanPinjaman === 'LAINNYA'`. */
  tujuanDetail?: string;
  /**
   * RC-S54 item 25 — agunan. Tidak diisi berarti "Tidak Ada", dan
   * TIDAK ada baris `pinjaman_agunan` yang dibuat.
   */
  agunan?: AgunanInput;
  dendaAktif: boolean;
  dendaTipe?: string;
  dendaNilai?: number;
  keterangan?: string;
  createdBy: string;
}

/**
 * BUG-13 — `tambahTenor()` DIHAPUS.
 *
 * Fungsi ini dulu dipakai dua cara: sekali-lompat untuk header maturity
 * dan iteratif untuk tiap baris jadwal. Untuk satuan BULAN kedua cara
 * itu memberi hasil BERBEDA (lihat penjelasan clamping akhir bulan di
 * `src/accounting/InstallmentDate.ts`), sehingga
 * `pinjaman.tanggal_jatuh_tempo` bisa tidak sama dengan
 * `MAX(angsuran_jadwal.tanggal_jatuh_tempo)`.
 *
 * Seluruh perhitungan tanggal angsuran sekarang lewat
 * `calculateInstallmentDate()` / `calculateMaturityDate()` — satu
 * algoritma, selalu relatif terhadap tanggal akad.
 */

/** Ajukan pinjaman baru + generate jadwal angsuran (belum dicairkan). PRD §11-12. */
export async function ajukanPinjaman(input: AjukanPinjamanInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'pinjaman', 'create');

    // Phase 6 (AUDIT_INTERNAL.md §3.2, §7 temuan #5): sebelum ini
    // ajukanPinjaman TIDAK ADA validasi eligibility sama sekali selain
    // izin akses. Pengajuan TETAP tidak menyentuh kas/piutang (jurnal
    // baru dibuat saat pencairan, sesuai desain awal) — ini murni gate
    // "boleh/tidak boleh mengajukan", dijalankan SEBELUM baris
    // `pinjaman` diinsert sama sekali.
    const cekEligibilitas = await checkEligibilitasPinjaman(db, {
      anggotaId: input.anggotaId,
      jumlahDiajukan: input.jumlahPinjaman,
    });
    if (!cekEligibilitas.valid) throw new Error(cekEligibilitas.reason);

    // RC-S54 item 24 & 25 — validasi tujuan & agunan, SEBELUM satu baris
    // pun ditulis. Keduanya murni data pengajuan: nol dampak pada
    // jurnal, pencairan, angsuran, restrukturisasi, maupun write-off.
    const tujuan = validasiTujuanPinjaman(input);
    const agunan = validasiAgunan(input.agunan);

    const year = new Date(input.tanggal).getFullYear();
    const nomorPinjaman = await nextSequence(db, 'PJ', year);
    const id = newId();
    const now = new Date().toISOString();

    // BUG-13: maturity header = tanggal angsuran TERAKHIR, dihitung
    // dengan algoritma yang SAMA PERSIS dengan baris jadwalnya.
    const tanggalJatuhTempo = calculateMaturityDate(input.tanggal, input.tenor, input.satuanTenor);

    // REQUIREMENT 7: kolom `biaya_admin_klasifikasi` SEKARANG diisi
    // eksplisit dari pilihan petugas (sebelumnya tidak pernah ada di
    // daftar kolom INSERT sehingga selalu memakai DEFAULT skema).
    const biayaAdminKlasifikasi = normalisasiBiayaAdminKlasifikasi(
      input.biayaAdminTipe,
      input.biayaAdminKlasifikasi
    );

    await db.runAsync(
      `INSERT INTO pinjaman
        (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor,
         metode_jasa, persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, biaya_admin_klasifikasi,
         denda_aktif, denda_tipe, denda_nilai, tanggal_jatuh_tempo, status,
         tujuan_pinjaman, tujuan_detail,
         keterangan, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, nomorPinjaman, input.anggotaId, input.tanggal, input.jumlahPinjaman, input.tenor,
      input.satuanTenor, input.metodeJasa, input.persentaseJasa, input.biayaAdminTipe,
      input.biayaAdminNilai, biayaAdminKlasifikasi, input.dendaAktif ? 1 : 0, input.dendaTipe ?? null,
      input.dendaNilai ?? 0, tanggalJatuhTempo, 'DIAJUKAN',
      tujuan.tujuanPinjaman, tujuan.tujuanDetail,
      input.keterangan ?? null, input.createdBy, now, now
    );

    // Agunan hanya ditulis bila memang ADA. "Tidak Ada" diwakili oleh
    // KETIADAAN baris, bukan baris kosong bernilai 0.
    if (agunan) {
      await db.runAsync(
        `INSERT INTO pinjaman_agunan
          (id, pinjaman_id, jenis_agunan, pemilik, nomor_dokumen, nilai_agunan, keterangan,
           created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        newId(), id, agunan.jenisAgunan, agunan.pemilik, agunan.nomorDokumen,
        agunan.nilaiAgunan, agunan.keterangan ?? null, input.createdBy, now, now
      );
    }

    // Generate jadwal angsuran (kosong untuk CUSTOM, diisi manual nanti)
    const jadwal = hitungJadwalAngsuran({
      jumlahPinjaman: input.jumlahPinjaman,
      tenor: input.tenor,
      persentaseJasaPerPeriode: input.persentaseJasa,
      metode: input.metodeJasa,
    });

    for (const row of jadwal) {
      // BUG-13: dihitung dari tanggal akad + nomor angsuran, BUKAN
      // ditumpuk dari hasil iterasi sebelumnya.
      const tanggalAngsuran = calculateInstallmentDate(input.tanggal, row.nomorAngsuran, input.satuanTenor);
      await db.runAsync(
        `INSERT INTO angsuran_jadwal
          (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        newId(), id, row.nomorAngsuran, tanggalAngsuran,
        row.pokok, row.jasa, 0, row.total, 'BELUM_BAYAR'
      );
    }

    return { id, nomorPinjaman };
  });
}

export interface EditPinjamanInput {
  pinjamanId: string;
  tanggal: string;
  jumlahPinjaman: Rupiah;
  tenor: number;
  satuanTenor: SatuanTenor;
  metodeJasa: MetodeJasa;
  persentaseJasa: number;
  biayaAdminTipe: 'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA';
  biayaAdminNilai: number;
  /** REQUIREMENT 7 — lihat AjukanPinjamanInput.biayaAdminKlasifikasi. Aman diubah di sini karena pinjaman belum dicairkan (belum ada jurnal fee/EIR yang terlanjur dibuat). */
  biayaAdminKlasifikasi?: BiayaAdminKlasifikasi;
  dendaAktif: boolean;
  dendaTipe?: string;
  dendaNilai?: number;
  keterangan?: string;
  /**
   * RC-S72 — TUJUAN & AGUNAN PADA EDIT (bug produksi: form Edit Pinjaman
   * mengirim field ini tetapi kontrak & service lama membuangnya diam-diam).
   *
   * Semantik tri-state, SAMA dengan aturan `ajukanPinjaman`:
   *   - `tujuanPinjaman` undefined  -> tujuan TIDAK diubah (pemanggil
   *     programatik lama yang tidak berurusan dengan tujuan);
   *     diisi -> divalidasi `validasiTujuanPinjaman` lalu disimpan.
   *   - `agunan` undefined -> agunan TIDAK diubah;
   *     null -> "Tidak Ada" (baris agunan dihapus — pinjaman belum cair);
   *     objek -> divalidasi `validasiAgunan` lalu menggantikan agunan.
   * Tidak ada efek akuntansi: tujuan/agunan tidak dipakai jurnal, EIR,
   * maupun impairment, dan edit hanya sah sebelum pencairan.
   */
  tujuanPinjaman?: TujuanPinjaman;
  /** Wajib HANYA bila `tujuanPinjaman === 'LAINNYA'`. */
  tujuanDetail?: string;
  agunan?: AgunanInput | null;
  actingUserId: string;
}

/**
 * Edit pinjaman yang BELUM dicairkan (bug fix — sebelumnya TIDAK ADA
 * fungsi edit sama sekali, hanya ajukanPinjaman untuk buat baru). ID &
 * nomor pinjaman TIDAK PERNAH berubah. HANYA boleh selama status
 * DIAJUKAN/DISETUJUI — begitu AKTIF (sudah cair, ada jurnal/piutang/EIR),
 * koreksi harus lewat Akad Ulang, BUKAN fungsi ini (guard sama seperti
 * simpanJadwalAngsuranCustom).
 *
 * Reuse rumus existing (hitungJadwalAngsuran) — TIDAK ADA formula baru.
 * Jadwal angsuran lama dihapus & dibuat ulang dari field yang baru;
 * ini AMAN karena pinjaman belum cair sama sekali (belum ada jurnal,
 * belum ada pembayaran) — ditegakkan lewat guard di bawah, bukan
 * diasumsikan. Untuk metode CUSTOM, jadwal dikosongkan (harus disusun
 * ulang manual lewat Susun Jadwal Custom), persis alur ajukanPinjaman.
 */
export async function editPinjaman(input: EditPinjamanInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.actingUserId, 'pinjaman', 'edit');

    const pinjaman = await db.getFirstAsync<any>('SELECT * FROM pinjaman WHERE id = ?', input.pinjamanId);
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    if (!['DIAJUKAN', 'DISETUJUI'].includes(pinjaman.status)) {
      throw new Error(`Pinjaman berstatus "${pinjaman.status}" (sudah dicairkan) tidak bisa diedit lewat sini — gunakan Akad Ulang.`);
    }

    const existingRows = await db.getAllAsync<{ pokok_terbayar: number; jasa_terbayar: number }>(
      'SELECT pokok_terbayar, jasa_terbayar FROM angsuran_jadwal WHERE pinjaman_id = ?',
      input.pinjamanId
    );
    const sudahAdaPembayaran = existingRows.some((r) => r.pokok_terbayar > 0 || r.jasa_terbayar > 0);
    if (sudahAdaPembayaran) {
      throw new Error('Pinjaman tidak bisa diedit karena sudah ada pembayaran angsuran tercatat.');
    }

    // RC-S72 — validasi tujuan & agunan SEBELUM satu baris pun diubah,
    // dengan aturan yang sama persis dengan `ajukanPinjaman`.
    const tujuanBaru = input.tujuanPinjaman !== undefined ? validasiTujuanPinjaman(input) : null;
    const agunanBaru = input.agunan !== undefined ? validasiAgunan(input.agunan ?? undefined) : null;
    if (input.agunan !== undefined) {
      // Form hanya mengelola SATU agunan. Bila ada lebih dari satu baris
      // (tidak dapat dibuat lewat UI), menggantinya akan menghapus data yang
      // tidak terlihat oleh pengguna — ditolak eksplisit, bukan diam-diam.
      const jumlahAgunan = await db.getFirstAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM pinjaman_agunan WHERE pinjaman_id = ?',
        input.pinjamanId
      );
      if ((jumlahAgunan?.n ?? 0) > 1) {
        throw new Error('Pinjaman ini memiliki lebih dari satu agunan; agunan tidak dapat diubah lewat form edit.');
      }
    }

    const now = new Date().toISOString();
    // BUG-13: maturity header = tanggal angsuran TERAKHIR, dihitung
    // dengan algoritma yang SAMA PERSIS dengan baris jadwalnya.
    const tanggalJatuhTempo = calculateMaturityDate(input.tanggal, input.tenor, input.satuanTenor);

    await db.runAsync(
      `UPDATE pinjaman SET tanggal = ?, jumlah_pinjaman = ?, tenor = ?, satuan_tenor = ?,
        metode_jasa = ?, persentase_jasa = ?, biaya_admin_tipe = ?, biaya_admin_nilai = ?,
        biaya_admin_klasifikasi = ?,
        denda_aktif = ?, denda_tipe = ?, denda_nilai = ?, tanggal_jatuh_tempo = ?,
        keterangan = ?, updated_at = ?
       WHERE id = ?`,
      input.tanggal, input.jumlahPinjaman, input.tenor, input.satuanTenor,
      input.metodeJasa, input.persentaseJasa, input.biayaAdminTipe, input.biayaAdminNilai,
      normalisasiBiayaAdminKlasifikasi(input.biayaAdminTipe, input.biayaAdminKlasifikasi),
      input.dendaAktif ? 1 : 0, input.dendaTipe ?? null, input.dendaNilai ?? 0,
      tanggalJatuhTempo, input.keterangan ?? null, now, input.pinjamanId
    );

    if (tujuanBaru) {
      await db.runAsync(
        `UPDATE pinjaman SET tujuan_pinjaman = ?, tujuan_detail = ? WHERE id = ?`,
        tujuanBaru.tujuanPinjaman, tujuanBaru.tujuanDetail, input.pinjamanId
      );
    }
    if (input.agunan !== undefined) {
      await db.runAsync('DELETE FROM pinjaman_agunan WHERE pinjaman_id = ?', input.pinjamanId);
      // "Tidak Ada" diwakili KETIADAAN baris, sama seperti ajukanPinjaman.
      if (agunanBaru) {
        await db.runAsync(
          `INSERT INTO pinjaman_agunan
            (id, pinjaman_id, jenis_agunan, pemilik, nomor_dokumen, nilai_agunan, keterangan,
             created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          newId(), input.pinjamanId, agunanBaru.jenisAgunan, agunanBaru.pemilik, agunanBaru.nomorDokumen,
          agunanBaru.nilaiAgunan, agunanBaru.keterangan ?? null, input.actingUserId, now, now
        );
      }
    }

    await db.runAsync('DELETE FROM angsuran_jadwal WHERE pinjaman_id = ?', input.pinjamanId);

    if (input.metodeJasa !== 'CUSTOM') {
      const jadwal = hitungJadwalAngsuran({
        jumlahPinjaman: input.jumlahPinjaman,
        tenor: input.tenor,
        persentaseJasaPerPeriode: input.persentaseJasa,
        metode: input.metodeJasa,
      });
      for (const row of jadwal) {
        const tanggalAngsuran = calculateInstallmentDate(input.tanggal, row.nomorAngsuran, input.satuanTenor);
        await db.runAsync(
          `INSERT INTO angsuran_jadwal
            (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          newId(), input.pinjamanId, row.nomorAngsuran, tanggalAngsuran,
          row.pokok, row.jasa, 0, row.total, 'BELUM_BAYAR'
        );
      }
    }
    // CUSTOM: jadwal dibiarkan kosong — sama seperti ajukanPinjaman baru,
    // harus disusun ulang lewat simpanJadwalAngsuranCustom.
  });
}

/**
 * Batalkan pinjaman yang BELUM dicairkan (bug fix — sebelumnya TIDAK
 * ADA cara membatalkan pengajuan sama sekali dari UI). Reuse nilai enum
 * `DITOLAK` yang SUDAH ADA di skema `pinjaman.status`
 * (lihat komentar listPinjaman §I: "'DIBATALKAN' (DITOLAK — enum
 * existing, tidak ada nilai 'DIBATALKAN' terpisah di skema)") — TIDAK
 * membuat status/kolom baru.
 *
 * HANYA boleh selama status DIAJUKAN/DISETUJUI (belum cair). Tidak
 * pernah membuat jurnal pencairan, Piutang Pinjaman, Pendapatan Jasa,
 * atau EIR — karena semua itu memang belum ada untuk pinjaman yang
 * belum dicairkan. Tidak menghapus historical data apa pun; baris
 * pinjaman & jadwal tetap ada, hanya status yang berubah.
 */
export async function batalkanPinjaman(params: {
  pinjamanId: string;
  alasan: string;
  actingUserId: string;
}) {
  return withTransaction(async (db) => {
    await requirePermission(db, params.actingUserId, 'pinjaman', 'edit');
    if (!params.alasan.trim()) throw new Error('Alasan pembatalan wajib diisi.');

    const pinjaman = await db.getFirstAsync<{ status: string; keterangan: string | null }>(
      'SELECT status, keterangan FROM pinjaman WHERE id = ?',
      params.pinjamanId
    );
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    if (!['DIAJUKAN', 'DISETUJUI'].includes(pinjaman.status)) {
      throw new Error(`Pinjaman berstatus "${pinjaman.status}" tidak bisa dibatalkan lewat sini (sudah cair).`);
    }

    const now = new Date().toISOString();
    const keteranganBaru = pinjaman.keterangan
      ? `${pinjaman.keterangan} | Dibatalkan: ${params.alasan.trim()}`
      : `Dibatalkan: ${params.alasan.trim()}`;

    await db.runAsync(
      `UPDATE pinjaman SET status = 'DITOLAK', keterangan = ?, updated_at = ? WHERE id = ?`,
      keteranganBaru, now, params.pinjamanId
    );
  });
}

/**
 * Simpan/ganti jadwal angsuran CUSTOM (fase 9 §1-3, §7-11). Dipisah dari
 * ajukanPinjaman() supaya alurnya jelas: ajukan dulu (jadwal kosong untuk
 * metode CUSTOM, lihat komentar di ajukanPinjaman), lalu admin susun
 * jadwalnya sendiri di sini sebelum pinjaman dicairkan.
 *
 * Boleh dipanggil ULANG (mengganti jadwal lama) selama pinjaman BELUM
 * cair (status DIAJUKAN/DISETUJUI) dan belum ada satu pun pembayaran —
 * begitu ada pembayaran atau sudah cair, jadwal dikunci supaya
 * outstanding balance tetap konsisten dengan jurnal yang sudah diposting.
 */
export async function simpanJadwalAngsuranCustom(params: {
  pinjamanId: string;
  baris: BarisAngsuranCustomInput[];
  createdBy: string;
}) {
  return withTransaction(async (db) => {
    await requirePermission(db, params.createdBy, 'pinjaman', 'create');

    const pinjaman = await db.getFirstAsync<any>('SELECT * FROM pinjaman WHERE id = ?', params.pinjamanId);
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    if (pinjaman.metode_jasa !== 'CUSTOM') {
      throw new Error('Jadwal custom hanya berlaku untuk pinjaman dengan metode jasa CUSTOM.');
    }
    if (!['DIAJUKAN', 'DISETUJUI'].includes(pinjaman.status)) {
      throw new Error(`Jadwal angsuran tidak bisa diubah untuk pinjaman berstatus "${pinjaman.status}" (sudah cair).`);
    }

    const existingRows = await db.getAllAsync<{ id: string; pokok_terbayar: number; jasa_terbayar: number }>(
      'SELECT id, pokok_terbayar, jasa_terbayar FROM angsuran_jadwal WHERE pinjaman_id = ?',
      params.pinjamanId
    );
    const sudahAdaPembayaran = existingRows.some((r) => r.pokok_terbayar > 0 || r.jasa_terbayar > 0);
    if (sudahAdaPembayaran) {
      throw new Error('Jadwal tidak bisa diubah karena sudah ada pembayaran angsuran tercatat.');
    }

    const validasi = validasiJadwalCustom(params.baris, pinjaman.jumlah_pinjaman, pinjaman.tanggal);
    if (!validasi.valid) {
      throw new Error(`Jadwal angsuran tidak valid:\n${validasi.errors.join('\n')}`);
    }

    if (existingRows.length > 0) {
      await db.runAsync('DELETE FROM angsuran_jadwal WHERE pinjaman_id = ?', params.pinjamanId);
    }

    const hasil = hitungTotalBarisCustom(params.baris);
    for (const row of hasil) {
      await db.runAsync(
        `INSERT INTO angsuran_jadwal
          (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
         VALUES (?,?,?,?,?,?,0,?,'BELUM_BAYAR')`,
        newId(),
        params.pinjamanId,
        row.nomorAngsuran,
        row.tanggalJatuhTempo,
        row.pokok,
        row.jasa,
        row.total
      );
    }

    return {
      jumlahPeriode: validasi.jumlahPeriode,
      totalPokok: validasi.totalPokok,
      totalJasa: validasi.totalJasa,
      totalAngsuran: validasi.totalAngsuran,
    };
  });
}

/**
 * Cairkan pinjaman yang sudah DISETUJUI. Jurnal (PRD §11):
 *   DEBIT  Piutang Pinjaman
 *   KREDIT Kas/Bank
 * Jika ada biaya admin, dipotong langsung dari pencairan dan diakui
 * sebagai Pendapatan Administrasi.
 *
 * FIX WALL-CLOCK DATE (permintaan pengguna): SEBELUMNYA fungsi ini
 * memakai `format(new Date(), 'yyyy-MM-dd')` di TIGA tempat sekaligus
 * (tanggal jurnal pencairan, tanggal pencatatan fee integral, dan
 * `tanggalPencairan` yang dikirim ke `inisiasiEirPinjaman`). Akibatnya,
 * kalau pencairan diproses pada hari yang BERBEDA dari tanggal akad —
 * termasuk seluruh skenario data historis/backdate — arus kas EIR
 * dibangun relatif terhadap tanggal RUNTIME, bukan tanggal transaksi
 * pencairan yang sesungguhnya. Untuk pinjaman berakad 2026-01-01
 * dengan jadwal 2026-02-01 dst, offset `hari` menjadi NEGATIF dan tidak
 * monoton, lalu `validasiCashFlows()` di EIR solver menolaknya
 * ("Arus kas harus terurut menaik berdasarkan tanggal (hari)") sehingga
 * SELURUH transaksi pencairan rollback.
 *
 * Sekarang tanggal pencairan berasal dari SATU sumber tunggal
 * (`tanggalPencairan`), dengan prioritas:
 *   1. tanggal pencairan EKSPLISIT dari caller (`params.tanggalPencairan`)
 *   2. fallback tanggal kalender LOKAL hari ini (`getTanggalLokalHariIni()`
 *      — helper existing dari fix timezone sebelumnya, BUKAN helper baru,
 *      dan BUKAN UTC `toISOString()`)
 *
 * Parameter ini OPSIONAL supaya seluruh caller lama (UI
 * PinjamanDetailScreen & test existing) berperilaku PERSIS SAMA seperti
 * sebelumnya. `pinjaman.tanggal` SENGAJA TIDAK dipakai sebagai fallback:
 * menurut code flow, kolom itu adalah tanggal AKAD (basis
 * `hitungJadwalAngsuran` & seluruh `tanggal_jatuh_tempo` di
 * `ajukanPinjaman`), dan skema TIDAK punya kolom tanggal pencairan
 * tersendiri — menyamakan keduanya secara diam-diam berarti mengarang
 * aturan domain baru.
 *
 * Satu nilai yang sama dipakai untuk tanggal jurnal pencairan, tanggal
 * pencatatan fee integral, dan tanggal referensi arus kas EIR, sehingga
 * ketiganya TIDAK MUNGKIN lagi saling bertentangan.
 *
 * RUMUS EIR TIDAK DISENTUH — yang diperbaiki murni INPUT tanggalnya.
 */
export type CairkanPinjamanParams = {
  pinjamanId: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  approvedBy: string;
  /** Tanggal transaksi pencairan 'YYYY-MM-DD'. Opsional — default tanggal kalender LOKAL hari ini. */
  tanggalPencairan?: string;
};

export async function cairkanPinjaman(params: CairkanPinjamanParams) {
  return withTransaction(async (db) => cairkanPinjamanDb(db, params));
}

/**
 * RC-S133.6.2 — isi fungsi di atas TANPA membuka transaksi sendiri (ekstraksi murni,
 * logika tidak diubah), supaya koreksi transaksi dari History dapat membalik
 * transaksi asal lalu mencatat ulang dalam SATU transaksi database.
 * Pemanggil WAJIB sudah berada di dalam withTransaction.
 */
export async function cairkanPinjamanDb(db: SQLite.SQLiteDatabase, params: CairkanPinjamanParams) {
    await requirePermission(db, params.approvedBy, 'pinjaman', 'approve');

    const tanggalPencairan = params.tanggalPencairan ?? getTanggalLokalHariIni();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggalPencairan)) {
      throw new Error('Tanggal pencairan harus berformat YYYY-MM-DD.');
    }
    const pinjaman = await db.getFirstAsync<any>('SELECT * FROM pinjaman WHERE id = ?', params.pinjamanId);
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    const cekStatus = checkBelumDicairkan(pinjaman.status);
    if (!cekStatus.valid) throw new Error(cekStatus.reason);

    // FORM_TRANSACTION_AUDIT.md §4.1 (HIGH): ajukanPinjaman() sudah
    // mengecek eligibility (termasuk anggota AKTIF) SEKALI saat
    // pengajuan, tapi status anggota bisa berubah (KELUAR/MENINGGAL/
    // TIDAK_AKTIF) di antara pengajuan dan pencairan — jeda waktu itu
    // bisa berhari-hari/berminggu. Re-check di sini, TEPAT SEBELUM
    // ada tulisan apa pun (jurnal/update status pinjaman), pakai rule
    // yang SAMA PERSIS dengan yang sudah dipakai SimpananService
    // (checkAnggotaAktif — 'AKTIF' saja yang lolos, tidak ada status
    // baru yang dikarang). Karena ini masih di dalam withTransaction
    // SEBELUM baris tulis pertama, gagal di sini otomatis TIDAK
    // meninggalkan jejak apa pun (tidak ada jurnal, tidak ada
    // perubahan saldo, tidak ada perubahan status pinjaman).
    const anggotaPencairan = await db.getFirstAsync<{ status: string }>(
      'SELECT status FROM anggota WHERE id = ?',
      pinjaman.anggota_id
    );
    if (!anggotaPencairan) throw new Error('Data anggota untuk pinjaman ini tidak ditemukan.');
    const cekAnggotaPencairan = checkAnggotaAktif(anggotaPencairan.status);
    if (!cekAnggotaPencairan.valid) {
      throw new Error(`Pencairan ditolak: ${cekAnggotaPencairan.reason}`);
    }

    const piutangAccountId = await resolveAccountId(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG');
    const kasBankAccountId = await resolveKasBankAccountId(db, params.sumberDana, params.bankAccountId);

    // Phase 4 (AUDIT_INTERNAL.md §7 temuan #2, BLOCKER): SEBELUM ini,
    // cairkanPinjaman tidak pernah membaca saldo kas/bank sama sekali —
    // kas/bank bisa jadi negatif tanpa penolakan. Dua lapis cek sesuai
    // spesifikasi: (1) liquidity AGREGAT (kas+bank di seluruh koperasi,
    // dikurangi reserve/minimum/pending) — mencegah total kas koperasi
    // habis walau rekening yang dipilih kebetulan cukup; (2) saldo
    // rekening SPESIFIK yang dipilih user — mencegah rekening itu
    // sendiri jadi negatif walau agregat koperasi masih sehat.
    const cekLikuiditas = await checkLiquiditasPencairan(db, {
      jumlahDiajukan: pinjaman.jumlah_pinjaman,
      excludePinjamanId: pinjaman.id,
    });
    const cekSaldoRekening = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: params.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: pinjaman.jumlah_pinjaman,
    });
    const cekGabungan = validateAll(cekLikuiditas, cekSaldoRekening);
    if (!cekGabungan.valid) throw new Error(cekGabungan.reason);

    let biayaAdmin = 0;
    if (pinjaman.biaya_admin_tipe === 'NOMINAL') biayaAdmin = pinjaman.biaya_admin_nilai;
    else if (pinjaman.biaya_admin_tipe === 'PERSENTASE') {
      biayaAdmin = Math.round((pinjaman.jumlah_pinjaman * pinjaman.biaya_admin_nilai) / 100);
    }
    const klasifikasiFee = pinjaman.biaya_admin_klasifikasi ?? 'SEPARATE_SERVICE';

    const lines = [{ accountId: piutangAccountId, debit: pinjaman.jumlah_pinjaman, kredit: 0 }];

    if (biayaAdmin > 0) {
      // PHASE 2 (§12/§13, permintaan pengguna): klasifikasi fee admin
      // pencairan (pinjaman.biaya_admin_klasifikasi, migration v43) —
      // DEFAULT 'SEPARATE_SERVICE' untuk seluruh pinjaman yang tidak
      // eksplisit diisi, jadi baris ini berperilaku PERSIS SAMA dengan
      // sebelum Phase 2 KECUALI admin secara eksplisit menandai
      // pinjaman sebagai INTEGRAL_FINANCIAL_INSTRUMENT.
      lines.push({ accountId: kasBankAccountId, debit: 0, kredit: pinjaman.jumlah_pinjaman - biayaAdmin });
      if (klasifikasiFee === 'INTEGRAL_FINANCIAL_INSTRUMENT') {
        // Fee integral TIDAK diakui sebagai pendapatan langsung pada
        // tanggal pencairan (memerlukan pengukuran EIR/effective yield
        // penuh — di luar scope Phase 2, "jangan membuat EIR palsu").
        // Dibukukan sementara sebagai liabilitas "Pendapatan Diterima
        // Dimuka" (akun 2-1300 existing, reuse) sampai Phase EIR
        // membangun amortisasi yang sesungguhnya.
        const dimukaAccountId = await resolveAccountId(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA');
        lines.push({ accountId: dimukaAccountId, debit: 0, kredit: biayaAdmin });
      } else {
        const adminIncomeAccountId = await resolveAccountId(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN');
        lines.push({ accountId: adminIncomeAccountId, debit: 0, kredit: biayaAdmin });
      }
    } else {
      lines.push({ accountId: kasBankAccountId, debit: 0, kredit: pinjaman.jumlah_pinjaman });
    }

    const { journalId } = await createJournal(db, {
      tanggal: tanggalPencairan,
      sumberTransaksi: 'PENCAIRAN_PINJAMAN',
      sumberId: pinjaman.id,
      nomorReferensi: pinjaman.nomor_pinjaman,
      deskripsi: `Pencairan pinjaman ${pinjaman.nomor_pinjaman}`,
      createdBy: params.approvedBy,
      lines,
    });

    // PHASE 2 KOREKSI (permintaan pengguna §2): fee integral yang baru
    // saja dibukukan ke Pendapatan Diterima Dimuka di atas dicatat
    // eksplisit sebagai DEFERRED_PENDING_EIR (bukan hanya duduk diam
    // di GL tanpa jejak status) — TIDAK ADA jurnal amortisasi/EIR
    // dibuat di sini, murni pencatatan schedule untuk Phase EIR
    // berikutnya. Dipanggil di transaction yang sama dengan jurnal
    // pencairan (rollback bersama kalau ada langkah lain gagal).
    if (klasifikasiFee === 'INTEGRAL_FINANCIAL_INSTRUMENT') {
      // AA1 FIX (permintaan pengguna, kategori production bug):
      // SEBELUMNYA seluruh blok ini dijaga `biayaAdmin > 0`, sehingga
      // pinjaman yang ditandai INTEGRAL_FINANCIAL_INSTRUMENT tetapi
      // fee-nya 0 TIDAK PERNAH melewati inisiasiEirPinjaman() sama
      // sekali dan `eir_measurement_status`-nya tertinggal di
      // 'EIR_NOT_MIGRATED' — padahal secara desain pinjaman seperti itu
      // memang TIDAK memerlukan pengukuran EIR dan seharusnya ditandai
      // 'NOT_APPLICABLE' (lihat dokumentasi inisiasiEirPinjaman: "kalau
      // fee integral = 0, tidak ada apa pun untuk diamortisasi ...
      // eir_measurement_status tetap 'NOT_APPLICABLE', BUKAN error").
      // Akibatnya status pengukuran EIR jadi tidak akurat untuk
      // pelaporan/audit. Sekarang inisiasiEirPinjaman() SELALU dipanggil
      // untuk klasifikasi INTEGRAL; pencatatan fee dimuka tetap hanya
      // dilakukan kalau fee-nya memang ada (>0), jadi TIDAK ADA baris
      // fee bernilai nol yang dikarang.
      if (biayaAdmin > 0) {
        await catatFeeIntegralPendingEir(db, {
          pinjamanId: pinjaman.id,
          tanggal: tanggalPencairan,
          jumlahFee: biayaAdmin,
          journalId,
          createdBy: params.approvedBy,
        });
      }

      // PHASE 7 (permintaan pengguna §C/§G): sekarang hitung EIR
      // SUNGGUHAN dari seluruh arus kas kontraktual (angsuran_jadwal
      // yang SUDAH ada, dibuat ajukanPinjaman — TIDAK dihitung ulang
      // di sini) terhadap initial carrying amount (kas bersih yang
      // diserahkan). §AC: TIDAK ADA try/catch yang menelan error —
      // kalau solver gagal konvergen, SELURUH transaksi pencairan ini
      // rollback (dalam withTransaction yang sama), BUKAN dilanjutkan
      // dengan EIR palsu/fallback.
      await inisiasiEirPinjaman(db, {
        pinjamanId: pinjaman.id,
        tanggalPencairan,
        jumlahPinjaman: pinjaman.jumlah_pinjaman,
        feeIntegral: biayaAdmin,
      });
    }

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE pinjaman SET status = 'AKTIF', pencairan_journal_id = ?, approved_by = ?, updated_at = ? WHERE id = ?`,
      journalId, params.approvedBy, now, params.pinjamanId
    );

    return { journalId };
}

/**
 * Cek apakah pencairan pinjaman aman diedit/dihapus.
 *
 * PHASE 4 §G KOREKSI (permintaan pengguna, ditegaskan ulang setelah
 * Fase 8 sebelumnya): SEBELUMNYA fungsi ini masih mengizinkan edit/
 * hapus pencairan SELAMA belum ada angsuran yang dibayarkan. Sekarang
 * DIPERKETAT — begitu pinjaman berstatus AKTIF (sudah dicairkan),
 * edit/hapus pencairan TIDAK LAGI didukung sama sekali, TANPA
 * pengecualian, sesuai instruksi eksplisit "HILANGKAN Edit Pencairan/
 * Batalkan Pencairan setelah dicairkan". Kalau ada kebutuhan koreksi
 * transaksi yang sudah POSTED, gunakan mekanisme reversal/correction
 * AccountingEngine (KoreksiTransaksiService/menu Akuntansi > Koreksi
 * Transaksi) — BUKAN fungsi ini.
 */
async function cekPencairanAmanDiubah(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string
): Promise<{ valid: true; pinjaman: any } | { valid: false; reason: string }> {
  const pinjaman = await db.getFirstAsync<any>('SELECT * FROM pinjaman WHERE id = ?', pinjamanId);
  if (!pinjaman) return { valid: false, reason: 'Pinjaman tidak ditemukan.' };
  if (pinjaman.status !== 'AKTIF' || !pinjaman.pencairan_journal_id) {
    return { valid: false, reason: 'Pinjaman ini belum pernah dicairkan (tidak ada pencairan untuk diedit/dihapus).' };
  }
  return {
    valid: false,
    reason:
      'Edit/pembatalan pencairan tidak lagi didukung setelah pinjaman dicairkan. Gunakan koreksi/reversal jurnal melalui Akuntansi > Koreksi Transaksi jika diperlukan.',
  };
}

/**
 * Edit pencairan pinjaman (§8, permintaan pengguna) — mengoreksi
 * sumber dana/rekening yang salah dipilih saat pencairan, TANPA
 * membuat pencairan ganda & TANPA mengubah ID transaksi (`pinjaman.id`/
 * `nomor_pinjaman` tetap sama, hanya `pencairan_journal_id` yang
 * berganti ke jurnal baru). Jurnal LAMA di-reversal (bukan diedit
 * mentah — prinsip yang sama dengan koreksiTransaksiKasBank/RAK/
 * Simpanan), jurnal BARU diposting dengan sumber dana yang benar,
 * divalidasi ulang persis seperti pencairan pertama kali (likuiditas +
 * saldo rekening tujuan) supaya tidak ada saldo kas/bank yang salah.
 */
export async function editPencairanPinjaman(params: {
  pinjamanId: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  alasan: string;
  actingUserId: string;
}) {
  return withTransaction(async (db) => {
    await requirePermission(db, params.actingUserId, 'pinjaman', 'approve');
    if (!params.alasan.trim()) throw new Error('Alasan koreksi pencairan wajib diisi.');

    const cek = await cekPencairanAmanDiubah(db, params.pinjamanId);
    if (!cek.valid) throw new Error(cek.reason);
    const { pinjaman } = cek;

    // Reversal jurnal LAMA dulu (mengembalikan saldo piutang & kas/bank
    // lama seperti sebelum pencairan). RC-S54 T16 GAP 5: reverseJournal()
    // tidak memeriksa periode jurnal lama — pembalik bertanggal hari ini dan
    // hanya ditolak bila periode hari ini CLOSED.
    await reverseJournal(db, pinjaman.pencairan_journal_id, params.actingUserId, `Koreksi pencairan: ${params.alasan}`);

    const piutangAccountId = await resolveAccountId(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG');
    const kasBankAccountId = await resolveKasBankAccountId(db, params.sumberDana, params.bankAccountId);

    const cekLikuiditas = await checkLiquiditasPencairan(db, {
      jumlahDiajukan: pinjaman.jumlah_pinjaman,
      excludePinjamanId: pinjaman.id,
    });
    const cekSaldoRekening = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: params.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: pinjaman.jumlah_pinjaman,
    });
    const cekGabungan = validateAll(cekLikuiditas, cekSaldoRekening);
    if (!cekGabungan.valid) throw new Error(cekGabungan.reason);

    let biayaAdmin = 0;
    if (pinjaman.biaya_admin_tipe === 'NOMINAL') biayaAdmin = pinjaman.biaya_admin_nilai;
    else if (pinjaman.biaya_admin_tipe === 'PERSENTASE') {
      biayaAdmin = Math.round((pinjaman.jumlah_pinjaman * pinjaman.biaya_admin_nilai) / 100);
    }

    const lines = [{ accountId: piutangAccountId, debit: pinjaman.jumlah_pinjaman, kredit: 0 }];
    if (biayaAdmin > 0) {
      const adminIncomeAccountId = await resolveAccountId(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN');
      lines.push({ accountId: kasBankAccountId, debit: 0, kredit: pinjaman.jumlah_pinjaman - biayaAdmin });
      lines.push({ accountId: adminIncomeAccountId, debit: 0, kredit: biayaAdmin });
    } else {
      lines.push({ accountId: kasBankAccountId, debit: 0, kredit: pinjaman.jumlah_pinjaman });
    }

    const { journalId } = await createJournal(db, {
      // RC-S95 — tanggal jurnal = "hari ini" JAM APLIKASI. Sisa terakhir pola
      // `format(new Date(), ...)` yang dulu sudah diganti di tiga tempat lain
      // (lihat komentar di atas): tanpa ini, koreksi sumber dana tetap
      // dibukukan pada tanggal asli walau Mode Pengujian Waktu aktif.
      tanggal: getTanggalLokalHariIni(),
      sumberTransaksi: 'PENCAIRAN_PINJAMAN',
      sumberId: pinjaman.id,
      nomorReferensi: pinjaman.nomor_pinjaman,
      deskripsi: `Pencairan pinjaman ${pinjaman.nomor_pinjaman} (koreksi sumber dana) - ${params.alasan}`,
      createdBy: params.actingUserId,
      lines,
    });

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE pinjaman SET pencairan_journal_id = ?, updated_at = ? WHERE id = ?`,
      journalId,
      now,
      params.pinjamanId
    );

    return { journalId };
  });
}

/**
 * Hapus/batalkan pencairan pinjaman (§8, permintaan pengguna) —
 * REVERSAL jurnal pencairan (BUKAN hard-delete jurnal yang sudah
 * posted), pinjaman dikembalikan ke status DISETUJUI (siap dicairkan
 * ulang dengan benar) — `pencairan_journal_id`/`approved_by`
 * dikosongkan. HANYA boleh kalau belum ada angsuran terkait (lihat
 * `cekPencairanAmanDiubah`) & periode belum closed (ditegakkan
 * `reverseJournal()` sendiri).
 */
export async function hapusPencairanPinjaman(params: {
  pinjamanId: string;
  alasan: string;
  actingUserId: string;
}) {
  return withTransaction(async (db) => {
    await requirePermission(db, params.actingUserId, 'pinjaman', 'approve');
    if (!params.alasan.trim()) throw new Error('Alasan pembatalan pencairan wajib diisi.');

    const cek = await cekPencairanAmanDiubah(db, params.pinjamanId);
    if (!cek.valid) throw new Error(cek.reason);
    const { pinjaman } = cek;

    const { journalId } = await reverseJournal(
      db,
      pinjaman.pencairan_journal_id,
      params.actingUserId,
      `Pencairan dibatalkan: ${params.alasan}`
    );

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE pinjaman SET status = 'DISETUJUI', pencairan_journal_id = NULL, approved_by = NULL, updated_at = ? WHERE id = ?`,
      now,
      params.pinjamanId
    );

    return { journalId };
  });
}

/**
 * Bayar angsuran. Sistem menghitung pembagian pokok/jasa/denda sesuai
 * jadwal (PRD §13). Jurnal:
 *   DEBIT  Kas/Bank
 *   KREDIT Piutang Pinjaman (porsi pokok)
 *   KREDIT Pendapatan Jasa (porsi jasa)
 *   KREDIT Pendapatan Denda (porsi denda, hanya jika > 0 — PRD: "gunakan
 *          hanya akun yang memang ada pada transaksi")
 */
export type BayarAngsuranParams = {
  pinjamanId: string;
  jadwalId: string;
  tanggal: string;
  nominal: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  createdBy: string;
};

export async function bayarAngsuran(params: BayarAngsuranParams) {
  return withTransaction(async (db) => bayarAngsuranDb(db, params));
}

/**
 * RC-S133.6.2 — isi fungsi di atas TANPA membuka transaksi sendiri (ekstraksi murni,
 * logika tidak diubah), supaya koreksi transaksi dari History dapat membalik
 * transaksi asal lalu mencatat ulang dalam SATU transaksi database.
 * Pemanggil WAJIB sudah berada di dalam withTransaction.
 */
export async function bayarAngsuranDb(db: SQLite.SQLiteDatabase, params: BayarAngsuranParams) {
    await requirePermission(db, params.createdBy, 'pinjaman', 'create');
    const jadwal = await db.getFirstAsync<any>('SELECT * FROM angsuran_jadwal WHERE id = ?', params.jadwalId);
    if (!jadwal) throw new Error('Jadwal angsuran tidak ditemukan.');
    // PHASE 3 (§I/§R, permintaan pengguna): jadwal yang sudah
    // dihapusbukukan (write-off) atau digantikan lewat akad ulang
    // TIDAK BOLEH menerima pembayaran baru lewat flow normal —
    // historical, bukan tagihan aktif. Pembayaran setelah akad ulang
    // harus diarahkan ke jadwal BARU (lihat akadUlangPinjaman).
    if (jadwal.status === 'DIHAPUSBUKU') {
      throw new Error('Angsuran ini sudah dihapusbukukan (write-off) — tidak dapat menerima pembayaran.');
    }
    if (jadwal.status === 'DIRESTRUKTURISASI') {
      throw new Error('Angsuran ini sudah digantikan oleh akad ulang — pembayaran harus mengarah ke jadwal baru.');
    }

    const pinjaman = await db.getFirstAsync<any>('SELECT * FROM pinjaman WHERE id = ?', params.pinjamanId);
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');

    // FORM_TRANSACTION_AUDIT.md §4.1 (HIGH): re-check status anggota
    // tepat sebelum transaksi finansial, pola SAMA PERSIS dengan
    // cairkanPinjaman() di atas (checkAnggotaAktif, tidak mengarang
    // status baru). Catatan kebijakan: ini SENGAJA tetap menolak
    // pembayaran walau angsuran adalah uang MASUK ke koperasi (bukan
    // keluar) — mengikuti instruksi eksplisit bahwa kedua fungsi
    // memakai rule yang sama. Kalau anggota MENINGGAL dan ahli waris
    // ingin melunasi sisa pinjaman, pembayaran itu perlu jalur lain
    // (mis. dicatat atas nama ahli waris) — bukan lewat fungsi ini
    // selama status anggota masih MENINGGAL di data induk.
    const anggotaAngsuran = await db.getFirstAsync<{ status: string }>(
      'SELECT status FROM anggota WHERE id = ?',
      pinjaman.anggota_id
    );
    if (!anggotaAngsuran) throw new Error('Data anggota untuk pinjaman ini tidak ditemukan.');
    const cekAnggotaAngsuran = checkAnggotaAktif(anggotaAngsuran.status);
    if (!cekAnggotaAngsuran.valid) {
      throw new Error(`Pembayaran ditolak: ${cekAnggotaAngsuran.reason}`);
    }

    const sisaPokok = jadwal.pokok - jadwal.pokok_terbayar;
    const sisaJasa = jadwal.jasa - jadwal.jasa_terbayar;

    const hariTerlambat = Math.max(
      0,
      differenceInCalendarDays(new Date(params.tanggal), new Date(jadwal.tanggal_jatuh_tempo))
    );
    const denda = hitungDenda({
      aktif: !!pinjaman.denda_aktif,
      tipe: pinjaman.denda_tipe,
      nilai: pinjaman.denda_nilai,
      sisaTagihan: sisaPokok + sisaJasa,
      hariTerlambat,
    });
    const sisaDenda = Math.max(0, denda - jadwal.denda_terbayar);

    // Phase 7 (AUDIT_INTERNAL.md §3.2 & §7 temuan #3): SEBELUM ini,
    // pembayaran yang melebihi sisa tagihan (pokok+jasa+denda) diam-diam
    // DIPOTONG lewat Math.min() di bawah — kelebihannya "hilang" (tidak
    // dijurnal ke mana pun), sementara kolom angsuran_pembayaran.nominal
    // tetap menyimpan nilai MENTAH (tidak cocok dengan jurnal
    // sungguhan). Sekarang ditolak eksplisit SEBELUM ada write apa pun
    // — user harus bayar persis atau kurang dari outstanding, tidak ada
    // uang yang bisa "menghilang" lagi. Ini juga otomatis membuat
    // porsiPokok+porsiJasa+porsiDenda di bawah SELALU persis sama
    // dengan params.nominal (identity alokasi waterfall), jadi
    // angsuran_pembayaran.nominal dijamin konsisten dengan jurnal.
    const outstanding = sisaPokok + sisaJasa + sisaDenda;
    const cekOutstanding = checkPembayaranTidakMelebihiOutstanding(params.nominal, outstanding);
    if (!cekOutstanding.valid) throw new Error(cekOutstanding.reason);

    // Prioritas alokasi pembayaran: denda -> jasa -> pokok
    let sisaNominal = params.nominal;
    const porsiDenda = Math.min(sisaNominal, sisaDenda);
    sisaNominal -= porsiDenda;
    const porsiJasa = Math.min(sisaNominal, sisaJasa);
    sisaNominal -= porsiJasa;
    const porsiPokok = Math.min(sisaNominal, sisaPokok);

    const kasBankAccountId = await resolveKasBankAccountId(db, params.sumberDana, params.bankAccountId);
    const piutangAccountId = await resolveAccountId(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG');

    const lines: JournalLineInput[] = [{ accountId: kasBankAccountId, debit: porsiPokok + porsiJasa + porsiDenda, kredit: 0 }];
    if (porsiPokok > 0) lines.push({ accountId: piutangAccountId, debit: 0, kredit: porsiPokok });
    if (porsiJasa > 0) {
      // PHASE 2 (§5/§6, permintaan pengguna): porsi jasa yang SUDAH
      // pernah diakru (pinjaman_akuntansi_jasa) mengurangi Piutang
      // Jasa (BUKAN mengakui Pendapatan Jasa lagi — itu akan
      // double-count, sudah diakui saat akrual). Porsi yang BELUM
      // pernah diakru (mis. anggota membayar sebelum batch akrual
      // bulan berjalan dijalankan) tetap diakui langsung ke Pendapatan
      // Jasa seperti SEBELUM Phase 2 — tidak ada income yang hilang
      // atau digandakan.
      //
      // FINAL FIX AKRUAL (permintaan pengguna BUG 4/5/7): KAS DITERIMA
      // != PENDAPATAN EARNED. Kalau angsuran ini dibayar SEBELUM
      // tanggal jatuh temponya, periode jasanya belum berjalan dan
      // menurut kebijakan akrual yang dipakai aplikasi ini (pengakuan
      // per periode yang sudah jatuh tempo, lihat
      // AkrualJasaPinjamanService) jasa tersebut BELUM boleh diakui
      // sebagai pendapatan. Kasnya dibukukan JUJUR sebagai liabilitas
      // "Pendapatan Diterima Dimuka" (akun 2-1300 EXISTING — mekanisme
      // yang SAMA dipakai fee integral pencairan & jasa future
      // pelunasan; TIDAK ada akun/mekanisme akuntansi baru), lalu
      // dilepas menjadi Pendapatan Jasa oleh proses akrual ketika
      // periodenya benar-benar jatuh tempo.
      const jasaSudahJatuhTempo = jadwal.tanggal_jatuh_tempo <= params.tanggal;
      if (!jasaSudahJatuhTempo) {
        const dimukaAccountId = await resolveAccountId(db, 'ANGSURAN_JASA', 'KREDIT_DIMUKA');
        lines.push({
          accountId: dimukaAccountId,
          debit: 0,
          kredit: porsiJasa,
          keterangan: `Jasa angsuran ke-${jadwal.nomor_angsuran} diterima sebelum jatuh tempo (${jadwal.tanggal_jatuh_tempo}) — belum diakui sebagai pendapatan`,
        });
        // Subledger per baris jadwal (migration v48) supaya proses
        // akrual tahu PERSIS berapa yang harus dilepas dari liabilitas
        // saat periode ini jatuh tempo — tidak ada angka yang ditebak.
        await db.runAsync(
          `UPDATE angsuran_jadwal SET jasa_dimuka = jasa_dimuka + ? WHERE id = ?`,
          porsiJasa,
          params.jadwalId
        );
      } else {
        // Sudah jatuh tempo = sudah earned. Porsi yang SUDAH pernah
        // diakru (pinjaman_akuntansi_jasa periode INI — lihat catatan
        // scoping periode di alokasikanPembayaranJasa) mengurangi
        // Piutang Jasa, BUKAN mengakui pendapatan lagi. Sisanya (batch
        // akrual belum sempat jalan) diakui langsung ke Pendapatan Jasa
        // seperti sebelum Phase 2 — tidak ada income yang hilang atau
        // digandakan.
        const periodeJadwal = String(jadwal.tanggal_jatuh_tempo).slice(0, 7);
        const { jasaSudahDiakru, jasaBelumDiakru } = await alokasikanPembayaranJasa(
          db,
          params.pinjamanId,
          porsiJasa,
          periodeJadwal
        );
        if (jasaSudahDiakru > 0) {
          const piutangJasaAccountId = await resolveAccountId(db, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA');
          lines.push({ accountId: piutangJasaAccountId, debit: 0, kredit: jasaSudahDiakru });
          await terapkanPembayaranKePiutangJasa(db, params.pinjamanId, jasaSudahDiakru, periodeJadwal);
        }
        if (jasaBelumDiakru > 0) {
          const jasaAccountId = await resolveAccountId(db, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN');
          lines.push({ accountId: jasaAccountId, debit: 0, kredit: jasaBelumDiakru });
        }
      }
    }
    if (porsiDenda > 0) {
      const dendaAccountId = await resolveAccountId(db, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN');
      lines.push({ accountId: dendaAccountId, debit: 0, kredit: porsiDenda });
    }

    const { journalId } = await createJournal(db, {
      tanggal: params.tanggal,
      sumberTransaksi: 'ANGSURAN_POKOK',
      sumberId: pinjaman.id,
      nomorReferensi: `${pinjaman.nomor_pinjaman}/AGS-${jadwal.nomor_angsuran}`,
      deskripsi: `Pembayaran angsuran ke-${jadwal.nomor_angsuran} - ${pinjaman.nomor_pinjaman}`,
      createdBy: params.createdBy,
      lines,
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO angsuran_pembayaran
        (id, pinjaman_id, jadwal_id, tanggal, nominal, porsi_pokok, porsi_jasa, porsi_denda,
         sumber_dana, bank_account_id, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, params.pinjamanId, params.jadwalId, params.tanggal, params.nominal,
      porsiPokok, porsiJasa, porsiDenda, params.sumberDana, params.bankAccountId ?? null,
      journalId, params.createdBy, now
    );

    const newPokokTerbayar = jadwal.pokok_terbayar + porsiPokok;
    const newJasaTerbayar = jadwal.jasa_terbayar + porsiJasa;
    const newDendaTerbayar = jadwal.denda_terbayar + porsiDenda;
    const lunas = newPokokTerbayar >= jadwal.pokok && newJasaTerbayar >= jadwal.jasa;
    const statusBaru = lunas ? 'LUNAS' : newPokokTerbayar + newJasaTerbayar > 0 ? 'SEBAGIAN' : 'BELUM_BAYAR';

    await db.runAsync(
      `UPDATE angsuran_jadwal
       SET pokok_terbayar = ?, jasa_terbayar = ?, denda_terbayar = ?, denda = ?, status = ?
       WHERE id = ?`,
      newPokokTerbayar, newJasaTerbayar, newDendaTerbayar, denda, statusBaru, params.jadwalId
    );

    // Cek pelunasan seluruh pinjaman
    const belumLunas = await db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM angsuran_jadwal WHERE pinjaman_id = ? AND ${sqlJadwalMasihTertagih('angsuran_jadwal')}`,
      params.pinjamanId
    );
    if ((belumLunas?.cnt ?? 0) === 0) {
      await db.runAsync(`UPDATE pinjaman SET status = 'LUNAS', updated_at = ? WHERE id = ?`, now, params.pinjamanId);

      // ============================================================
      // BUG-03 — FEE INTEGRAL YANG TERSANGKUT PADA PELUNASAN NORMAL
      // ============================================================
      // `lunasiPinjaman()` (pelunasan dipercepat) sudah men-derecognize
      // sisa fee integral, tetapi jalur INI — pinjaman lunas karena
      // angsuran TERAKHIR dibayar seperti biasa — tidak pernah
      // melakukannya. Padahal `prosesEirBulanan()` menolak pinjaman
      // non-AKTIF, sehingga begitu status berubah menjadi LUNAS sisa
      // fee tidak akan pernah bisa diamortisasi lagi: ia mengendap
      // PERMANEN di akun Pendapatan Diterima Dimuka (2-1300).
      //
      // Gejalanya bergantung pada URUTAN: kalau amortisasi periode
      // terakhir kebetulan dijalankan SEBELUM pembayaran terakhir,
      // sisanya lunas (cabang `iniPeriodeTerakhir`); kalau pembayaran
      // duluan, fee tersangkut. Ketergantungan pada urutan seperti itu
      // adalah cacat, bukan kebijakan.
      //
      // Memakai fungsi derecognition yang SUDAH ADA — tidak ada
      // mekanisme akuntansi baru, dan no-op untuk pinjaman non-EIR.
      await deselesaikanFeeEirDiDalamTransaksi(db, {
        pinjamanId: params.pinjamanId,
        tanggal: params.tanggal,
        alasan: 'PELUNASAN_ANGSURAN_TERAKHIR',
        createdBy: params.createdBy,
      });
    }

    return { id, journalId, porsiPokok, porsiJasa, porsiDenda };
}

/**
 * REQUIREMENT 9 (permintaan pengguna) — dua metode perhitungan jasa
 * saat PELUNASAN dipercepat. Nilainya sama persis dengan CHECK
 * constraint kolom `angsuran_pembayaran.metode_jasa_pelunasan`
 * (schema.ts / migration v50).
 */
export type MetodeJasaPelunasan = 'JASA_TERUTANG' | 'JASA_KONTRAKTUAL';

/** Default = perilaku SEBELUM requirement 9 (menagih seluruh jasa kontraktual) — supaya caller lama tidak berubah perilakunya. */
export const METODE_JASA_PELUNASAN_DEFAULT: MetodeJasaPelunasan = 'JASA_KONTRAKTUAL';

function validasiMetodeJasaPelunasan(nilai: MetodeJasaPelunasan | undefined): MetodeJasaPelunasan {
  if (nilai === undefined || nilai === null) return METODE_JASA_PELUNASAN_DEFAULT;
  if (nilai !== 'JASA_TERUTANG' && nilai !== 'JASA_KONTRAKTUAL') {
    throw new Error('Metode pelunasan jasa tidak valid.');
  }
  return nilai;
}

export interface RincianPelunasan {
  pinjamanId: string;
  nomorPinjaman: string;
  pokokTersisa: Rupiah;
  jasaTerutang: Rupiah;
  denda: Rupiah;
  /** PHASE 4 (permintaan pengguna §A/§C): biaya penalti pelunasan dipercepat — 0 kalau tidak diisi/tidak berlaku. */
  penaltiPelunasan: Rupiah;
  /** PHASE 4 (permintaan pengguna §A/§C): biaya administrasi pelunasan dipercepat — 0 kalau tidak diisi/tidak berlaku. */
  administrasiPelunasan: Rupiah;
  /**
   * PHASE 4 FINAL CHECK (permintaan pengguna) — porsi `jasaTerutang`
   * yang periodenya SUDAH jatuh tempo pada `tanggal` settlement
   * (waktu SUDAH berlalu — layak diakui sebagai Pendapatan Jasa
   * Pinjaman, entah sudah diakru lewat batch bulanan atau belum).
   */
  jasaSudahJatuhTempo: Rupiah;
  /**
   * PHASE 4 FINAL CHECK (permintaan pengguna) — porsi `jasaTerutang`
   * yang periodenya BELUM jatuh tempo sama sekali pada `tanggal`
   * settlement (murni kontraktual masa depan — TIDAK ADA waktu yang
   * berlalu untuk diakui sebagai pendapatan bunga/jasa biasa). TETAP
   * bagian dari `totalPelunasan` (kontrak FLAT tanpa rabat tetap
   * mewajibkan anggota membayarnya) — TAPI `lunasiPinjaman()` TIDAK
   * mengkreditkannya ke Pendapatan Jasa Pinjaman MAUPUN ke Pendapatan
   * Penalti/Administrasi Pelunasan (KOREKSI: draft sebelumnya sempat
   * salah mengklasifikasikannya sebagai penalti — itu TIDAK VALID,
   * penalti hanya sah kalau memang penalti kontraktual). Dibukukan
   * sebagai Pendapatan Diterima Dimuka (liabilitas, PENDING_EIR_ACCOUNTING)
   * sampai pengukuran biaya perolehan diamortisasi/EIR penuh (SAK EP
   * Bab 11, belum dibangun) menentukan pengakuan yang benar.
   */
  jasaFuture: Rupiah;
  /**
   * FINAL FIX AKRUAL (permintaan pengguna BUG 14) — porsi
   * `jasaSudahJatuhTempo` yang SUDAH diakui sebagai pendapatan lewat
   * akrual bulanan dan masih berdiri sebagai Piutang Jasa di GL
   * (pinjaman_akuntansi_jasa). Saat pelunasan, porsi ini HANYA
   * mengurangi Piutang Jasa — BUKAN pendapatan baru.
   */
  jasaSudahDiakru: Rupiah;
  /**
   * FINAL FIX AKRUAL (permintaan pengguna BUG 14) — porsi
   * `jasaSudahJatuhTempo` yang periodenya sudah lewat tetapi BELUM
   * sempat diakru batch bulanan. Ini satu-satunya porsi jasa yang
   * benar-benar menjadi Pendapatan Jasa baru saat pelunasan.
   * jasaSudahDiakru + jasaJatuhTempoBelumDiakru = jasaSudahJatuhTempo.
   */
  jasaJatuhTempoBelumDiakru: Rupiah;
  /**
   * REQUIREMENT 9 (permintaan pengguna) — metode perhitungan jasa yang
   * dipakai menghasilkan `totalPelunasan` di bawah:
   *   'JASA_KONTRAKTUAL' (DEFAULT, perilaku lama persis) — seluruh sisa
   *      jasa sesuai kontrak ditagih (= `jasaTerutang`).
   *   'JASA_TERUTANG' — hanya jasa yang periodenya SUDAH jatuh tempo
   *      pada `tanggal` settlement yang ditagih (= `jasaSudahJatuhTempo`);
   *      sisanya dirabat.
   */
  metodeJasaPelunasan: MetodeJasaPelunasan;
  /**
   * REQUIREMENT 9 — jasa yang BENAR-BENAR DITAGIH sesuai metode terpilih.
   * JASA_KONTRAKTUAL -> = jasaTerutang. JASA_TERUTANG -> = jasaSudahJatuhTempo.
   * INI yang masuk `totalPelunasan`, bukan `jasaTerutang` mentah.
   */
  jasaDitagih: Rupiah;
  /**
   * REQUIREMENT 9 — jasa kontraktual yang TIDAK ditagih (rabat) akibat
   * memilih JASA_TERUTANG. 0 untuk metode kontraktual.
   * jasaDitagih + rabatJasa === jasaTerutang, SELALU.
   *
   * Rabat ini TIDAK menimbulkan jurnal apa pun: jasa masa depan memang
   * belum pernah diakui sebagai pendapatan maupun sebagai piutang di GL
   * (lihat jasaFuture) — jadi tidak ada aset/pendapatan yang perlu
   * dihapus. Hanya dicatat sebagai jejak audit di `angsuran_pembayaran`.
   */
  rabatJasa: Rupiah;
  totalPelunasan: Rupiah;
  jumlahAngsuranTersisa: number;
}

/**
 * PHASE 4 (§B, permintaan pengguna): validasi backend untuk
 * penalti/administrasi pelunasan — TIDAK PERNAH mempercayai angka
 * dari frontend begitu saja (dipanggil ULANG di sini terlepas dari
 * validasi apa pun yang sudah dilakukan UI). Uang di aplikasi ini
 * SELALU INTEGER Rupiah penuh (PRD §40, lihat komentar schema.ts) —
 * jadi bukan cuma "\>= 0 dan finite", tapi juga harus bilangan bulat;
 * NaN/Infinity/desimal/negatif semuanya ditolak eksplisit di sini,
 * bukan cuma di layer UI.
 */
function validasiNominalPelunasanTambahan(nilai: number | undefined, label: string): Rupiah {
  if (nilai === undefined || nilai === null) return 0;
  if (typeof nilai !== 'number' || Number.isNaN(nilai) || !Number.isFinite(nilai)) {
    throw new Error(`${label} tidak valid.`);
  }
  if (!Number.isInteger(nilai)) {
    throw new Error(`${label} harus berupa nilai Rupiah bulat (tanpa desimal).`);
  }
  if (nilai < 0) {
    throw new Error(`${label} tidak boleh negatif.`);
  }
  return nilai;
}

/**
 * Hitung rincian TOTAL PELUNASAN pinjaman (§6, permintaan pengguna) —
 * MURNI PERHITUNGAN, TIDAK menulis apa pun ke database. Dipakai UI
 * untuk menampilkan preview (Pokok Tersisa/Jasa Terutang/Denda/Total)
 * SEBELUM user menekan tombol "Lunasi", dan dipakai ULANG oleh
 * `lunasiPinjaman()` di bawah supaya angka yang DITAMPILKAN & angka
 * yang SUNGGUHAN DITAGIH selalu identik (satu sumber kebenaran, tidak
 * ada rumus kedua yang bisa berbeda hasil).
 *
 * Menjumlahkan SEMUA angsuran_jadwal yang belum LUNAS untuk pinjaman
 * ini (bukan cuma satu angsuran seperti `bayarAngsuran`) — jasa &
 * denda dihitung dengan fungsi yang SAMA PERSIS dipakai
 * `bayarAngsuran()` (`hitungDenda`, `differenceInCalendarDays`) per
 * baris jadwal, TIDAK ADA rumus baru yang dikarang. Jasa MASA DEPAN
 * (angsuran yang jatuh temponya belum lewat & belum jadi kewajiban)
 * TIDAK ikut ditagih di sini — jasa/denda yang dihitung PERSIS jasa &
 * denda milik jadwal yang SUDAH ada (accrual per-periode existing,
 * bukan proyeksi ke depan).
 *
 * PHASE 4 (§A/§B/§C, permintaan pengguna): tambahan opsional
 * `penaltiPelunasan`/`administrasiPelunasan` — dua biaya PISAH dari
 * pokok/jasa/denda kontraktual, ditambahkan APA ADANYA ke total
 * (bukan dihitung ulang dari kontrak, itu memang murni keputusan
 * pengurus/nilai yang diinput saat transaksi) tapi TETAP divalidasi
 * server-side (lihat validasiNominalPelunasanTambahan) — TIDAK PERNAH
 * dipercaya mentah-mentah dari opts tanpa validasi ulang di sini.
 */
export async function hitungTotalPelunasan(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  tanggal: string,
  opts: {
    penaltiPelunasan?: number;
    administrasiPelunasan?: number;
    /** REQUIREMENT 9 — default 'JASA_KONTRAKTUAL' (perilaku lama). */
    metodeJasaPelunasan?: MetodeJasaPelunasan;
  } = {}
): Promise<RincianPelunasan> {
  const penaltiPelunasan = validasiNominalPelunasanTambahan(opts.penaltiPelunasan, 'Biaya Penalti Pelunasan');
  const administrasiPelunasan = validasiNominalPelunasanTambahan(opts.administrasiPelunasan, 'Biaya Administrasi Pelunasan');
  // REQUIREMENT 9: divalidasi server-side, TIDAK dipercaya mentah dari
  // UI — pola sama dengan validasiNominalPelunasanTambahan di atas.
  const metodeJasaPelunasan = validasiMetodeJasaPelunasan(opts.metodeJasaPelunasan);

  const pinjaman = await db.getFirstAsync<any>('SELECT * FROM pinjaman WHERE id = ?', pinjamanId);
  if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');

  const rows = await db.getAllAsync<any>(
    `SELECT * FROM angsuran_jadwal WHERE pinjaman_id = ? AND ${sqlJadwalMasihTertagih('angsuran_jadwal')} ORDER BY nomor_angsuran ASC`,
    pinjamanId
  );

  let totalPokok = 0;
  let totalJasa = 0;
  let totalDenda = 0;
  // PHASE 4 FINAL CHECK (permintaan pengguna) — pisahkan jasa yang
  // periodenya SUDAH jatuh tempo (waktu sudah berlalu, secara accrual
  // benar-benar sudah menjadi hak koperasi — entah sudah diakru lewat
  // batch bulanan atau belum) dari jasa yang periodenya BELUM jatuh
  // tempo sama sekali pada tanggal settlement (murni kontraktual masa
  // depan, TIDAK ADA waktu yang berlalu untuk "diakru"). `totalJasa`
  // (dipakai UI & total kontraktual) TETAP MENCAKUP KEDUANYA (kontrak
  // tetap mewajibkan bayar penuh untuk metode FLAT tanpa rabat —
  // "Jangan mengubah contractual total" per instruksi) — split ini
  // HANYA dipakai lunasiPinjaman() di bawah untuk menentukan akun
  // KREDIT yang benar secara akuntansi, bukan untuk mengubah angka
  // yang ditagih ke anggota.
  let jasaSudahJatuhTempo = 0;
  for (const jadwal of rows) {
    const sisaPokok = jadwal.pokok - jadwal.pokok_terbayar;
    const sisaJasa = jadwal.jasa - jadwal.jasa_terbayar;
    const hariTerlambat = Math.max(0, differenceInCalendarDays(new Date(tanggal), new Date(jadwal.tanggal_jatuh_tempo)));
    const denda = hitungDenda({
      aktif: !!pinjaman.denda_aktif,
      tipe: pinjaman.denda_tipe,
      nilai: pinjaman.denda_nilai,
      sisaTagihan: sisaPokok + sisaJasa,
      hariTerlambat,
    });
    const sisaDenda = Math.max(0, denda - jadwal.denda_terbayar);
    totalPokok += sisaPokok;
    totalJasa += sisaJasa;
    totalDenda += sisaDenda;
    if (new Date(jadwal.tanggal_jatuh_tempo) <= new Date(tanggal)) {
      jasaSudahJatuhTempo += sisaJasa;
    }
  }
  const jasaFuture = Math.max(0, totalJasa - jasaSudahJatuhTempo);
  // BUG 14: pisahkan TIGA komponen jasa secara eksplisit di SATU
  // tempat (bukan dihitung ulang dengan rumus lain di lunasiPinjaman),
  // supaya "masuk total pelunasan" tidak pernah tertukar dengan
  // "pendapatan akuntansi". Sumber angkanya adalah subledger akrual
  // yang SUDAH ADA (pinjaman_akuntansi_jasa), bukan SUM jadwal mentah.
  const outstandingPiutangJasa = await hitungOutstandingPiutangJasa(db, pinjamanId);
  const jasaSudahDiakru = Math.min(jasaSudahJatuhTempo, outstandingPiutangJasa);
  const jasaJatuhTempoBelumDiakru = Math.max(0, jasaSudahJatuhTempo - jasaSudahDiakru);

  const rincianTanpaBiaya: RincianPelunasan = {
    pinjamanId,
    nomorPinjaman: pinjaman.nomor_pinjaman,
    pokokTersisa: totalPokok,
    jasaTerutang: totalJasa,
    denda: totalDenda,
    penaltiPelunasan: 0,
    administrasiPelunasan: 0,
    jasaSudahJatuhTempo,
    jasaFuture,
    jasaSudahDiakru,
    jasaJatuhTempoBelumDiakru,
    metodeJasaPelunasan,
    // REQUIREMENT 9 — porsi jasa yang ditagih sesuai metode terpilih.
    // JASA_TERUTANG memakai `jasaSudahJatuhTempo` yang SUDAH dihitung
    // di loop di atas (definisi "earned/jatuh tempo" yang SAMA dipakai
    // lunasiPinjaman untuk menentukan akun kredit) — TIDAK ADA definisi
    // "jasa terutang" kedua di aplikasi ini.
    jasaDitagih: metodeJasaPelunasan === 'JASA_TERUTANG' ? jasaSudahJatuhTempo : totalJasa,
    rabatJasa: metodeJasaPelunasan === 'JASA_TERUTANG' ? jasaFuture : 0,
    // §C: total kontraktual = pokok + SELURUH jasa kontraktual pada
    // jadwal yang belum lunas (termasuk periode yang belum jatuh
    // tempo, KALAU kontrak FLAT tanpa rabat memang mewajibkannya —
    // BUSINESS LOGIC EXISTING, TIDAK diubah) + denda + penalti +
    // administrasi. KLASIFIKASI AKUNTANSI atas komponen ini (mana yang
    // masuk Pendapatan Jasa vs tidak) ditentukan terpisah oleh
    // lunasiPinjaman() lewat jasaSudahJatuhTempo/jasaFuture di atas —
    // "masuk total pelunasan" TIDAK otomatis berarti "pendapatan
    // akuntansi", persis seperti diminta.
    // REQUIREMENT 9: komponen jasa dalam total SEKARANG bergantung pada
    // metode terpilih (`jasaDitagih`), BUKAN selalu `totalJasa`.
    // JASA_KONTRAKTUAL menghasilkan angka yang IDENTIK dengan sebelum
    // requirement ini (jasaDitagih === totalJasa) — tidak ada regresi.
    totalPelunasan:
      totalPokok + (metodeJasaPelunasan === 'JASA_TERUTANG' ? jasaSudahJatuhTempo : totalJasa) + totalDenda,
    jumlahAngsuranTersisa: rows.length,
  };

  // SATU formula komposisi total — dipakai fungsi ini MAUPUN UI
  // (lihat terapkanBiayaTambahanPelunasan). Tidak ada rumus kedua.
  return terapkanBiayaTambahanPelunasan(rincianTanpaBiaya, penaltiPelunasan, administrasiPelunasan);
}

/**
 * REQUIREMENT 8 (permintaan pengguna) — komposisi TOTAL PELUNASAN dari
 * rincian dasar + biaya penalti/administrasi. Fungsi MURNI (tanpa I/O,
 * tanpa akses database) dan SATU-SATUNYA tempat rumus total pelunasan
 * ditulis: `hitungTotalPelunasan()` di atas memanggilnya untuk hasil
 * akhirnya sendiri, dan layar "Bayar Piutang Anggota" memanggilnya
 * untuk memperbarui preview saat petugas mengetik nominal biaya.
 *
 * INI yang menghilangkan akar masalah bug input pada requirement 8:
 * sebelumnya setiap ketukan tombol memicu `hitungTotalPelunasan()` —
 * query database asinkron — yang menyalakan state `loading` sehingga
 * kartu pelunasan (BESERTA kedua input di dalamnya) di-unmount lalu
 * di-mount ulang, membuang fokus & isi kursor. Padahal penalti dan
 * administrasi TIDAK BERGANTUNG PADA DATA APA PUN DI DATABASE — dua
 * angka itu murni ditambahkan ke total. Jadi tidak pernah ada alasan
 * memanggil database saat mengetiknya.
 *
 * Nilai tetap DIVALIDASI di sini (bukan cuma di UI), dan
 * `lunasiPinjaman()` TETAP menghitung ulang seluruhnya dari database di
 * dalam transaksinya sendiri — angka dari layar tidak pernah dipercaya.
 */
export function terapkanBiayaTambahanPelunasan(
  rincian: RincianPelunasan,
  penaltiPelunasan?: number,
  administrasiPelunasan?: number
): RincianPelunasan {
  const penalti = validasiNominalPelunasanTambahan(penaltiPelunasan, 'Biaya Penalti Pelunasan');
  const administrasi = validasiNominalPelunasanTambahan(administrasiPelunasan, 'Biaya Administrasi Pelunasan');
  return {
    ...rincian,
    penaltiPelunasan: penalti,
    administrasiPelunasan: administrasi,
    totalPelunasan:
      rincian.pokokTersisa + rincian.jasaDitagih + rincian.denda + penalti + administrasi,
  };
}

/**
 * Pelunasan Piutang Anggota (§6, permintaan pengguna) — melunasi
 * SELURUH kewajiban pinjaman (semua angsuran yang belum LUNAS) dalam
 * SATU transaksi pembayaran (satu jurnal + SATU baris `angsuran_pembayaran`
 * konsolidasi), bukan per-angsuran seperti `bayarAngsuran()`.
 *
 * WAJIB lewat accounting engine existing (`createJournal`, SAMA
 * PERSIS dipakai `bayarAngsuran`) — TIDAK ADA SQL jurnal langsung.
 * Nominal & rincian pokok/jasa/denda dihitung SEKALI lewat
 * `hitungTotalPelunasan()` di atas (dipanggil di dalam transaksi DB
 * yang sama, jadi dijamin konsisten dengan apa pun yang ditampilkan
 * UI sesaat sebelumnya — tidak ada celah waktu untuk race condition
 * mengubah outstanding di antara "lihat total" dan "submit").
 *
 * ATOMICITY & DOUBLE-PAYMENT PROTECTION: seluruh operasi (1 jurnal +
 * 1 baris `angsuran_pembayaran` konsolidasi + update N baris
 * `angsuran_jadwal` + update status `pinjaman`) terjadi di DALAM SATU
 * `withTransaction()` — kalau ada satu langkah gagal, SEMUANYA
 * rollback (tidak ada pembayaran "setengah jalan"). Outstanding DICEK
 * ULANG di awal fungsi ini (query `angsuran_jadwal` yang belum LUNAS)
 * — kalau kosong (mis. sudah dilunasi oleh klik sebelumnya), transaksi
 * DITOLAK di sini, bukan cuma diasumsikan aman dari tombol UI yang
 * di-disable saja.
 */
export async function lunasiPinjaman(params: {
  pinjamanId: string;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  createdBy: string;
  /** PHASE 4 (§A, permintaan pengguna): opsional — 0 kalau tidak diisi. Divalidasi ULANG server-side (§B), TIDAK dipercaya mentah dari UI. */
  penaltiPelunasan?: number;
  /** PHASE 4 (§A, permintaan pengguna): opsional — 0 kalau tidak diisi. Divalidasi ULANG server-side (§B), TIDAK dipercaya mentah dari UI. */
  administrasiPelunasan?: number;
  /**
   * REQUIREMENT 9 (permintaan pengguna): 'JASA_TERUTANG' (hanya jasa
   * yang sudah jatuh tempo) atau 'JASA_KONTRAKTUAL' (seluruh sisa jasa
   * kontrak). Opsional; default 'JASA_KONTRAKTUAL' = perilaku persis
   * sebelum requirement ini. Divalidasi ULANG server-side.
   */
  metodeJasaPelunasan?: MetodeJasaPelunasan;
}): Promise<{
  journalId: string;
  totalPelunasan: Rupiah;
  porsiPokok: Rupiah;
  porsiJasa: Rupiah;
  porsiDenda: Rupiah;
  porsiPenalti: Rupiah;
  porsiAdministrasi: Rupiah;
  /** REQUIREMENT 9 — metode jasa yang benar-benar dipakai backend (bukan yang dikirim UI). */
  metodeJasaPelunasan: MetodeJasaPelunasan;
  /** REQUIREMENT 9 — jasa kontraktual yang dirabat (tidak ditagih). 0 untuk JASA_KONTRAKTUAL. */
  rabatJasa: Rupiah;
  /** PHASE 4 KOREKSI FINAL (permintaan pengguna) — bagian dari `porsiJasa` yang periodenya belum jatuh tempo, dibukukan sebagai Pendapatan Diterima Dimuka (PENDING_EIR_ACCOUNTING) — BUKAN pendapatan penalti, BUKAN pendapatan jasa. Lihat komentar di badan fungsi. */
  jasaFuturePendingEirAccounting: Rupiah;
  /** PHASE 7 FINAL FIX (permintaan pengguna §1) — sisa fee integral (EIR) yang diselesaikan otomatis saat pelunasan ini. 0 kalau pinjaman ini bukan pinjaman ber-EIR. */
  eirFeeDiselesaikan: Rupiah;
}> {
  return withTransaction(async (db) => {
    await requirePermission(db, params.createdBy, 'pinjaman', 'create');

    const pinjaman = await db.getFirstAsync<any>('SELECT * FROM pinjaman WHERE id = ?', params.pinjamanId);
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    if (pinjaman.status === 'LUNAS') throw new Error('Pinjaman ini sudah lunas.');
    if (pinjaman.status !== 'AKTIF') {
      throw new Error(`Pinjaman berstatus "${pinjaman.status}" tidak dapat dilunasi.`);
    }

    // Pola sama persis bayarAngsuran(): re-check status anggota tepat
    // sebelum transaksi finansial.
    const anggotaRow = await db.getFirstAsync<{ status: string }>('SELECT status FROM anggota WHERE id = ?', pinjaman.anggota_id);
    if (!anggotaRow) throw new Error('Data anggota untuk pinjaman ini tidak ditemukan.');
    const cekAnggota = checkAnggotaAktif(anggotaRow.status);
    if (!cekAnggota.valid) {
      throw new Error(`Pelunasan ditolak: ${cekAnggota.reason}`);
    }

    // DOUBLE-PAYMENT PROTECTION: cek ulang outstanding DI DALAM
    // transaksi ini (bukan mengandalkan data yang mungkin sudah basi
    // dari layar sebelumnya) — kalau tidak ada jadwal tersisa yang
    // belum LUNAS, berarti pinjaman ini SUDAH dilunasi (mis. oleh
    // klik ganda yang keduanya sempat terkirim), tolak transaksi kedua.
    const rows = await db.getAllAsync<any>(
      `SELECT * FROM angsuran_jadwal WHERE pinjaman_id = ? AND ${sqlJadwalMasihTertagih('angsuran_jadwal')} ORDER BY nomor_angsuran ASC`,
      params.pinjamanId
    );
    if (rows.length === 0) {
      throw new Error('Pinjaman ini sudah lunas.');
    }

    // §B: hitungTotalPelunasan MEVALIDASI ULANG penalti/administrasi
    // di dalamnya (validasiNominalPelunasanTambahan) — dipanggil DI
    // DALAM transaksi ini yang sama, bukan mempercayai `totalPelunasan`
    // apa pun yang mungkin dikirim UI; backend SELALU menghitung ulang.
    const rincian = await hitungTotalPelunasan(db, params.pinjamanId, params.tanggal, {
      penaltiPelunasan: params.penaltiPelunasan,
      administrasiPelunasan: params.administrasiPelunasan,
      // REQUIREMENT 9: metode dari UI ikut dihitung ULANG di sini, di
      // dalam transaksi yang sama — angka yang ditagih tidak pernah
      // diambil dari frontend.
      metodeJasaPelunasan: params.metodeJasaPelunasan,
    });
    if (rincian.totalPelunasan <= 0) {
      throw new Error('Tidak ada kewajiban yang perlu dilunasi.');
    }

    const kasBankAccountId = await resolveKasBankAccountId(db, params.sumberDana, params.bankAccountId);
    const piutangAccountId = await resolveAccountId(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG');

    // Jurnal KONSOLIDASI — satu jurnal untuk seluruh pelunasan, bukan
    // satu jurnal per angsuran (§6: "SATU transaksi pembayaran").
    // BUG-09: nominal yang benar-benar dikreditkan ke 2-1300 pada
    // jurnal pelunasan ini — dipakai sebagai pembanding invarian
    // terhadap total yang ditulis ke subledger `jasa_dimuka` di bawah.
    let jasaFutureDibukukan = 0;
    let totalFutureKeSubledger = 0;

    const lines: JournalLineInput[] = [
      { accountId: kasBankAccountId, debit: rincian.totalPelunasan, kredit: 0 },
    ];
    if (rincian.pokokTersisa > 0) lines.push({ accountId: piutangAccountId, debit: 0, kredit: rincian.pokokTersisa });
    if (rincian.jasaDitagih > 0) {
      // PHASE 4 KOREKSI FINAL (permintaan pengguna) — jasa yang
      // dibayar di settlement dipisah TIGA arah secara akuntansi:
      //  1. jasaSudahDiakru: sudah diakui via akrual bulanan (Phase 2)
      //     -> Cr Piutang Jasa (mengurangi aset yang sudah tercatat).
      //  2. jasaJatuhTempoBelumDiakru: periodenya SUDAH lewat/jatuh
      //     tempo per tanggal settlement, tapi belum sempat diakru
      //     lewat batch bulanan -> waktu SUDAH berlalu, ini secara sah
      //     sudah menjadi hak koperasi -> Cr Pendapatan Jasa Pinjaman
      //     (SAMA seperti "bayar sebelum akrual" di bayarAngsuran()).
      //  3. jasaFuture: periodenya BELUM jatuh tempo SAMA SEKALI pada
      //     tanggal settlement (tidak ada waktu yang berlalu). KOREKSI
      //     dari draft sebelumnya: BUKAN direklasifikasi ke Pendapatan
      //     Penalti — itu SALAH, klasifikasi penalti hanya sah kalau
      //     memang penalti berdasarkan kontrak/policy, bukan sekadar
      //     karena nominalnya "future". Nominal ini TETAP bagian dari
      //     total yang ditagih (kontrak FLAT tanpa rabat tidak diubah,
      //     lihat `rincian.jasaFuture`/`totalPelunasan`), TAPI
      //     pengakuannya sebagai PENDAPATAN memerlukan pengukuran
      //     biaya perolehan diamortisasi/EIR penuh (SAK EP Bab 11)
      //     yang BELUM dibangun — bukan wewenang fungsi ini untuk
      //     memutuskan sepihak. Kas yang diterima untuk porsi ini
      //     DIBUKUKAN JUJUR sebagai liabilitas "Pendapatan Diterima
      //     Dimuka" (akun 2-1300 EXISTING, reuse — BUKAN akun revenue
      //     baru yang dikarang) sampai Phase EIR menentukan pengakuan
      //     yang benar — PENDING_EIR_ACCOUNTING, bukan jurnal palsu.
      // BUG 14: pemisahan dihitung SEKALI di hitungTotalPelunasan
      // (dipanggil di transaksi yang sama, beberapa baris di atas) —
      // TIDAK dihitung ulang di sini supaya tidak ada rumus kedua yang
      // bisa berbeda hasil dari angka yang ditampilkan UI.
      const jasaSudahDiakru = rincian.jasaSudahDiakru;
      const jasaJatuhTempoBelumDiakru = rincian.jasaJatuhTempoBelumDiakru;
      // REQUIREMENT 9: pada metode 'JASA_TERUTANG', jasa masa depan
      // TIDAK ditagih sama sekali (dirabat) — jadi TIDAK ADA kas yang
      // diterima untuknya dan TIDAK BOLEH ada baris Pendapatan Diterima
      // Dimuka. Membiarkan baris ini ada akan membuat jurnal TIDAK
      // BALANCE (kredit > debit kas). Pada 'JASA_KONTRAKTUAL' perilaku
      // tetap persis seperti sebelumnya.
      jasaFutureDibukukan = rincian.metodeJasaPelunasan === 'JASA_TERUTANG' ? 0 : rincian.jasaFuture;
      const jasaFuturePendingEir = jasaFutureDibukukan;

      if (jasaSudahDiakru > 0) {
        const piutangJasaAccountId = await resolveAccountId(db, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA');
        lines.push({ accountId: piutangJasaAccountId, debit: 0, kredit: jasaSudahDiakru });
        await terapkanPembayaranKePiutangJasa(db, params.pinjamanId, jasaSudahDiakru);
      }
      if (jasaJatuhTempoBelumDiakru > 0) {
        const jasaAccountId = await resolveAccountId(db, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN');
        lines.push({ accountId: jasaAccountId, debit: 0, kredit: jasaJatuhTempoBelumDiakru });
      }
      if (jasaFuturePendingEir > 0) {
        const dimukaAccountId = await resolveAccountId(db, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA');
        lines.push({
          accountId: dimukaAccountId,
          debit: 0,
          kredit: jasaFuturePendingEir,
          keterangan: 'PENDING_EIR_ACCOUNTING — jasa kontraktual periode belum jatuh tempo, tetap ditagih (kontrak FLAT tanpa rabat) tapi BELUM diakui sebagai pendapatan sampai pengukuran EIR tersedia',
        });
      }
    }
    if (rincian.denda > 0) {
      const dendaAccountId = await resolveAccountId(db, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN');
      lines.push({ accountId: dendaAccountId, debit: 0, kredit: rincian.denda });
    }
    // PHASE 4 (§A/§D, permintaan pengguna): mapping COA existing dari
    // Phase 1 (4-1150/4-1160) — TIDAK dicampur dengan Pendapatan Jasa
    // Pinjaman atau Pendapatan Administrasi pencairan (4-1100).
    if (rincian.penaltiPelunasan > 0) {
      const penaltiAccountId = await resolveAccountId(db, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN');
      lines.push({ accountId: penaltiAccountId, debit: 0, kredit: rincian.penaltiPelunasan });
    }
    if (rincian.administrasiPelunasan > 0) {
      const administrasiAccountId = await resolveAccountId(db, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN');
      lines.push({ accountId: administrasiAccountId, debit: 0, kredit: rincian.administrasiPelunasan });
    }

    const { journalId } = await createJournal(db, {
      tanggal: params.tanggal,
      sumberTransaksi: 'ANGSURAN_POKOK',
      sumberId: pinjaman.id,
      nomorReferensi: `${pinjaman.nomor_pinjaman}/LUNAS`,
      deskripsi:
        rincian.rabatJasa > 0
          ? `Pelunasan pinjaman ${pinjaman.nomor_pinjaman} (metode Jasa Terutang — rabat jasa kontraktual belum jatuh tempo ${rincian.rabatJasa})`
          : `Pelunasan pinjaman ${pinjaman.nomor_pinjaman}`,
      createdBy: params.createdBy,
      lines,
    });

    const now = new Date().toISOString();

    // SATU baris angsuran_pembayaran KONSOLIDASI untuk seluruh
    // pelunasan (bukan satu baris per jadwal) — supaya "Bukti Bayar
    // Utang" ralat maksud, maksudnya "Bukti Bayar Piutang Anggota"
    // (mekanisme existing, TIDAK dibuat sistem bukti baru) menampilkan
    // TEPAT SATU bukti dengan total pokok/jasa/denda gabungan, sesuai
    // instruksi "Detail bukti harus menunjukkan: ... pokok, jasa,
    // denda, total pelunasan" (nilai tunggal, bukan pecahan per
    // angsuran). `jadwal_id` NULL (kolom ini memang nullable) karena
    // satu baris ini merepresentasikan SELURUH sisa jadwal, bukan
    // satu angsuran tertentu.
    const pembayaranId = newId();
    await db.runAsync(
      `INSERT INTO angsuran_pembayaran
        (id, pinjaman_id, jadwal_id, tanggal, nominal, porsi_pokok, porsi_jasa, porsi_denda,
         sumber_dana, bank_account_id, journal_id, created_by, created_at,
         metode_jasa_pelunasan, rabat_jasa_pelunasan)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pembayaranId, params.pinjamanId, params.tanggal, rincian.totalPelunasan,
      // REQUIREMENT 9: porsi_jasa = jasa yang BENAR-BENAR DITERIMA
      // (`jasaDitagih`), BUKAN jasa kontraktual penuh — kalau tetap
      // memakai `jasaTerutang`, bukti bayar & rekap penerimaan akan
      // mengklaim uang yang tidak pernah masuk, dan
      // porsi_pokok+porsi_jasa+porsi_denda tidak akan sama dengan
      // `nominal`.
      rincian.pokokTersisa, rincian.jasaDitagih, rincian.denda,
      params.sumberDana, params.bankAccountId ?? null,
      journalId, params.createdBy, now,
      rincian.metodeJasaPelunasan, rincian.rabatJasa
    );

    // Tiap baris angsuran_jadwal yang masih outstanding TETAP di-update
    // satu per satu (pokok_terbayar/jasa_terbayar/denda/status) —
    // histori per-angsuran harus akurat walau pembayarannya digabung
    // jadi satu bukti.
    for (const jadwal of rows) {
      const sisaPokok = jadwal.pokok - jadwal.pokok_terbayar;
      const sisaJasa = jadwal.jasa - jadwal.jasa_terbayar;
      const hariTerlambat = Math.max(0, differenceInCalendarDays(new Date(params.tanggal), new Date(jadwal.tanggal_jatuh_tempo)));
      const dendaBaris = hitungDenda({
        aktif: !!pinjaman.denda_aktif,
        tipe: pinjaman.denda_tipe,
        nilai: pinjaman.denda_nilai,
        sisaTagihan: sisaPokok + sisaJasa,
        hariTerlambat,
      });
      const sisaDenda = Math.max(0, dendaBaris - jadwal.denda_terbayar);

      // REQUIREMENT 9 — porsi jasa yang DITANDAI TERBAYAR pada baris ini
      // harus mencerminkan uang yang benar-benar diterima:
      //  - JASA_KONTRAKTUAL: seluruh sisa jasa ditagih -> jasa_terbayar = jasa
      //    (perilaku lama, tidak berubah).
      //  - JASA_TERUTANG: baris yang periodenya SUDAH jatuh tempo ditagih
      //    penuh; baris yang BELUM jatuh tempo TIDAK ditagih sama sekali,
      //    jadi `jasa_terbayar` dibiarkan apa adanya. Kolom `jasa`
      //    (nilai KONTRAKTUAL) SENGAJA TIDAK diturunkan/ditulis ulang —
      //    histori jadwal tidak boleh diubah demi merapikan tampilan;
      //    selisihnya adalah rabat yang sudah tercatat eksplisit di
      //    `angsuran_pembayaran.rabat_jasa_pelunasan`.
      // Status tetap 'LUNAS' pada kedua metode: kewajiban baris ini
      // memang sudah selesai (dilunasi atau dirabat), dan tanpa itu
      // pinjaman tidak akan pernah bisa berstatus LUNAS.
      const jatuhTempoSudahLewat = new Date(jadwal.tanggal_jatuh_tempo) <= new Date(params.tanggal);
      const jasaTerbayarBaru =
        rincian.metodeJasaPelunasan === 'JASA_KONTRAKTUAL' || jatuhTempoSudahLewat
          ? jadwal.jasa
          : jadwal.jasa_terbayar;

      // ============================================================
      // BUG-09 — SUBLEDGER PENDAPATAN DITERIMA DIMUKA PER BARIS JADWAL
      // ============================================================
      // Jurnal pelunasan mengkredit akun 2-1300 untuk porsi jasa yang
      // KASNYA sudah diterima tetapi periodenya BELUM jatuh tempo.
      // Sebelum perbaikan ini, nominal tersebut hanya ada di GL —
      // `angsuran_jadwal.jasa_dimuka` tidak pernah diisi, sehingga
      // mesin akrual tidak punya catatan berapa yang harus dilepas dan
      // saldo liabilitas itu mengendap PERMANEN.
      //
      // Dicatat PER BARIS (bukan ditumpuk di satu baris) supaya
      // pelepasannya bisa mengikuti tanggal jatuh tempo masing-masing
      // angsuran — itulah inti kebijakan Opsi B: jasa futura tetap
      // deferred dan diakui bulan demi bulan sesuai periode jasanya.
      //
      // Hanya berlaku untuk JASA_KONTRAKTUAL. Pada JASA_TERUTANG jasa
      // masa depan DIRABAT (tidak ditagih), jadi tidak ada kas yang
      // diterima dan tidak boleh ada deferred income sama sekali.
      const porsiFutureBaris =
        rincian.metodeJasaPelunasan === 'JASA_KONTRAKTUAL' && !jatuhTempoSudahLewat
          ? Math.max(0, jadwal.jasa - jadwal.jasa_terbayar)
          : 0;
      totalFutureKeSubledger += porsiFutureBaris;

      await db.runAsync(
        `UPDATE angsuran_jadwal
         SET pokok_terbayar = pokok, jasa_terbayar = ?, denda_terbayar = ?, denda = ?,
             jasa_dimuka = jasa_dimuka + ?, status = 'LUNAS'
         WHERE id = ?`,
        jasaTerbayarBaru,
        jadwal.denda_terbayar + sisaDenda,
        dendaBaris,
        porsiFutureBaris,
        jadwal.id
      );
    }

    // INVARIAN SUBLEDGER = GL. Jumlah yang ditulis ke `jasa_dimuka`
    // WAJIB sama persis dengan nominal yang dikreditkan ke 2-1300 pada
    // jurnal di atas. Kalau meleset, ada rumus kedua yang menyimpang —
    // gagalkan transaksi (seluruh pelunasan di-rollback) daripada
    // meninggalkan liabilitas yang tidak bisa direkonsiliasi.
    if (totalFutureKeSubledger !== jasaFutureDibukukan) {
      throw new Error(
        `[DeferredIncome] Subledger jasa dimuka (${totalFutureKeSubledger}) tidak sama dengan ` +
          `nominal yang dikreditkan ke Pendapatan Diterima Dimuka (${jasaFutureDibukukan}) ` +
          `pada pelunasan pinjaman ${pinjaman.nomor_pinjaman}.`
      );
    }

    // Status pinjaman -> LUNAS (pola SAMA PERSIS bayarAngsuran(): cek
    // ulang seluruh jadwal, bukan diasumsikan otomatis dari loop di atas).
    const belumLunas = await db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM angsuran_jadwal WHERE pinjaman_id = ? AND ${sqlJadwalMasihTertagih('angsuran_jadwal')}`,
      params.pinjamanId
    );
    let eirFeeDiselesaikan = 0;
    if ((belumLunas?.cnt ?? 0) === 0) {
      await db.runAsync(`UPDATE pinjaman SET status = 'LUNAS', updated_at = ? WHERE id = ?`, now, params.pinjamanId);

      // PHASE 7 FINAL FIX (permintaan pengguna §1) — DERECOGNITION EIR
      // OTOMATIS, BAGIAN ATOMIC dari transaksi pelunasan yang SAMA
      // (bukan dipanggil terpisah oleh UI/caller). No-op kalau pinjaman
      // ini bukan pinjaman ber-EIR (eir_measurement_status != 'MEASURED')
      // — TIDAK ADA efek apa pun untuk pinjaman non-EIR (§17: "kalau
      // existing fixture tidak menggunakan integral fee, EIR path
      // tidak aktif, existing behavior tetap sama"). §4: TIDAK PERNAH
      // membaca/mengakui future contractual jasa — hanya menyelesaikan
      // sisa fee integral yang benar-benar belum teramortisasi.
      const hasilEir = await deselesaikanFeeEirDiDalamTransaksi(db, {
        pinjamanId: params.pinjamanId,
        tanggal: params.tanggal,
        alasan: 'PELUNASAN_DIPERCEPAT',
        createdBy: params.createdBy,
      });
      eirFeeDiselesaikan = hasilEir.jumlahDiakui;
    }

    return {
      journalId,
      totalPelunasan: rincian.totalPelunasan,
      porsiPokok: rincian.pokokTersisa,
      porsiJasa: rincian.jasaDitagih,
      porsiDenda: rincian.denda,
      porsiPenalti: rincian.penaltiPelunasan,
      porsiAdministrasi: rincian.administrasiPelunasan,
      metodeJasaPelunasan: rincian.metodeJasaPelunasan,
      rabatJasa: rincian.rabatJasa,
      jasaFuturePendingEirAccounting:
        rincian.metodeJasaPelunasan === 'JASA_TERUTANG' ? 0 : rincian.jasaFuture,
      eirFeeDiselesaikan,
    };
  });
}

// ============================================================
// FUNGSI BACA — daftar, detail, jadwal, tunggakan (PRD §11-13)
// ============================================================

export interface PinjamanListItem {
  id: string;
  nomorPinjaman: string;
  anggotaId: string;
  namaAnggota: string;
  jumlahPinjaman: Rupiah;
  /** Sisa piutang (pokok + jasa yang belum dibayar) — SUM(total - pokok_terbayar - jasa_terbayar) dari jadwal yang belum LUNAS. Beda dari jumlahPinjaman (plafon awal, tidak berubah walau sudah diangsur). */
  sisaPiutang: Rupiah;
  tenor: number;
  satuanTenor: SatuanTenor;
  status: string;
  tanggalJatuhTempo: string;
}

export async function listPinjaman(opts: {
  anggotaId?: string;
  status?: string;
  /** PHASE 4 §I (permintaan pengguna): filter kategori gabungan untuk Menu Pinjaman — 'AKTIF' (sudah dicairkan, belum LUNAS/MACET), 'BELUM_AKTIF' (DIAJUKAN/DISETUJUI, belum dicairkan), 'DIBATALKAN' (DITOLAK — enum existing, tidak ada nilai "DIBATALKAN" terpisah di skema). Independen dari `status` (exact match) di atas — pakai salah satu, bukan keduanya. */
  statusKategori?: 'AKTIF' | 'BELUM_AKTIF' | 'DIBATALKAN';
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<PinjamanListItem[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: (string | number)[] = [];

  if (opts.anggotaId) {
    filters.push('p.anggota_id = ?');
    params.push(opts.anggotaId);
  }
  if (opts.status) {
    filters.push('p.status = ?');
    params.push(opts.status);
  }
  if (opts.statusKategori === 'AKTIF') {
    // §I: "sudah dicairkan dan belum lunas/write-off" — LUNAS jangan
    // ikut masuk kategori Aktif (instruksi eksplisit).
    filters.push(`p.status = 'AKTIF'`);
  } else if (opts.statusKategori === 'BELUM_AKTIF') {
    filters.push(`p.status IN ('DIAJUKAN','DISETUJUI')`);
  } else if (opts.statusKategori === 'DIBATALKAN') {
    filters.push(`p.status = 'DITOLAK'`);
  }
  if (opts.search) {
    // PHASE 4 §J (permintaan pengguna): tambah nomor anggota ke
    // pencarian (sebelumnya hanya nomor pinjaman & nama anggota) —
    // query SQL langsung (backend filtering, bukan load semua data ke
    // frontend baru difilter), efisien untuk dataset besar via index
    // LIKE existing pada kolom-kolom ini.
    filters.push('(p.nomor_pinjaman LIKE ? OR a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  // sisa_piutang di sini adalah figur TAMPILAN daftar (SUM(total -
  // pokok_terbayar - jasa_terbayar) dari jadwal yang belum LUNAS) —
  // PHASE 3: BUKAN lagi sumber saldo untuk write-off sungguhan
  // (hapusPiutangPinjaman SEKARANG memakai saldo GL sungguhan lewat
  // hitungSaldoPiutangPokokGL + hitungOutstandingPiutangJasa, lihat
  // AkrualJasaPinjamanService.ts) — angka ini murni referensi cepat
  // untuk daftar/picker, sengaja tidak diubah supaya performa list
  // tetap ringan (tidak query GL per baris).
  const rows = await db.getAllAsync<any>(
    `SELECT p.id, p.nomor_pinjaman, p.anggota_id, a.nama_lengkap, p.jumlah_pinjaman,
            p.tenor, p.satuan_tenor, p.status, p.tanggal_jatuh_tempo,
            COALESCE((
              SELECT SUM(total - pokok_terbayar - jasa_terbayar)
              FROM angsuran_jadwal
              WHERE pinjaman_id = p.id AND ${sqlJadwalMasihTertagih('angsuran_jadwal')}
            ), 0) as sisa_piutang
     FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );

  return rows.map((r) => ({
    id: r.id,
    nomorPinjaman: r.nomor_pinjaman,
    anggotaId: r.anggota_id,
    namaAnggota: r.nama_lengkap,
    jumlahPinjaman: r.jumlah_pinjaman,
    sisaPiutang: r.sisa_piutang,
    tenor: r.tenor,
    satuanTenor: r.satuan_tenor,
    status: r.status,
    tanggalJatuhTempo: r.tanggal_jatuh_tempo,
  }));
}

export interface AnggotaPiutangItem {
  anggotaId: string;
  namaAnggota: string;
  nomorAnggota: string;
  nik: string | null;
  /** Jumlah pinjaman AKTIF milik anggota ini yang masih punya sisa piutang > 0. */
  jumlahPinjamanAktif: number;
  /** Total sisa piutang gabungan seluruh pinjaman AKTIF anggota ini. */
  totalSisaPiutang: Rupiah;
}

/**
 * Daftar anggota yang BENAR-BENAR punya piutang pinjaman outstanding
 * (dipakai AnggotaPiutangPicker di "Bayar Piutang Anggota") — BUKAN
 * daftar semua anggota. Kriteria: py.status = 'AKTIF' DAN sisa piutang
 * (dihitung PERSIS sama seperti listPinjaman()/hapusPiutangPinjaman()
 * di atas — SUM(total - pokok_terbayar - jasa_terbayar) dari jadwal
 * yang belum LUNAS) > 0. Status pinjaman AKTIF SAJA tidak cukup
 * (dicek eksplisit sesuai permintaan) — kombinasi status + sisa
 * piutang aktual mencegah anggota dengan pinjaman MACET (sudah
 * dihapusbukukan lewat hapusPiutangPinjaman, tapi baris jadwalnya
 * sendiri tidak diubah) ikut muncul seolah masih harus ditagih,
 * padahal piutangnya sudah dihapuskan dari buku besar.
 */
export async function listAnggotaDenganPiutangAktif(opts: { search?: string } = {}): Promise<AnggotaPiutangItem[]> {
  const db = await getDb();
  const filters: string[] = [`p.status = 'AKTIF'`];
  const params: (string | number)[] = [];
  if (opts.search) {
    filters.push('(a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ? OR a.nik LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }
  const where = `WHERE ${filters.join(' AND ')}`;

  const rows = await db.getAllAsync<any>(
    `SELECT a.id as anggota_id, a.nama_lengkap, a.nomor_anggota, a.nik,
            COUNT(*) as jumlah_pinjaman_aktif,
            SUM(sisa.sisa_piutang) as total_sisa_piutang
     FROM pinjaman p
     JOIN anggota a ON a.id = p.anggota_id
     JOIN (
       SELECT pinjaman_id, COALESCE(SUM(total - pokok_terbayar - jasa_terbayar), 0) as sisa_piutang
       FROM angsuran_jadwal
       WHERE ${sqlJadwalMasihTertagih('angsuran_jadwal')}
       GROUP BY pinjaman_id
     ) sisa ON sisa.pinjaman_id = p.id
     ${where}
     GROUP BY a.id
     HAVING total_sisa_piutang > 0
     ORDER BY a.nama_lengkap ASC`,
    ...params
  );

  return rows.map((r) => ({
    anggotaId: r.anggota_id,
    namaAnggota: r.nama_lengkap,
    nomorAnggota: r.nomor_anggota,
    nik: r.nik ?? null,
    jumlahPinjamanAktif: r.jumlah_pinjaman_aktif,
    totalSisaPiutang: r.total_sisa_piutang,
  }));
}

export async function getPinjamanDetail(pinjamanId: string) {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT p.*, a.nama_lengkap, a.nomor_anggota
     FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id
     WHERE p.id = ?`,
    pinjamanId
  );
  if (!row) return null;
  return {
    id: row.id,
    nomorPinjaman: row.nomor_pinjaman,
    anggotaId: row.anggota_id,
    namaAnggota: row.nama_lengkap,
    nomorAnggota: row.nomor_anggota,
    tanggal: row.tanggal,
    jumlahPinjaman: row.jumlah_pinjaman as Rupiah,
    tenor: row.tenor as number,
    satuanTenor: row.satuan_tenor as SatuanTenor,
    metodeJasa: row.metode_jasa as MetodeJasa,
    persentaseJasa: row.persentase_jasa as number,
    biayaAdminTipe: row.biaya_admin_tipe as string,
    biayaAdminNilai: row.biaya_admin_nilai as number,
    /** REQUIREMENT 7 — dipakai prefill form Edit Pinjaman supaya pilihan Jasa Terpisah/Integral tidak hilang saat diedit. */
    biayaAdminKlasifikasi: (row.biaya_admin_klasifikasi ?? 'SEPARATE_SERVICE') as BiayaAdminKlasifikasi,
    dendaAktif: !!row.denda_aktif,
    dendaTipe: row.denda_tipe as string | null,
    dendaNilai: row.denda_nilai as number,
    tanggalJatuhTempo: row.tanggal_jatuh_tempo as string,
    status: row.status as string,
    keterangan: row.keterangan as string | null,
    /** RC-S72 — prefill form Edit Pinjaman (null untuk pinjaman sebelum v65). */
    tujuanPinjaman: (row.tujuan_pinjaman ?? null) as TujuanPinjaman | null,
    tujuanDetail: (row.tujuan_detail ?? null) as string | null,
    /** RC-S72 — prefill form Edit Pinjaman; kosong = tanpa agunan. */
    agunan: await getAgunanPinjaman(db, pinjamanId),
  };
}

export interface JadwalAngsuranItem {
  id: string;
  nomorAngsuran: number;
  tanggalJatuhTempo: string;
  pokok: Rupiah;
  jasa: Rupiah;
  denda: Rupiah;
  total: Rupiah;
  pokokTerbayar: Rupiah;
  jasaTerbayar: Rupiah;
  dendaTerbayar: Rupiah;
  status: string;
  /**
   * REQUIREMENT 6 (permintaan pengguna) — traceability akad ulang.
   * Kolom `dibuat_dari_akad_ulang_id`/`digantikan_oleh_akad_ulang_id`
   * SUDAH ADA di skema sejak Phase 3 (lihat akadUlangPinjaman) tapi
   * TIDAK PERNAH di-expose ke layer UI, sehingga Detail Pinjaman
   * merender SELURUH baris jadwal jadi satu daftar campur dan export
   * "Angsuran Aktif" ikut memuat baris restrukturisasi. Dua field ini
   * yang membuat pemisahan Angsuran Aktif / Restrukturisasi / Akad
   * Ulang bisa dilakukan dari DATA AKTUAL, bukan tebakan.
   *
   * `dibuatDariAkadUlangId` != null -> baris ini LAHIR dari akad ulang.
   * `digantikanOlehAkadUlangId` != null -> baris ini DIGANTI oleh akad
   * ulang (statusnya pasti 'DIRESTRUKTURISASI').
   */
  dibuatDariAkadUlangId: string | null;
  digantikanOlehAkadUlangId: string | null;
}

/**
 * REQUIREMENT 6 — klasifikasi PENYAJIAN satu baris jadwal angsuran.
 * MURNI turunan dari data existing (`status` + dua kolom akad ulang) —
 * TIDAK ADA status baru yang ditambahkan ke database (instruksi
 * eksplisit: "Jangan membuat status baru jika existing status
 * sebenarnya sudah bisa digunakan").
 *
 *   AKTIF          — jadwal berjalan dari akad ASLI (belum pernah
 *                    direstrukturisasi, bukan hasil akad ulang).
 *   AKAD_ULANG     — jadwal berjalan hasil akad ulang.
 *   RESTRUKTURISASI— jadwal LAMA yang sudah digantikan (histori).
 *   DIHAPUSBUKU    — jadwal yang piutangnya sudah di-write-off.
 */
export type KelompokJadwalAngsuran = 'AKTIF' | 'AKAD_ULANG' | 'RESTRUKTURISASI' | 'DIHAPUSBUKU';

export function kelompokkanJadwalAngsuran(item: JadwalAngsuranItem): KelompokJadwalAngsuran {
  // BUG-08/BUG-12: keputusan "obsolete atau tidak" berasal dari
  // ScheduleLifecycle (satu sumber kebenaran), bukan dari perbandingan
  // string yang diketik ulang di sini. Pemetaan ke label penyajian
  // tetap lokal karena itu memang urusan tampilan.
  if (isObsoleteRepaymentSchedule(item.status)) {
    return item.status === 'DIHAPUSBUKU' ? 'DIHAPUSBUKU' : 'RESTRUKTURISASI';
  }
  return item.dibuatDariAkadUlangId ? 'AKAD_ULANG' : 'AKTIF';
}

/**
 * REQUIREMENT 6 — baris yang boleh masuk daftar & EXPORT "Angsuran
 * Aktif". Definisi tunggal yang dipakai UI MAUPUN export builder,
 * supaya mustahil keduanya berbeda isi (instruksi: "Export harus
 * mengikuti status/data aktual", "jangan membuat dua source of truth").
 *
 * Baris restrukturisasi (jadwal lama yang sudah digantikan) & baris
 * hapus buku DIKELUARKAN. Baris hasil akad ulang yang MASIH BERJALAN
 * ikut, karena baris itulah angsuran aktif current pinjaman ini —
 * yang dilarang requirement adalah "akad ulang yang BUKAN active
 * installment current", dan baris akad ulang yang sudah digantikan
 * akad ulang berikutnya otomatis berstatus DIRESTRUKTURISASI sehingga
 * tersaring di sini juga.
 */
export function isAngsuranAktif(item: JadwalAngsuranItem): boolean {
  const kelompok = kelompokkanJadwalAngsuran(item);
  return kelompok === 'AKTIF' || kelompok === 'AKAD_ULANG';
}

/**
 * PHASE 4 §H (permintaan pengguna): wrapper tipis untuk layar UI
 * (Detail Pinjaman > Akad Ulang) menampilkan Piutang Jasa yang sudah
 * diakui SEBELUM user menyerahkan formulir akad ulang — memanggil
 * fungsi Phase 2 yang sama persis (`hitungOutstandingPiutangJasa`),
 * TIDAK ADA rumus kedua.
 */
export async function getOutstandingPiutangJasa(pinjamanId: string): Promise<Rupiah> {
  const db = await getDb();
  return hitungOutstandingPiutangJasa(db, pinjamanId);
}

export async function getJadwalAngsuran(pinjamanId: string): Promise<JadwalAngsuranItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran ASC`,
    pinjamanId
  );
  return rows.map((r) => ({
    id: r.id,
    nomorAngsuran: r.nomor_angsuran,
    tanggalJatuhTempo: r.tanggal_jatuh_tempo,
    pokok: r.pokok,
    jasa: r.jasa,
    denda: r.denda,
    total: r.total,
    pokokTerbayar: r.pokok_terbayar,
    jasaTerbayar: r.jasa_terbayar,
    dendaTerbayar: r.denda_terbayar,
    status: r.status,
    dibuatDariAkadUlangId: r.dibuat_dari_akad_ulang_id ?? null,
    digantikanOlehAkadUlangId: r.digantikan_oleh_akad_ulang_id ?? null,
  }));
}

export interface AkadUlangInput {
  pinjamanId: string;
  tanggal: string;
  tenorBaru: number;
  satuanTenorBaru: SatuanTenor;
  metodeJasaBaru: MetodeJasa;
  persentaseJasaBaru: number;
  keterangan?: string;
  actingUserId: string;
}

export interface RiwayatAkadUlangItem {
  id: string;
  tanggal: string;
  tenorLama: number;
  satuanTenorLama: SatuanTenor;
  metodeJasaLama: MetodeJasa;
  persentaseJasaLama: number;
  tenorBaru: number;
  satuanTenorBaru: SatuanTenor;
  metodeJasaBaru: MetodeJasa;
  persentaseJasaBaru: number;
  sisaPokok: Rupiah;
  keterangan: string | null;
  createdAt: string;
  /** PHASE 3 — snapshot audit-only Piutang Jasa yang sudah diakui pada saat akad ulang ini (lihat komentar akadUlangPinjaman). */
  outstandingPiutangJasa: Rupiah;
  status: string;
}

/**
 * Target §9 (permintaan pengguna): "Fungsi Akad Ulang" — restrukturisasi
 * pinjaman AKTIF dengan tenor/metode jasa/persentase jasa baru. Hanya
 * berlaku untuk sisa pokok yang BELUM dibayar sama sekali (baris
 * `angsuran_jadwal` berstatus BELUM_BAYAR) — kalau ada baris SEBAGIAN
 * (sudah ada pembayaran parsial), akad ulang DITOLAK dengan pesan
 * jelas, supaya tidak perlu memecah pembayaran parsial yang sudah
 * tercatat (mengikuti pola `simpanJadwalAngsuranCustom` yang juga
 * menolak perubahan jadwal begitu ada pembayaran tercatat).
 *
 * TIDAK membuat jurnal baru (sisa pokok TIDAK berubah, murni jadwal &
 * syarat pinjaman yang disusun ulang — tidak ada uang yang berpindah)
 * — konsisten dengan instruksi "Jangan mengubah saldo/angsuran secara
 * diam-diam tanpa transaksi/record yang sesuai": perubahan DICATAT di
 * `pinjaman_akad_ulang` (riwayat lengkap sebelum/sesudah) & `audit_log`
 * (action AKAD_ULANG), bukan lewat jurnal akuntansi baru karena tidak
 * ada perpindahan dana.
 *
 * Baris `angsuran_jadwal` yang BELUM_BAYAR dihapus & diganti dengan
 * jadwal baru hasil `hitungJadwalAngsuran()` atas SISA POKOK (bukan
 * jumlah pinjaman awal), melanjutkan nomor angsuran dari baris LUNAS
 * terakhir. Baris LUNAS/SEBAGIAN (kalau ada tunggakan denda saja,
 * misalnya) tidak disentuh.
 */
/**
 * PHASE 3 (permintaan pengguna, bagian K-P) — REBUILD: sebelumnya
 * baris `angsuran_jadwal` berstatus BELUM_BAYAR di-DELETE lalu diganti
 * jadwal baru — histori hilang, tidak bisa ditelusuri. DIPERBAIKI:
 * baris lama TIDAK PERNAH dihapus, hanya ditandai status
 * 'DIRESTRUKTURISASI' + `digantikan_oleh_akad_ulang_id` (menunjuk
 * event akad ulang ini). Baris baru diberi `dibuat_dari_akad_ulang_id`
 * yang sama — traceability BIDIRECTIONAL "old schedule ->
 * restructuring -> new schedule" (§L/§M) queryable dari kedua arah.
 *
 * Piutang Jasa yang SUDAH DIAKUI (Phase 2, `pinjaman_akuntansi_jasa`)
 * TIDAK disentuh sama sekali — accrual lama tetap valid & tetap
 * outstanding apa adanya (§N: "Piutang Jasa yang sudah diakui tidak
 * boleh hilang hanya karena schedule lama direstrukturisasi").
 * `hitungOutstandingPiutangJasa()` TIDAK memfilter berdasarkan
 * jadwal_id, jadi otomatis tetap benar tanpa perubahan apa pun di
 * modul akrual — disnapshot di sini HANYA untuk audit trail
 * (`pinjaman_akad_ulang.outstanding_piutang_jasa`), TIDAK
 * mempengaruhi perhitungan. TIDAK ADA jurnal baru dibuat (§O: tidak
 * boleh membuat pendapatan jasa baru / double income hanya karena
 * akad ulang — restrukturisasi murni mengubah jadwal KONTRAKTUAL
 * masa depan, bukan accounting recognition yang sudah terjadi).
 *
 * §Q: akad ulang hanya untuk status AKTIF (dicek di bawah) — pinjaman
 * yang sudah write-off berstatus MACET, otomatis ditolak tanpa
 * pengecekan tambahan.
 */
export async function akadUlangPinjaman(input: AkadUlangInput): Promise<{ sisaPokok: Rupiah; jumlahPeriodeBaru: number; akadUlangId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.actingUserId, 'pinjaman', 'edit');

    if (input.tenorBaru <= 0) throw new Error('Tenor baru harus lebih besar dari 0.');
    if (input.persentaseJasaBaru < 0) throw new Error('Persentase jasa tidak boleh negatif.');
    if (input.metodeJasaBaru === 'CUSTOM') {
      throw new Error('Akad ulang tidak mendukung metode jasa CUSTOM — susun jadwal custom lewat menu Jadwal Custom setelah akad ulang disimpan.');
    }

    const pinjaman = await db.getFirstAsync<any>('SELECT * FROM pinjaman WHERE id = ?', input.pinjamanId);
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    if (pinjaman.status !== 'AKTIF') {
      throw new Error(`Akad ulang hanya berlaku untuk pinjaman berstatus AKTIF (status saat ini: ${pinjaman.status}).`);
    }

    // ============================================================
    // BUG-10 — GUARD PERIODE UNTUK MUTASI TANPA JURNAL
    // ============================================================
    // Akad ulang HANYA memutasi subledger: menandai jadwal lama
    // DIRESTRUKTURISASI dan menyisipkan jadwal pengganti. Tidak ada
    // uang berpindah, jadi TIDAK ADA jurnal yang dibuat — akibatnya
    // guard periode di `createJournal()` tidak pernah tersentuh dan
    // restrukturisasi bisa mengubah periode yang SUDAH DITUTUP.
    //
    // Itu tetap merusak: outstanding, aging, kolektibilitas, dan dasar
    // pencadangan periode tersebut ikut berubah, padahal laporannya
    // sudah final dan dibagikan. "Tidak ada jurnal" tidak berarti
    // "tidak ada dampak akuntansi".
    //
    // Karena itu guardnya dipanggil EKSPLISIT di sini, memakai helper
    // terpusat yang sama dengan createJournal.
    await assertAccountingPeriodOpen(db, input.tanggal);

    const jadwalRows = await db.getAllAsync<any>(
      'SELECT * FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran ASC',
      input.pinjamanId
    );
    // §K/§M: hanya baris BELUM_BAYAR/SEBAGIAN yang relevan untuk
    // direstrukturisasi — baris DIHAPUSBUKU/DIRESTRUKTURISASI dari
    // event sebelumnya (kalau ada) TIDAK ikut dihitung ulang di sini
    // (sudah historical, tidak boleh "dihidupkan lagi").
    // BUG-08/BUG-12: pakai definisi CURRENT terpusat, bukan daftar
    // status yang diketik ulang. Kalau ada baris berstatus 'TERLAMBAT'
    // (status sah menurut CHECK constraint), daftar hardcoded lama akan
    // MELEWATKANNYA — baris itu tidak ditandai DIRESTRUKTURISASI
    // sementara jadwal pengganti tetap dibuat, sehingga selamanya ikut
    // dihitung bersama jadwal baru. Itu persis akar double count.
    const belumLunas = jadwalRows.filter((r) => isScheduleObsoleteForRestructuring(r.status));
    if (belumLunas.length === 0) {
      throw new Error('Pinjaman ini sudah lunas seluruhnya — tidak ada sisa pokok untuk diakad-ulangkan.');
    }
    const adaSebagian = belumLunas.some((r) => r.pokok_terbayar > 0 || r.jasa_terbayar > 0);
    if (adaSebagian) {
      throw new Error(
        'Akad ulang tidak bisa dilakukan karena ada angsuran yang sudah terbayar sebagian — lunasi atau koreksi pembayaran tersebut dulu.'
      );
    }

    const sisaPokok = belumLunas.reduce((a, r) => a + (r.pokok as number), 0);
    if (sisaPokok <= 0) {
      throw new Error('Sisa pokok pinjaman ini nol — tidak ada yang perlu diakad-ulangkan.');
    }

    // §L/§N: snapshot AUDIT-ONLY — Piutang Jasa yang sudah diakui
    // TIDAK berubah/ditransfer oleh baris di bawah, murni dicatat
    // untuk ditampilkan di riwayat.
    const outstandingPiutangJasa = await hitungOutstandingPiutangJasa(db, input.pinjamanId);

    // PHASE 7 (permintaan pengguna §S): kalau pinjaman ini di bawah
    // pengukuran EIR, TANDAI eksplisit sebagai
    // PENDING_RESTRUCTURING_EIR_REVIEW — JANGAN menghitung ulang EIR
    // atau melanjutkan amortisasi lama tanpa evaluasi. Modification
    // accounting yang benar memerlukan keputusan kebijakan tambahan
    // yang TIDAK dibuat sepihak di sini (persis instruksi). Histori
    // EIR_MONTHLY yang sudah ada TIDAK dihapus/disentuh — hanya status
    // pinjaman & baris FEE_INTEGRAL_AMORTISASI yang ditandai.
    await tandaiEirPendingRestrukturisasi(db, input.pinjamanId);

    // PHASE 3 KOREKSI (ditemukan lewat pengujian): SEBELUM ini
    // penomoran baris baru melanjutkan dari jumlah baris LUNAS
    // (`nomorTerakhirLunas`), yang aman SELAMA baris lama yang belum
    // lunas ikut DIHAPUS (perilaku lama). Sekarang baris lama TIDAK
    // dihapus (§K) — melanjutkan dari jumlah LUNAS bisa BENTROK dengan
    // `UNIQUE(pinjaman_id, nomor_angsuran)` milik baris lama yang
    // masih ada (sekarang DIRESTRUKTURISASI, bukan LUNAS, tapi
    // nomor_angsuran-nya tetap terpakai). Pakai nomor TERTINGGI yang
    // pernah ada untuk pinjaman ini (apa pun statusnya) supaya nomor
    // baris baru DIJAMIN belum pernah dipakai.
    const nomorTertinggi = jadwalRows.reduce((max, r) => Math.max(max, r.nomor_angsuran as number), 0);

    const hasilBaru = hitungJadwalAngsuran({
      jumlahPinjaman: sisaPokok,
      tenor: input.tenorBaru,
      persentaseJasaPerPeriode: input.persentaseJasaBaru,
      metode: input.metodeJasaBaru,
    });

    const akadUlangId = newId();
    const now = new Date().toISOString();

    // PENTING: baris `pinjaman_akad_ulang` HARUS di-INSERT SEBELUM
    // baris angsuran_jadwal (lama maupun baru) menunjuk ke id-nya lewat
    // FK `digantikan_oleh_akad_ulang_id`/`dibuat_dari_akad_ulang_id` —
    // pada instalasi baru (CREATE_TABLES_SQL mengaktifkan
    // `PRAGMA foreign_keys = ON`), FK diperiksa saat INSERT/UPDATE
    // baris ANAK terjadi, jadi baris INDUK wajib sudah ada lebih dulu.
    await db.runAsync(
      `INSERT INTO pinjaman_akad_ulang
        (id, pinjaman_id, tanggal, tenor_lama, satuan_tenor_lama, metode_jasa_lama, persentase_jasa_lama,
         tenor_baru, satuan_tenor_baru, metode_jasa_baru, persentase_jasa_baru, sisa_pokok, keterangan,
         outstanding_piutang_jasa, status, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'SELESAI',?,?)`,
      akadUlangId,
      input.pinjamanId,
      input.tanggal,
      pinjaman.tenor,
      pinjaman.satuan_tenor,
      pinjaman.metode_jasa,
      pinjaman.persentase_jasa,
      input.tenorBaru,
      input.satuanTenorBaru,
      input.metodeJasaBaru,
      input.persentaseJasaBaru,
      sisaPokok,
      input.keterangan ?? null,
      outstandingPiutangJasa,
      input.actingUserId,
      now
    );

    // §K/§M/§L: baris lama TIDAK DIHAPUS — ditandai DIRESTRUKTURISASI
    // + ditautkan ke event ini (bukan DELETE+INSERT seperti sebelumnya).
    for (const row of belumLunas) {
      await db.runAsync(
        `UPDATE angsuran_jadwal SET status = 'DIRESTRUKTURISASI', digantikan_oleh_akad_ulang_id = ? WHERE id = ?`,
        akadUlangId,
        row.id
      );
    }

    for (const row of hasilBaru) {
      // BUG-13: jadwal hasil akad ulang memakai algoritma yang sama,
      // origin-nya adalah tanggal akad ulang.
      const tanggalAngsuranBaru = calculateInstallmentDate(input.tanggal, row.nomorAngsuran, input.satuanTenorBaru);
      await db.runAsync(
        `INSERT INTO angsuran_jadwal
          (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status, dibuat_dari_akad_ulang_id)
         VALUES (?,?,?,?,?,?,0,?,'BELUM_BAYAR',?)`,
        newId(),
        input.pinjamanId,
        nomorTertinggi + row.nomorAngsuran,
        tanggalAngsuranBaru,
        row.pokok,
        row.jasa,
        row.total,
        akadUlangId
      );
    }

    // BUG-13: maturity header pinjaman setelah akad ulang = tanggal
    // angsuran TERAKHIR jadwal baru, dari algoritma yang sama.
    const tanggalJatuhTempoBaru = calculateMaturityDate(
      input.tanggal,
      input.tenorBaru,
      input.satuanTenorBaru
    );
    await db.runAsync(
      `UPDATE pinjaman SET tenor = ?, satuan_tenor = ?, metode_jasa = ?, persentase_jasa = ?, tanggal_jatuh_tempo = ?, updated_at = ? WHERE id = ?`,
      input.tenorBaru,
      input.satuanTenorBaru,
      input.metodeJasaBaru,
      input.persentaseJasaBaru,
      tanggalJatuhTempoBaru,
      new Date().toISOString(),
      input.pinjamanId
    );

    await db.runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(),
      input.actingUserId,
      now.slice(0, 10),
      now.slice(11, 19),
      'AKAD_ULANG',
      'pinjaman',
      input.pinjamanId,
      JSON.stringify({ tenor: pinjaman.tenor, satuanTenor: pinjaman.satuan_tenor, metodeJasa: pinjaman.metode_jasa, persentaseJasa: pinjaman.persentase_jasa }),
      JSON.stringify({
        tenor: input.tenorBaru,
        satuanTenor: input.satuanTenorBaru,
        metodeJasa: input.metodeJasaBaru,
        persentaseJasa: input.persentaseJasaBaru,
        sisaPokok,
        outstandingPiutangJasa,
        akadUlangId,
      }),
      now
    );

    return { sisaPokok, jumlahPeriodeBaru: hasilBaru.length, akadUlangId };
  });
}

/** Riwayat akad ulang untuk satu pinjaman, terbaru dulu — dipakai PinjamanDetailScreen untuk menelusuri akad-akad sebelumnya. */
export async function getRiwayatAkadUlang(pinjamanId: string): Promise<RiwayatAkadUlangItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM pinjaman_akad_ulang WHERE pinjaman_id = ? ORDER BY created_at DESC`,
    pinjamanId
  );
  return rows.map((r) => ({
    id: r.id,
    tanggal: r.tanggal,
    tenorLama: r.tenor_lama,
    satuanTenorLama: r.satuan_tenor_lama,
    metodeJasaLama: r.metode_jasa_lama,
    persentaseJasaLama: r.persentase_jasa_lama,
    tenorBaru: r.tenor_baru,
    satuanTenorBaru: r.satuan_tenor_baru,
    metodeJasaBaru: r.metode_jasa_baru,
    persentaseJasaBaru: r.persentase_jasa_baru,
    sisaPokok: r.sisa_pokok,
    keterangan: r.keterangan,
    createdAt: r.created_at,
    outstandingPiutangJasa: r.outstanding_piutang_jasa ?? 0,
    status: r.status ?? 'SELESAI',
  }));
}

/**
 * RC-S82 — DATA DOKUMEN AKAD ULANG (READ-ONLY).
 * ============================================================
 * Satu-satunya loader untuk dokumen PDF "Dokumen Akad Ulang Pinjaman".
 * HANYA SELECT — tidak ada INSERT/UPDATE/DELETE, tidak ada transaksi,
 * tidak menyentuh `akadUlangPinjaman()`, jurnal, COA, EIR, maupun
 * lifecycle jadwal.
 *
 * Sumber kebenaran tiap nilai (tidak ada rumus accounting kedua):
 *   - Sisa pokok dasar akad  -> SNAPSHOT `pinjaman_akad_ulang.sisa_pokok`
 *   - Piutang jasa diakui    -> SNAPSHOT `pinjaman_akad_ulang.outstanding_piutang_jasa`
 *                               (informasi historis/audit — TIDAK ditambahkan ke pokok)
 *   - Jadwal akad ulang      -> baris `angsuran_jadwal` dengan
 *                               `dibuat_dari_akad_ulang_id = akadUlangId`
 *                               (event historis tetap memakai jadwal MILIKNYA sendiri)
 *   - Jatuh tempo sebelum    -> jatuh tempo terakhir jadwal milik event
 *                               SEBELUMNYA (atau jadwal akad asli untuk event pertama)
 *   - Syarat akad awal       -> nilai `*_lama` pada event PERTAMA (baris
 *                               `pinjaman` sudah menyimpan syarat terbaru)
 */
export interface AkadUlangDocumentData {
  koperasi: { nama: string; alamat: string | null; nomorBadanHukum: string | null };
  /** Ketua/Sekretaris/Bendahara yang menjabat pada TANGGAL AKAD ULANG (bukan hari ini). */
  pengurus: SusunanPengurusInti;
  pinjaman: { id: string; nomorPinjaman: string; statusSaatIni: string };
  anggota: { namaLengkap: string; nomorAnggota: string; nik: string | null; alamat: string | null };
  akadAwal: {
    tanggal: string;
    jumlahPinjaman: Rupiah;
    tenor: number;
    satuanTenor: SatuanTenor;
    metodeJasa: MetodeJasa;
    persentaseJasa: number;
    jatuhTempo: string | null;
  };
  event: RiwayatAkadUlangItem;
  /** Event akad ulang tepat sebelum event ini (null untuk akad ulang pertama). */
  eventSebelumnya: RiwayatAkadUlangItem | null;
  /** 1-based, kronologis. */
  urutanEvent: number;
  jumlahEvent: number;
  /** Jatuh tempo terakhir kontrak SEBELUM event ini (null bila tidak dapat ditelusuri). */
  jatuhTempoSebelum: string | null;
  /** Jadwal yang LAHIR dari event ini, urut nomor internal. */
  jadwal: JadwalAngsuranItem[];
}

export async function getAkadUlangDocumentData(pinjamanId: string, akadUlangId: string): Promise<AkadUlangDocumentData> {
  const db = await getDb();

  const pinjaman = await db.getFirstAsync<any>(
    `SELECT p.id, p.nomor_pinjaman, p.tanggal, p.jumlah_pinjaman, p.tenor, p.satuan_tenor, p.metode_jasa,
            p.persentase_jasa, p.status,
            a.nama_lengkap, a.nomor_anggota, a.nik, a.alamat
     FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id
     WHERE p.id = ?`,
    pinjamanId
  );
  if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');

  const riwayat = await getRiwayatAkadUlang(pinjamanId);
  const urut = urutkanEventAkadUlang(riwayat);
  const idx = urut.findIndex((r) => r.id === akadUlangId);
  if (idx < 0) throw new Error('Data akad ulang tidak ditemukan untuk pinjaman ini.');
  const event = urut[idx];
  const eventPertama = urut[0];
  const eventSebelumnya = idx > 0 ? urut[idx - 1] : null;

  const semuaJadwal = await getJadwalAngsuran(pinjamanId);
  const jadwal = semuaJadwal.filter((j) => j.dibuatDariAkadUlangId === akadUlangId);
  const jadwalAkadAsli = semuaJadwal.filter((j) => !j.dibuatDariAkadUlangId);
  const jatuhTempoAkadAsli = jatuhTempoAkhir(jadwalAkadAsli);
  const jatuhTempoSebelum = eventSebelumnya
    ? jatuhTempoAkhir(semuaJadwal.filter((j) => j.dibuatDariAkadUlangId === eventSebelumnya.id))
    : jatuhTempoAkadAsli;

  const koperasi = await db.getFirstAsync<any>(`SELECT nama, alamat, nomor_badan_hukum FROM koperasi LIMIT 1`);
  const pengurus = await getSusunanPengurusInti(event.tanggal);

  return {
    koperasi: { nama: koperasi?.nama ?? '-', alamat: koperasi?.alamat ?? null, nomorBadanHukum: koperasi?.nomor_badan_hukum ?? null },
    pengurus,
    pinjaman: { id: pinjaman.id, nomorPinjaman: pinjaman.nomor_pinjaman, statusSaatIni: pinjaman.status },
    anggota: {
      namaLengkap: pinjaman.nama_lengkap,
      nomorAnggota: pinjaman.nomor_anggota,
      nik: pinjaman.nik ?? null,
      alamat: pinjaman.alamat ?? null,
    },
    akadAwal: {
      tanggal: pinjaman.tanggal,
      jumlahPinjaman: pinjaman.jumlah_pinjaman,
      tenor: eventPertama.tenorLama,
      satuanTenor: eventPertama.satuanTenorLama,
      metodeJasa: eventPertama.metodeJasaLama,
      persentaseJasa: eventPertama.persentaseJasaLama,
      jatuhTempo: jatuhTempoAkadAsli,
    },
    event,
    eventSebelumnya,
    urutanEvent: idx + 1,
    jumlahEvent: urut.length,
    jatuhTempoSebelum,
    jadwal,
  };
}

/**
 * RC-S82 (lanjutan) — DATA DOKUMEN AKAD AWAL (READ-ONLY).
 * Dapat diekspor TANPA akad ulang. HANYA SELECT.
 *
 *   - Syarat akad awal: bila pinjaman pernah diakadulangkan, baris
 *     `pinjaman` sudah memuat syarat TERBARU, sehingga syarat asli diambil
 *     dari nilai `*_lama` event akad ulang PERTAMA; bila belum pernah,
 *     dari baris `pinjaman` apa adanya.
 *   - Jadwal: baris `angsuran_jadwal` dengan `dibuat_dari_akad_ulang_id
 *     IS NULL` (jadwal akad asli, termasuk yang kemudian digantikan).
 */
export interface AkadAwalDocumentData {
  koperasi: { nama: string; alamat: string | null; nomorBadanHukum: string | null };
  /** Ketua/Sekretaris/Bendahara yang menjabat pada TANGGAL AKAD (bukan hari ini). */
  pengurus: SusunanPengurusInti;
  anggota: { namaLengkap: string; nomorAnggota: string; nik: string | null; alamat: string | null };
  pinjaman: {
    id: string;
    nomorPinjaman: string;
    tanggal: string;
    jumlahPinjaman: Rupiah;
    tenor: number;
    satuanTenor: SatuanTenor;
    metodeJasa: MetodeJasa;
    persentaseJasa: number;
    biayaAdminTipe: string;
    biayaAdminNilai: number;
    dendaAktif: boolean;
    tujuan: string | null;
    tujuanDetail: string | null;
    keterangan: string | null;
    statusSaatIni: string;
  };
  /** Akad ulang pertama yang menggantikan akad awal (null bila belum pernah). */
  digantikanOleh: { id: string; tanggal: string } | null;
  jumlahAkadUlang: number;
  jadwal: JadwalAngsuranItem[];
}

export async function getAkadAwalDocumentData(pinjamanId: string): Promise<AkadAwalDocumentData> {
  const db = await getDb();
  const p = await db.getFirstAsync<any>(
    `SELECT p.id, p.nomor_pinjaman, p.tanggal, p.jumlah_pinjaman, p.tenor, p.satuan_tenor, p.metode_jasa,
            p.persentase_jasa, p.biaya_admin_tipe, p.biaya_admin_nilai, p.denda_aktif, p.tujuan_pinjaman,
            p.tujuan_detail, p.keterangan, p.status,
            a.nama_lengkap, a.nomor_anggota, a.nik, a.alamat
     FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id
     WHERE p.id = ?`,
    pinjamanId
  );
  if (!p) throw new Error('Pinjaman tidak ditemukan.');
  if (p.status === 'DITOLAK') throw new Error('Pinjaman yang ditolak tidak memiliki dokumen akad.');

  const riwayat = urutkanEventAkadUlang(await getRiwayatAkadUlang(pinjamanId));
  const pertama = riwayat[0] ?? null;
  const semuaJadwal = await getJadwalAngsuran(pinjamanId);
  const koperasi = await db.getFirstAsync<any>(`SELECT nama, alamat, nomor_badan_hukum FROM koperasi LIMIT 1`);
  const pengurus = await getSusunanPengurusInti(p.tanggal);

  return {
    koperasi: { nama: koperasi?.nama ?? '-', alamat: koperasi?.alamat ?? null, nomorBadanHukum: koperasi?.nomor_badan_hukum ?? null },
    pengurus,
    anggota: {
      namaLengkap: p.nama_lengkap,
      nomorAnggota: p.nomor_anggota,
      nik: p.nik ?? null,
      alamat: p.alamat ?? null,
    },
    pinjaman: {
      id: p.id,
      nomorPinjaman: p.nomor_pinjaman,
      tanggal: p.tanggal,
      jumlahPinjaman: p.jumlah_pinjaman,
      tenor: pertama ? pertama.tenorLama : p.tenor,
      satuanTenor: pertama ? pertama.satuanTenorLama : p.satuan_tenor,
      metodeJasa: pertama ? pertama.metodeJasaLama : p.metode_jasa,
      persentaseJasa: pertama ? pertama.persentaseJasaLama : p.persentase_jasa,
      biayaAdminTipe: p.biaya_admin_tipe,
      biayaAdminNilai: p.biaya_admin_nilai,
      dendaAktif: p.denda_aktif === 1,
      tujuan: p.tujuan_pinjaman ?? null,
      tujuanDetail: p.tujuan_detail ?? null,
      keterangan: p.keterangan ?? null,
      statusSaatIni: p.status,
    },
    digantikanOleh: pertama ? { id: pertama.id, tanggal: pertama.tanggal } : null,
    jumlahAkadUlang: riwayat.length,
    jadwal: semuaJadwal.filter((j) => !j.dibuatDariAkadUlangId).sort((a, b) => a.nomorAngsuran - b.nomorAngsuran),
  };
}

export interface TunggakanItem {
  pinjamanId: string;
  nomorPinjaman: string;
  namaAnggota: string;
  nomorAngsuran: number;
  tanggalJatuhTempo: string;
  sisaTagihan: Rupiah;
  hariTerlambat: number;
}

/**
 * Penghapusan piutang pinjaman (write-off) — dipakai untuk pinjaman
 * anggota yang dianggap tak tertagih (macet total). BEDA dari
 * transaksi Kas & Bank lain: ini jurnal NON-KAS murni (tidak ada uang
 * yang keluar/masuk kas atau bank), jadi TIDAK lewat
 * catatPengeluaran/catatPemasukan (yang selalu menyentuh akun
 * kas/bank) — lihat sub-fitur "Penghapusan Piutang" di menu
 * Pengeluaran (TransaksiPengeluaranScreen), yang diarahkan ke sini,
 * bukan ke form Kas & Bank biasa.
 *
 * Update pasca-Phase 18 (permintaan pengguna §14/§18/§19/§20):
 * - §14: HANYA pinjaman berkolektibilitas MACET (>180 hari tunggakan,
 *   dari `LoanImpairmentService.getKlasifikasiPinjamanAktif` — SATU
 *   mesin klasifikasi yang sama dipakai layar Kolektibilitas Piutang)
 *   yang boleh dihapuskan — dicek di SERVICE ini (bukan cuma difilter
 *   di picker UI), jadi tidak bisa dilewati walau request entah
 *   bagaimana terkirim untuk pinjaman yang belum macet.
 * - §18: TIDAK ADA LAGI parameter akun yang dipilih user. Akun
 *   ditentukan OTOMATIS: DEBIT Penyisihan Piutang (mengonsumsi
 *   cadangan yang sudah dibentuk lewat `sesuaikanPenyisihanPiutang()`
 *   — BUKAN akun Beban baru, supaya kerugian tidak dicatat dua kali:
 *   sekali saat provisioning §15-17, sekali lagi saat write-off),
 *   KREDIT Piutang Pinjaman Anggota (piutang BENAR-BENAR dikeluarkan
 *   dari neraca — beda dari penyisihan yang TIDAK menyentuh piutang
 *   sama sekali, lihat komentar `sesuaikanPenyisihanPiutang` di
 *   LoanImpairmentService.ts: "Jangan menggunakan akun piutang
 *   langsung sebagai akun kredit" — itu aturan untuk jurnal
 *   PENYISIHAN, bukan untuk write-off ini, yang MEMANG harus
 *   mengeluarkan piutang).
 * - §19/§20: syarat RAT (Rapat Anggota Tahunan) — lihat parameter
 *   `ratId` & validasi di bawah.
 */
export interface HapusPiutangResult {
  journalId: string;
  nomorTransaksi: string;
  writeOffPrincipal: Rupiah;
  writeOffJasa: Rupiah;
  writeOffTotal: Rupiah;
  penyisihanTopUpJournalId: string | null;
  penyisihanTopUpJumlah: Rupiah;
  /** PHASE 7 FINAL FIX (permintaan pengguna §2) — sisa fee integral (EIR) yang diselesaikan otomatis saat write-off ini. 0 kalau pinjaman ini bukan pinjaman ber-EIR. */
  eirFeeDiselesaikan: Rupiah;
}

/**
 * PHASE 3 (permintaan pengguna, bagian A-H) — REBUILD TOTAL dari
 * fungsi ini. Bug lama: `SUM(total - pokok_terbayar - jasa_terbayar)`
 * = pokok outstanding + SELURUH jasa outstanding/future, dipakai
 * langsung sebagai kredit ke akun Piutang Pinjaman (yang di GL
 * sebenarnya HANYA mencerminkan pokok) — jurnal kredit lebih besar
 * dari saldo akun yang sesungguhnya. DIPERBAIKI TOTAL:
 *
 *  1. Piutang Pokok write-off = saldo GL SUNGGUHAN untuk pinjaman ini
 *     (hitungSaldoPiutangPokokGL — dihitung dari journal_entry yang
 *     benar-benar terposting, BUKAN dari kolom angsuran_jadwal).
 *  2. Piutang Jasa write-off = HANYA jasa yang SUDAH DIAKUI & belum
 *     dibayar (hitungOutstandingPiutangJasa, Phase 2) — jasa
 *     kontraktual MASA DEPAN yang belum pernah diakru TIDAK IKUT.
 *  3. Fee integral (FEE_INTEGRAL_AMORTISASI/DEFERRED_PENDING_EIR)
 *     TIDAK PERNAH dianggap Piutang Jasa/receivable — sama sekali
 *     tidak disentuh fungsi ini (tetap dilacak terpisah untuk Phase
 *     EIR berikutnya).
 *  4. Denda TIDAK ikut — aplikasi ini TIDAK PERNAH membukukan denda
 *     sebagai receivable (Dr Piutang Denda) di titik mana pun;
 *     Pendapatan Denda hanya diakui SAAT kas diterima (lihat
 *     bayarAngsuran). Karena tidak pernah menjadi aset/receivable
 *     tercatat, tidak ada apa pun untuk dihapusbukukan (§E: "HANYA
 *     saldo yang benar-benar tercatat sebagai aset/receivable
 *     accounting").
 *  5. Penyisihan TIDAK BOLEH menjadi negatif — kalau saldo Penyisihan
 *     Piutang (portfolio-wide, akun kontra existing, TIDAK diubah
 *     model impairment-nya) kurang dari total write-off, transaksi
 *     DITOLAK dengan pesan jelas KECUALI caller eksplisit mengizinkan
 *     top-up otomatis (`topUpPenyisihanJikaKurang: true`) — top-up
 *     memakai mapping PENYISIHAN_PIUTANG existing (Dr Beban Penyisihan
 *     / Cr Penyisihan Piutang, PERSIS mekanisme yang sudah dipakai
 *     LoanImpairmentService.sesuaikanPenyisihanPiutang), BUKAN akun
 *     baru yang dikarang.
 */
export async function hapusPiutangPinjaman(params: {
  pinjamanId: string;
  tanggal: string;
  alasan: string;
  createdBy: string;
  /** §E: izinkan top-up otomatis Beban Penyisihan/Penyisihan Piutang (mapping existing) kalau saldo penyisihan tidak cukup untuk menutup seluruh write-off. Default false — transaksi ditolak dulu, bukan diam-diam menambah beban. */
  topUpPenyisihanJikaKurang?: boolean;
}): Promise<HapusPiutangResult> {
  return withTransaction(async (db) => {
    await requirePermission(db, params.createdBy, 'pinjaman', 'edit');

    const pinjaman = await db.getFirstAsync<{ status: string; nomor_pinjaman: string }>(
      `SELECT status, nomor_pinjaman FROM pinjaman WHERE id = ?`,
      params.pinjamanId
    );
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    if (pinjaman.status === 'LUNAS') throw new Error('Pinjaman ini sudah lunas, tidak ada piutang untuk dihapus.');
    // §H IDEMPOTENCY: status MACET hanya bisa dicapai lewat fungsi ini
    // (satu-satunya penulis status ini di seluruh codebase selain
    // seed/migration) — menolak transaksi kedua secara struktural,
    // tanpa perlu tabel/flag idempotency terpisah.
    if (pinjaman.status === 'MACET') throw new Error('Pinjaman ini sudah pernah dihapusbukukan sebelumnya.');

    // §19: WAJIB ada persetujuan RAT untuk tahun buku terkait sebelum
    // penghapusan piutang — diturunkan otomatis dari tahun pada
    // `tanggal` transaksi (bukan field terpisah yang harus diisi user
    // manual; RAT sudah tersimpan sekali per tahun buku lewat layar
    // SHU, lihat RATService.ts & §12-13).
    const tahunBuku = new Date(params.tanggal).getFullYear();
    const rat = await db.getFirstAsync<{ id: string }>(`SELECT id FROM rat WHERE tahun_buku = ?`, tahunBuku);
    if (!rat) {
      throw new Error('Penghapusan piutang hanya dapat dilakukan setelah memperoleh persetujuan Rapat Anggota Tahunan (RAT).');
    }

    // §14 (TIDAK diubah Phase 3): HANYA boleh untuk pinjaman
    // berkolektibilitas MACET — dicek lewat mesin klasifikasi yang
    // sama dengan layar Kolektibilitas Piutang (statusAnggota: SEMUA
    // — anggota yang sudah keluar/nonaktif pun piutangnya tetap bisa
    // dihapuskan kalau memang macet).
    const klasifikasi = await getKlasifikasiPinjamanAktif(db, { tanggalLaporan: params.tanggal, statusAnggota: 'SEMUA' });
    const statusKredit = klasifikasi.find((k) => k.pinjamanId === params.pinjamanId);
    if (!statusKredit || statusKredit.kolektibilitas !== 'MACET') {
      throw new Error('Penghapusan piutang hanya dapat dilakukan untuk pinjaman berkolektibilitas Macet (tunggakan lebih dari 180 hari).');
    }

    // §B/§C: Piutang Pokok dari GL SUNGGUHAN (bukan kolom angsuran_jadwal).
    const piutangPokokAccountId = await resolveAccountId(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG');
    const writeOffPrincipal = await hitungSaldoPiutangPokokGL(db, params.pinjamanId, piutangPokokAccountId);

    // §D: Piutang Jasa HANYA yang sudah diakui (Phase 2) — future
    // contractual jasa & fee integral TIDAK PERNAH masuk sini.
    const writeOffJasa = await hitungOutstandingPiutangJasa(db, params.pinjamanId);

    const writeOffTotal = writeOffPrincipal + writeOffJasa;
    if (writeOffTotal <= 0) {
      throw new Error('Tidak ada saldo Piutang Pokok maupun Piutang Jasa yang tercatat di GL untuk pinjaman ini — tidak ada yang dapat dihapuskan.');
    }

    // §E: cek ketersediaan Penyisihan (portfolio-wide, TIDAK per pinjaman).
    const penyisihanAccountId = await resolveAccountId(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN');
    const penyisihanTersedia = await hitungSaldoPenyisihanGL(db, penyisihanAccountId);

    let penyisihanTopUpJournalId: string | null = null;
    let penyisihanTopUpJumlah = 0;
    if (writeOffTotal > penyisihanTersedia) {
      const kekurangan = writeOffTotal - penyisihanTersedia;
      if (!params.topUpPenyisihanJikaKurang) {
        throw new Error(
          `Saldo Penyisihan Piutang Tak Tertagih (Rp${penyisihanTersedia.toLocaleString('id-ID')}) tidak cukup untuk menutup write-off ` +
            `(Rp${writeOffTotal.toLocaleString('id-ID')}, kekurangan Rp${kekurangan.toLocaleString('id-ID')}). ` +
            `Naikkan penyisihan lebih dulu (menu Kolektibilitas Piutang), atau panggil ulang dengan topUpPenyisihanJikaKurang: true ` +
            `untuk menambah penyisihan secara otomatis sebelum write-off (Dr Beban Penyisihan / Cr Penyisihan Piutang, mapping existing).`
        );
      }
      const bebanPenyisihanAccountId = await resolveAccountId(db, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN');
      const year0 = new Date(params.tanggal).getFullYear();
      const nomorTopUp = await nextSequence(db, 'PYS', year0);
      const topUp = await createJournal(db, {
        tanggal: params.tanggal,
        sumberTransaksi: 'PENYISIHAN_PIUTANG',
        sumberId: params.pinjamanId,
        nomorReferensi: nomorTopUp,
        deskripsi: `Penambahan penyisihan piutang sebelum write-off pinjaman ${pinjaman.nomor_pinjaman} (kekurangan) - ${nomorTopUp}`,
        createdBy: params.createdBy,
        lines: [
          { accountId: bebanPenyisihanAccountId, debit: kekurangan, kredit: 0 },
          { accountId: penyisihanAccountId, debit: 0, kredit: kekurangan },
        ],
      });
      penyisihanTopUpJournalId = topUp.journalId;
      penyisihanTopUpJumlah = kekurangan;
    }

    // §F: jurnal write-off — TOTAL CREDIT per akun TIDAK PERNAH
    // melebihi saldo yang sungguhan tersedia (writeOffPrincipal &
    // writeOffJasa berasal langsung dari saldo GL/schedule aktual,
    // bukan angka yang bisa lebih besar dari itu).
    const piutangJasaAccountId = await resolveAccountId(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA');
    const lines: JournalLineInput[] = [
      { accountId: penyisihanAccountId, debit: writeOffTotal, kredit: 0 },
    ];
    if (writeOffPrincipal > 0) lines.push({ accountId: piutangPokokAccountId, debit: 0, kredit: writeOffPrincipal });
    if (writeOffJasa > 0) lines.push({ accountId: piutangJasaAccountId, debit: 0, kredit: writeOffJasa });

    const year = new Date(params.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'PHP', year);

    const { journalId } = await createJournal(db, {
      tanggal: params.tanggal,
      sumberTransaksi: 'PENGHAPUSAN_PIUTANG',
      sumberId: params.pinjamanId,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Penghapusan piutang pinjaman ${pinjaman.nomor_pinjaman} (RAT) - ${params.alasan}`,
      createdBy: params.createdBy,
      lines,
    });

    // §D/§F: kurangi Piutang Jasa yang di-write-off dari
    // pinjaman_akuntansi_jasa (FIFO, TERPISAH dari kas_diterima —
    // ini BUKAN penerimaan kas), supaya hitungOutstandingPiutangJasa
    // ke depannya sudah mencerminkan write-off ini.
    if (writeOffJasa > 0) {
      await terapkanWriteOffKePiutangJasa(db, params.pinjamanId, writeOffJasa);
    }

    // §I: HANYA baris yang masih aktif (BELUM_BAYAR/SEBAGIAN) ditandai
    // DIHAPUSBUKU — histori TIDAK PERNAH dihapus, baris LUNAS tetap
    // LUNAS apa adanya.
    const now = new Date().toISOString();
    await db.runAsync(
      // BUG-08/BUG-12: seluruh jadwal CURRENT (termasuk 'TERLAMBAT')
      // ikut dihapusbukukan — kalau tidak, sisa baris current akan tetap
      // menghasilkan outstanding & akrual untuk pinjaman yang sudah
      // di-write-off.
      `UPDATE angsuran_jadwal SET status = 'DIHAPUSBUKU'
       WHERE pinjaman_id = ? AND ${sqlJadwalCurrent('angsuran_jadwal')}`,
      params.pinjamanId
    );

    // §J: status MACET menghentikan accrual bulanan otomatis — Phase 2
    // sudah menolak akrual untuk pinjaman.status !== 'AKTIF' (lihat
    // AkrualJasaPinjamanService.prosesAkrualJasaPinjaman), jadi TIDAK
    // ADA perubahan diperlukan di sana; boundary non-accrual (Phase 2
    // KOREKSI) juga TIDAK disentuh.
    await db.runAsync(
      `UPDATE pinjaman SET status = 'MACET', updated_at = ? WHERE id = ?`,
      now,
      params.pinjamanId
    );

    // PHASE 7 FINAL FIX (permintaan pengguna §2) — DERECOGNITION EIR
    // OTOMATIS, BAGIAN ATOMIC dari transaksi write-off yang SAMA
    // (bukan dipanggil terpisah). No-op kalau pinjaman ini bukan
    // pinjaman ber-EIR. §6: TIDAK membaca/menulis-off future
    // contractual jasa — hanya sisa fee integral yang benar-benar
    // belum teramortisasi, dari accounting schedule EIR yang
    // sebenarnya (getEirTersimpan), BUKAN dari `total - pokok_terbayar
    // - jasa_terbayar` (pola lama yang sudah diperbaiki Phase 3).
    const hasilEir = await deselesaikanFeeEirDiDalamTransaksi(db, {
      pinjamanId: params.pinjamanId,
      tanggal: params.tanggal,
      alasan: 'WRITE_OFF',
      createdBy: params.createdBy,
    });

    return {
      journalId,
      nomorTransaksi,
      writeOffPrincipal,
      writeOffJasa,
      writeOffTotal,
      penyisihanTopUpJournalId,
      penyisihanTopUpJumlah,
      eirFeeDiselesaikan: hasilEir.jumlahDiakui,
    };
  });
}

/** Daftar tunggakan lintas anggota — angsuran lewat jatuh tempo & belum lunas (PRD §12-13). */
export async function listTunggakan(): Promise<TunggakanItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT p.id as pinjaman_id, p.nomor_pinjaman, a.nama_lengkap, aj.nomor_angsuran,
            aj.tanggal_jatuh_tempo, aj.total, aj.pokok_terbayar, aj.jasa_terbayar,
            julianday('now') - julianday(aj.tanggal_jatuh_tempo) as hari_terlambat
     FROM angsuran_jadwal aj
     JOIN pinjaman p ON p.id = aj.pinjaman_id
     JOIN anggota a ON a.id = p.anggota_id
     WHERE p.status = 'AKTIF' AND ${sqlJadwalCurrent('aj')} AND aj.tanggal_jatuh_tempo < date('now')
     ORDER BY aj.tanggal_jatuh_tempo ASC`
  );
  return rows.map((r) => ({
    pinjamanId: r.pinjaman_id,
    nomorPinjaman: r.nomor_pinjaman,
    namaAnggota: r.nama_lengkap,
    nomorAngsuran: r.nomor_angsuran,
    tanggalJatuhTempo: r.tanggal_jatuh_tempo,
    sisaTagihan: r.total - r.pokok_terbayar - r.jasa_terbayar,
    hariTerlambat: Math.floor(r.hari_terlambat),
  }));
}


// ===========================================================================
// RC-S54 item 24 & 25 — TUJUAN PINJAMAN & AGUNAN
// ===========================================================================

/**
 * Validasi tujuan pinjaman. Detail HANYA wajib — dan hanya disimpan —
 * saat tujuannya 'LAINNYA'; untuk tiga pilihan lain detail dibuang,
 * supaya tidak ada teks bebas yang menempel tanpa arti.
 */
export function validasiTujuanPinjaman(input: {
  tujuanPinjaman?: TujuanPinjaman;
  tujuanDetail?: string;
}): { tujuanPinjaman: TujuanPinjaman | null; tujuanDetail: string | null } {
  const tujuan = input.tujuanPinjaman;
  // TIDAK DIISI = null, bukan error.
  //
  // Kewajiban mengisi tujuan ditegakkan di FORM Ajukan Pinjaman
  // (`wajibkanTujuanPinjaman()` di bawah), bukan di sini. Alasannya
  // konkret: `ajukanPinjaman()` dipanggil oleh banyak jalur lain —
  // termasuk seluruh fixture uji modul pinjaman, EIR, dan angsuran —
  // yang tidak berurusan dengan tujuan sama sekali. Menolak mereka
  // berarti mengubah perilaku modul yang tidak diminta berubah, dan
  // pinjaman lama pun memang tidak pernah punya nilai ini.
  //
  // Yang TETAP ditegakkan di service: bila tujuan DIISI, nilainya harus
  // dikenal, dan 'LAINNYA' wajib membawa detail.
  if (!tujuan) return { tujuanPinjaman: null, tujuanDetail: null };
  if (!(tujuan in LABEL_TUJUAN_PINJAMAN)) {
    throw new Error(`Tujuan pinjaman "${tujuan}" tidak dikenal.`);
  }
  if (tujuan === 'LAINNYA') {
    const detail = (input.tujuanDetail ?? '').trim();
    if (!detail) throw new Error('Detail tujuan wajib diisi bila tujuan pinjaman "Lainnya".');
    return { tujuanPinjaman: tujuan, tujuanDetail: detail };
  }
  return { tujuanPinjaman: tujuan, tujuanDetail: null };
}

/** Validasi agunan. `undefined` berarti "Tidak Ada" dan itu sah. */
export function validasiAgunan(agunan?: AgunanInput): AgunanInput | null {
  if (!agunan) return null;
  if (!(agunan.jenisAgunan in LABEL_JENIS_AGUNAN)) {
    throw new Error('Jenis agunan wajib dipilih.');
  }
  const pemilik = (agunan.pemilik ?? '').trim();
  const nomorDokumen = (agunan.nomorDokumen ?? '').trim();
  if (!pemilik) throw new Error('Pemilik agunan wajib diisi.');
  if (!nomorDokumen) throw new Error('Nomor dokumen agunan wajib diisi.');
  if (!Number.isFinite(agunan.nilaiAgunan) || agunan.nilaiAgunan < 0) {
    throw new Error('Nilai agunan wajib diisi dan tidak boleh negatif.');
  }
  if (!Number.isInteger(agunan.nilaiAgunan)) {
    throw new Error('Nilai agunan harus bilangan bulat rupiah penuh.');
  }
  return { ...agunan, pemilik, nomorDokumen };
}

/** Agunan sebuah pinjaman — kosong berarti pinjaman tanpa agunan. */
export async function getAgunanPinjaman(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string
): Promise<AgunanRow[]> {
  const rows = await db.getAllAsync<Record<string, string | number>>(
    `SELECT * FROM pinjaman_agunan WHERE pinjaman_id = ? ORDER BY created_at`,
    pinjamanId
  );
  return rows.map((r) => ({
    id: r.id as string,
    pinjamanId: r.pinjaman_id as string,
    jenisAgunan: r.jenis_agunan as JenisAgunan,
    pemilik: r.pemilik as string,
    nomorDokumen: r.nomor_dokumen as string,
    nilaiAgunan: r.nilai_agunan as number,
    keterangan: (r.keterangan as string) ?? undefined,
  }));
}

/** Tujuan pinjaman tersimpan — null untuk pinjaman lama sebelum v65. */
export async function getTujuanPinjaman(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string
): Promise<{ tujuanPinjaman: TujuanPinjaman | null; tujuanDetail: string | null }> {
  const row = await db.getFirstAsync<{ tujuan_pinjaman: string | null; tujuan_detail: string | null }>(
    `SELECT tujuan_pinjaman, tujuan_detail FROM pinjaman WHERE id = ?`,
    pinjamanId
  );
  if (!row) throw new Error('Pinjaman tidak ditemukan.');
  return {
    tujuanPinjaman: (row.tujuan_pinjaman as TujuanPinjaman | null) ?? null,
    tujuanDetail: row.tujuan_detail ?? null,
  };
}

/**
 * Gerbang kewajiban untuk FORM Ajukan Pinjaman: di sini tujuan memang
 * WAJIB. Dipisah dari `validasiTujuanPinjaman()` supaya kewajiban itu
 * berlaku tepat di tempat pengguna mengisinya, tanpa memaksa setiap
 * pemanggil programatik ikut menyediakannya.
 */
export function wajibkanTujuanPinjaman(input: {
  tujuanPinjaman?: TujuanPinjaman;
  tujuanDetail?: string;
}): { tujuanPinjaman: TujuanPinjaman; tujuanDetail: string | null } {
  if (!input.tujuanPinjaman) throw new Error('Tujuan pinjaman wajib dipilih.');
  const hasil = validasiTujuanPinjaman(input);
  return { tujuanPinjaman: hasil.tujuanPinjaman as TujuanPinjaman, tujuanDetail: hasil.tujuanDetail };
}
