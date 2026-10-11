import { getDb, withTransaction } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { getRekonsiliasiTerakhirPerAkun, rekonsiliasiMenghalangiTutupPeriode, getStatusRekonsiliasiPeriode } from '@/services/CashReconciliationService';
import { getModePenyusutan, jalankanPenyusutanOtomatisUntukTahunBuku } from '@/services/PenyusutanService';
import { getRATByTahunBuku } from '@/services/RATService';
import { tungguTugasStartupSelesai } from '@/services/StartupTasks';
import {
  getJejakAkrualBungaUtang,
  jalankanAkrualBungaUtangJikaPerlu,
  periodeTerakhirSelesai,
} from '@/services/UtangBungaAccrualService';
import { getKontrolGapUtangBungaAsOf, listUtang } from '@/services/UtangService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * PeriodCloseService — Phase 11 (AUDIT_INTERNAL.md §5:
 * "PeriodCloseService: MISSING", §2 poin 3: "kolom & pengecekan CLOSED
 * period sudah ada di AccountingEngine.resolvePeriod sejak awal, tapi
 * tidak ada jalan untuk benar-benar mengubah status ke CLOSED").
 *
 * Periode yang OPEN & sudah lewat SELALU bisa ditutup kalau syaratnya
 * terpenuhi — TIDAK ADA cara untuk "membuka lagi" periode yang sudah
 * CLOSED (sengaja tidak dibuat: SAK & requirement asli eksplisit
 * bilang "CLOSED period tidak boleh menerima transaksi", membuka
 * kembali periode yang sudah ditutup butuh proses koreksi/approval
 * terpisah yang di luar scope Phase 11 ini — kalau dibutuhkan, itu
 * fitur baru yang harus dirancang eksplisit, bukan cuma UPDATE status
 * balik ke OPEN).
 */

export interface RingkasanPenutupanPeriode {
  periodeId: string;
  trialBalanceSeimbang: boolean;
  totalDebit: number;
  totalKredit: number;
  rekonsiliasiBermasalah: { accountId: string; namaRekening: string; selisih: number; tanggal: string }[];
  bolehDitutup: boolean;
  alasanTidakBolehDitutup?: string;
}

/**
 * Cek kesiapan periode untuk ditutup — dipanggil dari UI SEBELUM
 * `tutupPeriode()` supaya user bisa lihat dulu apa yang menghalangi,
 * bukan cuma dapat error generik.
 */
