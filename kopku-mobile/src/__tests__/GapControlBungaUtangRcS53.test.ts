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
  terimaUtang,
  bayarUtang,
  akruiBungaUtang,
  bagiPembayaranBunga,
  periodeKeyDariTanggal,
  getGapAkrualBungaUtang,
  getDiagnostikUtangBungaHistoris,
} from '@/services/UtangService';
import { reverseJournal } from '@/accounting/AccountingEngine';

/**
 * §Z FINAL — GAP CONTROL BUNGA UTANG & DIAGNOSTIK 2-1700 WARISAN.
 *
 * Seluruh suite berjalan di atas SQLite sungguhan dengan skema produksi
 * dan jurnal dari AccountingEngine asli. Tidak ada mock akuntansi.
 *
 * Yang dibuktikan di sini bukan "kode terlihat benar", melainkan angka
 * yang benar-benar duduk di `journal_entry` setelah rangkaian akrual,
 * pembayaran, dan reversal.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
  modal: 'acc-3-1000',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    nb,
    now,
    now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`,
    tt,
    role,
    accountId
  );
}

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_PIHAK_LAIN', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);

  for (const th of [2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`,
      th,
      `${th}-01-01`,
      `${th}-12-31`
    );
  }
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank A','123','Koperasi',?,1,?)`,
    ACC.bank,
    now
  );
  return db;
}

async function saldoKredit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit) - SUM(je.debit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return r?.s ?? 0;
}

async function saldoDebit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit) - SUM(je.kredit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return r?.s ?? 0;
}

async function jumlahJurnalAkrual(): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'UTANG_BUNGA'`
  );
  return r?.n ?? 0;
}

async function buatUtangUji(): Promise<string> {
  const hasil = await terimaUtang({
    namaPemberi: 'Bank Mitra',
    jenisPemberi: 'BANK',
    pokokPinjaman: 100_000_000,
    persenBunga: 12, basisBunga: 'BULANAN',
    jenisBunga: 'FLAT',
    tanggal: '2026-01-05',
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return hasil.id;
}

beforeEach(async () => {
  testDb = await seedFixture();
});

afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// ACCRUAL & GAP
// ===========================================================================

describe('§Z ACCRUAL — gap control per periode', () => {
  it('1. akrual pertama membukukan penuh', async () => {
    const id = await buatUtangUji();
    const h = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });

    expect(h.periodeKey).toBe('2026-09');
    expect(h.dibukukanSekarang).toBe(1_000_000);
    expect(h.journalId).not.toBeNull();
    expect(await saldoKredit(ACC.utangBunga)).toBe(1_000_000);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_000_000);
  });

  it('2-3. akrual parsial lalu gap — 700.000 kemudian 300.000, bukan 1.000.000 lagi', async () => {
    const id = await buatUtangUji();
    const a = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 700_000,
      createdBy: 'user-1',
    });
    const b = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });

    expect(a.dibukukanSekarang).toBe(700_000);
    expect(b.sudahDiakui).toBe(700_000);
    expect(b.dibukukanSekarang).toBe(300_000);
    expect(await saldoKredit(ACC.utangBunga)).toBe(1_000_000);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_000_000);
  });

  it('4-5. setelah target tercapai, akrual berikutnya 0 dan TIDAK menjurnal', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' });
    const jurnalSebelum = await jumlahJurnalAkrual();

    const lagi = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });

    expect(lagi.dibukukanSekarang).toBe(0);
    expect(lagi.journalId).toBeNull();
    expect(await jumlahJurnalAkrual()).toBe(jurnalSebelum);
    expect(await saldoKredit(ACC.utangBunga)).toBe(1_000_000);
  });

  it('6. tanggal BERBEDA dalam bulan yang sama tetap satu periode', async () => {
    // Inilah lubang guard Tranche 2: tanggal berbeda, nominal sama.
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-15', nominal: 1_000_000, createdBy: 'user-1' });
    const kedua = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });

    expect(kedua.dibukukanSekarang).toBe(0);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_000_000);
  });

  it('7. periode BERBEDA masing-masing punya target sendiri', async () => {
    const id = await buatUtangUji();
    const sep = await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' });
    const okt = await akruiBungaUtang({ utangId: id, tanggal: '2026-10-31', nominal: 1_000_000, createdBy: 'user-1' });

    expect(sep.dibukukanSekarang).toBe(1_000_000);
    expect(okt.periodeKey).toBe('2026-10');
    expect(okt.sudahDiakui).toBe(0);
    expect(okt.dibukukanSekarang).toBe(1_000_000);
    expect(await saldoKredit(ACC.utangBunga)).toBe(2_000_000);
  });

  it('gap dapat dibaca tanpa memposting apa pun', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 400_000, createdBy: 'user-1' });

    const gap = await getGapAkrualBungaUtang(id, '2026-09', 1_000_000);
    expect(gap.akrualBersih).toBe(400_000);
    expect(gap.sisaGap).toBe(600_000);
    expect(gap.melebihiTarget).toBe(false);
    expect(await jumlahJurnalAkrual()).toBe(1);
  });

  it('target LEBIH KECIL dari yang sudah diakui tidak membalik jurnal', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' });

    const turun = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 600_000,
      createdBy: 'user-1',
    });
    // Koreksi ke bawah adalah keputusan akuntansi (reversal), bukan
    // sesuatu yang boleh dilakukan diam-diam oleh gap control.
    expect(turun.dibukukanSekarang).toBe(0);
    expect(await saldoKredit(ACC.utangBunga)).toBe(1_000_000);

    const gap = await getGapAkrualBungaUtang(id, '2026-09', 600_000);
    expect(gap.melebihiTarget).toBe(true);
  });

  it('periodeKeyDariTanggal deterministik', () => {
    expect(periodeKeyDariTanggal('2026-09-30')).toBe('2026-09');
    expect(periodeKeyDariTanggal('2026-09-01')).toBe('2026-09');
    expect(periodeKeyDariTanggal('2026-10-01')).not.toBe('2026-09');
  });
});

// ===========================================================================
// PAYMENT
// ===========================================================================

describe('§Z PAYMENT — rekonsiliasi & tanpa beban kedua', () => {
  async function utangDenganAkrual(nominal = 1_000_000): Promise<string> {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal, createdBy: 'user-1' });
    return id;
  }

  it('8. pembayaran penuh mengosongkan Utang Bunga tanpa menambah beban', async () => {
    const id = await utangDenganAkrual();
    const bebanSebelum = await saldoDebit(ACC.bebanBunga);

    await bayarUtang({
      utangId: id,
      tanggal: '2026-10-05',
      pokok: 0,
      bunga: 1_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(bebanSebelum);
  });

  it('9-10. pembayaran bertahap 300 + 200 + 500 -> outstanding 0', async () => {
    const id = await utangDenganAkrual();
    for (const n of [300_000, 200_000, 500_000]) {
      await bayarUtang({
        utangId: id,
        tanggal: '2026-10-05',
        pokok: 0,
        bunga: n,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      });
    }
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_000_000);
  });

  it('11-12. pembayaran melebihi outstanding TIDAK membuat liabilitas negatif', async () => {
    const id = await utangDenganAkrual();
    await bayarUtang({
      utangId: id,
      tanggal: '2026-10-05',
      pokok: 0,
      bunga: 1_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    // Pembayaran keempat setelah lunas: seluruhnya menjadi beban baru,
    // bukan mendebit liabilitas yang tidak ada.
    await bayarUtang({
      utangId: id,
      tanggal: '2026-10-06',
      pokok: 0,
      bunga: 250_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    expect(await saldoKredit(ACC.utangBunga)).toBeGreaterThan(-1);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_250_000);
  });

  it('13. pembayaran TANPA akrual menjadi beban, tidak mendebit 2-1700', async () => {
    // Semantik ini sudah ditetapkan `bagiPembayaranBunga()` di Tranche 2
    // dan SENGAJA dipertahankan — bukan kebijakan baru.
    const id = await buatUtangUji();
    await bayarUtang({
      utangId: id,
      tanggal: '2026-10-05',
      pokok: 0,
      bunga: 300_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(300_000);
    expect(bagiPembayaranBunga(300_000, 0)).toEqual({ keUtangBunga: 0, keBeban: 300_000 });
  });

  it('23. INVARIAN — beban total = akrual + bunga yang belum pernah diakui', async () => {
    const id = await utangDenganAkrual(1_000_000);
    await bayarUtang({
      utangId: id,
      tanggal: '2026-10-05',
      pokok: 0,
      bunga: 1_400_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    // 1.000.000 diakui saat akrual, 400.000 sisanya baru diakui saat
    // bayar. Total 1.400.000 — bukan 2.400.000.
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_400_000);
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
  });
});

// ===========================================================================
// REVERSAL
// ===========================================================================

describe('§Z REVERSAL', () => {
  it('14. reversal penuh menetralkan akrual — gap kembali terbuka', async () => {
    const id = await buatUtangUji();
    const a = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });

    await testDb.withTransactionAsync(async () => {
      await reverseJournal(testDb as any, a.journalId as string, 'user-1', 'koreksi');
    });

    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    const gap = await getGapAkrualBungaUtang(id, '2026-09', 1_000_000);
    expect(gap.akrualBersih).toBe(0);
    expect(gap.sisaGap).toBe(1_000_000);
  });

  it('15. reversal parsial — akrual bersih = sisa yang belum dibalik', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 400_000, createdBy: 'user-1' });
    const kedua = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });
    expect(kedua.dibukukanSekarang).toBe(600_000);

    await testDb.withTransactionAsync(async () => {
      await reverseJournal(testDb as any, kedua.journalId as string, 'user-1', 'koreksi');
    });

    const gap = await getGapAkrualBungaUtang(id, '2026-09', 1_000_000);
    expect(gap.akrualBersih).toBe(400_000);
    expect(gap.sisaGap).toBe(600_000);
  });

  it('16. akrual ulang setelah reversal boleh, dan tidak dobel', async () => {
    const id = await buatUtangUji();
    const a = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });
    await testDb.withTransactionAsync(async () => {
      await reverseJournal(testDb as any, a.journalId as string, 'user-1', 'koreksi');
    });

    const ulang = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });
    expect(ulang.dibukukanSekarang).toBe(1_000_000);
    expect(await saldoKredit(ACC.utangBunga)).toBe(1_000_000);
    // Beban: 1jt akrual + 1jt reversal(-) + 1jt akrual ulang = 1jt.
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_000_000);
  });
});

// ===========================================================================
// CONCURRENCY, PERIOD, ROLLBACK
// ===========================================================================

describe('§Z CONCURRENCY & PERIODE', () => {
  it('17. dua akrual bersamaan tidak menghasilkan beban ganda', async () => {
    const id = await buatUtangUji();
    const hasil = await Promise.allSettled([
      akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' }),
      akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' }),
    ]);
    const berhasil = hasil.filter((h) => h.status === 'fulfilled');
    expect(berhasil.length).toBeGreaterThan(0);

    // Apa pun urutan penyelesaiannya, total tidak boleh melampaui target.
    expect(await saldoKredit(ACC.utangBunga)).toBe(1_000_000);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_000_000);
  });

  it('19. akrual lalu pembayaran beruntun tetap rekonsiliasi', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' });
    await bayarUtang({
      utangId: id,
      tanggal: '2026-10-05',
      pokok: 0,
      bunga: 600_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(await saldoKredit(ACC.utangBunga)).toBe(400_000);
    expect(await saldoDebit(ACC.bebanBunga)).toBe(1_000_000);
  });

  it('20-21. periode CLOSED ditolak; periode tidak dibuka sendiri', async () => {
    const id = await buatUtangUji();
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);

    await expect(
      akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' })
    ).rejects.toThrow(/ditutup|CLOSED/i);

    expect(await jumlahJurnalAkrual()).toBe(0);
    const p = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM accounting_period WHERE id='p2026'`
    );
    expect(p?.status).toBe('CLOSED');
  });

  it('30. kegagalan menggulung seluruh transaksi (rollback)', async () => {
    const id = await buatUtangUji();
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type='UTANG_BUNGA'`);

    await expect(
      akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' })
    ).rejects.toThrow();

    expect(await jumlahJurnalAkrual()).toBe(0);
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
  });

  it('22/26-29. jurnal balanced, referensi & periode benar, bertahan setelah restart', async () => {
    const id = await buatUtangUji();
    const h = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });

    const j = await testDb.getFirstAsync<{ sumber_transaksi: string; sumber_id: string; tanggal: string }>(
      `SELECT sumber_transaksi, sumber_id, tanggal FROM journal WHERE id = ?`,
      h.journalId as string
    );
    expect(j?.sumber_transaksi).toBe('UTANG_BUNGA');
    expect(j?.sumber_id).toBe(id);
    expect(periodeKeyDariTanggal(j?.tanggal as string)).toBe('2026-09');

    const baris = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      h.journalId as string
    );
    expect(baris.reduce((t, b) => t + b.debit, 0)).toBe(baris.reduce((t, b) => t + b.kredit, 0));

    // "Restart": tidak ada cache; gap dibaca ulang dari database.
    const gap = await getGapAkrualBungaUtang(id, '2026-09', 1_000_000);
    expect(gap.akrualBersih).toBe(1_000_000);
    expect(gap.sisaGap).toBe(0);
  });
});

// ===========================================================================
// DIAGNOSTIK 2-1700 WARISAN
// ===========================================================================

describe('§Z DIAGNOSTIK 2-1700 warisan', () => {
  /**
   * Fixture legacy: akrual 1.000.000 lalu pembayaran 600.000 yang
   * jurnalnya SALAH men-debit Beban Bunga (perilaku sebelum RC-S53).
   * Jurnalnya dibuat langsung lewat SQL agar benar-benar meniru data
   * lama — service saat ini tidak akan pernah menghasilkan jurnal ini.
   */
  async function seedLegacy(utangId: string): Promise<void> {
    await akruiBungaUtang({
      utangId,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });

    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, deskripsi, sumber_transaksi, sumber_id,
                            nomor_referensi, status, period_id, created_by, created_at, updated_at)
       VALUES ('j-legacy','JRN-LEGACY','2026-10-05','Pembayaran bunga (warisan)','UTANG_BAYAR',?,
               'LEG-1','POSTED','p2026','user-1',?,?)`,
      utangId,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
       VALUES ('je-l1','j-legacy',?,600000,0,0)`,
      ACC.bebanBunga
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
       VALUES ('je-l2','j-legacy',?,0,600000,1)`,
      ACC.kas
    );
    await testDb.runAsync(
      `INSERT INTO utang_pembayaran (id, utang_id, tanggal, pokok, bunga, sumber_dana,
                                     nomor_transaksi, journal_id, created_by, created_at)
       VALUES ('bayar-legacy',?,'2026-10-05',0,600000,'KAS','BYR-LEG-1','j-legacy','user-1',?)`,
      utangId,
      now
    );
  }

  it('menghitung expected 400.000, ledger 1.000.000, selisih 600.000', async () => {
    const id = await buatUtangUji();
    await seedLegacy(id);

    const d = await getDiagnostikUtangBungaHistoris();
    expect(d.totalAkrual).toBe(1_000_000);
    expect(d.totalDibayar).toBe(600_000);
    expect(d.outstandingSeharusnya).toBe(400_000);
    expect(d.saldoLedger).toBe(1_000_000);
    expect(d.selisih).toBe(600_000);
    expect(d.adaSelisih).toBe(true);
  });

  it('menunjuk jurnal & periode penyebabnya', async () => {
    const id = await buatUtangUji();
    await seedLegacy(id);

    const d = await getDiagnostikUtangBungaHistoris();
    const baris = d.perUtang.find((b) => b.utangId === id);
    expect(baris).toBeDefined();
    expect(baris?.jurnalPenyebab).toHaveLength(1);
    expect(baris?.jurnalPenyebab[0].journalId).toBe('j-legacy');
    expect(baris?.jurnalPenyebab[0].bunga).toBe(600_000);
    expect(baris?.periodeTerdampak).toEqual(['2026-10']);
  });

  it('usulan koreksi adalah PROPOSAL — tidak ada jurnal koreksi dibuat', async () => {
    const id = await buatUtangUji();
    await seedLegacy(id);
    const jurnalSebelum = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);

    const d = await getDiagnostikUtangBungaHistoris();
    expect(d.usulanKoreksi).toBe(600_000);

    const jurnalSesudah = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);
    expect(jurnalSesudah?.n).toBe(jurnalSebelum?.n);
  });

  it('READ-ONLY — jurnal, entri, ledger, dan pembayaran identik setelah diagnostik', async () => {
    const id = await buatUtangUji();
    await seedLegacy(id);

    const snapshot = async () => ({
      journal: await testDb.getAllAsync(`SELECT * FROM journal ORDER BY id`),
      entry: await testDb.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`),
      bayar: await testDb.getAllAsync(`SELECT * FROM utang_pembayaran ORDER BY id`),
      utang: await testDb.getAllAsync(`SELECT * FROM utang ORDER BY id`),
    });

    const sebelum = await snapshot();
    await getDiagnostikUtangBungaHistoris();
    const sesudah = await snapshot();

    expect(JSON.stringify(sesudah)).toBe(JSON.stringify(sebelum));
  });

  it('data yang sehat (pasca RC-S53) tidak memunculkan selisih', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 1_000_000, createdBy: 'user-1' });
    await bayarUtang({
      utangId: id,
      tanggal: '2026-10-05',
      pokok: 0,
      bunga: 600_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const d = await getDiagnostikUtangBungaHistoris();
    expect(d.outstandingSeharusnya).toBe(400_000);
    expect(d.saldoLedger).toBe(400_000);
    expect(d.selisih).toBe(0);
    expect(d.adaSelisih).toBe(false);
  });

  it('reversal ikut diperhitungkan dalam diagnostik', async () => {
    const id = await buatUtangUji();
    const a = await akruiBungaUtang({
      utangId: id,
      tanggal: '2026-09-30',
      nominal: 1_000_000,
      createdBy: 'user-1',
    });
    await testDb.withTransactionAsync(async () => {
      await reverseJournal(testDb as any, a.journalId as string, 'user-1', 'koreksi');
    });

    const d = await getDiagnostikUtangBungaHistoris();
    expect(d.totalReversal).toBe(1_000_000);
    expect(d.outstandingSeharusnya).toBe(0);
    expect(d.saldoLedger).toBe(0);
    expect(d.selisih).toBe(0);
  });
});
