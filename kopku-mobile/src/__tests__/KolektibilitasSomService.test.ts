import {
  AMBANG_SOM,
  AMBANG_SOM_TANPA_ANGSURAN,
  BULAN_DIRAGUKAN_MENJADI_MACET,
  InputKlasifikasiSom,
  KATEGORI_BERMASALAH_SOM,
  PERSENTASE_PENYISIHAN_SOM,
  RASIO_AGUNAN_MINIMUM_DIRAGUKAN,
  RASIO_ANGSURAN_MINIMUM_DIRAGUKAN,
  bulanPenuhAntara,
  hitungPenyisihanSom,
  isPinjamanBermasalah,
  kelompokMasaAngsuran,
  klasifikasikanSom,
  masaAngsuranBulanDariSatuanTenor,
} from '@/services/KolektibilitasSomService';

/**
 * Seluruh angka yang diuji di berkas ini berasal dari naskah Juklat SOM
 * 2025: kriteria dari angka 12.1 (hal. 42-43), persentase pencadangan
 * dari angka 15 (hal. 86).
 *
 * Dasar semua kasus: pinjaman DENGAN ANGSURAN bulanan, tanpa tunggakan,
 * belum ada angsuran terbayar, tanpa agunan. Tiap test mengubah HANYA
 * field yang sedang diuji supaya jelas variabel mana yang menyebabkan
 * perubahan kategori.
 */
function dasar(ubah: Partial<InputKlasifikasiSom> = {}): InputKlasifikasiSom {
  return {
    polaPengembalian: 'ANGSURAN',
    masaAngsuranBulan: 1,
    bulanTunggakanPokok: 0,
    bulanTunggakanJasa: 0,
    sudahJatuhTempo: false,
    bulanSejakJatuhTempo: 0,
    angsuranTerbayar: 0,
    totalKewajibanKontraktual: 12_000_000,
    nilaiAgunan: 0,
    sisaUtang: 12_000_000,
    ...ubah,
  };
}

