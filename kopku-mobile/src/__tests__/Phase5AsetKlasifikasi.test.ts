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

import { beliAset, getAsetById, updateAset } from '@/services/AsetService';
import { terimaModalBarang } from '@/services/ModalService';
import { tambahAsetKlasifikasi, editAsetKlasifikasi } from '@/services/AsetKlasifikasiService';
import { jalankanPenyusutanOtomatisJikaPerlu, setModePenyusutan, listJurnalPenyusutan, jalankanPenyusutanPeriode, prosesPenyusutanAset } from '@/services/PenyusutanService';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
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
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${transactionType}-${role}`, transactionType, role, accountId);
}

const ACC = {
  bebanPenyusutan: 'acc-beban-penyusutan',
  akumulasi: 'acc-akumulasi-penyusutan',
  asetTetap: 'acc-aset-tetap',
  kas: 'acc-kas',
  modal: 'acc-modal',
};

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.bebanPenyusutan, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.akumulasi, '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.asetTetap, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedMapping(db, 'PENYUSUTAN_ASET', 'DEBIT_BEBAN', ACC.bebanPenyusutan);
  await seedMapping(db, 'PENYUSUTAN_ASET', 'KREDIT_AKUMULASI', ACC.akumulasi);
  await seedMapping(db, 'ASET_TETAP', 'DEBIT_ASET', ACC.asetTetap);
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'MODAL_LAINNYA', 'KREDIT_DEFAULT', ACC.modal);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
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

  return db;
}

/**
 * FIXTURE FIX (kategori B): fixture Phase 5 tidak pernah menyeed saldo
 * Kas, sehingga beliAset() TUNAI/KAS ditolak "Saldo Kas tidak cukup
 * (saldo: 0)". Penolakan itu PERILAKU PRODUKSI YANG BENAR (guard saldo
 * kas negatif di LiquidityService) dan TIDAK diubah — yang kurang adalah
 * modal awal di fixture. Diseed lewat helper OPT-IN (dipanggil hanya
 * oleh test yang memang membeli aset dengan kas), bukan di seedFixture()
 * global, supaya test lain yang memverifikasi "tidak ada journal parsial"
 * (COUNT(*) FROM journal = 0) TIDAK ikut berubah artinya.
 */
async function seedModalAwalKas(db: TestDb, nominal = 500_000_000): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, nominal);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, nominal);
}

describe('PHASE 5 — Aset <-> Klasifikasi & Modal/Barang', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('N15/N16: terimaModalBarang() MENYIMPAN klasifikasi & mengisi FK aset_klasifikasi_id otomatis', async () => {
    const kl = await tambahAsetKlasifikasi({ kelompok: 'Peralatan', subKelompok: 'Komputer', masaManfaatBulanDefault: 48, createdBy: 'user-1' });

    const hasil = await terimaModalBarang({
      namaBarang: 'Laptop Sumbangan',
      nilaiPerolehan: 10_000_000,
      masaManfaatBulan: 48,
      kelompokAset: 'Peralatan',
      subKelompokAset: 'Komputer',
      tanggal: '2026-01-10',
      createdBy: 'user-1',
    });

    const aset = await getAsetById(hasil.asetId);
    expect(aset?.kelompokAset).toBe('Peralatan');
    expect(aset?.subKelompokAset).toBe('Komputer');
    expect(aset?.asetKlasifikasiId).toBe(kl.id); // N16: FK nyata, bukan cuma teks
  });

  test('§F fix: sebelumnya terimaModalBarang() TIDAK menerima klasifikasi sama sekali — sekarang WAJIB', async () => {
    await tambahAsetKlasifikasi({ kelompok: 'Peralatan', subKelompok: 'Komputer', masaManfaatBulanDefault: 48, createdBy: 'user-1' });

    await expect(
      terimaModalBarang({
        namaBarang: 'Laptop Tanpa Klasifikasi',
        nilaiPerolehan: 10_000_000,
        masaManfaatBulan: 48,
        kelompokAset: '',
        subKelompokAset: '',
        tanggal: '2026-01-10',
        createdBy: 'user-1',
      } as any)
    ).rejects.toThrow(/[Kk]lasifikasi/);
  });

  test('N14: klasifikasi yang TIDAK ADA di master data ditolak (Modal/Barang)', async () => {
    await expect(
      terimaModalBarang({
        namaBarang: 'Barang X',
        nilaiPerolehan: 5_000_000,
        masaManfaatBulan: 24,
        kelompokAset: 'Kelompok Fiktif',
        subKelompokAset: 'Sub Fiktif',
        tanggal: '2026-01-10',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/tidak ditemukan/);
  });

  test('N14: klasifikasi yang SUDAH NONAKTIF ditolak untuk aset baru (Modal/Barang)', async () => {
    const kl = await tambahAsetKlasifikasi({ kelompok: 'Kendaraan', subKelompok: 'Motor', masaManfaatBulanDefault: 60, createdBy: 'user-1' });
    await editAsetKlasifikasi({ id: kl.id, masaManfaatBulanDefault: 60, aktif: false, updatedBy: 'user-1' });

    await expect(
      terimaModalBarang({
        namaBarang: 'Motor Sumbangan',
        nilaiPerolehan: 15_000_000,
        masaManfaatBulan: 60,
        kelompokAset: 'Kendaraan',
        subKelompokAset: 'Motor',
        tanggal: '2026-01-10',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/nonaktif/);
  });

  test('N13/N17: beliAset() TETAP berjalan tanpa klasifikasi (backward compatible, opsional)', async () => {
    await seedModalAwalKas(testDb);
    const hasil = await beliAset({
      namaAset: 'Meja Kantor',
      nilaiPerolehan: 2_000_000,
      masaManfaatBulan: 48,
      tanggal: '2026-01-05',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const aset = await getAsetById(hasil.id);
    expect(aset?.kelompokAset).toBeNull();
    expect(aset?.asetKlasifikasiId).toBeNull();
  });

  test('N13: beliAset() DENGAN klasifikasi valid -> FK terisi otomatis (real relationship, bukan cuma teks)', async () => {
    await seedModalAwalKas(testDb);
    const kl = await tambahAsetKlasifikasi({ kelompok: 'Kendaraan', subKelompok: 'Mobil', masaManfaatBulanDefault: 96, createdBy: 'user-1' });
    const hasil = await beliAset({
      namaAset: 'Mobil Operasional',
      kelompokAset: 'Kendaraan',
      subKelompokAset: 'Mobil',
      nilaiPerolehan: 200_000_000,
      masaManfaatBulan: 96,
      tanggal: '2026-01-05',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const aset = await getAsetById(hasil.id);
    expect(aset?.asetKlasifikasiId).toBe(kl.id);
  });

  test('L: klasifikasi (safe field) TETAP bisa diubah setelah aset punya histori penyusutan, tanpa menyentuh jurnal historis', async () => {
    await seedModalAwalKas(testDb);
    const kl1 = await tambahAsetKlasifikasi({ kelompok: 'Peralatan', subKelompok: 'Printer', masaManfaatBulanDefault: 36, createdBy: 'user-1' });
    const kl2 = await tambahAsetKlasifikasi({ kelompok: 'Peralatan', subKelompok: 'Scanner', masaManfaatBulanDefault: 36, createdBy: 'user-1' });

    const hasil = await beliAset({
      namaAset: 'Printer Kantor',
      kelompokAset: 'Peralatan',
      subKelompokAset: 'Printer',
      nilaiPerolehan: 3_600_000,
      masaManfaatBulan: 36,
      tanggal: '2026-01-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // Beri histori penyusutan SUNGGUHAN lewat trigger otomatis (bukan raw
    // insert) — supaya jurnal & baris aset_penyusutan konsisten dengan
    // skema/engine sesungguhnya.
    const penyusutan = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-02-15'));
    expect(penyusutan.hasil?.diproses.length).toBe(1);

    const journalCountSebelum = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);

    await updateAset({
      id: hasil.id,
      namaAset: 'Printer Kantor',
      kelompokAset: 'Peralatan',
      subKelompokAset: 'Scanner',
      actingUserId: 'user-1',
    });

    const asetSesudah = await getAsetById(hasil.id);
    expect(asetSesudah?.subKelompokAset).toBe('Scanner');
    expect(asetSesudah?.asetKlasifikasiId).toBe(kl2.id);
    expect(asetSesudah?.asetKlasifikasiId).not.toBe(kl1.id);

    // Tidak ada jurnal baru dibuat hanya karena klasifikasi berubah (§L: historical accounting tidak tersentuh).
    const journalCountSesudah = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(journalCountSesudah?.cnt).toBe(journalCountSebelum?.cnt);
  });
});

describe('PHASE 5 §B/§D — automatic monthly depreciation trigger', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  async function seedAsetTetap(id: string, tanggalPerolehan: string) {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan, metode_pembayaran, sumber, created_by, created_at, jenis_aset)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      `AST-${id}`,
      'Laptop Kantor',
      24_000_000,
      0,
      24,
      tanggalPerolehan,
      'TUNAI',
      'PEMBELIAN',
      'user-1',
      now,
      'TETAP'
    );
  }

  test('O: run pertama -> create depreciation; run kedua periode SAMA -> no-op; run periode berikutnya -> create baru', async () => {
    await seedAsetTetap('aset-1', '2026-01-15');

    // CATATAN PERUBAHAN PERILAKU (perbaikan penyusutan retroaktif):
    // trigger otomatis sekarang memproses periode yang sudah JATUH
    // TEMPO (bulannya sudah berakhir), bukan bulan berjalan. Dipanggil
    // pada 2026-02-10, yang diposting adalah '2026-01' — Februari baru
    // boleh diposting setelah 28 Februari lewat. `run.periode` tetap
    // bulan kalender saat trigger dipanggil.
    const run1 = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-02-10'));
    expect(run1.dijalankan).toBe(true);
    expect(run1.periode).toBe('2026-02');
    expect(run1.periodeDiproses).toEqual(['2026-01']);
    expect(run1.hasil?.diproses.length).toBe(1);

    // Run kedua PADA HARI YANG SAMA (mensimulasikan refresh 08:05) -> idempotent, tidak ada jurnal kedua.
    const run2 = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-02-10'));
    expect(run2.hasil?.diproses.length).toBe(0);

    // "Restart" nanti pada hari lain, PERIODE MASIH SAMA (Februari) -> tetap tidak duplikat.
    const run3 = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-02-25'));
    expect(run3.hasil?.diproses.length).toBe(0);

    const jurnalJan = await listJurnalPenyusutan({ periode: '2026-01' });
    expect(jurnalJan.length).toBe(1); // TIDAK dobel
    // Februari BELUM berakhir pada 2026-02-25 -> belum boleh diposting.
    const jurnalFeb = await listJurnalPenyusutan({ periode: '2026-02' });
    expect(jurnalFeb.length).toBe(0);

    // Bulan berikutnya (Februari sudah berakhir) -> membuat baris baru.
    const run4 = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-03-05'));
    expect(run4.periode).toBe('2026-03');
    expect(run4.periodeDiproses).toEqual(['2026-02']);
    expect(run4.hasil?.diproses.length).toBe(1);
  });

  test('§C: future month TIDAK diposting — trigger hanya mengejar periode yang sudah BERAKHIR sampai tanggal yang diberikan, tidak pernah maju sendiri', async () => {
    await seedAsetTetap('aset-1', '2026-01-15');
    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-02-10'));
    expect(run.periode).toBe('2026-02');
    // Tidak ada baris untuk bulan-bulan setelahnya yang otomatis dibuat.
    const jurnalMaret = await listJurnalPenyusutan({ periode: '2026-03' });
    const jurnalApril = await listJurnalPenyusutan({ periode: '2026-04' });
    expect(jurnalMaret.length).toBe(0);
    expect(jurnalApril.length).toBe(0);
  });

  test('mode MANUAL -> trigger app-open TIDAK melakukan apa pun', async () => {
    await seedAsetTetap('aset-1', '2026-01-15');
    await setModePenyusutan('MANUAL', 'user-1');

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-02-10'));
    expect(run.dijalankan).toBe(false);

    const jurnalFeb = await listJurnalPenyusutan({ periode: '2026-02' });
    expect(jurnalFeb.length).toBe(0);
  });

  test('kegagalan PER-ASET (mis. mapping akun hilang) TIDAK membuat trigger keseluruhan gagal — dilaporkan jelas lewat `dilewati`, bukan exception, TIDAK ADA journal parsial', async () => {
    // Hapus mapping akun supaya proses penyusutan gagal secara internal.
    // jalankanPenyusutanPeriode() menangkap kegagalan PER-ASET (try/catch
    // internal, § "satu aset bermasalah tidak menggagalkan aset lain") —
    // jadi trigger keseluruhan TETAP `dijalankan: true` (proses BERJALAN),
    // tapi asetnya sendiri masuk `dilewati` dengan alasan jelas, BUKAN
    // dilaporkan lewat field `error` tingkat atas (itu HANYA untuk
    // kegagalan yang benar-benar menggagalkan seluruh proses, mis. mode
    // penyusutan gagal dibaca) — lihat test terpisah "5"/"6" di describe
    // block final-fix di bawah untuk skenario ini dengan konteks
    // systemTrigger yang lebih lengkap.
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'PENYUSUTAN_ASET'`);
    await seedAsetTetap('aset-1', '2026-01-15');

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-02-10'));
    expect(run.dijalankan).toBe(true);
    expect(run.hasil?.diproses.length).toBe(0);
    expect(run.hasil?.dilewati[0]?.alasan).toBeTruthy();

    const jurnal = await listJurnalPenyusutan({ periode: '2026-02' });
    expect(jurnal.length).toBe(0); // tidak ada journal parsial
  });
});

