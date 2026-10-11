import { readFileSync } from 'fs';
import { join } from 'path';
import { sekaliJalan } from '@/utils/sekaliJalan';

/**
 * ============================================================
 * RC-S115 — DATABASE TIDAK BOLEH DIBUKA DUA KALI
 * ============================================================
 *
 * BUG YANG DIJAGA SUITE INI (dilaporkan pengguna setelah build EAS).
 *
 * Gejalanya: "Gagal menyimpan setup — Call to function
 * 'NativeDatabase.prepareAsync' has been rejected. Caused by:
 * java.lang.NullPointerException".
 *
 * NPE itu berasal dari `prepareStatement()` di expo-sqlite
 * (SQLiteModule.kt baris 376-382): ia memanggil
 * `database.ref.sqlite3_prepare_v2(...)` pada `ref` yang sudah NULL —
 * pegangan native-nya sudah DILEPAS. Database yang sekadar ditutup
 * melempar AccessClosedResourceException, bukan NPE; jadi penyebabnya
 * bukan penutupan melainkan pelepasan oleh pengumpul sampah.
 *
 * Bentuk lama `getDb()` punya empat titik `await` antara penjaga
 * `if (dbInstance)` dan penugasan `dbInstance`. Dua pemanggil yang
 * masuk berdekatan sama-sama lolos penjaga itu dan KEDUANYA memanggil
 * `openDatabaseAsync` atas berkas yang sama. Yang selesai belakangan
 * menimpa `dbInstance`; objek pertama menjadi tak terjangkau, dilepas,
 * sementara pemanggil yang sempat menyimpannya (`const db = await
 * getDb()`) baru memakainya belakangan — persis pola layar Setup:
 * `db` diambil saat layar dibuka, dipakai saat tombol "Mulai" ditekan.
 *
 * Aplikasi ini punya 329 pemanggil `await getDb()`, beberapa berjalan
 * berbarengan saat aplikasi dibuka. Di build rilis waktunya jauh lebih
 * rapat daripada di mode pengembangan, sehingga balapan yang dulu
 * jarang menang menjadi sering menang.
 *
 * ============================================================
 * KENAPA PENJAGANYA DIPISAH JADI MODUL SENDIRI
 * ============================================================
 * `database/db.ts` hanya dapat dijalankan dengan jembatan native
 * expo-sqlite, yang tidak ada di Node — jadi semantik balapannya tidak
 * bisa diuji di sana. Penjaganya karena itu berdiri sendiri sebagai
 * `utils/sekaliJalan.ts` yang MURNI, sehingga perilaku yang menentukan
 * (berapa kali pekerjaan benar-benar dijalankan saat dipanggil
 * berbarengan) diuji SUNGGUHAN di bawah, bukan sekadar dibaca dari
 * teks sumber.
 */

