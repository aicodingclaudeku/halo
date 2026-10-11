/**
 * RC-S84 — MENU PAJAK (Pengeluaran > Kewajiban > Pajak).
 *
 * PRINSIP (lihat ATURAN_BISNIS.md §19):
 *  - TANPA migrasi skema. Pengaturan disimpan di `app_config`; masa pajak
 *    di `journal.sumber_id`; NTPN & masa setoran di keterangan jurnal.
 *  - Akun pajak baru (pajakPolicy.AKUN_PAJAK_BARU) disisipkan idempoten per
 *    kode di dalam transaksi pencatatan pertama — tidak ada akun/mapping
 *    existing yang diubah.
 *  - REUSE jalur yang sudah teruji:
 *      * setoran utang pajak  -> UtangService.bayarKewajibanCoa()
 *        (menolak setoran > saldo, menolak akun non-kewajiban-umum)
 *      * angsuran PPh 25      -> KasBankService.catatPengeluaran()
 *        (cek saldo kas/bank, idempotensi BUG-07)
 *      * pengakuan non-kas    -> AccountingEngine.createJournal()
 *        (guard periode tertutup, akun nonaktif, balance)
 *  - Tidak ada rumus akuntansi existing yang disentuh.
 */

import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, getAccountBalance, reverseJournal } from '@/accounting/AccountingEngine';
import { requirePermission } from '@/services/PermissionService';
import { catatPengeluaran, JenisRekening } from '@/services/KasBankService';
import { bayarKewajibanCoa } from '@/services/UtangService';
import { newId } from '@/utils/id';
import { Rupiah, formatRupiah } from '@/utils/money';
import { tanggalAkhirPeriode, isValidPeriode } from '@/accounting/PeriodeUtil';
import { getPeriodeLokalSekarang, getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import { getRingkasanPphBungaSimpananBulanIni, RingkasanPphBungaSimpananBulanIni } from '@/services/PphPotongService';
import {
  AKUN_PAJAK_BARU,
  BATAS_OMZET_FINAL,
  CONFIG_KEY_PENGATURAN_PAJAK,
  JENIS_PAJAK_PER_AKUN,
  KODE_AKUN_RIWAYAT_PAJAK,
  KODE_BEBAN_PAJAK,
  KODE_PAJAK_DIBAYAR_DIMUKA,
  KODE_UTANG_PAJAK_SETORAN,
  KODE_UTANG_PPH_29,
  KODE_UTANG_PPH_FINAL,
  KODE_UTANG_PPH_BUNGA_SIMPANAN,
  PengaturanPajak,
  SkemaPajak,
  SUMBER_PENGAKUAN_PAJAK,
  cekKelayakanFinal,
  HasilRezimPajak,
  kebijakanUntukTahun,
  LABEL_REZIM,
  OverrideRezim,
  RezimPajak,
  tentukanRezimPajak,
  daftarMasa,
  rincianPphFinal,
  RincianPerhitungan,
  AkunOmzetRincian,
  hitungPphBadan,
  hitungPphFinal,
  kunciAngsuranPph25,
  kunciPphBadan,
  kunciPphFinal,
  labelMasa,
  susunKeteranganAngsuranPph25,
  susunKeteranganSetoran,
  validasiNtpn,
  validasiPengaturanPajak,
} from '@/config/pajakPolicy';

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function idAkunByKode(db: SQLite.SQLiteDatabase, kode: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ id: string; is_active: number }>(`SELECT id, is_active FROM account WHERE kode = ?`, kode);
  return row?.id ?? null;
}

async function wajibAkun(db: SQLite.SQLiteDatabase, kode: string, nama: string): Promise<string> {
  const id = await idAkunByKode(db, kode);
  if (!id) throw new Error(`Akun ${kode} (${nama}) tidak ditemukan di Chart of Accounts.`);
  return id;
}

/**
 * Sisipkan akun pajak baru yang belum ada (cek per kode). Idempoten; tidak
 * menyentuh akun yang sudah ada (termasuk bila admin mengganti namanya).
 * WAJIB dipanggil di dalam transaksi pencatatan.
 */
export async function pastikanAkunPajak(db: SQLite.SQLiteDatabase): Promise<void> {
  const now = new Date().toISOString();
  for (const a of AKUN_PAJAK_BARU) {
    if (await idAkunByKode(db, a.kode)) continue;
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES (?,?,?,?,?,1,1,NULL,?,?)`,
      newId(),
      a.kode,
      a.nama,
      a.kategori,
      a.normalBalance,
      now,
      now
    );
  }
}

/**
 * RC-S86 — akun 2-1901 (Utang PPh Pasal 4(2) Bunga Simpanan). Dipakai
 * HANYA oleh `SimpananBerjangkaLifecycleService` (§B transfer & pencairan),
 * lewat `pastikanAkunPajak()` yang SAMA dipakai seluruh menu Pajak — TIDAK
 * ada mekanisme sisip akun kedua. Diletakkan di sini (bukan di
 * PphPotongService.ts) supaya PphPotongService tetap ringan (murni hitung
 * + catat riwayat) dan tidak membentuk import siklik dengan PajakService.
 */
export async function idAkunUtangPphBungaSimpanan(db: SQLite.SQLiteDatabase): Promise<string> {
  await pastikanAkunPajak(db);
  const id = await idAkunByKode(db, KODE_UTANG_PPH_BUNGA_SIMPANAN);
  if (!id) throw new Error(`Akun ${KODE_UTANG_PPH_BUNGA_SIMPANAN} (Utang PPh Pasal 4(2) Bunga Simpanan) gagal disiapkan.`);
  return id;
}

async function bacaPengaturan(db: SQLite.SQLiteDatabase): Promise<PengaturanPajak | null> {
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key = ?`, CONFIG_KEY_PENGATURAN_PAJAK);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<PengaturanPajak>;
    if ((v.skema === 'FINAL_UMKM' || v.skema === 'UMUM') && Number.isInteger(v.tahunTerdaftar)) {
      return { skema: v.skema, tahunTerdaftar: v.tahunTerdaftar as number };
    }
  } catch {
    // nilai rusak diperlakukan sebagai belum diatur — pengguna diminta mengisi ulang
  }
  return null;
}

async function jurnalPengakuanAda(db: SQLite.SQLiteDatabase, kunci: string): Promise<{ nomor_jurnal: string; tanggal: string } | null> {
  return db.getFirstAsync<{ nomor_jurnal: string; tanggal: string }>(
    `SELECT nomor_jurnal, tanggal FROM journal
      WHERE sumber_transaksi = ? AND sumber_id = ? AND status = 'POSTED' AND reversal_of_id IS NULL`,
    SUMBER_PENGAKUAN_PAJAK,
    kunci
  );
}

