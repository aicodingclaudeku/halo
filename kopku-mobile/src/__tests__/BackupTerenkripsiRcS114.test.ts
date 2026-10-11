import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MAGIC_BACKUP,
  MAGIC_SQLITE,
  VERSI_FORMAT_SEKARANG,
  PANJANG_TAG,
  PANJANG_KUNCI,
  PANJANG_NONCE,
  PANJANG_PREFIKS_NONCE,
  UKURAN_SEGMEN_BAWAAN,
  HeaderBackup,
  rakitPendahuluan,
  bacaPendahuluan,
  validasiHeader,
  jumlahSegmen,
  nonceSegmen,
  ukuranPlaintextSegmen,
  kenaliJenisBerkas,
  keBase64,
  dariBase64,
  teksKeBytes,
  bytesKeTeks,
  gabungBytes,
} from '@/backup/FormatBackupTerenkripsi';
import {
  enkripsiSeluruhnya,
  dekripsiSeluruhnya,
  enkripsiSegmen,
  dekripsiSegmen,
  aadSegmen,
  bungkusKunci,
  bukaKunci,
  buatSlot,
  cariSlot,
  turunkanKunciDariKode,
  PARAMETER_SCRYPT_BAWAAN,
} from '@/backup/MesinKriptoBackup';
import {
  susunKodePemulihan,
  periksaKodePemulihan,
  rapikanKodePemulihan,
  karakterPeriksa,
  formatKodePemulihan,
  ABJAD_KODE,
  PANJANG_DATA_KODE,
} from '@/backup/KodePemulihan';

/**
 * Pembuang komentar untuk assertion struktural.
 *
 * HATI-HATI — dan ini bukan kehati-hatian teoretis: `BackupService.ts`
 * memuat penyaring MIME untuk pemilih berkas, yaitu string berisi
 * bintang, garis miring, bintang. Di dalam string itu ada urutan
 * karakter yang TERLIHAT seperti pembuka komentar blok. Pembuang
 * komentar yang naif menganggapnya komentar dan menelan seluruh sisa
 * berkas — sehingga assertion di bawahnya memeriksa teks yang sudah
 * terpotong dan bisa lulus tanpa memeriksa apa pun.
 *
 * (Komentar ini pun sengaja TIDAK menuliskan urutan itu apa adanya:
 * menuliskannya akan menutup komentar ini sendiri di tengah kalimat.)
 *
 * Karena itu komentar blok hanya dibuang bila ia MEMULAI BARIS. Seluruh
 * komentar dokumentasi di proyek ini berbentuk begitu, sedangkan
 * kemunculan di tengah baris — yang hampir pasti bagian dari string —
 * dibiarkan.
 */
function tanpaKomentarSumber(teks: string): string {
  return teks
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
}


/**
 * ============================================================
 * RC-S114 — BACKUP TERENKRIPSI TERAUTENTIKASI
 * ============================================================
 *
 * BATAS YANG DIJAGA SUITE INI.
 *
 * Sampai RC-S113 berkas `.kdb` adalah salinan mentah SQLite: siapa pun
 * yang memegangnya bisa membaca NIK, tanggal lahir, alamat, nomor HP,
 * dan seluruh saldo setiap anggota. Berkas itu justru dirancang untuk
 * KELUAR dari perangkat lewat tombol Bagikan.
 *
 * Enkripsi yang "kelihatan jalan" mudah dibuat; yang sulit adalah
 * memastikan ia MENOLAK hal-hal yang harus ditolak. Karena itu suite
 * ini lebih banyak menguji penolakan daripada keberhasilan:
 *
 *   - berkas yang diubah satu byte,
 *   - berkas yang DIPOTONG (serangan yang lolos kalau hanya pakai tag
 *     per segmen tanpa pengikat posisi),
 *   - segmen yang DITUKAR URUTANNYA,
 *   - header yang diutak-atik,
 *   - slot kunci yang dipindah perannya,
 *   - kunci yang salah.
 *
 * Satu keberhasilan yang juga wajib dijaga: backup LAMA yang belum
 * terenkripsi harus tetap dikenali, karena pengguna punya arsip
 * berbulan-bulan yang tidak boleh mendadak tidak terbaca.
 */

