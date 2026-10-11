import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { diagnosaRcS54Produksi } from '@/services/DiagnostikRcS54ProduksiService';
import { newId } from '@/utils/id';

/**
 * RC-S54 TAHAP 16 — GAP 3: KOREKSI HISTORI TERKONTROL (preview → approve → apply).
 *
 * TIDAK ADA koreksi otomatis. Setiap temuan diklasifikasi:
 *  - DAPAT_DITERAPKAN   : fakta & formula koreksi pasti, tanpa menebak nilai, tanpa jurnal baru
 *                         dan tanpa menghapus jurnal. Saat ini SATU jenis:
 *                         INVESTASI_STATUS_TIDAK_SESUAI_JURNAL_PEMBALIK — investasi berstatus
 *                         AKTIF padahal jurnal penempatannya REVERSED oleh jurnal pembalik yang
 *                         POSTED, tanpa penyusutan, impairment, maupun jurnal pelepasan.
 *                         Formula: status := 'DIBATALKAN', updated_at := created_at jurnal
 *                         pembalik (tanggal koreksi yang sesungguhnya). Ledger sudah benar;
 *                         yang dikoreksi hanya register.
 *  - TANPA_JURNAL       : penyajian yang dihitung ulang otomatis (COA #14) atau replay yang
 *                         sudah deterministik (#13-A) — tidak ada yang ditulis.
 *  - MANUAL_REVIEW      : semua lainnya (RAK, disposal lama, arus kas, aset tetap, dsb.) —
 *                         hasil, tanggal, rekening, laba/rugi TIDAK ditebak.
 *
 * approve: menulis audit `HIST_CORRECTION_APPROVE` (userId, alasan, daftar temuan, snapshot
 * nilai sebelum, konfirmasi). apply: satu transaksi; menolak tanpa approval, approval yang
 * sudah diterapkan, temuan yang tidak lagi deterministik, atau snapshot yang berubah; menulis
 * audit `HIST_CORRECTION_APPLY` per temuan (correctionId, userId, tanggal, alasan, sumber
 * temuan, nilai sebelum/sesudah, jurnal terkait). Tanpa migration: approval & apply = audit_log.
 */

export type TindakanKoreksiHistori = 'DAPAT_DITERAPKAN' | 'TANPA_JURNAL' | 'MANUAL_REVIEW';

export interface ItemPreviewKoreksi {
  readonly findingId: string;
  readonly sumber: string;
  readonly kode: string;
  readonly transaksiId: string | null;
  readonly nomorTransaksi: string | null;
  readonly tindakan: TindakanKoreksiHistori;
  readonly deterministik: boolean;
  readonly nilaiSebelum: Readonly<Record<string, unknown>> | null;
  readonly nilaiSesudah: Readonly<Record<string, unknown>> | null;
  readonly journalTerkait: string | null;
  readonly formula: string;
}

export class KoreksiHistoriDitolakError extends Error {
  constructor(readonly kode: string, pesan: string) {
    super(`${kode}: ${pesan}`);
    this.name = 'KoreksiHistoriDitolakError';
  }
}

interface Kueri {
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
}
const kueri = (db: SQLite.SQLiteDatabase) => db as unknown as Kueri;

const KODE_STATUS_PEMBALIK = 'INVESTASI_STATUS_TIDAK_SESUAI_JURNAL_PEMBALIK';

