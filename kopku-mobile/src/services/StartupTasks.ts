import { jalankanPenyusutanOtomatisJikaPerlu } from '@/services/PenyusutanService';
import { bolehMenjalankanTugasOtomatis, bolehTugasOtomatisSinkron } from '@/sync/SyncKebijakan';
import { jalankanAkrualJasaOtomatisJikaPerlu } from '@/services/AkrualJasaPinjamanService';
import { jalankanEirOtomatisJikaPerlu } from '@/services/EirAccountingService';
import { jalankanCatchUpAkrualSimpananBerjangka } from '@/services/SimpananBerjangkaCatchUpService';
import { jalankanAkrualBungaSukarelaOtomatis } from '@/services/BungaSukarelaService';
import { daftarkanTaskAkrualBerjangka } from '@/services/SimpananBerjangkaBackgroundTask';
import { jalankanAkrualBungaUtangJikaPerlu } from '@/services/UtangBungaAccrualService';

/**
 * ============================================================
 * KOORDINATOR TUGAS LATAR SAAT APLIKASI SIAP (root cause BUG
 * "Posisi Keuangan first open != second open").
 * ============================================================
 *
 * ROOT CAUSE yang diperbaiki modul ini (bukan rounding, bukan UI):
 *
 * `app/index.tsx` memulai DUA pekerjaan yang MENULIS JURNAL tepat saat
 * fase berpindah ke READY:
 *   jalankanPenyusutanOtomatisJikaPerlu(...)
 *   jalankanAkrualJasaOtomatisJikaPerlu(...)
 * Keduanya sengaja TIDAK di-`await` supaya login tidak tertunda.
 *
 * Dua konsekuensi yang keduanya nyata:
 *
 * 1. KEDUANYA JALAN BERSAMAAN pada SATU koneksi SQLite yang sama
 *    (`dbInstance` singleton di db.ts). `withTransaction()` memakai
 *    `db.withTransactionAsync` = BEGIN/COMMIT pada koneksi itu. BEGIN
 *    tidak reentrant: transaksi kedua yang tumpang-tindih dengan yang
 *    pertama tidak terisolasi — COMMIT milik satu pekerjaan ikut
 *    mengunci pekerjaan lain yang baru setengah jalan.
 *
 * 2. Laporan yang dibuka SEBELUM pekerjaan itu selesai membaca ledger
 *    pada koneksi yang SAMA, sehingga ikut melihat baris yang BELUM
 *    lengkap. `createJournal()` menulis header jurnal dulu, baru tiap
 *    baris `journal_entry` satu per satu di dalam loop. Pembacaan yang
 *    jatuh di tengah loop itu melihat jurnal POSTED yang baru punya
 *    SEBAGIAN kakinya.
 *
 * Kenapa itu menghasilkan SELISIH, bukan sekadar "angka berbeda":
 * `getTrialBalance` menetralkan debit-kredit dengan tanda yang benar,
 * jadi Aset = Liabilitas + Ekuitas berlaku PERSIS selama himpunan baris
 * yang terbaca itu sendiri seimbang. Filter tanggal & status selalu
 * membuang jurnal SECARA UTUH (dua kaki sekaligus), jadi keduanya tidak
 * pernah bisa membuat laporan timpang. Satu-satunya cara membaca
 * himpunan yang TIDAK seimbang adalah melihat jurnal yang sebagian
 * kakinya belum tertulis — persis kondisi di atas. Begitu pekerjaan
 * latar selesai, jurnalnya utuh dan pembukaan KEDUA kembali 0.
 *
 * PERBAIKAN (murni lifecycle — TIDAK ADA formula akuntansi, mapping GL,
 * EIR, deferred income, penyusutan, klasifikasi arus kas, atau aturan
 * periode tertutup yang disentuh):
 *
 *   a. Kedua pekerjaan dijalankan BERURUTAN, bukan bersamaan, sehingga
 *      tidak ada lagi dua transaksi tumpang-tindih di satu koneksi.
 *   b. Modul ini menyimpan promise pekerjaan yang sedang berjalan dan
 *      mengekspos `tungguTugasStartupSelesai()`. Layar laporan
 *      menunggunya SEBELUM menghitung, jadi laporan tidak pernah lagi
 *      dihitung di atas penulisan yang belum selesai.
 *
 * Yang SENGAJA TIDAK dilakukan (dilarang eksplisit oleh tiket §7):
 * tidak ada toleransi pembulatan, tidak ada `Math.abs(selisih) < X`,
 * tidak ada `force balance = 0`, tidak ada `setTimeout`/delay sebagai
 * alat sinkronisasi. Gate di bawah menunggu PENYELESAIAN NYATA dari
 * promise pekerjaan, bukan menunggu durasi yang dikarang.
 */

/**
 * Promise pekerjaan latar yang sedang berjalan. `null` berarti tidak ada
 * pekerjaan yang sedang menulis — gate langsung lolos tanpa menunggu apa
 * pun (kondisi normal untuk pembukaan layar ke-2 dan seterusnya).
 */