/** RC-S87 — ekspor helper internal untuk PajakBadanService (satu arah, tanpa import siklik). */
export const bacaPengaturanPadaDb = bacaPengaturan;
export const jurnalPengakuanPajakAda = jurnalPengakuanAda;

// ---------------------------------------------------------------------------
// RC-S87 — Tabel aditif (self-heal idempoten; SCHEMA_VERSION tidak dinaikkan)
// ---------------------------------------------------------------------------

export async function pastikanTabelRezimPajak(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS pajak_rezim_evaluasi (
      id TEXT PRIMARY KEY,
      tahun_pajak INTEGER NOT NULL,
      rezim TEXT CHECK (rezim IN ('FINAL_UMKM','BADAN_31E','BADAN_UMUM')),
      sumber TEXT NOT NULL CHECK (sumber IN ('OTOMATIS','OVERRIDE','BELUM_DIATUR')),
      alasan_json TEXT NOT NULL,
      peringatan_json TEXT NOT NULL,
      dasar_aturan_json TEXT NOT NULL,
      parameter_json TEXT NOT NULL,
      versi_kebijakan TEXT NOT NULL,
      konteks TEXT NOT NULL,
      dievaluasi_oleh TEXT NOT NULL,
      dievaluasi_pada TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pajak_rezim_evaluasi_tahun ON pajak_rezim_evaluasi(tahun_pajak);
    CREATE TABLE IF NOT EXISTS pajak_rezim_override (
      id TEXT PRIMARY KEY,
      tahun_pajak INTEGER NOT NULL,
      rezim TEXT NOT NULL CHECK (rezim IN ('FINAL_UMKM','BADAN_31E','BADAN_UMUM')),
      alasan TEXT NOT NULL,
      nomor_dokumen TEXT NOT NULL,
      tanggal_dokumen TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('AKTIF','DICABUT')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dicabut_oleh TEXT,
      dicabut_pada TEXT,
      alasan_cabut TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pajak_rezim_override_tahun ON pajak_rezim_override(tahun_pajak, status);
    CREATE TABLE IF NOT EXISTS pajak_pengecualian_omzet (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      alasan TEXT NOT NULL,
      dasar_aturan TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('AKTIF','DICABUT')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dicabut_oleh TEXT,
      dicabut_pada TEXT
    );
  `);
}

// ---------------------------------------------------------------------------
// RC-S87 — Pengecualian omzet TERKONFIGURASI (bukan hanya centang di UI)
// ---------------------------------------------------------------------------

export interface PengecualianOmzet {
  id: string;
  accountId: string;
  kode: string;
  nama: string;
  alasan: string;
  dasarAturan: string;
  createdBy: string;
  createdAt: string;
}

async function idAkunDikecualikanPadaDb(db: SQLite.SQLiteDatabase): Promise<Set<string>> {
  await pastikanTabelRezimPajak(db);
  const rows = await db.getAllAsync<{ account_id: string }>(`SELECT account_id FROM pajak_pengecualian_omzet WHERE status = 'AKTIF'`);
  return new Set(rows.map((r) => r.account_id));
}

export async function listPengecualianOmzet(): Promise<PengecualianOmzet[]> {
  const db = await getDb();
  await pastikanTabelRezimPajak(db);
  const rows = await db.getAllAsync<{ id: string; account_id: string; kode: string; nama: string; alasan: string; dasar_aturan: string; created_by: string; created_at: string }>(
    `SELECT p.id, p.account_id, a.kode, a.nama, p.alasan, p.dasar_aturan, p.created_by, p.created_at
       FROM pajak_pengecualian_omzet p JOIN account a ON a.id = p.account_id
      WHERE p.status = 'AKTIF' ORDER BY a.kode`
  );
  return rows.map((r) => ({ id: r.id, accountId: r.account_id, kode: r.kode, nama: r.nama, alasan: r.alasan, dasarAturan: r.dasar_aturan, createdBy: r.created_by, createdAt: r.created_at }));
}

/**
 * Akun pendapatan yang BUKAN objek peredaran bruto (mis. bunga deposito yang
 * sudah dipotong PPh final, penghasilan bukan dari usaha). Wajib alasan &
 * dasar aturan; berlaku untuk PPh Final UMKM dan peredaran bruto Pasal 31E.
 */
export async function tambahPengecualianOmzet(input: { accountId: string; alasan: string; dasarAturan: string; userId: string }): Promise<string> {
  if (!input.alasan.trim()) throw new Error('Alasan pengecualian wajib diisi.');
  if (!input.dasarAturan.trim()) throw new Error('Dasar aturan pengecualian wajib diisi.');
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'pengaturan', 'edit');
    await pastikanTabelRezimPajak(db);
    const akun = await db.getFirstAsync<{ kategori: string }>(`SELECT kategori FROM account WHERE id = ?`, input.accountId);
    if (!akun || akun.kategori !== 'PENDAPATAN') throw new Error('Hanya akun pendapatan yang dapat dikecualikan dari peredaran bruto.');
    if ((await idAkunDikecualikanPadaDb(db)).has(input.accountId)) throw new Error('Akun ini sudah dikecualikan.');
    const id = newId();
    await db.runAsync(
      `INSERT INTO pajak_pengecualian_omzet (id, account_id, alasan, dasar_aturan, status, created_by, created_at) VALUES (?,?,?,?, 'AKTIF', ?, ?)`,
      id, input.accountId, input.alasan.trim(), input.dasarAturan.trim(), input.userId, new Date().toISOString()
    );
    return id;
  });
}

export async function cabutPengecualianOmzet(input: { id: string; userId: string }): Promise<void> {
  await withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'pengaturan', 'edit');
    await pastikanTabelRezimPajak(db);
    await db.runAsync(
      `UPDATE pajak_pengecualian_omzet SET status = 'DICABUT', dicabut_oleh = ?, dicabut_pada = ? WHERE id = ? AND status = 'AKTIF'`,
      input.userId, new Date().toISOString(), input.id
    );
  });
}

/** Peredaran bruto satu tahun pajak dari ledger, dikurangi pengecualian terkonfigurasi. */
export async function getOmzetTahunPajakPadaDb(db: SQLite.SQLiteDatabase, tahun: number): Promise<Rupiah> {
  const kecuali = await idAkunDikecualikanPadaDb(db);
  const rows = await omzetPerAkun(db, `${tahun}-01-01`, `${tahun}-12-31`);
  return rows.filter((r) => !kecuali.has(r.accountId)).reduce((s, r) => s + r.nilai, 0);
}

// ---------------------------------------------------------------------------
// RC-S87 — Resolver rezim berbasis data
// ---------------------------------------------------------------------------

async function overrideAktif(db: SQLite.SQLiteDatabase, tahun: number): Promise<(OverrideRezim & { id: string; tanggalDokumen: string; createdBy: string; createdAt: string }) | null> {
  await pastikanTabelRezimPajak(db);
  const r = await db.getFirstAsync<{ id: string; rezim: RezimPajak; alasan: string; nomor_dokumen: string; tanggal_dokumen: string; created_by: string; created_at: string }>(
    `SELECT id, rezim, alasan, nomor_dokumen, tanggal_dokumen, created_by, created_at FROM pajak_rezim_override
      WHERE tahun_pajak = ? AND status = 'AKTIF' ORDER BY created_at DESC LIMIT 1`,
    tahun
  );
  return r ? { id: r.id, rezim: r.rezim, alasan: r.alasan, nomorDokumen: r.nomor_dokumen, tanggalDokumen: r.tanggal_dokumen, createdBy: r.created_by, createdAt: r.created_at } : null;
}

/**
 * Evaluasi rezim untuk satu tahun pajak. Bila `catat` diisi, keputusan
 * disimpan ke `pajak_rezim_evaluasi` (alasan, dasar aturan, parameter,
 * versi kebijakan, konteks, user, waktu) — jejak audit "mengapa".
 */
export async function evaluasiRezimPajakPadaDb(
  db: SQLite.SQLiteDatabase,
  tahun: number,
  catat?: { konteks: string; userId: string }
): Promise<HasilRezimPajak> {
  if (!Number.isInteger(tahun) || tahun < 2000) throw new Error('Tahun pajak tidak valid.');
  const pengaturan = await bacaPengaturan(db);
  const omzetPerTahun: Record<number, Rupiah> = {};
  if (pengaturan) {
    const mulai = Math.max(pengaturan.tahunTerdaftar, tahun - 10);
    for (let t = mulai; t < tahun; t++) omzetPerTahun[t] = await getOmzetTahunPajakPadaDb(db, t);
  }
  const ov = await overrideAktif(db, tahun);
  const hasil = tentukanRezimPajak({
    tahunPajak: tahun,
    pengaturan,
    omzetPerTahun,
    omzetTahunBerjalan: await getOmzetTahunPajakPadaDb(db, tahun),
    override: ov ? { rezim: ov.rezim, alasan: ov.alasan, nomorDokumen: ov.nomorDokumen } : null,
  });
  if (catat) {
    await db.runAsync(
      `INSERT INTO pajak_rezim_evaluasi (id, tahun_pajak, rezim, sumber, alasan_json, peringatan_json, dasar_aturan_json, parameter_json,
         versi_kebijakan, konteks, dievaluasi_oleh, dievaluasi_pada) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId(), tahun, hasil.rezim, hasil.sumber, JSON.stringify(hasil.alasan), JSON.stringify(hasil.peringatan),
      JSON.stringify(hasil.dasarAturan), JSON.stringify(hasil.parameter), hasil.parameter.versiKebijakan,
      catat.konteks, catat.userId, new Date().toISOString()
    );
  }
  return hasil;
}

