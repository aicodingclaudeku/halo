import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import {
  KEBIJAKAN_PENARIKAN_DINI_TERSEDIA,
  PESAN_PENARIKAN_DINI_TANPA_KEBIJAKAN,
} from '@/accounting/SimpananBerjangkaKebijakanPencairan';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { TenorSimpananBerjangka } from '@/accounting/SimpananBerjangkaTenor';
import {
  buatJadwalBungaSimpananBerjangka,
  hitungTotalBungaKontrak,
  periodePascaJatuhTempoBerikutnya,
  periodePascaJatuhTempoEarned,
  periodeYangSudahEarned,
} from '@/accounting/SimpananBerjangkaBunga';
import { StatusSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  hitungPphBungaSimpananPeriodeAgregatPadaDb,
  catatBuktiPotongBungaSimpananPadaDb,
} from '@/services/PphPotongService';
import { idAkunUtangPphBungaSimpanan } from '@/services/PajakService';

/**
 * ============================================================
 * LIFECYCLE BUNGA, JATUH TEMPO & PENCAIRAN SIMPANAN BERJANGKA
 * ============================================================
 *
 *   SETOR -> AKTIF -> AKRUAL BUNGA KONTRAK -> JATUH_TEMPO
 *         -> AKRUAL BUNGA PASCA-JATUH-TEMPO selama belum dicairkan (RC-S128,
 *            hanya bila snapshot kebijakan kontrak mengaktifkannya)
 *         -> TRANSFER BUNGA KE SIMPANAN SUKARELA -> DICAIRKAN (pokok saja)
 *
 * JATUH_TEMPO hanya perubahan status: pokok TIDAK otomatis dicairkan dan
 * kontrak TIDAK otomatis diperpanjang. Bunga pasca jatuh tempo memakai
 * pokok asli dan rate dari SNAPSHOT kebijakan kontrak; periodenya baris
 * `simpanan_berjangka_bunga` berjenis PASCA_JATUH_TEMPO (lihat
 * `periodePascaJatuhTempoEarned`, satu-satunya penentu periode).
 *
 * TIGA JURNAL, MASING-MASING SATU KALI SAJA:
 *
 *   1. Penempatan (SimpananBerjangkaService.setorSimpananBerjangka)
 *        Dr Kas/Bank              pokok
 *        Cr 2-1210                pokok
 *
 *   2. Akrual bunga per periode (di sini, prosesAkrualBunga...)
 *        Dr 5-1955 Beban Bunga Simpanan Berjangka   bunga periode
 *        Cr 2-1710 Utang Bunga Simpanan Berjangka   bunga periode
 *      2-1210 TIDAK DISENTUH — pokok tidak pernah bertambah oleh bunga.
 *
 *   3. Pencairan (di sini, cairkanSimpananBerjangka)
 *        Dr 2-1210                pokok
 *        Dr 2-1710                total bunga terutang
 *        Cr Kas/Bank              pokok + bunga
 *      TIDAK ADA beban bunga kedua di sini. Bebannya sudah diakui
 *      seluruhnya pada langkah 2; pencairan hanya melunasi kewajiban.
 *      Inilah alasan utama bunga WAJIB melewati akrual lebih dulu.
 *
 * SEMUA jurnal dibuat lewat `createJournal()` — tidak ada satu pun
 * INSERT langsung ke `journal`/`journal_entry` di modul ini. Dengan
 * begitu guard periode tertutup, keseimbangan debit=kredit, dan
 * invarian Rupiah bulat berlaku otomatis dan tidak diduplikasi.
 *
 * BUKAN EIR: `EirAccountingService` tidak diimpor maupun dipanggil.
 *
 * RC-S86 — PPh PASAL 4(2) BUNGA SIMPANAN dipasang TEPAT di jurnal
 * langkah 3 (§B transfer ke Sukarela) DAN di jurnal pencairan, karena
 * itulah dua titik bunga BENAR-BENAR menjadi hak anggota yang bisa
 * dipakai/ditarik (lihat `PphPotongService.ts` untuk rincian kebijakan
 * lengkap). Akrual (langkah 2) TIDAK disentuh sama sekali — bunga di
 * situ belum tersedia bagi anggota, jadi belum objek pemotongan.
 */

export const TRANSAKSI_BUNGA_AKRUAL = 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL';
export const TRANSAKSI_PENCAIRAN = 'SIMPANAN_BERJANGKA_PENCAIRAN';
/**
 * §B — pemindahan bunga terakru ke Simpanan Sukarela.
 *
 * Dipakai sebagai `sumber_transaksi` jurnal, dan bersama `sumber_id`
 * (= id baris `simpanan_berjangka_bunga`) ia MEMBENTUK KUNCI PERIODE
 * yang deterministik: kontrak + nomor periode + jenis transaksi.
 */
export const TRANSAKSI_BUNGA_TRANSFER = 'SIMPANAN_BERJANGKA_BUNGA_TRANSFER';

interface KontrakRow {
  id: string;
  anggota_id: string;
  nomor_transaksi: string;
  tanggal_mulai: string;
  tanggal_jatuh_tempo: string;
  nominal: number;
  tenor_bulan: number;
  suku_bunga: number;
  status: StatusSimpananBerjangka;
  bunga_terakru: number;
  bunga_dibayar: number;
  // RC-S128 — snapshot kebijakan produk (NULL untuk kontrak legacy).
  policy_id: string | null;
  policy_versi: string | null;
  policy_bunga_pasca_aktif: number | null;
  policy_rate_pasca_jatuh_tempo: number | null;
  policy_bunga_dikreditkan_ke: string | null;
  policy_pasca_mulai_efektif: string | null;
  policy_auto_renewal: number | null;
  status_policy: string | null;
  journal_pencairan_id: string | null;
}

/** Rate pasca jatuh tempo yang BERLAKU untuk kontrak ini (0 = tidak ada). */
function ratePascaKontrak(k: KontrakRow): number {
  if (k.policy_id == null || k.policy_bunga_pasca_aktif !== 1) return 0;
  return k.policy_rate_pasca_jatuh_tempo ?? 0;
}

/**
 * Kontrak yang bunganya — menurut snapshot kebijakan — WAJIB berakhir di
 * Simpanan Sukarela, sehingga pencairan hanya membayar pokok. Kontrak
 * legacy (tanpa snapshot) mempertahankan perilaku pencairan lamanya.
 */
function bungaKeSukarelaMenurutKebijakan(k: KontrakRow): boolean {
  return k.policy_id != null && k.policy_bunga_dikreditkan_ke === 'SIMPANAN_SUKARELA';
}

interface PeriodeAkrual {
  nomorPeriode: number;
  tanggalAkhirPeriode: string;
  bunga: Rupiah;
  jenis: 'KONTRAK' | 'PASCA_JATUH_TEMPO';
  ratePersen: number;
  urutanPasca?: number;
}

/**
 * SELURUH periode yang sudah earned sampai `sampaiTanggal`: periode
 * kontrak (mesin lama, tidak diubah) lalu periode pasca jatuh tempo
 * (bila kebijakan kontrak mengaktifkannya). Satu-satunya penyusun daftar
 * periode untuk akrual — tidak ada salinan algoritma tanggal di sini.
 */
function periodeEarnedKontrak(k: KontrakRow, sampaiTanggal: string): PeriodeAkrual[] {
  const hasil: PeriodeAkrual[] = [];
  if (k.suku_bunga > 0) {
    const jadwal = buatJadwalBungaSimpananBerjangka(k.nominal, k.suku_bunga, k.tenor_bulan as TenorSimpananBerjangka, k.tanggal_mulai);
    for (const p of periodeYangSudahEarned(jadwal, sampaiTanggal)) {
      hasil.push({ nomorPeriode: p.nomorPeriode, tanggalAkhirPeriode: p.tanggalAkhirPeriode, bunga: p.bunga, jenis: 'KONTRAK', ratePersen: k.suku_bunga });
    }
  }
  const ratePasca = ratePascaKontrak(k);
  if (ratePasca > 0) {
    for (const p of periodePascaJatuhTempoEarned({
      pokok: k.nominal,
      tenorBulan: k.tenor_bulan as TenorSimpananBerjangka,
      tanggalMulai: k.tanggal_mulai,
      ratePascaPerTahun: ratePasca,
      sampaiTanggal,
      mulaiEfektif: k.policy_pasca_mulai_efektif,
    })) {
      hasil.push({
        nomorPeriode: p.nomorPeriode,
        tanggalAkhirPeriode: p.tanggalAkhirPeriode,
        bunga: p.bunga,
        jenis: 'PASCA_JATUH_TEMPO',
        ratePersen: p.ratePersen,
        urutanPasca: p.urutanPasca,
      });
    }
  }
  return hasil;
}

async function ambilKontrak(db: SQLite.SQLiteDatabase, id: string): Promise<KontrakRow> {
  const row = await db.getFirstAsync<KontrakRow>(`SELECT * FROM simpanan_berjangka WHERE id = ?`, id);
  if (!row) throw new Error('Kontrak simpanan berjangka tidak ditemukan.');
  return row;
}

// ============================================================
// AKRUAL BUNGA
// ============================================================

