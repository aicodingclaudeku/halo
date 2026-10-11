import { createTestDb, TestDb, sebagaiSQLiteDatabase } from './testDb';

let testDb: TestDb;

// DIPERBARUI RC-S72 (FIXTURE BUG): mock lama hanya mengembalikan getDb/
// withTransaction, sehingga `runMigrations` — fungsi yang justru diuji suite ini —
// tidak ada di Jest (hanya jalan di harness `.harness/dbShim.js`). Pola resmi
// disamakan dengan UpgradeV68KeV69RcS55: modul asli + koneksi uji.
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
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { runMigrations } from '@/database/db';
import { catatBagianShuInvestasi, catatPenerimaanBagianShu, listBagianShuInvestasiDenganDb } from '@/services/BagianShuService';

/**
 * RC-S53 — VALIDASI RILIS v63 -> v64.
 *
 * Yang diuji di sini bukan fitur barunya (itu sudah punya suite
 * sendiri), melainkan JALUR NAIKNYA: instalasi yang sudah berisi data
 * v63 sungguhan harus sampai ke v64 tanpa kehilangan, mengubah, atau
 * menduplikasi apa pun.
 *
 * Skema v63 dibentuk dari `CREATE_TABLES_SQL` saat ini dengan MENCABUT
 * persis apa yang ditambahkan v64 — lima kolom pada `investasi` dan
 * tabel `investasi_penyusutan`. Dengan begitu bentuk "sebelum" tidak
 * ditulis ulang tangan (yang akan basi begitu skema berubah), melainkan
 * diturunkan dari sumber yang sama.
 */

/** Kolom yang ditambahkan v64 ke tabel `investasi`. */
const KOLOM_V64 = [
  'jenis_objek_properti',
  'nilai_dapat_disusutkan',
  'nilai_residu_properti',
  'masa_manfaat_bulan_properti',
  'tanggal_mulai_penyusutan',
];

/** Turunkan SQL skema v63 dari skema sekarang dengan mencabut tambahan v64. */
function skemaV63(): string {
  let sql = CREATE_TABLES_SQL;

  // 1. cabut tabel & indeks investasi_penyusutan
  const awal = sql.indexOf('CREATE TABLE IF NOT EXISTS investasi_penyusutan');
  expect(awal).toBeGreaterThan(-1);
  const akhirIndeks = sql.indexOf('ON investasi_penyusutan(periode);', awal);
  expect(akhirIndeks).toBeGreaterThan(-1);
  sql = sql.slice(0, awal) + sql.slice(akhirIndeks + 'ON investasi_penyusutan(periode);'.length);

  // 2. cabut lima kolom v64 dari definisi tabel investasi
  sql = sql
    .split('\n')
    .filter((baris) => !KOLOM_V64.some((k) => baris.trim().startsWith(k + ' ')))
    .join('\n');

  for (const k of KOLOM_V64) {
    expect(sql).not.toContain(`  ${k} `);
  }
  expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS investasi_penyusutan');
  return sql;
}

const AKUN = {
  kas: 'acc-kas',
  piutang: 'acc-piutang',
  pendapatan: 'acc-pendapatan',
  properti: 'acc-properti',
  modal: 'acc-modal',
};

const INV_KOPERASI = 'inv-koperasi-mitra';
const INV_PROPERTI = 'inv-ruko';

