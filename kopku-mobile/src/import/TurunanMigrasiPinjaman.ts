import { Rupiah } from '@/utils/money';
import { bagiPokokSisa } from '@/import/MigrasiPinjamanPlan';
import { hitungJadwalAngsuran } from '@/accounting/PinjamanCalculator';

/**
 * RC-S103 — MELENGKAPI KOLOM MIGRASI SECARA OTOMATIS (MODUL MURNI).
 *
 * ============================================================
 * MASALAH YANG DIPERBAIKI
 * ============================================================
 * RC-S102 membuat jalur migrasi saldo awal pinjaman berjalan, tetapi
 * mewajibkan berkas Excel memuat lima kolom tambahan (Nomor Pinjaman
 * Lama, Sisa Pokok, Angsuran Tersisa, Tunggakan Pokok, Piutang Jasa).
 * Koperasi yang datanya berasal dari pembukuan lama praktis harus
 * menyusun ulang berkasnya lebih dulu — pekerjaan manual yang justru
 * jadi sumber kesalahan baru (salah rumus, salah pembulatan, nomor
 * ganda).
 *
 * Padahal tiga dari lima kolom itu DAPAT DITURUNKAN dari kolom yang
 * memang sudah wajib ada di template: Jumlah Pinjaman, Tenor, dan
 * Angsuran Sudah Dibayar. Modul ini yang menurunkannya.
 *
 * ============================================================
 * YANG DITURUNKAN, DAN YANG SENGAJA TIDAK
 * ============================================================
 * DITURUNKAN:
 *   - `sisaPokok`        <- lihat `sisaPokokDariAngsuranDibayar`
 *   - `angsuranTersisa`  <- tenor - angsuranSudahDibayar
 *   - `nomorPinjamanLama` <- `nomorMigrasiOtomatis` (deterministik)
 *
 * TIDAK DITURUNKAN — dibiarkan kosong:
 *   - `tunggakanPokok` — berkas sumber tidak memuat data tunggakan.
 *     Menurunkannya berarti MENGARANG kolektibilitas: menebak bahwa
 *     angsuran yang jatuh tempo sebelum cut-off belum dibayar padahal
 *     jumlah angsuran dibayar sudah dihitung terpisah. Dibiarkan kosong
 *     (= 0, lancar), dan keterbatasan ini dilaporkan pada hasil import.
 *   - `piutangJasa` — hanya benar bila koperasi memang mengakui jasa
 *     secara akrual di pembukuan lamanya. Aplikasi tidak bisa
 *     mengetahuinya dari berkas.
 *
 * Kolom yang SUDAH DIISI di berkas selalu MENANG atas hasil turunan —
 * angka dari pembukuan koperasi lebih otoritatif daripada angka
 * turunan, dan itulah sebabnya kolomnya tetap ada.
 */

/** Kolom yang nilainya berasal dari turunan, bukan dari berkas. */
export type KolomDiturunkan = 'NOMOR_PINJAMAN_LAMA' | 'SISA_POKOK' | 'ANGSURAN_TERSISA';

export interface BarisDasarMigrasi {
  baris: number;
  kode: string;
  jumlahPinjaman: Rupiah;
  tenor: number;
  angsuranSudahDibayar: number;
  nomorPinjamanLama?: string;
  sisaPokok?: Rupiah;
  angsuranTersisa?: number;
  /** RC-S133.4.5 — bila diisi, sisa pokok diturunkan dari jadwal akad yang SAMA dengan pinjaman baru (bukan pembagian rata ulang). */
  metodeJasa?: 'FLAT' | 'MENURUN' | 'EFEKTIF' | 'CUSTOM';
  persentaseJasa?: number;
}

export interface HasilTurunanMigrasi {
  nomorPinjamanLama: string;
  sisaPokok: Rupiah;
  angsuranTersisa: number;
  /** Kolom mana saja yang diisi oleh turunan — dilaporkan ke pengguna. */
  diturunkan: KolomDiturunkan[];
}

/**
 * Nomor pinjaman pengganti, dipakai HANYA bila berkas tidak memuat nomor
 * akad lama. Bentuknya deterministik (kode anggota + nomor baris) supaya:
 *   - import ulang berkas yang sama menghasilkan nomor yang SAMA,
 *     sehingga tertahan oleh UNIQUE `pinjaman.nomor_pinjaman` alih-alih
 *     membuat duplikat pinjaman;
 *   - satu anggota dengan beberapa pinjaman tetap dapat nomor berbeda;
 *   - awalan `SA-` menandai asalnya dari saldo awal, bukan akad asli.
 */