export interface HasilAkrualBunga {
  kontrakId: string;
  nomorTransaksi: string;
  /** Periode yang BARU diakui pada pemanggilan ini (bisa kosong). */
  periodeDiakui: { nomorPeriode: number; tanggal: string; bunga: Rupiah; journalId: string }[];
  totalBungaDiakuiSekarang: Rupiah;
  totalBungaTerakruKumulatif: Rupiah;
}

/**
 * Akrual bunga untuk SATU kontrak sampai `sampaiTanggal`.
 *
 * Hanya periode yang tanggal akhirnya SUDAH lewat (earned) yang
 * dijurnal — akrual tidak pernah mendahului waktu. Periode yang sudah
 * pernah diakui dilewati berdasarkan tabel event
 * `simpanan_berjangka_bunga`, bukan berdasarkan tebakan tanggal.
 *
 * IDEMPOTEN secara struktural: UNIQUE(simpanan_berjangka_id,
 * nomor_periode) membuat akrual ganda mustahil bahkan bila dua proses
 * berjalan bersamaan.
 */
export async function prosesAkrualBungaKontrak(
  kontrakId: string,
  sampaiTanggal: string,
  createdBy: string
): Promise<HasilAkrualBunga> {
  return withTransaction(async (db) => {
    await requirePermission(db, createdBy, 'simpanan', 'create');
    return prosesAkrualBungaKontrakPadaDb(db, kontrakId, sampaiTanggal, createdBy);
  });
}

/**
 * Versi yang berjalan DI DALAM transaksi pemanggil. Dipakai oleh
 * pencairan supaya "selesaikan akrual lalu bayar" benar-benar atomik —
 * mustahil ada jurnal akrual yang commit sementara pencairannya gagal.
 */
