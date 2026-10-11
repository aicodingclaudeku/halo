/**
 * RC-S67 — KEBIJAKAN PENDAPATAN KOPERASI (menu canonical "Pendapatan Koperasi").
 *
 * Berkas ini TIDAK membuat keputusan akuntansi baru. Setiap entri hanya
 * MENGUTIP keputusan / pola yang sudah terkunci di repository, supaya
 * leaf menu tidak meminta operator memilih akun yang sudah diputuskan:
 *
 *  - Jalur jurnal : `PendapatanLainnyaService.tambahTransaksiPendapatan`
 *                   -> `KasBankService.catatPemasukan` -> `createJournal`
 *                   (Dr Kas/Bank, Cr akun pendapatan). CASH-BASIS — ini
 *                   pola existing yang didokumentasikan pada komentar
 *                   `defaultCOA.ts` untuk 4-1400/4-1500/4-1600.
 *  - Akun bunga   : KEPUTUSAN 01-B DIREVISI RC-S70.6 (instruksi eksplisit
 *                   pengguna; lihat POLICY_ADDENDUM_RC-S70.6.md) — akun
 *                   SPESIFIK: Usaha Lain -> 4-1520 Pendapatan Bunga
 *                   Investasi, Deposito Berjangka -> 4-1510 Pendapatan
 *                   Bunga Deposito. 4-1500 BUKAN target transaksi baru
 *                   untuk kedua kategori itu (dikunci
 *                   `AKUN_WAJIB_PENDAPATAN_BUNGA`). Pemetaan lama
 *                   "4-1510/4-1520 -> 4-1500" berstatus DEPRECATED dan hanya
 *                   berlaku untuk jurnal historis yang sudah terposting.
 *  - Akun sewa    : KEPUTUSAN 01-A — pasangan 1-1250 <-> 4-1600; 4-1600
 *                   "Pendapatan Sewa" (HASIL_INVESTASI) di defaultCOA.
 *
 * TIDAK ADA akrual/piutang di sini: POLICY 06 `ACCRUAL = DISABLED`,
 * tabel `investasi` tidak menyimpan rate/tenor/kontrak, dan 1-1220/1-1240/
 * 1-1250 tidak dipetakan untuk bunga/sewa. Mengaktifkan akrual adalah
 * keputusan kebijakan tersendiri.
 *
 * Kode akun sengaja berada di CONFIG (pola sama dengan
 * `coaPolicyRegistry.ts`), bukan di service. Menambah `account_mapping`
 * baru memerlukan kenaikan SCHEMA_VERSION (self-heal mapping hanya jalan
 * saat upgrade versi) — itu migrasi, dan RC-S67 dilarang bermigrasi tanpa
 * persetujuan.
 */

import type { JenisInvestasiInput } from '@/services/InvestasiService';

export type KategoriPendapatanInvestasi = 'IMBAL_HASIL_TETAP' | 'BUNGA_USAHA_LAIN' | 'BUNGA_DEPOSITO' | 'SEWA_PROPERTI';

export interface KebijakanPendapatanInvestasi {
  /** Label tampilan & nilai kolom `kas_transaksi.kategori`/`bank_transaksi.kategori`. */
  readonly label: string;
  /** Jenis investasi sumber yang WAJIB dirujuk. */
  readonly jenisInvestasi: JenisInvestasiInput;
  /** Akun pendapatan (kode COA existing). */
  readonly akunKode: string;
  /** Rujukan keputusan/evidence. */
  readonly sumberKebijakan: string;
  /**
   * RC-S70.6 — pasangan (label kategori, kode akun) yang dipakai leaf ini
   * SEBELUM kebijakan akun berubah. HANYA dibaca untuk menampilkan riwayat
   * lama pada leaf yang sama; tidak pernah dipakai untuk posting. Data
   * historis tidak diubah.
   */
  readonly riwayatHistoris?: readonly { readonly label: string; readonly akunKode: string }[];
  /**
   * RC-S67.6 — bila true, nomor dokumen WAJIB dan menjadi bagian identity
   * idempotensi bisnis (jenis + investasi + nomor dokumen), bukan sekadar
   * kunci submit.
   */
  readonly wajibDokumen?: boolean;
}

