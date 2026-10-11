/**
 * RC-S110 — TAMPILAN LAYAR SALDO AWAL (MODUL MURNI).
 *
 * ============================================================
 * KENAPA MODUL TERPISAH
 * ============================================================
 * `SaldoAwalAkunListScreen.tsx` mengimpor `DatePicker`,
 * `CurrencyInput`, dan `SafeAreaView` — rantai impornya menyentuh
 * paket ESM native, sehingga berkas test apa pun yang memuat layar itu
 * gagal dimuat oleh ts-jest. Semua keputusan yang BISA salah secara
 * logis (label status, hitungan kemajuan, siapa yang boleh diedit,
 * urutan tombol) dipindahkan ke modul murni ini supaya benar-benar
 * teruji, bukan hanya terlihat benar di layar.
 *
 * ============================================================
 * SATU BATAS YANG TIDAK BOLEH DILANGGAR
 * ============================================================
 * Layar Saldo Awal HANYA untuk input data. Permintaan pengguna
 * sebelumnya (§8 FINAL) menghapus total dashboard keseimbangan —
 * Total Aset/Liabilitas/Ekuitas dan badge "Seimbang"/"Belum
 * Seimbang" — dari layar ini; pemeriksaan itu tugas laporan Posisi
 * Keuangan.
 *
 * `hitungKemajuanPengisian()` di bawah BUKAN pelanggaran batas itu,
 * dan pembedaannya penting: yang dihitung adalah BERAPA AKUN sudah
 * diisi dari berapa akun yang tampil — sebuah hitungan kelengkapan
 * pekerjaan. Ia tidak pernah menjumlahkan nominal, tidak pernah
 * membandingkan debit dengan kredit, dan tidak pernah menyimpulkan
 * saldo seimbang atau tidak. Karena itu modul ini sengaja TIDAK
 * menerima nominal apa pun sebagai parameter: batasnya dijaga oleh
 * bentuk fungsinya, bukan oleh ingatan penulis layar.
 */

export type StatusSaldoAwal = 'DRAFT' | 'POSTED' | 'LOCKED';

/** Nada visual status — layar memetakannya ke warna tema. */
export type NadaStatus = 'netral' | 'aktif' | 'terkunci';

export const JUDUL_MODUL_SALDO_AWAL = 'SALDO AWAL';

export const SUBJUDUL_MODUL_SALDO_AWAL =
  'Isi saldo awal tiap akun sesuai Daftar Akun (COA). Boleh dilengkapi bertahap dan tidak wajib seimbang saat input.';

/**
 * Label status yang dibaca pengguna. Sengaja memakai kata kerja
 * keadaan, bukan istilah teknis jurnal: "AKTIF" jauh lebih jelas
 * daripada "POSTED" untuk pengurus koperasi.
 */
export const LABEL_STATUS_SALDO_AWAL: Record<StatusSaldoAwal, string> = {
  DRAFT: 'BELUM ADA SALDO AWAL',
  POSTED: 'SALDO AWAL AKTIF',
  LOCKED: 'TERKUNCI PERMANEN',
};

/**
 * Keterangan satu baris di bawah label status — menjawab pertanyaan
 * yang selalu muncul berikutnya: "lalu saya boleh apa sekarang?".
 */
export const KETERANGAN_STATUS_SALDO_AWAL: Record<StatusSaldoAwal, string> = {
  DRAFT: 'Belum ada akun yang disimpan. Isi nilai lalu tekan SIMPAN — saldo langsung aktif.',
  POSTED: 'Saldo sudah masuk laporan. Akun yang sudah terisi hanya bisa diubah lewat Koreksi.',
  LOCKED: 'Saldo awal dikunci permanen. Perubahan hanya lewat Koreksi Saldo Awal.',
};

export const NADA_STATUS_SALDO_AWAL: Record<StatusSaldoAwal, NadaStatus> = {
  DRAFT: 'netral',
  POSTED: 'aktif',
  LOCKED: 'terkunci',
};

export const IKON_STATUS_SALDO_AWAL: Record<StatusSaldoAwal, string> = {
  DRAFT: 'document-text-outline',
  POSTED: 'checkmark-circle',
  LOCKED: 'lock-closed',
};

export type FilterPengisian = 'SEMUA' | 'SUDAH' | 'BELUM';

/** Urutan chip filter — "Semua" selalu pertama supaya jalan pulang jelas. */
export const URUTAN_FILTER_PENGISIAN: FilterPengisian[] = ['SEMUA', 'SUDAH', 'BELUM'];

export const LABEL_FILTER_PENGISIAN: Record<FilterPengisian, string> = {
  SEMUA: 'Semua',
  SUDAH: 'Sudah Diisi',
  BELUM: 'Belum Diisi',
};

export interface KemajuanPengisian {
  diisi: number;
  total: number;
  /** 0-100, dibulatkan. Dipakai sebagai lebar bar kemajuan. */
  persen: number;
  teks: string;
  lengkap: boolean;
}

/**
 * Kemajuan pengisian sebagai HITUNGAN AKUN, bukan nominal.
 *
 * `total === 0` (COA kosong, atau pencarian tidak menemukan apa pun)
 * dikembalikan sebagai 0% — bukan 100%. Pembagian nol yang
 * menghasilkan NaN akan membuat lebar bar menjadi "NaN%" dan
 * menghilangkan bar-nya tanpa pesan apa pun; 100% malah lebih buruk
 * lagi karena memberi tahu pengguna bahwa pekerjaan sudah selesai
 * padahal belum satu akun pun diisi.
 */
