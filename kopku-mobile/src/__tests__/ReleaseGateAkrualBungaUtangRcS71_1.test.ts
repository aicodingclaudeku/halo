import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S71.1 — FINAL RUNTIME & ACCOUNTING INTEGRITY VERIFICATION (release gate).
 *
 * BUKAN pengembangan fitur. Suite ini hanya MEMBUKTIKAN perilaku mesin akrual
 * bunga utang yang sudah ada (RC-S55..RC-S71) terhadap matriks uji RC-S71.1
 * §33 [01]..[19]. [20] (TypeScript) dijalankan di luar Jest (`npx tsc --noEmit`).
 *
 * DATABASE: SQLite sungguhan (sql.js, skema produksi `CREATE_TABLES_SQL`) +
 * AccountingEngine asli. Tidak ada mock pada service akuntansi.
 *
 * Nilai-nilai GOLDEN di [01]/formula dihitung dari kontrak (pokok x rate / 12),
 * bukan disalin dari output mesin.
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
  getStatusBungaSemuaUtang,
  KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG,
  LABEL_STATUS_BUNGA_UTANG,
  hitungNominalBunga,
  rateBulanan,
  periodePertamaEligible,
  periodeTerakhirSelesai,
  daftarPeriodeKandidat,
  idempotencyKeyAkrual,
} from '@/services/UtangBungaAccrualService';
import {
  terimaUtang,
  bayarUtang,
  akruiBungaUtang,
  lengkapiBasisBungaUtang,
  getKontrolGapUtangBunga,
  getGapAkrualBungaUtang,
} from '@/services/UtangService';
import { jalankanTugasStartup, _resetTugasStartupUntukTest } from '@/services/StartupTasks';
import { jalankanGerbangAkrualBungaUtang, tutupPeriode } from '@/services/PeriodCloseService';
import { reverseJournal, createJournal } from '@/accounting/AccountingEngine';
import { getTrialBalance, getLedger } from '@/accounting/Ledger';
import { getLabaRugi, getLHU, getPosisiKeuangan, getInformasiShuRAT } from '@/reports/FinancialReports';
import { tambahBulan, toPeriode, tanggalAkhirPeriode } from '@/accounting/PeriodeUtil';
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
  modal: 'acc-3-1000',
};

/**
 * DIPERBARUI RC-S79 §4: PeriodClose kini mewajibkan rekonsiliasi untuk
 * PERIODE yang ditutup pada setiap rekening kas/bank aktif. Fixture ini
 * tidak pernah merekonsiliasi apa pun, sehingga gerbang rekonsiliasi
 * menyala lebih dulu dan menutupi gerbang akrual bunga yang justru
 * diuji di sini. Helper ini memenuhi syarat rekonsiliasi (COCOK +
 * SELESAI) agar gerbang yang diuji tetap gerbang akrual.
 */
async function rekonsiliasiBeres(db: TestDb, periodeSelesai: string) {
  const now = new Date().toISOString();
  for (const [i, acc] of [ACC.kas, ACC.bank].entries()) {
    await db.runAsync(
      `INSERT INTO rekonsiliasi_kas_bank
        (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
         status_penyelesaian, created_by, created_at)
       VALUES (?,?,?,?,0,0,0,'COCOK','SELESAI',?,?)`,
      `rek-gate-${i}`, acc, acc === ACC.kas ? 'Kas' : 'Bank A', periodeSelesai, 'user-1', now
    );
  }
}

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
  await seedAccount(testDb, ACC.modal, '3-1000', 'Modal', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(testDb, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);

  for (const th of [2024, 2025, 2026, 2027]) {
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
  // Modal kas awal (Dr Kas / Cr Modal) supaya cek saldo pembayaran lolos.
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES ('j-awal','JRN-SEED','2024-12-31','p2024','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,100000000,0,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,100000000,1)`,
    ACC.modal
  );
});

afterEach(() => testDb.closeSync());

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

async function buatUtang(opts: {
  persen: number;
  basis?: 'TAHUNAN' | 'BULANAN' | null;
  jenisBunga?: 'FLAT' | 'EFEKTIF' | 'LAINNYA';
  tanggal?: string;
  pokok?: number;
  nama?: string;
}): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: opts.nama ?? 'Bank ABC',
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

/** Utang WARISAN (v<=68): basis_bunga NULL, ditulis langsung. */
async function buatUtangLegacy(id = 'utg-legacy', tanggal = '2026-01-01', jenisBunga = 'FLAT'): Promise<string> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga,
       jenis_bunga, basis_bunga, tanggal, sumber_dana, sumber, status, created_by, created_at, updated_at)
     VALUES (?,?,'Bank Lama','BANK',120000000,12,?,NULL,?,'KAS','LANGSUNG','AKTIF','user-1',?,?)`,
    id, `UTG-${id}`, jenisBunga, tanggal, now, now
  );
  return id;
}

async function jurnalAkrual(utangId: string) {
  return testDb.getAllAsync<{ id: string; tanggal: string; status: string; deskripsi: string; created_by: string }>(
    `SELECT id, tanggal, status, deskripsi, created_by FROM journal
      WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND reversal_of_id IS NULL ORDER BY tanggal, id`,
    utangId
  );
}

async function subledger(utangId: string) {
  return testDb.getAllAsync<{
    periode: string; nominal_target: number; nominal_dibukukan: number; mode: string;
    journal_id: string | null; idempotency_key: string; tanggal_jurnal: string;
  }>(
    `SELECT periode, nominal_target, nominal_dibukukan, mode, journal_id, idempotency_key, tanggal_jurnal
       FROM utang_bunga_akrual WHERE utang_id = ? ORDER BY periode`,
    utangId
  );
}

async function totalJurnalUtangBunga(): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi='UTANG_BUNGA'`);
  return r?.n ?? 0;
}

