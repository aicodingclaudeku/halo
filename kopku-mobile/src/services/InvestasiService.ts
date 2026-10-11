import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, reverseJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { getNilaiTercatatInvestasi } from '@/services/InvestasiImpairmentService';

/**
 * Investasi — penyertaan koperasi pada unit usaha sendiri (mis. unit
 * usaha toko/simpan-pinjam yang dikelola terpisah) atau koperasi lain.
 * Sub-fitur "Investasi" (menu Pengeluaran, dikelompokkan dengan
 * Kewajiban): uang KELUAR dari kas/bank koperasi, dicatat sebagai
 * ASET (penyertaan) — DEBIT Penyertaan pada Unit Usaha & Koperasi
 * Lain, KREDIT Kas/Bank — bukan beban, karena koperasi tetap punya
 * klaim/hak atas nilai investasi itu, persis seperti membeli aset,
 * hanya bentuknya penyertaan modal bukan barang fisik.
 */

export type JenisInvestasi =
  | 'UNIT_USAHA'
  | 'KOPERASI_LAIN'
  | 'USAHA_LAIN'
  | 'TABUNGAN_BANK_UMUM'
  | 'GIRO_BANK_UMUM'
  | 'DEPOSITO_BANK_UMUM'
  | 'PROPERTI_INVESTASI';

/**
 * Jenis investasi yang masih boleh dipilih untuk transaksi BARU (Phase
 * 18 §2 — UNIT_USAHA dihapus dari input baru, histori lama tetap
 * terbaca lewat JenisInvestasi di atas).
 *
 * Audit ulang (permintaan pengguna §2/§3): 5 jenis baru ditambahkan —
 * Usaha Lain, Bank Umum (Tabungan/Giro/Deposito > 3 Bulan), Properti
 * Investasi — melengkapi Koperasi Lain yang sudah ada.
 */
export type JenisInvestasiInput =
  | 'KOPERASI_LAIN'
  | 'USAHA_LAIN'
  | 'TABUNGAN_BANK_UMUM'
  | 'GIRO_BANK_UMUM'
  | 'DEPOSITO_BANK_UMUM'
  | 'PROPERTI_INVESTASI';

/**
 * Label tampilan (§3) — dipakai UI & export, SATU-SATUNYA sumber
 * kebenaran supaya tidak ada label generik "Koperasi Lain/External"
 * tersebar di banyak tempat.
 *
 * Audit ulang (permintaan pengguna, request baru §7): label
 * `DEPOSITO_BANK_UMUM` diubah dari "Deposito (> 3 bulan)" menjadi
 * "Deposito" — HANYA label tampilan. Internal enum value
 * `DEPOSITO_BANK_UMUM` (disimpan di kolom `investasi.jenis_investasi`)
 * TIDAK diubah, jadi data investasi Deposito yang sudah ada tetap
 * terbaca & tetap dipetakan ke akun yang sama (1-1650).
 */
export const LABEL_JENIS_INVESTASI: Record<JenisInvestasi, string> = {
  UNIT_USAHA: 'Unit Usaha Internal',
  KOPERASI_LAIN: 'Penyertaan pada Koperasi Lain',
  USAHA_LAIN: 'Usaha Lain',
  TABUNGAN_BANK_UMUM: 'Tabungan',
  GIRO_BANK_UMUM: 'Giro',
  DEPOSITO_BANK_UMUM: 'Deposito',
  PROPERTI_INVESTASI: 'Properti Investasi',
};

/**
 * Audit ulang §4: mapping transactionType per jenis investasi (dipakai
 * `resolveAccountId()`) — masing-masing jenis punya akun ASET sendiri
 * (lihat defaultCOA.ts 1-1610..1-1660), BUKAN satu akun generik
 * "Investasi". `UNIT_USAHA` SENGAJA tidak ada di sini (tidak bisa
 * dipakai untuk transaksi baru — lihat `JenisInvestasiInput`).
 */
