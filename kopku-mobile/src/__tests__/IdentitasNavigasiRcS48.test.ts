import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_ROLE_PERMISSIONS, ROLES, Role } from '@/config/defaultPermissions';
import { evaluasiIzin } from '@/security/permissions';

/**
 * ============================================================
 * IDENTITAS KOPERASI: RUTE INDEPENDEN, MENU, DAN TUJUAN KEMBALI
 * ============================================================
 *
 * DIPERBARUI RC-S49b. Berkas ini semula mengunci arsitektur RC-S48, di
 * mana `IdentitasKoperasi` hidup di dalam `PengaturanStack`. RC-S49b
 * memindahkannya ke `RootStack` sebagai destination independen, jadi
 * assertion yang dulu menjaga struktur lama sekarang menjaga struktur
 * baru — bukan dihapus, melainkan dibalik arahnya. Bagian yang TIDAK
 * berubah (permission, alur Simpan, larangan menyentuh skema/jurnal)
 * dibiarkan apa adanya.
 *
 * KENAPA RC-S48 SENDIRI TIDAK CUKUP (catatan sejarah dipertahankan):
 *
 * DUA BUG YANG DITUTUP.
 *
 * 1. Route `IdentitasKoperasi` terdaftar di PengaturanStack, layarnya
 *    ada, servicenya jalan — tetapi `PengaturanScreen.tsx` tidak punya
 *    satu pun entri menu ke sana. Satu-satunya jalan masuk adalah kartu
 *    Dashboard. Kelas bug yang sama dengan `SimpananBerjangkaHistori`
 *    pada RC-S45: yang hilang bukan kodenya, melainkan jalan masuknya.
 *
 * 2. RC-S47 hanya mengatur tujuan SETELAH Simpan. Tombol Back tidak
 *    disentuh, sehingga pengguna yang datang dari Dashboard mendarat di
 *    menu Pengaturan — layar yang tidak pernah ia buka — begitu ia
 *    menekan Back sebelum sempat menyunting apa pun.
 *
 * KENAPA CAMPURAN STRUKTURAL + FUNGSIONAL.
 * Visibilitas menu bergantung pada matrix permission yang merupakan
 * DATA, jadi ia diuji secara fungsional terhadap
 * `DEFAULT_ROLE_PERMISSIONS` & `evaluasiIzin()` yang sebenarnya — bukan
 * dengan membaca sumber. Sebaliknya "tombol back memanggil tujuan yang
 * benar" adalah sifat sumber: layar tidak dapat dirender di lingkungan
 * ini (`testEnvironment: 'node'`, tanpa renderer React Native).
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const nav = tanpaKomentar(read('src/navigation/RootNavigator.tsx'));
const pengaturan = tanpaKomentar(read('src/screens/Pengaturan/PengaturanScreen.tsx'));
const identitas = tanpaKomentar(read('src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'));
const dashboard = tanpaKomentar(read('src/screens/Dashboard/DashboardScreen.tsx'));

const semuaRute = [...nav.matchAll(/<\w+Stack\.Screen\s+name="(\w+)"/g)].map((m) => m[1]);

/** Blok entri MENU pada PengaturanScreen. */
const blokMenu = pengaturan.slice(pengaturan.indexOf('const MENU'), pengaturan.indexOf('export default function'));

