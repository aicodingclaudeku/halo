import { createTestDb, TestDb } from './testDb';
import { seedKebijakanProdukUji } from './kebijakanProdukBerjangkaUji';

/**
 * RC-S128 — LIFECYCLE SIMPANAN BERJANGKA DENGAN KEBIJAKAN PRODUK
 * & BUNGA PASCA JATUH TEMPO (integrasi, SQLite + skema produksi).
 *
 * Skenario utama: Rp10.000.000, mulai 15 Juli 2026, tenor 6 bulan, rate
 * kontrak 6%/th (Rp50.000/bulan, total Rp300.000), jatuh tempo 15 Januari
 * 2027. Kebijakan: bunga pasca jatuh tempo 4%/th (Rp33.333/bulan), tanpa
 * perpanjangan otomatis, bunga ke Simpanan Sukarela. Aplikasi baru dibuka
 * lagi 20 Agustus 2027.
 */
let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { setorSimpananBerjangka, getSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  cairkanSimpananBerjangka,
  getRincianBungaKontrak,
  getRingkasanPencairan,
  getStatusPeriodeBungaAnggota,
  getTotalUtangBungaBerjangka,
  prosesAkrualBungaSemuaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  TRANSAKSI_BUNGA_TRANSFER,
} from '@/services/SimpananBerjangkaLifecycleService';
import { jalankanCatchUpAkrualSimpananBerjangka, _resetCatchUpUntukTest } from '@/services/SimpananBerjangkaCatchUpService';
import {
  cabutKebijakanProduk,
  simpanKebijakanProduk,
  terapkanKebijakanKeKontrakLegacy,
} from '@/services/SimpananBerjangkaKebijakanProdukService';
import { getSaldoSimpanan } from '@/services/SimpananService';
import { listBuktiPotongPphBungaSimpanan, getPosisiPphBungaBulananPadaDb } from '@/services/PphPotongService';
import { hitungPphBungaSimpanan } from '@/config/pajakPolicy';
import {
  periodePascaJatuhTempoEarned,
  hitungBungaPascaJatuhTempoSatuPeriode,
} from '@/accounting/SimpananBerjangkaBunga';
import { validasiDrafKebijakanProduk, pilihKebijakanUntukTanggal } from '@/accounting/SimpananBerjangkaKebijakanProduk';
import { resetDataTransaksiPadaDb } from '@/services/ResetDataTransaksi';

const now = () => new Date().toISOString();
const U = 'user-1';

async function akun(id: string, kode: string, nama: string, kat: string, nb: string) {
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kat, nb, now(), now()
  );
}
async function map(tt: string, role: string, acc: string) {
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `m-${tt}-${role}`, tt, role, acc);
}

