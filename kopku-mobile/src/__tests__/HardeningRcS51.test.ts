import { readFileSync } from 'fs';
import { join } from 'path';
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

import { tutupPeriode } from '@/services/PeriodCloseService';
import { catatRekonsiliasi } from '@/services/CashReconciliationService';

/**
 * ============================================================
 * RC-S51 — HARDENING: PERIOD CLOSE, MIGRATION, BACKUP PATH
 * ============================================================
 *
 * TIGA TEMUAN, SATU BENANG MERAH: BATAS YANG TIDAK DIJAGA.
 *
 * P0. `tutupPeriode()` menjalankan penyusutan otomatis SEBELUM
 *     sebagian besar preconditionnya diverifikasi. Setiap penolakan
 *     yang terjadi setelahnya meninggalkan jurnal penyusutan yang
 *     tidak diminta siapa pun, pada periode yang tetap OPEN.
 *
 * P1. Enam migrasi rebuild tabel berjalan TANPA transaksi, sehingga
 *     `DROP TABLE lama` dan `RENAME baru` bisa terpisah oleh crash —
 *     meninggalkan skema separuh jadi. Dan `PRAGMA foreign_keys = ON`
 *     yang memulihkan invarian hanya ada di jalur sukses.
 *
 * LOW. `deleteBackup(fileName)` menempel argumennya ke `BACKUP_DIR`
 *     sebagai string dan langsung menghapus hasilnya.
 *
 * APA YANG DIUJI SUNGGUHAN vs STRUKTURAL.
 *
 * Period close & backup path diuji FUNGSIONAL: keduanya berjalan penuh
 * di lingkungan test ini (SQLite lewat sql.js, service asli, jurnal
 * asli). Assertion-nya melihat isi tabel `aset_penyusutan` dan
 * `journal`, bukan sumber kode.
 *
 * Transaction boundary migrasi diuji STRUKTURAL. Alasannya jujur dan
 * disebut eksplisit di §2D permintaan: interupsi proses di tengah
 * `DROP TABLE`/`RENAME` adalah peristiwa NATIVE yang tidak dapat
 * disimulasikan pada sql.js in-memory — mematikan proses Node juga
 * mematikan runner-nya. Yang dapat dibuktikan di sini adalah bahwa
 * setiap rebuild BERADA di dalam satu transaksi dan bahwa versi hanya
 * naik di akhir; sifat rollback-nya sendiri dijamin SQLite, bukan oleh
 * kode ini. Lihat catatan di laporan.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ============================================================
// FIXTURE
// ============================================================

const ACC = { kas: 'acc-kas', modal: 'acc-modal' };
const PERIODE_ID = 'period-2026';

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

/**
 * Fixture yang SELALU punya aset siap disusutkan.
 *
 * Itu bagian penting dari desain test ini: kalau tidak ada aset yang
 * bisa disusutkan, "tidak ada jurnal penyusutan" akan hijau karena
 * memang tidak ada apa pun untuk disusutkan — bukan karena
 * sequencing-nya benar. Setiap CASE kegagalan di bawah karena itu
 * dipasangkan dengan CASE 5 yang membuktikan aset yang sama MEMANG
 * tersusutkan ketika seluruh precondition lolos.
 */
async function seedFixture(opsi: { denganRat?: boolean } = {}): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(db, 'acc-beban-penyusutan', '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
  await seedAccount(db, 'acc-akum-penyusutan', '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT');

  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id)
     VALUES ('map-peny-beban','PENYUSUTAN_ASET','DEBIT_BEBAN','acc-beban-penyusutan')`
  );
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id)
     VALUES ('map-peny-akum','PENYUSUTAN_ASET','KREDIT_AKUMULASI','acc-akum-penyusutan')`
  );

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    PERIODE_ID,
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  // User tanpa izin `pengaturan:edit` — dipakai CASE 1.
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-anggota','User Anggota Uji','anggota-uji','ANGGOTA','x','x',0,1,?,?)`,
    now,
    now
  );

  if (opsi.denganRat !== false) {
    await db.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at)
       VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
      now,
      now
    );
  }

  await db.runAsync(
    `INSERT INTO aset_tetap
      (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan,
       metode_pembayaran, sumber, journal_id, created_by, created_at, status, updated_at)
     VALUES ('aset-1','AST-1','Mesin Uji',4800000,0,48,'2026-01-01','TUNAI','PEMBELIAN',NULL,'user-1',?,'AKTIF',?)`,
    now,
    now
  );

  return db;
}

