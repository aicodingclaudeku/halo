import Decimal from 'decimal.js';
import { roundToRupiah, percentageOf, sum, Rupiah } from '@/utils/money';

/**
 * Kalkulator SHU (Sisa Hasil Usaha) — murni fungsi matematis tanpa akses
 * database, mengikuti pola PinjamanCalculator.ts supaya bisa diuji unit
 * test tanpa SQLite (PRD §29).
 */

export interface KonfigurasiPersentaseSHU {
  persenCadangan: number;
  persenJasaModal: number;
  persenJasaUsaha: number;
  persenPendidikan: number;
  persenSosial: number;
  persenPengurus: number;
  persenPengawas: number;
  /** Update pasca-Phase 18/19 (permintaan pengguna §U): komponen distribusi baru — "Karyawan". */
  persenKaryawan: number;
  /** Update pasca-Phase 18/19 (permintaan pengguna §U): komponen distribusi baru — "Pembangunan Daerah Kerja". */
  persenPembangunanDaerahKerja: number;
  /**
   * Audit ulang (permintaan pengguna §13/§16): komponen distribusi
   * baru — "Cadangan Risiko" — akun EKUITAS TERPISAH dari Cadangan
   * (Umum, field `persenCadangan` di atas — label tampilannya berubah
   * jadi "Cadangan Umum" tapi field ini SENGAJA TIDAK di-rename, lihat
   * defaultCOA.ts). BEDA PENTING dari `persenCadangan`: field ini
   * adalah pool NOMINAL TETAP (persentase × totalSHU), BUKAN penampung
   * residual pembulatan — `cadangan`/Cadangan Umum tetap satu-satunya
   * yang menyerap sisa pembulatan & pool jasa modal/usaha yang tidak
   * terbagi (lihat komentar `cadangan` di RingkasanSHU). Default 0
   * untuk konfigurasi lama (TIDAK mengubah persentase existing lain).
   */
  persenCadanganRisiko: number;
  // `persenLainnya`/"Lainnya (%)" DIHAPUS TOTAL (audit ulang §5/§6/§7):
  // bukan lagi komponen distribusi SHU yang bisa dikonfigurasi. Nilai
  // persentase komponen LAIN (cadangan/jasaModal/.../pembangunanDaerahKerja)
  // yang SUDAH TERSIMPAN di aplikasi TIDAK diubah sama sekali oleh
  // penghapusan ini — hanya field `persenLainnya` yang hilang dari
  // bentuk data. Jika total 8 komponen di atas belum genap 100% setelah
  // "Lainnya" dihapus, `validasiTotalPersentase` akan menolak (bukan
  // menormalisasi otomatis) — lihat komentar di sana.
}

export interface AnggotaBasisSHU {
  anggotaId: string;
  basisSimpanan: Rupiah; // total simpanan pokok+wajib+sukarela s.d. akhir tahun buku
  basisPartisipasiUsaha: Rupiah; // total jasa pinjaman yang dibayar selama tahun buku
}

export interface HasilSHUAnggota {
  anggotaId: string;
  basisSimpanan: Rupiah;
  basisPartisipasiUsaha: Rupiah;
  jasaModal: Rupiah;
  jasaUsaha: Rupiah;
  totalShuAnggota: Rupiah;
}

