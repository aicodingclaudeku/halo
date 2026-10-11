import { createTestDb, TestDb } from './testDb';
import { getPosisiKeuangan, getPosisiKeuanganKomparatif } from '@/reports/FinancialReports';
import {
  buildPosisiKeuanganExport,
  buildPosisiKeuanganKomparatifExport,
} from '@/export/ReportTableBuilders';
import { geserPeriodeSetahunKeBelakang } from '@/utils/reportPeriod';

/**
 * REQUIREMENT 5 (permintaan pengguna) — Laporan Posisi Keuangan
 * SINGLE & COMPARATIVE.
 *
 * Yang dibuktikan:
 *   1) periode komparatif benar-benar MENGAMBIL TANGGAL PEMBANDING,
 *      bukan mengulang periode berjalan;
 *   2) tanggal pembanding default diturunkan dari TANGGAL LAPORAN
 *      (bukan dari jam komputer) — diuji pada akhir tahun, tengah
 *      tahun, bulan berbeda, dan tahun kabisat;
 *   3) Total Aset = Total Liabilitas + Ekuitas pada KEDUA periode;
 *   4) `labaBerjalan` dirender di export komparatif (BUG v50 yang
 *      diperbaiki: sebelumnya hanya masuk total, tidak pernah muncul
 *      sebagai baris, sehingga rincian Ekuitas tidak menjumlah ke
 *      Total Ekuitas-nya sendiri) dan TIDAK dihitung dua kali;
 *   5) export single = SATU kolom nilai, export komparatif = DUA kolom;
 *   6) angka di export identik dengan angka hasil service (satu sumber).
 */

let testDb: TestDb;

const ACC = {
  kas: 'acc-kas',
  utang: 'acc-utang',
  simpananBerjangka: 'acc-simpanan-berjangka',
  modal: 'acc-modal',
  pendapatan: 'acc-pendapatan',
  beban: 'acc-beban',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}

/** Jurnal POSTED langsung (bypass service) — fokus test ini adalah pelaporan, bukan alur transaksi. */
async function seedJurnal(
  db: TestDb,
  id: string,
  tanggal: string,
  baris: { accountId: string; debit: number; kredit: number }[]
) {
  const now = new Date().toISOString();
  const tahun = Number(tanggal.slice(0, 4));
  await db.runAsync(
    `INSERT OR IGNORE INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES (?,?,?,?,'OPEN')`,
    `period-${tahun}`,
    tahun,
    `${tahun}-01-01`,
    `${tahun}-12-31`
  );
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?,?,'MODAL_AWAL',?, 'POSTED','user-1',?,?,?)`,
    id,
    `JRN-${id}`,
    tanggal,
    `period-${tahun}`,
    `fixture ${id}`,
    now,
    now,
    now
  );
  let i = 0;
  for (const b of baris) {
    await db.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,?)`,
      `${id}-e${i++}`,
      id,
      b.accountId,
      b.debit,
      b.kredit
    );
  }
}

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.utang, '2-1900', 'Utang Pajak', 'LIABILITAS', 'KREDIT');
  // REQ 1 x REQ 5 (regresi lintas-requirement): akun simpanan berjangka
  // yang baru harus muncul sebagai LIABILITAS di Posisi Keuangan.
  await seedAccount(db, ACC.simpananBerjangka, '2-1210', 'Simpanan Anggota (Berjangka)', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatan, '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.beban, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');

  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );

  // --- TAHUN 2024 (periode pembanding) ---
  await seedJurnal(db, 'j-2024-modal', '2024-03-01', [
    { accountId: ACC.kas, debit: 10_000_000, kredit: 0 },
    { accountId: ACC.modal, debit: 0, kredit: 10_000_000 },
  ]);
  await seedJurnal(db, 'j-2024-utang', '2024-04-01', [
    { accountId: ACC.kas, debit: 2_000_000, kredit: 0 },
    { accountId: ACC.utang, debit: 0, kredit: 2_000_000 },
  ]);
  // Laba tahun berjalan 2024 = 3.000.000 - 1.000.000 = 2.000.000
  await seedJurnal(db, 'j-2024-pendapatan', '2024-06-01', [
    { accountId: ACC.kas, debit: 3_000_000, kredit: 0 },
    { accountId: ACC.pendapatan, debit: 0, kredit: 3_000_000 },
  ]);
  await seedJurnal(db, 'j-2024-beban', '2024-07-01', [
    { accountId: ACC.beban, debit: 1_000_000, kredit: 0 },
    { accountId: ACC.kas, debit: 0, kredit: 1_000_000 },
  ]);

  // --- TAHUN 2025 (periode berjalan) ---
  await seedJurnal(db, 'j-2025-berjangka', '2025-02-01', [
    { accountId: ACC.kas, debit: 5_000_000, kredit: 0 },
    { accountId: ACC.simpananBerjangka, debit: 0, kredit: 5_000_000 },
  ]);
  // Laba tahun berjalan 2025 = 4.000.000 - 1.500.000 = 2.500.000
  await seedJurnal(db, 'j-2025-pendapatan', '2025-05-01', [
    { accountId: ACC.kas, debit: 4_000_000, kredit: 0 },
    { accountId: ACC.pendapatan, debit: 0, kredit: 4_000_000 },
  ]);
  await seedJurnal(db, 'j-2025-beban', '2025-08-01', [
    { accountId: ACC.beban, debit: 1_500_000, kredit: 0 },
    { accountId: ACC.kas, debit: 0, kredit: 1_500_000 },
  ]);

  return db;
}