async function seedAkun(id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kat, nb, now, now
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

/**
 * Bangun instalasi v63 yang sudah dipakai: COA, mapping, periode, user,
 * dua investasi, satu bagian SHU yang sudah diakui beserta penerimaan
 * sebagiannya, dan jurnal-jurnalnya.
 */
async function seedInstalasiV63(): Promise<void> {
  testDb = await createTestDb({ applySchema: false });
  await testDb.execAsync(skemaV63());

  const now = new Date().toISOString();
  await seedAkun(AKUN.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAkun(AKUN.piutang, '1-1220', 'Piutang Pendapatan Investasi', 'ASET', 'DEBIT');
  await seedAkun(AKUN.pendapatan, '4-1300', 'Pendapatan Hasil Investasi', 'PENDAPATAN', 'KREDIT');
  await seedAkun(AKUN.properti, '1-1660', 'Properti Investasi', 'ASET', 'DEBIT');
  await seedAkun(AKUN.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');

  await seedMapping('KAS_UMUM', 'DEFAULT', AKUN.kas);
  await seedMapping('BAGIAN_SHU_INVESTASI', 'DEBIT_PIUTANG', AKUN.piutang);
  await seedMapping('BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN', AKUN.pendapatan);
  await seedMapping('BAGIAN_SHU_PENERIMAAN', 'KREDIT_PIUTANG', AKUN.piutang);
  await seedMapping('INVESTASI_PROPERTI_INVESTASI', 'DEBIT_ASET', AKUN.properti);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026', 2026, '2026-01-01', '2026-12-31', 'OPEN')`
  );
  await testDb.runAsync(
    `INSERT INTO koperasi (id, nama, nomor_ahu, nomor_induk_koperasi, tahun_buku_aktif,
                           standar_akuntansi, setup_selesai, created_at, updated_at)
     VALUES ('kop-1','Koperasi Uji','AHU-1','NIK-1',2026,'SAK_EP',1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                            sumber_dana, status, created_by, created_at, updated_at)
     VALUES (?, 'INV-2026-001', 'KOPERASI_LAIN', 'Koperasi Mitra Sejahtera', 50000000, '2026-01-10',
             'KAS', 'AKTIF', 'user-1', ?, ?)`,
    INV_KOPERASI, now, now
  );
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                            sumber_dana, status, created_by, created_at, updated_at)
     VALUES (?, 'INV-2026-009', 'PROPERTI_INVESTASI', 'Ruko Jl. Mawar', 500000000, '2026-01-05',
             'KAS', 'AKTIF', 'user-1', ?, ?)`,
    INV_PROPERTI, now, now
  );

  // Data v63 yang benar-benar dibuat lewat service, bukan INSERT mentah.
  const akrual = await catatBagianShuInvestasi({
    investasiId: INV_KOPERASI,
    tanggalHak: '2026-03-20',
    jumlah: 5_000_000,
    jenisDokumen: 'Berita Acara RAT',
    nomorDokumen: 'BA-RAT-2026-014',
    tanggalDokumen: '2026-03-20',
    createdBy: 'user-1',
  });
  await catatPenerimaanBagianShu({
    bagianShuId: akrual.id,
    tanggal: '2026-04-05',
    jumlah: 2_000_000,
    sumberDana: 'KAS',
    nomorReferensi: 'TRM-001',
    createdBy: 'user-1',
  });

  await testDb.execAsync(
    `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
  );
  await testDb.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 63)`);
}

async function potret() {
  return {
    tabel: (
      await testDb.getAllAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      )
    ).map((r) => r.name),
    journal: await testDb.getAllAsync<Record<string, unknown>>(`SELECT * FROM journal ORDER BY id`),
    entry: await testDb.getAllAsync<Record<string, unknown>>(`SELECT * FROM journal_entry ORDER BY id`),
    investasi: await testDb.getAllAsync<Record<string, unknown>>(
      `SELECT id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, status FROM investasi ORDER BY id`
    ),
    bagianShu: await testDb.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM investasi_bagian_shu ORDER BY id`
    ),
    penerimaan: await testDb.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM investasi_bagian_shu_penerimaan ORDER BY id`
    ),
    account: await testDb.getAllAsync<Record<string, unknown>>(`SELECT * FROM account ORDER BY kode`),
    mapping: await testDb.getAllAsync<Record<string, unknown>>(
      `SELECT transaction_type, role, account_id FROM account_mapping ORDER BY transaction_type, role`
    ),
  };
}

// ===========================================================================
// UPGRADE v63 -> v64
// ===========================================================================

describe('Upgrade v63 -> v64', () => {
  it('SEBELUM: instalasi benar-benar berbentuk v63', async () => {
    await seedInstalasiV63();
    const kolom = await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(investasi)`);
    const nama = kolom.map((k) => k.name);
    for (const k of KOLOM_V64) expect(nama).not.toContain(k);
    const tabel = (
      await testDb.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`)
    ).map((r) => r.name);
    expect(tabel).not.toContain('investasi_penyusutan');
    expect(tabel).toContain('investasi_bagian_shu');
    const v = await testDb.getFirstAsync<{ version: number }>(`SELECT version FROM schema_meta`);
    expect(v!.version).toBe(63);
  });

  it('SESUDAH: histori IDENTIK; hanya skema baru yang bertambah', async () => {
    await seedInstalasiV63();
    const sebelum = await potret();

    await runMigrations(sebagaiSQLiteDatabase(testDb));

    const sesudah = await potret();

    // 1-2. seluruh tabel v63 tetap ada.
    for (const t of sebelum.tabel) expect(sesudah.tabel).toContain(t);
    // 3-4. jurnal & entri jurnal lama tidak berubah satu byte pun.
    expect(sesudah.journal).toEqual(sebelum.journal);
    expect(sesudah.entry).toEqual(sebelum.entry);
    // 5-6. bagian SHU & investasi tetap terbaca apa adanya.
    expect(sesudah.bagianShu).toEqual(sebelum.bagianShu);
    expect(sesudah.penerimaan).toEqual(sebelum.penerimaan);
    expect(sesudah.investasi).toEqual(sebelum.investasi);
    // 11. tidak ada data yang berlipat.
    expect(sesudah.journal.length).toBe(sebelum.journal.length);
    expect(sesudah.bagianShu.length).toBe(sebelum.bagianShu.length);
  });

  it('SESUDAH: kolom penyusutan properti tersedia dan seluruhnya NULL', async () => {
    await seedInstalasiV63();
    await runMigrations(sebagaiSQLiteDatabase(testDb));

    const nama = (await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(investasi)`)).map(
      (k) => k.name
    );
    for (const k of KOLOM_V64) expect(nama).toContain(k);

    // Baris lama TIDAK tiba-tiba punya parameter penyusutan — kalau
    // sampai terisi, properti lama akan ikut disusutkan tanpa keputusan.
    const baris = await testDb.getAllAsync<Record<string, unknown>>(
      `SELECT jenis_objek_properti, nilai_dapat_disusutkan, nilai_residu_properti,
              masa_manfaat_bulan_properti, tanggal_mulai_penyusutan FROM investasi`
    );
    expect(baris).toHaveLength(2);
    for (const b of baris) {
      for (const k of Object.keys(b)) expect(b[k]).toBeNull();
    }
  });

  it('SESUDAH: investasi_penyusutan tersedia dan kosong', async () => {
    await seedInstalasiV63();
    await runMigrations(sebagaiSQLiteDatabase(testDb));
    const tabel = (
      await testDb.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`)
    ).map((r) => r.name);
    expect(tabel).toContain('investasi_penyusutan');
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM investasi_penyusutan`);
    expect(n!.n).toBe(0);
  });

  it('SESUDAH: mapping tetap valid & COA baru ikut tersisip lewat self-heal', async () => {
    await seedInstalasiV63();
    const sebelum = await potret();
    await runMigrations(sebagaiSQLiteDatabase(testDb));
    const sesudah = await potret();

    // Mapping lama tidak ada yang hilang atau berpindah akun.
    for (const m of sebelum.mapping) {
      const tetap = sesudah.mapping.find(
        (x) => x.transaction_type === m.transaction_type && x.role === m.role
      );
      expect(tetap).toBeDefined();
      expect(tetap!.account_id).toBe(m.account_id);
    }
    // Akun lama tidak ada yang tertimpa.
    for (const a of sebelum.account) {
      const tetap = sesudah.account.find((x) => x.kode === a.kode);
      expect(tetap!.nama).toBe(a.nama);
      expect(tetap!.normal_balance).toBe(a.normal_balance);
    }
    // Self-heal generik menyisipkan akun & mapping yang belum ada —
    // termasuk 1-1670 milik v64.
    expect(sesudah.account.map((a) => a.kode)).toContain('1-1670');
    const mapSusut = sesudah.mapping.filter(
      (m) => m.transaction_type === 'PENYUSUTAN_PROPERTI_INVESTASI'
    );
    expect(mapSusut).toHaveLength(2);
  });

  it('SESUDAH: versi naik ke v64, FK aktif, foreign_key_check kosong', async () => {
    await seedInstalasiV63();
    await runMigrations(sebagaiSQLiteDatabase(testDb));
    const v = await testDb.getFirstAsync<{ version: number }>(`SELECT version FROM schema_meta`);
    expect(v!.version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk!.foreign_keys).toBe(1);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });

  it('SESUDAH: Bagian SHU lama tetap berfungsi — sisa piutang dan status utuh', async () => {
    await seedInstalasiV63();
    await runMigrations(sebagaiSQLiteDatabase(testDb));

    const rows = await listBagianShuInvestasiDenganDb(sebagaiSQLiteDatabase(testDb), {});
    expect(rows).toHaveLength(1);
    expect(rows[0].jumlah).toBe(5_000_000);
    expect(rows[0].jumlahDiterima).toBe(2_000_000);
    expect(rows[0].sisaPiutang).toBe(3_000_000);
    expect(rows[0].status).toBe('DIAKUI');

    // Penerimaan pelunasan pasca-upgrade tetap jalan, dan TETAP tidak
    // menambah pendapatan.
    await catatPenerimaanBagianShu({
      bagianShuId: rows[0].id,
      tanggal: '2026-05-05',
      jumlah: 3_000_000,
      sumberDana: 'KAS',
      nomorReferensi: 'TRM-002',
      createdBy: 'user-1',
    });
    const pendapatan = await testDb.getFirstAsync<{ k: number }>(
      `SELECT COALESCE(SUM(kredit),0) AS k FROM journal_entry WHERE account_id = ?`,
      AKUN.pendapatan
    );
    expect(pendapatan!.k).toBe(5_000_000);
    const sesudah = await listBagianShuInvestasiDenganDb(sebagaiSQLiteDatabase(testDb), {});
    expect(sesudah[0].status).toBe('LUNAS');
    expect(sesudah[0].sisaPiutang).toBe(0);
  });
});

