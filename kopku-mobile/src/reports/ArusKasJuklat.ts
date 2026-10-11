import { Rupiah } from '@/utils/money';
import type { AktivitasKas } from '@/accounting/CashFlowClassification';

/**
 * RC-S104 — SUSUNAN LAPORAN ARUS KAS MENURUT JUKLAT SOM No. 3/2025
 * (MODUL MURNI).
 *
 * ============================================================
 * APA YANG DIPERBAIKI
 * ============================================================
 * Layar Arus Kas sebelumnya hanya menampilkan TIGA angka — satu total
 * per aktivitas — padahal `getArusKas()` sudah menelusuri setiap baris
 * jurnal kas. Pembaca laporan tidak bisa tahu kas operasinya berasal
 * dari mana: angsuran? simpanan? biaya operasional? Contoh resmi di
 * naskah justru memuat baris bernama di setiap bagian.
 *
 * Modul ini yang menamai dan mengurutkan baris itu. MURNI (tanpa
 * database/UI) supaya seluruh aturan penamaan & urutannya dapat diuji
 * langsung.
 *
 * ============================================================
 * URUTAN RESMI — dikutip dari contoh naskah (hlm. 73)
 * ============================================================
 *   KEGIATAN OPERASI      -> "Jumlah arus kas operasi"
 *   KEGIATAN INVESTASI    -> "Jumlah arus kas investasi"
 *   KEGIATAN PENDANAAN    -> "Jumlah arus kas pendanaan"
 *   KENAIKAN
 *   SALDO AWAL
 *   SALDO AKHIR
 *
 * ============================================================
 * DUA KETIDAKKONSISTENAN DI DALAM NASKAH — DIDOKUMENTASIKAN,
 * BUKAN DITIRU
 * ============================================================
 * 1. Butir 5.7(3) menyebut laporan diklasifikasikan menurut aktivitas
 *    "operasi dan pendanaan" saja — INVESTASI tidak disebut. Tetapi
 *    butir 5.7(4)(e) mendefinisikan aktivitas investasi, dan contoh
 *    resminya memuat bagian KEGIATAN INVESTASI lengkap dengan
 *    jumlahnya. Yang dipakai di sini adalah definisi + contoh (tiga
 *    aktivitas), bukan penyebutan di butir (3) yang jelas terlewat.
 *
 * 2. Contoh resminya menaruh "Penerimaan/pembayaran utang pinjaman
 *    kepada pihak lain" di KEGIATAN OPERASI, padahal butir 5.7(4)(f)
 *    mendefinisikan aktivitas pendanaan sebagai "aktivitas yang
 *    mengakibatkan perubahan dalam jumlah serta komposisi MODAL DAN
 *    PINJAMAN perusahaan" — yang persis menggambarkan utang koperasi
 *    kepada bank/pihak lain. Di sini yang dipakai adalah DEFINISI-nya
 *    (utang = PENDANAAN), karena definisi lebih mengikat daripada
 *    contoh, dan karena itu pula yang lazim di SAK EP. Keputusan ini
 *    ditampilkan terbuka di layar lewat `CATATAN_PENYAJIAN` di bawah.
 *
 * Simpanan sukarela & simpanan berjangka SEBALIKNYA dipindah ke
 * OPERASI (lihat CashFlowClassification.ts): di situ definisi 5.7(4)(d)
 * ("aktivitas penghasil utama pendapatan") DAN contoh resminya
 * SEPAKAT — dana simpanan itulah yang diputar koperasi menjadi
 * pinjaman dan menghasilkan jasa. Yang tetap di PENDANAAN hanya
 * simpanan pokok & wajib, yaitu modal anggota, persis seperti contoh
 * resminya ("Penambahan modal"/"Pengurangan modal").
 */

export type BagianArusKas = 'OPERASI' | 'INVESTASI' | 'PENDANAAN';

export interface BarisArusKas {
  /** Nama baris sebagaimana disajikan. */
  label: string;
  jumlah: Rupiah;
  /** Urutan tampil dalam bagiannya. */
  urutan: number;
}

export interface BagianTersusun {
  bagian: BagianArusKas;
  /** Judul bagian persis seperti naskah. */
  judul: string;
  nomor: string;
  baris: BarisArusKas[];
  /** Label jumlah bagian, persis seperti naskah. */
  labelJumlah: string;
  jumlah: Rupiah;
}

