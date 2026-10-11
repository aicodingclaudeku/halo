import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, assertAccountingPeriodOpen } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { getNilaiTercatatInvestasi } from '@/services/InvestasiImpairmentService';
import { SUMBER_PELEPASAN_INVESTASI, STATUS_INVESTASI_DILEPAS } from '@/services/PelepasanInvestasiService';
import { getInfoPendapatanInvestasi } from '@/services/PendapatanLainnyaService';
import { catatPemasukanPadaDb } from '@/services/KasBankService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { newId } from '@/utils/id';
import { Rupiah } from '@/utils/money';

/**
 * PENARIKAN DANA INVESTASI — SEBAGIAN & SELURUHNYA (v72).
 *
 * ATURAN (keputusan pengguna, Tahap B):
 *  - SEBAGIAN   : nilai tercatat berkurang SEBESAR dana pokok yang ditarik;
 *                 TIDAK ada untung/rugi.
 *                   Dr Kas/Bank              X
 *                      Cr Akun investasi        X
 *  - SELURUHNYA : penarikan terakhir. SISA nilai tercatat dihentikan
 *                 pengakuannya, dan selisih dana diterima vs sisa nilai
 *                 tercatat = untung/rugi — PERSIS pola jurnal
 *                 `PelepasanInvestasiService` (akun investasi, akumulasi
 *                 penyusutan, penyisihan penurunan nilai, mapping
 *                 PELEPASAN_INVESTASI KREDIT_LABA/DEBIT_RUGI), hanya saja
 *                 akun investasi dikredit sebesar biaya perolehan DIKURANGI
 *                 pokok yang sudah ditarik sebelumnya. Tanpa penarikan
 *                 sebagian sebelumnya, jurnalnya identik dengan pelepasan.
 *  - Bunga deposito (opsional, hanya Deposito Berjangka) dicatat pada
 *    TRANSAKSI DB YANG SAMA lewat jalur Pendapatan Bunga Deposito existing
 *    (`catatPemasukanPadaDb`, akun wajib 4-1510 dari
 *    `getInfoPendapatanInvestasi('BUNGA_DEPOSITO')`). Dicatat sebagai
 *    jurnal TERSENDIRI agar klasifikasi arus kas bunga (OPERASI, jalur
 *    penerimaan lain) tidak berubah menjadi INVESTASI; keduanya tetap
 *    atomik — gagal satu, batal semua.
 *
 * Jurnal pokok memakai sumber `PELEPASAN_INVESTASI` (klasifikasi arus kas
 * INVESTASI existing, sumber_id = id investasi). Status investasi tetap
 * AKTIF selama masih ada saldo; menjadi DILEPAS ("Selesai") setelah
 * penarikan SELURUHNYA. "Sebagian Ditarik" diturunkan dari tabel
 * `investasi_penarikan`, sehingga seluruh logika lama yang membaca
 * status AKTIF tidak berubah.
 *
 * Pratinjau dan eksekusi memakai SATU penyusun (`susunPenarikan`).
 */

export const JENIS_INVESTASI_DAPAT_DITARIK = ['KOPERASI_LAIN', 'USAHA_LAIN', 'DEPOSITO_BANK_UMUM'] as const;

export type ModePenarikan = 'SEBAGIAN' | 'SELURUHNYA';

export type KodePenolakanPenarikan =
  | 'INVESTASI_TIDAK_DITEMUKAN'
  | 'JENIS_TIDAK_DIDUKUNG'
  | 'SUDAH_SELESAI'
  | 'STATUS_TIDAK_AKTIF'
  | 'JURNAL_PENEMPATAN_TIDAK_VALID'
  | 'TANGGAL_TIDAK_VALID'
  | 'TANGGAL_MASA_DEPAN'
  | 'TANGGAL_SEBELUM_PEROLEHAN'
  | 'TANGGAL_SEBELUM_PENARIKAN_TERAKHIR'
  | 'ADA_TRANSAKSI_SETELAH_TANGGAL'
  | 'PERIODE_CLOSED'
  | 'NOMINAL_TIDAK_VALID'
  | 'MELEBIHI_SALDO'
  | 'BUNGA_TIDAK_VALID'
  | 'BUNGA_HANYA_DEPOSITO'
  | 'AKUN_BUNGA_TIDAK_TERSEDIA'
  | 'REKENING_WAJIB';

