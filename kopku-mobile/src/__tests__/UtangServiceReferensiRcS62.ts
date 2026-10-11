/**
 * ============================================================
 * RC-S62 — SALINAN REFERENSI (HANYA UNTUK TEST KESETARAAN)
 * ============================================================
 *
 * Ini SALINAN PERSIS `src/services/UtangService.ts` pada keadaan
 * RC-S61, DIBEKUKAN sebelum optimisasi RC-S62. Tidak dipakai produksi
 * dan tidak boleh diimpor dari mana pun kecuali test.
 *
 * Gunanya satu: RC-S62 §8 mewajibkan hasil implementasi LAMA dan BARU
 * dibandingkan field demi field pada dataset yang sama. Tanpa salinan
 * ini, "identik" hanya klaim.
 *
 * JANGAN diperbarui mengikuti perubahan UtangService. Begitu ia ikut
 * berubah, ia berhenti menjadi referensi.
 *
 * LETAKNYA DI `src/__tests__/` DAN BUKAN `src/test-utils/` — disengaja.
 * Guard statis `UtangBungaGapControlRcS54` §3-4c memindai seluruh `src/`
 * dan `app/` di luar `__tests__` untuk memastikan `akruiBungaUtang()`
 * hanya dipanggil dari `UtangService.ts`. Salinan beku ini, sebagai
 * duplikat literal, akan terbaca sebagai pemanggil kedua dan memecahkan
 * guard itu. Guard-nya benar; yang salah adalah menaruh salinan test di
 * pohon yang dipindainya. Ekspektasi guard TIDAK diubah.
 * Berkas ini bukan suite: `testMatch` hanya mengambil `*.test.ts`.
 */

import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { checkPembayaranTidakMelebihiOutstanding } from '@/validators/BusinessRuleEngine';
import { requirePermission } from '@/services/PermissionService';
import { catatPengeluaran } from '@/services/KasBankService';
import { getAccountsUntukKewajiban } from '@/repositories/AccountRepository';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';

/**
 * Utang — pinjaman yang DITERIMA koperasi dari bank/pihak lain
 * (kebalikan dari `PinjamanService.ts` yang mencatat pinjaman yang
 * DIBERIKAN ke anggota). Dipakai oleh sub-fitur "Utang" (menu
 * Penerimaan) untuk mencatat penerimaannya, dan "Kewajiban" (menu
 * Pengeluaran) untuk mencatat pelunasannya — keduanya saling
 * terhubung lewat tabel `utang` yang sama: TransaksiPengeluaranScreen
 * > Kewajiban memilih salah satu record utang di sini, sisa pokoknya
 * dihitung otomatis dari histori pembayaran (bukan disimpan manual).
 */

/**
 * UTANG_USAHA = timbul OTOMATIS dari pembelian aset metode KREDIT
 * (lihat AsetService.beliAset) — bukan diinput manual lewat
 * terimaUtang(). Tetap muncul di listUtang()/UtangPicker & bisa
 * dilunasi lewat bayarUtang() seperti BANK/PIHAK_LAIN, supaya
 * sub-fitur "Kewajiban" benar-benar mendeteksi SEMUA utang koperasi,
 * bukan cuma yang diterima tunai.
 */
export type JenisPemberi = 'BANK' | 'PIHAK_LAIN' | 'UTANG_USAHA';
export type JenisBunga = 'FLAT' | 'EFEKTIF' | 'LAINNYA';
/** Basis kontraktual suku bunga (RC-S55 §2). NULL = belum ditentukan (data warisan). */
export type BasisBunga = 'TAHUNAN' | 'BULANAN';
/** Asal baris utang: LANGSUNG = diinput manual (sub-fitur "Utang"), PEMBELIAN_ASET = otomatis dari beliAset(). */
export type SumberUtang = 'LANGSUNG' | 'PEMBELIAN_ASET';

export interface TerimaUtangInput {
  namaPemberi: string;
  /** Sub-fitur "Utang" (Penerimaan) hanya untuk utang TUNAI — UTANG_USAHA timbul otomatis dari beliAset(), bukan di sini. */
  jenisPemberi: Exclude<JenisPemberi, 'UTANG_USAHA'>;
  pokokPinjaman: Rupiah;
  persenBunga: number;
  jenisBunga: JenisBunga;
  /**
   * RC-S55 §2 — BASIS KONTRAKTUAL suku bunga. WAJIB diisi kalau
   * `persenBunga > 0`: menyimpan angka bunga tanpa basisnya persis yang
   * membuat seluruh data warisan tidak bisa diakru otomatis. Boleh null
   * HANYA untuk utang tanpa bunga.
   */
  basisBunga?: BasisBunga | null;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
}

