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

import {
  setorSimpananBerjangka,
  listSimpananBerjangka,
  getRingkasanSimpananBerjangka,
  getTotalPokokSimpananBerjangkaPadaDb,
  normalisasiSukuBunga,
  PESAN_TOLAK_PENCAIRAN_LEWAT_SUKARELA,
  listAnggotaDenganBerjangkaEligible,
} from '@/services/SimpananBerjangkaService';
import { setorSimpanan, tarikSimpananSukarela, getSaldoSimpanan } from '@/services/SimpananService';
import { getPosisiKeuangan } from '@/reports/FinancialReports';
import { MissingAccountMappingError } from '@/accounting/AccountMapping';

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  sukarela: 'acc-simpanan-sukarela',
  berjangka: 'acc-simpanan-berjangka',
  modal: 'acc-modal',
};

const ANGGOTA_ID = 'anggota-1';
const BANK_ID = 'bank-1';

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
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

async function seedFixture(opts: { mappingBerjangka?: boolean; bankAktif?: boolean } = {}): Promise<TestDb> {
  const { mappingBerjangka = true, bankAktif = true } = opts;
  const db = await createTestDb();
  await seedKebijakanProdukUji(db); // RC-S128: penempatan berjangka mewajibkan kebijakan produk
  const now = new Date().toISOString();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.sukarela, '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.berjangka, '2-1210', 'Simpanan Anggota (Berjangka)', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);
  await seedMapping(db, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.modal);
  if (mappingBerjangka) {
    await seedMapping(db, 'SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', ACC.berjangka);
  }

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('period-2026', 2026, '2026-01-01', '2026-12-31', 'OPEN')`
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
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
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    BANK_ID,
    'Bank Uji',
    '123456',
    'Koperasi Uji',
    ACC.bank,
    bankAktif ? 1 : 0,
    now
  );

  return db;
}

const setoranDasar = {
  anggotaId: ANGGOTA_ID,
  nominal: 10_000_000,
  tanggal: '2026-09-04',
  sumberDana: 'KAS' as const,
  createdBy: 'user-1',
};

// ============================================================
// §29 — TES SERVICE
// ============================================================

describe('§29 setoran & validasi', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test.each([3, 6, 12] as const)('setor tenor %i bulan berhasil', async (tenor) => {
    const hasil = await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: tenor });
    expect(hasil.journalId).toBeTruthy();
    const kontrak = await listSimpananBerjangka(ANGGOTA_ID);
    expect(kontrak[0].tenorBulan).toBe(tenor);
    expect(kontrak[0].status).toBe('AKTIF');
  });

  test('rate dikosongkan -> tersimpan 0', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });
    expect((await listSimpananBerjangka(ANGGOTA_ID))[0].sukuBungaPerTahun).toBe(0);
  });

  test('rate eksplisit 0 -> tersimpan 0', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3, sukuBungaPerTahun: 0 });
    expect((await listSimpananBerjangka(ANGGOTA_ID))[0].sukuBungaPerTahun).toBe(0);
  });

  test('rate > 0 (berdesimal) tersimpan apa adanya', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 6, sukuBungaPerTahun: 8.5 });
    expect((await listSimpananBerjangka(ANGGOTA_ID))[0].sukuBungaPerTahun).toBe(8.5);
  });

  test('rate negatif DITOLAK', async () => {
    await expect(
      setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3, sukuBungaPerTahun: -1 })
    ).rejects.toThrow(/tidak boleh negatif/i);
  });

  test('rate NaN / Infinity DITOLAK', () => {
    expect(() => normalisasiSukuBunga(NaN)).toThrow(/tidak valid/i);
    expect(() => normalisasiSukuBunga(Infinity)).toThrow(/tidak valid/i);
  });

  test.each([1, 2, 4, 9, 24])('tenor %i DITOLAK walau service dipanggil langsung', async (tenor) => {
    await expect(
      setorSimpananBerjangka({ ...setoranDasar, tenorBulan: tenor as any })
    ).rejects.toThrow(/hanya 3, 6, atau 12 bulan/i);
    expect(await listSimpananBerjangka(ANGGOTA_ID)).toHaveLength(0);
  });

  test('nominal 0 / negatif / pecahan DITOLAK', async () => {
    for (const nominal of [0, -1, 1000.5]) {
      await expect(
        setorSimpananBerjangka({ ...setoranDasar, nominal, tenorBulan: 3 })
      ).rejects.toThrow(/bilangan bulat Rupiah/i);
    }
  });

  test('anggota NONAKTIF DITOLAK', async () => {
    await testDb.runAsync(`UPDATE anggota SET status = 'KELUAR' WHERE id = ?`, ANGGOTA_ID);
    await expect(setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 })).rejects.toThrow();
    expect(await listSimpananBerjangka(ANGGOTA_ID)).toHaveLength(0);
  });

  test('periode TERTUTUP DITOLAK', async () => {
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED'`);
    await expect(setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 })).rejects.toThrow();
    expect(await listSimpananBerjangka(ANGGOTA_ID)).toHaveLength(0);
  });

  test('idempotency: submit dua kali -> satu kontrak, satu jurnal', async () => {
    const key = 'setor-berjangka-abc';
    const a = await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3, idempotencyKey: key });
    const b = await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3, idempotencyKey: key });

    expect(a.duplikat).toBe(false);
    expect(b.duplikat).toBe(true);
    expect(b.id).toBe(a.id);
    expect(await listSimpananBerjangka(ANGGOTA_ID)).toHaveLength(1);

    const jurnal = await testDb.getAllAsync<{ id: string }>(
      `SELECT id FROM journal WHERE sumber_transaksi = 'SIMPANAN_BERJANGKA'`
    );
    expect(jurnal).toHaveLength(1);
  });

  test('idempotency TIDAK diturunkan dari nominal+tanggal: dua penempatan sah tetap tercatat', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });
    expect(await listSimpananBerjangka(ANGGOTA_ID)).toHaveLength(2);
  });

  test('sumber dana BANK memakai akun bank', async () => {
    await setorSimpananBerjangka({
      ...setoranDasar,
      tenorBulan: 6,
      sumberDana: 'BANK',
      bankAccountId: BANK_ID,
    });
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number }>(
      `SELECT account_id, debit FROM journal_entry WHERE debit > 0`
    );
    expect(baris[0].account_id).toBe(ACC.bank);
  });

  test('BANK tanpa bankAccountId DITOLAK — tidak diam-diam memakai Kas', async () => {
    await expect(
      setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3, sumberDana: 'BANK' })
    ).rejects.toThrow(/bankAccountId wajib/i);
    expect(await listSimpananBerjangka(ANGGOTA_ID)).toHaveLength(0);
    expect(
      await testDb.getAllAsync(`SELECT id FROM journal_entry WHERE account_id = ?`, ACC.kas)
    ).toHaveLength(0);
  });
});

