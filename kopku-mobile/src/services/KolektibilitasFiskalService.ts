import * as SQLite from 'expo-sqlite';
import { getDb } from '@/database/db';
import { Rupiah, roundToRupiah } from '@/utils/money';
import {
  GetKlasifikasiOpts,
  Kolektibilitas,
  KlasifikasiPinjamanItem,
  getKlasifikasiPinjamanAktif,
} from '@/services/LoanImpairmentService';

/**
 * KolektibilitasFiskalService — lapisan pelaporan PMK 74/2024
 * (Peraturan Menteri Keuangan tentang Pembentukan Cadangan Piutang
 * Tak Tertagih), KHUSUS baris Koperasi Simpan Pinjam (Ps.7 & Lampiran).
 *
 * KENAPA MODUL TERPISAH (bukan mengubah `LoanImpairmentService.ts`):
 * cadangan BUKU (SAK EP, `PERSENTASE_CADANGAN`/`hitungCadangan` di
 * LoanImpairmentService) dan cadangan FISKAL (batas maksimum yang
 * diakui fiskus sebagai pengurang penghasilan bruto) adalah DUA
 * kebijakan berbeda yang lazim menghasilkan angka berbeda — selisihnya
 * itulah koreksi fiskal di SPT Badan. Menyatukan keduanya dalam satu
 * fungsi akan membuat salah satu tidak terlihat lagi. Mesin aging
 * (hari tunggakan, saldo pokok, saldo piutang) TETAP SATU — dipakai
 * dari `getKlasifikasiPinjamanAktif()` yang sudah ada, TIDAK ADA
 * perhitungan aging kedua di sini.
 *
 * PASCA-PERALIHAN KE SOM Juklat 3/2025: kategori buku sekarang SAMA
 * PERSIS dengan kategori fiskal (Lancar / Kurang Lancar / Diragukan /
 * Macet) — dulu tidak, karena skema buku lama punya kategori perbankan
 * "Dalam Perhatian" yang harus dipetakan. Pemetaannya karena itu menjadi
 * IDENTITAS (lihat `PETA_KATEGORI_KE_FISKAL`). Yang TIDAK menjadi sama
 * adalah DASAR pengenaannya: penyisihan buku dikenakan atas saldo pokok
 * PENUH, batasan fiskal atas saldo pokok DIKURANGI agunan (kecuali
 * Lancar) — itulah satu-satunya sumber selisih buku vs fiskal sekarang,
 * dan justru itu yang membuat laporan pembanding ini tetap diperlukan.
 *
 * SUMBER: PMK 74/2024, Lampiran, baris "Koperasi Simpan Pinjam" (Ps.7):
 * batasan cadangan piutang tak tertagih = 0,5% piutang Lancar, 10%
 * Kurang Lancar, 50% Diragukan, 100% Macet. PMK 74 KSP HANYA 4
 * kategori — TIDAK ADA kategori "Dalam Perhatian Khusus" (itu istilah
 * perbankan/POJK 40/2019 untuk bank umum & BPR, bukan untuk KSP).
 * Dasar penghitungan = nilai piutang DIKURANGI nilai agunan, KECUALI
 * kategori Lancar yang dihitung TANPA pengurang agunan.
 */

export type KolektibilitasFiskal = 'LANCAR' | 'KURANG_LANCAR' | 'DIRAGUKAN' | 'MACET';

export const LABEL_KOLEKTIBILITAS_FISKAL: Record<KolektibilitasFiskal, string> = {
  LANCAR: 'Lancar',
  KURANG_LANCAR: 'Kurang Lancar',
  DIRAGUKAN: 'Diragukan',
  MACET: 'Macet',
};

/**
 * Batasan tertentu cadangan piutang tak tertagih — PMK 74/2024,
 * Lampiran, baris Koperasi Simpan Pinjam (Ps.7). TETAP (bukan
 * configurable): ini angka baku dari peraturan, sama seperti
 * `PERSENTASE_CADANGAN` di LoanImpairmentService yang juga TETAP.
 */
export const PERSENTASE_CADANGAN_FISKAL: Record<KolektibilitasFiskal, number> = {
  LANCAR: 0.5,
  KURANG_LANCAR: 10,
  DIRAGUKAN: 50,
  MACET: 100,
};

