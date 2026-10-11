import { createTestDb, TestDb } from './testDb';

/**
 * KasBankService.ts memakai getDb()/withTransaction() dari database/db.ts
 * secara internal (pola yang sama dengan SimpananService/PinjamanService/
 * ShuService), bukan menerima db sebagai parameter. Teknik mock di sini
 * SAMA PERSIS dengan ShuService.test.ts — lihat komentar di sana untuk
 * penjelasan lengkap kenapa jest.requireActual TIDAK dipakai.
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
  listRekening,
  getSaldoRekening,
  tambahRekeningBank,
  editRekeningBank,
  catatPemasukan,
  catatPengeluaran,
  transferAntarRekening,
  listRiwayatTransaksi,
  koreksiTransaksiKasBank,
  catatSaldoAwalKas,
} from '@/services/KasBankService';

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

const ACC = {
  kas: 'acc-kas',
  kasKecil: 'acc-kas-kecil',
  modalLainnya: 'acc-modal-lainnya',
  pendapatanLain: 'acc-pendapatan-lain',
  bebanOperasional: 'acc-beban-operasional',
};

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.kasKecil, '1-1001', 'Kas Kecil', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.modalLainnya, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanLain, '4-3000', 'Pendapatan Lainnya', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.bebanOperasional, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'KAS_KECIL', 'DEFAULT', ACC.kasKecil);
  await seedMapping(testDb, 'SHU_DISTRIBUSI', 'KREDIT_DANA_LAINNYA', ACC.modalLainnya);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  // Fase 8: requirePermission() butuh baris app_user nyata untuk resolusi
  // role — 'user-1' diberi role ADMIN (izin penuh) supaya test-test
  // business logic di file ini tidak terganggu; skenario permission
  // (role terbatas, unauthorized) diuji khusus di PermissionService.test.ts.
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );
}

describe('KasBankService — rekening & saldo (PRD fase 7 §1-6, §20)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('listRekening mengembalikan Kas Tunai & Kas Kecil dengan saldo 0 saat belum ada transaksi', async () => {
    const rekening = await listRekening();
    const kas = rekening.find((r) => r.jenis === 'KAS');
    const kasKecil = rekening.find((r) => r.jenis === 'KAS_KECIL');
    expect(kas?.saldo).toBe(0);
    expect(kasKecil?.saldo).toBe(0);
  });

  // Audit ulang (permintaan pengguna §21/§22): "Saldo Awal" DIHAPUS
  // dari form/pembuatan Data Bank — tambahRekeningBank() TIDAK LAGI
  // membuat jurnal apa pun, berapa pun nilai `saldoAwal` yang dikirim
  // (parameter dipertahankan opsional untuk kompatibilitas mundur,
  // TAPI diam-diam diabaikan untuk keperluan jurnal/saldo). Saldo awal
  // sekarang HARUS lewat modul "Saldo Akun (COA)" (SaldoAwalAkunService).
  test('tambahRekeningBank TIDAK LAGI membuat jurnal apa pun, walau saldoAwal diisi > 0 (perilaku lama dihapus)', async () => {
    const { id } = await tambahRekeningBank({
      namaBank: 'BCA',
      nomorRekening: '1234567890',
      namaPemilik: 'Koperasi Sejahtera',
      saldoAwal: 5_000_000,
      createdBy: 'user-1',
    });

    const jurnalCount = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_id = ?`,
      id
    );
    expect(jurnalCount?.cnt ?? 0).toBe(0);

    const saldo = await getSaldoRekening('BANK', id);
    expect(saldo).toBe(0); // saldo HANYA dari ledger — tidak ada jurnal, jadi 0
  });

  test('tambahRekeningBank tanpa saldoAwal sama sekali (parameter dihapus dari form) tetap berhasil membuat rekening', async () => {
    const { id } = await tambahRekeningBank({
      namaBank: 'Mandiri',
      nomorRekening: '9999999999',
      namaPemilik: 'Koperasi Sejahtera',
      createdBy: 'user-1',
    });
    const jurnalCount = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_id = ?`,
      id
    );
    expect(jurnalCount?.cnt ?? 0).toBe(0);
    const rekening = await listRekening();
    expect(rekening.find((r) => r.id === id)).toBeDefined();
  });

  test('tambahRekeningBank menolak saldo awal negatif (validasi tetap ada meski tidak lagi menjurnal)', async () => {
    await expect(
      tambahRekeningBank({ namaBank: 'BNI', nomorRekening: '1111', namaPemilik: 'X', saldoAwal: -100, createdBy: 'user-1' })
    ).rejects.toThrow(/tidak boleh negatif/);
  });

  test('dua rekening bank punya akun ledger terpisah — saldo tidak tercampur (keduanya 0 karena tidak ada jurnal saldo awal otomatis lagi)', async () => {
    const bca = await tambahRekeningBank({ namaBank: 'BCA', nomorRekening: '111', namaPemilik: 'X', createdBy: 'user-1' });
    const bni = await tambahRekeningBank({ namaBank: 'BNI', nomorRekening: '222', namaPemilik: 'X', createdBy: 'user-1' });

    expect(await getSaldoRekening('BANK', bca.id)).toBe(0);
    expect(await getSaldoRekening('BANK', bni.id)).toBe(0);
    expect(bca.accountId).not.toBe(bni.accountId);
  });

  test('editRekeningBank mengubah nama/nomor/status TANPA mengubah saldo', async () => {
    const { id } = await tambahRekeningBank({ namaBank: 'BCA', nomorRekening: '111', namaPemilik: 'Budi', createdBy: 'user-1' });
    await editRekeningBank('user-1', id, { namaBank: 'BCA Syariah', nomorRekening: '222', aktif: false });

    const rekening = await listRekening();
    const updated = rekening.find((r) => r.id === id);
    expect(updated?.nama).toContain('BCA Syariah');
    expect(updated?.aktif).toBe(false);
    expect(updated?.saldo).toBe(0); // saldo tidak berubah oleh edit (masih 0, tidak ada jurnal)
  });

  test('Phase 17 §N: tambahRekeningBank tidak butuh namaPemilik (field dihapus dari form)', async () => {
    const { id } = await tambahRekeningBank({ namaBank: 'BRI', nomorRekening: '333', createdBy: 'user-1' });
    const rekening = await listRekening();
    expect(rekening.find((r) => r.id === id)).toBeDefined();
  });

  test('Phase 17 §N: editRekeningBank TIDAK menimpa nama_pemilik lama (kolom tidak ada di klausa SET lagi)', async () => {
    const { id } = await tambahRekeningBank({ namaBank: 'BCA', nomorRekening: '111', namaPemilik: 'Nama Pemilik Lama', createdBy: 'user-1' });
    await editRekeningBank('user-1', id, { namaBank: 'BCA', nomorRekening: '111', aktif: true });

    const row = await testDb.getFirstAsync<{ nama_pemilik: string }>(`SELECT nama_pemilik FROM bank_account WHERE id = ?`, id);
    expect(row?.nama_pemilik).toBe('Nama Pemilik Lama'); // tidak ditimpa kosong
  });

  test('Phase 17 §O: listRekening tetap mengembalikan Kas Tunai/Kas Kecil (data tidak hilang, cuma tidak ditampilkan sebagai bank di layar "Data Bank")', async () => {
    const rekening = await listRekening();
    expect(rekening.some((r) => r.jenis === 'KAS')).toBe(true);
    expect(rekening.some((r) => r.jenis === 'KAS_KECIL')).toBe(true);
  });
});

describe('KasBankService — catatSaldoAwalKas (BARU: Kas Umum/Kas Kecil sebelumnya tidak punya jalan resmi diberi saldo awal)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('mencatat saldo awal Kas Umum, langsung terlihat di getSaldoRekening', async () => {
    await catatSaldoAwalKas({ jenisKas: 'KAS_UMUM', saldoAwal: 3_000_000, tanggal: '2026-01-01', createdBy: 'user-1' });
    const saldo = await getSaldoRekening('KAS');
    expect(saldo).toBe(3_000_000);
  });

  test('mencatat saldo awal Kas Kecil terpisah dari Kas Umum', async () => {
    await catatSaldoAwalKas({ jenisKas: 'KAS_UMUM', saldoAwal: 3_000_000, tanggal: '2026-01-01', createdBy: 'user-1' });
    await catatSaldoAwalKas({ jenisKas: 'KAS_KECIL', saldoAwal: 500_000, tanggal: '2026-01-01', createdBy: 'user-1' });
    expect(await getSaldoRekening('KAS')).toBe(3_000_000);
    expect(await getSaldoRekening('KAS_KECIL')).toBe(500_000);
  });

  test('DITOLAK kalau saldo awal untuk akun yang sama sudah pernah dicatat sebelumnya', async () => {
    await catatSaldoAwalKas({ jenisKas: 'KAS_UMUM', saldoAwal: 1_000_000, tanggal: '2026-01-01', createdBy: 'user-1' });
    await expect(
      catatSaldoAwalKas({ jenisKas: 'KAS_UMUM', saldoAwal: 2_000_000, tanggal: '2026-02-01', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah pernah dicatat/);
    // Saldo tidak berubah dari percobaan kedua yang ditolak.
    expect(await getSaldoRekening('KAS')).toBe(1_000_000);
  });

  test('DITOLAK kalau saldo awal 0 atau negatif', async () => {
    await expect(
      catatSaldoAwalKas({ jenisKas: 'KAS_UMUM', saldoAwal: 0, tanggal: '2026-01-01', createdBy: 'user-1' })
    ).rejects.toThrow(/lebih dari 0/);
  });
});

describe('KasBankService — transaksi pemasukan/pengeluaran (PRD fase 7 §7-8, §18-19)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('catatPemasukan menambah saldo rekening & jurnal balance', async () => {
    const { journalId } = await catatPemasukan({
      jenis: 'KAS',
      tanggal: '2026-02-01',
      nominal: 200_000,
      akunLawanId: ACC.pendapatanLain,
      kategori: 'Pendapatan Lain',
      createdBy: 'user-1',
    });

    expect(await getSaldoRekening('KAS')).toBe(200_000);

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(200_000);
  });

  test('catatPengeluaran mengurangi saldo rekening', async () => {
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-02-01', nominal: 500_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });
    await catatPengeluaran({
      jenis: 'KAS',
      tanggal: '2026-02-05',
      nominal: 150_000,
      akunLawanId: ACC.bebanOperasional,
      kategori: 'Operasional',
      createdBy: 'user-1',
    });

    expect(await getSaldoRekening('KAS')).toBe(350_000);
  });

  test('nominal 0 atau negatif DITOLAK (validasi fase 7)', async () => {
    await expect(
      catatPemasukan({ jenis: 'KAS', tanggal: '2026-02-01', nominal: 0, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' })
    ).rejects.toThrow(/lebih besar dari 0/);
    await expect(
      catatPengeluaran({ jenis: 'KAS', tanggal: '2026-02-01', nominal: -100, akunLawanId: ACC.bebanOperasional, createdBy: 'user-1' })
    ).rejects.toThrow(/lebih besar dari 0/);
  });

  test('Phase 4: catatPengeluaran DITOLAK kalau saldo kas tidak cukup (AUDIT_INTERNAL.md §3.3)', async () => {
    // Kas masih 0 (belum ada pemasukan sama sekali di test ini).
    await expect(
      catatPengeluaran({
        jenis: 'KAS',
        tanggal: '2026-02-01',
        nominal: 100_000,
        akunLawanId: ACC.bebanOperasional,
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);

    // Saldo tetap 0 — transaksi yang ditolak tidak meninggalkan jejak apa pun.
    expect(await getSaldoRekening('KAS')).toBe(0);
  });

  test('transaksi Kas Kecil memakai akun terpisah dari Kas Tunai', async () => {
    await catatPemasukan({ jenis: 'KAS_KECIL', tanggal: '2026-02-01', nominal: 100_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });
    expect(await getSaldoRekening('KAS_KECIL')).toBe(100_000);
    expect(await getSaldoRekening('KAS')).toBe(0);
  });

  test('kategori & deskripsi tersimpan pada baris transaksi (fase 7 §10, §13)', async () => {
    await catatPemasukan({
      jenis: 'KAS',
      tanggal: '2026-02-01',
      nominal: 50_000,
      akunLawanId: ACC.pendapatanLain,
      kategori: 'Pendapatan Lain',
      keterangan: 'Penjualan formulir',
      createdBy: 'user-1',
    });
    const riwayat = await listRiwayatTransaksi({ jenis: 'KAS' });
    expect(riwayat[0].kategori).toBe('Pendapatan Lain');
    expect(riwayat[0].keterangan).toBe('Penjualan formulir');
  });
});

describe('KasBankService — transfer antar rekening (PRD fase 7 §9)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('transfer KAS -> Bank: satu jurnal balance, saldo sumber turun & tujuan naik sama persis', async () => {
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-01-05', nominal: 1_000_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });
    const bank = await tambahRekeningBank({ namaBank: 'BCA', nomorRekening: '111', namaPemilik: 'X', saldoAwal: 0, createdBy: 'user-1' });

    const { journalId } = await transferAntarRekening({
      sumberJenis: 'KAS',
      tujuanJenis: 'BANK',
      tujuanBankAccountId: bank.id,
      tanggal: '2026-02-01',
      nominal: 400_000,
      createdBy: 'user-1',
    });

    expect(await getSaldoRekening('KAS')).toBe(600_000);
    expect(await getSaldoRekening('BANK', bank.id)).toBe(400_000);

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    expect(entries.length).toBe(2);
    expect(entries.reduce((a, e) => a + e.debit, 0)).toBe(entries.reduce((a, e) => a + e.kredit, 0));
  });

  test('Phase 4: transfer DITOLAK kalau saldo rekening sumber tidak cukup', async () => {
    const bank = await tambahRekeningBank({ namaBank: 'BCA', nomorRekening: '111', namaPemilik: 'X', saldoAwal: 0, createdBy: 'user-1' });
    // Kas masih 0, coba transfer 100.000 dari Kas ke Bank.
    await expect(
      transferAntarRekening({
        sumberJenis: 'KAS',
        tujuanJenis: 'BANK',
        tujuanBankAccountId: bank.id,
        tanggal: '2026-02-01',
        nominal: 100_000,
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);

    expect(await getSaldoRekening('KAS')).toBe(0);
    expect(await getSaldoRekening('BANK', bank.id)).toBe(0);
  });

  test('transfer tercatat di RIWAYAT KEDUA rekening (sumber & tujuan) — bukan cuma satu sisi', async () => {
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-01-05', nominal: 1_000_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });
    const bank = await tambahRekeningBank({ namaBank: 'BCA', nomorRekening: '111', namaPemilik: 'X', saldoAwal: 0, createdBy: 'user-1' });

    await transferAntarRekening({
      sumberJenis: 'KAS',
      tujuanJenis: 'BANK',
      tujuanBankAccountId: bank.id,
      tanggal: '2026-02-01',
      nominal: 400_000,
      createdBy: 'user-1',
    });

    const riwayatKas = await listRiwayatTransaksi({ jenis: 'KAS' });
    const riwayatBank = await listRiwayatTransaksi({ jenis: 'BANK', bankAccountId: bank.id });
    expect(riwayatKas.some((r) => r.tipe === 'TRANSFER')).toBe(true);
    expect(riwayatBank.some((r) => r.tipe === 'TRANSFER')).toBe(true);
  });

  test('rekening sumber dan tujuan yang SAMA ditolak (validasi fase 7)', async () => {
    await expect(
      transferAntarRekening({
        sumberJenis: 'KAS',
        tujuanJenis: 'KAS',
        tanggal: '2026-02-01',
        nominal: 100_000,
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/tidak boleh sama/);
  });

  test('transfer dengan nominal tidak valid ditolak', async () => {
    const bank = await tambahRekeningBank({ namaBank: 'BCA', nomorRekening: '111', namaPemilik: 'X', saldoAwal: 0, createdBy: 'user-1' });
    await expect(
      transferAntarRekening({
        sumberJenis: 'KAS',
        tujuanJenis: 'BANK',
        tujuanBankAccountId: bank.id,
        tanggal: '2026-02-01',
        nominal: 0,
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/lebih besar dari 0/);
  });
});

describe('KasBankService — koreksi transaksi (PRD fase 7: "jangan hapus tanpa mekanisme aman")', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('koreksi mengembalikan saldo ke kondisi sebelumnya via reversal, TIDAK menghapus data lama', async () => {
    const { id } = await catatPemasukan({
      jenis: 'KAS',
      tanggal: '2026-02-01',
      nominal: 300_000,
      akunLawanId: ACC.pendapatanLain,
      createdBy: 'user-1',
    });
    expect(await getSaldoRekening('KAS')).toBe(300_000);

    await koreksiTransaksiKasBank('KAS', id, 'user-1', 'Salah input nominal');

    expect(await getSaldoRekening('KAS')).toBe(0); // saldo kembali ke 0 setelah reversal

    // Data transaksi asli TIDAK terhapus — masih ada di tabel.
    const original = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM kas_transaksi WHERE id = ?`, id);
    expect(original).not.toBeNull();

    // Ada baris KOREKSI baru sebagai jejak audit, bukan DELETE.
    const jumlahBaris = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM kas_transaksi`);
    expect(jumlahBaris?.cnt).toBe(2); // transaksi asli + baris koreksi
  });

  test('transaksi koreksi tidak bisa dikoreksi lagi (cegah reversal berantai)', async () => {
    const { id } = await catatPemasukan({
      jenis: 'KAS',
      tanggal: '2026-02-01',
      nominal: 100_000,
      akunLawanId: ACC.pendapatanLain,
      createdBy: 'user-1',
    });
    const { id: idKoreksi } = await koreksiTransaksiKasBank('KAS', id, 'user-1', 'Koreksi pertama');

    await expect(koreksiTransaksiKasBank('KAS', idKoreksi, 'user-1', 'Koreksi kedua')).rejects.toThrow(
      /tidak bisa dikoreksi lagi/
    );
  });
});

describe('KasBankService — riwayat & filter (PRD fase 7 §15-17)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('filter tanggal membatasi hasil riwayat dengan benar', async () => {
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-01-10', nominal: 100_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-03-10', nominal: 200_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });

    const hasil = await listRiwayatTransaksi({ tanggalMulai: '2026-02-01', tanggalSelesai: '2026-12-31' });
    expect(hasil.length).toBe(1);
    expect(hasil[0].nominal).toBe(200_000);
  });

  test('filter kategori hanya mengembalikan transaksi dengan kategori tsb', async () => {
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-01-10', nominal: 100_000, akunLawanId: ACC.pendapatanLain, kategori: 'Sewa', createdBy: 'user-1' });
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-01-11', nominal: 50_000, akunLawanId: ACC.pendapatanLain, kategori: 'Gaji', createdBy: 'user-1' });

    const hasil = await listRiwayatTransaksi({ kategori: 'Sewa' });
    expect(hasil.length).toBe(1);
    expect(hasil[0].kategori).toBe('Sewa');
  });

  test('filter rekening (jenis) memisahkan riwayat Kas dari Bank', async () => {
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-01-10', nominal: 100_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });
    const bank = await tambahRekeningBank({ namaBank: 'BCA', nomorRekening: '111', namaPemilik: 'X', saldoAwal: 0, createdBy: 'user-1' });
    await catatPemasukan({ jenis: 'BANK', bankAccountId: bank.id, tanggal: '2026-01-11', nominal: 200_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });

    const hasilKas = await listRiwayatTransaksi({ jenis: 'KAS' });
    const hasilBank = await listRiwayatTransaksi({ jenis: 'BANK' });
    expect(hasilKas.every((r) => r.jenis === 'KAS')).toBe(true);
    expect(hasilBank.every((r) => r.jenis === 'BANK')).toBe(true);
  });

  test('nomor transaksi unik antar baris (tidak ada tabrakan)', async () => {
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-01-10', nominal: 10_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });
    await catatPemasukan({ jenis: 'KAS', tanggal: '2026-01-11', nominal: 20_000, akunLawanId: ACC.pendapatanLain, createdBy: 'user-1' });
    const hasil = await listRiwayatTransaksi({ jenis: 'KAS' });
    const nomorSet = new Set(hasil.map((r) => r.nomorTransaksi));
    expect(nomorSet.size).toBe(hasil.length);
  });
});
