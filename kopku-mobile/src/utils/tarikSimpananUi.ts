import type { StatusSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import type { RingkasanPencairan } from '@/services/SimpananBerjangkaLifecycleService';
import type { HasilSettlementDini } from '@/accounting/EarlyWithdrawalCalculation';

/**
 * Logika TAMPILAN murni layar Tarik Simpanan Anggota.
 *
 * TIDAK ADA PERHITUNGAN. Setiap nominal diambil APA ADANYA dari objek
 * service (`HasilSettlementDini` dari `previewPencairanDini()` dan
 * `RingkasanPencairan` dari `getRingkasanPencairan()`), sehingga angka
 * pada konfirmasi mustahil berbeda dengan angka yang dibukukan.
 */

export type JenisTransaksiBerjangka = 'JATUH_TEMPO' | 'PENARIKAN_DINI' | 'SELESAI';

/**
 * Jenis transaksi DITENTUKAN SISTEM dari status kontrak — pengguna tidak
 * memilihnya. Status `JATUH_TEMPO` ditetapkan lifecycle/scheduler
 * berdasarkan tanggal jatuh tempo; `AKTIF` berarti belum jatuh tempo.
 * Sama persis dengan `modeDini` di layar (status === 'AKTIF').
 */
export function jenisTransaksiBerjangka(status: StatusSimpananBerjangka): JenisTransaksiBerjangka {
  if (status === 'JATUH_TEMPO') return 'JATUH_TEMPO';
  if (status === 'AKTIF') return 'PENARIKAN_DINI';
  return 'SELESAI';
}

export type NadaBadge = 'OK' | 'WARN' | 'MUTED';

export function badgeKontrak(
  status: StatusSimpananBerjangka,
  kebijakanDiniAktif: boolean
): { label: string; keterangan: string; nada: NadaBadge } {
  switch (status) {
    case 'JATUH_TEMPO':
      return { label: 'Jatuh Tempo', keterangan: 'Siap dicairkan', nada: 'OK' };
    case 'AKTIF':
      return {
        label: 'Penarikan Dini',
        keterangan: kebijakanDiniAktif ? 'Sebelum jatuh tempo' : 'Kebijakan belum ditetapkan',
        nada: 'WARN',
      };
    case 'DICAIRKAN':
      return { label: 'Sudah dicairkan', keterangan: 'Kontrak selesai', nada: 'MUTED' };
    default:
      return { label: 'Dibatalkan', keterangan: 'Kontrak tidak berlaku', nada: 'MUTED' };
  }
}

export interface BarisKonfirmasi {
  label: string;
  nilai: number;
  jenis: 'TAMBAH' | 'KURANG' | 'TOTAL';
}

/**
 * Ringkasan konfirmasi penarikan dini. Pokok, bunga berjalan, bunga hangus,
 * penalti, biaya administrasi, dan total SELALU tampil (walau 0) supaya
 * anggota melihat seluruh komponen; penyesuaian rate hanya tampil bila
 * tidak nol.
 *
 * Sesuai invarian `EarlyWithdrawalCalculation`:
 *   total = pokok + (bunga berjalan ± penyesuaian rate) − forfeiture
 *           − penalti − biaya administrasi
 * `penyesuaianPokok`/`penyesuaianBunga` BUKAN potongan tambahan —
 * keduanya hanya ALOKASI penalti + biaya ke pokok atau bunga — sehingga
 * tidak ditampilkan sebagai baris pengurang (akan terbaca dobel). Alokasi
 * akhirnya ditampilkan lewat `alokasiPembayaranDini()`.
 */
export function ringkasanKonfirmasiDini(s: HasilSettlementDini): BarisKonfirmasi[] {
  const baris: BarisKonfirmasi[] = [
    { label: 'Pokok', nilai: s.pokokBruto, jenis: 'TAMBAH' },
    { label: 'Bunga', nilai: s.bungaAkrualKontrak, jenis: 'TAMBAH' },
  ];
  if (s.penyesuaianRate !== 0) {
    baris.push({
      // Hanya muncul untuk kebijakan versi lama yang memakai rate dini.
      label: 'Penyesuaian bunga',
      nilai: Math.abs(s.penyesuaianRate),
      jenis: s.penyesuaianRate < 0 ? 'KURANG' : 'TAMBAH',
    });
  }
  baris.push(
    { label: 'Bunga hangus', nilai: s.bungaHangus, jenis: 'KURANG' },
    { label: 'Penalti', nilai: s.penalti, jenis: 'KURANG' },
    { label: 'Biaya administrasi', nilai: s.biayaAdmin, jenis: 'KURANG' },
    { label: 'Total diterima anggota', nilai: s.totalPayout, jenis: 'TOTAL' }
  );
  return baris;
}

/** Komposisi total yang dibayarkan (dari service): bagian pokok & bagian bunga. */
export function alokasiPembayaranDini(s: HasilSettlementDini): { pokok: number; bunga: number } {
  return { pokok: s.pokokDibayar, bunga: s.bungaDibayar };
}

/** Ringkasan konfirmasi pencairan jatuh tempo (tanpa penalti/forfeiture/biaya — tidak berlaku). */
export function ringkasanKonfirmasiJatuhTempo(r: RingkasanPencairan): BarisKonfirmasi[] {
  // RC-S128 — kontrak dengan kebijakan produk: rekening berjangka hanya
  // mencairkan POKOK; bunga sudah/akan dikreditkan ke Simpanan Sukarela
  // (lihat `ringkasanBungaKeSukarela`). Tidak ada bunga tunai.
  if (r.pencairanPokokSaja) {
    return [
      { label: 'Pokok Simpanan Berjangka', nilai: r.pokok, jenis: 'TAMBAH' },
      { label: 'Total diterima tunai', nilai: r.totalPencairan, jenis: 'TOTAL' },
    ];
  }
  // Kontrak lama: bunga tunai hanya bagian yang BELUM dipindahkan ke
  // Simpanan Sukarela (fallback ke bunga terakru untuk data bentuk lama).
  return [
    { label: 'Pokok', nilai: r.pokok, jenis: 'TAMBAH' },
    { label: 'Bunga', nilai: r.bungaBelumDipindahkan ?? r.bungaTerakru, jenis: 'TAMBAH' },
    { label: 'Total diterima anggota', nilai: r.totalPencairan, jenis: 'TOTAL' },
  ];
}

/**
 * RC-S128 — informasi bunga yang TIDAK dibayar tunai pada pencairan, supaya
 * pengguna paham mengapa uang yang diterima hanya sebesar pokok. Semua
 * angka dari service (`getRingkasanPencairan`); tidak dihitung di layar.
 */
export function ringkasanBungaKeSukarela(r: RingkasanPencairan): { label: string; nilai: string }[] {
  if (!r.pencairanPokokSaja) return [];
  return [
    { label: 'Bunga sudah di Simpanan Sukarela (bruto)', nilai: String(r.bungaSudahDiSukarela ?? 0) },
    { label: 'Bunga terutang, dipindahkan ke Sukarela saat pencairan', nilai: String(r.bungaBelumDipindahkan ?? 0) },
    { label: 'PPh Pasal 4(2) sudah dipotong', nilai: String(r.pphSudahDipotong ?? 0) },
  ];
}

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** 'YYYY-MM-DD' -> '12 Des 2026'; string lain ditampilkan apa adanya. */
export function tanggalRingkas(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return iso ?? '-';
  return `${parseInt(m[3], 10)} ${BULAN[parseInt(m[2], 10) - 1] ?? m[2]} ${m[1]}`;
}