/** Saldo akun sesuai sisi normal (debit-normal: D-K, kredit-normal: K-D). */
async function saldo(accountId: string, sisi: 'debit' | 'kredit', sampai?: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.${sisi} - je.${sisi === 'debit' ? 'kredit' : 'debit'}),0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') ${sampai ? 'AND j.tanggal <= ?' : ''}`,
    accountId, ...(sampai ? [sampai] : [])
  );
  return r?.s ?? 0;
}

async function barisJurnal(journalId: string) {
  return testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
    `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC, account_id`,
    journalId
  );
}

/** Simulasi "aplikasi ditutup": seluruh state in-process hilang. */
function restartAplikasi() {
  _resetGerbangAkrualUntukTest();
  _resetTugasStartupUntukTest();
}

function awalBulanLalu(n: number): string {
  return `${tambahBulan(toPeriode(getTanggalLokalHariIni()), -n)}-01`;
}

const produksi = (): string[] => {
  const hasil: string[] = [];
  const telusur = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        if (n === '__tests__' || n === 'test-utils' || n === 'node_modules') continue;
        telusur(p);
      } else if (/\.(ts|tsx)$/.test(n)) hasil.push(p);
    }
  };
  telusur(join(ROOT, 'src'));
  telusur(join(ROOT, 'app'));
  return hasil;
};

// ===========================================================================
// [01] BASIC ACCRUAL + FORMULA / WHOLE_MONTH UNCHANGED
// ===========================================================================

describe('RC-S71.1 [01] basic accrual, formula & WHOLE_MONTH', () => {
  it('[01] akrual dasar: 1 periode selesai -> 1 jurnal, nilai sesuai kontrak (120jt x 12%/12)', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    expect(h.jumlahJurnalBaru).toBe(1);
    expect(h.totalDibukukan).toBe(1_200_000);
    const sl = await subledger(id);
    expect(sl).toHaveLength(1);
    expect(sl[0]).toMatchObject({ periode: '2026-01', nominal_target: 1_200_000, nominal_dibukukan: 1_200_000, mode: 'AUTO', tanggal_jurnal: '2026-01-31' });
  });

  it('formula GOLDEN tidak berubah (input sama + policy sama = hasil sama)', () => {
    // Dihitung manual dari kontrak, bukan disalin dari mesin.
    expect(hitungNominalBunga(120_000_000, rateBulanan(12, 'TAHUNAN'))).toBe(1_200_000);
    expect(hitungNominalBunga(50_000_000, rateBulanan(1, 'BULANAN'))).toBe(500_000);
    expect(hitungNominalBunga(20_000_000, rateBulanan(6, 'TAHUNAN'))).toBe(100_000);
    // 10.000.001 x 7% / 12 = 58.333,3391... -> ROUND_HALF_UP -> 58.333
    expect(hitungNominalBunga(10_000_001, rateBulanan(7, 'TAHUNAN'))).toBe(58_333);
    // 1.000.000 x 1,5% / 12 = 1.250 (tepat)
    expect(hitungNominalBunga(1_000_000, rateBulanan(1.5, 'TAHUNAN'))).toBe(1_250);
    expect(hitungNominalBunga(0, rateBulanan(12, 'TAHUNAN'))).toBe(0);
    expect(rateBulanan(12, 'TAHUNAN')).toBeCloseTo(0.01, 12);
    expect(rateBulanan(1, 'BULANAN')).toBeCloseTo(0.01, 12);
  });

  it('EFEKTIF: dasar = outstanding awal periode; angsuran tengah bulan tidak diprorata (WHOLE_MONTH)', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', jenisBunga: 'EFEKTIF', pokok: 100_000_000, tanggal: '2026-01-01' });
    await bayarUtang({ utangId: id, tanggal: '2026-01-20', pokok: 10_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-05');
    // Jan: dasar 100jt -> 1.000.000 ; Feb: dasar 90jt -> 900.000
    expect((await subledger(id)).map((r) => [r.periode, r.nominal_dibukukan])).toEqual([
      ['2026-01', 1_000_000],
      ['2026-02', 900_000],
    ]);
  });

  it('WHOLE_MONTH: kebijakan tetap; mulai tengah bulan -> bulan pertama tidak diakru; bulan berjalan tidak diposting', async () => {
    expect(KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG).toBe('WHOLE_MONTH');
    expect(periodePertamaEligible('2026-01-01')).toBe('2026-01');
    expect(periodePertamaEligible('2026-01-15')).toBe('2026-02');
    expect(periodeTerakhirSelesai('2026-03-30')).toBe('2026-02');
    expect(periodeTerakhirSelesai('2026-03-31')).toBe('2026-03');

    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-15' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-20');
    // Jan tidak utuh -> tidak diakru (tidak ada prorata harian); Mar belum selesai.
    const sl = await subledger(id);
    expect(sl.map((r) => r.periode)).toEqual(['2026-02']);
    expect(sl[0].nominal_dibukukan).toBe(1_200_000); // bulan penuh, bukan harian
    // Tidak ada day-count convention di mesin.
    const mesin = tanpaKomentar(baca('src/services/UtangBungaAccrualService.ts'));
    expect(mesin).not.toMatch(/\/\s*365|\/\s*360|ACTUAL_DAY|DAILY|30\/360/);
  });
});

// ===========================================================================
// [02][03] GAP CONTROL, [17-spec] DUPLICATE DETECTION
// ===========================================================================

