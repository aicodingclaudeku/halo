/**
 * Tarik Simpanan Anggota sebagai pusat seluruh penarikan/pencairan:
 * jenis transaksi berjangka otomatis, ringkasan konfirmasi dari service,
 * dan tidak ada lagi Penarikan Dini / Jatuh Tempo di Pengaturan.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  alokasiPembayaranDini,
  badgeKontrak,
  jenisTransaksiBerjangka,
  ringkasanKonfirmasiDini,
  ringkasanKonfirmasiJatuhTempo,
  tanggalRingkas,
} from '@/utils/tarikSimpananUi';

const ROOT = path.join(__dirname, '..');
const baca = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const settlement = (o: Partial<any> = {}) => ({
  policyVersi: 'v1', pokokBruto: 10_000_000, totalBungaEarned: 300_000, bungaSudahDitransfer: 100_000,
  bungaMasihTerutang: 200_000, bungaAkrualKontrak: 200_000, penyesuaianRate: -50_000, bungaBruto: 150_000,
  bungaHangus: 30_000, bungaSetelahForfeiture: 120_000, penalti: 100_000, biayaAdmin: 25_000,
  penyesuaianPokok: 125_000, penyesuaianBunga: 0, pokokDibayar: 9_875_000, bungaDibayar: 120_000,
  totalPayout: 9_995_000, rateKontrak: 6, rateEfektif: 4, periodeBerjalan: 3, ...o,
}) as any;

describe('jenis transaksi berjangka ditentukan sistem', () => {
  test('dari status kontrak — selaras dengan modeDini (status AKTIF)', () => {
    expect(jenisTransaksiBerjangka('JATUH_TEMPO')).toBe('JATUH_TEMPO');
    expect(jenisTransaksiBerjangka('AKTIF')).toBe('PENARIKAN_DINI');
    expect(jenisTransaksiBerjangka('DICAIRKAN')).toBe('SELESAI');
    expect(jenisTransaksiBerjangka('DIBATALKAN')).toBe('SELESAI');
    const layar = baca('screens/Transaksi/TarikSimpananFormScreen.tsx');
    expect(layar).toMatch(/const modeDini = !!kontrakDipilih && kontrakDipilih\.status === 'AKTIF';/);
    expect(layar).toContain('Jenis transaksi (otomatis)');
  });

  test('badge status kontrak', () => {
    expect(badgeKontrak('JATUH_TEMPO', false).label).toBe('Jatuh Tempo');
    expect(badgeKontrak('AKTIF', true)).toEqual({ label: 'Penarikan Dini', keterangan: 'Sebelum jatuh tempo', nada: 'WARN' });
  });
});

describe('ringkasan konfirmasi = angka service apa adanya', () => {
  test('penarikan dini menampilkan pokok, bunga, bunga hangus, penalti, biaya admin, total', () => {
    const b = ringkasanKonfirmasiDini(settlement());
    expect(b.map((x) => x.label)).toEqual([
      'Pokok', 'Bunga', 'Penyesuaian bunga',
      'Bunga hangus', 'Penalti', 'Biaya administrasi', 'Total diterima anggota',
    ]);
    const total = b.find((x) => x.jenis === 'TOTAL')!;
    expect(total.nilai).toBe(9_995_000);
  });

  test('baris yang ditampilkan menjumlah ke total service (tidak dobel hitung alokasi pokok/bunga)', () => {
    for (const s of [settlement(), settlement({ penyesuaianRate: 0, bungaBruto: 200_000, bungaHangus: 0, bungaSetelahForfeiture: 200_000, penalti: 0, biayaAdmin: 0, penyesuaianPokok: 0, pokokDibayar: 10_000_000, bungaDibayar: 200_000, totalPayout: 10_200_000 })]) {
      const b = ringkasanKonfirmasiDini(s);
      const jumlah = b.filter((x) => x.jenis !== 'TOTAL').reduce((a, x) => a + (x.jenis === 'KURANG' ? -x.nilai : x.nilai), 0);
      expect(jumlah).toBe(s.totalPayout);
      expect(b.some((x) => /Potongan atas/.test(x.label))).toBe(false);
    }
  });

  test('penyesuaian rate 0 tidak ditampilkan; komponen utama tetap tampil walau 0', () => {
    const b = ringkasanKonfirmasiDini(settlement({ penyesuaianRate: 0, penalti: 0 }));
    expect(b.some((x) => x.label === 'Penyesuaian bunga')).toBe(false);
    expect(b.find((x) => x.label === 'Penalti')?.nilai).toBe(0);
  });

  test('alokasi pembayaran dari service', () => {
    expect(alokasiPembayaranDini(settlement())).toEqual({ pokok: 9_875_000, bunga: 120_000 });
  });

  test('jatuh tempo: pokok, bunga, total dari RingkasanPencairan', () => {
    const b = ringkasanKonfirmasiJatuhTempo({
      kontrakId: 'k', nomorTransaksi: 'SB', pokok: 5_000_000, bungaTerakru: 75_000, totalBungaKontrak: 150_000,
      totalPencairan: 5_075_000, status: 'JATUH_TEMPO', tanggalMulai: '2026-01-01', tanggalJatuhTempo: '2026-07-01',
      alasanTidakBolehCair: null, catatanKebijakanPenarikanDini: null,
    });
    expect(b).toEqual([
      { label: 'Pokok', nilai: 5_000_000, jenis: 'TAMBAH' },
      { label: 'Bunga', nilai: 75_000, jenis: 'TAMBAH' },
      { label: 'Total diterima anggota', nilai: 5_075_000, jenis: 'TOTAL' },
    ]);
  });

  test('tanggal ringkas aman untuk string non-ISO', () => {
    expect(tanggalRingkas('2026-12-05')).toBe('5 Des 2026');
    expect(tanggalRingkas('?')).toBe('?');
  });
});

describe('alur konfirmasi di layar', () => {
  const layar = baca('screens/Transaksi/TarikSimpananFormScreen.tsx');
  test('tombol utama membuka konfirmasi; eksekusi lewat handler lama', () => {
    expect(layar).toMatch(/onPress=\{bukaKonfirmasi\}/);
    expect(layar).toMatch(/if \(modeDini\) void submitPencairanDini\(\);\s*else void submitPencairan\(\);/);
    expect(layar).toMatch(/void submit\(\);/);
    expect(layar).toContain("'Konfirmasi Penarikan Dini'");
    expect(layar).toContain("'Konfirmasi Pencairan Jatuh Tempo'");
  });
  test('layar tidak menghitung nominal sendiri', () => {
    expect(layar).not.toMatch(/totalPayout\s*[-+]|pokokBruto\s*[-+]|penalti\s*[-+]\s*\w/);
  });
});

describe('audit: Pengaturan bukan tempat operasional pencairan', () => {
  const layarPengaturan = fs.readdirSync(path.join(ROOT, 'screens/Pengaturan')).map((f) => `screens/Pengaturan/${f}`);

  /**
   * Yang dijaga penjaga ini adalah INTI larangannya: Pengaturan tidak
   * boleh menjadi tempat mengonfigurasi atau menjalankan penarikan dini /
   * pencairan jatuh tempo. Istilah operasional di bawah berlaku untuk
   * SELURUH layar Pengaturan, tanpa kecuali.
   */
  const ISTILAH_OPERASIONAL = /penarikan dini|jatuh tempo|KebijakanPenarikanDini|pencairan|cairkanSimpananBerjangka/i;

  /**
   * Kata "berjangka" sendirian BUKAN istilah operasional — ia juga nama
   * salah satu JENIS DATA koperasi. Layar Import Data Awal (RC-S96) wajib
   * menyebutnya karena Simpanan Berjangka adalah satu dari empat sheet
   * yang diimpor, dan itu tidak membuat Pengaturan menjadi tempat
   * pencairan: layar itu tetap tunduk pada `ISTILAH_OPERASIONAL` di atas,
   * dan test "eksekusi pencairan hanya dari Tarik Simpanan Anggota" di
   * bawah membuktikan ia tidak memanggil fungsi pencairan apa pun.
   */
  const DIKECUALIKAN_KATA_BERJANGKA = ['screens/Pengaturan/ImportDataAwalScreen.tsx'];

  test.each(layarPengaturan)('%s tidak memuat menu/konfigurasi Penarikan Dini / Jatuh Tempo', (rel) => {
    const s = baca(rel);
    expect(s).not.toMatch(ISTILAH_OPERASIONAL);
    if (!DIKECUALIKAN_KATA_BERJANGKA.includes(rel)) {
      expect(s).not.toMatch(/berjangka/i);
    }
  });
  test('rute kebijakan tidak lagi di PengaturanStack', () => {
    const nav = fs.readFileSync(path.join(ROOT, 'navigation/RootNavigator.tsx'), 'utf8');
    expect(nav).not.toMatch(/<PengaturanStack\.Screen\s+name="KebijakanPenarikanDini"/);
    expect(fs.existsSync(path.join(ROOT, 'screens/Pengaturan/KebijakanPenarikanDiniScreen.tsx'))).toBe(false);
  });
  test('eksekusi pencairan hanya dari Tarik Simpanan Anggota', () => {
    const cari = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? cari(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []
      );
    const pemanggil = cari(path.join(ROOT, 'screens')).filter((f) =>
      /cairkanSimpananBerjangka(Dini)?\(/.test(baca(path.relative(ROOT, f)))
    );
    expect(pemanggil.map((f) => path.basename(f))).toEqual(['TarikSimpananFormScreen.tsx']);
  });
});
