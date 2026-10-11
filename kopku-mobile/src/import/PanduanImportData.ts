import type { RingkasanParse, BarisPinjaman } from '@/import/ExcelDataAwalParser';
import { hitungJadwalAngsuran } from '@/accounting/PinjamanCalculator';
import { JUDUL_SHEET, JUDUL_SHEET_SALDO_AWAL_AKUN, pilihRekeningBankImport, type RekeningBankAktif } from '@/import/ExcelDataAwalParser';
import { KODE_CONTOH, SHEET_TEMPLATE, type JenisTemplateDataAwal } from '@/import/TemplateDataAwal';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';
import {
  bandingkanSidik,
  hitungSidikBerkas,
  normalkanNamaSidik,
  type SidikTercatat,
} from '@/import/SidikImport';

/**
 * RC-S133.4.7 — PANDUAN PENGISIAN TEMPLATE IMPORT (MODUL MURNI).
 *
 * Berisi dua hal, keduanya TANPA database dan tanpa React:
 *
 *   1. ISI SLIDE PANDUAN berbentuk data (`PANDUAN_IMPORT[jenis]`). Layar
 *      `PanduanImportSlide` hanya menggambarnya. Kolom yang ditampilkan
 *      pada ilustrasi Excel memakai LABEL KOLOM TEMPLATE yang sama
 *      (`SHEET_TEMPLATE`) — dijaga test supaya panduan tidak bisa
 *      menyebut kolom yang tidak ada di berkas.
 *
 *   2. PEMERIKSAAN SEBELUM IMPORT (`periksaSebelumImport`) atas hasil
 *      pratinjau yang SUDAH dibaca parser. Pemeriksaan ini tidak mengubah
 *      cara data dibaca maupun dibukukan; ia hanya menandai kesalahan
 *      pengisian yang paling sering terjadi dan TIDAK tertangkap parser
 *      karena barisnya sah secara bentuk:
 *        - baris CONTOH yang lupa dihapus (lolos parser — dan memang
 *          diuji harus lolos — sehingga tanpa pemeriksaan ini akan
 *          terimpor sebagai anggota "(hapus baris ini)" lengkap dengan
 *          simpanan & pinjamannya);
 *        - berkas Saldo Lama yang diimpor dengan pilihan "Transaksi baru"
 *          (sheet 6/7 pasti gagal, kolom migrasi pinjaman diabaikan);
 *        - baris bertanggal pada/setelah cut-off pada pilihan "Saldo
 *          lama" (diproses sebagai transaksi kas, bukan saldo awal);
 *        - beberapa baris saldo simpanan untuk satu anggota (dijumlahkan);
 *        - total sheet 6 berbeda dari saldo Pendapatan Jasa Pinjaman di
 *          sheet 7.
 *      Tingkat BLOKIR menahan tombol Import di layar; tingkat lain hanya
 *      memberi tahu.
 */

// ===========================================================================
// UTILITAS KECIL (murni)
// ===========================================================================

