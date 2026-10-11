import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah, roundToRupiah } from '@/utils/money';
import { toPeriode, tanggalAkhirPeriode, selisihBulan, isValidPeriode } from '@/accounting/PeriodeUtil';

/**
 * Pendapatan Diterima Dimuka (sub-fitur Penerimaan) — terhubung ke
 * data anggota (dipilih lewat AnggotaPicker yang sudah ada) dan
 * dicatat dengan jangka waktu (bulan). Pengakuan pendapatan bertahap
 * tiap bulan (di bagian bawah file ini) memakai pola yang SAMA PERSIS
 * dengan PenyusutanService.ts: register terpisah (tabel
 * pendapatan_dimuka_pengakuan) dengan UNIQUE(pendapatan_dimuka_id,
 * periode) sebagai pengaman anti-duplikasi di level database.
 */

export interface TerimaPendapatanDimukaInput {
  anggotaId: string;
  jumlah: Rupiah;
  jangkaWaktuBulan: number;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  createdBy: string;
}

/** DEBIT Kas/Bank, KREDIT Pendapatan Diterima Dimuka. */
export async function terimaPendapatanDimuka(input: TerimaPendapatanDimukaInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    const anggota = await db.getFirstAsync<{ nama_lengkap: string }>(
      `SELECT nama_lengkap FROM anggota WHERE id = ?`,
      input.anggotaId
    );
    if (!anggota) throw new Error('Anggota tidak ditemukan.');

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const pendapatanDimukaAccountId = await resolveAccountId(db, 'PENDAPATAN_DITERIMA_DIMUKA', 'KREDIT_DEFAULT');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'PDM', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'PENDAPATAN_DITERIMA_DIMUKA',
      nomorReferensi: nomorTransaksi,
      deskripsi: `Pendapatan diterima dimuka dari ${anggota.nama_lengkap} (${input.jangkaWaktuBulan} bulan) - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: kasBankAccountId, debit: input.jumlah, kredit: 0 },
        { accountId: pendapatanDimukaAccountId, debit: 0, kredit: input.jumlah },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO pendapatan_diterima_dimuka
        (id, nomor_transaksi, anggota_id, jumlah, jangka_waktu_bulan, tanggal, sumber_dana, bank_account_id, status, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      nomorTransaksi,
      input.anggotaId,
      input.jumlah,
      input.jangkaWaktuBulan,
      input.tanggal,
      input.sumberDana,
      input.bankAccountId ?? null,
      'AKTIF',
      journalId,
      input.createdBy,
      now
    );

    return { id, nomorTransaksi, journalId };
  });
}

export interface PendapatanDimukaListItem {
  id: string;
  nomorTransaksi: string;
  anggotaId: string;
  namaAnggota: string;
  jumlah: Rupiah;
  jangkaWaktuBulan: number;
  tanggal: string;
  status: 'AKTIF' | 'SELESAI';
}

/** Daftar pendapatan diterima dimuka — untuk layar riwayat/register. */
export async function listPendapatanDimuka(): Promise<PendapatanDimukaListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT p.*, a.nama_lengkap
     FROM pendapatan_diterima_dimuka p JOIN anggota a ON a.id = p.anggota_id
     ORDER BY p.tanggal DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    nomorTransaksi: r.nomor_transaksi,
    anggotaId: r.anggota_id,
    namaAnggota: r.nama_lengkap,
    jumlah: r.jumlah,
    jangkaWaktuBulan: r.jangka_waktu_bulan,
    tanggal: r.tanggal,
    status: r.status,
  }));
}

// ============================================================
// PENGAKUAN PENDAPATAN BULANAN (garis lurus, sama polanya dengan
// PenyusutanService.ts) — dijalankan manual dipicu dari UI per
// periode, BUKAN cron/background job (app ini offline-first tanpa
// server).
//
// Rumus: nilai pengakuan bulanan = jumlah pendapatan dimuka / jangka waktu (bulan).
// Jurnal per periode per baris pendapatan dimuka:
//   DEBIT  Pendapatan Diterima Dimuka
//   KREDIT Pendapatan
//
// Setelah bulan TERAKHIR (urutan_bulan == jangka_waktu_bulan) berhasil
// diproses, status baris pendapatan_diterima_dimuka diubah jadi
// SELESAI — sekali saja, dalam transaksi yang sama dengan jurnalnya.
// ============================================================

export interface PengakuanDimukaRow {
  id: string;
  pendapatanDimukaId: string;
  namaAnggota: string;
  nomorTransaksi: string;
  periode: string;
  urutanBulan: number;
  tanggal: string;
  nilaiPengakuan: Rupiah;
  journalId: string;
  nomorJurnal: string | null;
}

/** Hitung nilai pengakuan bulanan garis lurus. */
export function hitungPengakuanBulanan(jumlah: Rupiah, jangkaWaktuBulan: number): Rupiah {
  if (jangkaWaktuBulan <= 0) return 0;
  return roundToRupiah(jumlah / jangkaWaktuBulan);
}

/** Indeks bulan ke berapa (0-based) periode ini dari bulan penerimaan dana. */
function indeksBulanPengakuan(tanggalTerima: string, periode: string): number {
  return selisihBulan(toPeriode(tanggalTerima), periode);
}

export type StatusPengakuanDimuka = 'BELUM_MULAI' | 'SUDAH_DIPROSES' | 'SIAP_DIPROSES' | 'SELESAI';

export interface StatusPengakuanDimukaItem {
  pendapatanDimukaId: string;
  namaAnggota: string;
  nomorTransaksi: string;
  jumlah: Rupiah;
  jangkaWaktuBulan: number;
  nilaiPengakuanBulanan: Rupiah;
  status: StatusPengakuanDimuka;
}

/** Status tiap baris pendapatan dimuka untuk satu periode — dasar layar "Status Periode". */
export async function getStatusPengakuanPeriode(periode: string): Promise<StatusPengakuanDimukaItem[]> {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT p.*, a.nama_lengkap
     FROM pendapatan_diterima_dimuka p JOIN anggota a ON a.id = p.anggota_id
     ORDER BY p.tanggal ASC`
  );
  const sudahDiproses = await db.getAllAsync<{ pendapatan_dimuka_id: string }>(
    `SELECT pendapatan_dimuka_id FROM pendapatan_dimuka_pengakuan WHERE periode = ?`,
    periode
  );
  const sudahDiprosesSet = new Set(sudahDiproses.map((r) => r.pendapatan_dimuka_id));

  return rows.map((r) => {
    const idx = indeksBulanPengakuan(r.tanggal, periode);
    let status: StatusPengakuanDimuka;
    if (idx < 0) status = 'BELUM_MULAI';
    else if (sudahDiprosesSet.has(r.id)) status = 'SUDAH_DIPROSES';
    else if (idx < r.jangka_waktu_bulan) status = 'SIAP_DIPROSES';
    else status = 'SELESAI';

    return {
      pendapatanDimukaId: r.id,
      namaAnggota: r.nama_lengkap,
      nomorTransaksi: r.nomor_transaksi,
      jumlah: r.jumlah,
      jangkaWaktuBulan: r.jangka_waktu_bulan,
      nilaiPengakuanBulanan: hitungPengakuanBulanan(r.jumlah, r.jangka_waktu_bulan),
      status,
    };
  });
}