describe('PHASE 5 FINAL FIX — automatic depreciation TIDAK bergantung permission UI user', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  async function seedAsetTetap(id: string, tanggalPerolehan: string) {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan, metode_pembayaran, sumber, created_by, created_at, jenis_aset)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      `AST-${id}`,
      'Laptop Kantor',
      24_000_000,
      0,
      24,
      tanggalPerolehan,
      'TUNAI',
      'PEMBELIAN',
      'user-1',
      now,
      'TETAP'
    );
  }

  /** ANGGOTA role -> kas_bank: NONE secara default (DEFAULT_ROLE_PERMISSIONS) — persis "user tanpa permission UI" yang dimaksud instruksi. */
  async function seedUserAnggotaTanpaPermission(id: string) {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES (?,?,?,?,?,?,0,1,?,?)`,
      id,
      'Anggota Tanpa Izin',
      `anggota-${id}`,
      'ANGGOTA',
      'x',
      'x',
      now,
      now
    );
  }

  test('1: user TANPA permission kas_bank/create TETAP dapat memicu automatic depreciation lewat lifecycle internal (systemTrigger)', async () => {
    await seedAsetTetap('aset-1', '2026-01-15');
    await seedUserAnggotaTanpaPermission('user-anggota');

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-anggota', new Date('2026-02-10'));
    expect(run.dijalankan).toBe(true);
    expect(run.error).toBeUndefined();
    expect(run.hasil?.diproses.length).toBe(1);

    // Perbaikan penyusutan retroaktif: periode yang diposting adalah
    // periode yang sudah JATUH TEMPO ('2026-01'), bukan bulan berjalan
    // yang belum berakhir ('2026-02').
    const jurnal = await listJurnalPenyusutan({ periode: '2026-01' });
    expect(jurnal.length).toBe(1);
  });

  test('2: user TANPA permission TETAP TIDAK BISA menjalankan penyusutan manual (tanpa systemTrigger, seperti tombol UI)', async () => {
    await seedAsetTetap('aset-1', '2026-01-15');
    await seedUserAnggotaTanpaPermission('user-anggota');

    // Pola PERSIS panggilan manual dari layar Status Periode Penyusutan
    // (jalankanPenyusutanPeriode TANPA opts systemTrigger). Batch
    // runner ini menangkap error PER-ASET (try/catch internal, satu
    // aset bermasalah tidak menggagalkan aset lain) — jadi permission
    // ditolak muncul sebagai `dilewati` (BUKAN exception yang
    // dilempar ke pemanggil), tapi hasilnya tetap SAMA: TIDAK ADA
    // penyusutan yang tercatat.
    const hasil = await jalankanPenyusutanPeriode('2026-02', 'user-anggota');
    expect(hasil.diproses.length).toBe(0);
    expect(hasil.dilewati[0]?.alasan).toMatch(/[Tt]idak (memiliki|berwenang)|[Uu]nauthor/);

    const jurnal = await listJurnalPenyusutan({ periode: '2026-02' });
    expect(jurnal.length).toBe(0); // tidak ada apa pun yang terjadi
  });

  test('7: existing permission behavior TETAP AMAN — ADMIN (punya izin) tetap bisa manual, ANGGOTA (tanpa izin) tetap ditolak manual — tidak ada regresi RBAC', async () => {
    await seedAsetTetap('aset-1', '2026-01-15');
    await seedUserAnggotaTanpaPermission('user-anggota');

    // ADMIN (user-1 dari fixture) tetap bisa jalankan manual seperti sebelumnya.
    const hasilAdmin = await jalankanPenyusutanPeriode('2026-02', 'user-1');
    expect(hasilAdmin.diproses.length).toBe(1);

    // ANGGOTA tetap ditolak untuk aksi manual pada PERIODE LAIN (aset kedua, supaya tidak bentrok idempotency).
    await seedAsetTetap('aset-2', '2026-01-20');
    await expect(prosesPenyusutanAset({ asetId: 'aset-2', periode: '2026-02', createdBy: 'user-anggota' })).rejects.toThrow();
  });

  test('3/4: automatic depreciation (systemTrigger) tetap idempotent & tidak pernah memposting periode yang belum berakhir, walau dipicu user tanpa permission', async () => {
    await seedAsetTetap('aset-1', '2026-01-15');
    await seedUserAnggotaTanpaPermission('user-anggota');

    const run1 = await jalankanPenyusutanOtomatisJikaPerlu('user-anggota', new Date('2026-02-10'));
    expect(run1.hasil?.diproses.length).toBe(1);
    const run2 = await jalankanPenyusutanOtomatisJikaPerlu('user-anggota', new Date('2026-02-20'));
    expect(run2.hasil?.diproses.length).toBe(0); // tidak duplikat

    const jurnalMaret = await listJurnalPenyusutan({ periode: '2026-03' });
    expect(jurnalMaret.length).toBe(0); // periode yang belum berakhir tidak pernah diposting
  });

  test('5: kegagalan (mis. mapping akun hilang) -> tidak ada journal/depreciation record parsial, dilaporkan jelas lewat `dilewati` (walau lewat systemTrigger, dipicu user tanpa permission)', async () => {
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'PENYUSUTAN_ASET'`);
    await seedAsetTetap('aset-1', '2026-01-15');
    await seedUserAnggotaTanpaPermission('user-anggota');

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-anggota', new Date('2026-02-10'));
    // Kegagalan mapping akun ditangkap PER-ASET (bukan menggagalkan
    // seluruh trigger) — tapi hasil pentingnya SAMA: tidak ada
    // penyusutan yang tercatat setengah jalan.
    expect(run.hasil?.diproses.length ?? 0).toBe(0);
    expect(run.hasil?.dilewati[0]?.alasan).toBeTruthy();

    const jurnal = await listJurnalPenyusutan({ periode: '2026-02' });
    expect(jurnal.length).toBe(0); // tidak ada journal/record parsial
    const jumlahJurnalTotal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJurnalTotal?.cnt ?? 0).toBe(0);
  });

  test('6: retry setelah kegagalan (mis. mapping akun sudah dibetulkan admin) -> berhasil pada percobaan berikutnya, periode sama', async () => {
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'PENYUSUTAN_ASET'`);
    await seedAsetTetap('aset-1', '2026-01-15');
    await seedUserAnggotaTanpaPermission('user-anggota');

    const runGagal = await jalankanPenyusutanOtomatisJikaPerlu('user-anggota', new Date('2026-02-10'));
    expect(runGagal.hasil?.diproses.length ?? 0).toBe(0);

    // Admin membetulkan mapping akun (skenario dunia nyata: masalah konfigurasi diperbaiki).
    await seedMapping(testDb, 'PENYUSUTAN_ASET', 'DEBIT_BEBAN', ACC.bebanPenyusutan);
    await seedMapping(testDb, 'PENYUSUTAN_ASET', 'KREDIT_AKUMULASI', ACC.akumulasi);

    // Aplikasi dibuka lagi (retry) -> periode yang jatuh tempo masih SAMA ('2026-01') -> coba lagi -> berhasil.
    const runBerhasil = await jalankanPenyusutanOtomatisJikaPerlu('user-anggota', new Date('2026-02-15'));
    expect(runBerhasil.dijalankan).toBe(true);
    expect(runBerhasil.hasil?.diproses.length).toBe(1);

    const jurnal = await listJurnalPenyusutan({ periode: '2026-01' });
    expect(jurnal.length).toBe(1); // tepat satu, tidak ada sisa dari percobaan gagal sebelumnya
  });
});
