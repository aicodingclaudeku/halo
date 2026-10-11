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
  CoaPolicyConflictError,
  assertKodeAkunTidakKonflikPolicy,
  cariKonflikKodeAkun,
} from '@/config/coaPolicyRegistry';
import { diagnosaPenyajianCoaItem14, getDampakHistorisCoa } from '@/services/CoaResolutionService';
import { createAccount } from '@/repositories/AccountRepository';
import { generateCALK, getPosisiKeuangan, getLHU, KODE_PIUTANG_HASIL_INVESTASI } from '@/reports/FinancialReports';
import { catatInvestasi } from '@/services/InvestasiService';
import {
  bacaKonfigurasiPenyusutan,
  simpanKonfigurasiPenyusutanProperti,
  prosesPenyusutanPropertiInvestasi,
  PenyusutanPropertiBelumSiapError,
} from '@/services/PenyusutanPropertiInvestasiService';
import { catatImpairmentInvestasi, getNilaiTercatatInvestasi } from '@/services/InvestasiImpairmentService';
import { catatBagianShuInvestasi } from '@/services/BagianShuService';

/**
 * RC-S54 TAHAP 15 — FINALISASI ITEM #14 COA.
 *
 * Mengunci keputusan final (tanpa akun/mapping/jurnal baru):
 *  A. Properti investasi: OPTION A ditegaskan (1-1660 + kontra 1-1670, pemisahan di data).
 *  B. Bagian SHU: Dr 1-1220 / Cr 4-1300 (KEPUTUSAN 04-A).
 *  C. EIR 2-1300: pengukuran tidak disentuh; saldo debit = gap PENYAJIAN, dideteksi diagnostik read-only.
 * Ditambah perbaikan penyajian CALK (catatan 5 & 11) yang terbukti salah terhadap Posisi Keuangan.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const accId = (kode: string) => `acc-${kode}`;
const USER = 'user-1';

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
     VALUES (?,?,?,?,?,'uji','POSTED','user-1',?,?)`,
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
  await seedJurnal('j-modal', '2025-01-01', 'MODAL_AWAL', [['1-1000', 900_000_000, 0], ['3-1000', 0, 900_000_000]]);
}

function pakaiDb(): void {
  beforeEach(async () => {
    jest.useFakeTimers({
      now: new Date('2026-09-17T03:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    await seedFixture();
  });
  afterEach(() => {
    testDb.closeSync();
    jest.useRealTimers();
  });
}

async function snapshotDb(): Promise<unknown> {
  const tabel = ['account', 'account_mapping', 'journal', 'journal_entry', 'investasi', 'investasi_penyusutan', 'investasi_impairment', 'investasi_bagian_shu', 'audit_log'];
  const out: Record<string, unknown> = {};
  for (const t of tabel) out[t] = await testDb.getAllAsync(`SELECT * FROM ${t} ORDER BY rowid`);
  return JSON.parse(JSON.stringify(out));
}

const saldoPosisi = (rows: { kode: string; saldo: number }[], kode: string) => rows.find((r) => r.kode === kode)?.saldo ?? 0;

async function propertiDisusutkanDanImpair(): Promise<string> {
  const inv = await catatInvestasi({
    jenisInvestasi: 'PROPERTI_INVESTASI', namaTujuan: 'Ruko Jl. Mawar', jumlah: 300_000_000,
    tanggal: '2026-01-05', sumberDana: 'KAS', createdBy: USER,
  });
  await simpanKonfigurasiPenyusutanProperti({
    investasiId: inv.id, jenisObjek: 'TANAH_DAN_BANGUNAN', nilaiDapatDisusutkan: 240_000_000,
    nilaiResidu: 0, masaManfaatBulan: 120, tanggalMulaiPenyusutan: '2026-01-05', createdBy: USER,
  });
  for (const periode of ['2026-01', '2026-02', '2026-03']) {
    await prosesPenyusutanPropertiInvestasi({ investasiId: inv.id, periode, createdBy: USER });
  }
  await catatImpairmentInvestasi({
    investasiId: inv.id, tanggal: '2026-04-10', indikasiTerpilih: ['Kerusakan fisik'],
    dasarPenilaian: 'Laporan kondisi bangunan', nilaiImpairment: 10_000_000, alasan: 'uji', createdBy: USER,
  });
  return inv.id;
}

// ===========================================================================
// §5 / §6 — MATRIKS FINAL & GUARD
// ===========================================================================

describe('RC-S54 T15 #14 — matriks kode diminta final & COA policy guard', () => {
  it('seluruh kode diminta berstatus DITAMBAHKAN; pemetaan ke akun semantik existing tetap terdokumentasi', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta DITAMBAHKAN ke COA (DEFINED / NOT ACTIVELY POSTED).
    const status = Object.fromEntries(KODE_COA_DIMINTA_ITEM_14.map((e) => [e.kode, [e.keputusan, [...e.akunExisting]]]));
    expect(status).toEqual({
      '1-660': ['DITAMBAHKAN', ['1-1660']],
      '1-661': ['DITAMBAHKAN', ['1-1660']],
      '1-220': ['DITAMBAHKAN', ['1-1220']],
      '1-230': ['DITAMBAHKAN', ['1-1220']],
      '1-240': ['DITAMBAHKAN', ['1-1240']],
      '1-250': ['DITAMBAHKAN', ['1-1250']],
      // DIPERBARUI RC-S70.6 (instruksi eksplisit pengguna): 4-1510/4-1520 kini akun
      // posting aktif untuk dirinya sendiri; pemetaan lama -> 4-1500 DEPRECATED.
      '4-1510': ['DITAMBAHKAN', ['4-1510']],
      '4-1520': ['DITAMBAHKAN', ['4-1520']],
      '4-1530': ['DITAMBAHKAN', ['4-1300']],
      '4-1540': ['DITAMBAHKAN', ['4-1300']],
      '4-2100': ['DITAMBAHKAN', []],
      '5-5000': ['DITAMBAHKAN', []],
    });
    expect(KODE_COA_DIMINTA_ITEM_14.find((e) => e.kode === '4-1540')!.policy).toMatch(/KEPUTUSAN 04-A/);
    expect(KODE_COA_DIMINTA_ITEM_14.find((e) => e.kode === '1-660')!.policy).toMatch(/KEPUTUSAN 02 .*OPTION A/);
  });

  it('guard tidak lagi memblokir kode diminta (akunnya ada); akun existing tetap tidak diblokir', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta DITAMBAHKAN ke COA (DEFINED / NOT ACTIVELY POSTED).
    for (const e of KODE_COA_DIMINTA_ITEM_14) {
      expect(cariKonflikKodeAkun(e.kode)).toBeNull();
      expect(() => assertKodeAkunTidakKonflikPolicy(e.kode)).not.toThrow();
    }
    for (const a of DEFAULT_ACCOUNTS) expect(cariKonflikKodeAkun(a.kode)).toBeNull();
    // Mekanisme guard tetap ada untuk entri yang kelak berstatus selain DITAMBAHKAN.
    expect(CoaPolicyConflictError.name).toBe('CoaPolicyConflictError');
  });

  it('ke-12 kode diminta ADA di COA dengan nama & klasifikasi yang diminta; tanpa mapping otomatis', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta DITAMBAHKAN ke COA (DEFINED / NOT ACTIVELY POSTED).
    const DIMINTA: [string, string, string, string][] = [
      ['1-220', 'Piutang Pendapatan Investasi', 'ASET', 'DEBIT'],
      ['1-230', 'Piutang Dividen', 'ASET', 'DEBIT'],
      ['1-240', 'Piutang Bagi Hasil', 'ASET', 'DEBIT'],
      ['1-250', 'Piutang Pendapatan Sewa', 'ASET', 'DEBIT'],
      ['1-660', 'Tanah Properti Investasi', 'ASET', 'DEBIT'],
      ['1-661', 'Bangunan Properti Investasi', 'ASET', 'DEBIT'],
      ['4-1510', 'Pendapatan Bunga Deposito', 'PENDAPATAN', 'KREDIT'],
      ['4-1520', 'Pendapatan Bunga Investasi', 'PENDAPATAN', 'KREDIT'],
      ['4-1530', 'Pendapatan Dividen', 'PENDAPATAN', 'KREDIT'],
      ['4-1540', 'Pendapatan Jasa (Bagian SHU)', 'PENDAPATAN', 'KREDIT'],
      ['4-2100', 'Keuntungan Perubahan Nilai Wajar Properti Investasi', 'PENDAPATAN', 'KREDIT'],
      ['5-5000', 'Kerugian Nilai Wajar Properti Investasi', 'BEBAN', 'DEBIT'],
    ];
    expect(DIMINTA.map((d) => d[0]).sort()).toEqual(KODE_COA_DIMINTA_ITEM_14.map((e) => e.kode).sort());
    for (const [kode, nama, kategori, normalBalance] of DIMINTA) {
      const akun = DEFAULT_ACCOUNTS.filter((a) => a.kode === kode);
      expect(akun).toHaveLength(1);
      expect(akun[0]).toMatchObject({ nama, kategori, normalBalance, isSystem: false });
      // DIPERBARUI RC-S88 (keputusan pengguna — model nilai wajar properti investasi SAK EP 16):
      // 4-2100 & 5-5000 kini DIPOSTING otomatis lewat mapping NILAI_WAJAR_PROPERTI_INVESTASI.
      // Sepuluh kode lainnya tetap DEFINED / NOT ACTIVELY POSTED.
      const mapping = DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === kode).map((m) => `${m.transactionType}/${m.role}`);
      if (kode === '4-2100') expect(mapping).toEqual(['NILAI_WAJAR_PROPERTI_INVESTASI/KREDIT_KEUNTUNGAN']);
      else if (kode === '5-5000') expect(mapping).toEqual(['NILAI_WAJAR_PROPERTI_INVESTASI/DEBIT_KERUGIAN']);
      else expect(mapping).toEqual([]);
    }
    expect(DEFAULT_ACCOUNTS.map((a) => a.kode)).not.toContain('1-1230');
  });

  describe('DB', () => {
    pakaiDb();
    it('ke-12 akun kode diminta ter-resolve di database; membuat duplikatnya ditolak; mapping & jurnal tidak berubah', async () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (keputusan pengguna): kode diminta DITAMBAHKAN ke COA (DEFINED / NOT ACTIVELY POSTED).
      const awal = await snapshotDb();
      for (const e of KODE_COA_DIMINTA_ITEM_14) {
        const akun = await testDb.getAllAsync<{ kode: string; nama: string }>(`SELECT kode, nama FROM account WHERE kode = ?`, e.kode);
        expect(akun).toHaveLength(1);
        expect(akun[0].nama).toBe(e.nama);
        await expect(
          createAccount(USER, { kode: e.kode, nama: `Duplikat ${e.kode}`, kategori: e.kode.startsWith('1') ? 'ASET' : e.kode.startsWith('4') ? 'PENDAPATAN' : 'BEBAN', normalBalance: e.kode.startsWith('4') ? 'KREDIT' : 'DEBIT' })
        ).rejects.toThrow();
        const mapping = await testDb.getAllAsync(
          `SELECT m.id FROM account_mapping m JOIN account a ON a.id = m.account_id WHERE a.kode = ?`, e.kode
        );
        // DIPERBARUI RC-S88: 4-2100/5-5000 dipetakan model nilai wajar (satu mapping masing-masing).
        expect(mapping).toHaveLength(['4-2100', '5-5000'].includes(e.kode) ? 1 : 0);
      }
      expect(await snapshotDb()).toEqual(awal);
    });
  });
});

// ===========================================================================
// §2 — DECISION A: PROPERTI INVESTASI
// ===========================================================================

describe('RC-S54 T15 #14 — Decision A: properti investasi (OPTION A ditegaskan)', () => {
  it('mapping: hanya penempatan mendebit 1-1660; penyusutan mengkredit 1-1670, beban 5-1300; impairment ke 1-1900', () => {
    const ke = (kode: string) => DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === kode).map((m) => `${m.transactionType}/${m.role}`).sort();
    expect(ke('1-1660')).toEqual(['INVESTASI_PROPERTI_INVESTASI/DEBIT_ASET']);
    expect(ke('1-1670')).toEqual(['PENYUSUTAN_PROPERTI_INVESTASI/KREDIT_AKUMULASI']);
    expect(ke('1-1900')).toEqual(['IMPAIRMENT_INVESTASI/KREDIT_PENYISIHAN']);
    const susut = DEFAULT_ACCOUNT_MAPPING.filter((m) => m.transactionType === 'PENYUSUTAN_PROPERTI_INVESTASI').map((m) => `${m.role}:${m.accountKode}`).sort();
    expect(susut).toEqual(['DEBIT_BEBAN:5-1300', 'KREDIT_AKUMULASI:1-1670']);
    // DIPERBARUI RC-S54 POST-CLOSURE #14: akun kode diminta ikut memuat frasa "Properti Investasi",
    // tetapi hanya 1-1660/1-1670 yang DIPETAKAN untuk posting.
    // DIPERBARUI RC-S88: model nilai wajar menambah akun penyesuai 1-1665 dan memetakan 4-2100/5-5000.
    const properti = DEFAULT_ACCOUNTS.filter((a) => /properti investasi/i.test(a.nama)).map((a) => a.kode).sort();
    expect(properti).toEqual(['1-1660', '1-1665', '1-1670', '1-660', '1-661', '4-2100', '5-5000'].sort());
    expect(properti.filter((k) => DEFAULT_ACCOUNT_MAPPING.some((m) => m.accountKode === k)).sort()).toEqual(
      ['1-1660', '1-1665', '1-1670', '4-2100', '5-5000'].sort()
    );
  });

  it('pemisahan tanah/bangunan ada di DATA: CHECK jenis_objek_properti & nilai_dapat_disusutkan; tanah tidak disusutkan', () => {
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(/jenis_objek_properti TEXT CHECK \(jenis_objek_properti IN \('TANAH','BANGUNAN','TANAH_DAN_BANGUNAN'\)\)/);
    expect(schema).toMatch(/nilai_dapat_disusutkan INTEGER/);
    const dasar = {
      id: 'x', nama_tujuan: 'Tanah', jenis_investasi: 'PROPERTI_INVESTASI', status: 'AKTIF',
      jumlah: 100_000_000, nilai_dapat_disusutkan: null, nilai_residu_properti: null,
      masa_manfaat_bulan_properti: null, tanggal_mulai_penyusutan: null,
    };
    let err: unknown;
    try {
      bacaKonfigurasiPenyusutan({ ...dasar, jenis_objek_properti: 'TANAH' } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PenyusutanPropertiBelumSiapError);
    expect((err as PenyusutanPropertiBelumSiapError).kode).toBe('TANAH_TIDAK_DISUSUTKAN');
  });

  describe('DB', () => {
    pakaiDb();
    it('objek campuran: penyusutan hanya atas nilai bangunan, ke 1-1670; 1-1660 tetap biaya perolehan; nilai tercatat = Posisi Keuangan', async () => {
      const id = await propertiDisusutkanDanImpair();
      const entri1660 = await testDb.getAllAsync<{ debit: number; kredit: number; sumber: string }>(
        `SELECT je.debit, je.kredit, j.sumber_transaksi AS sumber FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE je.account_id = ?`,
        accId('1-1660')
      );
      expect(entri1660).toEqual([{ debit: 300_000_000, kredit: 0, sumber: expect.any(String) }]);
      const susut = await testDb.getAllAsync<{ nilai_penyusutan: number }>(`SELECT nilai_penyusutan FROM investasi_penyusutan ORDER BY periode`);
      expect(susut.map((s) => s.nilai_penyusutan)).toEqual([2_000_000, 2_000_000, 2_000_000]);

      const nt = await getNilaiTercatatInvestasi(testDb as never, id);
      expect(nt).toMatchObject({ nilaiAwal: 300_000_000, akumulasiPenyusutan: 6_000_000, akumulasiImpairment: 10_000_000, nilaiTercatat: 284_000_000 });
      const posisi = await getPosisiKeuangan(testDb as never, '2026-12-31');
      expect(saldoPosisi(posisi.aset, '1-1660') + saldoPosisi(posisi.aset, '1-1670') + saldoPosisi(posisi.aset, '1-1900')).toBe(nt.nilaiTercatat);
    });
  });
});

// ===========================================================================
// §3 — DECISION B: BAGIAN SHU
// ===========================================================================

describe('RC-S54 T15 #14 — Decision B: bagian SHU = Dr 1-1220 / Cr 4-1300', () => {
  it('mapping produksi: 1-1220 & 4-1300; 1-1240 dan 4-1700 tidak dipetakan jalur otomatis mana pun', () => {
    const shu = DEFAULT_ACCOUNT_MAPPING.filter((m) => m.transactionType.startsWith('BAGIAN_SHU_')).map((m) => `${m.transactionType}/${m.role}:${m.accountKode}`).sort();
    expect(shu).toEqual([
      'BAGIAN_SHU_INVESTASI/DEBIT_PIUTANG:1-1220',
      'BAGIAN_SHU_INVESTASI/KREDIT_PENDAPATAN:4-1300',
      'BAGIAN_SHU_PENERIMAAN/KREDIT_PIUTANG:1-1220',
    ]);
    for (const k of ['1-1240', '4-1700']) expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === k)).toEqual([]);
    // jenis hasil register hanya BAGIAN_SHU. Imbal hasil tetap (RC-S67.6) aktif sebagai
    // penerimaan kas Cr 4-1700 lewat config kebijakan — bukan mapping, bukan register ini.
    expect(baca('src/database/schema.ts')).toMatch(/jenis_hasil TEXT NOT NULL DEFAULT 'BAGIAN_SHU' CHECK \(jenis_hasil IN \('BAGIAN_SHU'\)\)/);
    const svc = tanpaKomentar(baca('src/services/BagianShuService.ts'));
    expect(svc).toMatch(/resolveAccountId\(db, 'BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN'\)/);
    expect(svc).not.toMatch(/4-1700|4-1300|1-1240/);
  });

  describe('DB', () => {
    pakaiDb();
    it('pengakuan bagian SHU menjurnal Dr 1-1220 / Cr 4-1300 dan masuk baris LHU hasil investasi', async () => {
      const inv = await catatInvestasi({
        jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP Sekunder', jumlah: 50_000_000,
        tanggal: '2026-01-10', sumberDana: 'KAS', createdBy: USER,
      });
      await catatBagianShuInvestasi({
        investasiId: inv.id, tanggalHak: '2026-03-20', jumlah: 4_250_000, jenisDokumen: 'Berita Acara RAT',
        nomorDokumen: 'BA-01/2026', tanggalDokumen: '2026-03-20', createdBy: USER,
      });
      const entri = await testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
        `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN journal j ON j.id = je.journal_id
           JOIN account a ON a.id = je.account_id WHERE j.sumber_transaksi = 'BAGIAN_SHU_INVESTASI' ORDER BY a.kode`
      );
      expect(entri).toEqual([
        { kode: '1-1220', debit: 4_250_000, kredit: 0 },
        { kode: '4-1300', debit: 0, kredit: 4_250_000 },
      ]);
      const lhu = await getLHU(testDb as never, '2026-01-01', '2026-12-31');
      expect(lhu.totalHasilInvestasi).toBe(4_250_000);
    });
  });
});

// ===========================================================================
// §4 — DECISION C: EIR / 2-1300
// ===========================================================================

describe('RC-S54 T15 #14 — Decision C: EIR & 2-1300 (pengukuran tetap; penyajian = gap terdiagnosis)', () => {
  it('tidak ada akun EIR/aset bunga efektif baru; 2-1300 tetap satu akun dengan tujuh role', () => {
    expect(DEFAULT_ACCOUNTS.filter((a) => /diterima dimuka/i.test(a.nama)).map((a) => a.kode)).toEqual(['2-1300']);
    expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === '2-1300')).toHaveLength(7);
    const eir = DEFAULT_ACCOUNT_MAPPING.filter((m) => m.transactionType === 'EIR_FEE_AMORTIZATION').map((m) => `${m.role}:${m.accountKode}`).sort();
    expect(eir).toEqual(['DEBIT_DIMUKA:2-1300', 'KREDIT_PENDAPATAN:4-1000']);
    // Laporan tidak menyajikan ulang 2-1300: penyajian ulang adalah keputusan terbuka (T15 §5).
    expect(tanpaKomentar(baca('src/reports/FinancialReports.ts'))).not.toMatch(/2-1300|totalKomponenEirDi2_1300/);
  });

  describe('DB', () => {
    pakaiDb();
    it('saldo debit 2-1300 tersaji sebagai liabilitas negatif; diagnostik read-only menandainya per tanggal tanpa koreksi otomatis', async () => {
      await seedJurnal('j-cair', '2026-02-01', 'PENCAIRAN_PINJAMAN', [['1-1200', 12_000_000, 0], ['1-1000', 0, 11_760_000], ['2-1300', 0, 240_000]]);
      const tanpaDebit = await diagnosaPenyajianCoaItem14(testDb as never, '2026-12-31');
      expect(tanpaDebit.filter((t) => t.kode === 'SALDO_DEBIT_2_1300')).toEqual([]);

      // Komponen EIR FLAT: bunga efektif akrual melampaui sisa fee (X > sisaFee).
      await seedJurnal('j-eir', '2026-05-31', 'EIR_FEE_AMORTIZATION', [['2-1300', 900_000, 0], ['4-1000', 0, 900_000]]);
      const posisi = await getPosisiKeuangan(testDb as never, '2026-12-31');
      expect(saldoPosisi(posisi.liabilitas, '2-1300')).toBe(-660_000);

      const awal = await snapshotDb();
      const temuan = await diagnosaPenyajianCoaItem14(testDb as never, '2026-12-31');
      expect(await snapshotDb()).toEqual(awal);
      expect(temuan.filter((t) => t.kode === 'SALDO_DEBIT_2_1300')).toEqual([
        expect.objectContaining({
          akun: '2-1300', jumlahJurnal: 2, totalDebit: 900_000, totalKredit: 240_000,
          tanggalAwal: '2026-02-01', tanggalAkhir: '2026-05-31', saldo: -660_000,
          // RC-S54 T16: keputusan penyajian #14-C = OPSI C (pengungkapan otomatis CALK); sebelumnya false.
          koreksiDeterministik: true,
        }),
      ]);
      // Per tanggal sebelum jurnal EIR: tidak ada temuan.
      expect((await diagnosaPenyajianCoaItem14(testDb as never, '2026-05-30')).some((t) => t.kode === 'SALDO_DEBIT_2_1300')).toBe(false);
    });
  });
});

// ===========================================================================
// §7 — CALK
// ===========================================================================

describe('RC-S54 T15 #14 — CALK (catatan 5 & 11)', () => {
  it('kode piutang hasil investasi = tiga akun piutang KEPUTUSAN 01-A (ASET/DEBIT)', () => {
    expect([...KODE_PIUTANG_HASIL_INVESTASI]).toEqual(['1-1220', '1-1240', '1-1250']);
    for (const k of KODE_PIUTANG_HASIL_INVESTASI) {
      expect(DEFAULT_ACCOUNTS.find((a) => a.kode === k)).toMatchObject({ kategori: 'ASET', normalBalance: 'DEBIT' });
    }
  });

  describe('DB', () => {
    pakaiDb();
    const bagian = async (key: string) => {
      const calk = await generateCALK(testDb as never, '2026-01-01', '2026-12-31');
      return calk.sections.find((s) => s.sectionKey === key)!.konten;
    };

    it('catatan 5 hanya piutang pinjaman; piutang hasil investasi (1-1220/1-1240/1-1250) diungkap di catatan 11', async () => {
      await seedJurnal('j-cair', '2026-02-01', 'PENCAIRAN_PINJAMAN', [['1-1200', 12_000_000, 0], ['1-1000', 0, 12_000_000]]);
      await seedJurnal('j-shu', '2026-02-15', 'BAGIAN_SHU_INVESTASI', [['1-1220', 7_500_000, 0], ['4-1300', 0, 7_500_000]]);
      await seedJurnal('j-bh', '2026-03-15', 'JURNAL_UMUM', [['1-1240', 1_100_000, 0], ['4-1700', 0, 1_100_000]]);
      await seedJurnal('j-sewa', '2026-03-16', 'JURNAL_UMUM', [['1-1250', 900_000, 0], ['4-1600', 0, 900_000]]);
      const lima = await bagian('piutang');
      expect(lima).toContain('Piutang Pinjaman Anggota: Rp12.000.000.');
      for (const nama of ['Piutang Pendapatan Investasi', 'Piutang Bagi Hasil', 'Piutang Pendapatan Sewa']) expect(lima).not.toContain(nama);
      const sebelas = await bagian('investasi');
      expect(sebelas).toContain(
        'Piutang hasil investasi: Piutang Pendapatan Investasi: Rp7.500.000; Piutang Bagi Hasil: Rp1.100.000; Piutang Pendapatan Sewa: Rp900.000.'
      );
      // Posisi Keuangan tidak berubah: ketiga piutang tetap tersaji sebagai aset.
      const posisi = await getPosisiKeuangan(testDb as never, '2026-12-31');
      expect([saldoPosisi(posisi.aset, '1-1220'), saldoPosisi(posisi.aset, '1-1240'), saldoPosisi(posisi.aset, '1-1250')]).toEqual([7_500_000, 1_100_000, 900_000]);
    });

    it('catatan 11: nilai tercatat investasi = biaya − akumulasi penyusutan properti − penurunan nilai (= getNilaiTercatatInvestasi)', async () => {
      const id = await propertiDisusutkanDanImpair();
      const sebelas = await bagian('investasi');
      expect(sebelas).toContain('Total investasi aktif (biaya perolehan): Rp300.000.000 (1 penempatan).');
      expect(sebelas).toContain('Akumulasi penyusutan properti investasi: Rp6.000.000.');
      expect(sebelas).toContain('Penurunan nilai investasi: Rp10.000.000.');
      expect(sebelas).toContain('Nilai tercatat setelah akumulasi penyusutan dan penurunan nilai: Rp284.000.000.');
      const nt = await getNilaiTercatatInvestasi(testDb as never, id);
      expect(nt.nilaiTercatat).toBe(284_000_000);
      // Per 31-03 (sebelum impairment): penyusutan saja — penyusutan periode SESUDAH
      // tanggal laporan (April–Mei) tidak boleh ikut dikurangkan.
      for (const periode of ['2026-04', '2026-05']) {
        await prosesPenyusutanPropertiInvestasi({ investasiId: id, periode, createdBy: USER });
      }
      const calkMaret = await generateCALK(testDb as never, '2026-01-01', '2026-03-31');
      const sebelasMaret = calkMaret.sections.find((s) => s.sectionKey === 'investasi')!.konten;
      expect(sebelasMaret).toContain('Tidak ada penurunan nilai investasi yang tercatat pada periode ini. Nilai tercatat setelah akumulasi penyusutan: Rp294.000.000.');
    });

    it('kontrol: tanpa penyusutan properti, teks catatan 11 identik dengan format sebelumnya', async () => {
      await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP Sekunder', jumlah: 8_000_000, tanggal: '2026-01-10', sumberDana: 'KAS', createdBy: USER });
      const sebelas = await bagian('investasi');
      expect(sebelas).toContain('Total investasi aktif (nilai tercatat sebelum penurunan nilai): Rp8.000.000 (1 penempatan). Tidak ada penurunan nilai investasi yang tercatat pada periode ini. ');
      expect(sebelas).not.toMatch(/Akumulasi penyusutan|Piutang hasil investasi/);
    });

    it('CALK & diagnostik penyajian tidak menulis database', async () => {
      await propertiDisusutkanDanImpair();
      await seedJurnal('j-shu', '2026-02-15', 'BAGIAN_SHU_INVESTASI', [['1-1220', 7_500_000, 0], ['4-1300', 0, 7_500_000]]);
      const awal = await snapshotDb();
      await generateCALK(testDb as never, '2026-01-01', '2026-12-31');
      const temuan = await diagnosaPenyajianCoaItem14(testDb as never, '2026-12-31');
      await getDampakHistorisCoa(testDb as never);
      expect(await snapshotDb()).toEqual(awal);
      expect(temuan.map((t) => `${t.kode}:${t.akun}:${t.saldo}:${t.koreksiDeterministik}`)).toEqual([
        'PIUTANG_HASIL_INVESTASI_BERSALDO:1-1220:7500000:true',
        'PENYUSUTAN_PROPERTI_INVESTASI_BERSALDO:1-1670:6000000:true',
      ]);
    });
  });
});

// ===========================================================================
// §8 / §10 — HISTORI & SCOPE
// ===========================================================================

describe('RC-S54 T15 #14 — histori & scope', () => {
  it('dampak historis: total debit/kredit & tanggal awal/akhir tersedia (read-only)', () => {
    const src = tanpaKomentar(baca('src/services/CoaResolutionService.ts'));
    expect(src).not.toMatch(/INSERT INTO|UPDATE \w+ SET|DELETE FROM|createJournal|withTransaction|runAsync/);
    expect(src).toMatch(/totalDebit/);
    expect(src).toMatch(/tanggalAkhir/);
  });

  describe('DB', () => {
    pakaiDb();
    it('getDampakHistorisCoa: field baru terisi dan konsisten dengan saldo', async () => {
      await seedJurnal('j-shu', '2026-02-15', 'BAGIAN_SHU_INVESTASI', [['1-1220', 7_500_000, 0], ['4-1300', 0, 7_500_000]]);
      await seedJurnal('j-shu-kas', '2026-03-01', 'BAGIAN_SHU_PENERIMAAN', [['1-1000', 5_000_000, 0], ['1-1220', 0, 5_000_000]]);
      const d = await getDampakHistorisCoa(testDb as never);
      expect(d.akunTerkait.find((x) => x.kode === '1-1220')).toMatchObject({
        jumlahJurnal: 2, totalDebit: 7_500_000, totalKredit: 5_000_000, tanggalAwal: '2026-02-15', tanggalAkhir: '2026-03-01', saldo: 2_500_000,
      });
      expect(d.kodeDiminta.every((x) => x.totalDebit === 0 && x.tanggalAwal === null)).toBe(true);
    });
  });

  it('NO MIGRATION — schema v65; AccountingEngine & modul EIR/penyusutan/bagian SHU tidak mengacu hasil tahap ini', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL). · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini — invarian yang dijaga test ini (modul di bawah tidak menulis DB / tidak mengacu hasil tahap ini) TIDAK berubah. · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    for (const f of [
      'src/accounting/AccountingEngine.ts', 'src/services/EirAccountingService.ts', 'src/accounting/EirFeeInvariant.ts',
      'src/services/PenyusutanPropertiInvestasiService.ts', 'src/services/BagianShuService.ts', 'src/services/InvestasiService.ts',
    ]) {
      expect(baca(f)).not.toMatch(/KODE_PIUTANG_HASIL_INVESTASI|diagnosaPenyajianCoaItem14|RC-S54 TAHAP 15/);
    }
  });
});
