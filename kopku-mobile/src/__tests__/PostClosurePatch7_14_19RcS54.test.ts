import { readFileSync } from 'fs';
import { join } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, seedJurnal, snapshotTabel, accId, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

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

const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const SEMUA_TABEL = ['account', 'account_mapping', 'journal', 'journal_entry', 'investasi', 'investasi_penyusutan', 'investasi_impairment', 'aset_tetap', 'aset_penyusutan', 'utang', 'utang_pembayaran', 'rak_transaksi', 'audit_log', 'accounting_period'];

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

import { CASH_FLOW_CLASSIFICATION, classifyTransactionSource, classifyTransaction, NonCashSourceOnCashLineError } from '@/accounting/CashFlowClassification';
import { getArusKas } from '@/reports/FinancialReports';
import { catatInvestasi, batalkanInvestasi } from '@/services/InvestasiService';
import { reverseJournal } from '@/accounting/AccountingEngine';

import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { KODE_COA_DIMINTA_ITEM_14, cariKonflikKodeAkun } from '@/config/coaPolicyRegistry';
import { SCHEMA_VERSION } from '@/database/schema';
import { runMigrations } from '@/database/db';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { listRAK, catatRAK, batalkanRAK } from '@/services/RAKService';
import { getPosisiKeuangan } from '@/reports/FinancialReports';

/**
 * RC-S54 POST-CLOSURE PATCH — requirement #7, #14, #19.
 * Renderer RN tidak tersedia: bagian UI dikunci sebagai KONTRAK STATIK (sumber layar/menu),
 * bagian akuntansi dikunci lewat database SQLite nyata.
 */

const KODE_DIMINTA_12: [string, string, string, string][] = [
  ['1-660', 'Tanah Properti Investasi', 'ASET', 'DEBIT'],
  ['1-661', 'Bangunan Properti Investasi', 'ASET', 'DEBIT'],
  ['1-220', 'Piutang Pendapatan Investasi', 'ASET', 'DEBIT'],
  ['1-230', 'Piutang Dividen', 'ASET', 'DEBIT'],
  ['1-240', 'Piutang Bagi Hasil', 'ASET', 'DEBIT'],
  ['1-250', 'Piutang Pendapatan Sewa', 'ASET', 'DEBIT'],
  ['4-1510', 'Pendapatan Bunga Deposito', 'PENDAPATAN', 'KREDIT'],
  ['4-1520', 'Pendapatan Bunga Investasi', 'PENDAPATAN', 'KREDIT'],
  ['4-1530', 'Pendapatan Dividen', 'PENDAPATAN', 'KREDIT'],
  ['4-1540', 'Pendapatan Jasa (Bagian SHU)', 'PENDAPATAN', 'KREDIT'],
  ['4-2100', 'Keuntungan Perubahan Nilai Wajar Properti Investasi', 'PENDAPATAN', 'KREDIT'],
  ['5-5000', 'Kerugian Nilai Wajar Properti Investasi', 'BEBAN', 'DEBIT'],
];

