/**
 * RC-S84 — MENU PAJAK: aturan MURNI (tanpa I/O, tanpa react-native).
 *
 * Berkas ini adalah satu-satunya tempat angka & aturan pajak ditulis.
 * Service (PajakService.ts) dan layar hanya memanggil fungsi di sini,
 * sehingga setiap angka bisa diuji langsung tanpa database.
 *
 * DASAR REGULASI yang dicerminkan (diverifikasi September 2026; WAJIB
 * dikonfirmasi ulang ke konsultan pajak sebelum tarif/batas diubah):
 *   - PP 55/2022 jo. PP 20/2026 (berlaku 22 April 2026): koperasi dengan
 *     peredaran bruto tahun sebelumnya <= Rp4,8 miliar boleh memakai
 *     PPh Final 0,5%, paling lama 4 tahun pajak sejak terdaftar.
 *     Ketentuan peralihan: koperasi yang jangka waktunya menurut
 *     PP 55/2022 berakhir pada tahun pajak 2024–2029 tetap boleh
 *     memakainya sampai tahun pajak 2029.
 *   - Koperasi di luar skema final: PPh Badan tarif umum, dibayar lewat
 *     angsuran PPh Pasal 25 dan dilunasi lewat PPh Pasal 29.
 *
 * YANG SENGAJA TIDAK ADA DI SINI (keputusan kebijakan belum diambil):
 *   - Pemotongan PPh 21/23 (di luar bunga simpanan). Menyentuh form
 *     Beban & Imbalan Kerja — ditunda sampai keputusan kebijakan
 *     tertulis ada.
 *   - Lebih bayar PPh Badan (restitusi vs kompensasi). Ditolak keras.
 *
 * RC-S86 — PPh PASAL 4(2) ATAS BUNGA SIMPANAN (lihat §di bawah).
 * Dasar: PP 15/2009 — bunga simpanan yang dibayarkan koperasi kepada
 * anggota koperasi orang pribadi dikenai PPh final: 0% s.d. Rp240.000
 * per bulan, 10% dari bruto atas bagian yang melebihi itu. PP 15/2009
 * juga menegaskan bunga simpanan yang merupakan BAGIAN DARI SHU tidak
 * termasuk pengertian "bunga simpanan" yang dikenai ketentuan ini —
 * karena itu engine ini HANYA dipasang di siklus Simpanan Berjangka
 * (`SimpananBerjangkaLifecycleService`), tidak pernah di jalur SHU.
 * Administrasi setor/lapor mengikuti ketentuan yang berlaku saat ini
 * (PMK 81/2024 mencabut PMK 112/PMK.03/2010 dalam kerangka Coretax);
 * WAJIB dikonfirmasi ulang ke konsultan pajak sebelum go-live.
 */

import type { Rupiah } from '@/utils/money';
import { formatRupiah } from '@/utils/money';

// ---------------------------------------------------------------------------
// Akun
// ---------------------------------------------------------------------------

export interface AkunPajakSeed {
  kode: string;
  nama: string;
  kategori: 'ASET' | 'LIABILITAS';
  normalBalance: 'DEBIT' | 'KREDIT';
}

/** Akun induk "Utang Pajak" yang SUDAH ADA di defaultCOA (2-1900). Tidak disentuh. */
export const KODE_UTANG_PAJAK_UMUM = '2-1900';
/** Akun beban pajak yang SUDAH ADA (5-2200) — dibaca LHU sebagai baris pajak. Tidak disentuh. */
export const KODE_BEBAN_PAJAK = '5-2200';

export const KODE_UTANG_PPH_FINAL = '2-1904';
export const KODE_UTANG_PPH_29 = '2-1905';
export const KODE_PAJAK_DIBAYAR_DIMUKA = '1-1410';
/**
 * RC-S86 — Utang PPh Pasal 4(2) atas Bunga Simpanan. Kode ini SUDAH
 * dicadangkan sejak RC-S84 (komentar lama). Ini PAJAK YANG DIPOTONG
 * KOPERASI DARI ANGGOTA (penghasilan anggota), BUKAN beban pajak
 * koperasi — karena itu TIDAK PERNAH menyentuh 5-2200.
 */
export const KODE_UTANG_PPH_BUNGA_SIMPANAN = '2-1901';
/**
 * RC-S87 — Pajak Dibayar Dimuka atas PPh 22/23/24 yang dipotong/dipungut
 * PIHAK LAIN dari penghasilan koperasi. Kredit pajak PPh Badan (bukan beban).
 */
export const KODE_PAJAK_DIBAYAR_DIMUKA_LAIN = '1-1411';

/**
 * Akun BARU menu Pajak. Disisipkan idempoten (cek per kode) saat
 * transaksi pajak pertama dicatat — pola sama dengan self-heal COA,
 * tanpa migrasi skema. 2-1902..2-1903 masih dicadangkan untuk PPh
 * 21/23 dan belum dibuat.
 */
export const AKUN_PAJAK_BARU: readonly AkunPajakSeed[] = [
  { kode: KODE_PAJAK_DIBAYAR_DIMUKA, nama: 'Pajak Dibayar Dimuka (PPh 25)', kategori: 'ASET', normalBalance: 'DEBIT' },
  { kode: KODE_UTANG_PPH_FINAL, nama: 'Utang PPh Final', kategori: 'LIABILITAS', normalBalance: 'KREDIT' },
  { kode: KODE_UTANG_PPH_29, nama: 'Utang PPh Pasal 29', kategori: 'LIABILITAS', normalBalance: 'KREDIT' },
  { kode: KODE_UTANG_PPH_BUNGA_SIMPANAN, nama: 'Utang PPh Pasal 4(2) Bunga Simpanan', kategori: 'LIABILITAS', normalBalance: 'KREDIT' },
  { kode: KODE_PAJAK_DIBAYAR_DIMUKA_LAIN, nama: 'Pajak Dibayar Dimuka (PPh 22/23/24)', kategori: 'ASET', normalBalance: 'DEBIT' },
];

/** Akun utang pajak yang boleh disetor lewat menu Setor Pajak. */
export const KODE_UTANG_PAJAK_SETORAN: readonly string[] = [
  KODE_UTANG_PPH_FINAL,
  KODE_UTANG_PPH_29,
  KODE_UTANG_PPH_BUNGA_SIMPANAN,
  KODE_UTANG_PAJAK_UMUM,
];

/** Seluruh akun yang ditelusuri Riwayat Pajak. */
export const KODE_AKUN_RIWAYAT_PAJAK: readonly string[] = [
  KODE_BEBAN_PAJAK,
  KODE_PAJAK_DIBAYAR_DIMUKA,
  KODE_PAJAK_DIBAYAR_DIMUKA_LAIN,
  ...KODE_UTANG_PAJAK_SETORAN,
];

/** Jenis pajak per akun utang — dipakai label setoran. */
export const JENIS_PAJAK_PER_AKUN: Record<string, string> = {
  [KODE_UTANG_PPH_FINAL]: 'PPh Final 0,5%',
  [KODE_UTANG_PPH_29]: 'PPh Pasal 29',
  [KODE_UTANG_PPH_BUNGA_SIMPANAN]: 'PPh Pasal 4(2) Bunga Simpanan',
  [KODE_UTANG_PAJAK_UMUM]: 'Utang Pajak Lainnya',
};

