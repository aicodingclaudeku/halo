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
import {
  parseBerkasDataAwal,
  parseSheetSaldoAwalAkun,
  cocokkanSheetSaldoAwalAkun,
  cocokkanJenisSheet,
  JUDUL_SHEET_SALDO_AWAL_AKUN,
} from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal, PESAN_SALDO_AWAL_AKUN_TANPA_CUTOFF } from '@/import/EksekusiImportDataAwal';
import { periksaBarisMigrasiBerjangka, PESAN_BERJANGKA_SUDAH_JATUH_TEMPO } from '@/import/EksekusiMigrasiBerjangka';
import { jalankanCatchUpAkrualSimpananBerjangka } from '@/services/SimpananBerjangkaCatchUpService';
import { getTotalUtangBungaBerjangkaPadaDb } from '@/services/SimpananBerjangkaLifecycleService';
import { bacaBagianBelumTunaiSaldoAwal } from '@/accounting/SaldoAwalRealisasiKas';
import { tambahSaldoAwalAkun, aturBagianTunaiSaldoAwal } from '@/services/SaldoAwalAkunService';
import {
  SHEET_SALDO_AWAL_AKUN,
  SHEET_TEMPLATE,
  SHEET_TEMPLATE_TRANSAKSI_BARU,
  BARIS_PETUNJUK,
  BARIS_PETUNJUK_TRANSAKSI_BARU,
  judulKolomExcel,
} from '@/import/TemplateDataAwal';
import { bangunWorkbookTemplate } from '@/import/TemplateWorkbook';

/**
 * RC-S133.4.6 — IMPORT "SALDO LAMA" SETARA TRANSAKSI BIASA.
 *
 * Uji dua jalur RC-S133.4.5 (skenario 4 anggota, 4 pinjaman, berjangka,
 * aset, beban; cut-off 1 Jul 2026) menemukan import saldo lama berbeda
 * dari transaksi biasa karena:
 *  1. sheet 4 Simpanan Berjangka menjurnal Debit Kas (kas fiktif) dan
 *     bunga sebelum cut-off diakru & dipindahkan ulang;
 *  2. SHU Basis Kas menganggap saldo awal Beban Penyusutan tunai;
 *  3. Kas/pendapatan/beban harus diketik manual di menu Saldo Awal.
 */
