import { createTestDb, TestDb } from './testDb';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';

/** RC-S54 TAHAP 16 — fixture bersama: COA & mapping produksi lengkap di SQLite nyata. */

export const accId = (kode: string) => `acc-${kode}`;
export const USER = 'user-1';

export async function seedJurnal(
  db: TestDb,
  id: string,
  tanggal: string,
  sumber: string,
  lines: [string, number, number][],
  opsi: { sumberId?: string | null; status?: string } = {}
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, sumber_id, deskripsi, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'uji',?,'user-1',?,?)`,
    id, `JRN-${id}`, tanggal, `p${tanggal.slice(0, 4)}`, sumber, opsi.sumberId ?? null, opsi.status ?? 'POSTED', now, now
  );
  let n = 0;
  for (const [kode, d, k] of lines) {
    n += 1;
    await db.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,?)`,
      `${id}-${n}`, id, accId(kode), d, k
    );
  }
}

export async function buatDbCoaLengkap(opsi: { periodeTutup?: number[] } = {}): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  for (const a of DEFAULT_ACCOUNTS) {
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES (?,?,?,?,?,1,?,?,?,?)`,
      accId(a.kode), a.kode, a.nama, a.kategori, a.normalBalance, a.isSystem ? 1 : 0, a.lhuKlasifikasi ?? null, now, now
    );
  }
  let i = 0;
  for (const m of DEFAULT_ACCOUNT_MAPPING) {
    i += 1;
    await db.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-${i}`, m.transactionType, m.role, accId(m.accountKode)
    );
  }
  for (const th of [2025, 2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,?)`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`, (opsi.periodeTutup ?? []).includes(th) ? 'CLOSED' : 'OPEN'
    );
  }
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await seedJurnal(db, 'j-modal', '2025-01-01', 'MODAL_AWAL', [['1-1000', 900_000_000, 0], ['3-1000', 0, 900_000_000]]);
  return db;
}

export const FAKE_TIMERS_DATE_ONLY = {
  doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask', 'clearTimeout', 'clearInterval', 'clearImmediate', 'hrtime', 'performance'],
} as const;

export async function snapshotTabel(db: TestDb, tabel: readonly string[]): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const t of tabel) out[t] = await db.getAllAsync(`SELECT * FROM ${t} ORDER BY rowid`);
  return JSON.parse(JSON.stringify(out));
}
