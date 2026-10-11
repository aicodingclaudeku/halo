import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S71 — FULL AUTOMATIC UTANG BUNGA.
 *
 * Akrual bunga utang = infrastruktur akuntansi otomatis: tidak ada menu,
 * tidak ada input nominal, tidak ada pemicu manual. Mesin
 * (UtangBungaAccrualService) dipicu StartupTasks & gerbang PeriodClose lewat
 * gerbang single-flight yang sama. DATABASE = SQLite sungguhan (skema
 * produksi) + AccountingEngine asli.
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
  jalankanAkrualBungaUtangJikaPerlu,
  _resetGerbangAkrualUntukTest,
  getHasilAkrualBungaUtangTerakhir,
  getStatusBungaSemuaUtang,
  ENTITAS_AUDIT_EXCEPTION_AKRUAL,
  KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG,
  periodeTerakhirSelesai,
  idempotencyKeyAkrual,
} from '@/services/UtangBungaAccrualService';
import { terimaUtang, bayarUtang } from '@/services/UtangService';
import { jalankanTugasStartup, _resetTugasStartupUntukTest } from '@/services/StartupTasks';
import { jalankanGerbangAkrualBungaUtang } from '@/services/PeriodCloseService';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { tambahBulan, toPeriode } from '@/accounting/PeriodeUtil';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { SCHEMA_VERSION } from '@/database/schema';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
};

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

beforeEach(async () => {
  _resetGerbangAkrualUntukTest();
  _resetTugasStartupUntukTest();
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(testDb, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);

  for (const th of [2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank A','123','Koperasi',?,1,?)`,
    ACC.bank, now
  );
  // Modal kas awal supaya cek saldo pembayaran lolos.
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES ('j-awal','JRN-SEED','2025-12-31','p2025','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,100000000,0,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,100000000,1)`,
    ACC.utangBank
  );
});

afterEach(() => testDb.closeSync());

async function buatUtang(opts: {
  persen: number;
  basis?: 'TAHUNAN' | 'BULANAN' | null;
  jenisBunga?: 'FLAT' | 'EFEKTIF' | 'LAINNYA';
  tanggal?: string;
  pokok?: number;
}): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: 'Bank ABC',
    jenisPemberi: 'BANK',
    pokokPinjaman: opts.pokok ?? 120_000_000,
    persenBunga: opts.persen,
    jenisBunga: opts.jenisBunga ?? 'FLAT',
    basisBunga: opts.basis ?? null,
    tanggal: opts.tanggal ?? '2026-01-01',
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return r.id;
}

/** Utang WARISAN: ditulis langsung tanpa basis_bunga, meniru baris v<=68. */
async function buatUtangLegacy(persen = 12, jenisBunga = 'FLAT', tanggal = '2026-01-01'): Promise<string> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga,
       jenis_bunga, basis_bunga, tanggal, sumber_dana, sumber, status, created_by, created_at, updated_at)
     VALUES ('utg-legacy','UTG-LEG','Bank Lama','BANK',120000000,?,?,NULL,?,'KAS','LANGSUNG','AKTIF','user-1',?,?)`,
    persen, jenisBunga, tanggal, now, now
  );
  return 'utg-legacy';
}

async function saldo(accountId: string, sisi: 'debit' | 'kredit'): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.${sisi} - je.${sisi === 'debit' ? 'kredit' : 'debit'}),0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return r?.s ?? 0;
}


async function jurnalAkrual(utangId: string) {
  return testDb.getAllAsync<{ id: string; tanggal: string; status: string }>(
    `SELECT id, tanggal, status FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND reversal_of_id IS NULL ORDER BY tanggal`,
    utangId
  );
}
async function subledger(utangId: string) {
  return testDb.getAllAsync<{ periode: string; nominal_dibukukan: number; mode: string }>(
    `SELECT periode, nominal_dibukukan, mode FROM utang_bunga_akrual WHERE utang_id = ? ORDER BY periode`,
    utangId
  );
}
async function totalJurnal(): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi='UTANG_BUNGA'`);
  return r?.n ?? 0;
}

/** Tanggal mulai = hari pertama bulan, `n` bulan sebelum bulan berjalan (tanggal nyata). */
function awalBulanLalu(n: number): string {
  return `${tambahBulan(toPeriode(getTanggalLokalHariIni()), -n)}-01`;
}

