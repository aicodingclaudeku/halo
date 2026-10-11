import * as SQLite from 'expo-sqlite';
import { sqlJadwalBukanObsolete, sqlJadwalCurrent } from '@/accounting/ScheduleLifecycle';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { ringkasPenyelesaian, type JalurPenyelesaian } from '@/accounting/PenyelesaianPinjaman';
import {
  HasilKlasifikasiSom,
  KolektibilitasSom,
  KOLEKTIBILITAS_SOM_URUT,
  LABEL_KOLEKTIBILITAS_SOM,
  PERSENTASE_PENYISIHAN_SOM,
  PolaPengembalian,
  bulanPenuhAntara,
  hitungPenyisihanSom,
  isPinjamanBermasalah,
  klasifikasikanSom,
  masaAngsuranBulanDariSatuanTenor,
} from '@/services/KolektibilitasSomService';

/**
 * LoanImpairmentService — kolektibilitas piutang pinjaman anggota &
 * penyisihan (provisioning) otomatis.
 *
 * ============================================================
 * PENGGOLONGAN SEKARANG MENGIKUTI SOM Juklat 3/2025
 * ============================================================
 * PERUBAHAN KEBIJAKAN (permintaan pengguna): skema 5 kategori berbasis
 * HARI KALENDER yang dipakai berkas ini sebelumnya (Lancar 0 hari /
 * Dalam Perhatian 1-90 / Kurang Lancar 91-120 / Diragukan 121-180 /
 * Macet 181+, cadangan 0,5/5/15/50/100%) DIHAPUS SELURUHNYA dan
 * DIGANTI oleh penggolongan SOM Koperasi Simpan Pinjam menurut Petunjuk
 * Pelaksanaan Deputi Bidang Pengawasan Koperasi No. 3/2025: 4 kategori
 * (Lancar / Kurang Lancar / Diragukan / Macet), ambang dalam BULAN
 * tunggakan yang relatif terhadap MASA ANGSURAN pinjaman, plus kriteria
 * kualitatif agunan >= 75% dan aturan 21 bulan.
 *
 * Seluruh ATURANnya ada di `@/services/KolektibilitasSomService` (mesin
 * fungsi murni, tanpa database, bisa diuji dengan angka). Berkas INI
 * tetap menjadi SATU-SATUNYA tempat aging & saldo pinjaman dihitung
 * dari `angsuran_jadwal`, lalu memanggil mesin itu. TIDAK ADA mesin
 * penggolongan kedua di aplikasi ini.
 *
 * DAMPAK ANGKA (disengaja, bukan regresi): kategori "Dalam Perhatian"
 * tidak ada lagi; pinjaman yang menunggak tetapi belum melampaui ambang
 * bawah Kurang Lancar sekarang berstatus LANCAR, dan persentase
 * pencadangan mengikuti naskah SOM angka 15: 0% / 50% / 75% / 100%
 * (sebelumnya 0,5 / 5 / 15 / 50 / 100). Cadangan untuk pinjaman
 * bermasalah karena itu NAIK TAJAM, sementara pinjaman Lancar tidak
 * lagi dicadangkan sama sekali. Angka yang berlaku ada di
 * `PERSENTASE_PENYISIHAN_SOM`; batas FISKAL PMK 74 yang jauh lebih
 * rendah ada di `KolektibilitasFiskalService`, dan selisihnya adalah
 * koreksi fiskal di SPT Badan.
 *
 * `hariTunggakan` TETAP dihitung & tetap diekspos: kebijakan non-accrual
 * (`@/accounting/NonAccrualPolicy`) dinyatakan dalam HARI dan SENGAJA
 * tidak diikat ke kategori kolektibilitas — lihat komentar panjang di
 * berkas itu. Jadi hari tunggakan bukan sisa skema lama, ia dipakai
 * modul lain.
 *
 * BEDA dari `PinjamanService.hapusPiutangPinjaman()`: write-off
 * menghapus piutang SELAMANYA (piutang hilang dari neraca) — hanya
 * boleh SETELAH RAT & kolektibilitas MACET. Modul INI soal PENCADANGAN
 * (provisioning) — estimasi kerugian piutang, dicatat sebagai
 * kontra-aset (Penyisihan Piutang) SEBELUM piutangnya benar-benar
 * dihapus. Piutang bruto TIDAK berkurang oleh penyisihan, hanya oleh
 * write-off.
 */

/**
 * Kolektibilitas = kategori SOM Juklat 3/2025. Alias diekspor dari sini
 * supaya seluruh pemanggil lama (`import { Kolektibilitas } from
 * '@/services/LoanImpairmentService'`) tetap berjalan tanpa diubah
 * satu-satu — yang berubah adalah HIMPUNAN nilainya: 'DALAM_PERHATIAN'
 * TIDAK ADA LAGI.
 */
export type Kolektibilitas = KolektibilitasSom;

export const KOLEKTIBILITAS_LABEL: Record<Kolektibilitas, string> = LABEL_KOLEKTIBILITAS_SOM;

/** Urutan penyajian kategori (ringan -> berat) — satu urutan untuk layar, export, dan ringkasan. */
export const KOLEKTIBILITAS_URUT: Kolektibilitas[] = KOLEKTIBILITAS_SOM_URUT;

/**
 * Persentase penyisihan per kategori SOM. Tetap diekspor dengan nama
 * lama supaya pemanggil lama tidak perlu diubah; NILAINYA berasal dari
 * `PERSENTASE_PENYISIHAN_SOM` — satu sumber, tidak dua tabel angka.
 */
