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

import { buatFixtureHistoris, USER_ID, ANGGOTA_ID, totalDebitKredit } from './historicalFixture';
import {
  catatPenyelesaianPinjaman,
  batalkanPenyelesaianPinjaman,
  getPenyelesaianPinjaman,
} from '@/services/PenyelesaianPinjamanService';
import { getPinjamanDetail } from '@/services/PinjamanService';
import { getKlasifikasiPinjamanAktif } from '@/services/LoanImpairmentService';
import { klasifikasikanSom } from '@/services/KolektibilitasSomService';
import {
  validasiPenyelesaian,
  tanggalIsoValid,
  ringkasPenyelesaian,
  LABEL_NOMOR_PENYELESAIAN,
} from '@/accounting/PenyelesaianPinjaman';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * RC-S133.6.4 §2 (v82) — PENCATATAN MANUAL PENYELESAIAN KE PENGADILAN / ASURANSI
 * (kriteria Macet angka 3, SOM 12.1).
 */

const HARI_INI = getTanggalLokalHariIni();
const PJ = 'pj-uji';
const now = () => new Date().toISOString();

async function tambahUser(id: string, role: string, aktif = 1) {
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES (?,?,?,?,'x','x',0,?,?,?)`,
    id, `User ${role}`, `u-${id}`, role, aktif, now(), now()
  );
}

/** Pinjaman AKTIF Rp10.000.000 (2 angsuran), belum menunggak pada 2026-03-01. */
async function sisipPinjamanAktif(status = 'AKTIF') {
  await testDb.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, persentase_jasa,
       tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    PJ, 'PJ-2026-000099', ANGGOTA_ID, '2026-02-01', 10_000_000, 2, 'BULAN', 'CUSTOM', 0, '2026-12-01', status, USER_ID, now(), now()
  );
  const jadwal: [number, string][] = [[1, '2026-11-01'], [2, '2026-12-01']];
  for (const [no, tempo] of jadwal) {
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES (?,?,?,?,5000000,0,0,5000000,'BELUM_BAYAR')`,
      `${PJ}-j${no}`, PJ, no, tempo
    );
  }
}

const isian = (extra: Record<string, unknown> = {}) => ({
  pinjamanId: PJ,
  jalur: 'PENGADILAN',
  tanggal: '2026-03-01',
  nomor: '123/Pdt.G/2026/PN Bandung',
  dokumen: 'Surat gugatan tgl 1-3-2026',
  alasan: 'Debitur tidak kooperatif',
  actingUserId: USER_ID,
  ...extra,
});

beforeEach(async () => {
  testDb = await buatFixtureHistoris();
  await sisipPinjamanAktif();
});

describe('aturan murni PenyelesaianPinjaman', () => {
  test('tanggalIsoValid menolak tanggal yang tidak ada di kalender', () => {
    expect(tanggalIsoValid('2026-02-28')).toBe(true);
    expect(tanggalIsoValid('2026-02-30')).toBe(false);
    expect(tanggalIsoValid('2026-13-01')).toBe(false);
    expect(tanggalIsoValid('01/02/2026')).toBe(false);
    expect(tanggalIsoValid('')).toBe(false);
  });

  test('validasi: semua isian wajib diisi manusia, tanggal tidak di masa depan / sebelum akad', () => {
    const v = validasiPenyelesaian({ jalur: '', tanggal: '', nomor: ' ', dokumen: '' }, '2026-10-11', '2026-02-01');
    expect(v.valid).toBe(false);
    if (v.valid) return;
    expect(v.galat.join(' ')).toMatch(/Jalur penyelesaian wajib dipilih/);
    expect(v.galat.join(' ')).toMatch(/Tanggal wajib diisi/);
    expect(v.galat.join(' ')).toMatch(/Nomor perkara \/ klaim wajib diisi/);
    expect(v.galat.join(' ')).toMatch(/Dokumen bukti wajib diisi/);

    const masaDepan = validasiPenyelesaian({ jalur: 'ASURANSI', tanggal: '2026-10-12', nomor: 'K1', dokumen: 'D' }, '2026-10-11');
    expect(masaDepan.valid).toBe(false);
    if (!masaDepan.valid) expect(masaDepan.galat[0]).toMatch(/masa depan/);

    const sebelumAkad = validasiPenyelesaian({ jalur: 'ASURANSI', tanggal: '2026-01-31', nomor: 'K1', dokumen: 'D' }, '2026-10-11', '2026-02-01');
    expect(sebelumAkad.valid).toBe(false);
    if (!sebelumAkad.valid) expect(sebelumAkad.galat[0]).toMatch(/sebelum tanggal akad/);
  });

  test('label nomor mengikuti jalur; isian dipangkas; keterangan opsional', () => {
    const v = validasiPenyelesaian({ jalur: 'ASURANSI', tanggal: '2026-03-01', nomor: '  K-1 ', dokumen: ' Surat klaim ', alasan: '  ' }, '2026-10-11');
    expect(v).toEqual({ valid: true, nilai: { jalur: 'ASURANSI', tanggal: '2026-03-01', nomor: 'K-1', dokumen: 'Surat klaim', alasan: null } });
    expect(LABEL_NOMOR_PENYELESAIAN.PENGADILAN).toBe('Nomor perkara');
    expect(LABEL_NOMOR_PENYELESAIAN.ASURANSI).toBe('Nomor klaim');
    const panjang = validasiPenyelesaian({ jalur: 'ASURANSI', tanggal: '2026-03-01', nomor: 'x'.repeat(101), dokumen: 'D' }, '2026-10-11');
    expect(panjang.valid).toBe(false);
  });

  test('ringkasPenyelesaian', () => {
    expect(ringkasPenyelesaian({ jalur: 'PENGADILAN', nomor: '1/Pdt', tanggal: '2026-03-01' })).toBe('Pengadilan Negeri no. 1/Pdt, tercatat 2026-03-01');
    expect(ringkasPenyelesaian({ jalur: 'ASURANSI' })).toBe('Klaim asuransi kredit');
  });
});

