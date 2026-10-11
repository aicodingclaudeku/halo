import { getDb } from '@/database/db';
import { Rupiah } from '@/utils/money';
import { requirePermission } from '@/services/PermissionService';
import { koreksiTransaksiKasBank, JenisRekening } from '@/services/KasBankService';
import { batalkanRAK, kelayakanTarikDanaRAK, getStatusPeriodePembalikRAK } from '@/services/RAKService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { koreksiSimpanan } from '@/services/SimpananService';
import {
  SUMBER_KOREKSI,
  cekSaldoSimpananSetelahKoreksi,
  getJejakKoreksi,
  periksaKoreksiTransaksi,
  type JejakKoreksi,
  type PemeriksaanKoreksi,
} from '@/services/KoreksiTransaksiService';

/**
 * HistoryTransaksiService — SATU service History Transaksi (Phase 18
 * §8, permintaan pengguna): "Gunakan jurnal sebagai sumber audit utama
 * jika memungkinkan". Setiap service transaksi di app ini SUDAH
 * membuat baris `journal` (AccountingEngine.createJournal) untuk
 * setiap transaksi finansial — jadi menyatukan riwayat lewat `journal`
 * (bukan UNION belasan tabel sumber terpisah) secara otomatis
 * mencakup SEMUA jenis transaksi yang menghasilkan jurnal (Simpanan,
 * Tarik Simpanan, Pinjaman, Angsuran, Utang, Pembayaran Utang, Kas,
 * Bank, Investasi, Pembelian Aset, Beban, Modal, Pendapatan/Biaya
 * Dibayar Dimuka, RAK, SHU, Keluar Anggota, dst) TANPA duplikasi &
 * TANPA perlu daftar tabel yang harus di-update manual setiap ada
 * fitur baru — sumber datanya satu, `journal`+`journal_entry`, yang
 * sudah dipakai SEMUA service lain sebagai satu-satunya sumber
 * kebenaran ledger (PRD §19).
 *
 * "nomor transaksi" di sini = `journal.nomor_referensi` (nomor
 * transaksi domain asli, mis. "SIM-2026-000123") kalau ada, fallback
 * ke `journal.nomor_jurnal` (selalu ada) — konsisten dengan cara
 * setiap service domain menyimpan `nomorReferensi` saat createJournal.
 */