export async function prosesAkrualBungaKontrakPadaDb(
  db: SQLite.SQLiteDatabase,
  kontrakId: string,
  sampaiTanggal: string,
  createdBy: string
): Promise<HasilAkrualBunga> {
  const kontrak = await ambilKontrak(db, kontrakId);

  const hasil: HasilAkrualBunga = {
    kontrakId,
    nomorTransaksi: kontrak.nomor_transaksi,
    periodeDiakui: [],
    totalBungaDiakuiSekarang: 0,
    totalBungaTerakruKumulatif: kontrak.bunga_terakru,
  };

  // Kontrak yang sudah selesai tidak pernah diakru lagi.
  if (kontrak.status === 'DICAIRKAN' || kontrak.status === 'DIBATALKAN') return hasil;
  // Rate kontrak 0 DAN tanpa bunga pasca jatuh tempo -> tidak ada jurnal.
  if (kontrak.suku_bunga <= 0 && ratePascaKontrak(kontrak) <= 0) return hasil;

  const earned = periodeEarnedKontrak(kontrak, sampaiTanggal);

  const sudahAda = await db.getAllAsync<{ nomor_periode: number }>(
    `SELECT nomor_periode FROM simpanan_berjangka_bunga WHERE simpanan_berjangka_id = ?`,
    kontrakId
  );
  const sudahDiakui = new Set(sudahAda.map((r) => r.nomor_periode));

  const bebanAccountId = await resolveAccountId(db, TRANSAKSI_BUNGA_AKRUAL, 'DEBIT_BEBAN');
  const utangBungaAccountId = await resolveAccountId(db, TRANSAKSI_BUNGA_AKRUAL, 'KREDIT_UTANG_BUNGA');

  for (const periode of earned) {
    if (sudahDiakui.has(periode.nomorPeriode)) continue;
    if (periode.bunga <= 0) continue;

    const tahun = parseInt(periode.tanggalAkhirPeriode.slice(0, 4), 10);
    const nomor = await nextSequence(db, 'SPB-BUNGA', tahun);

    // Tanggal jurnal = tanggal akhir periode (saat bunga benar-benar
    // earned), BUKAN tanggal hari ini. Kalau periode itu sudah ditutup,
    // `createJournal` akan menolak — dan itu memang perilaku yang
    // benar: akrual tidak boleh digeser diam-diam ke periode terbuka.
    const { journalId } = await createJournal(db, {
      tanggal: periode.tanggalAkhirPeriode,
      sumberTransaksi: TRANSAKSI_BUNGA_AKRUAL,
      nomorReferensi: nomor,
      deskripsi:
        periode.jenis === 'KONTRAK'
          ? `Akrual bunga simpanan berjangka ${kontrak.nomor_transaksi} periode ${periode.nomorPeriode}/${kontrak.tenor_bulan}`
          : `Akrual bunga pasca jatuh tempo simpanan berjangka ${kontrak.nomor_transaksi} ` +
            `bulan ke-${periode.urutanPasca} (${periode.ratePersen}%/th, kebijakan ${kontrak.policy_versi ?? '-'})`,
      createdBy,
      lines: [
        { accountId: bebanAccountId, debit: periode.bunga, kredit: 0 },
        { accountId: utangBungaAccountId, debit: 0, kredit: periode.bunga },
      ],
    });

    await db.runAsync(
      `INSERT INTO simpanan_berjangka_bunga
        (id, simpanan_berjangka_id, nomor_periode, tanggal_akhir_periode, bunga, journal_id, created_by, created_at,
         jenis_periode, rate_persen)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(),
      kontrakId,
      periode.nomorPeriode,
      periode.tanggalAkhirPeriode,
      periode.bunga,
      journalId,
      createdBy,
      new Date().toISOString(),
      periode.jenis,
      periode.ratePersen
    );

    hasil.periodeDiakui.push({
      nomorPeriode: periode.nomorPeriode,
      tanggal: periode.tanggalAkhirPeriode,
      bunga: periode.bunga,
      journalId,
    });
    hasil.totalBungaDiakuiSekarang += periode.bunga;
  }

  if (hasil.totalBungaDiakuiSekarang > 0) {
    // Kolom turunan disinkronkan dari SUM tabel event (bukan `+=`),
    // sehingga tidak mungkin melenceng dari sumber otoritatifnya.
    const total = await db.getFirstAsync<{ t: number }>(
      `SELECT COALESCE(SUM(bunga),0) t FROM simpanan_berjangka_bunga WHERE simpanan_berjangka_id = ?`,
      kontrakId
    );
    await db.runAsync(
      `UPDATE simpanan_berjangka SET bunga_terakru = ?, updated_at = ? WHERE id = ?`,
      total?.t ?? 0,
      new Date().toISOString(),
      kontrakId
    );
    hasil.totalBungaTerakruKumulatif = total?.t ?? 0;
  }

  return hasil;
}

/**
 * Akrual untuk SELURUH kontrak yang memenuhi syarat.
 *
 * Hanya kontrak AKTIF/JATUH_TEMPO dengan rate > 0 yang diproses.
 * DICAIRKAN & DIBATALKAN dilewati. JATUH_TEMPO tetap ikut karena
 * periode terakhirnya mungkin belum sempat diakru.
 *
 * Tiap kontrak diproses dalam TRANSAKSINYA SENDIRI: satu kontrak yang
 * jatuh di periode tertutup tidak boleh menggagalkan akrual kontrak
 * lain. Kegagalannya dilaporkan, bukan ditelan.
 */
export async function prosesAkrualBungaSemuaKontrak(
  sampaiTanggal: string,
  createdBy: string
): Promise<{ diproses: HasilAkrualBunga[]; gagal: { kontrakId: string; alasan: string }[] }> {
  const db = await getDb();
  const kandidat = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM simpanan_berjangka
     WHERE status IN ('AKTIF','JATUH_TEMPO')
       AND (suku_bunga > 0 OR (policy_bunga_pasca_aktif = 1 AND policy_rate_pasca_jatuh_tempo > 0))
     ORDER BY tanggal_mulai ASC`
  );

  const diproses: HasilAkrualBunga[] = [];
  const gagal: { kontrakId: string; alasan: string }[] = [];

  for (const k of kandidat) {
    try {
      const hasil = await prosesAkrualBungaKontrak(k.id, sampaiTanggal, createdBy);
      if (hasil.periodeDiakui.length > 0) diproses.push(hasil);
    } catch (e) {
      gagal.push({ kontrakId: k.id, alasan: e instanceof Error ? e.message : 'Kesalahan tidak diketahui.' });
    }
  }

  return { diproses, gagal };
}

// ============================================================
// JATUH TEMPO OTOMATIS
// ============================================================

/**
 * Transisi AKTIF -> JATUH_TEMPO untuk kontrak yang tanggal jatuh
 * temponya sudah tiba.
 *
 * PERUBAHAN STATUS SAJA — TIDAK ADA JURNAL. Jatuh tempo bukan peristiwa
 * ekonomi: tidak ada kas yang bergerak dan tidak ada kewajiban baru
 * yang timbul (kewajiban bunga sudah diakui lewat akrual). Membuat
 * jurnal di sini akan menggandakan pengakuan.
 *
 * JATUH TEMPO BUKAN PENCAIRAN OTOMATIS. Kas hanya keluar lewat aksi
 * pengguna di Pengeluaran > Tarik Simpanan Anggota.
 *
 * Akrual periode terakhir diselesaikan lebih dulu bila memungkinkan,
 * supaya kontrak yang berstatus JATUH_TEMPO benar-benar sudah lengkap
 * bunganya sebelum bisa dibayar.
 */
export async function prosesJatuhTempoSimpananBerjangka(
  tanggalHariIni: string,
  createdBy: string
): Promise<{ jatuhTempo: string[]; gagalAkrual: { kontrakId: string; alasan: string }[] }> {
  const db = await getDb();
  const kandidat = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM simpanan_berjangka WHERE status = 'AKTIF' AND tanggal_jatuh_tempo <= ?`,
    tanggalHariIni
  );

  const jatuhTempo: string[] = [];
  const gagalAkrual: { kontrakId: string; alasan: string }[] = [];

  for (const k of kandidat) {
    try {
      await prosesAkrualBungaKontrak(k.id, tanggalHariIni, createdBy);
    } catch (e) {
      // Akrual gagal (mis. periode tertutup) TIDAK menghalangi transisi
      // status — status adalah fakta kalender, bukan hasil akuntansi.
      // Kekurangan bunganya akan ditangkap saat pencairan, yang menolak
      // membayar kalau akrual belum lengkap.
      gagalAkrual.push({ kontrakId: k.id, alasan: e instanceof Error ? e.message : 'Kesalahan.' });
    }
    await withTransaction(async (tx) => {
      await tx.runAsync(
        `UPDATE simpanan_berjangka SET status = 'JATUH_TEMPO', updated_at = ?
         WHERE id = ? AND status = 'AKTIF'`,
        new Date().toISOString(),
        k.id
      );
    });
    jatuhTempo.push(k.id);
  }

  return { jatuhTempo, gagalAkrual };
}

// ============================================================
// PENCAIRAN
// ============================================================

export interface RingkasanPencairan {
  kontrakId: string;
  nomorTransaksi: string;
  pokok: Rupiah;
  bungaTerakru: Rupiah;
  totalBungaKontrak: Rupiah;
  totalPencairan: Rupiah;
  status: StatusSimpananBerjangka;
  tanggalMulai: string;
  tanggalJatuhTempo: string;
  /** null = boleh dicairkan; berisi alasan bila tidak boleh. */
  alasanTidakBolehCair: string | null;
  /**
   * Catatan KEBIJAKAN tambahan untuk kontrak yang belum jatuh tempo.
   *
   * Field TERPISAH dari `alasanTidakBolehCair` dengan sengaja: pesan
   * alasan sudah menjadi kontrak perilaku yang diuji dan dipakai UI,
   * jadi tidak diubah. Yang ditambahkan hanyalah penjelasan MENGAPA
   * penarikan dini belum tersedia — konsekuensi langsung dari
   * `KEBIJAKAN_PENARIKAN_DINI_TERSEDIA = false`. Begitu pengurus
   * menetapkan kebijakan, satu konstanta itu yang berubah.
   *
   * null bila tidak relevan (kontrak jatuh tempo / sudah dicairkan).
   */
  catatanKebijakanPenarikanDini: string | null;
  // ---- RC-S128 (aditif) ----
  /** true = yang dicairkan dari rekening berjangka HANYA pokok; bunga ke Simpanan Sukarela. */
  pencairanPokokSaja?: boolean;
  /** Bruto bunga yang sudah berada di Simpanan Sukarela. */
  bungaSudahDiSukarela?: Rupiah;
  /** Bunga yang sudah diakui tetapi belum dipindahkan (akan dipindahkan saat pencairan). */
  bungaBelumDipindahkan?: Rupiah;
  /** PPh 4(2) yang sudah dipotong atas bunga kontrak ini. */
  pphSudahDipotong?: Rupiah;
  tanggalPerhitunganTerakhir?: string | null;
  bungaPascaJatuhTempo?: Rupiah;
}

export const PESAN_BELUM_JATUH_TEMPO = 'Simpanan berjangka belum jatuh tempo.';



/**
 * Ringkasan untuk layar pencairan. Membaca saja — tidak mengubah apa pun.
 */
export async function getRingkasanPencairan(kontrakId: string, hariIni?: string): Promise<RingkasanPencairan> {
  const db = await getDb();
  const k = await ambilKontrak(db, kontrakId);
  const rincian = await getRincianBungaKontrakPadaDb(db, kontrakId, hariIni ?? k.tanggal_jatuh_tempo);
  const totalKontrak = hitungTotalBungaKontrak(
    k.nominal,
    k.suku_bunga,
    k.tenor_bulan as TenorSimpananBerjangka
  );

  let alasan: string | null = null;
  if (k.status === 'DICAIRKAN') alasan = 'Simpanan berjangka ini sudah dicairkan.';
  else if (k.status === 'DIBATALKAN') alasan = 'Simpanan berjangka ini sudah dibatalkan.';
  else if (k.status === 'AKTIF') alasan = PESAN_BELUM_JATUH_TEMPO;

  return {
    kontrakId: k.id,
    nomorTransaksi: k.nomor_transaksi,
    pokok: k.nominal,
    bungaTerakru: k.bunga_terakru,
    totalBungaKontrak: totalKontrak,
    // RC-S128 — perkiraan uang TUNAI: bunga yang sudah ada di Simpanan
    // Sukarela TIDAK dibayar lagi. Kontrak berkebijakan: pokok saja.
    // Legacy: pokok + bunga yang belum dipindahkan (bruto, sebelum PPh).
    totalPencairan: rincian.pencairanPokokSaja ? k.nominal : k.nominal + rincian.bungaBelumDipindahkan,
    pencairanPokokSaja: rincian.pencairanPokokSaja,
    bungaSudahDiSukarela: rincian.bungaSudahKeSukarela,
    bungaBelumDipindahkan: rincian.bungaBelumDipindahkan,
    pphSudahDipotong: rincian.totalPph,
    tanggalPerhitunganTerakhir: rincian.tanggalPerhitunganTerakhir,
    bungaPascaJatuhTempo: rincian.bungaPascaJatuhTempo,
    status: k.status,
    tanggalMulai: k.tanggal_mulai,
    tanggalJatuhTempo: k.tanggal_jatuh_tempo,
    alasanTidakBolehCair: alasan,
    catatanKebijakanPenarikanDini:
      k.status === 'AKTIF' && !KEBIJAKAN_PENARIKAN_DINI_TERSEDIA
        ? PESAN_PENARIKAN_DINI_TANPA_KEBIJAKAN
        : null,
  };
}

export interface CairkanInput {
  kontrakId: string;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  idempotencyKey?: string;
  createdBy: string;
}

/**
 * Pencairan simpanan berjangka yang telah jatuh tempo.
 *
 *   Dr 2-1210 Simpanan Anggota (Berjangka)   pokok
 *   Dr 2-1710 Utang Bunga Simpanan Berjangka bunga terutang
 *   Cr Kas / Bank                            pokok + bunga
 *
 * TIDAK ADA beban bunga kedua — lihat catatan di kepala file.
 *
 * Seluruh langkah (validasi, penyelesaian akrual, jurnal, update
 * subledger, transisi status) berada dalam SATU transaksi. Mustahil
 * terjadi "jurnal ada tapi status masih JATUH_TEMPO" atau sebaliknya.
 */
export async function cairkanSimpananBerjangka(input: CairkanInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'simpanan', 'create');

    if (input.idempotencyKey) {
      const sudah = await db.getFirstAsync<{ id: string; journal_pencairan_id: string | null }>(
        `SELECT id, journal_pencairan_id FROM simpanan_berjangka WHERE idempotency_key_pencairan = ?`,
        input.idempotencyKey
      );
      if (sudah) {
        return {
          kontrakId: sudah.id,
          journalId: sudah.journal_pencairan_id,
          duplikat: true as const,
          pokok: 0,
          bunga: 0,
          total: 0,
          pajakDipotong: 0,
          totalDibayarBersih: 0,
          bungaDipindahkanSaatPencairan: 0,
          totalBungaDiSukarela: 0,
        };
      }
    }

    const k = await ambilKontrak(db, input.kontrakId);

    if (k.status === 'DICAIRKAN') throw new Error('Simpanan berjangka ini sudah dicairkan.');
    if (k.status === 'DIBATALKAN') throw new Error('Simpanan berjangka ini sudah dibatalkan.');
    if (k.status !== 'JATUH_TEMPO') throw new Error(PESAN_BELUM_JATUH_TEMPO);
    if (input.tanggal < k.tanggal_jatuh_tempo) throw new Error(PESAN_BELUM_JATUH_TEMPO);

    // Selesaikan akrual yang tertinggal DI DALAM transaksi yang sama —
    // bunga harus lengkap sebelum dibayar, dan tidak boleh ada jurnal
    // akrual yang commit kalau pencairannya gagal.
    await prosesAkrualBungaKontrakPadaDb(db, k.id, input.tanggal, input.createdBy);
    const kSegar = await ambilKontrak(db, k.id);

    // RC-S128 — pencairan tidak boleh bertanggal SEBELUM periode bunga yang
    // sudah diakui (mis. bunga pasca jatuh tempo bulan lalu sudah
    // dibukukan oleh catch-up). Mundur ke belakang periode itu berarti
    // membayar bunga yang secara tanggal belum menjadi hak anggota.
    const periodeTerakhir = await db.getFirstAsync<{ t: string | null }>(
      `SELECT MAX(tanggal_akhir_periode) AS t FROM simpanan_berjangka_bunga WHERE simpanan_berjangka_id = ?`,
      kSegar.id
    );
    if (periodeTerakhir?.t && periodeTerakhir.t > input.tanggal) {
      throw new Error(
        `Tanggal pencairan (${input.tanggal}) tidak boleh sebelum akhir periode bunga yang sudah diakui (${periodeTerakhir.t}).`
      );
    }

    const totalKontrak = hitungTotalBungaKontrak(
      kSegar.nominal,
      kSegar.suku_bunga,
      kSegar.tenor_bulan as TenorSimpananBerjangka
    );
    // INVARIAN: pada pencairan, bunga KONTRAK yang diakui harus SAMA
    // dengan bunga kontraktual. Kalau tidak, ada periode yang belum bisa
    // diakru (mis. periodenya tertutup) — lebih baik menolak daripada
    // membayar angka yang tidak dapat direkonsiliasi. (RC-S128: bunga
    // pasca jatuh tempo tidak termasuk perbandingan ini.)
    const bungaKontrakDiakui = await db.getFirstAsync<{ t: number }>(
      `SELECT COALESCE(SUM(bunga),0) AS t FROM simpanan_berjangka_bunga
        WHERE simpanan_berjangka_id = ? AND jenis_periode = 'KONTRAK'`,
      kSegar.id
    );
    if ((bungaKontrakDiakui?.t ?? 0) !== totalKontrak) {
      throw new Error(
        `Bunga simpanan berjangka belum lengkap diakui (terakru ${bungaKontrakDiakui?.t ?? 0} dari ${totalKontrak}). ` +
          'Selesaikan akrual bunga terlebih dahulu sebelum pencairan.'
      );
    }

    // RC-S128 — POKOK -> ANGGOTA, BUNGA -> SIMPANAN SUKARELA.
    // Untuk kontrak dengan snapshot kebijakan, SELURUH periode yang sudah
    // earned dipindahkan lebih dulu lewat mekanisme §B yang SAMA (jurnal
    // Dr 2-1710 / Cr 2-1200, PPh agregat, bukti potong) — di transaksi
    // yang sama. Sisa bunga untuk pembayaran tunai di bawah lalu menjadi 0
    // dengan sendirinya; kode pembayaran tunai tetap ada untuk kontrak
    // legacy dan untuk periode yang secara sah belum dapat dipindahkan.
    let bungaDipindahkanSaatPencairan = 0;
    if (bungaKeSukarelaMenurutKebijakan(kSegar)) {
      const t = await prosesTransferBungaKeSukarelaPadaDb(db, kSegar.id, input.tanggal, input.createdBy);
      bungaDipindahkanSaatPencairan = t.totalDipindahkanSekarang;
    }

    /**
     * §B — BUNGA YANG SUDAH DIPINDAHKAN TIDAK DIBAYAR LAGI.
     *
     * Sebelum §B, pencairan selalu membayar SELURUH `bunga_terakru` dan
     * men-debit 2-1710 sebesar itu. Begitu sebagian bunga sudah
     * berpindah ke Simpanan Sukarela — yang JUGA men-debit 2-1710 —
     * angka itu menjadi salah dua kali sekaligus:
     *
     *   1. 2-1710 didebit melebihi yang pernah dikreditkan, sehingga
     *      saldo kewajiban menjadi NEGATIF;
     *   2. anggota menerima bunga yang sama dua kali — sekali masuk
     *      Simpanan Sukarela, sekali lagi tunai saat pencairan.
     *
     * Yang dibayar tunai karena itu adalah SISA-nya saja. Bunga yang
     * sudah dipindahkan tetap menjadi hak anggota; ia hanya sudah
     * berada di tempat lain.
     */
    const bungaSudahDitransfer = await getTotalBungaDitransferPadaDb(db, kSegar.id);
    const pokok = kSegar.nominal;
    const bunga = kSegar.bunga_terakru - bungaSudahDitransfer;
    if (bunga < 0) {
      // Tidak mungkin terjadi lewat jalur normal; kalau terjadi, ada
      // jurnal transfer yang melebihi akrualnya. Menolak lebih baik
      // daripada membayar angka yang tidak dapat direkonsiliasi.
      throw new Error(
        `Bunga yang sudah dipindahkan ke Simpanan Sukarela (${bungaSudahDitransfer}) ` +
          `melebihi bunga terakru (${kSegar.bunga_terakru}) pada kontrak ${kSegar.nomor_transaksi}.`
      );
    }
    const totalGross = pokok + bunga;

    // RC-S86 — PPh 4(2): periode yang BELUM PERNAH dibayar/dikreditkan
    // (belum ditransfer §B) baru SEKARANG menjadi hak anggota — inilah
    // titik potongnya. Periode yang SUDAH ditransfer TIDAK muncul di
    // `periodeBelumDibayar` (dikecualikan oleh `sudahDitransfer`), jadi
    // sudah pernah dipotong lewat §B TIDAK dipotong lagi di sini —
    // mustahil dobel karena satu periode hanya bisa "belum" sekali.
    // Dihitung PER BULAN MASA BUNGA MASING-MASING periode, bukan digabung
    // dulu baru dikalikan tarif (lihat pajakPolicy.hitungPphBungaSimpananPeriode).
    const periodeBelumDibayar = (await getStatusTransferBungaPadaDb(db, kSegar.id, input.tanggal)).filter(
      (p) => !p.sudahDitransfer && p.bunga > 0
    );
    // RC-S127 — agregat per anggota per bulan, lintas produk (sukarela dll.).
    const pajakP = await hitungPphBungaSimpananPeriodeAgregatPadaDb(
      db,
      kSegar.anggota_id,
      periodeBelumDibayar.map((p) => ({
        bungaPeriodeId: p.bungaId,
        nomorPeriode: p.nomorPeriode,
        tanggalAkhirPeriode: p.tanggalAkhirPeriode,
        bruto: p.bunga,
      }))
    );
    const totalPajak = pajakP.totalPajak;
    const totalDibayarBersih = totalGross - totalPajak;

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const pokokAccountId = await resolveAccountId(db, TRANSAKSI_PENCAIRAN, 'DEBIT_POKOK');

    const lines = [{ accountId: pokokAccountId, debit: pokok, kredit: 0 }];
    if (bunga > 0) {
      const utangBungaAccountId = await resolveAccountId(db, TRANSAKSI_PENCAIRAN, 'DEBIT_UTANG_BUNGA');
      lines.push({ accountId: utangBungaAccountId, debit: bunga, kredit: 0 });
    }
    if (totalPajak !== 0) {
      // RC-S127 — negatif = pengembalian potongan bulan yang sama (jarang).
      const utangPphId = await idAkunUtangPphBungaSimpanan(db);
      lines.push(totalPajak > 0 ? { accountId: utangPphId, debit: 0, kredit: totalPajak } : { accountId: utangPphId, debit: -totalPajak, kredit: 0 });
    }
    lines.push({ accountId: kasBankAccountId, debit: 0, kredit: totalDibayarBersih });

    const tahun = parseInt(input.tanggal.slice(0, 4), 10);
    const nomor = await nextSequence(db, 'SPB-CAIR', tahun);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: TRANSAKSI_PENCAIRAN,
      nomorReferensi: nomor,
      deskripsi:
        `Pencairan simpanan berjangka ${kSegar.nomor_transaksi} - ${nomor}` +
        (totalPajak > 0 ? ` · PPh Ps.4(2) dipotong Rp${totalPajak.toLocaleString('id-ID')}` : ''),
      createdBy: input.createdBy,
      lines,
    });

    // RC-S86 — bukti potong per periode yang diselesaikan pencairan ini,
    // WAJIB termasuk yang pajaknya Rp0. Tidak ada apa pun bila seluruh
    // bunga sudah pernah ditransfer §B (periodeBelumDibayar kosong).
    await catatBuktiPotongBungaSimpananPadaDb(db, {
      simpananBerjangkaId: kSegar.id,
      anggotaId: kSegar.anggota_id,
      journalId,
      peristiwa: 'PENCAIRAN',
      tanggal: input.tanggal,
      createdBy: input.createdBy,
      hasil: pajakP,
    });

    await db.runAsync(
      `UPDATE simpanan_berjangka
         SET status = 'DICAIRKAN', bunga_dibayar = ?, tanggal_pencairan = ?,
             journal_pencairan_id = ?, idempotency_key_pencairan = ?, updated_at = ?
       WHERE id = ?`,
      // Seluruh bunga kontrak sudah TERSELESAIKAN: sebagian lewat
      // pemindahan ke Simpanan Sukarela, sisanya tunai di sini. Kolom
      // ini dipakai `getTotalUtangBungaBerjangkaPadaDb()` sebagai
      // pengurang kewajiban, jadi ia harus mencerminkan KESELURUHAN
      // yang tidak lagi terutang — bukan hanya bagian tunainya.
      kSegar.bunga_terakru,
      input.tanggal,
      journalId,
      input.idempotencyKey ?? null,
      new Date().toISOString(),
      kSegar.id
    );

    return {
      kontrakId: kSegar.id,
      journalId,
      duplikat: false as const,
      pokok,
      bunga,
      // `total` TETAP nilai BRUTO (pokok+bunga) — semantik existing tidak
      // diubah. Kas/Bank yang sungguhan keluar ada di `totalDibayarBersih`.
      total: totalGross,
      pajakDipotong: totalPajak,
      totalDibayarBersih,
      /** RC-S128 — bruto bunga yang dipindahkan ke Simpanan Sukarela PADA pencairan ini. */
      bungaDipindahkanSaatPencairan,
      /** RC-S128 — seluruh bruto bunga kontrak yang sudah berada di Simpanan Sukarela. */
      totalBungaDiSukarela: bungaSudahDitransfer,
    };
  });
}

// ===========================================================================
// §B — PEMINDAHAN BUNGA TERAKRU KE SIMPANAN SUKARELA
// ===========================================================================
//
// MASALAH YANG DIPECAHKAN. Bunga simpanan berjangka diakui sebagai
// kewajiban koperasi saat akrual (Dr Beban Bunga / Cr 2-1710), tetapi
// tidak pernah sampai ke anggota sampai kontrak cair. Permintaan
// koperasi: begitu satu periode bunga selesai, bunga itu dipindahkan ke
// Simpanan Sukarela anggota sehingga dapat dipakai.
//
// JURNALNYA HANYA MEMINDAHKAN KEWAJIBAN:
//
//     Dr 2-1710 Utang Bunga Simpanan Berjangka
//     Cr 2-1200 Simpanan Sukarela Anggota
//
// TIDAK ADA beban baru. Beban sudah diakui di fase akrual; membentuk
// beban kedua di sini akan menghitung bunga yang sama dua kali.
//
// KENAPA TANPA TABEL/KOLOM BARU. Tiga hal yang dibutuhkan §B sudah
// tersedia di skema:
//   1. periode bunga  -> `simpanan_berjangka_bunga` dengan UNIQUE
//      (simpanan_berjangka_id, nomor_periode);
//   2. bukti posting  -> `journal.sumber_transaksi` + `journal.sumber_id`;
//   3. kunci unik     -> `simpanan_transaksi.idempotency_key` dengan
//      UNIQUE partial index `idx_simpanan_idempotency`.
// Menambah kolom status hanya akan menduplikasi fakta yang sudah dapat
// dibaca dari jurnal — dan salinan kedua adalah tempat baru untuk tidak
// sinkron.

/**
 * RC-S133.4.6 — PENANDA KONTRAK HASIL MIGRASI SALDO AWAL (Import Data Awal,
 * pilihan "Saldo lama"). Kunci `app_config` per kontrak, nilainya tanggal
 * cut-off. Periode bunga kontrak bertanda yang berakhir SEBELUM cut-off dan
 * tidak berjurnal sudah diakru & dipindahkan ke Simpanan Sukarela di
 * pembukuan lama. Tanpa kolom baru → SCHEMA_VERSION tetap.
 */
export const PREFIX_CONFIG_MIGRASI_BERJANGKA = 'simpanan_berjangka.migrasi_saldo_awal.';

/** Kunci idempotensi deterministik: satu kontrak, satu periode, satu transfer. */
export function kunciTransferBunga(kontrakId: string, nomorPeriode: number): string {
  return `SBT-${kontrakId}-${nomorPeriode}`;
}

export interface PeriodeTransferBunga {
  readonly bungaId: string;
  readonly nomorPeriode: number;
  readonly tanggalAkhirPeriode: string;
  readonly bunga: Rupiah;
  readonly sudahDitransfer: boolean;
  readonly journalTransferId: string | null;
  /** RC-S128 — KONTRAK atau PASCA_JATUH_TEMPO. */
  readonly jenisPeriode: 'KONTRAK' | 'PASCA_JATUH_TEMPO';
}

export interface HasilTransferBunga {
  readonly kontrakId: string;
  readonly nomorTransaksi: string;
  readonly periodeDipindahkan: readonly number[];
  readonly totalDipindahkanSekarang: Rupiah;
  readonly totalSudahDipindahkanKumulatif: Rupiah;
}

/**
 * Status per periode — SATU-SATUNYA sumber untuk layar detail anggota.
 *
 * Dibaca dari jurnal, bukan dari flag terpisah: jurnal adalah fakta yang
 * benar-benar mengubah buku, jadi tidak mungkin ia "sudah diposting"
 * menurut flag tetapi tidak ada di buku besar.
 */
export async function getStatusTransferBungaPadaDb(
  db: SQLite.SQLiteDatabase,
  kontrakId: string,
  sampaiTanggal?: string
): Promise<PeriodeTransferBunga[]> {
  const baris = await db.getAllAsync<{
    id: string;
    nomor_periode: number;
    tanggal_akhir_periode: string;
    bunga: number;
    jenis_periode: 'KONTRAK' | 'PASCA_JATUH_TEMPO' | null;
    journal_id: string | null;
  }>(
    `SELECT id, nomor_periode, tanggal_akhir_periode, bunga, jenis_periode, journal_id
       FROM simpanan_berjangka_bunga
      WHERE simpanan_berjangka_id = ?
      ORDER BY nomor_periode ASC`,
    kontrakId
  );

  const penanda = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM app_config WHERE key = ?`,
    `${PREFIX_CONFIG_MIGRASI_BERJANGKA}${kontrakId}`
  );
  const cutOffMigrasi = penanda?.value ?? null;
  const hasil: PeriodeTransferBunga[] = [];
  for (const b of baris) {
    if (sampaiTanggal !== undefined && b.tanggal_akhir_periode > sampaiTanggal) continue;
    const jurnal = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM journal
        WHERE sumber_transaksi = ? AND sumber_id = ? AND status NOT IN ('VOID','REVERSED')
        LIMIT 1`,
      TRANSAKSI_BUNGA_TRANSFER,
      b.id
    );
    hasil.push({
      bungaId: b.id,
      nomorPeriode: b.nomor_periode,
      tanggalAkhirPeriode: b.tanggal_akhir_periode,
      bunga: b.bunga,
      // RC-S133.4.6 — periode hasil MIGRASI SALDO AWAL (kontrak bertanda,
      // tanpa jurnal, berakhir sebelum cut-off) sudah diakru & dipindahkan
      // ke Simpanan Sukarela di pembukuan lama. Tanpa ini catch-up akan
      // memindahkan bunga yang sama untuk kedua kalinya.
      sudahDitransfer:
        jurnal !== null || (b.journal_id === null && cutOffMigrasi !== null && b.tanggal_akhir_periode < cutOffMigrasi),
      journalTransferId: jurnal?.id ?? null,
      jenisPeriode: b.jenis_periode ?? 'KONTRAK',
    });
  }
  return hasil;
}

export async function getStatusTransferBunga(
  kontrakId: string,
  sampaiTanggal?: string
): Promise<PeriodeTransferBunga[]> {
  const db = await getDb();
  return getStatusTransferBungaPadaDb(db, kontrakId, sampaiTanggal);
}

/** Total bunga kontrak ini yang SUDAH berpindah ke Simpanan Sukarela. */
export async function getTotalBungaDitransferPadaDb(
  db: SQLite.SQLiteDatabase,
  kontrakId: string
): Promise<Rupiah> {
  const periode = await getStatusTransferBungaPadaDb(db, kontrakId);
  return periode.filter((p) => p.sudahDitransfer).reduce((t, p) => t + p.bunga, 0);
}

/**
 * PROSES SATU KONTRAK — berjalan DI DALAM transaksi pemanggil.
 *
 * Urutannya menentukan kebenarannya:
 *   1. kontrak dibaca & divalidasi;
 *   2. periode yang sudah earned tapi belum dipindahkan dicari;
 *   3. untuk tiap periode: jurnal dibuat, LALU baris simpanan_transaksi
 *      ditulis dengan idempotency_key deterministik.
 *
 * Keduanya berada di SATU transaksi, jadi "jurnal ada tetapi subledger
 * tidak" mustahil: kegagalan di langkah mana pun menggulung semuanya.
 * Bila toh ada jurnal yang tertinggal dari versi lama atau dari proses
 * yang mati di tempat yang tidak terduga, langkah 2 tetap menemukannya
 * lewat `sumber_id` dan periode itu dilewati — bukan diposting ulang.
 */
export async function prosesTransferBungaKeSukarelaPadaDb(
  db: SQLite.SQLiteDatabase,
  kontrakId: string,
  sampaiTanggal: string,
  createdBy: string
): Promise<HasilTransferBunga> {
  const kontrak = await ambilKontrak(db, kontrakId);

  const sudahKumulatif = await getTotalBungaDitransferPadaDb(db, kontrakId);
  const hasil: HasilTransferBunga = {
    kontrakId,
    nomorTransaksi: kontrak.nomor_transaksi,
    periodeDipindahkan: [],
    totalDipindahkanSekarang: 0,
    totalSudahDipindahkanKumulatif: sudahKumulatif,
  };

  // Kontrak yang sudah selesai tidak memindahkan apa pun lagi: bunganya
  // sudah diselesaikan lewat pencairan.
  if (kontrak.status === 'DICAIRKAN' || kontrak.status === 'DIBATALKAN') return hasil;

  const periode = await getStatusTransferBungaPadaDb(db, kontrakId, sampaiTanggal);
  const belum = periode.filter((p) => !p.sudahDitransfer && p.bunga > 0);
  if (belum.length === 0) return hasil;

  const utangBungaAccountId = await resolveAccountId(db, TRANSAKSI_PENCAIRAN, 'DEBIT_UTANG_BUNGA');
  const sukarelaAccountId = await resolveAccountId(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT');

  const dipindahkan: number[] = [];
  let totalSekarang = 0;

  for (const p of belum) {
    const kunci = kunciTransferBunga(kontrakId, p.nomorPeriode);

    // Penjaga kedua: baris subledger dengan kunci ini mungkin sudah ada
    // walau jurnalnya tidak terdeteksi. UNIQUE index akan menolaknya,
    // jadi lebih baik diketahui di sini daripada meledak sebagai
    // constraint error yang menggulung seluruh batch.
    const adaSubledger = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM simpanan_transaksi WHERE idempotency_key = ? LIMIT 1`,
      kunci
    );
    if (adaSubledger) continue;

    const tahun = parseInt(p.tanggalAkhirPeriode.slice(0, 4), 10);
    const nomor = await nextSequence(db, 'SPB-TRF', tahun);

    // RC-S86 — PPh 4(2): bunga periode ini BARU SEKARANG menjadi hak
    // anggota (masuk Simpanan Sukarela), jadi INI titik potong yang
    // benar. Satu periode = satu jurnal = satu bulan masa.
    // RC-S127 — batas Rp240.000 diuji terhadap TOTAL bunga anggota pada
    // bulan masa ini dari seluruh produk (bukti potong yang sudah terbit).
    const pajakP = await hitungPphBungaSimpananPeriodeAgregatPadaDb(db, kontrak.anggota_id, [
      { bungaPeriodeId: p.bungaId, nomorPeriode: p.nomorPeriode, tanggalAkhirPeriode: p.tanggalAkhirPeriode, bruto: p.bunga },
    ]);
    const pajak = pajakP.totalPajak;
    const netto = pajakP.totalNetto;

    const lines = [{ accountId: utangBungaAccountId, debit: p.bunga, kredit: 0 }];
    if (pajak !== 0) {
      const utangPphId = await idAkunUtangPphBungaSimpanan(db);
      lines.push(pajak > 0 ? { accountId: utangPphId, debit: 0, kredit: pajak } : { accountId: utangPphId, debit: -pajak, kredit: 0 });
    }
    // RC-S127 — neto bisa NEGATIF bila periode ini membuat total bulan
    // melewati batas & memotong susulan atas bunga lain bulan itu: selisih
    // ditarik dari Simpanan Sukarela anggota. Neto nol: tanpa baris.
    if (netto > 0) lines.push({ accountId: sukarelaAccountId, debit: 0, kredit: netto });
    else if (netto < 0) lines.push({ accountId: sukarelaAccountId, debit: -netto, kredit: 0 });

    // Tanggal jurnal = tanggal akhir periode, sama seperti akrualnya.
    // Kalau periode itu sudah ditutup, `createJournal` menolak — dan itu
    // memang benar: pemindahan tidak boleh digeser diam-diam ke periode
    // terbuka, karena ia harus berpasangan dengan akrual di periode yang
    // sama agar 2-1710 dapat direkonsiliasi per periode.
    const { journalId } = await createJournal(db, {
      tanggal: p.tanggalAkhirPeriode,
      sumberTransaksi: TRANSAKSI_BUNGA_TRANSFER,
      sumberId: p.bungaId,
      nomorReferensi: nomor,
      deskripsi:
        `Pemindahan bunga ${p.jenisPeriode === 'PASCA_JATUH_TEMPO' ? 'pasca jatuh tempo ' : ''}simpanan berjangka ${kontrak.nomor_transaksi} ` +
        (p.jenisPeriode === 'PASCA_JATUH_TEMPO'
          ? `bulan ke-${p.nomorPeriode - kontrak.tenor_bulan} sesudah jatuh tempo ke Simpanan Sukarela`
          : `periode ${p.nomorPeriode}/${kontrak.tenor_bulan} ke Simpanan Sukarela`) +
        (pajak > 0 ? ` · PPh Ps.4(2) dipotong Rp${pajak.toLocaleString('id-ID')}` : ''),
      createdBy,
      lines,
    });

    // RC-S86 — bukti potong WAJIB, termasuk saat pajak = 0 (satu jurnal
    // pembayaran ini SELALU memindahkan tepat satu periode di jalur §B).
    await catatBuktiPotongBungaSimpananPadaDb(db, {
      simpananBerjangkaId: kontrakId,
      anggotaId: kontrak.anggota_id,
      journalId,
      peristiwa: 'TRANSFER_SUKARELA',
      tanggal: p.tanggalAkhirPeriode,
      createdBy,
      hasil: pajakP,
    });

    // Saldo Simpanan Sukarela dibaca dari `simpanan_transaksi`, bukan
    // dari akun buku besar. Tanpa baris ini saldo anggota TIDAK akan
    // bertambah walaupun jurnalnya benar — layar dan buku akan berbeda.
    // Nominal = NETTO (bunga bersih sesudah PPh 4(2)) — itulah yang
    // benar-benar menjadi saldo Sukarela anggota yang bisa dipakai.
    // Baris subledger TETAP ditulis walau neto 0 — kunci idempotensinya
    // dipakai penjaga `adaSubledger` di atas.
    const nomorSimpanan = await nextSequence(db, 'SMP', tahun);
    await db.runAsync(
      `INSERT INTO simpanan_transaksi
        (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi,
         keterangan, journal_id, idempotency_key, created_by, created_at)
       VALUES (?,?,'SUKARELA',?,?,?,'KAS',?,?,?,?,?,?)`,
      newId(),
      kontrak.anggota_id,
      netto < 0 ? 'TARIK' : 'SETOR',
      p.tanggalAkhirPeriode,
      Math.abs(netto),
      nomorSimpanan,
      `Bunga simpanan berjangka ${kontrak.nomor_transaksi} periode ${p.nomorPeriode}` +
        (pajak !== 0
          ? netto < 0
            ? ` (PPh 4(2) Rp${pajak.toLocaleString('id-ID')} termasuk susulan bunga lain bulan ini melebihi bunga periode ini)`
            : ` (netto sesudah PPh 4(2) Rp${pajak.toLocaleString('id-ID')})`
          : ''),
      journalId,
      kunci,
      createdBy,
      new Date().toISOString()
    );

    dipindahkan.push(p.nomorPeriode);
    totalSekarang += p.bunga;
  }

  return {
    kontrakId,
    nomorTransaksi: kontrak.nomor_transaksi,
    periodeDipindahkan: dipindahkan,
    totalDipindahkanSekarang: totalSekarang,
    totalSudahDipindahkanKumulatif: sudahKumulatif + totalSekarang,
  };
}

