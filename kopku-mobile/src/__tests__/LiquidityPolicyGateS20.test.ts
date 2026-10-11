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

import { buatFixtureHistoris, ACC, USER_ID, BANK_ID, saldoGl } from './historicalFixture';
import { catatPemasukan, catatPengeluaran, koreksiTransaksiKasBank } from '@/services/KasBankService';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { getAccountBalance } from '@/accounting/AccountingEngine';

/**
 * ============================================================
 * S20/§V–§AA — GERBANG KEBIJAKAN LIKUIDITAS BACKDATED
 * ============================================================
 *
 * §V memerintahkan: cari kebijakan resmi lebih dulu; kalau TIDAK ada,
 * JANGAN memperbaiki `checkSaldoAkunCukup()` secara sepihak — tetap
 * POLICY GAP / BLOCKED / POLICY REQUIRED.
 *
 * Hasil pencarian ulang di S20 (lihat test §V di bawah, yang memindai
 * berkas ASLI, bukan mengandalkan ingatan): tidak ditemukan. Karena itu
 * implementasi TIDAK diubah, dan suite ini MENGUKUR perilaku aktual
 * (CURRENT BALANCE) alih-alih menetapkannya sebagai benar.
 *
 * §W (helper `getAccountBalanceAsOf`) SENGAJA TIDAK diimplementasikan:
 * §W berlaku hanya "JIKA POLICY = AS-OF TRANSACTION DATE", dan syarat
 * itu tidak terpenuhi.
 */

async function angka(db: TestDb, sql: string, ...p: any[]): Promise<number> {
  return (await db.getFirstAsync<{ n: number }>(sql, ...p))!.n;
}

// ============================================================
// §V — POLICY DISCOVERY (dijalankan ulang di S20)
// ============================================================
describe('§V — pencarian kebijakan likuiditas historis', () => {
  const akar = path.resolve(__dirname, '..');
  const berkas = [
    'ATURAN_BISNIS.md',
    'services/AccountingPolicyService.ts',
    'services/LiquidityService.ts',
    'config/defaultCOA.ts',
    'config/defaultPermissions.ts',
    'config/defaultAsetKlasifikasi.ts',
  ];

  // Istilah yang HARUS muncul kalau kebijakan seperti itu memang ada.
  const istilah = [
    'as-of', 'as of', 'asof',
    'saldo pada tanggal', 'saldo per tanggal', 'saldo saat transaksi',
    'saldo berjalan', 'historical balance', 'backdated liquidity',
  ];

  it('tidak ada satu pun istilah kebijakan likuiditas historis di sumber kebijakan', () => {
    const temuan: string[] = [];
    for (const rel of berkas) {
      const p = path.join(akar, rel);
      if (!fs.existsSync(p)) continue;
      const isi = fs.readFileSync(p, 'utf8').toLowerCase();
      for (const t of istilah) {
        if (isi.includes(t)) temuan.push(`${rel}: "${t}"`);
      }
    }
    // Kalau test ini SUATU SAAT gagal, artinya kebijakan sudah ditulis —
    // dan §W baru boleh dikerjakan. Kegagalannya adalah SINYAL, bukan
    // regresi.
    expect(temuan).toEqual([]);
  });

  it('POLICY_DEFAULTS tidak memuat kunci apa pun tentang tanggal/likuiditas historis', () => {
    const isi = fs.readFileSync(path.join(akar, 'services/AccountingPolicyService.ts'), 'utf8');
    const blok = /const POLICY_DEFAULTS[\s\S]*?\n\};/.exec(isi)![0];
    expect(blok).not.toMatch(/AS_OF|HISTORIS|HISTORICAL|TANGGAL|BACKDATED/i);
  });

  it('§AJ SEMANTIK AKTUAL: checkSaldoAkunCukup memakai saldo BERJALAN (tanpa argumen tanggal)', () => {
    const isi = fs.readFileSync(path.join(akar, 'services/LiquidityService.ts'), 'utf8');
    const fn = /export async function checkSaldoAkunCukup[\s\S]*?\n\}/.exec(isi)![0];
    // Fakta source: satu-satunya sumber saldo adalah getAccountBalance
    // dengan SATU argumen akun — tidak ada tanggal batas.
    expect(fn).toContain('getAccountBalance(db, params.accountId)');
    expect(fn).not.toMatch(/tanggal|asOf|as_of/i);
  });
});