// ---------------------------------------------------------------------------
// Sumber transaksi & kunci
// ---------------------------------------------------------------------------

/** Jurnal pengakuan pajak NON-KAS (PPh Final, PPh Badan). Terdaftar NON_KAS di CashFlowClassification. */
export const SUMBER_PENGAKUAN_PAJAK = 'PAJAK_PENGAKUAN';

export const kunciPphFinal = (masa: string) => `PPH_FINAL:${masa}`;
export const kunciPphBadan = (tahun: number) => `PPH_BADAN:${tahun}`;
/** Kunci idempotensi kas/bank untuk angsuran PPh 25 — satu angsuran per masa. */
export const kunciAngsuranPph25 = (masa: string) => `PAJAK:PPH25:${masa}`;

// ---------------------------------------------------------------------------
// Pengaturan & kelayakan PPh Final
// ---------------------------------------------------------------------------

export type SkemaPajak = 'FINAL_UMKM' | 'UMUM';

export interface PengaturanPajak {
  skema: SkemaPajak;
  /** Tahun koperasi terdaftar sebagai wajib pajak (NPWP). */
  tahunTerdaftar: number;
}

export const CONFIG_KEY_PENGATURAN_PAJAK = 'pajak.pengaturan';

export const TARIF_PPH_FINAL_PERMIL = 5; // 0,5% = 5 per seribu — integer, tanpa pecahan
export const BATAS_OMZET_FINAL: Rupiah = 4_800_000_000;
export const TAHUN_AKHIR_PERALIHAN_PP20_2026 = 2029;
export const LAMA_FASILITAS_FINAL_TAHUN = 4;

/**
 * Label DEKLARASI (bukan rezim efektif — rezim efektif per tahun ada di
 * `LABEL_REZIM`, dihitung `tentukanRezimPajak`).
 */
export const LABEL_SKEMA: Record<SkemaPajak, string> = {
  FINAL_UMKM: 'Memakai PPh Final UMKM 0,5%',
  UMUM: 'Tidak memakai PPh Final (PPh Badan)',
};

/**
 * Tahun pajak TERAKHIR koperasi boleh memakai PPh Final 0,5%.
 *
 *   - Jangka dasar: 4 tahun pajak sejak tahun terdaftar
 *     (tahunTerdaftar .. tahunTerdaftar + 3).
 *   - Terdaftar sebelum 2018: hitungan PP 23/2018 dimulai 2018, jadi
 *     jangka dasarnya berakhir 2021.
 *   - Peralihan PP 20/2026: bila jangka dasar berakhir di 2024–2029,
 *     fasilitas diperpanjang sampai 2029.
 */
export function tahunAkhirFasilitasFinal(tahunTerdaftar: number): number {
  const mulai = Math.max(tahunTerdaftar, 2018);
  const akhirDasar = mulai + LAMA_FASILITAS_FINAL_TAHUN - 1;
  if (akhirDasar >= 2024 && akhirDasar <= TAHUN_AKHIR_PERALIHAN_PP20_2026) return TAHUN_AKHIR_PERALIHAN_PP20_2026;
  return akhirDasar;
}

export type HasilKelayakanFinal =
  | { layak: true; tahunAkhir: number }
  | { layak: false; tahunAkhir: number | null; alasan: string };

export function cekKelayakanFinal(pengaturan: PengaturanPajak | null, tahunPajak: number): HasilKelayakanFinal {
  if (!pengaturan) {
    return { layak: false, tahunAkhir: null, alasan: 'Pengaturan pajak belum diisi. Buka Pengaturan Pajak terlebih dahulu.' };
  }
  if (pengaturan.skema !== 'FINAL_UMKM') {
    return { layak: false, tahunAkhir: null, alasan: 'Skema pajak koperasi adalah PPh Badan tarif umum, bukan PPh Final.' };
  }
  const tahunAkhir = tahunAkhirFasilitasFinal(pengaturan.tahunTerdaftar);
  if (tahunPajak < pengaturan.tahunTerdaftar) {
    return { layak: false, tahunAkhir, alasan: `Masa pajak ${tahunPajak} mendahului tahun terdaftar (${pengaturan.tahunTerdaftar}).` };
  }
  if (tahunPajak > tahunAkhir) {
    return {
      layak: false,
      tahunAkhir,
      alasan: `Fasilitas PPh Final 0,5% berakhir pada tahun pajak ${tahunAkhir}. Mulai ${tahunAkhir + 1} koperasi memakai PPh Badan tarif umum — ubah skema di Pengaturan Pajak.`,
    };
  }
  return { layak: true, tahunAkhir };
}

