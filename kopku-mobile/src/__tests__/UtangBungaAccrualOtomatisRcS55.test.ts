import { createTestDb, TestDb } from './testDb';

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
  prosesAkrualBungaUtangOtomatis,
  jalankanAkrualBungaUtangJikaPerlu,
  _resetGerbangAkrualUntukTest,
  getMonitorAkrualBungaUtang,
  getJejakAkrualBungaUtang,
  nilaiKontrakBunga,
  rateBulanan,
  periodePertamaEligible,
  daftarPeriodeKandidat,
  hitungNominalBunga,
  idempotencyKeyAkrual,
} from '@/services/UtangBungaAccrualService';
import {
  terimaUtang,
  bayarUtang,
  akruiBungaUtang,
  lengkapiBasisBungaUtang,
  getKontrolGapUtangBunga,
  replayBungaUtang,
} from '@/services/UtangService';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { classifyTransactionSource } from '@/accounting/CashFlowClassification';

/**
 * RC-S55 — MESIN AKRUAL BUNGA UTANG OTOMATIS.
 *
 * Seluruh suite berjalan di atas SQLite sungguhan dengan skema produksi
 * (CREATE_TABLES_SQL) dan jurnal dari AccountingEngine asli. Yang
 * dibuktikan bukan "kode terlihat benar", melainkan angka yang benar-benar
 * duduk di `journal_entry` dan `utang_bunga_akrual`.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
};

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

beforeEach(async () => {
  _resetGerbangAkrualUntukTest();
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(testDb, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);

  for (const th of [2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank A','123','Koperasi',?,1,?)`,
    ACC.bank, now
  );
  // Modal kas awal supaya cek saldo pembayaran lolos.
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES ('j-awal','JRN-SEED','2025-12-31','p2025','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,100000000,0,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,100000000,1)`,
    ACC.utangBank
  );
});

afterEach(() => testDb.closeSync());

async function buatUtang(opts: {
  persen: number;
  basis?: 'TAHUNAN' | 'BULANAN' | null;
  jenisBunga?: 'FLAT' | 'EFEKTIF' | 'LAINNYA';
  tanggal?: string;
  pokok?: number;
}): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: 'Bank ABC',
    jenisPemberi: 'BANK',
    pokokPinjaman: opts.pokok ?? 120_000_000,
    persenBunga: opts.persen,
    jenisBunga: opts.jenisBunga ?? 'FLAT',
    basisBunga: opts.basis ?? null,
    tanggal: opts.tanggal ?? '2026-01-01',
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return r.id;
}

/** Utang WARISAN: ditulis langsung tanpa basis_bunga, meniru baris v<=68. */
async function buatUtangLegacy(persen = 12, jenisBunga = 'FLAT', tanggal = '2026-01-01'): Promise<string> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga,
       jenis_bunga, basis_bunga, tanggal, sumber_dana, sumber, status, created_by, created_at, updated_at)
     VALUES ('utg-legacy','UTG-LEG','Bank Lama','BANK',120000000,?,?,NULL,?,'KAS','LANGSUNG','AKTIF','user-1',?,?)`,
    persen, jenisBunga, tanggal, now, now
  );
  return 'utg-legacy';
}

async function saldo(accountId: string, sisi: 'debit' | 'kredit'): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.${sisi} - je.${sisi === 'debit' ? 'kredit' : 'debit'}),0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return r?.s ?? 0;
}

async function jumlahJurnalAkrual(utangId: string): Promise<number> {
  const r = await testDb.getAllAsync<{ id: string }>(
    `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND status='POSTED' AND reversal_of_id IS NULL`,
    utangId
  );
  return r.length;
}

// ============================================================================

describe('KONTRAK & ELIGIBILITAS', () => {
  it('legacy tanpa basis bunga: MANUAL_REVIEW_REQUIRED, TIDAK ada akrual otomatis', async () => {
    const id = await buatUtangLegacy();
    const hasil = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-15' });

    expect(hasil.jumlahJurnalBaru).toBe(0);
    expect(await jumlahJurnalAkrual(id)).toBe(0);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    expect(hasil.exception).toHaveLength(1);
    expect(hasil.exception[0].kode).toBe('BASIS_BUNGA_BELUM_DITENTUKAN');
    expect(hasil.exception[0].pesan).toBe('Basis bunga belum ditentukan.');
  });

  it('legacy setelah basis dilengkapi: menjadi eligible dan diakru', async () => {
    const id = await buatUtangLegacy(12, 'FLAT', '2026-01-01');
    await lengkapiBasisBungaUtang({ utangId: id, basisBunga: 'TAHUNAN', createdBy: 'user-1' });

    const hasil = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-10' });
    expect(hasil.exception).toHaveLength(0);
    // 12% tahunan -> 1%/bulan atas 120.000.000 = 1.200.000, dua periode (Jan, Feb)
    // DIPERBARUI RC-S58 (posting di akhir periode): pada 10 Feb hanya Januari
    // yang sudah selesai; Februari menunggu 28 Feb. Sebelumnya 2.400.000 (Jan+Feb).
    expect(hasil.totalDibukukan).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(1_200_000);
  });

  it('melengkapi basis bunga tercatat di audit_log dengan user & timestamp', async () => {
    const id = await buatUtangLegacy();
    await lengkapiBasisBungaUtang({ utangId: id, basisBunga: 'BULANAN', createdBy: 'user-1' });

    const log = await testDb.getFirstAsync<any>(
      `SELECT * FROM audit_log WHERE entity='utang' AND entity_id=? AND action='UPDATE'`,
      id
    );
    expect(log).not.toBeNull();
    expect(log.user_id).toBe('user-1');
    expect(log.created_at).toBeTruthy();
    expect(JSON.parse(log.data_sebelum).basisBunga).toBeNull();
    expect(JSON.parse(log.data_sesudah).basisBunga).toBe('BULANAN');

    const row = await testDb.getFirstAsync<any>(`SELECT * FROM utang WHERE id=?`, id);
    expect(row.basis_bunga).toBe('BULANAN');
    expect(row.basis_bunga_diisi_oleh).toBe('user-1');
    expect(row.basis_bunga_diisi_pada).toBeTruthy();
  });

  it('melengkapi basis bunga TIDAK membuat jurnal apa pun', async () => {
    const id = await buatUtangLegacy();
    const sebelum = await testDb.getAllAsync(`SELECT id FROM journal`);
    await lengkapiBasisBungaUtang({ utangId: id, basisBunga: 'TAHUNAN', createdBy: 'user-1' });
    const sesudah = await testDb.getAllAsync(`SELECT id FROM journal`);
    expect(sesudah.length).toBe(sebelum.length);
  });

  it('basis bunga tidak dapat diubah setelah ada akrual terbukukan', async () => {
    const id = await buatUtangLegacy();
    await lengkapiBasisBungaUtang({ utangId: id, basisBunga: 'TAHUNAN', createdBy: 'user-1' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await expect(
      lengkapiBasisBungaUtang({ utangId: id, basisBunga: 'BULANAN', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah memiliki akrual/i);
  });

  it('utang baru berbunga WAJIB punya basis bunga — service menolak tanpa basis', async () => {
    await expect(buatUtang({ persen: 12, basis: null })).rejects.toThrow(/Basis bunga wajib dipilih/i);
  });

  it('rate nol: tidak diakru, bukan exception', async () => {
    await buatUtang({ persen: 0 });
    const hasil = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-15' });
    expect(hasil.jumlahJurnalBaru).toBe(0);
    expect(hasil.exception).toHaveLength(0);
  });

  it('jenis bunga LAINNYA: MANUAL_REVIEW_REQUIRED walau basis terisi', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN', jenisBunga: 'LAINNYA' });
    const hasil = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-15' });
    expect(hasil.jumlahJurnalBaru).toBe(0);
    expect(hasil.exception[0].kode).toBe('JENIS_BUNGA_LAINNYA');
  });

  it('utang usaha tidak pernah masuk pemrosesan bunga', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga,
         jenis_bunga, tanggal, sumber, status, created_by, created_at, updated_at)
       VALUES ('utg-usaha','UTG-U','Pemasok','UTANG_USAHA',50000000,0,'LAINNYA','2026-01-01','PEMBELIAN_ASET','AKTIF','user-1',?,?)`,
      now, now
    );
    const hasil = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-15' });
    expect(hasil.exception).toHaveLength(0);
    expect(hasil.jumlahJurnalBaru).toBe(0);
  });
});

