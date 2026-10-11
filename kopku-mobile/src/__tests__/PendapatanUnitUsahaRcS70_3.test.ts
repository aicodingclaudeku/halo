import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S70.3 — PEMISAHAN PENGEMBALIAN RAKU DAN PENDAPATAN UNIT USAHA.
 *
 * Bagian DATABASE memakai SQLite sungguhan (skema produksi) dan
 * AccountingEngine asli: Pendapatan Unit Usaha = Dr Kas/Bank, Cr 4-1400.
 *
 * Sisi Pengembalian RAKU (Dr Kas/Bank, Cr 1-1800, 4-1400 tetap 0, kategori
 * PENGEMBALIAN_RAK) SUDAH dikunci di level database oleh
 * RakuPengembalianRcS67_4_2.test.ts dan TIDAK diduplikasi di sini; suite ini
 * menambah kunci struktural bahwa kedua jalur tidak tertukar.
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

import {
  catatPendapatanUnitUsaha,
  getInfoPendapatanUnitUsaha,
  kunciIdentitasPendapatanUnitUsaha,
  listRiwayatPendapatanUnitUsaha,
  PendapatanUnitUsahaDitolakError,
} from '@/services/PendapatanUnitUsahaService';
import {
  koreksiTransaksiPendapatan,
  listAkunPendapatanLainnya,
  tambahTransaksiPendapatan,
} from '@/services/PendapatanLainnyaService';
import { KEBIJAKAN_PENDAPATAN_UNIT_USAHA, AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED } from '@/config/pendapatanKoperasiPolicy';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  rak: 'acc-1-1800',
  unitUsaha: 'acc-4-1400',
  bunga: 'acc-4-1500',
  lain: 'acc-4-2000',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT',
  opts: { isSystem?: boolean; isActive?: boolean; lhu?: string | null } = {}
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, kode, nama, kategori, nb, opts.isActive === false ? 0 : 1, opts.isSystem ? 1 : 0, opts.lhu ?? null, now, now
  );
}