const kunciBerkas = new Uint8Array(PANJANG_KUNCI).fill(0x11);
const kunciPerangkat = new Uint8Array(PANJANG_KUNCI).fill(0x22);
const prefiks = new Uint8Array(PANJANG_PREFIKS_NONCE).fill(0x33);

function buatHeader(ukuranAsli: number, ukuranSegmen = 64): HeaderBackup {
  return {
    v: VERSI_FORMAT_SEKARANG,
    alg: 'xchacha20poly1305',
    ukuranSegmen,
    totalSegmen: jumlahSegmen(ukuranAsli, ukuranSegmen),
    ukuranAsli,
    prefiksNonce: keBase64(prefiks),
    dibuatPada: '2026-09-29T00:00:00.000Z',
    skema: 78,
    pembungkus: [
      buatSlot({
        jenis: 'PERANGKAT',
        kunciBerkas,
        kunciPembungkus: kunciPerangkat,
        nonce: new Uint8Array(PANJANG_NONCE).fill(0x44),
        idInstalasi: 'instalasi-uji',
      }),
    ],
  };
}

function dataUji(n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i * 7 + 11) & 0xff;
  return d;
}

function berkasLengkap(data: Uint8Array, ukuranSegmen = 64) {
  const header = buatHeader(data.length, ukuranSegmen);
  const pendahuluan = rakitPendahuluan(header);
  const badan = enkripsiSeluruhnya({ data, kunciBerkas, header, bytesPendahuluan: pendahuluan });
  return { header, pendahuluan, badan, berkas: gabungBytes(pendahuluan, badan) };
}

describe('RC-S114 — perjalanan pulang-pergi', () => {
  test('database dipulihkan persis sama, byte per byte', () => {
    const data = dataUji(1000);
    const { header, pendahuluan, badan } = berkasLengkap(data);
    const kembali = dekripsiSeluruhnya({ data: badan, kunciBerkas, header, bytesPendahuluan: pendahuluan });
    expect(Array.from(kembali)).toEqual(Array.from(data));
  });

  test('ciphertext tidak memuat plaintext apa pun', () => {
    // Uji paling dasar dan paling mudah dilupakan: kalau pipa
    // enkripsinya salah pasang, data bisa lewat apa adanya.
    const rahasia = teksKeBytes('NIK 3201234567890001 Ahmad Subekti');
    const { badan } = berkasLengkap(rahasia);
    expect(bytesKeTeks(badan)).not.toContain('3201234567890001');
    expect(bytesKeTeks(badan)).not.toContain('Ahmad');
  });

  test('ukuran berkas = pendahuluan + data + satu tag per segmen', () => {
    const data = dataUji(200); // 64 B/segmen -> 4 segmen (64,64,64,8)
    const { header, badan } = berkasLengkap(data);
    expect(header.totalSegmen).toBe(4);
    expect(badan.length).toBe(200 + 4 * PANJANG_TAG);
  });

  test('berkas kosong dan berkas tepat satu segmen tetap sah', () => {
    for (const n of [0, 1, 64, 65, 128]) {
      const data = dataUji(n);
      const { header, pendahuluan, badan } = berkasLengkap(data);
      const kembali = dekripsiSeluruhnya({ data: badan, kunciBerkas, header, bytesPendahuluan: pendahuluan });
      expect(kembali.length).toBe(n);
    }
  });
});

