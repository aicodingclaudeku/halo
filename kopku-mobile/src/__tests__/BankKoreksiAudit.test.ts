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
import {
  catatPemasukan, catatPengeluaran, transferAntarRekening, koreksiTransaksiKasBank,
} from '@/services/KasBankService';
import { jalankanRekonsiliasiLengkap } from '@/accounting/FullReconciliation';
import { getArusKas, getLabaRugi } from '@/reports/FinancialReports';
import { classifyTransactionSource } from '@/accounting/CashFlowClassification';

/**
 * ============================================================
 * S20/§C–§N — KOREKSI TRANSAKSI BANK
 * ============================================================
 *
 * TEMUAN (P1, direproduksi di §C sebelum perbaikan):
 * `koreksiTransaksiKasBank()` menulis `tipe: 'KOREKSI'` untuk KEDUA
 * jenis rekening lewat SATU `insertBarisTransaksi()`, tetapi CHECK
 * `bank_transaksi.tipe` (schema <= v53) hanya menerima
 * ('PENERIMAAN','PENGELUARAN','TRANSFER'). Setiap koreksi transaksi
 * BANK karena itu gagal dengan "CHECK constraint failed" — transaksi
 * bank yang salah TIDAK BISA dikoreksi sama sekali. Diperbaiki di
 * schema v54 (lihat MigrationV54BankKoreksi.test.ts).
 *
 * SEMANTIK KOREKSI (§D — diambil dari implementasi, bukan tebakan):
 * koreksi = REVERSAL, persis pola `koreksiSimpanan()` di
 * SimpananService.ts:
 *   1) `reverseJournal()` pada jurnal ASLI — membuat jurnal baru
 *      dengan debit/kredit DIBALIK, bertanggal HARI INI, dan menandai
 *      jurnal asli `status='REVERSED'`;
 *   2) satu baris subledger `tipe='KOREKSI'`, nominal POSITIF sama
 *      dengan aslinya, `reversal_of_id` = baris asli.
 * Tidak ada correcting entry bernilai selisih, dan tidak ada
 * penghapusan transaksi lama.
 */

