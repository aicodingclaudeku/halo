/**
 * LicenseService — OTAK KEBIJAKAN LISENSI
 * =========================================================================
 *
 * Satu-satunya modul yang boleh memutuskan "boleh masuk aplikasi atau
 * tidak". Layar dan gate hanya MENAMPILKAN hasil keputusan di sini;
 * mereka tidak pernah menyusun keputusannya sendiri dari potongan
 * data. Alasannya sama dengan `requirePermission()` di domain izin:
 * kalau keputusan tersebar, cepat atau lambat ada satu jalur yang
 * memutuskan berbeda — dan jalur itulah yang jadi bypass.
 *
 * URUTAN KEPUTUSAN (§8) — sengaja tidak bisa dipotong:
 *
 *     public key terkonfigurasi
 *       -> token ada di SecureStore
 *       -> tanda tangan Ed25519 sah
 *       -> device_hash cocok perangkat ini
 *       -> belum kedaluwarsa (pakai waktu tahan-rollback)
 *       -> status server terakhir bukan revoked/expired/mismatch
 *       -> verifikasi server terakhir masih dalam grace period
 *     => IZINKAN
 *
 * Gagal di langkah mana pun = TIDAK diizinkan. Tidak ada cabang
 * "kalau offline, ya sudah izinkan saja".
 */

import {
  LICENSE_API_BASE,
  LICENSE_GRACE_PERIOD_MS,
  LICENSE_KEY_PATTERN,
  LICENSE_REQUEST_TIMEOUT_MS,
  LICENSE_VERIFY_INTERVAL_MS,
  LICENSE_VERIFY_URGENT_REMAINING_HOURS,
  isKnownLicenseType,
  type LicenseType,
} from '@/config/license';
import { isLicenseSigningConfigured } from '@/security/publicKeyRegistry';
import { ensureCryptoHealthy } from '@/security/ed25519SelfTest';
import { getDeviceId as resolveDeviceId } from '@/security/deviceId';
import { getDevicePlatform } from '@/security/devicePlatform';
import { getTrustedNow, isClockRollbackDetected, recordServerTime } from '@/security/licenseClock';
import {
  clearDeactivatedMark,
  clearLicenseState,
  markDeactivated,
  persistLicense,
  readDeactivatedAt,
  readStoredLicense,
  recordServerVerification,
  type LicenseServerStatus,
  type StoredLicense,
} from '@/security/licenseStore';
import {
  verifyActivationTokenOffline,
  type ActivationTokenPayload,
  type TokenRejectionReason,
} from '@/security/licenseToken';

// ---------------------------------------------------------------------------
// Tipe publik
// ---------------------------------------------------------------------------

/**
 * Keadaan lisensi yang dilihat sisa aplikasi. Sengaja enum bermakna,
 * BUKAN boolean (§17): satu `isLicensed: boolean` adalah tepat satu
 * instruksi yang perlu dibalik oleh siapa pun yang mem-patch bundle.
 */
export type LicenseGateState =
  /**
   * Primitif Ed25519 tidak berfungsi benar di mesin JavaScript ini.
   * Dipisahkan dari 'INVALID' dengan sengaja: tanpa state ini, mesin
   * yang rusak akan melaporkan "lisensi tidak valid" dan menuntun
   * diagnosis ke arah yang sama sekali salah.
   */
  | 'CRYPTO_UNAVAILABLE'
  /** Public key belum ditanam — sistem lisensi belum dikonfigurasi. */
  | 'NOT_CONFIGURED'
  /** Belum pernah aktivasi di perangkat ini. */
  | 'NOT_ACTIVATED'
  /**
   * Pengguna melepas lisensi dari perangkat ini secara sengaja, dan
   * server sudah mengonfirmasinya. Aksesnya ditolak sama seperti
   * NOT_ACTIVATED — yang berbeda hanya penjelasan di layar. Tanpa
   * pembedaan ini, pengguna yang baru saja menekan "Nonaktifkan"
   * melihat layar yang sama dengan pemasangan baru dan wajar mengira
   * datanya hilang.
   */
  | 'DEACTIVATED'
  /**
   * Token ini ditandatangani untuk koperasi lain. Diperlakukan sebagai
   * kegagalan keamanan, bukan sekadar data tidak cocok: satu license key
   * tidak boleh berpindah-pindah koperasi.
   */
  | 'COOPERATIVE_MISMATCH'
  /** Semua syarat terpenuhi; aplikasi boleh dipakai. */
  | 'ACTIVE'
  /** Token masih sah, tetapi grace period verifikasi server sudah habis. */
  | 'NEEDS_VERIFICATION'
  /** Masa berlaku lisensi habis. */
  | 'EXPIRED'
  /** Server mencabut lisensi ini. */
  | 'REVOKED'
  /** Token milik perangkat lain — diperlakukan sebagai kegagalan keamanan. */
  | 'DEVICE_MISMATCH'
  /** Token rusak/tidak dikenali server. */
  | 'INVALID';

