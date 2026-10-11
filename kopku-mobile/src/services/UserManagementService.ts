import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { hashPin, generateSalt } from '@/security/pin';
// Konstanta versi diambil LANGSUNG dari modul murninya, bukan lewat
// `@/security/pin`: modul itu di-mock sebagian di banyak suite, dan
// konstanta yang hilang dari mock akan terkirim ke SQLite sebagai
// undefined — gagal saat bind, bukan saat kompilasi.
import { VERSI_HASH_PIN_SEKARANG, hashPinV2Async, verifikasiPinAsync } from '@/security/pinHash';
import { periksaPassword, rapikanPassword, PESAN_MASALAH_PASSWORD } from '@/security/kebijakanPassword';
import { periksaUsername, rapikanUsername } from '@/security/kebijakanUsername';
import * as Crypto from 'expo-crypto';
import { newId } from '@/utils/id';
import { Role, ROLES } from '@/config/defaultPermissions';

/**
 * Service User Management (fase 8 §1-2, §7-8). Pengelolaan user (buat
 * user baru, ganti role, aktif/nonaktif, reset PIN) SENGAJA di-hardcode
 * ADMIN-only di sini — BUKAN cuma bergantung pada `role_permission`
 * matrix. Ini pertahanan berlapis: kalau suatu saat matrix
 * `user_management` untuk ADMIN ke-edit jadi salah (mis. admin sendiri
 * tidak sengaja mencabut izinnya sendiri lewat layar Permission Matrix),
 * aplikasi tidak boleh sampai TIDAK ADA SATU PUN yang bisa mengelola
 * user lagi — aturan dasar "hanya Admin" tidak boleh bergantung pada
 * data yang bisa salah dikonfigurasi.
 */

export class HanyaAdminError extends Error {
  constructor() {
    super('Hanya Admin yang dapat mengelola user.');
    this.name = 'HanyaAdminError';
  }
}

async function pastikanAdmin(userId: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ role: Role; aktif: number }>(`SELECT role, aktif FROM app_user WHERE id = ?`, userId);
  if (!row || !row.aktif || row.role !== 'ADMIN') {
    throw new HanyaAdminError();
  }
}

export interface UserItem {
  id: string;
  nama: string;
  username: string;
  role: Role;
  aktif: boolean;
  biometricEnabled: boolean;
  /**
   * RC-S117 — true bila password user ini masih berupa salinan PIN lama
   * hasil migrasi v76, jadi belum memenuhi kebijakan password baru.
   * Ditampilkan apa adanya di daftar supaya admin tahu mana yang masih
   * perlu diganti, bukan disembunyikan.
   */
  passwordWarisan: boolean;
  /** RC-S132 — anggota yang ditautkan (hanya role ANGGOTA); null bila belum. */
  anggotaId: string | null;
  nomorAnggota: string | null;
  /** RC-S133.5 — user harus mengganti password saat masuk berikutnya. */
  wajibGantiPassword?: boolean;
}

function rowToUserItem(row: any): UserItem {
  return {
    id: row.id,
    nama: row.nama,
    username: row.username,
    role: row.role,
    aktif: !!row.aktif,
    biometricEnabled: !!row.biometric_enabled,
    // Password hasil migrasi adalah SALINAN PERSIS hash PIN. Begitu
    // password diganti, salt-nya dibuat baru sehingga keduanya tidak
    // mungkin sama lagi — perbandingan ini karena itu cukup, dan tidak
    // perlu kolom penanda tambahan yang bisa menyimpang dari kenyataan.
    passwordWarisan: !!row.password_hash && row.password_hash === row.pin_hash,
    anggotaId: row.anggota_id ?? null,
    nomorAnggota: row.anggota_nomor ?? null,
  };
}

/**
 * RC-S132 — USER BER-ROLE ANGGOTA DITAUTKAN KE DATA ANGGOTA.
 *
 * Untuk role ANGGOTA, identitas user BUKAN ketikan bebas: Admin memilih
 * anggota yang sudah terdaftar, dan nama user mengikuti nama lengkap
 * anggota itu. Aturannya:
 *  - anggota wajib dipilih dan harus ada;
 *  - anggota berstatus KELUAR/MENINGGAL tidak dapat dijadikan akun;
 *  - satu anggota paling banyak satu akun (juga dijaga indeks unik v80);
 *  - role lain tidak boleh membawa tautan anggota (selalu NULL).
 * Mengembalikan nama yang dipakai untuk kolom `nama`.
 */
