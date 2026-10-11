/**
 * RC-S86 — PPh PASAL 4(2) ATAS BUNGA SIMPANAN (mesin pemotongan otomatis).
 *
 * PRINSIP UTAMA (keputusan pengguna, sesi RC-S86):
 *  - TITIK POTONG mengikuti PERISTIWA PEMBAYARAN, bukan nama prosesnya.
 *    Bunga simpanan berjangka punya DUA peristiwa yang membuatnya
 *    menjadi hak anggota yang bisa dipakai/ditarik:
 *      1. TRANSFER_SUKARELA — `SimpananBerjangkaLifecycleService`
 *         §B (`prosesTransferBungaKeSukarelaPadaDb`): bunga per
 *         periode dipindahkan ke Simpanan Sukarela anggota begitu
 *         periode itu selesai.
 *      2. PENCAIRAN — `cairkanSimpananBerjangka`: sisa bunga yang
 *         BELUM pernah ditransfer, dibayar tunai saat kontrak cair.
 *    AKRUAL (Dr Beban/Cr Utang Bunga) BUKAN peristiwa bayar — bunga di
 *    situ baru jadi kewajiban koperasi, belum tersedia bagi anggota.
 *    Modul ini TIDAK dipasang di titik akrual.
 *  - IDEMPOTENSI STRUKTURAL, BUKAN TABEL PENANDA TERPISAH. Pemotongan
 *    pajak SELALU menumpang di JURNAL PEMBAYARAN yang sama (satu
 *    jurnal, bukan dua) — Dr Utang Bunga / Cr Utang PPh 4(2) (bila >0)
 *    / Cr Sukarela-atau-Kas (netto). Karena itu, kalau satu periode
 *    SUDAH pernah dibayar (dicek lewat mekanisme existing:
 *    `getStatusTransferBungaPadaDb` untuk §B,
 *    `getTotalBungaDitransferPadaDb` untuk sisa di pencairan), ia
 *    OTOMATIS sudah pernah dipotong pajak juga — tidak mungkin dua
 *    kali, karena jurnal pembayarannya sendiri tidak mungkin dobel
 *    (idempotensi §B & pencairan yang SUDAH ADA dan TIDAK diubah).
 *  - REVERSAL. Karena pajak ada di JURNAL YANG SAMA dengan
 *    pembayarannya, membalik jurnal pembayaran (lewat
 *    `reverseJournal()` generik) OTOMATIS membalik utang PPh 4(2) juga
 *    — tidak ada jurnal pajak terpisah yang bisa tertinggal tidak
 *    sinkron. Setelah reversal, `sudahDitransfer`/`status` kontrak
 *    kembali "belum dibayar" (perilaku existing, tidak diubah) —
 *    sehingga periode itu otomatis kembali eligible untuk pembayaran +
 *    pemotongan baru.
 *  - THRESHOLD PER BULAN MASA BUNGA, BUKAN PER PEMBAYARAN — dan sejak
 *    RC-S127 AGREGAT PER ANGGOTA LINTAS PRODUK (Sukarela + Berjangka):
 *    `buatPenghitungPphAgregat` / `hitungPphBungaSimpananAgregat`.
 *  - PISAH TEGAS DARI SHU. Modul ini HANYA dipanggil dari
 *    `SimpananBerjangkaLifecycleService` (§B & pencairan) dan
 *    `BungaSukarelaService` (akrual bunga sukarela) — TIDAK
 *    PERNAH dari jalur SHU (`SHU_DISTRIBUSI`). PP 15/2009: bunga
 *    simpanan yang merupakan bagian dari SHU bukan objek pasal ini.
 *  - BUKTI POTONG WAJIB TERBIT UNTUK SETIAP PEMOTONGAN, TERMASUK
 *    TARIF 0%. Baris `pajak_potong_bunga_simpanan` selalu dibuat per
 *    periode yang dibayar, terlepas dari nilai pajaknya.
 *
 * SCHEMA. Tabel `pajak_potong_bunga_simpanan` BARU, aditif (tidak
 * menaikkan SCHEMA_VERSION — pola sama dengan `pastikanAkunPajak()` di
 * PajakService.ts: `CREATE TABLE IF NOT EXISTS` dipanggil idempoten di
 * dalam transaksi pencatatan pertama). Menyimpan RINCIAN per anggota
 * per periode (bruto/pajak/netto/masa/peristiwa/bukti potong) yang
 * TIDAK bisa direpresentasikan lewat `journal.sumber_id` saja karena
 * satu jurnal pencairan bisa menyelesaikan BEBERAPA periode sekaligus.
 */
