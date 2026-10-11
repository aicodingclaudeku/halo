import type * as SQLite from 'expo-sqlite';
import { Rupiah } from '@/utils/money';
import { newId, nextSequence } from '@/utils/id';
import { requirePermission } from '@/services/PermissionService';

/**
 * RC-S103 — MIGRASI SALDO AWAL SIMPANAN ANGGOTA (TANPA JURNAL KAS).
 *
 * ============================================================
 * MASALAH YANG DIPERBAIKI
 * ============================================================
 * Import Data Awal memasukkan simpanan dengan memanggil
 * `catatDataAwalSimpanan()`, yang MENJURNAL:
 *
 *     Debit  Kas/Bank          sebesar total simpanan
 *     Kredit Simpanan Pokok/Wajib/Sukarela
 *
 * Itu BENAR untuk setoran yang uangnya memang baru diterima hari ini —
 * dan karena itu fungsi tersebut TIDAK diubah; menu "Setor Simpanan"
 * tetap memakainya apa adanya.
 *
 * Tetapi SALAH untuk data awal. Simpanan anggota pada tanggal cut-off
 * adalah saldo historis: uangnya sudah lama diterima dan sebagian besar
 * sudah berputar keluar menjadi pinjaman. Mendebit kas sebesar total
 * simpanan menciptakan KAS FIKTIF — pada data koperasi KPRI yang
 * memicu perbaikan ini, Rp166.486.465 kas yang tidak pernah ada,
 * padahal uangnya sedang berada di tangan peminjam.
 *
 * Ini persis kesalahan yang sama dengan pencairan ULANG pinjaman
 * historis (RC-S102), hanya di sisi simpanan.
 *
 * ============================================================
 * PEMISAHAN YANG SAMA: BUKU PEMBANTU vs BUKU BESAR
 * ============================================================
 * Sama seperti `EksekusiMigrasiPinjaman`, fungsi ini TIDAK MENJURNAL
 * apa pun. Ia hanya menulis BUKU PEMBANTU simpanan — baris
 * `simpanan_transaksi` dengan `journal_id` NULL — sehingga saldo
 * simpanan per anggota, kartu simpanan, dan perhitungan jasa modal
 * membacanya seperti biasa.
 *
 * Sisi BUKU BESAR-nya (Simpanan Pokok/Wajib/Sukarela sebagai KEWAJIBAN
 * atau EKUITAS pada tanggal cut-off) dimasukkan lewat mekanisme SALDO
 * AWAL yang sudah ada (`saldo_awal_akun` + `postingSaldoAwal`), yang
 * memvalidasi persamaan akuntansi PENUH. Akibatnya kas yang dibukukan
 * adalah kas yang SESUNGGUHNYA diisi koperasi, bukan angka turunan dari
 * total simpanan.
 *
 * ============================================================
 * YANG TETAP DIJAGA
 * ============================================================
 *   - Aturan Simpanan Pokok hanya SEKALI per anggota (sama query-nya
 *     dengan `pastikanBelumAdaSimpananPokok` di SimpananService,
 *     termasuk pengecualian baris yang sudah dikoreksi).
 *   - Anggota harus AKTIF.
 *   - Nominal tidak boleh negatif dan totalnya harus > 0.
 *   - Satu baris berkas = satu kesatuan: Pokok/Wajib/Sukarela ditulis
 *     dalam SATU transaksi database, tidak ada kondisi Pokok tersimpan
 *     tetapi Wajib gagal.
 */

/** Klausa "baris yang belum dikoreksi" — SAMA dengan SimpananService. */
const BELUM_DIKOREKSI = `reversal_of_id IS NULL AND id NOT IN (
  SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL
)`;

export interface BarisMigrasiSimpanan {
  anggotaId: string;
  tanggal: string;
  pokok: Rupiah;
  wajib: Rupiah;
  sukarela: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string | null;
  keterangan?: string;
  createdBy: string;
}

export interface HasilMigrasiSimpanan {
  nomorTransaksi: string;
  total: Rupiah;
  idPokok: string | null;
  idWajib: string | null;
  idSukarela: string | null;
}

/** Nominal yang diterima sebagai saldo awal — dipisah agar bisa diuji. */
export function periksaNominalSaldoAwalSimpanan(pokok: Rupiah, wajib: Rupiah, sukarela: Rupiah): void {
  if (pokok < 0 || wajib < 0 || sukarela < 0) {
    throw new Error('Nominal Simpanan Pokok/Wajib/Sukarela tidak boleh negatif.');
  }
  if (pokok + wajib + sukarela <= 0) {
    throw new Error('Isi minimal salah satu dari Simpanan Pokok, Wajib, atau Sukarela.');
  }
}

