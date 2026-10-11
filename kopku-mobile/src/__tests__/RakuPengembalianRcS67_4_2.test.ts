import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S67.4.2 — RAKU: PENERIMAAN DARI UNIT USAHA (PENGEMBALIAN_RAK).
 *
 * DATABASE: SQLite sungguhan (skema produksi), RAKService/KasBankService/
 * AccountingEngine/FinancialReports asli. Mapping akun yang di-seed HANYA
 * yang ada di produksi (`RAK/DEBIT_ASET`) — tidak ada role kredit khusus.
 */

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import {
  catatPengembalianRAK,
  getOutstandingRAK,
  listRAKUntukPengembalian,
  listPengembalianRAK,
  batalkanPengembalianRAK,
  kunciIdentitasRAKU,
  RAKUError,
} from '@/services/RAKUService';
import { catatRAK, batalkanRAK, editRAK } from '@/services/RAKService';
import { buatUnitUsaha, setStatusUnitUsaha } from '@/services/KoperasiMasterService';
import { catatPemasukan } from '@/services/KasBankService';
import { classifyTransactionSource } from '@/accounting/CashFlowClassification';
import { labelJenisTransaksi } from '@/services/HistoryTransaksiService';
import { getArusKas, getLabaRugi, getPosisiKeuangan } from '@/reports/FinancialReports';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ACC = { kas: 'acc-kas', bank: 'acc-bank', rak: 'acc-rak', modal: 'acc-modal', pendapatan: 'acc-4-1400' };
const T0 = '2020-01-01T00:00:00.000Z';

async function seedAccount(id: string, kode: string, nama: string, kat: string, nb: string) {
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?,?)`,
    id, kode, nama, kat, nb, kat === 'PENDAPATAN' ? 'PENDAPATAN_USAHA_LAIN' : null, T0, T0
  );
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.bank, '1-1100', 'Bank', 'ASET', 'DEBIT');
  await seedAccount(ACC.rak, '1-1800', 'Rekening Antar Kantor', 'ASET', 'DEBIT');
  await seedAccount(ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.pendapatan, '4-1400', 'Pendapatan Unit Usaha', 'PENDAPATAN', 'KREDIT');
  for (const [tt, role, acc] of [
    ['KAS_UMUM', 'DEFAULT', ACC.kas],
    ['RAK', 'DEBIT_ASET', ACC.rak],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-${tt}-${role}`, tt, role, acc
    );
  }
  for (const th of [2025, 2026]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    T0, T0
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES ('bank-1','BCA','123','Koperasi',0,?,1,?)`,
    ACC.bank, T0
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-modal','JRN-MODAL','2025-01-01','p2025','MODAL_AWAL','Modal awal','POSTED','user-1',?,?)`,
    T0, T0
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm1','j-modal',?,900000000,0)`, ACC.kas);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,0,900000000)`, ACC.modal);
});
afterEach(() => testDb.closeSync());

const n = async (sql: string, ...p: unknown[]) =>
  (await testDb.getFirstAsync<{ n: number }>(sql, ...(p as any[])))?.n ?? 0;

const saldoAkun = async (acc: string) =>
  n(`SELECT COALESCE(SUM(e.debit - e.kredit),0) AS n FROM journal_entry e JOIN journal j ON j.id = e.journal_id WHERE e.account_id = ?`, acc);

async function siapkanUnitDanRAK(opts: { jumlah?: number; alokasi?: 'MODAL_TETAP' | 'MODAL_TAMBAHAN' | 'OPERASIONAL'; tanggal?: string; nama?: string } = {}) {
  const unit = await buatUnitUsaha({ namaUsaha: opts.nama ?? 'Unit Toko' });
  const rak = await catatRAK({
    jenisRak: 'PENYALURAN_DANA',
    unitUsahaId: unit,
    jenisAlokasi: opts.alokasi ?? 'MODAL_TAMBAHAN',
    jumlah: opts.jumlah ?? 10_000_000,
    tanggal: opts.tanggal ?? '2026-03-01',
    sumberDana: 'KAS',
    createdBy: 'user-1',
  } as any);
  return { unit, rakId: rak.id };
}

