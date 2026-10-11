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

import {
  buatFixtureHistoris, ACC, ANGGOTA_ID, ANGGOTA_2_ID, USER_ID, BANK_ID,
  saldoGl, totalDebitKredit, jejakJurnal,
} from './historicalFixture';
import { catatPemasukan, catatPengeluaran, transferAntarRekening } from '@/services/KasBankService';
import { setorSimpanan, tarikSimpananSukarela, getSaldoSimpanan } from '@/services/SimpananService';
import { setorSimpananBerjangka, getSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { terimaUtang, bayarUtang, listUtang } from '@/services/UtangService';
import { beliAset } from '@/services/AsetService';
import { getPosisiKeuangan, getLabaRugi, getArusKas, getLedger } from '@/reports/FinancialReports';
import { hitungTotalBungaKontrak, buatJadwalBungaSimpananBerjangka } from '@/accounting/SimpananBerjangkaBunga';
import { toTanggalLokal } from '@/utils/tanggal';

/**
 * ============================================================
 * §H/§I/§J/§X/§Y/§Z/§AB/§AC/§AD/§AJ/§AK — TRANSAKSI BACKDATED
 * ============================================================
 *
 * Semua transaksi di suite ini dicatat dengan TANGGAL TRANSAKSI
 * 2026-06-12 tetapi dimasukkan belakangan (backdated). Yang diperiksa
 * bukan cuma "tidak error", melainkan: tanggal jurnal, periode yang
 * terdampak, periode yang TIDAK boleh terdampak, subledger vs GL, dan
 * konsistensi laporan.
 */

const T = '2026-06-12';

describe('§H — kas & bank backdated', () => {
  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('penerimaan & pengeluaran kas 12 Juni: jurnal bertanggal transaksi, bukan tanggal input', async () => {
    const masuk = await catatPemasukan({
      jenis: 'KAS', tanggal: T, nominal: 5_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'penerimaan kas historis', createdBy: USER_ID,
    });
    const keluar = await catatPengeluaran({
      jenis: 'KAS', tanggal: T, nominal: 1_500_000,
      akunLawanId: ACC.bebanLain, keterangan: 'pengeluaran kas historis', createdBy: USER_ID,
    });

    for (const id of [masuk.journalId, keluar.journalId]) {
      const j = await testDb.getFirstAsync<{ tanggal: string; period_id: string }>(
        `SELECT tanggal, period_id FROM journal WHERE id = ?`, id
      );
      expect(j!.tanggal).toBe(T);
      expect(j!.period_id).toBe('p2026'); // masuk ke tahun buku yang benar
    }

    const jejakMasuk = await jejakJurnal(testDb, masuk.journalId);
    expect(jejakMasuk.find((r) => r.debit > 0)!.kode).toBe('1-1000');
    expect(jejakMasuk.find((r) => r.kredit > 0)!.kode).toBe('4-2000');
  });

  it('penerimaan & pengeluaran bank 12 Juni tercermin di saldo bank & arus kas', async () => {
    const sebelumBank = await saldoGl(testDb, ACC.bank, '2026-06-30');
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: T, nominal: 9_000_000,
      akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
    });
    await catatPengeluaran({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: T, nominal: 2_000_000,
      akunLawanId: ACC.bebanLain, createdBy: USER_ID,
    });
    expect(await saldoGl(testDb, ACC.bank, '2026-06-30')).toBe(sebelumBank + 7_000_000);

    const arus = await getArusKas(testDb as any, '2026-06-01', '2026-06-30');
    expect(arus.kasAkhirDihitung).toBe(arus.kasAkhirAktual);
    expect(arus.terekonsiliasi).toBe(true);
  });

  it('transfer kas <-> bank backdated: SATU jurnal, bukan pendapatan/beban', async () => {
    const { journalId } = await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: T, nominal: 10_000_000, keterangan: 'setor ke bank historis', createdBy: USER_ID,
    });
    const jejak = await jejakJurnal(testDb, journalId);
    expect(jejak).toHaveLength(2);
    expect(jejak.every((r) => r.kode.startsWith('1-'))).toBe(true); // hanya akun aset
    expect(jejak.every((r) => r.tanggal === T)).toBe(true);

    const { journalId: balik } = await transferAntarRekening({
      sumberJenis: 'BANK', sumberBankAccountId: BANK_ID, tujuanJenis: 'KAS',
      tanggal: T, nominal: 4_000_000, keterangan: 'tarik tunai historis', createdBy: USER_ID,
    });
    const jejakBalik = await jejakJurnal(testDb, balik);
    expect(jejakBalik.some((r) => r.kode.startsWith('4-') || r.kode.startsWith('5-'))).toBe(false);

    // Transfer TIDAK mengubah total kas+bank gabungan.
    const lr = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lr.totalPendapatan).toBe(5_000_000 + 9_000_000);
    expect(lr.totalBeban).toBe(1_500_000 + 2_000_000);
  });

  it('§AK — semantik tanggal konsisten dari input sampai buku besar', async () => {
    const baris = await getLedger(testDb as any, ACC.kas, { tanggalMulai: T, tanggalSelesai: T });
    expect(baris.length).toBeGreaterThan(0);
    expect(baris.every((b) => b.tanggal === T)).toBe(true);
  });
});

