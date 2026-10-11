import type * as SQLite from 'expo-sqlite';
import type { PermissionSet, Resource } from '@/config/defaultPermissions';
import { daftarTabelData, lit, q, PREFIX_APP_CONFIG_LOKAL } from './SyncSchema';
import { pasanganDiMemori } from './SyncIdentitas';
import { infoPlatformSinkron } from '@/desktop/platformSinkron';

/**
 * MODE CADANGAN (BACA-SAJA) UNTUK HP YANG TERSINKRON DENGAN DESKTOP.
 *
 * Kebijakan: begitu HP dipasangkan dengan KOPKU Desktop (QR dipindai), KOPKU Desktop menjadi SATU-SATUNYA tempat transaksi dan input
 * data. HP menjadi penyimpanan cadangan yang menerima salinan data dari
 * desktop (sinkron satu arah). Dengan begitu transaksi tidak mungkin
 * tercatat ganda di dua perangkat.
 *
 * Penegakan berlapis:
 *  1. DATABASE — trigger `sync_ro_*` menolak INSERT/UPDATE/DELETE pada
 *     setiap tabel data, kecuali ketika penerapan sinkron dari desktop
 *     sedang berjalan (`sync_guard.aktif = 1`). Pengecualian lokal:
 *       - `audit_log` (jejak login/backup di HP sendiri);
 *       - `app_config` dengan kunci khusus perangkat (sesi, PIN cepat,
 *         jam uji, panduan — lihat PREFIX_APP_CONFIG_LOKAL);
 *       - `app_user`: hanya kolom keamanan perangkat (PIN, password,
 *         biometrik, `updated_at`), bukan identitas/role/status akun.
 *  2. UI — izin role disaring: setiap modul hanya "Lihat" dan "Export"
 *     (Backup tetap penuh supaya HP dapat membuat cadangan .kdb). Menu,
 *     tab, dan formulir input tertutup lewat Permission Matrix (RC-S132).
 *  3. SINKRON — HP tidak mengirim perubahan apa pun ke desktop.
 *
 * Desktop TIDAK PERNAH berada dalam mode ini (trigger dilepas setiap kali
 * desktop menerima salinan database dari HP).
 */

export const KODE_HP_CADANGAN = 'KOPKU_HP_CADANGAN';
export const PESAN_HP_CADANGAN =
  'HP ini adalah penyimpanan cadangan KOPKU Desktop. Transaksi dan input data hanya dapat dilakukan di KOPKU Desktop.';

const KOLOM_KEAMANAN_USER = /^(pin_|password_|biometric|updated_at$|last_|login_|terakhir_)/;

const SYARAT_LOKAL = '(SELECT aktif FROM sync_guard WHERE id = 1) = 0';
const TOLAK = `SELECT RAISE(ABORT, ${lit(`${KODE_HP_CADANGAN}: ${PESAN_HP_CADANGAN}`)});`;

/**
 * Apakah perangkat ini HP yang sedang dalam mode cadangan (baca-saja). Sinkron, tanpa I/O.
 *
 * RC-S133.4.2 — aktif SEGERA setelah QR dipindai (tidak menunggu data awal
 * selesai), dan tetap aktif bila desktop memutus pemasangan. Hanya
 * "Putuskan pemasangan" di HP sendiri yang mengembalikan HP ke mode mandiri.
 */
export function modeHpBacaSajaAktif(): boolean {
  // RC-S133.5 — SINKRON MANUAL (keputusan pengguna 9 Okt 2026): HP dan PC
  // hanya DIHUBUNGKAN; data dikirim manual ("Kirim HP → PC" / "PC → HP").
  // Kedua perangkat tetap dapat dipakai, jadi HP tidak lagi baca-saja.
  // Trigger `sync_ro_*` lama dilepas oleh `pastikanModeManual()` (SyncKlien).
  return MODE_HP_BACA_SAJA && infoPlatformSinkron().jenis === 'HP' && !!pasanganDiMemori();
}

/** RC-S133.5 — mode cadangan baca-saja dimatikan (sinkron manual). */
export const MODE_HP_BACA_SAJA = false;

export const PESAN_DIPUTUS_DESKTOP =
  'Pemasangan diputus dari KOPKU Desktop. HP tetap menjadi penyimpanan cadangan (baca-saja) agar tidak terjadi transaksi ganda. Pindai QR desktop lagi untuk menyambung, atau putuskan di HP untuk memakai HP secara mandiri.';

/** Saring izin role: modul hanya Lihat/Export; Backup tetap penuh. */
export function maskerIzinBacaSaja<T extends Record<string, PermissionSet> | null>(izin: T): T {
  if (!izin || !modeHpBacaSajaAktif()) return izin;
  const out: Record<string, PermissionSet> = {};
  for (const [res, p] of Object.entries(izin)) {
    if ((res as Resource) === 'backup') {
      out[res] = p;
      continue;
    }
    out[res] = { ...p, canCreate: false, canEdit: false, canApprove: false };
  }
  return out as T;
}

