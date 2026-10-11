/**
 * RC-S87 — TAX REGIME ENGINE: PPh Final UMKM 0,5% | PPh Badan Pasal 31E (11%) + tarif umum (22%).
 *
 * Bagian A: aturan murni (pajakPolicy). Bagian B: integrasi di atas SQLite
 * sungguhan dengan jurnal AccountingEngine asli.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
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
import { getLHU } from '@/reports/FinancialReports';
import {
  catatPphBadan,
  catatPphFinal,
  evaluasiRezimPajak,
  simpanPengaturanPajak,
  tambahPengecualianOmzet,
  tetapkanOverrideRezim,
} from '@/services/PajakService';
import {
  batalkanPerhitunganPphBadan,
  bayarAngsuranPph25Terjadwal,
  catatKreditPajakLain,
  getJadwalPph25,
  hitungPphBadanTahun,
  kunciPerhitunganPphBadan,
  listSnapshotPphBadan,
  nyatakanRekonsiliasiFiskal,
  tambahKoreksiFiskal,
  tetapkanDasarPph25,
} from '@/services/PajakBadanService';
// RC-S87.4 — dashboard dipindah ke service tersendiri (engine PPh Badan tetap bersih dari PPh 4(2) anggota).
import { getDashboardPajak } from '@/services/PajakDashboardService';
import {
  KEBIJAKAN_PAJAK,
  LABEL_REZIM,
  hitungPphBadanNonFinal,
  jatuhTempoPph25,
  kebijakanUntukTahun,
  tentukanRezimPajak,
} from '@/config/pajakPolicy';

const U = 'user-1';
const NTPN = 'AB12CD34EF56GH78';
const K = kebijakanUntukTahun(2025);
const NOL = { pph25: 0, pph22: 0, pph23: 0, pph24: 0 };
const HARI_INI = '2026-03-01';

// ===========================================================================
// A. Aturan murni
// ===========================================================================

describe('RC-S87 A — kalkulator PPh Badan non-final', () => {
  it('omzet <= Rp4,8 M: seluruh PKP fasilitas Pasal 31E, tarif efektif 11%', () => {
    const h = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 1_000_000_000, pkpSebelumPembulatan: 310_000_000, kredit: NOL, kebijakan: K });
    expect(h.pkp).toBe(310_000_000);
    expect(h.pkpFasilitas).toBe(310_000_000);
    expect(h.tarifFasilitasPersen).toBe(11);
    expect(h.pphFasilitas).toBe(34_100_000);
    expect(h.pkpNonFasilitas).toBe(0);
    expect(h.pphNonFasilitas).toBe(0);
    expect(h.totalPphBadan).toBe(34_100_000);
  });

  it('Rp4,8 M < omzet <= Rp50 M: PKP dialokasikan proporsional — fasilitas 11%, sisanya 22%', () => {
    const h = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 10_000_000_000, pkpSebelumPembulatan: 1_000_000_000, kredit: NOL, kebijakan: K });
    expect(h.pkpFasilitas).toBe(480_000_000); // 4,8 M / 10 M × 1 M
    expect(h.pphFasilitas).toBe(52_800_000); // × 11%
    expect(h.pkpNonFasilitas).toBe(520_000_000);
    expect(h.tarifUmumPersen).toBe(22);
    expect(h.pphNonFasilitas).toBe(114_400_000); // × 22%
    expect(h.totalPphBadan).toBe(167_200_000);
    expect(h.pkpFasilitas + h.pkpNonFasilitas).toBe(h.pkp);
  });

  it('pecahan PKP fasilitas dibulatkan ke bawah, nilai eksak disimpan untuk audit; tanpa floating point', () => {
    const h = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 7_000_000_000, pkpSebelumPembulatan: 123_456_789, kredit: NOL, kebijakan: K });
    expect(h.pkp).toBe(123_456_000); // Pasal 17(4): ke bawah ribuan penuh
    expect(h.pkpSebelumPembulatan).toBe(123_456_789);
    // 4.800.000.000 × 123.456.000 / 7.000.000.000 = 84.655.542,857...
    expect(h.pkpFasilitas).toBe(84_655_542);
    expect(h.pkpFasilitasEksak).toBe('84655542 6000000000/7000000000');
    expect(h.pphFasilitas).toBe(Math.floor((84_655_542 * 11) / 100));
    expect(h.pphNonFasilitas).toBe(Math.floor(((123_456_000 - 84_655_542) * 22) / 100));
    for (const v of [h.pkp, h.pkpFasilitas, h.pphFasilitas, h.pphNonFasilitas, h.totalPphBadan]) expect(Number.isInteger(v)).toBe(true);
  });

  it('omzet > Rp50 M atau rezim BADAN_UMUM: tanpa fasilitas, seluruh PKP 22%', () => {
    const a = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 60_000_000_000, pkpSebelumPembulatan: 1_000_000_000, kredit: NOL, kebijakan: K });
    const b = hitungPphBadanNonFinal({ rezim: 'BADAN_UMUM', peredaranBruto: 1_000_000_000, pkpSebelumPembulatan: 1_000_000_000, kredit: NOL, kebijakan: K });
    for (const h of [a, b]) {
      expect(h.pkpFasilitas).toBe(0);
      expect(h.totalPphBadan).toBe(220_000_000);
    }
  });

  it('PKP nol/rugi tidak menghasilkan PPh terutang positif', () => {
    for (const pkp of [0, -50_000_000, 999]) {
      const h = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 1_000_000_000, pkpSebelumPembulatan: pkp, kredit: NOL, kebijakan: K });
      expect(h.totalPphBadan).toBe(0);
      expect(h.pph29).toBe(0);
    }
  });

  it('kredit mengurangi PPh Badan; PPh 29 = kekurangan; kelebihan dilaporkan sebagai lebih bayar', () => {
    const h = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 1_000_000_000, pkpSebelumPembulatan: 310_000_000, kredit: { pph25: 12_000_000, pph22: 0, pph23: 2_000_000, pph24: 0 }, kebijakan: K });
    expect(h.totalKredit).toBe(14_000_000);
    expect(h.pph29).toBe(20_100_000);
    expect(h.lebihBayar).toBe(0);
    const lb = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 1_000_000_000, pkpSebelumPembulatan: 10_000_000, kredit: { ...NOL, pph25: 5_000_000 }, kebijakan: K });
    expect(lb.pph29).toBe(0);
    expect(lb.lebihBayar).toBe(5_000_000 - 1_100_000);
  });

  it('jatuh tempo PPh 25 = tanggal 15 bulan berikutnya (dari kebijakan), termasuk pergantian tahun', () => {
    expect(jatuhTempoPph25('2026-03', K)).toBe('2026-04-15');
    expect(jatuhTempoPph25('2026-12', K)).toBe('2027-01-15');
  });
});

describe('RC-S87 A — resolver rezim (murni)', () => {
  const dasar = { tahunPajak: 2026, omzetPerTahun: {}, omzetTahunBerjalan: 0, override: null };

  it('masih memenuhi PPh Final -> otomatis FINAL_UMKM 0,5%', () => {
    const r = tentukanRezimPajak({ ...dasar, pengaturan: { skema: 'FINAL_UMKM', tahunTerdaftar: 2022 }, omzetPerTahun: { 2025: 3_000_000_000 } });
    expect(r.rezim).toBe('FINAL_UMKM');
    expect(r.sumber).toBe('OTOMATIS');
    expect(r.parameter.omzetTahunSebelumnya).toBe(3_000_000_000);
    expect(r.parameter.versiKebijakan).toBe(K.versi);
  });

  it('omzet tahun berjalan > Rp4,8 M TIDAK mengakhiri PPh Final tahun ini (hanya peringatan)', () => {
    const r = tentukanRezimPajak({ ...dasar, pengaturan: { skema: 'FINAL_UMKM', tahunTerdaftar: 2022 }, omzetTahunBerjalan: 6_000_000_000 });
    expect(r.rezim).toBe('FINAL_UMKM');
    expect(r.peringatan.join(' ')).toMatch(/tahun pajak berikutnya/);
  });

  it('omzet tahun sebelumnya > Rp4,8 M -> PPh Badan tahun ini, dan tidak kembali ke final tahun berikutnya', () => {
    const p = { skema: 'FINAL_UMKM' as const, tahunTerdaftar: 2022 };
    const r = tentukanRezimPajak({ ...dasar, pengaturan: p, omzetPerTahun: { 2025: 5_000_000_000 }, omzetTahunBerjalan: 3_000_000_000 });
    expect(r.rezim).toBe('BADAN_31E');
    expect(r.tahunKeluarFinalKarenaOmzet).toBe(2026);
    const r2 = tentukanRezimPajak({ ...dasar, tahunPajak: 2027, pengaturan: p, omzetPerTahun: { 2025: 5_000_000_000, 2026: 1_000_000_000 }, omzetTahunBerjalan: 1 });
    expect(r2.rezim).toBe('BADAN_31E');
  });

  it('rezim umum: omzet <= Rp50 M -> BADAN_31E; > Rp50 M -> BADAN_UMUM', () => {
    const p = { skema: 'UMUM' as const, tahunTerdaftar: 2015 };
    expect(tentukanRezimPajak({ ...dasar, pengaturan: p, omzetTahunBerjalan: 4_000_000_000 }).rezim).toBe('BADAN_31E');
    expect(tentukanRezimPajak({ ...dasar, pengaturan: p, omzetTahunBerjalan: 20_000_000_000 }).rezim).toBe('BADAN_31E');
    expect(tentukanRezimPajak({ ...dasar, pengaturan: p, omzetTahunBerjalan: 50_000_000_001 }).rezim).toBe('BADAN_UMUM');
  });

  it('fasilitas final habis -> PPh Badan dengan alasan tercatat', () => {
    const r = tentukanRezimPajak({ ...dasar, pengaturan: { skema: 'FINAL_UMKM', tahunTerdaftar: 2019 } });
    expect(r.rezim).toBe('BADAN_31E');
    expect(r.alasan.join(' ')).toMatch(/berakhir/);
  });

  it('override menang tetapi selisihnya dengan hasil otomatis tercatat', () => {
    const r = tentukanRezimPajak({ ...dasar, pengaturan: { skema: 'UMUM', tahunTerdaftar: 2015 }, override: { rezim: 'BADAN_UMUM', alasan: 'Surat DJP', nomorDokumen: 'S-1/2026' } });
    expect(r.rezim).toBe('BADAN_UMUM');
    expect(r.sumber).toBe('OVERRIDE');
    expect(r.peringatan.join(' ')).toMatch(/berbeda/);
  });

  it('istilah hukum benar dan tidak ada "PPh Final 11%/22%" di kode produksi', () => {
    expect(LABEL_REZIM).toEqual({
      FINAL_UMKM: 'PPh Final UMKM 0,5%',
      BADAN_31E: 'PPh Badan – Fasilitas Pasal 31E (tarif efektif 11%)',
      BADAN_UMUM: 'PPh Badan – Tarif Umum 22%',
    });
    const src = join(__dirname, '..');
    const periksa = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) {
          if (n !== '__tests__') periksa(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(n)) continue;
        const isi = readFileSync(p, 'utf8');
        expect({ p, cocok: /PPh Final\s*(11|22)\s*%|FINAL_(11|22)\b/i.test(isi) }).toEqual({ p, cocok: false });
      }
    };
    periksa(src);
  });

  it('PPh 4(2) bunga simpanan anggota tidak disentuh engine PPh Badan', () => {
    const isi = readFileSync(join(__dirname, '..', 'services', 'PajakBadanService.ts'), 'utf8');
    expect(isi).not.toMatch(/KODE_UTANG_PPH_BUNGA_SIMPANAN|2-1901|PphPotongService/);
  });
});

// ===========================================================================
// B. Integrasi
// ===========================================================================

const ACC = { kas: 'acc-kas', jasa: 'acc-jasa', beban: 'acc-beban', modal: 'acc-modal', bebanPajak: 'acc-5-2200' };

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
    lines: [
      { accountId: debit, debit: nominal, kredit: 0 },
      { accountId: kredit, debit: 0, kredit: nominal },
    ],
  });
}
async function saldoKode(kode: string, per?: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, kode);
  return r ? getAccountBalance(testDb as any, r.id, per) : 0;
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.jasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.beban, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.modal, '3-1000', 'Modal', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.bebanPajak, '5-2200', 'Beban Pajak Penghasilan', 'BEBAN', 'DEBIT');
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m1','KAS_UMUM','DEFAULT',?)`, ACC.kas);
  for (const t of [2024, 2025, 2026]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${t}`, t, `${t}-01-01`, `${t}-12-31`
    );
  }
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`, now, now
  );
  await jurnal('2025-01-02', ACC.kas, ACC.modal, 100_000_000); // modal kas — bukan omzet
});
afterEach(() => testDb.closeSync());

/** Tahun 2025: omzet 1 M, beban 700 jt -> laba komersial 300 jt. */
async function tahunBadan2025() {
  await simpanPengaturanPajak({ skema: 'UMUM', tahunTerdaftar: 2015, updatedBy: U });
  await jurnal('2025-06-30', ACC.kas, ACC.jasa, 1_000_000_000);
  await jurnal('2025-06-30', ACC.beban, ACC.kas, 700_000_000);
}