describe('#7 — Daftar Aset Tetap & Penyusutan digabung', () => {
  const menu = strip(baca('src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx'));
  const layar = strip(baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx'));
  const navigator = strip(baca('src/navigation/RootNavigator.tsx'));

  it('menu Rincian Laporan Lainnya hanya punya SATU entry aset tetap, dan itu entry gabungan', () => {
    const route = [...menu.matchAll(/route: '([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(route.filter((r) => r === 'DaftarAsetTetap')).toHaveLength(1);
    expect(route).not.toContain('StatusPeriode');
    expect(route).not.toContain('PenyusutanList');
    expect(menu).toContain("title: 'Daftar Aset Tetap & Penyusutan'");
    expect(menu).toMatch(/sub: '[^']*penyusutan[^']*'/i);
    // Hanya satu entry aset tetap di seluruh menu (tidak ada judul aset tetap kedua).
    const judul = [...menu.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
    expect(judul.filter((t) => /aset tetap/i.test(t))).toHaveLength(1);
  });

  it('layar gabungan memakai service existing untuk daftar aset DAN ringkasan penyusutan; tanpa engine baru', () => {
    expect(layar).toMatch(/await Promise\.all\(\[listAsetDenganNilaiBuku\(\), listRingkasanPenyusutanAset\(\)\]\)/);
    expect(layar).toMatch(/<RingkasanPenyusutanAsetList data=\{ringkasanPenyusutan\}/);
    for (const label of ['Nomor Aset', 'Tanggal Perolehan', 'Total Nilai Perolehan', 'Total Akumulasi Penyusutan/Amortisasi', 'Total Nilai Buku', 'Ringkasan Penyusutan Aset', 'Proses Penyusutan']) {
      expect(layar).toContain(label);
    }
    // Tidak ada perhitungan penyusutan lokal di layar.
    expect(layar).not.toMatch(/garisLurus|nilai_penyusutan\s*=|akumulasi\s*\+=|masaManfaatBulan\s*\//);
  });

  it('rute StatusPeriode & PenyusutanList tidak broken: StatusPeriode tetap terdaftar dan dijangkau dari layar gabungan', () => {
    expect(navigator).toMatch(/name="StatusPeriode"/);
    expect(navigator).toMatch(/name="DaftarAsetTetap"/);
    expect(layar).toMatch(/navigation\.navigate\('StatusPeriode'\)/);
    // PenyusutanList memang sudah dilepas sejak RC-S50; tidak ada yang menavigasinya.
    expect(navigator).not.toMatch(/name="PenyusutanList"/);
    const semuaLayar = ['src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx', 'src/screens/Akuntansi/DaftarAsetTetapScreen.tsx', 'src/screens/Akuntansi/StatusPeriodeScreen.tsx']
      .map((f) => baca(f)).join('\n');
    expect(semuaLayar).not.toMatch(/navigate\('PenyusutanList'\)/);
  });

  it('DB: data penyusutan & akumulasi tidak berubah oleh penggabungan UI (service yang sama)', async () => {
    const { beliAset, listAsetDenganNilaiBuku } = await import('@/services/AsetService');
    const { prosesPenyusutanAset, listRingkasanPenyusutanAset } = await import('@/services/PenyusutanService');
    const a = await beliAset({ namaAset: 'Mobil', nilaiPerolehan: 120_000_000, nilaiResidu: 0, masaManfaatBulan: 12, tanggal: '2026-01-05', tanggalPerolehan: '2026-01-05', metodePembayaran: 'TUNAI', sumberDana: 'KAS', createdBy: USER } as never);
    const id = (a as { id: string }).id;
    await prosesPenyusutanAset({ asetId: id, periode: '2026-01', createdBy: USER });
    const daftar = await listAsetDenganNilaiBuku();
    const ringkasan = await listRingkasanPenyusutanAset();
    expect(daftar.find((x) => x.id === id)).toMatchObject({ akumulasiPenyusutan: 10_000_000, nilaiBuku: 110_000_000 });
    expect(ringkasan.find((x) => x.asetId === id || (x as { id?: string }).id === id)).toBeDefined();
    const p = await getPosisiKeuangan(testDb as never, '2026-12-31');
    expect(p.aset.find((r) => r.kode === '1-1510')?.saldo).toBe(-10_000_000);
  });
});

describe('#14 — 12 COA dengan kode persis', () => {
  it('ke-12 kode tersedia dengan nama & klasifikasi yang diminta, tanpa duplikat kode', () => {
    for (const [kode, nama, kategori, normalBalance] of KODE_DIMINTA_12) {
      const akun = DEFAULT_ACCOUNTS.filter((a) => a.kode === kode);
      expect(akun).toHaveLength(1);
      expect(akun[0]).toMatchObject({ nama, kategori, normalBalance });
    }
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    expect(new Set(kode).size).toBe(kode.length);
    expect(KODE_COA_DIMINTA_ITEM_14.every((e) => e.keputusan === 'DITAMBAHKAN')).toBe(true);
    for (const [k] of KODE_DIMINTA_12) expect(cariKonflikKodeAkun(k)).toBeNull();
  });

  it('DEFINED / NOT ACTIVELY POSTED: tidak ada mapping ke 12 kode; policy final RC-S54 tidak berubah', () => {
    // DIPERBARUI RC-S88: 4-2100/5-5000 kini dipetakan model nilai wajar properti investasi (SAK EP 16);
    // sepuluh kode lainnya tetap tanpa mapping.
    for (const [k] of KODE_DIMINTA_12) {
      const mp = DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === k).map((m) => m.transactionType);
      expect(mp).toEqual(k === '4-2100' || k === '5-5000' ? ['NILAI_WAJAR_PROPERTI_INVESTASI'] : []);
    }
    const m = (t: string, r: string) => DEFAULT_ACCOUNT_MAPPING.filter((x) => x.transactionType === t && x.role === r).map((x) => x.accountKode);
    expect(m('BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN')).toEqual(['4-1300']);
    expect(m('BAGIAN_SHU_INVESTASI', 'DEBIT_PIUTANG')).toEqual(['1-1220']);
    expect(m('INVESTASI_PROPERTI_INVESTASI', 'DEBIT_ASET')).toEqual(['1-1660']);
    expect(m('PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI')).toEqual(['1-1670']);
    expect(m('PELEPASAN_INVESTASI', 'DEBIT_RUGI')).toEqual(['5-2160']);
    expect(m('PELEPASAN_ASET_TETAP', 'DEBIT_RUGI')).toEqual(['5-2170']);
    expect(DEFAULT_ACCOUNT_MAPPING.filter((x) => /NILAI_WAJAR/.test(x.transactionType)).map((x) => x.accountKode).sort()).toEqual(
      ['1-1665', '4-2100', '5-5000']
    );
  });

  it('DB: ke-12 akun ter-resolve; resolver mapping existing tidak berubah; jurnal historis utuh', async () => {
    await seedJurnal(testDb, 'j-lama', '2026-02-01', 'BAGIAN_SHU_INVESTASI', [['1-1220', 1_000_000, 0], ['4-1300', 0, 1_000_000]]);
    const jurnalAwal = JSON.stringify(await snapshotTabel(testDb, ['journal', 'journal_entry']));
    for (const [kode, nama] of KODE_DIMINTA_12) {
      const akun = await testDb.getAllAsync<{ id: string; nama: string; is_active: number }>(`SELECT id, nama, is_active FROM account WHERE kode = ?`, kode);
      expect(akun).toHaveLength(1);
      expect(akun[0]).toMatchObject({ nama, is_active: 1 });
    }
    expect(await resolveAccountId(testDb as never, 'BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN')).toBe(accId('4-1300'));
    expect(JSON.stringify(await snapshotTabel(testDb, ['journal', 'journal_entry']))).toBe(jurnalAwal);
  });

  it('DB: self-heal v67 -> v68 menambahkan tepat 12 akun, idempoten, tanpa menimpa akun/mapping kustom', async () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    // DIPERBARUI RC-S88: mapping nilai wajar yang menunjuk 4-2100/5-5000 dilepas dulu (FK),
    // lalu ikut dipulihkan self-heal bersama akunnya.
    for (const [k] of KODE_DIMINTA_12) {
      await testDb.runAsync(`DELETE FROM account_mapping WHERE account_id IN (SELECT id FROM account WHERE kode = ?)`, k);
      await testDb.runAsync(`DELETE FROM account WHERE kode = ?`, k);
    }
    await testDb.runAsync(`UPDATE account SET nama = 'Nama Kustom Pengguna' WHERE kode = '4-1300'`);
    await testDb.runAsync(`UPDATE account_mapping SET account_id = ? WHERE transaction_type = 'BAGIAN_SHU_INVESTASI' AND role = 'KREDIT_PENDAPATAN'`, accId('4-1500'));
    await testDb.execAsync(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`);
    await testDb.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 67)`);
    const sebelum = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM account`))!.n;

    await runMigrations(testDb as never);
    const sesudahSatu = JSON.stringify(await snapshotTabel(testDb, ['account', 'account_mapping']));
    await runMigrations(testDb as never);
    expect(JSON.stringify(await snapshotTabel(testDb, ['account', 'account_mapping']))).toBe(sesudahSatu);

    const sesudah = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM account`))!.n;
    expect(sesudah - sebelum).toBe(12);
    for (const [kode, nama] of KODE_DIMINTA_12) {
      expect(await testDb.getAllAsync(`SELECT kode FROM account WHERE kode = ? AND nama = ?`, kode, nama)).toHaveLength(1);
    }
    expect((await testDb.getFirstAsync<{ nama: string }>(`SELECT nama FROM account WHERE kode = '4-1300'`))!.nama).toBe('Nama Kustom Pengguna');
    const kustom = await testDb.getFirstAsync<{ kode: string }>(
      `SELECT a.kode FROM account_mapping m JOIN account a ON a.id = m.account_id WHERE m.transaction_type = 'BAGIAN_SHU_INVESTASI' AND m.role = 'KREDIT_PENDAPATAN'`
    );
    expect(kustom!.kode).toBe('4-1500');
    // RC-S55: runMigrations kini menaikkan schema_meta ke v69 (automatic
    // accrual bunga utang). Yang diuji test ini tidak berubah — self-heal COA
    // tetap menyisipkan tepat 12 akun, idempoten, tanpa menimpa akun/mapping
    // kustom (asersi di atas). Hanya versi akhirnya yang bergeser.
    // DIPERBARUI RESTRUKTURISASI DATA: v70 (asal personel) — migrasi MILIK
    // restrukturisasi Data/Personel, bukan tahap ini. Sesuai catatan di atas,
    // yang bergeser hanya versi AKHIR; asersi "tepat 12 akun, idempoten,
    // tanpa menimpa kustom" di atas tidak berubah.
    expect((await testDb.getFirstAsync<{ version: number }>(`SELECT version FROM schema_meta`))!.version).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel .version).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI v73 (RC-S88 nilai wajar/revaluasi) — hanya versi akhir yang bergeser · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });
});

