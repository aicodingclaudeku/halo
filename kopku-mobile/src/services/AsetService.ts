import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, reverseJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { catatUtangUsahaDariAset } from '@/services/UtangService';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { hitungPenyusutanBulanan, getDasarPenyusutanAsetPadaDb, getSelisihRevaluasiAsetPadaDb } from '@/services/PenyusutanService';
import { resolveKlasifikasiAsetByNama } from '@/services/AsetKlasifikasiService';

/**
 * Register Aset Tetap — dipakai dua sub-fitur berbeda yang sama-sama
 * "menambah aset koperasi": "Pembelian Aset" (Pengeluaran, tunai/kredit)
 * dan "Modal Barang" (Penerimaan, lihat ModalService.ts). Nilai
 * perolehan & masa manfaat dicatat sebagai dasar penyusutan sesuai
 * SAK — jurnal penyusutan bulanan otomatis BELUM dibuat di sini,
 * ini baru mencatat perolehannya (lihat komentar di schema.ts).
 */

export interface BeliAsetInput {
  namaAset: string;
  /** Bagian G: opsional, dari master data aset_klasifikasi — aset lama/tanpa klasifikasi tetap boleh NULL. */
  kelompokAset?: string;
  subKelompokAset?: string;
  nilaiPerolehan: Rupiah;
  /** Nilai residu (sisa nilai di akhir masa manfaat) — default 0 jika tidak diisi. */
  nilaiResidu?: Rupiah;
  masaManfaatBulan: number;
  /**
   * TANGGAL TRANSAKSI — kapan pembelian ini DIBUKUKAN.
   *
   * Menentukan tanggal jurnal dan periode akuntansi. BUKAN tanggal
   * perolehan aset (lihat `tanggalPerolehan` di bawah).
   */
  tanggal: string;
  /**
   * BUG-06 — TANGGAL PEROLEHAN, terpisah dari tanggal transaksi.
   *
   * Sebelumnya `tanggal` dipakai untuk DUA konsep sekaligus: tanggal
   * jurnal DAN `aset_tetap.tanggal_perolehan`. Selama keduanya sama
   * hal itu tidak kelihatan — tetapi begitu aset dicatat MUNDUR (aset
   * dibeli Juli, baru diinput September), pengguna hanya punya satu
   * pilihan dan keduanya salah:
   *   - isi 2026-07-01 -> jurnal masuk ke Juli, mengubah Laporan
   *     Laba Rugi & Posisi Keuangan Juli yang mungkin sudah dicetak,
   *     tanpa transaksi koreksi apa pun;
   *   - isi 2026-09-03 -> register aset dan penyusutan menganggap
   *     aset baru ada September, dua bulan penyusutan hilang.
   *
   * Opsional dan default = `tanggal`, sehingga SELURUH pemanggil lama
   * berperilaku persis sama seperti sebelumnya.
   */
  tanggalPerolehan?: string;
  metodePembayaran: 'TUNAI' | 'KREDIT';
  sumberDana?: 'KAS' | 'BANK'; // wajib jika metodePembayaran = TUNAI
  bankAccountId?: string;
  /** Wajib jika metodePembayaran = KREDIT — nama pemasok, dipakai sebagai identitas utang usaha (UtangService). */
  namaPemasok?: string;
  keterangan?: string;
  createdBy: string;
  /**
   * Prioritas 8/J (Aset Tak Berwujud) — default 'TETAP' supaya seluruh
   * pemanggil existing (sebelum field ini ada) tetap berperilaku
   * persis sama. 'TAK_BERWUJUD' memakai akun 1-1700 (bukan akun aset
   * tetap biasa) lewat mapping ASET_TAK_BERWUJUD yang sudah tersedia
   * di defaultCOA.ts.
   */
  jenisAset?: 'TETAP' | 'TAK_BERWUJUD';
}

/**
 * Phase 9 (audit Asset): AccountingEngine.createJournal() SUDAH
 * menolak nilaiPerolehan 0/negatif secara otomatis (baris jurnal
 * kosong/negatif ditolak di level engine — lihat
 * AccountingEngine.ts validasiBarisJurnal). Yang BELUM pernah
 * divalidasi: masaManfaatBulan & nilaiResidu — dua-duanya tidak
 * masuk jurnal (cuma disimpan di tabel aset_tetap), jadi tidak
 * kena guard engine sama sekali. masaManfaatBulan <= 0 bikin aset
 * tidak akan pernah tersusutkan (PenyusutanService sudah dijaga
 * tidak crash, tapi diam-diam salah) — divalidasi di sini supaya
 * error-nya jelas sejak input, bukan "aset macet" yang membingungkan
 * belakangan.
 */
export function validasiMasaManfaatDanResidu(nilaiPerolehan: Rupiah, nilaiResidu: Rupiah, masaManfaatBulan: number) {
  if (!Number.isFinite(masaManfaatBulan) || masaManfaatBulan <= 0) {
    throw new Error('Masa manfaat harus lebih dari 0 bulan.');
  }
  if (!Number.isInteger(masaManfaatBulan)) {
    throw new Error('Masa manfaat harus bilangan bulat (jumlah bulan).');
  }
  if (nilaiResidu < 0) {
    throw new Error('Nilai residu tidak boleh negatif.');
  }
  if (nilaiResidu >= nilaiPerolehan) {
    throw new Error('Nilai residu harus lebih kecil dari nilai perolehan (kalau tidak, aset tidak akan pernah tersusutkan).');
  }
}

