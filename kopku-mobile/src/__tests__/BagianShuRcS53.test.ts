import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb, sebagaiSQLiteDatabase } from './testDb';

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
  catatBagianShuInvestasi,
  catatPenerimaanBagianShu,
  listBagianShuInvestasiDenganDb,
} from '@/services/BagianShuService';

/**
 * RC-S53 — BAGIAN SHU DARI INVESTASI (KEPUTUSAN 04-A & 05).
 *
 * Yang diuji di sini bukan "fungsinya jalan", melainkan sifat-sifat yang
 * membuat akuntansinya benar: pendapatan diakui SEKALI, penerimaan kas
 * hanya menutup piutang, bukti wajib ada, identity idempotensi ditegakkan
 * database, dan periode tertutup ditolak.
 *
 * Bagian terakhir menguji batas IMBAL HASIL TETAP (aktif sejak RC-S67.6 via
 * pendapatan investasi, bukan register ini) — imbal
 * hasil tetap, posting nilai wajar, dan RAKU PENGUATAN — supaya batas
 * yang masih nonaktif (AKRUAL imbal hasil tetap, nilai wajar, PENGUATAN)
 * benar-benar terkunci, bukan sekadar dinyatakan di laporan.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

const AKUN = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  piutang: 'acc-piutang-inv',
  pendapatan: 'acc-pendapatan-inv',
  modal: 'acc-modal',
};

const INVESTASI_ID = 'inv-koperasi-mitra';

async function seedAkun(id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kat, nb, now, now
  );
}

async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

async function seedFixture(opts: { periode2026?: 'OPEN' | 'CLOSED' } = {}): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAkun(AKUN.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAkun(AKUN.bank, '1-1100', 'Bank BRI', 'ASET', 'DEBIT');
  await seedAkun(AKUN.piutang, '1-1220', 'Piutang Pendapatan Investasi', 'ASET', 'DEBIT');
  await seedAkun(AKUN.pendapatan, '4-1300', 'Pendapatan Hasil Investasi', 'PENDAPATAN', 'KREDIT');
  await seedAkun(AKUN.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');

  await seedMapping('KAS_UMUM', 'DEFAULT', AKUN.kas);
  await seedMapping('BAGIAN_SHU_INVESTASI', 'DEBIT_PIUTANG', AKUN.piutang);
  await seedMapping('BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN', AKUN.pendapatan);
  await seedMapping('BAGIAN_SHU_PENERIMAAN', 'KREDIT_PIUTANG', AKUN.piutang);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026', 2026, '2026-01-01', '2026-12-31', ?)`,
    opts.periode2026 ?? 'OPEN'
  );

  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );

  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                            sumber_dana, status, created_by, created_at, updated_at)
     VALUES (?, 'INV-2026-001', 'KOPERASI_LAIN', 'Koperasi Mitra Sejahtera', 50000000, '2026-01-10',
             'KAS', 'AKTIF', 'user-1', ?, ?)`,
    INVESTASI_ID, now, now
  );
}

const INPUT_SAH = {
  investasiId: INVESTASI_ID,
  tanggalHak: '2026-03-20',
  jumlah: 5_000_000,
  jenisDokumen: 'Berita Acara RAT',
  nomorDokumen: 'BA-RAT-2026-014',
  tanggalDokumen: '2026-03-20',
  createdBy: 'user-1',
};

async function saldoAkun(accountId: string): Promise<{ debit: number; kredit: number }> {
  const row = await testDb.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k
       FROM journal_entry WHERE account_id = ?`,
    accountId
  );
  return { debit: row?.d ?? 0, kredit: row?.k ?? 0 };
}

// ===========================================================================
// PENGAKUAN HAK
// ===========================================================================

describe('Bagian SHU — pengakuan hak (KEPUTUSAN 05)', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it('NORMAL — peristiwa hak berbukti menghasilkan Dr piutang, Cr pendapatan', async () => {
    const hasil = await catatBagianShuInvestasi(INPUT_SAH);
    expect(hasil.id).toBeTruthy();
    expect(hasil.journalId).toBeTruthy();

    const entri = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`,
      hasil.journalId
    );
    expect(entri).toHaveLength(2);
    expect(entri[0].account_id).toBe(AKUN.piutang);
    expect(entri[0].debit).toBe(5_000_000);
    expect(entri[1].account_id).toBe(AKUN.pendapatan);
    expect(entri[1].kredit).toBe(5_000_000);
  });

  it('JURNAL BALANCE — total debit = total kredit', async () => {
    await catatBagianShuInvestasi(INPUT_SAH);
    const row = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k FROM journal_entry`
    );
    expect(row!.d).toBe(row!.k);
  });

  it('BUKTI WAJIB — tanpa nomor dokumen ditolak, dan tidak ada jurnal terbentuk', async () => {
    await expect(
      catatBagianShuInvestasi({ ...INPUT_SAH, nomorDokumen: '   ' })
    ).rejects.toThrow(/Nomor dokumen bukti hak wajib diisi/);
    const jml = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(jml!.n).toBe(0);
  });

  it('BUKTI WAJIB — tanpa jenis dokumen ditolak', async () => {
    await expect(
      catatBagianShuInvestasi({ ...INPUT_SAH, jenisDokumen: '' })
    ).rejects.toThrow(/Jenis dokumen bukti hak wajib diisi/);
  });

  it('NOL / NEGATIF — jumlah nol dan negatif sama-sama ditolak', async () => {
    await expect(catatBagianShuInvestasi({ ...INPUT_SAH, jumlah: 0 })).rejects.toThrow(/lebih dari 0/);
    await expect(catatBagianShuInvestasi({ ...INPUT_SAH, jumlah: -1 })).rejects.toThrow(/lebih dari 0/);
    const jml = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(jml!.n).toBe(0);
  });

  it('DUPLICATE — identity yang sama ditolak; satu peristiwa hak = satu akrual', async () => {
    await catatBagianShuInvestasi(INPUT_SAH);
    await expect(catatBagianShuInvestasi(INPUT_SAH)).rejects.toThrow(/sudah pernah dicatat/);

    const register = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM investasi_bagian_shu`
    );
    expect(register!.n).toBe(1);
    const jurnal = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(jurnal!.n).toBe(1);
  });

  it('RETRY — tiga percobaan berturut-turut tetap menyisakan satu akrual', async () => {
    await catatBagianShuInvestasi(INPUT_SAH);
    for (let i = 0; i < 2; i += 1) {
      await expect(catatBagianShuInvestasi(INPUT_SAH)).rejects.toThrow();
    }
    const pendapatan = await saldoAkun(AKUN.pendapatan);
    expect(pendapatan.kredit).toBe(5_000_000);
  });

  it('CONCURRENCY — dua submit paralel identik hanya menghasilkan satu akrual', async () => {
    const hasil = await Promise.allSettled([
      catatBagianShuInvestasi(INPUT_SAH),
      catatBagianShuInvestasi(INPUT_SAH),
    ]);
    const sukses = hasil.filter((h) => h.status === 'fulfilled');
    expect(sukses).toHaveLength(1);
    const register = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM investasi_bagian_shu`
    );
    expect(register!.n).toBe(1);
  });

  it('DOKUMEN BERBEDA — peristiwa hak berikutnya tetap dapat dicatat', async () => {
    await catatBagianShuInvestasi(INPUT_SAH);
    await catatBagianShuInvestasi({
      ...INPUT_SAH,
      tanggalHak: '2026-09-15',
      nomorDokumen: 'BA-RAT-2026-031',
      jumlah: 2_000_000,
    });
    const rows = await listBagianShuInvestasiDenganDb(sebagaiSQLiteDatabase(testDb), { investasiId: INVESTASI_ID });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((t, r) => t + r.jumlah, 0)).toBe(7_000_000);
  });

  it('ROLLBACK — investasi tidak aktif ditolak dan tidak menyisakan jejak', async () => {
    await testDb.runAsync(`UPDATE investasi SET status = 'DIBATALKAN' WHERE id = ?`, INVESTASI_ID);
    await expect(catatBagianShuInvestasi(INPUT_SAH)).rejects.toThrow(/tidak aktif/);
    const jurnal = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    const register = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM investasi_bagian_shu`
    );
    expect(jurnal!.n).toBe(0);
    expect(register!.n).toBe(0);
  });

  it('INVESTASI TIDAK DIKENAL — ditolak, nol jurnal', async () => {
    await expect(
      catatBagianShuInvestasi({ ...INPUT_SAH, investasiId: 'inv-tidak-ada' })
    ).rejects.toThrow(/tidak ditemukan/);
    const jurnal = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(jurnal!.n).toBe(0);
  });
});

describe('Bagian SHU — periode tertutup', () => {
  it('CLOSED — pengakuan ditolak dan tidak ada jurnal maupun baris register', async () => {
    await seedFixture({ periode2026: 'CLOSED' });
    await expect(catatBagianShuInvestasi(INPUT_SAH)).rejects.toThrow();
    const jurnal = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    const register = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM investasi_bagian_shu`
    );
    expect(jurnal!.n).toBe(0);
    expect(register!.n).toBe(0);
  });

  it('OPEN — pengakuan pada periode terbuka lolos', async () => {
    await seedFixture({ periode2026: 'OPEN' });
    const hasil = await catatBagianShuInvestasi(INPUT_SAH);
    expect(hasil.journalId).toBeTruthy();
    const jurnal = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(jurnal!.n).toBe(1);
  });
});

// ===========================================================================
// PENERIMAAN KAS
// ===========================================================================

describe('Bagian SHU — penerimaan kas menutup piutang, bukan pendapatan kedua', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it('SETTLEMENT — Dr kas, Cr piutang; akun pendapatan TIDAK tersentuh', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    const terima = await catatPenerimaanBagianShu({
      bagianShuId: akrual.id,
      tanggal: '2026-04-05',
      jumlah: 5_000_000,
      sumberDana: 'KAS',
      nomorReferensi: 'TRM-001',
      createdBy: 'user-1',
    });

    const entri = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      terima.journalId
    );
    expect(entri).toHaveLength(2);
    expect(entri.map((e) => e.account_id).sort()).toEqual([AKUN.kas, AKUN.piutang].sort());
    expect(entri.some((e) => e.account_id === AKUN.pendapatan)).toBe(false);
  });

  it('NO DOUBLE REVENUE — pendapatan tetap 5.000.000 setelah kas diterima penuh', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await catatPenerimaanBagianShu({
      bagianShuId: akrual.id,
      tanggal: '2026-04-05',
      jumlah: 5_000_000,
      sumberDana: 'KAS',
      nomorReferensi: 'TRM-001',
      createdBy: 'user-1',
    });
    const pendapatan = await saldoAkun(AKUN.pendapatan);
    expect(pendapatan.kredit).toBe(5_000_000);
    expect(pendapatan.debit).toBe(0);
  });

  it('PIUTANG NOL SETELAH LUNAS — subledger cocok dengan ledger', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await catatPenerimaanBagianShu({
      bagianShuId: akrual.id,
      tanggal: '2026-04-05',
      jumlah: 5_000_000,
      sumberDana: 'KAS',
      nomorReferensi: 'TRM-001',
      createdBy: 'user-1',
    });

    const piutang = await saldoAkun(AKUN.piutang);
    const ledger = piutang.debit - piutang.kredit;

    const rows = await listBagianShuInvestasiDenganDb(sebagaiSQLiteDatabase(testDb), {});
    const subledger = rows.reduce((t, r) => t + r.sisaPiutang, 0);

    expect(ledger).toBe(0);
    expect(subledger).toBe(0);
    expect(subledger).toBe(ledger);
    expect(rows[0].status).toBe('LUNAS');
  });

  it('PENERIMAAN BERTAHAP — subledger tetap sama dengan ledger di tengah jalan', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await catatPenerimaanBagianShu({
      bagianShuId: akrual.id,
      tanggal: '2026-04-05',
      jumlah: 2_000_000,
      sumberDana: 'KAS',
      nomorReferensi: 'TRM-001',
      createdBy: 'user-1',
    });

    const piutang = await saldoAkun(AKUN.piutang);
    const rows = await listBagianShuInvestasiDenganDb(sebagaiSQLiteDatabase(testDb), {});
    expect(piutang.debit - piutang.kredit).toBe(3_000_000);
    expect(rows[0].sisaPiutang).toBe(3_000_000);
    expect(rows[0].status).toBe('DIAKUI');
  });

  it('DUPLICATE SETTLEMENT — referensi yang sama ditolak, piutang tidak tergerus dua kali', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    const args = {
      bagianShuId: akrual.id,
      tanggal: '2026-04-05',
      jumlah: 2_000_000,
      sumberDana: 'KAS' as const,
      nomorReferensi: 'TRM-001',
      createdBy: 'user-1',
    };
    await catatPenerimaanBagianShu(args);
    await expect(catatPenerimaanBagianShu(args)).rejects.toThrow(/sudah pernah dicatat/);
    const piutang = await saldoAkun(AKUN.piutang);
    expect(piutang.debit - piutang.kredit).toBe(3_000_000);
  });

  it('OVERPAYMENT — penerimaan melebihi sisa ditolak, nol jurnal tambahan', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await expect(
      catatPenerimaanBagianShu({
        bagianShuId: akrual.id,
        tanggal: '2026-04-05',
        jumlah: 6_000_000,
        sumberDana: 'KAS',
        nomorReferensi: 'TRM-002',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/melebihi sisa piutang/);
    const jurnal = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(jurnal!.n).toBe(1);
  });

  it('CLOSED PERIOD — penerimaan pada periode tertutup ditolak dan piutang tidak berubah', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    await expect(
      catatPenerimaanBagianShu({
        bagianShuId: akrual.id,
        tanggal: '2026-04-05',
        jumlah: 1_000_000,
        sumberDana: 'KAS',
        nomorReferensi: 'TRM-003',
        createdBy: 'user-1',
      })
    ).rejects.toThrow();
    const piutang = await saldoAkun(AKUN.piutang);
    expect(piutang.debit - piutang.kredit).toBe(5_000_000);
  });
});

// ===========================================================================
// REKONSILIASI & INTEGRITAS
// ===========================================================================

describe('Bagian SHU — rekonsiliasi & integritas data', () => {
  beforeEach(async () => {
    await seedFixture();
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await catatPenerimaanBagianShu({
      bagianShuId: akrual.id,
      tanggal: '2026-04-05',
      jumlah: 3_000_000,
      sumberDana: 'KAS',
      nomorReferensi: 'TRM-001',
      createdBy: 'user-1',
    });
  });

  it('setiap jurnal balance satu per satu', async () => {
    const rows = await testDb.getAllAsync<{ journal_id: string; d: number; k: number }>(
      `SELECT journal_id, SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry GROUP BY journal_id`
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.d).toBe(r.k);
  });

  it('ASET = LIABILITAS + EKUITAS + PENDAPATAN - BEBAN', async () => {
    const saldo = async (kategori: string) => {
      const r = await testDb.getFirstAsync<{ d: number; k: number }>(
        `SELECT COALESCE(SUM(je.debit),0) AS d, COALESCE(SUM(je.kredit),0) AS k
           FROM journal_entry je JOIN account a ON a.id = je.account_id
          WHERE a.kategori = ?`,
        kategori
      );
      return { d: r?.d ?? 0, k: r?.k ?? 0 };
    };
    const aset = await saldo('ASET');
    const liabilitas = await saldo('LIABILITAS');
    const ekuitas = await saldo('EKUITAS');
    const pendapatan = await saldo('PENDAPATAN');
    const beban = await saldo('BEBAN');

    const kiri = aset.d - aset.k;
    const kanan =
      (liabilitas.k - liabilitas.d) +
      (ekuitas.k - ekuitas.d) +
      (pendapatan.k - pendapatan.d) -
      (beban.d - beban.k);
    expect(kiri).toBe(kanan);
  });

  it('foreign_key_check kosong & foreign key aktif', async () => {
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk!.foreign_keys).toBe(1);
  });

  it('nol duplikat: register, penerimaan, jurnal, dan nomor jurnal', async () => {
    const dupRegister = await testDb.getAllAsync(
      `SELECT investasi_id FROM investasi_bagian_shu
        GROUP BY investasi_id, tanggal_hak, jenis_hasil, nomor_dokumen HAVING COUNT(*) > 1`
    );
    const dupPenerimaan = await testDb.getAllAsync(
      `SELECT id FROM investasi_bagian_shu_penerimaan
        GROUP BY bagian_shu_id, nomor_referensi HAVING COUNT(*) > 1`
    );
    const dupNomor = await testDb.getAllAsync(
      `SELECT nomor_jurnal FROM journal GROUP BY nomor_jurnal HAVING COUNT(*) > 1`
    );
    expect(dupRegister).toHaveLength(0);
    expect(dupPenerimaan).toHaveLength(0);
    expect(dupNomor).toHaveLength(0);
  });

  it('HISTORICAL SAFETY — jurnal akrual tidak diubah maupun dihapus oleh penerimaan', async () => {
    const akrual = await testDb.getFirstAsync<{ journal_id: string }>(
      `SELECT journal_id FROM investasi_bagian_shu LIMIT 1`
    );
    const jurnal = await testDb.getFirstAsync<{ status: string; nomor_jurnal: string }>(
      `SELECT status, nomor_jurnal FROM journal WHERE id = ?`,
      akrual!.journal_id
    );
    expect(jurnal!.status).toBe('POSTED');
    const entri = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      akrual!.journal_id
    );
    expect(entri).toHaveLength(2);
    expect(entri.reduce((t, e) => t + e.debit, 0)).toBe(5_000_000);
  });

  it('REPORT — piutang muncul sebagai ASET dan pendapatan sebagai PENDAPATAN', async () => {
    const piutang = await testDb.getFirstAsync<{ kategori: string; normal_balance: string }>(
      `SELECT kategori, normal_balance FROM account WHERE kode = '1-1220'`
    );
    const pendapatan = await testDb.getFirstAsync<{ kategori: string; normal_balance: string }>(
      `SELECT kategori, normal_balance FROM account WHERE kode = '4-1300'`
    );
    expect(piutang!.kategori).toBe('ASET');
    expect(piutang!.normal_balance).toBe('DEBIT');
    expect(pendapatan!.kategori).toBe('PENDAPATAN');
    expect(pendapatan!.normal_balance).toBe('KREDIT');
  });
});

// ===========================================================================
// IMBAL HASIL TETAP — AKTIF SEBAGAI PENERIMAAN KAS (RC-S67.6 / RC-S67.6.1)
// ===========================================================================
// Sebelumnya menguji `JenisHasilDisabledError`. Audit RC-S67.6.1: error itu
// tidak pernah dilempar jalur produksi mana pun (kode mati) dan sudah
// dihapus. Yang dijaga sekarang: imbal hasil tetap AKTIF lewat jalur
// pendapatan investasi (Dr Kas/Bank / Cr 4-1700), TIDAK lewat register
// Bagian SHU; semantik BAGIAN_SHU tidak berubah. Perilaku posting positif
// (jurnal, idempotensi, reversal, periode) diuji di ImbalHasilTetapRcS67_6.

describe('Imbal Hasil Tetap aktif tanpa mengubah semantik Bagian SHU', () => {
  it('IMBAL HASIL TETAP — aktif via pendapatan investasi (4-1700), bukan jenis hasil register Bagian SHU', () => {
    const fs = require('fs');
    const berkas = fs.readdirSync(join(__dirname, '..', 'services')) as string[];
    // Tidak ada service kedua: jalurnya PendapatanLainnyaService yang sudah ada.
    expect(berkas).not.toContain('ImbalHasilTetapService.ts');
    expect(berkas).not.toContain('InvestasiReturnService.ts');

    const { KEBIJAKAN_PENDAPATAN_INVESTASI } = require('@/config/pendapatanKoperasiPolicy');
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.IMBAL_HASIL_TETAP).toMatchObject({
      jenisInvestasi: 'KOPERASI_LAIN',
      akunKode: '4-1700',
      wajibDokumen: true,
    });

    // Jalur penolakan lama sudah tidak ada di produksi.
    const svc = baca('src/services/BagianShuService.ts').replace(/\/\/.*$/gm, '');
    expect(svc).not.toMatch(/class JenisHasilDisabledError|HASIL_INVESTASI_DISABLED\s*[:=]/);

    // CHECK di skema hanya menerima satu jenis hasil.
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(/jenis_hasil TEXT NOT NULL DEFAULT 'BAGIAN_SHU' CHECK \(jenis_hasil IN \('BAGIAN_SHU'\)\)/);
  });

  it('IMBAL HASIL TETAP — nol fungsi akrual & nol parameter kontrak di register', () => {
    const svc = baca('src/services/BagianShuService.ts');
    // Tidak ada satu pun fungsi akrual imbal hasil tetap yang diekspor.
    expect(svc).not.toMatch(/export async function .*ImbalHasil/i);
    expect(svc).not.toMatch(/export async function .*FixedReturn/i);
    // Register bagian SHU tidak menyimpan parameter kontrak apa pun —
    // itulah sebabnya akrual imbal hasil tetap memang tidak mungkin.
    const schema = baca('src/database/schema.ts');
    const awal = schema.indexOf('CREATE TABLE IF NOT EXISTS investasi_bagian_shu (');
    const blok = schema.slice(awal, schema.indexOf(');', awal));
    for (const kolom of ['rate', 'tenor', 'maturity', 'jatuh_tempo', 'frekuensi']) {
      expect(blok.toLowerCase()).not.toContain(kolom);
    }
  });

  // DIPERBARUI RC-S88 (keputusan pengguna): model nilai wajar/revaluasi SAK EP
  // diaktifkan — posting lewat gerbang `postingNilaiWajar` (status DIPOSTING).
  // Invarian bagian SHU yang dijaga di sini tidak berubah: nilai wajar tidak
  // menyentuh register/akun bagian SHU, dan status 'POSTED' tetap tidak ada.
  it('FAIR VALUE — posting lewat gerbang DIPOSTING (RC-S88), tidak menyentuh bagian SHU, nol status POSTED', () => {
    const svc = baca('src/services/PenyesuaianNilaiWajarService.ts');
    expect(svc).toMatch(/export async function postingNilaiWajar\(/);
    expect(svc).not.toMatch(/investasi_bagian_shu|BAGIAN_SHU/);
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(/status TEXT NOT NULL DEFAULT 'DRAFT' CHECK \(status IN \('DRAFT','DIPOSTING','DIBATALKAN'\)\)/);
    const awal = schema.indexOf('CREATE TABLE IF NOT EXISTS penyesuaian_nilai_wajar');
    expect(schema.slice(awal, schema.indexOf(');', awal))).not.toContain("'POSTED'");
  });

  it('RAKU PENGUATAN — CHECK tidak diperluas; SETORAN_DANA historis tetap terbaca', () => {
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(
      /jenis_rak TEXT NOT NULL CHECK \(jenis_rak IN \('PENYALURAN_DANA','SETORAN_DANA'\)\)/
    );
    expect(schema).not.toContain("'PENGUATAN'");
    const svc = baca('src/services/RAKService.ts');
    expect(svc).toMatch(/export type JenisRAK = 'PENYALURAN_DANA' \| 'SETORAN_DANA';/);
    expect(svc).toMatch(/export type JenisRAKInput = 'PENYALURAN_DANA';/);
  });
});

// ===========================================================================
// AUDIT RC-S53 — bukti tingkat DATABASE, bukan hanya tingkat service
// ===========================================================================

describe('Audit — proteksi identity ada di database', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it('INSERT mentah dengan identity yang sama DITOLAK indeks UNIQUE', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    const asli = await testDb.getFirstAsync<Record<string, string | number>>(
      `SELECT * FROM investasi_bagian_shu WHERE id = ?`,
      akrual.id
    );
    // Menembus service sepenuhnya: kalau proteksinya hanya di layer
    // aplikasi, baris ini akan masuk.
    let ditolak = false;
    try {
      await testDb.runAsync(
        `INSERT INTO investasi_bagian_shu
          (id, investasi_id, jenis_hasil, tanggal_hak, jumlah, jenis_dokumen, nomor_dokumen,
           tanggal_dokumen, journal_id, jumlah_diterima, status, created_by, created_at, updated_at)
         VALUES ('paksa',?,?,?,?,?,?,?,?,0,'DIAKUI','user-1',?,?)`,
        asli!.investasi_id,
        asli!.jenis_hasil,
        asli!.tanggal_hak,
        999,
        'Dokumen lain',
        asli!.nomor_dokumen,
        '2026-03-20',
        asli!.journal_id,
        new Date().toISOString(),
        new Date().toISOString()
      );
    } catch {
      ditolak = true;
    }
    expect(ditolak).toBe(true);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM investasi_bagian_shu`
    );
    expect(n!.n).toBe(1);
  });

  it('INSERT mentah penerimaan dengan referensi yang sama DITOLAK indeks UNIQUE', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await catatPenerimaanBagianShu({
      bagianShuId: akrual.id,
      tanggal: '2026-04-05',
      jumlah: 1_000_000,
      sumberDana: 'KAS',
      nomorReferensi: 'TRM-001',
      createdBy: 'user-1',
    });
    const asli = await testDb.getFirstAsync<Record<string, string | number>>(
      `SELECT * FROM investasi_bagian_shu_penerimaan LIMIT 1`
    );
    let ditolak = false;
    try {
      await testDb.runAsync(
        `INSERT INTO investasi_bagian_shu_penerimaan
          (id, bagian_shu_id, tanggal, jumlah, sumber_dana, nomor_referensi, journal_id, created_by, created_at)
         VALUES ('paksa',?,?,?,'KAS',?,?,'user-1',?)`,
        asli!.bagian_shu_id,
        '2026-04-06',
        500_000,
        asli!.nomor_referensi,
        asli!.journal_id,
        new Date().toISOString()
      );
    } catch {
      ditolak = true;
    }
    expect(ditolak).toBe(true);
  });

  it('AUDIT FIX — rekening selain Kas Umum/bank ditolak, bukan dipetakan ke Kas Umum', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await expect(
      catatPenerimaanBagianShu({
        bagianShuId: akrual.id,
        tanggal: '2026-04-05',
        jumlah: 1_000_000,
        sumberDana: 'KAS_KECIL' as never,
        nomorReferensi: 'TRM-KK',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Kas Umum atau rekening bank/);
    // Nol jurnal penerimaan terbentuk, jadi tidak ada yang mendebit akun
    // kas yang salah.
    const j = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'BAGIAN_SHU_PENERIMAAN'`
    );
    expect(j!.n).toBe(0);
  });
});

// ===========================================================================
// HARDENING RC-S53 — sumber dana: dua lapis, dan keduanya diuji perilakunya
// ===========================================================================

describe('Hardening — sumber dana penerimaan', () => {
  beforeEach(async () => {
    await seedFixture();
    // Rekening bank sungguhan, supaya jalur BANK diuji sampai ke akunnya.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
       VALUES ('bank-1','Bank Uji','123456','Koperasi Uji',?,1,?)`,
      AKUN.bank, now
    );
  });

  it('KAS — jurnal mendebit akun Kas Umum, bukan akun lain', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    const terima = await catatPenerimaanBagianShu({
      bagianShuId: akrual.id, tanggal: '2026-04-05', jumlah: 1_000_000,
      sumberDana: 'KAS', nomorReferensi: 'TRM-KAS', createdBy: 'user-1',
    });
    const debit = await testDb.getFirstAsync<{ account_id: string; debit: number }>(
      `SELECT account_id, debit FROM journal_entry WHERE journal_id = ? AND debit > 0`,
      terima.journalId
    );
    expect(debit!.account_id).toBe(AKUN.kas);
    expect(debit!.debit).toBe(1_000_000);
  });

  it('BANK — jurnal mendebit akun rekening bank yang dipilih', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    const terima = await catatPenerimaanBagianShu({
      bagianShuId: akrual.id, tanggal: '2026-04-05', jumlah: 2_000_000,
      sumberDana: 'BANK', bankAccountId: 'bank-1',
      nomorReferensi: 'TRM-BANK', createdBy: 'user-1',
    });
    const entri = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      terima.journalId
    );
    const debit = entri.find((e) => e.debit > 0)!;
    const kredit = entri.find((e) => e.kredit > 0)!;
    expect(debit.account_id).toBe(AKUN.bank);
    expect(debit.account_id).not.toBe(AKUN.kas);
    expect(kredit.account_id).toBe(AKUN.piutang);
    // Tetap nol sentuhan ke akun pendapatan.
    expect(entri.some((e) => e.account_id === AKUN.pendapatan)).toBe(false);
  });

  it('BANK tanpa rekening — ditolak, nol jurnal penerimaan', async () => {
    const akrual = await catatBagianShuInvestasi(INPUT_SAH);
    await expect(
      catatPenerimaanBagianShu({
        bagianShuId: akrual.id, tanggal: '2026-04-05', jumlah: 1_000_000,
        sumberDana: 'BANK', nomorReferensi: 'TRM-X', createdBy: 'user-1',
      })
    ).rejects.toThrow();
    const j = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'BAGIAN_SHU_PENERIMAAN'`
    );
    expect(j!.n).toBe(0);
  });
});
