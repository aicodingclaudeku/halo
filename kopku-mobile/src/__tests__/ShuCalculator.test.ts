import {
  hitungRingkasanSHU,
  validasiTotalPersentase,
  TotalPersentaseTidakValidError,
  ShuNegatifError,
  HasilPerhitunganNegatifError,
  KonfigurasiPersentaseSHU,
} from '@/accounting/ShuCalculator';
import { sum } from '@/utils/money';

// Audit ulang §5/§6/§7 (permintaan pengguna): "Lainnya (%)" DIHAPUS
// TOTAL — KonfigurasiPersentaseSHU sekarang HANYA 9 komponen. Fixture
// di bawah ini adalah data UJI (bukan data aplikasi sungguhan) — porsi
// yang dulu dialokasikan ke "Lainnya" (5%) dipindah ke Cadangan supaya
// total tetap 100% tanpa menambah komponen baru.
const KONFIGURASI_VALID: KonfigurasiPersentaseSHU = {
  persenCadangan: 30,
  persenJasaModal: 20,
  persenJasaUsaha: 20,
  persenPendidikan: 10,
  persenSosial: 10,
  persenPengurus: 5,
  persenPengawas: 5,
  persenKaryawan: 0,
  persenPembangunanDaerahKerja: 0,
  persenCadanganRisiko: 0,
};

describe('validasiTotalPersentase (PRD §29 - Validasi: TOTAL = 100%)', () => {
  test('menerima konfigurasi yang totalnya tepat 100%', () => {
    expect(() => validasiTotalPersentase(KONFIGURASI_VALID)).not.toThrow();
  });

  test('menolak konfigurasi yang totalnya kurang dari 100% (mis. setelah "Lainnya" dihapus, total belum disesuaikan)', () => {
    const invalid = { ...KONFIGURASI_VALID, persenPengawas: 0 }; // hilangkan 5% -> total 95%
    expect(() => validasiTotalPersentase(invalid)).toThrow(TotalPersentaseTidakValidError);
  });

  test('menolak konfigurasi yang totalnya lebih dari 100%', () => {
    const invalid = { ...KONFIGURASI_VALID, persenCadangan: 80 }; // total jadi 150%
    expect(() => validasiTotalPersentase(invalid)).toThrow(TotalPersentaseTidakValidError);
  });

  test('toleransi pembulatan kecil (mis. 99.999999 akibat floating point) tetap diterima', () => {
    const hampirValid = { ...KONFIGURASI_VALID, persenCadangan: 29.999999 };
    expect(() => validasiTotalPersentase(hampirValid)).not.toThrow();
  });

  test('tidak ada lagi field persenLainnya pada KonfigurasiPersentaseSHU', () => {
    expect((KONFIGURASI_VALID as any).persenLainnya).toBeUndefined();
  });
});