export async function getRingkasanPenutupanPeriode(periodeId: string): Promise<RingkasanPenutupanPeriode> {
  const db = await getDb();

  const periode = await db.getFirstAsync<{ periode_mulai: string; periode_selesai: string; status: string }>(
    `SELECT periode_mulai, periode_selesai, status FROM accounting_period WHERE id = ?`,
    periodeId
  );
  if (!periode) {
    return {
      periodeId,
      trialBalanceSeimbang: false,
      totalDebit: 0,
      totalKredit: 0,
      rekonsiliasiBermasalah: [],
      bolehDitutup: false,
      alasanTidakBolehDitutup: 'Periode tidak ditemukan.',
    };
  }

  // Defense-in-depth: createJournal SELALU memvalidasi balance per
  // jurnal sebelum diposting, jadi ini SEHARUSNYA selalu true. Dicek
  // ulang di sini murni sebagai jaring pengaman terakhir sebelum
  // periode dikunci permanen — kalau ada bug lain yang lolos, jangan
  // sampai periode yang tidak balance malah bisa ditutup.
  //
  // PHASE 1.1 (harden): rentang query di-scope PENUH ke periode ini
  // (periode_mulai <= tanggal <= periode_selesai) — sebelumnya HANYA
  // ada batas atas (tanggal <= periode_selesai), jadi transaksi dari
  // periode LAIN (mis. tahun buku sebelumnya) ikut terhitung. Trial
  // balance per-jurnal memang selalu seimbang sendiri (jaring pengaman
  // ini secara matematis tidak akan pernah gagal), tapi scoping yang
  // benar penting supaya jaring pengaman ini betul-betul memeriksa
  // SATU periode yang sedang ditutup, bukan gabungan semua periode —
  // terutama kalau nanti ada pemeriksaan lain yang ditambahkan di sini
  // yang BUKAN invariant matematis seperti ini.
  const totalRow = await db.getFirstAsync<{ total_debit: number; total_kredit: number }>(
    `SELECT COALESCE(SUM(je.debit),0) as total_debit, COALESCE(SUM(je.kredit),0) as total_kredit
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE j.status IN ('POSTED','REVERSED') AND j.tanggal >= ? AND j.tanggal <= ?`,
    periode.periode_mulai,
    periode.periode_selesai
  );
  const totalDebit = totalRow?.total_debit ?? 0;
  const totalKredit = totalRow?.total_kredit ?? 0;
  const trialBalanceSeimbang = totalDebit === totalKredit;

  // RC-S78 — yang memblokir bukan "ada selisih", melainkan "selisih
  // belum ditindaklanjuti" (atau baris SELESAI yang isinya tidak
  // konsisten). Perbedaan waktu yang sudah diperiksa memang membuat
  // saldo buku dan rekening koran berbeda pada tanggal yang sama; ia
  // tidak akan pernah cocok hanya karena rekonsiliasi diulang.
  //
  // RC-S79 — pemeriksaannya kini DIBATASI pada periode yang ditutup.
  // Sebelumnya baris terakhir dari seluruh histori yang dipakai,
  // sehingga pemeriksaan Juli dapat "memenuhi" penutupan Agustus dan
  // periode yang belum pernah diperiksa tetap lolos. Rekening wajib
  // yang tidak punya pemeriksaan dalam periode itu kini memblokir.
  const statusRekon = await getStatusRekonsiliasiPeriode(db, periode.periode_mulai, periode.periode_selesai);
  const belumAda = statusRekon.filter((r) => r.rekonsiliasi === null);
  const belumTuntas = statusRekon.filter(
    (r) => r.rekonsiliasi !== null && rekonsiliasiMenghalangiTutupPeriode(r.rekonsiliasi)
  );
  const rekonsiliasiBermasalah = [...belumAda, ...belumTuntas].map((r) => ({
    accountId: r.accountId,
    namaRekening: r.namaRekening,
    // RC-S80 — NOMINAL selisih yang sebenarnya. Sebelumnya di sini
    // dipakai penanda `1`, sehingga ringkasan penutupan periode
    // melaporkan "selisih Rp1" untuk kekurangan kas berapa pun —
    // angka yang menyesatkan pada layar yang justru dipakai untuk
    // memutuskan apakah periode boleh ditutup.
    selisih: r.rekonsiliasi?.selisih ?? 0,
    tanggal: r.rekonsiliasi?.tanggal ?? periode.periode_selesai,
  }));

  let bolehDitutup = true;
  let alasanTidakBolehDitutup: string | undefined;

  if (periode.status === 'CLOSED') {
    bolehDitutup = false;
    alasanTidakBolehDitutup = 'Periode ini sudah ditutup sebelumnya.';
  } else if (!trialBalanceSeimbang) {
    bolehDitutup = false;
    alasanTidakBolehDitutup = `Trial balance tidak seimbang (debit ${totalDebit} != kredit ${totalKredit}). Ini seharusnya tidak pernah terjadi — hubungi admin sistem.`;
  } else if (rekonsiliasiBermasalah.length > 0) {
    bolehDitutup = false;
    const periodeLabel = `${periode.periode_mulai} s/d ${periode.periode_selesai}`;
    alasanTidakBolehDitutup =
      belumAda.length > 0
        ? `Rekonsiliasi periode ${periodeLabel} belum tersedia untuk rekening ${belumAda.map((r) => r.namaRekening).join(', ')}.`
        : `Rekonsiliasi rekening ${belumTuntas.map((r) => r.namaRekening).join(', ')} untuk periode ${periodeLabel} belum ditindaklanjuti.`;
  }

  return {
    periodeId,
    trialBalanceSeimbang,
    totalDebit,
    totalKredit,
    rekonsiliasiBermasalah: rekonsiliasiBermasalah.map((r) => ({
      accountId: r.accountId,
      namaRekening: r.namaRekening,
      selisih: r.selisih,
      tanggal: r.tanggal,
    })),
    bolehDitutup,
    alasanTidakBolehDitutup,
  };
}