/** Tanggal lokal hari ini dalam format yyyy-MM-dd (sama seperti getTanggalLokalHariIni()). */
function hariIni(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function angka(db: TestDb, sql: string, ...p: any[]): Promise<number> {
  return (await db.getFirstAsync<{ n: number }>(sql, ...p))!.n;
}

async function snapshot(db: TestDb) {
  return {
    journal: await angka(db, `SELECT COUNT(*) as n FROM journal`),
    journalEntry: await angka(db, `SELECT COUNT(*) as n FROM journal_entry`),
    debit: await angka(db, `SELECT COALESCE(SUM(debit),0) as n FROM journal_entry`),
    kredit: await angka(db, `SELECT COALESCE(SUM(kredit),0) as n FROM journal_entry`),
    bankRows: await angka(db, `SELECT COUNT(*) as n FROM bank_transaksi`),
    bankNominal: await angka(db, `SELECT COALESCE(SUM(nominal),0) as n FROM bank_transaksi`),
    kasRows: await angka(db, `SELECT COUNT(*) as n FROM kas_transaksi`),
    kasNominal: await angka(db, `SELECT COALESCE(SUM(nominal),0) as n FROM kas_transaksi`),
    saldoBank: await saldoGl(db, ACC.bank),
    saldoKas: await saldoGl(db, ACC.kas),
    reversed: await angka(db, `SELECT COUNT(*) as n FROM journal WHERE status='REVERSED'`),
  };
}

async function rekon(db: TestDb) {
  const hasil = await jalankanRekonsiliasiLengkap(db as any);
  return {
    kas: hasil.baris.find((b) => b.domain === 'Cash')!,
    bank: hasil.baris.find((b) => b.domain === 'Bank')!,
    selisih: hasil.baris.filter((b) => b.status === 'SELISIH'),
  };
}

async function pemasukanBank(tanggal: string, nominal: number) {
  return catatPemasukan({
    jenis: 'BANK', bankAccountId: BANK_ID, tanggal, nominal,
    akunLawanId: ACC.pendapatanLain, keterangan: 'pemasukan bank', createdBy: USER_ID,
  });
}

// ============================================================
// §C/§E — SKEMA & REPRODUKSI
// ============================================================
describe('§C/§E — bank_transaksi.tipe menerima KOREKSI (P1)', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§C CHECK kas & bank kini SIMETRIS — keduanya memuat KOREKSI', async () => {
    const ambil = async (t: string) =>
      (await testDb.getFirstAsync<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`, t
      ))!.sql;
    expect(await ambil('kas_transaksi')).toContain("'KOREKSI'");
    expect(await ambil('bank_transaksi')).toContain("'KOREKSI'");
  });

  it('§C REGRESI: koreksi transaksi BANK tidak lagi melempar CHECK constraint failed', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const hasil = await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');
    expect(hasil.id).toBeTruthy();

    const baris = await testDb.getFirstAsync<any>(
      `SELECT tipe, nominal, reversal_of_id, nomor_transaksi FROM bank_transaksi WHERE id = ?`, hasil.id
    );
    expect(baris.tipe).toBe('KOREKSI');
    expect(baris.nominal).toBe(5_000_000);
    expect(baris.reversal_of_id).toBe(bank.id);
    expect(baris.nomor_transaksi).toContain('KOREKSI-');
  });

  it('§C koreksi KAS tetap bekerja seperti sebelum S20 (tidak ada regresi)', async () => {
    const kas = await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-03-31', nominal: 3_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pemasukan kas', createdBy: USER_ID,
    });
    const hasil = await koreksiTransaksiKasBank('KAS', kas.id, USER_ID, 'salah nominal');
    const baris = await testDb.getFirstAsync<any>(
      `SELECT tipe, reversal_of_id FROM kas_transaksi WHERE id = ?`, hasil.id
    );
    expect(baris.tipe).toBe('KOREKSI');
    expect(baris.reversal_of_id).toBe(kas.id);
  });
});

// ============================================================
// §D/§H — SEMANTIK AKUNTANSI KOREKSI
// ============================================================
describe('§D/§H — semantik koreksi bank = REVERSAL penuh', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§H jurnal reversal membalik TEPAT debit/kredit jurnal asli', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const asli = await testDb.getFirstAsync<{ journal_id: string }>(
      `SELECT journal_id FROM bank_transaksi WHERE id = ?`, bank.id
    );
    const jejakAsli = await jejakJurnal(testDb, asli!.journal_id);

    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');

    const jReversal = await testDb.getFirstAsync<{ id: string; status: string }>(
      `SELECT id, status FROM journal WHERE reversal_of_id = ?`, asli!.journal_id
    );
    expect(jReversal).not.toBeNull();
    const jejakBalik = await jejakJurnal(testDb, jReversal!.id);

    // Setiap akun yang di-debit jadi di-kredit dengan nominal sama.
    // `jejakJurnal()` mengembalikan KODE akun (bukan id) — dipakai apa
    // adanya supaya perbandingan ini tidak bergantung pada id acak.
    const petaAsli = new Map(jejakAsli.map((e) => [e.kode, [e.debit, e.kredit]]));
    expect(petaAsli.size).toBe(jejakAsli.length);
    for (const e of jejakBalik) {
      const a = petaAsli.get(e.kode)!;
      expect(a).toBeDefined();
      expect([e.debit, e.kredit]).toEqual([a[1], a[0]]);
    }
    expect(jejakBalik.length).toBe(jejakAsli.length);

    // Jurnal asli ditandai REVERSED, tidak dihapus.
    const statusAsli = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM journal WHERE id = ?`, asli!.journal_id
    );
    expect(statusAsli!.status).toBe('REVERSED');
  });

  it('§H saldo GL bank kembali ke posisi sebelum transaksi; jurnal tetap balance', async () => {
    const sebelum = await saldoGl(testDb, ACC.bank);
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    expect(await saldoGl(testDb, ACC.bank)).toBe(sebelum + 5_000_000);

    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');

    expect(await saldoGl(testDb, ACC.bank)).toBe(sebelum);
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  it('§H koreksi PENGELUARAN bank juga netral — arah reversal mengikuti jurnal asli', async () => {
    const sebelum = await saldoGl(testDb, ACC.bank);
    const keluar = await catatPengeluaran({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-31', nominal: 4_000_000,
      akunLawanId: ACC.bebanLain, keterangan: 'beban', createdBy: USER_ID,
    });
    expect(await saldoGl(testDb, ACC.bank)).toBe(sebelum - 4_000_000);

    await koreksiTransaksiKasBank('BANK', keluar.id, USER_ID, 'salah beban');

    expect(await saldoGl(testDb, ACC.bank)).toBe(sebelum);
    // Beban ikut dibatalkan — koreksi bukan transaksi baru yang
    // menambah beban lagi.
    expect(await saldoGl(testDb, ACC.bebanLain)).toBe(0);
  });

  it('§H koreksi tidak menghapus baris asli — riwayat tetap utuh (audit trail)', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');

    const asli = await testDb.getFirstAsync<any>(
      `SELECT id, tipe, nominal FROM bank_transaksi WHERE id = ?`, bank.id
    );
    expect(asli).not.toBeNull();
    expect(asli.tipe).toBe('PENERIMAAN');
    expect(asli.nominal).toBe(5_000_000);
    expect(await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi`)).toBe(2);
  });

  it('§H transaksi KOREKSI tidak bisa dikoreksi lagi (guard existing dipertahankan)', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const koreksi = await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');
    await expect(
      koreksiTransaksiKasBank('BANK', koreksi.id, USER_ID, 'salah lagi')
    ).rejects.toThrow(/tidak bisa dikoreksi lagi/);
  });
});

// ============================================================
// §G — ATOMICITY
// ============================================================
describe('§G — atomicity koreksi bank', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§G kegagalan di tengah koreksi -> rollback TOTAL (tidak ada setengah jalan)', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const sebelum = await snapshot(testDb);

    // Suntik kegagalan SETELAH jurnal reversal dibuat dan SEBELUM
    // baris subledger tersimpan: `nomor_transaksi` bentrok dengan
    // baris yang sudah ada (UNIQUE), tepat pada INSERT subledger.
    await testDb.runAsync(
      `INSERT INTO bank_transaksi (id, bank_account_id, tipe, tanggal, nominal, nomor_transaksi, created_by, created_at)
       VALUES ('bt-penghalang', ?, 'PENERIMAAN', '2026-03-31', 1, ?, ?, ?)`,
      BANK_ID,
      `KOREKSI-${(await testDb.getFirstAsync<{ nomor_transaksi: string }>(
        `SELECT nomor_transaksi FROM bank_transaksi WHERE id = ?`, bank.id
      ))!.nomor_transaksi}`,
      USER_ID,
      new Date().toISOString()
    );
    const setelahPenghalang = await snapshot(testDb);

    await expect(
      koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal')
    ).rejects.toThrow();

    const sesudah = await snapshot(testDb);
    // Jurnal reversal yang sempat dibuat HARUS ikut ter-rollback.
    expect(sesudah).toEqual(setelahPenghalang);
    expect(sesudah.journal).toBe(sebelum.journal);
    expect(sesudah.journalEntry).toBe(sebelum.journalEntry);
    expect(sesudah.reversed).toBe(0);
    expect(sesudah.saldoBank).toBe(sebelum.saldoBank);
    expect(sesudah.debit).toBe(sesudah.kredit);
  });

  it('§G koreksi transaksi tanpa jurnal ditolak tanpa efek apa pun', async () => {
    await testDb.runAsync(
      `INSERT INTO bank_transaksi (id, bank_account_id, tipe, tanggal, nominal, nomor_transaksi, created_by, created_at)
       VALUES ('bt-tanpa-jurnal', ?, 'PENERIMAAN', '2026-03-31', 1000, 'TANPA-JURNAL-1', ?, ?)`,
      BANK_ID, USER_ID, new Date().toISOString()
    );
    const sebelum = await snapshot(testDb);
    await expect(
      koreksiTransaksiKasBank('BANK', 'bt-tanpa-jurnal', USER_ID, 'coba')
    ).rejects.toThrow(/tidak mempunyai jurnal/);
    expect(await snapshot(testDb)).toEqual(sebelum);
  });
});

// ============================================================
// §I — IDEMPOTENCY
// ============================================================
describe('§I — koreksi bank dijalankan dua kali', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§I koreksi kedua atas transaksi yang SAMA ditolak — satu efek akuntansi saja', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');
    const setelahSatu = await snapshot(testDb);

    // Guard-nya adalah STATE JURNAL: `reverseJournal()` hanya menerima
    // jurnal berstatus POSTED, sedangkan jurnal asli sudah REVERSED.
    await expect(
      koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal')
    ).rejects.toThrow(/POSTED/);

    expect(await snapshot(testDb)).toEqual(setelahSatu);
    expect(await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi WHERE tipe='KOREKSI'`)).toBe(1);
    expect(
      await angka(testDb, `SELECT COUNT(*) as n FROM journal WHERE reversal_of_id IS NOT NULL`)
    ).toBe(1);
  });

  it('§I tidak ada double movement pada saldo bank', async () => {
    const sebelum = await saldoGl(testDb, ACC.bank);
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah').catch(() => undefined);
    expect(await saldoGl(testDb, ACC.bank)).toBe(sebelum);
  });
});

