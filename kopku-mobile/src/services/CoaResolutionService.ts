import * as SQLite from 'expo-sqlite';
import { KODE_COA_DIMINTA_ITEM_14 } from '@/config/coaPolicyRegistry';
import { Rupiah } from '@/utils/money';

/**
 * DAMPAK HISTORIS COA — RC-S54 TAHAP 12 (ITEM #14). READ-ONLY.
 *
 * Basis data KOPKU hidup di perangkat pengguna, sehingga jumlah jurnal yang
 * akan terdampak oleh perubahan COA TIDAK dapat dihitung dari source tree.
 * Fungsi ini menghitungnya pada basis data yang sebenarnya — dijalankan
 * sebelum keputusan migration/reklasifikasi apa pun diambil.
 *
 * Tidak ada INSERT/UPDATE/DELETE di berkas ini.
 */

/** Akun existing yang menjadi tujuan/penanggung fungsi 12 kode yang diminta, ditambah 2-1300 (EIR). */
export const KODE_AKUN_TERKAIT_ITEM_14: readonly string[] = [
  '1-1660', '1-1670', '1-1900',
  '1-1220', '1-1240', '1-1250',
  '4-1300', '4-1500', '4-1600', '4-1700',
  '2-1300',
];

/** Subledger yang bergantung pada akun tertentu — dihitung jumlah barisnya. */
const SUBLEDGER_PER_KODE: Record<string, readonly { tabel: string; where: string }[]> = {
  '1-1660': [
    { tabel: 'investasi', where: `jenis_investasi = 'PROPERTI_INVESTASI'` },
    { tabel: 'investasi_penyusutan', where: '1=1' },
    { tabel: 'penyesuaian_nilai_wajar', where: '1=1' },
  ],
  '1-1670': [{ tabel: 'investasi_penyusutan', where: '1=1' }],
  '1-1900': [{ tabel: 'investasi_impairment', where: '1=1' }],
  '1-1220': [
    { tabel: 'investasi_bagian_shu', where: '1=1' },
    { tabel: 'investasi_bagian_shu_penerimaan', where: '1=1' },
  ],
  '4-1300': [{ tabel: 'investasi_bagian_shu', where: '1=1' }],
};

export interface DampakHistorisAkun {
  readonly kode: string;
  readonly akunAda: boolean;
  readonly aktif: boolean | null;
  readonly isSystem: boolean | null;
  readonly jumlahJurnal: number;
  readonly jumlahEntri: number;
  readonly periodeAwal: string | null;
  readonly periodeAkhir: string | null;
  readonly jumlahPeriode: number;
  /** RC-S54 T15 — total debit/kredit jurnal POSTED/REVERSED pada akun ini. */
  readonly totalDebit: Rupiah;
  readonly totalKredit: Rupiah;
  /** RC-S54 T15 — tanggal jurnal paling awal / paling akhir (YYYY-MM-DD). */
  readonly tanggalAwal: string | null;
  readonly tanggalAkhir: string | null;
  /** Saldo menurut normal balance akun (0 bila akun tidak ada). */
  readonly saldo: Rupiah;
  readonly sumberJurnal: readonly string[];
  readonly mapping: readonly string[];
  readonly subledger: readonly { tabel: string; jumlahBaris: number }[];
}

export interface DampakHistorisCoa {
  /** Akun existing terkait. */
  readonly akunTerkait: readonly DampakHistorisAkun[];
  /** 12 kode yang diminta — `akunAda = true` berarti ada akun manual berkode itu di perangkat ini. */
  readonly kodeDiminta: readonly DampakHistorisAkun[];
  /** Kode yang diminta tetapi SUDAH ada sebagai akun (dibuat manual sebelum guard). Tidak disentuh. */
  readonly kodeDimintaSudahAda: readonly string[];
}

async function tabelAda(db: SQLite.SQLiteDatabase, tabel: string): Promise<boolean> {
  const r = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tabel
  );
  return (r?.n ?? 0) > 0;
}

