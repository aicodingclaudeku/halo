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
import { hitungJadwalAngsuran } from '@/accounting/PinjamanCalculator';
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import {
  jalankanMigrasiPinjaman,
  pratinjauMigrasiPinjaman,
  ValidasiMigrasiGagalError,
} from '@/import/EksekusiMigrasiPinjaman';
import {
  PENANDA_MIGRASI,
  adalahPinjamanMigrasi,
  bagiPokokSisa,
  pokokJasaAngsuranSisa,
  majuPeriode,
  rekonsiliasiPiutang,
  susunJadwalSisa,
  validasiMigrasiPinjaman,
  type BarisMigrasiPinjaman,
} from '@/import/MigrasiPinjamanPlan';

/**
 * RC-S102 — MIGRASI SALDO AWAL PINJAMAN BERJALAN.
 *
 * Yang dibuktikan di sini adalah tepat keluhan aslinya: koperasi dengan
 * KAS KECIL tetapi portofolio pinjaman BESAR harus bisa memigrasikan
 * pinjaman lamanya, TANPA kas hari ini berkurang dan TANPA pemeriksaan
 * likuiditas ikut campur — sementara pencairan pinjaman BARU tetap
 * ditolak ketika likuiditasnya memang tidak cukup.
 */

const ANG = { a1: 'ang-mig-1', a2: 'ang-mig-2' };
const CUTOFF = '2026-01-01';