/** Terima utang baru (sub-fitur "Utang", Penerimaan): DEBIT Kas/Bank, KREDIT Utang Bank/Pihak Lain. */
export async function terimaUtang(input: TerimaUtangInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    /*
     * RC-S55 §2 — GERBANG BASIS BUNGA, DI LAPISAN SERVICE.
     *
     * Ditegakkan di sini dan bukan hanya di form, karena form bukan
     * satu-satunya pintu masuk (test, import, layar lain di masa depan).
     * Efeknya: sejak v69 tidak ada lagi baris `utang` BARU yang lahir
     * dengan bunga tetapi tanpa basis — populasi MANUAL_REVIEW_REQUIRED
     * hanya bisa mengecil, tidak pernah bertambah.
     */
    const basisBunga = input.persenBunga > 0 ? (input.basisBunga ?? null) : null;
    if (input.persenBunga > 0 && basisBunga === null) {
      throw new Error(
        'Basis bunga wajib dipilih (Per Tahun / Per Bulan) untuk utang yang berbunga.'
      );
    }
    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const utangTransactionType = input.jenisPemberi === 'BANK' ? 'UTANG_BANK' : 'UTANG_PIHAK_LAIN';
    const utangAccountId = await resolveAccountId(db, utangTransactionType, 'KREDIT_DEFAULT');

    const year = new Date(input.tanggal).getFullYear();
    const nomorUtang = await nextSequence(db, 'UTG', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: utangTransactionType,
      nomorReferensi: nomorUtang,
      deskripsi: `Penerimaan utang dari ${input.namaPemberi} - ${nomorUtang}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: kasBankAccountId, debit: input.pokokPinjaman, kredit: 0 },
        { accountId: utangAccountId, debit: 0, kredit: input.pokokPinjaman },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO utang
        (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga, jenis_bunga,
         basis_bunga, basis_bunga_diisi_oleh, basis_bunga_diisi_pada,
         tanggal, sumber_dana, bank_account_id, sumber, aset_tetap_id, status, keterangan, journal_id, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      nomorUtang,
      input.namaPemberi,
      input.jenisPemberi,
      input.pokokPinjaman,
      input.persenBunga,
      input.jenisBunga,
      basisBunga,
      basisBunga ? input.createdBy : null,
      basisBunga ? new Date().toISOString() : null,
      input.tanggal,
      input.sumberDana,
      input.bankAccountId ?? null,
      'LANGSUNG',
      null,
      'AKTIF',
      input.keterangan ?? null,
      journalId,
      input.createdBy,
      now,
      now
    );

    return { id, nomorUtang, journalId };
  });
}

/**
 * Helper internal (dipakai AsetService.beliAset() untuk pembelian aset
 * metode KREDIT) — insert satu baris `utang` jenis UTANG_USAHA TANPA
 * membuat jurnal sendiri, karena jurnalnya (Debit Aset Tetap, Kredit
 * Utang Usaha) sudah dibuat oleh pemanggil. Dipisah dari terimaUtang()
 * karena tidak ada kas/bank yang diterima (sumber_dana NULL) dan HARUS
 * satu transaksi DB dengan jurnal itu — `db` diteruskan dari luar,
 * bukan withTransaction sendiri di sini (pola sama seperti
 * AsetService.catatAsetTetapDariModalBarang).
 *
 * Ini yang menutup gap: sebelumnya utang usaha dari pembelian aset
 * kredit HANYA menjadi baris jurnal, tidak pernah muncul di
 * listUtang()/UtangPicker — jadi TIDAK BISA dilunasi lewat sub-fitur
 * "Kewajiban" sama sekali. Sekarang tercatat sebagai baris `utang`
 * biasa (jenis_pemberi = 'UTANG_USAHA'), terdeteksi otomatis.
 */
export async function catatUtangUsahaDariAset(
  db: SQLite.SQLiteDatabase,
  params: {
    namaPemasok: string;
    nilaiPerolehan: Rupiah;
    tanggal: string;
    journalId: string;
    asetTetapId: string;
    createdBy: string;
  }
): Promise<{ id: string; nomorUtang: string }> {
  const year = new Date(params.tanggal).getFullYear();
  const nomorUtang = await nextSequence(db, 'UTG', year);
  const id = newId();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO utang
      (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga, jenis_bunga,
       basis_bunga, tanggal, sumber_dana, bank_account_id, sumber, aset_tetap_id, status, keterangan, journal_id, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    nomorUtang,
    params.namaPemasok,
    'UTANG_USAHA',
    params.nilaiPerolehan,
    0,
    'LAINNYA',
    // Utang usaha memang tidak berbunga — basis bunga tidak berlaku.
    null,
    params.tanggal,
    null,
    null,
    'PEMBELIAN_ASET',
    params.asetTetapId,
    'AKTIF',
    'Timbul otomatis dari pembelian aset tetap secara kredit.',
    params.journalId,
    params.createdBy,
    now,
    now
  );
  return { id, nomorUtang };
}

export interface UtangListItem {
  id: string;
  nomorUtang: string;
  namaPemberi: string;
  jenisPemberi: JenisPemberi;
  sumber: SumberUtang;
  asetTetapId: string | null;
  pokokPinjaman: Rupiah;
  sisaPokok: Rupiah;
  persenBunga: number;
  jenisBunga: JenisBunga;
  /** `null` = basis belum ditentukan (data warisan) — lihat UtangBungaAccrualService. */
  basisBunga: BasisBunga | null;
  tanggal: string;
  status: 'AKTIF' | 'LUNAS';
  /** Update pasca-Phase 18/19 (permintaan pengguna §E): ditambahkan supaya Daftar Utang bisa menampilkan keterangan — kolom `utang.keterangan` sudah ada sejak awal, sebelumnya belum di-expose lewat listUtang(). */
  keterangan: string | null;
}

/**
 * Daftar utang berstatus AKTIF (yang masih ada sisa pokok) — dipakai
 * UtangPicker di form Kewajiban. Mencakup SEMUA jenis (BANK/PIHAK_LAIN
 * dari sub-fitur "Utang" manual, MAUPUN UTANG_USAHA yang timbul
 * otomatis dari pembelian aset kredit) — satu sumber data yang sama,
 * supaya "Kewajiban" benar-benar mendeteksi seluruh utang koperasi.
 *
 * DATE-SCOPING (Phase 17/§3): `opts.asOfDate` OPSIONAL. Ini yang
 * PALING AKURAT di antara tiga fungsi date-scoping Phase 17 — BEDA
 * dengan Aset/Investasi, Utang punya tabel `utang_pembayaran` dengan
 * `tanggal` per pembayaran (bisa berkali-kali/parsial), jadi
 * `sisaPokok` & `status` historis bisa dihitung PERSIS, bukan proksi:
 *  - Utang dengan `tanggal` > asOfDate TIDAK muncul (belum ada).
 *  - `sisaPokok` = pokok_pinjaman - SUM(pembayaran.pokok WHERE
 *    tanggal <= asOfDate) — bukan cumulative all-time.
 *  - `status` (field yang dikembalikan) DIHITUNG ULANG dari sisaPokok
 *    historis (<=0 -> 'LUNAS') KETIKA asOfDate diisi — BUKAN memakai
 *    kolom `utang.status` mentah (yang mencerminkan status HARI INI,
 *    persis bug yang diminta diperbaiki). Kalau `opts.status` diisi
 *    BERSAMAAN dengan asOfDate, filter memakai status historis
 *    hasil hitungan ini, bukan kolom mentah.
 *
 * TANPA asOfDate: perilaku PERSIS SAMA seperti sebelumnya (status &
 * sisaPokok current, dari kolom `utang.status` + cumulative all-time)
 * — kompatibel penuh dengan UtangPicker/DaftarUtangScreen yang memang
 * butuh kondisi TERKINI.
 */
export async function listUtang(
  opts: { status?: 'AKTIF' | 'LUNAS'; search?: string; asOfDate?: string; jenisPemberi?: JenisPemberi } = {}
): Promise<UtangListItem[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: (string | number)[] = [];

  // Filter status HANYA dipakai di SQL saat TIDAK ada asOfDate (status
  // kolom mentah = current, valid untuk kondisi sekarang). Saat ada
  // asOfDate, status historis dihitung di JS setelah query (lihat
  // bawah), jadi filter status diterapkan setelahnya, bukan di SQL.
  if (opts.status && !opts.asOfDate) {
    filters.push('u.status = ?');
    params.push(opts.status);
  }
  if (opts.search) {
    filters.push('(u.nama_pemberi LIKE ? OR u.nomor_utang LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s);
  }
  if (opts.asOfDate) {
    filters.push('u.tanggal <= ?');
    params.push(opts.asOfDate);
  }
  // Revisi KOPKU (Bagian 2): filter berdasarkan jenis pemberi — dipakai
  // BayarUtangFormScreen supaya UtangPicker hanya menampilkan utang
  // yang sesuai dengan akun COA Liabilitas yang dipilih user (mis.
  // pilih akun "Utang Bank" -> picker hanya berisi utang jenis BANK).
  if (opts.jenisPemberi) {
    filters.push('u.jenis_pemberi = ?');
    params.push(opts.jenisPemberi);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const pokokTerbayarSubquery = opts.asOfDate
    ? `(SELECT SUM(pokok) FROM utang_pembayaran WHERE utang_id = u.id AND tanggal <= ?)`
    : `(SELECT SUM(pokok) FROM utang_pembayaran WHERE utang_id = u.id)`;
  const subqueryParams = opts.asOfDate ? [opts.asOfDate] : [];

  const rows = await db.getAllAsync<any>(
    `SELECT u.*, COALESCE(${pokokTerbayarSubquery}, 0) as pokok_terbayar
     FROM utang u ${where} ORDER BY u.created_at DESC`,
    ...subqueryParams,
    ...params
  );

  let items = rows.map((r) => {
    const sisaPokok = r.pokok_pinjaman - r.pokok_terbayar;
    return {
      id: r.id,
      nomorUtang: r.nomor_utang,
      namaPemberi: r.nama_pemberi,
      jenisPemberi: r.jenis_pemberi,
      sumber: (r.sumber ?? 'LANGSUNG') as SumberUtang,
      asetTetapId: r.aset_tetap_id ?? null,
      pokokPinjaman: r.pokok_pinjaman,
      sisaPokok,
      persenBunga: r.persen_bunga,
      jenisBunga: r.jenis_bunga,
      basisBunga: (r.basis_bunga === 'TAHUNAN' || r.basis_bunga === 'BULANAN' ? r.basis_bunga : null) as BasisBunga | null,
      tanggal: r.tanggal,
      status: opts.asOfDate ? ((sisaPokok <= 0 ? 'LUNAS' : 'AKTIF') as 'AKTIF' | 'LUNAS') : (r.status as 'AKTIF' | 'LUNAS'),
      keterangan: r.keterangan ?? null,
    };
  });

  if (opts.status && opts.asOfDate) {
    items = items.filter((i) => i.status === opts.status);
  }

  return items;
}

export interface BayarUtangInput {
  utangId: string;
  tanggal: string;
  pokok: Rupiah;
  bunga: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  createdBy: string;
}

/**
 * Pelunasan/angsuran utang (sub-fitur "Kewajiban", Pengeluaran).
 * Pokok & bunga dipisah sesuai input user (bukan jadwal angsuran
 * otomatis seperti pinjaman ke anggota):
 *   DEBIT Utang (porsi pokok) + DEBIT Beban Bunga (porsi bunga)
 *   KREDIT Kas/Bank (pokok + bunga)
 */
export async function bayarUtang(input: BayarUtangInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    if (input.pokok < 0 || input.bunga < 0) throw new Error('Jumlah pokok/bunga tidak boleh negatif.');
    if (input.pokok + input.bunga <= 0) throw new Error('Jumlah pembayaran harus lebih dari 0.');

    const utang = await db.getFirstAsync<{
      nama_pemberi: string;
      jenis_pemberi: JenisPemberi;
      pokok_pinjaman: number;
      status: string;
    }>(`SELECT nama_pemberi, jenis_pemberi, pokok_pinjaman, status FROM utang WHERE id = ?`, input.utangId);
    // Angsuran bunga hanya berlaku untuk utang tunai (BANK/PIHAK_LAIN)
    // — utang usaha (pembelian aset kredit) TIDAK ada jasa/bunga sejak
    // awal timbulnya (lihat AsetService.beliAset), jadi ditolak di sini
    // supaya tidak diam-diam membuat beban bunga yang tidak seharusnya.
    if (!utang) throw new Error('Data utang tidak ditemukan.');
    if (utang.status === 'LUNAS') throw new Error('Utang ini sudah lunas.');
    if (utang.jenis_pemberi === 'UTANG_USAHA' && input.bunga > 0) {
      throw new Error('Utang usaha (pembelian aset) tidak memiliki komponen bunga.');
    }

    const terbayarRow = await db.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(pokok), 0) as total FROM utang_pembayaran WHERE utang_id = ?`,
      input.utangId
    );
    const sisaPokok = utang.pokok_pinjaman - (terbayarRow?.total ?? 0);
    const cekOutstanding = checkPembayaranTidakMelebihiOutstanding(input.pokok, sisaPokok);
    if (!cekOutstanding.valid) {
      throw new Error(`Pembayaran pokok (${input.pokok}) melebihi sisa pokok utang (${sisaPokok}).`);
    }

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    // Phase 4: rekening sumber pembayaran harus cukup saldonya.
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: input.pokok + input.bunga,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const utangTransactionType =
      utang.jenis_pemberi === 'BANK'
        ? 'UTANG_BANK'
        : utang.jenis_pemberi === 'PIHAK_LAIN'
        ? 'UTANG_PIHAK_LAIN'
        : 'UTANG_USAHA';
    const utangAccountId = await resolveAccountId(db, utangTransactionType, 'KREDIT_DEFAULT');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'KWJ', year);

    const lines: { accountId: string; debit: number; kredit: number }[] = [];
    if (input.pokok > 0) lines.push({ accountId: utangAccountId, debit: input.pokok, kredit: 0 });
    if (input.bunga > 0) {
      /**
       * RC-S53 §Z — DOUBLE EXPENSE DIPERBAIKI DI SINI.
       *
       * Sebelumnya baris ini SELALU men-debit Beban Bunga (5-1950).
       * Padahal `akruiBungaUtang()` sudah mengakui beban yang sama:
       *
       *     akrual    : Dr 5-1950 Beban Bunga   / Cr 2-1700 Utang Bunga
       *     pembayaran: Dr 5-1950 Beban Bunga   / Cr Kas/Bank   <-- SALAH
       *
       * Akibatnya bebannya terhitung DUA KALI, dan 2-1700 tidak pernah
       * berkurang sehingga membengkak selamanya. Yang benar:
       *
       *     pembayaran: Dr 2-1700 Utang Bunga   / Cr Kas/Bank
       *
       * PEMBAGIANNYA. Bunga yang dibayar dicocokkan dulu dengan bunga
       * yang BENAR-BENAR pernah diakru untuk utang ini. Sisanya — bunga
       * yang dibayar tanpa pernah diakru — tetap menjadi beban periode
       * berjalan, karena liabilitas untuk bagian itu memang tidak
       * pernah dibukukan. Tanpa pembagian ini, koperasi yang membayar
       * bunga langsung (tanpa memakai form akrual) akan menghasilkan
       * saldo 2-1700 NEGATIF — menukar satu bug dengan bug lain.
       *
       * Jadi beban hanya muncul SEKALI, di salah satu dari dua titik,
       * tidak pernah di keduanya.
       */
      const rekon = await getRekonsiliasiBungaUtang(db, input.utangId);
      const { keUtangBunga, keBeban } = bagiPembayaranBunga(input.bunga, rekon.outstanding);

      if (keUtangBunga > 0) {
        const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');
        lines.push({ accountId: utangBungaAccountId, debit: keUtangBunga, kredit: 0 });
      }
      if (keBeban > 0) {
        const bebanBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'DEBIT_BEBAN');
        lines.push({ accountId: bebanBungaAccountId, debit: keBeban, kredit: 0 });
      }
    }
    lines.push({ accountId: kasBankAccountId, debit: 0, kredit: input.pokok + input.bunga });

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: utangTransactionType,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Pelunasan utang ${utang.nama_pemberi} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines,
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO utang_pembayaran
        (id, utang_id, tanggal, pokok, bunga, sumber_dana, bank_account_id, nomor_transaksi, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.utangId,
      input.tanggal,
      input.pokok,
      input.bunga,
      input.sumberDana,
      input.bankAccountId ?? null,
      nomorTransaksi,
      journalId,
      input.createdBy,
      now
    );

    const sisaSetelahBayar = sisaPokok - input.pokok;
    if (sisaSetelahBayar <= 0) {
      await db.runAsync(`UPDATE utang SET status = 'LUNAS', updated_at = ? WHERE id = ?`, now, input.utangId);
    }

    return { id, nomorTransaksi, journalId, sisaPokokSetelah: Math.max(0, sisaSetelahBayar) };
  });
}

/**
 * ============================================================
 * PERAN FUNGSI AKRUAL BUNGA UTANG (RC-S57 §2 — diperbarui)
 * ============================================================
 *
 * Komentar asli blok ini (Prioritas 10/L) menjelaskan form akrual MANUAL
 * sebagai satu-satunya cara mengakui bunga, dengan nominal diketik
 * pengurus. Itu sudah tidak berlaku sejak RC-S55. Peran saat ini:
 *
 *   NORMAL    `UtangBungaAccrualService.jalankanAkrualBungaUtangJikaPerlu()`
 *             -> akrual OTOMATIS bulanan dari data kontrak (WHOLE_MONTH),
 *                dipicu StartupTasks dan layar kontrol. Tidak ada input
 *                nominal dari pengguna.
 *   PRIMARY   `penyesuaianManualBungaUtang()` (di bawah)
 *   (manual)  -> penyesuaian manual TERAUDIT: alasan wajib, alasan ikut
 *                deskripsi jurnal. Hanya untuk pengecualian (mis. pengganti
 *                akrual yang direversal, jenis bunga LAINNYA).
 *   EXCEPTION `akruiBungaUtang()` (fungsi ini)
 *   (legacy)  -> jalur manual lama berbasis TARGET per periode dengan gap
 *                control. DIPERTAHANKAN karena menjadi mesin pembukuan di
 *                bawah `penyesuaianManualBungaUtang()` dan dipakai test
 *                regresi. Tidak dipanggil layar mana pun dan TIDAK pernah
 *                dipanggil pemicu otomatis (dikunci test statis RC-S57).
 *
 * Jurnalnya sama: DEBIT Beban Bunga (role DEBIT_BEBAN), KREDIT Utang Bunga
 * (role KREDIT_AKRUAL), non-kas, `sumber_transaksi = 'UTANG_BUNGA'`,
 * `sumber_id = utang_id` — identitas yang sama dengan jurnal otomatis,
 * sehingga gap control melihat keduanya dan tidak ada rupiah yang diakui
 * dua kali.
 *
 * PEMBAYARAN. Bunga dibayar lewat `bayarUtang()`, yang membagi porsi bunga
 * dengan `bagiPembayaranBunga()`: bagian yang sudah diakrual mengurangi
 * Utang Bunga, sisanya (belum pernah diakrual) menjadi beban saat bayar.
 * (Komentar lama yang menyatakan pelunasan harus lewat Kas & Bank umum,
 * "BUKAN lewat bayarUtang()", sudah usang sejak RC-S53 §Z.)
 */