describe('§I — simpanan anggota backdated', () => {
  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('pokok, wajib, sukarela & penarikan bertanggal historis konsisten subledger vs GL', async () => {
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: T, nominal: 500_000,
      sumberDana: 'KAS', createdBy: USER_ID,
    });
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: T, nominal: 100_000,
      periode: '2026-06', sumberDana: 'KAS', createdBy: USER_ID,
    });
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: T, nominal: 3_000_000,
      sumberDana: 'KAS', createdBy: USER_ID,
    });
    await tarikSimpananSukarela({
      anggotaId: ANGGOTA_ID, tanggal: T, nominal: 1_000_000,
      sumberDana: 'KAS', createdBy: USER_ID,
    });

    // Subledger anggota
    expect(await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'SUKARELA')).toBe(2_000_000);
    // GL: sukarela = LIABILITAS (saldo kredit -> negatif pada konvensi debit-kredit)
    expect(-(await saldoGl(testDb, ACC.simpananSukarela, '2026-06-30'))).toBe(2_000_000);
    expect(-(await saldoGl(testDb, ACC.simpananPokok, '2026-06-30'))).toBe(500_000);
    expect(-(await saldoGl(testDb, ACC.simpananWajib, '2026-06-30'))).toBe(100_000);

    // Pokok & wajib adalah EKUITAS, sukarela LIABILITAS — periksa lewat
    // laporan, bukan asumsi.
    const posisi = await getPosisiKeuangan(testDb as any, '2026-06-30');
    expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);

    // Simpanan bukan pendapatan.
    const lr = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lr.totalPendapatan).toBe(0);
  });

  it('periode SEBELUM tanggal transaksi tidak ikut berubah', async () => {
    expect(await saldoGl(testDb, ACC.simpananSukarela, '2026-06-11')).toBe(0);
    expect(await saldoGl(testDb, ACC.simpananPokok, '2026-05-31')).toBe(0);
  });
});

