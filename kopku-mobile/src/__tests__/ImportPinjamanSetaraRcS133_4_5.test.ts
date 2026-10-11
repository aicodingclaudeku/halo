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
import { susunJadwalMigrasi, alokasiPiutangJasaMigrasi, rekonsiliasiPiutang } from '@/import/MigrasiPinjamanPlan';
import { sisaPokokDariAngsuranDibayar } from '@/import/TurunanMigrasiPinjaman';
import { hitungJadwalAngsuran } from '@/accounting/PinjamanCalculator';
import { calculateInstallmentDate } from '@/accounting/InstallmentDate';
import { jalankanAkrualJasaOtomatisJikaPerlu } from '@/services/AkrualJasaPinjamanService';
import { getArusKas, getInformasiShuRAT } from '@/reports/FinancialReports';
import { listJasaDataAwal } from '@/services/PartisipasiDataAwalService';
import { createJournal } from '@/accounting/AccountingEngine';
import { bacaBagianBelumTunaiSaldoAwal } from '@/accounting/SaldoAwalRealisasiKas';

/**
 * RC-S133.4.5 — PINJAMAN HASIL IMPORT SETARA DENGAN PINJAMAN BIASA.
 *
 * Temuan uji dua jalur (transaksi langsung vs import) pada data nyata:
 *  1. jatuh tempo dihitung dari tanggal cut-off (tiap tanggal 29), bukan akad;
 *  2. tunggakan dihitung lebih satu angsuran karena pembulatan;
 *  3. sisa pokok turunan selisih Rp16 dari jadwal asli;
 *  4. jasa diakui DUA KALI: akrual otomatis mengakui lagi jasa tunggakan
 *     yang sudah ada di saldo awal Pendapatan Jasa & Piutang Jasa;
 *  5. saldo awal Kas tampil sebagai arus kas pendanaan.
 */
const CUTOFF = '2026-09-29';

