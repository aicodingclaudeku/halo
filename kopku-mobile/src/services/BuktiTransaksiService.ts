import { getDb } from '@/database/db';
import { Rupiah } from '@/utils/money';

/**
 * Service "Bukti Transaksi" (Phase 17 §W/§X/§Y/§Z) — MURNI READ dari
 * transaksi yang SUDAH ADA (`angsuran_pembayaran`, `simpanan_transaksi`,
 * `journal`). Tidak ada transaksi baru yang dibuat di sini sama sekali
 * — nomor bukti selalu berasal dari `journal.nomor_referensi` /
 * `simpanan_transaksi.nomor_transaksi` yang sudah dibuat saat
 * transaksi aslinya terjadi (Setor Simpanan, Bayar Piutang, Keluar
 * Anggota), BUKAN dibuat baru saat export (§Z: "Export hanya membaca
 * transaksi existing").
 */

export interface BuktiBayarPiutangRow {
  id: string;
  nomorBukti: string;
  tanggal: string;
  nomorAnggota: string;
  namaAnggota: string;
  nomorPinjaman: string;
  jumlahPembayaran: Rupiah;
  porsiPokok: Rupiah;
  porsiJasa: Rupiah;
  porsiDenda: Rupiah;
  sumberDana: string;
  keterangan: string | null;
}

