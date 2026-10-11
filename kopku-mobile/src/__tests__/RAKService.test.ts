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

import { catatRAK, editRAK, batalkanRAK, listRAK, getRAKDetail, JENIS_RAK_LABEL } from '@/services/RAKService';

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`,
    transactionType,
    role,
    accountId
  );
}

const ACC = { kas: 'acc-kas', rak: 'acc-rak', modal: 'acc-modal' };

async function isiKas(db: TestDb, nominal: number) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'journal-isi-kas',
    'JRN-ISI-KAS',
    '2026-01-01',
    'period-2026',
    'MODAL_AWAL',
    'Isi kas (fixture test)',
    'POSTED',
    'user-1',
    now,
    now,
    now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-isi-debit', 'journal-isi-kas', ACC.kas, nominal);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-isi-kredit', 'journal-isi-kas', ACC.modal, nominal);
}

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.rak, '1-1800', 'Rekening Antar Kantor (RAK)', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'RAK', 'DEBIT_ASET', ACC.rak);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );
  return db;
}

async function saldoAkun(db: TestDb, accountId: string): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
    accountId
  );
  return row?.total ?? 0;
}

describe('RAKService', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('catatRAK PENYALURAN_DANA: jurnal balance, DEBIT Rekening Antar Kantor KREDIT Kas, tersimpan status AKTIF', async () => {
    await isiKas(testDb, 20_000_000);

    const { id, nomorRak } = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang Makassar',
      jumlah: 10_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(nomorRak).toMatch(/RAK/);
    expect(await saldoAkun(testDb, ACC.kas)).toBe(10_000_000);
    expect(await saldoAkun(testDb, ACC.rak)).toBe(10_000_000);

    const detail = await getRAKDetail(id);
    expect(detail?.status).toBe('AKTIF');
    expect(detail?.jenisRak).toBe('PENYALURAN_DANA');
    expect(detail?.namaUnit).toBe('Kantor Cabang Makassar');

    const daftar = await listRAK();
    expect(daftar).toHaveLength(1);
  });

  test('catatRAK SETORAN_DANA: DITOLAK untuk transaksi baru (update pasca-Phase 18/19 §C.4) — hanya PENYALURAN_DANA yang boleh dipilih', async () => {
    await isiKas(testDb, 5_000_000);

    await expect(
      catatRAK({
        // @ts-expect-error SETORAN_DANA sengaja tidak lagi ada di JenisRAKInput — dicek tetap ditolak di runtime kalau ada pemanggil lama yang lolos dari type-check (mis. lewat any).
        jenisRak: 'SETORAN_DANA',
        namaUnit: 'Kantor Pusat',
        jumlah: 3_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Setoran Dana ke Unit\/Kantor Pusat.*sudah tidak dapat dipilih/);

    const daftar = await listRAK();
    expect(daftar).toHaveLength(0);
    expect(await saldoAkun(testDb, ACC.rak)).toBe(0);
  });

  test('histori SETORAN_DANA lama (dari sebelum update ini) tetap terbaca lewat listRAK/getRAKDetail — data lama TIDAK rusak', async () => {
    // Simulasi baris lama: SETORAN_DANA hanya bisa ada di database
    // dari SEBELUM update ini (catatRAK sekarang menolaknya) — di sini
    // di-seed langsung persis seperti baris yang sudah lama tersimpan.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-setoran-lama','JRN-SETORAN','2025-06-01','period-2026','RAK','Setoran dana lama','POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO rak_transaksi
        (id, nomor_rak, jenis_rak, nama_unit, jumlah, tanggal, sumber_dana, bank_account_id,
         keterangan, status, journal_id, reversal_of_id, created_by, created_at, updated_at)
       VALUES ('rak-lama','RAK-2025-000001','SETORAN_DANA','Kantor Pusat',2000000,'2025-06-01','KAS',NULL,NULL,'AKTIF','journal-setoran-lama',NULL,'user-1',?,?)`,
      now,
      now
    );

    const daftar = await listRAK();
    expect(daftar.find((d) => d.id === 'rak-lama')?.jenisRak).toBe('SETORAN_DANA');

    const detail = await getRAKDetail('rak-lama');
    expect(detail?.jenisRak).toBe('SETORAN_DANA');
    expect(detail?.namaUnit).toBe('Kantor Pusat');
    expect(detail?.jumlah).toBe(2_000_000);
  });

  test('catatRAK: DITOLAK kalau saldo kas tidak cukup', async () => {
    await isiKas(testDb, 1_000_000);
    await expect(
      catatRAK({
        jenisRak: 'PENYALURAN_DANA',
        namaUnit: 'Kantor Cabang',
        jumlah: 5_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);
    expect(await listRAK()).toHaveLength(0);
  });

  test('catatRAK: DITOLAK kalau nama unit kosong', async () => {
    await isiKas(testDb, 10_000_000);
    await expect(
      catatRAK({
        jenisRak: 'PENYALURAN_DANA',
        namaUnit: '   ',
        jumlah: 1_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Nn]ama unit/);
  });

  test('catatRAK: DITOLAK kalau nominal 0 atau negatif', async () => {
    await isiKas(testDb, 10_000_000);
    await expect(
      catatRAK({
        jenisRak: 'PENYALURAN_DANA',
        namaUnit: 'Kantor Cabang',
        jumlah: 0,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Nn]ominal/);
  });

  test('batalkanRAK: reversal jurnal, saldo kembali seperti semula, status DIBATALKAN, baris asli TETAP ADA', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang Makassar',
      jumlah: 10_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(await saldoAkun(testDb, ACC.rak)).toBe(10_000_000);

    await batalkanRAK(id, 'user-1', 'Salah input nominal');

    // Reversal jurnal mengembalikan saldo RAK & Kas ke sebelum transaksi ini.
    expect(await saldoAkun(testDb, ACC.rak)).toBe(0);
    expect(await saldoAkun(testDb, ACC.kas)).toBe(20_000_000);

    const detail = await getRAKDetail(id);
    expect(detail?.status).toBe('DIBATALKAN');

    // Baris asli TIDAK dihapus — masih bisa ditelusuri (audit trail).
    const daftar = await listRAK();
    expect(daftar).toHaveLength(1);
    expect(daftar[0].id).toBe(id);
  });

  test('batalkanRAK: DITOLAK kalau sudah dibatalkan sebelumnya (tidak bisa dibatalkan 2x)', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await batalkanRAK(id, 'user-1', 'Alasan pertama');
    await expect(batalkanRAK(id, 'user-1', 'Alasan kedua')).rejects.toThrow(/sudah dibatalkan/);
  });

  test('batalkanRAK: DITOLAK kalau alasan kosong', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await expect(batalkanRAK(id, 'user-1', '   ')).rejects.toThrow(/[Aa]lasan/);
  });

  test('editRAK: transaksi lama di-reversal (bukan di-UPDATE langsung), transaksi baru dibuat dengan data hasil edit, ditaut via reversalOfId', async () => {
    await isiKas(testDb, 20_000_000);
    const { id: idLama } = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang Lama',
      jumlah: 10_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const { id: idBaru, nomorRak: nomorBaru } = await editRAK(idLama, 'user-1', {
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang Baru',
      jumlah: 7_000_000,
      tanggal: '2026-02-05',
      sumberDana: 'KAS',
      keterangan: 'Koreksi nominal & nama unit',
    });

    // Baris lama dibatalkan (reversal), TIDAK dihapus.
    const lama = await getRAKDetail(idLama);
    expect(lama?.status).toBe('DIBATALKAN');

    // Baris baru AKTIF dengan data hasil edit.
    const baru = await getRAKDetail(idBaru);
    expect(baru?.status).toBe('AKTIF');
    expect(baru?.namaUnit).toBe('Kantor Cabang Baru');
    expect(baru?.jumlah).toBe(7_000_000);
    expect(baru?.jenisRak).toBe('PENYALURAN_DANA');
    expect(baru?.reversalOfId).toBe(idLama);
    expect(nomorBaru).not.toBe(baru?.nomorRak ? undefined : nomorBaru); // sanity: nomorRak terisi

    // Saldo akhir: hanya transaksi BARU yang berlaku (10jt lama dibalik, 7jt baru dicatat).
    expect(await saldoAkun(testDb, ACC.rak)).toBe(7_000_000);
    expect(await saldoAkun(testDb, ACC.kas)).toBe(13_000_000);

    // Kedua baris (lama+baru) tetap terlihat di daftar untuk audit trail.
    const daftar = await listRAK();
    expect(daftar).toHaveLength(2);
  });

  test('editRAK: DITOLAK kalau saldo kas tidak cukup untuk nominal baru', async () => {
    await isiKas(testDb, 5_000_000);
    const { id } = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang',
      jumlah: 3_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // Setelah transaksi awal (3jt keluar), sisa kas 2jt — edit ke 100jt harus ditolak.
    await expect(
      editRAK(id, 'user-1', {
        jenisRak: 'PENYALURAN_DANA',
        namaUnit: 'Kantor Cabang',
        jumlah: 100_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
      })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);

    // Transaksi lama TETAP AKTIF (edit gagal harus di-rollback penuh, bukan setengah).
    const detail = await getRAKDetail(id);
    expect(detail?.status).toBe('AKTIF');
  });
});

