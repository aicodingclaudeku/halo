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
  terimaUtang,
  bayarUtang,
  akruiBungaUtang,
  getGapAkrualBungaUtang,
  getKontrolGapUtangBunga,
  getDiagnostikUtangBungaHistoris,
  replayBungaUtang,
  bayarKewajibanCoa,
  PESAN_UTANG_BUNGA_LEWAT_BAYAR_UTANG,
} from '@/services/UtangService';
import { prosesAkrualBungaUtangOtomatis } from '@/services/UtangBungaAccrualService';
import { reverseJournal, createJournal } from '@/accounting/AccountingEngine';
import { catatPengeluaran } from '@/services/KasBankService';
import { getDb } from '@/database/db';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * §Z FINAL — GAP CONTROL BUNGA UTANG & DIAGNOSTIK 2-1700 WARISAN.
 *
 * Seluruh suite berjalan di atas SQLite sungguhan dengan skema produksi
 * dan jurnal dari AccountingEngine asli. Tidak ada mock akuntansi.
 *
 * Yang dibuktikan di sini bukan "kode terlihat benar", melainkan angka
 * yang benar-benar duduk di `journal_entry` setelah rangkaian akrual,
 * pembayaran, dan reversal.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
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
  const now = new Date().toISOString();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_PIHAK_LAIN', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);

  for (const th of [2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`,
      th,
      `${th}-01-01`,
      `${th}-12-31`
    );
  }
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
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
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return r?.s ?? 0;
}

async function saldoDebit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit) - SUM(je.kredit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return r?.s ?? 0;
}

async function jumlahJurnalAkrual(): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'UTANG_BUNGA'`
  );
  return r?.n ?? 0;
}