export async function evaluasiRezimPajak(tahun: number): Promise<HasilRezimPajak> {
  return evaluasiRezimPajakPadaDb(await getDb(), tahun);
}

/**
 * Penetapan rezim MANUAL (pengecualian yang diaudit) — mis. berdasarkan
 * surat/keputusan DJP. Wajib alasan, nomor & tanggal dokumen; tercatat
 * user & waktu; override lama untuk tahun yang sama otomatis dicabut.
 */
export async function tetapkanOverrideRezim(input: {
  tahun: number;
  rezim: RezimPajak;
  alasan: string;
  nomorDokumen: string;
  tanggalDokumen: string;
  userId: string;
}): Promise<string> {
  if (!(input.rezim in LABEL_REZIM)) throw new Error('Rezim pajak tidak dikenal.');
  if (!input.alasan.trim()) throw new Error('Alasan penetapan manual wajib diisi.');
  if (!input.nomorDokumen.trim()) throw new Error('Nomor dokumen referensi wajib diisi.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tanggalDokumen)) throw new Error('Tanggal dokumen wajib diisi.');
  kebijakanUntukTahun(input.tahun);
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'pengaturan', 'edit');
    await pastikanTabelRezimPajak(db);
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE pajak_rezim_override SET status = 'DICABUT', dicabut_oleh = ?, dicabut_pada = ?, alasan_cabut = 'Digantikan penetapan baru'
        WHERE tahun_pajak = ? AND status = 'AKTIF'`,
      input.userId, now, input.tahun
    );
    const id = newId();
    await db.runAsync(
      `INSERT INTO pajak_rezim_override (id, tahun_pajak, rezim, alasan, nomor_dokumen, tanggal_dokumen, status, created_by, created_at)
       VALUES (?,?,?,?,?,?, 'AKTIF', ?, ?)`,
      id, input.tahun, input.rezim, input.alasan.trim(), input.nomorDokumen.trim(), input.tanggalDokumen, input.userId, now
    );
    await evaluasiRezimPajakPadaDb(db, input.tahun, { konteks: 'OVERRIDE_DITETAPKAN', userId: input.userId });
    return id;
  });
}

export async function cabutOverrideRezim(input: { tahun: number; alasan: string; userId: string }): Promise<void> {
  if (!input.alasan.trim()) throw new Error('Alasan pencabutan wajib diisi.');
  await withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'pengaturan', 'edit');
    await pastikanTabelRezimPajak(db);
    await db.runAsync(
      `UPDATE pajak_rezim_override SET status = 'DICABUT', dicabut_oleh = ?, dicabut_pada = ?, alasan_cabut = ? WHERE tahun_pajak = ? AND status = 'AKTIF'`,
      input.userId, new Date().toISOString(), input.alasan.trim(), input.tahun
    );
    await evaluasiRezimPajakPadaDb(db, input.tahun, { konteks: 'OVERRIDE_DICABUT', userId: input.userId });
  });
}

function rentangMasa(masa: string): { mulai: string; selesai: string } {
  return { mulai: `${masa}-01`, selesai: tanggalAkhirPeriode(masa) };
}

// ---------------------------------------------------------------------------
// Pengaturan
// ---------------------------------------------------------------------------

export async function getPengaturanPajak(): Promise<PengaturanPajak | null> {
  return bacaPengaturan(await getDb());
}

export async function simpanPengaturanPajak(input: { skema: SkemaPajak; tahunTerdaftar: number; updatedBy: string }): Promise<PengaturanPajak> {
  // RC-S95 — ikut jam aplikasi (Mode Pengujian Waktu), bukan jam asli perangkat.
  const tahunSekarang = getWaktuSekarang().getFullYear();
  const salah = validasiPengaturanPajak(input, tahunSekarang);
  if (salah) throw new Error(salah);
  return withTransaction(async (db) => {
    await requirePermission(db, input.updatedBy, 'pengaturan', 'edit');
    const nilai: PengaturanPajak = { skema: input.skema, tahunTerdaftar: input.tahunTerdaftar };
    await db.runAsync(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      CONFIG_KEY_PENGATURAN_PAJAK,
      JSON.stringify(nilai),
      new Date().toISOString()
    );
    return nilai;
  });
}

// ---------------------------------------------------------------------------
// Ringkasan
// ---------------------------------------------------------------------------

export interface SaldoAkunPajak {
  accountId: string;
  kode: string;
  nama: string;
  jenis: string;
  saldo: Rupiah;
}

export interface RingkasanPajak {
  pengaturan: PengaturanPajak | null;
  /** Utang pajak per akun (hanya akun yang ada di COA). */
  utang: SaldoAkunPajak[];
  totalUtang: Rupiah;
  /** Saldo Pajak Dibayar Dimuka (angsuran PPh 25 yang belum dikreditkan). */
  pajakDibayarDimuka: Rupiah;
  /** RC-S86 — PPh Pasal 4(2) Bunga Simpanan bulan berjalan (masa = bulan berjalan berdasarkan tanggal hari ini). */
  pphBungaSimpananBulanIni: RingkasanPphBungaSimpananBulanIni;
}

export async function getRingkasanPajak(): Promise<RingkasanPajak> {
  const db = await getDb();
  const utang: SaldoAkunPajak[] = [];
  for (const kode of KODE_UTANG_PAJAK_SETORAN) {
    const a = await db.getFirstAsync<{ id: string; nama: string }>(`SELECT id, nama FROM account WHERE kode = ? AND is_active = 1`, kode);
    if (!a) continue;
    utang.push({ accountId: a.id, kode, nama: a.nama, jenis: JENIS_PAJAK_PER_AKUN[kode] ?? a.nama, saldo: await getAccountBalance(db, a.id) });
  }
  const idDimuka = await idAkunByKode(db, KODE_PAJAK_DIBAYAR_DIMUKA);
  // RC-S95 — masa pajak berjalan = periode LOKAL jam aplikasi. Sebelumnya
  // `new Date().toISOString()` memakai jam asli DAN zona UTC, sehingga di
  // WIB antara pukul 00.00–06.59 tanggal 1 masa yang terbaca masih bulan lalu.
  const masaSekarang = getPeriodeLokalSekarang();
  return {
    pengaturan: await bacaPengaturan(db),
    utang,
    totalUtang: utang.reduce((s, u) => s + Math.max(0, u.saldo), 0),
    pajakDibayarDimuka: idDimuka ? await getAccountBalance(db, idDimuka) : 0,
    pphBungaSimpananBulanIni: await getRingkasanPphBungaSimpananBulanIni(db, masaSekarang),
  };
}

// ---------------------------------------------------------------------------
// Omzet (peredaran bruto) dari ledger
// ---------------------------------------------------------------------------

export interface OmzetAkun {
  accountId: string;
  kode: string;
  nama: string;
  /** Mutasi bersih sisi kredit (kredit - debit) pada rentang. */
  nilai: Rupiah;
}

/**
 * Peredaran bruto per akun PENDAPATAN pada rentang tanggal — mutasi bersih
 * kredit dari jurnal POSTED/REVERSED (semantik sama dengan getAccountBalance,
 * jadi jurnal yang dibalik saling meniadakan). Akun bernilai 0 tidak ikut.
 */
async function omzetPerAkun(db: SQLite.SQLiteDatabase, mulai: string, selesai: string): Promise<OmzetAkun[]> {
  const rows = await db.getAllAsync<{ id: string; kode: string; nama: string; nilai: number }>(
    `SELECT a.id, a.kode, a.nama, COALESCE(SUM(je.kredit - je.debit), 0) AS nilai
       FROM account a
       JOIN journal_entry je ON je.account_id = a.id
       JOIN journal j ON j.id = je.journal_id
      WHERE a.kategori = 'PENDAPATAN'
        AND j.status IN ('POSTED','REVERSED')
        AND j.tanggal >= ? AND j.tanggal <= ?
      GROUP BY a.id, a.kode, a.nama
      ORDER BY a.kode`,
    mulai,
    selesai
  );
  return rows.filter((r) => r.nilai !== 0).map((r) => ({ accountId: r.id, kode: r.kode, nama: r.nama, nilai: r.nilai }));
}

export const omzetPerAkunPadaDb = omzetPerAkun;

export async function getOmzetMasa(masa: string): Promise<OmzetAkun[]> {
  if (!isValidPeriode(masa)) throw new Error('Masa pajak harus berformat YYYY-MM.');
  const { mulai, selesai } = rentangMasa(masa);
  return omzetPerAkun(await getDb(), mulai, selesai);
}

/** Total peredaran bruto satu tahun (untuk informasi batas Rp4,8 miliar). */
export async function getOmzetTahun(tahun: number): Promise<Rupiah> {
  const rows = await omzetPerAkun(await getDb(), `${tahun}-01-01`, `${tahun}-12-31`);
  return rows.reduce((s, r) => s + r.nilai, 0);
}

export interface InfoPphFinal {
  kelayakan: ReturnType<typeof cekKelayakanFinal>;
  omzetTahunLalu: Rupiah;
  melewatiBatasOmzet: boolean;
  sudahDicatat: { nomorJurnal: string; tanggal: string } | null;
}

export async function getInfoPphFinal(masa: string): Promise<InfoPphFinal> {
  const db = await getDb();
  const tahun = Number(masa.slice(0, 4));
  const pengaturan = await bacaPengaturan(db);
  const omzetTahunLalu = await getOmzetTahun(tahun - 1);
  const ada = await jurnalPengakuanAda(db, kunciPphFinal(masa));
  return {
    kelayakan: cekKelayakanFinal(pengaturan, tahun),
    omzetTahunLalu,
    melewatiBatasOmzet: omzetTahunLalu > BATAS_OMZET_FINAL,
    sudahDicatat: ada ? { nomorJurnal: ada.nomor_jurnal, tanggal: ada.tanggal } : null,
  };
}

// ---------------------------------------------------------------------------
// PPh Final 0,5% (pengakuan, non-kas)
// ---------------------------------------------------------------------------

export interface CatatPphFinalInput {
  masa: string;
  /** Akun pendapatan yang DIKECUALIKAN dari peredaran bruto (mis. bunga bank yang sudah dipotong PPh final). */
  akunDikecualikan: string[];
  tanggal?: string;
  createdBy: string;
}

export interface HasilPengakuanPajak {
  journalId: string;
  nomorJurnal: string;
  nominal: Rupiah;
}

/**
 * Dr Beban Pajak Penghasilan (5-2200) / Kr Utang PPh Final (2-1904).
 * Satu pengakuan per masa (jurnal POSTED dengan sumber_id PPH_FINAL:<masa>).
 * Omzet dihitung ULANG di dalam transaksi dari ledger — angka dari layar
 * tidak dipercaya.
 */
export async function catatPphFinal(input: CatatPphFinalInput): Promise<HasilPengakuanPajak> {
  if (!isValidPeriode(input.masa)) throw new Error('Masa pajak harus berformat YYYY-MM.');
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');

    const tahun = Number(input.masa.slice(0, 4));
    const kelayakan = cekKelayakanFinal(await bacaPengaturan(db), tahun);
    if (!kelayakan.layak) throw new Error(kelayakan.alasan);

    const ada = await jurnalPengakuanAda(db, kunciPphFinal(input.masa));
    if (ada) throw new Error(`PPh Final masa ${labelMasa(input.masa)} sudah dicatat (${ada.nomor_jurnal}).`);

    // RC-S87 — rezim efektif (omzet tahun sebelumnya, riwayat keluar final,
    // override) harus FINAL_UMKM; keputusan dicatat untuk audit.
    const rezim = await evaluasiRezimPajakPadaDb(db, tahun, { konteks: `PPH_FINAL:${input.masa}`, userId: input.createdBy });
    if (rezim.rezim !== 'FINAL_UMKM') {
      throw new Error(`Rezim pajak tahun ${tahun} adalah ${rezim.rezim ? LABEL_REZIM[rezim.rezim] : 'belum ditentukan'}: ${rezim.alasan.join(' ')}`);
    }

    const { mulai, selesai } = rentangMasa(input.masa);
    const tanggal = input.tanggal ?? selesai;
    if (tanggal < mulai) throw new Error('Tanggal pencatatan tidak boleh sebelum awal masa pajak.');

    const dikecualikan = new Set([...input.akunDikecualikan, ...(await idAkunDikecualikanPadaDb(db))]);
    const omzet = (await omzetPerAkun(db, mulai, selesai)).filter((r) => !dikecualikan.has(r.accountId)).reduce((s, r) => s + r.nilai, 0);
    if (omzet <= 0) throw new Error(`Tidak ada peredaran bruto pada masa ${labelMasa(input.masa)}.`);
    const pajak = hitungPphFinal(omzet);
    if (pajak <= 0) throw new Error('PPh Final yang dihitung Rp0 — tidak ada yang perlu dicatat.');

    await pastikanAkunPajak(db);
    const beban = await wajibAkun(db, KODE_BEBAN_PAJAK, 'Beban Pajak Penghasilan');
    const utang = await wajibAkun(db, KODE_UTANG_PPH_FINAL, 'Utang PPh Final');

    const { journalId, nomorJurnal } = await createJournal(db, {
      tanggal,
      sumberTransaksi: 'PAJAK_PENGAKUAN',
      sumberId: kunciPphFinal(input.masa),
      deskripsi: `PPh Final 0,5% · Masa ${labelMasa(input.masa)} · Peredaran bruto ${formatRupiah(omzet)}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: beban, debit: pajak, kredit: 0 },
        { accountId: utang, debit: 0, kredit: pajak },
      ],
    });
    return { journalId, nomorJurnal, nominal: pajak };
  });
}

