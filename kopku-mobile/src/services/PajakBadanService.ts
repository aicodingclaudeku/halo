/**
 * RC-S87 — PPh BADAN NON-FINAL (Pasal 31E 11% + tarif umum 22%), PPh 25, PPh 29.
 *
 * Alur:  Laba komersial (LHU: SHU sebelum pajak)
 *          → koreksi fiskal (data terkonfigurasi & diaudit, TIDAK dikarang)
 *          → PKP → Pasal 31E (PKP fasilitas 11% / PKP non-fasilitas 22%)
 *          → total PPh Badan → kredit (PPh 25 sah, PPh 22/23/24 terdaftar)
 *          → PPh 29 / lebih bayar → KUNCI (snapshot + jurnal).
 *
 * PRINSIP
 *  - Rumus & tarif HANYA di `pajakPolicy.ts` (`hitungPphBadanNonFinal`,
 *    `kebijakanUntukTahun`). Layar hanya menampilkan.
 *  - Jurnal lewat `createJournal()` / `reverseJournal()` existing. Kunci
 *    jurnal PPh Badan SAMA dengan jalur legacy (`PPH_BADAN:<tahun>`), jadi
 *    jalur engine dan jalur manual lama tidak mungkin keduanya tercatat.
 *  - PPh 25 = kredit (Cr 1-1410), BUKAN beban kedua. PPh 4(2) bunga
 *    simpanan adalah pajak yang dipotong dari ANGGOTA — tidak
 *    pernah masuk perhitungan ini.
 *  - Snapshot tidak pernah diubah. Koreksi = batalkan (reversal tercatat)
 *    lalu kunci ulang. Status dibatalkan diturunkan dari status jurnalnya.
 *  - Tabel baru aditif, dibuat idempoten; SCHEMA_VERSION tidak dinaikkan.
 */
import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { requirePermission } from '@/services/PermissionService';
import { catatAngsuranPph25 } from '@/services/PajakService';
import { JenisRekening } from '@/services/KasBankService';
import {
  batalkanPengakuanPajakPadaDb,
  evaluasiRezimPajakPadaDb,
  getOmzetTahunPajakPadaDb,
  jurnalPengakuanPajakAda,
  pastikanAkunPajak,
} from '@/services/PajakService';
import { getLHU } from '@/reports/FinancialReports';
import { newId } from '@/utils/id';
import { Rupiah, formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  HasilPphBadan,
  HasilRezimPajak,
  RincianPerhitungan,
  hitungDasarPph25,
  rincianPphBadan,
  KODE_BEBAN_PAJAK,
  KODE_PAJAK_DIBAYAR_DIMUKA,
  KODE_PAJAK_DIBAYAR_DIMUKA_LAIN,
  KODE_UTANG_PPH_29,
  KebijakanPajakVersi,
  LABEL_REZIM,
  SUMBER_PENGAKUAN_PAJAK,
  SumberDasarPph25,
  hitungPphBadanNonFinal,
  jatuhTempoPph25,
  kebijakanUntukTahun,
  kunciAngsuranPph25,
  kunciPphBadan,
  labelMasa,
  validasiNtpn,
} from '@/config/pajakPolicy';

// ---------------------------------------------------------------------------
// Tabel
// ---------------------------------------------------------------------------