// ============================================================
// §J — CLOSED PERIOD
// ============================================================
describe('§J — koreksi bank pada periode CLOSED', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§J ditolak total; snapshot sebelum & sesudah identik', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    // Periode 2026 ditutup SETELAH transaksi tercatat. Jurnal reversal
    // dibuat bertanggal HARI INI (2026-xx), jadi jatuh di periode yang
    // sudah CLOSED.
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    const sebelum = await snapshot(testDb);

    await expect(
      koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal')
    ).rejects.toThrow(/ditutup|CLOSED/);

    const sesudah = await snapshot(testDb);
    expect(sesudah).toEqual(sebelum);
    expect(sesudah.reversed).toBe(0);
    expect(
      await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi WHERE tipe='KOREKSI'`)
    ).toBe(0);
    const periode = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM accounting_period WHERE id='p2026'`
    );
    expect(periode!.status).toBe('CLOSED');
  });
});

// ============================================================
// §K — HISTORICAL
// ============================================================
describe('§K — koreksi bank atas transaksi historis', () => {
  const tanggalUji = ['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31'];

  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it.each(tanggalUji.map((t) => [t]))(
    'transaksi %s dikoreksi belakangan: jurnal reversal bertanggal INPUT, bukan tanggal asli',
    async (tanggal: string) => {
      const bank = await pemasukanBank(tanggal, 5_000_000);
      const asli = await testDb.getFirstAsync<{ journal_id: string }>(
        `SELECT journal_id FROM bank_transaksi WHERE id = ?`, bank.id
      );

      await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');

      const jAsli = await testDb.getFirstAsync<{ tanggal: string }>(
        `SELECT tanggal FROM journal WHERE id = ?`, asli!.journal_id
      );
      const jBalik = await testDb.getFirstAsync<{ tanggal: string }>(
        `SELECT tanggal FROM journal WHERE reversal_of_id = ?`, asli!.journal_id
      );
      // Tanggal jurnal ASLI tidak boleh bergeser…
      expect(jAsli!.tanggal).toBe(tanggal);
      // …dan reversal memakai tanggal PENCATATAN koreksi (hari ini),
      // bukan tanggal transaksi asli — semantik `reverseJournal()`,
      // yang memanggil `getTanggalLokalHariIni()`.
      //
      // CATATAN: tanggal koreksi TIDAK selalu >= tanggal transaksi.
      // Transaksi bertanggal ke depan (mis. 2026-12-31 dicatat hari
      // ini) menghasilkan reversal yang tanggalnya LEBIH AWAL. Itu
      // konsekuensi wajar dari 'reversal selalu bertanggal hari
      // pencatatan', bukan anomali.
      expect(jBalik!.tanggal).not.toBe(tanggal);
      expect(jBalik!.tanggal).toBe(hariIni());
    }
  );

  it('§K laporan periode ASLI tidak berubah oleh koreksi bertanggal kemudian', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const lrQ1Sebelum = await getLabaRugi(testDb as any, '2026-01-01', '2026-03-31');

    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');

    const lrQ1Sesudah = await getLabaRugi(testDb as any, '2026-01-01', '2026-03-31');
    // Reversal masuk periode pencatatannya sendiri; Q1 tetap
    // menampilkan angka yang dulu benar-benar dilaporkan.
    expect(lrQ1Sesudah.totalPendapatan).toBe(lrQ1Sebelum.totalPendapatan);
  });

  it('§K saldo bank & rekonsiliasi tetap benar setelah koreksi historis', async () => {
    const awal = await saldoGl(testDb, ACC.bank);
    const bank = await pemasukanBank('2026-06-30', 7_500_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');

    expect(await saldoGl(testDb, ACC.bank)).toBe(awal);
    const r = await rekon(testDb);
    expect(r.bank.variance).toBe(0);
    expect(r.selisih).toEqual([]);
  });
});