/** "1234567" -> "1.234.567" (tanpa Intl, aman di Hermes & web). */
export function ribuan(n: number): string {
  const neg = n < 0;
  const s = String(Math.round(Math.abs(n)));
  const t = s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return neg ? `-${t}` : t;
}

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** '2026-07-01' -> '1 Juli 2026'. Masukan tidak sah dikembalikan apa adanya. */
export function tanggalPanjang(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${BULAN[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Hari sebelum tanggal ISO ('2026-07-01' -> '2026-06-30'), memakai UTC supaya tidak bergeser zona waktu. */
export function hariSebelumIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Kode akun bawaan dari NAMA akunnya — supaya panduan tidak mengetik ulang kode akun. */
export function kodeAkunBawaan(nama: string): string {
  const a = DEFAULT_ACCOUNTS.find((x) => x.nama === nama);
  return a ? a.kode : '?';
}

/** Label kolom template yang wajib (dari metadata template, bukan diketik ulang). */
function wajib(sheetNama: string, label: string): boolean {
  const sh = SHEET_TEMPLATE.find((s) => s.nama === sheetNama);
  return !!sh?.kolom.find((k) => k.label === label)?.wajib;
}

// ===========================================================================
// 1. ISI SLIDE
// ===========================================================================

export type NadaPoin = 'BENAR' | 'SALAH' | 'INFO';
export interface PoinPanduan {
  nada: NadaPoin;
  teks: string;
}

/** Ilustrasi yang digambar komponen slide. */
export type IlustrasiImport =
  | { jenis: 'ALUR'; tahap: { ikon: string; label: string }[] }
  | { jenis: 'CUTOFF'; tanggalCutOff: string }
  | { jenis: 'DOKUMEN'; daftar: string[] }
  | { jenis: 'PILIH' }
  | {
      jenis: 'SHEET';
      /** Nama tab di bawah lembar (semua tab template) dan tab yang aktif. */
      tab: string[];
      tabAktif: string;
      /** Label kolom PERSIS seperti di template (tanpa tanda *). */
      kolom: string[];
      baris: string[][];
      /** Indeks kolom yang disorot & diketik bergantian oleh animasi. */
      sorot: number[];
      /** Gelembung keterangan untuk tiap kolom sorot (urutan sama dengan `sorot`). */
      keterangan: string[];
    }
  | { jenis: 'NERACA'; debit: BarisNeraca[]; kredit: BarisNeraca[] }
  | { jenis: 'FORMAT'; baris: { contoh: string; sah: boolean; catatan: string }[] }
  | { jenis: 'HAPUS_CONTOH'; kolom: string[]; contoh: string[]; data: string[][] }
  | { jenis: 'PERIKSA' }
  | { jenis: 'SELESAI' };

export interface BarisNeraca {
  akun: string;
  nilai: number;
  /** OTOMATIS = terisi dari sheet 1–6; SHEET7 = diketik di sheet 7. */
  asal: 'OTOMATIS' | 'SHEET7';
}

export interface SlidePanduanImport {
  kunci: string;
  /** Label kecil di atas judul, mis. "Sheet 3". */
  label: string;
  judul: string;
  isi: string;
  ilustrasi: IlustrasiImport;
  poin?: PoinPanduan[];
  /** Kotak tips di bawah — satu kalimat penting. */
  tips?: string;
}

const B = (teks: string): PoinPanduan => ({ nada: 'BENAR', teks });
const S = (teks: string): PoinPanduan => ({ nada: 'SALAH', teks });
const I = (teks: string): PoinPanduan => ({ nada: 'INFO', teks });

const TAB_SALDO_LAMA = [
  'Petunjuk',
  JUDUL_SHEET.ANGGOTA,
  JUDUL_SHEET.SIMPANAN,
  JUDUL_SHEET.PINJAMAN,
  JUDUL_SHEET.BERJANGKA,
  JUDUL_SHEET.ASET,
  JUDUL_SHEET.JASA,
  JUDUL_SHEET_SALDO_AWAL_AKUN,
  'Daftar Akun',
];
const TAB_TRANSAKSI_BARU = ['Petunjuk', JUDUL_SHEET.ANGGOTA, JUDUL_SHEET.SIMPANAN, JUDUL_SHEET.PINJAMAN, JUDUL_SHEET.BERJANGKA];

/**
 * CONTOH KASUS yang dipakai SELURUH slide Saldo Lama (satu koperasi kecil,
 * cut-off 1 Juli 2026), supaya angka antar-slide saling cocok dan neraca
 * di slide pemeriksaan benar-benar seimbang:
 *
 *   Simpanan  : pokok 2 x 100.000 = 200.000; wajib 1.500.000 + 750.000 =
 *               2.250.000; sukarela 2.000.000.
 *   Pinjaman  : A001 12.000.000 / 12 bln FLAT 1%, 5 kali bayar -> sisa
 *               7.000.000. A002 6.000.000 / 10 bln MENURUN 1,5%, 2 kali
 *               bayar -> sisa 4.800.000 (jatuh tempo 3, jadi 1 menunggak).
 *               Piutang = 11.800.000.
 *   Jasa      : A001 12.000.000 x 1% x 5 = 600.000; A002 90.000 + 81.000 =
 *               171.000. Total 771.000 = Pendapatan Jasa Pinjaman.
 *   Berjangka : 5.000.000 ditempatkan 15/06/2026 (belum ada periode bunga
 *               yang berakhir sebelum cut-off).
 *   Neraca    : debit Kas 8.071.000 + Piutang 11.800.000 + Beban
 *               Operasional 350.000 = 20.221.000 = kredit simpanan
 *               (200.000 + 2.250.000 + 2.000.000 + 5.000.000) + Pendapatan
 *               Jasa 771.000 + Cadangan Umum 10.000.000.
 */
export const CONTOH_KASUS = {
  tanggalCutOff: '2026-07-01',
  piutang: 7000000 + 4800000,
  jasa: 600000 + 171000,
  kas: 8071000,
} as const;

const NERACA_CONTOH: { debit: BarisNeraca[]; kredit: BarisNeraca[] } = {
  debit: [
    { akun: `${kodeAkunBawaan('Kas')} Kas`, nilai: CONTOH_KASUS.kas, asal: 'SHEET7' },
    { akun: `${kodeAkunBawaan('Piutang Pinjaman Anggota')} Piutang Pinjaman`, nilai: CONTOH_KASUS.piutang, asal: 'OTOMATIS' },
    { akun: `${kodeAkunBawaan('Beban Operasional')} Beban Operasional`, nilai: 350000, asal: 'SHEET7' },
  ],
  kredit: [
    { akun: `${kodeAkunBawaan('Simpanan Pokok')} Simpanan Pokok`, nilai: 200000, asal: 'OTOMATIS' },
    { akun: `${kodeAkunBawaan('Simpanan Wajib')} Simpanan Wajib`, nilai: 2250000, asal: 'OTOMATIS' },
    { akun: `${kodeAkunBawaan('Simpanan Sukarela Anggota')} Simpanan Sukarela`, nilai: 2000000, asal: 'OTOMATIS' },
    { akun: `${kodeAkunBawaan('Simpanan Anggota (Berjangka)')} Simpanan Berjangka`, nilai: 5000000, asal: 'OTOMATIS' },
    { akun: `${kodeAkunBawaan('Pendapatan Jasa Pinjaman')} Pendapatan Jasa Pinjaman`, nilai: CONTOH_KASUS.jasa, asal: 'SHEET7' },
    { akun: `${kodeAkunBawaan('Cadangan Umum')} Cadangan Umum`, nilai: 10000000, asal: 'SHEET7' },
  ],
};

const SLIDE_FORMAT: SlidePanduanImport = {
  kunci: 'format',
  label: 'Aturan penulisan',
  judul: 'Tulis tanggal & angka dengan bentuk yang dikenali',
  isi:
    'Aplikasi membaca isi sel, bukan tampilannya. Bentuk di bawah ini aman. Yang bertanda silang akan ditolak saat pemeriksaan — atau lebih buruk, terbaca keliru.',
  ilustrasi: {
    jenis: 'FORMAT',
    baris: [
      { contoh: '2026-06-30', sah: true, catatan: 'Paling aman (tahun-bulan-tanggal)' },
      { contoh: '30/06/2026', sah: true, catatan: 'Tanggal/bulan/tahun' },
      { contoh: '30 Juni 2026', sah: false, catatan: 'Nama bulan diketik sebagai teks' },
      { contoh: '31/06/2026', sah: false, catatan: 'Tanggal yang tidak ada' },
      { contoh: '1500000 · 1.500.000 · Rp 1.500.000', sah: true, catatan: 'Nominal' },
      { contoh: '=B4*2   ·   1,5 juta', sah: false, catatan: 'Rumus atau kata' },
    ],
  },
  poin: [
    B('Kolom bertanda * wajib diisi. Pilihan ditulis persis: KAS/BANK, L/P, FLAT/MENURUN/EFEKTIF.'),
    B('Urutan kolom boleh diubah; aplikasi mencari kolom berdasarkan namanya.'),
    S('Jangan mengganti nama sheet atau menghapus baris judul kolom (baris hijau).'),
    S('Jangan menggabungkan sel (merge) di area data.'),
  ],
  tips:
    'Setelah mengetik 01/02/2026, lihat lagi tampilannya di Excel. Bila Excel Anda berformat Amerika, tanggal itu bisa terbaca 2 Januari. Menulis 2026-02-01 menghindari salah baca ini.',
};

const SLIDE_HAPUS_CONTOH = (kolom: string[], data: string[][]): SlidePanduanImport => ({
  kunci: 'hapus-contoh',
  label: 'Sebelum menyimpan',
  judul: 'Hapus baris contoh berwarna kuning',
  isi:
    `Setiap sheet berisi satu baris contoh berlatar kuning bertanda "${KODE_CONTOH}". Hapus barisnya (klik kanan nomor baris › Delete). ` +
    'Cukup mengosongkan isinya juga boleh. Setelah itu simpan berkas dalam format Excel (.xlsx).',
  ilustrasi: {
    jenis: 'HAPUS_CONTOH',
    kolom,
    contoh: [KODE_CONTOH, '(hapus baris ini)', '01/01/2026'],
    data,
  },
  poin: [
    I('Bila baris contoh masih ada, tombol Import tidak bisa ditekan. Aplikasi menunjukkan sheet dan nomor barisnya.'),
    B('Simpan sebagai "Excel Workbook (.xlsx)". Format .csv hanya menyimpan satu sheet.'),
  ],
});

const SLIDE_ANGGOTA = (tab: string[]): SlidePanduanImport => ({
  kunci: 'anggota',
  label: 'Sheet 1',
  judul: 'Anggota — isi paling awal',
  isi:
    'Satu baris untuk satu anggota. "Kode Anggota" Anda tentukan sendiri, misalnya nomor anggota lama. Kode ini menjadi penghubung ke sheet lain. Nomor anggota resmi di aplikasi dibuat otomatis.',
  ilustrasi: {
    jenis: 'SHEET',
    tab,
    tabAktif: JUDUL_SHEET.ANGGOTA,
    kolom: ['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung', 'Jenis Kelamin'],
    baris: [
      ['A001', 'Siti Aminah', '05/01/2024', 'P'],
      ['A002', 'Budi Santoso', '10/03/2025', 'L'],
    ],
    sorot: [0, 2],
    keterangan: ['Unik — tidak boleh dipakai dua anggota', 'Tanggal masuk menjadi anggota'],
  },
  poin: [
    B('Tulis kode yang sama persis di sheet 2–6, misalnya A001 di semua sheet.'),
    S('"A001" di sheet 1 tetapi "A-001" di sheet 2. Baris sheet 2 itu ditolak.'),
    I('NIK boleh kosong. Bila diisi, harus 16 digit angka. Jenis Kelamin diisi L atau P.'),
  ],
});

const SALDO_LAMA: SlidePanduanImport[] = [
  {
    kunci: 'mulai',
    label: 'Panduan Template Saldo Lama',
    judul: 'Pindahkan pembukuan lama ke KOPKU dalam 4 langkah',
    isi:
      'Template ini untuk koperasi yang SUDAH berjalan. Yang dimasukkan adalah posisi saldo pada satu tanggal, bukan riwayat transaksinya. Kas koperasi tidak bertambah atau berkurang karena import.',
    ilustrasi: {
      jenis: 'ALUR',
      tahap: [
        { ikon: 'calendar-outline', label: 'Tentukan cut-off' },
        { ikon: 'create-outline', label: 'Isi sheet 1–7' },
        { ikon: 'shield-checkmark-outline', label: 'Periksa' },
        { ikon: 'cloud-upload-outline', label: 'Import' },
      ],
    },
    poin: [
      I('Contoh pada panduan ini memakai satu koperasi kecil dengan cut-off 1 Juli 2026. Angka antar-slide saling cocok.'),
      I('Geser, atau tekan Lanjut, untuk pindah slide.'),
    ],
  },
  {
    kunci: 'cutoff',
    label: 'Langkah 1',
    judul: 'Tentukan tanggal cut-off',
    isi:
      'Cut-off adalah hari pertama pembukuan dilakukan di KOPKU. Semua angka di berkas adalah posisi pada AKHIR HARI SEBELUMNYA. Contoh: cut-off 1 Juli 2026, maka saldo yang diisi adalah saldo per 30 Juni 2026.',
    ilustrasi: { jenis: 'CUTOFF', tanggalCutOff: CONTOH_KASUS.tanggalCutOff },
    poin: [
      B('Semua tanggal di berkas harus SEBELUM cut-off: tanggal saldo, pencairan, penempatan, perolehan.'),
      S('Mencampur saldo per 30 Juni dan per 31 Juli dalam satu berkas.'),
      I('Baris bertanggal pada/setelah cut-off diproses sebagai transaksi baru: kas ikut bergerak. Layar pemeriksaan akan memperingatkannya.'),
    ],
    tips: 'Bawaan aplikasi: cut-off = hari ini. Bila cut-off koperasi Anda berbeda, ubah tanggalnya di layar Import sebelum memilih berkas.',
  },
  {
    kunci: 'siapkan',
    label: 'Langkah 1',
    judul: 'Siapkan bahan dari pembukuan lama',
    isi: 'Kumpulkan dokumen berikut, semuanya per tanggal yang sama (sehari sebelum cut-off).',
    ilustrasi: {
      jenis: 'DOKUMEN',
      daftar: [
        'Daftar anggota & tanggal masuk',
        'Saldo simpanan pokok, wajib, sukarela per anggota',
        'Kartu pinjaman: pokok awal, tenor, kali bayar',
        'Daftar simpanan berjangka yang masih berjalan',
        'Daftar aset tetap & harga perolehan',
        'Jasa pinjaman yang dibayar tiap anggota tahun ini',
        'Neraca saldo per tanggal cut-off',
      ],
    },
    poin: [
      B('Pastikan neraca saldo lama sudah seimbang (total debit = total kredit) sebelum mulai mengisi.'),
      I('Bila ada simpanan berjangka, atur dulu Kebijakan Produk Simpanan Berjangka di aplikasi. Tanpa kebijakan aktif, baris berjangka gagal diimpor.'),
    ],
  },
  SLIDE_ANGGOTA(TAB_SALDO_LAMA),
  {
    kunci: 'simpanan',
    label: 'Sheet 2',
    judul: 'Simpanan — satu baris SALDO per anggota',
    isi:
      'Tulis saldo akhir simpanan tiap anggota per tanggal sebelum cut-off. Yang ditulis adalah saldonya, bukan daftar setoran. Ketiga kolom simpanan wajib diisi; tulis 0 bila tidak ada.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_SALDO_LAMA,
      tabAktif: JUDUL_SHEET.SIMPANAN,
      kolom: ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
      baris: [
        ['A001', '30/06/2026', '100.000', '1.500.000', '2.000.000'],
        ['A002', '30/06/2026', '100.000', '750.000', '0'],
      ],
      sorot: [1, 4],
      keterangan: ['Tanggal saldo — sebelum cut-off', 'Tulis 0, jangan dikosongkan'],
    },
    poin: [
      S('Menulis setoran bulanan satu per satu. Pada Saldo Lama, baris-baris itu dijumlahkan sehingga mudah tercatat ganda.'),
      I('Bunga simpanan berjangka yang sudah dikreditkan sebelum cut-off sudah termasuk di saldo Sukarela.'),
      I('Kas tidak bertambah karena baris ini. Uangnya sudah lama diterima dan sudah ada di saldo Kas sheet 7.'),
    ],
  },
  {
    kunci: 'pinjaman',
    label: 'Sheet 3',
    judul: 'Pinjaman yang masih berjalan',
    isi:
      'Tulis data akad aslinya: tanggal pencairan, pokok awal, tenor, dan berapa kali angsuran sudah dibayar. Sisa pokok, jadwal, dan tunggakan dihitung aplikasi.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_SALDO_LAMA,
      tabAktif: JUDUL_SHEET.PINJAMAN,
      kolom: ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Metode Jasa', 'Jasa Persen', 'Angsuran Sudah Dibayar'],
      baris: [
        ['A001', '10/01/2026', '12.000.000', '12', 'FLAT', '1', '5'],
        ['A002', '15/03/2026', '6.000.000', '10', 'MENURUN', '1,5', '2'],
      ],
      sorot: [2, 6],
      keterangan: ['Pokok saat dicairkan, BUKAN sisanya', 'Jumlah kali bayar, bukan rupiah'],
    },
    poin: [
      B('A001: 12.000.000, 12 kali, sudah bayar 5 → sisa pokok 7.000.000 dihitung otomatis.'),
      B('A002: jatuh tempo 15/4, 15/5, 15/6, baru dibayar 2 → 1 angsuran tercatat menunggak.'),
      S('Mengisi Jumlah Pinjaman dengan sisa pinjaman. Akibatnya sisa pokok terhitung jauh lebih kecil.'),
      I('Tenor = jumlah angsuran. Satuan Tenor kosong berarti BULAN. Jasa Persen = per periode angsuran.'),
      S('Menulis jasa per TAHUN (mis. 18) di Jasa Persen tanpa Satuan Jasa = TAHUN. Jasa terbaca 18% SEBULAN dan piutang membengkak.'),
    ],
  },
  {
    kunci: 'pinjaman-lanjutan',
    label: 'Sheet 3 — kolom tambahan',
    judul: 'Kolom Sisa Pokok dkk. boleh dikosongkan',
    isi:
      'Lima kolom di ujung kanan (Nomor Pinjaman Lama, Sisa Pokok, Angsuran Tersisa, Tunggakan Pokok, Piutang Jasa) bersifat opsional. Kosongkan bila angkanya sama dengan hitungan aplikasi.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_SALDO_LAMA,
      tabAktif: JUDUL_SHEET.PINJAMAN,
      kolom: ['Kode Anggota', 'Nomor Pinjaman Lama', 'Sisa Pokok', 'Angsuran Tersisa', 'Tunggakan Pokok'],
      baris: [
        ['A001', 'PJ-2026-014', '', '', ''],
        ['A003', 'PJ-2025-090', '2.500.000', '5', '500.000'],
      ],
      sorot: [2, 3],
      keterangan: ['Isi hanya bila beda dengan hitungan', 'Wajib diisi bersama Sisa Pokok'],
    },
    poin: [
      B('Isi Sisa Pokok bila pembukuan lama berbeda, misalnya pernah ada pelunasan sebagian. Angsuran Tersisa wajib ikut diisi.'),
      B('Nomor Pinjaman Lama dianjurkan diisi supaya pinjaman mudah dicocokkan. Bila kosong, nomor dibuat otomatis (SA-…).'),
      I('Tunggakan Pokok hanya dipakai bila Sisa Pokok diisi berbeda dari jadwal akad. Bila cocok, tunggakan dihitung dari jadwal.'),
      S('Tunggakan Pokok lebih besar dari Sisa Pokok.'),
      S('Memasukkan pinjaman yang sudah lunas sebelum cut-off. Barisnya dilewati; jasanya cukup ditulis di sheet 6.'),
      I('Piutang Jasa diisi HANYA bila pembukuan lama mencatat jasa secara akrual (jasa sudah diakui tetapi belum dibayar).'),
    ],
  },
  {
    kunci: 'berjangka',
    label: 'Sheet 4',
    judul: 'Simpanan berjangka yang masih berjalan',
    isi: 'Satu baris untuk satu kontrak. Tulis tanggal penempatan asli, nominal, tenor, dan bunga per tahun.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_SALDO_LAMA,
      tabAktif: JUDUL_SHEET.BERJANGKA,
      kolom: ['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan', 'Bunga Persen Per Tahun'],
      baris: [['A001', '15/06/2026', '5.000.000', '12', '6']],
      sorot: [3, 4],
      keterangan: ['Hanya 3, 6, atau 12', 'Per TAHUN; kosong = tanpa bunga'],
    },
    poin: [
      S('Kontrak yang sudah jatuh tempo sebelum cut-off. Kontrak seperti ini ditolak; catat saldonya sesuai keadaan (mis. sudah pindah ke Sukarela di sheet 2).'),
      I('Bunga periode sebelum cut-off dianggap sudah masuk saldo Sukarela di sheet 2, jadi tidak dihitung dua kali.'),
      I('Kas tidak bertambah. Saldo awal akun Simpanan Berjangka terisi otomatis.'),
    ],
  },
  {
    kunci: 'aset',
    label: 'Sheet 5',
    judul: 'Aset tetap yang masih dipakai',
    isi:
      'Tulis harga perolehan awal dan tanggal perolehan aslinya. Akumulasi penyusutan sampai cut-off dihitung aplikasi dari kolom-kolom ini.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_SALDO_LAMA,
      tabAktif: JUDUL_SHEET.ASET,
      kolom: ['Nomor Aset', 'Nama Aset', 'Tanggal Perolehan', 'Nilai Perolehan', 'Masa Manfaat Bulan'],
      baris: [['AST-001', 'Laptop Kantor', '02/01/2025', '8.000.000', '48']],
      sorot: [3, 4],
      keterangan: ['Harga beli awal, bukan nilai buku', '4 tahun = 48 bulan'],
    },
    poin: [
      S('Mengisi Nilai Perolehan dengan nilai buku sekarang. Penyusutan jadi terhitung dua kali.'),
      B('Nomor Aset unik per aset, dari pembukuan lama. Nomor yang sama di dua baris ditolak.'),
      I('Nilai Residu kosong dianggap 0 dan harus lebih kecil dari Nilai Perolehan.'),
    ],
  },
  {
    kunci: 'jasa',
    label: 'Sheet 6',
    judul: 'Jasa pinjaman yang SUDAH DIBAYAR tahun ini',
    isi:
      'Per anggota: total jasa pinjaman yang dibayar sejak awal tahun buku sampai sebelum cut-off, termasuk dari pinjaman yang sudah lunas. Dipakai untuk pembagian SHU jasa usaha; tidak dijurnal.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_SALDO_LAMA,
      tabAktif: JUDUL_SHEET.JASA,
      kolom: ['Kode Anggota', 'Nama Anggota', 'Jasa Pinjaman Dibayar'],
      baris: [
        ['A001', 'Siti Aminah', '600.000'],
        ['A002', 'Budi Santoso', '171.000'],
      ],
      sorot: [2],
      keterangan: ['Total rupiah jasa per anggota'],
    },
    poin: [
      B('A001: 12.000.000 × 1% × 5 kali = 600.000.'),
      B('A002 (menurun): 6.000.000 × 1,5% + 5.400.000 × 1,5% = 171.000.'),
      B(`Total sheet 6 (${ribuan(CONTOH_KASUS.jasa)}) = saldo Pendapatan Jasa Pinjaman di sheet 7.`),
      I('Satu anggota cukup satu baris. Bila data awal sudah pernah diimpor, sheet ini boleh diunggah sendiri memakai nomor anggota dari aplikasi (A00001).'),
    ],
  },
  {
    kunci: 'saldo-akun',
    label: 'Sheet 7',
    judul: 'Saldo Awal Akun — sisa neraca saldo',
    isi:
      'Isi akun yang TIDAK terisi otomatis: Kas, Bank, pendapatan dan beban tahun berjalan, cadangan, modal, dan utang. Kode akun lihat sheet "Daftar Akun". Saldo selalu angka positif menurut saldo normal akunnya.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_SALDO_LAMA,
      tabAktif: JUDUL_SHEET_SALDO_AWAL_AKUN,
      kolom: ['Kode Akun', 'Nama Akun', 'Saldo', 'Bagian Tunai'],
      baris: [
        [kodeAkunBawaan('Kas'), 'Kas', ribuan(CONTOH_KASUS.kas), ''],
        [kodeAkunBawaan('Pendapatan Jasa Pinjaman'), 'Pendapatan Jasa Pinjaman', ribuan(CONTOH_KASUS.jasa), ''],
        [kodeAkunBawaan('Beban Operasional'), 'Beban Operasional', '350.000', ''],
        [kodeAkunBawaan('Cadangan Umum'), 'Cadangan Umum', '10.000.000', ''],
      ],
      sorot: [0, 2],
      keterangan: ['Kode dari sheet "Daftar Akun"', 'Positif; akun bersaldo 0 tidak ditulis'],
    },
    poin: [
      S(
        'Menulis Piutang Pinjaman, Simpanan Pokok/Wajib/Sukarela, Simpanan Berjangka, Aset Tetap atau akumulasinya di sini. Akun-akun itu sudah terisi otomatis dari sheet 2–5, sehingga barisnya ditolak.'
      ),
      S('Menulis akun 3-5000 "Saldo Awal Belum Sesuai". Akun ini penyeimbang otomatis.'),
      I('Bagian Tunai (khusus pendapatan/beban) boleh dikosongkan. Isi bila sebagian pendapatan/beban belum diterima/dibayar tunai; dipakai untuk SHU Basis Kas.'),
    ],
  },
  {
    kunci: 'seimbang',
    label: 'Cek sebelum import',
    judul: 'Neraca harus seimbang → "Saldo Awal Belum Sesuai" Rp0',
    isi:
      'Akun dari sheet 2–5 (hijau) ditambah akun sheet 7 (biru) harus membentuk neraca saldo yang seimbang. Bila total debit ≠ total kredit, selisihnya masuk akun "Saldo Awal Belum Sesuai".',
    ilustrasi: { jenis: 'NERACA', debit: NERACA_CONTOH.debit, kredit: NERACA_CONTOH.kredit },
    poin: [
      B('Cara cepat: Kas = total kredit − total debit lain. Pada contoh: 20.221.000 − 12.150.000 = 8.071.000.'),
      I('Contoh ini tanpa aset tetap agar sederhana. Aset Tetap dan akumulasinya juga terisi otomatis dari sheet 5.'),
    ],
    tips: 'Setelah import, layar menampilkan nilai "Saldo Awal Belum Sesuai". Bila tidak Rp0, koreksi di menu Saldo Awal Akun.',
  },
  SLIDE_FORMAT,
  SLIDE_HAPUS_CONTOH(['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung'], [
    ['A001', 'Siti Aminah', '05/01/2024'],
    ['A002', 'Budi Santoso', '10/03/2025'],
  ]),
  {
    kunci: 'periksa',
    label: 'Langkah 3 & 4',
    judul: 'Periksa dulu, baru Import',
    isi:
      'Di layar Import pilih "Saldo lama", cek tanggal cut-off, lalu pilih berkas. Aplikasi hanya MEMERIKSA dan belum menyimpan apa pun. Kesalahan ditampilkan per sheet lengkap dengan nomor baris Excel.',
    ilustrasi: { jenis: 'PERIKSA' },
    poin: [
      B('Buat Backup lebih dulu (Pengaturan › Backup & Restore).'),
      B('Perbaiki baris yang salah di Excel, simpan, lalu pilih berkasnya lagi sampai pemeriksaan bersih.'),
      S('Mengimpor berkas yang sama dua kali. Bila ada baris yang gagal, impor ulang HANYA baris yang gagal itu.'),
    ],
  },
  {
    kunci: 'selesai',
    label: 'Setelah import',
    judul: 'Cocokkan hasilnya dengan pembukuan lama',
    isi: 'Import selesai bila tiga hal ini cocok:',
    ilustrasi: { jenis: 'SELESAI' },
    poin: [
      B('"Saldo Awal Belum Sesuai" = Rp0 di panel hasil import.'),
      B('Laporan Posisi Keuangan per cut-off sama dengan neraca lama.'),
      B('Tidak ada "Pinjaman yang perlu dicek". Bila ada, cocokkan dengan kartu pinjamannya.'),
      I('Riwayat import tersimpan di ikon jam pada pojok kanan atas layar Import.'),
    ],
  },
];

