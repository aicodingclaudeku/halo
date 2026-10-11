import { DataLaporanExport, BarisRingkasan, SeksiLaporan, TingkatBarisLaporan } from './ExportTypes';
import { formatRupiah } from '@/utils/money';
import { hitungKomposisiPendapatanLhu, formatPersenKomposisi } from '@/reports/KomposisiPendapatanLhu';
// RC-S101 — LPEA. `LpeaPlan` adalah modul MURNI (tidak mengimpor
// database/native), jadi label & keterbatasannya boleh diimpor sebagai
// value ke builder export — pola yang sama dengan KolektibilitasSomService.
import {
  KETERBATASAN_STRUKTURAL,
  LABEL_KELOMPOK_PEA,
  LABEL_STATUS_KOMPONEN,
  type LaporanLpea,
} from '@/reports/LpeaPlan';
import type { RincianShuAnggotaLpea } from '@/reports/LpeaRepository';
import { LABEL_KELOMPOK_OCI } from '@/config/ociPolicy';
import type { Anggota } from '@/repositories/AnggotaRepository';
import type { HistoriTransaksiRow } from '@/repositories/AnggotaRepository';
import type { SimpananHistoriRow } from '@/services/SimpananService';
import type { PinjamanListItem, JadwalAngsuranItem } from '@/services/PinjamanService';
import type { LedgerLine, TrialBalanceResult } from '@/accounting/Ledger';
import type {
  PosisiKeuanganResult,
  PosisiKeuanganKomparatif,
  LabaRugiResult,
  LhuResult,
  LhuKomparatif,
  InformasiShuRatResult,
  PerubahanEkuitasResult,
  PerubahanEkuitasKomparatif,
  ArusKasResult,
  ArusKasKomparatif,
  CalkResult,
} from '@/reports/FinancialReports';
import type { ShuAnggotaRow, ShuKonfigurasiRow } from '@/services/ShuService';
import type { BuktiBayarPiutangRow, BuktiBayarUtangRow, BuktiBayarSimpananRow, BuktiTarikSimpananRow, BuktiKeluarAnggotaRow } from '@/services/BuktiTransaksiService';
import type { KlasifikasiPinjamanItem } from '@/services/LoanImpairmentService';
import { ringkasPenyelesaian, type JalurPenyelesaian } from '@/accounting/PenyelesaianPinjaman';
import type { KlasifikasiFiskalItem } from '@/services/KolektibilitasFiskalService';
// KolektibilitasSomService adalah mesin aturan MURNI (tidak mengimpor
// `@/database/db` maupun `expo-sqlite`), jadi label & urutan kategorinya
// BOLEH diimpor sebagai value ke builder export — tidak seperti
// LoanImpairmentService, yang rantai importnya menarik modul native.
// Itulah sebabnya label kolektibilitas TIDAK LAGI ditulis ulang di sini.
import {
  KOLEKTIBILITAS_SOM_URUT,
  LABEL_KOLEKTIBILITAS_SOM,
  PERSENTASE_PENYISIHAN_SOM,
  type KolektibilitasSom,
} from '@/services/KolektibilitasSomService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import type { RingkasanSimpananBerjangka, SimpananBerjangkaRow } from '@/services/SimpananBerjangkaService';
import type { BarisStatusPeriodeBunga } from '@/services/SimpananBerjangkaLifecycleService';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { judulRentangHistori, periodeRentangHistori, saringHistoriPerRentang, type RentangHistori } from '@/utils/rentangHistori';
import {
  tampilanArusKasJuklat,
  tampilanCalkJuklat,
  tampilanEkuitasJuklat,
  tampilanLhuJuklat,
  tampilanPosisiJuklat,
} from './JuklatPdf';
import {
  KODE_BARIS_SHU_BERJALAN,
  URUTAN_PENYAJIAN_ASET,
  URUTAN_PENYAJIAN_EKUITAS,
  urutkanUntukPenyajian,
} from '@/reports/UrutanPenyajianPosisiKeuangan';
import {
  susunBagianArusKas,
  CATATAN_PENYAJIAN,
  LABEL_KENAIKAN,
  LABEL_SALDO_AWAL,
  LABEL_SALDO_AKHIR,
} from '@/reports/ArusKasJuklat';

/**
 * Builder MURNI (tanpa I/O) yang mengubah hasil repository/service yang
 * SUDAH ADA menjadi `DataLaporanExport` generik — satu struktur yang
 * dipakai seluruh pipeline export (CSV/Excel/PDF). Tidak ada data baru
 * yang diambil dari database di sini, dan tidak ada data dummy — semua
 * input berasal dari fungsi yang sudah dites di fase-fase sebelumnya
 * (PRD §36, fase 6: "gunakan data asli, jangan data dummy").
 *
 * Pola ini sama dengan PinjamanCalculator.ts/ShuCalculator.ts/
 * BackupValidator.ts: logika murni terpisah dari I/O, supaya testable.
 */

export interface InfoKoperasiExport {
  namaKoperasi: string;
  alamatKoperasi?: string;
  standarAkuntansi?: string;
}

// ============================================================
// 1. DAFTAR ANGGOTA
// ============================================================
const JENIS_KELAMIN_LABEL: Record<'LAKI_LAKI' | 'PEREMPUAN', string> = {
  LAKI_LAKI: 'Laki-laki',
  PEREMPUAN: 'Perempuan',
};

export function buildDaftarAnggotaExport(
  info: InfoKoperasiExport,
  daftar: Anggota[],
  tanggalCetak: string
): DataLaporanExport {
  return {
    judulLaporan: 'Daftar Anggota',
    namaFileDasar: 'daftar-anggota',
    ...info,
    periodeLabel: `Per ${tanggalCetak}`,
    // Bug fix (dilaporkan pengguna — "di PDF tidak ada jenis kelamin"):
    // kolom "Jenis Kelamin" belum pernah ditambahkan ke export Daftar
    // Anggota sejak field ini ada di form (§8) — field-nya sudah
    // tersimpan di database & sudah tampil di form, cuma belum
    // ditarik ke builder export ini. Ditaruh tepat setelah "Nama
    // Lengkap" (posisi wajar untuk data identitas dasar).
    kolom: ['No. Anggota', 'NIK', 'Nama Lengkap', 'Jenis Kelamin', 'Alamat', 'No. HP', 'Tgl Bergabung', 'Status'],
    baris: daftar.map((a) => [
      a.nomorAnggota,
      a.nik ?? '-',
      a.namaLengkap,
      a.jenisKelamin ? JENIS_KELAMIN_LABEL[a.jenisKelamin] : '-',
      a.alamat ?? '-',
      a.nomorHp ?? '-',
      a.tanggalBergabung,
      a.status,
    ]),
    kolomAngka: [],
    ringkasan: [{ label: 'Total Anggota', nilai: `${daftar.length}` }],
  };
}

// ============================================================
// 2. SIMPANAN ANGGOTA
// ============================================================
const JENIS_SIMPANAN_LABEL: Record<'POKOK' | 'WAJIB' | 'SUKARELA', string> = {
  POKOK: 'Simpanan Pokok',
  WAJIB: 'Simpanan Wajib',
  SUKARELA: 'Simpanan Sukarela',
};

/**
 * `jenisFilter` opsional: array 1-3 dari POKOK/WAJIB/SUKARELA yang
 * dicentang user (checklist di SimpananHistoriScreen) — kalau cuma
 * satu dicentang (mis. hanya Pokok), laporan HANYA berisi transaksi
 * jenis itu & judulnya otomatis jadi "Simpanan Pokok Anggota". Kalau
 * kosong/tidak diisi dianggap "semua jenis" (judul default).
 *
 * `totalSeluruhAnggota` opsional: saldo total per jenis di SELURUH
 * koperasi (bukan cuma yang ada di histori transaksi yang tampil) —
 * ditambahkan sebagai baris ringkasan ekstra kalau user mencentang
 * "Total Simpanan Seluruh Anggota". Hanya jenis yang ada di
 * `jenisFilter` yang totalnya ditampilkan, konsisten dengan filter
 * transaksi (mis. cuma centang Pokok -> cuma "Total Simpanan Pokok
 * Seluruh Anggota" yang muncul, bukan ketiga jenis).
 */
export function buildSimpananExport(
  info: InfoKoperasiExport,
  daftar: SimpananHistoriRow[],
  periodeLabel: string,
  jenisFilter?: ('POKOK' | 'WAJIB' | 'SUKARELA')[],
  totalSeluruhAnggota?: { pokok: number; wajib: number; sukarela: number }
): DataLaporanExport {
  const totalSetor = daftar.filter((d) => d.tipe === 'SETOR').reduce((a, d) => a + d.nominal, 0);
  const totalTarik = daftar.filter((d) => d.tipe === 'TARIK').reduce((a, d) => a + d.nominal, 0);

  const jenisDipilih = jenisFilter && jenisFilter.length > 0 && jenisFilter.length < 3 ? jenisFilter : undefined;
  const judul = jenisDipilih
    ? `${jenisDipilih.map((j) => JENIS_SIMPANAN_LABEL[j]).join(' & ')} Anggota`
    : 'Simpanan Anggota';
  const namaFile = jenisDipilih
    ? `simpanan-${jenisDipilih.map((j) => j.toLowerCase()).join('-')}-anggota`
    : 'simpanan-anggota';

  const ringkasan: BarisRingkasan[] = [
    { label: 'Total Setoran', nilai: formatRupiah(totalSetor) },
    { label: 'Total Penarikan', nilai: formatRupiah(totalTarik) },
  ];

  if (totalSeluruhAnggota) {
    const jenisUntukTotal: ('POKOK' | 'WAJIB' | 'SUKARELA')[] =
      jenisFilter && jenisFilter.length > 0 ? jenisFilter : ['POKOK', 'WAJIB', 'SUKARELA'];
    const nilaiPerJenis: Record<'POKOK' | 'WAJIB' | 'SUKARELA', number> = {
      POKOK: totalSeluruhAnggota.pokok,
      WAJIB: totalSeluruhAnggota.wajib,
      SUKARELA: totalSeluruhAnggota.sukarela,
    };
    for (const j of jenisUntukTotal) {
      ringkasan.push({
        label: `Total ${JENIS_SIMPANAN_LABEL[j]} Seluruh Anggota`,
        nilai: formatRupiah(nilaiPerJenis[j]),
      });
    }
    if (jenisUntukTotal.length > 1) {
      const grandTotal = jenisUntukTotal.reduce((a, j) => a + nilaiPerJenis[j], 0);
      ringkasan.push({ label: 'Total Simpanan Seluruh Anggota', nilai: formatRupiah(grandTotal) });
    }
  }

  return {
    judulLaporan: judul,
    namaFileDasar: namaFile,
    ...info,
    periodeLabel,
    kolom: ['Tanggal', 'No. Transaksi', 'Nama Anggota', 'Jenis', 'Tipe', 'Nominal', 'Keterangan'],
    baris: daftar.map((d) => [
      d.tanggal,
      d.nomorTransaksi,
      d.namaAnggota,
      d.jenis,
      d.tipe,
      d.nominal,
      d.keterangan ?? '-',
    ]),
    kolomAngka: [5],
    ringkasan,
  };
}

// ============================================================
// 2b. DETAIL SATU ANGGOTA (kartu ringkasan + histori transaksi)
// ============================================================
export interface RingkasanAnggotaExport {
  simpananPokok: number;
  simpananWajib: number;
  simpananSukarela: number;
  totalPinjaman: number;
  totalAngsuran: number;
  sisaPinjaman: number;
  // Permintaan pengguna §5: pemecahan "Sisa Pinjaman" (yang sudah ada,
  // gabungan pokok+jasa belum terbayar) menjadi 2 komponen terpisah —
  // sisaPinjamanPokok + sisaJasaPinjaman = sisaPinjaman PERSIS (tidak
  // dijumlah dobel), memakai definisi outstanding yang SAMA dengan
  // `saldo_pokok`/`saldo_piutang` di LoanImpairmentService.ts (SUM dari
  // angsuran_jadwal pinjaman AKTIF anggota ini, bukan nilai pinjaman awal).
  sisaPinjamanPokok: number;
  sisaJasaPinjaman: number;
  /**
   * REQUIREMENT 2 (permintaan pengguna) — Kolektibilitas Piutang
   * Anggota. Nilainya berasal dari
   * `LoanImpairmentService.getKolektibilitasAnggota()` (mesin aging &
   * penyisihan yang SAMA dipakai layar Kolektibilitas Piutang) — TIDAK
   * dihitung ulang di sini, TIDAK hardcode. undefined kalau data
   * kolektibilitas belum termuat (export tetap jalan tanpa baris ini,
   * bukan crash).
   */
  kolektibilitas?: {
    kategoriLabel: string;
    hariTunggakan: number;
    jumlahPinjamanAktif: number;
    totalOutstanding: number;
    totalPokok: number;
    totalCadangan: number;
  };
}

/**
 * RC-S83 — data Simpanan Berjangka untuk export Detail Anggota.
 *
 * SEMUA nilai berasal dari service yang SUDAH dipakai layar Detail
 * Anggota (tidak ada kueri/perhitungan baru di builder):
 *  - `ringkasan`   : `getRingkasanSimpananBerjangka()` (kontrak AKTIF & JATUH_TEMPO)
 *  - `kontrak`     : `listSimpananBerjangka(anggotaId)` (SELURUH kontrak, termasuk yang sudah dicairkan/dibatalkan)
 *  - `periodeBunga`: `getStatusPeriodeBungaAnggota()` (objek yang SAMA dengan yang dirender di layar)
 */
export interface BerjangkaAnggotaExport {
  ringkasan: RingkasanSimpananBerjangka;
  kontrak: SimpananBerjangkaRow[];
  periodeBunga: BarisStatusPeriodeBunga[];
}

const LABEL_STATUS_ANGGOTA: Record<string, string> = {
  AKTIF: 'Aktif',
  TIDAK_AKTIF: 'Tidak Aktif',
  KELUAR: 'Keluar',
  MENINGGAL: 'Meninggal Dunia',
};

const LABEL_STATUS_BERJANGKA: Record<string, string> = {
  AKTIF: 'Aktif',
  JATUH_TEMPO: 'Jatuh Tempo',
  DICAIRKAN: 'Dicairkan',
  DIBATALKAN: 'Dibatalkan',
};

const LABEL_STATUS_PERIODE_BUNGA: Record<string, string> = {
  SUDAH_DIPINDAHKAN: 'Sudah Dipindahkan',
  SIAP_DIPINDAHKAN: 'Siap Dipindahkan',
  BELUM_JATUH_TEMPO: 'Belum Jatuh Tempo',
};

/** 'YYYY-MM-DD' -> "1 Juni 2026"; nilai kosong/tak valid dikembalikan apa adanya atau '-'. */
function tglId(iso: string | null | undefined): string {
  if (!iso) return '-';
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? formatTanggalIndonesia(iso.slice(0, 10)) : iso;
}