export class PenarikanInvestasiDitolakError extends Error {
  constructor(readonly kode: KodePenolakanPenarikan, pesan: string) {
    super(`${kode}: ${pesan}`);
    this.name = 'PenarikanInvestasiDitolakError';
  }
}

export interface PenarikanInvestasiInput {
  investasiId: string;
  tanggal: string;
  mode: ModePenarikan;
  /** Dana pokok yang diterima (Rupiah bulat). SEBAGIAN: 0 < x < saldo tersedia. SELURUHNYA: >= 0. */
  danaPokok: number;
  /** Bunga deposito yang diterima bersamaan (Rupiah bulat >= 0). Hanya Deposito Berjangka. */
  bungaDeposito?: number;
  sumberDana?: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
  /** Identitas submit (dibuat saat form dibuka) — retry dengan kunci sama tidak membuat transaksi kedua. */
  idempotencyKey?: string;
}

export interface BarisJurnalPenarikan {
  accountId: string;
  kode: string;
  nama: string;
  debit: Rupiah;
  kredit: Rupiah;
}

export interface PratinjauPenarikanInvestasi {
  investasiId: string;
  nomorInvestasi: string;
  namaTujuan: string;
  jenisInvestasi: string;
  tanggal: string;
  mode: ModePenarikan;
  biayaPerolehan: Rupiah;
  akumulasiPenyusutan: Rupiah;
  akumulasiImpairment: Rupiah;
  totalDitarikSebelumnya: Rupiah;
  /** Saldo tersedia (nilai tercatat) sebelum transaksi. */
  nilaiSebelum: Rupiah;
  /** Nilai investasi yang dikembalikan/dikurangkan oleh transaksi ini. */
  nilaiDikembalikan: Rupiah;
  danaPokok: Rupiah;
  selisih: Rupiah;
  jenisSelisih: 'LABA' | 'IMPAS' | 'RUGI';
  bungaDeposito: Rupiah;
  totalDiterima: Rupiah;
  nilaiSesudah: Rupiah;
  statusSesudah: 'AKTIF' | 'SEBAGIAN_DITARIK' | 'SELESAI';
  rekeningAccountId: string | null;
  barisPokok: BarisJurnalPenarikan[];
  barisBunga: BarisJurnalPenarikan[];
}

export interface StatusPenarikanInvestasi {
  totalDitarik: Rupiah;
  jumlahPenarikan: number;
  /** Tanggal penarikan terakhir (kronologi), null bila belum pernah. */
  tanggalTerakhir: string | null;
  status: 'AKTIF' | 'SEBAGIAN_DITARIK' | 'SELESAI' | 'DIBATALKAN';
}

const RE_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;
const bulatNonNegatif = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

async function namaAkun(db: SQLite.SQLiteDatabase, lines: { accountId: string; debit: number; kredit: number }[]) {
  const out: BarisJurnalPenarikan[] = [];
  for (const l of lines) {
    const a = await db.getFirstAsync<{ kode: string; nama: string }>(`SELECT kode, nama FROM account WHERE id = ?`, l.accountId);
    out.push({ accountId: l.accountId, kode: a?.kode ?? '', nama: a?.nama ?? '', debit: l.debit, kredit: l.kredit });
  }
  return out;
}

