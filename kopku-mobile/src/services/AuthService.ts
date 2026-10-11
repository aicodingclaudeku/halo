import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { verifikasiPinAsync, hashPin, VERSI_HASH_PIN_SEKARANG } from '@/security/pinHash';
import {
  cocokkanPinCepat,
  hapusPinCepat,
  ikatanKredensialPin,
  jedaSetelahGagalMs,
  simpanPinCepat,
} from '@/security/unlockCepat';
import { getDb } from '@/database/db';
import { newId } from '@/utils/id';
import { Role } from '@/config/defaultPermissions';
import {
  verifyPin,
  setSession,
  getSession,
  clearSession,
  touchSession,
  isSessionLocked,
  AutoLockDuration,
} from '@/security/pin';

/**
 * Menyambungkan security/pin.ts (yang sudah ada sebelumnya tapi belum
 * dipakai di mana pun) ke alur aplikasi nyata: login, auto-lock, unlock
 * dengan PIN/biometric, dan audit log (PRD §31-33). Tidak mengubah
 * pin.ts sama sekali — hanya memakainya.
 */

export interface AuthUser {
  id: string;
  nama: string;
  username: string;
  role: Role;
  biometricEnabled: boolean;
  /** RC-S133.5 — anggota yang ditautkan (hanya akun ber-role ANGGOTA). */
  anggotaId: string | null;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Username atau PIN salah.');
    this.name = 'InvalidCredentialsError';
  }
}

async function writeAuditLog(userId: string, action: string) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.slice(0, 10),
    now.slice(11, 19),
    action,
    'app_user',
    userId,
    now
  );
}

function rowToAuthUser(row: any): AuthUser {
  return {
    id: row.id,
    nama: row.nama,
    username: row.username,
    role: row.role,
    biometricEnabled: !!row.biometric_enabled,
    anggotaId: row.anggota_id ?? null,
  };
}


/**
 * RC-S114 — verifikasi PIN yang sadar versi, plus kenaikan diam-diam.
 *
 * Hash lama (v1 = SHA-256 satu putaran) TETAP dapat diverifikasi:
 * menolaknya akan mengunci pengurus di luar aplikasinya sendiri.
 * Begitu terbukti cocok, PIN-nya memang sedang ada di tangan — itulah
 * satu-satunya saat hash dapat dihitung ulang tanpa meminta apa pun
 * kepada pengguna, jadi di situlah kenaikan ke v2 dilakukan.
 *
 * Kegagalan menyimpan hash baru SENGAJA tidak dilempar: login yang
 * PIN-nya benar tidak boleh gagal hanya karena upaya peningkatan
 * keamanan latar belakang tidak berhasil. Ia akan dicoba lagi pada
 * login berikutnya.
 */
async function verifikasiDanNaikkan(
  db: Awaited<ReturnType<typeof getDb>>,
  row: any,
  rahasia: string,
  kolom: 'pin' | 'password'
): Promise<boolean> {
  // RC-S117 — satu fungsi untuk DUA kredensial yang kini terpisah:
  // `password` (kredensial masuk) dan `pin` (kunci layar aplikasi).
  // Digabung begini supaya keduanya tidak mungkin berbeda dalam hal
  // yang menentukan — perbandingan waktu tetap dan kenaikan versi hash
  // — sementara kolom yang dibaca tetap tegas berbeda.
  const kolomHash = kolom === 'pin' ? 'pin_hash' : 'password_hash';
  const kolomSalt = kolom === 'pin' ? 'pin_salt' : 'password_salt';
  const kolomVersi = kolom === 'pin' ? 'pin_hash_versi' : 'password_hash_versi';

  const hashTersimpan = row[kolomHash];
  const salt = row[kolomSalt];
  if (!hashTersimpan || !salt) return false;

  const versiTersimpan = (Number(row[kolomVersi]) === 2 ? 2 : 1) as 1 | 2;
  // RC-S130 — varian asinkron (hasil identik): scrypt memberi giliran ke
  // event loop sehingga layar tidak membeku selama perhitungan.
  const hasil = await verifikasiPinAsync({
    pin: rahasia,
    salt,
    hashTersimpan,
    versiTersimpan,
  });
  if (!hasil.cocok) return false;

  if (hasil.perluDinaikkan) {
    try {
      await db.runAsync(
        `UPDATE app_user SET ${kolomHash} = ?, ${kolomVersi} = ?, updated_at = ? WHERE id = ?`,
        hashPin(rahasia, salt, VERSI_HASH_PIN_SEKARANG),
        VERSI_HASH_PIN_SEKARANG,
        new Date().toISOString(),
        row.id
      );
    } catch {
      // Lihat komentar di atas — tidak dilempar dengan sengaja.
    }
  }
  return true;
}

