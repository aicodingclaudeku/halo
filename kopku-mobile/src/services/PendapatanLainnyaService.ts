import { getDb } from '@/database/db';
import {
  catatPemasukan,
  koreksiTransaksiKasBank,
  type JenisRekening,
} from '@/services/KasBankService';
import { getLedger, LedgerLine } from '@/accounting/Ledger';
import type { LhuKlasifikasi } from '@/config/defaultCOA';
import { Rupiah } from '@/utils/money';
import {
  AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED,
  KEBIJAKAN_PENDAPATAN_INVESTASI,
  isKategoriPendapatanInvestasi,
  periksaAkunKategoriPendapatanInvestasi,
  AKUN_WAJIB_PENDAPATAN_BUNGA,
  type KategoriPendapatanInvestasi,
} from '@/config/pendapatanKoperasiPolicy';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * Menu "Pendapatan Lainnya" (Revisi LHU KOPKU, Bagian B-E). Tempat
 * TRANSAKSI pendapatan yang akunnya berasal dari COA existing.
 *
 * SENGAJA TIDAK membuat tabel/service transaksi baru (Bagian AK:
 * "cek apakah sudah ada, jika sudah ada perluas/reuse") — memakai
 * `KasBankService.catatPemasukan`/`kas_transaksi`/`bank_transaksi`
 * yang SUDAH ADA (jurnal DEBIT Kas/Bank, KREDIT akun pendapatan
 * terpilih — persis Bagian L), hanya ditambah lapisan validasi:
 * akun WAJIB kategori PENDAPATAN & sudah punya klasifikasi LHU
 * (Bagian AA). Klasifikasi LHU sendiri TIDAK disimpan per-transaksi —
 * selalu dibaca LIVE dari `account.lhu_klasifikasi` saat ditampilkan
 * (Bagian G: "sistem mencari account_id -> membaca klasifikasi LHU
 * akun -> otomatis") supaya kalau admin mengubah mapping klasifikasi
 * suatu akun, riwayat lama ikut menampilkan klasifikasi TERKINI —
 * konsisten dengan Bagian M ("klasifikasi tidak mengubah jurnal",
 * hanya penyajian).
 */

export interface AkunPendapatanLainnyaOption {
  accountId: string;
  kode: string;
  nama: string;
  klasifikasiLhu: LhuKlasifikasi | null;
}

export interface TambahTransaksiPendapatanInput {
  tanggal: string;
  accountId: string;
  nominal: Rupiah;
  jenis: JenisRekening;
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
  /**
   * RC-S67 — OPSIONAL, diteruskan apa adanya ke `catatPemasukan`.
   * Tanpa kedua field ini perilaku fungsi PERSIS seperti sebelumnya.
   * `kategori` = label tampilan baris kas/bank; `idempotencyKey` =
   * identitas SUBMIT (mekanisme BUG-07 yang sudah ada).
   */
  kategori?: string;
  idempotencyKey?: string;
}

async function pastikanAkunPendapatanValid(accountId: string): Promise<{ kode: string; nama: string; klasifikasi: LhuKlasifikasi | null }> {
  const db = await getDb();
  const acc = await db.getFirstAsync<{ kode: string; nama: string; kategori: string; is_active: number; is_system: number; lhu_klasifikasi: string | null }>(
    `SELECT kode, nama, kategori, is_active, is_system, lhu_klasifikasi FROM account WHERE id = ?`,
    accountId
  );
  if (!acc) throw new Error('Akun pendapatan tidak ditemukan.');
  if (acc.kategori !== 'PENDAPATAN') {
    throw new Error('Akun yang dipilih bukan akun Pendapatan.');
  }
  if (!acc.is_active) {
    throw new Error('Akun ini sudah dinonaktifkan dan tidak dapat dipakai transaksi baru.');
  }
  if (!acc.lhu_klasifikasi) {
    // Bagian AA: pesan PERSIS yang diminta.
    throw new Error('Akun ini belum diklasifikasikan untuk LHU.');
  }
  return { kode: acc.kode, nama: acc.nama, klasifikasi: acc.lhu_klasifikasi as LhuKlasifikasi };
}

/**
 * Dropdown "Akun Pendapatan (COA)" (Bagian E) — HANYA akun PENDAPATAN
 * yang sudah punya klasifikasi LHU (siap dipakai transaksi tanpa
 * ditolak). Akun PENDAPATAN yang belum diklasifikasikan TETAP tidak
 * tersembunyi dari Input Akun/Pengaturan (admin masih bisa
 * mengklasifikasikannya di sana), hanya tidak muncul di dropdown
 * transaksi ini sampai diklasifikasikan — mencegah user memilih akun
 * lalu ditolak saat submit (Bagian AA divalidasi ulang di
 * `tambahTransaksiPendapatan` sebagai lapis kedua yang sesungguhnya).
 */
export async function listAkunPendapatanLainnya(): Promise<AkunPendapatanLainnyaOption[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; kode: string; nama: string; lhu_klasifikasi: string | null }>(
    `SELECT id, kode, nama, lhu_klasifikasi FROM account
     WHERE kategori = 'PENDAPATAN' AND is_active = 1 AND is_system = 0
     ORDER BY kode ASC`
  );
  // Akun yang punya menu dedicated (4-1400 Pendapatan Unit Usaha) TIDAK
  // ditawarkan di dropdown generik: satu akun, satu entry point.
  return rows
    .filter((r) => !AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED.includes(r.kode))
    .map((r) => ({
      accountId: r.id,
      kode: r.kode,
      nama: r.nama,
      klasifikasiLhu: (r.lhu_klasifikasi as LhuKlasifikasi | null) ?? null,
    }));
}

