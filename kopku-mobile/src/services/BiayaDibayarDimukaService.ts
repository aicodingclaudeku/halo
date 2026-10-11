import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah, roundToRupiah } from '@/utils/money';
import { toPeriode, tanggalAkhirPeriode, selisihBulan, isValidPeriode } from '@/accounting/PeriodeUtil';

/**
 * Biaya Dibayar Dimuka — Phase 10 (AUDIT_INTERNAL.md §6: "Biaya
 * dibayar dimuka: MISSING"). Kebalikan SIMETRIS dari
 * PendapatanDimukaService.ts:
 *  - Pendapatan Dimuka: TERIMA uang untuk kewajiban masa depan
 *    (liabilitas) -> diakui bertahap jadi PENDAPATAN.
 *  - Biaya Dibayar Dimuka: BAYAR uang untuk manfaat masa depan (aset)
 *    -> diakui bertahap jadi BEBAN.
 * Pola kode, anti-duplikasi, dan status SELESAI otomatis SAMA PERSIS
 * -- kalau ada perubahan pola di satu tempat, cek juga yang satunya.
 */

export interface TerimaBiayaDibayarDimukaInput {
  namaBiaya: string;
  akunBebanId: string; // akun Beban yang diakui bertahap (mis. Beban Sewa, Beban Asuransi)
  jumlah: Rupiah;
  jangkaWaktuBulan: number;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  createdBy: string;
}