export const PERSENTASE_CADANGAN: Record<Kolektibilitas, number> = PERSENTASE_PENYISIHAN_SOM;

/**
 * Penyisihan = saldo POKOK outstanding x persentase kategori. Delegasi
 * ke `hitungPenyisihanSom` — lihat alasan pemilihan saldo pokok (bukan
 * pokok + jasa) di berkas itu.
 */
export function hitungCadangan(saldoPokok: Rupiah, kategori: Kolektibilitas): Rupiah {
  return hitungPenyisihanSom(saldoPokok, kategori);
}

export interface KlasifikasiPinjamanItem {
  pinjamanId: string;
  nomorPinjaman: string;
  anggotaId: string;
  nomorAnggota: string;
  namaAnggota: string;
  statusAnggota: string;
  /** Saldo piutang anggota (pokok + jasa yang belum terbayar dari jadwal yang belum LUNAS) — untuk TAMPILAN "Total Outstanding" saja. */
  saldoPiutang: Rupiah;
  /**
   * Update pasca-6-perbaikan (permintaan pengguna §5): outstanding
   * POKOK SAJA (bukan pokok+jasa) — INI yang dipakai sebagai basis
   * `nilaiCadangan`, BUKAN `saldoPiutang` di atas. Sebelumnya
   * `nilaiCadangan` keliru dihitung dari `saldoPiutang` (pokok+jasa),
   * sehingga cadangan risiko ikut membesar oleh komponen jasa/bunga
   * yang belum tentu tertagih — bukan murni eksposur risiko pokok.
   * Contoh: pokok 10.000.000, jasa 2.000.000, persentase 5% -> cadangan
   * HARUS 500.000 (5% × 10.000.000), BUKAN 600.000 (5% × 12.000.000).
   */
  saldoPokok: Rupiah;
  /**
   * Saldo JASA outstanding (jasa - jasa_terbayar dari jadwal current).
   * Dipakai bersama `saldoPokok` sebagai "total utang peminjam termasuk
   * jasanya" — pembanding nilai agunan pada kriteria Diragukan SOM.
   */
  saldoJasa: Rupiah;
  /** Tanggal jatuh tempo angsuran TERTUA yang masih menunggak (null kalau tidak ada tunggakan sama sekali). */
  tanggalJatuhTempoTertunggak: string | null;
  /**
   * Hari tunggakan angsuran tertua. TETAP ADA meski penggolongan SOM
   * memakai bulan: kebijakan non-accrual (`@/accounting/NonAccrualPolicy`)
   * dinyatakan dalam hari dan sengaja tidak diikat ke kategori
   * kolektibilitas.
   */
  hariTunggakan: number;

  // ---- Masukan penggolongan SOM (ditampilkan supaya hasilnya bisa diaudit) ----
  /** ANGSURAN vs TANPA_ANGSURAN — diturunkan dari jumlah baris jadwal current. */
  polaPengembalian: PolaPengembalian;
  /** Interval antar angsuran dalam bulan (dari satuan tenor pinjaman). */
  masaAngsuranBulan: number;
  /** Usia tunggakan POKOK tertua yang masih outstanding, dalam bulan penuh. */
  bulanTunggakanPokok: number;
  /** Usia tunggakan JASA tertua yang masih outstanding, dalam bulan penuh. */
  bulanTunggakanJasa: number;
  /** Total nilai agunan pinjaman ini (0 kalau tidak diagunkan). */
  nilaiAgunan: Rupiah;
  /** Angsuran pokok + bunga yang SUDAH dibayar peminjam (kriteria Diragukan huruf a). */
  angsuranTerbayar: Rupiah;
  /** Kewajiban KONTRAKTUAL pokok + bunga sepanjang jadwal (penyebut rasio 75%). */
  kewajibanKontraktual: Rupiah;
  /**
   * RC-S133.6.4 (v82) — pencatatan penyelesaian ke Pengadilan Negeri /
   * klaim asuransi (kriteria Macet angka 3), apa adanya dari `pinjaman`.
   * `penyelesaianBerlaku` = pencatatan ada DAN tanggalnya <= tanggal laporan
   * (hanya itu yang memicu Macet). Opsional agar pemanggil/uji lama tetap valid.
   */
  penyelesaianJalur?: JalurPenyelesaian | null;
  penyelesaianTanggal?: string | null;
  penyelesaianNomor?: string | null;
  penyelesaianBerlaku?: boolean;
  /** Angsuran terbayar sebagai persen dari kewajiban kontraktual (kriteria Diragukan huruf a). */
  rasioAngsuranPersen: number;
  /** Nilai agunan sebagai persen dari SISA utang pokok + jasa (kriteria Diragukan huruf b). */
  rasioAgunanPersen: number;
  /** Bulan sejak pinjaman melewati batas atas Kurang Lancar — dasar aturan 21 bulan SOM. */
  bulanSejakDiragukan: number;

  // ---- Hasil penggolongan ----
  kolektibilitas: Kolektibilitas;
  /** Kriteria SOM mana yang memicu kategori di atas — kalimat siap tampil/cetak. */
  dasarPenggolongan: string;
  /** true untuk Kurang Lancar / Diragukan / Macet — dasar rasio pinjaman bermasalah. */
  bermasalah: boolean;
  persentaseCadangan: number;
  nilaiCadangan: Rupiah;
}

