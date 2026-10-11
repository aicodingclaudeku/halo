import * as SQLite from 'expo-sqlite';
import { Rupiah } from '@/utils/money';

/**
 * ============================================================
 * DIAGNOSTIK HISTORIS RAK — RC-S54 TAHAP 13 (ITEM #19). READ-ONLY.
 * ============================================================
 *
 * Memeriksa rantai: baris `rak_transaksi` → jurnal asal → (Tarik Dana RAK)
 * → jurnal pembalik → saldo akun RAK. TIDAK ADA INSERT/UPDATE/DELETE di
 * berkas ini dan TIDAK ADA koreksi otomatis: setiap temuan membawa flag
 * `deterministik` dan usulan tindakan, keputusan koreksi tetap manual.
 *
 * Tautan yang dipakai (seluruhnya sudah ada di skema, tanpa tebakan):
 *   rak_transaksi.journal_id  → journal.id                (jurnal asal)
 *   journal.reversed_by_id    → journal.id                (pembalik)
 *   journal.reversal_of_id    → journal.id                (arah balik)
 *   rak_transaksi.reversal_of_id → rak_transaksi.id       (baris hasil EDIT)
 *   audit_log(entity='rak_transaksi', action='REVERSE')    (alasan, T13: keterangan asal)
 */

export type KodeDiagnosaRAK =
  | 'BALANCED'
  | 'GAP'
  | 'DUPLICATE_REVERSAL'
  | 'MISSING_SOURCE'
  | 'ORPHAN_REVERSAL'
  | 'OUTSTANDING_MISMATCH'
  | 'JOURNAL_MISMATCH'
  | 'PERIOD_MISMATCH'
  | 'HISTORICAL_GAP';

export interface TemuanRAK {
  readonly kode: Exclude<KodeDiagnosaRAK, 'BALANCED'>;
  readonly rakId: string | null;
  readonly nomorRak: string | null;
  readonly journalId: string | null;
  readonly detail: string;
  /** true = fakta pasti dari tautan skema; false = indikasi, butuh verifikasi manusia. */
  readonly deterministik: boolean;
}

export interface DiagnosaBarisRAK {
  readonly rakId: string;
  readonly nomorRak: string;
  readonly status: string;
  readonly jumlah: Rupiah;
  readonly kode: readonly KodeDiagnosaRAK[];
  readonly temuan: readonly TemuanRAK[];
}

export interface HasilDiagnosaRAK {
  readonly baris: readonly DiagnosaBarisRAK[];
  /** Temuan tingkat jurnal/buku besar yang tidak menempel pada satu baris RAK. */
  readonly temuanJurnal: readonly TemuanRAK[];
  readonly saldo: {
    readonly akunRakId: string | null;
    readonly saldoGl: Rupiah | null;
    /** Σ jumlah baris AKTIF. */
    readonly outstandingSubledger: Rupiah;
    /** Bagian saldo GL dari jurnal non-RAK (mis. saldo awal, jurnal manual). */
    readonly saldoGlSumberLain: Rupiah | null;
    /** saldoGl − saldoGlSumberLain − outstandingSubledger. 0 = cocok. */
    readonly selisihTidakTerjelaskan: Rupiah | null;
    /** Saldo kumulatif terendah dari jurnal bersumber RAK saja, beserta tanggalnya. */
    readonly saldoRakTerendah: { readonly tanggal: string; readonly saldo: Rupiah } | null;
  };
  readonly ringkasan: {
    readonly jumlahBaris: number;
    readonly balanced: number;
    readonly perKode: Readonly<Record<string, number>>;
  };
  readonly koreksiOtomatis: false;
  readonly alasanTanpaKoreksiOtomatis: string;
}

interface JurnalRow {
  id: string;
  tanggal: string;
  status: string;
  sumber_transaksi: string;
  reversal_of_id: string | null;
  reversed_by_id: string | null;
  period_id: string;
  periode_mulai: string | null;
  periode_selesai: string | null;
}

type Entri = { account_id: string; debit: number; kredit: number };

function netPerAkun(entri: readonly Entri[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entri) m.set(e.account_id, (m.get(e.account_id) ?? 0) + e.debit - e.kredit);
  return m;
}

function cerminanTepat(asal: readonly Entri[], pembalik: readonly Entri[]): boolean {
  const a = netPerAkun(asal);
  const b = netPerAkun(pembalik);
  const kunci = new Set([...a.keys(), ...b.keys()]);
  for (const k of kunci) if ((a.get(k) ?? 0) + (b.get(k) ?? 0) !== 0) return false;
  return true;
}

