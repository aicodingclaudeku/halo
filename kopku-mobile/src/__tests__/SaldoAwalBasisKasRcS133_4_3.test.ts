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

import {
  tambahSaldoAwalAkun,
  hapusSaldoAwalAkun,
  koreksiSaldoAwal,
  aturBagianTunaiSaldoAwal,
  listSaldoAwalAkun,
  kunciSaldoAwalPermanen,
} from '@/services/SaldoAwalAkunService';
import { getInformasiShuRAT, getLabaRugi, getLHU } from '@/reports/FinancialReports';
import { createJournal } from '@/accounting/AccountingEngine';
import { kunciBelumTunai } from '@/accounting/SaldoAwalRealisasiKas';
import { buildLHUExport } from '@/export/ReportTableBuilders';

/**
 * RC-S133.4.3 — SHU Basis Kas untuk SALDO AWAL Pendapatan/Beban.
 *
 * Kasus nyata pengguna: mulai memakai aplikasi 29-09-2026, pendapatan
 * Jan–Sep diisi lewat Saldo Awal Akun (4-1000 Rp5.010.701 dan 4-1100
 * Rp280.345, lawan kliring 3-5000), kasnya sudah ada di saldo awal Kas.
 * Sebelum perbaikan: SHU Basis Kas Rp0, "akrual belum kas" Rp5.291.046.
 */
const ACC = {
  kas: 'acc-kas',
  piutang: 'acc-piutang',
  piutangJasa: 'acc-piutang-jasa',
  kliring: 'acc-kliring',
  cadangan: 'acc-cadangan',
  jasa: 'acc-jasa',
  admin: 'acc-admin',
  bebanUmum: 'acc-beban-umum',
};
const MULAI = '2026-01-01';
const SELESAI = '2026-12-31';
const USER = 'user-1';