describe('RC-S133.4.5 — jadwal migrasi dibangun dari akad (modul murni)', () => {
  test('jadwal sama persis dengan pinjaman baru: nomor, tanggal, pokok, jasa', () => {
    const h = susunJadwalMigrasi({
      tanggalAkad: '2026-08-01', jumlahPinjamanAsli: 9_706_600, tenorAsli: 24, sisaPokok: sisaPokokDariAngsuranDibayar(9_706_600, 24, 0, 'FLAT', 0.5),
      angsuranTersisa: 24, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 0.5, tanggalCutOff: CUTOFF,
    });
    const asli = hitungJadwalAngsuran({ jumlahPinjaman: 9_706_600, tenor: 24, persentaseJasaPerPeriode: 0.5, metode: 'FLAT' });
    expect(h.mode).toBe('RIWAYAT');
    expect(h.baris.map((b) => [b.nomorAngsuran, b.pokok, b.jasa])).toEqual(asli.map((a) => [a.nomorAngsuran, a.pokok, a.jasa]));
    expect(h.baris.map((b) => b.tanggalJatuhTempo)).toEqual(asli.map((a) => calculateInstallmentDate('2026-08-01', a.nomorAngsuran, 'BULAN')));
    expect(h.baris[0].tanggalJatuhTempo).toBe('2026-09-01'); // bukan 2026-10-29
    // tunggakan TEPAT satu angsuran (jatuh tempo 1 Sep < cut-off), bukan dua
    expect(h.tunggakanPokok).toBe(asli[0].pokok);
    expect(h.baris.filter((b) => b.status !== 'LUNAS' && b.tanggalJatuhTempo < CUTOFF)).toHaveLength(1);
  });

  test('sisa pokok turunan = sisa jadwal asli (tidak lagi selisih pembulatan)', () => {
    const asli = hitungJadwalAngsuran({ jumlahPinjaman: 9_706_600, tenor: 24, persentaseJasaPerPeriode: 0.5, metode: 'FLAT' });
    for (const dibayar of [0, 1, 8, 23]) {
      expect(sisaPokokDariAngsuranDibayar(9_706_600, 24, dibayar, 'FLAT', 0.5)).toBe(asli.slice(dibayar).reduce((t, a) => t + a.pokok, 0));
    }
  });

  test('angsuran yang sudah dibayar = LUNAS; yang dibayar sebelum jatuh tempo membawa jasa dimuka', () => {
    // akad 1 Jun, 10 bulan, sudah dibayar 8 per cut-off 29 Sep: #1–#3 jatuh tempo sebelum cut-off, #4–#8 dibayar di muka
    const sisa = sisaPokokDariAngsuranDibayar(10_000_000, 10, 8, 'FLAT', 1.5);
    const h = susunJadwalMigrasi({ tanggalAkad: '2026-06-01', jumlahPinjamanAsli: 10_000_000, tenorAsli: 10, sisaPokok: sisa, angsuranTersisa: 2, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1.5, tanggalCutOff: CUTOFF });
    expect(h.baris.filter((b) => b.status === 'LUNAS')).toHaveLength(8);
    expect(h.baris.filter((b) => (b.jasaDimuka ?? 0) > 0).map((b) => b.nomorAngsuran)).toEqual([4, 5, 6, 7, 8]);
    expect(h.baris.filter((b) => b.status === 'LUNAS').reduce((t, b) => t + (b.jasaDimuka ?? 0), 0)).toBe(5 * 150_000);
    expect(h.tunggakanPokok).toBe(0);
  });

  test('sisa pokok berkas berbeda dari jadwal akad → jadwal sisa dari cut-off (pinjaman tidak lagi mengikuti akad)', () => {
    const h = susunJadwalMigrasi({ tanggalAkad: '2026-01-01', jumlahPinjamanAsli: 12_000_000, tenorAsli: 12, sisaPokok: 7_000_000, angsuranTersisa: 6, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1, tanggalCutOff: CUTOFF });
    expect(h.mode).toBe('SISA');
    expect(h.baris.reduce((t, b) => t + b.pokok, 0)).toBe(7_000_000);
  });

  test('alokasi piutang jasa FIFO ke angsuran tertua yang belum dibayar', () => {
    const h = susunJadwalMigrasi({ tanggalAkad: '2026-06-01', jumlahPinjamanAsli: 1_000_000, tenorAsli: 10, sisaPokok: 1_000_000, angsuranTersisa: 10, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1, tanggalCutOff: CUTOFF });
    expect(alokasiPiutangJasaMigrasi(h.baris, 25_000)).toEqual([
      { periode: '2026-07', nomorAngsuran: 1, jumlah: 10_000 },
      { periode: '2026-08', nomorAngsuran: 2, jumlah: 10_000 },
      { periode: '2026-09', nomorAngsuran: 3, jumlah: 5_000 },
    ]);
  });

  test('rekonsiliasi memperingatkan saldo awal Piutang Jasa tanpa rincian per pinjaman', () => {
    const r = rekonsiliasiPiutang({ totalSisaPokokBukuPembantu: 1, saldoAwalPiutangPokok: 1, totalPiutangJasaBukuPembantu: 0, saldoAwalPiutangJasa: 500_000 });
    expect(r.cocok).toBe(false);
    expect(r.pesan.join(' ')).toMatch(/tidak punya rincian per pinjaman/);
  });
});

