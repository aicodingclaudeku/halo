import { getDb } from '@/database/db';
import { getNilaiTercatatInvestasi } from '@/services/InvestasiImpairmentService';
import { SUMBER_PELEPASAN_INVESTASI } from '@/services/PelepasanInvestasiService';
import type { Rupiah } from '@/utils/money';

/**
 * KUERI BACA-SAJA untuk modul "Penerimaan Penarikan Dana Investasi".
 *
 * Tidak ada penulisan, jurnal, atau aturan baru di berkas ini. Seluruh
 * posting tetap lewat `PelepasanInvestasiService` (pratinjau & eksekusi
 * satu penyusun). Berkas ini hanya membaca:
 *  - nilai tercatat investasi (fungsi existing `getNilaiTercatatInvestasi`)
 *  - riwayat & detail transaksi penarikan dari jurnal ber-sumber
 *    `PELEPASAN_INVESTASI` beserta audit_log-nya — tanpa mengubahnya.
 */

export interface NilaiInvestasiTampilan {
  nilaiAwal: Rupiah;
  akumulasiPenyusutan: Rupiah;
  akumulasiImpairment: Rupiah;
  /** v72 — pokok yang sudah ditarik sebagian. */
  totalDitarik: Rupiah;
  nilaiTercatat: Rupiah;
}

export async function getNilaiInvestasiTampilan(investasiId: string, asOfDate?: string): Promise<NilaiInvestasiTampilan> {
  const db = await getDb();
  return getNilaiTercatatInvestasi(db, investasiId, asOfDate);
}

export interface RiwayatPenarikanInvestasiRow {
  journalId: string;
  nomorJurnal: string;
  tanggal: string;
  statusJurnal: string;
  investasiId: string;
  nomorInvestasi: string;
  namaTujuan: string;
  jenisInvestasi: string;
  /** Dana pokok diterima (dari baris penarikan v72, atau audit pelepasan lama). */
  danaDiterima: Rupiah | null;
  /** v72 — SEBAGIAN / SELURUHNYA; null untuk pelepasan lama (= seluruhnya). */
  jenisPenarikan: 'SEBAGIAN' | 'SELURUHNYA' | null;
  bungaDiterima: Rupiah;
  /** Dana pokok + bunga. */
  totalDiterima: Rupiah | null;
}

interface AuditPelepasan {
  hasilPelepasan?: number;
  biayaPerolehan?: number;
  akumulasiPenyusutan?: number;
  akumulasiImpairment?: number;
  nilaiTercatat?: number;
  labaRugi?: number;
  sumberDana?: string | null;
  rekeningAccountId?: string | null;
  keterangan?: string | null;
  userId?: string;
  journalId?: string;
}

function parseAudit(teks: string | null | undefined): AuditPelepasan | null {
  if (!teks) return null;
  try {
    return JSON.parse(teks) as AuditPelepasan;
  } catch {
    return null;
  }
}