export function nomorMigrasiOtomatis(kode: string, baris: number): string {
  const kodeBersih = kode.trim().toUpperCase().replace(/\s+/g, '-');
  return `SA-${kodeBersih}-${String(baris).padStart(4, '0')}`;
}

/**
 * Sisa pokok pada cut-off = jumlah angsuran POKOK yang belum jatuh
 * bagiannya, dihitung dari pembagian pokok yang SAMA PERSIS dengan yang
 * dipakai `susunJadwalSisa()`.
 *
 * Kenapa dihitung lewat `bagiPokokSisa()` dan bukan dengan rumus lepas
 * seperti `jumlahPinjaman - dibayar * (jumlahPinjaman / tenor)`: sisa
 * pokok hasil fungsi ini menjadi masukan `susunJadwalSisa()`, yang
 * membagi pokoknya LAGI dengan `bagiPokokSisa()`. Bila pembagian di sini
 * memakai aturan pembulatan yang BERBEDA, kedua sisi berselisih beberapa
 * rupiah dan total buku pembantu tidak lagi sama dengan saldo awal akun
 * Piutang — selisih yang kemudian ditangkap `rekonsiliasiPiutang()`
 * sebagai kegagalan yang membingungkan. Karena itu aturan pembagiannya
 * dipakai SATU sumber: pokok dibagi dengan `bagiPokokSisa()` (sisa
 * pembagian ditaruh pada angsuran TERAKHIR, sehingga jumlah seluruh
 * angsuran persis sama dengan pokok), lalu yang dijumlahkan adalah
 * bagian EKOR-nya — angsuran yang belum dibayar.
 *
 * Catatan kejujuran: untuk pembagian ber-`Math.floor` seperti ini, rumus
 * `jumlahPinjaman - dibayar * Math.floor(jumlahPinjaman / tenor)`
 * ternyata memberi hasil yang SAMA; yang menyimpang adalah varian
 * ber-`Math.round`. Jadi alasan sebenarnya bukan "rumus naif salah
 * hitung", melainkan "aturan pembulatan harus satu sumber" — lihat test
 * RC-S103 §A yang membuktikan keduanya.
 *
 * Konsekuensi yang disengaja: hasilnya selalu utuh (tidak ada rupiah
 * yang hilang atau tercipta), dan bila `angsuranSudahDibayar` = 0 maka
 * hasilnya persis `jumlahPinjaman`.
 */
export function sisaPokokDariAngsuranDibayar(
  jumlahPinjaman: Rupiah,
  tenor: number,
  angsuranSudahDibayar: number,
  metodeJasa?: 'FLAT' | 'MENURUN' | 'EFEKTIF' | 'CUSTOM',
  persentaseJasa?: number
): Rupiah {
  if (!Number.isInteger(tenor) || tenor <= 0) return 0;
  const dibayar = Math.max(0, Math.min(tenor, Math.trunc(angsuranSudahDibayar)));
  // RC-S133.4.5 — pokok per angsuran diambil dari kalkulator jadwal
  // pinjaman baru (pembulatan sama persis dengan kartu angsuran anggota).
  // Dulu dibagi rata ke bawah dengan sisa di angsuran terakhir, sehingga
  // sisa pokok hasil turunan berbeda beberapa rupiah dari jadwal aslinya
  // (kasus nyata: Rp254.135.316 vs Rp254.135.300).
  let pokokPerAngsuran: number[];
  if (metodeJasa && metodeJasa !== 'CUSTOM' && jumlahPinjaman > 0) {
    pokokPerAngsuran = hitungJadwalAngsuran({
      jumlahPinjaman,
      tenor,
      persentaseJasaPerPeriode: Number.isFinite(persentaseJasa) && (persentaseJasa as number) > 0 ? (persentaseJasa as number) : 0,
      metode: metodeJasa,
    }).map((b) => b.pokok);
  } else {
    pokokPerAngsuran = bagiPokokSisa(jumlahPinjaman, tenor);
  }
  let sisa = 0;
  for (let i = dibayar; i < tenor; i++) sisa += pokokPerAngsuran[i];
  return sisa;
}

/**
 * Jumlah angsuran tersisa = tenor - angsuran sudah dibayar (tidak pernah
 * negatif; dibayar lebih dari tenor dianggap sudah habis).
 */