describe('#19 — Tarik Dana RAK hilang dari Rincian Laporan Lainnya', () => {
  const rakList = strip(baca('src/screens/Akuntansi/RAKListScreen.tsx'));

  it('layar RAK di laporan tidak lagi punya aksi/modal Tarik Dana RAK', () => {
    expect(rakList).not.toMatch(/Tarik Dana RAK/);
    expect(rakList).not.toMatch(/batalkanRAK/);
    expect(rakList).not.toMatch(/<Modal/);
  });

  it('service, data, dan jalur akuntansi RAK TIDAK dihapus', async () => {
    const svc = baca('src/services/RAKService.ts');
    for (const f of ['export async function catatRAK', 'export async function batalkanRAK', 'export async function editRAK', 'kelayakanTarikDanaRAK']) {
      expect(svc).toContain(f);
    }
    expect(baca('src/services/HistoryTransaksiService.ts')).toContain('batalkanRAK');
    // RAKU di Transaksi > Pengeluaran tetap ada.
    const pengeluaran = strip(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
    expect(pengeluaran).toMatch(/RAKForm|RAKU|Rekening Antar Kantor/);
  });

  it('DB: pencatatan RAK & pembatalannya lewat service tetap berfungsi penuh', async () => {
    const rak = await catatRAK({ jenisRak: 'PENYALURAN_DANA', namaUnit: 'Unit A', jumlah: 5_000_000, tanggal: '2026-03-01', sumberDana: 'KAS', createdBy: USER } as never);
    const daftar = await listRAK();
    expect(daftar.find((r) => r.id === rak.id)).toMatchObject({ status: 'AKTIF' });
    await batalkanRAK(rak.id, USER, 'uji layanan tetap ada');
    expect((await listRAK()).find((r) => r.id === rak.id)!.status).toBe('DIBATALKAN');
  });
});