/**
 * Proses pengakuan SATU baris pendapatan dimuka untuk SATU periode.
 * Idempoten: kalau periode ini sudah diproses, return baris yang
 * sudah ada (bukan bikin baru).
 */
export async function prosesPengakuanPendapatanDimuka(params: {
  pendapatanDimukaId: string;
  periode: string;
  createdBy: string;
}): Promise<{ dibuat: boolean; row: PengakuanDimukaRow; menyelesaikan: boolean }> {
  if (!isValidPeriode(params.periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');

  return withTransaction(async (db) => {
    await requirePermission(db, params.createdBy, 'kas_bank', 'create');

    // Lapis 1 anti-duplikasi: cek dulu sebelum kerja apa pun.
    const existing = await db.getFirstAsync<any>(
      `SELECT pp.*, j.nomor_jurnal, a.nama_lengkap, p.nomor_transaksi
       FROM pendapatan_dimuka_pengakuan pp
       JOIN journal j ON j.id = pp.journal_id
       JOIN pendapatan_diterima_dimuka p ON p.id = pp.pendapatan_dimuka_id
       JOIN anggota a ON a.id = p.anggota_id
       WHERE pp.pendapatan_dimuka_id = ? AND pp.periode = ?`,
      params.pendapatanDimukaId,
      params.periode
    );
    if (existing) {
      return {
        dibuat: false,
        menyelesaikan: false,
        row: {
          id: existing.id,
          pendapatanDimukaId: existing.pendapatan_dimuka_id,
          namaAnggota: existing.nama_lengkap,
          nomorTransaksi: existing.nomor_transaksi,
          periode: existing.periode,
          urutanBulan: existing.urutan_bulan,
          tanggal: existing.tanggal,
          nilaiPengakuan: existing.nilai_pengakuan,
          journalId: existing.journal_id,
          nomorJurnal: existing.nomor_jurnal,
        },
      };
    }

    const dimuka = await db.getFirstAsync<any>(
      `SELECT p.*, a.nama_lengkap
       FROM pendapatan_diterima_dimuka p JOIN anggota a ON a.id = p.anggota_id
       WHERE p.id = ?`,
      params.pendapatanDimukaId
    );
    if (!dimuka) throw new Error('Data pendapatan diterima dimuka tidak ditemukan.');
    if (dimuka.status === 'SELESAI') {
      throw new Error(`Pendapatan dimuka dari ${dimuka.nama_lengkap} sudah SELESAI diakui seluruhnya.`);
    }

    const idx = indeksBulanPengakuan(dimuka.tanggal, params.periode);
    if (idx < 0) {
      throw new Error(
        `Pendapatan dimuka dari ${dimuka.nama_lengkap} baru diterima pada ${dimuka.tanggal} — periode ${params.periode} sebelum tanggal itu.`
      );
    }
    if (idx >= dimuka.jangka_waktu_bulan) {
      throw new Error(
        `Pendapatan dimuka dari ${dimuka.nama_lengkap} sudah melewati jangka waktu (${dimuka.jangka_waktu_bulan} bulan) — tidak ada lagi pengakuan untuk periode ${params.periode}.`
      );
    }

    const nilaiPengakuan = hitungPengakuanBulanan(dimuka.jumlah, dimuka.jangka_waktu_bulan);
    if (nilaiPengakuan <= 0) {
      throw new Error(`Pendapatan dimuka dari ${dimuka.nama_lengkap} tidak memiliki nilai pengakuan.`);
    }

    const dimukaAccountId = await resolveAccountId(db, 'PENGAKUAN_PENDAPATAN_DIMUKA', 'DEBIT_DIMUKA');
    const pendapatanAccountId = await resolveAccountId(db, 'PENGAKUAN_PENDAPATAN_DIMUKA', 'KREDIT_PENDAPATAN');
    const tanggal = tanggalAkhirPeriode(params.periode);
    const urutanBulan = idx + 1;

    const year = new Date(tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'PGK', year);

    const { journalId, nomorJurnal } = await createJournal(db, {
      tanggal,
      sumberTransaksi: 'PENGAKUAN_PENDAPATAN_DIMUKA',
      sumberId: dimuka.id,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Pengakuan pendapatan dimuka ${dimuka.nama_lengkap} bulan ke-${urutanBulan}/${dimuka.jangka_waktu_bulan} periode ${params.periode} - ${nomorTransaksi}`,
      createdBy: params.createdBy,
      lines: [
        { accountId: dimukaAccountId, debit: nilaiPengakuan, kredit: 0 },
        { accountId: pendapatanAccountId, debit: 0, kredit: nilaiPengakuan },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    // Lapis 2 anti-duplikasi: UNIQUE(pendapatan_dimuka_id, periode) —
    // kalau race condition, INSERT gagal & seluruh transaksi (termasuk
    // jurnal di atas) rollback otomatis.
    await db.runAsync(
      `INSERT INTO pendapatan_dimuka_pengakuan
        (id, pendapatan_dimuka_id, periode, urutan_bulan, tanggal, nilai_pengakuan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id,
      params.pendapatanDimukaId,
      params.periode,
      urutanBulan,
      tanggal,
      nilaiPengakuan,
      journalId,
      params.createdBy,
      now
    );

    const menyelesaikan = urutanBulan >= dimuka.jangka_waktu_bulan;
    if (menyelesaikan) {
      await db.runAsync(`UPDATE pendapatan_diterima_dimuka SET status = 'SELESAI' WHERE id = ?`, params.pendapatanDimukaId);
    }

    return {
      dibuat: true,
      menyelesaikan,
      row: {
        id,
        pendapatanDimukaId: params.pendapatanDimukaId,
        namaAnggota: dimuka.nama_lengkap,
        nomorTransaksi: dimuka.nomor_transaksi,
        periode: params.periode,
        urutanBulan,
        tanggal,
        nilaiPengakuan,
        journalId,
        nomorJurnal,
      },
    };
  });
}

export interface HasilBatchPengakuan {
  periode: string;
  diproses: PengakuanDimukaRow[];
  dilewati: { pendapatanDimukaId: string; namaAnggota: string; alasan: string }[];
}

/** Jalankan pengakuan untuk SEMUA baris pendapatan dimuka yang siap diproses pada satu periode. */
export async function jalankanPengakuanPeriode(periode: string, createdBy: string): Promise<HasilBatchPengakuan> {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
  const status = await getStatusPengakuanPeriode(periode);
  const diproses: PengakuanDimukaRow[] = [];
  const dilewati: { pendapatanDimukaId: string; namaAnggota: string; alasan: string }[] = [];

  for (const item of status) {
    if (item.status === 'SUDAH_DIPROSES') {
      dilewati.push({ pendapatanDimukaId: item.pendapatanDimukaId, namaAnggota: item.namaAnggota, alasan: 'Periode ini sudah diproses sebelumnya.' });
      continue;
    }
    if (item.status === 'BELUM_MULAI') {
      dilewati.push({ pendapatanDimukaId: item.pendapatanDimukaId, namaAnggota: item.namaAnggota, alasan: 'Belum memasuki bulan penerimaan dana.' });
      continue;
    }
    if (item.status === 'SELESAI') {
      dilewati.push({ pendapatanDimukaId: item.pendapatanDimukaId, namaAnggota: item.namaAnggota, alasan: 'Sudah selesai diakui seluruhnya.' });
      continue;
    }
    try {
      const hasil = await prosesPengakuanPendapatanDimuka({ pendapatanDimukaId: item.pendapatanDimukaId, periode, createdBy });
      if (hasil.dibuat) diproses.push(hasil.row);
      else dilewati.push({ pendapatanDimukaId: item.pendapatanDimukaId, namaAnggota: item.namaAnggota, alasan: 'Periode ini sudah diproses sebelumnya.' });
    } catch (e) {
      dilewati.push({
        pendapatanDimukaId: item.pendapatanDimukaId,
        namaAnggota: item.namaAnggota,
        alasan: e instanceof Error ? e.message : 'Gagal memproses.',
      });
    }
  }

  return { periode, diproses, dilewati };
}

/** Daftar jurnal pengakuan pendapatan yang sudah tercatat — untuk layar "Jurnal Pengakuan Pendapatan". */
export async function listJurnalPengakuanDimuka(opts: { pendapatanDimukaId?: string; periode?: string } = {}): Promise<PengakuanDimukaRow[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: string[] = [];
  if (opts.pendapatanDimukaId) {
    filters.push('pp.pendapatan_dimuka_id = ?');
    params.push(opts.pendapatanDimukaId);
  }
  if (opts.periode) {
    filters.push('pp.periode = ?');
    params.push(opts.periode);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = await db.getAllAsync<any>(
    `SELECT pp.*, j.nomor_jurnal, a.nama_lengkap, p.nomor_transaksi
     FROM pendapatan_dimuka_pengakuan pp
     JOIN journal j ON j.id = pp.journal_id
     JOIN pendapatan_diterima_dimuka p ON p.id = pp.pendapatan_dimuka_id
     JOIN anggota a ON a.id = p.anggota_id
     ${where}
     ORDER BY pp.periode DESC, a.nama_lengkap ASC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    pendapatanDimukaId: r.pendapatan_dimuka_id,
    namaAnggota: r.nama_lengkap,
    nomorTransaksi: r.nomor_transaksi,
    periode: r.periode,
    urutanBulan: r.urutan_bulan,
    tanggal: r.tanggal,
    nilaiPengakuan: r.nilai_pengakuan,
    journalId: r.journal_id,
    nomorJurnal: r.nomor_jurnal,
  }));
}