/**
 * Pembelian aset tetap (sub-fitur "Pembelian Aset", Pengeluaran):
 *  - TUNAI: DEBIT Aset Tetap, KREDIT Kas/Bank (uang langsung keluar).
 *  - KREDIT: DEBIT Aset Tetap, KREDIT Utang Usaha (belum dibayar,
 *    TIDAK menyentuh kas/bank sampai dilunasi lewat sub-fitur
 *    "Kewajiban" seperti utang lainnya).
 */
export async function beliAset(input: BeliAsetInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    validasiMasaManfaatDanResidu(input.nilaiPerolehan, input.nilaiResidu ?? 0, input.masaManfaatBulan);
    if (input.metodePembayaran === 'TUNAI' && !input.sumberDana) {
      throw new Error('Sumber dana (Kas/Bank) wajib dipilih untuk pembelian tunai.');
    }
    if (input.metodePembayaran === 'KREDIT' && !input.namaPemasok?.trim()) {
      throw new Error('Nama pemasok wajib diisi untuk pembelian kredit (dipakai sebagai identitas utang usaha).');
    }

    // BUG-06: dua tanggal, dua peran. `tanggal` -> jurnal & periode
    // akuntansi; `tanggalPerolehan` -> register aset & mulai penyusutan.
    //
    // Divalidasi DI SINI (bersama validasi input lain) dan bukan di
    // tengah fungsi: pemeriksaan yang murah dan pasti harus mendahului
    // resolusi COA, pengambilan nomor urut, dan pengecekan saldo —
    // supaya penolakan tidak terjadi setelah ada efek yang terlanjur
    // berjalan.
    const tanggalPerolehan = input.tanggalPerolehan ?? input.tanggal;
    if (tanggalPerolehan > input.tanggal) {
      throw new Error(
        `Tanggal perolehan (${tanggalPerolehan}) tidak boleh setelah tanggal transaksi (${input.tanggal}) — ` +
          `aset tidak dapat dibukukan sebelum diperoleh.`
      );
    }

    const asetAccountId = await resolveAccountId(
      db,
      input.jenisAset === 'TAK_BERWUJUD' ? 'ASET_TAK_BERWUJUD' : 'ASET_TETAP',
      'DEBIT_ASET'
    );
    let kreditAccountId: string;
    if (input.metodePembayaran === 'TUNAI') {
      kreditAccountId = await resolveKasBankAccountId(db, input.sumberDana!, input.bankAccountId);
      // Phase 4: pembelian tunai harus cek saldo dulu — kredit tidak
      // menyentuh kas/bank sama sekali jadi tidak perlu cek ini.
      const cekSaldo = await checkSaldoAkunCukup(db, {
        accountId: kreditAccountId,
        namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
        nominalKeluar: input.nilaiPerolehan,
      });
      if (!cekSaldo.valid) throw new Error(cekSaldo.reason);
    } else {
      // Pembelian kredit: utang ke pemasok, belum menyentuh kas/bank
      // sampai dilunasi (lewat sub-fitur "Kewajiban" seperti utang
      // lainnya) — akun diresolusi lewat AccountMapping (BUKAN query
      // nama akun hard-code lagi, lihat AccountMapping.ts) supaya COA
      // tetap configurable seperti transaksi otomatis lainnya.
      kreditAccountId = await resolveAccountId(db, 'UTANG_USAHA', 'KREDIT_DEFAULT');
    }

    const year = new Date(input.tanggal).getFullYear();
    const nomorAset = await nextSequence(db, 'AST', year);
    const sumberTransaksi = input.jenisAset === 'TAK_BERWUJUD' ? 'ASET_TAK_BERWUJUD' : 'ASET_TETAP';
    const labelJenis = input.jenisAset === 'TAK_BERWUJUD' ? 'aset tak berwujud' : 'aset';

    // PHASE 5 (§F/§G, permintaan pengguna): TIDAK mengubah kontrak
    // input (tetap kelompokAset/subKelompokAset TEXT, form Pembelian
    // Aset yang "sudah benar" TIDAK disentuh) — tapi sekarang dicari
    // & divalidasi ke master `aset_klasifikasi` supaya `aset_tetap`
    // punya relasi NYATA (FK), bukan cuma teks bebas. Kalau kosong,
    // tetap opsional seperti sebelumnya (klasifikasi wajib HANYA
    // untuk jalur Modal/Barang, lihat catatAsetTetapDariModalBarang).
    const klasifikasi = await resolveKlasifikasiAsetByNama(db, input.kelompokAset, input.subKelompokAset);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi,
      nomorReferensi: nomorAset,
      deskripsi: `Perolehan ${labelJenis} ${input.namaAset} (${input.metodePembayaran}) - ${nomorAset}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: asetAccountId, debit: input.nilaiPerolehan, kredit: 0 },
        { accountId: kreditAccountId, debit: 0, kredit: input.nilaiPerolehan },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO aset_tetap
        (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan,
         metode_pembayaran, sumber, keterangan, journal_id, created_by, created_at, kelompok_aset, sub_kelompok_aset, jenis_aset, aset_klasifikasi_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      nomorAset,
      input.namaAset,
      input.nilaiPerolehan,
      input.nilaiResidu ?? 0,
      input.masaManfaatBulan,
      // BUG-06: register aset memakai TANGGAL PEROLEHAN, bukan tanggal
      // transaksi. Jurnal di atas tetap memakai tanggal transaksi.
      tanggalPerolehan,
      input.metodePembayaran,
      'PEMBELIAN',
      input.keterangan ?? null,
      journalId,
      input.createdBy,
      now,
      input.kelompokAset ?? null,
      input.subKelompokAset ?? null,
      input.jenisAset ?? 'TETAP',
      klasifikasi?.id ?? null
    );

    // Pembelian kredit: catat sebagai baris `utang` (jenis UTANG_USAHA)
    // supaya terdeteksi & bisa dilunasi lewat sub-fitur "Kewajiban" —
    // lihat UtangService.catatUtangUsahaDariAset untuk penjelasan gap
    // yang ditutup ini. Satu transaksi DB yang sama dengan jurnal &
    // baris aset_tetap di atas (db diteruskan, bukan withTransaction
    // baru).
    if (input.metodePembayaran === 'KREDIT') {
      await catatUtangUsahaDariAset(db, {
        namaPemasok: input.namaPemasok!.trim(),
        nilaiPerolehan: input.nilaiPerolehan,
        tanggal: input.tanggal,
        journalId,
        asetTetapId: id,
        createdBy: input.createdBy,
      });
    }

    return { id, nomorAset, journalId };
  });
}

export interface AsetListItem {
  id: string;
  nomorAset: string;
  namaAset: string;
  /** Bagian G — null untuk aset lama sebelum migrasi klasifikasi (fallback "Belum Diklasifikasikan" di UI). */
  kelompokAset: string | null;
  subKelompokAset: string | null;
  /** PHASE 5 (§G) — FK nyata ke aset_klasifikasi, null untuk aset lama/tanpa klasifikasi. */
  asetKlasifikasiId: string | null;
  nilaiPerolehan: Rupiah;
  nilaiResidu: Rupiah;
  masaManfaatBulan: number;
  tanggalPerolehan: string;
  metodePembayaran: 'TUNAI' | 'KREDIT';
  sumber: 'PEMBELIAN' | 'MODAL_BARANG';
  status: 'AKTIF' | 'DIHAPUS';
  /** Prioritas 8/J — default 'TETAP' untuk baris lama (lihat migration v25). */
  jenisAset: 'TETAP' | 'TAK_BERWUJUD';
  /**
   * RC-S54 T16 GAP 6 — semantik status DIHAPUS, diturunkan dari jurnal (tanpa kolom baru):
   * PELEPASAN_ASET_TETAP (ada jurnal pelepasan), KOREKSI_SALAH_INPUT (jurnal perolehan
   * dibalik), DIHAPUS_TANPA_JURNAL (warisan pra-GAP 6); null untuk aset AKTIF.
   */
  jenisPenutupan?: 'PELEPASAN_ASET_TETAP' | 'KOREKSI_SALAH_INPUT' | 'DIHAPUS_TANPA_JURNAL' | null;
}

/** Daftar aset tetap (dari pembelian maupun modal barang) — untuk layar register aset. Default HANYA status AKTIF (§10) — set termasukDihapus:true untuk audit/riwayat. */
export async function listAset(opts: { termasukDihapus?: boolean } = {}): Promise<AsetListItem[]> {
  const db = await getDb();
  const where = opts.termasukDihapus ? '' : `WHERE COALESCE(status, 'AKTIF') = 'AKTIF'`;
  const rows = await db.getAllAsync<any>(
    `SELECT aset_tetap.*,
            (SELECT COUNT(*) FROM journal jp WHERE jp.sumber_transaksi = 'PELEPASAN_ASET_TETAP' AND jp.sumber_id = aset_tetap.id AND jp.status = 'POSTED') AS ada_pelepasan,
            (SELECT jq.status FROM journal jq WHERE jq.id = aset_tetap.journal_id) AS status_jurnal_perolehan
       FROM aset_tetap ${where} ORDER BY tanggal_perolehan DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    nomorAset: r.nomor_aset,
    namaAset: r.nama_aset,
    kelompokAset: r.kelompok_aset ?? null,
    asetKlasifikasiId: r.aset_klasifikasi_id ?? null,
    subKelompokAset: r.sub_kelompok_aset ?? null,
    nilaiPerolehan: r.nilai_perolehan,
    nilaiResidu: r.nilai_residu ?? 0,
    masaManfaatBulan: r.masa_manfaat_bulan,
    tanggalPerolehan: r.tanggal_perolehan,
    metodePembayaran: r.metode_pembayaran,
    sumber: r.sumber,
    status: r.status ?? 'AKTIF',
    jenisAset: r.jenis_aset ?? 'TETAP',
    jenisPenutupan:
      (r.status ?? 'AKTIF') !== 'DIHAPUS'
        ? null
        : r.ada_pelepasan > 0
          ? 'PELEPASAN_ASET_TETAP'
          : r.status_jurnal_perolehan === 'REVERSED'
            ? 'KOREKSI_SALAH_INPUT'
            : 'DIHAPUS_TANPA_JURNAL',
  }));
}