async function dampakSatuKode(db: SQLite.SQLiteDatabase, kode: string): Promise<DampakHistorisAkun> {
  const akun = await db.getFirstAsync<{ id: string; normal_balance: string; is_active: number; is_system: number }>(
    `SELECT id, normal_balance, is_active, is_system FROM account WHERE kode = ?`,
    kode
  );
  const subledger: { tabel: string; jumlahBaris: number }[] = [];
  for (const s of SUBLEDGER_PER_KODE[kode] ?? []) {
    if (!(await tabelAda(db, s.tabel))) continue;
    const r = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${s.tabel} WHERE ${s.where}`);
    subledger.push({ tabel: s.tabel, jumlahBaris: r?.n ?? 0 });
  }

  if (!akun) {
    return {
      kode, akunAda: false, aktif: null, isSystem: null, jumlahJurnal: 0, jumlahEntri: 0,
      periodeAwal: null, periodeAkhir: null, jumlahPeriode: 0,
      totalDebit: 0, totalKredit: 0, tanggalAwal: null, tanggalAkhir: null, saldo: 0,
      sumberJurnal: [], mapping: [], subledger,
    };
  }

  const agregat = await db.getFirstAsync<{
    jurnal: number; entri: number; awal: string | null; akhir: string | null; periode: number; d: number; k: number;
    tglAwal: string | null; tglAkhir: string | null;
  }>(
    `SELECT COUNT(DISTINCT je.journal_id) AS jurnal, COUNT(*) AS entri,
            MIN(substr(j.tanggal,1,10)) AS tglAwal, MAX(substr(j.tanggal,1,10)) AS tglAkhir,
            MIN(substr(j.tanggal,1,7)) AS awal, MAX(substr(j.tanggal,1,7)) AS akhir,
            COUNT(DISTINCT substr(j.tanggal,1,7)) AS periode,
            COALESCE(SUM(CASE WHEN j.status IN ('POSTED','REVERSED') THEN je.debit ELSE 0 END),0) AS d,
            COALESCE(SUM(CASE WHEN j.status IN ('POSTED','REVERSED') THEN je.kredit ELSE 0 END),0) AS k
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ?`,
    akun.id
  );
  const sumber = await db.getAllAsync<{ s: string }>(
    `SELECT DISTINCT j.sumber_transaksi AS s FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? ORDER BY s`,
    akun.id
  );
  const mapping = await db.getAllAsync<{ t: string; r: string }>(
    `SELECT transaction_type AS t, role AS r FROM account_mapping WHERE account_id = ? ORDER BY t, r`,
    akun.id
  );
  const d = agregat?.d ?? 0;
  const k = agregat?.k ?? 0;
  return {
    kode,
    akunAda: true,
    aktif: akun.is_active === 1,
    isSystem: akun.is_system === 1,
    jumlahJurnal: agregat?.jurnal ?? 0,
    jumlahEntri: agregat?.entri ?? 0,
    periodeAwal: agregat?.awal ?? null,
    periodeAkhir: agregat?.akhir ?? null,
    jumlahPeriode: agregat?.periode ?? 0,
    totalDebit: d,
    totalKredit: k,
    tanggalAwal: agregat?.tglAwal ?? null,
    tanggalAkhir: agregat?.tglAkhir ?? null,
    saldo: akun.normal_balance === 'KREDIT' ? k - d : d - k,
    sumberJurnal: sumber.map((x) => x.s),
    mapping: mapping.map((m) => `${m.t}/${m.r}`),
    subledger,
  };
}

/** Hitung dampak historis seluruh akun yang tersentuh keputusan COA item #14. Read-only. */
export async function getDampakHistorisCoa(db: SQLite.SQLiteDatabase): Promise<DampakHistorisCoa> {
  const akunTerkait: DampakHistorisAkun[] = [];
  for (const kode of KODE_AKUN_TERKAIT_ITEM_14) akunTerkait.push(await dampakSatuKode(db, kode));
  const kodeDiminta: DampakHistorisAkun[] = [];
  for (const e of KODE_COA_DIMINTA_ITEM_14) kodeDiminta.push(await dampakSatuKode(db, e.kode));
  return {
    akunTerkait,
    kodeDiminta,
    kodeDimintaSudahAda: kodeDiminta.filter((x) => x.akunAda).map((x) => x.kode),
  };
}

// ===========================================================================
// RC-S54 TAHAP 15 — DIAGNOSTIK PENYAJIAN COA ITEM #14. READ-ONLY.
// ===========================================================================
//
// Keputusan #14 tidak memindahkan saldo apa pun, sehingga TIDAK ADA jurnal
// historis yang perlu dikoreksi. Yang dapat terdampak hanyalah PENYAJIAN
// laporan per tanggal. Fungsi ini melaporkan, per akun, kondisi yang
// membuat penyajian terdampak — untuk dijalankan di perangkat, karena data
// produksi tidak ada di source tree. Tidak ada INSERT/UPDATE/DELETE.

export type KodeTemuanPenyajianCoa =
  /** 2-1300 bersaldo debit: Posisi Keuangan menyajikan liabilitas negatif. */
  | 'SALDO_DEBIT_2_1300'
  /** Piutang hasil investasi bersaldo: CALK sebelum T15 memuatnya di catatan piutang pinjaman anggota. */
  | 'PIUTANG_HASIL_INVESTASI_BERSALDO'
  /** Akumulasi penyusutan properti investasi bersaldo: CALK sebelum T15 menyajikan nilai tercatat investasi terlalu tinggi. */
  | 'PENYUSUTAN_PROPERTI_INVESTASI_BERSALDO';

export interface TemuanPenyajianCoa {
  readonly kode: KodeTemuanPenyajianCoa;
  readonly akun: string;
  readonly jumlahJurnal: number;
  readonly totalDebit: Rupiah;
  readonly totalKredit: Rupiah;
  readonly tanggalAwal: string | null;
  readonly tanggalAkhir: string | null;
  /** Saldo per tanggal menurut normal balance akun. */
  readonly saldo: Rupiah;
  readonly laporanTerdampak: readonly string[];
  /**
   * true  = penyajian otomatis sudah benar/dihitung ulang dari ledger tanpa menulis DB;
   * false = masih memerlukan keputusan penyajian (tidak ada koreksi otomatis).
   */
  readonly koreksiDeterministik: boolean;
  readonly keterangan: string;
}

async function agregatAkunPerTanggal(db: SQLite.SQLiteDatabase, kode: string, tanggal: string) {
  const akun = await db.getFirstAsync<{ id: string; normal_balance: string }>(
    `SELECT id, normal_balance FROM account WHERE kode = ?`,
    kode
  );
  if (!akun) return null;
  const r = await db.getFirstAsync<{ jurnal: number; d: number; k: number; awal: string | null; akhir: string | null }>(
    `SELECT COUNT(DISTINCT je.journal_id) AS jurnal,
            COALESCE(SUM(je.debit),0) AS d, COALESCE(SUM(je.kredit),0) AS k,
            MIN(substr(j.tanggal,1,10)) AS awal, MAX(substr(j.tanggal,1,10)) AS akhir
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') AND substr(j.tanggal,1,10) <= ?`,
    akun.id,
    tanggal
  );
  const d = r?.d ?? 0;
  const k = r?.k ?? 0;
  return {
    jumlahJurnal: r?.jurnal ?? 0,
    totalDebit: d,
    totalKredit: k,
    tanggalAwal: r?.awal ?? null,
    tanggalAkhir: r?.akhir ?? null,
    saldo: akun.normal_balance === 'KREDIT' ? k - d : d - k,
  };
}

