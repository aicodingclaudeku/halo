import * as fs from 'fs';
import * as path from 'path';
import { createTestDb, TestDb } from './testDb';
import { createJournal } from '@/accounting/AccountingEngine';
import {
  TABEL_RESET_TRANSAKSI,
  TABEL_DIPERTAHANKAN_TRANSAKSI,
  FRASA_KONFIRMASI,
  DURASI_TAHAN_MS,
  periksaCakupanTabelReset,
  cocokFrasaKonfirmasi,
  lapisBelumTerpenuhi,
  bolehJalankanReset,
  statusKonfirmasiAwal,
  gantiMode,
  StatusKonfirmasiReset,
  URUTAN_LAPIS,
  PESAN_LAPIS,
} from '@/services/ResetDataPlan';
import {
  resetDataTransaksiPadaDb,
  hitungRingkasanDataTransaksi,
  pastikanTabelTerdaftar,
  KELOMPOK_RINGKASAN,
} from '@/services/ResetDataTransaksi';

/**
 * RC-S99 — RESET DATA: GERBANG KONFIRMASI BERLAPIS & EKSEKUSI YANG AMAN.
 *
 * Permintaan pengguna: "tombol reset data yang memiliki beberapa kali
 * konfirmasi agar tidak tertekan tidak sengaja". Dua hal yang diuji di
 * sini, dan keduanya wajib:
 *
 *  A. Gerbangnya benar-benar berlapis — tidak ada satu pun jalan menuju
 *     "boleh dijalankan" yang melewatkan sebuah lapis.
 *  B. Kalau sampai dijalankan, hasilnya tepat: data operasional hilang,
 *     konfigurasi & login utuh, dan tidak ada referensi menggantung.
 *
 * Bagian B memakai SQLite sungguhan (sql.js, skema asli dari schema.ts)
 * dan jurnal sungguhan lewat AccountingEngine.
 */

// ============================================================
// A. GERBANG KONFIRMASI (modul murni)
// ============================================================

/** Status yang sudah memenuhi SEMUA lapis — titik awal test "lepas satu lapis". */
function statusLengkap(overrides: Partial<StatusKonfirmasiReset> = {}): StatusKonfirmasiReset {
  return {
    mode: 'TRANSAKSI',
    dampakDipahami: true,
    backupDibuat: true,
    lanjutTanpaBackup: false,
    frasaDiketik: FRASA_KONFIRMASI.TRANSAKSI,
    pinDiperlukan: true,
    pinTerverifikasi: true,
    ...overrides,
  };
}