// ---------------------------------------------------------------------------
// RC-S87.3 — PPh Final OTOMATIS: rincian, daftar masa, catat semua
// ---------------------------------------------------------------------------

export interface RincianPphFinalMasa extends RincianPerhitungan {
  masa: string;
  dasar: Rupiah;
  pajak: Rupiah;
  jatuhTempo: string;
}

async function rincianPphFinalPadaDb(
  db: SQLite.SQLiteDatabase,
  masa: string,
  akunDikecualikanManual: readonly string[] = []
): Promise<RincianPphFinalMasa> {
  const { mulai, selesai } = rentangMasa(masa);
  await pastikanTabelRezimPajak(db);
  const alasanKonfig = new Map(
    (await db.getAllAsync<{ account_id: string; alasan: string }>(`SELECT account_id, alasan FROM pajak_pengecualian_omzet WHERE status = 'AKTIF'`)).map((r) => [r.account_id, r.alasan])
  );
  const manual = new Set(akunDikecualikanManual);
  const akun: AkunOmzetRincian[] = (await omzetPerAkun(db, mulai, selesai)).map((r) => ({
    kode: r.kode,
    nama: r.nama,
    nilai: r.nilai,
    alasanDikecualikan: alasanKonfig.get(r.accountId) ?? (manual.has(r.accountId) ? 'Dikecualikan manual untuk masa ini' : undefined),
  }));
  const r = rincianPphFinal({ masa, akun, kebijakan: kebijakanUntukTahun(Number(masa.slice(0, 4))) });
  return { ...r, masa };
}

