/**
 * RC-S87.3 — Perhitungan pajak otomatis + rincian yang konsisten.
 */
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

import { createJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { catatPphFinalOtomatis, getDaftarMasaPphFinal, getRincianPphFinal, simpanPengaturanPajak, tambahPengecualianOmzet } from '@/services/PajakService';
import {
  getDasarPph25,
  getUsulanDasarPph25,
  hitungPphBadanTahun,
  kunciPerhitunganPphBadan,
  nyatakanRekonsiliasiFiskal,
  tetapkanDasarPph25Otomatis,
} from '@/services/PajakBadanService';
import { hitungDasarPph25, hitungPphBadanNonFinal, hitungPphFinal, kebijakanUntukTahun, rincianPphBadan, rincianPphFinal } from '@/config/pajakPolicy';

const U = 'user-1';
const K = kebijakanUntukTahun(2026);
const baca = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('RC-S87.3 A — rincian (murni)', () => {
  it('PPh Final: akun dikecualikan tampil dicoret tetapi tidak dihitung; pajak = hitungPphFinal(dasar)', () => {
    const r = rincianPphFinal({
      masa: '2026-03',
      akun: [
        { kode: '4-1000', nama: 'Jasa', nilai: 20_000_000 },
        { kode: '4-1510', nama: 'Bunga deposito', nilai: 1_000_000, alasanDikecualikan: 'Sudah PPh final' },
      ],
      kebijakan: K,
    });
    expect(r.dasar).toBe(20_000_000);
    expect(r.pajak).toBe(hitungPphFinal(20_000_000));
    expect(r.langkah.find((l) => l.jenis === 'dikecualikan')!.nilai).toBe(1_000_000);
    expect(r.langkah[r.langkah.length - 1]).toMatchObject({ jenis: 'hasil', nilai: 100_000 });
    expect(r.jatuhTempo).toBe('2026-04-15');
  });

  it('PPh Badan: baris hasil = PPh 29 dan subtotal PPh = fasilitas + non-fasilitas', () => {
    const h = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 10_000_000_000, pkpSebelumPembulatan: 1_000_000_500, kredit: { pph25: 60_000_000, pph22: 0, pph23: 7_200_000, pph24: 0 }, kebijakan: K });
    const r = rincianPphBadan({ tahun: 2025, hasil: h, labaKomersial: 990_000_500, koreksi: [{ uraian: 'Sumbangan', jenis: 'POSITIF', nilai: 10_000_000 }] });
    const hasil = r.langkah[r.langkah.length - 1];
    expect(hasil).toMatchObject({ jenis: 'hasil', nilai: h.pph29 });
    expect(r.langkah.find((l) => l.label === 'PPh Badan terutang')!.nilai).toBe(h.pphFasilitas + h.pphNonFasilitas);
    expect(r.langkah.find((l) => l.label === 'Penghasilan Kena Pajak (PKP)')!.nilai).toBe(1_000_000_000);
  });

  it('dasar PPh 25 = (PPh terutang − kredit PPh 22/23/24) ÷ 12, dibulatkan ke bawah, tidak negatif', () => {
    expect(hitungDasarPph25({ tahunPajak: 2026, pphTerutangTahunLalu: 34_100_000, kreditPph22: 0, kreditPph23: 1_000_000, kreditPph24: 0 }).angsuranBulanan).toBe(2_758_333);
    expect(hitungDasarPph25({ tahunPajak: 2026, pphTerutangTahunLalu: 1_000, kreditPph22: 0, kreditPph23: 5_000, kreditPph24: 0 }).angsuranBulanan).toBe(0);
  });
});

// ---------------------------------------------------------------------------