import * as SQLite from 'expo-sqlite';
import { getDb } from '@/database/db';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { NAMA_BULAN } from '@/utils/reportPeriod';
import type { DataLaporanExport } from '@/export/ExportTypes';
import {
  PeriodeBungaSimpananPajak,
  HasilHitungPajakBungaSimpanan,
  PeristiwaBayarBungaSimpanan,
  hitungPphBungaSimpananPeriode,
  BATAS_BUNGA_SIMPANAN_PPH_BEBAS,
  TARIF_PPH_BUNGA_SIMPANAN_PERSEN,
  hitungPphBungaSimpananAgregat,
  type PosisiPphBungaBulanan,
} from '@/config/pajakPolicy';

/**
 * RC-S127 — penanda pada kolom `simpanan_berjangka_id` untuk bukti potong
 * BUNGA SIMPANAN SUKARELA (akrual bulanan BungaSukarelaService). Kolom itu
 * sudah ada sejak RC-S86 dan berstatus NOT NULL; bunga sukarela tidak punya
 * kontrak, jadi diisi penanda ini. Didefinisikan DI SINI (bukan di
 * BungaSukarelaService) supaya modul ini bisa membedakan produk tanpa
 * impor melingkar. Nilai TIDAK boleh diubah — data lama memakainya.
 */
export const PENANDA_BUKTI_POTONG_SUKARELA = 'SUKARELA';

/** Produk simpanan asal bunga yang dipotong. */
export type ProdukBuktiPotong = 'SUKARELA' | 'BERJANGKA';

export const LABEL_PRODUK_BUKTI_POTONG: Record<ProdukBuktiPotong, string> = {
  SUKARELA: 'Bunga Simpanan Sukarela',
  BERJANGKA: 'Bunga Simpanan Berjangka',
};

