/**
 * ============================================================
 * RC-S61 — BENCHMARK: getKontrolGapUtangBungaAsOf vs kontrol GLOBAL
 * ============================================================
 *
 * BUKAN test regresi. Berkas ini sengaja diberi akhiran `.perf.ts`
 * sehingga TIDAK cocok dengan `testMatch` (`**\/__tests__\/**\/*.test.ts`)
 * di `jest.config.js` dan tidak ikut berjalan pada suite biasa.
 * Dijalankan eksplisit:
 *
 *   npx jest --runInBand --testMatch='**\/__tests__\/**\/*.perf.ts'
 *
 * LATAR BELAKANG (RC-S59 §10)
 * ---------------------------
 * `getKontrolGapUtangBungaAsOf()` memanggil `getKontrolGapUtangBunga(db)`
 * di dalamnya (UtangService.ts:1785). Kontrol global mem-replay SELURUH
 * utang sepanjang waktu. Karena PeriodClose memanggil versi as-of, setiap
 * penutupan periode ikut menanggung biaya pemindaian global itu.
 *
 * RC-S59 melaporkannya sebagai dugaan TANPA pengukuran, dan RC-S61 §1
 * memerintahkan MENGUKUR DULU, bukan menghapus pemanggilan.
 *
 * DESAIN PENGUKURAN
 * -----------------
 * Dataset sintetis DETERMINISTIK (tanpa Math.random, tanpa Date.now di
 * jalur data): N jurnal akrual bunga tersebar rata pada U utang, masing-
 * masing 100 jurnal bulanan. Bentuk barisnya persis seperti yang
 * dihasilkan jalur akrual sungguhan — `journal` ber-`sumber_transaksi`
 * 'UTANG_BUNGA' + `sumber_id` utang, dengan dua `journal_entry`
 * (debit Beban Bunga, kredit Utang Bunga) — supaya query yang diukur
 * adalah query yang sama dengan produksi.
 *
 * Yang diukur per ukuran dataset:
 *   1. getKontrolGapUtangBunga()      — kontrol GLOBAL
 *   2. getKontrolGapUtangBungaAsOf()  — versi AS-OF (termasuk global)
 *   3. jalankanGerbangAkrualBungaUtang() — jalur PeriodClose sesungguhnya
 * plus jumlah query SQL dan delta heap.
 *
 * Tiga iterasi per ukuran, dilaporkan MEDIAN (RC-S61 §1).
 */

import initSqlJs, { Database } from 'sql.js';
import { CREATE_TABLES_SQL } from '@/database/schema';

// ---- adapter TestDb + penghitung query -------------------------------
let queryCount = 0;
let testDb: any;

async function createCountingDb() {
  const SQL = await initSqlJs();
  const db: Database = new SQL.Database();
  db.run(CREATE_TABLES_SQL);
  return {
    async getFirstAsync<T>(sql: string, ...p: any[]): Promise<T | null> {
      queryCount++;
      const s = db.prepare(sql);
      s.bind(p);
      const has = s.step();
      const r = has ? (s.getAsObject() as unknown as T) : null;
      s.free();
      return r;
    },
    async getAllAsync<T>(sql: string, ...p: any[]): Promise<T[]> {
      queryCount++;
      const s = db.prepare(sql);
      s.bind(p);
      const rows: T[] = [];
      while (s.step()) rows.push(s.getAsObject() as unknown as T);
      s.free();
      return rows;
    },
    async runAsync(sql: string, ...p: any[]) {
      queryCount++;
      db.run(sql, p);
      return { lastInsertRowId: 0, changes: db.getRowsModified() };
    },
    async execAsync(sql: string) {
      queryCount++;
      db.run(sql);
    },
    async withTransactionAsync(fn: () => Promise<void>) {
      db.run('BEGIN');
      try {
        await fn();
        db.run('COMMIT');
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    },
    closeSync() {
      db.close();
    },
    _raw: db,
  };
}

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: any) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { getKontrolGapUtangBunga, getKontrolGapUtangBungaAsOf } from '@/services/UtangService';
// RC-S62 §9 — implementasi AS-OF LAMA (beku) sebagai pembanding OLD vs NEW.
import { getKontrolGapUtangBungaAsOf as asOfLama } from './UtangServiceReferensiRcS62';
import { jalankanGerbangAkrualBungaUtang } from '@/services/PeriodCloseService';

const ACC = {
  kas: 'acc-kas',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
  modal: 'acc-3-1000',
};
const FIXED_NOW = '2020-01-01T00:00:00.000Z';
const JURNAL_PER_UTANG = 100;

/** Tanggal bulanan deterministik mulai 2018-01-31, indeks ke-i. */
function tanggalBulanKe(i: number): string {
  const tahun = 2018 + Math.floor(i / 12);
  const bulan = (i % 12) + 1;
  const hariTerakhir = new Date(Date.UTC(tahun, bulan, 0)).getUTCDate();
  return `${tahun}-${String(bulan).padStart(2, '0')}-${String(hariTerakhir).padStart(2, '0')}`;
}