export interface GetKlasifikasiOpts {
  /** Tanggal "as of" perhitungan aging (§4F: dari ReportPeriodPicker) — default hari ini. */
  tanggalLaporan?: string;
  /** §4E: default AKTIF (anggota status existing, TIDAK membuat status baru). */
  statusAnggota?: 'AKTIF' | 'TIDAK_AKTIF' | 'SEMUA';
  /**
   * REQUIREMENT 2 (permintaan pengguna) — batasi ke SATU anggota, untuk
   * layar Detail Anggota. Filter dilakukan DI QUERY (bukan memfilter
   * array hasil di UI) supaya tidak memindai seluruh portofolio
   * pinjaman koperasi hanya untuk menampilkan satu anggota. Mesin
   * klasifikasi & rumus cadangan yang dipakai TETAP SAMA PERSIS —
   * TIDAK ADA perhitungan kolektibilitas kedua di aplikasi ini.
   */
  anggotaId?: string;
}

/**
 * Klasifikasi kolektibilitas SEMUA pinjaman berstatus AKTIF (dasar
 * layar Kolektibilitas Piutang §4 & basis perhitungan penyisihan
 * agregat §15-17). Aging dihitung dari `angsuran_jadwal` sungguhan
 * (jatuh tempo & status per angsuran, BUKAN tanggal transaksi
 * pinjaman) — §4B. Hanya pinjaman dengan saldo piutang > 0 yang
 * dikembalikan (pinjaman yang sudah lunas semua angsurannya otomatis
 * tidak ikut, meski query awal menyertakan seluruh status='AKTIF').
 *
 * Update pasca-6-perbaikan (permintaan pengguna §5): `nilaiCadangan`
 * dihitung dari `saldo_pokok` (pokok outstanding SAJA), bukan lagi
 * dari `saldo_piutang` (pokok+jasa) — lihat komentar `saldoPokok` di
 * `KlasifikasiPinjamanItem`.
 *
 * PENGGOLONGAN SOM Juklat 3/2025: query di bawah mengumpulkan SELURUH
 * masukan yang dibutuhkan mesin aturan dalam SATU perjalanan ke
 * database — usia tunggakan POKOK dan JASA dipisah (SOM punya ambang
 * berbeda untuk keduanya), jumlah baris jadwal current (untuk
 * membedakan pengembalian dengan/tanpa angsuran), satuan tenor (masa
 * angsuran), dan total nilai agunan (kriteria Diragukan). Penggolongannya
 * sendiri dilakukan `klasifikasikanSom()` — tidak ada satu pun ambang
 * SOM yang ditulis di berkas ini.
 */
