import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb, sebagaiSQLiteDatabase } from './testDb';

let testDb: TestDb;

// DIPERBARUI RC-S72 (FIXTURE BUG, register #14): mock lama hanya mengembalikan
// getDb/withTransaction, sehingga `runMigrations` yang diuji JALUR B tidak ada di
// Jest (hanya jalan di harness `.harness/dbShim.js`). Pola disamakan dengan
// UpgradeV68KeV69RcS55. COA/mapping (termasuk 4-1500/4-1510/4-1520) tidak disentuh.
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

import { SCHEMA_VERSION } from '@/database/schema';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { runMigrations } from '@/database/db';

/**
 * RC-S53 — KEPUTUSAN 01-A (POLICY 01, bagian akun aset).
 *
 * Suite ini mengunci SATU keputusan: tiga akun piutang hasil investasi
 * dibuat, empat usulan sisanya tidak. Yang diuji bukan "akunnya ada",
 * melainkan syarat-syarat yang membuat keputusan itu sah:
 *
 *   - kodenya berada di blok piutang yang memang sudah ada, bukan angka
 *     baru yang dikarang;
 *   - tidak satu pun dari 12 kode requirement asli ikut masuk;
 *   - akun pendapatan TIDAK dipakai sebagai akun piutang;
 *   - `1-1660` tetap satu akun (POLICY 02 belum diputuskan);
 *   - ketiganya BELUM dipetakan, karena peristiwa pengakuannya milik
 *     POLICY 04/05/06 yang masih POLICY_REQUIRED;
 *   - tidak ada perubahan skema.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

/** Tiga akun yang DIPUTUSKAN dibuat. */
const AKUN_BARU = [
  { kode: '1-1220', nama: 'Piutang Pendapatan Investasi' },
  { kode: '1-1240', nama: 'Piutang Bagi Hasil' },
  { kode: '1-1250', nama: 'Piutang Pendapatan Sewa' },
];

/** Dua belas kode requirement asli — tetap TIDAK boleh masuk produksi. */
const KODE_DIMINTA = [
  '1-660', '1-661', '1-220', '1-230', '1-240', '1-250',
  '4-1510', '4-1520', '4-1530', '4-1540', '4-2100', '5-5000',
];