export interface RingkasanSHU {
  totalSHU: Rupiah;
  totalSHUPositif: boolean;
  /**
   * Cadangan — SEKARANG JUGA menyerap seluruh selisih rekonsiliasi
   * (audit ulang pasca penghapusan "Lainnya" §7): (a) selisih
   * pembulatan Rupiah antar pool, dan (b) sisa pool jasa modal/jasa
   * usaha yang tidak bisa dibagi ke anggota (basis 0 / tidak ada
   * anggota bertransaksi). Tidak ada lagi komponen residual terpisah
   * "Lainnya" — cadangan dipilih sebagai penampung deterministik
   * karena secara substansi adalah pos cadangan/ekuitas koperasi,
   * bukan dana dengan peruntukan spesifik seperti pendidikan/sosial/dst.
   * Persentase `persenCadangan` itu sendiri TIDAK diubah oleh mekanisme
   * ini — hanya NOMINAL HASIL (Rupiah) yang mendapat tambahan selisih.
   */
  cadangan: Rupiah;
  /**
   * Audit ulang §13/§16: pool NOMINAL TETAP (persentase × totalSHU) —
   * BEDA dari `cadangan` di atas, field ini TIDAK ikut menyerap sisa
   * pembulatan/pool tak terbagi (murni hasil `persenCadanganRisiko`).
   */
  cadanganRisiko: Rupiah;
  jasaModal: Rupiah; // jumlah yang BENAR-BENAR terdistribusi ke anggota (bisa < pool jika basis 0)
  jasaUsaha: Rupiah; // jumlah yang BENAR-BENAR terdistribusi ke anggota (bisa < pool jika basis 0)
  pendidikan: Rupiah;
  sosial: Rupiah;
  pengurus: Rupiah;
  pengawas: Rupiah;
  karyawan: Rupiah;
  pembangunanDaerahKerja: Rupiah;
  anggota: HasilSHUAnggota[];
}

/** Toleransi pembulatan saat validasi total persentase = 100% (PRD §29). */
const TOLERANSI_PERSEN = 0.01;

export class TotalPersentaseTidakValidError extends Error {
  constructor(total: number) {
    super(`Total persentase SHU harus 100%, saat ini ${total}%. Periksa kembali konfigurasi.`);
    this.name = 'TotalPersentaseTidakValidError';
  }
}

/**
 * Audit ulang §7: dijaga sebagai pengaman terakhir supaya perhitungan
 * TIDAK PERNAH diam-diam menghasilkan nominal negatif pada komponen
 * mana pun (mis. selisih pembulatan negatif yang kebetulan lebih besar
 * dari pool cadangan pada persentase cadangan yang sangat kecil) —
 * kondisi ini seharusnya tidak pernah terjadi pada konfigurasi wajar,
 * tapi jika terjadi harus GAGAL EKSPLISIT, bukan menampilkan
 * "Lainnya -Rp2" atau nominal minus lainnya.
 */
export class HasilPerhitunganNegatifError extends Error {
  constructor(komponen: string, nilai: number) {
    super(
      `Perhitungan SHU menghasilkan nominal negatif pada komponen ${komponen} (${nilai}). ` +
        `Periksa kembali konfigurasi persentase SHU.`
    );
    this.name = 'HasilPerhitunganNegatifError';
  }
}

/**
 * Phase 13 (audit SHU): sebelumnya totalSHU negatif (koperasi rugi
 * tahun berjalan) tidak pernah dicek di sini — perhitungan tetap
 * jalan menghasilkan pool & jasa modal/usaha NEGATIF, dan baru gagal
 * belakangan di `AccountingEngine.createJournal()` (saat `bagikanSHU`)
 * dengan pesan generik "Nominal debit/kredit tidak boleh negatif" —
 * benar secara SISTEM (tidak sampai membuat jurnal yang salah), tapi
 * membingungkan sebagai pesan BISNIS. SHU secara konsep memang tidak
 * berlaku untuk kerugian (rugi tidak "dibagikan" ke anggota, itu
 * ditanggung/dibawa maju sebagai kerugian — di luar scope modul SHU
 * ini) — sekarang ditolak eksplisit & jelas SEBELUM ada write apa pun.
 */
export class ShuNegatifError extends Error {
  constructor(totalSHU: number) {
    super(
      `SHU tidak boleh negatif (hasil usaha saat ini ${totalSHU}, artinya koperasi rugi). SHU tidak bisa dihitung/dibagikan untuk kerugian — kerugian perlu ditangani lewat mekanisme lain (mis. dibawa maju atau ditanggung cadangan), bukan modul SHU ini.`
    );
    this.name = 'ShuNegatifError';
  }
}

