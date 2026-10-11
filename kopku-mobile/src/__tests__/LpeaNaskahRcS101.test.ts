import {
  ARAH_SELISIH,
  BarisPea,
  HURUF_BUKU_PEMBANTU,
  KETERBATASAN_STRUKTURAL,
  LABEL_KOMPONEN_PEA,
  ParameterLpea,
  URUTAN_KOMPONEN_PEA,
  hitungPeaBaris,
  hitungPeaKomponen,
  parameterKurang,
  parameterLpeaKosong,
  rakitLaporanLpea,
  susunHasilKomponen,
  tarifPinjamanKePerBulan,
  tarifTahunanKePerBulan,
} from '@/reports/LpeaPlan';

/**
 * RC-S101 — LPEA DIUJI TERHADAP ANGKA CONTOH NASKAH.
 *
 * Seluruh angka pada §A–§C di bawah dikutip dari Petunjuk Pelaksanaan SOM
 * Nomor 3 Tahun 2025, Lampiran butir 9 ("Contoh Buku Pembantu Promosi
 * Ekonomi Anggota huruf A–D") dan butir 7 ("Contoh Laporan Promosi
 * Ekonomi Anggota untuk KSP"). Yang diuji BUKAN kesesuaian dengan
 * tafsiran sendiri, melainkan kemampuan mesin ini mereproduksi angka
 * naskah persis — termasuk pembalikan tanda antara komponen pinjaman dan
 * komponen simpanan, yang paling mudah keliru.
 */

// ===========================================================================
// A. BUKU PEMBANTU HURUF A — PARTISIPASI JASA PINJAMAN, (c − b) × a
// ===========================================================================

/** Kelima baris tabel huruf A, apa adanya dari naskah. */
const BARIS_HURUF_A: BarisPea[] = [
  // Des 1 — saldo Rp 20.000.000, koperasi 2,5%/bulan, luar 20%/12 per bulan
  { basis: 20_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 20 / 12 },
  // Des 2 — Rp 55.000.000, 2,5% vs 20%/12
  { basis: 55_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 20 / 12 },
  // Des 7 — Rp 8.000.000, 2,5% vs 2%
  { basis: 8_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 2 },
  // Des 13 — Rp 22.000.000, 2,5% vs 2%
  { basis: 22_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 2 },
  // Des 30 — Rp 38.000.000, 2,5% vs 1,5%
  { basis: 38_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 1.5 },
];

describe('RC-S101 §A — buku pembantu A: partisipasi jasa pinjaman', () => {
  test('setiap baris sama dengan kolom PEA pada naskah', () => {
    const hasil = BARIS_HURUF_A.map((b) => hitungPeaBaris('JASA_PINJAMAN', b).toNumber());
    // (166.666,67) (458.333,33) (40.000) (110.000) (380.000) — negatif,
    // karena tarif koperasi LEBIH TINGGI daripada tarif luar.
    expect(hasil[0]).toBeCloseTo(-166_666.67, 2);
    expect(hasil[1]).toBeCloseTo(-458_333.33, 2);
    expect(hasil[2]).toBe(-40_000);
    expect(hasil[3]).toBe(-110_000);
    expect(hasil[4]).toBe(-380_000);
  });

  test('Jumlah PEA huruf A = (1.155.000,00) persis seperti naskah', () => {
    // Pecahan 166.666,67 + 458.333,33 hanya berjumlah bulat kalau
    // pembulatan ditahan sampai akhir — inilah yang dijaga di sini.
    expect(hitungPeaKomponen('JASA_PINJAMAN', BARIS_HURUF_A)).toBe(-1_155_000);
  });

  test('pembulatan ditahan sampai akhir, bukan per baris', () => {
    // Kasus yang BENAR-BENAR membedakan kedua cara. Tiap baris bernilai
    // tepat 0,5 rupiah: dibulatkan per baris (HALF_UP) masing-masing
    // menjadi 1 sehingga jumlahnya 3; ditahan sampai akhir, jumlah
    // sesungguhnya 1,5 dan dibulatkan sekali menjadi 2.
    //
    // Contoh naskah huruf A sendiri TIDAK dapat membuktikan ini —
    // pecahan ,67 dan ,33 di sana kebetulan saling melengkapi menjadi
    // 1 rupiah, jadi kedua cara menghasilkan 1.155.000 yang sama.
    const tiga: BarisPea[] = Array.from({ length: 3 }, () => ({
      basis: 50,
      tarifKoperasiPersenPerBulan: 0,
      tarifLuarPersenPerBulan: 1,
    }));
    expect(hitungPeaBaris('JASA_PINJAMAN', tiga[0]).toNumber()).toBe(0.5);
    expect(hitungPeaKomponen('JASA_PINJAMAN', tiga)).toBe(2);
  });

  test('arah selisih pinjaman adalah (c − b), bukan sebaliknya', () => {
    expect(ARAH_SELISIH.JASA_PINJAMAN).toBe('LUAR_MINUS_KOPERASI');
    // Bila arahnya dibalik, tandanya akan terbalik total.
    const satu = hitungPeaBaris('JASA_PINJAMAN', {
      basis: 10_000_000,
      tarifKoperasiPersenPerBulan: 1,
      tarifLuarPersenPerBulan: 2,
    });
    // Tarif luar lebih tinggi -> anggota UNTUNG -> positif.
    expect(satu.toNumber()).toBe(100_000);
  });
});