/**
 * Tutup periode — REJECT kalau salah satu syarat di
 * `getRingkasanPenutupanPeriode` tidak terpenuhi (trial balance tidak
 * seimbang, ATAU ada rekonsiliasi kas/bank yang masih SELISIH, ATAU
 * periode sudah CLOSED). Dicek ULANG di sini (bukan cuma percaya hasil
 * `getRingkasanPenutupanPeriode` yang dipanggil UI sebelumnya) supaya
 * aman dari race condition / kondisi berubah di antara dua panggilan.
 *
 * Update pasca-Phase 18/19 (permintaan pengguna §F/§K.14):
 * - §F: kalau mode Penyusutan = OTOMATIS, jalankan penyusutan untuk
 *   SELURUH bulan dalam tahun buku ini yang belum diproses SEBELUM
 *   periode ditutup (dipanggil DI LUAR transaksi close-period sendiri
 *   — expo-sqlite tidak mendukung transaksi bersarang, lihat komentar
 *   `PenyusutanService.jalankanPenyusutanOtomatisUntukTahunBuku`).
 * - §K.14: WAJIB ada data RAT (`RATService.getRATByTahunBuku`) untuk
 *   tahun buku ini sebelum periode bisa ditutup — defense-in-depth,
 *   BUKAN cuma popup konfirmasi di UI (popup di UI murni UX, gerbang
 *   sungguhan ada di sini).
 */
/**
 * ============================================================
 * RC-S51 §1 — PENJAGA EKSEKUSI GANDA PER PERIODE
 * ============================================================
 *
 * SUBTASK 1B. Dua caller yang memanggil `tutupPeriode()` pada periode
 * yang SAMA hampir bersamaan sama-sama lolos validasi (keduanya masih
 * melihat status OPEN), lalu keduanya menjalankan batch penyusutan.
 *
 * Peta ini membuat pemanggilan kedua MENUNGGU hasil yang pertama, bukan
 * memulai batch kedua — pola yang SAMA dengan `batchBerjalan` di
 * `SimpananBerjangkaCatchUpService`, jadi bukan mekanisme baru.
 *
 * Kuncinya `periodeId`, BUKAN global: menutup periode 2025 tidak boleh
 * memblokir apa pun yang menyangkut periode 2026, dan tidak boleh
 * mengunci aplikasi.
 *
 * BATAS YANG JUJUR: penjaga ini IN-PROCESS. Ia menutup jendela race di
 * dalam satu instance aplikasi — yang memang satu-satunya bentuk
 * konkurensi yang mungkin pada aplikasi offline-first ini (satu proses,
 * satu koneksi SQLite). Ia BUKAN lock lintas proses. Jaminan
 * sesungguhnya terhadap penyusutan ganda tetap ada di lapisan bawah:
 * `jalankanPenyusutanPeriode()` melewati aset yang periodenya sudah
 * tercatat di `aset_penyusutan`, dan status CLOSED diperiksa ulang di
 * dalam transaksi penutupan. Penjaga ini optimasi & kerapian, bukan
 * satu-satunya pertahanan.
 */
const penutupanBerjalan = new Map<string, Promise<{ ditutup: boolean }>>();