const JENIS_TRANSACTION_TYPE: Record<JenisInvestasiInput, string> = {
  KOPERASI_LAIN: 'INVESTASI_KOPERASI_LAIN',
  USAHA_LAIN: 'INVESTASI_USAHA_LAIN',
  TABUNGAN_BANK_UMUM: 'INVESTASI_TABUNGAN_BANK_UMUM',
  GIRO_BANK_UMUM: 'INVESTASI_GIRO_BANK_UMUM',
  DEPOSITO_BANK_UMUM: 'INVESTASI_DEPOSITO_BANK_UMUM',
  PROPERTI_INVESTASI: 'INVESTASI_PROPERTI_INVESTASI',
};

/** §2: kelompok "Bank Umum" di UI (Tabungan/Giro/Deposito) — dipakai untuk menampilkan sub-pilihan & field dinamis (§5). */
export const JENIS_BANK_UMUM: JenisInvestasiInput[] = ['TABUNGAN_BANK_UMUM', 'GIRO_BANK_UMUM', 'DEPOSITO_BANK_UMUM'];

/**
 * Permintaan pengguna §11 (Deposito Berjangka): field "Nama Bank" (dan
 * kewajiban memilihnya dari Data Bank lewat `bankTujuanId`) DIHAPUS
 * khusus untuk jenis DEPOSITO_BANK_UMUM — nama tujuan investasi
 * deposito sekarang teks bebas seperti Koperasi Lain/Usaha Lain
 * (`namaTujuan`), sama seperti jenis non-Bank-Umum lainnya. Jenis Bank
 * Umum LAIN (TABUNGAN_BANK_UMUM/GIRO_BANK_UMUM — legacy, sudah tidak
 * bisa dipilih untuk investasi baru tapi datanya & mode edit-nya
 * tetap ada) TIDAK berubah — tetap WAJIB pilih Nama Bank dari Data
 * Bank seperti semula, kolom `bank_tujuan_id` TIDAK dihapus dari
 * skema karena masih dipakai jenis ini.
 */
const JENIS_WAJIB_NAMA_BANK: JenisInvestasiInput[] = ['TABUNGAN_BANK_UMUM', 'GIRO_BANK_UMUM'];

export interface InvestasiInput {
  jenisInvestasi: JenisInvestasiInput;
  /** Nama unit usaha lain / koperasi lain / nama&deskripsi properti — tujuan investasi. Diabaikan untuk jenis Bank Umum (lihat `bankTujuanId`). */
  namaTujuan: string;
  jumlah: Rupiah;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  /** §5: relevan HANYA untuk jenis Bank Umum (Tabungan/Giro/Deposito) — nomor rekening pada bank tujuan investasi. Diabaikan untuk jenis lain. */
  nomorRekeningInvestasi?: string;
  /**
   * Revisi KOPKU (Bagian 1): WAJIB diisi untuk jenis Bank Umum
   * (Tabungan/Giro/Deposito) — id bank_account dari "Data Bank"
   * (menu Data Bank/RekeningListScreen), MENGGANTIKAN input teks bebas
   * nama bank yang lama. `namaTujuan` untuk jenis Bank Umum TIDAK lagi
   * dipakai dari input — otomatis diambil dari nama bank yang dipilih
   * di sini (lihat `catatInvestasi`/`editInvestasi`). Diabaikan untuk
   * jenis investasi lain.
   */
  bankTujuanId?: string;
  /** §5: relevan HANYA untuk Properti Investasi — lokasi/deskripsi properti. Diabaikan untuk jenis lain. */
  lokasiProperti?: string;
  /** v72 — tanggal jatuh tempo (YYYY-MM-DD), relevan HANYA untuk Deposito Berjangka. Opsional. */
  tanggalJatuhTempo?: string;
  createdBy: string;
}

/**
 * v72 — simpan tanggal jatuh tempo deposito (opsional, additive). Validasi:
 * format YYYY-MM-DD dan tidak sebelum tanggal penempatan. Jenis selain
 * Deposito Berjangka diabaikan.
 */
