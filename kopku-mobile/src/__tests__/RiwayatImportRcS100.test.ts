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

import { buatFixtureHistoris, USER_ID } from './historicalFixture';
import { parseBerkasDataAwal } from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal, HasilImportDataAwal } from '@/import/EksekusiImportDataAwal';
import {
  catatRiwayatImport,
  daftarRiwayatImport,
  logRiwayatImport,
  jumlahRiwayatImport,
} from '@/import/RiwayatImportRepository';
import {
  LABEL_FILTER_LOG,
  LABEL_STATUS_RIWAYAT,
  KETERANGAN_STATUS_RIWAYAT,
  saringLogRiwayat,
  statusDariHasil,
  turunkanStatusRiwayat,
  BarisLogRiwayat,
} from '@/import/RiwayatImportPlan';

/**
 * RC-S100 — RIWAYAT HASIL IMPORT DATA AWAL.
 *
 * Permintaan pengguna: "riwayat hasil import data awal menampilkan log
 * berhasil dan error". Sebelum ini hasil import hanya tampil sesaat di
 * layar; begitu layar ditinggalkan, daftar baris yang gagal beserta
 * alasannya HILANG — padahal itulah yang dibutuhkan untuk memperbaiki
 * berkas Excel-nya.
 *
 * Yang dibuktikan di sini: riwayat BENAR-BENAR tersimpan saat import
 * berjalan (bukan hanya bisa disimpan kalau dipanggil), log berhasil DAN
 * gagal keduanya tercatat lengkap dengan nomor baris Excel, dan status
 * "berhasil sebagian" tidak pernah tertukar dengan "gagal".
 */

function sheetAnggota(baris: (string | number)[][]): (string | number)[][] {
  return [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ...baris];
}

const opsi = () => ({ createdBy: USER_ID, dbRiwayat: testDb as never });

// ============================================================
// A. ATURAN PENYAJIAN (modul murni)
// ============================================================

describe('RC-S100 §A — status riwayat diturunkan dari angka, bukan ditebak', () => {
  test('seluruh baris masuk -> BERHASIL', () => {
    expect(turunkanStatusRiwayat(10, 0)).toBe('BERHASIL');
  });

  test('sebagian masuk & sebagian gagal -> SEBAGIAN, bukan GAGAL', () => {
    // Ini pembedaan yang paling penting: kalau disebut "gagal" begitu
    // saja, pengguna bisa mengimpor ulang berkas yang sama dan
    // menggandakan baris yang SUDAH masuk.
    expect(turunkanStatusRiwayat(7, 3)).toBe('SEBAGIAN');
    expect(turunkanStatusRiwayat(7, 3)).not.toBe('GAGAL');
  });

  test('tidak ada yang masuk -> GAGAL', () => {
    expect(turunkanStatusRiwayat(0, 5)).toBe('GAGAL');
  });

  test('berkas tanpa satu baris pun -> GAGAL, bukan BERHASIL', () => {
    // Tidak ada yang masuk; menyebutnya berhasil menyesatkan.
    expect(turunkanStatusRiwayat(0, 0)).toBe('GAGAL');
  });

  test('keterangan status SEBAGIAN memperingatkan bahaya import ulang', () => {
    expect(KETERANGAN_STATUS_RIWAYAT.SEBAGIAN).toMatch(/menggandakan/i);
    for (const s of ['BERHASIL', 'SEBAGIAN', 'GAGAL'] as const) {
      expect(LABEL_STATUS_RIWAYAT[s]).toBeTruthy();
      expect(KETERANGAN_STATUS_RIWAYAT[s]).toBeTruthy();
    }
  });

  test('penyaringan log: SEMUA/BERHASIL/GAGAL, urutan asli dipertahankan', () => {
    const log: BarisLogRiwayat[] = [
      { id: '1', jenisSheet: 'ANGGOTA', baris: 2, keterangan: 'A1', status: 'BERHASIL', pesan: null },
      { id: '2', jenisSheet: 'ANGGOTA', baris: 3, keterangan: 'A2', status: 'GAGAL', pesan: 'NIK ganda' },
      { id: '3', jenisSheet: 'SIMPANAN', baris: 2, keterangan: 'A1', status: 'BERHASIL', pesan: null },
    ];
    expect(saringLogRiwayat(log, 'SEMUA')).toHaveLength(3);
    expect(saringLogRiwayat(log, 'GAGAL').map((b) => b.id)).toEqual(['2']);
    // Urutan proses dipertahankan — pengguna mencocokkannya dengan
    // nomor baris di berkas Excel.
    expect(saringLogRiwayat(log, 'BERHASIL').map((b) => b.id)).toEqual(['1', '3']);
    expect(Object.keys(LABEL_FILTER_LOG).sort()).toEqual(['BERHASIL', 'GAGAL', 'SEMUA']);
  });
});