describe('§J — simpanan berjangka backdated & catch-up akrual', () => {
  let kontrakId: string;
  const POKOK = 12_000_000;
  const RATE = 6;
  const TENOR = 6;

  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
    const hasil = await setorSimpananBerjangka({
      anggotaId: ANGGOTA_2_ID, nominal: POKOK, tanggal: T, tenorBulan: TENOR,
      sukuBungaPerTahun: RATE, sumberDana: 'KAS', createdBy: USER_ID,
    });
    kontrakId = hasil.id;
  });

  it('kontrak menyimpan tanggal mulai & jatuh tempo dari TANGGAL TRANSAKSI historis', async () => {
    const k = await getSimpananBerjangka(kontrakId);
    expect(k!.tanggalMulai).toBe(T);
    expect(k!.tanggalJatuhTempo).toBe('2026-12-12');
    expect(k!.nominal).toBe(POKOK);
    expect(k!.status).toBe('AKTIF');
  });

  it('akrual hanya untuk periode yang BENAR-BENAR sudah earned', async () => {
    // Catch-up per 30 September: hanya periode kontrak yang tanggal
    // akhirnya <= 2026-09-30 yang boleh diakui.
    const jadwal = buatJadwalBungaSimpananBerjangka(POKOK, RATE, TENOR as 6, T);
    const earned = jadwal.filter((p) => p.tanggalAkhirPeriode <= '2026-09-30');
    const hasil = await prosesAkrualBungaKontrak(kontrakId, '2026-09-30', USER_ID);
    expect(hasil.periodeDiakui.length).toBe(earned.length);
    expect(hasil.periodeDiakui.length).toBeGreaterThan(0);
    expect(hasil.periodeDiakui.length).toBeLessThan(jadwal.length); // tidak mendahului waktu

    // Beban bunga = jumlah periode yang diakui, dan liabilitas bunga sama besar.
    const beban = await saldoGl(testDb, ACC.bebanBungaBerjangka, '2026-09-30');
    expect(beban).toBe(hasil.totalBungaTerakruKumulatif);
    expect(-(await saldoGl(testDb, ACC.utangBungaBerjangka, '2026-09-30'))).toBe(beban);
    // Pokok TIDAK bertambah oleh bunga.
    expect(-(await saldoGl(testDb, ACC.berjangka, '2026-09-30'))).toBe(POKOK);
  });

  it('catch-up diulang (dan catch-up ganda) tidak menggandakan akrual', async () => {
    const sebelumJ = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
    const sebelumB = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM simpanan_berjangka_bunga`))!.n;
    await prosesAkrualBungaKontrak(kontrakId, '2026-09-30', USER_ID);
    await prosesAkrualBungaKontrak(kontrakId, '2026-09-30', USER_ID);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n).toBe(sebelumJ);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM simpanan_berjangka_bunga`))!.n).toBe(sebelumB);
  });

  it('akrual sampai jatuh tempo = bunga kontraktual, tidak lebih', async () => {
    await prosesAkrualBungaKontrak(kontrakId, '2026-12-12', USER_ID);
    const k = await getSimpananBerjangka(kontrakId);
    expect(k!.bungaTerakru).toBe(hitungTotalBungaKontrak(POKOK, RATE, TENOR as 6));
  });
});

describe('§Y/§Z — beban & kewajiban backdated', () => {
  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('beban 12 Juni yang baru diinput masuk ke periode Juni, bukan periode input', async () => {
    const lrMeiSebelum = await getLabaRugi(testDb as any, '2026-05-01', '2026-05-31');
    await catatPengeluaran({
      jenis: 'KAS', tanggal: T, nominal: 800_000,
      akunLawanId: ACC.bebanLain, keterangan: 'beban historis', createdBy: USER_ID,
    });
    const lrJuni = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    const lrJuli = await getLabaRugi(testDb as any, '2026-07-01', '2026-07-31');
    const lrMeiSesudah = await getLabaRugi(testDb as any, '2026-05-01', '2026-05-31');

    expect(lrJuni.totalBeban).toBe(800_000);
    expect(lrJuli.totalBeban).toBe(0);      // periode setelahnya tidak terdampak
    expect(lrMeiSesudah).toEqual(lrMeiSebelum); // periode sebelumnya identik
  });

  it('utang diterima & dibayar dengan tanggal historis', async () => {
    await terimaUtang({
      namaPemberi: 'Bank Mitra', jenisPemberi: 'BANK', pokokPinjaman: 30_000_000,
      persenBunga: 0, jenisBunga: 'FLAT', tanggal: T,
      sumberDana: 'BANK', bankAccountId: BANK_ID, createdBy: USER_ID,
    });
    expect(-(await saldoGl(testDb, ACC.utangBank, '2026-06-30'))).toBe(30_000_000);
    // Penerimaan utang BUKAN pendapatan.
    const lr = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lr.totalPendapatan).toBe(0);

    const utang = (await listUtang()).find((u) => u.namaPemberi === 'Bank Mitra')!;
    await bayarUtang({
      utangId: utang.id, tanggal: '2026-06-20', pokok: 5_000_000, bunga: 0,
      sumberDana: 'BANK', bankAccountId: BANK_ID, createdBy: USER_ID,
    });
    expect(-(await saldoGl(testDb, ACC.utangBank, '2026-06-30'))).toBe(25_000_000);
    // Pembayaran pokok utang BUKAN beban.
    const lrSesudah = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lrSesudah.totalBeban).toBe(800_000); // hanya beban dari test sebelumnya
  });
});

