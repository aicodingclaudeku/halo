import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ALUR FIRST RUN: SETUP + LISENSI
 * =========================================================================
 *
 * Suite ini menguji sifat yang menentukan apakah kelonggaran FIRST_RUN
 * di LicenseGate benar-benar aman, atau justru pintu belakang.
 *
 * KENAPA STRUKTURAL, BUKAN RENDER.
 * `@testing-library/react-native` tidak dapat dipasang di lingkungan ini,
 * jadi komponen tidak dapat di-render. Tetapi pertanyaan yang paling
 * penting di sini memang bukan "apa yang tampil di layar", melainkan
 * "apakah ada jalur kode yang menyelesaikan setup tanpa lisensi" — dan
 * itu pertanyaan tentang BENTUK kode, yang justru lebih tepat dijawab
 * dengan memeriksa sumbernya secara langsung daripada dengan satu
 * skenario render yang kebetulan dipilih.
 *
 * Test render tetap perlu dilakukan di perangkat sungguhan. Suite ini
 * TIDAK menggantikannya, dan tidak boleh diklaim demikian.
 */

const ROOT = join(__dirname, '..', '..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/** Buang komentar agar yang "disebut" di komentar tidak ikut terhitung. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const gateSource = read('src/components/LicenseGate.tsx');
const gateCode = stripComments(gateSource);
const wizardSource = read('src/screens/Setup/SetupWizardScreen.tsx');
const wizardCode = stripComments(wizardSource);
const indexCode = stripComments(read('app/index.tsx'));
const layoutCode = stripComments(read('app/_layout.tsx'));

// ---------------------------------------------------------------------------
// A. FIRST RUN — SetupWizard dapat tampil tanpa token lisensi
// ---------------------------------------------------------------------------

describe('A. FIRST RUN dapat menampilkan SetupWizard tanpa lisensi', () => {
  it('gate punya fase FIRST_RUN yang terpisah dari ALLOWED', () => {
    // Dipisah sebagai fase, bukan digabung ke satu boolean, supaya
    // `phase === 'ALLOWED'` tetap berarti "lisensi benar-benar sah".
    expect(gateCode).toMatch(/'FIRST_RUN'/);
    expect(gateCode).toMatch(/GatePhase =[^;]*'ALLOWED'/);
  });

  it('FIRST_RUN ditentukan oleh isSetupComplete(), bukan flag baru', () => {
    // Memakai state SetupService yang sudah ada. Flag khusus gate akan
    // menjadi nilai kedua yang menjawab "apakah aplikasi sudah di-setup",
    // dan dua sumber kebenaran cepat atau lambat akan berbeda.
    expect(gateCode).toMatch(/isSetupComplete\(\)/);
    expect(gateCode).toMatch(/from '@\/services\/SetupService'/);
  });

  it('index.tsx mengarahkan ke SETUP selama setup belum selesai', () => {
    // Inilah yang membuat FIRST_RUN hanya bisa mencapai SetupWizard:
    // fase SETUP dievaluasi SEBELUM Login, Lock, dan RootNavigator.
    const setupCheck = indexCode.indexOf('const setupDone = await isSetupComplete()');
    const setPhaseSetup = indexCode.indexOf("setPhase('SETUP')");
    const rootNav = indexCode.indexOf('<RootNavigator />');
    expect(setupCheck).toBeGreaterThan(-1);
    expect(setPhaseSetup).toBeGreaterThan(setupCheck);
    expect(rootNav).toBeGreaterThan(setPhaseSetup);
  });
});

// ---------------------------------------------------------------------------
// B. FIRST RUN TANPA LICENSE — submit ditolak
// ---------------------------------------------------------------------------

describe('B. setup tanpa license key ditolak', () => {
  it('licenseKey wajib ada di skema validasi', () => {
    expect(wizardCode).toMatch(/licenseKey: z/);
    expect(wizardCode).toMatch(/min\(1, 'License key wajib diisi'\)/);
  });

  it('format divalidasi lewat LicenseService, bukan regex kedua', () => {
    // Dua definisi "kunci yang sah" akan berbeda cepat atau lambat, dan
    // yang lebih longgar yang akan dipakai.
    expect(wizardCode).toMatch(/isValidLicenseKeyFormat\(normalizeLicenseKey\(v\)\)/);
    expect(wizardCode).not.toMatch(/KPK\(-\[A-Z0-9\]/);
  });

  it('setupKoperasi TIDAK dipanggil sebelum aktivasi dievaluasi', () => {
    const activate = wizardCode.indexOf('await activateLicense(');
    const setup = wizardCode.indexOf('await setupKoperasi(');
    expect(activate).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(activate);
  });

  it('jalur gagal melakukan return sebelum setupKoperasi dan onComplete', () => {
    // `return` di dalam blok `if (!result.ok)` adalah satu-satunya hal
    // yang mencegah database ditulis tanpa lisensi.
    const gagal = wizardCode.indexOf('if (!result.ok)');
    const returnStmt = wizardCode.indexOf('return;', gagal);
    const setup = wizardCode.indexOf('await setupKoperasi(');
    expect(gagal).toBeGreaterThan(-1);
    expect(returnStmt).toBeGreaterThan(gagal);
    expect(setup).toBeGreaterThan(returnStmt);
  });

  it('onComplete hanya dipanggil sekali, setelah setupKoperasi', () => {
    const panggilan = wizardCode.match(/onComplete\(\)/g) ?? [];
    expect(panggilan).toHaveLength(1);
    expect(wizardCode.indexOf('onComplete()')).toBeGreaterThan(
      wizardCode.indexOf('await setupKoperasi(')
    );
  });
});

// ---------------------------------------------------------------------------
// C. FIRST RUN DENGAN LICENSE VALID
// ---------------------------------------------------------------------------

describe('C. setup dengan license valid', () => {
  it('license key dinormalisasi sebelum dikirim', () => {
    expect(wizardCode).toMatch(/licenseKey: normalizeLicenseKey\(parsed\.licenseKey\)/);
  });

  it('cooperativeName berasal dari field Nama Koperasi', () => {
    // Bukan dari layar kedua. Inilah alasan License Key dipindah ke
    // wizard: nama koperasi tidak perlu ditanyakan dua kali dan tidak
    // bisa berbeda antara server dan database lokal.
    expect(wizardCode).toMatch(/const nama = parsed\.nama\.trim\(\)/);
    expect(wizardCode).toMatch(/cooperativeName: nama/);
    expect(wizardCode).toMatch(/setupKoperasi\(\{\s*nama,/);
  });

  it('tidak ada implementasi HTTP aktivasi baru di wizard', () => {
    // Wizard HARUS memakai LicenseService. `fetch` di sini berarti ada
    // jalur aktivasi kedua yang tidak melewati verifikasi tanda tangan.
    expect(wizardCode).not.toMatch(/\bfetch\s*\(/);
    expect(wizardCode).not.toMatch(/activate\.php/);
    expect(wizardCode).toMatch(/from '@\/services\/LicenseService'/);
  });

  it('gate dievaluasi ulang setelah setup selesai', () => {
    const recheck = wizardCode.indexOf('triggerLicenseRecheck()');
    const complete = wizardCode.indexOf('onComplete()');
    expect(recheck).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(recheck);
  });
});

// ---------------------------------------------------------------------------
// D & E. LISENSI INVALID / KRIPTOGRAFI GAGAL
// ---------------------------------------------------------------------------

describe('D & E. lisensi invalid atau kriptografi gagal', () => {
  it('keputusan aktivasi diambil LicenseService, bukan wizard', () => {
    // §8: satu titik keputusan kebijakan. Wizard hanya membaca hasilnya.
    expect(wizardCode).toMatch(/const result = await activateLicense\(/);
    expect(wizardCode).toMatch(/if \(!result\.ok\)/);
  });

  it('wizard tidak memverifikasi token sendiri', () => {
    // Verifikasi kedua di UI akan menjadi tempat kedua yang bisa
    // dilonggarkan, dan yang paling longgar yang menentukan.
    expect(wizardCode).not.toMatch(/verifyActivationTokenOffline/);
    expect(wizardCode).not.toMatch(/verifyEd25519/);
  });

  it('pesan error berasal dari LicenseService, bukan exception mentah', () => {
    expect(wizardCode).toMatch(/setLicenseError\(result\.message\)/);
  });

  it('kegagalan kriptografi dapat didiagnosis dari wizard', () => {
    // Tanpa ini, perangkat yang Hermes-nya bermasalah hanya menampilkan
    // "aktivasi gagal" tanpa petunjuk apa pun sejak pemasangan pertama.
    expect(wizardCode).toMatch(/LicenseDiagnosticScreen/);
  });

  it('LicenseService tetap fail-closed saat kriptografi tidak sehat', () => {
    const service = stripComments(read('src/services/LicenseService.ts'));
    expect(service).toMatch(/state: 'CRYPTO_UNAVAILABLE', allowAppAccess: false/);
    expect(service).toMatch(/failure\('CRYPTO_UNAVAILABLE'\)/);
  });
});

// ---------------------------------------------------------------------------
// F. SETUP SELESAI + LISENSI INVALID -> tetap diblokir
// ---------------------------------------------------------------------------

describe('F. setup selesai dengan lisensi invalid tetap diblokir', () => {
  it('setup selesai memaksa BLOCKED, bukan FIRST_RUN', () => {
    expect(gateCode).toMatch(/setPhase\(setupDone \? 'BLOCKED' : 'FIRST_RUN'\)/);
  });

  it('kegagalan membaca status setup diperlakukan sebagai setup selesai', () => {
    // Fail-closed: database yang rusak berujung BLOCKED, bukan terbuka.
    expect(gateCode).toMatch(/catch\s*\{\s*setupDone = true;/);
  });

  it('lisensi sah diperiksa LEBIH DULU daripada status setup', () => {
    const allowed = gateCode.indexOf("setPhase('ALLOWED')");
    const setupCheck = gateCode.indexOf('await isSetupComplete()');
    expect(allowed).toBeGreaterThan(-1);
    expect(setupCheck).toBeGreaterThan(allowed);
  });

  it('sinyal recheck hanya memicu evaluasi ulang, tidak membawa keputusan', () => {
    // Kalau sinyal ini bisa MENETAPKAN fase, ia menjadi tombol untuk
    // membuka aplikasi. Ia hanya boleh memanggil evaluate().
    expect(gateCode).toMatch(/if \(licenseRecheckSignal > 0\) \{\s*void evaluate\(true\);/);
    expect(gateCode).not.toMatch(/licenseRecheckSignal[^)]*setPhase/);
  });

  it('tidak ada boolean tingkat modul yang menyimpan keputusan izin', () => {
    expect(gateCode).not.toMatch(/^\s*(let|var)\s+\w*[Ll]icensed\w*\s*=/m);
    expect(gateCode).not.toMatch(/^\s*(let|var)\s+isLicensed/m);
  });
});

// ---------------------------------------------------------------------------
// G & H. DEEP LINK DAN RUTE LAIN
// ---------------------------------------------------------------------------

describe('G & H. deep link dan rute lain tidak dapat melewati gate', () => {
  it('gate tetap di root layout, membungkus <Slot />', () => {
    const gateOpen = layoutCode.indexOf('<LicenseGate>');
    const slot = layoutCode.indexOf('<Slot');
    const gateClose = layoutCode.indexOf('</LicenseGate>');
    expect(gateOpen).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(gateOpen);
    expect(gateClose).toBeGreaterThan(slot);
  });

  it('gate TIDAK dipindah ke app/index.tsx', () => {
    expect(indexCode).not.toMatch(/<LicenseGate/);
  });

  it('gate TIDAK memakai rute untuk keputusan apa pun', () => {
    /**
     * Test ini sudah dua kali berubah, dan riwayatnya penting:
     *
     *   RC-S37 : melarang `usePathname` sepenuhnya.
     *   RC-S38A: melonggarkannya, karena gate memakai `<Redirect>`
     *            berbasis pathname untuk mengisolasi FIRST_RUN.
     *   RC-S38B: larangan dikembalikan — pendekatan `<Redirect>`
     *            DIBUANG. Pengalihan bekerja setelah rute tujuan sempat
     *            di-mount, sehingga `useEffect` di dalamnya sudah
     *            terlanjur jalan, dan rute baru yang ditambahkan kelak
     *            tidak ikut terlindungi.
     *
     * Sekarang FIRST_RUN tidak me-render pohon rute sama sekali, jadi
     * gate tidak butuh tahu rute apa pun. Perlindungannya struktural.
     */
    expect(gateCode).not.toMatch(/usePathname|useSegments|useLocalSearchParams/);
    expect(gateCode).not.toMatch(/Redirect/);
    expect(gateCode).not.toMatch(/Linking/);
    expect(gateCode).not.toMatch(/pathname|route\.name/);
  });

  it('FIRST_RUN me-render SetupWizard, BUKAN <Slot />', () => {
    // PART E. Selama setup belum selesai tidak ada satu pun rute yang
    // pernah di-mount — deep link ke /license, dashboard, atau rute apa
    // pun berujung di layar yang sama karena rutenya tidak pernah ada.
    expect(gateCode).toMatch(/phase === 'FIRST_RUN'[\s\S]{0,120}<FirstRunSetup/);
    const firstRun = gateCode.indexOf("phase === 'FIRST_RUN'");
    const children = gateCode.indexOf('{children}');
    expect(firstRun).toBeGreaterThan(-1);
    // `children` (yaitu <Slot />) hanya tercapai SETELAH cabang FIRST_RUN.
    expect(children).toBeGreaterThan(firstRun);
  });

  it('FirstRunSetup hanya me-render SetupWizard', () => {
    const firstRunSource = stripComments(read('src/components/FirstRunSetup.tsx'));
    expect(firstRunSource).toMatch(/<SetupWizardScreen/);
    expect(firstRunSource).not.toMatch(/<Slot|RootNavigator|LoginScreen|LockScreen/);
  });

  it('children di-render tepat di satu tempat, setelah cabang BLOCKED', () => {
    const occurrences = gateCode.match(/\{children\}/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(gateCode.indexOf('{children}')).toBeGreaterThan(
      gateCode.indexOf("phase === 'BLOCKED'")
    );
  });
});

// ---------------------------------------------------------------------------
// Non-regresi: kebijakan lisensi tidak ikut berubah
// ---------------------------------------------------------------------------

describe('kebijakan lisensi tidak berubah oleh perubahan alur setup', () => {
  const config = read('src/config/license.ts');

  it('offline grace tetap 7 hari', () => {
    expect(config).toMatch(/LICENSE_OFFLINE_GRACE_PERIOD_DAYS = 7/);
  });

  it('interval verifikasi tetap 24 jam', () => {
    expect(config).toMatch(/LICENSE_VERIFY_INTERVAL_HOURS = 24/);
  });

  it('public key produksi adalah kunci server yang aktif', () => {
    expect(read('src/config/licensePublicKeys.ts'))
      .toMatch(/'n8czx9Yis8m5GSxpkFDzig0MjaIp1UsBUcv5ZPsDQJ8='/);
  });

  it('wizard tidak memuat secret server apa pun', () => {
    for (const nama of ['TOKEN_SIGNING_SECRET', 'LICENSE_HMAC_SECRET', 'ADMIN_SETUP_TOKEN']) {
      expect(wizardSource).not.toContain(nama);
    }
  });
});


// ---------------------------------------------------------------------------
// J. Pengguna mobile tidak dapat melepas lisensi sendiri (RC-S37)
// ---------------------------------------------------------------------------

describe('J. tidak ada self-deactivate di UI pengguna', () => {
  /**
   * Lisensi terikat pada License Key + Perangkat + Koperasi. Tombol
   * self-deactivate memberi pengguna cara melepas ikatan itu lalu
   * memasangnya kembali dengan koperasi yang berbeda — persis yang
   * ingin dicegah model lisensi ini.
   *
   * `deactivateLicense()` sendiri TIDAK dihapus: ia masih dibutuhkan
   * lifecycle server dan tetap diuji. Yang dilarang adalah adanya
   * PEMANGGIL dari layar yang dapat dibuka pengguna biasa.
   */
  const infoSource = stripComments(read('src/screens/License/LicenseInfoScreen.tsx'));
  const activationSource = stripComments(read('src/screens/License/LicenseActivationScreen.tsx'));
  const diagnosticSource = stripComments(read('src/screens/License/LicenseDiagnosticScreen.tsx'));

  it('LicenseInfoScreen tidak mengimpor maupun memanggil deactivateLicense', () => {
    expect(infoSource).not.toMatch(/deactivateLicense/);
  });

  it('tidak ada teks tombol "Nonaktifkan Lisensi" di layar mana pun', () => {
    for (const source of [infoSource, activationSource, diagnosticSource]) {
      expect(source).not.toMatch(/Nonaktifkan Lisensi/);
    }
  });

  it('tidak ada layar lisensi yang memanggil deactivateLicense', () => {
    for (const source of [infoSource, activationSource, diagnosticSource]) {
      expect(source).not.toMatch(/deactivateLicense\s*\(/);
    }
  });

  it('LicenseService TETAP mengekspor deactivateLicense untuk lifecycle server', () => {
    // Menghapus fungsinya akan menghilangkan kemampuan yang masih
    // dibutuhkan; yang salah adalah menempelkannya ke tombol pengguna.
    expect(stripComments(read('src/services/LicenseService.ts')))
      .toMatch(/export async function deactivateLicense/);
  });

  it('Verifikasi Sekarang tetap tersedia', () => {
    expect(infoSource).toMatch(/verifyLicense\s*\(/);
    expect(infoSource).toMatch(/Verifikasi Sekarang/);
  });
});
