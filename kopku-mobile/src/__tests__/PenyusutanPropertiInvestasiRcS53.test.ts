import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

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

import { SCHEMA_VERSION } from '@/database/schema';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import {
  prosesPenyusutanPropertiInvestasi,
  simpanKonfigurasiPenyusutanProperti,
  getPeriodePenyusutanPropertiTertunggak,
  listPenyusutanPropertiDenganDb,
  getTotalPenyusutanProperti,
  PenyusutanPropertiBelumSiapError,
} from '@/services/PenyusutanPropertiInvestasiService';
import { getNilaiTercatatInvestasi } from '@/services/InvestasiImpairmentService';

/**
 * RC-S53 CORRECTIVE — PENYUSUTAN PROPERTI INVESTASI (MODEL BIAYA).
 *
 * POLICY 03 = MODEL BIAYA. Sampai v63 tidak ada satu pun jalur yang
 * menyusutkan akun investasi, sehingga nilai tercatat properti investasi
 * tidak pernah berkurang oleh penyusutan. Suite ini menguji penutupan
 * celah itu — DAN batas-batasnya: tanah tidak disusutkan, objek campuran
 * tanpa nilai bangunan ditolak sebagai DATA GAP, dan tidak ada satu pun
 * parameter yang punya nilai bawaan.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

const AKUN = {
  kas: 'acc-kas',
  properti: 'acc-properti',
  akumulasi: 'acc-akum-properti',
  bebanSusut: 'acc-beban-susut',
  bebanImpair: 'acc-beban-impair',
  penyisihan: 'acc-penyisihan-inv',
  modal: 'acc-modal',
};

const INV = 'inv-ruko';

async function seedAkun(id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kat, nb, now, now
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

async function seedFixture(opts: { periodeStatus?: 'OPEN' | 'CLOSED'; jumlah?: number } = {}) {
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAkun(AKUN.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAkun(AKUN.properti, '1-1660', 'Properti Investasi', 'ASET', 'DEBIT');
  await seedAkun(AKUN.akumulasi, '1-1670', 'Akumulasi Penyusutan Properti Investasi', 'ASET', 'KREDIT');
  await seedAkun(AKUN.bebanSusut, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
  await seedAkun(AKUN.bebanImpair, '5-2150', 'Beban Penurunan Nilai Investasi', 'BEBAN', 'DEBIT');
  await seedAkun(AKUN.penyisihan, '1-1680', 'Penyisihan Penurunan Nilai Investasi', 'ASET', 'KREDIT');
  await seedAkun(AKUN.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');

  await seedMapping('KAS_UMUM', 'DEFAULT', AKUN.kas);
  await seedMapping('PENYUSUTAN_PROPERTI_INVESTASI', 'DEBIT_BEBAN', AKUN.bebanSusut);
  await seedMapping('PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI', AKUN.akumulasi);
  await seedMapping('IMPAIRMENT_INVESTASI', 'DEBIT_BEBAN', AKUN.bebanImpair);
  await seedMapping('IMPAIRMENT_INVESTASI', 'KREDIT_PENYISIHAN', AKUN.penyisihan);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026', 2026, '2026-01-01', '2026-12-31', ?)`,
    opts.periodeStatus ?? 'OPEN'
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                            sumber_dana, status, created_by, created_at, updated_at)
     VALUES (?, 'INV-2026-009', 'PROPERTI_INVESTASI', 'Ruko Jl. Mawar', ?, '2026-01-05',
             'KAS', 'AKTIF', 'user-1', ?, ?)`,
    INV, opts.jumlah ?? 500_000_000, now, now
  );
}

/** Konfigurasi standar: bangunan 240 juta, residu 0, 120 bulan -> 2.000.000/bulan. */
async function konfigurasiBangunan() {
  await simpanKonfigurasiPenyusutanProperti({
    investasiId: INV,
    jenisObjek: 'TANAH_DAN_BANGUNAN',
    nilaiDapatDisusutkan: 240_000_000,
    nilaiResidu: 0,
    masaManfaatBulan: 120,
    tanggalMulaiPenyusutan: '2026-01-05',
    createdBy: 'user-1',
  });
}