describe('KEPUTUSAN 01-A — tiga akun piutang hasil investasi', () => {
  it('ketiganya ada dengan kategori, normal balance, dan flag yang benar', () => {
    for (const harap of AKUN_BARU) {
      const akun = DEFAULT_ACCOUNTS.find((a) => a.kode === harap.kode);
      expect(akun).toBeDefined();
      expect(akun!.nama).toBe(harap.nama);
      expect(akun!.kategori).toBe('ASET');
      expect(akun!.normalBalance).toBe('DEBIT');
      expect(akun!.isSystem).toBe(true);
      // Akun ASET tidak punya baris LHU; mengisinya akan memindahkan
      // piutang ke laporan hasil usaha.
      expect(akun!.lhuKlasifikasi).toBeUndefined();
    }
  });

  it('kodenya berada di blok piutang existing, bukan blok baru', () => {
    // Blok 1-12xx sudah dipakai kelompok piutang sebelum keputusan ini.
    for (const k of ['1-1200', '1-1205', '1-1210']) {
      expect(DEFAULT_ACCOUNTS.map((a) => a.kode)).toContain(k);
    }
    for (const harap of AKUN_BARU) {
      expect(harap.kode.startsWith('1-12')).toBe(true);
    }
  });

  it('slot 1-1230 tetap kosong; Piutang Dividen tersedia sebagai akun kode diminta 1-230 (tanpa mapping)', () => { // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 kode diminta kini ADA di COA (DEFINED / NOT ACTIVELY POSTED); policy posting tidak berubah
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    expect(kode).not.toContain('1-1230');
    const dividen = DEFAULT_ACCOUNTS.filter((a) => a.nama === 'Piutang Dividen');
    expect(dividen.map((a) => a.kode)).toEqual(['1-230']);
    expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === '1-230')).toEqual([]);
  });

  it('1-1660 tetap satu akun untuk POSTING; 1-660/1-661 hanya terdefinisi, tanpa mapping', () => { // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 kode diminta kini ADA di COA (DEFINED / NOT ACTIVELY POSTED); policy posting tidak berubah
    const coa = baca('src/config/defaultCOA.ts');
    expect(coa).toContain("{ kode: '1-1660', nama: 'Properti Investasi'");
    const kodeDari = (nama: string) => DEFAULT_ACCOUNTS.filter((a) => a.nama === nama).map((a) => a.kode);
    expect(kodeDari('Tanah Properti Investasi')).toEqual(['1-660']);
    expect(kodeDari('Bangunan Properti Investasi')).toEqual(['1-661']);
    for (const k of ['1-660', '1-661']) expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === k)).toEqual([]);
    // Posting properti investasi TIDAK pindah: tetap 1-1660 / 1-1670.
    expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.transactionType === 'INVESTASI_PROPERTI_INVESTASI').map((m) => m.accountKode)).toEqual(['1-1660']);
  });

  it('ke-12 kode requirement asli kini ADA di COA dengan kode persis, tanpa satu pun mapping otomatis', () => { // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 kode diminta kini ADA di COA (DEFINED / NOT ACTIVELY POSTED); policy posting tidak berubah
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    for (const k of KODE_DIMINTA) {
      expect(kode).toContain(k);
      // DIPERBARUI RC-S88: 4-2100/5-5000 kini dipetakan model nilai wajar properti investasi.
      const mapping = DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === k).map((m) => m.transactionType);
      expect(mapping).toEqual(k === '4-2100' || k === '5-5000' ? ['NILAI_WAJAR_PROPERTI_INVESTASI'] : []);
    }
  });

  it('akun pendapatan TIDAK dipakai sebagai akun piutang', () => {
    // Pasangan pendapatan yang dirujuk keputusan tetap berkategori
    // PENDAPATAN, dan ketiga akun piutang tetap berkategori ASET.
    for (const k of ['4-1300', '4-1600', '4-1700']) {
      const akun = DEFAULT_ACCOUNTS.find((a) => a.kode === k);
      expect(akun).toBeDefined();
      expect(akun!.kategori).toBe('PENDAPATAN');
    }
    for (const harap of AKUN_BARU) {
      expect(DEFAULT_ACCOUNTS.find((a) => a.kode === harap.kode)!.kategori).toBe('ASET');
    }
  });

  // DIPERBARUI RC-S53 — KEPUTUSAN 04-A memetakan 1-1220. Dua akun lain
  // tetap tidak dipetakan: akrual (piutang) imbal hasil tetap & sewa masih
  // nonaktif (KEPUTUSAN 06). Penerimaan kas imbal hasil tetap (RC-S67.6)
  // tidak memakai piutang.
  it('hanya 1-1220 yang dipetakan; 1-1240 & 1-1250 tetap belum', () => {
    const untuk = (kode: string) => DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === kode);
    expect(untuk('1-1220').map((m) => m.transactionType).sort()).toEqual(
      ['BAGIAN_SHU_INVESTASI', 'BAGIAN_SHU_PENERIMAAN']
    );
    expect(untuk('1-1240')).toHaveLength(0);
    expect(untuk('1-1250')).toHaveLength(0);
  });

  it('pendapatan bagian SHU memakai 4-1300, bukan akun pendapatan baru', () => {
    const kredit = DEFAULT_ACCOUNT_MAPPING.filter(
      (m) => m.transactionType === 'BAGIAN_SHU_INVESTASI' && m.role === 'KREDIT_PENDAPATAN'
    );
    expect(kredit).toHaveLength(1);
    expect(kredit[0].accountKode).toBe('4-1300');
  });

  it('penerimaan kas TIDAK memetakan akun pendapatan mana pun', () => {
    // Inti pencegahan double revenue di tingkat mapping: settlement hanya
    // punya sisi piutang; sisi kas/bank ditentukan resolver kas.
    const settlement = DEFAULT_ACCOUNT_MAPPING.filter(
      (m) => m.transactionType === 'BAGIAN_SHU_PENERIMAAN'
    );
    expect(settlement).toHaveLength(1);
    expect(settlement[0].role).toBe('KREDIT_PIUTANG');
    expect(settlement[0].accountKode).toBe('1-1220');
  });

  it('seluruh kode unik; nama ganda HANYA pasangan kode-diminta vs akun semantik existing; format kode X-NNN(N)', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 akun kode-persis ditambahkan.
    // Kode diminta memakai 3 digit (1-660, 1-220, ...) dan namanya sengaja
    // persis sama dengan akun semantik existing untuk tiga piutang. Keduanya
    // didokumentasikan di coaPolicyRegistry (kode diminta -> akun existing).
    const KODE_DIMINTA_3_DIGIT = ['1-220', '1-230', '1-240', '1-250', '1-660', '1-661'];
    const NAMA_GANDA_TERDOKUMENTASI = ['Piutang Pendapatan Investasi', 'Piutang Bagi Hasil', 'Piutang Pendapatan Sewa'];
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    const nama = DEFAULT_ACCOUNTS.map((a) => a.nama);
    expect(new Set(kode).size).toBe(kode.length);
    const ganda = [...new Set(nama.filter((n, i) => nama.indexOf(n) !== i))].sort();
    expect(ganda).toEqual([...NAMA_GANDA_TERDOKUMENTASI].sort());
    for (const n of ganda) {
      const pasangan = DEFAULT_ACCOUNTS.filter((a) => a.nama === n).map((a) => a.kode).sort();
      expect(pasangan).toHaveLength(2);
      expect(pasangan.filter((k) => KODE_DIMINTA_3_DIGIT.includes(k))).toHaveLength(1);
    }
    for (const k of kode) {
      expect(KODE_DIMINTA_3_DIGIT.includes(k) ? /^[1-9]-\d{3}$/.test(k) : /^[1-9]-\d{4}$/.test(k)).toBe(true);
    }
  });

  // DIPERBARUI RC-S53 — v63 lahir dari KEPUTUSAN 04-A, bukan dari 01-A.
  // Yang dijaga: COA tetap TIDAK punya migrasi khusus sendiri.
  // DIPERBARUI RC-S53 corrective — SCHEMA_VERSION kini 64. Yang dijaga
  // tetap sama: tidak satu pun migrasi menyisipkan COA sendiri; itu tugas
  // blok self-heal generik.
  it('COA tetap tanpa migrasi khusus, baik di v63 maupun v64', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    const db = baca('src/database/db.ts');
    const awal64 = db.indexOf('export async function migrasiV64');
    const awal63 = db.indexOf('export async function migrasiV63');
    const blok = db.slice(awal64, db.indexOf('export async function migrasiV62'));
    for (const kode of ['1-1220', '1-1240', '1-1250', '1-1670']) {
      expect(blok).not.toContain(kode);
    }
    expect(blok).not.toContain('INSERT INTO account');
    expect(awal64).toBeLessThan(awal63);
  });

  it('setiap mapping tetap menunjuk akun yang benar-benar ada', () => {
    const kode = new Set(DEFAULT_ACCOUNTS.map((a) => a.kode));
    for (const m of DEFAULT_ACCOUNT_MAPPING) {
      expect(kode.has(m.accountKode)).toBe(true);
    }
  });
});

