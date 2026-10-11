import { createTestDb, TestDb } from './testDb';
import { seedKebijakanProdukUji } from './kebijakanProdukBerjangkaUji';

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

// Modul background task mengimpor native module Expo yang tidak ada di
// lingkungan test. Yang diuji di sini adalah SEMANTIK registrasi
// (idempotensi), bukan jembatan nativenya.
const taskTerdaftar = new Set<string>();
const taskTerdefinisi = new Set<string>();
let registerDipanggil = 0;

// `expo-task-manager` dan `expo-background-task` dipetakan oleh
// jest.config ke satu stub bersama (`test-utils/expoBackgroundMock`).
// Mock dipasang pada BERKAS STUB ITU — bukan pada nama paketnya —
// karena moduleNameMapper sudah menyelesaikan keduanya ke path tersebut,
// sehingga mock bernama paket tidak akan terpakai.
jest.mock('@/test-utils/expoBackgroundMock', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  isTaskDefined: (n: string) => taskTerdefinisi.has(n),
  defineTask: (n: string) => taskTerdefinisi.add(n),
  isTaskRegisteredAsync: async (n: string) => taskTerdaftar.has(n),
  registerTaskAsync: async (n: string) => {
    registerDipanggil++;
    taskTerdaftar.add(n);
  },
  unregisterTaskAsync: async (n: string) => {
    taskTerdaftar.delete(n);
  },
}));

import { setorSimpananBerjangka, listSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  jalankanCatchUpAkrualSimpananBerjangka,
  _resetCatchUpUntukTest,
} from '@/services/SimpananBerjangkaCatchUpService';
import {
  daftarkanTaskAkrualBerjangka,
  NAMA_TASK_AKRUAL_BERJANGKA,
} from '@/services/SimpananBerjangkaBackgroundTask';
import {
  KEBIJAKAN_PENARIKAN_DINI_TERSEDIA,
  evaluasiKelayakanPencairan,
  PESAN_PENARIKAN_DINI_TANPA_KEBIJAKAN,
} from '@/accounting/SimpananBerjangkaKebijakanPencairan';
import { getRingkasanPencairan } from '@/services/SimpananBerjangkaLifecycleService';

const ACC = {
  kas: 'acc-kas',
  berjangka: 'acc-2-1210',
  utangBunga: 'acc-2-1710',
  bebanBunga: 'acc-5-1955',
  modal: 'acc-modal',
};
const ANGGOTA = 'anggota-1';

async function seed(): Promise<TestDb> {
  const db = await createTestDb();
  await seedKebijakanProdukUji(db); // RC-S128: penempatan berjangka mewajibkan kebijakan produk
  const now = new Date().toISOString();

  const akun: [string, string, string, string, 'DEBIT' | 'KREDIT'][] = [
    [ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT'],
    [ACC.berjangka, '2-1210', 'Simpanan Anggota (Berjangka)', 'LIABILITAS', 'KREDIT'],
    [ACC.utangBunga, '2-1710', 'Utang Bunga Simpanan Berjangka', 'LIABILITAS', 'KREDIT'],
    [ACC.bebanBunga, '5-1955', 'Beban Bunga Simpanan Berjangka', 'BEBAN', 'DEBIT'],
    [ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT'],
  ];
  for (const [id, kode, nama, kat, nb] of akun) {
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, nama, kat, nb, now, now
    );
  }

  const mapping: [string, string, string][] = [
    ['KAS_UMUM', 'DEFAULT', ACC.kas],
    ['SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', ACC.berjangka],
    ['SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN', ACC.bebanBunga],
    ['SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', ACC.utangBunga],
    ['SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_POKOK', ACC.berjangka],
    ['SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_UTANG_BUNGA', ACC.utangBunga],
  ];
  for (const [tipe, role, accId] of mapping) {
    await db.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-${tipe}-${role}`, tipe, role, accId
    );
  }

  for (const tahun of [2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?, 'OPEN')`,
      `p${tahun}`, tahun, `${tahun}-01-01`, `${tahun}-12-31`
    );
  }
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'AKTIF', ?,?)`,
    ANGGOTA, 'A001', '1234567890123456', 'Budi', '2020-01-01', now, now
  );
  return db;
}

async function saldoGl(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(kredit) - SUM(debit), 0) s FROM journal_entry WHERE account_id = ?`,
    accountId
  );
  return r!.s;
}