async function saldoAkun(accountId: string) {
  const r = await testDb.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k
       FROM journal_entry WHERE account_id = ?`,
    accountId
  );
  return { debit: r?.d ?? 0, kredit: r?.k ?? 0 };
}

// ===========================================================================
// TEMUAN & PRASYARAT
// ===========================================================================

describe('Model biaya — akun & mapping penyusutan properti investasi', () => {
  it('1-1670 ada sebagai kontra-aset, terpisah dari akumulasi aset tetap', () => {
    const akun = DEFAULT_ACCOUNTS.find((a) => a.kode === '1-1670');
    expect(akun).toBeDefined();
    expect(akun!.nama).toBe('Akumulasi Penyusutan Properti Investasi');
    expect(akun!.kategori).toBe('ASET');
    expect(akun!.normalBalance).toBe('KREDIT');
    // TIDAK boleh memakai akumulasi aset tetap — properti investasi bukan aset tetap.
    expect(akun!.kode).not.toBe('1-1510');
  });

  it('beban memakai akun existing 5-1300, bukan akun beban baru', () => {
    const beban = DEFAULT_ACCOUNT_MAPPING.filter(
      (m) => m.transactionType === 'PENYUSUTAN_PROPERTI_INVESTASI' && m.role === 'DEBIT_BEBAN'
    );
    expect(beban).toHaveLength(1);
    expect(beban[0].accountKode).toBe('5-1300');
    const akum = DEFAULT_ACCOUNT_MAPPING.filter(
      (m) => m.transactionType === 'PENYUSUTAN_PROPERTI_INVESTASI' && m.role === 'KREDIT_AKUMULASI'
    );
    expect(akum).toHaveLength(1);
    expect(akum[0].accountKode).toBe('1-1670');
  });

  it('POLICY 02 tetap — 1-1660 tetap satu akun, nol akun Tanah/Bangunan', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (permintaan pengguna): 12 kode diminta DITAMBAHKAN sebagai akun COA (DEFINED / NOT ACTIVELY POSTED); tidak ada mapping/posting/jurnal yang berubah.
    expect(DEFAULT_ACCOUNTS.filter((a) => a.nama === 'Properti Investasi')).toHaveLength(1);
    for (const k of ['1-660', '1-661']) {
      expect(DEFAULT_ACCOUNTS.find((a) => a.kode === k)).toBeDefined();
      expect(DEFAULT_ACCOUNT_MAPPING.filter((m) => m.accountKode === k)).toEqual([]);
    }
  });

  it('migrasi v64 aditif: nol DROP, nol rewrite data lama', () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    const db = baca('src/database/db.ts');
    const awal = db.indexOf('export async function migrasiV64');
    const blok = db.slice(awal, db.indexOf('export async function migrasiV63'));
    expect(blok).not.toMatch(/DROP TABLE|DELETE FROM/);
    expect(blok).not.toMatch(/UPDATE investasi\s+SET/);
    expect(db).not.toMatch(/currentVersion < 83/); // DIPERBARUI v82 (blok v82 milik RC-S133.6.4, bukan tahap ini; ambang digeser ke 83). DIPERBARUI v81 (blok v81 milik RC-S133.6.2, bukan tahap ini; ambang digeser ke 82). DIPERBARUI v80 (blok v80 milik RC-S132, bukan tahap ini; ambang digeser ke 81). DIPERBARUI v79 (blok v79 milik RC-S128, bukan tahap ini; ambang digeser ke 80). DIPERBARUI v78 (blok v78 milik fitur bunga harian sukarela, bukan tahap ini; ambang digeser ke 79). DIPERBARUI v77 (Poin 5/6/10): blok v77 milik patch 19 poin (kolom unit_usaha_id + klasifikasi/label akun), bukan tahap ini; ambang digeser ke 78.  DIPERBARUI RC-S88: blok v73 MILIK RC-S88 (nilai wajar/revaluasi); ambang digeser ke 74. // DIPERBARUI v72 = penarikan dana investasi (milik modul itu, bukan tahap ini) · DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: blok v70 (asal personel) kini ADA dan MILIK restrukturisasi Data/Personel; ambang digeser ke 71 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: blok v74 MILIK RC-S100 (riwayat import data awal, dua tabel BARU aditif); ambang digeser ke 75 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji.
  });
});

// ===========================================================================
// KONFIGURASI — TIDAK ADA NILAI BAWAAN
// ===========================================================================

describe('Konfigurasi penyusutan — nol nilai bawaan', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it('BELUM DIKONFIGURASI — penyusutan ditolak, nol jurnal', async () => {
    let err: unknown;
    try {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PenyusutanPropertiBelumSiapError);
    expect((err as PenyusutanPropertiBelumSiapError).kode).toBe('BELUM_DIKONFIGURASI');
    const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(j!.n).toBe(0);
  });

  it('TANAH — tidak disusutkan, dan itu keputusan eksplisit bukan kelalaian', async () => {
    await simpanKonfigurasiPenyusutanProperti({
      investasiId: INV, jenisObjek: 'TANAH', createdBy: 'user-1',
    });
    let err: unknown;
    try {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    } catch (e) { err = e; }
    expect((err as PenyusutanPropertiBelumSiapError).kode).toBe('TANAH_TIDAK_DISUSUTKAN');
    const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(j!.n).toBe(0);
  });

  it('DATA GAP — objek campuran tanpa nilai bangunan ditolak, bukan ditaksir', async () => {
    await testDb.runAsync(
      `UPDATE investasi SET jenis_objek_properti = 'TANAH_DAN_BANGUNAN' WHERE id = ?`, INV
    );
    let err: unknown;
    try {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    } catch (e) { err = e; }
    expect((err as PenyusutanPropertiBelumSiapError).kode).toBe('DATA_GAP_KOMPONEN');
  });

  it('MASA MANFAAT & RESIDU wajib — nol fallback diam-diam', async () => {
    await expect(
      simpanKonfigurasiPenyusutanProperti({
        investasiId: INV, jenisObjek: 'BANGUNAN', nilaiDapatDisusutkan: 100_000_000,
        nilaiResidu: 0, masaManfaatBulan: 0, tanggalMulaiPenyusutan: '2026-01-05',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Masa manfaat/);
    await expect(
      simpanKonfigurasiPenyusutanProperti({
        investasiId: INV, jenisObjek: 'BANGUNAN', nilaiDapatDisusutkan: 100_000_000,
        masaManfaatBulan: 120, tanggalMulaiPenyusutan: '2026-01-05', createdBy: 'user-1',
      })
    ).rejects.toThrow(/Nilai residu/);
    await expect(
      simpanKonfigurasiPenyusutanProperti({
        investasiId: INV, jenisObjek: 'BANGUNAN', nilaiDapatDisusutkan: 100_000_000,
        nilaiResidu: 0, masaManfaatBulan: 120, createdBy: 'user-1',
      })
    ).rejects.toThrow(/Tanggal mulai/);
  });

  it('nilai yang dapat disusutkan tidak boleh melebihi nilai perolehan', async () => {
    await testDb.runAsync(
      `UPDATE investasi SET jenis_objek_properti='TANAH_DAN_BANGUNAN', nilai_dapat_disusutkan=600000000,
              nilai_residu_properti=0, masa_manfaat_bulan_properti=120, tanggal_mulai_penyusutan='2026-01-05'
        WHERE id = ?`, INV
    );
    let err: unknown;
    try {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    } catch (e) { err = e; }
    expect((err as PenyusutanPropertiBelumSiapError).kode).toBe('DATA_GAP_KOMPONEN');
  });
});

// ===========================================================================
// PENYUSUTAN
// ===========================================================================

describe('Penyusutan properti investasi — perhitungan & jurnal', () => {
  beforeEach(async () => {
    await seedFixture();
    await konfigurasiBangunan();
  });

  it('PERIODE PERTAMA — Dr 5-1300, Cr 1-1670, sebesar dasar/masa manfaat', async () => {
    const hasil = await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
    });
    expect(hasil.dibuat).toBe(true);
    expect(hasil.row.nilaiPenyusutan).toBe(2_000_000);

    const entri = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`,
      hasil.row.journalId
    );
    expect(entri).toHaveLength(2);
    expect(entri[0].account_id).toBe(AKUN.bebanSusut);
    expect(entri[0].debit).toBe(2_000_000);
    expect(entri[1].account_id).toBe(AKUN.akumulasi);
    expect(entri[1].kredit).toBe(2_000_000);
  });

  it('tanggal jurnal selalu akhir periode, bukan new Date() sembarangan', async () => {
    const hasil = await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
    });
    expect(hasil.row.tanggal).toBe('2026-02-28');
    const j = await testDb.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE id = ?`, hasil.row.journalId
    );
    expect(j!.tanggal).toBe('2026-02-28');
  });

  it('PERIODE BERIKUTNYA — akumulasi bertambah, bukan menimpa', async () => {
    for (const p of ['2026-01', '2026-02', '2026-03']) {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: p, createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    }
    expect(await getTotalPenyusutanProperti(testDb as never, INV)).toBe(6_000_000);
    const akum = await saldoAkun(AKUN.akumulasi);
    expect(akum.kredit - akum.debit).toBe(6_000_000);
  });

  it('DUPLICATE — periode yang sama tidak membuat jurnal kedua', async () => {
    await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
    });
    const ulang = await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
    });
    expect(ulang.dibuat).toBe(false);
    const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(j!.n).toBe(1);
  });

  it('RETRY — tiga percobaan berturut-turut tetap satu jurnal', async () => {
    for (let i = 0; i < 3; i += 1) {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    }
    expect(await getTotalPenyusutanProperti(testDb as never, INV)).toBe(2_000_000);
  });

  it('CONCURRENCY — dua proses paralel hanya menghasilkan satu baris', async () => {
    await Promise.allSettled([
      prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      }),
      prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      }),
    ]);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM investasi_penyusutan WHERE investasi_id = ? AND periode = '2026-01'`,
      INV
    );
    expect(n!.n).toBe(1);
  });

  it('ROLLBACK — investasi tidak aktif ditolak, nol jejak', async () => {
    await testDb.runAsync(`UPDATE investasi SET status='DIBATALKAN' WHERE id = ?`, INV);
    await expect(
      prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      })
    ).rejects.toThrow(/tidak aktif/);
    const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    const r = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM investasi_penyusutan`);
    expect(j!.n).toBe(0);
    expect(r!.n).toBe(0);
  });

  it('PERIODE MASA DEPAN ditolak; periode sebelum tanggal mulai ditolak', async () => {
    await expect(
      prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2027-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      })
    ).rejects.toThrow(/belum berjalan/);
    await expect(
      prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2025-12', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      })
    ).rejects.toThrow(/sebelum tanggal mulai/);
  });

  it('CATCH-UP TIDAK OTOMATIS — periode tertunggak hanya dilaporkan', async () => {
    const tertunggak = await getPeriodePenyusutanPropertiTertunggak(INV, '2026-04-30');
    expect(tertunggak).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    // Melaporkannya TIDAK menjurnal apa pun.
    const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(j!.n).toBe(0);

    await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-04-30',
    });
    expect(await getPeriodePenyusutanPropertiTertunggak(INV, '2026-04-30')).toEqual(
      ['2026-01', '2026-03', '2026-04']
    );
  });
});

describe('Penyusutan properti investasi — periode tertutup', () => {
  it('CLOSED — ditolak, nol jurnal, nol baris register', async () => {
    await seedFixture({ periodeStatus: 'CLOSED' });
    await konfigurasiBangunan();
    await expect(
      prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      })
    ).rejects.toThrow();
    const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    const r = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM investasi_penyusutan`);
    expect(j!.n).toBe(0);
    expect(r!.n).toBe(0);
  });
});