async function simpanJatuhTempo(
  db: SQLite.SQLiteDatabase,
  id: string,
  jenis: JenisInvestasiInput,
  tanggal: string,
  jatuhTempo: string | undefined
): Promise<void> {
  if (jenis !== 'DEPOSITO_BANK_UMUM') return;
  const t = (jatuhTempo ?? '').trim();
  if (!t) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) {
    throw new Error('Tanggal jatuh tempo tidak valid (YYYY-MM-DD).');
  }
  if (t < tanggal.slice(0, 10)) throw new Error('Tanggal jatuh tempo tidak boleh sebelum tanggal penempatan.');
  await db.runAsync(`UPDATE investasi SET tanggal_jatuh_tempo = ? WHERE id = ?`, t, id);
}

/**
 * Revisi KOPKU (Bagian 1): resolusi & validasi bank TUJUAN investasi
 * dari Data Bank (bank_account) — dipakai `catatInvestasi`/
 * `editInvestasi` untuk jenis Bank Umum. Validasi di lapisan SERVICE
 * ini (bukan cuma UI) supaya tetap ditegakkan meski dipanggil dari
 * jalur lain (Bagian 1.3: "Jangan membuat nama bank manual dari form
 * Investasi").
 */
async function resolveBankTujuan(
  db: SQLite.SQLiteDatabase,
  bankTujuanId: string | undefined
): Promise<{ id: string; namaBank: string }> {
  if (!bankTujuanId) {
    throw new Error('Nama bank wajib dipilih dari Data Bank. Belum ada data bank? Tambahkan bank terlebih dahulu melalui menu Data Bank.');
  }
  const bank = await db.getFirstAsync<{ id: string; nama_bank: string }>(
    `SELECT id, nama_bank FROM bank_account WHERE id = ?`,
    bankTujuanId
  );
  if (!bank) {
    throw new Error('Bank tujuan tidak ditemukan di Data Bank.');
  }
  return { id: bank.id, namaBank: bank.nama_bank };
}

