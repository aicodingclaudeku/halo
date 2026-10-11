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

import { buatFixtureHistoris, ACC, USER_ID, ANGGOTA_ID, ANGGOTA_2_ID } from './historicalFixture';
import { parseBerkasDataAwal, cocokkanJenisSheet, JUDUL_SHEET, URUTAN_PROSES } from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal, PESAN_JASA_TANPA_CUTOFF } from '@/import/EksekusiImportDataAwal';
import { SHEET_TEMPLATE, BARIS_PETUNJUK, ATURAN_UMUM } from '@/import/TemplateDataAwal';
import { getBasisAnggotaSHU } from '@/services/ShuService';
import { jenisSheetDiizinkanLog } from '@/import/RiwayatImportRepository';
import { catatDataAwalSimpanan } from '@/services/SimpananService';
import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran } from '@/services/PinjamanService';
import {
  listJasaDataAwal,
  hariSebelum,
  kunciJasaDataAwal,
  rekonsiliasiJasaDataAwal,
} from '@/services/PartisipasiDataAwalService';

/**
 * RC-S133.4.3 — sheet "6. Jasa Dibayar" & petunjuk template yang jujur.
 *
 * Import data awal jalur saldo lama tidak mencatat angsuran yang sudah
 * dibayar, sehingga jasa Jan–cut-off hilang dari dasar SHU jasa usaha
 * per anggota. Sheet 6 mengisinya per anggota, tanpa jurnal.
 */
const CUTOFF = '2026-09-29';
const HEADER_ANGGOTA = ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'];
const HEADER_JASA = ['Kode Anggota *', 'Nama Anggota', 'Jasa Pinjaman Dibayar * (tahun ini s.d. cut-off)'];

const sheetJasa = (rows: unknown[][]) => [['keterangan sheet'], [], HEADER_JASA, ...rows];
const opsi = (cut: string | null = CUTOFF) => ({
  createdBy: USER_ID,
  dbRiwayat: testDb as never,
  dbMigrasi: testDb as never,
  tanggalCutOff: cut ?? undefined,
});
const basisPartisipasi = async (mulai = '2026-01-01', selesai = '2026-12-31') =>
  new Map((await getBasisAnggotaSHU(testDb as never, mulai, selesai, true)).map((b) => [b.anggotaId, b.basisPartisipasiUsaha]));

describe('RC-S133.4.3 — parser & template sheet "6. Jasa Dibayar"', () => {
  test('nama sheet dikenali, termasuk nama bebas yang memuat "pinjaman"/"anggota"', () => {
    expect(cocokkanJenisSheet(JUDUL_SHEET.JASA)).toBe('JASA');
    expect(cocokkanJenisSheet('Jasa Pinjaman Anggota')).toBe('JASA');
    expect(cocokkanJenisSheet('3. Pinjaman')).toBe('PINJAMAN');
    expect(cocokkanJenisSheet('1. Anggota')).toBe('ANGGOTA');
    expect(cocokkanJenisSheet('Petunjuk')).toBeNull();
    expect(URUTAN_PROSES[URUTAN_PROSES.length - 1]).toBe('JASA');
  });

  test('berkas berisi sheet 6 saja siap diimpor (data awal sudah pernah diimpor)', () => {
    const r = parseBerkasDataAwal({ JASA: sheetJasa([['A001', 'Anggota A001', 'Rp 1.250.000']]) });
    expect(r.siapDiimpor).toBe(true);
    expect(r.hasil.jasa.baris).toEqual([{ baris: 4, kode: 'A001', nama: 'Anggota A001', jasa: 1_250_000 }]);
  });

  test('validasi baris: wajib, tidak negatif, satu anggota satu baris', () => {
    const r = parseBerkasDataAwal({
      JASA: sheetJasa([
        ['A001', '', 100_000],
        ['A002', '', ''],
        ['A003', '', -5],
        ['a001', '', 200_000],
        ['', '', 1],
      ]),
    });
    expect(r.siapDiimpor).toBe(false);
    const pesan = r.hasil.jasa.galat.map((g) => g.pesan).join(' | ');
    expect(pesan).toMatch(/wajib diisi — tulis 0/);
    expect(pesan).toMatch(/tidak boleh negatif/);
    expect(pesan).toMatch(/sudah dipakai baris 4/);
    expect(pesan).toMatch(/Kode Anggota wajib diisi/);
    expect(r.hasil.jasa.baris.map((b) => b.kode)).toEqual(['A001']);
  });

  test('template memuat sheet 6 & petunjuk menjelaskan DUA mode, tidak lagi menyatakan import selalu lewat kas', () => {
    const s6 = SHEET_TEMPLATE.find((s) => s.jenis === 'JASA')!;
    expect(s6.nama).toBe('6. Jasa Dibayar');
    expect(s6.kolom.filter((k) => k.wajib).map((k) => k.label)).toEqual(['Kode Anggota', 'Jasa Pinjaman Dibayar']);
    const teks = BARIS_PETUNJUK.map((b) => b.join(' ')).join('\n');
    expect(teks).toMatch(/SALDO LAMA KOPERASI/);
    expect(teks).toMatch(/TANPA jurnal kas/);
    expect(teks).toMatch(/TIDAK dicatat satu per satu/);
    expect(teks).toMatch(/Kas\/Bank, pendapatan & beban tahun berjalan/);
    expect(teks).toMatch(/TRANSAKSI BARU/);
    expect(teks).toMatch(/6\. Jasa Dibayar/);
    // kalimat lama yang menyesatkan hanya boleh muncul DI BAWAH bagian "TRANSAKSI BARU"
    const idxB = teks.indexOf('TRANSAKSI BARU');
    expect(teks.indexOf('Simpanan dicatat sebagai penerimaan kas')).toBeGreaterThan(idxB);
    expect(ATURAN_UMUM.some((a) => /tanpa jurnal kas/i.test(a.judul))).toBe(true);
  });
});