describe('KolektibilitasSomService — konstanta dari naskah Juklat SOM 3/2025', () => {
  test('hanya 4 kategori; bermasalah = Kurang Lancar/Diragukan/Macet (angka 12.2 A.1.a)', () => {
    expect(Object.keys(PERSENTASE_PENYISIHAN_SOM).sort()).toEqual(
      ['DIRAGUKAN', 'KURANG_LANCAR', 'LANCAR', 'MACET'].sort()
    );
    // "Dalam Perhatian (Khusus)" adalah istilah PERBANKAN, bukan kategori
    // SOM untuk KSP — ia TIDAK BOLEH muncul kembali.
    expect(Object.keys(PERSENTASE_PENYISIHAN_SOM)).not.toContain('DALAM_PERHATIAN');
    expect(KATEGORI_BERMASALAH_SOM).toEqual(['KURANG_LANCAR', 'DIRAGUKAN', 'MACET']);
    expect(isPinjamanBermasalah('LANCAR')).toBe(false);
    expect(isPinjamanBermasalah('KURANG_LANCAR')).toBe(true);
  });

  test('persentase taksiran piutang tak tertagih 0 / 50 / 75 / 100 (angka 15)', () => {
    // Naskah angka 15: lancar 0%, kurang lancar 50%, diragukan 75%,
    // macet 100%. BUKAN 0,5/10/50/100 — itu batasan FISKAL PMK 74.
    expect(PERSENTASE_PENYISIHAN_SOM.LANCAR).toBe(0);
    expect(PERSENTASE_PENYISIHAN_SOM.KURANG_LANCAR).toBe(50);
    expect(PERSENTASE_PENYISIHAN_SOM.DIRAGUKAN).toBe(75);
    expect(PERSENTASE_PENYISIHAN_SOM.MACET).toBe(100);
  });

  test('contoh perhitungan naskah angka 15 direproduksi persis', () => {
    // Naskah: lancar 300jt, kurang lancar 100jt, diragukan 75jt, macet
    // 25jt -> taksiran piutang tak tertagih Rp131.250.000.
    const lancar = hitungPenyisihanSom(300_000_000, 'LANCAR');
    const kurangLancar = hitungPenyisihanSom(100_000_000, 'KURANG_LANCAR');
    const diragukan = hitungPenyisihanSom(75_000_000, 'DIRAGUKAN');
    const macet = hitungPenyisihanSom(25_000_000, 'MACET');

    expect(lancar).toBe(0);
    expect(kurangLancar).toBe(50_000_000);
    expect(diragukan).toBe(56_250_000);
    expect(macet).toBe(25_000_000);
    expect(lancar + kurangLancar + diragukan + macet).toBe(131_250_000);
  });

  test('ambang Kurang Lancar per kelompok masa angsuran (angka 12.1 butir 1)', () => {
    // Pokok: melampaui 1 belum melampaui 2 bulan (masa angsuran < 1 bulan).
    expect(AMBANG_SOM.KURANG_DARI_1_BULAN.pokokLewatBulan).toBe(1);
    expect(AMBANG_SOM.KURANG_DARI_1_BULAN.pokokBatasAtasBulan).toBe(2);
    // Bunga: melampaui 1 belum melampaui 3 bulan (masa angsuran < 1 bulan).
    expect(AMBANG_SOM.KURANG_DARI_1_BULAN.jasaLewatBulan).toBe(1);
    expect(AMBANG_SOM.KURANG_DARI_1_BULAN.jasaBatasAtasBulan).toBe(3);
    // Pokok: melampaui 3 belum melampaui 6 bulan (masa angsuran 2-3 bulan).
    expect(AMBANG_SOM.SATU_SAMPAI_3_BULAN.pokokLewatBulan).toBe(3);
    expect(AMBANG_SOM.SATU_SAMPAI_3_BULAN.pokokBatasAtasBulan).toBe(6);
    // Pokok: melampaui 6 belum melampaui 12 bulan (masa angsuran >= 6 bulan).
    expect(AMBANG_SOM.ENAM_BULAN_ATAU_LEBIH.pokokLewatBulan).toBe(6);
    expect(AMBANG_SOM.ENAM_BULAN_ATAU_LEBIH.pokokBatasAtasBulan).toBe(12);
    // Tanpa angsuran: bunga melampaui 3 belum melampaui 6 bulan; sudah
    // jatuh tempo belum melampaui 3 bulan.
    expect(AMBANG_SOM_TANPA_ANGSURAN.jasaLewatBulan).toBe(3);
    expect(AMBANG_SOM_TANPA_ANGSURAN.jasaBatasAtasBulan).toBe(6);
    expect(AMBANG_SOM_TANPA_ANGSURAN.setelahJatuhTempoBatasAtasBulan).toBe(3);
  });

  test('kriteria Diragukan memakai DUA rasio berbeda: angsuran 75% & agunan 100%', () => {
    // Naskah huruf a menulis "ANGSURANNYA bernilai sekurang-kurangnya
    // 75% dari utang peminjam termasuk bunganya", huruf b "AGUNANNYA
    // masih bernilai sekurang-kurangnya 100% dari utang peminjam".
    // Keduanya BUKAN "agunan 75%".
    expect(RASIO_ANGSURAN_MINIMUM_DIRAGUKAN).toBe(75);
    expect(RASIO_AGUNAN_MINIMUM_DIRAGUKAN).toBe(100);
    expect(BULAN_DIRAGUKAN_MENJADI_MACET).toBe(21);
  });
});