export const JENIS_TRANSAKSI_LABEL: Record<string, string> = {
  SIMPANAN_POKOK: 'Setor Simpanan Pokok',
  SIMPANAN_WAJIB: 'Setor Simpanan Wajib',
  SIMPANAN_SUKARELA: 'Simpanan Sukarela (Setor/Tarik)',
  // Perbaikan History Transaksi: fitur "Data Awal Simpanan Anggota"
  // sudah dilebur ke "Setor Simpanan" (SimpananFormScreen), label
  // jenis transaksi untuk kode internal 'SIMPANAN_DATA_AWAL' (TIDAK
  // diganti — masih dipakai untuk filter/pengelompokan) diperbarui
  // supaya konsisten, bukan menampilkan kode mentahnya.
  SIMPANAN_DATA_AWAL: 'Setor Simpanan',
  KELUAR_ANGGOTA: 'Keluar Anggota',
  PENCAIRAN_PINJAMAN: 'Pencairan Pinjaman',
  ANGSURAN_POKOK: 'Angsuran Pinjaman',
  PENGHAPUSAN_PIUTANG: 'Penghapusan Piutang',
  PENYISIHAN_PIUTANG: 'Penyisihan Piutang Tak Tertagih',
  UTANG_BANK: 'Utang Bank (Terima/Bayar)',
  UTANG_PIHAK_LAIN: 'Utang Pihak Lain (Terima/Bayar)',
  UTANG_USAHA: 'Utang Usaha (Bayar)',
  KAS_PENERIMAAN_LAIN: 'Kas — Penerimaan Lain',
  KAS_PENGELUARAN_LAIN: 'Kas — Pengeluaran Lain',
  PAJAK_PENGAKUAN: 'Pengakuan Pajak',
  BANK_PENERIMAAN_LAIN: 'Bank — Penerimaan Lain',
  BANK_PENGELUARAN_LAIN: 'Bank — Pengeluaran Lain',
  TRANSFER_BANK: 'Pemindahan Saldo Rekening',
  SALDO_AWAL_REKENING: 'Saldo Awal Kas/Bank',
  SALDO_AWAL_AKUN: 'Saldo Awal Akun',
  INVESTASI_UNIT_USAHA: 'Investasi — Unit Usaha (histori)',
  INVESTASI_KOPERASI_LAIN: 'Investasi — Koperasi Lain',
  PELEPASAN_INVESTASI: 'Pelepasan Investasi',
  PELEPASAN_ASET_TETAP: 'Pelepasan Aset Tetap',
  RAK: 'Rekening Antar Kantor/Unit (RAKU)', // Poin 10 — label tampilan; kode jenis 'RAK' tidak berubah
  RAK_PENGEMBALIAN_KAS: 'Pengembalian RAK dari Unit Usaha (Kas)',
  RAK_PENGEMBALIAN_BANK: 'Pengembalian RAK dari Unit Usaha (Bank)',
  ASET_TETAP: 'Pembelian Aset Tetap',
  PENYUSUTAN_ASET: 'Penyusutan Aset',
  MODAL_UANG: 'Modal Koperasi — Uang',
  MODAL_BARANG: 'Modal Koperasi — Barang',
  PENDAPATAN_DITERIMA_DIMUKA: 'Pendapatan Diterima Dimuka',
  PENGAKUAN_PENDAPATAN_DIMUKA: 'Pengakuan Pendapatan Dimuka',
  BIAYA_DIBAYAR_DIMUKA: 'Biaya Dibayar Dimuka',
  PENGAKUAN_BIAYA_DIMUKA: 'Pengakuan Biaya Dibayar Dimuka',
  SHU_DISTRIBUSI: 'Distribusi SHU',
  // S21 — dibedakan dari pencairan normal supaya riwayat anggota &
  // filter laporan dapat menunjukkan penarikan sebelum jatuh tempo
  // secara eksplisit, bukan tenggelam sebagai "pencairan" biasa.
  SIMPANAN_BERJANGKA: 'Setor Simpanan Berjangka',
  SIMPANAN_BERJANGKA_BUNGA_AKRUAL: 'Akrual Bunga Simpanan Berjangka',
  SIMPANAN_SUKARELA_BUNGA: 'Bunga Simpanan Sukarela',
  SIMPANAN_BERJANGKA_PENCAIRAN: 'Pencairan Simpanan Berjangka',
  SIMPANAN_BERJANGKA_PENCAIRAN_DINI: 'Pencairan Dini Simpanan Berjangka',
  BEBAN_LAINNYA: 'Beban',
};

export function labelJenisTransaksi(sumberTransaksi: string): string {
  return JENIS_TRANSAKSI_LABEL[sumberTransaksi] ?? sumberTransaksi;
}

/**
 * Rute domain yang SUDAH punya layar koreksi (edit/batal) sendiri —
 * History Transaksi TIDAK menduplikasi logika koreksi, cukup
 * mengarahkan ke layar yang sudah ada & sudah teruji (§9: "gunakan
 * mekanisme correction/reversal yang sesuai accounting engine
 * existing"). Jenis transaksi yang TIDAK ada di sini masih bisa
 * dilihat detailnya secara lengkap, hanya tombol Edit/Delete-nya
 * dinonaktifkan dengan alasan yang jelas (§9/§10) — bukan disembunyikan
 * atau pura-pura berhasil.
 */