/**
 * RC-S117 — Login dengan username + PASSWORD.
 *
 * Sebelumnya PIN 6 digit merangkap kredensial masuk. Untuk membuka
 * kunci aplikasi di perangkat yang sudah dipegang orangnya, 6 digit
 * memadai; untuk memisahkan seorang petugas dari wewenang Admin atas
 * seluruh buku besar, tidak — ruang tebakannya hanya sejuta.
 *
 * PIN tetap ada, tetapi hanya untuk `unlockWithPin()` di bawah.
 */
export async function login(username: string, password: string): Promise<AuthUser> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT * FROM app_user WHERE username = ? AND aktif = 1`,
    username
  );
  if (!row) throw new InvalidCredentialsError();

  const valid = await verifikasiDanNaikkan(db, row, password, 'password');
  if (!valid) throw new InvalidCredentialsError();

  await setSession(row.id);
  await writeAuditLog(row.id, 'LOGIN');
  // RC-S132 — login berhasil mengakhiri status "keluar manual" dan
  // mengingat username (bukan password) untuk mengisi layar login berikutnya.
  await SecureStore.deleteItemAsync(KUNCI_KELUAR_MANUAL).catch(() => undefined);
  await SecureStore.setItemAsync(KUNCI_USERNAME_TERAKHIR, row.username).catch(() => undefined);
  return rowToAuthUser(row);
}

/**
 * RC-S132 — PENANDA "KELUAR MANUAL".
 *
 * Saat PIN nonaktif, aplikasi membuka sesi otomatis dengan Admin
 * (`mulaiSesiTanpaPin`, §14/§17) supaya koperasi satu-pengguna tidak
 * perlu login. Tanpa penanda ini, tombol Keluar tidak berarti apa-apa:
 * begitu sesi dihapus, pembukaan berikutnya langsung masuk lagi sebagai
 * Admin — dan pengguna lain tidak pernah sempat login dengan akunnya.
 *
 * Keluar dari Pengaturan / layar kunci menyalakan penanda; app/index.tsx
 * lalu menampilkan layar LOGIN (juga setelah aplikasi ditutup-buka) sampai
 * ada login yang berhasil. Koperasi yang tidak pernah menekan Keluar
 * tetap berperilaku seperti sebelumnya.
 */
export const KUNCI_KELUAR_MANUAL = 'koperasi.session.keluarManual';
export const KUNCI_USERNAME_TERAKHIR = 'koperasi.login.usernameTerakhir';

export async function apakahKeluarManual(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(KUNCI_KELUAR_MANUAL)) === '1';
  } catch {
    // Fail-closed: tidak bisa membaca -> perlakukan sebagai sudah keluar (minta login).
    return true;
  }
}

export async function getUsernameTerakhir(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KUNCI_USERNAME_TERAKHIR);
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  const userId = await getSession();
  await clearSession();
  await hapusPinCepat();
  await SecureStore.setItemAsync(KUNCI_KELUAR_MANUAL, '1').catch(() => undefined);
  if (userId) await writeAuditLog(userId, 'LOGOUT');
}

/** Cek apakah ada sesi aktif dan apakah sudah harus terkunci (auto-lock). */
export async function getSessionStatus(
  autoLockMinutes: AutoLockDuration
): Promise<{ userId: string | null; locked: boolean }> {
  const userId = await getSession();
  if (!userId) return { userId: null, locked: true };
  const locked = await isSessionLocked(autoLockMinutes);
  return { userId, locked };
}

export async function getUserById(userId: string): Promise<AuthUser | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM app_user WHERE id = ?`, userId);
  return row ? rowToAuthUser(row) : null;
}