const input = (unit: string, rakId: string, extra: Record<string, unknown> = {}) => ({
  unitUsahaId: unit,
  rakTransaksiId: rakId,
  tanggal: '2026-04-01',
  jumlah: 3_000_000,
  jenis: 'KAS' as const,
  nomorDokumen: 'BS-001',
  createdBy: 'user-1',
  ...extra,
});

async function tolak(fn: () => Promise<unknown>, kode: string) {
  const jurnalSebelum = await n(`SELECT COUNT(*) AS n FROM journal`);
  const kasSebelum = await n(`SELECT COUNT(*) AS n FROM kas_transaksi`);
  const bankSebelum = await n(`SELECT COUNT(*) AS n FROM bank_transaksi`);
  let err: any;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RAKUError);
  expect(err?.kode).toBe(kode);
  expect(await n(`SELECT COUNT(*) AS n FROM journal`)).toBe(jurnalSebelum);
  expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(kasSebelum);
  expect(await n(`SELECT COUNT(*) AS n FROM bank_transaksi`)).toBe(bankSebelum);
}

// ============================================================
describe('RC-S67.4.2 — create & accounting', () => {
  it('create via Kas: Dr Kas / Cr 1-1800, balanced, POSTED, sumber RAK_PENGEMBALIAN_KAS, sumber_id = rak', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const rakSebelum = await testDb.getFirstAsync(`SELECT * FROM rak_transaksi WHERE id = ?`, rakId);
    const r = await catatPengembalianRAK(input(unit, rakId));

    const j = await testDb.getFirstAsync<{ status: string; sumber_transaksi: string; sumber_id: string }>(
      `SELECT status, sumber_transaksi, sumber_id FROM journal WHERE id = ?`, r.journalId
    );
    expect(j).toEqual({ status: 'POSTED', sumber_transaksi: 'RAK_PENGEMBALIAN_KAS', sumber_id: rakId });
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId
    );
    expect(baris).toEqual([
      { account_id: ACC.kas, debit: 3_000_000, kredit: 0 },
      { account_id: ACC.rak, debit: 0, kredit: 3_000_000 },
    ]);

    const kas = await testDb.getFirstAsync<{ journal_id: string; kategori: string; akun_lawan_id: string; idempotency_key: string; tipe: string }>(
      `SELECT journal_id, kategori, akun_lawan_id, idempotency_key, tipe FROM kas_transaksi WHERE id = ?`, r.id
    );
    expect(kas?.journal_id).toBe(r.journalId); // jurnal <-> baris kas saling tertelusuri
    expect(kas?.kategori).toBe('PENGEMBALIAN_RAK');
    expect(kas?.akun_lawan_id).toBe(ACC.rak);
    expect(kas?.tipe).toBe('PENERIMAAN');
    expect(kas?.idempotency_key).toBe(kunciIdentitasRAKU(unit, rakId, 'BS-001'));

    // RAK original TIDAK berubah.
    expect(await testDb.getFirstAsync(`SELECT * FROM rak_transaksi WHERE id = ?`, rakId)).toEqual(rakSebelum);
    // TIDAK ada akun pendapatan yang tersentuh (4-1400 tetap 0).
    expect(await saldoAkun(ACC.pendapatan)).toBe(0);
    expect(r.outstandingSesudah).toBe(7_000_000);
  });

  it('create via Bank: Dr Bank / Cr 1-1800, sumber RAK_PENGEMBALIAN_BANK, baris bank_transaksi', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const r = await catatPengembalianRAK(input(unit, rakId, { jenis: 'BANK', bankAccountId: 'bank-1' }));
    const j = await testDb.getFirstAsync<{ sumber_transaksi: string }>(`SELECT sumber_transaksi FROM journal WHERE id = ?`, r.journalId);
    expect(j?.sumber_transaksi).toBe('RAK_PENGEMBALIAN_BANK');
    expect(await n(`SELECT COUNT(*) AS n FROM bank_transaksi WHERE id = ? AND journal_id = ?`, r.id, r.journalId)).toBe(1);
    const dr = await testDb.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit > 0`, r.journalId);
    expect(dr?.account_id).toBe(ACC.bank);
  });

  it('SUM(debit) = SUM(kredit) untuk seluruh buku setelah RAK + pengembalian + reversal', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const r = await catatPengembalianRAK(input(unit, rakId));
    await catatPengembalianRAK(input(unit, rakId, { nomorDokumen: 'BS-002', jumlah: 1_000_000 }));
    await batalkanPengembalianRAK('KAS', r.id, 'user-1', 'salah nominal');
    const s = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry`);
    expect(s?.d).toBe(s?.k);
  });
});