// ============================================================
// §38 — ATOMICITY
// ============================================================

describe('§38 atomicity', () => {
  test('mapping 2-1210 hilang -> MissingAccountMappingError & rollback total', async () => {
    testDb = await seedFixture({ mappingBerjangka: false });

    await expect(setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 })).rejects.toThrow(
      MissingAccountMappingError
    );

    expect(await testDb.getAllAsync(`SELECT id FROM journal`)).toHaveLength(0);
    expect(await testDb.getAllAsync(`SELECT id FROM journal_entry`)).toHaveLength(0);
    expect(await testDb.getAllAsync(`SELECT id FROM simpanan_berjangka`)).toHaveLength(0);
  });
});

// ============================================================
// §6/§31 — AKUNTANSI
// ============================================================

describe('§6/§31 jurnal & rekonsiliasi', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('Dr Kas / Cr 2-1210 sebesar POKOK, debit = kredit', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 12, sukuBungaPerTahun: 6 });

    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry ORDER BY urutan`
    );
    expect(baris).toHaveLength(2);
    expect(baris[0]).toMatchObject({ account_id: ACC.kas, debit: 10_000_000, kredit: 0 });
    expect(baris[1]).toMatchObject({ account_id: ACC.berjangka, debit: 0, kredit: 10_000_000 });

    const total = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT SUM(debit) d, SUM(kredit) k FROM journal_entry`
    );
    expect(total!.d).toBe(total!.k);
  });

  test('ANTI DOUBLE-COUNT: bunga TIDAK ikut dikredit ke liabilitas saat penempatan', async () => {
    // Rate 12%/tahun selama 12 bulan = Rp1.200.000 bunga kontraktual.
    // Liabilitas awal harus TETAP Rp10.000.000, bukan Rp11.200.000.
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 12, sukuBungaPerTahun: 12 });
    const kredit = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) total FROM journal_entry WHERE account_id = ?`,
      ACC.berjangka
    );
    expect(kredit!.total).toBe(10_000_000);
  });

  test('INTEREST ACCRUAL NOT IMPLEMENTED: rate > 0 tidak menghasilkan jurnal bunga apa pun', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 12, sukuBungaPerTahun: 8.5 });
    // Hanya SATU jurnal (penempatan). Tidak ada jurnal beban/utang bunga.
    expect(await testDb.getAllAsync(`SELECT id FROM journal`)).toHaveLength(1);
    const akunTerpakai = await testDb.getAllAsync<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM journal_entry`
    );
    expect(akunTerpakai.map((a) => a.account_id).sort()).toEqual([ACC.kas, ACC.berjangka].sort());
  });

  test('§31 Aset = Liabilitas + Ekuitas, variance 0; 2-1210 di LIABILITAS saja', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });

    const r = await getPosisiKeuangan(testDb as any, '2026-12-31');
    expect(r.selisih).toBe(0);
    expect(r.isBalanced).toBe(true);

    const baris = r.liabilitas.find((x) => x.kode === '2-1210');
    expect(baris?.saldo).toBe(10_000_000);
    expect(r.ekuitas.some((x) => x.kode === '2-1210')).toBe(false);
    expect(r.aset.some((x) => x.kode === '2-1210')).toBe(false);
  });

  test('§45 rekonsiliasi: subledger pokok = saldo GL 2-1210', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });
    await setorSimpananBerjangka({ ...setoranDasar, nominal: 5_000_000, tenorBulan: 6 });

    const subledger = await getTotalPokokSimpananBerjangkaPadaDb(testDb as any);
    const gl = await testDb.getFirstAsync<{ saldo: number }>(
      `SELECT COALESCE(SUM(kredit) - SUM(debit), 0) saldo FROM journal_entry WHERE account_id = ?`,
      ACC.berjangka
    );
    expect(subledger).toBe(15_000_000);
    expect(gl!.saldo).toBe(subledger);
  });
});