let tugasBerjalan: Promise<void> | null = null;

// ===========================================================================
// HOTFIX RC-S74 — METADATA RUNTIME UNTUK ESTIMASI TAMPILAN
// ===========================================================================
//
// Hanya INFORMASI untuk UI (mis. "Estimasi selesai dalam ±N detik" di
// Bayar Kewajiban). BUKAN alat sinkronisasi dan BUKAN timeout: penyelesaian
// tetap HANYA ditentukan promise `tugasBerjalan` lewat
// `tungguTugasStartupSelesai()`. Tidak ada yang dibatalkan, diulang, atau
// dipaksa selesai berdasarkan angka-angka ini.
//
// Disimpan di memori proses saja (tanpa tabel, tanpa migrasi): aplikasi
// yang baru dibuka belum punya riwayat, dan UI menampilkan estimasi
// kualitatif sampai satu batch benar-benar selesai diukur.

/** Jumlah durasi batch terakhir yang dirata-rata (rolling average). */
export const MAKS_SAMPEL_DURASI_TUGAS = 5;

/** Waktu mulai (ms epoch) batch yang SEDANG dieksekusi; null = tidak ada. */
let waktuMulaiTugas: number | null = null;

/** Durasi AKTUAL batch yang selesai normal, terbaru di akhir. */
const riwayatDurasiTugasMs: number[] = [];

function catatDurasiTugas(durasiMs: number): void {
  if (!Number.isFinite(durasiMs) || durasiMs < 0) return;
  riwayatDurasiTugasMs.push(durasiMs);
  if (riwayatDurasiTugasMs.length > MAKS_SAMPEL_DURASI_TUGAS) riwayatDurasiTugasMs.shift();
}

export interface StatusTugasStartup {
  /** Ada batch yang sedang berjalan atau sudah dirantai (sama dengan gate). */
  readonly berjalan: boolean;
  /** Mulai batch yang sedang dieksekusi; null bila tidak berjalan / belum mulai. */
  readonly mulaiMs: number | null;
  /** Rata-rata durasi aktual batch terakhir; null bila belum ada riwayat. */
  readonly estimasiMs: number | null;
  /** Jumlah sampel durasi yang membentuk `estimasiMs`. */
  readonly jumlahSampel: number;
}

/**
 * Potret metadata runtime koordinator. Murni membaca variabel modul —
 * tidak menyentuh database dan tidak memulai pekerjaan apa pun, jadi aman
 * dibaca kapan saja oleh layar.
 */
export function getStatusTugasStartup(): StatusTugasStartup {
  const n = riwayatDurasiTugasMs.length;
  const estimasiMs = n > 0 ? riwayatDurasiTugasMs.reduce((a, b) => a + b, 0) / n : null;
  const berjalan = tugasBerjalan !== null;
  return { berjalan, mulaiMs: berjalan ? waktuMulaiTugas : null, estimasiMs, jumlahSampel: n };
}

/**
 * Mulai pekerjaan latar pasca-login/unlock. TIDAK di-`await` oleh
 * pemanggil (perilaku lama dipertahankan: login tidak boleh tertunda),
 * tetapi sekarang hasilnya DILACAK supaya pembaca laporan bisa menunggu.
 *
 * Kalau masih ada pekerjaan sebelumnya yang berjalan (mis. aplikasi
 * kembali dari background sebelum batch sebelumnya selesai), pekerjaan
 * baru DIRANTAI setelahnya — bukan dijalankan paralel. Ini yang mencegah
 * BEGIN bersarang pada koneksi tunggal.
 */
export function jalankanTugasStartup(userId: string): Promise<void> {
  const sebelumnya = tugasBerjalan ?? Promise.resolve();

  const berikutnya = sebelumnya
    .catch(() => {})
    .then(async () => {
      // HOTFIX RC-S74 — ukur durasi AKTUAL batch ini (metadata tampilan saja).
      const mulai = Date.now();
      waktuMulaiTugas = mulai;
      try {
        await jalankanLangkahTugas(userId);
        catatDurasiTugas(Date.now() - mulai);
      } finally {
        if (waktuMulaiTugas === mulai) waktuMulaiTugas = null;
      }
    })
    .finally(() => {
      // Hanya bersihkan kalau promise INI yang paling akhir terdaftar —
      // kalau sudah ada batch berikutnya yang dirantai, biarkan dia yang
      // memegang gate.
      if (tugasBerjalan === berikutnya) tugasBerjalan = null;
    });

  tugasBerjalan = berikutnya;
  return berikutnya;
}

/**
 * Isi satu batch, urutan TIDAK berubah (dipindah apa adanya dari body
 * `jalankanTugasStartup` supaya pengukuran durasi membungkusnya utuh).
 */
