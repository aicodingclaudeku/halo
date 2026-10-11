import { createTestDb, TestDb } from './testDb';

/**
 * MIGRASI v48 -> v49 (audit v49, permintaan pengguna §12).
 *
 * v49 menambahkan nilai `'EIR_DERECOGNITION'` ke CHECK
 * `pinjaman_akuntansi_jasa.tipe_pengakuan`. SQLite tidak bisa meng-ALTER
 * CHECK, jadi migrasinya me-rebuild tabel (pola SAMA PERSIS dengan
 * rebuild v47). Test ini membuktikan rebuild tersebut:
 *   1) MEMPERTAHANKAN seluruh baris historis apa adanya — termasuk
 *      histori EIR_MONTHLY, yang TIDAK BOLEH dihapus/direklasifikasi;
 *   2) mempertahankan index & UNIQUE constraint;
 *   3) membuat `'EIR_DERECOGNITION'` benar-benar dapat dipakai SETELAH
 *      migrasi (sebelumnya ditolak CHECK);
 *   4) idempoten — dijalankan dua kali tidak error & tidak menggandakan
 *      data.
 */

let testDb: TestDb;

import { runMigrations } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';

/** Skema minimal instalasi "v48" — sengaja TANPA 'EIR_DERECOGNITION' di CHECK. */
const SKEMA_V48 = `
  CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
  INSERT INTO schema_meta (id, version) VALUES (1, 48);
  CREATE TABLE account (
    id TEXT PRIMARY KEY, kode TEXT NOT NULL UNIQUE, nama TEXT NOT NULL,
    kategori TEXT NOT NULL, normal_balance TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1, is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE account_mapping (
    id TEXT PRIMARY KEY, transaction_type TEXT NOT NULL, role TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id)
  );
  CREATE TABLE aset_klasifikasi (
    id TEXT PRIMARY KEY, kelompok TEXT NOT NULL, sub_kelompok TEXT NOT NULL,
    masa_manfaat_bulan_default INTEGER, aktif INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(kelompok, sub_kelompok)
  );
  CREATE TABLE pinjaman_akuntansi_jasa (
    id TEXT PRIMARY KEY,
    pinjaman_id TEXT NOT NULL,
    jadwal_id TEXT,
    periode_akuntansi TEXT NOT NULL,
    tipe_pengakuan TEXT NOT NULL CHECK (tipe_pengakuan IN (
      'JASA_AKRUAL','FEE_INTEGRAL_AMORTISASI','FEE_SEPARATE_SERVICE','EIR_MONTHLY'
    )) DEFAULT 'JASA_AKRUAL',
    saldo_awal_carrying INTEGER NOT NULL DEFAULT 0,
    pendapatan_akuntansi INTEGER NOT NULL DEFAULT 0,
    kas_diterima INTEGER NOT NULL DEFAULT 0,
    amortisasi_fee INTEGER NOT NULL DEFAULT 0,
    saldo_akhir_carrying INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('DIAKUI','DIBATALKAN')) DEFAULT 'DIAKUI',
    journal_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    fee_lifecycle_status TEXT CHECK (fee_lifecycle_status IN (
      'DEFERRED_PENDING_EIR','AMORTIZED','RECOGNIZED','PENDING_RESTRUCTURING_EIR_REVIEW','DERECOGNIZED'
    )),
    writeoff_amount INTEGER NOT NULL DEFAULT 0,
    effective_interest_rate REAL,
    remaining_term_bulan INTEGER,
    principal_component INTEGER,
    UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan)
  );
  CREATE UNIQUE INDEX idx_pinjaman_akuntansi_jasa_idempotency ON pinjaman_akuntansi_jasa(idempotency_key);
`;

async function seedBarisHistoris(db: TestDb) {
  const now = '2026-01-01T00:00:00.000Z';
  // Baris induk NYATA supaya FK pinjaman_akuntansi_jasa.pinjaman_id ->
  // pinjaman(id) tetap sah saat tabel di-rebuild (kondisi database
  // sungguhan, bukan baris yatim).
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('agt-1','A001','1234567890123456','Budi','2020-01-01','AKTIF',?,?)`,
    now, now
  );
  await db.runAsync(
    `INSERT INTO pinjaman
      (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor,
       metode_jasa, persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif,
       denda_nilai, status, created_by, created_at, updated_at)
     VALUES ('pinj-1','PJ-2026-000001','agt-1','2026-01-01',1200000,12,'BULAN','FLAT',1,'NOMINAL',12000,0,0,'AKTIF','user-1',?,?)`,
    now, now
  );
  const baris = [
    ['paj-fee', 'pinj-1', '2026-01', 'FEE_INTEGRAL_AMORTISASI', 12000, 0, 'pinj-1:2026-01:FEE'],
    ['paj-m1', 'pinj-1', '2026-02', 'EIR_MONTHLY', 0, 1000, 'pinj-1:2026-02:EIR_MONTHLY'],
    ['paj-m2', 'pinj-1', '2026-03', 'EIR_MONTHLY', 0, 1000, 'pinj-1:2026-03:EIR_MONTHLY'],
    ['paj-akrual', 'pinj-1', '2026-02', 'JASA_AKRUAL', 0, 100000, 'pinj-1:2026-02:JASA_AKRUAL'],
  ] as const;
  for (const [id, pinjamanId, periode, tipe, saldoAkhir, pendapatan, key] of baris) {
    await db.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, saldo_akhir_carrying,
         pendapatan_akuntansi, status, idempotency_key, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'DIAKUI',?,'user-1',?,?)`,
      id, pinjamanId, periode, tipe, saldoAkhir, pendapatan, key, now, now
    );
  }
}