/**
 * Validasi PRD §29: "Validasi: TOTAL = 100%". Update pasca-Phase 18/19
 * §U: 2 komponen baru (Karyawan, Pembangunan Daerah Kerja) ikut
 * dihitung dalam total.
 *
 * Audit ulang §5/§6/§7 (penghapusan "Lainnya (%)"): total sekarang
 * HANYA dari komponen yang memang ada (tanpa `persenLainnya`). Kalau
 * total belum genap 100% setelah "Lainnya" dihapus, fungsi ini
 * MENOLAK — TIDAK menormalisasi otomatis (tidak menaikkan/menurunkan
 * komponen lain, tidak membuat "Lainnya" kembali). Admin harus
 * menyesuaikan sendiri konfigurasi lewat layar Form SHU sampai total
 * genap 100%.
 *
 * Audit ulang §13/§16: `persenCadanganRisiko` (komponen baru) SEKARANG
 * ikut dihitung dalam total (10 komponen). Sama seperti komponen lain:
 * TIDAK ada normalisasi otomatis — kalau total belum 100% setelah
 * Cadangan Risiko ditambahkan, fungsi ini menolak & admin harus
 * menyesuaikan sendiri (bisa termasuk Cadangan Risiko itu sendiri).
 */
export function validasiTotalPersentase(config: KonfigurasiPersentaseSHU): void {
  const total =
    config.persenCadangan +
    config.persenJasaModal +
    config.persenJasaUsaha +
    config.persenPendidikan +
    config.persenSosial +
    config.persenPengurus +
    config.persenPengawas +
    config.persenKaryawan +
    config.persenPembangunanDaerahKerja +
    config.persenCadanganRisiko;

  if (Math.abs(total - 100) > TOLERANSI_PERSEN) {
    throw new TotalPersentaseTidakValidError(Math.round(total * 100) / 100);
  }
}

/**
 * Membagi satu pool nominal secara proporsional ke banyak anggota
 * berdasarkan basis masing-masing, dengan koreksi pembulatan supaya
 * total yang terbagi PERSIS SAMA dengan pool (selisih pembulatan
 * dilimpahkan ke anggota dengan basis terbesar) — pola yang sama
 * dengan distributeWithRoundingFix di PinjamanCalculator.ts.
 *
 * Jika total basis 0 (tidak ada aktivitas sama sekali), pool tidak
 * dibagi (semua anggota dapat 0) — sisa pool ini HARUS ditambahkan
 * pemanggil ke Cadangan (lihat `hitungRingkasanSHU`) supaya total SHU
 * tetap rekonsiliasi, tanpa membuat komponen "Lainnya".
 */
function bagiProporsional(pool: Rupiah, basis: { anggotaId: string; nilai: Rupiah }[]): Map<string, Rupiah> {
  const hasil = new Map<string, Rupiah>();
  const totalBasis = sum(basis.map((b) => b.nilai));

  if (totalBasis <= 0 || pool === 0) {
    basis.forEach((b) => hasil.set(b.anggotaId, 0));
    return hasil;
  }

  let totalTerbagi = 0;
  let idBasisTerbesar = basis[0]?.anggotaId;
  let basisTerbesar = -Infinity;

  for (const b of basis) {
    const bagian = roundToRupiah(new Decimal(pool).mul(b.nilai).div(totalBasis));
    hasil.set(b.anggotaId, bagian);
    totalTerbagi += bagian;
    if (b.nilai > basisTerbesar) {
      basisTerbesar = b.nilai;
      idBasisTerbesar = b.anggotaId;
    }
  }

  const selisih = pool - totalTerbagi;
  if (selisih !== 0 && idBasisTerbesar) {
    hasil.set(idBasisTerbesar, (hasil.get(idBasisTerbesar) ?? 0) + selisih);
  }

  return hasil;
}

/**
 * Hitung ringkasan & distribusi SHU. totalSHU HARUS berasal dari
 * Laporan Hasil Usaha (hasilUsaha, lihat FinancialReports.getLabaRugi)
 * — bukan angka rekaan (PRD: "jangan menggunakan data dummy").
 */
