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

import { buatFixtureHistoris, ACC, USER_ID, saldoGl, totalDebitKredit, jejakJurnal } from './historicalFixture';
import { beliAset } from '@/services/AsetService';
import {
  jalankanPenyusutanCatchUp,
  hitungPenyusutanBulanan,
  getPeriodePenyusutanYangSeharusnyaDiproses,
  prosesPenyusutanAset,
  getTotalPenyusutan,
} from '@/services/PenyusutanService';
import { getPosisiKeuangan, getLabaRugi } from '@/reports/FinancialReports';

/**
 * ============================================================
 * §E/§F/§AO — PEMBELIAN ASET & PENYUSUTAN BACKDATED
 * ============================================================
 *
 * Skenario yang diminta audit, apa adanya:
 *   tanggal transaksi  = 2026-06-12
 *   tanggal perolehan  = 2026-06-12
 *   nilai              = Rp12.000.000
 *   dibayar tunai (Kas) pada 2026-06-12
 *   DIINPUT SETELAH tanggal transaksi tersebut (backdated)
 *
 * KEBIJAKAN YANG DIPAKAI DIAMBIL DARI SOURCE, BUKAN DIKARANG:
 *   - kategori: "Kelompok 1 / Mesin kantor" -> masa manfaat 48 bulan
 *     (src/config/defaultAsetKlasifikasi.ts)
 *   - metode: GARIS LURUS, (perolehan - residu) / masa manfaat bulan
 *     (PenyusutanService.hitungPenyusutanBulanan)
 *   - konvensi mulai: BULAN PEROLEHAN DIHITUNG PENUH, tidak ada
 *     proporsi harian (PenyusutanService, blok "KEBIJAKAN PERIODE
 *     PENYUSUTAN" aturan 1) -> 2026-06 disusutkan penuh meski aset
 *     diperoleh tanggal 12
 *   - jatuh tempo pengakuan: periode baru diakui setelah bulannya
 *     BERAKHIR (aturan 2)
 *
 * Nilai bulanan yang MENGIKUTI kebijakan itu: 12.000.000 / 48 = 250.000.
 */

const NILAI = 12_000_000;
const MASA_MANFAAT = 48;
const RESIDU = 0;
const TANGGAL_TRANSAKSI = '2026-06-12';
const TANGGAL_PEROLEHAN = '2026-06-12';
/** "Hari ini" saat data backdated ini diinput — jauh setelah transaksinya. */
const TANGGAL_INPUT_AKTUAL = '2026-12-31';

