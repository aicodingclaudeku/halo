import * as SQLite from 'expo-sqlite';
import { newId } from '@/utils/id';
import type { HasilImportDataAwal } from './EksekusiImportDataAwal';
import type { SidikTercatat } from './SidikImport';
import {
  BarisLogRiwayat,
  RingkasanRiwayatImport,
  StatusRiwayatImport,
  statusDariHasil,
} from './RiwayatImportPlan';

/**
 * RC-S100 — PENYIMPANAN & PEMBACAAN RIWAYAT IMPORT DATA AWAL.
 *
 * Menerima `db` sebagai parameter (tidak memanggil `getDb`) supaya bisa
 * diuji langsung terhadap SQLite sungguhan — konvensi yang sama dengan
 * `ResetDataTransaksi` dan `EksekusiImportDataAwal`.
 */

export interface KonteksCatatRiwayat {
  dijalankanOleh: string;
  namaBerkas?: string | null;
  /**
   * Waktu pencatatan. WAJIB diisi pemanggil dengan jam ASLI (`new Date()`),
   * BUKAN `getWaktuSekarang()` milik Mode Pengujian Waktu: riwayat adalah
   * catatan "kapan saya menekan tombol import", dan kalau memakai jam
   * simulasi, import yang lebih baru bisa tampak lebih lama dan urutan
   * daftarnya menyesatkan. Alasan yang sama dipakai `createBackup`
   * (lihat BackupService).
   */
  dijalankanPada: Date;
}

/**
 * Simpan satu hasil import beserta SELURUH baris log-nya (berhasil dan
 * gagal) dalam satu transaksi.
 *
 * TIDAK ADA pembatasan jumlah log yang disimpan. Membatasinya (mis. "100
 * baris pertama") akan membuang justru baris gagal yang belum terlihat,
 * tanpa pengguna tahu ada yang hilang — dan satu kali import data awal
 * paling banyak berukuran ribuan baris, yang bagi SQLite tidak berat.
 */
/**
 * RC-S133.4.3 — jenis sheet yang DITERIMA kolom `import_data_awal_log.jenis_sheet`.
 *
 * CHECK pada tabel itu (v74) hanya memuat ANGGOTA/SIMPANAN/PINJAMAN/
 * BERJANGKA. Sheet yang ditambahkan sesudahnya (5. Aset Tetap, 6. Jasa
 * Dibayar) membuat SATU baris log melanggar CHECK, dan karena seluruh
 * riwayat ditulis dalam satu transaksi, riwayat import itu HILANG
 * seluruhnya tanpa jejak (galatnya hanya tercetak di console).
 *
 * Tanpa migrasi skema (SCHEMA_VERSION tetap, sinkron HP/desktop versi
 * lama tetap jalan), perbaikannya: baca CHECK yang benar-benar terpasang
 * dan lewati rincian baris untuk jenis yang belum diizinkan. Riwayat &
 * jumlah per sheet (ringkasan_json) TETAP tercatat. Bila kelak CHECK
 * diperluas lewat migrasi, rincian jenis itu otomatis ikut tercatat.
 */
