import { createTestDb, TestDb } from './testDb';
import { readFileSync } from 'fs';
import { join } from 'path';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual<typeof import('@/database/db')>('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { catatRAK, editRAK, batalkanRAK, listRAK, getStatusModalTetapUnit } from '@/services/RAKService';
import { buatUnitUsaha, setStatusUnitUsaha } from '@/services/KoperasiMasterService';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * ============================================================
 * RC-S64 — INVARIAN MODAL TETAP SATU KALI PER UNIT USAHA
 * ============================================================
 *
 * Seluruh test memanggil SERVICE langsung, tanpa melewati layar. Itu
 * disengaja: aturan ini harus tetap berlaku ketika UI dilewati.
 */

const ACC = {
  kas: 'acc-kas',
  rak: 'acc-rak',
  modal: 'acc-modal',
};
const T0 = '2020-01-01T00:00:00.000Z';

async function seedAccount(id: string, kode: string, nama: string, kat: string, nb: string) {
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kat, nb, T0, T0
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.rak, '1-1800', 'Rekening Antar Kantor', 'ASET', 'DEBIT');
  await seedAccount(ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');
  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('RAK', 'DEBIT_ASET', ACC.rak);
  await seedMapping('RAK', 'KREDIT_ASET', ACC.rak);
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
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-modal','JRN-MODAL','2025-01-01','p2025','MODAL_AWAL','Modal awal','POSTED','user-1',?,?)`,
    T0, T0
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm1','j-modal',?,900000000,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,0,900000000)`,
    ACC.modal
  );
});
afterEach(() => testDb.closeSync());

const dasar = {
  jenisRak: 'PENYALURAN_DANA' as const,
  jumlah: 100_000_000,
  tanggal: '2026-03-10',
  sumberDana: 'KAS' as const,
  createdBy: 'user-1',
};