/** Catat investasi baru (sub-fitur "Investasi", Pengeluaran): DEBIT Penyertaan/Investasi (akun sesuai jenis), KREDIT Kas/Bank. */
export async function catatInvestasi(input: InvestasiInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    // Phase 18 §2 (permintaan pengguna): Investasi Unit Usaha Internal
    // dihapus dari transaksi BARU — akun 1-1600 dinonaktifkan & mapping
    // INVESTASI_UNIT_USAHA dihapus (migration v18), jadi ini juga akan
    // gagal lewat resolveAccountId(); dicek eksplisit di sini dulu
    // supaya pesannya jelas untuk pengguna, bukan error mapping generik.
    if ((input.jenisInvestasi as string) === 'UNIT_USAHA') {
      throw new Error('Investasi Unit Usaha Internal sudah tidak dapat dibuat untuk transaksi baru. Pilih jenis investasi lain.');
    }
    const investasiTransactionType = JENIS_TRANSACTION_TYPE[input.jenisInvestasi];
    if (!investasiTransactionType) {
      throw new Error(`Jenis investasi "${input.jenisInvestasi}" tidak dikenali.`);
    }
    // Revisi KOPKU (Bagian 1): untuk Bank Umum, nama tujuan WAJIB dari
    // Data Bank (bank_account) — bukan teks bebas — resolusi &
    // validasi di sini supaya berlaku di jalur mana pun (bukan cuma UI).
    // Permintaan pengguna §11: DEPOSITO_BANK_UMUM DIKECUALIKAN dari
    // aturan ini — pakai `JENIS_WAJIB_NAMA_BANK` (bukan `JENIS_BANK_UMUM`)
    // supaya Deposito Berjangka memakai jalur teks bebas seperti jenis
    // lain, sedangkan Tabungan/Giro (legacy) tetap wajib pilih bank.
    const wajibNamaBank = JENIS_WAJIB_NAMA_BANK.includes(input.jenisInvestasi);
    let bankTujuanId: string | null = null;
    let namaTujuanFinal: string;
    if (wajibNamaBank) {
      const bankTujuan = await resolveBankTujuan(db, input.bankTujuanId);
      bankTujuanId = bankTujuan.id;
      namaTujuanFinal = bankTujuan.namaBank;
    } else {
      if (!input.namaTujuan.trim()) {
        throw new Error('Nama/tujuan investasi wajib diisi.');
      }
      namaTujuanFinal = input.namaTujuan.trim();
    }
    if (!Number.isFinite(input.jumlah) || input.jumlah <= 0) {
      throw new Error('Jumlah investasi harus lebih dari 0.');
    }

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    // Investasi selalu tunai keluar dari kas/bank koperasi — wajib cek
    // saldo dulu (pola sama dengan AsetService.beliAset metode TUNAI),
    // supaya kas/bank tidak bisa negatif tanpa penolakan.
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: input.jumlah,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    // Bagian E (permintaan pengguna) & audit ulang §4: akun DIPILIH
    // berdasarkan investasi.jenis_investasi — transactionType TERPISAH
    // per jenis (JENIS_TRANSACTION_TYPE di atas), BUKAN satu akun
    // generik "Investasi".
    const investasiAccountId = await resolveAccountId(db, investasiTransactionType, 'DEBIT_ASET');

    const year = new Date(input.tanggal).getFullYear();
    const nomorInvestasi = await nextSequence(db, 'INV', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: investasiTransactionType,
      nomorReferensi: nomorInvestasi,
      deskripsi: `Investasi ${LABEL_JENIS_INVESTASI[input.jenisInvestasi]} - ${namaTujuanFinal} - ${nomorInvestasi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: investasiAccountId, debit: input.jumlah, kredit: 0 },
        { accountId: kasBankAccountId, debit: 0, kredit: input.jumlah },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO investasi
        (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, bank_account_id, bank_tujuan_id,
         keterangan, nomor_rekening_investasi, lokasi_properti, journal_id, created_by, created_at, status, reversal_of_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      nomorInvestasi,
      input.jenisInvestasi,
      namaTujuanFinal,
      input.jumlah,
      input.tanggal,
      input.sumberDana,
      input.bankAccountId ?? null,
      bankTujuanId,
      input.keterangan ?? null,
      input.nomorRekeningInvestasi?.trim() || null,
      input.lokasiProperti?.trim() || null,
      journalId,
      input.createdBy,
      now,
      'AKTIF',
      null,
      now
    );

    await simpanJatuhTempo(db, id, input.jenisInvestasi, input.tanggal, input.tanggalJatuhTempo);

    await writeAuditLog(db, input.createdBy, 'CREATE', id, { nomorInvestasi, jenisInvestasi: input.jenisInvestasi, namaTujuan: namaTujuanFinal, jumlah: input.jumlah, tanggalJatuhTempo: input.tanggalJatuhTempo ?? null });

    return { id, nomorInvestasi, journalId };
  });
}

export interface InvestasiListItem {
  id: string;
  nomorInvestasi: string;
  jenisInvestasi: JenisInvestasi;
  namaTujuan: string;
  jumlah: Rupiah;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId: string | null;
  /** Revisi KOPKU (Bagian 1): id bank_account (Data Bank) tujuan investasi — hanya terisi untuk jenis Bank Umum. */
  bankTujuanId: string | null;
  keterangan: string | null;
  nomorRekeningInvestasi: string | null;
  lokasiProperti: string | null;
  /** v72 — jatuh tempo deposito (null bila tidak dicatat). */
  tanggalJatuhTempo: string | null;
  /** DILEPAS = RC-S54 T16 #20 (PELEPASAN_INVESTASI). */
  status: 'AKTIF' | 'DIBATALKAN' | 'DILEPAS';
  reversalOfId: string | null;
  journalId: string | null;
}

function rowToItem(r: any): InvestasiListItem {
  return {
    id: r.id,
    nomorInvestasi: r.nomor_investasi,
    jenisInvestasi: r.jenis_investasi,
    namaTujuan: r.nama_tujuan,
    jumlah: r.jumlah,
    tanggal: r.tanggal,
    sumberDana: r.sumber_dana,
    bankAccountId: r.bank_account_id,
    bankTujuanId: r.bank_tujuan_id ?? null,
    keterangan: r.keterangan,
    nomorRekeningInvestasi: r.nomor_rekening_investasi ?? null,
    lokasiProperti: r.lokasi_properti ?? null,
    tanggalJatuhTempo: r.tanggal_jatuh_tempo ?? null,
    status: r.status ?? 'AKTIF',
    reversalOfId: r.reversal_of_id,
    journalId: r.journal_id,
  };
}

/**
 * Daftar investasi (untuk layar riwayat & export) — diurutkan terbaru
 * dulu.
 *
 * DATE-SCOPING (Phase 17/§2): `asOfDate` OPSIONAL — kalau diisi:
 *  - Investasi dengan `tanggal` > asOfDate TIDAK muncul (belum ada
 *    pada tanggal itu).
 *  - Investasi berstatus DIBATALKAN TETAP muncul kalau pembatalannya
 *    terjadi SETELAH asOfDate (masih aktif pada tanggal itu).
 *
 * KETERBATASAN (didokumentasikan, bukan dikarang): aplikasi ini TIDAK
 * punya konsep "pencairan/redemption" investasi yang genuine (jual
 * sebagian/seluruh investasi yang sudah lama dipegang) — yang ada
 * hanya `batalkanInvestasi()`, sebuah KOREKSI (reversal penuh,
 * memperlakukan transaksi seolah tidak pernah terjadi), bukan
 * transaksi keluar/exit yang berdiri sendiri. Untuk keperluan
 * date-scoping ini diperlakukan setara ("tidak lagi aktif setelah
 * tanggal pembatalan") karena itulah satu-satunya sinyal yang
 * tersedia di data — TAPI secara akuntansi maknanya berbeda dari
 * pencairan sungguhan. Sama seperti Aset (lihat komentar
 * `listAsetDenganNilaiBuku`), tidak ada kolom tanggal efektif
 * terpisah untuk pembatalan — `updated_at` (waktu aksi dilakukan)
 * dipakai sebagai proksi, field yang benar-benar ada di skema.
 *
 * TANPA asOfDate: perilaku PERSIS SAMA seperti sebelumnya.
 */
export async function listInvestasi(asOfDate?: string): Promise<InvestasiListItem[]> {
  const db = await getDb();
  const whereClause = asOfDate
    ? `WHERE tanggal <= ?
       AND NOT (status = 'DIBATALKAN' AND updated_at IS NOT NULL AND substr(updated_at,1,10) <= ?)
       AND NOT (status = 'DILEPAS' AND EXISTS (
             SELECT 1 FROM journal jp WHERE jp.sumber_transaksi = 'PELEPASAN_INVESTASI' AND jp.sumber_id = investasi.id
               AND jp.status = 'POSTED' AND substr(jp.tanggal,1,10) <= ?))`
    : '';
  // RC-S54 T16 #20: investasi DILEPAS tidak lagi aktif sejak TANGGAL PELEPASAN (tanggal jurnal pelepasan).
  const params = asOfDate ? [asOfDate, asOfDate, asOfDate] : [];
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM investasi ${whereClause} ORDER BY tanggal DESC, created_at DESC`,
    ...params
  );
  return rows.map(rowToItem);
}

