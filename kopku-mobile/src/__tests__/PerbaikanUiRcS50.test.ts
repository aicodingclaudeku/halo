import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';

/**
 * ============================================================
 * RC-S50 — PERBAIKAN UI & PENYEMPURNAAN MENU
 * ============================================================
 *
 * BATAS YANG DIJAGA SUITE INI.
 *
 * Sepuluh perubahan RC-S50 hampir seluruhnya PRESENTASI: label yang
 * tidak dirender, baris yang berpindah posisi, menu yang dihapus,
 * picker yang menyaring. Risiko terbesarnya bukan tampilan yang salah
 * — itu terlihat dalam sepuluh detik — melainkan perubahan presentasi
 * yang MERAMBAT ke identitas akun, saldo, atau logic otomatis. Kode
 * akun yang "disembunyikan" lalu ikut hilang dari data; urutan baris
 * yang diubah lalu ikut menyaring baris; menu penyusutan yang dihapus
 * lalu ikut mematikan proses otomatisnya.
 *
 * Karena itu setiap assertion di bawah dipasangkan dengan assertion
 * kebalikannya: bukan hanya "tidak tampil", tetapi juga "tetap ada di
 * tempat yang seharusnya".
 *
 * KENAPA STRUKTURAL. `testEnvironment: 'node'` tanpa renderer React
 * Native — layar tidak dapat dirender di sini, jadi sifat presentasi
 * diperiksa pada sumbernya. Sifat yang BUKAN presentasi (isi
 * DEFAULT_ACCOUNTS, daftar filter picker) diuji sungguhan lewat impor.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const posisi = read('src/screens/Laporan/PosisiKeuanganScreen.tsx');
const posisiBersih = tanpaKomentar(posisi);
const menuRincian = read('src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx');
const menuRincianBersih = tanpaKomentar(menuRincian);
const nav = tanpaKomentar(read('src/navigation/RootNavigator.tsx'));

// DIPERBARUI Poin 9/11: daftar urutan & helper penyajian dipindah ke modul
// bersama (dipakai layar DAN export). Invarian tidak berubah; berkasnya saja.
const modulUrutan = read('src/reports/UrutanPenyajianPosisiKeuangan.ts');

/** Urutan penyajian aset, dibaca dari sumber sebagai daftar kode. */
const urutanAset = (() => {
  const blok = modulUrutan.slice(
    modulUrutan.indexOf('const URUTAN_PENYAJIAN_ASET'),
    modulUrutan.indexOf('const URUTAN_PENYAJIAN_EKUITAS')
  );
  return [...blok.matchAll(/'(\d-\d{4})'/g)].map((m) => m[1]);
})();
const posisiKode = (kode: string) => urutanAset.indexOf(kode);

