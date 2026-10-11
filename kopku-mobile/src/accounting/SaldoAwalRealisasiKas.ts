import * as SQLite from 'expo-sqlite';
import { Rupiah } from '@/utils/money';

/**
 * RC-S133.4.3 — REALISASI KAS UNTUK SALDO AWAL PENDAPATAN/BEBAN.
 *
 * MASALAH YANG DIPERBAIKI
 * Koperasi yang mulai memakai aplikasi di TENGAH tahun buku memasukkan
 * pendapatan & beban Jan–cut-off lewat Saldo Awal Akun (mis. 4-1000
 * Pendapatan Jasa Pinjaman). Jurnalnya berlawanan dengan akun kliring
 * 3-5000, BUKAN Kas — uang tunai hasil pendapatan itu sudah terkandung
 * di saldo awal Kas yang dicatat terpisah. Akibatnya
 * `getInformasiShuRAT()` (jalur 1–4) tidak pernah melihat kasnya dan
 * melaporkan SHU Basis Kas Rp0 + seluruh pendapatan sebagai "akrual
 * belum kas", padahal kasnya sudah diterima sebelum cut-off.
 *
 * ATURAN (jalur 5):
 *  - Baris PENDAPATAN/BEBAN pada jurnal `SALDO_AWAL_AKUN` /
 *    `KOREKSI_SALDO_AWAL` (termasuk jurnal reversal-nya, yang mewarisi
 *    sumber yang sama) di dalam periode dianggap SUDAH diterima/dibayar
 *    tunai — KECUALI bagian yang oleh pengguna dinyatakan BELUM tunai
 *    (masih piutang/utang saat cut-off) lewat layar Saldo Awal.
 *  - Jurnal saldo awal yang SUDAH menyentuh Kas/Bank (mekanisme batch
 *    lama: satu jurnal memuat semua akun termasuk Kas) TIDAK ikut jalur
 *    ini karena sudah dihitung jalur 1 — tidak ada hitung ganda.
 *  - Dihitung NET per akun dari jurnal (bukan dari angka di tabel
 *    saldo_awal_akun) supaya selalu sejalan dengan SHU akrual: hapus
 *    saldo awal (jurnal + reversal) → net 0, koreksi → ikut selisihnya.
 *
 * PENYIMPANAN bagian belum tunai: `app_config`, satu kunci per akun
 * (`saldo_awal.belum_tunai.<accountId>` → nominal Rupiah). TANPA kolom
 * baru → TANPA kenaikan SCHEMA_VERSION, sehingga HP & desktop versi
 * lama tetap bisa sinkron (kunci yang tidak dikenal hanya diabaikan).
 * Kunci ini BUKAN kunci khusus perangkat, jadi ikut tersinkron.
 */

export const PREFIX_CONFIG_SALDO_AWAL_BELUM_TUNAI = 'saldo_awal.belum_tunai.';

export const SUMBER_JURNAL_SALDO_AWAL: readonly string[] = ['SALDO_AWAL_AKUN', 'KOREKSI_SALDO_AWAL'];

export function kunciBelumTunai(accountId: string): string {
  return `${PREFIX_CONFIG_SALDO_AWAL_BELUM_TUNAI}${accountId}`;
}

/** Peta accountId → bagian saldo awal yang BELUM tunai yang DIATUR pengguna (termasuk 0 = seluruhnya tunai). */
export async function bacaBagianBelumTunaiDiatur(db: SQLite.SQLiteDatabase): Promise<Map<string, Rupiah>> {
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    `SELECT key, value FROM app_config WHERE key LIKE ?`,
    `${PREFIX_CONFIG_SALDO_AWAL_BELUM_TUNAI}%`
  );
  const peta = new Map<string, Rupiah>();
  for (const r of rows) {
    const n = Math.round(Number(r.value));
    if (Number.isFinite(n) && n >= 0) peta.set(r.key.slice(PREFIX_CONFIG_SALDO_AWAL_BELUM_TUNAI.length), n);
  }
  return peta;
}

