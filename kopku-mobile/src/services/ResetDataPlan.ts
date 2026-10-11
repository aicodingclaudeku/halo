/**
 * RC-S99 — RENCANA & GERBANG KEAMANAN "RESET DATA" (MODUL MURNI).
 *
 * Berisi SELURUH keputusan tentang apa yang dihapus, apa yang
 * dipertahankan, dan kapan tombol reset boleh aktif — TANPA satu pun
 * import database atau modul native. Alasannya sama seperti
 * `BackupValidator` dan `KolektibilitasSomService`: aturan yang
 * konsekuensinya permanen tidak boleh hanya "diklaim benar", ia harus
 * bisa diuji langsung. Eksekusi SQL-nya ada di `ResetDataService.ts`.
 *
 * Permintaan pengguna: "tombol reset data yang memiliki beberapa kali
 * konfirmasi agar tidak tertekan tidak sengaja". Perlindungan terhadap
 * tekanan tidak sengaja di sini BUKAN satu dialog "Anda yakin?" (yang
 * justru dihafal dan ditekan refleks), melainkan beberapa lapis yang
 * masing-masing menuntut jenis tindakan BERBEDA:
 *
 *   1. Memilih mode secara sadar (tidak ada mode terpilih di awal).
 *   2. Membaca rincian dampak lalu menyatakan sudah paham.
 *   3. Gerbang backup: backup dibuat, ATAU sengaja melewatkannya.
 *   4. MENGETIK frasa konfirmasi — tindakan yang mustahil dilakukan
 *      oleh tekanan tidak sengaja, berbeda dari menekan tombol.
 *   5. PIN pengguna (bila app-lock PIN aktif).
 *   6. MENAHAN tombol terakhir beberapa detik, bukan sekali tekan.
 *
 * Lapis 4 dan 6 adalah inti permintaannya: keduanya menuntut niat yang
 * berlangsung, bukan satu sentuhan.
 */

export type ModeResetData = 'TRANSAKSI' | 'TOTAL';

/**
 * TABEL YANG DIKOSONGKAN pada mode TRANSAKSI, DALAM URUTAN AMAN FOREIGN
 * KEY (anak lebih dulu, induk terakhir).
 *
 * Urutan ini BUKAN karangan: ia diturunkan dari urutan topologis seluruh
 * klausa `REFERENCES` pada `schema.ts`. `ResetDataService` masih
 * memverifikasinya lagi dengan `PRAGMA foreign_key_check` di dalam
 * transaksi yang sama, jadi kalau suatu saat ada relasi baru yang
 * membuat urutan ini salah, reset GAGAL dan di-rollback — bukan
 * meninggalkan database setengah terhapus.
 */