async function tentukanTautanAnggota(
  db: SQLite.SQLiteDatabase,
  role: Role,
  anggotaId: string | null | undefined,
  kecualiUserId: string | null
): Promise<{ anggotaId: string | null; nama: string | null }> {
  if (role !== 'ANGGOTA') return { anggotaId: null, nama: null };
  if (!anggotaId) throw new Error('Pilih anggota untuk akun ber-role Anggota.');
  const anggota = await db.getFirstAsync<{ id: string; nama_lengkap: string; status: string }>(
    `SELECT id, nama_lengkap, status FROM anggota WHERE id = ?`,
    anggotaId
  );
  if (!anggota) throw new Error('Anggota tidak ditemukan.');
  if (anggota.status === 'KELUAR' || anggota.status === 'MENINGGAL') {
    throw new Error('Anggota yang sudah keluar atau meninggal tidak dapat dibuatkan akun.');
  }
  const dipakai = await db.getFirstAsync<{ username: string }>(
    `SELECT username FROM app_user WHERE anggota_id = ? AND id <> ?`,
    anggotaId,
    kecualiUserId ?? ''
  );
  if (dipakai) throw new Error(`Anggota ini sudah memiliki akun "${dipakai.username}".`);
  return { anggotaId: anggota.id, nama: anggota.nama_lengkap };
}


/**
 * RC-S117 — penjaga "admin terakhir", diekstrak supaya `updateUserRole`
 * dan `updateUser` memakai aturan yang SAMA PERSIS. Dua salinan aturan
 * ini cepat atau lambat akan berbeda, dan yang longgar akan menjadi
 * jalan keluar tanpa disadari — koperasi tanpa satu pun admin aktif
 * tidak punya cara mengangkat admin baru.
 */
async function pastikanBukanAdminTerakhir(db: any, userId: string): Promise<void> {
  const jumlahAdminAktif = await db.getFirstAsync(
    `SELECT COUNT(*) as cnt FROM app_user WHERE role = 'ADMIN' AND aktif = 1`
  );
  if ((jumlahAdminAktif?.cnt ?? 0) <= 1) {
    throw new Error('Tidak bisa mengubah role Admin terakhir — minimal harus ada satu Admin aktif.');
  }
  void userId;
}

/** RC-S133.5 — lempar bila username tidak memenuhi kebijakan (security/kebijakanUsername.ts). */
function pastikanUsernameSah(username: string): void {
  const hasil = periksaUsername(username);
  if (!hasil.sah) throw new Error(hasil.pesan ?? 'Username tidak sah.');
}

/** Lempar bila password tidak memenuhi kebijakan (security/kebijakanPassword.ts). */
function pastikanPasswordSah(password: string, username?: string): void {
  const hasil = periksaPassword({ password, username });
  if (!hasil.sah) {
    throw new Error(hasil.pesan ?? PESAN_MASALAH_PASSWORD.KOSONG);
  }
}

/**
 * Nilai PIN yang TIDAK DAPAT dipakai siapa pun — kolom `pin_hash` NOT
 * NULL di skema, sementara PIN sesungguhnya ditetapkan sendiri oleh
 * pemiliknya lewat Pengaturan > Keamanan. Pola yang sama dipakai
 * SetupService untuk admin pertama.
 */
function pinAcakTidakDapatDipakai(): string {
  return `nopin:${generateSalt()}`;
}