/** Bungkus transaksional untuk satu kontrak. */
export async function prosesTransferBungaKeSukarela(
  kontrakId: string,
  sampaiTanggal: string,
  createdBy: string
): Promise<HasilTransferBunga> {
  return withTransaction(async (db) => {
    await requirePermission(db, createdBy, 'simpanan', 'create');
    return prosesTransferBungaKeSukarelaPadaDb(db, kontrakId, sampaiTanggal, createdBy);
  });
}

/**
 * SATU-SATUNYA PINTU untuk seluruh pemanggil (§10).
 *
 * Startup, foreground, layar detail anggota, dan background task
 * memanggil fungsi INI. Tidak ada satu pun dari mereka yang boleh
 * menyusun jurnalnya sendiri: keputusan bisnis ada di sini, pemicunya
 * saja yang berbeda.
 *
 * CATCH-UP. Kontrak diproses per PERIODE, bukan "periode terakhir saja".
 * Aplikasi yang tidak dibuka selama tiga bulan akan memindahkan ketiga
 * periode yang tertinggal dalam satu panggilan, masing-masing dengan
 * jurnal bertanggal periodenya sendiri.
 *
 * Kegagalan satu kontrak TIDAK menggagalkan kontrak lain: tiap kontrak
 * berjalan di transaksinya sendiri. Kontrak yang gagal dilaporkan dan
 * akan dicoba lagi pada pemanggilan berikutnya.
 */
