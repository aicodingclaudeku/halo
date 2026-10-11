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

import { buatFixtureHistoris, ACC, ANGGOTA_ID, BANK_ID, USER_ID, saldoGl } from './historicalFixture';
import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran } from '@/services/PinjamanService';
import { catatDataAwalSimpanan, getSaldoSimpanan, setorSimpanan, tarikSimpananSukarela } from '@/services/SimpananService';
import { prosesAkrualJasaPinjaman } from '@/services/AkrualJasaPinjamanService';
import { getHistoryDetail } from '@/services/HistoryTransaksiService';
import {
  koreksiAngsuran,
  koreksiPencairanPinjaman,
  koreksiSetoranSimpanan,
  periksaKoreksiTransaksi,
} from '@/services/KoreksiTransaksiService';

/**
 * RC-S133.6.2 — KOREKSI TRANSAKSI DARI HISTORY DENGAN JEJAK AUDIT (temuan T-08).
 *
 * Keputusan pengguna: transaksi yang sudah dibukukan TIDAK diedit/dihapus;
 * koreksi = pembalikan + pencatatan ulang yang benar, dengan alasan,
 * otorisasi, ID transaksi asal, dan jurnal yang dapat ditelusuri; validasi
 * khusus bila ada transaksi lanjutan atau periode tertutup.
 */

async function jurnal(id: string) {
  return testDb.getFirstAsync<any>(`SELECT * FROM journal WHERE id = ?`, id);
}

async function seimbang() {
  const r = await testDb.getFirstAsync<any>(
    `SELECT COALESCE(SUM(je.debit),0) d, COALESCE(SUM(je.kredit),0) k FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE j.status IN ('POSTED','REVERSED')`
  );
  return Number(r.d) === Number(r.k);
}

async function siapkanPinjaman(tenor = 12, tanggal = '2026-01-15') {
  await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-01', nominal: 500_000, sumberDana: 'KAS', createdBy: USER_ID });
  await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-01-01', nominal: 100_000, periode: '2026-01', sumberDana: 'KAS', createdBy: USER_ID });
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID, tanggal, jumlahPinjaman: 12_000_000, tenor, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, createdBy: USER_ID,
  } as any);
  const { journalId } = (await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: USER_ID, tanggalPencairan: tanggal })) as { journalId: string };
  return { pinjamanId: id, journalId };
}

beforeEach(async () => {
  testDb = await buatFixtureHistoris();
});