/** Diagnostik penyajian #14 per tanggal laporan. Read-only; tidak mengoreksi apa pun. */
export async function diagnosaPenyajianCoaItem14(
  db: SQLite.SQLiteDatabase,
  tanggal: string
): Promise<readonly TemuanPenyajianCoa[]> {
  const hasil: TemuanPenyajianCoa[] = [];

  const dimuka = await agregatAkunPerTanggal(db, '2-1300', tanggal);
  if (dimuka && dimuka.saldo < 0) {
    hasil.push({
      kode: 'SALDO_DEBIT_2_1300',
      akun: '2-1300',
      ...dimuka,
      // RC-S54 T16: aplikasi hanya punya Arus Kas metode LANGSUNG (baris kas),
      // yang tidak tersentuh komponen EIR non-kas — label "Arus Kas indirek"
      // pada T15 keliru dan dihapus.
      laporanTerdampak: ['Posisi Keuangan', 'CALK (catatan 5)'],
      koreksiDeterministik: true,
      keterangan:
        'Keputusan penyajian #14-C = OPSI C: saldo disajikan apa adanya (Posisi Keuangan = Neraca Saldo) dan diungkapkan otomatis di CALK catatan 5. Pengukuran benar (Piutang − komponen EIR = amortized cost); tidak ada koreksi jurnal.',
    });
  }

  for (const kode of ['1-1220', '1-1240', '1-1250']) {
    const a = await agregatAkunPerTanggal(db, kode, tanggal);
    if (a && a.saldo !== 0) {
      hasil.push({
        kode: 'PIUTANG_HASIL_INVESTASI_BERSALDO',
        akun: kode,
        ...a,
        laporanTerdampak: ['CALK (catatan 5 & 11)'],
        koreksiDeterministik: true,
        keterangan:
          'CALK otomatis kini menyajikannya di catatan 11, bukan catatan 5. CALK yang pernah disunting/disimpan manual tidak diubah.',
      });
    }
  }

  const susut = await agregatAkunPerTanggal(db, '1-1670', tanggal);
  if (susut && susut.saldo !== 0) {
    hasil.push({
      kode: 'PENYUSUTAN_PROPERTI_INVESTASI_BERSALDO',
      akun: '1-1670',
      ...susut,
      laporanTerdampak: ['CALK (catatan 11)'],
      koreksiDeterministik: true,
      keterangan:
        'CALK otomatis kini mengurangkan akumulasi penyusutan dari nilai tercatat investasi. CALK yang pernah disunting/disimpan manual tidak diubah.',
    });
  }

  return hasil;
}
