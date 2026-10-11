import {
  URUTAN_STATUS_SHU,
  JUMLAH_TAHAP_SHU,
  tahapShu,
  tahapSudahDilewati,
  bolehDiubah,
  JUDUL_MODUL_SHU,
  type StatusShu,
} from '@/reports/StatusShuPlan';

/**
 * RC-S109 — PEMBAGIAN SISA HASIL USAHA: TAHAPAN, PENEMPATAN MENU, DAN
 * BATAS TANGGAL RAT.
 *
 * Tiga permintaan pengguna dikunci di sini:
 *   1. SHU pindah dari menu Laporan ke Transaksi > Pengeluaran, dengan
 *      nama "Pembagian Sisa Hasil Usaha".
 *   2. Kolektibilitas pindah ke Transaksi > Penyesuaian.
 *   3. Tanggal pelaksanaan RAT tidak lagi terkunci pada hari ini,
 *      sehingga RAT tahun berikutnya dapat diisi.
 */

const baca = (rel: string) =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (require('fs') as typeof import('fs')).readFileSync(
    (require('path') as typeof import('path')).join(process.cwd(), rel),
    'utf8'
  );

describe('RC-S109 §A — tahapan pembagian SHU', () => {
  test('lima tahap, urut dari draft sampai dibagikan', () => {
    expect(URUTAN_STATUS_SHU).toEqual(['DRAFT', 'DIHITUNG', 'DIAJUKAN_RAT', 'DISAHKAN_RAT', 'DIBAGIKAN']);
    expect(JUMLAH_TAHAP_SHU).toBe(5);
  });

  test('setiap status punya tahap bernomor, label, dan tindakan lanjutan', () => {
    for (const st of URUTAN_STATUS_SHU) {
      const t = tahapShu(st);
      expect(t.nomor).toBeGreaterThanOrEqual(1);
      expect(t.nomor).toBeLessThanOrEqual(JUMLAH_TAHAP_SHU);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.labelPendek.length).toBeGreaterThan(0);
      // Tindakan harus benar-benar menerangkan, bukan sekadar terisi.
      expect(t.tindakan.length).toBeGreaterThan(20);
    }
  });

  test('nomor tahap unik dan berurutan', () => {
    const nomor = URUTAN_STATUS_SHU.map((s) => tahapShu(s).nomor);
    expect(nomor).toEqual([1, 2, 3, 4, 5]);
  });

  test('hanya tahap terakhir yang ditandai selesai', () => {
    for (const st of URUTAN_STATUS_SHU) {
      expect(tahapShu(st).selesai).toBe(st === 'DIBAGIKAN');
    }
  });

  test('penanda langkah: tahap sebelum & sama dengan status sekarang dianggap lewat', () => {
    expect(tahapSudahDilewati('DRAFT', 'DIAJUKAN_RAT')).toBe(true);
    expect(tahapSudahDilewati('DIAJUKAN_RAT', 'DIAJUKAN_RAT')).toBe(true);
    expect(tahapSudahDilewati('DISAHKAN_RAT', 'DIAJUKAN_RAT')).toBe(false);
    expect(tahapSudahDilewati('DIBAGIKAN', 'DRAFT')).toBe(false);
  });

  test('DIBAGIKAN final — tidak boleh diubah; selain itu boleh', () => {
    for (const st of URUTAN_STATUS_SHU) {
      expect(bolehDiubah(st)).toBe(st !== 'DIBAGIKAN');
    }
  });

  test('istilah modul dipakai satu sumber, bukan ditulis ulang per layar', () => {
    expect(JUDUL_MODUL_SHU).toBe('Pembagian Sisa Hasil Usaha');
    const layar = baca('src/screens/Shu/ShuScreen.tsx');
    expect(layar).toMatch(/JUDUL_MODUL_SHU/);
    // Label status tidak lagi disalin ke layar.
    expect(layar).not.toMatch(/const STATUS_LABEL/);
  });
});

describe('RC-S109 §B — penempatan menu', () => {
  test('SHU ada di Transaksi > Pengeluaran dengan nama barunya', () => {
    const src = baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx');
    expect(src).toMatch(/title: 'Pembagian Sisa Hasil Usaha'/);
    expect(src).toMatch(/nav\.navigate\('Shu'\)/);
  });

  test('Kolektibilitas ada di Transaksi > Penyesuaian', () => {
    const src = baca('src/screens/Transaksi/PenyesuaianScreen.tsx');
    expect(src).toMatch(/route: 'KolektibilitasPiutang'/);
  });

  test('keduanya TIDAK lagi muncul di menu Laporan — satu pintu masuk saja', () => {
    const src = baca('src/screens/Laporan/LaporanScreen.tsx');
    // Yang diperiksa adalah ENTRI MENU (baris `route:`), bukan kata
    // dalam komentar penjelas — jebakan yang sudah beberapa kali
    // membuat penjaga struktural memeriksa prosa.
    const entri = [...src.matchAll(/route: '([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(entri).not.toContain('Shu');
    expect(entri).not.toContain('KolektibilitasPiutang');
    // Dan menu Laporan tetap memuat kelima laporan keuangan utama.
    for (const r of ['PosisiKeuangan', 'LabaRugi', 'PerubahanEkuitas', 'ArusKas', 'Calk']) {
      expect(entri).toContain(r);
    }
  });

  test('rute terdaftar di stack Transaksi, bukan cuma di stack Laporan', () => {
    const nav = baca('src/navigation/RootNavigator.tsx');
    for (const rute of ['Shu', 'ShuForm', 'ShuDetail', 'ShuAnggotaDetail', 'KolektibilitasPiutang']) {
      expect(nav).toMatch(new RegExp(`<TransaksiStack\\.Screen[\\s\\S]{0,120}name="${rute}"`));
    }
  });

  test('judul layar memakai istilah baru, bukan singkatan SHU saja', () => {
    const nav = baca('src/navigation/RootNavigator.tsx');
    expect(nav).not.toMatch(/name="Shu" component=\{ShuScreen\} options=\{\{ title: 'SHU' \}\}/);
    expect(nav).toMatch(/title: 'Pembagian Sisa Hasil Usaha'/);
  });
});

describe('RC-S109 §C — tanggal pelaksanaan RAT', () => {
  const src = baca('src/screens/Shu/ShuDetailScreen.tsx');

  test('batas atas TIDAK lagi hari ini — RAT tahun berikutnya dapat diisi', () => {
    const kode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(kode).not.toMatch(/maximumDate=\{getWaktuSekarang\(\)\}/);
    expect(kode).toMatch(/minimumDate=\{new Date\(Date\.UTC\(tahunBuku, 0, 1\)\)\}/);
    expect(kode).toMatch(/maximumDate=\{new Date\(Date\.UTC\(tahunBuku \+ 2, 11, 31\)\)\}/);
  });

  test('GERBANG pembagian TIDAK dilonggarkan — tanggal RAT harus sudah tiba', () => {
    expect(src).toMatch(/ratSudahLewat\s*=\s*!!rat && hariIni >= rat\.tanggalRat/);
  });

  test('service RAT tetap tidak membatasi tahun — pembatasan hanya soal salah ketik di layar', () => {
    const svc = baca('src/services/RATService.ts');
    expect(svc).toMatch(/Tanggal pelaksanaan RAT wajib diisi/);
    expect(svc).not.toMatch(/tidak boleh melewati hari ini/i);
  });
});
