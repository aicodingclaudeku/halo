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
import {
  evaluasiEligibilitasPinjaman,
  checkEligibilitasPinjaman,
  getTotalOutstandingPerTanggal,
  getTunggakanAnggotaPerTanggal,
} from '@/services/LoanEligibilityService';
import { ajukanPinjaman } from '@/services/PinjamanService';
import { setPolicyValue } from '@/services/AccountingPolicyService';
import { parseBerkasDataAwal } from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import { periksaSyaratPinjamanImport, periksaSebelumImport } from '@/import/PanduanImportData';
import { logRiwayatImport } from '@/import/RiwayatImportRepository';
import { adalahPeringatanSyarat } from '@/import/RiwayatImportPlan';

/**
 * RC-S133.6.4 §1 — SYARAT PINJAMAN DINILAI PADA TANGGAL PENGAJUAN, BUKAN HARI INI.
 *
 * Kebutuhan:
 *  - input bertanggal lampau dinilai dengan keadaan PADA tanggal itu;
 *  - untuk tanggal hari ini hasilnya TIDAK berubah dari sebelumnya;
 *  - form pengajuan tetap menolak; import data awal hanya memperingatkan;
 *  - hasil pengecekan pada tanggal pinjaman tampil di pratinjau dan riwayat import.
 *
 * "Hari ini" disuntikkan (`tanggalHariIni`) agar uji tidak bergantung pada
 * jam mesin.
 */

const HARI_INI = '2026-12-31';

async function setor(db: TestDb, anggotaId: string, jenis: 'POKOK' | 'WAJIB' | 'SUKARELA', tanggal: string, nominal: number, no: string) {
  await db.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    `st-${no}`, anggotaId, jenis, 'SETOR', tanggal, nominal, 'KAS', no, USER_ID, new Date().toISOString()
  );
}

