/**
 * ============================================================
 * KEBIJAKAN PENARIKAN SEBELUM JATUH TEMPO — GAP TERDOKUMENTASI
 * ============================================================
 *
 * HASIL AUDIT KEBIJAKAN (§2), dikerjakan SEBELUM menulis implementasi:
 *
 *   POLICY FOUND: **NO**
 *
 * Pencarian menyeluruh di `src/`, `app/`, dan `src/ATURAN_BISNIS.md`
 * atas istilah: early withdrawal, premature, pencairan/penarikan sebelum
 * jatuh tempo, penalti, penalty, forfeiture, forfeit, break deposito,
 * biaya pencairan, potongan bunga, denda, penalty rate, biaya
 * administrasi, bunga berjalan.
 *
 * Seluruh temuan berasal dari domain PINJAMAN, bukan simpanan:
 *   - `denda` / `denda_tipe` / `denda_nilai`  -> denda keterlambatan angsuran
 *   - `4-1200 Pendapatan Denda`               -> denda angsuran pinjaman
 *   - `4-1150 Pendapatan Penalti Pelunasan`   -> penalti pelunasan pinjaman dipercepat
 *   - `PELUNASAN_PENALTI` / `PELUNASAN_ADMINISTRASI` -> pelunasan pinjaman
 *   - biaya administrasi pencairan            -> pencairan PINJAMAN
 *
 * TIDAK SATU PUN menyangkut simpanan berjangka. `ATURAN_BISNIS.md` §18.5
 * bahkan menyatakan eksplisit: "Tidak ada kebijakan penarikan dini dan
 * tidak ada penalti".
 *
 * KONSEKUENSI (§3):
 * Infrastruktur validasi & status UI DIBANGUN, tetapi jalur akuntansi
 * pembayaran DINI **TIDAK diimplementasikan**:
 *
 *   EARLY WITHDRAWAL ACCOUNTING: NOT IMPLEMENTED — POLICY REQUIRED
 *
 * Yang SENGAJA TIDAK dikarang, karena tidak ada dasarnya:
 *   - persentase penalti
 *   - potongan/forfeiture bunga terakru
 *   - biaya administrasi pencairan dini
 *   - perubahan rate menjadi rate tabungan biasa
 *   - pembayaran hanya pokok tanpa bunga
 *
 * Masing-masing pilihan di atas menghasilkan jurnal, saldo anggota, dan
 * beban bunga yang BERBEDA. Memilih salah satunya tanpa kebijakan berarti
 * mengarang aturan keuangan yang mengikat anggota — dan begitu ada satu
 * kontrak dicairkan dengan aturan karangan itu, jurnalnya sudah terposting
 * dan tidak bisa ditarik kembali diam-diam.
 *
 * APA YANG DIBUTUHKAN AGAR FITUR INI BISA DISELESAIKAN:
 * keputusan tertulis pengurus koperasi atas empat hal —
 *   1. apakah penarikan dini diizinkan sama sekali;
 *   2. perlakuan bunga yang SUDAH diakru (dibayar penuh / sebagian /
 *      dibatalkan) dan jurnal pembalikannya bila dibatalkan;
 *   3. ada/tidaknya penalti, dasar perhitungannya, dan akun pendapatan
 *      yang menampungnya;
 *   4. apakah status berakhir di `DICAIRKAN` atau status baru.
 * Setelah keempatnya ada, implementasinya langsung dan dapat diuji.
 *
 * ============================================================
 * PEMUTAKHIRAN S21 — ARSITEKTUR ADA, ANGKA TETAP TIDAK ADA
 * ============================================================
 * S21 membangun mesin kebijakan & perhitungan penarikan dini secara
 * penuh (`EarlyWithdrawalPolicy.ts`, `EarlyWithdrawalCalculation.ts`,
 * `SimpananBerjangkaEarlyWithdrawalService.ts`) berikut jurnal,
 * subledger, laporan, dan tesnya. Keenam kapabilitas yang diminta —
 * penalti, bunga hangus, biaya administrasi, penyesuaian rate,
 * perlakuan pokok, perlakuan bunga — kini punya tempatnya masing-masing
 * dan dapat diisi tanpa redesign.
 *
 * YANG TIDAK BERUBAH: koperasi masih BELUM menerbitkan angka apa pun.
 * Karena itu konstanta di bawah TETAP `false` — aplikasi tidak
 * mengapalkan kebijakan bawaan, dan tanpa baris di
 * `simpanan_berjangka_kebijakan_dini` status kebijakan adalah
 * POLICY_REQUIRED sehingga penarikan dini tetap DITOLAK. Konstanta ini
 * menjawab "apakah ada kebijakan bawaan", bukan "apakah aplikasi mampu
 * menjalankan penarikan dini".
 *
 * Kebijakan yang BERLAKU dibaca dari database lewat
 * `getKebijakanDiniAktif()`; jangan menyimpulkan apa pun dari konstanta
 * ini selain "tidak ada default bawaan".
 */

/** Apakah koperasi memiliki kebijakan penarikan dini yang berlaku? */
export const KEBIJAKAN_PENARIKAN_DINI_TERSEDIA = false as const;

/** Pesan tunggal saat kontrak belum jatuh tempo. Dipakai service & UI. */
export const PESAN_PENARIKAN_DINI_TANPA_KEBIJAKAN =
  'Pencairan sebelum jatuh tempo belum tersedia karena ketentuan koperasi untuk penarikan dini ' +
  '(perlakuan bunga dan ada/tidaknya penalti) belum ditetapkan.';

export type KelayakanPencairan =
  /** Jatuh tempo — jalur pencairan normal berlaku. */
  | 'BOLEH_NORMAL'
  /** Belum jatuh tempo DAN tidak ada kebijakan penarikan dini. */
  | 'DINI_TANPA_KEBIJAKAN'
  /** Belum jatuh tempo DAN kebijakan penarikan dini lengkap & berlaku. */
  | 'BOLEH_DINI'
  /** Sudah dicairkan / dibatalkan. */
  | 'TIDAK_BERLAKU';

/**
 * Kelayakan pencairan berdasarkan status kontrak.
 *
 * Fungsi murni tanpa akses database, sehingga UI dan service memakai
 * aturan yang sama persis dan tidak mungkin berbeda pendapat tentang
 * kontrak mana yang boleh dicairkan.
 *
 * `kebijakanDiniBerlaku` DEFAULT `false` dengan sengaja: pemanggil yang
 * tidak tahu-menahu soal kebijakan tidak boleh mendapat jawaban "boleh
 * dini". Nilai `true` hanya diisi pemanggil yang benar-benar sudah
 * mengevaluasi kebijakan lewat `evaluasiKebijakanEarlyWithdrawal()`.
 */
export function evaluasiKelayakanPencairan(
  status: string,
  kebijakanDiniBerlaku: boolean = false
): KelayakanPencairan {
  if (status === 'JATUH_TEMPO') return 'BOLEH_NORMAL';
  if (status === 'AKTIF') return kebijakanDiniBerlaku ? 'BOLEH_DINI' : 'DINI_TANPA_KEBIJAKAN';
  return 'TIDAK_BERLAKU';
}