// ============================================================
// RC-S49b §B1 — IDENTITAS BUKAN LAGI SUBMENU PENGATURAN
// ============================================================
describe('§B1 — Identitas Koperasi dipisahkan dari menu Pengaturan', () => {
  it('TIDAK ada lagi entri Identitas di menu Pengaturan', () => {
    expect(blokMenu).not.toMatch(/route: 'IdentitasKoperasi'/);
    expect(blokMenu).not.toMatch(/title: 'Identitas Koperasi'/);
    expect(blokMenu).not.toMatch(/testID: 'pengaturan-identitas-koperasi'/);
  });

  it('menu Pengaturan yang lain TIDAK ikut hilang', () => {
    // Regresi yang paling mahal dari pekerjaan ini adalah menu
    // Pengaturan yang ikut rusak saat Identitas dicabut.
    // DIPERBARUI (sentralisasi Tarik Simpanan Anggota — instruksi eksplisit pengguna: Kebijakan Penarikan Dini tidak lagi di Pengaturan).
    for (const rute of ['BackupRestore', 'UserManagement', 'PermissionMatrix']) {
      expect(blokMenu).toContain(`route: '${rute}'`);
    }
    expect(blokMenu).not.toContain("route: 'KebijakanPenarikanDini'");
    expect(pengaturan).toMatch(/router\.push\('\/license'\)/);
  });

  it('TIDAK membuat resource permission baru', () => {
    const resources = read('src/config/defaultPermissions.ts');
    expect(resources).not.toMatch(/'identitas'/);
    expect(blokMenu).not.toMatch(/resource: 'identitas'/);
  });

  it('§C — menu Pengaturan tetap menavigasi di dalam stack-nya sendiri', () => {
    expect(pengaturan).toMatch(/onPress=\{\(\) => navigation\.navigate\(item\.route\)\}/);
    expect(pengaturan).not.toMatch(/navigate\('Pengaturan', \{ screen: 'IdentitasKoperasi'/);
  });
});

describe('§L/§R — rute identitas tetap tunggal', () => {
  it('terdaftar TEPAT satu kali di seluruh navigator', () => {
    expect(semuaRute.filter((r) => r === 'IdentitasKoperasi')).toHaveLength(1);
  });

  it('RC-S49b — terdaftar di RootStack, BUKAN di PengaturanStack', () => {
    // Inti perbaikannya: rutenya berdiri sejajar dengan `Tabs`, bukan
    // sebagai anak salah satu tab. Selama ini benar, membuka Identitas
    // secara struktural TIDAK MUNGKIN memindahkan tab Pengaturan.
    expect(nav).toMatch(/<RootStack\.Screen\s+name="IdentitasKoperasi"/);
    expect(nav).not.toMatch(/<PengaturanStack\.Screen name="IdentitasKoperasi"/);
    const blok = nav.slice(nav.indexOf('<RootStack.Screen'));
    expect(blok).toMatch(/title: 'Identitas Koperasi'/);
  });

  it('RC-S49b — `Tabs` membungkus Tab.Navigator tanpa header tambahan', () => {
    // `headerShown: false` menjaga Dashboard tetap tampil persis
    // seperti sebelumnya (ia satu-satunya layar tanpa header stack).
    expect(nav).toMatch(/<RootStack\.Screen name="Tabs" component=\{TabNavigator\} options=\{\{ headerShown: false \}\}/);
    expect(nav).toMatch(/<Tab\.Screen name="Dashboard" component=\{DashboardScreen\}/);
  });

  it('tidak ada layar identitas kedua yang dibuat', () => {
    expect(nav).not.toMatch(/IdentitasKoperasiDashboard|IdentitasKoperasiSettings/);
  });

  it('§B5 — Dashboard membuka rute independen LANGSUNG', () => {
    expect(dashboard).toMatch(/navigation\.navigate\('IdentitasKoperasi'\)/);
    // Navigasi bersarang lewat tab Pengaturan tidak boleh ada lagi:
    // itulah yang dulu memindahkan state tab Pengaturan.
    expect(dashboard).not.toMatch(/navigate\('Pengaturan', \{/);
    expect(dashboard).not.toMatch(/asal: 'DASHBOARD'/);
  });
});

// ============================================================
// §O — visibilitas menu mengikuti permission yang sebenarnya
// ============================================================
describe('§O — visibilitas menu ditentukan permission existing', () => {
  /**
   * Ini menguji DATA-nya, bukan sumbernya: entri menu memakai
   * `resource: 'pengaturan'` dan layar memfilter dengan
   * `can(item.resource, 'view')`, jadi visibilitasnya persis sama
   * dengan `evaluasiIzin(permissions.pengaturan, 'view')`.
   */
  const bolehLihat = (role: Role) =>
    evaluasiIzin(DEFAULT_ROLE_PERMISSIONS[role].pengaturan, 'view');

  it('filter layar memang memakai usePermission, tidak di-bypass', () => {
    expect(pengaturan).toMatch(/const \{ can \} = usePermission\(\)/);
    // DIPERBARUI RC-S99. Pemanggilan `can()` kini lewat satu helper
    // `bolehLihat` karena entri menu boleh menentukan LEVEL izin yang
    // diperiksa (`item.aksi`, default 'view') — dibutuhkan agar "Reset
    // Data" hanya tampil pada level 'approve', bukan ikut muncul karena
    // sebuah role boleh MELIHAT modul backup. Yang dijaga test ini tetap
    // sama: visibilitas menu ditentukan `can()` dari `usePermission`,
    // bukan di-bypass. Default 'view' dipastikan masih ada di regex.
    expect(pengaturan).toMatch(/can\(item\.resource, item\.aksi \?\? 'view'\)/);
    expect(pengaturan).toMatch(/MENU\.filter\(\(item\) => !item\.danger && bolehLihat\(item\)\)/);
  });

  it.each([['ADMIN'], ['PENGURUS']])('%s dapat melihat menu Pengaturan', (role) => {
    expect(bolehLihat(role as Role)).toBe(true);
  });

  it.each([['BENDAHARA'], ['PETUGAS'], ['ANGGOTA']])(
    '%s TIDAK dapat melihat menu Pengaturan',
    (role) => {
      expect(bolehLihat(role as Role)).toBe(false);
    }
  );

  it('permission belum termuat -> fail-closed', () => {
    // usePermission mengembalikan false bila cache permission kosong.
    expect(evaluasiIzin(undefined, 'view')).toBe(false);
  });

  it('matrix permission TIDAK diubah oleh RC ini', () => {
    // Lima role, dan `pengaturan` tetap ada untuk semuanya.
    expect(ROLES).toHaveLength(5);
    for (const role of ROLES) {
      expect(DEFAULT_ROLE_PERMISSIONS[role].pengaturan).toBeDefined();
    }
  });
});

// ============================================================
// §D/§E/§M — TOMBOL BACK (disederhanakan RC-S49b)
// ============================================================
describe('§D/§M — Back kembali ke layar pemanggil, tanpa tambalan', () => {
  it('ada satu fungsi tujuan kembali yang dipakai bersama', () => {
    expect(identitas).toMatch(/const kembali = useCallback\(\(\) => \{/);
    // Simpan memakai fungsi yang SAMA — bukan salinan kedua.
    expect(identitas).toMatch(/const kembaliSetelahSimpan = kembali;/);
  });

  it('RC-S49b — goBack() adalah jalur utama, dijaga canGoBack()', () => {
    const blok = identitas.slice(
      identitas.indexOf('const kembali = useCallback'),
      identitas.indexOf('const kembaliSetelahSimpan')
    );
    expect(blok).toMatch(/navigation\.canGoBack\(\)/);
    expect(blok).toMatch(/navigation\.goBack\(\);/);
    expect(blok.indexOf('canGoBack()')).toBeLessThan(blok.indexOf('goBack()'));
  });

  it('RC-S49b — fallback mengarah ke Dashboard, bukan stack kosong', () => {
    const blok = identitas.slice(
      identitas.indexOf('const kembali = useCallback'),
      identitas.indexOf('const kembaliSetelahSimpan')
    );
    expect(blok).toMatch(/navigation\.navigate\('Tabs', \{ screen: 'Dashboard' \}\)/);
  });

  it('§M — replace()/reset() TIDAK dipakai untuk alur ini', () => {
    expect(identitas).not.toMatch(/navigation\.replace\(/);
    expect(identitas).not.toMatch(/navigation\.reset\(/);
  });

  it('RC-S49b — tidak ada lagi headerLeft/BackHandler buatan sendiri', () => {
    // Ketiganya (param `asal`, headerLeft, BackHandler) hanya ada untuk
    // mengoreksi pendaftaran rute yang salah. Begitu rutenya benar,
    // back bawaan native-stack SUDAH mengembalikan pengguna ke layar
    // pemanggilnya — mempertahankan tambalannya berarti menyimpan dua
    // definisi perilaku kembali yang bisa berbeda.
    expect(identitas).not.toMatch(/headerLeft/);
    expect(identitas).not.toMatch(/BackHandler\.addEventListener/);
    expect(identitas).not.toMatch(/dariDashboard/);
  });

  it('§E — tujuan kembali TIDAK disimpulkan dari kelengkapan data', () => {
    const blok = identitas.slice(
      identitas.indexOf('const kembali = useCallback'),
      identitas.indexOf('const kembaliSetelahSimpan')
    );
    expect(blok).not.toMatch(/completion/);
    expect(blok).not.toMatch(/COMPLETE/);
  });

  it('§H — tidak ada perhitungan inset manual di header', () => {
    expect(identitas).not.toMatch(/paddingTop:\s*(24|25|30|32|40|44|48)\b/);
    expect(identitas).not.toMatch(/StatusBar\.currentHeight/);
    expect(identitas).not.toMatch(/insets\.top/);
  });
});

// ============================================================
// §N — tujuan setelah Simpan
// ============================================================
describe('§N — Simpan kembali sesuai ASAL, bukan sesuai isi data', () => {
  const blokSimpan = identitas.slice(identitas.indexOf('const simpan = async'));

  it('Simpan memanggil tujuan kembali setelah sukses', () => {
    expect(blokSimpan).toMatch(/kembaliSetelahSimpan\(\)/);
  });

  it('pemanggilannya berada SETELAH update & sinkronisasi store', () => {
    const iUpdate = blokSimpan.indexOf('updateIdentitasKoperasi(');
    const iStore = blokSimpan.indexOf('setKoperasi(');
    const iKembali = blokSimpan.indexOf('kembaliSetelahSimpan()');
    expect(iUpdate).toBeGreaterThan(-1);
    expect(iStore).toBeGreaterThan(iUpdate);
    expect(iKembali).toBeGreaterThan(iStore);
  });

  it('TIDAK pernah dipanggil pada cabang gagal', () => {
    const blokCatch = blokSimpan.slice(blokSimpan.indexOf('} catch (e) {'));
    expect(blokCatch).not.toMatch(/kembaliSetelahSimpan\(\)/);
  });

  it('§E — tujuan TIDAK disimpulkan dari kelengkapan data', () => {
    const blokKembali = identitas.slice(
      identitas.indexOf('const kembali = useCallback'),
      identitas.indexOf('const kembaliSetelahSimpan')
    );
    expect(blokKembali).not.toMatch(/completion/);
    expect(blokKembali).not.toMatch(/COMPLETE/);
    expect(blokKembali).not.toMatch(/identitas\?\./);
  });
});

// ============================================================
// §G — parameter navigasi (RC-S49b: tidak ada lagi)
// ============================================================
describe('§G — layar tidak lagi menerima parameter rute', () => {
  it('tipe param & prop `route` dihapus bersama tambalan back-nya', () => {
    expect(identitas).not.toMatch(/AsalIdentitasKoperasi/);
    expect(identitas).not.toMatch(/ParamIdentitasKoperasi/);
    expect(identitas).not.toMatch(/route\?: any/);
  });

  it('signature layar kembali sederhana, tanpa props', () => {
    expect(identitas).toMatch(/export default function IdentitasKoperasiScreen\(\) \{/);
  });
});

// ============================================================
// §F/§J/§S — jangan merusak yang sudah jalan
// ============================================================
describe('§F — FirstRun tidak tersentuh', () => {
  it('gate tetap merender FirstRunSetup, bukan pohon rute', () => {
    expect(tanpaKomentar(read('src/components/LicenseGate.tsx'))).toMatch(/FirstRunSetup/);
  });

  it('SetupWizard tetap menyelesaikan first run lewat onComplete', () => {
    const wizard = tanpaKomentar(read('src/screens/Setup/SetupWizardScreen.tsx'));
    expect(wizard).toMatch(/setupKoperasi\(\{/);
    expect(wizard).toMatch(/onComplete\(\);/);
  });

  it('layar identitas TIDAK ikut campur dalam status setup', () => {
    // §A: SetupService & completion helper tidak boleh disentuh dari
    // sisi navigasi.
    expect(identitas).not.toMatch(/setupKoperasi\(/);
    expect(identitas).not.toMatch(/triggerLicenseRecheck/);
  });
});

describe('§J — status identitas di Dashboard tetap segar', () => {
  it('Dashboard memuat ulang status lewat fokus, bukan timer', () => {
    expect(dashboard).toMatch(/useFocusRefresh\(/);
    expect(dashboard).toMatch(/muatStatusIdentitas\(\)/);
    // RC-S49b: `setInterval` KINI ADA di layar ini, tetapi HANYA untuk
    // menggambar countdown lisensi (§D) — bukan untuk memuat data.
    // Assertion diperketat, bukan dilonggarkan: yang dilarang adalah
    // pemuatan berbasis waktu, dan itu diperiksa dengan melihat apa
    // yang dijalankan DI DALAM interval.
    expect(dashboard).not.toMatch(/setTimeout|forceUpdate/);
    const isiInterval = dashboard.slice(
      dashboard.indexOf('setInterval('),
      dashboard.indexOf('setInterval(') + 60
    );
    expect(isiInterval).toMatch(/setInterval\(\(\) => setTikMs\(Date\.now\(\)\), 1000\)/);
    expect([...dashboard.matchAll(/setInterval\(/g)]).toHaveLength(1);
    expect(dashboard).not.toMatch(/setInterval\([^)]*muatStatusIdentitas/);
  });
});

describe('§A/§S — domain data tidak disentuh', () => {
  it('service identitas dipanggil apa adanya, tanpa jalur kedua', () => {
    expect(identitas).toMatch(/updateIdentitasKoperasi\(\{/);
    expect(identitas).toMatch(/hitungIdentityCompletion\(/);
    expect(identitas).toMatch(/bolehGantiTahunBuku\(\)/);
  });

  it('tidak ada SQL atau jurnal yang disentuh layar', () => {
    expect(identitas).not.toMatch(/UPDATE\s+koperasi|INSERT INTO|postJurnal\(/);
  });

  it('menu Pengaturan lain tetap ada', () => {
    // DIPERBARUI (sentralisasi Tarik Simpanan Anggota — instruksi eksplisit pengguna: Kebijakan Penarikan Dini tidak lagi di Pengaturan).
    for (const rute of ['BackupRestore', 'UserManagement', 'PermissionMatrix']) {
      expect(blokMenu).toContain(`route: '${rute}'`);
    }
    expect(blokMenu).not.toContain("route: 'KebijakanPenarikanDini'");
    // Lisensi tetap lewat expo-router, bukan dipindah ke MENU.
    expect(pengaturan).toMatch(/router\.push\('\/license'\)/);
  });

  it('tidak ada perubahan skema untuk pekerjaan navigasi ini', () => {
    // DIPERBARUI RC-S50. Assertion ini semula MEMATOK angka
    // `SCHEMA_VERSION = 58`, dan itu keliru sebagai penjaga: yang ingin
    // dijamin adalah "pekerjaan RC INI tidak mengubah skema", bukan
    // "skema tidak akan pernah naik lagi". Begitu RC berikutnya
    // melakukan perubahan database yang memang sah (RC-S50 §4:
    // rename nama akun 1-1210, UPDATE data di migrasi v59), assertion
    // versi mutlak gagal tanpa ada yang benar-benar rusak.
    //
    // Sekarang yang diperiksa adalah sifatnya: versinya TIDAK PERNAH
    // TURUN, dan tidak ada satu pun migrasi yang menyebut RC ini —
    // artinya RC ini memang tidak membawa perubahan database.
    const versi = Number(
      /export const SCHEMA_VERSION = (\d+);/.exec(read('src/database/schema.ts'))?.[1]
    );
    expect(versi).toBeGreaterThanOrEqual(58);
    expect(read('src/database/db.ts')).not.toMatch(new RegExp('RC-S49b'));
  });
});

// ============================================================
// §P — scoped compiler
// ============================================================
describe('§P — berkas yang diubah masuk scope compiler', () => {
  const cfg = read('tsconfig.screen-check.json');

  it.each([
    ['src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'],
    ['src/screens/Pengaturan/PengaturanScreen.tsx'],
  ])('%s ada di tsconfig.screen-check.json', (berkas) => {
    expect(cfg).toContain(berkas);
  });
});