describe('FORMULA', () => {
  it('konversi rate: TAHUNAN dibagi 12, BULANAN apa adanya', () => {
    expect(rateBulanan(12, 'TAHUNAN')).toBeCloseTo(0.01, 10);
    expect(rateBulanan(1.5, 'BULANAN')).toBeCloseTo(0.015, 10);
  });

  it('rate tahunan: 12% atas 120jt -> 1.200.000/bulan', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    expect(h.totalDibukukan).toBe(1_200_000);
  });

  it('rate bulanan: 1,5% atas 120jt -> 1.800.000/bulan', async () => {
    await buatUtang({ persen: 1.5, basis: 'BULANAN' });
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    expect(h.totalDibukukan).toBe(1_800_000);
  });

  it('FLAT memakai pokok kontraktual; angsuran pokok TIDAK mengecilkan bunga', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', jenisBunga: 'FLAT' });
    await bayarUtang({ utangId: id, tanggal: '2026-01-10', pokok: 60_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });
    // Jan & Feb dua-duanya 1% x 120jt penuh
    expect(h.totalDibukukan).toBe(2_400_000);
  });

  it('EFEKTIF memakai outstanding principal pada awal periode', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', jenisBunga: 'EFEKTIF' });
    await bayarUtang({ utangId: id, tanggal: '2026-01-10', pokok: 60_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });
    // Jan: outstanding awal 120jt -> 1.200.000; Feb: 60jt -> 600.000
    expect(h.totalDibukukan).toBe(1_800_000);
  });

  it('pembulatan menghasilkan Rupiah bulat (jurnal menolak pecahan)', () => {
    expect(hitungNominalBunga(1_000_001, 0.0133333)).toBe(Math.round(1_000_001 * 0.0133333));
    expect(Number.isInteger(hitungNominalBunga(1_000_001, 0.0133333))).toBe(true);
  });
});

