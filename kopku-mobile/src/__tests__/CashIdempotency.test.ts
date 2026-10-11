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

import { catatPemasukan, catatPengeluaran } from '@/services/KasBankService';

/**
 * BUG-07 — IDEMPOTENSI TRANSAKSI KAS MANUAL.
 *
 * Kolom `idempotency_key` dan UNIQUE INDEX parsialnya
 * (`idx_kas_idempotency`, `idx_bank_idempotency`) SUDAH ADA di skema
 * sejak lama tetapi tidak pernah dipakai satu pun service —
 * infrastruktur mati. Akibatnya double-submit atau retry setelah
 * timeout menghasilkan DUA jurnal dan DUA pergerakan kas.
 *
 * Yang sengaja TIDAK dilakukan: menyimpulkan duplikat dari kombinasi
 * nominal + tanggal + akun. Dua setoran Rp250.000 pada hari yang sama
 * adalah dua transaksi SAH; memblokirnya adalah kerusakan yang lebih
 * halus dan lebih sulit disadari daripada jurnal ganda. Karena itu
 * idempotensi berbasis identitas SUBMIT yang dikirim pemanggil.
 */

const ACC = { kas: 'acc-kas', pendapatanLain: 'acc-pendapatan-lain', bebanLain: 'acc-beban-lain', modal: 'acc-modal' };

async function seedAccount(
  db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanLain, '4-2000', 'Pendapatan Lain-lain', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.bebanLain, '5-2000', 'Beban Lainnya', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m-kas','KAS_UMUM','DEFAULT',?)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p26',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-M','2026-01-01','p26','MODAL_UANG','Modal awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je1','j-modal',?,?,0)`,
    ACC.kas, 50_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je2','j-modal',?,0,?)`,
    ACC.modal, 50_000_000
  );
});

async function jumlah(sql: string): Promise<number> {
  return (await testDb.getFirstAsync<{ n: number }>(sql))?.n ?? 0;
}

const PEMASUKAN = {
  jenis: 'KAS' as const,
  tanggal: '2026-02-10',
  nominal: 250_000,
  akunLawanId: ACC.pendapatanLain,
  createdBy: 'user-1',
};

describe('BUG-07 — idempotensi kas manual', () => {
  test('dua panggilan dengan kunci SAMA hanya menghasilkan SATU jurnal dan SATU baris kas', async () => {
    const pertama = await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'submit-abc' });
    const jurnalSetelah1 = await jumlah(`SELECT COUNT(*) as n FROM journal`);

    const kedua = await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'submit-abc' });

    expect(kedua.id).toBe(pertama.id);
    expect(kedua.journalId).toBe(pertama.journalId);
    expect(await jumlah(`SELECT COUNT(*) as n FROM journal`)).toBe(jurnalSetelah1);
    expect(await jumlah(`SELECT COUNT(*) as n FROM kas_transaksi`)).toBe(1);
  });

  test('retry berkali-kali (timeout) tetap satu efek akuntansi', async () => {
    for (let i = 0; i < 5; i++) {
      await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'submit-retry' });
    }
    expect(await jumlah(`SELECT COUNT(*) as n FROM kas_transaksi`)).toBe(1);
    expect(
      await jumlah(
        `SELECT COUNT(*) as n FROM journal WHERE sumber_transaksi = 'KAS_PENERIMAAN_LAIN'`
      )
    ).toBe(1);
  });

  test('kas tidak bergerak dua kali', async () => {
    const saldo = async () =>
      jumlah(
        `SELECT COALESCE(SUM(je.debit - je.kredit),0) as n FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
         WHERE je.account_id = '${ACC.kas}' AND j.status IN ('POSTED','REVERSED')`
      );
    const sebelum = await saldo();
    await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'submit-saldo' });
    const setelah1 = await saldo();
    await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'submit-saldo' });
    expect(setelah1 - sebelum).toBe(250_000);
    expect(await saldo()).toBe(setelah1);
  });

  test('KUNCI BERBEDA dengan nominal, tanggal, dan akun SAMA tetap boleh — itu dua transaksi sah', async () => {
    await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'submit-1' });
    await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'submit-2' });
    expect(await jumlah(`SELECT COUNT(*) as n FROM kas_transaksi`)).toBe(2);
  });

  test('tanpa kunci sama sekali, perilaku PERSIS seperti sebelumnya (tidak ada pemblokiran baru)', async () => {
    await catatPemasukan(PEMASUKAN);
    await catatPemasukan(PEMASUKAN);
    expect(await jumlah(`SELECT COUNT(*) as n FROM kas_transaksi`)).toBe(2);
  });

  test('pengeluaran juga idempoten dengan mekanisme yang sama', async () => {
    const a = await catatPengeluaran({
      jenis: 'KAS',
      tanggal: '2026-02-11',
      nominal: 100_000,
      akunLawanId: ACC.bebanLain,
      createdBy: 'user-1',
      idempotencyKey: 'keluar-1',
    });
    const b = await catatPengeluaran({
      jenis: 'KAS',
      tanggal: '2026-02-11',
      nominal: 100_000,
      akunLawanId: ACC.bebanLain,
      createdBy: 'user-1',
      idempotencyKey: 'keluar-1',
    });
    expect(b.id).toBe(a.id);
    expect(await jumlah(`SELECT COUNT(*) as n FROM kas_transaksi`)).toBe(1);
  });

  test('kunci yang sama TIDAK boleh dipakai ulang untuk transaksi jenis berbeda', async () => {
    const masuk = await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'lintas' });
    // Pengeluaran dengan kunci yang sama mengembalikan efek yang SUDAH
    // ada, bukan membuat pengeluaran baru — kunci mengidentifikasi
    // SUBMIT, dan submit itu sudah diproses.
    const keluar = await catatPengeluaran({
      jenis: 'KAS',
      tanggal: '2026-02-12',
      nominal: 999_000,
      akunLawanId: ACC.bebanLain,
      createdBy: 'user-1',
      idempotencyKey: 'lintas',
    });
    expect(keluar.id).toBe(masuk.id);
    expect(await jumlah(`SELECT COUNT(*) as n FROM kas_transaksi`)).toBe(1);
  });

  test('kunci tersimpan di database sehingga jaminannya bertahan lintas sesi', async () => {
    await catatPemasukan({ ...PEMASUKAN, idempotencyKey: 'tersimpan' });
    const row = await testDb.getFirstAsync<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM kas_transaksi WHERE idempotency_key = 'tersimpan'`
    );
    expect(row?.idempotency_key).toBe('tersimpan');
  });
});
