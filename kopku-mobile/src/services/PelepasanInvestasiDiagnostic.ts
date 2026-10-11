import * as SQLite from 'expo-sqlite';
import { resolveAccountId } from '@/accounting/AccountMapping';

/**
 * RC-S54 TAHAP 16 — ITEM #20: DIAGNOSTIK HISTORI PELEPASAN INVESTASI. READ-ONLY.
 *
 * Mencakup dua jalur keluar investasi:
 *  - DIBATALKAN (KOREKSI_SALAH_INPUT, termasuk "Jual Kembali"/"Cairkan" pra-#20 yang hanya
 *    membalik jurnal penempatan) — seharusnya tidak meninggalkan saldo apa pun;
 *  - DILEPAS    (PELEPASAN_INVESTASI) — jurnal pelepasan harus seimbang, cocok dengan register,
 *    membersihkan akun aset & kontra per investasi, dan laba/rugi = hasil − nilai tercatat.
 *
 * Kode temuan:
 *  - ASET_DILEPAS_AKUMULASI_PENYUSUTAN_TERSISA : saldo 1-1670 milik investasi yang keluar ≠ 0
 *  - ASET_DILEPAS_IMPAIRMENT_TERSISA           : saldo 1-1900 milik investasi yang keluar ≠ 0
 *  - CARRYING_AMOUNT_MISMATCH                  : nilai tercatat ledger per investasi ≠ seharusnya
 *  - JOURNAL_MISMATCH                          : status investasi vs jurnal penempatan/pelepasan, atau jurnal register tidak POSTED / ≠ register
 *  - JURNAL_PELEPASAN_TIDAK_SEIMBANG           : Σ debit ≠ Σ kredit jurnal pelepasan
 *  - JURNAL_PELEPASAN_TIDAK_COCOK_REGISTER     : baris kontra/aset jurnal pelepasan ≠ register/biaya
 *  - GAIN_LOSS_MISMATCH                        : laba/rugi tercatat ≠ hasil − nilai tercatat
 *    (untuk DIBATALKAN berlifecycle: laba/rugi tidak tercatat sama sekali; hasil tidak diketahui)
 *
 * Data warisan TIDAK ditebak (hasil, tanggal, laba/rugi): setiap baris bertemuan hanya diberi
 * `tindakanKoreksi = 'MANUAL_REVIEW'` dan `estimasiSelisih` (ledger − seharusnya).
 * Tidak ada INSERT/UPDATE/DELETE, jurnal, perubahan status, atau migration.
 */

export type KodeTemuanPelepasanInvestasi =
  | 'ASET_DILEPAS_AKUMULASI_PENYUSUTAN_TERSISA'
  | 'ASET_DILEPAS_IMPAIRMENT_TERSISA'
  | 'JOURNAL_MISMATCH'
  | 'CARRYING_AMOUNT_MISMATCH'
  | 'GAIN_LOSS_MISMATCH'
  | 'JURNAL_PELEPASAN_TIDAK_SEIMBANG'
  | 'JURNAL_PELEPASAN_TIDAK_COCOK_REGISTER';

export interface BarisDiagnostikPelepasan {
  readonly investasiId: string;
  readonly nomorInvestasi: string;
  readonly jenisInvestasi: string;
  readonly status: string;
  readonly biayaPerolehan: number;
  readonly akumulasiPenyusutan: number;
  readonly akumulasiImpairment: number;
  readonly nilaiTercatatSeharusnya: number;
  readonly nilaiTercatatLedger: number;
  readonly estimasiSelisih: number;
  readonly journalPelepasanId: string | null;
  readonly temuan: readonly { kode: KodeTemuanPelepasanInvestasi; keterangan: string; nilai: number }[];
  readonly tindakanKoreksi: 'MANUAL_REVIEW' | null;
  readonly koreksiDeterministik: false;
}

export interface DiagnostikPelepasanInvestasi {
  readonly baris: readonly BarisDiagnostikPelepasan[];
  readonly ringkasan: Readonly<Record<KodeTemuanPelepasanInvestasi, number>>;
  /** Jumlah investasi yang memerlukan MANUAL_REVIEW. */
  readonly jumlahKandidat: number;
}

interface JurnalRingkas {
  id: string;
  status: string;
  reversed_by_id: string | null;
}

