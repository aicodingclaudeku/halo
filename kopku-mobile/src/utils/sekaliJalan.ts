/**
 * RC-S115 — PENJAGA "HANYA SEKALI JALAN" UNTUK INISIALISASI ASINKRON.
 *
 * ============================================================
 * MASALAH YANG DIPERBAIKI
 * ============================================================
 * Pola lazy-singleton yang ditulis apa adanya PUNYA BALAPAN:
 *
 *     if (instance) return instance;
 *     instance = await buatMahal();   // <- ada titik tunggu di sini
 *     return instance;
 *
 * Antara penjaga `if` dan penugasan `instance` ada titik `await`. Dua
 * pemanggil yang masuk berdekatan sama-sama lolos penjaga itu selagi
 * `instance` masih kosong, lalu KEDUANYA menjalankan `buatMahal()`.
 *
 * Untuk database, akibatnya bukan sekadar pemborosan: dua pegangan
 * native dibuka atas berkas yang sama, yang selesai belakangan menimpa
 * yang pertama, dan objek pertama yang menjadi tak terjangkau
 * dilepas oleh pengumpul sampah — sementara pemanggil yang sempat
 * menyimpannya baru memakainya belakangan. Itu yang muncul sebagai
 * "NativeDatabase.prepareAsync ... java.lang.NullPointerException"
 * di build rilis, tempat waktunya jauh lebih rapat daripada di mode
 * pengembangan.
 *
 * ============================================================
 * YANG DILAKUKAN
 * ============================================================
 * Yang disimpan adalah JANJINYA, bukan hasilnya. Pemanggil kedua yang
 * datang selagi pekerjaan masih berjalan menunggu janji yang SAMA.
 *
 * Kegagalan membuang janji itu supaya percobaan berikutnya benar-benar
 * mencoba lagi. Menyimpan janji yang sudah ditolak akan membuat
 * kegagalan sesaat — keystore terkunci, disk penuh sesaat — menjadi
 * kegagalan permanen sampai aplikasi dimatikan paksa.
 */
export interface SekaliJalan<T> {
  (): Promise<T>;
  /** Buang hasil & janji yang tersimpan; panggilan berikutnya mulai dari nol. */
  reset(): void;
  /** Nilai yang sudah jadi, atau null bila belum pernah selesai. */
  nilai(): T | null;
}

export function sekaliJalan<T>(kerjakan: () => Promise<T>): SekaliJalan<T> {
  let hasil: T | null = null;
  let berjalan: Promise<T> | null = null;

  const panggil = async (): Promise<T> => {
    if (hasil !== null) return hasil;
    if (berjalan) return berjalan;

    berjalan = (async () => {
      const nilaiBaru = await kerjakan();
      // Ditugaskan PALING AKHIR: selagi `kerjakan()` belum tuntas,
      // `hasil` tetap kosong sehingga tidak ada pemanggil yang menerima
      // nilai setengah jadi.
      hasil = nilaiBaru;
      return nilaiBaru;
    })();

    try {
      return await berjalan;
    } catch (e) {
      berjalan = null;
      throw e;
    }
  };

  const terbungkus = panggil as SekaliJalan<T>;
  terbungkus.reset = () => {
    hasil = null;
    berjalan = null;
  };
  terbungkus.nilai = () => hasil;
  return terbungkus;
}
