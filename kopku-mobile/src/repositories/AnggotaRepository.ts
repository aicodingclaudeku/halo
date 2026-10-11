import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { newId } from '@/utils/id';
import { requirePermission } from '@/services/PermissionService';

/** Audit trail anggota (permintaan pengguna §9 — Aktivitas Log): "Tambah anggota"/"Edit anggota"/"Hapus anggota" WAJIB tercatat. Pola sama dengan RAKService/InvestasiService/RATService.writeAuditLog. */
async function writeAuditLog(
  db: SQLite.SQLiteDatabase,
  userId: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  entityId: string,
  dataSesudah?: Record<string, unknown>
) {
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    action,
    'anggota',
    entityId,
    dataSesudah ? JSON.stringify(dataSesudah) : null,
    now.toISOString()
  );
}

export type StatusAnggota = 'AKTIF' | 'TIDAK_AKTIF' | 'KELUAR' | 'MENINGGAL';
// Permintaan pengguna §8.
export type JenisKelamin = 'LAKI_LAKI' | 'PEREMPUAN';

export interface Anggota {
  id: string;
  nomorAnggota: string;
  nik?: string | null;
  namaLengkap: string;
  jenisKelamin?: JenisKelamin | null;
  tempatLahir?: string;
  tanggalLahir?: string;
  alamat?: string;
  nomorHp?: string;
  pekerjaan?: string;
  tanggalBergabung: string;
  status: StatusAnggota;
  fotoUri?: string;
  catatan?: string;
}

function rowToAnggota(row: any): Anggota {
  return {
    id: row.id,
    nomorAnggota: row.nomor_anggota,
    nik: row.nik,
    namaLengkap: row.nama_lengkap,
    jenisKelamin: row.jenis_kelamin ?? null,
    tempatLahir: row.tempat_lahir,
    tanggalLahir: row.tanggal_lahir,
    alamat: row.alamat,
    nomorHp: row.nomor_hp,
    pekerjaan: row.pekerjaan,
    tanggalBergabung: row.tanggal_bergabung,
    status: row.status,
    fotoUri: row.foto_uri,
    catatan: row.catatan,
  };
}

