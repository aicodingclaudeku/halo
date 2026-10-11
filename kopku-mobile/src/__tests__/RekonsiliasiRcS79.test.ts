import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S79 — FINALISASI REKONSILIASI.
 *
 * Tiga gate:
 *  1. SERVICE memvalidasi penyebab × arah × jenis rekening × akun lawan
 *     (UI membantu memilih; service yang menolak).
 *  2. PeriodClose memeriksa rekonsiliasi PERIODE YANG DITUTUP — Juli
 *     tidak boleh menggantikan Agustus, September tidak boleh
 *     memenuhinya.
 *  3. UI memakai label kontekstual, bukan "Saldo Aktual".
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
  rekonsiliasiMenghalangiTutupPeriode,
  type PenyebabSelisih,
} from '@/services/CashReconciliationService';
import {
  labelSaldoEksternal,
  hintSaldoEksternal,
  penjelasanSelisih,
  labelSelisih,
  labelPenyebabRiwayat,
  LABEL_PENYEBAB_RIWAYAT,
  opsiPenyebabUntuk,
  perluPilihAkun,
  OPSI_PENYEBAB,
} from '@/utils/rekonsiliasiForm';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const USER = 'user-1';
const ACC = {
  kas: 'acc-kas', bank: 'acc-bank',
  beban: 'acc-beban', pendapatan: 'acc-pendapatan',
  aset: 'acc-aset', bebanNonAktif: 'acc-beban-off',
};