const JENIS_LOG_BAWAAN = ['ANGGOTA', 'SIMPANAN', 'PINJAMAN', 'BERJANGKA'];
export async function jenisSheetDiizinkanLog(db: SQLite.SQLiteDatabase): Promise<Set<string>> {
  try {
    const row = await db.getFirstAsync<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_data_awal_log'`
    );
    const m = row?.sql ? /jenis_sheet[^,]*?CHECK\s*\(\s*jenis_sheet\s+IN\s*\(([^)]*)\)/i.exec(row.sql) : null;
    if (!m) return new Set(row?.sql && !/CHECK\s*\(\s*jenis_sheet/i.test(row.sql) ? ['*'] : JENIS_LOG_BAWAAN);
    return new Set(m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')));
  } catch {
    return new Set(JENIS_LOG_BAWAAN);
  }
}

export async function catatRiwayatImport(
  db: SQLite.SQLiteDatabase,
  hasil: HasilImportDataAwal,
  konteks: KonteksCatatRiwayat
): Promise<string> {
  const riwayatId = newId();
  const nowIso = konteks.dijalankanPada.toISOString();
  const status: StatusRiwayatImport = statusDariHasil(hasil);
  const totalBaris = hasil.totalBerhasil + hasil.totalGagal;

  const diizinkan = await jenisSheetDiizinkanLog(db);
  const bolehLog = (jenis: string) => diizinkan.has('*') || diizinkan.has(jenis);

  // RC-S133.6.2 (v81) — kolom sidik_berkas/total_dilewati hanya ditulis bila
  // memang ada (database uji lama tanpa v81 tetap tercatat seperti dulu).
  const kolomRiwayat = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(import_data_awal_riwayat)`);
  const adaV81 = kolomRiwayat.some((k) => k.name === 'total_dilewati');

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO import_data_awal_riwayat
         (id, dijalankan_pada, dijalankan_oleh, nama_berkas, status,
          total_baris, total_berhasil, total_gagal, ringkasan_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      riwayatId,
      nowIso,
      konteks.dijalankanOleh,
      konteks.namaBerkas ?? null,
      status,
      totalBaris,
      hasil.totalBerhasil,
      hasil.totalGagal,
      JSON.stringify(hasil.perSheet),
      nowIso
    );
    if (adaV81) {
      await db.runAsync(
        `UPDATE import_data_awal_riwayat SET sidik_berkas = ?, total_dilewati = ? WHERE id = ?`,
        hasil.sidikBerkas ?? null,
        hasil.totalDilewati ?? 0,
        riwayatId
      );
    }

    for (const b of hasil.berhasil) {
      if (!bolehLog(b.jenis)) continue;
      await db.runAsync(
        `INSERT INTO import_data_awal_log
           (id, riwayat_id, jenis_sheet, baris, keterangan, status, pesan, created_at)
         VALUES (?,?,?,?,?, 'BERHASIL', NULL, ?)`,
        newId(),
        riwayatId,
        b.jenis,
        b.baris,
        b.keterangan,
        nowIso
      );
    }
    for (const g of hasil.gagal) {
      if (!bolehLog(g.jenis)) continue;
      await db.runAsync(
        `INSERT INTO import_data_awal_log
           (id, riwayat_id, jenis_sheet, baris, keterangan, status, pesan, created_at)
         VALUES (?,?,?,?,?, 'GAGAL', ?, ?)`,
        newId(),
        riwayatId,
        g.jenis,
        g.baris,
        g.keterangan,
        g.pesan,
        nowIso
      );
    }
  });

  return riwayatId;
}

function baca<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    // Riwayat tidak boleh gagal ditampilkan hanya karena satu kolom JSON
    // rusak — kartu tetap muncul dengan rincian per sheet kosong, dan
    // angka total (yang tersimpan sebagai kolom tersendiri) tetap benar.
    return fallback;
  }
}

/** Daftar riwayat, terbaru lebih dulu. `batas` menjaga layar tetap ringan. */
export async function daftarRiwayatImport(
  db: SQLite.SQLiteDatabase,
  batas = 50
): Promise<RingkasanRiwayatImport[]> {
  const rows = await db.getAllAsync<{
    id: string;
    dijalankan_pada: string;
    dijalankan_oleh: string;
    nama_berkas: string | null;
    status: StatusRiwayatImport;
    total_baris: number;
    total_berhasil: number;
    total_gagal: number;
    ringkasan_json: string | null;
    total_dilewati?: number | null;
  }>(
    // SELECT * (bukan daftar kolom): kolom v81 total_dilewati dibaca bila ada.
    `SELECT *
       FROM import_data_awal_riwayat
      ORDER BY dijalankan_pada DESC
      LIMIT ?`,
    batas
  );

  return rows.map((r) => ({
    id: r.id,
    dijalankanPada: r.dijalankan_pada,
    dijalankanOleh: r.dijalankan_oleh,
    namaBerkas: r.nama_berkas,
    status: r.status,
    totalBaris: Number(r.total_baris),
    totalBerhasil: Number(r.total_berhasil),
    totalGagal: Number(r.total_gagal),
    totalDilewati: Number(r.total_dilewati ?? 0),
    perSheet: baca(r.ringkasan_json, []),
  }));
}

/** Seluruh baris log satu import, dalam urutan proses (bukan diurut ulang). */
export async function logRiwayatImport(
  db: SQLite.SQLiteDatabase,
  riwayatId: string
): Promise<BarisLogRiwayat[]> {
  const rows = await db.getAllAsync<{
    id: string;
    jenis_sheet: string;
    baris: number;
    keterangan: string;
    status: 'BERHASIL' | 'GAGAL';
    pesan: string | null;
  }>(
    `SELECT id, jenis_sheet, baris, keterangan, status, pesan
       FROM import_data_awal_log
      WHERE riwayat_id = ?
      ORDER BY rowid ASC`,
    riwayatId
  );

  return rows.map((r) => ({
    id: r.id,
    jenisSheet: r.jenis_sheet,
    baris: Number(r.baris),
    keterangan: r.keterangan,
    status: r.status,
    pesan: r.pesan,
  }));
}

/** Jumlah riwayat tersimpan — dipakai lencana pada ikon di pojok kanan atas. */
export async function jumlahRiwayatImport(db: SQLite.SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM import_data_awal_riwayat`
  );
  return Number(row?.n ?? 0);
}

