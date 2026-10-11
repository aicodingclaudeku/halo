import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { requirePermission } from '@/services/PermissionService';
import { nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';

/**
 * Imbalan Kerja (Prioritas 9/K) — model SEDERHANA sesuai instruksi
 * ("gunakan model sederhana jika aplikasi belum memerlukan aktuaria
 * kompleks... JANGAN membuat fitur yang membutuhkan data aktuaria
 * yang tidak tersedia"). Koperasi kecil pada praktiknya mengelola
 * imbalan kerja (THR, bonus, pesangon sederhana) secara akrual dasar
 * — bukan PSAK 24 (imbalan pasca-kerja dengan asumsi aktuaria).
 *
 * AUDIT (sebelum fitur ini dibangun): akun 2-1600 "Utang Imbalan
 * Kerja" & 5-1050 "Beban Imbalan Kerja" SUDAH ADA di COA, dan
 * "Beban Imbalan Kerja" SUDAH BISA dipakai sebagai kategori
 * pengeluaran TUNAI langsung lewat BebanFormScreen (DEBIT Beban,
 * KREDIT Kas — kalau imbalan kerja dibayar tunai seketika tanpa
 * accrual, jalur ini SUDAH CUKUP, tidak perlu diubah). PEMBAYARAN
 * yang MENGURANGI kewajiban yang sudah di-accrual JUGA SUDAH BISA
 * lewat layar Kas & Bank umum (AccountPicker di sana tidak dibatasi
 * kategori — user tinggal pilih akun lawan "Utang Imbalan Kerja").
 *
 * Yang BENAR-BENAR HILANG (satu-satunya gap, makanya fungsi baru di
 * file ini HANYA satu): mekanisme untuk MENGAKUI KEWAJIBAN itu SENDIRI
 * sebelum dibayar (accrual, non-kas): DEBIT Beban Imbalan Kerja,
 * KREDIT Utang Imbalan Kerja. Tidak ada tabel baru — histori accrual
 * & pembayaran sama-sama sudah bisa ditelusuri lewat Buku Besar akun
 * 2-1600 (BukuBesarScreen, sudah ada), konsisten dengan pola
 * PenyisihanPiutang/SaldoAwalAkun yang juga tidak punya tabel register
 * terpisah.
 */

export interface AkruiImbalanKerjaInput {
  tanggal: string;
  nominal: Rupiah;
  keterangan: string; // wajib diisi (mis. "Akrual THR 2026", "Provisi bonus tahunan")
  createdBy: string;
}

/**
 * Akrual kewajiban imbalan kerja (belum dibayar): DEBIT Beban Imbalan
 * Kerja (5-1050), KREDIT Utang Imbalan Kerja (2-1600). Nominal murni
 * input manual (bukan hasil kalkulasi aktuaria) — sesuai instruksi,
 * model sederhana.
 */
export async function akruiImbalanKerja(input: AkruiImbalanKerjaInput): Promise<{ journalId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    if (!Number.isFinite(input.nominal) || input.nominal <= 0) {
      throw new Error('Nominal akrual imbalan kerja harus lebih dari 0.');
    }
    if (!input.keterangan.trim()) {
      throw new Error('Keterangan wajib diisi (mis. tujuan akrual: THR, bonus, pesangon).');
    }

    const bebanAccountId = await resolveAccountId(db, 'UTANG_IMBALAN_KERJA', 'DEBIT_BEBAN');
    const utangAccountId = await resolveAccountId(db, 'UTANG_IMBALAN_KERJA', 'KREDIT_DEFAULT');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'IMK', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'UTANG_IMBALAN_KERJA',
      nomorReferensi: nomorTransaksi,
      deskripsi: `Akrual imbalan kerja: ${input.keterangan.trim()} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: bebanAccountId, debit: input.nominal, kredit: 0 },
        { accountId: utangAccountId, debit: 0, kredit: input.nominal },
      ],
    });

    return { journalId };
  });
}

/**
 * Saldo kewajiban imbalan kerja saat ini — untuk rekonsiliasi/tampilan
 * ringkasan (dibaca langsung dari ledger akun 2-1600, bukan dihitung
 * terpisah). Histori lengkap (akrual maupun pembayaran) ada di Buku
 * Besar akun ini (BukuBesarScreen).
 */
export async function getSaldoUtangImbalanKerja(db: SQLite.SQLiteDatabase, asOfDate?: string): Promise<Rupiah> {
  const utangAccountId = await resolveAccountId(db, 'UTANG_IMBALAN_KERJA', 'KREDIT_DEFAULT');
  return getAccountBalance(db, utangAccountId, asOfDate);
}

/** Versi yang membuka koneksi db sendiri — dipakai langsung dari layar. */
export async function getSaldoUtangImbalanKerjaSaatIni(asOfDate?: string): Promise<Rupiah> {
  const db = await getDb();
  return getSaldoUtangImbalanKerja(db, asOfDate);
}

/** Cari akun 2-1600 (untuk dipakai layar yang mengarahkan ke Buku Besar). */
export async function getAkunUtangImbalanKerjaId(): Promise<string> {
  const db = await getDb();
  return resolveAccountId(db, 'UTANG_IMBALAN_KERJA', 'KREDIT_DEFAULT');
}

// ===========================================================================
// FASE 8 — IMBALAN KERJA PER PERSONEL & PER PERIODE
// ===========================================================================
//
// PERLUASAN dari `akruiImbalanKerja()` di atas, BUKAN service kedua.
// Arah jurnalnya sama persis; yang ditambahkan adalah tiga hal yang
// sebelumnya tidak punya tempat:
//
//   1. PENERIMA — berasal dari master `koperasi_personel`, bukan teks
//      bebas. Jenis personel & jabatan disalin otomatis dari master
//      sebagai SNAPSHOT saat pengakuan, karena jabatan seseorang dapat
//      berubah sementara bukti imbalan harus tetap menunjukkan jabatan
//      yang berlaku ketika imbalan itu diakui.
//   2. PERIODE — `period_key` berformat 'YYYY-MM'. String tampilan
//      seperti "September 2026" tidak pernah menjadi referensi.
//   3. PEMBAYARAN — Dr 2-1600 / Cr Kas-Bank, terpisah dari pengakuan,
//      sehingga beban tidak pernah diakui dua kali.
//
// `akruiImbalanKerja()` yang lama TIDAK diubah dan tetap dipakai untuk
// akrual kolektif tanpa penerima (provisi THR, pesangon). Keduanya
// menulis ke akun yang sama dan tetap terekonsiliasi lewat saldo 2-1600.

export type JenisImbalan = 'GAJI' | 'HONORARIUM' | 'TUNJANGAN' | 'BONUS' | 'LAINNYA';

/**
 * Vokabular jenis imbalan.
 *
 * SENGAJA PENDEK. Instruksi hanya menyebut satu contoh (HONORARIUM);
 * menambah puluhan enum tanpa kebutuhan hanya akan mengunci kosakata
 * yang belum tentu dipakai koperasi. Empat nilai ini cukup untuk
 * membedakan pos yang lazim, dan `LAINNYA` menampung sisanya lewat
 * kolom keterangan.
 */
export const JENIS_IMBALAN: readonly JenisImbalan[] = [
  // Permintaan pengguna: GAJI ditambahkan, ditempatkan sebelum HONORARIUM.
  // Additive murni — kolom `jenis_imbalan` tidak punya CHECK constraint,
  // dan perlakuan akuntansinya SAMA dengan jenis lain (Dr 5-1050 Beban
  // Imbalan Kerja / Cr 2-1600 Utang Imbalan Kerja). UNIQUE(personel,
  // periode, jenis) membuat GAJI dan HONORARIUM orang yang sama pada
  // periode yang sama dua baris yang sah dan terpisah.
  'GAJI',
  'HONORARIUM',
  'TUNJANGAN',
  'BONUS',
  'LAINNYA',
];

/** Label tampilan jenis imbalan — enum tidak pernah tampil mentah di layar/pesan. */
export const LABEL_JENIS_IMBALAN: Record<JenisImbalan, string> = {
  GAJI: 'Gaji',
  HONORARIUM: 'Honorarium',
  TUNJANGAN: 'Tunjangan',
  BONUS: 'Bonus',
  LAINNYA: 'Lainnya',
};

export interface CatatImbalanKerjaInput {
  personelId: string;
  /** 'YYYY-MM'. */
  periodKey: string;
  jenisImbalan?: JenisImbalan;
  /** Dasar perhitungan (mis. gaji pokok) — BUKAN nilai yang dijurnal. */
  dasarPerhitungan?: Rupiah;
  /** Nilai imbalan yang benar-benar diakui sebagai beban. */
  nilaiImbalan: Rupiah;
  tanggalPengakuan: string;
  tanggalJatuhTempo: string;
  keterangan?: string;
  createdBy: string;
}

export interface ImbalanKerjaRow {
  readonly id: string;
  readonly personelId: string;
  readonly namaPenerima: string;
  readonly jenisPersonel: string;
  readonly jabatan: string | null;
  readonly periodKey: string;
  readonly jenisImbalan: JenisImbalan;
  readonly dasarPerhitungan: Rupiah;
  readonly nilaiImbalan: Rupiah;
  readonly tanggalPengakuan: string;
  readonly tanggalJatuhTempo: string;
  readonly status: 'POSTED' | 'PAID';
  readonly journalId: string;
  readonly journalBayarId: string | null;
  readonly tanggalPembayaran: string | null;
  readonly keterangan: string | null;
}

/** Ubah 'YYYY-MM-DD' menjadi kunci periode 'YYYY-MM'. */
export function periodKeyDariTanggalImbalan(tanggal: string): string {
  return tanggal.slice(0, 7);
}

function petakanImbalan(r: Record<string, unknown>): ImbalanKerjaRow {
  return {
    id: r.id as string,
    personelId: r.personel_id as string,
    namaPenerima: (r.nama_penerima as string) ?? '',
    jenisPersonel: r.jenis_personel as string,
    jabatan: (r.jabatan as string | null) ?? null,
    periodKey: r.period_key as string,
    jenisImbalan: r.jenis_imbalan as JenisImbalan,
    dasarPerhitungan: r.dasar_perhitungan as number,
    nilaiImbalan: r.nilai_imbalan as number,
    tanggalPengakuan: r.tanggal_pengakuan as string,
    tanggalJatuhTempo: r.tanggal_jatuh_tempo as string,
    status: r.status as 'POSTED' | 'PAID',
    journalId: r.journal_id as string,
    journalBayarId: (r.journal_bayar_id as string | null) ?? null,
    tanggalPembayaran: (r.tanggal_pembayaran as string | null) ?? null,
    keterangan: (r.keterangan as string | null) ?? null,
  };
}

/**
 * PENGAKUAN IMBALAN: Dr 5-1050 Beban Imbalan Kerja / Cr 2-1600 Utang
 * Imbalan Kerja.
 *
 * IDEMPOTENSI ditegakkan DATABASE lewat
 * `UNIQUE(personel_id, period_key, jenis_imbalan)`. Menekan
 * "Simpan & Jurnal" dua kali menghasilkan satu baris dan satu jurnal;
 * percobaan kedua ditolak dengan pesan yang jelas, bukan diam-diam
 * membuat jurnal kedua.
 */
export async function catatImbalanKerja(input: CatatImbalanKerjaInput): Promise<ImbalanKerjaRow> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');

    if (!Number.isFinite(input.nilaiImbalan) || input.nilaiImbalan <= 0) {
      throw new Error('Nilai imbalan harus lebih dari 0.');
    }
    if (!/^\d{4}-\d{2}$/.test(input.periodKey)) {
      throw new Error(`Kunci periode harus berformat YYYY-MM — diterima "${input.periodKey}".`);
    }
    if (input.tanggalJatuhTempo < input.tanggalPengakuan) {
      throw new Error(
        `Tanggal jatuh tempo (${input.tanggalJatuhTempo}) tidak boleh mendahului tanggal pengakuan (${input.tanggalPengakuan}).`
      );
    }

    // PENERIMA WAJIB dari master personel — ini yang membuat jenis
    // personel & jabatan tidak pernah diketik bebas.
    const personel = await db.getFirstAsync<{
      id: string;
      nama: string;
      jenis_personel: string;
      jabatan: string | null;
      status_aktif: number;
    }>(
      `SELECT id, nama, jenis_personel, jabatan, status_aktif FROM koperasi_personel WHERE id = ?`,
      input.personelId
    );
    if (!personel) throw new Error('Personel penerima tidak ditemukan.');
    if (personel.status_aktif !== 1) {
      throw new Error(`Personel "${personel.nama}" berstatus nonaktif dan tidak dapat menerima imbalan baru.`);
    }

    const jenisImbalan = input.jenisImbalan ?? 'HONORARIUM';
    const duplikat = await db.getFirstAsync<{ id: string; period_key: string }>(
      `SELECT id, period_key FROM imbalan_kerja
        WHERE personel_id = ? AND period_key = ? AND jenis_imbalan = ?`,
      input.personelId,
      input.periodKey,
      jenisImbalan
    );
    if (duplikat) {
      throw new Error(
        `Imbalan ${LABEL_JENIS_IMBALAN[jenisImbalan] ?? jenisImbalan} untuk ${personel.nama} periode ${input.periodKey} sudah pernah dibukukan.`
      );
    }

    const bebanAccountId = await resolveAccountId(db, 'UTANG_IMBALAN_KERJA', 'DEBIT_BEBAN');
    const utangAccountId = await resolveAccountId(db, 'UTANG_IMBALAN_KERJA', 'KREDIT_DEFAULT');
    const tahun = parseInt(input.tanggalPengakuan.slice(0, 4), 10);
    const nomor = await nextSequence(db, 'IMK', tahun);
    const id = `imk-${nomor}`;

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggalPengakuan,
      sumberTransaksi: 'UTANG_IMBALAN_KERJA',
      sumberId: id,
      nomorReferensi: nomor,
      deskripsi: `Imbalan ${jenisImbalan} ${input.periodKey} - ${personel.nama} - ${nomor}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: bebanAccountId, debit: input.nilaiImbalan, kredit: 0 },
        { accountId: utangAccountId, debit: 0, kredit: input.nilaiImbalan },
      ],
    });

    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO imbalan_kerja
        (id, personel_id, period_key, jenis_imbalan, jenis_personel, jabatan,
         dasar_perhitungan, nilai_imbalan, tanggal_pengakuan, tanggal_jatuh_tempo,
         keterangan, status, journal_id, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'POSTED',?,?,?,?)`,
      id,
      personel.id,
      input.periodKey,
      jenisImbalan,
      personel.jenis_personel,
      personel.jabatan,
      input.dasarPerhitungan ?? 0,
      input.nilaiImbalan,
      input.tanggalPengakuan,
      input.tanggalJatuhTempo,
      input.keterangan ?? null,
      journalId,
      input.createdBy,
      now,
      now
    );

    const baris = await db.getFirstAsync<Record<string, unknown>>(
      `SELECT i.*, p.nama AS nama_penerima FROM imbalan_kerja i
         JOIN koperasi_personel p ON p.id = i.personel_id WHERE i.id = ?`,
      id
    );
    return petakanImbalan(baris as Record<string, unknown>);
  });
}

export interface BayarImbalanKerjaInput {
  imbalanId: string;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  createdBy: string;
}

/**
 * PEMBAYARAN IMBALAN: Dr 2-1600 Utang Imbalan Kerja / Cr Kas/Bank.
 *
 * TIDAK PERNAH mendebit beban lagi — bebannya sudah diakui pada
 * pengakuan. Membayar yang sudah berstatus PAID ditolak, sehingga
 * liabilitas tidak mungkin menjadi negatif dan kas tidak mungkin keluar
 * dua kali untuk satu imbalan.
 */
export async function bayarImbalanKerja(
  input: BayarImbalanKerjaInput
): Promise<{ journalId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');

    const row = await db.getFirstAsync<{
      id: string;
      nilai_imbalan: number;
      status: string;
      period_key: string;
      personel_id: string;
    }>(`SELECT id, nilai_imbalan, status, period_key, personel_id FROM imbalan_kerja WHERE id = ?`,
      input.imbalanId
    );
    if (!row) throw new Error('Data imbalan kerja tidak ditemukan.');
    if (row.status === 'PAID') {
      throw new Error('Imbalan ini sudah dibayar. Pembayaran kedua ditolak.');
    }

    const utangAccountId = await resolveAccountId(db, 'UTANG_IMBALAN_KERJA', 'KREDIT_DEFAULT');
    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const cek = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: row.nilai_imbalan,
    });
    if (!cek.valid) throw new Error(cek.reason);

    const tahun = parseInt(input.tanggal.slice(0, 4), 10);
    const nomor = await nextSequence(db, 'IMK-BYR', tahun);
    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'UTANG_IMBALAN_KERJA_BAYAR',
      sumberId: row.id,
      nomorReferensi: nomor,
      deskripsi: `Pembayaran imbalan kerja ${row.period_key} - ${nomor}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: utangAccountId, debit: row.nilai_imbalan, kredit: 0 },
        { accountId: kasBankAccountId, debit: 0, kredit: row.nilai_imbalan },
      ],
    });

    await db.runAsync(
      `UPDATE imbalan_kerja
          SET status = 'PAID', journal_bayar_id = ?, tanggal_pembayaran = ?,
              sumber_dana = ?, bank_account_id = ?, updated_at = ?
        WHERE id = ?`,
      journalId,
      input.tanggal,
      input.sumberDana,
      input.bankAccountId ?? null,
      new Date().toISOString(),
      row.id
    );

    return { journalId };
  });
}