function namaTrigger(jenis: 'i' | 'u' | 'd', tabel: string): string {
  return q(`sync_ro_${jenis}_${tabel}`);
}

export async function sqlModeBacaSaja(db: SQLite.SQLiteDatabase): Promise<string[]> {
  const tabel = await daftarTabelData(db);
  const out: string[] = [];
  const syaratKunciLokal = (alias: 'NEW' | 'OLD') => PREFIX_APP_CONFIG_LOKAL.map((p) => `${alias}."key" NOT LIKE ${lit(p + '%')}`).join(' AND ');
  for (const t of tabel) {
    const n = q(t.nama);
    if (t.nama === 'audit_log') continue;
    if (t.nama === 'app_config' && t.kolom.includes('key')) {
      out.push(
        `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('i', t.nama)} BEFORE INSERT ON ${n} WHEN ${SYARAT_LOKAL} AND ${syaratKunciLokal('NEW')} BEGIN ${TOLAK} END;`,
        `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('u', t.nama)} BEFORE UPDATE ON ${n} WHEN ${SYARAT_LOKAL} AND ${syaratKunciLokal('NEW')} BEGIN ${TOLAK} END;`,
        `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('d', t.nama)} BEFORE DELETE ON ${n} WHEN ${SYARAT_LOKAL} AND ${syaratKunciLokal('OLD')} BEGIN ${TOLAK} END;`
      );
      continue;
    }
    if (t.nama === 'app_user') {
      const bisnis = t.kolom.filter((k) => !KOLOM_KEAMANAN_USER.test(k));
      const berubah = bisnis.map((k) => `NEW.${q(k)} IS NOT OLD.${q(k)}`).join(' OR ') || '0';
      out.push(
        `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('i', t.nama)} BEFORE INSERT ON ${n} WHEN ${SYARAT_LOKAL} BEGIN ${TOLAK} END;`,
        `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('u', t.nama)} BEFORE UPDATE ON ${n} WHEN ${SYARAT_LOKAL} AND (${berubah}) BEGIN ${TOLAK} END;`,
        `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('d', t.nama)} BEFORE DELETE ON ${n} WHEN ${SYARAT_LOKAL} BEGIN ${TOLAK} END;`
      );
      continue;
    }
    out.push(
      `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('i', t.nama)} BEFORE INSERT ON ${n} WHEN ${SYARAT_LOKAL} BEGIN ${TOLAK} END;`,
      `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('u', t.nama)} BEFORE UPDATE ON ${n} WHEN ${SYARAT_LOKAL} BEGIN ${TOLAK} END;`,
      `CREATE TRIGGER IF NOT EXISTS ${namaTrigger('d', t.nama)} BEFORE DELETE ON ${n} WHEN ${SYARAT_LOKAL} BEGIN ${TOLAK} END;`
    );
  }
  return out;
}

async function triggerRoLama(db: SQLite.SQLiteDatabase): Promise<string[]> {
  const r = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync\\_ro\\_%' ESCAPE '\\'");
  return r.map((x) => x.name);
}

/** Pasang/segarkan trigger baca-saja (idempoten, atomik). Membutuhkan infrastruktur sinkron. */
export async function pasangModeBacaSaja(db: SQLite.SQLiteDatabase): Promise<void> {
  const lama = await triggerRoLama(db);
  const baru = await sqlModeBacaSaja(db);
  const skrip = ['BEGIN;', ...lama.map((n) => `DROP TRIGGER IF EXISTS ${q(n)};`), ...baru, 'COMMIT;'].join('\n');
  try {
    await db.execAsync(skrip);
  } catch (e) {
    await db.execAsync('ROLLBACK;').catch(() => undefined);
    throw e;
  }
}

/** Lepas seluruh trigger baca-saja (desktop, atau HP yang diputus pemasangannya). */
export async function lepasModeBacaSaja(db: SQLite.SQLiteDatabase): Promise<void> {
  const lama = await triggerRoLama(db);
  if (lama.length === 0) return;
  await db.execAsync(['BEGIN;', ...lama.map((n) => `DROP TRIGGER IF EXISTS ${q(n)};`), 'COMMIT;'].join('\n'));
}

export async function jumlahTriggerBacaSaja(db: SQLite.SQLiteDatabase): Promise<number> {
  return (await triggerRoLama(db)).length;
}

/** Terjemahkan galat SQLite dari trigger baca-saja menjadi pesan yang ramah. */
export function apakahGalatHpCadangan(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).includes(KODE_HP_CADANGAN);
}
