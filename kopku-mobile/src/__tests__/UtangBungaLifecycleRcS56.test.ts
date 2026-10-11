import { createTestDb, TestDb } from './testDb';
import { readFileSync } from 'fs';
import { join } from 'path';

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
  getStatusLifecyclePeriode,
  getJejakAkrualBungaUtang,
  getMonitorAkrualBungaUtang,
  KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG,
  _resetGerbangAkrualUntukTest,
} from '@/services/UtangBungaAccrualService';
import {
  terimaUtang,
  bayarUtang,
  penyesuaianManualBungaUtang,
  lengkapiBasisBungaUtang,
  getKontrolGapUtangBunga,
  getGapAkrualBungaUtang,
  replayBungaUtang,
} from '@/services/UtangService';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { getKebijakanAkuntansiNarasi } from '@/services/AccountingPolicyService';

/**
 * RC-S56 — ACCOUNTING LIFECYCLE HARDENING.
 *
 * Fokus: apa yang terjadi SETELAH akrual pertama — reversal, penggantian,
 * penyesuaian manual, perubahan kontrak, pelunasan di tengah periode.
 *
 * Seluruh asersi membuktikan ANGKA AKHIR di buku besar, bukan sekadar jumlah
 * baris. Satu akrual yang dibalik lalu diganti harus berakhir pada beban yang
 * benar, bukan pada "ada 2 baris jadi pasti benar".
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
};

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

beforeEach(async () => {
  _resetGerbangAkrualUntukTest();
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(testDb, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);

  for (const th of [2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
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
     VALUES ('j-awal','JRN-SEED','2025-12-31','p2025','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,500000000,0,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,500000000,1)`,
    ACC.utangBank
  );
});

afterEach(() => testDb.closeSync());

async function buatUtang(opts: {
  persen?: number;
  basis?: 'TAHUNAN' | 'BULANAN';
  jenisBunga?: 'FLAT' | 'EFEKTIF';
  tanggal?: string;
  pokok?: number;
} = {}): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: 'Bank ABC',
    jenisPemberi: 'BANK',
    pokokPinjaman: opts.pokok ?? 120_000_000,
    persenBunga: opts.persen ?? 12,
    jenisBunga: opts.jenisBunga ?? 'FLAT',
    basisBunga: opts.basis ?? 'TAHUNAN',
    tanggal: opts.tanggal ?? '2026-01-01',
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return r.id;
}

async function saldo(accountId: string, sisi: 'debit' | 'kredit'): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.${sisi} - je.${sisi === 'debit' ? 'kredit' : 'debit'}),0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return r?.s ?? 0;
}

async function jurnalAkrualAktif(utangId: string): Promise<number> {
  const r = await testDb.getAllAsync(
    `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND status='POSTED' AND reversal_of_id IS NULL`,
    utangId
  );
  return r.length;
}

/** Balikkan jurnal akrual periode tertentu. */
async function reversalAkrual(utangId: string, periode: string, tanggalReversal?: string): Promise<string> {
  const j = await testDb.getFirstAsync<{ id: string }>(
    `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND status='POSTED'
       AND substr(tanggal,1,7)=? AND reversal_of_id IS NULL`,
    utangId, periode
  );
  const hasil = await reverseJournal(testDb as any, j!.id, 'user-1', 'Koreksi kontrak');
  if (tanggalReversal) {
    // reverseJournal memberi tanggal HARI INI; digeser untuk menguji lintas periode.
    await testDb.runAsync(`UPDATE journal SET tanggal = ? WHERE id = ?`, tanggalReversal, hasil.journalId);
  }
  return hasil.journalId;
}

// ============================================================================

