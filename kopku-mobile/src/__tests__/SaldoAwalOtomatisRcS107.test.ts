import { TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let r: unknown;
    await testDb.withTransactionAsync(async () => { r = await fn(testDb); });
    return r;
  }),
}));

import { buatFixtureHistoris, ACC, USER_ID, saldoGl, totalDebitKredit } from './historicalFixture';
import { parseBerkasDataAwal } from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import {
  susunRencanaSaldoAwal,
  pesanSudahAda,
  PEMETAAN_POS,
  CATATAN_SALDO_AWAL_OTOMATIS,
} from '@/import/SaldoAwalOtomatisPlan';
import {
  hitungPenyusutanMasaLalu,
  validasiMigrasiAset,
  adalahAsetMigrasi,
  PENANDA_MIGRASI_ASET,
  KETERBATASAN_MIGRASI_ASET,
  majuPeriodeBulan,
  selisihPeriode,
  type BarisMigrasiAset,
} from '@/import/MigrasiAsetPlan';

/**
 * RC-S107 — SALDO AWAL OTOMATIS & IMPORT ASET TETAP.
 *
 * Dua hal yang dibuktikan: angka buku pembantu benar-benar sampai ke
 * buku besar tanpa diketik ulang, dan aset lama masuk TANPA mengurangi
 * kas maupun mengakui ulang penyusutan tahun-tahun lalu.
 */

const CUTOFF = '2026-09-01';
const HDR_ANGGOTA = ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'];
const HDR_SIMPANAN = ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'];
const HDR_PINJAMAN = ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Angsuran Sudah Dibayar'];
const HDR_ASET = ['Nomor Aset', 'Nama Aset', 'Tanggal Perolehan', 'Nilai Perolehan', 'Masa Manfaat Bulan', 'Nilai Residu'];