// ===========================================================================
// IDEMPOTENSI
// ===========================================================================

describe('Idempotensi migrasi', () => {
  it('dijalankan dua kali: nol error, nol duplikat, versi tetap v64, histori utuh', async () => {
    await seedInstalasiV63();
    await runMigrations(sebagaiSQLiteDatabase(testDb));
    const sekali = await potret();

    await runMigrations(sebagaiSQLiteDatabase(testDb));
    const duaKali = await potret();

    expect(duaKali.journal).toEqual(sekali.journal);
    expect(duaKali.entry).toEqual(sekali.entry);
    expect(duaKali.bagianShu).toEqual(sekali.bagianShu);
    expect(duaKali.account.length).toBe(sekali.account.length);
    expect(duaKali.mapping.length).toBe(sekali.mapping.length);

    const dupAkun = await testDb.getAllAsync(
      `SELECT kode FROM account GROUP BY kode HAVING COUNT(*) > 1`
    );
    const dupJurnal = await testDb.getAllAsync(
      `SELECT nomor_jurnal FROM journal GROUP BY nomor_jurnal HAVING COUNT(*) > 1`
    );
    expect(dupAkun).toHaveLength(0);
    expect(dupJurnal).toHaveLength(0);

    const v = await testDb.getFirstAsync<{ version: number }>(`SELECT version FROM schema_meta`);
    // DIPERBARUI RC-S72: literal 68 basi sejak RC-S55 (v69). runMigrations selalu
    // membawa ke versi TERKINI; invarian idempotensi = versi tetap SCHEMA_VERSION
    // setelah dijalankan dua kali (bukan naik dua kali, bukan turun).
    expect(v!.version).toBe(SCHEMA_VERSION); // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL)
  });
});