export async function processAccruedTermDepositInterestDue(
  sampaiTanggal: string,
  createdBy: string
): Promise<{
  readonly diproses: readonly HasilTransferBunga[];
  readonly gagal: readonly { kontrakId: string; alasan: string }[];
  readonly totalDipindahkan: Rupiah;
}> {
  const db = await getDb();
  const kandidat = await db.getAllAsync<{ id: string }>(
    `SELECT DISTINCT sb.id
       FROM simpanan_berjangka sb
       JOIN simpanan_berjangka_bunga b ON b.simpanan_berjangka_id = sb.id
      WHERE sb.status IN ('AKTIF','JATUH_TEMPO')
        AND b.tanggal_akhir_periode <= ?
      ORDER BY sb.id ASC`,
    sampaiTanggal
  );

  const diproses: HasilTransferBunga[] = [];
  const gagal: { kontrakId: string; alasan: string }[] = [];
  let total = 0;

  for (const k of kandidat) {
    try {
      const hasil = await prosesTransferBungaKeSukarela(k.id, sampaiTanggal, createdBy);
      if (hasil.totalDipindahkanSekarang > 0) {
        diproses.push(hasil);
        total += hasil.totalDipindahkanSekarang;
      }
    } catch (error) {
      gagal.push({
        kontrakId: k.id,
        alasan: error instanceof Error ? error.message : 'Kesalahan tidak dikenali.',
      });
    }
  }

  return { diproses, gagal, totalDipindahkan: total };
}