export const TABEL_RESET_TRANSAKSI: readonly string[] = [
  // --- lapis terdalam: baris yang menunjuk ke banyak tabel lain
  'angsuran_pembayaran',
  'aset_penyusutan',
  'bank_transaksi',
  // Bunga harian simpanan sukarela (v78): rincian menunjuk proses,
  // anggota, dan simpanan_transaksi — dihapus lebih dulu.
  'bunga_sukarela_rincian',
  'biaya_dimuka_pengakuan',
  'calk_note',
  'imbalan_kerja',
  'investasi_bagian_shu_penerimaan',
  'investasi_impairment',
  'investasi_penarikan',
  'investasi_penyusutan',
  'journal_entry',
  // RC-S133.6.2 (v81) — jejak koreksi transaksi menunjuk journal: dihapus lebih dulu.
  'koreksi_transaksi',
  'kas_transaksi',
  'keluar_anggota',
  'pendapatan_dimuka_pengakuan',
  'penyesuaian_nilai_wajar',
  'pinjaman_agunan',
  'pinjaman_akuntansi_jasa',
  'pinjaman_koperasi',
  'rak_transaksi',
  'rekonsiliasi_kas_bank',
  'saldo_awal_akun',
  'saldo_awal_lock',
  'shu_anggota',
  'simpanan_berjangka_bunga',
  'simpanan_berjangka_pencairan_dini',
  'simpanan_transaksi',
  'utang_bunga_akrual',
  'utang_pembayaran',
  // --- lapis tengah
  'angsuran_jadwal',
  'bunga_sukarela_proses',
  'biaya_dibayar_dimuka',
  'investasi_bagian_shu',
  'pendapatan_diterima_dimuka',
  'shu_konfigurasi',
  // RC-S128 — catatan penerapan kebijakan menunjuk kontrak: dihapus lebih dulu.
  'simpanan_berjangka_penerapan_kebijakan',
  'simpanan_berjangka',
  'utang',
  'aset_tetap',
  'investasi',
  'pinjaman_akad_ulang',
  'rat',
  'pinjaman',
  // --- induk
  'anggota',
  'journal',
  // RC-S100 — riwayat import data awal. DIHAPUS, bukan dipertahankan:
  // isinya menggambarkan baris-baris yang berhasil diimpor, dan setelah
  // data operasionalnya dikosongkan riwayat "berhasil impor 87 anggota"
  // justru menyesatkan karena anggota itu sudah tidak ada. Berbeda dari
  // `audit_log`, yang dipertahankan karena ia jejak keamanan (siapa
  // melakukan apa), bukan laporan tentang data yang kini hilang.
  // Anak lebih dulu supaya referensinya tidak menggantung.
  'import_data_awal_log',
  'import_data_awal_riwayat',
  // RC-S133.6.2 (v81) — sidik baris yang sudah diimpor ikut dihapus: data
  // hasil impornya sudah dikosongkan, jadi berkas yang sama boleh diimpor lagi.
  'import_data_awal_sidik',
  // --- penomoran otomatis: WAJIB dikosongkan supaya nomor anggota,
  // nomor pinjaman, dan nomor bukti mulai dari 1 lagi. Kalau tidak,
  // data baru akan meneruskan nomor data uji coba yang sudah dihapus.
  'sequence_counter',
];

/**
 * TABEL YANG DIPERTAHANKAN pada mode TRANSAKSI — konfigurasi, identitas,
 * dan jejak audit. Ditulis EKSPLISIT (bukan "sisanya") supaya setiap
 * tabel baru yang ditambahkan ke skema di masa depan memaksa keputusan
 * sadar: `periksaCakupanTabelReset()` akan gagal kalau ada tabel yang
 * tidak terdaftar di salah satu dari dua daftar ini.
 */
export const TABEL_DIPERTAHANKAN_TRANSAKSI: readonly string[] = [
  // Identitas & profil koperasi
  'koperasi',
  'koperasi_personel',
  'koperasi_unit_usaha',
  'koperasi_perizinan',
  'koperasi_peraturan_internal',
  // Akses aplikasi — pengguna TIDAK boleh kehilangan loginnya sendiri
  'app_user',
  'role_permission',
  'app_config',
  // Bagan akun & pemetaannya: hasil penyesuaian yang mahal dibuat ulang
  'account',
  'account_mapping',
  // Master/referensi
  'aset_klasifikasi',
  'data_referensi',
  'bank_account',
  'bank_jenis_simpanan',
  'accounting_period',
  'simpanan_berjangka_kebijakan_dini',
  // RC-S128 — kebijakan produk simpanan berjangka (berversi): konfigurasi
  // koperasi, dipertahankan seperti kebijakan penarikan dini.
  'simpanan_berjangka_kebijakan_produk',
  // Kebijakan produk koperasi (v78) — sama seperti kebijakan dini berjangka.
  'bunga_sukarela_kebijakan',
  'kebijakan_basis_jasa_modal',
  // Jejak yang justru harus selamat dari reset
  'audit_log',
  'standar_akuntansi_log',
];

/**
 * Frasa yang WAJIB diketik. Sengaja panjang, memakai kata yang menyebut
 * akibatnya, dan BERBEDA antar mode — sehingga frasa untuk reset ringan
 * tidak bisa dipakai untuk reset total.
 */
export const FRASA_KONFIRMASI: Record<ModeResetData, string> = {
  TRANSAKSI: 'HAPUS DATA TRANSAKSI',
  TOTAL: 'RESET TOTAL SEMUA DATA',
};

/** Lama tombol terakhir harus DITAHAN (milidetik) — bukan sekali tekan. */
export const DURASI_TAHAN_MS = 3000;

export const LABEL_MODE: Record<ModeResetData, string> = {
  TRANSAKSI: 'Hapus Data Transaksi',
  TOTAL: 'Reset Total',
};