async function siapkanKliring() {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT OR IGNORE INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-kliring-sa','3-5000','Saldo Awal Belum Sesuai','EKUITAS','KREDIT',1,1,?,?)`, now, now);
  await testDb.runAsync(
    `INSERT OR IGNORE INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    'map-ksa', 'KOREKSI_SALDO_AWAL', 'KLIRING', 'acc-kliring-sa');
}

const opsi = () => ({
  createdBy: USER_ID,
  dbRiwayat: testDb as never,
  dbMigrasi: testDb as never,
  tanggalCutOff: CUTOFF,
});

// ===========================================================================
// A. PERENCANA (modul murni)
// ===========================================================================

describe('RC-S107 §A — rencana pengisian saldo awal', () => {
  test('pos bernilai 0 atau negatif dibuang — tambahSaldoAwalAkun memang menolaknya', () => {
    const r = susunRencanaSaldoAwal({ PIUTANG_PINJAMAN: 0, SIMPANAN_POKOK: -5, SIMPANAN_WAJIB: 100 });
    expect(r.map((x) => x.pos)).toEqual(['SIMPANAN_WAJIB']);
  });

  test('urutan aset lebih dulu dari simpanan — neraca terbaca dari aset ke ekuitas', () => {
    const r = susunRencanaSaldoAwal({ SIMPANAN_POKOK: 1, ASET_TETAP: 1, PIUTANG_PINJAMAN: 1 });
    expect(r.map((x) => x.pos)).toEqual(['PIUTANG_PINJAMAN', 'ASET_TETAP', 'SIMPANAN_POKOK']);
  });

  test('setiap pos memetakan lewat transaction_type/role, BUKAN kode akun yang dipaku', () => {
    for (const m of Object.values(PEMETAAN_POS)) {
      expect(m.tipeTransaksi).toMatch(/^[A-Z_]+$/);
      expect(m.peran).toMatch(/^[A-Z_]+$/);
      // Kode akun tidak boleh muncul di pemetaan.
      expect(JSON.stringify(m)).not.toMatch(/\b\d-\d{4}\b/);
    }
  });

  test('pesan pembanding menyebut kedua angka ketika berbeda', () => {
    const p = pesanSudahAda('Simpanan Pokok', 1_000_000, 1_500_000);
    expect(p).toContain('1.000.000');
    expect(p).toContain('1.500.000');
    expect(p).toMatch(/TIDAK diubah/i);
  });

  test('catatan menegaskan Kas tidak diisi otomatis dan saldo awal belum dikunci', () => {
    const teks = CATATAN_SALDO_AWAL_OTOMATIS.join(' ');
    expect(teks).toMatch(/Kas dan Bank TIDAK diisi otomatis/i);
    expect(teks).toMatch(/belum dikunci permanen/i);
    expect(teks).toMatch(/3-5000/);
  });
});

// ===========================================================================
// B. PENYUSUTAN MASA LALU (modul murni)
// ===========================================================================

describe('RC-S107 §B — akumulasi penyusutan sampai cut-off', () => {
  const dasar = {
    nilaiPerolehan: 4_800_000,
    nilaiResidu: 0,
    masaManfaatBulan: 48,
    tanggalPerolehan: '2024-01-15',
  };

  test('bulan perolehan dihitung penuh, periode bulan cut-off belum diakui', () => {
    const p = hitungPenyusutanMasaLalu({ ...dasar, tanggalCutOff: '2026-09-01' });
    // 2024-01 s.d. 2026-08 = 32 periode.
    expect(p.periode).toHaveLength(32);
    expect(p.periode[0]).toBe('2024-01');
    expect(p.periode[31]).toBe('2026-08');
    expect(p.nilaiPerPeriode).toBe(100_000);
    expect(p.akumulasi).toBe(3_200_000);
    expect(p.nilaiBuku).toBe(1_600_000);
  });

  test('aset baru (perolehan = bulan cut-off) belum punya penyusutan masa lalu', () => {
    const p = hitungPenyusutanMasaLalu({ ...dasar, tanggalPerolehan: '2026-09-02', tanggalCutOff: '2026-09-01' });
    expect(p.periode).toHaveLength(0);
    expect(p.akumulasi).toBe(0);
    expect(p.nilaiBuku).toBe(dasar.nilaiPerolehan);
  });

  test('aset yang masa manfaatnya sudah habis: akumulasi BERHENTI di nilai yang dapat disusutkan', () => {
    const p = hitungPenyusutanMasaLalu({ ...dasar, tanggalPerolehan: '2015-01-01', tanggalCutOff: '2026-09-01' });
    expect(p.periode).toHaveLength(48);
    expect(p.akumulasi).toBe(4_800_000);
    expect(p.nilaiBuku).toBe(0);
  });

  test('nilai buku TIDAK PERNAH jatuh di bawah nilai residu', () => {
    const p = hitungPenyusutanMasaLalu({
      nilaiPerolehan: 10_000_000, nilaiResidu: 1_000_000, masaManfaatBulan: 12,
      tanggalPerolehan: '2010-01-01', tanggalCutOff: '2026-09-01',
    });
    expect(p.akumulasi).toBe(9_000_000);
    expect(p.nilaiBuku).toBe(1_000_000);
  });

  test('pembagian yang tidak bulat tidak membuat akumulasi melampaui dasar', () => {
    const p = hitungPenyusutanMasaLalu({
      nilaiPerolehan: 1_000_000, nilaiResidu: 0, masaManfaatBulan: 7,
      tanggalPerolehan: '2020-01-01', tanggalCutOff: '2026-09-01',
    });
    expect(p.akumulasi).toBe(1_000_000);
  });

  test('bantu periode: maju & selisih bulan konsisten melintasi tahun', () => {
    expect(majuPeriodeBulan('2024-11', 3)).toBe('2025-02');
    expect(selisihPeriode('2024-11', '2025-02')).toBe(3);
  });
});

// ===========================================================================
// C. VALIDASI ASET
// ===========================================================================

describe('RC-S107 §C — validasi baris aset', () => {
  const baris = (over: Partial<BarisMigrasiAset> = {}): BarisMigrasiAset => ({
    baris: 2, nomorAset: 'AST-001', namaAset: 'Meja', tanggalPerolehan: '2024-01-01',
    nilaiPerolehan: 5_000_000, masaManfaatBulan: 48, nilaiResidu: 0, ...over,
  });

  test('baris sah tidak menghasilkan galat', () => {
    expect(validasiMigrasiAset([baris()], { tanggalCutOff: CUTOFF })).toEqual([]);
  });

  test('nomor aset ganda dalam satu berkas ditolak', () => {
    const g = validasiMigrasiAset([baris(), baris({ baris: 3 })], { tanggalCutOff: CUTOFF });
    expect(g.map((x) => x.kode)).toContain('NOMOR_ASET_GANDA');
  });

  test('aset yang diperoleh SESUDAH cut-off ditolak — itu pembelian baru', () => {
    const g = validasiMigrasiAset([baris({ tanggalPerolehan: '2026-12-01' })], { tanggalCutOff: CUTOFF });
    expect(g.map((x) => x.kode)).toContain('PEROLEHAN_SETELAH_CUTOFF');
    expect(g[0].pesan).toMatch(/menu Aset/i);
  });

  test('residu >= nilai perolehan ditolak', () => {
    const g = validasiMigrasiAset([baris({ nilaiResidu: 5_000_000 })], { tanggalCutOff: CUTOFF });
    expect(g.map((x) => x.kode)).toContain('RESIDU_TIDAK_VALID');
  });

  test('keterbatasan dinyatakan, termasuk bahwa akumulasi dihitung bukan diambil', () => {
    const teks = KETERBATASAN_MIGRASI_ASET.join(' ');
    expect(teks).toMatch(/DIHITUNG dari nilai perolehan/i);
    expect(teks).toMatch(/TIDAK menjurnal pembelian/i);
    expect(teks).toMatch(/tidak diakui ulang/i);
  });
});

// ===========================================================================
// D. END-TO-END
// ===========================================================================

describe('RC-S107 §D — import mengisi saldo awal sendiri', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await siapkanKliring();
  });

  const berkas = () =>
    parseBerkasDataAwal({
      ANGGOTA: [HDR_ANGGOTA, ['A1', 'Budi', '2024-01-02']],
      SIMPANAN: [HDR_SIMPANAN, ['A1', '2025-01-01', '100000', '2400000', '500000']],
      PINJAMAN: [HDR_PINJAMAN, ['A1', '2025-07-01', '12000000', '12', 'BULAN', 'FLAT', '1.5', 'KAS', '3']],
      ASET: [HDR_ASET, ['AST-001', 'Meja Kantor', '2024-01-15', '4800000', '48', '0']],
    });

  test('saldo awal terisi sendiri untuk piutang, simpanan, aset, dan akumulasi', async () => {
    const h = await jalankanImportDataAwal(berkas(), opsi());
    expect(h.saldoAwal).not.toBeNull();
    const per = new Map(h.saldoAwal!.baris.map((b) => [b.pos, b]));
    expect(per.get('PIUTANG_PINJAMAN')?.status).toBe('DIISI');
    expect(per.get('PIUTANG_PINJAMAN')?.saldoImport).toBe(9_000_000);
    expect(per.get('SIMPANAN_POKOK')?.saldoImport).toBe(100_000);
    expect(per.get('SIMPANAN_WAJIB')?.saldoImport).toBe(2_400_000);
    expect(per.get('SIMPANAN_SUKARELA')?.saldoImport).toBe(500_000);
    expect(per.get('ASET_TETAP')?.saldoImport).toBe(4_800_000);
    expect(per.get('AKUMULASI_PENYUSUTAN')?.saldoImport).toBe(3_200_000);
    expect(h.saldoAwal!.jumlahGagal).toBe(0);
  });

  test('angka saldo awal SAMA dengan buku pembantunya — bukan diketik ulang', async () => {
    const h = await jalankanImportDataAwal(berkas(), opsi());
    const per = new Map(h.saldoAwal!.baris.map((b) => [b.pos, b]));
    expect(per.get('PIUTANG_PINJAMAN')!.saldoImport).toBe(h.migrasi!.totalSisaPokok);
    const jadwal = await testDb.getFirstAsync<{ t: number }>(`SELECT SUM(pokok) t FROM angsuran_jadwal WHERE status != 'LUNAS'` /* DIPERBARUI RC-S133.4.5: angsuran yang sudah dibayar kini ikut tercatat (LUNAS) */);
    expect(Number(jadwal?.t)).toBe(h.migrasi!.totalSisaPokok);
  });

  test('KAS TIDAK diisi otomatis dan tidak bergerak sama sekali', async () => {
    const kas = await saldoGl(testDb, ACC.kas);
    const h = await jalankanImportDataAwal(berkas(), opsi());
    expect(h.saldoAwal!.baris.some((b) => /kas/i.test(b.label))).toBe(false);
    expect(await saldoGl(testDb, ACC.kas)).toBe(kas);
  });

  test('buku besar tetap seimbang setelah seluruh saldo awal diposting', async () => {
    await jalankanImportDataAwal(berkas(), opsi());
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  test('saldo awal yang SUDAH diisi pengguna TIDAK ditimpa, hanya dilaporkan', async () => {
    // Isi Simpanan Pokok lebih dulu dengan angka berbeda.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at)
       VALUES ('sa-manual', ?, ?, 777000, NULL, ?, ?, ?)`,
      ACC.simpananPokok, CUTOFF, USER_ID, now, now);

    const h = await jalankanImportDataAwal(berkas(), opsi());
    const pokok = h.saldoAwal!.baris.find((b) => b.pos === 'SIMPANAN_POKOK')!;
    expect(pokok.status).toBe('SUDAH_ADA');
    expect(pokok.saldoSebelumnya).toBe(777_000);
    expect(pokok.saldoImport).toBe(100_000);
    // Nilainya benar-benar tidak berubah di database.
    const row = await testDb.getFirstAsync<{ saldo: number }>(
      `SELECT saldo FROM saldo_awal_akun WHERE account_id = ?`, ACC.simpananPokok);
    expect(row?.saldo).toBe(777_000);
  });
});

