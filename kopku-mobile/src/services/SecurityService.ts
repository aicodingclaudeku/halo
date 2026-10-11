import * as SQLite from 'expo-sqlite';
import { getDb } from '@/database/db';

/**
 * ============================================================
 * KEAMANAN APLIKASI — SATU SUMBER KEBENARAN UNTUK STATUS PIN (§14-§18)
 * ============================================================
 *
 * HASIL AUDIT DEPENDENSI PIN (§15) — dikerjakan SEBELUM PIN dibuat
 * opsional, karena mematikan PIN yang ternyata menjadi akar kunci
 * enkripsi akan membuat database polos tanpa disadari.
 *
 * Peta dependensi PIN pada source ini:
 *
 *   PIN (6 digit)
 *     -> security/pin.ts: hashPin() = SHA256("<salt>:<pin>")
 *     -> disimpan sebagai app_user.pin_hash + app_user.pin_salt (SQLite)
 *     -> DIPAKAI HANYA OLEH:
 *          AuthService.login()         (autentikasi username+PIN)
 *          AuthService.unlockWithPin() (buka auto-lock sesi)
 *
 * Yang TIDAK bergantung pada PIN (diverifikasi satu per satu):
 *   - Enkripsi database  : TIDAK ADA. `SQLite.openDatabaseAsync(DATABASE_NAME)`
 *                          di db.ts membuka file apa adanya — tidak ada
 *                          SQLCipher, tidak ada parameter key/passphrase.
 *   - Derivasi kunci     : TIDAK ADA. hashPin() hanya menghasilkan hash
 *                          verifikasi, hasilnya tidak pernah dipakai
 *                          sebagai kunci enkripsi apa pun.
 *   - SecureStore        : hanya menyimpan `koperasi.session.userId` dan
 *                          `koperasi.session.lastActiveAt` (timestamp).
 *                          Keduanya TIDAK diturunkan dari PIN.
 *   - Enkripsi backup    : TIDAK ADA. BackupService menyalin file
 *                          database apa adanya; kolom pin_hash di
 *                          dalamnya memang sudah ter-hash sejak awal.
 *
 * KESIMPULAN: PIN pada aplikasi ini MURNI application lock +
 * autentikasi user, BUKAN bagian dari security root enkripsi data.
 * Karena itu PIN AMAN dijadikan opsional (§15: "Jika PIN hanya app
 * lock: PIN boleh dibuat optional"). Tidak ada database yang menjadi
 * tidak terenkripsi akibat PIN dimatikan — karena memang tidak pernah
 * ada enkripsi berbasis PIN yang hilang.
 *
 * KOMPATIBILITAS PEMASANGAN LAMA (§18):
 * Status disimpan di `app_config` (tabel key-value yang SUDAH ADA sejak
 * skema awal, dipakai AccountingPolicyService & PenyusutanService) —
 * TIDAK ada tabel/kolom baru, TIDAK ada kenaikan SCHEMA_VERSION, jadi
 * tidak ada migrasi yang bisa merusak data.
 *
 * Aturan default saat key BELUM ADA sama sekali:
 *   - Instalasi LAMA (koperasi.setup_selesai = 1, dibuat sebelum fitur
 *     ini ada) -> ENABLED. Pemasangan yang selama ini selalu meminta PIN
 *     TETAP meminta PIN. PIN existing TIDAK PERNAH dimatikan otomatis.
 *   - Belum ada koperasi sama sekali (fresh install) -> DISABLED, dan
 *     `setupKoperasi()` menuliskan nilainya secara EKSPLISIT saat setup
 *     selesai, sehingga sesudah itu key selalu ada dan tidak pernah
 *     bergantung pada tebakan.
 */

export const PIN_ENABLED_CONFIG_KEY = 'security.pin_enabled';

/**
 * State terpusat (§17). Semua layar autentikasi WAJIB membaca status
 * dari sini — jangan menyebar `if (pinEnabled)` boolean ad-hoc ke
 * banyak screen.
 */
export type PinState =
  /** PIN mati — aplikasi tidak pernah meminta PIN, tidak ada lock screen. */
  | 'PIN_DISABLED'
  /** PIN dinyalakan tetapi user belum pernah menetapkan PIN sungguhan. */
  | 'PIN_ENABLED_SETUP_REQUIRED'
  /** PIN aktif & sudah ditetapkan — login/unlock berlaku seperti biasa. */
  | 'PIN_ENABLED'
  /** PIN aktif dan sesi sedang terkunci (auto-lock). */
  | 'PIN_LOCKED';