/** Daftar semua user (fase 8 §1) — Admin only. */
export async function listUsers(actingUserId: string): Promise<UserItem[]> {
  await pastikanAdmin(actingUserId);
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT u.*, a.nomor_anggota AS anggota_nomor
       FROM app_user u LEFT JOIN anggota a ON a.id = u.anggota_id
      WHERE u.username NOT LIKE '${PREFIX_USERNAME_DIHAPUS}%'
      ORDER BY u.nama ASC`
  );
  const wajib = await daftarWajibGantiPassword(db);
  return rows.map((r) => ({ ...rowToUserItem(r), wajibGantiPassword: wajib.has(r.id) }));
}

export interface CreateUserInput {
  nama: string;
  username: string;
  role: Role;
  /**
   * RC-S117 — PASSWORD, bukan PIN.
   *
   * PIN tidak lagi menjadi kredensial masuk; ia hanya membuka kunci
   * aplikasi pada perangkat yang sudah dipegang orangnya, dan
   * ditetapkan sendiri oleh pemiliknya lewat Pengaturan > Keamanan.
   * Admin tidak menetapkan PIN orang lain — itu bukan miliknya.
   */
  password: string;
  /** RC-S132 — WAJIB untuk role ANGGOTA (nama mengikuti data anggota); diabaikan untuk role lain. */
  anggotaId?: string | null;
}

/** Admin membuat user baru (fase 8 §1, §7). */
export async function createUser(actingUserId: string, input: CreateUserInput): Promise<{ id: string }> {
  await pastikanAdmin(actingUserId);

  if (!ROLES.includes(input.role)) {
    throw new Error(`Role "${input.role}" tidak dikenal.`);
  }
  // RC-S133.5 — username dirapikan & diperiksa dengan kebijakan yang SAMA
  // dengan Setup (sebelumnya tidak dipangkas, sehingga username berspasi
  // di ujung tidak pernah bisa dipakai masuk).
  input = { ...input, username: rapikanUsername(input.username) };
  pastikanPasswordSah(input.password, input.username);
  pastikanUsernameSah(input.username);

  return withTransaction(async (db) => {
    const existing = await db.getFirstAsync<{ id: string }>(`SELECT id FROM app_user WHERE username = ?`, input.username);
    if (existing) throw new Error(`Username "${input.username}" sudah dipakai.`);
    const tautan = await tentukanTautanAnggota(db, input.role, input.anggotaId, null);
    const nama = (tautan.nama ?? input.nama ?? '').trim();
    if (!nama) throw new Error('Nama wajib diisi.');

    const id = newId();
    const now = new Date().toISOString();

    const saltPassword = generateSalt();
    const passwordHash = await hashPin(rapikanPassword(input.password), saltPassword);

    // PIN diisi nilai ACAK yang tidak dapat dipakai siapa pun. Kolomnya
    // NOT NULL di skema, sementara PIN yang sesungguhnya ditetapkan
    // sendiri oleh pemiliknya lewat Pengaturan > Keamanan. Menyalin
    // password ke kolom PIN akan membuat password ikut menjadi kunci
    // layar — persis penggabungan dua peran yang RC-S117 pisahkan.
    const saltPin = generateSalt();
    const pinHash = await hashPin(pinAcakTidakDapatDipakai(), saltPin);

    await db.runAsync(
      `INSERT INTO app_user
        (id, nama, username, role, pin_hash, pin_salt, pin_hash_versi,
         password_hash, password_salt, password_hash_versi, biometric_enabled, aktif, created_at, updated_at, anggota_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,1,?,?,?)`,
      id,
      nama,
      input.username,
      input.role,
      pinHash,
      saltPin,
      VERSI_HASH_PIN_SEKARANG,
      passwordHash,
      saltPassword,
      VERSI_HASH_PIN_SEKARANG,
      now,
      now,
      tautan.anggotaId
    );

    await writeAuditLog(db, actingUserId, 'CREATE', id, {
      nama,
      username: input.username,
      role: input.role,
      ...(tautan.anggotaId ? { anggotaId: tautan.anggotaId } : {}),
    });
    return { id };
  });
}

/** Admin mengubah role user (fase 8 §8). */
export async function updateUserRole(actingUserId: string, userId: string, newRole: Role): Promise<void> {
  await pastikanAdmin(actingUserId);
  if (!ROLES.includes(newRole)) {
    throw new Error(`Role "${newRole}" tidak dikenal.`);
  }

  return withTransaction(async (db) => {
    const target = await db.getFirstAsync<{ id: string; role: Role }>(`SELECT id, role FROM app_user WHERE id = ?`, userId);
    if (!target) throw new Error('User tidak ditemukan.');

    // Proteksi: jangan sampai Admin terakhir mengubah role dirinya sendiri
    // jadi bukan ADMIN, membuat aplikasi tanpa satu pun Admin aktif.
    if (target.role === 'ADMIN' && newRole !== 'ADMIN') {
      await pastikanBukanAdminTerakhir(db, userId);
    }

    // RC-S132 — role ANGGOTA wajib bertaut ke data anggota; tautan itu
    // hanya bisa dipilih lewat `updateUser`. Role lain selalu tanpa tautan.
    if (newRole === 'ANGGOTA' && target.role !== 'ANGGOTA') {
      throw new Error('Untuk menjadikan user ber-role Anggota, sunting user dan pilih anggotanya.');
    }
    await db.runAsync(
      `UPDATE app_user SET role = ?, anggota_id = CASE WHEN ? = 'ANGGOTA' THEN anggota_id ELSE NULL END, updated_at = ? WHERE id = ?`,
      newRole,
      newRole,
      new Date().toISOString(),
      userId
    );
    await writeAuditLog(db, actingUserId, 'UPDATE_ROLE', userId, { roleLama: target.role, roleBaru: newRole });
  });
}

/** Admin mengaktifkan/menonaktifkan user (fase 8 §1). */
export async function updateUserStatus(actingUserId: string, userId: string, aktif: boolean): Promise<void> {
  await pastikanAdmin(actingUserId);

  return withTransaction(async (db) => {
    const target = await db.getFirstAsync<{ id: string; role: Role }>(`SELECT id, role FROM app_user WHERE id = ?`, userId);
    if (!target) throw new Error('User tidak ditemukan.');

    if (target.role === 'ADMIN' && !aktif) {
      const jumlahAdminAktif = await db.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM app_user WHERE role = 'ADMIN' AND aktif = 1`
      );
      if ((jumlahAdminAktif?.cnt ?? 0) <= 1) {
        throw new Error('Tidak bisa menonaktifkan Admin terakhir — minimal harus ada satu Admin aktif.');
      }
    }

    await db.runAsync(`UPDATE app_user SET aktif = ?, updated_at = ? WHERE id = ?`, aktif ? 1 : 0, new Date().toISOString(), userId);
    await writeAuditLog(db, actingUserId, aktif ? 'ACTIVATE' : 'DEACTIVATE', userId);
  });
}

