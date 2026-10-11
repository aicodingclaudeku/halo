import * as SQLite from 'expo-sqlite';

/**
 * DevClockService — JAM SIMULASI untuk "Mode Pengujian Waktu" (menu
 * Developer, dikunci password).
 *
 * KENAPA MODUL INI ADA
 * Untuk menguji perilaku yang bergantung pada tanggal (akrual jasa
 * pinjaman, non-accrual, tutup periode, masa PPh Final, countdown
 * lisensi, dst.) tanpa menunggu waktu sungguhan berjalan, developer
 * perlu cara menggeser "hari ini" versi aplikasi — TANPA mengubah jam
 * perangkat sungguhan (yang akan ikut mengacaukan OS/aplikasi lain).
 *
 * SATU-SATUNYA TITIK INTEGRASI: `getTanggalLokalHariIni()` di
 * `utils/tanggal.ts` — dikutip di kepala berkas itu sebagai
 * "satu-satunya sumber 'hari ini' untuk keperluan AKUNTANSI", dipakai
 * di 80+ berkas. Mengganti sumber waktunya DI SATU TEMPAT ITU SAJA
 * (lewat `getWaktuSekarang()` di sini) berarti seluruh mesin akrual,
 * tutup periode, pajak, dan lisensi otomatis ikut memakai jam simulasi
 * — TIDAK ADA logic tanggal kedua yang dibuat di layar Developer.
 *
 * YANG SENGAJA TIDAK DISENTUH: timestamp audit (`created_at`,
 * `updated_at`, kolom `waktu` di `audit_log`, dan `app_config.updated_at`
 * di berkas ini sendiri) TETAP memakai `new Date()` ASLI — persis
 * keputusan yang sudah didokumentasikan di `tanggal.ts` untuk
 * `toISOString()`. Jam simulasi HANYA memengaruhi "tanggal akuntansi
 * hari ini", bukan jejak audit kapan sesuatu benar-benar terjadi di
 * dunia nyata. Ini penting: kalau audit trail ikut disimulasikan, jejak
 * forensik siapa-mengubah-apa-kapan jadi tidak bisa dipercaya lagi.
 *
 * GAGAL AMAN (fail-safe): kalau `app_config` belum pernah diisi, belum
 * sempat dimuat (`muatJamUjiDariDb` belum dipanggil), atau baris rusak
 * — `getWaktuSekarang()` SELALU kembali ke `new Date()` asli. Tidak ada
 * jalur di mana kegagalan baca konfigurasi diam-diam membuat aplikasi
 * memakai tanggal simulasi yang tidak diinginkan.
 */

export type ModeJamUji = 'REALTIME' | 'KUSTOM';

export interface StatusJamUji {
  /** Sakelar utama (switch on/off di layar Developer). */
  aktif: boolean;
  mode: ModeJamUji;
  /** Waktu simulasi yang DITETAPKAN (ISO), basis penghitungan — bukan waktu sekarang. */
  basisIso: string | null;
  /** Epoch ASLI (Date.now()) saat basis di atas ditetapkan — dipakai supaya jam kustom tetap "berjalan maju". */
  ditetapkanEpoch: number | null;
}

const KEY_AKTIF = 'dev.jam_uji_aktif';
const KEY_MODE = 'dev.jam_uji_mode';
const KEY_BASIS = 'dev.jam_uji_basis_iso';
const KEY_EPOCH = 'dev.jam_uji_ditetapkan_epoch';
const SEMUA_KEY = [KEY_AKTIF, KEY_MODE, KEY_BASIS, KEY_EPOCH];

const STATE_AWAL: StatusJamUji = { aktif: false, mode: 'REALTIME', basisIso: null, ditetapkanEpoch: null };

/** State in-memory — SINKRON, supaya `getWaktuSekarang()` bisa dipanggil dari 80+ call site sinkron yang sudah ada tanpa membuatnya async. */
let state: StatusJamUji = { ...STATE_AWAL };

/**
 * Password gerbang layar Developer (permintaan pengguna). Nilai TETAP,
 * BUKAN kredensial user/PIN aplikasi, dan SENGAJA tidak disimpan di
 * `app_config`/DB — supaya tidak ikut terbawa kalau file database
 * (mis. hasil backup) dibuka/dibaca orang lain.
 */
const PASSWORD_DEVELOPER = '01022003';

export function cocokkanPasswordDeveloper(input: string): boolean {
  return input === PASSWORD_DEVELOPER;
}

/** "Sekarang" versi aplikasi — REAL kecuali mode pengujian aktif & sudah ditetapkan waktu kustomnya. */
export function getWaktuSekarang(): Date {
  if (!state.aktif || state.mode !== 'KUSTOM' || !state.basisIso || state.ditetapkanEpoch === null) {
    return new Date();
  }
  const basisMs = Date.parse(state.basisIso);
  if (Number.isNaN(basisMs)) return new Date();
  // Jam kustom tetap BERJALAN MAJU mengikuti waktu asli sejak
  // ditetapkan — bukan waktu yang beku di satu titik — supaya perilaku
  // yang bergantung pada durasi (mis. sesi auto-lock) tetap masuk akal
  // selama sesi pengujian.
  const elapsedMs = Date.now() - state.ditetapkanEpoch;
  return new Date(basisMs + elapsedMs);
}