describe('KEPUTUSAN 02 — struktur properti investasi tetap satu akun', () => {
  it('1-1660 utuh: kategori, normal balance, dan isSystem tidak berubah', () => {
    const akun = DEFAULT_ACCOUNTS.find((a) => a.kode === '1-1660');
    expect(akun).toBeDefined();
    expect(akun!.nama).toBe('Properti Investasi');
    expect(akun!.kategori).toBe('ASET');
    expect(akun!.normalBalance).toBe('DEBIT');
    expect(akun!.isSystem).toBe(true);
  });

  it('mapping INVESTASI_PROPERTI_INVESTASI tetap menunjuk 1-1660, tanpa akun kedua', () => {
    const mapping = DEFAULT_ACCOUNT_MAPPING.filter(
      (m) => m.transactionType === 'INVESTASI_PROPERTI_INVESTASI'
    );
    expect(mapping).toHaveLength(1);
    expect(mapping[0].role).toBe('DEBIT_ASET');
    expect(mapping[0].accountKode).toBe('1-1660');
  });

  // DIPERBARUI RC-S53 corrective — 1-1670 Akumulasi Penyusutan Properti
  // Investasi ADALAH akun kontra, bukan akun properti kedua: POLICY 02
  // tetap utuh karena nilai perolehan tetap hanya di 1-1660.
  it('akun POSTING properti investasi tetap satu (1-1660) + kontra 1-1670; 1-660/1-661 terdefinisi tanpa posting', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 akun kode-persis ditambahkan.
    const properti = DEFAULT_ACCOUNTS.filter((a) => a.nama === 'Properti Investasi');
    expect(properti).toHaveLength(1);
    expect(properti[0].kode).toBe('1-1660');
    const kontra = DEFAULT_ACCOUNTS.find((a) => a.kode === '1-1670');
    expect(kontra!.normalBalance).toBe('KREDIT');
    for (const k of ['1-660', '1-661']) {
      expect(DEFAULT_ACCOUNTS.find((a) => a.kode === k)).toBeDefined();
      expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === k)).toEqual([]);
    }
  });

  it('tidak ada code path yang menyusutkan akun investasi', () => {
    // Dasar faktual KEPUTUSAN 02 butir 2: penyusutan hanya berlaku atas aset
    // tetap & aset tak berwujud, bukan atas akun investasi.
    const mappingPenyusutan = DEFAULT_ACCOUNT_MAPPING.filter(
      (m) => m.transactionType === 'PENYUSUTAN_ASET'
    ).map((m) => m.accountKode);
    expect(mappingPenyusutan).toContain('5-1300');
    expect(mappingPenyusutan).toContain('1-1510');
    expect(mappingPenyusutan).not.toContain('1-1660');
  });
});