describe('KolektibilitasSomService — kelompok masa angsuran & satuan tenor', () => {
  test('satuan tenor HARI/MINGGU jatuh ke kelompok "kurang dari 1 bulan"', () => {
    expect(kelompokMasaAngsuran(masaAngsuranBulanDariSatuanTenor('HARI'))).toBe('KURANG_DARI_1_BULAN');
    expect(kelompokMasaAngsuran(masaAngsuranBulanDariSatuanTenor('MINGGU'))).toBe('KURANG_DARI_1_BULAN');
  });

  test('CELAH NASKAH: masa angsuran tepat 1 bulan & 4-5 bulan ditempatkan di kelompok 2-3 bulan', () => {
    // Naskah hanya menyebut "kurang dari 1 bulan", "2 bulan sampai 3
    // bulan", dan "6 bulan atau lebih" — masa angsuran TEPAT 1 bulan
    // (pinjaman bulanan, bentuk paling umum di KSP) dan rentang 4-5
    // bulan tidak disebut. Keputusan penempatannya didokumentasikan di
    // header KolektibilitasSomService.ts; test ini yang menguncinya
    // supaya perubahan penempatan tidak terjadi tanpa disengaja.
    expect(kelompokMasaAngsuran(masaAngsuranBulanDariSatuanTenor('BULAN'))).toBe('SATU_SAMPAI_3_BULAN');
    expect(kelompokMasaAngsuran(1)).toBe('SATU_SAMPAI_3_BULAN');
    expect(kelompokMasaAngsuran(2)).toBe('SATU_SAMPAI_3_BULAN');
    expect(kelompokMasaAngsuran(3)).toBe('SATU_SAMPAI_3_BULAN');
    expect(kelompokMasaAngsuran(4)).toBe('SATU_SAMPAI_3_BULAN');
    expect(kelompokMasaAngsuran(5)).toBe('SATU_SAMPAI_3_BULAN');
    expect(kelompokMasaAngsuran(6)).toBe('ENAM_BULAN_ATAU_LEBIH');
    expect(kelompokMasaAngsuran(12)).toBe('ENAM_BULAN_ATAU_LEBIH');
  });
});

describe('KolektibilitasSomService — bulanPenuhAntara', () => {
  test('menghitung BULAN KALENDER penuh, bukan pembagian 30 hari', () => {
    expect(bulanPenuhAntara('2026-01-15', '2026-02-14')).toBe(0); // belum sampai tanggal yang sama
    expect(bulanPenuhAntara('2026-01-15', '2026-02-15')).toBe(1);
    expect(bulanPenuhAntara('2026-01-15', '2026-04-15')).toBe(3);
    expect(bulanPenuhAntara('2026-01-31', '2026-03-01')).toBe(1); // Feb tidak punya tanggal 31
    expect(bulanPenuhAntara('2025-06-10', '2026-06-10')).toBe(12);
  });

  test('tanggal tujuan lebih awal / sama -> 0, tanggal tidak valid -> 0 (bukan NaN)', () => {
    expect(bulanPenuhAntara('2026-05-01', '2026-05-01')).toBe(0);
    expect(bulanPenuhAntara('2026-05-01', '2026-01-01')).toBe(0);
    expect(bulanPenuhAntara('bukan-tanggal', '2026-01-01')).toBe(0);
  });
});

