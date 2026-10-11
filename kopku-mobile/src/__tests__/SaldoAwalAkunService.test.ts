import { createTestDb, TestDb } from './testDb';

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
  listSaldoAwalAkun,
  listAkunNeracaUntukSaldoAwal,
  tambahSaldoAwalAkun,
  editSaldoAwalAkun,
  hapusSaldoAwalAkun,
  postingSaldoAwal,
  koreksiSaldoAwal,
  getValidasiSaldoAwal,
  getRingkasanSaldoAwal,
  getLegacyOpeningBalanceInfo,
  getAsetTetapAccountInfo,
  getSaldoAwalLockInfo,
  kunciSaldoAwalPermanen,
} from '@/services/SaldoAwalAkunService';
import { getPosisiKeuangan } from '@/reports/FinancialReports';
import { createJournal } from '@/accounting/AccountingEngine';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`, transactionType, role, accountId
  );
}

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  piutang: 'acc-piutang',
  asetTetap: 'acc-aset-tetap',
  rak: 'acc-rak',
  utang: 'acc-utang',
  simpananPokok: 'acc-simpanan-pokok',
  simpananWajib: 'acc-simpanan-wajib',
  cadangan: 'acc-cadangan',
  ekuitasLainnya: 'acc-ekuitas-lainnya',
  kliringKoreksi: 'acc-kliring-koreksi',
};

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.asetTetap, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.rak, '1-1800', 'Rekening Antar Kantor (RAK)', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.utang, '2-1400', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.simpananWajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.cadangan, '3-2000', 'Cadangan', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.ekuitasLainnya, '3-3000', 'Ekuitas Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.kliringKoreksi, '3-5000', 'Saldo Awal Belum Sesuai', 'EKUITAS', 'KREDIT');
  await seedMapping(db, 'KOREKSI_SALDO_AWAL', 'KLIRING', ACC.kliringKoreksi);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026', 2026, '2026-01-01', '2026-12-31'
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(), new Date().toISOString()
  );
  return db;
}

async function saldoAkun(accountId: string): Promise<number> {
  const row = await testDb.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
    accountId
  );
  return row?.total ?? 0;
}

/**
 * Audit ulang (permintaan pengguna, request FINAL): helper untuk
 * mensimulasikan baris LEGACY yang genuinely belum pernah diposting
 * (journal_id NULL) — sejak perubahan FINAL ini, `tambahSaldoAwalAkun()`
 * SELALU langsung membuat jurnal, jadi baris draft murni TIDAK PERNAH
 * lagi tercipta lewat alur normal. Dipakai HANYA untuk menguji jalur
 * kompatibilitas mundur (`postingSaldoAwal()`/`editSaldoAwalAkun()`
 * untuk baris legacy) — mensimulasikan data peninggalan dari sebelum
 * perubahan ini ada.
 */
async function seedLegacyDraftRow(db: TestDb, accountId: string, saldo: number, tanggal = '2026-01-01') {
  const id = `legacy-draft-${accountId}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at)
     VALUES (?,?,?,?,NULL,'user-1',?,?)`,
    id,
    accountId,
    tanggal,
    saldo,
    now,
    now
  );
  return id;
}

// ============================================================
// Audit ulang (permintaan pengguna, request FINAL §5/§6/§7/§13/§14):
// SATU-SATUNYA jalur SEKARANG — tambahSaldoAwalAkun() langsung membuat
// jurnal 2-baris (akun + kliring "Saldo Awal Belum Sesuai") & AKTIF
// SEKETIKA, TIDAK ADA lagi draft/posting terpisah.
// ============================================================
describe('SaldoAwalAkunService — SIMPAN langsung aktif (request FINAL §5/§6/§7/§13/§14)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('tambahSaldoAwalAkun: LANGSUNG membuat jurnal 2-baris (akun + kliring) & aktif seketika — TIDAK ADA lagi status draft', async () => {
    const hasil = await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });

    expect(hasil.posted).toBe(true);
    expect(hasil.journalId).toBeTruthy();

    const daftar = await listSaldoAwalAkun();
    expect(daftar).toHaveLength(1);
    expect(daftar[0].posted).toBe(true);
    expect(daftar[0].journalId).toBeTruthy();

    // Jurnal SUNGGUHAN ada, tepat 1, dengan 2 baris (akun + kliring).
    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnal?.cnt).toBe(1);
    const entries = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      hasil.journalId
    );
    expect(entries).toHaveLength(2);
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit); // jurnal SELALU balance sendiri

    // #18 (tetap berlaku): TIDAK ADA yang menyentuh Ekuitas Lainnya —
    // kontra SEKARANG akun kliring "Saldo Awal Belum Sesuai" (3-5000),
    // BUKAN 3-3000.
    expect(await saldoAkun(ACC.ekuitasLainnya)).toBe(0);

    // Langsung aktif di ledger — masuk laporan seketika (§6/§25), tidak
    // perlu langkah kedua apa pun.
    expect(await saldoAkun(ACC.kas)).toBe(100_000_000);
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(-100_000_000); // lawan teknis, transparan
  });

  test('akun kliring "Saldo Awal Belum Sesuai" SECARA MATEMATIS PERSIS SAMA dengan selisih murni yang diinput user (§9/§10) — TIDAK menyamarkan ketidaklengkapan', async () => {
    // Hanya Kas & Piutang diisi (Debit), TANPA lawan Liabilitas/Ekuitas — sengaja belum lengkap.
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.piutang, tanggal: '2026-01-01', saldo: 500_000_000, createdBy: 'user-1' });

    const v = await getValidasiSaldoAwal(testDb as any);
    expect(v.selisih).toBe(600_000_000); // selisih murni dari getValidasiSaldoAwal (independen dari akun kliring)

    // Saldo akun kliring (dari ledger sungguhan) PERSIS SAMA dengan selisih di atas.
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(-600_000_000); // kredit 600jt (lawan 2 baris debit)

    // Setelah dilengkapi (Simpanan Pokok Kredit 600jt), kliring balik ke Rp0 SENDIRINYA, TANPA transaksi tambahan.
    await tambahSaldoAwalAkun({ accountId: ACC.simpananPokok, tanggal: '2026-01-01', saldo: 600_000_000, createdBy: 'user-1' });
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(0);
    const vSesudah = await getValidasiSaldoAwal(testDb as any);
    expect(vSesudah.selisih).toBe(0);
    expect(vSesudah.seimbang).toBe(true);
  });

  // Audit ulang (permintaan pengguna, request baru §Q TEST 1): 25 akun
  // COA berbeda dapat DIBERIKAN saldo awal secara independen —
  // membuktikan arsitektur ini bekerja untuk COA berukuran nyata
  // (bukan hanya 1-2 akun contoh), tanpa batasan jumlah apa pun.
  test('TEST 1 (§Q): 25 akun COA berbeda semuanya dapat diberikan saldo awal secara independen, masing-masing langsung aktif', async () => {
    const kodePrefix = ['1-2', '1-3', '1-4', '1-5', '1-6']; // 5 blok kode x 5 akun = 25 akun
    const ids: string[] = [];
    let n = 0;
    for (const prefix of kodePrefix) {
      for (let i = 0; i < 5; i++) {
        n++;
        const id = `acc-extra-${n}`;
        await seedAccount(testDb, id, `${prefix}${i}00`, `Akun Tambahan ${n}`, 'ASET', 'DEBIT');
        ids.push(id);
      }
    }
    expect(ids).toHaveLength(25);

    for (const [i, id] of ids.entries()) {
      await tambahSaldoAwalAkun({ accountId: id, tanggal: '2026-01-01', saldo: (i + 1) * 1_000_000, createdBy: 'user-1' });
    }

    const daftar = await listSaldoAwalAkun();
    expect(daftar.filter((d) => d.accountId.startsWith('acc-extra-'))).toHaveLength(25);
    // Audit ulang: SEMUA langsung aktif (posted=true), BUKAN draft lagi.
    expect(daftar.filter((d) => d.accountId.startsWith('acc-extra-')).every((d) => d.posted === true)).toBe(true);
    // 25 jurnal terpisah (satu per akun) — masing-masing balance sendiri.
    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnal?.cnt).toBe(25);
  });

  test('editSaldoAwalAkun: HANYA berlaku untuk baris LEGACY yang genuinely belum pernah diposting (journal_id NULL) — DITOLAK untuk baris normal (selalu sudah posted)', async () => {
    const hasil = await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 5_000_000, createdBy: 'user-1' });
    await expect(
      editSaldoAwalAkun({ id: hasil.id, accountId: ACC.kas, tanggal: '2026-01-01', saldo: 8_000_000, updatedBy: 'user-1' })
    ).rejects.toThrow(/sudah diposting/);
  });

  test('editSaldoAwalAkun: BERHASIL untuk baris LEGACY (journal_id NULL, peninggalan sebelum perubahan FINAL ini) — tetap TIDAK membuat jurnal apa pun', async () => {
    const id = await seedLegacyDraftRow(testDb, ACC.kas, 5_000_000);
    await editSaldoAwalAkun({ id, accountId: ACC.kas, tanggal: '2026-01-01', saldo: 8_000_000, updatedBy: 'user-1' });

    const daftar = await listSaldoAwalAkun();
    expect(daftar[0].saldo).toBe(8_000_000);
    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnal?.cnt).toBe(0);
  });

  test('hapusSaldoAwalAkun: baris NORMAL (sudah aktif/posted) dihapus lewat REVERSAL (§17) — jurnal asli TIDAK di-DELETE/UPDATE, tetap ada sebagai audit trail', async () => {
    const hasil = await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    const journalIdAsli = hasil.journalId!;

    await hapusSaldoAwalAkun(hasil.id, 'user-1');

    // Baris saldo_awal_akun hilang — akun kembali "Belum Diisi".
    const daftar = await listSaldoAwalAkun();
    expect(daftar).toHaveLength(0);

    // Jurnal ASLI tetap ADA (TIDAK dihapus), tapi statusnya berubah jadi REVERSED.
    const jurnalAsli = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, journalIdAsli);
    expect(jurnalAsli).not.toBeNull();
    expect(jurnalAsli?.status).toBe('REVERSED');

    // Ada JURNAL REVERSAL baru (jurnal kedua), saldo bersih akun jadi Rp0 lagi.
    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnal?.cnt).toBe(2); // asli + reversal
    expect(await saldoAkun(ACC.kas)).toBe(0);
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(0);
  });

  test('hapusSaldoAwalAkun: baris LEGACY (journal_id NULL) — DELETE langsung, TIDAK ada reversal karena tidak pernah ada jurnal', async () => {
    const id = await seedLegacyDraftRow(testDb, ACC.kas, 5_000_000);
    await hapusSaldoAwalAkun(id, 'user-1');

    const daftar = await listSaldoAwalAkun();
    expect(daftar).toHaveLength(0);
    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnal?.cnt).toBe(0);
  });

  // Audit ulang (permintaan pengguna §6/§30 TEST 7 — "IDEMPOTENCY"):
  // penegasan EKSPLISIT bahwa penolakan di atas berarti TIDAK ADA
  // jurnal kedua yang terbentuk — "klik SIMPAN lagi" untuk akun yang
  // sama TETAP hanya menghasilkan SATU jurnal, bukan dua.
  test('TEST 7 (§30): menambah saldo awal DUA KALI untuk akun yang sama TIDAK menghasilkan jurnal kedua — tetap hanya SATU jurnal (idempotency)', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 1_000_000, createdBy: 'user-1' });
    const jumlahSebelum = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahSebelum?.cnt).toBe(1);

    await expect(
      tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-02', saldo: 2_000_000, createdBy: 'user-1' })
    ).rejects.toThrow(/sudah memiliki saldo awal/);

    const jumlahSesudah = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahSesudah?.cnt).toBe(1); // TETAP satu, bukan dua
    expect(await saldoAkun(ACC.kas)).toBe(1_000_000); // nilai TIDAK berubah jadi 2jt/3jt
  });

  // ============================================================
  // Audit ulang (permintaan pengguna §2/§23/§24/§25 — "DRAFT vs
  // PERMANEN harus menghasilkan laporan yang sama"): membuktikan
  // LANGSUNG lewat service SUNGGUHAN (bukan simulasi manual) bahwa
  // "tampilan" (`listSaldoAwalAkun`/`getRingkasanSaldoAwal`, dibaca
  // dari tabel `saldo_awal_akun`) dan "hasil permanen" (`getPosisiKeuangan`,
  // dibaca dari ledger sungguhan) SAMA PERSIS untuk setiap akun —
  // konsisten dengan arsitektur instan (setiap SIMPAN langsung
  // memposting jurnal seketika, TIDAK ADA lagi jeda draft terpisah
  // dari ledger).
  // ============================================================
  test('TEST 1/2 (§24/§25): DRAFT (tampilan) vs PERMANEN (Posisi Keuangan) — nilai SETIAP akun harus SAMA PERSIS, tidak boleh ada yang berubah/hilang', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.piutang, tanggal: '2026-01-01', saldo: 60_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.utang, tanggal: '2026-01-01', saldo: 20_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.simpananPokok, tanggal: '2026-01-01', saldo: 140_000_000, createdBy: 'user-1' });

    // "Tampilan" (apa yang dilihat user di layar Saldo Awal Akun).
    const tampilan = await listSaldoAwalAkun();
    const nilaiTampilan: Record<string, number> = {};
    for (const r of tampilan) nilaiTampilan[r.accountId] = r.saldo;

    // "Hasil permanen" (apa yang sungguhan dibaca laporan resmi).
    const posisi = await getPosisiKeuangan(testDb as any, '2026-01-01');
    const nilaiPermanen: Record<string, number> = {};
    for (const r of [...posisi.aset, ...posisi.liabilitas, ...posisi.ekuitas]) {
      const acc = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, r.kode);
      if (acc) nilaiPermanen[acc.id] = r.saldo;
    }

    expect(nilaiTampilan[ACC.kas]).toBe(100_000_000);
    expect(nilaiPermanen[ACC.kas]).toBe(100_000_000);
    expect(nilaiTampilan[ACC.piutang]).toBe(60_000_000);
    expect(nilaiPermanen[ACC.piutang]).toBe(60_000_000);
    expect(nilaiTampilan[ACC.utang]).toBe(20_000_000);
    expect(nilaiPermanen[ACC.utang]).toBe(20_000_000); // sama persis — tidak ada tanda yang berubah/hilang
    expect(nilaiTampilan[ACC.simpananPokok]).toBe(140_000_000);
    expect(nilaiPermanen[ACC.simpananPokok]).toBe(140_000_000);

    // §2: Posisi Keuangan BALANCE — Aset (100+60=160jt) = Liabilitas+Ekuitas (20+140=160jt).
    expect(posisi.totalAset).toBe(160_000_000);
    expect(posisi.totalLiabilitas + posisi.totalEkuitas).toBe(160_000_000);
    expect(posisi.isBalanced).toBe(true);
  });

  test('menolak saldo 0 atau negatif', async () => {
    await expect(tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 0, createdBy: 'user-1' })).rejects.toThrow(/lebih dari 0/);
  });

  // Audit ulang (permintaan pengguna, request baru §1): kategori
  // PENDAPATAN/BEBAN SEKARANG DIIZINKAN (sebelumnya ditolak) — "Saldo
  // Awal Neraca" diperluas jadi "Saldo Akun (COA)", mencakup SELURUH
  // kategori COA.
  test('menerima akun PENDAPATAN/BEBAN (diizinkan sejak request baru §1 — bukan lagi hanya akun neraca), langsung aktif seperti akun neraca lainnya', async () => {
    await seedAccount(testDb, 'acc-beban', '5-1000', 'Beban Lainnya', 'BEBAN', 'DEBIT');
    await seedAccount(testDb, 'acc-pendapatan', '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
    const beban = await tambahSaldoAwalAkun({ accountId: 'acc-beban', tanggal: '2026-01-01', saldo: 1_000_000, createdBy: 'user-1' });
    const pendapatan = await tambahSaldoAwalAkun({ accountId: 'acc-pendapatan', tanggal: '2026-01-01', saldo: 2_000_000, createdBy: 'user-1' });
    expect(beban.kategoriAkun).toBe('BEBAN');
    expect(pendapatan.kategoriAkun).toBe('PENDAPATAN');
    expect(beban.posted).toBe(true);
    expect(pendapatan.posted).toBe(true);

    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnal?.cnt).toBe(2); // masing-masing langsung membuat jurnalnya sendiri
  });

  test('masih menolak akun nonaktif dan akun yang tidak ditemukan (validasi lain TIDAK berubah)', async () => {
    await seedAccount(testDb, 'acc-nonaktif', '5-2000', 'Beban Nonaktif', 'BEBAN', 'DEBIT');
    await testDb.runAsync(`UPDATE account SET is_active = 0 WHERE id = 'acc-nonaktif'`);
    await expect(
      tambahSaldoAwalAkun({ accountId: 'acc-nonaktif', tanggal: '2026-01-01', saldo: 1_000_000, createdBy: 'user-1' })
    ).rejects.toThrow(/tidak aktif/);
    await expect(
      tambahSaldoAwalAkun({ accountId: 'acc-tidak-ada', tanggal: '2026-01-01', saldo: 1_000_000, createdBy: 'user-1' })
    ).rejects.toThrow(/tidak ditemukan/);
  });

  test('listAkunNeracaUntukSaldoAwal: SEKARANG mencakup SELURUH kategori COA aktif (ASET/LIABILITAS/EKUITAS/PENDAPATAN/BEBAN), dari COA — bukan hardcode', async () => {
    await seedAccount(testDb, 'acc-pendapatan', '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
    await seedAccount(testDb, 'acc-beban', '5-1000', 'Beban Lainnya', 'BEBAN', 'DEBIT');
    const daftar = await listAkunNeracaUntukSaldoAwal();
    // Audit ulang §1: PENDAPATAN/BEBAN SEKARANG ikut, bukan lagi dikecualikan.
    expect(daftar.find((a) => a.kode === '4-1000')).toBeDefined();
    expect(daftar.find((a) => a.kode === '5-1000')).toBeDefined();
    expect(daftar.find((a) => a.kode === '1-1000')).toBeDefined(); // Kas tetap termasuk
    // #23: RAK ikut sebagai akun neraca biasa (kategori ASET), tanpa kasus khusus.
    expect(daftar.find((a) => a.kode === '1-1800')).toBeDefined();
  });

  test('listAkunNeracaUntukSaldoAwal: tidak menyertakan akun yang nonaktif, walau kategorinya valid', async () => {
    await seedAccount(testDb, 'acc-pendapatan-nonaktif', '4-2000', 'Pendapatan Nonaktif', 'PENDAPATAN', 'KREDIT');
    await testDb.runAsync(`UPDATE account SET is_active = 0 WHERE id = 'acc-pendapatan-nonaktif'`);
    const daftar = await listAkunNeracaUntukSaldoAwal();
    expect(daftar.find((a) => a.kode === '4-2000')).toBeUndefined();
  });

  // ============================================================
  // Audit ulang (permintaan pengguna, request terbaru §2-4/§29/§34 —
  // "jangan membuat kelompok ASET/LIABILITAS/EKUITAS di dalam form
  // saldo awal"): urutan yang dikembalikan MURNI kode akun, TIDAK
  // dikelompokkan/diurutkan per kategori sama sekali — pengelompokan
  // itu HANYA boleh terjadi di laporan (getPosisiKeuangan), bukan di
  // data yang dipakai form input saldo awal ini.
  // ============================================================
  test('listAkunNeracaUntukSaldoAwal: urutan MURNI kode akun (bukan dikelompokkan per kategori) — akun EKUITAS berkode kecil bisa muncul SEBELUM akun ASET berkode besar', async () => {
    // Sengaja beri akun EKUITAS kode yang lebih KECIL dari akun ASET
    // tertentu, supaya kalau masih ada pengelompokan kategori
    // tersembunyi, urutannya akan salah (ASET selalu duluan).
    await seedAccount(testDb, 'acc-ekuitas-kode-kecil', '0-9000', 'Ekuitas Kode Kecil (uji urutan)', 'EKUITAS', 'KREDIT');
    const daftar = await listAkunNeracaUntukSaldoAwal();
    const kodes = daftar.map((a) => a.kode);
    const sorted = [...kodes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(kodes).toEqual(sorted);
    // Akun EKUITAS kode kecil harus jadi yang PALING AWAL, bukan
    // "dikelompokkan" ke bagian akhir daftar bersama akun EKUITAS lain.
    expect(daftar[0].kode).toBe('0-9000');
    expect(daftar[0].kategori).toBe('EKUITAS');
  });

  test('listSaldoAwalAkun: urutan MURNI kode akun juga (bukan kategori) — konsisten dengan listAkunNeracaUntukSaldoAwal', async () => {
    await seedAccount(testDb, 'acc-ekuitas-kode-kecil2', '0-9100', 'Ekuitas Kode Kecil 2', 'EKUITAS', 'KREDIT');
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 1_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: 'acc-ekuitas-kode-kecil2', tanggal: '2026-01-01', saldo: 500_000, createdBy: 'user-1' });

    const daftar = await listSaldoAwalAkun();
    expect(daftar[0].kodeAkun).toBe('0-9100'); // kode terkecil duluan, walau kategorinya EKUITAS bukan ASET
  });
});

describe('SaldoAwalAkunService — VALIDASI (Phase 18 §5/§20 #3-9)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('#3-6 total per kategori dihitung benar, #7 seimbang -> selisih 0', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.piutang, tanggal: '2026-01-01', saldo: 50_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.asetTetap, tanggal: '2026-01-01', saldo: 50_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.utang, tanggal: '2026-01-01', saldo: 50_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.simpananPokok, tanggal: '2026-01-01', saldo: 50_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.simpananWajib, tanggal: '2026-01-01', saldo: 50_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.cadangan, tanggal: '2026-01-01', saldo: 50_000_000, createdBy: 'user-1' });

    const v = await getValidasiSaldoAwal(testDb as any);
    expect(v.totalAset).toBe(200_000_000);
    expect(v.totalLiabilitas).toBe(50_000_000);
    expect(v.totalEkuitas).toBe(150_000_000);
    expect(v.totalLiabilitasEkuitas).toBe(200_000_000);
    expect(v.selisih).toBe(0);
    expect(v.seimbang).toBe(true);
  });

  test('#6 tidak seimbang: selisih dihitung benar & TIDAK 0', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 200_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.utang, tanggal: '2026-01-01', saldo: 50_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.simpananPokok, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });

    const v = await getValidasiSaldoAwal(testDb as any);
    expect(v.totalAset).toBe(200_000_000);
    expect(v.totalLiabilitasEkuitas).toBe(150_000_000);
    expect(v.selisih).toBe(50_000_000);
    expect(v.seimbang).toBe(false);
  });

  // ============================================================
  // Audit ulang (permintaan pengguna, request baru §1): "Saldo Awal
  // Neraca" -> "Saldo Akun (COA)" — validasi balance DIPERLUAS jadi
  // "Total Aset + Total Beban = Total Liabilitas + Total Ekuitas +
  // Total Pendapatan", supaya akun Pendapatan/Beban BISA diberi saldo
  // awal (mis. migrasi dari sistem lain di tengah tahun buku) tanpa
  // merusak properti "satu jurnal tanpa akun kliring" saat posting.
  // ============================================================
  test('akun Pendapatan/Beban TIDAK diperhitungkan sama sekali kalau tidak diisi — rumus identik dengan versi lama (totalPendapatan/totalBeban = 0)', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.simpananPokok, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });

    const v = await getValidasiSaldoAwal(testDb as any);
    expect(v.totalPendapatan).toBe(0);
    expect(v.totalBeban).toBe(0);
    expect(v.seimbang).toBe(true);
  });

  test('Pendapatan menambah sisi KREDIT, Beban menambah sisi DEBIT — kombinasi neraca + P&L yang balance harus lolos validasi', async () => {
    await seedAccount(testDb, 'acc-pendapatan', '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
    await seedAccount(testDb, 'acc-beban', '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');

    // Sisi DEBIT: Kas 100jt + Beban 20jt = 120jt.
    // Sisi KREDIT: Simpanan Pokok 100jt + Pendapatan 20jt = 120jt.
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: 'acc-beban', tanggal: '2026-01-01', saldo: 20_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.simpananPokok, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: 'acc-pendapatan', tanggal: '2026-01-01', saldo: 20_000_000, createdBy: 'user-1' });

    const v = await getValidasiSaldoAwal(testDb as any);
    expect(v.totalAset).toBe(100_000_000);
    expect(v.totalBeban).toBe(20_000_000);
    expect(v.totalEkuitas).toBe(100_000_000);
    expect(v.totalPendapatan).toBe(20_000_000);
    expect(v.selisih).toBe(0);
    expect(v.seimbang).toBe(true);
  });

  test('Pendapatan/Beban TIDAK berimbang (ada Beban tanpa lawan yang cukup) -> seimbang=false, selisih benar', async () => {
    await seedAccount(testDb, 'acc-beban', '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.simpananPokok, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: 'acc-beban', tanggal: '2026-01-01', saldo: 5_000_000, createdBy: 'user-1' });

    const v = await getValidasiSaldoAwal(testDb as any);
    expect(v.totalBeban).toBe(5_000_000);
    expect(v.selisih).toBe(5_000_000); // sisi debit (aset+beban) lebih besar 5jt dari sisi kredit
    expect(v.seimbang).toBe(false);
  });

  test('kombinasi neraca + P&L yang balance -> postingSaldoAwal (jalur LEGACY batch) BERHASIL untuk baris draft peninggalan, satu jurnal, TANPA akun kliring apa pun', async () => {
    await seedAccount(testDb, 'acc-pendapatan', '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
    await seedAccount(testDb, 'acc-beban', '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');
    // Audit ulang (request FINAL): postingSaldoAwal() SEKARANG murni
    // jalur LEGACY (hanya memproses baris journal_id NULL) — disimulasikan
    // lewat seedLegacyDraftRow, BUKAN tambahSaldoAwalAkun (yang sejak
    // perubahan FINAL selalu langsung posting sendiri per baris).
    await seedLegacyDraftRow(testDb, ACC.kas, 100_000_000);
    await seedLegacyDraftRow(testDb, 'acc-beban', 20_000_000);
    await seedLegacyDraftRow(testDb, ACC.simpananPokok, 100_000_000);
    await seedLegacyDraftRow(testDb, 'acc-pendapatan', 20_000_000);

    const { journalId } = await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });
    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    expect(entries).toHaveLength(4); // Kas, Beban, Simpanan Pokok, Pendapatan — tanpa baris kliring tambahan
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(120_000_000);
  });

  test('#8/#9 tidak seimbang -> postingSaldoAwal (jalur LEGACY) DITOLAK, TIDAK ADA jurnal dibuat', async () => {
    await seedLegacyDraftRow(testDb, ACC.kas, 200_000_000);
    await seedLegacyDraftRow(testDb, ACC.utang, 50_000_000);
    await seedLegacyDraftRow(testDb, ACC.simpananPokok, 100_000_000);

    await expect(postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' })).rejects.toThrow(/tidak seimbang/i);

    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnal?.cnt).toBe(0);
    // Baris draft tetap draft, TIDAK ADA yang jadi POSTED.
    const daftar = await listSaldoAwalAkun();
    expect(daftar.every((r) => !r.posted)).toBe(true);
  });
});

describe('SaldoAwalAkunService — POSTING BATCH LEGACY (Phase 18 §8/§20 #10-15, #17-25; audit ulang request FINAL: fungsi ini sekarang HANYA memproses baris draft peninggalan journal_id NULL, TIDAK dipanggil lagi dari alur utama)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  async function isiSaldoAwalSeimbangLegacy() {
    await seedLegacyDraftRow(testDb, ACC.kas, 100_000_000);
    await seedLegacyDraftRow(testDb, ACC.piutang, 50_000_000);
    await seedLegacyDraftRow(testDb, ACC.asetTetap, 50_000_000);
    await seedLegacyDraftRow(testDb, ACC.utang, 50_000_000);
    await seedLegacyDraftRow(testDb, ACC.simpananPokok, 50_000_000);
    await seedLegacyDraftRow(testDb, ACC.simpananWajib, 50_000_000);
    await seedLegacyDraftRow(testDb, ACC.cadangan, 50_000_000);
  }

  test('#10/#11/#12/#13 seimbang -> posting berhasil, SATU jurnal, total debit=kredit, lewat AccountingEngine, tercatat di ledger', async () => {
    await isiSaldoAwalSeimbangLegacy();
    const { journalId } = await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    expect(journalId).toBeTruthy();
    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnal?.cnt).toBe(1); // #10/#11: SATU jurnal untuk seluruh batch

    const totals = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(kredit),0) as k FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    expect(totals?.d).toBe(totals?.k); // #11 total debit = total kredit

    // #13: tercatat di ledger (bisa dibaca via saldo per akun).
    expect(await saldoAkun(ACC.kas)).toBe(100_000_000);
    expect(await saldoAkun(ACC.utang)).toBe(-50_000_000);

    // #18: TIDAK ADA baris yang menyentuh Ekuitas Lainnya.
    expect(await saldoAkun(ACC.ekuitasLainnya)).toBe(0);
  });

  test('#14 audit log tercatat: VALIDATE, POST_OPENING_BALANCE', async () => {
    await isiSaldoAwalSeimbangLegacy();
    await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    const actions = await testDb.getAllAsync<{ action: string }>(`SELECT action FROM audit_log ORDER BY created_at ASC`);
    const actionNames = actions.map((a) => a.action);
    expect(actionNames).toContain('VALIDATE_OPENING_BALANCE');
    expect(actionNames).toContain('POST_OPENING_BALANCE');
  });

  test('#15/#16 status POSTED setelah posting; edit/hapus draft langsung DITOLAK (harus lewat koreksi)', async () => {
    await isiSaldoAwalSeimbangLegacy();
    await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    const ringkasan = await getRingkasanSaldoAwal();
    expect(ringkasan.status).toBe('POSTED');
    expect(ringkasan.rows.every((r) => r.posted)).toBe(true);

    const kasRow = ringkasan.rows.find((r) => r.accountId === ACC.kas)!;
    await expect(
      editSaldoAwalAkun({ id: kasRow.id, accountId: ACC.kas, tanggal: '2026-01-01', saldo: 999_000_000, updatedBy: 'user-1' })
    ).rejects.toThrow(/sudah diposting/);
    // Audit ulang (request FINAL §17): hapus baris yang SUDAH posted
    // SEKARANG BERHASIL lewat reversal (bukan ditolak) — cocokkan
    // dengan perilaku baru `hapusSaldoAwalAkun()`, sudah dites lengkap
    // di describe block "SIMPAN langsung aktif" di atas. Di sini cukup
    // pastikan TIDAK melempar error & benar-benar mereversal.
    await expect(hapusSaldoAwalAkun(kasRow.id, 'user-1')).resolves.toBeUndefined();
    expect(await saldoAkun(ACC.kas)).toBe(0);
  });

  test('#17 posting saldo awal TIDAK menutup periode akuntansi — transaksi baru di Januari 2026 tetap bisa masuk', async () => {
    await isiSaldoAwalSeimbangLegacy();
    await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    const period = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM accounting_period WHERE id = 'period-2026'`);
    expect(period?.status).toBe('OPEN'); // tidak berubah jadi CLOSED

    // Transaksi normal baru tetap bisa masuk (regresi §27).
    await expect(
      createJournal(testDb as any, {
        tanggal: '2026-01-15',
        sumberTransaksi: 'MODAL_UANG',
        deskripsi: 'Transaksi normal setelah saldo awal',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
          { accountId: ACC.ekuitasLainnya, debit: 0, kredit: 1_000_000 },
        ],
      })
    ).resolves.toBeDefined();
  });

  test('#19/#20/#21/#22 Cadangan/Simpanan Pokok/Simpanan Wajib/Liabilitas tetap masuk akun masing-masing, TIDAK dilebur ke Ekuitas Lainnya', async () => {
    await isiSaldoAwalSeimbangLegacy();
    await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    expect(await saldoAkun(ACC.cadangan)).toBe(-50_000_000);
    expect(await saldoAkun(ACC.simpananPokok)).toBe(-50_000_000);
    expect(await saldoAkun(ACC.simpananWajib)).toBe(-50_000_000);
    expect(await saldoAkun(ACC.utang)).toBe(-50_000_000);
    expect(await saldoAkun(ACC.ekuitasLainnya)).toBe(0);
  });

  test('#23 RAK diproses sebagai akun neraca ASET biasa, ikut tervalidasi & terposting dengan benar', async () => {
    await seedLegacyDraftRow(testDb, ACC.rak, 20_000_000);
    await seedLegacyDraftRow(testDb, ACC.cadangan, 20_000_000);

    const v = await getValidasiSaldoAwal(testDb as any);
    expect(v.totalAset).toBe(20_000_000);
    expect(v.seimbang).toBe(true);

    await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });
    expect(await saldoAkun(ACC.rak)).toBe(20_000_000);
  });

  test('#24 opening balance tidak membuat saldo palsu — jumlah baris jurnal = jumlah akun draft, tidak lebih tidak kurang', async () => {
    await isiSaldoAwalSeimbangLegacy();
    const { journalId } = await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    const jumlahBaris = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal_entry WHERE journal_id = ?`, journalId);
    expect(jumlahBaris?.cnt).toBe(7); // persis 7 akun yang diisi, tidak ada baris tambahan/kliring
  });

  test('#25 Posisi Keuangan setelah posting balance (Total Aset = Total Liabilitas + Ekuitas)', async () => {
    await isiSaldoAwalSeimbangLegacy();
    await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    const posisi = await getPosisiKeuangan(testDb as any, '2026-01-01');
    expect(posisi.isBalanced).toBe(true);
    expect(posisi.selisih).toBe(0);
    expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);
  });

  test('posting kosong (tidak ada draft legacy sama sekali) ditolak dengan pesan jelas', async () => {
    await expect(postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' })).rejects.toThrow(/belum ada saldo awal/i);
  });

  // Audit ulang (permintaan pengguna, request FINAL): SEKARANG
  // `postingSaldoAwal()` TIDAK LAGI punya guard global "sudah pernah
  // diposting" (fungsi itu dihapus — lihat komentar di service) —
  // pemanggilan kedua kali murni gagal karena TIDAK ADA lagi baris
  // journal_id NULL yang tersisa untuk diproses (batch pertama sudah
  // menghabiskannya), BUKAN karena ditolak status "sudah diposting".
  test('posting kedua kalinya (setelah batch pertama sudah posted, tidak ada draft legacy tersisa) ditolak — pesan "belum ada saldo awal"', async () => {
    await isiSaldoAwalSeimbangLegacy();
    await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    await expect(postingSaldoAwal({ tanggal: '2026-02-01', actingUserId: 'user-1' })).rejects.toThrow(/belum ada saldo awal/i);
  });
});

describe('SaldoAwalAkunService — KOREKSI (Phase 18 §11/§13)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
    // Audit ulang (request FINAL): tambahSaldoAwalAkun() SEKARANG
    // langsung memposting — TIDAK perlu lagi postingSaldoAwal() batch
    // terpisah setelahnya (memanggilnya justru akan gagal, karena
    // sudah tidak ada baris draft journal_id NULL tersisa).
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.cadangan, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
  });

  test('koreksiSaldoAwal: TIDAK mengedit jurnal lama, memposting jurnal koreksi baru lewat akun kliring 3-5000', async () => {
    const jurnalSebelum = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    const { journalId } = await koreksiSaldoAwal({
      accountId: ACC.kas,
      saldoBaru: 120_000_000,
      alasan: 'Salah hitung saldo bank saat input awal',
      actingUserId: 'user-1',
    });
    const jurnalSesudah = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);

    expect(jurnalSesudah!.cnt).toBe(jurnalSebelum!.cnt + 1); // jurnal BARU ditambahkan, bukan mengedit yang lama
    expect(await saldoAkun(ACC.kas)).toBe(120_000_000);
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(-20_000_000); // kliring menampung selisih sementara

    // saldo_awal_akun ikut terupdate untuk tampilan.
    const daftar = await listSaldoAwalAkun();
    expect(daftar.find((r) => r.accountId === ACC.kas)?.saldo).toBe(120_000_000);

    // Audit log CORRECT_OPENING_BALANCE tercatat.
    const log = await testDb.getFirstAsync<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'CORRECT_OPENING_BALANCE'`);
    expect(log).not.toBeNull();
    expect(journalId).toBeTruthy();
  });

  test('koreksiSaldoAwal: bisa dipakai bahkan SETELAH dikunci permanen (LOCKED) — berbeda dari edit draft biasa', async () => {
    await kunciSaldoAwalPermanen('user-1');

    await expect(
      koreksiSaldoAwal({ accountId: ACC.kas, saldoBaru: 150_000_000, alasan: 'Koreksi setelah lock', actingUserId: 'user-1' })
    ).resolves.toBeDefined();
    expect(await saldoAkun(ACC.kas)).toBe(150_000_000);
  });

  test('koreksiSaldoAwal: alasan wajib diisi', async () => {
    await expect(
      koreksiSaldoAwal({ accountId: ACC.kas, saldoBaru: 120_000_000, alasan: '  ', actingUserId: 'user-1' })
    ).rejects.toThrow(/alasan/i);
  });

  test('koreksiSaldoAwal: DITOLAK untuk akun yang belum pernah diposting sama sekali', async () => {
    await expect(
      koreksiSaldoAwal({ accountId: ACC.utang, saldoBaru: 10_000_000, alasan: 'Test', actingUserId: 'user-1' })
    ).rejects.toThrow(/belum pernah dicatat/);
  });

  test('koreksi dua akun berpasangan mengembalikan saldo kliring ke Rp0', async () => {
    await koreksiSaldoAwal({ accountId: ACC.kas, saldoBaru: 120_000_000, alasan: 'Naik 20jt', actingUserId: 'user-1' });
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(-20_000_000);

    await koreksiSaldoAwal({ accountId: ACC.cadangan, saldoBaru: 120_000_000, alasan: 'Naik 20jt juga, pasangan koreksi kas', actingUserId: 'user-1' });
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(0);
  });
});