const ACC = { kas: 'acc-kas', jasa: 'acc-jasa', bunga: 'acc-bunga', beban: 'acc-beban', modal: 'acc-modal', bebanPajak: 'acc-5-2200' };
async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}
async function jurnal(tanggal: string, debit: string, kredit: string, nominal: number) {
  await createJournal(testDb as any, {
    tanggal, sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'uji', createdBy: U,
    lines: [{ accountId: debit, debit: nominal, kredit: 0 }, { accountId: kredit, debit: 0, kredit: nominal }],
  });
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.jasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.bunga, '4-1510', 'Bunga Deposito', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.beban, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.modal, '3-1000', 'Modal', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.bebanPajak, '5-2200', 'Beban Pajak Penghasilan', 'BEBAN', 'DEBIT');
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m1','KAS_UMUM','DEFAULT',?)`, ACC.kas);
  for (const t of [2024, 2025, 2026]) {
    await testDb.runAsync(`INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`, `p${t}`, t, `${t}-01-01`, `${t}-12-31`);
  }
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at) VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await jurnal('2024-01-02', ACC.kas, ACC.modal, 100_000_000);
});
afterEach(() => testDb.closeSync());

describe('RC-S87.3 B — PPh Final otomatis', () => {
  beforeEach(async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    await jurnal('2026-01-10', ACC.kas, ACC.jasa, 20_000_000);
    await jurnal('2026-03-10', ACC.kas, ACC.jasa, 30_000_000);
    await jurnal('2026-03-20', ACC.kas, ACC.bunga, 4_000_000);
    await jurnal('2026-04-05', ACC.kas, ACC.jasa, 9_000_000);
  });

  it('status tiap masa dihitung sendiri: perlu dicatat / nihil / berjalan, dengan jatuh tempo', async () => {
    const d = await getDaftarMasaPphFinal('2026-04-20');
    const s = Object.fromEntries(d.map((m) => [m.masa, m]));
    expect(s['2026-04'].status).toBe('BERJALAN');
    expect(s['2026-03']).toMatchObject({ status: 'PERLU_DICATAT', pajak: 170_000, jatuhTempo: '2026-04-15', terlambat: true });
    expect(s['2026-02'].status).toBe('NIHIL');
    expect(s['2026-01']).toMatchObject({ status: 'PERLU_DICATAT', pajak: 100_000 });
  });

  it('RC-S95 — tanpa argumen, daftar masa memakai "hari ini" jam aplikasi (Mode Pengujian Waktu)', async () => {
    // Sebelum RC-S95 default-nya `new Date().toISOString().slice(0, 10)`:
    // jam ASLI perangkat dan zona UTC, sehingga Mode Pengujian Waktu
    // diabaikan dan daftar masa berpatokan pada bulan yang salah.
    const { _resetStateUntukTest, setJamUjiAktif, setWaktuKustom } = require('@/services/DevClockService');
    try {
      await setJamUjiAktif(testDb, true);
      await setWaktuKustom(testDb, '2026-04-20', '09:00');
      const tanpaArgumen = await getDaftarMasaPphFinal();
      const eksplisit = await getDaftarMasaPphFinal('2026-04-20');
      expect(tanpaArgumen).toEqual(eksplisit);
      expect(tanpaArgumen.find((m) => m.masa === '2026-04')!.status).toBe('BERJALAN');
    } finally {
      _resetStateUntukTest();
    }
  });

  it('catat otomatis semua masa sekaligus; dipanggil ulang tidak mencatat ganda; nominal = rincian', async () => {
    const h = await catatPphFinalOtomatis({ createdBy: U, hariIni: '2026-04-20' });
    expect(h.dicatat.map((x) => x.masa)).toEqual(['2026-01', '2026-03']);
    expect(h.gagal).toEqual([]);
    const lagi = await catatPphFinalOtomatis({ createdBy: U, hariIni: '2026-04-20' });
    expect(lagi.dicatat).toEqual([]);
    const utang = (await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = '2-1904'`))!.id;
    expect(await getAccountBalance(testDb as any, utang)).toBe(270_000);
    const d = await getDaftarMasaPphFinal('2026-04-20');
    expect(d.find((m) => m.masa === '2026-03')).toMatchObject({ status: 'DICATAT', pajak: 170_000 });
  });

  it('pengecualian terkonfigurasi otomatis dipakai dan tampil di rincian', async () => {
    await tambahPengecualianOmzet({ accountId: ACC.bunga, alasan: 'Bunga deposito sudah PPh final', dasarAturan: 'PP 131/2000', userId: U });
    const r = await getRincianPphFinal('2026-03');
    expect(r.dasar).toBe(30_000_000);
    expect(r.pajak).toBe(150_000);
    expect(r.langkah.some((l) => l.jenis === 'dikecualikan' && l.rumus!.includes('Bunga deposito'))).toBe(true);
    const h = await catatPphFinalOtomatis({ createdBy: U, hariIni: '2026-04-20' });
    expect(h.dicatat.find((x) => x.masa === '2026-03')!.nominal).toBe(150_000);
  });
});

describe('RC-S87.3 B — PPh 25 & PPh Badan otomatis', () => {
  async function kunci2025() {
    await simpanPengaturanPajak({ skema: 'UMUM', tahunTerdaftar: 2015, updatedBy: U });
    await jurnal('2025-06-30', ACC.kas, ACC.jasa, 1_000_000_000);
    await jurnal('2025-06-30', ACC.beban, ACC.kas, 700_000_000);
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    await kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: '2026-03-01' });
  }

  it('tanpa perhitungan tahun lalu yang dikunci: tidak ada usulan (tidak menebak)', async () => {
    await simpanPengaturanPajak({ skema: 'UMUM', tahunTerdaftar: 2015, updatedBy: U });
    const u = await getUsulanDasarPph25(2026);
    expect(u.tersedia).toBe(false);
    await expect(tetapkanDasarPph25Otomatis({ tahunPajak: 2026, userId: U })).rejects.toThrow(/belum dikunci/);
  });

  it('dasar PPh 25 otomatis dari PPh Badan tahun lalu yang dikunci, dengan rincian & referensi', async () => {
    await kunci2025();
    const u = await getUsulanDasarPph25(2026);
    expect(u.tersedia).toBe(true);
    expect(u.angsuranBulanan).toBe(2_750_000); // 33.000.000 ÷ 12
    expect(u.rincian!.langkah[u.rincian!.langkah.length - 1].nilai).toBe(2_750_000);
    await tetapkanDasarPph25Otomatis({ tahunPajak: 2026, userId: U });
    const d = await getDasarPph25(2026);
    expect(d).toMatchObject({ angsuranBulanan: 2_750_000, sumber: 'PERHITUNGAN_TAHUN_LALU', tahunSumber: 2025 });
    expect(d!.nomorReferensi).toMatch(/^PPH-BADAN-2025\//);
  });

  it('rincian PPh Badan konsisten dengan hasil engine, sebelum dan sesudah dikunci', async () => {
    await kunci2025();
    const p = await hitungPphBadanTahun(2025, '2026-03-01');
    expect(p.status).toBe('TERKUNCI');
    const hasil = p.rincian!.langkah[p.rincian!.langkah.length - 1];
    expect(hasil.nilai).toBe(p.snapshot!.hasil.pph29);
    expect(p.rincian!.langkah.find((l) => l.label === 'Laba komersial (SHU sebelum pajak)')!.nilai).toBe(300_000_000);
  });
});

describe('RC-S87.3 — layar hanya menampilkan', () => {
  it('layar PPh Final tidak lagi menghitung pajak sendiri', () => {
    const s = baca('screens/Pajak/PphFinalFormScreen.tsx');
    expect(s).not.toMatch(/hitungPphFinal\(/);
    expect(s).toMatch(/catatPphFinalOtomatis\(/);
    expect(s).toMatch(/<KartuRincian /);
  });
  it('rincian dirender satu komponen di PPh Final, PPh 25, dan PPh Badan', () => {
    for (const f of ['PphFinalFormScreen', 'AngsuranPph25FormScreen', 'PphBadanFormScreen']) expect(baca(`screens/Pajak/${f}.tsx`)).toMatch(/<KartuRincian /);
  });
});
