import { readFileSync } from 'fs';
import { join } from 'path';
import { LICENSE_TYPES, type LicenseType } from '@/config/license';
import {
  LABEL_TIPE_LISENSI,
  formatSisaWaktu,
  hitungSisaMs,
  tipeLisensiPakaiCountdown,
  urgensiSisaWaktu,
} from '@/utils/licenseCountdown';

/**
 * ============================================================
 * RC-S49b §C/§D/§E/§F/§G — COUNTDOWN LISENSI DI DASHBOARD
 * ============================================================
 *
 * DUA LAPIS, DAN KEDUANYA MEMANG PERLU.
 *
 * 1. FUNGSIONAL. Perhitungan sisa waktu adalah aritmetika murni, jadi
 *    ia diuji sungguhan — termasuk kasus yang paling gampang salah:
 *    lisensi tanpa `expiresAt`, `expiresAt` yang tidak dapat diurai,
 *    dan detik terakhir sebelum nol.
 *
 * 2. STRUKTURAL. Sifat "countdown tidak boleh menjadi sumber kebenaran"
 *    tidak bisa dibuktikan dengan memanggil fungsi: ia sifat tentang
 *    SIAPA yang memutuskan. Yang diperiksa adalah bahwa Dashboard
 *    membaca `getLicenseStatus()` dan menyerahkan penguncian kepada
 *    LicenseGate — bukan menyimpulkan sendiri dari timer.
 *
 * YANG SENGAJA TIDAK DIUJI DI SINI: kriptografi, token, device binding,
 * trusted clock, dan protokol server. RC ini TIDAK menyentuhnya, dan
 * semuanya sudah punya suite sendiri (LicenseCrypto, LicenseToken,
 * LicenseClock, LicenseService). Menduplikasi assertion-nya di sini
 * hanya akan menciptakan tempat kedua yang harus ikut diperbarui.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const dashboard = read('src/screens/Dashboard/DashboardScreen.tsx');
const dashboardBersih = tanpaKomentar(dashboard);

const DETIK = 1000;
const MENIT = 60 * DETIK;
const JAM = 60 * MENIT;
const HARI = 24 * JAM;

// ============================================================
// §C2 — PERMANENT vs TRIAL
// ============================================================
describe('§C1/§C2 — tipe lisensi mana yang menghitung mundur', () => {
  it('seluruh tipe lisensi server punya label yang dibaca pengguna', () => {
    // Kalau server menambah tipe dan label ini tidak ikut, kartunya
    // akan menampilkan `undefined` di Dashboard.
    for (const tipe of LICENSE_TYPES) {
      expect(LABEL_TIPE_LISENSI[tipe]).toBeTruthy();
    }
    expect(Object.keys(LABEL_TIPE_LISENSI).sort()).toEqual([...LICENSE_TYPES].sort());
  });

  it('§C2 — PERMANENT TIDAK menampilkan countdown', () => {
    expect(tipeLisensiPakaiCountdown('PERMANENT')).toBe(false);
    expect(LABEL_TIPE_LISENSI.PERMANENT).toBe('Lisensi Permanen');
  });

  it.each<[LicenseType, string]>([
    ['TRIAL_3D', 'Lisensi Trial 3 Hari'],
    ['TRIAL_7D', 'Lisensi Trial 7 Hari'],
    ['TRIAL_1M', 'Lisensi Trial 1 Bulan'],
  ])('%s menampilkan countdown dengan label "%s"', (tipe, label) => {
    expect(tipeLisensiPakaiCountdown(tipe)).toBe(true);
    expect(LABEL_TIPE_LISENSI[tipe]).toBe(label);
  });

  it('status tanpa tipe lisensi tidak dipaksa menghitung mundur', () => {
    expect(tipeLisensiPakaiCountdown(null)).toBe(false);
  });
});

// ============================================================
// §C3 — countdown WAJIB mengikuti expiresAt
// ============================================================
describe('§C3 — sisa waktu dihitung dari expiresAt token', () => {
  const sekarang = Date.parse('2026-09-10T08:00:00.000Z');

  it.each<[LicenseType, string]>([
    ['TRIAL_3D', '2026-09-13T08:00:00.000Z'],
    ['TRIAL_7D', '2026-09-17T08:00:00.000Z'],
    ['TRIAL_1M', '2026-10-10T08:00:00.000Z'],
  ])('%s mengikuti expiresAt sebenarnya, bukan durasi tipenya', (_tipe, expiresAt) => {
    const sisa = hitungSisaMs(expiresAt, sekarang);
    expect(sisa).toBe(Date.parse(expiresAt) - sekarang);
  });

  it('expiresAt yang SAMA menghasilkan sisa yang mengecil seiring waktu', () => {
    // Inti §C3: acuannya tanggal kedaluwarsa yang tetap, bukan "3 hari
    // sejak Dashboard dibuka". Kalau acuannya saat layar dibuka, kedua
    // nilai di bawah akan identik dan trial tidak pernah habis.
    const expiresAt = '2026-09-13T08:00:00.000Z';
    const awal = hitungSisaMs(expiresAt, sekarang)!;
    const sejamKemudian = hitungSisaMs(expiresAt, sekarang + JAM)!;
    expect(sejamKemudian).toBe(awal - JAM);
  });

  it('lisensi tanpa batas waktu tidak menghasilkan angka sisa', () => {
    expect(hitungSisaMs(null, sekarang)).toBeNull();
  });

  it('expiresAt yang tidak dapat diurai TIDAK menjadi angka ngawur', () => {
    // Mengembalikan 0 atau NaN akan tampil sebagai "sudah berakhir"
    // pada lisensi yang mungkin masih sah. `null` = "tidak tahu",
    // dan kartunya tidak menampilkan countdown.
    expect(hitungSisaMs('bukan-tanggal', sekarang)).toBeNull();
  });

  it('sisa negatif dipertahankan, tidak dinormalkan jadi nol', () => {
    expect(hitungSisaMs('2026-09-10T07:00:00.000Z', sekarang)).toBe(-JAM);
  });
});

// ============================================================
// §C1 — format yang dibaca pengguna
// ============================================================
describe('§C1 — format sisa waktu', () => {
  it('>= 24 jam: hari + jam + menit', () => {
    expect(formatSisaWaktu(2 * HARI + 14 * JAM + 32 * MENIT)).toBe('2 hari 14 jam 32 menit');
  });

  it('< 24 jam: jam + menit', () => {
    expect(formatSisaWaktu(13 * JAM + 42 * MENIT)).toBe('13 jam 42 menit');
  });

  it('< 1 jam: menit + detik', () => {
    expect(formatSisaWaktu(42 * MENIT + 15 * DETIK)).toBe('42 menit 15 detik');
  });

  it('batas 24 jam tepat masuk format harian', () => {
    expect(formatSisaWaktu(HARI)).toBe('1 hari 0 jam 0 menit');
  });

  it('batas 1 jam tepat masuk format jam', () => {
    expect(formatSisaWaktu(JAM)).toBe('1 jam 0 menit');
  });

  it('detik-detik terakhir tetap terbaca', () => {
    expect(formatSisaWaktu(9 * DETIK)).toBe('0 menit 9 detik');
  });

  it('nol dan negatif dinyatakan berakhir, bukan angka minus', () => {
    expect(formatSisaWaktu(0)).toBe('Sudah berakhir');
    expect(formatSisaWaktu(-5 * MENIT)).toBe('Sudah berakhir');
  });

  it('tidak pernah menghasilkan NaN atau undefined', () => {
    for (const ms of [1, DETIK, MENIT, JAM, HARI, 31 * HARI]) {
      expect(formatSisaWaktu(ms)).not.toMatch(/NaN|undefined/);
    }
  });
});

describe('urgensi hanya memengaruhi warna, bukan akses', () => {
  it.each([
    [null, 'NORMAL'],
    [5 * HARI, 'NORMAL'],
    [10 * JAM, 'SEGERA_HABIS'],
    [30 * MENIT, 'HAMPIR_HABIS'],
    [0, 'BERAKHIR'],
    [-1, 'BERAKHIR'],
  ])('sisa %p -> %s', (sisa, harapan) => {
    expect(urgensiSisaWaktu(sisa as number | null)).toBe(harapan);
  });
});

// ============================================================
// §C/§G — Dashboard memakai sistem lisensi yang SUDAH ADA
// ============================================================
describe('§C/§G — Dashboard tidak membuat sistem lisensi kedua', () => {
  it('membaca status lewat getLicenseStatus() existing', () => {
    expect(dashboard).toMatch(
      /import \{ getLicenseStatus, type LicenseStatus \} from '@\/services\/LicenseService';/
    );
    expect(dashboardBersih).toMatch(/await getLicenseStatus\(\)/);
  });

  it('memakai field status yang sudah ada, bukan bentukan sendiri', () => {
    expect(dashboardBersih).toMatch(/lisensi\?\.licenseType/);
    expect(dashboardBersih).toMatch(/lisensi\.expiresAt/);
    expect(dashboardBersih).toMatch(/status\.allowAppAccess/);
    expect(dashboardBersih).toMatch(/lisensi\.cooperativeName/);
  });

  it('§G — TIDAK menyentuh kriptografi, token, atau server lisensi', () => {
    expect(dashboard).not.toMatch(/ed25519|licenseToken|licenseStore|verifyActivationToken/);
    expect(dashboard).not.toMatch(/LICENSE_API_BASE|fetch\(/);
    expect(dashboard).not.toMatch(/activateLicense|deactivateLicense|verifyLicense\(/);
  });

  it('§H — nama koperasi diambil dari status, bukan disimpan ulang', () => {
    expect(dashboardBersih).not.toMatch(/setCooperativeName|persistLicense|writeLicense/);
  });
});

// ============================================================
// §D — timer hanya untuk presentasi
// ============================================================
describe('§D — timer countdown aman dan tunggal', () => {
  it('tepat SATU setInterval di seluruh layar', () => {
    expect([...dashboardBersih.matchAll(/setInterval\(/g)]).toHaveLength(1);
  });

  it('interval hanya memperbarui jam gambar', () => {
    expect(dashboardBersih).toMatch(/setInterval\(\(\) => setTikMs\(Date\.now\(\)\), 1000\)/);
  });

  it('interval dibersihkan (tidak ada memory leak / timer ganda)', () => {
    expect(dashboardBersih).toMatch(/return \(\) => clearInterval\(interval\);/);
    expect([...dashboardBersih.matchAll(/clearInterval\(/g)]).toHaveLength(1);
  });

  it('§C2 — timer tidak berjalan sama sekali untuk lisensi permanen', () => {
    // `pakaiCountdown` bernilai false untuk PERMANENT, dan efeknya
    // keluar SEBELUM setInterval dipanggil.
    const efek = dashboardBersih.slice(
      dashboardBersih.indexOf('if (!pakaiCountdown) return;'),
      dashboardBersih.indexOf('setInterval(')
    );
    expect(efek).toContain('if (!pakaiCountdown) return;');
  });

  it('timer TIDAK menjalankan kueri database atau panggilan server', () => {
    const i = dashboardBersih.indexOf('setInterval(');
    expect(dashboardBersih.slice(i, i + 120)).not.toMatch(
      /getDb|getLicenseStatus|fetch\(|SELECT /
    );
  });

  it('timer bukan variabel global', () => {
    expect(dashboardBersih).not.toMatch(/^(?:let|const|var)\s+\w*[Ii]nterval/m);
  });
});

// ============================================================
// §E/§E1/§F — perilaku saat habis & saat aplikasi kembali
// ============================================================
describe('§E/§E1 — countdown nol menyerahkan keputusan ke LicenseGate', () => {
  it('countdown habis memicu pembacaan status OTORITATIF, bukan penguncian sendiri', () => {
    const efek = dashboardBersih.slice(dashboardBersih.indexOf('if (!pakaiCountdown || sisaMs === null'));
    expect(efek.slice(0, 400)).toMatch(/void muatStatusLisensi\(\)/);
  });

  it('§E — Dashboard TIDAK membuat lock screen kedua', () => {
    // Diperiksa pada kode, bukan komentar: penjelasan boleh menyebut
    // LicenseGate/LicenseActivationScreen, yang dilarang adalah
    // merendernya dari sini.
    expect(dashboardBersih).not.toMatch(/LicenseActivationScreen|APLIKASI TERKUNCI|Masukkan License/);
  });

  it('§E1 — akses yang tidak lagi diizinkan membangunkan gate', () => {
    expect(dashboardBersih).toMatch(
      /if \(!status\.allowAppAccess\) \{[\s\S]{0,120}triggerLicenseRecheck\(\);/
    );
  });

  it('laporan "waktu habis" dikirim sekali, bukan tiap detik', () => {
    expect(dashboardBersih).toMatch(/sudahLaporBerakhir\.current = true;/);
    expect(dashboardBersih).toMatch(/if \(sudahLaporBerakhir\.current\) return;/);
  });

  it('penegakan tetap milik LicenseGate, dan mekanismenya tidak diubah', () => {
    const gate = tanpaKomentar(read('src/components/LicenseGate.tsx'));
    // Sinyal recheck yang dipakai Dashboard memang sudah didengarkan
    // gate sejak sebelum RC ini — tidak ada jalur baru yang dibuat.
    expect(gate).toMatch(/if \(licenseRecheckSignal > 0\) \{\s*void evaluate\(true\);/);
    expect(gate).toMatch(/setPhase\(setupDone \? 'BLOCKED' : 'FIRST_RUN'\)/);
    expect(gate).toMatch(/<LicenseActivationScreen status=\{status\}/);
  });

  it('§F — app resume tetap dievaluasi ulang lewat AppState di gate', () => {
    const gate = tanpaKomentar(read('src/components/LicenseGate.tsx'));
    expect(gate).toMatch(/AppState\.addEventListener\('change'/);
    expect(gate).toMatch(/if \(state === 'active'\) \{\s*void evaluate\(true\);/);
    // Dashboard TIDAK memasang listener AppState-nya sendiri: satu
    // mekanisme resume, bukan dua yang bisa berbeda.
    expect(dashboardBersih).not.toMatch(/AppState/);
  });

  it('status lisensi ikut dibaca ulang saat layar difokuskan', () => {
    // DIPERBARUI RC-S74 FINAL FIX DELAY AKRUAL (§4): antara pemanggilan
    // `muatStatusLisensi()` dan penutup `useFocusRefresh` kini ada consume
    // one-shot startup-task request (kode baru, bukan accounting) — maksud
    // assertion (status lisensi tetap dibaca ulang tiap fokus, dan tiga
    // fungsi lama tetap ada di deps) tidak berubah.
    expect(dashboardBersih).toMatch(/void muatStatusLisensi\(\);[\s\S]{0,600}\}, \[[\s\S]*?\]\);/);
    const iEfek = dashboardBersih.indexOf('useFocusRefresh(() => {');
    const iTutup = dashboardBersih.indexOf('}, [', iEfek);
    const deps = dashboardBersih.slice(iTutup, dashboardBersih.indexOf(');', iTutup));
    expect(deps).toMatch(/\bload\b/);
    expect(deps).toMatch(/\bmuatStatusIdentitas\b/);
    expect(deps).toMatch(/\bmuatStatusLisensi\b/);
  });
});

// ============================================================
// §I — UI profesional & konsisten
// ============================================================
describe('§I — kartu lisensi memakai design system existing', () => {
  it('memakai token warna/radius/spacing, bukan angka yang dikarang', () => {
    const gaya = dashboard.slice(dashboard.indexOf('lisensiCard: {'), dashboard.indexOf('container: {'));
    expect(gaya).toMatch(/colors\.surface/);
    expect(gaya).toMatch(/radius\.md/);
    expect(gaya).toMatch(/spacing\.md/);
  });

  it('memakai Ionicons, konsisten dengan kartu lain di Dashboard', () => {
    expect(dashboard).toMatch(/name=\{pakaiCountdown \? 'time-outline' : 'shield-checkmark-outline'\}/);
  });

  it('berbahasa Indonesia dan konsisten dengan wording yang diminta', () => {
    expect(dashboard).toContain('Sisa waktu');
    expect(dashboard).toContain('Koperasi: ');
    expect(dashboard).toContain('Status: Aktif · tanpa batas waktu');
  });

  it('kartu tidak menghalangi dashboard bila status gagal dibaca', () => {
    // Pola sama dengan kartu identitas: gagal baca -> kartunya tidak
    // ditampilkan, bukan seluruh layar gagal render.
    expect(dashboardBersih).toMatch(/\} catch \{\s*setLisensi\(null\);/);
    expect(dashboardBersih).toMatch(/\{lisensi && tipeLisensi && \(/);
  });
});

// ============================================================
// §M — regresi
// ============================================================
describe('§M — dashboard yang sudah ada tidak berubah', () => {
  it('statistik & kueri dashboard tidak disentuh', () => {
    expect(dashboard).toContain('Komposisi Simpanan');
    expect(dashboard).toContain('Kesehatan Pinjaman');
    expect(dashboard).toContain('Keanggotaan');
    expect(dashboard).toMatch(/FROM simpanan_transaksi/);
    expect(dashboard).toMatch(/FROM angsuran_jadwal aj JOIN pinjaman p/);
  });

  it('kartu identitas tetap ada dan tetap segar lewat fokus', () => {
    expect(dashboardBersih).toMatch(/muatStatusIdentitas/);
    expect(dashboardBersih).toMatch(/getIdentityCompletionStatus\(\)/);
  });

  it('tidak ada perubahan skema database untuk pekerjaan ini', () => {
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