/** Self-heal aditif — aman dipanggil berkali-kali, tidak pernah DROP/ALTER data. */
export async function pastikanTabelPphPotongBungaSimpanan(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS pajak_potong_bunga_simpanan (
      id TEXT PRIMARY KEY,
      simpanan_berjangka_id TEXT NOT NULL,
      bunga_periode_id TEXT NOT NULL,
      nomor_periode INTEGER NOT NULL,
      anggota_id TEXT NOT NULL,
      masa_pajak TEXT NOT NULL,
      bruto INTEGER NOT NULL,
      pajak INTEGER NOT NULL,
      netto INTEGER NOT NULL,
      peristiwa TEXT NOT NULL CHECK (peristiwa IN ('TRANSFER_SUKARELA','PENCAIRAN')),
      journal_id TEXT NOT NULL,
      nomor_bukti_potong TEXT NOT NULL UNIQUE,
      tanggal TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pph_potong_bunga_kontrak ON pajak_potong_bunga_simpanan(simpanan_berjangka_id);
    CREATE INDEX IF NOT EXISTS idx_pph_potong_bunga_periode ON pajak_potong_bunga_simpanan(bunga_periode_id);
    CREATE INDEX IF NOT EXISTS idx_pph_potong_bunga_anggota ON pajak_potong_bunga_simpanan(anggota_id);
    CREATE INDEX IF NOT EXISTS idx_pph_potong_bunga_journal ON pajak_potong_bunga_simpanan(journal_id);
  `);
}

/** Re-export murni — supaya pemanggil (lifecycle service) cukup satu import untuk hitung. */
export { hitungPphBungaSimpananPeriode };
export type { PeriodeBungaSimpananPajak, HasilHitungPajakBungaSimpanan, PeristiwaBayarBungaSimpanan };

// ---------------------------------------------------------------------------
// RC-S127 — PENGHITUNG PPh AGREGAT PER ANGGOTA PER BULAN (lintas produk)
// ---------------------------------------------------------------------------

/**
 * Posisi bulan masa `masa` untuk satu anggota dari SELURUH bukti potong
 * yang masih berlaku (jurnal pembayarannya POSTED) — Sukarela, Berjangka,
 * apa pun produknya. Bukti potong yang jurnalnya dibalik tidak dihitung.
 */
export async function getPosisiPphBungaBulananPadaDb(db: SQLite.SQLiteDatabase, anggotaId: string, masa: string): Promise<PosisiPphBungaBulanan> {
  await pastikanTabelPphPotongBungaSimpanan(db);
  const r = await db.getFirstAsync<{ bruto: number; pajak: number }>(
    `SELECT COALESCE(SUM(p.bruto),0) AS bruto, COALESCE(SUM(p.pajak),0) AS pajak
       FROM pajak_potong_bunga_simpanan p JOIN journal j ON j.id = p.journal_id
      WHERE p.anggota_id = ? AND p.masa_pajak = ? AND j.status = 'POSTED'`,
    anggotaId,
    masa
  );
  return { brutoSudah: r?.bruto ?? 0, pajakSudah: r?.pajak ?? 0 };
}

export interface PenghitungPphAgregat {
  /** PPh untuk satu pembayaran bunga `bruto` (boleh negatif = koreksi turun) milik anggota pada bulan masa `masa`. */
  hitung(anggotaId: string, masa: string, bruto: Rupiah): Promise<Rupiah>;
}

/**
 * Satu penghitung per transaksi pembayaran. Posisi awal dibaca dari DB
 * sekali per (anggota, masa), lalu setiap pembayaran dalam batch yang
 * sama DITAMBAHKAN di memori — sehingga beberapa baris untuk anggota &
 * bulan yang sama dalam satu transaksi tetap dihitung kumulatif, walau
 * bukti potongnya baru ditulis sesudahnya.
 */
export function buatPenghitungPphAgregat(db: SQLite.SQLiteDatabase): PenghitungPphAgregat {
  const posisi = new Map<string, PosisiPphBungaBulanan>();
  return {
    async hitung(anggotaId, masa, bruto) {
      const kunci = `${anggotaId}|${masa}`;
      let pos = posisi.get(kunci);
      if (!pos) {
        pos = await getPosisiPphBungaBulananPadaDb(db, anggotaId, masa);
        posisi.set(kunci, pos);
      }
      const pajak = hitungPphBungaSimpananAgregat(pos, bruto);
      pos.brutoSudah += bruto;
      pos.pajakSudah += pajak;
      return pajak;
    },
  };
}

/**
 * Versi agregat `hitungPphBungaSimpananPeriode` untuk simpanan berjangka:
 * tiap periode tetap dihitung pada bulan masanya sendiri (tidak digabung
 * lintas bulan), tetapi digabung dengan bunga produk lain anggota yang
 * sama pada bulan itu.
 */
export async function hitungPphBungaSimpananPeriodeAgregatPadaDb(
  db: SQLite.SQLiteDatabase,
  anggotaId: string,
  periods: readonly PeriodeBungaSimpananPajak[],
  penghitung: PenghitungPphAgregat = buatPenghitungPphAgregat(db)
): Promise<HasilHitungPajakBungaSimpanan> {
  const perPeriode = [];
  for (const p of periods) {
    const masaPajak = p.tanggalAkhirPeriode.slice(0, 7);
    const pajak = await penghitung.hitung(anggotaId, masaPajak, p.bruto);
    perPeriode.push({ bungaPeriodeId: p.bungaPeriodeId, nomorPeriode: p.nomorPeriode, masaPajak, bruto: p.bruto, pajak, netto: p.bruto - pajak });
  }
  return {
    totalBruto: perPeriode.reduce((s, p) => s + p.bruto, 0),
    totalPajak: perPeriode.reduce((s, p) => s + p.pajak, 0),
    totalNetto: perPeriode.reduce((s, p) => s + p.netto, 0),
    perPeriode,
  };
}

export interface CatatBuktiPotongInput {
  simpananBerjangkaId: string;
  anggotaId: string;
  journalId: string;
  peristiwa: PeristiwaBayarBungaSimpanan;
  tanggal: string;
  createdBy: string;
  hasil: HasilHitungPajakBungaSimpanan;
}

export interface BuktiPotongTercatat {
  bungaPeriodeId: string;
  nomorPeriode: number;
  masaPajak: string;
  bruto: Rupiah;
  pajak: Rupiah;
  netto: Rupiah;
  nomorBuktiPotong: string;
}

/**
 * Catat SATU BUKTI POTONG per periode dalam `hasil.perPeriode` — TERMASUK
 * yang pajaknya Rp0 (ketentuan bunga simpanan mensyaratkan bukti potong
 * tetap terbit pada tarif 0%). WAJIB dipanggil SETELAH jurnal pembayaran
 * (transfer/pencairan) berhasil dibuat, di dalam TRANSAKSI YANG SAMA,
 * dengan `journalId` jurnal itu — supaya bukti potong tidak pernah ada
 * tanpa jurnal pembayaran yang menyertainya (dan sebaliknya, reversal
 * jurnal itu otomatis "membatalkan" konteks bukti potongnya tanpa
 * baris terpisah yang bisa tidak sinkron).
 */
export async function catatBuktiPotongBungaSimpananPadaDb(
  db: SQLite.SQLiteDatabase,
  input: CatatBuktiPotongInput
): Promise<BuktiPotongTercatat[]> {
  if (input.hasil.perPeriode.length === 0) return [];
  await pastikanTabelPphPotongBungaSimpanan(db);

  const hasil: BuktiPotongTercatat[] = [];
  for (const p of input.hasil.perPeriode) {
    const tahun = parseInt(p.masaPajak.slice(0, 4), 10);
    const nomorBuktiPotong = await nextSequence(db, 'BP-PPH4A2', tahun);
    const id = newId();
    await db.runAsync(
      `INSERT INTO pajak_potong_bunga_simpanan
        (id, simpanan_berjangka_id, bunga_periode_id, nomor_periode, anggota_id, masa_pajak,
         bruto, pajak, netto, peristiwa, journal_id, nomor_bukti_potong, tanggal, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.simpananBerjangkaId,
      p.bungaPeriodeId,
      p.nomorPeriode,
      input.anggotaId,
      p.masaPajak,
      p.bruto,
      p.pajak,
      p.netto,
      input.peristiwa,
      input.journalId,
      nomorBuktiPotong,
      input.tanggal,
      input.createdBy,
      new Date().toISOString()
    );
    hasil.push({
      bungaPeriodeId: p.bungaPeriodeId,
      nomorPeriode: p.nomorPeriode,
      masaPajak: p.masaPajak,
      bruto: p.bruto,
      pajak: p.pajak,
      netto: p.netto,
      nomorBuktiPotong,
    });
  }
  return hasil;
}