// ============================================================
// §X/§Y — PERILAKU AKTUAL YANG DIUKUR (bukan yang ditetapkan)
// ============================================================
describe('§X/§Y — likuiditas: perilaku aktual di bawah semantik CURRENT BALANCE', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§X pendanaan MENDAHULUI transaksi (2026-03-01 -> 2026-08-10): DITERIMA', async () => {
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-01', nominal: 100_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pendanaan', createdBy: USER_ID,
    });
    const hasil = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: 80_000_000,
    });
    expect(hasil.valid).toBe(true);
  });

  it('§X pendanaan SESUDAH transaksi (2026-09-01 -> 2026-08-10): TETAP DITERIMA — POLICY GAP', async () => {
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-09-01', nominal: 100_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pendanaan', createdBy: USER_ID,
    });
    const hasil = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: 80_000_000,
    });
    // Di bawah semantik AS-OF hasilnya DITOLAK. Di bawah semantik
    // CURRENT (yang sekarang berlaku) DITERIMA. Angka ini DIUKUR, bukan
    // dinyatakan benar — keputusannya milik pengurus (§I S19, §V S20).
    expect(hasil.valid).toBe(true);
  });

  it('§X keputusan bisnis identik antara urutan kronologis dan acak', async () => {
    const jalankan = async (kronologis: boolean) => {
      testDb = await buatFixtureHistoris();
      const langkah = [
        () => catatPemasukan({
          jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-01', nominal: 100_000_000,
          akunLawanId: ACC.pendapatanLain, keterangan: 'pendanaan', createdBy: USER_ID,
        }),
        () => catatPemasukan({
          jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-01-15', nominal: 5_000_000,
          akunLawanId: ACC.pendapatanLain, keterangan: 'lain', createdBy: USER_ID,
        }),
      ];
      const urutan = kronologis ? langkah : [...langkah].reverse();
      for (const l of urutan) await l();
      const hasil = await checkSaldoAkunCukup(testDb as any, {
        accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: 80_000_000,
      });
      return { valid: hasil.valid, saldo: await getAccountBalance(testDb as any, ACC.bank) };
    };

    const a = await jalankan(true);
    const b = await jalankan(false);
    expect(b).toEqual(a);
  });

  it('§Y batas: saldo = nominal DITERIMA, saldo = nominal - 1 DITOLAK', async () => {
    const saldo = await getAccountBalance(testDb as any, ACC.bank);

    const pas = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: saldo,
    });
    expect(pas.valid).toBe(true);

    const lebih = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: saldo + 1,
    });
    expect(lebih.valid).toBe(false);

    const kurang = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: saldo - 1,
    });
    expect(kurang.valid).toBe(true);
  });

  it('§Y saldo 0: pengeluaran berapa pun DITOLAK, nominal 0 tidak diuji sebagai pengeluaran', async () => {
    await catatPengeluaran({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-02-01',
      nominal: await getAccountBalance(testDb as any, ACC.bank),
      akunLawanId: ACC.bebanLain, keterangan: 'kuras', createdBy: USER_ID,
    });
    expect(await getAccountBalance(testDb as any, ACC.bank)).toBe(0);

    const hasil = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: 1,
    });
    expect(hasil.valid).toBe(false);
  });

  it('§Y month-end & year-end tidak mengubah keputusan (saldo berjalan tidak melihat tanggal)', async () => {
    for (const tanggal of ['2026-01-31', '2026-06-30', '2026-12-31']) {
      await catatPemasukan({
        jenis: 'BANK', bankAccountId: BANK_ID, tanggal, nominal: 1_000_000,
        akunLawanId: ACC.pendapatanLain, keterangan: `masuk ${tanggal}`, createdBy: USER_ID,
      });
    }
    const saldo = await getAccountBalance(testDb as any, ACC.bank);
    const hasil = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: saldo,
    });
    expect(hasil.valid).toBe(true);
  });
});

// ============================================================
// §AA — LIKUIDITAS + KOREKSI BANK (baru di S20)
// ============================================================
describe('§AA — likuiditas setelah koreksi bank', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('§AA koreksi mengembalikan saldo, dan keputusan likuiditas IKUT berubah — tidak tertinggal', async () => {
    const awal = await getAccountBalance(testDb as any, ACC.bank);

    const masuk = await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-31', nominal: 50_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pemasukan', createdBy: USER_ID,
    });

    // Sebelum koreksi: pengeluaran sebesar saldo BARU diterima.
    const sebelum = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: awal + 50_000_000,
    });
    expect(sebelum.valid).toBe(true);

    await koreksiTransaksiKasBank('BANK', masuk.id, USER_ID, 'salah nominal');

    // Sesudah koreksi: nominal yang sama DITOLAK, karena dananya
    // memang sudah tidak ada. Guard likuiditas tidak boleh memakai
    // saldo basi.
    const sesudah = await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: awal + 50_000_000,
    });
    expect(sesudah.valid).toBe(false);
    expect(await getAccountBalance(testDb as any, ACC.bank)).toBe(awal);
  });

  it('§AA keputusan likuiditas KONSISTEN dengan saldo GL setelah koreksi', async () => {
    const keluar = await catatPengeluaran({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-04-01', nominal: 30_000_000,
      akunLawanId: ACC.bebanLain, keterangan: 'beban', createdBy: USER_ID,
    });
    await koreksiTransaksiKasBank('BANK', keluar.id, USER_ID, 'salah beban');

    const saldo = await getAccountBalance(testDb as any, ACC.bank);
    expect(saldo).toBe(await saldoGl(testDb, ACC.bank));

    // Batasnya bergerak persis mengikuti saldo, bukan tertinggal di
    // posisi sebelum koreksi.
    expect((await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: saldo,
    })).valid).toBe(true);
    expect((await checkSaldoAkunCukup(testDb as any, {
      accountId: ACC.bank, namaRekening: 'Bank', nominalKeluar: saldo + 1,
    })).valid).toBe(false);
  });

  it('§AA koreksi tidak meninggalkan baris subledger yang tidak terhitung', async () => {
    const masuk = await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-31', nominal: 50_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pemasukan', createdBy: USER_ID,
    });
    await koreksiTransaksiKasBank('BANK', masuk.id, USER_ID, 'salah');

    // Setiap baris bank_transaksi punya tipe yang DIKENALI rekonsiliasi.
    const tipeTakDikenal = await angka(
      testDb,
      `SELECT COUNT(*) as n FROM bank_transaksi
        WHERE tipe NOT IN ('PENERIMAAN','PENGELUARAN','TRANSFER','KOREKSI')`
    );
    expect(tipeTakDikenal).toBe(0);
  });
});