// ===========================================================================
// INTERAKSI DENGAN IMPAIRMENT — INTI KOREKSI
// ===========================================================================

describe('Nilai tercatat — biaya dikurangi penyusutan DAN penurunan nilai', () => {
  beforeEach(async () => {
    await seedFixture();
    await konfigurasiBangunan();
  });

  it('nilai tercatat berkurang oleh penyusutan (sebelumnya TIDAK)', async () => {
    const sebelum = await getNilaiTercatatInvestasi(testDb as never, INV);
    expect(sebelum.nilaiTercatat).toBe(500_000_000);
    expect(sebelum.akumulasiPenyusutan).toBe(0);

    for (const p of ['2026-01', '2026-02']) {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: p, createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    }
    const sesudah = await getNilaiTercatatInvestasi(testDb as never, INV);
    expect(sesudah.akumulasiPenyusutan).toBe(4_000_000);
    expect(sesudah.nilaiTercatat).toBe(496_000_000);
  });

  it('TIDAK ADA DOUBLE REDUCTION — penyusutan dan impairment masing-masing satu kali', async () => {
    await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
    });
    const { catatImpairmentInvestasi } = await import('@/services/InvestasiImpairmentService');
    await catatImpairmentInvestasi({
      investasiId: INV,
      tanggal: '2026-03-31',
      indikasiTerpilih: ['Penurunan nilai pasar signifikan'],
      dasarPenilaian: 'Penilaian pengurus',
      nilaiImpairment: 10_000_000,
      alasan: 'Kondisi pasar',
      createdBy: 'user-1',
    });

    const nilai = await getNilaiTercatatInvestasi(testDb as never, INV);
    expect(nilai.akumulasiPenyusutan).toBe(2_000_000);
    expect(nilai.akumulasiImpairment).toBe(10_000_000);
    // Tepat satu kali masing-masing — bukan 500jt - 2jt - 2jt - 10jt.
    expect(nilai.nilaiTercatat).toBe(488_000_000);

    const akumSusut = await saldoAkun(AKUN.akumulasi);
    const penyisihan = await saldoAkun(AKUN.penyisihan);
    expect(akumSusut.kredit - akumSusut.debit).toBe(2_000_000);
    expect(penyisihan.kredit - penyisihan.debit).toBe(10_000_000);
  });

  it('batas impairment memakai nilai tercatat SETELAH penyusutan', async () => {
    await testDb.runAsync(
      `UPDATE investasi SET jumlah = 5000000 WHERE id = ?`, INV
    );
    await simpanKonfigurasiPenyusutanProperti({
      investasiId: INV, jenisObjek: 'BANGUNAN', nilaiDapatDisusutkan: 4_800_000,
      nilaiResidu: 0, masaManfaatBulan: 2, tanggalMulaiPenyusutan: '2026-01-05',
      createdBy: 'user-1',
    });
    for (const p of ['2026-01', '2026-02']) {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: p, createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    }
    const nilai = await getNilaiTercatatInvestasi(testDb as never, INV);
    expect(nilai.nilaiTercatat).toBe(200_000);
    const { catatImpairmentInvestasi } = await import('@/services/InvestasiImpairmentService');
    await expect(
      catatImpairmentInvestasi({
        investasiId: INV, tanggal: '2026-03-31',
        indikasiTerpilih: ['Penurunan nilai pasar signifikan'],
        dasarPenilaian: 'Penilaian pengurus', nilaiImpairment: 1_000_000,
        alasan: 'Kondisi pasar', createdBy: 'user-1',
      })
    ).rejects.toThrow(/melebihi nilai tercatat/);
  });
});