const TRANSAKSI_BARU: SlidePanduanImport[] = [
  {
    kunci: 'mulai',
    label: 'Panduan Template Transaksi Baru',
    judul: 'Catat banyak transaksi awal sekaligus',
    isi:
      'Template ini untuk koperasi yang BARU berdiri, atau untuk transaksi yang uangnya memang bergerak lewat kas/bank koperasi. Setiap baris menjadi transaksi berjurnal biasa, sama seperti diinput satu per satu lewat menu.',
    ilustrasi: {
      jenis: 'ALUR',
      tahap: [
        { ikon: 'download-outline', label: 'Unduh template' },
        { ikon: 'create-outline', label: 'Isi sheet 1–4' },
        { ikon: 'shield-checkmark-outline', label: 'Periksa' },
        { ikon: 'cloud-upload-outline', label: 'Import' },
      ],
    },
    poin: [I('Geser, atau tekan Lanjut, untuk pindah slide.')],
  },
  {
    kunci: 'pilih',
    label: 'Sebelum mulai',
    judul: 'Pastikan memakai template yang tepat',
    isi:
      'Koperasi yang sudah berjalan bertahun-tahun dan baru pindah ke KOPKU memakai Template SALDO LAMA, bukan template ini. Bila salah pilih, kas tercatat bertambah/berkurang untuk uang yang sudah lama bergerak.',
    ilustrasi: { jenis: 'PILIH' },
    poin: [
      B('Koperasi baru berdiri, setoran dan pencairan pertama dicatat sekaligus → Transaksi Baru.'),
      S('Memasukkan saldo simpanan lama lewat template ini. Kas akan bertambah seolah uangnya baru diterima.'),
    ],
  },
  SLIDE_ANGGOTA(TAB_TRANSAKSI_BARU),
  {
    kunci: 'simpanan',
    label: 'Sheet 2',
    judul: 'Setoran simpanan — satu baris satu setoran',
    isi:
      'Setiap baris adalah satu setoran pada tanggalnya. Satu anggota boleh punya banyak baris (misalnya simpanan wajib tiap bulan). Kas/Bank bertambah sebesar setoran.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_TRANSAKSI_BARU,
      tabAktif: JUDUL_SHEET.SIMPANAN,
      kolom: ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
      baris: [
        ['A001', '05/01/2026', '100.000', '50.000', '0'],
        ['A001', '05/02/2026', '0', '50.000', '0'],
        ['A002', '10/01/2026', '100.000', '50.000', '200.000'],
      ],
      sorot: [1, 2],
      keterangan: ['Tanggal setoran', 'Hanya sekali per anggota'],
    },
    poin: [
      S('Menulis Simpanan Pokok di setiap baris. Simpanan Pokok hanya dicatat sekali; baris berikutnya tulis 0.'),
      I('Simpanan diproses LEBIH DULU daripada pinjaman, supaya kas cukup untuk pencairan.'),
      I('Sumber Dana BANK: bila koperasi punya lebih dari satu rekening bank aktif, isi kolom Rekening Bank dengan nomor rekeningnya (lihat menu Data Bank).'),
    ],
  },
  {
    kunci: 'pinjaman',
    label: 'Sheet 3',
    judul: 'Pinjaman dicairkan dari kas',
    isi:
      'Pinjaman dicairkan pada Tanggal Pencairan, dengan pemeriksaan kelayakan dan likuiditas seperti biasa. Angsuran yang sudah dibayar dicatat satu per satu pada tanggal jatuh temponya.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_TRANSAKSI_BARU,
      tabAktif: JUDUL_SHEET.PINJAMAN,
      kolom: ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Sumber Dana', 'Angsuran Sudah Dibayar'],
      baris: [['A001', '15/01/2026', '2.000.000', '10', 'KAS', '2']],
      sorot: [4, 5],
      keterangan: ['Kas/Bank harus cukup', 'Dicatat per jatuh tempo'],
    },
    poin: [
      S('Saldo kas pada tanggal pencairan lebih kecil dari pinjaman. Baris ditolak karena likuiditas tidak cukup.'),
      I('Angsuran yang dibayar tidak tepat pada tanggal jatuh tempo diinput lewat menu Pinjaman, bukan lewat template.'),
      I('Pencairan dari BANK memakai rekening di kolom Rekening Bank; boleh kosong hanya bila koperasi punya satu rekening bank aktif.'),
    ],
  },
  {
    kunci: 'berjangka',
    label: 'Sheet 4',
    judul: 'Penempatan simpanan berjangka baru',
    isi: 'Kas/Bank bertambah sebesar nominal pada tanggal penempatan. Tenor hanya 3, 6, atau 12 bulan.',
    ilustrasi: {
      jenis: 'SHEET',
      tab: TAB_TRANSAKSI_BARU,
      tabAktif: JUDUL_SHEET.BERJANGKA,
      kolom: ['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan', 'Bunga Persen Per Tahun'],
      baris: [['A002', '01/02/2026', '3.000.000', '6', '5']],
      sorot: [3, 4],
      keterangan: ['3, 6, atau 12', 'Bunga per tahun'],
    },
    poin: [I('Atur Kebijakan Produk Simpanan Berjangka lebih dulu. Tanpa kebijakan yang berlaku pada tanggal penempatan, baris ini gagal.')],
  },
  SLIDE_FORMAT,
  SLIDE_HAPUS_CONTOH(['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung'], [
    ['A001', 'Siti Aminah', '05/01/2026'],
    ['A002', 'Budi Santoso', '10/01/2026'],
  ]),
  {
    kunci: 'periksa',
    label: 'Langkah 3 & 4',
    judul: 'Periksa dulu, baru Import',
    isi:
      'Di layar Import pilih "Transaksi baru", lalu pilih berkas. Aplikasi hanya MEMERIKSA dan belum menyimpan apa pun. Kesalahan ditampilkan per sheet lengkap dengan nomor baris Excel.',
    ilustrasi: { jenis: 'PERIKSA' },
    poin: [
      B('Buat Backup lebih dulu (Pengaturan › Backup & Restore).'),
      S('Mengimpor berkas yang sama dua kali. Setoran dan pinjaman akan tercatat ganda.'),
      I('Penarikan simpanan, beban, pembelian aset, dan pendapatan lain diinput lewat menu biasa.'),
    ],
  },
];

