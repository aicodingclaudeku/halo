import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, assertAccountingPeriodOpen } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { newId } from '@/utils/id';
import { getSelisihRevaluasiAsetPadaDb } from '@/services/PenyusutanService';

type Rupiah = number;

/**
 * RC-S54 TAHAP 16 — GAP 6: PELEPASAN (DERECOGNITION) ASET TETAP.
 *
 * DUA OPERASI TERPISAH:
 *  - KOREKSI_SALAH_INPUT   : `AsetService.hapusAset` — reversal jurnal perolehan, hanya untuk
 *    aset yang BELUM disusutkan; bukan penjualan, tanpa laba/rugi.
 *  - PELEPASAN_ASET_TETAP  : fungsi di berkas ini — event baru pada tanggal pelepasan.
 *
 * Nilai buku (NBV) = biaya perolehan (C) − akumulasi penyusutan s.d. tanggal pelepasan (A),
 * dari register `aset_penyusutan` + jurnalnya (tanpa engine penyusutan baru).
 * Laba/rugi = hasil (H) − NBV.
 *
 *     Dr Kas/Bank                              H          (bila H > 0)
 *     Dr Akumulasi penyusutan (per akun kredit jurnal penyusutan aset INI)   A
 *     Dr Kerugian Pelepasan Aset Tetap (PELEPASAN_ASET_TETAP/DEBIT_RUGI)     NBV − H  (bila rugi)
 *        Cr Akun aset (akun debit jurnal perolehan aset INI)                C
 *        Cr Laba (PELEPASAN_ASET_TETAP/KREDIT_LABA)                         H − NBV  (bila laba)
 *
 * RC-S88 — aset yang pernah DIREVALUASI: akumulasi selisih revaluasi (R, akun
 * penyesuai 1-1520 milik aset INI) ikut dibersihkan dan NBV = C + R − A:
 *        Cr 1-1520  R (bila R > 0)   ·   Dr 1-1520 |R| (bila R < 0)
 * Surplus revaluasi di ekuitas (3-6000) TIDAK dilewatkan laba rugi dan tidak
 * dipindahkan otomatis (SAK EP 17 mengizinkan, tidak mewajibkan, pemindahan ke
 * saldo laba) — tetap tercatat sebagai bagian ekuitas.
 *
 * COA: laba 4-1800 Pendapatan Penjualan Aset (existing); rugi 5-2170 Kerugian Pelepasan Aset
 * Tetap (BEBAN_LAIN; audit COA tidak menemukan akun khusus existing). Disalurkan ke perangkat
 * lama oleh self-heal v67. Pratinjau & eksekusi memakai satu penyusun; eksekusi satu transaksi,
 * semua validasi sebelum penulisan pertama. Status aset `AKTIF → DIHAPUS`; semantik penutupan
 * dibedakan oleh jurnal (pelepasan vs pembalik perolehan). Register penyusutan tidak dihapus.
 */

export const SUMBER_PELEPASAN_ASET_TETAP = 'PELEPASAN_ASET_TETAP' as const;

export type KodePenolakanPelepasanAset =
  | 'ASET_TIDAK_DITEMUKAN'
  | 'SUDAH_DILEPAS'
  | 'STATUS_TIDAK_AKTIF'
  | 'JURNAL_PEROLEHAN_TIDAK_VALID'
  | 'JURNAL_PENYUSUTAN_TIDAK_VALID'
  | 'TANGGAL_TIDAK_VALID'
  | 'TANGGAL_MASA_DEPAN'
  | 'TANGGAL_SEBELUM_PEROLEHAN'
  | 'ADA_PENYUSUTAN_SETELAH_TANGGAL_PELEPASAN'
  | 'ADA_REVALUASI_SETELAH_TANGGAL_PELEPASAN'
  | 'PERIODE_CLOSED'
  | 'HASIL_TIDAK_VALID'
  | 'REKENING_WAJIB';

export class PelepasanAsetTetapDitolakError extends Error {
  constructor(readonly kode: KodePenolakanPelepasanAset, pesan: string) {
    super(`${kode}: ${pesan}`);
    this.name = 'PelepasanAsetTetapDitolakError';
  }
}