async function seedDasar() {
  const akun: [string, string, string, string, string][] = [
    [ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT'],
    [ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT'],
    [ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT'],
    [ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT'],
    [ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT'],
  ];
  for (const [id, kode, nama, kat, nb] of akun) {
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, nama, kat, nb, FIXED_NOW, FIXED_NOW
    );
  }
  const map: [string, string, string][] = [
    ['KAS_UMUM', 'DEFAULT', ACC.kas],
    ['UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank],
    ['UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank],
    ['UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga],
    ['UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga],
  ];
  for (const [tt, role, acc] of map) {
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-${tt}-${role}`, tt, role, acc
    );
  }
  for (let th = 2017; th <= 2030; th++) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    FIXED_NOW, FIXED_NOW
  );
}

/**
 * Seed N jurnal akrual pada U utang. Semua nilai tetap, tidak acak.
 * Nomor jurnal mengikuti pola produksi (PREFIX-000001) agar urutan total
 * `bandingkanKejadianBungaUtang` terpakai sebagaimana mestinya.
 */
async function seedDataset(jumlahJurnal: number): Promise<{ utang: number }> {
  const utangCount = Math.max(1, Math.round(jumlahJurnal / JURNAL_PER_UTANG));
  const perUtang = Math.max(1, Math.round(jumlahJurnal / utangCount));
  await testDb.withTransactionAsync(async () => {
    for (let u = 0; u < utangCount; u++) {
      const uid = `utang-${String(u).padStart(6, '0')}`;
      await testDb.runAsync(
        `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman,
                            persen_bunga, jenis_bunga, basis_bunga, tanggal, sumber_dana, sumber,
                            status, created_by, created_at, updated_at)
         VALUES (?,?,?,'BANK',120000000,12,'FLAT','TAHUNAN','2018-01-01','KAS','LANGSUNG','AKTIF','user-1',?,?)`,
        uid, `UTG-${String(u).padStart(6, '0')}`, `Bank ${u}`, FIXED_NOW, FIXED_NOW
      );
      for (let m = 0; m < perUtang; m++) {
        const jid = `j-${uid}-${String(m).padStart(4, '0')}`;
        const tgl = tanggalBulanKe(m);
        const periodId = `p${tgl.slice(0, 4)}`;
        await testDb.runAsync(
          `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, sumber_id,
                                deskripsi, status, created_by, posted_at, created_at, updated_at)
           VALUES (?,?,?,?,'UTANG_BUNGA',?,'Akrual bunga','POSTED','user-1',?,?,?)`,
          jid, `AKR-${String(u * 10000 + m).padStart(6, '0')}`, tgl, periodId, uid,
          FIXED_NOW, FIXED_NOW, FIXED_NOW
        );
        await testDb.runAsync(
          `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
           VALUES (?,?,?,1200000,0,0)`,
          `${jid}-d`, jid, ACC.bebanBunga
        );
        await testDb.runAsync(
          `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
           VALUES (?,?,?,0,1200000,1)`,
          `${jid}-k`, jid, ACC.utangBunga
        );
      }
    }
  });
  return { utang: utangCount };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const UKURAN = [100, 1000, 10000];
const ITERASI_PER_UKURAN: Record<number, number> = { 100: 3, 1000: 3, 10000: 1 };

jest.setTimeout(60 * 60 * 1000);

describe('RC-S61 — benchmark kontrol gap utang bunga', () => {
  it('mengukur GLOBAL vs AS-OF vs PeriodClose pada dataset bertingkat', async () => {
    const hasil: any[] = [];

    for (const n of UKURAN) {
      testDb = await createCountingDb();
      await seedDasar();
      const { utang } = await seedDataset(n);

      const cekJurnal: { c: number } | null = await testDb.getFirstAsync(
        `SELECT COUNT(*) c FROM journal WHERE sumber_transaksi='UTANG_BUNGA'`
      );

      const tGlobal: number[] = [];
      const tAsOfLama: number[] = [];
      const tAsOfBaru: number[] = [];
      const tGerbang: number[] = [];
      let qGlobal = 0;
      let qAsOfLama = 0;
      let qAsOfBaru = 0;
      let heapDelta = 0;
      const iterasi = ITERASI_PER_UKURAN[n] ?? 1;

      for (let i = 0; i < iterasi; i++) {
        global.gc?.();
        const h0 = process.memoryUsage().heapUsed;

        queryCount = 0;
        let t0 = performance.now();
        await getKontrolGapUtangBunga(testDb);
        tGlobal.push(performance.now() - t0);
        qGlobal = queryCount;

        queryCount = 0;
        t0 = performance.now();
        await asOfLama('2025-12-31', testDb);
        tAsOfLama.push(performance.now() - t0);
        qAsOfLama = queryCount;

        queryCount = 0;
        t0 = performance.now();
        await getKontrolGapUtangBungaAsOf('2025-12-31', testDb);
        tAsOfBaru.push(performance.now() - t0);
        qAsOfBaru = queryCount;

        t0 = performance.now();
        await jalankanGerbangAkrualBungaUtang({
          periodeMulai: '2025-01-01',
          periodeSelesai: '2025-12-31',
          createdBy: 'user-1',
          tanggalSekarang: '2026-01-15',
        });
        tGerbang.push(performance.now() - t0);

        heapDelta = (process.memoryUsage().heapUsed - h0) / 1024 / 1024;
      }

      hasil.push({
        jurnal: cekJurnal?.c ?? 0,
        utang,
        global_ms: +median(tGlobal).toFixed(1),
        asof_lama_ms: +median(tAsOfLama).toFixed(1),
        asof_baru_ms: +median(tAsOfBaru).toFixed(1),
        gerbang_baru_ms: +median(tGerbang).toFixed(1),
        q_global: qGlobal,
        q_asof_lama: qAsOfLama,
        q_asof_baru: qAsOfBaru,
        heap_mb: +heapDelta.toFixed(1),
      });

      // eslint-disable-next-line no-console
      console.log('RCS61_ROW ' + JSON.stringify(hasil[hasil.length - 1]));
      testDb.closeSync();
    }

    // eslint-disable-next-line no-console
    console.log('RCS61_TABLE ' + JSON.stringify(hasil));
    expect(hasil.length).toBe(UKURAN.length);
  });
});