async function buatUtangUji(): Promise<string> {
  const hasil = await terimaUtang({
    namaPemberi: 'Bank Mitra',
    jenisPemberi: 'BANK',
    pokokPinjaman: 100_000_000,
    persenBunga: 12, basisBunga: 'BULANAN',
    jenisBunga: 'FLAT',
    tanggal: '2026-01-05',
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return hasil.id;
}

/**
 * RC-S54 TAHAP 10 — ITEM #13 — KONTROL GAP UTANG BUNGA
 * =========================================================================
 * SQLite nyata, AccountingEngine asli, service produksi. Jurnal dan saldo
 * dibaca dari database; setiap angka akun digabung dengan sumber event
 * (jurnal akrual per utang, utang_pembayaran, replay subledger).
 */

beforeEach(async () => {
  testDb = await seedFixture();
});

afterEach(() => {
  testDb.closeSync();
});

async function jurnalAkrual(utangId: string) {
  return testDb.getAllAsync<{ id: string; tanggal: string; status: string }>(
    `SELECT id, tanggal, status FROM journal WHERE sumber_transaksi = 'UTANG_BUNGA' AND sumber_id = ? ORDER BY created_at`, utangId
  );
}

async function entri(journalId: string) {
  return testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
    `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY account_id`, journalId
  );
}

async function snapshot() {
  const n = async (t: string) => (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`))?.n ?? 0;
  return { journal: await n('journal'), entry: await n('journal_entry'), bayar: await n('utang_pembayaran'), utang: await n('utang') };
}

/** Empat lapis: event akrual (jurnal) -> subledger (replay) -> GL -> settlement (utang_pembayaran). */
async function cekEmpatLapis(utangId: string, harapan: { beban: number; outstanding: number; dibayar: number }) {
  const db = await getDb();
  const replay = await replayBungaUtang(db, utangId);
  expect(replay.totalAkrual + replay.dibebankanSaatBayar).toBe(harapan.beban);
  expect(replay.outstanding).toBe(harapan.outstanding);
  expect(replay.totalDibayar).toBe(harapan.dibayar);
  expect(await saldoKredit(ACC.utangBunga)).toBe(harapan.outstanding);
  expect(await saldoDebit(ACC.bebanBunga)).toBe(harapan.beban);
  const bayarRows = await testDb.getFirstAsync<{ s: number }>(`SELECT COALESCE(SUM(bunga),0) s FROM utang_pembayaran WHERE utang_id = ?`, utangId);
  expect(bayarRows?.s).toBe(harapan.dibayar);
  const kontrol = await getKontrolGapUtangBunga(db);
  expect(kontrol.temuan).toEqual([]);
  expect(kontrol).toMatchObject({ status: 'BALANCED', expected: harapan.outstanding, actual: harapan.outstanding, gap: 0 });
}

// ===========================================================================
// 1–4 AKRUAL & IDEMPOTENSI
// ===========================================================================

describe('AKRUAL & IDEMPOTENSI', () => {
  it('1. akrual satu periode: satu jurnal Dr Beban Bunga / Cr Utang Bunga (mapping existing)', async () => {
    const id = await buatUtangUji();
    const h = await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    expect(h.dibukukanSekarang).toBe(300_000);
    const j = await jurnalAkrual(id);
    expect(j).toHaveLength(1);
    expect(await entri(j[0].id)).toEqual([
      { account_id: ACC.utangBunga, debit: 0, kredit: 300_000 },
      { account_id: ACC.bebanBunga, debit: 300_000, kredit: 0 },
    ]);
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 300_000, dibayar: 0 });
  });

  it('2. akrual ulang periode yang sama (retry, tanggal lain di bulan sama): tetap 1 beban, 1 payable, 1 jurnal', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    for (const tgl of ['2026-09-30', '2026-09-15', '2026-09-01']) {
      const r = await akruiBungaUtang({ utangId: id, tanggal: tgl, nominal: 300_000, createdBy: 'user-1' });
      expect(r.dibukukanSekarang).toBe(0);
      expect(r.journalId).toBeNull();
      expect(r.sudahDiakui).toBe(300_000);
    }
    expect(await jurnalAkrual(id)).toHaveLength(1);
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 300_000, dibayar: 0 });
  });

  /*
   * RC-S55 — INVARIAN INI SENGAJA DIBALIK, BUKAN SEKADAR DIPERBARUI.
   *
   * Versi RC-S54 membuktikan bahwa TIDAK ADA pemicu otomatis akrual bunga
   * utang: satu-satunya pemanggil `akruiBungaUtang()` adalah form manual.
   * Itu benar untuk desain lama, dan justru merupakan cacatnya — beban
   * bunga hanya masuk buku kalau ada yang mengetiknya.
   *
   * Desainnya sekarang berubah (mesin otomatis menjadi jalur utama), jadi
   * mempertahankan asersi lama berarti mengunci bug. Yang menggantikannya
   * BUKAN daftar pemanggil yang diperlebar — itu hanya memindahkan angka
   * harapan — melainkan pembuktian bahwa eksekusi otomatis BENAR-BENAR
   * TERJADI: satu pemicu, jurnal nyata, saldo nyata, tanpa satu pun input
   * nominal dari manusia.
   */
  it('3–4. mesin otomatis mengakru tanpa input manual, dan pemicunya terpasang di StartupTasks', async () => {
    const id = await buatUtangUji();
    await testDb.runAsync(`UPDATE utang SET basis_bunga = 'BULANAN' WHERE id = ?`, id);

    const hasil = await prosesAkrualBungaUtangOtomatis({
      createdBy: 'user-1',
      tanggalSekarang: '2026-09-30',
    });

    // Tidak ada nominal yang diketik di mana pun pada test ini.
    expect(hasil.jumlahJurnalBaru).toBeGreaterThan(0);
    expect(await jurnalAkrual(id)).not.toHaveLength(0);

    // Dan pemicunya memang terpasang pada koordinator tugas startup —
    // bukan hanya tersedia sebagai fungsi yang tidak pernah dipanggil.
    const startup = readFileSync(join(__dirname, '..', 'services', 'StartupTasks.ts'), 'utf8');
    expect(startup).toMatch(/jalankanAkrualBungaUtangJikaPerlu\s*\(/);
  });

  it('3–4c. jalur manual tetap ada sebagai EXCEPTION, bukan jalur normal', () => {
    const root = join(__dirname, '..', '..');
    const berkas: string[] = [];
    const telusur = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) telusur(p);
        else if (/\.(ts|tsx)$/.test(f)) berkas.push(p);
      }
    };
    telusur(join(root, 'src'));
    telusur(join(root, 'app'));
    const pemanggil = berkas
      .filter((p) => !p.includes('__tests__'))
      .filter((p) => {
        const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        return /\bakruiBungaUtang\s*\(/.test(src);
      })
      .map((p) => p.slice(root.length + 1))
      .sort();
    // Layar akrual TIDAK lagi memanggilnya: ia sekarang layar monitoring.
    // Yang tersisa hanya UtangService (definisi + pembungkus penyesuaian
    // manual terkontrol `penyesuaianManualBungaUtang`).
    expect(pemanggil).toEqual(['src/services/UtangService.ts']);
  });

  it('3–4b. pemicu berulang (simulasi startup ×2, background ×2, catch-up) atas target yang sama: 1 jurnal', async () => {
    const id = await buatUtangUji();
    const pemicu = ['startup', 'startup-ulang', 'background', 'background-ulang', 'catch-up'];
    const hasil = [];
    for (const _p of pemicu) hasil.push(await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' }));
    expect(hasil.map((h) => h.dibukukanSekarang)).toEqual([300_000, 0, 0, 0, 0]);
    expect(await jumlahJurnalAkrual()).toBe(1);
  });

  it('15. dua akrual bersamaan (Promise.allSettled): transaksi kedua ditolak SQLite, 1 jurnal', async () => {
    const id = await buatUtangUji();
    const r = await Promise.allSettled([
      akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' }),
      akruiBungaUtang({ utangId: id, tanggal: '2026-09-10', nominal: 300_000, createdBy: 'user-1' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await jurnalAkrual(id)).toHaveLength(1);
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 300_000, dibayar: 0 });
  });

  it('14. gagal -> rollback tanpa sisa parsial -> retry menghasilkan tepat satu event', async () => {
    const id = await buatUtangUji();
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);
    const sebelum = await snapshot();
    await expect(akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' })).rejects.toThrow(/ditutup|CLOSED/i);
    expect(await snapshot()).toEqual(sebelum);

    await testDb.runAsync(`UPDATE accounting_period SET status='OPEN' WHERE id='p2026'`);
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    expect(await jurnalAkrual(id)).toHaveLength(1);
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 300_000, dibayar: 0 });
  });
});

// ===========================================================================
// 5–8 PEMBAYARAN
// ===========================================================================

describe('PEMBAYARAN', () => {
  it('5. partial: utang 300.000, bayar 100.000 -> outstanding 200.000, beban tetap 300.000', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    const b = await bayarUtang({ utangId: id, tanggal: '2026-10-05', pokok: 0, bunga: 100_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const e = await entri(b.journalId);
    expect(e.find((x) => x.account_id === ACC.utangBunga)).toEqual({ account_id: ACC.utangBunga, debit: 100_000, kredit: 0 });
    expect(e.find((x) => x.account_id === ACC.bebanBunga)).toBeUndefined();
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 200_000, dibayar: 100_000 });
  });

  it('6. full: bayar 300.000 -> outstanding 0, tanpa beban kedua', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    await bayarUtang({ utangId: id, tanggal: '2026-10-05', pokok: 0, bunga: 300_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 0, dibayar: 300_000 });
  });

  it('7. overpayment 350.000 atas 300.000: perilaku resmi — 300.000 ke Utang Bunga, 50.000 beban periode bayar; tidak negatif; kontrol BALANCED', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    const b = await bayarUtang({ utangId: id, tanggal: '2026-10-05', pokok: 0, bunga: 350_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const e = await entri(b.journalId);
    expect(e.find((x) => x.account_id === ACC.utangBunga)?.debit).toBe(300_000);
    expect(e.find((x) => x.account_id === ACC.bebanBunga)?.debit).toBe(50_000);
    await cekEmpatLapis(id, { beban: 350_000, outstanding: 0, dibayar: 350_000 });
    // Diagnostik historis existing tidak lagi melaporkan selisih palsu (Fix E).
    expect((await getDiagnostikUtangBungaHistoris()).adaSelisih).toBe(false);
  });

  it('7b. siklus berikutnya setelah overpayment: tidak ada beban kedua (Fix D)', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    await bayarUtang({ utangId: id, tanggal: '2026-10-02', pokok: 0, bunga: 350_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-11-30', nominal: 100_000, createdBy: 'user-1' });
    const b = await bayarUtang({ utangId: id, tanggal: '2026-12-02', pokok: 0, bunga: 100_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const e = await entri(b.journalId);
    expect(e.find((x) => x.account_id === ACC.utangBunga)?.debit).toBe(100_000);
    expect(e.find((x) => x.account_id === ACC.bebanBunga)).toBeUndefined();
    await cekEmpatLapis(id, { beban: 450_000, outstanding: 0, dibayar: 450_000 });
  });

  it('8. multi-period P1 100k, P2 120k, P3 80k; bayar 100k + 50k -> outstanding 150k, beban 300k', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-07-31', nominal: 100_000, createdBy: 'user-1' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-08-31', nominal: 120_000, createdBy: 'user-1' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 80_000, createdBy: 'user-1' });
    await bayarUtang({ utangId: id, tanggal: '2026-10-05', pokok: 0, bunga: 100_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await bayarUtang({ utangId: id, tanggal: '2026-10-20', pokok: 0, bunga: 50_000, sumberDana: 'KAS', createdBy: 'user-1' });
    // retry seluruh periode setelah pembayaran: tidak ada beban baru
    for (const [t, n] of [['2026-07-31', 100_000], ['2026-08-31', 120_000], ['2026-09-30', 80_000]] as const) {
      expect((await akruiBungaUtang({ utangId: id, tanggal: t, nominal: n, createdBy: 'user-1' })).dibukukanSekarang).toBe(0);
    }
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 150_000, dibayar: 150_000 });
  });

  it('bunga dibayar tanpa akrual lalu diakru di periode yang sama: beban tetap satu kali (Fix B)', async () => {
    const id = await buatUtangUji();
    await bayarUtang({ utangId: id, tanggal: '2026-09-25', pokok: 0, bunga: 300_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const ak = await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    expect(ak).toMatchObject({ dibukukanSekarang: 0, journalId: null, sudahDiakui: 300_000 });
    const gap = await getGapAkrualBungaUtang(id, '2026-09', 300_000);
    expect(gap).toMatchObject({ akrualBersih: 0, dibebankanSaatBayar: 300_000, sisaGap: 0 });
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 0, dibayar: 300_000 });
  });

  it('Utang Bunga tidak bisa dilunasi lewat Bayar Kewajiban langsung (Fix C)', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    const sebelum = await snapshot();
    await expect(
      bayarKewajibanCoa({ accountId: ACC.utangBunga, tanggal: '2026-10-01', nominal: 300_000, sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(PESAN_UTANG_BUNGA_LEWAT_BAYAR_UTANG);
    expect(await snapshot()).toEqual(sebelum);
    await cekEmpatLapis(id, { beban: 300_000, outstanding: 300_000, dibayar: 0 });
  });
});

// ===========================================================================
// 9–13 GAP CONTROL, DUPLIKAT, TRACEABILITY
// ===========================================================================

describe('GAP CONTROL', () => {
  it('9. balanced: expected = actual = 300.000 -> gap 0, BALANCED', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    const k = await getKontrolGapUtangBunga();
    expect(k).toEqual({ status: 'BALANCED', expected: 300_000, actual: 300_000, gap: 0, temuan: [] });
  });

  it('10. gap: expected 300.000, actual 200.000 (pelunasan kas langsung ke akun Utang Bunga) -> GAP 100.000 dengan sumber', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    const kas = await catatPengeluaran({ jenis: 'KAS', nominal: 100_000, tanggal: '2026-10-03', akunLawanId: ACC.utangBunga, kategori: 'Kewajiban', keterangan: 'bayar bunga langsung', createdBy: 'user-1' });
    const sebelum = await snapshot();
    const k = await getKontrolGapUtangBunga();
    expect(await snapshot()).toEqual(sebelum); // read-only
    expect(k.status).toBe('GAP');
    expect(k.expected).toBe(300_000);
    expect(k.actual).toBe(200_000);
    expect(k.gap).toBe(-100_000); // konvensi existing: recorded - expected
    const t = k.temuan.find((x) => x.kode === 'JURNAL_TANPA_SUBLEDGER')!;
    expect(t).toMatchObject({ expected: 0, recorded: -100_000, difference: -100_000 });
    expect(t.jurnal.map((j) => j.journalId)).toEqual([kas.journalId]);
    expect(t.jurnal[0]).toMatchObject({ tanggal: '2026-10-03', nilai: -100_000 });
    expect(await jumlahJurnalAkrual()).toBe(1); // tidak ada jurnal koreksi otomatis
  });

  it('11a. jurnal akrual ganda warisan (dua jurnal identik) -> DUPLICATE_INTEREST_EXPENSE', async () => {
    const id = await buatUtangUji();
    const a = await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    // Simulasi data warisan (sebelum gap control) lewat AccountingEngine, bukan SQL langsung.
    const db = await getDb();
    let kembarId = '';
    await testDb.withTransactionAsync(async () => {
      const r = await createJournal(db, {
        tanggal: '2026-09-30', sumberTransaksi: 'UTANG_BUNGA', sumberId: id, nomorReferensi: 'LEGACY-1', deskripsi: 'legacy dobel', createdBy: 'user-1',
        lines: [{ accountId: ACC.bebanBunga, debit: 300_000, kredit: 0 }, { accountId: ACC.utangBunga, debit: 0, kredit: 300_000 }],
      });
      kembarId = r.journalId;
    });
    const k = await getKontrolGapUtangBunga();
    const dup = k.temuan.find((x) => x.kode === 'DUPLICATE_INTEREST_EXPENSE')!;
    expect(dup).toMatchObject({ utangId: id, periode: '2026-09', expected: 300_000, recorded: 600_000, difference: 300_000 });
    expect(dup.jurnal.map((j) => j.journalId).sort()).toEqual([a.journalId, kembarId].sort());
    expect(k.status).toBe('GAP');
  });

  it('11b. warisan: bunga dibebankan saat bayar DAN diakru periode sama -> DUPLICATE_INTEREST_EXPENSE per periode', async () => {
    const id = await buatUtangUji();
    const bayar = await bayarUtang({ utangId: id, tanggal: '2026-09-25', pokok: 0, bunga: 300_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const db = await getDb();
    let akrualId = '';
    await testDb.withTransactionAsync(async () => {
      const r = await createJournal(db, {
        tanggal: '2026-09-30', sumberTransaksi: 'UTANG_BUNGA', sumberId: id, nomorReferensi: 'LEGACY-2', deskripsi: 'akrual sebelum Fix B', createdBy: 'user-1',
        lines: [{ accountId: ACC.bebanBunga, debit: 300_000, kredit: 0 }, { accountId: ACC.utangBunga, debit: 0, kredit: 300_000 }],
      });
      akrualId = r.journalId;
    });
    const k = await getKontrolGapUtangBunga();
    const dup = k.temuan.find((x) => x.kode === 'DUPLICATE_INTEREST_EXPENSE')!;
    expect(dup).toMatchObject({ periode: '2026-09', expected: 300_000, recorded: 600_000, difference: 300_000 });
    expect(dup.jurnal.map((j) => j.journalId).sort()).toEqual([akrualId, bayar.journalId].sort());
  });

  it('12. traceability & UTANG_BUNGA_HISTORICAL_GAP: pembayaran warisan yang men-debit beban', async () => {
    const id = await buatUtangUji();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-08-31', nominal: 300_000, createdBy: 'user-1' });
    // Pembayaran bunga pola sebelum RC-S53: Dr Beban / Cr Kas + baris utang_pembayaran.
    const db = await getDb();
    let legacyId = '';
    await testDb.withTransactionAsync(async () => {
      const r = await createJournal(db, {
        tanggal: '2026-09-10', sumberTransaksi: 'UTANG_BANK', nomorReferensi: 'KWJ-LEGACY', deskripsi: 'Pelunasan warisan', createdBy: 'user-1',
        lines: [{ accountId: ACC.bebanBunga, debit: 100_000, kredit: 0 }, { accountId: ACC.kas, debit: 0, kredit: 100_000 }],
      });
      legacyId = r.journalId;
      await testDb.runAsync(
        `INSERT INTO utang_pembayaran (id, utang_id, tanggal, pokok, bunga, sumber_dana, nomor_transaksi, journal_id, created_by, created_at)
         VALUES ('bayar-legacy', ?, '2026-09-10', 0, 100000, 'KAS', 'KWJ-LEGACY', ?, 'user-1', ?)`,
        id, legacyId, new Date(Date.now() + 1000).toISOString()
      );
    });
    const k = await getKontrolGapUtangBunga();
    const t = k.temuan.find((x) => x.kode === 'UTANG_BUNGA_HISTORICAL_GAP')!;
    expect(t).toMatchObject({ utangId: id, nomorUtang: expect.any(String), namaPemberi: 'Bank Mitra', expected: 200_000, recorded: 300_000, difference: 100_000 });
    expect(t.jurnal).toEqual([expect.objectContaining({ journalId: legacyId, nomorJurnal: expect.any(String), tanggal: '2026-09-10', sumberTransaksi: 'UTANG_BANK' })]);
    expect(k).toMatchObject({ status: 'GAP', expected: 200_000, actual: 300_000, gap: 100_000 });
    // tidak ada koreksi otomatis
    expect(await saldoKredit(ACC.utangBunga)).toBe(300_000);
  });

  it('13. lintas lapis setelah reversal di BULAN BERIKUTNYA: gap periode asal terbuka kembali (Fix A)', async () => {
    const id = await buatUtangUji();
    const a = await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    jest.useFakeTimers({ now: new Date('2026-10-05T10:00:00'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    try {
      await testDb.withTransactionAsync(async () => {
        await reverseJournal(await getDb(), a.journalId as string, 'user-1', 'koreksi');
      });
    } finally {
      jest.useRealTimers();
    }
    const rev = await testDb.getFirstAsync<{ tanggal: string }>(`SELECT tanggal FROM journal WHERE reversal_of_id = ?`, a.journalId);
    expect(rev?.tanggal).toBe('2026-10-05');
    expect(await getGapAkrualBungaUtang(id, '2026-09', 250_000)).toMatchObject({ akrualBersih: 0, sisaGap: 250_000 });
    expect(await getGapAkrualBungaUtang(id, '2026-10', 300_000)).toMatchObject({ akrualBersih: 0, sisaGap: 300_000 });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 250_000, createdBy: 'user-1' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-10-31', nominal: 300_000, createdBy: 'user-1' });
    await cekEmpatLapis(id, { beban: 550_000, outstanding: 550_000, dibayar: 0 });
  });
});