/**
 * Peta accountId → bagian saldo awal yang BELUM tunai yang BERLAKU (> 0).
 *
 * RC-S133.4.5 — BAWAAN UNTUK PENDAPATAN JASA PINJAMAN: bila pengguna belum
 * mengatur bagian tunai akun Pendapatan Jasa Pinjaman dan ada saldo awal
 * Piutang Jasa Pinjaman, bagian sebesar piutang itu dianggap BELUM tunai
 * (jasa yang sudah diakui pembukuan lama tetapi belum dibayar anggota).
 * Tanpa ini, koperasi yang pembukuannya akrual melihat SHU Basis Kas
 * terlalu besar sebesar piutang jasanya.
 */
/**
 * RC-S133.4.6 — BEBAN YANG SIFATNYA TIDAK PERNAH MENGELUARKAN KAS.
 *
 * Uji setara (transaksi biasa vs import saldo lama) menunjukkan SHU Basis
 * Kas jalur import terlalu kecil: saldo awal Beban Penyusutan dianggap
 * "sudah dibayar tunai" secara bawaan, padahal di jalur transaksi biasa
 * beban yang sama (jurnal penyusutan) tidak pernah menyentuh Kas.
 *
 * Akun beban di bawah ini — dicari lewat PEMETAAN AKUN, bukan kode — di
 * aplikasi ini selalu dijurnal tanpa Kas/Bank: penyusutan aset tetap &
 * properti investasi, amortisasi, penyisihan piutang, penurunan nilai
 * investasi, dan bunga simpanan yang dikreditkan ke Simpanan Sukarela.
 * Bila pengguna BELUM mengatur bagian tunainya, seluruh saldo awalnya
 * dianggap belum tunai. Pengaturan pengguna (tombol "Ubah" di layar Saldo
 * Awal, atau kolom Bagian Tunai di sheet 7) tetap menang.
 */
