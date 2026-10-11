import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S67.6 — IMBAL HASIL TETAP (cash-basis) & entry Penjualan Aset.
 *
 * Bagian DATABASE memakai SQLite sungguhan (skema produksi) dan
 * AccountingEngine asli. Bagian STRUKTURAL membaca source untuk mengunci
 * sifat yang tidak dapat dibuktikan lewat pemanggilan fungsi (hierarki
 * menu, rute, tidak ada jalur akuntansi kedua).
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

import {
  kunciIdentitasPendapatanInvestasi,
  getInfoPendapatanInvestasi,
  tambahPendapatanInvestasi,
  listRiwayatPendapatanInvestasi,
  tambahTransaksiPendapatan,
  koreksiTransaksiPendapatan,
  listTransaksiPendapatan,
  PendapatanInvestasiDitolakError,
} from '@/services/PendapatanLainnyaService';
import { KEBIJAKAN_PENDAPATAN_INVESTASI, SEMUA_KATEGORI_PENDAPATAN_INVESTASI, isKategoriPendapatanInvestasi } from '@/config/pendapatanKoperasiPolicy';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const ACC = {
  kas: 'acc-kas',
  bankBca: 'acc-bank-bca',
  bunga: 'acc-4-1500',
  sewa: 'acc-4-1600',
  bagiHasil: 'acc-4-1700',
  lain: 'acc-4-2000',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT',
  opts: { isSystem?: boolean; isActive?: boolean; lhu?: string | null } = {}
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, kode, nama, kategori, nb, opts.isActive === false ? 0 : 1, opts.isSystem ? 1 : 0, opts.lhu ?? null, now, now
  );
}

async function seedInvestasi(
  db: TestDb,
  id: string,
  nomor: string,
  jenis: string,
  nama: string,
  opts: { tanggal?: string; status?: string } = {}
) {
  await db.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, created_by, created_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, nomor, jenis, nama, 50_000_000, opts.tanggal ?? '2026-01-02', 'KAS', 'user-1', new Date().toISOString(), opts.status ?? 'AKTIF'
  );
}

