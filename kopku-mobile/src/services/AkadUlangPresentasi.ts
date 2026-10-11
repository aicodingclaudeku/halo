/**
 * RC-S82 — HELPER PENYAJIAN AKAD ULANG (MURNI, READ-ONLY).
 * ============================================================
 *
 * Modul ini TIDAK menyentuh database, jurnal, COA, EIR, maupun
 * lifecycle jadwal. Isinya hanya turunan penyajian dari data yang SUDAH
 * dimuat (`JadwalAngsuranItem[]`, `RiwayatAkadUlangItem[]`), supaya:
 *
 *   1. Layar Detail Pinjaman, dokumen PDF Akad Ulang, dan test memakai
 *      SATU definisi yang sama (tidak ada rumus kedua di layar).
 *   2. Keputusan "jadwal mana yang masih berjalan" SELALU berasal dari
 *      `isCurrentRepaymentSchedule()` (ScheduleLifecycle.ts) — sumber
 *      kebenaran yang juga dipakai `akadUlangPinjaman()`.
 *
 * BUG RC-S82 (yang diperbaiki lewat modul ini):
 * Modal Akad Ulang dulu menghitung "Outstanding Pokok" dan "Jadwal Lama
 * Tersisa" dari daftar status yang DIKETIK ULANG di layar
 * (`BELUM_BAYAR`/`SEBAGIAN`), sehingga jadwal `TERLAMBAT` — yang oleh
 * ScheduleLifecycle dan oleh service dianggap CURRENT — tidak ikut
 * dihitung. Angka di modal bisa lebih kecil daripada sisa pokok yang
 * benar-benar diakadulangkan service.
 */
import { isCurrentRepaymentSchedule, isObsoleteRepaymentSchedule } from '@/accounting/ScheduleLifecycle';
import type { MetodeJasa, SatuanTenor } from '@/accounting/PinjamanCalculator';
import type { Rupiah } from '@/utils/money';

/**
 * Bentuk minimal satu baris jadwal yang dibutuhkan helper ini. Sengaja
 * struktural (bukan import dari PinjamanService) supaya modul ini tidak
 * menarik dependensi database — `JadwalAngsuranItem` memenuhinya.
 */
export interface BarisJadwalPresentasi {
  id: string;
  nomorAngsuran: number;
  tanggalJatuhTempo: string;
  pokok: Rupiah;
  jasa: Rupiah;
  total: Rupiah;
  pokokTerbayar: Rupiah;
  jasaTerbayar: Rupiah;
  status: string;
  dibuatDariAkadUlangId: string | null;
  digantikanOlehAkadUlangId: string | null;
}

// ------------------------------------------------------------------
// LABEL MANUSIAWI
// ------------------------------------------------------------------

const LABEL_SATUAN_TENOR: Record<SatuanTenor, string> = {
  HARI: 'Hari',
  MINGGU: 'Minggu',
  BULAN: 'Bulan',
};

const LABEL_METODE_JASA: Record<MetodeJasa, string> = {
  FLAT: 'Flat',
  MENURUN: 'Menurun',
  EFEKTIF: 'Efektif',
  CUSTOM: 'Custom',
};

/** Label satuan tenor untuk UI/dokumen ("Bulan"), bukan enum mentah ("BULAN"). */
export function labelSatuanTenor(satuan: string | null | undefined): string {
  return LABEL_SATUAN_TENOR[satuan as SatuanTenor] ?? String(satuan ?? '-');
}

/** Label metode jasa untuk UI/dokumen ("Menurun"), bukan enum mentah ("MENURUN"). */
export function labelMetodeJasa(metode: string | null | undefined): string {
  return LABEL_METODE_JASA[metode as MetodeJasa] ?? String(metode ?? '-');
}

/** "12 Bulan". */
export function formatTenor(tenor: number, satuan: string): string {
  return `${tenor} ${labelSatuanTenor(satuan)}`;
}

/**
 * "1,5% per periode". Memakai koma desimal Indonesia. TIDAK membulatkan
 * nilai — hanya mengganti pemisah desimal pada representasi angka apa
 * adanya, sehingga yang tampil identik dengan yang tersimpan.
 */
export function formatPersenJasa(persen: number): string {
  return `${String(persen).replace('.', ',')}% per periode`;
}

const NAMA_BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/**
 * 'YYYY-MM-DD' -> "24 September 2026". Diparse sebagai string (bukan
 * `new Date()`), jadi tidak ada pergeseran zona waktu WIB/WITA/WIT.
 * Nilai yang tidak berformat tanggal dikembalikan apa adanya.
 */
