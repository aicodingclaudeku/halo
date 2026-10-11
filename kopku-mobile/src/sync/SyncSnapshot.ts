import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import { File } from 'expo-file-system';
import { getDb, closeDb, getDatabaseFilePath, getSqliteDirectory } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';
import { BACKUP_DIR, validasiFileBackup } from '@/services/BackupService';
import { logout } from '@/services/AuthService';
import { useAppStore } from '@/store/useAppStore';
import { tulisBackupTerenkripsi } from '@/backup/BerkasBackupIO';
import { getKunciPerangkat, pastikanKodePemulihan, getIdInstalasi } from '@/security/backupKeyStore';
import { uriKePath } from '@/desktop/platformSinkron';
import { pasangInfrastrukturSinkron, tulisMeta, bacaMeta, lit } from './SyncSchema';
import { ambilPerubahanLokal, bacaKursor, nomorUrutChangelog, seqLokalTertinggi, type BarisKonflik } from './SyncEngine';
import { hex, idAcak, pembuatHash } from './SyncKripto';
import { lepasModeBacaSaja } from './SyncModeBacaSaja';

/**
 * SNAPSHOT — salinan database utuh untuk (1) memilih data awal saat
 * pertama dipasangkan dan (2) menyelesaikan konflik dengan memilih
 * perangkat buku induk.
 *
 * Penggantian database penerima memakai pola yang sama dengan
 * `BackupService.restoreBackup` (validasi → backup pengaman terenkripsi
 * → tukar berkas lewat `.previous` → buka & migrasi → kembalikan bila
 * gagal), sehingga tidak ada data yang hilang: kondisi sebelum
 * penggantian selalu tersimpan di daftar Backup sebagai
 * `sebelum-sinkron_*.kdb`, dan perubahan yang belum tersinkron
 * diarsipkan sebagai JSON yang dapat dibagikan.
 */

export const DIR_SINKRON = `${FileSystem.documentDirectory}sinkron/`;
export const DIR_ARSIP = `${DIR_SINKRON}arsip/`;

async function pastikanDir(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
}

function stempel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface InfoSnapshot {
  uri: string;
  ukuran: number;
  sha256: string;
  baseline: string;
}

export function hashBerkas(uri: string): { ukuran: number; sha256: string } {
  const f = new File(uri);
  const ukuran = f.size ?? 0;
  const h = pembuatHash();
  const pegangan = f.open();
  try {
    const POTONG = 1 << 20;
    for (let pos = 0; pos < ukuran; pos += POTONG) {
      pegangan.offset = pos;
      h.update(pegangan.readBytes(Math.min(POTONG, ukuran - pos)));
    }
  } finally {
    pegangan.close();
  }
  return { ukuran, sha256: hex(h.digest()) };
}

/** Buat snapshot konsisten (VACUUM INTO) dengan baseline BARU tertanam di dalamnya. */
export async function buatSnapshot(): Promise<InfoSnapshot> {
  const db = await getDb();
  await pasangInfrastrukturSinkron(db);
  const baseline = `BL-${idAcak()}`;
  await tulisMeta(db, 'baseline', baseline);
  await pastikanDir(DIR_SINKRON);
  const uri = `${DIR_SINKRON}snapshot-keluar.db`;
  await FileSystem.deleteAsync(uri, { idempotent: true });
  await db.execAsync(`VACUUM INTO ${lit(uriKePath(uri))};`);
  const { ukuran, sha256 } = hashBerkas(uri);
  return { uri, ukuran, sha256, baseline };
}

export interface MetaSnapshot {
  smax: number;
  sseq: number;
  baseline: string | null;
  skema: number;
  setupSelesai: boolean;
}

