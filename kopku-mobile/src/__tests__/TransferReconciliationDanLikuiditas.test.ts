import * as fs from 'fs';
import * as path from 'path';
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

import {
  buatFixtureHistoris, ACC, USER_ID, BANK_ID, saldoGl, totalDebitKredit, jejakJurnal,
} from './historicalFixture';
import { catatPemasukan, catatPengeluaran, transferAntarRekening } from '@/services/KasBankService';
import { beliAset } from '@/services/AsetService';
import { jalankanRekonsiliasiLengkap } from '@/accounting/FullReconciliation';
import { getLabaRugi, getArusKas, getPosisiKeuangan } from '@/reports/FinancialReports';
import { getAccountBalance } from '@/accounting/AccountingEngine';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';

const BANK2_ID = 'bank-2';
const ACC_BANK2 = 'acc-bank2';

async function tambahBankKedua(db: TestDb) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    ACC_BANK2, '1-1101', 'Bank BNI', 'ASET', 'DEBIT', now, now
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at)
     VALUES (?,?,?,?,?,0,1,?)`,
    BANK2_ID, 'Bank BNI', '999', 'Koperasi Uji', ACC_BANK2, now
  );
}

async function rekon(db: TestDb) {
  const hasil = await jalankanRekonsiliasiLengkap(db as any);
  return {
    kas: hasil.baris.find((b) => b.domain === 'Cash')!,
    bank: hasil.baris.find((b) => b.domain === 'Bank')!,
    selisih: hasil.baris.filter((b) => b.status === 'SELISIH'),
  };
}

// ============================================================
// §F/§G — VARIAN TRANSFER
// ============================================================
describe('§F/§G — transfer antar rekening: seluruh varian direkonsiliasi bersih', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await tambahBankKedua(testDb);
  });

  it('§F skenario wajib: Kas->Bank 20.000.000 & Bank->Kas 8.000.000 (tanggal berbeda) -> variance 0', async () => {
    await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-03-31', nominal: 20_000_000, createdBy: USER_ID,
    });
    await transferAntarRekening({
      sumberJenis: 'BANK', sumberBankAccountId: BANK_ID, tujuanJenis: 'KAS',
      tanggal: '2026-09-30', nominal: 8_000_000, createdBy: USER_ID,
    });

    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.variance).toBe(0);
    expect(r.selisih).toEqual([]);
    expect(r.kas.status).toBe('SEIMBANG');
    expect(r.bank.status).toBe('SEIMBANG');
  });

  it('Bank->Bank (dua rekening berbeda) direkonsiliasi bersih', async () => {
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-02-01', nominal: 30_000_000,
      akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
    });
    await transferAntarRekening({
      sumberJenis: 'BANK', sumberBankAccountId: BANK_ID,
      tujuanJenis: 'BANK', tujuanBankAccountId: BANK2_ID,
      tanggal: '2026-05-15', nominal: 12_000_000, createdBy: USER_ID,
    });
    const r = await rekon(testDb);
    expect(r.bank.variance).toBe(0);
    expect(await saldoGl(testDb, ACC_BANK2, '2026-12-31')).toBe(12_000_000);
  });

  it('Kas->Kas ditolak: rekening sumber & tujuan tidak boleh sama', async () => {
    await expect(
      transferAntarRekening({
        sumberJenis: 'KAS', tujuanJenis: 'KAS',
        tanggal: '2026-05-15', nominal: 1_000_000, createdBy: USER_ID,
      })
    ).rejects.toThrow(/tidak boleh sama/);
  });

  it.each([
    ['nominal kecil', 1_000],
    ['nominal besar', 250_000_000],
  ])('%s tetap variance 0', async (_nama, nominal) => {
    await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-06-12', nominal, createdBy: USER_ID,
    });
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.variance).toBe(0);
  });

  it('nominal SAMA DENGAN saldo rekening sumber: diterima & variance 0', async () => {
    const saldoKas = await getAccountBalance(testDb as any, ACC.kas);
    await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-06-12', nominal: saldoKas, createdBy: USER_ID,
    });
    expect(await getAccountBalance(testDb as any, ACC.kas)).toBe(0);
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.variance).toBe(0);
  });

  it.each([
    ['backdated', '2026-06-12'],
    ['akhir bulan', '2026-08-31'],
    ['akhir tahun', '2026-12-31'],
  ])('transfer %s: bukan pendapatan, bukan beban, SHU tidak berubah', async (_nama, tanggal) => {
    const lrSebelum = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    const { journalId } = await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal, nominal: 5_000_000, createdBy: USER_ID,
    });
    const jejak = await jejakJurnal(testDb, journalId);
    expect(jejak.every((r) => r.kode.startsWith('1-'))).toBe(true);
    expect(jejak.every((r) => r.tanggal === tanggal)).toBe(true);

    const lrSesudah = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    expect(lrSesudah.hasilUsaha).toBe(lrSebelum.hasilUsaha);
    expect(lrSesudah.totalPendapatan).toBe(lrSebelum.totalPendapatan);
    expect(lrSesudah.totalBeban).toBe(lrSebelum.totalBeban);
  });

  it('dua transfer berlawanan pada HARI YANG SAMA saling meniadakan tanpa selisih', async () => {
    await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-06-12', nominal: 7_000_000, createdBy: USER_ID,
    });
    await transferAntarRekening({
      sumberJenis: 'BANK', sumberBankAccountId: BANK_ID, tujuanJenis: 'KAS',
      tanggal: '2026-06-12', nominal: 7_000_000, createdBy: USER_ID,
    });
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.variance).toBe(0);
    const arus = await getArusKas(testDb as any, '2026-06-01', '2026-06-30');
    expect(arus.perubahanKas).toBe(0); // perpindahan internal, bukan arus keluar/masuk
    expect(arus.terekonsiliasi).toBe(true);
  });

  it('§S duplicate/retry: dua transfer identik = DUA peristiwa, masing-masing satu jurnal', async () => {
    const a = await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-06-12', nominal: 3_000_000, createdBy: USER_ID,
    });
    const b = await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-06-12', nominal: 3_000_000, createdBy: USER_ID,
    });
    // Dua submit berbeda memang dua transaksi sah — yang dijaga adalah
    // SATU peristiwa tidak menghasilkan efek ganda, bukan menolak dua
    // transfer bernominal sama (lihat catatan idempotensi di
    // KasBankService: kunci berbasis submit, bukan isi form).
    expect(a.journalId).not.toBe(b.journalId);
    expect(await jejakJurnal(testDb, a.journalId)).toHaveLength(2);
    expect(await jejakJurnal(testDb, b.journalId)).toHaveLength(2);
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.variance).toBe(0);
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  it('arah transfer tersimpan di SUBLEDGER (bukan hanya di jurnal)', async () => {
    await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-06-12', nominal: 2_000_000, createdBy: USER_ID,
    });
    const kas = await testDb.getFirstAsync<{ arah_transfer: string }>(
      `SELECT arah_transfer FROM kas_transaksi WHERE tipe = 'TRANSFER'`
    );
    const bank = await testDb.getFirstAsync<{ arah_transfer: string }>(
      `SELECT arah_transfer FROM bank_transaksi WHERE tipe = 'TRANSFER'`
    );
    expect(kas!.arah_transfer).toBe('KELUAR');
    expect(bank!.arah_transfer).toBe('MASUK');
  });
});

// ============================================================
// §N — REKONSILIASI TIDAK BOLEH SIRKULAR
// ============================================================
describe('§N — rekonsiliasi harus MENDETEKSI kerusakan di kedua sisi', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-06-12', nominal: 5_000_000,
      akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
    });
    await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-06-20', nominal: 4_000_000, createdBy: USER_ID,
    });
  });

  it('titik awal bersih: variance 0', async () => {
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.variance).toBe(0);
  });

  it('GL dirusak, subledger benar -> rekonsiliasi GAGAL dengan variance nyata', async () => {
    // Nominal salah satu kaki jurnal kas digeser 1.000.000 — hanya GL
    // yang rusak; baris subledger tidak disentuh.
    await testDb.runAsync(
      `UPDATE journal_entry SET debit = debit + 1000000
        WHERE account_id = ? AND debit > 0
          AND journal_id IN (SELECT journal_id FROM kas_transaksi WHERE tipe = 'PENERIMAAN')`,
      ACC.kas
    );
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(-1_000_000);
    expect(r.kas.status).toBe('SELISIH');
  });

  it('subledger dirusak, GL benar -> rekonsiliasi GAGAL dengan variance nyata', async () => {
    await testDb.runAsync(
      `UPDATE kas_transaksi SET nominal = nominal + 2000000 WHERE tipe = 'PENERIMAAN'`
    );
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(2_000_000);
    expect(r.kas.status).toBe('SELISIH');
  });

  it('arah transfer dibalik di subledger -> terdeteksi (bukan diambil dari jurnal)', async () => {
    // Kalau sisi subledger diam-diam membaca arah dari jurnal, perusakan
    // ini TIDAK akan terlihat — dan itulah definisi rekonsiliasi
    // sirkular. Test ini yang mengunci bahwa arah benar-benar dibaca
    // dari kolom subledger.
    await testDb.runAsync(
      `UPDATE kas_transaksi SET arah_transfer = 'MASUK' WHERE tipe = 'TRANSFER'`
    );
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(2 * 4_000_000); // -4jt menjadi +4jt
    expect(r.kas.status).toBe('SELISIH');
  });

  it('arah transfer dikosongkan -> dilaporkan eksplisit, tidak dianggap seimbang', async () => {
    await testDb.runAsync(`UPDATE kas_transaksi SET arah_transfer = NULL WHERE tipe = 'TRANSFER'`);
    const r = await rekon(testDb);
    expect(r.kas.status).toBe('SELISIH');
    expect(r.kas.catatan).toMatch(/tidak punya arah/i);
  });
});

// ============================================================
// §I–§M — AUDIT KEBIJAKAN GUARD LIKUIDITAS (P3)
// ============================================================
describe('§I–§M — semantik guard likuiditas untuk transaksi backdated', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§I POLICY DISCOVERY: tidak ada kebijakan tertulis tentang saldo as-of vs saldo berjalan', () => {
    const aturan = fs.readFileSync(path.join(__dirname, '..', 'ATURAN_BISNIS.md'), 'utf8');
    const istilah = [
      /likuidit/i,
      /saldo\s+(pada|per)\s+tanggal\s+transaksi/i,
      /as-?of\s+date/i,
      /saldo\s+berjalan/i,
    ];
    // Tidak satu pun istilah kebijakan itu muncul di dokumen aturan
    // bisnis. Konsekuensinya: semantik guard likuiditas untuk transaksi
    // BACKDATED belum pernah diputuskan.
    expect(istilah.some((re) => re.test(aturan))).toBe(false);
  });

  it('§I SEMANTIK AKTUAL: guard memakai SALDO BERJALAN, bukan saldo per tanggal transaksi', async () => {
    const sumber = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'LiquidityService.ts'), 'utf8'
    );
    // `getAccountBalance(db, accountId)` dipanggil TANPA argumen tanggal.
    expect(sumber).toContain('const saldoTersedia = await getAccountBalance(db, params.accountId);');

    // Dibuktikan juga secara perilaku: dana yang baru masuk SETELAH
    // tanggal transaksi tetap dianggap tersedia.
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-09-01', nominal: 100_000_000,
      akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
    });
    const cek = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank BRI', nominalKeluar: 250_000_000,
    });
    // 200jt modal awal + 100jt penerimaan September = 300jt "berjalan",
    // walaupun pada 10 Agustus saldonya baru 200jt.
    expect(cek.valid).toBe(true);
  });

  it('§K POLICY GAP TERUKUR: pembelian 2026-08-10 didanai penerimaan 2026-09-01 DITERIMA', async () => {
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-09-01', nominal: 100_000_000,
      akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
    });
    // Kuras saldo bank awal supaya HANYA penerimaan September yang bisa
    // mendanai pembelian ini.
    await catatPengeluaran({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-01-05', nominal: 200_000_000,
      akunLawanId: ACC.bebanLain, createdBy: USER_ID,
    });

    const hasil = await beliAset({
      namaAset: 'Aset didanai belakangan', nilaiPerolehan: 80_000_000, masaManfaatBulan: 48,
      tanggal: '2026-08-10', tanggalPerolehan: '2026-08-10',
      metodePembayaran: 'TUNAI', sumberDana: 'BANK', bankAccountId: BANK_ID,
      createdBy: USER_ID,
    });
    expect(hasil.journalId).toBeTruthy();

    // FAKTA YANG DILAPORKAN, BUKAN DIPERBAIKI: pada 10 Agustus 2026
    // saldo bank sebenarnya NOL — dananya baru masuk 1 September.
    expect(await saldoGl(testDb, ACC.bank, '2026-08-10')).toBe(-80_000_000);
    // Saldo negatif per tanggal transaksi ini akan MUSTAHIL bila
    // kebijakan menetapkan penilaian as-of. Karena kebijakan itu BELUM
    // ADA, implementasi TIDAK diubah — statusnya POLICY GAP.
  });

  it('§K/§L pendanaan MENDAHULUI transaksi: diterima, dan hasilnya tidak bergantung urutan input', async () => {
    // Urutan input A: pendanaan dulu, lalu pembelian.
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-01', nominal: 100_000_000,
      akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
    });
    await beliAset({
      namaAset: 'Aset A', nilaiPerolehan: 80_000_000, masaManfaatBulan: 48,
      tanggal: '2026-08-10', tanggalPerolehan: '2026-08-10',
      metodePembayaran: 'TUNAI', sumberDana: 'BANK', bankAccountId: BANK_ID, createdBy: USER_ID,
    });
    const saldoA = await saldoGl(testDb, ACC.bank, '2026-12-31');

    // Urutan input B: pembelian dulu, lalu pendanaan (tanggal sama).
    testDb = await buatFixtureHistoris();
    await beliAset({
      namaAset: 'Aset B', nilaiPerolehan: 80_000_000, masaManfaatBulan: 48,
      tanggal: '2026-08-10', tanggalPerolehan: '2026-08-10',
      metodePembayaran: 'TUNAI', sumberDana: 'BANK', bankAccountId: BANK_ID, createdBy: USER_ID,
    });
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-01', nominal: 100_000_000,
      akunLawanId: ACC.pendapatanLain, createdBy: USER_ID,
    });
    const saldoB = await saldoGl(testDb, ACC.bank, '2026-12-31');

    expect(saldoB).toBe(saldoA); // hasil akuntansinya identik
  });

  it('§L batas: saldo kurang Rp1 ditolak, saldo pas diterima', async () => {
    const saldo = await getAccountBalance(testDb as any, ACC.kas);
    const kurang = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.kas, namaRekening: 'Kas', nominalKeluar: saldo + 1,
    });
    expect(kurang.valid).toBe(false);
    const pas = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.kas, namaRekening: 'Kas', nominalKeluar: saldo,
    });
    expect(pas.valid).toBe(true);
  });

  it('§M guard + transfer: dana yang sudah dipindahkan ke Kas ikut dihitung pada rekening tujuan', async () => {
    await transferAntarRekening({
      sumberJenis: 'BANK', sumberBankAccountId: BANK_ID, tujuanJenis: 'KAS',
      tanggal: '2026-05-01', nominal: 50_000_000, createdBy: USER_ID,
    });
    const saldoKasBerjalan = await getAccountBalance(testDb as any, ACC.kas);
    const saldoKasPerApril = await saldoGl(testDb, ACC.kas, '2026-04-30');
    // Perbedaan inilah yang menjadi inti POLICY GAP: guard memakai
    // angka pertama, bukan angka kedua.
    expect(saldoKasBerjalan).toBe(saldoKasPerApril + 50_000_000);
    const posisi = await getPosisiKeuangan(testDb as any, '2026-12-31');
    expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);
  });
});
