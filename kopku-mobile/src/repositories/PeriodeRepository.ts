import { getDb } from '@/database/db';

export interface AccountingPeriodItem {
  id: string;
  tahunBuku: number;
  periodeMulai: string;
  periodeSelesai: string;
  status: 'OPEN' | 'CLOSED';
}

/** Daftar periode akuntansi untuk picker periode di layar Laporan (PRD §20). */
export async function listAccountingPeriods(): Promise<AccountingPeriodItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT id, tahun_buku, periode_mulai, periode_selesai, status
     FROM accounting_period ORDER BY periode_mulai DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    tahunBuku: r.tahun_buku,
    periodeMulai: r.periode_mulai,
    periodeSelesai: r.periode_selesai,
    status: r.status,
  }));
}

/** Periode aktif (OPEN) yang paling baru — dipakai sebagai default pilihan. */
export async function getDefaultPeriod(): Promise<AccountingPeriodItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT id, tahun_buku, periode_mulai, periode_selesai, status
     FROM accounting_period WHERE status = 'OPEN' ORDER BY periode_mulai DESC LIMIT 1`
  );
  if (!row) return null;
  return {
    id: row.id,
    tahunBuku: row.tahun_buku,
    periodeMulai: row.periode_mulai,
    periodeSelesai: row.periode_selesai,
    status: row.status,
  };
}
