import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S80 — tiga perbaikan terakhir Rekonsiliasi:
 *  1. CTA "Simpan Temuan & Buka ..." menyimpan DULU, baru berpindah.
 *  2. PeriodClose membawa NOMINAL selisih aktual, bukan penanda `1`.
 *  3. Akun khusus Biaya Bank / Jasa Giro / Selisih Kas: tidak ada
 *     mapping khusus di source, jadi akun WAJIB dipilih eksplisit dan
 *     divalidasi service — tidak pernah dipilihkan otomatis.
 */

let testDb: TestDb;

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

import {
  selesaikanRekonsiliasi,
  getStatusRekonsiliasiPeriode,
} from '@/services/CashReconciliationService';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const LAYAR = 'src/screens/Akuntansi/RekonsiliasiScreen.tsx';
const SERVICE = 'src/services/CashReconciliationService.ts';
const PERIODCLOSE = 'src/services/PeriodCloseService.ts';

const USER = 'user-1';
const ACC = { kas: 'acc-kas', bank: 'acc-bank', beban: 'acc-beban', pendapatan: 'acc-pendapatan', aset: 'acc-aset' };

async function seed(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  const akun = async (id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') =>
    db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, nama, kat, nb, now, now
    );
  await akun(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await akun(ACC.bank, '1-1100', 'Bank Operasional', 'ASET', 'DEBIT');
  await akun(ACC.beban, '5-9000', 'Beban Administrasi Bank', 'BEBAN', 'DEBIT');
  await akun(ACC.pendapatan, '4-9000', 'Pendapatan Jasa Giro', 'PENDAPATAN', 'KREDIT');
  await akun(ACC.aset, '1-3000', 'Perlengkapan', 'ASET', 'DEBIT');
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m-kas','KAS_UMUM','DEFAULT',?)`, ACC.kas
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES ('bank-1','BCA','12345','Koperasi',0,?,1,?)`, ACC.bank, now
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES (?,'Admin','admin','ADMIN','x','x',0,1,?,?)`, USER, now, now
  );
  return db;
}

let seq = 0;
async function baris(accountId: string, selisih: number, tanggal = '2026-08-31'): Promise<string> {
  const id = `rek-${++seq}`;
  const now = new Date().toISOString();
  const buku = selisih < 0 ? Math.abs(selisih) : 0;
  await testDb.runAsync(
    `INSERT INTO rekonsiliasi_kas_bank
      (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
       status_penyelesaian, created_by, created_at)
     VALUES (?,?,?,?,?,?,?, 'SELISIH','DRAFT',?,?)`,
    id, accountId, accountId === ACC.bank ? 'Bank Operasional' : 'Kas',
    tanggal, buku, buku + selisih, selisih, USER, now
  );
  return id;
}

async function potret() {
  return JSON.stringify({
    journal: await testDb.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`),
    journal_entry: await testDb.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`),
    rekonsiliasi: await testDb.getAllAsync<any>(`SELECT * FROM rekonsiliasi_kas_bank ORDER BY id`),
  });
}

beforeEach(async () => {
  testDb = await seed();
  seq = 0;
});

// ===========================================================================
// A/B/C — SAVE FIRST, NAVIGATE SECOND (§2)
// ===========================================================================

