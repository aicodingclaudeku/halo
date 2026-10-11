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

import { setorSimpananBerjangka, getRingkasanSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  prosesAkrualBungaKontrak,
  prosesAkrualBungaSemuaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  cairkanSimpananBerjangka,
  getRingkasanPencairan,
  PESAN_BELUM_JATUH_TEMPO,
} from '@/services/SimpananBerjangkaLifecycleService';
import {
  hitungTotalBungaKontrak,
  buatJadwalBungaSimpananBerjangka,
  tambahBulanKalender,
} from '@/accounting/SimpananBerjangkaBunga';
import { getPosisiKeuangan, getLabaRugi } from '@/reports/FinancialReports';
import { jalankanRekonsiliasiLengkap } from '@/accounting/FullReconciliation';
import { MissingAccountMappingError } from '@/accounting/AccountMapping';

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  bank2: 'acc-bank2',
  berjangka: 'acc-2-1210',
  utangBunga: 'acc-2-1710',
  bebanBunga: 'acc-5-1955',
  modal: 'acc-3-1000',
  sukarela: 'acc-2-1200', // RC-S128: bunga dipindahkan ke Simpanan Sukarela
};

const BANK_ID = 'bank-1';
const BANK2_ID = 'bank-2';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
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

async function seedAnggota(db: TestDb, id: string, nomor: string, nik: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,'2020-01-01','AKTIF',?,?)`,
    id, nomor, nik, `Anggota ${nomor}`, now, now
  );
}

async function seedFixture(opts: { mappingBunga?: boolean; mappingPencairan?: boolean } = {}): Promise<TestDb> {
  const { mappingBunga = true, mappingPencairan = true } = opts;
  const db = await createTestDb();
  await seedKebijakanProdukUji(db); // RC-S128: penempatan berjangka mewajibkan kebijakan produk
  const now = new Date().toISOString();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank2, '1-1101', 'Bank B', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.berjangka, '2-1210', 'Simpanan Anggota (Berjangka)', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.utangBunga, '2-1710', 'Utang Bunga Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanBunga, '5-1955', 'Beban Bunga Simpanan Berjangka', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.sukarela, '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', ACC.berjangka);
  await seedMapping(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);
  if (mappingBunga) {
    await seedMapping(db, 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN', ACC.bebanBunga);
    await seedMapping(db, 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', ACC.utangBunga);
  }
  if (mappingPencairan) {
    await seedMapping(db, 'SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_POKOK', ACC.berjangka);
    await seedMapping(db, 'SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_UTANG_BUNGA', ACC.utangBunga);
  }

  // Dua tahun buku terbuka: kontrak 12 bulan melintasi tahun.
  for (const th of [2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await seedAnggota(db, 'anggota-A', 'A001', '1111111111111111');
  await seedAnggota(db, 'anggota-B', 'A002', '2222222222222222');
  await seedAnggota(db, 'anggota-C', 'A003', '3333333333333333');

  for (const [id, nama, acc] of [[BANK_ID, 'Bank A', ACC.bank], [BANK2_ID, 'Bank B', ACC.bank2]] as const) {
    await db.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
       VALUES (?,?,?,?,?,1,?)`,
      id, nama, '123', 'Koperasi', acc, now
    );
  }
  return db;
}

