import { createTestDb, TestDb } from './testDb';
import {
  cocokkanPasswordDeveloper,
  getStatusJamUji,
  getWaktuSekarang,
  muatJamUjiDariDb,
  setJamUjiAktif,
  setModeRealtime,
  setTahunKustom,
  setWaktuKustom,
  _resetStateUntukTest,
} from '@/services/DevClockService';

let testDb: TestDb;

beforeEach(async () => {
  testDb = await createTestDb();
  _resetStateUntukTest();
});

describe('DevClockService — password developer', () => {
  test('cocokkanPasswordDeveloper: hanya benar untuk 01022003', () => {
    expect(cocokkanPasswordDeveloper('01022003')).toBe(true);
    expect(cocokkanPasswordDeveloper('01022004')).toBe(false);
    expect(cocokkanPasswordDeveloper('')).toBe(false);
    expect(cocokkanPasswordDeveloper('010220030')).toBe(false);
  });
});

describe('DevClockService — gagal aman (fail-safe) ke waktu asli', () => {
  test('state awal (belum pernah dimuat): getWaktuSekarang() = waktu asli, bukan simulasi', () => {
    const sebelum = Date.now();
    const hasil = getWaktuSekarang();
    const sesudah = Date.now();
    expect(hasil.getTime()).toBeGreaterThanOrEqual(sebelum);
    expect(hasil.getTime()).toBeLessThanOrEqual(sesudah);
  });

  test('getStatusJamUji() awal: aktif=false, mode=REALTIME', () => {
    const status = getStatusJamUji();
    expect(status.aktif).toBe(false);
    expect(status.mode).toBe('REALTIME');
    expect(status.basisIso).toBeNull();
  });

  test('muatJamUjiDariDb pada DB kosong (belum pernah diset): tetap REALTIME, tidak melempar error', async () => {
    await expect(muatJamUjiDariDb(testDb as any)).resolves.toBeUndefined();
    const status = getStatusJamUji();
    expect(status.aktif).toBe(false);
    expect(status.mode).toBe('REALTIME');
  });
});

describe('DevClockService — menyalakan & mematikan mode pengujian', () => {
  test('setJamUjiAktif(true) lalu dimuat ulang dari DB: nilainya persisten', async () => {
    await setJamUjiAktif(testDb as any, true);
    expect(getStatusJamUji().aktif).toBe(true);

    _resetStateUntukTest();
    expect(getStatusJamUji().aktif).toBe(false); // cache direset

    await muatJamUjiDariDb(testDb as any);
    expect(getStatusJamUji().aktif).toBe(true); // dibaca lagi dari DB, tetap true
  });

  test('mematikan aktif TIDAK menghapus basis kustom tersimpan, hanya berhenti diterapkan', async () => {
    await setJamUjiAktif(testDb as any, true);
    await setWaktuKustom(testDb as any, '2027-05-01', '09:00');
    expect(getWaktuSekarang().getFullYear()).toBe(2027);

    await setJamUjiAktif(testDb as any, false);
    // Sekarang REAL lagi walau basis kustom masih tersimpan di state.
    expect(getWaktuSekarang().getFullYear()).toBe(new Date().getFullYear());

    await setJamUjiAktif(testDb as any, true);
    // Dinyalakan lagi -> basis kustom yang sama berlaku lagi.
    expect(getWaktuSekarang().getFullYear()).toBe(2027);
  });
});

describe('DevClockService — mode KUSTOM', () => {
  test('setWaktuKustom: getWaktuSekarang() mengikuti basis + berjalan maju dari waktu asli', async () => {
    await setJamUjiAktif(testDb as any, true);
    await setWaktuKustom(testDb as any, '2030-01-15', '08:00');

    const hasil = getWaktuSekarang();
    expect(hasil.getFullYear()).toBe(2030);
    expect(hasil.getMonth()).toBe(0); // Januari
    expect(hasil.getDate()).toBe(15);
    expect(hasil.getHours()).toBe(8);
    // Berjalan maju: dipanggil lagi setelah sedikit waktu, hasilnya >= basis.
    const basisMs = hasil.getTime();
    const hasilKedua = getWaktuSekarang();
    expect(hasilKedua.getTime()).toBeGreaterThanOrEqual(basisMs);
  });

  test('setWaktuKustom: format tanggal/jam salah ditolak dengan error, state tidak berubah', async () => {
    await setJamUjiAktif(testDb as any, true);
    await expect(setWaktuKustom(testDb as any, '2030/01/15', '08:00')).rejects.toThrow();
    await expect(setWaktuKustom(testDb as any, '2030-01-15', '8:00')).rejects.toThrow();
    expect(getStatusJamUji().mode).toBe('REALTIME'); // gagal -> tidak berubah
  });

  test('setModeRealtime: mengembalikan getWaktuSekarang() ke waktu asli walau aktif masih true', async () => {
    await setJamUjiAktif(testDb as any, true);
    await setWaktuKustom(testDb as any, '2030-01-15', '08:00');
    expect(getWaktuSekarang().getFullYear()).toBe(2030);

    await setModeRealtime(testDb as any);
    expect(getWaktuSekarang().getFullYear()).toBe(new Date().getFullYear());
    expect(getStatusJamUji().mode).toBe('REALTIME');
  });
});

describe('DevClockService — setTahunKustom (ubah tahun cepat)', () => {
  test('hanya mengganti komponen tahun, bulan/tanggal/jam tetap dari basis KUSTOM sebelumnya', async () => {
    await setJamUjiAktif(testDb as any, true);
    await setWaktuKustom(testDb as any, '2027-06-10', '14:30');

    await setTahunKustom(testDb as any, 2031);

    const hasil = getWaktuSekarang();
    expect(hasil.getFullYear()).toBe(2031);
    expect(hasil.getMonth()).toBe(5); // Juni, tidak berubah
    expect(hasil.getDate()).toBe(10);
    expect(hasil.getHours()).toBe(14);
  });

  test('dari REALTIME: mengganti tahun otomatis pindah ke mode KUSTOM dengan bulan/tanggal/jam saat ini', async () => {
    await setJamUjiAktif(testDb as any, true);
    expect(getStatusJamUji().mode).toBe('REALTIME');

    const sekarangAsli = new Date();
    await setTahunKustom(testDb as any, 2040);

    expect(getStatusJamUji().mode).toBe('KUSTOM');
    const hasil = getWaktuSekarang();
    expect(hasil.getFullYear()).toBe(2040);
    expect(hasil.getMonth()).toBe(sekarangAsli.getMonth());
    expect(hasil.getDate()).toBe(sekarangAsli.getDate());
  });

  test('tahun di luar rentang wajar (2000-2100) ditolak', async () => {
    await setJamUjiAktif(testDb as any, true);
    await expect(setTahunKustom(testDb as any, 1999)).rejects.toThrow();
    await expect(setTahunKustom(testDb as any, 2101)).rejects.toThrow();
    await expect(setTahunKustom(testDb as any, 2027.5)).rejects.toThrow();
  });
});