describe('Setoran simpanan (Setor Simpanan / data awal)', () => {
  test('dibalik + dicatat ulang: jurnal asal REVERSED (tidak dihapus), pengganti POSTED, saldo & kas benar, jejak tercatat', async () => {
    const asal = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID, tanggal: '2026-02-01', pokok: 100_000, wajib: 50_000, sukarela: 200_000, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const kasSebelum = await saldoGl(testDb, ACC.kas);
    const h = await koreksiSetoranSimpanan({
      journalId: asal.journalId,
      alasan: 'Sukarela salah ketik, seharusnya 20.000',
      userId: USER_ID,
      catatUlang: { tanggal: '2026-02-01', pokok: 100_000, wajib: 50_000, sukarela: 20_000, sumberDana: 'KAS' },
    });
    expect((await jurnal(asal.journalId)).status).toBe('REVERSED');
    const pembalik = await jurnal(h.journalPembalikId);
    expect(pembalik.reversal_of_id).toBe(asal.journalId);
    expect((await jurnal(h.journalPenggantiId!)).status).toBe('POSTED');
    expect(await getSaldoSimpanan(testDb as never, ANGGOTA_ID, 'SUKARELA')).toBe(20_000);
    expect(await getSaldoSimpanan(testDb as never, ANGGOTA_ID, 'POKOK')).toBe(100_000);
    expect(await saldoGl(testDb, ACC.kas)).toBe(kasSebelum - 180_000);
    expect(await seimbang()).toBe(true);
    const k = await testDb.getFirstAsync<any>(`SELECT * FROM koreksi_transaksi WHERE journal_asal_id = ?`, asal.journalId);
    expect(k).toMatchObject({ jenis: 'SETORAN_SIMPANAN', journal_pembalik_id: h.journalPembalikId, journal_pengganti_id: h.journalPenggantiId, diotorisasi_oleh: USER_ID });
    expect(k.alasan).toMatch(/salah ketik/);
    const audit = await testDb.getFirstAsync<any>(`SELECT * FROM audit_log WHERE action = 'KOREKSI' AND entity_id = ?`, asal.journalId);
    expect(audit).not.toBe(null);
    // Koreksi kedua atas jurnal yang sama ditolak.
    await expect(koreksiSetoranSimpanan({ journalId: asal.journalId, alasan: 'ulang lagi', userId: USER_ID })).rejects.toThrow(/Koreksi ditolak/);
  });

  test('sudah ada penarikan sesudahnya: pembalikan murni ditolak (saldo akan negatif); dengan pencatatan ulang yang cukup diterima', async () => {
    const asal = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID, tanggal: '2026-02-01', pokok: 0, wajib: 0, sukarela: 200_000, sumberDana: 'KAS', createdBy: USER_ID,
    });
    await tarikSimpananSukarela({ anggotaId: ANGGOTA_ID, tanggal: '2026-03-01', nominal: 150_000, sumberDana: 'KAS', createdBy: USER_ID } as any);
    const cek = await periksaKoreksiTransaksi(testDb as never, asal.journalId);
    expect(cek!.boleh).toBe(true);
    expect(cek!.catatan.join(' ')).toMatch(/negatif/);
    await expect(koreksiSetoranSimpanan({ journalId: asal.journalId, alasan: 'setoran tidak pernah ada', userId: USER_ID })).rejects.toThrow(/negatif/);
    expect((await jurnal(asal.journalId)).status).toBe('POSTED');
    await koreksiSetoranSimpanan({
      journalId: asal.journalId,
      alasan: 'nominal seharusnya 150.000',
      userId: USER_ID,
      catatUlang: { tanggal: '2026-02-01', pokok: 0, wajib: 0, sukarela: 150_000, sumberDana: 'KAS' },
    });
    expect(await getSaldoSimpanan(testDb as never, ANGGOTA_ID, 'SUKARELA')).toBe(0);
  });

  test('SHU tahun buku sudah dibagikan -> ditolak; periode ditutup -> ditolak', async () => {
    const asal = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID, tanggal: '2026-02-01', pokok: 0, wajib: 50_000, sukarela: 0, sumberDana: 'KAS', createdBy: USER_ID,
    });
    await testDb.runAsync(`INSERT INTO shu_konfigurasi (id, tahun_buku, status, created_at, updated_at) VALUES ('shu26', 2026, 'DIBAGIKAN', ?, ?)`, new Date().toISOString(), new Date().toISOString());
    let cek = await periksaKoreksiTransaksi(testDb as never, asal.journalId);
    expect(cek!.boleh).toBe(false);
    expect(cek!.alasanTolak.join(' ')).toMatch(/SHU tahun buku 2026 sudah dibagikan/);
    await testDb.runAsync(`DELETE FROM shu_konfigurasi`);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE tahun_buku = 2026`);
    cek = await periksaKoreksiTransaksi(testDb as never, asal.journalId);
    expect(cek!.boleh).toBe(false);
    expect(cek!.alasanTolak.join(' ')).toMatch(/periode akuntansi yang sudah ditutup/);
  });

  test('History: jurnal setoran menawarkan Koreksi Transaksi; jurnal pembalik tidak; jejak tampil di ketiganya', async () => {
    const asal = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID, tanggal: '2026-02-01', pokok: 0, wajib: 50_000, sukarela: 0, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const d0 = await getHistoryDetail(asal.journalId);
    expect(d0!.koreksiKhusus?.boleh).toBe(true);
    expect(d0!.aksiTidakTersediaAlasan).toBe(null);
    const h = await koreksiSetoranSimpanan({
      journalId: asal.journalId, alasan: 'wajib seharusnya 60.000', userId: USER_ID,
      catatUlang: { tanggal: '2026-02-01', pokok: 0, wajib: 60_000, sukarela: 0, sumberDana: 'BANK', bankAccountId: BANK_ID },
    });
    const dAsal = await getHistoryDetail(asal.journalId);
    expect(dAsal!.status).toBe('REVERSED');
    expect(dAsal!.jejakKoreksi).toHaveLength(1);
    const dPembalik = await getHistoryDetail(h.journalPembalikId);
    expect(dPembalik!.koreksiKhusus ?? null).toBe(null);
    expect(dPembalik!.aksiTidakTersediaAlasan).toMatch(/jurnal pembalik/);
    expect(dPembalik!.jejakKoreksi![0].journalAsalId).toBe(asal.journalId);
    const dPengganti = await getHistoryDetail(h.journalPenggantiId!);
    expect(dPengganti!.jejakKoreksi![0].journalPenggantiId).toBe(h.journalPenggantiId);
    expect(dPengganti!.koreksiKhusus?.boleh).toBe(true); // transaksi pengganti dapat dikoreksi lagi bila perlu
  });
});

describe('Pencairan pinjaman', () => {
  test('dicairkan ulang dengan sumber dana benar: piutang tetap, kas pulih, bank berkurang, pinjaman AKTIF menunjuk jurnal pengganti', async () => {
    const { pinjamanId, journalId } = await siapkanPinjaman();
    const kas = await saldoGl(testDb, ACC.kas);
    const bank = await saldoGl(testDb, ACC.bank);
    const h = await koreksiPencairanPinjaman({
      journalId, alasan: 'seharusnya dari rekening bank', userId: USER_ID,
      cairkanUlang: { tanggal: '2026-01-15', sumberDana: 'BANK', bankAccountId: BANK_ID },
    });
    const p = await testDb.getFirstAsync<any>(`SELECT status, pencairan_journal_id FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(p).toMatchObject({ status: 'AKTIF', pencairan_journal_id: h.journalPenggantiId });
    expect(await saldoGl(testDb, ACC.kas)).toBe(kas + 12_000_000);
    expect(await saldoGl(testDb, ACC.bank)).toBe(bank - 12_000_000);
    expect(await saldoGl(testDb, ACC.piutangPokok)).toBe(12_000_000);
    expect(await seimbang()).toBe(true);
  });

  test('tanpa pencairan ulang: pinjaman kembali DISETUJUI, piutang nol', async () => {
    const { pinjamanId, journalId } = await siapkanPinjaman();
    await koreksiPencairanPinjaman({ journalId, alasan: 'pinjaman batal diambil', userId: USER_ID });
    const p = await testDb.getFirstAsync<any>(`SELECT status, pencairan_journal_id FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(p).toMatchObject({ status: 'DISETUJUI', pencairan_journal_id: null });
    expect(await saldoGl(testDb, ACC.piutangPokok)).toBe(0);
  });

  test('sudah ada angsuran ATAU akrual jasa -> ditolak, tidak ada yang berubah', async () => {
    const a = await siapkanPinjaman();
    const j1 = (await getJadwalAngsuran(a.pinjamanId)).sort((x, y) => x.nomorAngsuran - y.nomorAngsuran)[0];
    await bayarAngsuran({ pinjamanId: a.pinjamanId, jadwalId: j1.id, tanggal: j1.tanggalJatuhTempo, nominal: j1.total, sumberDana: 'KAS', createdBy: USER_ID });
    const cek = await periksaKoreksiTransaksi(testDb as never, a.journalId);
    expect(cek!.boleh).toBe(false);
    expect(cek!.alasanTolak.join(' ')).toMatch(/Sudah ada pembayaran angsuran/);
    await expect(koreksiPencairanPinjaman({ journalId: a.journalId, alasan: 'coba koreksi', userId: USER_ID })).rejects.toThrow(/Koreksi ditolak/);
    expect((await jurnal(a.journalId)).status).toBe('POSTED');

    testDb = await buatFixtureHistoris();
    const b = await siapkanPinjaman();
    await prosesAkrualJasaPinjaman({ pinjamanId: b.pinjamanId, periode: '2026-02', createdBy: USER_ID, tanggalLaporan: '2026-02-28' });
    const cekB = await periksaKoreksiTransaksi(testDb as never, b.journalId);
    expect(cekB!.alasanTolak.join(' ')).toMatch(/sudah diakru/);
  });
});

describe('Pembayaran angsuran', () => {
  test('hanya pembayaran TERAKHIR yang dapat dikoreksi; koreksi + bayar ulang sebagian memulihkan jadwal & dasar SHU jasa', async () => {
    const { pinjamanId } = await siapkanPinjaman();
    const jadwal = (await getJadwalAngsuran(pinjamanId)).sort((x, y) => x.nomorAngsuran - y.nomorAngsuran);
    const b1 = await bayarAngsuran({ pinjamanId, jadwalId: jadwal[0].id, tanggal: jadwal[0].tanggalJatuhTempo, nominal: jadwal[0].total, sumberDana: 'KAS', createdBy: USER_ID });
    const b2 = await bayarAngsuran({ pinjamanId, jadwalId: jadwal[1].id, tanggal: jadwal[1].tanggalJatuhTempo, nominal: jadwal[1].total, sumberDana: 'KAS', createdBy: USER_ID });

    const cek1 = await periksaKoreksiTransaksi(testDb as never, b1.journalId);
    expect(cek1!.boleh).toBe(false);
    expect(cek1!.alasanTolak.join(' ')).toMatch(/pembayaran sesudahnya/);

    const kas = await saldoGl(testDb, ACC.kas);
    const sebagian = 500_000;
    const h = await koreksiAngsuran({
      journalId: b2.journalId, alasan: 'anggota hanya membayar 500.000', userId: USER_ID,
      bayarUlang: { tanggal: jadwal[1].tanggalJatuhTempo, nominal: sebagian, sumberDana: 'KAS' },
    });
    expect(await saldoGl(testDb, ACC.kas)).toBe(kas - jadwal[1].total + sebagian);
    const j2 = await testDb.getFirstAsync<any>(`SELECT status, pokok_terbayar, jasa_terbayar FROM angsuran_jadwal WHERE id = ?`, jadwal[1].id);
    expect(j2.status).toBe('SEBAGIAN');
    expect(Number(j2.pokok_terbayar) + Number(j2.jasa_terbayar)).toBe(sebagian);
    // Baris pembalik bernilai negatif: penjumlahan pembayaran = pembayaran yang berlaku.
    const tot = await testDb.getFirstAsync<any>(`SELECT SUM(nominal) n, SUM(porsi_jasa) jasa FROM angsuran_pembayaran WHERE pinjaman_id = ?`, pinjamanId);
    expect(Number(tot.n)).toBe(jadwal[0].total + sebagian);
    expect(Number(tot.jasa)).toBe(jadwal[0].jasa + Number(j2.jasa_terbayar));
    expect((await jurnal(h.journalPembalikId)).reversal_of_id).toBe(b2.journalId);
    expect(await seimbang()).toBe(true);
  });

  test('pembayaran yang melunasi pinjaman dibalik -> pinjaman kembali AKTIF', async () => {
    const { pinjamanId } = await siapkanPinjaman(1);
    const [j] = await getJadwalAngsuran(pinjamanId);
    const b = await bayarAngsuran({ pinjamanId, jadwalId: j.id, tanggal: j.tanggalJatuhTempo, nominal: j.total, sumberDana: 'KAS', createdBy: USER_ID });
    expect((await testDb.getFirstAsync<any>(`SELECT status FROM pinjaman WHERE id = ?`, pinjamanId)).status).toBe('LUNAS');
    await koreksiAngsuran({ journalId: b.journalId, alasan: 'salah anggota, bukan pinjaman ini', userId: USER_ID });
    expect((await testDb.getFirstAsync<any>(`SELECT status FROM pinjaman WHERE id = ?`, pinjamanId)).status).toBe('AKTIF');
    const jj = await testDb.getFirstAsync<any>(`SELECT status, pokok_terbayar, jasa_terbayar FROM angsuran_jadwal WHERE id = ?`, j.id);
    expect(jj).toMatchObject({ status: 'BELUM_BAYAR', pokok_terbayar: 0, jasa_terbayar: 0 });
    expect(await saldoGl(testDb, ACC.piutangPokok)).toBe(12_000_000);
  });

  test('akrual jasa periode itu dihitung SESUDAH pembayaran -> ditolak', async () => {
    const { pinjamanId } = await siapkanPinjaman();
    const [j] = (await getJadwalAngsuran(pinjamanId)).sort((x, y) => x.nomorAngsuran - y.nomorAngsuran);
    // Jasa angsuran 1 = Rp120.000; dibayar 50.000 -> sisa jasa 70.000 diakru sesudahnya.
    const b = await bayarAngsuran({ pinjamanId, jadwalId: j.id, tanggal: j.tanggalJatuhTempo, nominal: 50_000, sumberDana: 'KAS', createdBy: USER_ID });
    expect((await periksaKoreksiTransaksi(testDb as never, b.journalId))!.boleh).toBe(true);
    const periode = j.tanggalJatuhTempo.slice(0, 7);
    const ak = await prosesAkrualJasaPinjaman({ pinjamanId, periode, createdBy: USER_ID, tanggalLaporan: `${periode}-28` });
    expect(ak.dibuat).toBe(true);
    const cek = await periksaKoreksiTransaksi(testDb as never, b.journalId);
    expect(cek!.boleh).toBe(false);
    expect(cek!.alasanTolak.join(' ')).toMatch(/Akrual jasa periode/);
  });

  test('pengguna tanpa izin History Transaksi (edit) ditolak', async () => {
    const asal = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID, tanggal: '2026-02-01', pokok: 0, wajib: 50_000, sukarela: 0, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('petugas','Petugas','petugas','PETUGAS','x','x',0,1,?,?)`, now, now
    );
    await expect(koreksiSetoranSimpanan({ journalId: asal.journalId, alasan: 'tidak berwenang', userId: 'petugas' })).rejects.toThrow();
    expect((await jurnal(asal.journalId)).status).toBe('POSTED');
  });
});
