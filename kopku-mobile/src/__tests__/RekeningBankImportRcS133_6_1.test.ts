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

import { buatFixtureHistoris, ACC, USER_ID, BANK_ID, saldoGl } from './historicalFixture';
import {
  normalkanNomorRekening,
  parseBerkasDataAwal,
  parseSheetBerjangka,
  parseSheetPinjaman,
  parseSheetSimpanan,
  pilihRekeningBankImport,
  type RekeningBankAktif,
} from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import { periksaSebelumImport } from '@/import/PanduanImportData';
import { SHEET_TEMPLATE, SHEET_TEMPLATE_TRANSAKSI_BARU } from '@/import/TemplateDataAwal';
import { createJournal } from '@/accounting/AccountingEngine';

/**
 * RC-S133.6.1 — KOLOM OPSIONAL "Rekening Bank" PADA IMPOR.
 *
 * Keputusan pengguna setelah audit manual-vs-impor (RC-S133.6): baris
 * Sumber Dana BANK ditolak bila koperasi punya lebih dari satu rekening
 * bank aktif karena berkas tidak menyebut rekeningnya. Template kini punya
 * kolom opsional "Rekening Bank" (nomor rekening). Aturan (satu fungsi,
 * dipakai pratinjau DAN eksekutor):
 *   - kosong + tepat 1 rekening aktif  -> rekening itu (perilaku RC-S133.6)
 *   - kosong + 0 / >1 rekening aktif   -> galat, minta kolom diisi
 *   - diisi -> harus cocok dengan nomor rekening aktif
 * Juga temuan (d): pratinjau dulu menyatakan "siap diimpor" padahal baris
 * BANK pasti ditolak — kini BLOKIR di pratinjau.
 */

const now = () => new Date().toISOString();
const DUA_BANK: RekeningBankAktif[] = [
  { id: 'bank-1', namaBank: 'Bank BRI', nomorRekening: '123456' },
  { id: 'bank-2', namaBank: 'Bank Mandiri', nomorRekening: '0098765' },
];

const HDR_S = ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana', 'Rekening Bank'];
const HDR_P = ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Rekening Bank'];

describe('RC-S133.6.1 — parser kolom Rekening Bank', () => {
  test('nomor dibaca apa adanya; spasi/titik/tanda hubung dibuang; sel kosong tidak menambah field', () => {
    const s = parseSheetSimpanan([
      HDR_S,
      ['K1', '2026-02-01', 100_000, 0, 0, 'BANK', '0123-456 789'],
      ['K1', '2026-02-02', 0, 50_000, 0, 'BANK', 98765],
      ['K1', '2026-02-03', 0, 50_000, 0, 'BANK', null],
      ['K1', '2026-02-04', 0, 50_000, 0, 'KAS', ''],
    ]);
    expect(s.galat).toEqual([]);
    expect(s.baris.map((b) => b.rekeningBank)).toEqual(['0123456789', '98765', undefined, undefined]);
    expect('rekeningBank' in s.baris[2]).toBe(false);
    expect(normalkanNomorRekening(' 1.370-012 ')).toBe('1370012');
  });

  test('isian bukan nomor, atau diisi pada Sumber Dana KAS/kosong → galat baris (tidak ditebak sebagai BANK)', () => {
    const s = parseSheetSimpanan([
      HDR_S,
      ['K1', '2026-02-01', 100_000, 0, 0, 'BANK', 'BRI Cabang'],
      ['K1', '2026-02-02', 0, 50_000, 0, 'KAS', '123456'],
      ['K1', '2026-02-03', 0, 50_000, 0, null, '123456'],
    ]);
    expect(s.baris).toEqual([]);
    expect(s.galat.map((g) => [g.baris, g.pesan])).toEqual([
      [2, expect.stringMatching(/Rekening Bank "BRI Cabang" tidak sah/)],
      [3, expect.stringMatching(/hanya diisi bila Sumber Dana = BANK/)],
      [4, expect.stringMatching(/hanya diisi bila Sumber Dana = BANK/)],
    ]);
  });

  test('kolom juga dibaca di sheet Pinjaman dan Simpanan Berjangka', () => {
    const p = parseSheetPinjaman([HDR_P, ['K1', '2026-03-01', 1_200_000, 12, 'BULAN', 'FLAT', 1, 'BANK', '0098765']]);
    expect(p.galat).toEqual([]);
    expect(p.baris[0].rekeningBank).toBe('0098765');
    const b = parseSheetBerjangka([
      ['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan', 'Bunga Persen Per Tahun', 'Sumber Dana', 'Rekening Bank'],
      ['K1', '2026-03-01', 5_000_000, 12, 6, 'BANK', '123456'],
    ]);
    expect(b.galat).toEqual([]);
    expect(b.baris[0].rekeningBank).toBe('123456');
  });

  test('berkas lama TANPA kolom Rekening Bank terbaca sama seperti sebelumnya', () => {
    const s = parseSheetSimpanan([HDR_S.slice(0, 6), ['K1', '2026-02-01', 100_000, 0, 0, 'BANK']]);
    expect(s.galat).toEqual([]);
    expect(s.baris[0]).toEqual({ baris: 2, kode: 'K1', tanggal: '2026-02-01', pokok: 100_000, wajib: 0, sukarela: 0, sumberDana: 'BANK' });
  });
});