// ============================================================
describe('RC-S67.4.2 — outstanding & over-return', () => {
  it('10 jt RAK, 3 jt kembali → outstanding 7 jt (RAK & unit)', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    const o = await getOutstandingRAK({ unitUsahaId: unit, rakTransaksiId: rakId });
    expect(o.rak).toEqual({ jumlah: 10_000_000, totalPengembalian: 3_000_000, outstanding: 7_000_000 });
    expect(o.unit).toEqual({ totalRak: 10_000_000, totalPengembalian: 3_000_000, outstanding: 7_000_000 });
    // GL 1-1800 konsisten dengan outstanding.
    expect(await saldoAkun(ACC.rak)).toBe(7_000_000);
  });

  it('outstanding 7 jt, kembali 8 jt → OVER_RAK_OUTSTANDING, tanpa tulisan', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { nomorDokumen: 'BS-002', jumlah: 8_000_000 })), 'OVER_RAK_OUTSTANDING');
  });

  it('tepat outstanding diterima → 0; satu rupiah lagi ditolak; saldo RAK tidak pernah negatif', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    await catatPengembalianRAK(input(unit, rakId, { nomorDokumen: 'BS-002', jumlah: 7_000_000 }));
    expect((await getOutstandingRAK({ unitUsahaId: unit, rakTransaksiId: rakId })).rak?.outstanding).toBe(0);
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { nomorDokumen: 'BS-003', jumlah: 1 })), 'OVER_RAK_OUTSTANDING');
    expect(await saldoAkun(ACC.rak)).toBe(0);
  });

  it('batas per RAK: kelebihan pada satu RAK tidak dapat ditutup oleh RAK lain milik unit yang sama', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK({ jumlah: 2_000_000 });
    await catatRAK({ jenisRak: 'PENYALURAN_DANA', unitUsahaId: unit, jenisAlokasi: 'OPERASIONAL', jumlah: 5_000_000, tanggal: '2026-03-02', sumberDana: 'KAS', createdBy: 'user-1' } as any);
    expect((await getOutstandingRAK({ unitUsahaId: unit })).unit.outstanding).toBe(7_000_000);
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { jumlah: 3_000_000 })), 'OVER_RAK_OUTSTANDING');
  });

  it('reversal pengembalian memulihkan outstanding', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const r = await catatPengembalianRAK(input(unit, rakId));
    await batalkanPengembalianRAK('KAS', r.id, 'user-1', 'salah input');
    expect((await getOutstandingRAK({ unitUsahaId: unit, rakTransaksiId: rakId })).rak?.outstanding).toBe(10_000_000);
    expect(await saldoAkun(ACC.rak)).toBe(10_000_000);
  });

  it('RAK DIBATALKAN & RAK histori tanpa unit tidak dihitung ke outstanding unit', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await batalkanRAK(rakId, 'user-1', 'tarik penuh');
    await catatRAK({ jenisRak: 'PENYALURAN_DANA', namaUnit: 'Histori Tanpa Master', jumlah: 4_000_000, tanggal: '2026-03-05', sumberDana: 'KAS', createdBy: 'user-1' } as any);
    const o = await getOutstandingRAK({ unitUsahaId: unit });
    expect(o.unit).toEqual({ totalRak: 0, totalPengembalian: 0, outstanding: 0 });
    expect(await listRAKUntukPengembalian(unit)).toHaveLength(0);
  });
});