// ===========================================================================
// FRESH INSTALL v64
// ===========================================================================

describe('Fresh install v64', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('seluruh tabel v63 & v64 tersedia dari skema awal', async () => {
    const tabel = (
      await testDb.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`)
    ).map((r) => r.name);
    for (const t of [
      'account', 'account_mapping', 'journal', 'journal_entry', 'investasi',
      'investasi_impairment', 'investasi_bagian_shu', 'investasi_bagian_shu_penerimaan',
      'investasi_penyusutan',
    ]) {
      expect(tabel).toContain(t);
    }
  });

  it('kolom penyusutan properti ada sejak awal, dan CHECK-nya menolak nilai asing', async () => {
    const nama = (await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(investasi)`)).map(
      (k) => k.name
    );
    for (const k of KOLOM_V64) expect(nama).toContain(k);

    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
      now, now
    );
    let ditolak = false;
    try {
      await testDb.runAsync(
        `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                                sumber_dana, status, created_by, created_at, updated_at, jenis_objek_properti)
         VALUES ('x','INV-X','PROPERTI_INVESTASI','X',1000,'2026-01-01','KAS','AKTIF','user-1',?,?,'PABRIK')`,
        now, now
      );
    } catch {
      ditolak = true;
    }
    expect(ditolak).toBe(true);
  });

  it('COA default memuat akun & mapping v64, tanpa duplikasi', () => {
    expect(DEFAULT_ACCOUNTS.map((a) => a.kode)).toContain('1-1670');
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    expect(new Set(kode).size).toBe(kode.length);
    const susut = DEFAULT_ACCOUNT_MAPPING.filter(
      (m) => m.transactionType === 'PENYUSUTAN_PROPERTI_INVESTASI'
    );
    expect(susut).toHaveLength(2);
    const semuaKode = new Set(kode);
    for (const m of DEFAULT_ACCOUNT_MAPPING) expect(semuaKode.has(m.accountKode)).toBe(true);
  });

  it('FK aktif & foreign_key_check kosong pada instalasi baru', async () => {
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk!.foreign_keys).toBe(1);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });
});