// ============================================================
// §1 — kode akun tidak dirender
// ============================================================
describe('§1 — Laporan Posisi Keuangan hanya menampilkan nama akun', () => {
  it('baris akun TIDAK lagi merender kode akun', () => {
    expect(posisiBersih).not.toMatch(/styles\.rowKode/);
    expect(posisiBersih).not.toMatch(/<Text[^>]*>\{r\.kode\}<\/Text>/);
  });

  it('style rowKode ikut dihapus (tidak meninggalkan gaya mati)', () => {
    expect(posisi).not.toMatch(/\n\s*rowKode:\s*\{/);
  });

  it('nama akun TETAP dirender', () => {
    expect(posisiBersih).toMatch(/<Text style=\{styles\.rowNama\}>\{r\.nama\}<\/Text>/);
  });

  it('kode akun TETAP dipakai secara internal oleh layar', () => {
    // Inilah pemisahan yang harus bertahan: hilang dari MATA pengguna,
    // tetap ada untuk mesin. Kalau `kode` benar-benar dibuang dari
    // data, urutan penyajian & mode komparatif langsung rusak.
    expect(posisiBersih).toMatch(/key=\{`\$\{r\.kode\}-\$\{idx\}`\}/);
    expect(posisiBersih).toMatch(/interface BarisPosisi \{\s*kode: string;/);
    expect(posisiBersih).toMatch(/urutkanUntukPenyajian/);
  });

  it('Neraca Saldo TETAP menampilkan kode akun', () => {
    // §1 dibatasi pada SATU layar. Di Neraca Saldo kode akun justru
    // informasi utamanya (lihat deskripsi menunya sendiri: "Kode akun,
    // debit, kredit, saldo per tanggal").
    expect(read('src/screens/Laporan/NeracaSaldoScreen.tsx')).toMatch(/\.kode/);
    expect(menuRincian).toMatch(/title: 'Neraca Saldo', sub: 'Kode akun/);
  });

  it('export & report engine TIDAK diubah', () => {
    const builders = read('src/export/ReportTableBuilders.ts');
    expect(builders).toMatch(/kode/);
    expect(read('src/reports/FinancialReports.ts')).toMatch(/kode/);
  });
});

// ============================================================
// §5/§6 — urutan penyajian
// ============================================================
describe('§5/§6 — urutan penyajian kelompok ASET', () => {
  it('daftar urutan terbaca dan lengkap', () => {
    expect(urutanAset.length).toBeGreaterThanOrEqual(15);
    for (const kode of ['1-1800', '1-1500', '1-1630', '1-1640', '1-1200']) {
      expect(posisiKode(kode)).toBeGreaterThan(-1);
    }
  });

  it('§5 — Rekening Antar Kantor (1-1800) DI ATAS Aset Tetap (1-1500)', () => {
    expect(posisiKode('1-1800')).toBeLessThan(posisiKode('1-1500'));
  });

  it('§5 — RAK juga di atas Akumulasi Penyusutan & Aset Tak Berwujud', () => {
    expect(posisiKode('1-1800')).toBeLessThan(posisiKode('1-1510'));
    expect(posisiKode('1-1800')).toBeLessThan(posisiKode('1-1700'));
  });

  it('§6 — 1-1630 DI ATAS Piutang Pinjaman Anggota (1-1200)', () => {
    expect(posisiKode('1-1630')).toBeLessThan(posisiKode('1-1200'));
  });

  it('§6 — 1-1640 DI ATAS Piutang Pinjaman Anggota (1-1200)', () => {
    expect(posisiKode('1-1640')).toBeLessThan(posisiKode('1-1200'));
  });

  it('1-1630 tetap mendahului 1-1640 (urutan kode di dalam kelompoknya)', () => {
    expect(posisiKode('1-1630')).toBeLessThan(posisiKode('1-1640'));
  });

  it('urutan ini PRESENTASI SAJA: tidak menyaring & tidak mengubah nilai', () => {
    const fungsi = modulUrutan.slice(modulUrutan.indexOf('function urutkanUntukPenyajian'));
    // Tidak ada filter/slice: jumlah baris keluar == jumlah baris masuk.
    expect(fungsi).not.toMatch(/\.filter\(|\.slice\(/);
    // Tidak menyentuh saldo sama sekali.
    expect(fungsi).not.toMatch(/saldo/);
  });

  it('total tetap dibaca dari hasil service, bukan dijumlah dari baris layar', () => {
    // Ini yang membuat urutan mustahil mengubah angka laporan.
    expect(posisiBersih).toMatch(/data\.totalAset/);
    expect(posisiBersih).not.toMatch(/rows\.reduce\(/);
  });

  it('tidak ada kode akun yang di-hardcode ke dalam perhitungan', () => {
    const setelahKomponen = posisi.slice(posisi.indexOf('export default function PosisiKeuanganScreen'));
    expect(tanpaKomentar(setelahKomponen)).not.toMatch(/'1-1\d{3}'/);
  });
});

// ============================================================
// §2 — Modal: Aset Tetap / Aset Tak Berwujud
// ============================================================
describe('§2 — Modal Barang punya pilihan jenis aset', () => {
  const form = read('src/screens/Transaksi/ModalFormScreen.tsx');
  const service = read('src/services/ModalService.ts');
  const aset = read('src/services/AsetService.ts');

  it('§6 test wajib — ada pilihan "Aset Tetap"', () => {
    expect(form).toMatch(/label="Aset Tetap"/);
    expect(form).toMatch(/setJenisBarang\('TETAP'\)/);
  });

  it('§7 test wajib — ada pilihan "Aset Tak Berwujud"', () => {
    expect(form).toMatch(/label="Aset Tak Berwujud"/);
    expect(form).toMatch(/setJenisBarang\('TAK_BERWUJUD'\)/);
  });

  it('memakai komponen Chip existing, bukan kontrol baru', () => {
    expect(form).toMatch(/<Chip\s+label="Aset Tetap"/);
    expect(form).not.toMatch(/RadioButton|react-native-radio/);
  });

  it('pilihan diteruskan ke service, bukan diputuskan di layar', () => {
    expect(tanpaKomentar(form)).toMatch(/jenisAset: jenisBarang/);
    // Layar tidak boleh mengenal akun/kode akun sama sekali.
    expect(tanpaKomentar(form)).not.toMatch(/resolveAccountId|'1-1500'|'1-1700'/);
  });

  it('service memilih mapping akun EXISTING, tanpa akun/COA baru', () => {
    expect(service).toMatch(/jenisAset === 'TAK_BERWUJUD' \? 'ASET_TAK_BERWUJUD' : 'ASET_TETAP'/);
    // Mapping yang sama sudah dipakai jalur Pembelian Aset.
    expect(aset).toMatch(/input\.jenisAset === 'TAK_BERWUJUD' \? 'ASET_TAK_BERWUJUD' : 'ASET_TETAP'/);
    expect(service).not.toMatch(/'1-1500'|'1-1700'/);
  });

  it('ROOT CAUSE: kolom jenis_aset SUDAH ADA, hanya tidak pernah diisi', () => {
    // Jalur Modal Barang kini menuliskannya — tidak ada kolom/tabel
    // baru, tidak ada migrasi untuk fitur ini.
    expect(aset).toMatch(/sub_kelompok_aset, jenis_aset, aset_klasifikasi_id\)/);
    expect(aset).toMatch(/params\.jenisAset \?\? 'TETAP'/);
  });

  it('klasifikasi aset tetap memakai master existing, bukan daftar kedua', () => {
    expect(form).toMatch(/from '@\/services\/AsetKlasifikasiService'/);
    expect(tanpaKomentar(form)).not.toMatch(/defaultAsetKlasifikasi/);
  });

  it('amortisasi vs penyusutan tetap ditentukan PenyusutanService', () => {
    const peny = read('src/services/PenyusutanService.ts');
    expect(peny).toMatch(/isTakBerwujud \? 'AMORTISASI_ASET_TAK_BERWUJUD' : 'PENYUSUTAN_ASET'/);
  });
});

// ============================================================
// §4 — rename 1-1210
// ============================================================
describe('§4 — akun 1-1210 berganti nama, bukan berganti identitas', () => {
  const akun = DEFAULT_ACCOUNTS.filter((a) => a.kode === '1-1210');

  it('§14 test wajib — kode akun tetap 1-1210 dan hanya ada satu', () => {
    expect(akun).toHaveLength(1);
    expect(akun[0].kode).toBe('1-1210');
  });

  it('§15 test wajib — namanya menjadi "Penyisihan Piutang"', () => {
    expect(akun[0].nama).toBe('Penyisihan Piutang');
  });

  it('kategori & normal balance TIDAK berubah', () => {
    // Kontra-aset: kategori ASET dengan saldo normal KREDIT. Salah satu
    // saja berubah dan Posisi Keuangan langsung salah tanda.
    expect(akun[0].kategori).toBe('ASET');
    expect(akun[0].normalBalance).toBe('KREDIT');
  });

  it('tidak ada variasi nama lain yang tertinggal di DEFAULT_ACCOUNTS', () => {
    const nama = DEFAULT_ACCOUNTS.map((a) => a.nama);
    expect(nama).not.toContain('Penyisihan Piutang Tak Tertagih');
    expect(nama).not.toContain('Penyisihan Piutang Tidak Tertagih');
    expect(nama).not.toContain('Cadangan Piutang');
  });

  it('migrasi rename memakai pola v50: UPDATE nama saja', () => {
    const db = read('src/database/db.ts');
    // KODE saja (komentar dibuang): penjelasan di dalam blok memang
    // MENYEBUT kolom-kolom yang tidak disentuh, jadi memeriksa teks
    // mentah akan salah menandainya sebagai pelanggaran.
    const awal = db.indexOf('if (currentVersion < 59)');
    const blok = tanpaKomentar(db.slice(awal, db.indexOf('await db.runAsync(\'UPDATE schema_meta', awal)));
    expect(blok).toMatch(/UPDATE account SET nama = 'Penyisihan Piutang'/);
    // Difilter pada nama lama: nama yang sudah diubah admin sendiri
    // TIDAK ditimpa.
    expect(blok).toMatch(/WHERE kode = '1-1210' AND nama = 'Penyisihan Piutang Tak Tertagih'/);
    // Identitas akun & mapping tidak boleh disentuh.
    expect(blok).not.toMatch(/SET kode|normal_balance|kategori|account_mapping/);
    // Tidak ada DDL: ini UPDATE DATA, bukan perubahan skema.
    expect(blok).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/);
    // Hanya SATU pernyataan SQL di seluruh blok.
    expect([...blok.matchAll(/db\.runAsync\(/g)]).toHaveLength(1);
  });

  it('impairment & write-off tetap memakai akun yang sama', () => {
    // Keduanya me-resolve akun lewat mapping, bukan lewat nama — itulah
    // sebabnya rename ini aman.
    const imp = read('src/services/LoanImpairmentService.ts');
    expect(imp).toMatch(/resolveAccountId/);
    expect(imp).not.toMatch(/nama = 'Penyisihan/);
  });
});

// ============================================================
// §7 — picker liabilitas
// ============================================================
describe('§7 — 2-1210 & 2-1300 tidak ditawarkan di KewajibanAkunPicker', () => {
  const picker = read('src/components/KewajibanAkunPicker.tsx');
  /**
   * Dibaca dari sumber, bukan diimpor: berkasnya `.tsx` dan
   * `testEnvironment: 'node'` di sini tidak punya transformer JSX
   * (lihat jest.config.js — `testMatch` pun hanya `*.test.ts`).
   * Mengimpornya akan menggagalkan SUITE, bukan assertion-nya.
   */
  const KODE_AKUN_DISEMBUNYIKAN_PICKER = (() => {
    const blok = picker.slice(picker.indexOf('KODE_AKUN_DISEMBUNYIKAN_PICKER: readonly string[] ='));
    return [...blok.slice(0, blok.indexOf(';')).matchAll(/'([\d-]+)'/g)].map((m) => m[1]);
  })();

  it('§16 test wajib — 2-1210 disembunyikan', () => {
    expect(KODE_AKUN_DISEMBUNYIKAN_PICKER).toContain('2-1210');
  });

  it('§17 test wajib — 2-1300 disembunyikan', () => {
    expect(KODE_AKUN_DISEMBUNYIKAN_PICKER).toContain('2-1300');
  });

  it('hanya ketiga akun itu yang disaring', () => {
    // RC-S53 §D — daftar ini BERTAMBAH satu: '2-1710'. Assertion diubah
    // karena PERSYARATANNYA yang berubah (permintaan eksplisit RC-S53),
    // bukan untuk memaksa test lama menjadi hijau. Dua assertion di atas
    // yang menjaga 2-1210 & 2-1300 sengaja dibiarkan utuh, dan §D yang
    // baru menambahkan assertion tersendiri untuk 2-1710 — jadi tidak
    // ada perlindungan lama yang hilang.
    expect([...KODE_AKUN_DISEMBUNYIKAN_PICKER].sort()).toEqual(['2-1210', '2-1300', '2-1710']);
  });

  it('filter benar-benar diterapkan ke daftar yang dirender', () => {
    expect(tanpaKomentar(picker)).toMatch(
      /daftar\.filter\(\(a\) => !KODE_AKUN_DISEMBUNYIKAN_PICKER\.includes\(a\.kode\)\)/
    );
  });

  it('menyaring berdasarkan KODE, bukan nama akun', () => {
    // Nama akun bisa diganti admin; kodenya identitas.
    expect(tanpaKomentar(picker)).not.toMatch(/includes\(a\.nama\)/);
  });

  it('service listAkunKewajiban TIDAK diubah', () => {
    // Filter sengaja di picker: service ini punya test tersendiri dan
    // menjadi sumber kebenaran untuk hal lain.
    const utang = read('src/services/UtangService.ts');
    expect(utang).not.toMatch(/2-1210|2-1300|KODE_AKUN_DISEMBUNYIKAN_PICKER/);
  });

  it('kedua akun TETAP ADA di COA', () => {
    const kode = DEFAULT_ACCOUNTS.map((a) => a.kode);
    expect(kode).toContain('2-1210');
    expect(kode).toContain('2-1300');
  });
});

// ============================================================
// §8/§9/§10 — menu Rincian Laporan Lainnya
// ============================================================
describe('§8/§9/§10 — menu Laporan Rincian Lainnya', () => {
  const entri = [...menuRincianBersih.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
  const rute = [...menuRincianBersih.matchAll(/route: '(\w+)'/g)].map((m) => m[1]);

  it('§18 test wajib — "Jurnal Penyusutan" tidak muncul di menu', () => {
    expect(entri).not.toContain('Jurnal Penyusutan');
    expect(rute).not.toContain('JurnalPenyusutan');
  });

  it('§19 test wajib — "Jurnal Pengakuan Pendapatan" tidak muncul di menu', () => {
    expect(entri).not.toContain('Jurnal Pengakuan Pendapatan');
    expect(rute).not.toContain('JurnalPengakuanDimuka');
  });

  it('§20 test wajib — "Riwayat Pendapatan" tidak muncul di menu', () => {
    expect(entri).not.toContain('Riwayat Pendapatan');
    expect(rute).not.toContain('PendapatanLainnyaList');
  });

  it('§21 test wajib — "Daftar Penyusutan" bukan menu terpisah', () => {
    expect(entri).not.toContain('Daftar Penyusutan');
    expect(rute).not.toContain('PenyusutanList');
  });

  it('§22 test wajib — "Status Periode Penyusutan" bukan menu terpisah', () => {
    expect(entri).not.toContain('Status Periode Penyusutan');
    expect(entri).not.toContain('Status Periode');
  });

  it('§23 test wajib — hanya ada SATU menu aset tetap/penyusutan (entri gabungan)', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #7 (permintaan pengguna): entri "Daftar Aset Tetap" + "Penyusutan Aset" DIGABUNG jadi satu entri; rute StatusPeriode tetap ada & dijangkau dari layar gabungan.
    expect(entri.filter((t) => t === 'Penyusutan Aset')).toHaveLength(0);
    expect(entri.filter((t) => t === 'Daftar Aset Tetap & Penyusutan')).toHaveLength(1);
    expect(rute.filter((r) => r === 'StatusPeriode')).toHaveLength(0);
    expect(rute.filter((r) => r === 'DaftarAsetTetap')).toHaveLength(1);
  });

  it('deskripsinya konsisten dengan gaya menu lain (satu baris, informatif)', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #7 (permintaan pengguna): entri "Daftar Aset Tetap" + "Penyusutan Aset" DIGABUNG jadi satu entri; rute StatusPeriode tetap ada & dijangkau dari layar gabungan.
    const blok = menuRincianBersih.slice(menuRincianBersih.indexOf("title: 'Daftar Aset Tetap & Penyusutan'"));
    expect(blok).toMatch(/sub: 'Rincian aset tetap, akumulasi penyusutan, nilai buku, ringkasan & proses penyusutan'/);
  });

  it('menu lain TIDAK ikut hilang', () => {
    for (const t of [
      'Neraca Saldo',
      'Buku Besar',
      'Daftar Investasi',
      'Daftar Utang',
      'Daftar Aset Tetap & Penyusutan', // DIPERBARUI RC-S54 POST-CLOSURE #7
      'Daftar Pendapatan',
      'Daftar Pendapatan Dimuka',
    ]) {
      expect(entri).toContain(t);
    }
  });

  it('tidak ada entri menu duplikat', () => {
    const kunci = [...menuRincianBersih.matchAll(/route: '(\w+)'[\s\S]{0,200}?title: '([^']+)'/g)].map(
      (m) => `${m[1]}|${m[2]}`
    );
    expect(new Set(kunci).size).toBe(kunci.length);
  });
});

// ============================================================
// §10/§10B — screen gabungan & tidak ada dead route
// ============================================================
describe('§10/§10B — screen gabungan Penyusutan Aset', () => {
  const status = read('src/screens/Akuntansi/StatusPeriodeScreen.tsx');
  const statusBersih = tanpaKomentar(status);

  it('§24 test wajib — rute menu terdaftar & berjudul "Penyusutan Aset"', () => {
    expect(nav).toMatch(
      /<LaporanStack\.Screen name="StatusPeriode" component=\{StatusPeriodeScreen\} options=\{\{ title: 'Penyusutan Aset' \}\}/
    );
  });

  it('screen gabungan menampilkan Status Periode DAN Daftar Aset', () => {
    expect(statusBersih).toMatch(/title="Penyusutan Aset"|Mode Penyusutan/);
    expect(statusBersih).toMatch(/title="Daftar Aset"/);
    expect(statusBersih).toMatch(/<RingkasanPenyusutanAsetList data=\{ringkasanAset\}/);
  });

  it('daftar aset memakai fungsi service YANG SAMA dengan layar lama', () => {
    expect(statusBersih).toMatch(/listRingkasanPenyusutanAset\(\)/);
    expect(read('src/screens/Akuntansi/PenyusutanListScreen.tsx')).toMatch(/listRingkasanPenyusutanAset/);
  });

  it('tidak ada tampilan kartu kedua: keduanya pakai komponen bersama', () => {
    for (const berkas of [
      'src/screens/Akuntansi/StatusPeriodeScreen.tsx',
      'src/screens/Akuntansi/PenyusutanListScreen.tsx',
    ]) {
      expect(read(berkas)).toMatch(/RingkasanPenyusutanAsetList/);
    }
    expect(existsSync(join(ROOT, 'src/screens/Akuntansi/RingkasanPenyusutanAsetList.tsx'))).toBe(true);
  });

  it('tidak ada screen baru yang dibuat untuk menu ini', () => {
    expect(existsSync(join(ROOT, 'src/screens/Akuntansi/PenyusutanAsetScreen.tsx'))).toBe(false);
  });

  it('§10B — rute yang menunya dihapus TIDAK lagi terdaftar (dead route)', () => {
    for (const rute of ['PenyusutanList', 'JurnalPenyusutan', 'JurnalPengakuanDimuka', 'PendapatanLainnyaList']) {
      expect(nav).not.toMatch(new RegExp(`<LaporanStack\\.Screen name="${rute}"`));
    }
  });

  it('berkas screen & service-nya TIDAK dihapus', () => {
    for (const berkas of [
      'src/screens/Akuntansi/PenyusutanListScreen.tsx',
      'src/screens/Akuntansi/JurnalPenyusutanScreen.tsx',
      'src/screens/Akuntansi/JurnalPengakuanDimukaScreen.tsx',
      'src/screens/Transaksi/PendapatanLainnyaListScreen.tsx',
      'src/screens/Transaksi/DaftarPendapatanScreen.tsx',
      'src/services/PendapatanLainnyaService.ts',
      'src/services/PenyusutanService.ts',
      'src/services/PendapatanDimukaService.ts',
    ]) {
      expect(existsSync(join(ROOT, berkas))).toBe(true);
    }
  });

  it('LOGIC OTOMATIS penyusutan & pengakuan TETAP BERJALAN', () => {
    // Inti §8: menu hilang, proses tidak. Keduanya masih dipicu dari
    // layar gabungan (mode MANUAL) dan dari penutupan periode
    // (mode OTOMATIS).
    expect(statusBersih).toMatch(/jalankanPenyusutanPeriode\(periode, currentUser\.id\)/);
    expect(statusBersih).toMatch(/jalankanPengakuanPeriode\(periode, currentUser\.id\)/);
    // PeriodCloseService memakai varian tahun-buku dari service yang
    // sama (mode OTOMATIS: seluruh bulan yang belum diproses dijalankan
    // sebelum periode ditutup).
    expect(read('src/services/PeriodCloseService.ts')).toMatch(
      /jalankanPenyusutanOtomatisUntukTahunBuku/
    );
  });
});

// ============================================================
// §3 — pemicu catch-up akrual dari Detail Anggota
// ============================================================
describe('§3 — Detail Anggota memicu catch-up akrual existing', () => {
  const detail = read('src/screens/Anggota/AnggotaDetailScreen.tsx');
  const detailBersih = tanpaKomentar(detail);
  const catchUp = read('src/services/SimpananBerjangkaCatchUpService.ts');

  it('memakai service catch-up EXISTING, bukan mekanisme kedua', () => {
    expect(detail).toMatch(
      /import \{ jalankanCatchUpAkrualSimpananBerjangka \} from '@\/services\/SimpananBerjangkaCatchUpService';/
    );
    expect(detailBersih).toMatch(/await jalankanCatchUpAkrualSimpananBerjangka\(currentUser\.id\)/);
  });

  it('layar TIDAK membuat jurnal atau menghitung bunga sendiri', () => {
    // §3 eksplisit: tidak ada INSERT jurnal dari screen.
    expect(detailBersih).not.toMatch(/createJournal\(|INSERT INTO journal|postJurnal\(/);
    expect(detailBersih).not.toMatch(/buatJadwalBungaSimpananBerjangka|hitungTotalBungaKontrak/);
    expect(detailBersih).not.toMatch(/resolveAccountId/);
  });

  it('dijalankan saat mount DAN saat layar difokuskan kembali', () => {
    expect(detailBersih).toMatch(/void jalankanCatchUpDanMuat\(\);\s*\n?\s*\/\/|void jalankanCatchUpDanMuat\(\)/);
    expect([...detailBersih.matchAll(/jalankanCatchUpDanMuat\(\)/g)].length).toBeGreaterThanOrEqual(2);
  });

  it('detail tetap dimuat walau catch-up gagal (tidak memblokir layar)', () => {
    const blok = detailBersih.slice(detailBersih.indexOf('const jalankanCatchUpDanMuat'));
    expect(blok.slice(0, 400)).toMatch(/catch \{[\s\S]*?\}\s*\n?\s*\}\s*\n\s*await loadDetail\(\);/);
  });

  it('§8/§10/§13 — kelayakan akrual ditentukan TANGGAL, bukan pembukaan layar', () => {
    // Screen hanya memberi kesempatan eksekusi; periodenya ditentukan
    // perbandingan tanggal terhadap jadwal bunga kontrak.
    const lifecycle = read('src/services/SimpananBerjangkaLifecycleService.ts');
    expect(lifecycle).toMatch(/periodeYangSudahEarned\(jadwal, sampaiTanggal\)/);
    expect(catchUp).toMatch(/const sampaiTanggal = tanggalAcuan \?\? getTanggalLokalHariIni\(\)/);
    // Periode yang sudah pernah diakui dilewati berdasarkan tabel event.
    expect(lifecycle).toMatch(/if \(sudahDiakui\.has\(periode\.nomorPeriode\)\) continue;/);
  });

  it('§11/§12 — idempotensi berlapis mencegah double posting', () => {
    // 1) penjaga in-process: pemicu bersamaan menunggu batch berjalan.
    expect(catchUp).toMatch(/if \(batchBerjalan\) \{/);
    // 2) cek event per periode (di lifecycle, diuji di atas).
    // 3) UNIQUE di database — perlindungan terakhir.
    expect(read('src/database/schema.ts')).toMatch(
      /UNIQUE\s*\(\s*simpanan_berjangka_id\s*,\s*nomor_periode\s*\)/
    );
  });

  it('tidak ada timer yang dijadikan penjadwal akuntansi', () => {
    expect(detailBersih).not.toMatch(/setInterval|setTimeout/);
    expect(tanpaKomentar(catchUp)).not.toMatch(/setInterval|setTimeout/);
  });

  it('pemicu lain yang sudah ada TIDAK diubah', () => {
    expect(read('src/services/StartupTasks.ts')).toMatch(/jalankanCatchUpAkrualSimpananBerjangka\(userId\)/);
    expect(read('src/services/SimpananBerjangkaBackgroundTask.ts')).toMatch(
      /jalankanCatchUpAkrualSimpananBerjangka\(userIdUntukTaskLatar\)/
    );
  });
});

// ============================================================
// REGRESI — batas yang tidak boleh dilewati RC ini
// ============================================================
describe('REGRESI — accounting & security tidak disentuh', () => {
  it('AccountingEngine tidak menyebut satu pun perubahan RC ini', () => {
    const engine = read('src/accounting/AccountingEngine.ts');
    expect(engine).not.toMatch(/RC-S50/);
    expect(engine).not.toMatch(/jenisBarang|KODE_AKUN_DISEMBUNYIKAN_PICKER|Penyusutan Aset/);
  });

  it('Ledger, EIR, impairment, SHU, dan arus kas tidak menyebut RC ini', () => {
    for (const berkas of [
      'src/accounting/Ledger.ts',
      'src/accounting/EffectiveInterestRateService.ts',
      'src/accounting/NonAccrualPolicy.ts',
      'src/accounting/ShuCalculator.ts',
      'src/accounting/CashFlowClassification.ts',
      'src/accounting/SimpananBerjangkaBunga.ts',
    ]) {
      expect(read(berkas)).not.toMatch(/RC-S50/);
    }
  });

  it('formula & urutan laporan SAK EP tidak disentuh', () => {
    expect(read('src/reports/FinancialReports.ts')).not.toMatch(/RC-S50/);
  });

  it('sistem lisensi tidak disentuh', () => {
    for (const berkas of [
      'src/services/LicenseService.ts',
      'src/components/LicenseGate.tsx',
      'src/security/licenseToken.ts',
      'src/security/licenseClock.ts',
    ]) {
      expect(read(berkas)).not.toMatch(/RC-S50/);
    }
  });

  it('migrasi v59 adalah SATU-SATUNYA perubahan database RC ini', () => {
    const db = read('src/database/db.ts');
    const jumlahRcS50 = [...db.matchAll(/RC-S50/g)].length;
    expect(jumlahRcS50).toBeGreaterThan(0);
    // Seluruh penyebutannya berada di dalam blok v59.
    const awalV59 = db.indexOf('if (currentVersion < 59)');
    for (const m of db.matchAll(/RC-S50/g)) {
      expect(m.index!).toBeGreaterThan(awalV59);
    }
  });

  it('tidak ada tabel/kolom baru yang ditambahkan RC ini', () => {
    const schema = read('src/database/schema.ts');
    // MAKSUD assertion ini: RC-S50 tidak menyumbang perubahan skema
    // apa pun. Bentuk lamanya memakukan SCHEMA_VERSION pada angka 59
    // secara harfiah, sehingga migrasi SAH berikutnya (v60, master data
    // identitas koperasi) memutusnya — padahal RC-S50 tetap tidak
    // menyumbang apa-apa. Yang diuji sekarang adalah maksudnya:
    //   1. tidak ada penanda RC-S50 di schema.ts;
    //   2. SCHEMA_VERSION tidak pernah TURUN di bawah 59.
    // Penjaga sesungguhnya tetap test di atas: seluruh penyebutan
    // RC-S50 di db.ts wajib berada di dalam blok v59 — itu tidak
    // dilonggarkan sedikit pun.
    expect(schema).not.toMatch(/RC-S50/);
    const cocok = schema.match(/export const SCHEMA_VERSION = (\d+);/);
    expect(cocok).not.toBeNull();
    expect(Number(cocok![1])).toBeGreaterThanOrEqual(59);
  });
});
