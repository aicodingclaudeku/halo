import { createTestDb, TestDb } from './testDb';
import { readFileSync } from 'fs';
import { join } from 'path';

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
  prosesAkrualBungaUtangOtomatis,
  jalankanAkrualBungaUtangJikaPerlu,
  _resetGerbangAkrualUntukTest,
} from '@/services/UtangBungaAccrualService';
import {
  terimaUtang,
  bayarUtang,
  penyesuaianManualBungaUtang,
  getKontrolGapUtangBunga,
  getKontrolGapUtangBungaAsOf,
} from '@/services/UtangService';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { jalankanGerbangAkrualBungaUtang } from '@/services/PeriodCloseService';
import { _resetTugasStartupUntukTest } from '@/services/StartupTasks';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * RC-S58.1 — GAP UTANG BUNGA BERCAKUPAN PERIODE.
 *
 * Tutup periode memutuskan berdasarkan posisi PER AKHIR PERIODE yang ditutup
 * (`getKontrolGapUtangBungaAsOf(periodeSelesai)`), bukan kontrol global.
 * Kontrol global tetap ada untuk diagnostik aplikasi.
 */

const ROOT = join(__dirname, '..', '..');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ACC = { kas: 'acc-kas', utangBank: 'acc-2-2100', utangBunga: 'acc-2-1700', bebanBunga: 'acc-5-1950', modal: 'acc-3-1000' };

async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: string) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${tt}-${role}`, tt, role, accountId);
}

beforeEach(async () => {
  _resetGerbangAkrualUntukTest();
  _resetTugasStartupUntukTest();
  testDb = await createTestDb();
  const now = new Date().toISOString();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping('UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping('UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping('UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);
  for (const th of [2024, 2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES ('j-awal','JRN-SEED','2024-12-31','p2024','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,500000000,0,0)`, ACC.kas);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,500000000,1)`, ACC.modal);
});
afterEach(() => testDb.closeSync());

/** 120.000.000 × 12%/tahun FLAT = 1.200.000 per bulan. */
async function buatUtang(tanggal: string, nama = 'Bank ABC'): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: nama,
    jenisPemberi: 'BANK',
    pokokPinjaman: 120_000_000,
    persenBunga: 12,
    jenisBunga: 'FLAT',
    basisBunga: 'TAHUNAN',
    tanggal,
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return r.id;
}

const proses = (tanggalSekarang: string) => prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang });
const gerbang = (tahun: number, tanggalSekarang: string) =>
  jalankanGerbangAkrualBungaUtang({ periodeMulai: `${tahun}-01-01`, periodeSelesai: `${tahun}-12-31`, createdBy: 'user-1', tanggalSekarang });

/** Balikkan jurnal akrual pada tanggal tertentu (reverseJournal memberi tanggal hari ini; digeser untuk skenario lintas periode). */
async function balikkanAkrual(utangId: string, tanggalAkrual: string, tanggalReversal: string): Promise<string> {
  const j = await testDb.getFirstAsync<{ id: string }>(
    `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND tanggal=? AND reversal_of_id IS NULL`,
    utangId,
    tanggalAkrual
  );
  const r = await reverseJournal(testDb as any, j!.id, 'user-1', 'Koreksi');
  await testDb.runAsync(`UPDATE journal SET tanggal = ? WHERE id = ?`, tanggalReversal, r.journalId);
  return r.journalId;
}

/**
 * Data warisan yang menimbulkan GAP: mutasi 2-1700 tanpa atribusi utang
 * (mis. pengeluaran kas langsung ke akun Utang Bunga sebelum RC-S54 Fix C).
 * Disisipkan langsung karena jalur aplikasi sekarang menolaknya.
 */
async function sisipkanMutasiYatim(id: string, tanggal: string, kredit: number) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES (?,?,?,?, 'KAS_UMUM','Mutasi warisan','POSTED','user-1',?,?,?)`,
    id, `JRN-${id}`, tanggal, `p${tanggal.slice(0, 4)}`, now, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES (?,?,?,?,0,0)`, `${id}-d`, id, ACC.kas, kredit);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES (?,?,?,0,?,1)`, `${id}-k`, id, ACC.utangBunga, kredit);
}