export interface AkruiBungaUtangInput {
  utangId: string;
  tanggal: string;
  /**
   * TARGET bunga untuk periode `tanggal` (YYYY-MM), bukan selisih yang
   * ingin dijurnal. Service yang menghitung gap-nya — lihat catatan gap
   * control di dalam `akruiBungaUtang()`.
   */
  nominal: Rupiah;
  keterangan?: string;
  createdBy: string;
}

export interface HasilAkrualBungaUtang {
  /** `null` bila tidak ada yang perlu dibukukan (gap = 0). */
  readonly journalId: string | null;
  /** Kunci periode yang dipakai gap control, 'YYYY-MM'. */
  readonly periodeKey: string;
  /** Target bunga periode ini (= `input.nominal`). */
  readonly target: Rupiah;
  /** Bunga periode ini yang sudah diakui SEBELUM pemanggilan ini (akrual bersih + dibebankan saat bayar). */
  readonly sudahDiakui: Rupiah;
  /** Selisih yang benar-benar dijurnal sekarang. */
  readonly dibukukanSekarang: Rupiah;
}

export async function akruiBungaUtang(
  input: AkruiBungaUtangInput
): Promise<HasilAkrualBungaUtang> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    if (!Number.isFinite(input.nominal) || input.nominal <= 0) {
      throw new Error('Nominal akrual bunga harus lebih dari 0.');
    }

    const utang = await db.getFirstAsync<{ nama_pemberi: string; jenis_pemberi: JenisPemberi; status: string }>(
      `SELECT nama_pemberi, jenis_pemberi, status FROM utang WHERE id = ?`,
      input.utangId
    );
    if (!utang) throw new Error('Data utang tidak ditemukan.');
    if (utang.status === 'LUNAS') throw new Error('Utang ini sudah lunas — tidak ada lagi bunga berjalan.');
    if (utang.jenis_pemberi === 'UTANG_USAHA') {
      throw new Error('Utang usaha (pembelian aset) tidak memiliki komponen bunga.');
    }

    const bebanBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'DEBIT_BEBAN');
    const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');

    /**
     * RC-S53 §Z — GAP CONTROL PER PERIODE.
     *
     * `input.nominal` dibaca sebagai TARGET bunga periode ini, bukan
     * "jumlah yang ingin dijurnal". Yang dibukukan hanya SELISIHNYA
     * terhadap yang sudah diakui untuk periode yang sama:
     *
     *     target 1.000.000, sudah   700.000 -> jurnal 300.000
     *     target 1.000.000, sudah 1.000.000 -> tidak ada jurnal
     *
     * Pembacaan ini mengikuti cara nominal tersebut memang dipakai:
     * pengurus menghitung bunga berjalan periode itu lalu memasukkan
     * totalnya. Sebelum RC-S53, memasukkan angka yang sama dua kali
     * menghasilkan beban dua kali.
     *
     * MENGGANTIKAN guard double-submit Tranche 2, yang hanya menolak
     * kombinasi tanggal + nominal identik dan tetap lolos untuk akrual
     * 1.000.000 dua kali dengan tanggal berbeda di bulan yang sama —
     * justru kasus yang paling mungkin terjadi. Guard lama DIHAPUS,
     * bukan ditumpuk, karena gap control menutup keduanya.
     */
    const periodeKey = periodeKeyDariTanggal(input.tanggal);
    const gap = await getGapAkrualBungaUtangPadaDb(db, input.utangId, periodeKey, input.nominal);

    if (gap.sisaGap <= 0) {
      // BUKAN error. Memanggil ulang dengan target yang sama adalah
      // perilaku normal (retry, dua pemicu, catch-up); jawabannya
      // "tidak ada yang perlu dibukukan", bukan kegagalan.
      return {
        journalId: null,
        periodeKey,
        target: input.nominal,
        sudahDiakui: gap.akrualBersih + gap.dibebankanSaatBayar,
        dibukukanSekarang: 0,
      };
    }
    const nominalDibukukan = gap.sisaGap;

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'AKB', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'UTANG_BUNGA',
      sumberId: input.utangId,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Akrual bunga utang ${utang.nama_pemberi}${input.keterangan ? ` - ${input.keterangan}` : ''} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: bebanBungaAccountId, debit: nominalDibukukan, kredit: 0 },
        { accountId: utangBungaAccountId, debit: 0, kredit: nominalDibukukan },
      ],
    });

    return {
      journalId,
      periodeKey,
      target: input.nominal,
      sudahDiakui: gap.akrualBersih + gap.dibebankanSaatBayar,
      dibukukanSekarang: nominalDibukukan,
    };
  });
}

/**
 * PEMBAGIAN PEMBAYARAN BUNGA (RC-S53 §Z).
 *
 * Dipisahkan sebagai fungsi MURNI dengan sengaja: inilah satu aturan
 * yang menentukan apakah beban terhitung sekali atau dua kali, dan ia
 * harus dapat diuji tanpa database, tanpa jurnal, dan tanpa mock.
 *
 * Invarian yang dijaga:
 *   keUtangBunga + keBeban === bungaDibayar   (tidak ada rupiah hilang)
 *   keUtangBunga <= outstanding               (liabilitas tak pernah negatif)
 *   keduanya >= 0
 */
export function bagiPembayaranBunga(
  bungaDibayar: Rupiah,
  outstandingAkrual: Rupiah
): { readonly keUtangBunga: Rupiah; readonly keBeban: Rupiah } {
  const dibayar = bungaDibayar > 0 ? bungaDibayar : 0;
  const tersedia = outstandingAkrual > 0 ? outstandingAkrual : 0;
  const keUtangBunga = Math.min(dibayar, tersedia);
  return { keUtangBunga, keBeban: dibayar - keUtangBunga };
}

/**
 * KUNCI PERIODE AKRUAL BUNGA UTANG (RC-S53 §Z).
 *
 * Diturunkan dari tanggal jurnal, BUKAN disimpan sebagai kolom baru.
 * Konsekuensinya penting: seluruh jurnal akrual yang SUDAH ADA di
 * database lama langsung ikut terhitung oleh gap control, tanpa
 * migration dan tanpa backfill yang bisa salah.
 *
 * Granularitasnya BULANAN karena itulah satuan periode yang dipakai
 * layar akrual dan contoh yang diminta ('2026-09'). Ia identitas
 * TEKNIS, bukan kebijakan akuntansi: tanggal jurnalnya sendiri tidak
 * berubah dan tetap menentukan periode buku.
 */
export interface DiagnostikUtangBungaBaris {
  readonly utangId: string;
  readonly nomorUtang: string;
  readonly namaPemberi: string;
  readonly totalAkrual: Rupiah;
  readonly totalDibayar: Rupiah;
  readonly totalReversal: Rupiah;
  /** Yang SEHARUSNYA tersisa: akrual bersih dikurangi pembayaran. */
  readonly outstandingSeharusnya: Rupiah;
  /** Yang benar-benar terbaca di buku besar 2-1700 untuk utang ini. */
  readonly saldoLedger: Rupiah;
  /** saldoLedger - outstandingSeharusnya. > 0 berarti ledger overstated. */
  readonly selisih: Rupiah;
  /** Periode (YYYY-MM) yang punya pembayaran bunga warisan. */
  readonly periodeTerdampak: readonly string[];
  /** Jurnal pembayaran yang tidak pernah mendebit 2-1710/2-1700. */
  readonly jurnalPenyebab: readonly { journalId: string; nomorJurnal: string; tanggal: string; bunga: Rupiah }[];
}

export interface DiagnostikUtangBungaHistoris {
  readonly totalAkrual: Rupiah;
  readonly totalDibayar: Rupiah;
  readonly totalReversal: Rupiah;
  readonly outstandingSeharusnya: Rupiah;
  readonly saldoLedger: Rupiah;
  readonly selisih: Rupiah;
  readonly adaSelisih: boolean;
  readonly perUtang: readonly DiagnostikUtangBungaBaris[];
  /** Usulan nominal koreksi — PROPOSAL saja, tidak pernah dijurnal. */
  readonly usulanKoreksi: Rupiah;
}

/**
 * DIAGNOSTIK SELISIH UTANG BUNGA WARISAN (RC-S53 §Z, read-only).
 *
 * LATAR BELAKANG. Sebelum RC-S53, `bayarUtang()` selalu men-debit BEBAN
 * BUNGA saat membayar bunga, bukan Utang Bunga. Akibatnya pada database
 * yang sudah berjalan: beban terhitung dua kali, dan 2-1700 tidak pernah
 * berkurang walaupun bunganya sudah lunas. Perbaikan RC-S53 menghentikan
 * pendarahannya, tetapi TIDAK menyentuh saldo yang sudah terlanjur —
 * memperbaiki saldo tanpa jurnal adalah persis yang dilarang.
 *
 * Fungsi ini HANYA MEMBACA. Tidak ada satu pun UPDATE/DELETE/INSERT di
 * sini, dan tidak ada jurnal koreksi yang dibuat. Nominal koreksi
 * disajikan sebagai USULAN supaya pengurus dapat menerbitkan jurnal
 * koreksi secara sadar, dengan tanggal dan kebijakan yang mereka pilih.
 *
 * Kenapa "dibayar" dibaca dari `utang_pembayaran` dan bukan dari ledger:
 * jurnal pembayaran warisan tidak menyentuh 2-1700 sama sekali, jadi
 * ledger tidak menyimpan jejaknya. `utang_pembayaran.bunga` mencatatnya
 * dengan benar sejak awal — ia satu-satunya sumber yang utuh.
 */