const ROUTABLE_SOURCE_TABLE: Record<string, { table: string; jenisRekening?: 'KAS' | 'BANK' }> = {
  KAS_PENERIMAAN_LAIN: { table: 'kas_transaksi', jenisRekening: 'KAS' },
  KAS_PENGELUARAN_LAIN: { table: 'kas_transaksi', jenisRekening: 'KAS' },
  BANK_PENERIMAAN_LAIN: { table: 'bank_transaksi', jenisRekening: 'BANK' },
  BANK_PENGELUARAN_LAIN: { table: 'bank_transaksi', jenisRekening: 'BANK' },
  RAK: { table: 'rak_transaksi' },
  // Pengembalian RAKU — baris kas/bank biasa; koreksi = reversal existing (koreksiTransaksiKasBank).
  RAK_PENGEMBALIAN_KAS: { table: 'kas_transaksi', jenisRekening: 'KAS' },
  RAK_PENGEMBALIAN_BANK: { table: 'bank_transaksi', jenisRekening: 'BANK' },
  SIMPANAN_POKOK: { table: 'simpanan_transaksi' },
  SIMPANAN_WAJIB: { table: 'simpanan_transaksi' },
  SIMPANAN_SUKARELA: { table: 'simpanan_transaksi' },
};

export interface HistoryTransaksiRow {
  /** RC-S54 T16 #20. */
  operasiInvestasi: 'PELEPASAN_INVESTASI' | 'KOREKSI_SALAH_INPUT' | null;
  /** RC-S54 T16 GAP 6. */
  operasiAsetTetap: 'PELEPASAN_ASET_TETAP' | 'KOREKSI_SALAH_INPUT' | null;
  /** RC-S54 T16 GAP 1: jurnal.sumber_id (pelepasan -> id investasi). */
  sumberId: string | null;
  journalId: string;
  /** Jurnal yang dibalik oleh jurnal ini (NULL = bukan pembalik). Hanya-baca, untuk penanda tampilan. */
  reversalOfId: string | null;
  nomorTransaksi: string;
  tanggal: string;
  jenisTransaksi: string;
  jenisLabel: string;
  deskripsi: string;
  nominal: Rupiah;
  status: 'DRAFT' | 'POSTED' | 'VOID' | 'REVERSED';
  createdBy: string;
  createdByNama: string | null;
  periodeStatus: 'OPEN' | 'CLOSED' | null;
}

export interface HistoryTransaksiFilter {
  search?: string;
  tanggalMulai?: string;
  tanggalSelesai?: string;
  jenis?: string[];
  status?: HistoryTransaksiRow['status'][];
  accountId?: string;
  limit?: number;
}

/**
 * RC-S54 T16 #20 — membedakan dua operasi investasi yang berbeda makna:
 * PELEPASAN_INVESTASI (jurnal pelepasan) vs KOREKSI_SALAH_INPUT (jurnal
 * pembalik atas penempatan INVESTASI_*). Jurnal lain -> null.
 */
const SUMBER_PEROLEHAN_ASET: readonly string[] = ['ASET_TETAP', 'ASET_TAK_BERWUJUD'];

/** RC-S54 T16 GAP 6 — pelepasan aset tetap vs koreksi salah input pembelian aset. */
export function operasiAsetTetapDariJurnal(sumberTransaksi: string, reversalOfId: string | null | undefined): 'PELEPASAN_ASET_TETAP' | 'KOREKSI_SALAH_INPUT' | null {
  if (sumberTransaksi === 'PELEPASAN_ASET_TETAP') return 'PELEPASAN_ASET_TETAP';
  if (SUMBER_PEROLEHAN_ASET.includes(sumberTransaksi) && reversalOfId) return 'KOREKSI_SALAH_INPUT';
  return null;
}

export function operasiInvestasiDariJurnal(sumberTransaksi: string, reversalOfId: string | null | undefined): 'PELEPASAN_INVESTASI' | 'KOREKSI_SALAH_INPUT' | null {
  if (sumberTransaksi === 'PELEPASAN_INVESTASI') return 'PELEPASAN_INVESTASI';
  if (sumberTransaksi.startsWith('INVESTASI_') && reversalOfId) return 'KOREKSI_SALAH_INPUT';
  return null;
}