/**
 * Peta kategori kolektibilitas buku (SOM Juklat 3/2025) ke kategori
 * fiskal PMK 74/2024.
 *
 * Sejak penggolongan buku memakai SOM, kedua taksonomi berisi kategori
 * yang SAMA, jadi peta ini adalah IDENTITAS. Peta itu SENGAJA TETAP ADA
 * dan tidak dihapus/diganti pemakaian langsung: ia adalah satu-satunya
 * tempat keterkaitan "kategori buku -> kategori fiskal" dinyatakan.
 * Kalau salah satu peraturan kelak mengubah daftar kategorinya, yang
 * perlu diubah hanya berkas ini, dan TypeScript akan menolak kompilasi
 * kalau ada kategori buku yang lupa dipetakan.
 */
export const PETA_KATEGORI_KE_FISKAL: Record<Kolektibilitas, KolektibilitasFiskal> = {
  LANCAR: 'LANCAR',
  KURANG_LANCAR: 'KURANG_LANCAR',
  DIRAGUKAN: 'DIRAGUKAN',
  MACET: 'MACET',
};

export function petakanKeKolektibilitasFiskal(kategori: Kolektibilitas): KolektibilitasFiskal {
  return PETA_KATEGORI_KE_FISKAL[kategori];
}

/**
 * Cadangan fiskal SATU pinjaman.
 *
 * `saldoPokok` dipakai sebagai "nilai piutang" (KONSISTEN dengan
 * keputusan yang sudah ada di `hitungCadangan()`/`KlasifikasiPinjamanItem.
 * saldoPokok` — cadangan, baik buku maupun fiskal, murni soal eksposur
 * risiko pokok, bukan jasa/bunga yang belum tentu tertagih; lihat
 * komentar di `LoanImpairmentService.ts`).
 *
 * Dasar pencadangan = saldoPokok - nilaiAgunan (tidak boleh negatif),
 * KECUALI kategori LANCAR yang dihitung dari saldoPokok penuh (Lampiran
 * PMK 74/2024: "...kecuali untuk piutang lancar").
 */
export function hitungCadanganFiskal(
  saldoPokok: Rupiah,
  nilaiAgunan: Rupiah,
  kategoriFiskal: KolektibilitasFiskal
): { dasarPencadanganFiskal: Rupiah; cadanganFiskal: Rupiah } {
  const dasarPencadanganFiskal =
    kategoriFiskal === 'LANCAR'
      ? Math.max(0, saldoPokok)
      : Math.max(0, saldoPokok - Math.max(0, nilaiAgunan));
  const cadanganFiskal = roundToRupiah(
    (dasarPencadanganFiskal * PERSENTASE_CADANGAN_FISKAL[kategoriFiskal]) / 100
  );
  return { dasarPencadanganFiskal, cadanganFiskal };
}

export interface KlasifikasiFiskalItem extends KlasifikasiPinjamanItem {
  kolektibilitasFiskal: KolektibilitasFiskal;
  nilaiAgunan: Rupiah;
  dasarPencadanganFiskal: Rupiah;
  persentaseCadanganFiskal: number;
  cadanganFiskal: Rupiah;
}

/**
 * Klasifikasi fiskal SEMUA pinjaman aktif — dasar laporan cadangan
 * PMK 74 / lampiran koreksi fiskal SPT Badan.
 *
 * SUMBER DATA & AGING 100% dari `getKlasifikasiPinjamanAktif()` yang
 * sudah ada — TIDAK ADA mesin klasifikasi kedua. Fungsi ini murni
 * MENAMBAHKAN pemetaan kategori fiskal + nilai agunan (dari
 * `pinjaman_agunan`, sudah ada sejak RC-S54 item 25) di atas hasil yang
 * sudah dihitung.
 */