describe('SaldoAwalAkunService — Legacy detection (Phase 18 §17/§23)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('#26 data legacy (jurnal individual lama per akun) tetap terbaca, terdeteksi sebagai legacy', async () => {
    // Simulasikan data LAMA: dua baris saldo_awal_akun dengan journal_id BERBEDA (satu jurnal per akun, pola sebelum refactor).
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-legacy-1','JRN-L1','2025-01-01','period-2026','SALDO_AWAL_AKUN','Saldo awal Kas (legacy)','POSTED','user-1',?,?,?)`,
      now, now, now
    );
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-l1','journal-legacy-1',?,10000000,0)`, ACC.kas);
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-l2','journal-legacy-1',?,0,10000000)`, ACC.ekuitasLainnya);
    await testDb.runAsync(
      `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at)
       VALUES ('saw-legacy-1',?,'2025-01-01',10000000,'journal-legacy-1','user-1',?,?)`,
      ACC.kas, now, now
    );

    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-legacy-2','JRN-L2','2025-01-01','period-2026','SALDO_AWAL_AKUN','Saldo awal Cadangan (legacy)','POSTED','user-1',?,?,?)`,
      now, now, now
    );
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-l3','journal-legacy-2',?,0,5000000)`, ACC.cadangan);
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-l4','journal-legacy-2',?,5000000,0)`, ACC.ekuitasLainnya);
    await testDb.runAsync(
      `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at)
       VALUES ('saw-legacy-2',?,'2025-01-01',5000000,'journal-legacy-2','user-1',?,?)`,
      ACC.cadangan, now, now
    );

    // Data legacy tetap terbaca normal.
    const daftar = await listSaldoAwalAkun();
    expect(daftar).toHaveLength(2);
    expect(daftar.find((r) => r.accountId === ACC.kas)?.saldo).toBe(10_000_000);

    // Terdeteksi sebagai legacy (2 journal_id berbeda, bukan 1 batch bersama).
    const legacy = await getLegacyOpeningBalanceInfo();
    expect(legacy.isLegacy).toBe(true);
    expect(legacy.jumlahJurnalTerpisah).toBe(2);

    // Ledger historisnya TIDAK diubah — saldo Ekuitas Lainnya legacy tetap seperti apa adanya.
    // Bug fix (test): nilai yang diharapkan sebelumnya (-15_000_000)
    // salah hitung. Dari data yang di-insert di atas: je-l2 (journal
    // legacy-1) KREDIT 10.000.000 ke ekuitasLainnya, je-l4 (journal
    // legacy-2) DEBIT 5.000.000 ke ekuitasLainnya. `saldoAkun()`
    // menghitung SUM(debit) - SUM(kredit) = 5.000.000 - 10.000.000 =
    // -5.000.000 — angka inilah yang benar-benar dihasilkan dari baris
    // yang di-seed di atas.
    expect(await saldoAkun(ACC.ekuitasLainnya)).toBe(-5_000_000);
  });

  // Audit ulang (bug ditemukan lewat sesi ini, request FINAL): heuristik
  // LAMA ("banyak journal_id berbeda = legacy") sudah TIDAK VALID sejak
  // SETIAP baris SELALU membuat jurnalnya sendiri-sendiri (bukan lagi
  // batch) — test ini DIGANTI untuk membuktikan heuristik BARU (cek
  // akun "Ekuitas Lainnya" 3-3000 spesifik) bekerja benar.
  test('pemakaian NORMAL (tambahSaldoAwalAkun instan, kontra akun kliring 3-5000) TIDAK terdeteksi sebagai legacy — walau setiap baris punya journal_id BERBEDA', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.cadangan, tanggal: '2026-01-01', saldo: 100_000_000, createdBy: 'user-1' });

    const legacy = await getLegacyOpeningBalanceInfo();
    expect(legacy.isLegacy).toBe(false); // TIDAK menyentuh Ekuitas Lainnya sama sekali, walau journal_id-nya 2 (berbeda)
    expect(legacy.jumlahJurnalTerpisah).toBe(2);
  });

  test('batch LEGACY (postingSaldoAwal, satu journal_id bersama, TANPA Ekuitas Lainnya) TIDAK terdeteksi sebagai legacy — mekanisme batch juga bersih dari 3-3000', async () => {
    await seedLegacyDraftRow(testDb, ACC.kas, 100_000_000);
    await seedLegacyDraftRow(testDb, ACC.cadangan, 100_000_000);
    await postingSaldoAwal({ tanggal: '2026-01-01', actingUserId: 'user-1' });

    const legacy = await getLegacyOpeningBalanceInfo();
    expect(legacy.isLegacy).toBe(false);
    expect(legacy.jumlahJurnalTerpisah).toBe(1);
  });
});