/** Rincian PPh Final satu masa — angka SAMA dengan yang dicatat `catatPphFinal`. */
export async function getRincianPphFinal(masa: string, akunDikecualikanManual: readonly string[] = []): Promise<RincianPphFinalMasa> {
  if (!isValidPeriode(masa)) throw new Error('Masa pajak harus berformat YYYY-MM.');
  return rincianPphFinalPadaDb(await getDb(), masa, akunDikecualikanManual);
}

export type StatusMasaPphFinal = 'DICATAT' | 'PERLU_DICATAT' | 'NIHIL' | 'BERJALAN' | 'BUKAN_REZIM_FINAL';

export interface MasaPphFinal {
  masa: string;
  label: string;
  status: StatusMasaPphFinal;
  dasar: Rupiah;
  pajak: Rupiah;
  jatuhTempo: string;
  terlambat: boolean;
  nomorJurnal: string | null;
  alasan: string | null;
}

/**
 * Status PPh Final 12 masa terakhir, dihitung OTOMATIS dari buku besar.
 * Masa berjalan tidak pernah dianggap siap dicatat (peredaran bruto
 * belum lengkap).
 */
// RC-S95 — default = tanggal LOKAL jam aplikasi (sebelumnya jam asli & UTC).
export async function getDaftarMasaPphFinal(hariIni: string = getTanggalLokalHariIni()): Promise<MasaPphFinal[]> {
  const db = await getDb();
  const sekarang = hariIni.slice(0, 7);
  const rezimPerTahun = new Map<number, HasilRezimPajak>();
  const hasil: MasaPphFinal[] = [];
  for (const masa of daftarMasa(sekarang, 12)) {
    const tahun = Number(masa.slice(0, 4));
    if (!rezimPerTahun.has(tahun)) rezimPerTahun.set(tahun, await evaluasiRezimPajakPadaDb(db, tahun));
    const rezim = rezimPerTahun.get(tahun)!;
    const r = await rincianPphFinalPadaDb(db, masa);
    const ada = await jurnalPengakuanAda(db, kunciPphFinal(masa));
    let status: StatusMasaPphFinal;
    let nominal = r.pajak;
    let alasan: string | null = null;
    if (ada) {
      status = 'DICATAT';
      const j = await db.getFirstAsync<{ n: number }>(
        `SELECT COALESCE(SUM(je.kredit),0) n FROM journal_entry je JOIN journal j ON j.id = je.journal_id JOIN account a ON a.id = je.account_id
          WHERE j.sumber_id = ? AND j.status = 'POSTED' AND a.kode = ?`,
        kunciPphFinal(masa), KODE_UTANG_PPH_FINAL
      );
      nominal = j?.n ?? r.pajak;
    } else if (rezim.rezim !== 'FINAL_UMKM') {
      status = 'BUKAN_REZIM_FINAL';
      alasan = rezim.rezim ? LABEL_REZIM[rezim.rezim] : 'Rezim belum ditentukan';
    } else if (masa >= sekarang) {
      status = 'BERJALAN';
    } else if (r.pajak <= 0) {
      status = 'NIHIL';
    } else {
      status = 'PERLU_DICATAT';
    }
    hasil.push({
      masa,
      label: labelMasa(masa),
      status,
      dasar: r.dasar,
      pajak: nominal,
      jatuhTempo: r.jatuhTempo,
      terlambat: status === 'PERLU_DICATAT' && hariIni > r.jatuhTempo,
      nomorJurnal: ada?.nomor_jurnal ?? null,
      alasan,
    });
  }
  return hasil;
}

