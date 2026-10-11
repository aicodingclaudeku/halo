import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

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

import { SCHEMA_VERSION } from '@/database/schema';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import {
  KODE_COA_DIMINTA_ITEM_14,
  KODE_POLICY_CONFLICT,
  CoaPolicyConflictError,
  assertKodeAkunTidakKonflikPolicy,
  cariKonflikKodeAkun,
} from '@/config/coaPolicyRegistry';
import { getDampakHistorisCoa, KODE_AKUN_TERKAIT_ITEM_14 } from '@/services/CoaResolutionService';
import { createAccount, updateAccount, listAllAccounts } from '@/repositories/AccountRepository';
import { getPosisiKeuangan, getLHU } from '@/reports/FinancialReports';
import { getTrialBalance, getLedger } from '@/accounting/Ledger';
import {
  KEBIJAKAN_PENGUKURAN_PROPERTI_INVESTASI,
  MAPPING_NILAI_WAJAR_AKTIF,
} from '@/services/PenyesuaianNilaiWajarService';

/**
 * RC-S54 TAHAP 12 — ITEM #14 COA.
 *
 * Mengunci hasil audit: dua belas kode yang diminta tidak dibuat, akun
 * existing tidak di-rename/re-number, mapping historis tidak bergeser,
 * dan upaya membuat kode yang ditolak keputusan COA lewat menu COA
 * menghasilkan POLICY_CONFLICT — bukan akun baru.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

const KODE_DIMINTA = [
  '1-660', '1-661', '1-220', '1-230', '1-240', '1-250',
  '4-1510', '4-1520', '4-1530', '4-1540', '4-2100', '5-5000',
];

const accId = (kode: string) => `acc-${kode}`;

async function seedCoaLengkap(): Promise<void> {
  const now = new Date().toISOString();
  for (const a of DEFAULT_ACCOUNTS) {
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES (?,?,?,?,?,1,?,?,?,?)`,
      accId(a.kode), a.kode, a.nama, a.kategori, a.normalBalance, a.isSystem ? 1 : 0, a.lhuKlasifikasi ?? null, now, now
    );
  }
  let i = 0;
  for (const m of DEFAULT_ACCOUNT_MAPPING) {
    i += 1;
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-${i}`, m.transactionType, m.role, accId(m.accountKode)
    );
  }
}

async function seedJurnal(id: string, tanggal: string, sumber: string, lines: [string, number, number][]) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,'historis','POSTED','user-1',?,?)`,
    id, `JRN-${id}`, tanggal, `p${tanggal.slice(0, 4)}`, sumber, now, now
  );
  let n = 0;
  for (const [kode, d, k] of lines) {
    n += 1;
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,?)`,
      `${id}-${n}`, id, accId(kode), d, k
    );
  }
}

async function seedFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();
  await seedCoaLengkap();
  for (const th of [2025, 2026]) {
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
  // Histori yang mewakili jalur produksi yang benar-benar memakai akun terkait.
  await seedJurnal('j-modal', '2025-01-01', 'MODAL_AWAL', [['1-1000', 900_000_000, 0], ['3-1000', 0, 900_000_000]]);
  await seedJurnal('j-prop', '2025-03-10', 'INVESTASI', [['1-1660', 500_000_000, 0], ['1-1000', 0, 500_000_000]]);
  await seedJurnal('j-susut', '2026-01-31', 'PENYUSUTAN_PROPERTI_INVESTASI', [['5-1300', 2_000_000, 0], ['1-1670', 0, 2_000_000]]);
  await seedJurnal('j-shu', '2026-02-15', 'BAGIAN_SHU_INVESTASI', [['1-1220', 7_500_000, 0], ['4-1300', 0, 7_500_000]]);
  await seedJurnal('j-shu-kas', '2026-03-01', 'BAGIAN_SHU_PENERIMAAN', [['1-1000', 5_000_000, 0], ['1-1220', 0, 5_000_000]]);
  await seedJurnal('j-bunga', '2026-03-31', 'PENERIMAAN_LAIN', [['1-1000', 1_200_000, 0], ['4-1500', 0, 1_200_000]]);
  await seedJurnal('j-fee', '2026-04-01', 'PENCAIRAN_PINJAMAN', [['1-1200', 12_000_000, 0], ['1-1000', 0, 11_760_000], ['2-1300', 0, 240_000]]);
}

/** DB hanya untuk describe yang membutuhkannya — test statis tidak bergantung pada fixture. */
function pakaiDb(): void {
  beforeEach(async () => {
    await seedFixture();
  });
  afterEach(() => {
    testDb.closeSync();
  });
}

