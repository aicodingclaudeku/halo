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

import { buatFixtureHistoris, ACC, ANGGOTA_ID, USER_ID, saldoGl, totalDebitKredit, jejakJurnal } from './historicalFixture';
import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran } from '@/services/PinjamanService';
import { setorSimpanan } from '@/services/SimpananService';
import { getKlasifikasiPinjamanAktif } from '@/services/LoanImpairmentService';
import { getLabaRugi, getPosisiKeuangan } from '@/reports/FinancialReports';

/**
 * ============================================================
 * §U/§V/§W — PINJAMAN, ANGSURAN & TANGGAL AKHIR BULAN
 * ============================================================
 *
 * Seluruh pinjaman di sini dicairkan dengan TANGGAL HISTORIS (mundur).
 * Yang diperiksa: pokok tidak menjadi pendapatan, pencairan bukan beban,
 * jadwal & aging memakai tanggal yang benar, dan tanggal akhir bulan
 * (31 Januari, 28 Februari, dst.) tidak menghasilkan jatuh tempo yang
 * meleset.
 */

const POKOK = 12_000_000;

/**
 * Syarat kelayakan yang MEMANG BERLAKU di source
 * (`checkEligibilitasPinjaman`): anggota wajib sudah punya Simpanan
 * Pokok & Wajib. Disetor pada awal tahun buku supaya seluruh tanggal
 * pencairan yang diuji (termasuk 31 Januari) tetap sesudahnya.
 */
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

async function buatPinjaman(tanggal: string, tenor = 12) {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID, tanggal, jumlahPinjaman: POKOK,
    tenor, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false,
    createdBy: USER_ID,
  });
  const { journalId } = await cairkanPinjaman({
    pinjamanId: id, sumberDana: 'KAS', approvedBy: USER_ID, tanggalPencairan: tanggal,
  }) as { journalId: string };
  return { id, journalId };
}