describe('RC-S114 — penolakan berkas yang diutak-atik', () => {
  test('satu byte ciphertext diubah -> ditolak', () => {
    const { header, pendahuluan, badan } = berkasLengkap(dataUji(500));
    const rusak = Uint8Array.from(badan);
    rusak[10] ^= 0x01;
    expect(() => dekripsiSeluruhnya({ data: rusak, kunciBerkas, header, bytesPendahuluan: pendahuluan })).toThrow();
  });

  test('BERKAS DIPOTONG -> ditolak (bukan dipulihkan sebagian)', () => {
    // Inilah alasan penanda "segmen terakhir" ada. Tanpa itu, memotong
    // berkas menghasilkan database yang lebih pendek namun setiap
    // segmennya tetap lolos verifikasi — kerusakan senyap terburuk yang
    // bisa menimpa buku besar.
    const data = dataUji(500);
    const { header, pendahuluan, badan } = berkasLengkap(data);
    const potong = badan.subarray(0, badan.length - (64 + PANJANG_TAG));
    expect(() =>
      dekripsiSeluruhnya({ data: potong, kunciBerkas, header, bytesPendahuluan: pendahuluan })
    ).toThrow();
  });

  test('segmen terakhir yang sah tidak dapat dipindah ke posisi lain', () => {
    const data = dataUji(128); // 2 segmen penuh berukuran sama
    const { header, pendahuluan } = berkasLengkap(data, 64);
    const aad = aadSegmen(pendahuluan);
    const segmenTerakhir = enkripsiSegmen({
      plaintext: data.subarray(64, 128),
      kunciBerkas,
      prefiksNonce: prefiks,
      indeks: 1,
      terakhir: true,
      aad,
    });
    // Dibaca sebagai segmen 0 (bukan penutup) -> harus gagal.
    expect(() =>
      dekripsiSegmen({
        ciphertext: segmenTerakhir,
        kunciBerkas,
        prefiksNonce: prefiks,
        indeks: 0,
        terakhir: false,
        aad,
      })
    ).toThrow();
  });

  test('penanda segmen-terakhir benar-benar mengikat, bukan hiasan', () => {
    // Uji yang MENGISOLASI penanda akhir: indeks sama, hanya penandanya
    // berbeda. Tanpa uji ini, mematikan penanda hanya tertangkap secara
    // kebetulan oleh pembukuan panjang — dan pembukuan panjang bukan
    // jaminan kriptografis.
    const data = dataUji(64);
    const { pendahuluan } = berkasLengkap(data, 64);
    const aad = aadSegmen(pendahuluan);
    const sebagaiPenutup = enkripsiSegmen({
      plaintext: data,
      kunciBerkas,
      prefiksNonce: prefiks,
      indeks: 0,
      terakhir: true,
      aad,
    });
    expect(() =>
      dekripsiSegmen({
        ciphertext: sebagaiPenutup,
        kunciBerkas,
        prefiksNonce: prefiks,
        indeks: 0,
        terakhir: false,
        aad,
      })
    ).toThrow();
  });

  test('segmen yang ditukar urutannya -> ditolak', () => {
    const data = dataUji(192); // 3 segmen 64 B
    const { header, pendahuluan, badan } = berkasLengkap(data, 64);
    const besarSegmen = 64 + PANJANG_TAG;
    const s0 = badan.subarray(0, besarSegmen);
    const s1 = badan.subarray(besarSegmen, besarSegmen * 2);
    const s2 = badan.subarray(besarSegmen * 2);
    const ditukar = gabungBytes(s1, s0, s2);
    expect(() => dekripsiSeluruhnya({ data: ditukar, kunciBerkas, header, bytesPendahuluan: pendahuluan })).toThrow();
  });

  test('header diutak-atik -> seluruh segmen gagal dibuka', () => {
    // Header tidak dienkripsi (ia memuat salt yang dibutuhkan SEBELUM
    // ada kunci), jadi satu-satunya perlindungannya adalah ia menjadi
    // AAD setiap segmen.
    const { header, pendahuluan, badan } = berkasLengkap(dataUji(300));
    const palsu = rakitPendahuluan({ ...header, dibuatPada: '2020-01-01T00:00:00.000Z' });
    expect(() => dekripsiSeluruhnya({ data: badan, kunciBerkas, header, bytesPendahuluan: palsu })).toThrow();
  });

  test('kunci berkas yang salah -> ditolak', () => {
    const { header, pendahuluan, badan } = berkasLengkap(dataUji(300));
    const kunciLain = new Uint8Array(PANJANG_KUNCI).fill(0x99);
    expect(() =>
      dekripsiSeluruhnya({ data: badan, kunciBerkas: kunciLain, header, bytesPendahuluan: pendahuluan })
    ).toThrow();
  });
});

