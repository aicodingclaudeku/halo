import type { AkadAwalDocumentData } from '@/services/PinjamanService';
import type { SusunanPengurusInti } from '@/services/PengurusInti';
import {
  buatNomorDokumenAkadAwal,
  formatPersenJasa,
  formatTanggalPanjang,
  formatTenor,
  jatuhTempoAkhir,
  labelBiayaAdmin,
  labelMetodeJasa,
  labelStatusEventAkadUlang,
  labelSatuanTenor,
  labelTujuanPinjaman,
  statusDokumenAkadAwal,
  tentukanStatusJadwalKontrak,
} from '@/services/AkadUlangPresentasi';
import { formatRupiah, Rupiah } from '@/utils/money';
import { namaHari, terbilang, terbilangRupiah } from '@/utils/terbilang';
import { DASAR_HUKUM_PERJANJIAN_PINJAMAN, DASAR_KEWENANGAN_PENGURUS } from './DasarHukumAkad';
import type { BarisKv, BarisJadwalHtml } from './DokumenKontrakHtml';

/**
 * RC-S82 — VIEW MODEL "PERJANJIAN PINJAMAN" (AKAD AWAL), MURNI.
 * ============================================================
 * Format mengikuti perjanjian pinjaman koperasi pada umumnya:
 * kepala perjanjian (hari & tanggal), komparisi PARA PIHAK, dasar hukum,
 * pasal-pasal, tanda tangan, dan LAMPIRAN jadwal angsuran.
 *
 * Batas yang DIJAGA (aturan proyek — tidak mengarang kebijakan):
 *  - Semua angka berasal dari data tersimpan / penjumlahan jadwal.
 *  - Denda: hanya "diberlakukan sesuai ketentuan koperasi" atau "tidak
 *    dikenakan" — besaran denda TIDAK ditulis ulang di sini.
 *  - Pelunasan dipercepat & penagihan: merujuk ketentuan koperasi dan
 *    AD/ART, tanpa menetapkan tarif/penalti baru.
 *  - Teks pasal adalah TEMPLATE UMUM yang perlu ditinjau pengurus /
 *    penasihat hukum koperasi sebelum dipakai (dicatat di laporan sesi).
 */

export const JUDUL_DOKUMEN_AKAD_AWAL = 'PERJANJIAN PINJAMAN';

export interface PasalPerjanjian {
  nomor: number;
  judul: string;
  /** Satu elemen = paragraf tunggal; lebih dari satu = ayat bernomor (1), (2), ... */
  ayat: string[];
}

export interface DokumenAkadAwal {
  namaFileDasar: string;
  judul: string;
  koperasi: { nama: string; alamat: string | null; nomorBadanHukum: string | null };
  nomorPinjaman: string;
  nomorDokumen: string;
  sifat: 'FINAL' | 'BELUM_DICAIRKAN';
  statusAkadLabel: string;
  pemberitahuanPenggantian: string | null;
  /** "Pada hari ini, Kamis, tanggal 1 Januari 2026, yang bertanda tangan di bawah ini:" */
  kalimatPembukaan: string;
  pihakPertama: { rincian: BarisKv[]; peran: string };
  pihakKedua: { rincian: BarisKv[]; peran: string };
  kalimatKesepakatan: string;
  dasarHukum: readonly string[];
  pasal: PasalPerjanjian[];
  /** Ringkasan ketentuan (dicetak pada Lampiran di atas jadwal). */
  ketentuan: BarisKv[];
  jumlahPinjaman: Rupiah;
  totalJadwal: { pokok: Rupiah; jasa: Rupiah; total: Rupiah };
  jadwal: BarisJadwalHtml[];
  namaAnggota: string;
  pengurus: SusunanPengurusInti;
  footer: { nomorPinjaman: string; nomorDokumen: string; tanggalCetak: string; catatan: string };
}

function tenorDenganTerbilang(tenor: number, satuan: string): string {
  return `${tenor} (${terbilang(tenor)}) ${labelSatuanTenor(satuan)}`;
}