async function seedAnggota(db: TestDb, id: string, nomor: string, nama: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,'AKTIF',?,?)`,
    id,
    nomor,
    nama,
    '2024-01-02',
    now,
    now
  );
}

const peta = () =>
  new Map([
    ['A1', { id: ANG.a1, nomorAnggota: 'A-001', nama: 'Budi' }],
    ['A2', { id: ANG.a2, nomorAnggota: 'A-002', nama: 'Sari' }],
  ]);

function baris(over: Partial<BarisMigrasiPinjaman> = {}): BarisMigrasiPinjaman {
  return {
    baris: 2,
    kodeAnggota: 'A1',
    nomorPinjamanAsli: 'LAMA-001',
    tanggalAkad: '2024-06-01',
    jumlahPinjamanAsli: 20_000_000,
    sisaPokok: 12_000_000,
    angsuranTersisa: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    ...over,
  };
}

const opsi = () => ({ tanggalCutOff: CUTOFF, createdBy: USER_ID, petaAnggota: peta() });

// ===========================================================================
// A. RUMUS & PENYUSUNAN JADWAL (modul murni)
// ===========================================================================

describe('RC-S102 §A — pembagian pokok & jadwal sisa', () => {
  test('jumlah pokok jadwal SELALU sama dengan sisa pokok, termasuk saat tidak terbagi rata', () => {
    // Invarian yang menentukan: kalau selisih pembulatan dibiarkan, buku
    // pembantu dan saldo awal buku besar akan selisih beberapa rupiah dan
    // rekonsiliasinya gagal selamanya.
    for (const [sisa, n] of [
      [12_000_000, 12],
      [10_000_000, 3],
      [1, 1],
      [7, 3],
      [999_999, 7],
    ] as const) {
      const bagian = bagiPokokSisa(sisa, n);
      expect(bagian).toHaveLength(n);
      expect(bagian.reduce((a, b) => a + b, 0)).toBe(sisa);
      expect(bagian.every((x) => x >= 0)).toBe(true);
    }
  });

  test('selisih pembulatan ditaruh di angsuran TERAKHIR', () => {
    // 10.000.000 / 3 = 3.333.333,33 -> 3.333.333 + 3.333.333 + 3.333.334
    expect(bagiPokokSisa(10_000_000, 3)).toEqual([3_333_333, 3_333_333, 3_333_334]);
  });

  /**
   * DIGANTI RC-S105 — test lama MENGUNCI PERILAKU YANG SALAH.
   *
   * Ia menuntut jasa flat dihitung "dari SISA pokok", padahal definisi
   * metode FLAT adalah jasa dari pokok AKAD dan sama tiap periode.
   * Test yang salah inilah yang membuat bugnya lolos: ia hijau justru
   * karena mencocokkan rumus yang keliru dengan dirinya sendiri.
   * Sekarang acuannya `hitungJadwalAngsuran()` — jadwal pinjaman baru —
   * bukan angka yang saya tulis sendiri.
   */
  test('FLAT: jasa per angsuran = pokok AKAD x persen, sama dengan jadwal pinjaman baru', () => {
    const { jasa } = pokokJasaAngsuranSisa({
      metodeJasa: 'FLAT',
      jumlahPinjamanAsli: 12_000_000,
      sisaPokok: 9_000_000,
      angsuranTersisa: 9,
      persentaseJasa: 1.5,
    });
    const normal = hitungJadwalAngsuran({
      jumlahPinjaman: 12_000_000, tenor: 12, persentaseJasaPerPeriode: 1.5, metode: 'FLAT',
    });
    expect(jasa).toHaveLength(9);
    expect(jasa.every((j) => j === normal[0].jasa)).toBe(true);
    expect(jasa[0]).toBe(180_000);
  });

  test('FLAT: jasa TIDAK ikut mengecil saat sisa pokok mengecil', () => {
    const a = pokokJasaAngsuranSisa({ metodeJasa: 'FLAT', jumlahPinjamanAsli: 12_000_000, sisaPokok: 9_000_000, angsuranTersisa: 9, persentaseJasa: 1.5 });
    const b = pokokJasaAngsuranSisa({ metodeJasa: 'FLAT', jumlahPinjamanAsli: 12_000_000, sisaPokok: 3_000_000, angsuranTersisa: 3, persentaseJasa: 1.5 });
    expect(a.jasa[0]).toBe(b.jasa[0]);
  });

  test('MENURUN & EFEKTIF: dihitung lewat kalkulator yang SAMA dengan pinjaman baru', () => {
    for (const metode of ['MENURUN', 'EFEKTIF'] as const) {
      const hasil = pokokJasaAngsuranSisa({
        metodeJasa: metode, jumlahPinjamanAsli: 12_000_000, sisaPokok: 9_000_000, angsuranTersisa: 9, persentaseJasa: 1.5,
      });
      const acuan = hitungJadwalAngsuran({
        jumlahPinjaman: 9_000_000, tenor: 9, persentaseJasaPerPeriode: 1.5, metode,
      });
      expect(hasil.pokok).toEqual(acuan.map((r) => r.pokok));
      expect(hasil.jasa).toEqual(acuan.map((r) => r.jasa));
      // MENURUN: jasa menurun tiap periode — beda tegas dari FLAT.
      if (metode === 'MENURUN') expect(hasil.jasa[0]).toBeGreaterThan(hasil.jasa[8]);
    }
  });

  test('CUSTOM tetap 0 — jadwalnya memang manual, menebak berarti mengarang', () => {
    const { pokok, jasa } = pokokJasaAngsuranSisa({
      metodeJasa: 'CUSTOM', jumlahPinjamanAsli: 12_000_000, sisaPokok: 9_000_000, angsuranTersisa: 9, persentaseJasa: 1.5,
    });
    expect(jasa.every((j) => j === 0)).toBe(true);
    expect(pokok.reduce((t, p) => t + p, 0)).toBe(9_000_000);
  });

  test('persen 0 atau tidak sah tidak menghasilkan jasa, apa pun metodenya', () => {
    for (const metode of ['FLAT', 'MENURUN', 'EFEKTIF', 'CUSTOM'] as const) {
      const { jasa } = pokokJasaAngsuranSisa({
        metodeJasa: metode, jumlahPinjamanAsli: 12_000_000, sisaPokok: 9_000_000, angsuranTersisa: 9, persentaseJasa: 0,
      });
      expect(jasa.every((j) => j === 0)).toBe(true);
    }
  });

  test('pokok SELALU berjumlah persis sisa pokok, untuk seluruh metode', () => {
    for (const metode of ['FLAT', 'MENURUN', 'EFEKTIF', 'CUSTOM'] as const) {
      for (const [sisa, n] of [[9_000_000, 9], [7_777_777, 6], [1_000_001, 7]] as const) {
        const { pokok } = pokokJasaAngsuranSisa({
          metodeJasa: metode, jumlahPinjamanAsli: 12_000_000, sisaPokok: sisa, angsuranTersisa: n, persentaseJasa: 1.5,
        });
        expect(pokok.reduce((t, p) => t + p, 0)).toBe(sisa);
      }
    }
  });

  test('tanpa tunggakan: seluruh jadwal BELUM_BAYAR & jatuh tempo setelah cut-off', () => {
    const jadwal = susunJadwalSisa({
      jumlahPinjamanAsli: 6_000_000,
      sisaPokok: 6_000_000,
      angsuranTersisa: 6,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      tanggalCutOff: CUTOFF,
    });
    expect(jadwal).toHaveLength(6);
    expect(jadwal.every((j) => j.status === 'BELUM_BAYAR')).toBe(true);
    expect(jadwal.every((j) => j.tanggalJatuhTempo > CUTOFF)).toBe(true);
    expect(jadwal[0].tanggalJatuhTempo).toBe('2026-02-01');
    expect(jadwal[5].tanggalJatuhTempo).toBe('2026-07-01');
  });

  test('dengan tunggakan: angsuran tertunggak berstatus TERLAMBAT & jatuh tempo SEBELUM cut-off', () => {
    // Tunggakan 2.000.000 dari sisa 6.000.000 (6 angsuran @1.000.000)
    // -> 2 angsuran pertama tertunggak.
    const jadwal = susunJadwalSisa({
      jumlahPinjamanAsli: 6_000_000,
      sisaPokok: 6_000_000,
      angsuranTersisa: 6,
      tunggakanPokok: 2_000_000,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      tanggalCutOff: CUTOFF,
    });
    const tertunggak = jadwal.filter((j) => j.status === 'TERLAMBAT');
    expect(tertunggak).toHaveLength(2);
    // Aging terbaca benar sejak hari pertama: jatuh temponya di masa lalu.
    expect(tertunggak.every((j) => j.tanggalJatuhTempo < CUTOFF)).toBe(true);
    expect(tertunggak[0].tanggalJatuhTempo).toBe('2025-11-01');
    expect(tertunggak[1].tanggalJatuhTempo).toBe('2025-12-01');
    // Sisanya tetap di masa depan.
    expect(jadwal.filter((j) => j.status === 'BELUM_BAYAR')).toHaveLength(4);
    // Dan totalnya tetap sama dengan sisa pokok.
    expect(jadwal.reduce((t, j) => t + j.pokok, 0)).toBe(6_000_000);
  });

  test('majuPeriode tidak melewati akhir bulan (31 Jan + 1 bulan = 28 Feb)', () => {
    expect(majuPeriode('2026-01-31', 'BULAN', 1)).toBe('2026-02-28');
    expect(majuPeriode('2026-01-15', 'BULAN', 2)).toBe('2026-03-15');
    expect(majuPeriode('2026-01-01', 'MINGGU', 2)).toBe('2026-01-15');
    expect(majuPeriode('2026-01-01', 'HARI', 10)).toBe('2026-01-11');
    expect(majuPeriode('2026-03-01', 'BULAN', -1)).toBe('2026-02-01');
  });
});

// ===========================================================================
// B. VALIDASI — TIDAK ADA YANG DITULIS SEBELUM BERKAS BERSIH
// ===========================================================================

describe('RC-S102 §B — validasi menolak sebelum menulis', () => {
  test('akad pada/setelah cut-off DITOLAK dengan sebab yang menyebut jalur benarnya', () => {
    const g = validasiMigrasiPinjaman([baris({ tanggalAkad: CUTOFF })], { tanggalCutOff: CUTOFF });
    expect(g.map((x) => x.kode)).toContain('AKAD_SETELAH_CUTOFF');
    expect(g[0].pesan).toMatch(/pencairan baru/i);
    expect(g[0].pesan).toMatch(/likuiditas/i);
  });

  test('nomor pinjaman lama wajib & tidak boleh ganda dalam satu berkas', () => {
    expect(
      validasiMigrasiPinjaman([baris({ nomorPinjamanAsli: '  ' })], { tanggalCutOff: CUTOFF }).map((x) => x.kode)
    ).toContain('NOMOR_ASLI_KOSONG');

    const ganda = validasiMigrasiPinjaman(
      [baris({ baris: 2, nomorPinjamanAsli: 'X-1' }), baris({ baris: 3, nomorPinjamanAsli: 'x-1' })],
      { tanggalCutOff: CUTOFF }
    );
    expect(ganda.map((x) => x.kode)).toContain('NOMOR_ASLI_GANDA');
    // Menyebut baris yang bertabrakan, bukan hanya "duplikat".
    expect(ganda.find((x) => x.kode === 'NOMOR_ASLI_GANDA')!.pesan).toContain('baris 2');
  });

  test.each([
    ['sisa pokok 0', { sisaPokok: 0 }, 'SISA_POKOK_TIDAK_VALID'],
    ['sisa pokok > pokok akad', { sisaPokok: 30_000_000 }, 'SISA_POKOK_MELEBIHI_POKOK_ASLI'],
    ['angsuran tersisa 0', { angsuranTersisa: 0 }, 'ANGSURAN_TERSISA_TIDAK_VALID'],
    ['tunggakan > sisa pokok', { tunggakanPokok: 99_000_000 }, 'TUNGGAKAN_MELEBIHI_SISA_POKOK'],
    ['piutang jasa negatif', { piutangJasa: -1 }, 'PIUTANG_JASA_NEGATIF'],
  ])('%s ditolak', (_n, over, kode) => {
    const g = validasiMigrasiPinjaman([baris(over as Partial<BarisMigrasiPinjaman>)], { tanggalCutOff: CUTOFF });
    expect(g.map((x) => x.kode)).toContain(kode);
  });

  test('status LUNAS tidak dapat dimigrasikan', () => {
    const g = validasiMigrasiPinjaman(
      [baris({ status: 'LUNAS' as never })],
      { tanggalCutOff: CUTOFF }
    );
    expect(g.map((x) => x.kode)).toContain('STATUS_TIDAK_DIIZINKAN');
  });

  test('cut-off tidak sah menghentikan validasi lebih awal', () => {
    const g = validasiMigrasiPinjaman([baris()], { tanggalCutOff: '01/01/2026' });
    expect(g).toHaveLength(1);
    expect(g[0].kode).toBe('CUTOFF_TIDAK_VALID');
  });

  test('berkas bersih -> tidak ada galat', () => {
    expect(validasiMigrasiPinjaman([baris()], { tanggalCutOff: CUTOFF })).toEqual([]);
  });
});

// ===========================================================================
// C. EKSEKUSI DI SQLite — INTI KELUHAN
// ===========================================================================

describe('RC-S102 §C — migrasi TIDAK menyentuh kas & tidak menjurnal', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
    await seedAnggota(testDb, ANG.a2, 'A-002', 'Sari');
  });

  test('KAS KECIL + portofolio pinjaman BESAR: migrasi tetap berhasil', async () => {
    // Inilah kasus yang dulu mustahil: kas koperasi jauh lebih kecil
    // daripada pokok pinjaman lama yang harus dimigrasikan.
    const kasSebelum = await saldoGl(testDb, ACC.kas);
    const bankSebelum = await saldoGl(testDb, ACC.bank);

    const hasil = await jalankanMigrasiPinjaman(
      testDb as never,
      [
        baris({ baris: 2, nomorPinjamanAsli: 'LAMA-001', sisaPokok: 500_000_000, jumlahPinjamanAsli: 800_000_000 }),
        baris({ baris: 3, kodeAnggota: 'A2', nomorPinjamanAsli: 'LAMA-002', sisaPokok: 300_000_000, jumlahPinjamanAsli: 400_000_000 }),
      ],
      opsi()
    );

    expect(hasil.berhasil).toHaveLength(2);
    expect(hasil.totalSisaPokok).toBe(800_000_000);

    // KAS & BANK TIDAK BERGERAK SATU RUPIAH PUN.
    expect(await saldoGl(testDb, ACC.kas)).toBe(kasSebelum);
    expect(await saldoGl(testDb, ACC.bank)).toBe(bankSebelum);
  });

  test('migrasi TIDAK membuat jurnal apa pun', async () => {
    const jurnalSebelum = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    await jalankanMigrasiPinjaman(testDb as never, [baris()], opsi());
    const jurnalSesudah = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(Number(jurnalSesudah?.n)).toBe(Number(jurnalSebelum?.n));

    // Dan buku besar tetap seimbang (karena memang tidak disentuh).
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  test('tidak ada baris pembayaran angsuran yang dikarang', async () => {
    await jalankanMigrasiPinjaman(testDb as never, [baris({ angsuranTersisa: 12 })], opsi());
    const bayar = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM angsuran_pembayaran`
    );
    expect(Number(bayar?.n)).toBe(0);
  });

  test('sisa pokok & jadwal tersimpan benar, dan pinjaman ditandai hasil migrasi', async () => {
    await jalankanMigrasiPinjaman(
      testDb as never,
      [baris({ sisaPokok: 12_000_000, angsuranTersisa: 12, persentaseJasa: 1 })],
      opsi()
    );

    const p = await testDb.getFirstAsync<{
      id: string;
      nomor_pinjaman: string;
      status: string;
      keterangan: string;
      tenor: number;
      tanggal: string;
    }>(`SELECT id, nomor_pinjaman, status, keterangan, tenor, tanggal FROM pinjaman`);
    expect(p?.nomor_pinjaman).toBe('LAMA-001');
    expect(p?.status).toBe('AKTIF');
    // Tanggal akad HISTORIS dipertahankan, bukan diganti tanggal import.
    expect(p?.tanggal).toBe('2024-06-01');
    expect(adalahPinjamanMigrasi(p?.keterangan)).toBe(true);
    expect(p?.keterangan).toContain(PENANDA_MIGRASI);
    // Penanda menjelaskan bahwa kas tidak dipakai.
    expect(p?.keterangan).toMatch(/tidak dicairkan lewat kas/i);

    const jadwal = await testDb.getAllAsync<{ pokok: number; jasa: number; status: string }>(
      `SELECT pokok, jasa, status FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran`,
      p!.id
    );
    expect(jadwal).toHaveLength(12);
    expect(jadwal.reduce((t, j) => t + j.pokok, 0)).toBe(12_000_000);
    // DIPERBAIKI RC-S105 — jasa FLAT dihitung dari pokok AKAD dan sama
    // tiap periode: 1% x 20.000.000 = 200.000. Nilai lama (10.000)
    // adalah hasil rumus keliru "sisa pokok x persen, dibagi tenor",
    // yaitu 20 kali lebih kecil.
    expect(jadwal[0].jasa).toBe(200_000);
    expect(jadwal.every((j) => j.jasa === 200_000)).toBe(true);
    expect(jadwal.every((j) => j.status === 'BELUM_BAYAR')).toBe(true);
  });

  test('tunggakan tersimpan sebagai jadwal TERLAMBAT — kolektibilitas terbaca sejak awal', async () => {
    await jalankanMigrasiPinjaman(
      testDb as never,
      [baris({ sisaPokok: 6_000_000, angsuranTersisa: 6, tunggakanPokok: 2_000_000 })],
      opsi()
    );
    const terlambat = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string }>(
      `SELECT tanggal_jatuh_tempo FROM angsuran_jadwal WHERE status = 'TERLAMBAT'`
    );
    expect(terlambat).toHaveLength(2);
    expect(terlambat.every((j) => j.tanggal_jatuh_tempo < CUTOFF)).toBe(true);
  });

  test('status MACET dipertahankan apa adanya', async () => {
    await jalankanMigrasiPinjaman(testDb as never, [baris({ status: 'MACET' })], opsi());
    const p = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM pinjaman`);
    expect(p?.status).toBe('MACET');
  });
});

// ===========================================================================
// D. IMPORT ULANG & PARSIAL
// ===========================================================================

describe('RC-S102 §D — import ulang & keutuhan transaksi', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
    await seedAnggota(testDb, ANG.a2, 'A-002', 'Sari');
  });

  test('migrasi ulang nomor yang SAMA dilewati — data lama TIDAK diubah', async () => {
    await jalankanMigrasiPinjaman(testDb as never, [baris({ sisaPokok: 12_000_000 })], opsi());

    // Percobaan kedua dengan nomor sama tapi sisa pokok berbeda (tetap
    // sah: <= pokok akad, supaya yang diuji benar-benar penjaga duplikasi
    // dan bukan validasi nilai).
    const kedua = await jalankanMigrasiPinjaman(
      testDb as never,
      [baris({ sisaPokok: 15_000_000 })],
      opsi()
    );
    expect(kedua.berhasil).toHaveLength(0);
    expect(kedua.dilewati).toHaveLength(1);
    expect(kedua.dilewati[0].pesan).toMatch(/SUDAH pernah dimigrasikan/);

    // Hanya SATU pinjaman, dan nilainya yang PERTAMA — tidak ditimpa.
    const semua = await testDb.getAllAsync<{ nomor_pinjaman: string }>(`SELECT nomor_pinjaman FROM pinjaman`);
    expect(semua).toHaveLength(1);
    const totalPokok = await testDb.getFirstAsync<{ t: number }>(
      `SELECT COALESCE(SUM(pokok),0) AS t FROM angsuran_jadwal`
    );
    expect(Number(totalPokok?.t)).toBe(12_000_000);
  });

  test('nomor yang sudah dipakai pinjaman NON-migrasi ditolak dengan sebab berbeda', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor,
                             metode_jasa, persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif,
                             tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'BULAN','FLAT',1,'TIDAK_ADA',0,0,?,'AKTIF',?,?,?)`,
      'pj-normal',
      'LAMA-001',
      ANG.a2,
      '2026-06-01',
      5_000_000,
      6,
      '2026-12-01',
      USER_ID,
      now,
      now
    );

    const hasil = await jalankanMigrasiPinjaman(testDb as never, [baris()], opsi());
    expect(hasil.berhasil).toHaveLength(0);
    expect(hasil.dilewati[0].pesan).toMatch(/bukan hasil migrasi/);
  });

  test('satu baris tidak sah membatalkan SELURUH migrasi — tidak ada import parsial', async () => {
    await expect(
      jalankanMigrasiPinjaman(
        testDb as never,
        [
          baris({ baris: 2, nomorPinjamanAsli: 'OK-1' }),
          baris({ baris: 3, nomorPinjamanAsli: 'RUSAK', sisaPokok: 0 }),
        ],
        opsi()
      )
    ).rejects.toThrow(ValidasiMigrasiGagalError);

    // Baris yang sah pun TIDAK ditulis.
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM pinjaman`);
    expect(Number(n?.n)).toBe(0);
  });

  test('anggota tidak ditemukan membatalkan seluruhnya (rollback), bukan sebagian', async () => {
    await expect(
      jalankanMigrasiPinjaman(
        testDb as never,
        [
          baris({ baris: 2, nomorPinjamanAsli: 'OK-1' }),
          baris({ baris: 3, nomorPinjamanAsli: 'OK-2', kodeAnggota: 'TIDAK-ADA' }),
        ],
        opsi()
      )
    ).rejects.toThrow(/tidak ditemukan/);

    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM pinjaman`);
    expect(Number(n?.n)).toBe(0);
  });

  test('pratinjau TIDAK menulis apa pun', async () => {
    const pra = await pratinjauMigrasiPinjaman(testDb as never, [baris()], { tanggalCutOff: CUTOFF });
    expect(pra.galat).toEqual([]);
    expect(pra.totalSisaPokok).toBe(12_000_000);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM pinjaman`);
    expect(Number(n?.n)).toBe(0);
  });
});

// ===========================================================================
// E. REKONSILIASI KE SALDO AWAL BUKU BESAR
// ===========================================================================

describe('RC-S102 §E — rekonsiliasi buku pembantu vs saldo awal buku besar', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
  });

  async function isiSaldoAwal(accountId: string, saldo: number) {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      `sa-${accountId}`,
      accountId,
      CUTOFF,
      saldo,
      USER_ID,
      now,
      now
    );
  }

  test('saldo awal belum diisi -> dilaporkan sebagai langkah yang belum dikerjakan, bukan selisih', async () => {
    const hasil = await jalankanMigrasiPinjaman(testDb as never, [baris({ sisaPokok: 12_000_000 })], opsi());
    expect(hasil.rekonsiliasi.saldoAwalPiutangPokok).toBeNull();
    expect(hasil.rekonsiliasi.selisihPokok).toBeNull();
    expect(hasil.rekonsiliasi.cocok).toBe(false);
    // Pesannya memberi angka yang harus diisi, bukan hanya "tidak cocok".
    expect(hasil.rekonsiliasi.pesan[0]).toContain('12000000');
    expect(hasil.rekonsiliasi.pesan[0]).toMatch(/Saldo Awal Akun/);
  });

  test('saldo awal cocok -> rekonsiliasi bersih', async () => {
    await isiSaldoAwal(ACC.piutangPokok, 12_000_000);
    const hasil = await jalankanMigrasiPinjaman(testDb as never, [baris({ sisaPokok: 12_000_000 })], opsi());
    expect(hasil.rekonsiliasi.saldoAwalPiutangPokok).toBe(12_000_000);
    expect(hasil.rekonsiliasi.selisihPokok).toBe(0);
    expect(hasil.rekonsiliasi.cocok).toBe(true);
    expect(hasil.rekonsiliasi.pesan).toEqual([]);
  });

  test('saldo awal berbeda -> selisih dilaporkan dengan kedua angkanya', async () => {
    await isiSaldoAwal(ACC.piutangPokok, 10_000_000);
    const hasil = await jalankanMigrasiPinjaman(testDb as never, [baris({ sisaPokok: 12_000_000 })], opsi());
    expect(hasil.rekonsiliasi.selisihPokok).toBe(2_000_000);
    expect(hasil.rekonsiliasi.cocok).toBe(false);
    expect(hasil.rekonsiliasi.pesan[0]).toContain('12000000');
    expect(hasil.rekonsiliasi.pesan[0]).toContain('10000000');
  });

  test('piutang jasa hanya direkonsiliasi bila baris migrasi melaporkannya', () => {
    const tanpaJasa = rekonsiliasiPiutang({
      totalSisaPokokBukuPembantu: 100,
      saldoAwalPiutangPokok: 100,
      totalPiutangJasaBukuPembantu: 0,
      saldoAwalPiutangJasa: null,
    });
    // Piutang jasa 0 & saldo awalnya belum diisi BUKAN masalah.
    expect(tanpaJasa.cocok).toBe(true);

    const denganJasa = rekonsiliasiPiutang({
      totalSisaPokokBukuPembantu: 100,
      saldoAwalPiutangPokok: 100,
      totalPiutangJasaBukuPembantu: 50,
      saldoAwalPiutangJasa: null,
    });
    expect(denganJasa.cocok).toBe(false);
    expect(denganJasa.pesan.join(' ')).toMatch(/Piutang Jasa/);
  });
});

// ===========================================================================
// F. PENCAIRAN NORMAL TETAP DIJAGA
// ===========================================================================

describe('RC-S102 §F — pencairan pinjaman BARU tetap melewati seluruh pemeriksaan', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
  });

  test('pinjaman pada/setelah cut-off DITOLAK saat likuiditas tidak cukup', async () => {
    // Pinjaman jauh lebih besar daripada kas yang tersedia, berakad
    // SETELAH cut-off -> jalur pencairan normal -> harus ditolak.
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [
        ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'],
        ['A1', 'Budi Baru', '2026-01-02'],
      ],
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib'],
        ['A1', '2026-01-05', '100000', '50000'],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'],
        ['A1', '2026-06-01', '900000000', '12', 'BULAN', 'FLAT', '1', 'KAS'],
      ],
    });
    expect(ringkasan.siapDiimpor).toBe(true);

    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });

    // Pinjaman GAGAL — pemeriksaannya tidak dilonggarkan sedikit pun.
    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.gagal).toBe(1);
    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.berhasil).toBe(0);
    // Dan tidak lewat jalur migrasi.
    expect(hasil.migrasi).toBeNull();
    // Tidak ada pinjaman yang tertinggal separuh jadi.
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pinjaman WHERE status = 'AKTIF'`
    );
    expect(Number(n?.n)).toBe(0);
  });

  test('tanpa cut-off, perilaku import PERSIS seperti sebelumnya (semua lewat pencairan normal)', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [
        ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'],
        ['A1', 'Budi Lama', '2024-01-02'],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor'],
        ['A1', '2024-06-01', '900000000', '12'],
      ],
    });
    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      // tanggalCutOff sengaja TIDAK diisi
    });
    expect(hasil.migrasi).toBeNull();
    // Tetap ditolak seperti sebelum perubahan ini.
    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.gagal).toBe(1);
  });
});

