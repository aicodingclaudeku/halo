import { DEFAULT_ASET_KLASIFIKASI } from '@/config/defaultAsetKlasifikasi';

describe('DEFAULT_ASET_KLASIFIKASI (Phase 18 §14-19)', () => {
  test('Kelompok 1: 11 sub-kelompok, semuanya masa manfaat 48 bulan', () => {
    const k1 = DEFAULT_ASET_KLASIFIKASI.filter((k) => k.kelompok === 'Kelompok 1');
    expect(k1).toHaveLength(11);
    expect(k1.every((k) => k.masaManfaatBulanDefault === 48)).toBe(true);
    expect(k1.map((k) => k.subKelompok)).toContain('Mebel dan peralatan dari kayu atau rotan');
    expect(k1.map((k) => k.subKelompok)).toContain('Mobil taksi, bus, dan truk yang digunakan sebagai angkutan umum');
  });

  test('Kelompok 2: 11 sub-kelompok, semuanya masa manfaat 96 bulan', () => {
    const k2 = DEFAULT_ASET_KLASIFIKASI.filter((k) => k.kelompok === 'Kelompok 2');
    expect(k2).toHaveLength(11);
    expect(k2.every((k) => k.masaManfaatBulanDefault === 96)).toBe(true);
    expect(k2.map((k) => k.subKelompok)).toContain('Mebel dan peralatan dari logam');
  });

  test('Kelompok 3: masa manfaat 192 bulan, tiga sub-kelompok sesuai daftar yang diminta (§17)', () => {
    const k3 = DEFAULT_ASET_KLASIFIKASI.filter((k) => k.kelompok === 'Kelompok 3');
    expect(k3).toHaveLength(3);
    expect(k3.every((k) => k.masaManfaatBulanDefault === 192)).toBe(true);
    const subs = k3.map((k) => k.subKelompok);
    expect(subs).toContain('Mesin pengolah pemintalan, pertenunan, dan pencelupan');
    expect(subs).toContain('Mesin pengolah perkayuan');
    expect(subs).toContain('Mesin dan peralatan penggergajian');
    // Placeholder lama TIDAK boleh muncul lagi di daftar default baru.
    expect(subs).not.toContain('Sub Kelompok Lainnya (tambahkan sesuai kebutuhan)');
  });

  test('Kelompok 4: Bangunan Permanen 240 bulan, Bangunan Tidak Permanen 120 bulan', () => {
    const k4 = DEFAULT_ASET_KLASIFIKASI.filter((k) => k.kelompok === 'Kelompok 4');
    expect(k4).toHaveLength(2);
    expect(k4.find((k) => k.subKelompok === 'Bangunan Permanen')?.masaManfaatBulanDefault).toBe(240);
    expect(k4.find((k) => k.subKelompok === 'Bangunan Tidak Permanen')?.masaManfaatBulanDefault).toBe(120);
  });

  test('Kelompok 5: "Lainnya" tersedia dengan masa manfaat default null (opsional, §18)', () => {
    const k5 = DEFAULT_ASET_KLASIFIKASI.filter((k) => k.kelompok === 'Kelompok 5');
    expect(k5).toHaveLength(1);
    expect(k5[0].subKelompok).toBe('Lainnya');
    expect(k5[0].masaManfaatBulanDefault).toBeNull();
  });

  test('tidak ada duplikat (kelompok, subKelompok) — konsisten dengan UNIQUE constraint aset_klasifikasi', () => {
    const keys = DEFAULT_ASET_KLASIFIKASI.map((k) => `${k.kelompok.toLowerCase()}::${k.subKelompok.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('semua masa manfaat yang diisi (bukan null) bernilai positif (bulan) — null hanya untuk Kelompok 5', () => {
    expect(
      DEFAULT_ASET_KLASIFIKASI.every((k) => k.masaManfaatBulanDefault === null || k.masaManfaatBulanDefault > 0)
    ).toBe(true);
    expect(DEFAULT_ASET_KLASIFIKASI.filter((k) => k.masaManfaatBulanDefault === null)).toHaveLength(1);
  });
});
