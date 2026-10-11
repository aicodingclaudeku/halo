import { TestDb } from './testDb';

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

import { buatFixtureHistoris, ACC, USER_ID, ANGGOTA_ID, saldoGl } from './historicalFixture';
import {
  normalkanSelPersen,
  parseBilanganHitungan,
  parseBerkasDataAwal,
  parseRupiah,
  parseSheetAset,
  parseSheetBerjangka,
  parseSheetPinjaman,
} from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import { catatDataAwalSimpanan } from '@/services/SimpananService';
import { createJournal, reverseJournal } from '@/accounting/AccountingEngine';
import { getArusKas, getLabaRugi, getPerubahanEkuitas, getPosisiKeuangan } from '@/reports/FinancialReports';
import { buildPerubahanEkuitasExport } from '@/export/ReportTableBuilders';
import { tampilanEkuitasJuklat } from '@/export/JuklatPdf';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * RC-S133.6 — TINDAK LANJUT AUDIT REKONSILIASI (KOPKU-AUDIT-RESULTS).
 *
 * Mengunci perbaikan atas temuan audit yang sebelumnya hanya dibuktikan
 * lewat skenario audit (bukan tes unit):
 *   F-1/F-1b  impor Sumber Dana BANK
 *   F-2       Arus Kas: porsi sukarela jurnal SIMPANAN_DATA_AWAL (+ pembaliknya)
 *   F-3       label Posisi Keuangan sebelum tanggal distribusi SHU
 *   F-4       Perubahan Ekuitas tahun berikutnya menyambung
 *   B-2       sel Excel berformat persen
 *   B-3       tenor/angsuran pecahan tidak lagi dibulatkan diam-diam
 */

const now = () => new Date().toISOString();

async function tambahAkun(db: TestDb, id: string, kode: string, nama: string, kategori: string, normal: 'DEBIT' | 'KREDIT') {
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, normal, now(), now()
  );
}