export const PANDUAN_IMPORT: Record<JenisTemplateDataAwal, SlidePanduanImport[]> = {
  SALDO_LAMA,
  TRANSAKSI_BARU,
};

/** Label kolom yang dipakai ilustrasi — untuk test "panduan tidak menyebut kolom yang tidak ada". */
export function kolomIlustrasi(slides: SlidePanduanImport[]): { sheet: string; kolom: string }[] {
  const out: { sheet: string; kolom: string }[] = [];
  for (const s of slides) {
    if (s.ilustrasi.jenis !== 'SHEET') continue;
    for (const k of s.ilustrasi.kolom) out.push({ sheet: s.ilustrasi.tabAktif, kolom: k });
  }
  return out;
}

/** True bila kolom ilustrasi wajib menurut template (untuk tanda * pada ilustrasi). */
export function kolomWajibIlustrasi(sheet: string, kolom: string): boolean {
  if (sheet === JUDUL_SHEET_SALDO_AWAL_AKUN) return kolom === 'Kode Akun' || kolom === 'Saldo';
  return wajib(sheet, kolom);
}

// ===========================================================================
// 2. DAFTAR PERIKSA (ditampilkan di layar sebelum memilih berkas)
// ===========================================================================

export const DAFTAR_PERIKSA: Record<JenisTemplateDataAwal, string[]> = {
  SALDO_LAMA: [
    'Semua tanggal di berkas SEBELUM tanggal cut-off',
    'Kode Anggota di sheet 2–6 sama persis dengan sheet 1',
    'Jumlah Pinjaman = pokok awal, bukan sisa pinjaman',
    'Total sheet 6 = saldo Pendapatan Jasa Pinjaman di sheet 7',
    'Baris contoh (kuning) sudah dihapus di setiap sheet',
    'Sudah membuat Backup',
  ],
  TRANSAKSI_BARU: [
    'Setiap baris simpanan = satu setoran pada tanggalnya',
    'Kode Anggota di sheet 2–4 sama persis dengan sheet 1',
    'Kas cukup pada tanggal setiap pencairan pinjaman',
    'Baris contoh (kuning) sudah dihapus di setiap sheet',
    'Sudah membuat Backup',
  ],
};