async function jalankanLangkahTugas(userId: string): Promise<void> {
  // SINKRON HP⇄DESKTOP — selama perangkat terpasang, hanya PERANGKAT UTAMA
  // yang menjurnal otomatis (lihat src/sync/SyncKebijakan.ts). Perangkat
  // yang tidak pernah dipasangkan selalu lolos: perilaku lama tidak berubah.
  const izinCepat = bolehTugasOtomatisSinkron();
  if (izinCepat === false) return;
  if (izinCepat === null && !(await bolehMenjalankanTugasOtomatis())) return;
  // Berurutan, bukan Promise.all — lihat alasan (a) di atas.
  // Kedua fungsi ini sudah menangani errornya sendiri secara
  // internal; `.catch()` di sini tetap dipasang sebagai jaring
  // pengaman terakhir supaya satu kegagalan tidak pernah membuat
  // gate `tungguTugasStartupSelesai()` menggantung selamanya.
  await jalankanPenyusutanOtomatisJikaPerlu(userId).catch(() => {});
  await jalankanAkrualJasaOtomatisJikaPerlu(userId).catch(() => {});
  // RC-S54 TAHAP 9 — PENYESUAIAN EIR (amortized cost) OTOMATIS.
  // Satu-satunya pemicu produksi `prosesEirBulanan`. Berurutan setelah
  // akrual jasa, pada koneksi yang sama. Fungsi tidak melempar: kegagalan
  // per pinjaman/periode dikembalikan & tersedia lewat
  // `getHasilEirOtomatisTerakhir()`.
  await jalankanEirOtomatisJikaPerlu(userId);
  // CATCH-UP AKRUAL BUNGA SIMPANAN BERJANGKA (§18).
  //
  // Dijalankan BERURUTAN bersama pekerjaan latar lain, bukan
  // paralel — alasannya sama seperti dua pekerjaan di atas: satu
  // koneksi SQLite, transaksi tidak boleh tumpang-tindih.
  //
  // Ini adalah jaring pengaman utama, BUKAN pelengkap: kalau OS
  // tidak pernah menjalankan background task (Expo Go, Background
  // App Refresh dimatikan, perangkat hemat daya), catch-up di sini
  // tetap mengakru SELURUH periode yang terlewat. Fungsinya tidak
  // pernah melempar, jadi tidak bisa menggantung gate laporan.
  await jalankanCatchUpAkrualSimpananBerjangka(userId);
  // AKRUAL BUNGA HARIAN SIMPANAN SUKARELA (kebijakan, default OFF —
  // tanpa versi kebijakan aktif fungsi ini langsung kembali). Setelah
  // akrual berjangka supaya transfer bunga berjangka ke sukarela bulan itu
  // sudah masuk saldo. Tidak melempar; bila berhenti (mis. periode
  // tertutup) pesannya tersedia lewat getHasilAkrualOtomatisTerakhir().
  await jalankanAkrualBungaSukarelaOtomatis(userId).catch(() => undefined);
  // RC-S55 — AKRUAL BUNGA UTANG OTOMATIS.
  //
  // Dirantai BERURUTAN dengan pekerjaan latar lain, alasan sama seperti
  // di atas: satu koneksi SQLite, transaksi tidak boleh tumpang-tindih.
  //
  // Karena gate `tungguTugasStartupSelesai()` di bawah ditunggu oleh
  // layar laporan, menempatkannya di sini sekaligus memenuhi syarat
  // "laporan akuntansi membaca saldo setelah periode terbuka catch-up":
  // Posisi Keuangan & Hasil Usaha tidak pernah lagi dihitung di atas
  // periode yang bunganya belum diakru.
  //
  // Fungsinya menelan errornya sendiri dan memakai gerbang eksekusi
  // tunggal, jadi pemanggilan berulang (startup, foreground, dashboard)
  // tidak pernah menggandakan jurnal maupun menggantung gate ini.
  await jalankanAkrualBungaUtangJikaPerlu(userId);
  // Registrasi task OS bersifat best-effort dan idempoten
  // (isTaskRegisteredAsync diperiksa lebih dulu) — membuka aplikasi
  // berkali-kali tetap menghasilkan satu task.
  await daftarkanTaskAkrualBerjangka(userId).catch(() => false);
}

/**
 * Menunggu SELURUH pekerjaan latar yang sedang menulis ledger selesai.
 *
 * Dipanggil oleh layar laporan sebelum menghitung. Kalau tidak ada
 * pekerjaan yang berjalan (kasus paling umum), fungsi ini resolve
 * seketika tanpa penundaan apa pun — jadi tidak menambah latensi pada
 * pembukaan laporan yang normal.
 */
export async function tungguTugasStartupSelesai(): Promise<void> {
  // Loop: pekerjaan bisa merantai pekerjaan baru sementara kita menunggu.
  while (tugasBerjalan) {
    const menunggu = tugasBerjalan;
    await menunggu.catch(() => {});
    if (tugasBerjalan === menunggu) break;
  }
}

/** Hanya untuk test — mengosongkan state modul antar-skenario. */
export function _resetTugasStartupUntukTest(): void {
  tugasBerjalan = null;
  waktuMulaiTugas = null;
  riwayatDurasiTugasMs.length = 0;
}
