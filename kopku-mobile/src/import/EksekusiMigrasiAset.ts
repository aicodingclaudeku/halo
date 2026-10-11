import type * as SQLite from 'expo-sqlite';
import { newId } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import {
  validasiMigrasiAset,
  hitungPenyusutanMasaLalu,
  keteranganMigrasiAset,
  type BarisMigrasiAset,
  type GalatMigrasiAset,
} from '@/import/MigrasiAsetPlan';

/**
 * RC-S107 — EKSEKUSI MIGRASI ASET TETAP.
 *
 * TIDAK mengimpor `AsetService.beliAset`, `createJournal`, maupun
 * pemetaan akun Kas — secara struktural mustahil mengurangi kas.
 * Yang ditulis hanya buku pembantu:
 *   - `aset_tetap` dengan `journal_id` NULL;
 *   - `aset_penyusutan` untuk periode SEBELUM cut-off, merujuk jurnal
 *     SALDO AWAL Akumulasi Penyusutan (lihat MigrasiAsetPlan).
 *
 * Seluruhnya dalam SATU transaksi: aset yang masuk separuh membuat
 * saldo awal Aset Tetap mustahil direkonsiliasi.
 */

export class ValidasiMigrasiAsetGagalError extends Error {
  constructor(public readonly galat: GalatMigrasiAset[]) {
    super(
      `Migrasi aset dibatalkan: ${galat.length} kesalahan pada berkas. ` +
        `Tidak ada satu baris pun yang ditulis ke database.`
    );
    this.name = 'ValidasiMigrasiAsetGagalError';
  }
}

export interface HasilBarisAset {
  baris: number;
  nomorAset: string;
  namaAset: string;
  nilaiPerolehan: Rupiah;
  akumulasiPenyusutan: Rupiah;
  nilaiBuku: Rupiah;
  periodePenyusutanMasaLalu: number;
}

export interface HasilMigrasiAset {
  berhasil: HasilBarisAset[];
  /** Baris yang DILEWATI karena nomor asetnya sudah ada. */
  dilewati: GalatMigrasiAset[];
  totalNilaiPerolehan: Rupiah;
  totalAkumulasiPenyusutan: Rupiah;
}

/** Nomor aset yang sudah terpakai — penjaga import ulang. */
async function nomorAsetTerpakai(db: SQLite.SQLiteDatabase, nomor: string[]): Promise<Set<string>> {
  if (nomor.length === 0) return new Set();
  const tanda = nomor.map(() => '?').join(',');
  const rows = await db.getAllAsync<{ nomor_aset: string }>(
    `SELECT nomor_aset FROM aset_tetap WHERE nomor_aset IN (${tanda})`,
    ...nomor
  );
  return new Set(rows.map((r) => r.nomor_aset.toUpperCase()));
}

/**
 * Hitung hasil TANPA menulis apa pun — dipakai pratinjau dan dipakai
 * ulang oleh eksekusi, supaya angka yang ditampilkan dan angka yang
 * ditulis mustahil berbeda.
 */
export function hitungHasilAset(
  baris: BarisMigrasiAset[],
  tanggalCutOff: string
): { hasil: HasilBarisAset[]; totalNilaiPerolehan: Rupiah; totalAkumulasiPenyusutan: Rupiah } {
  const hasil = baris.map((r) => {
    const p = hitungPenyusutanMasaLalu({
      nilaiPerolehan: r.nilaiPerolehan,
      nilaiResidu: r.nilaiResidu,
      masaManfaatBulan: r.masaManfaatBulan,
      tanggalPerolehan: r.tanggalPerolehan,
      tanggalCutOff,
    });
    return {
      baris: r.baris,
      nomorAset: r.nomorAset,
      namaAset: r.namaAset,
      nilaiPerolehan: r.nilaiPerolehan,
      akumulasiPenyusutan: p.akumulasi,
      nilaiBuku: p.nilaiBuku,
      periodePenyusutanMasaLalu: p.periode.length,
    };
  });
  return {
    hasil,
    totalNilaiPerolehan: hasil.reduce((t, h) => t + h.nilaiPerolehan, 0),
    totalAkumulasiPenyusutan: hasil.reduce((t, h) => t + h.akumulasiPenyusutan, 0),
  };
}