describe('KEPUTUSAN 01-A — integritas data di SQLite sungguhan', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });
  afterEach(() => {
    (testDb as unknown as { closeSync?: () => void }).closeSync?.();
  });

  async function seedCoa(): Promise<void> {
    const now = new Date().toISOString();
    for (const a of DEFAULT_ACCOUNTS) {
      await testDb.runAsync(
        `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?,?,?)`,
        `acc-${a.kode}`,
        a.kode,
        a.nama,
        a.kategori,
        a.normalBalance,
        a.isSystem ? 1 : 0,
        a.lhuKlasifikasi ?? null,
        now,
        now
      );
    }
  }

  it('seluruh COA tersimpan & terbaca ulang, termasuk ketiga akun baru', async () => {
    await seedCoa();
    for (const harap of AKUN_BARU) {
      const row = await testDb.getFirstAsync<{ kode: string; nama: string; kategori: string; normal_balance: string; is_system: number }>(
        `SELECT kode, nama, kategori, normal_balance, is_system FROM account WHERE kode = ?`,
        harap.kode
      );
      expect(row).not.toBeNull();
      expect(row!.nama).toBe(harap.nama);
      expect(row!.kategori).toBe('ASET');
      expect(row!.normal_balance).toBe('DEBIT');
      expect(row!.is_system).toBe(1);
    }
  });

  it('kode duplikat DITOLAK database — bukan menimpa akun yang sudah ada', async () => {
    await seedCoa();
    const now = new Date().toISOString();
    let ditolak = false;
    try {
      await testDb.runAsync(
        `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
         VALUES (?,?,?,?,?,1,1,?,?)`,
        'acc-duplikat', '1-1220', 'Piutang Pendapatan Investasi (duplikat)', 'ASET', 'DEBIT', now, now
      );
    } catch {
      ditolak = true;
    }
    expect(ditolak).toBe(true);
    const jumlah = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM account WHERE kode = '1-1220'`
    );
    expect(jumlah!.n).toBe(1);
    // Akun aslinya tidak tersentuh.
    const asli = await testDb.getFirstAsync<{ nama: string }>(
      `SELECT nama FROM account WHERE kode = '1-1220'`
    );
    expect(asli!.nama).toBe('Piutang Pendapatan Investasi');
  });

  it('penyisipan ulang bersifat idempoten lewat pola self-heal (INSERT hanya bila belum ada)', async () => {
    await seedCoa();
    const sebelum = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM account`);
    // Pola blok self-heal COA di db.ts: lewati kode yang sudah ada.
    const ada = new Set(
      (await testDb.getAllAsync<{ kode: string }>(`SELECT kode FROM account`)).map((r) => r.kode)
    );
    const now = new Date().toISOString();
    for (const a of DEFAULT_ACCOUNTS) {
      if (ada.has(a.kode)) continue;
      await testDb.runAsync(
        `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
        `acc2-${a.kode}`, a.kode, a.nama, a.kategori, a.normalBalance, a.isSystem ? 1 : 0, now, now
      );
    }
    const sesudah = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM account`);
    expect(sesudah!.n).toBe(sebelum!.n);
  });

  it('tidak ada duplikat kode & foreign_key_check kosong', async () => {
    await seedCoa();
    const duplikat = await testDb.getAllAsync<{ kode: string }>(
      `SELECT kode FROM account GROUP BY kode HAVING COUNT(*) > 1`
    );
    expect(duplikat).toHaveLength(0);
    const fk = await testDb.getAllAsync<Record<string, unknown>>(`PRAGMA foreign_key_check`);
    expect(fk).toHaveLength(0);
  });

  // =========================================================================
  // CODE PATH KETERSEDIAAN AKUN — FAKTA, BUKAN ASUMSI
  // =========================================================================
  // Pertanyaannya: lewat jalur mana ketiga akun 01-A benar-benar sampai ke
  // database? Dua jalur ada di kode, dan keduanya diuji di sini.

  async function siapkanInstalasiTanpaAkunBaru(versi: number): Promise<void> {
    await seedCoa();
    await testDb.runAsync(`DELETE FROM account WHERE kode IN ('1-1220','1-1240','1-1250')`);
    await testDb.execAsync(
      `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
    );
    await testDb.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, ?)`, versi);
  }

  it('JALUR B — instalasi yang versinya TERTINGGAL: self-heal COA generik menyisipkan ketiganya', async () => {
    await siapkanInstalasiTanpaAkunBaru(SCHEMA_VERSION - 1);
    await runMigrations(sebagaiSQLiteDatabase(testDb));
    for (const harap of AKUN_BARU) {
      const row = await testDb.getFirstAsync<{ kode: string }>(
        `SELECT kode FROM account WHERE kode = ?`,
        harap.kode
      );
      expect(row).not.toBeNull();
    }
  });

  it('JALUR B — self-heal idempoten: dijalankan dua kali tidak menduplikasi', async () => {
    await siapkanInstalasiTanpaAkunBaru(SCHEMA_VERSION - 1);
    await runMigrations(sebagaiSQLiteDatabase(testDb));
    const sesudahSekali = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM account`);
    await runMigrations(sebagaiSQLiteDatabase(testDb));
    const sesudahDuaKali = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM account`);
    expect(sesudahDuaKali!.n).toBe(sesudahSekali!.n);
    const duplikat = await testDb.getAllAsync<{ kode: string }>(
      `SELECT kode FROM account GROUP BY kode HAVING COUNT(*) > 1`
    );
    expect(duplikat).toHaveLength(0);
  });

  it('BATAS JALUR B — instalasi yang SUDAH di versi terkini: blok self-heal tidak dijalankan', async () => {
    // Blok self-heal COA berada DI DALAM `if (currentVersion < SCHEMA_VERSION)`.
    // Pada database yang sudah di versi aplikasi, seluruh blok itu dilewati —
    // jadi mengubah DEFAULT_ACCOUNTS saja TIDAK menyentuh instalasi tersebut.
    // Ini fakta code path, dan alasannya kenapa ketiga akun tidak boleh
    // diklaim "sudah ada di semua instalasi".
    await siapkanInstalasiTanpaAkunBaru(SCHEMA_VERSION);
    await runMigrations(sebagaiSQLiteDatabase(testDb));
    for (const harap of AKUN_BARU) {
      const row = await testDb.getFirstAsync<{ kode: string }>(
        `SELECT kode FROM account WHERE kode = ?`,
        harap.kode
      );
      expect(row).toBeNull();
    }
  });

  it('ketiga akun baru tidak membawa jurnal apa pun', async () => {
    await seedCoa();
    const entri = await testDb.getAllAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal_entry je
       JOIN account a ON a.id = je.account_id
       WHERE a.kode IN ('1-1220','1-1240','1-1250')`
    );
    expect(entri[0].n).toBe(0);
  });
});