describe('RC-S99 §A — reset tidak mungkin terpicu oleh satu tekanan tidak sengaja', () => {
  test('keadaan awal layar: tidak ada mode terpilih dan reset belum boleh dijalankan', () => {
    const awal = statusKonfirmasiAwal(true);
    expect(awal.mode).toBeNull();
    expect(awal.dampakDipahami).toBe(false);
    expect(awal.backupDibuat).toBe(false);
    expect(awal.lanjutTanpaBackup).toBe(false);
    expect(awal.frasaDiketik).toBe('');
    expect(awal.pinTerverifikasi).toBe(false);
    expect(bolehJalankanReset(awal)).toBe(false);
  });

  test('status lengkap boleh dijalankan — memastikan test di bawah benar-benar menguji satu lapis', () => {
    expect(lapisBelumTerpenuhi(statusLengkap())).toEqual([]);
    expect(bolehJalankanReset(statusLengkap())).toBe(true);
  });

  test.each([
    ['mode belum dipilih', { mode: null }, 'MODE_BELUM_DIPILIH'],
    ['dampak belum dipahami', { dampakDipahami: false }, 'DAMPAK_BELUM_DIPAHAMI'],
    ['backup belum diputuskan', { backupDibuat: false, lanjutTanpaBackup: false }, 'BACKUP_BELUM_DIPUTUSKAN'],
    ['frasa masih kosong', { frasaDiketik: '' }, 'FRASA_BELUM_COCOK'],
    ['frasa salah ketik', { frasaDiketik: 'HAPUS DATA' }, 'FRASA_BELUM_COCOK'],
    ['PIN belum diverifikasi', { pinTerverifikasi: false }, 'PIN_BELUM_TERVERIFIKASI'],
  ])('MELEPAS satu lapis (%s) membuat reset terkunci lagi', (_nama, lepas, alasan) => {
    const status = statusLengkap(lepas as Partial<StatusKonfirmasiReset>);
    expect(bolehJalankanReset(status)).toBe(false);
    expect(lapisBelumTerpenuhi(status)).toContain(alasan);
  });

  test('setiap lapis punya pesan penuntun — tidak ada gerbang yang mengunci tanpa penjelasan', () => {
    for (const alasan of URUTAN_LAPIS) {
      expect(PESAN_LAPIS[alasan]).toBeTruthy();
      expect(PESAN_LAPIS[alasan].length).toBeGreaterThan(10);
    }
  });

  test('gerbang backup: "sengaja tanpa backup" diterima, tapi harus dinyatakan — bukan default', () => {
    expect(bolehJalankanReset(statusLengkap({ backupDibuat: false, lanjutTanpaBackup: true }))).toBe(true);
    expect(bolehJalankanReset(statusLengkap({ backupDibuat: false, lanjutTanpaBackup: false }))).toBe(false);
  });

  test('PIN hanya diminta bila app-lock PIN aktif di perangkat', () => {
    // PIN nonaktif: lapis PIN tidak boleh mengunci selamanya.
    expect(
      bolehJalankanReset(statusLengkap({ pinDiperlukan: false, pinTerverifikasi: false }))
    ).toBe(true);
    expect(
      bolehJalankanReset(statusLengkap({ pinDiperlukan: true, pinTerverifikasi: false }))
    ).toBe(false);
  });

  test('frasa tiap mode BERBEDA — frasa reset ringan tidak bisa membuka reset total', () => {
    expect(FRASA_KONFIRMASI.TRANSAKSI).not.toBe(FRASA_KONFIRMASI.TOTAL);
    const status = statusLengkap({ mode: 'TOTAL', frasaDiketik: FRASA_KONFIRMASI.TRANSAKSI });
    expect(bolehJalankanReset(status)).toBe(false);
    expect(lapisBelumTerpenuhi(status)).toContain('FRASA_BELUM_COCOK');
  });

  test('frasa cukup panjang & bermakna, bukan sesuatu yang bisa terketik tak sengaja', () => {
    for (const frasa of Object.values(FRASA_KONFIRMASI)) {
      expect(frasa.length).toBeGreaterThanOrEqual(15);
      expect(frasa.split(' ').length).toBeGreaterThanOrEqual(3);
    }
  });

  test('pencocokan frasa: toleran pada kapitalisasi & spasi berlebih, tetap menolak yang beda', () => {
    expect(cocokFrasaKonfirmasi('hapus data transaksi', 'TRANSAKSI')).toBe(true);
    expect(cocokFrasaKonfirmasi('  HAPUS  DATA   TRANSAKSI  ', 'TRANSAKSI')).toBe(true);
    expect(cocokFrasaKonfirmasi('HapusDataTransaksi', 'TRANSAKSI')).toBe(false);
    expect(cocokFrasaKonfirmasi('HAPUS DATA TRANSAKS', 'TRANSAKSI')).toBe(false);
    expect(cocokFrasaKonfirmasi('', 'TRANSAKSI')).toBe(false);
    expect(cocokFrasaKonfirmasi('RESET TOTAL SEMUA DATA', 'TOTAL')).toBe(true);
  });

  test('BERGANTI MODE mengosongkan lapis yang sudah dilewati — celah paling berbahaya', () => {
    // Semua lapis sudah siap untuk mode ringan...
    const siapTransaksi = statusLengkap();
    expect(bolehJalankanReset(siapTransaksi)).toBe(true);

    // ...lalu pengguna menyentuh kartu "Reset Total". Tombol terakhir
    // TIDAK BOLEH langsung aktif untuk tindakan yang jauh lebih merusak.
    const pindahKeTotal = gantiMode(siapTransaksi, 'TOTAL');
    expect(pindahKeTotal.mode).toBe('TOTAL');
    expect(bolehJalankanReset(pindahKeTotal)).toBe(false);
    expect(pindahKeTotal.dampakDipahami).toBe(false);
    expect(pindahKeTotal.frasaDiketik).toBe('');
    expect(pindahKeTotal.pinTerverifikasi).toBe(false);
    expect(pindahKeTotal.lanjutTanpaBackup).toBe(false);
  });

  test('berganti mode TIDAK membuang backup yang berkasnya sudah benar-benar dibuat', () => {
    const setelah = gantiMode(statusLengkap({ backupDibuat: true }), 'TOTAL');
    expect(setelah.backupDibuat).toBe(true);
    // Tetap terkunci karena lapis lainnya dikosongkan.
    expect(bolehJalankanReset(setelah)).toBe(false);
  });

  test('memilih mode yang SAMA tidak mengosongkan kemajuan (bukan perangkap salah sentuh)', () => {
    const status = statusLengkap();
    expect(gantiMode(status, 'TRANSAKSI')).toBe(status);
  });

  test('tombol terakhir harus DITAHAN, bukan sekali tekan', () => {
    expect(DURASI_TAHAN_MS).toBeGreaterThanOrEqual(2000);
  });
});

