import * as SQLite from 'expo-sqlite';
import { getDb } from '@/database/db';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { catatPemasukan, koreksiTransaksiKasBank, type JenisRekening } from '@/services/KasBankService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { Rupiah } from '@/utils/money';

/**
 * ============================================================
 * PENGEMBALIAN RAKU
 * ============================================================
 *
 * SATU jenis transaksi: `PENGEMBALIAN_RAK` — unit usaha mengembalikan
 * (sebagian) dana yang sebelumnya disalurkan lewat RAK.
 *
 *     Dr Kas/Bank          jumlah
 *        Cr 1-1800 RAK      jumlah
 *
 * BUKAN pendapatan: tidak ada akun PENDAPATAN yang disentuh, 4-1400 tidak
 * dipakai. Pendapatan Unit Usaha (Cr 4-1400) adalah transaksi terpisah di
 * PendapatanUnitUsahaService dan tidak melewati berkas ini.
 *
 * TANPA MIGRASI. Setiap kebutuhan data dipenuhi kolom yang SUDAH ADA:
 *   - baris kas/bank + jurnal   : `KasBankService.catatPemasukan`
 *                                 (jalur khusus RAK_PENGEMBALIAN_KAS/_BANK)
 *   - relasi ke RAK             : `journal.sumber_id` = `rak_transaksi.id`
 *   - unit                      : diturunkan dari `rak_transaksi.unit_usaha_id`
 *                                 (divalidasi sama dengan unit yang dipilih)
 *   - identity / idempotensi    : `idempotency_key` (UNIQUE parsial existing)
 *                                 = RAKU|PENGEMBALIAN_RAK|unit|rak|NOMOR_DOKUMEN
 *   - status                    : jurnal POSTED = AKTIF, REVERSED = DIBATALKAN
 *   - kategori tampilan         : `kategori` = 'PENGEMBALIAN_RAK'
 *
 * RAK original TIDAK PERNAH diubah. Outstanding dihitung read-only:
 *   outstanding(RAK)  = rak.jumlah − Σ pengembalian POSTED ber-sumber_id rak.id
 *   outstanding(unit) = Σ outstanding(RAK) untuk RAK AKTIF PENYALURAN_DANA milik unit
 *
 * Akun 1-1800 diambil lewat `resolveAccountId('RAK','DEBIT_ASET')` — satu-
 * satunya mapping akun RAK yang ada. Role itu menamai AKUN aset RAK;
 * di sini akun yang sama berada di sisi kredit (arah yang sama dengan
 * jurnal pembalik Tarik Dana). Role kredit khusus = mapping baru = v70
 * (tidak dibuat — tercatat sebagai gap).
 */

export type JenisTransaksiRAKU = 'PENGEMBALIAN_RAK';
export const JENIS_TRANSAKSI_RAKU: JenisTransaksiRAKU = 'PENGEMBALIAN_RAK';
export const KATEGORI_PENGEMBALIAN_RAK = 'PENGEMBALIAN_RAK';
const SUMBER_PENGEMBALIAN = ['RAK_PENGEMBALIAN_KAS', 'RAK_PENGEMBALIAN_BANK'] as const;

export type KodeRAKUError =
  | 'UNIT_REQUIRED'
  | 'UNIT_NOT_FOUND'
  | 'UNIT_INACTIVE'
  | 'RAK_REQUIRED'
  | 'RAK_NOT_FOUND'
  | 'RAK_UNIT_MISMATCH'
  | 'RAK_CANCELLED'
  | 'RAK_NOT_ELIGIBLE'
  | 'INVALID_AMOUNT'
  | 'INVALID_DATE'
  | 'DATE_IN_FUTURE'
  | 'DATE_BEFORE_RAK'
  | 'OVER_RAK_OUTSTANDING'
  | 'DUPLICATE_RAKU'
  | 'PERIOD_CLOSED'
  | 'CASH_BANK_REQUIRED'
  | 'DOCUMENT_REQUIRED'
  | 'DOCUMENT_INVALID'
  | 'REASON_REQUIRED'
  | 'RAKU_NOT_FOUND'
  | 'ALREADY_REVERSED';

export class RAKUError extends Error {
  constructor(readonly kode: KodeRAKUError, pesan: string) {
    super(pesan);
    this.name = 'RAKUError';
  }
}