async function seed(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  const akun = async (id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT', aktif = 1) =>
    db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)`,
      id, kode, nama, kat, nb, aktif, now, now
    );
  await akun(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await akun(ACC.bank, '1-1100', 'Bank Operasional', 'ASET', 'DEBIT');
  await akun(ACC.beban, '5-9000', 'Beban Administrasi Bank', 'BEBAN', 'DEBIT');
  await akun(ACC.pendapatan, '4-9000', 'Pendapatan Jasa Giro', 'PENDAPATAN', 'KREDIT');
  await akun(ACC.aset, '1-3000', 'Perlengkapan', 'ASET', 'DEBIT');
  await akun(ACC.bebanNonAktif, '5-9900', 'Beban Lama', 'BEBAN', 'DEBIT', 0);

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
/** Siapkan satu baris SELISIH siap diselesaikan. */
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

const selesai = (id: string, o: any) =>
  selesaikanRekonsiliasi({ rekonsiliasiId: id, createdBy: USER, catatan: 'pemeriksaan RC-S79', ...o });

beforeEach(async () => {
  testDb = await seed();
  seq = 0;
});

// ===========================================================================
// 1. SERVICE GUARDS (§8)
// ===========================================================================

describe('RC-S79 — service memvalidasi penyebab × arah × rekening × akun', () => {
  /** Setiap penolakan wajib meninggalkan database persis seperti semula. */
  async function tolak(id: string, o: any, pola: RegExp) {
    const sebelum = await potret();
    await expect(selesai(id, o)).rejects.toThrow(pola);
    expect(await potret()).toBe(sebelum);
  }

  it('1. Bank + biaya bank + kurang → valid, jurnal seimbang Dr Beban / Cr Bank', async () => {
    const id = await baris(ACC.bank, -15_000);
    const r = await selesai(id, { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban });
    expect(r.journalId).not.toBeNull();
    const e = await testDb.getAllAsync<any>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.beban, debit: 15_000, kredit: 0 },
      { account_id: ACC.bank, debit: 0, kredit: 15_000 },
    ]);
    const j = await testDb.getFirstAsync<any>(`SELECT sumber_transaksi FROM journal WHERE id = ?`, r.journalId!);
    expect(j.sumber_transaksi).toBe('REKONSILIASI_KAS_BANK');
  });

  it('2. Bank + biaya bank + LEBIH → ditolak', async () => {
    await tolak(await baris(ACC.bank, 15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan },
      /selisih kurang/i);
  });

  it('3. Bank + jasa giro + lebih → valid, Dr Bank / Cr Pendapatan', async () => {
    const id = await baris(ACC.bank, 25_000);
    const r = await selesai(id, { penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan });
    const e = await testDb.getAllAsync<any>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.bank, debit: 25_000, kredit: 0 },
      { account_id: ACC.pendapatan, debit: 0, kredit: 25_000 },
    ]);
  });

  it('4. Bank + jasa giro + KURANG → ditolak', async () => {
    await tolak(await baris(ACC.bank, -25_000),
      { penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban },
      /selisih lebih/i);
  });

  it('5. Bank + kesalahan bank → tersimpan tanpa jurnal', async () => {
    const id = await baris(ACC.bank, -1_000_000);
    const r = await selesai(id, { penyebab: 'KESALAHAN_BANK', perlakuan: 'TIDAK_PERLU_JURNAL' });
    expect(r.journalId).toBeNull();
    expect(await testDb.getAllAsync<any>(`SELECT id FROM journal`)).toHaveLength(0);
  });

  it('6/7. Kas + selisih fisik dua arah → valid, akun mengikuti arah', async () => {
    const kurang = await selesai(await baris(ACC.kas, -50_000), {
      penyebab: 'SELISIH_FISIK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban,
    });
    expect(kurang.journalId).not.toBeNull();
    const lebih = await selesai(await baris(ACC.kas, 30_000), {
      penyebab: 'SELISIH_FISIK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan,
    });
    const e = await testDb.getAllAsync<any>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, lebih.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.kas, debit: 30_000, kredit: 0 },
      { account_id: ACC.pendapatan, debit: 0, kredit: 30_000 },
    ]);
  });

  it('8. Bank + selisih fisik → DITOLAK (penyebab khas kas)', async () => {
    await tolak(await baris(ACC.bank, -50_000),
      { penyebab: 'SELISIH_FISIK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban },
      /hanya berlaku untuk rekening kas/i);
  });

  // TIMING_DIFFERENCE sengaja TIDAK termasuk: setoran tunai yang belum
  // masuk pembukuan kas juga perbedaan waktu. Yang dibatasi service
  // hanya tiga penyebab yang benar-benar mustahil pada kas (§3 tiket).
  it.each([['BIAYA_ADMIN_BANK'], ['JASA_GIRO'], ['KESALAHAN_BANK']] as [PenyebabSelisih][])(
    '9/10. Kas + %s → DITOLAK (penyebab khas bank)',
    async (penyebab) => {
      const perluJurnal = penyebab === 'BIAYA_ADMIN_BANK' || penyebab === 'JASA_GIRO';
      await tolak(await baris(ACC.kas, penyebab === 'JASA_GIRO' ? 25_000 : -25_000), {
        penyebab,
        perlakuan: perluJurnal ? 'PERLU_JURNAL' : 'TIDAK_PERLU_JURNAL',
        ...(perluJurnal ? { akunLawanId: penyebab === 'JASA_GIRO' ? ACC.pendapatan : ACC.beban } : {}),
      }, /hanya berlaku untuk rekening bank/i);
    }
  );

  it.each([['TIMING_DIFFERENCE'], ['KESALAHAN_BANK'], ['LAINNYA'], ['TRANSAKSI_BELUM_TERCATAT'], ['SELISIH_PENCATATAN']] as [PenyebabSelisih][])(
    '11/12/13. %s + PERLU_JURNAL → DITOLAK',
    async (penyebab) => {
      await tolak(await baris(ACC.bank, -200_000),
        { penyebab, perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban },
        /tidak diselesaikan dengan jurnal/i);
    }
  );

  it('14. penyebab tanpa jurnal + akun lawan → DITOLAK (akun sisa pilihan lama)', async () => {
    await tolak(await baris(ACC.bank, -200_000),
      { penyebab: 'KESALAHAN_BANK', perlakuan: 'TIDAK_PERLU_JURNAL', akunLawanId: ACC.beban },
      /tidak memerlukan akun pencatatan/i);
  });

  it('15. penyebab penyesuaian TANPA akun → DITOLAK', async () => {
    await tolak(await baris(ACC.bank, -15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL' },
      /Akun lawan wajib/i);
  });

  it('16. kategori akun salah → DITOLAK; akun tidak aktif / tidak ada → DITOLAK', async () => {
    // Selisih kurang harus ke BEBAN — akun Pendapatan/Aset ditolak.
    await tolak(await baris(ACC.bank, -15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan },
      /akun Beban/i);
    await tolak(await baris(ACC.bank, -15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.aset },
      /akun Beban/i);
    // Selisih lebih harus ke PENDAPATAN.
    await tolak(await baris(ACC.bank, 25_000),
      { penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban },
      /akun Pendapatan/i);
    // Akun nonaktif & akun yang tidak ada.
    await tolak(await baris(ACC.bank, -15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.bebanNonAktif },
      /tidak aktif/i);
    await tolak(await baris(ACC.bank, -15_000),
      { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: 'tidak-ada' },
      /tidak ditemukan/i);
  });

  it('17. penyelesaian kedua ditolak; tidak ada jurnal duplikat', async () => {
    const id = await baris(ACC.bank, -15_000);
    await selesai(id, { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban });
    const sesudah = await potret();
    await expect(
      selesai(id, { penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban })
    ).rejects.toThrow(/sudah diselesaikan/i);
    expect(await potret()).toBe(sesudah);
  });
});

// ===========================================================================
// 2. PERIOD CLOSE — PERIODE SPESIFIK (§9)
// ===========================================================================

describe('RC-S79 — PeriodClose memeriksa rekonsiliasi PERIODE yang ditutup', () => {
  const AGT = ['2026-08-01', '2026-08-31'] as const;

  /** Rekening mana yang memblokir penutupan periode Agustus. */
  async function pemblokir() {
    const st = await getStatusRekonsiliasiPeriode(testDb as any, AGT[0], AGT[1]);
    return st
      .filter((r) => r.rekonsiliasi === null || rekonsiliasiMenghalangiTutupPeriode(r.rekonsiliasi))
      .map((r) => r.accountId);
  }

  async function tulis(accountId: string, tanggal: string, o: Partial<{
    selisih: number; penyelesaian: string; penyebab: string | null; perlakuan: string | null; journalId: string | null;
  }> = {}) {
    const selisih = o.selisih ?? 0;
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO rekonsiliasi_kas_bank
        (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
         status_penyelesaian, penyebab, perlakuan, journal_id, keterangan, created_by, created_at)
       VALUES (?,?,'Rek',?,0,?,?,?,?,?,?,?,'x',?,?)`,
      `r-${++seq}`, accountId, tanggal, selisih, selisih,
      selisih === 0 ? 'COCOK' : 'SELISIH',
      o.penyelesaian ?? 'SELESAI',
      o.penyebab ?? null, o.perlakuan ?? null, o.journalId ?? null, USER, now
    );
  }

  /** Kas & Bank sama-sama wajib; isi Kas agar fokus pada Bank. */
  const kasBeres = () => tulis(ACC.kas, '2026-08-31');

  it('A. rekonsiliasi Juli ada, Agustus TIDAK → BLOCK (Juli tidak menggantikan Agustus)', async () => {
    await tulis(ACC.bank, '2026-07-31');
    await kasBeres();
    expect(await pemblokir()).toEqual([ACC.bank]);
  });

  it('B. Agustus ada + COCOK + SELESAI → ALLOW', async () => {
    await tulis(ACC.bank, '2026-08-31');
    await kasBeres();
    expect(await pemblokir()).toEqual([]);
  });

  it('C. Agustus SELISIH + perbedaan waktu + SELESAI → ALLOW (status tetap SELISIH)', async () => {
    await tulis(ACC.bank, '2026-08-31', {
      selisih: -500_000, penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL',
    });
    await kasBeres();
    expect(await pemblokir()).toEqual([]);
    // Statusnya TIDAK diubah menjadi COCOK hanya agar lolos.
    const r = await testDb.getFirstAsync<any>(`SELECT status FROM rekonsiliasi_kas_bank WHERE account_id = ?`, ACC.bank);
    expect(r.status).toBe('SELISIH');
  });

  it.each([['TRANSAKSI_BELUM_TERCATAT'], ['SELISIH_PENCATATAN'], ['KESALAHAN_BANK']])(
    'D. Agustus SELISIH + %s + DRAFT → BLOCK',
    async (penyebab) => {
      await tulis(ACC.bank, '2026-08-31', { selisih: -200_000, penyelesaian: 'DRAFT', penyebab });
      await kasBeres();
      expect(await pemblokir()).toEqual([ACC.bank]);
    }
  );

  it('E. Agustus penyesuaian + SELESAI + journal valid → ALLOW', async () => {
    // Jurnal sungguhan: `journal_id` punya FK, jadi id karangan akan
    // ditolak database — dan itu memang benar.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, nomor_referensi, sumber_transaksi, sumber_id, deskripsi, status, created_by, created_at, updated_at)
       VALUES ('j-1','JV-RC79-1','2026-08-31','p2026','REK-1','REKONSILIASI_KAS_BANK',NULL,'penyesuaian','POSTED',?,?,?)`,
      USER, now, now
    );
    await tulis(ACC.bank, '2026-08-31', {
      selisih: -15_000, penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', journalId: 'j-1',
    });
    await kasBeres();
    expect(await pemblokir()).toEqual([]);
  });

  it('F. Agustus SELESAI + PERLU_JURNAL + journal NULL → BLOCK (tidak konsisten)', async () => {
    await tulis(ACC.bank, '2026-08-31', {
      selisih: -15_000, penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', journalId: null,
    });
    await kasBeres();
    expect(await pemblokir()).toEqual([ACC.bank]);
  });

  it('G. September sudah ada, Agustus DRAFT → tetap memakai Agustus → BLOCK', async () => {
    await tulis(ACC.bank, '2026-08-31', { selisih: -200_000, penyelesaian: 'DRAFT', penyebab: 'KESALAHAN_BANK' });
    await tulis(ACC.bank, '2026-09-30'); // COCOK di September
    await kasBeres();
    // September TIDAK boleh memenuhi penutupan Agustus.
    expect(await pemblokir()).toEqual([ACC.bank]);
  });

  it('H. dua pemeriksaan dalam Agustus → yang dipakai yang TERAKHIR dalam periode', async () => {
    await tulis(ACC.bank, '2026-08-10', { selisih: -200_000, penyelesaian: 'DRAFT', penyebab: 'KESALAHAN_BANK' });
    await tulis(ACC.bank, '2026-08-31'); // COCOK, lebih akhir
    await kasBeres();
    expect(await pemblokir()).toEqual([]);
    const st = await getStatusRekonsiliasiPeriode(testDb as any, AGT[0], AGT[1]);
    expect(st.find((r) => r.accountId === ACC.bank)!.rekonsiliasi!.tanggal).toBe('2026-08-31');
  });

  it('I. DRAFT lama (Juli) + Agustus COCOK → ALLOW, dan histori Juli tetap ada', async () => {
    await tulis(ACC.bank, '2026-07-15', { selisih: -200_000, penyelesaian: 'DRAFT', penyebab: 'KESALAHAN_BANK' });
    await tulis(ACC.bank, '2026-08-31');
    await kasBeres();
    expect(await pemblokir()).toEqual([]);
    expect(await testDb.getAllAsync<any>(`SELECT id FROM rekonsiliasi_kas_bank WHERE tanggal = '2026-07-15'`)).toHaveLength(1);
  });

  it('rekening kas/bank aktif yang BELUM pernah diperiksa pada periode itu → BLOCK', async () => {
    // Tidak ada baris sama sekali: keduanya wajib, keduanya memblokir.
    expect((await pemblokir()).sort()).toEqual([ACC.bank, ACC.kas].sort());
  });

  it('§11 — membaca status 10x tidak mengubah database', async () => {
    await tulis(ACC.bank, '2026-08-31', { selisih: -500_000, penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL' });
    const sebelum = await potret();
    for (let i = 0; i < 10; i++) await getStatusRekonsiliasiPeriode(testDb as any, AGT[0], AGT[1]);
    expect(await potret()).toBe(sebelum);
  });
});

// ===========================================================================
// 3. UI (§10)
// ===========================================================================

describe('RC-S79 — UI', () => {
  const layar = tanpaKomentar(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'));

  it('label saldo eksternal kontekstual; "Saldo Aktual" tidak lagi jadi label utama', () => {
    expect(labelSaldoEksternal('BANK')).toBe('Saldo Menurut Rekening Koran');
    expect(labelSaldoEksternal('KAS')).toBe('Hasil Kas Opname');
    expect(labelSaldoEksternal('KAS_KECIL')).toBe('Hasil Kas Opname');
    expect(hintSaldoEksternal('BANK')).toMatch(/rekening koran/i);
    expect(hintSaldoEksternal('KAS')).toMatch(/kas opname/i);
    expect(layar).not.toMatch(/SALDO AKTUAL|Saldo Aktual/);
    expect(layar).toContain('labelSaldoEksternal(rekening.jenis)');
  });

  it('headline selisih tanpa angka negatif, disertai penjelasan arah', () => {
    expect(labelSelisih(-15_000)).toEqual({ judul: 'Selisih Kurang', nilai: 15_000 });
    expect(labelSelisih(15_000)).toEqual({ judul: 'Selisih Lebih', nilai: 15_000 });
    expect(penjelasanSelisih(-1)).toBe('Saldo eksternal lebih kecil dari saldo buku.');
    expect(penjelasanSelisih(1)).toBe('Saldo eksternal lebih besar dari saldo buku.');
    expect(penjelasanSelisih(0)).toBe('Saldo buku dan saldo eksternal sama.');
    expect(layar).toContain('penjelasanSelisih(selisih)');
  });

  it('daftar penyebab sesuai jenis rekening, dan AccountPicker hanya untuk penyebab penyesuaian', () => {
    expect(opsiPenyebabUntuk(-1, 'KAS').map((o) => o.kode)).not.toContain('BIAYA_BANK');
    expect(opsiPenyebabUntuk(-1, 'BANK').map((o) => o.kode)).not.toContain('SELISIH_KAS_FISIK');
    for (const kode of ['BELUM_TERCATAT', 'SALAH_PENCATATAN', 'PERBEDAAN_WAKTU', 'KESALAHAN_BANK', 'LAINNYA']) {
      expect(perluPilihAkun(OPSI_PENYEBAB.find((o) => o.kode === kode)!)).toBe(false);
    }
    for (const kode of ['BIAYA_BANK', 'JASA_GIRO', 'SELISIH_KAS_FISIK']) {
      expect(perluPilihAkun(OPSI_PENYEBAB.find((o) => o.kode === kode)!)).toBe(true);
    }
  });

  it('tidak ada enum teknis yang bocor sebagai teks UI', () => {
    for (const t of ['PERLU_JURNAL', 'TIDAK_PERLU_JURNAL', 'TIMING_DIFFERENCE', 'SELISIH_FISIK', 'BIAYA_ADMIN_BANK']) {
      expect(layar).not.toContain(t);
    }
  });

  it('§2E — riwayat menampilkan penyebab + penyelesaian, dengan label manusia', () => {
    // Setiap penyebab database punya label baca-manusia; enum tidak bocor.
    for (const p of Object.keys(LABEL_PENYEBAB_RIWAYAT)) {
      const label = labelPenyebabRiwayat(p as any)!;
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/_/); // bukan enum
    }
    expect(labelPenyebabRiwayat('TIMING_DIFFERENCE')).toBe('Perbedaan Waktu');
    expect(labelPenyebabRiwayat('BIAYA_ADMIN_BANK')).toBe('Biaya Bank');
    expect(labelPenyebabRiwayat(null)).toBeNull(); // COCOK: tidak ada penyebab

    // Layar benar-benar merendernya, dan label saldo eksternal di riwayat
    // juga kontekstual.
    expect(layar).toContain('labelPenyebabRiwayat(r.penyebab)');
    expect(layar).toContain('labelStatusRiwayat(r)');
    expect(layar).toMatch(/labelSaldoEksternal\(rekening\.jenis\)[\s\S]{0,80}formatRupiah\(r\.saldoFisik\)/);
    // "Aktual" sebagai label riwayat sudah tidak dipakai.
    expect(layar).not.toMatch(/· Aktual \{formatRupiah/);
  });

  it('layar tidak melakukan mutasi SQL/jurnal sendiri', () => {
    for (const t of ['createJournal', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'withTransaction(', 'getDb(']) {
      expect(layar).not.toContain(t);
    }
  });
});