/** Detail satu investasi. */
export async function getInvestasiDetail(id: string): Promise<InvestasiListItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM investasi WHERE id = ?`, id);
  return row ? rowToItem(row) : null;
}

/** Audit trail investasi (permintaan pengguna §9 — Aktivitas Log): "Tambah investasi"/"Jual kembali investasi" WAJIB tercatat. Pola sama dengan RAKService/RATService.writeAuditLog. */
async function writeAuditLog(
  db: SQLite.SQLiteDatabase,
  userId: string,
  action: 'CREATE' | 'UPDATE' | 'REVERSE',
  entityId: string,
  dataSesudah?: Record<string, unknown>
) {
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    action,
    'investasi',
    entityId,
    dataSesudah ? JSON.stringify(dataSesudah) : null,
    now.toISOString()
  );
}

export const KODE_KOREKSI_DITOLAK_LIFECYCLE = 'KOREKSI_DITOLAK_LIFECYCLE' as const;

/**
 * RC-S54 T16 #20 — KOREKSI_SALAH_INPUT ditolak untuk investasi yang sudah mempunyai siklus
 * akuntansi lanjutan (penyusutan dan/atau penurunan nilai). Penjualan/pencairan memakai
 * operasi terpisah `PelepasanInvestasiService.lepaskanInvestasi`.
 */
export class KoreksiInvestasiDitolakError extends Error {
  readonly kode = KODE_KOREKSI_DITOLAK_LIFECYCLE;
  constructor(
    namaTujuan: string,
    readonly akumulasiPenyusutan: Rupiah,
    readonly akumulasiImpairment: Rupiah
  ) {
    super(
      `${KODE_KOREKSI_DITOLAK_LIFECYCLE}: "${namaTujuan}" sudah mempunyai lifecycle akuntansi ` +
        `(akumulasi penyusutan Rp${akumulasiPenyusutan}, penurunan nilai Rp${akumulasiImpairment}), sehingga tidak dapat ` +
        `dikoreksi dengan membalik jurnal penempatan. Gunakan operasi Pelepasan Investasi (Jual Kembali/Cairkan) ` +
        `untuk penjualan atau pencairan; koreksi salah input atas investasi ini memerlukan workflow koreksi terpisah.`
    );
    this.name = 'KoreksiInvestasiDitolakError';
  }
}

async function batalkanInternal(db: SQLite.SQLiteDatabase, id: string, userId: string, alasan: string): Promise<InvestasiListItem> {
  const original = await db.getFirstAsync<any>(`SELECT * FROM investasi WHERE id = ?`, id);
  if (!original) throw new Error('Investasi tidak ditemukan.');
  if (original.status === 'DIBATALKAN') throw new Error('Investasi ini sudah dibatalkan sebelumnya.');
  if ((original as { status: string }).status === 'DILEPAS') throw new Error('Investasi ini sudah dilepas (Pelepasan Investasi); pelepasan bukan objek koreksi/pembatalan.');
  if (!original.journal_id) throw new Error('Investasi ini tidak mempunyai jurnal terkait.');

  // RC-S54 TAHAP 16 — ITEM #20. Fungsi ini = operasi KOREKSI_SALAH_INPUT
  // (reversal jurnal penempatan). Untuk investasi yang sudah punya
  // akumulasi penyusutan (1-1670) atau penurunan nilai (1-1900), reversal
  // penempatan saja meninggalkan saldo kontra yatim (RC-S54_TAHAP_15.md §15),
  // jadi DITOLAK — penjualan/pencairan memakai PELEPASAN_INVESTASI
  // (PelepasanInvestasiService). Investasi tanpa penyusutan/impairment
  // tidak berubah. Status DILEPAS juga bukan objek koreksi.
  const nilai = await getNilaiTercatatInvestasi(db, id);
  // v72 — investasi yang sudah pernah ditarik (sebagian) tidak dapat
  // dikoreksi dengan membalik jurnal penempatan: jurnal penarikannya akan
  // tertinggal tanpa pasangan. Penyelesaian lewat Penarikan Dana Investasi.
  if (nilai.totalDitarik > 0) {
    throw new Error(
      `"${(original as { nama_tujuan: string }).nama_tujuan}" sudah pernah ditarik sebagian sehingga tidak dapat dikoreksi/dibatalkan. ` +
        'Selesaikan melalui Penarikan Dana Investasi.'
    );
  }
  if (nilai.akumulasiPenyusutan > 0 || nilai.akumulasiImpairment > 0) {
    throw new KoreksiInvestasiDitolakError((original as { nama_tujuan: string }).nama_tujuan, nilai.akumulasiPenyusutan, nilai.akumulasiImpairment);
  }

  // RC-S54 T16 GAP 5 (dokumentasi = implementasi): reverseJournal() TIDAK
  // memeriksa periode jurnal ASLI. Jurnal pembalik diberi tanggal hari ini
  // (getTanggalLokalHariIni) sehingga createJournal menolak hanya bila
  // periode HARI INI CLOSED; jurnal asli di periode CLOSED tidak diubah
  // (status ditandai REVERSED) dan pembaliknya masuk periode berjalan.
  await reverseJournal(db, original.journal_id, userId, alasan);

  const now = new Date().toISOString();
  await db.runAsync(`UPDATE investasi SET status = 'DIBATALKAN', keterangan = ?, updated_at = ? WHERE id = ?`, alasan, now, id);

  const updated = await db.getFirstAsync<any>(`SELECT * FROM investasi WHERE id = ?`, id);
  // Permintaan pengguna §9/§10: dicatat sebagai 'REVERSE' baik untuk
  // "Cairkan" maupun "Jual Kembali" (Properti Investasi) — keduanya
  // sama-sama reversal jurnal secara akuntansi, hanya label UI yang
  // berbeda (lihat DaftarInvestasiScreen).
  await writeAuditLog(db, userId, 'REVERSE', id, { alasan, jenisInvestasi: original.jenis_investasi, namaTujuan: original.nama_tujuan });
  return rowToItem(updated);
}

/**
 * Batalkan/hapus investasi (§11 — "gunakan correction/reversal, jangan
 * hard-delete journal"): reversal jurnal + status DIBATALKAN, baris
 * asli TETAP ADA untuk audit trail (bukan dihapus fisik). Investasi
 * yang sudah dibatalkan sebelumnya TIDAK bisa dibatalkan lagi.
 */
export async function batalkanInvestasi(id: string, userId: string, alasan: string): Promise<InvestasiListItem> {
  return withTransaction(async (db) => {
    await requirePermission(db, userId, 'kas_bank', 'edit');
    if (!alasan.trim()) throw new Error('Alasan pembatalan wajib diisi.');
    return batalkanInternal(db, id, userId, alasan);
  });
}

/**
 * Edit investasi yang masih AKTIF (§11 — "gunakan InvestasiService
 * existing"): jurnal & baris LAMA dibatalkan (reversal, tetap
 * tersimpan untuk audit), lalu baris & jurnal BARU dibuat dari data
 * hasil edit — ditaut lewat `reversalOfId`.
 *
 * Audit ulang (permintaan pengguna §2/§5): jenis investasi BARU
 * SEKARANG bisa salah satu dari 6 jenis input yang valid (bukan
 * hardcode KOPERASI_LAIN lagi) — TAPI jenis TETAP mengikuti jenis
 * investasi ASLI yang sedang diedit (dibaca dari baris lama), BUKAN
 * dipilih ulang lewat parameter — mengedit investasi Bank Umum tetap
 * menghasilkan investasi Bank Umum, dst., supaya akun/akuntansi yang
 * dipakai tetap konsisten dengan substansi transaksi yang sedang
 * dikoreksi. Investasi UNIT_USAHA (legacy) TETAP tidak bisa diedit
 * (Phase 18 §2 — tidak diaktifkan kembali untuk transaksi baru,
 * termasuk lewat edit) — DITOLAK eksplisit di sini, bukan hanya di UI.
 */
export async function editInvestasi(
  id: string,
  userId: string,
  input: Omit<InvestasiInput, 'createdBy' | 'jenisInvestasi'>,
  alasanPerubahan: string
): Promise<{ id: string; nomorInvestasi: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, userId, 'kas_bank', 'edit');
    // Permintaan pengguna §7: alasan perubahan WAJIB diisi sebelum
    // investasi hasil edit disimpan — dicatat sebagai audit trail lewat
    // reverseJournal (userId + timestamp otomatis) & kolom `keterangan`
    // baris lama, pola sama seperti `batalkanInvestasi`. Audit trail ini
    // SENGAJA terpisah dari audit pencairan (§6) — deskripsi jurnal &
    // keterangan baris di bawah eksplisit menyebut "koreksi (diedit)",
    // bukan "dicairkan"/"dibatalkan".
    if (!alasanPerubahan.trim()) throw new Error('Alasan perubahan wajib diisi.');
    if (!Number.isFinite(input.jumlah) || input.jumlah <= 0) throw new Error('Jumlah investasi harus lebih dari 0.');

    const original = await db.getFirstAsync<{ jenis_investasi: string }>(
      `SELECT jenis_investasi FROM investasi WHERE id = ?`,
      id
    );
    if (!original) throw new Error('Investasi tidak ditemukan.');
    if (original.jenis_investasi === 'UNIT_USAHA') {
      throw new Error('Investasi Unit Usaha Internal (legacy) tidak dapat diedit — hanya dapat dibatalkan.');
    }
    const jenisInvestasi = original.jenis_investasi as JenisInvestasiInput;
    const investasiTransactionType = JENIS_TRANSACTION_TYPE[jenisInvestasi];
    if (!investasiTransactionType) {
      throw new Error(`Jenis investasi "${jenisInvestasi}" tidak dikenali.`);
    }
    // Revisi KOPKU (Bagian 1) — sama seperti catatInvestasi: Bank Umum
    // WAJIB dari Data Bank, jenis lain tetap teks tujuan seperti biasa.
    // Permintaan pengguna §11: DEPOSITO_BANK_UMUM dikecualikan (lihat
    // komentar `JENIS_WAJIB_NAMA_BANK`).
    const wajibNamaBank = JENIS_WAJIB_NAMA_BANK.includes(jenisInvestasi);
    let bankTujuanId: string | null = null;
    let namaTujuanFinal: string;
    if (wajibNamaBank) {
      const bankTujuan = await resolveBankTujuan(db, input.bankTujuanId);
      bankTujuanId = bankTujuan.id;
      namaTujuanFinal = bankTujuan.namaBank;
    } else {
      if (!input.namaTujuan.trim()) throw new Error('Nama/tujuan investasi wajib diisi.');
      namaTujuanFinal = input.namaTujuan.trim();
    }

    await batalkanInternal(db, id, userId, `Dikoreksi (diedit) - digantikan oleh transaksi investasi baru. Alasan perubahan: ${alasanPerubahan.trim()}`);

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: input.jumlah,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const investasiAccountId = await resolveAccountId(db, investasiTransactionType, 'DEBIT_ASET');
    const year = new Date(input.tanggal).getFullYear();
    const nomorInvestasi = await nextSequence(db, 'INV', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: investasiTransactionType,
      nomorReferensi: nomorInvestasi,
      deskripsi: `Investasi ${LABEL_JENIS_INVESTASI[jenisInvestasi]} - ${namaTujuanFinal} (koreksi) - ${nomorInvestasi}`,
      createdBy: userId,
      lines: [
        { accountId: investasiAccountId, debit: input.jumlah, kredit: 0 },
        { accountId: kasBankAccountId, debit: 0, kredit: input.jumlah },
      ],
    });

    const newRowId = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO investasi
        (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, bank_account_id, bank_tujuan_id,
         keterangan, nomor_rekening_investasi, lokasi_properti, journal_id, created_by, created_at, status, reversal_of_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newRowId,
      nomorInvestasi,
      jenisInvestasi,
      namaTujuanFinal,
      input.jumlah,
      input.tanggal,
      input.sumberDana,
      input.bankAccountId ?? null,
      bankTujuanId,
      input.keterangan ?? null,
      input.nomorRekeningInvestasi?.trim() || null,
      input.lokasiProperti?.trim() || null,
      journalId,
      userId,
      now,
      'AKTIF',
      id,
      now
    );

    await simpanJatuhTempo(db, newRowId, jenisInvestasi, input.tanggal, input.tanggalJatuhTempo);

    await writeAuditLog(db, userId, 'UPDATE', newRowId, { nomorInvestasi, jenisInvestasi, namaTujuan: namaTujuanFinal, jumlah: input.jumlah, reversalOfId: id, tanggalJatuhTempo: input.tanggalJatuhTempo ?? null });

    return { id: newRowId, nomorInvestasi };
  });
}