export const KEBIJAKAN_PENDAPATAN_INVESTASI: Readonly<Record<KategoriPendapatanInvestasi, KebijakanPendapatanInvestasi>> = {
  // RC-S67.6 — penerimaan KAS imbal hasil tetap dari penyertaan pada koperasi
  // lain. CASH-BASIS: Dr Kas/Bank / Cr 4-1700. Akrual (1-1240) TETAP nonaktif
  // (KEPUTUSAN 06 tidak berubah; register investasi_bagian_shu tetap hanya
  // BAGIAN_SHU). 4-1700 = akun yang dicadangkan untuk imbal hasil tetap
  // (coaPolicyRegistry.ts, catatan 4-1540: "1-1240/4-1700 dicadangkan untuk
  // imbal hasil tetap"). Pengaktifan: instruksi eksplisit pengguna RC-S67.6 —
  // lihat POLICY_ADDENDUM_RC-S67.6.md.
  IMBAL_HASIL_TETAP: {
    label: 'Imbal Hasil Tetap',
    jenisInvestasi: 'KOPERASI_LAIN',
    akunKode: '4-1700',
    sumberKebijakan: 'coaPolicyRegistry (1-1240/4-1700 dicadangkan untuk imbal hasil tetap) + POLICY_ADDENDUM_RC-S67.6 (cash-basis)',
    wajibDokumen: true,
  },
  // RC-S70.6 — akun spesifik (KEPUTUSAN 01-B direvisi). Transaksi lama yang
  // terposting ke 4-1500 TETAP di 4-1500; tidak ada migrasi/reklasifikasi.
  BUNGA_USAHA_LAIN: {
    label: 'Pendapatan Bunga Investasi',
    jenisInvestasi: 'USAHA_LAIN',
    akunKode: '4-1520',
    sumberKebijakan: 'KEPUTUSAN 01-B direvisi RC-S70.6 (Usaha Lain -> 4-1520 Pendapatan Bunga Investasi)',
    riwayatHistoris: [{ label: 'Pendapatan Bunga Usaha Lain', akunKode: '4-1500' }],
  },
  BUNGA_DEPOSITO: {
    label: 'Pendapatan Bunga Deposito',
    jenisInvestasi: 'DEPOSITO_BANK_UMUM',
    akunKode: '4-1510',
    sumberKebijakan: 'KEPUTUSAN 01-B direvisi RC-S70.6 (Deposito Berjangka -> 4-1510 Pendapatan Bunga Deposito)',
    riwayatHistoris: [{ label: 'Pendapatan Bunga Deposito', akunKode: '4-1500' }],
  },
  SEWA_PROPERTI: {
    label: 'Pendapatan Sewa Properti Investasi',
    jenisInvestasi: 'PROPERTI_INVESTASI',
    akunKode: '4-1600',
    sumberKebijakan: 'KEPUTUSAN 01-A (pasangan 1-1250 <-> 4-1600) dan defaultCOA 4-1600',
  },
};

// ============================================================
// RC-S70.6 — KUNCI KERAS AKUN PENDAPATAN BUNGA
// ============================================================
//
// Lapisan kedua di atas `KEBIJAKAN_PENDAPATAN_INVESTASI`: kategori bunga
// hanya sah bila diposting ke akun spesifiknya. Tidak ada fallback — akun
// lain (termasuk 4-1500 dan akun bunga milik kategori lain) DITOLAK.

export const AKUN_WAJIB_PENDAPATAN_BUNGA: Readonly<Record<'BUNGA_USAHA_LAIN' | 'BUNGA_DEPOSITO', { readonly kode: string; readonly nama: string }>> = {
  BUNGA_USAHA_LAIN: { kode: '4-1520', nama: 'Pendapatan Bunga Investasi' },
  BUNGA_DEPOSITO: { kode: '4-1510', nama: 'Pendapatan Bunga Deposito' },
};

/**
 * Pesan penolakan bila `akunKode` bukan akun yang sah untuk `kategori`;
 * `null` bila sah. Untuk kategori bunga, akun wajib = AKUN_WAJIB_PENDAPATAN_BUNGA;
 * untuk kategori lain, akun wajib = `KEBIJAKAN_PENDAPATAN_INVESTASI[kategori].akunKode`.
 */
export function periksaAkunKategoriPendapatanInvestasi(kategori: KategoriPendapatanInvestasi, akunKode: string): string | null {
  const wajib =
    kategori === 'BUNGA_USAHA_LAIN' || kategori === 'BUNGA_DEPOSITO'
      ? AKUN_WAJIB_PENDAPATAN_BUNGA[kategori].kode
      : KEBIJAKAN_PENDAPATAN_INVESTASI[kategori].akunKode;
  const kode = (akunKode ?? '').trim();
  if (kode === wajib) return null;
  return `Akun ${kode || '(kosong)'} tidak sah untuk ${KEBIJAKAN_PENDAPATAN_INVESTASI[kategori].label}; wajib ${wajib}.`;
}