describe('catatPenyelesaianPinjaman', () => {
  test('Admin mencatat: kolom terisi, audit_log CATAT_PENYELESAIAN, status/jadwal/jurnal TIDAK berubah', async () => {
    const jurnalSebelum = await totalDebitKredit(testDb);
    const jurnalCount = (await testDb.getFirstAsync<any>(`SELECT COUNT(*) n FROM journal`)).n;
    const hasil = await catatPenyelesaianPinjaman(isian());

    expect(hasil).toMatchObject({ pinjamanId: PJ, jalur: 'PENGADILAN', tanggal: '2026-03-01', nomor: '123/Pdt.G/2026/PN Bandung', dicatatOleh: USER_ID });
    const row = await testDb.getFirstAsync<any>(`SELECT * FROM pinjaman WHERE id = ?`, PJ);
    expect(row).toMatchObject({
      penyelesaian_jalur: 'PENGADILAN',
      penyelesaian_tanggal: '2026-03-01',
      penyelesaian_nomor: '123/Pdt.G/2026/PN Bandung',
      penyelesaian_dokumen: 'Surat gugatan tgl 1-3-2026',
      penyelesaian_alasan: 'Debitur tidak kooperatif',
      penyelesaian_oleh: USER_ID,
      status: 'AKTIF',
    });
    // Tidak ada dampak akuntansi.
    expect((await testDb.getFirstAsync<any>(`SELECT COUNT(*) n FROM journal`)).n).toBe(jurnalCount);
    expect(await totalDebitKredit(testDb)).toEqual(jurnalSebelum);
    expect((await testDb.getAllAsync<any>(`SELECT status FROM angsuran_jadwal WHERE pinjaman_id = ?`, PJ)).map((j: any) => j.status)).toEqual(['BELUM_BAYAR', 'BELUM_BAYAR']);

    const audit = await testDb.getAllAsync<any>(`SELECT * FROM audit_log WHERE entity = 'pinjaman' AND entity_id = ?`, PJ);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'CATAT_PENYELESAIAN', user_id: USER_ID });
    expect(JSON.parse(audit[0].data_sebelum)).toBeNull();
    expect(JSON.parse(audit[0].data_sesudah)).toMatchObject({ jalur: 'PENGADILAN', nomor: '123/Pdt.G/2026/PN Bandung', nomorPinjaman: 'PJ-2026-000099' });
  });

  test('Pengurus boleh; Bendahara & Petugas & Anggota ditolak (izin pinjaman:approve), tanpa efek', async () => {
    await tambahUser('u-pengurus', 'PENGURUS');
    await tambahUser('u-bendahara', 'BENDAHARA');
    await tambahUser('u-petugas', 'PETUGAS');
    await tambahUser('u-anggota', 'ANGGOTA');

    for (const u of ['u-bendahara', 'u-petugas', 'u-anggota']) {
      await expect(catatPenyelesaianPinjaman(isian({ actingUserId: u }))).rejects.toThrow();
    }
    expect((await testDb.getFirstAsync<any>(`SELECT penyelesaian_jalur j FROM pinjaman WHERE id = ?`, PJ)).j).toBeNull();
    expect((await testDb.getFirstAsync<any>(`SELECT COUNT(*) n FROM audit_log`)).n).toBe(0);

    await expect(catatPenyelesaianPinjaman(isian({ actingUserId: 'u-pengurus' }))).resolves.toMatchObject({ dicatatOleh: 'u-pengurus' });
  });

  test('user nonaktif / tidak dikenal ditolak', async () => {
    await tambahUser('u-nonaktif', 'ADMIN', 0);
    await expect(catatPenyelesaianPinjaman(isian({ actingUserId: 'u-nonaktif' }))).rejects.toThrow();
    await expect(catatPenyelesaianPinjaman(isian({ actingUserId: 'tidak-ada' }))).rejects.toThrow();
  });

  test('hanya pinjaman AKTIF; status lain ditolak dengan pesan status', async () => {
    for (const status of ['DIAJUKAN', 'DISETUJUI', 'LUNAS', 'MACET', 'DITOLAK']) {
      await testDb.runAsync(`UPDATE pinjaman SET status = ? WHERE id = ?`, status, PJ);
      await expect(catatPenyelesaianPinjaman(isian())).rejects.toThrow(new RegExp(`hanya dapat dicatat untuk pinjaman berstatus AKTIF \\(status saat ini: ${status}\\)`));
    }
    await expect(catatPenyelesaianPinjaman(isian({ pinjamanId: 'tidak-ada' }))).rejects.toThrow(/Pinjaman tidak ditemukan/);
  });

  test('validasi: nomor/dokumen kosong, jalur salah, tanggal masa depan atau sebelum akad ditolak; tidak ada yang tertulis', async () => {
    const kasus: [Record<string, unknown>, RegExp][] = [
      [{ nomor: '  ' }, /wajib diisi/],
      [{ dokumen: '' }, /Dokumen bukti wajib/],
      [{ jalur: 'LAINNYA' }, /Jalur penyelesaian/],
      [{ tanggal: '2999-01-01' }, /masa depan/],
      [{ tanggal: '2026-01-15' }, /sebelum tanggal akad/],
      [{ tanggal: '2026-02-30' }, /format YYYY-MM-DD/],
    ];
    for (const [ubah, pola] of kasus) {
      await expect(catatPenyelesaianPinjaman(isian(ubah))).rejects.toThrow(pola);
    }
    expect((await testDb.getFirstAsync<any>(`SELECT penyelesaian_jalur j FROM pinjaman WHERE id = ?`, PJ)).j).toBeNull();
    expect((await testDb.getFirstAsync<any>(`SELECT COUNT(*) n FROM audit_log`)).n).toBe(0);
  });

  test('mencatat ulang = UBAH_PENYELESAIAN dengan data sebelum & sesudah di audit_log', async () => {
    await catatPenyelesaianPinjaman(isian());
    await catatPenyelesaianPinjaman(isian({ jalur: 'ASURANSI', tanggal: '2026-04-01', nomor: 'KLM-9', dokumen: 'Surat klaim' }));
    const audit = await testDb.getAllAsync<any>(`SELECT * FROM audit_log WHERE entity_id = ? ORDER BY created_at, rowid`, PJ);
    expect(audit.map((a: any) => a.action)).toEqual(['CATAT_PENYELESAIAN', 'UBAH_PENYELESAIAN']);
    expect(JSON.parse(audit[1].data_sebelum)).toMatchObject({ jalur: 'PENGADILAN', nomor: '123/Pdt.G/2026/PN Bandung' });
    expect(JSON.parse(audit[1].data_sesudah)).toMatchObject({ jalur: 'ASURANSI', nomor: 'KLM-9' });
    expect(await getPenyelesaianPinjaman(PJ)).toMatchObject({ jalur: 'ASURANSI', tanggal: '2026-04-01', nomor: 'KLM-9' });
  });

  test('getPinjamanDetail menyertakan pencatatan (null bila tidak ada)', async () => {
    expect((await getPinjamanDetail(PJ))!.penyelesaian).toBeNull();
    await catatPenyelesaianPinjaman(isian());
    expect((await getPinjamanDetail(PJ))!.penyelesaian).toMatchObject({ jalur: 'PENGADILAN', dokumen: 'Surat gugatan tgl 1-3-2026' });
  });
});

