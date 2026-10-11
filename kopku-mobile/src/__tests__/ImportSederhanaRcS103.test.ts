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

import { buatFixtureHistoris, ACC, USER_ID, saldoGl, totalDebitKredit } from './historicalFixture';
import { parseBerkasDataAwal } from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import {
  angsuranTersisaDariTenor,
  lengkapiBarisMigrasi,
  nomorMigrasiOtomatis,
  pinjamanSudahTidakBersaldo,
  sisaPokokDariAngsuranDibayar,
  KETERBATASAN_TURUNAN,
} from '@/import/TurunanMigrasiPinjaman';
import { bagiPokokSisa } from '@/import/MigrasiPinjamanPlan';
import { jalankanMigrasiSimpanan, periksaNominalSaldoAwalSimpanan } from '@/import/EksekusiMigrasiSimpanan';

/**
 * RC-S103 — IMPORT DATA AWAL YANG BISA DIPAKAI TANPA MENYUSUN ULANG BERKAS.
 *
 * Dua hal yang dibuktikan di sini:
 *
 *   1. Berkas yang HANYA memuat kolom wajib template (tanpa lima kolom
 *      migrasi RC-S102) tetap bisa diimpor sebagai saldo awal, karena
 *      Sisa Pokok / Angsuran Tersisa / Nomor Pinjaman Lama DITURUNKAN.
 *   2. Simpanan yang diimpor sebagai saldo awal TIDAK MENAMBAH KAS.
 *      Inilah bug yang tersisa setelah RC-S102: uang simpanan anggota
 *      sudah lama diterima dan sebagian besar sudah keluar menjadi
 *      pinjaman, sehingga mendebit kas sebesar total simpanan
 *      menciptakan kas yang tidak pernah ada.
 */

const CUTOFF = '2026-09-01';

const HEADER_ANGGOTA = ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'];
const HEADER_SIMPANAN = ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'];
/** Persis kolom WAJIB template — tidak satu pun kolom migrasi RC-S102. */
const HEADER_PINJAMAN = [
  'Kode Anggota',
  'Tanggal Pencairan',
  'Jumlah Pinjaman',
  'Tenor',
  'Satuan Tenor',
  'Metode Jasa',
  'Jasa Persen',
  'Sumber Dana',
  'Angsuran Sudah Dibayar',
];

