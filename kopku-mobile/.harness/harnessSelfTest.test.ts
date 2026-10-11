import Decimal from './decimalHarness';
import { addDays, addWeeks, addMonths, format, differenceInCalendarDays } from './dateFnsShim';
import { createTestDb, TestDb } from './testDb';

/**
 * SELF-TEST HARNESS (RC-S53 Tranche 3 FASE 2, §8/§9/§10).
 *
 * Harness yang salah menghasilkan kegagalan yang TERLIHAT seperti bug
 * produksi — persis yang terjadi pada FASE 1, ketika `decimalShim`
 * tipe-saja membuat setiap nilai uang menjadi nol. Berkas ini menguji
 * alat ukurnya sendiri.
 *
 * BATAS YANG HARUS DIAKUI. Perbandingan langsung "decimal.js asli vs
 * shim" dan "date-fns asli vs shim" TIDAK dapat dijalankan: kedua paket
 * itu tidak terpasang di lingkungan ini. Yang diuji adalah kesesuaian
 * dengan SEMANTIK TERDOKUMENTASI keduanya, pada nilai yang jawabannya
 * dapat diturunkan secara independen (aritmetika eksak, kalender
 * Gregorian). Perbandingan A/B yang sesungguhnya baru mungkin di mesin
 * yang punya `node_modules`.
 */

// ===========================================================================
// §8 — Decimal
// ===========================================================================

describe('§8 decimalHarness — aritmetika eksak', () => {
  it('penjumlahan desimal tidak terkena galat float', () => {
    // 0.1 + 0.2 === 0.30000000000000004 pada float IEEE-754.
    expect(new Decimal('0.1').plus('0.2').toString()).toBe('0.3');
    expect(new Decimal('0.1').plus('0.2').equals('0.3')).toBe(true);
  });

  it('pengurangan, perkalian, pembagian', () => {
    expect(new Decimal(10).minus(3).toNumber()).toBe(7);
    expect(new Decimal('1.5').times('2.5').toString()).toBe('3.75');
    expect(new Decimal(10).div(4).toString()).toBe('2.5');
  });

  it('kasus uang yang membuat FASE 1 gagal: 10.000.000 x 12% x 3/12', () => {
    const hasil = new Decimal(10_000_000).times(0.12).times(3).div(12);
    expect(hasil.toNumber()).toBe(300_000);
  });

  it('toDecimalPlaces membulatkan SETENGAH KE ATAS', () => {
    expect(new Decimal('2.5').toDecimalPlaces(0).toNumber()).toBe(3);
    expect(new Decimal('3.5').toDecimalPlaces(0).toNumber()).toBe(4);
    expect(new Decimal('2.4').toDecimalPlaces(0).toNumber()).toBe(2);
    // Setengah ke atas MENJAUHI nol untuk bilangan negatif.
    expect(new Decimal('-2.5').toDecimalPlaces(0).toNumber()).toBe(-3);
  });

  it('pembulatan ke rupiah bulat pada nilai yang rawan', () => {
    expect(new Decimal('1000000.5').toDecimalPlaces(0).toNumber()).toBe(1_000_001);
    expect(new Decimal('1000000.4999').toDecimalPlaces(0).toNumber()).toBe(1_000_000);
  });

  it('pow bilangan bulat, positif dan negatif', () => {
    expect(new Decimal(2).pow(10).toNumber()).toBe(1024);
    expect(new Decimal(2).pow(0).toNumber()).toBe(1);
    expect(new Decimal(4).pow(-1).toString()).toBe('0.25');
  });

  it('abs & negated', () => {
    expect(new Decimal('-7.25').abs().toString()).toBe('7.25');
    expect(new Decimal('7.25').negated().toString()).toBe('-7.25');
  });

  it('perbandingan', () => {
    expect(new Decimal('0.3').comparedTo('0.1')).toBe(1);
    expect(new Decimal('0.1').comparedTo('0.3')).toBe(-1);
    expect(new Decimal('0.3').comparedTo('0.3')).toBe(0);
    expect(new Decimal(5).greaterThan(4)).toBe(true);
    expect(new Decimal(5).lessThan(4)).toBe(false);
    expect(new Decimal(5).gte(5)).toBe(true);
    expect(new Decimal(5).lte(4)).toBe(false);
    expect(new Decimal(0).isZero()).toBe(true);
    expect(new Decimal(-1).isNegative()).toBe(true);
  });

  it('notasi eksponen diterima (dipakai solver EIR)', () => {
    expect(new Decimal('1e-7').toString()).toBe('0.0000001');
    expect(new Decimal('2.5e3').toNumber()).toBe(2500);
  });

  it('toFixed', () => {
    expect(new Decimal('1234.5678').toFixed(2)).toBe('1234.57');
    expect(new Decimal('1234').toFixed(0)).toBe('1234');
  });

  it('nilai tidak valid MELEMPAR, tidak diam-diam menjadi nol', () => {
    // Inilah kegagalan `decimalShim` lama: ia mengembalikan 0 untuk
    // apa pun, sehingga test hijau di atas angka yang salah.
    expect(() => new Decimal('bukan angka')).toThrow(/tidak valid/);
    expect(() => new Decimal(10).div(0)).toThrow(/nol/);
  });
});