export async function getKlasifikasiPinjamanAktif(
  db: SQLite.SQLiteDatabase,
  opts: GetKlasifikasiOpts = {}
): Promise<KlasifikasiPinjamanItem[]> {
  const tanggalLaporan = opts.tanggalLaporan ?? getTanggalLokalHariIni();
  const statusAnggota = opts.statusAnggota ?? 'AKTIF';

  const filters = [`p.status = 'AKTIF'`];
  if (statusAnggota === 'AKTIF') filters.push(`a.status = 'AKTIF'`);
  else if (statusAnggota === 'TIDAK_AKTIF') filters.push(`a.status != 'AKTIF'`);
  // SEMUA -> tidak ada filter tambahan status anggota.

  // REQUIREMENT 2 — filter satu anggota (opsional). Parameter di-bind
  // (bukan string interpolation) mengikuti pola query lain di file ini.
  const paramsAnggota: string[] = [];
  if (opts.anggotaId) {
    filters.push(`p.anggota_id = ?`);
    paramsAnggota.push(opts.anggotaId);
  }

  const jadwalCurrentJatuhTempo = `${sqlJadwalCurrent('aj')} AND aj.tanggal_jatuh_tempo <= ?`;

  const rows = await db.getAllAsync<any>(
    `SELECT p.id as pinjaman_id, p.nomor_pinjaman, p.anggota_id, a.nomor_anggota, a.nama_lengkap, a.status as status_anggota,
            p.satuan_tenor, p.tanggal_jatuh_tempo,
            p.penyelesaian_jalur, p.penyelesaian_tanggal, p.penyelesaian_nomor,
            COALESCE(SUM(aj.total - aj.pokok_terbayar - aj.jasa_terbayar), 0) as saldo_piutang,
            COALESCE(SUM(aj.pokok - aj.pokok_terbayar), 0) as saldo_pokok,
            COALESCE(SUM(aj.jasa - aj.jasa_terbayar), 0) as saldo_jasa,
            -- Kriteria Diragukan SOM huruf a: "angsurannya bernilai
            -- sekurang-kurangnya 75% dari utang peminjam TERMASUK
            -- BUNGANYA". Pembilang = angsuran pokok + bunga yang sudah
            -- DIBAYAR; penyebut = kewajiban KONTRAKTUAL pokok + bunga
            -- sepanjang jadwal. Denda SENGAJA tidak ikut keduanya: denda
            -- bukan bagian dari "utang peminjam termasuk bunganya", dan
            -- memasukkannya akan mengecilkan rasio kemajuan pembayaran
            -- justru pada pinjaman yang menunggak.
            COALESCE(SUM(aj.pokok_terbayar + aj.jasa_terbayar), 0) as angsuran_terbayar,
            COALESCE(SUM(aj.pokok + aj.jasa), 0) as kewajiban_kontraktual,
            -- Jumlah angsuran KONTRAKTUAL pinjaman ini, dipakai membedakan
            -- pengembalian dengan angsuran vs tanpa angsuran (sekali bayar
            -- di jatuh tempo).
            --
            -- SENGAJA menghitung SELURUH baris jadwal yang bukan obsolete
            -- (JOIN sudah memfilternya) — TERMASUK baris LUNAS. Kalau hanya
            -- baris CURRENT yang dihitung, pinjaman 12 angsuran yang 11
            -- angsurannya sudah lunas akan tersisa 1 baris current dan
            -- salah dikenali sebagai pinjaman tanpa angsuran, sehingga
            -- ambang SOM yang dipakai ikut salah.
            COUNT(aj.id) as jumlah_angsuran_kontraktual,
            MIN(CASE WHEN ${jadwalCurrentJatuhTempo} THEN aj.tanggal_jatuh_tempo END) as jatuh_tempo_tertua,
            -- Usia tunggakan POKOK dan JASA dipisah: SOM menetapkan ambang
            -- yang berbeda untuk tunggakan pokok dan tunggakan jasa, jadi
            -- keduanya harus dihitung dari baris yang benar-benar masih
            -- menunggak komponen tersebut.
            MIN(CASE WHEN ${jadwalCurrentJatuhTempo} AND (aj.pokok - aj.pokok_terbayar) > 0
                     THEN aj.tanggal_jatuh_tempo END) as jatuh_tempo_pokok_tertua,
            MIN(CASE WHEN ${jadwalCurrentJatuhTempo} AND (aj.jasa - aj.jasa_terbayar) > 0
                     THEN aj.tanggal_jatuh_tempo END) as jatuh_tempo_jasa_tertua,
            MAX(CASE WHEN ${jadwalCurrentJatuhTempo}
                     THEN julianday(?) - julianday(aj.tanggal_jatuh_tempo) ELSE 0 END) as hari_max,
            -- Nilai agunan sebagai SUBQUERY berkorelasi, bukan JOIN kedua:
            -- men-JOIN pinjaman_agunan ke query yang sudah di-GROUP BY per
            -- jadwal akan mengalikan baris jadwal x baris agunan dan
            -- menggelembungkan seluruh SUM saldo di atas.
            COALESCE((SELECT SUM(ag.nilai_agunan) FROM pinjaman_agunan ag WHERE ag.pinjaman_id = p.id), 0) as nilai_agunan
     FROM pinjaman p
     JOIN anggota a ON a.id = p.anggota_id
     -- BUG-08/BUG-12: jadwal obsolete (DIRESTRUKTURISASI/DIHAPUSBUKU)
     -- dikeluarkan DI JOIN, bukan di WHERE, supaya pinjaman tanpa jadwal
     -- current tetap muncul (LEFT JOIN) dengan saldo 0 dan bukan hilang
     -- dari laporan. Tanpa ini, saldo & aging pinjaman yang pernah
     -- direstrukturisasi dihitung dari jadwal lama + jadwal baru.
     LEFT JOIN angsuran_jadwal aj ON aj.pinjaman_id = p.id AND ${sqlJadwalBukanObsolete('aj')}
     WHERE ${filters.join(' AND ')}
     GROUP BY p.id, p.nomor_pinjaman, p.anggota_id, a.nomor_anggota, a.nama_lengkap, a.status,
              p.satuan_tenor, p.tanggal_jatuh_tempo,
              p.penyelesaian_jalur, p.penyelesaian_tanggal, p.penyelesaian_nomor`,
    // URUTAN PENTING: seluruh `?` di bawah ada di SELECT (sebelum WHERE) —
    // lima kemunculan `tanggalLaporan` mengikuti urutan kolomnya di atas
    // (jatuh_tempo_tertua, jatuh_tempo_pokok_tertua, jatuh_tempo_jasa_tertua,
    // lalu dua kali pada hari_max) — parameter anggotaId ada di WHERE,
    // jadi harus di posisi terakhir.
    tanggalLaporan,
    tanggalLaporan,
    tanggalLaporan,
    tanggalLaporan,
    tanggalLaporan,
    ...paramsAnggota
  );

  return rows
    .filter((r) => r.saldo_piutang > 0)
    .map((r) => {
      const hariTunggakan = Math.max(0, Math.floor(r.hari_max ?? 0));
      const saldoPokok = Math.max(0, r.saldo_pokok ?? 0);
      const saldoJasa = Math.max(0, r.saldo_jasa ?? 0);
      const nilaiAgunan = Math.max(0, r.nilai_agunan ?? 0);

      // Pengembalian TANPA ANGSURAN = satu kali bayar di jatuh tempo,
      // yaitu jadwal current hanya berisi SATU baris. Ini turunan dari
      // data yang ada, bukan kolom baru: aplikasi tidak menyimpan
      // "pola pengembalian" secara eksplisit, dan menambah kolomnya
      // hanya untuk pembedaan ini akan menyisakan seluruh pinjaman lama
      // tanpa nilai.
      const polaPengembalian: PolaPengembalian =
        (r.jumlah_angsuran_kontraktual ?? 0) <= 1 ? 'TANPA_ANGSURAN' : 'ANGSURAN';

      const masaAngsuranBulan = masaAngsuranBulanDariSatuanTenor(String(r.satuan_tenor));
      const bulanTunggakanPokok = r.jatuh_tempo_pokok_tertua
        ? bulanPenuhAntara(String(r.jatuh_tempo_pokok_tertua), tanggalLaporan)
        : 0;
      const bulanTunggakanJasa = r.jatuh_tempo_jasa_tertua
        ? bulanPenuhAntara(String(r.jatuh_tempo_jasa_tertua), tanggalLaporan)
        : 0;

      const jatuhTempoPinjaman = r.tanggal_jatuh_tempo ? String(r.tanggal_jatuh_tempo) : null;
      // `<` dan BUKAN `<=`: pada tanggal jatuh tempo itu sendiri pinjaman
      // belum terlambat — kewajibannya jatuh pada hari itu. Kriteria SOM
      // "telah jatuh tempo dan belum dibayar" baru berlaku sehari
      // sesudahnya. Dengan `<=`, setiap pinjaman tanpa angsuran akan
      // langsung digolongkan Kurang Lancar pada hari jatuh temponya.
      const sudahJatuhTempo = !!jatuhTempoPinjaman && jatuhTempoPinjaman < tanggalLaporan;
      const bulanSejakJatuhTempo =
        jatuhTempoPinjaman && sudahJatuhTempo ? bulanPenuhAntara(jatuhTempoPinjaman, tanggalLaporan) : 0;

      const angsuranTerbayar = Math.max(0, r.angsuran_terbayar ?? 0);
      const kewajibanKontraktual = Math.max(0, r.kewajiban_kontraktual ?? 0);

      // RC-S133.6.4 — kriteria Macet angka 3: hanya bila pencatatan ADA dan
      // sudah berlaku pada tanggal laporan (laporan untuk tanggal sebelum
      // penyelesaian diserahkan tidak boleh ikut Macet).
      const jalurPenyelesaian: JalurPenyelesaian | null =
        r.penyelesaian_jalur === 'PENGADILAN' || r.penyelesaian_jalur === 'ASURANSI' ? r.penyelesaian_jalur : null;
      const tanggalPenyelesaian: string | null = r.penyelesaian_tanggal ? String(r.penyelesaian_tanggal) : null;
      const nomorPenyelesaian: string | null = r.penyelesaian_nomor ? String(r.penyelesaian_nomor) : null;
      const penyelesaianBerlaku = !!jalurPenyelesaian && !!tanggalPenyelesaian && tanggalPenyelesaian <= tanggalLaporan;

      const som: HasilKlasifikasiSom = klasifikasikanSom({
        polaPengembalian,
        masaAngsuranBulan,
        bulanTunggakanPokok,
        bulanTunggakanJasa,
        sudahJatuhTempo,
        bulanSejakJatuhTempo,
        // Kriteria Diragukan huruf a (rasio 75%) dan huruf b (rasio 100%)
        // memakai PENYEBUT YANG BERBEDA — lihat komentar masing-masing
        // field di `InputKlasifikasiSom`. Huruf a mengukur kemajuan
        // pembayaran terhadap kewajiban PENUH; huruf b mengukur
        // kecukupan agunan terhadap SISA utang.
        angsuranTerbayar,
        totalKewajibanKontraktual: kewajibanKontraktual,
        nilaiAgunan,
        sisaUtang: saldoPokok + saldoJasa,
        // v82 (RC-S133.6.4): dicatat manual di `pinjaman.penyelesaian_*` —
        // lihat komentar field ini di `InputKlasifikasiSom`.
        diserahkanKePengadilanAtauAsuransi: penyelesaianBerlaku,
        rujukanPenyelesaian:
          penyelesaianBerlaku && jalurPenyelesaian
            ? ringkasPenyelesaian({ jalur: jalurPenyelesaian, nomor: nomorPenyelesaian, tanggal: tanggalPenyelesaian })
            : undefined,
      });

      return {
        pinjamanId: r.pinjaman_id,
        nomorPinjaman: r.nomor_pinjaman,
        anggotaId: r.anggota_id,
        nomorAnggota: r.nomor_anggota,
        namaAnggota: r.nama_lengkap,
        statusAnggota: r.status_anggota,
        saldoPiutang: r.saldo_piutang,
        saldoPokok,
        saldoJasa,
        tanggalJatuhTempoTertunggak: r.jatuh_tempo_tertua ?? null,
        hariTunggakan,
        polaPengembalian,
        masaAngsuranBulan,
        bulanTunggakanPokok,
        bulanTunggakanJasa,
        nilaiAgunan,
        angsuranTerbayar,
        kewajibanKontraktual,
        penyelesaianJalur: jalurPenyelesaian,
        penyelesaianTanggal: tanggalPenyelesaian,
        penyelesaianNomor: nomorPenyelesaian,
        penyelesaianBerlaku,
        rasioAngsuranPersen: som.rasioAngsuranPersen,
        rasioAgunanPersen: som.rasioAgunanPersen,
        bulanSejakDiragukan: som.bulanSejakDiragukan,
        kolektibilitas: som.kategori,
        dasarPenggolongan: som.dasarPenggolongan,
        bermasalah: isPinjamanBermasalah(som.kategori),
        persentaseCadangan: som.persentasePenyisihan,
        nilaiCadangan: hitungCadangan(saldoPokok, som.kategori),
      };
    });
}