export function hitungRingkasanSHU(
  totalSHU: Rupiah,
  config: KonfigurasiPersentaseSHU,
  basisAnggota: AnggotaBasisSHU[]
): RingkasanSHU {
  validasiTotalPersentase(config);
  if (totalSHU < 0) {
    throw new ShuNegatifError(totalSHU);
  }

  // Pool per kategori (10 komponen, tanpa "Lainnya" — audit ulang §5/§6/§7/§13).
  const cadanganPool = percentageOf(totalSHU, config.persenCadangan);
  const cadanganRisiko = percentageOf(totalSHU, config.persenCadanganRisiko);
  const jasaModalPool = percentageOf(totalSHU, config.persenJasaModal);
  const jasaUsahaPool = percentageOf(totalSHU, config.persenJasaUsaha);
  const pendidikan = percentageOf(totalSHU, config.persenPendidikan);
  const sosial = percentageOf(totalSHU, config.persenSosial);
  const pengurus = percentageOf(totalSHU, config.persenPengurus);
  const pengawas = percentageOf(totalSHU, config.persenPengawas);
  const karyawan = percentageOf(totalSHU, config.persenKaryawan);
  const pembangunanDaerahKerja = percentageOf(totalSHU, config.persenPembangunanDaerahKerja);

  const jasaModalTerbagi = bagiProporsional(
    jasaModalPool,
    basisAnggota.map((b) => ({ anggotaId: b.anggotaId, nilai: b.basisSimpanan }))
  );
  const jasaUsahaTerbagi = bagiProporsional(
    jasaUsahaPool,
    basisAnggota.map((b) => ({ anggotaId: b.anggotaId, nilai: b.basisPartisipasiUsaha }))
  );

  const anggota: HasilSHUAnggota[] = basisAnggota.map((b) => {
    const jasaModal = jasaModalTerbagi.get(b.anggotaId) ?? 0;
    const jasaUsaha = jasaUsahaTerbagi.get(b.anggotaId) ?? 0;
    return {
      anggotaId: b.anggotaId,
      basisSimpanan: b.basisSimpanan,
      basisPartisipasiUsaha: b.basisPartisipasiUsaha,
      jasaModal,
      jasaUsaha,
      totalShuAnggota: jasaModal + jasaUsaha,
    };
  });

  const jasaModalTerdistribusi = sum(anggota.map((a) => a.jasaModal));
  const jasaUsahaTerdistribusi = sum(anggota.map((a) => a.jasaUsaha));

  // Audit ulang §5/§6/§7 (penghapusan "Lainnya"): SELURUH selisih
  // rekonsiliasi — (a) koreksi pembulatan Rupiah antar pool, DAN (b)
  // sisa pool jasa modal/usaha yang tidak terbagi ke anggota (basis 0)
  // — dilimpahkan ke komponen Cadangan yang MEMANG SUDAH ADA (bukan
  // membuat "Lainnya" baru; lihat komentar `cadangan` di RingkasanSHU).
  // Persentase `persenCadangan` TIDAK berubah — hanya nominal HASIL.
  const totalSebelumSelisih = sum([
    cadanganPool,
    cadanganRisiko,
    jasaModalTerdistribusi,
    jasaUsahaTerdistribusi,
    pendidikan,
    sosial,
    pengurus,
    pengawas,
    karyawan,
    pembangunanDaerahKerja,
  ]);
  const selisih = totalSHU - totalSebelumSelisih;
  const cadangan = cadanganPool + selisih;

  if (cadangan < 0) {
    throw new HasilPerhitunganNegatifError('Cadangan Umum', cadangan);
  }

  return {
    totalSHU,
    totalSHUPositif: totalSHU > 0,
    cadangan,
    cadanganRisiko,
    jasaModal: jasaModalTerdistribusi,
    jasaUsaha: jasaUsahaTerdistribusi,
    pendidikan,
    sosial,
    pengurus,
    pengawas,
    karyawan,
    pembangunanDaerahKerja,
    anggota,
  };
}