describe('§U — pencairan pinjaman bertanggal historis', () => {
  let pinjamanId: string;
  let journalPencairan: string;

  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
    await siapkanAnggota();
    const hasil = await buatPinjaman('2026-06-12');
    pinjamanId = hasil.id;
    journalPencairan = hasil.journalId;
  });

  it('pencairan: Dr Piutang / Cr Kas — BUKAN beban, BUKAN pendapatan', async () => {
    const jejak = await jejakJurnal(testDb, journalPencairan);
    expect(jejak.every((r) => r.tanggal === '2026-06-12')).toBe(true);
    expect(jejak.find((r) => r.debit > 0)!.kode).toBe('1-1200'); // Piutang pokok
    expect(jejak.some((r) => r.kode.startsWith('5-'))).toBe(false);
    expect(await saldoGl(testDb, ACC.piutangPokok, '2026-06-30')).toBe(POKOK);

    const lr = await getLabaRugi(testDb as any, '2026-06-01', '2026-06-30');
    expect(lr.totalPendapatan).toBe(0); // pencairan tidak menciptakan pendapatan
    expect(lr.totalBeban).toBe(0);
  });

  it('jadwal angsuran dibuat dari TANGGAL PENCAIRAN historis', async () => {
    const jadwal = await getJadwalAngsuran(pinjamanId);
    expect(jadwal).toHaveLength(12);
    expect(jadwal[0].tanggalJatuhTempo > '2026-06-12').toBe(true);
    expect(jadwal[0].tanggalJatuhTempo.slice(0, 7)).toBe('2026-07');
    // Jadwal kronologis & tidak ada tanggal ganda.
    const tanggal = jadwal.map((j) => j.tanggalJatuhTempo);
    expect([...tanggal].sort()).toEqual(tanggal);
    expect(new Set(tanggal).size).toBe(tanggal.length);
  });

  it('§W — angsuran backdated: pokok mengurangi piutang, jasa menjadi pendapatan', async () => {
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const baris = jadwal[0];
    const piutangSebelum = await saldoGl(testDb, ACC.piutangPokok);

    await bayarAngsuran({
      pinjamanId, jadwalId: baris.id, tanggal: baris.tanggalJatuhTempo,
      nominal: baris.total, sumberDana: 'KAS', createdBy: USER_ID,
    });

    const piutangSesudah = await saldoGl(testDb, ACC.piutangPokok);
    expect(piutangSebelum - piutangSesudah).toBe(baris.pokok); // pokok bukan pendapatan
    const lr = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    expect(lr.totalPendapatan).toBeGreaterThan(0); // hanya jasa yang jadi pendapatan
    expect(lr.totalPendapatan).toBeLessThanOrEqual(baris.jasa + 1);

    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
    const posisi = await getPosisiKeuangan(testDb as any, '2026-12-31');
    expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);
  });

  it('angsuran yang sama dibayar dua kali tidak diterima diam-diam', async () => {
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const lunas = jadwal.find((j) => j.status === 'LUNAS')!;
    await expect(
      bayarAngsuran({
        pinjamanId, jadwalId: lunas.id, tanggal: lunas.tanggalJatuhTempo,
        nominal: lunas.total, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow();
  });

  it('kolektibilitas dihitung pada TANGGAL LAPORAN, bukan tanggal input', async () => {
    // Tepat setelah pencairan: belum ada tunggakan.
    const awal = await getKlasifikasiPinjamanAktif(testDb as any, { tanggalLaporan: '2026-06-30' });
    expect(awal.every((k) => k.hariTunggakan === 0)).toBe(true);
    // Jauh setelahnya: angsuran yang belum dibayar sudah menunggak.
    const akhir = await getKlasifikasiPinjamanAktif(testDb as any, { tanggalLaporan: '2026-12-31' });
    expect(akhir.some((k) => k.hariTunggakan > 0)).toBe(true);
  });
});

describe('§V — tanggal akhir bulan', () => {
  const TANGGAL_UJI = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-08-31', '2026-12-31'];

  it.each(TANGGAL_UJI)('pencairan %s menghasilkan jadwal 12 bulan yang konsisten', async (tanggal) => {
    testDb = await buatFixtureHistoris();
    await siapkanAnggota();
    const { id } = await buatPinjaman(tanggal, 12);
    const jadwal = await getJadwalAngsuran(id);

    expect(jadwal).toHaveLength(12);
    // Tidak ada tanggal yang meluber ke bulan berikutnya (31 Jan + 1
    // bulan tidak boleh menjadi 3 Maret).
    const bulanUnik = new Set(jadwal.map((j) => j.tanggalJatuhTempo.slice(0, 7)));
    expect(bulanUnik.size).toBe(12);
    // Seluruh jatuh tempo setelah tanggal pencairan & berurutan.
    expect(jadwal[0].tanggalJatuhTempo > tanggal).toBe(true);
    const list = jadwal.map((j) => j.tanggalJatuhTempo);
    expect([...list].sort()).toEqual(list);
    // Jatuh tempo terakhir = bulan ke-12 setelah pencairan.
    const bulanAwal = Number(tanggal.slice(5, 7));
    const tahunAwal = Number(tanggal.slice(0, 4));
    const totalBulan = tahunAwal * 12 + bulanAwal - 1 + 12;
    const harapanTerakhir = `${Math.floor(totalBulan / 12)}-${String((totalBulan % 12) + 1).padStart(2, '0')}`;
    expect(list[11].slice(0, 7)).toBe(harapanTerakhir);
  });

  it('total pokok jadwal = pokok pinjaman (tidak ada rupiah yang hilang di pembulatan)', async () => {
    testDb = await buatFixtureHistoris();
    await siapkanAnggota();
    const { id } = await buatPinjaman('2026-01-31', 12);
    const jadwal = await getJadwalAngsuran(id);
    expect(jadwal.reduce((a, j) => a + j.pokok, 0)).toBe(POKOK);
  });
});
