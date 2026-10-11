import { readFileSync } from 'fs';
import { join } from 'path';
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

import { listRekening } from '@/services/KasBankService';
import { resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { catatBagianShuInvestasi, catatPenerimaanBagianShu } from '@/services/BagianShuService';

/**
 * KAS KECIL — TIDAK TERSEDIA UNTUK TRANSAKSI BARU, HISTORI TETAP TERBACA.
 *
 * Kas Kecil dinonaktifkan sejak Phase 18 §4: akun `1-1001` di-set
 * `is_active = 0` dan mapping `KAS_KECIL` dihapus oleh migrasi v18 —
 * akunnya TIDAK dihapus, karena instalasi lama masih memegang jurnal di
 * sana.
 *
 * Suite ini mengunci kedua sisi sekaligus, yang sebelumnya tersebar:
 * bahwa Kas Kecil tidak dapat masuk ke transaksi baru lewat jalur mana
 * pun, DAN bahwa saldo historisnya tetap dapat dibaca. Keduanya harus
 * benar bersamaan; menguji salah satu saja menyisakan kemungkinan
 * "dibersihkan" dengan cara yang merusak histori.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

const AKUN = {
  kasUmum: 'acc-kas-umum',
  kasKecil: 'acc-kas-kecil',
  bank: 'acc-bank',
  piutang: 'acc-piutang',
  pendapatan: 'acc-pendapatan',
  modal: 'acc-modal',
};

async function seedAkun(
  id: string, kode: string, nama: string, kat: string,
  nb: 'DEBIT' | 'KREDIT', aktif = 1
) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,?,1,?,?)`,
    id, kode, nama, kat, nb, aktif, now, now
  );
}

/**
 * Instalasi LAMA: Kas Kecil masih punya mapping dan jurnal historis,
 * tetapi akunnya sudah dinonaktifkan — persis keadaan sesudah migrasi
 * v18 pada perangkat yang sudah lama dipakai.
 */
async function seedInstalasiLama(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAkun(AKUN.kasUmum, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAkun(AKUN.kasKecil, '1-1001', 'Kas Kecil', 'ASET', 'DEBIT', 0); // nonaktif
  await seedAkun(AKUN.bank, '1-1100', 'Bank BRI', 'ASET', 'DEBIT');
  await seedAkun(AKUN.piutang, '1-1220', 'Piutang Pendapatan Investasi', 'ASET', 'DEBIT');
  await seedAkun(AKUN.pendapatan, '4-1300', 'Pendapatan Hasil Investasi', 'PENDAPATAN', 'KREDIT');
  await seedAkun(AKUN.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');

  for (const [tt, acc] of [
    ['KAS_UMUM', AKUN.kasUmum],
    ['KAS_KECIL', AKUN.kasKecil], // mapping warisan instalasi lama
    ['BAGIAN_SHU_INVESTASI_PIUTANG', AKUN.piutang],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,'DEFAULT',?)`,
      `map-${tt}`, tt, acc
    );
  }
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id)
     VALUES ('map-shu-d','BAGIAN_SHU_INVESTASI','DEBIT_PIUTANG',?)`, AKUN.piutang
  );
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id)
     VALUES ('map-shu-k','BAGIAN_SHU_INVESTASI','KREDIT_PENDAPATAN',?)`, AKUN.pendapatan
  );
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id)
     VALUES ('map-shu-t','BAGIAN_SHU_PENERIMAAN','KREDIT_PIUTANG',?)`, AKUN.piutang
  );

  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank BRI','123456','Koperasi Uji',?,1,?)`,
    AKUN.bank, now
  );

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2025', 2025, '2025-01-01', '2025-12-31', 'CLOSED')`
  );

  // Jurnal historis Kas Kecil — inilah yang TIDAK boleh hilang.
  await testDb.runAsync(
    `INSERT INTO journal (id, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, nomor_jurnal)
     VALUES ('j-lama','2025-01-05','p2025','KAS_KECIL','Setoran kas kecil lama','POSTED','user-1',?,?,'JRN-2025-0001')`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('e1','j-lama',?,250000,0,1)`, AKUN.kasKecil
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('e2','j-lama',?,0,250000,2)`, AKUN.modal
  );

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026', 2026, '2026-01-01', '2026-12-31', 'OPEN')`
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                            sumber_dana, status, created_by, created_at, updated_at)
     VALUES ('inv-1','INV-2026-001','KOPERASI_LAIN','Koperasi Mitra',50000000,'2026-01-10',
             'KAS','AKTIF','user-1',?,?)`,
    now, now
  );
}

// ===========================================================================
// DAFTAR REKENING AKTIF
// ===========================================================================

describe('Daftar rekening — Kas Kecil tidak lagi menjadi pilihan aktif', () => {
  beforeEach(async () => {
    await seedInstalasiLama();
  });

  it('Kas Kecil tetap muncul di daftar, tetapi ditandai TIDAK AKTIF', async () => {
    const rows = await listRekening();
    const kasKecil = rows.find((r) => r.jenis === 'KAS_KECIL');
    expect(kasKecil).toBeDefined();
    expect(kasKecil!.aktif).toBe(false);
    // Saldonya tetap terbaca dari jurnal historis — inilah alasan
    // barisnya TIDAK dihapus.
    expect(kasKecil!.saldo).toBe(250000);
  });

  it('Kas Umum dan bank tetap aktif dan tetap dapat dipilih', async () => {
    const rows = await listRekening();
    const kasUmum = rows.find((r) => r.jenis === 'KAS');
    const bank = rows.find((r) => r.jenis === 'BANK');
    expect(kasUmum!.aktif).toBe(true);
    expect(bank!.aktif).toBe(true);
  });

  it('setelah disaring seperti picker (aktif saja), Kas Kecil hilang dari pilihan', async () => {
    const rows = await listRekening();
    const dapatDipilih = rows.filter((r) => r.aktif !== false);
    expect(dapatDipilih.map((r) => r.jenis)).not.toContain('KAS_KECIL');
    expect(dapatDipilih.map((r) => r.jenis)).toContain('KAS');
    expect(dapatDipilih.map((r) => r.jenis)).toContain('BANK');
  });

  it('nol opsi duplikat di daftar rekening', async () => {
    const rows = await listRekening();
    const kunci = rows.map((r) => `${r.jenis}-${r.id}`);
    expect(new Set(kunci).size).toBe(kunci.length);
  });

  it('instalasi baru — tanpa mapping KAS_KECIL, barisnya tidak muncul sama sekali', async () => {
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'KAS_KECIL'`);
    const rows = await listRekening();
    expect(rows.find((r) => r.jenis === 'KAS_KECIL')).toBeUndefined();
    expect(rows.find((r) => r.jenis === 'KAS')).toBeDefined();
  });
});