export const JUDUL_BAGIAN: Record<BagianArusKas, string> = {
  OPERASI: 'Kegiatan Operasi',
  INVESTASI: 'Kegiatan Investasi',
  PENDANAAN: 'Kegiatan Pendanaan',
};

export const LABEL_JUMLAH_BAGIAN: Record<BagianArusKas, string> = {
  OPERASI: 'Jumlah arus kas operasi',
  INVESTASI: 'Jumlah arus kas investasi',
  PENDANAAN: 'Jumlah arus kas pendanaan',
};

export const NOMOR_BAGIAN: Record<BagianArusKas, string> = {
  OPERASI: 'I',
  INVESTASI: 'II',
  PENDANAAN: 'III',
};

/** Urutan bagian — sama persis dengan contoh naskah. */
export const URUTAN_BAGIAN: readonly BagianArusKas[] = ['OPERASI', 'INVESTASI', 'PENDANAAN'];

/**
 * Nama baris per `sumber_transaksi`, mengikuti peristilahan contoh
 * naskah semirip mungkin. `urutan` mengikuti urutan baris pada contoh;
 * jenis transaksi yang tidak ada di contoh diberi urutan sesudahnya
 * (90+) supaya tidak menyela susunan resmi.
 *
 * Jenis yang TIDAK terdaftar di sini tetap tampil — dengan nama
 * apa adanya lewat `labelCadangan()`. Ia TIDAK dibuang diam-diam:
 * laporan yang menyembunyikan mutasi kas jauh lebih berbahaya
 * daripada laporan dengan satu nama baris yang kurang rapi.
 */