export interface AsetDenganNilaiBukuItem extends AsetListItem {
  akumulasiPenyusutan: Rupiah;
  /** RC-S88 — akumulasi selisih revaluasi yang diposting (bertanda; 0 = tidak pernah direvaluasi). */
  selisihRevaluasi: Rupiah;
  nilaiBuku: Rupiah;
  /**
   * RC-S54 item 7 — penyusutan (atau amortisasi) per bulan.
   *
   * Dihitung `hitungPenyusutanBulanan()` dari `PenyusutanService` —
   * MESIN YANG SAMA yang dipakai `prosesPenyusutanAset()` saat menjurnal.
   * Disediakan di sini supaya layar cukup menampilkan hasilnya dan tidak
   * perlu menyalin rumus apa pun ke UI.
   */
  penyusutanPerBulan: Rupiah;
}

/**
 * Daftar aset tetap LENGKAP dengan akumulasi penyusutan & nilai buku
 * (Bagian F2 permintaan pengguna, hub "Rincian Laporan Lainnya" —
 * READ-ONLY, bukan transaksi). Akumulasi dijumlah langsung dari
 * `aset_penyusutan` (proses yang sama dipakai PenyusutanService,
 * BUKAN dihitung ulang dengan rumus terpisah) — nilai buku = nilai
 * perolehan - akumulasi, di-floor ke nilai residu (tidak pernah di
 * bawah nilai residu, apalagi negatif).
 *
 * DATE-SCOPING (Phase 17/§1): `asOfDate` OPSIONAL — kalau diisi,
 * fungsi ini menghasilkan kondisi aset "per tanggal tsb", bukan
 * kondisi sekarang:
 *  - Aset yang tanggal_perolehan-nya > asOfDate TIDAK muncul (belum
 *    ada/belum dibeli pada tanggal itu).
 *  - Aset berstatus DIHAPUS TETAP muncul kalau penghapusannya terjadi
 *    SETELAH asOfDate (masih dimiliki pada tanggal itu) — hanya
 *    disembunyikan kalau penghapusannya <= asOfDate.
 *  - akumulasiPenyusutan/nilaiBuku dihitung dari baris `aset_penyusutan`
 *    yang tanggal-nya <= asOfDate saja (bukan akumulasi all-time).
 *
 * KETERBATASAN YANG DIDOKUMENTASIKAN (bukan diakali/dikarang): tabel
 * `aset_tetap` TIDAK punya kolom "tanggal pelepasan" terpisah —
 * penghapusan aset (`AsetService.hapusAset`) hanya mencatat
 * status='DIHAPUS' + `updated_at` (waktu aksi hapus dilakukan, apa
 * adanya, tidak bisa di-backdate lewat form). Kolom `updated_at`
 * itulah yang dipakai sebagai proksi tanggal pelepasan di sini — field
 * yang BENAR-BENAR ADA di skema, bukan field karangan. Kalau suatu
 * saat dibutuhkan tanggal pelepasan yang bisa diisi user secara
 * independen dari waktu klik "Hapus", itu perlu kolom baru (di luar
 * lingkup Phase 17 ini karena bukan sekadar date-scoping laporan).
 *
 * TANPA asOfDate: perilaku PERSIS SAMA seperti sebelumnya (kondisi
 * sekarang) — kompatibel penuh dengan seluruh consumer existing
 * (DaftarAsetTetapScreen, AsetListScreen) yang memang butuh daftar aset
 * TERKINI, bukan historis.
 */