// ===========================================================================
// B. HURUF B — PARTISIPASI JASA PROVISI, (c − b) × a
// ===========================================================================

describe('RC-S101 §B — buku pembantu B: partisipasi jasa provisi', () => {
  const BARIS_HURUF_B: BarisPea[] = [
    // Des 8 — Rp 20.000.000, provisi koperasi 1%, luar 2%
    { basis: 20_000_000, tarifKoperasiPersenPerBulan: 1, tarifLuarPersenPerBulan: 2 },
    // Des 14 — Rp 38.000.000, 1% vs 2%
    { basis: 38_000_000, tarifKoperasiPersenPerBulan: 1, tarifLuarPersenPerBulan: 2 },
  ];

  test('kedua baris & jumlahnya sama dengan naskah (200.000 + 380.000 = 580.000)', () => {
    const hasil = BARIS_HURUF_B.map((b) => hitungPeaBaris('JASA_PROVISI', b).toNumber());
    expect(hasil).toEqual([200_000, 380_000]);
    expect(hitungPeaKomponen('JASA_PROVISI', BARIS_HURUF_B)).toBe(580_000);
  });
});

// ===========================================================================
// C. HURUF C & D — SIMPANAN, (b − c) × a  [ARAH TERBALIK]
// ===========================================================================

describe('RC-S101 §C — buku pembantu C & D: simpanan', () => {
  test('huruf C: saldo terendah 5.000.000, koperasi 2% vs luar 1% -> 50.000', () => {
    const baris: BarisPea[] = [
      { basis: 5_000_000, tarifKoperasiPersenPerBulan: 2, tarifLuarPersenPerBulan: 1 },
    ];
    expect(hitungPeaKomponen('TABUNGAN', baris)).toBe(50_000);
    expect(ARAH_SELISIH.TABUNGAN).toBe('KOPERASI_MINUS_LUAR');
  });

  test('huruf D: 1.500.000 (genap sebulan) + 225.000 (prorata 9/30) = 1.725.000', () => {
    const baris: BarisPea[] = [
      // *) (2,5% − 1%) × 100.000.000 = 1.500.000
      { basis: 100_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 1 },
      // **) (2,5% − 1%) × 50.000.000 × 9/30 = 225.000
      {
        basis: 50_000_000,
        tarifKoperasiPersenPerBulan: 2.5,
        tarifLuarPersenPerBulan: 1,
        hariProrata: 9,
      },
    ];
    const nilai = baris.map((b) => hitungPeaBaris('SIMPANAN_BERJANGKA', b).toNumber());
    expect(nilai).toEqual([1_500_000, 225_000]);
    expect(hitungPeaKomponen('SIMPANAN_BERJANGKA', baris)).toBe(1_725_000);
  });

  test('prorata hari memakai pembagi 30, sesuai catatan kaki naskah', () => {
    const penuh = hitungPeaBaris('SIMPANAN_BERJANGKA', {
      basis: 30_000_000,
      tarifKoperasiPersenPerBulan: 2,
      tarifLuarPersenPerBulan: 1,
    }).toNumber();
    const separuh = hitungPeaBaris('SIMPANAN_BERJANGKA', {
      basis: 30_000_000,
      tarifKoperasiPersenPerBulan: 2,
      tarifLuarPersenPerBulan: 1,
      hariProrata: 15,
    }).toNumber();
    expect(separuh).toBeCloseTo(penuh / 2, 6);
  });
});