export interface PelepasanAsetTetapInput {
  asetId: string;
  tanggalPelepasan: string;
  /** Rupiah bulat >= 0; TIDAK pernah diambil dari biaya perolehan. */
  hasilPelepasan: number;
  sumberDana?: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
}

export interface BarisJurnalPelepasanAset {
  peran: 'KAS_BANK' | 'AKUMULASI' | 'RUGI' | 'ASET' | 'SELISIH_REVALUASI' | 'LABA';
  accountId: string;
  kode: string;
  nama: string;
  debit: Rupiah;
  kredit: Rupiah;
}

export interface PratinjauPelepasanAsetTetap {
  jenisOperasi: 'PELEPASAN_ASET_TETAP';
  asetId: string;
  nomorAset: string;
  namaAset: string;
  tanggalPerolehan: string;
  tanggalPelepasan: string;
  biayaPerolehan: Rupiah;
  akumulasiPenyusutan: Rupiah;
  /** RC-S88 — akumulasi selisih revaluasi aset ini (bertanda; 0 bila tidak pernah direvaluasi). */
  selisihRevaluasi: Rupiah;
  nilaiBuku: Rupiah;
  statusPenyusutan: 'BELUM_DISUSUTKAN' | 'SEBAGIAN' | 'PENUH';
  hasilPelepasan: Rupiah;
  selisih: Rupiah;
  jenisSelisih: 'LABA' | 'IMPAS' | 'RUGI';
  rekeningAccountId: string | null;
  baris: BarisJurnalPelepasanAset[];
}

interface Kueri {
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
}
const kueri = (db: SQLite.SQLiteDatabase) => db as unknown as Kueri;