export interface HasilCatatOtomatis {
  dicatat: { masa: string; nominal: Rupiah; nomorJurnal: string }[];
  gagal: { masa: string; pesan: string }[];
}

/**
 * Catat SEKALIGUS semua masa berstatus PERLU_DICATAT (dari yang terlama).
 * Tiap masa lewat `catatPphFinal()` existing — idempotensi, rezim, periode
 * tutup, dan pengecualian terkonfigurasi tetap berlaku. Dipanggil ulang
 * tidak mencatat ganda.
 */
export async function catatPphFinalOtomatis(input: { createdBy: string; hariIni?: string }): Promise<HasilCatatOtomatis> {
  const daftar = (await getDaftarMasaPphFinal(input.hariIni)).filter((m) => m.status === 'PERLU_DICATAT').reverse();
  const hasil: HasilCatatOtomatis = { dicatat: [], gagal: [] };
  for (const m of daftar) {
    try {
      const h = await catatPphFinal({ masa: m.masa, akunDikecualikan: [], createdBy: input.createdBy });
      hasil.dicatat.push({ masa: m.masa, nominal: h.nominal, nomorJurnal: h.nomorJurnal });
    } catch (e) {
      hasil.gagal.push({ masa: m.masa, pesan: e instanceof Error ? e.message : 'Gagal dicatat.' });
    }
  }
  return hasil;
}

// ---------------------------------------------------------------------------
// Angsuran PPh Pasal 25 (kas keluar)
// ---------------------------------------------------------------------------

export interface CatatAngsuranPph25Input {
  masa: string;
  nominal: Rupiah;
  jenisRekening: JenisRekening;
  bankAccountId?: string;
  tanggal: string;
  ntpn: string;
  catatan?: string;
  createdBy: string;
}

/**
 * RC-S87 — dahulu memeriksa deklarasi `skema === 'UMUM'` saja. Kini memakai
 * rezim EFEKTIF tahun pajak: koperasi yang mendeklarasikan PPh Final tetapi
 * fasilitasnya habis / omzetnya melewati batas tahun sebelumnya WAJIB bisa
 * mencatat PPh 25 & PPh Badan. Pesan untuk rezim final tidak berubah.
 */
export async function pastikanRezimBadan(db: SQLite.SQLiteDatabase, tahun: number): Promise<HasilRezimPajak> {
  const p = await bacaPengaturan(db);
  if (!p) throw new Error('Pengaturan pajak belum diisi. Buka Pengaturan Pajak terlebih dahulu.');
  const r = await evaluasiRezimPajakPadaDb(db, tahun);
  if (r.rezim === 'FINAL_UMKM' || r.rezim === null) {
    throw new Error('Koperasi memakai PPh Final 0,5% — angsuran PPh 25 dan PPh Badan tidak berlaku.');
  }
  return r;
}

/** Dr Pajak Dibayar Dimuka (1-1410) / Kr Kas-Bank. Satu angsuran per masa. */
export async function catatAngsuranPph25(input: CatatAngsuranPph25Input): Promise<{ id: string; journalId: string }> {
  if (!isValidPeriode(input.masa)) throw new Error('Masa pajak harus berformat YYYY-MM.');
  const salahNtpn = validasiNtpn(input.ntpn);
  if (salahNtpn) throw new Error(salahNtpn);
  if (!Number.isInteger(input.nominal) || input.nominal <= 0) throw new Error('Nominal angsuran harus lebih dari 0.');

  const kunciDasar = kunciAngsuranPph25(input.masa);
  const { accountId, kunci } = await withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    await pastikanRezimBadan(db, Number(input.masa.slice(0, 4)));
    // Angsuran yang pernah dicatat untuk masa ini (termasuk yang sudah
    // dibalik lewat History Transaksi). Yang masih POSTED memblokir; yang
    // sudah dibalik tidak — pencatatan ulang memakai kunci bernomor supaya
    // idempotensi BUG-07 tidak mengembalikan efek lama yang sudah dibatalkan.
    const pola = `${kunciDasar}%`;
    const pernah = await db.getAllAsync<{ status: string }>(
      `SELECT j.status FROM kas_transaksi t JOIN journal j ON j.id = t.journal_id WHERE t.idempotency_key LIKE ?
       UNION ALL
       SELECT j.status FROM bank_transaksi t JOIN journal j ON j.id = t.journal_id WHERE t.idempotency_key LIKE ?`,
      pola,
      pola
    );
    if (pernah.some((p) => p.status === 'POSTED')) {
      throw new Error(`Angsuran PPh 25 masa ${labelMasa(input.masa)} sudah dicatat.`);
    }
    await pastikanAkunPajak(db);
    return {
      accountId: await wajibAkun(db, KODE_PAJAK_DIBAYAR_DIMUKA, 'Pajak Dibayar Dimuka'),
      kunci: pernah.length === 0 ? kunciDasar : `${kunciDasar}:${pernah.length + 1}`,
    };
  });

  return catatPengeluaran({
    jenis: input.jenisRekening,
    bankAccountId: input.jenisRekening === 'BANK' ? input.bankAccountId : undefined,
    tanggal: input.tanggal,
    nominal: input.nominal,
    akunLawanId: accountId,
    kategori: 'Angsuran PPh Pasal 25',
    keterangan: susunKeteranganAngsuranPph25(input.masa, input.ntpn, input.catatan),
    idempotencyKey: kunci,
    createdBy: input.createdBy,
  });
}