async function setupFixture(opts: { tanpa4_1400?: boolean } = {}): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT', { isSystem: true });
  await seedAccount(db, ACC.bank, '1-1100', 'Bank BCA', 'ASET', 'DEBIT', { isSystem: true });
  await seedAccount(db, ACC.rak, '1-1800', 'Rekening Antar Kantor/Unit (RAKU)', 'ASET', 'DEBIT', { isSystem: true });
  if (!opts.tanpa4_1400) {
    await seedAccount(db, ACC.unitUsaha, '4-1400', 'Pendapatan Unit Usaha', 'PENDAPATAN', 'KREDIT', { lhu: 'PENDAPATAN_USAHA_LAIN' });
  }
  await seedAccount(db, ACC.bunga, '4-1500', 'Pendapatan Bunga', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  await seedAccount(db, ACC.lain, '4-2000', 'Pendapatan Usaha Lain', 'PENDAPATAN', 'KREDIT', { lhu: 'PENDAPATAN_USAHA_LAIN' });
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kas','KAS_UMUM','DEFAULT',?)`, ACC.kas);
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2025',2025,'2025-01-01','2025-12-31','CLOSED')`
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES ('bank-1','BCA','123','Koperasi',0,?,1,?)`,
    ACC.bank, now
  );
  // Poin 5 — master Unit Usaha (satu aktif, satu nonaktif).
  await db.runAsync(
    `INSERT INTO koperasi_unit_usaha (id, nama_usaha, jenis_usaha, alamat, status, created_at, updated_at)
     VALUES ('unit-toko','Toko Koperasi','Perdagangan',NULL,'AKTIF',?,?)`,
    now, now
  );
  await db.runAsync(
    `INSERT INTO koperasi_unit_usaha (id, nama_usaha, jenis_usaha, alamat, status, created_at, updated_at)
     VALUES ('unit-lama','Fotokopi','Jasa',NULL,'NONAKTIF',?,?)`,
    now, now
  );
  return db;
}

async function n(sql: string, ...p: unknown[]): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(sql, ...(p as any[]));
  return Number(r?.n ?? 0);
}

async function saldoKredit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit),0) AS s FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return Number(r?.s ?? 0);
}

async function barisJurnal(journalId: string) {
  return testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
    `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`,
    journalId
  );
}

async function jumlahTulisan() {
  return {
    jurnal: await n(`SELECT COUNT(*) AS n FROM journal`),
    baris: await n(`SELECT COUNT(*) AS n FROM journal_entry`),
    kas: await n(`SELECT COUNT(*) AS n FROM kas_transaksi`),
    bank: await n(`SELECT COUNT(*) AS n FROM bank_transaksi`),
  };
}

const dasar = {
  tanggal: '2026-02-10',
  unitUsahaId: 'unit-toko',
  idempotencyKey: 'kirim-001',
  nominal: 2_500_000,
  jenis: 'KAS' as const,
  createdBy: 'user-1',
};

async function tolakDengan(p: Promise<unknown>): Promise<PendapatanUnitUsahaDitolakError | Error | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as Error;
  }
}

// ============================================================
describe('RC-S70.3 — Pendapatan Unit Usaha (DATABASE)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  it('Case A — Kas: Dr Kas / Cr 4-1400, POSTED, kategori PENDAPATAN_UNIT_USAHA, unit usaha tersimpan', async () => {
    const r = await catatPendapatanUnitUsaha(dasar);
    expect(r.akunKode).toBe('4-1400');
    expect(r.klasifikasiLhu).toBe('PENDAPATAN_USAHA_LAIN');
    expect(await barisJurnal(r.journalId)).toEqual([
      { account_id: ACC.kas, debit: 2_500_000, kredit: 0 },
      { account_id: ACC.unitUsaha, debit: 0, kredit: 2_500_000 },
    ]);
    const j = await testDb.getFirstAsync<{ status: string; sumber_transaksi: string }>(
      `SELECT status, sumber_transaksi FROM journal WHERE id = ?`, r.journalId
    );
    expect(j).toEqual({ status: 'POSTED', sumber_transaksi: 'KAS_PENERIMAAN_LAIN' });
    const kas = await testDb.getFirstAsync<{ kategori: string; akun_lawan_id: string; idempotency_key: string; tipe: string; journal_id: string; unit_usaha_id: string }>(
      `SELECT kategori, akun_lawan_id, idempotency_key, tipe, journal_id, unit_usaha_id FROM kas_transaksi WHERE id = ?`, r.id
    );
    expect(kas).toEqual({
      kategori: 'PENDAPATAN_UNIT_USAHA',
      akun_lawan_id: ACC.unitUsaha,
      idempotency_key: 'PENDAPATAN_UNIT_USAHA|4-1400|kirim-001',
      tipe: 'PENERIMAAN',
      journal_id: r.journalId,
      unit_usaha_id: 'unit-toko',
    });
    expect(r.unitUsahaId).toBe('unit-toko');
    // Histori tahu asal unitnya; tidak ada unit baru yang dibuat.
    const riw = await listRiwayatPendapatanUnitUsaha();
    expect(riw.find((x) => x.id === r.id)?.namaUnitUsaha).toBe('Toko Koperasi');
    expect(await n(`SELECT COUNT(*) AS n FROM koperasi_unit_usaha`)).toBe(2);
    // RAKU tidak tersentuh.
    expect(await n(`SELECT COUNT(*) AS n FROM journal_entry WHERE account_id = ?`, ACC.rak)).toBe(0);
  });

  it('Case B — Bank: Dr Bank / Cr 4-1400, baris bank_transaksi', async () => {
    const r = await catatPendapatanUnitUsaha({ ...dasar, idempotencyKey: 'kirim-B-01', jenis: 'BANK', bankAccountId: 'bank-1' });
    expect(await barisJurnal(r.journalId)).toEqual([
      { account_id: ACC.bank, debit: 2_500_000, kredit: 0 },
      { account_id: ACC.unitUsaha, debit: 0, kredit: 2_500_000 },
    ]);
    const j = await testDb.getFirstAsync<{ sumber_transaksi: string }>(`SELECT sumber_transaksi FROM journal WHERE id = ?`, r.journalId);
    expect(j?.sumber_transaksi).toBe('BANK_PENERIMAAN_LAIN');
    expect(await n(`SELECT COUNT(*) AS n FROM bank_transaksi WHERE id = ? AND kategori = 'PENDAPATAN_UNIT_USAHA' AND unit_usaha_id = 'unit-toko'`, r.id)).toBe(1);
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(0);
  });

  it('Case C — balanced: SUM debit = SUM kredit per jurnal dan untuk seluruh buku', async () => {
    const a = await catatPendapatanUnitUsaha(dasar);
    const b = await catatPendapatanUnitUsaha({ ...dasar, idempotencyKey: 'kirim-002', nominal: 750_000, jenis: 'BANK', bankAccountId: 'bank-1' });
    for (const id of [a.journalId, b.journalId]) {
      const s = await testDb.getFirstAsync<{ d: number; k: number }>(
        `SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry WHERE journal_id = ?`, id
      );
      expect(s?.d).toBe(s?.k);
    }
    const semua = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry`);
    expect(semua?.d).toBe(semua?.k);
    expect(await saldoKredit(ACC.unitUsaha)).toBe(3_250_000);
  });

  it('Case D — bypass akun: field accountId/akunLawanId DITOLAK tanpa tulisan; jalur generik menolak 4-1400', async () => {
    const sebelum = await jumlahTulisan();
    for (const bypass of [{ accountId: ACC.bunga }, { akunLawanId: ACC.bunga }, { accountId: ACC.unitUsaha }]) {
      const e = await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, ...(bypass as object) } as any));
      expect(e).toBeInstanceOf(PendapatanUnitUsahaDitolakError);
      expect((e as PendapatanUnitUsahaDitolakError).kode).toBe('AKUN_TIDAK_BOLEH_DIPILIH');
    }
    // Pintu generik tidak bisa dipakai untuk 4-1400 walau dropdown di-bypass.
    const eGenerik = await tolakDengan(
      tambahTransaksiPendapatan({ tanggal: '2026-02-10', accountId: ACC.unitUsaha, nominal: 1_000, jenis: 'KAS', createdBy: 'user-1' })
    );
    expect(eGenerik?.message).toBe('Akun 4-1400 hanya dapat dicatat melalui menu Pendapatan Unit Usaha.');
    expect(await jumlahTulisan()).toEqual(sebelum);
    expect(await saldoKredit(ACC.bunga)).toBe(0);
  });

  it('Case E — kunci pengiriman sama (retry/ketukan ganda): efek yang sama dikembalikan, tetap satu jurnal', async () => {
    const pertama = await catatPendapatanUnitUsaha(dasar);
    const sesudahPertama = await jumlahTulisan();
    const ulang = await catatPendapatanUnitUsaha(dasar);
    expect(ulang.id).toBe(pertama.id);
    expect(ulang.journalId).toBe(pertama.journalId);
    expect(await jumlahTulisan()).toEqual(sesudahPertama);
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE idempotency_key = ?`, kunciIdentitasPendapatanUnitUsaha('kirim-001'))).toBe(1);
    // Kunci baru = transaksi baru (dua penerimaan sah dengan nominal sama tetap bisa dicatat).
    await catatPendapatanUnitUsaha({ ...dasar, idempotencyKey: 'kirim-baru' });
    expect(await n(`SELECT COUNT(*) AS n FROM journal`)).toBe(2);
  });

  it('Case E2 — dua submit BERSAMAAN dengan dokumen sama: tepat satu jurnal', async () => {
    const hasil = await Promise.allSettled([catatPendapatanUnitUsaha(dasar), catatPendapatanUnitUsaha(dasar)]);
    expect(hasil.some((h) => h.status === 'fulfilled')).toBe(true);
    expect(await n(`SELECT COUNT(*) AS n FROM journal`)).toBe(1);
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(1);
  });

  it('Case E3 — unit usaha wajib, harus ada di master, dan AKTIF; tidak ada unit baru yang dibuat', async () => {
    const sebelum = await jumlahTulisan();
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, unitUsahaId: '  ' }))) as any).kode).toBe('UNIT_USAHA_WAJIB');
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, unitUsahaId: 'tidak-ada' }))) as any).kode).toBe('UNIT_USAHA_TIDAK_DITEMUKAN');
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, unitUsahaId: 'unit-lama' }))) as any).kode).toBe('UNIT_USAHA_NONAKTIF');
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, idempotencyKey: '' }))) as any).kode).toBe('KUNCI_PENGIRIMAN_WAJIB');
    expect(await jumlahTulisan()).toEqual(sebelum);
    expect(await n(`SELECT COUNT(*) AS n FROM koperasi_unit_usaha`)).toBe(2);
  });

  it('Case F — 4-1400 tidak ada / nonaktif / belum diklasifikasikan / klasifikasi LHU lain: DITOLAK, tanpa fallback', async () => {
    const skenario: Array<[string, () => Promise<void>]> = [
      ['nonaktif', async () => { await testDb.runAsync(`UPDATE account SET is_active = 0 WHERE id = ?`, ACC.unitUsaha); }],
      ['belum diklasifikasikan', async () => { await testDb.runAsync(`UPDATE account SET lhu_klasifikasi = NULL WHERE id = ?`, ACC.unitUsaha); }],
      ['klasifikasi lain', async () => { await testDb.runAsync(`UPDATE account SET lhu_klasifikasi = 'PENDAPATAN_LAIN' WHERE id = ?`, ACC.unitUsaha); }],
    ];
    for (const [, ubah] of skenario) {
      testDb = await setupFixture();
      await ubah();
      const sebelum = await jumlahTulisan();
      const e = await tolakDengan(catatPendapatanUnitUsaha(dasar));
      expect((e as PendapatanUnitUsahaDitolakError).kode).toBe('COA_TIDAK_TERSEDIA');
      expect(await jumlahTulisan()).toEqual(sebelum);
    }

    testDb = await setupFixture({ tanpa4_1400: true });
    const info = await getInfoPendapatanUnitUsaha();
    expect(info.akun).toBeNull();
    expect(info.masalah).toBe('COA 4-1400 belum tersedia. Hubungi administrator.');
    const e = await tolakDengan(catatPendapatanUnitUsaha(dasar));
    expect((e as PendapatanUnitUsahaDitolakError).kode).toBe('COA_TIDAK_TERSEDIA');
    // Tidak auto-create COA dan tidak ada jurnal ke akun lain.
    expect(await n(`SELECT COUNT(*) AS n FROM account WHERE kode = '4-1400'`)).toBe(0);
    expect(await n(`SELECT COUNT(*) AS n FROM journal`)).toBe(0);
  });

  it('Case G — periode CLOSED DITOLAK (ClosedPeriodError), atomik tanpa jurnal/baris baru', async () => {
    const sebelum = await jumlahTulisan();
    const e = await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, tanggal: '2025-06-15', idempotencyKey: 'kirim-lama' }));
    expect(e?.name).toBe('ClosedPeriodError');
    expect(await jumlahTulisan()).toEqual(sebelum);
    // Kunci tidak "terbakar" oleh percobaan yang gagal.
    await catatPendapatanUnitUsaha({ ...dasar, idempotencyKey: 'kirim-lama' });
    expect(await n(`SELECT COUNT(*) AS n FROM journal`)).toBe(1);
  });

  it('Case H — reversal existing: jurnal REVERSED, riwayat asli TIDAK dihapus, saldo 4-1400 kembali 0', async () => {
    const r = await catatPendapatanUnitUsaha(dasar);
    const kasSebelum = await n(`SELECT COUNT(*) AS n FROM kas_transaksi`);
    await koreksiTransaksiPendapatan('KAS', r.id, 'user-1', 'salah nominal');

    const j = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, r.journalId);
    expect(j?.status).toBe('REVERSED');
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE id = ?`, r.id)).toBe(1); // tidak di-DELETE
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(kasSebelum + 1); // baris KOREKSI ditambahkan
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE reversal_of_id = ? AND tipe = 'KOREKSI'`, r.id)).toBe(1);
    expect(await saldoKredit(ACC.unitUsaha)).toBe(0);
    const s = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry`);
    expect(s?.d).toBe(s?.k);

    const riw = await listRiwayatPendapatanUnitUsaha();
    expect(riw.find((x) => x.id === r.id)?.status).toBe('DIKOREKSI');
  });

  it('validasi dasar: nominal/tanggal/rekening', async () => {
    const sebelum = await jumlahTulisan();
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, nominal: 0 }))) as any).kode).toBe('NOMINAL_TIDAK_VALID');
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, nominal: 10.5 }))) as any).kode).toBe('NOMINAL_TIDAK_VALID');
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, tanggal: '2026-02-30' }))) as any).kode).toBe('TANGGAL_TIDAK_VALID');
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, tanggal: '2099-01-01' }))) as any).kode).toBe('TANGGAL_MASA_DEPAN');
    expect(((await tolakDengan(catatPendapatanUnitUsaha({ ...dasar, jenis: 'BANK' }))) as any).kode).toBe('REKENING_WAJIB');
    expect(await jumlahTulisan()).toEqual(sebelum);
  });

  it('generik: 4-1400 tidak ada di dropdown Pendapatan Lainnya; akun pendapatan lain tetap ada & tetap dapat diposting', async () => {
    const kode = (await listAkunPendapatanLainnya()).map((o) => o.kode);
    expect(kode).not.toContain('4-1400');
    expect(kode).toEqual(['4-1500', '4-2000']);
    const r = await tambahTransaksiPendapatan({ tanggal: '2026-02-10', accountId: ACC.lain, nominal: 5_000, jenis: 'KAS', createdBy: 'user-1' });
    expect(r.klasifikasiLhu).toBe('PENDAPATAN_USAHA_LAIN');
  });

  it('riwayat leaf hanya memuat kategori PENDAPATAN_UNIT_USAHA di 4-1400', async () => {
    await catatPendapatanUnitUsaha(dasar);
    await tambahTransaksiPendapatan({ tanggal: '2026-02-10', accountId: ACC.lain, nominal: 5_000, jenis: 'KAS', createdBy: 'user-1' });
    const riw = await listRiwayatPendapatanUnitUsaha();
    expect(riw).toHaveLength(1);
    expect(riw[0].akunKode).toBe('4-1400');
  });
});