// ===========================================================================
// FAIR VALUE, REKONSILIASI, INTEGRITAS
// ===========================================================================

// DIPERBARUI RC-S88: properti investasi kini dapat beralih ke MODEL NILAI WAJAR
// (SAK EP 16) lewat penilaian yang DIPOSTING; sejak itu penyusutan berhenti
// (dijaga di PenyusutanPropertiInvestasiService, diuji RcS88NilaiWajarOci).
// Selama belum ada penilaian diposting, model biaya & penyusutan ini berlaku.
describe('Model biaya s.d. penilaian nilai wajar pertama diposting', () => {
  it('posting nilai wajar lewat gerbang DIPOSTING; nol status POSTED; penyusutan dihentikan pada model nilai wajar', () => {
    const svc = baca('src/services/PenyesuaianNilaiWajarService.ts');
    expect(svc).toMatch(/export async function postingNilaiWajar\(/);
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(/status TEXT NOT NULL DEFAULT 'DRAFT' CHECK \(status IN \('DRAFT','DIPOSTING','DIBATALKAN'\)\)/);
    const susut = baca('src/services/PenyusutanPropertiInvestasiService.ts');
    expect(susut).toMatch(/'MODEL_NILAI_WAJAR'/);
  });

  it('nol jurnal nilai wajar terbentuk oleh jalur penyusutan', async () => {
    await seedFixture();
    await konfigurasiBangunan();
    await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
    });
    const sumber = await testDb.getAllAsync<{ sumber_transaksi: string }>(
      `SELECT DISTINCT sumber_transaksi FROM journal`
    );
    expect(sumber.map((s) => s.sumber_transaksi)).toEqual(['PENYUSUTAN_PROPERTI_INVESTASI']);
  });
});

