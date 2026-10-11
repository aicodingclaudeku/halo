import { createTestDb, TestDb } from './testDb';

/**
 * FIX TIMEZONE / TANGGAL AKUNTANSI (permintaan pengguna) — batas
 * pergantian hari menurut KALENDER LOKAL, bukan UTC.
 *
 * Indonesia (WIB +7 / WITA +8 / WIT +9) seluruhnya DI DEPAN UTC, jadi
 * antara tengah malam lokal dan pukul 07:00-09:00 pagi lokal,
 * `new Date().toISOString().slice(0, 10)` masih mengembalikan tanggal
 * KEMARIN. Untuk akrual jasa, itu berarti angsuran yang jatuh tempo
 * hari ini tidak diakru sepanjang pagi.
 *
 * Teknik mock SAMA PERSIS dengan AkrualJasaPinjamanService.test.ts —
 * SQLite sungguhan (sql.js) lewat testDb, service code sungguhan.
 */
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

import { getTanggalLokalHariIni, toTanggalLokal, getPeriodeLokalSekarang } from '@/utils/tanggal';
import { periodeSekarang } from '@/accounting/PeriodeUtil';
import {
  prosesAkrualJasaPinjaman,
  jalankanAkrualJasaOtomatisJikaPerlu,
} from '@/services/AkrualJasaPinjamanService';
import { ajukanPinjaman, cairkanPinjaman } from '@/services/PinjamanService';

/**
 * Jalankan `fn` seolah-olah jam dinding perangkat berada pada instant
 * `instantUtc` DENGAN offset zona waktu `offsetJam` (mis. +7 untuk
 * WIB). Offset TIDAK di-hardcode di kode aplikasi — di sini hanya
 * dipakai untuk MENSIMULASIKAN perangkat di zona waktu Indonesia,
 * karena Jest berjalan di UTC.
 */
async function denganJamLokal<T>(instantUtc: string, offsetJam: number, fn: () => Promise<T> | T): Promise<T> {
  const RealDate = Date;
  const fixed = new RealDate(instantUtc).getTime();
  const offsetMs = offsetJam * 3600_000;

  class FakeDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixed);
      } else {
        // @ts-expect-error — meneruskan argumen apa adanya ke Date asli.
        super(...args);
      }
    }
    static now() {
      return fixed;
    }
    // Komponen kalender LOKAL = UTC + offset zona waktu perangkat.
    getFullYear() {
      return new RealDate(this.getTime() + offsetMs).getUTCFullYear();
    }
    getMonth() {
      return new RealDate(this.getTime() + offsetMs).getUTCMonth();
    }
    getDate() {
      return new RealDate(this.getTime() + offsetMs).getUTCDate();
    }
    getHours() {
      return new RealDate(this.getTime() + offsetMs).getUTCHours();
    }
    getTimezoneOffset() {
      return -offsetJam * 60;
    }
  }

  (global as any).Date = FakeDate;
  try {
    return await fn();
  } finally {
    (global as any).Date = RealDate;
  }
}

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`,
    transactionType,
    role,
    accountId
  );
}

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanDenda: 'acc-pendapatan-denda',
  modal: 'acc-modal',
};
const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID,
    'A001',
    '1234567890123456',
    'Budi',
    '2020-01-01',
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sp-fixture',?,'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sw-fixture',?,'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
}

/** Pinjaman aktif dengan SATU baris jadwal bertanggal jatuh tempo yang dikontrol penuh. */
async function pinjamanDenganJatuhTempo(jatuhTempo: string, jasa = 12_000): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman: 1_200_000,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA',
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });
  await testDb.runAsync(`DELETE FROM angsuran_jadwal WHERE pinjaman_id = ?`, id);
  await testDb.runAsync(
    `INSERT INTO angsuran_jadwal
      (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total,
       pokok_terbayar, jasa_terbayar, denda_terbayar, jasa_dimuka, status)
     VALUES (?,?,1,?,100000,?,0,?,0,0,0,0,'BELUM_BAYAR')`,
    `jdw-${id}`,
    id,
    jatuhTempo,
    jasa,
    100_000 + jasa
  );
  return id;
}

async function jumlahJurnalAkrual(pinjamanId: string): Promise<number> {
  const row = await testDb.getFirstAsync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'AKRUAL_JASA_PINJAMAN' AND sumber_id = ?`,
    pinjamanId
  );
  return row?.cnt ?? 0;
}