describe('KolektibilitasSomService — ambang Kurang Lancar (pinjaman dengan angsuran)', () => {
  test('angsuran bulanan: tunggakan pokok 0-3 bulan Lancar, >3 s/d 6 bulan Kurang Lancar', () => {
    expect(klasifikasikanSom(dasar({ bulanTunggakanPokok: 0 })).kategori).toBe('LANCAR');
    expect(klasifikasikanSom(dasar({ bulanTunggakanPokok: 3 })).kategori).toBe('LANCAR');
    expect(klasifikasikanSom(dasar({ bulanTunggakanPokok: 4 })).kategori).toBe('KURANG_LANCAR');
    expect(klasifikasikanSom(dasar({ bulanTunggakanPokok: 6 })).kategori).toBe('KURANG_LANCAR');
    // Lewat batas atas, tanpa angsuran terbayar & tanpa agunan -> Macet.
    expect(klasifikasikanSom(dasar({ bulanTunggakanPokok: 7 })).kategori).toBe('MACET');
  });

  test('angsuran harian/mingguan: ambangnya jauh lebih pendek (1 dan 2 bulan)', () => {
    const harian = (bulan: number) =>
      klasifikasikanSom(
        dasar({ masaAngsuranBulan: masaAngsuranBulanDariSatuanTenor('HARI'), bulanTunggakanPokok: bulan })
      ).kategori;
    expect(harian(1)).toBe('LANCAR');
    expect(harian(2)).toBe('KURANG_LANCAR');
    // Tunggakan 3 bulan pada pinjaman harian sudah melewati Kurang
    // Lancar, padahal pada pinjaman bulanan masih Lancar — inti
    // perbedaan SOM terhadap ambang hari tunggal.
    expect(harian(3)).toBe('MACET');
    expect(klasifikasikanSom(dasar({ bulanTunggakanPokok: 3 })).kategori).toBe('LANCAR');
  });

  test('angsuran 6 bulanan: toleransi pokok sampai 12 bulan', () => {
    const enamBulanan = (bulan: number) =>
      klasifikasikanSom(dasar({ masaAngsuranBulan: 6, bulanTunggakanPokok: bulan })).kategori;
    expect(enamBulanan(6)).toBe('LANCAR');
    expect(enamBulanan(7)).toBe('KURANG_LANCAR');
    expect(enamBulanan(12)).toBe('KURANG_LANCAR');
    expect(enamBulanan(13)).toBe('MACET');
  });

  test('tunggakan BUNGA dinilai terpisah dan yang TERBURUK yang menentukan', () => {
    // Pokok masih Lancar (2 bulan) tetapi bunga sudah lewat 3 bulan.
    const hasil = klasifikasikanSom(dasar({ bulanTunggakanPokok: 2, bulanTunggakanJasa: 5 }));
    expect(hasil.kategori).toBe('KURANG_LANCAR');
    expect(hasil.dasarPenggolongan).toContain('bunga');

    // Pokok yang lebih buruk -> penjelasannya menyebut pokok.
    const hasilPokok = klasifikasikanSom(dasar({ bulanTunggakanPokok: 5, bulanTunggakanJasa: 1 }));
    expect(hasilPokok.kategori).toBe('KURANG_LANCAR');
    expect(hasilPokok.dasarPenggolongan).toContain('pokok');
  });

  test('pinjaman harian: tunggakan bunga punya batas atas 3 bulan, berbeda dari pokok (2 bulan)', () => {
    const harian = (pokok: number, jasa: number) =>
      klasifikasikanSom(
        dasar({
          masaAngsuranBulan: masaAngsuranBulanDariSatuanTenor('HARI'),
          bulanTunggakanPokok: pokok,
          bulanTunggakanJasa: jasa,
        })
      ).kategori;
    // Bunga 3 bulan masih di dalam rentang Kurang Lancar (batas atas 3),
    // sementara pokok 3 bulan sudah melewatinya (batas atas 2).
    expect(harian(0, 3)).toBe('KURANG_LANCAR');
    expect(harian(3, 0)).toBe('MACET');
  });
});

describe('KolektibilitasSomService — pinjaman TANPA ANGSURAN (angka 12.1 butir 1 sub 2)', () => {
  test('belum jatuh tempo: dinilai dari tunggakan bunga (>3 s/d 6 bulan Kurang Lancar)', () => {
    const tanpa = (jasa: number) =>
      klasifikasikanSom(dasar({ polaPengembalian: 'TANPA_ANGSURAN', bulanTunggakanJasa: jasa })).kategori;
    expect(tanpa(3)).toBe('LANCAR');
    expect(tanpa(4)).toBe('KURANG_LANCAR');
    expect(tanpa(6)).toBe('KURANG_LANCAR');
    expect(tanpa(7)).toBe('MACET');
  });

  test('sudah jatuh tempo & belum dibayar: Kurang Lancar sejak bulan ke-0, Macet setelah 3 bulan', () => {
    const jatuhTempo = (bulan: number) =>
      klasifikasikanSom(
        dasar({ polaPengembalian: 'TANPA_ANGSURAN', sudahJatuhTempo: true, bulanSejakJatuhTempo: bulan })
      ).kategori;
    expect(jatuhTempo(0)).toBe('KURANG_LANCAR');
    expect(jatuhTempo(3)).toBe('KURANG_LANCAR');
    expect(jatuhTempo(4)).toBe('MACET');
  });
});