export async function listAsetDenganNilaiBuku(asOfDate?: string): Promise<AsetDenganNilaiBukuItem[]> {
  const db = await getDb();
  const akumulasiSubquery = asOfDate
    ? `(SELECT SUM(nilai_penyusutan) FROM aset_penyusutan WHERE aset_id = a.id AND tanggal <= ?)`
    : `(SELECT SUM(nilai_penyusutan) FROM aset_penyusutan WHERE aset_id = a.id)`;

  const whereClause = asOfDate
    ? `WHERE a.tanggal_perolehan <= ?
       AND NOT (a.status = 'DIHAPUS' AND NOT EXISTS (
             SELECT 1 FROM journal jp WHERE jp.sumber_transaksi = 'PELEPASAN_ASET_TETAP' AND jp.sumber_id = a.id AND jp.status = 'POSTED')
             AND a.updated_at IS NOT NULL AND substr(a.updated_at,1,10) <= ?)
       AND NOT (a.status = 'DIHAPUS' AND EXISTS (
             SELECT 1 FROM journal jp WHERE jp.sumber_transaksi = 'PELEPASAN_ASET_TETAP' AND jp.sumber_id = a.id AND jp.status = 'POSTED'
               AND substr(jp.tanggal,1,10) <= ?))`
    : '';
  // Urutan parameter HARUS persis mengikuti urutan tanda tanya di SQL
  // di atas: 1) tanggal di akumulasiSubquery, 2) tanggal_perolehan,
  // 3) tanggal dihapus (koreksi/warisan), 4) tanggal jurnal pelepasan
  // (RC-S54 T16 GAP 6 — aset dilepas keluar sejak TANGGAL PELEPASAN).
  const params: string[] = asOfDate ? [asOfDate, asOfDate, asOfDate, asOfDate] : [];

  const rows = await db.getAllAsync<any>(
    `SELECT a.*, COALESCE(${akumulasiSubquery}, 0) as akumulasi
     FROM aset_tetap a ${whereClause} ORDER BY a.tanggal_perolehan DESC`,
    ...params
  );
  const hasil: AsetDenganNilaiBukuItem[] = [];
  for (const r of rows) {
    const nilaiResidu = r.nilai_residu ?? 0;
    // RC-S88 — aset yang direvaluasi: nilai buku = perolehan + selisih
    // revaluasi − akumulasi penyusutan, dan penyusutan per bulan memakai
    // dasar revaluasi (mesin yang SAMA dengan prosesPenyusutanAset).
    const selisihRevaluasi = await getSelisihRevaluasiAsetPadaDb(db, r.id, asOfDate);
    const nilaiBukuMentah = r.nilai_perolehan + selisihRevaluasi - r.akumulasi;
    const nilaiBuku = selisihRevaluasi !== 0 ? Math.max(nilaiBukuMentah, 0) : Math.max(nilaiBukuMentah, nilaiResidu, 0);
    const penyusutanPerBulan = selisihRevaluasi !== 0
      ? (await getDasarPenyusutanAsetPadaDb(db, r)).nilaiBulanan
      : hitungPenyusutanBulanan(r.nilai_perolehan, nilaiResidu, r.masa_manfaat_bulan);
    hasil.push({
      penyusutanPerBulan,
      id: r.id,
      nomorAset: r.nomor_aset,
      namaAset: r.nama_aset,
      asetKlasifikasiId: r.aset_klasifikasi_id ?? null,
      kelompokAset: r.kelompok_aset ?? null,
      subKelompokAset: r.sub_kelompok_aset ?? null,
      nilaiPerolehan: r.nilai_perolehan,
      nilaiResidu,
      masaManfaatBulan: r.masa_manfaat_bulan,
      tanggalPerolehan: r.tanggal_perolehan,
      metodePembayaran: r.metode_pembayaran,
      sumber: r.sumber,
      status: r.status ?? 'AKTIF',
      jenisAset: r.jenis_aset ?? 'TETAP',
      // RC-S54 T16 GAP 6: daftar ini = aset yang masih tercatat per tanggal; semantik penutupan ada di listAset().
      jenisPenutupan: null,
      akumulasiPenyusutan: r.akumulasi,
      selisihRevaluasi,
      nilaiBuku,
    });
  }
  return hasil;
}