/**
 * RC-S117 — Admin mereset PASSWORD user lain (mis. lupa password).
 *
 * Menggantikan `resetUserPin` yang lama. PIN sengaja TIDAK ikut
 * direset: ia kunci layar milik pemiliknya sendiri di perangkatnya
 * sendiri, dan admin tidak punya urusan menetapkannya. Kalau PIN-nya
 * yang lupa, pemiliknya menetapkan ulang lewat Pengaturan > Keamanan
 * setelah masuk dengan password barunya.
 */
export async function resetUserPassword(
  actingUserId: string,
  userId: string,
  newPassword: string,
  opsi: { wajibGanti?: boolean } = {}
): Promise<void> {
  await pastikanAdmin(actingUserId);

  return withTransaction(async (db) => {
    const target = await db.getFirstAsync<{ id: string; username: string }>(
      `SELECT id, username FROM app_user WHERE id = ?`,
      userId
    );
    if (!target) throw new Error('User tidak ditemukan.');

    pastikanPasswordSah(newPassword, target.username);

    const salt = generateSalt();
    const passwordHash = await hashPin(rapikanPassword(newPassword), salt);
    await db.runAsync(
      `UPDATE app_user SET password_hash = ?, password_salt = ?, password_hash_versi = ?, updated_at = ? WHERE id = ?`,
      passwordHash,
      salt,
      VERSI_HASH_PIN_SEKARANG,
      new Date().toISOString(),
      userId
    );
    // RC-S133.5 — password yang ditetapkan admin boleh diwajibkan diganti
    // pemiliknya saat masuk berikutnya (opsional; bawaan tidak berubah).
    if (opsi.wajibGanti !== undefined) await aturWajibGantiPassword(db, userId, opsi.wajibGanti);
    await writeAuditLog(db, actingUserId, 'RESET_PIN', userId, { jenis: 'PASSWORD', ...(opsi.wajibGanti ? { wajibGanti: true } : {}) });
  });
}

export interface UpdateUserInput {
  nama: string;
  username: string;
  role: Role;
  /** RC-S132 — WAJIB bila role ANGGOTA; tautan dihapus bila role diganti ke selain ANGGOTA. */
  anggotaId?: string | null;
}

/**
 * RC-S117 — Admin menyunting identitas user (nama, username, role).
 *
 * Sebelumnya hanya role yang bisa diubah, lewat dialog tersendiri;
 * salah ketik nama atau username berarti user harus dinonaktifkan dan
 * dibuat ulang — yang memutus jejak audit atas namanya.
 *
 * Password TIDAK ikut di sini: mengubahnya adalah tindakan berbeda
 * dengan akibat berbeda (pemiliknya langsung tidak bisa masuk dengan
 * yang lama), jadi ia punya jalurnya sendiri lewat `resetUserPassword`.
 */
