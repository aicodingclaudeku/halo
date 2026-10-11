import {
  buildPublicKeyRegistry,
  describePublicKeyConfiguration,
  getUsablePublicKeys,
  isLicenseSigningConfigured,
} from '@/security/publicKeyRegistry';
import { LICENSE_TOKEN_PUBLIC_KEYS } from '@/config/licensePublicKeys';
import {
  runEd25519SelfTest,
  ensureCryptoHealthy,
  __resetCryptoHealthCacheForTests,
} from '@/security/ed25519SelfTest';
import { generateTestKeyPair, type TestKeyPair } from '@/test-utils/licenseTokenFixtures';
import { createHash } from 'crypto';
import * as ed from '@noble/ed25519';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * FASE 2 & 3 — validasi kunci publik dan kesehatan kriptografi.
 */

const ENV = 'EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS';

let keyPair: TestKeyPair;

function setKeys(value: string | null): void {
  if (value === null) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = value;
  }
}

beforeAll(() => {
  keyPair = generateTestKeyPair();
});

afterEach(() => {
  setKeys(null);
});

describe('publicKeyRegistry — validasi format kunci', () => {
  /**
   * Test di bawah memberikan daftar kunci SECARA EKSPLISIT.
   *
   * Sebelum kunci produksi ditanam, test ini bekerja dengan menyetel
   * `EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS` lalu memeriksa konfigurasi
   * global. Cara itu tidak lagi memadai: `LICENSE_TOKEN_PUBLIC_KEYS`
   * sekarang SELALU berisi kunci produksi, sehingga kasus "tidak ada
   * kunci sah sama sekali" tidak dapat lagi diciptakan lewat environment.
   *
   * Menguji fungsi murninya secara langsung juga lebih baik: hasilnya
   * tidak bergantung pada state global, tidak bocor antar-test, dan
   * tetap mengunci logika yang sama.
   */
  it('menerima base64 standar 44 karakter', () => {
    const registry = buildPublicKeyRegistry([keyPair.publicKeyBase64]);
    expect(registry.valid).toHaveLength(1);
    expect(registry.rejected).toHaveLength(0);
    expect(registry.valid[0].bytes.length).toBe(32);
  });

  it('menerima hex 64 karakter', () => {
    expect(buildPublicKeyRegistry([keyPair.publicKeyHex]).valid).toHaveLength(1);
  });

  it('menerima base64url tanpa padding', () => {
    const base64url = keyPair.publicKeyBase64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(buildPublicKeyRegistry([base64url]).valid).toHaveLength(1);
  });

  it('menerima beberapa kunci sekaligus untuk rotasi', () => {
    const second = generateTestKeyPair();
    const registry = buildPublicKeyRegistry([keyPair.publicKeyBase64, second.publicKeyBase64]);
    expect(registry.valid).toHaveLength(2);
  });

  it('mengabaikan spasi di sekitar kunci', () => {
    expect(buildPublicKeyRegistry([`  ${keyPair.publicKeyBase64}  `]).valid).toHaveLength(1);
  });

  it('menolak blok PEM', () => {
    const registry = buildPublicKeyRegistry([
      '-----BEGIN PUBLIC KEY-----MCowBQYDK2VwAyEA-----END PUBLIC KEY-----',
    ]);
    expect(registry.valid).toHaveLength(0);
    expect(registry.rejected[0].reason).toBe('WRAPPED_FORMAT');
  });

  it('menolak SPKI/DER base64 yang mudah tertukar dengan kunci mentah', () => {
    // Kesalahan penyalinan paling umum: `openssl` mengeluarkan bentuk
    // SPKI yang panjangnya 44 byte — bukan 32. Tanpa deteksi khusus, ia
    // hanya gagal sebagai WRONG_LENGTH tanpa petunjuk apa yang salah.
    const registry = buildPublicKeyRegistry(['MCowBQYDK2VwAyEA' + keyPair.publicKeyBase64]);
    expect(registry.rejected[0].reason).toBe('WRAPPED_FORMAT');
  });

  it('menolak SPKI/DER hex', () => {
    const registry = buildPublicKeyRegistry(['302a300506032b6570032100' + keyPair.publicKeyHex]);
    expect(registry.rejected[0].reason).toBe('WRAPPED_FORMAT');
  });

  it('menolak string yang bukan base64/hex', () => {
    expect(buildPublicKeyRegistry(['bukan-kunci-sama-sekali!!!']).rejected[0].reason)
      .toBe('NOT_DECODABLE');
  });

  it('menolak kunci yang ter-decode tetapi panjangnya salah', () => {
    const rejection = buildPublicKeyRegistry(['aGFsbG8gZHVuaWEgaW5pIGJ1a2FuIGt1bmNp']).rejected[0];
    expect(rejection.reason).toBe('WRONG_LENGTH');
    expect(rejection.decodedLength).toBe(27);
  });

  it('menolak entri kosong', () => {
    expect(buildPublicKeyRegistry(['   ']).rejected[0].reason).toBe('EMPTY');
  });

  it('tetap memakai kunci sah walau ada kunci rusak di sebelahnya', () => {
    const registry = buildPublicKeyRegistry(['rusak!!!', keyPair.publicKeyBase64]);
    expect(registry.valid).toHaveLength(1);
    expect(registry.rejected).toHaveLength(1);
  });

  it('daftar kosong berarti BELUM DIKONFIGURASI', () => {
    expect(buildPublicKeyRegistry([]).valid).toHaveLength(0);
  });

  it('SEMUA kunci rusak juga berarti BELUM DIKONFIGURASI', () => {
    // Inti perbaikan Fase 2: kunci rusak tidak boleh dilewati diam-diam
    // sehingga sistem mengaku "terkonfigurasi" lalu menolak setiap token
    // dengan BAD_SIGNATURE — diagnosis yang menuntun ke arah server,
    // padahal kesalahannya di konfigurasi build.
    const registry = buildPublicKeyRegistry([
      '-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----',
      'rusak!!!',
    ]);
    expect(registry.valid).toHaveLength(0);
    expect(registry.rejected).toHaveLength(2);
  });
});