// ===========================================================================
// D. LAPORAN UTUH — CONTOH KSP NASKAH (Lampiran butir 7)
// ===========================================================================

describe('RC-S101 §D — laporan utuh mereproduksi contoh KSP naskah', () => {
  const parameterLengkap: ParameterLpea = {
    tahunBuku: 2022,
    // Tarif luar di contoh naskah berbeda per baris; untuk uji laporan
    // utuh dipakai tarif seragam per komponen supaya `susunHasilKomponen`
    // yang diuji, sedangkan kesesuaian per baris sudah diuji di §A–§C.
    tarifLuarJasaPinjaman: 2,
    tarifLuarJasaProvisi: 2,
    tarifLuarTabungan: 1,
    tarifLuarSimpananBerjangka: 1,
    tarifKoperasiJasaProvisi: 1,
    tarifKoperasiTabungan: 2,
    sumberAcuan: 'Contoh naskah',
  };

  test('susunan subtotal & total mengikuti naskah: (575.000) + 1.725.000 = 1.150.000; + SHU 36.560.000 = 37.710.000', () => {
    // Nilai komponen diambil dari hasil §A–§C yang sudah terbukti sama
    // dengan naskah, lalu dirakit lewat jalur produksi yang sama.
    const komponen = [
      susunHasilKomponen('JASA_PINJAMAN', BARIS_HURUF_A, parameterLengkap, null),
      susunHasilKomponen(
        'JASA_PROVISI',
        [
          { basis: 20_000_000, tarifKoperasiPersenPerBulan: 1, tarifLuarPersenPerBulan: 2 },
          { basis: 38_000_000, tarifKoperasiPersenPerBulan: 1, tarifLuarPersenPerBulan: 2 },
        ],
        parameterLengkap,
        1
      ),
      susunHasilKomponen(
        'TABUNGAN',
        [{ basis: 5_000_000, tarifKoperasiPersenPerBulan: 2, tarifLuarPersenPerBulan: 1 }],
        parameterLengkap,
        2
      ),
      susunHasilKomponen(
        'SIMPANAN_BERJANGKA',
        [
          { basis: 100_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 1 },
          { basis: 50_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 1, hariProrata: 9 },
        ],
        parameterLengkap,
        null
      ),
    ];

    const laporan = rakitLaporanLpea({
      tahunBuku: 2022,
      tanggalMulai: '2022-01-01',
      tanggalSelesai: '2022-12-31',
      parameter: parameterLengkap,
      komponen,
      bagianShu: {
        tahunBuku: 2022,
        sudahDibagikan: true,
        totalBagianAnggota: 36_560_000,
        jumlahAnggotaPenerima: 21,
        shuDisahkanRat: 91_400_000,
      },
    });

    // "Penghematan Beban Pinjaman Anggota" = (1.155.000) + 580.000 = (575.000)
    expect(laporan.subtotalPenghematanBebanPinjaman).toBe(-575_000);
    // "Kelebihan Balas Jasa Simpanan Anggota" = 50.000 + 1.725.000 = 1.775.000
    //
    // KETIDAKSESUAIAN DI DALAM NASKAH ITU SENDIRI — didokumentasikan di
    // sini supaya tidak terulang sebagai "bug" di kemudian hari.
    //
    // Pada blok pinjaman, contoh LPEA naskah memang memuat TOTAL tiap buku
    // pembantu: (1.155.000) dari huruf A dan 580.000 dari huruf B,
    // bersubtotal (575.000). Konsisten.
    //
    // Pada blok simpanan, dua angka yang tercetak adalah 1.500.000 dan
    // 225.000 — dan keduanya adalah DUA BARIS buku pembantu huruf D
    // (lihat catatan kaki *) dan **) di huruf D), bukan total huruf C dan
    // total huruf D. Akibatnya total huruf C (50.000) TIDAK PERNAH muncul
    // di contoh LPEA naskah, dan subtotalnya tertulis 1.725.000 — yang
    // justru sama dengan "Jumlah PEA" huruf D.
    //
    // Mesin ini menjumlahkan KEDUA komponen sebagaimana mestinya menurut
    // struktur laporan (tabungan + simpanan berjangka), sehingga
    // subtotalnya 1.775.000 dan jumlah pelayanannya 1.200.000. Selisih
    // 50.000 berasal dari naskahnya, BUKAN dari rumus di sini — test
    // berikutnya membuktikan angka penutup naskah tereproduksi persis
    // begitu huruf C dikosongkan seperti pada contohnya.
    expect(laporan.subtotalKelebihanBalasJasaSimpanan).toBe(1_775_000);
    expect(laporan.jumlahPeaPelayanan).toBe(1_200_000);
    expect(laporan.jumlahPeaAnggota).toBe(1_200_000 + 36_560_000);
    expect(laporan.totalBelumLengkap).toBe(false);
  });

  test('angka penutup naskah (1.150.000 & 37.710.000) tereproduksi persis pada susunan naskah', () => {
    // Susunan naskah: subtotal simpanan = huruf D saja.
    const komponen = [
      susunHasilKomponen('JASA_PINJAMAN', BARIS_HURUF_A, parameterLengkap, null),
      susunHasilKomponen(
        'JASA_PROVISI',
        [
          { basis: 20_000_000, tarifKoperasiPersenPerBulan: 1, tarifLuarPersenPerBulan: 2 },
          { basis: 38_000_000, tarifKoperasiPersenPerBulan: 1, tarifLuarPersenPerBulan: 2 },
        ],
        parameterLengkap,
        1
      ),
      susunHasilKomponen('TABUNGAN', [], parameterLengkap, 2),
      susunHasilKomponen(
        'SIMPANAN_BERJANGKA',
        [
          { basis: 100_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 1 },
          { basis: 50_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 1, hariProrata: 9 },
        ],
        parameterLengkap,
        null
      ),
    ];
    const laporan = rakitLaporanLpea({
      tahunBuku: 2022,
      tanggalMulai: '2022-01-01',
      tanggalSelesai: '2022-12-31',
      parameter: parameterLengkap,
      komponen,
      bagianShu: {
        tahunBuku: 2022,
        sudahDibagikan: true,
        totalBagianAnggota: 36_560_000,
        jumlahAnggotaPenerima: 21,
        shuDisahkanRat: 91_400_000,
      },
    });
    expect(laporan.jumlahPeaPelayanan).toBe(1_150_000);
    expect(laporan.jumlahPeaAnggota).toBe(37_710_000);
  });
});