// ===========================================================================
// PEMULIHAN BILA MIGRASI TERHENTI DI TENGAH
// ===========================================================================

describe('Migrasi terhenti di tengah — maju-ulang, bukan rollback', () => {
  /**
   * Blok migrasi di `initDatabase` TIDAK dibungkus satu transaksi
   * global; hanya migrasi yang membangun ulang tabel yang punya
   * transaksi sendiri. Untuk v63/v64 yang murni aditif, jaminannya
   * adalah MAJU-ULANG: setiap pernyataan idempoten, dan `schema_meta`
   * baru naik setelah seluruh blok selesai.
   *
   * Yang disimulasikan di sini adalah keadaan sesudah proses mati di
   * tengah: sebagian skema v64 sudah terpasang, tetapi versinya belum
   * naik.
   */
  it('sebagian skema v64 sudah ada tetapi versi belum naik: dilanjutkan tanpa duplikasi', async () => {
    await seedInstalasiV63();
    const sebelum = await potret();

    // Simulasi mati di tengah: satu kolom & tabel v64 sudah sempat dibuat.
    await testDb.execAsync(`ALTER TABLE investasi ADD COLUMN jenis_objek_properti TEXT;`);
    await testDb.execAsync(`
      CREATE TABLE IF NOT EXISTS investasi_penyusutan (
        id TEXT PRIMARY KEY,
        investasi_id TEXT NOT NULL REFERENCES investasi(id),
        periode TEXT NOT NULL,
        tanggal TEXT NOT NULL,
        nilai_penyusutan INTEGER NOT NULL CHECK (nilai_penyusutan > 0),
        journal_id TEXT NOT NULL REFERENCES journal(id),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (investasi_id, periode)
      );`);
    const versiTertinggal = await testDb.getFirstAsync<{ version: number }>(
      `SELECT version FROM schema_meta`
    );
    expect(versiTertinggal!.version).toBe(63);

    await runMigrations(sebagaiSQLiteDatabase(testDb));

    // Selesai sampai v64, tanpa error dan tanpa kolom/tabel berlipat.
    const v = await testDb.getFirstAsync<{ version: number }>(`SELECT version FROM schema_meta`);
    expect(v!.version).toBe(SCHEMA_VERSION); // DIPERBARUI RC-S54: migrasi berlanjut sampai versi terkini
    const kolom = (await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(investasi)`)).map(
      (k) => k.name
    );
    for (const k of KOLOM_V64) {
      expect(kolom.filter((x) => x === k)).toHaveLength(1);
    }
    const sesudah = await potret();
    expect(sesudah.journal).toEqual(sebelum.journal);
    expect(sesudah.entry).toEqual(sebelum.entry);
    expect(sesudah.bagianShu).toEqual(sebelum.bagianShu);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });

  it('migrasi v63 & v64 murni aditif — nol DROP, nol rewrite tabel', () => {
    const db = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src/database/db.ts'),
      'utf8'
    ) as string;
    const a64 = db.indexOf('export async function migrasiV64');
    const a63 = db.indexOf('export async function migrasiV63');
    const a62 = db.indexOf('export async function migrasiV62');
    const blok64 = db.slice(a64, a63);
    const blok63 = db.slice(a63, a62);
    for (const blok of [blok63, blok64]) {
      expect(blok).not.toMatch(/DROP TABLE|DELETE FROM/);
      expect(blok).not.toMatch(/_new\b/);
    }
  });
});
