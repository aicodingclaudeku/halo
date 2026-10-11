import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  prosesAkrualBungaSemuaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  processAccruedTermDepositInterestDue,
} from '@/services/SimpananBerjangkaLifecycleService';

/**
 * ============================================================
 * CATCH-UP AKRUAL BUNGA SIMPANAN BERJANGKA — SATU PINTU
 * ============================================================
 *
 * SATU service untuk KETIGA pemicu (§14):
 *   A. background task OS   (SimpananBerjangkaBackgroundTask.ts)
 *   B. catch-up saat startup (StartupTasks.ts)
 *   C. catch-up saat layar difokuskan (Dashboard / Simpanan Berjangka)
 *
 * Ketiganya memanggil `jalankanCatchUpAkrualSimpananBerjangka()` — TIDAK
 * ADA tiga formula, tidak ada tiga jalur akuntansi. Mesin bunganya tetap
 * `SimpananBerjangkaBunga.ts` dan penjurnalannya tetap lewat
 * `AccountingEngine` seperti sebelumnya; modul ini murni ORKESTRASI.
 *
 * KENAPA CATCH-UP, BUKAN "akru bulan ini" (§19):
 * OS seluler boleh menunda atau tidak menjalankan background task sama
 * sekali, dan aplikasi bisa saja tidak dibuka berbulan-bulan. Karena itu
 * kelayakan akrual TIDAK PERNAH ditentukan oleh "kapan scheduler
 * berjalan", melainkan oleh perbandingan tanggal berjalan dengan periode
 * yang BELUM punya event akrual. `prosesAkrualBungaSemuaKontrak()` sudah
 * bekerja begitu: ia mencari SELURUH periode yang sudah earned tetapi
 * belum terakru, lalu memprosesnya berurutan. Aplikasi yang ditutup dari
 * Januari sampai April akan mengakru Februari, Maret, dan April — bukan
 * hanya April.
 *
 * Scheduler hanya MEMICU eksekusi; ia tidak pernah menentukan besaran
 * maupun periode bunga (§44).
 *
 * KENAPA TIDAK ADA setTimeout/setInterval (§45):
 * timer JavaScript mati begitu proses aplikasi berhenti, jadi ia tidak
 * pernah bisa menjadi penjadwal akuntansi. Yang dipakai hanya background
 * task OS + catch-up di foreground. Modul ini tidak memuat satu timer
 * pun.
 *
 * IDEMPOTENSI BERLAPIS (§25):
 *   1. penjaga in-process di bawah (mencegah dua pemicu yang datang
 *      hampir bersamaan menjalankan batch ganda dalam satu proses);
 *   2. pengecekan event akrual per periode di dalam service;
 *   3. UNIQUE(simpanan_berjangka_id, nomor_periode) di database —
 *      PERLINDUNGAN TERAKHIR yang tidak bisa ditembus race apa pun.
 * Lapis 1 adalah optimasi, BUKAN jaminan; jaminannya ada di lapis 3.
 */

export interface HasilCatchUpAkrual {
  /** Tanggal acuan yang dipakai untuk menentukan periode earned. */
  sampaiTanggal: string;
  /** Jumlah kontrak yang benar-benar mendapat akrual baru. */
  kontrakDiakru: number;
  /** Jumlah periode akrual baru yang dijurnal. */
  periodeDiakru: number;
  /** Kontrak yang transisi AKTIF -> JATUH_TEMPO. */
  kontrakJatuhTempo: number;
  /**
   * §B — kontrak yang bunganya berpindah ke Simpanan Sukarela pada
   * batch ini. 0 berarti tidak ada yang baru; dipakai pemanggil untuk
   * memutuskan perlu-tidaknya memberi umpan balik ke pengguna.
   */
  kontrakBungaDipindahkan: number;
  /** Jumlah periode bunga yang dipindahkan pada batch ini. */
  periodeBungaDipindahkan: number;
  /** Total rupiah bunga yang dipindahkan pada batch ini. */
  totalBungaDipindahkan: number;
  /** Kegagalan per kontrak (mis. periode tertutup) — TIDAK dilempar. */
  gagal: { kontrakId: string; alasan: string }[];
  /** true bila batch dilewati karena sudah ada batch yang berjalan. */
  dilewati: boolean;
}

/**
 * Penjaga in-process: satu batch pada satu waktu. Bila pemicu lain
 * datang saat batch sedang berjalan, ia MENUNGGU hasil batch itu alih-
 * alih memulai batch kedua — sehingga background task, startup, dan
 * focus yang menyala bersamaan hanya menghasilkan satu kali pemrosesan.
 */