export function formatTanggalPanjang(tanggal: string | null | undefined): string {
  if (!tanggal) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(tanggal);
  if (!m) return tanggal;
  const bulan = NAMA_BULAN[Number(m[2]) - 1];
  if (!bulan) return tanggal;
  return `${Number(m[3])} ${bulan} ${m[1]}`;
}

// ------------------------------------------------------------------
// §A — RINGKASAN POSISI AKAD ULANG (BUG FIX)
// ------------------------------------------------------------------

export interface RingkasanPosisiAkadUlang {
  /**
   * SUM(max(0, pokok - pokokTerbayar)) atas SEMUA jadwal CURRENT
   * (BELUM_BAYAR / SEBAGIAN / TERLAMBAT). Pada kondisi yang diizinkan
   * service (tidak ada pembayaran pada jadwal current) nilai ini identik
   * dengan `sisaPokok` yang dihitung `akadUlangPinjaman()`.
   */
  sisaPokok: Rupiah;
  /** Jumlah SEMUA jadwal CURRENT (termasuk TERLAMBAT). */
  jumlahJadwalCurrent: number;
  /** Jadwal CURRENT yang sudah memiliki pembayaran pokok ATAU jasa. */
  jumlahJadwalCurrentTerbayar: number;
}

export function ringkasPosisiAkadUlang(jadwal: readonly BarisJadwalPresentasi[]): RingkasanPosisiAkadUlang {
  let sisaPokok = 0;
  let jumlahJadwalCurrent = 0;
  let jumlahJadwalCurrentTerbayar = 0;
  for (const j of jadwal) {
    if (!isCurrentRepaymentSchedule(j.status)) continue;
    jumlahJadwalCurrent += 1;
    sisaPokok += Math.max(0, j.pokok - j.pokokTerbayar);
    if (j.pokokTerbayar > 0 || j.jasaTerbayar > 0) jumlahJadwalCurrentTerbayar += 1;
  }
  return { sisaPokok, jumlahJadwalCurrent, jumlahJadwalCurrentTerbayar };
}

// ------------------------------------------------------------------
// §B — PREFLIGHT (UX SAJA — service tetap otoritas terakhir)
// ------------------------------------------------------------------

export type HasilPreflightAkadUlang =
  | { boleh: true; ringkasan: RingkasanPosisiAkadUlang }
  | { boleh: false; ringkasan: RingkasanPosisiAkadUlang; judul: string; pesan: string };

/**
 * Pemeriksaan sebelum modal Akad Ulang dibuka. TIDAK memblokir karena
 * status TERLAMBAT — yang diblokir hanya kondisi yang juga DITOLAK oleh
 * service (`akadUlangPinjaman()`): ada pembayaran pada jadwal current,
 * atau tidak ada jadwal current sama sekali. Validasi service TIDAK
 * dihapus; ini hanya supaya pengguna tidak mengisi formulir panjang
 * yang pasti ditolak.
 */
export function preflightAkadUlang(jadwal: readonly BarisJadwalPresentasi[]): HasilPreflightAkadUlang {
  const ringkasan = ringkasPosisiAkadUlang(jadwal);
  if (ringkasan.jumlahJadwalCurrentTerbayar > 0) {
    return {
      boleh: false,
      ringkasan,
      judul: 'Akad Ulang Tidak Dapat Dilakukan',
      pesan:
        `Terdapat ${ringkasan.jumlahJadwalCurrentTerbayar} jadwal angsuran berjalan yang sudah memiliki pembayaran ` +
        'tercatat (pokok atau jasa). Akad ulang hanya dapat disusun atas jadwal yang belum menerima pembayaran. ' +
        'Selesaikan pembayaran angsuran tersebut atau koreksi pembayarannya terlebih dahulu.',
    };
  }
  if (ringkasan.jumlahJadwalCurrent === 0 || ringkasan.sisaPokok <= 0) {
    return {
      boleh: false,
      ringkasan,
      judul: 'Akad Ulang Tidak Dapat Dilakukan',
      pesan: 'Tidak ada jadwal angsuran berjalan dengan sisa pokok untuk diakadulangkan.',
    };
  }
  return { boleh: true, ringkasan };
}

// ------------------------------------------------------------------
// §E — VALIDASI INPUT KETAT
// ------------------------------------------------------------------

/**
 * Tenor: HANYA digit ("12"). `parseInt('12abc')` lama menerima 12 —
 * sekarang ditolak. Tidak ada batas maksimal baru (tidak ada kebijakan
 * existing yang menetapkannya); hanya harus bilangan bulat aman > 0.
 */