/** Daftar "Bukti Bayar Piutang Anggota" (§W) — dari angsuran_pembayaran (transaksi asli bayarAngsuran). */
export async function listBuktiBayarPiutang(opts: { search?: string } = {}): Promise<BuktiBayarPiutangRow[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: string[] = [];
  if (opts.search) {
    filters.push('(a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ? OR p.nomor_pinjaman LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const rows = await db.getAllAsync<any>(
    `SELECT ap.id, j.nomor_referensi as nomor_bukti, ap.tanggal, a.nomor_anggota, a.nama_lengkap,
            p.nomor_pinjaman, ap.nominal, ap.porsi_pokok, ap.porsi_jasa, ap.porsi_denda, ap.sumber_dana
     FROM angsuran_pembayaran ap
     JOIN pinjaman p ON p.id = ap.pinjaman_id
     JOIN anggota a ON a.id = p.anggota_id
     LEFT JOIN journal j ON j.id = ap.journal_id
     WHERE ap.reversal_of_id IS NULL
       -- Jaga-jaga (belum ada fitur koreksi angsuran saat ini, jadi
       -- baris NOT IN ini secara praktik masih no-op) — pola sama
       -- dengan fix simpanan_transaksi (Prioritas 3/E) supaya kalau
       -- suatu saat fitur koreksi angsuran ditambahkan, query ini
       -- sudah otomatis benar tanpa perlu diingat untuk ditambal lagi.
       AND ap.id NOT IN (SELECT reversal_of_id FROM angsuran_pembayaran WHERE reversal_of_id IS NOT NULL)
       ${where}
     ORDER BY ap.tanggal DESC, ap.created_at DESC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    nomorBukti: r.nomor_bukti ?? '-',
    tanggal: r.tanggal,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    nomorPinjaman: r.nomor_pinjaman,
    jumlahPembayaran: r.nominal,
    porsiPokok: r.porsi_pokok,
    porsiJasa: r.porsi_jasa,
    porsiDenda: r.porsi_denda,
    sumberDana: r.sumber_dana,
    keterangan: `Angsuran pinjaman ${r.nomor_pinjaman}`,
  }));
}

/** Satu baris Bukti Bayar Piutang berdasar id (dipakai layar detail). */
export async function getBuktiBayarPiutangById(id: string): Promise<BuktiBayarPiutangRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<any>(
    `SELECT ap.id, j.nomor_referensi as nomor_bukti, ap.tanggal, a.nomor_anggota, a.nama_lengkap,
            p.nomor_pinjaman, ap.nominal, ap.porsi_pokok, ap.porsi_jasa, ap.porsi_denda, ap.sumber_dana
     FROM angsuran_pembayaran ap
     JOIN pinjaman p ON p.id = ap.pinjaman_id
     JOIN anggota a ON a.id = p.anggota_id
     LEFT JOIN journal j ON j.id = ap.journal_id
     WHERE ap.id = ?`,
    id
  );
  if (!r) return null;
  return {
    id: r.id,
    nomorBukti: r.nomor_bukti ?? '-',
    tanggal: r.tanggal,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    nomorPinjaman: r.nomor_pinjaman,
    jumlahPembayaran: r.nominal,
    porsiPokok: r.porsi_pokok,
    porsiJasa: r.porsi_jasa,
    porsiDenda: r.porsi_denda,
    sumberDana: r.sumber_dana,
    keterangan: `Angsuran pinjaman ${r.nomor_pinjaman}`,
  };
}

export interface BuktiBayarUtangRow {
  id: string;
  nomorBukti: string;
  tanggal: string;
  nomorUtang: string;
  namaPemberi: string;
  jenisPemberi: string;
  jumlahPembayaran: Rupiah;
  porsiPokok: Rupiah;
  porsiBunga: Rupiah;
  sumberDana: string;
  keterangan: string | null;
  dibuatOleh: string | null;
}

/**
 * Daftar "Bukti Bayar Utang" (update 6-perbaikan §2, permintaan
 * pengguna) — MURNI READ dari `utang_pembayaran` (transaksi asli
 * `UtangService.bayarUtang()`, TIDAK ADA transaksi baru yang dibuat di
 * sini sama sekali — pola SAMA PERSIS `listBuktiBayarPiutang` di atas).
 * Nomor bukti dari `nomor_transaksi` yang sudah dibuat saat pembayaran
 * aslinya terjadi (prefix 'KWJ', lihat `UtangService.bayarUtang`).
 */
export async function listBuktiBayarUtang(opts: { search?: string } = {}): Promise<BuktiBayarUtangRow[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: string[] = [];
  if (opts.search) {
    filters.push('(u.nama_pemberi LIKE ? OR u.nomor_utang LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s);
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const rows = await db.getAllAsync<any>(
    `SELECT up.id, up.nomor_transaksi as nomor_bukti, up.tanggal, u.nomor_utang, u.nama_pemberi, u.jenis_pemberi,
            up.pokok, up.bunga, up.sumber_dana, up.created_by, usr.nama as dibuat_oleh
     FROM utang_pembayaran up
     JOIN utang u ON u.id = up.utang_id
     LEFT JOIN app_user usr ON usr.id = up.created_by
     WHERE 1=1 ${where}
     ORDER BY up.tanggal DESC, up.created_at DESC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    nomorBukti: r.nomor_bukti ?? '-',
    tanggal: r.tanggal,
    nomorUtang: r.nomor_utang,
    namaPemberi: r.nama_pemberi,
    jenisPemberi: r.jenis_pemberi,
    jumlahPembayaran: r.pokok + r.bunga,
    porsiPokok: r.pokok,
    porsiBunga: r.bunga,
    sumberDana: r.sumber_dana,
    keterangan: `Pembayaran utang ${r.nomor_utang}`,
    dibuatOleh: r.dibuat_oleh ?? null,
  }));
}

/** Satu baris Bukti Bayar Utang berdasar id (dipakai layar detail). */
export async function getBuktiBayarUtangById(id: string): Promise<BuktiBayarUtangRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<any>(
    `SELECT up.id, up.nomor_transaksi as nomor_bukti, up.tanggal, u.nomor_utang, u.nama_pemberi, u.jenis_pemberi,
            up.pokok, up.bunga, up.sumber_dana, up.created_by, usr.nama as dibuat_oleh
     FROM utang_pembayaran up
     JOIN utang u ON u.id = up.utang_id
     LEFT JOIN app_user usr ON usr.id = up.created_by
     WHERE up.id = ?`,
    id
  );
  if (!r) return null;
  return {
    id: r.id,
    nomorBukti: r.nomor_bukti ?? '-',
    tanggal: r.tanggal,
    nomorUtang: r.nomor_utang,
    namaPemberi: r.nama_pemberi,
    jenisPemberi: r.jenis_pemberi,
    jumlahPembayaran: r.pokok + r.bunga,
    porsiPokok: r.pokok,
    porsiBunga: r.bunga,
    sumberDana: r.sumber_dana,
    keterangan: `Pembayaran utang ${r.nomor_utang}`,
    dibuatOleh: r.dibuat_oleh ?? null,
  };
}