/** DEBIT Biaya Dibayar Dimuka, KREDIT Kas/Bank. */
export async function bayarBiayaDibayarDimuka(input: TerimaBiayaDibayarDimukaInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    if (input.jangkaWaktuBulan <= 0 || !Number.isInteger(input.jangkaWaktuBulan)) {
      throw new Error('Jangka waktu harus bilangan bulat lebih dari 0 bulan.');
    }

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: input.jumlah,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const dimukaAccountId = await resolveAccountId(db, 'BIAYA_DIBAYAR_DIMUKA', 'DEBIT_DIMUKA');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'BDM', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'BIAYA_DIBAYAR_DIMUKA',
      nomorReferensi: nomorTransaksi,
      deskripsi: `Pembayaran biaya dibayar dimuka: ${input.namaBiaya} (${input.jangkaWaktuBulan} bulan) - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: dimukaAccountId, debit: input.jumlah, kredit: 0 },
        { accountId: kasBankAccountId, debit: 0, kredit: input.jumlah },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO biaya_dibayar_dimuka
        (id, nomor_transaksi, nama_biaya, akun_beban_id, jumlah, jangka_waktu_bulan, tanggal, sumber_dana, bank_account_id, status, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      nomorTransaksi,
      input.namaBiaya,
      input.akunBebanId,
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

export interface BiayaDimukaListItem {
  id: string;
  nomorTransaksi: string;
  namaBiaya: string;
  jumlah: Rupiah;
  jangkaWaktuBulan: number;
  tanggal: string;
  status: 'AKTIF' | 'SELESAI';
}

/** Daftar biaya dibayar dimuka -- untuk layar riwayat/register. */
export async function listBiayaDibayarDimuka(): Promise<BiayaDimukaListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(`SELECT * FROM biaya_dibayar_dimuka ORDER BY tanggal DESC`);
  return rows.map((r) => ({
    id: r.id,
    nomorTransaksi: r.nomor_transaksi,
    namaBiaya: r.nama_biaya,
    jumlah: r.jumlah,
    jangkaWaktuBulan: r.jangka_waktu_bulan,
    tanggal: r.tanggal,
    status: r.status,
  }));
}

// ============================================================
// PENGAKUAN BEBAN BULANAN (garis lurus) -- pola SAMA PERSIS dengan
// PendapatanDimukaService.ts & PenyusutanService.ts.
// ============================================================

export interface PengakuanBiayaDimukaRow {
  id: string;
  biayaDimukaId: string;
  namaBiaya: string;
  nomorTransaksi: string;
  periode: string;
  urutanBulan: number;
  tanggal: string;
  nilaiPengakuan: Rupiah;
  journalId: string;
  nomorJurnal: string | null;
}

/** Hitung nilai pengakuan beban bulanan garis lurus. */
export function hitungPengakuanBiayaBulanan(jumlah: Rupiah, jangkaWaktuBulan: number): Rupiah {
  if (jangkaWaktuBulan <= 0) return 0;
  return roundToRupiah(jumlah / jangkaWaktuBulan);
}

function indeksBulanPengakuan(tanggalBayar: string, periode: string): number {
  return selisihBulan(toPeriode(tanggalBayar), periode);
}

export type StatusPengakuanBiayaDimuka = 'BELUM_MULAI' | 'SUDAH_DIPROSES' | 'SIAP_DIPROSES' | 'SELESAI';

export interface StatusPengakuanBiayaDimukaItem {
  biayaDimukaId: string;
  namaBiaya: string;
  nomorTransaksi: string;
  jumlah: Rupiah;
  jangkaWaktuBulan: number;
  nilaiPengakuanBulanan: Rupiah;
  status: StatusPengakuanBiayaDimuka;
}

/** Status tiap baris biaya dibayar dimuka untuk satu periode. */
export async function getStatusPengakuanBiayaPeriode(periode: string): Promise<StatusPengakuanBiayaDimukaItem[]> {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
  const db = await getDb();
  const rows = await db.getAllAsync<any>(`SELECT * FROM biaya_dibayar_dimuka ORDER BY tanggal ASC`);
  const sudahDiproses = await db.getAllAsync<{ biaya_dimuka_id: string }>(
    `SELECT biaya_dimuka_id FROM biaya_dimuka_pengakuan WHERE periode = ?`,
    periode
  );
  const sudahDiprosesSet = new Set(sudahDiproses.map((r) => r.biaya_dimuka_id));

  return rows.map((r) => {
    const idx = indeksBulanPengakuan(r.tanggal, periode);
    let status: StatusPengakuanBiayaDimuka;
    if (idx < 0) status = 'BELUM_MULAI';
    else if (sudahDiprosesSet.has(r.id)) status = 'SUDAH_DIPROSES';
    else if (idx < r.jangka_waktu_bulan) status = 'SIAP_DIPROSES';
    else status = 'SELESAI';

    return {
      biayaDimukaId: r.id,
      namaBiaya: r.nama_biaya,
      nomorTransaksi: r.nomor_transaksi,
      jumlah: r.jumlah,
      jangkaWaktuBulan: r.jangka_waktu_bulan,
      nilaiPengakuanBulanan: hitungPengakuanBiayaBulanan(r.jumlah, r.jangka_waktu_bulan),
      status,
    };
  });
}

/** Proses pengakuan SATU baris biaya dibayar dimuka untuk SATU periode. Idempoten. */
export async function prosesPengakuanBiayaDimuka(params: {
  biayaDimukaId: string;
  periode: string;
  createdBy: string;
}): Promise<{ dibuat: boolean; row: PengakuanBiayaDimukaRow; menyelesaikan: boolean }> {
  if (!isValidPeriode(params.periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');

  return withTransaction(async (db) => {
    await requirePermission(db, params.createdBy, 'kas_bank', 'create');

    const existing = await db.getFirstAsync<any>(
      `SELECT bp.*, j.nomor_jurnal, b.nama_biaya, b.nomor_transaksi
       FROM biaya_dimuka_pengakuan bp
       JOIN journal j ON j.id = bp.journal_id
       JOIN biaya_dibayar_dimuka b ON b.id = bp.biaya_dimuka_id
       WHERE bp.biaya_dimuka_id = ? AND bp.periode = ?`,
      params.biayaDimukaId,
      params.periode
    );
    if (existing) {
      return {
        dibuat: false,
        menyelesaikan: false,
        row: {
          id: existing.id,
          biayaDimukaId: existing.biaya_dimuka_id,
          namaBiaya: existing.nama_biaya,
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

    const biaya = await db.getFirstAsync<any>(`SELECT * FROM biaya_dibayar_dimuka WHERE id = ?`, params.biayaDimukaId);
    if (!biaya) throw new Error('Data biaya dibayar dimuka tidak ditemukan.');
    if (biaya.status === 'SELESAI') {
      throw new Error(`Biaya dibayar dimuka "${biaya.nama_biaya}" sudah SELESAI diakui seluruhnya.`);
    }

    const idx = indeksBulanPengakuan(biaya.tanggal, params.periode);
    if (idx < 0) {
      throw new Error(`Biaya "${biaya.nama_biaya}" baru dibayar pada ${biaya.tanggal} — periode ${params.periode} sebelum tanggal itu.`);
    }
    if (idx >= biaya.jangka_waktu_bulan) {
      throw new Error(`Biaya "${biaya.nama_biaya}" sudah melewati jangka waktu (${biaya.jangka_waktu_bulan} bulan).`);
    }

    const nilaiPengakuan = hitungPengakuanBiayaBulanan(biaya.jumlah, biaya.jangka_waktu_bulan);
    if (nilaiPengakuan <= 0) {
      throw new Error(`Biaya "${biaya.nama_biaya}" tidak memiliki nilai pengakuan.`);
    }

    const dimukaAccountId = await resolveAccountId(db, 'BIAYA_DIBAYAR_DIMUKA', 'DEBIT_DIMUKA');
    const tanggal = tanggalAkhirPeriode(params.periode);
    const urutanBulan = idx + 1;

    const year = new Date(tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'PBD', year);

    const { journalId, nomorJurnal } = await createJournal(db, {
      tanggal,
      sumberTransaksi: 'PENGAKUAN_BIAYA_DIMUKA',
      sumberId: biaya.id,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Pengakuan biaya dibayar dimuka ${biaya.nama_biaya} bulan ke-${urutanBulan}/${biaya.jangka_waktu_bulan} periode ${params.periode} - ${nomorTransaksi}`,
      createdBy: params.createdBy,
      lines: [
        { accountId: biaya.akun_beban_id, debit: nilaiPengakuan, kredit: 0 },
        { accountId: dimukaAccountId, debit: 0, kredit: nilaiPengakuan },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO biaya_dimuka_pengakuan
        (id, biaya_dimuka_id, periode, urutan_bulan, tanggal, nilai_pengakuan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id,
      params.biayaDimukaId,
      params.periode,
      urutanBulan,
      tanggal,
      nilaiPengakuan,
      journalId,
      params.createdBy,
      now
    );

    const menyelesaikan = urutanBulan >= biaya.jangka_waktu_bulan;
    if (menyelesaikan) {
      await db.runAsync(`UPDATE biaya_dibayar_dimuka SET status = 'SELESAI' WHERE id = ?`, params.biayaDimukaId);
    }

    return {
      dibuat: true,
      menyelesaikan,
      row: {
        id,
        biayaDimukaId: params.biayaDimukaId,
        namaBiaya: biaya.nama_biaya,
        nomorTransaksi: biaya.nomor_transaksi,
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

export interface HasilBatchPengakuanBiaya {
  periode: string;
  diproses: PengakuanBiayaDimukaRow[];
  dilewati: { biayaDimukaId: string; namaBiaya: string; alasan: string }[];
}

/** Jalankan pengakuan untuk SEMUA baris biaya dibayar dimuka yang siap diproses pada satu periode. */
export async function jalankanPengakuanBiayaPeriode(periode: string, createdBy: string): Promise<HasilBatchPengakuanBiaya> {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
  const status = await getStatusPengakuanBiayaPeriode(periode);
  const diproses: PengakuanBiayaDimukaRow[] = [];
  const dilewati: { biayaDimukaId: string; namaBiaya: string; alasan: string }[] = [];

  for (const item of status) {
    if (item.status === 'SUDAH_DIPROSES') {
      dilewati.push({ biayaDimukaId: item.biayaDimukaId, namaBiaya: item.namaBiaya, alasan: 'Periode ini sudah diproses sebelumnya.' });
      continue;
    }
    if (item.status === 'BELUM_MULAI') {
      dilewati.push({ biayaDimukaId: item.biayaDimukaId, namaBiaya: item.namaBiaya, alasan: 'Belum memasuki bulan pembayaran.' });
      continue;
    }
    if (item.status === 'SELESAI') {
      dilewati.push({ biayaDimukaId: item.biayaDimukaId, namaBiaya: item.namaBiaya, alasan: 'Sudah selesai diakui seluruhnya.' });
      continue;
    }
    try {
      const hasil = await prosesPengakuanBiayaDimuka({ biayaDimukaId: item.biayaDimukaId, periode, createdBy });
      if (hasil.dibuat) diproses.push(hasil.row);
      else dilewati.push({ biayaDimukaId: item.biayaDimukaId, namaBiaya: item.namaBiaya, alasan: 'Periode ini sudah diproses sebelumnya.' });
    } catch (e) {
      dilewati.push({
        biayaDimukaId: item.biayaDimukaId,
        namaBiaya: item.namaBiaya,
        alasan: e instanceof Error ? e.message : 'Gagal memproses.',
      });
    }
  }

  return { periode, diproses, dilewati };
}

/** Daftar jurnal pengakuan biaya yang sudah tercatat -- untuk layar "Jurnal Pengakuan Biaya". */
export async function listJurnalPengakuanBiaya(opts: { biayaDimukaId?: string; periode?: string } = {}): Promise<PengakuanBiayaDimukaRow[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: string[] = [];
  if (opts.biayaDimukaId) {
    filters.push('bp.biaya_dimuka_id = ?');
    params.push(opts.biayaDimukaId);
  }
  if (opts.periode) {
    filters.push('bp.periode = ?');
    params.push(opts.periode);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = await db.getAllAsync<any>(
    `SELECT bp.*, j.nomor_jurnal, b.nama_biaya, b.nomor_transaksi
     FROM biaya_dimuka_pengakuan bp
     JOIN journal j ON j.id = bp.journal_id
     JOIN biaya_dibayar_dimuka b ON b.id = bp.biaya_dimuka_id
     ${where}
     ORDER BY bp.periode DESC, b.nama_biaya ASC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    biayaDimukaId: r.biaya_dimuka_id,
    namaBiaya: r.nama_biaya,
    nomorTransaksi: r.nomor_transaksi,
    periode: r.periode,
    urutanBulan: r.urutan_bulan,
    tanggal: r.tanggal,
    nilaiPengakuan: r.nilai_pengakuan,
    journalId: r.journal_id,
    nomorJurnal: r.nomor_jurnal,
  }));
}