async function siapkan() {
  _resetCatchUpUntukTest();
  testDb = await createTestDb();
  await akun('acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT');
  await akun('acc-2-1210', '2-1210', 'Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await akun('acc-2-1200', '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');
  await akun('acc-2-1710', '2-1710', 'Utang Bunga Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await akun('acc-5-1955', '5-1955', 'Beban Bunga Simpanan Berjangka', 'BEBAN', 'DEBIT');
  await map('KAS_UMUM', 'DEFAULT', 'acc-kas');
  await map('SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', 'acc-2-1210');
  await map('SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', 'acc-2-1200');
  await map('SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN', 'acc-5-1955');
  await map('SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', 'acc-2-1710');
  await map('SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_POKOK', 'acc-2-1210');
  await map('SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_UTANG_BUNGA', 'acc-2-1710');
  for (const t of [2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${t}`, t, `${t}-01-01`, `${t}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now(), now()
  );
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('ang-A','A001','NIK-A','Anggota A','2020-01-01','AKTIF',?,?)`,
    now(), now()
  );
}

async function saldoAkun(kode: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit),0) s FROM journal_entry je JOIN account a ON a.id = je.account_id
      JOIN journal j ON j.id = je.journal_id WHERE a.kode = ? AND j.status IN ('POSTED','REVERSED')`,
    kode
  );
  return r?.s ?? 0;
}
const saldoSukarela = () => getSaldoSimpanan(testDb as never, 'ang-A', 'SUKARELA');
const barisBunga = (id: string) =>
  testDb.getAllAsync<{ nomor_periode: number; tanggal_akhir_periode: string; bunga: number; jenis_periode: string; rate_persen: number }>(
    `SELECT nomor_periode, tanggal_akhir_periode, bunga, jenis_periode, rate_persen FROM simpanan_berjangka_bunga
      WHERE simpanan_berjangka_id = ? ORDER BY nomor_periode`,
    id
  );

async function kontrakUtama(pokok = 10_000_000): Promise<string> {
  return (
    await setorSimpananBerjangka({
      anggotaId: 'ang-A', nominal: pokok, tenorBulan: 6, sukuBungaPerTahun: 6,
      tanggal: '2026-07-15', sumberDana: 'KAS', createdBy: U,
    })
  ).id;
}

// ---------------------------------------------------------------------------
// A. Fungsi murni
// ---------------------------------------------------------------------------
describe('RC-S128 §A — periode pasca jatuh tempo (murni)', () => {
  test('bunga satu periode = pokok x rate x 1/12, dibulatkan; pokok asli', () => {
    expect(hitungBungaPascaJatuhTempoSatuPeriode(10_000_000, 4)).toBe(33_333);
    expect(hitungBungaPascaJatuhTempoSatuPeriode(10_000_000, 6)).toBe(50_000);
  });

  test('periode pertama mulai tepat pada tanggal jatuh tempo; hanya bulan kalender penuh', () => {
    const p = periodePascaJatuhTempoEarned({ pokok: 10_000_000, tenorBulan: 6, tanggalMulai: '2026-07-15', ratePascaPerTahun: 4, sampaiTanggal: '2027-03-14' });
    expect(p.map((x) => [x.nomorPeriode, x.tanggalAwalPeriode, x.tanggalAkhirPeriode])).toEqual([[7, '2027-01-15', '2027-02-15']]);
  });

  test('kalender konsisten dengan jadwal kontrak: anchor ke tanggal mulai (31 Agu -> 28 Feb -> 31 Mar)', () => {
    const p = periodePascaJatuhTempoEarned({ pokok: 1_200_000, tenorBulan: 6, tanggalMulai: '2026-08-31', ratePascaPerTahun: 12, sampaiTanggal: '2027-05-31' });
    expect(p.map((x) => x.tanggalAkhirPeriode)).toEqual(['2027-03-31', '2027-04-30', '2027-05-31']);
    expect(p[0].tanggalAwalPeriode).toBe('2027-02-28'); // = tanggal jatuh tempo kontrak
  });

  test('mulai efektif (kontrak legacy): periode yang dimulai sebelum tanggal efektif tidak diakui', () => {
    const p = periodePascaJatuhTempoEarned({ pokok: 1_200_000, tenorBulan: 3, tanggalMulai: '2026-01-10', ratePascaPerTahun: 12, sampaiTanggal: '2026-08-10', mulaiEfektif: '2026-06-01' });
    expect(p.map((x) => x.tanggalAwalPeriode)).toEqual(['2026-06-10', '2026-07-10']);
  });

  test('validasi kebijakan: auto-renewal ditolak, rate wajib bila pasca aktif, tanpa rate bawaan', () => {
    const dasar = { versi: 'V1', berlakuMulai: '2026-01-01', autoRenewal: false, bungaPascaJatuhTempoAktif: true, ratePascaJatuhTempo: null, dasarPenetapan: 'SK', ditetapkanOleh: 'Pengurus', ditetapkanPada: '2026-01-01' };
    expect(validasiDrafKebijakanProduk(dasar).join(' ')).toMatch(/Rate bunga pasca jatuh tempo wajib/);
    expect(validasiDrafKebijakanProduk({ ...dasar, ratePascaJatuhTempo: 3, autoRenewal: true }).join(' ')).toMatch(/Perpanjangan otomatis belum didukung/);
    expect(validasiDrafKebijakanProduk({ ...dasar, ratePascaJatuhTempo: 3 })).toEqual([]);
  });

  test('hanya satu kebijakan berlaku per tanggal: versi aktif dengan berlaku_mulai terbesar <= tanggal', () => {
    const k = (versi: string, berlakuMulai: string, status: 'AKTIF' | 'DICABUT' = 'AKTIF') => ({ id: versi, versi, berlakuMulai, status } as any);
    const daftar = [k('V1', '2026-01-01'), k('V2', '2026-07-01'), k('V3', '2026-09-01', 'DICABUT')];
    expect(pilihKebijakanUntukTanggal(daftar, '2025-12-31')).toBeNull();
    expect(pilihKebijakanUntukTanggal(daftar, '2026-06-30')?.versi).toBe('V1');
    expect(pilihKebijakanUntukTanggal(daftar, '2026-10-01')?.versi).toBe('V2');
  });
});

// ---------------------------------------------------------------------------
// B. Skenario utama
// ---------------------------------------------------------------------------
describe('RC-S128 §B — Rp10 jt Juli 2026, tenor 6, jatuh tempo Januari 2027, catch-up Agustus 2027', () => {
  beforeEach(async () => {
    await siapkan();
    await seedKebijakanProdukUji(testDb, { versi: 'KBP-2026-01', bungaPasca: true, ratePasca: 4 });
  });

  test('snapshot kebijakan tersimpan di kontrak saat penempatan', async () => {
    const id = await kontrakUtama();
    const k = await getSimpananBerjangka(id);
    expect(k).toMatchObject({
      tanggalJatuhTempo: '2027-01-15', statusPolicy: 'POLICY_SNAPSHOT', policyVersi: 'KBP-2026-01',
      rateKontrak: 6, ratePascaJatuhTempo: 4, autoRenewal: false, bungaPascaAktif: true, bungaDikreditkanKe: 'SIMPANAN_SUKARELA',
    });
  });

  test('bunga kontrak hanya sampai akhir tenor; setelah jatuh tempo muncul periode pasca sesuai rate kebijakan', async () => {
    const id = await kontrakUtama();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-01-20');
    let b = await barisBunga(id);
    expect(b.filter((x) => x.jenis_periode === 'KONTRAK').map((x) => x.bunga)).toEqual([50_000, 50_000, 50_000, 50_000, 50_000, 50_000]);
    expect(b.filter((x) => x.jenis_periode === 'KONTRAK').pop()!.tanggal_akhir_periode).toBe('2027-01-15');
    expect(b.filter((x) => x.jenis_periode === 'PASCA_JATUH_TEMPO')).toHaveLength(0); // periode pasca pertama belum genap

    _resetCatchUpUntukTest();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-02-15');
    b = await barisBunga(id);
    expect(b.filter((x) => x.jenis_periode === 'PASCA_JATUH_TEMPO')).toEqual([
      { nomor_periode: 7, tanggal_akhir_periode: '2027-02-15', bunga: 33_333, jenis_periode: 'PASCA_JATUH_TEMPO', rate_persen: 4 },
    ]);
  });

  test('offline sampai 20 Agustus 2027: seluruh 7 periode pasca di-catch-up sekali, berurutan, idempoten', async () => {
    const id = await kontrakUtama();
    const h1 = await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-08-20');
    expect(h1.gagal).toEqual([]);
    const pasca = (await barisBunga(id)).filter((x) => x.jenis_periode === 'PASCA_JATUH_TEMPO');
    expect(pasca.map((x) => x.nomor_periode)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(pasca.map((x) => x.tanggal_akhir_periode)).toEqual(['2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15', '2027-06-15', '2027-07-15', '2027-08-15']);

    const jurnalSebelum = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
    for (let i = 0; i < 3; i++) {
      _resetCatchUpUntukTest();
      await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-08-20');
    }
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n).toBe(jurnalSebelum);
    expect(await barisBunga(id)).toHaveLength(13);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM simpanan_transaksi WHERE idempotency_key LIKE 'SBT-%'`))!.n).toBe(13);
  });

  test('bunga yang menjadi hak anggota masuk Simpanan Sukarela; jurnal transfer selalu Dr 2-1710 / Cr 2-1200', async () => {
    await kontrakUtama();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-08-20');
    const total = 300_000 + 7 * 33_333;
    expect(await saldoSukarela()).toBe(total); // di bawah batas PPh -> neto = bruto
    expect(await saldoAkun('2-1200')).toBe(total); // subledger = buku besar
    expect(await saldoAkun('2-1710')).toBe(0);
    expect(await getTotalUtangBungaBerjangka()).toBe(0);

    const baris = await testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
      `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        JOIN account a ON a.id = je.account_id WHERE j.sumber_transaksi = ?`,
      TRANSAKSI_BUNGA_TRANSFER
    );
    expect(new Set(baris.filter((x) => x.debit > 0).map((x) => x.kode))).toEqual(new Set(['2-1710']));
    expect(new Set(baris.filter((x) => x.kredit > 0).map((x) => x.kode))).toEqual(new Set(['2-1200']));
    // Tanpa beban baru saat pemindahan: beban hanya dari akrual.
    expect(-(await saldoAkun('5-1955'))).toBe(total);
  });

  test('pencairan setelah bunga dipindahkan hanya membayar POKOK; bunga tidak dibayar dua kali', async () => {
    const id = await kontrakUtama();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-08-20');
    const kasSebelum = -(await saldoAkun('1-1000'));
    const sukarelaSebelum = await saldoSukarela();

    const ringkas = await getRingkasanPencairan(id, '2027-08-20');
    expect(ringkas).toMatchObject({ pencairanPokokSaja: true, totalPencairan: 10_000_000, bungaBelumDipindahkan: 0, bungaSudahDiSukarela: 300_000 + 7 * 33_333 });

    const h = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2027-08-20', sumberDana: 'KAS', createdBy: U });
    expect(h).toMatchObject({ pokok: 10_000_000, bunga: 0, pajakDipotong: 0, totalDibayarBersih: 10_000_000, bungaDipindahkanSaatPencairan: 0 });
    expect(kasSebelum - -(await saldoAkun('1-1000'))).toBe(10_000_000);
    expect(await saldoSukarela()).toBe(sukarelaSebelum);
    expect(await saldoAkun('2-1210')).toBe(0);
    expect(await saldoAkun('2-1710')).toBe(0);
    const k = await getSimpananBerjangka(id);
    expect(k).toMatchObject({ status: 'DICAIRKAN', nominal: 10_000_000 });
  });

  test('pencairan sebelum transfer: catch-up + pemindahan terjadi DI DALAM pencairan, kas tetap pokok saja', async () => {
    const id = await kontrakUtama();
    await prosesJatuhTempoSimpananBerjangka('2027-01-15', U);
    const h = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2027-04-20', sumberDana: 'KAS', createdBy: U });
    expect(h.totalDibayarBersih).toBe(10_000_000);
    expect(h.bungaDipindahkanSaatPencairan).toBe(300_000 + 3 * 33_333);
    expect(await saldoSukarela()).toBe(300_000 + 3 * 33_333);
    expect(await saldoAkun('2-1710')).toBe(0);
    // Bulan April belum genap (15 Apr–15 Mei) -> tidak ada bunga penuh untuk periode itu.
    expect((await barisBunga(id)).map((x) => x.nomor_periode).pop()).toBe(9);
  });

  test('auto_renewal = FALSE: jatuh tempo bukan kontrak baru; pokok tidak bertambah karena bunga', async () => {
    const id = await kontrakUtama();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-08-20');
    const semua = await testDb.getAllAsync<{ id: string; nominal: number; status: string; tanggal_jatuh_tempo: string }>(
      `SELECT id, nominal, status, tanggal_jatuh_tempo FROM simpanan_berjangka`
    );
    expect(semua).toEqual([{ id, nominal: 10_000_000, status: 'JATUH_TEMPO', tanggal_jatuh_tempo: '2027-01-15' }]);
    expect(await saldoAkun('2-1210')).toBe(10_000_000);
    await expect(testDb.runAsync(`UPDATE simpanan_berjangka SET nominal = nominal + 1 WHERE id = ?`, id)).rejects.toThrow(/Pokok simpanan berjangka tidak dapat diubah/);
  });

  test('tanggal pencairan tidak boleh mundur ke belakang periode yang sudah diakui', async () => {
    const id = await kontrakUtama();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-08-20');
    await expect(cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2027-05-01', sumberDana: 'KAS', createdBy: U })).rejects.toThrow(/tidak boleh sebelum akhir periode bunga/);
  });

  test('rincian bunga membedakan tenor, pasca jatuh tempo, sudah di Sukarela, belum dipindahkan', async () => {
    const id = await kontrakUtama();
    await prosesAkrualBungaSemuaKontrak('2027-03-20', U);
    let r = await getRincianBungaKontrak(id, '2027-03-20');
    expect(r).toMatchObject({ bungaSelamaTenor: 300_000, bungaPascaJatuhTempo: 66_666, jumlahPeriodePasca: 2, bungaSudahKeSukarela: 0, bungaBelumDipindahkan: 366_666, tanggalPerhitunganTerakhir: '2027-03-15' });
    expect(r.periodeBerikutnya).toMatchObject({ nomorPeriode: 9, tanggalAkhir: '2027-04-15', jenis: 'PASCA_JATUH_TEMPO' });
    // Rekonsiliasi: utang bunga subledger = saldo 2-1710.
    expect(await getTotalUtangBungaBerjangka()).toBe(await saldoAkun('2-1710'));
    _resetCatchUpUntukTest();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-03-20');
    r = await getRincianBungaKontrak(id, '2027-03-20');
    expect(r).toMatchObject({ bungaSudahKeSukarela: 366_666, netoKeSukarela: 366_666, bungaBelumDipindahkan: 0 });
    const status = await getStatusPeriodeBungaAnggota('ang-A', '2027-03-20');
    expect(status.filter((s) => s.jenisPeriode === 'PASCA_JATUH_TEMPO').map((s) => s.status)).toEqual(['SUDAH_DIPINDAHKAN', 'SUDAH_DIPINDAHKAN', 'BELUM_JATUH_TEMPO']);
  });
});

// ---------------------------------------------------------------------------
// C. Pajak — tetap agregat lintas produk (RC-S127)
// ---------------------------------------------------------------------------
describe('RC-S128 §C — PPh bunga pasca jatuh tempo memakai mesin pajak agregat yang sama', () => {
  beforeEach(siapkan);

  test('pokok 100 jt @4% pasca (333.333/bulan > batas): PPh 10%, bukti potong per masa, neto ke Sukarela', async () => {
    await seedKebijakanProdukUji(testDb, { bungaPasca: true, ratePasca: 4 });
    await kontrakUtama(100_000_000); // bunga kontrak 500.000/bulan
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-03-20');
    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2027);
    const pasca = bukti.filter((b) => b.nomorPeriode > 6).sort((a, b) => a.nomorPeriode - b.nomorPeriode);
    expect(pasca.map((b) => [b.masaPajak, b.bruto, b.pajak, b.netto])).toEqual([
      ['2027-02', 333_333, 33_333, 300_000],
      ['2027-03', 333_333, 33_333, 300_000],
    ]);
    for (const m of ['2026-08', '2027-02', '2027-03']) {
      const pos = await getPosisiPphBungaBulananPadaDb(testDb as any, 'ang-A', m);
      expect(pos.pajakSudah).toBe(hitungPphBungaSimpanan(pos.brutoSudah));
    }
    expect(await saldoSukarela()).toBe(await saldoAkun('2-1200'));
  });

  test('bunga di bawah batas: bukti potong tetap tercatat dengan tarif 0%', async () => {
    await seedKebijakanProdukUji(testDb, { bungaPasca: true, ratePasca: 4 });
    await kontrakUtama();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-02-20');
    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2027);
    expect(bukti.find((b) => b.nomorPeriode === 7)).toMatchObject({ bruto: 33_333, pajak: 0, netto: 33_333 });
  });
});

// ---------------------------------------------------------------------------
// D. Kebijakan: wajib, append-only, snapshot, legacy
// ---------------------------------------------------------------------------
describe('RC-S128 §D — kebijakan produk berversi & kontrak legacy', () => {
  beforeEach(siapkan);

  test('tanpa kebijakan yang berlaku pada tanggal penempatan: penempatan ditolak', async () => {
    await seedKebijakanProdukUji(testDb, { berlakuMulai: '2026-08-01', bungaPasca: true, ratePasca: 4 });
    await expect(kontrakUtama()).rejects.toThrow(/belum ditetapkan/);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n).toBe(0);
  });

  test('kebijakan baru tidak mengubah snapshot kontrak lama; snapshot & kebijakan terkunci trigger', async () => {
    const v1 = await seedKebijakanProdukUji(testDb, { versi: 'V1', bungaPasca: true, ratePasca: 4 });
    const id = await kontrakUtama();
    await simpanKebijakanProduk({
      versi: 'V2', berlakuMulai: '2026-09-01', autoRenewal: false, bungaPascaJatuhTempoAktif: true, ratePascaJatuhTempo: 2,
      dasarPenetapan: 'SK Pengurus 7/2026', ditetapkanOleh: 'Ketua', ditetapkanPada: '2026-08-25', createdBy: U,
    });
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-03-20');
    expect((await getSimpananBerjangka(id))).toMatchObject({ policyVersi: 'V1', ratePascaJatuhTempo: 4 });
    expect((await barisBunga(id)).filter((x) => x.jenis_periode === 'PASCA_JATUH_TEMPO').every((x) => x.bunga === 33_333)).toBe(true);

    await expect(testDb.runAsync(`UPDATE simpanan_berjangka SET policy_rate_pasca_jatuh_tempo = 9 WHERE id = ?`, id)).rejects.toThrow(/Snapshot kebijakan/);
    await expect(testDb.runAsync(`UPDATE simpanan_berjangka_kebijakan_produk SET rate_pasca_jatuh_tempo = 9 WHERE id = ?`, v1)).rejects.toThrow(/tidak dapat diubah/);
    await expect(testDb.runAsync(`DELETE FROM simpanan_berjangka_kebijakan_produk WHERE id = ?`, v1)).rejects.toThrow(/append-only/);
    await expect(cabutKebijakanProduk({ id: v1, alasan: 'uji', createdBy: U })).rejects.toThrow(/sudah dipakai/);
  });

  test('database: kontrak tidak dapat menempel ke kebijakan yang sudah DICABUT; status hanya AKTIF -> DICABUT', async () => {
    const v1 = await seedKebijakanProdukUji(testDb, { versi: 'V1', bungaPasca: true, ratePasca: 4 });
    await cabutKebijakanProduk({ id: v1, alasan: 'salah ketik', createdBy: U });
    await expect(
      testDb.runAsync(
        `INSERT INTO simpanan_berjangka (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal, tenor_bulan,
           suku_bunga, status, sumber_dana, created_by, created_at, updated_at, policy_id)
         VALUES ('x','ang-A','SPB-X','2026-07-15','2027-01-15',1000,6,0,'AKTIF','KAS','user-1',?,?,?)`,
        now(), now(), v1
      )
    ).rejects.toThrow(/kebijakan produk yang AKTIF/);
    await expect(testDb.runAsync(`UPDATE simpanan_berjangka_kebijakan_produk SET status = 'AKTIF' WHERE id = ?`, v1)).rejects.toThrow(/AKTIF ke DICABUT/);
  });

  test('simpanKebijakanProduk: tanpa rate pasca ditolak; versi/tanggal ganda ditolak; versi belum dipakai bisa dicabut', async () => {
    const dasar = {
      versi: 'A', berlakuMulai: '2026-01-01', autoRenewal: false, bungaPascaJatuhTempoAktif: true, ratePascaJatuhTempo: null as number | null,
      dasarPenetapan: 'SK', ditetapkanOleh: 'Ketua', ditetapkanPada: '2026-01-01', createdBy: U,
    };
    await expect(simpanKebijakanProduk(dasar)).rejects.toThrow(/wajib diisi/);
    const k = await simpanKebijakanProduk({ ...dasar, ratePascaJatuhTempo: 3 });
    await expect(simpanKebijakanProduk({ ...dasar, ratePascaJatuhTempo: 3 })).rejects.toThrow(/sudah ada/);
    await expect(simpanKebijakanProduk({ ...dasar, versi: 'B', ratePascaJatuhTempo: 3 })).rejects.toThrow(/berlaku mulai 2026-01-01/);
    await cabutKebijakanProduk({ id: k.id, alasan: 'salah ketik', createdBy: U });
    await simpanKebijakanProduk({ ...dasar, versi: 'B', ratePascaJatuhTempo: 3 });
  });

  test('kontrak legacy tanpa penerapan kebijakan: jalur pencairan lama tidak berubah (sisa bunga dibayar tunai)', async () => {
    await testDb.runAsync(
      `INSERT INTO simpanan_berjangka (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal, tenor_bulan,
         suku_bunga, status, sumber_dana, created_by, created_at, updated_at)
       VALUES ('lama2','ang-A','SPB-LAMA2','2026-01-15','2026-04-15',12000000,3,12,'AKTIF','KAS','user-1',?,?)`,
      now(), now()
    );
    await prosesJatuhTempoSimpananBerjangka('2026-04-15', U);
    const h = await cairkanSimpananBerjangka({ kontrakId: 'lama2', tanggal: '2026-09-01', sumberDana: 'KAS', createdBy: U });
    expect(h).toMatchObject({ pokok: 12_000_000, bunga: 360_000, bungaDipindahkanSaatPencairan: 0 });
    expect(await barisBunga('lama2')).toHaveLength(3); // tanpa periode pasca jatuh tempo
    expect(await saldoSukarela()).toBe(0);
  });

  test('kontrak legacy: tidak diberi bunga pasca diam-diam; penerapan eksplisit tercatat dan tanpa backfill', async () => {
    // Kontrak sebelum v79: tanpa kolom kebijakan (status_policy DEFAULT legacy).
    await testDb.runAsync(
      `INSERT INTO simpanan_berjangka (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal, tenor_bulan,
         suku_bunga, status, sumber_dana, created_by, created_at, updated_at)
       VALUES ('lama','ang-A','SPB-LAMA','2026-01-15','2026-04-15',12000000,3,0,'JATUH_TEMPO','KAS','user-1',?,?)`,
      now(), now()
    );
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2026-12-31');
    expect(await barisBunga('lama')).toHaveLength(0);
    expect((await getSimpananBerjangka('lama'))!.statusPolicy).toBe('LEGACY_POLICY_REVIEW_REQUIRED');

    const pid = await seedKebijakanProdukUji(testDb, { versi: 'V1', berlakuMulai: '2026-06-01', bungaPasca: true, ratePasca: 12 });
    await expect(
      terapkanKebijakanKeKontrakLegacy({ kontrakId: 'lama', policyId: pid, tanggalEfektif: '2026-05-01', alasan: 'RAT', ditetapkanOleh: 'Ketua', createdBy: U })
    ).rejects.toThrow(/tidak boleh sebelum/);
    await terapkanKebijakanKeKontrakLegacy({ kontrakId: 'lama', policyId: pid, tanggalEfektif: '2026-09-01', alasan: 'Keputusan RAT 2026', ditetapkanOleh: 'Ketua', createdBy: U });
    const pen = await testDb.getFirstAsync<any>(`SELECT * FROM simpanan_berjangka_penerapan_kebijakan WHERE simpanan_berjangka_id = 'lama'`);
    expect(pen).toMatchObject({ policy_versi: 'V1', tanggal_efektif: '2026-09-01', alasan: 'Keputusan RAT 2026', ditetapkan_oleh: 'Ketua' });
    await expect(testDb.runAsync(`UPDATE simpanan_berjangka_penerapan_kebijakan SET alasan = 'x'`)).rejects.toThrow(/append-only/);

    _resetCatchUpUntukTest();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2026-12-31');
    // Periode pasca bulanan dari 15 tiap bulan; hanya yang DIMULAI >= 1 Sep: 15 Sep–15 Okt, 15 Okt–15 Nov, 15 Nov–15 Des.
    expect((await barisBunga('lama')).map((x) => [x.tanggal_akhir_periode, x.bunga, x.jenis_periode])).toEqual([
      ['2026-10-15', 120_000, 'PASCA_JATUH_TEMPO'],
      ['2026-11-15', 120_000, 'PASCA_JATUH_TEMPO'],
      ['2026-12-15', 120_000, 'PASCA_JATUH_TEMPO'],
    ]);
    expect((await getSimpananBerjangka('lama'))!.statusPolicy).toBe('LEGACY_POLICY_DITERAPKAN');
  });

  test('Reset Data mode Transaksi tetap berjalan: kontrak, periode & penerapan dihapus; kebijakan produk dipertahankan', async () => {
    const pid = await seedKebijakanProdukUji(testDb, { versi: 'V1', bungaPasca: true, ratePasca: 4 });
    await kontrakUtama();
    await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-03-20');
    await testDb.runAsync(
      `INSERT INTO simpanan_berjangka (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal, tenor_bulan,
         suku_bunga, status, sumber_dana, created_by, created_at, updated_at)
       VALUES ('lama','ang-A','SPB-LAMA','2026-01-15','2026-04-15',12000000,3,0,'JATUH_TEMPO','KAS','user-1',?,?)`,
      now(), now()
    );
    await terapkanKebijakanKeKontrakLegacy({ kontrakId: 'lama', policyId: pid, tanggalEfektif: '2026-09-01', alasan: 'RAT', ditetapkanOleh: 'Ketua', createdBy: U });
    const hasil = await resetDataTransaksiPadaDb(testDb as any);
    expect(hasil.terhapus['simpanan_berjangka']).toBe(2);
    expect(hasil.terhapus['simpanan_berjangka_penerapan_kebijakan']).toBe(1);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM simpanan_berjangka_kebijakan_produk`))!.n).toBe(1);
  });
});