describe('hitungRingkasanSHU (PRD §29 - perhitungan & distribusi SHU, tanpa "Lainnya")', () => {
  test('total 7 komponen kategori (tanpa lainnya) HARUS PERSIS SAMA dengan totalSHU (rekonsiliasi penuh)', () => {
    const hasil = hitungRingkasanSHU(10_000_000, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 1_000_000, basisPartisipasiUsaha: 200_000 },
      { anggotaId: 'a2', basisSimpanan: 3_000_000, basisPartisipasiUsaha: 100_000 },
    ]);

    expect((hasil as any).lainnya).toBeUndefined();

    const totalKategori = sum([
      hasil.cadangan,
      hasil.cadanganRisiko,
      hasil.jasaModal,
      hasil.jasaUsaha,
      hasil.pendidikan,
      hasil.sosial,
      hasil.pengurus,
      hasil.pengawas,
      hasil.karyawan,
      hasil.pembangunanDaerahKerja,
    ]);
    expect(totalKategori).toBe(10_000_000);
  });

  test('jasa modal dibagi proporsional terhadap basis simpanan, total dibagi = pool persis', () => {
    const hasil = hitungRingkasanSHU(10_000_000, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 1_000_000, basisPartisipasiUsaha: 0 },
      { anggotaId: 'a2', basisSimpanan: 3_000_000, basisPartisipasiUsaha: 0 },
    ]);

    // pool jasa modal = 20% x 10jt = 2.000.000, dibagi rasio 1:3
    const a1 = hasil.anggota.find((a) => a.anggotaId === 'a1')!;
    const a2 = hasil.anggota.find((a) => a.anggotaId === 'a2')!;
    expect(a1.jasaModal).toBe(500_000);
    expect(a2.jasaModal).toBe(1_500_000);
    expect(a1.jasaModal + a2.jasaModal).toBe(hasil.jasaModal);
  });

  test('jasa usaha dibagi proporsional terhadap basis partisipasi usaha', () => {
    const hasil = hitungRingkasanSHU(10_000_000, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 0, basisPartisipasiUsaha: 300_000 },
      { anggotaId: 'a2', basisSimpanan: 0, basisPartisipasiUsaha: 100_000 },
    ]);

    // pool jasa usaha = 20% x 10jt = 2.000.000, dibagi rasio 3:1
    const a1 = hasil.anggota.find((a) => a.anggotaId === 'a1')!;
    const a2 = hasil.anggota.find((a) => a.anggotaId === 'a2')!;
    expect(a1.jasaUsaha).toBe(1_500_000);
    expect(a2.jasaUsaha).toBe(500_000);
  });

  test('total_shu_anggota = jasaModal + jasaUsaha per anggota', () => {
    const hasil = hitungRingkasanSHU(10_000_000, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 1_000_000, basisPartisipasiUsaha: 200_000 },
    ]);
    const a1 = hasil.anggota[0];
    expect(a1.totalShuAnggota).toBe(a1.jasaModal + a1.jasaUsaha);
  });

  test('total seluruh anggota + porsi organisasi HARUS PERSIS SAMA dengan totalSHU', () => {
    const hasil = hitungRingkasanSHU(7_777_777, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 1_234_567, basisPartisipasiUsaha: 111_111 },
      { anggotaId: 'a2', basisSimpanan: 2_345_678, basisPartisipasiUsaha: 222_222 },
      { anggotaId: 'a3', basisSimpanan: 3_456_789, basisPartisipasiUsaha: 333_333 },
    ]);

    const totalAnggota = sum(hasil.anggota.map((a) => a.totalShuAnggota));
    const totalOrganisasi = sum([
      hasil.cadangan,
      hasil.cadanganRisiko,
      hasil.pendidikan,
      hasil.sosial,
      hasil.pengurus,
      hasil.pengawas,
      hasil.karyawan,
      hasil.pembangunanDaerahKerja,
    ]);
    // jasaModal & jasaUsaha pool sudah terbagi habis ke anggota (basis > 0 semua),
    // jadi totalAnggota + totalOrganisasi harus persis sama dengan totalSHU.
    expect(totalAnggota + totalOrganisasi).toBe(7_777_777);
  });

  test('basis kosong (tidak ada anggota bertransaksi) tidak membuat uang hilang — dilimpahkan ke Cadangan (bukan "Lainnya")', () => {
    const hasil = hitungRingkasanSHU(10_000_000, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 0, basisPartisipasiUsaha: 0 },
    ]);

    expect(hasil.anggota[0].jasaModal).toBe(0);
    expect(hasil.anggota[0].jasaUsaha).toBe(0);
    // pool jasa modal (2jt) + jasa usaha (2jt) yang tidak terbagi masuk
    // ke Cadangan: cadangan dasar 30% x 10jt = 3jt, ditambah 4jt -> 7jt.
    expect(hasil.cadangan).toBe(7_000_000);
    const totalKategori = sum([
      hasil.cadangan,
      hasil.cadanganRisiko,
      hasil.jasaModal,
      hasil.jasaUsaha,
      hasil.pendidikan,
      hasil.sosial,
      hasil.pengurus,
      hasil.pengawas,
      hasil.karyawan,
      hasil.pembangunanDaerahKerja,
    ]);
    expect(totalKategori).toBe(10_000_000);
  });

  test('daftar anggota kosong tetap menghasilkan ringkasan kategori yang valid (tidak crash)', () => {
    const hasil = hitungRingkasanSHU(5_000_000, KONFIGURASI_VALID, []);
    expect(hasil.anggota).toEqual([]);
    const totalKategori = sum([
      hasil.cadangan,
      hasil.cadanganRisiko,
      hasil.jasaModal,
      hasil.jasaUsaha,
      hasil.pendidikan,
      hasil.sosial,
      hasil.pengurus,
      hasil.pengawas,
      hasil.karyawan,
      hasil.pembangunanDaerahKerja,
    ]);
    expect(totalKategori).toBe(5_000_000);
  });

  test('Phase 13: totalSHU negatif (rugi) DITOLAK eksplisit, bukan diam-diam dihitung jadi pool negatif', () => {
    expect(() =>
      hitungRingkasanSHU(-1_000_000, KONFIGURASI_VALID, [
        { anggotaId: 'a1', basisSimpanan: 1_000_000, basisPartisipasiUsaha: 0 },
      ])
    ).toThrow(ShuNegatifError);
  });

  test('totalSHU 0 (impas) tetap boleh dihitung — semua kategori & anggota dapat 0, bukan error', () => {
    const hasil = hitungRingkasanSHU(0, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 1_000_000, basisPartisipasiUsaha: 0 },
    ]);
    expect(hasil.totalSHUPositif).toBe(false);
    expect(hasil.totalSHU).toBe(0);
    expect(hasil.anggota[0].totalShuAnggota).toBe(0);
    expect(hasil.cadangan).toBe(0);
  });

  test('totalSHU positif ditandai totalSHUPositif=true', () => {
    const hasil = hitungRingkasanSHU(1, KONFIGURASI_VALID, []);
    expect(hasil.totalSHUPositif).toBe(true);
  });

  test('konfigurasi persentase tidak valid (bukan 100%) menolak perhitungan', () => {
    const invalid = { ...KONFIGURASI_VALID, persenPengawas: 0 };
    expect(() => hitungRingkasanSHU(10_000_000, invalid, [])).toThrow(TotalPersentaseTidakValidError);
  });

  test('anggota dengan basis 0 di antara anggota lain yang basisnya > 0 tetap mendapat 0, bukan error', () => {
    const hasil = hitungRingkasanSHU(10_000_000, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 0, basisPartisipasiUsaha: 0 },
      { anggotaId: 'a2', basisSimpanan: 5_000_000, basisPartisipasiUsaha: 500_000 },
    ]);
    const a1 = hasil.anggota.find((a) => a.anggotaId === 'a1')!;
    expect(a1.jasaModal).toBe(0);
    expect(a1.jasaUsaha).toBe(0);
  });

  test('selisih pembulatan Rupiah (mis. Rp1-2) dilimpahkan ke Cadangan, bukan membuat nominal "Lainnya" negatif', () => {
    // Angka totalSHU ganjil supaya persentase menghasilkan pembulatan yang tidak pas.
    const hasil = hitungRingkasanSHU(1_000_001, KONFIGURASI_VALID, [
      { anggotaId: 'a1', basisSimpanan: 1, basisPartisipasiUsaha: 1 },
    ]);
    const totalKategori = sum([
      hasil.cadangan,
      hasil.cadanganRisiko,
      hasil.jasaModal,
      hasil.jasaUsaha,
      hasil.pendidikan,
      hasil.sosial,
      hasil.pengurus,
      hasil.pengawas,
      hasil.karyawan,
      hasil.pembangunanDaerahKerja,
    ]);
    expect(totalKategori).toBe(1_000_001);
    expect(hasil.cadangan).toBeGreaterThanOrEqual(0);
  });
});