async function seedAnggota(db: TestDb, id: string, nomor: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,'AKTIF',?,?)`,
    id,
    nomor,
    `Anggota ${nomor}`,
    '2024-01-02',
    now,
    now
  );
}

// ===========================================================================
// A. PENURUNAN SISA POKOK — TIDAK BOLEH ADA RUPIAH HILANG
// ===========================================================================

describe('RC-S103 §A — sisa pokok diturunkan tanpa pembulatan ganda', () => {
  test('belum ada angsuran dibayar -> sisa pokok = pokok penuh', () => {
    expect(sisaPokokDariAngsuranDibayar(10_000_000, 12, 0)).toBe(10_000_000);
  });

  test('seluruh angsuran dibayar -> sisa pokok 0', () => {
    expect(sisaPokokDariAngsuranDibayar(10_000_000, 12, 12)).toBe(0);
  });

  test('sisa pokok + bagian yang sudah dibayar = pokok, PERSIS, pada pokok yang tidak habis dibagi', () => {
    // 10.000.000 / 12 = 833.333,33 -> justru kasus yang membuat rumus
    // naif (pokok - dibayar * floor(pokok/tenor)) menyimpang.
    const pokok = 10_000_000;
    const tenor = 12;
    for (let dibayar = 0; dibayar <= tenor; dibayar++) {
      const sisa = sisaPokokDariAngsuranDibayar(pokok, tenor, dibayar);
      const potongan = bagiPokokSisa(pokok, tenor)
        .slice(0, dibayar)
        .reduce((t, n) => t + n, 0);
      expect(sisa + potongan).toBe(pokok);
    }
  });

  test('rumus lepas ber-Math.floor memberi hasil SAMA — jadi bukan itu alasannya', () => {
    // Dicatat sebagai fakta, bukan sebagai pembenaran: untuk pembagian
    // ber-floor, rumus lepas ini memang setara. Klaim "rumus naif salah
    // hitung" akan keliru, dan test ini yang menjaganya tetap keliru
    // kalau suatu saat dituliskan lagi.
    const pokok = 10_000_000;
    const tenor = 12;
    for (let dibayar = 0; dibayar <= tenor; dibayar++) {
      const lepas = pokok - dibayar * Math.floor(pokok / tenor);
      const lewatJadwal = sisaPokokDariAngsuranDibayar(pokok, tenor, dibayar);
      if (dibayar < tenor) expect(lewatJadwal).toBe(lepas);
    }
  });

  test('yang BENAR-BENAR menyimpang adalah varian ber-Math.round', () => {
    // 1.700.000 / 3 = 566.666,67 -> floor 566.666, round 566.667.
    const pokok = 1_700_000;
    const tenor = 3;
    const dibayar = 1;
    const bulat = pokok - dibayar * Math.round(pokok / tenor);
    expect(bulat).not.toBe(sisaPokokDariAngsuranDibayar(pokok, tenor, dibayar));
  });

  test('alasan sesungguhnya: hasilnya WAJIB sama dengan pembagian yang dipakai penyusun jadwal', () => {
    // Inilah invarian yang menjaga buku pembantu tidak berselisih dengan
    // saldo awal buku besar: sisa pokok yang diturunkan harus persis
    // habis dibagi ulang oleh `bagiPokokSisa()` menjadi jadwal sisanya.
    for (const pokok of [10_000_000, 7_777_777, 1_000_001, 999]) {
      for (const tenor of [3, 6, 12, 24]) {
        for (let dibayar = 0; dibayar < tenor; dibayar++) {
          const sisa = sisaPokokDariAngsuranDibayar(pokok, tenor, dibayar);
          const jadwal = bagiPokokSisa(sisa, tenor - dibayar);
          expect(jadwal.reduce((t, n) => t + n, 0)).toBe(sisa);
        }
      }
    }
  });

  test('angsuran dibayar melebihi tenor atau negatif dijepit, tidak menghasilkan sisa negatif', () => {
    expect(sisaPokokDariAngsuranDibayar(5_000_000, 10, 99)).toBe(0);
    expect(sisaPokokDariAngsuranDibayar(5_000_000, 10, -3)).toBe(5_000_000);
    expect(angsuranTersisaDariTenor(10, 99)).toBe(0);
    expect(angsuranTersisaDariTenor(10, -3)).toBe(10);
  });

  test('tenor tidak valid tidak melempar, mengembalikan 0 supaya baris dilewati dengan sebab jelas', () => {
    expect(sisaPokokDariAngsuranDibayar(5_000_000, 0, 0)).toBe(0);
    expect(sisaPokokDariAngsuranDibayar(5_000_000, 2.5, 0)).toBe(0);
    expect(angsuranTersisaDariTenor(0, 0)).toBe(0);
  });
});

// ===========================================================================
// B. NOMOR OTOMATIS & PRIORITAS NILAI DARI BERKAS
// ===========================================================================

describe('RC-S103 §B — nomor otomatis deterministik, nilai berkas selalu menang', () => {
  test('nomor otomatis sama untuk berkas yang sama -> import ulang tertahan UNIQUE', () => {
    expect(nomorMigrasiOtomatis('a1', 7)).toBe('SA-A1-0007');
    expect(nomorMigrasiOtomatis('a1', 7)).toBe(nomorMigrasiOtomatis('A1', 7));
  });

  test('baris berbeda pada anggota yang sama mendapat nomor berbeda', () => {
    expect(nomorMigrasiOtomatis('A1', 7)).not.toBe(nomorMigrasiOtomatis('A1', 8));
  });

  test('nilai yang SUDAH ada di berkas dipakai apa adanya dan tidak dicatat sebagai turunan', () => {
    const h = lengkapiBarisMigrasi({
      baris: 2,
      kode: 'A1',
      jumlahPinjaman: 10_000_000,
      tenor: 12,
      angsuranSudahDibayar: 4,
      nomorPinjamanLama: 'PJ-LAMA-9',
      sisaPokok: 6_123_456,
      angsuranTersisa: 8,
    });
    expect(h.nomorPinjamanLama).toBe('PJ-LAMA-9');
    expect(h.sisaPokok).toBe(6_123_456);
    expect(h.angsuranTersisa).toBe(8);
    expect(h.diturunkan).toEqual([]);
  });

  test('yang kosong diturunkan, dan setiap penurunan dicatat', () => {
    const h = lengkapiBarisMigrasi({
      baris: 3,
      kode: 'A2',
      jumlahPinjaman: 12_000_000,
      tenor: 12,
      angsuranSudahDibayar: 3,
    });
    expect(h.nomorPinjamanLama).toBe('SA-A2-0003');
    expect(h.sisaPokok).toBe(9_000_000);
    expect(h.angsuranTersisa).toBe(9);
    expect(h.diturunkan).toEqual(['NOMOR_PINJAMAN_LAMA', 'SISA_POKOK', 'ANGSURAN_TERSISA']);
  });

  test('pinjaman yang sudah habis angsurannya dikenali sebagai tidak bersaldo', () => {
    const h = lengkapiBarisMigrasi({
      baris: 4,
      kode: 'A3',
      jumlahPinjaman: 12_000_000,
      tenor: 12,
      angsuranSudahDibayar: 12,
    });
    expect(pinjamanSudahTidakBersaldo(h)).toBe(true);
  });

  test('TIDAK menurunkan tunggakan maupun piutang jasa — keduanya akan mengarang kolektibilitas', () => {
    const h = lengkapiBarisMigrasi({
      baris: 5,
      kode: 'A4',
      jumlahPinjaman: 6_000_000,
      tenor: 6,
      angsuranSudahDibayar: 2,
    });
    expect(h.diturunkan).not.toContain('TUNGGAKAN_POKOK');
    expect(Object.keys(h)).not.toContain('tunggakanPokok');
    expect(Object.keys(h)).not.toContain('piutangJasa');
  });
});

// ===========================================================================
// C. BERKAS TANPA KOLOM MIGRASI — INTI KELUHANNYA
// ===========================================================================

describe('RC-S103 §C — berkas hanya berkolom wajib tetap bisa diimpor sebagai saldo awal', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  const berkas = () =>
    parseBerkasDataAwal({
      ANGGOTA: [
        HEADER_ANGGOTA,
        ['A1', 'Budi Lama', '2024-01-02'],
        ['A2', 'Sari Lama', '2024-01-02'],
      ],
      PINJAMAN: [
        HEADER_PINJAMAN,
        ['A1', '2025-07-01', '12000000', '12', 'BULAN', 'FLAT', '1', 'KAS', '3'],
        ['A2', '2026-08-01', '10000000', '10', 'BULAN', 'FLAT', '1', 'KAS', '0'],
      ],
    });

  test('berkas dianggap siap oleh pratinjau walau tanpa kolom migrasi', () => {
    expect(berkas().siapDiimpor).toBe(true);
  });

  test('SEBELUM RC-S103 jalur ini menolak semuanya; sekarang seluruh baris masuk tanpa kas berkurang', async () => {
    const kasSebelum = await saldoGl(testDb, ACC.kas);

    const hasil = await jalankanImportDataAwal(berkas(), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });

    const p = hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!;
    expect(p.gagal).toBe(0);
    expect(p.berhasil).toBe(2);
    expect(hasil.migrasi).not.toBeNull();

    // Sisa pokok: A1 sudah bayar 3 dari 12 -> 9.000.000; A2 belum bayar -> 10.000.000.
    expect(hasil.migrasi!.totalSisaPokok).toBe(19_000_000);
    expect(await saldoGl(testDb, ACC.kas)).toBe(kasSebelum);
  });

  test('nomor pinjaman yang tersimpan adalah nomor otomatis berpola SA-', async () => {
    await jalankanImportDataAwal(berkas(), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    const rows = await testDb.getAllAsync<{ nomor_pinjaman: string }>(
      `SELECT nomor_pinjaman FROM pinjaman ORDER BY nomor_pinjaman`
    );
    expect(rows.map((r) => r.nomor_pinjaman)).toEqual(['SA-A1-0002', 'SA-A2-0003']);
  });

  test('total pokok jadwal angsuran sama dengan total sisa pokok — buku pembantu utuh', async () => {
    const hasil = await jalankanImportDataAwal(berkas(), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    const row = await testDb.getFirstAsync<{ t: number }>(`SELECT SUM(pokok) AS t FROM angsuran_jadwal WHERE status != 'LUNAS'` /* DIPERBARUI RC-S133.4.5: angsuran yang sudah dibayar kini ikut tercatat (LUNAS) */);
    expect(Number(row?.t)).toBe(hasil.migrasi!.totalSisaPokok);
  });

  test('keterbatasan penurunan DILAPORKAN, tidak disembunyikan', async () => {
    const hasil = await jalankanImportDataAwal(berkas(), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    for (const k of KETERBATASAN_TURUNAN) expect(hasil.keterbatasanTurunan).toContain(k);
  });

  test('berkas yang memuat kolom migrasinya sendiri TIDAK memicu keterbatasan turunan', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [HEADER_ANGGOTA, ['A1', 'Budi Lama', '2024-01-02']],
      PINJAMAN: [
        [...HEADER_PINJAMAN, 'Nomor Pinjaman Lama', 'Sisa Pokok', 'Angsuran Tersisa'],
        ['A1', '2025-07-01', '12000000', '12', 'BULAN', 'FLAT', '1', 'KAS', '3', 'PJ-2025-7', '9000000', '9'],
      ],
    });
    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    expect(hasil.keterbatasanTurunan).toEqual([]);
    const row = await testDb.getFirstAsync<{ nomor_pinjaman: string }>(`SELECT nomor_pinjaman FROM pinjaman`);
    expect(row?.nomor_pinjaman).toBe('PJ-2025-7');
  });

  test('pinjaman yang sudah lunas dilewati dengan sebab yang bisa dimengerti, bukan pesan validator', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [HEADER_ANGGOTA, ['A1', 'Budi Lama', '2024-01-02']],
      PINJAMAN: [HEADER_PINJAMAN, ['A1', '2025-01-01', '6000000', '6', 'BULAN', 'FLAT', '1', 'KAS', '6']],
    });
    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    // Satu baris dilewati, BUKAN seluruh migrasi dibatalkan.
    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.gagal).toBe(1);
    const pesan = hasil.gagal.find((g) => g.jenis === 'PINJAMAN')!.pesan;
    expect(pesan).toMatch(/sudah dibayar sebelum tanggal cut-off/i);
    expect(pesan).not.toMatch(/harus bilangan bulat/i);
  });

  test('satu baris lunas TIDAK menggagalkan baris lain yang masih bersaldo', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [HEADER_ANGGOTA, ['A1', 'Budi', '2024-01-02'], ['A2', 'Sari', '2024-01-02']],
      PINJAMAN: [
        HEADER_PINJAMAN,
        ['A1', '2025-01-01', '6000000', '6', 'BULAN', 'FLAT', '1', 'KAS', '6'],
        ['A2', '2025-01-01', '6000000', '6', 'BULAN', 'FLAT', '1', 'KAS', '2'],
      ],
    });
    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    const p = hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!;
    expect(p.berhasil).toBe(1);
    expect(p.gagal).toBe(1);
    expect(hasil.migrasi!.totalSisaPokok).toBe(4_000_000);
  });

  test('import ULANG berkas yang sama tidak menggandakan pinjaman', async () => {
    const opsi = {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    };
    await jalankanImportDataAwal(berkas(), opsi);
    const sesudahPertama = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM pinjaman`);
    // Anggotanya gagal dibuat ulang (nomor/NIK), tapi yang diuji di sini
    // adalah penjaga nomor pinjaman: baris migrasi harus DILEWATI.
    const kedua = await jalankanImportDataAwal(berkas(), opsi);
    const sesudahKedua = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM pinjaman`);
    expect(Number(sesudahKedua?.n)).toBe(Number(sesudahPertama?.n));
    expect(kedua.migrasi?.berhasil ?? []).toHaveLength(0);
  });
});

// ===========================================================================
// D. SIMPANAN SALDO AWAL TIDAK MENAMBAH KAS
// ===========================================================================

describe('RC-S103 §D — simpanan saldo awal tidak menciptakan kas fiktif', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  const berkasSimpanan = (tanggal: string) =>
    parseBerkasDataAwal({
      ANGGOTA: [HEADER_ANGGOTA, ['A1', 'Budi Lama', '2024-01-02']],
      SIMPANAN: [HEADER_SIMPANAN, ['A1', tanggal, '100000', '2400000', '500000']],
    });

  test('tanggal SEBELUM cut-off: kas TIDAK berubah, tapi saldo simpanan anggota tetap tercatat', async () => {
    const kasSebelum = await saldoGl(testDb, ACC.kas);

    const hasil = await jalankanImportDataAwal(berkasSimpanan('2025-01-01'), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });

    expect(hasil.perSheet.find((s) => s.jenis === 'SIMPANAN')!.berhasil).toBe(1);
    expect(await saldoGl(testDb, ACC.kas)).toBe(kasSebelum);

    // Buku pembantunya ADA — tiga baris, tanpa journal_id.
    const rows = await testDb.getAllAsync<{ jenis: string; nominal: number; journal_id: string | null }>(
      `SELECT jenis, nominal, journal_id FROM simpanan_transaksi ORDER BY jenis`
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.journal_id === null)).toBe(true);
    expect(rows.reduce((t, r) => t + r.nominal, 0)).toBe(3_000_000);
  });

  test('buku besar tetap seimbang — tidak ada jurnal setengah jadi', async () => {
    await jalankanImportDataAwal(berkasSimpanan('2025-01-01'), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  test('tanggal PADA/SETELAH cut-off tetap menjurnal debit kas seperti sebelumnya', async () => {
    const kasSebelum = await saldoGl(testDb, ACC.kas);
    await jalankanImportDataAwal(berkasSimpanan('2026-09-15'), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    expect(await saldoGl(testDb, ACC.kas)).toBe(kasSebelum + 3_000_000);
  });

  test('TANPA cut-off perilakunya PERSIS seperti sebelum RC-S103 (kas bertambah)', async () => {
    const kasSebelum = await saldoGl(testDb, ACC.kas);
    await jalankanImportDataAwal(berkasSimpanan('2025-01-01'), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      // tanggalCutOff sengaja TIDAK diisi
    });
    expect(await saldoGl(testDb, ACC.kas)).toBe(kasSebelum + 3_000_000);
  });

  test('keterbatasan saldo awal simpanan dilaporkan, termasuk peringatan kas', async () => {
    const hasil = await jalankanImportDataAwal(berkasSimpanan('2025-01-01'), {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    expect(hasil.keterbatasanTurunan.some((k) => /TIDAK menambah kas/i.test(k))).toBe(true);
  });

  test('aturan Simpanan Pokok sekali per anggota TETAP berlaku di jalur saldo awal', async () => {
    await seedAnggota(testDb, 'ang-sa-1', 'A-900');
    const input = {
      anggotaId: 'ang-sa-1',
      tanggal: '2025-01-01',
      pokok: 100_000,
      wajib: 0,
      sukarela: 0,
      sumberDana: 'KAS' as const,
      createdBy: USER_ID,
    };
    await jalankanMigrasiSimpanan(testDb as never, input);
    await expect(jalankanMigrasiSimpanan(testDb as never, input)).rejects.toThrow(/Simpanan Pokok hanya dibayar satu kali/i);
  });

  test('anggota tidak aktif ditolak di jalur saldo awal', async () => {
    await seedAnggota(testDb, 'ang-sa-2', 'A-901');
    await testDb.runAsync(`UPDATE anggota SET status = 'KELUAR' WHERE id = ?`, 'ang-sa-2');
    await expect(
      jalankanMigrasiSimpanan(testDb as never, {
        anggotaId: 'ang-sa-2',
        tanggal: '2025-01-01',
        pokok: 0,
        wajib: 50_000,
        sukarela: 0,
        sumberDana: 'KAS',
        createdBy: USER_ID,
      })
    ).rejects.toThrow(/berstatus KELUAR/i);
  });

  test('nominal negatif dan total nol ditolak', () => {
    expect(() => periksaNominalSaldoAwalSimpanan(-1, 0, 0)).toThrow(/tidak boleh negatif/i);
    expect(() => periksaNominalSaldoAwalSimpanan(0, 0, 0)).toThrow(/minimal salah satu/i);
    expect(() => periksaNominalSaldoAwalSimpanan(0, 1, 0)).not.toThrow();
  });
});

// ===========================================================================
// E. KASUS GABUNGAN — KOPERASI BERKAS KECIL, PORTOFOLIO BESAR
// ===========================================================================

describe('RC-S103 §E — satu berkas berkolom wajib saja, simpanan + pinjaman lama sekaligus', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('seluruh baris masuk, kas tidak bergerak sama sekali, buku besar seimbang', async () => {
    const kasSebelum = await saldoGl(testDb, ACC.kas);
    const bankSebelum = await saldoGl(testDb, ACC.bank);

    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [HEADER_ANGGOTA, ['A1', 'Budi', '2024-01-02'], ['A2', 'Sari', '2024-01-02']],
      SIMPANAN: [
        HEADER_SIMPANAN,
        ['A1', '2025-01-01', '100000', '1200000', '300000'],
        ['A2', '2025-01-01', '100000', '900000', '0'],
      ],
      PINJAMAN: [
        HEADER_PINJAMAN,
        ['A1', '2025-07-01', '12000000', '12', 'BULAN', 'FLAT', '1', 'KAS', '3'],
        ['A2', '2026-08-01', '10000000', '10', 'BULAN', 'FLAT', '1', 'KAS', '1'],
      ],
    });
    expect(ringkasan.siapDiimpor).toBe(true);

    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });

    expect(hasil.totalGagal).toBe(0);
    expect(hasil.totalBerhasil).toBe(6);
    expect(await saldoGl(testDb, ACC.kas)).toBe(kasSebelum);
    expect(await saldoGl(testDb, ACC.bank)).toBe(bankSebelum);
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);

    // Rekonsiliasi memberi tahu angka yang harus diisi di Saldo Awal Akun.
    expect(hasil.migrasi!.rekonsiliasi.totalSisaPokokBukuPembantu).toBe(hasil.migrasi!.totalSisaPokok);
    expect(hasil.migrasi!.rekonsiliasi.pesan.join(' ')).toMatch(/Saldo awal akun/i);
  });
});

// ===========================================================================
// F. PENJAGA STRUKTURAL
// ===========================================================================

describe('RC-S103 §F — penjaga struktural', () => {
  const baca = (rel: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('fs') as typeof import('fs')).readFileSync(
      (require('path') as typeof import('path')).join(process.cwd(), rel),
      'utf8'
    );

  test('jalur saldo awal simpanan TIDAK mengimpor createJournal maupun memanggilnya', () => {
    const src = baca('src/import/EksekusiMigrasiSimpanan.ts');
    // Baris IMPORT, bukan sekadar kata di komentar — jebakan yang sudah
    // beberapa kali membuat penjaga struktural lolos padahal kodenya
    // berubah.
    expect(src).not.toMatch(/^import .*createJournal/m);
    expect(src).not.toMatch(/^import .*from '@\/accounting\//m);
    // Dan tidak ada bentuk PEMANGGILAN-nya.
    expect(src).not.toMatch(/createJournal\s*\(/);
    expect(src).not.toMatch(/resolveAccountId\s*\(/);
  });

  test('baris simpanan saldo awal ditulis dengan journal_id NULL — bukan lewat setor biasa', () => {
    const src = baca('src/import/EksekusiMigrasiSimpanan.ts');
    // Satu-satunya INSERT-nya menyebut journal_id, dan nilainya `null`.
    expect(src).toMatch(/INSERT INTO simpanan_transaksi/);
    expect(src).not.toMatch(/^import .*catatDataAwalSimpanan/m);
    expect(src).not.toMatch(/setorSimpanan\s*\(/);
  });

  test('catatDataAwalSimpanan TETAP menjurnal debit kas — jalur Setor Simpanan tidak diubah', () => {
    const src = baca('src/services/SimpananService.ts');
    // Kalau ada yang "merapikan" dengan menghapus jurnalnya dari fungsi
    // ini, menu Setor Simpanan akan berhenti mencatat penerimaan kas.
    expect(src).toMatch(/kasBankAccountId, debit: total, kredit: 0/);
    expect(src).toMatch(/createJournal\s*\(/);
  });

  test('penurunan kolom TIDAK menyentuh tunggakan pokok maupun piutang jasa', () => {
    const src = baca('src/import/TurunanMigrasiPinjaman.ts');
    // Keduanya hanya boleh muncul sebagai teks keterbatasan, bukan
    // sebagai nilai yang dihitung dan dikembalikan.
    expect(src).not.toMatch(/tunggakanPokok\s*[:=]/);
    expect(src).not.toMatch(/piutangJasa\s*[:=]/);
  });

  test('layar import tidak lagi menuntut pengguna mengisi tanggal untuk jalur saldo awal', () => {
    const src = baca('src/screens/Pengaturan/ImportDataAwalScreen.tsx');
    // Cut-off diisi sendiri oleh layar bila pengguna tidak mengisinya.
    expect(src).toMatch(/cutOffManual\.trim\(\)\s*\|\|\s*getTanggalLokalHariIni\(\)/);
    // Dan memakai jam simulasi, BUKAN new Date() — penjaga RC-S95.
    //
    // KOMENTAR DIBUANG DULU. Versi pertama penjaga ini gagal karena
    // frasa "new Date()" ada di DOCBLOCK yang justru menerangkan
    // larangannya — persis jebakan yang sudah beberapa kali membuat
    // penjaga struktural di repo ini memeriksa prosa, bukan kode.
    const kode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(kode).not.toMatch(/new Date\(\)/);
    expect(kode).toMatch(/getTanggalLokalHariIni\(\)/);
  });

  test('pilihan bawaan layar adalah SALDO_AWAL, bukan pencairan baru', () => {
    const src = baca('src/screens/Pengaturan/ImportDataAwalScreen.tsx');
    expect(src).toMatch(/useState<'SALDO_AWAL' \| 'TRANSAKSI_BARU'>\('SALDO_AWAL'\)/);
  });

  test('tanpa perubahan skema untuk fitur ini', () => {
    const src = baca('src/database/schema.ts');
    expect(src).toMatch(/SCHEMA_VERSION\s*=\s*80\b/); // DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128). DIPERBARUI v78 — migrasi milik fitur bunga harian sukarela. DIPERBARUI v77 (Poin 5/6/10) — migrasi milik patch 19 poin, bukan fitur ini
  });
});