export function validasiPengaturanPajak(p: { skema: string; tahunTerdaftar: number }, tahunSekarang: number): string | null {
  if (p.skema !== 'FINAL_UMKM' && p.skema !== 'UMUM') return 'Pilih skema pajak koperasi.';
  if (!Number.isInteger(p.tahunTerdaftar)) return 'Tahun terdaftar wajib diisi angka tahun.';
  if (p.tahunTerdaftar < 1945 || p.tahunTerdaftar > tahunSekarang) {
    return `Tahun terdaftar harus antara 1945 dan ${tahunSekarang}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Perhitungan
// ---------------------------------------------------------------------------

/**
 * PPh Final 0,5% dari peredaran bruto. Pembulatan KE BAWAH ke rupiah
 * penuh (integer-only Rupiah; tidak pernah menagih lebih dari tarif).
 */
export function hitungPphFinal(omzet: Rupiah): Rupiah {
  if (!Number.isInteger(omzet) || omzet < 0) throw new Error('Peredaran bruto harus bilangan bulat rupiah dan tidak negatif.');
  return Math.floor((omzet * TARIF_PPH_FINAL_PERMIL) / 1000);
}

// ---------------------------------------------------------------------------
// PPh Pasal 4(2) — Bunga Simpanan (RC-S86)
// ---------------------------------------------------------------------------

/** Batas bebas PPh per BULAN MASA BUNGA (bukan per pembayaran). PP 15/2009. */
export const BATAS_BUNGA_SIMPANAN_PPH_BEBAS: Rupiah = 240_000;
export const TARIF_PPH_BUNGA_SIMPANAN_PERSEN = 10;

/**
 * PPh Pasal 4(2) atas SATU bulan masa bunga simpanan anggota.
 *
 * Masukan = TOTAL bruto bunga simpanan SATU ANGGOTA untuk satu bulan,
 * seluruh produk digabung (RC-S127 — lihat `hitungPphBungaSimpananAgregat`).
 * 0% jika bunga bulan itu <= Rp240.000; 10% dari BRUTO bulan itu jika
 * melebihi — bukan 10% dari total bila beberapa bulan dibayar sekaligus
 * (lihat `hitungPphBungaSimpananPeriode` untuk kasus multi-bulan).
 * Pembulatan KE BAWAH ke rupiah penuh, sama seperti `hitungPphFinal`.
 */
export function hitungPphBungaSimpanan(brutoBulanIni: Rupiah): Rupiah {
  if (!Number.isInteger(brutoBulanIni) || brutoBulanIni < 0) {
    throw new Error('Bunga bruto per bulan harus bilangan bulat rupiah dan tidak negatif.');
  }
  if (brutoBulanIni <= BATAS_BUNGA_SIMPANAN_PPH_BEBAS) return 0;
  return Math.floor((brutoBulanIni * TARIF_PPH_BUNGA_SIMPANAN_PERSEN) / 100);
}

/**
 * RC-S127 — AGREGASI PER ANGGOTA PER BULAN MASA, LINTAS PRODUK
 * (keputusan pengurus, dicatat di ATURAN_BISNIS.md).
 *
 * Batas Rp240.000 diuji terhadap JUMLAH SELURUH bunga simpanan yang
 * dibayarkan koperasi kepada SATU anggota untuk SATU bulan masa bunga —
 * Sukarela + Berjangka (dan produk bunga simpanan lain yang menyusul).
 * Bila jumlahnya melebihi batas, tarif 10% dikenakan atas SELURUH bruto
 * bulan itu, bukan hanya kelebihannya.
 *
 * Karena bunga satu bulan bisa dibayar dalam beberapa peristiwa (transfer
 * §B berjangka di tengah bulan, akrual sukarela di akhir bulan, pencairan
 * belakangan), PPh tiap peristiwa = PPh atas TOTAL bulan sesudah peristiwa
 * ini − PPh yang SUDAH dipotong peristiwa sebelumnya pada bulan yang sama.
 * Akibatnya:
 *  - peristiwa yang membuat total melewati batas memotong SUSULAN atas
 *    bunga bulan itu yang sebelumnya dipotong 0% (bisa melebihi bruto
 *    peristiwa itu sendiri — neto negatif ditarik dari saldo anggota);
 *  - koreksi turun yang membuat total kembali <= batas menghasilkan PPh
 *    negatif (pengembalian potongan) — total potongan selalu sama dengan
 *    PPh atas total bruto bulan itu.
 */
export interface PosisiPphBungaBulanan {
  /** Bruto bunga bulan masa ini yang SUDAH dibayar & dipotong (peristiwa sebelumnya, masih berlaku). */
  brutoSudah: Rupiah;
  /** PPh yang SUDAH dipotong atas bruto itu. */
  pajakSudah: Rupiah;
}

export function hitungPphBungaSimpananAgregat(posisi: PosisiPphBungaBulanan, brutoBaru: Rupiah): Rupiah {
  if (!Number.isInteger(brutoBaru) || !Number.isInteger(posisi.brutoSudah) || !Number.isInteger(posisi.pajakSudah)) {
    throw new Error('Bunga & PPh harus bilangan bulat rupiah.');
  }
  const total = Math.max(0, posisi.brutoSudah + brutoBaru);
  return hitungPphBungaSimpanan(total) - posisi.pajakSudah;
}

export interface PeriodeBungaSimpananPajak {
  /** id baris `simpanan_berjangka_bunga` — identitas periode & kunci telusur. */
  bungaPeriodeId: string;
  nomorPeriode: number;
  /** Tanggal akhir periode — SUMBER masa pajak (YYYY-MM), bukan tanggal pembayaran. */
  tanggalAkhirPeriode: string;
  /** Bunga BRUTO bulan ini (kontraktual, dari `simpanan_berjangka_bunga.bunga`). */
  bruto: Rupiah;
}

export interface RincianPajakPeriode {
  bungaPeriodeId: string;
  nomorPeriode: number;
  masaPajak: string;
  bruto: Rupiah;
  pajak: Rupiah;
  netto: Rupiah;
}

export interface HasilHitungPajakBungaSimpanan {
  totalBruto: Rupiah;
  totalPajak: Rupiah;
  totalNetto: Rupiah;
  perPeriode: RincianPajakPeriode[];
}

/**
 * Menghitung PPh 4(2) untuk SEKELOMPOK bulan masa bunga yang dibayarkan
 * BERSAMAAN (mis. beberapa bulan tertunggak dibayar sekaligus saat
 * pencairan). SETIAP bulan dihitung SENDIRI-SENDIRI terhadap batas
 * Rp240.000 — TIDAK digabung dulu baru dikalikan tarif. Ini sesuai
 * contoh resmi PP 15/2009: Jan 250rb + Feb 150rb + Mar 100rb dibayar
 * sekaligus bulan April -> PPh HANYA dari Januari (Rp25.000), bukan
 * 10% x Rp500.000.
 */
export function hitungPphBungaSimpananPeriode(periods: readonly PeriodeBungaSimpananPajak[]): HasilHitungPajakBungaSimpanan {
  const perPeriode: RincianPajakPeriode[] = periods.map((p) => {
    const pajak = hitungPphBungaSimpanan(p.bruto);
    return {
      bungaPeriodeId: p.bungaPeriodeId,
      nomorPeriode: p.nomorPeriode,
      masaPajak: p.tanggalAkhirPeriode.slice(0, 7),
      bruto: p.bruto,
      pajak,
      netto: p.bruto - pajak,
    };
  });
  return {
    totalBruto: perPeriode.reduce((s, p) => s + p.bruto, 0),
    totalPajak: perPeriode.reduce((s, p) => s + p.pajak, 0),
    totalNetto: perPeriode.reduce((s, p) => s + p.netto, 0),
    perPeriode,
  };
}

/** Jenis peristiwa pembayaran yang memicu pemotongan PPh 4(2) bunga simpanan. */
export type PeristiwaBayarBungaSimpanan = 'TRANSFER_SUKARELA' | 'PENCAIRAN';

export const LABEL_PERISTIWA_BAYAR_BUNGA: Record<PeristiwaBayarBungaSimpanan, string> = {
  TRANSFER_SUKARELA: 'Pemindahan ke Simpanan Sukarela',
  PENCAIRAN: 'Pencairan Simpanan Berjangka',
};

export interface RincianPphBadan {
  terutang: Rupiah;
  kreditPph25: Rupiah;
  kurangBayar: Rupiah;
}

/**
 * PPh Badan akhir tahun: kredit pajak = saldo Pajak Dibayar Dimuka
 * (angsuran PPh 25). Lebih bayar DITOLAK — perlakuannya (restitusi atau
 * kompensasi) adalah keputusan kebijakan yang belum diambil.
 */
export function hitungPphBadan(terutang: Rupiah, saldoPph25: Rupiah): RincianPphBadan {
  if (!Number.isInteger(terutang) || terutang <= 0) throw new Error('PPh terutang harus lebih dari 0.');
  const kredit = Math.max(0, saldoPph25);
  if (kredit > terutang) {
    throw new Error(
      'Angsuran PPh 25 melebihi PPh terutang (lebih bayar). Perlakuan lebih bayar — restitusi atau kompensasi — belum ditetapkan kebijakannya, sehingga belum dapat dicatat di aplikasi.'
    );
  }
  return { terutang, kreditPph25: kredit, kurangBayar: terutang - kredit };
}

// ---------------------------------------------------------------------------
// Masa pajak, NTPN, keterangan
// ---------------------------------------------------------------------------

const NAMA_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

export function labelMasa(masa: string): string {
  const [t, b] = masa.split('-').map(Number);
  return `${NAMA_BULAN[b - 1] ?? '?'} ${t}`;
}

/** Daftar masa pajak (YYYY-MM) dari yang terbaru, `jumlah` bulan ke belakang. */
export function daftarMasa(periodeSekarang: string, jumlah = 12): string[] {
  const [t, b] = periodeSekarang.split('-').map(Number);
  const hasil: string[] = [];
  for (let i = 0; i < jumlah; i++) {
    const total = t * 12 + (b - 1) - i;
    hasil.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`);
  }
  return hasil;
}