async function saldoAkun(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit) - SUM(je.debit), 0) s
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status = 'POSTED'`,
    accountId
  );
  return r?.s ?? 0;
}

const setor12x12 = {
  anggotaId: 'anggota-A',
  nominal: 10_000_000,
  tanggal: '2026-01-15',
  tenorBulan: 12 as const,
  sukuBungaPerTahun: 12,
  sumberDana: 'KAS' as const,
  createdBy: 'user-1',
};

// ============================================================
// §7 — FORMULA BUNGA KONTRAKTUAL
// ============================================================

describe('§7 total bunga kontraktual = pokok x rate x tenor/12', () => {
  test('10.000.000 @ 12% tenor 12 = 1.200.000', () => {
    expect(hitungTotalBungaKontrak(10_000_000, 12, 12)).toBe(1_200_000);
  });
  test('10.000.000 @ 12% tenor 6 = 600.000', () => {
    expect(hitungTotalBungaKontrak(10_000_000, 12, 6)).toBe(600_000);
  });
  test('10.000.000 @ 12% tenor 3 = 300.000', () => {
    expect(hitungTotalBungaKontrak(10_000_000, 12, 3)).toBe(300_000);
  });
  test('rate 0 -> bunga 0', () => {
    expect(hitungTotalBungaKontrak(10_000_000, 0, 12)).toBe(0);
  });
  test('rate 8.5 dibulatkan ke Rupiah bulat', () => {
    const t = hitungTotalBungaKontrak(10_000_000, 8.5, 6);
    expect(t).toBe(425_000);
    expect(Number.isInteger(t)).toBe(true);
  });
  test('rate negatif / NaN ditolak', () => {
    expect(() => hitungTotalBungaKontrak(10_000_000, -1, 3)).toThrow(/tidak valid/i);
    expect(() => hitungTotalBungaKontrak(10_000_000, NaN, 3)).toThrow(/tidak valid/i);
  });
});

// ============================================================
// §8 — ALOKASI PERIODE & RESIDU
// ============================================================

describe('§8 alokasi per periode & residu', () => {
  test('jumlah seluruh alokasi PERSIS sama dengan total kontrak (tanpa toleransi)', () => {
    for (const [pokok, rate, tenor] of [
      [10_000_000, 12, 12],
      [10_000_000, 10, 12],
      [3_333_333, 7.7, 6],
      [1_000_000, 1, 3],
      [12_345_678, 8.5, 12],
    ] as const) {
      const total = hitungTotalBungaKontrak(pokok, rate, tenor);
      const jadwal = buatJadwalBungaSimpananBerjangka(pokok, rate, tenor, '2026-01-15');
      const jumlah = jadwal.reduce((a, p) => a + p.bunga, 0);
      expect(jumlah).toBe(total);
    }
  });

  test('residu ditempatkan di periode TERAKHIR, bukan disebar diam-diam', () => {
    // total 1.000.000 / 12 -> floor 83.333, 11 x 83.333 = 916.663,
    // periode terakhir = 83.337.
    const jadwal = buatJadwalBungaSimpananBerjangka(10_000_000, 10, 12, '2026-01-15');
    expect(jadwal.slice(0, 11).every((p) => p.bunga === 83_333)).toBe(true);
    expect(jadwal[11].bunga).toBe(1_000_000 - 83_333 * 11);
    expect(jadwal.reduce((a, p) => a + p.bunga, 0)).toBe(1_000_000);
  });

  test('semua alokasi berupa Rupiah bulat', () => {
    const jadwal = buatJadwalBungaSimpananBerjangka(7_777_777, 6.35, 12, '2026-03-31');
    expect(jadwal.every((p) => Number.isInteger(p.bunga))).toBe(true);
  });

  test('periode terakhir jatuh PERSIS pada tanggal jatuh tempo kontrak', () => {
    const jadwal = buatJadwalBungaSimpananBerjangka(10_000_000, 12, 3, '2026-01-31');
    expect(jadwal[2].tanggalAkhirPeriode).toBe('2026-04-30');
  });

  test('tambahBulanKalender memakai clamping akhir bulan, anchored ke tanggal asal', () => {
    expect(tambahBulanKalender('2026-01-31', 1)).toBe('2026-02-28');
    expect(tambahBulanKalender('2026-01-31', 2)).toBe('2026-03-31');
    expect(tambahBulanKalender('2028-01-31', 1)).toBe('2028-02-29');
    expect(tambahBulanKalender('2026-01-31', 12)).toBe('2027-01-31');
  });
});

// ============================================================
// §10/§15/§16 — AKRUAL
// ============================================================

describe('§10/§15 akrual bunga', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('Dr Beban Bunga / Cr Utang Bunga; 2-1210 TIDAK disentuh', async () => {
    const { id } = await setorSimpananBerjangka(setor12x12);
    const pokokSebelum = await saldoAkun(ACC.berjangka);

    const hasil = await prosesAkrualBungaKontrak(id, '2026-03-20', 'user-1');

    // Periode berakhir 15 Feb & 15 Mar -> 2 periode earned.
    expect(hasil.periodeDiakui).toHaveLength(2);
    expect(hasil.totalBungaDiakuiSekarang).toBe(100_000 * 2);
    expect(await saldoAkun(ACC.utangBunga)).toBe(200_000);
    expect(await saldoAkun(ACC.bebanBunga)).toBe(-200_000); // beban = debit
    expect(await saldoAkun(ACC.berjangka)).toBe(pokokSebelum);
  });

  test('akrual TIDAK mendahului waktu', async () => {
    const { id } = await setorSimpananBerjangka(setor12x12);
    const hasil = await prosesAkrualBungaKontrak(id, '2026-02-10', 'user-1');
    expect(hasil.periodeDiakui).toHaveLength(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(0);
  });

  test('§15 IDEMPOTEN: dijalankan dua kali tidak menggandakan beban/utang/jurnal', async () => {
    const { id } = await setorSimpananBerjangka(setor12x12);
    await prosesAkrualBungaKontrak(id, '2026-06-20', 'user-1');
    const utang1 = await saldoAkun(ACC.utangBunga);
    const jml1 = (await testDb.getAllAsync(`SELECT id FROM journal WHERE sumber_transaksi = 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL'`)).length;

    const kedua = await prosesAkrualBungaKontrak(id, '2026-06-20', 'user-1');
    expect(kedua.periodeDiakui).toHaveLength(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(utang1);
    expect((await testDb.getAllAsync(`SELECT id FROM journal WHERE sumber_transaksi = 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL'`)).length).toBe(jml1);
  });

  test('rate 0 -> tidak ada jurnal bunga sama sekali', async () => {
    const { id } = await setorSimpananBerjangka({ ...setor12x12, sukuBungaPerTahun: 0, tenorBulan: 3 });
    const hasil = await prosesAkrualBungaKontrak(id, '2027-01-01', 'user-1');
    expect(hasil.periodeDiakui).toHaveLength(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(0);
    expect(await saldoAkun(ACC.bebanBunga)).toBe(0);
  });

  test('§16 periode TERTUTUP -> akrual DITOLAK, tanpa mutasi sebagian', async () => {
    const { id } = await setorSimpananBerjangka(setor12x12);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);

    await expect(prosesAkrualBungaKontrak(id, '2026-06-20', 'user-1')).rejects.toThrow();

    expect(await testDb.getAllAsync(`SELECT id FROM simpanan_berjangka_bunga`)).toHaveLength(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(0);
    const k = await testDb.getFirstAsync<{ bunga_terakru: number }>(`SELECT bunga_terakru FROM simpanan_berjangka WHERE id = ?`, id);
    expect(k!.bunga_terakru).toBe(0);
  });

  test('§11 mapping bunga hilang -> MissingAccountMappingError & rollback', async () => {
    testDb = await seedFixture({ mappingBunga: false });
    const { id } = await setorSimpananBerjangka(setor12x12);
    await expect(prosesAkrualBungaKontrak(id, '2026-06-20', 'user-1')).rejects.toThrow(MissingAccountMappingError);
    expect(await testDb.getAllAsync(`SELECT id FROM simpanan_berjangka_bunga`)).toHaveLength(0);
  });

  test('§42 multi-contract: tiap kontrak dihitung independen', async () => {
    const a = await setorSimpananBerjangka({ ...setor12x12, anggotaId: 'anggota-A' });
    const b = await setorSimpananBerjangka({
      anggotaId: 'anggota-B', nominal: 5_000_000, tanggal: '2026-01-15',
      tenorBulan: 6, sukuBungaPerTahun: 6, sumberDana: 'KAS', createdBy: 'user-1',
    });
    const c = await setorSimpananBerjangka({
      anggotaId: 'anggota-C', nominal: 3_000_000, tanggal: '2026-01-15',
      tenorBulan: 3, sukuBungaPerTahun: 0, sumberDana: 'KAS', createdBy: 'user-1',
    });

    await prosesAkrualBungaSemuaKontrak('2026-07-20', 'user-1');

    const cek = async (id: string) =>
      (await testDb.getFirstAsync<{ b: number }>(`SELECT bunga_terakru b FROM simpanan_berjangka WHERE id = ?`, id))!.b;

    // A: 12% x 10jt x 12/12 = 1.200.000 / 12 = 100.000 x 6 periode
    expect(await cek(a.id)).toBe(600_000);
    // B: 6% x 5jt x 6/12 = 150.000 / 6 = 25.000 x 6 periode (semua earned)
    expect(await cek(b.id)).toBe(150_000);
    // C: rate 0
    expect(await cek(c.id)).toBe(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(750_000);
  });
});

