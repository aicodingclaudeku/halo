import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { nextSequence, newId } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { JENIS_INVESTASI_BAGIAN_SHU } from '@/config/pendapatanKoperasiPolicy';

/**
 * BAGIAN SHU DARI INVESTASI PADA KOPERASI LAIN — RC-S53.
 *
 * Mengimplementasikan KEPUTUSAN 05 (peristiwa hak) dan KEPUTUSAN 04-A
 * (klasifikasi & akuntansi). Dua operasi, dua peristiwa berbeda:
 *
 *   1. `catatBagianShuInvestasi()` — PENGAKUAN HAK.
 *      Dr `1-1220` Piutang Pendapatan Investasi
 *      Cr `4-1300` Pendapatan Hasil Investasi
 *
 *   2. `catatPenerimaanBagianShu()` — PENERIMAAN KAS.
 *      Dr Kas/Bank
 *      Cr `1-1220` Piutang Pendapatan Investasi
 *
 * YANG PALING PENTING DI BERKAS INI: penerimaan kas TIDAK menyentuh akun
 * pendapatan sama sekali. Ia hanya menutup piutang yang sudah diakui.
 * Itulah yang mencegah `ACCRUAL + CASH = DOUBLE REVENUE`.
 *
 * SYARAT BUKTI (KEPUTUSAN 05). Pengakuan menolak berjalan tanpa jenis
 * dokumen, nomor dokumen, dan tanggal dokumen. Sistem TIDAK pernah
 * membuat akrual otomatis dari estimasi, dari informasi informal, atau
 * dari fakta bahwa investee memperoleh SHU — hak baru ada setelah
 * investee resmi menetapkan pembagiannya dan koperasi memegang buktinya.
 *
 * YANG SENGAJA TIDAK ADA DI SINI. AKRUAL imbal hasil tetap (KEPUTUSAN 06)
 * dan posting nilai wajar (KEPUTUSAN 03) tidak diimplementasikan. Register
 * ini hanya untuk BAGIAN_SHU. Penerimaan KAS imbal hasil tetap AKTIF sejak
 * RC-S67.6 lewat `PendapatanLainnyaService.tambahPendapatanInvestasi`
 * (kategori IMBAL_HASIL_TETAP, KEPUTUSAN 04-B revisi RC-S67.6) — bukan di
 * berkas ini. Tidak ada rate default, tenor default, kontrak sintetis,
 * maupun jurnal nilai wajar.
 */

/** Satu-satunya jenis hasil pada register Bagian SHU (akrual berbasis hak). */
export const JENIS_HASIL_AKTIF = 'BAGIAN_SHU' as const;

// RC-S67.6.1 — `HASIL_INVESTASI_DISABLED` & `JenisHasilDisabledError`
// DIHAPUS. Audit: tidak ada satu pun pemanggil produksi yang melempar error
// itu (CatatBagianShuInput tidak punya field jenis hasil; register selalu
// menulis JENIS_HASIL_AKTIF), satu-satunya pemakai adalah test. Imbal hasil
// tetap kini AKTIF sebagai penerimaan kas (lihat komentar berkas di atas).

export interface CatatBagianShuInput {
  investasiId: string;
  /** Tanggal peristiwa hak: saat investee resmi menetapkan pembagian. */
  tanggalHak: string;
  jumlah: Rupiah;
  /** Mis. 'Berita Acara RAT' atau 'Keputusan Pembagian SHU'. */
  jenisDokumen: string;
  /** Nomor dokumen bukti hak — bagian dari identity idempotensi. */
  nomorDokumen: string;
  tanggalDokumen: string;
  keterangan?: string;
  createdBy: string;
}

export interface CatatPenerimaanBagianShuInput {
  bagianShuId: string;
  tanggal: string;
  jumlah: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  /** Referensi penerimaan — bagian dari identity idempotensi. */
  nomorReferensi: string;
  createdBy: string;
}

function wajibDiisi(nilai: string | undefined, label: string): string {
  const bersih = (nilai ?? '').trim();
  if (!bersih) throw new Error(`${label} wajib diisi.`);
  return bersih;
}

/**
 * Catat pengakuan hak atas bagian SHU dari koperasi lain.
 *
 * Idempotensi (KEPUTUSAN 04-A): identity
 * `investasi_id + tanggal_hak + jenis_hasil + nomor_dokumen` dijaga
 * indeks UNIQUE di database. Submit ganda, retry, maupun pemulihan
 * setelah crash menghasilkan penolakan — bukan baris kedua dan bukan
 * jurnal kedua, karena seluruh operasi berada dalam satu transaksi.
 */