/** Periode tahun berjalan (jurnal pembalik bertanggal hari ini). */
async function pastikanPeriodeHariIni(db: TestDb) {
  const tahun = Number(getTanggalLokalHariIni().slice(0, 4));
  const ada = await db.getFirstAsync<{ id: string }>(`SELECT id FROM accounting_period WHERE tahun_buku = ?`, tahun);
  if (!ada) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${tahun}`, tahun, `${tahun}-01-01`, `${tahun}-12-31`
    );
  }
}

// ---------------------------------------------------------------------------
// F-1 / F-1b — impor "Transaksi baru" dengan Sumber Dana BANK
// ---------------------------------------------------------------------------
describe('AUDIT F-1 — impor Sumber Dana BANK', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  const berkas = (sumberDana: 'KAS' | 'BANK') =>
    parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Budi', '2026-01-01']],
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'],
        ['K1', '2026-02-01', 100_000, 50_000, 25_000, sumberDana],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'],
        ['K1', '2026-03-01', 1_200_000, 12, 'BULAN', 'FLAT', 1, sumberDana],
      ],
    });
  const opsi = () => ({ createdBy: USER_ID, dbRiwayat: testDb as never });

  test('tepat satu rekening bank aktif → baris BANK berhasil dan memakai rekening itu', async () => {
    const bankSebelum = await saldoGl(testDb, ACC.bank);
    const h = await jalankanImportDataAwal(berkas('BANK'), opsi());
    expect(h.totalGagal).toBe(0);
    expect(h.perSheet.find((s) => s.jenis === 'SIMPANAN')).toMatchObject({ berhasil: 1, gagal: 0 });
    expect(h.perSheet.find((s) => s.jenis === 'PINJAMAN')).toMatchObject({ berhasil: 1, gagal: 0 });
    // +175.000 setoran simpanan, −1.200.000 pencairan — semuanya lewat akun bank.
    expect((await saldoGl(testDb, ACC.bank)) - bankSebelum).toBe(175_000 - 1_200_000);
    const trx = await testDb.getFirstAsync<{ bank_account_id: string | null }>(
      `SELECT bank_account_id FROM simpanan_transaksi WHERE jenis = 'POKOK' ORDER BY created_at DESC LIMIT 1`
    );
    expect(trx?.bank_account_id).toBe('bank-1');
  });

  test('dua rekening bank aktif → galat jelas, dan TIDAK ada pinjaman DIAJUKAN yang tertinggal (F-1b)', async () => {
    await tambahAkun(testDb, 'acc-bank-2', '1-1101', 'Bank Mandiri', 'ASET', 'DEBIT');
    await testDb.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at) VALUES ('bank-2','Bank Mandiri','999','Koperasi Uji','acc-bank-2',0,1,?)`,
      now()
    );
    const h = await jalankanImportDataAwal(berkas('BANK'), opsi());
    expect(h.perSheet.find((s) => s.jenis === 'PINJAMAN')).toMatchObject({ berhasil: 0, gagal: 1 });
    expect(h.gagal.map((g) => g.pesan).join(' ')).toMatch(/tepat satu rekening bank aktif/);
    const pinjaman = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id WHERE a.nama_lengkap = 'Budi'`
    );
    expect(pinjaman?.n).toBe(0);
  });

  test('pencairan gagal di tengah (saldo bank tidak cukup) → pinjaman DIBATALKAN, bukan DIAJUKAN yatim', async () => {
    const berkasBesar = parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Budi', '2026-01-01']],
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'],
        ['K1', '2026-02-01', 100_000, 50_000, 0, 'KAS'],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'],
        ['K1', '2026-03-01', 900_000_000, 12, 'BULAN', 'FLAT', 1, 'BANK'],
      ],
    });
    const h = await jalankanImportDataAwal(berkasBesar, opsi());
    expect(h.perSheet.find((s) => s.jenis === 'PINJAMAN')).toMatchObject({ berhasil: 0, gagal: 1 });
    const rows = await testDb.getAllAsync<{ status: string }>(
      `SELECT p.status FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id WHERE a.nama_lengkap = 'Budi'`
    );
    expect(rows.map((r) => r.status)).toEqual(['DITOLAK']);
    expect(h.gagal[0].pesan).toMatch(/tidak cukup/);
    // Tidak ada jurnal pencairan.
    const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'PENCAIRAN_PINJAMAN'`);
    expect(j?.n).toBe(0);
  });

  test('tanpa rekening bank aktif → galat menyarankan KAS; jalur KAS tetap berhasil', async () => {
    await testDb.runAsync(`UPDATE bank_account SET aktif = 0`);
    const h = await jalankanImportDataAwal(berkas('BANK'), opsi());
    expect(h.gagal.map((g) => g.pesan).join(' ')).toMatch(/belum ada rekening bank aktif/);

    testDb = await buatFixtureHistoris();
    const hKas = await jalankanImportDataAwal(berkas('KAS'), { createdBy: USER_ID, dbRiwayat: testDb as never });
    expect(hKas.totalGagal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-2 — Arus Kas: porsi sukarela jurnal SIMPANAN_DATA_AWAL
// ---------------------------------------------------------------------------
describe('AUDIT F-2 — Arus Kas setor simpanan gabungan', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await pastikanPeriodeHariIni(testDb);
  });

  test('pokok+wajib = PENDANAAN, sukarela = OPERASI (sama dengan setor sukarela biasa)', async () => {
    await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID, tanggal: '2026-03-01', pokok: 100_000, wajib: 50_000, sukarela: 200_000, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const ak = await getArusKas(testDb as never, '2026-03-01', '2026-03-31');
    expect(ak.operasi).toBe(200_000);
    expect(ak.pendanaan).toBe(150_000);
    expect(ak.terekonsiliasi).toBe(true);
    expect(ak.rincian.find((r) => r.aktivitas === 'OPERASI')?.sumberTransaksi).toBe('SIMPANAN_SUKARELA');
  });

  test('jurnal pembalik dipecah dengan porsi jurnal asal → per aktivitas saling meniadakan', async () => {
    const r = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID, tanggal: '2026-03-01', pokok: 100_000, wajib: 50_000, sukarela: 200_000, sumberDana: 'KAS', createdBy: USER_ID,
    });
    await reverseJournal(testDb as never, r.journalId, USER_ID, 'salah input');
    const ak = await getArusKas(testDb as never, '2026-01-02', '2099-12-31');
    expect(ak.operasi).toBe(0);
    expect(ak.pendanaan).toBe(0);
    expect(ak.terekonsiliasi).toBe(true);
  });

  test('setoran tanpa sukarela tetap seluruhnya PENDANAAN (perilaku lama)', async () => {
    await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID, tanggal: '2026-03-01', pokok: 100_000, wajib: 50_000, sukarela: 0, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const ak = await getArusKas(testDb as never, '2026-03-01', '2026-03-31');
    expect(ak.operasi).toBe(0);
    expect(ak.pendanaan).toBe(150_000);
  });
});

