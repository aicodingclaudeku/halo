import { createTestDb, TestDb } from './testDb';

let dbAktif: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => dbAktif),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await dbAktif.withTransactionAsync(async () => {
      result = await fn(dbAktif);
    });
    return result;
  }),
}));

import { createJournal } from '@/accounting/AccountingEngine';
import {
  getPosisiKeuangan,
  getPerubahanEkuitas,
  getLabaRugi,
  getLabaRugiKomparatif,
} from '@/reports/FinancialReports';
import { geserPeriodeSetahunKeBelakang } from '@/utils/reportPeriod';

/**
 * REGRESI EKUITAS MULTI-TAHUN + COMPARATIVE (fix konsistensi v49 §5/§6).
 *
 * MODEL AKUNTANSI KOPKU yang mendasari test ini (diverifikasi dari kode,
 * bukan diasumsikan):
 *  - TIDAK ADA closing entry. Akun Pendapatan/Beban tidak pernah
 *    di-nol-kan, jadi laba tahun-tahun sebelumnya TIDAK pernah pindah
 *    sendiri ke akun ekuitas permanen.
 *  - Yang memindahkannya HANYA jurnal SHU_DISTRIBUSI: Dr 3-4000
 *    (kliring "SHU Tahun Berjalan") / Cr Cadangan, Ekuitas Lainnya,
 *    Simpanan Sukarela.
 *  - Akun 3-4000 karena itu bersaldo KUMULATIF NEGATIF sebesar total
 *    yang sudah pernah didistribusikan, sepanjang masa.
 *
 * Konsekuensinya, baris "SHU/Laba Tahun Berjalan" di Posisi Keuangan =
 * hasil usaha KUMULATIF sepanjang masa DIKURANGI seluruh yang sudah
 * didistribusikan, yaitu SISA yang belum dibagikan. Test di bawah
 * mengunci konsekuensi itu untuk tiga tahun buku dengan kombinasi
 * belum/sudah/sebagian dibagikan.
 */

const ACC = {
  kas: 'acc-kas',
  simpananPokok: 'acc-simpanan-pokok',
  pendapatan: 'acc-pendapatan',
  cadangan: 'acc-cadangan',
  danaLainnya: 'acc-dana-lainnya',
  shuBerjalan: 'acc-shu-berjalan',
  simpananSukarela: 'acc-simpanan-sukarela',
};

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}

async function jurnal(db: TestDb, tanggal: string, sumber: string, lines: { accountId: string; debit: number; kredit: number }[]) {
  return createJournal(db as any, { tanggal, sumberTransaksi: sumber, deskripsi: 'test', createdBy: 'user-1', lines });
}