beforeEach(async () => {
  testDb = await seed();
  _resetCatchUpUntukTest();
  taskTerdaftar.clear();
  registerDipanggil = 0;
  // Definisi task dilakukan pada level modul saat bundle dimuat, jadi
  // sudah terjadi sebelum beforeEach pertama. Ditegaskan di sini supaya
  // tiap skenario berangkat dari kondisi "task terdefinisi, belum
  // terdaftar" — yang persis kondisi aplikasi saat baru dibuka.
  taskTerdefinisi.add(NAMA_TASK_AKRUAL_BERJANGKA);
});

// ============================================================
// §19/§40 — CATCH-UP PERIODE TERLEWAT
// ============================================================

describe('§19/§40 catch-up periode terlewat', () => {
  test('aplikasi ditutup berbulan-bulan: SEMUA periode earned diakru, bukan hanya bulan terakhir', async () => {
    // 10jt, 12%/th, 12 bulan -> bunga kontrak 1.200.000, 100.000/bulan.
    await setorSimpananBerjangka({
      anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
      tenorBulan: 12, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1',
    });

    // Dibuka lagi 5 April: periode Feb, Mar, Apr sudah earned.
    const hasil = await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-04-05');

    expect(hasil.periodeDiakru).toBe(3);
    expect(await saldoGl(ACC.utangBunga)).toBe(300_000);
    expect(await saldoGl(ACC.bebanBunga)).toBe(-300_000); // beban = debit
  });

  test('catch-up kedua tanpa waktu berjalan TIDAK mengakru apa pun lagi', async () => {
    await setorSimpananBerjangka({
      anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
      tenorBulan: 12, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1',
    });
    await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-04-05');
    _resetCatchUpUntukTest();
    const kedua = await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-04-05');

    expect(kedua.periodeDiakru).toBe(0);
    expect(await saldoGl(ACC.utangBunga)).toBe(300_000);
  });

  test('§23 rate 0 TIDAK menghasilkan jurnal apa pun', async () => {
    await setorSimpananBerjangka({
      anggotaId: ANGGOTA, nominal: 3_000_000, tanggal: '2026-01-05',
      tenorBulan: 3, sumberDana: 'KAS', createdBy: 'user-1',
    });
    const hasil = await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-04-05');

    expect(hasil.periodeDiakru).toBe(0);
    expect(await saldoGl(ACC.utangBunga)).toBe(0);
    expect(await saldoGl(ACC.bebanBunga)).toBe(0);
  });

  test('§21 seluruh tenor terakru penuh = bunga kontrak (residual tertangani)', async () => {
    await setorSimpananBerjangka({
      anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
      tenorBulan: 12, sukuBungaPerTahun: 10, sumberDana: 'KAS', createdBy: 'user-1',
    });
    // 10jt x 10% x 12/12 = 1.000.000 -> 12 periode, tidak habis dibagi.
    await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2027-01-05');

    expect(await saldoGl(ACC.utangBunga)).toBe(1_000_000);
    const kontrak = (await listSimpananBerjangka(ANGGOTA))[0];
    expect(kontrak.bungaTerakru).toBe(1_000_000);
  });
});

// ============================================================
// §25/§41 — IDEMPOTENSI PEMICU BERSAMAAN
// ============================================================