/**
 * Tambah Transaksi Pendapatan (Bagian D/L) — Dr Kas/Bank, Cr Akun
 * Pendapatan COA. Klasifikasi otomatis (Bagian G), TIDAK diminta
 * ulang dari user.
 */
export async function tambahTransaksiPendapatan(
  input: TambahTransaksiPendapatanInput
): Promise<{ id: string; journalId: string; klasifikasiLhu: LhuKlasifikasi }> {
  const { kode, klasifikasi } = await pastikanAkunPendapatanValid(input.accountId);
  // Penolakan di SERVICE, bukan hanya disembunyikan di UI:
  // pemanggil yang mem-bypass dropdown tetap tidak dapat memposting 4-1400
  // lewat jalur generik. Koreksi/reversal transaksi lama TIDAK terdampak
  // (`koreksiTransaksiPendapatan` tidak melewati fungsi ini).
  if (AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED.includes(kode)) {
    throw new Error(`Akun ${kode} hanya dapat dicatat melalui menu Pendapatan Unit Usaha.`);
  }

  const { id, journalId } = await catatPemasukan({
    jenis: input.jenis,
    bankAccountId: input.bankAccountId,
    tanggal: input.tanggal,
    nominal: input.nominal,
    akunLawanId: input.accountId,
    kategori: input.kategori,
    keterangan: input.keterangan,
    createdBy: input.createdBy,
    idempotencyKey: input.idempotencyKey,
  });

  return { id, journalId, klasifikasiLhu: klasifikasi as LhuKlasifikasi };
}

export interface TransaksiPendapatanRow {
  id: string;
  jenis: JenisRekening;
  rekeningNama: string;
  tanggal: string;
  nominal: Rupiah;
  accountId: string;
  akunKode: string;
  akunNama: string;
  klasifikasiLhu: LhuKlasifikasi | null;
  kasBank: string;
  keterangan: string | null;
  /** RC-S67 — label kategori baris kas/bank (NULL untuk transaksi dari form generik). */
  kategori: string | null;
  nomorTransaksi: string;
  status: 'AKTIF' | 'KOREKSI' | 'DIKOREKSI';
  journalId: string | null;
}

export interface FilterTransaksiPendapatan {
  tanggalMulai?: string;
  tanggalSelesai?: string;
  search?: string;
}

/**
 * Daftar/Riwayat Pendapatan (Bagian C/Y) — SATU query dipakai untuk
 * kedua entri menu ("Daftar Pendapatan" & "Riwayat Pendapatan"),
 * sesuai Bagian C: "jangan membuat tabel duplikat jika tabel transaksi
 * pendapatan sudah tersedia". Sumber data = `kas_transaksi` +
 * `bank_transaksi` tipe PENERIMAAN dengan akun lawan kategori
 * PENDAPATAN & bukan akun sistem pinjaman — TABEL YANG SAMA dipakai
 * `KasBankService.listRiwayatTransaksi`, hanya di-filter lebih
 * spesifik di sini (bukan tabel baru).
 */
