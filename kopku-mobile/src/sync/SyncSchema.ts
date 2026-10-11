import type * as SQLite from 'expo-sqlite';

/**
 * SINKRONISASI HP ⇄ DESKTOP — INFRASTRUKTUR PENCATAT PERUBAHAN.
 *
 * Prinsip yang menjaga aplikasi Android tetap berperilaku sama:
 *
 *   1. TIDAK menaikkan `SCHEMA_VERSION` dan tidak menyentuh rantai migrasi
 *      `db.ts`. Tabel `sync_*` dan trigger HANYA dipasang ketika perangkat
 *      dipasangkan (`pasangInfrastrukturSinkron`) dan dicabut saat
 *      pemasangan diputus (`cabutInfrastrukturSinkron`). Perangkat yang
 *      tidak pernah dipasangkan menjalankan database yang identik dengan
 *      sebelum fitur ini ada.
 *   2. Trigger hanya MENAMBAH baris ke `sync_changelog`. Ia tidak mengubah
 *      `changes()`/`last_insert_rowid()` pernyataan pemanggil (SQLite
 *      mengembalikan nilai keduanya setelah trigger selesai), jadi service
 *      akuntansi tidak melihat perbedaan apa pun.
 *   3. Trigger dibuat ulang dari `PRAGMA table_info` setiap kali sidik
 *      skema berubah (mis. setelah migrasi versi aplikasi berikutnya
 *      membangun ulang tabel), sehingga kolom baru otomatis ikut tercatat.
 */

/** Tabel yang tidak pernah disinkronkan (metadata lokal perangkat). */
export const TABEL_TIDAK_DISINKRONKAN: ReadonlySet<string> = new Set(['schema_meta']);

/**
 * Kunci `app_config` yang melekat ke PERANGKAT, bukan ke data koperasi:
 * sesi login, PIN cepat, username terakhir, jam uji developer, status
 * panduan, dan saklar PIN (hash PIN-nya sendiri ada di secure store
 * perangkat, jadi saklarnya pun harus lokal).
 */
export const PREFIX_APP_CONFIG_LOKAL: readonly string[] = [
  'koperasi.session.',
  'koperasi.login.',
  'koperasi.pin.',
  'security.',
  'dev.',
  'panduan.',
];

export function apakahKunciConfigLokal(kunci: string): boolean {
  return PREFIX_APP_CONFIG_LOKAL.some((p) => kunci.startsWith(p));
}

/** Versi format trigger — naikkan bila bentuk SQL trigger berubah. */
const VERSI_TRIGGER = 'T3';
const JUMLAH_KOLOM_PER_POTONG = 40;

export interface InfoTabel {
  nama: string;
  kolom: string[];
  pk: string[];
}

const DDL_SINKRON = `
CREATE TABLE IF NOT EXISTS sync_meta (kunci TEXT PRIMARY KEY, nilai TEXT);
CREATE TABLE IF NOT EXISTS sync_changelog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  pk TEXT NOT NULL,
  pk_lama TEXT,
  op TEXT NOT NULL CHECK (op IN ('U','D')),
  data TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_changelog_kunci ON sync_changelog(tbl, pk);
CREATE TABLE IF NOT EXISTS sync_guard (id INTEGER PRIMARY KEY CHECK (id = 1), aktif INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO sync_guard (id, aktif) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS sync_assert (ok INTEGER NOT NULL CHECK (ok = 1));
CREATE TABLE IF NOT EXISTS sync_peer (
  peer_id TEXT PRIMARY KEY,
  nama TEXT,
  terima_seq INTEGER NOT NULL DEFAULT 0,
  kirim_seq INTEGER NOT NULL DEFAULT 0,
  terakhir_sinkron TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS sync_riwayat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waktu TEXT NOT NULL,
  arah TEXT NOT NULL,
  jumlah_kirim INTEGER NOT NULL DEFAULT 0,
  jumlah_terima INTEGER NOT NULL DEFAULT 0,
  hasil TEXT NOT NULL,
  pesan TEXT
);
`;