// ===========================================================================
// 3. PEMERIKSAAN SEBELUM IMPORT
// ===========================================================================

export type TingkatPeringatan = 'BLOKIR' | 'PERINGATAN' | 'INFO';
export interface PeringatanImport {
  kunci: string;
  tingkat: TingkatPeringatan;
  judul: string;
  pesan: string;
}

const NOMOR_ASET_CONTOH = String(
  SHEET_TEMPLATE.find((s) => s.jenis === 'ASET')?.kolom.find((k) => k.label === 'Nomor Aset')?.contoh ?? 'AST-CONTOH'
).toUpperCase();

function daftarBaris(nomor: number[]): string {
  const urut = [...nomor].sort((a, b) => a - b);
  const tampil = urut.slice(0, 6).join(', ');
  return urut.length > 6 ? `${tampil}, … (${urut.length} baris)` : tampil;
}

/**
 * Pemeriksaan TAMBAHAN atas hasil pratinjau. Tidak mengubah `ringkasan`.
 * `sifat` dan `cutOff` adalah pilihan yang sedang aktif di layar.
 */
export function periksaSebelumImport(
  ringkasan: RingkasanParse,
  opsi: {
    sifat: 'SALDO_AWAL' | 'TRANSAKSI_BARU';
    cutOff?: string;
    /**
     * RC-S133.6.1 — rekening bank aktif saat pratinjau. Bila diberikan,
     * baris Sumber Dana BANK yang akan bergerak lewat kas/bank diperiksa
     * dengan aturan yang SAMA dengan eksekutor (`pilihRekeningBankImport`).
     * Tidak diberikan = pemeriksaan ini dilewati (perilaku lama).
     */
    rekeningBank?: RekeningBankAktif[];
    /** RC-S133.6.1 — NIK anggota yang sudah ada di database (BLOKIR bila berkas memakainya lagi). */
    nikTerdaftar?: string[];
    /**
     * RC-S133.6.2 — sidik baris yang sudah tersimpan (lihat SidikImport) untuk
     * sidik baris berkas ini. Tidak diberikan = pemeriksaan import ganda dilewati.
     */
    sidikTercatat?: ReadonlyMap<string, SidikTercatat>;
    /**
     * RC-S133.6.2 — anggota yang sudah ada (nama & tanggal bergabung) untuk
     * memperingatkan baris anggota tanpa NIK yang kemungkinan sudah diimpor
     * sebelum sidik dicatat (data sebelum v81).
     */
    anggotaTerdaftar?: { nomorAnggota: string; nama: string; tanggalBergabung: string | null }[];
  }
): PeringatanImport[] {
  const h = ringkasan.hasil;
  const out: PeringatanImport[] = [];

  // ---- A0. RC-S133.6.2 — BERKAS / BARIS YANG SUDAH PERNAH DIIMPOR ----
  // Dikenali dari sidik ISI baris yang tersimpan permanen — bukan nama
  // berkas, bukan NIK. Seluruh baris sudah masuk -> BLOKIR (berkas identik,
  // termasuk yang namanya diganti). Sebagian -> PERINGATAN: baris yang sudah
  // masuk dilewati, sisanya diproses (melanjutkan import yang gagal sebagian).
  const sidikBerkas = opsi.sidikTercatat ? hitungSidikBerkas(h) : null;
  const sudahAnggota = new Set<number>();
  if (sidikBerkas && opsi.sidikTercatat) {
    const cmp = bandingkanSidik(sidikBerkas, opsi.sidikTercatat);
    for (const b of cmp.sudah) if (b.jenis === 'ANGGOTA') sudahAnggota.add(b.baris);
    if (cmp.sudah.length > 0) {
      const asal = cmp.pertama
        ? ` (pertama kali ${tanggalPanjang(cmp.pertama.createdAt.slice(0, 10))}${cmp.pertama.namaBerkas ? `, berkas "${cmp.pertama.namaBerkas}"` : ''})`
        : '';
      const perJenis = new Map<string, number[]>();
      for (const b of cmp.sudah) perJenis.set(b.jenis, [...(perJenis.get(b.jenis) ?? []), b.baris]);
      const rincian = [...perJenis.entries()]
        .map(([j, b]) => `${JUDUL_SHEET[j as keyof typeof JUDUL_SHEET]} baris ${daftarBaris(b)}`)
        .join('; ');
      if (cmp.sudah.length === cmp.total) {
        out.push({
          kunci: 'berkas-sudah-diimpor',
          tingkat: 'BLOKIR',
          judul: 'Berkas ini sudah pernah diimpor',
          pesan:
            `Seluruh ${cmp.total} baris pada berkas ini sudah pernah diimpor${asal}, walau nama berkasnya bisa berbeda. ` +
            'Mengimpor ulang akan menggandakan anggota, simpanan, dan pinjaman — import ditolak. Lihat Riwayat Import.',
        });
      } else {
        out.push({
          kunci: 'sebagian-sudah-diimpor',
          tingkat: 'PERINGATAN',
          judul: `${cmp.sudah.length} baris sudah pernah diimpor — akan DILEWATI`,
          pesan:
            `${cmp.sudah.length} dari ${cmp.total} baris sudah masuk ke buku${asal}: ${rincian}. ` +
            `Baris itu tidak diproses lagi; hanya ${cmp.baru.length} baris baru yang diimpor. ` +
            'Pastikan ini memang lanjutan import sebelumnya, bukan transaksi baru yang isinya kebetulan sama.',
        });
      }
    }
  }

  // ---- A0b. RC-S133.6.2 — ANGGOTA TANPA NIK YANG MIRIP ANGGOTA YANG ADA ----
  // Untuk data yang diimpor SEBELUM sidik dicatat (v81) atau dimasukkan lewat
  // menu: nama + tanggal bergabung sama dengan anggota yang sudah ada.
  if (opsi.anggotaTerdaftar && opsi.anggotaTerdaftar.length > 0) {
    const ada = new Map<string, string>();
    for (const a of opsi.anggotaTerdaftar) {
      ada.set(`${normalkanNamaSidik(a.nama)}~${a.tanggalBergabung ?? ''}`, a.nomorAnggota);
    }
    const mirip = h.anggota.baris.filter(
      (r) => !r.nik && !sudahAnggota.has(r.baris) && ada.has(`${normalkanNamaSidik(r.namaLengkap)}~${r.tanggalBergabung}`)
    );
    if (mirip.length > 0) {
      out.push({
        kunci: 'anggota-mirip',
        tingkat: 'PERINGATAN',
        judul: 'Anggota tanpa NIK kemungkinan sudah ada',
        pesan:
          mirip
            .slice(0, 4)
            .map((r) => `baris ${r.baris} ${r.namaLengkap} = ${ada.get(`${normalkanNamaSidik(r.namaLengkap)}~${r.tanggalBergabung}`)}`)
            .join('; ') +
          (mirip.length > 4 ? `; dan ${mirip.length - 4} lainnya` : '') +
          `. Nama dan tanggal bergabungnya sama dengan anggota yang sudah ada di aplikasi. Bila berkas ini pernah diimpor, JANGAN lanjutkan — anggota beserta simpanan & pinjamannya akan tercatat dua kali. Isi NIK agar anggota dapat dikenali pasti.`,
      });
    }
  }
  const kodeContoh = KODE_CONTOH.toUpperCase();

  // ---- A. BARIS CONTOH YANG LUPA DIHAPUS (BLOKIR) ----
  const contoh: string[] = [];
  const cek = (judul: string, nomor: number[]) => {
    if (nomor.length > 0) contoh.push(`${judul} baris ${daftarBaris(nomor)}`);
  };
  cek(JUDUL_SHEET.ANGGOTA, h.anggota.baris.filter((r) => r.kode.trim().toUpperCase() === kodeContoh).map((r) => r.baris));
  cek(JUDUL_SHEET.SIMPANAN, h.simpanan.baris.filter((r) => r.kode.trim().toUpperCase() === kodeContoh).map((r) => r.baris));
  cek(JUDUL_SHEET.PINJAMAN, h.pinjaman.baris.filter((r) => r.kode.trim().toUpperCase() === kodeContoh).map((r) => r.baris));
  cek(JUDUL_SHEET.BERJANGKA, h.berjangka.baris.filter((r) => r.kode.trim().toUpperCase() === kodeContoh).map((r) => r.baris));
  cek(
    JUDUL_SHEET.ASET,
    h.aset.baris
      .filter((r) => r.nomorAset.trim().toUpperCase() === NOMOR_ASET_CONTOH || /hapus baris ini/i.test(r.namaAset))
      .map((r) => r.baris)
  );
  cek(JUDUL_SHEET.JASA, h.jasa.baris.filter((r) => r.kode.trim().toUpperCase() === kodeContoh).map((r) => r.baris));
  if (contoh.length > 0) {
    out.push({
      kunci: 'contoh',
      tingkat: 'BLOKIR',
      judul: 'Baris contoh belum dihapus',
      pesan: `${contoh.join('; ')}. Hapus baris bertanda "${KODE_CONTOH}" (berlatar kuning), simpan, lalu pilih berkasnya lagi.`,
    });
  }

  // ---- A2. SHEET ADA TETAPI JUDUL KOLOMNYA TIDAK DIKENALI (BLOKIR) ----
  // Parser tidak menghitungnya sebagai galat (sheet dianggap tidak ada),
  // sehingga tanpa pemeriksaan ini SELURUH isi sheet itu diam-diam
  // terlewat — mis. kolom "Jumlah Pinjaman" diganti nama, lalu import
  // berjalan tanpa satu pun pinjaman.
  const judulHilang: string[] = [];
  for (const sh of [h.anggota, h.simpanan, h.pinjaman, h.berjangka, h.aset, h.jasa, h.saldoAwalAkun]) {
    if (sh && !sh.terbaca && sh.galatSheet && /baris judul kolom tidak ditemukan/.test(sh.galatSheet)) judulHilang.push(sh.galatSheet);
  }
  if (judulHilang.length > 0) {
    out.push({
      kunci: 'judul-kolom',
      tingkat: 'BLOKIR',
      judul: 'Judul kolom tidak dikenali — isi sheet akan terlewat',
      pesan: `${judulHilang.join(' ')} Jangan mengganti nama kolom wajib atau menghapus baris judul (baris hijau). Bila sheet itu memang tidak dipakai, hapus sheet-nya.`,
    });
  }

  // ---- A2b. RC-S133.6.1 — REKENING UNTUK SUMBER DANA BANK (BLOKIR) ----
  // Temuan audit manual-vs-impor (d): pratinjau menyatakan "siap diimpor"
  // padahal baris BANK pasti ditolak eksekutor (lebih dari satu rekening
  // aktif, kolom Rekening Bank kosong / tidak cocok). Hanya baris yang
  // memang bergerak lewat kas/bank yang diperiksa — baris saldo lama
  // (tanggal sebelum cut-off) tidak memakai rekening.
  if (opsi.rekeningBank) {
    const daftar = opsi.rekeningBank;
    const lewatKasBank = (t: string) => opsi.sifat === 'TRANSAKSI_BARU' || !opsi.cutOff || t >= opsi.cutOff;
    const perPesan = new Map<string, Map<string, number[]>>();
    const periksaRek = (judul: string, rows: { baris: number; tanggal: string; sumberDana: 'KAS' | 'BANK'; rekeningBank?: string }[]) => {
      for (const r of rows) {
        if (r.sumberDana !== 'BANK' || !lewatKasBank(r.tanggal)) continue;
        const p = pilihRekeningBankImport(r.rekeningBank, daftar);
        if ('id' in p) continue;
        const m = perPesan.get(p.galat) ?? new Map<string, number[]>();
        m.set(judul, [...(m.get(judul) ?? []), r.baris]);
        perPesan.set(p.galat, m);
      }
    };
    periksaRek(JUDUL_SHEET.SIMPANAN, h.simpanan.baris);
    periksaRek(JUDUL_SHEET.PINJAMAN, h.pinjaman.baris);
    periksaRek(JUDUL_SHEET.BERJANGKA, h.berjangka.baris);
    if (perPesan.size > 0) {
      const bagian = [...perPesan.entries()].map(
        ([pesan, m]) => `${[...m.entries()].map(([judul, nomor]) => `${judul} baris ${daftarBaris(nomor)}`).join('; ')}: ${pesan}`
      );
      out.push({
        kunci: 'rekening-bank',
        tingkat: 'BLOKIR',
        judul: 'Rekening bank untuk Sumber Dana BANK belum jelas',
        pesan: `${bagian.join(' ')} Isi kolom Rekening Bank dengan nomor rekening seperti di menu Data Bank, atau gunakan Sumber Dana KAS.`,
      });
    }
  }

  // ---- A2c. RC-S133.6.1 — NIK SUDAH TERDAFTAR (BLOKIR) ----
  // anggota.nik UNIK; baris dengan NIK milik anggota yang sudah ada pasti
  // gagal saat import (beserta seluruh simpanan/pinjamannya).
  if (opsi.nikTerdaftar && opsi.nikTerdaftar.length > 0) {
    const ada = new Set(opsi.nikTerdaftar.map((n) => n.trim()));
    // RC-S133.6.2 — baris anggota yang sudah tercatat sidiknya akan DILEWATI
    // (anggotanya dipakai ulang), jadi NIK-nya wajar sudah terdaftar.
    const bentrok = h.anggota.baris.filter((r) => r.nik && ada.has(r.nik.trim()) && !sudahAnggota.has(r.baris));
    if (bentrok.length > 0) {
      out.push({
        kunci: 'nik-terdaftar',
        tingkat: 'BLOKIR',
        judul: 'NIK sudah terdaftar pada anggota lain',
        pesan: `${JUDUL_SHEET.ANGGOTA} baris ${daftarBaris(bentrok.map((r) => r.baris))}: NIK sudah dipakai anggota yang ada di aplikasi. Bila berkas ini pernah diimpor, jangan impor ulang; bila anggotanya berbeda, perbaiki NIK.`,
      });
    }
  }

  // ---- A3. RC-S133.4.8 — SATUAN JASA PINJAMAN & RINGKASAN PIUTANG ----
  out.push(...periksaJasaPinjaman(h.pinjaman.baris));

  const adaSheet7 = (h.saldoAwalAkun?.baris.length ?? 0) > 0;
  const kolomMigrasi = h.pinjaman.baris.filter(
    (r) =>
      r.nomorPinjamanLama !== undefined ||
      r.sisaPokok !== undefined ||
      r.angsuranTersisa !== undefined ||
      r.tunggakanPokok !== undefined ||
      r.piutangJasa !== undefined
  );

  if (opsi.sifat === 'TRANSAKSI_BARU') {
    // ---- B. BERKAS SALDO LAMA DIIMPOR SEBAGAI TRANSAKSI BARU ----
    const tanda: string[] = [];
    if (adaSheet7) tanda.push(`sheet "${JUDUL_SHEET_SALDO_AWAL_AKUN}" terisi`);
    if (h.jasa.baris.length > 0) tanda.push(`sheet "${JUDUL_SHEET.JASA}" terisi`);
    if (tanda.length > 0) {
      out.push({
        kunci: 'salah-template',
        tingkat: 'BLOKIR',
        judul: 'Berkas ini berisi data Saldo Lama',
        pesan:
          `Pada berkas, ${tanda.join(' dan ')}. Sheet itu hanya dipakai pilihan "Saldo lama" dan akan gagal semuanya bila diimpor sebagai transaksi baru. ` +
          'Ganti pilihan jenis data menjadi "Saldo lama", atau hapus isi sheet tersebut.',
      });
    }
    if (kolomMigrasi.length > 0) {
      out.push({
        kunci: 'kolom-migrasi',
        tingkat: 'PERINGATAN',
        judul: 'Kolom Sisa Pokok dkk. diabaikan',
        pesan:
          `${JUDUL_SHEET.PINJAMAN} baris ${daftarBaris(kolomMigrasi.map((r) => r.baris))} mengisi kolom pinjaman lama (Nomor Pinjaman Lama/Sisa Pokok/` +
          'Angsuran Tersisa/Tunggakan/Piutang Jasa). Pada "Transaksi baru" kolom itu tidak dipakai: pinjaman dicairkan penuh dari kas. ' +
          'Bila ini pinjaman lama, pilih "Saldo lama".',
      });
    }
    if (h.aset.baris.length > 0) {
      out.push({
        kunci: 'aset-transaksi-baru',
        tingkat: 'INFO',
        judul: 'Aset tetap dicatat sebagai saldo awal',
        pesan:
          `Baris ${JUDUL_SHEET.ASET} tidak dibeli lewat kas. Aset dicatat sebagai saldo awal per hari ini. Pembelian aset baru diinput lewat menu Pembelian Aset.`,
      });
    }
    return out;
  }

  // ---- C. SALDO LAMA: BARIS PADA/SETELAH CUT-OFF ----
  const cutOff = opsi.cutOff;
  if (cutOff) {
    const lewat: string[] = [];
    const s = h.simpanan.baris.filter((r) => r.tanggal >= cutOff).map((r) => r.baris);
    const p = h.pinjaman.baris.filter((r) => r.tanggal >= cutOff).map((r) => r.baris);
    const b = h.berjangka.baris.filter((r) => r.tanggal >= cutOff).map((r) => r.baris);
    if (s.length) lewat.push(`${JUDUL_SHEET.SIMPANAN} baris ${daftarBaris(s)} (kas bertambah)`);
    if (b.length) lewat.push(`${JUDUL_SHEET.BERJANGKA} baris ${daftarBaris(b)} (kas bertambah)`);
    if (p.length) lewat.push(`${JUDUL_SHEET.PINJAMAN} baris ${daftarBaris(p)} (dicairkan dari kas)`);
    if (lewat.length > 0) {
      out.push({
        kunci: 'setelah-cutoff',
        tingkat: 'PERINGATAN',
        judul: `Ada tanggal pada/setelah cut-off (${tanggalPanjang(cutOff)})`,
        pesan:
          `${lewat.join('; ')}. Baris ini diproses sebagai TRANSAKSI BARU, bukan saldo awal. ` +
          `Bila semestinya saldo lama, ubah tanggalnya menjadi paling lambat ${tanggalPanjang(hariSebelumIso(cutOff))} atau ubah tanggal cut-off.`,
      });
    }
  }

  // ---- D. SALDO LAMA: BEBERAPA BARIS SALDO SIMPANAN PER ANGGOTA ----
  const perAnggota = new Map<string, number[]>();
  for (const r of h.simpanan.baris) {
    if (cutOff && r.tanggal >= cutOff) continue;
    const k = r.kode.trim().toUpperCase();
    perAnggota.set(k, [...(perAnggota.get(k) ?? []), r.baris]);
  }
  const ganda = [...perAnggota.entries()].filter(([, b]) => b.length > 1);
  if (ganda.length > 0) {
    out.push({
      kunci: 'simpanan-ganda',
      tingkat: 'PERINGATAN',
      judul: 'Satu anggota punya beberapa baris saldo simpanan',
      pesan:
        ganda
          .slice(0, 4)
          .map(([k, b]) => `${k}: baris ${daftarBaris(b)}`)
          .join('; ') +
        (ganda.length > 4 ? `; dan ${ganda.length - 4} anggota lain` : '') +
        '. Pada Saldo lama semua baris itu DIJUMLAHKAN. Pastikan ini bukan daftar setoran. Yang benar: satu baris berisi saldo akhir per anggota.',
    });
  }

  // ---- E. TOTAL SHEET 6 vs PENDAPATAN JASA DI SHEET 7 ----
  if (h.jasa.baris.length > 0 && adaSheet7) {
    const kodeJasa = kodeAkunBawaan('Pendapatan Jasa Pinjaman');
    const totalJasa = h.jasa.baris.reduce((t, r) => t + r.jasa, 0);
    const baris7 = h.saldoAwalAkun!.baris.find((r) => r.kodeAkun.trim() === kodeJasa);
    if (baris7 && baris7.saldo !== totalJasa) {
      out.push({
        kunci: 'jasa-beda',
        tingkat: 'PERINGATAN',
        judul: 'Total jasa sheet 6 berbeda dari sheet 7',
        pesan:
          `Total "${JUDUL_SHEET.JASA}" Rp${ribuan(totalJasa)}, sedangkan saldo ${kodeJasa} Pendapatan Jasa Pinjaman di sheet 7 Rp${ribuan(baris7.saldo)} ` +
          `(selisih Rp${ribuan(Math.abs(totalJasa - baris7.saldo))}). Selisih wajar hanya bila ada jasa yang belum dibayar tunai (piutang jasa).`,
      });
    }
  }

  // ---- F. INFO: TANPA SHEET 7 / ADA BERJANGKA ----
  if (!adaSheet7 && (h.anggota.baris.length > 0 || h.simpanan.baris.length > 0 || h.pinjaman.baris.length > 0)) {
    out.push({
      kunci: 'tanpa-sheet7',
      tingkat: 'INFO',
      judul: 'Saldo Kas & akun lain belum ada di berkas',
      pesan:
        `Sheet "${JUDUL_SHEET_SALDO_AWAL_AKUN}" tidak ada atau belum berisi saldo akun. Setelah import, isi Kas/Bank, pendapatan & beban tahun berjalan, cadangan, dan utang di menu Saldo Awal Akun sampai "Saldo Awal Belum Sesuai" Rp0.`,
    });
  }
  if (h.berjangka.baris.length > 0) {
    out.push({
      kunci: 'kebijakan-berjangka',
      tingkat: 'INFO',
      judul: 'Simpanan berjangka butuh kebijakan produk',
      pesan:
        'Pastikan Kebijakan Produk Simpanan Berjangka sudah aktif (paling lambat pada tanggal cut-off). Tanpa itu, baris simpanan berjangka gagal diimpor.',
    });
  }
  return out;
}