const jumlahPenyusutan = async () =>
  (
    await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM aset_penyusutan WHERE aset_id = 'aset-1'`
    )
  )?.cnt ?? -1;

const jumlahJurnalPenyusutan = async () =>
  (
    await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'PENYUSUTAN_ASET'`
    )
  )?.cnt ?? -1;

const statusPeriode = async () =>
  (
    await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM accounting_period WHERE id = ?`,
      PERIODE_ID
    )
  )?.status;

// ============================================================
// §1 SUBTASK 1C — CASE 1..7
// ============================================================
describe('§1 — precondition gagal TIDAK PERNAH meninggalkan mutasi penyusutan', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  it('CASE 5 (kontrol) — semua precondition lolos: penyusutan DIPROSES', async () => {
    // Dijalankan lebih dulu sebagai KONTROL. Tanpa case ini, keempat
    // case kegagalan di bawah bisa hijau hanya karena fixture-nya
    // memang tidak pernah menghasilkan penyusutan apa pun.
    const hasil = await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });
    expect(hasil.ditutup).toBe(true);
    expect(await jumlahPenyusutan()).toBe(12);
    expect(await jumlahJurnalPenyusutan()).toBe(12);
  });

  it('CASE 1 — permission gagal: TIDAK ada jurnal penyusutan', async () => {
    // Inilah regresi paling tajam dari urutan lama: user tanpa izin
    // menutup periode tetap memicu 12 jurnal penyusutan sebelum
    // ditolak.
    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-anggota' })).rejects.toThrow();
    expect(await jumlahPenyusutan()).toBe(0);
    expect(await jumlahJurnalPenyusutan()).toBe(0);
    expect(await statusPeriode()).toBe('OPEN');
  });

  it('CASE 2 — RAT belum dicatat: TIDAK ada jurnal penyusutan', async () => {
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2026`);

    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow(
      'Periode belum dapat ditutup karena data pelaksanaan RAT untuk tahun buku ini belum dicatat.'
    );
    expect(await jumlahPenyusutan()).toBe(0);
    expect(await jumlahJurnalPenyusutan()).toBe(0);
    expect(await statusPeriode()).toBe('OPEN');
  });

  it('CASE 4 — rekonsiliasi kas/bank masih SELISIH: TIDAK ada jurnal penyusutan', async () => {
    await catatRekonsiliasi({
      accountId: ACC.kas,
      namaRekening: 'Kas',
      tanggal: '2026-06-30',
      saldoFisik: 999_000,
      createdBy: 'user-1',
    });

    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow(/rekonsiliasi/i);
    expect(await jumlahPenyusutan()).toBe(0);
    expect(await jumlahJurnalPenyusutan()).toBe(0);
    expect(await statusPeriode()).toBe('OPEN');
  });

  it('CASE 6 — close berhasil: periode CLOSED', async () => {
    await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });
    expect(await statusPeriode()).toBe('CLOSED');

    const row = await testDb.getFirstAsync<{ closed_by: string; closed_at: string }>(
      `SELECT closed_by, closed_at FROM accounting_period WHERE id = ?`,
      PERIODE_ID
    );
    expect(row?.closed_by).toBe('user-1');
    expect(row?.closed_at).toBeTruthy();
  });

  it('CASE 7 / SUBTASK 1A — close kedua ditolak & TIDAK menyusutkan dua kali', async () => {
    await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });
    const setelahSatu = await jumlahPenyusutan();
    expect(setelahSatu).toBe(12);

    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow(
      /sudah ditutup/i
    );

    // Dua lapis yang sama-sama harus bertahan: gerbang CLOSED di
    // pre-flight, DAN idempotensi PenyusutanService (periode yang
    // sudah tercatat di `aset_penyusutan` dilewati).
    expect(await jumlahPenyusutan()).toBe(setelahSatu);
    expect(await jumlahJurnalPenyusutan()).toBe(12);
  });

  it('SUBTASK 1B — dua close bersamaan pada periode yang sama: satu batch saja', async () => {
    // Keduanya dimulai sebelum salah satu selesai. Tanpa penjaga
    // per-periode, keduanya lolos pre-flight (status masih OPEN) lalu
    // sama-sama menjalankan batch penyusutan.
    const hasil = await Promise.allSettled([
      tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' }),
      tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' }),
    ]);

    // Pemanggilan kedua ikut menunggu hasil yang pertama, jadi keduanya
    // melaporkan hasil yang SAMA — bukan dua penutupan.
    expect(hasil.filter((h) => h.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await statusPeriode()).toBe('CLOSED');
    // Yang paling penting: tetap 12, bukan 24.
    expect(await jumlahPenyusutan()).toBe(12);
    expect(await jumlahJurnalPenyusutan()).toBe(12);
  });

  it('penjaga per-periode DILEPAS setelah gagal, sehingga bisa dicoba ulang', async () => {
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2026`);
    await expect(tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' })).rejects.toThrow(/RAT/);

    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at)
       VALUES ('rat-2026b',2026,'2026-05-01','user-1',?,?)`,
      now,
      now
    );

    const hasil = await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });
    expect(hasil.ditutup).toBe(true);
    expect(await jumlahPenyusutan()).toBe(12);
  });

  it('mode MANUAL tetap TIDAK menjalankan penyusutan otomatis', async () => {
    // Non-regresi: reordering tidak boleh mengubah SIAPA yang menyusutkan.
    const { setModePenyusutan } = await import('@/services/PenyusutanService');
    await setModePenyusutan('MANUAL', 'user-1');

    await tutupPeriode({ periodeId: PERIODE_ID, createdBy: 'user-1' });
    expect(await jumlahPenyusutan()).toBe(0);
    expect(await statusPeriode()).toBe('CLOSED');
  });
});

