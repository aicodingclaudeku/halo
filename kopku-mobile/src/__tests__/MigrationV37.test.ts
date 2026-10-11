import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL } from '@/database/schema';

/**
 * Migrasi v37 (permintaan pengguna, request PERBAIKAN §8/§9/§10):
 *  - §8: 2 akun EKUITAS baru "Modal Tetap" (3-1200) & "Modal Tambahan"
 *    (3-1300) — self-heal COA, pola sama persis dengan v27/v28/v30/
 *    v31/v34/v36 (lihat MigrationV36.test.ts).
 *  - §10: kolom `bank_account.jenis_simpanan` (ADD COLUMN, nullable)
 *    + tabel referensi baru `bank_jenis_simpanan` (Tabungan/Giro/
 *    Deposito, seed 3 baris aktif=1).
 *  - §9: tabel riwayat baru `pinjaman_akad_ulang` (kosong di migrasi,
 *    diisi lewat PinjamanService.akadUlangPinjaman()).
 *
 * Pola test SAMA PERSIS dengan MigrationV36.test.ts: simulasikan
 * instalasi lama (di sini v35, sebelum kolom bank_tujuan_id v35 —
 * dipilih v35 supaya turut membuktikan migrasi v36 & v37 berjalan
 * berurutan dari titik lama) lewat sql.js in-memory, jalankan
 * `runMigrations`, lalu verifikasi hasil & idempotensi.
 */
async function createV35Db() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run(CREATE_TABLES_SQL);
  raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, 35)`);

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

describe('Migrasi v37 — COA Modal Tetap/Modal Tambahan, Jenis Simpanan Bank, riwayat Akad Ulang', () => {
  test('§8: akun 3-1200 "Modal Tetap" & 3-1300 "Modal Tambahan" otomatis tersedia (self-heal), akun lama tidak disentuh', async () => {
    const db = await createV35Db();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-3-1000','3-1000','Simpanan Pokok','EKUITAS','KREDIT',1,1,?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const modalTetap = (await db.getFirstAsync(`SELECT nama, kategori, normal_balance, is_system FROM account WHERE kode = '3-1200'`)) as any;
    expect(modalTetap?.nama).toBe('Modal Tetap');
    expect(modalTetap?.kategori).toBe('EKUITAS');
    expect(modalTetap?.normal_balance).toBe('KREDIT');

    const modalTambahan = (await db.getFirstAsync(`SELECT nama, kategori FROM account WHERE kode = '3-1300'`)) as any;
    expect(modalTambahan?.nama).toBe('Modal Tambahan');
    expect(modalTambahan?.kategori).toBe('EKUITAS');

    const simpananPokok = (await db.getFirstAsync(`SELECT nama, kode FROM account WHERE id = 'acc-3-1000'`)) as any;
    expect(simpananPokok?.nama).toBe('Simpanan Pokok');
    expect(simpananPokok?.kode).toBe('3-1000');
  });

  test('§8: migrasi idempoten — dijalankan dua kali tidak menduplikasi 3-1200/3-1300', async () => {
    const db = await createV35Db();
    await runMigrations(db as any);
    await runMigrations(db as any);

    for (const kode of ['3-1200', '3-1300']) {
      const rows = await db.getAllAsync(`SELECT id FROM account WHERE kode = ?`, kode);
      expect(rows.length).toBe(1);
    }
  });

  test('§10: bank_jenis_simpanan seed 3 baris (Tabungan/Giro/Deposito) semua aktif, kolom bank_account.jenis_simpanan tersedia & nullable', async () => {
    const db = await createV35Db();
    const now = new Date().toISOString();

    // Rekening bank lama (sebelum kolom jenis_simpanan ada) harus tetap terbaca apa adanya setelah migrasi.
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-bank-1','1-1900','Bank BCA','ASET','DEBIT',1,0,?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
       VALUES ('bank-1','BCA','1234567890','Koperasi Maju',0,'acc-bank-1',1,?)`,
      now
    );

    await runMigrations(db as any);

    const jenisRows = (await db.getAllAsync(`SELECT kode, nama, aktif FROM bank_jenis_simpanan ORDER BY kode ASC`)) as any[];
    expect(jenisRows.map((r) => r.kode)).toEqual(['DEPOSITO', 'GIRO', 'TABUNGAN']);
    for (const r of jenisRows) expect(r.aktif).toBe(1);

    const rekeningLama = (await db.getFirstAsync(`SELECT nama_bank, jenis_simpanan FROM bank_account WHERE id = 'bank-1'`)) as any;
    expect(rekeningLama?.nama_bank).toBe('BCA');
    expect(rekeningLama?.jenis_simpanan).toBeNull();
  });

  test('§10: migrasi idempoten — dijalankan dua kali tidak menduplikasi baris bank_jenis_simpanan', async () => {
    const db = await createV35Db();
    await runMigrations(db as any);
    await runMigrations(db as any);

    const rows = await db.getAllAsync(`SELECT id FROM bank_jenis_simpanan`);
    expect(rows.length).toBe(3);
  });

  test('§9: tabel pinjaman_akad_ulang dibuat & bisa diisi (dipakai PinjamanService.akadUlangPinjaman)', async () => {
    const db = await createV35Db();
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
      `INSERT INTO pinjaman_akad_ulang
        (id, pinjaman_id, tanggal, tenor_lama, satuan_tenor_lama, metode_jasa_lama, persentase_jasa_lama,
         tenor_baru, satuan_tenor_baru, metode_jasa_baru, persentase_jasa_baru, sisa_pokok, keterangan, created_by, created_at)
       VALUES ('ak1','p1','2024-06-01',12,'BULAN','FLAT',1.5,18,'BULAN','MENURUN',1.0,500000,'restrukturisasi','u1',?)`,
      now
    );

    const row = (await db.getFirstAsync(`SELECT * FROM pinjaman_akad_ulang WHERE id = 'ak1'`)) as any;
    expect(row?.pinjaman_id).toBe('p1');
    expect(row?.sisa_pokok).toBe(500000);
    expect(row?.metode_jasa_baru).toBe('MENURUN');
  });
});
