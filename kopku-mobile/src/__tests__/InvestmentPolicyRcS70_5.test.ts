import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S70.5 — INVESTMENT INSTRUMENT POLICY & FIXED RETURN CONTROL.
 *
 * Mengunci hasil audit RC-S70.5:
 *   1. Model investasi TIDAK punya atribut eligibility fixed return, dan
 *      aplikasi TIDAK mengarang satu. Bila kolom semacam itu ditambahkan
 *      kelak (RC-S70.6), test "tripwire" di bawah gagal dan memaksa service
 *      Imbal Hasil Tetap diperbarui untuk memakainya.
 *   2. KOPERASI_LAIN hanya kelompok; tidak ada kode yang menyimpulkan fixed
 *      return dari jenis investasi.
 *   3. 4-1700 tidak diubah; riwayat postingnya DAPAT dipisahkan per jalur
 *      (dedicated Imbal Hasil Tetap vs Pendapatan Lainnya generik) lewat
 *      kolom `kategori` — dasar proposal RC-S70.6 COA 4-1700.
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

import { tambahPendapatanInvestasi, tambahTransaksiPendapatan, listAkunPendapatanLainnya } from '@/services/PendapatanLainnyaService';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';
import { KEBIJAKAN_PENDAPATAN_INVESTASI, JENIS_INVESTASI_BAGIAN_SHU, AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED } from '@/config/pendapatanKoperasiPolicy';
import { SCHEMA_VERSION } from '@/database/schema';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

