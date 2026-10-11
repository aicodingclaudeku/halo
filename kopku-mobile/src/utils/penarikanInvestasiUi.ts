/**
 * Logika TAMPILAN murni modul "Penerimaan Penarikan Dana Investasi".
 * Tidak menghitung jurnal, laba/rugi, atau nilai tercatat — semua itu
 * milik `PelepasanInvestasiService` (pratinjau == eksekusi).
 */

export type JenisPenarikanInvestasi = 'KOPERASI_LAIN' | 'USAHA_LAIN' | 'DEPOSITO_BANK_UMUM';

export const JENIS_PENARIKAN: readonly {
  kode: JenisPenarikanInvestasi;
  judul: string;
  keterangan: string;
  ikon: 'business-outline' | 'briefcase-outline' | 'time-outline';
}[] = [
  { kode: 'KOPERASI_LAIN', judul: 'Penyertaan pada Koperasi Lain', keterangan: 'Pengembalian modal penyertaan dari koperasi lain', ikon: 'business-outline' },
  { kode: 'USAHA_LAIN', judul: 'Penyertaan pada Usaha Lain', keterangan: 'Pengembalian dana penyertaan dari usaha lain', ikon: 'briefcase-outline' },
  { kode: 'DEPOSITO_BANK_UMUM', judul: 'Deposito Berjangka', keterangan: 'Pencairan deposito berjangka di bank', ikon: 'time-outline' },
];

export function judulJenisPenarikan(kode: string): string {
  return JENIS_PENARIKAN.find((j) => j.kode === kode)?.judul ?? kode;
}

export function isJenisPenarikan(kode: unknown): kode is JenisPenarikanInvestasi {
  return JENIS_PENARIKAN.some((j) => j.kode === kode);
}

/**
 * Status investasi -> label & nada. DILEPAS = seluruh investasi sudah
 * ditarik (Selesai). "Sebagian Ditarik" diturunkan dari riwayat penarikan
 * (status tabel tetap AKTIF selama masih ada saldo).
 */
export function statusInvestasiUi(status: string, jumlahPenarikan = 0): { label: string; nada: 'OK' | 'WARN' | 'MUTED' } {
  if (status === 'AKTIF' && jumlahPenarikan > 0) return { label: 'Sebagian Ditarik', nada: 'WARN' };
  if (status === 'AKTIF') return { label: 'Aktif', nada: 'OK' };
  if (status === 'DILEPAS') return { label: 'Selesai', nada: 'MUTED' };
  if (status === 'DIBATALKAN') return { label: 'Dibatalkan', nada: 'MUTED' };
  return { label: status, nada: 'MUTED' };
}

/** Hanya investasi berstatus AKTIF yang dapat ditarik (guard yang sama dengan service). */
export function dapatDitarik(status: string): boolean {
  return status === 'AKTIF';
}

export function labelSelisih(jenis: 'LABA' | 'IMPAS' | 'RUGI'): string {
  return jenis === 'LABA' ? 'Keuntungan penarikan investasi' : jenis === 'RUGI' ? 'Kerugian penarikan investasi' : 'Tanpa selisih';
}

export interface InputFormPenarikan {
  tanggal: string;
  hariIni: string;
  tanggalPerolehan: string;
  /** v72 — tanggal penarikan terakhir sebelumnya (kronologi). */
  tanggalPenarikanTerakhir?: string | null;
  mode?: 'SEBAGIAN' | 'SELURUHNYA';
  /** Saldo tersedia (nilai tercatat) — batas penarikan sebagian. */
  saldoTersedia?: number;
  danaDiterima: number | '';
  bunga?: number | '';
  sumberDana: 'KAS' | 'BANK' | null;
  adaRekeningBank: boolean;
}

/**
 * Validasi di layar — CERMINAN guard service (`susunPelepasan`) supaya
 * pengguna mendapat pesan sebelum meninjau. Service tetap memvalidasi
 * ulang; tidak ada aturan yang tidak dimiliki service.
 */