describe('§25/§41 idempotensi pemicu bersamaan', () => {
  test('background + startup + focus hampir bersamaan -> satu event per periode', async () => {
    await setorSimpananBerjangka({
      anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
      tenorBulan: 12, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1',
    });

    await Promise.all([
      jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-03-05'),
      jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-03-05'),
      jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-03-05'),
    ]);

    const event = await testDb.getAllAsync<{ nomor_periode: number }>(
      `SELECT nomor_periode FROM simpanan_berjangka_bunga ORDER BY nomor_periode`
    );
    expect(event.map((e) => e.nomor_periode)).toEqual([1, 2]);
    expect(await saldoGl(ACC.utangBunga)).toBe(200_000);
  });

  test('§20 database menolak akrual periode ganda sebagai perlindungan terakhir', async () => {
    await setorSimpananBerjangka({
      anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
      tenorBulan: 12, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1',
    });
    await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-02-05');
    const kontrak = (await listSimpananBerjangka(ANGGOTA))[0];

    await expect(
      testDb.runAsync(
        `INSERT INTO simpanan_berjangka_bunga
          (id, simpanan_berjangka_id, nomor_periode, tanggal_akhir_periode, bunga, created_by, created_at)
         VALUES ('dup', ?, 1, '2026-02-05', 100000, 'user-1', 'x')`,
        kontrak.id
      )
    ).rejects.toThrow();
  });
});

// ============================================================
// §39 — MULTI-KONTRAK INDEPENDEN
// ============================================================