export async function listTransaksiPendapatan(filter: FilterTransaksiPendapatan = {}): Promise<TransaksiPendapatanRow[]> {
  const db = await getDb();
  const params: (string | number)[] = [];
  let tanggalFilter = '';
  if (filter.tanggalMulai) {
    tanggalFilter += ' AND t.tanggal >= ?';
    params.push(filter.tanggalMulai);
  }
  if (filter.tanggalSelesai) {
    tanggalFilter += ' AND t.tanggal <= ?';
    params.push(filter.tanggalSelesai);
  }

  const kasRows = await db.getAllAsync<any>(
    `SELECT t.id, t.tanggal, t.nominal, t.akun_lawan_id, t.keterangan, t.kategori, t.nomor_transaksi,
            t.journal_id, t.tipe, t.reversal_of_id,
            a.kode as akun_kode, a.nama as akun_nama, a.lhu_klasifikasi
     FROM kas_transaksi t
     JOIN account a ON a.id = t.akun_lawan_id
     WHERE t.tipe IN ('PENERIMAAN','KOREKSI') AND a.kategori = 'PENDAPATAN' AND a.is_system = 0 ${tanggalFilter}
     ORDER BY t.tanggal DESC, t.created_at DESC`,
    ...params
  );
  const bankRows = await db.getAllAsync<any>(
    `SELECT t.id, t.tanggal, t.nominal, t.akun_lawan_id, t.keterangan, t.kategori, t.nomor_transaksi,
            t.journal_id, t.tipe, t.reversal_of_id,
            a.kode as akun_kode, a.nama as akun_nama, a.lhu_klasifikasi,
            ba.nama_bank, ba.nomor_rekening
     FROM bank_transaksi t
     JOIN account a ON a.id = t.akun_lawan_id
     JOIN bank_account ba ON ba.id = t.bank_account_id
     WHERE t.tipe IN ('PENERIMAAN','KOREKSI') AND a.kategori = 'PENDAPATAN' AND a.is_system = 0 ${tanggalFilter}
     ORDER BY t.tanggal DESC, t.created_at DESC`,
    ...params
  );

  // Status: sebuah transaksi berstatus DIKOREKSI kalau ada baris
  // KOREKSI lain yang me-reversal-nya (reversal_of_id merujuk id ini) —
  // dicek lintas kas & bank sekaligus (koreksi selalu jenis yang sama,
  // tapi tetap aman kalau tidak).
  const semuaReversalOf = new Set<string>(
    [...kasRows, ...bankRows].map((r) => r.reversal_of_id).filter((x): x is string => !!x)
  );

  const rows: TransaksiPendapatanRow[] = [];
  for (const r of kasRows) {
    if (r.tipe === 'KOREKSI') continue; // baris koreksi tidak ditampilkan sebagai transaksi pendapatan tersendiri
    rows.push({
      id: r.id,
      jenis: 'KAS',
      rekeningNama: 'Kas Tunai',
      tanggal: r.tanggal,
      nominal: r.nominal,
      accountId: r.akun_lawan_id,
      akunKode: r.akun_kode,
      akunNama: r.akun_nama,
      klasifikasiLhu: (r.lhu_klasifikasi as LhuKlasifikasi | null) ?? null,
      kasBank: 'Kas',
      keterangan: r.keterangan,
      kategori: r.kategori ?? null,
      nomorTransaksi: r.nomor_transaksi,
      status: semuaReversalOf.has(r.id) ? 'DIKOREKSI' : 'AKTIF',
      journalId: r.journal_id,
    });
  }
  for (const r of bankRows) {
    if (r.tipe === 'KOREKSI') continue;
    rows.push({
      id: r.id,
      jenis: 'BANK',
      rekeningNama: `${r.nama_bank} — ${r.nomor_rekening}`,
      tanggal: r.tanggal,
      nominal: r.nominal,
      accountId: r.akun_lawan_id,
      akunKode: r.akun_kode,
      akunNama: r.akun_nama,
      klasifikasiLhu: (r.lhu_klasifikasi as LhuKlasifikasi | null) ?? null,
      kasBank: `${r.nama_bank} — ${r.nomor_rekening}`,
      keterangan: r.keterangan,
      kategori: r.kategori ?? null,
      nomorTransaksi: r.nomor_transaksi,
      status: semuaReversalOf.has(r.id) ? 'DIKOREKSI' : 'AKTIF',
      journalId: r.journal_id,
    });
  }

  let hasil = rows.sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1));
  if (filter.search) {
    const q = filter.search.toLowerCase();
    hasil = hasil.filter(
      (r) =>
        r.akunNama.toLowerCase().includes(q) ||
        (r.keterangan ?? '').toLowerCase().includes(q) ||
        r.nomorTransaksi.toLowerCase().includes(q)
    );
  }
  return hasil;
}

/**
 * Koreksi/batalkan transaksi pendapatan (Bagian Z: "gunakan mekanisme
 * reversal existing, jangan menghapus jurnal secara langsung") — MURNI
 * delegasi ke `KasBankService.koreksiTransaksiKasBank` yang sudah ada
 * (menghasilkan audit trail lewat reversal), dengan satu lapis
 * verifikasi tambahan supaya endpoint ini hanya dipakai untuk
 * transaksi pendapatan (bukan jenis transaksi kas/bank lain).
 */
export async function koreksiTransaksiPendapatan(
  jenis: JenisRekening,
  id: string,
  userId: string,
  alasan: string
): Promise<{ id: string }> {
  const db = await getDb();
  const tabel = jenis === 'BANK' ? 'bank_transaksi' : 'kas_transaksi';
  const original = await db.getFirstAsync<{ akun_lawan_id: string | null }>(
    `SELECT akun_lawan_id FROM ${tabel} WHERE id = ?`,
    id
  );
  if (!original?.akun_lawan_id) throw new Error('Transaksi tidak ditemukan.');
  const akun = await db.getFirstAsync<{ kategori: string }>(`SELECT kategori FROM account WHERE id = ?`, original.akun_lawan_id);
  if (akun?.kategori !== 'PENDAPATAN') {
    throw new Error('Transaksi ini bukan transaksi Pendapatan Lainnya.');
  }
  return koreksiTransaksiKasBank(jenis, id, userId, alasan);
}