/** Status tampilan dari data (status tabel + riwayat penarikan). Baca-saja. */
export async function getStatusPenarikanInvestasi(investasiId: string): Promise<StatusPenarikanInvestasi> {
  const db = await getDb();
  const inv = await db.getFirstAsync<{ status: string }>(`SELECT status FROM investasi WHERE id = ?`, investasiId);
  const r = await db.getFirstAsync<{ total: number; n: number; t: string | null }>(
    `SELECT COALESCE(SUM(CASE WHEN jenis = 'SEBAGIAN' THEN pokok_ditarik ELSE 0 END), 0) AS total, COUNT(*) AS n, MAX(tanggal) AS t
       FROM investasi_penarikan WHERE investasi_id = ?`,
    investasiId
  );
  const totalDitarik = r?.total ?? 0;
  const status =
    inv?.status === STATUS_INVESTASI_DILEPAS
      ? 'SELESAI'
      : inv?.status === 'DIBATALKAN'
        ? 'DIBATALKAN'
        : (r?.n ?? 0) > 0
          ? 'SEBAGIAN_DITARIK'
          : 'AKTIF';
  return { totalDitarik, jumlahPenarikan: r?.n ?? 0, tanggalTerakhir: r?.t ?? null, status };
}

/** Peta id investasi -> jumlah penarikan (untuk badge daftar). Baca-saja. */
export async function getPetaPenarikanInvestasi(): Promise<Record<string, { totalDitarik: Rupiah; jumlah: number }>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ investasi_id: string; total: number; n: number }>(
    `SELECT investasi_id, COALESCE(SUM(CASE WHEN jenis = 'SEBAGIAN' THEN pokok_ditarik ELSE 0 END), 0) AS total, COUNT(*) AS n
       FROM investasi_penarikan GROUP BY investasi_id`
  );
  const peta: Record<string, { totalDitarik: Rupiah; jumlah: number }> = {};
  for (const r of rows) peta[r.investasi_id] = { totalDitarik: r.total, jumlah: r.n };
  return peta;
}

