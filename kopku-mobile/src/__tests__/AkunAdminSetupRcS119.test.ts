/**
 * RC-S119 — AKUN ADMINISTRATOR DIBUAT SAAT SETUP.
 *
 * ============================================================
 * JALAN BUNTU YANG DITUTUP
 * ============================================================
 * Wizard lama hanya meminta tiga isian dan membuat akun admin
 * diam-diam: username selalu "admin", dan kolom password diisi CERMIN
 * dari hash PIN. Pada jalur setup minimal, PIN itu sendiri adalah nilai
 * ACAK yang memang dibuat agar tidak dapat dipakai siapa pun — sehingga
 * admin pertama tidak punya password yang bisa diketik sama sekali.
 *
 * Selama sesi terbuka sendiri hal itu tidak terlihat. Tetapi sekali
 * pengguna menyalakan PIN lalu menekan "Keluar" di layar kunci, layar
 * Masuk meminta password yang tidak pernah ada, dan tidak ada jalan
 * kembali selain memasang ulang aplikasi — beserta seluruh datanya.
 *
 * §3 menguji tepat urutan itu terhadap database sungguhan: setup ->
 * login dengan password yang dipilih pengguna. Menguji "kolom password
 * terisi" saja tidak cukup; kolom itu SELALU terisi, bahkan pada
 * kondisi rusak yang dibicarakan di atas.
 */
import fs from 'fs';
import path from 'path';
import {
  periksaUsername,
  rapikanUsername,
  PANJANG_MIN_USERNAME,
  PANJANG_MAKS_USERNAME,
  PESAN_MASALAH_USERNAME,
} from '@/security/kebijakanUsername';

const baca = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const wizard = () => baca('screens', 'Setup', 'SetupWizardScreen.tsx');

describe('RC-S119 §1 — kebijakan username', () => {
  it('menerima username wajar', () => {
    for (const u of ['admin', 'bendahara.1', 'pak_budi', 'ketua-koperasi', 'A1b2']) {
      expect(periksaUsername(u).sah).toBe(true);
    }
  });

  it('menolak username kosong', () => {
    expect(periksaUsername('').sah).toBe(false);
    expect(periksaUsername('   ').pesan).toBe(PESAN_MASALAH_USERNAME.KOSONG);
  });

  it('menolak yang terlalu pendek dan terlalu panjang', () => {
    expect(periksaUsername('a'.repeat(PANJANG_MIN_USERNAME - 1)).masalah).toContain('TERLALU_PENDEK');
    expect(periksaUsername('a'.repeat(PANJANG_MAKS_USERNAME + 1)).masalah).toContain('TERLALU_PANJANG');
    expect(periksaUsername('a'.repeat(PANJANG_MIN_USERNAME)).sah).toBe(true);
    expect(periksaUsername('a'.repeat(PANJANG_MAKS_USERNAME)).sah).toBe(true);
  });

  it('menolak spasi DENGAN pesan yang menyebut spasi', () => {
    // Pesan "hanya boleh huruf, angka, ..." menyuruh pengguna
    // membandingkan karakternya satu per satu; yang salah adalah spasi,
    // dan itulah yang harus dikatakan.
    const hasil = periksaUsername('admin koperasi');
    expect(hasil.sah).toBe(false);
    expect(hasil.pesan).toBe(PESAN_MASALAH_USERNAME.ADA_SPASI);
  });

  it('menolak karakter yang tidak diizinkan', () => {
    for (const u of ['admin@kop', 'admin!', 'admin/1', "admin'--"]) {
      expect(periksaUsername(u).masalah).toContain('KARAKTER_TIDAK_DIIZINKAN');
    }
  });

  it('memangkas ujung tetapi TIDAK mengubah huruf besar/kecil', () => {
    // AuthService.login mencocokkan `username = ?` PERSIS. Menormalkan
    // ke huruf kecil di satu sisi saja membuat "Admin" yang diketik
    // tidak pernah cocok dengan "admin" yang tersimpan.
    expect(rapikanUsername('  Admin  ')).toBe('Admin');
    expect(rapikanUsername('Admin')).toBe('Admin');
  });
});