const BULAN_PENDEK = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** 'YYYY-MM-DD' -> "10 Jan 2025" — dipakai kolom tanggal pada tabel yang padat. */
function tglPendek(iso: string | null | undefined): string {
  if (!iso) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${parseInt(m[3], 10)} ${BULAN_PENDEK[parseInt(m[2], 10) - 1] ?? m[2]} ${m[1]}` : iso;
}

/** Label tampilan untuk kode enum: "SIMPANAN_POKOK" -> "Simpanan Pokok". */
function labelKode(kode: string): string {
  return kode
    .toLowerCase()
    .split('_')
    .map((k) => (k ? k[0].toUpperCase() + k.slice(1) : k))
    .join(' ');
}

function formatSukuBunga(persen: number): string {
  return persen > 0 ? `${String(persen).replace('.', ',')}% p.a.` : 'Tanpa bunga';
}

/**
 * Export "Detail Anggota" — kartu ringkasan satu anggota (identitas,
 * saldo simpanan per jenis, simpanan berjangka, posisi pinjaman) +
 * seluruh histori transaksinya, dipakai dari tombol Export di
 * AnggotaDetailScreen. Beda dari buildDaftarAnggotaExport (daftar SEMUA
 * anggota) — ini fokus ke SATU anggota secara lengkap.
 *
 * RC-S83: parameter `berjangka` (opsional, additive) menambahkan
 * Simpanan Berjangka ke export — sebelumnya bagian ini tidak ikut
 * ter-export sama sekali walaupun tampil di layar. Output juga kini
 * mengisi `seksi`, sehingga PDF/Excel/CSV tersusun per bagian seperti
 * dokumen rekening anggota, bukan satu tabel histori dengan daftar
 * label campur-aduk di bawahnya. Struktur datar (`kolom`/`baris`/
 * `ringkasan`) tetap diisi dengan label yang SAMA seperti sebelumnya.
 */
export function buildAnggotaDetailExport(
  info: InfoKoperasiExport,
  anggota: Anggota,
  ringkasan: RingkasanAnggotaExport,
  histori: HistoriTransaksiRow[],
  tanggalCetak: string,
  berjangka?: BerjangkaAnggotaExport,
  /**
   * Rentang histori transaksi yang diekspor (default SEMUA = perilaku lama).
   * Hanya memengaruhi seksi Histori Transaksi; saldo simpanan, berjangka,
   * dan pinjaman tetap posisi per tanggal cetak.
   */
  rentangHistori: RentangHistori = 'SEMUA'
): DataLaporanExport {
  const historiSemua = histori;
  histori = saringHistoriPerRentang(historiSemua, rentangHistori, tanggalCetak);
  const totalSimpanan = ringkasan.simpananPokok + ringkasan.simpananWajib + ringkasan.simpananSukarela;

  // RC-S83.1 (permintaan pengguna) — bagian yang TIDAK dimiliki anggota
  // tidak ditampilkan di export. Kriteria memakai angka yang SUDAH ada
  // (tidak ada kueri baru):
  //  - Simpanan  : saldo Pokok/Wajib/Sukarela; jenis bersaldo 0 tidak
  //                dicantumkan, seksi hilang bila ketiganya 0.
  //  - Berjangka : ringkasan hanya bila ada kontrak berjalan (sama dengan
  //                syarat kartu di layar); rincian kontrak bila anggota
  //                pernah punya kontrak; jadwal bunga bila ada periodenya.
  //  - Pinjaman  : hilang bila tidak ada pinjaman (aktif maupun lunas),
  //                tidak ada angsuran dibayar, dan tidak ada sisa.
  const jenisSimpanan: [string, number][] = (
    [
      ['Simpanan Pokok', ringkasan.simpananPokok],
      ['Simpanan Wajib', ringkasan.simpananWajib],
      ['Simpanan Sukarela', ringkasan.simpananSukarela],
    ] as [string, number][]
  ).filter(([, saldo]) => saldo !== 0);
  const adaKontrakBerjangka = !!berjangka && (berjangka.kontrak.length > 0 || berjangka.ringkasan.jumlahKontrakAktif > 0);
  const adaPinjaman =
    ringkasan.totalPinjaman !== 0 ||
    ringkasan.totalAngsuran !== 0 ||
    ringkasan.sisaPinjaman !== 0 ||
    !!ringkasan.kolektibilitas;

  const ringkasanBerjangka: BarisRingkasan[] = berjangka && adaKontrakBerjangka
    ? [
        { label: 'Simpanan Berjangka (Pokok)', nilai: formatRupiah(berjangka.ringkasan.saldoPokok) },
        { label: 'Kontrak Simpanan Berjangka Aktif', nilai: String(berjangka.ringkasan.jumlahKontrakAktif) },
        { label: 'Bunga Simpanan Berjangka Terakru', nilai: formatRupiah(berjangka.ringkasan.bungaTerakru) },
      ]
    : [];

  // ---------------- SEKSI DOKUMEN ----------------
  const seksi: SeksiLaporan[] = [];

  const identitas: BarisRingkasan[] = [
    { label: 'Nama Lengkap', nilai: anggota.namaLengkap },
    { label: 'Nomor Anggota', nilai: anggota.nomorAnggota },
    { label: 'NIK', nilai: anggota.nik || '-' },
    { label: 'Status Keanggotaan', nilai: LABEL_STATUS_ANGGOTA[anggota.status] ?? anggota.status },
    { label: 'Tanggal Bergabung', nilai: tglId(anggota.tanggalBergabung) },
  ];
  if (anggota.jenisKelamin) {
    identitas.push({ label: 'Jenis Kelamin', nilai: anggota.jenisKelamin === 'LAKI_LAKI' ? 'Laki-laki' : 'Perempuan' });
  }
  if (anggota.tempatLahir || anggota.tanggalLahir) {
    identitas.push({
      label: 'Tempat, Tanggal Lahir',
      nilai: [anggota.tempatLahir, anggota.tanggalLahir ? tglId(anggota.tanggalLahir) : ''].filter(Boolean).join(', '),
    });
  }
  if (anggota.pekerjaan) identitas.push({ label: 'Pekerjaan', nilai: anggota.pekerjaan });
  if (anggota.nomorHp) identitas.push({ label: 'Nomor HP', nilai: anggota.nomorHp });
  if (anggota.alamat) identitas.push({ label: 'Alamat', nilai: anggota.alamat });
  seksi.push({ jenis: 'KV', judul: 'Data Anggota', baris: identitas });

  if (jenisSimpanan.length > 0) {
    seksi.push({
      jenis: 'TABEL',
      judul: 'Simpanan',
      kolom: ['Jenis Simpanan', 'Saldo'],
      kolomAngka: [1],
      baris: jenisSimpanan,
      barisTotal: ['Total Simpanan', totalSimpanan],
    });
  }

  if (berjangka && berjangka.ringkasan.jumlahKontrakAktif > 0) {
    const r = berjangka.ringkasan;
    seksi.push({
      jenis: 'KV',
      judul: 'Simpanan Berjangka',
      baris: [
        { label: 'Saldo Pokok (kontrak berjalan)', nilai: formatRupiah(r.saldoPokok) },
        { label: 'Kontrak Berjalan', nilai: `${r.jumlahKontrakAktif} kontrak` },
        { label: 'Jatuh Tempo Terdekat', nilai: tglId(r.jatuhTempoTerdekat) },
        { label: 'Suku Bunga', nilai: r.rentangSukuBunga ? `${r.rentangSukuBunga.replace(/\./g, ',')} p.a.` : 'Tanpa bunga' },
        { label: 'Bunga Terakru (belum dibayar)', nilai: formatRupiah(r.bungaTerakru) },
      ],
      labelTebal: ['Saldo Pokok (kontrak berjalan)'],
      catatan:
        'Saldo pokok tidak termasuk bunga. Pokok tercatat pada akun Simpanan Anggota (Berjangka); ' +
        'bunga terakru pada akun Utang Bunga Simpanan Berjangka.',
    });
  }

  if (berjangka && berjangka.kontrak.length > 0) {
    const kontrakUrut = [...berjangka.kontrak].sort((a, b) =>
      a.tanggalMulai === b.tanggalMulai ? a.nomorTransaksi.localeCompare(b.nomorTransaksi) : a.tanggalMulai < b.tanggalMulai ? -1 : 1
    );
    seksi.push({
      jenis: 'TABEL',
      judul: 'Rincian Kontrak Simpanan Berjangka',
      kolom: ['No. Kontrak', 'Tgl Mulai', 'Jatuh Tempo', 'Tenor', 'Suku Bunga', 'Pokok', 'Bunga Terakru', 'Bunga Dibayar', 'Status'],
      kolomAngka: [5, 6, 7],
      baris: kontrakUrut.map((k) => [
        k.nomorTransaksi,
        tglPendek(k.tanggalMulai),
        tglPendek(k.tanggalJatuhTempo),
        `${k.tenorBulan} bulan`,
        formatSukuBunga(k.sukuBungaPerTahun),
        k.nominal,
        k.bungaTerakru,
        k.bungaDibayar,
        (LABEL_STATUS_BERJANGKA[k.status] ?? k.status) + (k.tanggalPencairan ? ` (${tglPendek(k.tanggalPencairan)})` : ''),
      ]),
      catatan: 'Memuat seluruh kontrak, termasuk yang sudah dicairkan atau dibatalkan.',
    });
  }

  if (berjangka && berjangka.periodeBunga.length > 0) {
    const totalBunga = berjangka.periodeBunga.reduce((a, p) => a + p.bunga, 0);
    seksi.push({
      jenis: 'TABEL',
      judul: 'Jadwal Bunga Simpanan Berjangka per Periode',
      kolom: ['No. Kontrak', 'Periode', 'Akhir Periode', 'Bunga', 'Status'],
      kolomAngka: [3],
      baris: berjangka.periodeBunga.map((p) => [
        p.nomorKontrak,
        `Ke-${p.nomorPeriode}`,
        tglId(p.tanggalAkhirPeriode),
        p.bunga,
        LABEL_STATUS_PERIODE_BUNGA[p.status] ?? p.status,
      ]),
      barisTotal: ['Total', '', '', totalBunga, ''],
      catatan:
        'Bunga yang sudah dipindahkan menambah Simpanan Sukarela anggota dan tidak dibayarkan lagi saat pencairan kontrak.',
    });
  }

  if (adaPinjaman) {
    const pinjamanKv: BarisRingkasan[] = [];
    if (ringkasan.kolektibilitas) {
      const k = ringkasan.kolektibilitas;
      pinjamanKv.push(
        { label: 'Kolektibilitas Piutang', nilai: k.kategoriLabel },
        { label: 'Tunggakan Terlama', nilai: `${k.hariTunggakan} hari` },
        { label: 'Jumlah Pinjaman Aktif', nilai: `${k.jumlahPinjamanAktif} pinjaman` },
        { label: 'Outstanding Piutang', nilai: formatRupiah(k.totalOutstanding) },
        { label: 'Penyisihan (Cadangan) Piutang', nilai: formatRupiah(k.totalCadangan) }
      );
    } else {
      pinjamanKv.push({ label: 'Kolektibilitas Piutang', nilai: 'Tidak ada pinjaman aktif' });
    }
    pinjamanKv.push(
      { label: 'Sisa Pinjaman Pokok', nilai: formatRupiah(ringkasan.sisaPinjamanPokok) },
      { label: 'Sisa Jasa Pinjaman', nilai: formatRupiah(ringkasan.sisaJasaPinjaman) },
      { label: 'Total Angsuran Dibayar', nilai: formatRupiah(ringkasan.totalAngsuran) },
      { label: 'Sisa Pinjaman', nilai: formatRupiah(ringkasan.sisaPinjaman) }
    );
    seksi.push({ jenis: 'KV', judul: 'Pinjaman', baris: pinjamanKv, labelTebal: ['Sisa Pinjaman'] });
  }

  // Histori ditampilkan kronologis (lama -> baru), lazimnya rekening koran.
  const historiUrut = [...histori].sort((a, b) => (a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : 0));
  const rentangDipilih = rentangHistori !== 'SEMUA';
  seksi.push({
    jenis: 'TABEL',
    judul: rentangDipilih ? `Histori Transaksi — ${judulRentangHistori(rentangHistori)}` : 'Histori Transaksi',
    kolom: ['No.', 'Tanggal', 'Jenis Transaksi', 'Keterangan', 'No. Referensi', 'Nominal'],
    kolomAngka: [5],
    baris: historiUrut.map((h, i) => [
      String(i + 1),
      tglId(h.tanggal),
      h.jenis.replace(/Simpanan ([A-Z_]+)/, (_m, j: string) => `Simpanan ${labelKode(j)}`),
      /^[A-Z_]+$/.test(h.tipe) ? labelKode(h.tipe) : h.tipe,
      h.nomorReferensi ?? '-',
      h.nominal,
    ]),
    teksKosong: rentangDipilih
      ? `Tidak ada transaksi pada periode ${periodeRentangHistori(rentangHistori, tanggalCetak)}.`
      : 'Belum ada transaksi.',
    catatan:
      histori.length === 0
        ? undefined
        : (rentangDipilih
            ? `Periode ${periodeRentangHistori(rentangHistori, tanggalCetak)}: ${histori.length} dari ${historiSemua.length} transaksi. `
            : '') +
          `Total ${histori.length} transaksi.` +
          (berjangka && berjangka.kontrak.length > 0
            ? ' Setoran dan pencairan simpanan berjangka tercantum pada Rincian Kontrak di atas.'
            : ''),
  });

  return {
    judulLaporan: `Detail Anggota - ${anggota.namaLengkap}`,
    namaFileDasar: `detail-anggota-${anggota.nomorAnggota}${rentangDipilih ? `-histori-${rentangHistori.toLowerCase().replace('_', '-')}` : ''}`,
    ...info,
    periodeLabel: `Per ${tglId(tanggalCetak)}`,
    kolom: ['Tanggal', 'Jenis', 'Tipe', 'No. Referensi', 'Nominal'],
    baris: histori.map((h) => [h.tanggal, h.jenis, h.tipe, h.nomorReferensi, h.nominal]),
    kolomAngka: [4],
    ringkasan: [
      { label: 'Nomor Anggota', nilai: anggota.nomorAnggota },
      { label: 'NIK', nilai: anggota.nik ?? '-' },
      { label: 'Status', nilai: anggota.status },
      { label: 'Tanggal Bergabung', nilai: anggota.tanggalBergabung },
      { label: 'Simpanan Pokok', nilai: formatRupiah(ringkasan.simpananPokok) },
      { label: 'Simpanan Wajib', nilai: formatRupiah(ringkasan.simpananWajib) },
      { label: 'Simpanan Sukarela', nilai: formatRupiah(ringkasan.simpananSukarela) },
      { label: 'Total Simpanan', nilai: formatRupiah(totalSimpanan) },
      // RC-S83 — Simpanan Berjangka SESUDAH total Pokok/Wajib/Sukarela
      // dan TIDAK dijumlahkan ke "Total Simpanan" (domain terpisah, §22).
      ...ringkasanBerjangka,
      // REQUIREMENT 2 — kolektibilitas ditempatkan DI ATAS Pinjaman
      // Pokok, urutan yang SAMA dengan layar Detail Anggota.
      ...(ringkasan.kolektibilitas
        ? [
            { label: 'Kolektibilitas Piutang Anggota', nilai: ringkasan.kolektibilitas.kategoriLabel },
            { label: 'Hari Tunggakan Terlama', nilai: `${ringkasan.kolektibilitas.hariTunggakan} hari` },
            { label: 'Jumlah Pinjaman Aktif', nilai: String(ringkasan.kolektibilitas.jumlahPinjamanAktif) },
            { label: 'Outstanding Piutang', nilai: formatRupiah(ringkasan.kolektibilitas.totalOutstanding) },
            { label: 'Penyisihan (Cadangan) Piutang', nilai: formatRupiah(ringkasan.kolektibilitas.totalCadangan) },
          ]
        : []),
      { label: 'Pinjaman Pokok (Sisa)', nilai: formatRupiah(ringkasan.sisaPinjamanPokok) },
      { label: 'Jasa Pinjaman (Sisa)', nilai: formatRupiah(ringkasan.sisaJasaPinjaman) },
      { label: 'Total Angsuran Dibayar', nilai: formatRupiah(ringkasan.totalAngsuran) },
      { label: 'Sisa Pinjaman', nilai: formatRupiah(ringkasan.sisaPinjaman) },
    ],
    seksi,
    nomorDokumen:
      `Detail Anggota ${anggota.nomorAnggota} · per ${tglId(tanggalCetak)}` +
      (rentangDipilih ? ` · histori ${judulRentangHistori(rentangHistori).toLowerCase()}` : ''),
  };
}

// ============================================================
// 3. PINJAMAN
// ============================================================
export function buildPinjamanExport(
  info: InfoKoperasiExport,
  daftar: PinjamanListItem[],
  tanggalCetak: string
): DataLaporanExport {
  const totalPinjaman = daftar.reduce((a, d) => a + d.jumlahPinjaman, 0);
  return {
    judulLaporan: 'Daftar Pinjaman',
    namaFileDasar: 'daftar-pinjaman',
    ...info,
    periodeLabel: `Per ${tanggalCetak}`,
    kolom: ['No. Pinjaman', 'Nama Anggota', 'Jumlah Pinjaman', 'Tenor', 'Jatuh Tempo', 'Status'],
    baris: daftar.map((d) => [
      d.nomorPinjaman,
      d.namaAnggota,
      d.jumlahPinjaman,
      `${d.tenor} ${d.satuanTenor.toLowerCase()}`,
      d.tanggalJatuhTempo,
      d.status,
    ]),
    kolomAngka: [2],
    ringkasan: [{ label: 'Total Pinjaman', nilai: formatRupiah(totalPinjaman) }],
  };
}

// ============================================================
// 4. ANGSURAN (jadwal angsuran satu pinjaman)
// ============================================================
/**
 * REQUIREMENT 6 (permintaan pengguna) — bagian jadwal angsuran yang
 * di-export. `judul`/`namaFile` mengikuti bagian yang dipilih supaya
 * file hasil export tidak pernah rancu isinya.
 */
export type BagianAngsuranExport = 'AKTIF' | 'RESTRUKTURISASI' | 'AKAD_ULANG';

const JUDUL_BAGIAN_ANGSURAN: Record<BagianAngsuranExport, { judul: string; file: string }> = {
  AKTIF: { judul: 'Angsuran Aktif', file: 'angsuran-aktif' },
  RESTRUKTURISASI: { judul: 'Angsuran Restrukturisasi (Histori)', file: 'angsuran-restrukturisasi' },
  AKAD_ULANG: { judul: 'Angsuran Akad Ulang', file: 'angsuran-akad-ulang' },
};

/**
 * REQUIREMENT 6 — export jadwal angsuran PER BAGIAN.
 *
 * Sebelumnya fungsi ini menerima SELURUH baris `angsuran_jadwal` apa
 * adanya (termasuk baris berstatus DIRESTRUKTURISASI & DIHAPUSBUKU),
 * sehingga export "Angsuran Aktif" ikut memuat angsuran restrukturisasi
 * dan angsuran lama yang sudah tidak berlaku — persis yang dilarang
 * requirement.
 *
 * Pemanggil WAJIB mengirim baris yang sudah tersaring lewat
 * `isAngsuranAktif()`/`kelompokkanJadwalAngsuran()` di PinjamanService —
 * fungsi klasifikasi yang SAMA dipakai UI, jadi isi layar & isi file
 * export mustahil berbeda. Parameter `bagian` hanya menentukan
 * judul/nama file & ringkasan.
 */
export function buildAngsuranExport(
  info: InfoKoperasiExport,
  nomorPinjaman: string,
  namaAnggota: string,
  jadwal: JadwalAngsuranItem[],
  bagian: BagianAngsuranExport = 'AKTIF'
): DataLaporanExport {
  const totalTagihan = jadwal.reduce((a, j) => a + j.total, 0);
  const totalTerbayar = jadwal.reduce((a, j) => a + j.pokokTerbayar + j.jasaTerbayar + j.dendaTerbayar, 0);
  const meta = JUDUL_BAGIAN_ANGSURAN[bagian];
  return {
    judulLaporan: `${meta.judul} — ${nomorPinjaman}`,
    namaFileDasar: `${meta.file}-${nomorPinjaman}`,
    ...info,
    periodeLabel: `Anggota: ${namaAnggota}`,
    kolom: ['Angsuran Ke', 'Jatuh Tempo', 'Pokok', 'Jasa', 'Denda', 'Total', 'Status'],
    baris: jadwal.map((j) => [j.nomorAngsuran, j.tanggalJatuhTempo, j.pokok, j.jasa, j.denda, j.total, j.status]),
    kolomAngka: [2, 3, 4, 5],
    ringkasan: [
      { label: 'Bagian', nilai: meta.judul },
      { label: 'Jumlah Baris', nilai: String(jadwal.length) },
      { label: 'Total Tagihan', nilai: formatRupiah(totalTagihan) },
      { label: 'Total Terbayar', nilai: formatRupiah(totalTerbayar) },
    ],
  };
}

// ============================================================
// 5. BUKU BESAR
// ============================================================
export function buildBukuBesarExport(
  info: InfoKoperasiExport,
  namaAkun: string,
  ledger: LedgerLine[],
  periodeLabel: string
): DataLaporanExport {
  const totalDebit = ledger.reduce((a, l) => a + l.debit, 0);
  const totalKredit = ledger.reduce((a, l) => a + l.kredit, 0);
  const saldoAkhir = ledger.length > 0 ? ledger[ledger.length - 1].saldoBerjalan : 0;
  return {
    judulLaporan: `Buku Besar — ${namaAkun}`,
    namaFileDasar: `buku-besar-${namaAkun}`,
    ...info,
    periodeLabel,
    kolom: ['Tanggal', 'No. Jurnal', 'Keterangan', 'Debit', 'Kredit', 'Saldo'],
    baris: ledger.map((l) => [l.tanggal, l.nomorJurnal, l.keterangan, l.debit, l.kredit, l.saldoBerjalan]),
    kolomAngka: [3, 4, 5],
    ringkasan: [
      { label: 'Total Debit', nilai: formatRupiah(totalDebit) },
      { label: 'Total Kredit', nilai: formatRupiah(totalKredit) },
      { label: 'Saldo Akhir', nilai: formatRupiah(saldoAkhir) },
    ],
  };
}

// ============================================================
// 6. NERACA SALDO
// ============================================================
export function buildNeracaSaldoExport(
  info: InfoKoperasiExport,
  trial: TrialBalanceResult,
  tanggalCetak: string
): DataLaporanExport {
  return {
    judulLaporan: 'Neraca Saldo',
    namaFileDasar: 'neraca-saldo',
    ...info,
    periodeLabel: `Per ${tanggalCetak}`,
    kolom: ['Kode Akun', 'Nama Akun', 'Debit', 'Kredit'],
    baris: trial.rows.map((r) => [r.kode, r.nama, r.debit, r.kredit]),
    kolomAngka: [2, 3],
    ringkasan: [
      { label: 'Total Debit', nilai: formatRupiah(trial.totalDebit) },
      { label: 'Total Kredit', nilai: formatRupiah(trial.totalKredit) },
      { label: 'Status', nilai: trial.isBalanced ? 'Seimbang' : 'TIDAK SEIMBANG' },
    ],
  };
}

// ============================================================
// 7. LAPORAN POSISI KEUANGAN
// ============================================================
export function buildPosisiKeuanganExport(
  info: InfoKoperasiExport,
  data: PosisiKeuanganResult
): DataLaporanExport {
  // Poin 9/11 — urutan penyajian SAMA dengan layar (modul bersama):
  // RAKU tepat di bawah Piutang Jasa Pinjaman, baris SHU tahun berjalan
  // tepat di bawah Cadangan Risiko. Murni posisi baris; nilai & total
  // tetap dari service.
  const ekuitasDisajikan: { kode: string; nama: string; saldo: number }[] = [...data.ekuitas];
  if (data.labaBerjalan !== 0) {
    ekuitasDisajikan.push({ kode: KODE_BARIS_SHU_BERJALAN, nama: data.labaBerjalanLabel, saldo: data.labaBerjalan });
  }
  const baris: (string | number)[][] = [];
  baris.push(['ASET', '']);
  urutkanUntukPenyajian(data.aset, URUTAN_PENYAJIAN_ASET).forEach((r) => baris.push([r.nama, r.saldo]));
  baris.push(['Total Aset', data.totalAset]);
  baris.push(['LIABILITAS', '']);
  data.liabilitas.forEach((r) => baris.push([r.nama, r.saldo]));
  baris.push(['Total Liabilitas', data.totalLiabilitas]);
  baris.push(['EKUITAS', '']);
  urutkanUntukPenyajian(ekuitasDisajikan, URUTAN_PENYAJIAN_EKUITAS).forEach((r) => baris.push([r.nama, r.saldo]));
  baris.push(['Total Ekuitas', data.totalEkuitas]);

  return {
    judulLaporan: 'Laporan Posisi Keuangan',
    namaFileDasar: 'posisi-keuangan',
    ...info,
    // Audit ulang (permintaan pengguna §11): indikator jelas di export
    // kalau laporan ini menyertakan Saldo Awal yang masih DRAFT (belum
    // diposting) — supaya file yang diunduh/dibagikan tidak disalahpahami
    // sebagai laporan final.
    periodeLabel: data.termasukSaldoAwalDraft
      ? `Per ${data.asOfDate} (Termasuk Saldo Awal Draft — belum final)`
      : `Per ${data.asOfDate}`,
    kolom: ['Akun', 'Saldo'],
    baris,
    kolomAngka: [1],
    ringkasan: [
      { label: 'Total Aset', nilai: formatRupiah(data.totalAset) },
      { label: 'Total Liabilitas + Ekuitas', nilai: formatRupiah(data.totalLiabilitas + data.totalEkuitas) },
      {
        label: 'Status',
        nilai: data.isBalanced ? 'Seimbang' : `TIDAK SEIMBANG (selisih ${formatRupiah(Math.abs(data.selisih))})`,
      },
    ],
    laporanKeuangan: { tanggalAcuan: data.asOfDate, juklat: tampilanPosisiJuklat([data]) },
  };
}

/**
 * PHASE 6 §R (permintaan pengguna) — export Posisi Keuangan
 * KOMPARATIF. Pola SAMA PERSIS dengan
 * `buildPerubahanEkuitasKomparatifExport`/`buildArusKasKomparatifExport`
 * existing (kolom "Periode Berjalan"/"Periode Komparatif", union
 * kode akun dari kedua sisi — §S.10: akun baru yang cuma ada di satu
 * periode tetap ikut, bukan disembunyikan).
 */
export function buildPosisiKeuanganKomparatifExport(info: InfoKoperasiExport, data: PosisiKeuanganKomparatif): DataLaporanExport {
  function gabungSeksi(rowsSekarang: PosisiKeuanganResult['aset'], rowsPembanding: PosisiKeuanganResult['aset']) {
    const kodeSet = new Set<string>();
    rowsSekarang.forEach((r) => kodeSet.add(r.kode));
    rowsPembanding.forEach((r) => kodeSet.add(r.kode));
    const namaByKode = new Map<string, string>();
    rowsSekarang.forEach((r) => namaByKode.set(r.kode, r.nama));
    rowsPembanding.forEach((r) => namaByKode.set(r.kode, r.nama));
    const sekarangMap = new Map(rowsSekarang.map((r) => [r.kode, r.saldo]));
    const pembandingMap = new Map(rowsPembanding.map((r) => [r.kode, r.saldo]));
    return Array.from(kodeSet).map((kode) => ({
      kode,
      nama: namaByKode.get(kode) ?? kode,
      saldo: sekarangMap.get(kode) ?? 0,
      saldoPembanding: pembandingMap.get(kode) ?? 0,
    }));
  }
  type BarisGabung = ReturnType<typeof gabungSeksi>[number];
  const keBaris = (rows: BarisGabung[]) => rows.map((r) => [r.nama, r.saldo, r.saldoPembanding] as (string | number)[]);
  const [kolomSekarang, kolomPembanding] = labelKolomKomparatif(data.sekarang.asOfDate, data.pembanding.asOfDate);

  const baris: (string | number)[][] = [];
  baris.push(['ASET', '', '']);
  // Poin 11 — urutan penyajian SAMA dengan layar & mode tunggal.
  baris.push(...keBaris(urutkanUntukPenyajian(gabungSeksi(data.sekarang.aset, data.pembanding.aset), URUTAN_PENYAJIAN_ASET)));
  baris.push(['Total Aset', data.sekarang.totalAset, data.pembanding.totalAset]);
  baris.push(['LIABILITAS', '', '']);
  baris.push(...keBaris(gabungSeksi(data.sekarang.liabilitas, data.pembanding.liabilitas)));
  baris.push(['Total Liabilitas', data.sekarang.totalLiabilitas, data.pembanding.totalLiabilitas]);
  baris.push(['EKUITAS', '', '']);
  const ekuitasGabung = gabungSeksi(data.sekarang.ekuitas, data.pembanding.ekuitas);
  // REQUIREMENT 5 — BUG FIX: baris SHU/laba tahun berjalan SUDAH ikut
  // dijumlahkan ke `totalEkuitas` (lihat getPosisiKeuangan), tapi
  // SEBELUMNYA tidak pernah dirender di mode komparatif — baik di layar
  // maupun di file export. Akibatnya rincian Ekuitas tidak pernah sama
  // dengan Total Ekuitas-nya sendiri setiap kali ada laba berjalan.
  // Versi tunggal (buildPosisiKeuanganExport) sudah benar sejak awal;
  // sekarang keduanya konsisten. Baris ditampilkan kalau SALAH SATU
  // periode punya laba berjalan (bukan hanya periode berjalan).
  if (data.sekarang.labaBerjalan !== 0 || data.pembanding.labaBerjalan !== 0) {
    ekuitasGabung.push({
      kode: KODE_BARIS_SHU_BERJALAN,
      nama: data.sekarang.labaBerjalanLabel,
      saldo: data.sekarang.labaBerjalan,
      saldoPembanding: data.pembanding.labaBerjalan,
    });
  }
  // Poin 9 — baris SHU tahun berjalan tepat di bawah Cadangan Risiko.
  baris.push(...keBaris(urutkanUntukPenyajian(ekuitasGabung, URUTAN_PENYAJIAN_EKUITAS)));
  baris.push(['Total Ekuitas', data.sekarang.totalEkuitas, data.pembanding.totalEkuitas]);

  return {
    judulLaporan: 'Laporan Posisi Keuangan — Komparatif',
    namaFileDasar: 'posisi-keuangan-komparatif',
    ...info,
    periodeLabel: `Per ${data.sekarang.asOfDate} vs Per ${data.pembanding.asOfDate}`,
    kolom: ['Akun', kolomSekarang, kolomPembanding],
    baris,
    kolomAngka: [1, 2],
    // PDF format Juklat: kolom tahun LAMA di kiri, BERJALAN di kanan.
    laporanKeuangan: { tanggalAcuan: data.sekarang.asOfDate, juklat: tampilanPosisiJuklat([data.pembanding, data.sekarang]) },
    ringkasan: [
      { label: `Total Aset — ${kolomSekarang}`, nilai: formatRupiah(data.sekarang.totalAset) },
      { label: `Total Aset — ${kolomPembanding}`, nilai: formatRupiah(data.pembanding.totalAset) },
      { label: 'Perubahan Total Aset', nilai: formatRupiah(data.perubahanTotalAset) },
      // REQUIREMENT 5 — balance check WAJIB ada di kedua mode, tidak
      // hanya mode tunggal. Sebelumnya export komparatif sama sekali
      // tidak menyatakan apakah laporannya seimbang.
      {
        label: `Total Liabilitas + Ekuitas — ${kolomSekarang}`,
        nilai: formatRupiah(data.sekarang.totalLiabilitas + data.sekarang.totalEkuitas),
      },
      {
        label: `Total Liabilitas + Ekuitas — ${kolomPembanding}`,
        nilai: formatRupiah(data.pembanding.totalLiabilitas + data.pembanding.totalEkuitas),
      },
      {
        label: `Status ${kolomSekarang}`,
        nilai: data.sekarang.isBalanced
          ? 'Seimbang'
          : `TIDAK SEIMBANG (selisih ${formatRupiah(Math.abs(data.sekarang.selisih))})`,
      },
      {
        label: `Status ${kolomPembanding}`,
        nilai: data.pembanding.isBalanced
          ? 'Seimbang'
          : `TIDAK SEIMBANG (selisih ${formatRupiah(Math.abs(data.pembanding.selisih))})`,
      },
    ],
  };
}

// ============================================================
// 8. LAPORAN HASIL USAHA / LABA RUGI
// ============================================================
export function buildLabaRugiExport(info: InfoKoperasiExport, data: LabaRugiResult, judul: string): DataLaporanExport {
  const baris: (string | number)[][] = [];
  baris.push(['PENDAPATAN', '']);
  data.pendapatan.forEach((r) => baris.push([r.nama, r.jumlah]));
  baris.push(['Total Pendapatan', data.totalPendapatan]);
  baris.push(['BEBAN', '']);
  data.beban.forEach((r) => baris.push([r.nama, r.jumlah]));
  baris.push(['Total Beban', data.totalBeban]);
  baris.push(['Hasil Usaha Periode', data.hasilUsaha]);
  baris.push(['PENGHASILAN KOMPREHENSIF LAIN', '']);
  if (data.penghasilanKomprehensifLainRows.length === 0) {
    baris.push(['Penghasilan Komprehensif Lain (tidak ada transaksi OCI)', data.penghasilanKomprehensifLain]);
  } else {
    data.penghasilanKomprehensifLainRows.forEach((r) => baris.push([r.nama, r.jumlah]));
    baris.push(['Total Penghasilan Komprehensif Lain', data.penghasilanKomprehensifLain]);
  }
  baris.push(['TOTAL PENGHASILAN KOMPREHENSIF', data.totalPenghasilanKomprehensif]);

  return {
    judulLaporan: judul,
    namaFileDasar: 'hasil-usaha',
    ...info,
    periodeLabel: `${data.tanggalMulai} s.d. ${data.tanggalSelesai}`,
    kolom: ['Akun', 'Jumlah'],
    baris,
    kolomAngka: [1],
    ringkasan: [
      { label: 'Hasil Usaha Periode', nilai: formatRupiah(data.hasilUsaha) },
      { label: 'Total Penghasilan Komprehensif Periode', nilai: formatRupiah(data.totalPenghasilanKomprehensif) },
    ],
  };
}

// ============================================================
// 8b. LHU — LAPORAN HASIL USAHA (Revisi LHU KOPKU, struktur final
//     Bagian A) — RC-S88: setelah SHU Neto dilanjutkan PENGHASILAN
//     KOMPREHENSIF LAIN dan TOTAL PENGHASILAN KOMPREHENSIF (SAK EP).
// ============================================================

/**
 * RC-S98 — PENYUSUN BARIS LHU (satu sumber urutan & hierarki).
 *
 * Sebelumnya urutan baris ditulis dua kali (tunggal & komparatif) dan
 * tingkat baris tidak pernah dinyatakan, sehingga di PDF "Jumlah Beban
 * Usaha", "Sisa Hasil Usaha Bruto", dan satu baris akun tampil identik —
 * itulah "export tidak rapi" yang dilaporkan pengguna. Helper kecil ini
 * menyimpan label DAN `TingkatBarisLaporan` bersama-sama, sehingga
 * urutan/hierarki tidak bisa lepas satu dari yang lain lagi.
 *
 * KONVENSI TANDA: setiap beban dicatat NEGATIF di sini (beban usaha,
 * beban perkoperasian, beban lain, beban pajak) — bukan magnitudo positif
 * seperti sebelumnya untuk beban usaha. Dengan begitu kolom nominal
 * benar-benar berjumlah dari atas ke bawah persis seperti kolom pada
 * naskah Juklat SOM 3/2025 (yang menulisnya di dalam tanda kurung), dan
 * nominalnya tetap ANGKA sungguhan sehingga bisa dijumlahkan di Excel.
 * Sebagian jalur lama sudah negatif (beban lain & pajak); yang berubah
 * adalah beban usaha, jadi seluruh laporan kini konsisten.
 */
class PenyusunBarisLhu {
  readonly baris: (string | number)[][] = [];
  readonly tingkat: (TingkatBarisLaporan | undefined)[] = [];

  constructor(private readonly jumlahKolomNilai: number) {}

  private tambah(label: string, nilai: (string | number)[], tingkat: TingkatBarisLaporan) {
    this.baris.push([label, ...nilai]);
    this.tingkat.push(tingkat);
  }

  /** Band kelompok (PARTISIPASI ANGGOTA, BEBAN USAHA, ...) — tanpa nominal. */
  judul(label: string) {
    this.tambah(label, new Array(this.jumlahKolomNilai).fill(''), 'JUDUL');
  }

  rincian(label: string, ...nilai: number[]) {
    this.tambah(label, nilai, 'RINCIAN');
  }

  /** Rincian yang tidak ada isinya — ditulis eksplisit, bukan dihilangkan. */
  rincianKosong(teks: string) {
    this.tambah(teks, new Array(this.jumlahKolomNilai).fill(0), 'RINCIAN');
  }

  /**
   * RC-S101 — rincian yang nilainya berupa TEKS, bukan nominal (mis.
   * "Belum dapat dihitung"). Dipakai LPEA supaya komponen yang belum
   * punya tarif pembanding tidak tercetak sebagai angka nol yang tampak
   * sah. Kolom nilai tetap terisi supaya lebar tabel tidak berubah.
   */
  rincianTeks(label: string, teks: string) {
    const nilai = new Array(this.jumlahKolomNilai).fill('');
    nilai[0] = teks;
    this.tambah(label, nilai, 'RINCIAN');
  }

  subtotal(label: string, ...nilai: number[]) {
    this.tambah(label, nilai, 'SUBTOTAL');
  }

  total(label: string, ...nilai: number[]) {
    this.tambah(label, nilai, 'TOTAL');
  }
}

/**
 * Label periode berbahasa Indonesia untuk kop laporan — menggantikan
 * "2026-01-01 s.d. 2026-12-31" (format penyimpanan ISO, bukan format yang
 * layak dicetak di laporan resmi).
 */
function labelPeriodeLaporan(tanggalMulai: string, tanggalSelesai: string): string {
  return `Untuk periode ${formatTanggalIndonesia(tanggalMulai)} s.d. ${formatTanggalIndonesia(tanggalSelesai)}`;
}

/**
 * Poin 14 — label kolom laporan KOMPARATIF = TAHUN periode laporan
 * (mis. "2026" vs "2025"), diambil dari tanggal akhir periode tiap kolom
 * — tidak di-hardcode. Bila kedua kolom jatuh di tahun yang sama
 * (pembanding dipilih manual dalam tahun yang sama), tahun saja akan
 * ambigu, sehingga dipakai tanggal lengkap "31 Desember 2026".
 */
export function labelKolomKomparatif(tanggalSekarang: string, tanggalPembanding: string): [string, string] {
  const a = tanggalSekarang.slice(0, 4);
  const b = tanggalPembanding.slice(0, 4);
  if (a !== b) return [a, b];
  return [formatTanggalIndonesia(tanggalSekarang), formatTanggalIndonesia(tanggalPembanding)];
}

/** Baris ringkasan komposisi pendapatan (Lampiran Juklat SOM 3/2025) — lihat KomposisiPendapatanLhu.ts. */
function ringkasanKomposisiLhu(jumlahPartisipasiAnggota: number, totalHasilInvestasi: number): BarisRingkasan[] {
  const k = hitungKomposisiPendapatanLhu(jumlahPartisipasiAnggota, totalHasilInvestasi);
  return [
    { label: 'Komposisi — Partisipasi Anggota', nilai: formatPersenKomposisi(k.persenPartisipasiAnggota) },
    { label: 'Komposisi — Hasil Investasi', nilai: formatPersenKomposisi(k.persenHasilInvestasi) },
  ];
}

/** Baris OCI (dua kelompok SAK EP) — dipakai export tunggal. */
function barisOciLhu(b: PenyusunBarisLhu, data: LhuResult): void {
  b.judul('PENGHASILAN KOMPREHENSIF LAIN');
  b.judul(`${LABEL_KELOMPOK_OCI.TIDAK_DIREKLASIFIKASI}:`);
  if (data.ociTidakDireklasifikasi.length === 0) b.rincianKosong('Tidak ada');
  data.ociTidakDireklasifikasi.forEach((r) => b.rincian(r.nama, r.jumlah));
  b.judul(`${LABEL_KELOMPOK_OCI.DIREKLASIFIKASI}:`);
  if (data.ociDireklasifikasi.length === 0) b.rincianKosong('Tidak ada');
  data.ociDireklasifikasi.forEach((r) => b.rincian(r.nama, r.jumlah));
  b.subtotal('Jumlah Penghasilan Komprehensif Lain', data.totalOci);
  b.total('TOTAL PENGHASILAN KOMPREHENSIF', data.totalPenghasilanKomprehensif);
}

/**
 * RC-S98 — urutan seksi mengikuti Lampiran "CONTOH PERHITUNGAN HASIL
 * USAHA UNTUK KSP" (Juklat SOM No. 3/2025) baris demi baris, termasuk
 * baris baku BEBAN PERKOPERASIAN yang sebelumnya ikut terhitung di Beban
 * Usaha (lihat FinancialReports.LhuResult.bebanPerkoperasian).
 */
export function buildLHUExport(info: InfoKoperasiExport, data: LhuResult, judul: string, shuRat?: InformasiShuRatResult): DataLaporanExport {
  const b = new PenyusunBarisLhu(1);

  b.judul('PARTISIPASI ANGGOTA');
  b.rincian('Pendapatan Jasa Pinjaman', data.pendapatanJasaPinjaman);
  data.pendapatanUsahaLain.forEach((r) => b.rincian(r.nama, r.jumlah));
  b.subtotal('Jumlah Partisipasi Anggota', data.jumlahPartisipasiAnggota);

  b.judul('BEBAN USAHA');
  if (data.bebanUsaha.length === 0) b.rincianKosong('Tidak ada beban usaha');
  data.bebanUsaha.forEach((r) => b.rincian(r.nama, -r.jumlah));
  b.subtotal('Jumlah Beban Usaha', -data.jumlahBebanUsaha);

  b.total('SISA HASIL USAHA BRUTO', data.shuBruto);

  b.judul('HASIL INVESTASI');
  if (data.hasilInvestasi.length === 0) b.rincianKosong('Tidak ada hasil investasi');
  data.hasilInvestasi.forEach((r) => b.rincian(r.nama, r.jumlah));
  b.subtotal('Total Hasil Investasi', data.totalHasilInvestasi);

  b.judul('BEBAN PERKOPERASIAN');
  if (data.bebanPerkoperasian.length === 0) b.rincianKosong('Tidak ada beban perkoperasian');
  data.bebanPerkoperasian.forEach((r) => b.rincian(r.nama, -r.jumlah));
  b.subtotal('Total Beban Perkoperasian', -data.totalBebanPerkoperasian);

  b.judul('PENDAPATAN DAN BEBAN LAIN');
  if (data.pendapatanLain.length === 0 && data.bebanLain.length === 0) b.rincianKosong('Tidak ada pendapatan/beban lain');
  data.pendapatanLain.forEach((r) => b.rincian(r.nama, r.jumlah));
  data.bebanLain.forEach((r) => b.rincian(r.nama, -r.jumlah));
  b.subtotal('Pendapatan/(Beban) Lain Neto', data.pendapatanBebanLainNeto);

  b.total('SISA HASIL USAHA SEBELUM PAJAK', data.shuSebelumPajak);
  b.rincian('Beban Pajak Penghasilan', -data.bebanPajakPenghasilan);
  b.total('SISA HASIL USAHA NETO', data.shuNeto);
  barisOciLhu(b, data);

  // PHASE 6 §R (permintaan pengguna): section SHU Akrual vs Basis Kas
  // ikut export kalau datanya disediakan (opsional, backward
  // compatible — caller lama yang tidak mengisi `shuRat` tetap dapat
  // export TANPA baris tambahan ini).
  if (shuRat) {
    b.judul('SHU — AKRUAL VS BASIS KAS');
    b.rincian('SHU Basis Akrual', shuRat.shuLaporanKeuanganAkrual);
    b.rincian('SHU Basis Kas', shuRat.shuInformasiRat);
    b.subtotal('Selisih', shuRat.selisihAkrualVsKas);
    b.judul('REKONSILIASI AKRUAL KE KAS');
    b.rincian('Pendapatan akrual belum kas', -shuRat.pendapatanAkrualBelumKas);
    b.rincian('Pendapatan kas belum akrual', shuRat.pendapatanKasBelumAkrual);
    b.rincian('Beban akrual belum kas', shuRat.bebanAkrualBelumKas);
    b.rincian('Beban kas belum akrual', -shuRat.bebanKasBelumAkrual);
    // RC-S133.4.3 — keterangan jalur 5 (hanya bila ada, supaya export
    // koperasi tanpa saldo awal pendapatan/beban tidak berubah).
    const saPendapatan = shuRat.pendapatanSaldoAwalTunai ?? 0;
    const saBeban = shuRat.bebanSaldoAwalTunai ?? 0;
    if (saPendapatan !== 0 || saBeban !== 0) {
      b.judul('TERMASUK DALAM BASIS KAS: SALDO AWAL (SEBELUM CUT-OFF)');
      if (saPendapatan !== 0) b.rincian('Saldo awal pendapatan, dianggap sudah diterima tunai', saPendapatan);
      if (saBeban !== 0) b.rincian('Saldo awal beban, dianggap sudah dibayar tunai', -saBeban);
    }
  }

  return {
    judulLaporan: judul,
    namaFileDasar: 'lhu-hasil-usaha',
    ...info,
    periodeLabel: labelPeriodeLaporan(data.tanggalMulai, data.tanggalSelesai),
    kolom: ['Uraian', 'Jumlah'],
    baris: b.baris,
    tingkatBaris: b.tingkat,
    kolomAngka: [1],
    laporanKeuangan: { tanggalAcuan: data.tanggalSelesai, juklat: tampilanLhuJuklat(judul, [data]) },
    ringkasan: [
      { label: 'Sisa Hasil Usaha Bruto', nilai: formatRupiah(data.shuBruto) },
      { label: 'Sisa Hasil Usaha Sebelum Pajak', nilai: formatRupiah(data.shuSebelumPajak) },
      { label: 'Sisa Hasil Usaha Neto', nilai: formatRupiah(data.shuNeto) },
      { label: 'Penghasilan Komprehensif Lain', nilai: formatRupiah(data.totalOci) },
      { label: 'Total Penghasilan Komprehensif', nilai: formatRupiah(data.totalPenghasilanKomprehensif) },
      ...ringkasanKomposisiLhu(data.jumlahPartisipasiAnggota, data.totalHasilInvestasi),
      ...(shuRat ? [{ label: 'SHU Basis Kas', nilai: formatRupiah(shuRat.shuInformasiRat) }] : []),
    ],
  };
}

// ============================================================
// 8c. LPEA — LAPORAN PROMOSI EKONOMI ANGGOTA (RC-S101).
//     Susunan baris mengikuti Lampiran butir 7 Juklak SOM No. 3/2025.
// ============================================================

/**
 * RC-S101 — export LPEA.
 *
 * Memakai `PenyusunBarisLhu` yang sama dengan LHU (lihat di atas):
 * hierarki baris dinyatakan lewat `tingkatBaris`, sehingga judul
 * kelompok, rincian komponen, subtotal, dan total tampil berbeda di PDF.
 *
 * Komponen yang BELUM DAPAT DIHITUNG tidak dicetak sebagai nol: barisnya
 * memuat teks status, dan seluruh keterbatasan dicetak di bagian
 * ringkasan. Laporan yang totalnya belum lengkap WAJIB mengatakannya.
 */
export function buildLpeaExport(
  info: InfoKoperasiExport,
  data: LaporanLpea,
  rincianShu: RincianShuAnggotaLpea[],
  judul: string
): DataLaporanExport {
  const b = new PenyusunBarisLhu(1);

  b.judul('MANFAAT EKONOMI DARI SIMPAN PINJAM LEWAT KOPERASI');

  for (const kelompok of ['PENGHEMATAN_BEBAN_PINJAMAN', 'KELEBIHAN_BALAS_JASA_SIMPANAN'] as const) {
    b.judul(LABEL_KELOMPOK_PEA[kelompok].toUpperCase());
    const anggotaKelompok = data.komponen.filter((k) => k.kelompok === kelompok);
    for (const k of anggotaKelompok) {
      const label = `${k.label} (buku pembantu ${k.huruf})`;
      if (k.status === 'DIHITUNG') {
        b.rincian(label, k.nilai);
      } else {
        // Baris tetap ADA supaya susunan laporan lengkap sesuai naskah,
        // tetapi angkanya tidak dikarang.
        b.rincianTeks(label, LABEL_STATUS_KOMPONEN[k.status]);
      }
    }
    b.subtotal(
      `Jumlah ${LABEL_KELOMPOK_PEA[kelompok]}`,
      kelompok === 'PENGHEMATAN_BEBAN_PINJAMAN'
        ? data.subtotalPenghematanBebanPinjaman
        : data.subtotalKelebihanBalasJasaSimpanan
    );
  }

  b.total(
    'JUMLAH PROMOSI EKONOMI DARI TRANSAKSI PENYEDIAAN JASA UNTUK ANGGOTA',
    data.jumlahPeaPelayanan
  );

  b.judul('PROMOSI EKONOMI PADA AKHIR TAHUN');
  if (data.bagianShu.sudahDibagikan) {
    b.rincian(
      `Pembagian SHU periode berjalan untuk anggota (${data.bagianShu.jumlahAnggotaPenerima} anggota)`,
      data.bagianShu.totalBagianAnggota
    );
  } else {
    b.rincianTeks('Pembagian SHU periode berjalan untuk anggota', 'Belum dibagikan');
  }

  b.total('JUMLAH PROMOSI EKONOMI ANGGOTA', data.jumlahPeaAnggota);

  // --- Rincian per anggota, hanya bila pembagian SHU sudah diproses.
  if (rincianShu.length > 0) {
    b.judul('RINCIAN PEMBAGIAN SHU PER ANGGOTA');
    for (const r of rincianShu) {
      b.rincian(`${r.nomorAnggota} — ${r.namaLengkap}`, r.totalShuAnggota);
    }
    b.subtotal(
      'Jumlah pembagian SHU untuk anggota',
      rincianShu.reduce((t, r) => t + r.totalShuAnggota, 0)
    );
  }

  // --- Asumsi tarif yang dipakai, supaya angkanya dapat ditelusuri.
  b.judul('TARIF PEMBANDING YANG DIPAKAI (PERSEN PER BULAN)');
  for (const k of data.komponen) {
    const luar = k.tarifLuarPersenPerBulan;
    const kop = k.tarifKoperasiPersenPerBulan;
    b.rincianTeks(
      `${k.label} (buku pembantu ${k.huruf})`,
      `koperasi ${kop === null ? 'per transaksi' : `${kop}%`} · luar ${luar === null ? 'belum diisi' : `${luar}%`}`
    );
  }

  const ringkasan: BarisRingkasan[] = [
    { label: 'Jumlah PEA dari pelayanan simpan pinjam', nilai: formatRupiah(data.jumlahPeaPelayanan) },
    {
      label: 'Pembagian SHU untuk anggota',
      nilai: data.bagianShu.sudahDibagikan
        ? formatRupiah(data.bagianShu.totalBagianAnggota)
        : 'Belum dibagikan',
    },
    { label: 'Jumlah Promosi Ekonomi Anggota', nilai: formatRupiah(data.jumlahPeaAnggota) },
    {
      label: 'Status kelengkapan',
      nilai: data.totalBelumLengkap ? 'BELUM LENGKAP — lihat keterbatasan' : 'Lengkap',
    },
  ];
  if (data.parameter.sumberAcuan) {
    ringkasan.push({ label: 'Sumber acuan tarif luar', nilai: data.parameter.sumberAcuan });
  }
  // Keterbatasan dicetak sebagai bagian laporan, BUKAN disembunyikan.
  data.keterbatasan.forEach((k, i) => ringkasan.push({ label: `Keterbatasan ${i + 1}`, nilai: k }));
  KETERBATASAN_STRUKTURAL.forEach((k, i) =>
    ringkasan.push({ label: `Catatan ${i + 1}`, nilai: k })
  );

  return {
    judulLaporan: judul,
    namaFileDasar: 'lpea-promosi-ekonomi-anggota',
    ...info,
    periodeLabel: `Untuk periode yang berakhir tanggal ${formatTanggalIndonesia(data.tanggalSelesai)}`,
    kolom: ['Uraian', 'Jumlah'],
    baris: b.baris,
    tingkatBaris: b.tingkat,
    kolomAngka: [1],
    ringkasan,
    // LPEA: blok tanda tangan pengurus tetap dicetak, tetapi TANPA pilihan
    // template — pilihan "Contoh Laporan Juklat SOM 2025" hanya untuk 5
    // laporan keuangan pokok (LPK, LPHU, LPE, LAK, CALK). LPEA = Standar.
    laporanKeuangan: { tanggalAcuan: data.tanggalSelesai },
  };
}

/**
 * PHASE 6 §D/§R (permintaan pengguna) — export LHU KOMPARATIF. Pola
 * SAMA dengan `buildPosisiKeuanganKomparatifExport` di atas — hanya
 * baris RINGKASAN (Jumlah Partisipasi Anggota/Beban Usaha/SHU Bruto/
 * Sebelum Pajak/Neto) yang dibandingkan berdampingan, konsisten
 * dengan tingkat detail yang ditampilkan LabaRugiScreen.tsx dalam
 * mode Komparatif (lihat komentar ComparativeRow di sana).
 */
/**
 * PHASE 6 FINAL FIX §2/§3 (permintaan pengguna) — export LHU
 * KOMPARATIF LENGKAP: SEMUA baris klasifikasi (bukan cuma 5 baris
 * ringkasan seperti draft sebelumnya), union by kode SAMA PERSIS
 * dengan `gabungLhuRows` di LabaRugiScreen.tsx (§5.C: "UI dan export
 * mempunyai data comparative yang konsisten") — TIDAK ADA logic
 * akuntansi baru, murni memasangkan baris getLHU() yang sudah ada.
 * Format TETAP 3 kolom (Label, Periode Berjalan, Periode Komparatif)
 * — standar existing yang sudah dipakai
 * buildPerubahanEkuitasKomparatifExport/buildArusKasKomparatifExport
 * (§3: "boleh mempertahankan standar 3 kolom, tapi jangan kehilangan
 * data detail LHU" — detail dipertahankan lewat CAKUPAN BARIS, bukan
 * kolom tambahan).
 */
function gabungLhuRowsUntukExport(sekarang: LhuResult['pendapatanUsahaLain'], pembanding: LhuResult['pendapatanUsahaLain']): (string | number)[][] {
  const kodeSet = new Set<string>();
  sekarang.forEach((r) => kodeSet.add(r.kode));
  pembanding.forEach((r) => kodeSet.add(r.kode));
  const namaByKode = new Map<string, string>();
  sekarang.forEach((r) => namaByKode.set(r.kode, r.nama));
  pembanding.forEach((r) => {
    if (!namaByKode.has(r.kode)) namaByKode.set(r.kode, r.nama);
  });
  const sekarangMap = new Map(sekarang.map((r) => [r.kode, r.jumlah]));
  const pembandingMap = new Map(pembanding.map((r) => [r.kode, r.jumlah]));
  return Array.from(kodeSet).map((kode) => [namaByKode.get(kode) ?? kode, sekarangMap.get(kode) ?? 0, pembandingMap.get(kode) ?? 0]);
}

export function buildLHUKomparatifExport(info: InfoKoperasiExport, data: LhuKomparatif, judul: string): DataLaporanExport {
  const b = new PenyusunBarisLhu(2);
  const S = data.sekarang;
  const P = data.pembanding;

  /** Pasangkan rincian dua periode, dengan pilihan membalik tanda (beban). */
  const rincianBerpasangan = (
    barisSekarang: LhuResult['bebanUsaha'],
    barisPembanding: LhuResult['bebanUsaha'],
    teksKosong: string,
    pengurang = false
  ) => {
    const gabungan = gabungLhuRowsUntukExport(barisSekarang, barisPembanding);
    if (gabungan.length === 0) {
      b.rincianKosong(teksKosong);
      return;
    }
    const tanda = pengurang ? -1 : 1;
    gabungan.forEach((row) => b.rincian(String(row[0]), tanda * (row[1] as number), tanda * (row[2] as number)));
  };

  b.judul('PARTISIPASI ANGGOTA');
  b.rincian('Pendapatan Jasa Pinjaman', S.pendapatanJasaPinjaman, P.pendapatanJasaPinjaman);
  rincianBerpasangan(S.pendapatanUsahaLain, P.pendapatanUsahaLain, 'Tidak ada pendapatan usaha lain');
  b.subtotal('Jumlah Partisipasi Anggota', S.jumlahPartisipasiAnggota, P.jumlahPartisipasiAnggota);

  b.judul('BEBAN USAHA');
  rincianBerpasangan(S.bebanUsaha, P.bebanUsaha, 'Tidak ada beban usaha', true);
  b.subtotal('Jumlah Beban Usaha', -S.jumlahBebanUsaha, -P.jumlahBebanUsaha);

  b.total('SISA HASIL USAHA BRUTO', S.shuBruto, P.shuBruto);

  b.judul('HASIL INVESTASI');
  rincianBerpasangan(S.hasilInvestasi, P.hasilInvestasi, 'Tidak ada hasil investasi');
  b.subtotal('Total Hasil Investasi', S.totalHasilInvestasi, P.totalHasilInvestasi);

  b.judul('BEBAN PERKOPERASIAN');
  rincianBerpasangan(S.bebanPerkoperasian, P.bebanPerkoperasian, 'Tidak ada beban perkoperasian', true);
  b.subtotal('Total Beban Perkoperasian', -S.totalBebanPerkoperasian, -P.totalBebanPerkoperasian);

  b.judul('PENDAPATAN DAN BEBAN LAIN');
  rincianBerpasangan(S.pendapatanLain, P.pendapatanLain, 'Tidak ada pendapatan lain');
  rincianBerpasangan(S.bebanLain, P.bebanLain, 'Tidak ada beban lain', true);
  b.subtotal('Pendapatan/(Beban) Lain Neto', S.pendapatanBebanLainNeto, P.pendapatanBebanLainNeto);

  b.total('SISA HASIL USAHA SEBELUM PAJAK', S.shuSebelumPajak, P.shuSebelumPajak);
  b.rincian('Beban Pajak Penghasilan', -S.bebanPajakPenghasilan, -P.bebanPajakPenghasilan);
  b.total('SISA HASIL USAHA NETO', S.shuNeto, P.shuNeto);

  b.judul('PENGHASILAN KOMPREHENSIF LAIN');
  b.judul(`${LABEL_KELOMPOK_OCI.TIDAK_DIREKLASIFIKASI}:`);
  rincianBerpasangan(S.ociTidakDireklasifikasi, P.ociTidakDireklasifikasi, 'Tidak ada');
  b.judul(`${LABEL_KELOMPOK_OCI.DIREKLASIFIKASI}:`);
  rincianBerpasangan(S.ociDireklasifikasi, P.ociDireklasifikasi, 'Tidak ada');
  b.subtotal('Jumlah Penghasilan Komprehensif Lain', S.totalOci, P.totalOci);
  b.total('TOTAL PENGHASILAN KOMPREHENSIF', S.totalPenghasilanKomprehensif, P.totalPenghasilanKomprehensif);

  return {
    judulLaporan: `${judul} — Komparatif`,
    namaFileDasar: 'lhu-hasil-usaha-komparatif',
    ...info,
    periodeLabel: `${labelPeriodeLaporan(S.tanggalMulai, S.tanggalSelesai)} — dibandingkan ${formatTanggalIndonesia(
      P.tanggalMulai
    )} s.d. ${formatTanggalIndonesia(P.tanggalSelesai)}`,
    kolom: ['Uraian', ...labelKolomKomparatif(S.tanggalSelesai, P.tanggalSelesai)],
    baris: b.baris,
    tingkatBaris: b.tingkat,
    kolomAngka: [1, 2],
    laporanKeuangan: {
      tanggalAcuan: S.tanggalSelesai,
      juklat: tampilanLhuJuklat(judul.replace(/\s*—\s*Komparatif$/i, ''), [P, S]),
    },
    ringkasan: [
      { label: `SHU Neto — ${labelKolomKomparatif(S.tanggalSelesai, P.tanggalSelesai)[0]}`, nilai: formatRupiah(data.sekarang.shuNeto) },
      { label: `SHU Neto — ${labelKolomKomparatif(S.tanggalSelesai, P.tanggalSelesai)[1]}`, nilai: formatRupiah(data.pembanding.shuNeto) },
      { label: 'Perubahan SHU Neto', nilai: formatRupiah(data.perubahanShuNeto) },
      {
        label: `Total Penghasilan Komprehensif — ${labelKolomKomparatif(S.tanggalSelesai, P.tanggalSelesai)[0]}`,
        nilai: formatRupiah(data.sekarang.totalPenghasilanKomprehensif),
      },
      {
        label: `Total Penghasilan Komprehensif — ${labelKolomKomparatif(S.tanggalSelesai, P.tanggalSelesai)[1]}`,
        nilai: formatRupiah(data.pembanding.totalPenghasilanKomprehensif),
      },
    ],
  };
}

// ============================================================
// 9. LAPORAN PERUBAHAN EKUITAS
// ============================================================
export function buildPerubahanEkuitasExport(
  info: InfoKoperasiExport,
  data: PerubahanEkuitasResult
): DataLaporanExport {
  const baris = data.rows.map((r) => [r.nama, r.saldoAwal, r.mutasi, r.saldoAkhir]);
  // RC-S133.6 (AUDIT F-4) — baris SHU/Hasil Usaha kini punya saldo awal
  // (sisa belum dibagikan per H-1), sama seperti akun ekuitas lain.
  const awalShu = data.saldoAwalHasilUsaha ?? 0;
  baris.push([data.hasilUsahaPeriodeLabel, awalShu, data.hasilUsahaPeriode - awalShu, data.hasilUsahaPeriode]);
  // RC-S133.6.1 — rincian baris SHU/Hasil Usaha (indentasi, BUKAN baris
  // tambahan untuk dijumlah): SHU tahun lalu − distribusi, dan hasil usaha
  // periode = Laporan Hasil Usaha. Jumlah rincian = baris di atasnya.
  const tingkatBaris: (TingkatBarisLaporan | undefined)[] = baris.map(() => undefined);
  for (const r of data.rincianHasilUsaha ?? []) {
    baris.push([`   • ${r.nama}`, r.saldoAwal, r.mutasi, r.saldoAkhir]);
    tingkatBaris.push('RINCIAN');
  }
  const rincianShu: { label: string; nilai: string }[] = [];
  if (data.hasilUsahaPeriodeBerjalan !== undefined && (awalShu !== 0 || (data.shuDibagikanPeriode ?? 0) !== 0)) {
    rincianShu.push({ label: 'Hasil usaha periode ini', nilai: formatRupiah(data.hasilUsahaPeriodeBerjalan) });
    rincianShu.push({ label: 'SHU dibagikan dalam periode', nilai: formatRupiah(-(data.shuDibagikanPeriode ?? 0)) });
    if ((data.shuDibagikanPeriode ?? 0) !== 0 && data.distribusiShuKeEkuitas !== undefined) {
      rincianShu.push({ label: '  ke Cadangan/akun ekuitas (tetap di ekuitas)', nilai: formatRupiah(data.distribusiShuKeEkuitas) });
      rincianShu.push({ label: '  ke dana-dana & simpanan anggota (keluar dari ekuitas)', nilai: formatRupiah(data.distribusiShuKeLuarEkuitas ?? 0) });
    }
  }

  return {
    judulLaporan: 'Laporan Perubahan Ekuitas',
    namaFileDasar: 'perubahan-ekuitas',
    ...info,
    periodeLabel: `${data.tanggalMulai} s.d. ${data.tanggalSelesai}`,
    kolom: ['Akun', 'Saldo Awal', 'Mutasi', 'Saldo Akhir'],
    baris,
    kolomAngka: [1, 2, 3],
    ...(tingkatBaris.some(Boolean) ? { tingkatBaris } : {}),
    laporanKeuangan: { tanggalAcuan: data.tanggalSelesai, juklat: tampilanEkuitasJuklat([data]) },
    ringkasan: [
      { label: 'Total Saldo Awal', nilai: formatRupiah(data.totalSaldoAwal) },
      ...rincianShu,
      { label: 'Total Saldo Akhir', nilai: formatRupiah(data.totalSaldoAkhir) },
    ],
  };
}

// ============================================================
// 10. LAPORAN ARUS KAS
// ============================================================
export function buildArusKasExport(info: InfoKoperasiExport, data: ArusKasResult): DataLaporanExport {
  // RC-S104 — SUSUNAN SAMA PERSIS DENGAN LAYAR.
  //
  // Sebelumnya export hanya memuat tujuh baris datar tanpa hierarki:
  // kas awal justru di paling atas, ketiga aktivitas hanya totalnya,
  // dan tidak ada satu pun baris rincian. Sekarang strukturnya
  // mengikuti contoh Juklat SOM No. 3/2025 — bagian bernomor, baris
  // rincian bernama, "Jumlah arus kas ...", lalu penutup.
  //
  // Baris disusun oleh `PenyusunBarisLhu` yang SAMA dengan LHU/LPEA
  // (bukan penyusun baru), sehingga tingkat baris JUDUL/RINCIAN/
  // SUBTOTAL/TOTAL diterjemahkan ke indentasi & penebalan oleh
  // HtmlReportBuilder dan ExportService yang sudah ada.
  const b = new PenyusunBarisLhu(1);
  for (const bagian of susunBagianArusKas(data.rincian)) {
    b.judul(`${bagian.nomor}. ${bagian.judul.toUpperCase()}`);
    if (bagian.baris.length === 0) {
      b.rincianTeks('', 'Tidak ada mutasi kas pada kegiatan ini');
    } else {
      for (const r of bagian.baris) b.rincian(r.label, r.jumlah);
    }
    b.subtotal(bagian.labelJumlah, bagian.jumlah);
  }
  b.total(LABEL_KENAIKAN, data.perubahanKas);
  b.judul('REKONSILIASI SALDO KAS');
  b.rincian(LABEL_SALDO_AWAL, data.kasAwal);
  b.rincian(LABEL_KENAIKAN, data.perubahanKas);
  b.subtotal(LABEL_SALDO_AKHIR, data.kasAkhirDihitung);
  b.total('Saldo kas dan bank aktual pada akhir periode', data.kasAkhirAktual);

  return {
    judulLaporan: 'Laporan Arus Kas',
    namaFileDasar: 'arus-kas',
    ...info,
    periodeLabel: labelPeriodeLaporan(data.tanggalMulai, data.tanggalSelesai),
    kolom: ['Uraian', 'Jumlah'],
    baris: b.baris,
    tingkatBaris: b.tingkat,
    kolomAngka: [1],
    ringkasan: [
      { label: 'Metode penyusunan', nilai: 'Langsung (dari mutasi kas dan bank)' },
      {
        label: 'Rekonsiliasi',
        nilai: data.terekonsiliasi
          ? 'Sesuai dengan saldo kas/bank'
          : `Selisih ${formatRupiah(Math.abs(data.selisihRekonsiliasi))}`,
      },
    ],
    catatanKaki: [...CATATAN_PENYAJIAN],
    laporanKeuangan: { tanggalAcuan: data.tanggalSelesai, juklat: tampilanArusKasJuklat([data], CATATAN_PENYAJIAN) },
  };
}

/**
 * Phase 17 §11: export Perubahan Ekuitas KOMPARATIF — dua kolom
 * (Periode Berjalan/Periode Komparatif) berdampingan, sama seperti
 * tabel yang ditampilkan PerubahanEkuitasScreen mode Komparatif (§6).
 * Reuse `DataLaporanExport`/`ExportService` yang sama, TIDAK ada
 * export engine baru.
 */
export function buildPerubahanEkuitasKomparatifExport(
  info: InfoKoperasiExport,
  data: PerubahanEkuitasKomparatif
): DataLaporanExport {
  const kodeSet = new Set<string>();
  data.sekarang.rows.forEach((r) => kodeSet.add(r.kode));
  data.pembanding.rows.forEach((r) => kodeSet.add(r.kode));
  const namaByKode = new Map<string, string>();
  data.sekarang.rows.forEach((r) => namaByKode.set(r.kode, r.nama));
  data.pembanding.rows.forEach((r) => namaByKode.set(r.kode, r.nama));
  const saldoAkhirByKode = (result: PerubahanEkuitasResult) => new Map(result.rows.map((r) => [r.kode, r.saldoAkhir]));
  const sekarangMap = saldoAkhirByKode(data.sekarang);
  const pembandingMap = saldoAkhirByKode(data.pembanding);

  const baris: (string | number)[][] = [];
  for (const kode of kodeSet) {
    baris.push([namaByKode.get(kode) ?? kode, sekarangMap.get(kode) ?? 0, pembandingMap.get(kode) ?? 0]);
  }
  baris.push([data.sekarang.hasilUsahaPeriodeLabel, data.sekarang.hasilUsahaPeriode, data.pembanding.hasilUsahaPeriode]);

  return {
    judulLaporan: 'Laporan Perubahan Ekuitas — Komparatif',
    namaFileDasar: 'perubahan-ekuitas-komparatif',
    ...info,
    periodeLabel: `${data.sekarang.tanggalMulai} s.d. ${data.sekarang.tanggalSelesai} vs ${data.pembanding.tanggalMulai} s.d. ${data.pembanding.tanggalSelesai}`,
    kolom: ['Komponen', ...labelKolomKomparatif(data.sekarang.tanggalSelesai, data.pembanding.tanggalSelesai)],
    baris,
    kolomAngka: [1, 2],
    laporanKeuangan: { tanggalAcuan: data.sekarang.tanggalSelesai, juklat: tampilanEkuitasJuklat([data.pembanding, data.sekarang]) },
    ringkasan: [
      {
        label: `Saldo Akhir ${labelKolomKomparatif(data.sekarang.tanggalSelesai, data.pembanding.tanggalSelesai)[0]}`,
        nilai: formatRupiah(data.sekarang.totalSaldoAkhir),
      },
      {
        label: `Saldo Akhir ${labelKolomKomparatif(data.sekarang.tanggalSelesai, data.pembanding.tanggalSelesai)[1]}`,
        nilai: formatRupiah(data.pembanding.totalSaldoAkhir),
      },
      { label: 'Perubahan', nilai: formatRupiah(data.perubahanTotalSaldoAkhir) },
    ],
  };
}

/** Phase 17 §11: export Arus Kas KOMPARATIF — pola sama dengan buildPerubahanEkuitasKomparatifExport di atas. */
export function buildArusKasKomparatifExport(info: InfoKoperasiExport, data: ArusKasKomparatif): DataLaporanExport {
  const baris: (string | number)[][] = [
    ['Kas Awal', data.sekarang.kasAwal, data.pembanding.kasAwal],
    ['Arus Kas Operasi', data.sekarang.operasi, data.pembanding.operasi],
    ['Arus Kas Investasi', data.sekarang.investasi, data.pembanding.investasi],
    ['Arus Kas Pendanaan', data.sekarang.pendanaan, data.pembanding.pendanaan],
    ['Kenaikan (Penurunan) Bersih Kas', data.sekarang.perubahanKas, data.pembanding.perubahanKas],
    ['Kas Akhir', data.sekarang.kasAkhirAktual, data.pembanding.kasAkhirAktual],
  ];

  return {
    judulLaporan: 'Laporan Arus Kas — Komparatif',
    namaFileDasar: 'arus-kas-komparatif',
    ...info,
    periodeLabel: `${data.sekarang.tanggalMulai} s.d. ${data.sekarang.tanggalSelesai} vs ${data.pembanding.tanggalMulai} s.d. ${data.pembanding.tanggalSelesai}`,
    kolom: ['Aktivitas', ...labelKolomKomparatif(data.sekarang.tanggalSelesai, data.pembanding.tanggalSelesai)],
    baris,
    kolomAngka: [1, 2],
    // PDF: rincian pos per kegiatan seperti naskah (bukan hanya total per kegiatan).
    laporanKeuangan: {
      tanggalAcuan: data.sekarang.tanggalSelesai,
      juklat: tampilanArusKasJuklat([data.pembanding, data.sekarang], CATATAN_PENYAJIAN),
    },
    ringkasan: [
      {
        label: `Rekonsiliasi ${labelKolomKomparatif(data.sekarang.tanggalSelesai, data.pembanding.tanggalSelesai)[0]}`,
        nilai: data.sekarang.terekonsiliasi ? 'Sesuai' : `Selisih ${formatRupiah(Math.abs(data.sekarang.selisihRekonsiliasi))}`,
      },
      {
        label: `Rekonsiliasi ${labelKolomKomparatif(data.sekarang.tanggalSelesai, data.pembanding.tanggalSelesai)[1]}`,
        nilai: data.pembanding.terekonsiliasi ? 'Sesuai' : `Selisih ${formatRupiah(Math.abs(data.pembanding.selisihRekonsiliasi))}`,
      },
    ],
  };
}

// ============================================================
// 11. CALK
// ============================================================
export function buildCalkExport(info: InfoKoperasiExport, data: CalkResult): DataLaporanExport {
  return {
    judulLaporan: 'Catatan Atas Laporan Keuangan',
    namaFileDasar: 'calk',
    ...info,
    periodeLabel: `${data.tanggalMulai} s.d. ${data.tanggalSelesai}`,
    kolom: ['Bagian', 'Isi'],
    baris: data.sections.map((s) => [s.judul, s.konten]),
    kolomAngka: [],
    laporanKeuangan: { tanggalAcuan: data.tanggalSelesai, juklat: tampilanCalkJuklat(data) },
  };
}

// ============================================================
// 12. SHU ANGGOTA
// ============================================================
export function buildShuAnggotaExport(
  info: InfoKoperasiExport,
  konfigurasi: ShuKonfigurasiRow,
  daftar: ShuAnggotaRow[]
): DataLaporanExport {
  const totalShuAnggota = daftar.reduce((a, d) => a + d.totalShuAnggota, 0);
  return {
    judulLaporan: `SHU Anggota — Tahun Buku ${konfigurasi.tahunBuku}`,
    namaFileDasar: `shu-anggota-${konfigurasi.tahunBuku}`,
    ...info,
    periodeLabel: `Tahun Buku ${konfigurasi.tahunBuku}`,
    kolom: ['No. Anggota', 'Nama', 'Basis Simpanan', 'Basis Partisipasi', 'Jasa Modal', 'Jasa Usaha', 'Total SHU'],
    baris: daftar.map((d) => [
      d.nomorAnggota,
      d.namaAnggota,
      d.basisSimpanan,
      d.basisPartisipasiUsaha,
      d.jasaModal,
      d.jasaUsaha,
      d.totalShuAnggota,
    ]),
    kolomAngka: [2, 3, 4, 5, 6],
    ringkasan: [
      { label: 'Total SHU Dibagikan ke Anggota', nilai: formatRupiah(totalShuAnggota) },
      { label: 'Total SHU Koperasi', nilai: formatRupiah(konfigurasi.totalShu ?? 0) },
    ],
  };
}

// ============================================================
// 13. DATA BANK (Phase 17 §P)
// ============================================================
export function buildDataBankExport(
  info: InfoKoperasiExport,
  daftar: { nama: string; nomorRekening?: string; namaPemilik?: string; saldo: number; aktif: boolean }[]
): DataLaporanExport {
  const totalSaldo = daftar.reduce((a, d) => a + d.saldo, 0);
  return {
    judulLaporan: 'Data Bank',
    namaFileDasar: 'data-bank',
    ...info,
    periodeLabel: `Per ${getTanggalLokalHariIni()}`,
    // Audit ulang (permintaan pengguna, request baru §4): kolom "Nama
    // Pemilik/Rekening" ditambahkan — tampil "-" kalau memang tidak
    // ada (field ini sudah tidak diminta lagi di form tambah data bank
    // sejak §21/§22, tapi data lama yang masih punya nilainya tetap
    // ditampilkan di sini, tidak hilang).
    kolom: ['Nama Bank', 'Nomor Rekening', 'Nama Pemilik/Rekening', 'Saldo', 'Status'],
    baris: daftar.map((d) => [
      d.nama.split(' — ')[0],
      d.nomorRekening ?? d.nama.split(' — ')[1] ?? '-',
      d.namaPemilik ?? '-',
      d.saldo,
      d.aktif ? 'Aktif' : 'Nonaktif',
    ]),
    kolomAngka: [3],
    ringkasan: [{ label: 'Total Saldo Bank', nilai: formatRupiah(totalSaldo) }],
  };
}

// ============================================================
// 14. BUKTI BAYAR PIUTANG ANGGOTA (Phase 17 §W)
// ============================================================
export function buildBuktiBayarPiutangExport(info: InfoKoperasiExport, item: BuktiBayarPiutangRow): DataLaporanExport {
  return {
    judulLaporan: 'Bukti Bayar Piutang Anggota',
    namaFileDasar: `bukti-bayar-piutang-${item.nomorBukti}`,
    ...info,
    periodeLabel: `${item.tanggal}`,
    kolom: ['Keterangan', 'Nilai'],
    baris: [
      ['Nomor Bukti', item.nomorBukti],
      ['Tanggal', item.tanggal],
      ['Nomor Anggota', item.nomorAnggota],
      ['Nama Anggota', item.namaAnggota],
      ['Nomor Pinjaman', item.nomorPinjaman],
      ['Porsi Pokok', item.porsiPokok],
      ['Porsi Jasa', item.porsiJasa],
      ['Porsi Denda', item.porsiDenda],
      ['Sumber Dana', item.sumberDana],
      ['Keterangan', item.keterangan ?? '-'],
    ],
    kolomAngka: [],
    ringkasan: [{ label: 'Total Pembayaran', nilai: formatRupiah(item.jumlahPembayaran) }],
  };
}

const JENIS_PEMBERI_LABEL_BUKTI: Record<string, string> = {
  BANK: 'Bank',
  PIHAK_LAIN: 'Pihak Lain',
  UTANG_USAHA: 'Utang Usaha (Pembelian Aset)',
};

/** Bukti Bayar Utang (update 6-perbaikan §2) — pola SAMA PERSIS buildBuktiBayarPiutangExport, dari sisi utang koperasi (bukan piutang anggota). */
export function buildBuktiBayarUtangExport(info: InfoKoperasiExport, item: BuktiBayarUtangRow): DataLaporanExport {
  return {
    judulLaporan: 'Bukti Bayar Utang',
    namaFileDasar: `bukti-bayar-utang-${item.nomorBukti}`,
    ...info,
    periodeLabel: `${item.tanggal}`,
    kolom: ['Keterangan', 'Nilai'],
    baris: [
      ['Nomor Bukti', item.nomorBukti],
      ['Tanggal', item.tanggal],
      ['Nomor Utang', item.nomorUtang],
      ['Pihak Pemberi', item.namaPemberi],
      ['Jenis Pemberi', JENIS_PEMBERI_LABEL_BUKTI[item.jenisPemberi] ?? item.jenisPemberi],
      ['Porsi Pokok', item.porsiPokok],
      ['Porsi Bunga/Jasa', item.porsiBunga],
      ['Sumber Dana', item.sumberDana],
      ['Keterangan', item.keterangan ?? '-'],
      ['Dibuat Oleh', item.dibuatOleh ?? '-'],
    ],
    kolomAngka: [],
    ringkasan: [{ label: 'Total Pembayaran', nilai: formatRupiah(item.jumlahPembayaran) }],
  };
}

// ============================================================
// 15. BUKTI BAYAR SIMPANAN ANGGOTA (Phase 17 §X)
// ============================================================
const JENIS_SIMPANAN_LABEL_BUKTI: Record<string, string> = {
  POKOK: 'Simpanan Pokok',
  WAJIB: 'Simpanan Wajib',
  SUKARELA: 'Simpanan Sukarela',
  BERJANGKA: 'Simpanan Berjangka',
};

/** Label jenis simpanan untuk bukti (layar & export memakai label yang sama). */
export function labelJenisSimpananBukti(jenis: string): string {
  return JENIS_SIMPANAN_LABEL_BUKTI[jenis] ?? jenis;
}

export function buildBuktiBayarSimpananExport(info: InfoKoperasiExport, item: BuktiBayarSimpananRow): DataLaporanExport {
  return {
    judulLaporan: 'Bukti Bayar Simpanan Anggota',
    namaFileDasar: `bukti-simpanan-${item.nomorBukti}`,
    ...info,
    periodeLabel: `${item.tanggal}`,
    kolom: ['Keterangan', 'Nilai'],
    baris: [
      ['Nomor Bukti', item.nomorBukti],
      ['Tanggal', item.tanggal],
      ['Nomor Anggota', item.nomorAnggota],
      ['Nama Anggota', item.namaAnggota],
      ['Jenis Simpanan', JENIS_SIMPANAN_LABEL_BUKTI[item.jenisSimpanan] ?? item.jenisSimpanan],
      ['Sumber Dana', item.sumberDana],
      ['Keterangan', item.keterangan ?? '-'],
    ],
    kolomAngka: [],
    ringkasan: [{ label: 'Jumlah Setoran', nilai: formatRupiah(item.jumlah) }],
  };
}

/**
 * Bukti Tarik Simpanan Anggota (§G/§W) — pola SAMA PERSIS
 * buildBuktiBayarSimpananExport, hanya arah nominalnya berbeda
 * (penarikan, bukan setoran). Untuk pencairan SIMPANAN BERJANGKA,
 * kontrak & rincian pencairannya ikut dicetak (pokok, bunga, PPh 4(2),
 * penalti, biaya administrasi) — angkanya dibaca service, tidak dihitung
 * ulang di sini.
 */
export function buildBuktiTarikSimpananExport(info: InfoKoperasiExport, item: BuktiTarikSimpananRow): DataLaporanExport {
  const rb = item.rincianBerjangka ?? null;
  const baris: (string | number)[][] = [
    ['Nomor Bukti', item.nomorBukti],
    ['Tanggal', item.tanggal],
    ['Nomor Anggota', item.nomorAnggota],
    ['Nama Anggota', item.namaAnggota],
    ['Jenis Simpanan', labelJenisSimpananBukti(item.jenisSimpanan)],
    ['Sumber Dana', item.sumberDana],
    ['Keterangan', item.keterangan ?? '-'],
  ];
  if (rb) {
    baris.push(
      ['Jenis Pencairan', rb.jenisPencairan === 'DINI' ? 'Penarikan Dini' : 'Pencairan Jatuh Tempo'],
      ['Nomor Kontrak', rb.nomorKontrak],
      ['Tanggal Penempatan', rb.tanggalMulai],
      ['Jatuh Tempo', rb.tanggalJatuhTempo],
      ['Tenor', `${rb.tenorBulan} bulan`],
      ['Suku Bunga', `${String(rb.sukuBunga).replace('.', ',')}% per tahun`]
    );
    if (rb.jenisPencairan === 'DINI' && rb.policyVersi) baris.push(['Kebijakan Penarikan Dini', `Versi ${rb.policyVersi}`]);
    baris.push(['Pokok Simpanan', formatRupiah(rb.pokok)], ['Bunga Dibayarkan', formatRupiah(rb.bunga)]);
    if (rb.pphDipotong > 0) baris.push(['PPh Pasal 4 ayat (2) atas Bunga', `-${formatRupiah(rb.pphDipotong)}`]);
    if (rb.penalti > 0) baris.push(['Penalti Penarikan Dini', `-${formatRupiah(rb.penalti)}`]);
    if (rb.biayaAdmin > 0) baris.push(['Biaya Administrasi', `-${formatRupiah(rb.biayaAdmin)}`]);
    if (rb.bungaHangus > 0) baris.push(['Bunga Hangus (tidak dibayarkan)', formatRupiah(rb.bungaHangus)]);
  }
  return {
    judulLaporan: 'Bukti Tarik Simpanan Anggota',
    namaFileDasar: `bukti-tarik-simpanan-${item.nomorBukti}`,
    ...info,
    periodeLabel: `${item.tanggal}`,
    kolom: ['Keterangan', 'Nilai'],
    baris,
    kolomAngka: [],
    ringkasan: [{ label: rb ? 'Total Diterima Anggota' : 'Jumlah Penarikan', nilai: formatRupiah(item.jumlah) }],
  };
}

// ============================================================
// 16. BUKTI KELUAR ANGGOTA (Phase 17 §Y)
// ============================================================
// ============================================================
// 15. BUKTI KELUAR ANGGOTA (Phase 17 §Y)
// ============================================================
export function buildBuktiKeluarAnggotaExport(info: InfoKoperasiExport, item: BuktiKeluarAnggotaRow): DataLaporanExport {
  return {
    judulLaporan: 'Bukti Keluar Anggota',
    namaFileDasar: `bukti-keluar-anggota-${item.nomorBukti}`,
    ...info,
    periodeLabel: `${item.tanggal}`,
    kolom: ['Keterangan', 'Nilai'],
    baris: [
      ['Nomor Bukti', item.nomorBukti],
      ['Tanggal', item.tanggal],
      ['Nomor Anggota', item.nomorAnggota],
      ['Nama Anggota', item.namaAnggota],
      ['Sumber Dana Pengembalian', item.sumberDana],
      ['Keterangan', item.keterangan ?? '-'],
    ],
    kolomAngka: [],
    ringkasan: [{ label: 'Total Saldo Dikembalikan', nilai: formatRupiah(item.totalDikembalikan) }],
  };
}

// ============================================================
// 17. HISTORY TRANSAKSI (Phase 18 §8/§11)
// ============================================================
export function buildHistoryTransaksiExport(
  info: InfoKoperasiExport,
  daftar: {
    nomorTransaksi: string;
    jenisLabel: string;
    tanggal: string;
    deskripsi: string;
    nominal: number;
    status: string;
    createdByNama: string | null;
  }[]
): DataLaporanExport {
  return {
    judulLaporan: 'History Transaksi',
    namaFileDasar: 'history-transaksi',
    ...info,
    periodeLabel: `Per ${getTanggalLokalHariIni()}`,
    kolom: ['Nomor Transaksi', 'Jenis', 'Tanggal', 'Deskripsi', 'Nominal', 'Status', 'Dibuat Oleh'],
    baris: daftar.map((d) => [
      d.nomorTransaksi,
      d.jenisLabel,
      d.tanggal,
      d.deskripsi,
      d.nominal,
      d.status,
      d.createdByNama ?? '-',
    ]),
    kolomAngka: [4],
    ringkasan: [{ label: 'Jumlah Transaksi', nilai: String(daftar.length) }],
  };
}

// ============================================================
// 16. RAK — REKENING ANTAR KANTOR (Phase 18 §3/§11)
// ============================================================
export function buildRAKExport(
  info: InfoKoperasiExport,
  daftar: {
    nomorRak: string;
    jenisRak: string;
    namaUnit: string;
    jumlah: number;
    tanggal: string;
    sumberDana: string;
    keterangan: string | null;
    status: string;
  }[]
): DataLaporanExport {
  const JENIS_LABEL: Record<string, string> = {
    PENYALURAN_DANA: 'Penyaluran Dana ke Unit dan Kantor Cabang',
    SETORAN_DANA: 'Setoran Dana ke Unit/Kantor Pusat',
  };
  const totalAktif = daftar.filter((d) => d.status === 'AKTIF').reduce((a, d) => a + d.jumlah, 0);
  return {
    judulLaporan: 'Rekening Antar Kantor/Unit (RAKU)',
    namaFileDasar: 'rak-rekening-antar-kantor',
    ...info,
    periodeLabel: `Per ${getTanggalLokalHariIni()}`,
    kolom: ['Nomor RAK', 'Jenis', 'Unit/Kantor', 'Tanggal', 'Jumlah', 'Sumber Dana', 'Status', 'Keterangan'],
    baris: daftar.map((d) => [
      d.nomorRak,
      JENIS_LABEL[d.jenisRak] ?? d.jenisRak,
      d.namaUnit,
      d.tanggal,
      d.jumlah,
      d.sumberDana === 'BANK' ? 'Bank' : 'Kas',
      d.status === 'AKTIF' ? 'Aktif' : 'Dibatalkan',
      d.keterangan ?? '-',
    ]),
    kolomAngka: [4],
    ringkasan: [{ label: 'Total RAK Aktif', nilai: formatRupiah(totalAktif) }],
  };
}

// ============================================================
// 17B. (KOSONG) — builder ekspor "Pemberian Pinjaman untuk Koperasi"
//      DIHAPUS di RC-S70.2 bersama fitur legacy-nya. Nomor bagian
//      sengaja tidak dipakai ulang supaya penomoran builder lain tetap.
// ============================================================

// ============================================================
// 18. KOLEKTIBILITAS PIUTANG PINJAMAN ANGGOTA (§4/§4C/§4D/§4G)
// ============================================================
/** RC-S133.6.3 — persen gaya Indonesia: 61,1% / 0,5% / 100%. */
function persenId(n: number, desimal = 1): string {
  if (!Number.isFinite(n)) return '-';
  let teks = n.toFixed(desimal);
  if (teks.includes('.')) teks = teks.replace(/0+$/, '').replace(/\.$/, '');
  return `${teks.replace('.', ',')}%`;
}

/**
 * RC-S133.6.3 — data fiskal PMK 74 per pinjaman (opsional). Diisi layar
 * dari `getKlasifikasiFiskalPinjamanAktif()`; bila tidak ada, bagian fiskal
 * tidak dicetak (pemanggil/test lama tetap berlaku).
 */
type ItemKolektibilitasExport = KlasifikasiPinjamanItem &
  Partial<Pick<KlasifikasiFiskalItem, 'kolektibilitasFiskal' | 'dasarPencadanganFiskal' | 'persentaseCadanganFiskal' | 'cadanganFiskal'>>;

export interface OpsiExportKolektibilitas {
  /** Lingkup anggota yang dipakai layar, mis. "Anggota aktif" / "Semua status anggota". */
  lingkupAnggota?: string;
  /** Saldo akun Penyisihan Piutang di buku besar per tanggal laporan (null = tidak dibaca). */
  penyisihanTercatat?: number | null;
  /**
   * Tarif cadangan fiskal per kategori (PMK 74/2024) yang dipakai layar —
   * dikirim pemanggil agar modul export tidak bergantung pada service ber-db.
   * Bila tidak ada, % diambil dari item (kategori tanpa pinjaman tampil "-").
   */
  tarifFiskal?: Partial<Record<KolektibilitasSom, number>>;
}

/**
 * Kolom tabel datar (tetap disediakan untuk konsumen lama & test). Indeks
 * kolom nominal DITURUNKAN dari definisi ini — bukan ditulis tangan — supaya
 * tidak bisa bergeser lagi saat kolom ditambah (temuan audit: dulu
 * `[3, 4, 7, 9, 15]`, padahal kolom Rupiah ada di 3, 4, 10, 12, 17).
 */
const KOLOM_KOLEKTIBILITAS_DATAR: { judul: string; rupiah?: true }[] = [
  { judul: 'No Anggota' },
  { judul: 'Nama Anggota' },
  { judul: 'No Pinjaman' },
  { judul: 'Saldo Piutang (Pokok+Jasa)', rupiah: true },
  { judul: 'Saldo Pokok (Outstanding)', rupiah: true },
  { judul: 'Tanggal Jatuh Tempo' },
  { judul: 'Hari Tunggakan' },
  { judul: 'Pola Pengembalian' },
  { judul: 'Tunggakan Pokok (bulan)' },
  { judul: 'Tunggakan Jasa (bulan)' },
  { judul: 'Angsuran Terbayar', rupiah: true },
  { judul: 'Angsuran / Kewajiban (%)' },
  { judul: 'Nilai Agunan', rupiah: true },
  { judul: 'Agunan / Sisa Utang (%)' },
  { judul: 'Kolektibilitas (SOM)' },
  { judul: 'Dasar Penggolongan' },
  { judul: '% Penyisihan' },
  { judul: 'Nilai Penyisihan', rupiah: true },
  { judul: 'Status Anggota' },
];
const KOLOM_KOLEKTIBILITAS_FISKAL: { judul: string; rupiah?: true }[] = [
  { judul: 'Kolektibilitas Fiskal' },
  { judul: 'Dasar Pencadangan Fiskal', rupiah: true },
  { judul: '% Cadangan Fiskal' },
  { judul: 'Cadangan Fiskal', rupiah: true },
];

export function buildKolektibilitasExport(
  info: InfoKoperasiExport,
  periodeLabel: string,
  daftar: ItemKolektibilitasExport[],
  opsi: OpsiExportKolektibilitas = {}
): DataLaporanExport {
  const LABEL = LABEL_KOLEKTIBILITAS_SOM;
  const KATEGORI_URUT = KOLEKTIBILITAS_SOM_URUT;
  const adaFiskal = daftar.length > 0 && daftar.every((d) => typeof d.cadanganFiskal === 'number' && !!d.kolektibilitasFiskal);
  const jumlah = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const persenFiskalKategori = (kat: KolektibilitasSom, items: ItemKolektibilitasExport[]): string => {
    const t = opsi.tarifFiskal?.[kat] ?? items[0]?.persentaseCadanganFiskal;
    return typeof t === 'number' ? persenId(t) : '-';
  };

  // Audit ulang (permintaan pengguna §23-25): ringkasan/total berbasis
  // PINJAMAN OUTSTANDING (saldoPokok), bukan saldoPiutang (pokok + jasa
  // belum terbayar) — basis yang dipakai `hitungCadangan()`.
  const totalOutstanding = jumlah(daftar, (d) => d.saldoPokok);
  const totalPiutang = jumlah(daftar, (d) => d.saldoPiutang);
  const totalCadangan = jumlah(daftar, (d) => d.nilaiCadangan);
  const totalAgunan = jumlah(daftar, (d) => d.nilaiAgunan);
  const bermasalah = daftar.filter((d) => d.bermasalah);
  const outstandingBermasalah = jumlah(bermasalah, (d) => d.saldoPokok);
  const rasioBermasalah = totalOutstanding > 0 ? (outstandingBermasalah / totalOutstanding) * 100 : 0;
  const totalCadanganFiskal = adaFiskal ? jumlah(daftar, (d) => d.cadanganFiskal ?? 0) : 0;
  const totalDasarFiskal = adaFiskal ? jumlah(daftar, (d) => d.dasarPencadanganFiskal ?? 0) : 0;
  // v82 (RC-S133.6.4) — pinjaman Macet karena kriteria angka 3 (penyelesaian dicatat manual).
  const macetAngka3 = daftar.filter((d) => d.penyelesaianBerlaku && d.penyelesaianJalur);
  const jumlahMacetAngka3 = macetAngka3.length;
  const rujukanMacetAngka3 = macetAngka3
    .map((d) => `${d.nomorPinjaman} (${ringkasPenyelesaian({ jalur: d.penyelesaianJalur as JalurPenyelesaian, nomor: d.penyelesaianNomor, tanggal: d.penyelesaianTanggal })})`)
    .join('; ');

  // ---- Ringkasan datar (tetap, untuk konsumen lama) ----
  const ringkasan: BarisRingkasan[] = KATEGORI_URUT.map((kat) => {
    const items = daftar.filter((d) => d.kolektibilitas === kat);
    return {
      label: `${LABEL[kat]} (${items.length} pinjaman)`,
      nilai: `Outstanding ${formatRupiah(jumlah(items, (d) => d.saldoPokok))} — Cadangan ${formatRupiah(jumlah(items, (d) => d.nilaiCadangan))}`,
    };
  });
  ringkasan.push({ label: 'Total Outstanding', nilai: formatRupiah(totalOutstanding) });
  ringkasan.push({
    label: 'Pinjaman Bermasalah (Kurang Lancar + Diragukan + Macet)',
    nilai: `${formatRupiah(outstandingBermasalah)} — ${rasioBermasalah.toFixed(2)}% dari outstanding`,
  });
  ringkasan.push({ label: 'Taksiran Piutang Tak Tertagih (SOM angka 15)', nilai: formatRupiah(totalCadangan) });
  const DASAR_SOM =
    'Juklat SOM Deputi Bidang Pengawasan Koperasi No. 3/2025 angka 12.1 (ambang bulan tunggakan relatif masa angsuran; Diragukan bila angsuran >= 75% kewajiban atau agunan >= 100% sisa utang; Macet termasuk aturan 21 bulan) & angka 15 (cadangan risiko 0/50/75/100%)';
  ringkasan.push({ label: 'Dasar penggolongan', nilai: DASAR_SOM });
  if (adaFiskal) {
    ringkasan.push({ label: 'Cadangan diakui fiskal (PMK 74/2024)', nilai: formatRupiah(totalCadanganFiskal) });
    ringkasan.push({ label: 'Selisih cadangan buku − fiskal', nilai: formatRupiah(totalCadangan - totalCadanganFiskal) });
  }

  // ---- Tabel datar ----
  const defKolom = adaFiskal ? [...KOLOM_KOLEKTIBILITAS_DATAR, ...KOLOM_KOLEKTIBILITAS_FISKAL] : KOLOM_KOLEKTIBILITAS_DATAR;
  const baris = daftar.map((d) => [
    d.nomorAnggota,
    d.namaAnggota,
    d.nomorPinjaman,
    d.saldoPiutang,
    d.saldoPokok,
    d.tanggalJatuhTempoTertunggak ?? '-',
    d.hariTunggakan,
    d.polaPengembalian === 'TANPA_ANGSURAN' ? 'Tanpa Angsuran' : 'Dengan Angsuran',
    d.bulanTunggakanPokok,
    d.bulanTunggakanJasa,
    d.angsuranTerbayar,
    d.rasioAngsuranPersen.toFixed(1),
    d.nilaiAgunan,
    d.rasioAgunanPersen.toFixed(1),
    LABEL[d.kolektibilitas],
    d.dasarPenggolongan,
    `${d.persentaseCadangan}%`,
    d.nilaiCadangan,
    d.statusAnggota,
    ...(adaFiskal
      ? [LABEL[d.kolektibilitasFiskal!], d.dasarPencadanganFiskal ?? 0, `${d.persentaseCadanganFiskal ?? 0}%`, d.cadanganFiskal ?? 0]
      : []),
  ]);

  // ============================================================
  // RC-S133.6.3 — DOKUMEN BERSEKSI (PDF/Excel/CSV): ringkas, berurutan,
  // dan tiap tabel cukup sempit untuk A4. Dulu satu tabel 19 kolom terpotong
  // di PDF, persen tertulis "61.1", dan angka fiskal di layar tidak ikut.
  // ============================================================
  const urutRisiko = [...KATEGORI_URUT].reverse();
  const terurut = [...daftar].sort(
    (a, b) => urutRisiko.indexOf(a.kolektibilitas) - urutRisiko.indexOf(b.kolektibilitas) || b.saldoPokok - a.saldoPokok
  );
  const anggota = (d: ItemKolektibilitasExport) => `${d.nomorAnggota} — ${d.namaAnggota}`;

  const seksiRingkasan: BarisRingkasan[] = [
    { label: 'Jumlah pinjaman', nilai: `${daftar.length} pinjaman` },
    ...(opsi.lingkupAnggota ? [{ label: 'Lingkup anggota', nilai: opsi.lingkupAnggota }] : []),
    { label: 'Outstanding (saldo pokok)', nilai: formatRupiah(totalOutstanding) },
    { label: 'Saldo piutang (pokok + jasa)', nilai: formatRupiah(totalPiutang) },
    {
      label: 'Pinjaman bermasalah',
      nilai: `${formatRupiah(outstandingBermasalah)} (${persenId(rasioBermasalah, 2)}) — ${bermasalah.length} pinjaman`,
    },
    { label: 'Penyisihan menurut SOM (buku)', nilai: formatRupiah(totalCadangan) },
  ];
  if (opsi.penyisihanTercatat !== undefined && opsi.penyisihanTercatat !== null) {
    seksiRingkasan.push({ label: 'Penyisihan tercatat di buku besar', nilai: formatRupiah(opsi.penyisihanTercatat) });
    const sel = totalCadangan - opsi.penyisihanTercatat;
    seksiRingkasan.push({
      label: 'Penyesuaian penyisihan yang diperlukan',
      nilai: sel === 0 ? 'Tidak ada (sudah sesuai)' : `${sel > 0 ? 'Tambah' : 'Kurangi'} ${formatRupiah(Math.abs(sel))}`,
    });
  }
  if (adaFiskal) {
    const sel = totalCadangan - totalCadanganFiskal;
    seksiRingkasan.push({ label: 'Cadangan diakui fiskal (PMK 74/2024)', nilai: formatRupiah(totalCadanganFiskal) });
    seksiRingkasan.push({
      label: 'Selisih buku − fiskal',
      nilai:
        sel === 0
          ? 'Rp0 — tidak ada koreksi fiskal'
          : `${formatRupiah(Math.abs(sel))} — calon koreksi fiskal ${sel > 0 ? 'POSITIF' : 'NEGATIF'} SPT Badan`,
    });
  }

  const seksi: SeksiLaporan[] = [
    { jenis: 'KV', judul: 'Ringkasan', baris: seksiRingkasan, labelTebal: ['Outstanding (saldo pokok)', 'Penyisihan menurut SOM (buku)'] },
    {
      jenis: 'TABEL',
      judul: 'Rekap per Kolektibilitas (SOM)',
      kolom: ['Kolektibilitas', 'Jumlah', 'Outstanding', '% Outstanding', '% Penyisihan', 'Penyisihan'],
      kolomAngka: [2, 5],
      baris: KATEGORI_URUT.map((kat) => {
        const items = daftar.filter((d) => d.kolektibilitas === kat);
        const out = jumlah(items, (d) => d.saldoPokok);
        return [
          LABEL[kat],
          items.length,
          out,
          persenId(totalOutstanding > 0 ? (out / totalOutstanding) * 100 : 0),
          // Tarif SOM angka 15 dari konstanta mesin aturan (juga untuk kategori tanpa pinjaman).
          persenId(PERSENTASE_PENYISIHAN_SOM[kat]),
          jumlah(items, (d) => d.nilaiCadangan),
        ];
      }),
      barisTotal: ['Jumlah', daftar.length, totalOutstanding, totalOutstanding > 0 ? '100%' : '0%', '', totalCadangan],
    },
    {
      jenis: 'TABEL',
      judul: 'Rincian per Pinjaman',
      kolom: ['Anggota', 'No Pinjaman', 'Outstanding', 'Saldo Piutang', 'Tunggakan (bln) Pokok/Jasa', 'Hari', 'Kolektibilitas', '% Peny.', 'Penyisihan'],
      kolomAngka: [2, 3, 8],
      baris: terurut.map((d) => [
        anggota(d),
        d.nomorPinjaman,
        d.saldoPokok,
        d.saldoPiutang,
        `${d.bulanTunggakanPokok} / ${d.bulanTunggakanJasa}`,
        d.hariTunggakan,
        LABEL[d.kolektibilitas],
        persenId(d.persentaseCadangan),
        d.nilaiCadangan,
      ]),
      barisTotal: ['Jumlah', `${daftar.length} pinjaman`, totalOutstanding, totalPiutang, '', '', '', '', totalCadangan],
      teksKosong: 'Tidak ada pinjaman aktif bersaldo pada tanggal ini.',
      catatan: 'Diurutkan dari risiko tertinggi (Macet) lalu outstanding terbesar.',
    },
    {
      jenis: 'TABEL',
      judul: 'Dasar Penggolongan per Pinjaman',
      kolom: ['No Pinjaman', 'Masa Angsuran', 'Angsuran Terbayar', 'Terbayar / Kewajiban', 'Nilai Agunan', 'Agunan / Sisa Utang', 'Dasar Penggolongan'],
      kolomAngka: [2, 4],
      baris: terurut.map((d) => [
        d.nomorPinjaman,
        d.polaPengembalian === 'TANPA_ANGSURAN' ? 'Tanpa angsuran' : `${d.masaAngsuranBulan} bulan`,
        d.angsuranTerbayar,
        persenId(d.rasioAngsuranPersen),
        d.nilaiAgunan,
        d.nilaiAgunan > 0 ? persenId(d.rasioAgunanPersen) : 'Tanpa agunan',
        // Teks dari mesin aturan memakai titik desimal ("61.1%"); disajikan gaya Indonesia.
        d.dasarPenggolongan.replace(/(\d)\.(\d+)%/g, '$1,$2%'),
      ]),
      teksKosong: 'Tidak ada pinjaman.',
    },
  ];

  if (adaFiskal) {
    seksi.push(
      {
        jenis: 'TABEL',
        judul: 'Batasan Fiskal Cadangan Piutang (PMK 74/2024)',
        kolom: ['Kolektibilitas Fiskal', 'Jumlah', 'Dasar Pencadangan', '% Fiskal', 'Cadangan Fiskal', 'Cadangan Buku', 'Selisih'],
        kolomAngka: [2, 4, 5, 6],
        baris: KATEGORI_URUT.map((kat) => {
          const items = daftar.filter((d) => d.kolektibilitasFiskal === kat);
          const fisk = jumlah(items, (d) => d.cadanganFiskal ?? 0);
          const buku = jumlah(items, (d) => d.nilaiCadangan);
          return [
            LABEL[kat],
            items.length,
            jumlah(items, (d) => d.dasarPencadanganFiskal ?? 0),
            persenFiskalKategori(kat, items),
            fisk,
            buku,
            buku - fisk,
          ];
        }),
        barisTotal: ['Jumlah', daftar.length, totalDasarFiskal, '', totalCadanganFiskal, totalCadangan, totalCadangan - totalCadanganFiskal],
        catatan:
          'Dasar pencadangan fiskal = saldo pokok dikurangi nilai agunan, kecuali Lancar (tanpa pengurang agunan). Selisih positif = cadangan buku melebihi batas fiskal (koreksi fiskal positif). Laporan pembanding, tidak membuat jurnal.',
      },
      {
        jenis: 'TABEL',
        judul: 'Rincian Fiskal per Pinjaman',
        kolom: ['No Pinjaman', 'Outstanding', 'Nilai Agunan', 'Dasar Fiskal', '% Fiskal', 'Cadangan Fiskal', 'Cadangan Buku'],
        kolomAngka: [1, 2, 3, 5, 6],
        baris: terurut.map((d) => [
          d.nomorPinjaman,
          d.saldoPokok,
          d.nilaiAgunan,
          d.dasarPencadanganFiskal ?? 0,
          persenId(d.persentaseCadanganFiskal ?? 0),
          d.cadanganFiskal ?? 0,
          d.nilaiCadangan,
        ]),
        barisTotal: ['Jumlah', totalOutstanding, totalAgunan, totalDasarFiskal, '', totalCadanganFiskal, totalCadangan],
      }
    );
  }

  seksi.push({
    jenis: 'KV',
    judul: 'Dasar & Catatan',
    baris: [
      { label: 'Dasar penggolongan', nilai: DASAR_SOM },
      {
        label: 'Penafsiran masa angsuran',
        nilai:
          'Masa angsuran tepat 1 bulan dan 4–5 bulan tidak disebut eksplisit dalam naskah; aplikasi memakai ambang kelompok 1–3 bulan (tunggakan > 3 bulan = Kurang Lancar, > 6 bulan melewati Kurang Lancar). Penafsiran ini perlu dikonfirmasi pengawas/pengurus koperasi.',
      },
      {
        label: 'Kriteria Macet angka 3',
        // v82 (RC-S133.6.4): kriteria ini dapat dicatat manual (Detail Pinjaman,
        // Admin/Pengurus) dan dipakai penggolongan sejak tanggal pencatatan.
        nilai:
          'Penyerahan ke Pengadilan Negeri / klaim asuransi kredit dicatat manual oleh Admin/Pengurus di Detail Pinjaman (nomor perkara/klaim dan dokumen); ' +
          'pinjaman yang tercatat digolongkan Macet sejak tanggal pencatatan. ' +
          (jumlahMacetAngka3 > 0
            ? `Pada laporan ini ${jumlahMacetAngka3} pinjaman digolongkan Macet karena kriteria ini: ${rujukanMacetAngka3}.`
            : 'Pada laporan ini tidak ada pinjaman yang tercatat memenuhi kriteria ini.'),
      },
      { label: 'Basis nilai', nilai: 'Penyisihan & batas fiskal dihitung atas saldo pokok (outstanding); saldo piutang ditampilkan sebagai pembanding.' },
    ],
  });

  return {
    judulLaporan: 'Kolektibilitas Piutang Pinjaman Anggota',
    namaFileDasar: 'kolektibilitas-piutang-pinjaman',
    ...info,
    periodeLabel,
    kolom: defKolom.map((k) => k.judul),
    baris,
    // Indeks kolom Rupiah DITURUNKAN dari definisi kolom (lihat di atas).
    kolomAngka: defKolom.flatMap((k, i) => (k.rupiah ? [i] : [])),
    ringkasan,
    seksi,
  };
}

// ============================================================
// 19. DAFTAR ASET TETAP (§10, permintaan pengguna)
// ============================================================
export function buildDaftarAsetExport(
  info: InfoKoperasiExport,
  daftar: {
    nomorAset: string;
    namaAset: string;
    kelompokAset: string | null;
    subKelompokAset: string | null;
    masaManfaatBulan: number;
    nilaiPerolehan: number;
    tanggalPerolehan: string;
    akumulasiPenyusutan: number;
    nilaiBuku: number;
    status: 'AKTIF' | 'DIHAPUS';
    // Permintaan pengguna §12 — kolom terpisah supaya jelas per baris
    // mana yang Penyusutan (Aset Tetap) vs Amortisasi (Aset Tak
    // Berwujud); optional untuk kompatibilitas pemanggil lama.
    jenisAset?: 'TETAP' | 'TAK_BERWUJUD';
  }[]
): DataLaporanExport {
  const totalPerolehan = daftar.reduce((a, d) => a + d.nilaiPerolehan, 0);
  const totalNilaiBuku = daftar.reduce((a, d) => a + d.nilaiBuku, 0);
  return {
    judulLaporan: 'Daftar Aset Tetap',
    namaFileDasar: 'daftar-aset-tetap',
    ...info,
    periodeLabel: `Per ${getTanggalLokalHariIni()}`,
    kolom: [
      'Nomor Aset',
      'Nama Aset',
      'Klasifikasi',
      'Sub Kelompok',
      'Jenis Aset',
      'Masa Manfaat',
      'Nilai Perolehan',
      'Tanggal Perolehan',
      // Kolom gabungan (§12) — dasar akun aktualnya TETAP dipisah per
      // jenis di jurnal/COA (Akumulasi Penyusutan vs Akumulasi
      // Amortisasi), label netral ini HANYA untuk tabel campuran ini.
      'Akumulasi Penyusutan/Amortisasi',
      'Nilai Buku',
      'Status',
    ],
    baris: daftar.map((d) => [
      d.nomorAset,
      d.namaAset,
      d.kelompokAset ?? 'Belum Diklasifikasikan',
      d.subKelompokAset ?? '-',
      d.jenisAset === 'TAK_BERWUJUD' ? 'Aset Tak Berwujud' : 'Aset Tetap',
      `${d.masaManfaatBulan} bulan`,
      d.nilaiPerolehan,
      d.tanggalPerolehan,
      d.akumulasiPenyusutan,
      d.nilaiBuku,
      d.status === 'AKTIF' ? 'Aktif' : 'Nonaktif',
    ]),
    kolomAngka: [6, 8, 9],
    ringkasan: [
      { label: 'Total Nilai Perolehan', nilai: formatRupiah(totalPerolehan) },
      { label: 'Total Nilai Buku', nilai: formatRupiah(totalNilaiBuku) },
    ],
  };
}

// ============================================================
// 20. DAFTAR INVESTASI (§11, permintaan pengguna)
// ============================================================
export function buildDaftarInvestasiExport(
  info: InfoKoperasiExport,
  daftar: {
    nomorInvestasi: string;
    jenisInvestasi: string;
    namaTujuan: string;
    jumlah: number;
    tanggal: string;
    sumberDana: string;
    keterangan: string | null;
    status: string;
    nomorRekeningInvestasi?: string | null;
    lokasiProperti?: string | null;
  }[]
): DataLaporanExport {
  // Label lokal (BUKAN import dari InvestasiService.ts) — pola yang
  // sama dengan builder lain (RAK/Kolektibilitas): builder export
  // TIDAK boleh menarik masuk `@/database/db` (lewat rantai import
  // service -> db.ts -> expo-sqlite, modul native yang tidak bisa
  // di-parse Jest di luar mock). Audit ulang (permintaan pengguna
  // §2/§3): 5 label baru ditambahkan, harus SAMA PERSIS dengan
  // `LABEL_JENIS_INVESTASI` di InvestasiService.ts.
  const JENIS_LABEL: Record<string, string> = {
    UNIT_USAHA: 'Unit Usaha Internal',
    KOPERASI_LAIN: 'Penyertaan pada Koperasi Lain',
    USAHA_LAIN: 'Usaha Lain',
    TABUNGAN_BANK_UMUM: 'Tabungan',
    GIRO_BANK_UMUM: 'Giro',
    DEPOSITO_BANK_UMUM: 'Deposito',
    PROPERTI_INVESTASI: 'Properti Investasi',
  };
  const totalAktif = daftar.filter((d) => d.status === 'AKTIF').reduce((a, d) => a + d.jumlah, 0);
  return {
    judulLaporan: 'Daftar Investasi',
    namaFileDasar: 'daftar-investasi',
    ...info,
    periodeLabel: `Per ${getTanggalLokalHariIni()}`,
    kolom: [
      'Tanggal',
      'Jenis Investasi',
      'Nama Tujuan',
      'Nominal',
      'Rekening',
      'Nomor Rekening Investasi',
      'Lokasi Properti',
      'Keterangan',
      'Status',
    ],
    baris: daftar.map((d) => [
      d.tanggal,
      JENIS_LABEL[d.jenisInvestasi] ?? d.jenisInvestasi,
      d.namaTujuan,
      d.jumlah,
      d.sumberDana === 'BANK' ? 'Bank' : 'Kas',
      d.nomorRekeningInvestasi ?? '-',
      d.lokasiProperti ?? '-',
      d.keterangan ?? '-',
      d.status === 'AKTIF' ? 'Aktif' : 'Dibatalkan',
    ]),
    kolomAngka: [3],
    ringkasan: [{ label: 'Total Investasi Aktif', nilai: formatRupiah(totalAktif) }],
  };
}

// ============================================================
// 21. DAFTAR UTANG (§E, permintaan pengguna)
// ============================================================
export function buildUtangExport(
  info: InfoKoperasiExport,
  daftar: {
    nomorUtang: string;
    tanggal: string;
    namaPemberi: string;
    jenisPemberi: string;
    pokokPinjaman: number;
    persenBunga: number;
    status: string;
    sisaPokok: number;
    sumber: string;
    keterangan: string | null;
  }[]
): DataLaporanExport {
  const JENIS_PEMBERI_LABEL: Record<string, string> = {
    BANK: 'Bank',
    PIHAK_LAIN: 'Pihak Lain',
    UTANG_USAHA: 'Utang Usaha (Pembelian Aset)',
  };
  const SUMBER_LABEL: Record<string, string> = {
    LANGSUNG: 'Langsung',
    PEMBELIAN_ASET: 'Pembelian Aset',
  };
  const totalPokok = daftar.reduce((a, d) => a + d.pokokPinjaman, 0);
  const totalSisa = daftar.filter((d) => d.status === 'AKTIF').reduce((a, d) => a + d.sisaPokok, 0);
  return {
    judulLaporan: 'Daftar Utang Koperasi',
    namaFileDasar: 'daftar-utang',
    ...info,
    periodeLabel: `Per ${getTanggalLokalHariIni()}`,
    kolom: ['Nomor Utang', 'Tanggal', 'Nama Pemberi', 'Jenis Pemberi', 'Pokok Pinjaman', 'Bunga (%)', 'Sisa Kewajiban', 'Sumber', 'Status', 'Keterangan'],
    baris: daftar.map((d) => [
      d.nomorUtang,
      d.tanggal,
      d.namaPemberi,
      JENIS_PEMBERI_LABEL[d.jenisPemberi] ?? d.jenisPemberi,
      d.pokokPinjaman,
      d.persenBunga,
      d.sisaPokok,
      SUMBER_LABEL[d.sumber] ?? d.sumber,
      d.status === 'AKTIF' ? 'Aktif' : 'Lunas',
      d.keterangan ?? '-',
    ]),
    kolomAngka: [4, 6],
    ringkasan: [
      { label: 'Total Pokok Pinjaman', nilai: formatRupiah(totalPokok) },
      { label: 'Total Sisa Kewajiban (Aktif)', nilai: formatRupiah(totalSisa) },
    ],
  };
}