describe('RC-S71.1 [02][03] gap control & duplicate detection', () => {
  it('[02] GAP = 0: periode sudah diakui penuh -> tidak ada jurnal baru', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    // Sudah diakui lewat jalur internal (akrual penuh) sebelum mesin berjalan.
    await akruiBungaUtang({ utangId: id, tanggal: '2026-01-31', nominal: 1_200_000, createdBy: 'user-1' });
    const n = await totalJurnalUtangBunga();
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    expect(h.jumlahJurnalBaru).toBe(0);
    expect(h.periodeDiproses.find((p) => p.periode === '2026-01')?.hasil).toBe('TIDAK_ADA_GAP');
    expect(await totalJurnalUtangBunga()).toBe(n);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('[03] GAP > 0: hanya SELISIH yang valid yang diposting', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-01-31', nominal: 400_000, createdBy: 'user-1' });
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    expect(h.jumlahJurnalBaru).toBe(1);
    expect(h.totalDibukukan).toBe(800_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000); // tepat 1x bunga periode
    expect((await getGapAkrualBungaUtang(id, '2026-01', 1_200_000)).sisaGap).toBe(0);
    expect((await getKontrolGapUtangBunga()).status).toBe('BALANCED');
  });

  it('[03b] GAP < 0 (sudah diakui MELEBIHI target): tidak ada posting spekulatif (tidak ada jurnal, tidak ada pembalik otomatis)', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-01-31', nominal: 1_500_000, createdBy: 'user-1' });
    const n = await totalJurnalUtangBunga();
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    expect(h.jumlahJurnalBaru).toBe(0);
    expect(await totalJurnalUtangBunga()).toBe(n);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_500_000); // tidak diubah mesin
    const gap = await getGapAkrualBungaUtang(id, '2026-01', 1_200_000);
    expect(gap.melebihiTarget).toBe(true);
    expect(gap.sisaGap).toBe(0);
  });

  it('[03c] anomali beban ganda (akrual + dibebankan saat bayar, periode sama) -> ACCOUNTING EXCEPTION yang memblokir PeriodClose', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2025-01-01' });
    // Pola historis pra-RC-S54: bayar bunga Jan tanpa akrual (-> beban), LALU
    // jurnal akrual Jan dibuat langsung tanpa gap control.
    await bayarUtang({ utangId: id, tanggal: '2025-01-20', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await testDb.withTransactionAsync(async () => {
      await createJournal(testDb as any, {
        tanggal: '2025-01-31',
        sumberTransaksi: 'UTANG_BUNGA',
        sumberId: id,
        nomorReferensi: 'AKB-LEGACY',
        deskripsi: 'Akrual lama tanpa gap control',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.bebanBunga, debit: 1_200_000, kredit: 0 },
          { accountId: ACC.utangBunga, debit: 0, kredit: 1_200_000 },
        ],
      });
    });
    const g = await jalankanGerbangAkrualBungaUtang({
      periodeMulai: '2025-01-01', periodeSelesai: '2025-12-31', createdBy: 'user-1', tanggalSekarang: '2026-02-10',
    });
    expect(g.statusRekonsiliasi).toBe('GAP');
    expect(g.penghalang.some((p) => p.kode === 'REKONSILIASI_UTANG_BUNGA_GAP')).toBe(true);
    const kontrol = await getKontrolGapUtangBunga();
    expect(kontrol.temuan.some((t) => t.kode === 'DUPLICATE_INTEREST_EXPENSE' && t.periode === '2025-01')).toBe(true);
    // Mesin tidak "memperbaiki" sendiri: tidak ada jurnal koreksi otomatis.
    expect((await jurnalAkrual(id)).filter((j) => j.tanggal === '2025-01-31')).toHaveLength(1);
  });

  it('[17-spec] duplicate detection: jurnal existing + permintaan akrual yang sama -> SKIP', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    const sebelum = await jurnalAkrual(id);
    // Jalur internal lama dengan target yang sama -> gap 0 -> tidak ada jurnal.
    const r = await akruiBungaUtang({ utangId: id, tanggal: '2026-01-31', nominal: 1_200_000, createdBy: 'user-1' });
    expect(r.journalId).toBeNull();
    expect(r.dibukukanSekarang).toBe(0);
    // UNIQUE (utang, periode, tipe) menolak baris subledger kedua di level DB.
    await expect(
      testDb.runAsync(
        `INSERT INTO utang_bunga_akrual
          (id, utang_id, periode, tipe_akrual, mode, basis_bunga, jenis_bunga, persen_bunga,
           dasar_perhitungan, nominal_target, nominal_dibukukan, tanggal_jurnal, journal_id,
           idempotency_key, keterangan, created_by, created_at)
         VALUES ('dup',?,'2026-01','BUNGA_BULANAN','AUTO','TAHUNAN','FLAT',12,120000000,1200000,0,'2026-01-31',NULL,?,NULL,'user-1',?)`,
        id, idempotencyKeyAkrual(id, '2026-01'), new Date().toISOString()
      )
    ).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await jurnalAkrual(id)).toEqual(sebelum);
  });
});

// ===========================================================================
// [04] DUPLICATE EXECUTION, [05] CONCURRENT, [06] RESTART
// ===========================================================================

