import { getDb } from '@/database/db';

/**
 * PENANDA PANDUAN APLIKASI (app_config, tanpa tabel baru).
 *
 * Setup administrasi selesai -> `tandaiPanduanAwalPerluTampil()` menulis
 * penanda; Dashboard menampilkan panduan slide SEKALI lalu
 * `tandaiPanduanAwalSudahDilihat()`. Instalasi yang sudah berjalan tidak
 * mendapat penanda, sehingga tidak terganggu; mereka tetap dapat membuka
 * panduan dari kartu "Panduan Aplikasi" di Dashboard.
 */

const KUNCI = 'panduan.ONBOARDING_PERLU_TAMPIL';

async function tulis(nilai: '0' | '1'): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    KUNCI,
    nilai,
    new Date().toISOString()
  );
}

export async function tandaiPanduanAwalPerluTampil(): Promise<void> {
  await tulis('1');
}

export async function tandaiPanduanAwalSudahDilihat(): Promise<void> {
  await tulis('0');
}

export async function perluTampilkanPanduanAwal(): Promise<boolean> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key = ?`, KUNCI);
    return row?.value === '1';
  } catch {
    return false;
  }
}