/**
 * ============================================================
 * PRE-FLIGHT: VALIDASI MURNI, TANPA SATU PUN MUTASI
 * ============================================================
 *
 * STEP 1/STEP 2 RC-S51. Fungsi ini HANYA MEMBACA. Ia tidak membuat
 * jurnal, tidak menyentuh saldo, tidak menjalankan penyusutan, dan
 * tidak memanggil posting apa pun. Seluruh gerbang yang SUDAH ADA
 * dikumpulkan di sini supaya "apa yang divalidasi" berada di satu
 * tempat dan tidak mungkin lagi tercampur dengan "apa yang dimutasi".
 *
 * Aturan validasinya TIDAK BERUBAH sedikit pun dari sebelumnya:
 * permission `pengaturan:edit`, periode harus ada, belum CLOSED, RAT
 * tahun buku harus tercatat, trial balance seimbang, dan tidak ada
 * rekonsiliasi kas/bank yang masih SELISIH. Yang berubah hanya KAPAN
 * semuanya dijalankan.
 */
async function praPenutupan(params: { periodeId: string; createdBy: string }): Promise<{
  tahunBuku: number;
  periodeMulai: string;
  periodeSelesai: string;
}> {
  const db = await getDb();

  // Permission lebih dulu: tidak ada gunanya membocorkan keadaan
  // periode kepada user yang memang tidak berhak menutupnya.
  // `requirePermission` read-only, jadi aman dipanggil di luar
  // transaksi. Ia TETAP dipanggil ulang di dalam transaksi penutupan
  // (defense-in-depth, pola yang sudah dipakai gate lain di app ini).
  await requirePermission(db, params.createdBy, 'pengaturan', 'edit');

  const periode = await db.getFirstAsync<{
    tahun_buku: number;
    periode_mulai: string;
    periode_selesai: string;
    status: string;
  }>(
    `SELECT tahun_buku, periode_mulai, periode_selesai, status FROM accounting_period WHERE id = ?`,
    params.periodeId
  );
  if (!periode) throw new Error('Periode tidak ditemukan.');
  if (periode.status === 'CLOSED') throw new Error('Periode ini sudah ditutup sebelumnya.');

  // §K.14 — gerbang RAT. Dipindah KE SINI (sebelum penyusutan);
  // sebelumnya ia dievaluasi SETELAH batch penyusutan berjalan.
  const rat = await getRATByTahunBuku(periode.tahun_buku);
  if (!rat) {
    throw new Error('Periode belum dapat ditutup karena data pelaksanaan RAT untuk tahun buku ini belum dicatat.');
  }

  // Trial balance & rekonsiliasi kas/bank — memakai `getRingkasan
  // PenutupanPeriode()` yang SUDAH ADA (read-only) apa adanya, bukan
  // salinan aturannya.
  const ringkasan = await getRingkasanPenutupanPeriode(params.periodeId);
  if (!ringkasan.bolehDitutup) {
    throw new Error(ringkasan.alasanTidakBolehDitutup ?? 'Periode belum bisa ditutup.');
  }

  return {
    tahunBuku: periode.tahun_buku,
    periodeMulai: periode.periode_mulai,
    periodeSelesai: periode.periode_selesai,
  };
}