// ============================================================
// §17/§18/§19 — JATUH TEMPO
// ============================================================

describe('§17/§18 jatuh tempo otomatis', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('AKTIF -> JATUH_TEMPO tanpa jurnal tambahan', async () => {
    const { id } = await setorSimpananBerjangka({ ...setor12x12, tenorBulan: 3 });
    const jurnalSebelum = (await testDb.getAllAsync(`SELECT id FROM journal`)).length;

    await prosesJatuhTempoSimpananBerjangka('2026-04-20', 'user-1');

    const k = await testDb.getFirstAsync<{ status: string; bunga_terakru: number }>(
      `SELECT status, bunga_terakru FROM simpanan_berjangka WHERE id = ?`, id
    );
    expect(k!.status).toBe('JATUH_TEMPO');
    // Bunga periode terakhir sudah lengkap: 12% x 10jt x 3/12 = 300.000
    expect(k!.bunga_terakru).toBe(300_000);

    // Jurnal yang bertambah HANYA jurnal akrual — tidak ada jurnal
    // "jatuh tempo".
    const jenis = await testDb.getAllAsync<{ sumber_transaksi: string }>(`SELECT sumber_transaksi FROM journal`);
    expect(jenis.filter((j) => j.sumber_transaksi === 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL')).toHaveLength(3);
    expect(jenis.length).toBe(jurnalSebelum + 3);
  });

  test('§20 jatuh tempo BUKAN pencairan otomatis: kas tidak bergerak', async () => {
    await setorSimpananBerjangka({ ...setor12x12, tenorBulan: 3 });
    const kasSebelum = await saldoAkun(ACC.kas);
    await prosesJatuhTempoSimpananBerjangka('2026-04-20', 'user-1');
    expect(await saldoAkun(ACC.kas)).toBe(kasSebelum);
  });

  test('kontrak yang belum jatuh tempo tidak ikut berubah status', async () => {
    const { id } = await setorSimpananBerjangka({ ...setor12x12, tenorBulan: 12 });
    await prosesJatuhTempoSimpananBerjangka('2026-06-20', 'user-1');
    const k = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM simpanan_berjangka WHERE id = ?`, id);
    expect(k!.status).toBe('AKTIF');
  });
});

// ============================================================
// §26/§27/§28 — PENCAIRAN
// ============================================================

describe('§26/§27/§28 pencairan', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  async function siapkanJatuhTempo(over: Partial<typeof setor12x12> = {}) {
    const { id } = await setorSimpananBerjangka({ ...setor12x12, tenorBulan: 3, ...over } as any);
    await prosesJatuhTempoSimpananBerjangka('2026-04-20', 'user-1');
    return id;
  }

  test('§26 pencairan SEBELUM jatuh tempo DITOLAK', async () => {
    const { id } = await setorSimpananBerjangka({ ...setor12x12, tenorBulan: 12 });
    await expect(
      cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-06-01', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(PESAN_BELUM_JATUH_TEMPO);
    expect(await testDb.getAllAsync(`SELECT id FROM journal WHERE sumber_transaksi = 'SIMPANAN_BERJANGKA_PENCAIRAN'`)).toHaveLength(0);
  });

  test('§41 pencairan saat jatuh tempo (RC-S128): Dr pokok / Cr Kas; bunga lewat Simpanan Sukarela', async () => {
    const id = await siapkanJatuhTempo();
    const hasil = await cairkanSimpananBerjangka({
      kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1',
    });

    expect(hasil.pokok).toBe(10_000_000);
    expect(hasil.bunga).toBe(0); // RC-S128: bunga sudah dipindahkan ke Simpanan Sukarela; kas hanya membayar pokok
    expect(hasil.bungaDipindahkanSaatPencairan).toBe(300_000);
    expect(hasil.total).toBe(10_000_000);
    expect(await saldoAkun(ACC.sukarela)).toBe(300_000);

    // §35 setelah payout: pokok & utang bunga NOL
    expect(await saldoAkun(ACC.berjangka)).toBe(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(0);
    // §36 beban kumulatif TETAP 300.000 — tidak ada expense kedua
    expect(await saldoAkun(ACC.bebanBunga)).toBe(-300_000);
    // Kas: +10.000.000 (setor) -10.000.000 (cair pokok) = 0 net. RC-S128:
    // bunga 300.000 kini berada di Simpanan Sukarela, bukan dibayar tunai.
    expect(await saldoAkun(ACC.kas)).toBe(0); // kredit-debit
  });

  test('§29 TIDAK ADA beban bunga kedua pada jurnal pencairan', async () => {
    const id = await siapkanJatuhTempo();
    await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });

    const barisPencairan = await testDb.getAllAsync<{ account_id: string }>(
      `SELECT je.account_id FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE j.sumber_transaksi = 'SIMPANAN_BERJANGKA_PENCAIRAN'`
    );
    expect(barisPencairan.some((b) => b.account_id === ACC.bebanBunga)).toBe(false);
  });

  test('§27 status JATUH_TEMPO -> DICAIRKAN; pencairan kedua ditolak', async () => {
    const id = await siapkanJatuhTempo();
    await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });

    const k = await testDb.getFirstAsync<{ status: string; bunga_dibayar: number }>(
      `SELECT status, bunga_dibayar FROM simpanan_berjangka WHERE id = ?`, id
    );
    expect(k!.status).toBe('DICAIRKAN');
    expect(k!.bunga_dibayar).toBe(300_000);

    await expect(
      cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-21', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah dicairkan/i);
  });

  test('§31 idempotency key: double click -> satu payout', async () => {
    const id = await siapkanJatuhTempo();
    const key = 'cair-abc';
    const a = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1', idempotencyKey: key });
    const b = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1', idempotencyKey: key });

    expect(a.duplikat).toBe(false);
    expect(b.duplikat).toBe(true);
    expect(await testDb.getAllAsync(`SELECT id FROM journal WHERE sumber_transaksi = 'SIMPANAN_BERJANGKA_PENCAIRAN'`)).toHaveLength(1);
  });

  test('§32 payout BANK memakai akun bank; bank kosong ditolak', async () => {
    const id = await siapkanJatuhTempo();
    await expect(
      cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'BANK', createdBy: 'user-1' })
    ).rejects.toThrow(/bankAccountId wajib/i);

    await cairkanSimpananBerjangka({
      kontrakId: id, tanggal: '2026-04-20', sumberDana: 'BANK', bankAccountId: BANK_ID, createdBy: 'user-1',
    });
    expect(await saldoAkun(ACC.bank)).toBe(10_000_000); // kredit — RC-S128: bunga sudah dipindahkan ke Simpanan Sukarela; kas hanya membayar pokok
    // Kas hanya menerima setoran awal (Dr 10jt) dan TIDAK tersentuh
    // payout — bukti tidak ada fallback diam-diam ke Kas.
    expect(await saldoAkun(ACC.kas)).toBe(-10_000_000);
  });

  test('§43 multi-bank: tiap kontrak memakai akunnya masing-masing', async () => {
    const a = await siapkanJatuhTempo({ anggotaId: 'anggota-A' } as any);
    const b = await siapkanJatuhTempo({ anggotaId: 'anggota-B' } as any);
    const c = await siapkanJatuhTempo({ anggotaId: 'anggota-C' } as any);

    await cairkanSimpananBerjangka({ kontrakId: a, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });
    await cairkanSimpananBerjangka({ kontrakId: b, tanggal: '2026-04-20', sumberDana: 'BANK', bankAccountId: BANK_ID, createdBy: 'user-1' });
    await cairkanSimpananBerjangka({ kontrakId: c, tanggal: '2026-04-20', sumberDana: 'BANK', bankAccountId: BANK2_ID, createdBy: 'user-1' });

    expect(await saldoAkun(ACC.bank)).toBe(10_000_000); // RC-S128: bunga sudah dipindahkan ke Simpanan Sukarela; kas hanya membayar pokok
    expect(await saldoAkun(ACC.bank2)).toBe(10_000_000);
    expect(await saldoAkun(ACC.berjangka)).toBe(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(0);
  });

  test('§44 payout pada periode TERTUTUP ditolak tanpa mutasi', async () => {
    const id = await siapkanJatuhTempo();
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    await expect(
      cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow();
    const k = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM simpanan_berjangka WHERE id = ?`, id);
    expect(k!.status).toBe('JATUH_TEMPO');
  });

  test('§30 mapping pencairan hilang -> rollback total', async () => {
    testDb = await seedFixture({ mappingPencairan: false });
    const id = await siapkanJatuhTempo();
    await expect(
      cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(MissingAccountMappingError);
    const k = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM simpanan_berjangka WHERE id = ?`, id);
    expect(k!.status).toBe('JATUH_TEMPO');
    expect(await testDb.getAllAsync(`SELECT id FROM journal WHERE sumber_transaksi = 'SIMPANAN_BERJANGKA_PENCAIRAN'`)).toHaveLength(0);
  });

  test('kontrak rate 0: pencairan hanya pokok, tanpa baris utang bunga', async () => {
    const id = await siapkanJatuhTempo({ sukuBungaPerTahun: 0 } as any);
    const hasil = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });
    expect(hasil.bunga).toBe(0);
    expect(hasil.total).toBe(10_000_000);
    const baris = await testDb.getAllAsync<{ account_id: string }>(
      `SELECT je.account_id FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE j.sumber_transaksi = 'SIMPANAN_BERJANGKA_PENCAIRAN'`
    );
    expect(baris.some((b) => b.account_id === ACC.utangBunga)).toBe(false);
    expect(baris).toHaveLength(2);
  });

  test('§25 ringkasan pencairan menampilkan alasan bila belum jatuh tempo', async () => {
    const { id } = await setorSimpananBerjangka({ ...setor12x12, tenorBulan: 12 });
    const r = await getRingkasanPencairan(id);
    expect(r.status).toBe('AKTIF');
    expect(r.alasanTidakBolehCair).toBe(PESAN_BELUM_JATUH_TEMPO);
    expect(r.totalBungaKontrak).toBe(1_200_000);
  });
});

// ============================================================
// §35/§36/§38/§41 — LAPORAN & REKONSILIASI
// ============================================================

describe('§35/§36/§38 laporan & rekonsiliasi', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('§41 skenario penuh 10jt @12% 12 bulan', async () => {
    const { id } = await setorSimpananBerjangka(setor12x12);
    await prosesJatuhTempoSimpananBerjangka('2027-01-20', 'user-1');

    // Pada jatuh tempo
    const k = await testDb.getFirstAsync<{ status: string; bunga_terakru: number }>(
      `SELECT status, bunga_terakru FROM simpanan_berjangka WHERE id = ?`, id
    );
    expect(k!.status).toBe('JATUH_TEMPO');
    expect(k!.bunga_terakru).toBe(1_200_000);
    expect(await saldoAkun(ACC.berjangka)).toBe(10_000_000);
    expect(await saldoAkun(ACC.utangBunga)).toBe(1_200_000);

    const hasil = await cairkanSimpananBerjangka({
      kontrakId: id, tanggal: '2027-01-20', sumberDana: 'KAS', createdBy: 'user-1',
    });
    expect(hasil.total).toBe(10_000_000); // RC-S128: bunga sudah dipindahkan ke Simpanan Sukarela; kas hanya membayar pokok
    expect(await saldoAkun(ACC.sukarela)).toBe(1_200_000);

    // Setelah payout
    expect(await saldoAkun(ACC.berjangka)).toBe(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(0);
    expect(await saldoAkun(ACC.bebanBunga)).toBe(-1_200_000);

    // Neraca tetap seimbang
    const posisi = await getPosisiKeuangan(testDb as any, '2027-12-31');
    expect(posisi.selisih).toBe(0);
  });

  test('§35 selama AKTIF: 2-1210 = pokok, bunga di akun liabilitas TERPISAH', async () => {
    await setorSimpananBerjangka(setor12x12);
    await prosesAkrualBungaSemuaKontrak('2026-06-20', 'user-1');

    const posisi = await getPosisiKeuangan(testDb as any, '2026-06-30');
    expect(posisi.liabilitas.find((x) => x.kode === '2-1210')?.saldo).toBe(10_000_000);
    expect(posisi.liabilitas.find((x) => x.kode === '2-1710')?.saldo).toBe(500_000);
    expect(posisi.selisih).toBe(0);
  });

  test('§36 bunga muncul sebagai BEBAN, bukan pendapatan', async () => {
    await setorSimpananBerjangka(setor12x12);
    await prosesAkrualBungaSemuaKontrak('2026-06-20', 'user-1');

    const lr = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    expect(lr.beban.find((x) => x.kode === '5-1955')?.jumlah).toBe(500_000);
    expect(lr.pendapatan.some((x) => x.kode === '5-1955')).toBe(false);
  });

  test('§38 rekonsiliasi pokok & utang bunga: variance 0', async () => {
    const { id } = await setorSimpananBerjangka(setor12x12);
    await prosesAkrualBungaSemuaKontrak('2026-06-20', 'user-1');

    let hasil = await jalankanRekonsiliasiLengkap(testDb as any);
    const pokok = hasil.baris.find((b) => b.domain === 'Savings berjangka (pokok)');
    const bunga = hasil.baris.find((b) => b.domain === 'Savings berjangka (utang bunga)');
    expect(pokok?.variance).toBe(0);
    expect(bunga?.subledger).toBe(500_000);
    expect(bunga?.gl).toBe(500_000);
    expect(bunga?.variance).toBe(0);

    await prosesJatuhTempoSimpananBerjangka('2027-01-20', 'user-1');
    await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2027-01-20', sumberDana: 'KAS', createdBy: 'user-1' });

    hasil = await jalankanRekonsiliasiLengkap(testDb as any);
    expect(hasil.baris.find((b) => b.domain === 'Savings berjangka (pokok)')?.variance).toBe(0);
    expect(hasil.baris.find((b) => b.domain === 'Savings berjangka (utang bunga)')?.variance).toBe(0);
  });

  test('§34 ringkasan anggota: saldo aktif turun setelah dicairkan, histori tetap ada', async () => {
    const { id } = await setorSimpananBerjangka({ ...setor12x12, tenorBulan: 3 });
    await prosesJatuhTempoSimpananBerjangka('2026-04-20', 'user-1');
    await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });

    const ringkasan = await getRingkasanSimpananBerjangka('anggota-A');
    expect(ringkasan.saldoPokok).toBe(0);
    expect(ringkasan.jumlahKontrakAktif).toBe(0);
    // Kontrak & jejak bunganya TETAP tersimpan.
    expect(await testDb.getAllAsync(`SELECT id FROM simpanan_berjangka`)).toHaveLength(1);
    expect((await testDb.getAllAsync(`SELECT id FROM simpanan_berjangka_bunga`)).length).toBe(3);
  });

  test('§39/§40 invarian: pokok tak berubah oleh bunga; akrual tak melebihi kontrak', async () => {
    const { id } = await setorSimpananBerjangka(setor12x12);
    await prosesAkrualBungaSemuaKontrak('2028-01-01', 'user-1'); // jauh melewati tenor

    const k = await testDb.getFirstAsync<{ nominal: number; bunga_terakru: number }>(
      `SELECT nominal, bunga_terakru FROM simpanan_berjangka WHERE id = ?`, id
    );
    expect(k!.nominal).toBe(10_000_000); // pokok TIDAK PERNAH bertambah bunga
    expect(k!.bunga_terakru).toBe(1_200_000); // tidak melebihi kontrak
    expect(await testDb.getAllAsync(`SELECT id FROM simpanan_berjangka_bunga WHERE simpanan_berjangka_id = ?`, id)).toHaveLength(12);
  });

  test('§54 integritas database bersih sepanjang lifecycle', async () => {
    const { id } = await setorSimpananBerjangka({ ...setor12x12, tenorBulan: 3 });
    await prosesJatuhTempoSimpananBerjangka('2026-04-20', 'user-1');
    await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });

    const integrity = await testDb.getAllAsync<{ integrity_check: string }>(`PRAGMA integrity_check`);
    expect(integrity[0].integrity_check).toBe('ok');
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);

    const t = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT SUM(debit) d, SUM(kredit) k FROM journal_entry`
    );
    expect(t!.d).toBe(t!.k);
  });
});