// ---------------------------------------------------------------------------
// Riwayat & ringkasan (dibaca layar Pajak)
// ---------------------------------------------------------------------------

export interface BuktiPotongPphBungaSimpanan {
  id: string;
  simpananBerjangkaId: string;
  nomorPeriode: number;
  anggotaId: string;
  anggotaNama: string;
  masaPajak: string;
  bruto: Rupiah;
  pajak: Rupiah;
  netto: Rupiah;
  peristiwa: PeristiwaBayarBungaSimpanan;
  journalId: string;
  nomorBuktiPotong: string;
  tanggal: string;
  /** Status jurnal pembayaran yang menyertainya — SATU-SATUNYA sumber "dibatalkan atau tidak" (tidak ada flag terpisah). */
  statusJurnal: string;
  // --- RC-S127 (aditif) ---
  /** Produk asal bunga — diturunkan dari penanda `simpanan_berjangka_id`. */
  produk: ProdukBuktiPotong;
  nomorAnggota: string;
  nikAnggota: string | null;
  /** Nomor kontrak simpanan berjangka; null untuk bunga sukarela. */
  nomorKontrak: string | null;
  nomorJurnal: string;
  /** Jurnal pembayarannya sudah dibalik (pembatalan) — bukti potong tidak berlaku. */
  dibatalkan: boolean;
}

