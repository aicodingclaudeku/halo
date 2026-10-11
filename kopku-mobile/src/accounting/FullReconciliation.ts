import * as SQLite from 'expo-sqlite';
import { resolveAccountId, MissingAccountMappingError } from '@/accounting/AccountMapping';
import { sqlJadwalBukanObsolete } from '@/accounting/ScheduleLifecycle';
import { rekonsiliasiDeferredIncome } from '@/accounting/DeferredIncomeReconciliation';
import { totalSisaFeeIntegral } from '@/accounting/EirFeeInvariant';

type Rupiah = number;

/**
 * MATRIKS REKONSILIASI SUBLEDGER vs GENERAL LEDGER.
 * ============================================================
 *
 * Tujuan modul ini bukan "membuat laporan terlihat cocok", melainkan
 * MENEMUKAN TITIK DIVERGENSI PERTAMA antara catatan operasional
 * (subledger) dan buku besar (GL).
 *
 * Prinsip yang dipegang:
 *
 *  1. Setiap baris menyebut SUMBER angkanya. Kalau sebuah domain tidak
 *     punya padanan satu-lawan-satu, ia ditandai `bridge` dan
 *     penjelasannya wajib ada — bukan dipaksa sama.
 *  2. Mapping COA yang hilang menghasilkan ERROR, bukan saldo 0.
 *     Rekonsiliasi yang melaporkan "seimbang" karena tidak tahu akunnya
 *     adalah kebalikan dari gunanya.
 *  3. Domain yang memang tidak dipakai koperasi (belum ada mapping DAN
 *     belum ada aktivitas) dilewati secara eksplisit dengan status
 *     `TIDAK_BERLAKU`, bukan dilaporkan seimbang.
 */
export type StatusRekonsiliasi = 'SEIMBANG' | 'SELISIH' | 'TIDAK_BERLAKU';

/**
 * Cara sebuah domain dibandingkan:
 *  - `direct`  : subledger punya padanan satu-lawan-satu dengan satu akun GL.
 *  - `bridge`  : perbandingan memerlukan formula/pembatasan; rumusnya WAJIB
 *                dijelaskan di `catatan`.
 *  - `gl-only` : tidak ada subledger independen; yang diuji adalah invarian
 *                pada saldo GL itu sendiri.
 */
export type BasisRekonsiliasi = 'direct' | 'bridge' | 'gl-only';

export interface BarisRekonsiliasi {
  domain: string;
  subledger: Rupiah;
  gl: Rupiah;
  variance: Rupiah;
  status: StatusRekonsiliasi;
  basis: BasisRekonsiliasi;
  /** Diisi bila domain ini bukan perbandingan langsung, atau bila dilewati. */
  catatan?: string;
}

export interface HasilRekonsiliasiLengkap {
  baris: BarisRekonsiliasi[];
  /** Total debit seluruh jurnal POSTED/REVERSED. */
  totalDebit: Rupiah;
  totalKredit: Rupiah;
  jurnalSeimbang: boolean;
  /** TRUE bila tidak ada satu pun baris berstatus SELISIH. */
  seluruhnyaSeimbang: boolean;
}

/** Saldo GL sebuah akun, menghormati normal balance. */
async function saldoGl(db: SQLite.SQLiteDatabase, accountId: string): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ normal_balance: string; d: number; k: number }>(
    `SELECT a.normal_balance,
            COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN je.debit ELSE 0 END), 0) as d,
            COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN je.kredit ELSE 0 END), 0) as k
     FROM account a
     LEFT JOIN journal_entry je ON je.account_id = a.id
     LEFT JOIN journal j ON j.id = je.journal_id AND j.status IN ('POSTED','REVERSED')
     WHERE a.id = ?
     GROUP BY a.id, a.normal_balance`,
    accountId
  );
  if (!row) throw new Error(`Akun ${accountId} tidak ditemukan saat rekonsiliasi.`);
  return row.normal_balance === 'DEBIT' ? row.d - row.k : row.k - row.d;
}

/**
 * Bandingkan satu domain. `adaAktivitas` membedakan "koperasi memang
 * tidak memakai domain ini" dari "mappingnya hilang padahal ada
 * transaksi" — yang kedua WAJIB gagal keras (BUG-14).
 */
async function bandingkan(
  db: SQLite.SQLiteDatabase,
  domain: string,
  subledger: Rupiah,
  mapping: { type: string; role: string },
  adaAktivitas: boolean
): Promise<BarisRekonsiliasi> {
  let accountId: string;
  try {
    accountId = await resolveAccountId(db, mapping.type, mapping.role);
  } catch (err) {
    if (err instanceof MissingAccountMappingError && !adaAktivitas) {
      return {
        domain,
        subledger: 0,
        gl: 0,
        variance: 0,
        status: 'TIDAK_BERLAKU',
        basis: 'direct',
        catatan: `Mapping "${mapping.type}/${mapping.role}" belum diatur dan belum ada aktivitas pada domain ini.`,
      };
    }
    throw new Error(
      `Rekonsiliasi "${domain}" gagal: mapping COA "${mapping.type}" (role: ${mapping.role}) tidak ditemukan ` +
        `padahal domain ini sudah memiliki aktivitas. Atur mapping tersebut lalu jalankan ulang.`
    );
  }
  const gl = await saldoGl(db, accountId);
  const variance = subledger - gl;
  return {
    domain,
    subledger,
    gl,
    variance,
    status: variance === 0 ? 'SEIMBANG' : 'SELISIH',
    basis: 'direct',
  };
}