export async function getDiagnostikUtangBungaHistoris(): Promise<DiagnostikUtangBungaHistoris> {
  const db = await getDb();
  const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');

  const daftar = await db.getAllAsync<{ id: string; nomor_utang: string; nama_pemberi: string }>(
    `SELECT id, nomor_utang, nama_pemberi FROM utang ORDER BY tanggal ASC`
  );

  const perUtang: DiagnostikUtangBungaBaris[] = [];
  for (const u of daftar) {
    const akrual = await db.getFirstAsync<{ kredit: number; debit: number }>(
      `SELECT COALESCE(SUM(je.kredit),0) kredit, COALESCE(SUM(je.debit),0) debit
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND j.sumber_transaksi = 'UTANG_BUNGA'
          AND j.sumber_id = ? AND j.status IN ('POSTED','REVERSED')`,
      utangBungaAccountId,
      u.id
    );
    const totalAkrual = akrual?.kredit ?? 0;
    const totalReversal = akrual?.debit ?? 0;

    const replay = await replayBungaUtang(db, u.id);
    const totalDibayar = replay.totalDibayar;

    /**
     * Saldo 2-1700 yang benar-benar terbentuk dari transaksi utang INI.
     *
     * Atribusinya harus lewat DUA jalur, karena jurnalnya memang dibuat
     * dengan dua cara berbeda:
     *   - jurnal AKRUAL membawa `sumber_id` = id utang;
     *   - jurnal PEMBAYARAN tidak membawa `sumber_id` sama sekali, dan
     *     satu-satunya kaitannya ke utang adalah lewat
     *     `utang_pembayaran.journal_id`.
     *
     * Kalau hanya jalur pertama dipakai, debit dari pembayaran yang SUDAH
     * benar (pasca RC-S53) tidak terhitung, dan diagnostik akan
     * melaporkan selisih palsu pada data yang sebenarnya sehat.
     */
    const ledger = await db.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.kredit - je.debit),0) total
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ?
          AND j.status IN ('POSTED','REVERSED')
          AND (
            j.sumber_id = ?
            OR j.id IN (SELECT journal_id FROM utang_pembayaran WHERE utang_id = ?)
          )`,
      utangBungaAccountId,
      u.id,
      u.id
    );
    const saldoLedger = ledger?.total ?? 0;
    // RC-S54 TAHAP 10 — dulu `totalAkrual - totalReversal - totalDibayar`:
    // kelebihan bayar resmi (dibebankan saat bayar) terbaca sebagai selisih
    // palsu (probe P4: selisih 50.000 pada data sehat). Sekarang hanya
    // bagian yang memang mengurangi 2-1700 menurut aturan pembagian.
    const outstandingSeharusnya = totalAkrual - totalReversal - replay.diterapkanKeUtangBunga;

    // Pembayaran yang SEHARUSNYA mengurangi 2-1700 (menurut replay) tetapi
    // jurnalnya tidak mendebit 2-1700 sebesar itu — tanda jurnal warisan
    // yang men-debit beban. RC-S54 Tahap 10: pembayaran yang memang
    // seluruhnya dibebankan (tanpa akrual) tidak lagi dituduh sebagai penyebab.
    const penyebab: { journal_id: string; nomor_jurnal: string; tanggal: string; bunga: number }[] = [];
    for (const b of replay.pembayaran) {
      if (b.keUtangBunga <= 0 || !b.journalId) continue;
      const j = await db.getFirstAsync<{ nomor_jurnal: string; debit: number }>(
        `SELECT j.nomor_jurnal, COALESCE((SELECT SUM(je.debit) FROM journal_entry je WHERE je.journal_id = j.id AND je.account_id = ?), 0) AS debit
           FROM journal j WHERE j.id = ?`,
        utangBungaAccountId,
        b.journalId
      );
      if (j && j.debit < b.keUtangBunga) {
        penyebab.push({ journal_id: b.journalId, nomor_jurnal: j.nomor_jurnal, tanggal: b.tanggal, bunga: b.bunga });
      }
    }
    penyebab.sort((x, y) => (x.tanggal < y.tanggal ? -1 : x.tanggal > y.tanggal ? 1 : 0));

    const selisih = saldoLedger - outstandingSeharusnya;
    if (selisih === 0 && totalAkrual === 0 && totalDibayar === 0) continue;

    perUtang.push({
      utangId: u.id,
      nomorUtang: u.nomor_utang,
      namaPemberi: u.nama_pemberi,
      totalAkrual,
      totalDibayar,
      totalReversal,
      outstandingSeharusnya,
      saldoLedger,
      selisih,
      periodeTerdampak: [...new Set(penyebab.map((x) => periodeKeyDariTanggal(x.tanggal)))],
      jurnalPenyebab: penyebab.map((x) => ({
        journalId: x.journal_id,
        nomorJurnal: x.nomor_jurnal,
        tanggal: x.tanggal,
        bunga: x.bunga,
      })),
    });
  }

  const jumlah = (ambil: (b: DiagnostikUtangBungaBaris) => number): number =>
    perUtang.reduce((t, b) => t + ambil(b), 0);

  const selisihTotal = jumlah((b) => b.selisih);
  return {
    totalAkrual: jumlah((b) => b.totalAkrual),
    totalDibayar: jumlah((b) => b.totalDibayar),
    totalReversal: jumlah((b) => b.totalReversal),
    outstandingSeharusnya: jumlah((b) => b.outstandingSeharusnya),
    saldoLedger: jumlah((b) => b.saldoLedger),
    selisih: selisihTotal,
    adaSelisih: selisihTotal !== 0,
    perUtang,
    // PROPOSAL, bukan perintah. Tidak ada jurnal yang dibuat di mana pun
    // dalam fungsi ini.
    usulanKoreksi: selisihTotal,
  };
}

/**
 * PENYESUAIAN MANUAL TERKONTROL (RC-S55 §16).
 *
 * `akruiBungaUtang()` di atas TIDAK dihapus dan tidak berubah perilakunya —
 * banyak pemanggil & test yang sah masih bergantung padanya, dan gap
 * control-nya memang benar. Yang berubah adalah KEDUDUKANNYA: ia bukan
 * lagi cara normal mencatat akrual rutin (itu sekarang tugas
 * `UtangBungaAccrualService`), melainkan jalur EXCEPTION.
 *
 * CATATAN RC-S57: saat ini TIDAK ADA layar yang memanggil fungsi ini —
 * layar "Akrual & Kontrol Bunga Utang" hanya memantau dan memicu mesin
 * otomatis. Fungsi ini adalah API penyesuaian yang tersedia di lapisan
 * service (dan diuji), bukan fitur UI. Ia lebih ketat dari jalur lama
 * dalam satu hal yang penting: ALASAN WAJIB. Penyesuaian manual atas angka
 * yang dihasilkan mesin harus bisa dipertanggungjawabkan bertahun-tahun
 * kemudian, dan alasan itu ikut masuk ke deskripsi jurnal sehingga terbaca
 * langsung di Buku Besar — bukan hanya di tabel audit terpisah.
 *
 * Ia TIDAK mengedit jurnal yang sudah posted dan tidak menghapus apa pun:
 * seluruh pembukuan tetap lewat `akruiBungaUtang()` -> `createJournal()`,
 * yang hanya menambahkan selisih terhadap yang sudah diakui.
 */
export async function penyesuaianManualBungaUtang(input: {
  utangId: string;
  tanggal: string;
  /** TARGET total bunga periode tersebut, bukan selisih. */
  nominalTarget: Rupiah;
  alasan: string;
  createdBy: string;
}): Promise<HasilAkrualBungaUtang> {
  const alasan = input.alasan?.trim() ?? '';
  if (alasan.length < 5) {
    throw new Error('Alasan penyesuaian manual wajib diisi (minimal 5 karakter).');
  }
  return akruiBungaUtang({
    utangId: input.utangId,
    tanggal: input.tanggal,
    nominal: input.nominalTarget,
    keterangan: `Penyesuaian manual: ${alasan}`,
    createdBy: input.createdBy,
  });
}

/**
 * ============================================================
 * RC-S55 §4 — MELENGKAPI BASIS BUNGA UTANG WARISAN
 * ============================================================
 *
 * Seluruh baris `utang` yang dibuat sebelum v69 tidak menyimpan basis
 * suku bunganya, dan karena itu dilewati mesin akrual otomatis. Fungsi
 * ini adalah SATU-SATUNYA jalan sah untuk melengkapinya — tanpa membuat
 * pengurus menghapus lalu membuat ulang utangnya (yang akan memutus
 * seluruh histori pembayaran & jurnalnya).
 *
 * YANG DIUBAH: hanya `basis_bunga` beserta jejak siapa/kapan mengisinya.
 *
 * YANG TIDAK DIUBAH, DAN INI YANG PENTING: tidak ada jurnal yang dibuat,
 * dibatalkan, atau disentuh; tidak ada akrual retroaktif yang langsung
 * diterbitkan. Melengkapi basis bunga hanya membuat utang itu ELIGIBLE.
 * Akrual periode-periode yang tertinggal baru terjadi lewat mesin
 * otomatis, dengan seluruh aturannya tetap berlaku — termasuk larangan
 * memposting ke periode yang sudah CLOSED.
 *
 * SEKALI ISI, BUKAN EDIT BEBAS. Basis bunga adalah FAKTA KONTRAKTUAL,
 * bukan preferensi. Mengubahnya setelah ada akrual yang terbit akan
 * membuat jurnal lama dan jurnal baru berdiri di atas dua kontrak yang
 * berbeda tanpa jejak — jadi perubahan ditolak kalau utang ini sudah
 * pernah diakru. Koreksi semacam itu harus lewat reversal/adjustment.
 */
export async function assertKontrakBungaBolehDiubah(
  db: SQLite.SQLiteDatabase,
  utangId: string,
  namaFakta: string
): Promise<void> {
  const adaAkrual = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM utang_bunga_akrual WHERE utang_id = ?`,
    utangId
  );
  if ((adaAkrual?.n ?? 0) > 0) {
    throw new Error(
      `${namaFakta} tidak dapat diubah karena utang ini sudah memiliki akrual yang terbukukan. ` +
        'Gunakan pembalikan (reversal) dan jurnal penyesuaian bila kontraknya memang berbeda.'
    );
  }
}