async function setupFixture(opts: { tanpaSewa?: boolean; bungaNonaktif?: boolean } = {}): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT', { isSystem: true });
  await seedAccount(db, ACC.bankBca, '1-1100', 'Bank BCA', 'ASET', 'DEBIT', { isSystem: true });
  await seedAccount(db, ACC.bunga, '4-1500', 'Pendapatan Bunga', 'PENDAPATAN', 'KREDIT', {
    lhu: 'HASIL_INVESTASI',
    isActive: !opts.bungaNonaktif,
  });
  // RC-S70.6 — fixture: leaf Deposito kini memposting ke 4-1510 (akun spesifik).
  await seedAccount(db, 'acc-4-1510', '4-1510', 'Pendapatan Bunga Deposito', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  if (!opts.tanpaSewa) {
    await seedAccount(db, ACC.sewa, '4-1600', 'Pendapatan Sewa', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  }
  await seedAccount(db, ACC.lain, '4-2000', 'Pendapatan Usaha Lain', 'PENDAPATAN', 'KREDIT', { lhu: 'PENDAPATAN_USAHA_LAIN' });
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kas','KAS_UMUM','DEFAULT',?)`,
    ACC.kas
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2025',2025,'2025-01-01','2025-12-31','CLOSED')`
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES ('bank-1','BCA','123','Koperasi',0,?,1,?)`,
    ACC.bankBca, now
  );
  await seedInvestasi(db, 'inv-dep', 'INV-2026-000001', 'DEPOSITO_BANK_UMUM', 'Deposito Bank Contoh');
  await seedInvestasi(db, 'inv-ul', 'INV-2026-000002', 'USAHA_LAIN', 'CV Mitra Usaha');
  await seedInvestasi(db, 'inv-prop', 'INV-2026-000003', 'PROPERTI_INVESTASI', 'Ruko Jl. Contoh');
  await seedInvestasi(db, 'inv-kl', 'INV-2026-000004', 'KOPERASI_LAIN', 'Koperasi Mitra');
  await seedInvestasi(db, 'inv-batal', 'INV-2026-000005', 'DEPOSITO_BANK_UMUM', 'Deposito Dibatalkan', { status: 'DIBATALKAN' });
  await seedInvestasi(db, 'inv-baru', 'INV-2026-000006', 'DEPOSITO_BANK_UMUM', 'Deposito Baru', { tanggal: '2026-03-01' });
  return db;
}

async function hitung(sql: string, ...p: unknown[]): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(sql, ...(p as any[]));
  return r?.n ?? 0;
}

async function jurnalSeimbang(journalId: string) {
  const r = await testDb.getFirstAsync<{ d: number; k: number; baris: number }>(
    `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k, COUNT(*) AS baris FROM journal_entry WHERE journal_id = ?`,
    journalId
  );
  return r!;
}

const dasar = {
  kategori: 'BUNGA_DEPOSITO' as const,
  investasiId: 'inv-dep',
  tanggal: '2026-02-10',
  nominal: 125_000,
  jenis: 'KAS' as const,
  createdBy: 'user-1',
};


const ACC_BAGI_HASIL = 'acc-4-1700';

async function fixtureIHT(opts: { tanpaAkun?: boolean } = {}) {
  testDb = await setupFixture();
  if (!opts.tanpaAkun) {
    await seedAccount(testDb, ACC_BAGI_HASIL, '4-1700', 'Pendapatan Bagi Hasil', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  }
}

const iht = {
  kategori: 'IMBAL_HASIL_TETAP' as const,
  investasiId: 'inv-kl',
  tanggal: '2026-02-15',
  nominal: 2_500_000,
  jenis: 'KAS' as const,
  createdBy: 'user-1',
  nomorDokumen: 'IH-2026-001',
};

describe('RC-S67.6 — Imbal Hasil Tetap: kebijakan & COA', () => {
  it('kategori terdaftar: KOPERASI_LAIN, akun 4-1700, dokumen wajib', () => {
    const k = KEBIJAKAN_PENDAPATAN_INVESTASI.IMBAL_HASIL_TETAP;
    expect(k.jenisInvestasi).toBe('KOPERASI_LAIN');
    expect(k.akunKode).toBe('4-1700');
    expect(k.wajibDokumen).toBe(true);
    expect(SEMUA_KATEGORI_PENDAPATAN_INVESTASI).toContain('IMBAL_HASIL_TETAP');
  });

  it('4-1700 existing di COA: PENDAPATAN, KREDIT, non-sistem, HASIL_INVESTASI; dicadangkan untuk imbal hasil tetap', () => {
    const a = DEFAULT_ACCOUNTS.find((x) => x.kode === '4-1700');
    expect(a).toMatchObject({ kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'HASIL_INVESTASI' });
    expect(baca('src/config/coaPolicyRegistry.ts')).toContain('1-1240/4-1700');
    expect(baca('src/config/coaPolicyRegistry.ts')).toContain('dicadangkan untuk imbal hasil tetap');
  });

  it('tidak ada jalur produksi yang menolak IMBAL_HASIL_TETAP; akrual tetap di luar register Bagian SHU', () => {
    // RC-S67.6.1: JenisHasilDisabledError (kode mati) dihapus.
    const semua = ['src/services/BagianShuService.ts', 'src/services/PendapatanLainnyaService.ts', 'src/config/pendapatanKoperasiPolicy.ts',
      'src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx', 'src/screens/Transaksi/PendapatanInvestasiFormScreen.tsx']
      .map((f) => tanpaKomentar(baca(f))).join('\n');
    expect(semua).not.toMatch(/JenisHasilDisabledError|HASIL_INVESTASI_DISABLED/);
    expect(isKategoriPendapatanInvestasi('IMBAL_HASIL_TETAP')).toBe(true);
    // Semantik Bagian SHU tidak berubah: register tetap satu jenis hasil.
    expect(baca('src/database/schema.ts')).toContain("CHECK (jenis_hasil IN ('BAGIAN_SHU'))");
  });

  it('kebijakan tercatat ACTIVE di dokumen keputusan (04-B) — bukan DISABLED', () => {
    const pol = baca('POLICY_DECISION_RC-S53.md');
    const i = pol.indexOf('### KEPUTUSAN 04-B');
    const blok = pol.slice(i, pol.indexOf('---', i));
    expect(blok).toContain('`CASH-BASIS AKTIF`');
    expect(blok).toContain('Dr Kas/Bank / Cr `4-1700`');
    expect(blok).not.toContain('`DISABLED`');
  });
});

describe('IMBAL_HASIL_TETAP', () => {
  beforeEach(async () => {
    await fixtureIHT();
  });

  it('posting valid: Dr Kas / Cr 4-1700, seimbang, POSTED, sumber & dokumen tercatat', async () => {
    const r = await tambahPendapatanInvestasi(iht);
    expect(r.akunKode).toBe('4-1700');
    const s = await jurnalSeimbang(r.journalId);
    expect(s).toEqual({ d: 2_500_000, k: 2_500_000, baris: 2 });
    const dr = await testDb.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit > 0`, r.journalId);
    const cr = await testDb.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM journal_entry WHERE journal_id = ? AND kredit > 0`, r.journalId);
    expect(dr?.account_id).toBe(ACC.kas);
    expect(cr?.account_id).toBe(ACC_BAGI_HASIL);
    const j = await testDb.getFirstAsync<{ status: string; deskripsi: string; sumber_transaksi: string }>(
      `SELECT status, deskripsi, sumber_transaksi FROM journal WHERE id = ?`, r.journalId
    );
    expect(j?.status).toBe('POSTED');
    // Identifier existing (tidak dibuat sumber baru): KAS_PENERIMAAN_LAIN +
    // kategori 'Imbal Hasil Tetap' + identity PI|IMBAL_HASIL_TETAP|...
    expect(j?.sumber_transaksi).toBe('KAS_PENERIMAAN_LAIN');
    expect(await hitung(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE tipe = 'PENERIMAAN'`)).toBe(1);
    expect(j?.deskripsi).toContain('INV-2026-000004');
    expect(j?.deskripsi).toContain('Koperasi Mitra');
    expect(j?.deskripsi).toContain('Dok IH-2026-001');
    const row = await testDb.getFirstAsync<{ kategori: string; idempotency_key: string; journal_id: string }>(
      `SELECT kategori, idempotency_key, journal_id FROM kas_transaksi WHERE id = ?`, r.id
    );
    expect(row?.kategori).toBe('Imbal Hasil Tetap');
    expect(row?.journal_id).toBe(r.journalId);
    expect(row?.idempotency_key).toBe(kunciIdentitasPendapatanInvestasi('IMBAL_HASIL_TETAP', 'inv-kl', 'IH-2026-001'));
    // 1-1240 / akrual tidak disentuh; tidak ada baris register Bagian SHU.
    expect(await hitung(`SELECT COUNT(*) AS n FROM investasi_bagian_shu`)).toBe(0);
  });

  it('via Bank: Dr Bank / Cr 4-1700', async () => {
    const r = await tambahPendapatanInvestasi({ ...iht, jenis: 'BANK', bankAccountId: 'bank-1' });
    const dr = await testDb.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit > 0`, r.journalId);
    expect(dr?.account_id).toBe(ACC.bankBca);
    expect(await hitung(`SELECT COUNT(*) AS n FROM bank_transaksi WHERE id = ?`, r.id)).toBe(1);
  });

  const tolakIHT = async (patch: Record<string, unknown>, kode: string) => {
    let err: any;
    try {
      await tambahPendapatanInvestasi({ ...iht, ...patch } as any);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PendapatanInvestasiDitolakError);
    expect(err?.kode).toBe(kode);
  };

  it('nomor dokumen wajib / tanpa "|"', async () => {
    await tolakIHT({ nomorDokumen: '  ' }, 'DOKUMEN_WAJIB');
    await tolakIHT({ nomorDokumen: undefined }, 'DOKUMEN_WAJIB');
    await tolakIHT({ nomorDokumen: 'A|B' }, 'DOKUMEN_TIDAK_VALID');
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(0);
  });

  it('sumber wajib penyertaan koperasi lain yang AKTIF; nominal & tanggal & kas/bank divalidasi', async () => {
    await tolakIHT({ investasiId: '' }, 'INVESTASI_WAJIB');
    await tolakIHT({ investasiId: 'inv-dep' }, 'JENIS_INVESTASI_TIDAK_SESUAI');
    await tolakIHT({ nominal: 0 }, 'NOMINAL_TIDAK_VALID');
    await tolakIHT({ tanggal: '2026-13-01' }, 'TANGGAL_TIDAK_VALID');
    await tolakIHT({ tanggal: '2999-01-01' }, 'TANGGAL_MASA_DEPAN');
    await tolakIHT({ jenis: 'BANK' }, 'REKENING_WAJIB');
    await testDb.runAsync(`UPDATE investasi SET status = 'DIBATALKAN' WHERE id = 'inv-kl'`);
    await tolakIHT({}, 'INVESTASI_TIDAK_AKTIF');
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(0);
  });

  it('duplikat dokumen (beda huruf/spasi, bahkan dengan kunci submit berbeda) DITOLAK — tetap 1 transaksi', async () => {
    await tambahPendapatanInvestasi({ ...iht, idempotencyKey: 'submit-1' });
    await tolakIHT({ nomorDokumen: ' ih-2026-001 ', idempotencyKey: 'submit-2' }, 'DUPLIKAT_DOKUMEN');
    await tolakIHT({ jenis: 'BANK', bankAccountId: 'bank-1' }, 'DUPLIKAT_DOKUMEN');
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(1);
    expect(await hitung(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(1);
  });

  it('dua submit bersamaan dokumen sama → tepat satu posting', async () => {
    await Promise.allSettled([tambahPendapatanInvestasi(iht), tambahPendapatanInvestasi(iht)]);
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(1);
  });

  it('dokumen berbeda → dua transaksi sah', async () => {
    await tambahPendapatanInvestasi(iht);
    await tambahPendapatanInvestasi({ ...iht, nomorDokumen: 'IH-2026-002' });
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(2);
  });

  it('periode CLOSED ditolak tanpa tulisan', async () => {
    await testDb.runAsync(`UPDATE investasi SET tanggal = '2025-01-01' WHERE id = 'inv-kl'`);
    let err: any;
    try {
      await tambahPendapatanInvestasi({ ...iht, tanggal: '2025-06-30' });
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe('ClosedPeriodError');
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(0);
  });

  it('reversal existing: jurnal REVERSED, saldo 4-1700 = 0, riwayat DIKOREKSI, audit REVERSE', async () => {
    const r = await tambahPendapatanInvestasi(iht);
    await koreksiTransaksiPendapatan('KAS', r.id, 'user-1', 'salah nominal');
    const j = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, r.journalId);
    expect(j?.status).toBe('REVERSED');
    const saldo = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(kredit),0) - COALESCE(SUM(debit),0) AS s FROM journal_entry WHERE account_id = ?`, ACC_BAGI_HASIL
    );
    expect(saldo?.s).toBe(0);
    const riw = await listRiwayatPendapatanInvestasi('IMBAL_HASIL_TETAP');
    expect(riw).toHaveLength(1);
    expect(riw[0].status).toBe('DIKOREKSI');
    expect(await hitung(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'REVERSE' AND entity_id = ?`, r.id)).toBe(1);
    // Jurnal pembalik seimbang & koreksi kas tercatat (reversal existing).
    const pembalik = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM journal WHERE reversal_of_id = ?`, r.journalId);
    const sp = await jurnalSeimbang(pembalik!.id);
    expect(sp.d).toBe(sp.k);
    expect(sp.d).toBe(2_500_000);
    expect(await hitung(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE tipe = 'KOREKSI' AND reversal_of_id = ?`, r.id)).toBe(1);
    const semua = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry`);
    expect(semua?.d).toBe(semua?.k);
  });

  it('reversal kedua ditolak (tidak ada pembalik ganda)', async () => {
    const r = await tambahPendapatanInvestasi(iht);
    await koreksiTransaksiPendapatan('KAS', r.id, 'user-1', 'salah');
    let err: unknown;
    try {
      await koreksiTransaksiPendapatan('KAS', r.id, 'user-1', 'lagi');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal WHERE reversal_of_id = ?`, r.journalId)).toBe(1);
  });

  it('audit: createJournal menulis audit untuk jurnal baru', async () => {
    const r = await tambahPendapatanInvestasi(iht);
    expect(await hitung(`SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'journal' AND entity_id = ?`, r.journalId)).toBeGreaterThan(0);
  });

  it('riwayat Imbal Hasil Tetap terpisah dari Bagian SHU & bunga', async () => {
    await tambahPendapatanInvestasi(iht);
    await tambahPendapatanInvestasi({ kategori: 'BUNGA_DEPOSITO', investasiId: 'inv-dep', tanggal: '2026-02-10', nominal: 1_000, jenis: 'KAS', createdBy: 'user-1' });
    expect(await listRiwayatPendapatanInvestasi('IMBAL_HASIL_TETAP')).toHaveLength(1);
    expect(await listRiwayatPendapatanInvestasi('BUNGA_DEPOSITO')).toHaveLength(1);
  });
});

describe('RC-S67.6 — Imbal Hasil Tetap: COA MISSING', () => {
  it('4-1700 tidak ada → ditolak COA_MISSING, akun tidak dibuat otomatis', async () => {
    await fixtureIHT({ tanpaAkun: true });
    const info = await getInfoPendapatanInvestasi('IMBAL_HASIL_TETAP');
    expect(info.akun).toBeNull();
    let err: any;
    try {
      await tambahPendapatanInvestasi(iht);
    } catch (e) {
      err = e;
    }
    expect(err?.kode).toBe('COA_MISSING');
    expect(await hitung(`SELECT COUNT(*) AS n FROM account WHERE kode = '4-1700'`)).toBe(0);
  });
});

describe('RC-S67.6 — menu & form (struktural)', () => {
  const menu = tanpaKomentar(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));
  const form = tanpaKomentar(baca('src/screens/Transaksi/PendapatanInvestasiFormScreen.tsx'));
  const nav = baca('src/navigation/RootNavigator.tsx');

  it('Imbal Hasil Tetap ACTIVE di bawah Penyertaan pada Koperasi Lain; tidak ada leaf nonaktif', () => {
    const iGrup = menu.indexOf("judul: 'Penyertaan pada Koperasi Lain'");
    const iLeaf = menu.indexOf("title: 'Imbal Hasil Tetap'");
    expect(iLeaf).toBeGreaterThan(iGrup);
    expect(menu.indexOf("judul: 'Usaha Lain'")).toBeGreaterThan(iLeaf);
    expect(menu).toContain("aksi: { route: 'PendapatanInvestasiForm', params: { kategori: 'IMBAL_HASIL_TETAP' } }");
    expect(menu).not.toMatch(/nonaktif: \{/);
    expect(menu).not.toContain('LEAF_TIDAK_AKTIF');
  });

  it('menu → tekan → form: leaf dapat ditekan (TouchableOpacity + onPress), rute terdaftar, form menerima kategori', async () => {
    // Leaf ber-aksi dirender sebagai tombol yang memanggil navigate(route, params).
    expect(menu).toMatch(/m\.nonaktif \|\| !m\.aksi \?[\s\S]*?<TouchableOpacity[\s\S]*?onPress=\{\(\) => jalankan\(m\.aksi as Aksi\)\}/);
    expect(menu).toContain('else navigation.navigate(aksi.route, aksi.params);');
    // Form membaca route.params.kategori dan menerima IMBAL_HASIL_TETAP.
    expect(form).toContain('route?.params?.kategori');
    expect(form).toContain('isKategoriPendapatanInvestasi(kategoriParam)');
    // Data yang dimuat form saat dibuka: info akun 4-1700 + dokumen wajib.
    await fixtureIHT();
    const info = await getInfoPendapatanInvestasi('IMBAL_HASIL_TETAP');
    expect(info).toMatchObject({ label: 'Imbal Hasil Tetap', akunKode: '4-1700', wajibDokumen: true, masalah: null });
    expect(await listRiwayatPendapatanInvestasi('IMBAL_HASIL_TETAP')).toEqual([]);
  });

  it('form: rute terdaftar; field nomor dokumen wajib dikirim ke service; investee dari master', () => {
    expect(nav).toMatch(/<TransaksiStack\.Screen name="PendapatanInvestasiForm"/);
    expect(form).toContain('info.wajibDokumen');
    expect(form).toContain('nomorDokumen: info.wajibDokumen ? nomorDokumen : undefined');
    expect(form).toContain('investasi.namaTujuan');
    expect(form).not.toMatch(/JenisHasilDisabledError|BagianShuService/);
  });

  // RC-S67.7: tujuan leaf C diubah menjadi form transaksi PelepasanAsetForm
  // (diuji lengkap di PelepasanAsetFlowRcS67_7). Master Daftar Aset tetap di Laporan.
  it('Penjualan Aset: menu membuka form transaksi PelepasanAsetForm; master Daftar Aset tetap terdaftar di Laporan', () => {
    const i = menu.indexOf("judul: 'Penjualan / Pelepasan Aset'");
    const blok = menu.slice(i, menu.indexOf("judul: 'Pendapatan Lainnya'"));
    expect(blok).toContain("aksi: { route: 'PelepasanAsetForm' }");
    expect(blok).not.toContain('DaftarAsetTetap');
    expect(blok).not.toContain('PendapatanLainnyaForm');
    expect(nav).toMatch(/<LaporanStack\.Screen name="DaftarAsetTetap" component=\{DaftarAsetTetapScreen\} options=\{\{ title: 'Daftar Aset Tetap & Penyusutan' \}\}/);
  });

  it('Daftar Aset: kolom nilai buku, pelepasan hanya aset AKTIF, memakai PelepasanAsetTetapService', () => {
    const layar = tanpaKomentar(baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx'));
    for (const t of ['item.tanggalPerolehan', 'item.akumulasiPenyusutan', 'item.nilaiBuku', "item.status === 'DIHAPUS'"]) {
      expect(layar).toContain(t);
    }
    expect(layar).toMatch(/canEdit && item\.status === 'AKTIF'/);
    expect(layar).toContain('lepaskanAsetTetap(input)');
    expect(layar).toContain('pratinjauPelepasanAsetTetap(input)');
  });
});