// ===========================================================================
// §9 — date-fns
// ===========================================================================

describe('§9 dateFnsShim — kalender', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00`);

  it('addDays biasa & lintas bulan', () => {
    expect(format(addDays(d('2026-09-10'), 5), 'yyyy-MM-dd')).toBe('2026-09-15');
    expect(format(addDays(d('2026-09-28'), 5), 'yyyy-MM-dd')).toBe('2026-10-03');
  });

  it('addDays lintas tahun', () => {
    expect(format(addDays(d('2026-12-30'), 3), 'yyyy-MM-dd')).toBe('2027-01-02');
  });

  it('addWeeks', () => {
    expect(format(addWeeks(d('2026-09-10'), 2), 'yyyy-MM-dd')).toBe('2026-09-24');
  });

  it('addMonths MENJEPIT akhir bulan — 31 Jan + 1 bulan = 28 Feb', () => {
    // `setMonth()` bawaan JS akan meluap ke 3 Maret. Kalau ini salah,
    // tanggal jatuh tempo kontrak ikut melenceng.
    expect(format(addMonths(d('2026-01-31'), 1), 'yyyy-MM-dd')).toBe('2026-02-28');
  });

  it('addMonths pada tahun kabisat — 31 Jan 2024 + 1 bulan = 29 Feb', () => {
    expect(format(addMonths(d('2024-01-31'), 1), 'yyyy-MM-dd')).toBe('2024-02-29');
  });

  it('addMonths 31 Mei + 1 bulan = 30 Juni', () => {
    expect(format(addMonths(d('2026-05-31'), 1), 'yyyy-MM-dd')).toBe('2026-06-30');
  });

  it('addMonths lintas tahun & mundur', () => {
    expect(format(addMonths(d('2026-11-15'), 3), 'yyyy-MM-dd')).toBe('2027-02-15');
    expect(format(addMonths(d('2026-01-15'), -1), 'yyyy-MM-dd')).toBe('2025-12-15');
  });

  it('addMonths tenor simpanan berjangka 3/6/12', () => {
    expect(format(addMonths(d('2026-09-01'), 3), 'yyyy-MM-dd')).toBe('2026-12-01');
    expect(format(addMonths(d('2026-09-01'), 6), 'yyyy-MM-dd')).toBe('2027-03-01');
    expect(format(addMonths(d('2026-09-01'), 12), 'yyyy-MM-dd')).toBe('2027-09-01');
  });

  it('differenceInCalendarDays menghitung HARI KALENDER, bukan selisih jam', () => {
    expect(differenceInCalendarDays(d('2026-09-15'), d('2026-09-10'))).toBe(5);
    // Beda 2 jam tetapi melewati tengah malam -> 1 hari kalender.
    const malam = new Date('2026-09-10T23:00:00');
    const pagi = new Date('2026-09-11T01:00:00');
    expect(differenceInCalendarDays(pagi, malam)).toBe(1);
  });

  it('differenceInCalendarDays negatif & lintas tahun kabisat', () => {
    expect(differenceInCalendarDays(d('2026-09-10'), d('2026-09-15'))).toBe(-5);
    expect(differenceInCalendarDays(d('2024-03-01'), d('2024-02-28'))).toBe(2);
  });

  it('format token yang dipakai produksi', () => {
    const t = new Date('2026-09-05T07:08:09');
    expect(format(t, 'yyyy-MM-dd')).toBe('2026-09-05');
    expect(format(t, 'dd/MM/yyyy')).toBe('05/09/2026');
    expect(format(t, 'HH:mm:ss')).toBe('07:08:09');
  });

  it('token tak dikenal MELEMPAR, tidak mengembalikan string salah', () => {
    expect(() => format(new Date(), 'yyyy MMMM')).toThrow(/belum didukung/);
  });
});

// ===========================================================================
// §10 — adapter node:sqlite
// ===========================================================================

describe('§10 testDb — kompatibilitas adapter', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await db.execAsync(`CREATE TABLE uji (
      id TEXT PRIMARY KEY,
      teks TEXT,
      bilangan INTEGER,
      pecahan REAL,
      flag INTEGER
    )`);
  });

  afterEach(() => {
    db.closeSync();
  });

  it('skema produksi ikut terpasang', async () => {
    const row = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='journal'`
    );
    expect(row?.n).toBe(1);
  });

  it('NULL, teks, integer, real', async () => {
    await db.runAsync(`INSERT INTO uji (id, teks, bilangan, pecahan) VALUES (?,?,?,?)`, 'a', null, 42, 1.5);
    const row = await db.getFirstAsync<any>(`SELECT * FROM uji WHERE id = ?`, 'a');
    expect(row.teks).toBeNull();
    expect(row.bilangan).toBe(42);
    expect(row.pecahan).toBe(1.5);
  });

  it('undefined diperlakukan sebagai NULL, sama seperti expo-sqlite', async () => {
    await db.runAsync(`INSERT INTO uji (id, teks) VALUES (?,?)`, 'b', undefined);
    const row = await db.getFirstAsync<any>(`SELECT teks FROM uji WHERE id = ?`, 'b');
    expect(row.teks).toBeNull();
  });

  it('boolean dinormalisasi ke 0/1', async () => {
    await db.runAsync(`INSERT INTO uji (id, flag) VALUES (?,?)`, 'c', true);
    await db.runAsync(`INSERT INTO uji (id, flag) VALUES (?,?)`, 'd', false);
    expect((await db.getFirstAsync<any>(`SELECT flag FROM uji WHERE id='c'`)).flag).toBe(1);
    expect((await db.getFirstAsync<any>(`SELECT flag FROM uji WHERE id='d'`)).flag).toBe(0);
  });

  it('objek tak dikenal MELEMPAR, tidak disimpan sebagai [object Object]', async () => {
    await expect(
      db.runAsync(`INSERT INTO uji (id, teks) VALUES (?,?)`, 'e', { a: 1 } as any)
    ).rejects.toThrow(/tidak didukung/);
  });

  it('getAllAsync, update, delete, changes', async () => {
    await db.runAsync(`INSERT INTO uji (id, bilangan) VALUES (?,?)`, 'x', 1);
    await db.runAsync(`INSERT INTO uji (id, bilangan) VALUES (?,?)`, 'y', 2);
    expect(await db.getAllAsync(`SELECT * FROM uji`)).toHaveLength(2);

    const ubah = await db.runAsync(`UPDATE uji SET bilangan = ? WHERE id = ?`, 9, 'x');
    expect(ubah.changes).toBe(1);

    const hapus = await db.runAsync(`DELETE FROM uji WHERE id = ?`, 'y');
    expect(hapus.changes).toBe(1);
    expect(await db.getAllAsync(`SELECT * FROM uji`)).toHaveLength(1);
  });

  it('getFirstAsync mengembalikan null bila tidak ada baris', async () => {
    expect(await db.getFirstAsync(`SELECT * FROM uji WHERE id = ?`, 'tidak-ada')).toBeNull();
  });

  it('COMMIT menyimpan perubahan', async () => {
    await db.withTransactionAsync(async () => {
      await db.runAsync(`INSERT INTO uji (id, bilangan) VALUES (?,?)`, 'commit', 1);
    });
    expect(await db.getAllAsync(`SELECT * FROM uji`)).toHaveLength(1);
  });

  it('ROLLBACK membatalkan seluruh perubahan transaksi', async () => {
    await expect(
      db.withTransactionAsync(async () => {
        await db.runAsync(`INSERT INTO uji (id, bilangan) VALUES (?,?)`, 'rb1', 1);
        await db.runAsync(`INSERT INTO uji (id, bilangan) VALUES (?,?)`, 'rb2', 2);
        throw new Error('gagal di tengah');
      })
    ).rejects.toThrow('gagal di tengah');
    expect(await db.getAllAsync(`SELECT * FROM uji`)).toHaveLength(0);
  });

  it('transaksi BERSARANG ikut transaksi terluar; kegagalan tetap rollback total', async () => {
    await expect(
      db.withTransactionAsync(async () => {
        await db.runAsync(`INSERT INTO uji (id) VALUES (?)`, 'luar');
        await db.withTransactionAsync(async () => {
          await db.runAsync(`INSERT INTO uji (id) VALUES (?)`, 'dalam');
          throw new Error('gagal di dalam');
        });
      })
    ).rejects.toThrow('gagal di dalam');
    expect(await db.getAllAsync(`SELECT * FROM uji`)).toHaveLength(0);
  });

  it('FOREIGN KEY DITEGAKKAN — sama seperti produksi (db.ts: PRAGMA foreign_keys = ON)', async () => {
    // `src/__tests__/testDb.ts` (sql.js) TIDAK menyalakan pragma ini,
    // sehingga fixture yang melanggar relasi lolos di test tetapi akan
    // ditolak di perangkat. Adapter ini sengaja mengikuti produksi.
    // PRAGMA mengembalikan kolom bernama sama dengan pragma-nya.
    const row = await db.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(row?.foreign_keys).toBe(1);

    await expect(
      db.runAsync(
        `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
         VALUES (?,?,?,?,?,?)`,
        'je-yatim',
        'journal-tidak-ada',
        'account-tidak-ada',
        1000,
        0,
        0
      )
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('setiap createTestDb() benar-benar terisolasi', async () => {
    await db.runAsync(`INSERT INTO uji (id) VALUES (?)`, 'sesi-1');
    const db2 = await createTestDb();
    const row = await db2.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='uji'`
    );
    expect(row?.n).toBe(0);
    db2.closeSync();
  });
});