export async function listAnggota(opts: {
  search?: string;
  status?: StatusAnggota;
  limit?: number;
  offset?: number;
  /**
   * Update pasca-Phase 18/19 (permintaan pengguna §Q): ambil SEMUA
   * baris tanpa LIMIT/OFFSET sama sekali — dipakai layar Anggota
   * (AnggotaListScreen) yang sekarang tidak lagi dibatasi 50. Picker
   * transaksi lain yang SENGAJA membatasi (mis. autocomplete ringan)
   * TIDAK terpengaruh — tetap pakai `limit` seperti biasa kalau opsi
   * ini tidak diisi.
   */
  semuaData?: boolean;
} = {}): Promise<Anggota[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: (string | number)[] = [];

  if (opts.search) {
    filters.push('(nama_lengkap LIKE ? OR nomor_anggota LIKE ? OR nik LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }
  if (opts.status) {
    filters.push('status = ?');
    params.push(opts.status);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  if (opts.semuaData) {
    const rows = await db.getAllAsync(`SELECT * FROM anggota ${where} ORDER BY nama_lengkap ASC`, ...params);
    return rows.map(rowToAnggota);
  }

  const limit = opts.limit ?? 50; // picker/autocomplete lain: pagination tetap seperti semula
  const offset = opts.offset ?? 0;

  const rows = await db.getAllAsync(
    `SELECT * FROM anggota ${where} ORDER BY nama_lengkap ASC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );
  return rows.map(rowToAnggota);
}

export async function getAnggotaById(id: string): Promise<Anggota | null> {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT * FROM anggota WHERE id = ?', id);
  return row ? rowToAnggota(row) : null;
}

const NOMOR_ANGGOTA_PREFIX = 'A';
const NOMOR_ANGGOTA_PAD = 5; // A00001, A00002, ...

/**
 * Nomor anggota otomatis (Phase 17 §C) — bukan diketik user lagi.
 *
 * Dijalankan DI DALAM transaksi yang sama dengan INSERT anggota
 * (sama seperti pola `nextSequence` yang sudah dipakai untuk nomor
 * jurnal/transaksi lain di app ini), supaya aman terhadap dua proses
 * insert bersamaan — write SQLite di app ini serial lewat satu koneksi
 * `withTransaction`, jadi tidak ada celah antara baca nilai terakhir
 * dan update-nya.
 *
 * `sequence_counter` di-seed dari nomor anggota tertinggi yang SUDAH
 * ADA di tabel (bukan mulai dari 0), supaya kalau ada data anggota
 * lama yang nomornya belum pernah lewat counter ini (mis. hasil
 * import/migrasi), nomor baru tetap lanjut setelah nomor tertinggi
 * yang sudah dipakai — tidak akan tabrakan/duplicate.
 */
async function generateNomorAnggotaBerikutnya(db: SQLite.SQLiteDatabase): Promise<string> {
  const maxRow = await db.getFirstAsync<{ maxNum: number | null }>(
    `SELECT MAX(CAST(SUBSTR(nomor_anggota, LENGTH(?) + 1) AS INTEGER)) as maxNum
     FROM anggota WHERE nomor_anggota GLOB ?`,
    NOMOR_ANGGOTA_PREFIX,
    `${NOMOR_ANGGOTA_PREFIX}[0-9]*`
  );
  const existingMax = maxRow?.maxNum ?? 0;
  const seqKey = 'ANGGOTA';

  await db.runAsync(
    `INSERT INTO sequence_counter (seq_key, last_value) VALUES (?, ?)
     ON CONFLICT(seq_key) DO UPDATE SET last_value = MAX(sequence_counter.last_value, excluded.last_value)`,
    seqKey,
    existingMax
  );
  await db.runAsync(`UPDATE sequence_counter SET last_value = last_value + 1 WHERE seq_key = ?`, seqKey);
  const row = await db.getFirstAsync<{ last_value: number }>(
    `SELECT last_value FROM sequence_counter WHERE seq_key = ?`,
    seqKey
  );
  const num = (row?.last_value ?? existingMax + 1).toString().padStart(NOMOR_ANGGOTA_PAD, '0');
  return `${NOMOR_ANGGOTA_PREFIX}${num}`;
}

export async function createAnggota(
  actingUserId: string,
  input: Omit<Anggota, 'id' | 'status' | 'nomorAnggota'> & { status?: StatusAnggota }
): Promise<Anggota> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'anggota', 'create');
    const id = newId();
    const nomorAnggota = await generateNomorAnggotaBerikutnya(db);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota
        (id, nomor_anggota, nik, nama_lengkap, jenis_kelamin, tempat_lahir, tanggal_lahir, alamat,
         nomor_hp, pekerjaan, tanggal_bergabung, status, foto_uri, catatan, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, nomorAnggota, input.nik ?? null, input.namaLengkap, input.jenisKelamin ?? null, input.tempatLahir ?? null,
      input.tanggalLahir ?? null, input.alamat ?? null, input.nomorHp ?? null,
      input.pekerjaan ?? null, input.tanggalBergabung, input.status ?? 'AKTIF',
      input.fotoUri ?? null, input.catatan ?? null, now, now
    );
    await writeAuditLog(db, actingUserId, 'CREATE', id, { nomorAnggota, namaLengkap: input.namaLengkap });
    return { id, nomorAnggota, status: input.status ?? 'AKTIF', ...input } as Anggota;
  });
}

/** Ubah status anggota saja (mis. AKTIF -> KELUAR) tanpa update field lain. */
export async function updateAnggotaStatus(actingUserId: string, id: string, status: StatusAnggota): Promise<void> {
  const db = await getDb();
  await requirePermission(db, actingUserId, 'anggota', 'edit');
  await db.runAsync('UPDATE anggota SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id);
  await writeAuditLog(db, actingUserId, 'UPDATE', id, { status });
}

/**
 * Update lengkap data anggota (bagian "U" dari CRUD, PRD §7).
 *
 * Phase 17 §C: `nomor_anggota` SENGAJA TIDAK ada di klausa SET —
 * nomor anggota tidak boleh berubah lewat edit, dan ini dijaga di
 * repository layer (bukan cuma dengan menyembunyikan field di UI),
 * supaya tidak ada jalan lain yang bisa mengubahnya secara tidak
 * sengaja. Parameter `nomorAnggota` di `input` diabaikan.
 */
export async function updateAnggota(
  actingUserId: string,
  id: string,
  input: Omit<Anggota, 'id' | 'nomorAnggota'>
): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'anggota', 'edit');
    await db.runAsync(
      `UPDATE anggota SET
         nik = ?, nama_lengkap = ?, jenis_kelamin = ?, tempat_lahir = ?, tanggal_lahir = ?,
         alamat = ?, nomor_hp = ?, pekerjaan = ?, tanggal_bergabung = ?, status = ?,
         foto_uri = ?, catatan = ?, updated_at = ?
       WHERE id = ?`,
      input.nik ?? null, input.namaLengkap, input.jenisKelamin ?? null, input.tempatLahir ?? null,
      input.tanggalLahir ?? null, input.alamat ?? null, input.nomorHp ?? null,
      input.pekerjaan ?? null, input.tanggalBergabung, input.status,
      input.fotoUri ?? null, input.catatan ?? null, new Date().toISOString(), id
    );
    await writeAuditLog(db, actingUserId, 'UPDATE', id, { namaLengkap: input.namaLengkap, status: input.status });
  });
}

/**
 * Hapus anggota (bagian "D" dari CRUD, PRD §7). Hanya diizinkan jika
 * anggota belum punya transaksi keuangan sama sekali — anggota yang
 * sudah bertransaksi harus diubah statusnya (KELUAR/TIDAK_AKTIF),
 * bukan dihapus, supaya histori jurnal tetap utuh (PRD §43).
 */
export async function deleteAnggota(actingUserId: string, id: string): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'anggota', 'edit'); // hapus dianggap setara edit-destruktif
    const simpanan = await db.getFirstAsync<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM simpanan_transaksi WHERE anggota_id = ?',
      id
    );
    const pinjaman = await db.getFirstAsync<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM pinjaman WHERE anggota_id = ?',
      id
    );
    if ((simpanan?.cnt ?? 0) > 0 || (pinjaman?.cnt ?? 0) > 0) {
      throw new Error(
        'Anggota ini sudah mempunyai transaksi simpanan/pinjaman dan tidak bisa dihapus. Ubah status menjadi "Keluar" atau "Tidak Aktif" sebagai gantinya.'
      );
    }
    // RC-S132 — anggota yang menjadi akun login (user ber-role ANGGOTA)
    // tidak dihapus diam-diam; tautannya harus diputus dulu oleh Admin.
    const pengguna = await db.getFirstAsync<{ username: string }>(
      'SELECT username FROM app_user WHERE anggota_id = ? LIMIT 1',
      id
    );
    if (pengguna) {
      throw new Error(
        `Anggota ini ditautkan ke akun login "${pengguna.username}". Ubah atau nonaktifkan akun itu di Pengaturan › User Management sebelum menghapus anggota.`
      );
    }
    await db.runAsync('DELETE FROM anggota WHERE id = ?', id);
    await writeAuditLog(db, actingUserId, 'DELETE', id);
  });
}

export interface HistoriTransaksiRow {
  id: string;
  tanggal: string;
  jenis: string;       // e.g. 'Simpanan Pokok', 'Angsuran Pinjaman'
  tipe: string;        // SETOR/TARIK/... atau deskripsi pembayaran
  nominal: number;
  nomorReferensi: string;
}

/** Histori transaksi anggota gabungan simpanan + pembayaran angsuran (PRD §7). */
export async function getHistoriTransaksiAnggota(
  anggotaId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<HistoriTransaksiRow[]> {
  const db = await getDb();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const simpananRows = await db.getAllAsync<any>(
    `SELECT id, tanggal, jenis, tipe, nominal, nomor_transaksi
     FROM simpanan_transaksi WHERE anggota_id = ? ORDER BY tanggal DESC LIMIT ? OFFSET ?`,
    anggotaId, limit, offset
  );
  const angsuranRows = await db.getAllAsync<any>(
    `SELECT ap.id, ap.tanggal, p.nomor_pinjaman, ap.nominal, aj.nomor_angsuran
     FROM angsuran_pembayaran ap
     JOIN pinjaman p ON p.id = ap.pinjaman_id
     LEFT JOIN angsuran_jadwal aj ON aj.id = ap.jadwal_id
     WHERE p.anggota_id = ? ORDER BY ap.tanggal DESC LIMIT ? OFFSET ?`,
    anggotaId, limit, offset
  );

  const combined: HistoriTransaksiRow[] = [
    ...simpananRows.map((r) => ({
      id: r.id,
      tanggal: r.tanggal,
      jenis: `Simpanan ${r.jenis}`,
      tipe: r.tipe,
      nominal: r.nominal,
      nomorReferensi: r.nomor_transaksi,
    })),
    ...angsuranRows.map((r) => ({
      id: r.id,
      tanggal: r.tanggal,
      jenis: 'Angsuran Pinjaman',
      tipe: `Angsuran ke-${r.nomor_angsuran ?? '-'}`,
      nominal: r.nominal,
      nomorReferensi: r.nomor_pinjaman,
    })),
  ];

  return combined.sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1)).slice(0, limit);
}