export async function catatBagianShuInvestasi(
  input: CatatBagianShuInput
): Promise<{ id: string; journalId: string; nomorReferensi: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit');

    const jenisDokumen = wajibDiisi(input.jenisDokumen, 'Jenis dokumen bukti hak');
    const nomorDokumen = wajibDiisi(input.nomorDokumen, 'Nomor dokumen bukti hak');
    const tanggalDokumen = wajibDiisi(input.tanggalDokumen, 'Tanggal dokumen bukti hak');
    wajibDiisi(input.tanggalHak, 'Tanggal hak');

    if (!Number.isFinite(input.jumlah) || input.jumlah <= 0) {
      throw new Error('Jumlah bagian SHU harus lebih dari 0.');
    }
    if (!Number.isInteger(input.jumlah)) {
      throw new Error('Jumlah bagian SHU harus bilangan bulat rupiah penuh.');
    }

    const investasi = await db.getFirstAsync<{ id: string; nama_tujuan: string; status: string; jenis_investasi: string }>(
      `SELECT id, nama_tujuan, status, jenis_investasi FROM investasi WHERE id = ?`,
      input.investasiId
    );
    if (!investasi) throw new Error('Investasi tidak ditemukan.');
    if (investasi.status !== 'AKTIF') {
      throw new Error('Investasi ini sudah tidak aktif — tidak bisa dicatat bagian SHU-nya.');
    }
    // Bagian SHU hanya untuk penyertaan pada koperasi lain. Service adalah
    // penjaga akhir: investasiId jenis lain yang lolos dari UI tetap ditolak,
    // tanpa fallback dan tanpa mengubah jenis investasinya.
    if (investasi.jenis_investasi !== JENIS_INVESTASI_BAGIAN_SHU) {
      throw new Error('Bagian SHU hanya dapat dicatat untuk Penyertaan pada Koperasi Lain.');
    }

    // Identity idempotensi dicek lebih dulu supaya pesannya jelas; indeks
    // UNIQUE di database tetap menjadi penjaga terakhir kalau dua proses
    // berjalan bersamaan.
    const sudahAda = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM investasi_bagian_shu
        WHERE investasi_id = ? AND tanggal_hak = ? AND jenis_hasil = ? AND nomor_dokumen = ?`,
      input.investasiId,
      input.tanggalHak,
      JENIS_HASIL_AKTIF,
      nomorDokumen
    );
    if (sudahAda) {
      throw new Error(
        `Bagian SHU untuk dokumen ${nomorDokumen} pada tanggal ${input.tanggalHak} sudah pernah dicatat.`
      );
    }

    const piutangAccountId = await resolveAccountId(db, 'BAGIAN_SHU_INVESTASI', 'DEBIT_PIUTANG');
    const pendapatanAccountId = await resolveAccountId(db, 'BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN');

    const year = new Date(input.tanggalHak).getFullYear();
    const nomorReferensi = await nextSequence(db, 'BSH', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggalHak,
      sumberTransaksi: 'BAGIAN_SHU_INVESTASI',
      sumberId: input.investasiId,
      nomorReferensi,
      deskripsi: `Bagian SHU dari ${investasi.nama_tujuan} - ${jenisDokumen} ${nomorDokumen}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: piutangAccountId, debit: input.jumlah, kredit: 0 },
        { accountId: pendapatanAccountId, debit: 0, kredit: input.jumlah },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO investasi_bagian_shu
        (id, investasi_id, jenis_hasil, tanggal_hak, jumlah, jenis_dokumen, nomor_dokumen,
         tanggal_dokumen, keterangan, journal_id, jumlah_diterima, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,'DIAKUI',?,?,?)`,
      id,
      input.investasiId,
      JENIS_HASIL_AKTIF,
      input.tanggalHak,
      input.jumlah,
      jenisDokumen,
      nomorDokumen,
      tanggalDokumen,
      input.keterangan?.trim() || null,
      journalId,
      input.createdBy,
      now,
      now
    );

    return { id, journalId, nomorReferensi };
  });
}

/**
 * Catat penerimaan kas atas bagian SHU yang SUDAH diakui.
 *
 * Jurnalnya sengaja hanya menyentuh Kas/Bank dan piutang. Tidak ada satu
 * baris pun ke akun pendapatan — pendapatannya sudah diakui pada
 * peristiwa hak.
 */
export async function catatPenerimaanBagianShu(
  input: CatatPenerimaanBagianShuInput
): Promise<{ id: string; journalId: string; status: 'DIAKUI' | 'LUNAS' }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit');

    const nomorReferensi = wajibDiisi(input.nomorReferensi, 'Nomor referensi penerimaan');
    wajibDiisi(input.tanggal, 'Tanggal penerimaan');

    if (!Number.isFinite(input.jumlah) || input.jumlah <= 0) {
      throw new Error('Jumlah penerimaan harus lebih dari 0.');
    }
    if (!Number.isInteger(input.jumlah)) {
      throw new Error('Jumlah penerimaan harus bilangan bulat rupiah penuh.');
    }

    const row = await db.getFirstAsync<{
      id: string;
      investasi_id: string;
      jumlah: number;
      jumlah_diterima: number;
      nomor_dokumen: string;
      nama_tujuan: string;
    }>(
      `SELECT b.id, b.investasi_id, b.jumlah, b.jumlah_diterima, b.nomor_dokumen, i.nama_tujuan
         FROM investasi_bagian_shu b
         JOIN investasi i ON i.id = b.investasi_id
        WHERE b.id = ?`,
      input.bagianShuId
    );
    if (!row) throw new Error('Data bagian SHU tidak ditemukan.');

    const sisa = row.jumlah - row.jumlah_diterima;
    if (sisa <= 0) {
      throw new Error('Bagian SHU ini sudah lunas — tidak ada sisa piutang yang dapat diterima.');
    }
    if (input.jumlah > sisa) {
      throw new Error(
        `Jumlah penerimaan (${input.jumlah}) melebihi sisa piutang bagian SHU (${sisa}).`
      );
    }

    const duplikat = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM investasi_bagian_shu_penerimaan WHERE bagian_shu_id = ? AND nomor_referensi = ?`,
      input.bagianShuId,
      nomorReferensi
    );
    if (duplikat) {
      throw new Error(`Penerimaan dengan referensi ${nomorReferensi} sudah pernah dicatat.`);
    }

    // AUDIT FIX RC-S53 — `RekeningPicker` juga menawarkan Kas Kecil,
    // sedangkan `sumber_dana` pada register hanya menerima 'KAS' dan
    // 'BANK' (CHECK di skema). Tanpa penjagaan ini, pilihan Kas Kecil
    // akan tercatat sebagai 'KAS' dan jurnalnya mendebit KAS UMUM —
    // uangnya masuk ke akun kas yang salah tanpa satu pun peringatan.
    // Ditolak terang-terangan, bukan dipetakan diam-diam.
    const sumberDana = input.sumberDana as string;
    if (sumberDana !== 'KAS' && sumberDana !== 'BANK') {
      throw new Error(
        'Penerimaan bagian SHU hanya dapat dicatat ke Kas Umum atau rekening bank. ' +
          'Pilih salah satu dari keduanya.'
      );
    }
    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const piutangAccountId = await resolveAccountId(db, 'BAGIAN_SHU_PENERIMAAN', 'KREDIT_PIUTANG');

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'BAGIAN_SHU_PENERIMAAN',
      sumberId: row.id,
      nomorReferensi,
      deskripsi: `Penerimaan bagian SHU dari ${row.nama_tujuan} - ${row.nomor_dokumen}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: kasBankAccountId, debit: input.jumlah, kredit: 0 },
        { accountId: piutangAccountId, debit: 0, kredit: input.jumlah },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO investasi_bagian_shu_penerimaan
        (id, bagian_shu_id, tanggal, jumlah, sumber_dana, bank_account_id, nomor_referensi,
         journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id,
      row.id,
      input.tanggal,
      input.jumlah,
      input.sumberDana,
      input.bankAccountId ?? null,
      nomorReferensi,
      journalId,
      input.createdBy,
      now
    );

    const totalDiterima = row.jumlah_diterima + input.jumlah;
    const status: 'DIAKUI' | 'LUNAS' = totalDiterima >= row.jumlah ? 'LUNAS' : 'DIAKUI';
    await db.runAsync(
      `UPDATE investasi_bagian_shu SET jumlah_diterima = ?, status = ?, updated_at = ? WHERE id = ?`,
      totalDiterima,
      status,
      now,
      row.id
    );

    return { id, journalId, status };
  });
}

export interface BagianShuRow {
  id: string;
  investasiId: string;
  namaTujuan: string;
  tanggalHak: string;
  jumlah: Rupiah;
  jumlahDiterima: Rupiah;
  sisaPiutang: Rupiah;
  jenisDokumen: string;
  nomorDokumen: string;
  tanggalDokumen: string;
  status: 'DIAKUI' | 'LUNAS';
  journalId: string;
}

/** Daftar pengakuan bagian SHU — untuk layar, subledger piutang, dan CALK. */
export async function listBagianShuInvestasi(
  opts: { investasiId?: string } = {}
): Promise<BagianShuRow[]> {
  const db = await getDb();
  return listBagianShuInvestasiDenganDb(db, opts);
}

/** Varian yang menerima koneksi — dipakai di dalam transaksi & test. */
export async function listBagianShuInvestasiDenganDb(
  db: SQLite.SQLiteDatabase,
  opts: { investasiId?: string } = {}
): Promise<BagianShuRow[]> {
  const where = opts.investasiId ? 'WHERE b.investasi_id = ?' : '';
  const params = opts.investasiId ? [opts.investasiId] : [];
  const rows = await db.getAllAsync<Record<string, string | number>>(
    `SELECT b.*, i.nama_tujuan
       FROM investasi_bagian_shu b
       JOIN investasi i ON i.id = b.investasi_id
       ${where}
      ORDER BY b.tanggal_hak DESC, b.created_at DESC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id as string,
    investasiId: r.investasi_id as string,
    namaTujuan: r.nama_tujuan as string,
    tanggalHak: r.tanggal_hak as string,
    jumlah: r.jumlah as number,
    jumlahDiterima: r.jumlah_diterima as number,
    sisaPiutang: (r.jumlah as number) - (r.jumlah_diterima as number),
    jenisDokumen: r.jenis_dokumen as string,
    nomorDokumen: r.nomor_dokumen as string,
    tanggalDokumen: r.tanggal_dokumen as string,
    status: r.status as 'DIAKUI' | 'LUNAS',
    journalId: r.journal_id as string,
  }));
}