export const RINGKASAN_MODE: Record<ModeResetData, string> = {
  TRANSAKSI:
    'Menghapus seluruh data operasional: anggota, simpanan, pinjaman, angsuran, kas & bank, aset, investasi, utang, jurnal, SHU, dan saldo awal. Identitas koperasi, pengguna beserta loginnya, daftar akun, dan pengaturan TETAP ADA.',
  TOTAL:
    'Mengembalikan aplikasi ke kondisi baru dipasang. SELURUH isi database dihapus, termasuk identitas koperasi, daftar akun, dan akun login Anda sendiri. Setelah ini aplikasi wajib melalui setup awal dari nol.',
};

/**
 * `periksaCakupanTabelReset` — INVARIAN KELENGKAPAN.
 *
 * Dipanggil oleh test dengan daftar tabel yang dibaca dari `schema.ts`.
 * Tujuannya menutup satu-satunya cara fitur ini bisa rusak tanpa terasa:
 * seseorang menambah tabel baru berisi data transaksi, lupa
 * mendaftarkannya, lalu "Hapus Data Transaksi" diam-diam meninggalkan
 * data lama di sana. Mengembalikan daftar masalah (bukan melempar)
 * supaya pesan test bisa menyebut nama tabelnya.
 */
export function periksaCakupanTabelReset(semuaTabel: readonly string[]): {
  belumDiklasifikasikan: string[];
  ganda: string[];
  tidakDikenal: string[];
} {
  const dihapus = new Set(TABEL_RESET_TRANSAKSI);
  const dipertahankan = new Set(TABEL_DIPERTAHANKAN_TRANSAKSI);
  const skema = new Set(semuaTabel);

  return {
    belumDiklasifikasikan: semuaTabel.filter((t) => !dihapus.has(t) && !dipertahankan.has(t)).sort(),
    ganda: semuaTabel.filter((t) => dihapus.has(t) && dipertahankan.has(t)).sort(),
    tidakDikenal: [...dihapus, ...dipertahankan].filter((t) => !skema.has(t)).sort(),
  };
}

/**
 * Pencocokan frasa konfirmasi.
 *
 * Spasi di tepi diabaikan dan huruf besar/kecil tidak dibedakan: papan
 * ketik ponsel mengatur kapitalisasi otomatis di luar kendali pengguna,
 * sehingga menuntut kapitalisasi persis hanya menambah frustrasi TANPA
 * menambah perlindungan — yang melindungi adalah keharusan mengetik ~20
 * karakter bermakna, dan itu tetap utuh. Spasi ganda di tengah TIDAK
 * ditoleransi longgar: teks dinormalkan dulu supaya "HAPUS  DATA" tetap
 * diterima, karena itu murni kesalahan ketik, bukan frasa yang berbeda.
 */
export function cocokFrasaKonfirmasi(masukan: string, mode: ModeResetData): boolean {
  const normal = (t: string) => t.trim().replace(/\s+/g, ' ').toUpperCase();
  return normal(masukan) === normal(FRASA_KONFIRMASI[mode]);
}

/** Keadaan seluruh lapis konfirmasi pada satu waktu. */
export interface StatusKonfirmasiReset {
  mode: ModeResetData | null;
  /** Lapis 2 — pengguna menyatakan sudah membaca rincian dampak. */
  dampakDipahami: boolean;
  /** Lapis 3a — backup berhasil dibuat pada sesi ini. */
  backupDibuat: boolean;
  /** Lapis 3b — pengguna sengaja melanjutkan tanpa backup. */
  lanjutTanpaBackup: boolean;
  /** Lapis 4 — teks yang diketik pengguna. */
  frasaDiketik: string;
  /** Lapis 5 — apakah app-lock PIN aktif di perangkat ini. */
  pinDiperlukan: boolean;
  /** Lapis 5 — PIN sudah diverifikasi benar. */
  pinTerverifikasi: boolean;
}

export type AlasanBelumBoleh =
  | 'MODE_BELUM_DIPILIH'
  | 'DAMPAK_BELUM_DIPAHAMI'
  | 'BACKUP_BELUM_DIPUTUSKAN'
  | 'FRASA_BELUM_COCOK'
  | 'PIN_BELUM_TERVERIFIKASI';