// ============================================================
describe('RC-S67.4.2 — validasi unit & RAK', () => {
  it('unit wajib', async () => {
    const { rakId } = await siapkanUnitDanRAK();
    await tolak(() => catatPengembalianRAK(input('', rakId)), 'UNIT_REQUIRED');
  });
  it('unit tidak ditemukan', async () => {
    const { rakId } = await siapkanUnitDanRAK();
    await tolak(() => catatPengembalianRAK(input('unit-tidak-ada', rakId)), 'UNIT_NOT_FOUND');
  });
  it('unit NONAKTIF ditolak', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await setStatusUnitUsaha(unit, 'NONAKTIF');
    await tolak(() => catatPengembalianRAK(input(unit, rakId)), 'UNIT_INACTIVE');
  });
  it('RAK wajib', async () => {
    const { unit } = await siapkanUnitDanRAK();
    await tolak(() => catatPengembalianRAK(input(unit, '')), 'RAK_REQUIRED');
  });
  it('RAK tidak ditemukan', async () => {
    const { unit } = await siapkanUnitDanRAK();
    await tolak(() => catatPengembalianRAK(input(unit, 'rak-tidak-ada')), 'RAK_NOT_FOUND');
  });
  it('RAK milik unit lain → RAK_UNIT_MISMATCH', async () => {
    const a = await siapkanUnitDanRAK({ nama: 'Unit A' });
    const b = await siapkanUnitDanRAK({ nama: 'Unit B' });
    await tolak(() => catatPengembalianRAK(input(a.unit, b.rakId)), 'RAK_UNIT_MISMATCH');
  });
  it('RAK histori tanpa unit_usaha_id → RAK_UNIT_MISMATCH (tidak diatribusikan)', async () => {
    const { unit } = await siapkanUnitDanRAK();
    const lama = await catatRAK({ jenisRak: 'PENYALURAN_DANA', namaUnit: 'Histori', jumlah: 1_000_000, tanggal: '2026-03-05', sumberDana: 'KAS', createdBy: 'user-1' } as any);
    await tolak(() => catatPengembalianRAK(input(unit, lama.id)), 'RAK_UNIT_MISMATCH');
  });
  it('RAK DIBATALKAN → RAK_CANCELLED', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await batalkanRAK(rakId, 'user-1', 'batal');
    await tolak(() => catatPengembalianRAK(input(unit, rakId)), 'RAK_CANCELLED');
  });
  it('nominal 0 / negatif / pecahan → INVALID_AMOUNT', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    for (const jumlah of [0, -1, 10.5]) {
      await tolak(() => catatPengembalianRAK(input(unit, rakId, { jumlah })), 'INVALID_AMOUNT');
    }
  });
  it('tanggal salah / masa depan / sebelum RAK', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { tanggal: '2026-02-30' })), 'INVALID_DATE');
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { tanggal: '2999-01-01' })), 'DATE_IN_FUTURE');
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { tanggal: '2026-02-01' })), 'DATE_BEFORE_RAK');
  });
  it('Kas/Bank wajib (BANK tanpa rekening; jenis tidak dikenal)', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { jenis: 'BANK' })), 'CASH_BANK_REQUIRED');
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { jenis: 'KAS_KECIL' })), 'CASH_BANK_REQUIRED');
  });
  it('nomor dokumen wajib dan tanpa karakter "|"', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { nomorDokumen: '   ' })), 'DOCUMENT_REQUIRED');
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { nomorDokumen: 'A|B' })), 'DOCUMENT_INVALID');
  });
});