export function hitungKemajuanPengisian(total: number, diisi: number): KemajuanPengisian {
  const totalSah = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const diisiSah = Number.isFinite(diisi) && diisi > 0 ? Math.min(Math.floor(diisi), totalSah) : 0;
  const persen = totalSah === 0 ? 0 : Math.round((diisiSah / totalSah) * 100);
  return {
    diisi: diisiSah,
    total: totalSah,
    persen,
    teks: totalSah === 0 ? 'Belum ada akun untuk diisi' : `${diisiSah} dari ${totalSah} akun sudah diisi`,
    lengkap: totalSah > 0 && diisiSah === totalSah,
  };
}

/**
 * Akun boleh diketik langsung HANYA kalau belum pernah disimpan dan
 * saldo awal belum dikunci permanen. Akun yang sudah punya saldo
 * bersifat read-only: perubahannya wajib lewat Koreksi (reversal +
 * jurnal baru), supaya jejak auditnya tidak hilang karena diketik
 * ulang di kotak yang sama.
 */
export function bolehDiedit(sudahDiisi: boolean, terkunciPermanen: boolean): boolean {
  return !sudahDiisi && !terkunciPermanen;
}

/** Tombol Koreksi/Hapus hanya untuk baris yang sudah aktif dan belum dikunci. */
export function bolehDikoreksi(sudahDiisi: boolean, terkunciPermanen: boolean): boolean {
  return sudahDiisi && !terkunciPermanen;
}

/**
 * "Simpan Permanen" hanya tampil kalau memang ada yang bisa dikunci:
 * status sudah lewat DRAFT, belum terkunci, dan ada baris tersimpan.
 * Ketiganya dipertahankan apa adanya dari layar lama — RC-S110 hanya
 * memindahkannya ke sini supaya bisa diuji.
 */
export function bolehKunciPermanen(
  status: StatusSaldoAwal,
  jumlahBaris: number,
  terkunciPermanen: boolean,
): boolean {
  return status !== 'DRAFT' && !terkunciPermanen && jumlahBaris > 0;
}

export const CATATAN_BUKAN_PEMERIKSAAN_KESEIMBANGAN =
  'Layar ini tidak memeriksa keseimbangan saldo. Seimbang atau belum diperiksa di Laporan Posisi Keuangan.';

/**
 * ============================================================
 * PEMBERITAHUAN "SALDO AWAL BELUM SESUAI" (AKUN KLIRING 3-5000)
 * ============================================================
 * Permintaan pengguna: kalau akun kliring "Saldo Awal Belum Sesuai"
 * masih bersaldo, beri tahu di BAGIAN ATAS layar — jangan sebagai
 * banner yang ikut tergulir hilang di tengah daftar akun yang panjang.
 *
 * Ini TIDAK melanggar §8. Yang dilarang di layar ini adalah dashboard
 * keseimbangan yang MENGHITUNG SENDIRI Total Aset/Liabilitas/Ekuitas
 * lalu menyimpulkan seimbang atau tidak. Yang ditampilkan di sini
 * adalah SALDO SEBUAH AKUN COA apa adanya — akun 3-5000 — persis
 * seperti saldo akun lain yang memang ditampilkan layar ini. Modul ini
 * pun tidak menghitung apa pun: ia hanya memilih kata, dan keputusan
 * "perlu diberitahu atau tidak" jatuh pada satu perbandingan dengan
 * nol yang dilakukan pemanggil.
 *
 * Kenapa penting diberitahu: selama akun 3-5000 belum Rp0, Laporan
 * Posisi Keuangan akan menampilkannya sebagai pos ekuitas yang
 * menutup selisih. Angkanya bukan kesalahan — mengakui selisih jauh
 * lebih jujur daripada menyembunyikannya — tetapi ia PENANDA bahwa
 * masih ada akun pasangan yang belum diisi atau belum dikoreksi.
 */
export const JUDUL_PERINGATAN_KLIRING = 'Saldo Awal Belum Sesuai';

export const KODE_AKUN_KLIRING_SALDO_AWAL = '3-5000';

/**
 * Apakah pemberitahuan perlu tampil. Sengaja `!== 0`, bukan `> 0`:
 * selisih bisa jatuh ke sisi debit maupun kredit, dan saldo negatif
 * sama perlunya diberitahu.
 */
export function perluPeringatanKliring(saldoKliring: number): boolean {
  return Number.isFinite(saldoKliring) && saldoKliring !== 0;
}

/**
 * Penjelasan satu paragraf yang menjawab tiga pertanyaan sekaligus:
 * ini apa, kenapa muncul, dan apa yang harus saya lakukan. Nominalnya
 * dirakit oleh layar (yang punya formatRupiah), bukan di sini —
 * modul ini tetap bebas dari perkakas uang.
 */
export const PENJELASAN_PERINGATAN_KLIRING =
  `Akun ${KODE_AKUN_KLIRING_SALDO_AWAL} masih bersaldo, artinya masih ada akun pasangan yang belum diisi atau belum dikoreksi. ` +
  'Angka ini bukan kesalahan — selisihnya sengaja ditampung supaya tidak disembunyikan — dan akan menjadi Rp0 dengan sendirinya ' +
  'begitu seluruh akun terisi lengkap dan seimbang.';