async function susunPenarikan(db: SQLite.SQLiteDatabase, input: PenarikanInvestasiInput): Promise<PratinjauPenarikanInvestasi> {
  const inv = await db.getFirstAsync<{
    id: string; nomor_investasi: string; nama_tujuan: string; jenis_investasi: string; jumlah: number; tanggal: string; status: string; journal_id: string | null;
  }>(
    `SELECT id, nomor_investasi, nama_tujuan, jenis_investasi, jumlah, tanggal, status, journal_id FROM investasi WHERE id = ?`,
    input.investasiId
  );
  if (!inv) throw new PenarikanInvestasiDitolakError('INVESTASI_TIDAK_DITEMUKAN', 'Investasi tidak ditemukan.');
  if (!(JENIS_INVESTASI_DAPAT_DITARIK as readonly string[]).includes(inv.jenis_investasi)) {
    throw new PenarikanInvestasiDitolakError('JENIS_TIDAK_DIDUKUNG', 'Jenis investasi ini tidak ditarik melalui modul Penarikan Dana Investasi.');
  }
  if (inv.status === STATUS_INVESTASI_DILEPAS) {
    throw new PenarikanInvestasiDitolakError('SUDAH_SELESAI', `"${inv.nama_tujuan}" sudah ditarik seluruhnya.`);
  }
  if (inv.status !== 'AKTIF') {
    throw new PenarikanInvestasiDitolakError('STATUS_TIDAK_AKTIF', `"${inv.nama_tujuan}" berstatus ${inv.status}; hanya investasi aktif yang dapat ditarik.`);
  }
  const jPenempatan = inv.journal_id ? await db.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, inv.journal_id) : null;
  if (!jPenempatan || jPenempatan.status !== 'POSTED') {
    throw new PenarikanInvestasiDitolakError('JURNAL_PENEMPATAN_TIDAK_VALID', 'Jurnal penempatan investasi tidak ada atau tidak POSTED.');
  }

  // ---- tanggal ----
  const tgl = input.tanggal;
  if (!RE_TANGGAL.test(tgl) || Number.isNaN(Date.parse(tgl))) {
    throw new PenarikanInvestasiDitolakError('TANGGAL_TIDAK_VALID', `Tanggal "${tgl}" tidak valid (YYYY-MM-DD).`);
  }
  const hariIni = getTanggalLokalHariIni();
  if (tgl > hariIni) throw new PenarikanInvestasiDitolakError('TANGGAL_MASA_DEPAN', `Tanggal ${tgl} setelah hari ini (${hariIni}).`);
  if (tgl < inv.tanggal.slice(0, 10)) {
    throw new PenarikanInvestasiDitolakError('TANGGAL_SEBELUM_PEROLEHAN', `Tanggal ${tgl} sebelum tanggal penempatan ${inv.tanggal.slice(0, 10)}.`);
  }
  const terakhir = await db.getFirstAsync<{ t: string | null }>(`SELECT MAX(tanggal) AS t FROM investasi_penarikan WHERE investasi_id = ?`, inv.id);
  if (terakhir?.t && tgl < terakhir.t) {
    throw new PenarikanInvestasiDitolakError('TANGGAL_SEBELUM_PENARIKAN_TERAKHIR', `Tanggal ${tgl} sebelum penarikan terakhir (${terakhir.t}).`);
  }
  const sesudah = await db.getFirstAsync<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM investasi_penyusutan WHERE investasi_id = ? AND tanggal > ?)
          + (SELECT COUNT(*) FROM investasi_impairment WHERE investasi_id = ? AND tanggal > ?) AS n`,
    inv.id, tgl, inv.id, tgl
  );
  if ((sesudah?.n ?? 0) > 0) {
    throw new PenarikanInvestasiDitolakError('ADA_TRANSAKSI_SETELAH_TANGGAL', `Ada penyusutan/penurunan nilai bertanggal setelah ${tgl}.`);
  }
  const periode = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM accounting_period WHERE periode_mulai <= ? AND periode_selesai >= ? ORDER BY periode_mulai DESC LIMIT 1`,
    tgl, tgl
  );
  if (periode?.status === 'CLOSED') {
    throw new PenarikanInvestasiDitolakError('PERIODE_CLOSED', `Periode akuntansi untuk ${tgl} sudah CLOSED.`);
  }

  // ---- nilai (fungsi existing, sudah memperhitungkan penarikan sebagian) ----
  const nilai = await getNilaiTercatatInvestasi(db, inv.id, tgl);
  const nilaiSebelum = nilai.nilaiTercatat;

  // ---- nominal ----
  const X = input.danaPokok;
  if (!bulatNonNegatif(X)) throw new PenarikanInvestasiDitolakError('NOMINAL_TIDAK_VALID', 'Dana pokok wajib rupiah bulat, tidak negatif.');
  if (input.mode === 'SEBAGIAN') {
    if (X <= 0) throw new PenarikanInvestasiDitolakError('NOMINAL_TIDAK_VALID', 'Penarikan sebagian harus lebih dari 0.');
    if (X >= nilaiSebelum) {
      throw new PenarikanInvestasiDitolakError(
        'MELEBIHI_SALDO',
        `Penarikan sebagian harus lebih kecil dari saldo tersedia (${nilaiSebelum}). Untuk menarik seluruh saldo, pilih penarikan seluruhnya.`
      );
    }
  }
  const B = input.bungaDeposito ?? 0;
  if (!bulatNonNegatif(B)) throw new PenarikanInvestasiDitolakError('BUNGA_TIDAK_VALID', 'Bunga deposito wajib rupiah bulat, tidak negatif.');
  if (B > 0 && inv.jenis_investasi !== 'DEPOSITO_BANK_UMUM') {
    throw new PenarikanInvestasiDitolakError('BUNGA_HANYA_DEPOSITO', 'Bunga hanya dapat dicatat bersama pencairan Deposito Berjangka.');
  }

  const totalDiterima = X + B;
  let rekeningAccountId: string | null = null;
  if (totalDiterima > 0) {
    if (input.sumberDana !== 'KAS' && input.sumberDana !== 'BANK') {
      throw new PenarikanInvestasiDitolakError('REKENING_WAJIB', 'Pilih akun Kas/Bank penerima.');
    }
    if (input.sumberDana === 'BANK' && !input.bankAccountId) {
      throw new PenarikanInvestasiDitolakError('REKENING_WAJIB', 'Pilih rekening bank penerima.');
    }
    rekeningAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
  }

  // Akun investasi = akun debit jurnal penempatan investasi INI (pola pelepasan).
  const akunAset = await db.getFirstAsync<{ account_id: string }>(
    `SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit = ? ORDER BY id LIMIT 1`,
    inv.journal_id, inv.jumlah
  );
  if (!akunAset) throw new PenarikanInvestasiDitolakError('JURNAL_PENEMPATAN_TIDAK_VALID', 'Baris aset jurnal penempatan tidak ditemukan.');

  // ---- jurnal pokok ----
  const lines: { accountId: string; debit: number; kredit: number }[] = [];
  let nilaiDikembalikan: number;
  let selisih = 0;
  if (input.mode === 'SEBAGIAN') {
    nilaiDikembalikan = X;
    lines.push({ accountId: rekeningAccountId!, debit: X, kredit: 0 });
    lines.push({ accountId: akunAset.account_id, debit: 0, kredit: X });
  } else {
    const C = nilai.nilaiAwal - nilai.totalDitarik; // saldo akun investasi (gross) tersisa
    const A = nilai.akumulasiPenyusutan;
    const I = nilai.akumulasiImpairment;
    nilaiDikembalikan = nilaiSebelum;
    selisih = X - nilaiSebelum;
    if (X > 0) lines.push({ accountId: rekeningAccountId!, debit: X, kredit: 0 });
    if (A > 0) lines.push({ accountId: await resolveAccountId(db, 'PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI'), debit: A, kredit: 0 });
    if (I > 0) lines.push({ accountId: await resolveAccountId(db, 'IMPAIRMENT_INVESTASI', 'KREDIT_PENYISIHAN'), debit: I, kredit: 0 });
    if (selisih < 0) lines.push({ accountId: await resolveAccountId(db, SUMBER_PELEPASAN_INVESTASI, 'DEBIT_RUGI'), debit: -selisih, kredit: 0 });
    lines.push({ accountId: akunAset.account_id, debit: 0, kredit: C });
    if (selisih > 0) lines.push({ accountId: await resolveAccountId(db, SUMBER_PELEPASAN_INVESTASI, 'KREDIT_LABA'), debit: 0, kredit: selisih });
  }

  // ---- jurnal bunga (pratinjau; eksekusi lewat catatPemasukanPadaDb) ----
  let barisBunga: BarisJurnalPenarikan[] = [];
  if (B > 0) {
    const info = await getInfoPendapatanInvestasi('BUNGA_DEPOSITO');
    if (!info.akun) throw new PenarikanInvestasiDitolakError('AKUN_BUNGA_TIDAK_TERSEDIA', info.masalah ?? 'Akun pendapatan bunga deposito tidak tersedia.');
    barisBunga = await namaAkun(db, [
      { accountId: rekeningAccountId!, debit: B, kredit: 0 },
      { accountId: info.akun.accountId, debit: 0, kredit: B },
    ]);
  }

  return {
    investasiId: inv.id,
    nomorInvestasi: inv.nomor_investasi,
    namaTujuan: inv.nama_tujuan,
    jenisInvestasi: inv.jenis_investasi,
    tanggal: tgl,
    mode: input.mode,
    biayaPerolehan: nilai.nilaiAwal,
    akumulasiPenyusutan: nilai.akumulasiPenyusutan,
    akumulasiImpairment: nilai.akumulasiImpairment,
    totalDitarikSebelumnya: nilai.totalDitarik,
    nilaiSebelum,
    nilaiDikembalikan,
    danaPokok: X,
    selisih,
    jenisSelisih: selisih > 0 ? 'LABA' : selisih < 0 ? 'RUGI' : 'IMPAS',
    bungaDeposito: B,
    totalDiterima,
    nilaiSesudah: input.mode === 'SEBAGIAN' ? nilaiSebelum - X : 0,
    statusSesudah: input.mode === 'SEBAGIAN' ? 'SEBAGIAN_DITARIK' : 'SELESAI',
    rekeningAccountId,
    barisPokok: await namaAkun(db, lines),
    barisBunga,
  };
}