// ============================================================
// A2. KELENGKAPAN CAKUPAN TABEL (dibaca dari schema.ts)
// ============================================================

/** Nama seluruh tabel yang benar-benar dibuat oleh schema.ts. */
function tabelDariSkema(): string[] {
  const sumber = fs.readFileSync(path.join(process.cwd(), 'src/database/schema.ts'), 'utf8');
  return [...sumber.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)\s*\(/g)].map((m) => m[1]);
}

describe('RC-S99 §A2 — tidak ada tabel yang luput dari keputusan sadar', () => {
  test('setiap tabel skema terdaftar sebagai DIHAPUS atau DIPERTAHANKAN, tidak keduanya', () => {
    const semua = tabelDariSkema();
    expect(semua.length).toBeGreaterThan(50); // pengaman: regex benar-benar menemukan tabel

    const hasil = periksaCakupanTabelReset(semua);
    // Kalau test ini gagal, ada tabel BARU pada skema yang belum
    // diklasifikasikan. Itu berarti "Hapus Data Transaksi" akan
    // meninggalkan data lama di sana tanpa ada yang tahu.
    expect(hasil.belumDiklasifikasikan).toEqual([]);
    expect(hasil.ganda).toEqual([]);
    expect(hasil.tidakDikenal).toEqual([]);
  });

  test('hal-hal yang pengguna paling takut hilang memang ada di daftar dipertahankan', () => {
    for (const tabel of ['app_user', 'role_permission', 'koperasi', 'account', 'account_mapping', 'app_config', 'audit_log']) {
      expect(TABEL_DIPERTAHANKAN_TRANSAKSI).toContain(tabel);
      expect(TABEL_RESET_TRANSAKSI).not.toContain(tabel);
    }
  });

  test('penomoran otomatis ikut dikosongkan supaya nomor data baru mulai dari 1', () => {
    expect(TABEL_RESET_TRANSAKSI).toContain('sequence_counter');
  });

  test('kelompok ringkasan hanya menghitung tabel yang memang akan dihapus', () => {
    for (const kelompok of KELOMPOK_RINGKASAN) {
      for (const tabel of kelompok.tabel) {
        expect(TABEL_RESET_TRANSAKSI).toContain(tabel);
      }
    }
  });

  test('nama tabel di luar rencana ditolak keras sebelum masuk ke SQL', () => {
    expect(() => pastikanTabelTerdaftar('anggota')).not.toThrow();
    expect(() => pastikanTabelTerdaftar('app_user')).not.toThrow();
    expect(() => pastikanTabelTerdaftar('tabel_karangan')).toThrow(/tidak terdaftar/);
    expect(() => pastikanTabelTerdaftar('anggota; DROP TABLE account')).toThrow(/tidak terdaftar/);
  });
});

// ============================================================
// B. EKSEKUSI NYATA DI SQLite
// ============================================================

const ACC = { kas: 'acc-kas', pendapatan: 'acc-pendapatan' };

