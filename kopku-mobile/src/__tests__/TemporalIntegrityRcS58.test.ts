import { createTestDb, TestDb } from './testDb';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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
  prosesAkrualBungaUtangOtomatis,
  jalankanAkrualBungaUtangJikaPerlu,
  periodeTerakhirSelesai,
  getMonitorAkrualBungaUtang,
  _resetGerbangAkrualUntukTest,
} from '@/services/UtangBungaAccrualService';
import { terimaUtang, bayarUtang, replayBungaUtang, getKontrolGapUtangBunga } from '@/services/UtangService';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { getTrialBalance } from '@/accounting/Ledger';
import { jalankanGerbangAkrualBungaUtang } from '@/services/PeriodCloseService';
import { jalankanTugasStartup, _resetTugasStartupUntukTest } from '@/services/StartupTasks';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * RC-S58 — INTEGRITAS TEMPORAL + GERBANG TUTUP PERIODE.
 *
 * Kontrak baru (Opsi A, "WHOLE_MONTH post-at-end"):
 *   - bulan belum selesai  -> belum ada posting akrual otomatis;
 *   - bulan sudah selesai  -> eligible (termasuk PADA hari terakhirnya);
 *   - bulan lampau          -> catch-up;
 *   - bulan depan           -> tidak pernah;
 *   - tanpa prorata; BULANAN = rate, TAHUNAN = rate/12 (tidak berubah).
 * Invarian inti: TIDAK ADA jurnal UTANG_BUNGA otomatis bertanggal setelah
 * tanggal sekarang mesin.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ACC = { kas: 'acc-kas', utangBank: 'acc-2-2100', utangBunga: 'acc-2-1700', bebanBunga: 'acc-5-1950', modal: 'acc-3-1000' };

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}
async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${tt}-${role}`, tt, role, accountId);
}

async function seedDasar(opts: { mappingBunga?: boolean } = {}) {
  _resetGerbangAkrualUntukTest();
  _resetTugasStartupUntukTest();
  testDb = await createTestDb();
  const now = new Date().toISOString();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  if (opts.mappingBunga !== false) {
    await seedMapping(testDb, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
    await seedMapping(testDb, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);
  }
  for (const th of [2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES ('j-awal','JRN-SEED','2024-12-31','p2025','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,500000000,0,0)`, ACC.kas);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,500000000,1)`, ACC.modal);
}

beforeEach(async () => {
  await seedDasar();
});
afterEach(() => testDb.closeSync());

/** 120.000.000 × 12%/tahun FLAT = 1.200.000 per bulan. */
async function buatUtang(tanggal: string, opts: { basis?: 'TAHUNAN' | 'BULANAN' | null } = {}): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: 'Bank ABC',
    jenisPemberi: 'BANK',
    pokokPinjaman: 120_000_000,
    persenBunga: 12,
    jenisBunga: 'FLAT',
    basisBunga: opts.basis ?? 'TAHUNAN',
    tanggal,
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  if (opts.basis === null) {
    // Simulasi data warisan pra-v69: basis_bunga NULL. terimaUtang() sekarang
    // mewajibkan basis, jadi keadaan ini hanya bisa berasal dari upgrade.
    await testDb.runAsync(`UPDATE utang SET basis_bunga = NULL WHERE id = ?`, r.id);
  }
  return r.id;
}

async function periodeTerposting(utangId?: string): Promise<string[]> {
  const rows = await testDb.getAllAsync<{ p: string }>(
    `SELECT substr(tanggal,1,7) AS p FROM journal
      WHERE sumber_transaksi='UTANG_BUNGA' AND reversal_of_id IS NULL ${utangId ? 'AND sumber_id = ?' : ''}
      ORDER BY tanggal`,
    ...(utangId ? [utangId] : [])
  );
  return rows.map((r) => r.p);
}

/** Query duplikat yang BENAR: per utang + periode (bukan per bulan saja). */
async function duplikatPerUtangPeriode(): Promise<number> {
  const rows = await testDb.getAllAsync(
    `SELECT sumber_id, substr(tanggal,1,7) AS periode, COUNT(*) AS n FROM journal
      WHERE sumber_transaksi='UTANG_BUNGA' AND reversal_of_id IS NULL
      GROUP BY sumber_id, substr(tanggal,1,7) HAVING COUNT(*) > 1`
  );
  return rows.length;
}

async function tanggalJurnalTerakhir(): Promise<string | null> {
  const r = await testDb.getFirstAsync<{ t: string | null }>(`SELECT MAX(tanggal) AS t FROM journal WHERE sumber_transaksi='UTANG_BUNGA'`);
  return r?.t ?? null;
}

async function saldo(accountId: string, sisi: 'debit' | 'kredit', sampai = '9999-12-31'): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.${sisi} - je.${sisi === 'debit' ? 'kredit' : 'debit'}),0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') AND j.tanggal <= ?`,
    accountId,
    sampai
  );
  return r?.s ?? 0;
}