describe('Migrasi v48 -> v49 — tipe accounting EIR_DERECOGNITION', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    // createTestDb() membuat skema TERBARU; untuk mensimulasikan instalasi
    // v48 sungguhan, tabel yang relevan dibuang lalu dibuat ulang dengan
    // definisi v48 (CHECK tanpa 'EIR_DERECOGNITION').
    await testDb.execAsync(`DROP TABLE IF EXISTS pinjaman_akuntansi_jasa;`);
    await testDb.execAsync(`DROP TABLE IF EXISTS schema_meta;`);
    await testDb.execAsync(SKEMA_V48.replace(/CREATE TABLE account[\s\S]*?\);/g, '').replace(/CREATE TABLE aset_klasifikasi[\s\S]*?\);/, ''));
    await seedBarisHistoris(testDb);
  });

  test('CHECK v48 memang MENOLAK EIR_DERECOGNITION (prasyarat: migrasi benar-benar dibutuhkan)', async () => {
    let ditolak = false;
    try {
      await testDb.runAsync(
        `INSERT INTO pinjaman_akuntansi_jasa
          (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, status, idempotency_key, created_by, created_at, updated_at)
         VALUES ('x','pinj-1','2026-04','EIR_DERECOGNITION','DIAKUI','k-x','user-1','t','t')`
      );
    } catch {
      ditolak = true;
    }
    expect(ditolak).toBe(true);
  });

  test('setelah runMigrations(): seluruh baris historis TETAP ADA & tidak berubah (EIR_MONTHLY tidak dihapus/direklasifikasi)', async () => {
    await runMigrations(testDb as any);

    const rows = await testDb.getAllAsync<{ id: string; tipe_pengakuan: string; pendapatan_akuntansi: number }>(
      `SELECT id, tipe_pengakuan, pendapatan_akuntansi FROM pinjaman_akuntansi_jasa ORDER BY id`
    );
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.id)).toEqual(['paj-akrual', 'paj-fee', 'paj-m1', 'paj-m2']);

    const monthly = rows.filter((r) => r.tipe_pengakuan === 'EIR_MONTHLY');
    expect(monthly.length).toBe(2);
    expect(monthly.reduce((s, r) => s + r.pendapatan_akuntansi, 0)).toBe(2000);

    const fee = rows.find((r) => r.id === 'paj-fee');
    expect(fee?.tipe_pengakuan).toBe('FEE_INTEGRAL_AMORTISASI');
  });

  test('setelah runMigrations(): EIR_DERECOGNITION dapat dipakai, dan TIDAK bertabrakan dengan EIR_MONTHLY periode yang sama', async () => {
    await runMigrations(testDb as any);

    // Periode 2026-02 SUDAH punya baris EIR_MONTHLY; derecognition pada
    // periode yang sama harus BISA disimpan (inilah inti fix §AB).
    await testDb.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, pendapatan_akuntansi, status, idempotency_key, created_by, created_at, updated_at)
       VALUES ('paj-der','pinj-1','2026-02','EIR_DERECOGNITION',10000,'DIAKUI','pinj-1:2026-02:EIR_DERECOGNITION:PELUNASAN_DIPERCEPAT','user-1','t','t')`
    );

    const total = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(pendapatan_akuntansi),0) as total FROM pinjaman_akuntansi_jasa
       WHERE pinjaman_id = 'pinj-1' AND tipe_pengakuan IN ('EIR_MONTHLY','EIR_DERECOGNITION') AND status = 'DIAKUI'`
    );
    // INVARIANT: initial fee 12.000 = amortisasi bulanan 2.000 + derecognition 10.000.
    expect(total!.total).toBe(12_000);
  });

  test('UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan) TETAP berlaku setelah rebuild', async () => {
    await runMigrations(testDb as any);
    let ditolak = false;
    try {
      await testDb.runAsync(
        `INSERT INTO pinjaman_akuntansi_jasa
          (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, status, idempotency_key, created_by, created_at, updated_at)
         VALUES ('paj-dup','pinj-1','2026-02','EIR_MONTHLY','DIAKUI','k-dup','user-1','t','t')`
      );
    } catch {
      ditolak = true;
    }
    expect(ditolak).toBe(true);
  });

  test('migrasi idempoten: runMigrations() dua kali tidak error & tidak menggandakan baris', async () => {
    await runMigrations(testDb as any);
    await runMigrations(testDb as any);

    const cnt = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa`);
    expect(cnt!.cnt).toBe(4);

    // Maksud assertion ini adalah "runMigrations() membawa database ke
    // versi skema TERKINI dan berhenti di situ", BUKAN "versinya harus
    // selamanya 49". Dibandingkan terhadap konstanta SCHEMA_VERSION
    // (sebelumnya di-hardcode 49) supaya tidak basi setiap kali versi
    // skema naik — di v50 assertion lama gagal dengan "expected 50 toBe 49"
    // padahal migrasinya justru berperilaku benar.
    const versi = await testDb.getFirstAsync<{ version: number }>(`SELECT version FROM schema_meta WHERE id = 1`);
    expect(versi!.version).toBe(SCHEMA_VERSION);
  });
});