/** Jumlah revaluasi DIPOSTING bertanggal setelah `tgl` (0 bila tabel/kolom belum ada). */
async function getRevaluasiSesudah(q: Kueri, asetId: string, tgl: string): Promise<number> {
  try {
    const r = await q.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM penyesuaian_nilai_wajar
        WHERE objek = 'ASET_TETAP' AND aset_tetap_id = ? AND status = 'DIPOSTING' AND tanggal > ?`,
      asetId, tgl
    );
    return r?.n ?? 0;
  } catch (e) {
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return 0;
    throw e;
  }
}

async function susunPelepasanAset(db: SQLite.SQLiteDatabase, input: PelepasanAsetTetapInput): Promise<PratinjauPelepasanAsetTetap> {
  const q = kueri(db);
  const aset = await q.getFirstAsync<{ id: string; nomor_aset: string; nama_aset: string; nilai_perolehan: number; nilai_residu: number; tanggal_perolehan: string; journal_id: string | null; status: string | null }>(
    `SELECT id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, tanggal_perolehan, journal_id, status FROM aset_tetap WHERE id = ?`,
    input.asetId
  );
  if (!aset) throw new PelepasanAsetTetapDitolakError('ASET_TIDAK_DITEMUKAN', 'Aset tidak ditemukan.');
  const sudah = await q.getFirstAsync<{ id: string }>(
    `SELECT id FROM journal WHERE sumber_transaksi = ? AND sumber_id = ? AND status IN ('POSTED','REVERSED') LIMIT 1`,
    SUMBER_PELEPASAN_ASET_TETAP, aset.id
  );
  if (sudah) throw new PelepasanAsetTetapDitolakError('SUDAH_DILEPAS', `"${aset.nama_aset}" sudah dilepas; pelepasan kedua ditolak.`);
  if ((aset.status ?? 'AKTIF') !== 'AKTIF') {
    throw new PelepasanAsetTetapDitolakError('STATUS_TIDAK_AKTIF', `"${aset.nama_aset}" berstatus ${aset.status}; hanya aset AKTIF yang dapat dilepas.`);
  }

  const tgl = input.tanggalPelepasan;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl) || Number.isNaN(Date.parse(tgl))) {
    throw new PelepasanAsetTetapDitolakError('TANGGAL_TIDAK_VALID', `Tanggal pelepasan "${tgl}" tidak valid (YYYY-MM-DD).`);
  }
  const hariIni = getTanggalLokalHariIni();
  if (tgl > hariIni) throw new PelepasanAsetTetapDitolakError('TANGGAL_MASA_DEPAN', `Tanggal pelepasan ${tgl} setelah hari ini (${hariIni}).`);
  const tglPerolehan = aset.tanggal_perolehan.slice(0, 10);
  if (tgl < tglPerolehan) throw new PelepasanAsetTetapDitolakError('TANGGAL_SEBELUM_PEROLEHAN', `Tanggal pelepasan ${tgl} sebelum tanggal perolehan ${tglPerolehan}.`);
  const sesudah = await q.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM aset_penyusutan WHERE aset_id = ? AND tanggal > ?`, aset.id, tgl);
  if ((sesudah?.n ?? 0) > 0) {
    throw new PelepasanAsetTetapDitolakError('ADA_PENYUSUTAN_SETELAH_TANGGAL_PELEPASAN', `Ada penyusutan bertanggal setelah ${tgl}; pilih tanggal pada/setelah penyusutan terakhir.`);
  }
  const periode = await q.getFirstAsync<{ status: string }>(
    `SELECT status FROM accounting_period WHERE periode_mulai <= ? AND periode_selesai >= ? ORDER BY periode_mulai DESC LIMIT 1`, tgl, tgl
  );
  if (periode?.status === 'CLOSED') throw new PelepasanAsetTetapDitolakError('PERIODE_CLOSED', `Periode akuntansi untuk ${tgl} sudah CLOSED.`);

  // Jurnal perolehan & akun aset milik aset INI.
  const C = aset.nilai_perolehan;
  const jPerolehan = aset.journal_id ? await q.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, aset.journal_id) : null;
  if (!jPerolehan || jPerolehan.status !== 'POSTED') {
    throw new PelepasanAsetTetapDitolakError('JURNAL_PEROLEHAN_TIDAK_VALID', 'Jurnal perolehan aset tidak ada atau tidak POSTED.');
  }
  const akunAset = await q.getFirstAsync<{ account_id: string }>(
    `SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit = ? ORDER BY id LIMIT 1`, aset.journal_id, C
  );
  if (!akunAset) throw new PelepasanAsetTetapDitolakError('JURNAL_PEROLEHAN_TIDAK_VALID', 'Baris debit aset sebesar biaya perolehan tidak ditemukan pada jurnal perolehan.');

  // Akumulasi penyusutan milik aset INI s.d. tanggal pelepasan, per akun kredit jurnal penyusutannya.
  const register = await q.getFirstAsync<{ t: number }>(`SELECT COALESCE(SUM(nilai_penyusutan),0) AS t FROM aset_penyusutan WHERE aset_id = ? AND tanggal <= ?`, aset.id, tgl);
  const A = register?.t ?? 0;
  const perAkun = await q.getAllAsync<{ account_id: string; total: number }>(
    `SELECT je.account_id AS account_id, SUM(je.kredit) AS total
       FROM aset_penyusutan p
       JOIN journal j ON j.id = p.journal_id AND j.status = 'POSTED'
       JOIN journal_entry je ON je.journal_id = p.journal_id AND je.kredit > 0
      WHERE p.aset_id = ? AND p.tanggal <= ?
      GROUP BY je.account_id ORDER BY je.account_id`,
    aset.id, tgl
  );
  if (perAkun.reduce((t, r) => t + r.total, 0) !== A) {
    throw new PelepasanAsetTetapDitolakError('JURNAL_PENYUSUTAN_TIDAK_VALID', 'Jurnal penyusutan aset tidak cocok dengan register (tidak POSTED atau nilai berbeda).');
  }
  // RC-S88 — selisih revaluasi yang diposting s.d. tanggal pelepasan.
  const revalSesudah = await getRevaluasiSesudah(q, aset.id, tgl);
  if (revalSesudah > 0) {
    throw new PelepasanAsetTetapDitolakError('ADA_REVALUASI_SETELAH_TANGGAL_PELEPASAN', `Ada revaluasi bertanggal setelah ${tgl}; pilih tanggal pada/setelah revaluasi terakhir.`);
  }
  const R = await getSelisihRevaluasiAsetPadaDb(db, aset.id, tgl);
  const nilaiBuku = C + R - A;

  const H = input.hasilPelepasan;
  if (typeof H !== 'number' || !Number.isInteger(H) || H < 0) throw new PelepasanAsetTetapDitolakError('HASIL_TIDAK_VALID', 'Hasil pelepasan wajib rupiah bulat >= 0.');
  let rekeningAccountId: string | null = null;
  if (H > 0) {
    if (input.sumberDana !== 'KAS' && input.sumberDana !== 'BANK') {
      throw new PelepasanAsetTetapDitolakError('REKENING_WAJIB', 'Pilih rekening Kas/Bank penerima hasil pelepasan.');
    }
    rekeningAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
  }
  const selisih = H - nilaiBuku;

  const lines: Omit<BarisJurnalPelepasanAset, 'kode' | 'nama'>[] = [];
  if (H > 0) lines.push({ peran: 'KAS_BANK', accountId: rekeningAccountId!, debit: H, kredit: 0 });
  for (const r of perAkun) lines.push({ peran: 'AKUMULASI', accountId: r.account_id, debit: r.total, kredit: 0 });
  if (R < 0) lines.push({ peran: 'SELISIH_REVALUASI', accountId: await resolveAccountId(db, 'REVALUASI_ASET_TETAP', 'PENYESUAIAN_ASET'), debit: -R, kredit: 0 });
  if (selisih < 0) lines.push({ peran: 'RUGI', accountId: await resolveAccountId(db, SUMBER_PELEPASAN_ASET_TETAP, 'DEBIT_RUGI'), debit: -selisih, kredit: 0 });
  lines.push({ peran: 'ASET', accountId: akunAset.account_id, debit: 0, kredit: C });
  if (R > 0) lines.push({ peran: 'SELISIH_REVALUASI', accountId: await resolveAccountId(db, 'REVALUASI_ASET_TETAP', 'PENYESUAIAN_ASET'), debit: 0, kredit: R });
  if (selisih > 0) lines.push({ peran: 'LABA', accountId: await resolveAccountId(db, SUMBER_PELEPASAN_ASET_TETAP, 'KREDIT_LABA'), debit: 0, kredit: selisih });

  const baris: BarisJurnalPelepasanAset[] = [];
  for (const l of lines) {
    const a = await q.getFirstAsync<{ kode: string; nama: string }>(`SELECT kode, nama FROM account WHERE id = ?`, l.accountId);
    baris.push({ ...l, kode: a?.kode ?? '', nama: a?.nama ?? '' });
  }
  return {
    jenisOperasi: 'PELEPASAN_ASET_TETAP',
    asetId: aset.id,
    nomorAset: aset.nomor_aset,
    namaAset: aset.nama_aset,
    tanggalPerolehan: tglPerolehan,
    tanggalPelepasan: tgl,
    biayaPerolehan: C,
    akumulasiPenyusutan: A,
    selisihRevaluasi: R,
    nilaiBuku,
    statusPenyusutan: A === 0 ? 'BELUM_DISUSUTKAN' : A >= C - (aset.nilai_residu ?? 0) ? 'PENUH' : 'SEBAGIAN',
    hasilPelepasan: H,
    selisih,
    jenisSelisih: selisih > 0 ? 'LABA' : selisih < 0 ? 'RUGI' : 'IMPAS',
    rekeningAccountId,
    baris,
  };
}

