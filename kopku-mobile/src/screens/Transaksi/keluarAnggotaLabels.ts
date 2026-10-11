import type { AlasanKeluar, StatusPengajuanKeluar } from '@/services/KeluarAnggotaService';

/**
 * Label alasan keluar untuk TAMPILAN.
 *
 * Diangkat ke modul sendiri saat layar Keluar Anggota dipecah menjadi
 * hub / pengajuan / daftar: form dan daftar sama-sama merendernya, dan
 * menyalin `Record` ini ke dua berkas berarti menambah alasan baru di
 * service bisa diterjemahkan di satu layar tapi tidak di layar lain.
 *
 * Murni presentasi — nilai `AlasanKeluar` sendiri tetap milik
 * `KeluarAnggotaService`, dan tipenya di sini memastikan setiap alasan
 * yang ditambahkan di sana wajib punya label di sini.
 */
export const LABEL_ALASAN_KELUAR: Record<AlasanKeluar, string> = {
  MENGUNDURKAN_DIRI: 'Mengundurkan Diri',
  DIBERHENTIKAN: 'Diberhentikan',
  MENINGGAL: 'Meninggal',
  LAINNYA: 'Lainnya',
};

/**
 * Label status untuk TAMPILAN. Nilai status di database TIDAK berubah
 * (`DIAJUKAN`/`DISETUJUI`/`DITOLAK`/`DIBAYAR`); yang diterjemahkan
 * hanya apa yang dibaca pengurus.
 *
 * `DIAJUKAN` -> "Menunggu Persetujuan" dan `DIBAYAR` -> "Selesai"
 * karena istilah mentahnya menggambarkan apa yang SUDAH terjadi pada
 * baris, bukan apa yang ditunggu dari pembacanya. Di daftar berisi
 * campuran status, "Diajukan" dan "Disetujui" terlihat mirip padahal
 * yang satu menunggu tindakan dan yang lain menunggu uang keluar.
 */
export const LABEL_STATUS_KELUAR: Record<StatusPengajuanKeluar, string> = {
  DIAJUKAN: 'Menunggu Persetujuan',
  DISETUJUI: 'Disetujui — Siap Dibayar',
  DITOLAK: 'Ditolak',
  DIBAYAR: 'Selesai',
};

/** Penjelasan satu kalimat di layar detail — mengikuti status aktual. */
export const PENJELASAN_STATUS_KELUAR: Record<StatusPengajuanKeluar, string> = {
  DIAJUKAN: 'Menunggu persetujuan pengurus.',
  DISETUJUI: 'Pengajuan telah disetujui dan siap dibayarkan.',
  DITOLAK: 'Pengajuan telah ditolak.',
  DIBAYAR: 'Pembayaran telah selesai.',
};