// ============================================================
describe('RC-S67.4.2 — idempotency', () => {
  it('dokumen sama (beda huruf besar/spasi) → DUPLICATE_RAKU, satu jurnal', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId, { nomorDokumen: 'bs-001' }));
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { nomorDokumen: '  BS-001 ' })), 'DUPLICATE_RAKU');
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE kategori = 'PENGEMBALIAN_RAK'`)).toBe(1);
  });

  it('dokumen sama lewat Bank setelah Kas → tetap DUPLICATE_RAKU (identity lintas tabel)', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { jenis: 'BANK', bankAccountId: 'bank-1' })), 'DUPLICATE_RAKU');
  });

  it('dokumen berbeda → dua transaksi sah', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId, { jumlah: 1_000_000 }));
    await catatPengembalianRAK(input(unit, rakId, { jumlah: 1_000_000, nomorDokumen: 'BS-002' }));
    expect(await n(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'RAK_PENGEMBALIAN_KAS'`)).toBe(2);
  });

  it('dua submit bersamaan dengan dokumen sama → tepat SATU posting (UNIQUE idempotency_key)', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const hasil = await Promise.allSettled([
      catatPengembalianRAK(input(unit, rakId)),
      catatPengembalianRAK(input(unit, rakId)),
    ]);
    expect(hasil.some((h) => h.status === 'fulfilled')).toBe(true);
    expect(await n(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'RAK_PENGEMBALIAN_KAS'`)).toBe(1);
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE kategori = 'PENGEMBALIAN_RAK'`)).toBe(1);
  });

  it('retry di tingkat KasBankService dengan kunci identitas yang sama tidak membuat jurnal kedua', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const r = await catatPengembalianRAK(input(unit, rakId));
    const ulang = await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-04-01', nominal: 3_000_000, akunLawanId: ACC.rak, createdBy: 'user-1',
      idempotencyKey: kunciIdentitasRAKU(unit, rakId, 'BS-001'), jalurKhusus: 'RAK_PENGEMBALIAN', sumberId: rakId,
    });
    expect(ulang.id).toBe(r.id);
    expect(await n(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'RAK_PENGEMBALIAN_KAS'`)).toBe(1);
  });
});

// ============================================================
describe('RC-S67.4.2 — reversal', () => {
  it('POSTED → REVERSE: jurnal asli REVERSED (tidak dihapus), pembalik seimbang & mewarisi sumber_id, baris KOREKSI, audit', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const r = await catatPengembalianRAK(input(unit, rakId));
    await batalkanPengembalianRAK('KAS', r.id, 'user-1', 'salah input');

    expect((await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, r.journalId))?.status).toBe('REVERSED');
    const pembalik = await testDb.getFirstAsync<{ id: string; sumber_id: string; sumber_transaksi: string; status: string }>(
      `SELECT id, sumber_id, sumber_transaksi, status FROM journal WHERE reversal_of_id = ?`, r.journalId
    );
    expect(pembalik?.sumber_id).toBe(rakId);
    expect(pembalik?.sumber_transaksi).toBe('RAK_PENGEMBALIAN_KAS');
    const s = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry WHERE journal_id = ?`, pembalik!.id);
    expect(s?.d).toBe(s?.k);
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE reversal_of_id = ? AND tipe = 'KOREKSI'`, r.id)).toBe(1);
    expect(await n(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'REVERSE' AND entity_id = ?`, r.id)).toBe(1);

    const riw = await listPengembalianRAK({ unitUsahaId: unit });
    expect(riw).toHaveLength(1);
    expect(riw[0]).toMatchObject({ status: 'DIBATALKAN', rakTransaksiId: rakId, unitUsahaId: unit, namaUnit: 'Unit Toko', nomorDokumen: 'BS-001' });
  });

  it('reversal kedua → ALREADY_REVERSED', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const r = await catatPengembalianRAK(input(unit, rakId));
    await batalkanPengembalianRAK('KAS', r.id, 'user-1', 'salah');
    await tolak(() => batalkanPengembalianRAK('KAS', r.id, 'user-1', 'lagi'), 'ALREADY_REVERSED');
  });

  it('alasan wajib; baris kas non-RAKU tidak dapat dibatalkan lewat RAKUService', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const r = await catatPengembalianRAK(input(unit, rakId));
    await tolak(() => batalkanPengembalianRAK('KAS', r.id, 'user-1', '  '), 'REASON_REQUIRED');
    const lain = await catatPemasukan({ jenis: 'KAS', tanggal: '2026-04-02', nominal: 5_000, akunLawanId: ACC.pendapatan, createdBy: 'user-1' });
    await tolak(() => batalkanPengembalianRAK('KAS', lain.id, 'user-1', 'x'), 'RAKU_NOT_FOUND');
  });
});

// ============================================================
describe('RC-S67.4.2 — PeriodClose', () => {
  it('periode CLOSED → PERIOD_CLOSED tanpa tulisan; periode OPEN diizinkan', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK({ tanggal: '2025-03-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2025'`);
    await tolak(() => catatPengembalianRAK(input(unit, rakId, { tanggal: '2025-06-30' })), 'PERIOD_CLOSED');
    const ok = await catatPengembalianRAK(input(unit, rakId, { tanggal: '2026-01-10' }));
    expect(ok.journalId).toBeTruthy();
  });
});

// ============================================================
describe('RC-S67.4.2 — MODAL_TETAP invariant', () => {
  it('pengembalian atas MODAL_TETAP tidak membatalkan barisnya; MODAL_TETAP kedua tetap ditolak', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK({ alokasi: 'MODAL_TETAP' });
    await catatPengembalianRAK(input(unit, rakId, { jumlah: 10_000_000 }));
    expect((await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM rak_transaksi WHERE id = ?`, rakId))?.status).toBe('AKTIF');
    let err: unknown;
    try {
      await catatRAK({ jenisRak: 'PENYALURAN_DANA', unitUsahaId: unit, jenisAlokasi: 'MODAL_TETAP', jumlah: 1_000_000, tanggal: '2026-04-05', sumberDana: 'KAS', createdBy: 'user-1' } as any);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(await n(`SELECT COUNT(*) AS n FROM rak_transaksi WHERE unit_usaha_id = ? AND jenis_alokasi = 'MODAL_TETAP'`, unit)).toBe(1);
  });
});