/**
 * REQUIREMENT 2 (permintaan pengguna) — "Kolektibilitas Piutang
 * Anggota" untuk layar Detail Anggota.
 */
export interface KolektibilitasAnggotaResult {
  anggotaId: string;
  tanggalLaporan: string;
  /** true kalau anggota ini TIDAK punya pinjaman aktif dengan saldo piutang > 0. */
  tanpaPinjamanAktif: boolean;
  /**
   * Kolektibilitas anggota = kategori TERBURUK dari seluruh pinjaman
   * aktifnya. Ini bukan pilihan sembarangan: kolektibilitas adalah
   * ukuran RISIKO debitur — satu pinjaman macet tidak menjadi "lancar"
   * hanya karena debitur punya pinjaman lain yang lancar. Konsisten
   * pula dengan `hariTunggakan` di bawah (tunggakan terlama).
   * null kalau tanpaPinjamanAktif.
   */
  kolektibilitas: Kolektibilitas | null;
  /** Hari tunggakan TERLAMA di antara seluruh pinjaman aktif anggota ini. */
  hariTunggakan: number;
  /** Tanggal jatuh tempo angsuran tertua yang masih menunggak (null kalau tidak menunggak). */
  tanggalJatuhTempoTertunggak: string | null;
  jumlahPinjamanAktif: number;
  /** Outstanding pokok + jasa seluruh pinjaman aktif anggota ini. */
  totalOutstanding: Rupiah;
  /** Outstanding POKOK saja — basis penyisihan (lihat KlasifikasiPinjamanItem.saldoPokok). */
  totalPokok: Rupiah;
  /** Penyisihan/cadangan target atas piutang anggota ini. */
  totalCadangan: Rupiah;
  /** Rincian per pinjaman — supaya UI bisa menampilkan detail tanpa query kedua. */
  rincian: KlasifikasiPinjamanItem[];
}

