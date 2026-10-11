import type {
  ArusKasResult,
  CalkResult,
  LhuResult,
  LhuRow,
  PerubahanEkuitasResult,
  PosisiKeuanganResult,
} from '@/reports/FinancialReports';
import { susunBagianArusKas, type BagianArusKas } from '@/reports/ArusKasJuklat';
import {
  KODE_BARIS_SHU_BERJALAN,
  URUTAN_PENYAJIAN_ASET,
  URUTAN_PENYAJIAN_EKUITAS,
  urutkanUntukPenyajian,
} from '@/reports/UrutanPenyajianPosisiKeuangan';
import { hitungKomposisiPendapatanLhu, formatPersenKomposisi } from '@/reports/KomposisiPendapatanLhu';
import { formatTanggalIndonesia, NAMA_BULAN } from '@/utils/reportPeriod';

/**
 * TAMPILAN PDF LAPORAN KEUANGAN MENURUT LAMPIRAN JUKLAT SOM 2025.
 * ============================================================
 * Mereplikasi format contoh pada Lampiran Petunjuk Pelaksanaan SOM
 * (Contoh Perhitungan Hasil Usaha, Contoh Neraca/Laporan Posisi Keuangan,
 * Contoh Laporan Arus Kas):
 *
 *   - kop DI DALAM tabel bergaris: NAMA KOPERASI (tebal, kapital),
 *     judul laporan (tebal), lalu baris periode ("Tahun yang berakhir
 *     31 Desember 2025 dan 2026" / "Tanggal ... (Dalam Rupiah)");
 *   - kolom angka berjudul TAHUN, urutan naskah: tahun LAMA di kiri,
 *     tahun BERJALAN di kanan;
 *   - angka tanpa "Rp", pemisah ribuan titik, pengurang dalam kurung;
 *   - band kelompok (PARTISIPASI ANGGOTA, ASET, KEGIATAN OPERASI, ...)
 *     tebal kapital, "Jumlah ..."/"Total ..." tebal menjorok, akun
 *     pengurang (penyisihan/akumulasi) menjorok satu tingkat.
 *
 * MURNI PENYAJIAN PDF: seluruh angka dibaca dari hasil service apa
 * adanya (tidak ada perhitungan akuntansi baru). Data Excel/CSV tetap
 * memakai baris builder yang lengkap — modul ini hanya mengatur bentuk
 * cetak PDF.
 */

export type TingkatJuklat = 'JUDUL' | 'RINCIAN' | 'KONTRA' | 'SUBTOTAL' | 'TOTAL' | 'PARAGRAF';

export interface BarisJuklat {
  label: string;
  /** Satu nilai per kolom angka; `null` = sel kosong (mis. band judul). */
  nilai: (number | null)[];
  tingkat: TingkatJuklat;
  /** Untuk tingkat PARAGRAF (CALK): teks isi di bawah judul bagian. */
  teks?: string;
  /** Nilai berupa teks per kolom (mis. "Belum dibagikan") — menggantikan angka pada kolom itu. */
  nilaiTeks?: (string | null)[];
}

export interface TampilanJuklat {
  /** Judul laporan pada kop (tanpa akhiran "— Komparatif"). */
  judul: string;
  /** Baris periode pada kop, mis. "Tahun yang berakhir 31 Desember 2025 dan 2026". */
  periode: string;
  /** Judul kolom angka, urut naskah (lama → baru). Kosong untuk laporan naratif (CALK). */
  kolom: string[];
  baris: BarisJuklat[];
  /** Keterangan di bawah tabel (mis. komposisi pendapatan seperti naskah). */
  keterangan?: { judul?: string; baris: string[] }[];
}

// ------------------------------------------------------------------
// Format angka & periode
// ------------------------------------------------------------------