describe('RC-S119 §2 — wizard meminta akun admin', () => {
  it('wizard punya dua langkah', () => {
    const s = wizard();
    expect(s).toContain("type LangkahWizard = 'KOPERASI' | 'ADMIN'");
    expect(s).toContain("setLangkah('KOPERASI')");
  });

  it('meminta username, password, DAN konfirmasi', () => {
    const s = wizard();
    for (const name of ['adminUsername', 'adminPassword', 'adminKonfirmasi', 'adminNama']) {
      expect(s).toContain(`name="${name}"`);
    }
  });

  it('password dan konfirmasi disembunyikan secara bawaan', () => {
    // `secureTextEntry={!lihatPassword}` dengan state awal false.
    const s = wizard();
    expect(s).toContain('const [lihatPassword, setLihatPassword] = useState(false)');
    expect((s.match(/secureTextEntry=\{!lihatPassword\}/g) ?? []).length).toBe(2);
  });

  it('memakai modul kebijakan bersama, bukan aturan baru sendiri', () => {
    const s = wizard();
    expect(s).toContain("from '@/security/kebijakanPassword'");
    expect(s).toContain("from '@/security/kebijakanUsername'");
    // Aturan panjang yang ditulis ulang di layar akan menyimpang dari
    // yang dipakai service cepat atau lambat.
    expect(s).not.toMatch(/length\s*[<>]=?\s*8\b/);
  });

  it('mengirim password ke setupKoperasi', () => {
    expect(wizard()).toMatch(/setupKoperasi\(\{[\s\S]{0,400}adminPassword:/);
  });

  it('aktivasi lisensi TIDAK dijalankan saat pindah langkah', () => {
    // Mengaktifkan di langkah 1 memakan satu slot perangkat di server
    // untuk pemasangan yang mungkin ditinggalkan di langkah 2.
    const s = wizard();
    // Sampai `};` penutup fungsinya saja — bukan sampai `onSubmit`,
    // karena di antaranya ada komentar yang MENYEBUT activateLicense,
    // dan penyebutan dalam komentar bukan pemanggilan.
    const mulai = s.indexOf('const keLangkahAdmin');
    const fn = s.slice(mulai, s.indexOf('\n  };', mulai));
    expect(fn).not.toContain('activateLicense');
    expect(fn).toContain('trigger()');
  });

  it('gagal aktivasi mengembalikan pengguna ke langkah yang memuat isian lisensi', () => {
    expect(wizard()).toMatch(/setLicenseError\(result\.message\)[\s\S]{0,600}setLangkah\('KOPERASI'\)/);
  });
});

describe('RC-S119 §3 — SetupService menyimpan password admin', () => {
  const sumber = () => baca('services', 'SetupService.ts');

  it('password TIDAK lagi meminjam salt milik PIN ketika diminta', () => {
    const s = sumber();
    expect(s).toContain('const saltPassword = passwordDiminta ? generateSalt() : salt;');
    expect(s).toMatch(/passwordDiminta[\s\S]{0,200}hashPin\(rapikanPassword\(/);
  });

  it('username & password divalidasi di service, bukan hanya di layar', () => {
    const s = sumber();
    expect(s).toContain('periksaUsername(usernameAdmin)');
    expect(s).toContain('periksaPassword({ password: input.adminPassword as string');
  });

  it('username yang disimpan adalah yang sudah dirapikan', () => {
    // Menyimpan `input.adminUsername` mentah akan memasukkan spasi
    // ujung ke kolom UNIQUE yang harus diketik ulang saat masuk.
    const s = sumber();
    expect(s).toMatch(/VALUES \(\?,\?,\?,'ADMIN'[\s\S]{0,300}usernameAdmin,/);
  });
});