/** Ringkasan kontrol untuk pembandingan eksak (tanpa toMatchObject, yang tidak dikenal shim tipe rcs53). */
const posisi = (k: { status: string; expected: number; actual: number; gap: number }) => ({ status: k.status, expected: k.expected, actual: k.actual, gap: k.gap });

const kodePenghalang = (g: { penghalang: readonly { kode: string }[] }) => g.penghalang.map((p) => p.kode);

// ===========================================================================

describe('RC-S58.1 kontrol GAP as-of', () => {
  it('1. akrual 2025 saja: per 31-12-2025 Utang Bunga 1.200.000, BALANCED; tutup 2025 lolos', async () => {
    await buatUtang('2025-12-01');
    await proses('2026-01-05');
    const k = await getKontrolGapUtangBungaAsOf('2025-12-31');
    expect(k.asOfDate).toBe('2025-12-31');
    expect(posisi(k)).toEqual({ status: 'BALANCED', expected: 1_200_000, actual: 1_200_000, gap: 0 });
    const g = await gerbang(2025, '2026-01-05');
    expect(g.penghalang).toEqual([]);
    expect(g.outstandingUtangBunga).toBe(1_200_000);
  });

  it('2. akrual 2025 + pembayaran 15-01-2026: tutup 2025 melihat 1.200.000, tutup 2026 melihat 0', async () => {
    const id = await buatUtang('2025-12-01');
    await proses('2026-01-05');
    await bayarUtang({ utangId: id, tanggal: '2026-01-15', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const k2025 = await getKontrolGapUtangBungaAsOf('2025-12-31');
    const k2026 = await getKontrolGapUtangBungaAsOf('2026-12-31');
    expect(posisi(k2025)).toEqual({ status: 'BALANCED', expected: 1_200_000, actual: 1_200_000, gap: 0 });
    expect(posisi(k2026)).toEqual({ status: 'BALANCED', expected: 0, actual: 0, gap: 0 });
    const g = await gerbang(2025, '2026-01-20');
    expect(g.penghalang).toEqual([]);
    expect(g.outstandingUtangBunga).toBe(1_200_000);
  });

  it('3. akrual 2025 + reversal 05-01-2026: per 2025 akrual masih aktif (tutup 2025 lolos), per 2026 sudah dibalik', async () => {
    const id = await buatUtang('2025-12-01');
    await proses('2026-01-05');
    await balikkanAkrual(id, '2025-12-31', '2026-01-05');
    const k2025 = await getKontrolGapUtangBungaAsOf('2025-12-31');
    const k2026 = await getKontrolGapUtangBungaAsOf('2026-01-31');
    expect(posisi(k2025)).toEqual({ status: 'BALANCED', expected: 1_200_000, actual: 1_200_000, gap: 0 });
    expect(posisi(k2026)).toEqual({ status: 'BALANCED', expected: 0, actual: 0, gap: 0 });
    // Mesin tetap melapor AKRUAL_DIREVERSAL (semantik RC-S56 tidak berubah)…
    const h = await proses('2026-01-06');
    expect(h.exception.map((e) => `${e.kode}:${e.periode}`)).toContain('AKRUAL_DIREVERSAL:2025-12');
    // …tetapi reversal 2026 belum ada per 31-12-2025, jadi tidak memblokir tutup 2025.
    const g = await gerbang(2025, '2026-01-06');
    expect(g.penghalang).toEqual([]);
  });

  it('3b. reversal DI DALAM periode yang ditutup tetap memblokir', async () => {
    const id = await buatUtang('2025-11-01');
    await proses('2026-01-05');
    await balikkanAkrual(id, '2025-11-30', '2025-12-15');
    const g = await gerbang(2025, '2026-01-06');
    expect(g.penghalang.map((p) => `${p.kode}:${p.periode}`)).toContain('AKRUAL_DIREVERSAL:2025-11');
  });

  it('4. 2025 BALANCED + GAP 2026: tutup 2025 lolos; tutup 2026 diblokir; diagnostik global tetap GAP', async () => {
    await buatUtang('2025-12-01');
    await proses('2026-01-05');
    await sisipkanMutasiYatim('yatim-2026', '2026-03-10', 250_000);
    expect((await getKontrolGapUtangBungaAsOf('2025-12-31')).status).toBe('BALANCED');
    expect((await gerbang(2025, '2026-03-15')).penghalang).toEqual([]);
    const g2026 = await gerbang(2026, '2027-01-05');
    expect(kodePenghalang(g2026)).toContain('REKONSILIASI_UTANG_BUNGA_GAP');
    expect(g2026.statusRekonsiliasi).toBe('GAP');
    const global = await getKontrolGapUtangBunga();
    expect(global.status).toBe('GAP');
    expect(global.temuan.map((t) => t.kode)).toContain('JURNAL_TANPA_SUBLEDGER');
  });

  it('5. GAP 2025 + 2026 BALANCED (dikoreksi 2026): tutup 2025 diblokir; tutup 2026 lolos', async () => {
    await buatUtang('2025-12-01');
    await sisipkanMutasiYatim('yatim-2025', '2025-06-10', 250_000);
    await proses('2026-01-05');
    const g2025 = await gerbang(2025, '2026-01-05');
    expect(kodePenghalang(g2025)).toEqual(['REKONSILIASI_UTANG_BUNGA_GAP']);
    expect(g2025.penghalang[0].pesan).toMatch(/Per 2025-12-31/);
    // Koreksi sah pada 2026: reversal mutasi warisan.
    const r = await reverseJournal(testDb as any, 'yatim-2025', 'user-1', 'Koreksi mutasi warisan');
    await testDb.runAsync(`UPDATE journal SET tanggal = '2026-02-01' WHERE id = ?`, r.journalId);
    expect((await getKontrolGapUtangBungaAsOf('2025-12-31')).status).toBe('GAP'); // 2025 tetap tidak berubah
    expect((await getKontrolGapUtangBungaAsOf('2026-12-31')).status).toBe('BALANCED');
    const g2026 = await gerbang(2026, '2027-01-05');
    expect(kodePenghalang(g2026)).not.toContain('REKONSILIASI_UTANG_BUNGA_GAP');
  });

  it('6. beberapa utang berbeda periode: GAP utang 2026 tidak memblokir 2025 dan disebut namanya saat menutup 2026', async () => {
    await buatUtang('2025-12-01', 'Bank A');
    const b = await buatUtang('2026-03-01', 'Bank B');
    await proses('2026-07-05');
    // Subledger pembayaran bunga B tanpa jurnal (pola data warisan) -> GAP milik B per 2026.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO utang_pembayaran (id, utang_id, tanggal, pokok, bunga, sumber_dana, nomor_transaksi, journal_id, created_by, created_at)
       VALUES ('bayar-yatim', ?, '2026-06-10', 0, 500000, 'KAS', 'BYU-WARISAN-1', NULL, 'user-1', ?)`,
      b, now
    );
    const k2025 = await getKontrolGapUtangBungaAsOf('2025-12-31');
    expect(k2025.status).toBe('BALANCED');
    expect(k2025.expected).toBe(1_200_000);
    expect((await gerbang(2025, '2026-07-05')).penghalang).toEqual([]);
    const k2026 = await getKontrolGapUtangBungaAsOf('2026-12-31');
    expect(k2026.status).toBe('GAP');
    const nomorB = (await testDb.getFirstAsync<{ n: string }>(`SELECT nomor_utang AS n FROM utang WHERE id = ?`, b))!.n;
    expect(new Set(k2026.temuan.map((t) => t.nomorUtang))).toEqual(new Set([nomorB]));
  });

  it('7. penyesuaian lintas periode: pengganti akrual Des-2025 dibukukan Jan-2026 — tidak mengubah posisi 2025', async () => {
    const id = await buatUtang('2025-12-01');
    await proses('2026-01-05');
    await balikkanAkrual(id, '2025-12-31', '2026-01-05');
    const adj = await penyesuaianManualBungaUtang({
      utangId: id,
      tanggal: '2026-01-10',
      nominalTarget: 1_200_000,
      alasan: 'Pengganti akrual Desember setelah koreksi kontrak',
      createdBy: 'user-1',
    });
    expect(adj.dibukukanSekarang).toBe(1_200_000);
    expect(posisi(await getKontrolGapUtangBungaAsOf('2025-12-31'))).toEqual({ status: 'BALANCED', expected: 1_200_000, actual: 1_200_000, gap: 0 });
    expect(posisi(await getKontrolGapUtangBungaAsOf('2026-01-09'))).toEqual({ status: 'BALANCED', expected: 0, actual: 0, gap: 0 });
    expect(posisi(await getKontrolGapUtangBungaAsOf('2026-01-31'))).toEqual({ status: 'BALANCED', expected: 1_200_000, actual: 1_200_000, gap: 0 });
  });

  it('8. diagnostik global tetap mendeteksi GAP di periode mana pun', async () => {
    await buatUtang('2025-12-01');
    await proses('2026-01-05');
    await sisipkanMutasiYatim('yatim-2027', '2027-02-01', 99_000);
    const global = await getKontrolGapUtangBunga();
    expect(global.status).toBe('GAP');
    expect(global.gap).toBe(99_000);
    expect((await getKontrolGapUtangBungaAsOf('2026-12-31')).status).toBe('BALANCED');
  });
});

describe('RC-S58.1 PeriodClose memakai kontrol as-of', () => {
  it('9. gerbang memanggil kontrol AS-OF dengan periodeSelesai, bukan kontrol global dan bukan tanggal hari ini', () => {
    const s = tanpaKomentar(readFileSync(join(ROOT, 'src/services/PeriodCloseService.ts'), 'utf8'));
    expect(s).toMatch(/await getKontrolGapUtangBungaAsOf\(params\.periodeSelesai\)/);
    expect(s).not.toMatch(/getKontrolGapUtangBunga\(/);
    expect(s).not.toMatch(/getKontrolGapUtangBungaAsOf\(tanggalSekarang/);
  });

  it('9b. fungsi global tidak berubah perilakunya: seluruh waktu, tanpa filter tanggal', () => {
    const u = tanpaKomentar(readFileSync(join(ROOT, 'src/services/UtangService.ts'), 'utf8'));
    const global = u.slice(u.indexOf('export async function getKontrolGapUtangBunga('), u.indexOf('export interface KontrolGapUtangBungaAsOf'));
    expect(global).toMatch(/const actual = await getAccountBalance\(db, utangBungaAccountId\);/);
    expect(global).not.toMatch(/asOf/);
  });

  it('10. pemicu bersamaan (gerbang 2025 + gerbang 2026 + layar + refresh) tetap idempoten', async () => {
    const id = await buatUtang('2025-11-01');
    await Promise.all([
      gerbang(2025, '2026-01-05'),
      jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-01-05'),
      jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-01-05'),
      gerbang(2025, '2026-01-05'),
    ]);
    await Promise.allSettled([jalankanAkrualBungaUtangJikaPerlu('user-1', '2026-01-05'), gerbang(2025, '2026-01-05')]);
    const dup = await testDb.getAllAsync(
      `SELECT sumber_id, substr(tanggal,1,7) p, COUNT(*) n FROM journal
        WHERE sumber_transaksi='UTANG_BUNGA' AND reversal_of_id IS NULL GROUP BY sumber_id, substr(tanggal,1,7) HAVING COUNT(*) > 1`
    );
    expect(dup.length).toBe(0);
    const p = await testDb.getAllAsync<{ p: string }>(
      `SELECT substr(tanggal,1,7) p FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? ORDER BY tanggal`,
      id
    );
    expect(p.map((x) => x.p)).toEqual(['2025-11', '2025-12']);
    expect((await getKontrolGapUtangBungaAsOf('2025-12-31')).status).toBe('BALANCED');
  });

  it('skema tetap v69', () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });
});