/** NTPN: 16 karakter huruf/angka. Kosong diperbolehkan (dilengkapi kemudian lewat catatan). */
export function normalisasiNtpn(ntpn: string): string {
  return ntpn.replace(/\s+/g, '').toUpperCase();
}

export function validasiNtpn(ntpn: string): string | null {
  const n = normalisasiNtpn(ntpn);
  if (!n) return null;
  if (!/^[A-Z0-9]{16}$/.test(n)) return 'NTPN terdiri dari 16 huruf/angka.';
  return null;
}

/**
 * Keterangan jurnal setoran — format TETAP supaya terbaca di Buku Besar
 * & Riwayat Pajak tanpa tabel tambahan:
 *   "Setor <jenis> · Masa <bulan tahun> · NTPN <ntpn>"
 */
export function susunKeteranganSetoran(jenis: string, masa: string, ntpn: string, catatan?: string): string {
  const bagian = [`Setor ${jenis}`, `Masa ${labelMasa(masa)}`];
  const n = normalisasiNtpn(ntpn);
  if (n) bagian.push(`NTPN ${n}`);
  const c = catatan?.trim();
  if (c) bagian.push(c);
  return bagian.join(' · ');
}

export function susunKeteranganAngsuranPph25(masa: string, ntpn: string, catatan?: string): string {
  return susunKeteranganSetoran('Angsuran PPh Pasal 25', masa, ntpn, catatan);
}

// ===========================================================================
// RC-S87 — TAX REGIME ENGINE: PPh Final UMKM 0,5% | PPh Badan Pasal 31E | PPh Badan Tarif Umum
// ===========================================================================
//
// TERMINOLOGI (dikunci test): 11% dan 22% adalah PPh BADAN NON-FINAL.
// Tidak ada — dan tidak boleh ada — enum/label yang menyebut tarif 11%
// atau 22% sebagai pajak final. Satu-satunya pajak final di sini adalah
// PPh Final UMKM 0,5% atas peredaran bruto.
//
// `SkemaPajak` (FINAL_UMKM | UMUM) TETAP ada sebagai DEKLARASI koperasi
// (apakah memakai fasilitas PPh Final). Rezim EFEKTIF per tahun pajak
// dihitung `tentukanRezimPajak()` — operator tidak pernah memilih tarif.

export type RezimPajak = 'FINAL_UMKM' | 'BADAN_31E' | 'BADAN_UMUM';

/**
 * RC-S87.5 — label ringkas untuk tampilan sederhana. Tetap menyebut
 * "PPh Badan" untuk 11%/22% (non-final); hanya 0,5% yang "PPh Final".
 */
export const LABEL_REZIM_SINGKAT: Record<RezimPajak, string> = {
  FINAL_UMKM: 'PPh Final 0,5%',
  BADAN_31E: 'PPh Badan (tarif efektif 11%)',
  BADAN_UMUM: 'PPh Badan (tarif 22%)',
};

/** RC-S87.5 — arti rezim dalam satu kalimat sehari-hari. */
export const ARTI_REZIM: Record<RezimPajak, string> = {
  FINAL_UMKM: 'Bayar 0,5% dari omzet setiap bulan.',
  BADAN_31E: 'Pajak dihitung dari laba setahun dengan potongan tarif, dicicil tiap bulan.',
  BADAN_UMUM: 'Pajak 22% dari laba setahun, dicicil tiap bulan.',
};

export const LABEL_REZIM: Record<RezimPajak, string> = {
  FINAL_UMKM: 'PPh Final UMKM 0,5%',
  BADAN_31E: 'PPh Badan – Fasilitas Pasal 31E (tarif efektif 11%)',
  BADAN_UMUM: 'PPh Badan – Tarif Umum 22%',
};

/**
 * Parameter regulasi yang DIVERSIKAN. Perubahan regulasi = tambah versi
 * baru di daftar ini; service & UI tidak disentuh. Snapshot yang sudah
 * dikunci menyimpan salinan parameter versinya sendiri, jadi versi baru
 * tidak pernah mengubah hasil lama.
 *
 * Dasar (WAJIB dikonfirmasi konsultan pajak sebelum go-live):
 *  - Tarif PPh Badan 22%: UU 2/2020 (tahun pajak 2020–2021) dan UU 7/2021
 *    (HPP) Pasal 17 ayat (1) huruf b (tahun pajak 2022 dst.).
 *  - Pasal 31E UU PPh: WP badan dengan peredaran bruto s.d. Rp50 miliar
 *    mendapat pengurangan tarif 50% atas PKP dari bagian peredaran bruto
 *    s.d. Rp4,8 miliar.
 *  - Pasal 17 ayat (4) UU PPh: PKP dibulatkan ke bawah dalam ribuan rupiah penuh.
 *  - PP 55/2022 jo. PP 20/2026: PPh Final UMKM 0,5% (lihat bagian RC-S84 di atas).
 */
export interface KebijakanPajakVersi {
  versi: string;
  berlakuMulaiTahun: number;
  tarifPphBadanPersen: number;
  persenPenguranganTarif31E: number;
  batasPeredaranBrutoBagianFasilitas31E: Rupiah;
  batasPeredaranBrutoPenerima31E: Rupiah;
  pembulatanPkp: number;
  batasOmzetFinal: Rupiah;
  tarifPphFinalPermil: number;
  /** Tanggal batas setor angsuran PPh 25 pada bulan berikutnya. */
  tanggalJatuhTempoPph25: number;
  /** Tanggal batas setor PPh Final UMKM pada bulan berikutnya. */
  tanggalJatuhTempoPphFinal: number;
  dasarAturan: string[];
}

