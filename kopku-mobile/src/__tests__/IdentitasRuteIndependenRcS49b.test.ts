import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * ============================================================
 * RC-S49b §B — IDENTITAS KOPERASI SEBAGAI DESTINATION INDEPENDEN
 * ============================================================
 *
 * ROOT CAUSE YANG DITUTUP.
 *
 * `IdentitasKoperasi` terdaftar di `PengaturanStack`. Satu keputusan
 * itu menghasilkan tiga gejala yang tampak tidak berhubungan:
 *
 *   1. Membuka Identitas dari Dashboard MEMINDAHKAN tab Pengaturan ke
 *      layar lain — efek samping yang tidak pernah diminta.
 *   2. Back dari Identitas mendarat di menu Pengaturan, layar yang
 *      tidak pernah dibuka pengguna.
 *   3. Untuk menambal (1) dan (2), layar itu perlu parameter `asal`,
 *      `headerLeft` sendiri, dan `BackHandler` sendiri.
 *
 * Ketiganya hilang begitu rutenya dipindah ke `RootStack`, sejajar
 * dengan `Tabs`. Suite ini menjaga agar ia TIDAK pernah kembali
 * bersarang di dalam salah satu tab.
 *
 * SATU LAYAR, SATU IMPLEMENTASI (§B2). Yang dipindah HANYA
 * pendaftaran rutenya — bukan salinan layar, bukan service kedua.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const nav = tanpaKomentar(read('src/navigation/RootNavigator.tsx'));
const dashboard = tanpaKomentar(read('src/screens/Dashboard/DashboardScreen.tsx'));

/** Seluruh pendaftaran rute: [namaStack, namaRute]. */
const pendaftaran = [...nav.matchAll(/<(\w+)Stack\.Screen\s+name="(\w+)"/g)].map((m) => ({
  stack: m[1],
  rute: m[2],
}));

// ============================================================
// §B1 — rute independen
// ============================================================
describe('§B1 — Identitas Koperasi bukan anak Pengaturan', () => {
  it('terdaftar di RootStack', () => {
    const identitas = pendaftaran.filter((r) => r.rute === 'IdentitasKoperasi');
    expect(identitas).toHaveLength(1);
    expect(identitas[0].stack).toBe('Root');
  });

  it('TIDAK terdaftar di stack tab mana pun', () => {
    for (const stack of ['Pengaturan', 'Anggota', 'Transaksi', 'Laporan']) {
      expect(pendaftaran.some((r) => r.stack === stack && r.rute === 'IdentitasKoperasi')).toBe(false);
    }
  });

  it('RootStack berisi tepat: pembungkus tab dan Identitas', () => {
    // Kalau stack ini lama-lama menjadi tempat pembuangan rute, ia
    // berhenti bermakna. Batasnya dijaga eksplisit.
    //
    // DIPERBARUI RESTRUKTURISASI DATA: keempat master (PersonelKoperasi,
    // PerizinanKoperasi, UnitUsahaKoperasi, PeraturanInternal) DIPINDAH ke
    // AnggotaStack (tab Data) dan registrasinya di RootStack dihapus.
    // Syarat keanggotaan RootStack yang dijaga test ini justru yang
    // MEMAKSA pemindahan itu: rute master dulu boleh di sini KARENA
    // hanya dibuka dari layar Identitas. Setelah enam pintasan di
    // IdentitasKoperasiScreen dihapus, syarat itu tidak lagi terpenuhi,
    // jadi rutenya harus ikut pindah — bukan dibiarkan menganggur.
    const isi = pendaftaran.filter((r) => r.stack === 'Root').map((r) => r.rute);
    expect(isi).toEqual(['Tabs', 'IdentitasKoperasi']);

    // Konsekuensi yang dijaga: layar Identitas tidak lagi menavigasi ke
    // master mana pun, dan keempatnya kini hidup di AnggotaStack.
    const layarIdentitas = tanpaKomentar(read('src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'));
    const MASTER_DIPINDAH = ['PersonelKoperasi', 'PerizinanKoperasi', 'UnitUsahaKoperasi', 'PeraturanInternal'];
    for (const rute of MASTER_DIPINDAH) {
      expect(layarIdentitas).not.toContain(`navigate('${rute}'`);
      const daftar = pendaftaran.filter((r) => r.rute === rute);
      expect(daftar).toHaveLength(1); // tidak ada registrasi ganda
      expect(daftar[0].stack).toBe('Anggota');
    }
  });
});

