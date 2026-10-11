import type { AkadUlangDocumentData } from '@/services/PinjamanService';
import type { SusunanPengurusInti } from '@/services/PengurusInti';
import {
  buatNomorDokumenAkadAwal,
  buatNomorDokumenAkadUlang,
  formatPersenJasa,
  formatTanggalPanjang,
  formatTenor,
  hitungPeriodeRelatifAkadUlang,
  jatuhTempoAkhir,
  labelMetodeJasa,
  labelStatusEventAkadUlang,
  tentukanStatusEventAkadUlang,
} from '@/services/AkadUlangPresentasi';
import { formatRupiah, Rupiah } from '@/utils/money';

/**
 * RC-S82 — VIEW MODEL "DOKUMEN AKAD ULANG PINJAMAN" (MURNI).
 * ============================================================
 * Data in (`AkadUlangDocumentData`, hasil loader read-only), view model
 * out. Tidak ada I/O dan tidak ada perhitungan accounting: seluruh
 * nominal adalah SNAPSHOT event atau nilai baris jadwal apa adanya.
 *
 * SENGAJA TERPISAH dari `DataLaporanExport`/`buildReportHtml()`: itu
 * adalah pipeline TABEL generik (PDF/Excel/CSV) yang dipakai seluruh
 * laporan. Dokumen akad ulang adalah dokumen administratif dengan
 * struktur bab, tabel perbandingan, dan ruang pengesahan — memaksanya ke
 * pipeline generik akan mengubah perilaku semua laporan lain.
 */

export const JUDUL_DOKUMEN_AKAD_ULANG = 'DOKUMEN AKAD ULANG PINJAMAN';

export const CATATAN_PIUTANG_JASA =
  'Piutang jasa yang telah diakui merupakan informasi historis/audit dan tidak menambah pokok akad ulang.';

export const CATATAN_JADWAL_LAMA =
  'Jadwal angsuran sebelum akad ulang ini tetap tersimpan sebagai histori dan tidak menjadi kewajiban berjalan.';

export interface BarisLabelNilai {
  label: string;
  nilai: string;
}

export interface BarisPerubahanAkad {
  komponen: string;
  sebelum: string;
  sesudah: string;
}

export interface BarisJadwalDokumen {
  /** "1/6" — RELATIF terhadap akad ulang ini, BUKAN nomor internal. */
  periode: string;
  /** Nomor internal `angsuran_jadwal.nomor_angsuran` (hanya untuk jejak audit). */
  nomorInternal: number;
  jatuhTempo: string;
  pokok: Rupiah;
  jasa: Rupiah;
  total: Rupiah;
}

export interface DokumenAkadUlang {
  namaFileDasar: string;
  judul: string;
  koperasi: { nama: string; alamat: string | null };
  nomorPinjaman: string;
  nomorDokumen: string;
  tanggalAkadUlang: string;
  urutanLabel: string;
  statusEventLabel: string;
  identitasDokumen: BarisLabelNilai[];
  identitasAnggota: BarisLabelNilai[];
  referensiAkadAwal: BarisLabelNilai[];
  perubahan: BarisPerubahanAkad[];
  /** Nilai SNAPSHOT `pinjaman_akad_ulang.sisa_pokok`. */
  sisaPokok: Rupiah;
  /** Nilai SNAPSHOT `pinjaman_akad_ulang.outstanding_piutang_jasa` — informasi saja. */
  piutangJasaDiakui: Rupiah;
  catatanPiutangJasa: string;
  jadwal: BarisJadwalDokumen[];
  totalJadwal: { pokok: Rupiah; jasa: Rupiah; total: Rupiah };
  keterangan: string | null;
  namaAnggota: string;
  namaKoperasi: string;
  /** Pengurus yang menjabat pada tanggal akad ulang (penanda tangan). */
  pengurus: SusunanPengurusInti;
  /** Nomor Perjanjian Pinjaman (akad awal) yang diubah oleh dokumen ini. */
  nomorAkadAwal: string;
  footer: { nomorPinjaman: string; nomorDokumen: string; tanggalCetak: string; catatan: string };
}