/**
 * Saldo GL sebuah akun yang HANYA berasal dari satu sumber transaksi.
 *
 * Dipakai domain penarikan dini: akun pendapatan penalti / biaya
 * administrasi yang ditunjuk kebijakan boleh saja akun yang SAMA dengan
 * yang dipakai domain lain (mis. 4-1200 Pendapatan Denda juga menampung
 * denda angsuran pinjaman). Membandingkan saldo penuh akun itu dengan
 * subledger penarikan dini akan menghasilkan selisih palsu. Karena itu
 * pembandingnya dibatasi ke baris jurnal bersumber penarikan dini saja —
 * dan pembatasan itu dinyatakan terbuka sebagai basis `bridge`, bukan
 * disembunyikan.
 *
 * Mengembalikan (kredit - debit): komponen penarikan dini yang
 * dibandingkan semuanya bersaldo kredit.
 */
async function saldoGlSumber(
  db: SQLite.SQLiteDatabase,
  accountId: string,
  sumberTransaksi: string
): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(je.debit),0) d, COALESCE(SUM(je.kredit),0) k
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.sumber_transaksi = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId,
    sumberTransaksi
  );
  return (row?.k ?? 0) - (row?.d ?? 0);
}

async function angka(db: SQLite.SQLiteDatabase, sql: string, ...params: SQLite.SQLiteBindValue[]): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(sql, ...params);
  return row?.n ?? 0;
}