describe('RC-S114 — pembungkus kunci', () => {
  test('kunci berkas kembali utuh lewat slot perangkat', () => {
    const header = buatHeader(100);
    const slot = cariSlot(header, 'PERANGKAT')!;
    expect(Array.from(bukaKunci(slot, kunciPerangkat))).toEqual(Array.from(kunciBerkas));
  });

  test('kunci pembungkus salah -> ditolak, bukan mengembalikan sampah', () => {
    const slot = cariSlot(buatHeader(100), 'PERANGKAT')!;
    expect(() => bukaKunci(slot, new Uint8Array(PANJANG_KUNCI).fill(0x55))).toThrow();
  });

  test('slot tidak bisa dipindah perannya', () => {
    // Peran ikut diautentikasi sebagai AAD. Tanpa itu, slot perangkat
    // bisa dipasang di posisi slot kode pemulihan dan tetap terbuka,
    // sehingga pembatasan "kode pemulihan wajib" bisa dilewati.
    const slot = cariSlot(buatHeader(100), 'PERANGKAT')!;
    const menyamar = { ...slot, jenis: 'KODE_PEMULIHAN' as const };
    expect(() => bukaKunci(menyamar, kunciPerangkat)).toThrow();
  });

  test('kode pemulihan membuka kunci berkas yang sama', () => {
    const acak = new Uint8Array(13).fill(0x5a);
    const kode = susunKodePemulihan(acak);
    const salt = new Uint8Array(16).fill(0x66);
    const kunciKode = turunkanKunciDariKode(kode, salt);
    const slot = buatSlot({
      jenis: 'KODE_PEMULIHAN',
      kunciBerkas,
      kunciPembungkus: kunciKode,
      nonce: new Uint8Array(PANJANG_NONCE).fill(0x77),
      kdf: { ...PARAMETER_SCRYPT_BAWAAN, salt: keBase64(salt) },
    });
    expect(Array.from(bukaKunci(slot, turunkanKunciDariKode(kode, salt)))).toEqual(Array.from(kunciBerkas));
  });

  test('scrypt dipanggil dengan parameter yang benar-benar mahal', () => {
    // N=2^15, r=8 -> 32 MiB. Kalau suatu saat diturunkan diam-diam,
    // penebakan offline terhadap kode pemulihan jadi jauh lebih murah.
    expect(PARAMETER_SCRYPT_BAWAAN.N).toBeGreaterThanOrEqual(32768);
    expect(PARAMETER_SCRYPT_BAWAAN.r).toBeGreaterThanOrEqual(8);
  });
});

describe('RC-S114 — kode pemulihan', () => {
  test('bentuknya 21 karakter dalam grup empat', () => {
    const kode = susunKodePemulihan(new Uint8Array(13).fill(0xa5));
    expect(rapikanKodePemulihan(kode)).toHaveLength(PANJANG_DATA_KODE + 1);
    expect(kode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}-[0-9A-Z]$/);
    expect(periksaKodePemulihan(kode)).toBe('SAH');
  });

  test('abjadnya membuang huruf yang tertukar saat ditulis tangan', () => {
    // Kode ini memang dimaksudkan untuk dicetak atau ditulis tangan.
    for (const c of ['I', 'L', 'O', 'U']) expect(ABJAD_KODE).not.toContain(c);
  });

  test('salah ketik satu karakter tertangkap sebagai salah ketik', () => {
    const kode = susunKodePemulihan(new Uint8Array(13).fill(0x3c));
    const bersih = rapikanKodePemulihan(kode);
    const lain = ABJAD_KODE[(ABJAD_KODE.indexOf(bersih[0]) + 1) % 32];
    expect(periksaKodePemulihan(lain + bersih.slice(1))).toBe('PERIKSA_GAGAL');
  });

  test('O/I/L yang tertulis manusia dibetulkan, bukan ditolak', () => {
    // Menolak masukan yang persis seperti di kertas adalah cara
    // tercepat membuat orang menyerah pada pemulihan yang sebenarnya
    // masih mungkin.
    expect(rapikanKodePemulihan('o1i-l0O')).toBe('011100');
    expect(rapikanKodePemulihan(' abcd-efgh ')).toBe('ABCDEFGH');
  });

  test('panjang & karakter asing dibedakan dari salah ketik', () => {
    expect(periksaKodePemulihan('ABC')).toBe('PANJANG_SALAH');
    expect(periksaKodePemulihan('!'.repeat(21))).toBe('KARAKTER_ASING');
  });

  test('kode yang tidak sah tidak pernah sampai ke scrypt', () => {
    // Menjalankan scrypt 32 MiB untuk kode yang jelas salah ketik
    // hanya membuat pengguna menunggu beberapa detik untuk kegagalan
    // yang sudah bisa dipastikan sejak awal.
    expect(() => turunkanKunciDariKode('SALAH', new Uint8Array(16))).toThrow(/karakter/i);
  });

  test('byte acak berbeda menghasilkan kode berbeda', () => {
    const a = susunKodePemulihan(new Uint8Array(13).fill(1));
    const b = susunKodePemulihan(new Uint8Array(13).fill(2));
    expect(a).not.toBe(b);
  });

  test('karakterPeriksa konsisten dengan formatnya', () => {
    const data = 'ABCD1234ABCD1234ABCD';
    expect(formatKodePemulihan(data + karakterPeriksa(data))).toContain('-');
  });
});