/**
 * Tutup periode.
 *
 * ============================================================
 * RC-S51 §1 — VALIDATE FIRST, MUTATE SECOND, CLOSE LAST
 * ============================================================
 *
 * ROOT CAUSE YANG DITUTUP (temuan audit P0). Urutan sebelumnya adalah:
 *
 *     1. jalankan penyusutan otomatis   <-- MUTASI AKUNTANSI
 *     2. cek RAT
 *     3. buka transaksi -> cek permission
 *     4.                 -> cek trial balance & rekonsiliasi
 *     5.                 -> set CLOSED
 *
 * Artinya SETIAP kegagalan pada langkah 2-4 terjadi SETELAH jurnal
 * penyusutan sudah ter-commit. User tanpa izin `pengaturan:edit`, tahun
 * buku yang RAT-nya belum dicatat, atau rekening yang rekonsiliasinya
 * masih selisih — ketiganya menolak penutupan, tetapi meninggalkan
 * jurnal penyusutan yang tidak diminta siapa pun. Periode tetap OPEN,
 * bukunya sudah berubah.
 *
 * Urutan sekarang:
 *
 *     1. PRE-FLIGHT murni  : permission, periode ada, belum CLOSED,
 *                            RAT, trial balance, rekonsiliasi
 *     2. MUTASI            : penyusutan otomatis (mode OTOMATIS saja),
 *                            lewat PenyusutanService existing
 *     3. VALIDASI FINAL    : trial balance & rekonsiliasi dicek ULANG
 *                            setelah mutasi
 *     4. CLOSE             : set CLOSED di dalam transaksi, dengan
 *                            permission & RAT diperiksa sekali lagi
 *
 * TIDAK ADA COMPENSATING DELETE. Tidak ada satu pun jalur di sini yang
 * menghapus atau membalik jurnal penyusutan yang sudah dibuat —
 * dilarang eksplisit, dan tidak diperlukan justru karena seluruh
 * prasyarat yang dapat diprediksi sudah gagal SEBELUM penyusutan
 * dijalankan.
 *
 * KENAPA PENYUSUTAN TIDAK IKUT KE DALAM SATU TRANSAKSI. expo-sqlite
 * tidak mendukung transaksi bersarang, dan
 * `jalankanPenyusutanOtomatisUntukTahunBuku()` membuka transaksinya
 * sendiri per periode (lihat PenyusutanService). Menyatukannya butuh
 * membongkar service penyusutan — jauh di luar cakupan hardening ini,
 * dan tidak diperlukan: penyusutan yang berhasil pada periode yang
 * kemudian gagal ditutup TETAP BENAR secara akuntansi (ia memang
 * beban periode itu) dan idempoten, sehingga percobaan penutupan
 * berikutnya tidak mengulangnya.
 *
 * Aturan akuntansinya sendiri TIDAK DISENTUH: mode penyusutan, formula
 * garis lurus, periode yang dianggap tertunggak, gerbang RAT, ambang
 * rekonsiliasi, dan definisi trial balance seluruhnya tetap milik
 * service masing-masing.
 */
/**
 * ============================================================
 * RC-S58 — GERBANG AKRUAL BUNGA UTANG SEBELUM TUTUP PERIODE
 * ============================================================
 *
 * Penutupan periode TIDAK menghitung bunga. Ia hanya:
 *   1. menunggu rantai tugas latar (`tungguTugasStartupSelesai`) supaya
 *      tidak ada dua transaksi tumpang-tindih pada koneksi SQLite tunggal;
 *   2. memanggil mesin lewat gerbang single-flight yang SAMA dengan
 *      StartupTasks (`jalankanAkrualBungaUtangJikaPerlu`; RC-S71: tanpa layar) —
 *      tidak ada runner kedua; pemanggil yang bersamaan berbagi satu run;
 *   3. mengevaluasi exception, rekonsiliasi, dan outstanding.
 *
 * Kebijakan existing `tutupPeriode` adalah BLOKIR bila prasyarat gagal
 * (tidak ada mekanisme "tutup dengan catatan"). Karena itu penghalang di
 * bawah menolak penutupan dengan alasan eksplisit, bukan menutup diam-diam.
 */
export interface PenghalangAkrualBunga {
  readonly kode: string;
  readonly utangId: string | null;
  readonly nomorUtang: string | null;
  readonly periode: string | null;
  readonly pesan: string;
}

export interface HasilGerbangAkrualBungaUtang {
  readonly adaUtangBerbunga: boolean;
  readonly penghalang: readonly PenghalangAkrualBunga[];
  readonly statusRekonsiliasi: 'BALANCED' | 'GAP' | 'TIDAK_ADA_DATA';
  readonly outstandingUtangBunga: number;
  readonly jurnalBaru: number;
}