export interface LicenseStatus {
  readonly state: LicenseGateState;
  readonly allowAppAccess: boolean;
  readonly licenseType: LicenseType | null;
  readonly cooperativeName: string | null;
  readonly activatedAt: string | null;
  readonly expiresAt: string | null;
  readonly lastVerifiedAtMs: number | null;
  /** Sisa grace period dalam ms; `null` bila belum pernah verifikasi. */
  readonly graceRemainingMs: number | null;
  readonly clockRollbackDetected: boolean;
  /** `true` bila sudah waktunya menghubungi server (§13). */
  readonly serverVerificationDue: boolean;
  readonly deviceId: string;
  /**
   * Apakah ADA token tersimpan di perangkat ini — terlepas dari sah
   * atau tidaknya token itu.
   *
   * Hanya untuk LAYAR, bukan untuk keputusan akses: `allowAppAccess`
   * tetap satu-satunya jawaban "boleh masuk". Yang dijawab field ini
   * adalah pertanyaan yang berbeda dan murni tampilan — "adakah sesuatu
   * yang bisa dikirim tombol Coba Verifikasi Lagi".
   *
   * Sebelum RC-S52 layar menebaknya dari `state`, dan tebakan itu salah
   * untuk DEACTIVATED: perangkat yang ditolak server lewat
   * DEVICE_DEACTIVATED MASIH menyimpan token, tetapi tombol verifikasi
   * disembunyikan — sehingga pembatalan deaktivasi oleh admin tidak
   * pernah bisa terbaca dari sisi aplikasi.
   */
  readonly hasStoredLicense: boolean;
}

export type LicenseErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_LICENSE'
  | 'LICENSE_ALREADY_USED'
  | 'LICENSE_REVOKED'
  | 'LICENSE_EXPIRED'
  | 'DEVICE_MISMATCH'
  | 'DEVICE_DEACTIVATED'
  | 'COOPERATIVE_MISMATCH'
  | 'COOPERATIVE_BINDING_MISSING'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK_UNAVAILABLE'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'TOKEN_REJECTED'
  | 'NOT_CONFIGURED'
  | 'CRYPTO_UNAVAILABLE'
  | 'NOT_ACTIVATED';

export interface LicenseFailure {
  readonly ok: false;
  readonly code: LicenseErrorCode;
  /** Pesan siap tampil untuk pengguna — TIDAK PERNAH berisi stack trace. */
  readonly message: string;
  /** Alasan teknis penolakan token, bila relevan. Untuk log lokal saja. */
  readonly tokenReason?: TokenRejectionReason;
}

export type ActivationResult = { readonly ok: true; readonly status: LicenseStatus } | LicenseFailure;

export type VerificationResult =
  | { readonly ok: true; readonly status: LicenseStatus }
  | LicenseFailure;

export type DeactivationResult = { readonly ok: true } | LicenseFailure;

// ---------------------------------------------------------------------------
// Lapisan HTTP
// ---------------------------------------------------------------------------

interface HttpOutcome {
  readonly kind: 'RESPONSE' | 'NETWORK' | 'TIMEOUT' | 'MALFORMED';
  readonly httpStatus?: number;
  readonly body?: Record<string, unknown>;
  /** Waktu server dari header `Date`, epoch ms. */
  readonly serverTimeMs?: number;
}

/**
 * POST JSON ke license server.
 *
 * Sengaja TIDAK melempar untuk kegagalan jaringan apa pun. Aplikasi ini
 * offline-first: "server tidak terjangkau" adalah keadaan NORMAL yang
 * harus dibedakan dengan jelas dari "server menjawab bahwa lisensi
 * tidak sah" (§7). Exception yang naik ke pemanggil membuat dua hal itu
 * gampang tertukar.
 */