describe('KonfigurasiPersentaseSHU — komponen Karyawan & Pembangunan Daerah Kerja (update pasca-Phase 18/19 §U)', () => {
  test('validasiTotalPersentase: MENOLAK kalau total tanpa memperhitungkan Karyawan/Pembangunan Daerah Kerja hanya 95% (bukti keduanya BENAR-BENAR ikut divalidasi, bukan cuma label UI)', () => {
    const config = { ...KONFIGURASI_VALID, persenKaryawan: 0, persenPembangunanDaerahKerja: 0, persenCadangan: 25 };
    // 25+20+20+10+10+5+5+0+0 = 95
    expect(() => validasiTotalPersentase(config)).toThrow(TotalPersentaseTidakValidError);
  });

  test('validasiTotalPersentase: BERHASIL kalau Karyawan + Pembangunan Daerah Kerja MENGISI porsi supaya total tetap 100%', () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenKaryawan: 3, persenPembangunanDaerahKerja: 2 };
    // 25+20+20+10+10+5+5+3+2 = 100
    expect(() => validasiTotalPersentase(config)).not.toThrow();
  });

  test('hitungRingkasanSHU: Karyawan & Pembangunan Daerah Kerja menghasilkan pool NOMINAL sungguhan (persentase x totalSHU), bukan 0/diabaikan', () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenKaryawan: 3, persenPembangunanDaerahKerja: 2 };
    const hasil = hitungRingkasanSHU(10_000_000, config, []);
    expect(hasil.karyawan).toBe(300_000); // 3% dari 10jt
    expect(hasil.pembangunanDaerahKerja).toBe(200_000); // 2% dari 10jt
  });

  test('hitungRingkasanSHU: total SELURUH kategori (termasuk 2 komponen baru) tetap PERSIS sama dengan totalSHU (tidak ada uang yang hilang/bertambah)', () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenKaryawan: 3, persenPembangunanDaerahKerja: 2 };
    const hasil = hitungRingkasanSHU(10_000_000, config, [
      { anggotaId: 'a1', basisSimpanan: 5_000_000, basisPartisipasiUsaha: 500_000 },
    ]);
    const totalSeluruhKategori =
      hasil.cadangan +
      hasil.cadanganRisiko +
      hasil.jasaModal +
      hasil.jasaUsaha +
      hasil.pendidikan +
      hasil.sosial +
      hasil.pengurus +
      hasil.pengawas +
      hasil.karyawan +
      hasil.pembangunanDaerahKerja;
    expect(totalSeluruhKategori).toBe(10_000_000);
  });
});

