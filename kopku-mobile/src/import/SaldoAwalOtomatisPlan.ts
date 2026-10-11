import { Rupiah } from '@/utils/money';

/**
 * RC-S107 — SALDO AWAL OTOMATIS SETELAH IMPORT (MODUL MURNI).
 *
 * ============================================================
 * MASALAH YANG DIPERBAIKI
 * ============================================================
 * Import saldo awal sengaja tidak menjurnal apa pun: pinjaman lama,
 * simpanan lama, dan aset lama hanya mengisi BUKU PEMBANTU. Sisi buku
 * besarnya harus diisi lewat Saldo Awal Akun — dan itu selama ini
 * pekerjaan manual: pengguna harus menyalin sendiri total piutang,
 * total simpanan per jenis, nilai perolehan aset, dan akumulasi
 * penyusutannya, satu per satu, dari panel hasil import.
 *
 * Padahal angka-angka itu SELURUHNYA sudah diketahui aplikasi pada
 * akhir import. Menyalin ulang dengan tangan hanya menambah peluang
 * salah ketik pada angka yang justru paling menentukan keseimbangan
 * neraca.
 *
 * Modul ini MURNI: ia hanya MENYUSUN DAFTAR "akun apa, sebesar berapa",
 * tanpa menyentuh database. Penulisannya ada di
 * `EksekusiSaldoAwalOtomatis`, dan itulah yang membuat aturan
 * pemetaannya dapat diuji langsung.
 *
 * ============================================================
 * YANG SENGAJA TIDAK DILAKUKAN
 * ============================================================
 *  - TIDAK menimpa saldo awal yang sudah diisi pengguna. Bila akunnya
 *    sudah punya saldo awal, hasil import hanya DILAPORKAN sebagai
 *    pembanding. Angka yang diketik manusia tidak boleh hilang diam-diam.
 *  - TIDAK mengunci saldo awal. Baris hasil import tetap bisa dikoreksi
 *    dan dihapus; penguncian permanen tetap tindakan terpisah yang
 *    disengaja pengguna.
 *  - TIDAK mengisi Kas/Bank. Hanya koperasi yang tahu berapa uang tunai
 *    yang sesungguhnya ada pada tanggal cut-off; menebaknya justru
 *    menghidupkan lagi kas fiktif yang baru saja dihapus.
 */

/** Peran akun yang saldo awalnya dapat diisi otomatis dari hasil import. */
export type PosSaldoAwalOtomatis =
  | 'PIUTANG_PINJAMAN'
  | 'PIUTANG_JASA'
  | 'SIMPANAN_POKOK'
  | 'SIMPANAN_WAJIB'
  | 'SIMPANAN_SUKARELA'
  | 'SIMPANAN_BERJANGKA'
  | 'ASET_TETAP'
  | 'AKUMULASI_PENYUSUTAN'
  | 'PENDAPATAN_DIMUKA';

export interface PemetaanPos {
  pos: PosSaldoAwalOtomatis;
  /** Nama yang ditampilkan ke pengguna. */
  label: string;
  /** Pemetaan COA: jenis transaksi + peran, BUKAN kode akun yang di-hardcode. */
  tipeTransaksi: string;
  peran: string;
  /** Dari sheet mana angkanya berasal — dipakai pada pesan ke pengguna. */
  asal: string;
}

/**
 * Pemetaan pos ke COA. Memakai `transaction_type`/`role` yang SUDAH ADA
 * — sama dengan yang dipakai jurnal domainnya masing-masing — supaya
 * koperasi yang mengganti kode akunnya tidak perlu mengubah apa pun di
 * sini.
 */
export const PEMETAAN_POS: Record<PosSaldoAwalOtomatis, PemetaanPos> = {
  PIUTANG_PINJAMAN: {
    pos: 'PIUTANG_PINJAMAN',
    label: 'Piutang Pinjaman Anggota',
    tipeTransaksi: 'PENCAIRAN_PINJAMAN',
    peran: 'DEBIT_PIUTANG',
    asal: 'sisa pokok seluruh pinjaman hasil migrasi',
  },
  PIUTANG_JASA: {
    pos: 'PIUTANG_JASA',
    label: 'Piutang Jasa Pinjaman',
    tipeTransaksi: 'AKRUAL_JASA_PINJAMAN',
    peran: 'DEBIT_PIUTANG_JASA',
    asal: 'kolom Piutang Jasa pada sheet Pinjaman',
  },
  SIMPANAN_POKOK: {
    pos: 'SIMPANAN_POKOK',
    label: 'Simpanan Pokok',
    tipeTransaksi: 'SIMPANAN_POKOK',
    peran: 'KREDIT_DEFAULT',
    asal: 'sheet Simpanan',
  },
  SIMPANAN_WAJIB: {
    pos: 'SIMPANAN_WAJIB',
    label: 'Simpanan Wajib',
    tipeTransaksi: 'SIMPANAN_WAJIB',
    peran: 'KREDIT_DEFAULT',
    asal: 'sheet Simpanan',
  },
  SIMPANAN_SUKARELA: {
    pos: 'SIMPANAN_SUKARELA',
    label: 'Simpanan Sukarela',
    tipeTransaksi: 'SIMPANAN_SUKARELA',
    peran: 'KREDIT_DEFAULT',
    asal: 'sheet Simpanan',
  },
  SIMPANAN_BERJANGKA: {
    pos: 'SIMPANAN_BERJANGKA',
    label: 'Simpanan Berjangka',
    tipeTransaksi: 'SIMPANAN_BERJANGKA',
    peran: 'KREDIT_DEFAULT',
    asal: 'sheet Simpanan Berjangka',
  },
  ASET_TETAP: {
    pos: 'ASET_TETAP',
    label: 'Aset Tetap (nilai perolehan)',
    tipeTransaksi: 'ASET_TETAP',
    peran: 'DEBIT_ASET',
    asal: 'sheet Aset Tetap',
  },
  AKUMULASI_PENYUSUTAN: {
    pos: 'AKUMULASI_PENYUSUTAN',
    label: 'Akumulasi Penyusutan Aset Tetap',
    tipeTransaksi: 'PENYUSUTAN_ASET',
    peran: 'KREDIT_AKUMULASI',
    asal: 'dihitung dari data aset sampai tanggal cut-off',
  },
  // RC-S133.4.5 — jasa angsuran yang dibayar SEBELUM jatuh temponya
  // (Angsuran Sudah Dibayar melampaui angsuran yang jatuh tempo per
  // cut-off). Sama seperti pembayaran di muka lewat menu Pinjaman, jasa
  // itu belum pendapatan: diakui otomatis saat jatuh tempo.
  PENDAPATAN_DIMUKA: {
    pos: 'PENDAPATAN_DIMUKA',
    label: 'Pendapatan Diterima Dimuka (jasa angsuran dibayar di muka)',
    // Akun yang SAMA dengan yang dikredit `bayarAngsuran` untuk jasa yang dibayar sebelum jatuh tempo.
    tipeTransaksi: 'ANGSURAN_JASA',
    peran: 'KREDIT_DIMUKA',
    asal: 'jasa angsuran yang sudah dibayar sebelum jatuh tempo (sheet Pinjaman)',
  },
};