export const KEBIJAKAN_PAJAK: readonly KebijakanPajakVersi[] = [
  {
    versi: 'KOPKU-PAJAK-2026.1',
    berlakuMulaiTahun: 2020,
    tarifPphBadanPersen: 22,
    persenPenguranganTarif31E: 50,
    batasPeredaranBrutoBagianFasilitas31E: 4_800_000_000,
    batasPeredaranBrutoPenerima31E: 50_000_000_000,
    pembulatanPkp: 1000,
    batasOmzetFinal: BATAS_OMZET_FINAL,
    tarifPphFinalPermil: TARIF_PPH_FINAL_PERMIL,
    tanggalJatuhTempoPph25: 15,
    tanggalJatuhTempoPphFinal: 15,
    dasarAturan: [
      'UU PPh Pasal 17 ayat (1) huruf b jo. UU 7/2021 (HPP) — tarif PPh Badan 22%',
      'UU PPh Pasal 31E — pengurangan tarif 50% atas PKP dari bagian peredaran bruto s.d. Rp4,8 miliar, peredaran bruto s.d. Rp50 miliar',
      'UU PPh Pasal 17 ayat (4) — PKP dibulatkan ke bawah ribuan rupiah penuh',
      'PP 55/2022 jo. PP 20/2026 — PPh Final UMKM 0,5%',
      'UU PPh Pasal 25 ayat (1) — angsuran bulanan = (PPh terutang tahun lalu − kredit PPh 21/22/23/24) ÷ 12',
    ],
  },
];

export function kebijakanUntukTahun(tahun: number): KebijakanPajakVersi {
  const cocok = [...KEBIJAKAN_PAJAK].filter((k) => k.berlakuMulaiTahun <= tahun).sort((a, b) => b.berlakuMulaiTahun - a.berlakuMulaiTahun)[0];
  if (!cocok) throw new Error(`Kebijakan pajak untuk tahun pajak ${tahun} belum tersedia di aplikasi.`);
  return cocok;
}

// ---------------------------------------------------------------------------
// Resolver rezim (murni)
// ---------------------------------------------------------------------------

export interface OverrideRezim {
  rezim: RezimPajak;
  alasan: string;
  nomorDokumen: string;
}

export interface InputRezimPajak {
  tahunPajak: number;
  pengaturan: PengaturanPajak | null;
  /** Peredaran bruto per tahun dari ledger, untuk tahun-tahun SEBELUM tahunPajak (yang tersedia). */
  omzetPerTahun: Readonly<Record<number, Rupiah>>;
  omzetTahunBerjalan: Rupiah;
  override: OverrideRezim | null;
}

export interface HasilRezimPajak {
  tahunPajak: number;
  rezim: RezimPajak | null;
  sumber: 'OTOMATIS' | 'OVERRIDE' | 'BELUM_DIATUR';
  alasan: string[];
  peringatan: string[];
  dasarAturan: string[];
  tahunAkhirFasilitasFinal: number | null;
  /** Tahun pajak pertama koperasi keluar dari PPh Final karena omzet (null = belum pernah). */
  tahunKeluarFinalKarenaOmzet: number | null;
  parameter: {
    versiKebijakan: string;
    omzetTahunSebelumnya: Rupiah;
    omzetTahunBerjalan: Rupiah;
    batasOmzetFinal: Rupiah;
    batasPeredaranBrutoPenerima31E: Rupiah;
    skemaDeklarasi: SkemaPajak | null;
    tahunTerdaftar: number | null;
  };
}

function rezimBadanDariOmzet(omzet: Rupiah, k: KebijakanPajakVersi): RezimPajak {
  return omzet <= k.batasPeredaranBrutoPenerima31E ? 'BADAN_31E' : 'BADAN_UMUM';
}

/**
 * Menentukan rezim PPh koperasi untuk satu tahun pajak.
 *
 *  1. Belum ada pengaturan -> tidak diputuskan (BELUM_DIATUR).
 *  2. Deklarasi FINAL_UMKM tetap FINAL kecuali:
 *     a. jangka waktu fasilitas habis (cekKelayakanFinal, PP 20/2026);
 *     b. peredaran bruto suatu tahun sebelumnya > Rp4,8 miliar -> tarif
 *        umum MULAI tahun pajak berikutnya, dan tidak kembali ke final.
 *     Omzet TAHUN BERJALAN yang melewati batas TIDAK mengakhiri fasilitas
 *     tahun ini — hanya peringatan (berlaku mulai tahun berikutnya).
 *  3. Rezim badan: Pasal 31E bila peredaran bruto tahun pajak <= Rp50 miliar,
 *     selain itu tarif umum. Untuk tahun berjalan omzet belum final ->
 *     peringatan.
 *  4. Override (dokumen eksternal) menang, tetapi selisihnya dengan hasil
 *     otomatis dicatat sebagai peringatan.
 */
export function tentukanRezimPajak(input: InputRezimPajak): HasilRezimPajak {
  const k = kebijakanUntukTahun(input.tahunPajak);
  const p = input.pengaturan;
  const omzetLalu = input.omzetPerTahun[input.tahunPajak - 1] ?? 0;
  const dasar: HasilRezimPajak = {
    tahunPajak: input.tahunPajak,
    rezim: null,
    sumber: 'BELUM_DIATUR',
    alasan: [],
    peringatan: [],
    dasarAturan: [...k.dasarAturan],
    tahunAkhirFasilitasFinal: p ? tahunAkhirFasilitasFinal(p.tahunTerdaftar) : null,
    tahunKeluarFinalKarenaOmzet: null,
    parameter: {
      versiKebijakan: k.versi,
      omzetTahunSebelumnya: omzetLalu,
      omzetTahunBerjalan: input.omzetTahunBerjalan,
      batasOmzetFinal: k.batasOmzetFinal,
      batasPeredaranBrutoPenerima31E: k.batasPeredaranBrutoPenerima31E,
      skemaDeklarasi: p?.skema ?? null,
      tahunTerdaftar: p?.tahunTerdaftar ?? null,
    },
  };
  if (!p) {
    dasar.alasan.push('Pengaturan pajak belum diisi.');
    return dasar;
  }

  // Tahun pertama omzet melewati batas (hanya tahun < tahunPajak yang relevan).
  const tahunLewat = Object.keys(input.omzetPerTahun)
    .map(Number)
    .filter((t) => t < input.tahunPajak && t >= p.tahunTerdaftar && (input.omzetPerTahun[t] ?? 0) > k.batasOmzetFinal)
    .sort((a, b) => a - b)[0];
  dasar.tahunKeluarFinalKarenaOmzet = tahunLewat !== undefined ? tahunLewat + 1 : null;

  let otomatis: RezimPajak;
  if (p.skema === 'FINAL_UMKM') {
    const kelayakan = cekKelayakanFinal(p, input.tahunPajak);
    if (!kelayakan.layak) {
      otomatis = rezimBadanDariOmzet(input.omzetTahunBerjalan, k);
      dasar.alasan.push(kelayakan.alasan);
    } else if (tahunLewat !== undefined) {
      otomatis = rezimBadanDariOmzet(input.omzetTahunBerjalan, k);
      dasar.alasan.push(
        `Peredaran bruto tahun ${tahunLewat} melebihi Rp4,8 miliar; mulai tahun pajak ${tahunLewat + 1} koperasi dikenai PPh Badan (non-final) dan tidak kembali ke PPh Final.`
      );
    } else {
      otomatis = 'FINAL_UMKM';
      dasar.alasan.push(`Koperasi memakai PPh Final UMKM dan masih dalam jangka waktu fasilitas (s.d. tahun pajak ${kelayakan.tahunAkhir}).`);
      dasar.alasan.push(`Peredaran bruto tahun sebelumnya tercatat ${omzetLalu.toLocaleString('id-ID')}, tidak melebihi Rp4,8 miliar.`);
      if (input.omzetTahunBerjalan > k.batasOmzetFinal) {
        dasar.peringatan.push(
          'Peredaran bruto tahun berjalan sudah melebihi Rp4,8 miliar. PPh Final tetap berlaku sampai akhir tahun pajak ini; mulai tahun pajak berikutnya koperasi dikenai PPh Badan.'
        );
      }
    }
  } else {
    otomatis = rezimBadanDariOmzet(input.omzetTahunBerjalan, k);
    dasar.alasan.push('Koperasi tidak memakai PPh Final UMKM (deklarasi di Pengaturan Pajak).');
  }
  if (otomatis !== 'FINAL_UMKM') {
    dasar.alasan.push(
      otomatis === 'BADAN_31E'
        ? 'Peredaran bruto tahun pajak tidak melebihi Rp50 miliar — berhak fasilitas Pasal 31E.'
        : 'Peredaran bruto tahun pajak melebihi Rp50 miliar — tidak berhak fasilitas Pasal 31E, seluruh PKP dikenai tarif umum.'
    );
    dasar.peringatan.push('Penentuan Pasal 31E memakai peredaran bruto tahun pajak ini; untuk tahun yang masih berjalan angkanya belum final.');
  }

  if (input.override) {
    dasar.rezim = input.override.rezim;
    dasar.sumber = 'OVERRIDE';
    dasar.alasan.unshift(`Ditetapkan manual berdasarkan dokumen ${input.override.nomorDokumen}: ${input.override.alasan}`);
    if (input.override.rezim !== otomatis) {
      dasar.peringatan.push(`Hasil otomatis sistem adalah ${LABEL_REZIM[otomatis]}; berbeda dengan penetapan manual.`);
    }
    return dasar;
  }
  dasar.rezim = otomatis;
  dasar.sumber = 'OTOMATIS';
  return dasar;
}