/**
 * Pembungkus non-transaksional untuk rekonsiliasi & test.
 *
 * Sengaja MEMANGGIL versi PadaDb, bukan menyalin kuerinya: dua salinan
 * kueri rekonsiliasi adalah dua tempat untuk memberi jawaban berbeda
 * tentang angka yang sama.
 */
export type StatusPeriodeBunga =
  /** Periode belum berakhir — belum ada hak bunga yang timbul. */
  | 'BELUM_JATUH_TEMPO'
  /** Periode sudah berakhir & sudah diakru, tetapi belum dipindahkan. */
  | 'SIAP_DIPINDAHKAN'
  /** Jurnal pemindahan ke Simpanan Sukarela sudah ada dan sah. */
  | 'SUDAH_DIPINDAHKAN';

export interface BarisStatusPeriodeBunga {
  readonly kontrakId: string;
  readonly nomorKontrak: string;
  readonly nomorPeriode: number;
  readonly tanggalAkhirPeriode: string;
  readonly bunga: Rupiah;
  readonly status: StatusPeriodeBunga;
  readonly journalTransferId: string | null;
  /** RC-S128 — KONTRAK atau PASCA_JATUH_TEMPO. */
  readonly jenisPeriode?: 'KONTRAK' | 'PASCA_JATUH_TEMPO';
}