// ============================================================
// §1 — struktur: VALIDATE FIRST, MUTATE SECOND, CLOSE LAST
// ============================================================
describe('§1 — urutan & larangan compensating delete', () => {
  const svc = read('src/services/PeriodCloseService.ts');
  const svcBersih = tanpaKomentar(svc);

  it('pre-flight berjalan SEBELUM penyusutan dipanggil', () => {
    const iPraflight = svcBersih.indexOf('await praPenutupan(params)');
    const iPenyusutan = svcBersih.indexOf('jalankanPenyusutanOtomatisUntukTahunBuku(');
    const iClose = svcBersih.indexOf("SET status = 'CLOSED'");
    expect(iPraflight).toBeGreaterThan(-1);
    expect(iPraflight).toBeLessThan(iPenyusutan);
    expect(iPenyusutan).toBeLessThan(iClose);
  });

  it('pre-flight benar-benar MURNI: tidak ada satu pun mutasi di dalamnya', () => {
    const blok = svcBersih.slice(
      svcBersih.indexOf('async function praPenutupan'),
      svcBersih.indexOf('export async function tutupPeriode')
    );
    expect(blok).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/);
    expect(blok).not.toMatch(/createJournal|jalankanPenyusutan|withTransaction/);
  });

  it('pre-flight memeriksa SELURUH gerbang yang sudah ada', () => {
    const blok = svcBersih.slice(
      svcBersih.indexOf('async function praPenutupan'),
      svcBersih.indexOf('export async function tutupPeriode')
    );
    expect(blok).toMatch(/requirePermission\(db, params\.createdBy, 'pengaturan', 'edit'\)/);
    expect(blok).toMatch(/if \(!periode\) throw/);
    expect(blok).toMatch(/if \(periode\.status === 'CLOSED'\) throw/);
    expect(blok).toMatch(/getRATByTahunBuku\(periode\.tahun_buku\)/);
    expect(blok).toMatch(/getRingkasanPenutupanPeriode\(params\.periodeId\)/);
  });

  it('ada validasi FINAL setelah mutasi, sebelum CLOSED', () => {
    const iPenyusutan = svcBersih.indexOf('jalankanPenyusutanOtomatisUntukTahunBuku(');
    const iFinal = svcBersih.indexOf('const ringkasanFinal');
    const iClose = svcBersih.indexOf("SET status = 'CLOSED'");
    expect(iFinal).toBeGreaterThan(iPenyusutan);
    expect(iFinal).toBeLessThan(iClose);
  });

  it('DILARANG: tidak ada compensating delete/reversal jurnal', () => {
    expect(svcBersih).not.toMatch(/DELETE FROM journal|DELETE FROM aset_penyusutan/);
    expect(svcBersih).not.toMatch(/reverseJournal|batalkanJurnal|hapusJurnal/);
    // Tidak ada try/catch di sekitar penyusutan yang "membereskan" hasilnya.
    const sekitar = svcBersih.slice(
      Math.max(0, svcBersih.indexOf('jalankanPenyusutanOtomatisUntukTahunBuku(') - 300),
      svcBersih.indexOf('jalankanPenyusutanOtomatisUntukTahunBuku(') + 400
    );
    expect(sekitar).not.toMatch(/catch/);
  });

  it('penjaga konkurensi dikunci per periode, bukan global', () => {
    expect(svcBersih).toMatch(/const penutupanBerjalan = new Map<string, Promise<\{ ditutup: boolean \}>>\(\)/);
    expect(svcBersih).toMatch(/penutupanBerjalan\.get\(params\.periodeId\)/);
    expect(svcBersih).toMatch(/penutupanBerjalan\.delete\(params\.periodeId\)/);
  });

  it('TIDAK membuat service penyusutan kedua', () => {
    expect(svc).toMatch(/from '@\/services\/PenyusutanService'/);
    expect(svcBersih).not.toMatch(/hitungPenyusutan|nilai_penyusutan|garis lurus/);
  });

  it('aturan akuntansi tetap milik service masing-masing', () => {
    // PeriodCloseService tidak boleh mengenal formula apa pun.
    expect(svcBersih).not.toMatch(/@\/accounting\/(?!.*$)/);
    expect(svcBersih).not.toMatch(/masa_manfaat|nilai_residu|suku_bunga/);
  });
});

