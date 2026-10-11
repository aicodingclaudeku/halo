import { Rupiah } from '@/utils/money';

/**
 * RC-S107 — MIGRASI ASET TETAP LAMA (MODUL MURNI).
 *
 * ============================================================
 * MASALAH YANG DIHINDARI
 * ============================================================
 * `AsetService.beliAset()` menjurnal PEMBELIAN: Debit Aset Tetap,
 * Kredit Kas/Bank. Benar untuk aset yang memang baru dibeli, tetapi
 * salah untuk aset lama — kas koperasi hari ini akan berkurang untuk
 * uang yang keluar bertahun-tahun lalu. Ini kesalahan yang SAMA
 * kelasnya dengan pencairan ulang pinjaman (RC-S102) dan kas fiktif
 * dari simpanan (RC-S103).
 *
 * Karena itu migrasi aset TIDAK MENJURNAL PEMBELIAN. Yang ditulis
 * hanyalah BUKU PEMBANTU aset: baris `aset_tetap` dengan `journal_id`
 * NULL. Sisi buku besarnya (Aset Tetap dan Akumulasi Penyusutan pada
 * tanggal cut-off) masuk lewat Saldo Awal Akun, yang memvalidasi
 * persamaan akuntansi penuh.
 *
 * ============================================================
 * MASALAH KEDUA: PENYUSUTAN MASA LALU
 * ============================================================
 * Mesin penyusutan aplikasi mengejar ketertinggalan (catch-up) sejak
 * `tanggal_perolehan`. Aset yang diperoleh 2020 dan diimpor hari ini
 * akan memicu puluhan bulan beban penyusutan diposting ke tahun buku
 * BERJALAN — mengakui ulang beban tahun-tahun yang sudah lewat.
 *
 * Penangkalnya: periode penyusutan SEBELUM cut-off dicatat sebagai
 * SUDAH diakui, memakai jurnal saldo awal sebagai rujukannya. Itu
 * bukan jurnal karangan — jurnal saldo awal itulah yang memang memuat
 * kredit Akumulasi Penyusutan sebesar penyusutan masa lalu tersebut,
 * sehingga jumlah baris buku pembantu persis sama dengan nilai yang
 * diakui di buku besar. `getPeriodePenyusutanTertunggak` kemudian
 * melewati periode-periode itu, dan penyusutan berjalan hanya untuk
 * periode SETELAH cut-off.
 *
 * ============================================================
 * AKUMULASI PENYUSUTAN DIHITUNG, BUKAN DIMINTA
 * ============================================================
 * Akumulasi tidak diambil dari kolom isian. Alasannya bukan
 * kemudahan: bila pengguna mengisi angka yang berbeda dari hasil
 * perhitungan mesin penyusutan, buku pembantu dan buku besar akan
 * selisih sejak hari pertama dan tidak pernah bisa direkonsiliasi.
 * Di sini akumulasi dihitung dengan rumus yang SAMA dengan mesin
 * penyusutan (garis lurus, bulan perolehan dihitung penuh), sehingga
 * keduanya sama secara konstruksi. Bila angka pembukuan lama berbeda,
 * selisihnya harus diselesaikan lewat koreksi saldo awal — terlihat,
 * bukan tersembunyi.
 */

export interface BarisMigrasiAset {
  /** Nomor baris pada berkas sumber — untuk pesan galat yang bisa ditindaklanjuti. */
  baris: number;
  /** Nomor aset dari pembukuan lama; dipakai sebagai `aset_tetap.nomor_aset` yang UNIQUE. */
  nomorAset: string;
  namaAset: string;
  tanggalPerolehan: string;
  nilaiPerolehan: Rupiah;
  masaManfaatBulan: number;
  nilaiResidu: Rupiah;
  kelompokAset?: string;
  subKelompokAset?: string;
}

export type KodeGalatAset =
  | 'CUTOFF_TIDAK_VALID'
  | 'NOMOR_ASET_KOSONG'
  | 'NOMOR_ASET_GANDA'
  | 'NAMA_KOSONG'
  | 'TANGGAL_TIDAK_VALID'
  | 'PEROLEHAN_SETELAH_CUTOFF'
  | 'NILAI_PEROLEHAN_TIDAK_VALID'
  | 'MASA_MANFAAT_TIDAK_VALID'
  | 'RESIDU_TIDAK_VALID';