/**
 * STATUS SELURUH PERIODE BUNGA MILIK SATU ANGGOTA (§B, layar detail).
 *
 * Menggabungkan DUA sumber yang keduanya sudah ada:
 *   - `buatJadwalBungaSimpananBerjangka()` — jadwal kontraktual, fungsi
 *     MURNI yang sama persis dipakai mesin akrual. Dari sinilah periode
 *     yang BELUM jatuh tempo dapat ditampilkan, karena periode seperti
 *     itu memang belum punya baris di `simpanan_berjangka_bunga`.
 *   - `getStatusTransferBungaPadaDb()` — fakta pemindahan, dibaca dari
 *     jurnal.
 *
 * Tidak ada aturan kelayakan yang ditulis ulang di sini: status
 * SUDAH_DIPINDAHKAN semata-mata berarti jurnalnya ada. Layar tidak
 * pernah menyimpulkan sendiri bahwa sesuatu "sudah diposting".
 */
export async function getStatusPeriodeBungaAnggota(
  anggotaId: string,
  sampaiTanggal: string
): Promise<BarisStatusPeriodeBunga[]> {
  const db = await getDb();
  const kontrak = await db.getAllAsync<{
    id: string;
    nomor_transaksi: string;
    nominal: number;
    suku_bunga: number;
    tenor_bulan: number;
    tanggal_mulai: string;
    policy_id: string | null;
    policy_bunga_pasca_aktif: number | null;
    policy_rate_pasca_jatuh_tempo: number | null;
    policy_pasca_mulai_efektif: string | null;
  }>(
    `SELECT id, nomor_transaksi, nominal, suku_bunga, tenor_bulan, tanggal_mulai,
            policy_id, policy_bunga_pasca_aktif, policy_rate_pasca_jatuh_tempo, policy_pasca_mulai_efektif
       FROM simpanan_berjangka
      WHERE anggota_id = ? AND status IN ('AKTIF','JATUH_TEMPO')
      ORDER BY tanggal_mulai ASC`,
    anggotaId
  );

  const hasil: BarisStatusPeriodeBunga[] = [];
  for (const k of kontrak) {
    const ratePasca = k.policy_id != null && k.policy_bunga_pasca_aktif === 1 ? k.policy_rate_pasca_jatuh_tempo ?? 0 : 0;
    if (k.suku_bunga <= 0 && ratePasca <= 0) continue;
    const jadwal =
      k.suku_bunga > 0
        ? buatJadwalBungaSimpananBerjangka(k.nominal, k.suku_bunga, k.tenor_bulan as TenorSimpananBerjangka, k.tanggal_mulai)
        : [];
    const transfer = await getStatusTransferBungaPadaDb(db, k.id);
    const perNomor = new Map(transfer.map((t) => [t.nomorPeriode, t]));

    // RC-S128 — periode pasca jatuh tempo: yang SUDAH diakui (baris
    // event) + satu periode berikutnya yang sedang berjalan.
    if (ratePasca > 0) {
      for (const t of transfer.filter((x) => x.jenisPeriode === 'PASCA_JATUH_TEMPO')) {
        hasil.push({
          kontrakId: k.id,
          nomorKontrak: k.nomor_transaksi,
          nomorPeriode: t.nomorPeriode,
          tanggalAkhirPeriode: t.tanggalAkhirPeriode,
          bunga: t.bunga,
          status: t.sudahDitransfer ? 'SUDAH_DIPINDAHKAN' : 'SIAP_DIPINDAHKAN',
          journalTransferId: t.journalTransferId,
          jenisPeriode: 'PASCA_JATUH_TEMPO',
        });
      }
      const berikut = periodePascaJatuhTempoBerikutnya({
        pokok: k.nominal,
        tenorBulan: k.tenor_bulan as TenorSimpananBerjangka,
        tanggalMulai: k.tanggal_mulai,
        ratePascaPerTahun: ratePasca,
        sampaiTanggal,
        mulaiEfektif: k.policy_pasca_mulai_efektif,
      });
      if (berikut && !perNomor.has(berikut.nomorPeriode)) {
        hasil.push({
          kontrakId: k.id,
          nomorKontrak: k.nomor_transaksi,
          nomorPeriode: berikut.nomorPeriode,
          tanggalAkhirPeriode: berikut.tanggalAkhirPeriode,
          bunga: berikut.bunga,
          status: 'BELUM_JATUH_TEMPO',
          journalTransferId: null,
          jenisPeriode: 'PASCA_JATUH_TEMPO',
        });
      }
    }

    for (const p of jadwal) {
      const t = perNomor.get(p.nomorPeriode);
      const status: StatusPeriodeBunga =
        t?.sudahDitransfer === true
          ? 'SUDAH_DIPINDAHKAN'
          : p.tanggalAkhirPeriode <= sampaiTanggal
            ? 'SIAP_DIPINDAHKAN'
            : 'BELUM_JATUH_TEMPO';
      hasil.push({
        kontrakId: k.id,
        nomorKontrak: k.nomor_transaksi,
        nomorPeriode: p.nomorPeriode,
        tanggalAkhirPeriode: p.tanggalAkhirPeriode,
        bunga: t?.bunga ?? p.bunga,
        status,
        journalTransferId: t?.journalTransferId ?? null,
        jenisPeriode: 'KONTRAK',
      });
    }
  }
  return hasil;
}

export async function getTotalUtangBungaBerjangka(): Promise<Rupiah> {
  const db = await getDb();
  return getTotalUtangBungaBerjangkaPadaDb(db);
}

