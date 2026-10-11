import { createTestDb, TestDb } from './testDb';

/**
 * REQUIREMENT 7 (permintaan pengguna) — "Jasa Terpisah" vs "Jasa
 * Integral" untuk biaya administrasi pencairan.
 *
 * Inti yang dibuktikan: pilihan ini BUKAN sekadar dua opsi visual.
 * Test ini TIDAK memeriksa "state berubah" — yang diperiksa adalah
 * HASIL AKUNTANSINYA:
 *   1) pilihan tersimpan ke `pinjaman.biaya_admin_klasifikasi`
 *      (sebelum v50 form tidak pernah mengirimnya sehingga SELALU
 *      jatuh ke default);
 *   2) Jasa Terpisah  -> KREDIT ke Pendapatan Administrasi (4-1100),
 *      diakui penuh saat pencairan;
 *   3) Jasa Integral  -> KREDIT ke Pendapatan Diterima Dimuka (2-1300),
 *      TIDAK diakui sebagai pendapatan, dan memicu pengukuran EIR;
 *   4) berlaku untuk biaya admin NOMINAL maupun PERSENTASE, dengan
 *      nominal fee & kas diterima yang IDENTIK di kedua metode
 *      (yang berbeda hanya akun & waktu pengakuan);
 *   5) jurnal tetap BALANCE di kedua metode;
 *   6) klasifikasi integral TANPA fee dinormalisasi ke SEPARATE_SERVICE;
 *   7) nilai klasifikasi tidak valid DITOLAK;
 *   8) editPinjaman mempertahankan/mengubah pilihan secara eksplisit —
 *      tidak pernah diam-diam kembali ke default.
 */

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

import { ajukanPinjaman, editPinjaman, cairkanPinjaman, getPinjamanDetail } from '@/services/PinjamanService';

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
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}
async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanDenda: 'acc-pendapatan-denda',
  modal: 'acc-modal',
};
const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026', 2026, '2026-01-01', '2026-12-31'
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'A001', '1234567890123456', 'Budi', '2020-01-01', now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-MODAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal fixture','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je1','j-modal',?,?,0)`, ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je2','j-modal',?,0,?)`, ACC.modal, 50_000_000);

  for (const [id, jenis, nominal] of [['sp', 'POKOK', 100000], ['sw', 'WAJIB', 50000]] as const) {
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,'SETOR','2020-01-01',?,'KAS',?, 'user-1',?)`,
      id, ANGGOTA_ID, jenis, nominal, id.toUpperCase(), now
    );
  }
}

async function buatPinjaman(opts: {
  biayaAdminTipe: 'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA';
  biayaAdminNilai: number;
  biayaAdminKlasifikasi?: 'SEPARATE_SERVICE' | 'INTEGRAL_FINANCIAL_INSTRUMENT';
}): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman: 1_200_000,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: opts.biayaAdminTipe,
    biayaAdminNilai: opts.biayaAdminNilai,
    biayaAdminKlasifikasi: opts.biayaAdminKlasifikasi,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  return id;
}

// CATATAN: `tanggalPencairan: '2026-01-01'` WAJIB dikirim eksplisit di
// seluruh test ini. Tanpa itu, cairkanPinjaman() memakai tanggal sistem
// (hari ini) sementara jadwal angsuran fixture dimulai 2026-02-01,
// sehingga arus kas EIR jadi tidak terurut dan solver menolaknya. Ini
// perilaku BENAR dari EffectiveInterestRateService (validasi urutan
// arus kas), bukan bug — pola yang sama dipakai EirAccountingService.test.ts.

/** Kredit pada satu akun di dalam satu jurnal. */
async function kredit(journalId: string, accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ k: number }>(
    `SELECT COALESCE(SUM(kredit),0) as k FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
    journalId, accountId
  );
  return r?.k ?? 0;
}
async function totalJurnal(journalId: string) {
  const r = await testDb.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(kredit),0) as k FROM journal_entry WHERE journal_id = ?`,
    journalId
  );
  return { debit: r?.d ?? 0, kredit: r?.k ?? 0 };
}