export async function updateUser(
  actingUserId: string,
  userId: string,
  input: UpdateUserInput
): Promise<void> {
  await pastikanAdmin(actingUserId);
  if (!ROLES.includes(input.role)) {
    throw new Error(`Role "${input.role}" tidak dikenal.`);
  }
  const username = rapikanUsername(input.username);
  if (input.role !== 'ANGGOTA' && input.nama.trim().length === 0) throw new Error('Nama wajib diisi.');
  if (username.length === 0) throw new Error('Username wajib diisi.');
  pastikanUsernameSah(username);

  return withTransaction(async (db) => {
    const target = await db.getFirstAsync<{ id: string; role: Role }>(
      `SELECT id, role FROM app_user WHERE id = ?`,
      userId
    );
    if (!target) throw new Error('User tidak ditemukan.');

    const bentrok = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM app_user WHERE username = ? AND id <> ?`,
      username,
      userId
    );
    if (bentrok) throw new Error(`Username "${username}" sudah dipakai.`);

    // Penjaga yang SAMA dengan `updateUserRole`: koperasi tidak boleh
    // kehilangan admin terakhirnya, karena tidak ada jalan masuk lain
    // untuk mengangkat admin baru.
    if (target.role === 'ADMIN' && input.role !== 'ADMIN') {
      await pastikanBukanAdminTerakhir(db, userId);
    }

    const tautan = await tentukanTautanAnggota(db, input.role, input.anggotaId, userId);
    const nama = (tautan.nama ?? input.nama).trim();

    await db.runAsync(
      `UPDATE app_user SET nama = ?, username = ?, role = ?, anggota_id = ?, updated_at = ? WHERE id = ?`,
      nama,
      username,
      input.role,
      tautan.anggotaId,
      new Date().toISOString(),
      userId
    );
    await writeAuditLog(db, actingUserId, 'UPDATE', userId, {
      nama,
      username,
      role: input.role,
      ...(tautan.anggotaId ? { anggotaId: tautan.anggotaId } : {}),
    });
  });
}

async function writeAuditLog(
  db: SQLite.SQLiteDatabase,
  userId: string,
  action: string,
  entityId: string,
  dataSesudah?: unknown
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
    'app_user',
    entityId,
    dataSesudah ? JSON.stringify(dataSesudah) : null,
    now.toISOString()
  );
}

// =====================================================================
// RC-S133.5 — HAPUS USER, WAJIB GANTI PASSWORD, AKUN ANGGOTA MASSAL
// =====================================================================

/**
 * Username akun yang sudah dihapus. Tanda `~` TIDAK diizinkan kebijakan
 * username, jadi tidak mungkin bertabrakan dengan username sungguhan dan
 * tidak mungkin diketik di layar Login.
 */
export const PREFIX_USERNAME_DIHAPUS = '~dihapus~';

/** Kunci app_config penanda "wajib ganti password" (ikut data koperasi, bukan perangkat). */
export const PREFIX_KUNCI_WAJIB_GANTI = 'akun.wajibGantiPassword.';

async function daftarWajibGantiPassword(db: SQLite.SQLiteDatabase): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ key: string }>(
    `SELECT key FROM app_config WHERE key LIKE ? AND value = '1'`,
    `${PREFIX_KUNCI_WAJIB_GANTI}%`
  );
  return new Set(rows.map((r) => r.key.slice(PREFIX_KUNCI_WAJIB_GANTI.length)));
}

async function aturWajibGantiPassword(db: SQLite.SQLiteDatabase, userId: string, wajib: boolean): Promise<void> {
  const key = PREFIX_KUNCI_WAJIB_GANTI + userId;
  if (wajib) {
    await db.runAsync(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
      key,
      new Date().toISOString()
    );
  } else {
    await db.runAsync(`DELETE FROM app_config WHERE key = ?`, key);
  }
}

/** Apakah user ini harus mengganti password sebelum memakai aplikasi. */
export async function apakahWajibGantiPassword(userId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM app_config WHERE key = ?`,
    PREFIX_KUNCI_WAJIB_GANTI + userId
  );
  return row?.value === '1';
}

/**
 * Pemilik akun mengganti password-nya SENDIRI (dipakai layar "Ganti
 * Password" — termasuk yang wajib saat masuk pertama). Password lama
 * diverifikasi; tidak butuh Admin.
 */
export async function gantiPasswordSendiri(
  userId: string,
  passwordLama: string,
  passwordBaru: string
): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM app_user WHERE id = ? AND aktif = 1`, userId);
  if (!row) throw new Error('User tidak ditemukan atau nonaktif.');
  const cocok = row.password_hash && row.password_salt
    ? (await verifikasiPinAsync({
        pin: passwordLama,
        salt: row.password_salt,
        hashTersimpan: row.password_hash,
        versiTersimpan: (Number(row.password_hash_versi) === 2 ? 2 : 1) as 1 | 2,
      })).cocok
    : false;
  if (!cocok) throw new Error('Password lama salah.');
  pastikanPasswordSah(passwordBaru, row.username);
  if (rapikanPassword(passwordBaru) === rapikanPassword(passwordLama)) {
    throw new Error('Password baru harus berbeda dari password lama.');
  }
  const salt = generateSalt();
  const hash = await hashPinV2Async(rapikanPassword(passwordBaru), salt);
  await withTransaction(async (tx) => {
    await tx.runAsync(
      `UPDATE app_user SET password_hash = ?, password_salt = ?, password_hash_versi = ?, updated_at = ? WHERE id = ?`,
      hash,
      salt,
      VERSI_HASH_PIN_SEKARANG,
      new Date().toISOString(),
      userId
    );
    await aturWajibGantiPassword(tx, userId, false);
    await writeAuditLog(tx, userId, 'GANTI_PASSWORD', userId);
  });
}

/**
 * Admin MENGHAPUS user.
 *
 * Kolom `created_by`/`*_oleh` di ±60 tabel menyimpan id user tanpa FK;
 * riwayat transaksi menampilkan nama pembuatnya lewat LEFT JOIN. Karena
 * itu baris akun TIDAK dibuang: ia diubah menjadi nisan —
 *  - tidak aktif, kredensial (password & PIN) diganti nilai yang tidak
 *    dapat dipakai siapa pun → tidak bisa masuk lagi dari perangkat mana pun;
 *  - username diganti `~dihapus~<id>` → username lama bebas dipakai lagi;
 *  - tautan anggota dilepas → anggota itu bisa dibuatkan akun baru;
 *  - nama dipertahankan → riwayat tetap menampilkan "dibuat oleh <nama>";
 *  - hilang dari daftar User Management.
 * Penjaga: tidak bisa menghapus diri sendiri dan Admin aktif terakhir.
 */
export async function hapusUser(actingUserId: string, userId: string): Promise<void> {
  await pastikanAdmin(actingUserId);
  if (actingUserId === userId) throw new Error('Akun yang sedang dipakai tidak dapat dihapus.');
  return withTransaction(async (db) => {
    const target = await db.getFirstAsync<{ id: string; role: Role; aktif: number; username: string; nama: string; anggota_id: string | null }>(
      `SELECT id, role, aktif, username, nama, anggota_id FROM app_user WHERE id = ?`,
      userId
    );
    if (!target || target.username.startsWith(PREFIX_USERNAME_DIHAPUS)) throw new Error('User tidak ditemukan.');
    if (target.role === 'ADMIN' && target.aktif) {
      const n = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM app_user WHERE role = 'ADMIN' AND aktif = 1`);
      if ((n?.cnt ?? 0) <= 1) throw new Error('Tidak bisa menghapus Admin terakhir — minimal harus ada satu Admin aktif.');
    }
    const nisan = `${PREFIX_USERNAME_DIHAPUS}${userId}`;
    await db.runAsync(
      `UPDATE app_user
          SET aktif = 0, username = ?, anggota_id = NULL, biometric_enabled = 0,
              password_hash = ?, password_salt = ?, pin_hash = ?, pin_salt = ?, updated_at = ?
        WHERE id = ?`,
      nisan,
      `dihapus:${generateSalt()}`,
      generateSalt(),
      `dihapus:${generateSalt()}`,
      generateSalt(),
      new Date().toISOString(),
      userId
    );
    await aturWajibGantiPassword(db, userId, false);
    await writeAuditLog(db, actingUserId, 'DELETE', userId, {
      nama: target.nama,
      username: target.username,
      role: target.role,
      ...(target.anggota_id ? { anggotaId: target.anggota_id } : {}),
    });
  });
}