// ---------------------------------------------------------------------------
// Kalkulator PPh Badan (Pasal 31E + tarif umum) — murni, integer/BigInt
// ---------------------------------------------------------------------------

export interface KreditPajakBadan {
  pph25: Rupiah;
  pph22: Rupiah;
  pph23: Rupiah;
  pph24: Rupiah;
}

export interface InputPphBadan {
  rezim: 'BADAN_31E' | 'BADAN_UMUM';
  peredaranBruto: Rupiah;
  /** PKP SEBELUM pembulatan (laba komersial + koreksi positif − koreksi negatif). */
  pkpSebelumPembulatan: Rupiah;
  kredit: KreditPajakBadan;
  kebijakan: KebijakanPajakVersi;
}

export interface HasilPphBadan {
  versiKebijakan: string;
  rezim: 'BADAN_31E' | 'BADAN_UMUM';
  peredaranBruto: Rupiah;
  pkpSebelumPembulatan: Rupiah;
  pkp: Rupiah;
  batasOmzetFasilitas: Rupiah;
  /** Nilai pecahan PKP fasilitas sebelum dibulatkan (string desimal, untuk audit). */
  pkpFasilitasEksak: string;
  pkpFasilitas: Rupiah;
  tarifFasilitasPersen: number;
  pphFasilitas: Rupiah;
  pkpNonFasilitas: Rupiah;
  tarifUmumPersen: number;
  pphNonFasilitas: Rupiah;
  totalPphBadan: Rupiah;
  kredit: KreditPajakBadan;
  totalKredit: Rupiah;
  pph29: Rupiah;
  lebihBayar: Rupiah;
}