describe('REQ 7 — pilihan tersimpan ke database', () => {
  beforeEach(async () => { await setupFixture(); });

  test('ajukanPinjaman MENGIRIM klasifikasi (sebelum v50 kolom ini tidak pernah diisi form)', async () => {
    const id = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    const row = await testDb.getFirstAsync<{ biaya_admin_klasifikasi: string }>(
      `SELECT biaya_admin_klasifikasi FROM pinjaman WHERE id = ?`, id
    );
    expect(row?.biaya_admin_klasifikasi).toBe('INTEGRAL_FINANCIAL_INSTRUMENT');
  });

  test('tanpa pilihan -> SEPARATE_SERVICE (perilaku lama, tidak ada regresi)', async () => {
    const id = await buatPinjaman({ biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000 });
    const row = await testDb.getFirstAsync<{ biaya_admin_klasifikasi: string }>(
      `SELECT biaya_admin_klasifikasi FROM pinjaman WHERE id = ?`, id
    );
    expect(row?.biaya_admin_klasifikasi).toBe('SEPARATE_SERVICE');
  });

  test('INTEGRAL tanpa biaya admin dinormalisasi ke SEPARATE_SERVICE (integral tanpa fee tidak punya arti akuntansi)', async () => {
    const id = await buatPinjaman({
      biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    const row = await testDb.getFirstAsync<{ biaya_admin_klasifikasi: string }>(
      `SELECT biaya_admin_klasifikasi FROM pinjaman WHERE id = ?`, id
    );
    expect(row?.biaya_admin_klasifikasi).toBe('SEPARATE_SERVICE');
  });

  test('klasifikasi tidak valid DITOLAK backend (tidak dipercaya mentah dari UI)', async () => {
    await expect(
      buatPinjaman({
        biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
        biayaAdminKlasifikasi: 'JASA_GRATIS' as any,
      })
    ).rejects.toThrow(/Klasifikasi biaya administrasi tidak valid/i);
  });

  test('getPinjamanDetail meng-expose klasifikasi untuk PREFILL form edit', async () => {
    const id = await buatPinjaman({
      biayaAdminTipe: 'PERSENTASE', biayaAdminNilai: 2,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    const detail = await getPinjamanDetail(id);
    expect(detail?.biayaAdminKlasifikasi).toBe('INTEGRAL_FINANCIAL_INSTRUMENT');
  });

  test('editPinjaman TIDAK diam-diam mengembalikan pilihan ke default', async () => {
    const id = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    await editPinjaman({
      pinjamanId: id, tanggal: '2026-01-01', jumlahPinjaman: 1_200_000,
      tenor: 12, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1,
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 60_000,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
      dendaAktif: false, actingUserId: 'user-1',
    });
    const detail = await getPinjamanDetail(id);
    expect(detail?.biayaAdminKlasifikasi).toBe('INTEGRAL_FINANCIAL_INSTRUMENT');
    expect(detail?.biayaAdminNilai).toBe(60_000);
  });

  test('editPinjaman dapat MENGUBAH pilihan secara eksplisit', async () => {
    const id = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    await editPinjaman({
      pinjamanId: id, tanggal: '2026-01-01', jumlahPinjaman: 1_200_000,
      tenor: 12, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1,
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'SEPARATE_SERVICE',
      dendaAktif: false, actingUserId: 'user-1',
    });
    const detail = await getPinjamanDetail(id);
    expect(detail?.biayaAdminKlasifikasi).toBe('SEPARATE_SERVICE');
  });
});

describe('REQ 7 — pilihan MENGUBAH JURNAL PENCAIRAN (bukan sekadar label)', () => {
  beforeEach(async () => { await setupFixture(); });

  test('NOMINAL + Jasa Terpisah -> fee diakui sebagai Pendapatan Administrasi (4-1100)', async () => {
    const id = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'SEPARATE_SERVICE',
    });
    const { journalId } = await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    expect(await kredit(journalId, ACC.pendapatanAdmin)).toBe(50_000);
    expect(await kredit(journalId, ACC.pendapatanDimuka)).toBe(0);
    // Kas keluar = pokok - fee
    expect(await kredit(journalId, ACC.kas)).toBe(1_150_000);
    const t = await totalJurnal(journalId);
    expect(t.debit).toBe(t.kredit);
  });

  test('NOMINAL + Jasa Integral -> fee DITANGGUHKAN ke Pendapatan Diterima Dimuka (2-1300)', async () => {
    const id = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    const { journalId } = await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    expect(await kredit(journalId, ACC.pendapatanDimuka)).toBe(50_000);
    // TIDAK BOLEH diakui sebagai pendapatan pada tanggal pencairan.
    expect(await kredit(journalId, ACC.pendapatanAdmin)).toBe(0);
    // Kas yang diterima anggota IDENTIK dengan metode terpisah —
    // yang berbeda hanya akun & waktu pengakuannya.
    expect(await kredit(journalId, ACC.kas)).toBe(1_150_000);
    const t = await totalJurnal(journalId);
    expect(t.debit).toBe(t.kredit);
  });

  test('PERSENTASE: fee = pokok x persen (dibulatkan) dan tetap tunduk pada pilihan metode', async () => {
    // 2% dari 1.200.000 = 24.000
    const idTerpisah = await buatPinjaman({
      biayaAdminTipe: 'PERSENTASE', biayaAdminNilai: 2,
      biayaAdminKlasifikasi: 'SEPARATE_SERVICE',
    });
    const j1 = await cairkanPinjaman({ pinjamanId: idTerpisah, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    expect(await kredit(j1.journalId, ACC.pendapatanAdmin)).toBe(24_000);
    expect(await kredit(j1.journalId, ACC.pendapatanDimuka)).toBe(0);
    expect(await kredit(j1.journalId, ACC.kas)).toBe(1_176_000);

    await setupFixture();
    const idIntegral = await buatPinjaman({
      biayaAdminTipe: 'PERSENTASE', biayaAdminNilai: 2,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    const j2 = await cairkanPinjaman({ pinjamanId: idIntegral, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    expect(await kredit(j2.journalId, ACC.pendapatanDimuka)).toBe(24_000);
    expect(await kredit(j2.journalId, ACC.pendapatanAdmin)).toBe(0);
    expect(await kredit(j2.journalId, ACC.kas)).toBe(1_176_000);
  });

  test('PEMBUKTIAN INTI: dua pilihan menghasilkan AKUN KREDIT YANG BERBEDA untuk fee yang SAMA', async () => {
    const idA = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'SEPARATE_SERVICE',
    });
    const jA = await cairkanPinjaman({ pinjamanId: idA, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    const a = {
      admin: await kredit(jA.journalId, ACC.pendapatanAdmin),
      dimuka: await kredit(jA.journalId, ACC.pendapatanDimuka),
      kas: await kredit(jA.journalId, ACC.kas),
    };

    await setupFixture();
    const idB = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    const jB = await cairkanPinjaman({ pinjamanId: idB, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    const b = {
      admin: await kredit(jB.journalId, ACC.pendapatanAdmin),
      dimuka: await kredit(jB.journalId, ACC.pendapatanDimuka),
      kas: await kredit(jB.journalId, ACC.kas),
    };

    // Kas identik, tapi penempatan fee BERTUKAR sepenuhnya.
    expect(a.kas).toBe(b.kas);
    expect(a.admin).toBe(50_000);
    expect(b.admin).toBe(0);
    expect(a.dimuka).toBe(0);
    expect(b.dimuka).toBe(50_000);
  });

  test('Jasa Integral memicu pengukuran EIR; Jasa Terpisah TIDAK', async () => {
    const idIntegral = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    });
    await cairkanPinjaman({ pinjamanId: idIntegral, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    const rIntegral = await testDb.getFirstAsync<{ eir_measurement_status: string }>(
      `SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, idIntegral
    );
    expect(rIntegral?.eir_measurement_status).toBe('MEASURED');

    await setupFixture();
    const idTerpisah = await buatPinjaman({
      biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 50_000,
      biayaAdminKlasifikasi: 'SEPARATE_SERVICE',
    });
    await cairkanPinjaman({ pinjamanId: idTerpisah, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    const rTerpisah = await testDb.getFirstAsync<{ eir_measurement_status: string }>(
      `SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, idTerpisah
    );
    expect(rTerpisah?.eir_measurement_status).not.toBe('MEASURED');
  });

  test('tanpa biaya admin: jurnal pencairan tidak menyentuh akun fee mana pun & tetap balance', async () => {
    const id = await buatPinjaman({ biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0 });
    const { journalId } = await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    expect(await kredit(journalId, ACC.pendapatanAdmin)).toBe(0);
    expect(await kredit(journalId, ACC.pendapatanDimuka)).toBe(0);
    expect(await kredit(journalId, ACC.kas)).toBe(1_200_000);
    const t = await totalJurnal(journalId);
    expect(t.debit).toBe(t.kredit);
  });
});