export async function diagnosaHistoriPelepasanPropertiInvestasi(db: SQLite.SQLiteDatabase): Promise<DiagnostikPelepasanInvestasi> {
  const akunAkumulasi = await resolveAccountId(db, 'PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI');
  const akunPenyisihan = await resolveAccountId(db, 'IMPAIRMENT_INVESTASI', 'KREDIT_PENYISIHAN');

  const investasi = await db.getAllAsync<{ id: string; nomor_investasi: string; jenis_investasi: string; status: string; jumlah: number; journal_id: string | null }>(
    `SELECT id, nomor_investasi, jenis_investasi, status, jumlah, journal_id FROM investasi ORDER BY tanggal, id`
  );
  const jurnal = async (id: string | null): Promise<JurnalRingkas | null> =>
    id ? db.getFirstAsync<JurnalRingkas>(`SELECT id, status, reversed_by_id FROM journal WHERE id = ?`, id) : null;
  const barisAkun = async (journalId: string, accountId: string) =>
    (await db.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      journalId, accountId
    )) ?? { d: 0, k: 0 };

  const baris: BarisDiagnostikPelepasan[] = [];
  const ringkasan: Record<KodeTemuanPelepasanInvestasi, number> = {
    ASET_DILEPAS_AKUMULASI_PENYUSUTAN_TERSISA: 0,
    ASET_DILEPAS_IMPAIRMENT_TERSISA: 0,
    JOURNAL_MISMATCH: 0,
    CARRYING_AMOUNT_MISMATCH: 0,
    GAIN_LOSS_MISMATCH: 0,
    JURNAL_PELEPASAN_TIDAK_SEIMBANG: 0,
    JURNAL_PELEPASAN_TIDAK_COCOK_REGISTER: 0,
  };

  for (const inv of investasi) {
    const temuan: { kode: KodeTemuanPelepasanInvestasi; keterangan: string; nilai: number }[] = [];
    const tambah = (kode: KodeTemuanPelepasanInvestasi, keterangan: string, nilai: number) => {
      temuan.push({ kode, keterangan, nilai });
      ringkasan[kode] += 1;
    };
    const dibatalkan = inv.status === 'DIBATALKAN';
    const dilepas = inv.status === 'DILEPAS';

    // --- Penempatan: akun aset = baris debit jurnal penempatan.
    let akunAset: string | null = null;
    let nilaiAsetLedger = 0;
    const jPenempatan = await jurnal(inv.journal_id);
    if (jPenempatan) {
      const debit = await db.getFirstAsync<{ account_id: string }>(
        `SELECT account_id FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC LIMIT 1`,
        jPenempatan.id
      );
      if (debit) {
        akunAset = debit.account_id;
        const asal = await barisAkun(jPenempatan.id, akunAset);
        nilaiAsetLedger += asal.d - asal.k;
        const jBalik = await jurnal(jPenempatan.reversed_by_id);
        if (jBalik && (jBalik.status === 'POSTED' || jBalik.status === 'REVERSED')) {
          const balik = await barisAkun(jBalik.id, akunAset);
          nilaiAsetLedger += balik.d - balik.k;
        }
      }
    }
    const penempatanCocok = dibatalkan ? jPenempatan?.status === 'REVERSED' : jPenempatan?.status === 'POSTED';
    if (!penempatanCocok) {
      tambah('JOURNAL_MISMATCH', `status investasi ${inv.status} tetapi jurnal penempatan ${jPenempatan?.status ?? 'tidak ada'}`, 0);
    }

    // --- Register penyusutan & impairment.
    let penyusutan = 0;
    let penyusutanLedger = 0;
    for (const r of await db.getAllAsync<{ nilai_penyusutan: number; journal_id: string }>(
      `SELECT nilai_penyusutan, journal_id FROM investasi_penyusutan WHERE investasi_id = ? ORDER BY periode`, inv.id
    )) {
      penyusutan += r.nilai_penyusutan;
      const j = await jurnal(r.journal_id);
      const e = j ? await barisAkun(j.id, akunAkumulasi) : { d: 0, k: 0 };
      if (!j || j.status !== 'POSTED' || e.k - e.d !== r.nilai_penyusutan) {
        tambah('JOURNAL_MISMATCH', `jurnal penyusutan ${r.journal_id} tidak POSTED atau ≠ register`, r.nilai_penyusutan);
      }
      if (j && (j.status === 'POSTED' || j.status === 'REVERSED')) penyusutanLedger += e.k - e.d;
    }
    let impairment = 0;
    let impairmentLedger = 0;
    for (const r of await db.getAllAsync<{ nilai_impairment: number; journal_id: string }>(
      `SELECT nilai_impairment, journal_id FROM investasi_impairment WHERE investasi_id = ? ORDER BY tanggal, id`, inv.id
    )) {
      impairment += r.nilai_impairment;
      const j = await jurnal(r.journal_id);
      const e = j ? await barisAkun(j.id, akunPenyisihan) : { d: 0, k: 0 };
      if (!j || j.status !== 'POSTED' || e.k - e.d !== r.nilai_impairment) {
        tambah('JOURNAL_MISMATCH', `jurnal impairment ${r.journal_id} tidak POSTED atau ≠ register`, r.nilai_impairment);
      }
      if (j && (j.status === 'POSTED' || j.status === 'REVERSED')) impairmentLedger += e.k - e.d;
    }

    // --- Jurnal pelepasan (#20).
    const jPelepasanList = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM journal WHERE sumber_transaksi = 'PELEPASAN_INVESTASI' AND sumber_id = ? AND status = 'POSTED' ORDER BY id`,
      inv.id
    );
    const jPelepasanId = jPelepasanList[0]?.id ?? null;
    if (jPelepasanList.length > 1) tambah('JOURNAL_MISMATCH', `${jPelepasanList.length} jurnal pelepasan untuk satu investasi`, jPelepasanList.length);
    if (dilepas && !jPelepasanId) tambah('JOURNAL_MISMATCH', 'status DILEPAS tanpa jurnal pelepasan POSTED', 0);
    if (!dilepas && jPelepasanId) tambah('JOURNAL_MISMATCH', `jurnal pelepasan ada tetapi status investasi ${inv.status}`, 0);

    if (jPelepasanId) {
      const tot = (await db.getFirstAsync<{ d: number; k: number }>(
        `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k FROM journal_entry WHERE journal_id = ?`, jPelepasanId
      )) ?? { d: 0, k: 0 };
      if (tot.d !== tot.k) tambah('JURNAL_PELEPASAN_TIDAK_SEIMBANG', `debit ${tot.d} ≠ kredit ${tot.k}`, tot.d - tot.k);
      const eAkm = await barisAkun(jPelepasanId, akunAkumulasi);
      const eImp = await barisAkun(jPelepasanId, akunPenyisihan);
      const eAset = akunAset ? await barisAkun(jPelepasanId, akunAset) : { d: 0, k: 0 };
      penyusutanLedger -= eAkm.d - eAkm.k;
      impairmentLedger -= eImp.d - eImp.k;
      nilaiAsetLedger += eAset.d - eAset.k;
      if (eAkm.d - eAkm.k !== penyusutan || eImp.d - eImp.k !== impairment || eAset.k - eAset.d !== inv.jumlah) {
        tambah('JURNAL_PELEPASAN_TIDAK_COCOK_REGISTER', `kontra ${eAkm.d - eAkm.k}/${eImp.d - eImp.k}, aset ${eAset.k - eAset.d} vs register ${penyusutan}/${impairment}, biaya ${inv.jumlah}`, 0);
      }
      const hasil = tot.d - (eAkm.d + eImp.d) ;
      const labaTercatat = tot.k - (eAset.k + eAkm.k + eImp.k);
      const labaSeharusnya = hasil - (inv.jumlah - penyusutan - impairment);
      if (labaTercatat !== labaSeharusnya) {
        tambah('GAIN_LOSS_MISMATCH', `laba/rugi tercatat ${labaTercatat} ≠ hasil ${hasil} − nilai tercatat ${inv.jumlah - penyusutan - impairment}`, labaTercatat - labaSeharusnya);
      }
    }

    const keluar = dibatalkan || dilepas;
    if (keluar && penyusutanLedger !== 0) {
      tambah('ASET_DILEPAS_AKUMULASI_PENYUSUTAN_TERSISA', 'akumulasi penyusutan investasi yang sudah keluar masih bersaldo', penyusutanLedger);
    }
    if (keluar && impairmentLedger !== 0) {
      tambah('ASET_DILEPAS_IMPAIRMENT_TERSISA', 'penyisihan penurunan nilai investasi yang sudah keluar masih bersaldo', impairmentLedger);
    }
    const seharusnya = keluar ? 0 : inv.jumlah - penyusutan - impairment;
    const ledger = nilaiAsetLedger - penyusutanLedger - impairmentLedger;
    if (ledger !== seharusnya) {
      tambah('CARRYING_AMOUNT_MISMATCH', `nilai tercatat ledger ${ledger} ≠ seharusnya ${seharusnya}`, ledger - seharusnya);
    }
    if (dibatalkan && penyusutan + impairment > 0) {
      tambah('GAIN_LOSS_MISMATCH', 'keluar lewat koreksi/pembalikan tanpa jurnal laba/rugi; hasil sebenarnya tidak diketahui (tidak ditebak)', penyusutan + impairment);
    }

    baris.push({
      investasiId: inv.id,
      nomorInvestasi: inv.nomor_investasi,
      jenisInvestasi: inv.jenis_investasi,
      status: inv.status,
      biayaPerolehan: inv.jumlah,
      akumulasiPenyusutan: penyusutan,
      akumulasiImpairment: impairment,
      nilaiTercatatSeharusnya: seharusnya,
      nilaiTercatatLedger: ledger,
      estimasiSelisih: ledger - seharusnya,
      journalPelepasanId: jPelepasanId,
      temuan,
      tindakanKoreksi: temuan.length > 0 ? 'MANUAL_REVIEW' : null,
      koreksiDeterministik: false,
    });
  }
  return { baris, ringkasan, jumlahKandidat: baris.filter((b) => b.tindakanKoreksi).length };
}