async function siapkanPph25(bulan: number[]) {
  await tetapkanDasarPph25({
    tahunPajak: 2025, angsuranBulanan: 1_000_000, sumber: 'SPT_TAHUNAN', tahunSumber: 2024,
    nomorReferensi: 'SPT-2024-001', tanggalReferensi: '2025-04-30', userId: U,
  });
  for (const b of bulan) {
    const masa = `2025-${String(b).padStart(2, '0')}`;
    await bayarAngsuranPph25Terjadwal({ masa, jenisRekening: 'KAS', tanggal: `2025-${String(b).padStart(2, '0')}-20`, ntpn: NTPN, createdBy: U });
  }
}

describe('RC-S87 B — rezim & PPh Final', () => {
  it('koperasi masih memenuhi PPh Final: rezim FINAL_UMKM, PPh Final 0,5% tetap jalan, PPh Badan tidak berlaku', async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    await jurnal('2026-02-10', ACC.kas, ACC.jasa, 20_000_000);
    expect((await evaluasiRezimPajak(2026)).rezim).toBe('FINAL_UMKM');
    const h = await catatPphFinal({ masa: '2026-02', akunDikecualikan: [], createdBy: U });
    expect(h.nominal).toBe(100_000);
    const e = await testDb.getAllAsync<{ konteks: string; rezim: string }>(`SELECT konteks, rezim FROM pajak_rezim_evaluasi`);
    expect(e).toEqual([{ konteks: 'PPH_FINAL:2026-02', rezim: 'FINAL_UMKM' }]); // keputusan tersimpan untuk audit
    expect((await hitungPphBadanTahun(2026, '2027-02-01')).status).toBe('BUKAN_REZIM_BADAN');
  });

  it('omzet tahun lalu > Rp4,8 M: PPh Final ditolak, rezim otomatis PPh Badan', async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    await jurnal('2025-05-01', ACC.kas, ACC.jasa, 5_000_000_000);
    await jurnal('2026-02-10', ACC.kas, ACC.jasa, 20_000_000);
    expect((await evaluasiRezimPajak(2025)).rezim).toBe('FINAL_UMKM'); // tahun berjalan melewati batas: tetap final
    expect((await evaluasiRezimPajak(2026)).rezim).toBe('BADAN_31E');
    await expect(catatPphFinal({ masa: '2026-02', akunDikecualikan: [], createdBy: U })).rejects.toThrow(/PPh Badan/);
  });

  it('pengecualian omzet terkonfigurasi (dengan alasan & dasar aturan) dipakai resolver dan PPh Final', async () => {
    await seedAccount('acc-bunga', '4-1510', 'Bunga Deposito', 'PENDAPATAN', 'KREDIT');
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    await jurnal('2025-05-01', ACC.kas, 'acc-bunga', 5_000_000_000);
    expect((await evaluasiRezimPajak(2026)).rezim).toBe('BADAN_31E');
    await expect(tambahPengecualianOmzet({ accountId: 'acc-bunga', alasan: '', dasarAturan: 'x', userId: U })).rejects.toThrow(/Alasan/);
    await tambahPengecualianOmzet({ accountId: 'acc-bunga', alasan: 'Sudah dipotong PPh final bunga deposito', dasarAturan: 'PP 131/2000', userId: U });
    expect((await evaluasiRezimPajak(2026)).rezim).toBe('FINAL_UMKM');
  });

  it('override rezim wajib alasan & dokumen, dan dipakai engine', async () => {
    await tahunBadan2025();
    await expect(tetapkanOverrideRezim({ tahun: 2025, rezim: 'BADAN_UMUM', alasan: 'x', nomorDokumen: '', tanggalDokumen: '2025-12-01', userId: U })).rejects.toThrow(/dokumen/);
    await tetapkanOverrideRezim({ tahun: 2025, rezim: 'BADAN_UMUM', alasan: 'Keputusan DJP', nomorDokumen: 'KEP-1/2025', tanggalDokumen: '2025-12-01', userId: U });
    const p = await hitungPphBadanTahun(2025, HARI_INI);
    expect(p.rezim.sumber).toBe('OVERRIDE');
    expect(p.hasil!.totalPphBadan).toBe(66_000_000); // 300 jt × 22%
  });
});

