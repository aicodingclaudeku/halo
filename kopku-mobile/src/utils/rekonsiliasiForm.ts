import type { PenyebabSelisih, PerlakuanSelisih, TindakLanjutSelisihInput } from '@/services/CashReconciliationService';

/**
 * RC-S67.9 — logika MURNI layar Rekonsiliasi Kas & Bank yang disederhanakan.
 *
 * Tidak ada rumus akuntansi di sini. Saldo buku berasal dari ledger
 * (`getSaldoBukuPerTanggal` / `catatRekonsiliasi`), jurnal penyesuaian
 * dibuat oleh `selesaikanRekonsiliasi` existing. Berkas ini hanya
 * menerjemahkan pilihan bahasa sehari-hari ke penyebab/perlakuan yang
 * SUDAH ADA di service.
 */

export type JenisRekeningRekon = 'KAS' | 'KAS_KECIL' | 'BANK';

/** Selisih selalu dihitung sistem: saldo eksternal − saldo buku (tidak pernah diketik pengguna). */
export function hitungSelisih(saldoBuku: number, saldoAktual: number | ''): number | null {
  if (saldoAktual === '' || !Number.isFinite(saldoAktual)) return null;
  return saldoAktual - saldoBuku;
}

export type StatusSelisih = 'COCOK' | 'KURANG' | 'LEBIH';

export function statusSelisih(selisih: number): StatusSelisih {
  return selisih === 0 ? 'COCOK' : selisih < 0 ? 'KURANG' : 'LEBIH';
}

/** "Selisih Kurang" / "Selisih Lebih" + nilai absolut — tanpa angka negatif di UI. */
/**
 * RC-S79 — label saldo eksternal KONTEKSTUAL.
 *
 * Kolom databasenya tetap `saldo_fisik` (tidak di-rename), tetapi yang
 * dibaca pengurus harus menyebut dokumen sumbernya: rekening koran
 * untuk bank, hasil hitung fisik untuk kas. "Saldo Aktual" tidak
 * memberi tahu apa pun tentang dari mana angkanya harus diambil.
 */
export function labelSaldoEksternal(jenis: JenisRekeningRekon): string {
  return jenis === 'BANK' ? 'Saldo Menurut Rekening Koran' : 'Hasil Kas Opname';
}

/** Penjelasan satu baris di bawah input saldo eksternal. */
export function hintSaldoEksternal(jenis: JenisRekeningRekon): string {
  return jenis === 'BANK'
    ? 'Saldo menurut rekening koran / mutasi bank per tanggal ini.'
    : 'Jumlah uang tunai hasil hitung fisik (kas opname).';
}

/** Kalimat penjelas hasil rekonsiliasi — arah selisih dinyatakan eksplisit. */
export function penjelasanSelisih(selisih: number): string {
  const st = statusSelisih(selisih);
  if (st === 'COCOK') return 'Saldo buku dan saldo eksternal sama.';
  return st === 'KURANG'
    ? 'Saldo eksternal lebih kecil dari saldo buku.'
    : 'Saldo eksternal lebih besar dari saldo buku.';
}

export function labelSelisih(selisih: number): { judul: string; nilai: number } {
  const st = statusSelisih(selisih);
  if (st === 'COCOK') return { judul: 'Tidak ada selisih', nilai: 0 };
  return { judul: st === 'KURANG' ? 'Selisih Kurang' : 'Selisih Lebih', nilai: Math.abs(selisih) };
}

export type KodePenyebabUI =
  | 'BELUM_TERCATAT'
  | 'SALAH_PENCATATAN'
  | 'PERBEDAAN_WAKTU'
  | 'BIAYA_BANK'
  | 'JASA_GIRO'
  | 'KESALAHAN_BANK'
  | 'SELISIH_KAS_FISIK'
  | 'LAINNYA';