// ===========================================================================
// TEST 1 / 4 — Startup otomatis & restart
// ===========================================================================

describe('RC-S71 — eksekusi otomatis lewat StartupTasks', () => {
  it('TEST 1 — startup membuat akrual periode yang sudah selesai, tanpa aksi user', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: awalBulanLalu(3) });
    await jalankanTugasStartup('user-1');
    const j = await jurnalAkrual(id);
    expect(j).toHaveLength(3); // 3 bulan penuh yang sudah berakhir; bulan berjalan belum (WHOLE_MONTH)
    const akhir = periodeTerakhirSelesai(getTanggalLokalHariIni());
    expect((await subledger(id)).map((r) => r.periode)).toEqual([tambahBulan(akhir, -2), tambahBulan(akhir, -1), akhir]);
    expect((await subledger(id)).every((r) => r.mode === 'AUTO')).toBe(true);
    // Hasil mesin terakhir tersedia untuk layar status (tanpa memicu mesin lagi).
    expect(getHasilAkrualBungaUtangTerakhir()?.jumlahJurnalBaru).toBe(3);
  });

  it('TEST 4 — app restart (gerbang in-process dikosongkan) tidak menggandakan', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: awalBulanLalu(4) });
    await jalankanTugasStartup('user-1');
    const pertama = await jurnalAkrual(id);
    // "Tutup aplikasi" = state proses hilang.
    _resetGerbangAkrualUntukTest();
    _resetTugasStartupUntukTest();
    await jalankanTugasStartup('user-1');
    _resetGerbangAkrualUntukTest();
    _resetTugasStartupUntukTest();
    await jalankanTugasStartup('user-1');
    expect(await jurnalAkrual(id)).toEqual(pertama);
    expect(getHasilAkrualBungaUtangTerakhir()?.jumlahJurnalBaru).toBe(0);
  });
});

// ===========================================================================
// TEST 2 / 3 — tidak ada menu, tidak ada input nominal
// ===========================================================================