/**
 * §14/§17 — sesi TANPA PIN.
 *
 * Dipakai HANYA ketika app-lock PIN NONAKTIF (lihat
 * SecurityService.isPinEnabled()). Karena tidak ada PIN yang diminta,
 * aplikasi masuk memakai user ADMIN aktif yang sudah dibuat saat setup —
 * user yang SAMA yang selama ini dipakai sebagai `created_by` pada
 * seluruh audit trail, jadi tidak ada identitas baru yang dikarang.
 *
 * Fungsi ini TIDAK memverifikasi PIN apa pun dan TIDAK boleh dipanggil
 * saat PIN aktif — pemanggil (app/index.tsx) memutuskan lewat
 * `resolvePinState()`, bukan lewat pengecekan boolean sendiri.
 */
export async function mulaiSesiTanpaPin(): Promise<AuthUser | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT * FROM app_user WHERE aktif = 1 ORDER BY CASE WHEN role = 'ADMIN' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`
  );
  if (!row) return null;
  await setSession(row.id);
  return rowToAuthUser(row);
}

/** Buka kunci sesi yang sedang locked dengan PIN (PRD §32 auto lock). */
export async function unlockWithPin(pin: string): Promise<AuthUser> {
  const userId = await getSession();
  if (!userId) throw new Error('Tidak ada sesi aktif. Silakan login ulang.');

  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM app_user WHERE id = ?`, userId);
  if (!row) throw new Error('User tidak ditemukan.');

  // RC-S130 — jalur cepat (lihat security/unlockCepat.ts). Fail-closed:
  // apa pun selain COCOK/TIDAK_COCOK yang sah jatuh ke scrypt penuh.
  const ikatan = ikatanKredensialPin(row);
  const cepat = await cocokkanPinCepat(row.id, ikatan, pin);
  if (cepat === 'COCOK') {
    gagalBeruntunPin = 0;
    await touchSession();
    return rowToAuthUser(row);
  }
  if (cepat === 'TIDAK_COCOK') {
    gagalBeruntunPin += 1;
    await jeda(jedaSetelahGagalMs(gagalBeruntunPin));
    throw new InvalidCredentialsError();
  }

  // Kunci layar — tetap PIN, dan memang hanya untuk ini.
  const valid = await verifikasiDanNaikkan(db, row, pin, 'pin');
  if (!valid) {
    gagalBeruntunPin += 1;
    throw new InvalidCredentialsError();
  }
  gagalBeruntunPin = 0;

  // PIN terbukti benar lewat scrypt -> siapkan jalur cepat untuk pembukaan
  // berikutnya. Baris dibaca ulang: hash bisa saja baru dinaikkan v1 -> v2.
  try {
    const terbaru = await db.getFirstAsync<any>(
      `SELECT id, pin_hash, pin_salt, pin_hash_versi FROM app_user WHERE id = ?`,
      row.id
    );
    if (terbaru) await simpanPinCepat(row.id, ikatanKredensialPin(terbaru), pin);
  } catch {
    // Best-effort — tidak memengaruhi pembukaan kunci.
  }

  await touchSession();
  return rowToAuthUser(row);
}

/**
 * RC-S131 — VERIFIKASI IDENTITAS SEBELUM MENGGANTI PIN.
 *
 * Diterima SALAH SATU: PIN saat ini, ATAU password login. Password
 * diterima karena (a) setiap pengguna mengetahuinya — termasuk pengguna
 * baru buatan Admin yang PIN awalnya acak dan memang tidak dapat dipakai
 * (UserManagementService), sehingga tanpa ini mereka tidak pernah bisa
 * membuat PIN sendiri; dan (b) password adalah kredensial yang lebih
 * kuat daripada PIN.
 *
 * Teks 6 digit dicoba sebagai PIN dulu (jalur cepat bila tersedia, lalu
 * scrypt), baru kemudian sebagai password. Gagal -> jeda singkat yang sama
 * dengan PIN salah, supaya tidak menjadi jalur tebak cepat.
 */