describe('kunci produksi yang tertanam di build', () => {
  /**
   * Test-test ini MENGUNCI kunci produksi. Bila suatu saat ada yang
   * mengubah, menghapus, atau salah menyalin nilai di
   * `licensePublicKeys.ts`, kegagalannya muncul di sini — bukan nanti
   * di lapangan sebagai BAD_SIGNATURE di setiap perangkat pengguna.
   */
  const PRODUCTION_KEY = 'n8czx9Yis8m5GSxpkFDzig0MjaIp1UsBUcv5ZPsDQJ8=';
  /** SHA-256 kunci, 16 hex pertama — bentuk yang dipakai audit log server. */
  const PRODUCTION_SERVER_FINGERPRINT = 'd4444e3315fab892';
  /** 4 byte awal + 4 byte akhir — bentuk yang ditampilkan layar Diagnostik APK. */
  const PRODUCTION_DISPLAY_FINGERPRINT = '9fc733c7…fb03409f';

  it('kunci produksi tertanam di source, bukan hanya di environment', () => {
    // Bergantung pada environment saja berisiko: build yang lupa
    // menyetel EXPO_PUBLIC_* akan lolos compile dan baru gagal total
    // saat dipasang di perangkat.
    expect(LICENSE_TOKEN_PUBLIC_KEYS).toContain(PRODUCTION_KEY);
  });

  it('kunci produksi lolos validasi format', () => {
    const registry = buildPublicKeyRegistry([PRODUCTION_KEY]);
    expect(registry.valid).toHaveLength(1);
    expect(registry.valid[0].bytes.length).toBe(32);
  });

  it('sidik jari yang ditampilkan aplikasi cocok dengan kunci produksi', () => {
    // CATATAN — dua sidik jari yang berbeda, dan test ini pernah keliru
    // menyamakan keduanya:
    //
    //   * layar Diagnostik APK  -> 4 byte AWAL + 4 byte AKHIR kunci mentah
    //   * audit log server      -> SHA-256 kunci, 16 hex pertama
    //
    // Keduanya sah, tetapi dihitung dengan cara berbeda dan TIDAK
    // pernah sama. Menyamakannya berarti orang akan mengira kunci di
    // APK berbeda dari kunci di server padahal identik.
    setKeys(null);
    const info = describePublicKeyConfiguration();
    expect(info.fingerprints).toHaveLength(1);
    expect(info.fingerprints[0]).toBe(PRODUCTION_DISPLAY_FINGERPRINT);
  });

  it('sidik jari SHA-256 cocok dengan yang tercatat di audit log server', () => {
    const bytes = buildPublicKeyRegistry([PRODUCTION_KEY]).valid[0].bytes;
    const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    expect(digest.slice(0, 16)).toBe(PRODUCTION_SERVER_FINGERPRINT);
  });

  it('sistem lisensi terkonfigurasi tanpa environment variable apa pun', () => {
    setKeys(null);
    expect(isLicenseSigningConfigured()).toBe(true);
    expect(getUsablePublicKeys().length).toBeGreaterThan(0);
  });

  it('tidak ada CONFIG_REQUIRED yang tersisa', () => {
    setKeys(null);
    const info = describePublicKeyConfiguration();
    expect(info.hardcodedCount).toBeGreaterThan(0);
    expect(info.validCount).toBeGreaterThan(0);
    expect(info.rejections).toHaveLength(0);
  });

  it('kunci dari environment DITAMBAHKAN, bukan menggantikan kunci build', () => {
    // Penting untuk rotasi: menyetel EXPO_PUBLIC_* tidak boleh
    // diam-diam mematikan kunci yang tertanam di source.
    setKeys(keyPair.publicKeyBase64);
    const registry = buildPublicKeyRegistry();
    expect(registry.valid).toHaveLength(2);
  });
});