// ===========================================================================
// E. KETERBATASAN: TIDAK ADA ANGKA ASUMSI
// ===========================================================================

describe('RC-S101 §E — parameter belum diisi TIDAK menghasilkan angka', () => {
  const baris: BarisPea[] = [
    { basis: 10_000_000, tarifKoperasiPersenPerBulan: 2, tarifLuarPersenPerBulan: 0 },
  ];

  test('tarif luar kosong -> BELUM_DAPAT_DIHITUNG, bukan nol yang tampak sah', () => {
    const kosong = parameterLpeaKosong(2026);
    const hasil = susunHasilKomponen('JASA_PINJAMAN', baris, kosong, null);
    expect(hasil.status).toBe('BELUM_DAPAT_DIHITUNG');
    expect(hasil.nilai).toBe(0);
    expect(hasil.parameterKurang).toEqual(['tarifLuarJasaPinjaman']);
    // Basisnya tetap dilaporkan supaya pengguna tahu datanya ADA, hanya
    // tarif pembandingnya yang belum diisi.
    expect(hasil.totalBasis).toBe(10_000_000);
  });

  test('komponen BELUM_DAPAT_DIHITUNG tidak ikut total dan menandai total belum lengkap', () => {
    const kosong = parameterLpeaKosong(2026);
    const laporan = rakitLaporanLpea({
      tahunBuku: 2026,
      tanggalMulai: '2026-01-01',
      tanggalSelesai: '2026-12-31',
      parameter: kosong,
      komponen: URUTAN_KOMPONEN_PEA.map((k) => susunHasilKomponen(k, baris, kosong, null)),
      bagianShu: {
        tahunBuku: 2026,
        sudahDibagikan: false,
        totalBagianAnggota: 0,
        jumlahAnggotaPenerima: 0,
        shuDisahkanRat: null,
      },
    });
    expect(laporan.jumlahPeaPelayanan).toBe(0);
    expect(laporan.jumlahPeaAnggota).toBe(0);
    expect(laporan.totalBelumLengkap).toBe(true);
    // Setiap komponen yang terkunci dijelaskan, tidak dibiarkan senyap.
    expect(laporan.keterbatasan.length).toBeGreaterThanOrEqual(4);
    for (const k of URUTAN_KOMPONEN_PEA) {
      expect(laporan.keterbatasan.join(' ')).toContain(LABEL_KOMPONEN_PEA[k]);
    }
  });

  test('parameter lengkap tapi tanpa transaksi -> TIDAK_ADA_TRANSAKSI (nol yang memang benar)', () => {
    const p: ParameterLpea = { ...parameterLpeaKosong(2026), tarifLuarJasaPinjaman: 2 };
    const hasil = susunHasilKomponen('JASA_PINJAMAN', [], p, null);
    expect(hasil.status).toBe('TIDAK_ADA_TRANSAKSI');
    expect(hasil.nilai).toBe(0);
  });

  test('parameter kurang diperiksa SEBELUM ada/tidaknya transaksi', () => {
    // Tanpa transaksi DAN tanpa parameter: statusnya harus
    // BELUM_DAPAT_DIHITUNG, bukan TIDAK_ADA_TRANSAKSI — yang terakhir
    // menyiratkan angkanya benar nol.
    const hasil = susunHasilKomponen('JASA_PINJAMAN', [], parameterLpeaKosong(2026), null);
    expect(hasil.status).toBe('BELUM_DAPAT_DIHITUNG');
  });

  test('provisi & tabungan butuh DUA parameter karena aplikasi tidak mencatat tarif koperasinya', () => {
    expect(parameterKurang('JASA_PROVISI', parameterLpeaKosong(2026))).toEqual([
      'tarifLuarJasaProvisi',
      'tarifKoperasiJasaProvisi',
    ]);
    expect(parameterKurang('TABUNGAN', parameterLpeaKosong(2026))).toEqual([
      'tarifLuarTabungan',
      'tarifKoperasiTabungan',
    ]);
    // Jasa pinjaman & berjangka hanya butuh tarif luar: tarif koperasinya
    // dibaca dari data transaksi.
    expect(parameterKurang('JASA_PINJAMAN', { ...parameterLpeaKosong(2026), tarifLuarJasaPinjaman: 1 })).toEqual([]);
  });

  test('nol dan NaN dibedakan: 0% adalah tarif yang SAH, NaN bukan', () => {
    const nol: ParameterLpea = { ...parameterLpeaKosong(2026), tarifLuarJasaPinjaman: 0 };
    expect(parameterKurang('JASA_PINJAMAN', nol)).toEqual([]);
    const rusak: ParameterLpea = { ...parameterLpeaKosong(2026), tarifLuarJasaPinjaman: Number.NaN };
    expect(parameterKurang('JASA_PINJAMAN', rusak)).toEqual(['tarifLuarJasaPinjaman']);
  });
});