function ribuan(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** "1.200.000", pengurang "(1.200.000)", nol "0" — seperti naskah. */
export function angkaJuklat(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return n < 0 ? `(${ribuan(n)})` : ribuan(n);
}

function tahun(iso: string): string {
  return iso.slice(0, 4);
}

function tahunPenuh(mulai: string, selesai: string): boolean {
  return mulai.endsWith('-01-01') && selesai.endsWith('-12-31') && tahun(mulai) === tahun(selesai);
}

/** "31 Desember" dari 'YYYY-MM-DD'. */
function hariBulan(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${NAMA_BULAN[Number(iso.slice(5, 7)) - 1] ?? ''}`;
}

/** Kolom angka: tahun bila berbeda, tanggal lengkap bila tahunnya sama (supaya tidak ambigu). */
export function kolomJuklat(tanggalAkhirUrutLamaKeBaru: string[]): string[] {
  const th = tanggalAkhirUrutLamaKeBaru.map(tahun);
  const unik = new Set(th).size === th.length;
  return unik ? th : tanggalAkhirUrutLamaKeBaru.map(formatTanggalIndonesia);
}

/** Periode laporan arus (LPHU, Arus Kas, Ekuitas) — urut lama → baru. */
export function periodeJuklat(periode: { mulai: string; selesai: string }[]): string {
  const semuaTahunPenuh = periode.every((p) => tahunPenuh(p.mulai, p.selesai));
  const akhirSama = new Set(periode.map((p) => p.selesai.slice(5))).size === 1;
  if (periode.length === 1) {
    const p = periode[0];
    return semuaTahunPenuh
      ? `Tahun yang berakhir ${formatTanggalIndonesia(p.selesai)}`
      : `Periode ${formatTanggalIndonesia(p.mulai)} s.d. ${formatTanggalIndonesia(p.selesai)}`;
  }
  const awalan = semuaTahunPenuh ? 'Tahun yang berakhir' : 'Periode yang berakhir';
  if (akhirSama && new Set(periode.map((p) => tahun(p.selesai))).size === periode.length) {
    return `${awalan} ${hariBulan(periode[0].selesai)} ${periode.map((p) => tahun(p.selesai)).join(' dan ')}`;
  }
  return `${awalan} ${periode.map((p) => formatTanggalIndonesia(p.selesai)).join(' dan ')}`;
}

/** Periode laporan posisi — urut lama → baru, dengan "(Dalam Rupiah)" seperti naskah. */
export function tanggalPosisiJuklat(tanggal: string[]): string {
  const akhirSama = new Set(tanggal.map((t) => t.slice(5))).size === 1;
  const tahunUnik = new Set(tanggal.map(tahun)).size === tanggal.length;
  const isi =
    tanggal.length > 1 && akhirSama && tahunUnik
      ? `${hariBulan(tanggal[0])} ${tanggal.map(tahun).join(' dan ')}`
      : tanggal.map(formatTanggalIndonesia).join(' dan ');
  return `Tanggal ${isi} (Dalam Rupiah)`;
}

// ------------------------------------------------------------------
// Penggabung baris lintas periode (urut lama → baru)
// ------------------------------------------------------------------

/** Satukan daftar akun beberapa periode per kode; akun yang hanya ada di satu periode tetap tampil (0 di periode lain). */
function gabungPerKode<T extends { kode: string; nama: string }>(
  daftar: T[][],
  nilai: (r: T) => number
): { kode: string; nama: string; nilai: number[] }[] {
  const urutan: string[] = [];
  const nama = new Map<string, string>();
  const peta = daftar.map((rows) => new Map(rows.map((r) => [r.kode, nilai(r)])));
  // Urutan kemunculan mengikuti periode TERBARU dulu, lalu sisanya.
  for (const rows of [...daftar].reverse()) {
    for (const r of rows) {
      if (!nama.has(r.kode)) {
        nama.set(r.kode, r.nama);
        urutan.push(r.kode);
      }
    }
  }
  return urutan.map((kode) => ({ kode, nama: nama.get(kode) ?? kode, nilai: peta.map((m) => m.get(kode) ?? 0) }));
}

const kosong = (n: number) => new Array<number | null>(n).fill(null);

// ------------------------------------------------------------------
// 1. LAPORAN PERHITUNGAN HASIL USAHA (Lampiran 1/2)
// ------------------------------------------------------------------

/**
 * Susunan baris PERSIS naskah: PARTISIPASI ANGGOTA → Jumlah partisipasi
 * anggota → BEBAN USAHA → Jumlah beban usaha → SISA HASIL USAHA BRUTO
 * (band) → hasil investasi & beban perkoperasian → PENDAPATAN & BEBAN
 * LAIN → Sisa hasil usaha sebelum pajak → Beban pajak penghasilan →
 * SISA HASIL USAHA → Penghasilan komprehensif lain → PENGHASILAN
 * KOMPREHENSIF. Akun dirinci per akun di tempat naskah menulis satu pos.
 */
export function tampilanLhuJuklat(judul: string, periode: LhuResult[]): TampilanJuklat {
  const n = periode.length;
  const baris: BarisJuklat[] = [];
  const judulBand = (label: string) => baris.push({ label, nilai: kosong(n), tingkat: 'JUDUL' });
  const rinci = (label: string, nilai: number[]) => baris.push({ label, nilai, tingkat: 'RINCIAN' });
  const akun = (ambil: (p: LhuResult) => LhuRow[], tanda: 1 | -1, labelKosong: string) => {
    const g = gabungPerKode(periode.map(ambil), (r) => r.jumlah * tanda);
    if (g.length === 0) rinci(labelKosong, periode.map(() => 0));
    else g.forEach((r) => rinci(r.nama, r.nilai));
  };
  const per = (f: (p: LhuResult) => number) => periode.map(f);

  judulBand('PARTISIPASI ANGGOTA');
  rinci('Pendapatan bunga', per((p) => p.pendapatanJasaPinjaman));
  akun((p) => p.pendapatanUsahaLain, 1, 'Pendapatan usaha lain');
  baris.push({ label: 'Jumlah partisipasi anggota', nilai: per((p) => p.jumlahPartisipasiAnggota), tingkat: 'SUBTOTAL' });

  judulBand('BEBAN USAHA');
  akun((p) => p.bebanUsaha, -1, 'Beban usaha');
  baris.push({ label: 'Jumlah beban usaha', nilai: per((p) => -p.jumlahBebanUsaha), tingkat: 'SUBTOTAL' });

  judulBand('SISA HASIL USAHA BRUTO');
  akun((p) => p.hasilInvestasi, 1, 'Hasil investasi');
  akun((p) => p.bebanPerkoperasian, -1, 'Beban perkoperasian');

  judulBand('PENDAPATAN & BEBAN LAIN');
  akun((p) => p.pendapatanLain, 1, 'Pendapatan lain');
  akun((p) => p.bebanLain, -1, 'Beban lain');

  rinci('Sisa hasil usaha sebelum pajak', per((p) => p.shuSebelumPajak));
  rinci('Beban pajak penghasilan', per((p) => -p.bebanPajakPenghasilan));
  baris.push({ label: 'SISA HASIL USAHA', nilai: per((p) => p.shuNeto), tingkat: 'TOTAL' });
  rinci('Penghasilan komprehensif lain', per((p) => p.totalOci));
  baris.push({ label: 'PENGHASILAN KOMPREHENSIF', nilai: per((p) => p.totalPenghasilanKomprehensif), tingkat: 'TOTAL' });

  // Penutup naskah: komposisi pendapatan per tahun.
  const kolom = kolomJuklat(periode.map((p) => p.tanggalSelesai));
  const keterangan = periode.map((p, i) => {
    const pendapatanUsahaLain = p.jumlahPartisipasiAnggota - p.pendapatanJasaPinjaman;
    const k = hitungKomposisiPendapatanLhu(p.jumlahPartisipasiAnggota, p.totalHasilInvestasi);
    const penyebut = `Rp (${angkaJuklat(p.pendapatanJasaPinjaman)} + ${angkaJuklat(pendapatanUsahaLain)} + ${angkaJuklat(p.totalHasilInvestasi)})`;
    return {
      judul: `TAHUN ${kolom[i]}`.toUpperCase(),
      baris: [
        `1. Rp ${angkaJuklat(p.jumlahPartisipasiAnggota)} / ${penyebut} × 100% = ${formatPersenKomposisi(k.persenPartisipasiAnggota)}`,
        `2. Rp ${angkaJuklat(p.totalHasilInvestasi)} / ${penyebut} × 100% = ${formatPersenKomposisi(k.persenHasilInvestasi)}`,
      ],
    };
  });

  return {
    judul,
    periode: periodeJuklat(periode.map((p) => ({ mulai: p.tanggalMulai, selesai: p.tanggalSelesai }))),
    kolom,
    baris,
    keterangan,
  };
}

// ------------------------------------------------------------------
// 2. LAPORAN POSISI KEUANGAN (Lampiran 3/4)
// ------------------------------------------------------------------

const KODE_KONTRA = new Set(['1-1210', '1-1510', '1-1670', '1-1710', '1-1900']);

function akunKontra(kode: string, nama: string): boolean {
  return KODE_KONTRA.has(kode) || /^(akumulasi|penyisihan|cadangan kerugian)/i.test(nama.trim());
}

export function tampilanPosisiJuklat(periode: PosisiKeuanganResult[]): TampilanJuklat {
  const n = periode.length;
  const baris: BarisJuklat[] = [];
  const band = (label: string) => baris.push({ label, nilai: kosong(n), tingkat: 'JUDUL' });
  const per = (f: (p: PosisiKeuanganResult) => number) => periode.map(f);

  band('ASET');
  urutkanUntukPenyajian(gabungPerKode(periode.map((p) => p.aset), (r) => r.saldo), URUTAN_PENYAJIAN_ASET).forEach((r) =>
    baris.push({ label: r.nama, nilai: r.nilai, tingkat: akunKontra(r.kode, r.nama) ? 'KONTRA' : 'RINCIAN' })
  );
  baris.push({ label: 'Total aset', nilai: per((p) => p.totalAset), tingkat: 'SUBTOTAL' });

  band('LIABILITAS');
  gabungPerKode(periode.map((p) => p.liabilitas), (r) => r.saldo).forEach((r) =>
    baris.push({ label: r.nama, nilai: r.nilai, tingkat: 'RINCIAN' })
  );
  baris.push({ label: 'Total liabilitas', nilai: per((p) => p.totalLiabilitas), tingkat: 'SUBTOTAL' });

  band('EKUITAS');
  const ekuitas = periode.map((p) =>
    p.labaBerjalan !== 0 || periode.some((q) => q.labaBerjalan !== 0)
      ? [...p.ekuitas, { kode: KODE_BARIS_SHU_BERJALAN, nama: periode[n - 1].labaBerjalanLabel, saldo: p.labaBerjalan }]
      : p.ekuitas
  );
  urutkanUntukPenyajian(gabungPerKode(ekuitas, (r) => r.saldo), URUTAN_PENYAJIAN_EKUITAS).forEach((r) =>
    baris.push({ label: r.nama, nilai: r.nilai, tingkat: 'RINCIAN' })
  );
  baris.push({ label: 'Total ekuitas', nilai: per((p) => p.totalEkuitas), tingkat: 'SUBTOTAL' });
  baris.push({ label: 'Total liabilitas dan ekuitas', nilai: per((p) => p.totalLiabilitas + p.totalEkuitas), tingkat: 'SUBTOTAL' });

  const peringatan: string[] = [];
  periode.forEach((p, i) => {
    if (!p.isBalanced) peringatan.push(`Kolom ${kolomJuklat(periode.map((q) => q.asOfDate))[i]}: total aset belum seimbang dengan total liabilitas dan ekuitas (selisih ${angkaJuklat(Math.abs(p.selisih))}).`);
  });
  let periodeTeks = tanggalPosisiJuklat(periode.map((p) => p.asOfDate));
  if (periode.some((p) => p.termasukSaldoAwalDraft)) periodeTeks += ' — termasuk saldo awal draf (belum final)';

  return {
    judul: 'Laporan Posisi Keuangan',
    periode: periodeTeks,
    kolom: kolomJuklat(periode.map((p) => p.asOfDate)),
    baris,
    keterangan: peringatan.length ? [{ judul: 'Perhatian', baris: peringatan }] : undefined,
  };
}

// ------------------------------------------------------------------
// 3. LAPORAN ARUS KAS (Lampiran 5/6)
// ------------------------------------------------------------------

const BAND_ARUS_KAS: Record<BagianArusKas, { judul: string; jumlah: string }> = {
  OPERASI: { judul: 'KEGIATAN OPERASI', jumlah: 'Jumlah arus kas operasi' },
  INVESTASI: { judul: 'KEGIATAN INVESTASI', jumlah: 'Jumlah arus kas investasi' },
  PENDANAAN: { judul: 'KEGIATAN PENDANAAN', jumlah: 'Jumlah arus kas pendanaan' },
};

export function tampilanArusKasJuklat(periode: ArusKasResult[], catatanPenyajian: readonly string[] = []): TampilanJuklat {
  const n = periode.length;
  const baris: BarisJuklat[] = [];
  const tersusun = periode.map((p) => susunBagianArusKas(p.rincian));
  for (let b = 0; b < tersusun[0].length; b++) {
    const bagian = tersusun[0][b].bagian;
    baris.push({ label: BAND_ARUS_KAS[bagian].judul, nilai: kosong(n), tingkat: 'JUDUL' });
    // Satukan pos per label (urutan pos mengikuti naskah via `urutan`).
    const pos = new Map<string, { urutan: number; nilai: number[] }>();
    tersusun.forEach((t, i) => {
      for (const r of t[b].baris) {
        const ada = pos.get(r.label) ?? { urutan: r.urutan, nilai: new Array(n).fill(0) };
        ada.nilai[i] += r.jumlah;
        pos.set(r.label, ada);
      }
    });
    const urut = [...pos.entries()].sort((x, y) => x[1].urutan - y[1].urutan || x[0].localeCompare(y[0], 'id'));
    if (urut.length === 0) baris.push({ label: 'Tidak ada mutasi kas', nilai: new Array(n).fill(0), tingkat: 'RINCIAN' });
    urut.forEach(([label, v]) => baris.push({ label, nilai: v.nilai, tingkat: 'RINCIAN' }));
    baris.push({ label: BAND_ARUS_KAS[bagian].jumlah, nilai: tersusun.map((t) => t[b].jumlah), tingkat: 'SUBTOTAL' });
  }
  const naik = periode.map((p) => p.perubahanKas);
  baris.push({ label: naik.some((x) => x < 0) ? 'KENAIKAN (PENURUNAN)' : 'KENAIKAN', nilai: naik, tingkat: 'TOTAL' });
  baris.push({ label: 'SALDO AWAL', nilai: periode.map((p) => p.kasAwal), tingkat: 'TOTAL' });
  baris.push({ label: 'SALDO AKHIR', nilai: periode.map((p) => p.kasAkhirDihitung), tingkat: 'TOTAL' });

  const kolom = kolomJuklat(periode.map((p) => p.tanggalSelesai));
  const rekon = periode
    .map((p, i) =>
      p.terekonsiliasi
        ? null
        : `Kolom ${kolom[i]}: saldo akhir belum sama dengan saldo kas dan bank aktual ${angkaJuklat(p.kasAkhirAktual)} (selisih ${angkaJuklat(Math.abs(p.selisihRekonsiliasi))}).`
    )
    .filter((x): x is string => x !== null);
  const keterangan: TampilanJuklat['keterangan'] = [];
  if (rekon.length) keterangan.push({ judul: 'Perhatian', baris: rekon });
  if (catatanPenyajian.length) {
    keterangan.push({ judul: 'Catatan penyajian', baris: catatanPenyajian.map((c, i) => `${i + 1}. ${c}`) });
  }

  return {
    judul: 'Laporan Arus Kas',
    periode: periodeJuklat(periode.map((p) => ({ mulai: p.tanggalMulai, selesai: p.tanggalSelesai }))),
    kolom,
    baris,
    keterangan: keterangan.length ? keterangan : undefined,
  };
}

// ------------------------------------------------------------------
// 4. LAPORAN PERUBAHAN EKUITAS (tidak ada contoh di Lampiran — format tabel sama)
// ------------------------------------------------------------------

export function tampilanEkuitasJuklat(periode: PerubahanEkuitasResult[]): TampilanJuklat {
  const p = periode[periode.length - 1];
  if (periode.length === 1) {
    const baris: BarisJuklat[] = [{ label: 'EKUITAS', nilai: kosong(3), tingkat: 'JUDUL' }];
    p.rows.forEach((r) => baris.push({ label: r.nama, nilai: [r.saldoAwal, r.mutasi, r.saldoAkhir], tingkat: 'RINCIAN' }));
    // RC-S133.6 (AUDIT F-4) — saldo awal baris SHU = sisa hasil usaha belum dibagikan per H-1.
    const awalShu = p.saldoAwalHasilUsaha ?? 0;
    baris.push({ label: p.hasilUsahaPeriodeLabel, nilai: [awalShu, p.hasilUsahaPeriode - awalShu, p.hasilUsahaPeriode], tingkat: 'RINCIAN' });
    baris.push({
      label: 'Total ekuitas',
      nilai: [p.totalSaldoAwal, p.totalSaldoAkhir - p.totalSaldoAwal, p.totalSaldoAkhir],
      tingkat: 'SUBTOTAL',
    });
    const adaRincianShu = p.hasilUsahaPeriodeBerjalan !== undefined && (awalShu !== 0 || (p.shuDibagikanPeriode ?? 0) !== 0);
    return {
      judul: 'Laporan Perubahan Ekuitas',
      periode: periodeJuklat([{ mulai: p.tanggalMulai, selesai: p.tanggalSelesai }]),
      kolom: ['Saldo awal', 'Penambahan (pengurangan)', 'Saldo akhir'],
      baris,
      keterangan: adaRincianShu
        ? [
            {
              judul: 'Rincian mutasi SHU/hasil usaha',
              baris: [
                `Hasil usaha periode ini: Rp ${angkaJuklat(p.hasilUsahaPeriodeBerjalan ?? 0)}`,
                `SHU dibagikan dalam periode: Rp ${angkaJuklat(-(p.shuDibagikanPeriode ?? 0))}`,
                // RC-S133.6.1 — rincian baris SHU/hasil usaha (jumlahnya = baris di atas).
                ...(p.rincianHasilUsaha ?? []).map(
                  (r) => `${r.nama}: saldo awal Rp ${angkaJuklat(r.saldoAwal)}, mutasi Rp ${angkaJuklat(r.mutasi)}, saldo akhir Rp ${angkaJuklat(r.saldoAkhir)}`
                ),
                ...((p.shuDibagikanPeriode ?? 0) !== 0 && p.distribusiShuKeEkuitas !== undefined
                  ? [
                      `Distribusi SHU ke Cadangan/akun ekuitas: Rp ${angkaJuklat(p.distribusiShuKeEkuitas)}; ke dana-dana & simpanan anggota (keluar dari ekuitas): Rp ${angkaJuklat(p.distribusiShuKeLuarEkuitas ?? 0)}`,
                    ]
                  : []),
              ],
            },
          ]
        : undefined,
    };
  }
  const n = periode.length;
  const baris: BarisJuklat[] = [{ label: 'EKUITAS', nilai: kosong(n), tingkat: 'JUDUL' }];
  gabungPerKode(periode.map((q) => q.rows), (r) => r.saldoAkhir).forEach((r) =>
    baris.push({ label: r.nama, nilai: r.nilai, tingkat: 'RINCIAN' })
  );
  baris.push({ label: p.hasilUsahaPeriodeLabel, nilai: periode.map((q) => q.hasilUsahaPeriode), tingkat: 'RINCIAN' });
  baris.push({ label: 'Total ekuitas', nilai: periode.map((q) => q.totalSaldoAkhir), tingkat: 'SUBTOTAL' });
  return {
    judul: 'Laporan Perubahan Ekuitas',
    periode: periodeJuklat(periode.map((q) => ({ mulai: q.tanggalMulai, selesai: q.tanggalSelesai }))),
    kolom: kolomJuklat(periode.map((q) => q.tanggalSelesai)),
    baris,
  };
}

// ------------------------------------------------------------------
// 5. CATATAN ATAS LAPORAN KEUANGAN (naratif, format tabel sama)
// ------------------------------------------------------------------

export function tampilanCalkJuklat(data: CalkResult): TampilanJuklat {
  const baris: BarisJuklat[] = [];
  data.sections.forEach((s, i) => {
    baris.push({ label: `${i + 1}. ${s.judul}`, nilai: [], tingkat: 'JUDUL' });
    baris.push({ label: '', nilai: [], tingkat: 'PARAGRAF', teks: s.konten });
  });
  return {
    judul: 'Catatan Atas Laporan Keuangan',
    periode: periodeJuklat([{ mulai: data.tanggalMulai, selesai: data.tanggalSelesai }]),
    kolom: [],
    baris,
  };
}

// ------------------------------------------------------------------
// 6. LAPORAN PROMOSI EKONOMI ANGGOTA (Lampiran 7/8) & penyusun umum
// ------------------------------------------------------------------

/**
 * Ubah baris builder (label, nilai…) + tingkat menjadi tampilan Juklat.
 * Dipakai LPEA, yang barisnya sudah disusun mengikuti naskah oleh
 * `buildLpeaExport`; di sini hanya bentuk cetaknya yang diseragamkan.
 */
export function tampilanDariBaris(
  judul: string,
  periode: string,
  kolom: string[],
  baris: (string | number)[][],
  tingkat: (string | undefined)[],
  keterangan?: TampilanJuklat['keterangan']
): TampilanJuklat {
  return {
    judul,
    periode,
    kolom,
    keterangan,
    baris: baris.map((r, i) => {
      const t = (tingkat[i] ?? 'RINCIAN') as TingkatJuklat;
      const sel = r.slice(1);
      const adaTeks = sel.some((v) => typeof v === 'string' && v !== '');
      return {
        label: String(r[0] ?? ''),
        tingkat: t,
        nilai: sel.map((v) => (typeof v === 'number' ? v : null)),
        nilaiTeks: adaTeks ? sel.map((v) => (typeof v === 'string' && v !== '' ? v : null)) : undefined,
      };
    }),
  };
}
