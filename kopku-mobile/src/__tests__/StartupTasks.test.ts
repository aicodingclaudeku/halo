/**
 * §5/§30 — KOORDINATOR TUGAS LATAR (perbaikan root cause first-open).
 *
 * Yang dibuktikan:
 *  1. penyusutan & akrual jasa berjalan BERURUTAN, tidak lagi bersamaan
 *     (dulu dua fire-and-forget terpisah -> dua transaksi tumpang-tindih
 *     pada SATU koneksi SQLite);
 *  2. `tungguTugasStartupSelesai()` benar-benar menunggu SELESAI, jadi
 *     laporan tidak pernah dihitung di atas jurnal yang baru sebagian;
 *  3. gate resolve SEKETIKA kalau tidak ada pekerjaan berjalan (tidak
 *     menambah latensi pada pembukaan layar berikutnya);
 *  4. pekerjaan yang GAGAL tidak membuat gate menggantung selamanya.
 *
 * Tidak ada setTimeout sebagai alat sinkronisasi di implementasinya —
 * gate menunggu promise pekerjaan yang sesungguhnya.
 */

const jejak: string[] = [];
let tundaPenyusutan: (() => void) | null = null;
let penyusutanGagal = false;

jest.mock('@/services/PenyusutanService', () => ({
  jalankanPenyusutanOtomatisJikaPerlu: jest.fn(async () => {
    jejak.push('penyusutan:mulai');
    if (tundaPenyusutan) {
      await new Promise<void>((resolve) => {
        tundaPenyusutan = () => resolve();
      });
    }
    if (penyusutanGagal) {
      jejak.push('penyusutan:gagal');
      throw new Error('penyusutan gagal');
    }
    jejak.push('penyusutan:selesai');
  }),
}));

jest.mock('@/services/AkrualJasaPinjamanService', () => ({
  jalankanAkrualJasaOtomatisJikaPerlu: jest.fn(async () => {
    jejak.push('akrual:mulai');
    jejak.push('akrual:selesai');
  }),
}));

import {
  jalankanTugasStartup,
  tungguTugasStartupSelesai,
  _resetTugasStartupUntukTest,
} from '@/services/StartupTasks';

beforeEach(() => {
  jejak.length = 0;
  tundaPenyusutan = null;
  penyusutanGagal = false;
  _resetTugasStartupUntukTest();
});

test('penyusutan & akrual jasa berjalan BERURUTAN, bukan bersamaan', async () => {
  await jalankanTugasStartup('user-1');

  expect(jejak).toEqual([
    'penyusutan:mulai',
    'penyusutan:selesai',
    'akrual:mulai',
    'akrual:selesai',
  ]);
  // Bukti tidak tumpang-tindih: akrual tidak pernah dimulai sebelum
  // penyusutan selesai.
  expect(jejak.indexOf('akrual:mulai')).toBeGreaterThan(jejak.indexOf('penyusutan:selesai'));
});

test('gate menunggu pekerjaan latar benar-benar SELESAI sebelum laporan boleh dihitung', async () => {
  // Tahan penyusutan di tengah jalan supaya pekerjaan "masih berjalan".
  tundaPenyusutan = () => {};
  const tugas = jalankanTugasStartup('user-1');
  await Promise.resolve();

  let gateLolos = false;
  const gate = tungguTugasStartupSelesai().then(() => {
    gateLolos = true;
  });

  // Saat pekerjaan masih berjalan, gate BELUM boleh lolos.
  await Promise.resolve();
  expect(gateLolos).toBe(false);
  expect(jejak).not.toContain('akrual:selesai');

  // Lepaskan pekerjaan -> gate lolos setelah SEMUA selesai.
  tundaPenyusutan!();
  await tugas;
  await gate;

  expect(gateLolos).toBe(true);
  expect(jejak).toContain('akrual:selesai');
});

test('gate resolve seketika kalau tidak ada pekerjaan latar yang berjalan', async () => {
  await jalankanTugasStartup('user-1');
  jejak.length = 0;

  await tungguTugasStartupSelesai();

  // Tidak ada pekerjaan baru yang terpicu oleh gate itu sendiri.
  expect(jejak).toEqual([]);
});

test('pekerjaan yang GAGAL tidak membuat gate menggantung selamanya', async () => {
  penyusutanGagal = true;
  jalankanTugasStartup('user-1').catch(() => {});

  await tungguTugasStartupSelesai();

  expect(jejak).toContain('penyusutan:gagal');
  // Akrual TETAP dijalankan walau penyusutan gagal — kegagalan satu
  // pekerjaan tidak boleh membatalkan pekerjaan lain.
  expect(jejak).toContain('akrual:selesai');
});

test('pemanggilan berulang (mis. kembali dari background) DIRANTAI, tidak paralel', async () => {
  const a = jalankanTugasStartup('user-1');
  const b = jalankanTugasStartup('user-1');
  await Promise.all([a, b]);

  // Dua batch berurutan penuh: tidak ada "mulai" kedua yang menyelip di
  // tengah batch pertama.
  expect(jejak).toEqual([
    'penyusutan:mulai',
    'penyusutan:selesai',
    'akrual:mulai',
    'akrual:selesai',
    'penyusutan:mulai',
    'penyusutan:selesai',
    'akrual:mulai',
    'akrual:selesai',
  ]);
});