describe('batalkanPenyelesaianPinjaman', () => {
  test('alasan wajib; kolom dikosongkan; audit BATAL_PENYELESAIAN menyimpan data lama & alasan', async () => {
    await catatPenyelesaianPinjaman(isian());
    await expect(batalkanPenyelesaianPinjaman({ pinjamanId: PJ, alasan: '  ', actingUserId: USER_ID })).rejects.toThrow(/Alasan pembatalan wajib/);
    expect(await getPenyelesaianPinjaman(PJ)).not.toBeNull();

    await batalkanPenyelesaianPinjaman({ pinjamanId: PJ, alasan: 'Salah catat nomor perkara', actingUserId: USER_ID });
    const row = await testDb.getFirstAsync<any>(`SELECT * FROM pinjaman WHERE id = ?`, PJ);
    for (const k of ['penyelesaian_jalur', 'penyelesaian_tanggal', 'penyelesaian_nomor', 'penyelesaian_dokumen', 'penyelesaian_alasan', 'penyelesaian_oleh']) {
      expect(row[k]).toBeNull();
    }
    expect(row.status).toBe('AKTIF');
    const audit = await testDb.getAllAsync<any>(`SELECT * FROM audit_log WHERE entity_id = ? AND action = 'BATAL_PENYELESAIAN'`, PJ);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].data_sebelum)).toMatchObject({ jalur: 'PENGADILAN', nomor: '123/Pdt.G/2026/PN Bandung' });
    expect(JSON.parse(audit[0].data_sesudah)).toEqual({ dibatalkan: true, alasan: 'Salah catat nomor perkara' });
  });

  test('tanpa pencatatan -> ditolak; tanpa izin -> ditolak', async () => {
    await expect(batalkanPenyelesaianPinjaman({ pinjamanId: PJ, alasan: 'x', actingUserId: USER_ID })).rejects.toThrow(/tidak memiliki pencatatan/);
    await catatPenyelesaianPinjaman(isian());
    await tambahUser('u-bendahara', 'BENDAHARA');
    await expect(batalkanPenyelesaianPinjaman({ pinjamanId: PJ, alasan: 'x', actingUserId: 'u-bendahara' })).rejects.toThrow();
    expect(await getPenyelesaianPinjaman(PJ)).not.toBeNull();
  });
});