/** Pratinjau baca-saja; validasi identik dengan eksekusi. */
export async function pratinjauPenarikanInvestasi(input: PenarikanInvestasiInput): Promise<PratinjauPenarikanInvestasi> {
  return susunPenarikan(await getDb(), input);
}

/** Eksekusi: SATU transaksi DB — jurnal pokok, (jurnal bunga), baris penarikan, status, audit. */
export async function catatPenarikanInvestasi(
  input: PenarikanInvestasiInput
): Promise<{ id: string; journalId: string; journalBungaId: string | null; pratinjau: PratinjauPenarikanInvestasi; duplikat: boolean }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit');

    // Idempotensi: kunci submit yang sama tidak membuat transaksi kedua.
    if (input.idempotencyKey) {
      const ada = await db.getFirstAsync<{ id: string; journal_id: string; journal_bunga_id: string | null }>(
        `SELECT id, journal_id, journal_bunga_id FROM investasi_penarikan WHERE idempotency_key = ?`,
        input.idempotencyKey
      );
      if (ada) {
        const pratinjau = await susunPenarikanRingkasDariRiwayat(db, ada.id);
        return { id: ada.id, journalId: ada.journal_id, journalBungaId: ada.journal_bunga_id, pratinjau, duplikat: true };
      }
    }

    const p = await susunPenarikan(db, input);
    await assertAccountingPeriodOpen(db, p.tanggal);

    const { journalId } = await createJournal(db, {
      tanggal: p.tanggal,
      sumberTransaksi: SUMBER_PELEPASAN_INVESTASI,
      sumberId: p.investasiId,
      nomorReferensi: p.nomorInvestasi,
      deskripsi:
        (p.mode === 'SEBAGIAN' ? 'Penarikan sebagian investasi' : 'Penarikan seluruh investasi') +
        ` - ${p.namaTujuan} - ${p.nomorInvestasi}`,
      createdBy: input.createdBy,
      lines: p.barisPokok.map((b) => ({ accountId: b.accountId, debit: b.debit, kredit: b.kredit })),
    });

    let journalBungaId: string | null = null;
    if (p.bungaDeposito > 0) {
      const info = await getInfoPendapatanInvestasi('BUNGA_DEPOSITO');
      if (!info.akun) throw new PenarikanInvestasiDitolakError('AKUN_BUNGA_TIDAK_TERSEDIA', info.masalah ?? 'Akun pendapatan bunga deposito tidak tersedia.');
      const r = await catatPemasukanPadaDb(db, {
        jenis: input.sumberDana === 'BANK' ? 'BANK' : 'KAS',
        bankAccountId: input.sumberDana === 'BANK' ? input.bankAccountId : undefined,
        tanggal: p.tanggal,
        nominal: p.bungaDeposito,
        akunLawanId: info.akun.accountId,
        kategori: info.label,
        keterangan: `${info.label} — Sumber: ${p.nomorInvestasi} · ${p.namaTujuan} (bersama pencairan)`,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}|BUNGA` : undefined,
      });
      journalBungaId = r.journalId;
    }

    const id = newId();
    const now = new Date();
    await db.runAsync(
      `INSERT INTO investasi_penarikan
        (id, investasi_id, tanggal, jenis, pokok_ditarik, dana_diterima, selisih, bunga_diterima, sumber_dana, bank_account_id,
         journal_id, journal_bunga_id, keterangan, idempotency_key, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, p.investasiId, p.tanggal, p.mode, p.nilaiDikembalikan, p.danaPokok, p.selisih, p.bungaDeposito,
      p.totalDiterima > 0 ? input.sumberDana ?? null : null,
      input.sumberDana === 'BANK' ? input.bankAccountId ?? null : null,
      journalId, journalBungaId, input.keterangan?.trim() || null, input.idempotencyKey ?? null,
      input.createdBy, now.toISOString()
    );

    if (p.mode === 'SELURUHNYA') {
      await db.runAsync(
        `UPDATE investasi SET status = ?, updated_at = ? WHERE id = ? AND status = 'AKTIF'`,
        STATUS_INVESTASI_DILEPAS, now.toISOString(), p.investasiId
      );
      const cek = await db.getFirstAsync<{ status: string }>(`SELECT status FROM investasi WHERE id = ?`, p.investasiId);
      if (cek?.status !== STATUS_INVESTASI_DILEPAS) {
        throw new PenarikanInvestasiDitolakError('SUDAH_SELESAI', 'Status investasi berubah selama transaksi; dibatalkan.');
      }
    }

    await db.runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(), input.createdBy, now.toISOString().slice(0, 10), now.toISOString().slice(11, 19),
      p.mode === 'SELURUHNYA' ? 'DISPOSE' : 'WITHDRAW', 'investasi', p.investasiId,
      JSON.stringify({ status: 'AKTIF', nilaiTercatat: p.nilaiSebelum, totalDitarikSebelumnya: p.totalDitarikSebelumnya }),
      JSON.stringify({
        jenisOperasi: p.mode === 'SELURUHNYA' ? 'PENARIKAN_SELURUHNYA' : 'PENARIKAN_SEBAGIAN',
        penarikanId: id,
        investasiId: p.investasiId,
        tanggalPelepasan: p.tanggal,
        hasilPelepasan: p.danaPokok,
        biayaPerolehan: p.biayaPerolehan,
        akumulasiPenyusutan: p.akumulasiPenyusutan,
        akumulasiImpairment: p.akumulasiImpairment,
        nilaiTercatat: p.nilaiDikembalikan,
        labaRugi: p.selisih,
        bungaDeposito: p.bungaDeposito,
        totalDiterima: p.totalDiterima,
        journalId,
        journalBungaId,
        rekeningAccountId: p.rekeningAccountId,
        sumberDana: input.sumberDana ?? null,
        bankAccountId: input.bankAccountId ?? null,
        statusSesudah: p.statusSesudah,
        userId: input.createdBy,
        keterangan: input.keterangan ?? null,
      }),
      now.toISOString()
    );

    return { id, journalId, journalBungaId, pratinjau: p, duplikat: false };
  });
}