async function seed(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();
  const akun = async (id: string, kode: string, nama: string, kat: string, nb: string, lhu: string | null, sys = 0) =>
    testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES (?,?,?,?,?,1,?,?,?,?)`,
      id, kode, nama, kat, nb, sys, lhu, now, now
    );
  await akun('acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT', null, 1);
  await akun('acc-4-1700', '4-1700', 'Pendapatan Bagi Hasil', 'PENDAPATAN', 'KREDIT', 'HASIL_INVESTASI');
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m1','KAS_UMUM','DEFAULT','acc-kas')`);
  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, status, created_by, created_at)
     VALUES ('inv-kl','INV-2026-000001','KOPERASI_LAIN','Koperasi Mitra',10000000,'2026-01-05','KAS','AKTIF','user-1',?)`,
    now
  );
}

// ============================================================
describe('RC-S70.5 — audit model: eligibility fixed return', () => {
  it('TRIPWIRE: tabel investasi tidak punya kolom eligibility/sifat hasil (bila ditambah, service Imbal Hasil Tetap WAJIB memakainya)', () => {
    const skema = baca('src/database/schema.ts');
    const blok = skema.slice(skema.indexOf('CREATE TABLE IF NOT EXISTS investasi ('), skema.indexOf(');', skema.indexOf('CREATE TABLE IF NOT EXISTS investasi (')));
    const db = baca('src/database/db.ts');
    const kolomTambahan = [...db.matchAll(/tambahKolomJikaBelumAda\('investasi', '([a-z_]+)'/g)].map((m) => m[1]);
    for (const terlarang of ['sifat_hasil', 'return_type', 'fixed_rate', 'imbal_hasil', 'jenis_hasil', 'contract_type', 'instrument_type', 'profit_share_rate']) {
      expect(blok).not.toContain(terlarang);
      expect(kolomTambahan).not.toContain(terlarang);
    }
  });

  it('tidak ada migrasi di RC-S70.5: SCHEMA_VERSION tetap 69', () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });

  it('KOPERASI_LAIN hanya kelompok: jenis sama untuk Bagian SHU & Imbal Hasil Tetap, dan tidak ada kode yang menyimpulkan fixed return dari jenis', () => {
    expect(JENIS_INVESTASI_BAGIAN_SHU).toBe('KOPERASI_LAIN');
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.IMBAL_HASIL_TETAP.jenisInvestasi).toBe('KOPERASI_LAIN');
    const src = ['src/services/PendapatanLainnyaService.ts', 'src/services/InvestasiService.ts', 'src/services/BagianShuService.ts', 'src/config/pendapatanKoperasiPolicy.ts']
      .map((f) => tanpaKomentar(baca(f)))
      .join('\n');
    expect(src).not.toMatch(/isFixedReturn|fixedReturn|FIXED_RETURN|eligib/i);
  });
});

// ============================================================
describe('RC-S70.5 — UI copy: tanpa kesan fixed-return otomatis', () => {
  const menu = tanpaKomentar(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));
  const invForm = baca('src/screens/Transaksi/PendapatanInvestasiFormScreen.tsx');
  const shuForm = tanpaKomentar(baca('src/screens/Transaksi/BagianShuFormScreen.tsx'));

  it('copy menu final', () => {
    expect(menu).toContain("sub: 'Catat hak atau penerimaan bagian SHU dari penyertaan pada koperasi lain.'");
    expect(menu).toContain("sub: 'Catat imbal hasil tetap berdasarkan ketentuan atau hak kontraktual investasi.'");
  });

  it('empty state: Bagian SHU & Imbal Hasil Tetap (varian "eligibility belum formal")', () => {
    expect(shuForm).toContain('emptyTitle="Belum Ada Penyertaan pada Koperasi Lain"');
    expect(shuForm).toContain('emptyMessage="Tidak ada investasi aktif yang memenuhi syarat untuk pencatatan Bagian SHU."');
    expect(invForm).toContain("'Belum Ada Investasi Koperasi Lain'");
    expect(invForm).toContain("'Tidak ada investasi aktif yang tersedia untuk workflow ini.'");
    // Varian "eligibility terverifikasi" TIDAK dipakai karena model belum mendukungnya.
    expect(invForm).not.toContain('Belum Ada Investasi dengan Imbal Hasil Tetap');
  });

  it('form Imbal Hasil Tetap menyatakan terus terang bahwa dasar fixed return tidak diverifikasi sistem', () => {
    expect(invForm).toContain("kategori === 'IMBAL_HASIL_TETAP' ? (");
    expect(invForm).toContain('tidak diverifikasi secara sistem');
  });

  it('kata "otomatis" / "pasti" / "semua investasi" tidak dipakai pada copy kedua opsi', () => {
    const i = menu.indexOf("judul: 'Penyertaan pada Koperasi Lain'");
    const blok = menu.slice(i, menu.indexOf("judul: 'Usaha Lain'"));
    expect(blok).not.toMatch(/otomatis|pasti|semua investasi/i);
    const empty = [...invForm.matchAll(/'(Belum Ada Investasi Koperasi Lain|Tidak ada investasi aktif yang tersedia untuk workflow ini\.)'/g)].map((m) => m[1]);
    for (const t of empty) expect(t).not.toMatch(/otomatis|pasti|semua investasi/i);
  });
});

// ============================================================
describe('RC-S70.5 — COA 4-1700: audit pemakaian (tanpa perubahan master)', () => {
  beforeEach(seed);

  it('master 4-1700 tidak berubah', () => {
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '4-1700')).toEqual({
      kode: '4-1700', nama: 'Pendapatan Bagi Hasil', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'HASIL_INVESTASI',
    });
    expect(DEFAULT_ACCOUNTS.filter((a) => a.kode === '4-1700')).toHaveLength(1);
  });

  it('DUA jalur dapat memposting 4-1700: dedicated Imbal Hasil Tetap DAN Pendapatan Lainnya generik (4-1700 tidak direservasi)', async () => {
    expect(AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED).not.toContain('4-1700');
    expect((await listAkunPendapatanLainnya()).map((o) => o.kode)).toContain('4-1700');
  });

  it('riwayat 4-1700 DAPAT dipisahkan per jalur lewat kategori: dedicated = "Imbal Hasil Tetap", generik = NULL', async () => {
    await tambahPendapatanInvestasi({
      kategori: 'IMBAL_HASIL_TETAP', investasiId: 'inv-kl', tanggal: '2026-03-01', nominal: 1_000_000, jenis: 'KAS',
      createdBy: 'user-1', nomorDokumen: 'IHT-01',
    });
    await tambahTransaksiPendapatan({ tanggal: '2026-03-02', accountId: 'acc-4-1700', nominal: 500_000, jenis: 'KAS', createdBy: 'user-1' });

    const baris = await testDb.getAllAsync<{ kategori: string | null; nominal: number }>(
      `SELECT kategori, nominal FROM kas_transaksi WHERE akun_lawan_id = 'acc-4-1700' ORDER BY tanggal`
    );
    expect(baris).toEqual([
      { kategori: KEBIJAKAN_PENDAPATAN_INVESTASI.IMBAL_HASIL_TETAP.label, nominal: 1_000_000 },
      { kategori: null, nominal: 500_000 },
    ]);
  });
});