// ===========================================================================
// E. ASET: TIDAK MENGURANGI KAS, TIDAK MENGAKUI ULANG PENYUSUTAN
// ===========================================================================

describe('RC-S107 §E — import aset tetap', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await siapkanKliring();
  });

  const berkasAset = (rows: (string | number)[][]) =>
    parseBerkasDataAwal({
      ANGGOTA: [HDR_ANGGOTA, ['A1', 'Budi', '2024-01-02']],
      ASET: [HDR_ASET, ...rows],
    });

  test('aset tercatat di daftar aset, TANPA jurnal pembelian, kas tidak bergerak', async () => {
    const kas = await saldoGl(testDb, ACC.kas);
    const h = await jalankanImportDataAwal(
      berkasAset([['AST-001', 'Meja Kantor', '2024-01-15', '4800000', '48', '0']]), opsi());

    expect(h.perSheet.find((s) => s.jenis === 'ASET')!.berhasil).toBe(1);
    const a = await testDb.getFirstAsync<{ nama_aset: string; journal_id: string | null; keterangan: string; nilai_perolehan: number; tanggal_perolehan: string }>(
      `SELECT nama_aset, journal_id, keterangan, nilai_perolehan, tanggal_perolehan FROM aset_tetap`);
    expect(a?.nama_aset).toBe('Meja Kantor');
    expect(a?.journal_id).toBeNull();
    expect(adalahAsetMigrasi(a?.keterangan)).toBe(true);
    expect(a?.keterangan).toContain(PENANDA_MIGRASI_ASET);
    // Nilai & tanggal perolehan HISTORIS dipertahankan, bukan diganti nilai buku.
    expect(a?.nilai_perolehan).toBe(4_800_000);
    expect(a?.tanggal_perolehan).toBe('2024-01-15');
    expect(await saldoGl(testDb, ACC.kas)).toBe(kas);
  });

  test('periode penyusutan masa lalu ditandai sudah diakui — beban lama tidak diakui ulang', async () => {
    await jalankanImportDataAwal(
      berkasAset([['AST-001', 'Meja Kantor', '2024-01-15', '4800000', '48', '0']]), opsi());
    const p = await testDb.getFirstAsync<{ n: number; t: number }>(
      `SELECT COUNT(*) n, SUM(nilai_penyusutan) t FROM aset_penyusutan`);
    expect(Number(p?.n)).toBe(32);
    expect(Number(p?.t)).toBe(3_200_000);
    // Jumlahnya PERSIS sama dengan saldo awal Akumulasi Penyusutan.
    const sa = await testDb.getFirstAsync<{ saldo: number }>(
      `SELECT saldo FROM saldo_awal_akun WHERE account_id = ?`, ACC.akumulasi);
    expect(sa?.saldo).toBe(3_200_000);
  });

  test('baris penyusutan masa lalu merujuk jurnal saldo awal, bukan jurnal karangan', async () => {
    await jalankanImportDataAwal(
      berkasAset([['AST-001', 'Meja', '2024-01-15', '4800000', '48', '0']]), opsi());
    const sa = await testDb.getFirstAsync<{ journal_id: string | null }>(
      `SELECT journal_id FROM saldo_awal_akun WHERE account_id = ?`, ACC.akumulasi);
    const rows = await testDb.getAllAsync<{ journal_id: string }>(`SELECT DISTINCT journal_id FROM aset_penyusutan`);
    expect(rows).toHaveLength(1);
    expect(rows[0].journal_id).toBe(sa?.journal_id);
  });

  test('import ULANG tidak menggandakan aset', async () => {
    const rows = [['AST-001', 'Meja', '2024-01-15', '4800000', '48', '0']];
    await jalankanImportDataAwal(berkasAset(rows), opsi());
    const kedua = await jalankanImportDataAwal(berkasAset(rows), opsi());
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM aset_tetap`);
    expect(Number(n?.n)).toBe(1);
    expect(kedua.aset?.berhasil ?? []).toHaveLength(0);
    expect(kedua.aset?.dilewati.length).toBeGreaterThan(0);
  });

  test('satu baris rusak membatalkan seluruh migrasi aset — tidak ada yang separuh masuk', async () => {
    const h = await jalankanImportDataAwal(
      berkasAset([
        ['AST-001', 'Meja', '2024-01-15', '4800000', '48', '0'],
        ['AST-002', 'Lemari', '2026-12-01', '2000000', '24', '0'],
      ]),
      opsi()
    );
    // Baris kedua berakad SESUDAH cut-off -> validasi menolak seluruhnya.
    expect(h.perSheet.find((s) => s.jenis === 'ASET')!.berhasil).toBe(0);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM aset_tetap`);
    expect(Number(n?.n)).toBe(0);
  });

  test('buku besar seimbang, dan Aset Tetap serta Akumulasi Penyusutan terisi di neraca', async () => {
    await jalankanImportDataAwal(
      berkasAset([['AST-001', 'Meja', '2024-01-15', '4800000', '48', '0']]), opsi());
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
    expect(await saldoGl(testDb, ACC.asetTetap)).toBe(4_800_000);
    // `saldoGl` mengembalikan debit - kredit. Akumulasi Penyusutan
    // adalah akun KONTRA-aset (normal kredit), jadi saldonya negatif di
    // konvensi ini — dan justru itu yang benar: ia MENGURANGI aset
    // tetap di Laporan Posisi Keuangan.
    expect(await saldoGl(testDb, ACC.akumulasi)).toBe(-3_200_000);
    // Nilai buku aset tetap = perolehan - akumulasi.
    expect(
      (await saldoGl(testDb, ACC.asetTetap)) + (await saldoGl(testDb, ACC.akumulasi))
    ).toBe(1_600_000);
  });
});