export const NAMA_BARIS: Record<string, { label: string; urutan: number }> = {
  // ---- KEGIATAN OPERASI, urut seperti contoh naskah ----
  SIMPANAN_SUKARELA: { label: 'Penerimaan simpanan anggota', urutan: 10 },
  SIMPANAN_BERJANGKA: { label: 'Penerimaan simpanan berjangka anggota', urutan: 11 },
  SIMPANAN_BERJANGKA_PENCAIRAN: { label: 'Pembayaran simpanan berjangka jatuh tempo', urutan: 12 },
  SIMPANAN_BERJANGKA_PENCAIRAN_DINI: { label: 'Pembayaran simpanan berjangka yang dicairkan dini', urutan: 13 },
  PENCAIRAN_PINJAMAN: { label: 'Penyaluran pinjaman kepada anggota', urutan: 20 },
  ANGSURAN_POKOK: { label: 'Penerimaan pokok pinjaman dari anggota', urutan: 21 },
  ANGSURAN_JASA: { label: 'Penerimaan jasa pinjaman dari anggota', urutan: 22 },
  ANGSURAN_DENDA: { label: 'Penerimaan denda keterlambatan', urutan: 23 },
  BIAYA_ADMIN_PINJAMAN: { label: 'Penerimaan biaya administrasi pinjaman', urutan: 24 },
  KAS_PENERIMAAN_LAIN: { label: 'Penerimaan kas lainnya', urutan: 30 },
  BANK_PENERIMAAN_LAIN: { label: 'Penerimaan bank lainnya', urutan: 31 },
  KAS_PENGELUARAN_LAIN: { label: 'Biaya operasional (kas)', urutan: 32 },
  BANK_PENGELUARAN_LAIN: { label: 'Biaya operasional (bank)', urutan: 33 },
  TRANSFER_BANK: { label: 'Pemindahan antar kas dan bank', urutan: 34 },
  REKONSILIASI_KAS_BANK: { label: 'Koreksi rekonsiliasi kas dan bank', urutan: 35 },
  ANGSURAN_PINJAMAN: { label: 'Penerimaan angsuran pinjaman anggota', urutan: 25 },
  BAGIAN_SHU_PENERIMAAN: { label: 'Penerimaan bagian SHU dari investasi', urutan: 26 },
  BIAYA_DIBAYAR_DIMUKA: { label: 'Pembayaran biaya dibayar di muka', urutan: 36 },
  PENDAPATAN_DITERIMA_DIMUKA: { label: 'Penerimaan pendapatan diterima di muka', urutan: 37 },
  UTANG_IMBALAN_KERJA_BAYAR: { label: 'Pembayaran imbalan kerja', urutan: 38 },

  // ---- KEGIATAN INVESTASI ----
  ASET_TETAP: { label: 'Perolehan dan pelepasan aset tetap', urutan: 10 },
  ASET_TAK_BERWUJUD: { label: 'Perolehan dan pelepasan aset takberwujud', urutan: 11 },
  INVESTASI_PROPERTI_INVESTASI: { label: 'Perolehan dan pelepasan properti investasi', urutan: 12 },
  INVESTASI_UNIT_USAHA: { label: 'Penyertaan pada unit usaha', urutan: 20 },
  INVESTASI_KOPERASI_LAIN: { label: 'Penyertaan pada koperasi lain', urutan: 21 },
  INVESTASI_USAHA_LAIN: { label: 'Penyertaan pada usaha lain', urutan: 22 },
  INVESTASI_TABUNGAN_BANK_UMUM: { label: 'Penempatan pada tabungan bank umum', urutan: 30 },
  INVESTASI_GIRO_BANK_UMUM: { label: 'Penempatan pada giro bank umum', urutan: 31 },
  INVESTASI_DEPOSITO_BANK_UMUM: { label: 'Penempatan pada deposito bank umum', urutan: 32 },
  RAK: { label: 'Rekening antar kantor/unit (RAKU)', urutan: 40 },
  RAK_PENGEMBALIAN_KAS: { label: 'Pengembalian rekening antar kantor/unit (kas)', urutan: 41 },
  RAK_PENGEMBALIAN_BANK: { label: 'Pengembalian rekening antar kantor/unit (bank)', urutan: 42 },
  PEMBERIAN_PINJAMAN_KOPERASI: { label: 'Pemberian pinjaman kepada koperasi lain', urutan: 23 },
  PELEPASAN_INVESTASI: { label: 'Pelepasan penyertaan dan investasi', urutan: 24 },
  PELEPASAN_ASET_TETAP: { label: 'Pelepasan aset tetap', urutan: 13 },

  // ---- KEGIATAN PENDANAAN ----
  SIMPANAN_POKOK: { label: 'Penambahan (pengurangan) modal — simpanan pokok', urutan: 10 },
  SIMPANAN_WAJIB: { label: 'Penambahan (pengurangan) modal — simpanan wajib', urutan: 11 },
  MODAL_UANG: { label: 'Penambahan modal disetor lainnya', urutan: 12 },
  MODAL_BARANG: { label: 'Penambahan modal berupa barang', urutan: 13 },
  KELUAR_ANGGOTA: { label: 'Pengembalian simpanan anggota keluar', urutan: 14 },
  UTANG_BANK: { label: 'Penerimaan (pembayaran) utang bank', urutan: 20 },
  UTANG_PIHAK_LAIN: { label: 'Penerimaan (pembayaran) utang pihak lain', urutan: 21 },
  UTANG_USAHA: { label: 'Penerimaan (pembayaran) utang usaha', urutan: 22 },
  SHU_DISTRIBUSI: { label: 'Pembagian sisa hasil usaha', urutan: 30 },
  SALDO_AWAL_AKUN: { label: 'Saldo awal akun', urutan: 90 },
  KOREKSI_SALDO_AWAL: { label: 'Koreksi saldo awal akun', urutan: 91 },
  SALDO_AWAL_REKENING: { label: 'Saldo awal rekening kas/bank', urutan: 92 },
  SIMPANAN_DATA_AWAL: { label: 'Saldo awal simpanan anggota', urutan: 93 },
};

/**
 * Nama baris untuk sumber yang belum terdaftar. Sengaja masih dapat
 * dikenali (huruf besar dengan garis bawah diganti spasi) supaya
 * penyusun laporan tahu persis jenis apa yang belum dinamai.
 */