function rowToHistory(r: any): HistoryTransaksiRow {
  return {
    operasiInvestasi: operasiInvestasiDariJurnal(r.sumber_transaksi, r.reversal_of_id),
    operasiAsetTetap: operasiAsetTetapDariJurnal(r.sumber_transaksi, r.reversal_of_id),
    journalId: r.id,
    nomorTransaksi: r.nomor_referensi || r.nomor_jurnal,
    tanggal: r.tanggal,
    jenisTransaksi: r.sumber_transaksi,
    // RC-S54 T16 GAP 1: pembalik atas penempatan investasi disajikan sebagai Koreksi Salah Input, bukan reversal generik.
    jenisLabel:
      operasiInvestasiDariJurnal(r.sumber_transaksi, r.reversal_of_id) === 'KOREKSI_SALAH_INPUT' ||
      operasiAsetTetapDariJurnal(r.sumber_transaksi, r.reversal_of_id) === 'KOREKSI_SALAH_INPUT'
        ? `Koreksi Salah Input — ${labelJenisTransaksi(r.sumber_transaksi)}`
        : labelJenisTransaksi(r.sumber_transaksi),
    /** Tautan sumber (id investasi untuk Pelepasan Investasi). */
    sumberId: r.sumber_id ?? null,
    reversalOfId: r.reversal_of_id ?? null,
    deskripsi: r.deskripsi,
    nominal: r.nominal ?? 0,
    status: r.status,
    createdBy: r.created_by,
    createdByNama: r.created_by_nama ?? null,
    periodeStatus: r.periode_status ?? null,
  };
}

/** Daftar riwayat transaksi (search/filter) — §8/§9/§10. Diurutkan terbaru dulu. */
export async function listHistoryTransaksi(filter: HistoryTransaksiFilter = {}): Promise<HistoryTransaksiRow[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.search && filter.search.trim()) {
    where.push('(j.deskripsi LIKE ? OR j.nomor_referensi LIKE ? OR j.nomor_jurnal LIKE ?)');
    const s = `%${filter.search.trim()}%`;
    params.push(s, s, s);
  }
  if (filter.tanggalMulai) {
    where.push('j.tanggal >= ?');
    params.push(filter.tanggalMulai);
  }
  if (filter.tanggalSelesai) {
    where.push('j.tanggal <= ?');
    params.push(filter.tanggalSelesai);
  }
  if (filter.jenis && filter.jenis.length > 0) {
    where.push(`j.sumber_transaksi IN (${filter.jenis.map(() => '?').join(',')})`);
    params.push(...filter.jenis);
  }
  if (filter.status && filter.status.length > 0) {
    where.push(`j.status IN (${filter.status.map(() => '?').join(',')})`);
    params.push(...filter.status);
  }
  if (filter.accountId) {
    where.push('EXISTS (SELECT 1 FROM journal_entry je2 WHERE je2.journal_id = j.id AND je2.account_id = ?)');
    params.push(filter.accountId);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 300;

  const rows = await db.getAllAsync<any>(
    `SELECT j.id, j.nomor_jurnal, j.nomor_referensi, j.tanggal, j.sumber_transaksi, j.deskripsi, j.reversal_of_id, j.sumber_id,
            j.status, j.created_by, u.nama as created_by_nama, ap.status as periode_status,
            (SELECT COALESCE(SUM(je.debit), 0) FROM journal_entry je WHERE je.journal_id = j.id) as nominal
     FROM journal j
     LEFT JOIN app_user u ON u.id = j.created_by
     LEFT JOIN accounting_period ap ON ap.id = j.period_id
     ${whereClause}
     ORDER BY j.tanggal DESC, j.created_at DESC
     LIMIT ?`,
    ...params,
    limit
  );
  return rows.map(rowToHistory);
}

/** Jenis transaksi yang benar-benar ada di database (untuk chip filter) — bukan daftar hardcode statis, jadi otomatis mengikuti data sungguhan. */
export async function listJenisTransaksiTersedia(): Promise<{ jenis: string; label: string }[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ sumber_transaksi: string }>(
    `SELECT DISTINCT sumber_transaksi FROM journal ORDER BY sumber_transaksi ASC`
  );
  return rows.map((r) => ({ jenis: r.sumber_transaksi, label: labelJenisTransaksi(r.sumber_transaksi) }));
}

export interface HistoryJournalLine {
  accountId: string;
  kodeAkun: string;
  namaAkun: string;
  debit: Rupiah;
  kredit: Rupiah;
  keterangan: string | null;
}

