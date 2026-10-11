import { createTestDb, TestDb } from './testDb';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S94 — BUG: jasa yang dibayar di muka tidak masuk Laporan Hasil
 * Usaha setelah waktu diganti lewat Mode Pengujian Waktu (Developer).
 *
 * AKAR MASALAH: tiga pekerjaan otomatis yang dijalankan `StartupTasks`
 * — `jalankanAkrualJasaOtomatisJikaPerlu`, `jalankanPenyusutanOtomatisJikaPerlu`,
 * `jalankanEirOtomatisJikaPerlu` — punya parameter `tanggalSekarang`
 * dengan default `new Date()` (jam ASLI perangkat) dan dipanggil tanpa
 * argumen. Jadi walau "hari ini" aplikasi sudah dilompatkan, pelepasan
 * Pendapatan Diterima Dimuka -> Pendapatan Jasa tetap dihitung per
 * tanggal ASLI, dan periode yang sudah "jatuh tempo" menurut jam
 * simulasi tidak pernah diakui.
 *
 * Tahun 2040 dipakai supaya test ini tidak bergantung pada tanggal asli
 * saat test dijalankan: menurut jam asli, jadwal 2040 BELUM jatuh tempo;
 * menurut jam simulasi 2041, SEMUANYA sudah jatuh tempo.
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


const ANGGOTA_ID = 'anggota-1';
const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanAdmin: 'acc-pendapatan-admin',
  modal: 'acc-modal',
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
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}

async function seedMapping(db: TestDb, tipe: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tipe}-${role}`, tipe, role, accountId
  );
}

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  // Fixture menyeed simpanan_transaksi (syarat eligibilitas pinjaman),
  // jadi domain simpanan WAJIB punya akun & mapping — kalau tidak,
  // rekonsiliasi akan gagal keras, dan itu memang perilaku yang benar.
  await seedAccount(testDb, 'acc-simp-pokok', '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, 'acc-simp-wajib', '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  // Mapping yang dipakai jurnal pelunasan untuk jasa masa depan.
  await seedMapping(testDb, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT', 'acc-simp-pokok');
  await seedMapping(testDb, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT', 'acc-simp-wajib');

  for (const [id, tahun] of [['period-2026', 2026], ['period-2040', 2040], ['period-2041', 2041]] as const) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      id, tahun, `${tahun}-01-01`, `${tahun}-12-31`
    );
  }

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'A001', '1234567890123456', 'Budi', '2020-01-01', now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  // Simpanan diseed BERSAMA jurnalnya supaya subledger dan GL konsisten
  // sejak awal — fixture yang menulis subledger tanpa jurnal akan
  // menghasilkan selisih rekonsiliasi yang bukan berasal dari bug.
  for (const [id, jenis, nominal, akun] of [
    ['sp-f', 'POKOK', 100000, 'acc-simp-pokok'],
    ['sw-f', 'WAJIB', 50000, 'acc-simp-wajib'],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES (?,?,'2026-01-02','period-2026',?,'Setoran simpanan (fixture)','POSTED','user-1',?,?,?)`,
      `j-${id}`, `JRN-${id}`, jenis === 'POKOK' ? 'SIMPANAN_POKOK' : 'SIMPANAN_WAJIB', now, now, now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
      `je-${id}-d`, `j-${id}`, ACC.kas, nominal
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
      `je-${id}-k`, `j-${id}`, akun, nominal
    );
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,'SETOR','2026-01-02',?,'KAS',?,'user-1',?)`,
      id, ANGGOTA_ID, jenis, nominal, id, now
    );
  }
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-MODAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-md','j-modal',?,?,0)`,
    ACC.kas, 100_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-mk','j-modal',?,0,?)`,
    ACC.modal, 100_000_000
  );
}

/** Saldo GL akun 2-1300 (liabilitas, normal balance KREDIT). */
async function saldoGlDeferred(): Promise<number> {
  const row = await testDb.getFirstAsync<{ saldo: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit), 0) as saldo
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    ACC.pendapatanDimuka
  );
  return row?.saldo ?? 0;
}