describe('RC-S133.4.5 — eksekusi import & akrual tidak ganda', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    // akun kliring saldo awal (ada di COA bawaan, tidak di fixture historis)
    const now = new Date().toISOString();
    await testDb.runAsync(`INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES ('acc-kliring','3-5000','Saldo Awal Belum Sesuai','EKUITAS','KREDIT',1,0,?,?)`, now, now);
    await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kliring','KOREKSI_SALDO_AWAL','KLIRING','acc-kliring')`);
  });

  const berkas = (piutangJasa: number | null) =>
    parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Budi', '2025-01-01'], ['K2', 'Siti', '2025-01-01']],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Angsuran Sudah Dibayar', 'Nomor Pinjaman Lama', 'Piutang Jasa'],
        ['K1', '2026-08-01', 9_706_600, 24, 'BULAN', 'FLAT', 0.5, 'KAS', 0, 'PJ-1', piutangJasa],
        ['K2', '2026-06-01', 10_000_000, 10, 'BULAN', 'FLAT', 1.5, 'KAS', 8, 'PJ-2', null],
      ],
    });
  const opsi = { createdBy: USER_ID, dbRiwayat: testDb as never, dbMigrasi: testDb as never, tanggalCutOff: CUTOFF };

  test('jadwal tersimpan sama dengan pinjaman biasa; tenor akad; tanpa jurnal kas', async () => {
    const kas = await saldoGl(testDb, ACC.kas);
    const h = await jalankanImportDataAwal(berkas(48_533), { ...opsi, dbRiwayat: testDb as never, dbMigrasi: testDb as never });
    expect(h.perSheet.find((s) => s.jenis === 'PINJAMAN')).toMatchObject({ berhasil: 2, gagal: 0 });
    expect(h.migrasi!.berhasil.map((b) => b.modeJadwal)).toEqual(['RIWAYAT', 'RIWAYAT']);
    const p1 = await testDb.getFirstAsync<{ id: string; tenor: number }>(`SELECT id, tenor FROM pinjaman WHERE nomor_pinjaman='PJ-1'`);
    expect(p1!.tenor).toBe(24);
    const j1 = await testDb.getAllAsync<{ t: string; pokok: number; status: string }>(`SELECT tanggal_jatuh_tempo t, pokok, status FROM angsuran_jadwal WHERE pinjaman_id=? ORDER BY nomor_angsuran`, p1!.id);
    expect(j1).toHaveLength(24);
    expect(j1[0]).toEqual({ t: '2026-09-01', pokok: 404_442, status: 'BELUM_BAYAR' });
    expect(j1[23].t).toBe('2028-08-01');
    expect(await saldoGl(testDb, ACC.kas)).toBe(kas);
    // jasa dimuka pinjaman K2 (5 angsuran × 150.000) → saldo awal Pendapatan Diterima Dimuka otomatis
    expect(h.migrasi!.totalJasaDimuka).toBe(750_000);
    expect(h.saldoAwal!.baris.find((b) => b.pos === 'PENDAPATAN_DIMUKA')).toMatchObject({ status: 'DIISI', saldoImport: 750_000 });
    // rekonsiliasi dihitung SETELAH saldo awal terisi otomatis → cocok
    expect(h.migrasi!.rekonsiliasi.cocok).toBe(true);
    // dasar SHU jasa usaha dari riwayat angsuran: K2 membayar jasa #1..#8 = 8 × 150.000 (Jul–Sep jatuh tempo, sisanya di muka per 28 Sep)
    const jasa = await listJasaDataAwal(testDb as never);
    expect(jasa.map((j) => j.jasa)).toEqual([1_200_000]);
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  test('akrual otomatis TIDAK mengakui ulang jasa tunggakan yang sudah di saldo awal Piutang Jasa', async () => {
    await jalankanImportDataAwal(berkas(48_533), opsi);
    const pendSebelum = await saldoGl(testDb, ACC.pendapatanJasa);
    const piutSebelum = await saldoGl(testDb, ACC.piutangJasa);
    // jalankan akrual per 30 Sep (setelah cut-off)
    await jalankanAkrualJasaOtomatisJikaPerlu(USER_ID, new Date('2026-09-30T10:00:00'));
    const akrual = await testDb.getAllAsync<{ tanggal: string }>(`SELECT tanggal FROM journal WHERE sumber_transaksi='AKRUAL_JASA_PINJAMAN'`);
    expect(akrual).toEqual([]); // angsuran #1 (1 Sep) sudah tercakup piutang jasa migrasi; #2 baru jatuh tempo 1 Okt
    expect(await saldoGl(testDb, ACC.pendapatanJasa)).toBe(pendSebelum);
    expect(await saldoGl(testDb, ACC.piutangJasa)).toBe(piutSebelum);
    const paj = await testDb.getAllAsync<{ periode_akuntansi: string; pendapatan_akuntansi: number }>(`SELECT periode_akuntansi, pendapatan_akuntansi FROM pinjaman_akuntansi_jasa`);
    expect(paj).toEqual([{ periode_akuntansi: '2026-09', pendapatan_akuntansi: 48_533 }]);
  });

  test('tanpa Piutang Jasa (pembukuan kas): jasa tunggakan diakui setelah cut-off, tidak bertanggal sebelum cut-off', async () => {
    await jalankanImportDataAwal(berkas(null), opsi);
    await jalankanAkrualJasaOtomatisJikaPerlu(USER_ID, new Date('2026-09-30T10:00:00'));
    const akrual = await testDb.getAllAsync<{ tanggal: string }>(`SELECT tanggal FROM journal WHERE sumber_transaksi='AKRUAL_JASA_PINJAMAN'`);
    expect(akrual.length).toBe(1);
    expect(akrual[0].tanggal >= CUTOFF).toBe(true);
  });
});