describe('RC-S115 — penjaga sekaliJalan (perilaku sungguhan)', () => {
  const tunda = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('lima pemanggil berbarengan hanya menjalankan pekerjaan SATU kali', async () => {
    let jumlah = 0;
    const buka = sekaliJalan(async () => {
      jumlah += 1;
      await tunda(5); // celah yang dulu membuat pemanggil kedua lolos
      return { nama: 'db' };
    });

    const hasil = await Promise.all([buka(), buka(), buka(), buka(), buka()]);

    expect(jumlah).toBe(1);
    // Dan semuanya memegang objek yang SAMA — bukan lima pegangan
    // berbeda yang empat di antaranya akan dilepas pengumpul sampah.
    for (const h of hasil) expect(h).toBe(hasil[0]);
  });

  test('pemanggilan berurutan sesudahnya memakai ulang hasil yang sama', async () => {
    let jumlah = 0;
    const buka = sekaliJalan(async () => {
      jumlah += 1;
      return { nama: 'db' };
    });
    const a = await buka();
    const b = await buka();
    expect(jumlah).toBe(1);
    expect(b).toBe(a);
  });

  test('hasil tidak terlihat sebelum pekerjaan benar-benar selesai', async () => {
    // Kalau nilainya ditugaskan sebelum konfigurasi & migrasi tuntas,
    // pemanggil lain bisa menerima koneksi yang belum siap.
    let selesai = false;
    const buka = sekaliJalan(async () => {
      await tunda(5);
      selesai = true;
      return { siap: true };
    });
    const janji = buka();
    expect(buka.nilai()).toBeNull();
    expect(selesai).toBe(false);
    await janji;
    expect(buka.nilai()).toEqual({ siap: true });
  });

  test('reset() membuat panggilan berikutnya benar-benar mengulang', async () => {
    let jumlah = 0;
    const buka = sekaliJalan(async () => {
      jumlah += 1;
      return { ke: jumlah };
    });
    await buka();
    buka.reset();
    const kedua = await buka();
    expect(jumlah).toBe(2);
    expect(kedua).toEqual({ ke: 2 });
  });

  test('kegagalan TIDAK menjadi permanen', async () => {
    // Menyimpan janji yang sudah ditolak akan membuat kegagalan sesaat
    // — keystore terkunci, disk penuh sesaat — menjadi kegagalan
    // permanen sampai aplikasi dimatikan paksa.
    let percobaan = 0;
    const buka = sekaliJalan(async () => {
      percobaan += 1;
      if (percobaan === 1) throw new Error('disk penuh sesaat');
      return { nama: 'db' };
    });

    await expect(buka()).rejects.toThrow('disk penuh sesaat');
    await expect(buka()).resolves.toEqual({ nama: 'db' });
    expect(percobaan).toBe(2);
  });

  test('kegagalan berbarengan hanya dicoba sekali, ditolak untuk semua', async () => {
    let percobaan = 0;
    const buka = sekaliJalan(async () => {
      percobaan += 1;
      await tunda(5);
      throw new Error('gagal');
    });
    const hasil = await Promise.allSettled([buka(), buka(), buka()]);
    expect(percobaan).toBe(1);
    expect(hasil.every((h) => h.status === 'rejected')).toBe(true);
  });
});

describe('RC-S115 — getDb() memakai penjaga itu', () => {
  const db = readFileSync(join(__dirname, '..', 'database', 'db.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('pembukaan dibungkus sekaliJalan, bukan pola lazy yang berbalapan', () => {
    expect(db).toContain('sekaliJalan<SQLite.SQLiteDatabase>');
    expect(db).toContain('return pembukaanDb();');
    // Pola lama yang berbalapan tidak boleh kembali.
    expect(db).not.toMatch(/if \(dbInstance\) return dbInstance;\s*await pulihkanJikaRestoreTerputus/);
  });

  test('openDatabaseAsync hanya dipanggil dari dalam penjaga', () => {
    // Satu-satunya pemanggilan; kalau ada jalur kedua, jaminan "sekali
    // buka" hilang tanpa test lain yang menyadarinya.
    expect((db.match(/SQLite\.openDatabaseAsync\(/g) ?? []).length).toBe(1);
  });

  test('dbInstance ditugaskan SETELAH migrasi, bukan sebelum', () => {
    const iBuka = db.indexOf('SQLite.openDatabaseAsync(');
    const iMigrasi = db.indexOf('await runMigrations(db);', iBuka);
    const iTugas = db.indexOf('dbInstance = db;', iBuka);
    expect(iMigrasi).toBeGreaterThan(iBuka);
    expect(iTugas).toBeGreaterThan(iMigrasi);
  });

  test('closeDb() me-reset penjaga', () => {
    const i = db.indexOf('export async function closeDb');
    const blok = db.slice(i, db.indexOf('\n}', i));
    expect(blok).toContain('pembukaanDb.reset();');
  });
});

describe('RC-S115 — tidak bergantung pada fungsi Annex B', () => {
  // `escape`/`unescape` bagian dari Annex B dan tidak dijamin ada di
  // Hermes. Kegagalannya tidak akan terlihat saat pengembangan di Node,
  // tempat keduanya ada — jadi satu-satunya penjaga yang berguna adalah
  // melarangnya di sumber.
  const berkas = ['security/pinHash.ts', 'backup/FormatBackupTerenkripsi.ts'];

  for (const f of berkas) {
    test(`${f} memakai pengkodean UTF-8 eksplisit`, () => {
      const isi = readFileSync(join(__dirname, '..', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(isi).not.toMatch(/\bunescape\(/);
      expect(isi).not.toMatch(/[^.\w]escape\(/);
    });
  }
});
