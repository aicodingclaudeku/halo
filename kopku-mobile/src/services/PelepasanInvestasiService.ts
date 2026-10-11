import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, assertAccountingPeriodOpen } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { getNilaiTercatatInvestasi } from '@/services/InvestasiImpairmentService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { newId } from '@/utils/id';
import { Rupiah } from '@/utils/money';

/**
 * RC-S54 TAHAP 16 — ITEM #20: PELEPASAN (DERECOGNITION) INVESTASI.
 *
 * DUA OPERASI TERPISAH (jangan dipakai bergantian):
 *  - KOREKSI_SALAH_INPUT  : `InvestasiService.batalkanInvestasi` / edit — membalik jurnal
 *    penempatan seolah tidak pernah terjadi. Hanya untuk investasi TANPA siklus akuntansi
 *    lanjutan (tanpa penyusutan/impairment). Bukan penjualan, tanpa laba/rugi.
 *  - PELEPASAN_INVESTASI  : fungsi di berkas ini — event BARU pada `tanggalPelepasan`:
 *
 *      nilai tercatat  C − A − I          (getNilaiTercatatInvestasi, per investasi)
 *      selisih         H − (C − A − I)    (> 0 laba · = 0 impas · < 0 rugi)
 *
 *      Dr Kas/Bank                    H   (bila H > 0)
 *      Dr Akumulasi Penyusutan PI     A   (bila A > 0)
 *      Dr Penyisihan Penurunan Nilai  I   (bila I > 0)
 *         Cr Akun investasi (akun debit jurnal penempatan)   C
 *         Cr Laba pelepasan (mapping PELEPASAN_INVESTASI/KREDIT_LABA)  selisih (bila laba)
 *
 *      Dr Rugi pelepasan (mapping PELEPASAN_INVESTASI/DEBIT_RUGI -> 5-2160)  |selisih| (bila rugi)
 *
 *  RC-S88 — properti investasi model NILAI WAJAR: akumulasi penyesuaian
 *  nilai wajar yang diposting (F, akun penyesuai 1-1665) ikut dibersihkan:
 *      Cr 1-1665  F (bila F > 0)   ·   Dr 1-1665 |F| (bila F < 0)
 *  dan nilai tercatat = C − A − I + F.
 *
 * Akun rugi 5-2160 "Kerugian Pelepasan Investasi" (BEBAN_LAIN) = keputusan COA pengguna,
 * disalurkan ke perangkat lama lewat self-heal v66.
 *
 * Pratinjau dan eksekusi memakai SATU fungsi penyusun (`susunPelepasan`), sehingga baris
 * jurnal yang ditampilkan identik dengan yang diposting. Seluruh eksekusi berjalan dalam
 * satu transaksi SQLite; semua validasi selesai sebelum penulisan pertama.
 *
 * Tanpa migration: status investasi 'DILEPAS' (kolom status tanpa CHECK), rincian event di
 * jurnal (sumber PELEPASAN_INVESTASI, sumber_id = id investasi) dan audit_log. Register
 * penyusutan & impairment TIDAK dihapus/diubah (histori); saldonya dibersihkan per
 * investasi oleh jurnal pelepasan, dan investasi non-AKTIF tidak dapat disusutkan /
 * diturunkan nilainya lagi (guard existing).
 */

export const SUMBER_PELEPASAN_INVESTASI = 'PELEPASAN_INVESTASI' as const;
export const STATUS_INVESTASI_DILEPAS = 'DILEPAS' as const;
export type JenisOperasiInvestasi = 'KOREKSI_SALAH_INPUT' | 'PELEPASAN_INVESTASI';

export type KodePenolakanPelepasan =
  | 'INVESTASI_TIDAK_DITEMUKAN'
  | 'SUDAH_DILEPAS'
  | 'STATUS_TIDAK_AKTIF'
  | 'JURNAL_PENEMPATAN_TIDAK_VALID'
  | 'TANGGAL_TIDAK_VALID'
  | 'TANGGAL_MASA_DEPAN'
  | 'TANGGAL_SEBELUM_PEROLEHAN'
  | 'ADA_TRANSAKSI_SETELAH_TANGGAL_PELEPASAN'
  | 'PERIODE_CLOSED'
  | 'HASIL_TIDAK_VALID'
  | 'REKENING_WAJIB'
  | 'ADA_PENARIKAN_SEBAGIAN';

export class PelepasanInvestasiDitolakError extends Error {
  constructor(readonly kode: KodePenolakanPelepasan, pesan: string) {
    super(`${kode}: ${pesan}`);
    this.name = 'PelepasanInvestasiDitolakError';
  }
}

export interface PelepasanInvestasiInput {
  investasiId: string;
  tanggalPelepasan: string;
  /** Rupiah bulat >= 0. TIDAK pernah diambil dari biaya perolehan. */
  hasilPelepasan: number;
  /** Wajib bila hasilPelepasan > 0. */
  sumberDana?: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
}