export async function jalankanGerbangAkrualBungaUtang(params: {
  periodeMulai: string;
  periodeSelesai: string;
  createdBy: string;
  /** Hanya untuk test; produksi memakai tanggal lokal hari ini. */
  tanggalSekarang?: string;
}): Promise<HasilGerbangAkrualBungaUtang> {
  const tanggalSekarang = params.tanggalSekarang ?? getTanggalLokalHariIni();
  await tungguTugasStartupSelesai();
  const hasil = await jalankanAkrualBungaUtangJikaPerlu(params.createdBy, tanggalSekarang);

  // Baca utang lewat API read-only existing (`listUtang` + `asOfDate`, yang
  // memfilter tanggal <= akhir periode) — gerbang ini tidak menyentuh
  // database secara langsung.
  const semuaBerbunga = (await listUtang()).filter((u) => u.jenisPemberi !== 'UTANG_USAHA' && u.persenBunga > 0);
  if (semuaBerbunga.length === 0) {
    // Tanpa utang berbunga tidak mungkin ada jurnal UTANG_BUNGA (sumber_id = utang).
    return { adaUtangBerbunga: false, penghalang: [], statusRekonsiliasi: 'TIDAK_ADA_DATA', outstandingUtangBunga: 0, jurnalBaru: hasil.jumlahJurnalBaru };
  }
  const berbunga = (await listUtang({ asOfDate: params.periodeSelesai })).filter(
    (u) => u.jenisPemberi !== 'UTANG_USAHA' && u.persenBunga > 0
  );

  const penghalang: PenghalangAkrualBunga[] = [];
  if (!hasil.dijalankan) {
    penghalang.push({
      kode: 'MESIN_GAGAL',
      utangId: null,
      nomorUtang: null,
      periode: null,
      pesan: 'Proses akrual bunga utang otomatis gagal dijalankan, sehingga kelengkapan akrual periode ini tidak dapat dipastikan.',
    });
  }

  // 'YYYY-MM' dari tanggal ISO — tanpa impor @/accounting (aturan
  // akuntansi tetap milik service masing-masing; dikunci HardeningRcS51).
  const dari = params.periodeMulai.slice(0, 7);
  const sampai = params.periodeSelesai.slice(0, 7);
  const idRelevan = new Set(berbunga.map((u) => u.id));
  for (const e of hasil.exception) {
    // PERIODE_TERTUTUP menyangkut tahun buku lain yang SUDAH ditutup.
    if (e.kode === 'PERIODE_TERTUTUP') continue;
    const relevan = e.periode ? e.periode >= dari && e.periode <= sampai : idRelevan.has(e.utangId);
    // RC-S58.1: reversal yang terjadi SETELAH akhir periode belum ada per
    // akhir periode — akrualnya masih aktif di buku periode ini. Semantik
    // mesin (reversal final) tidak berubah; ini hanya evaluasi penutupan.
    if (relevan && e.kode === 'AKRUAL_DIREVERSAL' && e.periode) {
      const jejak = (await getJejakAkrualBungaUtang(e.utangId)).filter((x) => x.periode === e.periode && x.reversalTanggal);
      if (jejak.length > 0 && jejak.every((x) => (x.reversalTanggal as string) > params.periodeSelesai)) continue;
    }
    if (relevan) {
      penghalang.push({ kode: e.kode, utangId: e.utangId, nomorUtang: e.nomorUtang, periode: e.periode, pesan: e.pesan });
    }
  }

  // Bulan terakhir periode belum berakhir: akrualnya belum boleh dibukukan
  // (RC-S58), jadi periode tidak boleh dikunci lebih dulu.
  if (berbunga.length > 0 && periodeTerakhirSelesai(tanggalSekarang) < sampai) {
    penghalang.push({
      kode: 'PERIODE_BELUM_BERAKHIR',
      utangId: null,
      nomorUtang: null,
      periode: sampai,
      pesan: `Periode ${sampai} belum berakhir, sehingga akrual bunga utangnya belum dapat dibukukan. Tutup periode setelah tanggal ${params.periodeSelesai}.`,
    });
  }

  // RC-S58.1: rekonsiliasi AS-OF akhir periode yang ditutup — bukan kontrol
  // global. GAP yang baru terjadi sesudah `periodeSelesai`, serta pelunasan/
  // reversal sesudahnya, tidak memengaruhi penutupan periode ini. Kontrol
  // global (`getKontrolGapUtangBunga`) TIDAK dipakai di jalur ini.
  //
  // RC-S62 §3: sejak optimisasi, `getKontrolGapUtangBungaAsOf()` tidak lagi
  // memanggil kontrol global di dalamnya. PeriodClose karena itu TIDAK
  // melakukan full scan ledger global — seluruh temuan yang dibutuhkannya
  // (JURNAL_TANPA_SUBLEDGER, DUPLICATE_INTEREST_EXPENSE,
  // SUBLEDGER_TANPA_JURNAL) dihitung langsung secara as-of lewat agregasi
  // borongan. Terukur: 85,5 s -> 0,22 s pada 10.000 jurnal / 100 utang,
  // dengan jumlah query turun dari 41.010 menjadi 18 (konstan).
  //
  // Catatan RC-S61 §3.3 yang dikoreksi di sini: komentar lama menyatakan
  // kontrol global "tetap dipakai diagnostik aplikasi". Audit menunjukkan
  // global TIDAK punya call site produksi mana pun. Ia dipertahankan
  // sebagai API diagnostik/kompatibilitas, bukan sebagai jalur aktif.
  const kontrol = await getKontrolGapUtangBungaAsOf(params.periodeSelesai);
  if (kontrol.status === 'GAP') {
    const utangTerkait = [...new Set(kontrol.temuan.map((t) => t.nomorUtang).filter((x): x is string => !!x))];
    penghalang.push({
      kode: 'REKONSILIASI_UTANG_BUNGA_GAP',
      utangId: null,
      nomorUtang: null,
      periode: sampai,
      pesan: `Per ${params.periodeSelesai}: saldo akun Utang Bunga (${kontrol.actual}) tidak sama dengan outstanding subledger (${kontrol.expected}); selisih ${kontrol.gap}` +
        `${utangTerkait.length > 0 ? ` (utang: ${utangTerkait.join(', ')})` : ''}. Selesaikan lewat diagnostik/koreksi yang sah sebelum menutup periode.`,
    });
  }

  return {
    adaUtangBerbunga: true,
    penghalang,
    statusRekonsiliasi: kontrol.status,
    outstandingUtangBunga: kontrol.expected,
    jurnalBaru: hasil.jumlahJurnalBaru,
  };
}