describe('Rekonsiliasi, laporan, dan integritas', () => {
  beforeEach(async () => {
    await seedFixture();
    await konfigurasiBangunan();
    for (const p of ['2026-01', '2026-02', '2026-03']) {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: p, createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    }
  });

  it('setiap jurnal balance satu per satu', async () => {
    const rows = await testDb.getAllAsync<{ journal_id: string; d: number; k: number }>(
      `SELECT journal_id, SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry GROUP BY journal_id`
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.d).toBe(r.k);
  });

  it('SUBLEDGER = LEDGER — register penyusutan cocok dengan saldo 1-1670', async () => {
    const subledger = (await listPenyusutanPropertiDenganDb(testDb as never, { investasiId: INV }))
      .reduce((t, r) => t + r.nilaiPenyusutan, 0);
    const akum = await saldoAkun(AKUN.akumulasi);
    expect(subledger).toBe(6_000_000);
    expect(akum.kredit - akum.debit).toBe(subledger);
  });

  it('LHU — beban penyusutan masuk akun BEBAN, bukan mengurangi aset langsung', async () => {
    const beban = await saldoAkun(AKUN.bebanSusut);
    expect(beban.debit - beban.kredit).toBe(6_000_000);
    const properti = await saldoAkun(AKUN.properti);
    // Akun properti TIDAK dikreditkan langsung — nilai perolehan utuh.
    expect(properti.kredit).toBe(0);
  });

  it('POSISI KEUANGAN — nilai tercatat = perolehan - akumulasi penyusutan', async () => {
    const akum = await saldoAkun(AKUN.akumulasi);
    const properti = await saldoAkun(AKUN.properti);
    const nilaiBuku = (properti.debit - properti.kredit) - (akum.kredit - akum.debit);
    const nilai = await getNilaiTercatatInvestasi(testDb as never, INV);
    // Akun properti tidak berisi jurnal perolehan pada fixture ini, jadi
    // yang diuji adalah ARAH-nya: akumulasi mengurangi, bukan menambah.
    expect(nilaiBuku).toBe(-6_000_000);
    expect(nilai.nilaiTercatat).toBe(494_000_000);
  });

  it('ASET = LIABILITAS + EKUITAS + PENDAPATAN - BEBAN', async () => {
    const saldo = async (kategori: string) => {
      const r = await testDb.getFirstAsync<{ d: number; k: number }>(
        `SELECT COALESCE(SUM(je.debit),0) AS d, COALESCE(SUM(je.kredit),0) AS k
           FROM journal_entry je JOIN account a ON a.id = je.account_id
          WHERE a.kategori = ?`,
        kategori
      );
      return { d: r?.d ?? 0, k: r?.k ?? 0 };
    };
    const aset = await saldo('ASET');
    const lia = await saldo('LIABILITAS');
    const eku = await saldo('EKUITAS');
    const pend = await saldo('PENDAPATAN');
    const beb = await saldo('BEBAN');
    const kiri = aset.d - aset.k;
    const kanan = (lia.k - lia.d) + (eku.k - eku.d) + (pend.k - pend.d) - (beb.d - beb.k);
    expect(kiri).toBe(kanan);
  });

  it('INTEGRITAS — FK aktif, foreign_key_check kosong, nol duplikat, akumulasi tidak negatif', async () => {
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk!.foreign_keys).toBe(1);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);

    const dup = await testDb.getAllAsync(
      `SELECT investasi_id FROM investasi_penyusutan GROUP BY investasi_id, periode HAVING COUNT(*) > 1`
    );
    expect(dup).toHaveLength(0);
    const dupJurnal = await testDb.getAllAsync(
      `SELECT nomor_jurnal FROM journal GROUP BY nomor_jurnal HAVING COUNT(*) > 1`
    );
    expect(dupJurnal).toHaveLength(0);

    const negatif = await testDb.getAllAsync(
      `SELECT id FROM investasi_penyusutan WHERE nilai_penyusutan <= 0`
    );
    expect(negatif).toHaveLength(0);
  });

  it('HISTORICAL SAFETY — jurnal periode lama tidak diubah oleh periode berikutnya', async () => {
    const pertama = await testDb.getFirstAsync<{ journal_id: string; nilai_penyusutan: number }>(
      `SELECT journal_id, nilai_penyusutan FROM investasi_penyusutan WHERE periode = '2026-01'`
    );
    const j = await testDb.getFirstAsync<{ status: string; tanggal: string }>(
      `SELECT status, tanggal FROM journal WHERE id = ?`, pertama!.journal_id
    );
    expect(j!.status).toBe('POSTED');
    expect(j!.tanggal).toBe('2026-01-31');
    expect(pertama!.nilai_penyusutan).toBe(2_000_000);
  });
});