/**
 * RC-S67.9.1 — tindakan per penyebab:
 *  - PENYESUAIAN : Kopku mencatat penyesuaian lewat `selesaikanRekonsiliasi`
 *                  existing (PERLU_JURNAL). Akun pencatatan diminta di
 *                  "Detail Penyesuaian" (sekunder) karena service existing
 *                  SECARA EKSPLISIT mewajibkan akun lawan ditentukan pengurus
 *                  dan belum ada mapping akun untuk kasus ini.
 *  - ARAHKAN     : TIDAK ada jurnal; pengguna diarahkan ke workflow existing
 *                  (catat transaksi / koreksi di Riwayat Transaksi).
 * "Transaksi dalam proses" DIHAPUS dari pilihan (RC-S67.9.1 §8): tidak punya
 * perlakuan akuntansi khusus. "Jasa giro" juga tidak ditampilkan terpisah;
 * selisih lebih yang disebabkan jasa giro dicatat lewat "Lainnya".
 */
export type TindakanPenyebab = 'PENYESUAIAN' | 'TEMUAN';

export interface OpsiPenyebab {
  kode: KodePenyebabUI;
  label: string;
  /** PENYESUAIAN = perlu jurnal (butuh akun lawan); TEMUAN = tanpa jurnal. */
  tindakan: TindakanPenyebab;
  /** Penyebab di CashReconciliationService. RC-S78: SELALU terisi — setiap penyebab tersimpan. */
  penyebabService: PenyebabSelisih;
  arah: 'KURANG' | 'LEBIH' | 'KEDUANYA';
  rekening: 'BANK' | 'KAS' | 'SEMUA';
  wajibCatatan?: boolean;
  /** Helper text singkat di bawah label pilihan. */
  deskripsi: string;
  /** Isi kartu "Tindak Lanjut". */
  tindakLanjut: string;
  ctaLabel: string;
  /** true = boleh langsung SELESAI; false = disimpan sebagai DRAFT menunggu bukti penyelesaian. */
  selesai: boolean;
  /**
   * Pintasan ke workflow tindak lanjut, ditawarkan SETELAH temuan
   * tersimpan (tidak pernah menggantikan tombol simpan).
   */
  pintasanTindakLanjut?: { label: string; tujuan: 'TRANSAKSI' | 'RIWAYAT' };
}

/** Kalimat baku bagian Tindak Lanjut untuk penyebab yang disimpan sebagai temuan (DRAFT). */
const CATATAN_TEMUAN =
  'Temuan disimpan dengan status Belum Ditindaklanjuti — memilih penyebab belum menyelesaikan selisih. ' +
  'Periode belum dapat ditutup sampai rekonsiliasi ulang menunjukkan selisih ini sudah diselesaikan.';

/**
 * RC-S78 — TAKSONOMI PENYEBAB.
 *
 * Sebelumnya hanya ada 5 pilihan, dan dua di antaranya menyesatkan:
 * "Transaksi Belum Tercatat" & "Salah Pencatatan" hanya MENGARAHKAN
 * tanpa menyimpan penyebabnya (hilang dari audit trail), sementara
 * "Lainnya" menjadi jalur jurnal generik — termasuk dipakai untuk jasa
 * giro. Perbedaan waktu dan jasa giro sudah ada di service tetapi tidak
 * pernah muncul di layar, dan kesalahan pihak bank tidak punya kategori
 * sama sekali.
 *
 * Sekarang SETIAP penyebab tersimpan sebagai temuan, dan perlakuannya
 * ditentukan tabel di bawah — dicocokkan dengan `PERLAKUAN_SAH` di
 * service, yang menolak kombinasi ilegal walau layar salah.
 */