export async function lengkapiBasisBungaUtang(input: {
  utangId: string;
  basisBunga: BasisBunga;
  createdBy: string;
}): Promise<{ diubah: boolean; basisBunga: BasisBunga }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit');
    if (input.basisBunga !== 'TAHUNAN' && input.basisBunga !== 'BULANAN') {
      throw new Error('Basis bunga harus "TAHUNAN" atau "BULANAN".');
    }

    const utang = await db.getFirstAsync<{
      nama_pemberi: string;
      jenis_pemberi: JenisPemberi;
      persen_bunga: number;
      basis_bunga: string | null;
    }>(
      `SELECT nama_pemberi, jenis_pemberi, persen_bunga, basis_bunga FROM utang WHERE id = ?`,
      input.utangId
    );
    if (!utang) throw new Error('Data utang tidak ditemukan.');
    if (utang.jenis_pemberi === 'UTANG_USAHA') {
      throw new Error('Utang usaha (pembelian aset) tidak memiliki komponen bunga.');
    }
    if (!(utang.persen_bunga > 0)) {
      throw new Error('Utang ini tidak berbunga — basis bunga tidak berlaku.');
    }
    if (utang.basis_bunga === input.basisBunga) {
      return { diubah: false, basisBunga: input.basisBunga };
    }

    if (utang.basis_bunga) {
      await assertKontrakBungaBolehDiubah(db, input.utangId, 'Basis bunga');
    }

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE utang SET basis_bunga = ?, basis_bunga_diisi_oleh = ?, basis_bunga_diisi_pada = ?, updated_at = ?
        WHERE id = ?`,
      input.basisBunga,
      input.createdBy,
      now,
      now,
      input.utangId
    );

    // Jejak permanen di audit_log — pertanyaan "siapa yang menetapkan
    // bunga ini tahunan?" harus bisa dijawab bertahun-tahun kemudian.
    const stempel = new Date();
    await db.runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(),
      input.createdBy,
      stempel.toISOString().slice(0, 10),
      stempel.toISOString().slice(11, 19),
      'UPDATE',
      'utang',
      input.utangId,
      JSON.stringify({ basisBunga: utang.basis_bunga }),
      JSON.stringify({ basisBunga: input.basisBunga, persenBunga: utang.persen_bunga }),
      stempel.toISOString()
    );

    return { diubah: true, basisBunga: input.basisBunga };
  });
}

export function periodeKeyDariTanggal(tanggal: string): string {
  return tanggal.slice(0, 7);
}

export interface GapAkrualBungaUtang {
  readonly utangId: string;
  readonly periodeKey: string;
  /** Target yang diminta pemanggil untuk periode ini. */
  readonly target: Rupiah;
  /** Kredit dikurangi debit 2-1700 pada periode ini — sudah bersih dari reversal. */
  readonly akrualBersih: Rupiah;
  /**
   * RC-S54 TAHAP 10 — bunga periode ini yang SUDAH menjadi beban saat
   * dibayar tanpa akrual (`bayarUtang` bagian `keBeban`, tanggal bayar di
   * periode ini). Ikut dihitung sebagai "sudah diakui" supaya akrual
   * berikutnya di periode yang sama tidak membebankannya lagi.
   */
  readonly dibebankanSaatBayar: Rupiah;
  /** Selisih yang masih boleh diakui; tidak pernah negatif. */
  readonly sisaGap: Rupiah;
  /** `true` bila akrual periode ini sudah melampaui target. */
  readonly melebihiTarget: boolean;
}

/**
 * GAP AKRUAL SATU PERIODE.
 *
 * Identitas logisnya `utang_id + period_key + accrual_type`, ketiganya
 * dibaca dari jurnal: `sumber_id`, bulan dari `tanggal`, dan
 * `sumber_transaksi = 'UTANG_BUNGA'`.
 *
 * REVERSAL. Jurnal pembalik membawa `sumber_id` yang sama dengan debit/
 * kredit ditukar, sehingga `SUM(kredit - debit)` menghasilkan nol untuk
 * akrual yang dibatalkan. Periodenya diambil dari jurnal ASAL
 * (`reversal_of_id`) — RC-S54 Tahap 10 Fix A; tanggal jurnal pembalik
 * sendiri adalah tanggal reversal dilakukan.
 */
export async function getGapAkrualBungaUtangPadaDb(
  db: SQLite.SQLiteDatabase,
  utangId: string,
  periodeKey: string,
  target: Rupiah
): Promise<GapAkrualBungaUtang> {
  const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');
  const bebanBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'DEBIT_BEBAN');
  /*
   * RC-S54 TAHAP 10 — FIX A (dibuktikan: jam 2026-10, suite RC-S53 #14-16
   * gagal; probe P1 beban 600.000 untuk bunga 550.000).
   * `reverseJournal()` memberi jurnal pembalik tanggal HARI INI, bukan
   * tanggal jurnal asal. Klaim lama "pembalik membawa bulan yang sama" hanya
   * benar bila reversal dilakukan di bulan yang sama. Periode jurnal
   * pembalik sekarang diambil dari JURNAL ASAL-nya (reversal_of_id).
   */
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit), 0) AS total
       FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       LEFT JOIN journal asal ON asal.id = j.reversal_of_id
      WHERE je.account_id = ?
        AND j.sumber_transaksi = 'UTANG_BUNGA'
        AND j.sumber_id = ?
        AND substr(COALESCE(asal.tanggal, j.tanggal), 1, 7) = ?
        AND j.status IN ('POSTED','REVERSED')`,
    utangBungaAccountId,
    utangId,
    periodeKey
  );
  /*
   * RC-S54 TAHAP 10 — FIX B (dibuktikan: probe P2 beban 600.000 untuk bunga
   * 300.000). `bayarUtang` membebankan bunga yang dibayar tanpa akrual
   * sebagai beban "periode berjalan" (periode tanggal bayar). Gap control
   * lama hanya membaca jurnal UTANG_BUNGA, sehingga akrual periode yang sama
   * sesudahnya membebankan bunga itu KEDUA kalinya.
   */
  const dibebankan = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(je.debit - je.kredit), 0) AS total
       FROM utang_pembayaran p
       JOIN journal j ON j.id = p.journal_id
       JOIN journal_entry je ON je.journal_id = j.id
      WHERE p.utang_id = ?
        AND je.account_id = ?
        AND substr(p.tanggal, 1, 7) = ?
        AND j.status IN ('POSTED','REVERSED')`,
    utangId,
    bebanBungaAccountId,
    periodeKey
  );
  const akrualBersih = row?.total ?? 0;
  const dibebankanSaatBayar = dibebankan?.total ?? 0;
  const sudahDiakui = akrualBersih + dibebankanSaatBayar;
  const sisa = target - sudahDiakui;
  return {
    utangId,
    periodeKey,
    target,
    akrualBersih,
    dibebankanSaatBayar,
    sisaGap: sisa > 0 ? sisa : 0,
    melebihiTarget: sudahDiakui > target,
  };
}

/** Pembungkus non-transaksional untuk layar & rekonsiliasi. */
export async function getGapAkrualBungaUtang(
  utangId: string,
  periodeKey: string,
  target: Rupiah
): Promise<GapAkrualBungaUtang> {
  const db = await getDb();
  return getGapAkrualBungaUtangPadaDb(db, utangId, periodeKey, target);
}

export interface RekonsiliasiBungaUtang {
  /** Total bunga yang pernah DIAKRU untuk utang ini (kredit 2-1700). */
  readonly totalAkrual: Rupiah;
  /** Total bunga yang pernah DIBAYAR untuk utang ini (utang_pembayaran.bunga). */
  readonly totalDibayar: Rupiah;
  /** Sisa bunga terutang = akrual - dibayar. Tidak pernah negatif. */
  readonly outstanding: Rupiah;
  /**
   * Kelebihan bayar di atas yang pernah diakru. > 0 berarti bunga
   * dibayar tanpa didahului akrual — bukan kesalahan, tetapi selisihnya
   * WAJIB menjadi beban periode berjalan, bukan mengurangi liabilitas
   * yang tidak pernah ada.
   */
  readonly kelebihanDibayar: Rupiah;
}

/**
 * REKONSILIASI BUNGA PER UTANG (RC-S53 §Z).
 *
 * Dibaca dari DUA sumber yang saling memeriksa, bukan dari satu angka
 * yang disimpan:
 *   - akrual : kredit ke akun Utang Bunga (2-1700) pada jurnal
 *              `sumber_transaksi = 'UTANG_BUNGA'` dengan `sumber_id`
 *              utang ini. Jurnal VOID/REVERSED dikecualikan.
 *   - dibayar: kolom `bunga` di `utang_pembayaran`.
 *
 * Kenapa "dibayar" TIDAK dibaca dari ledger: jurnal pembayaran sebelum
 * RC-S53 men-debit BEBAN, bukan Utang Bunga (itulah bugnya), sehingga
 * saldo ledger 2-1700 pada database lama TIDAK mencerminkan bunga yang
 * sudah dilunasi. `utang_pembayaran` mencatatnya dengan benar sejak
 * awal, jadi ia sumber yang sah untuk sisi ini.
 *
 * Konsekuensi yang DISENGAJA: pada database lama, saldo ledger 2-1700
 * akan lebih besar daripada jumlah `outstanding` seluruh utang. Selisih
 * itu TIDAK diperbaiki diam-diam di sini — memperbaiki saldo tanpa
 * jurnal adalah persis yang dilarang. Ia dilaporkan lewat
 * `getSelisihLedgerUtangBunga()` supaya koperasi dapat menerbitkan
 * jurnal koreksi yang terlihat di buku.
 */
export async function getRekonsiliasiBungaUtang(
  db: SQLite.SQLiteDatabase,
  utangId: string
): Promise<RekonsiliasiBungaUtang> {
  const replay = await replayBungaUtang(db, utangId);
  return {
    totalAkrual: replay.totalAkrual,
    totalDibayar: replay.totalDibayar,
    outstanding: replay.outstanding > 0 ? replay.outstanding : 0,
    kelebihanDibayar: replay.dibebankanSaatBayar,
  };
}

export interface ReplayBungaUtang {
  /** Akrual bersih (kredit - debit 2-1700, jurnal UTANG_BUNGA utang ini, reversal ikut). */
  readonly totalAkrual: Rupiah;
  /** Σ utang_pembayaran.bunga. */
  readonly totalDibayar: Rupiah;
  /** Bagian pembayaran yang SEHARUSNYA mengurangi 2-1700 (aturan `bagiPembayaranBunga`). */
  readonly diterapkanKeUtangBunga: Rupiah;
  /** Bagian pembayaran yang SEHARUSNYA menjadi beban saat bayar. */
  readonly dibebankanSaatBayar: Rupiah;
  /** totalAkrual - diterapkanKeUtangBunga (boleh negatif bila akrual dibalik setelah dibayar). */
  readonly outstanding: Rupiah;
  readonly pembayaran: readonly {
    id: string;
    tanggal: string;
    journalId: string | null;
    bunga: Rupiah;
    keUtangBunga: Rupiah;
    keBeban: Rupiah;
  }[];
}

/**
 * RC-S54 TAHAP 10 — FIX D: SUMBER TUNGGAL OUTSTANDING BUNGA PER UTANG.
 *
 * Dulu `outstanding = Σ akrual - Σ utang_pembayaran.bunga`. Bagian bunga
 * yang oleh `bagiPembayaranBunga` DIBEBANKAN saat bayar (bukan mengurangi
 * 2-1700) ikut mengurangi outstanding, sehingga setelah satu kelebihan
 * bayar, pembayaran berikutnya membebankan lagi bunga yang sudah diakru.
 * Bukti probe P6: beban 500.000 untuk bunga 450.000, 2-1700 tersisa 50.000.
 *
 * Sekarang seluruh akrual (per jurnal) dan pembayaran diputar ulang
 * berurutan waktu pencatatan (`created_at`, urutan yang benar-benar dilihat
 * `bayarUtang` saat itu) dengan aturan `bagiPembayaranBunga` yang SAMA.
 * Hasilnya independen dari ledger, sehingga pembayaran warisan pra-RC-S53
 * (yang men-debit beban) tetap dihitung sebagai pelunasan — sama dengan
 * semantik diagnostik historis.
 */
/**
 * RC-S54 TAHAP 16 — ITEM #13-A: URUTAN KEJADIAN DETERMINISTIK.
 *
 * `bayarUtang` membagi pembayaran berdasarkan outstanding hasil replay PADA
 * SAAT pembayaran dicatat — jadi urutan replay yang benar adalah URUTAN
 * PENCATATAN, bukan tanggal efektif. Dulu urutan itu hanya `created_at`
 * (ISO, presisi milidetik) dengan pemecah seri "akrual dulu". Bila akrual
 * berikutnya dan pembayaran sebelumnya tercatat pada milidetik yang sama,
 * akrual itu ikut menambah outstanding pembayaran yang dicatat LEBIH DULU
 * (terbukti: RC-S54_TAHAP_15.md §13, test 7b flaky).
 *
 * Kunci urut kini tuple leksikografis (total order, deterministik):
 *   1. `created_at`                      — waktu pencatatan (semantik lama);
 *   2. prefix nomor jurnal (`JRN-YYYY`)  — hanya memisahkan counter berbeda;
 *   3. nomor urut jurnal                 — urutan pencatatan SESUNGGUHNYA:
 *      `nextSequence` bertambah satu per jurnal dalam satu counter, termasuk
 *      untuk jurnal pembayaran (`utang_pembayaran.journal_id`);
 *   4. tanggal efektif;
 *   5. jenis (akrual sebelum pembayaran — aturan lama, dipertahankan);
 *   6. id.
 * Kejadian tanpa nomor jurnal (pembayaran warisan tanpa `journal_id`)
 * diurutkan setelah yang bernomor pada `created_at` yang sama. Histori
 * tidak diubah; hanya cara membacanya.
 */
export interface KejadianBungaUtang {
  readonly jenis: 'AKRUAL' | 'PEMBAYARAN';
  readonly id: string;
  readonly createdAt: string;
  readonly tanggal: string;
  readonly nomorJurnal: string | null;
  readonly akrual?: Rupiah;
  readonly bayar?: { id: string; tanggal: string; journal_id: string | null; created_at: string; bunga: number };
}

const TANPA_NOMOR = '\uffff';

function kunciNomorJurnal(nomor: string | null): { prefix: string; urut: number } {
  const m = nomor ? /^(.*)-(\d+)$/.exec(nomor) : null;
  return m ? { prefix: m[1], urut: Number(m[2]) } : { prefix: TANPA_NOMOR, urut: 0 };
}

/** Pembanding total order untuk kejadian bunga utang (lihat kunci di atas). */
export function bandingkanKejadianBungaUtang(x: KejadianBungaUtang, y: KejadianBungaUtang): number {
  if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
  const kx = kunciNomorJurnal(x.nomorJurnal);
  const ky = kunciNomorJurnal(y.nomorJurnal);
  if (kx.prefix !== ky.prefix) return kx.prefix < ky.prefix ? -1 : 1;
  if (kx.urut !== ky.urut) return kx.urut - ky.urut;
  if (x.tanggal !== y.tanggal) return x.tanggal < y.tanggal ? -1 : 1;
  if (x.jenis !== y.jenis) return x.jenis === 'AKRUAL' ? -1 : 1;
  if (x.id !== y.id) return x.id < y.id ? -1 : 1;
  return 0;
}

/** Seluruh kejadian bunga satu utang, terurut deterministik. Read-only. */
export async function muatKejadianBungaUtang(db: SQLite.SQLiteDatabase, utangId: string): Promise<KejadianBungaUtang[]> {
  const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');
  const akrual = await db.getAllAsync<{ journal_id: string; created_at: string; nilai: number; tanggal: string; nomor_jurnal: string | null }>(
    `SELECT j.id AS journal_id, j.created_at AS created_at, SUM(je.kredit - je.debit) AS nilai,
            j.tanggal AS tanggal, j.nomor_jurnal AS nomor_jurnal
       FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ?
        AND j.sumber_transaksi = 'UTANG_BUNGA'
        AND j.sumber_id = ?
        AND j.status IN ('POSTED','REVERSED')
      GROUP BY j.id, j.created_at, j.tanggal, j.nomor_jurnal`,
    utangBungaAccountId,
    utangId
  );
  const bayar = await db.getAllAsync<{ id: string; tanggal: string; journal_id: string | null; created_at: string; bunga: number; nomor_jurnal: string | null }>(
    `SELECT p.id, p.tanggal, p.journal_id, p.created_at, p.bunga, j.nomor_jurnal AS nomor_jurnal
       FROM utang_pembayaran p LEFT JOIN journal j ON j.id = p.journal_id
      WHERE p.utang_id = ? AND p.bunga > 0`,
    utangId
  );
  const kejadian: KejadianBungaUtang[] = [
    ...akrual.map((a) => ({
      jenis: 'AKRUAL' as const, id: a.journal_id, createdAt: a.created_at, tanggal: a.tanggal,
      nomorJurnal: a.nomor_jurnal ?? null, akrual: a.nilai,
    })),
    ...bayar.map((b) => ({
      jenis: 'PEMBAYARAN' as const, id: b.id, createdAt: b.created_at, tanggal: b.tanggal,
      nomorJurnal: b.nomor_jurnal ?? null,
      bayar: { id: b.id, tanggal: b.tanggal, journal_id: b.journal_id, created_at: b.created_at, bunga: b.bunga },
    })),
  ];
  return kejadian.sort(bandingkanKejadianBungaUtang);
}

/** Replay murni atas kejadian yang SUDAH terurut (dipakai replay & diagnostik #13-A). */
export function hitungReplayDariKejadian(kejadian: readonly KejadianBungaUtang[]): ReplayBungaUtang {
  let outstanding = 0;
  let totalAkrual = 0;
  let totalDibayar = 0;
  let diterapkan = 0;
  let dibebankan = 0;
  const pembayaran: ReplayBungaUtang['pembayaran'][number][] = [];
  for (const k of kejadian) {
    if (k.akrual !== undefined) {
      totalAkrual += k.akrual;
      outstanding += k.akrual;
    } else if (k.bayar) {
      const { keUtangBunga, keBeban } = bagiPembayaranBunga(k.bayar.bunga, outstanding);
      outstanding -= keUtangBunga;
      totalDibayar += k.bayar.bunga;
      diterapkan += keUtangBunga;
      dibebankan += keBeban;
      pembayaran.push({ id: k.bayar.id, tanggal: k.bayar.tanggal, journalId: k.bayar.journal_id, bunga: k.bayar.bunga, keUtangBunga, keBeban });
    }
  }
  return {
    totalAkrual,
    totalDibayar,
    diterapkanKeUtangBunga: diterapkan,
    dibebankanSaatBayar: dibebankan,
    outstanding,
    pembayaran,
  };
}

export async function replayBungaUtang(db: SQLite.SQLiteDatabase, utangId: string): Promise<ReplayBungaUtang> {
  return hitungReplayDariKejadian(await muatKejadianBungaUtang(db, utangId));
}

/** Saldo bunga terutang (akrual belum dibayar) saat ini — rekonsiliasi, dibaca langsung dari ledger. */
export async function getSaldoUtangBunga(asOfDate?: string): Promise<Rupiah> {
  const db = await getDb();
  const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');
  return getAccountBalance(db, utangBungaAccountId, asOfDate);
}

// ============================================================
// Revisi KOPKU (Bagian 2) — "Bayar Kewajiban" berbasis COA
// Liabilitas, dengan Simpanan Sukarela dikecualikan.
// ============================================================

/**
 * transactionType Utang yang DIKELOLA lewat tabel `utang` (outstanding
 * pokok, bunga, jadwal — lihat `bayarUtang`/`listUtang` di atas).
 * Akun COA yang dipetakan ke salah satu dari ini TETAP WAJIB dibayar
 * lewat alur Utang Koperasi (UtangPicker + `bayarUtang`), BUKAN lewat
 * `bayarKewajibanCoa` di bawah — supaya outstanding/bunga tidak lewat
 * jalur yang tidak melacaknya (Bagian 2.3: "jangan menghapus
 * mekanisme existing").
 */
const UTANG_TRACKING_TRANSACTION_TYPES: { transactionType: string; jenisPemberi: JenisPemberi }[] = [
  { transactionType: 'UTANG_BANK', jenisPemberi: 'BANK' },
  { transactionType: 'UTANG_PIHAK_LAIN', jenisPemberi: 'PIHAK_LAIN' },
  { transactionType: 'UTANG_USAHA', jenisPemberi: 'UTANG_USAHA' },
];

export interface AkunKewajibanOption {
  accountId: string;
  kode: string;
  nama: string;
  /**
   * Saldo akun liabilitas ini saat ini, dari LEDGER (`getAccountBalance`
   * — REUSE fungsi account balance yang sudah ada, TIDAK menghitung
   * saldo baru). Bisa NEGATIF (mis. akun overpaid) — SENGAJA tidak
   * dibungkus Math.max()/Math.abs(), ditampilkan apa adanya (permintaan
   * pengguna: "Jika saldo akun negatif, tampilkan nilai negatif").
   */
  saldo: Rupiah;
  /**
   * Diisi ('BANK'/'PIHAK_LAIN'/'UTANG_USAHA') kalau akun ini dikelola
   * lewat tabel `utang` — BayarUtangFormScreen harus menampilkan
   * UtangPicker (pokok/bunga/outstanding) untuk akun ini, BUKAN form
   * pembayaran langsung. `null` = kewajiban COA umum (mis. Dana
   * Pendidikan, Utang Pajak, Kewajiban Lainnya) — dibayar langsung
   * tanpa pencatatan outstanding terpisah (jumlahnya selalu lunas
   * penuh per transaksi, seperti Beban).
   */
  jenisPemberiTerkait: JenisPemberi | null;
}

/**
 * Revisi KOPKU (Bagian 2.1/2.2): daftar pilihan untuk "Bayar
 * Kewajiban" — akun LIABILITAS dari COA (lewat
 * `getAccountsUntukKewajiban()`, yang sudah mengecualikan Simpanan
 * Sukarela berdasarkan account_id/mapping), ditandai mana yang
 * dikelola lewat tracking `utang` (Utang Bank/Pihak Lain/Usaha) dan
 * mana yang kewajiban COA umum.
 *
 * Revisi "Akun Liabilitas" (audit lanjutan): setiap akun sekarang
 * disertai `saldo` dari LEDGER (`getAccountBalance` — REUSE, bukan
 * service/perhitungan saldo baru), supaya layar "Kewajiban" bisa
 * menampilkan Nama Akun + Nominal langsung dari sini tanpa query
 * tambahan di UI.
 */
export async function listAkunKewajiban(): Promise<AkunKewajibanOption[]> {
  const db = await getDb();
  const akunLiabilitas = await getAccountsUntukKewajiban();

  const placeholders = UTANG_TRACKING_TRANSACTION_TYPES.map(() => '?').join(',');
  const trackedMappings = await db.getAllAsync<{ transaction_type: string; account_id: string }>(
    `SELECT transaction_type, account_id FROM account_mapping
     WHERE role = 'KREDIT_DEFAULT' AND transaction_type IN (${placeholders})`,
    ...UTANG_TRACKING_TRANSACTION_TYPES.map((t) => t.transactionType)
  );
  const jenisByAccountId = new Map<string, JenisPemberi>();
  for (const m of trackedMappings) {
    const match = UTANG_TRACKING_TRANSACTION_TYPES.find((t) => t.transactionType === m.transaction_type);
    if (match) jenisByAccountId.set(m.account_id, match.jenisPemberi);
  }

  const hasil: AkunKewajibanOption[] = [];
  for (const a of akunLiabilitas) {
    hasil.push({
      accountId: a.id,
      kode: a.kode,
      nama: a.nama,
      saldo: await getAccountBalance(db, a.id),
      jenisPemberiTerkait: jenisByAccountId.get(a.id) ?? null,
    });
  }
  return hasil;
}

export const PESAN_UTANG_BUNGA_LEWAT_BAYAR_UTANG =
  'Utang Bunga dilunasi lewat pembayaran Utang Koperasi (isi porsi bunga pada utang terkait), bukan Bayar Kewajiban langsung — supaya outstanding bunga per utang ikut berkurang.';

export interface BayarKewajibanCoaInput {
  accountId: string;
  tanggal: string;
  nominal: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
}

/**
 * Revisi KOPKU (Bagian 2.4): pelunasan kewajiban COA umum yang TIDAK
 * dikelola lewat tabel `utang` (mis. Dana Pendidikan, Utang Pajak,
 * Kewajiban Lainnya) — DEBIT akun kewajiban terpilih, KREDIT Kas/Bank.
 * Direct Dr/Kr penuh (bukan pokok+bunga terpisah, tidak ada
 * outstanding tersimpan) — konsisten dengan cara akun2 ini muncul di
 * COA (tanpa jadwal/bunga terdaftar sama sekali).
 *
 * REUSE `KasBankService.catatPengeluaran()` existing (Dr akun lawan /
 * Kr rekening, sudah termasuk cek permission & cek saldo cukup) —
 * TIDAK membuat mekanisme jurnal baru, sesuai instruksi audit ini.
 * Validasi TAMBAHAN di sini (kategori LIABILITAS, bukan Simpanan
 * Sukarela, bukan akun yang di-tracking `utang`) supaya berlaku di
 * lapisan SERVICE, bukan cuma UI.
 */
export async function bayarKewajibanCoa(input: BayarKewajibanCoaInput): Promise<{ id: string; journalId: string }> {
  const db = await getDb();
  const acc = await db.getFirstAsync<{ id: string; nama: string; kategori: string; is_active: number }>(
    `SELECT id, nama, kategori, is_active FROM account WHERE id = ?`,
    input.accountId
  );
  if (!acc) throw new Error('Akun kewajiban tidak ditemukan.');
  if (acc.kategori !== 'LIABILITAS') {
    throw new Error('Akun yang dipilih bukan akun Liabilitas/Kewajiban.');
  }
  if (!acc.is_active) {
    throw new Error('Akun ini sudah dinonaktifkan dan tidak dapat dipakai transaksi baru.');
  }

  const simpananSukarelaMapping = await db.getFirstAsync<{ account_id: string }>(
    `SELECT account_id FROM account_mapping WHERE transaction_type = 'SIMPANAN_SUKARELA' AND role = 'KREDIT_DEFAULT'`
  );
  if (simpananSukarelaMapping?.account_id === input.accountId) {
    throw new Error(
      'Simpanan Sukarela memiliki alur transaksi tersendiri (menu Simpanan/Tarik Simpanan Anggota) — tidak dibayar lewat Bayar Kewajiban.'
    );
  }

  const trackedTypes = UTANG_TRACKING_TRANSACTION_TYPES.map((t) => t.transactionType);
  const placeholders = trackedTypes.map(() => '?').join(',');
  const trackedMapping = await db.getFirstAsync<{ transaction_type: string }>(
    `SELECT transaction_type FROM account_mapping
     WHERE account_id = ? AND role = 'KREDIT_DEFAULT' AND transaction_type IN (${placeholders})`,
    input.accountId,
    ...trackedTypes
  );
  if (trackedMapping) {
    throw new Error(
      'Akun ini dikelola lewat pencatatan Utang Koperasi (pokok, bunga, outstanding) — pilih dari daftar Utang Koperasi, bukan pembayaran langsung.'
    );
  }
  /*
   * RC-S54 TAHAP 10 — FIX C (dibuktikan: probe P3 saldo 2-1700 = -300.000,
   * diagnostik lama tidak melihatnya). Utang Bunga (UTANG_BUNGA/KREDIT_AKRUAL)
   * dilacak per utang lewat `utang_pembayaran`. Pelunasan langsung ke akun
   * ini tidak mengurangi outstanding per utang, sehingga `bayarUtang`
   * berikutnya mendebit 2-1700 untuk bunga yang sudah lunas.
   */
  const utangBungaMapping = await db.getFirstAsync<{ account_id: string }>(
    `SELECT account_id FROM account_mapping WHERE transaction_type = 'UTANG_BUNGA' AND role = 'KREDIT_AKRUAL'`
  );
  if (utangBungaMapping?.account_id === input.accountId) {
    throw new Error(PESAN_UTANG_BUNGA_LEWAT_BAYAR_UTANG);
  }

  return catatPengeluaran({
    jenis: input.sumberDana,
    bankAccountId: input.bankAccountId,
    nominal: input.nominal,
    tanggal: input.tanggal,
    akunLawanId: input.accountId,
    kategori: 'Kewajiban',
    keterangan: input.keterangan?.trim() || `Pembayaran kewajiban ${acc.nama}`,
    createdBy: input.createdBy,
  });
}

// ============================================================================
// RC-S54 TAHAP 10 — KONTROL GAP UTANG BUNGA (read-only, deteksi otomatis)
// ============================================================================

export type KodeTemuanUtangBunga =
  | 'DUPLICATE_INTEREST_EXPENSE'
  | 'INTEREST_PAYABLE_GAP'
  | 'UTANG_BUNGA_HISTORICAL_GAP'
  | 'JURNAL_TANPA_SUBLEDGER'
  | 'SUBLEDGER_TANPA_JURNAL'
  | 'OUTSTANDING_NEGATIF';

export interface ReferensiJurnalUtangBunga {
  readonly journalId: string;
  readonly nomorJurnal: string;
  readonly tanggal: string;
  readonly sumberTransaksi: string;
  readonly nilai: Rupiah;
}

export interface TemuanUtangBunga {
  readonly kode: KodeTemuanUtangBunga;
  readonly utangId: string | null;
  readonly nomorUtang: string | null;
  readonly namaPemberi: string | null;
  readonly periode: string | null;
  readonly expected: Rupiah;
  readonly recorded: Rupiah;
  /** recorded - expected. */
  readonly difference: Rupiah;
  readonly jurnal: readonly ReferensiJurnalUtangBunga[];
  readonly keterangan: string;
}

export interface KontrolGapUtangBunga {
  readonly status: 'BALANCED' | 'GAP';
  /** Σ outstanding per utang menurut replay subledger. */
  readonly expected: Rupiah;
  /** Saldo GL akun Utang Bunga. */
  readonly actual: Rupiah;
  /** actual - expected. */
  readonly gap: Rupiah;
  readonly temuan: readonly TemuanUtangBunga[];
}

async function refJurnal(db: SQLite.SQLiteDatabase, journalIds: readonly string[], accountId: string): Promise<ReferensiJurnalUtangBunga[]> {
  const hasil: ReferensiJurnalUtangBunga[] = [];
  for (const id of journalIds) {
    const r = await db.getFirstAsync<{ id: string; nomor_jurnal: string; tanggal: string; sumber_transaksi: string; nilai: number }>(
      `SELECT j.id, j.nomor_jurnal, j.tanggal, j.sumber_transaksi,
              COALESCE((SELECT SUM(je.kredit - je.debit) FROM journal_entry je WHERE je.journal_id = j.id AND je.account_id = ?), 0) AS nilai
         FROM journal j WHERE j.id = ?`,
      accountId,
      id
    );
    if (r) hasil.push({ journalId: r.id, nomorJurnal: r.nomor_jurnal, tanggal: r.tanggal, sumberTransaksi: r.sumber_transaksi, nilai: r.nilai });
  }
  return hasil;
}

/**
 * Deteksi otomatis gap & beban ganda Utang Bunga. HANYA MEMBACA: tidak ada
 * INSERT/UPDATE/DELETE dan tidak ada jurnal koreksi (Bagian L).
 *
 * Definisi (memakai aturan resmi `bagiPembayaranBunga` + `replayBungaUtang`):
 *   expected payable per utang = akrual bersih - bagian pembayaran yang
 *                                diterapkan ke Utang Bunga
 *   recorded payable per utang = saldo GL Utang Bunga yang teratribusi ke
 *                                utang (jurnal UTANG_BUNGA ber-sumber_id
 *                                utang + jurnal pembayaran utang_pembayaran)
 *   gap global                 = saldo GL Utang Bunga - Σ expected
 */
export async function getKontrolGapUtangBunga(dbOpsional?: SQLite.SQLiteDatabase): Promise<KontrolGapUtangBunga> {
  const db = dbOpsional ?? (await getDb());
  const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');
  const bebanBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'DEBIT_BEBAN');
  const temuan: TemuanUtangBunga[] = [];
  let expectedTotal = 0;

  const daftar = await db.getAllAsync<{ id: string; nomor_utang: string; nama_pemberi: string }>(
    `SELECT id, nomor_utang, nama_pemberi FROM utang ORDER BY tanggal ASC, id ASC`
  );

  for (const u of daftar) {
    const replay = await replayBungaUtang(db, u.id);
    expectedTotal += replay.outstanding;
    const identitas = { utangId: u.id, nomorUtang: u.nomor_utang, namaPemberi: u.nama_pemberi };

    // ---- recorded payable per utang
    const ledger = await db.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.kredit - je.debit),0) total
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')
          AND ((j.sumber_transaksi = 'UTANG_BUNGA' AND j.sumber_id = ?)
               OR j.id IN (SELECT journal_id FROM utang_pembayaran WHERE utang_id = ? AND journal_id IS NOT NULL))`,
      utangBungaAccountId,
      u.id,
      u.id
    );
    const recorded = ledger?.total ?? 0;

    // ---- Case D / historis: pembayaran yang jurnalnya tidak sesuai aturan pembagian
    const pembayaranMenyimpang: string[] = [];
    let deviasiPembayaran = 0;
    for (const b of replay.pembayaran) {
      if (!b.journalId) continue;
      const d = await db.getFirstAsync<{ debit: number; status: string | null }>(
        `SELECT COALESCE((SELECT SUM(je.debit - je.kredit) FROM journal_entry je WHERE je.journal_id = j.id AND je.account_id = ?), 0) AS debit, j.status
           FROM journal j WHERE j.id = ?`,
        utangBungaAccountId,
        b.journalId
      );
      if (d && d.debit !== b.keUtangBunga) {
        pembayaranMenyimpang.push(b.journalId);
        deviasiPembayaran += b.keUtangBunga - d.debit;
      }
    }

    if (recorded !== replay.outstanding) {
      const penjelasHistoris = pembayaranMenyimpang.length > 0 && deviasiPembayaran === recorded - replay.outstanding;
      temuan.push({
        kode: penjelasHistoris ? 'UTANG_BUNGA_HISTORICAL_GAP' : 'INTEREST_PAYABLE_GAP',
        ...identitas,
        periode: null,
        expected: replay.outstanding,
        recorded,
        difference: recorded - replay.outstanding,
        jurnal: await refJurnal(db, pembayaranMenyimpang, utangBungaAccountId),
        keterangan: penjelasHistoris
          ? 'Jurnal pembayaran tidak mengurangi Utang Bunga sebesar aturan pembagian (pola sebelum RC-S53). Tidak dikoreksi otomatis.'
          : 'Saldo Utang Bunga utang ini tidak sama dengan outstanding menurut subledger (akrual - pelunasan yang diterapkan).',
      });
    }
    if (recorded < 0) {
      temuan.push({
        kode: 'OUTSTANDING_NEGATIF',
        ...identitas,
        periode: null,
        expected: Math.max(0, replay.outstanding),
        recorded,
        difference: recorded - Math.max(0, replay.outstanding),
        jurnal: [],
        keterangan: 'Utang Bunga utang ini bersaldo debit: dilunasi melebihi yang pernah diakui.',
      });
    }

    // ---- Case A: beban ganda di periode yang sama (akrual + dibebankan saat bayar)
    const periodeAkrual = await db.getAllAsync<{ periode: string }>(
      `SELECT DISTINCT substr(COALESCE(asal.tanggal, j.tanggal), 1, 7) AS periode
         FROM journal j LEFT JOIN journal asal ON asal.id = j.reversal_of_id
        WHERE j.sumber_transaksi = 'UTANG_BUNGA' AND j.sumber_id = ? AND j.status IN ('POSTED','REVERSED')`,
      u.id
    );
    for (const { periode } of periodeAkrual) {
      const gap = await getGapAkrualBungaUtangPadaDb(db, u.id, periode, 0);
      if (gap.akrualBersih > 0 && gap.dibebankanSaatBayar > 0) {
        const jurnalAkrual = await db.getAllAsync<{ id: string }>(
          `SELECT j.id FROM journal j LEFT JOIN journal asal ON asal.id = j.reversal_of_id
            WHERE j.sumber_transaksi = 'UTANG_BUNGA' AND j.sumber_id = ? AND j.status IN ('POSTED','REVERSED')
              AND substr(COALESCE(asal.tanggal, j.tanggal), 1, 7) = ?`,
          u.id,
          periode
        );
        const jurnalBayar = await db.getAllAsync<{ journal_id: string }>(
          `SELECT journal_id FROM utang_pembayaran WHERE utang_id = ? AND bunga > 0 AND journal_id IS NOT NULL AND substr(tanggal,1,7) = ?`,
          u.id,
          periode
        );
        const ganda = Math.min(gap.akrualBersih, gap.dibebankanSaatBayar);
        temuan.push({
          kode: 'DUPLICATE_INTEREST_EXPENSE',
          ...identitas,
          periode,
          expected: gap.akrualBersih + gap.dibebankanSaatBayar - ganda,
          recorded: gap.akrualBersih + gap.dibebankanSaatBayar,
          difference: ganda,
          jurnal: [
            ...(await refJurnal(db, jurnalAkrual.map((x) => x.id), utangBungaAccountId)),
            ...(await refJurnal(db, jurnalBayar.map((x) => x.journal_id), bebanBungaAccountId)),
          ],
          keterangan:
            'Bunga periode ini dibebankan saat dibayar tanpa akrual DAN juga diakru — beban terhitung dua kali sebesar difference (pola sebelum RC-S54 Tahap 10). Tidak dikoreksi otomatis.',
        });
      }
    }

    // ---- Case F: dua jurnal akrual identik (tanggal & nominal sama, keduanya aktif)
    const kembar = await db.getAllAsync<{ tanggal: string; nilai: number; ids: string; n: number }>(
      `SELECT x.tanggal, x.nilai, GROUP_CONCAT(x.id) AS ids, COUNT(*) AS n FROM (
         SELECT j.id, j.tanggal, SUM(je.kredit - je.debit) AS nilai
           FROM journal j JOIN journal_entry je ON je.journal_id = j.id
          WHERE je.account_id = ? AND j.sumber_transaksi = 'UTANG_BUNGA' AND j.sumber_id = ? AND j.status = 'POSTED'
            AND j.reversal_of_id IS NULL
          GROUP BY j.id, j.tanggal
       ) x WHERE x.nilai > 0 GROUP BY x.tanggal, x.nilai HAVING COUNT(*) > 1`,
      utangBungaAccountId,
      u.id
    );
    for (const k of kembar) {
      temuan.push({
        kode: 'DUPLICATE_INTEREST_EXPENSE',
        ...identitas,
        periode: periodeKeyDariTanggal(k.tanggal),
        expected: k.nilai,
        recorded: k.nilai * k.n,
        difference: k.nilai * (k.n - 1),
        jurnal: await refJurnal(db, k.ids.split(','), utangBungaAccountId),
        keterangan: `${k.n} jurnal akrual identik (tanggal & nominal sama) untuk satu utang — tidak mungkin dibuat lewat gap control; perlu ditinjau.`,
      });
    }

    // ---- Case C: subledger pembayaran bunga tanpa jurnal sah
    const tanpaJurnal = await db.getAllAsync<{ id: string; tanggal: string; bunga: number; journal_id: string | null }>(
      `SELECT p.id, p.tanggal, p.bunga, p.journal_id FROM utang_pembayaran p
         LEFT JOIN journal j ON j.id = p.journal_id
        WHERE p.utang_id = ? AND p.bunga > 0 AND (p.journal_id IS NULL OR j.id IS NULL OR j.status NOT IN ('POSTED','REVERSED'))`,
      u.id
    );
    for (const t of tanpaJurnal) {
      temuan.push({
        kode: 'SUBLEDGER_TANPA_JURNAL',
        ...identitas,
        periode: periodeKeyDariTanggal(t.tanggal),
        expected: t.bunga,
        recorded: 0,
        difference: -t.bunga,
        jurnal: [],
        keterangan: `Pembayaran bunga ${t.id} tercatat di utang_pembayaran tetapi jurnalnya ${t.journal_id ?? '(kosong)'} tidak ada/tidak berlaku.`,
      });
    }
  }

  // ---- Case B: mutasi Utang Bunga yang tidak teratribusi ke utang mana pun
  const yatim = await db.getAllAsync<{ id: string }>(
    `SELECT DISTINCT j.id FROM journal j JOIN journal_entry je ON je.journal_id = j.id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')
        AND NOT (j.sumber_transaksi = 'UTANG_BUNGA' AND j.sumber_id IN (SELECT id FROM utang))
        AND j.id NOT IN (SELECT journal_id FROM utang_pembayaran WHERE journal_id IS NOT NULL)
      ORDER BY j.tanggal, j.id`,
    utangBungaAccountId
  );
  if (yatim.length > 0) {
    const ref = await refJurnal(db, yatim.map((x) => x.id), utangBungaAccountId);
    const nilai = ref.reduce((t, r) => t + r.nilai, 0);
    temuan.push({
      kode: 'JURNAL_TANPA_SUBLEDGER',
      utangId: null,
      nomorUtang: null,
      namaPemberi: null,
      periode: null,
      expected: 0,
      recorded: nilai,
      difference: nilai,
      jurnal: ref,
      keterangan: 'Mutasi akun Utang Bunga yang tidak berasal dari akrual utang maupun pembayaran utang (mis. pengeluaran kas langsung ke akun ini).',
    });
  }

  const actual = await getAccountBalance(db, utangBungaAccountId);
  const gap = actual - expectedTotal;
  return {
    status: temuan.length === 0 && gap === 0 ? 'BALANCED' : 'GAP',
    expected: expectedTotal,
    actual,
    gap,
    temuan,
  };
}