export interface BuktiBayarSimpananRow {
  id: string;
  nomorBukti: string;
  tanggal: string;
  nomorAnggota: string;
  namaAnggota: string;
  jenisSimpanan: string;
  jumlah: Rupiah;
  sumberDana: string;
  keterangan: string | null;
}

/** Daftar "Bukti Bayar Simpanan Anggota" (§X) — dari simpanan_transaksi tipe SETOR (transaksi asli setorSimpanan). */
export async function listBuktiBayarSimpanan(opts: { search?: string } = {}): Promise<BuktiBayarSimpananRow[]> {
  const db = await getDb();
  const filters: string[] = [
    `st.tipe = 'SETOR'`,
    // BUG FIX (pola sama dengan SimpananService.getSaldoSimpanan,
    // Prioritas 3/E): keluarkan juga baris ASLI yang sudah dikoreksi
    // (bukan cuma baris koreksinya sendiri) — supaya setoran yang
    // sudah dibatalkan tidak tetap muncul sebagai kandidat cetak bukti.
    `st.reversal_of_id IS NULL`,
    `st.id NOT IN (SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL)`,
  ];
  const params: string[] = [];
  if (opts.search) {
    filters.push('(a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s);
  }
  const rows = await db.getAllAsync<any>(
    `SELECT st.id, st.nomor_transaksi, st.tanggal, a.nomor_anggota, a.nama_lengkap,
            st.jenis, st.nominal, st.sumber_dana, st.keterangan
     FROM simpanan_transaksi st
     JOIN anggota a ON a.id = st.anggota_id
     WHERE ${filters.join(' AND ')}
     ORDER BY st.tanggal DESC, st.created_at DESC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    nomorBukti: r.nomor_transaksi,
    tanggal: r.tanggal,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    jenisSimpanan: r.jenis,
    jumlah: r.nominal,
    sumberDana: r.sumber_dana,
    keterangan: r.keterangan,
  }));
}

/** Satu baris Bukti Bayar Simpanan berdasar id (dipakai layar detail). */
export async function getBuktiBayarSimpananById(id: string): Promise<BuktiBayarSimpananRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<any>(
    `SELECT st.id, st.nomor_transaksi, st.tanggal, a.nomor_anggota, a.nama_lengkap,
            st.jenis, st.nominal, st.sumber_dana, st.keterangan
     FROM simpanan_transaksi st
     JOIN anggota a ON a.id = st.anggota_id
     WHERE st.id = ?`,
    id
  );
  if (!r) return null;
  return {
    id: r.id,
    nomorBukti: r.nomor_transaksi,
    tanggal: r.tanggal,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    jenisSimpanan: r.jenis,
    jumlah: r.nominal,
    sumberDana: r.sumber_dana,
    keterangan: r.keterangan,
  };
}

/**
 * Rincian pencairan SIMPANAN BERJANGKA pada Bukti Tarik Simpanan.
 * Seluruh angka DIBACA dari transaksi yang sudah terjadi — jurnal
 * pencairan (`simpanan_berjangka.journal_pencairan_id`) dan, untuk
 * penarikan dini, baris settlement `simpanan_berjangka_pencairan_dini`.
 * Tidak ada perhitungan ulang bunga/penalti di sini.
 */
export interface RincianTarikBerjangka {
  jenisPencairan: 'JATUH_TEMPO' | 'DINI';
  nomorKontrak: string;
  tanggalMulai: string;
  tanggalJatuhTempo: string;
  tenorBulan: number;
  sukuBunga: number;
  /** Pokok simpanan yang dikembalikan (sebelum potongan). */
  pokok: Rupiah;
  /** Bunga yang dibayarkan pada pencairan ini (sebelum potongan). */
  bunga: Rupiah;
  /** PPh Pasal 4(2) atas bunga yang dipotong saat pencairan. */
  pphDipotong: Rupiah;
  penalti: Rupiah;
  biayaAdmin: Rupiah;
  /** Bunga yang hangus karena penarikan dini (informasi, tidak dibayar). */
  bungaHangus: Rupiah;
  /** Versi kebijakan penarikan dini yang dipakai (hanya DINI). */
  policyVersi: string | null;
}

export interface BuktiTarikSimpananRow {
  id: string;
  nomorBukti: string;
  tanggal: string;
  nomorAnggota: string;
  namaAnggota: string;
  jenisSimpanan: string;
  /** Uang yang benar-benar diterima anggota (neto). */
  jumlah: Rupiah;
  sumberDana: string;
  keterangan: string | null;
  /** Terisi HANYA untuk pencairan simpanan berjangka. */
  rincianBerjangka?: RincianTarikBerjangka | null;
}

function petakanTarikSukarela(r: any): BuktiTarikSimpananRow {
  return {
    id: r.id,
    nomorBukti: r.nomor_transaksi,
    tanggal: r.tanggal,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    jenisSimpanan: r.jenis,
    jumlah: r.nominal,
    sumberDana: r.sumber_dana,
    keterangan: r.keterangan,
    rincianBerjangka: null,
  };
}

async function listTarikSukarela(search?: string): Promise<BuktiTarikSimpananRow[]> {
  const db = await getDb();
  const filters: string[] = [
    `st.tipe = 'TARIK'`,
    `st.jenis = 'SUKARELA'`,
    // BUG FIX — sama seperti listBuktiBayarSimpanan di atas.
    `st.reversal_of_id IS NULL`,
    `st.id NOT IN (SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL)`,
    // RC-S128: baris TARIK hasil pemindahan bunga simpanan berjangka (neto
    // negatif karena potongan PPh susulan, RC-S127) bukan penarikan oleh
    // anggota — tidak ditampilkan sebagai Bukti Tarik.
    `(st.idempotency_key IS NULL OR st.idempotency_key NOT LIKE 'SBT-%')`,
  ];
  const params: string[] = [];
  if (search) {
    filters.push('(a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s);
  }
  const rows = await db.getAllAsync<any>(
    `SELECT st.id, st.nomor_transaksi, st.tanggal, a.nomor_anggota, a.nama_lengkap,
            st.jenis, st.nominal, st.sumber_dana, st.keterangan, st.created_at
     FROM simpanan_transaksi st
     JOIN anggota a ON a.id = st.anggota_id
     WHERE ${filters.join(' AND ')}
     ORDER BY st.tanggal DESC, st.created_at DESC`,
    ...params
  );
  return rows.map(petakanTarikSukarela);
}

// ------------------------------------------------------------------
// SIMPANAN BERJANGKA — pencairan jatuh tempo & penarikan dini
// ------------------------------------------------------------------

const SQL_TARIK_BERJANGKA = `SELECT k.id, k.nomor_transaksi, k.tanggal_mulai, k.tanggal_jatuh_tempo, k.tenor_bulan,
       k.suku_bunga, k.nominal, k.tanggal_pencairan, k.journal_pencairan_id, k.updated_at,
       a.nomor_anggota, a.nama_lengkap,
       j.nomor_referensi, j.nomor_jurnal, j.tanggal AS tanggal_jurnal,
       (SELECT COALESCE(SUM(je.debit), 0) FROM journal_entry je WHERE je.journal_id = j.id) AS total_debit,
       -- RC-S128: bunga yang dibayar pada jurnal pencairan = debit akun
       -- Utang Bunga (mapping pencairan), BUKAN total debit dikurangi pokok —
       -- jurnal bisa memuat debit lain (mis. pengembalian PPh).
       (SELECT COALESCE(SUM(je.debit), 0) FROM journal_entry je
         WHERE je.journal_id = j.id
           AND je.account_id IN (SELECT account_id FROM account_mapping
                                  WHERE transaction_type = 'SIMPANAN_BERJANGKA_PENCAIRAN' AND role = 'DEBIT_UTANG_BUNGA')) AS bunga_dibayar_jurnal,
       d.id AS dini_id, d.policy_versi, d.pokok_bruto, d.penalti, d.biaya_admin, d.bunga_hangus,
       d.total_payout, d.alasan
  FROM simpanan_berjangka k
  JOIN anggota a ON a.id = k.anggota_id
  JOIN journal j ON j.id = k.journal_pencairan_id AND j.status = 'POSTED'
  LEFT JOIN simpanan_berjangka_pencairan_dini d ON d.simpanan_berjangka_id = k.id
 WHERE k.status = 'DICAIRKAN'`;

/**
 * Baris Kas/Bank yang dikreditkan jurnal pencairan — sumber dana DAN
 * nominal yang benar-benar keluar kepada anggota. Kas = akun mapping
 * KAS_UMUM; Bank = akun buku besar milik salah satu `bank_account`.
 */
export async function bacaKasBankPencairan(journalId: string): Promise<{ kredit: Rupiah; label: string } | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ kredit: number; nama_bank: string | null; is_kas: number | null }>(
    `SELECT je.kredit,
            (SELECT b.nama_bank FROM bank_account b WHERE b.account_id = je.account_id ORDER BY b.nama_bank LIMIT 1) AS nama_bank,
            (SELECT 1 FROM account_mapping m
              WHERE m.transaction_type = 'KAS_UMUM' AND m.account_id = je.account_id LIMIT 1) AS is_kas
       FROM journal_entry je
      WHERE je.journal_id = ? AND je.kredit > 0
        AND (je.account_id IN (SELECT account_id FROM account_mapping WHERE transaction_type = 'KAS_UMUM')
             OR je.account_id IN (SELECT account_id FROM bank_account))
      ORDER BY je.kredit DESC LIMIT 1`,
    journalId
  );
  if (!r) return null;
  const label = r.is_kas ? 'KAS' : r.nama_bank ? `BANK - ${r.nama_bank}` : 'BANK';
  return { kredit: r.kredit, label };
}

async function petakanTarikBerjangka(r: any): Promise<BuktiTarikSimpananRow> {
  const kasBank = await bacaKasBankPencairan(r.journal_pencairan_id);
  const dini = r.dini_id != null;
  let pokok: Rupiah;
  let bunga: Rupiah;
  let pph = 0;
  let penalti = 0;
  let biayaAdmin = 0;
  let jumlah: Rupiah;
  if (dini) {
    // Identitas settlement: diterima = pokok + bunga − penalti − biaya.
    pokok = r.pokok_bruto;
    penalti = r.penalti ?? 0;
    biayaAdmin = r.biaya_admin ?? 0;
    jumlah = r.total_payout;
    bunga = jumlah - pokok + penalti + biayaAdmin;
  } else {
    // Jurnal pencairan normal: Dr pokok + Dr utang bunga = total bruto;
    // Cr Utang PPh 4(2) + Cr Kas/Bank (neto). PPh = bruto − neto.
    // RC-S128: bunga = debit Utang Bunga pada jurnal pencairan (untuk
    // kontrak berkebijakan nilainya 0 — bunga sudah di Simpanan Sukarela).
    // PPh = pokok + bunga − uang yang keluar dari Kas/Bank.
    pokok = r.nominal;
    bunga = r.bunga_dibayar_jurnal ?? 0;
    jumlah = kasBank ? kasBank.kredit : pokok + bunga;
    pph = pokok + bunga - jumlah;
  }
  const nomorBukti = r.nomor_referensi ?? r.nomor_jurnal ?? r.nomor_transaksi;
  return {
    id: r.id,
    nomorBukti,
    tanggal: r.tanggal_pencairan ?? r.tanggal_jurnal,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    jenisSimpanan: 'BERJANGKA',
    jumlah,
    sumberDana: kasBank?.label ?? '-',
    keterangan:
      (dini
        ? `Penarikan dini simpanan berjangka ${r.nomor_transaksi}`
        : `Pencairan simpanan berjangka ${r.nomor_transaksi} (jatuh tempo)`) +
      (dini && r.alasan ? ` — ${r.alasan}` : ''),
    rincianBerjangka: {
      jenisPencairan: dini ? 'DINI' : 'JATUH_TEMPO',
      nomorKontrak: r.nomor_transaksi,
      tanggalMulai: r.tanggal_mulai,
      tanggalJatuhTempo: r.tanggal_jatuh_tempo,
      tenorBulan: r.tenor_bulan,
      sukuBunga: r.suku_bunga,
      pokok,
      bunga,
      pphDipotong: pph,
      penalti,
      biayaAdmin,
      bungaHangus: dini ? (r.bunga_hangus ?? 0) : 0,
      policyVersi: dini ? r.policy_versi : null,
    },
  };
}

async function listTarikBerjangka(search?: string): Promise<BuktiTarikSimpananRow[]> {
  const db = await getDb();
  const params: string[] = [];
  let filter = '';
  if (search) {
    filter = ' AND (a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ? OR k.nomor_transaksi LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  const rows = await db.getAllAsync<any>(
    `${SQL_TARIK_BERJANGKA}${filter} ORDER BY k.tanggal_pencairan DESC, k.updated_at DESC`,
    ...params
  );
  const hasil: BuktiTarikSimpananRow[] = [];
  for (const r of rows) hasil.push(await petakanTarikBerjangka(r));
  return hasil;
}

/**
 * Daftar "Bukti Tarik Simpanan Anggota" (§G/§W, permintaan pengguna
 * update pasca-Phase 18/19). Dua sumber, keduanya transaksi yang SUDAH
 * terjadi (read-only, tidak membuat transaksi baru):
 *
 *  1. `simpanan_transaksi` tipe TARIK jenis SUKARELA — dicek eksplisit
 *     `st.jenis = 'SUKARELA'` (pokok/wajib tidak pernah ditarik selama
 *     masih anggota).
 *  2. Pencairan SIMPANAN BERJANGKA (jatuh tempo maupun penarikan dini)
 *     — kontrak berstatus DICAIRKAN dengan jurnal pencairan POSTED.
 *     Nominal = uang yang benar-benar diterima anggota (sesudah PPh
 *     4(2), penalti, dan biaya administrasi), rinciannya ikut dibawa.
 *
 * Diurutkan gabungan berdasarkan tanggal terbaru.
 */
export async function listBuktiTarikSimpanan(opts: { search?: string } = {}): Promise<BuktiTarikSimpananRow[]> {
  const [sukarela, berjangka] = await Promise.all([listTarikSukarela(opts.search), listTarikBerjangka(opts.search)]);
  return [...sukarela, ...berjangka].sort((x, y) => (x.tanggal < y.tanggal ? 1 : x.tanggal > y.tanggal ? -1 : 0));
}

/** Satu baris Bukti Tarik Simpanan berdasar id (sukarela ATAU simpanan berjangka) — dipakai layar detail. */
export async function getBuktiTarikSimpananById(id: string): Promise<BuktiTarikSimpananRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<any>(
    `SELECT st.id, st.nomor_transaksi, st.tanggal, a.nomor_anggota, a.nama_lengkap,
            st.jenis, st.nominal, st.sumber_dana, st.keterangan
     FROM simpanan_transaksi st
     JOIN anggota a ON a.id = st.anggota_id
     WHERE st.id = ? AND st.tipe = 'TARIK'`,
    id
  );
  if (r) return petakanTarikSukarela(r);
  const b = await db.getFirstAsync<any>(`${SQL_TARIK_BERJANGKA} AND k.id = ?`, id);
  return b ? petakanTarikBerjangka(b) : null;
}

export interface BuktiKeluarAnggotaRow {
  journalId: string;
  /**
   * RC-S76 — `keluar_anggota.id` asal bukti ini, dibaca dari
   * `journal.sumber_id`. Inilah satu-satunya tautan yang sah kembali ke
   * pengajuannya: mencocokkan lewat nama/tanggal/nominal akan salah
   * orang begitu ada dua anggota bernama sama atau dua pengajuan di
   * tanggal yang sama.
   *
   * `null` bila jurnalnya tidak menyimpan `sumber_id` (baris lama).
   * Pemanggil TIDAK boleh menebak — layar menampilkan keadaan aman.
   */
  sumberId: string | null;
  nomorBukti: string;
  tanggal: string;
  nomorAnggota: string;
  namaAnggota: string;
  totalDikembalikan: Rupiah;
  sumberDana: string;
  keterangan: string | null;
}

/**
 * Daftar "Bukti Keluar Anggota" (§Y) — dari jurnal KELUAR_ANGGOTA,
 * digabung per journal karena satu kejadian keluar anggota bisa terdiri
 * dari beberapa baris simpanan_transaksi (pokok+wajib+sukarela).
 *
 * RC-S76 — DUA JALUR PEMBAYARAN, SATU BUKTI.
 *
 * Ada dua cara jurnal KELUAR_ANGGOTA terbentuk, dan keduanya menulis
 * hal yang berbeda:
 *
 *   1. `keluarAnggota()` (jalur lama, bayar seketika) MENULIS baris
 *      `simpanan_transaksi` TARIK per jenis simpanan.
 *   2. `bayarKeluarAnggota()` (jalur persetujuan RC-S74/75) hanya
 *      menulis jurnal + memperbarui `keluar_anggota`; TIDAK ada baris
 *      `simpanan_transaksi`.
 *
 * Query ini semula `JOIN simpanan_transaksi`, sehingga pembayaran lewat
 * jalur (2) TIDAK PERNAH muncul sebagai bukti sama sekali — uang keluar
 * tanpa bukti yang dapat ditemukan pengurus. Karena itu JOIN-nya kini
 * LEFT, dan nilainya diambil dari `keluar_anggota` bila tersedia
 * (`j.sumber_id`), dengan agregasi `simpanan_transaksi` sebagai
 * cadangan untuk baris historis jalur (1).
 *
 * MURNI READ-ONLY: tidak ada kolom/tabel baru, tidak ada migrasi;
 * hanya cara membaca data yang sudah tersimpan.
 */
export async function listBuktiKeluarAnggota(opts: { search?: string } = {}): Promise<BuktiKeluarAnggotaRow[]> {
  const db = await getDb();
  const filters: string[] = [`j.sumber_transaksi = 'KELUAR_ANGGOTA'`];
  const params: string[] = [];
  if (opts.search) {
    // RC-S77 — pencarian harus membaca identitas anggota dari KEDUA
    // jalur pembayaran. Jalur lama (`keluarAnggota()`) menautkan anggota
    // lewat `simpanan_transaksi` (alias `a`); jalur persetujuan
    // (`bayarKeluarAnggota()`) tidak menulis baris itu sama sekali, dan
    // anggotanya hanya terbaca lewat `keluar_anggota` (alias `ka_a`).
    //
    // Memfilter `a.*` saja membuat bukti jalur persetujuan HILANG dari
    // hasil pencarian — padahal barisnya ada di daftar. COALESCE dipakai
    // dengan urutan yang SAMA seperti kolom yang ditampilkan
    // (`ka_a` lebih dulu), supaya yang dicari persis yang terlihat.
    filters.push(
      '(COALESCE(ka_a.nama_lengkap, a.nama_lengkap) LIKE ? OR COALESCE(ka_a.nomor_anggota, a.nomor_anggota) LIKE ?)'
    );
    const s = `%${opts.search}%`;
    params.push(s, s);
  }
  const rows = await db.getAllAsync<any>(
    `SELECT j.id as journal_id, j.nomor_referensi as nomor_bukti, j.tanggal,
            j.sumber_id as sumber_id, j.sumber_transaksi as sumber_transaksi,
            COALESCE(ka_a.nomor_anggota, a.nomor_anggota) as nomor_anggota,
            COALESCE(ka_a.nama_lengkap, a.nama_lengkap) as nama_lengkap,
            COALESCE(ka.nilai_pengembalian, SUM(st.nominal)) as total,
            COALESCE(ka.sumber_pembayaran, MAX(st.sumber_dana)) as sumber_dana,
            COALESCE(ka.keterangan, MAX(st.keterangan)) as keterangan
     FROM journal j
     LEFT JOIN simpanan_transaksi st ON st.journal_id = j.id
     LEFT JOIN anggota a ON a.id = st.anggota_id
     LEFT JOIN keluar_anggota ka
            ON ka.id = j.sumber_id AND j.sumber_transaksi = 'KELUAR_ANGGOTA'
     LEFT JOIN anggota ka_a ON ka_a.id = ka.anggota_id
     WHERE ${filters.join(' AND ')}
     GROUP BY j.id
     ORDER BY j.tanggal DESC`,
    ...params
  );
  return rows.map((r) => ({
    journalId: r.journal_id,
    sumberId: (r.sumber_id as string | null) ?? null,
    nomorBukti: r.nomor_bukti ?? '-',
    tanggal: r.tanggal,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    totalDikembalikan: r.total,
    sumberDana: r.sumber_dana,
    keterangan: r.keterangan,
  }));
}

/** Satu baris Bukti Keluar Anggota berdasar id journal (dipakai layar detail). */
export async function getBuktiKeluarAnggotaById(journalId: string): Promise<BuktiKeluarAnggotaRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<any>(
    `SELECT j.id as journal_id, j.nomor_referensi as nomor_bukti, j.tanggal,
            j.sumber_id as sumber_id, j.sumber_transaksi as sumber_transaksi,
            COALESCE(ka_a.nomor_anggota, a.nomor_anggota) as nomor_anggota,
            COALESCE(ka_a.nama_lengkap, a.nama_lengkap) as nama_lengkap,
            COALESCE(ka.nilai_pengembalian, SUM(st.nominal)) as total,
            COALESCE(ka.sumber_pembayaran, MAX(st.sumber_dana)) as sumber_dana,
            COALESCE(ka.keterangan, MAX(st.keterangan)) as keterangan
     FROM journal j
     LEFT JOIN simpanan_transaksi st ON st.journal_id = j.id
     LEFT JOIN anggota a ON a.id = st.anggota_id
     LEFT JOIN keluar_anggota ka
            ON ka.id = j.sumber_id AND j.sumber_transaksi = 'KELUAR_ANGGOTA'
     LEFT JOIN anggota ka_a ON ka_a.id = ka.anggota_id
     WHERE j.id = ?
     GROUP BY j.id`,
    journalId
  );
  if (!r) return null;
  // Tautan balik hanya dipercaya bila jurnalnya memang jurnal keluar
  // anggota. Jurnal lain yang kebetulan menyentuh simpanan_transaksi
  // punya `sumber_id` yang menunjuk tabel yang sama sekali berbeda;
  // meneruskannya sebagai id pengajuan akan membuka pengajuan yang salah.
  const sumberId =
    r.sumber_transaksi === 'KELUAR_ANGGOTA' ? ((r.sumber_id as string | null) ?? null) : null;
  return {
    journalId: r.journal_id,
    sumberId,
    nomorBukti: r.nomor_bukti ?? '-',
    tanggal: r.tanggal,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    totalDikembalikan: r.total,
    sumberDana: r.sumber_dana,
    keterangan: r.keterangan,
  };
}
