import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual<typeof import('@/database/db')>('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { SCHEMA_VERSION } from '@/database/schema';
import {
  simpanDraftNilaiWajar,
  perbaruiDraftNilaiWajar,
  batalkanPenilaianNilaiWajar,
  listDraftNilaiWajar,
  listPropertiInvestasiEligible,
  previewNilaiWajar,
  postingNilaiWajar,
  getNilaiTercatatInvestasi,
  getPenilaianNilaiWajar,
  getAuditTrailNilaiWajar,
  getFaktaPostingNilaiWajar,
  evaluasiKelayakanPostingNilaiWajar,
  hitungSelisihNilaiWajar,
  arahDariSelisih,
  KODE_NILAI_WAJAR,
  KEBIJAKAN_PENGUKURAN_PROPERTI_INVESTASI,
  MAPPING_NILAI_WAJAR_AKTIF,
  SUMBER_TRANSAKSI_NILAI_WAJAR,
  type FaktaPostingNilaiWajar,
} from '@/services/PenyesuaianNilaiWajarService';
import { getNilaiTercatatInvestasi as getNilaiTercatatResmi } from '@/services/InvestasiImpairmentService';
import { getPosisiKeuangan, getLabaRugi } from '@/reports/FinancialReports';
import { getTrialBalance } from '@/accounting/Ledger';

/**
 * RC-S54 TAHAP 11 — ITEM #10 PENYESUAIAN NILAI WAJAR PROPERTI INVESTASI.
 *
 * DATABASE VERIFIED: workflow penilaian (input, bukti, maker, lifecycle,
 * audit trail, identitas) dan gerbang posting POLICY 03 = MODEL BIAYA.
 * Seluruh test membuktikan NOL dampak akuntansi. RENDER = NOT VERIFIED.
 */

const ACC = {
  kas: 'acc-kas',
  properti: 'acc-properti',
  akmSusut: 'acc-akm-susut-properti',
  bebanSusut: 'acc-beban-susut',
  penyisihan: 'acc-penyisihan-inv',
  bebanImp: 'acc-beban-imp',
  modal: 'acc-modal',
  penyesuaiNw: 'acc-penyesuai-nw',
  untungNw: 'acc-untung-nw',
  rugiNw: 'acc-rugi-nw',
};

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}
function tanpaKomentar(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const BUKTI = { dasarPenilaian: 'Laporan penilai independen', referensiBukti: 'KJPP-2026-011' };

async function seedAccount(id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kat, nb, now, now
  );
}

async function seedJurnal(id: string, tanggal: string, lines: [string, number, number][]) {
  const now = new Date().toISOString();
  const periode = `p${tanggal.slice(0, 4)}`;
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,'SEED','seed','POSTED','user-1',?,?)`,
    id, `JRN-${id}`, tanggal, periode, now, now
  );
  let i = 0;
  for (const [acc, d, k] of lines) {
    i += 1;
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,?)`,
      `${id}-${i}`, id, acc, d, k
    );
  }
}