function pastikanRupiah(n: number, nama: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${nama} harus bilangan bulat rupiah.`);
}

/**
 * PPh Badan non-final.
 *
 *   PKP                = floor(PKP sebelum pembulatan / 1000) × 1000; <= 0 -> 0
 *   PKP fasilitas      = PKP                                   bila bruto <= Rp4,8 M
 *                      = floor(Rp4,8 M × PKP / bruto)          bila Rp4,8 M < bruto <= Rp50 M
 *                      = 0                                     bila bruto > Rp50 M atau rezim BADAN_UMUM
 *   PPh fasilitas      = floor(PKP fasilitas × 22% × (100% − 50%))   (tarif efektif 11%)
 *   PKP non-fasilitas  = PKP − PKP fasilitas
 *   PPh non-fasilitas  = floor(PKP non-fasilitas × 22%)
 *   Total PPh Badan    = PPh fasilitas + PPh non-fasilitas
 *   PPh 29             = max(0, Total − kredit);  lebih bayar = max(0, kredit − Total)
 *
 * Pembulatan hanya di titik yang ditentukan (PKP ke ribuan; setiap hasil
 * pajak & PKP fasilitas ke bawah ke rupiah penuh). Perhitungan antara
 * memakai BigInt — tidak ada floating point.
 */
export function hitungPphBadanNonFinal(input: InputPphBadan): HasilPphBadan {
  const k = input.kebijakan;
  pastikanRupiah(input.peredaranBruto, 'Peredaran bruto');
  pastikanRupiah(input.pkpSebelumPembulatan, 'PKP');
  for (const [nama, v] of Object.entries(input.kredit)) {
    pastikanRupiah(v, `Kredit ${nama}`);
    if (v < 0) throw new Error(`Kredit ${nama} tidak boleh negatif.`);
  }
  if (input.peredaranBruto < 0) throw new Error('Peredaran bruto tidak boleh negatif.');

  const pkp = input.pkpSebelumPembulatan <= 0 ? 0 : Math.floor(input.pkpSebelumPembulatan / k.pembulatanPkp) * k.pembulatanPkp;
  const batas = k.batasPeredaranBrutoBagianFasilitas31E;
  const berhak31E = input.rezim === 'BADAN_31E' && input.peredaranBruto <= k.batasPeredaranBrutoPenerima31E;

  let pkpFasilitas = 0;
  let eksak = '0';
  if (berhak31E && pkp > 0) {
    if (input.peredaranBruto <= batas) {
      pkpFasilitas = pkp;
      eksak = String(pkp);
    } else {
      const pembilang = BigInt(batas) * BigInt(pkp);
      const penyebut = BigInt(input.peredaranBruto);
      pkpFasilitas = Number(pembilang / penyebut);
      const sisa = pembilang % penyebut;
      eksak = sisa === 0n ? String(pkpFasilitas) : `${pkpFasilitas} ${sisa}/${penyebut}`;
    }
  }
  const tarifFasilitasPersen = (k.tarifPphBadanPersen * (100 - k.persenPenguranganTarif31E)) / 100;
  const pphFasilitas = Number((BigInt(pkpFasilitas) * BigInt(k.tarifPphBadanPersen) * BigInt(100 - k.persenPenguranganTarif31E)) / 10000n);
  const pkpNonFasilitas = pkp - pkpFasilitas;
  const pphNonFasilitas = Number((BigInt(pkpNonFasilitas) * BigInt(k.tarifPphBadanPersen)) / 100n);
  const totalPphBadan = pphFasilitas + pphNonFasilitas;
  const totalKredit = input.kredit.pph25 + input.kredit.pph22 + input.kredit.pph23 + input.kredit.pph24;

  return {
    versiKebijakan: k.versi,
    rezim: input.rezim,
    peredaranBruto: input.peredaranBruto,
    pkpSebelumPembulatan: input.pkpSebelumPembulatan,
    pkp,
    batasOmzetFasilitas: batas,
    pkpFasilitasEksak: eksak,
    pkpFasilitas,
    tarifFasilitasPersen,
    pphFasilitas,
    pkpNonFasilitas,
    tarifUmumPersen: k.tarifPphBadanPersen,
    pphNonFasilitas,
    totalPphBadan,
    kredit: { ...input.kredit },
    totalKredit,
    pph29: Math.max(0, totalPphBadan - totalKredit),
    lebihBayar: Math.max(0, totalKredit - totalPphBadan),
  };
}

// ---------------------------------------------------------------------------
// PPh 25 — jadwal (murni)
// ---------------------------------------------------------------------------

/** Tanggal `tanggal` pada bulan SESUDAH masa `masa` (YYYY-MM). */
function tanggalBulanBerikutnya(masa: string, tanggal: number): string {
  const [t, b] = masa.split('-').map(Number);
  const total = t * 12 + b; // bulan berikutnya (0-based +1)
  const tahun = Math.floor(total / 12);
  const bulan = (total % 12) + 1;
  return `${tahun}-${String(bulan).padStart(2, '0')}-${String(tanggal).padStart(2, '0')}`;
}

/** Jatuh tempo setor angsuran PPh 25 masa `masa`: tanggal N bulan berikutnya. */
export function jatuhTempoPph25(masa: string, k: KebijakanPajakVersi): string {
  return tanggalBulanBerikutnya(masa, k.tanggalJatuhTempoPph25);
}

/** Jatuh tempo setor PPh Final UMKM masa `masa`. */
export function jatuhTempoPphFinal(masa: string, k: KebijakanPajakVersi): string {
  return tanggalBulanBerikutnya(masa, k.tanggalJatuhTempoPphFinal);
}

export type SumberDasarPph25 = 'PERHITUNGAN_TAHUN_LALU' | 'SPT_TAHUNAN' | 'SKP' | 'KEPUTUSAN_DJP' | 'LAINNYA';

export const LABEL_SUMBER_DASAR_PPH25: Record<SumberDasarPph25, string> = {
  PERHITUNGAN_TAHUN_LALU: 'Otomatis dari PPh Badan tahun lalu (terkunci)',
  SPT_TAHUNAN: 'SPT Tahunan tahun sebelumnya',
  SKP: 'Surat Ketetapan Pajak',
  KEPUTUSAN_DJP: 'Keputusan DJP (pengurangan/penyesuaian)',
  LAINNYA: 'Dokumen lain',
};



// ===========================================================================
// RC-S87.3 — RINCIAN PERHITUNGAN (satu format untuk semua jenis pajak)
// ===========================================================================
//
// Setiap perhitungan pajak menghasilkan daftar LANGKAH yang sama bentuknya,
// dirender satu komponen (`RincianPerhitungan` di PajakUi). Rumus dan
// angka dibangun DI SINI dari hasil kalkulator — UI tidak menghitung.

export type JenisLangkah = 'nilai' | 'tambah' | 'kurang' | 'dikecualikan' | 'subtotal' | 'tarif' | 'hasil';

export interface LangkahPerhitungan {
  label: string;
  jenis: JenisLangkah;
  /** Nominal rupiah; null untuk baris tarif/keterangan. */
  nilai: Rupiah | null;
  /** Teks pengganti nilai (mis. "0,5%"). */
  teks?: string;
  /** Rumus/keterangan singkat di bawah label. */
  rumus?: string;
  /** Asal data (mis. "Buku besar", "Koreksi fiskal", "Angsuran 2025-03"). */
  sumber?: string;
}

export interface RincianPerhitungan {
  judul: string;
  langkah: LangkahPerhitungan[];
  catatan: string[];
}

function persen(n: number): string {
  return `${n.toLocaleString('id-ID')}%`;
}

export interface AkunOmzetRincian {
  kode: string;
  nama: string;
  nilai: Rupiah;
  /** Diisi bila akun dikecualikan (alasan tercatat). */
  alasanDikecualikan?: string;
}

/** PPh Final UMKM satu masa. Angka pajak = hitungPphFinal(dasar). */
export function rincianPphFinal(input: { masa: string; akun: readonly AkunOmzetRincian[]; kebijakan: KebijakanPajakVersi }): RincianPerhitungan & { dasar: Rupiah; pajak: Rupiah; jatuhTempo: string } {
  const k = input.kebijakan;
  const langkah: LangkahPerhitungan[] = [];
  for (const a of input.akun) {
    if (a.nilai === 0) continue;
    langkah.push(
      a.alasanDikecualikan
        ? { label: `${a.kode} ${a.nama}`, jenis: 'dikecualikan', nilai: a.nilai, rumus: `Dikecualikan: ${a.alasanDikecualikan}`, sumber: 'Pengecualian terkonfigurasi' }
        : { label: `${a.kode} ${a.nama}`, jenis: 'tambah', nilai: a.nilai, sumber: 'Buku besar' }
    );
  }
  const dasar = input.akun.filter((a) => !a.alasanDikecualikan).reduce((t, a) => t + a.nilai, 0);
  const dasarPositif = Math.max(0, dasar);
  const pajak = dasarPositif > 0 ? hitungPphFinal(dasarPositif) : 0;
  const tarif = persen(k.tarifPphFinalPermil / 10);
  langkah.push({ label: 'Peredaran bruto (dasar pengenaan)', jenis: 'subtotal', nilai: dasarPositif });
  langkah.push({ label: 'Tarif PPh Final UMKM', jenis: 'tarif', nilai: null, teks: tarif });
  langkah.push({ label: 'PPh Final terutang', jenis: 'hasil', nilai: pajak, rumus: `Dasar × ${tarif}, dibulatkan ke bawah` });
  const jatuhTempo = jatuhTempoPphFinal(input.masa, k);
  return {
    judul: `PPh Final UMKM · ${labelMasa(input.masa)}`,
    langkah,
    catatan: [`Setor paling lambat ${jatuhTempo}.`, `Kebijakan ${k.versi}.`],
    dasar: dasarPositif,
    pajak,
    jatuhTempo,
  };
}

export interface KoreksiRincian {
  uraian: string;
  jenis: 'POSITIF' | 'NEGATIF';
  nilai: Rupiah;
  referensi?: string;
}

/** PPh Badan non-final (Pasal 31E / tarif umum) dari hasil kalkulator. */
export function rincianPphBadan(input: {
  tahun: number;
  hasil: HasilPphBadan;
  labaKomersial: Rupiah;
  koreksi: readonly KoreksiRincian[];
  angsuranPph25?: readonly { masa: string; nominal: Rupiah; ntpn: string | null }[];
}): RincianPerhitungan {
  const h = input.hasil;
  const L: LangkahPerhitungan[] = [];
  L.push({ label: 'Peredaran bruto setahun', jenis: 'nilai', nilai: h.peredaranBruto, sumber: 'Buku besar', rumus: 'Penentu hak & porsi fasilitas Pasal 31E' });
  L.push({ label: 'Laba komersial (SHU sebelum pajak)', jenis: 'nilai', nilai: input.labaKomersial, sumber: 'Laporan Hasil Usaha' });
  for (const k of input.koreksi) {
    L.push({ label: k.uraian, jenis: k.jenis === 'POSITIF' ? 'tambah' : 'kurang', nilai: k.nilai, sumber: 'Koreksi fiskal', rumus: k.referensi });
  }
  L.push({ label: 'PKP sebelum pembulatan', jenis: 'subtotal', nilai: h.pkpSebelumPembulatan });
  L.push({ label: 'Penghasilan Kena Pajak (PKP)', jenis: 'subtotal', nilai: h.pkp, rumus: 'Dibulatkan ke bawah ribuan penuh; rugi = 0' });

  const fas = h.tarifFasilitasPersen;
  if (h.pkpFasilitas > 0) {
    const rumusFas =
      h.peredaranBruto <= h.batasOmzetFasilitas
        ? `Bruto ≤ ${formatRupiah(h.batasOmzetFasilitas)} → seluruh PKP`
        : `${formatRupiah(h.batasOmzetFasilitas)} ÷ ${formatRupiah(h.peredaranBruto)} × PKP`;
    L.push({ label: 'PKP fasilitas Pasal 31E', jenis: 'nilai', nilai: h.pkpFasilitas, rumus: rumusFas });
    L.push({ label: `PPh fasilitas (tarif efektif ${persen(fas)})`, jenis: 'tambah', nilai: h.pphFasilitas, rumus: `PKP fasilitas × ${persen(h.tarifUmumPersen)} × 50%` });
  }
  if (h.pkpNonFasilitas > 0 || h.pkpFasilitas === 0) {
    L.push({ label: 'PKP non-fasilitas', jenis: 'nilai', nilai: h.pkpNonFasilitas, rumus: h.pkpFasilitas > 0 ? 'PKP − PKP fasilitas' : h.rezim === 'BADAN_UMUM' ? 'Rezim tarif umum — tanpa fasilitas' : 'Seluruh PKP' });
    L.push({ label: `PPh tarif umum (${persen(h.tarifUmumPersen)})`, jenis: 'tambah', nilai: h.pphNonFasilitas, rumus: `PKP non-fasilitas × ${persen(h.tarifUmumPersen)}` });
  }
  L.push({ label: 'PPh Badan terutang', jenis: 'subtotal', nilai: h.totalPphBadan });

  const angsuran = input.angsuranPph25 ?? [];
  if (angsuran.length > 0) {
    for (const a of angsuran) {
      L.push({ label: `Angsuran PPh 25 · ${labelMasa(a.masa)}`, jenis: 'kurang', nilai: a.nominal, sumber: a.ntpn ? `NTPN ${a.ntpn}` : 'Tanpa NTPN' });
    }
  } else if (h.kredit.pph25 > 0) {
    L.push({ label: 'Kredit PPh 25', jenis: 'kurang', nilai: h.kredit.pph25 });
  }
  if (h.kredit.pph22 > 0) L.push({ label: 'Kredit PPh 22', jenis: 'kurang', nilai: h.kredit.pph22, sumber: 'Bukti pungut' });
  if (h.kredit.pph23 > 0) L.push({ label: 'Kredit PPh 23', jenis: 'kurang', nilai: h.kredit.pph23, sumber: 'Bukti potong' });
  if (h.kredit.pph24 > 0) L.push({ label: 'Kredit PPh 24', jenis: 'kurang', nilai: h.kredit.pph24, sumber: 'Bukti pajak luar negeri' });
  L.push(
    h.lebihBayar > 0
      ? { label: 'Lebih bayar', jenis: 'hasil', nilai: h.lebihBayar, rumus: 'Kredit − PPh terutang' }
      : { label: 'PPh Pasal 29 (kurang bayar)', jenis: 'hasil', nilai: h.pph29, rumus: 'PPh terutang − seluruh kredit' }
  );
  return {
    judul: `PPh Badan tahun pajak ${input.tahun}`,
    langkah: L,
    catatan: [`${LABEL_REZIM[h.rezim]}.`, `Kebijakan ${h.versiKebijakan}.`],
  };
}

export interface HasilDasarPph25 {
  angsuranBulanan: Rupiah;
  rincian: RincianPerhitungan;
}

/**
 * Dasar angsuran PPh 25 menurut Pasal 25 ayat (1):
 *   (PPh terutang tahun lalu − PPh 22 − PPh 23 − PPh 24 tahun lalu) ÷ 12,
 * dibulatkan ke bawah ke rupiah; tidak pernah negatif. Hanya dipakai bila
 * perhitungan PPh Badan tahun lalu SUDAH DIKUNCI.
 */
export function hitungDasarPph25(input: { tahunPajak: number; pphTerutangTahunLalu: Rupiah; kreditPph22: Rupiah; kreditPph23: Rupiah; kreditPph24: Rupiah }): HasilDasarPph25 {
  for (const [n, v] of Object.entries(input)) if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${n} harus bilangan bulat rupiah dan tidak negatif.`);
  const dasar = input.pphTerutangTahunLalu - input.kreditPph22 - input.kreditPph23 - input.kreditPph24;
  const angsuranBulanan = dasar > 0 ? Math.floor(dasar / 12) : 0;
  const lalu = input.tahunPajak - 1;
  const L: LangkahPerhitungan[] = [{ label: `PPh Badan terutang ${lalu}`, jenis: 'nilai', nilai: input.pphTerutangTahunLalu, sumber: `Perhitungan PPh Badan ${lalu} (terkunci)` }];
  if (input.kreditPph22 > 0) L.push({ label: `PPh 22 dipungut ${lalu}`, jenis: 'kurang', nilai: input.kreditPph22 });
  if (input.kreditPph23 > 0) L.push({ label: `PPh 23 dipotong ${lalu}`, jenis: 'kurang', nilai: input.kreditPph23 });
  if (input.kreditPph24 > 0) L.push({ label: `PPh 24 ${lalu}`, jenis: 'kurang', nilai: input.kreditPph24 });
  L.push({ label: 'Dasar angsuran setahun', jenis: 'subtotal', nilai: Math.max(0, dasar), rumus: 'Angsuran PPh 25 tahun lalu tidak ikut dikurangkan' });
  L.push({ label: 'Dibagi', jenis: 'tarif', nilai: null, teks: '12 bulan' });
  L.push({ label: 'Angsuran PPh 25 per bulan', jenis: 'hasil', nilai: angsuranBulanan, rumus: 'Dibulatkan ke bawah' });
  return {
    angsuranBulanan,
    rincian: {
      judul: `Angsuran PPh 25 tahun ${input.tahunPajak}`,
      langkah: L,
      catatan: ['UU PPh Pasal 25 ayat (1).', 'Bila ada ketetapan/keputusan DJP yang berbeda, tetapkan dasar secara manual dengan dokumennya.'],
    },
  };
}
