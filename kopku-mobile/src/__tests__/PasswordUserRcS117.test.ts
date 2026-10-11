import { readFileSync } from 'fs';
import { join } from 'path';
import {
  periksaPassword,
  rapikanPassword,
  kekuatanPassword,
  PANJANG_MIN_PASSWORD,
  PESAN_MASALAH_PASSWORD,
} from '@/security/kebijakanPassword';

/**
 * ============================================================
 * RC-S117 — PASSWORD UNTUK MASUK, PIN HANYA UNTUK KUNCI LAYAR
 * ============================================================
 *
 * BATAS YANG DIJAGA SUITE INI.
 *
 * Sampai RC-S116, PIN 6 digit merangkap DUA peran yang berbeda:
 * kredensial masuk (membuktikan "saya Bendahara Siti") dan kunci layar
 * aplikasi (membuka kembali sesi di perangkat yang sudah dipegang
 * orangnya). Untuk peran kedua 6 digit memadai; untuk peran pertama
 * tidak — ruang tebakannya sejuta, dan itu satu-satunya yang memisahkan
 * seorang petugas dari wewenang Admin atas seluruh buku besar.
 *
 * Bahaya terbesar dari pemisahan ini BUKAN password yang lemah — itu
 * ditolak kebijakan. Bahayanya adalah kedua peran diam-diam MENYATU
 * KEMBALI: password disalin ke kolom PIN "supaya praktis", atau jalur
 * login kembali membaca kolom PIN. Karena itu sebagian besar assertion
 * di bawah menguji PEMISAHANNYA, bukan sekadar bahwa password bekerja.
 */