// ===========================================================================
// RC-S133.6.2 (v81) — SIDIK ISI BARIS YANG SUDAH DIIMPOR
// ===========================================================================

/** Sidik yang sudah tercatat, untuk daftar sidik yang diberikan (dipotong per 400). */
export async function muatSidikTercatat(
  db: SQLite.SQLiteDatabase,
  sidik: readonly string[]
): Promise<Map<string, SidikTercatat>> {
  const hasil = new Map<string, SidikTercatat>();
  const unik = [...new Set(sidik)];
  for (let i = 0; i < unik.length; i += 400) {
    const potong = unik.slice(i, i + 400);
    const rows = await db.getAllAsync<{
      sidik: string;
      jenis_sheet: string;
      status: 'BERHASIL' | 'SEBAGIAN';
      entitas_id: string | null;
      created_at: string;
      nama_berkas: string | null;
    }>(
      `SELECT sidik, jenis_sheet, status, entitas_id, created_at, nama_berkas
         FROM import_data_awal_sidik WHERE sidik IN (${potong.map(() => '?').join(',')})`,
      ...potong
    );
    for (const r of rows) {
      hasil.set(r.sidik, {
        sidik: r.sidik,
        jenisSheet: r.jenis_sheet,
        status: r.status,
        entitasId: r.entitas_id,
        createdAt: r.created_at,
        namaBerkas: r.nama_berkas,
      });
    }
  }
  return hasil;
}

export interface CatatSidikInput {
  sidik: string;
  jenisSheet: string;
  status: 'BERHASIL' | 'SEBAGIAN';
  entitasTabel: string | null;
  entitasId: string | null;
  baris: number;
  keterangan: string | null;
  namaBerkas: string | null;
  sidikBerkas: string | null;
  createdBy: string;
  waktu: Date;
}

/**
 * Catat satu baris yang SUDAH tertulis ke buku. Bila sidik yang sama sudah
 * ada (data hasilnya ternyata sudah tidak ada sehingga baris diproses lagi),
 * catatan lama DIGANTI — satu sidik selalu menunjuk satu data yang hidup.
 */
export async function catatSidikBaris(db: SQLite.SQLiteDatabase, d: CatatSidikInput): Promise<void> {
  await db.runAsync(
    `INSERT INTO import_data_awal_sidik
       (id, sidik, jenis_sheet, status, entitas_tabel, entitas_id, riwayat_id, baris, keterangan,
        nama_berkas, sidik_berkas, created_by, created_at)
     VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?)
     ON CONFLICT(sidik) DO UPDATE SET
       jenis_sheet = excluded.jenis_sheet, status = excluded.status, entitas_tabel = excluded.entitas_tabel,
       entitas_id = excluded.entitas_id, riwayat_id = NULL, baris = excluded.baris, keterangan = excluded.keterangan,
       nama_berkas = excluded.nama_berkas, sidik_berkas = excluded.sidik_berkas,
       created_by = excluded.created_by, created_at = excluded.created_at`,
    newId(),
    d.sidik,
    d.jenisSheet,
    d.status,
    d.entitasTabel,
    d.entitasId,
    d.baris,
    d.keterangan,
    d.namaBerkas,
    d.sidikBerkas,
    d.createdBy,
    d.waktu.toISOString()
  );
}

/** Tautkan sidik yang dicatat selama satu import ke riwayatnya (ditulis di akhir import). */
export async function tautkanSidikKeRiwayat(
  db: SQLite.SQLiteDatabase,
  sidik: readonly string[],
  riwayatId: string
): Promise<void> {
  for (let i = 0; i < sidik.length; i += 400) {
    const potong = sidik.slice(i, i + 400);
    await db.runAsync(
      `UPDATE import_data_awal_sidik SET riwayat_id = ? WHERE sidik IN (${potong.map(() => '?').join(',')})`,
      riwayatId,
      ...potong
    );
  }
}