describe('RC-S87 B — PPh 25', () => {
  it('dasar angsuran menghasilkan jadwal otomatis; bayar hanya butuh sumber dana, tanggal, NTPN', async () => {
    await tahunBadan2025();
    await siapkanPph25([1, 2]);
    const j = await getJadwalPph25(2025, '2025-04-20');
    expect(j.masa).toHaveLength(12);
    expect(j.masa.slice(0, 4).map((m) => m.status)).toEqual(['LUNAS', 'LUNAS', 'TERLAMBAT', 'JATUH_TEMPO']);
    expect(j.masa[0].pembayaran!.ntpn).toBe(NTPN);
    expect(j.masa[0].jatuhTempo).toBe('2025-02-15');
    expect(j.totalDibayar).toBe(2_000_000);
    expect(await saldoKode('1-1410')).toBe(2_000_000); // kredit (aset), bukan beban
    expect(await saldoKode('5-2200')).toBe(0);
  });

  it('PPh 25 tidak terduplikasi per masa; NTPN wajib 16 karakter bila diisi; dasar wajib referensi', async () => {
    await tahunBadan2025();
    await siapkanPph25([1]);
    await expect(bayarAngsuranPph25Terjadwal({ masa: '2025-01', jenisRekening: 'KAS', tanggal: '2025-01-21', ntpn: NTPN, createdBy: U })).rejects.toThrow(/sudah dicatat/);
    await expect(bayarAngsuranPph25Terjadwal({ masa: '2025-02', jenisRekening: 'KAS', tanggal: '2025-02-21', ntpn: 'ABC', createdBy: U })).rejects.toThrow(/16/);
    await expect(
      tetapkanDasarPph25({ tahunPajak: 2025, angsuranBulanan: 1, sumber: 'SPT_TAHUNAN', tahunSumber: 2024, nomorReferensi: ' ', tanggalReferensi: '2025-01-01', userId: U })
    ).rejects.toThrow(/referensi/);
  });
});