async function bacaConfig(db: SQLite.SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key = ?`, key);
  return row?.value ?? null;
}

async function tulisConfig(db: SQLite.SQLiteDatabase, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now
  );
}

/**
 * Apakah PIN/app-lock aktif? SATU-SATUNYA pembacaan status PIN yang sah
 * di seluruh aplikasi (§17: "Semua screen authentication harus membaca
 * state dari satu sumber").
 *
 * Versi ber-parameter `db` supaya bisa dipakai di dalam transaksi
 * setup/test tanpa membuka koneksi kedua.
 */
export async function isPinEnabledPadaDb(db: SQLite.SQLiteDatabase): Promise<boolean> {
  const tersimpan = await bacaConfig(db, PIN_ENABLED_CONFIG_KEY);
  if (tersimpan !== null) return tersimpan === '1';

  // Key belum ada — lihat aturan kompatibilitas di komentar kepala file.
  // Instalasi lama (setup sudah selesai sebelum fitur ini ada) TETAP
  // memakai PIN; hanya database yang benar-benar belum pernah di-setup
  // yang dianggap DISABLED.
  const koperasi = await db.getFirstAsync<{ setup_selesai: number }>(
    `SELECT setup_selesai FROM koperasi ORDER BY created_at DESC LIMIT 1`
  );
  return !!koperasi && koperasi.setup_selesai === 1;
}

export async function isPinEnabled(): Promise<boolean> {
  return isPinEnabledPadaDb(await getDb());
}

/**
 * Menyalakan/mematikan app-lock PIN.
 *
 * PENTING (§16): mematikan PIN TIDAK PERNAH menghapus `pin_hash`/
 * `pin_salt` milik user. Kolom itu NOT NULL di skema dan merupakan
 * kredensial autentikasi — menghapusnya berarti merusak akun. Yang
 * berubah hanyalah apakah aplikasi MEMINTA PIN saat masuk. Menyalakan
 * PIN kembali langsung memakai PIN yang sama seperti sebelumnya, tanpa
 * user harus membuat ulang.
 */
export async function setPinEnabled(aktif: boolean): Promise<void> {
  await tulisConfig(await getDb(), PIN_ENABLED_CONFIG_KEY, aktif ? '1' : '0');
}

export async function setPinEnabledPadaDb(db: SQLite.SQLiteDatabase, aktif: boolean): Promise<void> {
  await tulisConfig(db, PIN_ENABLED_CONFIG_KEY, aktif ? '1' : '0');
}

/**
 * Penanda "user ini belum pernah menetapkan PIN sungguhan".
 *
 * Setup minimal (§8/§11) TIDAK meminta PIN, tetapi `app_user.pin_hash`
 * dan `pin_salt` NOT NULL di skema — jadi baris admin tetap harus punya
 * nilai. Nilai yang dipakai adalah hash dari PIN ACAK yang TIDAK PERNAH
 * ditampilkan ke siapa pun dan TIDAK PERNAH bisa dipakai login (bukan
 * "PIN default" yang bisa ditebak seperti 000000/123456), lalu user
 * ditandai lewat flag di bawah. Saat user menyalakan PIN, ia WAJIB
 * membuat PIN baru dan hash/salt-nya ditimpa dengan PIN pilihannya.
 */
export const PIN_BELUM_DITETAPKAN_CONFIG_KEY = 'security.pin_belum_ditetapkan';

export async function isPinBelumDitetapkanPadaDb(db: SQLite.SQLiteDatabase): Promise<boolean> {
  return (await bacaConfig(db, PIN_BELUM_DITETAPKAN_CONFIG_KEY)) === '1';
}

export async function tandaiPinBelumDitetapkanPadaDb(
  db: SQLite.SQLiteDatabase,
  belum: boolean
): Promise<void> {
  await tulisConfig(db, PIN_BELUM_DITETAPKAN_CONFIG_KEY, belum ? '1' : '0');
}

export async function tandaiPinSudahDitetapkan(): Promise<void> {
  await tandaiPinBelumDitetapkanPadaDb(await getDb(), false);
}

/**
 * Resolusi state terpusat yang dipakai `app/index.tsx` untuk memilih
 * fase aplikasi. `sesiTerkunci` diambil pemanggil dari mekanisme
 * auto-lock yang SUDAH ADA (`getSessionStatus`) — tidak ada logika
 * auto-lock kedua yang dibuat di sini.
 */
export async function resolvePinState(opts: { sesiTerkunci: boolean }): Promise<PinState> {
  const db = await getDb();
  if (!(await isPinEnabledPadaDb(db))) return 'PIN_DISABLED';
  if (await isPinBelumDitetapkanPadaDb(db)) return 'PIN_ENABLED_SETUP_REQUIRED';
  return opts.sesiTerkunci ? 'PIN_LOCKED' : 'PIN_ENABLED';
}
