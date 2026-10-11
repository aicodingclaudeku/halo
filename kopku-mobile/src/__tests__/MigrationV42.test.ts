import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL } from '@/database/schema';

/**
 * Migrasi v42 — PHASE 1: fondasi model akuntansi akrual jasa/bunga
 * pinjaman (permintaan pengguna bagian A-AI, "PHASE 1 — FOUNDATION"):
 *  - COA baru: "Piutang Jasa Pinjaman" (1-1205, ASET), "Pendapatan
 *    Penalti Pelunasan" (4-1150) & "Pendapatan Administrasi
 *    Pelunasan" (4-1160), keduanya PENDAPATAN — self-heal, pola SAMA
 *    PERSIS dengan v27/v28/v30/v31/v34/v36/v37 (lihat
 *    MigrationV37.test.ts).
 *  - AccountMapping baru: PIUTANG_JASA_PINJAMAN/DEBIT_PIUTANG_JASA,
 *    PELUNASAN_PENALTI/KREDIT_PENDAPATAN,
 *    PELUNASAN_ADMINISTRASI/KREDIT_PENDAPATAN.
 *  - Tabel baru `pinjaman_akuntansi_jasa` (fondasi accounting
 *    schedule/EIR untuk PHASE 2) dengan UNIQUE(pinjaman_id,
 *    periode_akuntansi, tipe_pengakuan) & idempotency_key UNIQUE.
 *
 * Pola test SAMA PERSIS dengan MigrationV37.test.ts: simulasikan
 * instalasi lama (v41, sebelum Phase 1) lewat sql.js in-memory,
 * jalankan runMigrations, lalu verifikasi hasil & idempotensi. Akun/
 * mapping ini SENGAJA belum dipakai jurnal apa pun (Phase 1 murni
 * fondasi) — tidak ada perubahan pada bayarAngsuran/cairkanPinjaman/
 * hapusPiutangPinjaman yang diuji di sini.
 */