// ===========================================================================
// PENJAGAAN DI LAPISAN SERVICE
// ===========================================================================

describe('Service guard — Kas Kecil ditolak walau UI dilewati', () => {
  beforeEach(async () => {
    await seedInstalasiLama();
  });

  it('resolveKasBankAccountId menolak Kas Kecil karena akunnya nonaktif', async () => {
    // Bypass total: memanggil resolver langsung dengan KAS_KECIL.
    await expect(resolveKasBankAccountId(testDb as never, 'KAS_KECIL')).rejects.toThrow();
    // KAS dan BANK tetap berfungsi normal.
    expect(await resolveKasBankAccountId(testDb as never, 'KAS')).toBe(AKUN.kasUmum);
    expect(await resolveKasBankAccountId(testDb as never, 'BANK', 'bank-1')).toBe(AKUN.bank);
  });

  it('penerimaan Bagian SHU dengan Kas Kecil ditolak dan NOL jurnal terbentuk', async () => {
    const akrual = await catatBagianShuInvestasi({
      investasiId: 'inv-1',
      tanggalHak: '2026-03-20',
      jumlah: 5_000_000,
      jenisDokumen: 'Berita Acara RAT',
      nomorDokumen: 'BA-RAT-2026-014',
      tanggalDokumen: '2026-03-20',
      createdBy: 'user-1',
    });
    await expect(
      catatPenerimaanBagianShu({
        bagianShuId: akrual.id, tanggal: '2026-04-05', jumlah: 1_000_000,
        sumberDana: 'KAS_KECIL' as never, nomorReferensi: 'TRM-KK', createdBy: 'user-1',
      })
    ).rejects.toThrow();
    const j = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'BAGIAN_SHU_PENERIMAAN'`
    );
    expect(j!.n).toBe(0);
    // Nol entri baru yang menyentuh akun Kas Kecil.
    const entri = await testDb.getAllAsync<{ journal_id: string }>(
      `SELECT journal_id FROM journal_entry WHERE account_id = ?`, AKUN.kasKecil
    );
    expect(entri).toHaveLength(1);
    expect(entri[0].journal_id).toBe('j-lama');
  });

  it('KAS dan BANK tetap menghasilkan jurnal yang benar', async () => {
    const akrual = await catatBagianShuInvestasi({
      investasiId: 'inv-1', tanggalHak: '2026-03-20', jumlah: 5_000_000,
      jenisDokumen: 'Berita Acara RAT', nomorDokumen: 'BA-RAT-2026-020',
      tanggalDokumen: '2026-03-20', createdBy: 'user-1',
    });
    const viaKas = await catatPenerimaanBagianShu({
      bagianShuId: akrual.id, tanggal: '2026-04-05', jumlah: 1_000_000,
      sumberDana: 'KAS', nomorReferensi: 'TRM-KAS', createdBy: 'user-1',
    });
    const viaBank = await catatPenerimaanBagianShu({
      bagianShuId: akrual.id, tanggal: '2026-04-06', jumlah: 2_000_000,
      sumberDana: 'BANK', bankAccountId: 'bank-1',
      nomorReferensi: 'TRM-BANK', createdBy: 'user-1',
    });
    const debitDari = async (journalId: string) =>
      (
        await testDb.getFirstAsync<{ account_id: string }>(
          `SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit > 0`,
          journalId
        )
      )!.account_id;
    expect(await debitDari(viaKas.journalId)).toBe(AKUN.kasUmum);
    expect(await debitDari(viaBank.journalId)).toBe(AKUN.bank);
  });
});

// ===========================================================================
// KEAMANAN HISTORI
// ===========================================================================

describe('Historical safety — Kas Kecil lama tidak disentuh', () => {
  beforeEach(async () => {
    await seedInstalasiLama();
  });

  it('akun, jurnal, dan entri Kas Kecil tetap ada dan tidak berubah', async () => {
    const akun = await testDb.getFirstAsync<{ kode: string; is_active: number }>(
      `SELECT kode, is_active FROM account WHERE id = ?`, AKUN.kasKecil
    );
    expect(akun).not.toBeNull();
    expect(akun!.is_active).toBe(0); // nonaktif, BUKAN terhapus

    const jurnal = await testDb.getFirstAsync<{ status: string; nomor_jurnal: string }>(
      `SELECT status, nomor_jurnal FROM journal WHERE id = 'j-lama'`
    );
    expect(jurnal!.status).toBe('POSTED');
    expect(jurnal!.nomor_jurnal).toBe('JRN-2025-0001');

    const entri = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = 'j-lama' ORDER BY urutan`
    );
    expect(entri).toHaveLength(2);
    expect(entri[0].debit).toBe(250000);
  });

  it('integritas database utuh', async () => {
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk!.foreign_keys).toBe(1);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });
});