async function postJson(path: string, payload: Record<string, unknown>): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LICENSE_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${LICENSE_API_BASE}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const dateHeader = response.headers.get('date');
    const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
    const serverTimeMs = Number.isFinite(parsedDate) ? parsedDate : undefined;

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: 'MALFORMED', httpStatus: response.status, serverTimeMs };
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { kind: 'MALFORMED', httpStatus: response.status, serverTimeMs };
    }

    return {
      kind: 'RESPONSE',
      httpStatus: response.status,
      body: body as Record<string, unknown>,
      serverTimeMs,
    };
  } catch (error) {
    // AbortError = timeout kita sendiri; sisanya DNS/TLS/offline.
    const name = error instanceof Error ? error.name : '';
    return { kind: name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

/** Pemetaan kode server -> pesan Indonesia yang aman ditampilkan (§11, §21). */
function messageForCode(code: LicenseErrorCode): string {
  switch (code) {
    case 'INVALID_LICENSE':
      return 'License key tidak valid atau tidak ditemukan.';
    case 'LICENSE_ALREADY_USED':
      return 'License ini sudah digunakan di perangkat lain.';
    case 'LICENSE_REVOKED':
      return 'Lisensi ini telah dicabut oleh penerbit.';
    case 'LICENSE_EXPIRED':
      return 'Masa berlaku lisensi sudah habis.';
    case 'DEVICE_MISMATCH':
      return 'Lisensi ini terdaftar untuk perangkat lain.';
    case 'DEVICE_DEACTIVATED':
      return 'Perangkat ini sudah dinonaktifkan oleh penerbit. Hubungi penerbit untuk aktivasi kembali.';
    case 'COOPERATIVE_MISMATCH':
      return 'License ini terdaftar untuk koperasi lain.';
    case 'COOPERATIVE_BINDING_MISSING':
      return 'Lisensi perlu diaktivasi ulang untuk perangkat ini.';
    case 'RATE_LIMITED':
      return 'Terlalu banyak percobaan. Silakan coba lagi beberapa saat lagi.';
    case 'NETWORK_UNAVAILABLE':
      return 'Tidak dapat terhubung ke server. Periksa koneksi internet Anda.';
    case 'TIMEOUT':
      return 'Server tidak merespons. Coba lagi beberapa saat lagi.';
    case 'MALFORMED_RESPONSE':
      return 'Respons server tidak dikenali. Coba lagi beberapa saat lagi.';
    case 'TOKEN_REJECTED':
      return 'Token aktivasi dari server tidak lolos pemeriksaan keamanan di perangkat ini.';
    case 'NOT_CONFIGURED':
      return 'Sistem lisensi belum dikonfigurasi pada aplikasi ini. Hubungi penerbit aplikasi.';
    case 'CRYPTO_UNAVAILABLE':
      return 'Pemeriksaan keamanan gagal berjalan di perangkat ini. Hubungi penerbit aplikasi.';
    case 'NOT_ACTIVATED':
      return 'Aplikasi belum diaktivasi di perangkat ini.';
    case 'INVALID_REQUEST':
      return 'Data yang dikirim tidak lengkap atau tidak valid.';
    case 'SERVER_ERROR':
    default:
      return 'Terjadi kesalahan pada server. Coba lagi beberapa saat lagi.';
  }
}

function failure(code: LicenseErrorCode, tokenReason?: TokenRejectionReason): LicenseFailure {
  return { ok: false, code, message: messageForCode(code), tokenReason };
}

/** Ambil kode error dari body server; apa pun yang asing -> SERVER_ERROR. */
function serverErrorCode(body: Record<string, unknown> | undefined): LicenseErrorCode {
  const raw = body?.error;
  const known: readonly LicenseErrorCode[] = [
    'INVALID_REQUEST',
    'INVALID_LICENSE',
    'LICENSE_ALREADY_USED',
    'LICENSE_REVOKED',
    'LICENSE_EXPIRED',
    'DEVICE_MISMATCH',
    'DEVICE_DEACTIVATED',
    'COOPERATIVE_MISMATCH',
    'COOPERATIVE_BINDING_MISSING',
    'RATE_LIMITED',
    'SERVER_ERROR',
  ];
  return typeof raw === 'string' && (known as readonly string[]).includes(raw)
    ? (raw as LicenseErrorCode)
    : 'SERVER_ERROR';
}

function networkFailure(outcome: HttpOutcome): LicenseFailure {
  if (outcome.kind === 'TIMEOUT') return failure('TIMEOUT');
  if (outcome.kind === 'MALFORMED') return failure('MALFORMED_RESPONSE');
  return failure('NETWORK_UNAVAILABLE');
}

// ---------------------------------------------------------------------------
// API publik
// ---------------------------------------------------------------------------

export async function getDeviceId(): Promise<string> {
  return resolveDeviceId();
}

export async function getStoredLicense(): Promise<StoredLicense | null> {
  return readStoredLicense();
}

export async function clearLicense(): Promise<void> {
  await clearLicenseState();
}

/** Normalisasi input pengguna sesuai `LicenseKey::normalize()` di server. */
export function normalizeLicenseKey(rawKey: string): string {
  return rawKey.toUpperCase().replace(/\s+/g, '');
}

export function isValidLicenseKeyFormat(normalizedKey: string): boolean {
  return LICENSE_KEY_PATTERN.test(normalizedKey);
}

/**
 * Apakah lisensi tersimpan sudah lewat masa berlaku?
 *
 * Memakai waktu tahan-rollback, BUKAN `Date.now()` mentah — kalau tidak,
 * memundurkan jam akan "menghidupkan kembali" trial yang sudah mati.
 */
export async function isLicenseExpired(): Promise<boolean> {
  const stored = await readStoredLicense();
  if (!stored || stored.expiresAt === null) return false;
  const expiresMs = Date.parse(stored.expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  const { effectiveNowMs } = await getTrustedNow();
  return effectiveNowMs >= expiresMs;
}

/**
 * Evaluasi lengkap keadaan lisensi. TIDAK menyentuh jaringan — murni
 * pemeriksaan lokal, jadi aman dipanggil di jalur startup yang harus
 * cepat dan di perangkat yang sedang offline.
 */
export async function getLicenseStatus(): Promise<LicenseStatus> {
  const deviceId = await resolveDeviceId();
  const { effectiveNowMs, rollbackDetected } = await getTrustedNow();

  const base = {
    licenseType: null,
    cooperativeName: null,
    activatedAt: null,
    expiresAt: null,
    lastVerifiedAtMs: null,
    graceRemainingMs: null,
    clockRollbackDetected: rollbackDetected,
    serverVerificationDue: false,
    deviceId,
    hasStoredLicense: false,
  } as const;

  // Lapisan 0 — apakah kriptografinya sendiri waras di mesin ini?
  // Diperiksa PALING AWAL: kalau Ed25519 tidak berfungsi, setiap
  // jawaban di bawahnya tidak bermakna. Fail-closed.
  const cryptoHealth = await ensureCryptoHealthy();
  if (!cryptoHealth.ok) {
    return { ...base, state: 'CRYPTO_UNAVAILABLE', allowAppAccess: false };
  }

  if (!isLicenseSigningConfigured()) {
    return { ...base, state: 'NOT_CONFIGURED', allowAppAccess: false };
  }

  const stored = await readStoredLicense();
  if (!stored) {
    // Keduanya menolak akses; penandanya hanya mengubah penjelasan.
    const deactivatedAt = await readDeactivatedAt();
    return {
      ...base,
      state: deactivatedAt !== null ? 'DEACTIVATED' : 'NOT_ACTIVATED',
      allowAppAccess: false,
    };
  }

  const metadata = {
    licenseType: stored.licenseType,
    cooperativeName: stored.cooperativeName,
    activatedAt: stored.activatedAt,
    expiresAt: stored.expiresAt,
    lastVerifiedAtMs: stored.lastVerifiedAtMs,
    clockRollbackDetected: rollbackDetected,
    deviceId,
    // Sampai titik ini `readStoredLicense()` sudah mengembalikan token —
    // jadi nilainya `true` untuk SEMUA cabang di bawah, termasuk cabang
    // yang menolak akses.
    hasStoredLicense: true,
  };

  // --- Lapisan 3-5: tanda tangan, device binding, kedaluwarsa ----------
  const tokenResult = await verifyActivationTokenOffline(stored.activationToken, {
    deviceId,
    nowMs: effectiveNowMs,
    // Binding yang tersimpan berasal dari aktivasi yang server setujui,
    // jadi ia sah dipakai sebagai pembanding. Bila ada, token WAJIB
    // membawa binding yang cocok.
    expectedCooperativeName: stored.cooperativeName,
  });

  if (!tokenResult.ok) {
    const state: LicenseGateState =
      tokenResult.reason === 'DEVICE_MISMATCH'
        ? 'DEVICE_MISMATCH'
        : tokenResult.reason === 'COOPERATIVE_MISMATCH' ||
            tokenResult.reason === 'COOPERATIVE_BINDING_MISSING'
          ? 'COOPERATIVE_MISMATCH'
        : tokenResult.reason === 'EXPIRED'
          ? 'EXPIRED'
          : tokenResult.reason === 'NOT_CONFIGURED'
            ? 'NOT_CONFIGURED'
            : 'INVALID';
    return {
      ...metadata,
      graceRemainingMs: null,
      serverVerificationDue: true,
      state,
      allowAppAccess: false,
    };
  }

  // --- Lapisan 6: putusan server terakhir yang diketahui ----------------
  // Putusan negatif bersifat LENGKET: sekali server bilang dicabut,
  // aplikasi tidak boleh terbuka lagi hanya karena berikutnya offline.
  if (stored.lastServerStatus && stored.lastServerStatus !== 'VALID') {
    const state: LicenseGateState =
      stored.lastServerStatus === 'LICENSE_REVOKED'
        ? 'REVOKED'
        : stored.lastServerStatus === 'LICENSE_EXPIRED'
          ? 'EXPIRED'
          : stored.lastServerStatus === 'DEVICE_MISMATCH'
            ? 'DEVICE_MISMATCH'
            : stored.lastServerStatus === 'DEVICE_DEACTIVATED'
              ? 'DEACTIVATED'
              : stored.lastServerStatus === 'COOPERATIVE_MISMATCH'
                ? 'COOPERATIVE_MISMATCH'
                : 'INVALID';
    return {
      ...metadata,
      graceRemainingMs: null,
      serverVerificationDue: true,
      state,
      allowAppAccess: false,
    };
  }

  // --- Lapisan 7: umur bukti verifikasi server -------------------------
  // Termasuk PERMANENT (§8): "permanen" berarti tidak punya tanggal
  // kedaluwarsa, BUKAN berarti server kehilangan hak mencabutnya.
  if (stored.lastVerifiedAtMs === null) {
    return {
      ...metadata,
      graceRemainingMs: null,
      serverVerificationDue: true,
      state: 'NEEDS_VERIFICATION',
      allowAppAccess: false,
    };
  }

  const ageMs = effectiveNowMs - stored.lastVerifiedAtMs;
  const graceRemainingMs = LICENSE_GRACE_PERIOD_MS - ageMs;

  if (graceRemainingMs <= 0) {
    return {
      ...metadata,
      graceRemainingMs: 0,
      serverVerificationDue: true,
      state: 'NEEDS_VERIFICATION',
      allowAppAccess: false,
    };
  }

  const urgentThresholdMs = LICENSE_VERIFY_URGENT_REMAINING_HOURS * 60 * 60 * 1000;
  const serverVerificationDue =
    ageMs >= LICENSE_VERIFY_INTERVAL_MS ||
    graceRemainingMs <= urgentThresholdMs ||
    rollbackDetected;

  return {
    ...metadata,
    licenseType: tokenResult.payload.licenseType,
    expiresAt: tokenResult.payload.expiresAt,
    graceRemainingMs,
    serverVerificationDue,
    state: 'ACTIVE',
    allowAppAccess: true,
  };
}

/**
 * Pemeriksaan lokal ringkas. Sengaja MEMANGGIL ULANG `getLicenseStatus()`
 * dan bukan membaca cache: pemanggil boleh memakainya sesering apa pun
 * tanpa risiko membaca keputusan basi.
 */
export async function hasValidLocalLicense(): Promise<boolean> {
  const status = await getLicenseStatus();
  return status.allowAppAccess;
}

/**
 * AKTIVASI (§12).
 *
 * Urutannya penting dan tidak boleh diubah: token DIVERIFIKASI SECARA
 * LOKAL sebelum disimpan. HTTP 200 dan `success: true` bukan bukti apa
 * pun — keduanya bisa dipalsukan oleh siapa pun yang mengendalikan DNS,
 * proxy, atau file hosts perangkat. Yang tidak bisa dipalsukan tanpa
 * private key server adalah tanda tangan Ed25519-nya.
 */
export async function activateLicense(params: {
  readonly licenseKey: string;
  readonly cooperativeName: string;
}): Promise<ActivationResult> {
  const cryptoHealth = await ensureCryptoHealthy();
  if (!cryptoHealth.ok) {
    return failure('CRYPTO_UNAVAILABLE');
  }

  if (!isLicenseSigningConfigured()) {
    return failure('NOT_CONFIGURED');
  }

  const normalizedKey = normalizeLicenseKey(params.licenseKey);
  if (!isValidLicenseKeyFormat(normalizedKey)) {
    return failure('INVALID_LICENSE');
  }

  const cooperativeName = params.cooperativeName.trim();
  if (cooperativeName.length < 3 || cooperativeName.length > 150) {
    return failure('INVALID_REQUEST');
  }

  const deviceId = await resolveDeviceId();

  const outcome = await postJson('activate.php', {
    license_key: normalizedKey,
    cooperative_name: cooperativeName,
    device_id: deviceId,
    // RC-S125 — field TAMBAHAN (additive). Server memakainya untuk
    // memisahkan slot "HP/Tablet" dan "Laptop/PC" pada satu lisensi
    // (1 lisensi = 1 HP + 1 Laptop/PC). Server lama mengabaikannya.
    // Bukan bagian keputusan akses: token tetap diverifikasi Ed25519.
    device_platform: getDevicePlatform(),
  });

  if (outcome.kind !== 'RESPONSE') {
    return networkFailure(outcome);
  }
  if (outcome.serverTimeMs !== undefined) {
    await recordServerTime(outcome.serverTimeMs);
  }

  const body = outcome.body ?? {};
  if (body.success !== true) {
    return failure(serverErrorCode(body));
  }

  const token = body.activation_token;
  if (typeof token !== 'string' || token.length === 0) {
    return failure('MALFORMED_RESPONSE');
  }

  // --- Verifikasi lokal SEBELUM menyimpan apa pun ----------------------
  const { effectiveNowMs } = await getTrustedNow();
  // Pada aktivasi, nama yang dikirim ke server dipakai sebagai
  // pembanding: kalau server menerbitkan token untuk koperasi LAIN,
  // itu ketidaksesuaian yang harus ketahuan sekarang, bukan nanti.
  const verified = await verifyActivationTokenOffline(token, {
    deviceId,
    nowMs: effectiveNowMs,
    expectedCooperativeName: cooperativeName,
  });
  if (!verified.ok) {
    return failure('TOKEN_REJECTED', verified.reason);
  }

  const payload: ActivationTokenPayload = verified.payload;

  // Metadata diambil dari PAYLOAD YANG SUDAH DITANDATANGANI, bukan dari
  // field JSON di luar token — field di luar token tidak terlindungi
  // tanda tangan dan bisa diubah di tengah jalan.
  const licenseType: LicenseType = payload.licenseType;
  if (!isKnownLicenseType(licenseType)) {
    return failure('MALFORMED_RESPONSE');
  }

  await persistLicense({
    activationToken: token,
    deviceId,
    licenseType,
    expiresAt: payload.expiresAt,
    activatedAt: payload.activatedAt,
    cooperativeName,
  });

  // Aktivasi yang berhasil ADALAH bukti server mengakui lisensi ini,
  // jadi ia sekaligus menjadi titik awal grace period (§13: "verify
  // pertama kali setelah activation" terpenuhi tanpa request kedua).
  await recordServerVerification({
    status: 'VALID',
    atMs: outcome.serverTimeMs ?? effectiveNowMs,
    serverTimeMs: outcome.serverTimeMs ?? null,
  });
  // Perangkat ini aktif lagi — penanda deaktivasi tidak lagi berlaku.
  await clearDeactivatedMark();

  return { ok: true, status: await getLicenseStatus() };
}

/**
 * VERIFIKASI KE SERVER (§7).
 *
 * Aturan utama: server yang TIDAK TERJANGKAU bukan server yang menolak.
 * Kegagalan jaringan TIDAK PERNAH menghapus token dan TIDAK PERNAH
 * mengubah status tersimpan — ia hanya membiarkan grace period menua.
 */
/**
 * RC-S125 — ANTRIAN VERIFIKASI (single-flight).
 *
 * Gate (mount, kembali dari background, sinyal recheck) dan layar
 * lisensi bisa meminta verifikasi hampir bersamaan. Tanpa antrian,
 * masing-masing mengirim request sendiri ke server — boros kuota rate
 * limit dan membuat aplikasi terasa lambat. Sekarang semua pemanggil
 * yang datang selagi satu request masih berjalan MENUNGGU hasil yang
 * sama. Begitu selesai, antrian dikosongkan sehingga pemanggilan
 * berikutnya tetap menghubungi server lagi (tidak ada cache keputusan).
 */
let verifikasiBerjalan: Promise<VerificationResult> | null = null;

export async function verifyLicense(): Promise<VerificationResult> {
  if (!verifikasiBerjalan) {
    verifikasiBerjalan = verifikasiKeServer().finally(() => {
      verifikasiBerjalan = null;
    });
  }
  return verifikasiBerjalan;
}

async function verifikasiKeServer(): Promise<VerificationResult> {
  const stored = await readStoredLicense();
  if (!stored) {
    return failure('NOT_ACTIVATED');
  }

  const deviceId = await resolveDeviceId();

  const outcome = await postJson('verify.php', {
    activation_token: stored.activationToken,
    device_id: deviceId,
  });

  if (outcome.kind !== 'RESPONSE') {
    return networkFailure(outcome);
  }
  if (outcome.serverTimeMs !== undefined) {
    await recordServerTime(outcome.serverTimeMs);
  }

  const body = outcome.body ?? {};

  // Server membalas 429/500 tanpa field `valid` — itu bukan putusan
  // tentang lisensi, jadi status lokal TIDAK diubah.
  if (typeof body.valid !== 'boolean') {
    return failure(serverErrorCode(body));
  }

  const { effectiveNowMs } = await getTrustedNow();
  const atMs = outcome.serverTimeMs ?? effectiveNowMs;

  if (body.valid === true) {
    await recordServerVerification({
      status: 'VALID',
      atMs,
      serverTimeMs: outcome.serverTimeMs ?? null,
    });
    return { ok: true, status: await getLicenseStatus() };
  }

  const rawError = typeof body.error === 'string' ? body.error : 'INVALID_LICENSE';
  const status: LicenseServerStatus =
    rawError === 'LICENSE_REVOKED' ||
    rawError === 'LICENSE_EXPIRED' ||
    rawError === 'DEVICE_MISMATCH' ||
    rawError === 'DEVICE_DEACTIVATED' ||
    rawError === 'COOPERATIVE_MISMATCH' ||
    rawError === 'COOPERATIVE_BINDING_MISSING'
      ? (rawError === 'COOPERATIVE_BINDING_MISSING' ? 'COOPERATIVE_MISMATCH' : rawError)
      : 'INVALID_LICENSE';

  await recordServerVerification({
    status,
    atMs,
    serverTimeMs: outcome.serverTimeMs ?? null,
  });

  // Token TIDAK dihapus (§22): pencabutan bisa dibatalkan admin, dan
  // menyimpan token memungkinkan tombol "Coba Verifikasi Lagi" bekerja.
  return failure(status as LicenseErrorCode);
}

/**
 * Verifikasi hanya bila sudah jatuh tempo (§13). Ini yang dipanggil
 * License Gate saat startup — bukan `verifyLicense()` langsung, supaya
 * membuka-tutup aplikasi sepuluh kali sehari tidak berarti sepuluh
 * request ke server.
 */
export async function verifyLicenseIfDue(): Promise<VerificationResult | null> {
  const status = await getLicenseStatus();
  if (
    status.state === 'NOT_CONFIGURED' ||
    status.state === 'CRYPTO_UNAVAILABLE' ||
    status.state === 'NOT_ACTIVATED' ||
    status.state === 'DEACTIVATED'
  ) {
    return null;
  }
  if (status.state === 'ACTIVE' && !status.serverVerificationDue) {
    return null;
  }
  return verifyLicense();
}

/**
 * DEAKTIVASI (§14). HANYA dipanggil dari aksi eksplisit pengguna yang
 * sudah dikonfirmasi — tidak ada pemanggil otomatis di mana pun.
 *
 * State lokal dihapus HANYA setelah server mengonfirmasi. Kalau dihapus
 * lebih dulu lalu request gagal, slot perangkat di server tetap terpakai
 * sementara pengguna kehilangan lisensinya — kegagalan paling buruk yang
 * mungkin terjadi di alur ini.
 */
export async function deactivateLicense(): Promise<DeactivationResult> {
  const stored = await readStoredLicense();
  if (!stored) {
    return failure('NOT_ACTIVATED');
  }

  const deviceId = await resolveDeviceId();

  const outcome = await postJson('deactivate.php', {
    activation_token: stored.activationToken,
    device_id: deviceId,
  });

  if (outcome.kind !== 'RESPONSE') {
    return networkFailure(outcome);
  }
  if (outcome.serverTimeMs !== undefined) {
    await recordServerTime(outcome.serverTimeMs);
  }

  const body = outcome.body ?? {};
  if (body.success !== true) {
    return failure(serverErrorCode(body));
  }

  // Urutannya penting: tandai SETELAH state dibersihkan, karena
  // `clearLicenseState()` juga menghapus penanda ini.
  const { effectiveNowMs } = await getTrustedNow();
  await clearLicenseState();
  await markDeactivated(outcome.serverTimeMs ?? effectiveNowMs);
  return { ok: true };
}

export { isClockRollbackDetected };

/**
 * AKTIVASI PENDAMPING — lisensi KOPKU Desktop otomatis dari HP.
 *
 * HP yang sudah aktif mengirim token aktivasinya (+ ID perangkatnya) ke
 * desktop lewat kanal sinkron terenkripsi (hanya desktop yang sudah
 * dipasangkan lewat QR). Desktop lalu meminta slot "Laptop/PC"-nya
 * SENDIRI ke server (`api/activate_companion.php`) dengan token HP itu
 * sebagai bukti. Server memeriksa bahwa token tersebut adalah token
 * TERKINI milik HP yang masih aktif, menegakkan aturan 1 HP + 1 PC, dan
 * menerbitkan token baru yang terikat ke perangkat desktop.
 *
 * Token HP tidak pernah disimpan desktop. Yang disimpan hanya token
 * desktop sendiri — setelah lolos verifikasi Ed25519 lokal yang sama
 * persis dengan `activateLicense()`.
 */
export async function activateLicenseCompanion(params: {
  readonly sponsorToken: string;
  readonly sponsorDeviceId: string;
}): Promise<ActivationResult> {
  const cryptoHealth = await ensureCryptoHealthy();
  if (!cryptoHealth.ok) return failure('CRYPTO_UNAVAILABLE');
  if (!isLicenseSigningConfigured()) return failure('NOT_CONFIGURED');
  if (!params.sponsorToken || !params.sponsorDeviceId) return failure('INVALID_REQUEST');

  const deviceId = await resolveDeviceId();
  const outcome = await postJson('activate_companion.php', {
    sponsor_token: params.sponsorToken,
    sponsor_device_id: params.sponsorDeviceId,
    device_id: deviceId,
    device_platform: getDevicePlatform(),
  });

  if (outcome.kind === 'MALFORMED' && outcome.httpStatus === 404) {
    return {
      ok: false,
      code: 'SERVER_ERROR',
      message: 'Server lisensi belum mendukung aktivasi otomatis dari HP (berkas api/activate_companion.php belum diunggah). Aktifkan dengan License Key.',
    };
  }
  if (outcome.kind !== 'RESPONSE') return networkFailure(outcome);
  if (outcome.serverTimeMs !== undefined) await recordServerTime(outcome.serverTimeMs);

  const body = outcome.body ?? {};
  if (body.success !== true) {
    const kode = typeof body.error === 'string' ? body.error : '';
    if ((kode === 'SPONSOR_INVALID' || kode === 'NOT_SUPPORTED') && typeof body.message === 'string') {
      return { ok: false, code: 'INVALID_LICENSE', message: body.message };
    }
    if (outcome.httpStatus === 404 && !kode) {
      return {
        ok: false,
        code: 'SERVER_ERROR',
        message: 'Server lisensi belum mendukung aktivasi otomatis dari HP (berkas api/activate_companion.php belum diunggah). Aktifkan dengan License Key.',
      };
    }
    return failure(serverErrorCode(body));
  }

  const token = body.activation_token;
  const cooperativeName = typeof body.cooperative_name === 'string' ? body.cooperative_name.trim() : '';
  if (typeof token !== 'string' || token.length === 0 || cooperativeName.length < 3) return failure('MALFORMED_RESPONSE');

  const { effectiveNowMs } = await getTrustedNow();
  const verified = await verifyActivationTokenOffline(token, {
    deviceId,
    nowMs: effectiveNowMs,
    expectedCooperativeName: cooperativeName,
  });
  if (!verified.ok) return failure('TOKEN_REJECTED', verified.reason);

  const payload: ActivationTokenPayload = verified.payload;
  const licenseType: LicenseType = payload.licenseType;
  if (!isKnownLicenseType(licenseType)) return failure('MALFORMED_RESPONSE');

  await persistLicense({
    activationToken: token,
    deviceId,
    licenseType,
    expiresAt: payload.expiresAt,
    activatedAt: payload.activatedAt,
    cooperativeName,
  });
  await recordServerVerification({
    status: 'VALID',
    atMs: outcome.serverTimeMs ?? effectiveNowMs,
    serverTimeMs: outcome.serverTimeMs ?? null,
  });
  await clearDeactivatedMark();
  return { ok: true, status: await getLicenseStatus() };
}