/**
 * Seluruh bukti potong pada tahun tertentu, TERMASUK yang pajaknya Rp0
 * (RiwayatPajakScreen/dashboard perlu menampilkannya sebagai bukti
 * kepatuhan, bukan hanya yang bernilai). Status "dibatalkan" DITURUNKAN
 * dari `journal.status` jurnal pembayarannya — bukan kolom sendiri.
 */
export async function listBuktiPotongPphBungaSimpanan(db: SQLite.SQLiteDatabase, tahun: number): Promise<BuktiPotongPphBungaSimpanan[]> {
  await pastikanTabelPphPotongBungaSimpanan(db);
  const rows = await db.getAllAsync<{
    id: string;
    simpanan_berjangka_id: string;
    nomor_periode: number;
    anggota_id: string;
    anggota_nama: string;
    nomor_anggota: string;
    nik: string | null;
    nomor_kontrak: string | null;
    masa_pajak: string;
    bruto: number;
    pajak: number;
    netto: number;
    peristiwa: PeristiwaBayarBungaSimpanan;
    journal_id: string;
    nomor_jurnal: string;
    nomor_bukti_potong: string;
    tanggal: string;
    status_jurnal: string;
  }>(
    `SELECT p.id, p.simpanan_berjangka_id, p.nomor_periode, p.anggota_id, a.nama_lengkap AS anggota_nama,
            a.nomor_anggota, a.nik, sb.nomor_transaksi AS nomor_kontrak,
            p.masa_pajak, p.bruto, p.pajak, p.netto, p.peristiwa, p.journal_id, j.nomor_jurnal,
            p.nomor_bukti_potong, p.tanggal, j.status AS status_jurnal
       FROM pajak_potong_bunga_simpanan p
       JOIN anggota a ON a.id = p.anggota_id
       JOIN journal j ON j.id = p.journal_id
       LEFT JOIN simpanan_berjangka sb ON sb.id = p.simpanan_berjangka_id
      WHERE p.tanggal >= ? AND p.tanggal <= ?
      ORDER BY p.tanggal DESC, p.nomor_bukti_potong DESC`,
    `${tahun}-01-01`,
    `${tahun}-12-31`
  );
  return rows.map((r) => ({
    id: r.id,
    simpananBerjangkaId: r.simpanan_berjangka_id,
    nomorPeriode: r.nomor_periode,
    anggotaId: r.anggota_id,
    anggotaNama: r.anggota_nama,
    masaPajak: r.masa_pajak,
    bruto: r.bruto,
    pajak: r.pajak,
    netto: r.netto,
    peristiwa: r.peristiwa,
    journalId: r.journal_id,
    nomorBuktiPotong: r.nomor_bukti_potong,
    tanggal: r.tanggal,
    statusJurnal: r.status_jurnal,
    produk: r.simpanan_berjangka_id === PENANDA_BUKTI_POTONG_SUKARELA ? 'SUKARELA' : 'BERJANGKA',
    nomorAnggota: r.nomor_anggota ?? '',
    nikAnggota: r.nik ?? null,
    nomorKontrak: r.simpanan_berjangka_id === PENANDA_BUKTI_POTONG_SUKARELA ? null : r.nomor_kontrak ?? null,
    nomorJurnal: r.nomor_jurnal ?? '',
    dibatalkan: r.status_jurnal === 'REVERSED' || r.status_jurnal === 'VOID',
  }));
}

export interface IdentitasPemotong {
  namaKoperasi: string;
  alamatKoperasi?: string;
  npwpKoperasi: string | null;
}