export async function getKlasifikasiFiskalPinjamanAktif(
  db: SQLite.SQLiteDatabase,
  opts: GetKlasifikasiOpts = {}
): Promise<KlasifikasiFiskalItem[]> {
  const klasifikasi = await getKlasifikasiPinjamanAktif(db, opts);
  if (klasifikasi.length === 0) return [];

  const ids = klasifikasi.map((k) => k.pinjamanId);
  // Skema `pinjaman_agunan` HANYA mengelola satu baris agunan per
  // pinjaman (lihat komentar tabel di schema.ts), tapi tetap di-SUM
  // per pinjaman_id supaya aman kalau asumsi satu-baris itu berubah.
  const agunanRows = await db.getAllAsync<{ pinjaman_id: string; total_agunan: number }>(
    `SELECT pinjaman_id, SUM(nilai_agunan) as total_agunan
     FROM pinjaman_agunan
     WHERE pinjaman_id IN (${ids.map(() => '?').join(',')})
     GROUP BY pinjaman_id`,
    ...ids
  );
  const agunanById = new Map(agunanRows.map((r) => [r.pinjaman_id, r.total_agunan]));

  return klasifikasi.map((k) => {
    const kategoriFiskal = petakanKeKolektibilitasFiskal(k.kolektibilitas);
    const nilaiAgunan = agunanById.get(k.pinjamanId) ?? 0;
    const { dasarPencadanganFiskal, cadanganFiskal } = hitungCadanganFiskal(
      k.saldoPokok,
      nilaiAgunan,
      kategoriFiskal
    );
    return {
      ...k,
      kolektibilitasFiskal: kategoriFiskal,
      nilaiAgunan,
      dasarPencadanganFiskal,
      persentaseCadanganFiskal: PERSENTASE_CADANGAN_FISKAL[kategoriFiskal],
      cadanganFiskal,
    };
  });
}

export interface RingkasanCadanganFiskalItem {
  kategori: KolektibilitasFiskal;
  jumlahPinjaman: number;
  totalDasarPencadangan: Rupiah;
  totalCadanganFiskal: Rupiah;
}

/** Ringkasan agregat per kategori FISKAL (4 kategori PMK 74) — untuk layar/laporan cadangan fiskal. */
export async function getRingkasanCadanganFiskal(
  opts: GetKlasifikasiOpts = {}
): Promise<RingkasanCadanganFiskalItem[]> {
  const db = await getDb();
  const klasifikasi = await getKlasifikasiFiskalPinjamanAktif(db, opts);
  const kategoriList: KolektibilitasFiskal[] = ['LANCAR', 'KURANG_LANCAR', 'DIRAGUKAN', 'MACET'];

  return kategoriList.map((kategori) => {
    const items = klasifikasi.filter((k) => k.kolektibilitasFiskal === kategori);
    return {
      kategori,
      jumlahPinjaman: items.length,
      totalDasarPencadangan: items.reduce((a, k) => a + k.dasarPencadanganFiskal, 0),
      totalCadanganFiskal: items.reduce((a, k) => a + k.cadanganFiskal, 0),
    };
  });
}

export interface PerbandinganCadanganBukuFiskal {
  totalCadanganBuku: Rupiah;
  totalCadanganFiskal: Rupiah;
  /** buku - fiskal. Positif = cadangan buku MELEBIHI batas fiskal (calon koreksi fiskal positif di SPT Badan). */
  selisih: Rupiah;
}

/**
 * Perbandingan cadangan BUKU (SAK EP, `nilaiCadangan` — sudah dihitung
 * `getKlasifikasiPinjamanAktif()`) vs cadangan FISKAL (PMK 74) — dasar
 * koreksi fiskal di SPT Badan. Ini HANYA laporan pembanding, TIDAK
 * memposting jurnal apa pun — cadangan yang dibukukan tetap murni versi
 * SAK EP lewat `sesuaikanPenyisihanPiutang()` di LoanImpairmentService;
 * penyesuaian ke batas fiskal dilakukan lewat koreksi fiskal SPT Badan,
 * bukan lewat jurnal akuntansi koperasi.
 */
export async function getPerbandinganCadanganBukuFiskal(
  opts: GetKlasifikasiOpts = {}
): Promise<PerbandinganCadanganBukuFiskal> {
  const db = await getDb();
  const klasifikasi = await getKlasifikasiFiskalPinjamanAktif(db, opts);
  const totalCadanganBuku = klasifikasi.reduce((a, k) => a + k.nilaiCadangan, 0);
  const totalCadanganFiskal = klasifikasi.reduce((a, k) => a + k.cadanganFiskal, 0);
  return {
    totalCadanganBuku,
    totalCadanganFiskal,
    selisih: totalCadanganBuku - totalCadanganFiskal,
  };
}