export interface AsetDetail extends AsetListItem {
  keterangan: string | null;
  journalId: string | null;
}

/** Detail satu aset tetap (untuk layar AsetDetailScreen — read-only, PRD/audit §19,§33). */
export async function getAsetById(id: string): Promise<AsetDetail | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM aset_tetap WHERE id = ?`, id);
  if (!row) return null;
  return {
    id: row.id,
    nomorAset: row.nomor_aset,
    asetKlasifikasiId: row.aset_klasifikasi_id ?? null,
    namaAset: row.nama_aset,
    kelompokAset: row.kelompok_aset ?? null,
    subKelompokAset: row.sub_kelompok_aset ?? null,
    nilaiPerolehan: row.nilai_perolehan,
    nilaiResidu: row.nilai_residu ?? 0,
    masaManfaatBulan: row.masa_manfaat_bulan,
    tanggalPerolehan: row.tanggal_perolehan,
    metodePembayaran: row.metode_pembayaran,
    sumber: row.sumber,
    status: row.status ?? 'AKTIF',
    jenisAset: row.jenis_aset ?? 'TETAP',
    keterangan: row.keterangan,
    journalId: row.journal_id,
  };
}

/**
 * Helper internal (dipakai ModalService.ts untuk "Modal Barang") —
 * insert satu baris register aset_tetap TANPA membuat jurnal sendiri,
 * karena jurnalnya (Debit Aset Tetap, Kredit Ekuitas Lainnya) sudah
 * dibuat oleh pemanggil. Dipisah dari beliAset() karena kredit-nya
 * beda akun (Modal, bukan Kas/Bank/Utang Usaha) dan HARUS satu
 * transaksi DB dengan jurnal itu — makanya `db` diteruskan dari luar,
 * bukan withTransaction sendiri di sini.
 */
/**
 * PHASE 5 (§F, permintaan pengguna) — SEBELUMNYA fungsi ini TIDAK
 * menerima kelompokAset/subKelompokAset sama sekali (bug yang
 * diidentifikasi Phase 5: "Direct Beli Aset SUDAH mengirim
 * classification, tapi terimaModalBarang() -> ini belum") — DIPERBAIKI.
 * `kelompokAset`/`subKelompokAset` SEKARANG WAJIB (§I: "Klasifikasi
 * wajib jika aset tersebut memang termasuk aset tetap" — fungsi ini
 * SELALU membuat aset tetap) & divalidasi terhadap master
 * `aset_klasifikasi` (harus ada & aktif) lewat
 * `resolveKlasifikasiAsetByNama` — SAMA PERSIS mekanisme yang
 * sekarang dipakai `beliAset` di atas, TIDAK ADA rumus/validasi kedua.
 */
export async function catatAsetTetapDariModalBarang(
  db: SQLite.SQLiteDatabase,
  params: {
    namaAset: string;
    nilaiPerolehan: Rupiah;
    masaManfaatBulan: number;
    tanggal: string;
    journalId: string;
    kelompokAset: string;
    subKelompokAset: string;
    /**
     * RC-S50 §2 — jenis aset untuk barang yang disetor sebagai modal.
     *
     * ROOT CAUSE yang ditutup: kolom `aset_tetap.jenis_aset` SUDAH ADA
     * (dipakai `beliAset` sejak Prioritas 8/J) dan PenyusutanService
     * SUDAH memilih mapping `AMORTISASI_ASET_TAK_BERWUJUD` vs
     * `PENYUSUTAN_ASET` berdasarkan kolom itu. Tetapi INSERT di bawah
     * TIDAK PERNAH menyertakan kolomnya, sehingga setiap barang modal
     * masuk sebagai NULL -> dibaca 'TETAP'. Jadi yang hilang bukan
     * skema dan bukan logic amortisasi — hanya satu kolom yang tidak
     * pernah diisi di jalur ini.
     *
     * Default 'TETAP' menjaga perilaku lama untuk pemanggil yang tidak
     * mengirimnya.
     */
    jenisAset?: 'TETAP' | 'TAK_BERWUJUD';
    keterangan?: string;
    createdBy: string;
  }
): Promise<{ id: string; nomorAset: string }> {
  const klasifikasi = await resolveKlasifikasiAsetByNama(db, params.kelompokAset, params.subKelompokAset);
  if (!klasifikasi) {
    // resolveKlasifikasiAsetByNama hanya return null kalau KEDUA field
    // kosong — untuk jalur Modal/Barang ini WAJIB diisi (§I), jadi
    // null di sini berarti caller tidak mengisinya sama sekali.
    throw new Error('Klasifikasi aset (Kelompok & Sub Kelompok) wajib diisi untuk barang yang menjadi aset tetap.');
  }

  const year = new Date(params.tanggal).getFullYear();
  const nomorAset = await nextSequence(db, 'AST', year);
  const id = newId();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO aset_tetap
      (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan,
       metode_pembayaran, sumber, keterangan, journal_id, created_by, created_at, kelompok_aset, sub_kelompok_aset, jenis_aset, aset_klasifikasi_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    nomorAset,
    params.namaAset,
    params.nilaiPerolehan,
    0,
    params.masaManfaatBulan,
    params.tanggal,
    'TUNAI',
    'MODAL_BARANG',
    params.keterangan ?? null,
    params.journalId,
    params.createdBy,
    now,
    params.kelompokAset,
    params.subKelompokAset,
    params.jenisAset ?? 'TETAP',
    klasifikasi.id
  );
  return { id, nomorAset };
}

/** Cek apakah aset sudah pernah disusutkan (dipakai UI untuk mengunci field struktural — §9/§10). */
export async function asetSudahDisusutkan(id: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM aset_penyusutan WHERE aset_id = ?`, id);
  return (row?.cnt ?? 0) > 0;
}