export const OPSI_PENYEBAB: readonly OpsiPenyebab[] = [
  {
    kode: 'BELUM_TERCATAT', label: 'Transaksi Belum Tercatat', tindakan: 'TEMUAN',
    penyebabService: 'TRANSAKSI_BELUM_TERCATAT', arah: 'KEDUANYA', rekening: 'SEMUA', wajibCatatan: true,
    deskripsi: 'Transaksi koperasi belum dicatat.',
    tindakLanjut: `Catat transaksi yang belum ada pada menu transaksi yang sesuai, lalu lakukan rekonsiliasi ulang. ${CATATAN_TEMUAN}`,
    ctaLabel: 'Simpan Temuan',
    selesai: false,
    pintasanTindakLanjut: { label: 'Buka Menu Transaksi', tujuan: 'TRANSAKSI' },
  },
  {
    kode: 'SALAH_PENCATATAN', label: 'Salah Pencatatan', tindakan: 'TEMUAN',
    penyebabService: 'SELISIH_PENCATATAN', arah: 'KEDUANYA', rekening: 'SEMUA', wajibCatatan: true,
    deskripsi: 'Sudah tercatat tetapi jumlah/rekening pencatatannya salah.',
    tindakLanjut: `Periksa transaksi sumber dan koreksi transaksi tersebut, lalu lakukan rekonsiliasi ulang. ${CATATAN_TEMUAN}`,
    ctaLabel: 'Simpan Temuan',
    selesai: false,
    pintasanTindakLanjut: { label: 'Buka Riwayat Transaksi', tujuan: 'RIWAYAT' },
  },
  {
    kode: 'PERBEDAAN_WAKTU', label: 'Perbedaan Waktu', tindakan: 'TEMUAN',
    penyebabService: 'TIMING_DIFFERENCE', arah: 'KEDUANYA', rekening: 'BANK', wajibCatatan: true,
    deskripsi: 'Perbedaan tanggal pembukuan, bukan kesalahan pencatatan.',
    tindakLanjut:
      'Selisih dicatat sebagai Selisih Dijelaskan dan langsung berstatus selesai, tanpa jurnal. ' +
      'Gunakan hanya bila perbedaan benar-benar berasal dari waktu pembukuan (mis. setoran dalam perjalanan).',
    ctaLabel: 'Tandai Sebagai Perbedaan Waktu',
    // Satu-satunya temuan yang boleh langsung SELESAI: penjelasannya
    // sudah lengkap, dan saldo memang akan tetap berbeda pada tanggal itu.
    selesai: true,
  },
  {
    kode: 'BIAYA_BANK', label: 'Biaya Bank / Administrasi', tindakan: 'PENYESUAIAN',
    penyebabService: 'BIAYA_ADMIN_BANK', arah: 'KURANG', rekening: 'BANK', wajibCatatan: true,
    deskripsi: 'Potongan bank yang belum dicatat.',
    tindakLanjut: 'Kopku mencatat jurnal penyesuaian beban biaya bank sebesar selisih. Cantumkan referensi rekening koran pada catatan.',
    ctaLabel: 'Catat Penyesuaian',
    selesai: true,
  },
  {
    kode: 'JASA_GIRO', label: 'Jasa Giro / Bunga Bank', tindakan: 'PENYESUAIAN',
    penyebabService: 'JASA_GIRO', arah: 'LEBIH', rekening: 'BANK', wajibCatatan: true,
    deskripsi: 'Jasa giro/bunga dari bank yang belum dicatat.',
    tindakLanjut: 'Kopku mencatat jurnal penyesuaian pendapatan jasa giro sebesar selisih. Cantumkan referensi bukti bank pada catatan.',
    ctaLabel: 'Catat Penyesuaian',
    selesai: true,
  },
  {
    kode: 'KESALAHAN_BANK', label: 'Kesalahan Bank', tindakan: 'TEMUAN',
    penyebabService: 'KESALAHAN_BANK', arah: 'KEDUANYA', rekening: 'BANK', wajibCatatan: true,
    deskripsi: 'Kesalahan pencatatan berasal dari pihak bank.',
    // Menjurnalnya berarti koperasi membukukan beban atas kekeliruan
    // yang bukan miliknya, hanya supaya saldo terlihat cocok.
    tindakLanjut: `Tidak ada jurnal koperasi. Ajukan koreksi kepada pihak bank, lalu lakukan rekonsiliasi ulang setelah rekening koran diperbaiki. ${CATATAN_TEMUAN}`,
    ctaLabel: 'Simpan Temuan',
    selesai: false,
  },
  {
    kode: 'SELISIH_KAS_FISIK', label: 'Selisih Kas Fisik', tindakan: 'PENYESUAIAN',
    penyebabService: 'SELISIH_FISIK', arah: 'KEDUANYA', rekening: 'KAS', wajibCatatan: true,
    deskripsi: 'Hasil kas opname berbeda dari saldo buku.',
    tindakLanjut: 'Pastikan hasil kas opname sudah diperiksa ulang. Kopku mencatat jurnal penyesuaian selisih kas sebesar selisih.',
    ctaLabel: 'Catat Penyesuaian',
    selesai: true,
  },
  {
    kode: 'LAINNYA', label: 'Penyebab Lain', tindakan: 'TEMUAN',
    penyebabService: 'LAINNYA', arah: 'KEDUANYA', rekening: 'SEMUA', wajibCatatan: true,
    deskripsi: 'Penyebab di luar kategori di atas.',
    // Exception, bukan pintu belakang: tidak ada AccountPicker dan tidak
    // pernah menghasilkan jurnal.
    tindakLanjut: `Tidak ada jurnal. Jelaskan penyebab dan rencana tindak lanjutnya pada catatan, lalu lakukan rekonsiliasi ulang setelah diselesaikan. ${CATATAN_TEMUAN}`,
    ctaLabel: 'Simpan Temuan',
    selesai: false,
  },
];