async function seedInvestasi(id: string, jenis: string, nilai: number, status = 'AKTIF') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                            sumber_dana, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,'2026-01-05','KAS',?,'user-1',?,?)`,
    id, `NO-${id}`, jenis, `Nama ${id}`, nilai, status, now, now
  );
}

async function seedFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.properti, '1-1660', 'Properti Investasi', 'ASET', 'DEBIT');
  await seedAccount(ACC.akmSusut, '1-1670', 'Akumulasi Penyusutan Properti Investasi', 'ASET', 'KREDIT');
  await seedAccount(ACC.penyisihan, '1-1900', 'Penyisihan Penurunan Nilai Investasi', 'ASET', 'KREDIT');
  await seedAccount(ACC.bebanSusut, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.bebanImp, '5-1400', 'Beban Penurunan Nilai Investasi', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');
  // RC-S88 — akun & mapping model nilai wajar properti investasi.
  await seedAccount(ACC.penyesuaiNw, '1-1665', 'Penyesuaian Nilai Wajar Properti Investasi', 'ASET', 'DEBIT');
  await seedAccount(ACC.untungNw, '4-2100', 'Keuntungan Perubahan Nilai Wajar Properti Investasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.rugiNw, '5-5000', 'Kerugian Nilai Wajar Properti Investasi', 'BEBAN', 'DEBIT');
  for (const [role, acc] of [
    ['PENYESUAIAN_ASET', ACC.penyesuaiNw],
    ['KREDIT_KEUNTUNGAN', ACC.untungNw],
    ['DEBIT_KERUGIAN', ACC.rugiNw],
  ]) {
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-nw-${role}`, 'NILAI_WAJAR_PROPERTI_INVESTASI', role, acc
    );
  }
  for (const th of [2025, 2026]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  for (const [id, nama] of [['user-1', 'Admin Satu'], ['user-2', 'Admin Dua']]) {
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES (?,?,?,'ADMIN','x','x',0,1,?,?)`,
      id, nama, id, now, now
    );
  }
  await seedJurnal('j-modal', '2025-01-01', [[ACC.kas, 600_000_000, 0], [ACC.modal, 0, 600_000_000]]);
  await seedJurnal('j-properti', '2026-01-05', [[ACC.properti, 500_000_000, 0], [ACC.kas, 0, 500_000_000]]);
  await seedInvestasi('inv-prop', 'PROPERTI_INVESTASI', 500_000_000);
}

beforeEach(async () => {
  await seedFixture();
});
afterEach(() => {
  testDb.closeSync();
});

async function buatDraft(over: Partial<Parameters<typeof simpanDraftNilaiWajar>[0]> = {}) {
  return simpanDraftNilaiWajar({
    investasiId: 'inv-prop',
    tanggal: '2026-06-30',
    nilaiWajar: 560_000_000,
    ...BUKTI,
    createdBy: 'user-1',
    ...over,
  });
}

async function snapshotBuku(): Promise<unknown> {
  const j = await testDb.getAllAsync(`SELECT * FROM journal ORDER BY id`);
  const je = await testDb.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`);
  const posisi = await getPosisiKeuangan(testDb as any, '2026-12-31');
  const lr = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
  const tb = await getTrialBalance(testDb as any, '2026-12-31');
  return JSON.parse(JSON.stringify({ j, je, posisi, lr, tb }));
}

const faktaDasar: FaktaPostingNilaiWajar = {
  ditemukan: true,
  status: 'DRAFT',
  dasarPenilaian: 'Laporan penilai',
  referensiBukti: 'KJPP-1',
  jumlahJurnalTerkait: 0,
  kebijakan: 'MODEL_NILAI_WAJAR',
  mappingAktif: true,
};

const POSTER = { userId: 'user-2' };