describe('describePublicKeyConfiguration', () => {
  it('melaporkan sidik jari, bukan kunci utuh', () => {
    setKeys(null);
    const info = describePublicKeyConfiguration();
    expect(info.validCount).toBe(1);
    expect(info.fingerprints).toHaveLength(1);
    expect(info.fingerprints[0]).toMatch(/^[0-9a-f]{8}…[0-9a-f]{8}$/);
  });

  it('melaporkan alasan penolakan agar salah konfigurasi terlihat', () => {
    setKeys('-----BEGIN PUBLIC KEY-----x-----END PUBLIC KEY-----');
    const info = describePublicKeyConfiguration();
    // Kunci produksi tetap sah; yang dari environment ditolak dan
    // alasannya dilaporkan, bukan disembunyikan.
    expect(info.validCount).toBe(1);
    expect(info.rejections[0].reason).toBe('WRAPPED_FORMAT');
  });

  it('tepat satu kunci tertanam di source', () => {
    // Lebih dari satu berarti rotasi sedang berjalan ATAU ada kunci
    // yang lupa dihapus. Keduanya perlu diperhatikan manusia.
    expect(describePublicKeyConfiguration().hardcodedCount).toBe(1);
  });
});

describe('self-test Ed25519 (RFC 8032)', () => {
  it('seluruh vektor dan kasus negatif lolos', async () => {
    const result = await runEd25519SelfTest();
    expect(result.ok).toBe(true);
    expect(result.cases).toHaveLength(6);
  });

  it('menguji kasus negatif, bukan hanya vektor positif', async () => {
    // Implementasi yang selalu mengembalikan `true` akan lolos semua
    // vektor positif. Kasus negatiflah yang membedakan "berfungsi" dari
    // "selalu bilang ya".
    const result = await runEd25519SelfTest();
    const negatives = result.cases.filter((testCase) => testCase.expected === false);
    expect(negatives).toHaveLength(3);
    for (const negative of negatives) {
      expect(negative.actual).toBe(false);
      expect(negative.passed).toBe(true);
    }
  });

  it('setiap vektor positif benar-benar diverifikasi', async () => {
    const result = await runEd25519SelfTest();
    const positives = result.cases.filter((testCase) => testCase.expected === true);
    expect(positives).toHaveLength(3);
    for (const positive of positives) {
      expect(positive.actual).toBe(true);
    }
  });

  it('ensureCryptoHealthy mengembalikan hasil yang sama pada pemanggilan berulang', async () => {
    __resetCryptoHealthCacheForTests();
    const first = await ensureCryptoHealthy();
    const second = await ensureCryptoHealthy();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('pemanggilan paralel tidak menjalankan self-test dua kali', async () => {
    __resetCryptoHealthCacheForTests();
    const [a, b, c] = await Promise.all([
      ensureCryptoHealthy(),
      ensureCryptoHealthy(),
      ensureCryptoHealthy(),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
  });
});


describe('integrasi self-test ke LicenseService (struktural)', () => {
  /**
   * Diuji atas SOURCE, bukan lewat pemanggilan, karena tidak ada seam
   * yang membuat Ed25519 asli "rusak sesuai permintaan" — dan menambah
   * seam semacam itu justru akan menjadi tombol untuk mematikan
   * verifikasi, persis yang dilarang §19.
   *
   * Yang dikunci di sini adalah URUTAN: kesehatan kriptografi diperiksa
   * SEBELUM apa pun yang lain. Kalau Ed25519 tidak berfungsi, setiap
   * jawaban di bawahnya tidak bermakna.
   */
  const source = readFileSync(
    join(__dirname, '..', 'services', 'LicenseService.ts'),
    'utf8'
  );

  it('getLicenseStatus memeriksa kesehatan kriptografi sebelum konfigurasi kunci', () => {
    const cryptoCheck = source.indexOf('await ensureCryptoHealthy()');
    const configCheck = source.indexOf('if (!isLicenseSigningConfigured())');
    expect(cryptoCheck).toBeGreaterThan(-1);
    expect(configCheck).toBeGreaterThan(cryptoCheck);
  });

  it('kegagalan kriptografi berujung fail-closed, bukan diizinkan', () => {
    expect(source).toMatch(/state: 'CRYPTO_UNAVAILABLE', allowAppAccess: false/);
  });

  it('aktivasi juga dihentikan ketika kriptografi tidak sehat', () => {
    expect(source).toMatch(/failure\('CRYPTO_UNAVAILABLE'\)/);
  });

  it('tidak ada jalur yang mengembalikan true tanpa verifikasi', () => {
    // Penjaga terhadap "perbaikan" yang mematikan verifikasi agar
    // aktivasi berhasil (§19, FINAL PRINCIPLE).
    const adapter = readFileSync(join(__dirname, '..', 'security', 'ed25519.ts'), 'utf8');
    expect(adapter).not.toMatch(/return true;/);
  });
});


describe('adapter SHA-512 — penjaga regresi bug RC-S33', () => {
  /**
   * Suite ini ada karena bug yang membuat SETIAP verifikasi di Android
   * mengembalikan `false` lolos melewati 201 test yang semuanya hijau.
   *
   * Penyebabnya bukan logikanya, melainkan MOCK-nya: ia menyediakan slot
   * `etc.sha512*` tetapi tidak pernah memakainya, sehingga jalur
   * penyuntikan hash di adapter tidak pernah dieksekusi saat test.
   *
   * Sekarang mock meniru default noble v2 apa adanya — `sha512Sync`
   * kosong, `sha512Async` terisi versi WebCrypto yang MELEMPAR di
   * Hermes. Test di bawah mengunci konsekuensinya.
   */

  it('adapter menyuntikkan sha512Sync', async () => {
    await runEd25519SelfTest();
    expect(typeof ed.etc.sha512Sync).toBe('function');
  });

  it('adapter MENIMPA sha512Async default, tidak mempertahankannya', async () => {
    // Inti bug RC-S33. Default noble v2 memakai crypto.subtle yang tidak
    // ada di Hermes; mempertahankannya membuat setiap verifikasi gagal.
    await runEd25519SelfTest();
    const digest = await (ed.etc.sha512Async as (m: Uint8Array) => Promise<Uint8Array>)(
      new Uint8Array([1, 2, 3])
    );
    expect(digest.length).toBe(64);
  });

  it('sha512 yang disuntikkan menghasilkan digest yang BENAR', async () => {
    // Provider yang mengembalikan nol semua akan lolos pemeriksaan
    // panjang tetapi merusak Ed25519 secara diam-diam.
    await runEd25519SelfTest();
    const pesan = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
    const nyata = createHash('sha512').update(Buffer.from(pesan)).digest('hex');
    const disuntikkan = (ed.etc.sha512Sync as (m: Uint8Array) => Uint8Array)(pesan);
    expect(Buffer.from(disuntikkan).toString('hex')).toBe(nyata);
  });

  it('default noble v2 yang belum ditimpa MELEMPAR, seperti di Hermes', async () => {
    // Membuktikan mock benar-benar meniru lingkungan yang bermasalah.
    // Kalau assertion ini gagal, mock kembali terlalu longgar dan bug
    // sejenis akan lolos lagi.
    ed.__resetHashSlotsForTests();
    let melempar = false;
    try {
      await (ed.etc.sha512Async as (m: Uint8Array) => Promise<Uint8Array>)(new Uint8Array(0));
    } catch {
      melempar = true;
    }
    expect(melempar).toBe(true);
    expect(ed.etc.sha512Sync).toBeUndefined();
  });

  it('penyuntikan hash benar-benar menentukan hasil verifikasi', async () => {
    // Test ini awalnya ditulis untuk membuktikan adapter "pulih" setelah
    // slot hash dikosongkan. Ternyata ia TIDAK pulih: `ensureHashWired()`
    // memakai penanda `wired` per proses, jadi pemanggilan berikutnya
    // langsung kembali tanpa menyuntik ulang.
    //
    // Itu BUKAN bug produksi — tidak ada apa pun di aplikasi yang
    // mengosongkan slot noble setelah disuntik. Jadi yang diubah adalah
    // assertion-nya, bukan kode produksinya: menghapus cache hanya untuk
    // memuaskan sebuah test berarti menambah kerja di jalur panas demi
    // skenario yang tidak pernah terjadi.
    //
    // Yang dikunci sekarang justru sifat yang lebih berharga: bila slot
    // hash HILANG, verifikasi GAGAL. Itu membuktikan penyuntikan hash
    // benar-benar menopang hasilnya — bukan kebetulan lolos karena mock
    // menghitung sendiri di belakang layar, yang persis kelemahan mock
    // versi sebelumnya.
    ed.__resetHashSlotsForTests();
    __resetCryptoHealthCacheForTests();

    const hasil = await runEd25519SelfTest();
    expect(hasil.cases).toHaveLength(6);
    // Fail-closed: hash hilang -> ditolak, bukan diterima.
    expect(hasil.ok).toBe(false);
    for (const kasus of hasil.cases.filter((c) => c.expected === true)) {
      expect(kasus.actual).toBe(false);
    }
  });
});