async function siapkanDbBerisi(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();

  // --- Konfigurasi & identitas yang WAJIB selamat
  await db.runAsync(
    `INSERT INTO koperasi (id, nama, alamat, tahun_buku_aktif, standar_akuntansi, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    'kop-1',
    'KSP Kenanga',
    'Jl. Mawar 1',
    2026,
    'SAK_EP',
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, pin_hash, pin_salt, role, aktif, created_at, updated_at)
     VALUES (?,?,?,?,?,?,1,?,?)`,
    'user-1',
    'Admin',
    'admin',
    'hash',
    'salt',
    'ADMIN',
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)`,
    'security.pin_enabled',
    '1',
    now
  );
  for (const [id, kode, nama, kategori, nb] of [
    [ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT'],
    [ACC.pendapatan, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT'],
  ] as const) {
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,1,?,?)`,
      id,
      kode,
      nama,
      kategori,
      nb,
      now,
      now
    );
  }
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  // --- Data operasional yang HARUS hilang
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,'AKTIF',?,?)`,
    'ang-1',
    'A-0001',
    'Budi',
    '2026-01-05',
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO simpanan_transaksi
       (id, anggota_id, jenis, tipe, nominal, tanggal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'simp-1',
    'ang-1',
    'POKOK',
    'SETOR',
    100_000,
    '2026-01-05',
    'KAS',
    'SP-0001',
    'user-1',
    now
  );
  await db.runAsync(
    `INSERT INTO sequence_counter (seq_key, last_value) VALUES (?,?)`,
    'SP-2026',
    7
  );
  await createJournal(db as never, {
    tanggal: '2026-02-01',
    sumberTransaksi: 'TEST',
    deskripsi: 'pendapatan jasa',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.kas, debit: 500_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 500_000 },
    ],
  });
  // Jejak audit — harus selamat, justru inilah bukti resetnya terjadi.
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, created_at) VALUES (?,?,?,?,?,?,?)`,
    'audit-1',
    'user-1',
    '2026-02-01',
    '08:00:00',
    'LOGIN',
    'app_user',
    now
  );

  return db;
}