describe('RC-S71.1 [04][05][06] idempotency, single-flight, restart', () => {
  it('[04] 1x / 2x / 10x / 100x -> tetap 1 jurnal per periode eligible', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const hitung: number[] = [];
    let run = 0;
    for (const target of [1, 2, 10, 100]) {
      while (run < target) {
        _resetGerbangAkrualUntukTest(); // tiap run = eksekusi independen, bukan hasil cache
        await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
        run++;
      }
      hitung.push((await jurnalAkrual(id)).length);
    }
    expect(hitung).toEqual([1, 1, 1, 1]);
    expect(await subledger(id)).toHaveLength(1);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('[05] eksekusi BERSAMAAN (engine x3) berbagi SATU eksekusi', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const p1 = jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-04-10');
    const p2 = jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-04-10');
    const p3 = jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-04-10');
    const [h1, h2, h3] = await Promise.all([p1, p2, p3]);
    // `jalankanAkrualBungaUtangJikaPerlu` adalah fungsi async, jadi tiap panggilan
    // membungkus promise baru; bukti SATU eksekusi adalah objek HASIL yang identik
    // (satu run `prosesAkrualBungaUtangOtomatis` dipakai ulang oleh ketiganya).
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
    expect(h1.jumlahJurnalBaru).toBe(3);
    expect(await jurnalAkrual(id)).toHaveLength(3);
  });

  it('[05] Startup + PeriodClose BERSAMAAN -> satu pengakuan per periode (mesin yang sama)', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: awalBulanLalu(3) });
    const hari = getTanggalLokalHariIni();
    const [, g] = await Promise.all([
      jalankanTugasStartup('user-1'),
      jalankanGerbangAkrualBungaUtang({
        periodeMulai: `${hari.slice(0, 4)}-01-01`, periodeSelesai: `${hari.slice(0, 4)}-12-31`,
        createdBy: 'user-1', tanggalSekarang: hari,
      }),
    ]);
    const j = await jurnalAkrual(id);
    expect(j).toHaveLength(3);
    expect(new Set(j.map((x) => x.tanggal)).size).toBe(3); // 1 jurnal per periode
    expect(await subledger(id)).toHaveLength(3);
    // Gerbang menunggu rantai startup, lalu memanggil mesin yang sama: 0 jurnal tambahan.
    expect(g.jurnalBaru).toBe(0);
  });

  it('[06] App Start -> Accrual -> Close -> Start -> Accrual: tidak ada jurnal ganda', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: awalBulanLalu(2) });
    await jalankanTugasStartup('user-1');
    const pertama = await jurnalAkrual(id);
    expect(pertama).toHaveLength(2);
    for (let i = 0; i < 3; i++) {
      restartAplikasi();
      await jalankanTugasStartup('user-1');
    }
    expect(await jurnalAkrual(id)).toEqual(pertama);
    expect(await subledger(id)).toHaveLength(2);
  });
});

// ===========================================================================
// [07] LATE OPENING, [08] MULTIPLE DEBTS, [09] LEGACY
// ===========================================================================