describe('RC-S87 B — PPh Badan akhir tahun (engine)', () => {
  it('tahun belum berakhir & rekonsiliasi fiskal belum lengkap -> tidak bisa dikunci', async () => {
    await tahunBadan2025();
    expect((await hitungPphBadanTahun(2025, '2025-11-01')).status).toBe('TAHUN_PAJAK_BELUM_BERAKHIR');
    const p = await hitungPphBadanTahun(2025, HARI_INI);
    expect(p.status).toBe('REKONSILIASI_BELUM_LENGKAP');
    await expect(kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI })).rejects.toThrow(/Rekonsiliasi fiskal belum lengkap/);
    expect(await testDb.getAllAsync(`SELECT id FROM pajak_badan_snapshot`)).toHaveLength(0);
  });

  it('alur penuh: laba komersial -> koreksi fiskal -> PKP -> 31E 11% -> kredit PPh 25 -> PPh 29 -> jurnal & snapshot', async () => {
    await tahunBadan2025();
    await siapkanPph25([1, 2, 3]);
    await tambahKoreksiFiskal({
      tahunPajak: 2025, jenis: 'POSITIF', uraian: 'Sumbangan', nilaiKomersial: 10_000_000, nilaiFiskal: 0,
      alasan: 'Bukan biaya yang dapat dikurangkan', referensiAturan: 'UU PPh Pasal 9 ayat (1) huruf g', userId: U,
    });
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    const p = await hitungPphBadanTahun(2025, HARI_INI);
    expect(p.status).toBe('SIAP_DIKUNCI');
    expect(p.omzetBruto).toBe(1_000_000_000);
    expect(p.labaKomersial).toBe(300_000_000);
    expect(p.hasil).toMatchObject({ pkp: 310_000_000, pkpFasilitas: 310_000_000, pphFasilitas: 34_100_000, pphNonFasilitas: 0, totalPphBadan: 34_100_000, pph29: 31_100_000 });
    expect(p.hasil!.kredit.pph25).toBe(3_000_000);

    const k = await kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI });
    expect(k.journalId).toBeTruthy();
    // Rekonsiliasi ke laporan keuangan
    expect(await saldoKode('5-2200')).toBe(34_100_000);
    expect(await saldoKode('1-1410')).toBe(0);
    expect(await saldoKode('2-1905')).toBe(31_100_000);
    const lhu = await getLHU(testDb as any, '2025-01-01', '2025-12-31');
    expect(lhu.bebanPajakPenghasilan).toBe(34_100_000);
    expect(lhu.shuSebelumPajak).toBe(300_000_000); // beban pajak tidak mengubah laba sebelum pajak
    const snap = (await listSnapshotPphBadan(2025))[0];
    expect(snap).toMatchObject({ status: 'TERKUNCI', rezim: 'BADAN_31E', versiKebijakan: K.versi, omzetBruto: 1_000_000_000 });
    expect(snap.hasil.pph29).toBe(31_100_000);
  });

  it('kredit PPh 25 diambil dari pembayaran angsuran sah, bukan dari jurnal bebas ke 1-1410', async () => {
    await tahunBadan2025();
    await siapkanPph25([1]);
    const idDimuka = (await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = '1-1410'`))!.id;
    await jurnal('2025-07-01', idDimuka, ACC.kas, 500_000); // jurnal umum, bukan angsuran
    const p = await hitungPphBadanTahun(2025, HARI_INI);
    expect(p.hasil!.kredit.pph25).toBe(1_000_000);
  });

  it('transaksi yang sama tidak menghasilkan pajak dua kali: kunci ganda & jalur manual lama ditolak', async () => {
    await tahunBadan2025();
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    await kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI });
    await expect(kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI })).rejects.toThrow(/sudah dikunci/);
    await expect(catatPphBadan({ tahun: 2025, pphTerutang: 1_000_000, tanggal: '2025-12-31', createdBy: U })).rejects.toThrow(/sudah dicatat/);
    expect(await saldoKode('5-2200')).toBe(33_000_000);
    await expect(
      tambahKoreksiFiskal({ tahunPajak: 2025, jenis: 'NEGATIF', uraian: 'x', nilaiKomersial: 1, nilaiFiskal: 0, alasan: 'x', referensiAturan: 'x', userId: U })
    ).rejects.toThrow(/sudah dikunci/);
  });

  it('perubahan kebijakan TIDAK mengubah snapshot yang sudah dikunci', async () => {
    await tahunBadan2025();
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    await kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI });
    const versiBaru = { ...K, versi: 'UJI-2025.9', berlakuMulaiTahun: 2025, tarifPphBadanPersen: 25 };
    (KEBIJAKAN_PAJAK as any[]).push(versiBaru);
    try {
      expect(kebijakanUntukTahun(2025).versi).toBe('UJI-2025.9');
      const snap = (await listSnapshotPphBadan(2025))[0];
      expect(snap.versiKebijakan).toBe(K.versi);
      expect(snap.hasil.totalPphBadan).toBe(33_000_000);
      expect(await saldoKode('5-2200')).toBe(33_000_000);
    } finally {
      (KEBIJAKAN_PAJAK as any[]).pop();
    }
  });

  it('pembatalan tercatat (reversal) lalu kunci ulang; snapshot lama tetap sebagai jejak audit', async () => {
    await tahunBadan2025();
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    await kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI });
    await expect(batalkanPerhitunganPphBadan({ tahun: 2025, alasan: ' ', userId: U })).rejects.toThrow(/Alasan/);
    await batalkanPerhitunganPphBadan({ tahun: 2025, alasan: 'Koreksi fiskal terlewat', userId: U });
    expect(await saldoKode('2-1905')).toBe(0);
    await tambahKoreksiFiskal({ tahunPajak: 2025, jenis: 'NEGATIF', uraian: 'Penghasilan final', nilaiKomersial: 100_000_000, nilaiFiskal: 0, alasan: 'Objek PPh final', referensiAturan: 'UU PPh Pasal 4 ayat (2)', userId: U });
    expect((await hitungPphBadanTahun(2025, HARI_INI)).status).toBe('REKONSILIASI_BELUM_LENGKAP'); // koreksi baru membatalkan pernyataan lengkap
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    const k2 = await kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI });
    expect(k2.hasil.pkp).toBe(200_000_000);
    const semua = await listSnapshotPphBadan(2025);
    expect(semua.map((s) => s.status).sort()).toEqual(['DIBATALKAN', 'TERKUNCI']);
    expect(await saldoKode('2-1905')).toBe(22_000_000);
  });

  it('periode tertutup tidak dapat diubah: kunci ditolak tanpa snapshot/jurnal', async () => {
    await tahunBadan2025();
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2025'`);
    await expect(kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI })).rejects.toThrow();
    expect(await testDb.getAllAsync(`SELECT id FROM pajak_badan_snapshot`)).toHaveLength(0);
    expect(await saldoKode('5-2200')).toBe(0);
  });

  it('rugi fiskal: PPh 0, dikunci tanpa jurnal', async () => {
    await simpanPengaturanPajak({ skema: 'UMUM', tahunTerdaftar: 2015, updatedBy: U });
    await jurnal('2025-06-30', ACC.kas, ACC.jasa, 100_000_000);
    await jurnal('2025-06-30', ACC.beban, ACC.kas, 150_000_000);
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    const k = await kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI });
    expect(k.hasil.totalPphBadan).toBe(0);
    expect(k.journalId).toBeNull();
  });

  it('kredit PPh 23 terdaftar (sekali per bukti) ikut dikreditkan dan dikosongkan saat dikunci', async () => {
    await tahunBadan2025();
    await catatKreditPajakLain({ tahunPajak: 2025, jenis: 'PPH23', nominal: 2_000_000, nomorBukti: 'BP-23-01', tanggalBukti: '2025-08-01', pemotong: 'PT A', akunLawanId: ACC.jasa, userId: U });
    await expect(
      catatKreditPajakLain({ tahunPajak: 2025, jenis: 'PPH23', nominal: 2_000_000, nomorBukti: 'BP-23-01', tanggalBukti: '2025-08-01', pemotong: 'PT A', akunLawanId: ACC.jasa, userId: U })
    ).rejects.toThrow(/sudah pernah/);
    await nyatakanRekonsiliasiFiskal({ tahun: 2025, lengkap: true, userId: U });
    const p = await hitungPphBadanTahun(2025, HARI_INI);
    expect(p.omzetBruto).toBe(1_002_000_000); // gross-up pendapatan bruto
    expect(p.hasil!.kredit.pph23).toBe(2_000_000);
    await kunciPerhitunganPphBadan({ tahun: 2025, createdBy: U, hariIni: HARI_INI });
    expect(await saldoKode('1-1411')).toBe(0);
  });

  it('dashboard terisi otomatis dari data', async () => {
    await tahunBadan2025();
    await siapkanPph25([1]);
    const d = await getDashboardPajak('2026-01-10');
    expect(d.rezim.rezim).toBe('BADAN_31E');
    expect(d.perhitunganTahunLalu!.hasil!.totalPphBadan).toBe(33_000_000);
    expect(d.pph25JatuhTempo.length).toBeGreaterThan(0);
    expect(d.pph25JatuhTempo.every((m) => m.status !== 'LUNAS')).toBe(true);
  });
});