function rupiahDenganTerbilang(n: Rupiah): string {
  return `${formatRupiah(n)} (${terbilangRupiah(n)})`;
}

export function buildDokumenAkadAwal(data: AkadAwalDocumentData, opts: { tanggalCetak: string }): DokumenAkadAwal {
  const p = data.pinjaman;
  const sifatDok = statusDokumenAkadAwal(p.statusSaatIni);
  if (sifatDok === 'TIDAK_TERSEDIA') throw new Error('Pinjaman yang ditolak tidak memiliki dokumen akad.');
  const sifat: 'FINAL' | 'BELUM_DICAIRKAN' = sifatDok;

  const nomorDokumen = buatNomorDokumenAkadAwal(p.nomorPinjaman, p.tanggal);
  const n = data.jadwal.length;
  const jadwal: BarisJadwalHtml[] = data.jadwal.map((j, idx) => ({
    periode: `${idx + 1}/${n}`,
    sub: null,
    jatuhTempo: formatTanggalPanjang(j.tanggalJatuhTempo),
    pokok: j.pokok,
    jasa: j.jasa,
    total: j.total,
  }));
  const totalJadwal = data.jadwal.reduce(
    (a, j) => ({ pokok: a.pokok + j.pokok, jasa: a.jasa + j.jasa, total: a.total + j.total }),
    { pokok: 0, jasa: 0, total: 0 }
  );
  const jatuhTempo = jatuhTempoAkhir(data.jadwal);

  const statusKontrak = tentukanStatusJadwalKontrak(data.jadwal);
  const statusAkadLabel =
    sifat === 'BELUM_DICAIRKAN'
      ? 'AKAD AWAL'
      : statusKontrak === 'DIGANTIKAN'
        ? 'HISTORIS — DIGANTIKAN AKAD ULANG'
        : labelStatusEventAkadUlang(statusKontrak);

  const pemberitahuanPenggantian = data.digantikanOleh
    ? `Perjanjian ini telah diubah melalui Akad Ulang tanggal ${formatTanggalPanjang(data.digantikanOleh.tanggal)}` +
      (data.jumlahAkadUlang > 1 ? ` (total ${data.jumlahAkadUlang} kali akad ulang)` : '') +
      '. Dokumen ini adalah salinan perjanjian awal untuk arsip; kewajiban berjalan mengikuti dokumen akad ulang terbaru.'
    : null;

  const kop = data.koperasi;
  const ketua = data.pengurus.KETUA;
  const tujuan = p.tujuan ? labelTujuanPinjaman(p.tujuan, p.tujuanDetail) : null;

  const pasal: PasalPerjanjian[] = [
    {
      nomor: 1,
      judul: 'Pokok Pinjaman',
      ayat: [
        `PIHAK PERTAMA memberikan pinjaman kepada PIHAK KEDUA sebesar ${rupiahDenganTerbilang(p.jumlahPinjaman)}` +
          (tujuan ? ` untuk keperluan ${tujuan}.` : '.'),
      ],
    },
    {
      nomor: 2,
      judul: 'Jangka Waktu',
      ayat: [
        `Pinjaman diberikan untuk jangka waktu ${tenorDenganTerbilang(p.tenor, p.satuanTenor)}, terhitung sejak ` +
          `tanggal ${formatTanggalPanjang(p.tanggal)} sampai dengan tanggal ${formatTanggalPanjang(jatuhTempo)}.`,
      ],
    },
    {
      nomor: 3,
      judul: 'Jasa Pinjaman dan Biaya',
      ayat: [
        `Atas pinjaman ini PIHAK KEDUA dikenakan jasa pinjaman sebesar ${formatPersenJasa(p.persentaseJasa)} dengan ` +
          `metode ${labelMetodeJasa(p.metodeJasa)}, dengan jumlah jasa sesuai jadwal angsuran sebesar ` +
          `${rupiahDenganTerbilang(totalJadwal.jasa)}.`,
        `Biaya administrasi pinjaman: ${labelBiayaAdmin(p.biayaAdminTipe, p.biayaAdminNilai, formatRupiah)}.`,
      ],
    },
    {
      nomor: 4,
      judul: 'Cara Pembayaran',
      ayat: [
        `PIHAK KEDUA wajib membayar kembali pinjaman beserta jasanya secara angsuran sebanyak ${n} (${terbilang(n)}) kali ` +
          `sesuai Jadwal Angsuran pada Lampiran yang merupakan bagian tidak terpisahkan dari Perjanjian ini, dengan jumlah ` +
          `kewajiban seluruhnya sebesar ${rupiahDenganTerbilang(totalJadwal.total)}.`,
        'Pembayaran dilakukan kepada PIHAK PERTAMA melalui kas koperasi atau rekening yang ditunjuk oleh PIHAK PERTAMA, ' +
          'dan setiap pembayaran dibuktikan dengan tanda terima yang sah.',
      ],
    },
    {
      nomor: 5,
      judul: 'Keterlambatan dan Kelalaian',
      ayat: [
        p.dendaAktif
          ? 'Keterlambatan pembayaran angsuran dikenakan denda sesuai ketentuan yang berlaku pada PIHAK PERTAMA.'
          : 'Atas keterlambatan pembayaran angsuran tidak dikenakan denda; namun PIHAK KEDUA tetap berkewajiban melunasi angsuran yang tertunggak.',
        'Apabila PIHAK KEDUA lalai memenuhi kewajibannya berdasarkan Perjanjian ini, PIHAK PERTAMA berhak melakukan ' +
          'penagihan dan penyelesaian sesuai Anggaran Dasar, Anggaran Rumah Tangga Koperasi, dan peraturan perundang-undangan yang berlaku.',
      ],
    },
    {
      nomor: 6,
      judul: 'Pelunasan Sebelum Jatuh Tempo',
      ayat: [
        'PIHAK KEDUA dapat melunasi seluruh sisa pinjaman sebelum tanggal jatuh tempo sesuai ketentuan yang berlaku pada PIHAK PERTAMA.',
      ],
    },
    {
      nomor: 7,
      judul: 'Perubahan Perjanjian',
      ayat: [
        'Setiap perubahan atas ketentuan Perjanjian ini, termasuk akad ulang, dituangkan dalam dokumen tertulis yang ' +
          'ditandatangani PARA PIHAK dan merupakan bagian yang tidak terpisahkan dari Perjanjian ini.',
      ],
    },
    {
      nomor: 8,
      judul: 'Pelindungan Data Pribadi',
      ayat: [
        'PIHAK KEDUA menyetujui pemrosesan data pribadinya oleh PIHAK PERTAMA sebatas untuk keperluan pelaksanaan ' +
          'Perjanjian ini, dan PIHAK PERTAMA wajib menjaga kerahasiaan data tersebut sesuai Undang-Undang Nomor 27 ' +
          'Tahun 2022 tentang Pelindungan Data Pribadi.',
      ],
    },
    {
      nomor: 9,
      judul: 'Penyelesaian Perselisihan',
      ayat: [
        'Perselisihan yang timbul dari Perjanjian ini diselesaikan secara musyawarah untuk mufakat.',
        'Apabila musyawarah tidak mencapai mufakat, PARA PIHAK sepakat menyelesaikannya melalui Pengadilan Negeri yang ' +
          'wilayah hukumnya meliputi tempat kedudukan PIHAK PERTAMA.',
      ],
    },
    {
      nomor: 10,
      judul: 'Penutup',
      ayat: [
        'Perjanjian ini dibuat dalam rangkap 2 (dua), masing-masing bermeterai cukup dan mempunyai kekuatan hukum yang ' +
          'sama, serta mulai berlaku sejak ditandatangani oleh PARA PIHAK.',
      ],
    },
  ];

  return {
    namaFileDasar: `perjanjian-pinjaman-${p.nomorPinjaman}`,
    judul: JUDUL_DOKUMEN_AKAD_AWAL,
    koperasi: kop,
    nomorPinjaman: p.nomorPinjaman,
    nomorDokumen,
    sifat,
    statusAkadLabel,
    pemberitahuanPenggantian,
    kalimatPembukaan: `Pada hari ini, ${namaHari(p.tanggal)}, tanggal ${formatTanggalPanjang(p.tanggal)}, yang bertanda tangan di bawah ini:`,
    pihakPertama: {
      rincian: [
        { label: 'Nama', nilai: ketua?.nama ?? '.............................................' },
        { label: 'Jabatan', nilai: `Ketua ${kop.nama}` },
      ],
      peran:
        `Dalam hal ini bertindak dalam jabatannya tersebut untuk dan atas nama ${kop.nama}` +
        (kop.nomorBadanHukum ? `, badan hukum koperasi Nomor ${kop.nomorBadanHukum}` : '') +
        (kop.alamat ? `, berkedudukan di ${kop.alamat}` : '') +
        `, berdasarkan ${DASAR_KEWENANGAN_PENGURUS}, selanjutnya disebut PIHAK PERTAMA.`,
    },
    pihakKedua: {
      rincian: [
        { label: 'Nama', nilai: data.anggota.namaLengkap },
        { label: 'Nomor Anggota', nilai: data.anggota.nomorAnggota },
        { label: 'NIK', nilai: data.anggota.nik || '-' },
        { label: 'Alamat', nilai: data.anggota.alamat || '-' },
      ],
      peran: `Dalam hal ini bertindak untuk dan atas nama diri sendiri selaku anggota ${kop.nama}, selanjutnya disebut PIHAK KEDUA.`,
    },
    kalimatKesepakatan:
      'PIHAK PERTAMA dan PIHAK KEDUA secara bersama-sama disebut PARA PIHAK. PARA PIHAK terlebih dahulu menerangkan ' +
      'bahwa PIHAK KEDUA telah mengajukan pinjaman kepada PIHAK PERTAMA dan PIHAK PERTAMA menyetujuinya, sehingga PARA ' +
      'PIHAK sepakat mengikatkan diri dalam Perjanjian Pinjaman ini dengan berdasarkan pada:',
    dasarHukum: DASAR_HUKUM_PERJANJIAN_PINJAMAN,
    pasal,
    ketentuan: [
      { label: 'Jumlah Pinjaman', nilai: formatRupiah(p.jumlahPinjaman) },
      { label: 'Tenor', nilai: formatTenor(p.tenor, p.satuanTenor) },
      { label: 'Metode Jasa', nilai: labelMetodeJasa(p.metodeJasa) },
      { label: 'Persentase Jasa', nilai: formatPersenJasa(p.persentaseJasa) },
      { label: 'Biaya Administrasi', nilai: labelBiayaAdmin(p.biayaAdminTipe, p.biayaAdminNilai, formatRupiah) },
      { label: 'Denda Keterlambatan', nilai: p.dendaAktif ? 'Diberlakukan sesuai ketentuan koperasi' : 'Tidak diberlakukan' },
      { label: 'Tujuan Pinjaman', nilai: labelTujuanPinjaman(p.tujuan, p.tujuanDetail) },
      { label: 'Jatuh Tempo Akhir', nilai: formatTanggalPanjang(jatuhTempo) },
    ],
    jumlahPinjaman: p.jumlahPinjaman,
    totalJadwal,
    jadwal,
    namaAnggota: data.anggota.namaLengkap,
    pengurus: data.pengurus,
    footer: {
      nomorPinjaman: p.nomorPinjaman,
      nomorDokumen,
      tanggalCetak: opts.tanggalCetak,
      catatan: data.digantikanOleh
        ? 'Perjanjian ini telah diubah melalui akad ulang; jadwal pada lampiran tersimpan sebagai histori dan tidak menjadi kewajiban berjalan.'
        : 'Dokumen ini disusun dari data pinjaman yang tercatat pada sistem koperasi.',
    },
  };
}