describe('RC-S54 T11 #10 — workflow penilaian', () => {
  it('Test 1 — create assessment: seluruh field terisi dari service', async () => {
    const d = await buatDraft({ catatan: 'Penilaian tahunan' });
    expect(d.id).toEqual(expect.any(String));
    expect(d.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(d.createdBy).toBe('user-1');
    expect(d.namaPembuat).toBe('Admin Satu');
    expect(d.investasiId).toBe('inv-prop');
    expect(d.namaInvestasi).toBe('Nama inv-prop');
    expect(d.nilaiTercatatSebelum).toBe(500_000_000);
    expect(d.nilaiWajar).toBe(560_000_000);
    expect(d.selisih).toBe(60_000_000);
    expect(d.arahPerubahan).toBe('KENAIKAN');
    expect(d.dasarPenilaian).toBe(BUKTI.dasarPenilaian);
    expect(d.referensiBukti).toBe(BUKTI.referensiBukti);
    expect(d.catatan).toBe('Penilaian tahunan');
    expect(d.status).toBe('DRAFT');
    expect(await listDraftNilaiWajar()).toHaveLength(1);
  });

  it('Test 2 — nilai tercatat sebelum = rumus resmi (perolehan − penyusutan − impairment) per tanggal penilaian', async () => {
    await seedJurnal('j-susut-1', '2026-03-31', [[ACC.bebanSusut, 10_000_000, 0], [ACC.akmSusut, 0, 10_000_000]]);
    await seedJurnal('j-susut-2', '2026-09-30', [[ACC.bebanSusut, 10_000_000, 0], [ACC.akmSusut, 0, 10_000_000]]);
    await seedJurnal('j-imp', '2026-05-15', [[ACC.bebanImp, 25_000_000, 0], [ACC.penyisihan, 0, 25_000_000]]);
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO investasi_penyusutan (id, investasi_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
       VALUES ('s1','inv-prop','2026-03','2026-03-31',10000000,'j-susut-1','user-1',?),
              ('s2','inv-prop','2026-09','2026-09-30',10000000,'j-susut-2','user-1',?)`,
      now, now
    );
    await testDb.runAsync(
      `INSERT INTO investasi_impairment (id, investasi_id, tanggal, nilai_tercatat_sebelum, indikasi_penurunan_nilai,
                                         dasar_penilaian, nilai_impairment, alasan, journal_id, created_by, created_at)
       VALUES ('i1','inv-prop','2026-05-15',490000000,'Penurunan nilai pasar properti','KJPP',25000000,'x','j-imp','user-1',?)`,
      now
    );

    // Per 30 Juni: 500 − 10 (Maret) − 25 (Mei) = 465. Penyusutan September belum terjadi.
    const resmi = await getNilaiTercatatResmi(testDb as any, 'inv-prop', '2026-06-30');
    expect(resmi.nilaiTercatat).toBe(465_000_000);
    expect(await getNilaiTercatatInvestasi('inv-prop', '2026-06-30')).toBe(465_000_000);

    const p = await previewNilaiWajar('inv-prop', 480_000_000, '2026-06-30');
    expect(p.nilaiTercatatSebelum).toBe(465_000_000);

    const d = await buatDraft({ nilaiWajar: 480_000_000 });
    expect(d.nilaiTercatatSebelum).toBe(465_000_000);
    expect(d.selisih).toBe(15_000_000);
    // `investasi.jumlah` (biaya perolehan) BUKAN nilai tercatat.
    expect(d.nilaiTercatatSebelum).not.toBe(500_000_000);

    // Nilai "sebelum" tidak dapat disuntikkan pengguna.
    const suntik = await simpanDraftNilaiWajar({
      investasiId: 'inv-prop', tanggal: '2026-10-31', nilaiWajar: 480_000_000, ...BUKTI, createdBy: 'user-1',
      nilaiTercatatSebelum: 1, selisih: 999,
    } as any);
    expect(suntik.nilaiTercatatSebelum).toBe(455_000_000);
    expect(suntik.selisih).toBe(25_000_000);
  });

  it('Test 3 — selisih otomatis = nilai wajar − nilai tercatat; kolom tersimpan konsisten', async () => {
    expect(hitungSelisihNilaiWajar(560, 500)).toBe(60);
    expect(hitungSelisihNilaiWajar(450, 500)).toBe(-50);
    const d = await buatDraft({ nilaiWajar: 537_500_000 });
    expect(d.selisih).toBe(37_500_000);
    const kolom = await testDb.getFirstAsync<{ selisih: number; arah_perubahan: string }>(
      `SELECT selisih, arah_perubahan FROM penyesuaian_nilai_wajar WHERE id = ?`, d.id
    );
    expect(kolom?.selisih).toBe(37_500_000);
    expect(kolom?.arah_perubahan).toBe('KENAIKAN');
    const ubah = await perbaruiDraftNilaiWajar(d.id, {
      tanggal: '2026-06-30', nilaiWajar: 499_000_000, ...BUKTI, createdBy: 'user-1',
    });
    expect(ubah.selisih).toBe(-1_000_000);
  });

  it('Test 4 — arah KENAIKAN', async () => {
    expect(arahDariSelisih(1)).toBe('KENAIKAN');
    expect((await buatDraft({ nilaiWajar: 500_000_001 })).arahPerubahan).toBe('KENAIKAN');
  });

  it('Test 5 — arah PENURUNAN', async () => {
    expect(arahDariSelisih(-1)).toBe('PENURUNAN');
    const d = await buatDraft({ nilaiWajar: 420_000_000 });
    expect(d.selisih).toBe(-80_000_000);
    expect(d.arahPerubahan).toBe('PENURUNAN');
  });

  it('Test 6 — nilai sama → TETAP (enum existing TIDAK_BERUBAH)', async () => {
    const d = await buatDraft({ nilaiWajar: 500_000_000 });
    expect(d.selisih).toBe(0);
    expect(d.arahPerubahan).toBe('TIDAK_BERUBAH');
  });

  it('Test 7 — nilai wajar negatif / NaN / Infinity / non-numerik / kosong / pecahan DITOLAK', async () => {
    for (const buruk of [-1, NaN, Infinity, -Infinity, '560000000', '', null, undefined, 1.5]) {
      await expect(buatDraft({ nilaiWajar: buruk as any })).rejects.toThrow(/Nilai wajar/);
    }
    await expect(previewNilaiWajar('inv-prop', -5)).rejects.toThrow(/tidak boleh negatif/);
    expect(await listDraftNilaiWajar()).toHaveLength(0);
    // Nol diperbolehkan (nilai wajar >= 0).
    expect((await buatDraft({ nilaiWajar: 0 })).arahPerubahan).toBe('PENURUNAN');
  });

  it('Test 8 — dasar penilaian & referensi bukti WAJIB (kosong/spasi ditolak, saat simpan & perbarui)', async () => {
    for (const over of [
      { dasarPenilaian: undefined },
      { dasarPenilaian: '   ' },
      { referensiBukti: undefined },
      { referensiBukti: '' },
    ]) {
      await expect(buatDraft(over as any)).rejects.toThrow(KODE_NILAI_WAJAR.EVIDENCE_REQUIRED);
    }
    expect(await listDraftNilaiWajar()).toHaveLength(0);
    const d = await buatDraft({ dasarPenilaian: '  Referensi pasar  ', referensiBukti: ' DOK-7 ' });
    expect(d.dasarPenilaian).toBe('Referensi pasar');
    expect(d.referensiBukti).toBe('DOK-7');
    await expect(
      perbaruiDraftNilaiWajar(d.id, { tanggal: '2026-06-30', nilaiWajar: 1, createdBy: 'user-1' })
    ).rejects.toThrow(KODE_NILAI_WAJAR.EVIDENCE_REQUIRED);
    expect((await getPenilaianNilaiWajar(d.id))?.referensiBukti).toBe('DOK-7');
  });

  it('Test 9 — maker tersimpan dan TIDAK ditimpa editor; bukan user posting', async () => {
    const d = await buatDraft();
    const ubah = await perbaruiDraftNilaiWajar(d.id, {
      tanggal: '2026-06-30', nilaiWajar: 550_000_000, ...BUKTI, createdBy: 'user-2',
    });
    expect(ubah.createdBy).toBe('user-1');
    expect(ubah.namaPembuat).toBe('Admin Satu');
    expect(ubah.userPosting).toBeNull();
    const trail = await getAuditTrailNilaiWajar(d.id);
    expect(trail.map((t) => [t.action, t.userId])).toEqual([['CREATE', 'user-1'], ['UPDATE', 'user-2']]);
  });

  it('Test 10 — lifecycle DRAFT → DIBATALKAN; baris tetap ada; tidak ada transisi lanjutan', async () => {
    const d = await buatDraft({ catatan: 'catatan asli' });
    await expect(batalkanPenilaianNilaiWajar(d.id, { alasan: '  ', userId: 'user-2' })).rejects.toThrow(/Alasan/);
    const batal = await batalkanPenilaianNilaiWajar(d.id, { alasan: 'Laporan penilai direvisi', userId: 'user-2' });
    expect(batal.status).toBe('DIBATALKAN');
    expect(batal.catatan).toBe('catatan asli');
    expect(await listDraftNilaiWajar()).toHaveLength(1);

    await expect(
      perbaruiDraftNilaiWajar(d.id, { tanggal: '2026-06-30', nilaiWajar: 1, ...BUKTI, createdBy: 'user-1' })
    ).rejects.toThrow(/Hanya draft/);
    await expect(batalkanPenilaianNilaiWajar(d.id, { alasan: 'lagi', userId: 'user-1' })).rejects.toThrow(
      KODE_NILAI_WAJAR.NOT_DRAFT
    );
    await expect(postingNilaiWajar(d.id, POSTER)).rejects.toThrow(KODE_NILAI_WAJAR.NOT_DRAFT);
    await expect(postingNilaiWajar('tidak-ada', POSTER)).rejects.toThrow(KODE_NILAI_WAJAR.NOT_FOUND);

    // Status POSTED tidak dapat ditulis — CHECK skema existing menolaknya.
    await expect(
      testDb.runAsync(`UPDATE penyesuaian_nilai_wajar SET status = 'POSTED' WHERE id = ?`, d.id)
    ).rejects.toThrow();
  });
});

// DIPERBARUI RC-S88 (keputusan pengguna — "perbagus penyesuaian nilai wajar sesuai
// rekomendasi terbaik"): POLICY 03 = MODEL BIAYA DIGANTI model nilai wajar SAK EP
// Bab 16 untuk properti investasi. Test 11–13, 16, 18 yang dulu membuktikan
// "posting SELALU ditolak / nol dampak akuntansi" kini membuktikan posting yang
// BENAR: jurnal laba rugi, gerbang bukti/status/urutan, idempoten, dan audit.
describe('RC-S88 — posting model nilai wajar properti investasi (laba rugi)', () => {
  it('Test 11 — kebijakan = MODEL NILAI WAJAR; kenaikan diposting Dr 1-1665 / Cr 4-2100', async () => {
    expect(KEBIJAKAN_PENGUKURAN_PROPERTI_INVESTASI).toBe('MODEL_NILAI_WAJAR');
    expect(MAPPING_NILAI_WAJAR_AKTIF).toBe(true);
    const d = await buatDraft();
    expect(evaluasiKelayakanPostingNilaiWajar(await getFaktaPostingNilaiWajar(d.id))).toEqual([]);
    const hasil = await postingNilaiWajar(d.id, POSTER);
    expect(hasil.row.status).toBe('DIPOSTING');
    expect(hasil.row.jumlahLabaRugi).toBe(60_000_000);
    expect(hasil.row.jumlahOci).toBe(0);
    const baris = await testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
      `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id
        WHERE je.journal_id = ? ORDER BY je.urutan`,
      hasil.journalId
    );
    expect(baris).toEqual([
      { kode: '1-1665', debit: 60_000_000, kredit: 0 },
      { kode: '4-2100', debit: 0, kredit: 60_000_000 },
    ]);
    const j = await testDb.getFirstAsync<{ sumber_transaksi: string; sumber_id: string; tanggal: string }>(
      `SELECT sumber_transaksi, sumber_id, tanggal FROM journal WHERE id = ?`, hasil.journalId
    );
    expect(j).toEqual({ sumber_transaksi: SUMBER_TRANSAKSI_NILAI_WAJAR, sumber_id: d.id, tanggal: '2026-06-30' });
  });

  it('Test 12 — penurunan diposting Dr 5-5000 / Cr 1-1665; nilai tercatat resmi = nilai wajar', async () => {
    const d = await buatDraft({ nilaiWajar: 420_000_000 });
    const hasil = await postingNilaiWajar(d.id, POSTER);
    const baris = await testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
      `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id
        WHERE je.journal_id = ? ORDER BY je.urutan`,
      hasil.journalId
    );
    expect(baris).toEqual([
      { kode: '5-5000', debit: 80_000_000, kredit: 0 },
      { kode: '1-1665', debit: 0, kredit: 80_000_000 },
    ]);
    expect(await getNilaiTercatatInvestasi('inv-prop', '2026-12-31')).toBe(420_000_000);
    expect((await getNilaiTercatatResmi(testDb as any, 'inv-prop', '2026-06-29')).nilaiTercatat).toBe(500_000_000);
  });

  it('Test 13 — laba rugi & posisi keuangan mencerminkan posting; draft/batal tetap tanpa dampak', async () => {
    const awal = await snapshotBuku();
    const d = await buatDraft({ nilaiWajar: 900_000_000 });
    await perbaruiDraftNilaiWajar(d.id, { tanggal: '2026-06-30', nilaiWajar: 100_000_000, ...BUKTI, createdBy: 'user-1' });
    await batalkanPenilaianNilaiWajar(d.id, { alasan: 'uji', userId: 'user-1' });
    expect(await snapshotBuku()).toEqual(awal); // draft & batal: nol dampak

    const d2 = await buatDraft({ tanggal: '2026-07-31', nilaiWajar: 530_000_000 });
    await postingNilaiWajar(d2.id, POSTER);
    const lr = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    expect(lr.pendapatan.find((r) => r.kode === '4-2100')?.jumlah).toBe(30_000_000);
    expect(lr.penghasilanKomprehensifLain).toBe(0); // properti investasi: laba rugi, BUKAN OCI
    const posisi = await getPosisiKeuangan(testDb as any, '2026-12-31');
    expect(posisi.aset.find((r) => r.kode === '1-1665')?.saldo).toBe(30_000_000);
    expect(posisi.isBalanced).toBe(true);
  });

  it('Test 14 — hanya properti investasi AKTIF yang eligible', async () => {
    await seedInvestasi('inv-kop', 'KOPERASI_LAIN', 50_000_000);
    await seedInvestasi('inv-depo', 'DEPOSITO_BANK_UMUM', 70_000_000);
    await seedInvestasi('inv-prop-batal', 'PROPERTI_INVESTASI', 90_000_000, 'DIBATALKAN');
    await seedInvestasi('inv-prop-2', 'PROPERTI_INVESTASI', 90_000_000);

    const ids = (await listPropertiInvestasiEligible()).map((p) => p.id).sort();
    expect(ids).toEqual(['inv-prop', 'inv-prop-2']);

    for (const id of ['inv-kop', 'inv-depo', 'inv-prop-batal']) {
      await expect(buatDraft({ investasiId: id })).rejects.toThrow(KODE_NILAI_WAJAR.PROPERTY_NOT_ELIGIBLE);
      await expect(previewNilaiWajar(id, 1)).rejects.toThrow(KODE_NILAI_WAJAR.PROPERTY_NOT_ELIGIBLE);
    }
    // Aset tetap / tak berwujud bukan baris `investasi` sama sekali.
    await expect(buatDraft({ investasiId: 'aset-tetap-1' })).rejects.toThrow(/tidak ditemukan/);
    expect(await listDraftNilaiWajar()).toHaveLength(0);
  });

  it('Test 15 — identitas penilaian (properti + tanggal): draft ganda ditolak; histori beda tanggal boleh', async () => {
    const d1 = await buatDraft();
    await expect(buatDraft({ nilaiWajar: 999 })).rejects.toThrow(KODE_NILAI_WAJAR.DUPLICATE_ASSESSMENT);
    const d2 = await buatDraft({ tanggal: '2026-12-31' });
    await expect(
      perbaruiDraftNilaiWajar(d2.id, { tanggal: '2026-06-30', nilaiWajar: 1, ...BUKTI, createdBy: 'user-1' })
    ).rejects.toThrow(KODE_NILAI_WAJAR.DUPLICATE_ASSESSMENT);
    // Perbarui draft sendiri pada tanggal yang sama bukan duplikat.
    await perbaruiDraftNilaiWajar(d1.id, { tanggal: '2026-06-30', nilaiWajar: 2, ...BUKTI, createdBy: 'user-1' });
    // Setelah dibatalkan, tanggal itu boleh dinilai ulang; yang batal tetap tersimpan.
    await batalkanPenilaianNilaiWajar(d1.id, { alasan: 'ganti penilai', userId: 'user-1' });
    await buatDraft({ nilaiWajar: 3 });
    expect(await listDraftNilaiWajar()).toHaveLength(3);
  });

  it('Test 16 — satu penilaian tidak dapat diposting dua kali (status + identitas jurnal)', async () => {
    expect(evaluasiKelayakanPostingNilaiWajar({ ...faktaDasar, jumlahJurnalTerkait: 1 })).toEqual([
      KODE_NILAI_WAJAR.ALREADY_POSTED,
    ]);
    expect(evaluasiKelayakanPostingNilaiWajar({ ...faktaDasar, status: 'DIPOSTING' })).toEqual([
      KODE_NILAI_WAJAR.ALREADY_POSTED,
    ]);
    expect(evaluasiKelayakanPostingNilaiWajar(faktaDasar)).toEqual([]);

    const d = await buatDraft();
    await postingNilaiWajar(d.id, POSTER);
    for (let i = 0; i < 3; i += 1) {
      await expect(postingNilaiWajar(d.id, POSTER)).rejects.toThrow(KODE_NILAI_WAJAR.ALREADY_POSTED);
    }
    expect(
      (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE sumber_id = ?`, d.id))?.n
    ).toBe(1);
    // Penilaian yang sudah diposting tidak dapat dibatalkan/diedit.
    await expect(batalkanPenilaianNilaiWajar(d.id, { alasan: 'x', userId: 'user-1' })).rejects.toThrow(
      KODE_NILAI_WAJAR.ALREADY_POSTED
    );
    await expect(
      perbaruiDraftNilaiWajar(d.id, { tanggal: '2026-06-30', nilaiWajar: 1, ...BUKTI, createdBy: 'user-1' })
    ).rejects.toThrow(/Hanya draft/);
  });

  it('Test 16b — urutan kronologis: penilaian bertanggal sebelum/sama dengan yang diposting ditolak', async () => {
    const d = await buatDraft({ tanggal: '2026-06-30' });
    await postingNilaiWajar(d.id, POSTER);
    const lebihLama = await buatDraft({ tanggal: '2026-05-31', nilaiWajar: 510_000_000 });
    await expect(postingNilaiWajar(lebihLama.id, POSTER)).rejects.toThrow(KODE_NILAI_WAJAR.OUT_OF_ORDER);
    // Penilaian sesudahnya menghitung selisih dari nilai wajar terakhir (560), bukan biaya perolehan.
    const berikut = await buatDraft({ tanggal: '2026-08-31', nilaiWajar: 575_000_000 });
    expect(berikut.nilaiTercatatSebelum).toBe(560_000_000);
    const hasil = await postingNilaiWajar(berikut.id, POSTER);
    expect(hasil.row.jumlahLabaRugi).toBe(15_000_000);
  });

  it('Test 16c — posting menuntut izin kas_bank:approve', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('user-petugas','Petugas','petugas','PETUGAS','x','x',0,1,?,?)`,
      now, now
    );
    const d = await buatDraft();
    await expect(postingNilaiWajar(d.id, { userId: 'user-petugas' })).rejects.toThrow();
    expect((await getPenilaianNilaiWajar(d.id))?.status).toBe('DRAFT');
  });

  it('Test 17 — audit trail: maker, editor, waktu, transisi status, alasan', async () => {
    const d = await buatDraft({ nilaiWajar: 510_000_000 });
    await perbaruiDraftNilaiWajar(d.id, { tanggal: '2026-06-30', nilaiWajar: 520_000_000, ...BUKTI, createdBy: 'user-2' });
    await batalkanPenilaianNilaiWajar(d.id, { alasan: 'Bukti tidak sah', userId: 'user-2' });
    await expect(postingNilaiWajar(d.id, POSTER)).rejects.toThrow();

    const trail = await getAuditTrailNilaiWajar(d.id);
    expect(trail.map((t) => t.action)).toEqual(['CREATE', 'UPDATE', 'VOID']);
    expect(trail.map((t) => t.userId)).toEqual(['user-1', 'user-2', 'user-2']);
    for (const t of trail) expect(t.waktu).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(trail[0].dataSebelum).toBeNull();
    expect(trail[0].dataSesudah).toMatchObject({ status: 'DRAFT', nilaiWajar: 510_000_000, createdBy: 'user-1' });
    expect(trail[1].dataSebelum).toMatchObject({ nilaiWajar: 510_000_000 });
    expect(trail[1].dataSesudah).toMatchObject({ nilaiWajar: 520_000_000, selisih: 20_000_000 });
    expect(trail[2].dataSebelum).toMatchObject({ status: 'DRAFT' });
    expect(trail[2].dataSesudah).toMatchObject({ status: 'DIBATALKAN', alasanPembatalan: 'Bukti tidak sah' });
  });

  it('Test 18 — jurnal / tanggal posting / user posting: NULL selama draft, terisi setelah posting', async () => {
    const d = await buatDraft();
    for (const r of [d, await getPenilaianNilaiWajar(d.id), (await listDraftNilaiWajar())[0]]) {
      expect(r?.jurnalId).toBeNull();
      expect(r?.nomorJurnal).toBeNull();
      expect(r?.tanggalPosting).toBeNull();
      expect(r?.userPosting).toBeNull();
      expect(r?.statusPosting).toBe('BELUM_DIPOSTING');
    }
    await postingNilaiWajar(d.id, POSTER);
    const r = await getPenilaianNilaiWajar(d.id);
    expect(r?.jurnalId).toEqual(expect.any(String));
    expect(r?.nomorJurnal).toMatch(/^JRN/);
    expect(r?.tanggalPosting).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r?.userPosting).toBe('Admin Dua');
    expect(r?.statusPosting).toBe('DIPOSTING');
    const trail = await getAuditTrailNilaiWajar(d.id);
    expect(trail.map((t) => [t.action, t.userId])).toEqual([['CREATE', 'user-1'], ['POST', 'user-2']]);
  });
});

describe('RC-S54 T11 #10 / RC-S88 — STATIC (scope, navigasi, skema)', () => {
  const svc = tanpaKomentar(baca('src/services/PenyesuaianNilaiWajarService.ts'));

  it('service: jurnal HANYA lewat createJournal & mapping (tanpa INSERT journal mentah / kode akun hard-code)', () => {
    expect(svc).toMatch(/createJournal\(db, \{/);
    expect(svc).not.toMatch(/INSERT INTO journal\b|INSERT INTO journal_entry\b/);
    for (const k of ['4-2100', '5-5000', '1-1665', '1-1520', '3-6000', '1-660', '1-661']) expect(svc).not.toContain(k);
    expect(svc).toMatch(/resolveAccountId\(db, MAPPING_PI, 'KREDIT_KEUNTUNGAN'\)/);
    expect(svc).toMatch(/resolveAccountId\(db, MAPPING_AT, 'SURPLUS_OCI'\)/);
  });

  it('nilai tercatat memakai rumus resmi InvestasiImpairmentService, bukan investasi.jumlah', () => {
    expect(svc).toMatch(/from '@\/services\/InvestasiImpairmentService'/);
    expect(svc).not.toMatch(/SELECT jumlah FROM investasi/);
  });

  it('menu: Rekonsiliasi → Penyesuaian Nilai Wajar → Impairment Investasi; rute tunggal', () => {
    const hub = tanpaKomentar(baca('src/screens/Transaksi/PenyesuaianScreen.tsx'));
    const iRek = hub.indexOf("route: 'Rekonsiliasi'");
    const iNw = hub.indexOf("route: 'PenyesuaianNilaiWajar'");
    const iImp = hub.indexOf("route: 'ImpairmentInvestasiForm'");
    expect(iRek).toBeGreaterThan(-1);
    expect(iRek).toBeLessThan(iNw);
    expect(iNw).toBeLessThan(iImp);
    const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));
    expect(nav.match(/name="PenyesuaianNilaiWajar"/g)).toHaveLength(1);
  });

  it('layar: daftar eligible & pratinjau dari service, bukti wajib, posting lewat lembar konfirmasi', () => {
    const layar = tanpaKomentar(baca('src/screens/Transaksi/PenyesuaianNilaiWajarScreen.tsx'));
    expect(layar).toMatch(/listObjekNilaiWajarEligible\(objek\)/);
    expect(layar).not.toMatch(/listInvestasi\(|createJournal/);
    expect(layar).toMatch(/Dasar Penilaian \*/);
    expect(layar).toMatch(/Referensi Bukti \*/);
    expect(layar).toMatch(/previewPostingNilaiWajar\(row\.id\)/);
    expect(layar).toMatch(/postingNilaiWajar\(lembarPosting\.row\.id, \{ userId: currentUser\.id \}\)/);
    for (const label of ['ID Transaksi', 'Jurnal yang Terbentuk', 'Tanggal Posting', 'User Posting', 'Simpan Draft']) {
      expect(layar).toContain(label);
    }
  });

  it('skema v73: status DRAFT/DIPOSTING/DIBATALKAN, objek PROPERTI_INVESTASI/ASET_TETAP', () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting & revaluasi aset tetap). · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(/status TEXT NOT NULL DEFAULT 'DRAFT' CHECK \(status IN \('DRAFT','DIPOSTING','DIBATALKAN'\)\)/);
    expect(schema).toMatch(/objek TEXT NOT NULL DEFAULT 'PROPERTI_INVESTASI' CHECK \(objek IN \('PROPERTI_INVESTASI','ASET_TETAP'\)\)/);
    expect(baca('src/database/db.ts')).toMatch(/if \(currentVersion < 73\) \{\s*await migrasiV73\(db\);/);
  });
});