/**
 * ============================================================
 * RC-S58.1 — KONTROL GAP UTANG BUNGA AS-OF (untuk tutup periode)
 * ============================================================
 *
 * `getKontrolGapUtangBunga()` di atas adalah kontrol GLOBAL: ledger seluruh
 * waktu vs replay seluruh waktu. Ia tetap sumber diagnostik aplikasi dan
 * TIDAK diubah. Untuk menutup periode, yang relevan adalah posisi pada akhir
 * periode itu; GAP yang baru terjadi sesudahnya (atau pelunasan/reversal
 * sesudahnya) tidak boleh mengubah keputusan penutupan periode sebelumnya.
 *
 * Semantik as-of (semua komponen memakai `tanggal <= asOfDate`):
 *  - akrual, reversal, penyesuaian: jurnal `UTANG_BUNGA` per TANGGAL JURNALNYA
 *    SENDIRI — jurnal pembalik bertanggal 2026 tidak mengurangi posisi 2025
 *    (sama dengan buku besar; berbeda dari gap control per periode yang
 *    mengatribusikan reversal ke periode asal — itu untuk tujuan lain);
 *  - pelunasan: `keUtangBunga` dari replay PENUH (urutan pencatatan, kontrak
 *    RC-S54) untuk pembayaran `tanggal <= asOfDate`. Pembagian TIDAK dihitung
 *    ulang dari subset kejadian, karena jurnal pembayaran dibuat dengan
 *    pembagian pada saat dicatat;
 *  - saldo GL: `getAccountBalance(akun, asOfDate)`.
 * Temuan global yang berperiode (beban ganda, subledger tanpa jurnal)
 * dipakai ulang bila periodenya <= bulan as-of.
 */