export async function getImbalanKerja(id: string): Promise<ImbalanKerjaRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT i.*, p.nama AS nama_penerima FROM imbalan_kerja i
       JOIN koperasi_personel p ON p.id = i.personel_id WHERE i.id = ?`,
    id
  );
  return r ? petakanImbalan(r) : null;
}

export async function listImbalanKerja(opts: { periodKey?: string } = {}): Promise<ImbalanKerjaRow[]> {
  const db = await getDb();
  const where = opts.periodKey ? 'WHERE i.period_key = ?' : '';
  const params = opts.periodKey ? [opts.periodKey] : [];
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT i.*, p.nama AS nama_penerima FROM imbalan_kerja i
       JOIN koperasi_personel p ON p.id = i.personel_id
     ${where}
     ORDER BY i.tanggal_pengakuan DESC, p.nama ASC`,
    ...params
  );
  return rows.map(petakanImbalan);
}

// ===========================================================================
// Poin 19 — NILAI AWAL (DEFAULT) PENCATATAN IMBALAN PER PENERIMA & JENIS
// ===========================================================================
//
// Memakai tabel kunci-nilai EXISTING `app_config` (tidak ada tabel baru,
// tidak ada perubahan skema). Nilai awal HANYA mengisi form di periode
// berikutnya; ia TIDAK pernah dijurnal, TIDAK mengubah imbalan yang sudah
// tercatat, dan selalu dapat diedit operator sebelum disimpan. Pencatatan
// tetap lewat `catatImbalanKerja()` (Dr Beban Imbalan Kerja / Cr Utang
// Imbalan Kerja) tanpa perubahan apa pun.