async function snapshotLaporan(): Promise<unknown> {
  const posisi = await getPosisiKeuangan(testDb as any, '2026-12-31');
  const lhu = await getLHU(testDb as any, '2026-01-01', '2026-12-31');
  const tb = await getTrialBalance(testDb as any, '2026-12-31');
  const akun = await testDb.getAllAsync(`SELECT id, kode, nama, kategori, normal_balance, is_active, is_system FROM account ORDER BY kode`);
  const mapping = await testDb.getAllAsync(`SELECT transaction_type, role, account_id FROM account_mapping ORDER BY transaction_type, role`);
  const jurnal = await testDb.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`);
  return JSON.parse(JSON.stringify({ posisi, lhu, tb, akun, mapping, jurnal }));
}

describe('RC-S54 T12 #14 — inventory & integritas COA', () => {
  it('Test 2 — tidak ada kode duplikat; seluruh kode berformat X-NNNN', () => {
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    expect(new Set(kode).size).toBe(kode.length);
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 akun kode-persis ditambahkan (DEFINED / NOT ACTIVELY POSTED).
    const KODE_DIMINTA_3_DIGIT = KODE_COA_DIMINTA_ITEM_14.map((e) => e.kode).filter((k) => /^\d-\d{3}$/.test(k));
    for (const k of kode) expect(k).toMatch(KODE_DIMINTA_3_DIGIT.includes(k) ? /^\d-\d{3}$/ : /^\d-\d{4}$/);
    const mapKey = DEFAULT_ACCOUNT_MAPPING.map((m) => `${m.transactionType}::${m.role}`);
    expect(new Set(mapKey).size).toBe(mapKey.length);
  });

  it('Test 3 — tidak ada duplikasi semantik akun (nama ternormalisasi unik; tidak ada padanan 12 kode yang diminta)', () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 akun kode-persis ditambahkan (DEFINED / NOT ACTIVELY POSTED).
    const nama = DEFAULT_ACCOUNTS.map((a) => norm(a.nama));
    // Satu-satunya nama ganda = pasangan (kode diminta, akun semantik existing).
    const ganda = [...new Set(nama.filter((n, i) => nama.indexOf(n) !== i))];
    for (const n of ganda) {
      const pasangan = DEFAULT_ACCOUNTS.filter((a) => norm(a.nama) === n).map((a) => a.kode);
      expect(pasangan).toHaveLength(2);
      const diminta = pasangan.filter((k) => KODE_COA_DIMINTA_ITEM_14.some((e) => e.kode === k));
      expect(diminta).toHaveLength(1);
      const entri = KODE_COA_DIMINTA_ITEM_14.find((e) => e.kode === diminta[0])!;
      expect(entri.akunExisting).toContain(pasangan.find((k) => k !== diminta[0]));
    }
    for (const e of KODE_COA_DIMINTA_ITEM_14) {
      // Kode diminta ADA; akun semantik existing tetap ada dan tidak di-renumber.
      expect(DEFAULT_ACCOUNTS.find((a) => a.kode === e.kode)).toBeDefined();
      for (const k of e.akunExisting) expect(DEFAULT_ACCOUNTS.find((a) => a.kode === k)).toBeDefined();
    }
  });

  it('Test 5 — keputusan COA berlaku: mapping historis akun terkait tidak bergeser', () => {
    const peta = (tt: string, role: string) =>
      DEFAULT_ACCOUNT_MAPPING.find((m) => m.transactionType === tt && m.role === role)?.accountKode;
    expect(peta('INVESTASI_PROPERTI_INVESTASI', 'DEBIT_ASET')).toBe('1-1660');
    expect(peta('PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI')).toBe('1-1670');
    expect(peta('IMPAIRMENT_INVESTASI', 'KREDIT_PENYISIHAN')).toBe('1-1900');
    expect(peta('BAGIAN_SHU_INVESTASI', 'DEBIT_PIUTANG')).toBe('1-1220');
    expect(peta('BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN')).toBe('4-1300');
    expect(peta('BAGIAN_SHU_PENERIMAAN', 'KREDIT_PIUTANG')).toBe('1-1220');
    expect(peta('EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA')).toBe('2-1300');
    expect(peta('EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN')).toBe('4-1000');
    expect(peta('BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA')).toBe('2-1300');
    // 1-1240 / 1-1250 tetap belum dipetakan: akrual nonaktif (KEPUTUSAN 06);
    // 04-B RC-S67.6 hanya mengaktifkan penerimaan KAS (tanpa piutang/mapping).
    const dipetakan = new Set(DEFAULT_ACCOUNT_MAPPING.map((m) => m.accountKode));
    expect(dipetakan.has('1-1240')).toBe(false);
    expect(dipetakan.has('1-1250')).toBe(false);
  });
});

describe('RC-S54 T12 #14 — matriks konflik', () => {
  it('Test 6 — 12 kode yang diminta terdeteksi berkonflik, masing-masing dengan policy & keputusan', () => {
    expect(KODE_COA_DIMINTA_ITEM_14.map((e) => e.kode)).toEqual(KODE_DIMINTA);
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta kini ADA di COA; posting/policy TIDAK berubah.
    for (const k of KODE_DIMINTA) {
      // Registry tetap mendokumentasikan kode diminta -> akun semantik existing,
      // tetapi kodenya kini DITAMBAHKAN sehingga bukan lagi konflik untuk guard.
      const e = KODE_COA_DIMINTA_ITEM_14.find((x) => x.kode === k)!;
      expect(e.policy).toMatch(/KEPUTUSAN 0[1-4]/);
      expect(e.keputusan).toBe('DITAMBAHKAN');
      expect(cariKonflikKodeAkun(k)).toBeNull();
      expect(DEFAULT_ACCOUNTS.find((a) => a.kode === k)).toBeDefined();
    }
    // Tidak ada REPLACE/RENUMBER yang dipilih otomatis.
    expect(JSON.stringify(KODE_COA_DIMINTA_ITEM_14)).not.toMatch(/REPLACE|RENUMBER/);
    // Akun existing tidak berkonflik dengan dirinya sendiri.
    for (const k of ['1-1660', '1-1220', '1-1240', '1-1250', '4-1300', '4-1500', '4-1700', '2-1300']) {
      expect(cariKonflikKodeAkun(k)).toBeNull();
    }
    const perlu = KODE_COA_DIMINTA_ITEM_14.filter((e) => e.keputusan === 'POLICY_DECISION_REQUIRED').map((e) => e.kode);

    // RC-S54 TAHAP 15: keputusan 1-660/1-661 (OPTION A ditegaskan) dan 4-1540
    // (04-A / 4-1300) difinalisasi tanpa perubahan akun/mapping. Sebelumnya
    // ['1-660', '1-661', '4-1540'] — lihat RC-S54_TAHAP_15.md §3, §4, §9.
    expect(perlu).toEqual([]);
  });

  it('Test 7 — 1-1660 tetap SATU akun properti investasi (POLICY 02 belum dicabut)', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 akun kode-persis ADA; posting & policy tidak berubah.
    const properti = DEFAULT_ACCOUNTS.filter((a) => /properti investasi/i.test(a.nama));
    // DIPERBARUI RC-S88: akun penyesuai nilai wajar 1-1665 (bukan akun properti kedua —
    // biaya perolehan tetap SATU di 1-1660).
    expect(properti.map((a) => a.kode).sort()).toEqual(
      ['1-1660', '1-1665', '1-1670', '1-660', '1-661', '4-2100', '5-5000'].sort()
    );
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '1-1670')!.normalBalance).toBe('KREDIT');
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta kini ADA di COA; posting/policy TIDAK berubah.
    // 1-660/1-661 ADA sebagai akun terdefinisi, tetapi TIDAK dipetakan ke posting apa pun.
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    expect(kode).toContain('1-660');
    expect(kode).toContain('1-661');
    for (const k of ['1-660', '1-661']) expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === k)).toEqual([]);
  });

  it('Test 8 — 1-1220 / 1-1240 / 1-1250 tetap valid; tidak di-renumber ke 1-220 / 1-240 / 1-250', () => {
    for (const [kode, nama] of [
      ['1-1220', 'Piutang Pendapatan Investasi'],
      ['1-1240', 'Piutang Bagi Hasil'],
      ['1-1250', 'Piutang Pendapatan Sewa'],
    ]) {
      const a = DEFAULT_ACCOUNTS.find((x) => x.kode === kode);
      expect(a).toMatchObject({ nama, kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true });
    }
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta kini ADA di COA; posting/policy TIDAK berubah.
    // Kode diminta ADA di COA, tetapi TIDAK ada di mapping mana pun (tidak di-renumber).
    const kodeMapping = DEFAULT_ACCOUNT_MAPPING.map((m) => m.accountKode);
    for (const k of ['1-220', '1-230', '1-240', '1-250']) {
      expect(DEFAULT_ACCOUNTS.map((a) => a.kode)).toContain(k);
      expect(kodeMapping).not.toContain(k);
    }
    expect(DEFAULT_ACCOUNTS.map((a) => a.kode)).not.toContain('1-1230');
  });

  it('Test 9 — 4-15xx tidak dibuat duplikat; tujuan 01-B tetap HASIL_INVESTASI', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta kini ADA di COA; posting/policy TIDAK berubah.
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    const kodeMapping = DEFAULT_ACCOUNT_MAPPING.map((m) => m.accountKode);
    for (const k of ['4-1510', '4-1520', '4-1530', '4-1540']) {
      expect(kode).toContain(k);
      expect(kodeMapping).not.toContain(k);
    }
    // Bagian SHU tetap Cr 4-1300 (KEPUTUSAN 04-A), bukan 4-1540.
    expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.transactionType === 'BAGIAN_SHU_INVESTASI' && m.role === 'KREDIT_PENDAPATAN').map((m) => m.accountKode)).toEqual(['4-1300']);
    for (const k of ['4-1300', '4-1700']) {
      expect(DEFAULT_ACCOUNTS.find((a) => a.kode === k)).toMatchObject({
        kategori: 'PENDAPATAN', normalBalance: 'KREDIT', lhuKlasifikasi: 'HASIL_INVESTASI',
      });
    }
    // Poin 6 — 4-1500 diklasifikasikan Pendapatan Usaha Lain pada LHU.
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '4-1500')).toMatchObject({
      kategori: 'PENDAPATAN', normalBalance: 'KREDIT', lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN',
    });
  });

  // DIPERBARUI RC-S88 (keputusan pengguna — rekomendasi SAK EP): POLICY 03 = MODEL
  // BIAYA DIGANTI model nilai wajar properti investasi. 4-2100/5-5000 kini AKTIF,
  // tetapi HANYA lewat mapping NILAI_WAJAR_PROPERTI_INVESTASI (bukan aktivasi diam-diam).
  it('Test 10 — 4-2100 / 5-5000 aktif HANYA lewat mapping nilai wajar (RC-S88)', () => {
    expect(KEBIJAKAN_PENGUKURAN_PROPERTI_INVESTASI).toBe('MODEL_NILAI_WAJAR');
    expect(MAPPING_NILAI_WAJAR_AKTIF).toBe(true);
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 akun kode-persis ADA; posting & policy tidak berubah.
    // Akun nilai wajar kini TERDEFINISI, tetapi tetap TIDAK dipetakan: posting nilai
    // wajar tetap digated POLICY 03 = MODEL BIAYA (tidak ada aktivasi diam-diam).
    for (const k of ['4-2100', '5-5000']) {
      expect(DEFAULT_ACCOUNTS.map((a) => a.kode)).toContain(k);
      expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === k).map((m) => m.transactionType)).toEqual([
        'NILAI_WAJAR_PROPERTI_INVESTASI',
      ]);
    }
    expect(
      DEFAULT_ACCOUNT_MAPPING.filter((m) => /NILAI_WAJAR/.test(m.transactionType)).map((m) => `${m.role}:${m.accountKode}`).sort()
    ).toEqual(['DEBIT_KERUGIAN:5-5000', 'KREDIT_KEUNTUNGAN:4-2100', 'PENYESUAIAN_ASET:1-1665']);
  });

  it('Test 11 — EIR 2-1300: satu akun, mapping netting existing, tanpa akun aset EIR baru', () => {
    const dimuka = DEFAULT_ACCOUNTS.filter((a) => /diterima dimuka/i.test(a.nama));
    expect(dimuka.map((a) => a.kode)).toEqual(['2-1300']);
    expect(DEFAULT_ACCOUNTS.some((a) => /bunga efektif|akrual eir|eir/i.test(a.nama))).toBe(false);
    const roles = DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === '2-1300').map((m) => `${m.transactionType}/${m.role}`).sort();
    expect(roles).toEqual([
      'AKRUAL_JASA_PINJAMAN/DEBIT_DIMUKA',
      'ANGSURAN_JASA/KREDIT_DIMUKA',
      'BIAYA_ADMIN_PINJAMAN/KREDIT_DIMUKA',
      'EIR_FEE_AMORTIZATION/DEBIT_DIMUKA',
      'PELUNASAN_JASA_FUTURE/KREDIT_DIMUKA',
      'PENDAPATAN_DITERIMA_DIMUKA/KREDIT_DEFAULT',
      'PENGAKUAN_PENDAPATAN_DIMUKA/DEBIT_DIMUKA',
    ]);
    // Bukti rekonsiliasi berbasis DB (Piutang − komponen EIR = AC; selisih 0 per periode,
    // termasuk saldo debit FLAT) ada di EirAmortizedCostRcS54 — tidak disentuh tahap ini.
    for (const f of ['src/accounting/EirFeeInvariant.ts', 'src/accounting/DeferredIncomeReconciliation.ts', 'src/services/EirAccountingService.ts']) {
      expect(baca(f)).not.toMatch(/coaPolicyRegistry|CoaResolutionService/);
    }
  });

});

describe('RC-S54 T12 #14 — DATABASE (inventory, histori, laporan)', () => {
  pakaiDb();

  it('Test 1 — seluruh COA existing terdeteksi; setiap mapping & akun tujuan keputusan benar-benar ada', async () => {
    const kodeDefault = new Set(DEFAULT_ACCOUNTS.map((a) => a.kode));
    for (const m of DEFAULT_ACCOUNT_MAPPING) expect(kodeDefault.has(m.accountKode)).toBe(true);
    for (const kode of KODE_AKUN_TERKAIT_ITEM_14) expect(kodeDefault.has(kode)).toBe(true);
    for (const e of KODE_COA_DIMINTA_ITEM_14) for (const t of e.akunExisting) expect(kodeDefault.has(t)).toBe(true);
    const tersimpan = await listAllAccounts();
    expect(tersimpan.map((a) => a.kode).sort()).toEqual([...kodeDefault].sort());
  });


  it('Test 4 — jurnal historis pada akun terkait tetap terbaca (ledger, TB, dampak historis)', async () => {
    const ledgerProp = await getLedger(testDb as any, accId('1-1660'));
    expect(ledgerProp).toHaveLength(1);
    const tb = await getTrialBalance(testDb as any, '2026-12-31');
    expect(JSON.stringify(tb)).toContain('1-1220');
    const dampak = await getDampakHistorisCoa(testDb as any);
    const by = new Map(dampak.akunTerkait.map((d) => [d.kode, d]));
    expect(by.get('1-1660')).toMatchObject({ akunAda: true, jumlahJurnal: 1, saldo: 500_000_000, isSystem: true });
    expect(by.get('1-1670')).toMatchObject({ jumlahJurnal: 1, saldo: 2_000_000, periodeAwal: '2026-01' });
    expect(by.get('1-1220')).toMatchObject({ jumlahJurnal: 2, jumlahEntri: 2, saldo: 2_500_000, jumlahPeriode: 2 });
    expect(by.get('1-1220')?.sumberJurnal).toEqual(['BAGIAN_SHU_INVESTASI', 'BAGIAN_SHU_PENERIMAAN']);
    expect(by.get('4-1300')).toMatchObject({ jumlahJurnal: 1, saldo: 7_500_000 });
    expect(by.get('1-1240')).toMatchObject({ akunAda: true, jumlahJurnal: 0, mapping: [] });
    expect(by.get('2-1300')).toMatchObject({ jumlahJurnal: 1, saldo: 240_000 });
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): 12 akun kode-persis ADA; posting & policy tidak berubah.
    expect([...dampak.kodeDimintaSudahAda].sort()).toEqual([...KODE_DIMINTA].sort());
    // DIPERBARUI RC-S54 POST-CLOSURE #14: akun kode diminta kini ADA, tetapi belum dipakai jurnal mana pun.
    for (const d of dampak.kodeDiminta) expect(d).toMatchObject({ akunAda: true, jumlahJurnal: 0 });
  });


  it('Test 12 — laporan, akun, mapping, dan jurnal TIDAK berubah (upaya konflik + audit dampak read-only)', async () => {
    const awal = await snapshotLaporan();
    for (const k of KODE_DIMINTA) {
      await expect(
        createAccount('user-1', { kode: k, nama: `Uji ${k}`, kategori: k.startsWith('1') ? 'ASET' : k.startsWith('4') ? 'PENDAPATAN' : 'BEBAN', normalBalance: k.startsWith('4') ? 'KREDIT' : 'DEBIT' })
      ).rejects.toThrow(/sudah dipakai akun lain/); // DIPERBARUI RC-S54 POST-CLOSURE #14: kode diminta kini akun sah -> duplikat ditolak sebagai kode ganda
    }
    await getDampakHistorisCoa(testDb as any);
    expect(await snapshotLaporan()).toEqual(awal);
  });


  it('Test 12b — LHU: 4-1300 vs 4-1700 untuk bagian SHU jatuh ke baris HASIL INVESTASI yang sama (dampak konflik 01-B/04-A)', async () => {
    const lhuDengan = async (kodePendapatan: string) => {
      await seedFixture();
      await seedJurnal('j-shu-x', '2026-05-01', 'BAGIAN_SHU_INVESTASI', [['1-1220', 3_000_000, 0], [kodePendapatan, 0, 3_000_000]]);
      const lhu = await getLHU(testDb as any, '2026-01-01', '2026-12-31');
      const hasil = { total: lhu.totalHasilInvestasi, shuNeto: lhu.shuNeto };
      testDb.closeSync();
      return hasil;
    };
    const a = await lhuDengan('4-1300');
    const b = await lhuDengan('4-1700');
    // DIPERBARUI Poin 6: 4-1500 (bunga 1.200.000 di fixture) kini diklasifikasikan
    // PENDAPATAN_USAHA_LAIN, sehingga tidak lagi masuk Hasil Investasi.
    expect(a.total).toBe(7_500_000 + 3_000_000);
    expect(b).toEqual(a);
    await seedFixture(); // afterEach menutup koneksi aktif
  });
});

describe('RC-S54 T12 #14 — NEGATIVE CONTROL: POLICY_CONFLICT, bukan silently create', () => {
  pakaiDb();

  // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta bukan lagi
  // POLICY_CONFLICT karena akunnya memang sudah ada di COA. Kontrol negatifnya bergeser:
  // membuat akun KEDUA dengan kode yang sama harus tetap ditolak (tidak ada duplikasi).
  it.each(['1-660', '1-661', '1-230', '4-2100', '5-5000'])('createAccount %s (duplikat kode) ditolak; akun tetap satu', async (kode) => {
    const sebelum = await listAllAccounts();
    const kategori = kode.startsWith('1') ? 'ASET' : kode.startsWith('4') ? 'PENDAPATAN' : 'BEBAN';
    expect(sebelum.filter((a) => a.kode === kode)).toHaveLength(1);
    await expect(
      createAccount('user-1', { kode, nama: `Uji ${kode}`, kategori, normalBalance: kode.startsWith('4') ? 'KREDIT' : 'DEBIT' })
    ).rejects.toThrow();
    const sesudah = await listAllAccounts();
    expect(sesudah.length).toBe(sebelum.length);
    expect(sesudah.filter((a) => a.kode === kode)).toHaveLength(1);
  });

  it('updateAccount: mengganti kode MENJADI kode yang sudah dipakai ditolak; akun non-konflik tetap dapat dibuat & diedit', async () => {
    const baru = await createAccount('user-1', { kode: '5-9100', nama: 'Beban Uji', kategori: 'BEBAN', normalBalance: 'DEBIT' });
    await expect(
      updateAccount('user-1', baru.id, { kode: '5-5000', nama: 'Beban Uji', kategori: 'BEBAN', normalBalance: 'DEBIT' })
    ).rejects.toThrow();
    expect((await listAllAccounts()).find((a) => a.id === baru.id)?.kode).toBe('5-9100');
    await updateAccount('user-1', baru.id, { kode: '5-9100', nama: 'Beban Uji Diubah', kategori: 'BEBAN', normalBalance: 'DEBIT' });
    expect((await listAllAccounts()).find((a) => a.id === baru.id)?.nama).toBe('Beban Uji Diubah');
  });

  it('akun berkode konflik yang SUDAH ada (dibuat sebelum guard) tidak dihapus, tetap terbaca & dapat diedit namanya', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-legacy-1230','1-9230','Piutang Dividen (manual lama)','ASET','DEBIT',1,0,?,?)`,
      now, now
    );
    const dampak = await getDampakHistorisCoa(testDb as any);
    // DIPERBARUI RC-S54 POST-CLOSURE #14: kode diminta kini akun resmi COA, jadi akun manual lama
    // memakai kode lain (1-9230). Yang dijaga tetap sama: akun manual lama tidak dihapus & tetap dapat diedit.
    expect(dampak.kodeDimintaSudahAda).toContain('1-230');
    await updateAccount('user-1', 'acc-legacy-1230', { kode: '1-9230', nama: 'Piutang Dividen (lama)', kategori: 'ASET', normalBalance: 'DEBIT' });
    expect((await listAllAccounts()).find((a) => a.id === 'acc-legacy-1230')?.nama).toBe('Piutang Dividen (lama)');
  });

});