export async function diagnosaHistoriRAK(db: SQLite.SQLiteDatabase): Promise<HasilDiagnosaRAK> {
  const mapping = await db.getFirstAsync<{ account_id: string }>(
    `SELECT account_id FROM account_mapping WHERE transaction_type = 'RAK' AND role = 'DEBIT_ASET'`
  );
  const akunRakId = mapping?.account_id ?? null;

  const jurnalSemua = await db.getAllAsync<JurnalRow>(
    `SELECT j.id, j.tanggal, j.status, j.sumber_transaksi, j.reversal_of_id, j.reversed_by_id, j.period_id,
            ap.periode_mulai, ap.periode_selesai
       FROM journal j LEFT JOIN accounting_period ap ON ap.id = j.period_id
      WHERE j.sumber_transaksi = 'RAK'
         OR j.id IN (SELECT journal_id FROM rak_transaksi WHERE journal_id IS NOT NULL)
         OR j.reversal_of_id IN (SELECT journal_id FROM rak_transaksi WHERE journal_id IS NOT NULL)`
  );
  const jurnalById = new Map(jurnalSemua.map((j) => [j.id, j]));
  const entriCache = new Map<string, Entri[]>();
  const entri = async (journalId: string): Promise<Entri[]> => {
    const ada = entriCache.get(journalId);
    if (ada) return ada;
    const rows = await db.getAllAsync<Entri>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    entriCache.set(journalId, rows);
    return rows;
  };

  const rakRows = await db.getAllAsync<{
    id: string; nomor_rak: string; status: string; jumlah: number; tanggal: string; keterangan: string | null;
    journal_id: string | null; reversal_of_id: string | null; unit_usaha_id: string | null; jenis_alokasi: string | null;
  }>(
    `SELECT id, nomor_rak, status, jumlah, tanggal, keterangan, journal_id, reversal_of_id, unit_usaha_id, jenis_alokasi
       FROM rak_transaksi ORDER BY tanggal, created_at`
  );
  const rakById = new Map(rakRows.map((r) => [r.id, r]));
  const journalIdSumber = new Set(rakRows.map((r) => r.journal_id).filter((x): x is string => !!x));

  const auditReverse = await db.getAllAsync<{ entity_id: string; data_sesudah: string | null }>(
    `SELECT entity_id, data_sesudah FROM audit_log WHERE entity = 'rak_transaksi' AND action = 'REVERSE'
      ORDER BY created_at, rowid`
  );
  const auditPerRak = new Map<string, Record<string, unknown>[]>();
  for (const a of auditReverse) {
    let data: Record<string, unknown> = {};
    try {
      data = a.data_sesudah ? (JSON.parse(a.data_sesudah) as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    auditPerRak.set(a.entity_id, [...(auditPerRak.get(a.entity_id) ?? []), data]);
  }

  const baris: DiagnosaBarisRAK[] = [];
  for (const r of rakRows) {
    const t: TemuanRAK[] = [];
    const tambah = (kode: TemuanRAK['kode'], detail: string, deterministik = true, journalId: string | null = r.journal_id) =>
      t.push({ kode, rakId: r.id, nomorRak: r.nomor_rak, journalId, detail, deterministik });

    const asal = r.journal_id ? jurnalById.get(r.journal_id) : undefined;
    if (!r.journal_id || !asal) {
      tambah('JOURNAL_MISMATCH', r.journal_id ? 'Jurnal asal yang dirujuk tidak ada.' : 'Baris RAK tidak mempunyai jurnal asal.');
    } else {
      const eAsal = await entri(asal.id);
      const totalD = eAsal.reduce((s, e) => s + e.debit, 0);
      const totalK = eAsal.reduce((s, e) => s + e.kredit, 0);
      const debitRak = akunRakId ? eAsal.filter((e) => e.account_id === akunRakId).reduce((s, e) => s + e.debit - e.kredit, 0) : null;
      if (asal.sumber_transaksi !== 'RAK') tambah('JOURNAL_MISMATCH', `Sumber jurnal asal ${asal.sumber_transaksi}, bukan RAK.`);
      if (totalD !== totalK) tambah('JOURNAL_MISMATCH', `Jurnal asal tidak seimbang (D ${totalD} ≠ K ${totalK}).`);
      if (totalD !== r.jumlah) tambah('JOURNAL_MISMATCH', `Nominal jurnal asal ${totalD} ≠ jumlah RAK ${r.jumlah}.`);
      if (debitRak !== null && debitRak !== r.jumlah) {
        tambah('JOURNAL_MISMATCH', `Debit bersih akun RAK pada jurnal asal ${debitRak} ≠ jumlah RAK ${r.jumlah}.`);
      }
      if (asal.tanggal !== r.tanggal) tambah('PERIOD_MISMATCH', `Tanggal jurnal asal ${asal.tanggal} ≠ tanggal RAK ${r.tanggal}.`);

      const pembalik = jurnalSemua.filter((j) => j.reversal_of_id === asal.id);
      if (pembalik.length > 1) {
        tambah('DUPLICATE_REVERSAL', `${pembalik.length} jurnal pembalik untuk satu jurnal asal: ${pembalik.map((p) => p.id).join(', ')}.`);
      }

      if (r.status === 'AKTIF' && (asal.status !== 'POSTED' || pembalik.length > 0)) {
        tambah('OUTSTANDING_MISMATCH', `Baris AKTIF (masih tertanam), tetapi jurnal asal berstatus ${asal.status} dengan ${pembalik.length} pembalik.`);
      }
      if (r.status === 'DIBATALKAN' && pembalik.length === 0) {
        tambah('GAP', `Baris DIBATALKAN (dana ditarik), tetapi jurnal asal berstatus ${asal.status} tanpa jurnal pembalik — saldo RAK di buku besar masih memuat ${r.jumlah}.`);
      }
      if (r.status === 'DIBATALKAN' && pembalik.length > 0 && asal.status !== 'REVERSED') {
        tambah('JOURNAL_MISMATCH', `Ada jurnal pembalik, tetapi status jurnal asal ${asal.status}, bukan REVERSED.`);
      }
      if (pembalik.length > 0 && asal.reversed_by_id && !pembalik.some((p) => p.id === asal.reversed_by_id)) {
        tambah('JOURNAL_MISMATCH', `reversed_by_id jurnal asal (${asal.reversed_by_id}) tidak menunjuk pembalik mana pun.`);
      }

      for (const p of pembalik) {
        const eP = await entri(p.id);
        if (!cerminanTepat(eAsal, eP)) {
          tambah('JOURNAL_MISMATCH', 'Jurnal pembalik bukan cerminan tepat jurnal asal (nilai/akun/arah berbeda).', true, p.id);
        }
        if (p.tanggal < asal.tanggal) {
          tambah('PERIOD_MISMATCH', `Jurnal pembalik (${p.tanggal}) mendahului jurnal asal (${asal.tanggal}).`, true, p.id);
        }
        if (p.periode_mulai && p.periode_selesai && (p.tanggal < p.periode_mulai || p.tanggal > p.periode_selesai)) {
          tambah('PERIOD_MISMATCH', `Tanggal jurnal pembalik ${p.tanggal} di luar periode ${p.period_id}.`, true, p.id);
        }
      }

      // HISTORICAL_GAP (a): sebelum T13 `keterangan` asal ditimpa alasan pembatalan.
      if (r.status === 'DIBATALKAN') {
        const audit = auditPerRak.get(r.id) ?? [];
        const adaKeteranganAsal = audit.some((a) => Object.prototype.hasOwnProperty.call(a, 'keteranganAsal'));
        if (!adaKeteranganAsal) {
          tambah(
            'HISTORICAL_GAP',
            'Tarik Dana/koreksi dilakukan sebelum RC-S54 T13: keterangan asal kemungkinan tertimpa alasan pembatalan. ' +
              'Deskripsi jurnal asal dapat dipakai sebagai petunjuk, tetapi tidak dapat dipastikan sama dengan keterangan asal.',
            false
          );
        }
      }
    }

    // HISTORICAL_GAP (b): baris hasil EDIT sebelum T13 kehilangan kolom RAKU.
    if (r.reversal_of_id) {
      const pendahulu = rakById.get(r.reversal_of_id);
      if (!pendahulu) {
        tambah('MISSING_SOURCE', `Baris hasil edit menunjuk baris RAK asal ${r.reversal_of_id} yang tidak ada.`, true, null);
      } else if (
        (pendahulu.unit_usaha_id !== null || pendahulu.jenis_alokasi !== null) &&
        r.unit_usaha_id === null && r.jenis_alokasi === null
      ) {
        tambah(
          'HISTORICAL_GAP',
          `Baris hasil edit tanpa unit usaha/jenis alokasi, padahal baris asal ${pendahulu.nomor_rak} memilikinya — ` +
            'kemungkinan hilang oleh bug edit sebelum T13; tidak dapat dipastikan bukan perubahan yang disengaja.',
          false,
          null
        );
      }
    }

    baris.push({
      rakId: r.id,
      nomorRak: r.nomor_rak,
      status: r.status,
      jumlah: r.jumlah,
      kode: t.length === 0 ? ['BALANCED'] : [...new Set(t.map((x) => x.kode))],
      temuan: t,
    });
  }

  // Temuan tingkat jurnal.
  const temuanJurnal: TemuanRAK[] = [];
  for (const j of jurnalSemua) {
    if (j.sumber_transaksi !== 'RAK') continue;
    if (j.reversal_of_id) {
      if (!journalIdSumber.has(j.reversal_of_id)) {
        temuanJurnal.push({
          kode: 'ORPHAN_REVERSAL', rakId: null, nomorRak: null, journalId: j.id, deterministik: true,
          detail: `Jurnal pembalik RAK menunjuk jurnal ${j.reversal_of_id} yang bukan jurnal asal baris RAK mana pun.`,
        });
      }
    } else if (!journalIdSumber.has(j.id)) {
      temuanJurnal.push({
        kode: 'MISSING_SOURCE', rakId: null, nomorRak: null, journalId: j.id, deterministik: true,
        detail: 'Jurnal bersumber RAK tanpa baris rak_transaksi.',
      });
    }
  }

  // Saldo & subledger.
  const outstandingSubledger = rakRows.filter((r) => r.status === 'AKTIF').reduce((s, r) => s + r.jumlah, 0);
  let saldoGl: Rupiah | null = null;
  let saldoGlSumberLain: Rupiah | null = null;
  let selisih: Rupiah | null = null;
  let saldoRakTerendah: { tanggal: string; saldo: Rupiah } | null = null;
  if (akunRakId) {
    const g = await db.getFirstAsync<{ semua: number; lain: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit), 0) AS semua,
              COALESCE(SUM(CASE WHEN j.sumber_transaksi <> 'RAK' THEN je.debit - je.kredit ELSE 0 END), 0) AS lain
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
      akunRakId
    );
    saldoGl = g?.semua ?? 0;
    saldoGlSumberLain = g?.lain ?? 0;
    selisih = saldoGl - saldoGlSumberLain - outstandingSubledger;
    if (selisih !== 0) {
      temuanJurnal.push({
        kode: 'OUTSTANDING_MISMATCH', rakId: null, nomorRak: null, journalId: null, deterministik: true,
        detail: `Saldo GL akun RAK dari jurnal RAK (${saldoGl - saldoGlSumberLain}) ≠ Σ baris AKTIF (${outstandingSubledger}).`,
      });
    }
    const harian = await db.getAllAsync<{ tanggal: string; mutasi: number }>(
      `SELECT j.tanggal, SUM(je.debit - je.kredit) AS mutasi
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') AND j.sumber_transaksi = 'RAK'
        GROUP BY j.tanggal ORDER BY j.tanggal`,
      akunRakId
    );
    let jalan = 0;
    for (const h of harian) {
      jalan += h.mutasi;
      if (saldoRakTerendah === null || jalan < saldoRakTerendah.saldo) saldoRakTerendah = { tanggal: h.tanggal, saldo: jalan };
    }
    if (saldoRakTerendah && saldoRakTerendah.saldo < 0) {
      temuanJurnal.push({
        kode: 'PERIOD_MISMATCH', rakId: null, nomorRak: null, journalId: null, deterministik: true,
        detail: `Saldo kumulatif akun RAK dari jurnal RAK negatif (${saldoRakTerendah.saldo}) pada ${saldoRakTerendah.tanggal} — pembalik tercatat sebelum transaksi asalnya.`,
      });
    }
  }

  const perKode: Record<string, number> = {};
  for (const b of baris) for (const k of b.kode) perKode[k] = (perKode[k] ?? 0) + 1;
  for (const tj of temuanJurnal) perKode[tj.kode] = (perKode[tj.kode] ?? 0) + 1;

  return {
    baris,
    temuanJurnal,
    saldo: {
      akunRakId,
      saldoGl,
      outstandingSubledger,
      saldoGlSumberLain,
      selisihTidakTerjelaskan: selisih,
      saldoRakTerendah,
    },
    ringkasan: {
      jumlahBaris: baris.length,
      balanced: baris.filter((b) => b.kode.length === 1 && b.kode[0] === 'BALANCED').length,
      perKode,
    },
    koreksiOtomatis: false,
    alasanTanpaKoreksiOtomatis:
      'Belum ada aturan identifikasi deterministik yang disetujui untuk mengoreksi histori RAK. ' +
      'Temuan hanya dilaporkan; koreksi dilakukan lewat jurnal baru bertanggal setelah keputusan.',
  };
}