// ============================================================
describe('RC-S70.3 — kebijakan & COA', () => {
  it('kebijakan menunjuk COA existing 4-1400 dengan LHU PENDAPATAN_USAHA_LAIN', () => {
    expect(KEBIJAKAN_PENDAPATAN_UNIT_USAHA.akunKode).toBe('4-1400');
    expect(KEBIJAKAN_PENDAPATAN_UNIT_USAHA.kategoriTransaksi).toBe('PENDAPATAN_UNIT_USAHA');
    expect(AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED).toEqual(['4-1400']);
    const acc = DEFAULT_ACCOUNTS.find((a) => a.kode === '4-1400');
    expect(acc).toMatchObject({
      nama: 'Pendapatan Unit Usaha',
      kategori: 'PENDAPATAN',
      normalBalance: 'KREDIT',
      isSystem: false,
      lhuKlasifikasi: KEBIJAKAN_PENDAPATAN_UNIT_USAHA.klasifikasiLhuWajib,
    });
  });

  it('tidak ada COA pengganti yang dibuat (4-1410 / 4-1450 tetap tidak ada)', () => {
    for (const k of ['4-1410', '4-1450']) expect(DEFAULT_ACCOUNTS.find((a) => a.kode === k)).toBeUndefined();
  });
});

// ============================================================
describe('RC-S70.3 — menu & navigasi (struktural)', () => {
  const menu = tanpaKomentar(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));
  const hub = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));
  const nav = baca('src/navigation/RootNavigator.tsx');
  const form = tanpaKomentar(baca('src/screens/Transaksi/PendapatanUnitUsahaFormScreen.tsx'));

  it('Pendapatan Koperasi: "Pendapatan Unit Usaha" -> PendapatanUnitUsahaForm; tidak ada "Pendapatan RAKU"', () => {
    expect(menu).toContain("title: 'Pendapatan Unit Usaha'");
    expect(menu).toContain("aksi: { route: 'PendapatanUnitUsahaForm' }");
    expect(menu).toContain("sub: 'Penerimaan pendapatan dari kegiatan unit usaha koperasi — dicatat ke COA 4-1400.'");
    expect(menu).not.toContain('PengembalianRAKForm');
    expect(menu).not.toContain('Pendapatan RAKU');
    expect(menu).not.toContain('Pengembalian RAKU');
  });

  it('urutan seksi Pendapatan Koperasi: Investasi -> Unit Usaha -> Pelepasan Aset -> Lainnya', () => {
    const urut = ["judul: 'Pendapatan Investasi'", "judul: 'Pendapatan Unit Usaha'", "judul: 'Penjualan / Pelepasan Aset'", "judul: 'Pendapatan Lainnya'"];
    let pos = -1;
    for (const u of urut) {
      const i = menu.indexOf(u);
      expect(i).toBeGreaterThan(pos);
      pos = i;
    }
  });

  it('Penerimaan > RAKU > Pengembalian RAKU -> PengembalianRAKForm (copy final)', () => {
    expect(hub).toContain("{ kode: 'RAKU', label: 'RAKU' }");
    const i = hub.indexOf("title: 'Pengembalian RAKU'");
    expect(i).toBeGreaterThan(-1);
    const blok = hub.slice(hub.lastIndexOf('{', i), hub.indexOf('},', i) + 2);
    expect(blok).toContain("grup: 'RAKU'");
    expect(blok).toContain("icon: 'return-down-back-outline'");
    expect(blok).toContain("sub: 'Penerimaan kembali dana RAKU dari unit usaha — mengurangi saldo RAKU, bukan pendapatan.'");
    expect(blok).toContain("nav.navigate('PengembalianRAKForm')");
  });

  it('grup RAKU tampil setelah Pendapatan dan sebelum Kas & Bank', () => {
    const a = hub.indexOf("{ kode: 'PENDAPATAN', label: 'Pendapatan' }");
    const b = hub.indexOf("{ kode: 'RAKU', label: 'RAKU' }");
    const c = hub.indexOf("{ kode: 'KAS_BANK', label: 'Kas & Bank' }");
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('rute: PengembalianRAKForm sekali (judul "Pengembalian RAKU"), PendapatanUnitUsahaForm sekali; tidak ada rute RAKU baru', () => {
    expect((nav.match(/name="PengembalianRAKForm"/g) ?? []).length).toBe(1);
    expect(nav).toContain("options={{ title: 'Pengembalian RAKU' }}");
    expect(nav).not.toContain("title: 'Penerimaan dari Unit Usaha'");
    expect((nav.match(/name="PendapatanUnitUsahaForm"/g) ?? []).length).toBe(1);
    expect(nav).toMatch(/<TransaksiStack\.Screen name="PendapatanUnitUsahaForm" component=\{PendapatanUnitUsahaFormScreen\}/);
    expect(nav).not.toMatch(/name="PengembalianRAKU/);
  });

  it('pemanggil PengembalianRAKForm hanya hub Penerimaan (+ layar RAKU sendiri), bukan menu pendapatan', () => {
    expect(hub).toContain("nav.navigate('PengembalianRAKForm')");
    expect(menu).not.toContain("'PengembalianRAKForm'");
  });

  it('form: tanpa pemilih akun, COA read-only 4-1400, field wajib, tidak menulis DB, kunci submit', () => {
    expect(form).not.toMatch(/AccountPicker|AkunPendapatanSelect|listAkunPendapatanLainnya|akunLawan|accountId:/);
    expect(form).not.toMatch(/getDb|runAsync|INSERT|UPDATE |createJournal/);
    expect(form).toContain('COA Pendapatan');
    expect(form).toContain('Ditetapkan sistem, tidak dapat diubah');
    for (const label of ['Tanggal *', 'Nominal (Rp) *', 'Diterima di Kas/Bank *', 'Keterangan']) {
      expect(form).toContain(label);
    }
    // Poin 5 — Nomor Dokumen dihapus; Unit Usaha dari master lewat picker existing.
    expect(form).not.toContain('Nomor Dokumen');
    expect(form).toContain('<UnitUsahaPicker');
    expect(form).toContain('unitUsahaId: unitUsaha.id');
    expect(form).toContain('if (sedangMengirim.current) return;');
    expect(form).toContain('await catatPendapatanUnitUsaha(');
  });
});

// ============================================================
describe('RC-S70.3 — audit akuntansi statis: kedua jalur tidak tertukar', () => {
  const raku = tanpaKomentar(baca('src/services/RAKUService.ts'));
  const unit = tanpaKomentar(baca('src/services/PendapatanUnitUsahaService.ts'));

  it('Pengembalian RAKU: Cr 1-1800 lewat mapping RAK, tidak menyentuh 4-1400 / PENDAPATAN_UNIT_USAHA', () => {
    expect(raku).toContain("resolveAccountId(db, 'RAK', 'DEBIT_ASET')");
    expect(raku).not.toMatch(/4-1400|PENDAPATAN_UNIT_USAHA|KEBIJAKAN_PENDAPATAN_UNIT_USAHA|'PENDAPATAN'/);
    expect(raku).toContain("KATEGORI_PENGEMBALIAN_RAK = 'PENGEMBALIAN_RAK'");
  });

  it('Pendapatan Unit Usaha: akun dari kebijakan 4-1400, tidak menyentuh RAK / 1-1800 / PENGEMBALIAN_RAK', () => {
    expect(unit).toContain('KEBIJAKAN_PENDAPATAN_UNIT_USAHA');
    expect(unit).not.toMatch(/1-1800|'RAK'|PENGEMBALIAN_RAK|RAKUService|jalurKhusus/);
    // Tidak ada kode akun literal di service (akun hidup di config).
    expect(unit).not.toMatch(/'4-1\d00'/);
  });

  it('satu jalur jurnal: service dedicated mendelegasikan ke catatPemasukan, tidak menulis DB / membuat jurnal sendiri', () => {
    expect(unit).toContain('await catatPemasukan(');
    expect(unit).not.toMatch(/INSERT |UPDATE |DELETE |createJournal|reverseJournal|runAsync/);
  });
});