describe('RAKService — label transaksi baru (update pasca-6-perbaikan §1)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('JENIS_RAK_LABEL.PENYALURAN_DANA = "Penyaluran Dana ke Unit dan Kantor Cabang" (label baru, bukan "...ke Unit/Kantor" lama)', () => {
    expect(JENIS_RAK_LABEL.PENYALURAN_DANA).toBe('Penyaluran Dana ke Unit dan Kantor Cabang');
    expect(JENIS_RAK_LABEL.PENYALURAN_DANA).not.toBe('Penyaluran Dana ke Unit/Kantor');
  });

  test('kode internal PENYALURAN_DANA TIDAK berubah — transaksi baru tetap tersimpan dengan kode yang sama, hanya labelnya yang beda', async () => {
    await isiKas(testDb, 5_000_000);
    const { id } = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang Makassar',
      jumlah: 2_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const detail = await getRAKDetail(id);
    expect(detail?.jenisRak).toBe('PENYALURAN_DANA'); // kode internal tidak berubah
    expect(JENIS_RAK_LABEL[detail!.jenisRak]).toBe('Penyaluran Dana ke Unit dan Kantor Cabang'); // label yang ditampilkan sudah baru
  });

  test('histori SETORAN_DANA lama tetap terbaca & tidak terpengaruh oleh perubahan label PENYALURAN_DANA', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-lama','JRN-LAMA','2025-06-01','period-2026','RAK','Setoran dana lama','POSTED','user-1',?,?,?)`,
      now, now, now
    );
    await testDb.runAsync(
      `INSERT INTO rak_transaksi
        (id, nomor_rak, jenis_rak, nama_unit, jumlah, tanggal, sumber_dana, bank_account_id,
         keterangan, status, journal_id, reversal_of_id, created_by, created_at, updated_at)
       VALUES ('rak-lama','RAK-2025-000001','SETORAN_DANA','Kantor Pusat',1000000,'2025-06-01','KAS',NULL,NULL,'AKTIF','journal-lama',NULL,'user-1',?,?)`,
      now, now
    );

    const detail = await getRAKDetail('rak-lama');
    expect(detail?.jenisRak).toBe('SETORAN_DANA');
    expect(JENIS_RAK_LABEL[detail!.jenisRak]).toBe('Setoran Dana ke Unit/Kantor Pusat'); // label lama untuk kategori ini tidak diminta berubah
  });
});