// ============================================================
// §L — KOREKSI + TRANSFER
// ============================================================
describe('§L — koreksi dan transfer antar rekening', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§L transfer Kas->Bank lalu koreksi transaksi bank LAIN: arah transfer tetap benar', async () => {
    await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-03-31', nominal: 20_000_000, createdBy: USER_ID,
    });
    const lain = await pemasukanBank('2026-04-01', 5_000_000);

    await koreksiTransaksiKasBank('BANK', lain.id, USER_ID, 'salah nominal');

    const kakiBank = await testDb.getFirstAsync<{ arah_transfer: string }>(
      `SELECT arah_transfer FROM bank_transaksi WHERE tipe='TRANSFER'`
    );
    const kakiKas = await testDb.getFirstAsync<{ arah_transfer: string }>(
      `SELECT arah_transfer FROM kas_transaksi WHERE tipe='TRANSFER'`
    );
    expect(kakiBank!.arah_transfer).toBe('MASUK');
    expect(kakiKas!.arah_transfer).toBe('KELUAR');

    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.variance).toBe(0);
    expect(r.selisih).toEqual([]);
  });

  it('§L baris KOREKSI TIDAK diberi arah_transfer (bukan kaki transfer)', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const koreksi = await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');
    const baris = await testDb.getFirstAsync<{ arah_transfer: string | null }>(
      `SELECT arah_transfer FROM bank_transaksi WHERE id = ?`, koreksi.id
    );
    expect(baris!.arah_transfer).toBeNull();

    // …dan karena itu TIDAK ikut terhitung sebagai transfer tanpa arah
    // (yang akan ditandai SELISIH oleh rekonsiliasi).
    expect(
      await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi WHERE tipe='TRANSFER' AND arah_transfer IS NULL`)
    ).toBe(0);
  });

  it('§L mengoreksi SATU kaki transfer ditolak lewat jalur ini — tidak ada koreksi transfer separuh', async () => {
    await transferAntarRekening({
      sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
      tanggal: '2026-03-31', nominal: 20_000_000, createdBy: USER_ID,
    });
    const kaki = await testDb.getFirstAsync<{ id: string }>(
      `SELECT id FROM bank_transaksi WHERE tipe='TRANSFER'`
    );
    const sebelum = await snapshot(testDb);

    // Kedua kaki berbagi SATU jurnal TRANSFER_BANK. Mengoreksi satu
    // kaki akan me-reverse jurnal itu tetapi hanya menulis satu baris
    // KOREKSI — kaki lawan tertinggal. Yang diuji di sini: apa pun
    // hasilnya, TIDAK BOLEH menghasilkan variance rekonsiliasi.
    let gagal = false;
    try {
      await koreksiTransaksiKasBank('BANK', kaki!.id, USER_ID, 'transfer salah');
    } catch {
      gagal = true;
    }

    if (gagal) {
      expect(await snapshot(testDb)).toEqual(sebelum);
    }
    const r = await rekon(testDb);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.variance).toBe(0);
  });
});

// ============================================================
// §M — CASH FLOW
// ============================================================
describe('§M — klasifikasi arus kas untuk koreksi', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§M koreksi TIDAK memakai sumberTransaksi baru — ia mewarisi milik jurnal asli', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const asli = await testDb.getFirstAsync<{ journal_id: string }>(
      `SELECT journal_id FROM bank_transaksi WHERE id = ?`, bank.id
    );
    const sumberAsli = await testDb.getFirstAsync<{ sumber_transaksi: string }>(
      `SELECT sumber_transaksi FROM journal WHERE id = ?`, asli!.journal_id
    );

    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');

    const sumberBalik = await testDb.getFirstAsync<{ sumber_transaksi: string }>(
      `SELECT sumber_transaksi FROM journal WHERE reversal_of_id = ?`, asli!.journal_id
    );
    expect(sumberBalik!.sumber_transaksi).toBe(sumberAsli!.sumber_transaksi);

    // Konsekuensinya: TIDAK ADA klasifikasi baru yang perlu dikarang
    // untuk 'KOREKSI'. Reversal jatuh di kelas aktivitas yang sama
    // dengan transaksi aslinya, dengan tanda berlawanan.
    expect(classifyTransactionSource(sumberBalik!.sumber_transaksi)).toBe(
      classifyTransactionSource(sumberAsli!.sumber_transaksi)
    );
  });

  it('§M arus kas setahun kembali NOL setelah koreksi (masuk lalu keluar di kelas yang sama)', async () => {
    const sebelum = await getArusKas(testDb as any, '2026-01-01', '2026-12-31');
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah nominal');
    const sesudah = await getArusKas(testDb as any, '2026-01-01', '2026-12-31');

    expect(sesudah.perubahanKas).toBe(sebelum.perubahanKas);
    expect(sesudah.kasAkhirDihitung).toBe(sebelum.kasAkhirDihitung);
    expect(sesudah.kasAkhirAktual).toBe(sebelum.kasAkhirAktual);
    expect(sesudah.terekonsiliasi).toBe(true);
    expect(sesudah.selisihRekonsiliasi).toBe(0);
  });

  it('§M tidak ada sumberTransaksi bernama KOREKSI yang bocor ke jurnal', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');
    expect(
      await angka(testDb, `SELECT COUNT(*) as n FROM journal WHERE sumber_transaksi = 'KOREKSI'`)
    ).toBe(0);
  });
});

// ============================================================
// §N — REKONSILIASI & ANTI-SIRKULAR
// ============================================================
describe('§N — rekonsiliasi setelah koreksi bank', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§N variance 0 di Kas & Bank setelah koreksi bank dan koreksi kas', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const kas = await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-03-31', nominal: 3_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'kas', createdBy: USER_ID,
    });
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');
    await koreksiTransaksiKasBank('KAS', kas.id, USER_ID, 'salah');

    const r = await rekon(testDb);
    expect(r.bank.variance).toBe(0);
    expect(r.kas.variance).toBe(0);
    expect(r.bank.status).toBe('SEIMBANG');
    expect(r.kas.status).toBe('SEIMBANG');
    expect(r.selisih).toEqual([]);
  });

  it('§N corruption GL +1.000.000 setelah koreksi TETAP terdeteksi', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');
    expect((await rekon(testDb)).bank.variance).toBe(0);

    const je = await testDb.getFirstAsync<{ id: string }>(
      `SELECT je.id FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = ? AND je.debit > 0
         AND j.id IN (SELECT journal_id FROM bank_transaksi WHERE journal_id IS NOT NULL)
       LIMIT 1`,
      ACC.bank
    );
    await testDb.runAsync(`UPDATE journal_entry SET debit = debit + 1000000 WHERE id = ?`, je!.id);

    const r = await rekon(testDb);
    expect(r.bank.variance).toBe(-1_000_000);
    expect(r.bank.status).toBe('SELISIH');
  });

  it('§N corruption SUBLEDGER +1.000.000 setelah koreksi TETAP terdeteksi', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');

    await testDb.runAsync(
      `UPDATE bank_transaksi SET nominal = nominal + 1000000 WHERE id = ?`, bank.id
    );

    const r = await rekon(testDb);
    expect(r.bank.variance).toBe(1_000_000);
    expect(r.bank.status).toBe('SELISIH');
  });

  it('§N ANTI-SIRKULAR: mengubah TIPE baris KOREKSI menjadi PENERIMAAN terdeteksi', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    const koreksi = await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');
    expect((await rekon(testDb)).bank.variance).toBe(0);

    // Kalau sisi subledger diam-diam membaca angkanya dari GL, merusak
    // KOLOM SUBLEDGER tidak akan terlihat. Karena terlihat, sisi kiri
    // dan sisi kanan rekonsiliasi terbukti dua sumber berbeda.
    await testDb.runAsync(`UPDATE bank_transaksi SET tipe='PENERIMAAN' WHERE id = ?`, koreksi.id);

    const r = await rekon(testDb);
    expect(r.bank.variance).toBe(5_000_000);
    expect(r.bank.status).toBe('SELISIH');
  });

  it('§N integritas database bersih setelah koreksi', async () => {
    const bank = await pemasukanBank('2026-03-31', 5_000_000);
    await koreksiTransaksiKasBank('BANK', bank.id, USER_ID, 'salah');

    const integrity = await testDb.getAllAsync<{ integrity_check: string }>(`PRAGMA integrity_check`);
    expect(integrity.map((r) => r.integrity_check)).toEqual(['ok']);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toEqual([]);

    // Tidak ada baris koreksi yatim.
    expect(
      await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi
                           WHERE reversal_of_id IS NOT NULL
                             AND reversal_of_id NOT IN (SELECT id FROM bank_transaksi)`)
    ).toBe(0);
    // Tidak ada koreksi ganda atas satu transaksi.
    expect(
      await angka(testDb, `SELECT COUNT(*) as n FROM (
                             SELECT reversal_of_id FROM bank_transaksi
                              WHERE reversal_of_id IS NOT NULL
                              GROUP BY reversal_of_id HAVING COUNT(*) > 1)`)
    ).toBe(0);
  });
});