// ============================================================
// Revisi "Daftar Pendapatan" (audit menu Daftar Pendapatan) — tampilan
// UTAMA menu ini sekarang akun nominal + saldo per kelompok LHU
// (PENDAPATAN_USAHA_LAIN / HASIL_INVESTASI / PENDAPATAN_LAIN), BUKAN
// lagi daftar transaksi individual (itu tetap ada, dipindah ke
// "Riwayat Pendapatan" — `listTransaksiPendapatan` di atas TIDAK
// dihapus/diubah, tetap dipakai untuk detail/history/koreksi/audit).
//
// "Pendapatan Jasa Pinjaman" (4-1000) SENGAJA dikecualikan dari fungsi
// ini — pendapatan UTAMA koperasi, baris tersendiri di Laba
// Rugi/LHU (lihat FinancialReports.getLHU, KODE_PENDAPATAN_JASA_PINJAMAN),
// BUKAN bagian dari 3 kelompok Daftar Pendapatan ini (Bagian 14 —
// "jangan mengubah mekanisme Pendapatan Jasa Pinjaman").
// ============================================================

const KODE_PENDAPATAN_JASA_PINJAMAN = '4-1000';

export interface AkunPendapatanNominalRow {
  accountId: string;
  kode: string;
  nama: string;
  /** Saldo/nominal akun ini pada periode yang diminta — dari LEDGER (lihat komentar di bawah), boleh negatif (mis. banyak koreksi/reversal), TIDAK dibungkus Math.max/abs. */
  nominal: Rupiah;
}

export interface PendapatanByClassificationResult {
  tanggalMulai: string;
  tanggalSelesai: string;
  pendapatanUsahaLain: AkunPendapatanNominalRow[];
  totalPendapatanUsahaLain: Rupiah;
  hasilInvestasi: AkunPendapatanNominalRow[];
  totalHasilInvestasi: Rupiah;
  pendapatanLain: AkunPendapatanNominalRow[];
  totalPendapatanLain: Rupiah;
  /** = totalPendapatanUsahaLain + totalHasilInvestasi + totalPendapatanLain (Bagian 8) — TIDAK termasuk belumDiklasifikasikan atau Pendapatan Jasa Pinjaman. */
  totalPendapatan: Rupiah;
  /**
   * Akun kategori PENDAPATAN (selain Jasa Pinjaman) yang AKTIF tapi
   * BELUM punya lhu_klasifikasi salah satu dari 3 kelompok di atas
   * (Bagian 13) — SENGAJA tidak dimasukkan otomatis ke kelompok mana
   * pun (beda dari FinancialReports.getLHU yang men-default akun
   * semacam ini ke Pendapatan Lain demi tetap rekonsiliasi dengan
   * getLabaRugi — LHU TIDAK diubah oleh revisi ini). Kalau array ini
   * berisi akun dengan saldo != 0, `totalPendapatan` di atas TIDAK
   * akan sama dengan total pendapatan-lain versi LHU untuk periode
   * yang sama sampai admin mengklasifikasikan akun tsb — inilah
   * peringatan yang memang diminta (Bagian 13: "agar administrator
   * dapat mengetahui adanya COA pendapatan yang belum dipetakan").
   */
  belumDiklasifikasikan: AkunPendapatanNominalRow[];
  totalBelumDiklasifikasikan: Rupiah;
}

function sumNominal(rows: AkunPendapatanNominalRow[]): Rupiah {
  return rows.reduce((s, r) => s + r.nominal, 0);
}

/**
 * Ringkasan akun nominal Pendapatan dikelompokkan per klasifikasi LHU,
 * untuk satu periode — dipakai layar "Daftar Pendapatan" (Revisi
 * Bagian 1/7/8/21).
 *
 * REUSE PENUH `Ledger.getLedger()` existing (Bagian 6/7/16/12: "gunakan
 * mekanisme ledger/accounting engine yang sudah ada", "jangan membuat
 * perhitungan terpisah yang menyebabkan perbedaan dengan Buku Besar")
 * — nominal setiap akun dihitung dari saldo berjalan TERAKHIR yang
 * dikembalikan `getLedger(db, accountId, {tanggalMulai, tanggalSelesai})`,
 * PERSIS query/status (POSTED+REVERSED) yang sama dipakai Buku Besar,
 * Neraca Saldo, & Laba Rugi/LHU — BUKAN query/rumus baru yang bisa
 * menyimpang. Akun TANPA transaksi pada periode ini tetap tampil
 * dengan nominal Rp0 (Bagian 4/8/21 — SENGAJA TIDAK di-skip seperti
 * `getLabaRugi()`, karena di sana akun tanpa mutasi memang tidak perlu
 * tampil di Laba Rugi, tapi di Daftar Pendapatan akun nominal WAJIB
 * selalu terlihat).
 */