/** Pilihan penyebab yang masuk akal untuk arah selisih & jenis rekening ini. */
export function opsiPenyebabUntuk(selisih: number, jenis: JenisRekeningRekon): OpsiPenyebab[] {
  const st = statusSelisih(selisih);
  if (st === 'COCOK') return [];
  const isBank = jenis === 'BANK';
  return OPSI_PENYEBAB.filter(
    (o) =>
      (o.arah === 'KEDUANYA' || o.arah === st) &&
      (o.rekening === 'SEMUA' || (o.rekening === 'BANK' ? isBank : !isBank))
  );
}

/** Kategori akun penyesuaian: selisih kurang → Beban, selisih lebih → Pendapatan. */
export function kategoriAkunPenyesuaian(selisih: number): 'BEBAN' | 'PENDAPATAN' {
  return selisih < 0 ? 'BEBAN' : 'PENDAPATAN';
}

export interface IsianTindakLanjut {
  opsi: OpsiPenyebab | null;
  akun: { id: string; kategori: string } | null;
  catatan: string;
}

/**
 * Susun tindak lanjut untuk service. Mengembalikan:
 *  - `{ ok: true, tindakLanjut }` → simpan pemeriksaan + tindak lanjut (atomik);
 *  - `{ ok: true, tindakLanjut: undefined }` → simpan pemeriksaan saja (ARAHKAN);
 *  - `{ ok: false, galat }` → isian belum lengkap.
 */
export function susunTindakLanjut(
  selisih: number,
  i: IsianTindakLanjut
): { ok: true; tindakLanjut?: TindakLanjutSelisihInput } | { ok: false; galat: string } {
  if (selisih === 0) return { ok: true };
  if (!i.opsi) return { ok: false, galat: 'Pilih penyebab selisih.' };
  const catatan = i.catatan.trim();
  // RC-S78: catatan WAJIB untuk semua penyebab. Baris SELESAI tanpa
  // penjelasan tidak berguna bagi pemeriksa berikutnya, dan service
  // menolaknya juga.
  if (i.opsi.wajibCatatan && !catatan) return { ok: false, galat: 'Jelaskan penyebab selisih pada catatan.' };

  // TEMUAN = tanpa jurnal. Penyebabnya TETAP disimpan (dulu jalur
  // "ARAHKAN" membuangnya), jadi audit trail tidak kehilangan apa pun.
  if (i.opsi.tindakan === 'TEMUAN') {
    return {
      ok: true,
      tindakLanjut: {
        penyebab: i.opsi.penyebabService,
        perlakuan: 'TIDAK_PERLU_JURNAL',
        catatan,
      },
    };
  }

  const perlakuan: PerlakuanSelisih = 'PERLU_JURNAL';
  if (!i.akun) return { ok: false, galat: 'Pilih akun pencatatan terlebih dahulu.' };
  if (i.akun.kategori !== kategoriAkunPenyesuaian(selisih)) {
    return { ok: false, galat: selisih < 0 ? 'Pilih akun Beban untuk selisih kurang.' : 'Pilih akun Pendapatan untuk selisih lebih.' };
  }
  return {
    ok: true,
    tindakLanjut: { penyebab: i.opsi.penyebabService, perlakuan, akunLawanId: i.akun.id, catatan },
  };
}