describe('Helper tanggal lokal — batas pergantian hari WIB/WITA/WIT', () => {
  // TEST 1: dini hari lokal, UTC masih kemarin.
  test('TEST 1: 2026-09-02 pukul 00:05 WIB -> getTanggalLokalHariIni() = 2026-09-02 (BUKAN 2026-09-01)', async () => {
    // 2026-09-02 00:05 WIB == 2026-09-01 17:05 UTC
    await denganJamLokal('2026-09-01T17:05:00.000Z', 7, () => {
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-01'); // perilaku LAMA (salah)
      expect(getTanggalLokalHariIni()).toBe('2026-09-02'); // perilaku BARU (benar)
    });
  });

  test('TEST 1b: benar juga untuk WITA (+8) dan WIT (+9) — offset TIDAK di-hardcode', async () => {
    // 2026-09-02 00:30 WITA == 2026-09-01 16:30 UTC
    await denganJamLokal('2026-09-01T16:30:00.000Z', 8, () => {
      expect(getTanggalLokalHariIni()).toBe('2026-09-02');
    });
    // 2026-09-02 00:30 WIT == 2026-09-01 15:30 UTC
    await denganJamLokal('2026-09-01T15:30:00.000Z', 9, () => {
      expect(getTanggalLokalHariIni()).toBe('2026-09-02');
    });
  });

  test('periodeSekarang() ikut lokal — 1 Oktober 00:05 WIB bukan lagi periode September', async () => {
    await denganJamLokal('2026-09-30T17:05:00.000Z', 7, () => {
      expect(getPeriodeLokalSekarang()).toBe('2026-10');
      expect(periodeSekarang()).toBe('2026-10');
    });
  });

  test('toTanggalLokal() memformat Date apa pun menurut kalender lokal', async () => {
    await denganJamLokal('2026-09-01T17:05:00.000Z', 7, () => {
      expect(toTanggalLokal(new Date())).toBe('2026-09-02');
    });
  });
});

describe('Eligibility akrual pada batas tanggal (tanggal_jatuh_tempo <= tanggalLaporan)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('TEST 2: jatuh tempo 2026-09-02, tanggal laporan 2026-09-01 -> TIDAK AKRUAL', async () => {
    const pinjamanId = await pinjamanDenganJatuhTempo('2026-09-02');
    const hasil = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-09',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-01',
    });
    expect(hasil.dibuat).toBe(false);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(0);
  });

  test('TEST 3: jatuh tempo 2026-09-02, tanggal laporan 2026-09-02 -> AKRUAL', async () => {
    const pinjamanId = await pinjamanDenganJatuhTempo('2026-09-02');
    const hasil = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-09',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-02',
    });
    expect(hasil.dibuat).toBe(true);
    expect(hasil.row?.jumlahJasa).toBe(12_000);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(1);
  });

  test('TEST 4: jatuh tempo 2026-09-01, tanggal laporan 2026-09-02 -> AKRUAL', async () => {
    const pinjamanId = await pinjamanDenganJatuhTempo('2026-09-01');
    const hasil = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-09',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-02',
    });
    expect(hasil.dibuat).toBe(true);
    expect(hasil.row?.jumlahJasa).toBe(12_000);
  });
});

describe('Trigger otomatis akrual memakai tanggal LOKAL', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('TEST 5: 2026-10-01 pukul 00:05 WIB dengan jatuh tempo 2026-10-01 -> periode eligible & jurnal dibuat', async () => {
    const pinjamanId = await pinjamanDenganJatuhTempo('2026-10-01');

    // 2026-10-01 00:05 WIB == 2026-09-30 17:05 UTC. Dengan perilaku
    // LAMA (UTC) tanggal laporan jadi '2026-09-30' dan akrual TERLAMBAT
    // satu hari.
    const hasil = await denganJamLokal('2026-09-30T17:05:00.000Z', 7, () =>
      jalankanAkrualJasaOtomatisJikaPerlu('user-1')
    );

    expect(hasil.dijalankan).toBe(true);
    expect(hasil.periodeDiproses).toEqual(['2026-10']);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(1);
  });

  test('TEST 6: tanggal lokal 2026-10-01, jatuh tempo 2026-10-02 -> TIDAK ADA jurnal', async () => {
    const pinjamanId = await pinjamanDenganJatuhTempo('2026-10-02');

    const hasil = await denganJamLokal('2026-09-30T17:05:00.000Z', 7, () =>
      jalankanAkrualJasaOtomatisJikaPerlu('user-1')
    );

    expect(hasil.dijalankan).toBe(true);
    expect(hasil.periodeDiproses).toEqual([]);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(0);
  });

  test('TEST 7: idempotensi — dijalankan dua kali pada jam lokal yang sama, jurnal tidak bertambah', async () => {
    const pinjamanId = await pinjamanDenganJatuhTempo('2026-10-01');

    await denganJamLokal('2026-09-30T17:05:00.000Z', 7, () => jalankanAkrualJasaOtomatisJikaPerlu('user-1'));
    const setelahRun1 = await jumlahJurnalAkrual(pinjamanId);
    expect(setelahRun1).toBe(1);

    const run2 = await denganJamLokal('2026-09-30T18:00:00.000Z', 7, () =>
      jalankanAkrualJasaOtomatisJikaPerlu('user-1')
    );
    expect(run2.periodeDiproses).toEqual([]);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(setelahRun1);
  });

  test('getStatusAkrualJasaPeriode() tanpa tanggalLaporan eksplisit ikut kalender lokal', async () => {
    const pinjamanId = await pinjamanDenganJatuhTempo('2026-10-01');

    const { getStatusAkrualJasaPeriode } = await import('@/services/AkrualJasaPinjamanService');
    const status = await denganJamLokal('2026-09-30T17:05:00.000Z', 7, () =>
      getStatusAkrualJasaPeriode('2026-10')
    );
    const item = status.find((s) => s.pinjamanId === pinjamanId);
    // Dengan perilaku UTC lama, tanggal laporan '2026-09-30' membuat
    // baris ini TIDAK_ADA_JASA (belum jatuh tempo).
    expect(item?.status).toBe('SIAP_DIAKUI');
    expect(item?.jasaPeriodeIni).toBe(12_000);
  });
});