/**
 * Kolektibilitas piutang SATU anggota (REQUIREMENT 2) — dipakai layar
 * Detail Anggota.
 *
 * SUMBER DATA & PERHITUNGAN 100% dari `getKlasifikasiPinjamanAktif()`
 * yang SUDAH ADA (mesin yang sama persis dipakai layar Kolektibilitas
 * Piutang & perhitungan penyisihan agregat). TIDAK ADA rumus aging
 * kedua, TIDAK ADA nilai hardcode, TIDAK ADA tabel baru — fungsi ini
 * murni MENGAGREGASI hasil mesin existing untuk satu anggota.
 *
 * `statusAnggota: 'SEMUA'` DISENGAJA: layar Detail Anggota harus tetap
 * menampilkan kolektibilitas walau anggota yang sedang dibuka berstatus
 * TIDAK_AKTIF/KELUAR — piutangnya tetap ada dan tetap berisiko. Ini
 * konsisten dengan alasan yang sama di `getTotalPenyisihanTarget()`.
 */
export async function getKolektibilitasAnggota(
  db: SQLite.SQLiteDatabase,
  anggotaId: string,
  tanggalLaporan?: string
): Promise<KolektibilitasAnggotaResult> {
  const tanggal = tanggalLaporan ?? getTanggalLokalHariIni();
  const rincian = await getKlasifikasiPinjamanAktif(db, {
    tanggalLaporan: tanggal,
    statusAnggota: 'SEMUA',
    anggotaId,
  });

  if (rincian.length === 0) {
    return {
      anggotaId,
      tanggalLaporan: tanggal,
      tanpaPinjamanAktif: true,
      kolektibilitas: null,
      hariTunggakan: 0,
      tanggalJatuhTempoTertunggak: null,
      jumlahPinjamanAktif: 0,
      totalOutstanding: 0,
      totalPokok: 0,
      totalCadangan: 0,
      rincian: [],
    };
  }

  // Kategori terburuk diambil dari kategori yang SUDAH dihitung mesin SOM
  // per pinjaman, dengan mengambil posisi TERAKHIR pada KOLEKTIBILITAS_URUT
  // (urutan ringan -> berat). Sengaja TIDAK dengan menggolongkan ulang
  // hari tunggakan terlama: penggolongan SOM tidak lagi merupakan fungsi
  // dari hari tunggakan saja (ia juga bergantung pada masa angsuran,
  // komponen pokok/jasa, dan rasio agunan MASING-MASING pinjaman), jadi
  // menggolongkan ulang dari angka agregat bisa menghasilkan kategori
  // yang tidak dimiliki satu pun pinjaman anggota ini.
  const kategoriTerburuk = rincian.reduce<Kolektibilitas>(
    (terburuk, r) =>
      KOLEKTIBILITAS_URUT.indexOf(r.kolektibilitas) > KOLEKTIBILITAS_URUT.indexOf(terburuk)
        ? r.kolektibilitas
        : terburuk,
    'LANCAR'
  );
  const hariTunggakan = rincian.reduce((max, r) => Math.max(max, r.hariTunggakan), 0);
  const tanggalTertunggak = rincian
    .map((r) => r.tanggalJatuhTempoTertunggak)
    .filter((t): t is string => !!t)
    .sort()[0] ?? null;

  return {
    anggotaId,
    tanggalLaporan: tanggal,
    tanpaPinjamanAktif: false,
    kolektibilitas: kategoriTerburuk,
    hariTunggakan,
    tanggalJatuhTempoTertunggak: tanggalTertunggak,
    jumlahPinjamanAktif: rincian.length,
    totalOutstanding: rincian.reduce((a, r) => a + r.saldoPiutang, 0),
    totalPokok: rincian.reduce((a, r) => a + r.saldoPokok, 0),
    // Cadangan DIJUMLAH per pinjaman (masing-masing memakai persentase
    // kategorinya SENDIRI), BUKAN dihitung ulang dari totalPokok x
    // persentase kategori terburuk — supaya angkanya identik dengan
    // laporan penyisihan agregat. Kategori terburuk di atas murni untuk
    // penyajian status, tidak dipakai menghitung uang.
    totalCadangan: rincian.reduce((a, r) => a + r.nilaiCadangan, 0),
    rincian,
  };
}

