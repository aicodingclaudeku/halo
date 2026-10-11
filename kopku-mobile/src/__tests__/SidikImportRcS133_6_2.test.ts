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
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import { periksaSebelumImport } from '@/import/PanduanImportData';
import { muatSidikTercatat } from '@/import/RiwayatImportRepository';
import { bandingkanSidik, hitungSidikBerkas, sha256Hex } from '@/import/SidikImport';
import { TABEL_RESET_TRANSAKSI } from '@/services/ResetDataPlan';

/**
 * RC-S133.6.2 — PENCEGAHAN IMPORT GANDA DENGAN SIDIK ISI BARIS (v81).
 *
 * Temuan audit T-05 (dibuktikan lewat UI): berkas yang sama tanpa NIK
 * diimpor dua kali -> anggota, simpanan, dan pinjaman tercatat dua kali.
 * Keputusan pengguna: sidik isi data disimpan PERMANEN, bukan nama berkas
 * atau NIK; berkas identik ditolak walau namanya berubah; import yang gagal
 * sebagian dapat dilanjutkan tanpa menggandakan baris yang sudah masuk.
 */
const HDR_A = ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *', 'NIK'];
const HDR_S = ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana', 'Rekening Bank'];
const HDR_P = ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Angsuran Sudah Dibayar'];

function berkas(opts: { kodeA?: string; kodeB?: string; rekeningB?: string; pinjamanB?: number; angsuranDibayar?: number } = {}) {
  const a = opts.kodeA ?? 'K1';
  const b = opts.kodeB ?? 'K2';
  return parseBerkasDataAwal({
    ANGGOTA: [HDR_A, [a, 'Siti Aminah', '2026-01-05', null], [b, 'Budi  Santoso', '2026-01-05', null]],
    SIMPANAN: [
      HDR_S,
      [a, '2026-01-06', 100000, 50000, 0, 'KAS', null],
      [b, '2026-01-06', 100000, 50000, 25000, opts.rekeningB ? 'BANK' : 'KAS', opts.rekeningB ?? null],
    ],
    PINJAMAN: [HDR_P, [a, '2026-01-10', opts.pinjamanB ?? 3000000, 10, 'BULAN', 'FLAT', 1, 'KAS', opts.angsuranDibayar ?? 0]],
  });
}

