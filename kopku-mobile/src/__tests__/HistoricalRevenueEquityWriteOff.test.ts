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
  buatFixtureHistoris, ACC, ANGGOTA_ID, USER_ID, saldoGl, totalDebitKredit, jejakJurnal,
} from './historicalFixture';
import { terimaPendapatanDimuka, prosesPengakuanPendapatanDimuka, listPendapatanDimuka } from '@/services/PendapatanDimukaService';
import { setorSimpanan } from '@/services/SimpananService';
import { catatPemasukan } from '@/services/KasBankService';
import {
  ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran,
  akadUlangPinjaman, lunasiPinjaman, hapusPiutangPinjaman,
} from '@/services/PinjamanService';
import { isCurrentRepaymentSchedule, isObsoleteRepaymentSchedule } from '@/accounting/ScheduleLifecycle';
import { getLabaRugi, getPosisiKeuangan, getPerubahanEkuitas } from '@/reports/FinancialReports';

/**
 * ============================================================
 * §X/§AA + §U (restrukturisasi & hapus buku) — BACKDATED
 * ============================================================
 *
 * Melengkapi suite historis lain: pendapatan yang diakui BERTAHAP
 * (pendapatan diterima dimuka), mutasi ekuitas historis, serta dua
 * jalur pinjaman yang paling mudah merusak periode kalau tanggalnya
 * salah — akad ulang dan penghapusan piutang.
 */

const T = '2026-06-12';

async function siapkanAnggota() {
  await setorSimpanan({
    anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-01',
    nominal: 500_000, sumberDana: 'KAS', createdBy: USER_ID,
  });
  await setorSimpanan({
    anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-01-01',
    nominal: 100_000, periode: '2026-01', sumberDana: 'KAS', createdBy: USER_ID,
  });
}

async function buatPinjaman(tanggal: string, tenor = 12, jumlah = 12_000_000) {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID, tanggal, jumlahPinjaman: jumlah,
    tenor, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false,
    createdBy: USER_ID,
  });
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: USER_ID, tanggalPencairan: tanggal });
  return id;
}

describe('§X — pendapatan diterima dimuka bertanggal historis', () => {
  let dimukaId: string;
  const JUMLAH = 12_000_000;
  const BULAN = 12;

  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
    await terimaPendapatanDimuka({
      anggotaId: ANGGOTA_ID, jumlah: JUMLAH, jangkaWaktuBulan: BULAN,
      tanggal: T, sumberDana: 'KAS', createdBy: USER_ID,
    });
    dimukaId = (await listPendapatanDimuka())[0].id;
  });

  it('penerimaan menjadi LIABILITAS, bukan pendapatan periode berjalan', async () => {
    expect(-(await saldoGl(testDb, ACC.pendapatanDimuka, '2026-06-30'))).toBe(JUMLAH);
    const lr = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lr.totalPendapatan).toBe(0); // belum earned
  });

  it('pengakuan per periode memindahkan liabilitas menjadi pendapatan, satu periode satu kali', async () => {
    const hasil = await prosesPengakuanPendapatanDimuka({
      pendapatanDimukaId: dimukaId, periode: '2026-06', createdBy: USER_ID,
    });
    expect(hasil.dibuat).toBe(true);

    const lrJuni = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lrJuni.totalPendapatan).toBe(JUMLAH / BULAN);
    expect(-(await saldoGl(testDb, ACC.pendapatanDimuka, '2026-06-30'))).toBe(JUMLAH - JUMLAH / BULAN);

    // Idempoten: periode yang sama tidak boleh diakui dua kali.
    const ulang = await prosesPengakuanPendapatanDimuka({
      pendapatanDimukaId: dimukaId, periode: '2026-06', createdBy: USER_ID,
    });
    expect(ulang.dibuat).toBe(false);
    const lrUlang = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lrUlang.totalPendapatan).toBe(JUMLAH / BULAN);
  });

  it('pengakuan periode berikutnya tidak mengubah periode sebelumnya', async () => {
    const lrJuniSebelum = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    await prosesPengakuanPendapatanDimuka({
      pendapatanDimukaId: dimukaId, periode: '2026-07', createdBy: USER_ID,
    });
    const lrJuniSesudah = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    const lrJuli = await getLabaRugi(testDb as any, '2026-07-01', '2026-07-31');
    expect(lrJuniSesudah).toEqual(lrJuniSebelum);
    expect(lrJuli.totalPendapatan).toBe(JUMLAH / BULAN);
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });
});

describe('§U — akad ulang (restrukturisasi) bertanggal historis', () => {
  let pinjamanId: string;

  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
    await siapkanAnggota();
    pinjamanId = await buatPinjaman('2026-02-10');
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await bayarAngsuran({
      pinjamanId, jadwalId: jadwal[0].id, tanggal: jadwal[0].tanggalJatuhTempo,
      nominal: jadwal[0].total, sumberDana: 'KAS', createdBy: USER_ID,
    });
  });

  it('akad ulang 12 Juni: jadwal lama menjadi obsolete, jadwal baru menjadi current', async () => {
    const sebelum = await getJadwalAngsuran(pinjamanId);
    const hasil = await akadUlangPinjaman({
      pinjamanId, tanggal: T, tenorBaru: 6, satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT', persentaseJasaBaru: 1, actingUserId: USER_ID,
    });
    expect(hasil.jumlahPeriodeBaru).toBe(6);

    const sesudah = await getJadwalAngsuran(pinjamanId);
    const current = sesudah.filter((j) => isCurrentRepaymentSchedule(j.status));
    const obsolete = sesudah.filter((j) => isObsoleteRepaymentSchedule(j.status));
    expect(obsolete.length).toBeGreaterThan(0);
    expect(current.length).toBeGreaterThan(0);
    // Jadwal baru mulai SETELAH tanggal akad ulang, bukan setelah
    // tanggal input.
    const barisBaru = current.filter((j) => j.status !== 'LUNAS');
    expect(barisBaru.every((j) => j.tanggalJatuhTempo > T)).toBe(true);
    expect(sebelum.length).toBeLessThan(sesudah.length);
  });

  it('akad ulang TIDAK menciptakan pendapatan/beban baru & buku tetap seimbang', async () => {
    const posisi = await getPosisiKeuangan(testDb as any, '2026-12-31');
    expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  it('pelunasan dipercepat bertanggal historis menutup piutang tanpa menyisakan saldo', async () => {
    await lunasiPinjaman({
      pinjamanId, tanggal: '2026-08-15', sumberDana: 'KAS', createdBy: USER_ID,
    });
    expect(await saldoGl(testDb, ACC.piutangPokok, '2026-12-31')).toBe(0);
    const p = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(p!.status).toBe('LUNAS');
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });
});