// ===========================================================================
// F. SHU: HANYA YANG SUDAH DIBAGIKAN
// ===========================================================================

describe('RC-S101 §F — bagian SHU hanya dari pembagian yang sudah diproses', () => {
  const p: ParameterLpea = { ...parameterLpeaKosong(2026), tarifLuarJasaPinjaman: 2 };
  const laporanDengan = (sudahDibagikan: boolean, total: number) =>
    rakitLaporanLpea({
      tahunBuku: 2026,
      tanggalMulai: '2026-01-01',
      tanggalSelesai: '2026-12-31',
      parameter: p,
      komponen: [
        susunHasilKomponen(
          'JASA_PINJAMAN',
          [{ basis: 10_000_000, tarifKoperasiPersenPerBulan: 1, tarifLuarPersenPerBulan: 2 }],
          p,
          null
        ),
      ],
      bagianShu: {
        tahunBuku: 2026,
        sudahDibagikan,
        totalBagianAnggota: total,
        jumlahAnggotaPenerima: sudahDibagikan ? 10 : 0,
        shuDisahkanRat: 50_000_000,
      },
    });

  test('sudah dibagikan -> masuk total', () => {
    const l = laporanDengan(true, 20_000_000);
    expect(l.jumlahPeaAnggota).toBe(100_000 + 20_000_000);
  });

  test('belum dibagikan -> TIDAK masuk total walau nominalnya terisi, dan dinyatakan', () => {
    // Menjaga terhadap kesalahan yang paling mudah terjadi: membaca
    // `shu_disahkan_rat` atau SHU yang baru dihitung lalu menyebutnya
    // manfaat ekonomi anggota.
    const l = laporanDengan(false, 20_000_000);
    expect(l.jumlahPeaAnggota).toBe(100_000);
    expect(l.keterbatasan.join(' ')).toMatch(/belum diproses/);
    expect(l.keterbatasan.join(' ')).toMatch(/TIDAK dihitung sebagai manfaat/);
  });
});