describe('§1/§2 REVERSAL -> LIFECYCLE', () => {
  it('A. auto accrual -> reverse -> jalankan engine lagi: TIDAK memposting ulang, exception eksplisit', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);

    await reversalAkrual(id, '2026-01');
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(0);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);

    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    expect(h.jumlahJurnalBaru).toBe(0);
    expect(h.exception.map((e) => e.kode)).toContain('AKRUAL_DIREVERSAL');
    // ANGKA AKHIR, bukan jumlah baris: beban & liabilitas tetap nol.
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(0);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
  });

  it('B. reversal tercermin di gap calculation: akrual bersih periode kembali 0', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    expect((await getGapAkrualBungaUtang(id, '2026-01', 1_200_000)).akrualBersih).toBe(1_200_000);

    await reversalAkrual(id, '2026-01');
    const gap = await getGapAkrualBungaUtang(id, '2026-01', 1_200_000);
    expect(gap.akrualBersih).toBe(0);
    expect(gap.sisaGap).toBe(1_200_000);
  });

  it('C. lifecycle dibedakan: BELUM_DIPROSES -> AKTIF -> DIREVERSAL (bukan boolean row-exists)', async () => {
    const id = await buatUtang();
    expect((await getStatusLifecyclePeriode(testDb as any, id, '2026-01')).status).toBe('BELUM_DIPROSES');

    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    const aktif = await getStatusLifecyclePeriode(testDb as any, id, '2026-01');
    expect(aktif.status).toBe('AKTIF');
    expect(aktif.akrualAktif).toBe(1_200_000);

    await reversalAkrual(id, '2026-01');
    const dibalik = await getStatusLifecyclePeriode(testDb as any, id, '2026-01');
    expect(dibalik.status).toBe('DIREVERSAL');
    expect(dibalik.akrualAktif).toBe(0);
    // Barisnya TETAP SATU — identitas periode, bukan duplikat demi reversal.
    const rows = await testDb.getAllAsync(`SELECT id FROM utang_bunga_akrual WHERE utang_id=?`, id);
    expect(rows).toHaveLength(1);
  });

  it('D. auto -> reverse -> penyesuaian manual: beban & liabilitas berakhir tepat 1.300.000', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await reversalAkrual(id, '2026-01');

    await penyesuaianManualBungaUtang({
      utangId: id,
      tanggal: '2026-01-31',
      nominalTarget: 1_300_000,
      alasan: 'Kontrak ternyata 13% per tahun',
      createdBy: 'user-1',
    });

    // 1.200.000 - 1.200.000 + 1.300.000 = 1.300.000
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_300_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(1_300_000);
  });

  it('E/§8. reversal di BULAN BERBEDA tetap diatribusikan ke periode asal', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    const revId = await reversalAkrual(id, '2026-01', '2026-02-10');

    const rev = await testDb.getFirstAsync<{ tanggal: string; reversal_of_id: string }>(
      `SELECT tanggal, reversal_of_id FROM journal WHERE id=?`, revId
    );
    // Jurnal pembalik memakai tanggal reversal...
    expect(rev!.tanggal).toBe('2026-02-10');
    // ...tetapi relasinya lewat reversal_of_id, bukan tanggal.
    expect(rev!.reversal_of_id).toBeTruthy();

    // Januari: akrual bersih kembali 0 (pembalik diatribusikan ke periode ASAL).
    expect((await getGapAkrualBungaUtang(id, '2026-01', 0)).akrualBersih).toBe(0);
    // Februari TIDAK dianggap memuat akrual Januari.
    expect((await getGapAkrualBungaUtang(id, '2026-02', 0)).akrualBersih).toBe(0);

    // Februari tetap bisa diakru normal, dan tidak ada beban ganda.
    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });
    expect(h.totalDibukukan).toBe(1_200_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('F/§12. Januari CLOSED setelah akrual: reversal tidak membuat jurnal bertanggal Januari', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    // Tutup 2026; reversal harus jatuh di periode yang masih terbuka.
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);

    const j = await testDb.getFirstAsync<{ id: string }>(
      `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND status='POSTED'`, id
    );
    // Periode tertutup -> reversal ditolak; jurnal posted TIDAK dimodifikasi.
    await expect(reverseJournal(testDb as any, j!.id, 'user-1', 'Koreksi')).rejects.toThrow(/ditutup|CLOSED/i);
    const tetap = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id=?`, j!.id);
    expect(tetap!.status).toBe('POSTED');
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });

  it('G. rantai reversal tidak menghasilkan double expense', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await reversalAkrual(id, '2026-01');
    await penyesuaianManualBungaUtang({
      utangId: id, tanggal: '2026-01-31', nominalTarget: 1_300_000,
      alasan: 'Koreksi pertama', createdBy: 'user-1',
    });
    await reversalAkrual(id, '2026-01');
    await penyesuaianManualBungaUtang({
      utangId: id, tanggal: '2026-01-31', nominalTarget: 1_100_000,
      alasan: 'Koreksi kedua', createdBy: 'user-1',
    });

    // 1.200 -1.200 +1.300 -1.300 +1.100 (ribu) = 1.100.000
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_100_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(1_100_000);
    expect((await getKontrolGapUtangBunga(testDb as any)).status).toBe('BALANCED');
  });
});

describe('§9/§10 MANUAL ADJUSTMENT LIFECYCLE', () => {
  it('§9. auto 1.200.000 lalu koreksi kontraktual 1.300.000: delta 100.000, bukan jurnal kedua penuh', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });

    const hasil = await penyesuaianManualBungaUtang({
      utangId: id, tanggal: '2026-01-31', nominalTarget: 1_300_000,
      alasan: 'Koreksi kontraktual', createdBy: 'user-1',
    });

    expect(hasil.dibukukanSekarang).toBe(100_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_300_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(1_300_000);
    // BUKAN 2.500.000.
    expect(await saldo(ACC.bebanBunga, 'debit')).not.toBe(2_500_000);
  });

  it('penyesuaian manual wajib menyertakan alasan', async () => {
    const id = await buatUtang();
    await expect(
      penyesuaianManualBungaUtang({
        utangId: id, tanggal: '2026-01-31', nominalTarget: 1_000_000, alasan: '  ', createdBy: 'user-1',
      })
    ).rejects.toThrow(/Alasan/i);
  });

  it('alasan penyesuaian ikut terbaca di deskripsi jurnal (bukan hanya tabel audit)', async () => {
    const id = await buatUtang();
    await penyesuaianManualBungaUtang({
      utangId: id, tanggal: '2026-01-31', nominalTarget: 1_000_000,
      alasan: 'Denda keterlambatan', createdBy: 'user-1',
    });
    const j = await testDb.getFirstAsync<{ deskripsi: string }>(
      `SELECT deskripsi FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=?`, id
    );
    expect(j!.deskripsi).toMatch(/Penyesuaian manual: Denda keterlambatan/);
  });
});

describe('§11 IDEMPOTENSI & CONCURRENCY SETELAH REVERSAL', () => {
  it('engine dijalankan berulang setelah reversal: tidak ada replacement ganda', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await reversalAkrual(id, '2026-01');

    for (let i = 0; i < 3; i++) {
      await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    }
    await Promise.all([
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
    ]);
    await Promise.allSettled([
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
      prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' }),
    ]);

    expect(await jurnalAkrualAktif(id)).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(0);
    const rows = await testDb.getAllAsync(`SELECT id FROM utang_bunga_akrual WHERE utang_id=?`, id);
    expect(rows).toHaveLength(1);
  });

  it('setelah reversal + adjustment, pemicu berulang tidak menambah apa pun', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await reversalAkrual(id, '2026-01');
    await penyesuaianManualBungaUtang({
      utangId: id, tanggal: '2026-01-31', nominalTarget: 1_300_000,
      alasan: 'Koreksi', createdBy: 'user-1',
    });
    for (let i = 0; i < 5; i++) {
      await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    }
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_300_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(1_300_000);
  });
});

describe('§3 CONTRACT MUTATION GUARD', () => {
  it('basis bunga ditolak diubah setelah akrual terbukukan (guard di service, bukan UI)', async () => {
    const id = await buatUtang({ basis: 'TAHUNAN' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await expect(
      lengkapiBasisBungaUtang({ utangId: id, basisBunga: 'BULANAN', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah memiliki akrual/i);
  });

  it('guard tetap berlaku walau akrualnya sudah direversal (histori tetap ada)', async () => {
    const id = await buatUtang({ basis: 'TAHUNAN' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await reversalAkrual(id, '2026-01');
    await expect(
      lengkapiBasisBungaUtang({ utangId: id, basisBunga: 'BULANAN', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah memiliki akrual/i);
  });

  it('AUDIT STATIS: tidak ada jalur mutasi kontrak bunga selain yang terjaga', () => {
    /*
     * Audit RC-S56 §3: satu-satunya pernyataan `UPDATE utang SET` di seluruh
     * source produksi adalah (a) penandaan status LUNAS oleh bayarUtang, dan
     * (b) pengisian basis_bunga yang dijaga assertKontrakBungaBolehDiubah.
     *
     * `persen_bunga`, `jenis_bunga`, `pokok_pinjaman`, dan `tanggal` TIDAK
     * punya jalur mutasi sama sekali — tidak ada layanan edit utang di
     * aplikasi ini. Test ini mengunci temuan itu: menambah jalur edit baru
     * akan menjatuhkannya, sehingga penambahnya terpaksa memutuskan secara
     * sadar bagaimana kontrak yang sudah menjadi dasar posting boleh berubah.
     */
    const src = readFileSync(join(__dirname, '..', 'services', 'UtangService.ts'), 'utf8');
    const mutasi = src.match(/UPDATE utang SET[^`]*/g) ?? [];
    expect(mutasi).toHaveLength(2);
    expect(mutasi.some((m) => /status = 'LUNAS'/.test(m))).toBe(true);
    expect(mutasi.some((m) => /basis_bunga = \?/.test(m))).toBe(true);
    for (const kolom of ['persen_bunga =', 'jenis_bunga =', 'pokok_pinjaman =']) {
      expect(src).not.toContain(`UPDATE utang SET ${kolom}`);
    }
  });
});