/** Ringkasan minimal untuk respons idempoten (dibaca dari baris tersimpan). */
async function susunPenarikanRingkasDariRiwayat(db: SQLite.SQLiteDatabase, penarikanId: string): Promise<PratinjauPenarikanInvestasi> {
  const r = await db.getFirstAsync<any>(
    `SELECT p.*, i.nomor_investasi, i.nama_tujuan, i.jenis_investasi, i.jumlah FROM investasi_penarikan p JOIN investasi i ON i.id = p.investasi_id WHERE p.id = ?`,
    penarikanId
  );
  return {
    investasiId: r.investasi_id,
    nomorInvestasi: r.nomor_investasi,
    namaTujuan: r.nama_tujuan,
    jenisInvestasi: r.jenis_investasi,
    tanggal: r.tanggal,
    mode: r.jenis,
    biayaPerolehan: r.jumlah,
    akumulasiPenyusutan: 0,
    akumulasiImpairment: 0,
    totalDitarikSebelumnya: 0,
    nilaiSebelum: 0,
    nilaiDikembalikan: r.pokok_ditarik,
    danaPokok: r.dana_diterima,
    selisih: r.selisih,
    jenisSelisih: r.selisih > 0 ? 'LABA' : r.selisih < 0 ? 'RUGI' : 'IMPAS',
    bungaDeposito: r.bunga_diterima,
    totalDiterima: r.dana_diterima + r.bunga_diterima,
    nilaiSesudah: 0,
    statusSesudah: r.jenis === 'SEBAGIAN' ? 'SEBAGIAN_DITARIK' : 'SELESAI',
    rekeningAccountId: null,
    barisPokok: [],
    barisBunga: [],
  };
}
