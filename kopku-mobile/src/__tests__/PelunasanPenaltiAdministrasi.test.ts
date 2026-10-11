import { createTestDb, TestDb } from './testDb';

/**
 * PHASE 4 — Pelunasan dengan Penalti/Administrasi. Teknik mock SAMA
 * PERSIS dengan file test lain (sql.js via testDb).
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

import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, lunasiPinjaman, hitungTotalPelunasan, getJadwalAngsuran, getPinjamanDetail } from '@/services/PinjamanService';
import { prosesAkrualJasaPinjaman, hitungOutstandingPiutangJasa } from '@/services/AkrualJasaPinjamanService';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`,
    transactionType,
    role,
    accountId
  );
}

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanPenalti: 'acc-pendapatan-penalti',
  pendapatanAdministrasi: 'acc-pendapatan-administrasi-pelunasan',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  modal: 'acc-modal',
};

const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanPenalti, '4-1150', 'Pendapatan Penalti Pelunasan', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdministrasi, '4-1160', 'Pendapatan Administrasi Pelunasan', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  // PHASE 4 (§A, permintaan pengguna): mapping COA Phase 1 — TIDAK
  // membuat akun baru, hanya reuse 4-1150/4-1160 yang sudah ada.
  await seedMapping(testDb, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN', ACC.pendapatanPenalti);
  await seedMapping(testDb, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN', ACC.pendapatanAdministrasi);
  // PHASE 4 KOREKSI FINAL (permintaan pengguna): jasa future PENDING_EIR_ACCOUNTING -> Pendapatan Diterima Dimuka (2-1300 existing, reuse), BUKAN penalti/administrasi.
  await seedMapping(testDb, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  // FINAL FIX AKRUAL (BUG 4/5/7): jasa yang kasnya diterima SEBELUM jatuh tempo
  // -> Pendapatan Diterima Dimuka (2-1300 existing), dilepas saat periode jatuh tempo.
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID,
    'A001',
    '1234567890123456',
    'Budi',
    '2020-01-01',
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );

  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);

  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sp-fixture',?,'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sw-fixture',?,'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
}

/** Pinjaman FLAT 12 bulan, jasa 100.000/bulan, dicairkan 2026-01-01, jatuh tempo pertama 2026-02-01. */
async function pinjamanAktif12Bulan(jumlahPinjaman = 1_200_000): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA',
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });
  return id;
}