describe('RC-S71 — tidak ada eksposur user untuk akrual', () => {
  const produksi = (): string[] => {
    const hasil: string[] = [];
    const telusur = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) {
          if (n === '__tests__' || n === 'test-utils') continue;
          telusur(p);
        } else if (/\.(ts|tsx)$/.test(n)) hasil.push(p);
      }
    };
    telusur(join(ROOT, 'src'));
    telusur(join(ROOT, 'app'));
    return hasil;
  };

  it('TEST 2 — tidak ada menu/rute/layar Akrual atau Kontrol Bunga Utang', () => {
    expect(existsSync(join(ROOT, 'src/screens/Transaksi/AkruiBungaUtangFormScreen.tsx'))).toBe(false);
    const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));
    expect(nav).not.toMatch(/AkruiBungaUtang/);
    const hub = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
    // "Akrual" milik Imbalan Kerja sah; yang dilarang adalah akrual/kontrol BUNGA UTANG.
    expect(hub).not.toMatch(/Bunga Utang|Kontrol Bunga|Gap Bunga|Proses Akrual|AkruiBungaUtang/);
    for (const p of produksi()) {
      const s = tanpaKomentar(readFileSync(p, 'utf8'));
      expect(s).not.toMatch(/AkruiBungaUtangForm|Akrual & Kontrol Bunga Utang|Kontrol Gap Bunga|Proses Sekarang/);
    }
  });

  it('TEST 3 — normal flow tanpa input nominal; UI tidak memicu mesin & tidak memakai jalur manual', () => {
    const layar = tanpaKomentar(baca('src/screens/Akuntansi/DaftarUtangScreen.tsx'));
    expect(layar).not.toMatch(/TextInput|FocusTextInput/);
    expect(layar).not.toMatch(/jalankanAkrualBungaUtangJikaPerlu|prosesAkrualBungaUtangOtomatis|akruiBungaUtang|penyesuaianManualBungaUtang/);
    for (const p of produksi()) {
      if (!p.includes('/screens/') && !p.includes('/components/')) continue;
      const s = tanpaKomentar(readFileSync(p, 'utf8'));
      expect(s).not.toMatch(/jalankanAkrualBungaUtangJikaPerlu|prosesAkrualBungaUtangOtomatis|penyesuaianManualBungaUtang|\bakruiBungaUtang\s*\(/);
    }
    // Pemicu mesin: hanya StartupTasks & PeriodClose (dan definisinya sendiri).
    const pemicu = produksi()
      .filter((p) => /\bjalankanAkrualBungaUtangJikaPerlu\s*\(/.test(tanpaKomentar(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(ROOT.length + 1))
      .sort();
    expect(pemicu).toEqual(['src/services/PeriodCloseService.ts', 'src/services/StartupTasks.ts', 'src/services/UtangBungaAccrualService.ts']);
  });

  it('engine/kebijakan tidak berubah: WHOLE_MONTH, idempotensi existing, skema v69', () => {
    expect(KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG).toBe('WHOLE_MONTH');
    expect(idempotencyKeyAkrual('u', '2026-01')).toBe(idempotencyKeyAkrual('u', '2026-01'));
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    expect(existsSync(join(ROOT, 'src/services/UtangBungaAccrualService.ts'))).toBe(true);
  });
});

// ===========================================================================
// TEST 5 / 6 / 12 — multi-utang, legacy, exception
// ===========================================================================

describe('RC-S71 — multi-utang & kontrak tidak lengkap', () => {
  it('TEST 5 / 6 — A,B,D diakru; C (legacy tanpa basis) tidak ditebak dan menjadi exception', async () => {
    const a = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const b = await buatUtang({ persen: 1, basis: 'BULANAN', tanggal: '2026-01-01', pokok: 50_000_000 });
    const c = await buatUtangLegacy(12, 'FLAT', '2026-01-01');
    const d = await buatUtang({ persen: 6, basis: 'TAHUNAN', tanggal: '2026-02-01', pokok: 20_000_000 });

    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-10');
    expect((await subledger(a)).map((r) => r.nominal_dibukukan)).toEqual([1_200_000, 1_200_000]);
    expect((await subledger(b)).map((r) => r.nominal_dibukukan)).toEqual([500_000, 500_000]);
    expect((await subledger(d)).map((r) => r.nominal_dibukukan)).toEqual([100_000]);
    expect(await subledger(c)).toEqual([]);
    expect(await jurnalAkrual(c)).toEqual([]);

    // TEST 12 — exception dapat dilacak: utang, nomor, kode.
    const exC = h.exception.filter((e) => e.utangId === c);
    expect(exC).toHaveLength(1);
    expect(exC[0]).toMatchObject({ nomorUtang: 'UTG-LEG', kode: 'BASIS_BUNGA_BELUM_DITENTUKAN', periode: null });

    const status = await getStatusBungaSemuaUtang('2026-03-10');
    expect(status.get(a)?.status).toBe('TERKENDALI');
    expect(status.get(d)?.status).toBe('TERKENDALI');
    expect(status.get(c)).toMatchObject({ status: 'KONTRAK_BELUM_LENGKAP', bisaLengkapiBasis: true });
    expect(status.get(c)?.pesan).toContain('Lengkapi basis bunga');
  });

  it('jurnal akrual: Dr 5-1950 Beban Bunga / Cr 2-1700 Utang Bunga, sumber UTANG_BUNGA + sumber_id = utang, tanpa kas', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-05');
    const j = await jurnalAkrual(id);
    expect(j).toHaveLength(1);
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, j[0].id
    );
    expect(baris).toEqual([
      { account_id: ACC.bebanBunga, debit: 1_200_000, kredit: 0 },
      { account_id: ACC.utangBunga, debit: 0, kredit: 1_200_000 },
    ]);
    expect(j[0].tanggal).toBe('2026-01-31');
  });

  it('MENUNGGU_PERIODE untuk utang yang bulan pertamanya belum berakhir', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-03-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-20');
    expect(await subledger(id)).toEqual([]);
    expect((await getStatusBungaSemuaUtang('2026-03-20')).get(id)?.status).toBe('MENUNGGU_PERIODE');
  });

  it('TEST 12 — kegagalan teknis dicatat ke audit_log (SYSTEM_EXCEPTION), tanpa jurnal parsial', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type='UTANG_BUNGA' AND role='DEBIT_BEBAN'`);
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-05');
    expect(h.exception.some((e) => e.utangId === id && e.kode === 'KEGAGALAN_TEKNIS')).toBe(true);
    const log = await testDb.getAllAsync<{ action: string; entity_id: string; data_sesudah: string }>(
      `SELECT action, entity_id, data_sesudah FROM audit_log WHERE entity = ?`, ENTITAS_AUDIT_EXCEPTION_AKRUAL
    );
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('SYSTEM_EXCEPTION');
    expect(log[0].entity_id).toBe(id);
    expect(JSON.parse(log[0].data_sesudah)).toMatchObject({ trigger: 'SYSTEM', kode: 'KEGAGALAN_TEKNIS', periode: '2026-01' });
    expect(await jurnalAkrual(id)).toEqual([]);
    expect(await subledger(id)).toEqual([]); // transaksi per periode dibatalkan utuh
    expect((await getStatusBungaSemuaUtang('2026-02-05')).get(id)?.status).toBe('PERLU_PERHATIAN');
  });
});

// ===========================================================================
// TEST 7 / 8 / 9 / 10 / 11
// ===========================================================================

describe('RC-S71 — batas akuntansi', () => {
  it('TEST 7 — periode CLOSED tidak dibypass: tidak ada jurnal di tahun tertutup, exception tercatat', async () => {
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2025'`);
    const id = await buatUtangLegacy(12, 'FLAT', '2025-11-01');
    await testDb.runAsync(`UPDATE utang SET basis_bunga='TAHUNAN' WHERE id=?`, id);
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    const j = await jurnalAkrual(id);
    expect(j.every((x) => x.tanggal >= '2026-01-01')).toBe(true);
    expect(j).toHaveLength(1); // hanya 2026-01
    const tertutup = h.exception.filter((e) => e.utangId === id && e.kode === 'PERIODE_TERTUTUP').map((e) => e.periode);
    expect(tertutup).toEqual(['2025-11', '2025-12']);
    expect((await getStatusBungaSemuaUtang('2026-02-10')).get(id)?.status).toBe('PERLU_PERHATIAN');
  });

  it('TEST 8 — pembayaran bunga setelah akrual: tidak ada beban ganda', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-03');
    await bayarUtang({ utangId: id, tanggal: '2026-02-05', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    _resetGerbangAkrualUntukTest();
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
  });

  it('TEST 9 — akrual yang dibalik tidak diposting ulang; menjadi exception', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-05');
    const [j] = await jurnalAkrual(id);
    await reverseJournal(testDb as any, j.id, 'user-1', 'Koreksi');
    _resetGerbangAkrualUntukTest();
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    expect(h.jumlahJurnalBaru).toBe(0);
    expect(await jurnalAkrual(id)).toHaveLength(1);
    expect(h.exception.some((e) => e.utangId === id && e.kode === 'AKRUAL_DIREVERSAL' && e.periode === '2026-01')).toBe(true);
    expect((await getStatusBungaSemuaUtang('2026-02-10')).get(id)?.status).toBe('PERLU_PERHATIAN');
  });

  it('TEST 10 — Startup lalu gerbang PeriodClose memakai mesin yang sama: nol jurnal tambahan', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: awalBulanLalu(3) });
    await jalankanTugasStartup('user-1');
    const sebelum = await totalJurnal();
    const hari = getTanggalLokalHariIni();
    const g = await jalankanGerbangAkrualBungaUtang({
      periodeMulai: `${hari.slice(0, 4)}-01-01`, periodeSelesai: `${hari.slice(0, 4)}-12-31`, createdBy: 'user-1', tanggalSekarang: hari,
    });
    expect(g.jurnalBaru).toBe(0);
    expect(await totalJurnal()).toBe(sebelum);
    expect(await jurnalAkrual(id)).toHaveLength(3);
  });

  it('TEST 11 — gap nol menghasilkan 0 jurnal baru (dipanggil berkali-kali)', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const h1 = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-06-15');
    expect(h1.jumlahJurnalBaru).toBe(5);
    const n = await totalJurnal();
    for (let i = 0; i < 10; i++) {
      _resetGerbangAkrualUntukTest();
      const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-06-15');
      expect(h.jumlahJurnalBaru).toBe(0);
      expect(h.totalDibukukan).toBe(0);
    }
    expect(await totalJurnal()).toBe(n);
  });
});