// ===========================================================================
// G. LEWAT IMPORT DATA AWAL, DENGAN CUT-OFF
// ===========================================================================

describe('RC-S102 §G — import data awal dengan cut-off memakai jalur migrasi', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('pinjaman lama masuk lewat migrasi; kas tidak berkurang; jasa tidak diakui ulang', async () => {
    const kasSebelum = await saldoGl(testDb, ACC.kas);
    const pendapatanSebelum = await saldoGl(testDb, ACC.pendapatanJasa);

    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [
        ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'],
        ['A1', 'Budi Lama', '2024-01-02'],
      ],
      PINJAMAN: [
        [
          'Kode Anggota',
          'Tanggal Pencairan',
          'Jumlah Pinjaman',
          'Tenor',
          'Satuan Tenor',
          'Metode Jasa',
          'Jasa Persen',
          'Sumber Dana',
          'Nomor Pinjaman Lama',
          'Sisa Pokok',
          'Angsuran Tersisa',
          'Tunggakan Pokok',
        ],
        ['A1', '2024-06-01', '800000000', '24', 'BULAN', 'FLAT', '1', 'KAS', 'LAMA-777', '500000000', '10', '50000000'],
      ],
    });
    expect(ringkasan.siapDiimpor).toBe(true);

    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });

    expect(hasil.migrasi).not.toBeNull();
    expect(hasil.migrasi!.berhasil).toHaveLength(1);
    expect(hasil.migrasi!.totalSisaPokok).toBe(500_000_000);
    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.berhasil).toBe(1);

    // Kas TIDAK berkurang, pendapatan jasa TIDAK diakui ulang.
    expect(await saldoGl(testDb, ACC.kas)).toBe(kasSebelum);
    expect(await saldoGl(testDb, ACC.pendapatanJasa)).toBe(pendapatanSebelum);

    // Buku besar tetap seimbang.
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);

    // Jadwal sisa terbentuk & tunggakannya tercatat.
    const jadwal = await testDb.getAllAsync<{ pokok: number; status: string }>(
      `SELECT pokok, status FROM angsuran_jadwal ORDER BY nomor_angsuran`
    );
    expect(jadwal).toHaveLength(10);
    expect(jadwal.reduce((t, j) => t + j.pokok, 0)).toBe(500_000_000);
    expect(jadwal.filter((j) => j.status === 'TERLAMBAT')).toHaveLength(1);
  });

  /**
   * DIUBAH RC-S103 — PERUBAHAN PERILAKU YANG DISENGAJA.
   *
   * Versi RC-S102 dari test ini menuntut berkas TANPA kolom migrasi
   * GAGAL seluruhnya. Tuntutan itu ternyata salah sasaran: hampir semua
   * berkas koperasi nyata tidak memuat kolom-kolom itu, sehingga aturan
   * tersebut membuat jalur migrasi praktis tidak bisa dipakai kecuali
   * berkasnya disusun ulang manual lebih dulu — pekerjaan yang justru
   * menjadi sumber salah rumus dan salah pembulatan.
   *
   * RC-S103 menurunkan ketiga kolom itu dari kolom yang memang sudah
   * wajib ada (lihat `TurunanMigrasiPinjaman`), jadi baris seperti ini
   * sekarang BERHASIL. Yang tetap dijaga adalah hal yang sesungguhnya
   * penting: baris yang datanya memang TIDAK MASUK AKAL tetap gagal
   * tanpa menulis apa pun — dibuktikan oleh test berikutnya.
   */
  test('pinjaman lama tanpa kolom migrasi sekarang BERHASIL lewat kolom turunan', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [
        ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'],
        ['A1', 'Budi Lama', '2024-01-02'],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor'],
        ['A1', '2024-06-01', '10000000', '12'],
      ],
    });

    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });

    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.gagal).toBe(0);
    // Belum ada angsuran dibayar -> sisa pokok = pokok penuh.
    expect(hasil.migrasi!.totalSisaPokok).toBe(10_000_000);
    // Keterbatasannya DILAPORKAN, tidak disembunyikan.
    expect(hasil.keterbatasanTurunan.length).toBeGreaterThan(0);
  });

  test('sisa pokok yang TIDAK MASUK AKAL ditolak sudah di PRATINJAU, jadi tidak pernah sampai ke database', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [
        ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'],
        ['A1', 'Budi Lama', '2024-01-02'],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Sisa Pokok', 'Angsuran Tersisa'],
        // Sisa pokok LEBIH BESAR daripada pokok akadnya — mustahil.
        ['A1', '2024-06-01', '10000000', '12', '99000000', '6'],
      ],
    });

    // Penjaganya ada di lapis TERDEPAN: baris ini tidak lolos pratinjau,
    // jadi tombol Import tidak bisa ditekan sama sekali. Ini yang penting
    // dijaga — bukan bahwa ia gagal di eksekutor, karena ia tidak sampai
    // ke sana.
    expect(ringkasan.siapDiimpor).toBe(false);
    expect(ringkasan.hasil.pinjaman.baris).toHaveLength(0);
    expect(ringkasan.hasil.pinjaman.galat.map((g) => g.pesan).join(' ')).toMatch(/Sisa Pokok/i);

    // Dan bila eksekutor tetap dijalankan atas pratinjau itu, tidak ada
    // pinjaman yang tertulis — yang diimpor hanyalah baris yang lolos.
    const hasil = await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      dbRiwayat: testDb as never,
      dbMigrasi: testDb as never,
      tanggalCutOff: CUTOFF,
    });
    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.berhasil).toBe(0);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM pinjaman`);
    expect(Number(n?.n)).toBe(0);
  });
});

// ===========================================================================
// H. PENJAGA STRUKTURAL
// ===========================================================================

describe('RC-S102 §H — jalur migrasi tidak boleh menjurnal atau melonggarkan pencairan', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const baca = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  test('eksekutor migrasi TIDAK mengimpor createJournal / cairkanPinjaman / bayarAngsuran', () => {
    const src = baca('src/import/EksekusiMigrasiPinjaman.ts');
    // Diperiksa PERNYATAAN IMPORT & PEMANGGILANNYA, bukan sekadar teks:
    // nama-nama itu memang disebut di docblock untuk menjelaskan apa yang
    // sengaja TIDAK dilakukan, dan versi pertama test ini gagal justru
    // karena mencocokkan komentar tersebut.
    const barisImport = src.split('\n').filter((b) => /^import /.test(b)).join('\n');
    for (const nama of ['createJournal', 'cairkanPinjaman', 'bayarAngsuran', 'checkLiquiditasPencairan']) {
      expect(barisImport).not.toContain(nama);
      // Tidak ada pemanggilan `nama(` di mana pun.
      expect(src).not.toMatch(new RegExp(`(?<![\\w.])${nama}\\s*\\(`));
    }
  });

  test('eksekutor migrasi TIDAK menulis ke saldo_awal_akun — hanya membaca', () => {
    const src = baca('src/import/EksekusiMigrasiPinjaman.ts');
    expect(src).toMatch(/SELECT saldo FROM saldo_awal_akun/);
    expect(src).not.toMatch(/INSERT INTO saldo_awal_akun|UPDATE saldo_awal_akun/);
  });

  test('tidak ada akun Cadangan Umum yang dipakai sebagai lawan migrasi', () => {
    for (const p of ['src/import/EksekusiMigrasiPinjaman.ts', 'src/import/MigrasiPinjamanPlan.ts']) {
      const src = baca(p);
      expect(src).not.toMatch(/CADANGAN_UMUM|3-2000/);
    }
  });

  test('cairkanPinjaman TETAP memeriksa likuiditas & saldo rekening', () => {
    const src = baca('src/services/PinjamanService.ts');
    expect(src).toMatch(/checkLiquiditasPencairan\(db, \{/);
    expect(src).toMatch(/checkSaldoAkunCukup\(db, \{/);
  });

  test('migrasi dijalankan dalam SATU transaksi', () => {
    const src = baca('src/import/EksekusiMigrasiPinjaman.ts');
    expect(src).toMatch(/await db\.withTransactionAsync\(/);
  });

  test('tanpa perubahan skema untuk fitur ini', () => {
    for (const p of ['src/import/EksekusiMigrasiPinjaman.ts', 'src/import/MigrasiPinjamanPlan.ts']) {
      expect(baca(p)).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
    }
    expect(baca('src/database/schema.ts')).toMatch(/export const SCHEMA_VERSION = 81;/); // DIPERBARUI v81 (RC-S133.6.2: sidik import & koreksi_transaksi, aditif; migrasi milik RC-S133.6.2). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel /export const SCHEMA_VERSION = 78;/); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 — migrasi milik fitur bunga harian sukarela. DIPERBARUI v77 (Poin 5/6/10) — migrasi milik patch 19 poin, bukan fitur ini.
  });
});