describe('Phase 18 §21 -> audit ulang request FINAL §10/§11 — TEST KHUSUS: kasus selisih Rp129.000.000', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  // Audit ulang (request FINAL): skenario ini SEBELUMNYA menguji bahwa
  // BATCH POSTING ditolak kalau tidak seimbang. Sejak arsitektur baru
  // (setiap baris langsung aktif seketika, TIDAK ADA lagi gerbang
  // batch), premis "posting ditolak" sudah tidak berlaku untuk alur
  // utama — SETIAP baris di bawah BERHASIL disimpan satu per satu,
  // TEPAT sesuai §6/§10: "SEMUA harus langsung aktif... Tidak ada
  // warning balance di form... laporan yang menunjukkan keadaan
  // sebenarnya." Test ini SEKARANG membuktikan hal itu — DAN
  // membuktikan selisih 129jt tetap terlihat jelas (via
  // getValidasiSaldoAwal DAN via saldo akun kliring, dua sumber
  // independen yang harus sama persis), BUKAN disembunyikan/dibuat
  // seolah balance.
  test('Total Aset 3.575.983.750 vs Liabilitas+Ekuitas 3.704.983.750 (selisih 129jt): SEMUA baris BERHASIL disimpan & langsung aktif, selisih TETAP TERLIHAT (§9/§10), TIDAK ADA balancing palsu (§11)', async () => {
    // Aset: Kas + Piutang + Aset Tetap = 3.575.983.750
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 1_575_983_750, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.piutang, tanggal: '2026-01-01', saldo: 1_500_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.asetTetap, tanggal: '2026-01-01', saldo: 500_000_000, createdBy: 'user-1' });

    // Liabilitas: 326.499.003
    await tambahSaldoAwalAkun({ accountId: ACC.utang, tanggal: '2026-01-01', saldo: 326_499_003, createdBy: 'user-1' });

    // Ekuitas: 3.378.484.747 (Simpanan Pokok + Simpanan Wajib + Cadangan)
    await tambahSaldoAwalAkun({ accountId: ACC.simpananPokok, tanggal: '2026-01-01', saldo: 1_378_484_747, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.simpananWajib, tanggal: '2026-01-01', saldo: 1_000_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.cadangan, tanggal: '2026-01-01', saldo: 1_000_000_000, createdBy: 'user-1' });

    // §6/§10: SEMUA baris BERHASIL — tidak ada yang ditolak karena "belum seimbang".
    // Bug fix (test): assertion sebelumnya toHaveLength(6) salah hitung
    // — ada 7 pemanggilan tambahSaldoAwalAkun() di atas (Kas, Piutang,
    // Aset Tetap, Utang, Simpanan Pokok, Simpanan Wajib, Cadangan).
    const daftar = await listSaldoAwalAkun();
    expect(daftar).toHaveLength(7);
    expect(daftar.every((r) => r.posted)).toBe(true);

    const v = await getValidasiSaldoAwal(testDb as any);
    expect(v.totalAset).toBe(3_575_983_750);
    expect(v.totalLiabilitas).toBe(326_499_003);
    expect(v.totalEkuitas).toBe(3_378_484_747);
    expect(v.totalLiabilitasEkuitas).toBe(3_704_983_750);
    expect(v.selisih).toBe(-129_000_000); // Aset - (Liab+Ekuitas) = 3.575.983.750 - 3.704.983.750
    expect(v.seimbang).toBe(false); // §9: laporan HARUS tetap menunjukkan belum seimbang

    // §11: TIDAK ADA yang masuk ke Ekuitas Lainnya/SHU untuk menutupi
    // selisih — akun ASET/LIABILITAS/EKUITAS asli persis sesuai input.
    expect(await saldoAkun(ACC.ekuitasLainnya)).toBe(0);
    expect(await saldoAkun(ACC.kas)).toBe(1_575_983_750);
    expect(await saldoAkun(ACC.cadangan)).toBe(-1_000_000_000);

    // §9/§10: selisih TETAP TERLIHAT — kali ini lewat akun kliring
    // "Saldo Awal Belum Sesuai" (bukan disembunyikan): saldonya PERSIS
    // berlawanan tanda dengan v.selisih di atas (kliring menampung sisi
    // KREDIT untuk tiap baris ASET & sisi DEBIT untuk tiap baris
    // LIABILITAS/EKUITAS — jadi saldo debit-kredit kliring = (Liab+Ekuitas)
    // - Aset = -v.selisih), dua cara hitung independen yang harus
    // konsisten satu sama lain.
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(-v.selisih);
    expect(await saldoAkun(ACC.kliringKoreksi)).toBe(129_000_000);
  });
});

