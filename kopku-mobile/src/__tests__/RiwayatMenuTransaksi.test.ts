import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  HALAMAN_RIWAYAT,
  LABEL_STATUS_RIWAYAT,
  RIWAYAT_MENU,
  kelompokkanRiwayatPerBulan,
  ringkasRiwayat,
  saringStatusRiwayat,
  statusTampilRiwayat,
  tanggalMulaiPeriodeRiwayat,
} from '@/utils/riwayatMenu';
import { JENIS_TRANSAKSI_LABEL } from '@/services/HistoryTransaksiService';

/**
 * RIWAYAT PER MENU TRANSAKSI + PENYEDERHANAAN IMBALAN KERJA.
 *
 * Yang dikunci:
 *  - riwayat per menu HANYA MEMBACA dan mengarah ke Detail History
 *    Transaksi (satu pintu koreksi/pembatalan) — tidak ada aksi koreksi
 *    tersalin ke layar lain;
 *  - setiap `jenis` di konfigurasi benar-benar dipakai service (atau
 *    jenis lama yang masih berlabel), bukan tebakan;
 *  - layar Imbalan Kerja tetap memakai service existing untuk catat & bayar.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

function semuaBerkas(dir: string, ekst: RegExp): string[] {
  const hasil: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) hasil.push(...semuaBerkas(p, ekst));
    else if (ekst.test(f)) hasil.push(p);
  }
  return hasil;
}

describe('konfigurasi riwayat per menu', () => {
  const sumberService = semuaBerkas(join(ROOT, 'src', 'services'), /\.ts$/)
    .concat(semuaBerkas(join(ROOT, 'src', 'accounting'), /\.ts$/))
    .filter((f) => !f.endsWith('HistoryTransaksiService.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  it('setiap jenis dipakai service atau merupakan jenis berlabel di History Transaksi', () => {
    for (const [kunci, k] of Object.entries(RIWAYAT_MENU)) {
      expect(k.jenis.length).toBeGreaterThan(0);
      for (const j of k.jenis) {
        const dipakai = sumberService.includes(`'${j}'`) || j in JENIS_TRANSAKSI_LABEL;
        if (!dipakai) throw new Error(`${kunci}: jenis ${j} tidak ditemukan di service maupun label history`);
      }
    }
  });

  it('periode riwayat dihitung dari tanggal hari ini (lintas tahun benar)', () => {
    expect(tanggalMulaiPeriodeRiwayat('BULAN_INI', '2026-10-04')).toBe('2026-10-01');
    expect(tanggalMulaiPeriodeRiwayat('TIGA_BULAN', '2026-10-04')).toBe('2026-08-01');
    expect(tanggalMulaiPeriodeRiwayat('TIGA_BULAN', '2026-01-15')).toBe('2025-11-01');
    expect(tanggalMulaiPeriodeRiwayat('TAHUN_INI', '2026-10-04')).toBe('2026-01-01');
    expect(tanggalMulaiPeriodeRiwayat('SEMUA', '2026-10-04')).toBeUndefined();
    expect(HALAMAN_RIWAYAT).toBeGreaterThan(0);
  });

  it('ringkasan hanya menjumlah transaksi aktif; pembalik & yang dibatalkan tidak dijumlah', () => {
    const rows = [
      { status: 'POSTED' as const, reversalOfId: null, nominal: 100 },
      { status: 'REVERSED' as const, reversalOfId: null, nominal: 50 },
      { status: 'POSTED' as const, reversalOfId: 'x', nominal: 50 },
    ];
    expect(ringkasRiwayat(rows)).toEqual({ jumlah: 3, totalAktif: 100, jumlahDibatalkan: 1 });
    expect(saringStatusRiwayat(rows, 'DIBATALKAN')).toHaveLength(1);
    expect(saringStatusRiwayat(rows, 'AKTIF')).toHaveLength(2);
  });

  it('dikelompokkan per bulan sesuai urutan terbaru dulu', () => {
    const g = kelompokkanRiwayatPerBulan([{ tanggal: '2026-10-04' }, { tanggal: '2026-10-01' }, { tanggal: '2026-09-30' }]);
    expect(g.map((x) => [x.judul, x.baris.length])).toEqual([['Oktober 2026', 2], ['September 2026', 1]]);
  });

  it('status tampil: dibatalkan / koreksi / draf / aktif', () => {
    expect(statusTampilRiwayat({ status: 'REVERSED', reversalOfId: null })).toBe('DIBATALKAN');
    expect(statusTampilRiwayat({ status: 'VOID', reversalOfId: null })).toBe('DIBATALKAN');
    expect(statusTampilRiwayat({ status: 'POSTED', reversalOfId: 'j-1' })).toBe('PEMBALIK');
    expect(statusTampilRiwayat({ status: 'DRAFT', reversalOfId: null })).toBe('DRAF');
    expect(statusTampilRiwayat({ status: 'POSTED', reversalOfId: null })).toBe('AKTIF');
    expect(LABEL_STATUS_RIWAYAT.DIBATALKAN).toBe('Dibatalkan');
  });
});

describe('komponen RiwayatTransaksiMenu — hanya membaca, satu pintu koreksi', () => {
  const src = tanpaKomentar(baca('src/components/RiwayatTransaksiMenu.tsx'));

  it('membaca lewat listHistoryTransaksi dan membuka Detail History Transaksi', () => {
    expect(src).toMatch(/await listHistoryTransaksi\(\{/);
    expect(src).toMatch(/navigation\.navigate\('HistoryTransaksiDetail', \{ journalId: r\.journalId \}\)/);
  });

  it('tidak memegang aksi koreksi/jurnal/SQL sendiri', () => {
    for (const terlarang of ['batalkanTransaksiHistory', 'createJournal', 'reverseJournal', 'getDb(', 'INSERT ', 'UPDATE ']) {
      expect(src).not.toContain(terlarang);
    }
  });

  it('menghormati izin lihat History Transaksi dan dimuat ulang saat layar fokus', () => {
    expect(src).toMatch(/can\('history_transaksi', 'view'\)/);
    expect(src).toMatch(/useFocusEffect\(/);
  });

  it('rute detail history terdaftar di stack Transaksi (Kembali ke menu asal)', () => {
    const nav = baca('src/navigation/RootNavigator.tsx');
    expect(nav).toMatch(/<TransaksiStack\.Screen name="HistoryTransaksiDetail" component=\{HistoryTransaksiDetailScreen\}/);
    // Pendaftaran Laporan tetap ada.
    expect(nav).toMatch(/<LaporanStack\.Screen name="HistoryTransaksiDetail"/);
  });
});

describe('riwayat terpasang di menu transaksi', () => {
  const PASANG: [string, string][] = [
    // DIPERBARUI RC-S123 (permintaan pengguna): riwayat Setor Simpanan
    // DIPINDAH ke layar Simpanan (lihat test di bawah). Form Setor kini hanya
    // memasang tab pada jalur berjangka.
    ['src/screens/Simpanan/SimpananFormScreen.tsx', 'SIMPANAN_BERJANGKA'],
    ['src/screens/Transaksi/TarikSimpananFormScreen.tsx', 'SIMPANAN_TARIK'],
    ['src/screens/Transaksi/BayarAngsuranFormScreen.tsx', 'ANGSURAN'],
    ['src/screens/Transaksi/BebanFormScreen.tsx', 'BEBAN'],
    ['src/screens/Transaksi/PendapatanLainnyaFormScreen.tsx', 'PENERIMAAN_LAIN'],
    ['src/screens/Transaksi/UtangFormScreen.tsx', 'UTANG'],
    ['src/screens/Transaksi/BayarUtangFormScreen.tsx', 'UTANG'],
    ['src/screens/Transaksi/ModalFormScreen.tsx', 'MODAL'],
    ['src/screens/Transaksi/PembelianAsetFormScreen.tsx', 'PEMBELIAN_ASET'],
    ['src/screens/Transaksi/PenarikanBankFormScreen.tsx', 'PEMINDAHAN_SALDO'],
    ['src/screens/Pinjaman/PenghapusanPiutangFormScreen.tsx', 'PENGHAPUSAN_PIUTANG'],
    ['src/screens/Transaksi/RAKFormScreen.tsx', 'RAKU'],
    ['src/screens/Transaksi/PengembalianRAKFormScreen.tsx', 'PENGEMBALIAN_RAKU'],
    ['src/screens/Transaksi/PelepasanAsetFormScreen.tsx', 'PELEPASAN_ASET'],
    ['src/screens/Transaksi/InvestasiFormScreen.tsx', 'INVESTASI'],
    ['src/screens/Transaksi/PendapatanDimukaFormScreen.tsx', 'PENDAPATAN_DIMUKA'],
    ['src/screens/Transaksi/PendapatanUnitUsahaFormScreen.tsx', 'PENDAPATAN_UNIT_USAHA'],
  ];

  PASANG.forEach(([berkas, menu]) => it(`${berkas} memakai riwayat menu ${menu}`, () => {
    const s = tanpaKomentar(baca(berkas));
    expect(s).toContain("import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';");
    // Tab terpisah "<label menu> | Riwayat" — form disembunyikan saat tab Riwayat aktif.
    expect(s).toMatch(/<TabTransaksi value=\{tabMenu\} onChange=\{setTabMenu\} menu=/);
    expect(s).toMatch(/\{tabMenu === 'RIWAYAT' \? \(\s*<RiwayatTransaksiMenu menu=/);
    expect(s).toMatch(new RegExp(`<RiwayatTransaksiMenu menu=(\\{[^}]*'${menu}'[^}]*\\}|"${menu}")`));
    expect(menu in RIWAYAT_MENU).toBe(true);
  }));
});

describe('RC-S123 — riwayat Setor Simpanan ada di layar Simpanan, bukan di form', () => {
  const layar = tanpaKomentar(baca('src/screens/Simpanan/SimpananHistoriScreen.tsx'));
  const form = tanpaKomentar(baca('src/screens/Simpanan/SimpananFormScreen.tsx'));

  it('layar Simpanan punya segmen Riwayat yang merender panel SIMPANAN_SETOR', () => {
    expect(layar).toContain("import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';");
    expect(layar).toMatch(/\{tampilan === 'RIWAYAT' \? \([\s\S]{0,400}<RiwayatTransaksiMenu menu="SIMPANAN_SETOR" \/>/);
    expect(layar).toContain("['RIWAYAT', 'Riwayat', 'time-outline']");
  });

  it('form Setor Simpanan (jalur REGULER) tidak lagi memuat riwayat setor', () => {
    expect(form).not.toContain('SIMPANAN_SETOR');
    expect(form).toMatch(/\{mode === 'BERJANGKA' && \(\s*<TabTransaksi value=\{tabMenu\} onChange=\{setTabMenu\} menu="SIMPANAN_BERJANGKA" \/>/);
  });

  it('konfigurasi riwayat SIMPANAN_SETOR tidak berubah', () => {
    expect(RIWAYAT_MENU.SIMPANAN_SETOR.jenis).toEqual(['SIMPANAN_POKOK', 'SIMPANAN_WAJIB', 'SIMPANAN_SUKARELA', 'SIMPANAN_DATA_AWAL']);
  });
});

describe('Imbalan Kerja — sederhana, tetap lewat service existing', () => {
  const s = tanpaKomentar(baca('src/screens/Transaksi/ImbalanKerjaFormScreen.tsx'));

  it('dua bagian jelas: Catat Imbalan & Daftar & Bayar', () => {
    expect(s).toContain("['CATAT', 'Catat Imbalan']");
    expect(s).toMatch(/Daftar & Bayar/);
  });

  it('tiga langkah utama; rincian opsional dilipat', () => {
    for (const j of ['judul="Penerima"', 'judul="Jenis Imbalan"', 'judul="Nilai & Tanggal"']) expect(s).toContain(j);
    expect(s).toContain('Rincian tambahan (opsional)');
    expect(s).toMatch(/rincianTerbuka \? \(/);
  });

  it('bayar per baris lewat lembar konfirmasi; sumber dana dipilih di lembar itu', () => {
    expect(s).toMatch(/onPress=\{\(\) => bukaBayar\(row\)\}/);
    expect(s).toMatch(/<Modal visible=\{barisBayar !== null\}/);
    expect(s).toMatch(/await bayarImbalanKerja\(\{/);
  });

  it('catat tetap lewat catatImbalanKerja; nilai bulan lalu lewat app_config service', () => {
    expect(s).toMatch(/await catatImbalanKerja\(\{/);
    expect(s).toMatch(/getNilaiAwalImbalan\(penerimaId, jenisImbalan\)/);
    expect(s).toMatch(/simpanNilaiAwalImbalan\(/);
    for (const t of ['INSERT INTO', 'SELECT ', 'UPDATE ', 'createJournal', 'getDb(']) expect(s).not.toContain(t);
  });

  it('jatuh tempo diturunkan dari tanggal pencatatan (tidak bisa mendahului)', () => {
    expect(s).toMatch(/tambahHariKalender\(tanggalPengakuan, jarakJatuhTempo\)/);
    expect(s).toMatch(/setJarakJatuhTempo\(selisihHariKalender\(tanggalPengakuan, v\)\)/);
  });
});

describe('label tab per menu & mode edit', () => {
  it('setiap menu punya label tab form sendiri (seperti "Pengajuan | Riwayat")', () => {
    for (const [k, v] of Object.entries(RIWAYAT_MENU)) {
      if (!v.labelBaru || String(v.labelBaru) === 'Riwayat') throw new Error(`${k}: labelBaru tidak valid`);
    }
    const tab = tanpaKomentar(baca('src/components/transaksi/TabTransaksi.tsx'));
    expect(tab).toMatch(/RIWAYAT_MENU\[menu\]\.labelBaru/);
  });

  it('mode edit (RAKU, Investasi) menyembunyikan tab — layar fokus pada transaksi yang diubah', () => {
    for (const f of ['src/screens/Transaksi/RAKFormScreen.tsx', 'src/screens/Transaksi/InvestasiFormScreen.tsx']) {
      expect(tanpaKomentar(baca(f))).toMatch(/\{!isEdit && <TabTransaksi /);
    }
  });

  it('Pendapatan Unit Usaha memakai panel riwayat standar (tidak ada daftar ganda)', () => {
    const s = tanpaKomentar(baca('src/screens/Transaksi/PendapatanUnitUsahaFormScreen.tsx'));
    expect(s).not.toContain('listRiwayatPendapatanUnitUsaha');
    expect(s).not.toContain('MAKS_RIWAYAT');
  });

  it('ringkasan panel diberi label jujur: nilai bruto, bukan saldo', () => {
    expect(baca('src/components/RiwayatTransaksiMenu.tsx')).toContain('Nilai transaksi aktif · bukan saldo');
  });
});