describe('RC-S114 — header & pengenalan berkas', () => {
  test('pendahuluan bolak-balik utuh', () => {
    const header = buatHeader(500);
    const dibaca = bacaPendahuluan(rakitPendahuluan(header));
    expect(dibaca.versi).toBe(VERSI_FORMAT_SEKARANG);
    expect(dibaca.header.ukuranAsli).toBe(500);
    expect(dibaca.header.pembungkus).toHaveLength(1);
  });

  test('versi format yang lebih baru ditolak dengan pesan yang berguna', () => {
    const header = buatHeader(100);
    const bytes = rakitPendahuluan(header);
    bytes[9] = 99; // versi 99
    expect(() => bacaPendahuluan(bytes)).toThrow(/versi aplikasi yang lebih baru/i);
  });

  test('header yang mengaku punya segmen lebih sedikit daripada isinya ditolak', () => {
    // Tanpa pemeriksaan ini, pemulihan berhenti diam-diam di tengah
    // database dan hasilnya tampak "berhasil".
    const header = buatHeader(500, 64);
    expect(() => validasiHeader({ ...header, totalSegmen: 2 })).toThrow(/tidak cocok/i);
  });

  test('nilai header yang tidak masuk akal ditolak sebelum dipakai', () => {
    // Header dibaca SEBELUM ada kunci, jadi belum terautentikasi pada
    // titik itu — angka raksasa di sana akan dipakai sebagai batas
    // perulangan atau ukuran alokasi.
    const h = buatHeader(100);
    expect(() => validasiHeader({ ...h, ukuranSegmen: 0 })).toThrow();
    expect(() => validasiHeader({ ...h, ukuranSegmen: 999999999 })).toThrow();
    expect(() => validasiHeader({ ...h, totalSegmen: -1 })).toThrow();
    expect(() => validasiHeader({ ...h, alg: 'rot13' as never })).toThrow();
    expect(() => validasiHeader({ ...h, pembungkus: [] })).toThrow();
  });

  test('backup LAMA (SQLite polos) tetap dikenali', () => {
    // Pengguna punya arsip berbulan-bulan; tidak boleh mendadak tidak
    // terbaca hanya karena aplikasinya diperbarui.
    expect(kenaliJenisBerkas(teksKeBytes(MAGIC_SQLITE + 'sisanya'))).toBe('SQLITE_LAMA');
    expect(kenaliJenisBerkas(teksKeBytes(MAGIC_BACKUP + '\u0000\u0001'))).toBe('TERENKRIPSI');
    expect(kenaliJenisBerkas(teksKeBytes('berkas lain'))).toBe('TIDAK_DIKENAL');
  });

  test('base64 bolak-balik untuk seluruh nilai byte', () => {
    const semua = new Uint8Array(256);
    for (let i = 0; i < 256; i++) semua[i] = i;
    expect(Array.from(dariBase64(keBase64(semua)))).toEqual(Array.from(semua));
    for (let n = 0; n < 8; n++) {
      const b = semua.subarray(0, n);
      expect(Array.from(dariBase64(keBase64(b)))).toEqual(Array.from(b));
    }
  });

  test('nonce segmen berbeda untuk setiap indeks dan penanda akhir', () => {
    const a = nonceSegmen(prefiks, 0, false);
    const b = nonceSegmen(prefiks, 1, false);
    const c = nonceSegmen(prefiks, 0, true);
    expect(a).toHaveLength(PANJANG_NONCE);
    expect(Array.from(a)).not.toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  test('ukuran segmen terakhir dihitung benar', () => {
    const h = buatHeader(200, 64);
    expect([0, 1, 2, 3].map((i) => ukuranPlaintextSegmen(h, i))).toEqual([64, 64, 64, 8]);
  });

  test('ukuran segmen bawaan membatasi puncak pemakaian memori', () => {
    // Database koperasi bisa puluhan MB; mengenkripsi sekaligus berarti
    // menahan plaintext dan ciphertext bersamaan di memori.
    expect(UKURAN_SEGMEN_BAWAAN).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe('RC-S114 — invarian jalur backup/restore (struktural)', () => {
  const baca = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const tanpaKomentar = tanpaKomentarSumber;

  const service = tanpaKomentar(baca('services/BackupService.ts'));
  const io = tanpaKomentar(baca('backup/BerkasBackupIO.ts'));

  test('backup TIDAK lagi menyalin database apa adanya', () => {
    // Inti seluruh perubahan ini. Kalau `copyAsync(dbAktif -> backup)`
    // kembali, seluruh enkripsi menjadi hiasan.
    expect(service).toContain('tulisBackupTerenkripsi(');
    expect(service).not.toMatch(/copyAsync\(\{\s*from:\s*getDatabaseFilePath\(\)/);
  });

  test('kunci berkas tidak pernah disimpan di luar berkas', () => {
    const keystore = tanpaKomentar(baca('security/backupKeyStore.ts'));
    // Yang boleh disimpan hanya kunci PERANGKAT, kode pemulihan, dan id
    // instalasi. Kunci berkas acak per backup dan hanya ada di dalam
    // berkas itu sendiri, dalam bentuk terbungkus.
    expect(keystore).not.toContain('kunciBerkas');
    expect(io).toContain('Crypto.getRandomBytes(PANJANG_KUNCI)');
  });

  test('setiap backup memasang KEDUA slot kunci', () => {
    // Tanpa slot kode pemulihan, backup menjadi tidak berguna tepat
    // saat paling dibutuhkan: ponsel hilang atau diganti.
    // Diperiksa PADA LARIK `pembungkus` yang benar-benar ditulis ke
    // berkas, bukan sekadar "string-nya ada di suatu tempat di berkas
    // ini" — kedua nama itu juga muncul di tipe CaraBuka dan di jalur
    // pembukaan kunci, sehingga pemeriksaan longgar tetap lulus
    // meskipun salah satu slot tidak pernah dipasang.
    const awal = io.indexOf('const pembungkus: SlotPembungkus[] = [');
    const larik = io.slice(awal, io.indexOf('];', awal));
    expect(awal).toBeGreaterThan(-1);
    expect(larik).toContain("jenis: 'PERANGKAT'");
    expect(larik).toContain("jenis: 'KODE_PEMULIHAN'");
    expect((larik.match(/jenis: '/g) ?? []).length).toBe(2);
  });

  test('prefiks nonce & kunci berkas selalu BARU tiap backup', () => {
    // Memakai ulang pasangan kunci+nonce pada dua berkas berbeda
    // meruntuhkan jaminan XChaCha20-Poly1305 sepenuhnya.
    expect(io).toContain('Crypto.getRandomBytes(PANJANG_PREFIKS_NONCE)');
    expect(io).not.toMatch(/prefiksNonce\s*=\s*new Uint8Array/);
  });

  test('restore menghapus `.previous` hanya SETELAH database baru terbukti bisa dibuka', () => {
    // TEMUAN AUDIT (T-2). Sebelumnya `.previous` dihapus tepat setelah
    // penukaran berkas — yaitu sebelum `getDb()` membuktikan database
    // baru dapat dibuka. Bila pembukaan gagal, database lama sudah
    // lenyap dan self-heal di db.ts tidak punya apa pun untuk
    // dipulihkan.
    const iSwap = service.indexOf('to: liveDbPath });');
    const iGetDb = service.indexOf('await getDb();', iSwap);
    const iHapus = service.indexOf('deleteAsync(previousPath', iSwap);
    expect(iSwap).toBeGreaterThan(-1);
    expect(iGetDb).toBeGreaterThan(-1);
    expect(iHapus).toBeGreaterThan(iGetDb);
  });

  test('restore yang gagal dibuka mengembalikan database lama', () => {
    expect(service).toContain("moveAsync({ from: previousPath, to: liveDbPath })");
    expect(service).toContain('Data sebelum restore sudah dikembalikan');
  });

  test('database AKTIF tidak disentuh sebelum validasi lulus', () => {
    const iValidasi = service.indexOf('const validasi = await validasiFileBackup(');
    const iTutup = service.indexOf('await closeDb();', iValidasi);
    expect(iValidasi).toBeGreaterThan(-1);
    expect(iTutup).toBeGreaterThan(iValidasi);
  });

  test('berkas backup lama tetap dapat dipulihkan', () => {
    // Pengguna punya arsip berbulan-bulan; enkripsi tidak boleh
    // membuatnya mendadak tidak terbaca.
    expect(service).toContain("periksa.jenis === 'SQLITE_LAMA'");
  });

  test('enkripsi ulang membuktikan hasilnya bisa dibuka sebelum menimpa', () => {
    // Tanpa langkah ini, kesalahan apa pun di jalur enkripsi akan
    // menghancurkan cadangan yang tadinya masih terbaca.
    const i = service.indexOf('export async function enkripsiUlangBackupLama');
    const blok = service.slice(i, service.indexOf('export async function', i + 10));
    expect(blok.indexOf('dekripsiBackupKeBerkas')).toBeGreaterThan(-1);
    expect(blok.indexOf('dekripsiBackupKeBerkas')).toBeLessThan(blok.indexOf('moveAsync({ from: sementara'));
  });

  test('berkas sementara hasil dekripsi selalu dibersihkan', () => {
    expect(service).toContain('deleteAsync(uriSementara, { idempotent: true })');
  });
});

describe('RC-S114 — hash PIN', () => {
  const baca = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  test('PIN baru ditulis dengan scrypt, bukan SHA-256 satu putaran', () => {
    const pinHash = baca('security/pinHash.ts');
    expect(pinHash).toContain('VERSI_HASH_PIN_SEKARANG: VersiHashPin = 2');
    expect(pinHash).toContain('scrypt(teksKeBytes(pin)');
  });

  test('hash warisan tetap dapat diverifikasi, lalu dinaikkan', () => {
    // Menolak hash lama akan mengunci pengurus di luar aplikasinya
    // sendiri. Kenaikan dilakukan saat login berhasil — satu-satunya
    // saat PIN memang ada di tangan.
    const auth = baca('services/AuthService.ts');
    // DIPERBARUI RC-S117: `verifikasiDanNaikkanPin` menjadi
    // `verifikasiDanNaikkan` dengan parameter kolom, karena kini ada
    // DUA kredensial terpisah — password (masuk) dan PIN (kunci
    // aplikasi). Digabung begitu supaya keduanya tidak mungkin
    // berbeda dalam hal yang menentukan: perbandingan waktu tetap
    // dan kenaikan versi hash.
    expect(auth).toContain('verifikasiDanNaikkan(');
    expect(auth).toContain('hasil.perluDinaikkan');
    const pinHash = baca('security/pinHash.ts');
    expect(pinHash).toContain('export function hashPinV1');
  });

  test('perbandingan hash memakai waktu tetap', () => {
    const pinHash = baca('security/pinHash.ts');
    expect(pinHash).toContain('beda |= a.charCodeAt(i) ^ b.charCodeAt(i)');
    expect(pinHash).not.toMatch(/return hashPin\([^)]*\) === hashTersimpan/);
  });

  test('migrasi menandai baris lama sebagai v1, bukan v2', () => {
    // Menandai hash lama sebagai v2 membuat SELURUH PIN yang ada gagal
    // diverifikasi.
    const db = baca('database/db.ts');
    expect(db).toContain('ADD COLUMN pin_hash_versi INTEGER NOT NULL DEFAULT 1');
  });
});

describe('RC-S116 — kegagalan kunci tidak boleh jadi jalan buntu', () => {
  const baca = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const tanpaKomentar = tanpaKomentarSumber;

  const service = tanpaKomentar(baca('services/BackupService.ts'));
  const layar = tanpaKomentar(baca('screens/Pengaturan/BackupRestoreScreen.tsx'));

  /**
   * BUG YANG DIJAGA (dilaporkan pengguna).
   *
   * Memilih berkas backup dari luar aplikasi ("Impor File Backup
   * Lain") yang dibuat di perangkat LAIN menghasilkan dialog berisi
   * pesan "Gunakan Kode Pemulihan yang dicatat saat backup dibuat" —
   * tetapi TANPA kotak isian, dan satu-satunya tombolnya "Batal".
   * Pesannya benar, jalannya tidak ada.
   */
  test('kegagalan kunci perangkat ditandai sebagai DAPAT diselesaikan', () => {
    expect(service).toContain('class GagalBukaKunciPerangkat');
    expect(service).toContain('butuhKodePemulihan: true');
    // Dibedakan lewat KELAS, bukan lewat teks pesan: mencocokkan pesan
    // akan diam-diam berhenti bekerja begitu kalimatnya diperhalus.
    expect(service).toContain('e instanceof GagalBukaKunciPerangkat');
  });

  test('SETIAP kegagalan kunci perangkat, bukan hanya beda perangkat', () => {
    // Kunci perangkat juga hilang saat aplikasi dipasang ulang atau
    // AndroidKeyStore menganggapnya tidak sah lagi. Di situ penanda
    // instalasi bisa cocok tetapi kuncinya tetap tidak ada.
    const i = service.indexOf('async function siapkanBerkasSqlite');
    const blok = service.slice(i, service.indexOf('\nasync function validasiBerkasSqlite', i));
    expect(blok).toContain("if (caraDipakai.jenis === 'PERANGKAT') {");
    expect(blok).not.toMatch(/if \(caraDipakai\.jenis === 'PERANGKAT' && periksa\.dariPerangkatIni === false\)/);
  });

  test('kode pemulihan yang SALAH juga tetap bisa dicoba lagi', () => {
    // Pengurus bisa memegang beberapa kode dari beberapa perangkat;
    // salah pilih tidak boleh berubah jadi "berkas rusak".
    expect(service).toContain("if (caraDipakai.jenis === 'KODE_PEMULIHAN') {");
    expect(service).toContain('Kode Pemulihan ini tidak cocok');
  });

  test('layar menampilkan kotak isian tepat pada kegagalan itu', () => {
    expect(layar).toContain('perluKode || validasi?.butuhKodePemulihan');
    // Dan kotak "berkas rusak" TIDAK muncul bersamaan — kalau keduanya
    // tampil, pengguna melihat "tidak dapat dipulihkan" tepat di atas
    // isian yang justru akan memulihkannya.
    expect(layar).toContain('!validasi.valid && !validasi.butuhKodePemulihan');
  });

  test('kode dirapikan sambil diketik dan divalidasi sebelum scrypt', () => {
    // scrypt 32 MiB berjalan beberapa detik; menjalankannya untuk kode
    // yang sudah pasti salah bentuk hanya membuat pengguna menunggu
    // kegagalan yang bisa dipastikan sejak awal.
    expect(layar).toContain('formatKodePemulihan(rapikanKodePemulihan(teks)');
    expect(layar).toContain("const kodeSiap = periksaKodePemulihan(kodeMasukan) === 'SAH'");
    expect(layar).toContain('disabled={!kodeSiap}');
  });

  test('nama berkas yang dipilih benar-benar ditampilkan', () => {
    // "File yang dipilih" tidak membantu pengguna memastikan ia memilih
    // berkas yang tepat — dan memulihkan berkas yang salah menimpa
    // seluruh data koperasi.
    expect(service).toContain("nama: aset.name ?? 'Berkas dipilih'");
    expect(layar).toContain('mulaiValidasiRestore(berkas.uri, berkas.nama)');
    expect(layar).not.toContain("'File yang dipilih'");
  });
});