export function validasiFormPenarikan(i: InputFormPenarikan): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.tanggal)) e.tanggal = 'Tanggal transaksi tidak valid.';
  else if (i.tanggal > i.hariIni) e.tanggal = 'Tanggal transaksi tidak boleh setelah hari ini.';
  else if (i.tanggal < i.tanggalPerolehan.slice(0, 10)) e.tanggal = 'Tanggal transaksi tidak boleh sebelum tanggal penempatan.';
  else if (i.tanggalPenarikanTerakhir && i.tanggal < i.tanggalPenarikanTerakhir)
    e.tanggal = 'Tanggal transaksi tidak boleh sebelum penarikan terakhir.';

  if (i.danaDiterima === '') e.danaDiterima = 'Isi jumlah dana yang diterima.';
  else if (!Number.isInteger(i.danaDiterima) || i.danaDiterima < 0) e.danaDiterima = 'Jumlah harus rupiah bulat, tidak negatif.';
  else if (i.mode === 'SEBAGIAN') {
    if (i.danaDiterima <= 0) e.danaDiterima = 'Jumlah penarikan sebagian harus lebih dari 0.';
    else if (typeof i.saldoTersedia === 'number' && i.danaDiterima >= i.saldoTersedia)
      e.danaDiterima = 'Penarikan sebagian harus lebih kecil dari saldo tersedia. Untuk menarik seluruh saldo, pilih Tarik Seluruhnya.';
  }

  const bunga = i.bunga === undefined || i.bunga === '' ? 0 : i.bunga;
  if (!Number.isInteger(bunga) || bunga < 0) e.bunga = 'Bunga harus rupiah bulat, tidak negatif.';

  const total = (i.danaDiterima === '' ? 0 : i.danaDiterima) + (Number.isInteger(bunga) && bunga > 0 ? bunga : 0);
  if (total > 0) {
    if (i.sumberDana === null) e.sumberDana = 'Pilih akun Kas atau Bank penerima.';
    else if (i.sumberDana === 'BANK' && !i.adaRekeningBank) e.sumberDana = 'Pilih rekening bank penerima.';
  }
  return e;
}

const PESAN_KODE: Record<string, string> = {
  INVESTASI_TIDAK_DITEMUKAN: 'Investasi tidak ditemukan.',
  SUDAH_DILEPAS: 'Investasi ini sudah ditarik seluruhnya. Penarikan kedua tidak diizinkan.',
  STATUS_TIDAK_AKTIF: 'Hanya investasi berstatus Aktif yang dapat ditarik.',
  JURNAL_PENEMPATAN_TIDAK_VALID: 'Jurnal penempatan investasi tidak valid; penarikan tidak dapat dicatat.',
  TANGGAL_TIDAK_VALID: 'Tanggal transaksi tidak valid.',
  TANGGAL_MASA_DEPAN: 'Tanggal transaksi tidak boleh setelah hari ini.',
  TANGGAL_SEBELUM_PEROLEHAN: 'Tanggal transaksi tidak boleh sebelum tanggal penempatan.',
  ADA_TRANSAKSI_SETELAH_TANGGAL_PELEPASAN: 'Ada penyusutan atau penurunan nilai setelah tanggal ini. Pilih tanggal yang lebih akhir.',
  PERIODE_CLOSED: 'Periode akuntansi untuk tanggal ini sudah ditutup.',
  HASIL_TIDAK_VALID: 'Jumlah dana harus rupiah bulat, tidak negatif.',
  REKENING_WAJIB: 'Pilih akun Kas atau Bank penerima.',
  // v72 — PenarikanInvestasiService
  SUDAH_SELESAI: 'Investasi ini sudah ditarik seluruhnya.',
  JENIS_TIDAK_DIDUKUNG: 'Jenis investasi ini tidak ditarik melalui modul ini.',
  TANGGAL_SEBELUM_PENARIKAN_TERAKHIR: 'Tanggal transaksi tidak boleh sebelum penarikan terakhir.',
  ADA_TRANSAKSI_SETELAH_TANGGAL: 'Ada penyusutan atau penurunan nilai setelah tanggal ini. Pilih tanggal yang lebih akhir.',
  NOMINAL_TIDAK_VALID: 'Jumlah penarikan tidak valid.',
  MELEBIHI_SALDO: 'Penarikan sebagian harus lebih kecil dari saldo tersedia.',
  BUNGA_TIDAK_VALID: 'Bunga harus rupiah bulat, tidak negatif.',
  BUNGA_HANYA_DEPOSITO: 'Bunga hanya dapat dicatat bersama pencairan Deposito Berjangka.',
  AKUN_BUNGA_TIDAK_TERSEDIA: 'Akun Pendapatan Bunga Deposito belum tersedia di COA. Hubungi administrator.',
  ADA_PENARIKAN_SEBAGIAN: 'Investasi ini sudah ditarik sebagian; selesaikan melalui Penarikan Dana Investasi.',
};

/** Pesan penolakan service -> kalimat pengguna. Pesan asli dipakai bila kode tidak dikenal. */
export function pesanPenolakan(e: unknown): string {
  const kode = (e as { kode?: string } | null)?.kode;
  if (kode && PESAN_KODE[kode]) return PESAN_KODE[kode];
  const m = e instanceof Error ? e.message : '';
  return m.replace(/^[A-Z_]+: /, '') || 'Terjadi kesalahan.';
}