// ---------------------------------------------------------------------------
// PPh Badan akhir tahun (Pasal 29, non-kas)
// ---------------------------------------------------------------------------

export async function getInfoPphBadan(tahun: number): Promise<{ kreditPph25: Rupiah; sudahDicatat: { nomorJurnal: string; tanggal: string } | null }> {
  const db = await getDb();
  const idDimuka = await idAkunByKode(db, KODE_PAJAK_DIBAYAR_DIMUKA);
  const ada = await jurnalPengakuanAda(db, kunciPphBadan(tahun));
  return {
    kreditPph25: idDimuka ? await getAccountBalance(db, idDimuka, `${tahun}-12-31`) : 0,
    sudahDicatat: ada ? { nomorJurnal: ada.nomor_jurnal, tanggal: ada.tanggal } : null,
  };
}

export interface CatatPphBadanInput {
  tahun: number;
  pphTerutang: Rupiah;
  tanggal: string;
  createdBy: string;
}

/**
 * Dr Beban Pajak (terutang) / Kr Pajak Dibayar Dimuka (kredit PPh 25 s.d.
 * akhir tahun pajak) / Kr Utang PPh 29 (kurang bayar). Satu per tahun pajak.
 */
export async function catatPphBadan(input: CatatPphBadanInput): Promise<HasilPengakuanPajak & { kurangBayar: Rupiah }> {
  if (!Number.isInteger(input.tahun) || input.tahun < 2000) throw new Error('Tahun pajak tidak valid.');
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    await pastikanRezimBadan(db, input.tahun);
    const ada = await jurnalPengakuanAda(db, kunciPphBadan(input.tahun));
    if (ada) throw new Error(`PPh Badan tahun pajak ${input.tahun} sudah dicatat (${ada.nomor_jurnal}).`);
    if (input.tanggal < `${input.tahun}-01-01`) throw new Error('Tanggal pencatatan tidak boleh sebelum tahun pajak.');

    await pastikanAkunPajak(db);
    const beban = await wajibAkun(db, KODE_BEBAN_PAJAK, 'Beban Pajak Penghasilan');
    const dimuka = await wajibAkun(db, KODE_PAJAK_DIBAYAR_DIMUKA, 'Pajak Dibayar Dimuka');
    const utang29 = await wajibAkun(db, KODE_UTANG_PPH_29, 'Utang PPh Pasal 29');

    const rincian = hitungPphBadan(input.pphTerutang, await getAccountBalance(db, dimuka, `${input.tahun}-12-31`));
    const lines = [{ accountId: beban, debit: rincian.terutang, kredit: 0 }];
    if (rincian.kreditPph25 > 0) lines.push({ accountId: dimuka, debit: 0, kredit: rincian.kreditPph25 });
    if (rincian.kurangBayar > 0) lines.push({ accountId: utang29, debit: 0, kredit: rincian.kurangBayar });

    const { journalId, nomorJurnal } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'PAJAK_PENGAKUAN',
      sumberId: kunciPphBadan(input.tahun),
      deskripsi: `PPh Badan tahun pajak ${input.tahun} · Kredit PPh 25 ${formatRupiah(rincian.kreditPph25)} · Kurang bayar ${formatRupiah(rincian.kurangBayar)}`,
      createdBy: input.createdBy,
      lines,
    });
    return { journalId, nomorJurnal, nominal: rincian.terutang, kurangBayar: rincian.kurangBayar };
  });
}

// ---------------------------------------------------------------------------
// Setor Pajak (reuse Bayar Kewajiban)
// ---------------------------------------------------------------------------

export interface SetorPajakInput {
  accountId: string;
  masa: string;
  nominal: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  tanggal: string;
  ntpn: string;
  catatan?: string;
  createdBy: string;
}

/**
 * Setoran utang pajak. Validasi pajak di sini (akun harus akun utang pajak,
 * masa & NTPN), seluruh validasi kewajiban & kas di bayarKewajibanCoa().
 */
export async function setorPajak(input: SetorPajakInput): Promise<{ id: string; journalId: string }> {
  if (!isValidPeriode(input.masa)) throw new Error('Masa pajak harus berformat YYYY-MM.');
  const salahNtpn = validasiNtpn(input.ntpn);
  if (salahNtpn) throw new Error(salahNtpn);
  const db = await getDb();
  const akun = await db.getFirstAsync<{ kode: string; nama: string }>(`SELECT kode, nama FROM account WHERE id = ?`, input.accountId);
  if (!akun || !KODE_UTANG_PAJAK_SETORAN.includes(akun.kode)) {
    throw new Error('Akun yang dipilih bukan akun utang pajak.');
  }
  return bayarKewajibanCoa({
    accountId: input.accountId,
    tanggal: input.tanggal,
    nominal: input.nominal,
    sumberDana: input.sumberDana,
    bankAccountId: input.sumberDana === 'BANK' ? input.bankAccountId : undefined,
    keterangan: susunKeteranganSetoran(JENIS_PAJAK_PER_AKUN[akun.kode] ?? akun.nama, input.masa, input.ntpn, input.catatan),
    createdBy: input.createdBy,
  });
}

// ---------------------------------------------------------------------------
// Pembatalan pengakuan (non-kas)
// ---------------------------------------------------------------------------