/** Pratinjau read-only; validasi & baris jurnal identik dengan eksekusi. */
export async function pratinjauPelepasanAsetTetap(input: PelepasanAsetTetapInput): Promise<PratinjauPelepasanAsetTetap> {
  return susunPelepasanAset(await getDb(), input);
}

/** Eksekusi pelepasan aset tetap — satu transaksi, rollback total. */
export async function lepaskanAsetTetap(input: PelepasanAsetTetapInput): Promise<{ journalId: string; pratinjau: PratinjauPelepasanAsetTetap }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit');
    const pratinjau = await susunPelepasanAset(db, input);
    await assertAccountingPeriodOpen(db, pratinjau.tanggalPelepasan);
    const { journalId } = await createJournal(db, {
      tanggal: pratinjau.tanggalPelepasan,
      sumberTransaksi: SUMBER_PELEPASAN_ASET_TETAP,
      sumberId: pratinjau.asetId,
      nomorReferensi: pratinjau.nomorAset,
      deskripsi: `Pelepasan aset tetap - ${pratinjau.namaAset} - ${pratinjau.nomorAset}`,
      createdBy: input.createdBy,
      lines: pratinjau.baris.map((b) => ({ accountId: b.accountId, debit: b.debit, kredit: b.kredit })),
    });
    const q = kueri(db);
    const now = new Date();
    // keterangan asal aset TIDAK ditimpa.
    await q.runAsync(`UPDATE aset_tetap SET status = 'DIHAPUS', updated_at = ? WHERE id = ? AND COALESCE(status,'AKTIF') = 'AKTIF'`, now.toISOString(), pratinjau.asetId);
    const cek = await q.getFirstAsync<{ status: string }>(`SELECT status FROM aset_tetap WHERE id = ?`, pratinjau.asetId);
    if (cek?.status !== 'DIHAPUS') throw new PelepasanAsetTetapDitolakError('SUDAH_DILEPAS', 'Status aset berubah selama pelepasan; transaksi dibatalkan.');
    await q.runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(), input.createdBy, now.toISOString().slice(0, 10), now.toISOString().slice(11, 19), 'DISPOSE', 'aset_tetap', pratinjau.asetId,
      JSON.stringify({ status: 'AKTIF' }),
      JSON.stringify({
        jenisOperasi: 'PELEPASAN_ASET_TETAP', asetId: pratinjau.asetId, nomorAset: pratinjau.nomorAset, tanggalPelepasan: pratinjau.tanggalPelepasan,
        hasilPelepasan: pratinjau.hasilPelepasan, biayaPerolehan: pratinjau.biayaPerolehan, akumulasiPenyusutan: pratinjau.akumulasiPenyusutan,
        nilaiBuku: pratinjau.nilaiBuku, labaRugi: pratinjau.selisih, journalId, rekeningAccountId: pratinjau.rekeningAccountId,
        sumberDana: input.sumberDana ?? null, bankAccountId: input.bankAccountId ?? null, statusSebelum: 'AKTIF', statusSesudah: 'DIHAPUS',
        userId: input.createdBy, keterangan: input.keterangan ?? null,
      }),
      now.toISOString()
    );
    return { journalId, pratinjau };
  });
}