async function seedKlasifikasi(db: TestDb) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO aset_klasifikasi (id, kelompok, sub_kelompok, masa_manfaat_bulan_default, aktif, created_at, updated_at)
     VALUES ('kl-1','Kelompok 1','Mesin kantor',48,1,?,?)`,
    now, now
  );
}

describe('§E — pembelian aset backdated (12 Juni 2026, Rp12.000.000)', () => {
  let asetId: string;
  let journalId: string;
  let sebelum: { jurnal: number; entry: number; aset: number; kas: number; asetTetap: number };

  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
    await seedKlasifikasi(testDb);

    sebelum = {
      jurnal: (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n,
      entry: (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal_entry`))!.n,
      aset: (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM aset_tetap`))!.n,
      kas: await saldoGl(testDb, ACC.kas),
      asetTetap: await saldoGl(testDb, ACC.asetTetap),
    };

    const hasil = await beliAset({
      namaAset: 'Mesin Kantor Historis',
      kelompokAset: 'Kelompok 1',
      subKelompokAset: 'Mesin kantor',
      nilaiPerolehan: NILAI,
      nilaiResidu: RESIDU,
      masaManfaatBulan: MASA_MANFAAT,
      tanggal: TANGGAL_TRANSAKSI,
      tanggalPerolehan: TANGGAL_PEROLEHAN,
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    asetId = hasil.id;
    journalId = hasil.journalId;
  });

  it('menambah TEPAT satu jurnal dengan dua baris — tidak duplikat', async () => {
    const jurnal = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
    const entry = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal_entry`))!.n;
    const aset = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM aset_tetap`))!.n;
    expect(jurnal - sebelum.jurnal).toBe(1);
    expect(entry - sebelum.entry).toBe(2);
    expect(aset - sebelum.aset).toBe(1);
  });

  it('jurnal: Dr Aset Tetap / Cr Kas — BUKAN beban, BUKAN pendapatan', async () => {
    const jejak = await jejakJurnal(testDb, journalId);
    expect(jejak).toHaveLength(2);
    const debit = jejak.find((r) => r.debit > 0)!;
    const kredit = jejak.find((r) => r.kredit > 0)!;
    expect(debit.kode).toBe('1-1500'); // Aset Tetap
    expect(debit.debit).toBe(NILAI);
    expect(kredit.kode).toBe('1-1000'); // Kas
    expect(kredit.kredit).toBe(NILAI);
    // Tidak ada satu pun kaki pada akun beban (5-x) atau pendapatan (4-x).
    expect(jejak.some((r) => r.kode.startsWith('5-') || r.kode.startsWith('4-'))).toBe(false);
  });

  it('tanggal jurnal = tanggal transaksi, tanggal register = tanggal perolehan', async () => {
    const j = await testDb.getFirstAsync<{ tanggal: string; sumber_transaksi: string }>(
      `SELECT tanggal, sumber_transaksi FROM journal WHERE id = ?`, journalId
    );
    expect(j!.tanggal).toBe(TANGGAL_TRANSAKSI);
    expect(j!.sumber_transaksi).toBe('ASET_TETAP');
    const a = await testDb.getFirstAsync<{ tanggal_perolehan: string; journal_id: string }>(
      `SELECT tanggal_perolehan, journal_id FROM aset_tetap WHERE id = ?`, asetId
    );
    expect(a!.tanggal_perolehan).toBe(TANGGAL_PEROLEHAN);
    expect(a!.journal_id).toBe(journalId); // tidak ada aset tanpa jurnal
  });

  it('kas berkurang & aset bruto bertambah tepat sebesar nilai perolehan', async () => {
    expect(await saldoGl(testDb, ACC.kas)).toBe(sebelum.kas - NILAI);
    expect(await saldoGl(testDb, ACC.asetTetap)).toBe(sebelum.asetTetap + NILAI);
  });

  it('laporan periode terdampak: aset naik, LABA RUGI TIDAK terpengaruh', async () => {
    const lrJuni = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lrJuni.totalBeban).toBe(0); // pembelian aset bukan beban
    const posisi = await getPosisiKeuangan(testDb as any, '2026-06-30');
    expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);
  });

  it('periode SEBELUM transaksi tidak berubah (2026-05-31)', async () => {
    expect(await saldoGl(testDb, ACC.asetTetap, '2026-05-31')).toBe(0);
    expect(await saldoGl(testDb, ACC.kas, '2026-05-31')).toBe(sebelum.kas);
  });

  it('menolak tanggal perolehan SETELAH tanggal transaksi', async () => {
    await expect(
      beliAset({
        namaAset: 'Aset Tidak Sah',
        nilaiPerolehan: 1_000_000,
        masaManfaatBulan: 12,
        tanggal: '2026-06-12',
        tanggalPerolehan: '2026-07-01',
        metodePembayaran: 'TUNAI',
        sumberDana: 'KAS',
        createdBy: USER_ID,
      })
    ).rejects.toThrow(/tidak boleh setelah tanggal transaksi/);
  });

  // ============================================================
  // §F/§AO — TABEL PENYUSUTAN PER PERIODE
  // ============================================================
  describe('§F/§AO — penyusutan backdated per periode', () => {
    const BULANAN = 250_000; // 12.000.000 / 48, mengikuti hitungPenyusutanBulanan
    const PERIODE_2026 = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];

    beforeAll(async () => {
      // Catch-up dijalankan SETELAH aset backdated masuk — persis
      // seperti aplikasi dibuka pada 31 Desember 2026.
      await jalankanPenyusutanCatchUp(USER_ID, TANGGAL_INPUT_AKTUAL);
    });

    it('nilai bulanan mengikuti rumus garis lurus di source', () => {
      expect(hitungPenyusutanBulanan(NILAI, RESIDU, MASA_MANFAAT)).toBe(BULANAN);
    });

    it('2026-05 (SEBELUM perolehan) TIDAK punya penyusutan sama sekali', async () => {
      const row = await testDb.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) n FROM aset_penyusutan WHERE aset_id = ? AND periode = '2026-05'`, asetId
      );
      expect(row!.n).toBe(0);
      expect(await saldoGl(testDb, ACC.akumulasi, '2026-05-31')).toBe(0);
      // Ditolak juga bila dipaksa lewat jalur manual.
      await expect(
        prosesPenyusutanAset({ asetId, periode: '2026-05', createdBy: USER_ID, tanggalLaporan: TANGGAL_INPUT_AKTUAL })
      ).rejects.toThrow(/sebelum tanggal perolehan/);
    });

    it.each(PERIODE_2026)('periode %s: expected 250.000, selisih 0, tidak duplikat', async (periode) => {
      const rows = await testDb.getAllAsync<{ nilai_penyusutan: number; tanggal: string }>(
        `SELECT nilai_penyusutan, tanggal FROM aset_penyusutan WHERE aset_id = ? AND periode = ?`,
        asetId, periode
      );
      expect(rows).toHaveLength(1); // no duplicate depreciation
      expect(rows[0].nilai_penyusutan).toBe(BULANAN);
      // Jurnal penyusutan bertanggal AKHIR periode, bukan tanggal input.
      expect(rows[0].tanggal.slice(0, 7)).toBe(periode);
    });

    it('daftar periode yang seharusnya diproses = daftar yang benar-benar tercatat', async () => {
      const seharusnya = getPeriodePenyusutanYangSeharusnyaDiproses(
        TANGGAL_PEROLEHAN, TANGGAL_INPUT_AKTUAL, MASA_MANFAAT
      );
      const tercatat = (
        await testDb.getAllAsync<{ periode: string }>(
          `SELECT periode FROM aset_penyusutan WHERE aset_id = ? ORDER BY periode`, asetId
        )
      ).map((r) => r.periode);
      expect(seharusnya).toEqual(PERIODE_2026);
      expect(tercatat).toEqual(PERIODE_2026);
    });

    it('total penyusutan 2026 = 1.750.000 dan nilai buku 31-12-2026 = 10.250.000', async () => {
      const total = await getTotalPenyusutan(testDb as any, asetId);
      expect(total).toBe(7 * BULANAN);
      expect(total).toBe(1_750_000);
      const akumulasiGl = -(await saldoGl(testDb, ACC.akumulasi, '2026-12-31'));
      expect(akumulasiGl).toBe(1_750_000); // subledger = GL
      const nilaiBuku = NILAI - akumulasiGl;
      expect(nilaiBuku).toBe(10_250_000);
      expect(nilaiBuku).toBeGreaterThanOrEqual(RESIDU); // book value >= 0
    });

    it('jurnal penyusutan: Dr Beban Penyusutan / Cr Akumulasi, tiap periode satu jurnal', async () => {
      const rows = await testDb.getAllAsync<{ journal_id: string; periode: string }>(
        `SELECT journal_id, periode FROM aset_penyusutan WHERE aset_id = ? ORDER BY periode`, asetId
      );
      expect(new Set(rows.map((r) => r.journal_id)).size).toBe(rows.length); // tidak berbagi jurnal
      for (const r of rows) {
        const jejak = await jejakJurnal(testDb, r.journal_id);
        expect(jejak.find((x) => x.debit > 0)!.kode).toBe('5-1300');
        expect(jejak.find((x) => x.kredit > 0)!.kode).toBe('1-1510');
        expect(jejak.every((x) => x.tanggal.slice(0, 7) === r.periode)).toBe(true);
      }
    });

    it('akumulasi TIDAK PERNAH melampaui dasar penyusutan sampai akhir masa manfaat', async () => {
      // Jalankan catch-up sampai jauh setelah masa manfaat berakhir
      // (48 bulan sejak 2026-06 -> berakhir 2030-05).
      await jalankanPenyusutanCatchUp(USER_ID, '2031-12-31');
      const total = await getTotalPenyusutan(testDb as any, asetId);
      expect(total).toBe(NILAI - RESIDU);
      expect(total).toBeLessThanOrEqual(NILAI - RESIDU);
      const jumlahPeriode = (
        await testDb.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) n FROM aset_penyusutan WHERE aset_id = ?`, asetId
        )
      )!.n;
      expect(jumlahPeriode).toBe(MASA_MANFAAT); // tidak melewati masa manfaat
      expect(NILAI - total).toBeGreaterThanOrEqual(0); // nilai buku tidak negatif
    });

    it('catch-up diulang TIDAK menghasilkan penyusutan kedua (idempoten)', async () => {
      const sebelumN = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM aset_penyusutan`))!.n;
      const sebelumJ = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
      await jalankanPenyusutanCatchUp(USER_ID, '2031-12-31');
      await jalankanPenyusutanCatchUp(USER_ID, '2031-12-31');
      expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM aset_penyusutan`))!.n).toBe(sebelumN);
      expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n).toBe(sebelumJ);
    });

    it('debit = kredit setelah seluruh rangkaian', async () => {
      const { debit, kredit } = await totalDebitKredit(testDb);
      expect(debit).toBe(kredit);
    });
  });
});