describe('RC-S133.4.3 — eksekusi sheet 6 & dasar SHU jasa usaha', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('import lengkap: kode sheet 1 → anggota baru; jasa tersimpan tanpa jurnal & ikut dasar SHU', async () => {
    const jurnalSebelum = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
    const berkas = parseBerkasDataAwal({
      ANGGOTA: [HEADER_ANGGOTA, ['K1', 'Budi Santoso', '2025-01-01'], ['K2', 'Siti Aminah', '2025-01-01']],
      JASA: sheetJasa([
        ['K1', 'Budi', 3_000_000],
        ['K2', 'Siti', 2_010_701],
      ]),
    });
    expect(berkas.siapDiimpor).toBe(true);
    const hasil = await jalankanImportDataAwal(berkas, opsi());
    expect(hasil.perSheet.find((s) => s.jenis === 'JASA')).toMatchObject({ berhasil: 2, gagal: 0 });
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n).toBe(jurnalSebelum);

    const tersimpan = await listJasaDataAwal(testDb as never);
    expect(tersimpan.map((j) => [j.tanggal, j.jasa]).sort()).toEqual([
      ['2026-09-28', 2_010_701],
      ['2026-09-28', 3_000_000],
    ]);
    const idBudi = (await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM anggota WHERE nama_lengkap = 'Budi Santoso'`))!.id;
    expect((await basisPartisipasi()).get(idBudi)).toBe(3_000_000);
    expect(hasil.jasaDataAwal).toMatchObject({ jumlahAnggota: 2, totalJasa: 5_010_701, saldoAwalPendapatanJasa: null });
    expect(hasil.berhasil.filter((b) => b.jenis === 'JASA').map((b) => b.keterangan).join(' ')).toMatch(/Budi Santoso · jasa Rp3\.000\.000/);
  });

  test('sheet 6 saja dengan NOMOR anggota yang sudah ada; kode tak dikenal gagal dengan pesan jelas', async () => {
    const hasil = await jalankanImportDataAwal(
      parseBerkasDataAwal({ JASA: sheetJasa([['a001', '', 1_000_000], ['A002', '', 500_000], ['AGT0099', 'Tidak Ada', 75_000]]) }),
      opsi()
    );
    expect(hasil.perSheet.find((s) => s.jenis === 'JASA')).toMatchObject({ berhasil: 2, gagal: 1 });
    expect(hasil.gagal[0].pesan).toMatch(/Anggota "AGT0099" tidak ditemukan/);
    const basis = await basisPartisipasi();
    expect(basis.get(ANGGOTA_ID)).toBe(1_000_000);
    expect(basis.get(ANGGOTA_2_ID)).toBe(500_000);
  });

  test('import ulang MENGGANTI nilai (tidak menambah); 0 menghapus', async () => {
    await jalankanImportDataAwal(parseBerkasDataAwal({ JASA: sheetJasa([['A001', '', 1_000_000]]) }), opsi());
    await jalankanImportDataAwal(parseBerkasDataAwal({ JASA: sheetJasa([['A001', '', 1_200_000]]) }), opsi());
    expect((await basisPartisipasi()).get(ANGGOTA_ID)).toBe(1_200_000);
    await jalankanImportDataAwal(parseBerkasDataAwal({ JASA: sheetJasa([['A001', '', 0]]) }), opsi());
    expect((await basisPartisipasi()).get(ANGGOTA_ID)).toBe(0);
    expect(await testDb.getFirstAsync(`SELECT value FROM app_config WHERE key = ?`, kunciJasaDataAwal(ANGGOTA_ID))).toBeNull();
  });

  test('mode "transaksi baru" (tanpa cut-off): sheet 6 ditolak — jasa sudah tercatat dari angsuran', async () => {
    const hasil = await jalankanImportDataAwal(parseBerkasDataAwal({ JASA: sheetJasa([['A001', '', 1_000_000]]) }), opsi(null));
    expect(hasil.perSheet.find((s) => s.jenis === 'JASA')).toMatchObject({ berhasil: 0, gagal: 1 });
    expect(hasil.gagal[0].pesan).toBe(PESAN_JASA_TANPA_CUTOFF);
    expect(await listJasaDataAwal(testDb as never)).toEqual([]);
  });

  test('jasa ikut tahun buku sebelum cut-off: cut-off 1 Jan 2027 → masuk SHU 2026, bukan 2027', async () => {
    expect(hariSebelum('2027-01-01')).toBe('2026-12-31');
    expect(hariSebelum('2026-03-01')).toBe('2026-02-28');
    await jalankanImportDataAwal(parseBerkasDataAwal({ JASA: sheetJasa([['A001', '', 900_000]]) }), opsi('2027-01-01'));
    expect((await basisPartisipasi('2026-01-01', '2026-12-31')).get(ANGGOTA_ID)).toBe(900_000);
    expect((await basisPartisipasi('2027-01-01', '2027-12-31')).get(ANGGOTA_ID)).toBe(0);
  });

  test('dijumlahkan dengan jasa dari angsuran yang dibayar SETELAH cut-off (jalur pembayaran normal)', async () => {
    await jalankanImportDataAwal(parseBerkasDataAwal({ JASA: sheetJasa([['A001', '', 700_000]]) }), opsi());
    await catatDataAwalSimpanan({ anggotaId: ANGGOTA_ID, tanggal: '2026-10-01', pokok: 100_000, wajib: 50_000, sukarela: 0, sumberDana: 'KAS', createdBy: USER_ID } as Parameters<typeof catatDataAwalSimpanan>[0]);
    const { id: pinjamanId } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-10-01',
      jumlahPinjaman: 1_000_000,
      tenor: 10,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1.5,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: USER_ID,
    } as Parameters<typeof ajukanPinjaman>[0]);
    await cairkanPinjaman({ pinjamanId, sumberDana: 'KAS', approvedBy: USER_ID, tanggalPencairan: '2026-10-01' });
    const j1 = (await getJadwalAngsuran(pinjamanId)).sort((a, b) => a.nomorAngsuran - b.nomorAngsuran)[0];
    await bayarAngsuran({ pinjamanId, jadwalId: j1.id, tanggal: j1.tanggalJatuhTempo, nominal: j1.total, sumberDana: 'KAS', createdBy: USER_ID });
    expect(j1.jasa).toBe(15_000);
    expect((await basisPartisipasi()).get(ANGGOTA_ID)).toBe(715_000);
  });

  test('rekonsiliasi ke saldo awal Pendapatan Jasa Pinjaman', async () => {
    await jalankanImportDataAwal(parseBerkasDataAwal({ JASA: sheetJasa([['A001', '', 3_000_000], ['A002', '', 2_000_000]]) }), opsi());
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at) VALUES ('sa-jasa', ?, '2026-09-29', 5010701, NULL, ?, ?, ?)`,
      ACC.pendapatanJasa, USER_ID, now, now
    );
    const r = await rekonsiliasiJasaDataAwal(testDb as never);
    expect(r).toMatchObject({ jumlahAnggota: 2, totalJasa: 5_000_000, saldoAwalPendapatanJasa: 5_010_701, selisih: 10_701 });
    expect(r.pesan).toMatch(/selisih Rp10\.701/);
  });
  test('riwayat import tetap tercatat walau sheet 6 belum diizinkan CHECK kolom log (dulu seluruh riwayat hilang)', async () => {
    expect([...(await jenisSheetDiizinkanLog(testDb as never))].sort()).toEqual(['ANGGOTA', 'BERJANGKA', 'PINJAMAN', 'SIMPANAN']);
    await jalankanImportDataAwal(
      parseBerkasDataAwal({
        ANGGOTA: [HEADER_ANGGOTA, ['K1', 'Budi Santoso', '2025-01-01']],
        JASA: sheetJasa([['K1', '', 100_000]]),
      }),
      opsi()
    );
    const r = await testDb.getAllAsync<{ ringkasan_json: string; total_berhasil: number }>(`SELECT ringkasan_json, total_berhasil FROM import_data_awal_riwayat`);
    expect(r).toHaveLength(1);
    expect(r[0].total_berhasil).toBe(2);
    expect(JSON.parse(r[0].ringkasan_json).find((x: { jenis: string }) => x.jenis === 'JASA')).toMatchObject({ berhasil: 1 });
    const log = await testDb.getAllAsync<{ jenis_sheet: string }>(`SELECT jenis_sheet FROM import_data_awal_log`);
    expect(log.map((l) => l.jenis_sheet)).toEqual(['ANGGOTA']);
  });
});