/**
 * Update pasca-Phase 18 §9/§10 (permintaan pengguna): Edit aset tetap.
 *
 * Field AMAN (tidak menyentuh jurnal/penyusutan) — SELALU boleh diubah:
 * nama, kelompok, sub kelompok, keterangan.
 *
 * Field STRUKTURAL (nilai perolehan, nilai residu, masa manfaat,
 * tanggal perolehan) — mempengaruhi jurnal perolehan &/atau
 * perhitungan penyusutan:
 *  - Kalau aset BELUM PERNAH disusutkan (`aset_penyusutan` kosong):
 *    boleh diubah. `nilaiPerolehan`/`tanggalPerolehan` mengoreksi
 *    jurnal perolehan lewat reversal+repost (prinsip sama dengan
 *    editPencairanPinjaman) — BUKAN UPDATE jurnal mentah.
 *    `masaManfaatBulan`/`nilaiResidu` aman diubah langsung (tidak
 *    pernah masuk jurnal, cuma dipakai PenyusutanService yang selalu
 *    membaca nilai TERBARU dari tabel ini, jadi tidak ada histori
 *    yang jadi salah).
 *  - Kalau SUDAH PERNAH disusutkan: DITOLAK — mengubah salah satu dari
 *    empat field ini akan membuat penyusutan yang SUDAH DIPOSTING
 *    tidak konsisten dengan skedul baru. Sesuai instruksi ("perubahan
 *    yang memengaruhi penyusutan harus dikonfirmasi, recalculation
 *    dilakukan dengan aman") — recalculation retroaktif yang aman
 *    lintas periode (termasuk kemungkinan periode sudah CLOSED)
 *    berisiko tinggi salah hitung, jadi SENGAJA diblokir dengan alasan
 *    jelas daripada mencoba recalculation otomatis yang bisa keliru.
 */