async function createV41Db() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run(CREATE_TABLES_SQL);
  raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, 41)`);

  return {
    async execAsync(sql: string) {
      raw.run(sql);
    },
    async runAsync(sql: string, ...params: any[]) {
      const stmt = raw.prepare(sql);
      stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
      stmt.step();
      stmt.free();
    },
    async getFirstAsync(sql: string, ...params: any[]) {
      const stmt = raw.prepare(sql);
      stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
      const has = stmt.step();
      const result = has ? stmt.getAsObject() : null;
      stmt.free();
      return result;
    },
    async getAllAsync(sql: string, ...params: any[]) {
      const stmt = raw.prepare(sql);
      stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    async withTransactionAsync(fn: () => Promise<void>) {
      raw.run('BEGIN');
      try {
        await fn();
        raw.run('COMMIT');
      } catch (e) {
        raw.run('ROLLBACK');
        throw e;
      }
    },
  };
}

describe('Migrasi v42 — PHASE 1: COA Piutang Jasa Pinjaman, Penalti/Administrasi Pelunasan, tabel pinjaman_akuntansi_jasa', () => {
  test('COA 1-1205 "Piutang Jasa Pinjaman" otomatis tersedia (self-heal), bertipe ASET/DEBIT, akun lama tidak disentuh', async () => {
    const db = await createV41Db();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-1-1200','1-1200','Piutang Pinjaman Anggota','ASET','DEBIT',1,1,?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const piutangJasa = (await db.getFirstAsync(
      `SELECT nama, kategori, normal_balance, is_system FROM account WHERE kode = '1-1205'`
    )) as any;
    expect(piutangJasa?.nama).toBe('Piutang Jasa Pinjaman');
    expect(piutangJasa?.kategori).toBe('ASET');
    expect(piutangJasa?.normal_balance).toBe('DEBIT');

    const piutangPokok = (await db.getFirstAsync(`SELECT nama, kode FROM account WHERE id = 'acc-1-1200'`)) as any;
    expect(piutangPokok?.nama).toBe('Piutang Pinjaman Anggota');
    expect(piutangPokok?.kode).toBe('1-1200');
  });

  test('COA 4-1150 "Pendapatan Penalti Pelunasan" & 4-1160 "Pendapatan Administrasi Pelunasan" tersedia, bertipe PENDAPATAN, terpisah dari 4-1000/4-1100', async () => {
    const db = await createV41Db();
    await runMigrations(db as any);

    const penalti = (await db.getFirstAsync(`SELECT nama, kategori, normal_balance FROM account WHERE kode = '4-1150'`)) as any;
    expect(penalti?.nama).toBe('Pendapatan Penalti Pelunasan');
    expect(penalti?.kategori).toBe('PENDAPATAN');
    expect(penalti?.normal_balance).toBe('KREDIT');

    const admin = (await db.getFirstAsync(`SELECT nama, kategori FROM account WHERE kode = '4-1160'`)) as any;
    expect(admin?.nama).toBe('Pendapatan Administrasi Pelunasan');
    expect(admin?.kategori).toBe('PENDAPATAN');

    const jasaAngsuran = (await db.getFirstAsync(`SELECT id FROM account WHERE kode = '4-1000'`)) as any;
    const adminPencairan = (await db.getFirstAsync(`SELECT id FROM account WHERE kode = '4-1100'`)) as any;
    expect(penalti?.id).not.toBe(jasaAngsuran?.id);
    expect(admin?.id).not.toBe(adminPencairan?.id);
  });

  test('Simpanan Sukarela Anggota (2-1200) tetap LIABILITAS setelah migrasi — klasifikasi existing TIDAK diubah', async () => {
    const db = await createV41Db();
    await runMigrations(db as any);

    const simpananSukarela = (await db.getFirstAsync(`SELECT kategori, normal_balance FROM account WHERE kode = '2-1200'`)) as any;
    expect(simpananSukarela?.kategori).toBe('LIABILITAS');
    expect(simpananSukarela?.normal_balance).toBe('KREDIT');
  });

  test('migrasi idempoten — dijalankan dua kali tidak menduplikasi 1-1205/4-1150/4-1160', async () => {
    const db = await createV41Db();
    await runMigrations(db as any);
    await runMigrations(db as any);

    for (const kode of ['1-1205', '4-1150', '4-1160']) {
      const rows = await db.getAllAsync(`SELECT id FROM account WHERE kode = ?`, kode);
      expect(rows.length).toBe(1);
    }
  });

  test('AccountMapping baru (PIUTANG_JASA_PINJAMAN, PELUNASAN_PENALTI, PELUNASAN_ADMINISTRASI) mengarah ke akun yang benar', async () => {
    const db = await createV41Db();
    await runMigrations(db as any);

    const piutangJasaMap = (await db.getFirstAsync(
      `SELECT a.kode FROM account_mapping am JOIN account a ON a.id = am.account_id
       WHERE am.transaction_type = 'PIUTANG_JASA_PINJAMAN' AND am.role = 'DEBIT_PIUTANG_JASA'`
    )) as any;
    expect(piutangJasaMap?.kode).toBe('1-1205');

    const penaltiMap = (await db.getFirstAsync(
      `SELECT a.kode FROM account_mapping am JOIN account a ON a.id = am.account_id
       WHERE am.transaction_type = 'PELUNASAN_PENALTI' AND am.role = 'KREDIT_PENDAPATAN'`
    )) as any;
    expect(penaltiMap?.kode).toBe('4-1150');

    const adminMap = (await db.getFirstAsync(
      `SELECT a.kode FROM account_mapping am JOIN account a ON a.id = am.account_id
       WHERE am.transaction_type = 'PELUNASAN_ADMINISTRASI' AND am.role = 'KREDIT_PENDAPATAN'`
    )) as any;
    expect(adminMap?.kode).toBe('4-1160');
  });

  test('mapping idempoten — dijalankan dua kali tidak menduplikasi baris account_mapping baru', async () => {
    const db = await createV41Db();
    await runMigrations(db as any);
    await runMigrations(db as any);

    for (const tt of ['PIUTANG_JASA_PINJAMAN', 'PELUNASAN_PENALTI', 'PELUNASAN_ADMINISTRASI']) {
      const rows = await db.getAllAsync(`SELECT id FROM account_mapping WHERE transaction_type = ?`, tt);
      expect(rows.length).toBe(1);
    }
  });

  test('tabel pinjaman_akuntansi_jasa dibuat & bisa diisi (fondasi PHASE 2)', async () => {
    const db = await createV41Db();
    await runMigrations(db as any);

    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a1','A-001','Budi','2024-01-01','AKTIF',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, status, created_by, created_at, updated_at)
       VALUES ('p1','PJ-001','a1','2024-01-01',1000000,12,'BULAN','FLAT','AKTIF','u1',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying, pendapatan_akuntansi,
         kas_diterima, amortisasi_fee, saldo_akhir_carrying, status, idempotency_key, created_by, created_at, updated_at)
       VALUES ('paj1','p1','2024-01','JASA_AKRUAL',1000000,100000,0,0,1100000,'DIAKUI','p1:2024-01:JASA_AKRUAL','u1',?,?)`,
      now,
      now
    );

    const row = (await db.getFirstAsync(`SELECT * FROM pinjaman_akuntansi_jasa WHERE id = 'paj1'`)) as any;
    expect(row?.pinjaman_id).toBe('p1');
    expect(row?.periode_akuntansi).toBe('2024-01');
    expect(row?.pendapatan_akuntansi).toBe(100000);
  });

  test('tabel pinjaman_akuntansi_jasa menolak duplicate recognition (UNIQUE pinjaman_id+periode_akuntansi+tipe_pengakuan)', async () => {
    const db = await createV41Db();
    await runMigrations(db as any);

    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a1','A-001','Budi','2024-01-01','AKTIF',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, status, created_by, created_at, updated_at)
       VALUES ('p1','PJ-001','a1','2024-01-01',1000000,12,'BULAN','FLAT','AKTIF','u1',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, idempotency_key, created_by, created_at, updated_at)
       VALUES ('paj1','p1','2024-01','JASA_AKRUAL','p1:2024-01:JASA_AKRUAL','u1',?,?)`,
      now,
      now
    );

    await expect(
      db.runAsync(
        `INSERT INTO pinjaman_akuntansi_jasa
          (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, idempotency_key, created_by, created_at, updated_at)
         VALUES ('paj2','p1','2024-01','JASA_AKRUAL','p1:2024-01:JASA_AKRUAL-lain','u1',?,?)`,
        now,
        now
      )
    ).rejects.toThrow();
  });

  test('tabel pinjaman_akuntansi_jasa menolak idempotency_key duplikat', async () => {
    const db = await createV41Db();
    await runMigrations(db as any);

    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a1','A-001','Budi','2024-01-01','AKTIF',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, status, created_by, created_at, updated_at)
       VALUES ('p1','PJ-001','a1','2024-01-01',1000000,12,'BULAN','FLAT','AKTIF','u1',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, idempotency_key, created_by, created_at, updated_at)
       VALUES ('paj1','p1','2024-01','JASA_AKRUAL','dup-key','u1',?,?)`,
      now,
      now
    );

    await expect(
      db.runAsync(
        `INSERT INTO pinjaman_akuntansi_jasa
          (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, idempotency_key, created_by, created_at, updated_at)
         VALUES ('paj2','p1','2024-02','JASA_AKRUAL','dup-key','u1',?,?)`,
        now,
        now
      )
    ).rejects.toThrow();
  });
});