export const BEBAN_NON_KAS_SALDO_AWAL: readonly { transactionType: string; role: string }[] = [
  { transactionType: 'PENYUSUTAN_ASET', role: 'DEBIT_BEBAN' },
  { transactionType: 'PENYUSUTAN_PROPERTI_INVESTASI', role: 'DEBIT_BEBAN' },
  { transactionType: 'AMORTISASI_ASET_TAK_BERWUJUD', role: 'DEBIT_BEBAN' },
  { transactionType: 'PENYISIHAN_PIUTANG', role: 'DEBIT_BEBAN' },
  { transactionType: 'IMPAIRMENT_INVESTASI', role: 'DEBIT_BEBAN' },
  { transactionType: 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', role: 'DEBIT_BEBAN' },
  { transactionType: 'SIMPANAN_SUKARELA_BUNGA', role: 'DEBIT_BEBAN' },
];

export async function bacaBagianBelumTunaiSaldoAwal(db: SQLite.SQLiteDatabase): Promise<Map<string, Rupiah>> {
  const diatur = await bacaBagianBelumTunaiDiatur(db);
  const peta = new Map<string, Rupiah>();
  for (const [k, v] of diatur) if (v > 0) peta.set(k, v);
  try {
    const akunJasa = await db.getFirstAsync<{ account_id: string }>(
      `SELECT account_id FROM account_mapping WHERE transaction_type = 'ANGSURAN_JASA' AND role = 'KREDIT_PENDAPATAN'`
    );
    const akunPiutang = await db.getFirstAsync<{ account_id: string }>(
      `SELECT account_id FROM account_mapping WHERE transaction_type = 'AKRUAL_JASA_PINJAMAN' AND role = 'DEBIT_PIUTANG_JASA'`
    );
    if (akunJasa && akunPiutang && !diatur.has(akunJasa.account_id)) {
      const pj = await db.getFirstAsync<{ saldo: number }>(`SELECT saldo FROM saldo_awal_akun WHERE account_id = ?`, akunPiutang.account_id);
      const pd = await db.getFirstAsync<{ saldo: number }>(`SELECT saldo FROM saldo_awal_akun WHERE account_id = ?`, akunJasa.account_id);
      if (pj && pd && Number(pj.saldo) > 0 && Number(pd.saldo) > 0) peta.set(akunJasa.account_id, Math.min(Number(pj.saldo), Number(pd.saldo)));
    }
  } catch {
    // pemetaan belum ada: tanpa bawaan
  }
  try {
    for (const m of BEBAN_NON_KAS_SALDO_AWAL) {
      const akun = await db.getFirstAsync<{ account_id: string }>(
        `SELECT account_id FROM account_mapping WHERE transaction_type = ? AND role = ?`,
        m.transactionType,
        m.role
      );
      if (!akun || diatur.has(akun.account_id) || peta.has(akun.account_id)) continue;
      const sa = await db.getFirstAsync<{ saldo: number }>(`SELECT saldo FROM saldo_awal_akun WHERE account_id = ?`, akun.account_id);
      if (sa && Number(sa.saldo) > 0) peta.set(akun.account_id, Number(sa.saldo));
    }
  } catch {
    // pemetaan belum ada: tanpa bawaan
  }
  return peta;
}

export interface RealisasiKasSaldoAwal {
  /** Pendapatan dari saldo awal yang dianggap sudah diterima tunai (net, periode ini). */
  pendapatan: Rupiah;
  /** Beban dari saldo awal yang dianggap sudah dibayar tunai (net, periode ini). */
  beban: Rupiah;
}

/**
 * Jalur 5 `getInformasiShuRAT()`. `kasBankIds` WAJIB tidak kosong
 * (pemanggil sudah menangani kasus tanpa akun kas/bank).
 */
export async function hitungRealisasiKasSaldoAwal(
  db: SQLite.SQLiteDatabase,
  periodeMulai: string,
  periodeSelesai: string,
  kasBankIds: string[]
): Promise<RealisasiKasSaldoAwal> {
  if (kasBankIds.length === 0) return { pendapatan: 0, beban: 0 };
  const phKas = kasBankIds.map(() => '?').join(',');
  const phSumber = SUMBER_JURNAL_SALDO_AWAL.map(() => '?').join(',');
  const perAkun = await db.getAllAsync<{ account_id: string; kategori: string; debit: number; kredit: number }>(
    `SELECT je.account_id, a.kategori, COALESCE(SUM(je.debit),0) AS debit, COALESCE(SUM(je.kredit),0) AS kredit
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     JOIN account a ON a.id = je.account_id
     WHERE j.status IN ('POSTED','REVERSED')
       AND j.tanggal BETWEEN ? AND ?
       AND j.sumber_transaksi IN (${phSumber})
       AND a.kategori IN ('PENDAPATAN','BEBAN')
       AND je.journal_id NOT IN (
         SELECT je2.journal_id FROM journal_entry je2 WHERE je2.account_id IN (${phKas})
       )
     GROUP BY je.account_id, a.kategori`,
    periodeMulai,
    periodeSelesai,
    ...SUMBER_JURNAL_SALDO_AWAL,
    ...kasBankIds
  );
  if (perAkun.length === 0) return { pendapatan: 0, beban: 0 };

  const belumTunai = await bacaBagianBelumTunaiSaldoAwal(db);
  // Bagian belum tunai hanya relevan pada periode yang memuat tanggal
  // saldo awal akun tsb (periode cut-off), bukan periode lain yang
  // kebetulan memuat jurnal koreksinya.
  const tanggalSaldoAwal = new Map<string, string>();
  if (belumTunai.size > 0) {
    const rows = await db.getAllAsync<{ account_id: string; tanggal: string }>(`SELECT account_id, tanggal FROM saldo_awal_akun`);
    for (const r of rows) tanggalSaldoAwal.set(r.account_id, r.tanggal);
  }

  let pendapatan = 0;
  let beban = 0;
  for (const r of perAkun) {
    const net = r.kategori === 'PENDAPATAN' ? Number(r.kredit) - Number(r.debit) : Number(r.debit) - Number(r.kredit);
    const tgl = tanggalSaldoAwal.get(r.account_id);
    const potong = tgl !== undefined && tgl >= periodeMulai && tgl <= periodeSelesai ? belumTunai.get(r.account_id) ?? 0 : 0;
    const tunai = net > 0 ? Math.max(0, net - potong) : net;
    if (r.kategori === 'PENDAPATAN') pendapatan += tunai;
    else beban += tunai;
  }
  return { pendapatan, beban };
}