export interface KontrolGapUtangBungaAsOf extends KontrolGapUtangBunga {
  readonly asOfDate: string;
}

export async function getKontrolGapUtangBungaAsOf(
  asOfDate: string,
  dbOpsional?: SQLite.SQLiteDatabase
): Promise<KontrolGapUtangBungaAsOf> {
  // Disusun SELURUHNYA dari API baca yang sudah ada (tanpa SQL baru), supaya
  // satu sumber kebenaran per komponen: kejadian = muatKejadianBungaUtang,
  // pembagian = replay penuh, nilai jurnal = refJurnal, GL = getAccountBalance.
  const db = dbOpsional ?? (await getDb());
  const utangBungaAccountId = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');
  const periodeAsOf = asOfDate.slice(0, 7);
  const global = await getKontrolGapUtangBunga(db);
  const temuan: TemuanUtangBunga[] = [];
  let expectedTotal = 0;

  for (const u of await listUtang({ asOfDate })) {
    const identitas = { utangId: u.id, nomorUtang: u.nomorUtang, namaPemberi: u.namaPemberi };
    const kejadian = await muatKejadianBungaUtang(db, u.id);
    const penuh = hitungReplayDariKejadian(kejadian);
    // Akrual/reversal/penyesuaian: nilai 2-1700 per jurnal, per tanggal jurnalnya sendiri.
    const akrualAsOf = kejadian
      .filter((k) => k.akrual !== undefined && k.tanggal <= asOfDate)
      .reduce((t, k) => t + (k.akrual ?? 0), 0);
    const bayarAsOf = penuh.pembayaran.filter((b) => b.tanggal <= asOfDate);
    const pelunasanAsOf = bayarAsOf.reduce((t, b) => t + b.keUtangBunga, 0);
    const expected = akrualAsOf - pelunasanAsOf;
    expectedTotal += expected;

    // Tercatat di buku besar: akrual yang sama + mutasi 2-1700 dari jurnal pembayaran as-of.
    const refBayar = await refJurnal(
      db,
      bayarAsOf.map((b) => b.journalId).filter((x): x is string => !!x),
      utangBungaAccountId
    );
    const recorded = akrualAsOf + refBayar.filter((r) => r.tanggal <= asOfDate).reduce((t, r) => t + r.nilai, 0);
    if (recorded !== expected) {
      temuan.push({
        kode: 'INTEREST_PAYABLE_GAP',
        ...identitas,
        periode: periodeAsOf,
        expected,
        recorded,
        difference: recorded - expected,
        jurnal: refBayar,
        keterangan: `Per ${asOfDate}: saldo Utang Bunga utang ini tidak sama dengan outstanding subledger as-of.`,
      });
    }
    if (recorded < 0) {
      temuan.push({
        kode: 'OUTSTANDING_NEGATIF',
        ...identitas,
        periode: periodeAsOf,
        expected: Math.max(0, expected),
        recorded,
        difference: recorded - Math.max(0, expected),
        jurnal: [],
        keterangan: `Per ${asOfDate}: Utang Bunga utang ini bersaldo debit.`,
      });
    }
  }

  for (const t of global.temuan) {
    // Mutasi Utang Bunga tanpa atribusi: hanya jurnal bertanggal <= asOf, dan
    // hanya bila NETO-nya tidak nol (yang sudah dikoreksi sebelum/pada asOf
    // tidak lagi memengaruhi posisi akhir periode).
    if (t.kode === 'JURNAL_TANPA_SUBLEDGER') {
      const ref = t.jurnal.filter((r) => r.tanggal <= asOfDate);
      const nilai = ref.reduce((x, r) => x + r.nilai, 0);
      if (nilai !== 0) {
        temuan.push({ ...t, periode: periodeAsOf, recorded: nilai, difference: nilai, jurnal: ref, keterangan: `Per ${asOfDate}: ${t.keterangan}` });
      }
    }
    // Temuan global yang berperiode — dipakai ulang, tidak dihitung ulang.
    if ((t.kode === 'DUPLICATE_INTEREST_EXPENSE' || t.kode === 'SUBLEDGER_TANPA_JURNAL') && t.periode && t.periode <= periodeAsOf) {
      temuan.push(t);
    }
  }

  const actual = await getAccountBalance(db, utangBungaAccountId, asOfDate);
  const gap = actual - expectedTotal;
  return {
    asOfDate,
    status: temuan.length === 0 && gap === 0 ? 'BALANCED' : 'GAP',
    expected: expectedTotal,
    actual,
    gap,
    temuan,
  };
}