describe('RC-S133.6.1 — pilihRekeningBankImport', () => {
  test('kosong: tepat satu rekening → dipakai; dua → galat (pesan lama "tepat satu rekening bank aktif" dipertahankan)', () => {
    expect(pilihRekeningBankImport(undefined, DUA_BANK.slice(0, 1))).toEqual({ id: 'bank-1' });
    const g = pilihRekeningBankImport(undefined, DUA_BANK);
    expect('galat' in g && g.galat).toMatch(/tepat satu rekening bank aktif, tetapi ada 2/);
    expect('galat' in g && g.galat).toMatch(/Isi kolom Rekening Bank/);
  });
  test('tanpa rekening aktif → galat "belum ada rekening bank aktif"', () => {
    const g = pilihRekeningBankImport('123456', []);
    expect('galat' in g && g.galat).toMatch(/belum ada rekening bank aktif/);
  });
  test('diisi: cocok persis; nol di depan yang hilang (sel angka Excel) tetap cocok bila unik; tidak terdaftar → galat', () => {
    expect(pilihRekeningBankImport('123456', DUA_BANK)).toEqual({ id: 'bank-1' });
    expect(pilihRekeningBankImport('0098765', DUA_BANK)).toEqual({ id: 'bank-2' });
    expect(pilihRekeningBankImport('98765', DUA_BANK)).toEqual({ id: 'bank-2' });
    const g = pilihRekeningBankImport('999', DUA_BANK);
    expect('galat' in g && g.galat).toMatch(/Rekening Bank "999" tidak ada di daftar rekening bank aktif/);
  });
  test('nomor yang sama pada dua rekening → galat (tidak memilih salah satu)', () => {
    const g = pilihRekeningBankImport('123456', [...DUA_BANK, { id: 'bank-3', namaBank: 'BRI Lain', nomorRekening: '123-456' }]);
    expect('galat' in g && g.galat).toMatch(/lebih dari satu rekening aktif/);
  });
});

