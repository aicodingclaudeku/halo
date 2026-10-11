import { createTestDb, TestDb } from './testDb';
import { runMigrations } from '@/database/db';

/**
 * MIGRASI v49 -> v50 — REQUIREMENT 1, 3 & 9 (permintaan pengguna).
 *
 * Yang dibuktikan test ini:
 *
 * REQUIREMENT 3 — rename akun 5-2100:
 *   1) `nama` berubah menjadi "Beban Penyisihan Pinjaman";
 *   2) `kode` TETAP '5-2100' dan `account.id` TIDAK BERUBAH — inilah
 *      syarat mutlak supaya seluruh jurnal historis & account_mapping
 *      tetap menunjuk akun yang sama;
 *   3) akun yang namanya SUDAH pernah diubah admin TIDAK ditimpa.
 *
 * REQUIREMENT 1 — akun 2-1210 "Simpanan Anggota (Berjangka)":
 *   4) dibuat untuk instalasi lama lewat self-heal COA, kategori
 *      LIABILITAS dengan saldo normal KREDIT;
 *   5) TIDAK duplikat walau migrasi dijalankan berkali-kali.
 *
 * REQUIREMENT 9 — kolom audit metode pelunasan:
 *   6) dua kolom baru ada, idempoten, dan baris historis mendapat
 *      NULL / 0 tanpa ada nilai lain yang berubah.
 */

let testDb: TestDb;

