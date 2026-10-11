import { createTestDb, TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import {
  prosesAkrualBungaUtangOtomatis,
  _resetGerbangAkrualUntukTest,
} from '@/services/UtangBungaAccrualService';
import { terimaUtang, bayarUtang, getKontrolGapUtangBungaAsOf } from '@/services/UtangService';
// Implementasi LAMA yang dibekukan sebelum optimisasi RC-S62.
import { getKontrolGapUtangBungaAsOf as asOfReferensi } from './UtangServiceReferensiRcS62';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { _resetTugasStartupUntukTest } from '@/services/StartupTasks';

/**
 * ============================================================
 * RC-S62 §8 — TEST KESETARAAN HASIL (WAJIB)
 * ============================================================
 *
 * Optimisasi RC-S62 membuat `getKontrolGapUtangBungaAsOf()` berhenti
 * memanggil kontrol global dan menghitung tiga jenis temuan langsung
 * dari agregasi borongan. Perubahan itu hanya sah bila hasilnya IDENTIK.
 *
 * Test ini menjalankan implementasi LAMA (salinan beku di
 * `src/test-utils/UtangServiceReferensiRcS62.ts`) dan implementasi BARU
 * terhadap DATABASE YANG SAMA, lalu membandingkan seluruh objek hasil:
 * status, expected, actual, gap, dan setiap temuan (kode, utangId,
 * nomorUtang, namaPemberi, periode, expected, recorded, difference,
 * keterangan, serta setiap referensi jurnal).
 *
 * CATATAN URUTAN. Temuan dibandingkan setelah diurutkan dengan kunci
 * kanonik. Alasannya bukan kelonggaran: query `SELECT DISTINCT periode`
 * pada implementasi lama TIDAK punya `ORDER BY`, sehingga urutan antar
 * periode di dalam satu utang memang tidak terdefinisi pada implementasi
 * lama itu sendiri. Membandingkan urutan yang tidak terdefinisi akan
 * menguji SQLite, bukan akuntansi. Isi himpunannya dibandingkan penuh.
 */

const ACC = {
  kas: 'acc-kas',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
  modal: 'acc-3-1000',
};

async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: string) {
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

beforeEach(async () => {
  _resetGerbangAkrualUntukTest();
  _resetTugasStartupUntukTest();
  testDb = await createTestDb();
  const now = '2020-01-01T00:00:00.000Z';
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping('UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping('UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping('UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);
  for (const th of [2024, 2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES ('j-awal','JRN-SEED','2024-12-31','p2024','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,500000000,0,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,500000000,1)`,
    ACC.modal
  );
});
afterEach(() => testDb.closeSync());

async function buatUtang(tanggal: string, nama: string): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: nama,
    jenisPemberi: 'BANK',
    pokokPinjaman: 120_000_000,
    persenBunga: 12,
    jenisBunga: 'FLAT',
    basisBunga: 'TAHUNAN',
    tanggal,
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return r.id;
}

const proses = (tanggalSekarang: string) =>
  prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang });

/** Kunci kanonik untuk mengurutkan temuan sebelum dibandingkan. */
function kunci(t: any): string {
  return [
    t.kode, t.utangId ?? '', t.periode ?? '', t.expected, t.recorded, t.difference,
    (t.jurnal ?? []).map((r: any) => r.journalId).join('+'),
  ].join('|');
}

function normalkan(hasil: any) {
  return {
    asOfDate: hasil.asOfDate,
    status: hasil.status,
    expected: hasil.expected,
    actual: hasil.actual,
    gap: hasil.gap,
    jumlahTemuan: hasil.temuan.length,
    temuan: [...hasil.temuan]
      .sort((a, b) => (kunci(a) < kunci(b) ? -1 : kunci(a) > kunci(b) ? 1 : 0))
      .map((t: any) => ({
        kode: t.kode,
        utangId: t.utangId,
        nomorUtang: t.nomorUtang,
        namaPemberi: t.namaPemberi,
        periode: t.periode,
        expected: t.expected,
        recorded: t.recorded,
        difference: t.difference,
        keterangan: t.keterangan,
        jurnal: (t.jurnal ?? []).map((r: any) => ({
          journalId: r.journalId,
          nomorJurnal: r.nomorJurnal,
          tanggal: r.tanggal,
          sumberTransaksi: r.sumberTransaksi,
          nilai: r.nilai,
        })),
      })),
  };
}

async function bandingkan(asOfDate: string) {
  const lama = await asOfReferensi(asOfDate, testDb as any);
  const baru = await getKontrolGapUtangBungaAsOf(asOfDate, testDb as any);
  expect(normalkan(baru)).toEqual(normalkan(lama));
  return { lama, baru };
}

describe('RC-S62 §8 — kesetaraan hasil LAMA vs BARU', () => {
  it('database bersih tanpa utang', async () => {
    await bandingkan('2025-12-31');
  });

  it('akrual murni, banyak utang, banyak periode', async () => {
    await buatUtang('2025-01-05', 'Bank A');
    await buatUtang('2025-02-10', 'Bank B');
    await buatUtang('2025-03-15', 'Bank C');
    await proses('2025-12-31');
    for (const d of ['2025-03-31', '2025-06-30', '2025-12-31', '2026-06-30']) {
      await bandingkan(d);
    }
  });

  it('akrual + pembayaran lintas periode', async () => {
    const u = await buatUtang('2025-01-05', 'Bank A');
    await buatUtang('2025-01-06', 'Bank B');
    await proses('2025-12-31');
    await bayarUtang({
      utangId: u,
      tanggal: '2026-01-15',
      pokok: 1_000_000,
      bunga: 1_200_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    for (const d of ['2025-12-31', '2026-01-14', '2026-01-15', '2026-12-31']) {
      await bandingkan(d);
    }
  });

  it('akrual + reversal bertanggal periode berikutnya', async () => {
    const u = await buatUtang('2025-01-05', 'Bank A');
    await proses('2025-12-31');
    const j = await testDb.getFirstAsync<{ id: string }>(
      `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND reversal_of_id IS NULL ORDER BY tanggal DESC LIMIT 1`,
      u
    );
    const r = await reverseJournal(testDb as any, j!.id, 'user-1', 'Koreksi');
    await testDb.runAsync(`UPDATE journal SET tanggal = ? WHERE id = ?`, '2026-02-10', r.journalId);
    for (const d of ['2025-12-31', '2026-02-09', '2026-02-10', '2026-12-31']) {
      await bandingkan(d);
    }
  });

  it('Case B — jurnal Utang Bunga tanpa atribusi utang', async () => {
    await buatUtang('2025-01-05', 'Bank A');
    await proses('2025-12-31');
    const now = '2020-01-01T00:00:00.000Z';
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
       VALUES ('j-yatim','YTM-000001','2025-07-01','p2025','KAS_UMUM','Bayar bunga langsung','POSTED','user-1',?,?,?)`,
      now, now, now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('jy1','j-yatim',?,500000,0,0)`,
      ACC.utangBunga
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('jy2','j-yatim',?,0,500000,1)`,
      ACC.kas
    );
    for (const d of ['2025-06-30', '2025-07-01', '2025-12-31']) {
      await bandingkan(d);
    }
  });

  it('Case C — subledger pembayaran bunga tanpa jurnal sah', async () => {
    const u = await buatUtang('2025-01-05', 'Bank A');
    await proses('2025-12-31');
    await testDb.runAsync(
      `INSERT INTO utang_pembayaran (id, utang_id, tanggal, pokok, bunga, sumber_dana, nomor_transaksi, journal_id, created_by, created_at)
       VALUES ('bayar-yatim',?,'2025-08-10',0,750000,'KAS','TRX-YATIM-1',NULL,'user-1',?)`,
      u, '2020-01-01T00:00:00.000Z'
    );
    for (const d of ['2025-07-31', '2025-08-31', '2025-12-31']) {
      await bandingkan(d);
    }
  });

  it('§6 — contoh cross-period yang diwajibkan spesifikasi', async () => {
    const u = await buatUtang('2025-12-01', 'Bank A');
    await proses('2025-12-31');
    await bayarUtang({
      utangId: u,
      tanggal: '2026-01-15',
      pokok: 0,
      bunga: 1_200_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const akhir2025 = await getKontrolGapUtangBungaAsOf('2025-12-31', testDb as any);
    expect(akhir2025.expected).toBe(1_200_000);
    expect(akhir2025.actual).toBe(1_200_000);
    expect(akhir2025.gap).toBe(0);

    const akhirJan2026 = await getKontrolGapUtangBungaAsOf('2026-01-31', testDb as any);
    expect(akhirJan2026.expected).toBe(0);
    expect(akhirJan2026.actual).toBe(0);
    expect(akhirJan2026.gap).toBe(0);

    await bandingkan('2025-12-31');
    await bandingkan('2026-01-31');
  });

  it('§12 — 10 pemanggilan konkuren memberi hasil sama', async () => {
    await buatUtang('2025-01-05', 'Bank A');
    await buatUtang('2025-02-05', 'Bank B');
    await proses('2025-12-31');
    const satu = await getKontrolGapUtangBungaAsOf('2025-12-31', testDb as any);
    const banyak = await Promise.all(
      Array.from({ length: 10 }, () => getKontrolGapUtangBungaAsOf('2025-12-31', testDb as any))
    );
    for (const h of banyak) expect(normalkan(h)).toEqual(normalkan(satu));
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => getKontrolGapUtangBungaAsOf('2025-12-31', testDb as any))
    );
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
  });
});