const proses = (tanggalSekarang: string) => prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang });

// ===========================================================================

describe('RC-S58 §2 batas periode selesai', () => {
  it('periodeTerakhirSelesai: bulan dianggap selesai PADA hari terakhirnya', () => {
    expect(periodeTerakhirSelesai('2026-09-19')).toBe('2026-08');
    expect(periodeTerakhirSelesai('2026-09-30')).toBe('2026-09');
    expect(periodeTerakhirSelesai('2026-10-01')).toBe('2026-09');
    expect(periodeTerakhirSelesai('2026-01-15')).toBe('2025-12');
    expect(periodeTerakhirSelesai('2026-02-28')).toBe('2026-02');
    expect(periodeTerakhirSelesai('2028-02-28')).toBe('2028-01'); // kabisat: Feb 2028 berakhir 29
    expect(periodeTerakhirSelesai('2028-02-29')).toBe('2028-02');
    expect(periodeTerakhirSelesai('2026-12-31')).toBe('2026-12');
  });
});

describe('RC-S58 §3 bulan berjalan', () => {
  it('19 Sep: Jul & Agu terposting, Sep BELUM; 30 Sep: Sep boleh; 1 Okt: Sep tepat sekali; rerun 10× tetap satu', async () => {
    const id = await buatUtang('2026-07-01');

    const a = await proses('2026-09-19');
    expect(a.jumlahJurnalBaru).toBe(2);
    expect(await periodeTerposting(id)).toEqual(['2026-07', '2026-08']);
    expect(await tanggalJurnalTerakhir()).toBe('2026-08-31');
    expect((await tanggalJurnalTerakhir())! <= '2026-09-19').toBe(true);

    const b = await proses('2026-09-30');
    expect(b.jumlahJurnalBaru).toBe(1);
    expect(await periodeTerposting(id)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(await tanggalJurnalTerakhir()).toBe('2026-09-30');

    const c = await proses('2026-10-01');
    expect(c.jumlahJurnalBaru).toBe(0);
    for (let i = 0; i < 10; i++) await proses('2026-10-01');
    expect(await periodeTerposting(id)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(await duplikatPerUtangPeriode()).toBe(0);
    const reg = await testDb.getAllAsync(`SELECT periode FROM utang_bunga_akrual WHERE utang_id = ?`, id);
    expect(reg.length).toBe(3);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(3_600_000);
  });

  it('monitor tidak menyebut bulan berjalan sebagai tunggakan', async () => {
    await buatUtang('2026-07-01');
    await proses('2026-09-19');
    const m = await getMonitorAkrualBungaUtang('2026-09-19');
    expect(m.periodeBerjalan).toBe('2026-09');
    expect(m.baris[0].periodeBelumDiproses).toEqual([]);
    const m2 = await getMonitorAkrualBungaUtang('2026-09-30');
    expect(m2.baris[0].periodeBelumDiproses).toEqual(['2026-09']);
  });
});

describe('RC-S58 §4 catch-up', () => {
  it('mulai 1 Mei, dibuka 19 Sep: Mei–Agu diproses; Sep tidak; tidak ada lima akrual sekaligus', async () => {
    const id = await buatUtang('2026-05-01');
    const h = await proses('2026-09-19');
    expect(h.jumlahJurnalBaru).toBe(4);
    expect(await periodeTerposting(id)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
    expect(await tanggalJurnalTerakhir()).toBe('2026-08-31');
  });

  it('banyak utang pada periode yang sama adalah SAH — query duplikat per utang+periode tidak salah lapor', async () => {
    await buatUtang('2026-07-01');
    await buatUtang('2026-07-01');
    await buatUtang('2026-08-01');
    await proses('2026-09-30');
    const perBulan = await testDb.getAllAsync<{ p: string; n: number }>(
      `SELECT substr(tanggal,1,7) AS p, COUNT(*) AS n FROM journal WHERE sumber_transaksi='UTANG_BUNGA' GROUP BY 1 ORDER BY 1`
    );
    // Query LAMA (per bulan saja) akan melaporkan "duplikat" palsu di sini.
    expect(perBulan.some((r) => r.n > 1)).toBe(true);
    expect(await duplikatPerUtangPeriode()).toBe(0);
  });
});

describe('RC-S58 §8/§9 laporan as-of & outstanding', () => {
  it('tidak ada jurnal masa depan: outstanding subledger (tanpa filter tanggal) == saldo GL as-of hari itu', async () => {
    const id = await buatUtang('2026-07-01');
    await proses('2026-09-19');
    const outstanding = (await replayBungaUtang(testDb as any, id)).outstanding;
    const glHariIni = await saldo(ACC.utangBunga, 'kredit', '2026-09-19');
    const glSemua = await saldo(ACC.utangBunga, 'kredit');
    expect(outstanding).toBe(2_400_000);
    expect(glHariIni).toBe(outstanding);
    expect(glSemua).toBe(glHariIni); // tidak ada saldo "kejutan" setelah hari ini
    const tb = await getTrialBalance(testDb as any, '2026-09-19');
    expect(tb.isBalanced).toBe(true);
    const baris = tb.rows.find((r: { accountId?: string; account_id?: string; kode?: string }) =>
      (r.kode ?? '') === '2-1700'
    ) as { saldo?: number; kredit?: number; debit?: number } | undefined;
    if (baris && typeof baris.saldo === 'number') expect(Math.abs(baris.saldo)).toBe(outstanding);
    const kontrol = await getKontrolGapUtangBunga();
    expect(kontrol.status).toBe('BALANCED');
    expect(kontrol.actual).toBe(glHariIni);
  });
});

describe('RC-S58 §10 pembayaran sebelum akhir periode', () => {
  it('bunga Sep dibayar penuh 15 Sep; 30 Sep: akrual tambahan 0; tidak ada beban ganda', async () => {
    const id = await buatUtang('2026-09-01');
    await bayarUtang({ utangId: id, tanggal: '2026-09-15', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000); // belum diakrual -> beban saat bayar
    const sebelum = await proses('2026-09-19');
    expect(sebelum.jumlahJurnalBaru).toBe(0);
    const akhir = await proses('2026-09-30');
    expect(akhir.jumlahJurnalBaru).toBe(0);
    expect(akhir.totalDibukukan).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    await proses('2026-10-01');
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('dibayar sebagian 500.000; 30 Sep: hanya sisa gap 700.000 yang diakru', async () => {
    const id = await buatUtang('2026-09-01');
    await bayarUtang({ utangId: id, tanggal: '2026-09-15', pokok: 0, bunga: 500_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const h = await proses('2026-09-30');
    expect(h.totalDibukukan).toBe(700_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(700_000);
    expect((await replayBungaUtang(testDb as any, id)).outstanding).toBe(700_000);
  });
});

describe('RC-S58 §11 pelunasan tengah bulan (WHOLE_MONTH, tanpa prorata)', () => {
  it('lunas 15 Sep: sebelum akhir bulan 0; 30 Sep satu bulan penuh; setelahnya tetap satu dan Okt tidak diakru', async () => {
    const id = await buatUtang('2026-09-01');
    await bayarUtang({ utangId: id, tanggal: '2026-09-15', pokok: 120_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });
    expect((await proses('2026-09-19')).jumlahJurnalBaru).toBe(0);
    const akhir = await proses('2026-09-30');
    expect(akhir.jumlahJurnalBaru).toBe(1);
    expect(akhir.totalDibukukan).toBe(1_200_000); // bulan penuh, bukan 14/30
    const setelah = await proses('2026-11-05');
    expect(setelah.jumlahJurnalBaru).toBe(0);
    expect(setelah.periodeDiproses.filter((p) => p.hasil === 'LUNAS_SEBELUM_PERIODE').map((p) => p.periode)).toEqual(['2026-10']);
    expect(await periodeTerposting(id)).toEqual(['2026-09']);
  });
});

describe('RC-S58 §5/§6 gerbang tutup periode', () => {
  it('menjalankan mesin sampai akhir tahun lalu mengizinkan bila bersih', async () => {
    const id = await buatUtang('2025-10-01');
    const g = await jalankanGerbangAkrualBungaUtang({ periodeMulai: '2025-01-01', periodeSelesai: '2025-12-31', createdBy: 'user-1', tanggalSekarang: '2026-01-05' });
    expect(g.penghalang).toEqual([]);
    expect(g.statusRekonsiliasi).toBe('BALANCED');
    expect(g.jurnalBaru).toBe(3); // Okt, Nov, Des 2025 — Jan 2026 belum selesai
    expect(await periodeTerposting(id)).toEqual(['2025-10', '2025-11', '2025-12']);
    expect(g.outstandingUtangBunga).toBe(3_600_000);
  });

  it('memblokir: bulan terakhir periode belum berakhir', async () => {
    await buatUtang('2026-07-01');
    const g = await jalankanGerbangAkrualBungaUtang({ periodeMulai: '2026-01-01', periodeSelesai: '2026-12-31', createdBy: 'user-1', tanggalSekarang: '2026-09-19' });
    expect(g.penghalang.map((p) => p.kode)).toContain('PERIODE_BELUM_BERAKHIR');
  });

  it('memblokir: utang MANUAL_REVIEW_REQUIRED yang berjalan dalam periode', async () => {
    await buatUtang('2025-10-01', { basis: null });
    const g = await jalankanGerbangAkrualBungaUtang({ periodeMulai: '2025-01-01', periodeSelesai: '2025-12-31', createdBy: 'user-1', tanggalSekarang: '2026-01-05' });
    expect(g.penghalang.map((p) => p.kode)).toEqual(['BASIS_BUNGA_BELUM_DITENTUKAN']);
  });

  it('memblokir: akrual dalam periode pernah direversal', async () => {
    const id = await buatUtang('2025-10-01');
    await proses('2026-01-05');
    const nov = await testDb.getFirstAsync<{ id: string }>(
      `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND tanggal='2025-11-30' AND reversal_of_id IS NULL`,
      id
    );
    const rev = await reverseJournal(testDb as any, nov!.id, 'user-1', 'Koreksi');
    // DIPERBARUI RC-S58.1: reverseJournal() memberi tanggal HARI INI (jam
    // nyata), yang jatuh SETELAH 2025. Maksud test ini adalah reversal DI
    // DALAM periode yang ditutup, jadi tanggalnya dikunci ke 2025. Reversal
    // SESUDAH periode kini sengaja tidak memblokir (RC-S58.1 kasus D; diuji di
    // PeriodScopedGapRcS58_1 #3).
    await testDb.runAsync(`UPDATE journal SET tanggal = '2025-12-15' WHERE id = ?`, rev.journalId);
    const g = await jalankanGerbangAkrualBungaUtang({ periodeMulai: '2025-01-01', periodeSelesai: '2025-12-31', createdBy: 'user-1', tanggalSekarang: '2026-01-05' });
    const kode = g.penghalang.map((p) => `${p.kode}:${p.periode}`);
    expect(kode).toContain('AKRUAL_DIREVERSAL:2025-11');
    expect(g.jurnalBaru).toBe(0);
  });

  it('tanpa utang berbunga: lolos tanpa membutuhkan mapping akun bunga', async () => {
    testDb.closeSync();
    await seedDasar({ mappingBunga: false });
    const g = await jalankanGerbangAkrualBungaUtang({ periodeMulai: '2025-01-01', periodeSelesai: '2025-12-31', createdBy: 'user-1', tanggalSekarang: '2026-01-05' });
    expect(g).toEqual({ adaUtangBerbunga: false, penghalang: [], statusRekonsiliasi: 'TIDAK_ADA_DATA', outstandingUtangBunga: 0, jurnalBaru: 0 });
  });

  it('tutupPeriode memanggil gerbang SETELAH mutasi & SEBELUM validasi final dan transaksi penutupan', () => {
    const s = tanpaKomentar(baca('src/services/PeriodCloseService.ts'));
    const fn = s.slice(s.indexOf('export async function tutupPeriode('));
    const iGerbang = fn.indexOf('await jalankanGerbangAkrualBungaUtang(');
    const iPenyusutan = fn.indexOf('jalankanPenyusutanOtomatisUntukTahunBuku(');
    const iFinal = fn.indexOf('getRingkasanPenutupanPeriode(');
    const iTx = fn.indexOf('return withTransaction(');
    expect(iGerbang).toBeGreaterThan(iPenyusutan);
    expect(iGerbang).toBeLessThan(iFinal);
    expect(iGerbang).toBeLessThan(iTx);
    expect(fn).toMatch(/if \(gerbangBunga\.penghalang\.length > 0\) \{[\s\S]{0,300}throw new Error/);
  });

  it('gerbang tidak menghitung bunga dan tidak membuat jurnal sendiri', () => {
    const s = tanpaKomentar(baca('src/services/PeriodCloseService.ts'));
    expect(s).not.toMatch(/rateBulanan|hitungNominalBunga|hitungDasarPerhitungan|createJournal|prosesAkrualBungaUtangOtomatis/);
    expect(s).toMatch(/await tungguTugasStartupSelesai\(\);\s*const hasil = await jalankanAkrualBungaUtangJikaPerlu\(/);
  });
});

describe('RC-S58 §7 idempotensi pemicu berdekatan', () => {
  it('startup + gerbang tutup periode + layar kontrol + refresh bersamaan: satu akrual per utang per periode', async () => {
    const id = await buatUtang('2026-07-01');
    await Promise.all([
      jalankanTugasStartup('user-1'),
      jalankanGerbangAkrualBungaUtang({ periodeMulai: '2026-01-01', periodeSelesai: '2026-12-31', createdBy: 'user-1', tanggalSekarang: '2026-10-01' }),
      jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-10-01'),
      jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-10-01'),
    ]);
    await Promise.allSettled([jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-10-01'), jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-10-01')]);
    expect(await duplikatPerUtangPeriode()).toBe(0);
    const p = await periodeTerposting(id);
    for (const x of ['2026-07', '2026-08', '2026-09']) expect(p.filter((y) => y === x).length).toBe(1);
    const reg = await testDb.getAllAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM utang_bunga_akrual WHERE utang_id = ? GROUP BY periode HAVING COUNT(*) > 1`,
      id
    );
    expect(reg.length).toBe(0);
  });
});

describe('RC-S58 §19 audit statis pemanggil', () => {
  const produksi = (): string[] => {
    const hasil: string[] = [];
    const telusur = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
          if (['__tests__', 'test-utils', 'node_modules'].includes(f)) continue;
          telusur(p);
        } else if (/\.(ts|tsx)$/.test(f)) hasil.push(p);
      }
    };
    telusur(join(ROOT, 'src'));
    telusur(join(ROOT, 'app'));
    return hasil;
  };
  const pemakai = (pola: RegExp) =>
    produksi()
      .filter((p) => pola.test(tanpaKomentar(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(ROOT.length + 1))
      .sort();

  // DIPERBARUI RC-S71: layar kontrol dihapus — pemanggil tinggal StartupTasks & gerbang tutup periode.
  it('pemanggil mesin: tepat StartupTasks, gerbang tutup periode — tanpa dashboard, tanpa layar, tanpa caller mati', () => {
    expect(pemakai(/\bjalankanAkrualBungaUtangJikaPerlu\b/)).toEqual(
      [
        'src/services/PeriodCloseService.ts',
        'src/services/StartupTasks.ts',
        'src/services/UtangBungaAccrualService.ts',
      ].sort()
    );
    expect(pemakai(/\bprosesAkrualBungaUtangOtomatis\b/)).toEqual(['src/services/UtangBungaAccrualService.ts']);
    expect(tanpaKomentar(baca('src/screens/Dashboard/DashboardScreen.tsx'))).not.toMatch(/UtangBungaAccrual|AkrualBunga/);
    // Gerbang tutup periode punya pemanggil nyata (bukan dead code).
    expect(pemakai(/\bjalankanGerbangAkrualBungaUtang\s*\(/)).toEqual(['src/services/PeriodCloseService.ts']);
  });

  it('tidak ada timer di mesin, gerbang, dan pemicu', () => {
    for (const f of [
      'src/services/UtangBungaAccrualService.ts',
      'src/services/PeriodCloseService.ts',
      'src/services/StartupTasks.ts',
      // DIPERBARUI RC-S71: layar akrual dihapus; layar status (Daftar Utang) ikut diperiksa.
      'src/screens/Akuntansi/DaftarUtangScreen.tsx',
    ]) {
      expect(tanpaKomentar(baca(f))).not.toMatch(/setInterval|setTimeout|defineTask/);
    }
  });

  it('mesin memakai batas periode selesai, bukan bulan berjalan', () => {
    const s = tanpaKomentar(baca('src/services/UtangBungaAccrualService.ts'));
    expect(s).toMatch(/const periodeSelesai = periodeTerakhirSelesai\(tanggalSekarang\);/);
    expect(s).toMatch(/daftarPeriodeKandidat\(kontrak\.tanggalMulai, periodeSelesai\)/);
    expect(s).not.toMatch(/daftarPeriodeKandidat\(kontrak\.tanggalMulai, (periodeSekarang|toPeriode\(tanggalSekarang\))\)/);
  });

  it('checklist device QA memakai query duplikat per utang + periode, bukan per bulan saja', () => {
    const d = baca('RC-S58_DEVICE_QA_CHECKLIST.md');
    expect(d).toMatch(/GROUP BY sumber_id, substr\(tanggal, ?1, ?7\)/);
    expect(d).not.toMatch(/GROUP BY 1 HAVING/);
    expect(d).toMatch(/DEVICE VALIDATION REQUIRED/);
    for (const s of ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.', 'H.', 'I.']) expect(d).toContain(`### ${s}`);
  });

  it('tidak ada kenaikan skema di RC-S58', () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });
});