/** Pinjaman AKTIF + satu jadwal (pokok+jasa) — disuntik langsung; yang diuji adalah penilaian syarat. */
async function sisipPinjaman(
  db: TestDb,
  o: { id: string; anggotaId: string; tanggal: string; status?: string; jadwal: { tempo: string; pokok: number; jasa: number }[] }
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, persentase_jasa,
       tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    o.id, `PJ-${o.id}`, o.anggotaId, o.tanggal, o.jadwal.reduce((t, j) => t + j.pokok, 0), o.jadwal.length, 'BULAN', 'CUSTOM', 0,
    o.jadwal[o.jadwal.length - 1].tempo, o.status ?? 'AKTIF', USER_ID, now, now
  );
  let n = 1;
  for (const j of o.jadwal) {
    await db.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES (?,?,?,?,?,?,0,?,'BELUM_BAYAR')`,
      `${o.id}-j${n}`, o.id, n, j.tempo, j.pokok, j.jasa, j.pokok + j.jasa
    );
    n += 1;
  }
}

/** Pembayaran pada tanggal tertentu untuk satu baris jadwal (kolom terbayar di jadwal ikut diisi seperti produksi). */
async function bayar(db: TestDb, pinjamanId: string, jadwalNo: number, tanggal: string) {
  const j = await db.getFirstAsync<{ id: string; pokok: number; jasa: number }>(
    `SELECT id, pokok, jasa FROM angsuran_jadwal WHERE pinjaman_id = ? AND nomor_angsuran = ?`, pinjamanId, jadwalNo
  );
  await db.runAsync(
    `INSERT INTO angsuran_pembayaran (id, pinjaman_id, jadwal_id, tanggal, nominal, porsi_pokok, porsi_jasa, porsi_denda, sumber_dana, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,0,'KAS',?,?)`,
    `ap-${j!.id}`, pinjamanId, j!.id, tanggal, j!.pokok + j!.jasa, j!.pokok, j!.jasa, USER_ID, new Date().toISOString()
  );
  await db.runAsync(
    `UPDATE angsuran_jadwal SET pokok_terbayar = pokok, jasa_terbayar = jasa, status = 'LUNAS' WHERE id = ?`, j!.id
  );
}

async function tambahAnggotaBaru(db: TestDb, id: string, nomor: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    id, nomor, `99${nomor}`.padEnd(16, '0'), `Anggota ${nomor}`, '2025-01-01', now, now
  );
}

describe('RC-S133.6.4 §1 — evaluasiEligibilitasPinjaman menilai pada tanggal pengajuan', () => {
  const A = 'anggota-uji-syarat';
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await tambahAnggotaBaru(testDb, A, '0901');
  });

  test('simpanan pokok & wajib disetor SESUDAH tanggal pengajuan -> belum memenuhi pada tanggal itu; sesudah disetor memenuhi', async () => {
    await setor(testDb, A, 'POKOK', '2026-03-01', 100_000, 'SP-1');
    await setor(testDb, A, 'WAJIB', '2026-03-01', 50_000, 'SW-1');

    const sebelum = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 1_000_000, tanggal: '2026-02-01', tanggalHariIni: HARI_INI });
    expect(sebelum.valid).toBe(false);
    expect(sebelum.perTanggalLampau).toBe(true);
    expect(sebelum.tanggalPenilaian).toBe('2026-02-01');
    expect(sebelum.alasan[0]).toMatch(/Simpanan Pokok dan Simpanan Wajib/);

    const sesudah = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 1_000_000, tanggal: '2026-03-01', tanggalHariIni: HARI_INI });
    expect(sesudah.valid).toBe(true);
  });

  test('tanggal HARI INI, masa depan, atau tidak diisi: memakai keadaan sekarang persis seperti sebelumnya', async () => {
    // Setoran bertanggal masa depan (setelah "hari ini") tetap terhitung seperti perilaku lama.
    await setor(testDb, A, 'POKOK', '2027-05-01', 100_000, 'SP-2');
    await setor(testDb, A, 'WAJIB', '2027-05-01', 50_000, 'SW-2');
    for (const tanggal of [HARI_INI, '2027-01-15', undefined]) {
      const h = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 1_000_000, tanggal, tanggalHariIni: HARI_INI });
      expect(h.valid).toBe(true);
      expect(h.perTanggalLampau).toBe(false);
      expect(h.tanggalPenilaian).toBe(HARI_INI);
    }
    // ...sedangkan untuk tanggal lampau setoran itu belum ada.
    const lampau = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 1_000_000, tanggal: '2026-06-01', tanggalHariIni: HARI_INI });
    expect(lampau.valid).toBe(false);
  });

  test('saldo simpanan minimum dinilai per tanggal pengajuan', async () => {
    await setPolicyValue('MINIMUM_SALDO_SIMPANAN_PINJAMAN', 500_000);
    await setor(testDb, A, 'POKOK', '2026-01-10', 100_000, 'SP-3');
    await setor(testDb, A, 'WAJIB', '2026-01-10', 50_000, 'SW-3');
    await setor(testDb, A, 'SUKARELA', '2026-05-01', 600_000, 'SS-3');

    const awal = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 1_000_000, tanggal: '2026-02-01', tanggalHariIni: HARI_INI });
    expect(awal.valid).toBe(false);
    expect(awal.alasan.join(' ')).toMatch(/syarat minimum/);
    const akhir = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 1_000_000, tanggal: '2026-06-01', tanggalHariIni: HARI_INI });
    expect(akhir.valid).toBe(true);
  });

  test('sisa pinjaman berjalan per tanggal: pinjaman yang baru dibuat sesudahnya tidak ikut; pembayaran sebelum tanggal itu mengurangi', async () => {
    await setor(testDb, A, 'POKOK', '2026-01-01', 100_000, 'SP-4');
    await setor(testDb, A, 'WAJIB', '2026-01-01', 50_000, 'SW-4');
    // Pinjaman 1 (Feb 2026): 2 angsuran @500rb. Angsuran 1 dibayar 2026-03-10.
    await sisipPinjaman(testDb, { id: 'pj1', anggotaId: A, tanggal: '2026-02-01', jadwal: [{ tempo: '2026-03-01', pokok: 450_000, jasa: 50_000 }, { tempo: '2026-04-01', pokok: 450_000, jasa: 50_000 }] });
    await bayar(testDb, 'pj1', 1, '2026-03-10');
    // Pinjaman 2 (Sep 2026): dibuat SESUDAH semua tanggal pengajuan yang diuji di bawah.
    await sisipPinjaman(testDb, { id: 'pj2', anggotaId: A, tanggal: '2026-09-01', jadwal: [{ tempo: '2026-10-01', pokok: 900_000, jasa: 100_000 }] });

    expect(await getTotalOutstandingPerTanggal(testDb as never, A, '2026-02-15')).toBe(1_000_000); // pj1 belum dibayar
    expect(await getTotalOutstandingPerTanggal(testDb as never, A, '2026-03-05')).toBe(1_000_000); // bayar baru 03-10
    expect(await getTotalOutstandingPerTanggal(testDb as never, A, '2026-03-20')).toBe(500_000);   // setelah bayar 1
    expect(await getTotalOutstandingPerTanggal(testDb as never, A, '2026-09-15')).toBe(1_500_000);  // pj2 ikut

    await setPolicyValue('MAX_OUTSTANDING_PER_ANGGOTA', 1_500_000);
    // Per 2026-02-15: 1.000.000 + 600.000 > 1.500.000 -> tidak memenuhi.
    const a = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 600_000, tanggal: '2026-02-15', tanggalHariIni: HARI_INI });
    expect(a.valid).toBe(false);
    expect(a.alasan.join(' ')).toMatch(/batas outstanding/);
    // Per 2026-03-20: 500.000 + 600.000 <= 1.500.000 -> memenuhi, WALAU hari ini (pj2 + sisa pj1) sudah penuh.
    const b = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 600_000, tanggal: '2026-03-20', tanggalHariIni: HARI_INI });
    expect(b.valid).toBe(true);
    const hariIni = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 600_000, tanggal: HARI_INI, tanggalHariIni: HARI_INI });
    expect(hariIni.valid).toBe(false); // keadaan sekarang: pj1 sisa 500rb + pj2 1jt
  });

  test('pinjaman LUNAS dengan pelunasan dipercepat dan rabat jasa dianggap lunas sejak tanggal pelunasan', async () => {
    await sisipPinjaman(testDb, { id: 'pjl', anggotaId: A, tanggal: '2026-01-05', status: 'LUNAS', jadwal: [{ tempo: '2026-03-05', pokok: 900_000, jasa: 100_000 }] });
    // Pelunasan dipercepat 2026-02-01 (jadwal_id NULL), jasa dirabat sehingga bayar (900rb) < kontrak (1jt).
    await testDb.runAsync(
      `INSERT INTO angsuran_pembayaran (id, pinjaman_id, jadwal_id, tanggal, nominal, porsi_pokok, porsi_jasa, porsi_denda, sumber_dana, created_by, created_at)
       VALUES ('ap-lunas','pjl',NULL,'2026-02-01',900000,900000,0,0,'KAS',?,?)`, USER_ID, new Date().toISOString()
    );
    expect(await getTotalOutstandingPerTanggal(testDb as never, A, '2026-01-20')).toBe(1_000_000);
    expect(await getTotalOutstandingPerTanggal(testDb as never, A, '2026-02-01')).toBe(0);
    expect((await getTunggakanAnggotaPerTanggal(testDb as never, A, '2026-04-01')).jumlahTunggakanAktif).toBe(0);
  });

  test('tunggakan per tanggal: angsuran yang BARU dibayar sesudah tanggal pengajuan masih menunggak pada tanggal itu', async () => {
    await setor(testDb, A, 'POKOK', '2026-01-01', 100_000, 'SP-5');
    await setor(testDb, A, 'WAJIB', '2026-01-01', 50_000, 'SW-5');
    await sisipPinjaman(testDb, { id: 'pjt', anggotaId: A, tanggal: '2026-01-02', jadwal: [{ tempo: '2026-02-01', pokok: 450_000, jasa: 50_000 }, { tempo: '2026-03-01', pokok: 450_000, jasa: 50_000 }] });
    await bayar(testDb, 'pjt', 1, '2026-03-15');
    await bayar(testDb, 'pjt', 2, '2026-03-15');

    const t = await getTunggakanAnggotaPerTanggal(testDb as never, A, '2026-03-10');
    expect(t.jumlahTunggakanAktif).toBe(2); // 02-01 dan 03-01 belum dibayar pada 03-10 (hari 02-01 -> 03-10 = 37)
    expect(t.hariTerlambatMaksimum).toBe(37);
    expect((await getTunggakanAnggotaPerTanggal(testDb as never, A, '2026-03-20')).jumlahTunggakanAktif).toBe(0);

    await setPolicyValue('MAX_TUNGGAKAN_AKTIF', 1);
    const tolak = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 100_000, tanggal: '2026-03-10', tanggalHariIni: HARI_INI });
    expect(tolak.valid).toBe(false);
    expect(tolak.alasan.join(' ')).toMatch(/tunggakan aktif/);
    const lolos = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 100_000, tanggal: '2026-03-20', tanggalHariIni: HARI_INI });
    expect(lolos.valid).toBe(true);
  });

  test('semua syarat yang gagal dikumpulkan; checkEligibilitasPinjaman tetap mengembalikan alasan PERTAMA', async () => {
    await setPolicyValue('MAX_PINJAMAN_PER_ANGGOTA', 100_000);
    const h = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 1_000_000, tanggal: '2026-02-01', tanggalHariIni: HARI_INI });
    expect(h.alasan.length).toBe(2); // belum pokok/wajib + melebihi plafon
    const r = await checkEligibilitasPinjaman(testDb as never, { anggotaId: A, jumlahDiajukan: 1_000_000, tanggal: '2026-02-01' });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(h.alasan[0]);
  });

  test('anggota tidak ditemukan', async () => {
    const h = await evaluasiEligibilitasPinjaman(testDb as never, { anggotaId: 'tidak-ada', jumlahDiajukan: 1, tanggal: '2026-02-01', tanggalHariIni: HARI_INI });
    expect(h).toMatchObject({ valid: false, alasan: ['Anggota tidak ditemukan.'] });
  });
});

describe('RC-S133.6.4 §1 — ajukanPinjaman: form menolak, import memperingatkan', () => {
  const A = 'anggota-uji-ajukan';
  const input = (extra: Record<string, unknown> = {}) => ({
    anggotaId: A,
    tanggal: '2026-02-01',
    jumlahPinjaman: 1_000_000,
    tenor: 2,
    satuanTenor: 'BULAN' as const,
    metodeJasa: 'CUSTOM' as const,
    persentaseJasa: 0,
    biayaAdminTipe: 'TIDAK_ADA' as const,
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: USER_ID,
    ...extra,
  });
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await tambahAnggotaBaru(testDb, A, '0902');
    // Simpanan pokok & wajib BARU ada sesudah tanggal pengajuan (2026-02-01).
    await setor(testDb, A, 'POKOK', '2026-03-01', 100_000, 'SP-A');
    await setor(testDb, A, 'WAJIB', '2026-03-01', 50_000, 'SW-A');
  });

  test('bawaan (form): pengajuan bertanggal lampau DITOLAK dengan alasan pada tanggal itu, tidak ada pinjaman tersimpan', async () => {
    await expect(ajukanPinjaman(input())).rejects.toThrow(/Simpanan Pokok dan Simpanan Wajib/);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM pinjaman WHERE anggota_id = ?`, A);
    expect(n!.n).toBe(0);
  });

  test("modeEligibilitas 'TOLAK' eksplisit sama dengan bawaan", async () => {
    await expect(ajukanPinjaman(input({ modeEligibilitas: 'TOLAK' }))).rejects.toThrow(/Simpanan Pokok/);
  });

  test("pengajuan bertanggal sesudah simpanan disetor lolos tanpa peringatan", async () => {
    const h = await ajukanPinjaman(input({ tanggal: '2026-03-01' }));
    expect(h.id).toBeTruthy();
    expect(h.peringatanSyarat).toEqual([]);
  });

  test("modeEligibilitas 'PERINGATAN' (import): pinjaman TETAP dibuat, alasan dikembalikan dengan kalimat netral", async () => {
    const h = await ajukanPinjaman(input({ modeEligibilitas: 'PERINGATAN' }));
    expect(h.id).toBeTruthy();
    expect(h.peringatanSyarat).toHaveLength(1);
    expect(h.peringatanSyarat[0]).toMatch(/^Anggota belum memiliki Simpanan Pokok dan Simpanan Wajib\.?$/);
    expect(h.peringatanSyarat.join(' ')).not.toMatch(/ditolak/i);
    const row = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM pinjaman WHERE id = ?`, h.id);
    expect(row!.status).toBe('DIAJUKAN');
  });
});

describe('RC-S133.6.4 §1 — pratinjau import: pemeriksaan syarat pinjaman pada tanggal pinjaman', () => {
  const KEBIJAKAN = { saldoMinimum: 0, plafonPinjaman: 0 };
  const berkas = (simpananTanggal: string, pinjamanTanggal: string, jumlah = '5.000.000') =>
    parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['A1', 'Budi', '01/01/2026']],
      SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'], ['A1', simpananTanggal, '100.000', '50.000', '0', 'KAS']],
      PINJAMAN: [['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'], ['A1', pinjamanTanggal, jumlah, '6', 'BULAN', 'FLAT', '1', 'KAS']],
    });

  test('simpanan baru ada sesudah tanggal pinjaman -> PERINGATAN (bukan BLOKIR) dengan nomor baris & tanggal', () => {
    const r = berkas('15/03/2026', '01/02/2026');
    expect(r.siapDiimpor).toBe(true);
    const p = periksaSyaratPinjamanImport(r.hasil, { kebijakan: KEBIJAKAN });
    expect(p).toHaveLength(1);
    expect(p[0].kunci).toBe('syarat-pinjaman-lampau');
    expect(p[0].tingkat).toBe('PERINGATAN');
    expect(p[0].judul).toMatch(/1 pinjaman tidak memenuhi syarat/);
    expect(p[0].pesan).toMatch(/Baris 2/);
    expect(p[0].pesan).toMatch(/2026-02-01/);
    expect(p[0].pesan).toMatch(/Simpanan Pokok dan Simpanan Wajib/);
    expect(p[0].pesan).toMatch(/TETAP diimpor/);
    expect(p[0].pesan).not.toMatch(/ditolak\./);
  });

  test('simpanan sudah ada pada/sebelum tanggal pinjaman -> hanya INFO', () => {
    const r = berkas('15/01/2026', '01/02/2026');
    const p = periksaSyaratPinjamanImport(r.hasil, { kebijakan: KEBIJAKAN });
    expect(p).toHaveLength(1);
    expect(p[0].tingkat).toBe('INFO');
  });

  test('saldo minimum & plafon dari kebijakan ikut diperiksa', () => {
    const r = berkas('15/01/2026', '01/02/2026', '5.000.000');
    const p = periksaSyaratPinjamanImport(r.hasil, { kebijakan: { saldoMinimum: 1_000_000, plafonPinjaman: 2_000_000 } });
    expect(p[0].tingkat).toBe('PERINGATAN');
    expect(p[0].pesan).toMatch(/syarat minimum/);
    expect(p[0].pesan).toMatch(/plafon maksimum/);
  });

  test('pinjaman lama sebelum cut-off (jalur migrasi) tidak diperiksa; pada/sesudah cut-off diperiksa', () => {
    const r = berkas('15/03/2026', '01/02/2026');
    expect(periksaSyaratPinjamanImport(r.hasil, { cutOff: '2026-03-01', kebijakan: KEBIJAKAN })).toEqual([]);
    expect(periksaSyaratPinjamanImport(r.hasil, { cutOff: '2026-02-01', kebijakan: KEBIJAKAN })[0].tingkat).toBe('PERINGATAN');
  });

  test('baris yang sudah pernah diimpor dilewati', () => {
    const r = berkas('15/03/2026', '01/02/2026');
    expect(periksaSyaratPinjamanImport(r.hasil, { kebijakan: KEBIJAKAN, lewatiBaris: new Set([2]) })).toEqual([]);
  });

  test('periksaSebelumImport memuatnya hanya bila kebijakan diberikan; tidak pernah menjadi BLOKIR', () => {
    const r = berkas('15/03/2026', '01/02/2026');
    const tanpa = periksaSebelumImport(r, { sifat: 'TRANSAKSI_BARU' });
    expect(tanpa.find((x) => x.kunci === 'syarat-pinjaman-lampau')).toBeUndefined();
    const dengan = periksaSebelumImport(r, { sifat: 'TRANSAKSI_BARU', kebijakanSyaratPinjaman: KEBIJAKAN });
    const p = dengan.find((x) => x.kunci === 'syarat-pinjaman-lampau');
    expect(p?.tingkat).toBe('PERINGATAN');
    expect(dengan.some((x) => x.tingkat === 'BLOKIR')).toBe(false);
  });
});

describe('RC-S133.6.4 §1 — import data awal: syarat tidak terpenuhi = peringatan, tercatat di hasil & Riwayat Import', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  const berkasImport = (adaSimpanan: boolean) =>
    parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['A1', 'Tanpa Simpanan Dulu', '01/01/2026'], ['A2', 'Lengkap', '01/01/2026']],
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'],
        // A1: simpanan bertanggal SESUDAH pinjamannya (atau tidak ada); A2: sebelum.
        ...(adaSimpanan ? [['A1', '01/03/2026', '100.000', '50.000', '0', 'KAS']] : []),
        ['A2', '05/01/2026', '100.000', '50.000', '0', 'KAS'],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'],
        ['A1', '01/02/2026', '3.000.000', '6', 'BULAN', 'FLAT', '1', 'KAS'],
        ['A2', '01/02/2026', '3.000.000', '6', 'BULAN', 'FLAT', '1', 'KAS'],
      ],
    });

  test('pinjaman tanpa simpanan pokok/wajib pada tanggalnya TETAP masuk (peringatan), yang memenuhi syarat tanpa peringatan', async () => {
    const ringkasan = berkasImport(false);
    const hasil = await jalankanImportDataAwal(ringkasan, { createdBy: USER_ID, dbRiwayat: testDb as never });

    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.berhasil).toBe(2);
    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.gagal).toBe(0);
    expect(hasil.gagal).toEqual([]);

    const bermasalah = hasil.berhasil.filter((b) => (b.peringatan?.length ?? 0) > 0);
    expect(bermasalah).toHaveLength(1);
    expect(bermasalah[0]).toMatchObject({ jenis: 'PINJAMAN', baris: 2 });
    expect(bermasalah[0].peringatan![0]).toMatch(/Simpanan Pokok dan Simpanan Wajib/);
    expect(hasil.berhasil.find((b) => b.jenis === 'PINJAMAN' && b.baris === 3)!.peringatan).toBeUndefined();

    // Keduanya benar-benar tercatat sebagai pinjaman aktif (sudah dicairkan).
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM pinjaman WHERE status = 'AKTIF'`);
    expect(n!.n).toBe(2);
  });

  test('Riwayat Import menyimpan peringatan di log baris BERHASIL; baris tanpa peringatan tetap tanpa pesan', async () => {
    const hasil = await jalankanImportDataAwal(berkasImport(true), { createdBy: USER_ID, dbRiwayat: testDb as never });
    // Simpanan A1 bertanggal 2026-03-01, pinjaman A1 2026-02-01 -> peringatan.
    expect(hasil.gagal).toEqual([]);
    const riwayat = await testDb.getFirstAsync<{ id: string; status: string }>(`SELECT id, status FROM import_data_awal_riwayat`);
    expect(riwayat!.status).toBe('BERHASIL'); // peringatan tidak mengubah status riwayat
    const log = await logRiwayatImport(testDb as never, riwayat!.id);
    const pinjamanLog = log.filter((b) => b.jenisSheet === 'PINJAMAN');
    expect(pinjamanLog).toHaveLength(2);
    const a1 = pinjamanLog.find((b) => b.baris === 2)!;
    const a2 = pinjamanLog.find((b) => b.baris === 3)!;
    expect(a1.status).toBe('BERHASIL');
    expect(adalahPeringatanSyarat(a1)).toBe(true);
    expect(a1.pesan).toMatch(/^Peringatan syarat pinjaman pada tanggal pinjaman: /);
    expect(a2.pesan).toBeNull();
    expect(adalahPeringatanSyarat(a2)).toBe(false);
  });
});