// ============================================================
describe('RC-S67.4.2 — reporting', () => {
  it('Laba Rugi: pengembalian RAK TIDAK menambah pendapatan', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    const lr = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    expect(lr.totalPendapatan).toBe(0);
  });

  it('Posisi Keuangan seimbang; 1-1800 = outstanding', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    const pk = await getPosisiKeuangan(testDb as any, '2026-12-31');
    expect(pk.isBalanced).toBe(true);
    const barisRak = pk.aset.find((a: any) => a.kode === '1-1800' || a.accountId === ACC.rak || a.nama === 'Rekening Antar Kantor') as any;
    expect(barisRak?.saldo ?? barisRak?.jumlah).toBe(7_000_000);
  });

  it('Arus Kas: pengembalian = INVESTASI (pasangan penyaluran RAK), bukan OPERASI; kas terekonsiliasi', async () => {
    expect(classifyTransactionSource('RAK_PENGEMBALIAN_KAS')).toBe('INVESTASI');
    expect(classifyTransactionSource('RAK_PENGEMBALIAN_BANK')).toBe(classifyTransactionSource('RAK'));
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    const ak = await getArusKas(testDb as any, '2026-01-01', '2026-12-31');
    expect(ak.investasi).toBe(-10_000_000 + 3_000_000);
    expect(ak.operasi).toBe(0);
    expect(ak.terekonsiliasi).toBe(true);
  });

  it('History: label & rute koreksi tersedia', () => {
    expect(labelJenisTransaksi('RAK_PENGEMBALIAN_KAS')).toMatch(/Pengembalian RAK/);
    expect(labelJenisTransaksi('RAK_PENGEMBALIAN_BANK')).toMatch(/Pengembalian RAK/);
  });
});

// ============================================================
describe('RC-S67.4.2 — struktural', () => {
  const svc = tanpaKomentar(baca('src/services/RAKUService.ts'));
  const screen = tanpaKomentar(baca('src/screens/Transaksi/PengembalianRAKFormScreen.tsx'));
  const nav = baca('src/navigation/RootNavigator.tsx');
  const menu = tanpaKomentar(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));
  const hubPenerimaan = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));

  it('service tidak menulis DB langsung & tidak membuat jurnal sendiri — lewat catatPemasukan / koreksiTransaksiKasBank', () => {
    expect(svc).not.toMatch(/INSERT |UPDATE |DELETE |createJournal|reverseJournal/);
    expect(svc).toContain('await catatPemasukan(');
    expect(svc).toContain('koreksiTransaksiKasBank(');
  });

  it('tidak ada akun pendapatan / 4-1400 / jenis PENDAPATAN_UNIT', () => {
    expect(svc).not.toMatch(/4-1400|PENDAPATAN_UNIT|'PENDAPATAN'/);
    expect(svc).toContain("resolveAccountId(db, 'RAK', 'DEBIT_ASET')");
  });

  it('layar tidak menulis DB; unit dari UnitUsahaPicker; tidak ada pilihan akun; konfirmasi + kunci submit', () => {
    expect(screen).not.toMatch(/getDb|runAsync|INSERT|UPDATE /);
    expect(screen).toContain('<UnitUsahaPicker');
    expect(screen).not.toMatch(/AccountPicker|akunLawan/);
    expect(screen).toContain('if (sedangMengirim.current) return;');
    expect(screen).toContain("'Konfirmasi Pengembalian RAKU'"); // DIPERBARUI Poin 10 — label RAKU
  });

  // RC-S70.3 — pemanggil dipindah atas instruksi eksplisit pengguna: dari
  // menu Pendapatan Koperasi (salah nomenklatur) ke Penerimaan > RAKU.
  it('rute terdaftar sekali, dipanggil dari Penerimaan > RAKU, tidak dari menu pendapatan', () => {
    expect((nav.match(/name="PengembalianRAKForm"/g) ?? []).length).toBe(1);
    expect(nav).toContain(`<TransaksiStack.Screen name="PengembalianRAKForm" component={PengembalianRAKFormScreen} options={{ title: 'Pengembalian RAKU' }} />`);
    expect(hubPenerimaan).toContain("onPress: (nav) => nav.navigate('PengembalianRAKForm')");
    expect(menu).not.toContain('PengembalianRAKForm');
  });
});

