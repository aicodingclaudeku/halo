import { LICENSE_CLOCK_ROLLBACK_TOLERANCE_MS } from '@/config/license';
import {
  getTrustedNow,
  isClockRollbackDetected,
  recordServerTime,
} from '@/security/licenseClock';
import { readClockHighWater } from '@/security/licenseStore';
import { __clear } from '@/test-utils/expoSecureStoreMock';

/**
 * §24 — CLOCK ROLLBACK.
 *
 * Yang dibuktikan di sini bukan "fungsi mengembalikan true/false", tapi
 * SIFAT yang benar-benar melindungi: memundurkan jam TIDAK PERNAH
 * membuat waktu efektif ikut mundur. Selama sifat itu terjaga, trial
 * tidak bisa diperpanjang dan grace period tidak bisa di-reset dengan
 * mengubah tanggal perangkat.
 */

const BASE = Date.parse('2026-09-06T10:00:00Z');
let nowSpy: jest.SpyInstance<number, []>;

function setDeviceClock(ms: number): void {
  nowSpy.mockReturnValue(ms);
}

beforeEach(() => {
  __clear();
  nowSpy = jest.spyOn(Date, 'now');
  setDeviceClock(BASE);
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe('getTrustedNow', () => {
  it('memakai jam perangkat saat belum ada catatan sama sekali', async () => {
    const result = await getTrustedNow();
    expect(result.effectiveNowMs).toBe(BASE);
    expect(result.rollbackDetected).toBe(false);
    // High-water langsung ditulis: pemanggilan pertama pun harus
    // meninggalkan jejak, kalau tidak proteksinya baru aktif belakangan.
    expect(await readClockHighWater()).toBe(BASE);
  });

  it('menaikkan high-water saat jam maju secara wajar', async () => {
    await getTrustedNow();
    const later = BASE + 3 * 60 * 60 * 1000;
    setDeviceClock(later);

    const result = await getTrustedNow();
    expect(result.effectiveNowMs).toBe(later);
    expect(result.rollbackDetected).toBe(false);
    expect(await readClockHighWater()).toBe(later);
  });

  it('TIDAK ikut mundur saat jam perangkat dimundurkan sehari', async () => {
    await getTrustedNow();
    const rolledBack = BASE - 24 * 60 * 60 * 1000;
    setDeviceClock(rolledBack);

    const result = await getTrustedNow();
    // Inti seluruh proteksi: waktu efektif bertahan di nilai tertinggi.
    expect(result.effectiveNowMs).toBe(BASE);
    expect(result.deviceNowMs).toBe(rolledBack);
    expect(result.rollbackDetected).toBe(true);
    expect(await readClockHighWater()).toBe(BASE);
  });

  it('memaafkan selisih kecil di bawah toleransi', async () => {
    await getTrustedNow();
    setDeviceClock(BASE - (LICENSE_CLOCK_ROLLBACK_TOLERANCE_MS - 1000));

    const result = await getTrustedNow();
    expect(result.rollbackDetected).toBe(false);
  });

  it('menandai mundur tepat melewati toleransi', async () => {
    await getTrustedNow();
    setDeviceClock(BASE - (LICENSE_CLOCK_ROLLBACK_TOLERANCE_MS + 1000));

    const result = await getTrustedNow();
    expect(result.rollbackDetected).toBe(true);
  });

  it('mempertahankan tanda mencurigakan meski jam dikembalikan sedikit', async () => {
    await getTrustedNow();
    setDeviceClock(BASE - 48 * 60 * 60 * 1000);
    await getTrustedNow();

    // Jam "dibetulkan" tapi masih di bawah high-water: kecurigaan
    // TETAP melekat. Kalau tidak, penyerang cukup mundur lalu maju
    // sedikit untuk membersihkan jejaknya.
    setDeviceClock(BASE - 60 * 1000);
    const result = await getTrustedNow();
    expect(result.rollbackDetected).toBe(true);
    expect(result.effectiveNowMs).toBe(BASE);
  });

  it('menghapus tanda mencurigakan setelah jam benar-benar melampaui high-water', async () => {
    await getTrustedNow();
    setDeviceClock(BASE - 48 * 60 * 60 * 1000);
    await getTrustedNow();
    expect(await isClockRollbackDetected()).toBe(true);

    setDeviceClock(BASE + 60 * 1000);
    const result = await getTrustedNow();
    expect(result.rollbackDetected).toBe(false);
    expect(await isClockRollbackDetected()).toBe(false);
  });
});

describe('recordServerTime', () => {
  it('menaikkan high-water memakai waktu server', async () => {
    await getTrustedNow();
    const serverTime = BASE + 7 * 24 * 60 * 60 * 1000;
    await recordServerTime(serverTime);

    const result = await getTrustedNow();
    expect(result.effectiveNowMs).toBe(serverTime);
  });

  it('TIDAK menurunkan high-water walau server melaporkan waktu lebih awal', async () => {
    await getTrustedNow();
    await recordServerTime(BASE - 10 * 24 * 60 * 60 * 1000);
    expect(await readClockHighWater()).toBe(BASE);
  });

  it('mengabaikan nilai yang tidak masuk akal', async () => {
    await getTrustedNow();
    await recordServerTime(Number.NaN);
    await recordServerTime(0);
    await recordServerTime(-1);
    expect(await readClockHighWater()).toBe(BASE);
  });

  it('TIDAK membersihkan kecurigaan hanya karena server melaporkan waktu yang lebih maju', async () => {
    // Waktu server yang jauh di depan jam perangkat justru MEMBUKTIKAN
    // jam perangkat salah — ia tidak boleh dipakai untuk menyatakan
    // perangkat baik-baik saja. Penandaan hanya lepas ketika jam
    // perangkat sendiri sudah melampaui high-water.
    await getTrustedNow();
    setDeviceClock(BASE - 48 * 60 * 60 * 1000);
    await getTrustedNow();
    expect(await isClockRollbackDetected()).toBe(true);

    await recordServerTime(BASE + 1000);
    expect(await isClockRollbackDetected()).toBe(true);

    setDeviceClock(BASE + 2000);
    await getTrustedNow();
    expect(await isClockRollbackDetected()).toBe(false);
  });
});

describe('isClockRollbackDetected', () => {
  it('tidak mengubah high-water saat dipanggil (read-only)', async () => {
    await getTrustedNow();
    setDeviceClock(BASE + 10 * 60 * 60 * 1000);

    await isClockRollbackDetected();
    // Kalau helper ini punya efek samping, memanggilnya dari UI akan
    // diam-diam menggeser proteksi — karena itu sifat read-only-nya
    // dikunci di test.
    expect(await readClockHighWater()).toBe(BASE);
  });
});