describe('KolektibilitasSomService — kriteria Diragukan (angka 12.1 butir 2)', () => {
  /** Tunggakan yang sudah melewati batas atas Kurang Lancar untuk pinjaman bulanan. */
  const lewatAmbang = { bulanTunggakanPokok: 7 };

  test('huruf a — angsuran terbayar >= 75% kewajiban termasuk bunga -> Diragukan', () => {
    const memenuhi = klasifikasikanSom(
      dasar({ ...lewatAmbang, angsuranTerbayar: 9_000_000, totalKewajibanKontraktual: 12_000_000 })
    );
    expect(memenuhi.rasioAngsuranPersen).toBeCloseTo(75);
    expect(memenuhi.kategori).toBe('DIRAGUKAN');
    expect(memenuhi.dasarPenggolongan).toContain('huruf a');

    // Tepat di bawah 75% dan tanpa agunan -> Macet.
    const tidakMemenuhi = klasifikasikanSom(
      dasar({ ...lewatAmbang, angsuranTerbayar: 8_999_999, totalKewajibanKontraktual: 12_000_000 })
    );
    expect(tidakMemenuhi.kategori).toBe('MACET');
  });

  test('huruf b — agunan >= 100% sisa utang -> Diragukan', () => {
    const memenuhi = klasifikasikanSom(
      dasar({ ...lewatAmbang, nilaiAgunan: 12_000_000, sisaUtang: 12_000_000 })
    );
    expect(memenuhi.rasioAgunanPersen).toBeCloseTo(100);
    expect(memenuhi.kategori).toBe('DIRAGUKAN');
    expect(memenuhi.dasarPenggolongan).toContain('huruf b');

    // 99% agunan TIDAK cukup untuk huruf b — naskah menulis
    // "sekurang-kurangnya 100%", bukan 75%.
    const kurang = klasifikasikanSom(
      dasar({ ...lewatAmbang, nilaiAgunan: 11_880_000, sisaUtang: 12_000_000 })
    );
    expect(kurang.kategori).toBe('MACET');
  });

  test('agunan 75% TIDAK lagi cukup menjadikan Diragukan (koreksi terhadap penafsiran lama)', () => {
    // Implementasi sebelumnya keliru memakai "agunan >= 75%". Naskah
    // menempatkan 75% pada ANGSURAN dan 100% pada AGUNAN.
    const hasil = klasifikasikanSom(
      dasar({ ...lewatAmbang, nilaiAgunan: 9_000_000, sisaUtang: 12_000_000, angsuranTerbayar: 0 })
    );
    expect(hasil.rasioAgunanPersen).toBeCloseTo(75);
    expect(hasil.kategori).toBe('MACET');
  });

  test('salah satu kriteria cukup — keduanya tidak harus terpenuhi bersamaan', () => {
    const hanyaAgunan = klasifikasikanSom(
      dasar({ ...lewatAmbang, angsuranTerbayar: 0, nilaiAgunan: 20_000_000, sisaUtang: 12_000_000 })
    );
    expect(hanyaAgunan.kategori).toBe('DIRAGUKAN');

    const hanyaAngsuran = klasifikasikanSom(
      dasar({ ...lewatAmbang, angsuranTerbayar: 12_000_000, totalKewajibanKontraktual: 12_000_000, nilaiAgunan: 0 })
    );
    expect(hanyaAngsuran.kategori).toBe('DIRAGUKAN');
  });

  test('penyebut 0 tidak menghasilkan NaN maupun Infinity pada kedua rasio', () => {
    const hasil = klasifikasikanSom(
      dasar({ ...lewatAmbang, totalKewajibanKontraktual: 0, sisaUtang: 0, nilaiAgunan: 5_000_000 })
    );
    expect(hasil.rasioAngsuranPersen).toBe(0);
    expect(hasil.rasioAgunanPersen).toBe(0);
    expect(Number.isFinite(hasil.rasioAgunanPersen)).toBe(true);
    expect(hasil.kategori).toBe('MACET');
  });
});