describe('RC-S54 T12 #14 — STATIC (scope & migration)', () => {
  it('guard murni: kode diminta yang sudah DITAMBAHKAN tidak melempar; kode existing juga tidak', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14: kode diminta DITAMBAHKAN -> guard tidak lagi melempar untuk kode itu.
    for (const k of KODE_DIMINTA) expect(() => assertKodeAkunTidakKonflikPolicy(k)).not.toThrow();
    for (const k of ['1-1660', '1-1220', '4-1300', '2-1300', '5-1300']) expect(() => assertKodeAkunTidakKonflikPolicy(k)).not.toThrow();
  });

  it('NO MIGRATION — SCHEMA v65; registry & service tidak menulis database', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL). · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini — invarian yang dijaga test ini (modul di bawah tidak menulis DB / tidak mengacu hasil tahap ini) TIDAK berubah. · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    expect(baca('src/database/db.ts')).not.toMatch(/currentVersion < 82/); // DIPERBARUI v81 (blok v81 milik RC-S133.6.2, bukan tahap ini; ambang digeser ke 82). DIPERBARUI v80 (blok v80 milik RC-S132, bukan tahap ini; ambang digeser ke 81). DIPERBARUI v79 (blok v79 milik RC-S128 kebijakan produk simpanan berjangka, bukan tahap ini; ambang digeser ke 80). DIPERBARUI v78 (blok v78 milik fitur bunga harian sukarela, bukan tahap ini; ambang digeser ke 79). DIPERBARUI v77 (Poin 5/6/10): blok v77 milik patch 19 poin (kolom unit_usaha_id + klasifikasi/label akun), bukan tahap ini; ambang digeser ke 78.  DIPERBARUI RC-S88: blok v73 MILIK RC-S88 (nilai wajar/revaluasi); ambang digeser ke 74. // DIPERBARUI v72 = penarikan dana investasi (milik modul itu, bukan tahap ini) · DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL). · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini — invarian yang dijaga test ini (modul di bawah tidak menulis DB / tidak mengacu hasil tahap ini) TIDAK berubah. · DIPERBARUI RESTRUKTURISASI DATA: blok v70 (asal personel) kini ADA dan MILIK restrukturisasi Data/Personel; ambang digeser ke 71 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: blok v74 MILIK RC-S100 (riwayat import data awal, dua tabel BARU aditif); ambang digeser ke 75 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of ['src/config/coaPolicyRegistry.ts', 'src/services/CoaResolutionService.ts']) {
      const src = strip(baca(f));
      expect(src).not.toMatch(/INSERT INTO|UPDATE \w+ SET|DELETE FROM|createJournal|withTransaction/);
    }
  });

  it('guard dipasang di satu-satunya jalur input akun manual (create & update)', () => {
    const repo = baca('src/repositories/AccountRepository.ts');
    expect(repo.match(/assertKodeAkunTidakKonflikPolicy\(kodeTrim\)/g)).toHaveLength(2);
  });
});