// ============================================================
// §B3 — tidak ada tabrakan rute
// ============================================================
describe('§B3 — navigasi stabil, tanpa ambiguitas nama rute', () => {
  it('nama rute RootStack tidak bertabrakan dengan rute di dalam tab', () => {
    // Nama yang sama di dua level akan membuat `navigate()` bergantung
    // pada dari mana ia dipanggil — persis jenis ambiguitas yang
    // membuat "layar tertukar".
    const diRoot = pendaftaran.filter((r) => r.stack === 'Root').map((r) => r.rute);
    const diTab = pendaftaran.filter((r) => r.stack !== 'Root').map((r) => r.rute);
    for (const rute of diRoot) {
      expect(diTab).not.toContain(rute);
    }
  });

  it('nama tab tidak bertabrakan dengan nama rute RootStack', () => {
    const namaTab = [...nav.matchAll(/<Tab\.Screen name="(\w+)"/g)].map((m) => m[1]);
    const diRoot = pendaftaran.filter((r) => r.stack === 'Root').map((r) => r.rute);
    for (const t of namaTab) expect(diRoot).not.toContain(t);
  });

  it('Dashboard tetap Tab.Screen langsung (tidak dibungkus stack baru)', () => {
    // Dashboard satu-satunya layar tanpa header stack; membungkusnya
    // akan menambah header ganda dan mengubah inset atas.
    expect(nav).toMatch(/<Tab\.Screen name="Dashboard" component=\{DashboardScreen\}/);
  });

  it('kelima tab tetap utuh', () => {
    const namaTab = [...nav.matchAll(/<Tab\.Screen name="(\w+)"/g)].map((m) => m[1]);
    expect(namaTab).toEqual(['Dashboard', 'Anggota', 'Transaksi', 'Laporan', 'Pengaturan']);
  });
});