export async function updateAset(input: {
  id: string;
  namaAset: string;
  /** PHASE 5 (§G/§L): kalau diisi (keduanya bersama), divalidasi & aset_klasifikasi_id diturunkan otomatis — aman diubah kapan pun (lihat komentar di badan fungsi). */
  kelompokAset?: string;
  subKelompokAset?: string;
  keterangan?: string;
  // Field struktural — opsional; kalau diisi & BERBEDA dari nilai
  // existing, dicek aman-tidaknya (lihat komentar di atas).
  nilaiPerolehan?: Rupiah;
  nilaiResidu?: Rupiah;
  masaManfaatBulan?: number;
  tanggalPerolehan?: string;
  sumberDana?: 'KAS' | 'BANK';
  bankAccountId?: string;
  alasanKoreksi?: string;
  actingUserId: string;
}): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.actingUserId, 'kas_bank', 'edit');
    if (!input.namaAset.trim()) throw new Error('Nama aset wajib diisi.');

    const existing = await db.getFirstAsync<any>('SELECT * FROM aset_tetap WHERE id = ?', input.id);
    if (!existing) throw new Error('Aset tidak ditemukan.');
    if ((existing.status ?? 'AKTIF') === 'DIHAPUS') {
      throw new Error('Aset ini sudah dihapus/nonaktif — tidak dapat diedit.');
    }

    const sudahDisusutkan = await db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM aset_penyusutan WHERE aset_id = ?`,
      input.id
    );
    // RC-S88: aset yang sudah DIREVALUASI diperlakukan sama dengan aset
    // yang sudah disusutkan — nilai struktural terkunci, karena nilai
    // revaluasi & dasar penyusutannya bergantung pada nilai tersebut.
    const punyaPenyusutan = (sudahDisusutkan?.cnt ?? 0) > 0 || (await punyaRevaluasiDiposting(db, input.id));

    const nilaiPerolehanBaru = input.nilaiPerolehan ?? existing.nilai_perolehan;
    const nilaiResiduBaru = input.nilaiResidu ?? existing.nilai_residu ?? 0;
    const masaManfaatBaru = input.masaManfaatBulan ?? existing.masa_manfaat_bulan;
    const tanggalBaru = input.tanggalPerolehan ?? existing.tanggal_perolehan;

    const strukturBerubah =
      nilaiPerolehanBaru !== existing.nilai_perolehan ||
      nilaiResiduBaru !== (existing.nilai_residu ?? 0) ||
      masaManfaatBaru !== existing.masa_manfaat_bulan ||
      tanggalBaru !== existing.tanggal_perolehan;

    if (strukturBerubah && punyaPenyusutan) {
      throw new Error(
        'Nilai perolehan, nilai residu, masa manfaat, dan tanggal perolehan tidak dapat diubah karena aset ini sudah memiliki histori penyusutan. Hanya nama, klasifikasi, dan keterangan yang dapat diedit.'
      );
    }
    if (strukturBerubah) {
      validasiMasaManfaatDanResidu(nilaiPerolehanBaru, nilaiResiduBaru, masaManfaatBaru);
    }

    const now = new Date().toISOString();

    // PHASE 5 (§G/§L, permintaan pengguna): klasifikasi (kelompok/
    // sub-kelompok/FK) TETAP diperlakukan sebagai "field aman" SAMA
    // SEPERTI SEBELUM Phase 5 (lihat komentar besar di atas fungsi
    // ini) — boleh diubah KAPAN PUN, termasuk setelah aset punya
    // histori penyusutan. Ini AMAN karena kelompok/sub-kelompok/FK
    // klasifikasi murni LABEL deskriptif — TIDAK PERNAH masuk
    // perhitungan jurnal apa pun (nilai_perolehan/nilai_residu/
    // masa_manfaat_bulan pada aset_tetap-lah yang menentukan
    // penyusutan, dan field itu SUDAH dikunci begitu punyaPenyusutan
    // di atas). Mengubah klasifikasi TIDAK mengubah satu jurnal/baris
    // penyusutan historis pun secara diam-diam — §L terpenuhi karena
    // tidak ada "historical accounting" yang tersentuh, bukan karena
    // perubahan classification diblokir.
    const klasifikasiBaru = await resolveKlasifikasiAsetByNama(db, input.kelompokAset, input.subKelompokAset);

    // Nilai perolehan/tanggal berubah -> jurnal perolehan lama harus
    // dikoreksi (reversal + repost), BUKAN UPDATE jurnal mentah.
    const jurnalPerluDikoreksi = punyaPenyusutan
      ? false // sudah pasti ditolak di atas kalau ada perbedaan; baris ini murni untuk kejelasan logika
      : nilaiPerolehanBaru !== existing.nilai_perolehan || tanggalBaru !== existing.tanggal_perolehan;

    let journalIdBaru: string | null = existing.journal_id;
    if (jurnalPerluDikoreksi && existing.journal_id) {
      if (!input.alasanKoreksi?.trim()) {
        throw new Error('Alasan koreksi wajib diisi kalau nilai perolehan atau tanggal perolehan diubah.');
      }
      await reverseJournal(db, existing.journal_id, input.actingUserId, `Koreksi aset: ${input.alasanKoreksi}`);

      const asetAccountId = await resolveAccountId(
        db,
        (existing.jenis_aset ?? 'TETAP') === 'TAK_BERWUJUD' ? 'ASET_TAK_BERWUJUD' : 'ASET_TETAP',
        'DEBIT_ASET'
      );
      let kreditAccountId: string;
      if (existing.metode_pembayaran === 'KREDIT') {
        kreditAccountId = await resolveAccountId(db, 'UTANG_USAHA', 'KREDIT_DEFAULT');
      } else if (existing.sumber === 'MODAL_BARANG') {
        kreditAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_DANA_LAINNYA');
      } else {
        if (!input.sumberDana) {
          throw new Error('Sumber dana (Kas/Bank) wajib dipilih untuk mengoreksi nilai pembelian tunai.');
        }
        kreditAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
        const cekSaldo = await checkSaldoAkunCukup(db, {
          accountId: kreditAccountId,
          namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
          nominalKeluar: nilaiPerolehanBaru,
        });
        if (!cekSaldo.valid) throw new Error(cekSaldo.reason);
      }

      const year = new Date(tanggalBaru).getFullYear();
      const nomorKoreksi = await nextSequence(db, 'AST', year);
      const { journalId } = await createJournal(db, {
        tanggal: tanggalBaru,
        sumberTransaksi: (existing.jenis_aset ?? 'TETAP') === 'TAK_BERWUJUD' ? 'ASET_TAK_BERWUJUD' : 'ASET_TETAP',
        nomorReferensi: existing.nomor_aset,
        deskripsi: `Koreksi perolehan aset ${input.namaAset} - ${input.alasanKoreksi}`,
        createdBy: input.actingUserId,
        lines: [
          { accountId: asetAccountId, debit: nilaiPerolehanBaru, kredit: 0 },
          { accountId: kreditAccountId, debit: 0, kredit: nilaiPerolehanBaru },
        ],
      });
      journalIdBaru = journalId;
    }

    await db.runAsync(
      `UPDATE aset_tetap SET
        nama_aset = ?, kelompok_aset = ?, sub_kelompok_aset = ?, aset_klasifikasi_id = ?, keterangan = ?,
        nilai_perolehan = ?, nilai_residu = ?, masa_manfaat_bulan = ?, tanggal_perolehan = ?,
        journal_id = ?, updated_at = ?
       WHERE id = ?`,
      input.namaAset.trim(),
      input.kelompokAset ?? null,
      input.subKelompokAset ?? null,
      klasifikasiBaru?.id ?? null,
      input.keterangan ?? null,
      nilaiPerolehanBaru,
      nilaiResiduBaru,
      masaManfaatBaru,
      tanggalBaru,
      journalIdBaru,
      now,
      input.id
    );
  });
}

/**
 * Hapus/nonaktifkan aset tetap (§9/§10, permintaan pengguna). TIDAK
 * PERNAH DELETE fisik dari `aset_tetap` — selalu soft-delete
 * (`status = 'DIHAPUS'`) supaya histori jurnal/penyusutan tetap valid.
 * Dua jalur tergantung ada-tidaknya histori penyusutan:
 *  - BELUM PERNAH disusutkan: jurnal perolehan di-REVERSAL (piutang/
 *    kas/utang usaha yang terpakai kembali seperti semula) — aset ini
 *    "benar-benar dibatalkan pembeliannya".
 *  - SUDAH PERNAH disusutkan: jurnal (perolehan MAUPUN seluruh
 *    penyusutan yang sudah diposting) TIDAK disentuh sama sekali —
 *    hanya status yang berubah jadi nonaktif. Membalik histori
 *    penyusutan yang mungkin sudah melewati periode CLOSED berisiko
 *    tinggi salah/tidak konsisten, jadi sengaja tidak dicoba
 *    (instruksi eksplisit mengizinkan jalur "status nonaktif" untuk
 *    kasus ini).
 */
export const KODE_KOREKSI_ASET_DITOLAK_LIFECYCLE = 'KOREKSI_ASET_DITOLAK_LIFECYCLE' as const;

/** RC-S88 — apakah aset ini punya revaluasi yang sudah DIPOSTING. */
async function punyaRevaluasiDiposting(db: SQLite.SQLiteDatabase, asetId: string): Promise<boolean> {
  try {
    const r = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM penyesuaian_nilai_wajar WHERE objek = 'ASET_TETAP' AND aset_tetap_id = ? AND status = 'DIPOSTING'`,
      asetId
    );
    return (r?.n ?? 0) > 0;
  } catch (e) {
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}