const INFO = { namaKoperasi: 'KOP Uji', standarAkuntansi: 'SAK_EP' as const };
const TGL_BERJALAN = '2025-12-31';
const TGL_PEMBANDING = '2024-12-31';

describe('REQ 5 — periode komparatif diturunkan dari TANGGAL LAPORAN, bukan jam komputer', () => {
  test('akhir tahun: 2025-12-31 -> 2024-12-31', () => {
    expect(geserPeriodeSetahunKeBelakang({ mulai: TGL_BERJALAN, selesai: TGL_BERJALAN }).selesai).toBe('2024-12-31');
  });

  test('tengah tahun: 2025-06-30 -> 2024-06-30', () => {
    expect(geserPeriodeSetahunKeBelakang({ mulai: '2025-06-30', selesai: '2025-06-30' }).selesai).toBe('2024-06-30');
  });

  test('bulan berbeda: 2025-03-15 -> 2024-03-15', () => {
    expect(geserPeriodeSetahunKeBelakang({ mulai: '2025-03-15', selesai: '2025-03-15' }).selesai).toBe('2024-03-15');
  });

  test('tahun kabisat: 2024-02-29 -> 2023 tetap tanggal valid (tidak menghasilkan tanggal hantu)', () => {
    const hasil = geserPeriodeSetahunKeBelakang({ mulai: '2024-02-29', selesai: '2024-02-29' }).selesai;
    expect(hasil.startsWith('2023-02-2')).toBe(true);
    // Wajib tanggal kalender yang benar-benar ada.
    expect(new Date(hasil).toISOString().slice(0, 10)).toBe(hasil);
  });

  test('hasilnya TIDAK bergantung pada tanggal hari ini', () => {
    // Dipanggil dua kali dengan input sama -> hasil sama; dan hasilnya
    // selalu setahun sebelum INPUT, bukan setahun sebelum hari ini.
    const a = geserPeriodeSetahunKeBelakang({ mulai: TGL_BERJALAN, selesai: TGL_BERJALAN }).selesai;
    const b = geserPeriodeSetahunKeBelakang({ mulai: TGL_BERJALAN, selesai: TGL_BERJALAN }).selesai;
    expect(a).toBe(b);
    expect(a.slice(0, 4)).toBe('2024');
  });
});