export interface HistoryTransaksiDetail extends HistoryTransaksiRow {
  lines: HistoryJournalLine[];
  reversalOfId: string | null;
  reversedById: string | null;
  canEdit: boolean;
  canDelete: boolean;
  aksiTidakTersediaAlasan: string | null;
  sumberRute: { table: string; id: string; jenisRekening?: 'KAS' | 'BANK' } | null;
  /**
   * RC-S133.6.2 — jalur koreksi khusus (setoran simpanan, pencairan pinjaman,
   * angsuran): hasil pemeriksaan beserta data asalnya. null bila jenis
   * transaksi ini tidak memakai jalur tersebut. Tombol "Koreksi Transaksi"
   * tampil bila `koreksiKhusus.boleh`.
   */
  koreksiKhusus?: PemeriksaanKoreksi | null;
  /** RC-S133.6.2 — koreksi yang menyangkut jurnal ini (asal/pembalik/pengganti). */
  jejakKoreksi?: JejakKoreksi[];
}

/**
 * Detail satu transaksi (§8: "Detail") — header jurnal + seluruh baris
 * debit/kredit (mirip Buku Besar untuk satu jurnal), DITAMBAH status
 * boleh/tidaknya diedit/dihapus & alasannya (§9/§10) — dihitung SEKALI
 * di sini (bukan di listHistoryTransaksi, supaya daftar tetap ringan
 * untuk banyak baris; lihat komentar listHistoryTransaksi).
 */