/** Total utang bunga simpanan berjangka yang belum dibayar (rekonsiliasi). */
export async function getTotalUtangBungaBerjangkaPadaDb(
  db: SQLite.SQLiteDatabase
): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ t: number }>(
    `SELECT COALESCE(SUM(bunga_terakru - bunga_dibayar), 0) t
     FROM simpanan_berjangka WHERE status IN ('AKTIF','JATUH_TEMPO')`
  );
  // RC-S133.4.6 — bunga periode hasil migrasi saldo awal (kontrak bertanda, tanpa jurnal)
  // sudah dipindahkan ke Simpanan Sukarela di pembukuan lama: bukan utang
  // bunga. Tanpa pengurang ini angka rekonsiliasi lebih besar daripada
  // saldo 2-1710 sebesar bunga sebelum cut-off.
  const migrasi = await db.getFirstAsync<{ t: number }>(
    `SELECT COALESCE(SUM(b.bunga), 0) t
       FROM simpanan_berjangka_bunga b JOIN simpanan_berjangka sb ON sb.id = b.simpanan_berjangka_id
      WHERE b.journal_id IS NULL AND sb.status IN ('AKTIF','JATUH_TEMPO')
        AND b.tanggal_akhir_periode < (SELECT c.value FROM app_config c WHERE c.key = ? || sb.id)`,
    PREFIX_CONFIG_MIGRASI_BERJANGKA
  );
  const terakruBelumDibayar = (row?.t ?? 0) - (migrasi?.t ?? 0);

  /**
   * §B — bunga yang SUDAH dipindahkan ke Simpanan Sukarela bukan lagi
   * utang bunga; ia kini menjadi saldo simpanan anggota. Tanpa
   * pengurang ini, angka rekonsiliasi akan lebih besar daripada saldo
   * 2-1710 yang sebenarnya, tepat sebesar total yang sudah dipindahkan.
   */
  // RC-S128 — HANYA debit pada akun Utang Bunga (2-1710). Sejak PPh
  // agregat RC-S127, jurnal pemindahan bisa memuat debit lain (Simpanan
  // Sukarela saat neto negatif, atau Utang PPh saat pengembalian
  // potongan); menjumlah seluruh debit akan membuat angka ini meleset.
  // Tanpa mapping utang bunga mustahil ada jurnal pemindahan (§B wajib
  // memakai mapping itu), jadi pengurangnya memang nol.
  const adaTransfer = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = ? AND status NOT IN ('VOID','REVERSED')`,
    TRANSAKSI_BUNGA_TRANSFER
  );
  if (!adaTransfer || adaTransfer.n === 0) return terakruBelumDibayar;
  const akunUtangBunga = await resolveAccountId(db, TRANSAKSI_BUNGA_AKRUAL, 'KREDIT_UTANG_BUNGA');
  const transfer = await db.getFirstAsync<{ t: number }>(
    `SELECT COALESCE(SUM(je.debit), 0) t
       FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       JOIN simpanan_berjangka_bunga b ON b.id = j.sumber_id
       JOIN simpanan_berjangka sb ON sb.id = b.simpanan_berjangka_id
      WHERE j.sumber_transaksi = ?
        AND j.status NOT IN ('VOID','REVERSED')
        AND je.account_id = ?
        AND sb.status IN ('AKTIF','JATUH_TEMPO')`,
    TRANSAKSI_BUNGA_TRANSFER,
    akunUtangBunga
  );
  return terakruBelumDibayar - (transfer?.t ?? 0);
}

// ============================================================
// RC-S128 — RINCIAN BUNGA SATU KONTRAK (sumber tunggal layar & dokumen)
// ============================================================

export interface RincianBungaKontrak {
  kontrakId: string;
  nomorTransaksi: string;
  status: StatusSimpananBerjangka;
  pokok: Rupiah;
  /** Total bunga kontraktual seumur tenor (rencana). */
  totalBungaKontrak: Rupiah;
  /** Bunga periode kontrak yang sudah diakui (akrual). */
  bungaSelamaTenor: Rupiah;
  /** Bunga periode pasca jatuh tempo yang sudah diakui. */
  bungaPascaJatuhTempo: Rupiah;
  jumlahPeriodePasca: number;
  /** Bruto bunga yang sudah dipindahkan ke Simpanan Sukarela. */
  bungaSudahKeSukarela: Rupiah;
  /** PPh 4(2) yang dipotong atas pemindahan ke Simpanan Sukarela. */
  pphAtasPemindahan: Rupiah;
  /** Neto yang benar-benar masuk saldo Simpanan Sukarela. */
  netoKeSukarela: Rupiah;
  /** Bunga yang sudah diakui tetapi belum dipindahkan / belum dibayar. */
  bungaBelumDipindahkan: Rupiah;
  /** Bunga yang dibayar TUNAI dalam jurnal pencairan (kontrak legacy). */
  bungaDibayarTunaiSaatPencairan: Rupiah;
  pphSaatPencairan: Rupiah;
  totalPph: Rupiah;
  /** Tanggal akhir periode bunga terakhir yang sudah diakui. */
  tanggalPerhitunganTerakhir: string | null;
  /** Periode berikutnya yang belum earned (informasi); null bila tidak ada. */
  periodeBerikutnya: { nomorPeriode: number; tanggalAkhir: string; bunga: Rupiah; jenis: 'KONTRAK' | 'PASCA_JATUH_TEMPO' } | null;
  /** Snapshot kebijakan (null = kontrak legacy belum ditinjau). */
  kebijakan: {
    statusPolicy: string;
    policyVersi: string | null;
    bungaPascaAktif: boolean;
    ratePascaJatuhTempo: number | null;
    autoRenewal: boolean | null;
    pascaMulaiEfektif: string | null;
  };
  /** true = pencairan hanya membayar pokok (bunga ke Simpanan Sukarela). */
  pencairanPokokSaja: boolean;
}

export async function getRincianBungaKontrakPadaDb(
  db: SQLite.SQLiteDatabase,
  kontrakId: string,
  hariIni: string
): Promise<RincianBungaKontrak> {
  const k = await ambilKontrak(db, kontrakId);
  const agregat = await db.getFirstAsync<{ kontrak: number; pasca: number; nPasca: number; terakhir: string | null }>(
    `SELECT COALESCE(SUM(CASE WHEN jenis_periode = 'PASCA_JATUH_TEMPO' THEN 0 ELSE bunga END),0) AS kontrak,
            COALESCE(SUM(CASE WHEN jenis_periode = 'PASCA_JATUH_TEMPO' THEN bunga ELSE 0 END),0) AS pasca,
            COALESCE(SUM(CASE WHEN jenis_periode = 'PASCA_JATUH_TEMPO' THEN 1 ELSE 0 END),0) AS nPasca,
            MAX(tanggal_akhir_periode) AS terakhir
       FROM simpanan_berjangka_bunga WHERE simpanan_berjangka_id = ?`,
    kontrakId
  );
  const status = await getStatusTransferBungaPadaDb(db, kontrakId);
  const bungaSudahKeSukarela = status.filter((p) => p.sudahDitransfer).reduce((t, p) => t + p.bunga, 0);
  const belumDitransfer = status.filter((p) => !p.sudahDitransfer).reduce((t, p) => t + p.bunga, 0);

  const pph = await db.getFirstAsync<{ transfer: number; cair: number }>(
    `SELECT COALESCE(SUM(CASE WHEN p.peristiwa = 'TRANSFER_SUKARELA' THEN p.pajak ELSE 0 END),0) AS transfer,
            COALESCE(SUM(CASE WHEN p.peristiwa = 'PENCAIRAN' THEN p.pajak ELSE 0 END),0) AS cair
       FROM pajak_potong_bunga_simpanan p JOIN journal j ON j.id = p.journal_id
      WHERE p.simpanan_berjangka_id = ? AND j.status = 'POSTED'`,
    kontrakId
  ).catch(() => ({ transfer: 0, cair: 0 }));

  let bungaTunai = 0;
  if (k.status === 'DICAIRKAN' && k.journal_pencairan_id) {
    const akunUtang = await resolveAccountId(db, TRANSAKSI_BUNGA_AKRUAL, 'KREDIT_UTANG_BUNGA').catch(() => null);
    if (akunUtang) {
      const r = await db.getFirstAsync<{ t: number }>(
        `SELECT COALESCE(SUM(debit),0) AS t FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
        k.journal_pencairan_id,
        akunUtang
      );
      bungaTunai = r?.t ?? 0;
    }
  }

  // Periode berikutnya: periode kontrak yang belum earned, lalu periode pasca.
  let periodeBerikutnya: RincianBungaKontrak['periodeBerikutnya'] = null;
  if (k.status === 'AKTIF' || k.status === 'JATUH_TEMPO') {
    if (k.suku_bunga > 0) {
      const p = buatJadwalBungaSimpananBerjangka(k.nominal, k.suku_bunga, k.tenor_bulan as TenorSimpananBerjangka, k.tanggal_mulai)
        .find((x) => x.tanggalAkhirPeriode > hariIni);
      if (p) periodeBerikutnya = { nomorPeriode: p.nomorPeriode, tanggalAkhir: p.tanggalAkhirPeriode, bunga: p.bunga, jenis: 'KONTRAK' };
    }
    const ratePasca = ratePascaKontrak(k);
    if (!periodeBerikutnya && ratePasca > 0) {
      const p = periodePascaJatuhTempoBerikutnya({
        pokok: k.nominal,
        tenorBulan: k.tenor_bulan as TenorSimpananBerjangka,
        tanggalMulai: k.tanggal_mulai,
        ratePascaPerTahun: ratePasca,
        sampaiTanggal: hariIni,
        mulaiEfektif: k.policy_pasca_mulai_efektif,
      });
      if (p) periodeBerikutnya = { nomorPeriode: p.nomorPeriode, tanggalAkhir: p.tanggalAkhirPeriode, bunga: p.bunga, jenis: 'PASCA_JATUH_TEMPO' };
    }
  }

  const pphTransfer = pph?.transfer ?? 0;
  const pphCair = pph?.cair ?? 0;
  return {
    kontrakId: k.id,
    nomorTransaksi: k.nomor_transaksi,
    status: k.status,
    pokok: k.nominal,
    totalBungaKontrak: hitungTotalBungaKontrak(k.nominal, k.suku_bunga, k.tenor_bulan as TenorSimpananBerjangka),
    bungaSelamaTenor: agregat?.kontrak ?? 0,
    bungaPascaJatuhTempo: agregat?.pasca ?? 0,
    jumlahPeriodePasca: agregat?.nPasca ?? 0,
    bungaSudahKeSukarela,
    pphAtasPemindahan: pphTransfer,
    netoKeSukarela: bungaSudahKeSukarela - pphTransfer,
    bungaBelumDipindahkan: k.status === 'DICAIRKAN' ? 0 : belumDitransfer,
    bungaDibayarTunaiSaatPencairan: bungaTunai,
    pphSaatPencairan: pphCair,
    totalPph: pphTransfer + pphCair,
    tanggalPerhitunganTerakhir: agregat?.terakhir ?? null,
    periodeBerikutnya,
    kebijakan: {
      statusPolicy: k.status_policy ?? 'LEGACY_POLICY_REVIEW_REQUIRED',
      policyVersi: k.policy_versi,
      bungaPascaAktif: ratePascaKontrak(k) > 0,
      ratePascaJatuhTempo: k.policy_rate_pasca_jatuh_tempo,
      autoRenewal: k.policy_auto_renewal == null ? null : k.policy_auto_renewal === 1,
      pascaMulaiEfektif: k.policy_pasca_mulai_efektif,
    },
    pencairanPokokSaja: bungaKeSukarelaMenurutKebijakan(k),
  };
}

export async function getRincianBungaKontrak(kontrakId: string, hariIni: string): Promise<RincianBungaKontrak> {
  return getRincianBungaKontrakPadaDb(await getDb(), kontrakId, hariIni);
}