// ===========================================================================
// KONTRAK UI
// ===========================================================================

describe('Kontrak UI — penyaringan ada di picker bersama, bukan ditempel per layar', () => {
  it('RekeningPicker menyaring rekening nonaktif untuk transaksi baru', () => {
    const picker = baca('src/components/RekeningPicker.tsx');
    expect(picker).toMatch(/rows\.filter\(\(r\) => r\.aktif !== false\)/);
  });

  it('form saldo awal tidak lagi menawarkan Kas Kecil', () => {
    const src = baca('src/screens/Pengaturan/SaldoAwalFormScreen.tsx');
    expect(src).not.toMatch(/value:\s*'KAS_KECIL'/);
    expect(src).not.toMatch(/jenis:\s*'KAS_KECIL'/);
  });

  it('daftar rekening tetap dapat menampilkan saldo historis Kas Kecil', () => {
    // listRekening() sengaja TIDAK menyaring status aktif — penyaringan
    // dilakukan di picker. Kalau penyaringan dipindah ke service,
    // saldo historis Kas Kecil akan hilang dari seluruh aplikasi.
    const svc = baca('src/services/KasBankService.ts');
    expect(svc).toMatch(/aktif: !!row\.is_active/);
    expect(svc).not.toMatch(/WHERE a\.is_active = 1/);
  });
});
