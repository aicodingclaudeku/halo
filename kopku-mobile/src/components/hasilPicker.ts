/**
 * RC-S118.1 — KETERANGAN JUMLAH PICKER ANGGOTA (MODUL MURNI).
 *
 * ============================================================
 * BUG YANG DIPERBAIKI (dilaporkan pengguna)
 * ============================================================
 * "Setor Simpanan Anggota cuma menampilkan 30 anggota", dan hal yang
 * sama muncul di Penempatan Simpanan Berjangka serta di form Pengurus,
 * Pengawas, dan Pengelola/Karyawan.
 *
 * Kenapa satu bug tampak di banyak layar sekaligus: semua layar itu
 * memakai SATU komponen yang sama, `AnggotaPicker`, dan komponen itulah
 * yang membatasi 30 baris. Jadi yang berubah sebenarnya bukan banyak
 * tempat — yang berubah satu tempat, dan tempat itu dipakai banyak
 * layar.
 *
 * ============================================================
 * KEPUTUSAN: TIDAK ADA BATAS SAMA SEKALI
 * ============================================================
 * Picker sekarang menampilkan SELURUH kandidat. Bukan 30, bukan 200,
 * melainkan sebanyak anggota yang memang memenuhi syarat. Batas berapa
 * pun akan salah untuk koperasi dengan jumlah anggota di atasnya, dan
 * daftar yang terpotong diam-diam terbaca sebagai "anggota kita cuma
 * segitu".
 *
 * Yang TIDAK ikut hilang adalah syarat KELAYAKAN, karena itu pertanyaan
 * yang berbeda dari "berapa yang ditampilkan":
 *   - Tarik Simpanan     -> hanya anggota dengan saldo sukarela > 0
 *   - Pencairan Berjangka -> hanya anggota dengan kontrak berjangka
 *                            yang masih dapat diproses
 *   - selain itu          -> seluruh anggota berstatus AKTIF
 * Penyaringan itu tetap dikerjakan di SQL seperti semula; yang dihapus
 * hanya klausa LIMIT/OFFSET-nya.
 */

/**
 * Keterangan jumlah di bawah kotak pencarian.
 *
 * Ada dua alasan angka ini ditampilkan terus-menerus, bukan hanya
 * sesekali. Pertama, inti bug yang dilaporkan adalah DIAMNYA daftar:
 * pengguna tidak punya cara tahu apakah yang dilihatnya lengkap.
 * Kedua, angka yang hanya muncul saat bermasalah membuat ketiadaannya
 * ikut bermakna, dan itu justru lebih mudah salah dibaca.
 */
export function keteranganJumlahPicker(jumlah: number, adaPencarian: boolean): string {
  const n = Number.isFinite(jumlah) && jumlah > 0 ? Math.floor(jumlah) : 0;
  if (n === 0) {
    return adaPencarian ? 'Tidak ada anggota yang cocok' : 'Belum ada anggota yang memenuhi syarat';
  }
  return adaPencarian ? `${n} anggota cocok` : `Menampilkan seluruh ${n} anggota`;
}