describe('getAsetTetapAccountInfo (tidak berubah dari sebelumnya)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('mengembalikan akun ASET_TETAP yang sudah dipetakan', async () => {
    await seedMapping(testDb, 'ASET_TETAP', 'DEBIT_ASET', ACC.asetTetap);
    const info = await getAsetTetapAccountInfo();
    expect(info?.kodeAkun).toBe('1-1500');
  });

  test('mengembalikan null (bukan error) kalau mapping belum ada', async () => {
    expect(await getAsetTetapAccountInfo()).toBeNull();
  });
});

describe('Saldo Awal — kunci permanen (tidak berubah semantiknya, hanya dites ulang di alur baru)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('getSaldoAwalLockInfo: null kalau belum dikunci', async () => {
    expect(await getSaldoAwalLockInfo()).toBeNull();
  });

  test('kunciSaldoAwalPermanen: DITOLAK kalau sudah pernah dikunci (tidak ada unlock)', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 5_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.cadangan, tanggal: '2026-01-01', saldo: 5_000_000, createdBy: 'user-1' });
    await kunciSaldoAwalPermanen('user-1');

    await expect(kunciSaldoAwalPermanen('user-1')).rejects.toThrow(/sudah dikunci permanen sebelumnya/);
  });

  test('status ringkasan menjadi LOCKED setelah dikunci', async () => {
    await tambahSaldoAwalAkun({ accountId: ACC.kas, tanggal: '2026-01-01', saldo: 5_000_000, createdBy: 'user-1' });
    await tambahSaldoAwalAkun({ accountId: ACC.cadangan, tanggal: '2026-01-01', saldo: 5_000_000, createdBy: 'user-1' });
    await kunciSaldoAwalPermanen('user-1');

    const ringkasan = await getRingkasanSaldoAwal();
    expect(ringkasan.status).toBe('LOCKED');
  });
});
