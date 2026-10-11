jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan, snapshotBuku,
  KEBIJAKAN_ENAM_KOMPONEN, KEBIJAKAN_NETRAL, ACC, USER_ID, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { cairkanSimpananBerjangkaDini } from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/**
 * EW-15 §AB — ATOMICITY.
 *
 * Kegagalan disuntik pada titik-titik BERBEDA sepanjang alur, lalu
 * dibuktikan bahwa buku kembali PERSIS seperti sebelum percobaan —
 * bukan sekadar "tidak ada jurnal".
 */

let db: TestDb;
let kontrakId: string;

beforeEach(async () => {
  db = await siapkanDb();
  kontrakId = await buatKontrakUji();
});

async function coba() {
  return cairkanSimpananBerjangkaDini({
    kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
  });
}

describe('EW-15 §AB — rollback total pada setiap titik kegagalan', () => {
  it('gagal saat evaluasi kebijakan (kebijakan belum lengkap)', async () => {
    await pasangKebijakan(db, { ...KEBIJAKAN_NETRAL, jenisPenalti: 'PERSENTASE' });
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    const sebelum = await snapshotBuku(db);
    await expect(coba()).rejects.toThrow();
    expect(await snapshotBuku(db)).toEqual(sebelum);
  });

  it('gagal saat akrual bunga (mapping beban akrual dihapus)', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    const sebelum = await snapshotBuku(db);
    await db.runAsync(
      `DELETE FROM account_mapping WHERE transaction_type = 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL' AND role = 'DEBIT_BEBAN'`
    );
    await expect(coba()).rejects.toThrow();
    const sesudah = await snapshotBuku(db);
    // Akrual yang sempat jalan pun ikut dibatalkan.
    expect(sesudah.jurnal).toEqual(sebelum.jurnal);
    expect(sesudah.entry).toEqual(sebelum.entry);
    expect(sesudah.kontrak).toEqual(sebelum.kontrak);
    expect(sesudah.bungaEvent).toEqual(sebelum.bungaEvent);
  });

  it('gagal saat resolusi akun pokok (mapping DEBIT_POKOK dihapus)', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    const sebelum = await snapshotBuku(db);
    await db.runAsync(
      `DELETE FROM account_mapping WHERE transaction_type = 'SIMPANAN_BERJANGKA_PENCAIRAN' AND role = 'DEBIT_POKOK'`
    );
    await expect(coba()).rejects.toThrow();
    expect(await snapshotBuku(db)).toEqual(sebelum);
  });

  it('gagal saat pembuatan jurnal (akun penalti dinonaktifkan)', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    const sebelum = await snapshotBuku(db);
    await db.runAsync(`UPDATE account SET is_active = 0 WHERE id = ?`, ACC.pendapatanDenda);
    await expect(coba()).rejects.toThrow();
    expect(await snapshotBuku(db)).toEqual(sebelum);
  });

  it('kebijakan TIDAK BISA menunjuk akun yang tidak ada — dicegah foreign key', async () => {
    // Ini lapisan sebelum atomicity: akun penampung penalti adalah FK
    // ke `account`, jadi kebijakan rusak tidak pernah sampai tersimpan
    // dan tidak pernah sempat menghasilkan jurnal separuh jalan.
    await expect(
      pasangKebijakan(db, {
        ...KEBIJAKAN_ENAM_KOMPONEN,
        versi: 'EW-UJI-AKUN-HILANG',
        akunPenaltiId: 'acc-tidak-ada',
      })
    ).rejects.toThrow(/FOREIGN KEY/i);

    const n = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM simpanan_berjangka_kebijakan_dini WHERE versi = 'EW-UJI-AKUN-HILANG'`
    );
    expect(n!.n).toBe(0);
  });

  it('gagal saat izin ditolak -> tidak ada mutasi apa pun', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    const sebelum = await snapshotBuku(db);
    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: 'user-tidak-ada',
      })
    ).rejects.toThrow();
    expect(await snapshotBuku(db)).toEqual(sebelum);
  });

  it('setelah kegagalan, pencairan yang benar tetap bisa dijalankan', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    await db.runAsync(`UPDATE account SET is_active = 0 WHERE id = ?`, ACC.pendapatanDenda);
    await expect(coba()).rejects.toThrow();
    await db.runAsync(`UPDATE account SET is_active = 1 WHERE id = ?`, ACC.pendapatanDenda);

    const hasil = await coba();
    expect(hasil.duplikat).toBe(false);
    expect(hasil.settlement!.totalPayout).toBe(23_560_000);
  });
});