export async function pastikanTabelPajakBadan(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS pajak_koreksi_fiskal (
      id TEXT PRIMARY KEY,
      tahun_pajak INTEGER NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('POSITIF','NEGATIF')),
      account_id TEXT,
      uraian TEXT NOT NULL,
      nilai_komersial INTEGER NOT NULL,
      nilai_fiskal INTEGER NOT NULL,
      nilai_koreksi INTEGER NOT NULL,
      alasan TEXT NOT NULL,
      referensi_aturan TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('AKTIF','DIHAPUS')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dihapus_oleh TEXT,
      dihapus_pada TEXT,
      alasan_hapus TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pajak_koreksi_fiskal_tahun ON pajak_koreksi_fiskal(tahun_pajak, status);
    CREATE TABLE IF NOT EXISTS pajak_rekonsiliasi_fiskal (
      id TEXT PRIMARY KEY,
      tahun_pajak INTEGER NOT NULL,
      lengkap INTEGER NOT NULL,
      catatan TEXT,
      dinyatakan_oleh TEXT NOT NULL,
      dinyatakan_pada TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pajak_rekonsiliasi_fiskal_tahun ON pajak_rekonsiliasi_fiskal(tahun_pajak);
    CREATE TABLE IF NOT EXISTS pajak_kredit_lain (
      id TEXT PRIMARY KEY,
      tahun_pajak INTEGER NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('PPH22','PPH23','PPH24')),
      nominal INTEGER NOT NULL,
      nomor_bukti TEXT NOT NULL,
      tanggal_bukti TEXT NOT NULL,
      pemotong TEXT NOT NULL,
      journal_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pajak_kredit_lain_bukti ON pajak_kredit_lain(jenis, nomor_bukti);
    CREATE TABLE IF NOT EXISTS pajak_pph25_dasar (
      id TEXT PRIMARY KEY,
      tahun_pajak INTEGER NOT NULL,
      angsuran_bulanan INTEGER NOT NULL,
      bulan_mulai INTEGER NOT NULL,
      sumber TEXT NOT NULL,
      tahun_sumber INTEGER NOT NULL,
      nomor_referensi TEXT NOT NULL,
      tanggal_referensi TEXT NOT NULL,
      catatan TEXT,
      status TEXT NOT NULL CHECK (status IN ('AKTIF','DIGANTI')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pajak_pph25_dasar_tahun ON pajak_pph25_dasar(tahun_pajak, status);
    CREATE TABLE IF NOT EXISTS pajak_badan_snapshot (
      id TEXT PRIMARY KEY,
      tahun_pajak INTEGER NOT NULL,
      rezim TEXT NOT NULL CHECK (rezim IN ('BADAN_31E','BADAN_UMUM')),
      versi_kebijakan TEXT NOT NULL,
      kebijakan_json TEXT NOT NULL,
      rezim_json TEXT NOT NULL,
      hasil_json TEXT NOT NULL,
      koreksi_json TEXT NOT NULL,
      omzet_bruto INTEGER NOT NULL,
      laba_komersial INTEGER NOT NULL,
      koreksi_positif INTEGER NOT NULL,
      koreksi_negatif INTEGER NOT NULL,
      pkp INTEGER NOT NULL,
      pkp_fasilitas INTEGER NOT NULL,
      pkp_non_fasilitas INTEGER NOT NULL,
      pph_fasilitas INTEGER NOT NULL,
      pph_non_fasilitas INTEGER NOT NULL,
      total_pph INTEGER NOT NULL,
      kredit_pph25 INTEGER NOT NULL,
      kredit_pph22 INTEGER NOT NULL,
      kredit_pph23 INTEGER NOT NULL,
      kredit_pph24 INTEGER NOT NULL,
      pph29 INTEGER NOT NULL,
      journal_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('TERKUNCI','DIBATALKAN')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dibatalkan_oleh TEXT,
      dibatalkan_pada TEXT,
      alasan_batal TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pajak_badan_snapshot_tahun ON pajak_badan_snapshot(tahun_pajak);
  `);
}

async function idAkun(db: SQLite.SQLiteDatabase, kode: string): Promise<string | null> {
  return (await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, kode))?.id ?? null;
}

// ---------------------------------------------------------------------------
// Koreksi fiskal
// ---------------------------------------------------------------------------

export type JenisKoreksiFiskal = 'POSITIF' | 'NEGATIF';

export interface KoreksiFiskal {
  id: string;
  tahunPajak: number;
  jenis: JenisKoreksiFiskal;
  accountId: string | null;
  uraian: string;
  nilaiKomersial: Rupiah;
  nilaiFiskal: Rupiah;
  nilaiKoreksi: Rupiah;
  alasan: string;
  referensiAturan: string;
  createdBy: string;
  createdAt: string;
}

export interface TambahKoreksiFiskalInput {
  tahunPajak: number;
  jenis: JenisKoreksiFiskal;
  accountId?: string | null;
  uraian: string;
  nilaiKomersial: Rupiah;
  nilaiFiskal: Rupiah;
  alasan: string;
  referensiAturan: string;
  userId: string;
}

async function snapshotAktif(db: SQLite.SQLiteDatabase, tahun: number): Promise<SnapshotRow | null> {
  const rows = await db.getAllAsync<SnapshotRow>(
    `SELECT s.*, j.status AS status_jurnal, j.nomor_jurnal AS nomor_jurnal FROM pajak_badan_snapshot s
       LEFT JOIN journal j ON j.id = s.journal_id WHERE s.tahun_pajak = ? ORDER BY s.created_at DESC`,
    tahun
  );
  return rows.find((r) => statusSnapshot(r) === 'TERKUNCI') ?? null;
}

async function tolakBilaTerkunci(db: SQLite.SQLiteDatabase, tahun: number): Promise<void> {
  if (await snapshotAktif(db, tahun)) {
    throw new Error(`Perhitungan PPh Badan tahun pajak ${tahun} sudah dikunci. Batalkan perhitungannya (tercatat) sebelum mengubah data.`);
  }
}

/**
 * Nilai koreksi = |komersial − fiskal|; arah ditentukan `jenis` (POSITIF
 * menambah PKP, NEGATIF mengurangi). Operator TIDAK mengetik selisih —
 * selisih dihitung dari dua nilai yang dapat ditelusuri.
 */
export async function tambahKoreksiFiskal(input: TambahKoreksiFiskalInput): Promise<string> {
  if (input.jenis !== 'POSITIF' && input.jenis !== 'NEGATIF') throw new Error('Jenis koreksi harus positif atau negatif.');
  if (!input.uraian.trim()) throw new Error('Uraian koreksi wajib diisi.');
  if (!input.alasan.trim()) throw new Error('Alasan koreksi wajib diisi.');
  if (!input.referensiAturan.trim()) throw new Error('Referensi aturan wajib diisi.');
  for (const [n, v] of [['Nilai komersial', input.nilaiKomersial], ['Nilai fiskal', input.nilaiFiskal]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${n} harus bilangan bulat rupiah dan tidak negatif.`);
  }
  const nilaiKoreksi = Math.abs(input.nilaiKomersial - input.nilaiFiskal);
  if (nilaiKoreksi === 0) throw new Error('Nilai komersial dan fiskal sama — tidak ada koreksi.');
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'create');
    await pastikanTabelPajakBadan(db);
    await tolakBilaTerkunci(db, input.tahunPajak);
    const id = newId();
    await db.runAsync(
      `INSERT INTO pajak_koreksi_fiskal (id, tahun_pajak, jenis, account_id, uraian, nilai_komersial, nilai_fiskal, nilai_koreksi,
         alasan, referensi_aturan, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'AKTIF', ?, ?)`,
      id, input.tahunPajak, input.jenis, input.accountId ?? null, input.uraian.trim(), input.nilaiKomersial, input.nilaiFiskal,
      nilaiKoreksi, input.alasan.trim(), input.referensiAturan.trim(), input.userId, new Date().toISOString()
    );
    // Data koreksi berubah -> pernyataan "lengkap" sebelumnya tidak lagi berlaku.
    await nyatakanRekonsiliasiPadaDb(db, input.tahunPajak, false, input.userId, 'Otomatis: koreksi fiskal ditambah');
    return id;
  });
}

export async function hapusKoreksiFiskal(input: { id: string; alasan: string; userId: string }): Promise<void> {
  if (!input.alasan.trim()) throw new Error('Alasan penghapusan wajib diisi.');
  await withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'create');
    await pastikanTabelPajakBadan(db);
    const k = await db.getFirstAsync<{ tahun_pajak: number }>(`SELECT tahun_pajak FROM pajak_koreksi_fiskal WHERE id = ? AND status = 'AKTIF'`, input.id);
    if (!k) throw new Error('Koreksi fiskal tidak ditemukan atau sudah dihapus.');
    await tolakBilaTerkunci(db, k.tahun_pajak);
    await db.runAsync(
      `UPDATE pajak_koreksi_fiskal SET status = 'DIHAPUS', dihapus_oleh = ?, dihapus_pada = ?, alasan_hapus = ? WHERE id = ?`,
      input.userId, new Date().toISOString(), input.alasan.trim(), input.id
    );
    await nyatakanRekonsiliasiPadaDb(db, k.tahun_pajak, false, input.userId, 'Otomatis: koreksi fiskal dihapus');
  });
}