describe('PHASE 4 — pelunasan dengan penalti & administrasi', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('O1: full settlement TANPA penalty/admin — perilaku Phase 2/3 tidak berubah', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, '2026-02-01');
    const hasil = await lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });
    expect(hasil.porsiPenalti).toBe(0);
    expect(hasil.porsiAdministrasi).toBe(0);
    // §C: total pelunasan KONTRAKTUAL mencakup pokok + SELURUH jasa
    // kontraktual pada jadwal yang belum LUNAS (12 periode, karena
    // belum ada satu pun yang dibayar) — ini business logic settlement
    // EXISTING (pelunasan dipercepat = melunasi seluruh sisa jadwal
    // kontraktual), TIDAK diubah Phase 4. Beda dari "Piutang Jasa
    // accounting" (hanya yang sudah diakru) — lihat O5/O6 di bawah.
    expect(hasil.totalPelunasan).toBe(rincian.totalPelunasan);
    expect(hasil.totalPelunasan).toBe(rincian.pokokTersisa + rincian.jasaTerutang);
  });

  test('O2: settlement DENGAN penalty saja — dikreditkan ke 4-1150, terpisah dari Pendapatan Jasa DAN terpisah dari jasa future (KOREKSI: jasa future TIDAK masuk 4-1150)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const rincianSebelum = await hitungTotalPelunasan(testDb as any, pinjamanId, '2026-02-01');

    const hasil = await lunasiPinjaman({
      pinjamanId,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
      penaltiPelunasan: 50_000,
    });
    expect(hasil.porsiPenalti).toBe(50_000);
    expect(hasil.totalPelunasan).toBe(rincianSebelum.totalPelunasan + 50_000);

    // KOREKSI (permintaan pengguna): Pendapatan Penalti Pelunasan
    // HANYA berisi input eksplisit (50.000) — TIDAK tercampur dengan
    // jasa future (yang sekarang masuk Pendapatan Diterima Dimuka).
    const penalti = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanPenalti);
    expect(penalti?.total).toBe(50_000);
    // Pendapatan Jasa Pinjaman HANYA menerima porsi yang sudah jatuh tempo (periode 1 saja, 2026-02-01).
    const pendapatanJasa = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    expect(pendapatanJasa?.total).toBe(rincianSebelum.jasaSudahJatuhTempo);
    // Jasa future (periode 2-12) masuk Pendapatan Diterima Dimuka (PENDING_EIR_ACCOUNTING), BUKAN penalti/jasa.
    const dimuka = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanDimuka);
    expect(dimuka?.total).toBe(rincianSebelum.jasaFuture);
    const admin = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanAdministrasi);
    expect(admin?.total ?? 0).toBe(0);
  });

  test('O3: settlement DENGAN admin saja — dikreditkan ke 4-1160', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const hasil = await lunasiPinjaman({
      pinjamanId,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
      administrasiPelunasan: 25_000,
    });
    expect(hasil.porsiAdministrasi).toBe(25_000);
    const admin = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanAdministrasi);
    expect(admin?.total).toBe(25_000);
  });

  test('O4: settlement DENGAN penalty + admin sekaligus — keduanya masuk journal terpisah, total benar', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const rincianSebelum = await hitungTotalPelunasan(testDb as any, pinjamanId, '2026-02-01');

    const hasil = await lunasiPinjaman({
      pinjamanId,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
      penaltiPelunasan: 50_000,
      administrasiPelunasan: 25_000,
    });
    expect(hasil.totalPelunasan).toBe(rincianSebelum.totalPelunasan + 75_000);

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(`SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`, hasil.journalId);
    const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
    const totalKredit = entries.reduce((s, e) => s + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit); // O12: journal balance
    expect(totalDebit).toBe(hasil.totalPelunasan);
  });

  test('O5: settlement dengan accrued Piutang Jasa — tiga arah: sudah diakru->Piutang Jasa, jatuh tempo belum diakru->Pendapatan Jasa, BELUM jatuh tempo->Pendapatan Diterima Dimuka (PENDING_EIR_ACCOUNTING, BUKAN penalti/jasa)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const hasilAkrual = await prosesAkrualJasaPinjaman({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-28' });
    const jasaSudahDiakru = hasilAkrual.row!.jumlahJasa;
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(jasaSudahDiakru);

    // Settle di 2026-03-01: periode 1 (2026-02-01) DAN periode 2
    // (2026-03-01) sudah jatuh tempo; periode 3-12 belum.
    const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, '2026-03-01');
    const jasaJatuhTempoBelumDiakru = rincian.jasaSudahJatuhTempo - jasaSudahDiakru;
    expect(jasaJatuhTempoBelumDiakru).toBeGreaterThan(0); // periode 2 belum pernah diakru

    const pendapatanJasaSebelum = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    const pendapatanPenaltiSebelum = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanPenalti);
    const dimukaSebelum = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanDimuka);

    await lunasiPinjaman({
      pinjamanId,
      tanggal: '2026-03-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
      penaltiPelunasan: 30_000,
    });

    const pendapatanJasaSesudah = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    const pendapatanPenaltiSesudah = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanPenalti);
    const dimukaSesudah = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanDimuka);

    // O15: Piutang Jasa menjadi 0 setelah settlement.
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(0);
    // Pendapatan Jasa Pinjaman HANYA bertambah sebesar porsi yang SUDAH
    // jatuh tempo tapi belum sempat diakru (periode 2) — BUKAN seluruh
    // sisa jasaTerutang (yang juga mencakup periode 3-12 yang belum jatuh tempo).
    expect(pendapatanJasaSesudah!.total - pendapatanJasaSebelum!.total).toBe(jasaJatuhTempoBelumDiakru);
    // Pendapatan Penalti Pelunasan HANYA bertambah sebesar input manual (30.000) — TIDAK tercampur jasa future.
    expect(pendapatanPenaltiSesudah!.total - pendapatanPenaltiSebelum!.total).toBe(30_000);
    // Jasa future (periode 3-12) masuk Pendapatan Diterima Dimuka, BUKAN penalti/jasa.
    expect(dimukaSesudah!.total - dimukaSebelum!.total).toBe(rincian.jasaFuture);

    const kreditPiutangJasa = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.piutangJasa);
    expect(kreditPiutangJasa?.total).toBe(jasaSudahDiakru); // hanya yang sudah diakru dilunasi lewat Piutang Jasa
  });

  test('O6: settlement TANPA accrued Piutang Jasa — SELURUH jasa kontraktual diakui langsung (Piutang Jasa GL tidak pernah tersentuh)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, '2026-02-01');
    const hasil = await lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });
    // Belum pernah ada akrual sama sekali -> seluruh porsi jasa lewat jalur "belum diakru" (Pendapatan Jasa langsung).
    expect(hasil.porsiJasa).toBe(rincian.jasaTerutang);
    const kreditPiutangJasa = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.piutangJasa);
    expect(kreditPiutangJasa?.total ?? 0).toBe(0); // tidak pernah disentuh
  });

  test('O7: partial payment SEBELUM settlement — settlement melunasi SISA setelah partial payment', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await bayarAngsuran({ pinjamanId, jadwalId: jadwal[0].id, tanggal: '2026-02-01', nominal: 50_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, '2026-03-01');
    expect(rincian.pokokTersisa).toBeLessThan(1_200_000); // sudah berkurang oleh partial payment

    const hasil = await lunasiPinjaman({ pinjamanId, tanggal: '2026-03-01', sumberDana: 'KAS', createdBy: 'user-1' });
    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('LUNAS'); // O14: loan menjadi LUNAS
    expect(hasil.totalPelunasan).toBe(rincian.totalPelunasan);
  });

  test('O8: duplicate settlement DITOLAK — tidak ada journal kedua', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1', penaltiPelunasan: 10_000 });

    await expect(
      lunasiPinjaman({ pinjamanId, tanggal: '2026-02-02', sumberDana: 'KAS', createdBy: 'user-1', penaltiPelunasan: 10_000 })
    ).rejects.toThrow(/sudah lunas/);
  });

  test('O9: penalty NEGATIF ditolak (backend, terlepas dari validasi UI apa pun)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await expect(
      lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1', penaltiPelunasan: -1000 })
    ).rejects.toThrow(/tidak boleh negatif/);

    // hitungTotalPelunasan (dipakai preview UI) juga menolak, bukan cuma lunasiPinjaman.
    await expect(hitungTotalPelunasan(testDb as any, pinjamanId, '2026-02-01', { penaltiPelunasan: -1 })).rejects.toThrow(/tidak boleh negatif/);
  });

  test('O10: administrasi NEGATIF ditolak', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await expect(
      lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1', administrasiPelunasan: -500 })
    ).rejects.toThrow(/tidak boleh negatif/);
  });

  test('O9b/O10b: NaN/Infinity/desimal ditolak (uang selalu Rupiah bulat)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await expect(
      lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1', penaltiPelunasan: NaN })
    ).rejects.toThrow(/tidak valid/);
    await expect(
      lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1', penaltiPelunasan: Infinity })
    ).rejects.toThrow(/tidak valid/);
    await expect(
      lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1', administrasiPelunasan: 1000.5 })
    ).rejects.toThrow(/bulat/);
  });

  test('O13: rollback — kalau langkah setelah journal gagal, TIDAK ada perubahan setengah jalan (loan tidak LUNAS, journal tidak nyangkut)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    // Tutup periode SETELAH pinjaman aktif tapi SEBELUM settlement -> createJournal akan menolak.
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2026'`);

    await expect(
      lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1', penaltiPelunasan: 10_000 })
    ).rejects.toThrow();

    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('AKTIF'); // TIDAK menjadi LUNAS
    const jurnalPelunasan = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE nomor_referensi LIKE '%/LUNAS'`
    );
    expect(jurnalPelunasan?.cnt).toBe(0); // tidak ada journal yang nyangkut
  });

  test('O16: future contractual jasa (belum jatuh tempo) TIDAK ikut menjadi bagian pelunasan/receivable', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    // Lunasi di HARI PERTAMA (2026-01-15, sebelum jatuh tempo angsuran pertama 2026-02-01) —
    // sisa jadwal masih 12 baris (semua belum lewat jatuh tempo).
    const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, '2026-01-15');
    // Total pelunasan tetap hanya = SUM(pokok+jasa+denda) dari 12 baris SESUAI JADWAL (kontraktual,
    // tapi ini bukan proyeksi baru — sudah ada di angsuran_jadwal sejak awal), BUKAN mengarang jasa tambahan.
    expect(rincian.jumlahAngsuranTersisa).toBe(12);
    // Piutang Jasa accounting (yang sudah diakui) = 0 karena belum ada akrual apa pun.
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(0);
    // PHASE 4 FINAL CHECK: pada 2026-01-15, TIDAK SATU PUN periode sudah jatuh tempo (periode 1 jatuh tempo 2026-02-01).
    expect(rincian.jasaSudahJatuhTempo).toBe(0);
    expect(rincian.jasaFuture).toBe(rincian.jasaTerutang); // seluruhnya future
  });

  // ================================================================
  // PHASE 4 FINAL ACCOUNTING CHECK (permintaan pengguna) — contoh
  // wajib §3: pokok 1.200.000, 12 bulan, FLAT 1%/bulan -> jasa
  // 12.000/bulan (BUKAN 100.000 — itu nilai pokok/periode). Settle
  // setelah 3 bulan berjalan, sebagian jasa sudah diakru.
  // ================================================================
  describe('FINAL CHECK — contoh wajib §3 (pokok 1.200.000, FLAT 1%/bulan, jasa 12.000/bulan)', () => {
    test('FC1/FC2/FC3/FC4/FC5/FC6/FC7/FC8/FC9/FC10: settlement setelah 3 periode berjalan, periode 1-2 sudah diakru, periode 3 jatuh tempo tapi belum diakru, periode 4-12 murni future', async () => {
      const pinjamanId = await pinjamanAktif12Bulan(1_200_000);
      const jadwal = await getJadwalAngsuran(pinjamanId);

      // Pastikan asumsi dasar contoh §3 benar sebelum lanjut.
      expect(jadwal[0].pokok).toBe(100_000); // FC8 (bagian pokok): pokok/periode benar
      expect(jadwal[0].jasa).toBe(12_000); // FC8: jasa/periode BENAR (bukan 100.000)

      // Akru periode 1 & 2 (periode 3 SENGAJA belum diakru — mensimulasikan
      // batch bulanan yang belum sempat jalan untuk periode terbaru).
      await prosesAkrualJasaPinjaman({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-04-01' });
      await prosesAkrualJasaPinjaman({ pinjamanId, periode: jadwal[1].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-04-01' });

      // FC5: Piutang Jasa TIDAK double-count -> persis 2 x 12.000, bukan lebih.
      const piutangJasaSebelumSettle = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
      expect(piutangJasaSebelumSettle).toBe(24_000);

      // Settle tepat di tanggal jatuh tempo periode 3 (2026-04-01) — periode 3 SUDAH jatuh tempo tapi BELUM diakru.
      const tanggalSettle = jadwal[2].tanggalJatuhTempo; // '2026-04-01'
      const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, tanggalSettle);

      // FC1-FC4/FC8: bisa membedakan pokok outstanding, jasa sudah
      // diakui (Piutang Jasa), jasa future, total contractual settlement.
      expect(rincian.pokokTersisa).toBe(1_200_000); // belum ada angsuran dibayar sama sekali
      expect(rincian.jasaSudahJatuhTempo).toBe(36_000); // periode 1+2+3 (semua sudah jatuh tempo per tanggalSettle)
      expect(rincian.jasaFuture).toBe(9 * 12_000); // periode 4-12 (9 periode) BELUM jatuh tempo
      expect(rincian.jasaTerutang).toBe(rincian.jasaSudahJatuhTempo + rincian.jasaFuture); // 144.000 total kontraktual
      expect(rincian.totalPelunasan).toBe(rincian.pokokTersisa + rincian.jasaTerutang); // FC8: total kontraktual benar (tanpa denda/penalti/admin di sini)

      const pendapatanJasaSebelum = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
      const pendapatanPenaltiSebelum = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanPenalti);
      const pendapatanAdministrasiSebelum = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanAdministrasi);
      const dimukaSebelum = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanDimuka);

      const hasil = await lunasiPinjaman({ pinjamanId, tanggal: tanggalSettle, sumberDana: 'KAS', createdBy: 'user-1' });

      // FC6: future jasa (periode 4-12) TIDAK menjadi Piutang Jasa — akun itu sudah 0 dan TIDAK PERNAH disentuh untuk porsi future.
      expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(0);

      const kreditPiutangJasa = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.piutangJasa);
      expect(kreditPiutangJasa?.total).toBe(24_000); // hanya periode 1+2 yang sudah diakru sebelumnya

      const pendapatanJasaSesudah = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
      // FC7: periode 3 (SUDAH jatuh tempo, belum sempat diakru) -> diakui sebagai Pendapatan Jasa (accounting income yang SAH, waktu sudah berlalu) = 12.000.
      expect(pendapatanJasaSesudah!.total - pendapatanJasaSebelum!.total).toBe(12_000);

      // KOREKSI (permintaan pengguna): periode 4-12 (BELUM jatuh
      // tempo) TIDAK masuk Pendapatan Jasa MAUPUN Pendapatan Penalti —
      // tidak ada penalti eksplisit di test ini, jadi Pendapatan
      // Penalti Pelunasan TIDAK bertambah sama sekali (FC1/FC2/FC9).
      const pendapatanPenaltiSesudah = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanPenalti);
      expect(pendapatanPenaltiSesudah!.total - pendapatanPenaltiSebelum!.total).toBe(0);
      const pendapatanAdministrasiSesudah = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanAdministrasi);
      expect(pendapatanAdministrasiSesudah!.total - pendapatanAdministrasiSebelum!.total).toBe(0);

      // FC9/FC10: periode 4-12 (108.000) dibukukan sebagai Pendapatan
      // Diterima Dimuka (liabilitas, PENDING_EIR_ACCOUNTING) — TIDAK
      // disamarkan sebagai pendapatan apa pun.
      const dimukaSesudah = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanDimuka);
      expect(dimukaSesudah!.total - dimukaSebelum!.total).toBe(108_000);
      expect(hasil.jasaFuturePendingEirAccounting).toBe(108_000);

      // FC9: journal balance.
      const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(`SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`, hasil.journalId);
      expect(entries.reduce((s, e) => s + e.debit, 0)).toBe(entries.reduce((s, e) => s + e.kredit, 0));

      // FC10: GL reconciliation — saldo Piutang Pokok & Piutang Jasa untuk pinjaman ini sekarang 0.
      const glPokok = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(je.debit - je.kredit),0) as total FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.sumber_id = ? AND je.account_id = ? AND j.status = 'POSTED'`,
        pinjamanId,
        ACC.piutangPokok
      );
      const glJasa = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(je.debit - je.kredit),0) as total FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.sumber_id = ? AND je.account_id = ? AND j.status = 'POSTED'`,
        pinjamanId,
        ACC.piutangJasa
      );
      expect(glPokok?.total).toBe(0);
      expect(glJasa?.total).toBe(0);
    });
  });
});