// ============================================================
// §15/§16/§28 — ISOLASI DARI SIMPANAN SUKARELA
// ============================================================

describe('§15/§16/§28 isolasi dari simpanan existing', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('simpanan berjangka TIDAK menambah saldo sukarela anggota', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });
    const saldo = await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'SUKARELA');
    expect(saldo).toBe(0);
  });

  test('berjangka TIDAK dapat ditarik lewat tarikSimpananSukarela (saldo sukarela tetap 0)', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });
    await expect(
      tarikSimpananSukarela({
        anggotaId: ANGGOTA_ID,
        tanggal: '2026-09-10',
        nominal: 1_000_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow();
    // Kontrak berjangka tidak tersentuh.
    expect((await listSimpananBerjangka(ANGGOTA_ID))[0].status).toBe('AKTIF');
  });

  test('setoran SUKARELA tetap berfungsi & tidak tercampur berjangka', async () => {
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-02-01',
      nominal: 2_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });

    expect(await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'SUKARELA')).toBe(2_000_000);
    expect(await getTotalPokokSimpananBerjangkaPadaDb(testDb as any)).toBe(10_000_000);

    const sukarelaGl = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(kredit)-SUM(debit),0) s FROM journal_entry WHERE account_id = ?`,
      ACC.sukarela
    );
    expect(sukarelaGl!.s).toBe(2_000_000);
  });

  test('pesan penolakan jalur sukarela tetap eksplisit menyebut pencairan berjangka', () => {
    expect(PESAN_TOLAK_PENCAIRAN_LEWAT_SUKARELA).toMatch(/pencairan simpanan berjangka/i);
  });
});

// ============================================================
// §22/§23/§35/§36 — RINGKASAN & HISTORI
// ============================================================

describe('§22/§23 ringkasan anggota & histori', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('ringkasan: saldo pokok, jumlah kontrak aktif, jatuh tempo terdekat', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 12 }); // JT 2027-09-04
    await setorSimpananBerjangka({ ...setoranDasar, nominal: 4_000_000, tenorBulan: 3 }); // JT 2026-12-04

    const ringkasan = await getRingkasanSimpananBerjangka(ANGGOTA_ID);
    expect(ringkasan.saldoPokok).toBe(14_000_000);
    expect(ringkasan.jumlahKontrakAktif).toBe(2);
    expect(ringkasan.jatuhTempoTerdekat).toBe('2026-12-04');
  });

  test('histori dibaca dari SUBLEDGER dan memuat syarat kontrak lengkap', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 6, sukuBungaPerTahun: 7.25 });
    const [kontrak] = await listSimpananBerjangka(ANGGOTA_ID);

    expect(kontrak.nomorTransaksi).toMatch(/^SPB-2026-/);
    expect(kontrak.nominal).toBe(10_000_000);
    expect(kontrak.tenorBulan).toBe(6);
    expect(kontrak.sukuBungaPerTahun).toBe(7.25);
    expect(kontrak.tanggalMulai).toBe('2026-09-04');
    expect(kontrak.tanggalJatuhTempo).toBe('2027-03-04');
    expect(kontrak.status).toBe('AKTIF');
  });

  test('kontrak DICAIRKAN/DIBATALKAN tidak dihitung dalam ringkasan aktif', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });
    await testDb.runAsync(`UPDATE simpanan_berjangka SET status = 'DICAIRKAN'`);
    const ringkasan = await getRingkasanSimpananBerjangka(ANGGOTA_ID);
    expect(ringkasan.saldoPokok).toBe(0);
    expect(ringkasan.jumlahKontrakAktif).toBe(0);
    expect(ringkasan.jatuhTempoTerdekat).toBeNull();
  });
});

// ============================================================
// §45 — DOMAIN REKONSILIASI PENUH
// ============================================================

import { jalankanRekonsiliasiLengkap } from '@/accounting/FullReconciliation';

describe('§45 domain rekonsiliasi "Savings berjangka (pokok)"', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('tanpa aktivitas & tanpa mapping -> TIDAK_BERLAKU (bukan gagal palsu)', async () => {
    testDb = await seedFixture({ mappingBerjangka: false });
    const hasil = await jalankanRekonsiliasiLengkap(testDb as any);
    const baris = hasil.baris.find((b) => b.domain === 'Savings berjangka (pokok)');
    expect(baris?.status).toBe('TIDAK_BERLAKU');
  });

  test('setelah setoran -> SEIMBANG, variance 0', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 3 });
    await setorSimpananBerjangka({ ...setoranDasar, nominal: 2_500_000, tenorBulan: 12 });

    const hasil = await jalankanRekonsiliasiLengkap(testDb as any);
    const baris = hasil.baris.find((b) => b.domain === 'Savings berjangka (pokok)');
    expect(baris?.subledger).toBe(12_500_000);
    expect(baris?.gl).toBe(12_500_000);
    expect(baris?.variance).toBe(0);
    expect(baris?.status).toBe('SEIMBANG');
  });

  test('bunga kontraktual TIDAK ikut ke baris rekonsiliasi pokok', async () => {
    await setorSimpananBerjangka({ ...setoranDasar, tenorBulan: 12, sukuBungaPerTahun: 10 });
    const hasil = await jalankanRekonsiliasiLengkap(testDb as any);
    const baris = hasil.baris.find((b) => b.domain === 'Savings berjangka (pokok)');
    expect(baris?.subledger).toBe(10_000_000);
    expect(baris?.variance).toBe(0);
  });
});

/**
 * RC-S118.1 — `semuaData` pada daftar kandidat pencairan berjangka.
 *
 * Yang dibuktikan di sini terhadap database sungguhan: query tetap sah
 * setelah klausa LIMIT dilepas, dan melepas batas TIDAK membuat anggota
 * tanpa kontrak berjangka ikut muncul — daftar ini memang hanya boleh
 * berisi anggota yang punya kontrak yang masih dapat diproses.
 */
describe('§RC-S118.1 listAnggotaDenganBerjangkaEligible semuaData', () => {
  const JUMLAH_BERKONTRAK = 35; // sengaja di atas 30, yaitu batas lama
  const TANPA_KONTRAK = 'anggota-tanpa-kontrak';

  beforeEach(async () => {
    testDb = await seedFixture();
    const now = new Date().toISOString();
    const tambahAnggota = async (id: string, nomor: string, nama: string) => {
      await testDb.runAsync(
        `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
         VALUES (?,?,?,?,?,'AKTIF',?,?)`,
        id, nomor, `NIK-${nomor}`, nama, '2020-01-01', now, now
      );
    };

    for (let i = 0; i < JUMLAH_BERKONTRAK; i++) {
      const nomor = `K${String(i).padStart(3, '0')}`;
      await tambahAnggota(`berkontrak-${i}`, nomor, `Anggota Berkontrak ${nomor}`);
      await setorSimpananBerjangka({ ...setoranDasar, anggotaId: `berkontrak-${i}`, tenorBulan: 3 });
    }
    await tambahAnggota(TANPA_KONTRAK, 'K900', 'Anggota Tanpa Kontrak');
  });

  test('tanpa semuaData, daftar berhenti di 30 — perilaku lama tetap utuh', async () => {
    expect(await listAnggotaDenganBerjangkaEligible()).toHaveLength(30);
  });

  test('dengan semuaData, SELURUH anggota berkontrak muncul — lebih dari 30', async () => {
    const kandidat = await listAnggotaDenganBerjangkaEligible({ semuaData: true });
    expect(kandidat).toHaveLength(JUMLAH_BERKONTRAK);
  });

  test('semuaData TIDAK memunculkan anggota tanpa kontrak berjangka', async () => {
    const kandidat = await listAnggotaDenganBerjangkaEligible({ semuaData: true });
    expect(kandidat.find((k) => k.id === TANPA_KONTRAK)).toBeUndefined();
  });

  test('semuaData tetap menghormati pencarian', async () => {
    const kandidat = await listAnggotaDenganBerjangkaEligible({ search: 'K001', semuaData: true });
    expect(kandidat).toHaveLength(1);
    expect(kandidat[0].nomorAnggota).toBe('K001');
  });
});