async function kandidatStatusPembalik(db: SQLite.SQLiteDatabase): Promise<ItemPreviewKoreksi[]> {
  const rows = await kueri(db).getAllAsync<{ id: string; nomor_investasi: string; status: string; updated_at: string | null; journal_id: string; balik_id: string; balik_created: string }>(
    `SELECT i.id, i.nomor_investasi, i.status, i.updated_at, i.journal_id, r.id AS balik_id, r.created_at AS balik_created
       FROM investasi i
       JOIN journal j ON j.id = i.journal_id AND j.status = 'REVERSED'
       JOIN journal r ON r.reversal_of_id = j.id AND r.status = 'POSTED'
      WHERE i.status = 'AKTIF'
        AND NOT EXISTS (SELECT 1 FROM investasi_penyusutan p WHERE p.investasi_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM investasi_impairment m WHERE m.investasi_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM journal d WHERE d.sumber_transaksi = 'PELEPASAN_INVESTASI' AND d.sumber_id = i.id)
      ORDER BY i.id`
  );
  return rows.map((r) => ({
    findingId: `${KODE_STATUS_PEMBALIK}:${r.id}`,
    sumber: 'INVESTASI',
    kode: KODE_STATUS_PEMBALIK,
    transaksiId: r.id,
    nomorTransaksi: r.nomor_investasi,
    tindakan: 'DAPAT_DITERAPKAN' as const,
    deterministik: true,
    nilaiSebelum: { status: r.status, updated_at: r.updated_at },
    nilaiSesudah: { status: 'DIBATALKAN', updated_at: r.balik_created },
    journalTerkait: r.balik_id,
    formula: 'status := DIBATALKAN; updated_at := created_at jurnal pembalik (ledger sudah benar, register diselaraskan)',
  }));
}

async function previewDenganDb(db: SQLite.SQLiteDatabase, tanggal?: string): Promise<ItemPreviewKoreksi[]> {
  const items = await kandidatStatusPembalik(db);
  const diag = await diagnosaRcS54Produksi(db, { tanggal });
  diag.temuan.forEach((t, i) => {
    const tanpaJurnal = t.tindakanKoreksi === 'PRESENTASI_OTOMATIS' || t.tindakanKoreksi === 'TIDAK_PERLU';
    items.push({
      findingId: `${t.area}:${t.kode}:${t.transaksiId ?? t.nomorTransaksi ?? i}`,
      sumber: t.area,
      kode: t.kode,
      transaksiId: t.transaksiId,
      nomorTransaksi: t.nomorTransaksi,
      tindakan: tanpaJurnal ? 'TANPA_JURNAL' : 'MANUAL_REVIEW',
      deterministik: false,
      nilaiSebelum: t.saldo === null ? null : { saldo: t.saldo },
      nilaiSesudah: null,
      journalTerkait: null,
      formula: tanpaJurnal ? 'Tidak ada data yang ditulis (dihitung ulang/terbaca deterministik).' : 'Tidak ada formula pasti — tinjau manual; nilai tidak ditebak.',
    });
  });
  return items;
}

/** Tahap 1 — hanya membaca. */
export async function previewKoreksiHistori(opsi: { tanggal?: string } = {}): Promise<ItemPreviewKoreksi[]> {
  return previewDenganDb(await getDb(), opsi.tanggal);
}

export interface PersetujuanKoreksiInput {
  userId: string;
  alasan: string;
  findingIds: string[];
  snapshotSebelum: Record<string, Record<string, unknown> | null>;
  konfirmasi: boolean;
}

/** Tahap 2 — persetujuan eksplisit; menulis audit persetujuan saja. */
export async function approveKoreksiHistori(input: PersetujuanKoreksiInput): Promise<{ correctionId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'edit');
    if (input.konfirmasi !== true) throw new KoreksiHistoriDitolakError('KONFIRMASI_WAJIB', 'Konfirmasi eksplisit wajib.');
    if (!input.alasan?.trim()) throw new KoreksiHistoriDitolakError('ALASAN_WAJIB', 'Alasan koreksi wajib diisi.');
    if (!Array.isArray(input.findingIds) || input.findingIds.length === 0) throw new KoreksiHistoriDitolakError('TEMUAN_WAJIB', 'Pilih minimal satu temuan.');
    const preview = new Map((await kandidatStatusPembalik(db)).map((i) => [i.findingId, i]));
    for (const fid of input.findingIds) {
      const item = preview.get(fid);
      if (!item) throw new KoreksiHistoriDitolakError('TIDAK_DAPAT_DITERAPKAN', `${fid} bukan temuan deterministik yang dapat diterapkan (MANUAL_REVIEW/TANPA_JURNAL/tidak ada).`);
      if (JSON.stringify(input.snapshotSebelum[fid] ?? null) !== JSON.stringify(item.nilaiSebelum)) {
        throw new KoreksiHistoriDitolakError('SNAPSHOT_TIDAK_COCOK', `Snapshot nilai sebelum untuk ${fid} tidak sama dengan data saat ini.`);
      }
    }
    const correctionId = newId();
    const now = new Date();
    await kueri(db).runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sesudah, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(), input.userId, now.toISOString().slice(0, 10), now.toISOString().slice(11, 19), 'HIST_CORRECTION_APPROVE', 'koreksi_histori', correctionId,
      JSON.stringify({ correctionId, userId: input.userId, alasan: input.alasan.trim(), findingIds: input.findingIds, snapshotSebelum: input.snapshotSebelum, konfirmasi: true }),
      now.toISOString()
    );
    return { correctionId };
  });
}