/** RC-S54 T16 GAP 6 — koreksi salah input atas aset yang sudah memiliki histori penyusutan. */
export class KoreksiAsetTetapDitolakError extends Error {
  readonly kode = KODE_KOREKSI_ASET_DITOLAK_LIFECYCLE;
  constructor(namaAset: string) {
    super(
      `${KODE_KOREKSI_ASET_DITOLAK_LIFECYCLE}: "${namaAset}" sudah memiliki histori penyusutan, sehingga tidak dapat dihapus ` +
        `sebagai koreksi salah input. Bila aset benar-benar dijual/dibuang, gunakan Pelepasan Aset Tetap.`
    );
    this.name = 'KoreksiAsetTetapDitolakError';
  }
}

export async function hapusAset(params: { id: string; alasan: string; actingUserId: string }): Promise<{ direversal: boolean }> {
  return withTransaction(async (db) => {
    await requirePermission(db, params.actingUserId, 'kas_bank', 'edit');
    if (!params.alasan.trim()) throw new Error('Alasan penghapusan aset wajib diisi.');

    const existing = await db.getFirstAsync<any>('SELECT * FROM aset_tetap WHERE id = ?', params.id);
    if (!existing) throw new Error('Aset tidak ditemukan.');
    if ((existing.status ?? 'AKTIF') === 'DIHAPUS') {
      throw new Error('Aset ini sudah dihapus/nonaktif sebelumnya.');
    }

    const sudahDisusutkan = await db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM aset_penyusutan WHERE aset_id = ?`,
      params.id
    );
    // RC-S88: aset yang sudah direvaluasi juga tidak boleh "dibatalkan"
    // lewat reversal perolehan — selisih revaluasinya akan tertinggal di GL.
    const punyaPenyusutan = (sudahDisusutkan?.cnt ?? 0) > 0 || (await punyaRevaluasiDiposting(db, params.id));

    // RC-S54 TAHAP 16 GAP 6: fungsi ini = KOREKSI_SALAH_INPUT. Aset yang sudah
    // disusutkan tidak boleh dikoreksi lewat penghapusan/reversal perolehan
    // generik (dulu hanya status DIHAPUS -> biaya & akumulasi tertinggal di GL).
    // Penjualan/pembuangan nyata memakai PelepasanAsetTetapService.lepaskanAsetTetap.
    if (punyaPenyusutan) {
      throw new KoreksiAsetTetapDitolakError((existing as { nama_aset: string }).nama_aset);
    }

    let direversal = false;
    if (!punyaPenyusutan && existing.journal_id) {
      await reverseJournal(db, existing.journal_id, params.actingUserId, `Aset dihapus: ${params.alasan}`);
      direversal = true;
    }

    const now = new Date().toISOString();
    await db.runAsync(`UPDATE aset_tetap SET status = 'DIHAPUS', keterangan = ?, updated_at = ? WHERE id = ?`, params.alasan, now, params.id);

    return { direversal };
  });
}