/** Identitas koperasi sebagai pemotong pajak (kop & NPWP bukti potong). */
export async function getIdentitasPemotong(): Promise<IdentitasPemotong> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ nama: string; alamat: string | null; npwp: string | null }>(
    `SELECT nama, alamat, npwp FROM koperasi ORDER BY created_at DESC LIMIT 1`
  );
  return { namaKoperasi: r?.nama ?? '', alamatKoperasi: r?.alamat ?? undefined, npwpKoperasi: r?.npwp ?? null };
}

/** Versi layar: membuka DB sendiri. */
export async function listBuktiPotongTahun(tahun: number): Promise<BuktiPotongPphBungaSimpanan[]> {
  return listBuktiPotongPphBungaSimpanan(await getDb(), tahun);
}

// ---------------------------------------------------------------------------
// RC-S127 — ringkasan, keterangan tarif & dokumen bukti potong (murni)
// ---------------------------------------------------------------------------

export function labelMasaPajak(masa: string): string {
  const [y, m] = masa.split('-');
  return `${NAMA_BULAN[Number(m) - 1] ?? m} ${y}`;
}

/**
 * Keterangan tarif untuk SATU bukti potong. Diturunkan dari angka yang
 * TERSIMPAN (bruto & pajak), bukan dihitung ulang — bukti potong lama tetap
 * tampil apa adanya walau kebijakan berganti versi. Bukti potong koreksi
 * (bruto negatif / selisih) ditandai sebagai koreksi.
 */
export function keteranganTarifBuktiPotong(b: { bruto: Rupiah; pajak: Rupiah }): string {
  const batas = `Rp${BATAS_BUNGA_SIMPANAN_PPH_BEBAS.toLocaleString('id-ID')}`;
  if (b.bruto < 0) return 'Koreksi bunga bulan lalu';
  if (b.pajak < 0) return 'Pengembalian potongan — total bunga bulan itu turun';
  if (b.pajak === 0) return `0% — total bunga anggota bulan itu tidak lebih dari ${batas}`;
  if (b.pajak === Math.floor((b.bruto * TARIF_PPH_BUNGA_SIMPANAN_PERSEN) / 100)) return `${TARIF_PPH_BUNGA_SIMPANAN_PERSEN}% dari bunga bruto`;
  // RC-S127 — potongan memuat susulan atas bunga produk lain bulan yang sama.
  return `${TARIF_PPH_BUNGA_SIMPANAN_PERSEN}% atas total bunga bulan itu (lewat ${batas}), termasuk susulan bunga lain yang sebelumnya 0%`;
}

export interface RingkasanBuktiPotong {
  jumlah: number;
  jumlahDipotong: number;
  jumlahNol: number;
  jumlahDibatalkan: number;
  totalBruto: Rupiah;
  totalPajak: Rupiah;
  totalNetto: Rupiah;
}

/** Ringkasan daftar — bukti potong yang jurnalnya dibatalkan TIDAK ikut dijumlah. */
export function ringkasBuktiPotong(daftar: readonly BuktiPotongPphBungaSimpanan[]): RingkasanBuktiPotong {
  const sah = daftar.filter((b) => !b.dibatalkan);
  return {
    jumlah: sah.length,
    jumlahDipotong: sah.filter((b) => b.pajak > 0).length,
    jumlahNol: sah.filter((b) => b.pajak === 0).length,
    jumlahDibatalkan: daftar.length - sah.length,
    totalBruto: sah.reduce((t, b) => t + b.bruto, 0),
    totalPajak: sah.reduce((t, b) => t + b.pajak, 0),
    totalNetto: sah.reduce((t, b) => t + b.netto, 0),
  };
}

export function filterBuktiPotong(
  daftar: readonly BuktiPotongPphBungaSimpanan[],
  produk: ProdukBuktiPotong | 'SEMUA'
): BuktiPotongPphBungaSimpanan[] {
  return produk === 'SEMUA' ? [...daftar] : daftar.filter((b) => b.produk === produk);
}

function sumberBunga(b: BuktiPotongPphBungaSimpanan): string {
  return b.produk === 'SUKARELA'
    ? LABEL_PRODUK_BUKTI_POTONG.SUKARELA
    : `${LABEL_PRODUK_BUKTI_POTONG.BERJANGKA}${b.nomorKontrak ? ` ${b.nomorKontrak}` : ''}${b.nomorPeriode ? ` periode ${b.nomorPeriode}` : ''}`;
}

