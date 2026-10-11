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

import { getRingkasanPenutupanPeriode, tutupPeriode, listPeriodeAkuntansi } from '@/services/PeriodCloseService';
import { catatRekonsiliasi } from '@/services/CashReconciliationService';
import { createJournal } from '@/accounting/AccountingEngine';

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

const ACC = { kas: 'acc-kas', modal: 'acc-modal' };
const PERIODE_ID = 'period-2026';

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    PERIODE_ID,
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  // Update pasca-Phase 18/19 §K.14: tutupPeriode() sekarang mensyaratkan
  // RAT untuk tahun buku terkait sudah tercatat — di-seed di sini
  // supaya seluruh test tutupPeriode existing di file ini (yang
  // menguji hal LAIN: trial balance, rekonsiliasi, dst) tidak perlu
  // diubah satu per satu. Gate RAT diuji terpisah & eksplisit di
  // describe block baru (tanpa RAT di-seed).
  await db.runAsync(
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
    now,
    now
  );
  return db;
}

describe('PeriodCloseService (Phase 11)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('getRingkasanPenutupanPeriode: boleh ditutup kalau trial balance seimbang & tidak ada rekonsiliasi bermasalah', async () => {
    await createJournal(testDb as any, {
      tanggal: '2026-01-10',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Modal awal',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 1_000_000 },
      ],
    });

    const ringkasan = await getRingkasanPenutupanPeriode(PERIODE_ID);
    expect(ringkasan.trialBalanceSeimbang).toBe(true);
    expect(ringkasan.bolehDitutup).toBe(true);
  });

  test('getRingkasanPenutupanPeriode: TIDAK boleh ditutup kalau ada rekonsiliasi SELISIH belum terselesaikan', async () => {
    await createJournal(testDb as any, {
      tanggal: '2026-01-10',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Modal awal',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 1_000_000 },
      ],
    });
    await catatRekonsiliasi({ accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-12-31', saldoFisik: 900_000, createdBy: 'user-1' });

    const ringkasan = await getRingkasanPenutupanPeriode(PERIODE_ID);
    expect(ringkasan.bolehDitutup).toBe(false);
    expect(ringkasan.rekonsiliasiBermasalah).toHaveLength(1);
    // DIPERBARUI RC-S78: pemblokiran tidak lagi berdasarkan "ada selisih"
    // melainkan "belum ditindaklanjuti" (§14). Baris uji ini tetap DRAFT,
    // jadi tetap memblokir — yang berubah hanya wording pesannya.
    expect(ringkasan.alasanTidakBolehDitutup).toMatch(/belum ditindaklanjuti/i);
  });

  test('tutupPeriode: DITOLAK kalau ada rekonsiliasi bermasalah — mengikuti reject dari getRingkasanPenutupanPeriode', async () => {
    await catatRekonsiliasi({ accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-12-31', saldoFisik: 100_000, createdBy: 'user-1' });

    // DIPERBARUI RC-S78: pemblokiran tidak lagi berdasarkan "ada selisih"
    // melainkan "belum ditindaklanjuti" (§14). Baris uji ini tetap DRAFT,
    // jadi tetap memblokir — yang berubah hanya wording pesannya.
    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow(/belum ditindaklanjuti/i);

    const periode = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM accounting_period WHERE id = ?`, PERIODE_ID);
    expect(periode?.status).toBe('OPEN'); // tidak berubah
  });

  test('tutupPeriode gagal: ROLLBACK penuh — tidak ada perubahan sama sekali (status, closed_at/closed_by, histori rekonsiliasi tetap utuh)', async () => {
    // Rekonsiliasi SELISIH yang menghalangi penutupan (bukan dihapus,
    // tetap ada sebagai jejak/histori).
    await catatRekonsiliasi({ accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-12-31', saldoFisik: 250_000, createdBy: 'user-1' });
    const rekonBefore = await testDb.getAllAsync<{ id: string }>(`SELECT id FROM rekonsiliasi_kas_bank`);

    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow();

    // 1. Status periode TIDAK berubah (masih OPEN, bukan CLOSED).
    const periode = await testDb.getFirstAsync<{ status: string; closed_by: string | null; closed_at: string | null }>(
      `SELECT status, closed_by, closed_at FROM accounting_period WHERE id = ?`,
      PERIODE_ID
    );
    expect(periode?.status).toBe('OPEN');
    // 2. closed_at/closed_by TETAP kosong — tidak ada tulisan parsial.
    expect(periode?.closed_by).toBeNull();
    expect(periode?.closed_at).toBeNull();
    // 3. Histori rekonsiliasi TIDAK terhapus (jangan hapus histori).
    const rekonAfter = await testDb.getAllAsync<{ id: string }>(`SELECT id FROM rekonsiliasi_kas_bank`);
    expect(rekonAfter).toHaveLength(rekonBefore.length);
    // 4. Periode masih menerima transaksi baru seperti biasa (bukti
    // BUKAN benar-benar ditutup walau gagal di tengah proses).
    await expect(
      createJournal(testDb as any, {
        tanggal: '2026-06-01',
        sumberTransaksi: 'MODAL_UANG',
        deskripsi: 'Transaksi setelah percobaan tutup periode yang gagal',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.kas, debit: 50_000, kredit: 0 },
          { accountId: ACC.modal, debit: 0, kredit: 50_000 },
        ],
      })
    ).resolves.toHaveProperty('journalId');
  });

  test('tutupPeriode: BERHASIL kalau semua syarat terpenuhi, status jadi CLOSED + closed_by/closed_at terisi', async () => {
    await createJournal(testDb as any, {
      tanggal: '2026-01-10',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Modal awal',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 1_000_000 },
      ],
    });
    await catatRekonsiliasi({ accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-12-31', saldoFisik: 1_000_000, createdBy: 'user-1' });

    const hasil = await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });
    expect(hasil.ditutup).toBe(true);

    const periode = await testDb.getFirstAsync<{ status: string; closed_by: string; closed_at: string }>(
      `SELECT status, closed_by, closed_at FROM accounting_period WHERE id = ?`,
      PERIODE_ID
    );
    expect(periode?.status).toBe('CLOSED');
    expect(periode?.closed_by).toBe('user-1');
    expect(periode?.closed_at).toBeTruthy();
  });

  test('tutupPeriode: periode yang sudah CLOSED tidak bisa ditutup lagi', async () => {
    await catatRekonsiliasi({ accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-12-31', saldoFisik: 0, createdBy: 'user-1' });
    await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });

    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow(/sudah ditutup/i);
  });

  test('setelah CLOSED, createJournal untuk tanggal di periode itu DITOLAK (integrasi dengan AccountingEngine)', async () => {
    await catatRekonsiliasi({ accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-12-31', saldoFisik: 0, createdBy: 'user-1' });
    await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });

    await expect(
      createJournal(testDb as any, {
        tanggal: '2026-06-01',
        sumberTransaksi: 'MODAL_UANG',
        deskripsi: 'Coba transaksi setelah periode ditutup',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.kas, debit: 100_000, kredit: 0 },
          { accountId: ACC.modal, debit: 0, kredit: 100_000 },
        ],
      })
    ).rejects.toThrow(/CLOSED|ditutup/i);
  });

  test('listPeriodeAkuntansi: mengembalikan periode terurut dari tahun terbaru', async () => {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2025',
      2025,
      '2025-01-01',
      '2025-12-31'
    );

    const daftar = await listPeriodeAkuntansi();
    expect(daftar[0].tahunBuku).toBe(2026);
    expect(daftar[1].tahunBuku).toBe(2025);
  });

  test('PHASE 1.1 (harden): trial balance untuk penutupan periode 2026 di-scope PENUH ke periode itu (periode_mulai <= tanggal <= periode_selesai) — TIDAK terpengaruh jurnal periode 2025 atau 2027', async () => {
    // Dua periode lain di luar periode yang mau ditutup (2026):
    // 2025 (sebelum periode_mulai) dan 2027 (setelah periode_selesai).
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2025',
      2025,
      '2025-01-01',
      '2025-12-31'
    );
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2027',
      2027,
      '2027-01-01',
      '2027-12-31'
    );

    // Jurnal SAH & SEIMBANG untuk periode 2026 yang mau ditutup.
    await createJournal(testDb as any, {
      tanggal: '2026-06-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Modal 2026',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 1_000_000 },
      ],
    });

    // Baris jurnal TIDAK SEIMBANG disuntik LANGSUNG ke journal_entry
    // (bypass AccountingEngine — mensimulasikan data korup/dari luar
    // sistem) untuk periode 2025 (SEBELUM periode_mulai 2026) dan 2027
    // (SETELAH periode_selesai 2026). Dipakai akun DUMMY terpisah dari
    // Kas (bukan ACC.kas) supaya tidak mengganggu rekonsiliasi Kas —
    // fokus test ini murni pada SCOPING trial balance, bukan
    // rekonsiliasi. Kalau query trial balance TIDAK di-scope dengan
    // benar (bug lama: hanya batas atas, tanpa batas bawah), baris
    // 2025 yang tidak seimbang ini akan IKUT terhitung saat menutup
    // periode 2026 dan salah menyimpulkan tidak seimbang.
    await seedAccount(testDb, 'acc-dummy-corrupt', '9-9999', 'Akun Dummy Uji Korup', 'ASET', 'DEBIT');
    const now = new Date().toISOString();
    for (const [suffix, tanggal] of [['2025', '2025-06-01'], ['2027', '2027-06-01']] as const) {
      await testDb.runAsync(
        `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        `journal-corrupt-${suffix}`,
        `JRN-CORRUPT-${suffix}`,
        tanggal,
        `period-${suffix}`,
        'TEST_CORRUPT',
        `Jurnal tidak seimbang periode ${suffix} (fixture, bypass engine)`,
        'POSTED',
        'user-1',
        now,
        now,
        now
      );
      await testDb.runAsync(
        `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
        `je-corrupt-${suffix}`,
        `journal-corrupt-${suffix}`,
        'acc-dummy-corrupt',
        5_000_000 // HANYA debit, tidak ada baris kredit lawan -> tidak seimbang
      );
    }

    await catatRekonsiliasi({ accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-12-31', saldoFisik: 1_000_000, createdBy: 'user-1' });

    // Penutupan periode 2026 HARUS tetap berhasil — trial balance
    // periode 2026 sendiri (1jt debit = 1jt kredit) seimbang, TIDAK
    // boleh terpengaruh baris tidak seimbang di periode 2025/2027.
    const ringkasan = await getRingkasanPenutupanPeriode(PERIODE_ID);
    expect(ringkasan.totalDebit).toBe(1_000_000);
    expect(ringkasan.totalKredit).toBe(1_000_000);
    expect(ringkasan.trialBalanceSeimbang).toBe(true);
    expect(ringkasan.bolehDitutup).toBe(true);

    const hasil = await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });
    expect(hasil.ditutup).toBe(true);
  });
});

describe('PeriodCloseService.tutupPeriode — update pasca-Phase 18/19 §F (auto-penyusutan) & §K.14 (gate RAT)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('§K.14: DITOLAK kalau RAT untuk tahun buku terkait belum ada — pesan sesuai permintaan pengguna', async () => {
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2026`);

    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow(
      'Periode belum dapat ditutup karena data pelaksanaan RAT untuk tahun buku ini belum dicatat.'
    );

    const periode = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM accounting_period WHERE id = ?`, PERIODE_ID);
    expect(periode?.status).toBe('OPEN'); // tidak berubah karena ditolak
  });

  test('§K.14: BERHASIL setelah RAT dilengkapi', async () => {
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2026`);
    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow(/RAT/);

    const { simpanRAT } = await import('@/services/RATService');
    await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-12-01', createdBy: 'user-1' });

    const hasil = await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });
    expect(hasil.ditutup).toBe(true);
  });

  test('§F: mode OTOMATIS (default) menjalankan penyusutan untuk aset yang belum diproses SEBELUM periode ditutup', async () => {
    const now = new Date().toISOString();
    await seedAccount(testDb, 'acc-beban-penyusutan', '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
    await seedAccount(testDb, 'acc-akumulasi-penyusutan', '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT');
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-peny-beban','PENYUSUTAN_ASET','DEBIT_BEBAN','acc-beban-penyusutan')`
    );
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-peny-akum','PENYUSUTAN_ASET','KREDIT_AKUMULASI','acc-akumulasi-penyusutan')`
    );
    await testDb.runAsync(
      `INSERT INTO aset_tetap
        (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan,
         metode_pembayaran, sumber, journal_id, created_by, created_at, status, updated_at)
       VALUES ('aset-1','AST-1','Mesin Uji',4800000,0,48,'2026-01-01','TUNAI','PEMBELIAN',NULL,'user-1',?,'AKTIF',?)`,
      now,
      now
    );

    // Mode default OTOMATIS (belum pernah di-set eksplisit).
    const { getModePenyusutan } = await import('@/services/PenyusutanService');
    expect(await getModePenyusutan()).toBe('OTOMATIS');

    await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });

    // Penyusutan untuk seluruh 12 bulan tahun buku 2026 sudah tercatat otomatis.
    const jumlahPenyusutan = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM aset_penyusutan WHERE aset_id = 'aset-1'`
    );
    expect(jumlahPenyusutan?.cnt).toBe(12);
  });

  test('§F: mode MANUAL TIDAK menjalankan penyusutan otomatis saat periode ditutup', async () => {
    const now = new Date().toISOString();
    await seedAccount(testDb, 'acc-beban-penyusutan', '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
    await seedAccount(testDb, 'acc-akumulasi-penyusutan', '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT');
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-peny-beban','PENYUSUTAN_ASET','DEBIT_BEBAN','acc-beban-penyusutan')`
    );
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-peny-akum','PENYUSUTAN_ASET','KREDIT_AKUMULASI','acc-akumulasi-penyusutan')`
    );
    await testDb.runAsync(
      `INSERT INTO aset_tetap
        (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan,
         metode_pembayaran, sumber, journal_id, created_by, created_at, status, updated_at)
       VALUES ('aset-1','AST-1','Mesin Uji',4800000,0,48,'2026-01-01','TUNAI','PEMBELIAN',NULL,'user-1',?,'AKTIF',?)`,
      now,
      now
    );

    const { setModePenyusutan, getModePenyusutan } = await import('@/services/PenyusutanService');
    await setModePenyusutan('MANUAL', 'user-1');
    expect(await getModePenyusutan()).toBe('MANUAL');

    await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });

    const jumlahPenyusutan = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM aset_penyusutan WHERE aset_id = 'aset-1'`
    );
    expect(jumlahPenyusutan?.cnt).toBe(0); // tidak ada yang otomatis diproses
  });
});