// ============================================================
// B. TERCATAT SUNGGUHAN SAAT IMPORT BERJALAN
// ============================================================

describe('RC-S100 §B — riwayat tersimpan sebagai bagian dari import', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('import berhasil: satu riwayat tersimpan beserta log per baris', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: sheetAnggota([
        ['A1', 'Budi Santoso', '2026-01-02'],
        ['A2', 'Siti Aminah', '2026-01-03'],
      ]),
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
        ['A1', '2026-01-05', '100000', '50000', '0'],
      ],
    });
    expect(ringkasan.siapDiimpor).toBe(true);

    const hasil = await jalankanImportDataAwal(ringkasan, { ...opsi(), namaBerkas: 'data-awal.xlsx' });
    expect(hasil.totalGagal).toBe(0);

    // Riwayat ADA tanpa perlu dipanggil terpisah oleh layar — inilah yang
    // membuatnya tetap tersimpan walau layar langsung ditutup.
    expect(await jumlahRiwayatImport(testDb as never)).toBe(1);

    const daftar = await daftarRiwayatImport(testDb as never);
    expect(daftar).toHaveLength(1);
    expect(daftar[0].status).toBe('BERHASIL');
    expect(daftar[0].namaBerkas).toBe('data-awal.xlsx');
    expect(daftar[0].dijalankanOleh).toBe(USER_ID);
    expect(daftar[0].totalBerhasil).toBe(3); // 2 anggota + 1 simpanan
    expect(daftar[0].totalGagal).toBe(0);
    expect(daftar[0].totalBaris).toBe(3);
    // Rincian per sheet ikut tersimpan.
    const anggotaSheet = daftar[0].perSheet.find((s) => s.jenis === 'ANGGOTA');
    expect(anggotaSheet?.berhasil).toBe(2);

    const log = await logRiwayatImport(testDb as never, daftar[0].id);
    expect(log).toHaveLength(3);
    expect(log.every((b) => b.status === 'BERHASIL')).toBe(true);
    // "Log berhasil" memang berisi identitas baris, bukan hanya angka.
    expect(log[0].keterangan).toContain('Budi Santoso');
    expect(log[0].baris).toBe(2); // baris Excel, bukan indeks array
  });

  test('log GAGAL menyimpan nomor baris Excel dan alasannya, agar berkas bisa diperbaiki', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: sheetAnggota([
        ['A1', 'Budi Santoso', '2026-01-02'],
        ['A2', 'Siti Aminah', '2026-01-03'],
      ]),
      // Simpanan Pokok hanya boleh dicatat SEKALI per anggota
      // (`pastikanBelumAdaSimpananPokok`), jadi baris ketiga pasti gagal
      // SAAT EKSEKUSI. Sengaja BUKAN kegagalan yang bisa ditangkap
      // pratinjau (mis. kode anggota tak dikenal): kegagalan semacam itu
      // sudah ditolak `parseBerkasDataAwal` sebelum eksekusi dimulai,
      // sehingga tidak akan pernah sampai ke log riwayat.
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
        ['A1', '2026-01-05', '100000', '0', '0'],
        ['A1', '2026-01-05', '100000', '0', '0'],
      ],
    });
    expect(ringkasan.siapDiimpor).toBe(true);

    const hasil = await jalankanImportDataAwal(ringkasan, opsi());
    expect(hasil.totalGagal).toBe(1);
    expect(hasil.totalBerhasil).toBe(3);

    const daftar = await daftarRiwayatImport(testDb as never);
    // Sebagian masuk, sebagian gagal.
    expect(daftar[0].status).toBe('SEBAGIAN');
    expect(statusDariHasil(hasil)).toBe('SEBAGIAN');

    const log = await logRiwayatImport(testDb as never, daftar[0].id);
    const gagal = log.filter((b) => b.status === 'GAGAL');
    expect(gagal).toHaveLength(1);
    expect(gagal[0].jenisSheet).toBe('SIMPANAN');
    expect(gagal[0].baris).toBe(3); // baris ke-3 pada sheet Excel
    // Alasannya tersimpan apa adanya, bukan pesan generik — itulah yang
    // dipakai pengguna untuk memperbaiki berkasnya.
    expect(gagal[0].pesan).toBeTruthy();
    expect(gagal[0].pesan!.length).toBeGreaterThan(10);
    // Identitas barisnya juga tersimpan.
    expect(gagal[0].keterangan).toContain('Budi Santoso');

    // Baris berhasil TIDAK membawa pesan galat.
    expect(log.filter((b) => b.status === 'BERHASIL').every((b) => b.pesan === null)).toBe(true);
  });

  test('dua kali import menghasilkan dua riwayat terpisah, terbaru lebih dulu', async () => {
    const buat = (kode: string, nama: string) =>
      parseBerkasDataAwal({ ANGGOTA: sheetAnggota([[kode, nama, '2026-01-02']]) });

    await catatRiwayatImport(
      testDb as never,
      // DIPERBARUI RC-S102: `migrasi` adalah field baru pada
      // HasilImportDataAwal (hasil jalur migrasi saldo awal pinjaman);
      // null di sini karena riwayat ini dibuat langsung, bukan lewat import.
      // DIPERBARUI RC-S103: `keterbatasanTurunan` field baru (keterbatasan
      // karena kolom migrasi diturunkan otomatis); kosong di sini karena
      // riwayat ini dibuat langsung, bukan lewat import.
      { perSheet: [], gagal: [], berhasil: [], totalBerhasil: 1, totalGagal: 0, migrasi: null, keterbatasanTurunan: [],
        // DIPERBARUI RC-S107: dua field baru (hasil migrasi aset & hasil
        // pengisian saldo awal otomatis); null di sini karena riwayat ini
        // dibuat langsung, bukan lewat import.
        aset: null, saldoAwal: null,
        // DIPERBARUI RC-S133.4.3: hasil sheet "6. Jasa Dibayar"; null karena riwayat ini dibuat langsung.
        jasaDataAwal: null },
      { dijalankanOleh: USER_ID, namaBerkas: 'lama.xlsx', dijalankanPada: new Date('2026-01-01T08:00:00Z') }
    );
    await jalankanImportDataAwal(buat('B1', 'Agus'), { ...opsi(), namaBerkas: 'baru.xlsx' });

    const daftar = await daftarRiwayatImport(testDb as never);
    expect(daftar).toHaveLength(2);
    // Terbaru lebih dulu — import baru dicatat dengan jam sekarang.
    expect(daftar[0].namaBerkas).toBe('baru.xlsx');
    expect(daftar[1].namaBerkas).toBe('lama.xlsx');
  });

  test('log satu riwayat tidak tercampur dengan riwayat lain', async () => {
    const buat = (kode: string, nama: string) =>
      parseBerkasDataAwal({ ANGGOTA: sheetAnggota([[kode, nama, '2026-01-02']]) });

    await jalankanImportDataAwal(buat('C1', 'Pertama'), opsi());
    await jalankanImportDataAwal(buat('C2', 'Kedua'), opsi());

    const daftar = await daftarRiwayatImport(testDb as never);
    expect(daftar).toHaveLength(2);
    for (const r of daftar) {
      const log = await logRiwayatImport(testDb as never, r.id);
      expect(log).toHaveLength(1);
    }
    const logSemua = [
      ...(await logRiwayatImport(testDb as never, daftar[0].id)),
      ...(await logRiwayatImport(testDb as never, daftar[1].id)),
    ];
    expect(logSemua.map((b) => b.keterangan).join(' ')).toMatch(/Pertama/);
    expect(logSemua.map((b) => b.keterangan).join(' ')).toMatch(/Kedua/);
  });

  test('nama berkas boleh tidak ada — tersimpan NULL, bukan teks "null"', async () => {
    const ringkasan = parseBerkasDataAwal({ ANGGOTA: sheetAnggota([['D1', 'Tanpa Nama Berkas', '2026-01-02']]) });
    await jalankanImportDataAwal(ringkasan, opsi());
    const daftar = await daftarRiwayatImport(testDb as never);
    expect(daftar[0].namaBerkas).toBeNull();
  });

  test('kegagalan mencatat riwayat TIDAK menggagalkan import yang datanya sudah masuk', async () => {
    const ringkasan = parseBerkasDataAwal({ ANGGOTA: sheetAnggota([['E1', 'Tetap Masuk', '2026-01-02']]) });

    // Tabel riwayat dihilangkan -> pencatatan pasti gagal.
    await testDb.execAsync('DROP TABLE import_data_awal_log; DROP TABLE import_data_awal_riwayat;');
    const diam = jest.spyOn(console, 'error').mockImplementation(() => {});

    const hasil = await jalankanImportDataAwal(ringkasan, opsi());

    // Import TETAP dilaporkan berhasil, karena barisnya memang tertulis.
    expect(hasil.totalBerhasil).toBe(1);
    expect(hasil.totalGagal).toBe(0);
    const anggota = await testDb.getAllAsync<{ nama_lengkap: string }>(
      `SELECT nama_lengkap FROM anggota WHERE nama_lengkap = 'Tetap Masuk'`
    );
    expect(anggota).toHaveLength(1);
    // Kegagalannya tidak ditelan diam-diam — tercatat di console.
    expect(diam).toHaveBeenCalled();
    diam.mockRestore();
  });

  test('ringkasan_json rusak tidak membuat riwayat gagal ditampilkan', async () => {
    const ringkasan = parseBerkasDataAwal({ ANGGOTA: sheetAnggota([['F1', 'Rusak', '2026-01-02']]) });
    await jalankanImportDataAwal(ringkasan, opsi());
    await testDb.runAsync(`UPDATE import_data_awal_riwayat SET ringkasan_json = ?`, '{bukan json');

    const daftar = await daftarRiwayatImport(testDb as never);
    expect(daftar).toHaveLength(1);
    expect(daftar[0].perSheet).toEqual([]);
    // Angka total tetap benar karena tersimpan sebagai kolom tersendiri.
    expect(daftar[0].totalBerhasil).toBe(1);
  });
});