// ===========================================================================
// 4. RC-S133.4.8 — JASA PINJAMAN: SATUAN & RINGKASAN SEBELUM IMPORT
// ===========================================================================

/** Estimasi sisa per pinjaman pada saat import (jadwal dari kalkulator yang sama dengan pinjaman baru). */
export interface EstimasiPinjamanImport {
  baris: number;
  pokokAwal: number;
  sisaPokok: number;
  sisaJasa: number;
  /** Total jasa sepanjang tenor (seluruh angsuran). */
  totalJasa: number;
}

export interface RingkasanPinjamanImport {
  jumlah: number;
  pokokAwal: number;
  sisaPokok: number;
  sisaJasa: number;
  /** Baris yang total jasanya melebihi pokok, padahal Jasa Persen dibaca PER PERIODE. */
  jasaMelebihiPokok: EstimasiPinjamanImport[];
  /** Baris yang memakai Satuan Jasa = TAHUN (sudah dikonversi ÷ 12). */
  barisTahunan: number;
}

export function estimasiPinjamanImport(r: BarisPinjaman): EstimasiPinjamanImport {
  const tenor = r.tenor;
  const dibayar = Math.max(0, Math.min(tenor, Math.trunc(r.angsuranSudahDibayar || 0)));
  let pokok: number[];
  let jasa: number[];
  try {
    const jadwal = hitungJadwalAngsuran({
      jumlahPinjaman: r.jumlahPinjaman,
      tenor,
      persentaseJasaPerPeriode: Number.isFinite(r.persentaseJasa) && r.persentaseJasa > 0 ? r.persentaseJasa : 0,
      metode: r.metodeJasa,
    });
    pokok = jadwal.map((b) => Number(b.pokok));
    jasa = jadwal.map((b) => Number(b.jasa));
  } catch {
    pokok = Array.from({ length: tenor }, (_, i) => (i === 0 ? r.jumlahPinjaman : 0));
    jasa = Array.from({ length: tenor }, () => 0);
  }
  // Kolom migrasi yang diisi manual (Sisa Pokok & Angsuran Tersisa) diutamakan.
  const tersisa = r.angsuranTersisa !== undefined ? Math.min(tenor, r.angsuranTersisa) : tenor - dibayar;
  const mulai = tenor - tersisa;
  let sisaPokok = 0;
  let sisaJasa = 0;
  for (let i = mulai; i < tenor; i++) {
    sisaPokok += pokok[i] ?? 0;
    sisaJasa += jasa[i] ?? 0;
  }
  if (r.sisaPokok !== undefined) sisaPokok = r.sisaPokok;
  return {
    baris: r.baris,
    pokokAwal: r.jumlahPinjaman,
    sisaPokok,
    sisaJasa,
    totalJasa: jasa.reduce((t, x) => t + x, 0),
  };
}