export async function getHistoryDetail(journalId: string): Promise<HistoryTransaksiDetail | null> {
  const db = await getDb();
  const header = await db.getFirstAsync<any>(
    `SELECT j.id, j.nomor_jurnal, j.nomor_referensi, j.tanggal, j.sumber_transaksi, j.deskripsi, j.reversal_of_id, j.sumber_id,
            j.status, j.created_by, j.reversal_of_id, j.reversed_by_id, u.nama as created_by_nama,
            ap.status as periode_status,
            (SELECT COALESCE(SUM(je.debit), 0) FROM journal_entry je WHERE je.journal_id = j.id) as nominal
     FROM journal j
     LEFT JOIN app_user u ON u.id = j.created_by
     LEFT JOIN accounting_period ap ON ap.id = j.period_id
     WHERE j.id = ?`,
    journalId
  );
  if (!header) return null;

  const lineRows = await db.getAllAsync<any>(
    `SELECT je.account_id, a.kode as kode_akun, a.nama as nama_akun, je.debit, je.kredit, je.keterangan
     FROM journal_entry je JOIN account a ON a.id = je.account_id
     WHERE je.journal_id = ?
     ORDER BY je.urutan ASC, je.debit DESC`,
    journalId
  );
  const lines: HistoryJournalLine[] = lineRows.map((l) => ({
    accountId: l.account_id,
    kodeAkun: l.kode_akun,
    namaAkun: l.nama_akun,
    debit: l.debit,
    kredit: l.kredit,
    keterangan: l.keterangan,
  }));

  // §9/§10: tentukan boleh/tidaknya edit & hapus, dengan alasan JUJUR
  // kalau tidak — bukan disembunyikan begitu saja.
  let canEdit = true;
  let canDelete = true;
  let alasan: string | null = null;
  let sumberRute: HistoryTransaksiDetail['sumberRute'] = null;
  let koreksiKhusus: PemeriksaanKoreksi | null = null;

  if (header.status !== 'POSTED') {
    canEdit = false;
    canDelete = false;
    alasan =
      header.status === 'REVERSED'
        ? 'Transaksi ini sudah pernah dikoreksi/dibatalkan sebelumnya.'
        : header.status === 'VOID'
        ? 'Transaksi ini sudah dibatalkan (VOID).'
        : 'Transaksi ini masih berstatus draft (belum diposting).';
  } else if (header.periode_status === 'CLOSED' && header.sumber_transaksi !== 'RAK') {
    // RC-S54 T14 — POLICY-A (#19): khusus RAK, periode ASAL CLOSED tidak
    // otomatis menolak; kelayakan RAK diputuskan `kelayakanTarikDanaRAK` di
    // bawah (sama dengan RAKList & service). Jenis lain tetap aturan ini.
    canEdit = false;
    canDelete = false;
    alasan = 'Transaksi ini berada pada periode akuntansi yang sudah ditutup (CLOSED).';
  } else if (header.sumber_transaksi === 'SHU_DISTRIBUSI') {
    canEdit = false;
    canDelete = false;
    alasan = 'Distribusi SHU bersifat final setelah dibagikan dan tidak dapat diubah dari sini.';
  } else {
    const route = ROUTABLE_SOURCE_TABLE[header.sumber_transaksi as string];
    if (route?.table === 'rak_transaksi' && header.reversal_of_id) {
      // RC-S54 T13 (#19): jurnal pembalik Tarik Dana RAK tidak mempunyai
      // baris rak_transaksi sendiri (baris asal menunjuk jurnal asal).
      // Sebelumnya jatuh ke pesan "data asal tidak ditemukan / tidak
      // konsisten" — keliru. Tetap tanpa aksi: pembalik tidak dibalik lagi.
      canEdit = false;
      canDelete = false;
      alasan = 'Jurnal ini adalah pembalik (Tarik Dana RAKU) atas transaksi RAKU asal dan tidak dapat dikoreksi lagi.';
    } else if (!route && SUMBER_KOREKSI[header.sumber_transaksi as string]) {
      // RC-S133.6.2 — setoran simpanan / pencairan / angsuran: pembalikan +
      // pencatatan ulang dengan jejak audit (KoreksiTransaksiService). Tombol
      // Batalkan biasa TIDAK dipakai untuk jenis ini.
      canEdit = false;
      canDelete = false;
      if (header.reversal_of_id) {
        alasan = 'Jurnal ini adalah jurnal pembalik hasil koreksi dan tidak dikoreksi lagi.';
      } else {
        koreksiKhusus = await periksaKoreksiTransaksi(db, journalId);
        alasan = koreksiKhusus && !koreksiKhusus.boleh ? `Koreksi tidak dapat dilakukan: ${koreksiKhusus.alasanTolak.join(' ')}` : null;
      }
    } else if (!route) {
      canEdit = false;
      canDelete = false;
      alasan = 'Belum ada jalur koreksi khusus untuk jenis transaksi ini — buka menu asal transaksi tersebut untuk melakukan penyesuaian.';
    } else {
      const sourceRow = await db.getFirstAsync<{
        id: string; status?: string; tipe?: string; tanggal?: string; nomor_rak?: string; journal_id?: string | null;
      }>(
        `SELECT id${route.table === 'rak_transaksi' ? ', status, tanggal, nomor_rak, journal_id' : ''}${
          route.table === 'kas_transaksi' || route.table === 'bank_transaksi' || route.table === 'simpanan_transaksi' ? ', tipe' : ''
        } FROM ${route.table} WHERE journal_id = ?`,
        journalId
      );
      // RC-S54 T14 — POLICY-A/B: keputusan RAK dari fungsi yang sama dengan
      // RAKList & service (periode pembalik = hari ini; asal masa depan ditolak).
      const kelayakanRak =
        sourceRow && route.table === 'rak_transaksi'
          ? kelayakanTarikDanaRAK(
              {
                status: sourceRow.status ?? '',
                journalId: sourceRow.journal_id ?? null,
                tanggal: sourceRow.tanggal ?? '',
                nomorRak: sourceRow.nomor_rak ?? '',
              },
              getTanggalLokalHariIni(),
              await getStatusPeriodePembalikRAK(db)
            )
          : null;
      const alasanTolakRak = kelayakanRak && kelayakanRak.kode !== 'BOLEH' ? kelayakanRak.alasan : null;
      if (!sourceRow) {
        canEdit = false;
        canDelete = false;
        alasan = 'Data transaksi asal tidak ditemukan (kemungkinan data lama/tidak konsisten).';
      } else if (sourceRow.status === 'DIBATALKAN') {
        canEdit = false;
        canDelete = false;
        alasan = 'Transaksi ini sudah dibatalkan.';
      } else if (alasanTolakRak) {
        canEdit = false;
        canDelete = false;
        alasan = alasanTolakRak;
      } else if (sourceRow.tipe === 'KOREKSI') {
        canEdit = false;
        canDelete = false;
        alasan = 'Baris ini adalah hasil koreksi transaksi lain, tidak bisa dikoreksi lagi.';
      } else {
        sumberRute = { table: route.table, id: sourceRow.id, jenisRekening: route.jenisRekening };
        // RC-S133.6.2 — setoran simpanan yang sudah diikuti penarikan: pembatalan
        // akan membuat saldo simpanan negatif -> tombol tidak ditawarkan.
        if (route.table === 'simpanan_transaksi' && sourceRow.tipe === 'SETOR') {
          const anggota = await db.getFirstAsync<{ anggota_id: string }>(
            `SELECT anggota_id FROM simpanan_transaksi WHERE id = ?`,
            sourceRow.id
          );
          const negatif = anggota
            ? await cekSaldoSimpananSetelahKoreksi(db, anggota.anggota_id, new Set([sourceRow.id]), [])
            : null;
          if (negatif) {
            canEdit = false;
            canDelete = false;
            alasan = `Tidak dapat dibatalkan: ${negatif}`;
            sumberRute = null;
          }
        }
      }
    }
  }

  return {
    ...rowToHistory(header),
    lines,
    reversalOfId: header.reversal_of_id,
    reversedById: header.reversed_by_id,
    canEdit,
    canDelete,
    aksiTidakTersediaAlasan: alasan,
    sumberRute,
    koreksiKhusus,
    jejakKoreksi: await getJejakKoreksi(db, journalId),
  };
}