export function labelCadangan(sumberTransaksi: string): string {
  const bersih = sumberTransaksi.trim();
  if (bersih === '') return 'Mutasi kas lainnya';
  return bersih.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export interface MutasiKasUntukSusunan {
  aktivitas: AktivitasKas;
  sumberTransaksi: string;
  jumlah: Rupiah;
}

/**
 * Kelompokkan mutasi kas menjadi baris bernama per bagian.
 *
 * Yang dijumlahkan adalah NETO per jenis transaksi — bukan satu baris
 * per jurnal. Penyaluran dan penerimaan pinjaman tetap terpisah karena
 * `sumber_transaksi`-nya memang berbeda (PENCAIRAN_PINJAMAN vs
 * ANGSURAN_POKOK), persis seperti contoh naskah yang juga
 * memisahkannya.
 *
 * Baris bernilai 0 DIBUANG: contoh naskah tidak memuat baris nol, dan
 * menampilkannya hanya memanjangkan laporan tanpa menambah informasi.
 * Nilainya sudah pasti tidak mengubah jumlah bagian.
 */
export function susunBagianArusKas(mutasi: MutasiKasUntukSusunan[]): BagianTersusun[] {
  const perBagian = new Map<BagianArusKas, Map<string, { label: string; urutan: number; jumlah: number }>>();
  for (const bagian of URUTAN_BAGIAN) perBagian.set(bagian, new Map());

  for (const m of mutasi) {
    const bagian = m.aktivitas as BagianArusKas;
    const peta = perBagian.get(bagian);
    if (!peta) continue;
    const nama = NAMA_BARIS[m.sumberTransaksi];
    const label = nama?.label ?? labelCadangan(m.sumberTransaksi);
    const urutan = nama?.urutan ?? 95;
    const ada = peta.get(m.sumberTransaksi);
    if (ada) ada.jumlah += m.jumlah;
    else peta.set(m.sumberTransaksi, { label, urutan, jumlah: m.jumlah });
  }

  return URUTAN_BAGIAN.map((bagian) => {
    const baris = [...perBagian.get(bagian)!.values()]
      .filter((b) => b.jumlah !== 0)
      .sort((a, b) => a.urutan - b.urutan || a.label.localeCompare(b.label, 'id'))
      .map((b) => ({ label: b.label, jumlah: b.jumlah, urutan: b.urutan }));
    return {
      bagian,
      judul: JUDUL_BAGIAN[bagian],
      nomor: NOMOR_BAGIAN[bagian],
      baris,
      labelJumlah: LABEL_JUMLAH_BAGIAN[bagian],
      // Dijumlahkan dari BARIS yang ditampilkan, sehingga angka yang
      // dibaca pengguna selalu sama dengan penjumlahan yang dilihatnya.
      jumlah: baris.reduce((t, b) => t + b.jumlah, 0),
    };
  });
}

/** Label penutup, persis seperti contoh naskah. */
export const LABEL_KENAIKAN = 'Kenaikan (penurunan) kas dan setara kas';
export const LABEL_SALDO_AWAL = 'Saldo awal kas dan setara kas';
export const LABEL_SALDO_AKHIR = 'Saldo akhir kas dan setara kas';

/**
 * Catatan penyajian yang WAJIB ikut ditampilkan. Bukan hiasan: dua
 * butir pertama menerangkan di mana penyajian ini berbeda dari contoh
 * naskah, sehingga pembaca laporan tidak perlu menebak.
 */
export const CATATAN_PENYAJIAN: readonly string[] = [
  'Urutan penyajian dan peristilahan mengikuti contoh Laporan Arus Kas pada Juklat SOM Deputi Bidang Pengawasan Koperasi No. 3/2025.',
  'Simpanan sukarela dan simpanan berjangka disajikan pada Kegiatan Operasi — sesuai contoh naskah dan definisi butir 5.7(4)(d), karena dana tersebut merupakan sumber utama penyaluran pinjaman koperasi. Simpanan pokok dan simpanan wajib tetap pada Kegiatan Pendanaan sebagai modal anggota.',
  'Utang bank dan utang kepada pihak lain disajikan pada Kegiatan Pendanaan mengikuti definisi butir 5.7(4)(f) ("perubahan dalam jumlah serta komposisi modal dan pinjaman"), meskipun contoh pada naskah menempatkannya pada Kegiatan Operasi.',
  'Butir 5.7(3) hanya menyebut aktivitas operasi dan pendanaan, namun aktivitas investasi didefinisikan pada butir 5.7(4)(e) dan disajikan pada contoh resminya; laporan ini menyajikan ketiganya.',
  'Disusun dengan metode langsung dari mutasi akun kas dan bank, lalu direkonsiliasi terhadap saldo kas dan bank aktual pada akhir periode.',
];