describe('PERIODISASI', () => {
  it('bulan tidak utuh tidak diakru: mulai 15 Jan -> periode pertama Feb', () => {
    expect(periodePertamaEligible('2026-01-15')).toBe('2026-02');
    expect(periodePertamaEligible('2026-01-01')).toBe('2026-01');
  });

  it('tidak ada akrual sebelum utang mulai', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-03-01' });
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-31' });
    const periode = h.periodeDiproses.map((p) => p.periode);
    expect(periode).toEqual(['2026-03']);
  });

  it('tidak ada akrual periode masa depan', () => {
    expect(daftarPeriodeKandidat('2026-01-01', '2026-03')).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('CATCH-UP: aplikasi tidak dibuka Feb-Apr, dibuka Mei -> semua periode terkejar', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-05-20' });
    // DIPERBARUI RC-S58 (posting di akhir periode): Jan–Apr terkejar; Mei
    // belum selesai pada 20 Mei sehingga belum dibukukan. Sebelumnya 5 / 6.000.000.
    expect(h.jumlahJurnalBaru).toBe(4);
    expect(h.totalDibukukan).toBe(4_800_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(4_800_000);
  });

  it('utang lunas: periode setelah pelunasan tidak diakru', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', jenisBunga: 'EFEKTIF' });
    await bayarUtang({ utangId: id, tanggal: '2026-01-20', pokok: 120_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-04-30' });
    // Hanya Januari (outstanding awal Jan masih 120jt); Feb-Apr sudah lunas
    expect(h.totalDibukukan).toBe(1_200_000);
    expect(h.periodeDiproses.filter((p) => p.hasil === 'LUNAS_SEBELUM_PERIODE').length).toBe(3);
  });
});

describe('PERIODE TERTUTUP', () => {
  it('periode CLOSED tidak diposting otomatis dan menghasilkan exception yang jelas', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);

    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-31' });
    expect(h.jumlahJurnalBaru).toBe(0);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    expect(h.exception.every((e) => e.kode === 'PERIODE_TERTUTUP')).toBe(true);
    expect(h.exception[0].pesan).toMatch(/sudah ditutup/i);
  });

  it('periode CLOSED tidak meninggalkan baris subledger (tidak dianggap sudah diproses)', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });
    const rows = await testDb.getAllAsync(`SELECT id FROM utang_bunga_akrual`);
    expect(rows).toHaveLength(0);

    // Dibuka kembali -> baru diproses.
    await testDb.runAsync(`UPDATE accounting_period SET status='OPEN' WHERE id='p2026'`);
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });
    expect(h.jumlahJurnalBaru).toBe(2);
  });
});

