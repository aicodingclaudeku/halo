jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan,
  KEBIJAKAN_ENAM_KOMPONEN, ACC, USER_ID, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { cairkanSimpananBerjangkaDini } from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { jalankanRekonsiliasiLengkap, BarisRekonsiliasi } from '@/accounting/FullReconciliation';

/** EW-17 §AD — REKONSILIASI. */

let db: TestDb;
let kontrakId: string;

const cari = (baris: BarisRekonsiliasi[], domain: string) => {
  const b = baris.find((x) => x.domain === domain);
  if (!b) throw new Error(`domain "${domain}" tidak ada di hasil rekonsiliasi`);
  return b;
};

beforeEach(async () => {
  db = await siapkanDb();
  await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
  kontrakId = await buatKontrakUji();
  await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
  await cairkanSimpananBerjangkaDini({
    kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
  });
});

describe('EW-17 §AD — variance nol setelah pencairan dini', () => {
  it('seluruh domain terkait seimbang', async () => {
    const h = await jalankanRekonsiliasiLengkap(db as any);
    expect(h.jurnalSeimbang).toBe(true);
    for (const domain of [
      'Savings berjangka (pokok)',
      'Savings berjangka (utang bunga)',
      'Penarikan dini (penalti)',
      'Penarikan dini (biaya administrasi)',
      'Penarikan dini (bunga hangus & penyesuaian rate)',
    ]) {
      expect(cari(h.baris, domain).variance).toBe(0);
    }
    expect(h.seluruhnyaSeimbang).toBe(true);
  });

  it('angka setiap domain penarikan dini sesuai settlement', async () => {
    const h = await jalankanRekonsiliasiLengkap(db as any);
    expect(cari(h.baris, 'Penarikan dini (penalti)').subledger).toBe(480_000);
    expect(cari(h.baris, 'Penarikan dini (biaya administrasi)').subledger).toBe(50_000);
    // 90.000 hangus - (-180.000) penyesuaian rate = 270.000 pembalikan.
    expect(cari(h.baris, 'Penarikan dini (bunga hangus & penyesuaian rate)').subledger).toBe(270_000);
  });

  it('basis dinyatakan terbuka sebagai bridge dengan catatan rumusnya', async () => {
    const h = await jalankanRekonsiliasiLengkap(db as any);
    const b = cari(h.baris, 'Penarikan dini (penalti)');
    expect(b.basis).toBe('bridge');
    expect(b.catatan).toContain('SIMPANAN_BERJANGKA_PENCAIRAN_DINI');
  });
});

describe('EW-17 §AD — korupsi tiap sisi terdeteksi, bukan dilaporkan seimbang', () => {
  it('subledger penalti dirusak -> SELISIH', async () => {
    await db.runAsync(`UPDATE simpanan_berjangka_pencairan_dini SET penalti = penalti + 1`);
    const h = await jalankanRekonsiliasiLengkap(db as any);
    expect(cari(h.baris, 'Penarikan dini (penalti)').status).toBe('SELISIH');
    expect(cari(h.baris, 'Penarikan dini (penalti)').variance).toBe(1);
  });

  it('sisi GL penalti dirusak -> SELISIH', async () => {
    await db.runAsync(
      `UPDATE journal_entry SET kredit = kredit + 7 WHERE account_id = ?`, ACC.pendapatanDenda
    );
    const h = await jalankanRekonsiliasiLengkap(db as any);
    expect(cari(h.baris, 'Penarikan dini (penalti)').variance).toBe(-7);
  });

  it('subledger biaya admin dirusak -> SELISIH', async () => {
    await db.runAsync(`UPDATE simpanan_berjangka_pencairan_dini SET biaya_admin = 0`);
    const h = await jalankanRekonsiliasiLengkap(db as any);
    expect(cari(h.baris, 'Penarikan dini (biaya administrasi)').variance).toBe(-50_000);
  });

  it('subledger bunga hangus dirusak -> SELISIH', async () => {
    await db.runAsync(`UPDATE simpanan_berjangka_pencairan_dini SET bunga_hangus = 0`);
    const h = await jalankanRekonsiliasiLengkap(db as any);
    expect(cari(h.baris, 'Penarikan dini (bunga hangus & penyesuaian rate)').variance).toBe(-90_000);
  });

  it('sisi GL pokok dirusak -> domain pokok berjangka SELISIH', async () => {
    await db.runAsync(
      `UPDATE journal_entry SET debit = debit - 1000 WHERE account_id = ? AND debit > 0`, ACC.berjangka
    );
    const h = await jalankanRekonsiliasiLengkap(db as any);
    expect(cari(h.baris, 'Savings berjangka (pokok)').status).toBe('SELISIH');
  });

  it('rekonsiliasi tidak melingkar: kedua sisi dibaca dari tabel berbeda', async () => {
    // Merusak HANYA tabel settlement mengubah sisi subledger saja;
    // kalau melingkar, GL akan ikut berubah dan variance tetap 0.
    const sebelum = await jalankanRekonsiliasiLengkap(db as any);
    await db.runAsync(`UPDATE simpanan_berjangka_pencairan_dini SET penalti = 1`);
    const sesudah = await jalankanRekonsiliasiLengkap(db as any);
    expect(cari(sebelum.baris, 'Penarikan dini (penalti)').gl).toBe(
      cari(sesudah.baris, 'Penarikan dini (penalti)').gl
    );
    expect(cari(sesudah.baris, 'Penarikan dini (penalti)').variance).not.toBe(0);
  });
});

describe('EW-17 §AD — tanpa pencairan dini, domain ditandai TIDAK_BERLAKU', () => {
  it('database tanpa settlement dini tidak melaporkan seimbang palsu', async () => {
    const bersih = await siapkanDb();
    const h = await jalankanRekonsiliasiLengkap(bersih as any);
    const b = cari(h.baris, 'Penarikan dini simpanan berjangka');
    expect(b.status).toBe('TIDAK_BERLAKU');
    expect(b.catatan).toContain('Belum ada pencairan dini');
  });
});
