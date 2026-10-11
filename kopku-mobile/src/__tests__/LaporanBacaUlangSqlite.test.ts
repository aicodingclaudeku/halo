import { createTestDb, TestDb } from './testDb';
import { getPosisiKeuangan } from '@/reports/FinancialReports';

/**
 * §17/§21/§22 — LAPORAN SELALU MEMBACA SQLITE TERKINI.
 *
 * Bug yang dijaga: setelah transaksi di-commit, layar laporan yang
 * sudah pernah dibuka menampilkan angka lama sampai aplikasi direstart.
 *
 * Test ini mengunci sisi DATA-nya: `FinancialReports` tidak menyimpan
 * cache apa pun, sehingga pemanggilan berikutnya SELALU mencerminkan
 * state SQLite terbaru dalam PROSES YANG SAMA dan KONEKSI YANG SAMA —
 * tanpa restart. Dengan begitu terbukti bahwa staleness yang dilaporkan
 * BUKAN berasal dari lapisan laporan/akuntansi, melainkan murni dari
 * lifecycle layar (lihat hooks/useFocusRefresh.ts).
 *
 * Sisi UI-nya (useFocusEffect benar-benar terpasang) tidak dapat diuji
 * di lingkungan ini karena tidak tersedia React Native testing library;
 * dilaporkan sebagai NOT RUN, bukan diklaim lulus.
 */

let db: TestDb;

async function akun(id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kat, nb, now, now
  );
}

async function jurnal(id: string, tanggal: string, accDebit: string, accKredit: string, nominal: number) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?, 'p2026','KAS_MASUK','uji','POSTED','user-1',?,?,?)`,
    id, `JRN-${id}`, tanggal, now, now, now
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES (?,?,?,?,0,0)`,
    `${id}-d`, id, accDebit, nominal
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES (?,?,?,0,?,1)`,
    `${id}-k`, id, accKredit, nominal
  );
}

beforeEach(async () => {
  db = await createTestDb();
  await akun('acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT');
  await akun('acc-modal', '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await jurnal('j1', '2026-01-05', 'acc-kas', 'acc-modal', 5_000_000);
});

test('A-E: buka laporan -> commit transaksi -> baca lagi = nilai BARU, tanpa restart', async () => {
  // A. buka laporan, catat nilai
  const sebelum = await getPosisiKeuangan(db as any, '2026-12-31');
  expect(sebelum.totalAset).toBe(5_000_000);

  // B/C. "navigasi ke transaksi" lalu commit transaksi baru —
  // proses & koneksi SQLite SAMA, tidak ada restart.
  await jurnal('j2', '2026-06-01', 'acc-kas', 'acc-modal', 2_000_000);

  // D/E. "kembali ke laporan" -> pemuatan ulang
  const sesudah = await getPosisiKeuangan(db as any, '2026-12-31');
  expect(sesudah.totalAset).toBe(7_000_000);
  expect(sesudah.totalAset).not.toBe(sebelum.totalAset);
  expect(sesudah.selisih).toBe(0);
});

test('§9 pemuatan berulang (5x fokus) memberi hasil identik, tanpa akumulasi', async () => {
  const hasil = [];
  for (let i = 0; i < 5; i++) hasil.push(await getPosisiKeuangan(db as any, '2026-12-31'));
  for (const h of hasil) {
    expect(h.totalAset).toBe(5_000_000);
    expect(h.selisih).toBe(0);
  }
});

test('§17 tidak ada cache: tiap pemanggilan mencerminkan commit terakhir', async () => {
  expect((await getPosisiKeuangan(db as any, '2026-12-31')).totalAset).toBe(5_000_000);
  await jurnal('j3', '2026-07-01', 'acc-kas', 'acc-modal', 1_000_000);
  expect((await getPosisiKeuangan(db as any, '2026-12-31')).totalAset).toBe(6_000_000);
  await jurnal('j4', '2026-08-01', 'acc-kas', 'acc-modal', 500_000);
  expect((await getPosisiKeuangan(db as any, '2026-12-31')).totalAset).toBe(6_500_000);
});
