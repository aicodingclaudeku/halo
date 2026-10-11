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

import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  cairkanSimpananBerjangka,
  getStatusPeriodeBungaAnggota,
  kunciTransferBunga,
  TRANSAKSI_BUNGA_TRANSFER,
} from '@/services/SimpananBerjangkaLifecycleService';
import {
  jalankanCatchUpAkrualSimpananBerjangka,
  _resetCatchUpUntukTest,
} from '@/services/SimpananBerjangkaCatchUpService';

/**
 * §B FINALISASI — PEMICU OTOMATIS & STATUS DI LAYAR DETAIL ANGGOTA.
 *
 * Yang diuji di sini BUKAN mesin §B (sudah diuji terpisah di
 * `TransferBungaBerjangkaRcS53`), melainkan pertanyaan yang berbeda:
 * apakah §B benar-benar BERJALAN SENDIRI.
 *
 * Titik ujinya adalah `jalankanCatchUpAkrualSimpananBerjangka()` —
 * koordinator yang SUDAH dipakai ketiga pemicu aplikasi (startup,
 * background task OS, dan fokus layar Detail Anggota). Menguji
 * koordinator berarti menguji ketiganya sekaligus, karena tidak ada satu
 * pun dari mereka yang punya jalur akuntansi sendiri.
 *
 * Seluruh suite berjalan di atas SQLite sungguhan dengan skema produksi.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  berjangka: 'acc-2-1210',
  sukarela: 'acc-2-1200',
  utangBunga: 'acc-2-1710',
  bebanBunga: 'acc-5-1955',
  modal: 'acc-3-1000',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    nb,
    now,
    now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`,
    tt,
    role,
    accountId
  );
}

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedKebijakanProdukUji(db); // RC-S128: penempatan berjangka mewajibkan kebijakan produk
  const now = new Date().toISOString();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.berjangka, '2-1210', 'Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.sukarela, '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.utangBunga, '2-1710', 'Utang Bunga Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanBunga, '5-1955', 'Beban Bunga Simpanan Berjangka', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', ACC.berjangka);
  await seedMapping(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);
  await seedMapping(db, 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(db, 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', ACC.utangBunga);
  await seedMapping(db, 'SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_POKOK', ACC.berjangka);
  await seedMapping(db, 'SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_UTANG_BUNGA', ACC.utangBunga);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2027',2027,'2027-01-01','2027-12-31','OPEN')`
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-A','A001','1111111111111111','Anggota A','2020-01-01','AKTIF',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-B','A002','2222222222222222','Anggota B','2020-01-01','AKTIF',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank A','123','Koperasi',?,1,?)`,
    ACC.bank,
    now
  );
  return db;
}

async function saldoKredit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit) - SUM(je.debit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status = 'POSTED'`,
    accountId
  );
  return r?.s ?? 0;
}

async function saldoDebit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit) - SUM(je.kredit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status = 'POSTED'`,
    accountId
  );
  return r?.s ?? 0;
}

async function jumlahJurnalTransfer(): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = ?`,
    TRANSAKSI_BUNGA_TRANSFER
  );
  return r?.n ?? 0;
}

async function saldoSukarela(anggotaId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(CASE WHEN tipe='SETOR' THEN nominal
                              WHEN tipe='TARIK' THEN -nominal ELSE 0 END), 0) s
       FROM simpanan_transaksi WHERE anggota_id = ? AND jenis = 'SUKARELA'`,
    anggotaId
  );
  return r?.s ?? 0;
}

/** 12.000.000 @ 12%/tahun, tenor 3 bulan, mulai 15-01-2026 -> 120.000/periode. */
async function buatKontrak(anggotaId = 'anggota-A', rate = 12): Promise<string> {
  const hasil = await setorSimpananBerjangka({
    anggotaId,
    nominal: 12_000_000,
    tenorBulan: 3,
    sukuBungaPerTahun: rate,
    tanggal: '2026-01-15',
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return hasil.id;
}

/** Satu kali "aplikasi dibuka" pada tanggal tertentu. */
function pemicu(tanggal: string) {
  return jalankanCatchUpAkrualSimpananBerjangka('user-1', tanggal);
}

beforeEach(async () => {
  testDb = await seedFixture();
  _resetCatchUpUntukTest();
});

afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// PEMICU OTOMATIS
// ===========================================================================

describe('§B TRIGGER — startup / foreground', () => {
  it('1. startup TEPAT pada tanggal akhir periode memindahkan bunga tanpa campur tangan', async () => {
    await buatKontrak();

    // Tidak ada satu pun pemanggilan manual ke mesin §B di sini.
    const hasil = await pemicu('2026-02-15');

    expect(hasil.totalBungaDipindahkan).toBe(120_000);
    expect(hasil.periodeBungaDipindahkan).toBe(1);
    expect(await jumlahJurnalTransfer()).toBe(1);
    expect(await saldoSukarela('anggota-A')).toBe(120_000);
  });

  it('2. startup SEBELUM periode berakhir tidak memindahkan apa pun', async () => {
    await buatKontrak();
    const hasil = await pemicu('2026-02-01');

    expect(hasil.totalBungaDipindahkan).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(0);
    expect(await saldoSukarela('anggota-A')).toBe(0);
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
  });

  it('3-4. startup TERLAMBAT tetap memproses periode yang sudah lewat', async () => {
    await buatKontrak();
    // Periode 1 berakhir 15-02; aplikasi baru dibuka 20-02.
    const hasil = await pemicu('2026-02-20');

    expect(hasil.totalBungaDipindahkan).toBe(120_000);
    expect(await jumlahJurnalTransfer()).toBe(1);
  });

  it('5. tiga periode terlewat diproses SEMUANYA dalam satu pemicu', async () => {
    await buatKontrak();
    // Aplikasi tidak dibuka Januari-April, baru dibuka 20-04.
    const hasil = await pemicu('2026-04-20');

    expect(hasil.periodeBungaDipindahkan).toBe(3);
    expect(hasil.totalBungaDipindahkan).toBe(360_000);
    expect(await jumlahJurnalTransfer()).toBe(3);
    expect(await saldoSukarela('anggota-A')).toBe(360_000);
  });

  it('6. startup DUA KALI hanya menghasilkan satu jurnal per periode', async () => {
    await buatKontrak();
    const a = await pemicu('2026-02-20');
    _resetCatchUpUntukTest();
    const b = await pemicu('2026-02-20');

    expect(a.totalBungaDipindahkan).toBe(120_000);
    expect(b.totalBungaDipindahkan).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(1);
  });

  it('7. startup lalu foreground (pemicu berbeda) tidak menduplikasi', async () => {
    await buatKontrak();
    const startup = await pemicu('2026-02-20');
    _resetCatchUpUntukTest();
    // Layar Detail Anggota difokuskan — koordinator YANG SAMA.
    const foreground = await pemicu('2026-02-20');

    expect(startup.totalBungaDipindahkan).toBe(120_000);
    expect(foreground.totalBungaDipindahkan).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(1);
    expect(await saldoSukarela('anggota-A')).toBe(120_000);
  });

  it('8. foreground berkali-kali dalam satu hari tetap satu jurnal', async () => {
    await buatKontrak();
    for (let i = 0; i < 4; i += 1) {
      _resetCatchUpUntukTest();
      await pemicu('2026-02-20');
    }
    expect(await jumlahJurnalTransfer()).toBe(1);
    expect(await saldoSukarela('anggota-A')).toBe(120_000);
  });

  it('9. dua pemicu BERSAMAAN — penjaga in-process menyatukannya', async () => {
    await buatKontrak();
    const [a, b] = await Promise.all([pemicu('2026-02-20'), pemicu('2026-02-20')]);

    // Yang kedua menunggu hasil batch pertama, bukan memulai batch baru.
    expect([a.dilewati, b.dilewati].filter(Boolean)).toHaveLength(1);
    expect(await jumlahJurnalTransfer()).toBe(1);
    expect(await saldoSukarela('anggota-A')).toBe(120_000);
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
  });

  it('10. pemicu setelah crash (state memori hilang) tidak memposting ulang', async () => {
    await buatKontrak();
    await pemicu('2026-02-20');

    // "Crash": penjaga in-process hilang total; keputusan hanya dari DB.
    _resetCatchUpUntukTest();
    const setelahCrash = await pemicu('2026-02-20');

    expect(setelahCrash.totalBungaDipindahkan).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(1);
  });

  it('11. periode CLOSED — dicatat di `gagal`, TIDAK melempar, tidak menjurnal', async () => {
    await buatKontrak();
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);

    // Startup tidak boleh jatuh hanya karena satu kontrak bermasalah.
    const hasil = await pemicu('2026-02-20');

    expect(hasil.totalBungaDipindahkan).toBe(0);
    expect(hasil.gagal.length).toBeGreaterThan(0);
    expect(await jumlahJurnalTransfer()).toBe(0);

    const p = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM accounting_period WHERE id='p2026'`
    );
    expect(p?.status).toBe('CLOSED');
  });

  it('11b. setelah periode dibuka kembali, pemicu berikutnya berhasil', async () => {
    await buatKontrak();
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);
    await pemicu('2026-02-20');

    await testDb.runAsync(`UPDATE accounting_period SET status='OPEN' WHERE id='p2026'`);
    _resetCatchUpUntukTest();
    const ulang = await pemicu('2026-02-20');

    expect(ulang.totalBungaDipindahkan).toBe(120_000);
    expect(await jumlahJurnalTransfer()).toBe(1);
  });

  it('12. jurnal yang sudah ada terdeteksi oleh pemicu berikutnya', async () => {
    await buatKontrak();
    await pemicu('2026-03-20');
    const sebelum = await jumlahJurnalTransfer();

    _resetCatchUpUntukTest();
    await pemicu('2026-03-20');
    expect(await jumlahJurnalTransfer()).toBe(sebelum);
  });

  it('13. kontrak tanpa bunga (0%) tidak menghasilkan jurnal apa pun', async () => {
    await buatKontrak('anggota-A', 0);
    const hasil = await pemicu('2026-04-20');

    expect(hasil.totalBungaDipindahkan).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(0);
  });

  it('14-15. kontrak eligible diproses, kontrak DICAIRKAN dilewati', async () => {
    const a = await buatKontrak('anggota-A');
    const b = await buatKontrak('anggota-B');

    // Kontrak B dicairkan lebih dulu (bunga diselesaikan tunai).
    await pemicu('2026-04-20');
    _resetCatchUpUntukTest();
    await cairkanSimpananBerjangka({
      kontrakId: b,
      tanggal: '2026-04-15',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const jurnalSebelum = await jumlahJurnalTransfer();
    _resetCatchUpUntukTest();
    const hasil = await pemicu('2026-05-20');

    expect(hasil.totalBungaDipindahkan).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(jurnalSebelum);
    expect(a).not.toBe(b);
  });

  it('18. umpan balik hanya ketika ADA transaksi baru', async () => {
    await buatKontrak();
    const pertama = await pemicu('2026-02-20');
    _resetCatchUpUntukTest();
    const kedua = await pemicu('2026-02-20');

    // Pemanggil memakai angka ini untuk memutuskan menampilkan pesan.
    expect(pertama.totalBungaDipindahkan).toBeGreaterThan(0);
    expect(pertama.kontrakBungaDipindahkan).toBe(1);
    expect(kedua.totalBungaDipindahkan).toBe(0);
    expect(kedua.kontrakBungaDipindahkan).toBe(0);
  });
});

// ===========================================================================
// INVARIAN AKUNTANSI SETELAH PEMICU OTOMATIS
// ===========================================================================

describe('§B TRIGGER — invarian akuntansi', () => {
  it('debit = kredit pada setiap jurnal transfer', async () => {
    await buatKontrak();
    await pemicu('2026-04-20');

    const perJurnal = await testDb.getAllAsync<{ d: number; k: number }>(
      `SELECT SUM(je.debit) d, SUM(je.kredit) k
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE j.sumber_transaksi = ? GROUP BY j.id`,
      TRANSAKSI_BUNGA_TRANSFER
    );
    expect(perJurnal).toHaveLength(3);
    for (const p of perJurnal) expect(p.d).toBe(p.k);
  });

  it('2-1710 berkurang, 2-1200 bertambah, beban TIDAK bertambah, pokok tetap', async () => {
    await buatKontrak();
    await pemicu('2026-04-20');

    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    expect(await saldoKredit(ACC.sukarela)).toBe(360_000);
    // Beban hanya dari fase akrual — pemindahan tidak menambahnya.
    expect(await saldoDebit(ACC.bebanBunga)).toBe(360_000);
    expect(await saldoKredit(ACC.berjangka)).toBe(12_000_000);
  });

  it('REGRESI §17 — pencairan tidak membayar ulang bunga yang sudah dipindahkan', async () => {
    const id = await buatKontrak();
    // Dua periode dipindahkan otomatis (240.000).
    await pemicu('2026-03-20');
    _resetCatchUpUntukTest();
    // Pemicu berikutnya menutup periode 3 & menandai jatuh tempo.
    await pemicu('2026-04-20');

    const cair = await cairkanSimpananBerjangka({
      kontrakId: id,
      tanggal: '2026-04-15',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // Seluruh 360.000 sudah berpindah, jadi tunai untuk bunga = 0.
    expect(cair.bunga).toBe(0);
    expect(cair.pokok).toBe(12_000_000);
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    expect(await saldoSukarela('anggota-A')).toBe(360_000);
  });
});

// ===========================================================================
// STATUS UNTUK LAYAR DETAIL ANGGOTA
// ===========================================================================

describe('§B UI — status periode di Detail Anggota', () => {
  it('16-17. status dibaca dari DATABASE dan berubah setelah pemicu', async () => {
    await buatKontrak();

    const sebelum = await getStatusPeriodeBungaAnggota('anggota-A', '2026-02-20');
    expect(sebelum).toHaveLength(3);
    expect(sebelum[0].status).toBe('SIAP_DIPINDAHKAN');
    expect(sebelum[0].journalTransferId).toBeNull();

    await pemicu('2026-02-20');

    const sesudah = await getStatusPeriodeBungaAnggota('anggota-A', '2026-02-20');
    expect(sesudah[0].status).toBe('SUDAH_DIPINDAHKAN');
    expect(sesudah[0].journalTransferId).not.toBeNull();
  });

  it('menampilkan SELURUH periode, termasuk yang belum jatuh tempo', async () => {
    await buatKontrak();
    const baris = await getStatusPeriodeBungaAnggota('anggota-A', '2026-02-20');

    expect(baris.map((b) => b.status)).toEqual([
      'SIAP_DIPINDAHKAN',
      'BELUM_JATUH_TEMPO',
      'BELUM_JATUH_TEMPO',
    ]);
    expect(baris.map((b) => b.tanggalAkhirPeriode)).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ]);
  });

  it('14 (UI) — tiga periode catch-up semuanya terbaca, bukan hanya yang terbaru', async () => {
    await buatKontrak();
    await pemicu('2026-04-20');

    const baris = await getStatusPeriodeBungaAnggota('anggota-A', '2026-04-20');
    expect(baris).toHaveLength(3);
    expect(baris.every((b) => b.status === 'SUDAH_DIPINDAHKAN')).toBe(true);
    expect(new Set(baris.map((b) => b.journalTransferId)).size).toBe(3);
  });

  it('nominal & journal ID yang ditampilkan cocok dengan jurnal sebenarnya', async () => {
    await buatKontrak();
    await pemicu('2026-02-20');

    const baris = await getStatusPeriodeBungaAnggota('anggota-A', '2026-02-20');
    const p = baris[0];
    expect(p.bunga).toBe(120_000);

    const je = await testDb.getFirstAsync<{ debit: number }>(
      `SELECT debit FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      p.journalTransferId as string,
      ACC.utangBunga
    );
    expect(je?.debit).toBe(120_000);

    const st = await testDb.getFirstAsync<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM simpanan_transaksi WHERE journal_id = ?`,
      p.journalTransferId as string
    );
    expect(st?.idempotency_key).toBe(kunciTransferBunga(p.kontrakId, p.nomorPeriode));
  });

  it('membaca status TIDAK memicu posting apa pun', async () => {
    await buatKontrak();
    // Layar boleh dibuka berkali-kali sebelum pemicu berjalan; membaca
    // status adalah operasi baca murni.
    for (let i = 0; i < 3; i += 1) {
      await getStatusPeriodeBungaAnggota('anggota-A', '2026-04-20');
    }
    expect(await jumlahJurnalTransfer()).toBe(0);
  });

  it('kontrak tanpa bunga tidak memunculkan baris periode', async () => {
    await buatKontrak('anggota-B', 0);
    expect(await getStatusPeriodeBungaAnggota('anggota-B', '2026-04-20')).toHaveLength(0);
  });
});

// ===========================================================================
// ARSITEKTUR — satu pintu, tanpa logika akuntansi di pemicu
// ===========================================================================

describe('§B ARSITEKTUR — satu business entry point', () => {
  const fs = require('fs');
  const path = require('path');
  const baca = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8') as string;

  it('ketiga pemicu merutekan ke koordinator yang SAMA', () => {
    for (const berkas of [
      'src/services/StartupTasks.ts',
      'src/services/SimpananBerjangkaBackgroundTask.ts',
      'src/screens/Anggota/AnggotaDetailScreen.tsx',
    ]) {
      expect(baca(berkas)).toMatch(/jalankanCatchUpAkrualSimpananBerjangka\(/);
    }
  });

  it('tidak ada pemicu yang memanggil mesin §B secara langsung', () => {
    // Kalau sebuah pemicu memanggil mesinnya sendiri, ia melewati
    // urutan akrual -> jatuh tempo -> transfer dan bisa memindahkan
    // bunga yang belum diakru.
    for (const berkas of [
      'src/services/StartupTasks.ts',
      'src/services/SimpananBerjangkaBackgroundTask.ts',
      'src/screens/Anggota/AnggotaDetailScreen.tsx',
    ]) {
      expect(baca(berkas)).not.toMatch(/processAccruedTermDepositInterestDue/);
      expect(baca(berkas)).not.toMatch(/prosesTransferBungaKeSukarela/);
    }
  });

  it('layar Detail Anggota tidak membuat jurnal maupun menghitung bunga', () => {
    const layar = baca('src/screens/Anggota/AnggotaDetailScreen.tsx');
    expect(layar).not.toMatch(/createJournal/);
    expect(layar).not.toMatch(/INSERT INTO journal/);
    expect(layar).not.toMatch(/hitungTotalBungaKontrak|buatJadwalBungaSimpananBerjangka/);
    expect(layar).toMatch(/getStatusPeriodeBungaAnggota\(/);
  });

  it('koordinator menjalankan transfer SETELAH akrual & jatuh tempo', () => {
    const src = baca('src/services/SimpananBerjangkaCatchUpService.ts');
    const iAkrual = src.indexOf('prosesAkrualBungaSemuaKontrak(');
    const iMaturity = src.indexOf('prosesJatuhTempoSimpananBerjangka(sampaiTanggal');
    const iTransfer = src.indexOf('processAccruedTermDepositInterestDue(sampaiTanggal');
    expect(iAkrual).toBeGreaterThan(-1);
    expect(iAkrual).toBeLessThan(iMaturity);
    expect(iMaturity).toBeLessThan(iTransfer);
  });

  it('tanggal bisnis berasal dari satu helper aplikasi', () => {
    const src = baca('src/services/SimpananBerjangkaCatchUpService.ts');
    expect(src).toMatch(/getTanggalLokalHariIni\(\)/);
    expect(src).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice/);
  });
});