// ============================================================
// §2 — CRASH-SAFETY MIGRASI (STRUKTURAL)
// ============================================================
describe('§2 — setiap rebuild tabel berada di dalam satu transaksi', () => {
  const db = read('src/database/db.ts');

  /** Pecah blok migrasi menjadi potongan per `if (currentVersion < N)`. */
  const blokMigrasi = (() => {
    const awal = db.indexOf('if (currentVersion < 2) {');
    const akhir = db.indexOf("await db.runAsync('UPDATE schema_meta SET version = ?', SCHEMA_VERSION);");
    const body = db.slice(awal, akhir);
    const posisi = [...body.matchAll(/if \(currentVersion < (\d+)\) \{/g)].map((m) => ({
      i: m.index!,
      ver: Number(m[1]),
    }));
    return posisi.map((p, k) => ({
      ver: p.ver,
      kode: body.slice(p.i, k + 1 < posisi.length ? posisi[k + 1].i : body.length),
    }));
  })();

  it('blok migrasi terbaca (pendeteksinya bekerja)', () => {
    expect(blokMigrasi.length).toBeGreaterThan(30);
    expect(blokMigrasi.some((b) => b.ver === 58)).toBe(true);
  });

  it('TIDAK ADA rebuild (DROP/RENAME) di luar transaksi', () => {
    // Inilah temuan P1. Sebelum RC-S51 daftar ini berisi
    // v29, v31, v32, v56, v57, v58.
    const pelanggaran = blokMigrasi
      .filter((b) => /DROP TABLE|RENAME TO/.test(b.kode) && !b.kode.includes('withTransactionAsync'))
      .map((b) => b.ver);
    expect(pelanggaran).toEqual([]);
  });

  it('enam blok yang diperbaiki RC ini memang memakai transaksi', () => {
    for (const ver of [29, 31, 32, 56, 57, 58]) {
      const blok = blokMigrasi.find((b) => b.ver === ver);
      expect(blok).toBeDefined();
      expect(blok!.kode).toContain('await db.withTransactionAsync(async () => {');
    }
  });

  it('§2B — PRAGMA foreign_keys tidak lagi diubah di tengah rangkaian migrasi', () => {
    // v56/v57/v58 dulu menyalakan FK kembali di tengah blok, sehingga
    // rebuild pada blok versi berikutnya berjalan dengan FK aktif —
    // di mana DROP TABLE memicu ON DELETE CASCADE.
    for (const b of blokMigrasi) {
      expect(tanpaKomentar(b.kode)).not.toMatch(/PRAGMA foreign_keys/);
    }
  });

  it('§2B — FK dimatikan tepat SEKALI dan dipulihkan di `finally`', () => {
    const bersih = tanpaKomentar(db);
    expect([...bersih.matchAll(/execAsync\('PRAGMA foreign_keys = OFF;'\)/g)]).toHaveLength(1);
    // Pemulihan berada di jalur yang SELALU dilalui, bukan hanya sukses.
    expect(bersih).toMatch(/\} finally \{[\s\S]{0,400}PRAGMA foreign_keys = ON;/);
  });

  it('§2B — foreign_key_check tetap dijalankan setelah migrasi', () => {
    expect(db).toMatch(/PRAGMA foreign_key_check/);
    expect(db).toMatch(/assertForeignKeysEnabled\(db, 'runMigrations \(setelah blok migrasi legacy\)'\)/);
  });

  it('§2E — versi HANYA dinaikkan setelah seluruh blok selesai', () => {
    const bersih = tanpaKomentar(db);
    const iUpdate = bersih.indexOf("UPDATE schema_meta SET version = ?', SCHEMA_VERSION");
    const iBlokPertama = bersih.indexOf('if (currentVersion < 2) {');
    const iBlokTerakhir = bersih.lastIndexOf('if (currentVersion < 59) {');
    expect(iBlokPertama).toBeLessThan(iUpdate);
    expect(iBlokTerakhir).toBeLessThan(iUpdate);
    // Tepat satu tempat yang menaikkan versi pada jalur upgrade.
    expect([...bersih.matchAll(/UPDATE schema_meta SET version = \?/g)]).toHaveLength(1);
  });

  it('§2E — versi TIDAK dinaikkan di dalam blok migrasi mana pun', () => {
    for (const b of blokMigrasi) {
      expect(b.kode).not.toMatch(/schema_meta SET version/);
      expect(b.kode).not.toMatch(/user_version/);
    }
  });

  it('§2A — kenaikan versi berada di dalam `try`, bukan setelah `finally`', () => {
    const bersih = tanpaKomentar(db);
    const iUpdate = bersih.indexOf("UPDATE schema_meta SET version = ?', SCHEMA_VERSION");
    const iFinally = bersih.indexOf('} finally {', bersih.indexOf("PRAGMA foreign_keys = OFF;'"));
    expect(iUpdate).toBeLessThan(iFinally);
  });
});

// ============================================================
// §3 — BACKUP DELETE PATH (FUNGSIONAL)
// ============================================================
describe('§3 — hanya nama file backup yang sah yang diterima', () => {
  /**
   * Diuji FUNGSIONAL lewat `BackupValidator` — modul MURNI (tanpa
   * FileSystem/Sharing), jadi validatornya benar-benar dijalankan di
   * sini, bukan dibaca dari sumber.
   *
   * `BackupService` sendiri TIDAK dapat diimpor di lingkungan test ini:
   * ia menarik `expo-sharing`/`expo-document-picker` yang di-ship
   * sebagai ESM murni dan tidak punya transformer di sini (alasan
   * identik dengan mock expo-crypto/expo-sqlite di jest.config.js).
   * Karena itu lapis KEDUA (invarian lokasi di dalam BACKUP_DIR) diuji
   * secara struktural di bawah.
   */
  const { POLA_NAMA_FILE_BACKUP, assertNamaFileBackupSah, formatNamaFileBackup } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('@/backup/BackupValidator') as typeof import('@/backup/BackupValidator');

  it('nama yang dihasilkan aplikasi sendiri DITERIMA', () => {
    // Sumber kebenaran polanya: fungsi yang benar-benar membuat nama itu.
    const nama = formatNamaFileBackup(new Date('2026-09-10T10:30:00'));
    expect(() => assertNamaFileBackupSah(nama)).not.toThrow();
    expect(POLA_NAMA_FILE_BACKUP.test(nama)).toBe(true);
  });

  it('salinan otomatis sebelum restore juga DITERIMA', () => {
    // `restoreBackup` membuat nama ini dengan mengganti prefiksnya.
    const nama = formatNamaFileBackup(new Date('2026-09-10T10:30:00')).replace(
      'koperasi_backup_',
      'sebelum-restore_'
    );
    expect(() => assertNamaFileBackupSah(nama)).not.toThrow();
  });

  it.each([
    ['traversal relatif', '../database.kdb'],
    ['traversal berlapis', '../../db.sqlite'],
    ['traversal di tengah', 'backup/../../x.kdb'],
    ['traversal windows', '..\\database.kdb'],
    ['absolute path unix', '/data/data/other/file.kdb'],
    ['absolute path dengan pola valid', '/koperasi_backup_2026-09-10_103000.kdb'],
    ['drive letter windows', 'C:\\temp\\db.kdb'],
    ['pemisah path', 'sub/koperasi_backup_2026-09-10_103000.kdb'],
    ['file URI', 'file:///etc/passwd'],
    ['nama kosong', ''],
    ['ekstensi lain', 'koperasi_backup_2026-09-10_103000.sqlite'],
    ['tanpa prefiks yang dikenal', 'sembarang.kdb'],
    ['stempel waktu tidak sesuai pola', 'koperasi_backup_20260910_103000.kdb'],
    ['null byte disisipkan', 'koperasi_backup_2026-09-10_103000.kdb\u0000.png'],
    ['karakter shell', 'koperasi_backup_2026-09-10_103000.kdb; rm -rf /'],
    ['spasi di depan', ' koperasi_backup_2026-09-10_103000.kdb'],
  ])('%s DITOLAK: %p', (_label, nama) => {
    expect(() => assertNamaFileBackupSah(nama as string)).toThrow(/tidak valid/i);
    expect(POLA_NAMA_FILE_BACKUP.test(nama as string)).toBe(false);
  });

  it('bukan string pun DITOLAK, tidak menghasilkan URI', () => {
    // Boundary service menerima apa pun dari JS runtime.
    expect(() => assertNamaFileBackupSah(undefined as unknown as string)).toThrow(/tidak valid/i);
    expect(() => assertNamaFileBackupSah(null as unknown as string)).toThrow(/tidak valid/i);
  });

  it('memakai allow-list, bukan daftar pola berbahaya', () => {
    const validator = tanpaKomentar(read('src/backup/BackupValidator.ts'));
    expect(validator).toMatch(/export const POLA_NAMA_FILE_BACKUP = \/\^/);
    // Tidak ada pengecekan berbasis daftar hitam.
    expect(validator).not.toMatch(/includes\('\.\.'\)[\s\S]{0,80}throw/);
  });

  it('deleteBackup memvalidasi SEBELUM menyentuh filesystem', () => {
    const svc = tanpaKomentar(read('src/services/BackupService.ts'));
    // Penempelan string mentah yang menjadi temuan audit sudah hilang.
    expect(svc).not.toMatch(/deleteAsync\(`\$\{BACKUP_DIR\}\$\{fileName\}`/);
    const blok = svc.slice(svc.indexOf('export async function deleteBackup'));
    const badan = blok.slice(0, blok.indexOf('}') + 1);
    expect(badan.indexOf('resolveUriBackupYangSah(fileName)')).toBeLessThan(badan.indexOf('deleteAsync'));
  });

  it('lapis kedua: invarian lokasi di dalam BACKUP_DIR tetap dijaga', () => {
    const svc = tanpaKomentar(read('src/services/BackupService.ts'));
    const blok = svc.slice(
      svc.indexOf('export function resolveUriBackupYangSah'),
      svc.indexOf('export async function deleteBackup')
    );
    expect(blok).toMatch(/assertNamaFileBackupSah\(fileName\)/);
    expect(blok).toMatch(/!uri\.startsWith\(BACKUP_DIR\)/);
    expect(blok).toMatch(/uri\.includes\('\.\.'\)/);
    expect(blok).toMatch(/uri\.slice\(BACKUP_DIR\.length\)\.includes\('\/'\)/);
  });
});

// ============================================================
// REGRESI — RC ini hanya menyentuh WHEN & BOUNDARY
// ============================================================
describe('REGRESI — tidak ada aturan akuntansi yang berubah', () => {
  it('tidak ada berkas accounting yang menyebut RC ini', () => {
    for (const berkas of [
      'src/accounting/AccountingEngine.ts',
      'src/accounting/Ledger.ts',
      'src/accounting/EffectiveInterestRateService.ts',
      'src/accounting/NonAccrualPolicy.ts',
      'src/accounting/ShuCalculator.ts',
      'src/accounting/CashFlowClassification.ts',
      'src/accounting/SimpananBerjangkaBunga.ts',
      'src/reports/FinancialReports.ts',
      'src/config/defaultCOA.ts',
    ]) {
      expect(read(berkas)).not.toMatch(/RC-S51/);
    }
  });

  it('PenyusutanService & service simpanan berjangka TIDAK diubah', () => {
    for (const berkas of [
      'src/services/PenyusutanService.ts',
      'src/services/SimpananBerjangkaLifecycleService.ts',
      'src/services/SimpananBerjangkaEarlyWithdrawalService.ts',
      'src/services/PendapatanDimukaService.ts',
      'src/services/LoanImpairmentService.ts',
    ]) {
      expect(read(berkas)).not.toMatch(/RC-S51/);
    }
  });

  it('lisensi & keamanan tidak disentuh', () => {
    for (const berkas of [
      'src/services/LicenseService.ts',
      'src/components/LicenseGate.tsx',
      'src/security/licenseToken.ts',
    ]) {
      expect(read(berkas)).not.toMatch(/RC-S51/);
    }
  });

  it('SCHEMA_VERSION tidak dinaikkan oleh RC ini', () => {
    // Crash-safety dicapai dengan transaction boundary, BUKAN dengan
    // mengubah bentuk skema.
    // DIPERBARUI RC-S72 (LEGACY EXPECTATION): literal `= 59` basi sejak v60 —
    // skema sah dinaikkan RC lain (v60 = master data identitas, ... v69 = RC-S55).
    // Invarian yang dimaksud — RC-S51 TIDAK menaikkan skema — kini dikunci secara
    // historis: skema tidak pernah di bawah 59, dan tidak satu pun blok migrasi
    // SESUDAH v59 (mulai `currentVersion < 60`) berasal dari RC-S51.
    const cocok = read('src/database/schema.ts').match(/export const SCHEMA_VERSION = (\d+);/);
    expect(cocok).not.toBeNull();
    expect(Number(cocok?.[1])).toBeGreaterThanOrEqual(59);
    const dbSrc = read('src/database/db.ts');
    const iV60 = dbSrc.indexOf('if (currentVersion < 60)');
    expect(iV60).toBeGreaterThan(-1);
    expect(dbSrc.slice(iV60)).not.toMatch(/RC-S51/);
    expect(read('src/database/schema.ts')).not.toMatch(/RC-S51/);
  });

  it('tidak ada tabel/kolom baru yang ditambahkan RC ini', () => {
    const dbSrc = read('src/database/db.ts');
    const blokRc = [...dbSrc.matchAll(/RC-S51[\s\S]{0,1200}?(?=\n\s*(?:if \(currentVersion|await db\.runAsync\('UPDATE schema_meta))/g)]
      .map((m) => m[0])
      .join('\n');
    expect(blokRc).not.toMatch(/ADD COLUMN|CREATE TABLE(?! \.\.\.)/);
  });

  it('UI & navigasi tidak disentuh', () => {
    for (const berkas of [
      'src/navigation/RootNavigator.tsx',
      'src/screens/Akuntansi/StatusPeriodeScreen.tsx',
      'src/screens/Laporan/PosisiKeuanganScreen.tsx',
    ]) {
      expect(read(berkas)).not.toMatch(/RC-S51/);
    }
  });
});