// ===========================================================================
// DIAGNOSTIK HISTORI — READ-ONLY
// ===========================================================================

export type KodeTemuanAsetTetap =
  | 'ASET_DIHAPUS_BELUM_DIDERECOGNISI'
  | 'ASET_DIHAPUS_JURNAL_TIDAK_DIBALIK'
  | 'AKUMULASI_PENYUSUTAN_TERSISA'
  | 'CARRYING_AMOUNT_MISMATCH'
  | 'JOURNAL_MISMATCH'
  | 'GAIN_LOSS_MISMATCH'
  | 'DOUBLE_DISPOSAL';

export interface BarisDiagnostikAsetTetap {
  readonly asetId: string;
  readonly nomorAset: string;
  readonly status: string;
  readonly biayaPerolehan: Rupiah;
  readonly akumulasiPenyusutan: Rupiah;
  readonly nilaiBukuSeharusnya: Rupiah;
  readonly nilaiBukuLedger: Rupiah;
  readonly journalPelepasanId: string | null;
  readonly temuan: readonly { kode: KodeTemuanAsetTetap; keterangan: string; nilai: Rupiah }[];
  readonly koreksiDeterministik: false;
  readonly tindakanKoreksi: 'MANUAL_REVIEW' | null;
}

/**
 * Diagnostik aset tetap per aset. Menghitung nilai buku ledger per aset dari jurnal miliknya
 * (perolehan ± pembalik, penyusutan, pelepasan) — bukan saldo global. Seluruh temuan
 * MANUAL_REVIEW: hasil/tanggal/rekening historis tidak ditebak. Tidak menulis apa pun.
 */