/**
 * Tulis aset ke buku pembantu. `journalIdAkumulasi` adalah jurnal saldo
 * awal Akumulasi Penyusutan; bila null, periode penyusutan masa lalu
 * TIDAK dicatat dan hal itu dilaporkan — lebih baik penyusutan
 * mengejar ketertinggalan (yang terlihat) daripada menulis baris
 * penyusutan tanpa rujukan jurnal (yang tidak bisa direkonsiliasi).
 */
export async function jalankanMigrasiAset(
  db: SQLite.SQLiteDatabase,
  baris: BarisMigrasiAset[],
  opsi: { tanggalCutOff: string; createdBy: string; journalIdAkumulasi: string | null }
): Promise<HasilMigrasiAset> {
  const galat = validasiMigrasiAset(baris, { tanggalCutOff: opsi.tanggalCutOff });
  if (galat.length > 0) throw new ValidasiMigrasiAsetGagalError(galat);

  const terpakai = await nomorAsetTerpakai(db, baris.map((r) => r.nomorAset.trim()));
  const dilewati: GalatMigrasiAset[] = [];
  const akanDiproses: BarisMigrasiAset[] = [];
  for (const r of baris) {
    if (terpakai.has(r.nomorAset.trim().toUpperCase())) {
      dilewati.push({
        baris: r.baris,
        kode: 'NOMOR_ASET_GANDA',
        pesan: `Nomor Aset "${r.nomorAset}" sudah pernah diimpor. Baris dilewati — datanya TIDAK diubah.`,
      });
      continue;
    }
    akanDiproses.push(r);
  }

  const { hasil, totalNilaiPerolehan, totalAkumulasiPenyusutan } = hitungHasilAset(
    akanDiproses,
    opsi.tanggalCutOff
  );
  const now = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    for (const r of akanDiproses) {
      const asetId = newId();
      await db.runAsync(
        `INSERT INTO aset_tetap
          (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan,
           tanggal_perolehan, metode_pembayaran, sumber, keterangan, journal_id,
           created_by, created_at, kelompok_aset, sub_kelompok_aset, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'AKTIF')`,
        asetId,
        r.nomorAset.trim(),
        r.namaAset.trim(),
        r.nilaiPerolehan,
        r.nilaiResidu,
        r.masaManfaatBulan,
        r.tanggalPerolehan,
        'TUNAI',
        'PEMBELIAN',
        keteranganMigrasiAset(opsi.tanggalCutOff),
        // journal_id NULL — INI INTINYA: tidak ada jurnal pembelian,
        // jadi kas mustahil berkurang.
        null,
        opsi.createdBy,
        now,
        r.kelompokAset ?? null,
        r.subKelompokAset ?? null
      );

      if (!opsi.journalIdAkumulasi) continue;
      const p = hitungPenyusutanMasaLalu({
        nilaiPerolehan: r.nilaiPerolehan,
        nilaiResidu: r.nilaiResidu,
        masaManfaatBulan: r.masaManfaatBulan,
        tanggalPerolehan: r.tanggalPerolehan,
        tanggalCutOff: opsi.tanggalCutOff,
      });
      let sisa = p.akumulasi;
      for (let i = 0; i < p.periode.length; i++) {
        const periode = p.periode[i];
        const terakhir = i === p.periode.length - 1;
        const nilai = terakhir ? sisa : Math.min(p.nilaiPerPeriode, sisa);
        sisa -= nilai;
        await db.runAsync(
          `INSERT INTO aset_penyusutan (id, aset_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          newId(),
          asetId,
          periode,
          akhirBulan(periode),
          nilai,
          // Merujuk jurnal SALDO AWAL Akumulasi Penyusutan: jurnal
          // itulah yang memang memuat kredit sebesar penyusutan masa
          // lalu ini, sehingga buku pembantu dan buku besar cocok.
          opsi.journalIdAkumulasi,
          opsi.createdBy,
          now
        );
      }
    }
  });

  return { berhasil: hasil, dilewati, totalNilaiPerolehan, totalAkumulasiPenyusutan };
}

/** Tanggal terakhir sebuah periode 'YYYY-MM'. */
function akhirBulan(periode: string): string {
  const [y, m] = periode.split('-').map(Number);
  const hari = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${periode}-${String(hari).padStart(2, '0')}`;
}