// ===========================================================================
// UI — STATIC/UI VERIFIED (render tidak dapat diverifikasi di lingkungan ini)
// ===========================================================================

describe('UI Penyusutan Properti Investasi — batas & keterjangkauan', () => {
  const SCREEN = 'src/screens/Akuntansi/PenyusutanPropertiFormScreen.tsx';
  const src = baca(SCREEN).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('NOL SQL dan NOL AccountingEngine di layar', () => {
    for (const dilarang of [
      'runAsync', 'execAsync', 'getAllAsync', 'getFirstAsync',
      'INSERT INTO', 'DELETE FROM', 'SELECT ',
      'createJournal', 'AccountingEngine', 'resolveAccountId', 'withTransaction',
    ]) {
      expect(src).not.toContain(dilarang);
    }
  });

  it('seluruh aksi lewat PenyusutanPropertiInvestasiService', () => {
    expect(src).toMatch(/from '@\/services\/PenyusutanPropertiInvestasiService'/);
    expect(src).toContain('simpanKonfigurasiPenyusutanProperti(');
    expect(src).toContain('prosesPenyusutanPropertiInvestasi(');
    expect(src).toContain('getPeriodePenyusutanPropertiTertunggak(');
  });

  it('layar tidak menghitung penyusutan sendiri', () => {
    expect(src).not.toContain('hitungPenyusutanBulanan');
    // Nol aritmetika penyusutan di layar: tidak ada pembagian terhadap
    // masa manfaat maupun pengurangan nilai residu.
    expect(src).not.toMatch(/\/\s*masaManfaat/);
    expect(src).not.toMatch(/nilaiDapatDisusutkan\s*-\s*nilaiResidu/);
  });

  it('keempat parameter wajib diminta, tanpa nilai bawaan di layar', () => {
    for (const f of ['nilaiDapatDisusutkan', 'nilaiResidu', 'masaManfaat', 'tanggalMulai']) {
      expect(src).toContain(f);
    }
    // Nilai awal state kosong, bukan angka yang dikarang.
    expect(src).toContain("useState<number | ''>('')");
    expect(src).toContain("useState('')");
  });

  it('TANAH menyembunyikan field penyusutan — tanah tidak disusutkan', () => {
    expect(src).toContain("jenisObjek !== 'TANAH'");
  });

  it('nol tombol proses-semua — catch-up hanya per periode', () => {
    expect(src).not.toMatch(/proses semua/i);
    expect(src).not.toMatch(/jalankanSemua|prosesSemua/);
    expect(src).toContain('proses(p)');
  });

  it('DATA GAP ditampilkan apa adanya, bukan disembunyikan', () => {
    expect(src).toContain('catatanTertunggak');
    expect(src).toContain('e instanceof Error ? e.message');
  });

  it('rute terdaftar sekali dan dapat dijangkau dari menu', () => {
    const nav = baca('src/navigation/RootNavigator.tsx');
    expect(nav).toContain("import PenyusutanPropertiFormScreen from '@/screens/Akuntansi/PenyusutanPropertiFormScreen';");
    // DIPERBARUI Poin 7: menu pindah ke Transaksi > Penyesuaian. Rute
    // didaftarkan SEKALI per stack (TransaksiStack untuk menu baru,
    // LaporanStack dipertahankan untuk tautan lama) — pola yang sama
    // dengan KolektibilitasPiutang; komponennya satu.
    expect((nav.match(/<TransaksiStack\.Screen name="PenyusutanPropertiInvestasi"/g) ?? [])).toHaveLength(1);
    expect((nav.match(/<LaporanStack\.Screen name="PenyusutanPropertiInvestasi"/g) ?? [])).toHaveLength(1);
    const menu = baca('src/screens/Transaksi/PenyesuaianScreen.tsx');
    expect((menu.match(/route: 'PenyusutanPropertiInvestasi'/g) ?? [])).toHaveLength(1);
    expect(menu).toContain('Penyusutan Properti Investasi');
  });
});