/**
 * Total penyisihan yang SEHARUSNYA tercatat saat ini (target), dari
 * SELURUH pinjaman aktif — TERMASUK anggota nonaktif (`statusAnggota:
 * 'SEMUA'`): penyisihan/CKPN adalah soal risiko kredit piutang, bukan
 * soal status keanggotaan, jadi basis provisioning harus mencakup
 * semua piutang outstanding apa pun status anggotanya.
 */
export async function getTotalPenyisihanTarget(db: SQLite.SQLiteDatabase, tanggalLaporan?: string): Promise<Rupiah> {
  const klasifikasi = await getKlasifikasiPinjamanAktif(db, { tanggalLaporan, statusAnggota: 'SEMUA' });
  return klasifikasi.reduce((a, k) => a + k.nilaiCadangan, 0);
}

export interface HasilPenyesuaianPenyisihan {
  targetPenyisihan: Rupiah;
  saldoPenyisihanSebelumnya: Rupiah;
  delta: Rupiah; // positif = nambah cadangan, negatif = melepas cadangan
  journalId: string | null; // null kalau delta 0 (tidak ada penyesuaian, tidak ada jurnal dibuat)
}

/**
 * Sesuaikan saldo akun Penyisihan Piutang Tak Tertagih supaya PERSIS
 * sama dengan target hasil klasifikasi terbaru — HANYA memposting
 * selisihnya (delta), bukan nilai penuh, supaya aman dijalankan
 * berulang kali tanpa dobel-catat (idempoten by construction).
 *
 * §15-18 (permintaan pengguna): akun DITENTUKAN OTOMATIS lewat
 * `resolveAccountId('PENYISIHAN_PIUTANG', ...)` — TIDAK ADA parameter
 * akun yang dipilih user sama sekali (sudah begini sejak fungsi ini
 * dibuat; diaudit ulang & dikonfirmasi tidak ada celah UI yang
 * memberi pilihan akun manual untuk fungsi ini).
 *
 * delta > 0 (perlu tambah cadangan): DEBIT Beban Penyisihan Piutang,
 *   KREDIT Penyisihan Piutang Tak Tertagih (kontra-aset — piutang
 *   BRUTO tidak tersentuh, lihat komentar header file).
 * delta < 0 (kualitas piutang membaik, cadangan dilepas sebagian):
 *   arah dibalik.
 */