// ------------------------------------------------------------- massal

export type ModeUsernameMassal = 'NOMOR_ANGGOTA' | 'ACAK';
export type ModePasswordMassal = 'ACAK' | 'SAMA';

export interface OpsiAkunMassal {
  modeUsername: ModeUsernameMassal;
  modePassword: ModePasswordMassal;
  /** Wajib bila modePassword = 'SAMA'. */
  passwordSama?: string;
  /** Bawaan true: anggota wajib mengganti password saat masuk pertama. */
  wajibGanti?: boolean;
}

export interface CalonAkunAnggota {
  anggotaId: string;
  nomorAnggota: string;
  nama: string;
}

export interface AkunAnggotaDibuat extends CalonAkunAnggota {
  userId: string;
  username: string;
  /** Password teks — HANYA ada di memori hasil fungsi ini; tidak pernah disimpan. */
  password: string;
}

/** Huruf/angka yang tidak mudah tertukar saat dibaca dari kertas (tanpa 0/O, 1/l/I). */
const HURUF_AMAN = 'abcdefghjkmnpqrstuvwxyz';
const ANGKA_AMAN = '23456789';

function acak(alfabet: string, n: number): string {
  // Penolakan bias: hanya byte < kelipatan terbesar panjang alfabet yang dipakai.
  const batas = 256 - (256 % alfabet.length);
  let out = '';
  while (out.length < n) {
    for (const b of Crypto.getRandomBytes(n * 2)) {
      if (b < batas) out += alfabet[b % alfabet.length];
      if (out.length === n) break;
    }
  }
  return out;
}

