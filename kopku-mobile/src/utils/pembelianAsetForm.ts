import type { Rupiah } from '@/utils/money';

/**
 * RC-S67.7.2 — helper MURNI untuk layar Pembelian Aset.
 *
 * Validasi Nilai Residu di sini hanya lapisan UX. Otoritas tetap
 * `AsetService.validasiMasaManfaatDanResidu()` (dipanggil `beliAset`),
 * yang TIDAK diubah: residu < 0 ditolak, residu >= perolehan ditolak.
 */

/** Nilai residu yang dikirim ke service: kosong berarti 0 (tidak pernah undefined/null). */
export function nilaiResiduUntukDisimpan(residu: number | ''): Rupiah {
  return residu === '' ? 0 : residu;
}

export function validasiNilaiResidu(perolehan: number | '', residu: number | ''): string | undefined {
  const r = nilaiResiduUntukDisimpan(residu);
  if (!Number.isFinite(r) || !Number.isInteger(r)) return 'Nilai residu harus berupa angka rupiah.';
  if (r < 0) return 'Nilai residu tidak boleh negatif.';
  if (perolehan === '' || perolehan <= 0) return undefined; // galat nilai perolehan ditampilkan di field-nya sendiri
  if (r > perolehan) return 'Nilai residu tidak boleh lebih besar dari nilai perolehan.';
  if (r === perolehan) return 'Nilai residu harus lebih kecil dari nilai perolehan (bila sama, aset tidak pernah disusutkan).';
  return undefined;
}

/**
 * Pratinjau "Nilai yang disusutkan" = perolehan - residu. HANYA tampilan;
 * sama dengan dasar di `PenyusutanService.hitungPenyusutanBulanan`
 * (tidak menggantikannya dan tidak membuat jurnal).
 */
export function pratinjauNilaiDisusutkan(perolehan: number | '', residu: number | ''): Rupiah | null {
  if (perolehan === '' || perolehan <= 0) return null;
  if (validasiNilaiResidu(perolehan, residu)) return null;
  return perolehan - nilaiResiduUntukDisimpan(residu);
}

export interface RingkasanPembelianAset {
  asetId: string;
  nomorAset: string;
  namaAset: string;
  nilaiPerolehan: Rupiah;
  nilaiResidu: Rupiah;
  masaManfaatBulan: number;
  metodePembayaran: 'TUNAI' | 'KREDIT';
  sumber: string;
}

/** Keterangan efek jurnal untuk ringkasan — mengikuti semantik existing (tidak diubah). */
export function efekJurnalPembelian(metode: 'TUNAI' | 'KREDIT'): string {
  return metode === 'TUNAI' ? 'Aset bertambah · Kas/Bank berkurang' : 'Aset bertambah · Utang Usaha bertambah';
}

/** "48 bulan (4 tahun)" / "18 bulan (1 tahun 6 bulan)". */
export function labelMasaManfaat(bulan: number): string {
  const th = Math.floor(bulan / 12);
  const bl = bulan % 12;
  const bagian = [th > 0 ? `${th} tahun` : '', bl > 0 ? `${bl} bulan` : ''].filter(Boolean).join(' ');
  return th > 0 ? `${bulan} bulan (${bagian})` : `${bulan} bulan`;
}

// ------------------------------------------------------------------
// RC-S67.7.3 — penjaga submit sekali (dapat diuji tanpa render RN)
// ------------------------------------------------------------------

export type HasilPenjagaSubmit<T> = { status: 'OK'; hasil: T } | { status: 'DIABAIKAN' };

/**
 * Penjaga submit sinkron untuk form transaksi:
 *  - selama `fn` berjalan, panggilan lain DIABAIKAN (tap ganda/tiga kali);
 *  - setelah `fn` BERHASIL, penjaga terkunci PERMANEN (tidak ada transaksi
 *    kedua dari form yang sama);
 *  - bila `fn` GAGAL (melempar), kunci dilepas agar pengguna dapat retry —
 *    galat diteruskan ke pemanggil.
 * Tidak menggantikan atomisitas service (`withTransaction`).
 */
export function buatPenjagaSubmit() {
  let berjalan = false;
  let selesai = false;
  return {
    get terkunci(): boolean {
      return berjalan || selesai;
    },
    async jalankan<T>(fn: () => Promise<T>): Promise<HasilPenjagaSubmit<T>> {
      if (berjalan || selesai) return { status: 'DIABAIKAN' };
      berjalan = true;
      try {
        const hasil = await fn();
        selesai = true;
        return { status: 'OK', hasil };
      } finally {
        berjalan = false;
      }
    },
  };
}