describe('integrasi ke penggolongan SOM (getKlasifikasiPinjamanAktif)', () => {
  const ambil = async (tanggalLaporan: string) => {
    const daftar = await getKlasifikasiPinjamanAktif(testDb as never, { tanggalLaporan, statusAnggota: 'SEMUA' });
    return daftar.find((d) => d.pinjamanId === PJ)!;
  };

  test('tanpa pencatatan: Lancar (belum ada tunggakan) dan kolom penyelesaian kosong', async () => {
    const d = await ambil('2026-03-15');
    expect(d.kolektibilitas).toBe('LANCAR');
    expect(d.persentaseCadangan).toBe(0);
    expect(d.penyelesaianJalur).toBeNull();
    expect(d.penyelesaianBerlaku).toBe(false);
    expect(d.dasarPenggolongan).not.toMatch(/Pengadilan Negeri/);
  });

  test('dicatat -> MACET sejak tanggal pencatatan: cadangan 100% atas saldo pokok, dasar memuat rujukan', async () => {
    await catatPenyelesaianPinjaman(isian());
    const d = await ambil('2026-03-15');
    expect(d.kolektibilitas).toBe('MACET');
    expect(d.bermasalah).toBe(true);
    expect(d.persentaseCadangan).toBe(100);
    expect(d.nilaiCadangan).toBe(10_000_000);
    expect(d.penyelesaianBerlaku).toBe(true);
    expect(d.penyelesaianJalur).toBe('PENGADILAN');
    expect(d.dasarPenggolongan).toMatch(/kriteria Macet angka 3/);
    expect(d.dasarPenggolongan).toMatch(/Pengadilan Negeri no\. 123\/Pdt\.G\/2026\/PN Bandung, tercatat 2026-03-01/);
  });

  test('pada tanggal pencatatan sendiri sudah Macet; laporan SEBELUM tanggal itu tetap Lancar (tidak berlaku surut)', async () => {
    await catatPenyelesaianPinjaman(isian());
    expect((await ambil('2026-03-01')).kolektibilitas).toBe('MACET');
    const sebelum = await ambil('2026-02-28');
    expect(sebelum.kolektibilitas).toBe('LANCAR');
    expect(sebelum.penyelesaianBerlaku).toBe(false);
    expect(sebelum.penyelesaianJalur).toBe('PENGADILAN'); // tercatat, tetapi belum berlaku pada tanggal laporan itu
  });

  test('jalur ASURANSI memakai rujukan klaim', async () => {
    await catatPenyelesaianPinjaman(isian({ jalur: 'ASURANSI', nomor: 'KLM-77', dokumen: 'Surat klaim' }));
    const d = await ambil('2026-03-15');
    expect(d.kolektibilitas).toBe('MACET');
    expect(d.dasarPenggolongan).toMatch(/Klaim asuransi kredit no\. KLM-77, tercatat 2026-03-01/);
  });

  test('dibatalkan -> kembali digolongkan menurut tunggakan (Lancar)', async () => {
    await catatPenyelesaianPinjaman(isian());
    expect((await ambil('2026-03-15')).kolektibilitas).toBe('MACET');
    await batalkanPenyelesaianPinjaman({ pinjamanId: PJ, alasan: 'Perkara dicabut', actingUserId: USER_ID });
    const d = await ambil('2026-03-15');
    expect(d.kolektibilitas).toBe('LANCAR');
    expect(d.penyelesaianJalur).toBeNull();
  });

  test('pinjaman lain tidak terpengaruh', async () => {
    await testDb.runAsync(
      `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, persentase_jasa,
         tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
       VALUES ('pj-lain','PJ-LAIN','anggota-2','2026-02-01',2000000,1,'BULAN','CUSTOM',0,'2026-12-01','AKTIF',?,?,?)`, USER_ID, now(), now()
    );
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES ('pj-lain-j1','pj-lain',1,'2026-12-01',2000000,0,0,2000000,'BELUM_BAYAR')`
    );
    await catatPenyelesaianPinjaman(isian());
    const daftar = await getKlasifikasiPinjamanAktif(testDb as never, { tanggalLaporan: '2026-03-15', statusAnggota: 'SEMUA' });
    expect(daftar.find((d) => d.pinjamanId === 'pj-lain')!.kolektibilitas).toBe('LANCAR');
    expect(daftar.find((d) => d.pinjamanId === PJ)!.kolektibilitas).toBe('MACET');
  });
});

describe('klasifikasikanSom: rujukan penyelesaian hanya teks', () => {
  const dasar = {
    polaPengembalian: 'ANGSURAN' as const,
    masaAngsuranBulan: 1,
    bulanTunggakanPokok: 0,
    bulanTunggakanJasa: 0,
    sudahJatuhTempo: false,
    bulanSejakJatuhTempo: 0,
    angsuranTerbayar: 0,
    totalKewajibanKontraktual: 1_000_000,
    nilaiAgunan: 0,
    sisaUtang: 1_000_000,
  };
  test('tanpa rujukan teks persis seperti sebelumnya; dengan rujukan ditambahkan, kategori sama', () => {
    const tanpa = klasifikasikanSom({ ...dasar, diserahkanKePengadilanAtauAsuransi: true });
    expect(tanpa.kategori).toBe('MACET');
    expect(tanpa.dasarPenggolongan).toBe(
      'Macet — penyelesaian sudah diserahkan ke Pengadilan Negeri atau diajukan permohonan ganti rugi ke perusahaan asuransi kredit (SOM 12.1 kriteria Macet angka 3).'
    );
    const dengan = klasifikasikanSom({ ...dasar, diserahkanKePengadilanAtauAsuransi: true, rujukanPenyelesaian: 'Pengadilan Negeri no. 1' });
    expect(dengan.kategori).toBe('MACET');
    expect(dengan.dasarPenggolongan).toMatch(/angka 3\) — Pengadilan Negeri no\. 1\.$/);
    expect(klasifikasikanSom({ ...dasar, rujukanPenyelesaian: 'x' }).kategori).toBe('LANCAR');
  });
});

test('hari ini dipakai untuk batas tanggal (sanity)', () => {
  expect(tanggalIsoValid(HARI_INI)).toBe(true);
});