describe('RC-S64 — Modal Tetap satu kali per Unit Usaha', () => {
  it('Test 1. Unit A belum punya Modal Tetap -> create berhasil', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const r = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    const row = await testDb.getFirstAsync<{ jenis_alokasi: string; unit_usaha_id: string; status: string }>(
      `SELECT jenis_alokasi, unit_usaha_id, status FROM rak_transaksi WHERE id = ?`, r.id
    );
    expect(row?.jenis_alokasi).toBe('MODAL_TETAP');
    expect(row?.unit_usaha_id).toBe(unitA);
    expect(row?.status).toBe('AKTIF');
  });

  it('Test 2. Modal Tetap kedua untuk unit yang sama -> DITOLAK', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    await expect(
      catatRAK({ ...dasar, jumlah: 50_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow(/sudah pernah dialokasikan/i);

    const jml = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM rak_transaksi WHERE unit_usaha_id=? AND jenis_alokasi='MODAL_TETAP' AND status='AKTIF'`,
      unitA
    );
    expect(jml?.n).toBe(1);
  });

  it('Test 3. Modal Tetap DIBATALKAN tidak mengunci slot -> create baru boleh', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const r1 = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    await batalkanRAK(r1.id, 'user-1', 'Salah input');

    const r2 = await catatRAK({ ...dasar, jumlah: 75_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    expect(r2.id).toBeTruthy();

    // Histori TIDAK dihapus: baris lama tetap ada, berstatus DIBATALKAN.
    const semua = await testDb.getAllAsync<{ id: string; status: string }>(
      `SELECT id, status FROM rak_transaksi WHERE unit_usaha_id=? AND jenis_alokasi='MODAL_TETAP' ORDER BY created_at`,
      unitA
    );
    expect(semua).toHaveLength(2);
    expect(semua.filter((x) => x.status === 'AKTIF')).toHaveLength(1);
    expect(semua.some((x) => x.id === r1.id && x.status === 'DIBATALKAN')).toBe(true);
  });

  it('Test 4. MODAL_TAMBAHAN tidak ikut dibatasi one-time', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    await catatRAK({ ...dasar, jumlah: 10_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TAMBAHAN' });
    await catatRAK({ ...dasar, jumlah: 20_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TAMBAHAN' });
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM rak_transaksi WHERE unit_usaha_id=? AND jenis_alokasi='MODAL_TAMBAHAN' AND status='AKTIF'`,
      unitA
    );
    expect(n?.n).toBe(2);
  });

  it('Test 5. OPERASIONAL tidak ikut dibatasi one-time', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    await catatRAK({ ...dasar, jumlah: 1_000_000, unitUsahaId: unitA, jenisAlokasi: 'OPERASIONAL' });
    await catatRAK({ ...dasar, jumlah: 2_000_000, unitUsahaId: unitA, jenisAlokasi: 'OPERASIONAL' });
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM rak_transaksi WHERE unit_usaha_id=? AND jenis_alokasi='OPERASIONAL' AND status='AKTIF'`,
      unitA
    );
    expect(n?.n).toBe(2);
  });

  it('Test 6. unit_usaha_id tidak ditemukan -> ditolak', async () => {
    await expect(
      catatRAK({ ...dasar, unitUsahaId: 'unit-tidak-ada', jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow(/tidak ditemukan/i);
  });

  it('Test 7. Unit NONAKTIF -> transaksi baru ditolak', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit Tutup' });
    await setStatusUnitUsaha(unitA, 'NONAKTIF');
    await expect(
      catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow(/NONAKTIF/);
  });

  it('Test 8. edit Modal Tetap yang SAMA tidak dianggap duplikat terhadap dirinya sendiri', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const r1 = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    const r2 = await editRAK(r1.id, 'user-1', {
      ...dasar,
      jumlah: 120_000_000,
      unitUsahaId: unitA,
      jenisAlokasi: 'MODAL_TETAP',
    });
    expect(r2.id).not.toBe(r1.id);

    const aktif = await testDb.getAllAsync<{ id: string; jumlah: number }>(
      `SELECT id, jumlah FROM rak_transaksi WHERE unit_usaha_id=? AND jenis_alokasi='MODAL_TETAP' AND status='AKTIF'`,
      unitA
    );
    expect(aktif).toHaveLength(1);
    expect(aktif[0].jumlah).toBe(120_000_000);
    // Mekanisme reversal existing dipertahankan: baris lama DIBATALKAN & tertaut.
    const lama = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM rak_transaksi WHERE id=?`, r1.id);
    expect(lama?.status).toBe('DIBATALKAN');
    const baru = await testDb.getFirstAsync<{ reversal_of_id: string }>(
      `SELECT reversal_of_id FROM rak_transaksi WHERE id=?`, r2.id
    );
    expect(baru?.reversal_of_id).toBe(r1.id);
  });

  it('Test 9. edit Modal Tetap Unit A -> Unit B yang SUDAH punya Modal Tetap -> ditolak', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const unitB = await buatUnitUsaha({ namaUsaha: 'Unit B' });
    const rA = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    await catatRAK({ ...dasar, jumlah: 30_000_000, unitUsahaId: unitB, jenisAlokasi: 'MODAL_TETAP' });

    await expect(
      editRAK(rA.id, 'user-1', { ...dasar, unitUsahaId: unitB, jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow(/sudah pernah dialokasikan/i);

    // Penolakan terjadi SEBELUM penulisan apa pun: baris A tetap AKTIF.
    const a = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM rak_transaksi WHERE id=?`, rA.id);
    expect(a?.status).toBe('AKTIF');
  });

  it('Test 10. edit Modal Tetap Unit A -> Unit B yang BELUM punya Modal Tetap -> boleh', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const unitB = await buatUnitUsaha({ namaUsaha: 'Unit B' });
    const rA = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    const rB = await editRAK(rA.id, 'user-1', { ...dasar, unitUsahaId: unitB, jenisAlokasi: 'MODAL_TETAP' });

    const row = await testDb.getFirstAsync<{ unit_usaha_id: string; nama_unit: string }>(
      `SELECT unit_usaha_id, nama_unit FROM rak_transaksi WHERE id=?`, rB.id
    );
    expect(row?.unit_usaha_id).toBe(unitB);
    expect(row?.nama_unit).toBe('Unit B');
    // Slot Modal Tetap Unit A kembali kosong karena baris lamanya DIBATALKAN.
    expect((await getStatusModalTetapUnit(unitA)).sudahAda).toBe(false);
    expect((await getStatusModalTetapUnit(unitB)).sudahAda).toBe(true);
  });

  /**
   * RC-S64.1 §D — BATAS BUKTI TEST INI.
   *
   * Adapter test (`testDb`) menjalankan `withTransactionAsync` secara
   * berurutan di atas sql.js satu koneksi, jadi ketiga panggilan di bawah
   * TIDAK benar-benar berjalan bersamaan. Yang dibuktikan test ini adalah
   * bahwa invarian bertahan terhadap pengiriman berulang/retry (double
   * submit) — BUKAN bahwa ia aman terhadap race sungguhan di expo-sqlite.
   * Analisis race produksi ada di laporan RC-S64.1 §8.
   */
  it('Test 11. dua create Modal Tetap berurutan & bersamaan -> tetap satu yang aktif', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const hasil = await Promise.allSettled([
      catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' }),
      catatRAK({ ...dasar, jumlah: 40_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' }),
      catatRAK({ ...dasar, jumlah: 60_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' }),
    ]);
    expect(hasil.filter((h) => h.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM rak_transaksi WHERE unit_usaha_id=? AND jenis_alokasi='MODAL_TETAP' AND status='AKTIF'`,
      unitA
    );
    expect(n?.n).toBe(1);
  });

  it('Test 12. RAK lama dengan unit_usaha_id NULL tetap terbaca & tidak ikut invarian', async () => {
    // Baris warisan: teks bebas, tanpa referensi master, tanpa jenis alokasi.
    await testDb.runAsync(
      `INSERT INTO rak_transaksi (id, nomor_rak, jenis_rak, nama_unit, unit_usaha_id, jenis_alokasi, jumlah,
                                  tanggal, sumber_dana, status, created_by, created_at, updated_at)
       VALUES ('rak-lama','RAK-LAMA-1','PENYALURAN_DANA','Cabang Lama (teks bebas)',NULL,NULL,9000000,
               '2025-05-05','KAS','AKTIF','user-1',?,?)`,
      T0, T0
    );
    const daftar = await listRAK();
    const lama = daftar.find((x) => x.id === 'rak-lama');
    expect(lama).toBeTruthy();
    expect(lama!.namaUnit).toBe('Cabang Lama (teks bebas)');
    expect(lama!.unitUsahaId).toBeNull();
    expect(lama!.jenisAlokasi).toBeNull();

    // Baris NULL tidak mengunci slot unit mana pun.
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const r = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    expect(r.id).toBeTruthy();
  });

  it('Test 13. nama_unit TIDAK boleh mismatch dengan master — diturunkan service', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    // Pemanggil sengaja mengirim nama yang salah; service harus mengabaikannya.
    const r = await catatRAK({
      ...dasar,
      namaUnit: 'Unit B (palsu)',
      unitUsahaId: unitA,
      jenisAlokasi: 'MODAL_TAMBAHAN',
    } as any);
    const row = await testDb.getFirstAsync<{ nama_unit: string; unit_usaha_id: string }>(
      `SELECT nama_unit, unit_usaha_id FROM rak_transaksi WHERE id=?`, r.id
    );
    expect(row?.unit_usaha_id).toBe(unitA);
    expect(row?.nama_unit).toBe('Unit A');
  });

  it('Test 14. form TIDAK lagi menyediakan input teks bebas nama unit, dan memakai picker', () => {
    const mentah = readFileSync(
      join(__dirname, '..', 'screens', 'Transaksi', 'RAKFormScreen.tsx'),
      'utf8'
    );
    // Komentar dibuang lebih dulu: yang diperiksa adalah KODE, bukan
    // penjelasan di dalamnya (pola yang sama dipakai suite statis lain).
    const src = mentah
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/Nama Unit\/Kantor Tujuan/);
    expect(src).toContain('UnitUsahaPicker');
    // Tidak ada lagi state teks bebas untuk nama unit, dan payload tidak mengirimnya.
    expect(src).not.toMatch(/setNamaUnit/);
    expect(src).not.toMatch(/namaUnit:\s*namaUnit/);
  });

  it('getStatusModalTetapUnit melaporkan slot dengan benar', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    expect(await getStatusModalTetapUnit(unitA)).toMatchObject({ sudahAda: false, jumlah: null });
    await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    const st = await getStatusModalTetapUnit(unitA);
    expect(st.sudahAda).toBe(true);
    expect(st.jumlah).toBe(100_000_000);
  });

  it('jurnal RAK tidak berubah: Dr 1-1800 / Cr Kas, debit = kredit', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const r = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    const row = await testDb.getFirstAsync<{ journal_id: string }>(
      `SELECT journal_id FROM rak_transaksi WHERE id=?`, r.id
    );
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id=?`, row!.journal_id
    );
    expect(baris.reduce((t, b) => t + b.debit, 0)).toBe(baris.reduce((t, b) => t + b.kredit, 0));
    expect(baris.find((b) => b.account_id === ACC.rak)!.debit).toBe(100_000_000);
    expect(baris.find((b) => b.account_id === ACC.kas)!.kredit).toBe(100_000_000);
  });

  it('SCHEMA_VERSION tetap 69 — RC-S64 tidak menambah migrasi', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });

  // ========================================================
  // RC-S64.1 — TAMBAHAN AUDIT (§C kombinasi edit yang belum tercakup)
  // ========================================================

  it('C5. edit transaksi yang SUDAH DIBATALKAN ditolak', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const r1 = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    await batalkanRAK(r1.id, 'user-1', 'Salah input');

    await expect(
      editRAK(r1.id, 'user-1', { ...dasar, jumlah: 1_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow(/sudah dibatalkan/i);

    const aktif = await testDb.getAllAsync(
      `SELECT id FROM rak_transaksi WHERE unit_usaha_id=? AND jenis_alokasi='MODAL_TETAP' AND status='AKTIF'`,
      unitA
    );
    expect(aktif).toHaveLength(0);
  });

  it('C6. edit BERANTAI (hasil edit diedit lagi) tetap menyisakan satu yang aktif', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const r1 = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    const r2 = await editRAK(r1.id, 'user-1', { ...dasar, jumlah: 110_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    const r3 = await editRAK(r2.id, 'user-1', { ...dasar, jumlah: 130_000_000, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });

    const rows = await testDb.getAllAsync<{ id: string; status: string; jumlah: number }>(
      `SELECT id, status, jumlah FROM rak_transaksi WHERE unit_usaha_id=? AND jenis_alokasi='MODAL_TETAP' ORDER BY created_at`,
      unitA
    );
    expect(rows).toHaveLength(3);
    const aktif = rows.filter((x) => x.status === 'AKTIF');
    expect(aktif).toHaveLength(1);
    expect(aktif[0].id).toBe(r3.id);
    expect(aktif[0].jumlah).toBe(130_000_000);
  });

  it('C7/C8. edit tanpa mengubah unit, hanya nominal -> tetap satu aktif, tidak false-positive', async () => {
    const unitA = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const r1 = await catatRAK({ ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    const r2 = await editRAK(r1.id, 'user-1', { ...dasar, unitUsahaId: unitA, jenisAlokasi: 'MODAL_TETAP' });
    expect(r2.id).toBeTruthy();
    expect((await getStatusModalTetapUnit(unitA)).sudahAda).toBe(true);
  });

  it('INVARIAN MENYELURUH — tidak ada unit mana pun dengan >1 Modal Tetap AKTIF setelah rangkaian operasi', async () => {
    const a = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    const b = await buatUnitUsaha({ namaUsaha: 'Unit B' });
    const c = await buatUnitUsaha({ namaUsaha: 'Unit C' });

    const rA = await catatRAK({ ...dasar, unitUsahaId: a, jenisAlokasi: 'MODAL_TETAP' });
    await catatRAK({ ...dasar, jumlah: 5_000_000, unitUsahaId: a, jenisAlokasi: 'MODAL_TAMBAHAN' });
    const rB = await catatRAK({ ...dasar, jumlah: 20_000_000, unitUsahaId: b, jenisAlokasi: 'MODAL_TETAP' });
    await catatRAK({ ...dasar, jumlah: 1_000_000, unitUsahaId: c, jenisAlokasi: 'OPERASIONAL' });

    await editRAK(rA.id, 'user-1', { ...dasar, jumlah: 111_000_000, unitUsahaId: a, jenisAlokasi: 'MODAL_TETAP' });
    await batalkanRAK(rB.id, 'user-1', 'Tarik dana');
    await catatRAK({ ...dasar, jumlah: 22_000_000, unitUsahaId: b, jenisAlokasi: 'MODAL_TETAP' });
    await catatRAK({ ...dasar, jumlah: 33_000_000, unitUsahaId: c, jenisAlokasi: 'MODAL_TETAP' });

    // Pemeriksaan invarian atas SELURUH tabel, bukan satu unit.
    const pelanggar = await testDb.getAllAsync<{ unit_usaha_id: string; n: number }>(
      `SELECT unit_usaha_id, COUNT(*) n FROM rak_transaksi
        WHERE jenis_alokasi='MODAL_TETAP' AND status='AKTIF' AND unit_usaha_id IS NOT NULL
        GROUP BY unit_usaha_id HAVING COUNT(*) > 1`
    );
    expect(pelanggar).toEqual([]);

    // Dan tiap unit memang punya tepat satu.
    for (const u of [a, b, c]) {
      expect((await getStatusModalTetapUnit(u)).sudahAda).toBe(true);
    }
  });
});