function adalahClosedPeriod(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'ClosedPeriodError';
}

function tanggalValid(t: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const [y, m, d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Normalisasi nomor dokumen untuk identity: trim, spasi tunggal, huruf besar. */
export function normalisasiNomorDokumen(nomor: string | undefined | null): string {
  return (nomor ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function kunciIdentitasRAKU(unitUsahaId: string, rakTransaksiId: string, nomorDokumen: string): string {
  return `RAKU|${JENIS_TRANSAKSI_RAKU}|${unitUsahaId}|${rakTransaksiId}|${normalisasiNomorDokumen(nomorDokumen)}`;
}

// ------------------------------------------------------------------
// OUTSTANDING (read-only)
// ------------------------------------------------------------------

async function totalPengembalianPosted(db: SQLite.SQLiteDatabase, rakIds: string[]): Promise<Map<string, Rupiah>> {
  const hasil = new Map<string, Rupiah>();
  if (rakIds.length === 0) return hasil;
  const ph = rakIds.map(() => '?').join(',');
  for (const tabel of ['kas_transaksi', 'bank_transaksi']) {
    const rows = await db.getAllAsync<{ rak_id: string; total: number }>(
      `SELECT j.sumber_id AS rak_id, COALESCE(SUM(t.nominal),0) AS total
         FROM ${tabel} t JOIN journal j ON j.id = t.journal_id
        WHERE t.tipe = 'PENERIMAAN'
          AND j.status = 'POSTED'
          AND j.sumber_transaksi IN ('RAK_PENGEMBALIAN_KAS','RAK_PENGEMBALIAN_BANK')
          AND j.sumber_id IN (${ph})
        GROUP BY j.sumber_id`,
      ...rakIds
    );
    for (const r of rows) hasil.set(r.rak_id, (hasil.get(r.rak_id) ?? 0) + (r.total ?? 0));
  }
  return hasil;
}

export interface RAKEligibleItem {
  rakTransaksiId: string;
  nomorRak: string;
  tanggal: string;
  jenisAlokasi: string | null;
  jumlah: Rupiah;
  totalPengembalian: Rupiah;
  outstanding: Rupiah;
}

async function rakAktifUnit(db: SQLite.SQLiteDatabase, unitUsahaId: string) {
  return db.getAllAsync<{ id: string; nomor_rak: string; tanggal: string; jenis_alokasi: string | null; jumlah: number }>(
    `SELECT id, nomor_rak, tanggal, jenis_alokasi, jumlah FROM rak_transaksi
      WHERE unit_usaha_id = ? AND status = 'AKTIF' AND jenis_rak = 'PENYALURAN_DANA' AND journal_id IS NOT NULL
      ORDER BY tanggal ASC, nomor_rak ASC`,
    unitUsahaId
  );
}

/** Daftar RAK milik unit yang dapat menjadi rujukan pengembalian (AKTIF, PENYALURAN_DANA, berjurnal). */
export async function listRAKUntukPengembalian(unitUsahaId: string): Promise<RAKEligibleItem[]> {
  const db = await getDb();
  const rows = await rakAktifUnit(db, unitUsahaId);
  const kembali = await totalPengembalianPosted(db, rows.map((r) => r.id));
  return rows.map((r) => {
    const total = kembali.get(r.id) ?? 0;
    return {
      rakTransaksiId: r.id,
      nomorRak: r.nomor_rak,
      tanggal: r.tanggal,
      jenisAlokasi: r.jenis_alokasi,
      jumlah: r.jumlah,
      totalPengembalian: total,
      outstanding: r.jumlah - total,
    };
  });
}

export interface OutstandingRAK {
  unit: { totalRak: Rupiah; totalPengembalian: Rupiah; outstanding: Rupiah };
  rak: { jumlah: Rupiah; totalPengembalian: Rupiah; outstanding: Rupiah } | null;
}

/**
 * Outstanding read-only. Hanya RAK AKTIF PENYALURAN_DANA ber-unit yang
 * dihitung; baris DIBATALKAN, SETORAN_DANA historis, dan baris lama tanpa
 * `unit_usaha_id` TIDAK diatribusikan ke unit mana pun (tanpa backfill).
 * Pengembalian yang sudah direversal (jurnal REVERSED) tidak mengurangi.
 */
export async function getOutstandingRAK(params: { unitUsahaId: string; rakTransaksiId?: string }): Promise<OutstandingRAK> {
  const items = await listRAKUntukPengembalian(params.unitUsahaId);
  const unit = items.reduce(
    (a, i) => ({ totalRak: a.totalRak + i.jumlah, totalPengembalian: a.totalPengembalian + i.totalPengembalian, outstanding: a.outstanding + i.outstanding }),
    { totalRak: 0, totalPengembalian: 0, outstanding: 0 }
  );
  let rak: OutstandingRAK['rak'] = null;
  if (params.rakTransaksiId) {
    const i = items.find((x) => x.rakTransaksiId === params.rakTransaksiId);
    if (i) rak = { jumlah: i.jumlah, totalPengembalian: i.totalPengembalian, outstanding: i.outstanding };
  }
  return { unit, rak };
}

// ------------------------------------------------------------------
// CATAT
// ------------------------------------------------------------------

export interface CatatPengembalianRAKInput {
  unitUsahaId: string;
  rakTransaksiId: string;
  tanggal: string;
  jumlah: Rupiah;
  jenis: JenisRekening;
  bankAccountId?: string;
  nomorDokumen: string;
  keterangan?: string;
  createdBy: string;
}

async function cariIdentitas(db: SQLite.SQLiteDatabase, kunci: string): Promise<{ id: string; journal_id: string } | null> {
  for (const tabel of ['kas_transaksi', 'bank_transaksi']) {
    const r = await db.getFirstAsync<{ id: string; journal_id: string }>(
      `SELECT id, journal_id FROM ${tabel} WHERE idempotency_key = ?`,
      kunci
    );
    if (r) return r;
  }
  return null;
}

/**
 * Catat pengembalian pokok RAK. Seluruh validasi terjadi SEBELUM penulisan
 * pertama; penulisan (jurnal + baris kas/bank) satu transaksi di dalam
 * `catatPemasukan`. Periode CLOSED ditolak oleh `createJournal`.
 */
export async function catatPengembalianRAK(
  input: CatatPengembalianRAKInput
): Promise<{ id: string; journalId: string; jenis: JenisRekening; outstandingSesudah: Rupiah }> {
  if (!input.unitUsahaId) throw new RAKUError('UNIT_REQUIRED', 'Unit usaha wajib dipilih.');
  if (!input.rakTransaksiId) throw new RAKUError('RAK_REQUIRED', 'Transaksi RAK terkait wajib dipilih.');
  if (!Number.isFinite(input.jumlah) || !Number.isInteger(input.jumlah) || input.jumlah <= 0) {
    throw new RAKUError('INVALID_AMOUNT', 'Nominal harus bilangan bulat rupiah lebih dari 0.');
  }
  const tanggal = (input.tanggal ?? '').trim();
  if (!tanggalValid(tanggal)) throw new RAKUError('INVALID_DATE', 'Tanggal tidak valid (format YYYY-MM-DD).');
  if (tanggal > getTanggalLokalHariIni()) throw new RAKUError('DATE_IN_FUTURE', 'Tanggal penerimaan tidak boleh di masa depan.');
  if (input.jenis !== 'KAS' && input.jenis !== 'BANK') throw new RAKUError('CASH_BANK_REQUIRED', 'Kas/Bank penerima wajib dipilih.');
  if (input.jenis === 'BANK' && !input.bankAccountId) throw new RAKUError('CASH_BANK_REQUIRED', 'Rekening bank penerima wajib dipilih.');
  const nomorDokumen = normalisasiNomorDokumen(input.nomorDokumen);
  if (!nomorDokumen) throw new RAKUError('DOCUMENT_REQUIRED', 'Nomor dokumen wajib diisi.');
  if (nomorDokumen.includes('|') || nomorDokumen.length > 100) {
    throw new RAKUError('DOCUMENT_INVALID', 'Nomor dokumen tidak boleh memuat karakter "|" dan maksimal 100 karakter.');
  }

  const db = await getDb();
  const unit = await db.getFirstAsync<{ id: string; nama_usaha: string; status: string }>(
    `SELECT id, nama_usaha, status FROM koperasi_unit_usaha WHERE id = ?`,
    input.unitUsahaId
  );
  if (!unit) throw new RAKUError('UNIT_NOT_FOUND', 'Unit usaha tidak ditemukan.');
  if (unit.status !== 'AKTIF') {
    throw new RAKUError('UNIT_INACTIVE', `Unit usaha "${unit.nama_usaha}" berstatus NONAKTIF.`);
  }

  const rak = await db.getFirstAsync<{
    id: string; nomor_rak: string; unit_usaha_id: string | null; status: string; jenis_rak: string; journal_id: string | null; tanggal: string; jumlah: number;
  }>(
    `SELECT id, nomor_rak, unit_usaha_id, status, jenis_rak, journal_id, tanggal, jumlah FROM rak_transaksi WHERE id = ?`,
    input.rakTransaksiId
  );
  if (!rak) throw new RAKUError('RAK_NOT_FOUND', 'Transaksi RAK tidak ditemukan.');
  if (rak.unit_usaha_id !== input.unitUsahaId) {
    throw new RAKUError('RAK_UNIT_MISMATCH', `Transaksi RAK ${rak.nomor_rak} bukan milik unit usaha "${unit.nama_usaha}".`);
  }
  if (rak.status !== 'AKTIF') throw new RAKUError('RAK_CANCELLED', `Transaksi RAK ${rak.nomor_rak} sudah dibatalkan.`);
  if (rak.jenis_rak !== 'PENYALURAN_DANA' || !rak.journal_id) {
    throw new RAKUError('RAK_NOT_ELIGIBLE', `Transaksi RAK ${rak.nomor_rak} tidak dapat menjadi rujukan pengembalian.`);
  }
  if (tanggal < String(rak.tanggal).slice(0, 10)) {
    throw new RAKUError('DATE_BEFORE_RAK', `Tanggal pengembalian tidak boleh sebelum tanggal RAK (${String(rak.tanggal).slice(0, 10)}).`);
  }

  const kunci = kunciIdentitasRAKU(input.unitUsahaId, rak.id, nomorDokumen);
  if (await cariIdentitas(db, kunci)) {
    throw new RAKUError(
      'DUPLICATE_RAKU',
      `Pengembalian dengan nomor dokumen ${nomorDokumen} untuk ${rak.nomor_rak} sudah pernah dicatat.`
    );
  }

  const sudahKembali = (await totalPengembalianPosted(db, [rak.id])).get(rak.id) ?? 0;
  const outstanding = rak.jumlah - sudahKembali;
  if (input.jumlah > outstanding) {
    throw new RAKUError(
      'OVER_RAK_OUTSTANDING',
      `Jumlah penerimaan melebihi saldo RAK yang masih outstanding (outstanding ${rak.nomor_rak}: Rp${outstanding.toLocaleString('id-ID')}).`
    );
  }

  const rakAccountId = await resolveAccountId(db, 'RAK', 'DEBIT_ASET');
  const catatan = (input.keterangan ?? '').trim();
  const keterangan =
    `Pengembalian RAK ${rak.nomor_rak} — ${unit.nama_usaha} · Dok ${nomorDokumen}` + (catatan ? ` · ${catatan}` : '');

  try {
    const { id, journalId } = await catatPemasukan({
      jenis: input.jenis,
      bankAccountId: input.jenis === 'BANK' ? input.bankAccountId : undefined,
      tanggal,
      nominal: input.jumlah,
      akunLawanId: rakAccountId,
      kategori: KATEGORI_PENGEMBALIAN_RAK,
      keterangan,
      createdBy: input.createdBy,
      idempotencyKey: kunci,
      jalurKhusus: 'RAK_PENGEMBALIAN',
      sumberId: rak.id,
    });
    return { id, journalId, jenis: input.jenis, outstandingSesudah: outstanding - input.jumlah };
  } catch (e) {
    if (adalahClosedPeriod(e)) {
      throw new RAKUError('PERIOD_CLOSED', 'Periode akuntansi untuk tanggal ini sudah ditutup.');
    }
    throw e;
  }
}

// ------------------------------------------------------------------
// RIWAYAT & REVERSAL
// ------------------------------------------------------------------

export interface PengembalianRAKRow {
  id: string;
  jenis: JenisRekening;
  tanggal: string;
  jumlah: Rupiah;
  nomorTransaksi: string;
  nomorDokumen: string;
  rakTransaksiId: string;
  nomorRak: string | null;
  unitUsahaId: string | null;
  namaUnit: string | null;
  keterangan: string | null;
  journalId: string;
  status: 'AKTIF' | 'DIBATALKAN';
}

function dokumenDariKunci(kunci: string | null): string {
  if (!kunci) return '';
  const bagian = kunci.split('|');
  return bagian.length >= 5 ? bagian.slice(4).join('|') : '';
}

export async function listPengembalianRAK(filter: { unitUsahaId?: string; rakTransaksiId?: string } = {}): Promise<PengembalianRAKRow[]> {
  const db = await getDb();
  const hasil: PengembalianRAKRow[] = [];
  for (const [tabel, jenis] of [['kas_transaksi', 'KAS'], ['bank_transaksi', 'BANK']] as const) {
    const rows = await db.getAllAsync<any>(
      `SELECT t.id, t.tanggal, t.nominal, t.nomor_transaksi, t.keterangan, t.idempotency_key, t.journal_id,
              j.status AS jstatus, j.sumber_id AS rak_id, r.nomor_rak, r.unit_usaha_id, u.nama_usaha
         FROM ${tabel} t
         JOIN journal j ON j.id = t.journal_id
         LEFT JOIN rak_transaksi r ON r.id = j.sumber_id
         LEFT JOIN koperasi_unit_usaha u ON u.id = r.unit_usaha_id
        WHERE t.tipe = 'PENERIMAAN'
          AND j.sumber_transaksi IN ('RAK_PENGEMBALIAN_KAS','RAK_PENGEMBALIAN_BANK')`
    );
    for (const r of rows) {
      if (filter.unitUsahaId && r.unit_usaha_id !== filter.unitUsahaId) continue;
      if (filter.rakTransaksiId && r.rak_id !== filter.rakTransaksiId) continue;
      hasil.push({
        id: r.id,
        jenis,
        tanggal: r.tanggal,
        jumlah: r.nominal,
        nomorTransaksi: r.nomor_transaksi,
        nomorDokumen: dokumenDariKunci(r.idempotency_key),
        rakTransaksiId: r.rak_id,
        nomorRak: r.nomor_rak ?? null,
        unitUsahaId: r.unit_usaha_id ?? null,
        namaUnit: r.nama_usaha ?? null,
        keterangan: r.keterangan ?? null,
        journalId: r.journal_id,
        status: r.jstatus === 'POSTED' ? 'AKTIF' : 'DIBATALKAN',
      });
    }
  }
  return hasil.sort((a, b) => (a.tanggal < b.tanggal ? 1 : a.tanggal > b.tanggal ? -1 : 0));
}

/**
 * Batalkan pengembalian lewat reversal existing (`koreksiTransaksiKasBank`
 * → `reverseJournal`): jurnal asli REVERSED, baris KOREKSI kas/bank,
 * audit REVERSE. Tidak ada DELETE. Jurnal pembalik menyalin `sumber_id`
 * (rak id), sehingga relasi ke RAK tetap terbaca dari kedua sisi.
 */
export async function batalkanPengembalianRAK(
  jenis: JenisRekening,
  id: string,
  userId: string,
  alasan: string
): Promise<{ id: string }> {
  if (!alasan || !alasan.trim()) throw new RAKUError('REASON_REQUIRED', 'Alasan pembatalan wajib diisi.');
  const db = await getDb();
  const tabel = jenis === 'BANK' ? 'bank_transaksi' : 'kas_transaksi';
  const row = await db.getFirstAsync<{ id: string; tipe: string; jstatus: string; sumber: string }>(
    `SELECT t.id, t.tipe, j.status AS jstatus, j.sumber_transaksi AS sumber
       FROM ${tabel} t JOIN journal j ON j.id = t.journal_id WHERE t.id = ?`,
    id
  );
  if (!row || row.tipe !== 'PENERIMAAN' || !(SUMBER_PENGEMBALIAN as readonly string[]).includes(row.sumber)) {
    throw new RAKUError('RAKU_NOT_FOUND', 'Transaksi pengembalian RAK tidak ditemukan.');
  }
  if (row.jstatus !== 'POSTED') throw new RAKUError('ALREADY_REVERSED', 'Transaksi ini sudah dibatalkan.');
  try {
    return await koreksiTransaksiKasBank(jenis, id, userId, alasan.trim());
  } catch (e) {
    if (adalahClosedPeriod(e)) throw new RAKUError('PERIOD_CLOSED', 'Periode akuntansi tanggal pembatalan sudah ditutup.');
    throw e;
  }
}