function tanpaKomentar(teks: string): string {
  return teks
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const baca = (p: string) => tanpaKomentar(readFileSync(join(__dirname, '..', p), 'utf8'));

describe('RC-S117 — kebijakan password', () => {
  test('menerima password yang wajar', () => {
    expect(periksaPassword({ password: 'rahasia123' }).sah).toBe(true);
    expect(periksaPassword({ password: 'Koperasi Maju 2026' }).sah).toBe(true);
  });

  test('menolak yang terlalu pendek', () => {
    const h = periksaPassword({ password: 'abc123' });
    expect(h.sah).toBe(false);
    expect(h.masalah).toContain('TERLALU_PENDEK');
    expect(h.pesan).toBe(PESAN_MASALAH_PASSWORD.TERLALU_PENDEK);
  });

  test('menolak password yang HANYA ANGKA', () => {
    // Inti pemisahan ini. Kalau angka saja boleh, orang akan menulis
    // PIN lamanya sebagai password dan seluruh pemisahan tidak
    // menghasilkan apa-apa.
    const h = periksaPassword({ password: '123456789' });
    expect(h.sah).toBe(false);
    expect(h.masalah).toContain('HANYA_ANGKA');
    expect(h.pesan).toMatch(/PIN/);
  });

  test('menolak password yang sama dengan username', () => {
    // Kredensial yang setengahnya sudah tertulis di layar login bukan
    // kredensial.
    expect(periksaPassword({ password: 'bendahara', username: 'bendahara' }).sah).toBe(false);
    expect(periksaPassword({ password: 'BENDAHARA', username: 'bendahara' }).sah).toBe(false);
  });

  test('konfirmasi yang tidak cocok ditolak', () => {
    const h = periksaPassword({ password: 'rahasia123', konfirmasi: 'rahasia124' });
    expect(h.sah).toBe(false);
    expect(h.masalah).toContain('KONFIRMASI_TIDAK_COCOK');
  });

  test('spasi di UJUNG dipangkas, spasi di TENGAH dipertahankan', () => {
    // Spasi tak terlihat di ujung adalah sumber "password saya benar
    // tapi ditolak" yang tidak mungkin didiagnosis pengguna sendiri.
    // Spasi di tengah justru menambah ruang tebakan dan memang sah.
    expect(rapikanPassword('  rahasia123  ')).toBe('rahasia123');
    expect(rapikanPassword('kata sandi panjang')).toBe('kata sandi panjang');
    expect(periksaPassword({ password: '  rahasia123  ', konfirmasi: 'rahasia123' }).sah).toBe(true);
  });

  test('password kosong ditolak dengan pesannya sendiri', () => {
    expect(periksaPassword({ password: '' }).masalah).toEqual(['KOSONG']);
    expect(periksaPassword({ password: '   ' }).masalah).toEqual(['KOSONG']);
  });

  test('batas minimum benar-benar dipakai, bukan hanya diumumkan', () => {
    const tepat = 'a'.repeat(PANJANG_MIN_PASSWORD - 1) + '1';
    const kurang = 'a'.repeat(PANJANG_MIN_PASSWORD - 2) + '1';
    expect(periksaPassword({ password: tepat }).sah).toBe(true);
    expect(periksaPassword({ password: kurang }).sah).toBe(false);
  });

  test('kekuatan hanya umpan balik, bukan penentu diterima', () => {
    expect(kekuatanPassword('rahasia1')).toBe('CUKUP');
    expect(kekuatanPassword('Koperasi2026!')).toBe('KUAT');
    expect(kekuatanPassword('aaaaaaaa')).toBe('LEMAH');
    // Yang LEMAH pun tetap diterima kalau memenuhi kebijakan — aturan
    // yang terlalu rewel membuat orang menempel password di monitor.
    expect(periksaPassword({ password: 'aaaaaaaa' }).sah).toBe(true);
  });
});

describe('RC-S117 — PIN dan password TIDAK boleh menyatu kembali', () => {
  const userService = baca('services/UserManagementService.ts');
  const auth = baca('services/AuthService.ts');
  const setup = baca('services/SetupService.ts');

  test('user baru menerima PASSWORD, bukan PIN', () => {
    expect(userService).toContain('password: string;');
    expect(userService).not.toMatch(/pin: string; \/\/ 6 digit/);
    expect(userService).toContain('pastikanPasswordSah(input.password, input.username)');
  });

  test('PIN user baru TIDAK disalin dari password', () => {
    // Menyalinnya membuat password ikut menjadi kunci layar — persis
    // penggabungan dua peran yang dipisahkan di sini.
    const i = userService.indexOf('export async function createUser');
    const blok = userService.slice(i, userService.indexOf('export async function updateUserRole'));
    expect(blok).toContain('pinAcakTidakDapatDipakai()');
    expect(blok).not.toMatch(/pinHash = await hashPin\(rapikanPassword/);
    // Dua salt BERBEDA: salt yang sama akan membuat dua hash dapat
    // dibandingkan satu sama lain.
    expect(blok).toContain('const saltPassword = generateSalt()');
    expect(blok).toContain('const saltPin = generateSalt()');
  });

  test('login membaca kolom PASSWORD, unlock membaca kolom PIN', () => {
    expect(auth).toContain("verifikasiDanNaikkan(db, row, password, 'password')");
    expect(auth).toContain("verifikasiDanNaikkan(db, row, pin, 'pin')");
    // Dan tanda tangan login-nya benar-benar menerima password.
    expect(auth).toMatch(/export async function login\(username: string, password: string\)/);
  });

  test('admin mereset PASSWORD, bukan PIN orang lain', () => {
    // PIN adalah kunci layar milik pemiliknya di perangkatnya sendiri.
    expect(userService).toContain('export async function resetUserPassword');
    expect(userService).not.toContain('export async function resetUserPin');
    const i = userService.indexOf('export async function resetUserPassword');
    const blok = userService.slice(i, userService.indexOf('export interface UpdateUserInput'));
    expect(blok).toContain('UPDATE app_user SET password_hash');
    expect(blok).not.toContain('pin_hash = ?');
  });

  test('PIN kunci aplikasi hanya dapat ditetapkan pemiliknya sendiri', () => {
    // Aturan lama menuntut ADMIN, sehingga Bendahara/Petugas sebenarnya
    // TIDAK BISA menyalakan kunci aplikasinya sendiri — kebalikan dari
    // maksud fitur itu.
    expect(userService).toContain('export async function aturPinKunciAplikasi');
    const i = userService.indexOf('export async function aturPinKunciAplikasi');
    const blok = userService.slice(i);
    expect(blok).toContain('if (actingUserId !== userId)');
    expect(blok).not.toContain('pastikanAdmin');
  });
});

describe('RC-S117 — tidak ada pengurus yang terkunci oleh perubahan ini', () => {
  const db = baca('database/db.ts');
  const setup = baca('services/SetupService.ts');

  test('migrasi menyalin PIN lama sebagai password awal', () => {
    // Pengurus lama tidak punya password. Mengosongkan kolomnya berarti
    // SELURUHNYA terkunci di luar aplikasinya sendiri pada pembaruan
    // berikutnya — admin pun ikut, sehingga tidak ada jalan masuk untuk
    // memperbaikinya.
    expect(db).toContain('SET password_hash = pin_hash');
    expect(db).toContain('WHERE password_hash IS NULL');
  });

  test('migrasi aman pada database yang belum punya app_user', () => {
    // Jalur upgrade dari versi sangat lama. Diperiksa secara tegas,
    // bukan dengan membungkus UPDATE dalam try/catch kosong — itu akan
    // ikut menelan kegagalan nyata pada database yang tabelnya ada.
    const i = db.indexOf('export async function migrasiV76');
    const blok = db.slice(i, db.indexOf('export async function migrasiV75'));
    expect(blok).toContain("name = 'app_user'");
    expect(blok).toContain('if (!tabel) return;');
  });

  test('admin pertama hasil setup juga punya password', () => {
    // Wizard setup hanya meminta tiga isian dan tidak meminta password;
    // kalau kolomnya dibiarkan kosong, admin pertama tidak punya cara
    // masuk begitu kunci PIN diaktifkan.
    expect(setup).toContain('password_hash, password_salt, password_hash_versi');
  });

  test('password warisan ditandai, bukan disembunyikan', () => {
    const userService = baca('services/UserManagementService.ts');
    const layar = baca('screens/Pengaturan/UserManagementScreen.tsx');
    expect(userService).toContain('passwordWarisan');
    expect(userService).toContain('row.password_hash === row.pin_hash');
    expect(layar).toContain('item.passwordWarisan');
  });
});

describe('RC-S117 — layar user: sunting & password', () => {
  const form = baca('screens/Pengaturan/UserFormScreen.tsx');
  const daftar = baca('screens/Pengaturan/UserManagementScreen.tsx');
  const login = baca('screens/Setup/LoginScreen.tsx');

  test('daftar user punya tombol Sunting', () => {
    // Sebelumnya hanya role yang bisa diubah; salah ketik nama atau
    // username berarti user harus dinonaktifkan dan dibuat ulang —
    // memutus jejak audit atas namanya.
    expect(daftar).toContain("navigation.navigate('UserForm', { userId: item.id })");
  });

  test('form melayani dua mode dari satu rute', () => {
    expect(form).toContain("const mode: 'TAMBAH' | 'SUNTING' = userId ? 'SUNTING' : 'TAMBAH'");
    expect(form).toContain('await updateUser(');
    expect(form).toContain('await createUser(');
  });

  test('menyunting tanpa mengisi password TIDAK mengganti password', () => {
    // Menyimpan suntingan nama tidak boleh diam-diam mengganti password
    // dan mengunci orangnya di luar.
    expect(form).toContain("const gantiPassword = mode === 'TAMBAH' || password.length > 0 || passwordKonfirmasi.length > 0");
    expect(form).toContain('if (gantiPassword) {');
  });

  test('form tidak lagi meminta PIN', () => {
    expect(form).not.toContain('PinInput');
    expect(form).not.toMatch(/pin:\s*\w+/);
  });

  test('layar login memakai password, bukan PinInput', () => {
    expect(login).not.toContain('<PinInput');
    expect(login).toContain('secureTextEntry');
    expect(login).toContain('login(username.trim(), password)');
  });
});
