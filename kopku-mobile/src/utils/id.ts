import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

/**
 * Generator ID unik (UUID v4).
 *
 * CATATAN BUG: sebelumnya pakai paket `uuid` (`uuidv4()`), yang di balik
 * layar bergantung pada global `crypto.getRandomValues()`. Di React
 * Native/Hermes itu tidak tersedia secara bawaan (beda dengan browser/Node),
 * sehingga setiap kali dipanggil — termasuk saat setup wizard membuat
 * koperasiId/adminUserId — selalu error:
 *   "crypto.getRandomValues() not supported"
 * dan setup gagal tersimpan.
 *
 * Fix: pakai `expo-crypto` (native, sudah jadi dependency proyek ini dan
 * sudah dipakai di security/pin.ts untuk salt) yang punya randomUUID()
 * bawaan — tidak butuh polyfill global crypto sama sekali.
 */
export function newId(): string {
  return Crypto.randomUUID();
}

/**
 * Menghasilkan nomor dokumen berurutan & unik per key per tahun,
 * contoh: nextSequence(db, 'JURNAL', 2026) -> "JURNAL-2026-000123"
 * Dipanggil di dalam transaksi DB yang sama dengan insert dokumennya
 * supaya tidak ada celah race condition antar-transaksi.
 */
export async function nextSequence(
  db: SQLite.SQLiteDatabase,
  prefix: string,
  year: number,
  padLength = 6
): Promise<string> {
  const seqKey = `${prefix}-${year}`;
  await db.runAsync(
    `INSERT INTO sequence_counter (seq_key, last_value) VALUES (?, 0)
     ON CONFLICT(seq_key) DO NOTHING`,
    seqKey
  );
  await db.runAsync(
    `UPDATE sequence_counter SET last_value = last_value + 1 WHERE seq_key = ?`,
    seqKey
  );
  const row = await db.getFirstAsync<{ last_value: number }>(
    `SELECT last_value FROM sequence_counter WHERE seq_key = ?`,
    seqKey
  );
  const num = (row?.last_value ?? 1).toString().padStart(padLength, '0');
  return `${seqKey}-${num}`;
}