describe('RC-S71.1 [07][08][09] late opening, multi-debt, legacy contract', () => {
  it('[07] aplikasi tidak dibuka Jan-Mar, dibuka April -> Jan, Feb, Mar diposting di periodenya masing-masing', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-04-08');
    expect(h.jumlahJurnalBaru).toBe(3);
    const j = await jurnalAkrual(id);
    expect(j.map((x) => x.tanggal)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    // April (bulan berjalan) BELUM diposting.
    expect(j.some((x) => x.tanggal >= '2026-04-01')).toBe(false);
    // Tiap jurnal masuk ke bulan yang benar di buku besar.
    expect(await saldo(ACC.bebanBunga, 'debit', '2026-01-31')).toBe(1_200_000);
    expect(await saldo(ACC.bebanBunga, 'debit', '2026-02-28')).toBe(2_400_000);
    expect(await saldo(ACC.bebanBunga, 'debit', '2026-03-31')).toBe(3_600_000);
    expect(daftarPeriodeKandidat('2026-01-01', periodeTerakhirSelesai('2026-04-08'))).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('[08] banyak utang: masing-masing diakru sesuai kontraknya sendiri, sumber_id terpisah', async () => {
    const a = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01', nama: 'Bank A' });
    const b = await buatUtang({ persen: 1, basis: 'BULANAN', tanggal: '2026-01-01', pokok: 50_000_000, nama: 'Bank B' });
    const c = await buatUtang({ persen: 6, basis: 'TAHUNAN', tanggal: '2026-02-01', pokok: 20_000_000, nama: 'Bank C' });
    const d = await buatUtang({ persen: 12, basis: 'TAHUNAN', jenisBunga: 'EFEKTIF', tanggal: '2026-01-01', pokok: 100_000_000, nama: 'Bank D' });
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-10');
    expect((await subledger(a)).map((r) => r.nominal_dibukukan)).toEqual([1_200_000, 1_200_000]);
    expect((await subledger(b)).map((r) => r.nominal_dibukukan)).toEqual([500_000, 500_000]);
    expect((await subledger(c)).map((r) => r.nominal_dibukukan)).toEqual([100_000]);
    expect((await subledger(d)).map((r) => r.nominal_dibukukan)).toEqual([1_000_000, 1_000_000]);
    expect(h.jumlahJurnalBaru).toBe(7);
    expect(h.totalDibukukan).toBe(2_400_000 + 1_000_000 + 100_000 + 2_000_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(h.totalDibukukan);
  });

  it('[09] basis_bunga NULL -> CONTRACT_INCOMPLETE, TIDAK ditebak (tidak ada jurnal & subledger)', async () => {
    const leg = await buatUtangLegacy();
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-05-10');
    expect(await jurnalAkrual(leg)).toEqual([]);
    expect(await subledger(leg)).toEqual([]);
    expect(h.exception.filter((e) => e.utangId === leg).map((e) => e.kode)).toEqual(['BASIS_BUNGA_BELUM_DITENTUKAN']);
    const st = (await getStatusBungaSemuaUtang('2026-05-10')).get(leg)!;
    expect(st.status).toBe('KONTRAK_BELUM_LENGKAP');
    expect(st.bisaLengkapiBasis).toBe(true);
    expect(st.pesan).toBe('Kontrak bunga belum lengkap. Lengkapi basis bunga untuk mengaktifkan perhitungan otomatis.');
    expect(LABEL_STATUS_BUNGA_UTANG[st.status]).toBe('Kontrak Belum Lengkap');
  });

  it('[09] jenis bunga LAINNYA juga tidak ditebak; tidak ditawarkan melengkapi basis', async () => {
    const leg = await buatUtangLegacy('utg-lain', '2026-01-01', 'LAINNYA');
    await testDb.runAsync(`UPDATE utang SET basis_bunga='TAHUNAN' WHERE id=?`, leg);
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-05-10');
    expect(await jurnalAkrual(leg)).toEqual([]);
    expect(h.exception.find((e) => e.utangId === leg)?.kode).toBe('JENIS_BUNGA_LAINNYA');
    const st = (await getStatusBungaSemuaUtang('2026-05-10')).get(leg)!;
    expect(st).toMatchObject({ status: 'KONTRAK_BELUM_LENGKAP', bisaLengkapiBasis: false });
  });

  it('[09] setelah kontrak dilengkapi (SAVE) -> mesin mengevaluasi otomatis lewat rantai startup yang sama', async () => {
    const leg = await buatUtangLegacy('utg-leg2', '2026-01-01');
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-10');
    expect(await jurnalAkrual(leg)).toEqual([]);
    await lengkapiBasisBungaUtang({ utangId: leg, basisBunga: 'TAHUNAN', createdBy: 'user-1' });
    // Melengkapi kontrak TIDAK membuat jurnal apa pun.
    expect(await jurnalAkrual(leg)).toEqual([]);
    _resetGerbangAkrualUntukTest();
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-10');
    expect((await subledger(leg)).map((r) => [r.periode, r.nominal_dibukukan])).toEqual([
      ['2026-01', 1_200_000],
      ['2026-02', 1_200_000],
    ]);
  });
});

// ===========================================================================
// [10] CLOSED PERIOD, [11] PERIODCLOSE
// ===========================================================================

describe('RC-S71.1 [10][11] closed period & PeriodClose', () => {
  it('[10] periode CLOSED: missing accrual TIDAK diposting langsung; menjadi exception; createJournal juga menolak', async () => {
    const leg = await buatUtangLegacy('utg-closed', '2025-11-01');
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2025'`);
    await lengkapiBasisBungaUtang({ utangId: leg, basisBunga: 'TAHUNAN', createdBy: 'user-1' });
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
    const j = await jurnalAkrual(leg);
    expect(j.every((x) => x.tanggal >= '2026-01-01')).toBe(true);
    expect(j.map((x) => x.tanggal)).toEqual(['2026-01-31']);
    expect(h.exception.filter((e) => e.utangId === leg && e.kode === 'PERIODE_TERTUTUP').map((e) => e.periode)).toEqual([
      '2025-11',
      '2025-12',
    ]);
    // Subledger periode tertutup TIDAK ditulis (tidak ada identitas yatim).
    expect((await subledger(leg)).map((r) => r.periode)).toEqual(['2026-01']);
    // Lapis kedua: AccountingEngine sendiri menolak posting ke periode CLOSED.
    await expect(
      testDb.withTransactionAsync(async () => {
        await createJournal(testDb as any, {
          tanggal: '2025-12-31', sumberTransaksi: 'UTANG_BUNGA', sumberId: leg, nomorReferensi: 'X',
          deskripsi: 'bypass', createdBy: 'user-1',
          lines: [
            { accountId: ACC.bebanBunga, debit: 1, kredit: 0 },
            { accountId: ACC.utangBunga, debit: 0, kredit: 1 },
          ],
        });
      })
    ).rejects.toThrow();
    expect((await getStatusBungaSemuaUtang('2026-02-10')).get(leg)?.status).toBe('PERLU_PERHATIAN');
  });

  it('[11] urutan PeriodClose: AUTO ACCRUAL -> RECONCILIATION -> EXCEPTION CHECK; hasil BALANCED tanpa aksi user', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2025-01-01' });
    // Aplikasi tidak pernah dibuka: belum ada akrual 2025 sama sekali.
    expect(await jurnalAkrual(id)).toEqual([]);
    const g = await jalankanGerbangAkrualBungaUtang({
      periodeMulai: '2025-01-01', periodeSelesai: '2025-12-31', createdBy: 'user-1', tanggalSekarang: '2026-01-15',
    });
    // Mesin berjalan DULU (12 jurnal 2025), baru rekonsiliasi as-of menilai hasilnya.
    expect(g.jurnalBaru).toBe(12);
    expect(g.statusRekonsiliasi).toBe('BALANCED');
    expect(g.outstandingUtangBunga).toBe(14_400_000);
    expect(g.penghalang).toEqual([]);
  });

  it('[11] PeriodClose DIBLOKIR dengan alasan jelas bila kontrak belum lengkap — tanpa menyuruh membuka menu akrual', async () => {
    await buatUtangLegacy('utg-pc', '2025-01-01');
    const { simpanRAT } = await import('@/services/RATService');
    await simpanRAT({ tahunBuku: 2025, tanggalRat: '2026-03-01', createdBy: 'user-1' });
    let pesan = '';
    try {
      await rekonsiliasiBeres(testDb, '2025-12-31');
      await tutupPeriode({ periodeId: 'p2025', createdBy: 'user-1' });
    } catch (e) {
      pesan = e instanceof Error ? e.message : String(e);
    }
    expect(pesan).toMatch(/Periode belum bisa ditutup — akrual bunga utang belum tuntas/);
    expect(pesan).toMatch(/Basis bunga belum ditentukan/);
    expect(pesan).not.toMatch(/menu|Akrual & Kontrol|Kontrol Bunga Utang|AkruiBungaUtang/i);
    const st = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM accounting_period WHERE id='p2025'`);
    expect(st?.status).toBe('OPEN');
  });

  it('[11] PeriodClose BERHASIL end-to-end setelah mesin membukukan seluruh periode (tanpa menu/aksi manual)', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2025-01-01' });
    const { simpanRAT } = await import('@/services/RATService');
    await simpanRAT({ tahunBuku: 2025, tanggalRat: '2026-03-01', createdBy: 'user-1' });
    await rekonsiliasiBeres(testDb, '2025-12-31');
    const r = await tutupPeriode({ periodeId: 'p2025', createdBy: 'user-1' });
    expect(r.ditutup).toBe(true);
    const j2025 = (await jurnalAkrual(id)).filter((x) => x.tanggal <= '2025-12-31');
    expect(j2025).toHaveLength(12);
    const st = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM accounting_period WHERE id='p2025'`);
    expect(st?.status).toBe('CLOSED');
  });
});

// ===========================================================================
// [12] REVERSAL, [13] PAYMENT, [14] PAYMENT + UNRECOGNIZED
// ===========================================================================

describe('RC-S71.1 [12][13][14] reversal & payment', () => {
  it('[12] Accrual -> Reversal -> re-run (berulang): tidak ada duplikat yang tidak diinginkan; semantik RC-S56 tetap', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-05');
    const [j] = await jurnalAkrual(id);
    await reverseJournal(testDb as any, j.id, 'user-1', 'Koreksi kontrak');
    for (let i = 0; i < 5; i++) {
      _resetGerbangAkrualUntukTest();
      const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-10');
      expect(h.jumlahJurnalBaru).toBe(0);
      expect(h.exception.some((e) => e.kode === 'AKRUAL_DIREVERSAL' && e.periode === '2026-01')).toBe(true);
    }
    expect(await jurnalAkrual(id)).toHaveLength(1);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(0); // akrual + pembalik = 0
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    // Periode berikutnya tetap berjalan normal (reversal hanya menyangkut 2026-01).
    _resetGerbangAkrualUntukTest();
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-05');
    expect((await subledger(id)).map((r) => r.periode)).toEqual(['2026-01', '2026-02']);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('[13] bayar bunga yang sudah diakui: Dr 2-1700 / Cr Kas, TANPA beban baru', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-03');
    const r = await bayarUtang({ utangId: id, tanggal: '2026-02-05', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const jb = await testDb.getFirstAsync<{ journal_id: string }>(`SELECT journal_id FROM utang_pembayaran WHERE utang_id = ?`, id);
    expect(r).toBeTruthy();
    expect(await barisJurnal(jb!.journal_id)).toEqual([
      { account_id: ACC.utangBunga, debit: 1_200_000, kredit: 0 },
      { account_id: ACC.kas, debit: 0, kredit: 1_200_000 },
    ]);
    _resetGerbangAkrualUntukTest();
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-20');
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000); // tidak ada double expense
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    expect((await getKontrolGapUtangBunga()).status).toBe('BALANCED');
  });

  it('[14] bayar bunga melebihi yang diakui: recognized + newly recognized = total bunga yang benar (tidak diakui dua kali)', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-02-03'); // Jan diakui 1,2jt
    // 5 Feb: bayar bunga Jan + Feb (2,4jt). Feb belum diakui.
    await bayarUtang({ utangId: id, tanggal: '2026-02-05', pokok: 0, bunga: 2_400_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const jb = await testDb.getFirstAsync<{ journal_id: string }>(`SELECT journal_id FROM utang_pembayaran WHERE utang_id = ?`, id);
    expect(await barisJurnal(jb!.journal_id)).toEqual([
      // urutan helper: debit DESC lalu account_id
      { account_id: ACC.utangBunga, debit: 1_200_000, kredit: 0 }, // pelunasan Jan yang sudah diakui
      { account_id: ACC.bebanBunga, debit: 1_200_000, kredit: 0 }, // Feb: baru diakui saat bayar
      { account_id: ACC.kas, debit: 0, kredit: 2_400_000 },
    ]);
    // Akhir Feb: mesin melihat Feb sudah diakui saat bayar -> tidak ada jurnal baru.
    _resetGerbangAkrualUntukTest();
    const h = await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-03-05');
    expect(h.jumlahJurnalBaru).toBe(0);
    expect(h.periodeDiproses.find((p) => p.periode === '2026-02')?.hasil).toBe('TIDAK_ADA_GAP');
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(2_400_000); // 2 bulan x 1,2jt, tepat
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    expect((await getKontrolGapUtangBunga()).status).toBe('BALANCED');
  });
});

// ===========================================================================
// [15] JOURNAL SOURCE, [16] SUBLEDGER = GL
// ===========================================================================

describe('RC-S71.1 [15][16] journal source & subledger reconciliation', () => {
  it('[15] jurnal akrual: Dr 5-1950 / Cr 2-1700, source=UTANG_BUNGA, sourceId=utangId, mode AUTO, tanpa kas', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-04-05');
    const j = await jurnalAkrual(id);
    expect(j).toHaveLength(3);
    for (const x of j) {
      const src = await testDb.getFirstAsync<{ sumber_transaksi: string; sumber_id: string; status: string }>(
        `SELECT sumber_transaksi, sumber_id, status FROM journal WHERE id = ?`, x.id
      );
      expect(src).toEqual({ sumber_transaksi: 'UTANG_BUNGA', sumber_id: id, status: 'POSTED' });
      expect(x.deskripsi).toMatch(/\(otomatis\)/);
      const baris = await barisJurnal(x.id);
      expect(baris).toEqual([
        { account_id: ACC.bebanBunga, debit: 1_200_000, kredit: 0 },
        { account_id: ACC.utangBunga, debit: 0, kredit: 1_200_000 },
      ]);
      // Tidak pernah menyentuh Kas/Bank; tidak pernah Cr Beban Bunga.
      expect(baris.some((b) => b.account_id === ACC.kas || b.account_id === ACC.bank)).toBe(false);
      expect(baris.some((b) => b.account_id === ACC.bebanBunga && b.kredit > 0)).toBe(false);
    }
    // Cr Utang Bunga tepat SEKALI per periode.
    const perPeriode = await testDb.getAllAsync<{ p: string; n: number }>(
      `SELECT substr(j.tanggal,1,7) p, COUNT(*) n FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND je.kredit > 0 AND j.sumber_transaksi='UTANG_BUNGA' AND j.sumber_id = ? GROUP BY p`,
      ACC.utangBunga, id
    );
    expect(perPeriode.every((r) => r.n === 1)).toBe(true);
    // Metadata trigger ekuivalen: subledger mode AUTO + kunci idempotensi deterministik.
    for (const s of await subledger(id)) {
      expect(s.mode).toBe('AUTO');
      expect(s.idempotency_key).toBe(`UTANG_BUNGA:${id}:${s.periode}:BUNGA_BULANAN`);
    }
  });

  it('[16] expectedAccrual = recognizedAccrual = journalAmount per periode; Σ subledger = GL 2-1700', async () => {
    const a = await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const b = await buatUtang({ persen: 1, basis: 'BULANAN', tanggal: '2026-02-01', pokok: 50_000_000, nama: 'Bank B' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-05-02');
    for (const id of [a, b]) {
      for (const s of await subledger(id)) {
        const jumlahJurnal = (await barisJurnal(s.journal_id!)).find((x) => x.account_id === ACC.utangBunga)!.kredit;
        expect(s.nominal_target).toBe(s.nominal_dibukukan); // expected = recognized
        expect(s.nominal_dibukukan).toBe(jumlahJurnal); // recognized = journal
      }
    }
    const sigmaSub = await testDb.getFirstAsync<{ s: number }>(`SELECT SUM(nominal_dibukukan) s FROM utang_bunga_akrual`);
    expect(sigmaSub?.s).toBe(await saldo(ACC.utangBunga, 'kredit'));
    expect(sigmaSub?.s).toBe(4 * 1_200_000 + 3 * 500_000);
    const kontrol = await getKontrolGapUtangBunga();
    expect(kontrol).toMatchObject({ status: 'BALANCED', gap: 0, expected: kontrol.actual });
  });
});

// ===========================================================================
// [17] SHU REGRESSION, [18] FINANCIAL REPORTS
// ===========================================================================

describe('RC-S71.1 [17][18] SHU & financial report regression', () => {
  async function seedPendapatan(tanggal: string, nominal: number) {
    await seedAccount(testDb, 'acc-4-1000', '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT').catch(() => undefined);
    await testDb.withTransactionAsync(async () => {
      await createJournal(testDb as any, {
        tanggal, sumberTransaksi: 'JURNAL_UMUM', nomorReferensi: 'PDP', deskripsi: 'Pendapatan', createdBy: 'user-1',
        lines: [
          { accountId: ACC.kas, debit: nominal, kredit: 0 },
          { accountId: 'acc-4-1000', debit: 0, kredit: nominal },
        ],
      });
    });
  }

  it('[17] SHU akrual turun TEPAT sebesar beban bunga akrual; SHU basis kas tidak terpengaruh akrual non-kas', async () => {
    await seedPendapatan('2026-01-15', 10_000_000);
    await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const sebelum = await getLabaRugi(testDb as any, '2026-01-01', '2026-03-31');
    const shuRatSebelum = await getInformasiShuRAT(testDb as any, '2026-01-01', '2026-03-31');
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-04-02');
    const sesudah = await getLabaRugi(testDb as any, '2026-01-01', '2026-03-31');
    const shuRatSesudah = await getInformasiShuRAT(testDb as any, '2026-01-01', '2026-03-31');
    expect(sebelum.hasilUsaha - sesudah.hasilUsaha).toBe(3_600_000);
    expect(shuRatSesudah.shuLaporanKeuanganAkrual).toBe(sesudah.hasilUsaha);
    expect(shuRatSesudah.shuInformasiRat).toBe(shuRatSebelum.shuInformasiRat); // akrual bukan kas
    expect(shuRatSesudah.bebanAkrualBelumKas - shuRatSebelum.bebanAkrualBelumKas).toBe(3_600_000);
    const lhu = await getLHU(testDb as any, '2026-01-01', '2026-03-31');
    expect(lhu.shuNeto).toBe(sesudah.hasilUsaha);
  });

  it('[18] Jurnal Umum, Buku Besar, Neraca Saldo, LHU, Posisi Keuangan: 5-1950 & 2-1700 pada periode yang benar', async () => {
    await buatUtang({ persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-04-02');

    // Jurnal Umum: 3 jurnal akrual bertanggal akhir bulan masing-masing.
    const ju = await testDb.getAllAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND status='POSTED' ORDER BY tanggal`
    );
    expect(ju.map((x) => x.tanggal)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);

    // Buku Besar 5-1950 & 2-1700.
    const bbBeban = await getLedger(testDb as any, ACC.bebanBunga);
    expect(bbBeban.map((l: any) => [l.tanggal, l.debit])).toEqual([
      ['2026-01-31', 1_200_000],
      ['2026-02-28', 1_200_000],
      ['2026-03-31', 1_200_000],
    ]);
    const bbUtangBunga = await getLedger(testDb as any, ACC.utangBunga);
    expect(bbUtangBunga.map((l: any) => l.kredit)).toEqual([1_200_000, 1_200_000, 1_200_000]);

    // Neraca Saldo per akhir Feb: hanya Jan+Feb.
    const tb = await getTrialBalance(testDb as any, '2026-02-28');
    expect(tb.isBalanced).toBe(true);
    const rowBeban = tb.rows.find((r: any) => r.accountId === ACC.bebanBunga || r.kode === '5-1950') as any;
    const rowUB = tb.rows.find((r: any) => r.accountId === ACC.utangBunga || r.kode === '2-1700') as any;
    expect(rowBeban).toBeTruthy();
    expect(rowUB).toBeTruthy();
    expect(JSON.stringify(rowBeban)).toContain('2400000');
    expect(JSON.stringify(rowUB)).toContain('2400000');

    // LHU per kuartal: beban bunga 3,6jt masuk periode Jan-Mar, bukan April.
    const lr = await getLabaRugi(testDb as any, '2026-01-01', '2026-03-31');
    expect(lr.totalBeban).toBe(3_600_000);
    expect((await getLabaRugi(testDb as any, '2026-04-01', '2026-04-30')).totalBeban).toBe(0);

    // Posisi Keuangan: Utang Bunga 3,6jt sebagai liabilitas, seimbang.
    const pk = await getPosisiKeuangan(testDb as any, '2026-03-31');
    expect(pk.isBalanced).toBe(true);
    expect(JSON.stringify(pk.liabilitas)).toContain('3600000');
  });
});

// ===========================================================================
// [19] NO USER-FACING ACCRUAL ROUTE / MANUAL WORKFLOW
// ===========================================================================

describe('RC-S71.1 [19] tidak ada rute/menu/workflow akrual manual', () => {
  const TERLARANG = /AkruiBungaUtangForm|AkruiBungaUtangFormScreen|Akrual Bunga Utang|Akrual & Kontrol Bunga Utang|Kontrol Bunga Utang|Gap Bunga|Proses Akrual|Proses Sekarang/;

  it('[19] navigation/screens/components/app: tidak ada rute, layar, tombol, atau label akrual bunga utang', () => {
    expect(existsSync(join(ROOT, 'src/screens/Transaksi/AkruiBungaUtangFormScreen.tsx'))).toBe(false);
    for (const p of produksi()) {
      if (!/\/(navigation|screens|components)\//.test(p) && !p.includes(`${join(ROOT, 'app')}`)) continue;
      const s = tanpaKomentar(readFileSync(p, 'utf8'));
      expect({ file: p.slice(ROOT.length + 1), hit: TERLARANG.test(s) }).toEqual({ file: p.slice(ROOT.length + 1), hit: false });
    }
  });

  it('[19] UI tidak memanggil mesin / jalur manual; pemicu mesin hanya StartupTasks & PeriodClose', () => {
    for (const p of produksi()) {
      if (!/\/(navigation|screens|components|hooks|store)\//.test(p) && !p.includes(join(ROOT, 'app'))) continue;
      const s = tanpaKomentar(readFileSync(p, 'utf8'));
      expect({ f: p.slice(ROOT.length + 1), hit: /prosesAkrualBungaUtangOtomatis|jalankanAkrualBungaUtangJikaPerlu|penyesuaianManualBungaUtang|\bakruiBungaUtang\s*\(/.test(s) })
        .toEqual({ f: p.slice(ROOT.length + 1), hit: false });
    }
    const pemanggilAkrui = produksi()
      .filter((p) => /\bakruiBungaUtang\s*\(/.test(tanpaKomentar(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(ROOT.length + 1));
    // Hanya definisi + pembungkus internal penyesuaianManualBungaUtang (service layer).
    expect(pemanggilAkrui).toEqual(['src/services/UtangService.ts']);
    const pemicu = produksi()
      .filter((p) => /\bjalankanAkrualBungaUtangJikaPerlu\s*\(/.test(tanpaKomentar(readFileSync(p, 'utf8'))))
      .map((p) => p.slice(ROOT.length + 1))
      .sort();
    expect(pemicu).toEqual(['src/services/PeriodCloseService.ts', 'src/services/StartupTasks.ts', 'src/services/UtangBungaAccrualService.ts']);
    // Satu mesin saja: tidak ada INSERT subledger akrual di luar mesin.
    const penulisSubledger = produksi()
      .filter((p) => /INSERT INTO utang_bunga_akrual/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(ROOT.length + 1));
    expect(penulisSubledger).toEqual(['src/services/UtangBungaAccrualService.ts']);
  });

  it('[19] Daftar Utang READ STATUS saja: tanpa input nominal; status sederhana tanpa istilah teknis', () => {
    const layar = tanpaKomentar(baca('src/screens/Akuntansi/DaftarUtangScreen.tsx'));
    expect(layar).not.toMatch(/TextInput|FocusTextInput|hitungNominalBunga|createJournal/);
    expect(layar).not.toMatch(/idempotency|gapControl|singleFlight|journalSource|sisaGap|subledger/i);
    expect(Object.values(LABEL_STATUS_BUNGA_UTANG)).toEqual(['Terkendali', 'Menunggu Periode', 'Kontrak Belum Lengkap', 'Perlu Perhatian']);
  });

  it('[19] tidak ada migrasi baru: skema tetap v69', () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });
});

// Sanity: helper tanggal yang dipakai suite ini konsisten dengan PeriodeUtil.
it('helper: tanggalAkhirPeriode Feb 2026 = 2026-02-28', () => {
  expect(tanggalAkhirPeriode('2026-02')).toBe('2026-02-28');
});