export async function listRiwayatPenarikanInvestasi(): Promise<RiwayatPenarikanInvestasiRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT j.id AS journal_id, j.nomor_jurnal, j.tanggal, j.status AS status_jurnal,
            i.id AS investasi_id, i.nomor_investasi, i.nama_tujuan, i.jenis_investasi,
            p.jenis AS jenis_penarikan, p.dana_diterima, p.bunga_diterima, p.journal_bunga_id,
            (SELECT a.data_sesudah FROM audit_log a
              WHERE a.entity = 'investasi' AND a.entity_id = i.id AND a.action IN ('DISPOSE','WITHDRAW')
                AND a.data_sesudah LIKE '%' || j.id || '%'
              ORDER BY a.created_at DESC LIMIT 1) AS audit
       FROM journal j
       JOIN investasi i ON i.id = j.sumber_id
       LEFT JOIN investasi_penarikan p ON p.journal_id = j.id
      WHERE j.sumber_transaksi = ?
      ORDER BY j.tanggal DESC, j.created_at DESC`,
    SUMBER_PELEPASAN_INVESTASI
  );
  return rows.map((r) => {
    const audit = parseAudit(r.audit);
    const dana = typeof r.dana_diterima === 'number' ? r.dana_diterima : typeof audit?.hasilPelepasan === 'number' ? audit.hasilPelepasan : null;
    const bunga = typeof r.bunga_diterima === 'number' ? r.bunga_diterima : 0;
    return {
      journalId: r.journal_id,
      nomorJurnal: r.nomor_jurnal,
      tanggal: r.tanggal,
      statusJurnal: r.status_jurnal,
      investasiId: r.investasi_id,
      nomorInvestasi: r.nomor_investasi,
      namaTujuan: r.nama_tujuan,
      jenisInvestasi: r.jenis_investasi,
      danaDiterima: dana,
      jenisPenarikan: r.jenis_penarikan ?? null,
      bungaDiterima: bunga,
      totalDiterima: dana === null ? null : dana + bunga,
    };
  });
}

export interface DetailPenarikanInvestasi extends RiwayatPenarikanInvestasiRow {
  deskripsi: string;
  nomorReferensi: string | null;
  dicatatOleh: string | null;
  dicatatPada: string;
  nilaiTercatat: Rupiah | null;
  biayaPerolehan: Rupiah | null;
  akumulasiPenyusutan: Rupiah | null;
  akumulasiImpairment: Rupiah | null;
  labaRugi: Rupiah | null;
  keterangan: string | null;
  rekening: string | null;
  baris: { kode: string; nama: string; debit: Rupiah; kredit: Rupiah }[];
  /** v72 — jurnal bunga deposito yang diposting bersama (bila ada). */
  nomorJurnalBunga: string | null;
  barisBunga: { kode: string; nama: string; debit: Rupiah; kredit: Rupiah }[];
}

export async function getDetailPenarikanInvestasi(journalId: string): Promise<DetailPenarikanInvestasi | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<any>(
    `SELECT j.id AS journal_id, j.nomor_jurnal, j.tanggal, j.status AS status_jurnal, j.deskripsi, j.nomor_referensi,
            j.created_at, u.nama AS nama_user,
            i.id AS investasi_id, i.nomor_investasi, i.nama_tujuan, i.jenis_investasi,
            p.jenis AS jenis_penarikan, p.dana_diterima, p.bunga_diterima, p.journal_bunga_id,
            (SELECT a.data_sesudah FROM audit_log a
              WHERE a.entity = 'investasi' AND a.entity_id = i.id AND a.action IN ('DISPOSE','WITHDRAW')
                AND a.data_sesudah LIKE '%' || j.id || '%'
              ORDER BY a.created_at DESC LIMIT 1) AS audit
       FROM journal j
       JOIN investasi i ON i.id = j.sumber_id
       LEFT JOIN investasi_penarikan p ON p.journal_id = j.id
       LEFT JOIN app_user u ON u.id = j.created_by
      WHERE j.id = ? AND j.sumber_transaksi = ?`,
    journalId,
    SUMBER_PELEPASAN_INVESTASI
  );
  if (!r) return null;
  const audit = parseAudit(r.audit);
  const baris = await db.getAllAsync<{ kode: string; nama: string; debit: number; kredit: number }>(
    `SELECT a.kode, a.nama, je.debit, je.kredit
       FROM journal_entry je JOIN account a ON a.id = je.account_id
      WHERE je.journal_id = ?
      ORDER BY je.debit DESC, je.id`,
    journalId
  );
  let barisBunga: { kode: string; nama: string; debit: number; kredit: number }[] = [];
  let nomorJurnalBunga: string | null = null;
  if (r.journal_bunga_id) {
    barisBunga = await db.getAllAsync<{ kode: string; nama: string; debit: number; kredit: number }>(
      `SELECT a.kode, a.nama, je.debit, je.kredit
         FROM journal_entry je JOIN account a ON a.id = je.account_id
        WHERE je.journal_id = ?
        ORDER BY je.debit DESC, je.id`,
      r.journal_bunga_id
    );
    nomorJurnalBunga = (await db.getFirstAsync<{ nomor_jurnal: string }>(`SELECT nomor_jurnal FROM journal WHERE id = ?`, r.journal_bunga_id))?.nomor_jurnal ?? null;
  }
  let rekening: string | null = null;
  if (audit?.rekeningAccountId) {
    const akun = await db.getFirstAsync<{ kode: string; nama: string }>(
      `SELECT kode, nama FROM account WHERE id = ?`,
      audit.rekeningAccountId
    );
    rekening = akun ? `${akun.kode} ${akun.nama}` : null;
  }
  const angka = (v: unknown) => (typeof v === 'number' ? v : null);
  const dana = angka(r.dana_diterima) ?? angka(audit?.hasilPelepasan);
  const bunga = angka(r.bunga_diterima) ?? 0;
  return {
    journalId: r.journal_id,
    nomorJurnal: r.nomor_jurnal,
    tanggal: r.tanggal,
    statusJurnal: r.status_jurnal,
    investasiId: r.investasi_id,
    nomorInvestasi: r.nomor_investasi,
    namaTujuan: r.nama_tujuan,
    jenisInvestasi: r.jenis_investasi,
    danaDiterima: dana,
    jenisPenarikan: r.jenis_penarikan ?? null,
    bungaDiterima: bunga,
    totalDiterima: dana === null ? null : dana + bunga,
    deskripsi: r.deskripsi,
    nomorReferensi: r.nomor_referensi ?? null,
    dicatatOleh: r.nama_user ?? null,
    dicatatPada: r.created_at,
    nilaiTercatat: angka(audit?.nilaiTercatat),
    biayaPerolehan: angka(audit?.biayaPerolehan),
    akumulasiPenyusutan: angka(audit?.akumulasiPenyusutan),
    akumulasiImpairment: angka(audit?.akumulasiImpairment),
    labaRugi: angka(audit?.labaRugi),
    keterangan: audit?.keterangan ?? null,
    rekening,
    baris,
    nomorJurnalBunga,
    barisBunga,
  };
}