/** Daftar bukti potong setahun (PDF/Excel/CSV) — rekap untuk pengurus & pengawas. */
export function buildDaftarBuktiPotongExport(
  info: { namaKoperasi: string; alamatKoperasi?: string },
  tahun: number,
  daftar: readonly BuktiPotongPphBungaSimpanan[],
  produk: ProdukBuktiPotong | 'SEMUA' = 'SEMUA'
): DataLaporanExport {
  const r = ringkasBuktiPotong(daftar);
  return {
    judulLaporan: 'Daftar Bukti Potong PPh Pasal 4 ayat (2) atas Bunga Simpanan',
    namaFileDasar: `bukti-potong-pph42-bunga-simpanan-${tahun}${produk === 'SEMUA' ? '' : `-${produk.toLowerCase()}`}`,
    namaKoperasi: info.namaKoperasi,
    alamatKoperasi: info.alamatKoperasi,
    periodeLabel: `Tahun ${tahun}${produk === 'SEMUA' ? '' : ` · ${LABEL_PRODUK_BUKTI_POTONG[produk]}`}`,
    kolom: ['No. Bukti Potong', 'Tanggal', 'Masa Pajak', 'No. Anggota', 'Nama', 'Sumber Bunga', 'Bunga Bruto', 'PPh Dipotong', 'Bunga Neto', 'Status'],
    kolomAngka: [6, 7, 8],
    baris: daftar.map((b) => [
      b.nomorBuktiPotong,
      b.tanggal,
      labelMasaPajak(b.masaPajak),
      b.nomorAnggota,
      b.anggotaNama,
      sumberBunga(b),
      b.bruto,
      b.pajak,
      b.netto,
      b.dibatalkan ? 'Dibatalkan' : 'Berlaku',
    ]),
    ringkasan: [
      { label: 'Jumlah bukti potong berlaku', nilai: String(r.jumlah) },
      { label: 'Dengan PPh dipotong', nilai: String(r.jumlahDipotong) },
      { label: 'Tarif 0%', nilai: String(r.jumlahNol) },
      { label: 'Total bunga bruto', nilai: String(r.totalBruto) },
      { label: 'Total PPh dipotong', nilai: String(r.totalPajak) },
    ],
    catatanKaki: [
      `Batas Rp${BATAS_BUNGA_SIMPANAN_PPH_BEBAS.toLocaleString('id-ID')} diuji terhadap TOTAL bunga simpanan satu anggota dalam satu bulan masa, seluruh produk digabung (Sukarela + Berjangka). Tidak lebih dari batas: 0%; melebihi: ${TARIF_PPH_BUNGA_SIMPANAN_PERSEN}% atas seluruh bruto bulan itu (PP 15/2009).`,
      'Potongan yang lebih besar dari 10% bunga barisnya sendiri memuat susulan atas bunga produk lain bulan yang sama yang sebelumnya dipotong 0%.',
      'Bukti potong tetap diterbitkan untuk tarif 0%.',
      'Bukti potong berstatus Dibatalkan berasal dari jurnal pembayaran bunga yang sudah dibalik dan tidak ikut dijumlahkan.',
    ],
  };
}