export function parseTenorInput(text: string): number | null {
  const t = (text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Persentase jasa: angka non-negatif dengan SATU pemisah desimal
 * opsional, titik atau koma ("1.5" / "1,5"). `parseFloat('1.5abc')`
 * lama menerima 1.5 dan `parseFloat('1,5')` diam-diam menjadi 1 —
 * keduanya sekarang ditangani eksplisit.
 */
export function parsePersentaseInput(text: string): number | null {
  const t = (text ?? '').trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(t)) return null;
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export interface FormAkadUlangInput {
  tanggal: string;
  tenorText: string;
  satuanTenor: SatuanTenor;
  metodeJasa: MetodeJasa;
  persentaseText: string;
  keterangan: string;
}

/** Nilai TERVALIDASI yang dipakai preview, konfirmasi, DAN dikirim ke `akadUlangPinjaman()`. */
export interface DraftAkadUlang {
  tanggal: string;
  tenor: number;
  satuanTenor: SatuanTenor;
  metodeJasa: MetodeJasa;
  persentaseJasa: number;
  keterangan: string | undefined;
}

export type HasilValidasiAkadUlang = { ok: true; draft: DraftAkadUlang } | { ok: false; error: string };

export function validasiFormAkadUlang(input: FormAkadUlangInput): HasilValidasiAkadUlang {
  if (!input.tanggal || !/^\d{4}-\d{2}-\d{2}$/.test(input.tanggal)) {
    return { ok: false, error: 'Tanggal akad ulang wajib diisi.' };
  }
  const tenor = parseTenorInput(input.tenorText);
  if (tenor === null) {
    return { ok: false, error: 'Tenor baru harus berupa bilangan bulat lebih besar dari 0 (hanya angka).' };
  }
  const persen = parsePersentaseInput(input.persentaseText);
  if (persen === null) {
    return { ok: false, error: 'Persentase jasa harus berupa angka tidak negatif, mis. 1,5.' };
  }
  if (input.metodeJasa === 'CUSTOM') {
    return { ok: false, error: 'Akad ulang tidak mendukung metode jasa Custom.' };
  }
  const keterangan = (input.keterangan ?? '').trim();
  return {
    ok: true,
    draft: {
      tanggal: input.tanggal,
      tenor,
      satuanTenor: input.satuanTenor,
      metodeJasa: input.metodeJasa,
      persentaseJasa: persen,
      keterangan: keterangan || undefined,
    },
  };
}

// ------------------------------------------------------------------
// §G — PERIODE RELATIF (tanpa mengubah nomor_angsuran di database)
// ------------------------------------------------------------------

export interface PeriodeRelatif {
  /** 1-based, relatif terhadap akad ulang yang melahirkan baris ini. */
  periode: number;
  /** Jumlah baris yang lahir dari akad ulang yang sama. */
  jumlah: number;
}

/**
 * Nomor kontraktual RELATIF untuk baris yang lahir dari akad ulang
 * (`dibuatDariAkadUlangId` terisi): baris diurutkan per event menurut
 * `nomorAngsuran` internal, lalu diberi nomor 1..N. Baris akad asli
 * (tanpa `dibuatDariAkadUlangId`) tidak masuk peta — nomor internalnya
 * memang sudah nomor kontraktual.
 */
export function hitungPeriodeRelatifAkadUlang(jadwal: readonly BarisJadwalPresentasi[]): Map<string, PeriodeRelatif> {
  const perEvent = new Map<string, BarisJadwalPresentasi[]>();
  for (const j of jadwal) {
    if (!j.dibuatDariAkadUlangId) continue;
    const daftar = perEvent.get(j.dibuatDariAkadUlangId) ?? [];
    daftar.push(j);
    perEvent.set(j.dibuatDariAkadUlangId, daftar);
  }
  const hasil = new Map<string, PeriodeRelatif>();
  for (const daftar of perEvent.values()) {
    const urut = [...daftar].sort((a, b) => a.nomorAngsuran - b.nomorAngsuran);
    urut.forEach((j, idx) => hasil.set(j.id, { periode: idx + 1, jumlah: urut.length }));
  }
  return hasil;
}

/** Jadwal milik SATU event akad ulang, urut nomor internal. */
export function jadwalMilikAkadUlang(
  jadwal: readonly BarisJadwalPresentasi[],
  akadUlangId: string
): BarisJadwalPresentasi[] {
  return jadwal
    .filter((j) => j.dibuatDariAkadUlangId === akadUlangId)
    .sort((a, b) => a.nomorAngsuran - b.nomorAngsuran);
}

/** Tanggal jatuh tempo TERAKHIR sekumpulan baris (string 'YYYY-MM-DD' aman dibandingkan leksikal). */
export function jatuhTempoAkhir(jadwal: readonly BarisJadwalPresentasi[]): string | null {
  let max: string | null = null;
  for (const j of jadwal) {
    if (max === null || j.tanggalJatuhTempo > max) max = j.tanggalJatuhTempo;
  }
  return max;
}

// ------------------------------------------------------------------
// §F — STATUS EVENT AKAD ULANG
// ------------------------------------------------------------------

/**
 * Status LIFECYCLE kontrak sebuah event akad ulang — BUKAN kolom
 * `pinjaman_akad_ulang.status` (kolom itu hanya status proses
 * penyimpanan event dan selalu 'SELESAI').
 *
 *   BERLAKU     — event punya jadwal CURRENT: inilah akad yang berjalan.
 *   DIGANTIKAN  — jadwalnya sudah digantikan oleh akad ulang berikutnya.
 *   LUNAS       — seluruh jadwalnya sudah lunas (tidak ada yang digantikan).
 *   DIHAPUSBUKU — jadwalnya ikut dihapusbukukan.
 *   TANPA_JADWAL— tidak ditemukan jadwal yang lahir dari event ini
 *                 (data legacy); ditampilkan jujur, tidak ditebak.
 */
export type StatusEventAkadUlang = 'BERLAKU' | 'DIGANTIKAN' | 'LUNAS' | 'DIHAPUSBUKU' | 'TANPA_JADWAL';

export function tentukanStatusEventAkadUlang(
  akadUlangId: string,
  jadwal: readonly BarisJadwalPresentasi[]
): StatusEventAkadUlang {
  return tentukanStatusJadwalKontrak(jadwal.filter((j) => j.dibuatDariAkadUlangId === akadUlangId));
}

/**
 * Status lifecycle SATU kontrak dari baris jadwal miliknya — dipakai
 * akad ulang (baris `dibuat_dari_akad_ulang_id = event`) DAN akad awal
 * (baris `dibuat_dari_akad_ulang_id IS NULL`). Satu aturan, dua dokumen.
 */
export function tentukanStatusJadwalKontrak(milik: readonly BarisJadwalPresentasi[]): StatusEventAkadUlang {
  if (milik.length === 0) return 'TANPA_JADWAL';
  if (milik.some((j) => isCurrentRepaymentSchedule(j.status))) return 'BERLAKU';
  if (milik.some((j) => j.digantikanOlehAkadUlangId)) return 'DIGANTIKAN';
  if (milik.some((j) => j.status === 'DIHAPUSBUKU')) return 'DIHAPUSBUKU';
  if (milik.every((j) => !isObsoleteRepaymentSchedule(j.status))) return 'LUNAS';
  return 'DIGANTIKAN';
}

/** Jadwal AKAD AWAL: baris yang TIDAK lahir dari akad ulang, urut nomor internal (= nomor kontraktual). */
export function jadwalMilikAkadAwal(jadwal: readonly BarisJadwalPresentasi[]): BarisJadwalPresentasi[] {
  return jadwal.filter((j) => !j.dibuatDariAkadUlangId).sort((a, b) => a.nomorAngsuran - b.nomorAngsuran);
}

export function labelStatusEventAkadUlang(status: StatusEventAkadUlang): string {
  switch (status) {
    case 'BERLAKU':
      return 'BERLAKU';
    case 'DIGANTIKAN':
      return 'HISTORIS — DIGANTIKAN';
    case 'LUNAS':
      return 'HISTORIS — LUNAS';
    case 'DIHAPUSBUKU':
      return 'HISTORIS — DIHAPUSBUKU';
    default:
      return 'HISTORIS';
  }
}

// ------------------------------------------------------------------
// §J — URUTAN EVENT & NOMOR DOKUMEN DETERMINISTIK
// ------------------------------------------------------------------

export interface EventAkadUlangUrut {
  id: string;
  tanggal: string;
  createdAt: string;
}

/**
 * Urutan kronologis event dalam riwayat pinjaman: saat event DISIMPAN
 * (`created_at`), lalu tanggal akad (`tanggal`) bila `created_at`
 * kebetulan identik (resolusi milidetik), lalu `id` sebagai penentu
 * terakhir yang deterministik. Event tidak pernah dihapus, jadi urutan
 * event historis stabil selamanya.
 */
function bandingkan(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function urutkanEventAkadUlang<T extends EventAkadUlangUrut>(riwayat: readonly T[]): T[] {
  return [...riwayat].sort(
    (a, b) => bandingkan(a.createdAt, b.createdAt) || bandingkan(a.tanggal, b.tanggal) || bandingkan(a.id, b.id)
  );
}

export function nomorUrutEventAkadUlang(riwayat: readonly EventAkadUlangUrut[]): Map<string, number> {
  const hasil = new Map<string, number>();
  urutkanEventAkadUlang(riwayat).forEach((r, idx) => hasil.set(r.id, idx + 1));
  return hasil;
}

/**
 * Nomor dokumen akad ulang: `AU/<nomor pinjaman>/<YYYYMMDD>/<NNN>`.
 * Deterministik dari data yang tidak pernah berubah (nomor pinjaman,
 * tanggal event, urutan event) — tidak butuh kolom database baru.
 */
export function buatNomorDokumenAkadUlang(nomorPinjaman: string, tanggalAkadUlang: string, urutan: number): string {
  const tgl = (tanggalAkadUlang ?? '').slice(0, 10).replace(/-/g, '');
  return `AU/${nomorPinjaman}/${tgl}/${String(urutan).padStart(3, '0')}`;
}

// ------------------------------------------------------------------
// AKAD AWAL — label & nomor dokumen
// ------------------------------------------------------------------

/** Nomor dokumen akad awal: `AK/<nomor pinjaman>/<YYYYMMDD>` — deterministik, tanpa kolom DB baru. */
export function buatNomorDokumenAkadAwal(nomorPinjaman: string, tanggalAkad: string): string {
  return `AK/${nomorPinjaman}/${(tanggalAkad ?? '').slice(0, 10).replace(/-/g, '')}`;
}

const LABEL_TUJUAN: Record<string, string> = {
  MODAL_KERJA: 'Modal Kerja',
  INVESTASI: 'Investasi',
  KONSUMTIF: 'Konsumtif',
  LAINNYA: 'Lainnya',
};

export function labelTujuanPinjaman(tujuan: string | null | undefined, detail?: string | null): string {
  const dasar = tujuan ? LABEL_TUJUAN[tujuan] ?? tujuan : '-';
  const d = (detail ?? '').trim();
  return d ? `${dasar} — ${d}` : dasar;
}

/**
 * Biaya administrasi SEPERTI TERSIMPAN — tidak dihitung ulang di sini
 * (nominal hasil persentase ditentukan service saat pencairan).
 * `biaya_admin_nilai` PERSENTASE disimpan sebagai persen dari jumlah pinjaman.
 */
export function labelBiayaAdmin(tipe: string | null | undefined, nilai: number, formatRp: (n: number) => string): string {
  if (tipe === 'NOMINAL') return formatRp(nilai);
  if (tipe === 'PERSENTASE') return `${String(nilai).replace('.', ',')}% dari jumlah pinjaman`;
  return 'Tidak ada';
}

const LABEL_STATUS_PINJAMAN: Record<string, string> = {
  DIAJUKAN: 'Diajukan',
  DISETUJUI: 'Disetujui',
  AKTIF: 'Aktif',
  LUNAS: 'Lunas',
  MACET: 'Macet',
  DITOLAK: 'Ditolak',
};

export function labelStatusPinjaman(status: string | null | undefined): string {
  return LABEL_STATUS_PINJAMAN[status ?? ''] ?? String(status ?? '-');
}

/**
 * Sifat dokumen akad awal.
 *  - BELUM_DICAIRKAN: pinjaman DIAJUKAN/DISETUJUI. Perjanjian dicetak UTUH
 *    (tanpa tanda DRAF) karena justru dokumen inilah yang ditandatangani
 *    anggota & Ketua SEBELUM dana dicairkan.
 *  - FINAL: sudah dicairkan (AKTIF/LUNAS/MACET).
 *  - TIDAK_TERSEDIA: DITOLAK tidak memiliki dokumen akad.
 */
export type SifatDokumenAkadAwal = 'FINAL' | 'BELUM_DICAIRKAN' | 'TIDAK_TERSEDIA';
export function statusDokumenAkadAwal(statusPinjaman: string): SifatDokumenAkadAwal {
  if (statusPinjaman === 'DITOLAK') return 'TIDAK_TERSEDIA';
  if (statusPinjaman === 'DIAJUKAN' || statusPinjaman === 'DISETUJUI') return 'BELUM_DICAIRKAN';
  return 'FINAL';
}