async function koreksiFiskalPadaDb(db: SQLite.SQLiteDatabase, tahun: number): Promise<KoreksiFiskal[]> {
  await pastikanTabelPajakBadan(db);
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM pajak_koreksi_fiskal WHERE tahun_pajak = ? AND status = 'AKTIF' ORDER BY created_at`,
    tahun
  );
  return rows.map((r) => ({
    id: r.id,
    tahunPajak: r.tahun_pajak,
    jenis: r.jenis,
    accountId: r.account_id,
    uraian: r.uraian,
    nilaiKomersial: r.nilai_komersial,
    nilaiFiskal: r.nilai_fiskal,
    nilaiKoreksi: r.nilai_koreksi,
    alasan: r.alasan,
    referensiAturan: r.referensi_aturan,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export async function listKoreksiFiskal(tahun: number): Promise<KoreksiFiskal[]> {
  return koreksiFiskalPadaDb(await getDb(), tahun);
}

async function nyatakanRekonsiliasiPadaDb(db: SQLite.SQLiteDatabase, tahun: number, lengkap: boolean, userId: string, catatan?: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO pajak_rekonsiliasi_fiskal (id, tahun_pajak, lengkap, catatan, dinyatakan_oleh, dinyatakan_pada) VALUES (?,?,?,?,?,?)`,
    newId(), tahun, lengkap ? 1 : 0, catatan ?? null, userId, new Date().toISOString()
  );
}

/**
 * Pernyataan bahwa SELURUH koreksi fiskal tahun pajak sudah diinput
 * (termasuk bila memang tidak ada koreksi). Tanpa pernyataan ini engine
 * menampilkan "Rekonsiliasi fiskal belum lengkap" dan tidak bisa dikunci.
 */
export async function nyatakanRekonsiliasiFiskal(input: { tahun: number; lengkap: boolean; catatan?: string; userId: string }): Promise<void> {
  await withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'create');
    await pastikanTabelPajakBadan(db);
    await tolakBilaTerkunci(db, input.tahun);
    await nyatakanRekonsiliasiPadaDb(db, input.tahun, input.lengkap, input.userId, input.catatan);
  });
}

async function rekonsiliasiLengkap(db: SQLite.SQLiteDatabase, tahun: number): Promise<{ lengkap: boolean; oleh: string | null; pada: string | null }> {
  const r = await db.getFirstAsync<{ lengkap: number; dinyatakan_oleh: string; dinyatakan_pada: string }>(
    `SELECT lengkap, dinyatakan_oleh, dinyatakan_pada FROM pajak_rekonsiliasi_fiskal WHERE tahun_pajak = ? ORDER BY dinyatakan_pada DESC, rowid DESC LIMIT 1`,
    tahun
  );
  return { lengkap: r?.lengkap === 1, oleh: r?.dinyatakan_oleh ?? null, pada: r?.dinyatakan_pada ?? null };
}

// ---------------------------------------------------------------------------
// Kredit PPh 22/23/24 (dipotong/dipungut pihak lain)
// ---------------------------------------------------------------------------

export type JenisKreditLain = 'PPH22' | 'PPH23' | 'PPH24';

/**
 * Daftarkan bukti potong/pungut. Jurnal: Dr 1-1411 Pajak Dibayar Dimuka
 * (PPh 22/23/24) / Cr `akunLawanId` (dipilih operator: pendapatan bruto
 * yang tadinya tercatat neto, atau kas/bank bila pajaknya dibayar sendiri).
 * Satu nomor bukti per jenis hanya bisa didaftarkan sekali.
 */