test('§39 tiga kontrak berbeda diproses independen', async () => {
  const now = new Date().toISOString();
  for (const [id, nomor] of [['anggota-2', 'A002'], ['anggota-3', 'A003']] as const) {
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES (?,?,?,?,?, 'AKTIF', ?,?)`,
      id, nomor, `123456789012345${nomor.slice(-1)}`, `Anggota ${nomor}`, '2020-01-01', now, now
    );
  }

  await setorSimpananBerjangka({ anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05', tenorBulan: 12, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1' });
  await setorSimpananBerjangka({ anggotaId: 'anggota-2', nominal: 5_000_000, tanggal: '2026-01-05', tenorBulan: 6, sukuBungaPerTahun: 6, sumberDana: 'KAS', createdBy: 'user-1' });
  await setorSimpananBerjangka({ anggotaId: 'anggota-3', nominal: 3_000_000, tanggal: '2026-01-05', tenorBulan: 3, sumberDana: 'KAS', createdBy: 'user-1' });

  await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-03-05');

  // A: 10jt x12% /12 = 100.000/bln x2 = 200.000
  // B:  5jt x 6% x 6/12 = 150.000 total / 6 = 25.000/bln x2 = 50.000
  // C: rate 0 -> 0
  expect(await saldoGl(ACC.utangBunga)).toBe(250_000);

  const a = (await listSimpananBerjangka(ANGGOTA))[0];
  const b = (await listSimpananBerjangka('anggota-2'))[0];
  const c = (await listSimpananBerjangka('anggota-3'))[0];
  expect(a.bungaTerakru).toBe(200_000);
  expect(b.bungaTerakru).toBe(50_000);
  expect(c.bungaTerakru).toBe(0);
  // §37 pokok tidak pernah berubah oleh bunga.
  expect(a.nominal).toBe(10_000_000);
  expect(b.nominal).toBe(5_000_000);
});

// ============================================================
// §27 — INTERAKSI JATUH TEMPO
// ============================================================

test('§27 catch-up menuntaskan bunga LALU menaikkan status ke JATUH_TEMPO', async () => {
  await setorSimpananBerjangka({
    anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
    tenorBulan: 3, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1',
  });

  const hasil = await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-04-05');

  expect(hasil.kontrakJatuhTempo).toBe(1);
  const k = (await listSimpananBerjangka(ANGGOTA))[0];
  expect(k.status).toBe('JATUH_TEMPO');
  // 10jt x 12% x 3/12 = 300.000, seluruhnya sudah terakru sebelum payout.
  expect(k.bungaTerakru).toBe(300_000);
  expect(await saldoGl(ACC.utangBunga)).toBe(300_000);
});

// ============================================================
// §26 — PERIODE TERTUTUP
// ============================================================

test('§26 periode TERTUTUP: tidak ada jurnal akrual, tidak ada mutasi separuh', async () => {
  await setorSimpananBerjangka({
    anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
    tenorBulan: 12, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1',
  });
  await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);

  const hasil = await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-04-05');

  expect(hasil.gagal.length).toBeGreaterThan(0);
  expect(await saldoGl(ACC.utangBunga)).toBe(0);
  expect(await testDb.getAllAsync(`SELECT id FROM simpanan_berjangka_bunga`)).toHaveLength(0);
  // Subledger tidak ikut termutasi walau jurnalnya gagal.
  expect((await listSimpananBerjangka(ANGGOTA))[0].bungaTerakru).toBe(0);
});

// ============================================================
// §42 — IDEMPOTENSI REGISTRASI TASK
// ============================================================

describe('§42 registrasi background task', () => {
  test('membuka aplikasi 10 kali -> SATU task terdaftar', async () => {
    for (let i = 0; i < 10; i++) {
      await daftarkanTaskAkrualBerjangka('user-1');
    }
    expect(taskTerdaftar.size).toBe(1);
    expect(taskTerdaftar.has(NAMA_TASK_AKRUAL_BERJANGKA)).toBe(true);
    // registerTaskAsync hanya benar-benar dipanggil sekali.
    expect(registerDipanggil).toBe(1);
  });

  test('kegagalan registrasi tidak melempar (perangkat tanpa dukungan background)', async () => {
    await expect(daftarkanTaskAkrualBerjangka('user-1')).resolves.not.toThrow();
  });
});

// ============================================================
// §2/§3 — KEBIJAKAN PENARIKAN DINI
// ============================================================

describe('§2/§3 kebijakan penarikan dini', () => {
  test('POLICY FOUND = NO: konstanta kebijakan bernilai false', () => {
    expect(KEBIJAKAN_PENARIKAN_DINI_TERSEDIA).toBe(false);
  });

  test('kelayakan pencairan mengikuti status kontrak', () => {
    expect(evaluasiKelayakanPencairan('JATUH_TEMPO')).toBe('BOLEH_NORMAL');
    expect(evaluasiKelayakanPencairan('AKTIF')).toBe('DINI_TANPA_KEBIJAKAN');
    expect(evaluasiKelayakanPencairan('DICAIRKAN')).toBe('TIDAK_BERLAKU');
    expect(evaluasiKelayakanPencairan('DIBATALKAN')).toBe('TIDAK_BERLAKU');
  });

  test('kontrak AKTIF sebelum jatuh tempo ditolak dengan alasan kebijakan yang eksplisit', async () => {
    await setorSimpananBerjangka({
      anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
      tenorBulan: 12, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1',
    });
    const kontrak = (await listSimpananBerjangka(ANGGOTA))[0];

    const ringkasan = await getRingkasanPencairan(kontrak.id);
    expect(ringkasan.alasanTidakBolehCair).toContain('belum jatuh tempo');
    expect(ringkasan.catatanKebijakanPenarikanDini).toBe(PESAN_PENARIKAN_DINI_TANPA_KEBIJAKAN);
  });

  test('TIDAK ADA penalti/forfeiture yang dikarang: bunga terakru tetap utuh pada kontrak AKTIF', async () => {
    await setorSimpananBerjangka({
      anggotaId: ANGGOTA, nominal: 10_000_000, tanggal: '2026-01-05',
      tenorBulan: 12, sukuBungaPerTahun: 12, sumberDana: 'KAS', createdBy: 'user-1',
    });
    await jalankanCatchUpAkrualSimpananBerjangka('user-1', '2026-03-05');

    const kontrak = (await listSimpananBerjangka(ANGGOTA))[0];
    expect(kontrak.bungaTerakru).toBe(200_000);
    // Tidak ada akun pendapatan penalti yang tersentuh sama sekali.
    const akunTerpakai = await testDb.getAllAsync<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM journal_entry`
    );
    expect(akunTerpakai.map((a) => a.account_id).sort()).toEqual(
      [ACC.kas, ACC.berjangka, ACC.utangBunga, ACC.bebanBunga].sort()
    );
  });
});
