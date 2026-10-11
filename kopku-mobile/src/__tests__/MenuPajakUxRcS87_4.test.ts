/**
 * RC-S87.4 — Menu Pajak mudah dipahami pengguna & pengawas.
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

import { createJournal } from '@/accounting/AccountingEngine';
import { catatPphFinalOtomatis, simpanPengaturanPajak } from '@/services/PajakService';
import { getDashboardPajak, susunTugasPajak } from '@/services/PajakDashboardService';
import { isiInfoPajak, KunciInfo } from '@/screens/Pajak/infoPajak';

const U = 'user-1';
const baca = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('RC-S87.4 — susunTugasPajak (murni)', () => {
  const kosong = { tahun: 2026, adaPengaturan: true, badan: false, pphFinalPerluDicatat: [], utangAktif: [], pph25JatuhTempo: [], adaDasarPph25TahunIni: false, perhitunganTahunLalu: null };

  it('tanpa pengaturan: satu tugas mendesak saja', () => {
    const t = susunTugasPajak({ ...kosong, adaPengaturan: false });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kunci: 'pengaturan', nada: 'MENDESAK', route: 'PengaturanPajak' });
  });

  it('semua beres: tidak ada tugas', () => {
    expect(susunTugasPajak(kosong)).toEqual([]);
  });

  it('urut mendesak dulu; setoran per akun membawa kodeAkun', () => {
    const t = susunTugasPajak({
      ...kosong,
      badan: true,
      adaDasarPph25TahunIni: true,
      utangAktif: [{ accountId: 'a', kode: '2-1901', nama: 'Utang PPh 4(2)', jenis: 'PPh Pasal 4(2) Bunga Simpanan', saldo: 25_000 }],
      pph25JatuhTempo: [{ masa: '2026-02', label: 'Februari 2026', nominal: 1_000_000, jatuhTempo: '2026-03-15', status: 'TERLAMBAT', pembayaran: null }],
    });
    expect(t.map((x) => x.nada)).toEqual(['MENDESAK', 'PERLU']);
    expect(t[1]).toMatchObject({ route: 'SetorPajakForm', params: { kodeAkun: '2-1901' }, nominal: 25_000 });
    expect(t[1].deskripsi).toMatch(/anggota/);
  });

  it('rezim badan tanpa dasar PPh 25: tugas menetapkan dasar', () => {
    expect(susunTugasPajak({ ...kosong, badan: true }).map((x) => x.kunci)).toContain('dasar-pph25');
  });
});

async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(`INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`, id, kode, nama, kategori, nb, now, now);
}

describe('RC-S87.4 — dashboard (integrasi)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedAccount('kas', '1-1000', 'Kas', 'ASET', 'DEBIT');
    await seedAccount('jasa', '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
    await seedAccount('bp', '5-2200', 'Beban Pajak Penghasilan', 'BEBAN', 'DEBIT');
    for (const t of [2025, 2026]) {
      await testDb.runAsync(`INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`, `p${t}`, t, `${t}-01-01`, `${t}-12-31`);
    }
    const now = new Date().toISOString();
    await testDb.runAsync(`INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at) VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`, now, now);
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    await createJournal(testDb as any, {
      tanggal: '2026-02-10', sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'x', createdBy: U,
      lines: [{ accountId: 'kas', debit: 40_000_000, kredit: 0 }, { accountId: 'jasa', debit: 0, kredit: 40_000_000 }],
    });
  });
  afterEach(() => testDb.closeSync());

  it('PPh Final belum dicatat muncul sebagai tugas; setelah dicatat berganti menjadi tugas setor & posisi pajak koperasi', async () => {
    const a = await getDashboardPajak('2026-03-20');
    expect(a.tugas[0]).toMatchObject({ kunci: 'pph-final', nominal: 200_000, nada: 'MENDESAK' }); // Februari lewat 15 Maret
    await catatPphFinalOtomatis({ createdBy: U, hariIni: '2026-03-20' });
    const b = await getDashboardPajak('2026-03-20');
    expect(b.tugas.map((t) => t.kunci)).toEqual(['setor-2-1904']);
    expect(b.posisi.pajakKoperasi.map((u) => u.saldo)).toEqual([200_000]);
    expect(b.posisi.dipotongAnggota).toEqual([]);
    expect(b.posisi.totalUtang).toBe(200_000);
  });
});

describe('RC-S87.5 — layar menu (versi sangat sederhana)', () => {
  const s = baca('screens/Pajak/PajakMenuScreen.tsx');

  it('hanya empat blok berurutan: status → sekarang → utang pajak → tombol besar', () => {
    const i = (t: string) => s.indexOf(t);
    expect(i('Pajak koperasi {tahun}')).toBeLessThan(i('>Sekarang<'));
    expect(i('>Sekarang<')).toBeLessThan(i('Utang pajak belum disetor'));
    expect(i('Utang pajak belum disetor')).toBeLessThan(i('styles.grid'));
  });

  it('satu tugas utama ditonjolkan; sisanya dan rincian utang dilipat', () => {
    expect(s).toMatch(/const \[utama, \.\.\.lain\] = dash\.tugas;/);
    expect(s).toMatch(/Lihat \$\{lain\.length\} tugas lainnya/);
    expect(s).toMatch(/Lihat rincian/);
    expect(s).toContain('Semua pajak sudah beres');
  });

  it('paling banyak empat tombol per rezim, masing-masing dengan tanda seru', () => {
    const kunci = [...s.matchAll(/info: '(\w+)'/g)].map((m) => m[1]);
    for (const k of ['menuPphFinal', 'menuPph25', 'menuPphBadan', 'menuSetor', 'menuRiwayat', 'menuPengaturan']) expect(kunci).toContain(k);
    expect(s).toMatch(/<TombolInfo isi=\{info\(b\.info\)\} \/>/);
    for (const k of ['caraKerja', 'tugas', 'posisiPajak', 'utangKoperasi', 'utangAnggota', 'kreditPajak']) expect(s).toContain(`info('${k}')`);
    for (const k of [...new Set(kunci), 'caraKerja', 'tugas', 'posisiPajak'] as KunciInfo[]) expect(isiInfoPajak(k, 2026).ringkas.length).toBeGreaterThan(20);
    for (const blok of s.split('? [').slice(1, 3)) expect((blok.split(']')[0].match(/route:/g) ?? []).length).toBeLessThanOrEqual(4);
  });

  it('label ringkas tetap benar secara hukum (11%/22% = PPh Badan)', () => {
    const { LABEL_REZIM_SINGKAT } = require('@/config/pajakPolicy');
    expect(LABEL_REZIM_SINGKAT.BADAN_31E).toMatch(/^PPh Badan/);
    expect(LABEL_REZIM_SINGKAT.BADAN_UMUM).toMatch(/^PPh Badan/);
    expect(LABEL_REZIM_SINGKAT.FINAL_UMKM).toBe('PPh Final 0,5%');
  });

  it('layar tidak menghitung atau menulis DB', () => {
    expect(s).not.toMatch(/getDb|runAsync|createJournal|hitungPph/);
    expect(s).not.toMatch(/'#[0-9A-Fa-f]{3,6}'/);
  });
});

describe('RC-S87.5 — Pengaturan Pajak (versi sangat sederhana)', () => {
  const s = baca('screens/Pajak/PengaturanPajakScreen.tsx');
  it('hanya dua pertanyaan yang terlihat; detail untuk pengawas dilipat', () => {
    expect(s).toContain('Apakah koperasi memakai PPh Final UMKM?');
    expect(s).toContain('Tahun terdaftar NPWP koperasi');
    expect(s).toMatch(/\{ nilai: 'FINAL_UMKM', label: 'Ya' \}/);
    expect(s).toMatch(/\{ nilai: 'UMUM', label: 'Tidak' \}/);
    expect(s).toContain('Detail untuk pengawas');
    expect(s).toMatch(/\{detailBuka && p && r \? \(/);
    expect(s).toContain('Mengapa?');
  });
});