export async function verifikasiIdentitasPengguna(userId: string, rahasia: string): Promise<boolean> {
  if (!rahasia) return false;
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM app_user WHERE id = ? AND aktif = 1`, userId);
  if (!row) return false;
  if (/^\d{6}$/.test(rahasia)) {
    const cepat = await cocokkanPinCepat(row.id, ikatanKredensialPin(row), rahasia);
    if (cepat === 'COCOK') return true;
    if (cepat === 'TIDAK_TERSEDIA' && (await verifikasiDanNaikkan(db, row, rahasia, 'pin'))) return true;
  }
  if (await verifikasiDanNaikkan(db, row, rahasia, 'password')) return true;
  gagalBeruntunPin += 1;
  await jeda(jedaSetelahGagalMs(gagalBeruntunPin));
  return false;
}

/**
 * RC-S131 — setelah PIN baru disimpan, siapkan jalur cepat untuk PIN itu
 * supaya pembukaan kunci berikutnya langsung instan (tanpa scrypt sekali
 * lagi). HANYA dipanggil tepat setelah `aturPinKunciAplikasi` berhasil
 * dengan PIN yang sama. Best-effort; tidak pernah melempar.
 */
export async function siapkanPinCepatSetelahDiatur(userId: string, pinBaru: string): Promise<void> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<any>(`SELECT id, pin_hash, pin_salt, pin_hash_versi FROM app_user WHERE id = ?`, userId);
    if (row) await simpanPinCepat(userId, ikatanKredensialPin(row), pinBaru);
  } catch {
    // Diabaikan — pembukaan berikutnya memakai scrypt sekali.
  }
}

/** RC-S130 — hitungan PIN salah berturut-turut (memori proses; reset saat berhasil). */
let gagalBeruntunPin = 0;
const jeda = (ms: number) => new Promise<void>((selesai) => setTimeout(selesai, ms));

/** Hanya untuk test. */
export function _resetGagalPinUntukTest(): void {
  gagalBeruntunPin = 0;
}

/**
 * RC-S130 — informasi tampilan layar kunci: nama pengguna sesi dan apakah
 * tombol biometrik layak ditampilkan (diaktifkan user + perangkat punya
 * sensor + sidik/wajah sudah didaftarkan). Hanya membaca; tidak pernah
 * melempar — gagal berarti layar memakai tampilan umum tanpa biometrik.
 */
export async function getInfoLayarKunci(): Promise<{ nama: string | null; biometrikTersedia: boolean }> {
  try {
    const userId = await getSession();
    if (!userId) return { nama: null, biometrikTersedia: false };
    const db = await getDb();
    const row = await db.getFirstAsync<any>(`SELECT nama, biometric_enabled FROM app_user WHERE id = ?`, userId);
    if (!row) return { nama: null, biometrikTersedia: false };
    let biometrikTersedia = false;
    if (row.biometric_enabled) {
      biometrikTersedia = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
    }
    return { nama: row.nama ?? null, biometrikTersedia };
  } catch {
    return { nama: null, biometrikTersedia: false };
  }
}

/** Buka kunci sesi dengan biometric jika tersedia & diaktifkan (PRD §32). */
export async function unlockWithBiometric(): Promise<AuthUser> {
  const userId = await getSession();
  if (!userId) throw new Error('Tidak ada sesi aktif. Silakan login ulang.');

  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM app_user WHERE id = ?`, userId);
  if (!row) throw new Error('User tidak ditemukan.');
  if (!row.biometric_enabled) throw new Error('Biometric belum diaktifkan untuk user ini.');

  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled = await LocalAuthentication.isEnrolledAsync();
  if (!hasHardware || !isEnrolled) {
    throw new Error('Biometric tidak tersedia di perangkat ini.');
  }

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Buka kunci aplikasi',
  });
  if (!result.success) throw new Error('Verifikasi biometric gagal.');

  await touchSession();
  return rowToAuthUser(row);
}

export async function setBiometricEnabled(userId: string, enabled: boolean): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE app_user SET biometric_enabled = ?, updated_at = ? WHERE id = ?`,
    enabled ? 1 : 0, new Date().toISOString(), userId);
}
