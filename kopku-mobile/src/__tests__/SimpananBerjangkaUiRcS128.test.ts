import { readFileSync } from 'fs';
import { join } from 'path';
import { ringkasanBungaKeSukarela, ringkasanKonfirmasiJatuhTempo } from '@/utils/tarikSimpananUi';

/** RC-S128 — lapisan layar: rute, sumber data cetak, panel "pokok saja". */
const baca = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

const dasar = {
  kontrakId: 'k', nomorTransaksi: 'SPB', pokok: 10_000_000, bungaTerakru: 533_331, totalBungaKontrak: 300_000,
  status: 'JATUH_TEMPO' as const, tanggalMulai: '2026-07-15', tanggalJatuhTempo: '2027-01-15',
  alasanTidakBolehCair: null, catatanKebijakanPenarikanDini: null,
};

test('konfirmasi pencairan kontrak berkebijakan: hanya pokok, tanpa bunga tunai', () => {
  const r = { ...dasar, totalPencairan: 10_000_000, pencairanPokokSaja: true, bungaSudahDiSukarela: 500_000, bungaBelumDipindahkan: 33_331, pphSudahDipotong: 0 };
  expect(ringkasanKonfirmasiJatuhTempo(r)).toEqual([
    { label: 'Pokok Simpanan Berjangka', nilai: 10_000_000, jenis: 'TAMBAH' },
    { label: 'Total diterima tunai', nilai: 10_000_000, jenis: 'TOTAL' },
  ]);
  expect(ringkasanBungaKeSukarela(r).map((b) => b.nilai)).toEqual(['500000', '33331', '0']);
});

test('kontrak lama: bunga tunai hanya yang belum dipindahkan (tidak menghitung ganda)', () => {
  const r = { ...dasar, totalPencairan: 10_100_000, pencairanPokokSaja: false, bungaBelumDipindahkan: 100_000 };
  expect(ringkasanKonfirmasiJatuhTempo(r)[1]).toEqual({ label: 'Bunga', nilai: 100_000, jenis: 'TAMBAH' });
  expect(ringkasanBungaKeSukarela(r)).toEqual([]);
});

test('rute Kebijakan Produk terdaftar dan dapat dijangkau dari form penempatan & detail kontrak', () => {
  expect(baca('navigation/RootNavigator.tsx')).toMatch(/name="KebijakanProdukBerjangka"\s+component=\{KebijakanProdukBerjangkaScreen\}/);
  expect(baca('screens/Simpanan/SimpananFormScreen.tsx')).toMatch(/navigate\('KebijakanProdukBerjangka'\)/);
  expect(baca('screens/Simpanan/SimpananBerjangkaDetailScreen.tsx')).toMatch(/navigate\('KebijakanProdukBerjangka'\)/);
});

test('cetak bukti dari data tersimpan (loader), bukan state layar', () => {
  const s = baca('screens/Simpanan/SimpananBerjangkaDetailScreen.tsx');
  expect(s).toMatch(/getDataBuktiPenempatan\(kontrak\.id\)/);
  expect(s).toMatch(/getDataBuktiPencairan\(kontrak\.id\)/);
  expect(s).toMatch(/Cetak Bukti Penempatan/);
  expect(s).toMatch(/Bunga Pasca Jatuh Tempo/);
  expect(s).toMatch(/Bunga Sudah Masuk Simpanan Sukarela/);
  expect(s).toMatch(/Bunga Belum Dipindahkan/);
});

test('layar Tarik menjelaskan pokok saja; layar kebijakan tidak mengisi rate bawaan', () => {
  expect(baca('screens/Transaksi/TarikSimpananFormScreen.tsx')).toMatch(/hanya POKOK/);
  const k = baca('screens/Simpanan/KebijakanProdukBerjangkaScreen.tsx');
  expect(k).toMatch(/useState\(''\);\n/); // rate dimulai kosong
  expect(k).not.toMatch(/setRate\('\d/);
});