// ===========================================================================
// G. KONVERSI TARIF
// ===========================================================================

describe('RC-S101 §G — konversi tarif ke per bulan (naskah memakai per bulan)', () => {
  test('tenor bulanan dipakai apa adanya', () => {
    expect(tarifPinjamanKePerBulan(2.5, 'BULAN')).toBe(2.5);
  });

  test('tenor mingguan & harian dikonversi dengan pembagi yang sama dengan prorata', () => {
    expect(tarifPinjamanKePerBulan(0.5, 'MINGGU')).toBe(2);
    expect(tarifPinjamanKePerBulan(0.1, 'HARI')).toBeCloseTo(3, 10);
  });

  test('suku bunga tahunan simpanan berjangka menjadi per bulan', () => {
    // 20%/tahun -> 20/12 per bulan, tarif yang dipakai naskah di huruf A.
    expect(tarifTahunanKePerBulan(20)).toBeCloseTo(20 / 12, 10);
    expect(tarifTahunanKePerBulan(12)).toBe(1);
  });
});

// ===========================================================================
// H. METADATA
// ===========================================================================

describe('RC-S101 §H — metadata penyajian sesuai naskah', () => {
  test('empat komponen dengan huruf buku pembantu A–D', () => {
    expect(URUTAN_KOMPONEN_PEA).toHaveLength(4);
    expect(URUTAN_KOMPONEN_PEA.map((k) => HURUF_BUKU_PEMBANTU[k])).toEqual(['A', 'B', 'C', 'D']);
  });

  test('keterbatasan struktural aplikasi dinyatakan, bukan disembunyikan', () => {
    expect(KETERBATASAN_STRUKTURAL.length).toBeGreaterThanOrEqual(3);
    const gabung = KETERBATASAN_STRUKTURAL.join(' ');
    expect(gabung).toMatch(/provisi/i);
    expect(gabung).toMatch(/saldo terendah/i);
  });
});

// ===========================================================================
// I. EXPORT & NAVIGASI
// ===========================================================================