/** Status rekonsiliasi untuk riwayat — bahasa pengguna, bukan enum internal. */
/**
 * RC-S79 §2E — label penyebab untuk RIWAYAT, dari nilai database.
 *
 * Riwayat sebelumnya hanya menampilkan angka + status, sehingga
 * pemeriksa berikutnya tidak bisa tahu MENGAPA ada selisih tanpa
 * membuka ulang pemeriksaannya. Enum database diterjemahkan di sini
 * supaya `TIMING_DIFFERENCE` tidak pernah bocor ke layar.
 */
export const LABEL_PENYEBAB_RIWAYAT: Record<PenyebabSelisih, string> = {
  TRANSAKSI_BELUM_TERCATAT: 'Transaksi Belum Tercatat',
  SELISIH_PENCATATAN: 'Salah Pencatatan',
  TIMING_DIFFERENCE: 'Perbedaan Waktu',
  BIAYA_ADMIN_BANK: 'Biaya Bank',
  JASA_GIRO: 'Jasa Giro',
  KESALAHAN_BANK: 'Kesalahan Bank',
  SELISIH_FISIK: 'Selisih Kas Fisik',
  LAINNYA: 'Penyebab Lain',
};

/** Label penyebab satu baris riwayat; null bila memang belum ada penyebab (mis. COCOK). */
export function labelPenyebabRiwayat(penyebab: PenyebabSelisih | null | undefined): string | null {
  return penyebab ? (LABEL_PENYEBAB_RIWAYAT[penyebab] ?? null) : null;
}

export type NadaStatus = 'OK' | 'INFO' | 'WARN';

export interface BarisStatusRiwayat {
  status: 'COCOK' | 'SELISIH';
  statusPenyelesaian: 'DRAFT' | 'SELESAI';
  journalId: string | null;
  penyebab?: PenyebabSelisih | null;
}

/**
 * Penyebab + Status Penyelesaian untuk SATU baris riwayat — dibaca apa
 * adanya dari kolom database (`status`, `status_penyelesaian`,
 * `journal_id`, `penyebab`); tidak ada nilai yang diubah atau ditebak.
 *
 *   COCOK                         -> "Cocok"
 *   SELISIH + DRAFT               -> "Belum Ditindaklanjuti"  (temuan)
 *   SELISIH + SELESAI + jurnal    -> "Penyesuaian Tercatat"
 *   SELISIH + SELESAI tanpa jurnal-> "Selisih Dijelaskan"     (mis. perbedaan waktu)
 *
 * Label "Penyesuaian Tercatat" HANYA muncul bila jurnalnya benar-benar
 * ada, jadi temuan tanpa jurnal tidak pernah tampil seolah sudah
 * disesuaikan.
 */
export function statusRiwayat(r: BarisStatusRiwayat): { penyebab: string; status: string; nada: NadaStatus } {
  if (r.status === 'COCOK') return { penyebab: 'Tidak ada selisih', status: 'Cocok', nada: 'OK' };
  const penyebab = labelPenyebabRiwayat(r.penyebab) ?? 'Belum ditentukan';
  if (r.statusPenyelesaian === 'SELESAI') {
    return r.journalId
      ? { penyebab, status: 'Penyesuaian Tercatat', nada: 'OK' }
      : { penyebab, status: 'Selisih Dijelaskan', nada: 'INFO' };
  }
  return { penyebab, status: 'Belum Ditindaklanjuti', nada: 'WARN' };
}

export function labelStatusRiwayat(r: BarisStatusRiwayat): string {
  return statusRiwayat(r).status;
}

export type JenisHasilSimpan = 'COCOK' | 'PENYESUAIAN' | 'TEMUAN' | 'DIJELASKAN';

/** Jenis kartu hasil setelah simpan — mengikuti baris yang DIKEMBALIKAN service, bukan pilihan di layar. */
export function jenisHasilSimpan(h: BarisStatusRiwayat): JenisHasilSimpan {
  if (h.status === 'COCOK') return 'COCOK';
  if (h.statusPenyelesaian === 'DRAFT') return 'TEMUAN';
  return h.journalId ? 'PENYESUAIAN' : 'DIJELASKAN';
}

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** '2026-08-31' → '31 Agustus 2026' (tampilan). */
export function formatTanggalPanjang(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return iso;
  return `${parseInt(m[3], 10)} ${BULAN[parseInt(m[2], 10) - 1] ?? m[2]} ${m[1]}`;
}