describe('§5/§6 KEBIJAKAN WHOLE_MONTH', () => {
  it('kebijakan diformalkan sebagai konstanta & terbit di narasi kebijakan akuntansi', () => {
    expect(KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG).toBe('WHOLE_MONTH');
    const item = getKebijakanAkuntansiNarasi().find((k) => k.area === 'bunga_utang');
    expect(item).toBeDefined();
    expect(item!.narasi).toMatch(/BULAN PENUH|WHOLE_MONTH/);
    expect(item!.narasi).toMatch(/tidak ada prorata harian/i);
  });

  it('§6. pelunasan penuh di tengah bulan: bulan berjalan TETAP diakru penuh (bukan prorata)', async () => {
    const id = await buatUtang({ tanggal: '2026-02-01', jenisBunga: 'EFEKTIF' });
    await bayarUtang({
      utangId: id, tanggal: '2026-02-15', pokok: 120_000_000, bunga: 0,
      sumberDana: 'KAS', createdBy: 'user-1',
    });

    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });
    // Februari penuh: 1% x 120jt. Bukan 15/28 hari.
    expect(h.totalDibukukan).toBe(1_200_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);

    // Maret sudah lunas sebelum periode -> tidak diakru.
    const h2 = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-31' });
    expect(h2.totalDibukukan).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(1_200_000);
  });
});