export interface GalatMigrasiAset {
  baris: number;
  kode: KodeGalatAset;
  pesan: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Periksa SELURUH baris lebih dulu. Satu baris rusak membatalkan
 * seluruh migrasi aset — pola yang sama dengan migrasi pinjaman, karena
 * aset yang masuk separuh membuat saldo awal Aset Tetap mustahil
 * direkonsiliasi.
 */
export function validasiMigrasiAset(
  baris: BarisMigrasiAset[],
  konteks: { tanggalCutOff: string }
): GalatMigrasiAset[] {
  const galat: GalatMigrasiAset[] = [];
  if (!ISO.test(konteks.tanggalCutOff)) {
    galat.push({ baris: 0, kode: 'CUTOFF_TIDAK_VALID', pesan: 'Tanggal cut-off tidak valid.' });
    return galat;
  }

  const nomorTerpakai = new Map<string, number>();
  for (const r of baris) {
    const nomor = (r.nomorAset ?? '').trim();
    if (nomor === '') {
      galat.push({ baris: r.baris, kode: 'NOMOR_ASET_KOSONG', pesan: 'Nomor Aset wajib diisi — dipakai agar import ulang tidak menggandakan aset.' });
    } else {
      const sebelumnya = nomorTerpakai.get(nomor.toUpperCase());
      if (sebelumnya !== undefined) {
        galat.push({ baris: r.baris, kode: 'NOMOR_ASET_GANDA', pesan: `Nomor Aset "${nomor}" sudah dipakai baris ${sebelumnya}.` });
      } else {
        nomorTerpakai.set(nomor.toUpperCase(), r.baris);
      }
    }

    if (!(r.namaAset ?? '').trim()) {
      galat.push({ baris: r.baris, kode: 'NAMA_KOSONG', pesan: 'Nama Aset wajib diisi.' });
    }

    if (!ISO.test(r.tanggalPerolehan)) {
      galat.push({ baris: r.baris, kode: 'TANGGAL_TIDAK_VALID', pesan: 'Tanggal Perolehan tidak valid.' });
    } else if (r.tanggalPerolehan > konteks.tanggalCutOff) {
      galat.push({
        baris: r.baris,
        kode: 'PEROLEHAN_SETELAH_CUTOFF',
        pesan: `Tanggal Perolehan (${r.tanggalPerolehan}) sesudah cut-off (${konteks.tanggalCutOff}). Aset yang baru dibeli dicatat lewat menu Aset, bukan import saldo awal.`,
      });
    }

    if (!Number.isInteger(r.nilaiPerolehan) || r.nilaiPerolehan <= 0) {
      galat.push({ baris: r.baris, kode: 'NILAI_PEROLEHAN_TIDAK_VALID', pesan: 'Nilai Perolehan harus bilangan bulat lebih besar dari 0.' });
    }
    if (!Number.isInteger(r.masaManfaatBulan) || r.masaManfaatBulan <= 0) {
      galat.push({ baris: r.baris, kode: 'MASA_MANFAAT_TIDAK_VALID', pesan: 'Masa Manfaat (bulan) harus bilangan bulat lebih besar dari 0.' });
    }
    if (!Number.isInteger(r.nilaiResidu) || r.nilaiResidu < 0 || r.nilaiResidu >= r.nilaiPerolehan) {
      galat.push({ baris: r.baris, kode: 'RESIDU_TIDAK_VALID', pesan: 'Nilai Residu harus 0 atau lebih, dan lebih kecil dari Nilai Perolehan.' });
    }
  }
  return galat;
}

/** Periode 'YYYY-MM' dari tanggal ISO. */
export function periodeDari(iso: string): string {
  return iso.slice(0, 7);
}

/** Selisih bulan antara dua periode 'YYYY-MM'. */
export function selisihPeriode(dari: string, sampai: string): number {
  const [y1, m1] = dari.split('-').map(Number);
  const [y2, m2] = sampai.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

/** Maju `n` bulan dari periode 'YYYY-MM'. */
export function majuPeriodeBulan(periode: string, n: number): string {
  const [y, m] = periode.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export interface PenyusutanMasaLalu {
  /** Periode yang dianggap SUDAH disusutkan sebelum cut-off. */
  periode: string[];
  /** Nilai penyusutan per periode (sama tiap periode — garis lurus). */
  nilaiPerPeriode: Rupiah;
  /** Total akumulasi penyusutan pada cut-off. */
  akumulasi: Rupiah;
  /** Nilai buku pada cut-off = perolehan - akumulasi. */
  nilaiBuku: Rupiah;
}

/**
 * Hitung penyusutan yang SUDAH terjadi sampai cut-off.
 *
 * Mengikuti kebijakan mesin penyusutan aplikasi:
 *   - garis lurus: (perolehan - residu) / masa manfaat;
 *   - bulan perolehan dihitung PENUH (idx 0 = bulan perolehan);
 *   - sebuah periode baru diakui setelah bulannya BERAKHIR, sehingga
 *     periode bulan cut-off ikut hanya bila cut-off jatuh pada hari
 *     terakhir bulan itu — di sini disederhanakan menjadi: periode
 *     yang seluruhnya berada SEBELUM bulan cut-off. Penyusutan bulan
 *     cut-off sendiri diserahkan ke mesin penyusutan seperti biasa,
 *     supaya tidak ada satu periode pun yang diakui dua kali.
 *   - tidak pernah melampaui masa manfaat.
 */
export function hitungPenyusutanMasaLalu(input: {
  nilaiPerolehan: Rupiah;
  nilaiResidu: Rupiah;
  masaManfaatBulan: number;
  tanggalPerolehan: string;
  tanggalCutOff: string;
}): PenyusutanMasaLalu {
  const { nilaiPerolehan, nilaiResidu, masaManfaatBulan } = input;
  const dasar = Math.max(0, nilaiPerolehan - nilaiResidu);
  const nilaiPerPeriode = masaManfaatBulan > 0 ? Math.round(dasar / masaManfaatBulan) : 0;

  const periodePerolehan = periodeDari(input.tanggalPerolehan);
  const periodeCutOff = periodeDari(input.tanggalCutOff);
  // Jumlah periode yang SUDAH berakhir sebelum bulan cut-off.
  const lewat = Math.max(0, selisihPeriode(periodePerolehan, periodeCutOff));
  const jumlah = Math.min(lewat, masaManfaatBulan);

  const periode: string[] = [];
  for (let i = 0; i < jumlah; i++) periode.push(majuPeriodeBulan(periodePerolehan, i));

  // Periode TERAKHIR menyerap sisa pembulatan supaya akumulasi tidak
  // pernah melampaui (perolehan - residu) dan nilai buku tidak pernah
  // jatuh di bawah residu.
  let akumulasi = nilaiPerPeriode * jumlah;
  if (jumlah === masaManfaatBulan) akumulasi = dasar;
  if (akumulasi > dasar) akumulasi = dasar;

  return { periode, nilaiPerPeriode, akumulasi, nilaiBuku: nilaiPerolehan - akumulasi };
}

/** Penanda pada keterangan aset hasil migrasi. */
export const PENANDA_MIGRASI_ASET = 'MIGRASI SALDO AWAL ASET';

export function keteranganMigrasiAset(tanggalCutOff: string): string {
  return `${PENANDA_MIGRASI_ASET} per ${tanggalCutOff} — aset lama, TIDAK dibeli lewat kas pada tanggal import.`;
}

export function adalahAsetMigrasi(keterangan: string | null | undefined): boolean {
  return typeof keterangan === 'string' && keterangan.includes(PENANDA_MIGRASI_ASET);
}

export const KETERBATASAN_MIGRASI_ASET: readonly string[] = [
  'Akumulasi penyusutan DIHITUNG dari nilai perolehan, nilai residu, masa manfaat, dan tanggal perolehan — bukan diambil dari pembukuan lama. Bila berbeda, selesaikan lewat koreksi saldo awal agar selisihnya terlihat.',
  'Metode penyusutan yang dipakai garis lurus, dan bulan perolehan dihitung penuh. Aset yang di pembukuan lama memakai metode lain akan berbeda akumulasinya.',
  'Migrasi aset TIDAK menjurnal pembelian: kas tidak berkurang. Saldo awal akun Aset Tetap dan Akumulasi Penyusutan diisi otomatis pada tanggal cut-off.',
  'Periode penyusutan sebelum cut-off ditandai sudah diakui, sehingga penyusutan berjalan hanya untuk periode sesudahnya — beban tahun-tahun lalu tidak diakui ulang.',
];