/** Tahap 3 — penerapan atomik atas temuan yang disetujui. */
export async function applyKoreksiHistori(input: { correctionId: string; userId: string }): Promise<{ diterapkan: number }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'edit');
    const q = kueri(db);
    const approval = await q.getFirstAsync<{ data_sesudah: string }>(
      `SELECT data_sesudah FROM audit_log WHERE action = 'HIST_CORRECTION_APPROVE' AND entity = 'koreksi_histori' AND entity_id = ?`, input.correctionId
    );
    if (!approval) throw new KoreksiHistoriDitolakError('BELUM_DISETUJUI', 'Koreksi belum disetujui.');
    const sudah = await q.getFirstAsync<{ id: string }>(
      `SELECT id FROM audit_log WHERE action = 'HIST_CORRECTION_APPLY' AND entity = 'koreksi_histori' AND entity_id = ? LIMIT 1`, input.correctionId
    );
    if (sudah) throw new KoreksiHistoriDitolakError('SUDAH_DITERAPKAN', 'Koreksi ini sudah diterapkan.');
    const data = JSON.parse(approval.data_sesudah) as { alasan: string; findingIds: string[]; snapshotSebelum: Record<string, unknown> };
    const preview = new Map((await kandidatStatusPembalik(db)).map((i) => [i.findingId, i]));
    let diterapkan = 0;
    for (const fid of data.findingIds) {
      const item = preview.get(fid);
      if (!item || item.tindakan !== 'DAPAT_DITERAPKAN') throw new KoreksiHistoriDitolakError('TIDAK_DAPAT_DITERAPKAN', `${fid} tidak lagi dapat diterapkan.`);
      if (JSON.stringify(data.snapshotSebelum[fid] ?? null) !== JSON.stringify(item.nilaiSebelum)) {
        throw new KoreksiHistoriDitolakError('SNAPSHOT_BERUBAH', `Data ${fid} berubah sejak disetujui.`);
      }
      const sesudah = item.nilaiSesudah as { status: string; updated_at: string };
      await q.runAsync(`UPDATE investasi SET status = ?, updated_at = ? WHERE id = ? AND status = 'AKTIF'`, sesudah.status, sesudah.updated_at, item.transaksiId);
      const now = new Date();
      await q.runAsync(
        `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        newId(), input.userId, now.toISOString().slice(0, 10), now.toISOString().slice(11, 19), 'HIST_CORRECTION_APPLY', 'koreksi_histori', input.correctionId,
        JSON.stringify(item.nilaiSebelum),
        JSON.stringify({ correctionId: input.correctionId, userId: input.userId, tanggal: now.toISOString().slice(0, 10), alasan: data.alasan, findingId: fid,
          sumberTemuan: `${item.sumber}:${item.kode}`, transaksiId: item.transaksiId, nilaiSebelum: item.nilaiSebelum, nilaiSesudah: item.nilaiSesudah, journalTerkait: item.journalTerkait }),
        now.toISOString()
      );
      diterapkan += 1;
    }
    return { diterapkan };
  });
}