/** Skema minimal "instalasi v49" — angsuran_pembayaran TANPA dua kolom baru. */
const SKEMA_V49_ANGSURAN_PEMBAYARAN = `
  CREATE TABLE angsuran_pembayaran (
    id TEXT PRIMARY KEY,
    pinjaman_id TEXT NOT NULL,
    jadwal_id TEXT,
    tanggal TEXT NOT NULL,
    nominal INTEGER NOT NULL,
    porsi_pokok INTEGER NOT NULL,
    porsi_jasa INTEGER NOT NULL,
    porsi_denda INTEGER NOT NULL DEFAULT 0,
    sumber_dana TEXT NOT NULL,
    bank_account_id TEXT,
    journal_id TEXT,
    reversal_of_id TEXT,
    idempotency_key TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

async function siapkanInstalasiV49(db: TestDb) {
  const now = '2026-01-01T00:00:00.000Z';

  // `createTestDb()` hanya menjalankan CREATE_TABLES_SQL — tabel
  // `schema_meta` dibuat oleh runMigrations(), BUKAN oleh schema.ts.
  // Jadi tabel itu dibuat di sini dan diisi versi 49 supaya blok
  // migrasi v50 benar-benar dijalankan (pola sama dengan
  // MigrationV49.test.ts yang mendeklarasikan schema_meta sendiri).
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
  );
  await db.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 49)`);

  // Buang dua kolom baru dengan membuat ulang tabel versi lama.
  await db.execAsync(`DROP TABLE IF EXISTS angsuran_pembayaran;`);
  await db.execAsync(SKEMA_V49_ANGSURAN_PEMBAYARAN);

  // Hapus akun 2-1210 (skema terbaru sudah menyeed-nya) supaya kondisi
  // "instalasi lama yang belum punya akun ini" tersimulasi jujur.
  await db.runAsync(`DELETE FROM account WHERE kode = '2-1210'`);

  // Akun 5-2100 dengan NAMA LAMA + satu jurnal historis yang memakainya.
  await db.runAsync(`DELETE FROM account WHERE kode = '5-2100'`);
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES ('acc-5-2100','5-2100','Beban Penyisihan Piutang Tak Tertagih','BEBAN','DEBIT',1,1,'BEBAN_USAHA',?,?)`,
    now,
    now
  );

  await db.runAsync(
    `INSERT INTO angsuran_pembayaran
      (id, pinjaman_id, jadwal_id, tanggal, nominal, porsi_pokok, porsi_jasa, porsi_denda,
       sumber_dana, created_by, created_at)
     VALUES ('bayar-lama','pinj-lama',NULL,'2026-02-01',1500000,1000000,500000,0,'KAS','user-1',?)`,
    now
  );
}

describe('Migrasi v49 -> v50', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await siapkanInstalasiV49(testDb);
  });

  test('REQ 3 — nama akun 5-2100 berubah TAPI kode & account.id tidak berubah', async () => {
    const sebelum = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = '5-2100'`);

    await runMigrations(testDb as any);

    const sesudah = await testDb.getFirstAsync<{ id: string; kode: string; nama: string; kategori: string }>(
      `SELECT id, kode, nama, kategori FROM account WHERE kode = '5-2100'`
    );
    expect(sesudah?.nama).toBe('Beban Penyisihan Pinjaman');
    expect(sesudah?.kode).toBe('5-2100');
    expect(sesudah?.kategori).toBe('BEBAN');
    // INI assertion terpenting: id yang sama = seluruh histori aman.
    expect(sesudah?.id).toBe(sebelum?.id);
  });

  test('REQ 3 — tidak ada akun 5-2100 kedua yang dibuat (bukan INSERT, tapi UPDATE)', async () => {
    await runMigrations(testDb as any);
    const jumlah = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM account WHERE kode = '5-2100'`
    );
    expect(jumlah?.cnt).toBe(1);
  });

  test('REQ 3 — nama yang SUDAH diubah admin TIDAK ditimpa migrasi', async () => {
    await testDb.runAsync(`UPDATE account SET nama = 'Beban CKPN Koperasi' WHERE kode = '5-2100'`);

    await runMigrations(testDb as any);

    const akun = await testDb.getFirstAsync<{ nama: string }>(`SELECT nama FROM account WHERE kode = '5-2100'`);
    expect(akun?.nama).toBe('Beban CKPN Koperasi');
  });

  test('REQ 1 — akun 2-1210 dibuat sebagai LIABILITAS / saldo normal KREDIT', async () => {
    await runMigrations(testDb as any);

    const akun = await testDb.getFirstAsync<{
      kode: string;
      nama: string;
      kategori: string;
      normal_balance: string;
      is_active: number;
    }>(`SELECT kode, nama, kategori, normal_balance, is_active FROM account WHERE kode = '2-1210'`);

    expect(akun).not.toBeNull();
    expect(akun?.nama).toBe('Simpanan Anggota (Berjangka)');
    expect(akun?.kategori).toBe('LIABILITAS');
    expect(akun?.normal_balance).toBe('KREDIT');
    expect(akun?.is_active).toBe(1);
  });

  test('REQ 1 — kode 2-1210 tidak menabrak akun liabilitas lain yang sudah ada', async () => {
    await runMigrations(testDb as any);

    const liabilitas = await testDb.getAllAsync<{ kode: string }>(
      `SELECT kode FROM account WHERE kategori = 'LIABILITAS' ORDER BY kode`
    );
    const kode = liabilitas.map((a) => a.kode);
    // Semua akun liabilitas lama harus tetap ada.
    for (const wajib of ['2-1000', '2-1100', '2-1200', '2-1300', '2-1900']) {
      expect(kode).toContain(wajib);
    }
    // Dan tidak ada kode ganda sama sekali.
    expect(new Set(kode).size).toBe(kode.length);
  });

  test('REQ 9 — dua kolom audit pelunasan ditambahkan, baris historis TIDAK berubah', async () => {
    await runMigrations(testDb as any);

    const kolom = await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(angsuran_pembayaran)`);
    const namaKolom = kolom.map((k) => k.name);
    expect(namaKolom).toContain('metode_jasa_pelunasan');
    expect(namaKolom).toContain('rabat_jasa_pelunasan');

    const lama = await testDb.getFirstAsync<{
      nominal: number;
      porsi_jasa: number;
      metode_jasa_pelunasan: string | null;
      rabat_jasa_pelunasan: number;
    }>(
      `SELECT nominal, porsi_jasa, metode_jasa_pelunasan, rabat_jasa_pelunasan
       FROM angsuran_pembayaran WHERE id = 'bayar-lama'`
    );
    // Nilai historis apa adanya — tidak ada backfill/asumsi retroaktif.
    expect(lama?.nominal).toBe(1500000);
    expect(lama?.porsi_jasa).toBe(500000);
    expect(lama?.metode_jasa_pelunasan ?? null).toBeNull();
    expect(lama?.rabat_jasa_pelunasan).toBe(0);
  });

  test('IDEMPOTEN — migrasi dijalankan dua kali tidak error & tidak menggandakan apa pun', async () => {
    await runMigrations(testDb as any);
    await testDb.runAsync(`UPDATE schema_meta SET version = 49`);
    await runMigrations(testDb as any);

    const akun2120 = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM account WHERE kode = '2-1210'`
    );
    expect(akun2120?.cnt).toBe(1);

    const kolom = await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(angsuran_pembayaran)`);
    expect(kolom.filter((k) => k.name === 'metode_jasa_pelunasan').length).toBe(1);
    expect(kolom.filter((k) => k.name === 'rabat_jasa_pelunasan').length).toBe(1);

    const baris = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM angsuran_pembayaran`);
    expect(baris?.cnt).toBe(1);
  });
});