/** Subledger deferred = SUM(angsuran_jadwal.jasa_dimuka). */
async function subledgerDeferred(): Promise<number> {
  const row = await testDb.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(jasa_dimuka), 0) as total FROM angsuran_jadwal`
  );
  return row?.total ?? 0;
}

async function pendapatanJasaGl(): Promise<number> {
  const row = await testDb.getFirstAsync<{ saldo: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit), 0) as saldo
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    ACC.pendapatanJasa
  );
  return row?.saldo ?? 0;
}


import { ajukanPinjaman, cairkanPinjaman, lunasiPinjaman } from '@/services/PinjamanService';
import { jalankanAkrualJasaOtomatisJikaPerlu } from '@/services/AkrualJasaPinjamanService';
import {
  _resetStateUntukTest,
  setJamUjiAktif,
  setWaktuKustom,
} from '@/services/DevClockService';

async function aturJamSimulasi(tanggalIso: string): Promise<void> {
  await setJamUjiAktif(testDb as any, true);
  await setWaktuKustom(testDb as any, tanggalIso, '09:00');
}

/** Pinjaman 2040 dilunasi di awal -> jasa angsuran masa depan masuk Pendapatan Diterima Dimuka. */
async function buatDanLunasi2040(): Promise<number> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2040-01-01',
    jumlahPinjaman: 12_000_000,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA',
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2040-01-01' });
  const hasil = await lunasiPinjaman({
    pinjamanId: id,
    tanggal: '2040-03-01',
    sumberDana: 'KAS',
    createdBy: 'user-1',
    metodeJasaPelunasan: 'JASA_KONTRAKTUAL',
  });
  return hasil.jasaFuturePendingEirAccounting;
}

describe('RC-S94 — akrual jasa otomatis mengikuti jam simulasi', () => {
  beforeEach(async () => {
    _resetStateUntukTest();
    await setupFixture();
  });

  afterEach(() => {
    _resetStateUntukTest();
  });

  test('setelah waktu dilompatkan, jasa diterima di muka PINDAH ke Pendapatan Jasa (masuk LHU)', async () => {
    await aturJamSimulasi('2040-03-01');
    const deferredAwal = await buatDanLunasi2040();
    expect(deferredAwal).toBeGreaterThan(0);
    expect(await saldoGlDeferred()).toBe(deferredAwal);
    const pendapatanSebelum = await pendapatanJasaGl();

    // Pengguna mengganti waktu di menu Developer: seluruh jadwal kini jatuh tempo.
    await aturJamSimulasi('2041-06-15');

    // Dipanggil PERSIS seperti StartupTasks — TANPA argumen tanggal.
    const hasil = await jalankanAkrualJasaOtomatisJikaPerlu('user-1');

    expect(hasil.error).toBeUndefined();
    expect(hasil.periodeDiproses.length).toBeGreaterThan(0);
    // Seluruh jasa diterima di muka sudah dilepas ke pendapatan...
    expect(await saldoGlDeferred()).toBe(0);
    expect(await subledgerDeferred()).toBe(0);
    // ...dan pendapatan jasa (baris LHU) bertambah persis sebesar itu.
    expect((await pendapatanJasaGl()) - pendapatanSebelum).toBe(deferredAwal);
  });

  test('mode pengujian MATI -> tetap memakai jam asli (jadwal 2040 belum diakui)', async () => {
    // Buat data di bawah jam simulasi, lalu MATIKAN mode: aplikasi harus
    // kembali memakai jam asli perangkat, di mana 2040 belum tiba.
    await aturJamSimulasi('2040-03-01');
    const deferredAwal = await buatDanLunasi2040();
    await setJamUjiAktif(testDb as any, false);

    await jalankanAkrualJasaOtomatisJikaPerlu('user-1');

    expect(await saldoGlDeferred()).toBe(deferredAwal);
  });

  test('tanggal eksplisit tetap dihormati (injeksi tanggal untuk test lama tidak berubah)', async () => {
    await aturJamSimulasi('2040-03-01');
    const deferredAwal = await buatDanLunasi2040();

    // Jam simulasi 2041, tetapi pemanggil mengoper tanggal eksplisit 2040-03-01.
    await aturJamSimulasi('2041-06-15');
    await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date(2040, 2, 1));

    expect(await saldoGlDeferred()).toBe(deferredAwal);
  });
});

describe('RC-S94 — tidak ada pekerjaan otomatis yang default ke jam asli', () => {
  const ROOT = join(__dirname, '..', '..');
  const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each([
    ['AkrualJasaPinjamanService', 'jalankanAkrualJasaOtomatisJikaPerlu'],
    ['PenyusutanService', 'jalankanPenyusutanOtomatisJikaPerlu'],
    ['EirAccountingService', 'jalankanEirOtomatisJikaPerlu'],
  ])('%s.%s memakai jam aplikasi (getWaktuSekarang), bukan new Date()', (berkas, fungsi) => {
    const src = tanpaKomentar(readFileSync(join(ROOT, `src/services/${berkas}.ts`), 'utf8'));
    const tanda = src.slice(src.indexOf(`export async function ${fungsi}(`));
    // Batas daftar parameter = `): Promise<` (bukan `)` pertama, yang bisa
    // jatuh di dalam `getWaktuSekarang()` sendiri).
    const parameter = tanda.slice(0, tanda.indexOf('): Promise<'));
    expect(parameter).toMatch(/tanggalSekarang: Date = getWaktuSekarang\(\)/);
    expect(parameter).not.toMatch(/new Date\(\)/);
  });
});

describe('RC-S94 — perubahan waktu langsung memicu pengejaran periode & LHU menunggunya', () => {
  const ROOT = join(__dirname, '..', '..');
  const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('setiap perubahan waktu di menu Developer meminta tugas latar dijalankan ulang', () => {
    const src = tanpaKomentar(readFileSync(join(ROOT, 'src/screens/Pengaturan/DeveloperScreen.tsx'), 'utf8'));
    const corong = src.slice(src.indexOf('const jalankan = async'), src.indexOf('const toggleAktif'));
    // Permintaan dilakukan SETELAH perubahan tersimpan, di satu-satunya
    // corong yang dipakai semua aksi (sakelar, real-time, kustom, preset, tahun).
    expect(corong).toMatch(/await fn\(db\);[\s\S]*requestStartupTask\(\)/);
  });

  it('Laporan Hasil Usaha menunggu tugas latar selesai SEBELUM menghitung', () => {
    const src = tanpaKomentar(readFileSync(join(ROOT, 'src/screens/Laporan/LabaRugiScreen.tsx'), 'utf8'));
    const iTunggu = src.indexOf('await tungguTugasStartupSelesai()');
    const iHitung = src.indexOf('getLHU(db,');
    expect(iTunggu).toBeGreaterThan(0);
    expect(iTunggu).toBeLessThan(iHitung);
  });
});