describe('§7 PARTIAL PRINCIPAL PAYMENT', () => {
  it('EFEKTIF: Feb pakai outstanding awal Feb, Mar pakai 100jt — tanpa pengurangan ganda', async () => {
    const id = await buatUtang({ tanggal: '2026-02-01', jenisBunga: 'EFEKTIF' });
    await bayarUtang({
      utangId: id, tanggal: '2026-02-20', pokok: 20_000_000, bunga: 0,
      sumberDana: 'KAS', createdBy: 'user-1',
    });

    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-31' });
    // Feb: 1% x 120jt = 1.200.000 · Mar: 1% x 100jt = 1.000.000
    expect(h.totalDibukukan).toBe(2_200_000);

    const jejak = await getJejakAkrualBungaUtang(id);
    expect(jejak.find((j) => j.periode === '2026-02')!.dasarPerhitungan).toBe(120_000_000);
    expect(jejak.find((j) => j.periode === '2026-03')!.dasarPerhitungan).toBe(100_000_000);

    // April: outstanding tetap 100jt — pembayaran Feb tidak dikurangkan lagi.
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-04-30' });
    const jejak2 = await getJejakAkrualBungaUtang(id);
    expect(jejak2.find((j) => j.periode === '2026-04')!.dasarPerhitungan).toBe(100_000_000);
  });

  it('FLAT: angsuran pokok tidak mengubah dasar — tetap pokok kontraktual', async () => {
    const id = await buatUtang({ tanggal: '2026-02-01', jenisBunga: 'FLAT' });
    await bayarUtang({
      utangId: id, tanggal: '2026-02-20', pokok: 20_000_000, bunga: 0,
      sumberDana: 'KAS', createdBy: 'user-1',
    });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-31' });

    const jejak = await getJejakAkrualBungaUtang(id);
    expect(jejak.find((j) => j.periode === '2026-02')!.dasarPerhitungan).toBe(120_000_000);
    expect(jejak.find((j) => j.periode === '2026-03')!.dasarPerhitungan).toBe(120_000_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(2_400_000);
  });
});

describe('§4/§13 SNAPSHOT KONTRAK & RANTAI AUDIT', () => {
  it('snapshot kontrak tersimpan per akrual dan tetap terbaca setelah reversal', async () => {
    const id = await buatUtang({ persen: 12, basis: 'TAHUNAN', jenisBunga: 'FLAT' });
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    await reversalAkrual(id, '2026-01');

    const [j] = await getJejakAkrualBungaUtang(id);
    // Bukti "angka ini dihitung berdasarkan kontrak seperti apa".
    expect(j.basisBunga).toBe('TAHUNAN');
    expect(j.jenisBunga).toBe('FLAT');
    expect(j.persenBunga).toBe(12);
    expect(j.dasarPerhitungan).toBe(120_000_000);
    expect(j.nominalTarget).toBe(1_200_000);
    expect(j.nominalDibukukan).toBe(1_200_000);
    expect(j.mode).toBe('AUTO');
    expect(j.createdBy).toBe('user-1');
    expect(j.createdAt).toBeTruthy();
  });

  it('rantai audit menghubungkan jurnal asal <-> jurnal pembalik lewat reversed_by_id', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    const revId = await reversalAkrual(id, '2026-01', '2026-02-10');

    const [j] = await getJejakAkrualBungaUtang(id);
    expect(j.journalId).toBeTruthy();
    expect(j.statusJurnal).toBe('REVERSED');
    expect(j.reversalJournalId).toBe(revId);
    expect(j.reversalNomorJurnal).toBeTruthy();
    expect(j.reversalTanggal).toBe('2026-02-10');
    expect(j.akrualAktif).toBe(0);
    expect(j.statusLifecycle).toBe('DIREVERSAL');
  });

  it('akrual yang masih aktif tidak dilaporkan punya reversal', async () => {
    const id = await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-01-31' });
    const [j] = await getJejakAkrualBungaUtang(id);
    expect(j.statusJurnal).toBe('POSTED');
    expect(j.reversalJournalId).toBeNull();
    expect(j.statusLifecycle).toBe('AKTIF');
    expect(j.akrualAktif).toBe(1_200_000);
  });
});

describe('§15/§16 TRIGGER & PERFORMA', () => {
  it('tidak ada timer/polling di service akrual', () => {
    const src = readFileSync(join(__dirname, '..', 'services', 'UtangBungaAccrualService.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  });

  it('monitor memakai agregasi terbatas: jumlah query tidak tumbuh 3x per utang', async () => {
    for (let i = 0; i < 6; i++) {
      await buatUtang({ tanggal: '2026-01-01' });
    }
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-02-28' });

    // Hitung query yang benar-benar menyentuh subledger akrual.
    const asli = testDb.getAllAsync.bind(testDb);
    let hitung = 0;
    (testDb as any).getAllAsync = async (sql: string, ...p: any[]) => {
      if (/utang_bunga_akrual/.test(sql)) hitung++;
      return asli(sql, ...p);
    };
    try {
      const m = await getMonitorAkrualBungaUtang('2026-02-28');
      expect(m.baris).toHaveLength(6);
    } finally {
      (testDb as any).getAllAsync = asli;
    }
    // Dua query agregat untuk SELURUH utang, bukan 2 per utang (yang berarti 12).
    expect(hitung).toBe(2);
  });
});