export async function diagnosaHistoriPelepasanAsetTetap(db: SQLite.SQLiteDatabase): Promise<readonly BarisDiagnostikAsetTetap[]> {
  const q = kueri(db);
  const asetRows = await q.getAllAsync<{ id: string; nomor_aset: string; status: string | null; nilai_perolehan: number; journal_id: string | null }>(
    `SELECT id, nomor_aset, status, nilai_perolehan, journal_id FROM aset_tetap ORDER BY nomor_aset`
  );
  const baris: BarisDiagnostikAsetTetap[] = [];
  for (const a of asetRows) {
    const temuan: { kode: KodeTemuanAsetTetap; keterangan: string; nilai: Rupiah }[] = [];
    const status = a.status ?? 'AKTIF';
    const jPer = a.journal_id ? await q.getFirstAsync<{ status: string; reversed_by_id: string | null }>(`SELECT status, reversed_by_id FROM journal WHERE id = ?`, a.journal_id) : null;
    const akunAset = a.journal_id
      ? (await q.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC LIMIT 1`, a.journal_id))?.account_id ?? null
      : null;
    const sumAkun = async (journalId: string, accountId: string) =>
      (await q.getFirstAsync<{ d: number; k: number }>(`SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k FROM journal_entry WHERE journal_id = ? AND account_id = ?`, journalId, accountId)) ?? { d: 0, k: 0 };

    let asetLedger = 0;
    let dibalik = false;
    if (a.journal_id && akunAset) {
      const e = await sumAkun(a.journal_id, akunAset);
      asetLedger += e.d - e.k;
      if (jPer?.reversed_by_id) {
        const r = await q.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, jPer.reversed_by_id);
        if (r && (r.status === 'POSTED' || r.status === 'REVERSED')) {
          const eb = await sumAkun(jPer.reversed_by_id, akunAset);
          asetLedger += eb.d - eb.k;
          dibalik = true;
        }
      }
    }
    const reg = await q.getAllAsync<{ nilai_penyusutan: number; journal_id: string }>(`SELECT nilai_penyusutan, journal_id FROM aset_penyusutan WHERE aset_id = ?`, a.id);
    const A = reg.reduce((t, r) => t + r.nilai_penyusutan, 0);
    const akmPerAkun = new Map<string, number>();
    for (const r of reg) {
      const j = await q.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, r.journal_id);
      const kred = await q.getAllAsync<{ account_id: string; kredit: number }>(`SELECT account_id, kredit FROM journal_entry WHERE journal_id = ? AND kredit > 0`, r.journal_id);
      const total = kred.reduce((t, x) => t + x.kredit, 0);
      if (!j || j.status !== 'POSTED' || total !== r.nilai_penyusutan) {
        temuan.push({ kode: 'JOURNAL_MISMATCH', keterangan: `jurnal penyusutan ${r.journal_id} tidak POSTED atau ≠ register`, nilai: r.nilai_penyusutan });
      }
      if (j && j.status === 'POSTED') for (const x of kred) akmPerAkun.set(x.account_id, (akmPerAkun.get(x.account_id) ?? 0) + x.kredit);
    }

    const disposals = await q.getAllAsync<{ id: string }>(`SELECT id FROM journal WHERE sumber_transaksi = 'PELEPASAN_ASET_TETAP' AND sumber_id = ? AND status = 'POSTED' ORDER BY id`, a.id);
    if (disposals.length > 1) temuan.push({ kode: 'DOUBLE_DISPOSAL', keterangan: `${disposals.length} jurnal pelepasan untuk satu aset`, nilai: disposals.length });
    const dispId = disposals[0]?.id ?? null;
    let labaTercatat = 0;
    let hasil = 0;
    if (dispId) {
      const tot = (await q.getFirstAsync<{ d: number; k: number }>(`SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k FROM journal_entry WHERE journal_id = ?`, dispId)) ?? { d: 0, k: 0 };
      if (tot.d !== tot.k) temuan.push({ kode: 'JOURNAL_MISMATCH', keterangan: `jurnal pelepasan tidak seimbang (${tot.d} ≠ ${tot.k})`, nilai: tot.d - tot.k });
      const eAset = akunAset ? await sumAkun(dispId, akunAset) : { d: 0, k: 0 };
      asetLedger += eAset.d - eAset.k;
      let akmDidebit = 0;
      for (const [acc] of akmPerAkun) {
        const e = await sumAkun(dispId, acc);
        akmPerAkun.set(acc, (akmPerAkun.get(acc) ?? 0) - (e.d - e.k));
        akmDidebit += e.d;
      }
      if (eAset.k - eAset.d !== a.nilai_perolehan) temuan.push({ kode: 'JOURNAL_MISMATCH', keterangan: `kredit aset jurnal pelepasan ${eAset.k - eAset.d} ≠ biaya ${a.nilai_perolehan}`, nilai: eAset.k - eAset.d - a.nilai_perolehan });
      const rugiLaba = await q.getAllAsync<{ debit: number; kredit: number; account_id: string }>(`SELECT debit, kredit, account_id FROM journal_entry WHERE journal_id = ?`, dispId);
      // hasil = debit selain akumulasi & rugi (akun rugi = baris debit yang bukan akumulasi dan bukan kas diketahui dari mapping)
      let akunRugi: string | null = null;
      let akunLaba: string | null = null;
      try { akunRugi = await resolveAccountId(db, 'PELEPASAN_ASET_TETAP', 'DEBIT_RUGI'); } catch { akunRugi = null; }
      try { akunLaba = await resolveAccountId(db, 'PELEPASAN_ASET_TETAP', 'KREDIT_LABA'); } catch { akunLaba = null; }
      const rugi = rugiLaba.filter((x) => x.account_id === akunRugi).reduce((t, x) => t + x.debit - x.kredit, 0);
      const laba = rugiLaba.filter((x) => x.account_id === akunLaba).reduce((t, x) => t + x.kredit - x.debit, 0);
      labaTercatat = laba - rugi;
      hasil = tot.d - akmDidebit - (rugi > 0 ? rugi : 0);
      const labaSeharusnya = hasil - (a.nilai_perolehan - A);
      if (labaTercatat !== labaSeharusnya) temuan.push({ kode: 'GAIN_LOSS_MISMATCH', keterangan: `laba/rugi tercatat ${labaTercatat} ≠ hasil ${hasil} − nilai buku ${a.nilai_perolehan - A}`, nilai: labaTercatat - labaSeharusnya });
    }
    const akmLedger = [...akmPerAkun.values()].reduce((t, v) => t + v, 0);
    if (status === 'AKTIF' && dispId) temuan.push({ kode: 'JOURNAL_MISMATCH', keterangan: 'jurnal pelepasan ada tetapi status aset AKTIF', nilai: 0 });
    if (status === 'DIHAPUS' && !dispId) {
      if (A > 0 && !dibalik) temuan.push({ kode: 'ASET_DIHAPUS_BELUM_DIDERECOGNISI', keterangan: 'aset DIHAPUS tanpa jurnal pelepasan; biaya & akumulasi masih di GL', nilai: a.nilai_perolehan - A });
      else if (!dibalik && jPer?.status === 'POSTED') temuan.push({ kode: 'ASET_DIHAPUS_JURNAL_TIDAK_DIBALIK', keterangan: 'aset DIHAPUS tanpa pelepasan dan tanpa pembalik perolehan', nilai: a.nilai_perolehan });
    }
    const keluar = status === 'DIHAPUS';
    if (keluar && akmLedger !== 0) temuan.push({ kode: 'AKUMULASI_PENYUSUTAN_TERSISA', keterangan: 'akumulasi penyusutan aset yang sudah keluar masih bersaldo', nilai: akmLedger });
    const nbvSeharusnya = keluar ? 0 : a.nilai_perolehan - A;
    const nbvLedger = asetLedger - akmLedger;
    if (nbvLedger !== nbvSeharusnya) temuan.push({ kode: 'CARRYING_AMOUNT_MISMATCH', keterangan: `nilai buku ledger ${nbvLedger} ≠ seharusnya ${nbvSeharusnya}`, nilai: nbvLedger - nbvSeharusnya });

    baris.push({
      asetId: a.id, nomorAset: a.nomor_aset, status, biayaPerolehan: a.nilai_perolehan, akumulasiPenyusutan: A,
      nilaiBukuSeharusnya: nbvSeharusnya, nilaiBukuLedger: nbvLedger, journalPelepasanId: dispId, temuan,
      koreksiDeterministik: false, tindakanKoreksi: temuan.length > 0 ? 'MANUAL_REVIEW' : null,
    });
  }
  return baris;
}
