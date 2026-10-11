import { kelompokkanJadwalAngsuran, isAngsuranAktif, JadwalAngsuranItem } from '@/services/PinjamanService';
import { buildAngsuranExport } from '@/export/ReportTableBuilders';

/**
 * REQUIREMENT 6 (permintaan pengguna) — pemisahan Angsuran Aktif /
 * Restrukturisasi / Akad Ulang.
 *
 * BUG YANG DIPERBAIKI: `getJadwalAngsuran()` mengembalikan SELURUH baris
 * `angsuran_jadwal` termasuk yang berstatus 'DIRESTRUKTURISASI' &
 * 'DIHAPUSBUKU'. Detail Pinjaman merendernya sebagai SATU daftar campur,
 * dan daftar campur yang sama diteruskan ke `buildAngsuranExport()` —
 * sehingga export "Angsuran Aktif" ikut memuat angsuran restrukturisasi
 * dan angsuran lama yang sudah tidak berlaku.
 *
 * Test ini menguji fungsi klasifikasi MURNI (tanpa database) yang
 * sekarang menjadi SATU-SATUNYA definisi "angsuran aktif" — dipakai
 * layar MAUPUN export, jadi keduanya mustahil berbeda isi.
 */

function baris(over: Partial<JadwalAngsuranItem> & { id: string }): JadwalAngsuranItem {
  return {
    nomorAngsuran: 1,
    tanggalJatuhTempo: '2026-03-01',
    pokok: 100000,
    jasa: 10000,
    denda: 0,
    total: 110000,
    pokokTerbayar: 0,
    jasaTerbayar: 0,
    dendaTerbayar: 0,
    status: 'BELUM_BAYAR',
    dibuatDariAkadUlangId: null,
    digantikanOlehAkadUlangId: null,
    ...over,
  };
}

describe('REQ 6 — kelompokkanJadwalAngsuran', () => {
  test('baris akad asli yang masih berjalan -> AKTIF', () => {
    expect(kelompokkanJadwalAngsuran(baris({ id: '1' }))).toBe('AKTIF');
    expect(kelompokkanJadwalAngsuran(baris({ id: '2', status: 'SEBAGIAN' }))).toBe('AKTIF');
    expect(kelompokkanJadwalAngsuran(baris({ id: '3', status: 'LUNAS' }))).toBe('AKTIF');
    expect(kelompokkanJadwalAngsuran(baris({ id: '4', status: 'TERLAMBAT' }))).toBe('AKTIF');
  });

  test('baris hasil akad ulang -> AKAD_ULANG (bukan AKTIF biasa)', () => {
    const item = baris({ id: '5', dibuatDariAkadUlangId: 'akad-1' });
    expect(kelompokkanJadwalAngsuran(item)).toBe('AKAD_ULANG');
  });

  test('baris lama yang sudah digantikan -> RESTRUKTURISASI', () => {
    const item = baris({ id: '6', status: 'DIRESTRUKTURISASI', digantikanOlehAkadUlangId: 'akad-1' });
    expect(kelompokkanJadwalAngsuran(item)).toBe('RESTRUKTURISASI');
  });

  test('status DIRESTRUKTURISASI menang atas asal akad ulang (akad ulang yang sudah diakadulangkan lagi)', () => {
    // Skenario nyata: pinjaman diakadulangkan DUA KALI. Baris hasil akad
    // ulang pertama berstatus DIRESTRUKTURISASI karena digantikan akad
    // ulang kedua — baris ini TIDAK BOLEH dihitung sebagai angsuran aktif
    // walau `dibuatDariAkadUlangId`-nya terisi.
    const item = baris({
      id: '7',
      status: 'DIRESTRUKTURISASI',
      dibuatDariAkadUlangId: 'akad-1',
      digantikanOlehAkadUlangId: 'akad-2',
    });
    expect(kelompokkanJadwalAngsuran(item)).toBe('RESTRUKTURISASI');
    expect(isAngsuranAktif(item)).toBe(false);
  });

  test('baris hapus buku -> DIHAPUSBUKU dan bukan angsuran aktif', () => {
    const item = baris({ id: '8', status: 'DIHAPUSBUKU' });
    expect(kelompokkanJadwalAngsuran(item)).toBe('DIHAPUSBUKU');
    expect(isAngsuranAktif(item)).toBe(false);
  });
});

describe('REQ 6 — isAngsuranAktif sebagai penyaring export', () => {
  const semua: JadwalAngsuranItem[] = [
    baris({ id: 'aktif-1', nomorAngsuran: 1 }),
    baris({ id: 'aktif-2', nomorAngsuran: 2, status: 'LUNAS' }),
    baris({ id: 'restru-1', nomorAngsuran: 3, status: 'DIRESTRUKTURISASI', digantikanOlehAkadUlangId: 'akad-1' }),
    baris({ id: 'restru-2', nomorAngsuran: 4, status: 'DIRESTRUKTURISASI', digantikanOlehAkadUlangId: 'akad-1' }),
    baris({ id: 'akad-baru-1', nomorAngsuran: 5, dibuatDariAkadUlangId: 'akad-1' }),
    baris({ id: 'hapusbuku-1', nomorAngsuran: 6, status: 'DIHAPUSBUKU' }),
  ];

  test('penyaring MENGELUARKAN restrukturisasi & hapus buku', () => {
    const aktif = semua.filter(isAngsuranAktif).map((j) => j.id);
    expect(aktif).toEqual(['aktif-1', 'aktif-2', 'akad-baru-1']);
    expect(aktif).not.toContain('restru-1');
    expect(aktif).not.toContain('restru-2');
    expect(aktif).not.toContain('hapusbuku-1');
  });

  test('export "Angsuran Aktif" tidak pernah memuat baris restrukturisasi/hapus buku', () => {
    const info = { namaKoperasi: 'KOP Uji', standarAkuntansi: 'SAK_EP' as const };
    const hasil = buildAngsuranExport(info, 'PJ-1', 'Budi', semua.filter(isAngsuranAktif), 'AKTIF');

    // Kolom terakhir = Status (lihat buildAngsuranExport).
    const status = hasil.baris.map((b) => b[b.length - 1]);
    expect(status).not.toContain('DIRESTRUKTURISASI');
    expect(status).not.toContain('DIHAPUSBUKU');
    expect(hasil.baris.length).toBe(3);

    // Total tagihan HANYA dari baris aktif — bukan dari 6 baris mentah.
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Tagihan')?.nilai).toBe('Rp330.000');
  });

  test('TIDAK ADA baris yang muncul di dua kelompok sekaligus (tidak ada duplicate installment)', () => {
    const kelompok = semua.map((j) => ({ id: j.id, k: kelompokkanJadwalAngsuran(j) }));
    const perId = new Map<string, string[]>();
    for (const { id, k } of kelompok) {
      perId.set(id, [...(perId.get(id) ?? []), k]);
    }
    for (const [, daftar] of perId) {
      expect(daftar.length).toBe(1);
    }
    // Jumlah seluruh kelompok = jumlah baris mentah (tidak ada yang hilang
    // maupun terhitung dua kali).
    const total =
      kelompok.filter((x) => x.k === 'AKTIF').length +
      kelompok.filter((x) => x.k === 'AKAD_ULANG').length +
      kelompok.filter((x) => x.k === 'RESTRUKTURISASI').length +
      kelompok.filter((x) => x.k === 'DIHAPUSBUKU').length;
    expect(total).toBe(semua.length);
  });
});