export function angsuranTersisaDariTenor(tenor: number, angsuranSudahDibayar: number): number {
  if (!Number.isInteger(tenor) || tenor <= 0) return 0;
  const dibayar = Math.max(0, Math.min(tenor, Math.trunc(angsuranSudahDibayar)));
  return tenor - dibayar;
}

/**
 * Lengkapi satu baris. Nilai yang SUDAH ADA di berkas dipakai apa adanya;
 * hanya yang kosong yang diturunkan, dan setiap penurunan dicatat pada
 * `diturunkan` supaya bisa dilaporkan ke pengguna secara jujur.
 */
export function lengkapiBarisMigrasi(r: BarisDasarMigrasi): HasilTurunanMigrasi {
  const diturunkan: KolomDiturunkan[] = [];

  let nomorPinjamanLama = r.nomorPinjamanLama?.trim() ?? '';
  if (nomorPinjamanLama === '') {
    nomorPinjamanLama = nomorMigrasiOtomatis(r.kode, r.baris);
    diturunkan.push('NOMOR_PINJAMAN_LAMA');
  }

  let sisaPokok = r.sisaPokok;
  if (sisaPokok === undefined) {
    sisaPokok = sisaPokokDariAngsuranDibayar(r.jumlahPinjaman, r.tenor, r.angsuranSudahDibayar, r.metodeJasa, r.persentaseJasa);
    diturunkan.push('SISA_POKOK');
  }

  let angsuranTersisa = r.angsuranTersisa;
  if (angsuranTersisa === undefined) {
    angsuranTersisa = angsuranTersisaDariTenor(r.tenor, r.angsuranSudahDibayar);
    diturunkan.push('ANGSURAN_TERSISA');
  }

  return { nomorPinjamanLama, sisaPokok, angsuranTersisa, diturunkan };
}

/**
 * Pinjaman yang menurut data sudah tidak punya saldo (angsuran dibayar >=
 * tenor, atau sisa pokoknya 0) TIDAK dimigrasikan: tidak ada saldo yang
 * perlu dibawa, dan `validasiMigrasiPinjaman` memang menolak sisa pokok
 * 0. Baris seperti ini dilewati dengan sebab yang jelas, BUKAN
 * dilaporkan sebagai kesalahan berkas.
 */
export function pinjamanSudahTidakBersaldo(h: HasilTurunanMigrasi): boolean {
  return h.sisaPokok <= 0 || h.angsuranTersisa <= 0;
}

export const PESAN_SUDAH_LUNAS =
  'Menurut data, seluruh angsuran pinjaman ini sudah dibayar sebelum tanggal cut-off ' +
  '(tidak ada sisa pokok), jadi tidak ada saldo yang perlu dimigrasikan. Baris dilewati.';

/**
 * Keterbatasan yang WAJIB ditampilkan ketika kolom migrasi diturunkan
 * otomatis. Angka turunan memang membuat import bisa jalan tanpa berkas
 * disusun ulang, tetapi ia TIDAK menggantikan rekonsiliasi terhadap
 * pembukuan koperasi.
 */
export const KETERBATASAN_TURUNAN: readonly string[] = [
  'Sisa pokok dihitung dari Jumlah Pinjaman, Tenor, dan Angsuran Sudah Dibayar — bukan dibaca dari pembukuan lama. Cocokkan totalnya dengan neraca sebelum memposting saldo awal.',
  'Angsuran Sudah Dibayar pada banyak berkas hasil ekspor sistem lama sendiri merupakan angka estimasi. Bila pembukuan memuat saldo pokok yang sesungguhnya, isi kolom Sisa Pokok agar dipakai apa adanya.',
  'Tunggakan dihitung dari jadwal akad: angsuran yang jatuh temponya sebelum cut-off dan belum termasuk "Angsuran Sudah Dibayar" dianggap menunggak — periksa daftar kolektibilitas setelah import.',
  'Piutang Jasa dianggap 0. Isi hanya bila koperasi memang mengakui jasa secara akrual di pembukuan lamanya.',
  'Nomor Pinjaman Lama dibangkitkan otomatis berpola SA-<kode anggota>-<baris> bila berkas tidak memuatnya. Isi nomor akad yang sesungguhnya bila ada, karena nomor inilah penjaga agar import ulang tidak menggandakan data.',
];