/** Baca kursor & baseline dari DALAM berkas snapshot (bukan dari pengirim). */
export async function bacaMetaSnapshot(uri: string): Promise<MetaSnapshot> {
  const nama = 'kopku_snapshot_periksa.db';
  const salinan = `${getSqliteDirectory()}${nama}`;
  await pastikanDir(getSqliteDirectory());
  for (const s of ['', '-wal', '-shm']) await FileSystem.deleteAsync(`${salinan}${s}`, { idempotent: true });
  await FileSystem.copyAsync({ from: uri, to: salinan });
  const db = await SQLite.openDatabaseAsync(nama);
  try {
    const skema = Number((await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_meta WHERE id = 1'))?.version ?? 0);
    const adaSync = Number(
      (await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='sync_changelog'"))?.n ?? 0
    ) > 0;
    const smax = adaSync ? await seqLokalTertinggi(db) : 0;
    const sseq = adaSync ? await nomorUrutChangelog(db) : 0;
    const baseline = adaSync ? await bacaMeta(db, 'baseline') : null;
    const setup = await db
      .getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM koperasi')
      .then((r) => Number(r?.n ?? 0) > 0)
      .catch(() => false);
    return { smax, sseq, baseline, skema, setupSelesai: setup };
  } finally {
    await db.closeAsync();
    for (const s of ['', '-wal', '-shm']) await FileSystem.deleteAsync(`${salinan}${s}`, { idempotent: true });
  }
}

/** Backup pengaman terenkripsi (tampil di menu Backup & Restore). */
async function backupPengaman(awalan: string): Promise<string> {
  const db = await getDb();
  await pastikanDir(BACKUP_DIR);
  await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  const nama = `${awalan}_${stempel()}.kdb`;
  const [kunciPerangkat, kodePemulihan, idInstalasi] = await Promise.all([getKunciPerangkat(), pastikanKodePemulihan(), getIdInstalasi()]);
  await tulisBackupTerenkripsi({
    sumberUri: getDatabaseFilePath(),
    tujuanUri: `${BACKUP_DIR}${nama}`,
    kunciPerangkat,
    kodePemulihan,
    idInstalasi,
    skema: SCHEMA_VERSION,
  });
  return nama;
}

/** Arsipkan perubahan lokal yang belum diterima pasangan sebelum ditimpa. */
export async function arsipkanPerubahanTertunda(peerId: string, alasan: string, konflik: BarisKonflik[] = []): Promise<string | null> {
  try {
    const db = await getDb();
    const k = await bacaKursor(db, peerId);
    const tertunda = await ambilPerubahanLokal(db, k?.kirim_seq ?? 0, 100000);
    if (tertunda.length === 0 && konflik.length === 0) return null;
    await pastikanDir(DIR_ARSIP);
    const uri = `${DIR_ARSIP}arsip-sinkron_${stempel()}.json`;
    await FileSystem.writeAsStringAsync(
      uri,
      JSON.stringify({ format: 'KOPKU-ARSIP-SINKRON-1', dibuat: new Date().toISOString(), alasan, konflik, perubahanTidakTerkirim: tertunda }, null, 1)
    );
    return uri;
  } catch {
    return null;
  }
}

export async function daftarArsip(): Promise<{ nama: string; uri: string }[]> {
  try {
    await pastikanDir(DIR_ARSIP);
    const f = await FileSystem.readDirectoryAsync(DIR_ARSIP);
    return f
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()
      .map((nama) => ({ nama, uri: `${DIR_ARSIP}${nama}` }));
  } catch {
    return [];
  }
}

export interface HasilGanti {
  smax: number;
  sseq: number;
  baseline: string;
  backupPengaman: string;
}

/**
 * Ganti database perangkat ini dengan snapshot pasangan, lalu tata ulang
 * metadata sinkron: changelog lama dibuang (milik pengirim), kursor diset
 * ke posisi snapshot.
 */
export async function gantiDatabaseDenganSnapshot(uri: string, peer: { id: string; nama: string }): Promise<HasilGanti> {
  const meta = await bacaMetaSnapshot(uri);
  if (meta.skema !== SCHEMA_VERSION) {
    throw new Error(
      `Versi data berbeda (snapshot v${meta.skema}, aplikasi ini v${SCHEMA_VERSION}). Perbarui aplikasi di kedua perangkat ke versi yang sama.`
    );
  }
  if (!meta.baseline) throw new Error('Snapshot tidak membawa baseline sinkron.');
  const validasi = await validasiFileBackup(uri);
  if (!validasi.valid) throw new Error(`Snapshot tidak valid:\n${validasi.errors.join('\n')}`);

  const pengaman = await backupPengaman('sebelum-sinkron');

  const live = getDatabaseFilePath();
  const previous = `${live}.previous`;
  const tmp = `${live}.restoring.tmp`;
  await FileSystem.deleteAsync(tmp, { idempotent: true });
  await FileSystem.copyAsync({ from: uri, to: tmp });
  await closeDb();
  await FileSystem.deleteAsync(previous, { idempotent: true });
  const liveInfo = await FileSystem.getInfoAsync(live);
  if (liveInfo.exists) await FileSystem.moveAsync({ from: live, to: previous });
  await FileSystem.deleteAsync(`${live}-wal`, { idempotent: true });
  await FileSystem.deleteAsync(`${live}-shm`, { idempotent: true });
  await FileSystem.moveAsync({ from: tmp, to: live });

  try {
    const db = await getDb();
    await pasangInfrastrukturSinkron(db);
    // Salinan dari HP membawa trigger baca-saja HP; perangkat PENERIMA tidak
    // pernah mewarisinya (HP memasangnya kembali sendiri setelah ini).
    await lepasModeBacaSaja(db);
    await db.execAsync(
      [
        'BEGIN;',
        'DELETE FROM sync_changelog;',
        'DELETE FROM sync_peer;',
        'DELETE FROM sync_riwayat;',
        `INSERT INTO sync_peer (peer_id, nama, terima_seq, kirim_seq, terakhir_sinkron, status) VALUES (${lit(peer.id)}, ${lit(peer.nama)}, ${meta.smax}, ${meta.sseq}, ${lit(new Date().toISOString())}, 'OK');`,
        `INSERT INTO sync_riwayat (waktu, arah, jumlah_kirim, jumlah_terima, hasil, pesan) VALUES (${lit(new Date().toISOString())}, 'SNAPSHOT_MASUK', 0, 0, 'OK', ${lit('Data diganti dengan salinan ' + peer.nama + '. Backup pengaman: ' + pengaman)});`,
        'COMMIT;',
      ].join('\n')
    );
  } catch (e) {
    await closeDb();
    for (const s of ['', '-wal', '-shm']) await FileSystem.deleteAsync(`${live}${s}`, { idempotent: true });
    const p = await FileSystem.getInfoAsync(previous);
    if (p.exists) await FileSystem.moveAsync({ from: previous, to: live });
    throw new Error(`Penggantian data dibatalkan; data lama dikembalikan. Rincian: ${e instanceof Error ? e.message : String(e)}`);
  }
  await FileSystem.deleteAsync(previous, { idempotent: true });
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);

  await logout().catch(() => undefined);
  useAppStore.getState().triggerRestoreReload();
  return { smax: meta.smax, sseq: meta.sseq, baseline: meta.baseline, backupPengaman: pengaman };
}

/** Sisi PENGIRIM snapshot: setel kursor setelah penerima selesai. */
export async function setelKursorSetelahSnapshotKeluar(peer: { id: string; nama: string }, smax: number, sseq: number): Promise<void> {
  const db = await getDb();
  await pasangInfrastrukturSinkron(db);
  await db.execAsync(
    [
      'BEGIN;',
      `INSERT OR IGNORE INTO sync_peer (peer_id, nama) VALUES (${lit(peer.id)}, ${lit(peer.nama)});`,
      `UPDATE sync_peer SET kirim_seq = ${smax}, terima_seq = ${sseq}, terakhir_sinkron = ${lit(new Date().toISOString())}, status = 'OK' WHERE peer_id = ${lit(peer.id)};`,
      `DELETE FROM sync_changelog WHERE seq <= ${smax};`,
      `INSERT INTO sync_riwayat (waktu, arah, jumlah_kirim, jumlah_terima, hasil, pesan) VALUES (${lit(new Date().toISOString())}, 'SNAPSHOT_KELUAR', 0, 0, 'OK', ${lit('Salinan data dikirim ke ' + peer.nama)});`,
      'COMMIT;',
    ].join('\n')
  );
}