/** Password acak 10 karakter: huruf kecil + angka, selalu memuat keduanya. */
export function buatPasswordAcak(): string {
  for (;;) {
    const p = acak(HURUF_AMAN + ANGKA_AMAN, 10);
    if (/[a-z]/.test(p) && /[0-9]/.test(p)) return p;
  }
}

/** Username dari nomor anggota: huruf kecil, hanya karakter yang diizinkan, minimal 3. */
export function usernameDariNomor(nomor: string): string {
  let u = (nomor ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (u.length < 3) u = `agt${u}`;
  return u.slice(0, 32);
}

/** Anggota aktif (bukan keluar/meninggal) yang BELUM punya akun. */
export async function daftarCalonAkunAnggota(actingUserId: string): Promise<CalonAkunAnggota[]> {
  await pastikanAdmin(actingUserId);
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; nomor_anggota: string; nama_lengkap: string }>(
    `SELECT a.id, a.nomor_anggota, a.nama_lengkap FROM anggota a
      WHERE a.status NOT IN ('KELUAR','MENINGGAL')
        AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.anggota_id = a.id)
      ORDER BY a.nomor_anggota ASC`
  );
  return rows.map((r) => ({ anggotaId: r.id, nomorAnggota: r.nomor_anggota, nama: r.nama_lengkap }));
}

/**
 * Admin membuat akun ber-role ANGGOTA untuk SEMUA anggota aktif yang belum
 * punya akun (atau hanya `anggotaIds` bila diberikan), sekaligus.
 *
 *  - Username: nomor anggota (mis. "a001") atau acak ("agt-x7k2mp");
 *    bentrok dengan username yang ada → diberi akhiran "-2", "-3", ….
 *  - Password: acak per anggota, atau satu password yang sama untuk semua
 *    (tetap diperiksa kebijakan password terhadap setiap username).
 *  - Hash dihitung lebih dulu (scrypt asinkron, `onProgres`), lalu SEMUA akun
 *    ditulis dalam SATU transaksi: gagal satu → tidak ada yang tersimpan.
 *  - PIN diisi penanda yang tidak dapat dipakai (bukan hash), karena PIN
 *    ditetapkan sendiri oleh pemiliknya — menghemat satu scrypt per akun.
 *  - Password teks hanya dikembalikan kepada pemanggil (untuk dicetak /
 *    dibagikan), tidak pernah disimpan.
 */