async function hitung(t: string, where = ''): Promise<number> {
  return Number((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM ${t} ${where}`))!.n);
}

describe('RC-S133.6.2 — sidik isi baris (murni)', () => {
  test('SHA-256 sesuai vektor uji FIPS 180-4', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('Kode Anggota (lokal berkas) dan spasi nama tidak mengubah sidik; isi yang berubah mengubah sidik', () => {
    const x = hitungSidikBerkas(berkas().hasil);
    const y = hitungSidikBerkas(berkas({ kodeA: 'ZZ9', kodeB: 'QQ1' }).hasil);
    expect(y.perBaris.map((b) => b.sidik)).toEqual(x.perBaris.map((b) => b.sidik));
    expect(y.sidikBerkas).toBe(x.sidikBerkas);
    const z = hitungSidikBerkas(berkas({ pinjamanB: 2000000 }).hasil);
    expect(z.sidikBerkas).not.toBe(x.sidikBerkas);
    expect(z.peta.get('PINJAMAN:2')).not.toBe(x.peta.get('PINJAMAN:2'));
    expect(z.peta.get('SIMPANAN:2')).toBe(x.peta.get('SIMPANAN:2'));
  });

  test('kolom keadaan (angsuran sudah dibayar, sumber dana/rekening) tidak ikut sidik — pinjaman yang sama tetap dikenali', () => {
    const x = hitungSidikBerkas(berkas().hasil);
    const y = hitungSidikBerkas(berkas({ angsuranDibayar: 3, rekeningB: '123456' }).hasil);
    expect(y.peta.get('PINJAMAN:2')).toBe(x.peta.get('PINJAMAN:2'));
    expect(y.peta.get('SIMPANAN:3')).toBe(x.peta.get('SIMPANAN:3'));
  });

  test('isi identik dua kali di satu berkas dibedakan urutannya; berkas lain dengan satu salinan = kemunculan pertama', () => {
    const dua = parseBerkasDataAwal({
      ANGGOTA: [HDR_A, ['K1', 'Siti', '2026-01-05', null]],
      SIMPANAN: [HDR_S, ['K1', '2026-02-01', 0, 50000, 0, 'KAS', null], ['K1', '2026-02-01', 0, 50000, 0, 'KAS', null]],
    });
    const satu = parseBerkasDataAwal({
      ANGGOTA: [HDR_A, ['K7', 'Siti', '2026-01-05', null]],
      SIMPANAN: [HDR_S, ['K7', '2026-02-01', 0, 50000, 0, 'KAS', null]],
    });
    const sd = hitungSidikBerkas(dua.hasil);
    expect(sd.peta.get('SIMPANAN:2')).not.toBe(sd.peta.get('SIMPANAN:3'));
    expect(hitungSidikBerkas(satu.hasil).peta.get('SIMPANAN:2')).toBe(sd.peta.get('SIMPANAN:2'));
  });
});

describe('RC-S133.6.2 — eksekusi: import ganda ditolak di tingkat baris', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('berkas identik dengan NAMA BERBEDA dan anggota TANPA NIK: tidak ada satu baris pun tercatat dua kali', async () => {
    const r = berkas();
    const pertama = await jalankanImportDataAwal(r, { createdBy: USER_ID, namaBerkas: 'data-awal.xlsx', dbRiwayat: testDb as never });
    expect(pertama.totalGagal).toBe(0);
    expect(pertama.totalBerhasil).toBe(5);
    const sebelum = {
      anggota: await hitung('anggota'),
      pinjaman: await hitung('pinjaman'),
      simpanan: await hitung('simpanan_transaksi'),
      jurnal: await hitung('journal'),
    };
    expect(await hitung('import_data_awal_sidik')).toBe(5);

    // Kode anggota juga diganti — sidik memakai identitas, bukan kode.
    const kedua = await jalankanImportDataAwal(berkas({ kodeA: 'X1', kodeB: 'X2' }), {
      createdBy: USER_ID,
      namaBerkas: 'salinan (2).xlsx',
      dbRiwayat: testDb as never,
    });
    expect(kedua.totalBerhasil).toBe(0);
    expect(kedua.totalGagal).toBe(0);
    expect(kedua.totalDilewati).toBe(5);
    expect(kedua.dilewati![0].pesan).toMatch(/Sudah diimpor .* dari berkas "data-awal\.xlsx"/);
    expect({
      anggota: await hitung('anggota'),
      pinjaman: await hitung('pinjaman'),
      simpanan: await hitung('simpanan_transaksi'),
      jurnal: await hitung('journal'),
    }).toEqual(sebelum);

    const riw = await testDb.getAllAsync<any>(`SELECT nama_berkas, total_dilewati, sidik_berkas FROM import_data_awal_riwayat ORDER BY rowid`);
    expect(riw.map((x) => x.total_dilewati)).toEqual([0, 5]);
    expect(riw[0].sidik_berkas).toBe(riw[1].sidik_berkas);
    expect(await hitung('import_data_awal_sidik', 'WHERE riwayat_id IS NULL')).toBe(0);
  });

  test('import gagal sebagian dapat DILANJUTKAN: baris yang sudah masuk dilewati, hanya baris yang diperbaiki yang diproses', async () => {
    // Rekening "999" tidak ada -> setoran anggota kedua gagal.
    const h1 = await jalankanImportDataAwal(berkas({ rekeningB: '999' }), { createdBy: USER_ID, namaBerkas: 'a.xlsx', dbRiwayat: testDb as never });
    expect(h1.totalGagal).toBe(1);
    expect(h1.gagal[0].jenis).toBe('SIMPANAN');
    const jurnalSebelum = await hitung('journal');

    // Diperbaiki (rekening benar), berkas yang sama diimpor ulang.
    const h2 = await jalankanImportDataAwal(berkas({ rekeningB: '123456' }), { createdBy: USER_ID, namaBerkas: 'a-perbaikan.xlsx', dbRiwayat: testDb as never });
    expect(h2.totalBerhasil).toBe(1);
    expect(h2.totalGagal).toBe(0);
    expect(h2.totalDilewati).toBe(4);
    expect(h2.berhasil).toEqual([expect.objectContaining({ jenis: 'SIMPANAN', baris: 3 })]);
    expect(await hitung('journal')).toBe(jurnalSebelum + 1);
    expect(await hitung('anggota')).toBe(3 + 2);
    expect(await hitung('pinjaman')).toBe(1);
    // Saldo simpanan tiap anggota tidak berlipat.
    const saldo = await testDb.getAllAsync<any>(
      `SELECT a.nama_lengkap, SUM(st.nominal) total FROM simpanan_transaksi st JOIN anggota a ON a.id = st.anggota_id
       WHERE a.nomor_anggota NOT IN ('A001','A002','A003') GROUP BY a.nama_lengkap ORDER BY a.nama_lengkap`
    );
    expect(saldo).toEqual([
      { nama_lengkap: 'Budi  Santoso', total: 175000 },
      { nama_lengkap: 'Siti Aminah', total: 150000 },
    ]);
  });
});

describe('RC-S133.6.2 — pratinjau', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('seluruh baris sudah diimpor -> BLOKIR; sebagian -> PERINGATAN (baris lama dilewati, import tetap bisa jalan)', async () => {
    await jalankanImportDataAwal(berkas(), { createdBy: USER_ID, namaBerkas: 'data-awal.xlsx', dbRiwayat: testDb as never });

    const sama = berkas({ kodeA: 'B1' });
    const t1 = await muatSidikTercatat(testDb as never, hitungSidikBerkas(sama.hasil).perBaris.map((b) => b.sidik));
    const p1 = periksaSebelumImport(sama, { sifat: 'TRANSAKSI_BARU', sidikTercatat: t1 });
    const blokir = p1.find((p) => p.kunci === 'berkas-sudah-diimpor');
    expect(blokir?.tingkat).toBe('BLOKIR');
    expect(blokir?.pesan).toMatch(/Seluruh 5 baris .* berkas "data-awal\.xlsx"/);

    const tambah = parseBerkasDataAwal({
      ANGGOTA: [HDR_A, ['K1', 'Siti Aminah', '2026-01-05', null], ['K3', 'Dewi', '2026-02-01', null]],
      SIMPANAN: [HDR_S, ['K1', '2026-01-06', 100000, 50000, 0, 'KAS', null], ['K3', '2026-02-02', 100000, 50000, 0, 'KAS', null]],
    });
    const t2 = await muatSidikTercatat(testDb as never, hitungSidikBerkas(tambah.hasil).perBaris.map((b) => b.sidik));
    const p2 = periksaSebelumImport(tambah, { sifat: 'TRANSAKSI_BARU', sidikTercatat: t2 });
    expect(p2.find((p) => p.kunci === 'berkas-sudah-diimpor')).toBeUndefined();
    const sebagian = p2.find((p) => p.kunci === 'sebagian-sudah-diimpor');
    expect(sebagian?.tingkat).toBe('PERINGATAN');
    expect(sebagian?.judul).toMatch(/^2 baris sudah pernah diimpor/);
    expect(bandingkanSidik(hitungSidikBerkas(tambah.hasil), t2).baru).toHaveLength(2);
  });

  test('NIK milik anggota yang SUDAH diimpor dari berkas ini tidak memblokir lanjutan import', async () => {
    const r = parseBerkasDataAwal({ ANGGOTA: [HDR_A, ['K1', 'Rina', '2026-01-05', '3206000000009999'], ['K2', 'Tono', '2026-01-05', null]] });
    await jalankanImportDataAwal(r, { createdBy: USER_ID, dbRiwayat: testDb as never });
    const t = await muatSidikTercatat(testDb as never, hitungSidikBerkas(r.hasil).perBaris.map((b) => b.sidik));
    const tanpaSidik = periksaSebelumImport(r, { sifat: 'TRANSAKSI_BARU', nikTerdaftar: ['3206000000009999'] });
    expect(tanpaSidik.some((p) => p.kunci === 'nik-terdaftar')).toBe(true);
    const denganSidik = periksaSebelumImport(r, { sifat: 'TRANSAKSI_BARU', nikTerdaftar: ['3206000000009999'], sidikTercatat: t });
    expect(denganSidik.some((p) => p.kunci === 'nik-terdaftar')).toBe(false);
  });

  test('anggota tanpa NIK yang nama & tanggal bergabungnya sama dengan anggota lama (data sebelum v81) -> PERINGATAN tegas', () => {
    const r = parseBerkasDataAwal({ ANGGOTA: [HDR_A, ['K1', 'anggota  A001', '2020-01-01', null], ['K2', 'Baru', '2020-01-01', null]] });
    const p = periksaSebelumImport(r, {
      sifat: 'TRANSAKSI_BARU',
      anggotaTerdaftar: [{ nomorAnggota: 'A001', nama: 'Anggota A001', tanggalBergabung: '2020-01-01' }],
      sidikTercatat: new Map(),
    });
    const m = p.find((x) => x.kunci === 'anggota-mirip');
    expect(m?.tingkat).toBe('PERINGATAN');
    expect(m?.pesan).toMatch(/baris 2 anggota {2}A001 = A001/);
    expect(m?.pesan).not.toMatch(/Baru/);
  });
});

describe('RC-S133.6.2 — reset data', () => {
  test('tabel v81 terdaftar pada daftar hapus mode TRANSAKSI', () => {
    expect(TABEL_RESET_TRANSAKSI).toContain('import_data_awal_sidik');
    expect(TABEL_RESET_TRANSAKSI).toContain('koreksi_transaksi');
    expect(TABEL_RESET_TRANSAKSI.indexOf('koreksi_transaksi')).toBeLessThan(TABEL_RESET_TRANSAKSI.indexOf('journal'));
  });
});