async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${tt}-${role}`, tt, role, accountId);
}

async function setup() {
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(ACC.kliring, '3-5000', 'Saldo Awal Belum Sesuai', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.cadangan, '3-2000', 'Cadangan Umum', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.jasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.admin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.bebanUmum, '5-1000', 'Beban Umum', 'BEBAN', 'DEBIT');
  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('KOREKSI_SALDO_AWAL', 'KLIRING', ACC.kliring);
  await seedMapping('AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2026', 2026, ?, ?, 'OPEN')`,
    MULAI, SELESAI
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES (?, 'Admin Uji', 'admin-uji', 'ADMIN', 'x', 'x', 0, 1, ?, ?)`,
    USER, new Date().toISOString(), new Date().toISOString()
  );
}

/** Data awal persis seperti backup pengguna (bagian yang relevan). */
async function dataAwalPengguna(tanggal = '2026-09-29') {
  await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal, saldo: 215_134_518, createdBy: USER });
  await tambahSaldoAwalAkun({ accountId: ACC.piutang, tanggal, saldo: 254_135_316, createdBy: USER });
  await tambahSaldoAwalAkun({ accountId: ACC.jasa, tanggal, saldo: 5_010_701, createdBy: USER });
  await tambahSaldoAwalAkun({ accountId: ACC.admin, tanggal, saldo: 280_345, createdBy: USER });
  // penyeimbang neraca supaya kliring 3-5000 = 0, seperti data pengguna
  await tambahSaldoAwalAkun({ accountId: ACC.cadangan, tanggal, saldo: 215_134_518 + 254_135_316 - 5_291_046, createdBy: USER });
}

function cekIdentitas(r: Awaited<ReturnType<typeof getInformasiShuRAT>>) {
  expect(r.shuLaporanKeuanganAkrual - r.pendapatanAkrualBelumKas + r.pendapatanKasBelumAkrual + r.bebanAkrualBelumKas - r.bebanKasBelumAkrual).toBe(
    r.shuInformasiRat
  );
}

describe('RC-S133.4.3 — saldo awal pendapatan/beban ikut SHU Basis Kas', () => {
  beforeEach(setup);

  test('kasus pengguna: basis kas = Rp5.291.046 (sebelumnya Rp0), akrual tidak berubah', async () => {
    await dataAwalPengguna();
    const r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.shuLaporanKeuanganAkrual).toBe(5_291_046);
    expect(r.shuInformasiRat).toBe(5_291_046);
    expect(r.pendapatanRealisasiKas).toBe(5_291_046);
    expect(r.pendapatanSaldoAwalTunai).toBe(5_291_046);
    expect(r.pendapatanAkrualBelumKas).toBe(0);
    expect(r.selisihAkrualVsKas).toBe(0);
    cekIdentitas(r);
    // SHU akrual / laba rugi persis sama dengan sebelum perbaikan
    expect((await getLabaRugi(testDb as any, MULAI, SELESAI)).hasilUsaha).toBe(5_291_046);
  });

  test('sebagian masih piutang: bagian tunai Rp4.000.000 → basis kas & bridge menyesuaikan, tanpa jurnal baru', async () => {
    await dataAwalPengguna();
    const jurnalSebelum = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
    const hasil = await aturBagianTunaiSaldoAwal({ accountId: ACC.jasa, bagianTunai: 4_000_000, actingUserId: USER });
    expect(hasil.bagianBelumTunai).toBe(1_010_701);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n).toBe(jurnalSebelum);

    const r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.shuLaporanKeuanganAkrual).toBe(5_291_046);
    expect(r.shuInformasiRat).toBe(4_280_345);
    expect(r.pendapatanAkrualBelumKas).toBe(1_010_701);
    cekIdentitas(r);

    const baris = (await listSaldoAwalAkun()).find((x) => x.accountId === ACC.jasa)!;
    expect(baris.bagianBelumTunai).toBe(1_010_701);
    expect((await listSaldoAwalAkun()).find((x) => x.accountId === ACC.kas)!.bagianBelumTunai).toBe(0);

    // kembali ke seluruhnya tunai → disimpan 0 (pilihan eksplisit mengalahkan bawaan otomatis) — DIPERBARUI RC-S133.4.5
    await aturBagianTunaiSaldoAwal({ accountId: ACC.jasa, bagianTunai: 5_010_701, actingUserId: USER });
    expect(await testDb.getFirstAsync(`SELECT value FROM app_config WHERE key = ?`, kunciBelumTunai(ACC.jasa))).toEqual({ value: '0' });
    expect((await getInformasiShuRAT(testDb as any, MULAI, SELESAI)).shuInformasiRat).toBe(5_291_046);
  });

  test('validasi: melebihi saldo, angka negatif, dan akun neraca ditolak', async () => {
    await dataAwalPengguna();
    await expect(aturBagianTunaiSaldoAwal({ accountId: ACC.jasa, bagianTunai: 5_010_702, actingUserId: USER })).rejects.toThrow(/melebihi/);
    await expect(aturBagianTunaiSaldoAwal({ accountId: ACC.jasa, bagianTunai: -1, actingUserId: USER })).rejects.toThrow(/>= 0/);
    await expect(aturBagianTunaiSaldoAwal({ accountId: ACC.kas, bagianTunai: 1, actingUserId: USER })).rejects.toThrow(/Pendapatan atau Beban/);
    await expect(aturBagianTunaiSaldoAwal({ accountId: ACC.bebanUmum, bagianTunai: 1, actingUserId: USER })).rejects.toThrow(/belum pernah dicatat/);
  });

  test('tetap bisa diatur setelah saldo awal dikunci permanen, dan tercatat di audit log', async () => {
    await dataAwalPengguna();
    await kunciSaldoAwalPermanen(USER);
    await aturBagianTunaiSaldoAwal({ accountId: ACC.admin, bagianTunai: 0, actingUserId: USER });
    const r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.shuInformasiRat).toBe(5_010_701);
    const audit = await testDb.getAllAsync<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'SET_OPENING_BALANCE_CASH_PORTION'`);
    expect(audit).toHaveLength(1);
  });

  test('hapus saldo awal pendapatan → akrual & kas sama-sama turun, pengaturan bagian tunai ikut terhapus', async () => {
    await dataAwalPengguna();
    await aturBagianTunaiSaldoAwal({ accountId: ACC.jasa, bagianTunai: 3_000_000, actingUserId: USER });
    const baris = (await listSaldoAwalAkun()).find((x) => x.accountId === ACC.jasa)!;
    await hapusSaldoAwalAkun(baris.id, USER);
    const r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.shuLaporanKeuanganAkrual).toBe(280_345);
    expect(r.shuInformasiRat).toBe(280_345);
    expect(await testDb.getFirstAsync(`SELECT value FROM app_config WHERE key = ?`, kunciBelumTunai(ACC.jasa))).toBeNull();
    cekIdentitas(r);
  });

  test('koreksi saldo awal pendapatan → basis kas mengikuti; bagian belum tunai dipotong bila melebihi saldo baru', async () => {
    await dataAwalPengguna();
    await aturBagianTunaiSaldoAwal({ accountId: ACC.jasa, bagianTunai: 1_000_000, actingUserId: USER }); // belum tunai 4.010.701
    await koreksiSaldoAwal({ accountId: ACC.jasa, saldoBaru: 3_000_000, alasan: 'uji', actingUserId: USER });
    const baris = (await listSaldoAwalAkun()).find((x) => x.accountId === ACC.jasa)!;
    expect(baris.saldo).toBe(3_000_000);
    expect(baris.bagianBelumTunai).toBe(3_000_000);
    // periode lebar supaya jurnal koreksi (bertanggal hari ini) pasti masuk
    const r = await getInformasiShuRAT(testDb as any, '2000-01-01', '2100-12-31');
    expect(r.shuLaporanKeuanganAkrual).toBe(3_000_000 + 280_345);
    expect(r.shuInformasiRat).toBe(280_345);
    cekIdentitas(r);
  });

  test('saldo awal beban ikut beban realisasi kas', async () => {
    await dataAwalPengguna();
    await tambahSaldoAwalAkun({ accountId: ACC.bebanUmum, tanggal: '2026-09-29', saldo: 1_200_000, createdBy: USER });
    let r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.bebanSaldoAwalTunai).toBe(1_200_000);
    expect(r.shuInformasiRat).toBe(5_291_046 - 1_200_000);
    expect(r.shuLaporanKeuanganAkrual).toBe(5_291_046 - 1_200_000);
    await aturBagianTunaiSaldoAwal({ accountId: ACC.bebanUmum, bagianTunai: 200_000, actingUserId: USER });
    r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.bebanRealisasiKas).toBe(200_000);
    expect(r.bebanAkrualBelumKas).toBe(1_000_000);
    cekIdentitas(r);
  });

  test('saldo awal di luar periode tidak ikut', async () => {
    await dataAwalPengguna('2025-12-31');
    const r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.shuLaporanKeuanganAkrual).toBe(0);
    expect(r.shuInformasiRat).toBe(0);
    expect(r.pendapatanSaldoAwalTunai).toBe(0);
  });

  test('jurnal saldo awal batch lama yang sudah menyentuh Kas tidak dihitung dua kali', async () => {
    await createJournal(testDb as any, {
      tanggal: '2026-09-29',
      sumberTransaksi: 'SALDO_AWAL_AKUN',
      deskripsi: 'Saldo awal akun (opening balance) - 2 akun',
      createdBy: USER,
      lines: [
        { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
        { accountId: ACC.jasa, debit: 0, kredit: 1_000_000 },
      ],
    });
    const r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.shuInformasiRat).toBe(1_000_000);
    expect(r.pendapatanSaldoAwalTunai).toBe(0); // sudah lewat jalur 1
    cekIdentitas(r);
  });

  test('akrual jasa biasa (Dr Piutang Jasa / Cr Pendapatan) tetap "akrual belum kas" — perilaku lama tidak berubah', async () => {
    await createJournal(testDb as any, {
      tanggal: '2026-10-31',
      sumberTransaksi: 'AKRUAL_JASA_PINJAMAN',
      deskripsi: 'Akrual jasa',
      createdBy: USER,
      lines: [
        { accountId: ACC.piutangJasa, debit: 150_000, kredit: 0 },
        { accountId: ACC.jasa, debit: 0, kredit: 150_000 },
      ],
    });
    const r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    expect(r.shuInformasiRat).toBe(0);
    expect(r.pendapatanAkrualBelumKas).toBe(150_000);
    expect(r.pendapatanSaldoAwalTunai).toBe(0);
  });

  test('export LHU memuat keterangan saldo awal hanya bila ada', async () => {
    await dataAwalPengguna();
    const r = await getInformasiShuRAT(testDb as any, MULAI, SELESAI);
    const lhu = await getLHU(testDb as any, MULAI, SELESAI);
    const teks = (x: any) => JSON.stringify(x.baris);
    const ada = teks(buildLHUExport({} as any, lhu, 'LHU', r));
    expect(ada).toContain('Saldo awal pendapatan, dianggap sudah diterima tunai');
    const tanpa = teks(buildLHUExport({} as any, lhu, 'LHU', { ...r, pendapatanSaldoAwalTunai: 0, bebanSaldoAwalTunai: 0 }));
    expect(tanpa).not.toContain('Saldo awal pendapatan');
  });
});