const jumlah = async (db: TestDb, tabel: string): Promise<number> =>
  Number((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabel}`))?.n ?? 0);

describe('RC-S99 §B — eksekusi "Hapus Data Transaksi" di SQLite sungguhan', () => {
  test('ringkasan sebelum reset melaporkan jumlah baris yang NYATA, bukan perkiraan', async () => {
    const db = await siapkanDbBerisi();
    const ringkasan = await hitungRingkasanDataTransaksi(db as never);

    const cari = (label: string) => ringkasan.find((r) => r.label === label)?.jumlah;
    expect(cari('Anggota')).toBe(1);
    expect(cari('Transaksi simpanan')).toBe(1);
    expect(cari('Jurnal (beserta barisnya)')).toBe(1);
    expect(cari('Pinjaman')).toBe(0);
    // Setiap kelompok terlaporkan, termasuk yang nol — pengguna melihat
    // gambaran penuh, bukan hanya yang ada isinya.
    expect(ringkasan).toHaveLength(KELOMPOK_RINGKASAN.length);
  });

  test('data operasional hilang, konfigurasi & login utuh, tanpa referensi menggantung', async () => {
    const db = await siapkanDbBerisi();

    const auditSebelum = await db.getAllAsync<{ id: string }>(`SELECT id FROM audit_log ORDER BY id`);
    expect(auditSebelum.length).toBeGreaterThan(0);

    const hasil = await resetDataTransaksiPadaDb(db as never);
    expect(hasil.totalBarisTerhapus).toBeGreaterThan(0);

    // HILANG
    for (const tabel of ['anggota', 'simpanan_transaksi', 'journal', 'journal_entry', 'sequence_counter']) {
      expect(await jumlah(db, tabel)).toBe(0);
    }

    // UTUH — termasuk login pengguna, yang kalau sampai hilang membuat
    // aplikasi tidak bisa dibuka lagi sama sekali.
    expect(await jumlah(db, 'app_user')).toBe(1);
    expect(await jumlah(db, 'koperasi')).toBe(1);
    expect(await jumlah(db, 'account')).toBe(2);
    expect(await jumlah(db, 'app_config')).toBe(1);
    expect(await jumlah(db, 'accounting_period')).toBe(1);
    // Jejak audit selamat SELURUHNYA — dicek per baris, bukan lewat
    // jumlah total, karena `createJournal` juga menulis jejaknya sendiri
    // di tabel ini (jadi isinya lebih dari satu baris sejak fixture).
    const auditSetelah = await db.getAllAsync<{ id: string }>(`SELECT id FROM audit_log ORDER BY id`);
    expect(auditSetelah.map((r) => r.id)).toContain('audit-1');
    expect(auditSetelah.length).toBe(auditSebelum.length);

    // Tidak ada orphan yang tertinggal.
    expect(await db.getAllAsync('PRAGMA foreign_key_check')).toEqual([]);
  });

  test('jurnal ikut terhapus beserta seluruh barisnya — buku besar tidak setengah terhapus', async () => {
    const db = await siapkanDbBerisi();
    expect(await jumlah(db, 'journal_entry')).toBe(2);

    await resetDataTransaksiPadaDb(db as never);

    expect(await jumlah(db, 'journal')).toBe(0);
    expect(await jumlah(db, 'journal_entry')).toBe(0);
  });

  test('idempoten: menjalankan dua kali tidak melempar dan yang kedua tidak menghapus apa pun', async () => {
    const db = await siapkanDbBerisi();
    await resetDataTransaksiPadaDb(db as never);

    const kedua = await resetDataTransaksiPadaDb(db as never);
    expect(kedua.totalBarisTerhapus).toBe(0);
    expect(kedua.terhapus).toEqual({});
    expect(await jumlah(db, 'app_user')).toBe(1);
  });

  test('database yang memang kosong tidak membuat reset gagal', async () => {
    const db = await createTestDb();
    const hasil = await resetDataTransaksiPadaDb(db as never);
    expect(hasil.totalBarisTerhapus).toBe(0);
  });

  test('laporan per tabel hanya memuat tabel yang benar-benar ada isinya', async () => {
    const db = await siapkanDbBerisi();
    const hasil = await resetDataTransaksiPadaDb(db as never);

    expect(hasil.terhapus.anggota).toBe(1);
    expect(hasil.terhapus.journal_entry).toBe(2);
    // Tabel kosong tidak dilaporkan — supaya ringkasannya terbaca.
    expect(hasil.terhapus.pinjaman).toBeUndefined();
    // Dan tidak ada tabel dipertahankan yang muncul di laporan penghapusan.
    for (const tabel of Object.keys(hasil.terhapus)) {
      expect(TABEL_DIPERTAHANKAN_TRANSAKSI).not.toContain(tabel);
    }
  });
});

describe('RC-S99 §B2 — jaring pengaman referensi menggantung benar-benar bekerja', () => {
  /**
   * Mensimulasikan PERSIS kegagalan yang dua lapis pengaman di
   * `resetDataTransaksiPadaDb` dipasang untuk menangkap: ada tabel yang
   * menunjuk ke tabel yang dihapus tetapi tidak ikut terdaftar di
   * `TABEL_RESET_TRANSAKSI` — misalnya tabel baru ditambahkan ke skema
   * dan lupa diklasifikasikan. Tabel tambahannya dibuat di dalam test,
   * bukan di skema produksi.
   *
   * Ada DUA lapis, dan keduanya diuji terpisah di bawah:
   *   1. `PRAGMA foreign_keys` ON (kondisi produksi, lihat
   *      assertForeignKeysEnabled di database/db.ts) — DELETE-nya sendiri
   *      sudah ditolak SQLite.
   *   2. Enforcement mati — DELETE lolos dan meninggalkan orphan, lalu
   *      `PRAGMA foreign_key_check` sebelum COMMIT yang menangkapnya.
   * Yang wajib sama pada keduanya: transaksi di-ROLLBACK, dan TIDAK ADA
   * satu baris pun yang hilang.
   */
  async function dbDenganReferensiMenggantung(): Promise<TestDb> {
    const db = await siapkanDbBerisi();
    await db.execAsync(`
      CREATE TABLE tabel_baru_belum_terdaftar (
        id TEXT PRIMARY KEY,
        anggota_id TEXT NOT NULL REFERENCES anggota(id)
      );
    `);
    await db.runAsync(`INSERT INTO tabel_baru_belum_terdaftar (id, anggota_id) VALUES (?,?)`, 'x-1', 'ang-1');
    return db;
  }

  const TABEL_DIPANTAU = [
    'anggota',
    'simpanan_transaksi',
    'journal',
    'journal_entry',
    'sequence_counter',
    'app_user',
  ];

  /** Cuplikan jumlah baris — dibandingkan sebelum vs sesudah, bukan angka hafalan. */
  async function cuplikan(db: TestDb): Promise<Record<string, number>> {
    const hasil: Record<string, number> = {};
    for (const t of TABEL_DIPANTAU) hasil[t] = await jumlah(db, t);
    return hasil;
  }

  test('lapis 1 (FK enforcement aktif, seperti produksi): DELETE ditolak dan seluruh data tetap utuh', async () => {
    const db = await dbDenganReferensiMenggantung();
    await db.execAsync('PRAGMA foreign_keys = ON;');

    const sebelum = await cuplikan(db);
    await expect(resetDataTransaksiPadaDb(db as never)).rejects.toThrow(/FOREIGN KEY/i);
    expect(await cuplikan(db)).toEqual(sebelum);
  });

  test('lapis 2 (enforcement mati): pemeriksaan sebelum COMMIT menangkap orphan dan membatalkan reset', async () => {
    const db = await dbDenganReferensiMenggantung();
    // Enforcement dimatikan HANYA di test ini, untuk mengisolasi lapis
    // kedua. Produksi tidak pernah berjalan seperti ini — justru
    // `assertForeignKeysEnabled` akan gagal keras kalau sampai terjadi.
    await db.execAsync('PRAGMA foreign_keys = OFF;');

    const sebelum = await cuplikan(db);
    await expect(resetDataTransaksiPadaDb(db as never)).rejects.toThrow(/referensi menggantung/);
    expect(await cuplikan(db)).toEqual(sebelum);
  });
});

// ============================================================
// C. LAYAR — lapis tidak boleh disusun ulang di UI
// ============================================================

describe('RC-S99 §C — layar memakai gerbang tunggal, bukan syarat karangan sendiri', () => {
  const layar = fs.readFileSync(
    path.join(process.cwd(), 'src/screens/Pengaturan/ResetDataScreen.tsx'),
    'utf8'
  );

  test('kelayakan reset diambil dari bolehJalankanReset(), tidak dirakit ulang di layar', () => {
    expect(layar).toContain('bolehJalankanReset(status)');
    // Kalau syaratnya ditulis ulang di layar sebagai rangkaian && atas
    // field status, satu lapis bisa lupa diikutkan saat tata letak
    // diubah. Itulah yang dijaga di sini.
    expect(layar).not.toMatch(/status\.dampakDipahami\s*&&\s*status\./);
  });

  test('tombol terakhir memakai tahan-tekan (onPressIn/onPressOut), bukan onPress sekali tekan', () => {
    expect(layar).toContain('onPressIn=');
    expect(layar).toContain('onPressOut=');
    expect(layar).toContain('DURASI_TAHAN_MS');
  });

  test('masih ada satu dialog penutup setelah tombol ditahan penuh', () => {
    expect(layar).toContain('konfirmasiTerakhir');
    expect(layar).toMatch(/style: 'destructive'/);
  });

  test('berganti mode di layar memakai gantiMode() yang mengosongkan lapis', () => {
    expect(layar).toContain('gantiMode(s, mode)');
  });

  test('layar menolak role non-Admin, tidak hanya bergantung pada filter menu', () => {
    expect(layar).toMatch(/currentUser\.role !== 'ADMIN'/);
  });

  test('entri menu Reset Data ditandai danger & diperiksa pada level approve', () => {
    const pengaturan = fs.readFileSync(
      path.join(process.cwd(), 'src/screens/Pengaturan/PengaturanScreen.tsx'),
      'utf8'
    );
    expect(pengaturan).toMatch(/route: 'ResetData'[\s\S]{0,400}?aksi: 'approve'/);
    expect(pengaturan).toMatch(/route: 'ResetData'[\s\S]{0,400}?danger: true/);
    // Dirender di bagian terpisah, bukan berbaur dengan menu harian.
    expect(pengaturan).toContain('Zona Berbahaya');
  });

  test('service reset meng-hardcode ADMIN-only, tidak hanya mengandalkan matrix izin', () => {
    const service = fs.readFileSync(path.join(process.cwd(), 'src/services/ResetDataService.ts'), 'utf8');
    expect(service).toMatch(/role !== 'ADMIN'/);
    expect(service).toContain('pastikanAdmin');
    // Kedua jalur reset wajib lewat penjaga itu.
    expect(service).toMatch(/resetDataTransaksi[\s\S]{0,200}?await pastikanAdmin/);
    expect(service).toMatch(/resetTotal[\s\S]{0,200}?await pastikanAdmin/);
  });

  test('eksekusi SQL tidak pernah mematikan foreign key, dan memeriksa orphan sebelum commit', () => {
    const eksekusi = fs.readFileSync(path.join(process.cwd(), 'src/services/ResetDataTransaksi.ts'), 'utf8');
    expect(eksekusi).not.toMatch(/foreign_keys\s*=\s*OFF/i);
    // Harus PEMANGGILANNYA, bukan sekadar frasa di komentar. Versi
    // pertama test ini hanya mencari teks 'PRAGMA foreign_key_check'
    // dan tetap lulus ketika pemanggilan aslinya dihapus — kalimatnya
    // masih ada di docblock. Diperketat menjadi pola pemanggilan.
    expect(eksekusi).toMatch(/await db\.getAllAsync[^\n]*'PRAGMA foreign_key_check'/);
    expect(eksekusi).toContain('ROLLBACK');
  });
});