export async function jalankanRekonsiliasiLengkap(
  db: SQLite.SQLiteDatabase
): Promise<HasilRekonsiliasiLengkap> {
  const baris: BarisRekonsiliasi[] = [];

  // ---- Pinjaman: pokok outstanding ----
  // Jadwal obsolete dikecualikan (BUG-08/BUG-12).
  const pokokOutstanding = await angka(
    db,
    `SELECT COALESCE(SUM(aj.pokok - aj.pokok_terbayar), 0) as n
     FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
     WHERE ${sqlJadwalBukanObsolete('aj')} AND p.status = 'AKTIF'`
  );
  const adaPinjaman = (await angka(db, `SELECT COUNT(*) as n FROM pinjaman`)) > 0;
  baris.push(
    await bandingkan(db, 'Loan principal', pokokOutstanding, {
      type: 'PENCAIRAN_PINJAMAN',
      role: 'DEBIT_PIUTANG',
    }, adaPinjaman)
  );

  // ---- Piutang jasa yang sudah diakru tetapi belum diterima ----
  const piutangJasa = await angka(
    db,
    `SELECT COALESCE(SUM(pendapatan_akuntansi - kas_diterima), 0) as n
     FROM pinjaman_akuntansi_jasa
     WHERE tipe_pengakuan = 'JASA_AKRUAL' AND status = 'DIAKUI'`
  );
  const adaAkrual =
    (await angka(
      db,
      `SELECT COUNT(*) as n FROM pinjaman_akuntansi_jasa WHERE tipe_pengakuan = 'JASA_AKRUAL'`
    )) > 0;
  baris.push(
    await bandingkan(db, 'Loan contractual service', piutangJasa, {
      type: 'AKRUAL_JASA_PINJAMAN',
      role: 'DEBIT_PIUTANG_JASA',
    }, adaAkrual)
  );

  // ---- Simpanan (per jenis) ----
  for (const [domain, jenis, tipe] of [
    ['Savings pokok', 'POKOK', 'SIMPANAN_POKOK'],
    ['Savings wajib', 'WAJIB', 'SIMPANAN_WAJIB'],
    ['Savings sukarela', 'SUKARELA', 'SIMPANAN_SUKARELA'],
  ] as const) {
    const saldo = await angka(
      db,
      `SELECT COALESCE(SUM(CASE WHEN tipe = 'SETOR' THEN nominal ELSE -nominal END), 0) as n
       FROM simpanan_transaksi WHERE jenis = ?`,
      jenis
    );
    const ada = (await angka(db, `SELECT COUNT(*) as n FROM simpanan_transaksi WHERE jenis = ?`, jenis)) > 0;
    baris.push(await bandingkan(db, domain, saldo, { type: tipe, role: 'KREDIT_DEFAULT' }, ada));
  }

  // ---- Simpanan berjangka (deposito anggota) ----
  // Subledger TERPISAH dari `simpanan_transaksi` (lihat komentar tabel
  // `simpanan_berjangka` di schema.ts), jadi punya blok sendiri dan
  // TIDAK ikut loop per-jenis di atas.
  //
  // Yang dibandingkan adalah POKOK saja — persis yang dikredit ke
  // 2-1210 saat penempatan. Bunga kontraktual TIDAK ikut, karena bunga
  // dijurnal ke akun UTANG BUNGA yang terpisah (2-1710), bukan ke
  // 2-1210 — lihat domain "Savings berjangka (utang bunga)" di bawah.
  // Kalau suatu saat mesin akrual bunga dibuat, bunga terutang akan
  // punya akun & domain rekonsiliasinya sendiri — bukan dicampur ke
  // baris pokok ini.
  //
  // Status DICAIRKAN/DIBATALKAN dikeluarkan: keduanya tidak lagi
  // menyisakan kewajiban di 2-1210.
  const berjangkaPokok = await angka(
    db,
    `SELECT COALESCE(SUM(nominal), 0) as n FROM simpanan_berjangka WHERE status IN ('AKTIF','JATUH_TEMPO')`
  );
  const adaBerjangka = (await angka(db, `SELECT COUNT(*) as n FROM simpanan_berjangka`)) > 0;
  baris.push(
    await bandingkan(
      db,
      'Savings berjangka (pokok)',
      berjangkaPokok,
      { type: 'SIMPANAN_BERJANGKA', role: 'KREDIT_DEFAULT' },
      adaBerjangka
    )
  );

  // ---- Utang bunga simpanan berjangka ----
  // Bunga TIDAK PERNAH masuk 2-1210. Ia punya akun kewajiban sendiri
  // (2-1710) supaya pokok & bunga bisa direkonsiliasi terpisah, dan
  // supaya saldonya tidak bercampur dengan 2-1700 "Utang Bunga" yang
  // sudah dimiliki domain utang koperasi.
  //
  // Subledger = bunga yang sudah diakru tetapi belum dibayar, untuk
  // kontrak yang belum dicairkan. Kontrak DICAIRKAN otomatis keluar
  // karena utang bunganya sudah dilunasi lewat jurnal pencairan.
  const bungaTerutang = await angka(
    db,
    `SELECT COALESCE(SUM(bunga_terakru - bunga_dibayar), 0) as n
     FROM simpanan_berjangka WHERE status IN ('AKTIF','JATUH_TEMPO')`
  );
  const adaBunga =
    (await angka(db, `SELECT COUNT(*) as n FROM simpanan_berjangka_bunga`)) > 0;
  baris.push(
    await bandingkan(
      db,
      'Savings berjangka (utang bunga)',
      bungaTerutang,
      { type: 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', role: 'KREDIT_UTANG_BUNGA' },
      adaBunga
    )
  );

  // ---- Penarikan dini: penalti, biaya admin, bunga hangus (§AD) ----
  //
  // Subledger = tabel event `simpanan_berjangka_pencairan_dini`.
  // GL       = baris jurnal bersumber SIMPANAN_BERJANGKA_PENCAIRAN_DINI
  //            pada akun yang DITUNJUK KEBIJAKAN (bukan mapping COA:
  //            akun penalti & biaya admin adalah keputusan kebijakan,
  //            lihat EarlyWithdrawalPolicy.ts).
  //
  // Tidak ada rekonsiliasi melingkar: kedua sisi dibaca dari tabel yang
  // BERBEDA (tabel settlement vs journal_entry), bukan dari sumber yang
  // sama dengan nama berbeda. Merusak salah satu sisi menghasilkan
  // variance.
  const jumlahSettlementDini = await angka(
    db,
    `SELECT COUNT(*) as n FROM simpanan_berjangka_pencairan_dini`
  );
  if (jumlahSettlementDini === 0) {
    baris.push({
      domain: 'Penarikan dini simpanan berjangka',
      subledger: 0,
      gl: 0,
      variance: 0,
      status: 'TIDAK_BERLAKU',
      basis: 'bridge',
      catatan: 'Belum ada pencairan dini yang tercatat.',
    });
  } else {
    const kebijakan = await db.getFirstAsync<{
      versi: string;
      akun_penalti_id: string | null;
      akun_biaya_admin_id: string | null;
    }>(
      `SELECT versi, akun_penalti_id, akun_biaya_admin_id
       FROM simpanan_berjangka_kebijakan_dini WHERE status = 'AKTIF'`
    );
    const total = await db.getFirstAsync<{ p: number; b: number; f: number; r: number }>(
      `SELECT COALESCE(SUM(penalti),0) p, COALESCE(SUM(biaya_admin),0) b,
              COALESCE(SUM(bunga_hangus),0) f, COALESCE(SUM(penyesuaian_rate),0) r
       FROM simpanan_berjangka_pencairan_dini`
    );

    const komponen: { domain: string; nilai: number; akunId: string | null; catatan: string }[] = [
      {
        domain: 'Penarikan dini (penalti)',
        nilai: total?.p ?? 0,
        akunId: kebijakan?.akun_penalti_id ?? null,
        catatan:
          'Subledger = SUM(penalti) tabel settlement; GL = kredit akun penalti kebijakan, ' +
          'dibatasi ke jurnal bersumber SIMPANAN_BERJANGKA_PENCAIRAN_DINI.',
      },
      {
        domain: 'Penarikan dini (biaya administrasi)',
        nilai: total?.b ?? 0,
        akunId: kebijakan?.akun_biaya_admin_id ?? null,
        catatan:
          'Subledger = SUM(biaya_admin) tabel settlement; GL = kredit akun biaya administrasi ' +
          'kebijakan, dibatasi ke jurnal bersumber SIMPANAN_BERJANGKA_PENCAIRAN_DINI.',
      },
    ];

    for (const k of komponen) {
      if (k.nilai === 0 && !k.akunId) {
        baris.push({
          domain: k.domain,
          subledger: 0,
          gl: 0,
          variance: 0,
          status: 'TIDAK_BERLAKU',
          basis: 'bridge',
          catatan: 'Kebijakan penarikan dini tidak menetapkan komponen ini.',
        });
        continue;
      }
      if (!k.akunId) {
        // Ada nilai tetapi akunnya tidak diketahui — ini kegagalan
        // konfigurasi, bukan alasan melaporkan seimbang.
        throw new Error(
          `Rekonsiliasi "${k.domain}" gagal: terdapat nilai ${k.nilai} pada tabel settlement ` +
            'tetapi kebijakan aktif tidak menunjuk akun penampungnya.'
        );
      }
      const gl = await saldoGlSumber(db, k.akunId, 'SIMPANAN_BERJANGKA_PENCAIRAN_DINI');
      baris.push({
        domain: k.domain,
        subledger: k.nilai,
        gl,
        variance: k.nilai - gl,
        status: k.nilai - gl === 0 ? 'SEIMBANG' : 'SELISIH',
        basis: 'bridge',
        catatan: k.catatan,
      });
    }

    // Bunga hangus + pengurangan akibat rate dini membalik BEBAN bunga
    // akrual (bukan menjadi pendapatan). Yang dibandingkan karena itu
    // adalah pembalikan bersih pada akun beban tersebut.
    const nettoPembalikan = (total?.f ?? 0) - (total?.r ?? 0);
    let akunBeban: string | null = null;
    try {
      akunBeban = await resolveAccountId(db, 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN');
    } catch {
      akunBeban = null;
    }
    if (akunBeban === null) {
      throw new Error(
        'Rekonsiliasi "Penarikan dini (bunga hangus)" gagal: mapping ' +
          'SIMPANAN_BERJANGKA_BUNGA_AKRUAL/DEBIT_BEBAN tidak ditemukan padahal sudah ada pencairan dini.'
      );
    }
    const glPembalikan = await saldoGlSumber(db, akunBeban, 'SIMPANAN_BERJANGKA_PENCAIRAN_DINI');
    baris.push({
      domain: 'Penarikan dini (bunga hangus & penyesuaian rate)',
      subledger: nettoPembalikan,
      gl: glPembalikan,
      variance: nettoPembalikan - glPembalikan,
      status: nettoPembalikan - glPembalikan === 0 ? 'SEIMBANG' : 'SELISIH',
      basis: 'bridge',
      catatan:
        'Subledger = SUM(bunga_hangus) - SUM(penyesuaian_rate); GL = pembalikan bersih (kredit - debit) ' +
        'pada akun beban bunga akrual, dibatasi ke jurnal bersumber SIMPANAN_BERJANGKA_PENCAIRAN_DINI.',
    });
  }

  // ---- Aset tetap (bruto) ----
  const asetBruto = await angka(
    db,
    `SELECT COALESCE(SUM(nilai_perolehan), 0) as n FROM aset_tetap
     WHERE COALESCE(status,'AKTIF') <> 'DIHAPUS' AND COALESCE(jenis_aset,'TETAP') = 'TETAP'`
  );
  const adaAset =
    (await angka(db, `SELECT COUNT(*) as n FROM aset_tetap WHERE COALESCE(jenis_aset,'TETAP') = 'TETAP'`)) > 0;
  baris.push(await bandingkan(db, 'Asset gross', asetBruto, { type: 'ASET_TETAP', role: 'DEBIT_ASET' }, adaAset));

  // ---- Akumulasi penyusutan ----
  const akumulasi = await angka(
    db,
    `SELECT COALESCE(SUM(ap.nilai_penyusutan), 0) as n
     FROM aset_penyusutan ap JOIN aset_tetap a ON a.id = ap.aset_id
     WHERE COALESCE(a.jenis_aset,'TETAP') = 'TETAP'`
  );
  const adaPenyusutan = (await angka(db, `SELECT COUNT(*) as n FROM aset_penyusutan`)) > 0;
  baris.push(
    await bandingkan(db, 'Accumulated depreciation', akumulasi, {
      type: 'PENYUSUTAN_ASET',
      role: 'KREDIT_AKUMULASI',
    }, adaPenyusutan)
  );

  // ---- Pendapatan diterima dimuka (2-1300) ----
  // Dua objek akuntansi berbagi satu akun — dipisahkan eksplisit
  // (lihat DeferredIncomeReconciliation). Baris "bridge".
  const adaDeferred =
    (await angka(db, `SELECT COUNT(*) as n FROM angsuran_jadwal WHERE jasa_dimuka > 0`)) > 0 ||
    (await angka(
      db,
      `SELECT COUNT(*) as n FROM pinjaman_akuntansi_jasa WHERE tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`
    )) > 0;
  if (adaDeferred) {
    const rekon = await rekonsiliasiDeferredIncome(db);
    baris.push({
      domain: 'Contractual deferred income',
      subledger: rekon.subledgerJasaKontraktual,
      gl: rekon.glDeferredIncome - rekon.subledgerFeeIntegral,
      variance: rekon.subledgerJasaKontraktual - (rekon.glDeferredIncome - rekon.subledgerFeeIntegral),
      status:
        rekon.subledgerJasaKontraktual === rekon.glDeferredIncome - rekon.subledgerFeeIntegral
          ? 'SEIMBANG'
          : 'SELISIH',
      basis: 'bridge',
      catatan:
        'Bridge: akun 2-1300 dipakai bersama fee integral. GL untuk baris ini = saldo 2-1300 dikurangi sisa fee integral.',
    });
    baris.push({
      domain: 'EIR fee deferred',
      subledger: rekon.subledgerFeeIntegral,
      gl: rekon.glDeferredIncome - rekon.subledgerJasaKontraktual,
      variance: rekon.subledgerFeeIntegral - (rekon.glDeferredIncome - rekon.subledgerJasaKontraktual),
      status:
        rekon.subledgerFeeIntegral === rekon.glDeferredIncome - rekon.subledgerJasaKontraktual
          ? 'SEIMBANG'
          : 'SELISIH',
      basis: 'bridge',
      catatan: 'Bridge: sisi lain dari akun 2-1300 yang sama.',
    });
    baris.push({
      domain: 'Deferred income total (2-1300)',
      subledger: rekon.totalSubledger,
      gl: rekon.glDeferredIncome,
      variance: rekon.variance,
      status: rekon.variance === 0 ? 'SEIMBANG' : 'SELISIH',
      basis: 'bridge',
      catatan: 'Total kedua objek akuntansi yang berbagi akun 2-1300.',
    });
  } else {
    baris.push({
      domain: 'Deferred income total (2-1300)',
      subledger: 0,
      gl: 0,
      variance: 0,
      status: 'TIDAK_BERLAKU',
      basis: 'bridge',
      catatan: 'Belum ada deferred income kontraktual maupun fee integral.',
    });
  }

  // ---- Penyisihan piutang (allowance) ----
  const allowance = await angka(
    db,
    `SELECT COALESCE(SUM(cadangan), 0) as n FROM pinjaman_impairment_snapshot`
  ).catch(() => 0);
  const adaAllowance = allowance > 0;
  if (adaAllowance) {
    baris.push(
      await bandingkan(db, 'Allowance', allowance, {
        type: 'PENYISIHAN_PIUTANG',
        role: 'KREDIT_PENYISIHAN',
      }, true)
    );
  } else {
    baris.push({
      domain: 'Allowance',
      subledger: 0,
      gl: 0,
      variance: 0,
      status: 'TIDAK_BERLAKU',
      basis: 'direct',
      catatan: 'Belum ada snapshot penyisihan yang direkonsiliasi.',
    });
  }

  // ============================================================
  // KAS — subledger `kas_transaksi` vs baris jurnal kas yang DIRUJUKNYA
  // ============================================================
  // WHY bridge, bukan direct: `kas_transaksi` BUKAN buku kas lengkap.
  // Ia hanya mencatat transaksi kas MANUAL; pencairan pinjaman, setoran
  // simpanan, pembelian aset, dan pembayaran utang juga menggerakkan
  // akun Kas tanpa menulis baris di sana. Membandingkan SUM(kas_transaksi)
  // dengan saldo GL Kas akan SELALU berselisih dan tidak berarti apa-apa.
  //
  // Yang benar-benar bisa — dan perlu — diuji: untuk setiap baris
  // `kas_transaksi`, apakah jurnal yang dirujuknya menggerakkan akun Kas
  // sebesar nominal yang sama? Itu menangkap baris subledger yang
  // jurnalnya terposting dengan angka berbeda, terbalik arahnya, atau
  // tidak menyentuh akun kas sama sekali.
  const adaKas = (await angka(db, `SELECT COUNT(*) as n FROM kas_transaksi`)) > 0;
  if (adaKas) {
    const kasAccountId = await resolveAccountId(db, 'KAS_UMUM', 'DEFAULT');
      // S19/P2 — baris TRANSFER dihitung MENURUT ARAHNYA
      // (`arah_transfer`, kolom subledger sejak schema v53). Sebelum
      // ini seluruh baris transfer jatuh ke `ELSE 0`, sementara sisi GL
      // di bawah tetap memasukkan jurnal transfernya — menghasilkan
      // selisih PALSU sebesar transfer neto. Arah dibaca dari
      // SUBLEDGER, bukan dari jurnal, supaya sisi kiri dan sisi kanan
      // perbandingan ini tetap dua sumber yang berbeda (non-sirkular).
      //
      // 'KOREKSI' tetap 0 dengan sengaja: baris koreksi merujuk jurnal
      // ASLI yang sudah di-reverse dan tidak menambah mutasi kas baru,
      // jadi menghitungnya akan menggandakan nominal yang sama.
    const subledgerKas = await angka(
      db,
      `SELECT COALESCE(SUM(CASE WHEN tipe = 'PENERIMAAN' THEN nominal
                                WHEN tipe = 'PENGELUARAN' THEN -nominal
                                WHEN tipe = 'TRANSFER' AND arah_transfer = 'MASUK' THEN nominal
                                WHEN tipe = 'TRANSFER' AND arah_transfer = 'KELUAR' THEN -nominal
                                ELSE 0 END), 0) as n
       FROM kas_transaksi WHERE jenis_kas = 'KAS'`
    );
    // Baris transfer yang arahnya TIDAK dapat direkonstruksi (lihat
    // migrasi v53). Tidak boleh disamarkan menjadi nol — jumlahnya
    // dilaporkan apa adanya dan barisnya ditandai SELISIH walaupun
    // angkanya kebetulan bertemu.
    const transferTanpaArahKas = await angka(
      db,
      `SELECT COUNT(*) as n FROM kas_transaksi
        WHERE jenis_kas = 'KAS' AND tipe = 'TRANSFER' AND arah_transfer IS NULL`
    );
    const glKas = await angka(
      db,
      `SELECT COALESCE(SUM(je.debit - je.kredit), 0) as n
       FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = ?
         AND j.status IN ('POSTED','REVERSED')
         AND j.id IN (SELECT journal_id FROM kas_transaksi WHERE jenis_kas = 'KAS' AND journal_id IS NOT NULL)`,
      kasAccountId
    );
    baris.push({
      domain: 'Cash',
      subledger: subledgerKas,
      gl: glKas,
      variance: subledgerKas - glKas,
      status: subledgerKas - glKas === 0 && transferTanpaArahKas === 0 ? 'SEIMBANG' : 'SELISIH',
      basis: 'bridge',
      catatan:
        'GL dibatasi pada jurnal yang dirujuk kas_transaksi. Akun Kas juga digerakkan modul lain (pinjaman, simpanan, aset) yang tidak menulis ke subledger ini.' +
        (transferTanpaArahKas > 0
          ? ` ${transferTanpaArahKas} baris transfer tidak punya arah (arah_transfer NULL) sehingga TIDAK dapat direkonsiliasi — perbaiki datanya, jangan abaikan baris ini.`
          : ''),
    });
  } else {
    baris.push({
      domain: 'Cash',
      subledger: 0, gl: 0, variance: 0,
      status: 'TIDAK_BERLAKU', basis: 'bridge',
      catatan: 'Belum ada transaksi kas manual.',
    });
  }

  // ============================================================
  // BANK — per rekening, TERMASUK rekening yang sudah dinonaktifkan
  // ============================================================
  // BUG-04: status `aktif` hanya mengatur boleh-tidaknya dipakai untuk
  // transaksi BARU. Rekening tertutup yang punya histori WAJIB tetap
  // direkonsiliasi — kalau tidak, saldonya lenyap dari pemeriksaan.
  const rekening = await db.getAllAsync<{ id: string; account_id: string; aktif: number }>(
    `SELECT id, account_id, aktif FROM bank_account`
  );
  if (rekening.length > 0) {
    let subledgerBank = 0;
    let glBank = 0;
    let transferTanpaArahBank = 0;
    for (const r of rekening) {
      // S19/P2 — sama seperti Kas: arah transfer dibaca dari subledger.
      subledgerBank += await angka(
        db,
        `SELECT COALESCE(SUM(CASE WHEN tipe = 'PENERIMAAN' THEN nominal
                                  WHEN tipe = 'PENGELUARAN' THEN -nominal
                                  WHEN tipe = 'TRANSFER' AND arah_transfer = 'MASUK' THEN nominal
                                  WHEN tipe = 'TRANSFER' AND arah_transfer = 'KELUAR' THEN -nominal
                                  ELSE 0 END), 0) as n
         FROM bank_transaksi WHERE bank_account_id = ?`,
        r.id
      );
      transferTanpaArahBank += await angka(
        db,
        `SELECT COUNT(*) as n FROM bank_transaksi
          WHERE bank_account_id = ? AND tipe = 'TRANSFER' AND arah_transfer IS NULL`,
        r.id
      );
      glBank += await angka(
        db,
        `SELECT COALESCE(SUM(je.debit - je.kredit), 0) as n
         FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
         WHERE je.account_id = ?
           AND j.status IN ('POSTED','REVERSED')
           AND j.id IN (SELECT journal_id FROM bank_transaksi WHERE bank_account_id = ? AND journal_id IS NOT NULL)`,
        r.account_id,
        r.id
      );
    }
    const nonaktif = rekening.filter((r) => !r.aktif).length;
    baris.push({
      domain: 'Bank',
      subledger: subledgerBank,
      gl: glBank,
      variance: subledgerBank - glBank,
      status: subledgerBank - glBank === 0 && transferTanpaArahBank === 0 ? 'SEIMBANG' : 'SELISIH',
      basis: 'bridge',
      catatan:
        `Seluruh ${rekening.length} rekening ikut direkonsiliasi (${nonaktif} nonaktif). ` +
        'GL dibatasi pada jurnal yang dirujuk bank_transaksi.' +
        (transferTanpaArahBank > 0
          ? ` ${transferTanpaArahBank} baris transfer tidak punya arah (arah_transfer NULL) sehingga TIDAK dapat direkonsiliasi — perbaiki datanya, jangan abaikan baris ini.`
          : ''),
    });
  } else {
    baris.push({
      domain: 'Bank',
      subledger: 0, gl: 0, variance: 0,
      status: 'TIDAK_BERLAKU', basis: 'bridge',
      catatan: 'Belum ada rekening bank.',
    });
  }

  // ============================================================
  // LIABILITAS — POKOK
  // ============================================================
  // Subledger `utang` memisahkan pokok dari bunga, jadi rekonsiliasinya
  // juga dipisah (§6). Tiga jenis pemberi memakai akun COA berbeda;
  // akun dikumpulkan sebagai Set supaya akun yang kebetulan sama tidak
  // dihitung dua kali.
  const adaUtang = (await angka(db, `SELECT COUNT(*) as n FROM utang`)) > 0;
  if (adaUtang) {
    const pokokOutstandingUtang = await angka(
      db,
      `SELECT COALESCE(SUM(u.pokok_pinjaman), 0)
              - COALESCE((SELECT SUM(up.pokok) FROM utang_pembayaran up), 0) as n
       FROM utang u`
    );
    const akunUtang = new Set<string>();
    for (const tipe of ['UTANG_BANK', 'UTANG_PIHAK_LAIN', 'UTANG_USAHA']) {
      try {
        akunUtang.add(await resolveAccountId(db, tipe, 'KREDIT_DEFAULT'));
      } catch (err) {
        if (!(err instanceof MissingAccountMappingError)) throw err;
        // Jenis utang yang tidak dipakai koperasi ini — dilewati.
      }
    }
    if (akunUtang.size === 0) {
      throw new Error(
        'Rekonsiliasi "Liability principal" gagal: tidak ada satu pun mapping COA utang ' +
          '(UTANG_BANK / UTANG_PIHAK_LAIN / UTANG_USAHA) padahal tabel utang sudah berisi data.'
      );
    }
    let glUtang = 0;
    for (const id of akunUtang) glUtang += await saldoGl(db, id);
    baris.push({
      domain: 'Liability principal',
      subledger: pokokOutstandingUtang,
      gl: glUtang,
      variance: pokokOutstandingUtang - glUtang,
      status: pokokOutstandingUtang - glUtang === 0 ? 'SEIMBANG' : 'SELISIH',
      basis: 'direct',
      catatan: 'Pokok utang dikurangi seluruh pembayaran pokok, dibandingkan total saldo akun utang.',
    });
  } else {
    baris.push({
      domain: 'Liability principal',
      subledger: 0, gl: 0, variance: 0,
      status: 'TIDAK_BERLAKU', basis: 'direct',
      catatan: 'Belum ada utang koperasi.',
    });
  }

  // ============================================================
  // LIABILITAS — BUNGA AKRUAL
  // ============================================================
  // TIDAK ADA subledger independen untuk bunga akrual: `getSaldoUtangBunga`
  // membaca saldo akun GL langsung, dan tidak ada tabel yang menyimpan
  // saldo akrual per utang. Karena itu basisnya `gl-only` dan yang diuji
  // adalah invarian pada saldo itu sendiri — bukan perbandingan palsu
  // terhadap angka yang berasal dari sumber yang sama.
  //
  // Ini SENGAJA tidak dilaporkan sebagai 'direct': menyatakan dua sisi
  // "cocok" padahal keduanya dibaca dari GL adalah rekonsiliasi semu.
  try {
    const akunBunga = await resolveAccountId(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL');
    const glBunga = await saldoGl(db, akunBunga);
    const adaAktivitasBunga =
      glBunga !== 0 || (await angka(db, `SELECT COALESCE(SUM(bunga),0) as n FROM utang_pembayaran`)) > 0;
    baris.push({
      domain: 'Liability interest',
      subledger: glBunga,
      gl: glBunga,
      variance: 0,
      // Liabilitas tidak boleh bersaldo negatif (debit): itu berarti
      // bunga dibayar melebihi yang pernah diakru.
      status: !adaAktivitasBunga ? 'TIDAK_BERLAKU' : glBunga >= 0 ? 'SEIMBANG' : 'SELISIH',
      basis: 'gl-only',
      catatan:
        'Tidak ada subledger independen untuk bunga akrual (saldo dibaca dari GL). ' +
        'Yang diuji: saldo liabilitas tidak boleh negatif.',
    });
  } catch (err) {
    if (!(err instanceof MissingAccountMappingError)) throw err;
    baris.push({
      domain: 'Liability interest',
      subledger: 0, gl: 0, variance: 0,
      status: 'TIDAK_BERLAKU', basis: 'gl-only',
      catatan: 'Mapping UTANG_BUNGA/KREDIT_AKRUAL belum diatur dan belum ada aktivitas bunga.',
    });
  }

  // ============================================================
  // EKUITAS — identitas akuntansi
  // ============================================================
  // Tidak ada "subledger ekuitas" tunggal (simpanan pokok/wajib,
  // cadangan, SHU berjalan semuanya berkontribusi). Yang bermakna dan
  // bisa diuji adalah identitas dasarnya: Aset = Liabilitas + Ekuitas.
  // Sisi "subledger" di sini adalah Aset - Liabilitas menurut GL.
  //
  // PENTING — tandanya ditentukan KATEGORI, bukan `normal_balance`.
  // Akun KONTRA (akumulasi penyusutan, penyisihan piutang) berkategori
  // ASET tetapi bersaldo normal KREDIT. Kalau tandanya diambil dari
  // normal_balance, akun-akun itu MENAMBAH total aset padahal fungsinya
  // MENGURANGI — dan selisihnya muncul sebesar dua kali saldo kontra.
  // Untuk persamaan akuntansi, seluruh akun ASET dihitung debit-kredit
  // apa pun saldo normalnya, sehingga kontra-aset otomatis negatif.
  const totalPerKategori = async (kategori: string): Promise<Rupiah> => {
    const arahDebit = kategori === 'ASET' || kategori === 'BEBAN';
    return angka(
      db,
      `SELECT COALESCE(SUM(${arahDebit ? 'je.debit - je.kredit' : 'je.kredit - je.debit'}), 0) as n
       FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       JOIN account a ON a.id = je.account_id
       WHERE a.kategori = ? AND j.status IN ('POSTED','REVERSED')`,
      kategori
    );
  };
  const totalAset = await totalPerKategori('ASET');
  const totalLiabilitas = await totalPerKategori('LIABILITAS');
  const totalEkuitasGl = await totalPerKategori('EKUITAS');
  const totalPendapatan = await totalPerKategori('PENDAPATAN');
  const totalBeban = await totalPerKategori('BEBAN');

  // Laba/rugi berjalan BELUM ditutup ke akun ekuitas selama tahun buku
  // berjalan, jadi persamaan dasarnya adalah:
  //
  //     Aset = Liabilitas + Ekuitas + (Pendapatan - Beban)
  //
  // Menghilangkan suku terakhir akan SELALU memunculkan selisih sebesar
  // SHU berjalan dan salah dibaca sebagai kerusakan data. Yang benar
  // adalah memasukkannya ke dalam rumus, bukan melonggarkan assertion.
  const shuBerjalan = totalPendapatan - totalBeban;
  const ekuitasTersirat = totalAset - totalLiabilitas - shuBerjalan;
  baris.push({
    domain: 'Equity',
    subledger: ekuitasTersirat,
    gl: totalEkuitasGl,
    variance: ekuitasTersirat - totalEkuitasGl,
    status: ekuitasTersirat - totalEkuitasGl === 0 ? 'SEIMBANG' : 'SELISIH',
    basis: 'bridge',
    catatan:
      `Bridge: sisi subledger = Aset - Liabilitas - SHU berjalan (${shuBerjalan}). ` +
      'SHU berjalan dikeluarkan karena laba/rugi tahun berjalan belum ditutup ke akun ekuitas. ' +
      'Selisih pada baris ini berarti persamaan dasar akuntansi tidak terpenuhi.',
  });

  // ============================================================
  // SHU
  // ============================================================
  // Subledger: alokasi per anggota (`shu_anggota`). GL: pendebetan akun
  // "SHU Belum Dibagi" oleh jurnal distribusi. Bagian anggota hanyalah
  // SEBAGIAN dari SHU yang didistribusikan (ada juga cadangan, dana
  // pendidikan, dsb.), jadi yang diuji adalah bagian anggota tidak
  // melebihi total yang didistribusikan.
  const adaShu = (await angka(db, `SELECT COUNT(*) as n FROM shu_anggota`)) > 0;
  if (adaShu) {
    const shuAnggota = await angka(db, `SELECT COALESCE(SUM(total_shu_anggota),0) as n FROM shu_anggota`);
    const akunShuBerjalan = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'DEBIT_SHU_BERJALAN');
    const shuDidistribusikan = await angka(
      db,
      `SELECT COALESCE(SUM(je.debit),0) as n
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = ? AND j.sumber_transaksi = 'SHU_DISTRIBUSI' AND j.status IN ('POSTED','REVERSED')`,
      akunShuBerjalan
    );
    baris.push({
      domain: 'SHU',
      subledger: shuAnggota,
      gl: shuDidistribusikan,
      variance: shuAnggota > shuDidistribusikan ? shuAnggota - shuDidistribusikan : 0,
      status: shuAnggota <= shuDidistribusikan ? 'SEIMBANG' : 'SELISIH',
      basis: 'bridge',
      catatan:
        'Bridge: alokasi anggota adalah SEBAGIAN dari SHU yang didistribusikan (sisanya cadangan & dana lain). ' +
        'Invarian: bagian anggota tidak boleh melebihi total yang didebet dari SHU Belum Dibagi.',
    });
  } else {
    baris.push({
      domain: 'SHU',
      subledger: 0, gl: 0, variance: 0,
      status: 'TIDAK_BERLAKU', basis: 'bridge',
      catatan: 'Belum ada distribusi SHU.',
    });
  }

  // ---- Kontrol GL global ----
  const total = await db.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE j.status IN ('POSTED','REVERSED')`
  );
  const totalDebit = total?.d ?? 0;
  const totalKredit = total?.k ?? 0;

  return {
    baris,
    totalDebit,
    totalKredit,
    jurnalSeimbang: totalDebit === totalKredit,
    seluruhnyaSeimbang: baris.every((b) => b.status !== 'SELISIH'),
  };
}