describe('§AB — periode TERTUTUP: seluruh transaksi backdated ditolak', () => {
  let sebelum: { jurnal: number; entry: number; kas: number };

  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    sebelum = {
      jurnal: (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n,
      entry: (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal_entry`))!.n,
      kas: await saldoGl(testDb, ACC.kas),
    };
  });

  const kasus: [string, () => Promise<unknown>][] = [
    ['penerimaan kas', () => catatPemasukan({
      jenis: 'KAS', tanggal: T, nominal: 1_000_000, akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
    })],
    ['pengeluaran kas', () => catatPengeluaran({
      jenis: 'KAS', tanggal: T, nominal: 1_000_000, akunLawanId: ACC.bebanLain, createdBy: USER_ID,
    })],
    ['transfer kas -> bank', () => transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: T, nominal: 1_000_000, createdBy: USER_ID,
    })],
    ['setoran simpanan', () => setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: T, nominal: 1_000_000,
      sumberDana: 'KAS', createdBy: USER_ID,
    })],
    ['penempatan simpanan berjangka', () => setorSimpananBerjangka({
      anggotaId: ANGGOTA_ID, nominal: 1_000_000, tanggal: T, tenorBulan: 3,
      sukuBungaPerTahun: 6, sumberDana: 'KAS', createdBy: USER_ID,
    })],
    ['pembelian aset', () => beliAset({
      namaAset: 'Aset di periode tertutup', nilaiPerolehan: 1_000_000, masaManfaatBulan: 12,
      tanggal: T, tanggalPerolehan: T, metodePembayaran: 'TUNAI', sumberDana: 'KAS', createdBy: USER_ID,
    })],
    ['penerimaan utang', () => terimaUtang({
      namaPemberi: 'Bank Mitra', jenisPemberi: 'BANK', pokokPinjaman: 1_000_000,
      persenBunga: 0, jenisBunga: 'FLAT', tanggal: T, sumberDana: 'BANK',
      bankAccountId: BANK_ID, createdBy: USER_ID,
    })],
  ];

  it.each(kasus)('%s bertanggal periode CLOSED ditolak', async (_nama, jalankan) => {
    await expect(jalankan()).rejects.toThrow();
  });

  it('snapshot buku sebelum & sesudah seluruh percobaan IDENTIK (periode immutable)', async () => {
    const sesudah = {
      jurnal: (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n,
      entry: (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal_entry`))!.n,
      kas: await saldoGl(testDb, ACC.kas),
    };
    expect(sesudah).toEqual(sebelum);
    // Tidak ada baris subledger yatim yang lolos tanpa jurnal.
    for (const tabel of ['kas_transaksi', 'bank_transaksi', 'simpanan_transaksi', 'aset_tetap', 'simpanan_berjangka']) {
      const n = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM ${tabel}`))!.n;
      expect(n).toBe(0);
    }
  });
});

describe('§AJ — batas hari & zona waktu', () => {
  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('00:00 dan 23:59 waktu LOKAL pada 12 Juni tetap menjadi 2026-06-12', () => {
    const awalHari = new Date(2026, 5, 12, 0, 0, 0);
    const akhirHari = new Date(2026, 5, 12, 23, 59, 59);
    expect(toTanggalLokal(awalHari)).toBe('2026-06-12');
    expect(toTanggalLokal(akhirHari)).toBe('2026-06-12');
    // Pembanding: toISOString() bisa menggeser hari — inilah yang
    // dihindari helper lokal di atas.
    expect(toTanggalLokal(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
    expect(toTanggalLokal(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
  });

  it('tanggal yang disimpan jurnal PERSIS string yang dikirim, tanpa pergeseran', async () => {
    for (const tanggal of ['2026-01-01', '2026-02-28', '2026-06-12', '2026-06-30', '2026-12-31']) {
      const { journalId } = await catatPemasukan({
        jenis: 'KAS', tanggal, nominal: 100_000, akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
      });
      const j = await testDb.getFirstAsync<{ tanggal: string }>(`SELECT tanggal FROM journal WHERE id = ?`, journalId);
      expect(j!.tanggal).toBe(tanggal);
    }
  });

  it('transaksi 31 Desember masuk periode 2026, bukan 2027', async () => {
    const j = await testDb.getFirstAsync<{ period_id: string }>(
      `SELECT period_id FROM journal WHERE tanggal = '2026-12-31' LIMIT 1`
    );
    expect(j!.period_id).toBe('p2026');
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });
});