describe('KolektibilitasSomService — kriteria Macet (angka 12.1 butir 3)', () => {
  test('angka 2 — Diragukan yang berlanjut 21 bulan tanpa pelunasan menjadi Macet', () => {
    const agunanPenuh = { nilaiAgunan: 12_000_000, sisaUtang: 12_000_000 };
    // Batas atas Kurang Lancar untuk angsuran bulanan = 6 bulan, jadi
    // lama "digolongkan Diragukan" = usia tunggakan - 6.
    const duaPuluh = klasifikasikanSom(dasar({ ...agunanPenuh, bulanTunggakanPokok: 6 + 20 }));
    expect(duaPuluh.kategori).toBe('DIRAGUKAN');
    expect(duaPuluh.bulanSejakDiragukan).toBe(20);

    const duaPuluhSatu = klasifikasikanSom(dasar({ ...agunanPenuh, bulanTunggakanPokok: 6 + 21 }));
    expect(duaPuluhSatu.kategori).toBe('MACET');
    expect(duaPuluhSatu.bulanSejakDiragukan).toBe(21);
    expect(duaPuluhSatu.dasarPenggolongan).toContain('21 bulan');
  });

  test('angka 3 — penyerahan ke Pengadilan Negeri / klaim asuransi kredit -> Macet tanpa syarat lain', () => {
    const hasil = klasifikasikanSom(
      dasar({
        bulanTunggakanPokok: 0,
        bulanTunggakanJasa: 0,
        angsuranTerbayar: 12_000_000,
        nilaiAgunan: 20_000_000,
        diserahkanKePengadilanAtauAsuransi: true,
      })
    );
    expect(hasil.kategori).toBe('MACET');
    expect(hasil.dasarPenggolongan).toContain('Pengadilan Negeri');
    expect(hasil.dasarPenggolongan).toContain('asuransi kredit');
  });

  test('nilai negatif diperlakukan sebagai 0, bukan dibiarkan membalik logika', () => {
    const hasil = klasifikasikanSom(
      dasar({ bulanTunggakanPokok: -5, bulanTunggakanJasa: -1, nilaiAgunan: -1_000_000, angsuranTerbayar: -1 })
    );
    expect(hasil.kategori).toBe('LANCAR');
    expect(hasil.rasioAgunanPersen).toBe(0);
    expect(hasil.rasioAngsuranPersen).toBe(0);
  });
});

describe('KolektibilitasSomService — hitungPenyisihanSom', () => {
  test('penyisihan = saldo POKOK x persentase kategori, dibulatkan ke Rupiah', () => {
    expect(hitungPenyisihanSom(10_000_000, 'LANCAR')).toBe(0);
    expect(hitungPenyisihanSom(10_000_000, 'KURANG_LANCAR')).toBe(5_000_000);
    expect(hitungPenyisihanSom(10_000_000, 'DIRAGUKAN')).toBe(7_500_000);
    expect(hitungPenyisihanSom(10_000_000, 'MACET')).toBe(10_000_000);
  });

  test('agunan TIDAK dikurangkan dari dasar pencadangan SOM (itu aturan fiskal PMK 74)', () => {
    // Fungsi ini bahkan tidak menerima nilai agunan — dasarnya saldo
    // pokok penuh. Test ini menjaga perbedaan buku vs fiskal tetap nyata.
    expect(hitungPenyisihanSom.length).toBe(2);
  });

  test('saldo pokok negatif -> 0, tidak menghasilkan penyisihan negatif', () => {
    expect(hitungPenyisihanSom(-1_000_000, 'MACET')).toBe(0);
  });
});