describe('KonfigurasiPersentaseSHU — komponen Cadangan Risiko (audit ulang §13/§14/§16)', () => {
  test('validasiTotalPersentase: MENOLAK kalau Cadangan Risiko diisi tapi komponen lain belum dikurangi (total > 100%)', () => {
    const config = { ...KONFIGURASI_VALID, persenCadanganRisiko: 5 };
    // 30+20+20+10+10+5+5+0+0+5 = 105
    expect(() => validasiTotalPersentase(config)).toThrow(TotalPersentaseTidakValidError);
  });

  test('validasiTotalPersentase: BERHASIL kalau Cadangan Risiko mengambil porsi dari Cadangan supaya total tetap 100% (persentase komponen LAIN tidak berubah otomatis — dikurangi manual di fixture)', () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenCadanganRisiko: 5 };
    // 25+20+20+10+10+5+5+0+0+5 = 100
    expect(() => validasiTotalPersentase(config)).not.toThrow();
  });

  test('konfigurasi lama (persenCadanganRisiko default 0) TETAP VALID tanpa perlu diubah — kompatibel mundur (§16)', () => {
    // KONFIGURASI_VALID merepresentasikan konfigurasi existing sebelum
    // Cadangan Risiko ada — persenCadanganRisiko: 0 (bukan wajib diisi),
    // total tetap 100% tanpa perlu mengubah persentase komponen lain.
    expect(() => validasiTotalPersentase(KONFIGURASI_VALID)).not.toThrow();
  });

  test('hitungRingkasanSHU: Cadangan Risiko menghasilkan pool NOMINAL sungguhan (persentase x totalSHU), TERPISAH dari Cadangan (Umum)', () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenCadanganRisiko: 5 };
    const hasil = hitungRingkasanSHU(10_000_000, config, [
      { anggotaId: 'a1', basisSimpanan: 5_000_000, basisPartisipasiUsaha: 500_000 },
    ]);
    expect(hasil.cadanganRisiko).toBe(500_000); // 5% dari 10jt, TETAP (bukan residual)
  });

  test('hitungRingkasanSHU: Cadangan Risiko TIDAK ikut menyerap sisa pool jasa modal/usaha yang tak terbagi (basis 0) — HANYA Cadangan (Umum) yang menyerap', () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenCadanganRisiko: 5 };
    const hasil = hitungRingkasanSHU(10_000_000, config, [
      { anggotaId: 'a1', basisSimpanan: 0, basisPartisipasiUsaha: 0 },
    ]);
    // Cadangan Risiko TETAP 5% x 10jt = 500rb, tidak berubah oleh basis 0.
    expect(hasil.cadanganRisiko).toBe(500_000);
    // Cadangan (Umum) menyerap seluruh sisa: pool jasa modal (2jt) + jasa
    // usaha (2jt) tak terbagi + cadangan dasar 25% x 10jt = 2,5jt -> 6,5jt.
    expect(hasil.cadangan).toBe(6_500_000);
    const totalKategori =
      hasil.cadangan +
      hasil.cadanganRisiko +
      hasil.jasaModal +
      hasil.jasaUsaha +
      hasil.pendidikan +
      hasil.sosial +
      hasil.pengurus +
      hasil.pengawas +
      hasil.karyawan +
      hasil.pembangunanDaerahKerja;
    expect(totalKategori).toBe(10_000_000);
  });

  test('totalSHU 0 (impas): Cadangan Risiko juga 0, bukan error', () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenCadanganRisiko: 5 };
    const hasil = hitungRingkasanSHU(0, config, []);
    expect(hasil.cadanganRisiko).toBe(0);
  });
});

describe('HasilPerhitunganNegatifError — pengaman anti-negatif (audit ulang §7)', () => {
  test('error diekspor dan punya nama yang benar', () => {
    const err = new HasilPerhitunganNegatifError('Cadangan', -2);
    expect(err.name).toBe('HasilPerhitunganNegatifError');
    expect(err.message).toContain('Cadangan');
  });
});
