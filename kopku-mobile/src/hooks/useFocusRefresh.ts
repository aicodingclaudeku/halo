import React, { useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';

/**
 * ============================================================
 * REFRESH DATA SAAT LAYAR KEMBALI DIFOKUSKAN
 * ============================================================
 *
 * ROOT CAUSE yang ditangani hook ini:
 *
 * `LaporanStack`/`TransaksiStack` adalah native-stack navigator, dan
 * navigator TIDAK meng-unmount layar yang ditinggalkan — layar hanya
 * kehilangan FOKUS dan tetap hidup di tumpukan beserta seluruh state-
 * nya. Layar laporan memuat datanya lewat:
 *
 *     useEffect(() => { load(...); }, [asOfDate, sertakanDraft, ...]);
 *
 * Dependensinya adalah nilai FILTER, bukan peristiwa navigasi. Jadi
 * ketika pengguna keluar ke Transaksi, mencatat transaksi, lalu kembali,
 * tidak ada satu pun dependensi yang berubah -> efek tidak dijalankan
 * ulang -> layar menampilkan hasil perhitungan LAMA. Menutup Expo Go
 * memaksa remount, dan itulah sebabnya angka baru baru muncul setelah
 * restart.
 *
 * Jadi ini murni masalah LIFECYCLE UI. Datanya sendiri sudah benar di
 * SQLite sejak transaksi di-commit — tidak ada satu pun angka akuntansi
 * yang salah, dan tidak ada yang perlu diubah di AccountingEngine,
 * jurnal, GL, subledger, EIR, atau klasifikasi arus kas.
 *
 * YANG SENGAJA TIDAK DIPAKAI:
 *  - `setTimeout`/`setInterval`/polling: kondisi yang ditunggu adalah
 *    PERISTIWA (layar difokuskan), bukan durasi. Timer hanya akan
 *    menebak-nebak dan tetap salah.
 *  - remount paksa lewat `key`: membuang state layar (filter, posisi
 *    gulir) hanya untuk memicu ulang satu kueri.
 *  - memindahkan saldo ke Zustand: SQLite tetap satu-satunya sumber
 *    kebenaran; store hanya cache UI.
 *
 * SATU LIFECYCLE OTORITATIF (§4):
 * `useFocusEffect` menjalankan callback saat layar difokuskan DAN saat
 * identitas callback berubah selagi layar fokus — sehingga ia sudah
 * mencakup perilaku `useEffect` untuk perubahan filter. Karena itu
 * layar mengGANTI `useEffect`-nya dengan hook ini, BUKAN menambahkan di
 * sampingnya; memasang keduanya akan menghasilkan dua kueri per
 * perubahan filter.
 *
 * SATU LOAD PER FOKUS (§9/§25): callback dibungkus `useCallback` oleh
 * pemanggil, jadi identitasnya stabil selama filter tidak berubah dan
 * `useFocusEffect` hanya menjalankannya sekali tiap peristiwa fokus —
 * bukan menumpuk.
 */
export function useFocusRefresh(muat: () => void, deps: React.DependencyList = []): void {
  // Referensi terbaru disimpan di ref supaya callback yang dijalankan
  // selalu versi terbaru, sementara efeknya sendiri hanya bergantung
  // pada `deps` yang diberikan pemanggil. Tanpa ini, callback inline
  // (identitasnya berubah tiap render) akan memicu pemuatan ulang pada
  // SETIAP render — persis masalah performa yang dilarang §9/§25.
  const muatRef = useRef(muat);
  muatRef.current = muat;

  useFocusEffect(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useCallback(() => {
      muatRef.current();
    }, deps)
  );
}

/**
 * Penjaga balapan untuk pemuatan asinkron (§10).
 *
 * Skenario yang dicegah: fokus -> blur -> fokus dengan cepat, atau
 * filter diubah berkali-kali. Pemuatan pertama bisa selesai SETELAH
 * pemuatan kedua, lalu menimpa hasil yang lebih baru dengan hasil yang
 * lebih lama. Untuk laporan keuangan, itu berarti angka yang tampil
 * bukan cuma usang — ia bisa tampak "berubah sendiri" ke nilai lama
 * tanpa sebab yang terlihat.
 *
 * Pemakaian:
 *
 *     const permintaan = usePermintaanTerakhir();
 *     const load = useCallback(async () => {
 *       const token = permintaan.mulai();
 *       const hasil = await hitungLaporan();
 *       if (!permintaan.masihTerbaru(token)) return; // hasil basi -> buang
 *       setData(hasil);
 *     }, [permintaan]);
 *
 * Hasil yang basi DIBUANG diam-diam: ia bukan error, hanya jawaban atas
 * pertanyaan yang sudah tidak ditanyakan lagi.
 */
export function usePermintaanTerakhir() {
  const penghitung = useRef(0);

  const mulai = useCallback(() => {
    penghitung.current += 1;
    return penghitung.current;
  }, []);

  const masihTerbaru = useCallback((token: number) => penghitung.current === token, []);

  return useRef({ mulai, masihTerbaru }).current;
}