const CUTOFF = '2026-07-01';
const ANGGOTA = [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Siti', '2026-01-05'], ['K2', 'Budi', '2026-01-05']];
const HEADER_BERJANGKA = ['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan', 'Bunga Persen Per Tahun', 'Sumber Dana'];
const HEADER_AKUN = ['Kode Akun *', 'Nama Akun', 'Saldo *', 'Bagian Tunai (khusus pendapatan/beban)'];

async function tambahKliring(): Promise<void> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES ('acc-kliring','3-5000','Saldo Awal Belum Sesuai','EKUITAS','KREDIT',1,0,?,?)`,
    now,
    now
  );
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kliring','KOREKSI_SALDO_AWAL','KLIRING','acc-kliring')`);
}
const opsi = (cut: string | null = CUTOFF) => ({
  createdBy: USER_ID,
  dbRiwayat: testDb as never,
  dbMigrasi: testDb as never,
  tanggalCutOff: cut ?? undefined,
});
const jumlahJurnal = async (sumber: string) =>
  (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = ?`, sumber))!.n;

describe('RC-S133.4.6 — modul murni', () => {
  test('berjangka saldo lama: tenor, nominal, tanggal sebelum cut-off, belum jatuh tempo', () => {
    const dasar = { tanggal: '2026-03-20', nominal: 4_000_000, tenorBulan: 12, tanggalCutOff: CUTOFF };
    expect(periksaBarisMigrasiBerjangka(dasar)).toBeNull();
    expect(periksaBarisMigrasiBerjangka({ ...dasar, tenorBulan: 5 })).toMatch(/3, 6, atau 12/);
    expect(periksaBarisMigrasiBerjangka({ ...dasar, nominal: 0 })).toMatch(/lebih besar dari 0/);
    expect(periksaBarisMigrasiBerjangka({ ...dasar, tanggal: CUTOFF })).toMatch(/sebelum tanggal cut-off/);
    expect(periksaBarisMigrasiBerjangka({ ...dasar, tanggal: '2026-01-10', tenorBulan: 3 })).toBe(PESAN_BERJANGKA_SUDAH_JATUH_TEMPO);
    // jatuh tempo TEPAT pada cut-off masih diterima (periode terakhirnya diakru aplikasi)
    expect(periksaBarisMigrasiBerjangka({ ...dasar, tanggal: '2026-04-01', tenorBulan: 3 })).toBeNull();
  });

  test('sheet 7 dikenali dari namanya dan tidak tertukar dengan sheet lain', () => {
    expect(cocokkanSheetSaldoAwalAkun(JUDUL_SHEET_SALDO_AWAL_AKUN)).toBe(true);
    expect(cocokkanSheetSaldoAwalAkun('Neraca Saldo')).toBe(true);
    expect(cocokkanJenisSheet(JUDUL_SHEET_SALDO_AWAL_AKUN)).toBeNull();
    for (const s of SHEET_TEMPLATE) expect(cocokkanSheetSaldoAwalAkun(s.nama)).toBe(false);
    expect(cocokkanSheetSaldoAwalAkun('Daftar Akun')).toBe(false);
  });

  test('parser sheet 7: baris contoh ditolak, saldo wajib > 0, bagian tunai ≤ saldo, satu akun satu baris', () => {
    const contoh = [HEADER_AKUN, SHEET_SALDO_AWAL_AKUN.kolom.map((k) => k.contoh)];
    expect(parseSheetSaldoAwalAkun(contoh).galat[0].pesan).toMatch(/baris contoh/);
    const h = parseSheetSaldoAwalAkun([
      ['keterangan'],
      [],
      SHEET_SALDO_AWAL_AKUN.kolom.map(judulKolomExcel),
      ['1-1000', 'Kas', 'Rp 2.061.666', null],
      ['4-1000', 'Pendapatan Jasa', 1_045_000, 1_045_000],
      ['5-1300', '', 375_000, 0],
      ['5-1200', '', 0, null],
      ['5-1700', '', 100, 200],
      ['1-1000', 'Kas lagi', 5, null],
    ]);
    expect(h.baris).toEqual([
      { baris: 4, kodeAkun: '1-1000', namaAkun: 'Kas', saldo: 2_061_666, bagianTunai: null },
      { baris: 5, kodeAkun: '4-1000', namaAkun: 'Pendapatan Jasa', saldo: 1_045_000, bagianTunai: 1_045_000 },
      { baris: 6, kodeAkun: '5-1300', namaAkun: null, saldo: 375_000, bagianTunai: 0 },
    ]);
    const pesan = h.galat.map((g) => g.pesan).join(' | ');
    expect(pesan).toMatch(/Saldo harus lebih dari 0/);
    expect(pesan).toMatch(/tidak boleh melebihi Saldo/);
    expect(pesan).toMatch(/sudah dipakai baris 4/);
  });

  test('berkas tanpa sheet 7 tetap dibaca seperti sebelumnya', () => {
    const r = parseBerkasDataAwal({ ANGGOTA });
    expect(r.hasil.saldoAwalAkun).toBeUndefined();
    expect(r.siapDiimpor).toBe(true);
  });

  test('dua template: Saldo Lama memuat sheet 1–7 + Daftar Akun; Transaksi Baru hanya sheet 1–4 berkolom inti', () => {
    const lama = bangunWorkbookTemplate();
    for (const s of SHEET_TEMPLATE) expect(lama.SheetNames).toContain(s.nama);
    expect(lama.SheetNames).toContain(JUDUL_SHEET_SALDO_AWAL_AKUN);
    expect(lama.SheetNames).toContain('Daftar Akun');
    const baru = bangunWorkbookTemplate('TRANSAKSI_BARU');
    expect(baru.SheetNames).toEqual(['Petunjuk', '1. Anggota', '2. Simpanan', '3. Pinjaman', '4. Simpanan Berjangka']);
    const pinjaman = SHEET_TEMPLATE_TRANSAKSI_BARU.find((s) => s.jenis === 'PINJAMAN')!;
    expect(pinjaman.kolom.map((k) => k.label)).not.toContain('Nomor Pinjaman Lama');
    expect(pinjaman.kolom[pinjaman.kolom.length - 1].label).toBe('Angsuran Sudah Dibayar');
    expect(BARIS_PETUNJUK.flat().join(' ')).toMatch(/7\. Saldo Awal Akun/);
    expect(BARIS_PETUNJUK_TRANSAKSI_BARU.flat().join(' ')).not.toMatch(/cut-off/);
  });

  test('jalur migrasi berjangka TIDAK mengimpor maupun memanggil createJournal', () => {
    const src = (require('fs') as typeof import('fs')).readFileSync(
      (require('path') as typeof import('path')).join(process.cwd(), 'src/import/EksekusiMigrasiBerjangka.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/^import .*createJournal/m);
    expect(src).not.toMatch(/createJournal\s*\(/);
    expect(src).not.toMatch(/resolveKasBankAccountId/);
  });
});

describe('RC-S133.4.6 — simpanan berjangka saldo lama tanpa kas fiktif & bunga tidak ganda', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await tambahKliring();
  });

  test('penempatan sebelum cut-off: tanpa jurnal kas, saldo awal 2-1210 otomatis, bunga sebelum cut-off tercatat tanpa jurnal', async () => {
    const kas = await saldoGl(testDb, ACC.kas);
    const h = await jalankanImportDataAwal(
      parseBerkasDataAwal({ ANGGOTA, BERJANGKA: [HEADER_BERJANGKA, ['K1', '2026-03-20', 4_000_000, 12, 6, 'KAS']] }),
      opsi()
    );
    expect(h.perSheet.find((s) => s.jenis === 'BERJANGKA')).toMatchObject({ berhasil: 1, gagal: 0 });
    expect(await saldoGl(testDb, ACC.kas)).toBe(kas);
    expect(await jumlahJurnal('SIMPANAN_BERJANGKA')).toBe(0);
    expect(await jumlahJurnal('SIMPANAN_BERJANGKA_BUNGA_AKRUAL')).toBe(0);
    expect(h.saldoAwal!.baris.find((b) => b.pos === 'SIMPANAN_BERJANGKA')).toMatchObject({ status: 'DIISI', saldoImport: 4_000_000 });
    expect(await saldoGl(testDb, ACC.berjangka)).toBe(-4_000_000);
    const bunga = await testDb.getAllAsync<{ n: number; b: number; j: string | null }>(
      `SELECT nomor_periode n, bunga b, journal_id j FROM simpanan_berjangka_bunga ORDER BY nomor_periode`
    );
    expect(bunga).toEqual([
      { n: 1, b: 20_000, j: null },
      { n: 2, b: 20_000, j: null },
      { n: 3, b: 20_000, j: null },
    ]);
    const k = await testDb.getFirstAsync<{ journal_id: string | null; bunga_terakru: number }>(`SELECT journal_id, bunga_terakru FROM simpanan_berjangka`);
    expect(k).toEqual({ journal_id: null, bunga_terakru: 60_000 });
    const penanda = await testDb.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key LIKE 'simpanan_berjangka.migrasi_saldo_awal.%'`);
    expect(penanda!.value).toBe(CUTOFF);
    expect(h.keterbatasanTurunan.join(' ')).toMatch(/Simpanan berjangka lama dicatat TANPA jurnal kas/);
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  test('catch-up setelah cut-off hanya mengakru & memindahkan periode SESUDAH cut-off', async () => {
    await jalankanImportDataAwal(
      parseBerkasDataAwal({ ANGGOTA, BERJANGKA: [HEADER_BERJANGKA, ['K1', '2026-03-20', 4_000_000, 12, 6, 'KAS']] }),
      opsi()
    );
    await jalankanCatchUpAkrualSimpananBerjangka(USER_ID, '2026-08-25');
    // periode 4 (20 Jul) & 5 (20 Agu) saja
    expect(await saldoGl(testDb, ACC.bebanBungaBerjangka)).toBe(40_000);
    expect(await jumlahJurnal('SIMPANAN_BERJANGKA_BUNGA_AKRUAL')).toBe(2);
    expect(await jumlahJurnal('SIMPANAN_BERJANGKA_BUNGA_TRANSFER')).toBe(2);
    const sukarela = await testDb.getFirstAsync<{ t: number }>(
      `SELECT COALESCE(SUM(nominal),0) t FROM simpanan_transaksi WHERE jenis='SUKARELA' AND tipe='SETOR'`
    );
    expect(sukarela!.t).toBe(40_000);
    // utang bunga subledger = GL 2-1710 (bunga sebelum cut-off bukan utang)
    expect(await saldoGl(testDb, ACC.utangBungaBerjangka)).toBe(0);
    expect(await getTotalUtangBungaBerjangkaPadaDb(testDb as never)).toBe(0);
    const k = await testDb.getFirstAsync<{ bunga_terakru: number }>(`SELECT bunga_terakru FROM simpanan_berjangka`);
    expect(k!.bunga_terakru).toBe(100_000);
  });

  test('penempatan pada/sesudah cut-off tetap setoran biasa (kas bertambah)', async () => {
    const kas = await saldoGl(testDb, ACC.kas);
    await jalankanImportDataAwal(
      parseBerkasDataAwal({ ANGGOTA, BERJANGKA: [HEADER_BERJANGKA, ['K1', CUTOFF, 1_000_000, 3, 6, 'KAS']] }),
      opsi()
    );
    expect(await saldoGl(testDb, ACC.kas)).toBe(kas + 1_000_000);
    expect(await jumlahJurnal('SIMPANAN_BERJANGKA')).toBe(1);
  });

  test('tanpa cut-off (Transaksi baru) perilaku lama: setoran berjurnal kas', async () => {
    const kas = await saldoGl(testDb, ACC.kas);
    await jalankanImportDataAwal(
      parseBerkasDataAwal({ ANGGOTA, BERJANGKA: [HEADER_BERJANGKA, ['K1', '2026-03-20', 4_000_000, 12, 6, 'KAS']] }),
      opsi(null)
    );
    expect(await saldoGl(testDb, ACC.kas)).toBe(kas + 4_000_000);
  });

  test('berjangka yang sudah jatuh tempo sebelum cut-off ditolak dengan sebab jelas', async () => {
    const h = await jalankanImportDataAwal(
      parseBerkasDataAwal({ ANGGOTA, BERJANGKA: [HEADER_BERJANGKA, ['K1', '2026-01-10', 4_000_000, 3, 6, 'KAS']] }),
      opsi()
    );
    expect(h.perSheet.find((s) => s.jenis === 'BERJANGKA')).toMatchObject({ berhasil: 0, gagal: 1 });
    expect(h.gagal[0].pesan).toBe(PESAN_BERJANGKA_SUDAH_JATUH_TEMPO);
    expect(await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM simpanan_berjangka`)).toEqual({ n: 0 });
  });
});

describe('RC-S133.4.6 — sheet 7 Saldo Awal Akun', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await tambahKliring();
  });

  const berkas = (akun: unknown[][]) =>
    parseBerkasDataAwal({
      ANGGOTA,
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
        ['K1', '2026-06-30', 100_000, 300_000, 2_000_000],
      ],
      SALDO_AWAL_AKUN: [HEADER_AKUN, ...akun],
    });

  test('baris sah masuk lewat service Saldo Awal; akun otomatis, kliring & kode asing ditolak; keseimbangan dilaporkan', async () => {
    const h = await jalankanImportDataAwal(
      berkas([
        ['1-1000', 'Kas', 1_500_000, null],
        ['4-1000', 'Pendapatan Jasa', 300_000, 300_000],
        ['5-1300', 'Beban Penyusutan', 200_000, null],
        ['2-1100', 'Simpanan Sukarela', 2_000_000, null],
        ['3-5000', 'Kliring', 1, null],
        ['9-9999', 'Tidak ada', 1, null],
        ['1-1500', 'Aset Tetap', 1_000_000, 500_000],
      ]),
      opsi()
    );
    const s = h.saldoAwalAkun!;
    expect(s.berhasil.map((b) => b.kodeAkun)).toEqual(['1-1000', '4-1000', '5-1300']);
    const pesan = Object.fromEntries(s.gagal.map((g) => [g.kodeAkun, g.pesan]));
    expect(pesan['2-1100']).toMatch(/sudah diisi otomatis/);
    expect(pesan['3-5000']).toMatch(/penyeimbang/);
    expect(pesan['9-9999']).toMatch(/tidak ada di Daftar Akun/);
    expect(pesan['1-1500']).toMatch(/Bagian Tunai hanya untuk akun Pendapatan atau Beban/);
    expect(await saldoGl(testDb, ACC.kas)).toBeGreaterThanOrEqual(1_500_000);
    const sa = await testDb.getAllAsync<{ account_id: string; saldo: number; tanggal: string }>(
      `SELECT account_id, saldo, tanggal FROM saldo_awal_akun WHERE account_id IN (?,?,?) ORDER BY account_id`,
      ACC.kas,
      ACC.pendapatanJasa,
      ACC.bebanPenyusutan
    );
    expect(sa.map((r) => [r.account_id, r.saldo, r.tanggal])).toEqual([
      [ACC.bebanPenyusutan, 200_000, CUTOFF],
      [ACC.kas, 1_500_000, CUTOFF],
      [ACC.pendapatanJasa, 300_000, CUTOFF],
    ]);
    // simpanan 2.400.000 (otomatis) = kas 1.500.000 − beban 200.000 ... kliring = sisa yang belum diisi
    const kliring = -(await saldoGl(testDb, 'acc-kliring'));
    expect(s.saldoKliring).toBe(-kliring);
    // bagian tunai pendapatan diatur dari kolom → seluruhnya tunai; beban penyusutan bawaan → belum tunai
    const belum = await bacaBagianBelumTunaiSaldoAwal(testDb as never);
    expect(belum.get(ACC.pendapatanJasa)).toBeUndefined();
    expect(belum.get(ACC.bebanPenyusutan)).toBe(200_000);
  });

  test('tanpa cut-off seluruh baris sheet 7 ditolak dengan pesan jelas', async () => {
    const h = await jalankanImportDataAwal(berkas([['1-1000', 'Kas', 1_500_000, null]]), opsi(null));
    expect(h.saldoAwalAkun!.berhasil).toEqual([]);
    expect(h.saldoAwalAkun!.gagal[0].pesan).toBe(PESAN_SALDO_AWAL_AKUN_TANPA_CUTOFF);
    expect(await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM saldo_awal_akun`)).toEqual({ n: 0 });
  });
});

describe('RC-S133.4.6 — SHU Basis Kas: beban non-kas di saldo awal', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await tambahKliring();
  });

  test('saldo awal Beban Penyusutan bawaan BELUM tunai; pengaturan pengguna tetap menang', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.bebanPenyusutan, tanggal: CUTOFF, saldo: 375_000, createdBy: USER_ID });
    await tambahSaldoAwalAkun({ accountId: ACC.bebanLain, tanggal: CUTOFF, saldo: 250_000, createdBy: USER_ID });
    let belum = await bacaBagianBelumTunaiSaldoAwal(testDb as never);
    expect(belum.get(ACC.bebanPenyusutan)).toBe(375_000);
    expect(belum.get(ACC.bebanLain)).toBeUndefined(); // beban biasa tetap dianggap tunai
    await aturBagianTunaiSaldoAwal({ accountId: ACC.bebanPenyusutan, bagianTunai: 375_000, actingUserId: USER_ID });
    belum = await bacaBagianBelumTunaiSaldoAwal(testDb as never);
    expect(belum.get(ACC.bebanPenyusutan)).toBeUndefined();
  });
});