export interface NilaiAwalImbalan {
  /** Dasar perhitungan (mis. gaji pokok) — informasi, bukan nilai jurnal. */
  dasarPerhitungan: Rupiah;
  nilaiImbalan: Rupiah;
  /** Jarak jatuh tempo dari tanggal pengakuan, dalam hari kalender. */
  selisihHariJatuhTempo: number;
  keterangan: string | null;
}

const PREFIKS_NILAI_AWAL_IMBALAN = 'IMBALAN_KERJA_NILAI_AWAL';

function kunciNilaiAwalImbalan(personelId: string, jenis: JenisImbalan): string {
  return `${PREFIKS_NILAI_AWAL_IMBALAN}:${personelId}:${jenis}`;
}

function bilanganBulatTakNegatif(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** Nilai awal tersimpan untuk penerima + jenis imbalan; `null` bila belum ada / rusak. */
export async function getNilaiAwalImbalan(personelId: string, jenis: JenisImbalan): Promise<NilaiAwalImbalan | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM app_config WHERE key = ?`,
    kunciNilaiAwalImbalan(personelId, jenis)
  );
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Record<string, unknown>;
    const dasar = bilanganBulatTakNegatif(v.dasarPerhitungan);
    const nilai = bilanganBulatTakNegatif(v.nilaiImbalan);
    const selisih = bilanganBulatTakNegatif(v.selisihHariJatuhTempo);
    if (dasar === null || nilai === null || selisih === null) return null;
    return {
      dasarPerhitungan: dasar,
      nilaiImbalan: nilai,
      selisihHariJatuhTempo: selisih,
      keterangan: typeof v.keterangan === 'string' && v.keterangan.trim() ? v.keterangan.trim() : null,
    };
  } catch {
    return null;
  }
}

/** Simpan/ganti nilai awal. Hanya pengguna yang berhak mencatat imbalan. */
export async function simpanNilaiAwalImbalan(
  personelId: string,
  jenis: JenisImbalan,
  nilai: NilaiAwalImbalan,
  actingUserId: string
): Promise<void> {
  if (!JENIS_IMBALAN.includes(jenis)) throw new Error('Jenis imbalan tidak dikenal.');
  if (bilanganBulatTakNegatif(nilai.dasarPerhitungan) === null || bilanganBulatTakNegatif(nilai.nilaiImbalan) === null) {
    throw new Error('Nilai awal harus bilangan bulat rupiah, tidak negatif.');
  }
  if (bilanganBulatTakNegatif(nilai.selisihHariJatuhTempo) === null) {
    throw new Error('Jarak jatuh tempo tidak valid.');
  }
  await withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'kas_bank', 'create');
    await db.runAsync(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      kunciNilaiAwalImbalan(personelId, jenis),
      JSON.stringify({
        dasarPerhitungan: nilai.dasarPerhitungan,
        nilaiImbalan: nilai.nilaiImbalan,
        selisihHariJatuhTempo: nilai.selisihHariJatuhTempo,
        keterangan: nilai.keterangan?.trim() || null,
      }),
      new Date().toISOString()
    );
  });
}

/** Hapus nilai awal (imbalan yang sudah tercatat tidak tersentuh). */
export async function hapusNilaiAwalImbalan(personelId: string, jenis: JenisImbalan, actingUserId: string): Promise<void> {
  await withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'kas_bank', 'create');
    await db.runAsync(`DELETE FROM app_config WHERE key = ?`, kunciNilaiAwalImbalan(personelId, jenis));
  });
}