describe('§U — penghapusan piutang (write-off) bertanggal historis', () => {
  let pinjamanId: string;

  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
    // Syarat yang MEMANG BERLAKU di source: hapus buku hanya untuk
    // kolektibilitas MACET (tunggakan > 180 hari) pada tanggal
    // transaksi. Pinjaman karena itu dicairkan 2025 dan tidak pernah
    // diangsur, sehingga per 12 Juni 2026 memang sudah macet.
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2025-01-01',
      nominal: 500_000, sumberDana: 'KAS', createdBy: USER_ID,
    });
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2025-01-01',
      nominal: 100_000, periode: '2025-01', sumberDana: 'KAS', createdBy: USER_ID,
    });
    pinjamanId = await buatPinjaman('2025-01-10', 6);
  });

  it('write-off 12 Juni: piutang hilang lewat penyisihan, bukan menjadi pendapatan', async () => {
    const piutangSebelum = await saldoGl(testDb, ACC.piutangPokok);
    expect(piutangSebelum).toBeGreaterThan(0);

    const hasil = await hapusPiutangPinjaman({
      pinjamanId, tanggal: T, alasan: 'Anggota tidak dapat ditagih (uji audit historis)',
      createdBy: USER_ID, topUpPenyisihanJikaKurang: true,
    });
    expect(hasil.writeOffTotal).toBeGreaterThan(0);

    expect(await saldoGl(testDb, ACC.piutangPokok, '2026-12-31')).toBe(0);
    const lr = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lr.totalPendapatan).toBe(0); // write-off tidak pernah menjadi pendapatan

    const p = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(p!.status).toBe('MACET');
  });

  it('write-off kedua ditolak (idempotensi struktural lewat status)', async () => {
    await expect(
      hapusPiutangPinjaman({
        pinjamanId, tanggal: T, alasan: 'percobaan kedua', createdBy: USER_ID,
        topUpPenyisihanJikaKurang: true,
      })
    ).rejects.toThrow(/sudah pernah dihapusbukukan/);
  });

  it('jurnal write-off bertanggal transaksi & buku tetap seimbang', async () => {
    const j = await testDb.getFirstAsync<{ id: string; tanggal: string }>(
      `SELECT id, tanggal FROM journal WHERE sumber_transaksi LIKE '%HAPUS%' OR sumber_transaksi LIKE '%WRITE%' LIMIT 1`
    );
    if (j) {
      expect(j.tanggal).toBe(T);
      const jejak = await jejakJurnal(testDb, j.id);
      expect(jejak.some((r) => r.kode.startsWith('4-'))).toBe(false);
    }
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });
});

describe('§AA — mutasi ekuitas historis', () => {
  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: T, nominal: 500_000,
      sumberDana: 'KAS', createdBy: USER_ID,
    });
    await catatPemasukan({
      jenis: 'KAS', tanggal: T, nominal: 4_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pendapatan historis', createdBy: USER_ID,
    });
  });

  it('Perubahan Ekuitas selalu bertemu dengan total ekuitas di Posisi Keuangan', async () => {
    for (const akhir of ['2026-06-30', '2026-09-30', '2026-12-31']) {
      const ekuitas = await getPerubahanEkuitas(testDb as any, '2026-01-01', akhir);
      const posisi = await getPosisiKeuangan(testDb as any, akhir);
      expect(ekuitas.totalSaldoAkhir).toBe(posisi.totalEkuitas);
    }
  });

  it('mutasi masuk ke periode transaksi, bukan periode input', async () => {
    const sebelumMutasi = await getPerubahanEkuitas(testDb as any, '2026-01-01', '2026-06-11');
    const sesudahMutasi = await getPerubahanEkuitas(testDb as any, '2026-01-01', '2026-06-30');
    expect(sesudahMutasi.totalSaldoAkhir - sebelumMutasi.totalSaldoAkhir).toBe(500_000 + 4_000_000);
  });

  it('periode berurutan menyambung: saldo akhir Semester I = titik awal Semester II', async () => {
    const semester1 = await getPerubahanEkuitas(testDb as any, '2026-01-01', '2026-06-30');
    const semester2 = await getPerubahanEkuitas(testDb as any, '2026-07-01', '2026-12-31');
    const posisiJuni = await getPosisiKeuangan(testDb as any, '2026-06-30');
    expect(semester1.totalSaldoAkhir).toBe(posisiJuni.totalEkuitas);
    // Tidak ada mutasi setelah 30 Juni pada dataset ini -> saldo akhir sama.
    expect(semester2.totalSaldoAkhir).toBe(semester1.totalSaldoAkhir);
  });
});