describe('RC-S80 — CTA menyimpan dulu, baru berpindah layar', () => {
  const layar = tanpaKomentar(baca(LAYAR));

  it('A/C — navigasi HANYA terjadi setelah simpan() berhasil', () => {
    // DIPERBARUI (perbaikan UI rekonsiliasi pasca RC-S81): tombol utama kini
    // hanya menyimpan; berpindah layar menjadi PINTASAN yang dirender HANYA
    // di kartu hasil (`hasilTerakhir`), dan kartu itu baru ada setelah
    // simpan() berhasil. Invariant yang dijaga tetap sama: tidak ada
    // navigasi sebelum temuan tersimpan.
    const cta = layar.slice(layar.indexOf('const jalankanCta'), layar.indexOf('const bukaPintasan'));
    expect(cta).toMatch(/if \(cta\.aksi === 'SIMPAN'\) \{\s*void simpan\(\);\s*return;\s*\}/);
    expect(cta).not.toContain('navigation.navigate');
    // navigate hanya di bukaPintasan, dan bukaPintasan hanya dipanggil dari kartu hasil.
    expect((layar.match(/navigation\.navigate\(/g) ?? []).length).toBe(2);
    expect(layar).toMatch(/hasilTerakhir\.pintasan && bukaPintasan\(hasilTerakhir\.pintasan\.tujuan\)/);
    expect((layar.match(/bukaPintasan\(/g) ?? []).length).toBe(1);
    // hasilTerakhir hanya diisi di jalur sukses simpan(), sebelum `return true`.
    expect(layar).toMatch(/setHasilTerakhir\(\{\s*jenis,[\s\S]*?await Promise\.all\(\[loadHistori\(\), muatSaldo\(\)\]\);\s*return true;/);
  });

  it('B — simpan() melaporkan keberhasilan, dan jalur gagal mengembalikan false', () => {
    // Kontraknya eksplisit: boolean, bukan void — itulah yang membuat
    // "jangan pindah kalau gagal" bisa ditegakkan.
    expect(layar).toContain('const simpan = async (): Promise<boolean> => {');
    // Ditolak single-flight & exception sama-sama BUKAN keberhasilan.
    expect(layar).toMatch(/if \(r\.status === 'DIABAIKAN'\) return false;/);
    expect(layar).toMatch(/notify\('Rekonsiliasi gagal disimpan', pesanOperator\(e\)\);\s*return false;/);
    // Jalur sukses satu-satunya.
    expect(layar).toMatch(/await Promise\.all\(\[loadHistori\(\), muatSaldo\(\)\]\);\s*return true;/);
    // Guard awal (form belum siap) juga bukan keberhasilan.
    expect(layar).toMatch(/kunci\.current\.sibuk\) return false;/);
  });

  it('CTA "SIMPAN" biasa tidak ikut menavigasi', () => {
    expect(layar).toMatch(/if \(cta\.aksi === 'SIMPAN'\) \{\s*void simpan\(\);\s*return;\s*\}/);
  });
});

// ===========================================================================
// D/E — PERIOD CLOSE NOMINAL & SCOPE (§3)
// ===========================================================================

describe('RC-S80 — PeriodClose memakai nominal selisih aktual', () => {
  async function tulis(accountId: string, tanggal: string, selisih: number, o: any = {}) {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO rekonsiliasi_kas_bank
        (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
         status_penyelesaian, penyebab, perlakuan, journal_id, keterangan, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'x',?,?)`,
      `r-${++seq}`, accountId, accountId === ACC.bank ? 'Bank Operasional' : 'Kas', tanggal,
      selisih < 0 ? Math.abs(selisih) : 0, selisih < 0 ? 0 : selisih, selisih,
      selisih === 0 ? 'COCOK' : 'SELISIH',
      o.penyelesaian ?? 'DRAFT', o.penyebab ?? null, o.perlakuan ?? null, o.journalId ?? null,
      USER, now
    );
  }

  it('D — kekurangan kas Rp150.000 dilaporkan Rp150.000, bukan penanda Rp1', async () => {
    await tulis(ACC.kas, '2026-08-31', -150_000, { penyebab: 'SELISIH_FISIK' });
    await tulis(ACC.bank, '2026-08-31', 0, { penyelesaian: 'SELESAI' });

    const st = await getStatusRekonsiliasiPeriode(testDb as any, '2026-08-01', '2026-08-31');
    const kas = st.find((r) => r.accountId === ACC.kas)!;
    expect(kas.rekonsiliasi!.selisih).toBe(-150_000);
    // Penanda `1` tidak boleh muncul sebagai nominal di mana pun.
    expect(kas.rekonsiliasi!.selisih).not.toBe(1);
    expect(tanpaKomentar(baca(PERIODCLOSE))).not.toMatch(/=== 'SELISIH' \? 1 : 0/);
    expect(tanpaKomentar(baca(PERIODCLOSE))).toContain('selisih: r.rekonsiliasi?.selisih ?? 0');
  });

  it('selisih lebih terbawa dengan tanda positif; COCOK tetap 0', async () => {
    await tulis(ACC.bank, '2026-08-31', 25_000, { penyebab: 'JASA_GIRO' });
    await tulis(ACC.kas, '2026-08-31', 0, { penyelesaian: 'SELESAI' });
    const st = await getStatusRekonsiliasiPeriode(testDb as any, '2026-08-01', '2026-08-31');
    expect(st.find((r) => r.accountId === ACC.bank)!.rekonsiliasi!.selisih).toBe(25_000);
    expect(st.find((r) => r.accountId === ACC.kas)!.rekonsiliasi!.selisih).toBe(0);
  });

  it('E — periode Agustus tidak memakai Juli maupun September', async () => {
    await tulis(ACC.bank, '2026-07-31', -700_000, { penyelesaian: 'SELESAI', penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL' });
    await tulis(ACC.bank, '2026-08-31', -150_000, { penyebab: 'SELISIH_PENCATATAN' });
    await tulis(ACC.bank, '2026-09-30', -900_000, { penyelesaian: 'SELESAI', penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL' });

    const st = await getStatusRekonsiliasiPeriode(testDb as any, '2026-08-01', '2026-08-31');
    const bank = st.find((r) => r.accountId === ACC.bank)!;
    expect(bank.rekonsiliasi!.tanggal).toBe('2026-08-31');
    expect(bank.rekonsiliasi!.selisih).toBe(-150_000); // bukan -700.000 / -900.000
  });

  it('G — membaca status 10x tidak mengubah database', async () => {
    await tulis(ACC.kas, '2026-08-31', -150_000, { penyebab: 'SELISIH_FISIK' });
    const sebelum = await potret();
    for (let i = 0; i < 10; i++) await getStatusRekonsiliasiPeriode(testDb as any, '2026-08-01', '2026-08-31');
    expect(await potret()).toBe(sebelum);
  });
});

// ===========================================================================
// F — SPECIAL ACCOUNT MAPPING (§4)
// ===========================================================================

describe('RC-S80 — akun khusus: tidak ada mapping, jadi wajib dipilih & divalidasi', () => {
  const selesai = (id: string, o: any) =>
    selesaikanRekonsiliasi({ rekonsiliasiId: id, createdBy: USER, catatan: 'ref RK-08', ...o });

  async function tolak(id: string, o: any, pola: RegExp) {
    const sebelum = await potret();
    await expect(selesai(id, o)).rejects.toThrow(pola);
    expect(await potret()).toBe(sebelum); // H — rejection byte-identical
  }

  it('AUDIT — tidak ada mapping khusus rekonsiliasi di COA default, dan service tidak memilihkan akun', () => {
    const coa = baca('src/config/defaultCOA.ts');
    // Tidak ada transaction_type khusus untuk penyesuaian rekonsiliasi.
    for (const t of ['REKONSILIASI', 'BIAYA_ADMIN_BANK', 'JASA_GIRO', 'SELISIH_FISIK']) {
      expect(coa).not.toContain(`transactionType: '${t}'`);
    }
    // Karena itu service TIDAK boleh menebak: tidak ada fallback akun.
    const svc = tanpaKomentar(baca(SERVICE));
    expect(svc).not.toMatch(/akunLawanId \?\?|akunLawanId \|\||resolveAkunDefault|akunDefault/);
  });

  it('F — akun valid sesuai arah → jurnal seimbang', async () => {
    const r = await selesai(await baris(ACC.bank, -15_000), {
      penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban,
    });
    const e = await testDb.getAllAsync<any>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.beban, debit: 15_000, kredit: 0 },
      { account_id: ACC.bank, debit: 0, kredit: 15_000 },
    ]);
  });

  it('F — tanpa akun → ditolak (tidak ada auto-select yang menutupi)', async () => {
    await tolak(await baris(ACC.bank, -15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL' }, /Akun lawan wajib/i);
    await tolak(await baris(ACC.bank, 25_000),
      { penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL' }, /Akun lawan wajib/i);
    await tolak(await baris(ACC.kas, -50_000),
      { penyebab: 'SELISIH_FISIK', perlakuan: 'PERLU_JURNAL' }, /Akun lawan wajib/i);
  });

  it('F — kategori akun salah → ditolak untuk ketiga penyebab penyesuaian', async () => {
    await tolak(await baris(ACC.bank, -15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.aset }, /akun Beban/i);
    await tolak(await baris(ACC.bank, 25_000),
      { penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban }, /akun Pendapatan/i);
    await tolak(await baris(ACC.kas, -50_000),
      { penyebab: 'SELISIH_FISIK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan }, /akun Beban/i);
    await tolak(await baris(ACC.kas, 50_000),
      { penyebab: 'SELISIH_FISIK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban }, /akun Pendapatan/i);
  });

  it('F — jenis rekening & arah tetap dijaga; penyebab non-jurnal tetap tolak akun', async () => {
    await tolak(await baris(ACC.kas, -15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban },
      /hanya berlaku untuk rekening bank/i);
    await tolak(await baris(ACC.bank, -50_000),
      { penyebab: 'SELISIH_FISIK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban },
      /hanya berlaku untuk rekening kas/i);
    await tolak(await baris(ACC.bank, 15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan },
      /selisih kurang/i);
    await tolak(await baris(ACC.bank, -200_000),
      { penyebab: 'KESALAHAN_BANK', perlakuan: 'TIDAK_PERLU_JURNAL', akunLawanId: ACC.beban },
      /tidak memerlukan akun pencatatan/i);
  });
});