export async function catatKreditPajakLain(input: {
  tahunPajak: number;
  jenis: JenisKreditLain;
  nominal: Rupiah;
  nomorBukti: string;
  tanggalBukti: string;
  pemotong: string;
  akunLawanId: string;
  userId: string;
}): Promise<{ id: string; journalId: string }> {
  if (!['PPH22', 'PPH23', 'PPH24'].includes(input.jenis)) throw new Error('Jenis kredit pajak tidak dikenal.');
  if (!Number.isSafeInteger(input.nominal) || input.nominal <= 0) throw new Error('Nominal kredit pajak harus lebih dari 0.');
  if (!input.nomorBukti.trim() || !input.pemotong.trim()) throw new Error('Nomor bukti dan nama pemotong wajib diisi.');
  if (input.tanggalBukti.slice(0, 4) !== String(input.tahunPajak)) throw new Error('Tanggal bukti harus berada di tahun pajak yang sama.');
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'create');
    await pastikanTabelPajakBadan(db);
    await tolakBilaTerkunci(db, input.tahunPajak);
    const dobel = await db.getFirstAsync(`SELECT id FROM pajak_kredit_lain WHERE jenis = ? AND nomor_bukti = ?`, input.jenis, input.nomorBukti.trim());
    if (dobel) throw new Error('Bukti potong ini sudah pernah didaftarkan.');
    await pastikanAkunPajak(db);
    const dimuka = (await idAkun(db, KODE_PAJAK_DIBAYAR_DIMUKA_LAIN)) as string;
    const id = newId();
    const { journalId } = await createJournal(db, {
      tanggal: input.tanggalBukti,
      sumberTransaksi: SUMBER_PENGAKUAN_PAJAK,
      sumberId: `KREDIT_PAJAK:${id}`,
      deskripsi: `Kredit ${input.jenis.replace('PPH', 'PPh ')} · bukti ${input.nomorBukti.trim()} · ${input.pemotong.trim()}`,
      createdBy: input.userId,
      lines: [
        { accountId: dimuka, debit: input.nominal, kredit: 0 },
        { accountId: input.akunLawanId, debit: 0, kredit: input.nominal },
      ],
    });
    await db.runAsync(
      `INSERT INTO pajak_kredit_lain (id, tahun_pajak, jenis, nominal, nomor_bukti, tanggal_bukti, pemotong, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, input.tahunPajak, input.jenis, input.nominal, input.nomorBukti.trim(), input.tanggalBukti, input.pemotong.trim(), journalId, input.userId, new Date().toISOString()
    );
    return { id, journalId };
  });
}

async function kreditLainPadaDb(db: SQLite.SQLiteDatabase, tahun: number): Promise<Record<JenisKreditLain, Rupiah>> {
  const rows = await db.getAllAsync<{ jenis: JenisKreditLain; n: number }>(
    `SELECT k.jenis, COALESCE(SUM(k.nominal),0) n FROM pajak_kredit_lain k JOIN journal j ON j.id = k.journal_id
      WHERE k.tahun_pajak = ? AND j.status = 'POSTED' GROUP BY k.jenis`,
    tahun
  );
  const hasil: Record<JenisKreditLain, Rupiah> = { PPH22: 0, PPH23: 0, PPH24: 0 };
  for (const r of rows) hasil[r.jenis] = r.n;
  return hasil;
}

// ---------------------------------------------------------------------------
// PPh 25 — dasar angsuran, jadwal, pembayaran
// ---------------------------------------------------------------------------

export interface DasarPph25 {
  id: string;
  tahunPajak: number;
  angsuranBulanan: Rupiah;
  bulanMulai: number;
  sumber: SumberDasarPph25;
  tahunSumber: number;
  nomorReferensi: string;
  tanggalReferensi: string;
  catatan: string | null;
  createdBy: string;
  createdAt: string;
}

export async function tetapkanDasarPph25(input: {
  tahunPajak: number;
  angsuranBulanan: Rupiah;
  bulanMulai?: number;
  sumber: SumberDasarPph25;
  tahunSumber: number;
  nomorReferensi: string;
  tanggalReferensi: string;
  catatan?: string;
  userId: string;
}): Promise<string> {
  if (!Number.isSafeInteger(input.angsuranBulanan) || input.angsuranBulanan < 0) throw new Error('Angsuran bulanan harus bilangan bulat rupiah dan tidak negatif.');
  const bulanMulai = input.bulanMulai ?? 1;
  if (!Number.isInteger(bulanMulai) || bulanMulai < 1 || bulanMulai > 12) throw new Error('Bulan mulai harus 1–12.');
  if (!input.nomorReferensi.trim()) throw new Error('Nomor SPT/dokumen referensi wajib diisi.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tanggalReferensi)) throw new Error('Tanggal dokumen referensi wajib diisi.');
  if (input.tahunSumber >= input.tahunPajak) throw new Error('Tahun sumber dasar angsuran harus sebelum tahun pajak angsuran.');
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'create');
    await pastikanTabelPajakBadan(db);
    await db.runAsync(`UPDATE pajak_pph25_dasar SET status = 'DIGANTI' WHERE tahun_pajak = ? AND status = 'AKTIF'`, input.tahunPajak);
    const id = newId();
    await db.runAsync(
      `INSERT INTO pajak_pph25_dasar (id, tahun_pajak, angsuran_bulanan, bulan_mulai, sumber, tahun_sumber, nomor_referensi, tanggal_referensi,
         catatan, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?, 'AKTIF', ?, ?)`,
      id, input.tahunPajak, input.angsuranBulanan, bulanMulai, input.sumber, input.tahunSumber, input.nomorReferensi.trim(),
      input.tanggalReferensi, input.catatan?.trim() || null, input.userId, new Date().toISOString()
    );
    return id;
  });
}

async function dasarPph25PadaDb(db: SQLite.SQLiteDatabase, tahun: number): Promise<DasarPph25 | null> {
  await pastikanTabelPajakBadan(db);
  const r = await db.getFirstAsync<any>(`SELECT * FROM pajak_pph25_dasar WHERE tahun_pajak = ? AND status = 'AKTIF' ORDER BY created_at DESC LIMIT 1`, tahun);
  return r
    ? {
        id: r.id,
        tahunPajak: r.tahun_pajak,
        angsuranBulanan: r.angsuran_bulanan,
        bulanMulai: r.bulan_mulai,
        sumber: r.sumber,
        tahunSumber: r.tahun_sumber,
        nomorReferensi: r.nomor_referensi,
        tanggalReferensi: r.tanggal_referensi,
        catatan: r.catatan,
        createdBy: r.created_by,
        createdAt: r.created_at,
      }
    : null;
}

export async function getDasarPph25(tahun: number): Promise<DasarPph25 | null> {
  return dasarPph25PadaDb(await getDb(), tahun);
}

export interface UsulanDasarPph25 {
  tersedia: boolean;
  alasan: string | null;
  angsuranBulanan: Rupiah;
  rincian: RincianPerhitungan | null;
  snapshotId: string | null;
  tanggalSnapshot: string | null;
}

/**
 * RC-S87.3 — usulan dasar angsuran PPh 25 tahun `tahun` dari perhitungan
 * PPh Badan tahun sebelumnya yang SUDAH DIKUNCI (Pasal 25 ayat 1). Tanpa
 * snapshot terkunci tidak ada usulan — aplikasi tidak menebak dari laba.
 */
export async function getUsulanDasarPph25(tahun: number): Promise<UsulanDasarPph25> {
  const db = await getDb();
  await pastikanTabelPajakBadan(db);
  const s = await snapshotAktif(db, tahun - 1);
  if (!s) {
    return { tersedia: false, alasan: `Perhitungan PPh Badan tahun ${tahun - 1} belum dikunci.`, angsuranBulanan: 0, rincian: null, snapshotId: null, tanggalSnapshot: null };
  }
  const h = hitungDasarPph25({ tahunPajak: tahun, pphTerutangTahunLalu: s.total_pph, kreditPph22: s.kredit_pph22, kreditPph23: s.kredit_pph23, kreditPph24: s.kredit_pph24 });
  return { tersedia: true, alasan: null, angsuranBulanan: h.angsuranBulanan, rincian: h.rincian, snapshotId: s.id, tanggalSnapshot: s.created_at.slice(0, 10) };
}

/** Tetapkan dasar PPh 25 dari usulan otomatis — satu ketukan, referensi = snapshot tahun lalu. */
export async function tetapkanDasarPph25Otomatis(input: { tahunPajak: number; userId: string }): Promise<{ id: string; angsuranBulanan: Rupiah }> {
  const u = await getUsulanDasarPph25(input.tahunPajak);
  if (!u.tersedia || !u.snapshotId || !u.tanggalSnapshot) throw new Error(u.alasan ?? 'Usulan dasar angsuran belum tersedia.');
  const id = await tetapkanDasarPph25({
    tahunPajak: input.tahunPajak,
    angsuranBulanan: u.angsuranBulanan,
    sumber: 'PERHITUNGAN_TAHUN_LALU',
    tahunSumber: input.tahunPajak - 1,
    nomorReferensi: `PPH-BADAN-${input.tahunPajak - 1}/${u.snapshotId.slice(0, 8).toUpperCase()}`,
    tanggalReferensi: u.tanggalSnapshot,
    catatan: 'Pasal 25 ayat (1): (PPh terutang − kredit PPh 22/23/24) ÷ 12',
    userId: input.userId,
  });
  return { id, angsuranBulanan: u.angsuranBulanan };
}

export interface PembayaranPph25 {
  masa: string;
  journalId: string;
  nomorJurnal: string;
  tanggal: string;
  nominal: Rupiah;
  ntpn: string | null;
}

/** Angsuran PPh 25 yang SAH: transaksi kas/bank berkunci PAJAK:PPH25:<masa> dengan jurnal POSTED. */
async function pembayaranPph25PadaDb(db: SQLite.SQLiteDatabase, tahun: number): Promise<PembayaranPph25[]> {
  const idDimuka = await idAkun(db, KODE_PAJAK_DIBAYAR_DIMUKA);
  if (!idDimuka) return [];
  const pola = `${kunciAngsuranPph25(`${tahun}-`)}%`;
  const rows = await db.getAllAsync<{ kunci: string; journal_id: string; nomor_jurnal: string; tanggal: string; deskripsi: string; nominal: number }>(
    `SELECT t.idempotency_key AS kunci, j.id AS journal_id, j.nomor_jurnal, j.tanggal, j.deskripsi,
            (SELECT COALESCE(SUM(je.debit),0) FROM journal_entry je WHERE je.journal_id = j.id AND je.account_id = ?) AS nominal
       FROM (SELECT idempotency_key, journal_id FROM kas_transaksi WHERE idempotency_key LIKE ?
             UNION ALL SELECT idempotency_key, journal_id FROM bank_transaksi WHERE idempotency_key LIKE ?) t
       JOIN journal j ON j.id = t.journal_id
      WHERE j.status = 'POSTED'
      ORDER BY j.tanggal`,
    idDimuka, pola, pola
  );
  return rows.map((r) => ({
    masa: r.kunci.split(':')[2],
    journalId: r.journal_id,
    nomorJurnal: r.nomor_jurnal,
    tanggal: r.tanggal,
    nominal: r.nominal,
    ntpn: /NTPN ([A-Z0-9]{16})/.exec(r.deskripsi)?.[1] ?? null,
  }));
}

export type StatusMasaPph25 = 'LUNAS' | 'BELUM_JATUH_TEMPO' | 'JATUH_TEMPO' | 'TERLAMBAT';

export interface JadwalMasaPph25 {
  masa: string;
  label: string;
  nominal: Rupiah;
  jatuhTempo: string;
  status: StatusMasaPph25;
  pembayaran: PembayaranPph25 | null;
}

export interface JadwalPph25 {
  tahunPajak: number;
  dasar: DasarPph25 | null;
  masa: JadwalMasaPph25[];
  totalTerjadwal: Rupiah;
  totalDibayar: Rupiah;
}

/** Kewajiban PPh 25 per masa dibentuk OTOMATIS dari dasar angsuran — operator tidak membuat kewajiban. */
export async function getJadwalPph25(tahun: number, hariIni: string = getTanggalLokalHariIni()): Promise<JadwalPph25> {
  const db = await getDb();
  const dasar = await dasarPph25PadaDb(db, tahun);
  const bayar = await pembayaranPph25PadaDb(db, tahun);
  const k = kebijakanUntukTahun(tahun);
  const masa: JadwalMasaPph25[] = [];
  if (dasar) {
    for (let b = dasar.bulanMulai; b <= 12; b++) {
      const m = `${tahun}-${String(b).padStart(2, '0')}`;
      const jt = jatuhTempoPph25(m, k);
      const p = bayar.find((x) => x.masa === m) ?? null;
      // JATUH_TEMPO = masa sudah berjalan/lewat dan batas setor belum lewat;
      // TERLAMBAT = batas setor sudah lewat tanpa pembayaran sah.
      const status: StatusMasaPph25 = p ? 'LUNAS' : hariIni > jt ? 'TERLAMBAT' : hariIni >= `${m}-01` ? 'JATUH_TEMPO' : 'BELUM_JATUH_TEMPO';
      masa.push({ masa: m, label: labelMasa(m), nominal: dasar.angsuranBulanan, jatuhTempo: jt, status, pembayaran: p });
    }
  }
  return {
    tahunPajak: tahun,
    dasar,
    masa,
    totalTerjadwal: masa.reduce((s, x) => s + x.nominal, 0),
    totalDibayar: bayar.reduce((s, x) => s + x.nominal, 0),
  };
}

/**
 * Bayar angsuran PPh 25 terjadwal: operator hanya memberi sumber dana,
 * tanggal setor, dan NTPN. Nominal diambil dari dasar angsuran; pencatatan
 * memakai `catatAngsuranPph25()` existing (idempotensi & cek saldo kas).
 */
export async function bayarAngsuranPph25Terjadwal(input: {
  masa: string;
  jenisRekening: JenisRekening;
  bankAccountId?: string;
  tanggal: string;
  ntpn: string;
  catatan?: string;
  createdBy: string;
}): Promise<{ id: string; journalId: string; nominal: Rupiah }> {
  const salah = validasiNtpn(input.ntpn);
  if (salah) throw new Error(salah);
  const tahun = Number(input.masa.slice(0, 4));
  const dasar = await getDasarPph25(tahun);
  if (!dasar) throw new Error(`Dasar angsuran PPh 25 tahun ${tahun} belum ditetapkan.`);
  const bulan = Number(input.masa.slice(5, 7));
  if (bulan < dasar.bulanMulai) throw new Error(`Masa ${labelMasa(input.masa)} di luar jadwal angsuran (mulai bulan ${dasar.bulanMulai}).`);
  if (dasar.angsuranBulanan <= 0) throw new Error('Angsuran PPh 25 yang ditetapkan Rp0 — tidak ada yang perlu dibayar.');
  const h = await catatAngsuranPph25({
    masa: input.masa,
    nominal: dasar.angsuranBulanan,
    jenisRekening: input.jenisRekening,
    bankAccountId: input.bankAccountId,
    tanggal: input.tanggal,
    ntpn: input.ntpn,
    catatan: input.catatan ? `${input.catatan} · Dasar ${dasar.nomorReferensi}` : `Dasar ${dasar.nomorReferensi}`,
    createdBy: input.createdBy,
  });
  return { ...h, nominal: dasar.angsuranBulanan };
}

// ---------------------------------------------------------------------------
// Engine PPh Badan
// ---------------------------------------------------------------------------

export type StatusPerhitunganPphBadan =
  | 'BUKAN_REZIM_BADAN'
  | 'TERKUNCI'
  | 'DICATAT_JALUR_LAMA'
  | 'TAHUN_PAJAK_BELUM_BERAKHIR'
  | 'REKONSILIASI_BELUM_LENGKAP'
  | 'LEBIH_BAYAR_BELUM_ADA_KEBIJAKAN'
  | 'KREDIT_TIDAK_SESUAI_BUKU'
  | 'SIAP_DIKUNCI';

export const LABEL_STATUS_PPH_BADAN: Record<StatusPerhitunganPphBadan, string> = {
  BUKAN_REZIM_BADAN: 'Tidak berlaku — koperasi memakai PPh Final UMKM',
  TERKUNCI: 'Perhitungan sudah dikunci',
  DICATAT_JALUR_LAMA: 'PPh Badan sudah dicatat lewat input manual (jalur lama)',
  TAHUN_PAJAK_BELUM_BERAKHIR: 'Tahun pajak belum berakhir — hasil sementara',
  REKONSILIASI_BELUM_LENGKAP: 'Rekonsiliasi fiskal belum lengkap',
  LEBIH_BAYAR_BELUM_ADA_KEBIJAKAN: 'Lebih bayar — perlakuan belum ditetapkan kebijakannya',
  KREDIT_TIDAK_SESUAI_BUKU: 'Kredit pajak tidak sesuai saldo buku besar',
  SIAP_DIKUNCI: 'Siap dikunci',
};

export interface PerhitunganPphBadan {
  tahunPajak: number;
  status: StatusPerhitunganPphBadan;
  pesan: string[];
  rezim: HasilRezimPajak;
  kebijakan: KebijakanPajakVersi;
  omzetBruto: Rupiah;
  labaKomersial: Rupiah;
  koreksi: KoreksiFiskal[];
  koreksiPositif: Rupiah;
  koreksiNegatif: Rupiah;
  rekonsiliasi: { lengkap: boolean; oleh: string | null; pada: string | null };
  pembayaranPph25: PembayaranPph25[];
  hasil: HasilPphBadan | null;
  snapshot: SnapshotPphBadan | null;
  /** RC-S87.3 — rincian langkah demi langkah (dari snapshot bila sudah dikunci). */
  rincian: RincianPerhitungan | null;
}

async function hitungPadaDb(db: SQLite.SQLiteDatabase, tahun: number, hariIni: string): Promise<PerhitunganPphBadan> {
  await pastikanTabelPajakBadan(db);
  const kebijakan = kebijakanUntukTahun(tahun);
  const rezim = await evaluasiRezimPajakPadaDb(db, tahun);
  const omzetBruto = await getOmzetTahunPajakPadaDb(db, tahun);
  const labaKomersial = (await getLHU(db, `${tahun}-01-01`, `${tahun}-12-31`)).shuSebelumPajak;
  const koreksi = await koreksiFiskalPadaDb(db, tahun);
  const koreksiPositif = koreksi.filter((k) => k.jenis === 'POSITIF').reduce((s, k) => s + k.nilaiKoreksi, 0);
  const koreksiNegatif = koreksi.filter((k) => k.jenis === 'NEGATIF').reduce((s, k) => s + k.nilaiKoreksi, 0);
  const rekonsiliasi = await rekonsiliasiLengkap(db, tahun);
  const pembayaranPph25 = await pembayaranPph25PadaDb(db, tahun);
  const kreditLain = await kreditLainPadaDb(db, tahun);
  const snap = await snapshotAktif(db, tahun);

  const dasar: PerhitunganPphBadan = {
    tahunPajak: tahun, status: 'SIAP_DIKUNCI', pesan: [], rezim, kebijakan, omzetBruto, labaKomersial, koreksi,
    koreksiPositif, koreksiNegatif, rekonsiliasi, pembayaranPph25, hasil: null, snapshot: snap ? keSnapshot(snap) : null, rincian: null,
  };

  if (rezim.rezim !== 'BADAN_31E' && rezim.rezim !== 'BADAN_UMUM') {
    dasar.status = 'BUKAN_REZIM_BADAN';
    dasar.pesan.push(...rezim.alasan);
    return dasar;
  }

  dasar.hasil = hitungPphBadanNonFinal({
    rezim: rezim.rezim,
    peredaranBruto: omzetBruto,
    pkpSebelumPembulatan: labaKomersial + koreksiPositif - koreksiNegatif,
    kredit: {
      pph25: pembayaranPph25.reduce((s, p) => s + p.nominal, 0),
      pph22: kreditLain.PPH22,
      pph23: kreditLain.PPH23,
      pph24: kreditLain.PPH24,
    },
    kebijakan,
  });

  // Rincian: angka snapshot (immutabel) bila sudah dikunci, selain itu hasil berjalan.
  if (dasar.snapshot) {
    const sn = dasar.snapshot;
    dasar.rincian = rincianPphBadan({
      tahun, hasil: sn.hasil, labaKomersial: sn.labaKomersial,
      koreksi: sn.koreksi.map((k) => ({ uraian: k.uraian, jenis: k.jenis, nilai: k.nilaiKoreksi, referensi: k.referensiAturan })),
    });
  } else {
    dasar.rincian = rincianPphBadan({
      tahun, hasil: dasar.hasil, labaKomersial,
      koreksi: koreksi.map((k) => ({ uraian: k.uraian, jenis: k.jenis, nilai: k.nilaiKoreksi, referensi: k.referensiAturan })),
      angsuranPph25: pembayaranPph25.map((p) => ({ masa: p.masa, nominal: p.nominal, ntpn: p.ntpn })),
    });
  }

  if (snap) {
    dasar.status = 'TERKUNCI';
    return dasar;
  }
  const lama = await jurnalPengakuanPajakAda(db, kunciPphBadan(tahun));
  if (lama) {
    dasar.status = 'DICATAT_JALUR_LAMA';
    dasar.pesan.push(`Jurnal ${lama.nomor_jurnal} tercatat lewat input manual. Batalkan dari Riwayat Pajak bila ingin memakai perhitungan otomatis.`);
    return dasar;
  }
  if (hariIni <= `${tahun}-12-31`) {
    dasar.status = 'TAHUN_PAJAK_BELUM_BERAKHIR';
    dasar.pesan.push('Angka ini sementara. Perhitungan hanya dapat dikunci setelah tahun pajak berakhir.');
    return dasar;
  }
  if (!rekonsiliasi.lengkap) {
    dasar.status = 'REKONSILIASI_BELUM_LENGKAP';
    dasar.pesan.push('Input seluruh koreksi fiskal (atau nyatakan tidak ada koreksi), lalu nyatakan rekonsiliasi fiskal lengkap.');
    return dasar;
  }
  if (dasar.hasil.lebihBayar > 0) {
    dasar.status = 'LEBIH_BAYAR_BELUM_ADA_KEBIJAKAN';
    dasar.pesan.push(
      `Kredit pajak melebihi PPh terutang sebesar ${formatRupiah(dasar.hasil.lebihBayar)}. Perlakuan lebih bayar (restitusi atau kompensasi) belum ditetapkan kebijakannya.`
    );
    return dasar;
  }
  const idDimuka = await idAkun(db, KODE_PAJAK_DIBAYAR_DIMUKA);
  const saldo25 = idDimuka ? await getAccountBalance(db, idDimuka, `${tahun}-12-31`) : 0;
  const idLain = await idAkun(db, KODE_PAJAK_DIBAYAR_DIMUKA_LAIN);
  const saldoLain = idLain ? await getAccountBalance(db, idLain, `${tahun}-12-31`) : 0;
  const kreditLainTotal = dasar.hasil.kredit.pph22 + dasar.hasil.kredit.pph23 + dasar.hasil.kredit.pph24;
  if (dasar.hasil.kredit.pph25 > saldo25 || kreditLainTotal > saldoLain) {
    dasar.status = 'KREDIT_TIDAK_SESUAI_BUKU';
    dasar.pesan.push(
      `Kredit PPh 25 ${formatRupiah(dasar.hasil.kredit.pph25)} (saldo buku ${formatRupiah(saldo25)}); kredit PPh 22/23/24 ${formatRupiah(kreditLainTotal)} (saldo buku ${formatRupiah(saldoLain)}). Kredit tidak boleh melebihi saldo Pajak Dibayar Dimuka.`
    );
    return dasar;
  }
  return dasar;
}

export async function hitungPphBadanTahun(tahun: number, hariIni: string = getTanggalLokalHariIni()): Promise<PerhitunganPphBadan> {
  return hitungPadaDb(await getDb(), tahun, hariIni);
}

// ---------------------------------------------------------------------------
// Snapshot & kunci
// ---------------------------------------------------------------------------

interface SnapshotRow {
  id: string;
  tahun_pajak: number;
  rezim: 'BADAN_31E' | 'BADAN_UMUM';
  versi_kebijakan: string;
  kebijakan_json: string;
  rezim_json: string;
  hasil_json: string;
  koreksi_json: string;
  omzet_bruto: number;
  laba_komersial: number;
  koreksi_positif: number;
  koreksi_negatif: number;
  pkp: number;
  pkp_fasilitas: number;
  pkp_non_fasilitas: number;
  pph_fasilitas: number;
  pph_non_fasilitas: number;
  total_pph: number;
  kredit_pph25: number;
  kredit_pph22: number;
  kredit_pph23: number;
  kredit_pph24: number;
  pph29: number;
  journal_id: string | null;
  status: 'TERKUNCI' | 'DIBATALKAN';
  created_by: string;
  created_at: string;
  status_jurnal: string | null;
  nomor_jurnal: string | null;
}

function statusSnapshot(r: SnapshotRow): 'TERKUNCI' | 'DIBATALKAN' {
  if (r.status === 'DIBATALKAN') return 'DIBATALKAN';
  if (r.journal_id && r.status_jurnal !== 'POSTED') return 'DIBATALKAN';
  return 'TERKUNCI';
}

export interface SnapshotPphBadan {
  id: string;
  tahunPajak: number;
  rezim: 'BADAN_31E' | 'BADAN_UMUM';
  versiKebijakan: string;
  hasil: HasilPphBadan;
  omzetBruto: Rupiah;
  labaKomersial: Rupiah;
  koreksiPositif: Rupiah;
  koreksiNegatif: Rupiah;
  koreksi: KoreksiFiskal[];
  journalId: string | null;
  nomorJurnal: string | null;
  status: 'TERKUNCI' | 'DIBATALKAN';
  createdBy: string;
  createdAt: string;
}

function keSnapshot(r: SnapshotRow): SnapshotPphBadan {
  return {
    id: r.id,
    tahunPajak: r.tahun_pajak,
    rezim: r.rezim,
    versiKebijakan: r.versi_kebijakan,
    hasil: JSON.parse(r.hasil_json),
    omzetBruto: r.omzet_bruto,
    labaKomersial: r.laba_komersial,
    koreksiPositif: r.koreksi_positif,
    koreksiNegatif: r.koreksi_negatif,
    koreksi: JSON.parse(r.koreksi_json ?? '[]'),
    journalId: r.journal_id,
    nomorJurnal: r.nomor_jurnal,
    status: statusSnapshot(r),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function listSnapshotPphBadan(tahun: number): Promise<SnapshotPphBadan[]> {
  const db = await getDb();
  await pastikanTabelPajakBadan(db);
  const rows = await db.getAllAsync<SnapshotRow>(
    `SELECT s.*, j.status AS status_jurnal, j.nomor_jurnal AS nomor_jurnal FROM pajak_badan_snapshot s
       LEFT JOIN journal j ON j.id = s.journal_id WHERE s.tahun_pajak = ? ORDER BY s.created_at DESC`,
    tahun
  );
  return rows.map(keSnapshot);
}

/**
 * KUNCI perhitungan: dihitung ULANG di dalam transaksi (angka layar tidak
 * dipercaya), wajib status SIAP_DIKUNCI. Jurnal (bila PPh > 0):
 *   Dr 5-2200 Beban Pajak Penghasilan      total PPh Badan
 *   Cr 1-1410 Pajak Dibayar Dimuka (PPh 25) kredit PPh 25
 *   Cr 1-1411 Pajak Dibayar Dimuka (22/23/24) kredit lain
 *   Cr 2-1905 Utang PPh Pasal 29            PPh 29
 * Snapshot menyimpan salinan kebijakan, rezim, koreksi, dan hasil.
 */
export async function kunciPerhitunganPphBadan(input: { tahun: number; tanggal?: string; createdBy: string; hariIni?: string }): Promise<{ snapshotId: string; journalId: string | null; hasil: HasilPphBadan }> {
  const hariIni = input.hariIni ?? getTanggalLokalHariIni();
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    const p = await hitungPadaDb(db, input.tahun, hariIni);
    if (p.status !== 'SIAP_DIKUNCI' || !p.hasil) {
      throw new Error(`${LABEL_STATUS_PPH_BADAN[p.status]}. ${p.pesan.join(' ')}`.trim());
    }
    const h = p.hasil;
    const tanggal = input.tanggal ?? `${input.tahun}-12-31`;
    if (tanggal < `${input.tahun}-12-31`) throw new Error('Tanggal jurnal PPh Badan paling awal 31 Desember tahun pajak.');

    // Catat keputusan rezim yang dipakai (audit "mengapa").
    await evaluasiRezimPajakPadaDb(db, input.tahun, { konteks: `KUNCI_PPH_BADAN:${input.tahun}`, userId: input.createdBy });

    let journalId: string | null = null;
    if (h.totalPphBadan > 0) {
      await pastikanAkunPajak(db);
      const beban = (await idAkun(db, KODE_BEBAN_PAJAK)) as string;
      if (!beban) throw new Error('Akun 5-2200 Beban Pajak Penghasilan tidak ditemukan.');
      const lines = [{ accountId: beban, debit: h.totalPphBadan, kredit: 0 }];
      if (h.kredit.pph25 > 0) lines.push({ accountId: (await idAkun(db, KODE_PAJAK_DIBAYAR_DIMUKA)) as string, debit: 0, kredit: h.kredit.pph25 });
      const lain = h.kredit.pph22 + h.kredit.pph23 + h.kredit.pph24;
      if (lain > 0) lines.push({ accountId: (await idAkun(db, KODE_PAJAK_DIBAYAR_DIMUKA_LAIN)) as string, debit: 0, kredit: lain });
      if (h.pph29 > 0) lines.push({ accountId: (await idAkun(db, KODE_UTANG_PPH_29)) as string, debit: 0, kredit: h.pph29 });
      const j = await createJournal(db, {
        tanggal,
        sumberTransaksi: SUMBER_PENGAKUAN_PAJAK,
        sumberId: kunciPphBadan(input.tahun),
        deskripsi:
          `PPh Badan tahun pajak ${input.tahun} · ${LABEL_REZIM[h.rezim]} · PKP ${formatRupiah(h.pkp)} · ` +
          `PPh fasilitas ${formatRupiah(h.pphFasilitas)} + PPh tarif umum ${formatRupiah(h.pphNonFasilitas)} · PPh 29 ${formatRupiah(h.pph29)}`,
        createdBy: input.createdBy,
        lines,
      });
      journalId = j.journalId;
    }

    const snapshotId = newId();
    await db.runAsync(
      `INSERT INTO pajak_badan_snapshot (id, tahun_pajak, rezim, versi_kebijakan, kebijakan_json, rezim_json, hasil_json, koreksi_json,
         omzet_bruto, laba_komersial, koreksi_positif, koreksi_negatif, pkp, pkp_fasilitas, pkp_non_fasilitas, pph_fasilitas,
         pph_non_fasilitas, total_pph, kredit_pph25, kredit_pph22, kredit_pph23, kredit_pph24, pph29, journal_id, status, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'TERKUNCI', ?, ?)`,
      snapshotId, input.tahun, h.rezim, h.versiKebijakan, JSON.stringify(p.kebijakan), JSON.stringify(p.rezim), JSON.stringify(h),
      JSON.stringify(p.koreksi), p.omzetBruto, p.labaKomersial, p.koreksiPositif, p.koreksiNegatif, h.pkp, h.pkpFasilitas,
      h.pkpNonFasilitas, h.pphFasilitas, h.pphNonFasilitas, h.totalPphBadan, h.kredit.pph25, h.kredit.pph22, h.kredit.pph23,
      h.kredit.pph24, h.pph29, journalId, input.createdBy, new Date().toISOString()
    );
    return { snapshotId, journalId, hasil: h };
  });
}

/**
 * Pembatalan perhitungan yang sudah dikunci — lewat reversal jurnal
 * (ditolak bila PPh 29-nya sudah disetor) dan penandaan snapshot. Snapshot
 * lama TETAP tersimpan sebagai jejak audit.
 */
export async function batalkanPerhitunganPphBadan(input: { tahun: number; alasan: string; userId: string }): Promise<void> {
  if (!input.alasan.trim()) throw new Error('Alasan pembatalan wajib diisi.');
  await withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'create');
    await pastikanTabelPajakBadan(db);
    const s = await snapshotAktif(db, input.tahun);
    if (!s) throw new Error(`Tidak ada perhitungan PPh Badan tahun ${input.tahun} yang terkunci.`);
    if (s.journal_id) await batalkanPengakuanPajakPadaDb(db, { journalId: s.journal_id, alasan: input.alasan, userId: input.userId });
    await db.runAsync(
      `UPDATE pajak_badan_snapshot SET status = 'DIBATALKAN', dibatalkan_oleh = ?, dibatalkan_pada = ?, alasan_batal = ? WHERE id = ?`,
      input.userId, new Date().toISOString(), input.alasan.trim(), s.id
    );
  });
}