/**
 * Jenis investasi sumber Bagian SHU: penyertaan pada koperasi lain.
 * Satu sumber kebenaran untuk filter UI (InvestasiPicker) DAN validasi
 * service (BagianShuService.catatBagianShuInvestasi).
 */
export const JENIS_INVESTASI_BAGIAN_SHU: JenisInvestasiInput = 'KOPERASI_LAIN';

export const SEMUA_KATEGORI_PENDAPATAN_INVESTASI: readonly KategoriPendapatanInvestasi[] = [
  'IMBAL_HASIL_TETAP',
  'BUNGA_USAHA_LAIN',
  'BUNGA_DEPOSITO',
  'SEWA_PROPERTI',
];

export function isKategoriPendapatanInvestasi(x: unknown): x is KategoriPendapatanInvestasi {
  return typeof x === 'string' && (SEMUA_KATEGORI_PENDAPATAN_INVESTASI as readonly string[]).includes(x);
}

/**
 * Leaf yang SENGAJA tidak dapat dipakai untuk transaksi. Saat ini kosong.
 *
 * "Pendapatan Unit Usaha" adalah leaf pendapatan (Cr 4-1400) — lihat
 * KEBIJAKAN_PENDAPATAN_UNIT_USAHA. Pengembalian RAKU bukan pendapatan dan
 * tidak ada di menu ini (Penerimaan > RAKU, Cr 1-1800).
 */
export const LEAF_TIDAK_AKTIF: Readonly<Record<string, { status: string; alasan: string }>> = {};


// ============================================================
// PENDAPATAN UNIT USAHA (akun tetap 4-1400)
// ============================================================
//
// COA existing: 4-1400 — Pendapatan Unit Usaha (defaultCOA.ts; PENDAPATAN,
// KREDIT, non-sistem, LHU PENDAPATAN_USAHA_LAIN). Akun dirujuk lewat kode
// di config ini karena tidak ada baris account_mapping untuknya.
//
// CASH-BASIS: hanya penerimaan yang SUDAH menjadi hak koperasi dan SUDAH
// diterima di kas/bank. Bukan penjualan kredit, piutang usaha, akrual,
// pendapatan diterima dimuka, RAKU, atau pelepasan aset.
//
// Atribusi per unit usaha tidak ada: kas_transaksi/bank_transaksi tidak
// punya kolom unit_usaha_id. 4-1400 adalah akun pendapatan unit usaha
// secara AGREGAT.

export interface KebijakanPendapatanUnitUsaha {
  /** Label tampilan. */
  readonly label: string;
  /** Nilai kolom `kas_transaksi.kategori` / `bank_transaksi.kategori`. */
  readonly kategoriTransaksi: 'PENDAPATAN_UNIT_USAHA';
  /** Akun pendapatan (kode COA existing). */
  readonly akunKode: string;
  /** Klasifikasi LHU yang WAJIB dimiliki akun agar boleh dipakai. */
  readonly klasifikasiLhuWajib: 'PENDAPATAN_USAHA_LAIN';
  /** Prefiks identitas idempotensi berbasis nomor dokumen. */
  readonly prefiksIdentitas: string;
  readonly sumberKebijakan: string;
}

export const KEBIJAKAN_PENDAPATAN_UNIT_USAHA: KebijakanPendapatanUnitUsaha = {
  label: 'Pendapatan Unit Usaha',
  kategoriTransaksi: 'PENDAPATAN_UNIT_USAHA',
  akunKode: '4-1400',
  klasifikasiLhuWajib: 'PENDAPATAN_USAHA_LAIN',
  prefiksIdentitas: 'PENDAPATAN_UNIT_USAHA',
  sumberKebijakan: 'Instruksi eksplisit pengguna RC-S70.3; COA existing 4-1400 (defaultCOA.ts)',
};

/**
 * Akun pendapatan yang HANYA boleh diposting lewat menu dedicated-nya,
 * sehingga tidak ada dua entry point untuk akun yang sama.
 * `PendapatanLainnyaService` menyembunyikannya dari dropdown generik DAN
 * menolaknya di service (bukan hanya di UI).
 */
export const AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED: readonly string[] = [KEBIJAKAN_PENDAPATAN_UNIT_USAHA.akunKode];