let batchBerjalan: Promise<HasilCatchUpAkrual> | null = null;

/**
 * Menjalankan catch-up akrual bunga + transisi jatuh tempo.
 *
 * TIDAK PERNAH melempar: dipanggil dari jalur latar dan dari lifecycle
 * layar, di mana pengecualian yang lolos akan menjatuhkan UI atau
 * menandai background task gagal. Kegagalan per kontrak dikumpulkan di
 * `gagal` supaya tetap terlihat dan dapat diaudit.
 *
 * @param createdBy user yang tercatat sebagai pembuat jurnal akrual.
 * @param tanggalAcuan opsional; default tanggal LOKAL hari ini
 *        (WIB/WITA/WIT), bukan UTC.
 */
export async function jalankanCatchUpAkrualSimpananBerjangka(
  createdBy: string,
  tanggalAcuan?: string
): Promise<HasilCatchUpAkrual> {
  if (batchBerjalan) {
    const hasil = await batchBerjalan;
    return { ...hasil, dilewati: true };
  }

  const jalankan = async (): Promise<HasilCatchUpAkrual> => {
    const sampaiTanggal = tanggalAcuan ?? getTanggalLokalHariIni();
    const gagal: { kontrakId: string; alasan: string }[] = [];

    let kontrakDiakru = 0;
    let periodeDiakru = 0;
    let kontrakJatuhTempo = 0;
    let kontrakBungaDipindahkan = 0;
    let periodeBungaDipindahkan = 0;
    let totalBungaDipindahkan = 0;

    try {
      // 1) Akru SELURUH periode yang sudah earned tetapi belum terakru.
      const akrual = await prosesAkrualBungaSemuaKontrak(sampaiTanggal, createdBy);
      kontrakDiakru = akrual.diproses.length;
      periodeDiakru = akrual.diproses.reduce((n, h) => n + h.periodeDiakui.length, 0);
      gagal.push(...akrual.gagal);

      // 2) Baru kemudian transisi jatuh tempo, supaya kontrak yang
      //    berpindah ke JATUH_TEMPO sudah lengkap bunganya lebih dulu
      //    (§27). Urutan ini disengaja dan tidak boleh dibalik.
      const maturity = await prosesJatuhTempoSimpananBerjangka(sampaiTanggal, createdBy);
      kontrakJatuhTempo = maturity.jatuhTempo.length;
      gagal.push(...maturity.gagalAkrual);

      // 3) §B — pemindahan bunga yang SUDAH terakru ke Simpanan
      //    Sukarela. Dijalankan PALING AKHIR dan urutannya tidak boleh
      //    dibalik: yang dipindahkan hanya periode yang sudah punya
      //    event akrual, jadi langkah 1 harus selesai lebih dulu.
      //    Kontrak yang baru saja dicairkan di langkah 2 pun sudah
      //    berstatus DICAIRKAN sehingga otomatis tidak ikut diproses.
      //
      //    Menempatkannya DI SINI — bukan sebagai pemicu baru di
      //    startup/screen/background — berarti KETIGA pemicu yang sudah
      //    ada langsung mendapatkannya tanpa satu pun caller tambahan,
      //    dan mustahil ada pemicu yang mengakru tetapi lupa
      //    memindahkan.
      const transfer = await processAccruedTermDepositInterestDue(sampaiTanggal, createdBy);
      kontrakBungaDipindahkan = transfer.diproses.length;
      periodeBungaDipindahkan = transfer.diproses.reduce(
        (n, h) => n + h.periodeDipindahkan.length,
        0
      );
      totalBungaDipindahkan = transfer.totalDipindahkan;
      gagal.push(...transfer.gagal);
    } catch (e) {
      gagal.push({
        kontrakId: '-',
        alasan: e instanceof Error ? e.message : 'Kesalahan tidak diketahui saat catch-up.',
      });
    }

    return {
      sampaiTanggal,
      kontrakDiakru,
      periodeDiakru,
      kontrakJatuhTempo,
      kontrakBungaDipindahkan,
      periodeBungaDipindahkan,
      totalBungaDipindahkan,
      gagal,
      dilewati: false,
    };
  };

  const promise = jalankan().finally(() => {
    if (batchBerjalan === promise) batchBerjalan = null;
  });
  batchBerjalan = promise;
  return promise;
}

/** Hanya untuk test — mengosongkan penjaga in-process antar skenario. */
export function _resetCatchUpUntukTest(): void {
  batchBerjalan = null;
}