// ============================================================
// RC-S67.4.3 — guard RAKService.batalkanInternal (Tarik Dana & Edit)
// ============================================================
describe('RC-S67.4.3 — guard Tarik Dana / Edit RAK setelah pengembalian', () => {
  const editInput = (unit: string) => ({
    jenisRak: 'PENYALURAN_DANA' as const,
    unitUsahaId: unit,
    jenisAlokasi: 'MODAL_TAMBAHAN' as const,
    jumlah: 10_000_000,
    tanggal: '2026-03-01',
    sumberDana: 'KAS' as const,
  });

  async function harusGagal(fn: () => Promise<unknown>) {
    const jurnal = await n(`SELECT COUNT(*) AS n FROM journal`);
    const rak = await n(`SELECT COUNT(*) AS n FROM rak_transaksi`);
    let err: any;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err?.message)).toContain('Batalkan pengembalian tersebut terlebih dahulu.');
    expect(await n(`SELECT COUNT(*) AS n FROM journal`)).toBe(jurnal);
    expect(await n(`SELECT COUNT(*) AS n FROM rak_transaksi`)).toBe(rak);
  }

  it('Case 1: RAK 10 jt → kembali 3 jt → Tarik Dana DITOLAK, saldo tetap 7 jt', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    await harusGagal(() => batalkanRAK(rakId, 'user-1', 'tarik dana'));
    expect(await saldoAkun(ACC.rak)).toBe(7_000_000);
    expect((await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM rak_transaksi WHERE id = ?`, rakId))?.status).toBe('AKTIF');
  });

  it('Case 2: RAK 10 jt → kembali 3 jt → Edit RAK DITOLAK, saldo tetap 7 jt', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    await catatPengembalianRAK(input(unit, rakId));
    await harusGagal(() => editRAK(rakId, 'user-1', editInput(unit) as any));
    expect(await saldoAkun(ACC.rak)).toBe(7_000_000);
    expect((await getOutstandingRAK({ unitUsahaId: unit, rakTransaksiId: rakId })).rak?.outstanding).toBe(7_000_000);
  });

  it('Case 3: kembali 3 jt → reversal pengembalian → Tarik Dana BERHASIL, saldo RAK = 0', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const r = await catatPengembalianRAK(input(unit, rakId));
    await batalkanPengembalianRAK('KAS', r.id, 'user-1', 'salah input');
    await batalkanRAK(rakId, 'user-1', 'tarik dana');
    expect((await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM rak_transaksi WHERE id = ?`, rakId))?.status).toBe('DIBATALKAN');
    expect(await saldoAkun(ACC.rak)).toBe(0);
    const s = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry`);
    expect(s?.d).toBe(s?.k);
  });

  it('Case 4: RAK tanpa pengembalian → Tarik Dana BERHASIL (perilaku lama tetap)', async () => {
    const { rakId } = await siapkanUnitDanRAK();
    await batalkanRAK(rakId, 'user-1', 'tarik dana');
    expect(await saldoAkun(ACC.rak)).toBe(0);
  });

  it('Edit RAK tanpa pengembalian tetap berhasil (perilaku lama tetap)', async () => {
    const { unit, rakId } = await siapkanUnitDanRAK();
    const baru = await editRAK(rakId, 'user-1', { ...editInput(unit), jumlah: 12_000_000 } as any);
    expect(baru.id).not.toBe(rakId);
    expect(await saldoAkun(ACC.rak)).toBe(12_000_000);
  });
});
