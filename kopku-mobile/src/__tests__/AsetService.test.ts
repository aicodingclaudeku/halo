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

import { beliAset, listAset, listAsetDenganNilaiBuku, getAsetById, updateAset, hapusAset } from '@/services/AsetService';
import { tambahAsetKlasifikasi } from '@/services/AsetKlasifikasiService';
import { listUtang, bayarUtang } from '@/services/UtangService';

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
  aset: 'acc-aset',
  utangUsaha: 'acc-utang-usaha',
  asetTakBerwujud: 'acc-aset-tak-berwujud',
  utangBank: 'acc-utang-bank',
  bebanBunga: 'acc-beban-bunga',
};

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.aset, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.utangUsaha, '2-1000', 'Utang Usaha', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.utangBank, '2-1400', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'ASET_TETAP', 'DEBIT_ASET', ACC.aset);
  await seedMapping(db, 'UTANG_USAHA', 'KREDIT_DEFAULT', ACC.utangUsaha);
  await seedMapping(db, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);

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

/** Isi kas lewat jurnal manual (setara modal awal) — dipakai beberapa test. */
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
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-isi-kredit', 'journal-isi-kas', ACC.utangUsaha, nominal);
}

describe('AsetService', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('beliAset TUNAI: jurnal balance, DEBIT Aset Tetap KREDIT Kas', async () => {
    await isiKas(testDb, 10_000_000);

    const { id } = await beliAset({
      namaAset: 'Laptop Kantor',
      nilaiPerolehan: 8_000_000,
      masaManfaatBulan: 24,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listAset();
    expect(daftar.find((a) => a.id === id)?.nilaiPerolehan).toBe(8_000_000);

    const asetRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.aset
    );
    expect(asetRow?.total).toBe(8_000_000);
  });

  test('Phase 4: beliAset TUNAI DITOLAK kalau saldo kas tidak cukup', async () => {
    await isiKas(testDb, 1_000_000); // kas cuma 1jt

    await expect(
      beliAset({
        namaAset: 'Kendaraan Operasional',
        nilaiPerolehan: 50_000_000,
        masaManfaatBulan: 48,
        tanggal: '2026-02-01',
        metodePembayaran: 'TUNAI',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);

    const daftar = await listAset();
    expect(daftar).toHaveLength(0); // tidak ada aset yang tercatat sama sekali
  });

  test('beliAset KREDIT: TIDAK menyentuh kas sama sekali (kredit ke Utang Usaha)', async () => {
    // Kas 0, tapi pembelian KREDIT tetap boleh karena tidak keluar kas.
    const { id } = await beliAset({
      namaAset: 'Mesin Fotokopi',
      nilaiPerolehan: 15_000_000,
      masaManfaatBulan: 60,
      tanggal: '2026-02-01',
      metodePembayaran: 'KREDIT',
      namaPemasok: 'Toko Fotokopi Jaya',
      createdBy: 'user-1',
    });

    const daftar = await listAset();
    expect(daftar.find((a) => a.id === id)?.metodePembayaran).toBe('KREDIT');

    const kasRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(kasRow?.total).toBe(0); // kas tidak bergerak sama sekali
  });

  test('beliAset KREDIT: DITOLAK kalau nama pemasok tidak diisi', async () => {
    await expect(
      beliAset({
        namaAset: 'Mesin Fotokopi',
        nilaiPerolehan: 15_000_000,
        masaManfaatBulan: 60,
        tanggal: '2026-02-01',
        metodePembayaran: 'KREDIT',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Nn]ama pemasok/);
  });

  test('beliAset KREDIT: tercatat sebagai utang usaha di UtangService & bisa dilunasi lewat Kewajiban (bug fix — sebelumnya TIDAK PERNAH muncul di listUtang)', async () => {
    const { id: asetId } = await beliAset({
      namaAset: 'Mesin Fotokopi',
      nilaiPerolehan: 15_000_000,
      masaManfaatBulan: 60,
      tanggal: '2026-02-01',
      metodePembayaran: 'KREDIT',
      namaPemasok: 'Toko Fotokopi Jaya',
      createdBy: 'user-1',
    });

    // Sebelum fix: tidak ada baris `utang` sama sekali dari jalur ini —
    // listUtang() akan selalu kosong walau jurnal "Utang Usaha" sudah
    // terbentuk, sehingga tidak pernah bisa dipilih/dilunasi lewat
    // sub-fitur "Kewajiban".
    const daftarUtang = await listUtang({ status: 'AKTIF' });
    expect(daftarUtang).toHaveLength(1);
    expect(daftarUtang[0].jenisPemberi).toBe('UTANG_USAHA');
    expect(daftarUtang[0].sumber).toBe('PEMBELIAN_ASET');
    expect(daftarUtang[0].asetTetapId).toBe(asetId);
    expect(daftarUtang[0].namaPemberi).toBe('Toko Fotokopi Jaya');
    expect(daftarUtang[0].sisaPokok).toBe(15_000_000);

    // Sekarang bisa dilunasi lewat bayarUtang() (sub-fitur Kewajiban) —
    // isi kas dulu supaya liquidity check lolos.
    await isiKas(testDb, 20_000_000);
    const hasil = await bayarUtang({
      utangId: daftarUtang[0].id,
      tanggal: '2026-03-01',
      pokok: 15_000_000,
      bunga: 0,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(hasil.sisaPokokSetelah).toBe(0);

    const setelahLunas = await listUtang();
    expect(setelahLunas.find((u) => u.id === daftarUtang[0].id)?.status).toBe('LUNAS');
  });

  test('beliAset KREDIT: utang usaha DITOLAK kalau dicoba bayar dengan komponen bunga (tidak ada bunga di utang usaha)', async () => {
    const { id: asetId } = await beliAset({
      namaAset: 'Mesin Fotokopi',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'KREDIT',
      namaPemasok: 'Toko Fotokopi Jaya',
      createdBy: 'user-1',
    });
    void asetId;
    const daftarUtang = await listUtang({ status: 'AKTIF' });
    await isiKas(testDb, 10_000_000);

    await expect(
      bayarUtang({
        utangId: daftarUtang[0].id,
        tanggal: '2026-03-01',
        pokok: 1_000_000,
        bunga: 50_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/tidak memiliki komponen bunga/);
  });

  test('Phase 9: beliAset DITOLAK kalau masaManfaatBulan 0 atau negatif', async () => {
    await isiKas(testDb, 10_000_000);
    await expect(
      beliAset({
        namaAset: 'Aset Tanpa Masa Manfaat',
        nilaiPerolehan: 1_000_000,
        masaManfaatBulan: 0,
        tanggal: '2026-02-01',
        metodePembayaran: 'TUNAI',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/masa manfaat/i);

    await expect(
      beliAset({
        namaAset: 'Aset Masa Manfaat Negatif',
        nilaiPerolehan: 1_000_000,
        masaManfaatBulan: -12,
        tanggal: '2026-02-01',
        metodePembayaran: 'KREDIT',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/masa manfaat/i);
  });

  test('Phase 9: beliAset DITOLAK kalau nilai residu >= nilai perolehan', async () => {
    await expect(
      beliAset({
        namaAset: 'Aset Residu Kebesaran',
        nilaiPerolehan: 1_000_000,
        nilaiResidu: 1_000_000, // sama dengan perolehan -> tidak akan pernah tersusutkan
        masaManfaatBulan: 12,
        tanggal: '2026-02-01',
        metodePembayaran: 'KREDIT',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/residu/i);
  });

  test('Phase 9: beliAset DITOLAK kalau nilai residu negatif', async () => {
    await expect(
      beliAset({
        namaAset: 'Aset Residu Negatif',
        nilaiPerolehan: 1_000_000,
        nilaiResidu: -100,
        masaManfaatBulan: 12,
        tanggal: '2026-02-01',
        metodePembayaran: 'KREDIT',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/residu/i);
  });

  test('Bagian G: beliAset menyimpan kelompokAset/subKelompokAset kalau diisi, tersedia lewat listAset & listAsetDenganNilaiBuku', async () => {
    await isiKas(testDb, 10_000_000);
    // FIXTURE FIX (kategori B): sejak klasifikasi aset punya FK & validasi
    // master data (Phase 5), kelompok/sub-kelompok yang dipakai test HARUS
    // terdaftar lebih dulu. Didaftarkan lewat mekanisme aplikasi yang SAMA
    // (tambahAsetKlasifikasi), BUKAN dengan mem-bypass validasi.
    await tambahAsetKlasifikasi({
      kelompok: 'Peralatan & Perlengkapan',
      subKelompok: 'Komputer & Laptop',
      masaManfaatBulanDefault: 48,
      createdBy: 'user-1',
    });
    const { id } = await beliAset({
      namaAset: 'Laptop Dell',
      kelompokAset: 'Peralatan & Perlengkapan',
      subKelompokAset: 'Komputer & Laptop',
      nilaiPerolehan: 8_000_000,
      masaManfaatBulan: 48,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listAset();
    const item = daftar.find((a) => a.id === id);
    expect(item?.kelompokAset).toBe('Peralatan & Perlengkapan');
    expect(item?.subKelompokAset).toBe('Komputer & Laptop');

    const daftarLengkap = await listAsetDenganNilaiBuku();
    const itemLengkap = daftarLengkap.find((a) => a.id === id);
    expect(itemLengkap?.kelompokAset).toBe('Peralatan & Perlengkapan');
    // Belum ada penyusutan diproses -> akumulasi 0, nilai buku = nilai perolehan penuh.
    expect(itemLengkap?.akumulasiPenyusutan).toBe(0);
    expect(itemLengkap?.nilaiBuku).toBe(8_000_000);
  });

  test('Bagian G: beliAset TANPA kelompok/sub-kelompok (opsional) tetap berhasil, tampil "belum diklasifikasikan" (null) — aset lama tetap terbaca', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Fotokopi Lama',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listAset();
    const item = daftar.find((a) => a.id === id);
    expect(item?.kelompokAset).toBeNull();
    expect(item?.subKelompokAset).toBeNull();
  });
});

describe('AsetService — updateAset & hapusAset (§9/§10, permintaan pengguna)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  async function seedPenyusutan(asetId: string, nilai: number) {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-penyusutan','JRN-PSY','2026-03-31','period-2026','PENYUSUTAN_ASET','Penyusutan','POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO aset_penyusutan (id, aset_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
       VALUES ('penyusutan-1',?,?,?,?,?,?,?)`,
      asetId,
      '2026-03',
      '2026-03-31',
      nilai,
      'journal-penyusutan',
      'user-1',
      now
    );
  }

  test('updateAset: field AMAN (nama/kelompok/keterangan) selalu bisa diubah, TANPA menyentuh jurnal, bahkan kalau sudah disusutkan', async () => {
    await isiKas(testDb, 10_000_000);
    const { id, journalId } = await beliAset({
      namaAset: 'Mesin Lama',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await seedPenyusutan(id, 100_000);

    // FIXTURE FIX (kategori B): kelompok & sub-kelompok WAJIB diisi
    // BERPASANGAN (resolveKlasifikasiAsetByNama) dan harus ada di master.
    // Sebelumnya test hanya mengirim `kelompokAset` sehingga produksi
    // menolak dengan benar. Validasinya TIDAK di-bypass — klasifikasinya
    // yang didaftarkan & pasangannya dilengkapi.
    await tambahAsetKlasifikasi({
      kelompok: 'Kelompok 1',
      subKelompok: 'Mesin kantor',
      masaManfaatBulanDefault: 48,
      createdBy: 'user-1',
    });
    await updateAset({
      id,
      namaAset: 'Mesin Fotokopi Baru',
      kelompokAset: 'Kelompok 1',
      subKelompokAset: 'Mesin kantor',
      keterangan: 'Direname',
      actingUserId: 'user-1',
    });

    const detail = await getAsetById(id);
    expect(detail?.namaAset).toBe('Mesin Fotokopi Baru');
    expect(detail?.kelompokAset).toBe('Kelompok 1');
    expect(detail?.subKelompokAset).toBe('Mesin kantor');
    expect(detail?.keterangan).toBe('Direname');
    expect(detail?.journalId).toBe(journalId); // jurnal TIDAK tersentuh untuk field aman
    expect(detail?.nilaiPerolehan).toBe(5_000_000); // nilai perolehan tidak berubah
  });

  test('updateAset: DITOLAK mengubah nilai perolehan/masa manfaat/tanggal kalau sudah pernah disusutkan', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Lama',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await seedPenyusutan(id, 100_000);

    await expect(
      updateAset({ id, namaAset: 'Mesin Lama', nilaiPerolehan: 6_000_000, actingUserId: 'user-1' })
    ).rejects.toThrow(/sudah memiliki histori penyusutan/);
    await expect(
      updateAset({ id, namaAset: 'Mesin Lama', masaManfaatBulan: 48, actingUserId: 'user-1' })
    ).rejects.toThrow(/sudah memiliki histori penyusutan/);
  });

  test('updateAset: nilai perolehan/tanggal BOLEH diubah sebelum ada penyusutan — jurnal LAMA di-reversal, jurnal BARU diposting, saldo TIDAK dobel', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Baru',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const saldoKasSebelum = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );

    await updateAset({
      id,
      namaAset: 'Mesin Baru',
      nilaiPerolehan: 6_000_000,
      sumberDana: 'KAS',
      alasanKoreksi: 'Salah input nilai perolehan',
      actingUserId: 'user-1',
    });

    const detail = await getAsetById(id);
    expect(detail?.nilaiPerolehan).toBe(6_000_000);

    const saldoAset = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.aset
    );
    expect(saldoAset?.total).toBe(6_000_000); // BUKAN 11jt (5jt lama + 6jt baru) — tidak dobel

    const saldoKasSesudah = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(saldoKasSesudah?.total).toBe((saldoKasSebelum?.total ?? 0) - 1_000_000); // selisih 1jt keluar tambahan
  });

  test('updateAset: DITOLAK kalau nilai perolehan berubah tanpa alasan koreksi', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Baru',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      updateAset({ id, namaAset: 'Mesin Baru', nilaiPerolehan: 6_000_000, sumberDana: 'KAS', actingUserId: 'user-1' })
    ).rejects.toThrow(/[Aa]lasan koreksi wajib/);
  });

  test('hapusAset: BELUM disusutkan — jurnal perolehan di-REVERSAL, saldo kas kembali seperti sebelum beli, status DIHAPUS', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Baru',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const { direversal } = await hapusAset({ id, alasan: 'Salah input, batalkan', actingUserId: 'user-1' });
    expect(direversal).toBe(true);

    const saldoAset = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.aset
    );
    expect(saldoAset?.total).toBe(0);

    const saldoKas = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(saldoKas?.total).toBe(10_000_000); // kembali seperti sebelum beli

    const daftar = await listAset();
    expect(daftar.find((a) => a.id === id)).toBeUndefined(); // default listAset() hanya AKTIF

    const semua = await listAset({ termasukDihapus: true });
    expect(semua.find((a) => a.id === id)?.status).toBe('DIHAPUS');
  });

  // DIPERBARUI RC-S54 T16 GAP 6 (kebijakan pengguna): koreksi salah input TIDAK boleh dipakai untuk aset yang sudah
  // disusutkan. Dulu: status DIHAPUS tanpa jurnal (biaya & akumulasi tertinggal di GL). Kini: DITOLAK, arahkan ke
  // Pelepasan Aset Tetap. Jurnal tetap tidak disentuh dan status tetap AKTIF.
  test('hapusAset: SUDAH disusutkan — DITOLAK (arahkan ke Pelepasan Aset Tetap); jurnal TIDAK disentuh, status tetap AKTIF', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Lama',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await seedPenyusutan(id, 100_000);

    await expect(hapusAset({ id, alasan: 'Aset rusak total', actingUserId: 'user-1' })).rejects.toThrow(/Pelepasan Aset Tetap/);

    // Saldo aset TETAP 5jt (jurnal perolehan TIDAK di-reversal).
    const saldoAset = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.aset
    );
    expect(saldoAset?.total).toBe(5_000_000);

    const semua = await listAset({ termasukDihapus: true });
    expect(semua.find((a) => a.id === id)?.status).toBe('AKTIF');
  });

  test('hapusAset: DITOLAK kalau sudah pernah dihapus sebelumnya', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Baru',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await hapusAset({ id, alasan: 'Alasan pertama', actingUserId: 'user-1' });

    await expect(hapusAset({ id, alasan: 'Coba lagi', actingUserId: 'user-1' })).rejects.toThrow(/sudah dihapus\/nonaktif sebelumnya/);
  });

  test('hapusAset: DITOLAK kalau alasan kosong', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Baru',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(hapusAset({ id, alasan: '  ', actingUserId: 'user-1' })).rejects.toThrow(/[Aa]lasan/);
  });
});

// ============================================================
// Prioritas 8 (J) — Aset Tak Berwujud & Amortisasi. Mapping
// ASET_TAK_BERWUJUD SUDAH ADA di defaultCOA.ts sebelumnya (tidak
// pernah dipakai oleh service manapun) — di sini disambungkan lewat
// parameter `jenisAset` baru pada beliAset(), REUSE tabel aset_tetap
// yang sudah ada (kolom jenis_aset, migration v25).
// ============================================================
describe('AsetService — Aset Tak Berwujud (Prioritas 8/J)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
    await seedAccount(testDb, ACC.asetTakBerwujud, '1-1700', 'Aset Tak Berwujud', 'ASET', 'DEBIT');
    await seedMapping(testDb, 'ASET_TAK_BERWUJUD', 'DEBIT_ASET', ACC.asetTakBerwujud);
  });

  test('beliAset dengan jenisAset TAK_BERWUJUD: DEBIT akun 1-1700 (bukan akun Aset Tetap biasa)', async () => {
    await isiKas(testDb, 10_000_000);

    const { id } = await beliAset({
      namaAset: 'Lisensi Software Akuntansi',
      jenisAset: 'TAK_BERWUJUD',
      nilaiPerolehan: 6_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const takBerwujudRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.asetTakBerwujud
    );
    expect(takBerwujudRow?.total).toBe(6_000_000);
    // Akun Aset Tetap biasa TIDAK tersentuh sama sekali.
    const asetTetapRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.aset
    );
    expect(asetTetapRow?.total ?? 0).toBe(0);

    const detail = await getAsetById(id);
    expect(detail?.jenisAset).toBe('TAK_BERWUJUD');
  });

  test('beliAset TANPA jenisAset (default): tetap TETAP — kompatibilitas mundur, tidak ada perubahan perilaku existing', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await beliAset({
      namaAset: 'Kursi Kantor',
      nilaiPerolehan: 1_000_000,
      masaManfaatBulan: 48,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const detail = await getAsetById(id);
    expect(detail?.jenisAset).toBe('TETAP');
  });
});

// ============================================================
// Phase 17 §1/§13 — Date-scoping historis: listAsetDenganNilaiBuku(asOfDate)
// ============================================================
describe('listAsetDenganNilaiBuku — date-scoping historis (Phase 17 §1)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('#1 aset yang dibeli SETELAH asOfDate tidak muncul', async () => {
    await isiKas(testDb, 10_000_000);
    await beliAset({
      namaAset: 'Laptop Baru',
      nilaiPerolehan: 8_000_000,
      masaManfaatBulan: 24,
      tanggal: '2026-02-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const per2025 = await listAsetDenganNilaiBuku('2025-12-31');
    expect(per2025.find((a) => a.namaAset === 'Laptop Baru')).toBeUndefined();

    const per2026 = await listAsetDenganNilaiBuku('2026-12-31');
    expect(per2026.find((a) => a.namaAset === 'Laptop Baru')).toBeDefined();
  });

  test('#2/#3 aset yang dilepas SETELAH asOfDate masih muncul; SEBELUM/PADA asOfDate tidak muncul', async () => {
    // Bug fix (test): kas sebelumnya diisi 10jt tapi aset yang dibeli
    // 12jt (tunai) — service DENGAN BENAR menolak pembelian karena
    // saldo tidak cukup (`checkSaldoAkunCukup`), jadi skenario
    // date-scoping yang dimaksud test ini tidak pernah tereksekusi
    // sama sekali. Kas dinaikkan supaya cukup untuk nilai perolehan.
    await isiKas(testDb, 12_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Lama',
      nilaiPerolehan: 12_000_000,
      masaManfaatBulan: 60,
      tanggal: '2025-01-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await hapusAset({ id, alasan: 'Rusak, tidak dipakai lagi', actingUserId: 'user-1' });
    // hapusAset() selalu mencatat updated_at = waktu sungguhan saat
    // test berjalan — backdate manual supaya skenario historis
    // deterministik (pola sama dipakai di test lain seluruh project).
    await testDb.runAsync(`UPDATE aset_tetap SET updated_at = ? WHERE id = ?`, '2026-06-15T00:00:00.000Z', id);

    // Per 2026-12-31 (SETELAH tanggal pelepasan 2026-06-15): tidak lagi muncul.
    const setelahLepas = await listAsetDenganNilaiBuku('2026-12-31');
    expect(setelahLepas.find((a) => a.id === id)).toBeUndefined();

    // Per 2026-06-15 (PADA tanggal pelepasan): sudah dianggap lepas, tidak muncul.
    const padaLepas = await listAsetDenganNilaiBuku('2026-06-15');
    expect(padaLepas.find((a) => a.id === id)).toBeUndefined();

    // Per 2026-01-01 (SEBELUM tanggal pelepasan): masih dimiliki, HARUS muncul.
    const sebelumLepas = await listAsetDenganNilaiBuku('2026-01-01');
    expect(sebelumLepas.find((a) => a.id === id)).toBeDefined();
  });

  test('#4 penyusutan SETELAH asOfDate tidak ikut masuk nilai buku historis', async () => {
    // Bug fix (test): sama seperti #2/#3 di atas — kas 10jt tidak cukup
    // untuk aset 24jt, pembelian ditolak (benar) sehingga skenario
    // penyusutan historis yang dimaksud tidak pernah tereksekusi.
    await isiKas(testDb, 24_000_000);
    const { id } = await beliAset({
      namaAset: 'Mesin Disusutkan',
      nilaiPerolehan: 24_000_000,
      masaManfaatBulan: 24,
      tanggal: '2026-01-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // Catat penyusutan langsung ke tabel (pola sama dipakai
    // PenyusutanService.test.ts) untuk 2 periode: Feb & Mar 2026.
    // Bug fix (test): komentar lama "FK tidak enforce di test db" SALAH
    // — schema.ts punya `PRAGMA foreign_keys = ON`, jadi journal_id
    // (REFERENCES journal(id)) harus menunjuk baris `journal` yang
    // benar-benar ada, bukan id fiktif. Insert dulu satu baris journal
    // dummy yang valid (referensi ke accounting_period 'period-2026'
    // yang sudah di-seed di seedFixture()).
    const journalDummy = 'journal-dummy';
    const nowIso = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      journalDummy, 'JRN-PENYUSUTAN-DUMMY', '2026-02-28', 'period-2026', 'PENYUSUTAN_ASET', 'Jurnal penyusutan dummy (test)', 'POSTED', 'user-1', nowIso, nowIso, nowIso
    );
    await testDb.runAsync(
      `INSERT INTO aset_penyusutan (id, aset_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      'pny-1', id, '2026-02', '2026-02-28', 1_000_000, journalDummy, 'user-1', new Date().toISOString()
    );
    await testDb.runAsync(
      `INSERT INTO aset_penyusutan (id, aset_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      'pny-2', id, '2026-03', '2026-03-31', 1_000_000, journalDummy, 'user-1', new Date().toISOString()
    );

    // Per 2026-02-28 (SEBELUM penyusutan Maret dijurnal): hanya 1jt.
    const perFeb = await listAsetDenganNilaiBuku('2026-02-28');
    const asetFeb = perFeb.find((a) => a.id === id)!;
    expect(asetFeb.akumulasiPenyusutan).toBe(1_000_000);
    expect(asetFeb.nilaiBuku).toBe(23_000_000);

    // Per 2026-03-31 (setelah kedua penyusutan): 2jt.
    const perMar = await listAsetDenganNilaiBuku('2026-03-31');
    const asetMar = perMar.find((a) => a.id === id)!;
    expect(asetMar.akumulasiPenyusutan).toBe(2_000_000);
    expect(asetMar.nilaiBuku).toBe(22_000_000);
  });

  test('TANPA asOfDate: perilaku current-state persis sama seperti sebelumnya (kompatibilitas mundur)', async () => {
    await isiKas(testDb, 10_000_000);
    await beliAset({
      namaAset: 'Aset Current',
      nilaiPerolehan: 5_000_000,
      masaManfaatBulan: 12,
      tanggal: '2026-01-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const daftar = await listAsetDenganNilaiBuku();
    expect(daftar.find((a) => a.namaAset === 'Aset Current')).toBeDefined();
  });
});

describe('UtangService.listUtang — date-scoping historis (Phase 17 §3)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('#8 utang yang dibuat SETELAH asOfDate tidak muncul', async () => {
    const { terimaUtang } = await import('@/services/UtangService');
    await terimaUtang({
      namaPemberi: 'Bank Baru',
      jenisPemberi: 'BANK',
      pokokPinjaman: 5_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-06-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const per2026awal = await listUtang({ asOfDate: '2026-01-01' });
    expect(per2026awal.find((u) => u.namaPemberi === 'Bank Baru')).toBeUndefined();

    const per2026akhir = await listUtang({ asOfDate: '2026-12-31' });
    expect(per2026akhir.find((u) => u.namaPemberi === 'Bank Baru')).toBeDefined();
  });

  test('#9/#10 sisaPokok & status historis dihitung dari pembayaran s.d. asOfDate, bukan cumulative all-time', async () => {
    const { terimaUtang } = await import('@/services/UtangService');
    const { id: utangId } = await terimaUtang({
      namaPemberi: 'Bank Cicilan',
      jenisPemberi: 'BANK',
      pokokPinjaman: 10_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await bayarUtang({ utangId, tanggal: '2026-06-01', pokok: 4_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });
    await bayarUtang({ utangId, tanggal: '2027-01-01', pokok: 6_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });

    // Per 2026-12-31: baru bayar 4jt (yang 2027-01-01 belum terjadi) -> sisa 6jt, masih AKTIF.
    const per2026 = await listUtang({ asOfDate: '2026-12-31' });
    const utang2026 = per2026.find((u) => u.id === utangId)!;
    expect(utang2026.sisaPokok).toBe(6_000_000);
    expect(utang2026.status).toBe('AKTIF');

    // Per 2027-01-01: kedua pembayaran sudah terjadi -> LUNAS (sisa 0), TIDAK muncul di filter status:'AKTIF'.
    const per2027Aktif = await listUtang({ asOfDate: '2027-01-01', status: 'AKTIF' });
    expect(per2027Aktif.find((u) => u.id === utangId)).toBeUndefined();

    const per2027Semua = await listUtang({ asOfDate: '2027-01-01' });
    const utang2027 = per2027Semua.find((u) => u.id === utangId)!;
    expect(utang2027.sisaPokok).toBe(0);
    expect(utang2027.status).toBe('LUNAS');
  });

  test('TANPA asOfDate: status & sisaPokok tetap current (kompatibilitas mundur — dipakai UtangPicker/DaftarUtangScreen)', async () => {
    const { terimaUtang } = await import('@/services/UtangService');
    const { id: utangId } = await terimaUtang({
      namaPemberi: 'Bank Current',
      jenisPemberi: 'BANK',
      pokokPinjaman: 5_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await bayarUtang({ utangId, tanggal: '2026-06-01', pokok: 5_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });

    const daftar = await listUtang();
    const utang = daftar.find((u) => u.id === utangId)!;
    expect(utang.sisaPokok).toBe(0);
    expect(utang.status).toBe('LUNAS');
  });
});