/** Selisih ringkas bertanda untuk kolom riwayat: "−Rp200.000" / "Rp200.000" / "Rp0". */
export function selisihRingkas(selisih: number, format: (n: number) => string): string {
  return selisih < 0 ? `−${format(-selisih)}` : format(selisih);
}

/** Kunci submit sinkron (tap cepat berulang → satu pemanggilan). Dilepas setelah selesai. */
export function buatKunciSubmit() {
  let berjalan = false;
  return {
    get sibuk(): boolean {
      return berjalan;
    },
    async jalankan<T>(fn: () => Promise<T>): Promise<{ status: 'OK'; hasil: T } | { status: 'DIABAIKAN' }> {
      if (berjalan) return { status: 'DIABAIKAN' };
      berjalan = true;
      try {
        return { status: 'OK', hasil: await fn() };
      } finally {
        berjalan = false;
      }
    },
  };
}

// ------------------------------------------------------------------
// RC-S67.9.2 — CTA utama sebagai fungsi murni (dapat diuji tanpa render)
// ------------------------------------------------------------------

export type AksiCta = 'SIMPAN' | 'NONE';
export interface CtaRekonsiliasi {
  label: string;
  aktif: boolean;
  aksi: AksiCta;
  /** Selalu diisi saat CTA nonaktif — pengguna selalu tahu apa yang kurang. */
  pesan?: string;
}

export function ctaRekonsiliasi(p: {
  siap: boolean;
  selisih: number | null;
  opsi: OpsiPenyebab | null;
  akun: { id: string; kategori: string } | null;
  catatan: string;
}): CtaRekonsiliasi {
  if (!p.siap || p.selisih === null) {
    return { label: 'Simpan Rekonsiliasi', aktif: false, aksi: 'NONE', pesan: 'Lengkapi data rekonsiliasi terlebih dahulu.' };
  }
  if (p.selisih === 0) return { label: 'Simpan Rekonsiliasi', aktif: true, aksi: 'SIMPAN' };
  if (!p.opsi) return { label: 'Pilih Penyebab', aktif: false, aksi: 'NONE', pesan: 'Pilih penyebab selisih di atas.' };
  // RC-S78 — label CTA berasal dari taksonomi (§10), bukan ditebak di
  // sini. Tombol utama SELALU hanya menyimpan: temuan cukup "Simpan
  // Temuan". Pintasan ke Transaksi / Riwayat baru ditawarkan pada kartu
  // hasil SETELAH temuan tersimpan, sehingga penyebab tidak pernah hilang
  // karena berpindah layar.
  const t = susunTindakLanjut(p.selisih, { opsi: p.opsi, akun: p.akun, catatan: p.catatan });
  if (!t.ok) return { label: p.opsi.ctaLabel, aktif: false, aksi: 'NONE', pesan: t.galat };
  return { label: p.opsi.ctaLabel, aktif: true, aksi: 'SIMPAN' };
}

/** Bagian "Pilih Akun Pencatatan" tampil TERBUKA untuk setiap penyebab yang membutuhkan penyesuaian. */
export function perluPilihAkun(opsi: OpsiPenyebab | null): boolean {
  return opsi?.tindakan === 'PENYESUAIAN';
}

/**
 * Ringkasan akibat memilih suatu penyebab — dipakai chip pada daftar
 * penyebab dan baris "Status setelah disimpan" di bagian Tindak Lanjut.
 * Diturunkan dari `tindakan` + `selesai` pada taksonomi, yang konsistensinya
 * dengan `PERLAKUAN_SAH` & `PENYEBAB_SELESAI_SEKETIKA` di service diuji.
 */
export function akibatPenyebab(o: OpsiPenyebab): { tag: string; statusSetelahSimpan: string; nada: NadaStatus } {
  if (o.tindakan === 'PENYESUAIAN') {
    return { tag: 'Jurnal penyesuaian', statusSetelahSimpan: 'Penyesuaian Tercatat', nada: 'OK' };
  }
  if (o.selesai) return { tag: 'Tanpa jurnal · Selesai', statusSetelahSimpan: 'Selisih Dijelaskan', nada: 'INFO' };
  return { tag: 'Temuan · Perlu tindak lanjut', statusSetelahSimpan: 'Belum Ditindaklanjuti', nada: 'WARN' };
}