describe('REQ 5 — SINGLE', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('neraca SEIMBANG: Total Aset = Total Liabilitas + Total Ekuitas', async () => {
    const r = await getPosisiKeuangan(testDb as any, TGL_BERJALAN);
    expect(r.totalAset).toBe(r.totalLiabilitas + r.totalEkuitas);
    expect(r.isBalanced).toBe(true);
    expect(r.selisih).toBe(0);
  });

  test('laba berjalan = hasil usaha KUMULATIF yang belum dibagikan & masuk Total Ekuitas tepat sekali', async () => {
    const r = await getPosisiKeuangan(testDb as any, TGL_BERJALAN);

    // CATATAN PENTING (bukan bug): `labaBerjalan` di KOPKU adalah hasil
    // usaha KUMULATIF SEPANJANG MASA dikurangi yang sudah didistribusikan
    // lewat SHU — BUKAN laba satu tahun buku. Sebabnya aplikasi ini
    // TIDAK PERNAH membuat closing entry, jadi laba tahun-tahun
    // sebelumnya tidak pernah berpindah ke akun ekuitas permanen (lihat
    // penjelasan panjang di getPosisiKeuangan / bug fix audit v49).
    // Fixture ini belum punya jurnal distribusi SHU sama sekali, jadi:
    //   2024: 3.000.000 - 1.000.000 = 2.000.000
    //   2025: 4.000.000 - 1.500.000 = 2.500.000
    //   kumulatif per 2025-12-31 = 4.500.000
    expect(r.labaBerjalan).toBe(4_500_000);

    const rincianEkuitas = r.ekuitas.reduce((a, x) => a + x.saldo, 0);
    // Total Ekuitas = rincian akun ekuitas + laba berjalan, PERSIS SEKALI
    // (kalau dihitung dobel, angka ini tidak akan cocok).
    expect(r.totalEkuitas).toBe(rincianEkuitas + r.labaBerjalan);
  });

  test('export single memakai SATU kolom nilai dan angkanya sama dengan service', async () => {
    const r = await getPosisiKeuangan(testDb as any, TGL_BERJALAN);
    const exp = buildPosisiKeuanganExport(INFO, r);

    // 2 kolom = label + satu kolom nilai (bukan dua periode).
    expect(exp.kolom.length).toBe(2);
    expect(exp.baris.every((b) => b.length === 2)).toBe(true);

    const totalAsetRow = exp.baris.find((b) => String(b[0]).toLowerCase().includes('total aset'));
    expect(totalAsetRow?.[1]).toBe(r.totalAset);
  });
});