export function q(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function daftarTabelData(db: SQLite.SQLiteDatabase): Promise<InfoTabel[]> {
  const tabel = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sync_%' ORDER BY name"
  );
  const hasil: InfoTabel[] = [];
  for (const t of tabel) {
    if (TABEL_TIDAK_DISINKRONKAN.has(t.name)) continue;
    const kolom = await db.getAllAsync<{ name: string; pk: number }>(`PRAGMA table_info(${q(t.name)})`);
    const pk = kolom
      .filter((k) => Number(k.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((k) => k.name);
    if (pk.length === 0) continue; // tanpa PK eksplisit tidak dapat disinkronkan dengan aman (tidak ada di skema v80)
    hasil.push({ nama: t.name, kolom: kolom.map((k) => k.name), pk });
  }
  return hasil;
}

function sidik(tabel: InfoTabel[]): string {
  // Hash FNV-1a 32-bit sederhana — cukup untuk mendeteksi perubahan bentuk.
  const teks = VERSI_TRIGGER + '|' + tabel.map((t) => `${t.nama}(${t.kolom.join(',')})[${t.pk.join(',')}]`).join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < teks.length; i++) {
    h ^= teks.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${VERSI_TRIGGER}-${h.toString(16)}-${tabel.length}`;
}

function ekspresiObjek(alias: 'NEW' | 'OLD', kolom: string[]): string {
  const potongan: string[] = [];
  for (let i = 0; i < kolom.length; i += JUMLAH_KOLOM_PER_POTONG) {
    const bagian = kolom.slice(i, i + JUMLAH_KOLOM_PER_POTONG);
    potongan.push(`json_object(${bagian.map((k) => `${lit(k)}, ${alias}.${q(k)}`).join(', ')})`);
  }
  return potongan.reduce((acc, p) => (acc ? `json_patch(${acc}, ${p})` : p), '');
}

function ekspresiPk(alias: 'NEW' | 'OLD', pk: string[]): string {
  return `json_array(${pk.map((k) => `${alias}.${q(k)}`).join(', ')})`;
}

const SYARAT_GUARD = '(SELECT aktif FROM sync_guard WHERE id = 1) = 0';

function syaratLokal(t: InfoTabel, alias: 'NEW' | 'OLD'): string {
  if (t.nama !== 'app_config' || !t.kolom.includes('key')) return '';
  return PREFIX_APP_CONFIG_LOKAL.map((p) => ` AND ${alias}."key" NOT LIKE ${lit(p + '%')}`).join('');
}

export function sqlTrigger(t: InfoTabel): string[] {
  const n = t.nama;
  const tn = lit(n);
  return [
    `CREATE TRIGGER IF NOT EXISTS ${q('sync_ai_' + n)} AFTER INSERT ON ${q(n)} WHEN ${SYARAT_GUARD}${syaratLokal(t, 'NEW')}
BEGIN INSERT INTO sync_changelog (tbl, pk, op, data) VALUES (${tn}, ${ekspresiPk('NEW', t.pk)}, 'U', ${ekspresiObjek('NEW', t.kolom)}); END;`,
    `CREATE TRIGGER IF NOT EXISTS ${q('sync_au_' + n)} AFTER UPDATE ON ${q(n)} WHEN ${SYARAT_GUARD}${syaratLokal(t, 'NEW')}
BEGIN INSERT INTO sync_changelog (tbl, pk, pk_lama, op, data) VALUES (${tn}, ${ekspresiPk('NEW', t.pk)},
  CASE WHEN ${ekspresiPk('OLD', t.pk)} IS NOT ${ekspresiPk('NEW', t.pk)} THEN ${ekspresiPk('OLD', t.pk)} END,
  'U', ${ekspresiObjek('NEW', t.kolom)}); END;`,
    `CREATE TRIGGER IF NOT EXISTS ${q('sync_ad_' + n)} AFTER DELETE ON ${q(n)} WHEN ${SYARAT_GUARD}${syaratLokal(t, 'OLD')}
BEGIN INSERT INTO sync_changelog (tbl, pk, op) VALUES (${tn}, ${ekspresiPk('OLD', t.pk)}, 'D'); END;`,
  ];
}

export async function bacaMeta(db: SQLite.SQLiteDatabase, kunci: string): Promise<string | null> {
  try {
    const r = await db.getFirstAsync<{ nilai: string | null }>('SELECT nilai FROM sync_meta WHERE kunci = ?', kunci);
    return r?.nilai ?? null;
  } catch {
    return null;
  }
}

export async function tulisMeta(db: SQLite.SQLiteDatabase, kunci: string, nilai: string | null): Promise<void> {
  await db.runAsync(
    'INSERT INTO sync_meta (kunci, nilai) VALUES (?, ?) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai',
    kunci,
    nilai
  );
}

export async function infrastrukturTerpasang(db: SQLite.SQLiteDatabase): Promise<boolean> {
  const r = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('sync_meta','sync_changelog','sync_guard','sync_peer')"
  );
  return Number(r?.n ?? 0) === 4;
}

/**
 * Pasang/segarkan tabel & trigger. Idempoten. Trigger dibuat ulang hanya
 * bila sidik skema berubah. Seluruhnya satu transaksi (atomik).
 */
/**
 * RC-S133.5 — SINKRON MANUAL. Data dipindahkan sebagai salinan utuh
 * (snapshot) atas perintah pengguna, bukan per perubahan. Trigger
 * changelog `sync_a?_*` tidak diperlukan lagi: tanpa sinkron berkala yang
 * mengosongkannya, `sync_changelog` hanya akan terus membesar. Tabel
 * `sync_meta`/`sync_peer`/`sync_riwayat` tetap dipakai (baseline, riwayat).
 */
export const MODE_SINKRON_MANUAL = true;

export async function pasangInfrastrukturSinkron(db: SQLite.SQLiteDatabase): Promise<{ dibuatUlang: boolean; jumlahTabel: number }> {
  await db.execAsync(DDL_SINKRON);
  if (MODE_SINKRON_MANUAL) {
    const lamaManual = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync\\_a_\\_%' ESCAPE '\\'"
    );
    const skripManual = ['BEGIN;', ...lamaManual.map((t) => `DROP TRIGGER IF EXISTS ${q(t.name)};`), 'DELETE FROM sync_changelog;', 'COMMIT;'].join('\n');
    try {
      await db.execAsync(skripManual);
    } catch (e) {
      await db.execAsync('ROLLBACK;').catch(() => undefined);
      throw e;
    }
    return { dibuatUlang: lamaManual.length > 0, jumlahTabel: 0 };
  }
  const tabel = await daftarTabelData(db);
  const sidikBaru = sidik(tabel);
  const sidikLama = await bacaMeta(db, 'sidik_trigger');
  const triggerAda = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync\\_a_\\_%' ESCAPE '\\'"
  );
  const lengkap = Number(triggerAda?.n ?? 0) === tabel.length * 3;
  if (sidikLama === sidikBaru && lengkap) return { dibuatUlang: false, jumlahTabel: tabel.length };

  const lama = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync\\_a_\\_%' ESCAPE '\\'"
  );
  const skrip = [
    'BEGIN;',
    ...lama.map((t) => `DROP TRIGGER IF EXISTS ${q(t.name)};`),
    ...tabel.flatMap(sqlTrigger),
    `INSERT INTO sync_meta (kunci, nilai) VALUES ('sidik_trigger', ${lit(sidikBaru)}) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai;`,
    'COMMIT;',
  ].join('\n');
  try {
    await db.execAsync(skrip);
  } catch (e) {
    await db.execAsync('ROLLBACK;').catch(() => undefined);
    throw e;
  }
  return { dibuatUlang: true, jumlahTabel: tabel.length };
}

/** Lepas seluruh trigger & tabel sinkron (dipakai saat pemasangan diputus). */
export async function cabutInfrastrukturSinkron(db: SQLite.SQLiteDatabase): Promise<void> {
  const lama = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'sync\\_a_\\_%' ESCAPE '\\' OR name LIKE 'sync\\_ro\\_%' ESCAPE '\\')"
  );
  const skrip = [
    'BEGIN;',
    ...lama.map((t) => `DROP TRIGGER IF EXISTS ${q(t.name)};`),
    'DROP TABLE IF EXISTS sync_changelog;',
    'DROP TABLE IF EXISTS sync_peer;',
    'DROP TABLE IF EXISTS sync_guard;',
    'DROP TABLE IF EXISTS sync_assert;',
    'DROP TABLE IF EXISTS sync_riwayat;',
    'DROP TABLE IF EXISTS sync_meta;',
    'COMMIT;',
  ].join('\n');
  try {
    await db.execAsync(skrip);
  } catch (e) {
    await db.execAsync('ROLLBACK;').catch(() => undefined);
    throw e;
  }
}