describe('IDEMPOTENSI & CONCURRENCY', () => {
  it('trigger 10x menghasilkan tepat satu akrual per periode', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    for (let i = 0; i < 10; i++) {
      await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    }
    expect(await jumlahJurnalAkrual(id)).toBe(1);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(1_200_000);
    const rows = await testDb.getAllAsync(`SELECT id FROM utang_bunga_akrual WHERE utang_id=?`, id);
    expect(rows).toHaveLength(1);
  });

  it('Promise.all (startup + dashboard + foreground): tetap satu akrual', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await Promise.all([
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
    ]);
    expect(await jumlahJurnalAkrual(id)).toBe(1);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('Promise.allSettled dua trigger simultan: tetap satu akrual', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await Promise.allSettled([
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
    ]);
    expect(await jumlahJurnalAkrual(id)).toBe(1);
  });

  it('gerbang eksekusi tunggal: refresh manual + startup berbagi satu eksekusi', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    const [a, b] = await Promise.all([
      jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-01-31'),
      jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-01-31'),
    ]);
    expect(a).toBe(b);
    expect(await jumlahJurnalAkrual(id)).toBe(1);
  });

  it('UNIQUE constraint database menolak akrual kedua untuk periode yang sama', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await expect(
      testDb.runAsync(
        `INSERT INTO utang_bunga_akrual (id, utang_id, periode, tipe_akrual, mode, basis_bunga, jenis_bunga,
           persen_bunga, dasar_perhitungan, nominal_target, nominal_dibukukan, tanggal_jurnal, idempotency_key, created_by, created_at)
         VALUES ('dup',?,'2026-01','BUNGA_BULANAN','AUTO','TAHUNAN','FLAT',12,120000000,1200000,0,'2026-01-31','k-lain','user-1','now')`,
        id
      )
    ).rejects.toThrow();
  });

  it('kunci idempotensi deterministik dan membedakan periode', () => {
    expect(idempotencyKeyAkrual('u1', '2026-09')).toBe('UTANG_BUNGA:u1:2026-09:BUNGA_BULANAN');
    expect(idempotencyKeyAkrual('u1', '2026-10')).not.toBe(idempotencyKeyAkrual('u1', '2026-09'));
  });
});

describe('INTEGRASI DENGAN MANUAL & PEMBAYARAN', () => {
  it('akrual manual lebih dulu: mesin otomatis TIDAK membebankan ulang (gap control dipertahankan)', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-01-31', nominal: 1_200_000, createdBy: 'user-1' });

    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    expect(h.totalDibukukan).toBe(0);
    expect(h.periodeDiproses[0].hasil).toBe('TIDAK_ADA_GAP');
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('akrual manual sebagian: mesin hanya membukukan selisihnya', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-01-15', nominal: 500_000, createdBy: 'user-1' });
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    expect(h.totalDibukukan).toBe(700_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('pembayaran bunga setelah akrual: Dr Utang Bunga / Cr Kas, TIDAK ada beban kedua', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await bayarUtang({ utangId: id, tanggal: '2026-02-05', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });

    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
  });

  it('partial payment mengurangi Utang Bunga, bukan Beban Bunga', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await bayarUtang({ utangId: id, tanggal: '2026-02-05', pokok: 0, bunga: 400_000, sumberDana: 'KAS', createdBy: 'user-1' });

    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(800_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);

    await bayarUtang({ utangId: id, tanggal: '2026-02-20', pokok: 0, bunga: 800_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('pembayaran langsung tanpa akrual: beban diakui sekali saja', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-02-01' });
    await bayarUtang({ utangId: id, tanggal: '2026-02-10', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    // Beban sudah diakui saat bayar; mesin otomatis tidak boleh menambah lagi.
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });
    expect(h.totalDibukukan).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
  });

  it('reversal akrual mengembalikan saldo dengan benar', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    const j = await testDb.getFirstAsync<{ id: string }>(
      `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND status='POSTED'`,
      id
    );
    await reverseJournal(testDb as any, j!.id, 'user-1', 'Koreksi');

    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(0);
    const replay = await replayBungaUtang(testDb as any, id);
    expect(replay.outstanding).toBe(0);
  });

  it('GL tetap balance dan kontrol gap BALANCED setelah akrual otomatis', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-31' });

    const tb = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(je.debit),0) d, COALESCE(SUM(je.kredit),0) k
         FROM journal_entry je JOIN journal j ON j.id=je.journal_id WHERE j.status='POSTED'`
    );
    expect(tb!.d).toBe(tb!.k);
    expect((await getKontrolGapUtangBunga(testDb as any)).status).toBe('BALANCED');
  });

  it('akrual otomatis tidak menyentuh kas/bank dan tetap NON_KAS', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    const kasSebelum = await saldo(ACC.kas, 'debit');
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });

    expect(await saldo(ACC.kas, 'debit')).toBe(kasSebelum);
    expect(await saldo(ACC.bank, 'debit')).toBe(0);
    expect(classifyTransactionSource('UTANG_BUNGA')).toBe('NON_KAS');

    const adaKas = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal_entry je JOIN journal j ON j.id=je.journal_id
        WHERE j.sumber_transaksi='UTANG_BUNGA' AND je.account_id IN (?,?)`,
      ACC.kas, ACC.bank
    );
    expect(adaKas!.n).toBe(0);
  });
});