describe('RC-S133.4.5 — Arus Kas & basis kas', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('jurnal saldo awal Kas di dalam periode = kas awal, bukan arus kas pendanaan', async () => {
    const sebelum = await getArusKas(testDb as never, '2026-09-29', '2026-12-31');
    await createJournal(testDb as never, {
      tanggal: CUTOFF, sumberTransaksi: 'SALDO_AWAL_AKUN', deskripsi: 'Saldo awal akun Kas', createdBy: USER_ID,
      lines: [{ accountId: ACC.kas, debit: 215_000_000, kredit: 0 }, { accountId: ACC.modal, debit: 0, kredit: 215_000_000 }],
    });
    const r = await getArusKas(testDb as never, '2026-09-29', '2026-12-31');
    expect(r.pendanaan).toBe(sebelum.pendanaan);
    expect(r.kasAwal).toBe(sebelum.kasAwal + 215_000_000);
    expect(r.kasAwalDariSaldoAwal).toBe(215_000_000);
    expect(r.terekonsiliasi).toBe(true);
    expect(r.rincian.some((x) => x.sumberTransaksi === 'SALDO_AWAL_AKUN')).toBe(false);
  });

  test('bawaan basis kas: saldo awal Piutang Jasa dianggap bagian Pendapatan Jasa yang belum tunai', async () => {
    const now = new Date().toISOString();
    for (const [id, acc, saldo] of [['sa1', ACC.pendapatanJasa, 9_000_000], ['sa2', ACC.piutangJasa, 3_000_000]] as const) {
      await testDb.runAsync(`INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at) VALUES (?,?,?,?,NULL,?,?,?)`, id, acc, CUTOFF, saldo, USER_ID, now, now);
    }
    const peta = await bacaBagianBelumTunaiSaldoAwal(testDb as never);
    expect(peta.get(ACC.pendapatanJasa)).toBe(3_000_000);
    // pilihan eksplisit "seluruhnya tunai" (0) mengalahkan bawaan
    await testDb.runAsync(`INSERT INTO app_config (key, value, updated_at) VALUES (?, '0', ?)`, `saldo_awal.belum_tunai.${ACC.pendapatanJasa}`, now);
    expect((await bacaBagianBelumTunaiSaldoAwal(testDb as never)).get(ACC.pendapatanJasa)).toBeUndefined();
    expect(typeof getInformasiShuRAT).toBe('function');
  });
});