export function getStatusJamUji(): StatusJamUji {
  return { ...state };
}

async function tulisConfig(db: SQLite.SQLiteDatabase, key: string, value: string): Promise<void> {
  const now = new Date().toISOString(); // ASLI, sengaja — lihat catatan header.
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now
  );
}

/**
 * Memuat status jam uji dari `app_config` ke cache in-memory. Dipanggil
 * SEKALI saat startup (`app/index.tsx`, sebelum fase READY) — layar
 * Developer memanggilnya lagi setiap kali dibuka supaya selalu
 * menampilkan nilai tersimpan terbaru.
 */
export async function muatJamUjiDariDb(db: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const rows = await db.getAllAsync<{ key: string; value: string }>(
      `SELECT key, value FROM app_config WHERE key IN (${SEMUA_KEY.map(() => '?').join(',')})`,
      ...SEMUA_KEY
    );
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const epochStr = map.get(KEY_EPOCH);
    const epoch = epochStr !== undefined ? Number(epochStr) : null;
    state = {
      aktif: map.get(KEY_AKTIF) === '1',
      mode: map.get(KEY_MODE) === 'KUSTOM' ? 'KUSTOM' : 'REALTIME',
      basisIso: map.get(KEY_BASIS) ?? null,
      ditetapkanEpoch: epoch !== null && Number.isFinite(epoch) ? epoch : null,
    };
  } catch {
    // Gagal baca -> gagal AMAN ke waktu asli (lihat catatan header),
    // BUKAN melempar error yang bisa menggagalkan startup aplikasi.
    state = { ...STATE_AWAL };
  }
}

/** Nyalakan/matikan Mode Pengujian Waktu. Mematikan TIDAK menghapus basis kustom tersimpan — hanya berhenti diterapkan (bisa dinyalakan lagi dengan nilai terakhir). */
export async function setJamUjiAktif(db: SQLite.SQLiteDatabase, aktif: boolean): Promise<void> {
  await tulisConfig(db, KEY_AKTIF, aktif ? '1' : '0');
  state = { ...state, aktif };
}

/** Kembali ke waktu asli perangkat (mode REALTIME). Basis kustom yang tersimpan tidak dihapus, hanya tidak dipakai. */
export async function setModeRealtime(db: SQLite.SQLiteDatabase): Promise<void> {
  await tulisConfig(db, KEY_MODE, 'REALTIME');
  state = { ...state, mode: 'REALTIME' };
}

/** Tetapkan waktu kustom lengkap (tanggal + jam). `tanggalIso` = 'YYYY-MM-DD', `jam` = 'HH:mm'. */
export async function setWaktuKustom(db: SQLite.SQLiteDatabase, tanggalIso: string, jam: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggalIso)) throw new Error('Format tanggal harus YYYY-MM-DD.');
  if (!/^\d{2}:\d{2}$/.test(jam)) throw new Error('Format jam harus HH:mm.');
  const basis = new Date(`${tanggalIso}T${jam}:00`);
  if (Number.isNaN(basis.getTime())) throw new Error('Tanggal atau jam tidak valid.');

  const epoch = Date.now();
  await tulisConfig(db, KEY_MODE, 'KUSTOM');
  await tulisConfig(db, KEY_BASIS, basis.toISOString());
  await tulisConfig(db, KEY_EPOCH, String(epoch));
  state = { ...state, mode: 'KUSTOM', basisIso: basis.toISOString(), ditetapkanEpoch: epoch };
}

/**
 * Ganti HANYA komponen TAHUN (permintaan pengguna: "tahun yang bisa
 * disesuaikan") — bulan/tanggal/jam mengikuti waktu berjalan saat ini
 * (simulasi kalau sedang KUSTOM, asli kalau masih REALTIME). Berguna
 * untuk lompat cepat menguji pergantian tahun buku/SHU/lisensi tanpa
 * mengatur ulang tanggal & jam lengkap.
 */
export async function setTahunKustom(db: SQLite.SQLiteDatabase, tahunBaru: number): Promise<void> {
  if (!Number.isInteger(tahunBaru) || tahunBaru < 2000 || tahunBaru > 2100) {
    throw new Error('Tahun harus berupa bilangan bulat antara 2000 dan 2100.');
  }
  const basis = getWaktuSekarang();
  basis.setFullYear(tahunBaru);

  const epoch = Date.now();
  await tulisConfig(db, KEY_MODE, 'KUSTOM');
  await tulisConfig(db, KEY_BASIS, basis.toISOString());
  await tulisConfig(db, KEY_EPOCH, String(epoch));
  state = { ...state, mode: 'KUSTOM', basisIso: basis.toISOString(), ditetapkanEpoch: epoch };
}

/** Hanya untuk test — reset cache in-memory ke kondisi awal tanpa menyentuh DB. */
export function _resetStateUntukTest(): void {
  state = { ...STATE_AWAL };
}