// ============================================================
// C. RINCIAN BERHASIL DIKEMBALIKAN EXECUTOR
// ============================================================

describe('RC-S100 §C — executor melaporkan rincian baris berhasil', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('jumlah di perSheet dan panjang daftar berhasil selalu sama', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: sheetAnggota([
        ['G1', 'Satu', '2026-01-02'],
        ['G2', 'Dua', '2026-01-03'],
      ]),
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
        ['G1', '2026-01-05', '100000', '0', '0'],
      ],
    });

    const hasil: HasilImportDataAwal = await jalankanImportDataAwal(ringkasan, opsi());

    // Dulu penghitung dinaikkan langsung di enam tempat; sekarang satu
    // fungsi menaikkan penghitung DAN mencatat rinciannya, jadi keduanya
    // mustahil divergen. Test ini yang menjaganya.
    expect(hasil.berhasil).toHaveLength(hasil.totalBerhasil);
    for (const sheet of hasil.perSheet) {
      expect(hasil.berhasil.filter((b) => b.jenis === sheet.jenis)).toHaveLength(sheet.berhasil);
    }
  });

  test('rincian berhasil anggota memuat nomor anggota yang dibuat aplikasi', async () => {
    const ringkasan = parseBerkasDataAwal({ ANGGOTA: sheetAnggota([['H1', 'Nomor Otomatis', '2026-01-02']]) });
    const hasil = await jalankanImportDataAwal(ringkasan, opsi());

    const baris = hasil.berhasil.find((b) => b.jenis === 'ANGGOTA');
    expect(baris?.keterangan).toContain('Nomor Otomatis');
    // Nomor anggota hasil aplikasi, bukan kode Excel — supaya pengguna
    // bisa mencarinya di daftar anggota.
    const nomor = await testDb.getFirstAsync<{ nomor_anggota: string }>(
      `SELECT nomor_anggota FROM anggota WHERE nama_lengkap = 'Nomor Otomatis'`
    );
    expect(baris?.keterangan).toContain(nomor!.nomor_anggota);
  });
});