/** Total per pos yang dikumpulkan selama import. */
export type TotalPerPos = Partial<Record<PosSaldoAwalOtomatis, Rupiah>>;

export interface RencanaSaldoAwal {
  pos: PosSaldoAwalOtomatis;
  label: string;
  tipeTransaksi: string;
  peran: string;
  asal: string;
  saldo: Rupiah;
}

/**
 * Susun rencana pengisian. Pos bernilai 0 atau negatif DIBUANG:
 * `tambahSaldoAwalAkun` memang menolak saldo <= 0, dan membuat baris
 * saldo awal bernilai nol hanya menambah baris kosong yang harus
 * dihapus pengguna.
 */
export function susunRencanaSaldoAwal(total: TotalPerPos): RencanaSaldoAwal[] {
  const urutan: PosSaldoAwalOtomatis[] = [
    'PIUTANG_PINJAMAN',
    'PIUTANG_JASA',
    'ASET_TETAP',
    'AKUMULASI_PENYUSUTAN',
    'SIMPANAN_POKOK',
    'SIMPANAN_WAJIB',
    'SIMPANAN_SUKARELA',
    'SIMPANAN_BERJANGKA',
    'PENDAPATAN_DIMUKA',
  ];
  const hasil: RencanaSaldoAwal[] = [];
  for (const pos of urutan) {
    const saldo = total[pos] ?? 0;
    if (!Number.isFinite(saldo) || saldo <= 0) continue;
    const m = PEMETAAN_POS[pos];
    hasil.push({ pos, label: m.label, tipeTransaksi: m.tipeTransaksi, peran: m.peran, asal: m.asal, saldo: Math.round(saldo) });
  }
  return hasil;
}

export type StatusPengisian = 'DIISI' | 'SUDAH_ADA' | 'GAGAL';

export interface HasilPengisianPos {
  pos: PosSaldoAwalOtomatis;
  label: string;
  status: StatusPengisian;
  /** Nilai yang dihitung dari hasil import. */
  saldoImport: Rupiah;
  /** Nilai yang sudah ada sebelumnya — hanya untuk status SUDAH_ADA. */
  saldoSebelumnya?: Rupiah;
  pesan: string;
}

export interface HasilSaldoAwalOtomatis {
  baris: HasilPengisianPos[];
  jumlahDiisi: number;
  jumlahSudahAda: number;
  jumlahGagal: number;
  /** true bila saldo awal terkunci permanen — tidak ada yang bisa diisi. */
  terkunci: boolean;
}

/** Pesan pembanding ketika akun sudah punya saldo awal. */
export function pesanSudahAda(label: string, sebelumnya: Rupiah, hasilImport: Rupiah): string {
  if (sebelumnya === hasilImport) {
    return `${label}: saldo awal sudah ada dan nilainya SAMA dengan hasil import. Tidak diubah.`;
  }
  const selisih = hasilImport - sebelumnya;
  const arah = selisih > 0 ? 'lebih besar' : 'lebih kecil';
  return (
    `${label}: saldo awal sudah diisi sebesar ${sebelumnya.toLocaleString('id-ID')}, ` +
    `sedangkan hasil import ${hasilImport.toLocaleString('id-ID')} (${arah} ${Math.abs(selisih).toLocaleString('id-ID')}). ` +
    `TIDAK diubah — periksa mana yang benar, lalu perbaiki lewat Koreksi Saldo Awal bila perlu.`
  );
}

export const CATATAN_SALDO_AWAL_OTOMATIS: readonly string[] = [
  'Saldo awal di atas diisi otomatis dari hasil import, dan masih dapat dikoreksi maupun dihapus — belum dikunci permanen.',
  'Kas dan Bank TIDAK diisi otomatis: hanya koperasi yang tahu berapa uang yang sesungguhnya ada pada tanggal cut-off — isi lewat sheet "7. Saldo Awal Akun" atau menu Saldo Awal.',
  'Akun lawan setiap baris adalah akun kliring "Saldo Awal Belum Sesuai" (3-5000). Setelah seluruh pos neraca terisi, saldo akun itu HARUS kembali Rp0.',
  'Periksa kembali Laporan Posisi Keuangan sebelum mengunci saldo awal.',
];
