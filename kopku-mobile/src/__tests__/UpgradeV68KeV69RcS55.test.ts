import { createTestDb, TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => {
  const asli = jest.requireActual('@/database/db');
  return {
    ...asli,
    getDb: jest.fn(async () => testDb),
    withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
      let result: unknown;
      await testDb.withTransactionAsync(async () => {
        result = await fn(testDb);
      });
      return result;
    }),
  };
});

import { SCHEMA_VERSION, CREATE_TABLES_SQL } from '@/database/schema';
import { migrasiV69 } from '@/database/db';
import { listUtang, lengkapiBasisBungaUtang } from '@/services/UtangService';
import { prosesAkrualBungaUtangOtomatis } from '@/services/UtangBungaAccrualService';

/**
 * RC-S55 — VALIDASI JALUR NAIK v68 -> v69.
 *
 * Yang diuji bukan fiturnya (punya suite sendiri), melainkan JALUR
 * NAIKNYA: instalasi berisi data v68 sungguhan harus sampai ke v69 tanpa
 * kehilangan, mengubah, atau mengarang apa pun — dan yang paling penting,
 * TANPA menetapkan basis bunga apa pun untuk data lama.
 *
 * Bentuk "sebelum" diturunkan dari CREATE_TABLES_SQL sekarang dengan
 * mencabut persis apa yang ditambahkan v69, supaya tidak basi ketika
 * skema berubah lagi.
 */

const KOLOM_V69 = ['basis_bunga', 'basis_bunga_diisi_oleh', 'basis_bunga_diisi_pada'];

function skemaV68(): string {
  let sql = CREATE_TABLES_SQL;

  const awal = sql.indexOf('CREATE TABLE IF NOT EXISTS utang_bunga_akrual');
  expect(awal).toBeGreaterThan(-1);
  const penanda = 'ON utang_bunga_akrual(utang_id, periode);';
  const akhir = sql.indexOf(penanda, awal);
  expect(akhir).toBeGreaterThan(-1);
  sql = sql.slice(0, awal) + sql.slice(akhir + penanda.length);

  sql = sql
    .split('\n')
    .filter((baris) => !KOLOM_V69.some((k) => baris.trim().startsWith(k + ' ')))
    .join('\n');

  expect(sql).not.toContain('utang_bunga_akrual');
  return sql;
}

async function buatDbV68(): Promise<TestDb> {
  const db = await createTestDb();
  // createTestDb sudah memuat skema TERBARU; bangun ulang tabel `utang`
  // dalam bentuk v68 supaya benar-benar bermula tanpa kolom v69.
  await db.execAsync(`DROP TABLE IF EXISTS utang_bunga_akrual;`);
  await db.execAsync(`DROP TABLE IF EXISTS utang_pembayaran;`);
  await db.execAsync(`DROP TABLE IF EXISTS utang;`);

  const sql = skemaV68();
  const awalUtang = sql.indexOf('CREATE TABLE IF NOT EXISTS utang (');
  const akhirUtang = sql.indexOf('CREATE INDEX IF NOT EXISTS idx_utang_bayar_idempotency');
  await db.execAsync(sql.slice(awalUtang, akhirUtang) + '\n');
  return db;
}

const now = new Date().toISOString();

async function seedDataV68(db: TestDb) {
  await db.runAsync(
    `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga,
       jenis_bunga, tanggal, sumber_dana, sumber, status, keterangan, created_by, created_at, updated_at)
     VALUES ('u1','UTG-2025-0001','Bank Lama','BANK',120000000,12,'FLAT','2026-01-01','KAS','LANGSUNG','AKTIF','warisan','user-1',?,?)`,
    now, now
  );
  await db.runAsync(
    `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga,
       jenis_bunga, tanggal, sumber, status, created_by, created_at, updated_at)
     VALUES ('u2','UTG-2025-0002','Pemasok','UTANG_USAHA',50000000,0,'LAINNYA','2026-01-05','PEMBELIAN_ASET','AKTIF','user-1',?,?)`,
    now, now
  );
  await db.runAsync(
    `INSERT INTO utang_pembayaran (id, utang_id, tanggal, pokok, bunga, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('bayar-1','u1','2026-01-15',10000000,0,'KAS','KWJ-2026-0001','user-1',?)`,
    now
  );
}