// ============================================================
// §B5 — Dashboard sebagai pintu masuk
// ============================================================
describe('§B5 — Dashboard membuka rute independen', () => {
  it('memakai navigate langsung, tanpa navigasi bersarang', () => {
    expect(dashboard).toMatch(/navigation\.navigate\('IdentitasKoperasi'\)/);
    expect(dashboard).not.toMatch(/screen: 'IdentitasKoperasi'/);
  });

  it('tidak ada reset/replace yang membuang riwayat', () => {
    expect(dashboard).not.toMatch(/navigation\.(reset|replace)\(/);
  });
});

// ============================================================
// §B2/§B4 — tidak ada duplikasi, tidak ada yang dihapus
// ============================================================
describe('§B2/§B4 — satu layar, satu implementasi, data utuh', () => {
  it('berkas layar TIDAK dihapus dan tidak ada salinannya', () => {
    expect(existsSync(join(ROOT, 'src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'))).toBe(true);
    for (const salinan of [
      'src/screens/Pengaturan/IdentitasKoperasiScreen2.tsx',
      'src/screens/Dashboard/IdentitasKoperasiScreen.tsx',
    ]) {
      expect(existsSync(join(ROOT, salinan))).toBe(false);
    }
    expect(nav).not.toMatch(/IdentitasKoperasiDashboard|IdentitasKoperasiSettings/);
  });

  it('navigator mengimpor komponen yang SAMA, bukan komponen baru', () => {
    expect(nav).toMatch(
      /import IdentitasKoperasiScreen from '@\/screens\/Pengaturan\/IdentitasKoperasiScreen';/
    );
  });

  it('service identitas TIDAK dihapus', () => {
    const setup = read('src/services/SetupService.ts');
    expect(setup).toMatch(/export async function getIdentitasKoperasi/);
    expect(setup).toMatch(/export async function updateIdentitasKoperasi/);
  });

  it('layar tetap memakai service itu, tanpa SQL sendiri', () => {
    const identitas = tanpaKomentar(read('src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'));
    expect(identitas).toMatch(/updateIdentitasKoperasi\(\{/);
    expect(identitas).not.toMatch(/UPDATE\s+koperasi|INSERT INTO|postJurnal\(/);
  });
});

// ============================================================
// §B6/§M — menu Pengaturan tidak ikut rusak
// ============================================================
describe('§B6/§M — seluruh menu Pengaturan tetap dapat dibuka', () => {
  const pengaturan = tanpaKomentar(read('src/screens/Pengaturan/PengaturanScreen.tsx'));
  const ruteMenu = [...pengaturan.matchAll(/route: '(\w+)'/g)].map((m) => m[1]);
  const ruteStackPengaturan = pendaftaran.filter((r) => r.stack === 'Pengaturan').map((r) => r.rute);

  it('menu yang ditampilkan sesuai target UX RC-S49b', () => {
    // DIPERBARUI (sentralisasi Tarik Simpanan Anggota — instruksi eksplisit pengguna: Kebijakan Penarikan Dini tidak lagi di Pengaturan).
    // DIPERBARUI RC-S96: 'ImportDataAwal' (import Excel data awal) ditambahkan
    // tepat setelah Backup & Restore — keduanya operasi data massal, dan
    // langkah yang disarankan sebelum import adalah membuat backup.
    // DIPERBARUI RC-S99: 'ResetData' ditambahkan sebagai entri TERAKHIR.
    // Ia ada di array MENU (jadi tetap melewati `can()`), tetapi dirender
    // di bagian "Zona Berbahaya" tersendiri di paling bawah layar lewat
    // penanda `danger: true` — sengaja dijauhkan dari kartu menu
    // sehari-hari, dan izinnya diperiksa pada level 'approve' (setara
    // restore, tindakan paling berisiko yang sudah ada).
    // DIPERBARUI KOPKU Desktop: 'SinkronPerangkat' (pasangkan HP⇄Desktop lewat QR,
    // sinkron Wi-Fi lokal) tepat setelah Backup & Restore — operasi data massal.
    // DIPERBARUI RC-S133.4.8: 'AsistenClaude' setelah Sinkron HP.
    // DIPERBARUI RC-S133.5: fitur Asisten Claude DIHAPUS atas permintaan pengguna
    // (9 Okt 2026) — menu kembali seperti sebelum RC-S133.4.8.
    expect(ruteMenu).toEqual(['BackupRestore', 'SinkronPerangkat', 'ImportDataAwal', 'UserManagement', 'PermissionMatrix', 'ResetData']);
  });

  it('setiap entri menu punya rute terdaftar di PengaturanStack', () => {
    for (const rute of ruteMenu) {
      expect(ruteStackPengaturan).toContain(rute);
    }
  });

  it('tidak ada rute PengaturanStack yang hilang selain Identitas', () => {
    expect(ruteStackPengaturan).toEqual([
      'PengaturanMenu',
      'BackupRestore',
      'UserManagement',
      'UserForm',
      // DIPERBARUI RC-S133.5 — 'AkunAnggotaMassal' (User Management › Buat akun
      // semua anggota), dibuka dari layar User Management, bukan dari MENU.
      'AkunAnggotaMassal',
      'PermissionMatrix',
      // RC-S96 — 'ImportDataAwal' (import Excel data awal). Terdaftar di
      // PengaturanStack DAN masuk array MENU (lihat `ruteMenu` di atas),
      // jadi ia melewati `can()` seperti submenu Pengaturan lainnya —
      // berbeda dari 'Developer'/'Lisensi' di bawah yang gerbangnya bukan
      // permission role. Urutannya di sini mengikuti urutan pendaftaran
      // rute di RootNavigator, bukan urutan kartu di layar.
      'ImportDataAwal',
      // DIPERBARUI RC-S103 — 'SaldoAwalAkunList' didaftarkan juga di stack
      // Pengaturan. Layar Import Data Awal menutup alurnya dengan tombol
      // menuju layar ini: setelah saldo awal pinjaman/simpanan masuk
      // sebagai buku pembantu, sisi buku besarnya harus diisi di sana, dan
      // tanpa pendaftaran ini navigasinya gagal karena rute yang sama
      // sebelumnya hanya ada di stack Anggota & Transaksi. Komponennya
      // SAMA (bukan salinan), jadi tidak ada layar atau logika berganda.
      'SaldoAwalAkunList',
      // RC-S97 — 'StrukturTemplate' (isi template Excel ditampilkan di
      // dalam aplikasi). Terdaftar di PengaturanStack tetapi SENGAJA tidak
      // masuk array MENU: pintu masuknya tombol "Lihat Struktur" di layar
      // Import Data Awal, tempat pengguna memang sedang membutuhkannya —
      // pola yang sama dengan rute turunan lain (mis. 'UserForm').
      'StrukturTemplate',
      // RC-S100 — 'RiwayatImport' (log hasil import data awal: berhasil &
      // gagal). Terdaftar di PengaturanStack tetapi SENGAJA tidak masuk
      // array MENU: pintu masuknya ikon di pojok kanan atas layar Import
      // Data Awal — pola yang sama dengan 'StrukturTemplate' di atas.
      'RiwayatImport',
      // RC-S99 — 'ResetData' (hapus data transaksi / reset total).
      // Terdaftar di PengaturanStack DAN masuk array MENU seperti
      // 'ImportDataAwal', jadi ia melewati `can()`; yang membedakannya
      // hanya level izin ('approve') dan penempatannya di Zona Berbahaya.
      'ResetData',
      // 'Developer' (mode pengujian waktu, dikunci password) ditambahkan
      // di luar array MENU — pola yang sama dengan 'Lisensi' (lihat test
      // "menu Lisensi tetap lewat expo-router" di bawah): rutenya
      // terdaftar di PengaturanStack, tapi kartunya sengaja tidak masuk
      // hitungan `ruteMenu`/`can()` karena gerbangnya password, bukan
      // permission role.
      'Developer',
      // RC-S121 — 'Keamanan' (PIN kunci aplikasi & login biometric),
      // dipindah dari isi layar PengaturanMenu. Pola sama dengan
      // 'Developer': terdaftar di PengaturanStack, kartunya di luar array
      // MENU karena sejak awal tidak digerbangi permission role.
      'Keamanan',
      // KOPKU Desktop — 'SinkronPerangkat' (sinkron HP⇄Desktop via QR & Wi-Fi lokal).
      'SinkronPerangkat',
      // RC-S133.4.8 'AsistenClaude' — DIHAPUS RC-S133.5 (fitur Claude dicabut).
    ]);
    // DIPERBARUI: KebijakanPenarikanDini pindah ke TransaksiStack.
    expect(pendaftaran.filter((r) => r.stack === 'Transaksi').map((r) => r.rute)).toContain('KebijakanPenarikanDini');
  });

  it('menu Lisensi tetap lewat expo-router, tidak dipindah', () => {
    expect(pengaturan).toMatch(/router\.push\('\/license'\)/);
  });
});