/** Urutan lapis — dipakai UI untuk menampilkan langkah ke berapa yang sedang ditunggu. */
export const URUTAN_LAPIS: AlasanBelumBoleh[] = [
  'MODE_BELUM_DIPILIH',
  'DAMPAK_BELUM_DIPAHAMI',
  'BACKUP_BELUM_DIPUTUSKAN',
  'FRASA_BELUM_COCOK',
  'PIN_BELUM_TERVERIFIKASI',
];

export const PESAN_LAPIS: Record<AlasanBelumBoleh, string> = {
  MODE_BELUM_DIPILIH: 'Pilih jenis reset yang diinginkan.',
  DAMPAK_BELUM_DIPAHAMI: 'Baca rincian dampaknya, lalu nyatakan Anda sudah paham.',
  BACKUP_BELUM_DIPUTUSKAN: 'Buat backup dulu, atau nyatakan sengaja melanjutkan tanpa backup.',
  FRASA_BELUM_COCOK: 'Ketik frasa konfirmasi dengan benar.',
  PIN_BELUM_TERVERIFIKASI: 'Masukkan PIN Anda untuk membuktikan ini benar-benar Anda.',
};

/**
 * GERBANG TUNGGAL. UI TIDAK boleh menyusun syaratnya sendiri — kalau
 * disusun ulang di layar, satu lapis bisa lupa diikutkan saat layar
 * diubah, dan itu tepat jenis kesalahan yang paling mahal di sini.
 * Mengembalikan daftar lapis yang BELUM terpenuhi, urut sesuai
 * `URUTAN_LAPIS`; kosong berarti reset boleh dijalankan.
 */
export function lapisBelumTerpenuhi(status: StatusKonfirmasiReset): AlasanBelumBoleh[] {
  const kurang: AlasanBelumBoleh[] = [];
  if (!status.mode) kurang.push('MODE_BELUM_DIPILIH');
  if (!status.dampakDipahami) kurang.push('DAMPAK_BELUM_DIPAHAMI');
  if (!status.backupDibuat && !status.lanjutTanpaBackup) kurang.push('BACKUP_BELUM_DIPUTUSKAN');
  // Frasa hanya bisa dinilai kalau modenya sudah dipilih — frasa tiap
  // mode berbeda, jadi tanpa mode tidak ada yang bisa dicocokkan.
  if (!status.mode || !cocokFrasaKonfirmasi(status.frasaDiketik, status.mode)) kurang.push('FRASA_BELUM_COCOK');
  if (status.pinDiperlukan && !status.pinTerverifikasi) kurang.push('PIN_BELUM_TERVERIFIKASI');
  return kurang;
}

export function bolehJalankanReset(status: StatusKonfirmasiReset): boolean {
  return lapisBelumTerpenuhi(status).length === 0;
}

/** Keadaan awal layar — TIDAK ADA lapis yang sudah terpenuhi, mode belum dipilih. */
export function statusKonfirmasiAwal(pinDiperlukan: boolean): StatusKonfirmasiReset {
  return {
    mode: null,
    dampakDipahami: false,
    backupDibuat: false,
    lanjutTanpaBackup: false,
    frasaDiketik: '',
    pinDiperlukan,
    pinTerverifikasi: false,
  };
}

/**
 * Mengubah mode WAJIB mengosongkan lapis yang sudah dilewati.
 *
 * Tanpa ini ada lubang yang nyata: pengguna menyiapkan semua lapis untuk
 * "Hapus Data Transaksi", lalu menyentuh kartu "Reset Total" — dan
 * tombol terakhir sudah aktif untuk tindakan yang JAUH lebih merusak,
 * tanpa satu pun konfirmasi baru. Setiap penggantian mode memulai rantai
 * dari awal (frasanya pun berbeda, jadi harus diketik ulang).
 */
export function gantiMode(status: StatusKonfirmasiReset, mode: ModeResetData): StatusKonfirmasiReset {
  if (status.mode === mode) return status;
  return {
    ...statusKonfirmasiAwal(status.pinDiperlukan),
    // Backup yang SUDAH dibuat tetap dihitung: berkasnya nyata, tidak
    // hilang hanya karena pengguna berganti pikiran soal mode.
    backupDibuat: status.backupDibuat,
    mode,
  };
}