async function seedShuKonfigurasi(db: TestDb, id: string, tahun: number, total: number, status: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO shu_konfigurasi
      (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
       persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
       total_shu, status, created_at, updated_at)
     VALUES (?,?,20,30,30,5,5,5,5,0,0,?,?,?,?)`,
    id, tahun, total, status, now, now
  );
}

async function setup(): Promise<TestDb> {
  const db = await createTestDb();
  dbAktif = db;
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatan, '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.cadangan, '3-2000', 'Cadangan', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.danaLainnya, '3-3000', 'Ekuitas Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.shuBerjalan, '3-4000', 'SHU Tahun Berjalan', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.simpananSukarela, '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');
  for (const tahun of [2025, 2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `period-${tahun}`, tahun, `${tahun}-01-01`, `${tahun}-12-31`
    );
  }
  await jurnal(db, '2025-01-05', 'SIMPANAN_POKOK', [
    { accountId: ACC.kas, debit: 5_000_000, kredit: 0 },
    { accountId: ACC.simpananPokok, debit: 0, kredit: 5_000_000 },
  ]);
  return db;
}

/** Aset = Liabilitas + Ekuitas — invariant yang HARUS selalu berlaku. */
async function cekBalance(db: TestDb, tanggal: string) {
  const p = await getPosisiKeuangan(db as any, tanggal);
  expect(p.totalAset).toBe(p.totalLiabilitas + p.totalEkuitas);
  expect(p.isBalanced).toBe(true);
  expect(p.selisih).toBe(0);
  return p;
}

describe('Ekuitas multi-tahun — laba kumulatif vs distribusi SHU (§5)', () => {
  test('TAHUN 1 belum dibagikan: seluruh hasil usaha tetap di ekuitas sebagai SHU belum dibagikan', async () => {
    const db = await setup();
    await jurnal(db, '2025-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 35_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 35_000_000 },
    ]);

    const p = await cekBalance(db, '2025-12-31');
    expect(p.labaBerjalan).toBe(35_000_000);
    expect(p.totalAset).toBe(40_000_000);
    expect(p.totalEkuitas).toBe(40_000_000);
  });

  test('TAHUN 2 sudah dibagikan PENUH: sisa SHU 0, ekuitas tidak berkurang dua kali', async () => {
    const db = await setup();
    await jurnal(db, '2025-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 35_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 35_000_000 },
    ]);
    await seedShuKonfigurasi(db, 'shu-2025', 2025, 35_000_000, 'DIBAGIKAN');
    await jurnal(db, '2026-03-15', 'SHU_DISTRIBUSI', [
      { accountId: ACC.shuBerjalan, debit: 35_000_000, kredit: 0 },
      { accountId: ACC.cadangan, debit: 0, kredit: 7_000_000 },
      { accountId: ACC.danaLainnya, debit: 0, kredit: 14_000_000 },
      { accountId: ACC.simpananSukarela, debit: 0, kredit: 14_000_000 },
    ]);

    const p = await cekBalance(db, '2026-12-31');
    // Sisa hasil usaha yang belum dibagikan = 35jt - 35jt = 0.
    expect(p.labaBerjalan).toBe(0);
    // Ekuitas: Simpanan Pokok 5jt + Cadangan 7jt + Ekuitas Lainnya 14jt.
    expect(p.totalEkuitas).toBe(26_000_000);
    expect(p.totalAset).toBe(40_000_000);
    expect(p.totalLiabilitas).toBe(14_000_000);
  });

  test('SEBAGIAN dibagikan: sisa = hasil usaha kumulatif - jumlah yang didistribusikan', async () => {
    const db = await setup();
    await jurnal(db, '2025-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 35_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 35_000_000 },
    ]);
    await seedShuKonfigurasi(db, 'shu-2025', 2025, 20_000_000, 'DIBAGIKAN');
    await jurnal(db, '2026-03-15', 'SHU_DISTRIBUSI', [
      { accountId: ACC.shuBerjalan, debit: 20_000_000, kredit: 0 },
      { accountId: ACC.cadangan, debit: 0, kredit: 4_000_000 },
      { accountId: ACC.danaLainnya, debit: 0, kredit: 8_000_000 },
      { accountId: ACC.simpananSukarela, debit: 0, kredit: 8_000_000 },
    ]);

    const p = await cekBalance(db, '2026-12-31');
    expect(p.labaBerjalan).toBe(15_000_000); // 35jt - 20jt
    expect(p.totalEkuitas).toBe(32_000_000); // 5 + 4 + 8 + 15
  });

  test('TAHUN 3 tanpa hasil usaha baru, dua tahun sebelumnya sudah dibagikan: tetap rekonsiliasi', async () => {
    const db = await setup();
    await jurnal(db, '2025-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 20_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 20_000_000 },
    ]);
    await seedShuKonfigurasi(db, 'shu-2025', 2025, 20_000_000, 'DIBAGIKAN');
    await jurnal(db, '2026-03-15', 'SHU_DISTRIBUSI', [
      { accountId: ACC.shuBerjalan, debit: 20_000_000, kredit: 0 },
      { accountId: ACC.cadangan, debit: 0, kredit: 4_000_000 },
      { accountId: ACC.danaLainnya, debit: 0, kredit: 8_000_000 },
      { accountId: ACC.simpananSukarela, debit: 0, kredit: 8_000_000 },
    ]);
    await jurnal(db, '2026-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 15_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 15_000_000 },
    ]);
    await seedShuKonfigurasi(db, 'shu-2026', 2026, 15_000_000, 'DIBAGIKAN');
    await jurnal(db, '2027-04-01', 'SHU_DISTRIBUSI', [
      { accountId: ACC.shuBerjalan, debit: 15_000_000, kredit: 0 },
      { accountId: ACC.cadangan, debit: 0, kredit: 3_000_000 },
      { accountId: ACC.danaLainnya, debit: 0, kredit: 6_000_000 },
      { accountId: ACC.simpananSukarela, debit: 0, kredit: 6_000_000 },
    ]);

    const p = await cekBalance(db, '2027-04-01');
    expect(p.labaBerjalan).toBe(0); // 35jt kumulatif - 35jt didistribusikan
    expect(p.totalAset).toBe(40_000_000);
    expect(p.totalLiabilitas).toBe(14_000_000);
    expect(p.totalEkuitas).toBe(26_000_000);

    // Perubahan Ekuitas HARUS identik dengan Posisi Keuangan.
    const ekuitas = await getPerubahanEkuitas(db as any, '2027-01-01', '2027-04-01');
    expect(ekuitas.totalSaldoAkhir).toBe(p.totalEkuitas);
  });

  test('Laporan Laba Rugi PER TAHUN BUKU tidak ikut berubah (tetap laba tahun ybs, bukan kumulatif)', async () => {
    const db = await setup();
    await jurnal(db, '2025-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 20_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 20_000_000 },
    ]);
    await jurnal(db, '2026-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 15_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 15_000_000 },
    ]);

    const lr2025 = await getLabaRugi(db as any, '2025-01-01', '2025-12-31');
    const lr2026 = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');
    expect(lr2025.hasilUsaha).toBe(20_000_000);
    expect(lr2026.hasilUsaha).toBe(15_000_000); // BUKAN 35jt
  });
});

describe('Comparative default KOPKU (§6) — tanggal & bulan sama, tahun sebelumnya', () => {
  test('geserPeriodeSetahunKeBelakang: 30 Sep 2026 -> 30 Sep 2025 (bukan 29 Sep / 1 Sep / full-year)', () => {
    const hasil = geserPeriodeSetahunKeBelakang({ mulai: '2026-09-30', selesai: '2026-09-30' });
    expect(hasil.mulai).toBe('2025-09-30');
    expect(hasil.selesai).toBe('2025-09-30');
  });

  test('periode Januari–September 2026 dibandingkan Januari–September 2025', () => {
    const hasil = geserPeriodeSetahunKeBelakang({ mulai: '2026-01-01', selesai: '2026-09-30' });
    expect(hasil).toEqual({ mulai: '2025-01-01', selesai: '2025-09-30' });
  });

  test('getLabaRugiKomparatif memakai engine existing & TIDAK membuat jurnal baru', async () => {
    const db = await setup();
    await jurnal(db, '2025-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 20_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 20_000_000 },
    ]);
    await jurnal(db, '2026-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 15_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 15_000_000 },
    ]);

    const jurnalSebelum = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    const sekarang = { mulai: '2026-01-01', selesai: '2026-09-30' };
    const pembanding = geserPeriodeSetahunKeBelakang(sekarang);
    const komparatif = await getLabaRugiKomparatif(db as any, sekarang, pembanding);
    const jurnalSesudah = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);

    expect(komparatif.sekarang.hasilUsaha).toBe(15_000_000);
    expect(komparatif.pembanding.hasilUsaha).toBe(20_000_000);
    // Angkanya IDENTIK dengan getLabaRugi biasa — tidak ada rumus kedua.
    const lrSekarang = await getLabaRugi(db as any, sekarang.mulai, sekarang.selesai);
    expect(komparatif.sekarang.hasilUsaha).toBe(lrSekarang.hasilUsaha);
    // Comparative hanya MEMBACA ledger.
    expect(jurnalSesudah!.cnt).toBe(jurnalSebelum!.cnt);
  });

  test('periode pembanding KUSTOM tetap dihormati (default tidak memaksa)', async () => {
    const db = await setup();
    await jurnal(db, '2025-03-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 9_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 9_000_000 },
    ]);
    await jurnal(db, '2026-06-01', 'PENDAPATAN_JASA', [
      { accountId: ACC.kas, debit: 15_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 15_000_000 },
    ]);

    const komparatif = await getLabaRugiKomparatif(
      db as any,
      { mulai: '2026-01-01', selesai: '2026-12-31' },
      { mulai: '2025-01-01', selesai: '2025-03-31' } // kustom, bukan default setahun penuh
    );
    expect(komparatif.pembanding.hasilUsaha).toBe(9_000_000);
  });
});