export async function sesuaikanPenyisihanPiutang(params: {
  tanggal: string;
  createdBy: string;
}): Promise<HasilPenyesuaianPenyisihan> {
  return withTransaction(async (db) => {
    await requirePermission(db, params.createdBy, 'pinjaman', 'edit');

    const targetPenyisihan = await getTotalPenyisihanTarget(db, params.tanggal);
    const penyisihanAccountId = await resolveAccountId(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN');
    const saldoPenyisihanSebelumnya = await getAccountBalance(db, penyisihanAccountId, params.tanggal);

    const delta = targetPenyisihan - saldoPenyisihanSebelumnya;
    if (delta === 0) {
      return { targetPenyisihan, saldoPenyisihanSebelumnya, delta: 0, journalId: null };
    }

    const bebanAccountId = await resolveAccountId(db, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN');
    const year = new Date(params.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'PSH', year);

    const lines =
      delta > 0
        ? [
            { accountId: bebanAccountId, debit: delta, kredit: 0 },
            { accountId: penyisihanAccountId, debit: 0, kredit: delta },
          ]
        : [
            { accountId: penyisihanAccountId, debit: -delta, kredit: 0 },
            { accountId: bebanAccountId, debit: 0, kredit: -delta },
          ];

    const { journalId } = await createJournal(db, {
      tanggal: params.tanggal,
      sumberTransaksi: 'PENYISIHAN_PIUTANG',
      nomorReferensi: nomorTransaksi,
      deskripsi: `Penyesuaian penyisihan piutang tak tertagih (${delta > 0 ? 'tambah' : 'lepas'} ${Math.abs(delta)}) - ${nomorTransaksi}`,
      createdBy: params.createdBy,
      lines,
    });

    return { targetPenyisihan, saldoPenyisihanSebelumnya, delta, journalId };
  });
}

/**
 * Ringkasan agregat per kategori (§4C) — untuk layar/laporan Kolektibilitas Piutang.
 *
 * Audit ulang (permintaan pengguna §23-25): `totalOutstanding` SEKARANG
 * dihitung dari `saldoPokok` (pinjaman outstanding — saldo pokok yang
 * belum dilunasi), BUKAN lagi dari `saldoPiutang` (pokok + jasa/bunga
 * belum terbayar). Rumus per kategori (§24):
 *   Total = SUM(saldoPokok) dari pinjaman pada kategori tersebut.
 */
export async function getRingkasanAging(
  opts: GetKlasifikasiOpts = {}
): Promise<{ kategori: Kolektibilitas; jumlahPinjaman: number; totalOutstanding: Rupiah; totalCadangan: Rupiah }[]> {
  const db = await getDb();
  const klasifikasi = await getKlasifikasiPinjamanAktif(db, opts);
  return KOLEKTIBILITAS_URUT.map((kategori) => {
    const items = klasifikasi.filter((k) => k.kolektibilitas === kategori);
    return {
      kategori,
      jumlahPinjaman: items.length,
      totalOutstanding: items.reduce((a, k) => a + k.saldoPokok, 0),
      totalCadangan: items.reduce((a, k) => a + k.nilaiCadangan, 0),
    };
  });
}

export interface RingkasanKualitasPinjaman {
  jumlahPinjaman: number;
  /** SUM(saldoPokok) seluruh pinjaman — penyebut rasio pinjaman bermasalah. */
  totalOutstanding: Rupiah;
  /** SUM(saldoPokok) pinjaman Kurang Lancar + Diragukan + Macet. */
  outstandingBermasalah: Rupiah;
  jumlahPinjamanBermasalah: number;
  /**
   * Rasio pinjaman bermasalah (persen) = outstanding bermasalah /
   * total outstanding x 100. Indikator pengawasan SOM: kategori
   * bermasalah menurut SOM adalah Kurang Lancar, Diragukan, dan Macet
   * (SOM tidak mengenal kategori antara Lancar dan Kurang Lancar).
   * 0 kalau tidak ada piutang outstanding — BUKAN NaN.
   */
  rasioBermasalahPersen: number;
  totalCadangan: Rupiah;
  perKategori: { kategori: Kolektibilitas; jumlahPinjaman: number; totalOutstanding: Rupiah; totalCadangan: Rupiah }[];
}

/**
 * Ringkasan kualitas portofolio pinjaman — dipakai kartu ringkasan layar
 * Kolektibilitas Piutang.
 *
 * MENERIMA hasil klasifikasi yang SUDAH dimuat (bukan query sendiri),
 * supaya layar yang sudah memegang daftar detailnya tidak memuat ulang
 * seluruh portofolio hanya untuk menghitung total — dan supaya angka
 * ringkasan MUSTAHIL berbeda dari angka daftar di bawahnya.
 */
export function ringkasKualitasPinjaman(items: KlasifikasiPinjamanItem[]): RingkasanKualitasPinjaman {
  const totalOutstanding = items.reduce((a, k) => a + k.saldoPokok, 0);
  const bermasalah = items.filter((k) => k.bermasalah);
  const outstandingBermasalah = bermasalah.reduce((a, k) => a + k.saldoPokok, 0);

  return {
    jumlahPinjaman: items.length,
    totalOutstanding,
    outstandingBermasalah,
    jumlahPinjamanBermasalah: bermasalah.length,
    rasioBermasalahPersen: totalOutstanding > 0 ? (outstandingBermasalah / totalOutstanding) * 100 : 0,
    totalCadangan: items.reduce((a, k) => a + k.nilaiCadangan, 0),
    perKategori: KOLEKTIBILITAS_URUT.map((kategori) => {
      const isi = items.filter((k) => k.kolektibilitas === kategori);
      return {
        kategori,
        jumlahPinjaman: isi.length,
        totalOutstanding: isi.reduce((a, k) => a + k.saldoPokok, 0),
        totalCadangan: isi.reduce((a, k) => a + k.nilaiCadangan, 0),
      };
    }),
  };
}

export interface PinjamanMacetItem {
  id: string;
  nomorPinjaman: string;
  anggotaId: string;
  namaAnggota: string;
  jumlahPinjaman: Rupiah;
  sisaPiutang: Rupiah;
  tenor: number;
  satuanTenor: string;
  status: string;
  tanggalJatuhTempo: string;
  hariTunggakan: number;
}

/**
 * Daftar pinjaman berkolektibilitas MACET SAJA (§14, permintaan
 * pengguna) — dipakai picker "Pilih Pinjaman" pada Penghapusan Piutang
 * (`PenghapusanPiutangFormScreen`). Filter dilakukan DI SINI (service),
 * memakai mesin klasifikasi yang SAMA dengan layar Kolektibilitas
 * Piutang (`getKlasifikasiPinjamanAktif`) — bukan filter terpisah yang
 * bisa berbeda hasil. `statusAnggota: 'SEMUA'` karena piutang yang
 * sudah macet tetap harus bisa dihapuskan walau anggotanya sudah
 * keluar/nonaktif.
 */
export async function listPinjamanMacetUntukPenghapusan(opts: { search?: string } = {}): Promise<PinjamanMacetItem[]> {
  const db = await getDb();
  const tanggalHariIni = getTanggalLokalHariIni();
  const klasifikasi = await getKlasifikasiPinjamanAktif(db, { tanggalLaporan: tanggalHariIni, statusAnggota: 'SEMUA' });
  const macet = klasifikasi.filter((k) => k.kolektibilitas === 'MACET');
  if (macet.length === 0) return [];

  const ids = macet.map((k) => k.pinjamanId);
  const rows = await db.getAllAsync<any>(
    `SELECT p.id, p.nomor_pinjaman, p.anggota_id, a.nama_lengkap, p.jumlah_pinjaman, p.tenor, p.satuan_tenor, p.status, p.tanggal_jatuh_tempo
     FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id
     WHERE p.id IN (${ids.map(() => '?').join(',')})
     ${opts.search ? 'AND (p.nomor_pinjaman LIKE ? OR a.nama_lengkap LIKE ?)' : ''}
     ORDER BY p.nomor_pinjaman ASC`,
    ...ids,
    ...(opts.search ? [`%${opts.search}%`, `%${opts.search}%`] : [])
  );

  const byId = new Map(macet.map((k) => [k.pinjamanId, k]));
  return rows.map((r) => ({
    id: r.id,
    nomorPinjaman: r.nomor_pinjaman,
    anggotaId: r.anggota_id,
    namaAnggota: r.nama_lengkap,
    jumlahPinjaman: r.jumlah_pinjaman,
    sisaPiutang: byId.get(r.id)!.saldoPiutang,
    tenor: r.tenor,
    satuanTenor: r.satuan_tenor,
    status: r.status,
    tanggalJatuhTempo: r.tanggal_jatuh_tempo,
    hariTunggakan: byId.get(r.id)!.hariTunggakan,
  }));
}