describe('REQ 5 — COMPARATIVE', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('periode pembanding benar-benar diambil dari TANGGAL PEMBANDING (bukan pengulangan periode berjalan)', async () => {
    const k = await getPosisiKeuanganKomparatif(testDb as any, TGL_BERJALAN, TGL_PEMBANDING);

    // Nilai kedua sisi HARUS berbeda — fixture sengaja punya mutasi 2025
    // yang tidak ada di 2024.
    expect(k.sekarang.totalAset).not.toBe(k.pembanding.totalAset);
    expect(k.sekarang.totalAset).toBe(21_500_000); // 10jt+2jt+3jt-1jt +5jt+4jt-1,5jt
    expect(k.pembanding.totalAset).toBe(14_000_000); // 10jt+2jt+3jt-1jt
    expect(k.perubahanTotalAset).toBe(k.sekarang.totalAset - k.pembanding.totalAset);
  });

  test('sisi "sekarang" komparatif IDENTIK dengan hasil mode single (satu sumber perhitungan)', async () => {
    const single = await getPosisiKeuangan(testDb as any, TGL_BERJALAN);
    const k = await getPosisiKeuanganKomparatif(testDb as any, TGL_BERJALAN, TGL_PEMBANDING);

    expect(k.sekarang.totalAset).toBe(single.totalAset);
    expect(k.sekarang.totalLiabilitas).toBe(single.totalLiabilitas);
    expect(k.sekarang.totalEkuitas).toBe(single.totalEkuitas);
    expect(k.sekarang.labaBerjalan).toBe(single.labaBerjalan);
  });

  test('KEDUA periode seimbang (balance check berlaku untuk komparatif juga)', async () => {
    const k = await getPosisiKeuanganKomparatif(testDb as any, TGL_BERJALAN, TGL_PEMBANDING);
    expect(k.sekarang.isBalanced).toBe(true);
    expect(k.pembanding.isBalanced).toBe(true);
    expect(k.sekarang.totalAset).toBe(k.sekarang.totalLiabilitas + k.sekarang.totalEkuitas);
    expect(k.pembanding.totalAset).toBe(k.pembanding.totalLiabilitas + k.pembanding.totalEkuitas);
  });

  test('laba berjalan BERBEDA antar periode dan masing-masing masuk total ekuitas periodenya sendiri', async () => {
    const k = await getPosisiKeuanganKomparatif(testDb as any, TGL_BERJALAN, TGL_PEMBANDING);
    // Kumulatif per tanggal masing-masing (lihat catatan di test SINGLE):
    // per 2025-12-31 = 2.000.000 + 2.500.000; per 2024-12-31 = 2.000.000.
    // Angka yang BERBEDA inilah bukti sisi pembanding benar-benar dihitung
    // pada tanggalnya sendiri, bukan menyalin periode berjalan.
    expect(k.sekarang.labaBerjalan).toBe(4_500_000);
    expect(k.pembanding.labaBerjalan).toBe(2_000_000);
    expect(k.sekarang.totalEkuitas).toBe(
      k.sekarang.ekuitas.reduce((a, x) => a + x.saldo, 0) + k.sekarang.labaBerjalan
    );
    expect(k.pembanding.totalEkuitas).toBe(
      k.pembanding.ekuitas.reduce((a, x) => a + x.saldo, 0) + k.pembanding.labaBerjalan
    );
  });

  test('BUG FIX v50 — export komparatif MERENDER baris laba berjalan untuk kedua periode', async () => {
    const k = await getPosisiKeuanganKomparatif(testDb as any, TGL_BERJALAN, TGL_PEMBANDING);
    const exp = buildPosisiKeuanganKomparatifExport(INFO, k);

    const barisLaba = exp.baris.find((b) => String(b[0]) === k.sekarang.labaBerjalanLabel);
    expect(barisLaba).toBeDefined();
    expect(barisLaba?.[1]).toBe(4_500_000);
    expect(barisLaba?.[2]).toBe(2_000_000);
  });

  test('rincian EKUITAS di export komparatif MENJUMLAH ke Total Ekuitas (kedua kolom)', async () => {
    const k = await getPosisiKeuanganKomparatif(testDb as any, TGL_BERJALAN, TGL_PEMBANDING);
    const exp = buildPosisiKeuanganKomparatifExport(INFO, k);

    const iEkuitas = exp.baris.findIndex((b) => String(b[0]) === 'EKUITAS');
    const iTotal = exp.baris.findIndex((b) => String(b[0]) === 'Total Ekuitas');
    expect(iEkuitas).toBeGreaterThanOrEqual(0);
    expect(iTotal).toBeGreaterThan(iEkuitas);

    const rincian = exp.baris.slice(iEkuitas + 1, iTotal);
    const jumlahSekarang = rincian.reduce((a, b) => a + (typeof b[1] === 'number' ? b[1] : 0), 0);
    const jumlahPembanding = rincian.reduce((a, b) => a + (typeof b[2] === 'number' ? b[2] : 0), 0);

    expect(jumlahSekarang).toBe(k.sekarang.totalEkuitas);
    expect(jumlahPembanding).toBe(k.pembanding.totalEkuitas);
  });

  test('export komparatif memakai DUA kolom nilai dengan tanggal yang BERBEDA di header', async () => {
    const k = await getPosisiKeuanganKomparatif(testDb as any, TGL_BERJALAN, TGL_PEMBANDING);
    const exp = buildPosisiKeuanganKomparatifExport(INFO, k);

    expect(exp.kolom.length).toBe(3); // Akun + 2 periode
    expect(exp.kolom[1]).not.toBe(exp.kolom[2]);
    expect(exp.baris.every((b) => b.length === 3)).toBe(true);
  });

  test('balance check periode komparatif ikut dilaporkan di ringkasan export', async () => {
    const k = await getPosisiKeuanganKomparatif(testDb as any, TGL_BERJALAN, TGL_PEMBANDING);
    const exp = buildPosisiKeuanganKomparatifExport(INFO, k);

    // DIPERBARUI Poin 14: label periode = tahun laporan (bukan "Berjalan"/"Komparatif").
    const [thBerjalan, thBanding] = [exp.kolom[1], exp.kolom[2]];
    expect(thBerjalan).toBe(TGL_BERJALAN.slice(0, 4));
    expect(thBanding).toBe(TGL_PEMBANDING.slice(0, 4));
    const statusBerjalan = exp.ringkasan?.find((r) => r.label === `Status ${thBerjalan}`);
    const statusKomparatif = exp.ringkasan?.find((r) => r.label === `Status ${thBanding}`);
    expect(statusBerjalan?.nilai).toBe('Seimbang');
    expect(statusKomparatif?.nilai).toBe('Seimbang');
  });

  test('REGRESI LINTAS-REQ (1 x 5): akun 2-1210 muncul di bagian LIABILITAS', async () => {
    const r = await getPosisiKeuangan(testDb as any, TGL_BERJALAN);
    const baris = r.liabilitas.find((x) => x.kode === '2-1210');
    expect(baris).toBeDefined();
    expect(baris?.saldo).toBe(5_000_000);
    // Tidak boleh nyasar ke aset maupun ekuitas.
    expect(r.aset.some((x) => x.kode === '2-1210')).toBe(false);
    expect(r.ekuitas.some((x) => x.kode === '2-1210')).toBe(false);
  });
});