// ===========================================================================
// AUDIT RC-S53 — proteksi database & pembulatan periode terakhir
// ===========================================================================

describe('Audit — penyusutan properti', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it('INSERT mentah dengan (investasi, periode) sama DITOLAK indeks UNIQUE', async () => {
    await konfigurasiBangunan();
    const hasil = await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
    });
    let ditolak = false;
    try {
      await testDb.runAsync(
        `INSERT INTO investasi_penyusutan
          (id, investasi_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
         VALUES ('paksa',?, '2026-01', '2026-01-31', 123, ?, 'user-1', ?)`,
        INV, hasil.row.journalId, new Date().toISOString()
      );
    } catch {
      ditolak = true;
    }
    expect(ditolak).toBe(true);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM investasi_penyusutan`
    );
    expect(n!.n).toBe(1);
  });

  it('PERIODE TERAKHIR — pembulatan tidak membuat akumulasi melampaui dasar', async () => {
    // Dasar 200 / 3 bulan -> 67 per bulan; 67 x 3 = 201 > 200. Periode
    // ketiga harus dipotong menjadi 66, bukan menjadikan nilai buku
    // turun di bawah residu.
    await simpanKonfigurasiPenyusutanProperti({
      investasiId: INV, jenisObjek: 'BANGUNAN', nilaiDapatDisusutkan: 200,
      nilaiResidu: 0, masaManfaatBulan: 3, tanggalMulaiPenyusutan: '2026-01-05',
      createdBy: 'user-1',
    });
    const nilai: number[] = [];
    for (const p of ['2026-01', '2026-02', '2026-03']) {
      const h = await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: p, createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
      nilai.push(h.row.nilaiPenyusutan);
    }
    expect(nilai).toEqual([67, 67, 66]);
    expect(await getTotalPenyusutanProperti(testDb as never, INV)).toBe(200);
  });

  it('SESUDAH TERSUSUT PENUH — periode berikutnya ditolak, nol jurnal tambahan', async () => {
    await simpanKonfigurasiPenyusutanProperti({
      investasiId: INV, jenisObjek: 'BANGUNAN', nilaiDapatDisusutkan: 200,
      nilaiResidu: 0, masaManfaatBulan: 3, tanggalMulaiPenyusutan: '2026-01-05',
      createdBy: 'user-1',
    });
    for (const p of ['2026-01', '2026-02', '2026-03']) {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: p, createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    }
    await expect(
      prosesPenyusutanPropertiInvestasi({
        investasiId: INV, periode: '2026-04', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      })
    ).rejects.toThrow(/melewati masa manfaat|tersusut penuh/);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(n!.n).toBe(3);
  });
});

describe('Hardening UI — pilihan investasi dibatasi ke properti investasi', () => {
  const src = baca('src/screens/Akuntansi/PenyusutanPropertiFormScreen.tsx')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('layar meminta picker hanya menampilkan PROPERTI_INVESTASI', () => {
    expect(src).toMatch(/onlyJenisInvestasi="PROPERTI_INVESTASI"/);
  });

  it('InvestasiPicker benar-benar menerapkan filter itu, dan propnya opsional', () => {
    const picker = baca('src/components/InvestasiPicker.tsx');
    expect(picker).toContain("onlyJenisInvestasi?: InvestasiListItem['jenisInvestasi']");
    expect(picker).toMatch(/!onlyJenisInvestasi \|\| i\.jenisInvestasi === onlyJenisInvestasi/);
    // Tanpa prop, daftarnya persis seperti sebelumnya (pemanggil lama aman).
    expect(picker).toMatch(/i\.status === 'AKTIF'/);
  });

  it('BYPASS UI — investasi non-properti tetap DITOLAK service, nol jurnal', async () => {
    await seedFixture();
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                              sumber_dana, status, created_by, created_at, updated_at)
       VALUES ('inv-deposito','INV-2026-050','DEPOSITO_BANK_UMUM','Deposito BRI',10000000,'2026-01-05',
               'KAS','AKTIF','user-1',?,?)`,
      now, now
    );
    // Menembus layar sepenuhnya: memanggil service langsung.
    let err: unknown;
    try {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: 'inv-deposito', periode: '2026-01', createdBy: 'user-1',
        tanggalLaporan: '2026-06-30',
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PenyusutanPropertiBelumSiapError);
    expect((err as PenyusutanPropertiBelumSiapError).kode).toBe('BUKAN_PROPERTI_INVESTASI');
    const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(j!.n).toBe(0);
  });

  it('properti yang sah tetap dapat diproses setelah filter ditambahkan', async () => {
    await seedFixture();
    await konfigurasiBangunan();
    const h = await prosesPenyusutanPropertiInvestasi({
      investasiId: INV, periode: '2026-01', createdBy: 'user-1', tanggalLaporan: '2026-06-30',
    });
    expect(h.dibuat).toBe(true);
    expect(h.row.nilaiPenyusutan).toBe(2_000_000);
  });
});