export async function getPendapatanByClassification(
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<PendapatanByClassificationResult> {
  const db = await getDb();

  // Akun aktif kategori PENDAPATAN, KECUALI Pendapatan Jasa Pinjaman
  // (lihat komentar di atas). is_active=1 SENGAJA dipakai di sini
  // (beda dari getTrialBalance yang menyertakan akun nonaktif) —
  // Bagian 12: "akun nonaktif jangan ditampilkan pada daftar akun
  // pendapatan AKTIF", histori transaksinya sendiri tetap aman/utuh di
  // ledger (tidak dihapus), hanya tidak muncul sebagai baris aktif di
  // layar ringkasan ini.
  const accounts = await db.getAllAsync<{ id: string; kode: string; nama: string; lhu_klasifikasi: string | null }>(
    `SELECT id, kode, nama, lhu_klasifikasi FROM account
     WHERE kategori = 'PENDAPATAN' AND is_active = 1 AND kode != ?
     ORDER BY kode ASC`,
    KODE_PENDAPATAN_JASA_PINJAMAN
  );

  const pendapatanUsahaLain: AkunPendapatanNominalRow[] = [];
  const hasilInvestasi: AkunPendapatanNominalRow[] = [];
  const pendapatanLain: AkunPendapatanNominalRow[] = [];
  const belumDiklasifikasikan: AkunPendapatanNominalRow[] = [];

  for (const acc of accounts) {
    const lines = await getLedger(db, acc.id, { tanggalMulai, tanggalSelesai });
    const nominal = lines.length > 0 ? lines[lines.length - 1].saldoBerjalan : 0;
    const row: AkunPendapatanNominalRow = { accountId: acc.id, kode: acc.kode, nama: acc.nama, nominal };

    if (acc.lhu_klasifikasi === 'PENDAPATAN_USAHA_LAIN') pendapatanUsahaLain.push(row);
    else if (acc.lhu_klasifikasi === 'HASIL_INVESTASI') hasilInvestasi.push(row);
    else if (acc.lhu_klasifikasi === 'PENDAPATAN_LAIN') pendapatanLain.push(row);
    else belumDiklasifikasikan.push(row);
  }

  const totalPendapatanUsahaLain = sumNominal(pendapatanUsahaLain);
  const totalHasilInvestasi = sumNominal(hasilInvestasi);
  const totalPendapatanLain = sumNominal(pendapatanLain);
  const totalBelumDiklasifikasikan = sumNominal(belumDiklasifikasikan);

  return {
    tanggalMulai,
    tanggalSelesai,
    pendapatanUsahaLain,
    totalPendapatanUsahaLain,
    hasilInvestasi,
    totalHasilInvestasi,
    pendapatanLain,
    totalPendapatanLain,
    totalPendapatan: totalPendapatanUsahaLain + totalHasilInvestasi + totalPendapatanLain,
    belumDiklasifikasikan,
    totalBelumDiklasifikasikan,
  };
}

export interface PendapatanAkunDetail {
  accountId: string;
  kode: string;
  nama: string;
  saldoPeriode: Rupiah;
  transaksi: LedgerLine[];
}

/**
 * Detail satu akun nominal Pendapatan (Bagian 10) — dibuka saat user
 * menekan salah satu baris di Daftar Pendapatan. REUSE `getLedger()`
 * apa adanya (Bagian 10: "Detail harus berasal dari jurnal/ledger
 * existing. Jangan membuat tabel transaksi baru.") — TIDAK ada tabel
 * atau query transaksi baru sama sekali di sini.
 */
export async function getPendapatanAkunDetail(
  accountId: string,
  tanggalMulai: string,
  tanggalSelesai: string
): Promise<PendapatanAkunDetail> {
  const db = await getDb();
  const acc = await db.getFirstAsync<{ kode: string; nama: string; kategori: string }>(
    `SELECT kode, nama, kategori FROM account WHERE id = ?`,
    accountId
  );
  if (!acc) throw new Error('Akun pendapatan tidak ditemukan.');
  if (acc.kategori !== 'PENDAPATAN') throw new Error('Akun yang dipilih bukan akun Pendapatan.');

  const transaksi = await getLedger(db, accountId, { tanggalMulai, tanggalSelesai });
  const saldoPeriode = transaksi.length > 0 ? transaksi[transaksi.length - 1].saldoBerjalan : 0;

  return { accountId, kode: acc.kode, nama: acc.nama, saldoPeriode, transaksi };
}

// ============================================================
// RC-S67 — PENDAPATAN INVESTASI BERSUMBER
// (menu canonical Pendapatan Koperasi: Usaha Lain · Bunga,
//  Deposito Berjangka · Bunga, Properti Investasi · Sewa)
//
// BUKAN jalur akuntansi baru. Setelah sumber divalidasi, fungsi ini
// MENDELEGASIKAN ke `tambahTransaksiPendapatan` -> `catatPemasukan` ->
// `createJournal` — jalur canonical yang sama dengan form generik:
//   Dr Kas/Bank   nominal
//      Cr akun pendapatan (dari KEBIJAKAN_PENDAPATAN_INVESTASI)  nominal
// sehingga PeriodClose (resolvePeriod), audit log (createJournal &
// koreksi), reversal (`koreksiTransaksiPendapatan`) dan idempotensi
// (`idempotencyKey`, indeks UNIQUE BUG-07) seluruhnya MEWARISI mekanisme
// existing — tidak ada mekanisme kedua.
//
// BATAS YANG DISADARI: tabel kas/bank tidak punya kolom `investasi_id`.
// Tautan ke investasi disimpan sebagai REFERENSI TEKS yang diturunkan
// dari master (`nomor_investasi` · `nama_tujuan`) pada `keterangan` dan
// deskripsi jurnal, serta label pada `kategori`. Ini BUKAN foreign key;
// tautan permanen memerlukan migrasi dan keputusan tersendiri.
// ============================================================

export type KodePenolakanPendapatanInvestasi =
  | 'KATEGORI_TIDAK_DIKENAL'
  | 'NOMINAL_TIDAK_VALID'
  | 'TANGGAL_TIDAK_VALID'
  | 'TANGGAL_MASA_DEPAN'
  | 'INVESTASI_WAJIB'
  | 'INVESTASI_TIDAK_DITEMUKAN'
  | 'JENIS_INVESTASI_TIDAK_SESUAI'
  | 'INVESTASI_TIDAK_AKTIF'
  | 'TANGGAL_SEBELUM_INVESTASI'
  | 'REKENING_WAJIB'
  | 'COA_MISSING'
  | 'AKUN_TIDAK_SESUAI'
  | 'DOKUMEN_WAJIB'
  | 'DOKUMEN_TIDAK_VALID'
  | 'DUPLIKAT_DOKUMEN';

export class PendapatanInvestasiDitolakError extends Error {
  constructor(readonly kode: KodePenolakanPendapatanInvestasi, pesan: string) {
    super(pesan);
    this.name = 'PendapatanInvestasiDitolakError';
  }
}

export interface InfoPendapatanInvestasi {
  kategori: KategoriPendapatanInvestasi;
  label: string;
  jenisInvestasi: string;
  akunKode: string;
  sumberKebijakan: string;
  /** RC-S67.6 — nomor dokumen wajib (identity bisnis). */
  wajibDokumen: boolean;
  /** NULL bila akun tidak dapat dipakai — lihat `masalah`. */
  akun: { accountId: string; kode: string; nama: string; klasifikasiLhu: LhuKlasifikasi } | null;
  /** Pesan untuk operator bila akun tidak tersedia (COA MISSING / nonaktif / belum diklasifikasikan). */
  masalah: string | null;
}

function kebijakanAtauTolak(kategori: unknown) {
  if (!isKategoriPendapatanInvestasi(kategori)) {
    throw new PendapatanInvestasiDitolakError('KATEGORI_TIDAK_DIKENAL', 'Jenis pendapatan investasi tidak dikenal.');
  }
  return { kategori, kebijakan: KEBIJAKAN_PENDAPATAN_INVESTASI[kategori] };
}

/**
 * Status akun tujuan sebuah leaf — dipakai layar untuk menampilkan akun
 * (read-only) dan untuk menolak lebih awal bila COA tidak tersedia.
 * Akun TIDAK pernah dibuat otomatis (COA MISSING dilaporkan, bukan diisi).
 */
export async function getInfoPendapatanInvestasi(kategori: KategoriPendapatanInvestasi): Promise<InfoPendapatanInvestasi> {
  const { kebijakan } = kebijakanAtauTolak(kategori);
  // RC-S70.6 — kunci keras: kebijakan yang menunjuk akun selain akun wajib
  // kategorinya (mis. bunga -> 4-1500) tidak pernah dicari di COA.
  const akunTidakSah = periksaAkunKategoriPendapatanInvestasi(kategori, kebijakan.akunKode);
  if (akunTidakSah) {
    return {
      kategori,
      label: kebijakan.label,
      jenisInvestasi: kebijakan.jenisInvestasi,
      akunKode: kebijakan.akunKode,
      sumberKebijakan: kebijakan.sumberKebijakan,
      wajibDokumen: !!kebijakan.wajibDokumen,
      akun: null,
      masalah: akunTidakSah,
    };
  }
  const db = await getDb();
  const acc = await db.getFirstAsync<{ id: string; kode: string; nama: string; kategori: string; is_active: number; lhu_klasifikasi: string | null }>(
    `SELECT id, kode, nama, kategori, is_active, lhu_klasifikasi FROM account WHERE kode = ?`,
    kebijakan.akunKode
  );
  let masalah: string | null = null;
  // RC-S70.6 — kategori bunga: pesan menyebut kode + nama akun wajib (actionable).
  const akunWajibBunga =
    kategori === 'BUNGA_USAHA_LAIN' || kategori === 'BUNGA_DEPOSITO' ? AKUN_WAJIB_PENDAPATAN_BUNGA[kategori] : null;
  if (!acc) {
    masalah = akunWajibBunga
      ? `COA ${akunWajibBunga.kode} ${akunWajibBunga.nama} tidak ditemukan. Transaksi tidak dapat diposting.`
      : `Akun ${kebijakan.akunKode} belum tersedia di COA. Hubungi administrator.`;
  } else if (acc.kategori !== 'PENDAPATAN') masalah = `Akun ${kebijakan.akunKode} bukan akun Pendapatan.`;
  else if (!acc.is_active) masalah = `Akun ${kebijakan.akunKode} sudah dinonaktifkan.`;
  else if (!acc.lhu_klasifikasi) masalah = `Akun ${kebijakan.akunKode} belum diklasifikasikan untuk LHU.`;

  return {
    kategori,
    label: kebijakan.label,
    jenisInvestasi: kebijakan.jenisInvestasi,
    akunKode: kebijakan.akunKode,
    sumberKebijakan: kebijakan.sumberKebijakan,
    wajibDokumen: !!kebijakan.wajibDokumen,
    akun:
      acc && !masalah
        ? { accountId: acc.id, kode: acc.kode, nama: acc.nama, klasifikasiLhu: acc.lhu_klasifikasi as LhuKlasifikasi }
        : null,
    masalah,
  };
}

export interface TambahPendapatanInvestasiInput {
  kategori: KategoriPendapatanInvestasi;
  investasiId: string;
  tanggal: string;
  nominal: Rupiah;
  jenis: JenisRekening;
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
  /** Identitas SUBMIT (dibuat saat form dibuka) — retry dengan kunci sama tidak membuat jurnal kedua. */
  idempotencyKey?: string;
  /**
   * RC-S67.6 — wajib untuk kategori ber-`wajibDokumen` (Imbal Hasil Tetap).
   * Identity bisnis = kategori + investasi + nomor dokumen (dinormalisasi)
   * dan MENGGANTIKAN kunci submit, sehingga retry dengan kunci baru pun
   * tidak dapat mencatat dokumen yang sama dua kali.
   */
  nomorDokumen?: string;
}

/** RC-S67.6 — normalisasi nomor dokumen: trim, spasi tunggal, huruf besar. */
export function normalisasiNomorDokumenPendapatan(nomor: string | undefined | null): string {
  return (nomor ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function kunciIdentitasPendapatanInvestasi(kategori: KategoriPendapatanInvestasi, investasiId: string, nomorDokumen: string): string {
  return `PI|${kategori}|${investasiId}|${normalisasiNomorDokumenPendapatan(nomorDokumen)}`;
}

function tanggalValid(tanggal: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return false;
  const [y, m, d] = tanggal.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Catat penerimaan pendapatan investasi yang BERSUMBER pada satu
 * investasi aktif. Service adalah otoritas validasi; UI hanya lapisan UX.
 */
export async function tambahPendapatanInvestasi(
  input: TambahPendapatanInvestasiInput
): Promise<{ id: string; journalId: string; klasifikasiLhu: LhuKlasifikasi; akunKode: string; referensiSumber: string }> {
  const { kategori, kebijakan } = kebijakanAtauTolak(input.kategori);

  if (!Number.isFinite(input.nominal) || !Number.isInteger(input.nominal) || input.nominal <= 0) {
    throw new PendapatanInvestasiDitolakError('NOMINAL_TIDAK_VALID', 'Nominal harus bilangan bulat rupiah lebih dari 0.');
  }
  const tanggal = (input.tanggal ?? '').trim();
  if (!tanggalValid(tanggal)) {
    throw new PendapatanInvestasiDitolakError('TANGGAL_TIDAK_VALID', 'Tanggal tidak valid (format YYYY-MM-DD).');
  }
  if (tanggal > getTanggalLokalHariIni()) {
    throw new PendapatanInvestasiDitolakError('TANGGAL_MASA_DEPAN', 'Tanggal penerimaan tidak boleh di masa depan.');
  }
  if (!input.investasiId) {
    throw new PendapatanInvestasiDitolakError('INVESTASI_WAJIB', 'Investasi sumber wajib dipilih.');
  }
  if (input.jenis === 'BANK' && !input.bankAccountId) {
    throw new PendapatanInvestasiDitolakError('REKENING_WAJIB', 'Rekening bank wajib dipilih.');
  }
  const nomorDokumen = normalisasiNomorDokumenPendapatan(input.nomorDokumen);
  if (kebijakan.wajibDokumen) {
    if (!nomorDokumen) throw new PendapatanInvestasiDitolakError('DOKUMEN_WAJIB', 'Nomor dokumen wajib diisi.');
    if (nomorDokumen.includes('|') || nomorDokumen.length > 100) {
      throw new PendapatanInvestasiDitolakError('DOKUMEN_TIDAK_VALID', 'Nomor dokumen tidak boleh memuat karakter "|" dan maksimal 100 karakter.');
    }
  }

  const db = await getDb();
  const inv = await db.getFirstAsync<{
    id: string; nomor_investasi: string; nama_tujuan: string; jenis_investasi: string; status: string; tanggal: string;
  }>(
    `SELECT id, nomor_investasi, nama_tujuan, jenis_investasi, status, tanggal FROM investasi WHERE id = ?`,
    input.investasiId
  );
  if (!inv) {
    throw new PendapatanInvestasiDitolakError('INVESTASI_TIDAK_DITEMUKAN', 'Investasi sumber tidak ditemukan.');
  }
  if (inv.jenis_investasi !== kebijakan.jenisInvestasi) {
    throw new PendapatanInvestasiDitolakError(
      'JENIS_INVESTASI_TIDAK_SESUAI',
      `Investasi ${inv.nomor_investasi} bukan jenis yang sesuai untuk ${kebijakan.label}.`
    );
  }
  if (inv.status !== 'AKTIF') {
    throw new PendapatanInvestasiDitolakError(
      'INVESTASI_TIDAK_AKTIF',
      `Investasi ${inv.nomor_investasi} sudah tidak aktif — pendapatan baru tidak dapat dicatat.`
    );
  }
  if (tanggal < String(inv.tanggal).slice(0, 10)) {
    throw new PendapatanInvestasiDitolakError(
      'TANGGAL_SEBELUM_INVESTASI',
      `Tanggal penerimaan tidak boleh sebelum tanggal investasi (${String(inv.tanggal).slice(0, 10)}).`
    );
  }

  const info = await getInfoPendapatanInvestasi(kategori);
  const akunTidakSah = periksaAkunKategoriPendapatanInvestasi(kategori, info.akun ? info.akun.kode : kebijakan.akunKode);
  if (akunTidakSah) {
    // RC-S70.6 — FAIL CLOSED: tidak ada fallback ke akun lain.
    throw new PendapatanInvestasiDitolakError('AKUN_TIDAK_SESUAI', akunTidakSah);
  }
  if (!info.akun) {
    throw new PendapatanInvestasiDitolakError('COA_MISSING', info.masalah ?? `Akun ${kebijakan.akunKode} tidak dapat dipakai.`);
  }

  let kunciIdentitas: string | undefined;
  if (kebijakan.wajibDokumen) {
    kunciIdentitas = kunciIdentitasPendapatanInvestasi(kategori, inv.id, nomorDokumen);
    for (const tabel of ['kas_transaksi', 'bank_transaksi']) {
      const ada = await db.getFirstAsync<{ id: string }>(`SELECT id FROM ${tabel} WHERE idempotency_key = ?`, kunciIdentitas);
      if (ada) {
        throw new PendapatanInvestasiDitolakError(
          'DUPLIKAT_DOKUMEN',
          `${kebijakan.label} dengan nomor dokumen ${nomorDokumen} untuk ${inv.nomor_investasi} sudah pernah dicatat.`
        );
      }
    }
  }

  const referensiSumber =
    `Sumber: ${inv.nomor_investasi} · ${inv.nama_tujuan}` + (kebijakan.wajibDokumen ? ` · Dok ${nomorDokumen}` : '');
  const catatan = (input.keterangan ?? '').trim();

  const hasil = await tambahTransaksiPendapatan({
    tanggal,
    accountId: info.akun.accountId,
    nominal: input.nominal,
    jenis: input.jenis,
    bankAccountId: input.jenis === 'BANK' ? input.bankAccountId : undefined,
    keterangan: catatan ? `${kebijakan.label} — ${referensiSumber} · ${catatan}` : `${kebijakan.label} — ${referensiSumber}`,
    kategori: kebijakan.label,
    createdBy: input.createdBy,
    idempotencyKey: kunciIdentitas ?? input.idempotencyKey,
  });

  return { ...hasil, akunKode: kebijakan.akunKode, referensiSumber };
}

/**
 * Riwayat satu leaf — SUBSET dari `listTransaksiPendapatan` (tabel dan
 * status koreksi yang sama), disaring label kategori + akun kebijakan.
 * Transaksi dari form generik (kategori NULL) tidak ikut, meski akunnya sama.
 *
 * RC-S70.6 — ditambah pasangan `riwayatHistoris` (label + akun sebelum
 * kebijakan akun berubah) agar transaksi lama leaf yang sama tetap tampil
 * dengan akun historisnya. Hanya pembacaan; tidak ada baris yang diubah.
 */
export async function listRiwayatPendapatanInvestasi(
  kategori: KategoriPendapatanInvestasi,
  filter: FilterTransaksiPendapatan = {}
): Promise<TransaksiPendapatanRow[]> {
  const { kebijakan } = kebijakanAtauTolak(kategori);
  const semua = await listTransaksiPendapatan(filter);
  const pasangan = [{ label: kebijakan.label, akunKode: kebijakan.akunKode }, ...(kebijakan.riwayatHistoris ?? [])];
  return semua.filter((r) => pasangan.some((p) => r.kategori === p.label && r.akunKode === p.akunKode));
}
