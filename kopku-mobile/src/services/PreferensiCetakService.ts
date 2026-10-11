import { getDb } from '@/database/db';
import type { GayaPdfLaporanKeuangan } from '@/export/ExportTypes';

/**
 * PREFERENSI TAMPILAN PDF LAPORAN KEUANGAN.
 *
 * Pilihan terakhir pengguna ("Standar" atau "Contoh Laporan Juklat SOM 2025") disimpan
 * di tabel kunci-nilai existing `app_config` supaya export berikutnya
 * langsung memakai pilihan yang sama. Tidak ada tabel/skema baru.
 * Hanya memengaruhi bentuk cetak PDF; data, Excel, dan CSV tidak berubah.
 */

const KUNCI = 'PDF_GAYA_LAPORAN_KEUANGAN';
/** Bawaan: tampilan Standar. Format contoh Juklat SOM 2025 hanya bila dipilih. */
export const GAYA_PDF_BAWAAN: GayaPdfLaporanKeuangan = 'STANDAR';

export async function getGayaPdfLaporanKeuangan(): Promise<GayaPdfLaporanKeuangan> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key = ?`, KUNCI);
    return row?.value === 'STANDAR' || row?.value === 'JUKLAT' ? row.value : GAYA_PDF_BAWAAN;
  } catch {
    return GAYA_PDF_BAWAAN;
  }
}

export async function setGayaPdfLaporanKeuangan(gaya: GayaPdfLaporanKeuangan): Promise<void> {
  if (gaya !== 'STANDAR' && gaya !== 'JUKLAT') throw new Error('Tampilan PDF tidak dikenal.');
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    KUNCI,
    gaya,
    new Date().toISOString()
  );
}