describe('RC-S133.6.1 — eksekusi impor dengan dua rekening bank', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES ('acc-bank-2','1-1101','Bank Mandiri','ASET','DEBIT',1,0,?,?)`,
      now(), now()
    );
    await testDb.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at) VALUES ('bank-2','Bank Mandiri','0098765','Koperasi Uji','acc-bank-2',0,1,?)`,
      now()
    );
    // Isi rekening kedua supaya pencairan dari rekening itu likuid.
    await createJournal(testDb as never, {
      tanggal: '2026-01-15', sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'Isi rekening Mandiri', createdBy: USER_ID,
      lines: [{ accountId: 'acc-bank-2', debit: 5_000_000, kredit: 0 }, { accountId: ACC.kas, debit: 0, kredit: 5_000_000 }],
    });
  });
  const opsi = () => ({ createdBy: USER_ID, dbRiwayat: testDb as never });
  const berkas = (rekS: unknown, rekP: unknown) =>
    parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Budi', '2026-01-01']],
      SIMPANAN: [HDR_S, ['K1', '2026-02-01', 100_000, 50_000, 25_000, 'BANK', rekS]],
      PINJAMAN: [HDR_P, ['K1', '2026-03-01', 1_200_000, 12, 'BULAN', 'FLAT', 1, 'BANK', rekP]],
    });

  test('baris berisi Rekening Bank berhasil dan memakai rekening yang disebut (bukan rekening pertama)', async () => {
    const b1 = await saldoGl(testDb, ACC.bank);
    const b2 = await saldoGl(testDb, 'acc-bank-2');
    const h = await jalankanImportDataAwal(berkas('123456', 98765), opsi());
    expect(h.totalGagal).toBe(0);
    expect((await saldoGl(testDb, ACC.bank)) - b1).toBe(175_000);
    expect((await saldoGl(testDb, 'acc-bank-2')) - b2).toBe(-1_200_000);
    const trx = await testDb.getAllAsync<{ bank_account_id: string }>(`SELECT DISTINCT bank_account_id FROM simpanan_transaksi`);
    expect(trx.map((t) => t.bank_account_id)).toEqual([BANK_ID]);
  });

  test('Rekening Bank kosong atau tidak terdaftar → baris ditolak dengan pesan jelas; tidak ada pinjaman yang tertinggal', async () => {
    const h = await jalankanImportDataAwal(berkas(null, '777'), opsi());
    expect(h.perSheet.find((s) => s.jenis === 'SIMPANAN')).toMatchObject({ berhasil: 0, gagal: 1 });
    expect(h.perSheet.find((s) => s.jenis === 'PINJAMAN')).toMatchObject({ berhasil: 0, gagal: 1 });
    const pesan = h.gagal.map((g) => g.pesan).join(' | ');
    expect(pesan).toMatch(/tepat satu rekening bank aktif, tetapi ada 2/);
    expect(pesan).toMatch(/Rekening Bank "777" tidak ada/);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id WHERE a.nama_lengkap = 'Budi'`
    );
    expect(n?.n).toBe(0);
  });
});

describe('RC-S133.6.1 — pratinjau memblokir baris BANK yang pasti ditolak (temuan d)', () => {
  const r = (rek: unknown, tanggal = '2026-02-01') =>
    parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Budi', '2026-01-01']],
      SIMPANAN: [HDR_S, ['K1', tanggal, 100_000, 50_000, 0, 'BANK', rek]],
    });
  const blokir = (p: ReturnType<typeof periksaSebelumImport>) => p.filter((x) => x.kunci === 'rekening-bank');

  test('dua rekening + kolom kosong → BLOKIR menyebut sheet & baris', () => {
    const p = blokir(periksaSebelumImport(r(null), { sifat: 'TRANSAKSI_BARU', rekeningBank: DUA_BANK }));
    expect(p).toHaveLength(1);
    expect(p[0].tingkat).toBe('BLOKIR');
    expect(p[0].pesan).toMatch(/2\. Simpanan baris 2: .*tepat satu rekening bank aktif/);
  });
  test('nomor terdaftar → tidak diblokir; satu rekening + kosong → tidak diblokir', () => {
    expect(blokir(periksaSebelumImport(r('0098765'), { sifat: 'TRANSAKSI_BARU', rekeningBank: DUA_BANK }))).toEqual([]);
    expect(blokir(periksaSebelumImport(r(null), { sifat: 'TRANSAKSI_BARU', rekeningBank: DUA_BANK.slice(0, 1) }))).toEqual([]);
  });
  test('saldo lama sebelum cut-off tidak memakai rekening → tidak diperiksa; tanpa daftar rekening → pemeriksaan dilewati', () => {
    expect(blokir(periksaSebelumImport(r(null, '2025-12-31'), { sifat: 'SALDO_AWAL', cutOff: '2026-01-01', rekeningBank: DUA_BANK }))).toEqual([]);
    expect(blokir(periksaSebelumImport(r(null, '2026-01-05'), { sifat: 'SALDO_AWAL', cutOff: '2026-01-01', rekeningBank: DUA_BANK }))).toHaveLength(1);
    expect(blokir(periksaSebelumImport(r(null), { sifat: 'TRANSAKSI_BARU' }))).toEqual([]);
  });
});

describe('RC-S133.6.1 — template', () => {
  test('"Rekening Bank" tepat sesudah "Sumber Dana" di sheet Simpanan, Pinjaman, Berjangka (kedua template)', () => {
    for (const daftar of [SHEET_TEMPLATE, SHEET_TEMPLATE_TRANSAKSI_BARU]) {
      for (const jenis of ['SIMPANAN', 'PINJAMAN', 'BERJANGKA']) {
        const kolom = daftar.find((s) => s.jenis === jenis)!.kolom.map((k) => k.label);
        expect(kolom[kolom.indexOf('Sumber Dana') + 1]).toBe('Rekening Bank');
      }
    }
    const k = SHEET_TEMPLATE.find((s) => s.jenis === 'SIMPANAN')!.kolom.find((x) => x.label === 'Rekening Bank')!;
    expect(k.wajib).toBe(false);
    // Format sel TEKS ('@') diverifikasi pada template yang diunduh lewat UI (TemplateWorkbook memerlukan xlsx-js-style).
  });
});