describe('RC-S101 §I — export LPEA rapi dan tidak mengarang angka', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const { buildLpeaExport } = require('@/export/ReportTableBuilders') as typeof import('@/export/ReportTableBuilders');
  const { buildReportHtml } = require('@/export/HtmlReportBuilder') as typeof import('@/export/HtmlReportBuilder');

  const parameterSebagian: ParameterLpea = {
    ...parameterLpeaKosong(2026),
    tarifLuarJasaPinjaman: 1.5,
    sumberAcuan: 'SBDK Bank X',
  };

  const laporanSebagian = () =>
    rakitLaporanLpea({
      tahunBuku: 2026,
      tanggalMulai: '2026-01-01',
      tanggalSelesai: '2026-12-31',
      parameter: parameterSebagian,
      komponen: URUTAN_KOMPONEN_PEA.map((k) =>
        susunHasilKomponen(
          k,
          [{ basis: 20_000_000, tarifKoperasiPersenPerBulan: 2.5, tarifLuarPersenPerBulan: 1.5 }],
          parameterSebagian,
          null
        )
      ),
      bagianShu: {
        tahunBuku: 2026,
        sudahDibagikan: true,
        totalBagianAnggota: 3_000_000,
        jumlahAnggotaPenerima: 2,
        shuDisahkanRat: 10_000_000,
      },
    });

  test('susunan baris export mengikuti naskah, dengan tingkat baris yang benar', () => {
    const e = buildLpeaExport({ namaKoperasi: 'KSP Kenanga' }, laporanSebagian(), [], 'Laporan Promosi Ekonomi Anggota');
    const label = e.baris.map((b) => String(b[0]));
    const urutan = [
      'MANFAAT EKONOMI DARI SIMPAN PINJAM LEWAT KOPERASI',
      'PENGHEMATAN BEBAN PINJAMAN ANGGOTA',
      'KELEBIHAN BALAS JASA SIMPANAN ANGGOTA',
      'JUMLAH PROMOSI EKONOMI DARI TRANSAKSI PENYEDIAAN JASA UNTUK ANGGOTA',
      'PROMOSI EKONOMI PADA AKHIR TAHUN',
      'JUMLAH PROMOSI EKONOMI ANGGOTA',
    ];
    const indeks = urutan.map((t) => label.indexOf(t));
    expect(indeks).not.toContain(-1);
    expect([...indeks].sort((a, b) => a - b)).toEqual(indeks);
    expect(e.tingkatBaris).toHaveLength(e.baris.length);
    expect(e.tingkatBaris?.[label.indexOf('JUMLAH PROMOSI EKONOMI ANGGOTA')]).toBe('TOTAL');
  });

  test('komponen yang belum dapat dihitung dicetak sebagai TEKS status, bukan angka nol', () => {
    const e = buildLpeaExport({ namaKoperasi: 'KSP Kenanga' }, laporanSebagian(), [], 'LPEA');
    const barisProvisi = e.baris.find((b) => String(b[0]).includes('Partisipasi jasa provisi'));
    expect(barisProvisi?.[1]).toBe('Belum dapat dihitung');
    expect(typeof barisProvisi?.[1]).toBe('string');
    // Sedangkan komponen yang lengkap tetap ANGKA, supaya bisa dijumlahkan.
    const barisPinjaman = e.baris.find((b) => String(b[0]).includes('Partisipasi jasa pinjaman'));
    expect(typeof barisPinjaman?.[1]).toBe('number');
  });

  test('keterbatasan & status kelengkapan IKUT tercetak di ringkasan', () => {
    const e = buildLpeaExport({ namaKoperasi: 'KSP Kenanga' }, laporanSebagian(), [], 'LPEA');
    const teks = (e.ringkasan ?? []).map((r) => `${r.label}: ${r.nilai}`).join(' | ');
    expect(teks).toContain('BELUM LENGKAP');
    expect(teks).toMatch(/Keterbatasan 1/);
    expect(teks).toContain('SBDK Bank X');
    // Catatan struktural aplikasi juga tercetak.
    expect(teks).toMatch(/Catatan 1/);
  });

  test('tarif yang dipakai dicetak supaya angkanya dapat ditelusuri', () => {
    const e = buildLpeaExport({ namaKoperasi: 'KSP Kenanga' }, laporanSebagian(), [], 'LPEA');
    const label = e.baris.map((b) => String(b[0]));
    expect(label).toContain('TARIF PEMBANDING YANG DIPAKAI (PERSEN PER BULAN)');
    const barisTarif = e.baris.find(
      (b) => String(b[0]).includes('Partisipasi jasa pinjaman') && String(b[1]).includes('luar')
    );
    expect(String(barisTarif?.[1])).toContain('1.5%');
  });

  test('rincian per anggota ikut bila pembagian SHU sudah diproses', () => {
    const e = buildLpeaExport(
      { namaKoperasi: 'KSP Kenanga' },
      laporanSebagian(),
      [
        { nomorAnggota: 'A-001', namaLengkap: 'Budi', jasaModal: 1_000_000, jasaUsaha: 500_000, totalShuAnggota: 1_500_000 },
        { nomorAnggota: 'A-002', namaLengkap: 'Sari', jasaModal: 1_000_000, jasaUsaha: 500_000, totalShuAnggota: 1_500_000 },
      ],
      'LPEA'
    );
    const label = e.baris.map((b) => String(b[0]));
    expect(label).toContain('RINCIAN PEMBAGIAN SHU PER ANGGOTA');
    expect(label.some((l) => l.includes('A-001 — Budi'))).toBe(true);
    // Jumlah rincian direkonsiliasi ke total bagian anggota.
    const subtotal = e.baris.find((b) => String(b[0]) === 'Jumlah pembagian SHU untuk anggota');
    expect(subtotal?.[1]).toBe(3_000_000);
  });

  test('label periode memakai format naskah "Untuk periode yang berakhir tanggal ..."', () => {
    const e = buildLpeaExport({ namaKoperasi: 'KSP Kenanga' }, laporanSebagian(), [], 'LPEA');
    expect(e.periodeLabel).toBe('Untuk periode yang berakhir tanggal 31 Desember 2026');
  });

  test('PDF merender hierarki barisnya', () => {
    const html = buildReportHtml(
      buildLpeaExport({ namaKoperasi: 'KSP Kenanga' }, laporanSebagian(), [], 'LPEA')
    );
    expect(html).toContain('<tr class="sub-header">');
    expect(html).toContain('<tr class="rincian">');
    expect(html).toContain('<tr class="total">');
    expect(html).toContain('KSP Kenanga');
  });

  test('LPEA ada di hub Rincian Laporan Lainnya, dan urutan lima laporan utama TIDAK berubah', () => {
    const hub = fs.readFileSync(
      path.join(process.cwd(), 'src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx'),
      'utf8'
    );
    expect(hub).toMatch(/route: 'Lpea'/);
    expect(hub).toContain('Laporan Promosi Ekonomi Anggota');

    // LaporanScreen (lima laporan keuangan utama) TIDAK boleh menyebut LPEA.
    const laporanScreen = fs.readFileSync(
      path.join(process.cwd(), 'src/screens/Laporan/LaporanScreen.tsx'),
      'utf8'
    );
    expect(laporanScreen).not.toContain('Lpea');
    expect(laporanScreen).not.toContain('Promosi Ekonomi');

    // Rutenya terdaftar di LaporanStack.
    const nav = fs.readFileSync(path.join(process.cwd(), 'src/navigation/RootNavigator.tsx'), 'utf8');
    expect(nav).toMatch(/name="Lpea"\s+component=\{LpeaScreen\}/);
  });

  test('tidak ada tabel baru untuk LPEA — parameter memakai app_config', () => {
    const repo = fs.readFileSync(path.join(process.cwd(), 'src/reports/LpeaRepository.ts'), 'utf8');
    expect(repo).not.toMatch(/CREATE TABLE/i);
    expect(repo).toContain('app_config');
    const schema = fs.readFileSync(path.join(process.cwd(), 'src/database/schema.ts'), 'utf8');
    expect(schema).not.toMatch(/CREATE TABLE IF NOT EXISTS lpea/i);
  });

  test('rumus PEA hanya hidup di SATU tempat', () => {
    // Repository menyiapkan basis & tarif, TIDAK menghitung selisihnya.
    const repo = fs.readFileSync(path.join(process.cwd(), 'src/reports/LpeaRepository.ts'), 'utf8');
    expect(repo).not.toMatch(/hitungPeaBaris|hitungPeaKomponen/);
    const layar = fs.readFileSync(path.join(process.cwd(), 'src/screens/Laporan/LpeaScreen.tsx'), 'utf8');
    expect(layar).not.toMatch(/hitungPeaBaris|hitungPeaKomponen/);
  });
});