export async function tutupPeriode(params: { periodeId: string; createdBy: string }): Promise<{ ditutup: boolean }> {
  // SUBTASK 1B — pemanggilan kedua pada periode yang sama menunggu
  // hasil yang pertama, bukan memulai batch penyusutan kedua.
  const berjalan = penutupanBerjalan.get(params.periodeId);
  if (berjalan) return berjalan;

  const eksekusi = (async (): Promise<{ ditutup: boolean }> => {
    // ---------- STEP 1 & 2: PRE-FLIGHT (READ-ONLY) ----------
    const periode = await praPenutupan(params);

    // ---------- STEP 3: MUTASI ----------
    // Baru di sini buku boleh berubah. Memakai service existing;
    // idempotensinya (aset yang periodenya sudah tercatat di
    // `aset_penyusutan` dilewati) TIDAK diduplikasi di sini.
    const mode = await getModePenyusutan();
    if (mode === 'OTOMATIS') {
      await jalankanPenyusutanOtomatisUntukTahunBuku(
        periode.periodeMulai,
        periode.periodeSelesai,
        params.createdBy
      );
    }

    // ---------- STEP 3b: AKRUAL BUNGA UTANG (RC-S58) ----------
    // Di LUAR transaksi penutupan: mesin membuka transaksinya sendiri per
    // periode, dan transaksi bersarang pada koneksi yang sama akan gagal.
    const gerbangBunga = await jalankanGerbangAkrualBungaUtang({
      periodeMulai: periode.periodeMulai,
      periodeSelesai: periode.periodeSelesai,
      createdBy: params.createdBy,
    });
    if (gerbangBunga.penghalang.length > 0) {
      const rinci = gerbangBunga.penghalang
        .map((p) => `${p.nomorUtang ? `${p.nomorUtang}: ` : ''}${p.pesan}`)
        .join(' | ');
      throw new Error(`Periode belum bisa ditutup — akrual bunga utang belum tuntas. ${rinci}`);
    }

    // ---------- STEP 4: VALIDASI FINAL ----------
    // Setelah mutasi, prasyarat dievaluasi ULANG — periode tidak boleh
    // dikunci berdasarkan keadaan sebelum penyusutan. Ini juga yang
    // menangkap kalau batch penyusutan (atau transaksi lain yang masuk
    // bersamaan) sampai membuat trial balance tidak seimbang.
    const ringkasanFinal = await getRingkasanPenutupanPeriode(params.periodeId);
    if (!ringkasanFinal.bolehDitutup) {
      throw new Error(ringkasanFinal.alasanTidakBolehDitutup ?? 'Periode belum bisa ditutup.');
    }

    // ---------- STEP 5: CLOSE ----------
    return withTransaction(async (db) => {
      await requirePermission(db, params.createdBy, 'pengaturan', 'edit');

      // Lapis terakhir, dievaluasi DI DALAM transaksi: status CLOSED,
      // trial balance, dan rekonsiliasi. Ini yang membuat penutupan
      // kedua (SUBTASK 1A) ditolak dengan pesan "Periode ini sudah
      // ditutup sebelumnya." alih-alih menutup dua kali.
      const ringkasan = await getRingkasanPenutupanPeriode(params.periodeId);
      if (!ringkasan.bolehDitutup) {
        throw new Error(ringkasan.alasanTidakBolehDitutup ?? 'Periode belum bisa ditutup.');
      }

      const periodeRow = await db.getFirstAsync<{ tahun_buku: number }>(
        `SELECT tahun_buku FROM accounting_period WHERE id = ?`,
        params.periodeId
      );
      if (periodeRow) {
        const rat = await getRATByTahunBuku(periodeRow.tahun_buku);
        if (!rat) {
          throw new Error('Periode belum dapat ditutup karena data pelaksanaan RAT untuk tahun buku ini belum dicatat.');
        }
      }

      const now = new Date().toISOString();
      await db.runAsync(
        `UPDATE accounting_period SET status = 'CLOSED', closed_at = ?, closed_by = ? WHERE id = ?`,
        now,
        params.createdBy,
        params.periodeId
      );

      return { ditutup: true };
    });
  })();

  penutupanBerjalan.set(params.periodeId, eksekusi);
  try {
    return await eksekusi;
  } finally {
    // Dilepas apa pun hasilnya: penutupan yang gagal (mis. RAT belum
    // dicatat) HARUS bisa dicoba lagi setelah penyebabnya diperbaiki.
    penutupanBerjalan.delete(params.periodeId);
  }
}

/** Daftar semua periode akuntansi — untuk layar Status Periode. */
export async function listPeriodeAkuntansi(): Promise<
  { id: string; tahunBuku: number; periodeMulai: string; periodeSelesai: string; status: 'OPEN' | 'CLOSED'; closedAt: string | null }[]
> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(`SELECT * FROM accounting_period ORDER BY tahun_buku DESC`);
  return rows.map((r) => ({
    id: r.id,
    tahunBuku: r.tahun_buku,
    periodeMulai: r.periode_mulai,
    periodeSelesai: r.periode_selesai,
    status: r.status,
    closedAt: r.closed_at,
  }));
}