// ---------------------------------------------------------------------------
// F-3 & F-4 — label Posisi Keuangan dan kesinambungan Perubahan Ekuitas
// ---------------------------------------------------------------------------
describe('AUDIT F-3/F-4 — SHU antar-tahun', () => {
  const ACC_SHU = 'acc-shu-berjalan';
  const ACC_CADANGAN = 'acc-cadangan';

  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await tambahAkun(testDb, ACC_SHU, '3-4000', 'SHU Tahun Berjalan', 'EKUITAS', 'KREDIT');
    await tambahAkun(testDb, ACC_CADANGAN, '3-2000', 'Cadangan', 'EKUITAS', 'KREDIT');
    // Tahun buku 2026: pendapatan 10 jt, beban 2 jt → SHU 8 jt.
    await createJournal(testDb as never, {
      tanggal: '2026-06-01', sumberTransaksi: 'PENDAPATAN_LAIN', deskripsi: 'Pendapatan 2026', createdBy: USER_ID,
      lines: [{ accountId: ACC.kas, debit: 10_000_000, kredit: 0 }, { accountId: ACC.pendapatanLain, debit: 0, kredit: 10_000_000 }],
    });
    await createJournal(testDb as never, {
      tanggal: '2026-07-01', sumberTransaksi: 'BEBAN_LAIN', deskripsi: 'Beban 2026', createdBy: USER_ID,
      lines: [{ accountId: ACC.bebanLain, debit: 2_000_000, kredit: 0 }, { accountId: ACC.kas, debit: 0, kredit: 2_000_000 }],
    });
    // Tahun buku 2027: pendapatan 3 jt.
    await createJournal(testDb as never, {
      tanggal: '2027-02-01', sumberTransaksi: 'PENDAPATAN_LAIN', deskripsi: 'Pendapatan 2027', createdBy: USER_ID,
      lines: [{ accountId: ACC.kas, debit: 3_000_000, kredit: 0 }, { accountId: ACC.pendapatanLain, debit: 0, kredit: 3_000_000 }],
    });
  });

  async function bagikanShu2026(tanggal: string) {
    await testDb.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
         persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
         total_shu, status, created_at, updated_at)
       VALUES ('shu-2026',2026,25,35,40,0,0,0,0,0,0,8000000,'DIBAGIKAN',?,?)`,
      now(), now()
    );
    await createJournal(testDb as never, {
      tanggal, sumberTransaksi: 'SHU_DISTRIBUSI', sumberId: 'shu-2026', deskripsi: 'Distribusi SHU tahun buku 2026', createdBy: USER_ID,
      lines: [
        { accountId: ACC_SHU, debit: 8_000_000, kredit: 0 },
        { accountId: ACC_CADANGAN, debit: 0, kredit: 2_000_000 },
        { accountId: ACC.simpananSukarela, debit: 0, kredit: 6_000_000 },
      ],
    });
  }

  test('F-4: saldo awal Perubahan Ekuitas 2027 = total ekuitas Posisi Keuangan 31-12-2026 (sebelum SHU dibagikan)', async () => {
    const p26 = await getPosisiKeuangan(testDb as never, '2026-12-31');
    const e27 = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-12-31');
    const p27 = await getPosisiKeuangan(testDb as never, '2027-12-31');
    const lr27 = await getLabaRugi(testDb as never, '2027-01-01', '2027-12-31');

    expect(e27.totalSaldoAwal).toBe(p26.totalEkuitas);
    expect(e27.saldoAwalHasilUsaha).toBe(8_000_000);
    expect(e27.hasilUsahaPeriodeBerjalan).toBe(lr27.hasilUsaha);
    expect(e27.hasilUsahaPeriodeBerjalan).toBe(3_000_000);
    expect(e27.shuDibagikanPeriode).toBe(0);
    expect(e27.totalSaldoAkhir).toBe(p27.totalEkuitas); // tidak berubah dari perilaku lama
  });

  test('F-4: setelah SHU 2026 dibagikan pada 2027 — awal tetap menyambung, distribusi tampil terpisah', async () => {
    await bagikanShu2026('2027-03-15');
    const p26 = await getPosisiKeuangan(testDb as never, '2026-12-31');
    const e26 = await getPerubahanEkuitas(testDb as never, '2026-01-01', '2026-12-31');
    const e27 = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-12-31');
    const p27 = await getPosisiKeuangan(testDb as never, '2027-12-31');

    expect(e26.totalSaldoAkhir).toBe(p26.totalEkuitas);
    expect(e27.totalSaldoAwal).toBe(e26.totalSaldoAkhir); // kesinambungan antar-tahun
    expect(e27.shuDibagikanPeriode).toBe(8_000_000);
    expect(e27.hasilUsahaPeriodeBerjalan).toBe(3_000_000);
    expect(e27.hasilUsahaPeriode).toBe(3_000_000); // saldo akhir baris SHU
    expect(e27.totalSaldoAkhir).toBe(p27.totalEkuitas);
    // Persamaan rekonsiliasi lengkap.
    const mutasiAkun = e27.rows.reduce((t, r) => t + r.mutasi, 0);
    expect(e27.totalSaldoAwal + mutasiAkun + (e27.hasilUsahaPeriodeBerjalan ?? 0) - (e27.shuDibagikanPeriode ?? 0)).toBe(e27.totalSaldoAkhir);
    expect(e27.rows.find((r) => r.kode === '3-2000')?.mutasi).toBe(2_000_000);
  });

  test('F-4: tahun pertama tidak berubah (saldo awal SHU 0)', async () => {
    const e26 = await getPerubahanEkuitas(testDb as never, '2026-01-02', '2026-12-31');
    expect(e26.saldoAwalHasilUsaha).toBe(0);
    expect(e26.hasilUsahaPeriodeBerjalan).toBe(8_000_000);
    expect(e26.hasilUsahaPeriode).toBe(8_000_000);
  });

  test('F-4: ekspor tabel & PDF Juklat memakai saldo awal baris SHU', async () => {
    await bagikanShu2026('2027-03-15');
    const e27 = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-12-31');
    const ex = buildPerubahanEkuitasExport({ namaKoperasi: 'Uji', standarAkuntansi: 'SAK EP' } as never, e27);
    const baris = ex.baris.find((b) => b[0] === e27.hasilUsahaPeriodeLabel);
    expect(baris).toEqual([e27.hasilUsahaPeriodeLabel, 8_000_000, 3_000_000 - 8_000_000, 3_000_000]);
    expect(ex.ringkasan?.find((r) => r.label === 'SHU dibagikan dalam periode')).toBeDefined();
    const pdf = tampilanEkuitasJuklat([e27]);
    const barisPdf = pdf.baris.find((b) => b.label === e27.hasilUsahaPeriodeLabel);
    expect(barisPdf?.nilai).toEqual([8_000_000, -5_000_000, 3_000_000]);
    expect(pdf.keterangan?.[0].judul).toMatch(/Rincian mutasi SHU/);
  });

  test('F-3: Posisi per tanggal SEBELUM jurnal distribusi → label "dicatat sesudah tanggal laporan", angka tetap', async () => {
    await bagikanShu2026('2027-03-15');
    const p = await getPosisiKeuangan(testDb as never, '2026-12-31');
    expect(p.shuStatus).toBe('DIBAGIKAN');
    expect(p.labaBerjalan).toBe(8_000_000);
    expect(p.labaBerjalanLabel).toMatch(/sesudah tanggal laporan/);
    expect(p.labaBerjalanLabel).not.toMatch(/perlu ditelusuri/);
    expect(p.labaBerjalanLabel).not.toContain('belum dibagikan');
    expect(p.isBalanced).toBe(true);
  });

  test('F-3: distribusi SUDAH tercatat lalu ada pendapatan baru di tahun yang sama → label "perlu ditelusuri" tetap', async () => {
    await bagikanShu2026('2026-12-20');
    await createJournal(testDb as never, {
      tanggal: '2026-12-25', sumberTransaksi: 'PENDAPATAN_LAIN', deskripsi: 'Pendapatan terlambat', createdBy: USER_ID,
      lines: [{ accountId: ACC.kas, debit: 1_000_000, kredit: 0 }, { accountId: ACC.pendapatanLain, debit: 0, kredit: 1_000_000 }],
    });
    const p = await getPosisiKeuangan(testDb as never, '2026-12-31');
    expect(p.labaBerjalan).toBe(1_000_000);
    expect(p.labaBerjalanLabel).toMatch(/perlu ditelusuri/);
  });
});

// ---------------------------------------------------------------------------
// B-2 — sel berformat persen
// ---------------------------------------------------------------------------
describe('AUDIT B-2 — sel Excel berformat persen', () => {
  test('angka bertampilan persen diganti teks persennya; sel lain & objek asal tidak berubah', () => {
    const ws = {
      '!ref': 'A1:D2',
      A2: { t: 'n', v: 0.015, w: '1.50%' },
      B2: { t: 'n', v: 0.18, z: '0%' },
      C2: { t: 'n', v: 1_500_000, w: '1,500,000' },
      D2: { t: 's', v: '1,5%' },
    };
    const hasil = normalkanSelPersen(ws) as Record<string, { t: string; v: unknown }>;
    expect(hasil.A2).toMatchObject({ t: 's', v: '1.5%' });
    expect(hasil.B2).toMatchObject({ t: 's', v: '18%' });
    expect(hasil.C2).toBe(ws.C2);
    expect(hasil.D2).toBe(ws.D2);
    expect(ws.A2.v).toBe(0.015); // tidak memutasi sheet asal
    const tanpaPersen = { '!ref': 'A1', A1: { t: 'n', v: 5 } };
    expect(normalkanSelPersen(tanpaPersen)).toBe(tanpaPersen);
  });

  test('teks hasil normalisasi dibaca parser sebagai 1,5 (bukan 0,015)', () => {
    const s = parseSheetPinjaman([
      ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'],
      ['K1', '2026-03-01', 1_200_000, 12, 'BULAN', 'FLAT', '1.5%', 'KAS'],
    ]);
    expect(s.galat).toEqual([]);
    expect(s.baris[0].persentaseJasa).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// B-3 — kolom hitungan pecahan
// ---------------------------------------------------------------------------
describe('AUDIT B-3 — tenor/angsuran pecahan ditolak, bukan dibulatkan', () => {
  const headerPinjaman = ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Angsuran Sudah Dibayar'];
  const pinjaman = (tenor: unknown, dibayar: unknown = null) =>
    parseSheetPinjaman([headerPinjaman, ['K1', '2026-03-01', 1_200_000, tenor, 'BULAN', 'FLAT', 1, 'KAS', dibayar]]);

  test('parseRupiah tidak berubah; parseBilanganHitungan ketat untuk kolom hitungan', () => {
    expect(parseRupiah('1.500,50')).toBe(1501);
    expect(parseRupiah(2.5)).toBe(3);
    expect(parseBilanganHitungan(12)).toBe(12);
    expect(parseBilanganHitungan('12')).toBe(12);
    expect(parseBilanganHitungan('12,5')).toBe(12.5); // dulu terbaca 125 lewat parseRupiah
    expect(parseBilanganHitungan('12.5')).toBe(12.5);
    expect(parseBilanganHitungan(2.5)).toBe(2.5);
    expect(parseBilanganHitungan('1.000')).toBeNaN(); // ambigu untuk bilangan hitungan → ditolak
    expect(parseBilanganHitungan('12 bulan')).toBeNaN();
    expect(parseBilanganHitungan('')).toBeNull();
    expect(parseBilanganHitungan(null)).toBeNull();
  });

  test('Tenor "12,5" / 2.5 ditolak; 12 diterima', () => {
    expect(pinjaman('12,5').galat[0]?.pesan).toMatch(/Tenor harus bilangan bulat/);
    expect(pinjaman('1.000').galat[0]?.pesan).toMatch(/Tenor harus bilangan bulat/);
    expect(pinjaman('12').baris[0]?.tenor).toBe(12);
    expect(pinjaman(2.5).galat[0]?.pesan).toMatch(/Tenor harus bilangan bulat/);
    expect(pinjaman(12).galat).toEqual([]);
    expect(pinjaman(12).baris[0].tenor).toBe(12);
  });

  test('Angsuran Sudah Dibayar pecahan ditolak', () => {
    expect(pinjaman(12, 1.5).galat[0]?.pesan).toMatch(/Angsuran Sudah Dibayar/);
    expect(pinjaman(12, 3).galat).toEqual([]);
  });

  test('Tenor Bulan berjangka 3,4 ditolak; Masa Manfaat aset 12,5 ditolak', () => {
    const b = parseSheetBerjangka([
      ['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan', 'Bunga Persen Per Tahun', 'Sumber Dana'],
      ['K1', '2026-03-01', 1_000_000, 3.4, 5, 'KAS'],
      ['K1', '2026-03-01', 1_000_000, 3, 5, 'KAS'],
    ]);
    expect(b.galat).toHaveLength(1);
    expect(b.galat[0].pesan).toMatch(/Tenor Bulan/);
    expect(b.baris).toHaveLength(1);

    const a = parseSheetAset([
      ['Nomor Aset', 'Nama Aset', 'Tanggal Perolehan', 'Nilai Perolehan', 'Masa Manfaat Bulan'],
      ['AT-1', 'Laptop', '2026-01-01', 12_000_000, 12.5],
    ]);
    expect(a.galat[0]?.pesan).toMatch(/Masa Manfaat Bulan harus bilangan bulat/);
  });
});