export function ringkasPinjamanImport(daftar: BarisPinjaman[]): RingkasanPinjamanImport {
  const est = daftar.map((r) => ({ r, e: estimasiPinjamanImport(r) }));
  return {
    jumlah: daftar.length,
    pokokAwal: est.reduce((t, x) => t + x.e.pokokAwal, 0),
    sisaPokok: est.reduce((t, x) => t + x.e.sisaPokok, 0),
    sisaJasa: est.reduce((t, x) => t + x.e.sisaJasa, 0),
    jasaMelebihiPokok: est.filter((x) => x.r.satuanJasa !== 'TAHUN' && x.e.totalJasa > x.e.pokokAwal).map((x) => x.e),
    barisTahunan: daftar.filter((r) => r.satuanJasa === 'TAHUN').length,
  };
}

/**
 * Peringatan jasa pinjaman. "Jasa Persen" dibaca PER PERIODE angsuran
 * (sama dengan form pinjaman). Kesalahan paling mahal adalah mengisi
 * angka PER TAHUN (mis. 18) tanpa Satuan Jasa = TAHUN: jasa menjadi 12×
 * lipat dan piutang berjalan membengkak. Ringkasan angka ditampilkan
 * SEBELUM import supaya terlihat.
 */
export function periksaJasaPinjaman(daftar: BarisPinjaman[]): PeringatanImport[] {
  if (daftar.length === 0) return [];
  const out: PeringatanImport[] = [];
  const rk = ringkasPinjamanImport(daftar);
  if (rk.jasaMelebihiPokok.length > 0) {
    const contoh = rk.jasaMelebihiPokok[0];
    const barisContoh = daftar.find((r) => r.baris === contoh.baris);
    out.push({
      kunci: 'jasa-per-tahun',
      tingkat: 'PERINGATAN',
      judul: `Jasa ${rk.jasaMelebihiPokok.length} pinjaman lebih besar dari pokoknya — Jasa Persen per tahun?`,
      pesan:
        `${JUDUL_SHEET.PINJAMAN} baris ${daftarBaris(rk.jasaMelebihiPokok.map((e) => e.baris))}. "Jasa Persen" dibaca PER BULAN (per periode angsuran). ` +
        (barisContoh
          ? `Contoh baris ${contoh.baris}: pokok Rp${ribuan(contoh.pokokAwal)}, ${barisContoh.persentaseJasa}% × ${barisContoh.tenor} angsuran → jasa Rp${ribuan(contoh.totalJasa)}. `
          : '') +
        'Bila angka Anda per TAHUN (mis. 18% setahun = 1,5% sebulan), isi kolom "Satuan Jasa" dengan TAHUN, simpan, lalu pilih berkasnya lagi.',
    });
  }
  out.push({
    kunci: 'ringkasan-pinjaman',
    tingkat: 'INFO',
    judul: `Ringkasan ${rk.jumlah} pinjaman (estimasi sebelum import)`,
    pesan:
      `Pokok awal Rp${ribuan(rk.pokokAwal)} · Sisa pokok (piutang) Rp${ribuan(rk.sisaPokok)} · ` +
      `Sisa jasa terjadwal Rp${ribuan(rk.sisaJasa)} · Sisa angsuran (pokok + jasa) Rp${ribuan(rk.sisaPokok + rk.sisaJasa)}. ` +
      (rk.barisTahunan > 0
        ? `${rk.barisTahunan} baris memakai Satuan Jasa TAHUN (sudah dibagi 12).`
        : 'Jasa Persen dibaca per bulan/periode.'),
  });
  return out;
}

/** True bila ada peringatan yang menahan tombol Import. */
export function adaBlokir(daftar: PeringatanImport[]): boolean {
  return daftar.some((p) => p.tingkat === 'BLOKIR');
}