/**
 * Membalik jurnal PENGAKUAN pajak (PPh Final / PPh Badan) lewat
 * reverseJournal() — tidak ada DELETE. Ditolak bila utang yang diakui
 * jurnal itu sudah (sebagian) disetor: saldo utang pajak saat ini harus
 * masih >= porsi kredit jurnal pada akun utang tersebut. Tanpa guard ini
 * pembalikan membuat utang pajak negatif padahal kasnya sudah keluar.
 */
export async function batalkanPengakuanPajak(input: { journalId: string; alasan: string; userId: string }): Promise<{ nomorJurnal: string }> {
  if (!input.alasan.trim()) throw new Error('Alasan pembatalan wajib diisi.');
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'create');
    return batalkanPengakuanPajakPadaDb(db, input);
  });
}

/** RC-S87 — varian di dalam transaksi pemanggil (dipakai pembatalan snapshot PPh Badan). */
export async function batalkanPengakuanPajakPadaDb(
  db: SQLite.SQLiteDatabase,
  input: { journalId: string; alasan: string; userId: string }
): Promise<{ nomorJurnal: string }> {
  if (!input.alasan.trim()) throw new Error('Alasan pembatalan wajib diisi.');
  {
    const j = await db.getFirstAsync<{ sumber_transaksi: string; status: string; reversal_of_id: string | null }>(
      `SELECT sumber_transaksi, status, reversal_of_id FROM journal WHERE id = ?`,
      input.journalId
    );
    if (!j || j.sumber_transaksi !== SUMBER_PENGAKUAN_PAJAK || j.reversal_of_id) {
      throw new Error('Hanya jurnal pengakuan pajak yang dapat dibatalkan dari menu Pajak.');
    }
    if (j.status !== 'POSTED') throw new Error('Jurnal ini sudah dibatalkan.');
    const kreditUtang = await db.getAllAsync<{ account_id: string; kode: string; nama: string; kredit: number }>(
      `SELECT je.account_id, a.kode, a.nama, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id
        WHERE je.journal_id = ? AND je.kredit > 0 AND a.kategori = 'LIABILITAS'`,
      input.journalId
    );
    for (const k of kreditUtang) {
      const saldo = await getAccountBalance(db, k.account_id);
      if (saldo < k.kredit) {
        throw new Error(
          `${k.nama} dari jurnal ini sudah disetor (sisa utang ${formatRupiah(Math.max(0, saldo))} dari ${formatRupiah(k.kredit)}). Batalkan setorannya lebih dulu lewat History Transaksi.`
        );
      }
    }
    const { nomorJurnal } = await reverseJournal(db, input.journalId, input.userId, input.alasan.trim());
    return { nomorJurnal };
  }
}

// ---------------------------------------------------------------------------
// Riwayat
// ---------------------------------------------------------------------------

export type JenisRiwayatPajak = 'PENGAKUAN' | 'SETORAN' | 'ANGSURAN_PPH25' | 'PPH_BUNGA_SIMPANAN' | 'PEMBATALAN' | 'LAINNYA';

export interface RiwayatPajakItem {
  journalId: string;
  nomorJurnal: string;
  tanggal: string;
  deskripsi: string;
  jenis: JenisRiwayatPajak;
  nominal: Rupiah;
  status: string;
  /** true bila jurnal pengakuan ini boleh dibatalkan dari menu Pajak (POSTED, bukan reversal). */
  bisaDibatalkan: boolean;
}

/**
 * Seluruh jurnal yang menyentuh akun pajak pada tahun tertentu, terbaru di
 * atas. Diturunkan dari ledger — tidak ada tabel riwayat terpisah yang
 * bisa berbeda dari buku besar.
 */
export async function listRiwayatPajak(tahun: number): Promise<RiwayatPajakItem[]> {
  const db = await getDb();
  const ph = KODE_AKUN_RIWAYAT_PAJAK.map(() => '?').join(',');
  const rows = await db.getAllAsync<{
    id: string;
    nomor_jurnal: string;
    tanggal: string;
    deskripsi: string;
    sumber_transaksi: string;
    status: string;
    reversal_of_id: string | null;
    kode: string;
    debit: number;
    kredit: number;
  }>(
    `SELECT j.id, j.nomor_jurnal, j.tanggal, j.deskripsi, j.sumber_transaksi, j.status, j.reversal_of_id, a.kode, je.debit, je.kredit
       FROM journal j
       JOIN journal_entry je ON je.journal_id = j.id
       JOIN account a ON a.id = je.account_id
      WHERE a.kode IN (${ph}) AND j.status IN ('POSTED','REVERSED')
        AND j.tanggal >= ? AND j.tanggal <= ?
      ORDER BY j.tanggal DESC, j.nomor_jurnal DESC`,
    ...KODE_AKUN_RIWAYAT_PAJAK,
    `${tahun}-01-01`,
    `${tahun}-12-31`
  );

  const peta = new Map<string, RiwayatPajakItem>();
  for (const r of rows) {
    let item = peta.get(r.id);
    if (!item) {
      const jenis: JenisRiwayatPajak =
        r.reversal_of_id || r.deskripsi.startsWith('REVERSAL:')
          ? 'PEMBATALAN'
          : r.kode === KODE_UTANG_PPH_BUNGA_SIMPANAN
          ? 'PPH_BUNGA_SIMPANAN'
          : r.sumber_transaksi === SUMBER_PENGAKUAN_PAJAK
          ? 'PENGAKUAN'
          : r.deskripsi.startsWith('Setor Angsuran PPh Pasal 25')
          ? 'ANGSURAN_PPH25'
          : r.deskripsi.startsWith('Setor ')
          ? 'SETORAN'
          : 'LAINNYA';
      item = {
        journalId: r.id,
        nomorJurnal: r.nomor_jurnal,
        tanggal: r.tanggal,
        deskripsi: r.deskripsi,
        jenis,
        nominal: 0,
        status: r.status,
        bisaDibatalkan: jenis === 'PENGAKUAN' && r.status === 'POSTED',
      };
      peta.set(r.id, item);
    }
    // Nominal = sisi debit terbesar pada akun pajak (beban/dimuka/pelunasan utang)
    // atau sisi kredit bila jurnal hanya menambah utang (koreksi manual).
    item.nominal = Math.max(item.nominal, r.debit, r.kredit);
  }
  return [...peta.values()];
}

export const LABEL_JENIS_RIWAYAT: Record<JenisRiwayatPajak, string> = {
  PENGAKUAN: 'Pengakuan pajak',
  SETORAN: 'Setoran pajak',
  ANGSURAN_PPH25: 'Angsuran PPh 25',
  PPH_BUNGA_SIMPANAN: 'PPh Ps.4(2) Bunga Simpanan',
  PEMBATALAN: 'Pembatalan',
  LAINNYA: 'Transaksi lain',
};