export function buildDokumenAkadUlang(data: AkadUlangDocumentData, opts: { tanggalCetak: string }): DokumenAkadUlang {
  const { event, eventSebelumnya, akadAwal } = data;
  const nomorDokumen = buatNomorDokumenAkadUlang(data.pinjaman.nomorPinjaman, event.tanggal, data.urutanEvent);

  const periodeRelatif = hitungPeriodeRelatifAkadUlang(data.jadwal);
  const jadwalUrut = [...data.jadwal].sort((a, b) => a.nomorAngsuran - b.nomorAngsuran);
  const jadwal: BarisJadwalDokumen[] = jadwalUrut.map((j) => {
    const rel = periodeRelatif.get(j.id);
    return {
      periode: rel ? `${rel.periode}/${rel.jumlah}` : '-',
      nomorInternal: j.nomorAngsuran,
      jatuhTempo: formatTanggalPanjang(j.tanggalJatuhTempo),
      pokok: j.pokok,
      jasa: j.jasa,
      total: j.total,
    };
  });
  const totalJadwal = jadwal.reduce(
    (a, j) => ({ pokok: a.pokok + j.pokok, jasa: a.jasa + j.jasa, total: a.total + j.total }),
    { pokok: 0, jasa: 0, total: 0 }
  );

  // Dasar pokok SEBELUM event ini: jumlah pinjaman awal untuk akad ulang
  // pertama; snapshot sisa pokok event sebelumnya untuk akad ulang
  // berikutnya. Keduanya nilai tersimpan — bukan hasil hitung ulang.
  const dasarPokokSebelum = eventSebelumnya ? eventSebelumnya.sisaPokok : akadAwal.jumlahPinjaman;
  const jatuhTempoSesudah = jatuhTempoAkhir(data.jadwal);

  const statusEvent = tentukanStatusEventAkadUlang(event.id, data.jadwal);

  return {
    namaFileDasar: `dokumen-akad-ulang-${data.pinjaman.nomorPinjaman}-${String(data.urutanEvent).padStart(3, '0')}`,
    judul: JUDUL_DOKUMEN_AKAD_ULANG,
    koperasi: data.koperasi,
    nomorPinjaman: data.pinjaman.nomorPinjaman,
    nomorDokumen,
    tanggalAkadUlang: formatTanggalPanjang(event.tanggal),
    urutanLabel: `Akad Ulang ke-${data.urutanEvent} dari ${data.jumlahEvent}`,
    statusEventLabel: labelStatusEventAkadUlang(statusEvent),
    identitasDokumen: [
      { label: 'Nomor Pinjaman', nilai: data.pinjaman.nomorPinjaman },
      { label: 'Nomor Akad Ulang', nilai: nomorDokumen },
      { label: 'Tanggal Akad Ulang', nilai: formatTanggalPanjang(event.tanggal) },
      { label: 'Urutan', nilai: `Akad Ulang ke-${data.urutanEvent} dari ${data.jumlahEvent}` },
      { label: 'Status Akad', nilai: labelStatusEventAkadUlang(statusEvent) },
    ],
    identitasAnggota: [
      { label: 'Nama', nilai: data.anggota.namaLengkap },
      { label: 'Nomor Anggota', nilai: data.anggota.nomorAnggota },
      { label: 'NIK', nilai: data.anggota.nik || '-' },
      { label: 'Alamat', nilai: data.anggota.alamat || '-' },
    ],
    referensiAkadAwal: [
      { label: 'Tanggal Akad Awal', nilai: formatTanggalPanjang(akadAwal.tanggal) },
      { label: 'Jumlah Pinjaman Awal', nilai: formatRupiah(akadAwal.jumlahPinjaman) },
      { label: 'Tenor Awal', nilai: formatTenor(akadAwal.tenor, akadAwal.satuanTenor) },
      { label: 'Metode Jasa Awal', nilai: labelMetodeJasa(akadAwal.metodeJasa) },
      { label: 'Persentase Jasa Awal', nilai: formatPersenJasa(akadAwal.persentaseJasa) },
    ],
    perubahan: [
      {
        komponen: 'Tenor',
        sebelum: formatTenor(event.tenorLama, event.satuanTenorLama),
        sesudah: formatTenor(event.tenorBaru, event.satuanTenorBaru),
      },
      { komponen: 'Metode Jasa', sebelum: labelMetodeJasa(event.metodeJasaLama), sesudah: labelMetodeJasa(event.metodeJasaBaru) },
      {
        komponen: 'Persentase Jasa',
        sebelum: formatPersenJasa(event.persentaseJasaLama),
        sesudah: formatPersenJasa(event.persentaseJasaBaru),
      },
      { komponen: 'Dasar Pokok', sebelum: formatRupiah(dasarPokokSebelum), sesudah: formatRupiah(event.sisaPokok) },
      {
        komponen: 'Jatuh Tempo',
        sebelum: formatTanggalPanjang(data.jatuhTempoSebelum),
        sesudah: formatTanggalPanjang(jatuhTempoSesudah),
      },
    ],
    sisaPokok: event.sisaPokok,
    piutangJasaDiakui: event.outstandingPiutangJasa,
    catatanPiutangJasa: CATATAN_PIUTANG_JASA,
    jadwal,
    totalJadwal,
    keterangan: event.keterangan && event.keterangan.trim() ? event.keterangan.trim() : null,
    namaAnggota: data.anggota.namaLengkap,
    namaKoperasi: data.koperasi.nama,
    pengurus: data.pengurus,
    nomorAkadAwal: buatNomorDokumenAkadAwal(data.pinjaman.nomorPinjaman, data.akadAwal.tanggal),
    footer: {
      nomorPinjaman: data.pinjaman.nomorPinjaman,
      nomorDokumen,
      tanggalCetak: opts.tanggalCetak,
      catatan: CATATAN_JADWAL_LAMA,
    },
  };
}
