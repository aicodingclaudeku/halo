import { createTestDb, TestDb } from './testDb';

/**
 * RC-S78 — REKONSILIASI KAS & BANK.
 *
 * Tiga lapis:
 *  1. MIGRASI v70 → v71 (preservasi histori, idempotensi, FK).
 *  2. MATRIKS PERLAKUAN di service (kombinasi ilegal ditolak).
 *  3. SEMANTIK PeriodClose + skenario lapangan (SQLite sungguhan).
 *
 * Rekonsiliasi di sini diperlakukan sebagai kontrol internal untuk
 * mendukung keandalan saldo Kas/Bank, ketepatan pencatatan, dan
 * dokumentasi penyelesaian perbedaan — BUKAN alat untuk memaksa saldo
 * buku menyamai saldo eksternal.
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

import { runMigrations } from '@/database/db';
import {
  catatRekonsiliasiDanTindakLanjut,
  selesaikanRekonsiliasi,
  getRekonsiliasiTerakhirPerAkun,
  rekonsiliasiMenghalangiTutupPeriode,
  PERLAKUAN_SAH,
  PENYEBAB_SELISIH,
  type PenyebabSelisih,
} from '@/services/CashReconciliationService';

const USER = 'user-1';
const ACC = { kas: 'acc-kas', bank: 'acc-bank', beban: 'acc-beban', pendapatan: 'acc-pendapatan' };

async function seed(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  const akun = async (id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') =>
    db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, nama, kat, nb, now, now
    );
  await akun(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await akun(ACC.bank, '1-1100', 'Bank BCA', 'ASET', 'DEBIT');
  await akun(ACC.beban, '5-9000', 'Beban Administrasi Bank', 'BEBAN', 'DEBIT');
  await akun(ACC.pendapatan, '4-9000', 'Pendapatan Lain', 'PENDAPATAN', 'KREDIT');
  // Rekonsiliasi hanya menerima akun yang MEMANG Kas/Bank: kas lewat
  // account_mapping KAS_UMUM, bank lewat baris bank_account.
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m-kas','KAS_UMUM','DEFAULT',?)`,
    ACC.kas
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES ('bank-1','BCA','12345','Koperasi',0,?,1,?)`,
    ACC.bank, now
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

/**
 * Saldo buku = 0 (fixture tidak punya jurnal), jadi saldo aktual yang
 * disetor SAMA DENGAN selisih yang diinginkan. `saldoFisik` tidak boleh
 * negatif, jadi untuk skenario "selisih kurang" dipakai saldo buku
 * semu: baris rekonsiliasi dicatat dengan saldo aktual apa adanya dan
 * selisihnya diverifikasi dari hasilnya.
 */
function rek(accountId: string, nama: string, saldoAktual: number) {
  return { accountId, namaRekening: nama, tanggal: '2026-08-31', saldoFisik: saldoAktual, createdBy: USER };
}

/**
 * Untuk selisih KURANG, saldo buku harus lebih besar dari saldo aktual.
 * Fixture tidak punya jurnal (saldo buku 0), jadi selisih negatif dibuat
 * lewat baris rekonsiliasi yang ditulis langsung — jalur service diuji
 * terpisah lewat `selesaikanRekonsiliasi`.
 */
async function baris(
  db: TestDb,
  id: string,
  accountId: string,
  selisih: number
): Promise<string> {
  const now = new Date().toISOString();
  const buku = selisih < 0 ? Math.abs(selisih) : 0;
  const fisik = buku + selisih;
  await db.runAsync(
    `INSERT INTO rekonsiliasi_kas_bank
      (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
       status_penyelesaian, created_by, created_at)
     VALUES (?,?,'Rekening',?,?,?,?, 'SELISIH','DRAFT',?,?)`,
    id, accountId, '2026-08-31', buku, fisik, selisih, USER, now
  );
  return id;
}

async function potret(db: TestDb) {
  return JSON.stringify({
    journal: await db.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`),
    journal_entry: await db.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`),
    rekonsiliasi: await db.getAllAsync<any>(`SELECT * FROM rekonsiliasi_kas_bank ORDER BY id`),
  });
}

// ===========================================================================
// 1. MIGRASI v71
// ===========================================================================