export interface BarisJurnalPelepasan {
  accountId: string;
  kode: string;
  nama: string;
  debit: Rupiah;
  kredit: Rupiah;
}

export interface PratinjauPelepasanInvestasi {
  jenisOperasi: 'PELEPASAN_INVESTASI';
  investasiId: string;
  nomorInvestasi: string;
  namaTujuan: string;
  jenisInvestasi: string;
  tanggalPelepasan: string;
  biayaPerolehan: Rupiah;
  akumulasiPenyusutan: Rupiah;
  akumulasiImpairment: Rupiah;
  /** RC-S88 — akumulasi penyesuaian nilai wajar (bertanda). */
  akumulasiPenyesuaianNilaiWajar: Rupiah;
  nilaiTercatat: Rupiah;
  hasilPelepasan: Rupiah;
  selisih: Rupiah;
  jenisSelisih: 'LABA' | 'IMPAS' | 'RUGI';
  rekeningAccountId: string | null;
  baris: BarisJurnalPelepasan[];
}

/** Adapter tipe untuk query baca/tulis (API expo-sqlite yang sama). */
interface Kueri {
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
}
const kueri = (db: SQLite.SQLiteDatabase) => db as unknown as Kueri;

const RE_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

async function susunPelepasan(db: SQLite.SQLiteDatabase, input: PelepasanInvestasiInput): Promise<PratinjauPelepasanInvestasi> {
  const q = kueri(db);
  // 1–2. investasi & status
  const inv = await q.getFirstAsync<{ id: string; nomor_investasi: string; nama_tujuan: string; jenis_investasi: string; jumlah: number; tanggal: string; status: string; journal_id: string | null }>(
    `SELECT id, nomor_investasi, nama_tujuan, jenis_investasi, jumlah, tanggal, status, journal_id FROM investasi WHERE id = ?`,
    input.investasiId
  );
  if (!inv) throw new PelepasanInvestasiDitolakError('INVESTASI_TIDAK_DITEMUKAN', 'Investasi tidak ditemukan.');
  // v72 — investasi yang sudah ditarik sebagian memakai jalur
  // PenarikanInvestasiService (nilai tercatat sisa), bukan pelepasan penuh
  // ini yang mengkredit seluruh biaya perolehan.
  const adaPenarikan = await q
    .getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM investasi_penarikan WHERE investasi_id = ?`, inv.id)
    .catch(() => null);
  if ((adaPenarikan?.n ?? 0) > 0) {
    throw new PelepasanInvestasiDitolakError(
      'ADA_PENARIKAN_SEBAGIAN',
      `"${inv.nama_tujuan}" sudah pernah ditarik sebagian; selesaikan melalui Penarikan Dana Investasi.`
    );
  }
  const sudah = await q.getFirstAsync<{ id: string }>(
    `SELECT id FROM journal WHERE sumber_transaksi = ? AND sumber_id = ? AND status IN ('POSTED','REVERSED') LIMIT 1`,
    SUMBER_PELEPASAN_INVESTASI,
    inv.id
  );
  if (inv.status === STATUS_INVESTASI_DILEPAS || sudah) {
    throw new PelepasanInvestasiDitolakError('SUDAH_DILEPAS', `"${inv.nama_tujuan}" sudah dilepas; pelepasan kedua ditolak.`);
  }
  if (inv.status !== 'AKTIF') {
    throw new PelepasanInvestasiDitolakError('STATUS_TIDAK_AKTIF', `"${inv.nama_tujuan}" berstatus ${inv.status}; hanya investasi AKTIF yang dapat dilepas.`);
  }
  const jPenempatan = inv.journal_id
    ? await q.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, inv.journal_id)
    : null;
  if (!jPenempatan || jPenempatan.status !== 'POSTED') {
    throw new PelepasanInvestasiDitolakError('JURNAL_PENEMPATAN_TIDAK_VALID', 'Jurnal penempatan investasi tidak ada atau tidak POSTED.');
  }

  // 3. tanggal
  const tgl = input.tanggalPelepasan;
  if (!RE_TANGGAL.test(tgl) || Number.isNaN(Date.parse(tgl))) {
    throw new PelepasanInvestasiDitolakError('TANGGAL_TIDAK_VALID', `Tanggal pelepasan "${tgl}" tidak valid (YYYY-MM-DD).`);
  }
  const hariIni = getTanggalLokalHariIni();
  if (tgl > hariIni) {
    throw new PelepasanInvestasiDitolakError('TANGGAL_MASA_DEPAN', `Tanggal pelepasan ${tgl} setelah hari ini (${hariIni}).`);
  }
  if (tgl < inv.tanggal.slice(0, 10)) {
    throw new PelepasanInvestasiDitolakError('TANGGAL_SEBELUM_PEROLEHAN', `Tanggal pelepasan ${tgl} sebelum tanggal perolehan ${inv.tanggal.slice(0, 10)}.`);
  }
  const sesudah = await q.getFirstAsync<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM investasi_penyusutan WHERE investasi_id = ? AND tanggal > ?)
          + (SELECT COUNT(*) FROM investasi_impairment WHERE investasi_id = ? AND tanggal > ?) AS n`,
    inv.id, tgl, inv.id, tgl
  );
  if ((sesudah?.n ?? 0) > 0) {
    throw new PelepasanInvestasiDitolakError('ADA_TRANSAKSI_SETELAH_TANGGAL_PELEPASAN', `Ada penyusutan/penurunan nilai bertanggal setelah ${tgl}.`);
  }
  // RC-S88 — penyesuaian nilai wajar yang diposting setelah tanggal pelepasan.
  let nwSesudah = 0;
  try {
    nwSesudah =
      (
        await q.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) AS n FROM penyesuaian_nilai_wajar WHERE investasi_id = ? AND status = 'DIPOSTING' AND tanggal > ?`,
          inv.id, tgl
        )
      )?.n ?? 0;
  } catch (e) {
    if (!/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
  if (nwSesudah > 0) {
    throw new PelepasanInvestasiDitolakError('ADA_TRANSAKSI_SETELAH_TANGGAL_PELEPASAN', `Ada penyesuaian nilai wajar bertanggal setelah ${tgl}.`);
  }

  // 4. periode (baca saja; periode yang belum ada dibuat OPEN oleh createJournal)
  const periode = await q.getFirstAsync<{ status: string }>(
    `SELECT status FROM accounting_period WHERE periode_mulai <= ? AND periode_selesai >= ? ORDER BY periode_mulai DESC LIMIT 1`,
    tgl, tgl
  );
  if (periode?.status === 'CLOSED') {
    throw new PelepasanInvestasiDitolakError('PERIODE_CLOSED', `Periode akuntansi untuk ${tgl} sudah CLOSED; pelepasan tidak dapat dicatat.`);
  }

  // 5. nilai tercatat (fungsi existing, per investasi, per tanggal pelepasan)
  const nilai = await getNilaiTercatatInvestasi(db, inv.id, tgl);

  // 6–7. hasil & rekening
  const H = input.hasilPelepasan;
  if (typeof H !== 'number' || !Number.isInteger(H) || H < 0) {
    throw new PelepasanInvestasiDitolakError('HASIL_TIDAK_VALID', 'Hasil pelepasan wajib rupiah bulat >= 0.');
  }
  let rekeningAccountId: string | null = null;
  if (H > 0) {
    if (input.sumberDana !== 'KAS' && input.sumberDana !== 'BANK') {
      throw new PelepasanInvestasiDitolakError('REKENING_WAJIB', 'Pilih rekening Kas/Bank penerima hasil pelepasan.');
    }
    rekeningAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
  }

  // 8. laba/rugi
  const C = nilai.nilaiAwal;
  const A = nilai.akumulasiPenyusutan;
  const I = nilai.akumulasiImpairment;
  const F = nilai.akumulasiPenyesuaianNilaiWajar;
  const nilaiTercatat = nilai.nilaiTercatat;
  const selisih = H - nilaiTercatat;

  // Akun: akun aset = akun debit jurnal penempatan investasi INI (bukan saldo global).
  const akunAset = await q.getFirstAsync<{ account_id: string }>(
    `SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit = ? ORDER BY id LIMIT 1`,
    inv.journal_id, inv.jumlah
  );
  if (!akunAset) throw new PelepasanInvestasiDitolakError('JURNAL_PENEMPATAN_TIDAK_VALID', 'Baris aset jurnal penempatan tidak ditemukan.');

  const lines: { accountId: string; debit: number; kredit: number }[] = [];
  if (H > 0) lines.push({ accountId: rekeningAccountId!, debit: H, kredit: 0 });
  if (A > 0) lines.push({ accountId: await resolveAccountId(db, 'PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI'), debit: A, kredit: 0 });
  if (I > 0) lines.push({ accountId: await resolveAccountId(db, 'IMPAIRMENT_INVESTASI', 'KREDIT_PENYISIHAN'), debit: I, kredit: 0 });
  if (F < 0) lines.push({ accountId: await resolveAccountId(db, 'NILAI_WAJAR_PROPERTI_INVESTASI', 'PENYESUAIAN_ASET'), debit: -F, kredit: 0 });
  if (selisih < 0) lines.push({ accountId: await resolveAccountId(db, SUMBER_PELEPASAN_INVESTASI, 'DEBIT_RUGI'), debit: -selisih, kredit: 0 });
  lines.push({ accountId: akunAset.account_id, debit: 0, kredit: C });
  if (F > 0) lines.push({ accountId: await resolveAccountId(db, 'NILAI_WAJAR_PROPERTI_INVESTASI', 'PENYESUAIAN_ASET'), debit: 0, kredit: F });
  if (selisih > 0) lines.push({ accountId: await resolveAccountId(db, SUMBER_PELEPASAN_INVESTASI, 'KREDIT_LABA'), debit: 0, kredit: selisih });

  const baris: BarisJurnalPelepasan[] = [];
  for (const l of lines) {
    const a = await q.getFirstAsync<{ kode: string; nama: string }>(`SELECT kode, nama FROM account WHERE id = ?`, l.accountId);
    baris.push({ accountId: l.accountId, kode: a?.kode ?? '', nama: a?.nama ?? '', debit: l.debit, kredit: l.kredit });
  }

  return {
    jenisOperasi: 'PELEPASAN_INVESTASI',
    investasiId: inv.id,
    nomorInvestasi: inv.nomor_investasi,
    namaTujuan: inv.nama_tujuan,
    jenisInvestasi: inv.jenis_investasi,
    tanggalPelepasan: tgl,
    biayaPerolehan: C,
    akumulasiPenyusutan: A,
    akumulasiImpairment: I,
    akumulasiPenyesuaianNilaiWajar: F,
    nilaiTercatat,
    hasilPelepasan: H,
    selisih,
    jenisSelisih: selisih > 0 ? 'LABA' : selisih < 0 ? 'RUGI' : 'IMPAS',
    rekeningAccountId,
    baris,
  };
}

/** Pratinjau read-only; validasi identik dengan eksekusi. */
export async function pratinjauPelepasanInvestasi(input: PelepasanInvestasiInput): Promise<PratinjauPelepasanInvestasi> {
  return susunPelepasan(await getDb(), input);
}

/** Eksekusi pelepasan: satu transaksi, rollback total bila langkah mana pun gagal. */
export async function lepaskanInvestasi(input: PelepasanInvestasiInput): Promise<{ journalId: string; pratinjau: PratinjauPelepasanInvestasi }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit');
    const pratinjau = await susunPelepasan(db, input);
    await assertAccountingPeriodOpen(db, pratinjau.tanggalPelepasan);

    const { journalId } = await createJournal(db, {
      tanggal: pratinjau.tanggalPelepasan,
      sumberTransaksi: SUMBER_PELEPASAN_INVESTASI,
      sumberId: pratinjau.investasiId,
      nomorReferensi: pratinjau.nomorInvestasi,
      deskripsi: `Pelepasan investasi - ${pratinjau.namaTujuan} - ${pratinjau.nomorInvestasi}`,
      createdBy: input.createdBy,
      lines: pratinjau.baris.map((b) => ({ accountId: b.accountId, debit: b.debit, kredit: b.kredit })),
    });

    const q = kueri(db);
    const now = new Date();
    await q.runAsync(
      `UPDATE investasi SET status = ?, updated_at = ? WHERE id = ? AND status = 'AKTIF'`,
      STATUS_INVESTASI_DILEPAS, now.toISOString(), pratinjau.investasiId
    );
    const cek = await q.getFirstAsync<{ status: string }>(`SELECT status FROM investasi WHERE id = ?`, pratinjau.investasiId);
    if (cek?.status !== STATUS_INVESTASI_DILEPAS) {
      throw new PelepasanInvestasiDitolakError('SUDAH_DILEPAS', 'Status investasi berubah selama pelepasan; transaksi dibatalkan.');
    }

    await q.runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(), input.createdBy, now.toISOString().slice(0, 10), now.toISOString().slice(11, 19),
      'DISPOSE', 'investasi', pratinjau.investasiId,
      JSON.stringify({ status: 'AKTIF' }),
      JSON.stringify({
        jenisOperasi: 'PELEPASAN_INVESTASI',
        investasiId: pratinjau.investasiId,
        tanggalPelepasan: pratinjau.tanggalPelepasan,
        hasilPelepasan: pratinjau.hasilPelepasan,
        biayaPerolehan: pratinjau.biayaPerolehan,
        akumulasiPenyusutan: pratinjau.akumulasiPenyusutan,
        akumulasiImpairment: pratinjau.akumulasiImpairment,
        nilaiTercatat: pratinjau.nilaiTercatat,
        labaRugi: pratinjau.selisih,
        journalId,
        rekeningAccountId: pratinjau.rekeningAccountId,
        sumberDana: input.sumberDana ?? null,
        bankAccountId: input.bankAccountId ?? null,
        statusSebelum: 'AKTIF',
        statusSesudah: STATUS_INVESTASI_DILEPAS,
        userId: input.createdBy,
        keterangan: input.keterangan ?? null,
      }),
      now.toISOString()
    );
    return { journalId, pratinjau };
  });
}