/**
 * Tulis saldo awal simpanan satu anggota. WAJIB dipanggil dari dalam
 * transaksi database milik pemanggil (`jalankanMigrasiSimpanan` di
 * bawah) — bukan membuka transaksinya sendiri, supaya seluruh baris satu
 * berkas bisa dibungkus oleh pemanggil bila diperlukan.
 */
async function tulisSaldoAwalSimpanan(
  db: SQLite.SQLiteDatabase,
  input: BarisMigrasiSimpanan
): Promise<HasilMigrasiSimpanan> {
  // Izin diperiksa SAMA seperti `catatDataAwalSimpanan` — jalur saldo
  // awal tidak boleh jadi pintu belakang yang melewati otorisasi.
  await requirePermission(db, input.createdBy, 'simpanan', 'create');

  const anggota = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM anggota WHERE id = ?`,
    input.anggotaId
  );
  if (!anggota) throw new Error('Anggota tidak ditemukan.');
  if (anggota.status !== 'AKTIF') {
    throw new Error(`Anggota berstatus ${anggota.status}, tidak bisa dicatat saldo awal simpanan.`);
  }

  periksaNominalSaldoAwalSimpanan(input.pokok, input.wajib, input.sukarela);

  if (input.pokok > 0) {
    const row = await db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM simpanan_transaksi
       WHERE anggota_id = ? AND jenis = 'POKOK' AND tipe = 'SETOR' AND ${BELUM_DIKOREKSI}`,
      input.anggotaId
    );
    if ((row?.cnt ?? 0) > 0) {
      throw new Error('Anggota ini sudah memiliki Simpanan Pokok. Simpanan Pokok hanya dibayar satu kali.');
    }
  }

  const tahun = Number(input.tanggal.slice(0, 4));
  const nomorTransaksi = await nextSequence(db, 'SP-AWAL', tahun);
  const keterangan = input.keterangan?.trim() ? input.keterangan.trim() : 'Saldo awal simpanan';
  const now = new Date().toISOString();

  const insertBaris = async (jenis: 'POKOK' | 'WAJIB' | 'SUKARELA', nominal: Rupiah): Promise<string | null> => {
    if (nominal <= 0) return null;
    const id = newId();
    await db.runAsync(
      `INSERT INTO simpanan_transaksi
        (id, anggota_id, jenis, tipe, tanggal, periode, nominal, sumber_dana, bank_account_id,
         nomor_transaksi, keterangan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.anggotaId,
      jenis,
      'SETOR',
      input.tanggal,
      null,
      nominal,
      input.sumberDana,
      input.bankAccountId ?? null,
      `${nomorTransaksi}-${jenis}`,
      keterangan,
      // journal_id NULL — INI INTINYA. Saldo awal simpanan adalah buku
      // pembantu; sisi buku besarnya diposting lewat Saldo Awal Akun,
      // sehingga kas hari ini TIDAK bertambah karenanya.
      null,
      input.createdBy,
      now
    );
    return id;
  };

  return {
    nomorTransaksi,
    total: input.pokok + input.wajib + input.sukarela,
    idPokok: await insertBaris('POKOK', input.pokok),
    idWajib: await insertBaris('WAJIB', input.wajib),
    idSukarela: await insertBaris('SUKARELA', input.sukarela),
  };
}

/**
 * Catat saldo awal simpanan satu anggota dalam satu transaksi database.
 * Dipanggil per baris oleh Import Data Awal agar satu baris yang gagal
 * tidak menggagalkan baris lain — pelaporan per baris itulah yang
 * dipakai layar import dan riwayatnya.
 */
export async function jalankanMigrasiSimpanan(
  db: SQLite.SQLiteDatabase,
  input: BarisMigrasiSimpanan
): Promise<HasilMigrasiSimpanan> {
  let hasil: HasilMigrasiSimpanan | null = null;
  await db.withTransactionAsync(async () => {
    hasil = await tulisSaldoAwalSimpanan(db, input);
  });
  return hasil as unknown as HasilMigrasiSimpanan;
}

export const KETERBATASAN_SALDO_AWAL_SIMPANAN: readonly string[] = [
  'Saldo awal simpanan TIDAK menambah kas. Isi saldo awal akun Kas/Bank sebesar saldo yang sesungguhnya ada pada tanggal cut-off.',
  'Saldo awal akun Simpanan Pokok, Wajib, dan Sukarela di buku besar harus diisi sebesar total masing-masing jenis pada tanggal cut-off; aplikasi memeriksa keseimbangannya saat posting.',
  'Simpanan Wajib dicatat tanpa periode (bukan setoran bulan tertentu) karena yang dimigrasikan adalah SALDO pada cut-off, bukan riwayat setoran bulanannya.',
];