describe('RC-S78 — migrasi v71 (dua penyebab baru)', () => {
  const NOW = '2026-01-01T00:00:00.000Z';

  /** Instalasi v70: CHECK `penyebab` BELUM memuat dua enum baru. */
  async function pasangV70(db: TestDb) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
    );
    await db.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 70)`);
    await db.execAsync(`
      DROP TABLE IF EXISTS rekonsiliasi_kas_bank;
      CREATE TABLE rekonsiliasi_kas_bank (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES account(id),
        nama_rekening TEXT NOT NULL,
        tanggal TEXT NOT NULL,
        saldo_buku INTEGER NOT NULL,
        saldo_fisik INTEGER NOT NULL,
        selisih INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('COCOK','SELISIH')),
        status_penyelesaian TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (status_penyelesaian IN ('DRAFT','SELESAI')),
        penyebab TEXT CHECK (penyebab IN
          ('TIMING_DIFFERENCE','BIAYA_ADMIN_BANK','JASA_GIRO','SELISIH_PENCATATAN','SELISIH_FISIK','LAINNYA')),
        perlakuan TEXT CHECK (perlakuan IN ('TIDAK_PERLU_JURNAL','PERLU_JURNAL')),
        journal_id TEXT REFERENCES journal(id),
        diselesaikan_oleh TEXT,
        diselesaikan_at TEXT,
        keterangan TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    await db.runAsync(
      `INSERT INTO rekonsiliasi_kas_bank
        (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
         status_penyelesaian, penyebab, perlakuan, journal_id, diselesaikan_oleh,
         diselesaikan_at, keterangan, created_by, created_at)
       VALUES ('rek-lama', ?, 'Bank BCA', '2026-07-31', 20000000, 19800000, -200000, 'SELISIH',
               'SELESAI', 'TIMING_DIFFERENCE', 'TIDAK_PERLU_JURNAL', NULL, ?, ?, 'cek no. 12', ?, ?)`,
      ACC.bank, USER, NOW, USER, NOW
    );
  }

  beforeEach(async () => {
    testDb = await seed();
    await pasangV70(testDb);
  });

  it('v70 memang menolak enum baru — membuktikan migrasi ini memang diperlukan', async () => {
    await expect(
      testDb.runAsync(
        `UPDATE rekonsiliasi_kas_bank SET penyebab = 'KESALAHAN_BANK' WHERE id = 'rek-lama'`
      )
    ).rejects.toThrow();
  });

  it('baris historis utuh setelah upgrade: SELURUH kolom identik, id tidak berubah', async () => {
    const sebelum = await testDb.getFirstAsync<any>(`SELECT * FROM rekonsiliasi_kas_bank WHERE id = 'rek-lama'`);
    await runMigrations(testDb as any);
    const sesudah = await testDb.getFirstAsync<any>(`SELECT * FROM rekonsiliasi_kas_bank WHERE id = 'rek-lama'`);
    expect(sesudah).toEqual(sebelum); // termasuk journal_id, diselesaikan_*, keterangan
    expect(await testDb.getAllAsync<any>(`SELECT id FROM rekonsiliasi_kas_bank`)).toEqual([{ id: 'rek-lama' }]);
  });

  it('CHECK baru menerima TRANSAKSI_BELUM_TERCATAT & KESALAHAN_BANK, dan tetap menolak nilai ngawur', async () => {
    await runMigrations(testDb as any);
    for (const p of ['TRANSAKSI_BELUM_TERCATAT', 'KESALAHAN_BANK']) {
      await expect(
        testDb.runAsync(`UPDATE rekonsiliasi_kas_bank SET penyebab = ? WHERE id = 'rek-lama'`, p)
      ).resolves.toBeDefined();
    }
    await expect(
      testDb.runAsync(`UPDATE rekonsiliasi_kas_bank SET penyebab = 'NGAWUR' WHERE id = 'rek-lama'`)
    ).rejects.toThrow();
  });

  it('idempoten: dijalankan dua kali tidak menduplikasi atau mengubah baris', async () => {
    await runMigrations(testDb as any);
    const pertama = await testDb.getAllAsync<any>(`SELECT * FROM rekonsiliasi_kas_bank ORDER BY id`);
    await runMigrations(testDb as any);
    expect(await testDb.getAllAsync<any>(`SELECT * FROM rekonsiliasi_kas_bank ORDER BY id`)).toEqual(pertama);
  });

  it('index dibuat ulang, tabel sementara tidak tertinggal, FK bersih, versi >= 71', async () => {
    await runMigrations(testDb as any);
    const idx = await testDb.getAllAsync<any>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rekonsiliasi_kas_bank' ORDER BY name`
    );
    expect(idx.map((i) => i.name)).toEqual(
      expect.arrayContaining(['idx_rekonsiliasi_account', 'idx_rekonsiliasi_penyelesaian'])
    );
    const sisa = await testDb.getFirstAsync<any>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='rekonsiliasi_kas_bank_new'`
    );
    expect(sisa).toBeFalsy();
    expect(await testDb.getAllAsync<any>(`PRAGMA foreign_key_check`)).toEqual([]);
    const v = await testDb.getFirstAsync<any>(`SELECT version FROM schema_meta WHERE id = 1`);
    expect(v.version).toBeGreaterThanOrEqual(71);
  });
});

// ===========================================================================
// 2. MATRIKS PERLAKUAN
// ===========================================================================

describe('RC-S78 — matriks perlakuan ditegakkan service', () => {
  beforeEach(async () => {
    testDb = await seed();
  });

  let n = 0;
  /** Siapkan satu baris SELISIH, lalu selesaikan lewat service. */
  const simpan = async (accountId: string, _nama: string, selisih: number, tl: any) => {
    const id = await baris(testDb, `rek-${++n}`, accountId, selisih);
    return selesaikanRekonsiliasi({ rekonsiliasiId: id, createdBy: USER, ...tl });
  };

  it('hanya tiga penyebab yang boleh menghasilkan jurnal', () => {
    const perluJurnal = PENYEBAB_SELISIH.filter((p) => PERLAKUAN_SAH[p] === 'PERLU_JURNAL');
    expect([...perluJurnal].sort()).toEqual(['BIAYA_ADMIN_BANK', 'JASA_GIRO', 'SELISIH_FISIK']);
  });

  it.each([
    ['TIMING_DIFFERENCE'],
    ['KESALAHAN_BANK'],
    ['LAINNYA'],
    ['TRANSAKSI_BELUM_TERCATAT'],
    ['SELISIH_PENCATATAN'],
  ] as [PenyebabSelisih][])(
    '%s + PERLU_JURNAL DITOLAK, dan tidak meninggalkan jurnal',
    async (penyebab) => {
      const id = await baris(testDb, `tolak-${penyebab}`, ACC.bank, -200_000);
      // Potret diambil SETELAH baris pemeriksaan ada: yang diuji adalah
      // penolakan tidak meninggalkan jejak (tidak ada jurnal, baris tetap
      // DRAFT), bukan bahwa pemeriksaannya sendiri batal.
      const sebelum = await potret(testDb);
      await expect(
        selesaikanRekonsiliasi({
          rekonsiliasiId: id, createdBy: USER,
          penyebab, perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban, catatan: 'x',
        })
      ).rejects.toThrow(/tidak diselesaikan dengan jurnal/i);
      expect(await potret(testDb)).toBe(sebelum);
    }
  );

  it.each([['BIAYA_ADMIN_BANK'], ['JASA_GIRO'], ['SELISIH_FISIK']] as [PenyebabSelisih][])(
    '%s + TIDAK_PERLU_JURNAL DITOLAK',
    async (penyebab) => {
      await expect(
        simpan(ACC.bank, 'Bank BCA', penyebab === 'JASA_GIRO' ? 200_000 : -200_000, {
          penyebab, perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'x',
        })
      ).rejects.toThrow(/memerlukan pencatatan penyesuaian/i);
    }
  );

  it('arah salah ditolak: biaya bank pada selisih lebih, jasa giro pada selisih kurang', async () => {
    await expect(
      simpan(ACC.bank, 'Bank BCA', 200_000, {
        penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan, catatan: 'x',
      })
    ).rejects.toThrow(/selisih kurang/i);
    await expect(
      simpan(ACC.bank, 'Bank BCA', -200_000, {
        penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban, catatan: 'x',
      })
    ).rejects.toThrow(/selisih lebih/i);
  });

  it('catatan kosong ditolak untuk setiap penyebab', async () => {
    await expect(
      simpan(ACC.bank, 'Bank BCA', -200_000, {
        penyebab: 'KESALAHAN_BANK', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: '   ',
      })
    ).rejects.toThrow(/Catatan pemeriksaan wajib/i);
  });
});

// ===========================================================================
// 3. SKENARIO LAPANGAN (§22)
// ===========================================================================

describe('RC-S78 — skenario lapangan', () => {
  beforeEach(async () => {
    testDb = await seed();
  });

  let n = 0;
  const simpan = async (accountId: string, _nama: string, selisih: number, tl: any) => {
    const id = await baris(testDb, `rek-${++n}`, accountId, selisih);
    return selesaikanRekonsiliasi({ rekonsiliasiId: id, createdBy: USER, ...tl });
  };

  const jurnalRek = () =>
    testDb.getAllAsync<any>(`SELECT * FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`);

  it('SKENARIO A — biaya bank: satu jurnal seimbang, Dr Beban / Cr Bank', async () => {
    const r = await simpan(ACC.bank, 'Bank BCA', -15_000, {
      penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban, catatan: 'adm Agustus, ref RK-08',
    });
    expect(r.statusPenyelesaian).toBe('SELESAI');
    expect(r.journalId).not.toBeNull();
    const e = await testDb.getAllAsync<any>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.beban, debit: 15_000, kredit: 0 },
      { account_id: ACC.bank, debit: 0, kredit: 15_000 },
    ]);
  });

  it('SKENARIO B — jasa giro: Dr Bank / Cr Pendapatan', async () => {
    const r = await simpan(ACC.bank, 'Bank BCA', 25_000, {
      penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan, catatan: 'jasa giro Agustus',
    });
    const e = await testDb.getAllAsync<any>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.bank, debit: 25_000, kredit: 0 },
      { account_id: ACC.pendapatan, debit: 0, kredit: 25_000 },
    ]);
  });

  it('SKENARIO C — perbedaan waktu: SELESAI tanpa jurnal, histori tetap SELISIH', async () => {
    const r = await simpan(ACC.bank, 'Bank BCA', -500_000, {
      penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'cek no. 12 belum cair',
    });
    expect(r.status).toBe('SELISIH'); // selisihnya TIDAK dihapus dari histori
    expect(r.statusPenyelesaian).toBe('SELESAI');
    expect(r.journalId).toBeNull();
    expect(await jurnalRek()).toHaveLength(0);
  });

  it('SKENARIO D — kesalahan bank: DRAFT tanpa jurnal (koperasi tidak membukukan kekeliruan bank)', async () => {
    const r = await simpan(ACC.bank, 'Bank BCA', -1_000_000, {
      penyebab: 'KESALAHAN_BANK', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'bank salah debit 1jt, lapor 01/09',
    });
    expect(r.penyebab).toBe('KESALAHAN_BANK');
    expect(r.journalId).toBeNull();
    expect(await jurnalRek()).toHaveLength(0);
  });

  it('SKENARIO E — kas kurang: penyesuaian ke akun Beban', async () => {
    const r = await simpan(ACC.kas, 'Kas', -50_000, {
      penyebab: 'SELISIH_FISIK', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.beban, catatan: 'opname 31/08',
    });
    const e = await testDb.getAllAsync<any>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.beban, debit: 50_000, kredit: 0 },
      { account_id: ACC.kas, debit: 0, kredit: 50_000 },
    ]);
  });

  it('SKENARIO F — transaksi belum tercatat: DRAFT tanpa jurnal, penyebab TERSIMPAN', async () => {
    const r = await simpan(ACC.bank, 'Bank BCA', 500_000, {
      penyebab: 'TRANSAKSI_BELUM_TERCATAT', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'setoran 500rb belum dicatat',
    });
    // Penyebabnya tidak hilang — dulu jalur ini membuangnya.
    expect(r.penyebab).toBe('TRANSAKSI_BELUM_TERCATAT');
    expect(r.journalId).toBeNull();
    expect(await jurnalRek()).toHaveLength(0);
  });

  it('§23 — membaca daftar 10x tidak mengubah database', async () => {
    await simpan(ACC.bank, 'Bank BCA', -500_000, {
      penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'cek no. 12',
    });
    const sebelum = await potret(testDb);
    for (let i = 0; i < 10; i++) await getRekonsiliasiTerakhirPerAkun(testDb as any, '2026-12-31');
    expect(await potret(testDb)).toBe(sebelum);
  });
});

// ===========================================================================
// 4. SEMANTIK PeriodClose (§14)
// ===========================================================================

describe('RC-S78 — PeriodClose memblokir yang BELUM DITINDAKLANJUTI, bukan yang masih selisih', () => {
  const baris = (o: Partial<Parameters<typeof rekonsiliasiMenghalangiTutupPeriode>[0]>) =>
    rekonsiliasiMenghalangiTutupPeriode({
      status: 'SELISIH', statusPenyelesaian: 'SELESAI',
      penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL', journalId: null,
      ...o,
    } as any);

  it('COCOK + SELESAI → tidak memblokir', () => {
    expect(baris({ status: 'COCOK', penyebab: null, perlakuan: null })).toBe(false);
  });

  it('SELISIH + perbedaan waktu + SELESAI → TIDAK memblokir (inti perbaikan RC-S78)', () => {
    // Selisih ini memang tidak akan pernah "cocok" hanya karena diulang;
    // aturan lama memaksa orang menutupnya dengan jurnal karangan.
    expect(baris({})).toBe(false);
  });

  it('SELISIH + penyesuaian + SELESAI + journal ada → tidak memblokir', () => {
    expect(baris({ penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', journalId: 'j-1' })).toBe(false);
  });

  it('SELISIH + DRAFT → MEMBLOKIR', () => {
    expect(baris({ statusPenyelesaian: 'DRAFT', penyebab: null, perlakuan: null })).toBe(true);
    expect(baris({ statusPenyelesaian: 'DRAFT', penyebab: 'KESALAHAN_BANK' })).toBe(true);
  });

  it('baris SELESAI yang TIDAK KONSISTEN memblokir — lebih berbahaya daripada DRAFT yang jujur', () => {
    // mengaku dijurnal tetapi tidak punya jurnal
    expect(baris({ penyebab: 'BIAYA_ADMIN_BANK', perlakuan: 'PERLU_JURNAL', journalId: null })).toBe(true);
    // mengaku tanpa jurnal tetapi punya jurnal
    expect(baris({ penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL', journalId: 'j-1' })).toBe(true);
    // perlakuan tidak sah untuk penyebabnya
    expect(baris({ penyebab: 'LAINNYA', perlakuan: 'PERLU_JURNAL', journalId: 'j-1' })).toBe(true);
    // selesai tetapi tanpa penyebab/perlakuan
    expect(baris({ penyebab: null, perlakuan: null })).toBe(true);
  });

  it('yang dibaca adalah pemeriksaan TERBARU per akun: DRAFT lama + COCOK baru → tidak memblokir', async () => {
    testDb = await seed();
    const tulis = async (id: string, tanggal: string, selisih: number, penyelesaian: string) => {
      const now = new Date().toISOString();
      await testDb.runAsync(
        `INSERT INTO rekonsiliasi_kas_bank
          (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
           status_penyelesaian, penyebab, perlakuan, journal_id, keterangan, created_by, created_at)
         VALUES (?,?,'Bank BCA',?,0,?,?,?,?,?,?,NULL,'x',?,?)`,
        id, ACC.bank, tanggal, selisih, selisih, selisih === 0 ? 'COCOK' : 'SELISIH',
        penyelesaian, selisih === 0 ? null : 'TRANSAKSI_BELUM_TERCATAT',
        selisih === 0 ? null : 'TIDAK_PERLU_JURNAL', USER, now
      );
    };
    await tulis('r1', '2026-08-23', -200_000, 'DRAFT');
    await tulis('r2', '2026-08-24', 0, 'SELESAI');

    const terakhir = await getRekonsiliasiTerakhirPerAkun(testDb as any, '2026-12-31');
    expect(terakhir).toHaveLength(1);
    expect(terakhir[0].tanggal).toBe('2026-08-24');
    expect(terakhir.filter(rekonsiliasiMenghalangiTutupPeriode)).toHaveLength(0);

    // Histori 23 Agustus TETAP ada — tidak ditimpa.
    expect(await testDb.getAllAsync<any>(`SELECT id FROM rekonsiliasi_kas_bank ORDER BY id`))
      .toEqual([{ id: 'r1' }, { id: 'r2' }]);
  });
});