/**
 * Batalkan/koreksi transaksi (§10 — "gunakan reversal/correction,
 * bukan DELETE mentah") LANGSUNG dari History Transaksi. Ini BUKAN
 * implementasi koreksi baru — murni ROUTER tipis yang memanggil fungsi
 * service domain yang SUDAH ADA & SUDAH menjalankan reversal jurnal
 * lewat AccountingEngine.reverseJournal() (koreksiTransaksiKasBank /
 * batalkanRAK / koreksiSimpanan) — supaya baris di tabel sumber
 * (kas_transaksi/bank_transaksi/rak_transaksi/simpanan_transaksi) ikut
 * konsisten diperbarui persis seperti kalau pengguna melakukannya dari
 * layar asal masing-masing, TIDAK ada state ganda/menyimpang.
 * `getHistoryDetail()` HARUS dipanggil dulu untuk mendapatkan
 * `sumberRute` & memastikan `canDelete === true` sebelum memanggil ini
 * (UI mengikuti pola ini — lihat HistoryTransaksiDetailScreen.tsx).
 */
export async function batalkanTransaksiHistory(
  sumberRute: { table: string; id: string; jenisRekening?: 'KAS' | 'BANK' },
  userId: string,
  alasan: string
): Promise<void> {
  if (!alasan.trim()) throw new Error('Alasan pembatalan wajib diisi.');

  // Gerbang izin KHUSUS History Transaksi (§26: "history_transaksi
  // edit/delete") — LAPISAN TAMBAHAN di atas permission resource
  // domain asli (kas_bank/rak/simpanan) yang tetap dicek sendiri oleh
  // fungsi yang dipanggil di bawah. Jadi admin bisa membatasi siapa
  // yang boleh memakai jalan pintas koreksi lewat History Transaksi
  // secara terpisah dari izin domain masing-masing.
  const db = await getDb();
  await requirePermission(db, userId, 'history_transaksi', 'edit');

  switch (sumberRute.table) {
    case 'kas_transaksi':
    case 'bank_transaksi': {
      const jenis: JenisRekening = sumberRute.jenisRekening ?? (sumberRute.table === 'bank_transaksi' ? 'BANK' : 'KAS');
      await koreksiTransaksiKasBank(jenis, sumberRute.id, userId, alasan);
      return;
    }
    case 'rak_transaksi':
      await batalkanRAK(sumberRute.id, userId, alasan);
      return;
    case 'simpanan_transaksi':
      await koreksiSimpanan(sumberRute.id, userId, alasan);
      return;
    default:
      throw new Error('Jenis transaksi ini belum punya jalur koreksi otomatis.');
  }
}