const tambahKolom = async (tabel: string, kolom: string, tipe: string) => {
  try {
    await testDb.execAsync(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${tipe};`);
  } catch {
    /* sudah ada */
  }
};

beforeEach(async () => {
  testDb = await buatDbV68();
  await seedDataV68(testDb);
});

afterEach(() => testDb.closeSync());

describe('MIGRASI v68 -> v69', () => {
  it('SCHEMA_VERSION sudah 69', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });

  it('database v68 tidak punya struktur v69 sebelum migrasi', async () => {
    const kolom = await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(utang)`);
    expect(kolom.map((k) => k.name)).not.toContain('basis_bunga');
    const tabel = await testDb.getFirstAsync(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='utang_bunga_akrual'`
    );
    expect(tabel).toBeNull();
  });

  it('migrasi menambahkan kolom & tabel tanpa menghilangkan data', async () => {
    const sebelum = await testDb.getAllAsync(`SELECT * FROM utang ORDER BY id`);
    const bayarSebelum = await testDb.getAllAsync(`SELECT * FROM utang_pembayaran`);

    await migrasiV69(testDb as any, tambahKolom);

    const kolom = await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(utang)`);
    const nama = kolom.map((k) => k.name);
    for (const k of KOLOM_V69) expect(nama).toContain(k);

    const tabel = await testDb.getFirstAsync(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='utang_bunga_akrual'`
    );
    expect(tabel).not.toBeNull();

    const sesudah = await testDb.getAllAsync(`SELECT * FROM utang ORDER BY id`);
    expect(sesudah).toHaveLength(sebelum.length);
    expect(await testDb.getAllAsync(`SELECT * FROM utang_pembayaran`)).toHaveLength(bayarSebelum.length);
  });

  it('TIDAK ADA backfill: seluruh baris warisan tetap basis_bunga NULL', async () => {
    await migrasiV69(testDb as any, tambahKolom);
    const rows = await testDb.getAllAsync<{ id: string; basis_bunga: string | null }>(
      `SELECT id, basis_bunga FROM utang`
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.basis_bunga ?? null).toBeNull();
  });

  it('migrasi tidak membuat jurnal apa pun', async () => {
    const sebelum = await testDb.getAllAsync(`SELECT id FROM journal`);
    await migrasiV69(testDb as any, tambahKolom);
    expect(await testDb.getAllAsync(`SELECT id FROM journal`)).toHaveLength(sebelum.length);
    expect(await testDb.getAllAsync(`SELECT id FROM utang_bunga_akrual`)).toHaveLength(0);
  });

  it('idempoten: dijalankan dua kali tidak error dan tidak menggandakan', async () => {
    await migrasiV69(testDb as any, tambahKolom);
    await migrasiV69(testDb as any, tambahKolom);
    const kolom = await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(utang)`);
    expect(kolom.filter((k) => k.name === 'basis_bunga')).toHaveLength(1);
    expect(await testDb.getAllAsync(`SELECT * FROM utang`)).toHaveLength(2);
  });

  it('data v68 tetap terbaca lewat listUtang() setelah migrasi', async () => {
    await migrasiV69(testDb as any, tambahKolom);
    const daftar = await listUtang();
    expect(daftar).toHaveLength(2);
    const u1 = daftar.find((u) => u.id === 'u1')!;
    expect(u1.nomorUtang).toBe('UTG-2025-0001');
    expect(u1.persenBunga).toBe(12);
    expect(u1.sisaPokok).toBe(110_000_000);
    expect(u1.basisBunga).toBeNull();
  });

  it('pasca-migrasi data warisan dilewati mesin otomatis, lalu eligible setelah dilengkapi', async () => {
    await migrasiV69(testDb as any, tambahKolom);
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
      now, now
    );

    const sebelum = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });
    expect(sebelum.jumlahJurnalBaru).toBe(0);
    expect(sebelum.exception.map((e) => e.kode)).toEqual(['BASIS_BUNGA_BELUM_DITENTUKAN']);

    await lengkapiBasisBungaUtang({ utangId: 'u1', basisBunga: 'TAHUNAN', createdBy: 'user-1' });
    const row = await testDb.getFirstAsync<{ basis_bunga: string }>(`SELECT basis_bunga FROM utang WHERE id='u1'`);
    expect(row!.basis_bunga).toBe('TAHUNAN');
  });
});