/** Satu lembar bukti potong untuk diserahkan kepada anggota. */
export function buildBuktiPotongSatuExport(
  info: { namaKoperasi: string; alamatKoperasi?: string; npwpKoperasi?: string | null },
  b: BuktiPotongPphBungaSimpanan
): DataLaporanExport {
  const identitas = [
    { label: 'Nomor anggota', nilai: b.nomorAnggota || '-' },
    { label: 'Nama', nilai: b.anggotaNama },
    { label: 'NIK', nilai: b.nikAnggota || '-' },
  ];
  const rincian = [
    { label: 'Sumber bunga', nilai: sumberBunga(b) },
    { label: 'Masa pajak', nilai: labelMasaPajak(b.masaPajak) },
    { label: 'Tanggal pemotongan', nilai: b.tanggal },
    { label: 'Bunga bruto', nilai: `Rp${b.bruto.toLocaleString('id-ID')}` },
    { label: 'Tarif', nilai: keteranganTarifBuktiPotong(b) },
    { label: 'PPh dipotong', nilai: `Rp${b.pajak.toLocaleString('id-ID')}` },
    { label: 'Bunga diterima (neto)', nilai: `Rp${b.netto.toLocaleString('id-ID')}` },
  ];
  const pemotong = [
    { label: 'Nama koperasi', nilai: info.namaKoperasi },
    { label: 'NPWP koperasi', nilai: info.npwpKoperasi || '-' },
    { label: 'Nomor jurnal', nilai: b.nomorJurnal || '-' },
    { label: 'Status', nilai: b.dibatalkan ? 'DIBATALKAN' : 'Berlaku' },
  ];
  return {
    judulLaporan: 'Bukti Pemotongan PPh Pasal 4 ayat (2) atas Bunga Simpanan',
    namaFileDasar: `bukti-potong-${b.nomorBuktiPotong.replace(/[^A-Za-z0-9-]/g, '-')}`,
    namaKoperasi: info.namaKoperasi,
    alamatKoperasi: info.alamatKoperasi,
    periodeLabel: `Nomor ${b.nomorBuktiPotong} · Masa ${labelMasaPajak(b.masaPajak)}`,
    nomorDokumen: b.nomorBuktiPotong,
    kolom: ['Keterangan', 'Nilai'],
    kolomAngka: [],
    baris: [...identitas, ...rincian, ...pemotong].map((x) => [x.label, x.nilai]),
    seksi: [
      { jenis: 'KV', judul: 'Penerima penghasilan (anggota)', baris: identitas },
      { jenis: 'KV', judul: 'Rincian pemotongan', baris: rincian, labelTebal: ['PPh dipotong'] },
      { jenis: 'KV', judul: 'Pemotong pajak', baris: pemotong },
    ],
    catatanKaki: [
      'PPh atas bunga simpanan koperasi bersifat final (PP 15/2009) — tidak perlu diperhitungkan lagi oleh anggota.',
      `Total bunga simpanan anggota (semua produk) tidak lebih dari Rp${BATAS_BUNGA_SIMPANAN_PPH_BEBAS.toLocaleString('id-ID')} sebulan dikenai tarif 0%; di atasnya ${TARIF_PPH_BUNGA_SIMPANAN_PERSEN}% atas seluruh bruto bulan itu.`,
    ],
  };
}

export interface RingkasanPphBungaSimpananBulanIni {
  masaPajak: string;
  totalBruto: Rupiah;
  totalPajak: Rupiah;
  jumlahBuktiPotong: number;
}

/**
 * Ringkasan bulan berjalan untuk dashboard Pajak — hanya menghitung
 * bukti potong yang jurnal pembayarannya MASIH POSTED (yang sudah
 * dibalik tidak ikut, konsisten dengan `getAccountBalance()` yang juga
 * mengabaikan jurnal REVERSED untuk saldo berjalan).
 */
export async function getRingkasanPphBungaSimpananBulanIni(db: SQLite.SQLiteDatabase, masaPajak: string): Promise<RingkasanPphBungaSimpananBulanIni> {
  await pastikanTabelPphPotongBungaSimpanan(db);
  const row = await db.getFirstAsync<{ bruto: number; pajak: number; n: number }>(
    `SELECT COALESCE(SUM(p.bruto),0) AS bruto, COALESCE(SUM(p.pajak),0) AS pajak, COUNT(*) AS n
       FROM pajak_potong_bunga_simpanan p
       JOIN journal j ON j.id = p.journal_id
      WHERE p.masa_pajak = ? AND j.status = 'POSTED'`,
    masaPajak
  );
  return { masaPajak, totalBruto: row?.bruto ?? 0, totalPajak: row?.pajak ?? 0, jumlahBuktiPotong: row?.n ?? 0 };
}