describe('ROLLBACK & AUDIT TRAIL', () => {
  it('kegagalan pembuatan jurnal: tidak meninggalkan metadata tanpa jurnal', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    // Mapping beban dihapus -> resolveAccountId gagal di tengah transaksi.
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type='UTANG_BUNGA' AND role='DEBIT_BEBAN'`);

    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    expect(h.jumlahJurnalBaru).toBe(0);
    expect(await testDb.getAllAsync(`SELECT id FROM utang_bunga_akrual`)).toHaveLength(0);
    expect(await jumlahJurnalAkrual(id)).toBe(0);
  });

  it('retry setelah kegagalan menghasilkan tepat satu event', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type='UTANG_BUNGA' AND role='DEBIT_BEBAN'`);
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });

    await seedMapping(testDb, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });

    expect(await jumlahJurnalAkrual(id)).toBe(1);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(1_200_000);
  });

  it('audit trail menjawab: periode, target, dibukukan, pemicu, jurnal mana', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });

    const jejak = await getJejakAkrualBungaUtang(id);
    expect(jejak).toHaveLength(2);
    expect(jejak[0].periode).toBe('2026-01');
    expect(jejak[0].mode).toBe('AUTO');
    expect(jejak[0].basisBunga).toBe('TAHUNAN');
    expect(jejak[0].dasarPerhitungan).toBe(120_000_000);
    expect(jejak[0].nominalTarget).toBe(1_200_000);
    expect(jejak[0].nominalDibukukan).toBe(1_200_000);
    expect(jejak[0].journalId).toBeTruthy();
    expect(jejak[0].nomorJurnal).toBeTruthy();
    expect(jejak[0].createdBy).toBe('user-1');
  });
});

describe('MONITOR', () => {
  it('ringkasan memisahkan eligible dan yang perlu review', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN' });
    await buatUtangLegacy();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });

    const m = await getMonitorAkrualBungaUtang('2026-02-28');
    expect(m.jumlahEligible).toBe(1);
    expect(m.jumlahPerluReview).toBe(1);
    expect(m.periodeBerjalan).toBe('2026-02');
    expect(m.outstandingBunga).toBe(2_400_000);

    const legacy = m.baris.find((b) => b.utangId === 'utg-legacy')!;
    expect(legacy.eligibilitas).toBe('MANUAL_REVIEW_REQUIRED');
    expect(legacy.pesanAlasan).toBe('Basis bunga belum ditentukan.');
    expect(legacy.periodeTerakhirDiproses).toBeNull();
  });

  it('nilaiKontrakBunga murni: tidak butuh database', () => {
    const k = nilaiKontrakBunga({
      id: 'x', nomor_utang: 'U1', nama_pemberi: 'B', jenis_pemberi: 'BANK',
      jenis_bunga: 'FLAT', persen_bunga: 12, basis_bunga: null,
      pokok_pinjaman: 1000, tanggal: '2026-01-01', status: 'AKTIF',
    } as any);
    expect(k.eligibilitas).toBe('MANUAL_REVIEW_REQUIRED');
    expect(k.alasan).toBe('BASIS_BUNGA_BELUM_DITENTUKAN');
  });
});