export async function buatAkunAnggotaMassal(
  actingUserId: string,
  opsi: OpsiAkunMassal,
  anggotaIds?: string[],
  onProgres?: (selesai: number, total: number) => void
): Promise<AkunAnggotaDibuat[]> {
  await pastikanAdmin(actingUserId);
  if (opsi.modePassword === 'SAMA') {
    const sama = rapikanPassword(opsi.passwordSama ?? '');
    pastikanPasswordSah(sama);
  }
  let calon = await daftarCalonAkunAnggota(actingUserId);
  if (anggotaIds) {
    const pilih = new Set(anggotaIds);
    calon = calon.filter((c) => pilih.has(c.anggotaId));
  }
  if (calon.length === 0) throw new Error('Semua anggota aktif sudah memiliki akun.');

  const db = await getDb();
  const terpakai = new Set(
    (await db.getAllAsync<{ username: string }>(`SELECT username FROM app_user`)).map((r) => r.username.toLowerCase())
  );
  const rencana: (AkunAnggotaDibuat & { salt: string; hash?: string })[] = [];
  for (const c of calon) {
    let dasar = opsi.modeUsername === 'NOMOR_ANGGOTA' ? usernameDariNomor(c.nomorAnggota) : `agt-${acak(HURUF_AMAN + ANGKA_AMAN, 6)}`;
    let username = dasar;
    for (let k = 2; terpakai.has(username.toLowerCase()); k++) {
      username = opsi.modeUsername === 'ACAK' ? `agt-${acak(HURUF_AMAN + ANGKA_AMAN, 6)}` : `${dasar.slice(0, 28)}-${k}`;
    }
    terpakai.add(username.toLowerCase());
    pastikanUsernameSah(username);
    const password = opsi.modePassword === 'SAMA' ? rapikanPassword(opsi.passwordSama ?? '') : buatPasswordAcak();
    const cek = periksaPassword({ password, username });
    if (!cek.sah) {
      throw new Error(`Password tidak dapat dipakai untuk username "${username}" (${c.nama}): ${cek.pesan ?? ''}`.trim());
    }
    rencana.push({ ...c, userId: newId(), username, password, salt: generateSalt() });
  }

  for (let i = 0; i < rencana.length; i++) {
    rencana[i].hash = await hashPinV2Async(rencana[i].password, rencana[i].salt);
    onProgres?.(i + 1, rencana.length);
  }

  const wajibGanti = opsi.wajibGanti !== false;
  await withTransaction(async (tx) => {
    const now = new Date().toISOString();
    for (const r of rencana) {
      // Diperiksa ulang di dalam transaksi: anggota bisa saja dibuatkan akun
      // dari perangkat/layar lain selama hash dihitung.
      const tautan = await tentukanTautanAnggota(tx, 'ANGGOTA', r.anggotaId, null);
      const bentrok = await tx.getFirstAsync<{ id: string }>(`SELECT id FROM app_user WHERE username = ?`, r.username);
      if (bentrok) throw new Error(`Username "${r.username}" sudah dipakai. Ulangi pembuatan akun.`);
      await tx.runAsync(
        `INSERT INTO app_user
          (id, nama, username, role, pin_hash, pin_salt, pin_hash_versi,
           password_hash, password_salt, password_hash_versi, biometric_enabled, aktif, created_at, updated_at, anggota_id)
         VALUES (?,?,?,'ANGGOTA',?,?,?,?,?,?,0,1,?,?,?)`,
        r.userId,
        tautan.nama ?? r.nama,
        r.username,
        `nopin:${generateSalt()}`,
        generateSalt(),
        VERSI_HASH_PIN_SEKARANG,
        r.hash,
        r.salt,
        VERSI_HASH_PIN_SEKARANG,
        now,
        now,
        tautan.anggotaId
      );
      if (wajibGanti) await aturWajibGantiPassword(tx, r.userId, true);
      await writeAuditLog(tx, actingUserId, 'CREATE', r.userId, {
        nama: tautan.nama ?? r.nama,
        username: r.username,
        role: 'ANGGOTA',
        anggotaId: r.anggotaId,
        massal: true,
        modeUsername: opsi.modeUsername,
        modePassword: opsi.modePassword,
      });
    }
  });
  return rencana.map(({ salt: _s, hash: _h, ...r }) => r);
}

/**
 * RC-S117 — menetapkan PIN KUNCI APLIKASI milik diri sendiri.
 *
 * Menggantikan pemakaian `resetUserPin` oleh layar Keamanan. Dua hal
 * yang berubah dan keduanya disengaja:
 *
 *  1. TIDAK menuntut ADMIN. PIN adalah kunci layar milik pemiliknya di
 *     perangkatnya sendiri. Aturan lama menuntut admin, sehingga
 *     Bendahara atau Petugas sebenarnya TIDAK BISA menyalakan kunci
 *     aplikasinya sendiri — kebalikan dari maksud fitur itu.
 *  2. HANYA untuk diri sendiri. Tanpa batas ini, fungsi tanpa penjaga
 *     admin menjadi jalan bagi siapa pun untuk mengganti kunci layar
 *     orang lain.
 */
export async function aturPinKunciAplikasi(
  actingUserId: string,
  userId: string,
  newPin: string
): Promise<void> {
  if (actingUserId !== userId) {
    throw new Error('PIN kunci aplikasi hanya dapat ditetapkan oleh pemiliknya sendiri.');
  }
  if (!/^\d{6}$/.test(newPin)) {
    throw new Error('PIN harus 6 digit angka.');
  }

  return withTransaction(async (db) => {
    const target = await db.getFirstAsync<{ id: string }>(`SELECT id FROM app_user WHERE id = ?`, userId);
    if (!target) throw new Error('User tidak ditemukan.');

    const salt = generateSalt();
    const pinHash = await hashPin(newPin, salt);
    await db.runAsync(
      `UPDATE app_user SET pin_hash = ?, pin_salt = ?, pin_hash_versi = ?, updated_at = ? WHERE id = ?`,
      pinHash,
      salt,
      VERSI_HASH_PIN_SEKARANG,
      new Date().toISOString(),
      userId
    );
    await writeAuditLog(db, actingUserId, 'RESET_PIN', userId, { jenis: 'PIN_KUNCI_APLIKASI' });
  });
}
