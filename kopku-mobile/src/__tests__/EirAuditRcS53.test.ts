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

import { ajukanPinjaman, cairkanPinjaman } from '@/services/PinjamanService';
import { getEirTersimpan } from '@/services/EirAccountingService';
import {
  solveEffectiveInterestRate,
  EirSolverError,
  type EirCashFlow,
} from '@/accounting/EffectiveInterestRateService';

/**
 * §AA — AUDIT EIR: CELAH YANG BELUM TERTUTUP SUITE LAIN.
 *
 * Suite existing sudah menguji solver (EirShortTermSolver), konvensi
 * tanggal (EirDateOnlyAudit), skenario device (EirDeviceScenarioIntegral),
 * settlement/write-off (EirSettlementWriteOffIntegration), non-accrual,
 * dan restrukturisasi. Berkas ini SENGAJA tidak mengulanginya.
 *
 * Yang ditambahkan di sini adalah kasus yang belum punya pembuktian:
 *   - tahun kabisat & batas akhir bulan pada perhitungan hari cashflow;
 *   - tenor panjang (konvergensi, finite, deterministik);
 *   - persistensi: hitung -> simpan -> "reload" -> rate identik;
 *   - determinisme 10 kali pemanggilan;
 *   - batas klasifikasi fee: hanya fee INTEGRAL yang masuk cashflow EIR;
 *   - invarian NPV(r) = 0 diverifikasi ulang secara independen.
 *
 * Seluruhnya lewat `cairkanPinjaman()` SUNGGUHAN di atas SQLite nyata,
 * kecuali bagian solver murni yang memang tidak butuh database.
 */

const ACC = {
  kas: 'acc-kas',
  piutang: 'acc-piutang',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDenda: 'acc-pendapatan-denda',
  modal: 'acc-modal',
};

const ANGGOTA_ID = 'anggota-1';

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
     VALUES (?,?,?,?,?,1,1,?,?)`,
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

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutang);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);

  for (const th of [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `period-${th}`,
      th,
      `${th}-01-01`,
      `${th}-12-31`
    );
  }

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
     VALUES ('j-modal','JRN-MODAL','2024-01-01','period-2024','MODAL_AWAL','Modal awal fixture','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je1','j-modal',?,?,0)`,
    ACC.kas,
    900_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je2','j-modal',?,0,?)`,
    ACC.modal,
    900_000_000
  );

  for (const [id, jenis, nominal] of [
    ['sp', 'POKOK', 100000],
    ['sw', 'WAJIB', 50000],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,'SETOR',?,?,'KAS',?, 'user-1',?)`,
      id,
      ANGGOTA_ID,
      jenis,
      '2020-01-01',
      nominal,
      id.toUpperCase(),
      now
    );
  }
}

interface OpsiPinjaman {
  tanggal: string;
  jumlah?: number;
  tenor?: number;
  satuanTenor?: 'BULAN' | 'HARI';
  metodeJasa?: 'FLAT' | 'EFEKTIF' | 'MENURUN';
  persentaseJasa?: number;
  biayaAdminTipe?: 'NOMINAL' | 'PERSENTASE';
  biayaAdminNilai?: number;
  klasifikasi?: string;
}

async function cairkan(o: OpsiPinjaman): Promise<string> {
  const p = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: o.tanggal,
    jumlahPinjaman: o.jumlah ?? 12_000_000,
    tenor: o.tenor ?? 12,
    satuanTenor: o.satuanTenor ?? 'BULAN',
    metodeJasa: o.metodeJasa ?? 'FLAT',
    persentaseJasa: o.persentaseJasa ?? 12,
    biayaAdminTipe: o.biayaAdminTipe ?? 'NOMINAL',
    biayaAdminNilai: o.biayaAdminNilai ?? 240_000,
    biayaAdminKlasifikasi: (o.klasifikasi ?? 'INTEGRAL_FINANCIAL_INSTRUMENT') as never,
    dendaAktif: false,
    createdBy: 'user-1',
  } as never);
  await cairkanPinjaman({
    pinjamanId: (p as { id: string }).id,
    sumberDana: 'KAS',
    approvedBy: 'user-1',
    tanggalPencairan: o.tanggal,
  } as never);
  return (p as { id: string }).id;
}

async function bacaRate(pinjamanId: string): Promise<number | null> {
  const row = await testDb.getFirstAsync<{ effective_interest_rate: number | null }>(
    `SELECT effective_interest_rate FROM pinjaman_akuntansi_jasa
      WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
    pinjamanId
  );
  return row?.effective_interest_rate ?? null;
}

async function statusEir(pinjamanId: string): Promise<string | null> {
  const row = await testDb.getFirstAsync<{ eir_measurement_status: string | null }>(
    `SELECT eir_measurement_status FROM pinjaman WHERE id = ?`,
    pinjamanId
  );
  return row?.eir_measurement_status ?? null;
}

/** Rekonstruksi cashflow kontraktual INDEPENDEN dari jadwal tersimpan. */
async function cashflowKontraktual(
  pinjamanId: string,
  tanggalPencairan: string,
  carryingAwal: number
): Promise<EirCashFlow[]> {
  const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string; total: number }>(
    `SELECT tanggal_jatuh_tempo, total FROM angsuran_jadwal
      WHERE pinjaman_id = ? ORDER BY nomor_angsuran ASC`,
    pinjamanId
  );
  const t0 = new Date(tanggalPencairan).getTime();
  return [
    { hari: 0, jumlah: -carryingAwal },
    ...rows.map((r) => ({
      hari: Math.round((new Date(r.tanggal_jatuh_tempo).getTime() - t0) / 86_400_000),
      jumlah: r.total,
    })),
  ];
}

function npv(rate: number, cf: EirCashFlow[]): number {
  return cf.reduce((a, c) => a + c.jumlah / Math.pow(1 + rate, c.hari / 365), 0);
}

beforeEach(async () => {
  await setupFixture();
});

afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// FEE CLASSIFICATION — batas apa yang masuk cashflow EIR
// ===========================================================================

describe('§AA FEE — hanya fee INTEGRAL yang memicu & masuk EIR', () => {
  it('1. FLAT tanpa fee -> NOT_APPLICABLE, tidak ada EIR dipaksakan', async () => {
    const id = await cairkan({ tanggal: '2026-03-02', biayaAdminNilai: 0 });
    expect(await statusEir(id)).toBe('NOT_APPLICABLE');
    expect(await bacaRate(id)).toBeNull();
    expect(await getEirTersimpan(testDb as never, id)).toBeNull();
  });

  it('2. FLAT + fee INTEGRAL -> EIR diukur dan tersimpan', async () => {
    const id = await cairkan({ tanggal: '2026-03-02' });
    expect(await statusEir(id)).toBe('MEASURED');
    const rate = await bacaRate(id);
    expect(rate).not.toBeNull();
    expect(Number.isFinite(rate as number)).toBe(true);
  });

  it('3. fee NON-INTEGRAL (jasa terpisah) TIDAK memicu EIR', async () => {
    const id = await cairkan({
      tanggal: '2026-03-02',
      klasifikasi: 'SEPARATE_SERVICE',
    });
    // Statusnya tetap 'EIR_NOT_MIGRATED' (DEFAULT kolom), BUKAN
    // 'NOT_APPLICABLE'. Keduanya sama-sama berarti "tidak diukur EIR",
    // tetapi asalnya berbeda dan pembedaannya disengaja:
    //   EIR_NOT_MIGRATED -> pinjaman ini tidak pernah masuk jalur EIR;
    //   NOT_APPLICABLE   -> masuk jalur EIR, tetapi fee integralnya nol.
    // Yang penting bagi §AA: tidak ada rate yang dipaksakan.
    expect(await statusEir(id)).toBe('EIR_NOT_MIGRATED');
    expect(await statusEir(id)).not.toBe('MEASURED');
    expect(await bacaRate(id)).toBeNull();
    expect(await getEirTersimpan(testDb as never, id)).toBeNull();
  });

  it('fee integral MENAIKKAN effective yield di atas rate kontraktual', async () => {
    // Kalau EIR keluar sama dengan rate kontraktual padahal ada fee
    // integral, berarti fee-nya tidak pernah masuk cashflow.
    const tanpaFee = await cairkan({ tanggal: '2026-03-02', biayaAdminNilai: 0 });
    const denganFee = await cairkan({ tanggal: '2026-03-02', biayaAdminNilai: 240_000 });

    expect(await bacaRate(tanpaFee)).toBeNull();
    const rate = (await bacaRate(denganFee)) as number;
    // Jasa FLAT 12% setahun; fee 2% di muka membuat yield efektif jauh
    // lebih tinggi daripada 12%.
    expect(rate).toBeGreaterThan(0.12);
  });

  it('denda TIDAK ikut ke cashflow EIR — total = pokok + jasa saja', async () => {
    const id = await cairkan({ tanggal: '2026-03-02' });

    // `angsuran_jadwal` MEMANG punya kolom `denda`, tetapi cashflow EIR
    // dibangun dari kolom `total`. Yang harus dibuktikan karena itu
    // bukan "denda tidak ada", melainkan "denda tidak masuk total".
    const baris = await testDb.getAllAsync<{ pokok: number; jasa: number; total: number; denda: number }>(
      `SELECT pokok, jasa, total, denda FROM angsuran_jadwal WHERE pinjaman_id = ?`,
      id
    );
    expect(baris.length).toBeGreaterThan(0);
    for (const b of baris) {
      expect(b.total).toBe(b.pokok + b.jasa);
      expect(b.total).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// DATE — kabisat, batas bulan, batas tahun
// ===========================================================================

describe('§AA DATE — hari kalender sungguhan', () => {
  it('8. tahun KABISAT: cashflow melewati 29 Feb 2028 dan tetap konvergen', async () => {
    const id = await cairkan({ tanggal: '2028-01-31', tenor: 6 });
    const rate = (await bacaRate(id)) as number;
    expect(Number.isFinite(rate)).toBe(true);

    const cf = await cashflowKontraktual(id, '2028-01-31', 12_000_000 - 240_000);
    // 31 Jan + 1 bulan harus menjepit ke 29 Feb pada tahun kabisat.
    expect(cf[1].hari).toBe(29);
    expect(Math.abs(npv(rate, cf))).toBeLessThanOrEqual(0.5);
  });

  it('6. batas akhir bulan: 31 Jan -> 28 Feb pada tahun BUKAN kabisat', async () => {
    const id = await cairkan({ tanggal: '2026-01-31', tenor: 6 });
    const cf = await cashflowKontraktual(id, '2026-01-31', 12_000_000 - 240_000);
    expect(cf[1].hari).toBe(28);
    const rate = (await bacaRate(id)) as number;
    expect(Math.abs(npv(rate, cf))).toBeLessThanOrEqual(0.5);
  });

  it('7. batas TAHUN: pinjaman melintasi 31 Des tetap benar', async () => {
    const id = await cairkan({ tanggal: '2026-11-15', tenor: 6 });
    const cf = await cashflowKontraktual(id, '2026-11-15', 12_000_000 - 240_000);
    // Hari harus MONOTON NAIK melewati pergantian tahun.
    for (let i = 1; i < cf.length; i += 1) {
      expect(cf[i].hari).toBeGreaterThan(cf[i - 1].hari);
    }
    const rate = (await bacaRate(id)) as number;
    expect(Math.abs(npv(rate, cf))).toBeLessThanOrEqual(0.5);
  });

  it('9. interval TIDAK seragam tetap dipakai apa adanya', async () => {
    const id = await cairkan({ tanggal: '2026-01-31', tenor: 6 });
    const cf = await cashflowKontraktual(id, '2026-01-31', 12_000_000 - 240_000);
    const selisih = cf.slice(1).map((c, i) => (i === 0 ? c.hari : c.hari - cf[i].hari));
    // Jarak antar angsuran berbeda-beda (28/31/30...) — bukan 30 seragam.
    expect(new Set(selisih).size).toBeGreaterThan(1);
  });
});

// ===========================================================================
// TENOR — pendek & panjang
// ===========================================================================

describe('§AA TENOR', () => {
  it('10. tenor sangat pendek (1 periode) tetap menghasilkan akar', async () => {
    const id = await cairkan({ tanggal: '2026-03-02', tenor: 1 });
    const rate = (await bacaRate(id)) as number;
    expect(Number.isFinite(rate)).toBe(true);
    const cf = await cashflowKontraktual(id, '2026-03-02', 12_000_000 - 240_000);
    expect(Math.abs(npv(rate, cf))).toBeLessThanOrEqual(0.5);
  });

  it('11. tenor PANJANG 60 bulan: konvergen, finite, NPV = 0', async () => {
    const id = await cairkan({ tanggal: '2026-03-02', tenor: 60, jumlah: 60_000_000, biayaAdminNilai: 1_200_000 });
    const rate = (await bacaRate(id)) as number;
    expect(Number.isFinite(rate)).toBe(true);
    expect(Number.isNaN(rate)).toBe(false);
    expect(rate).toBeGreaterThan(0);

    const cf = await cashflowKontraktual(id, '2026-03-02', 60_000_000 - 1_200_000);
    expect(cf).toHaveLength(61);
    expect(Math.abs(npv(rate, cf))).toBeLessThanOrEqual(0.5);
  });
});

// ===========================================================================
// PERSISTENCE & DETERMINISM
// ===========================================================================

describe('§AA PERSISTENCE & DETERMINISM', () => {
  it('25. rate dibaca kembali dari database identik dengan saat disimpan', async () => {
    const id = await cairkan({ tanggal: '2026-03-02' });
    const saatSimpan = (await bacaRate(id)) as number;

    const tersimpan = await getEirTersimpan(testDb as never, id);
    expect(tersimpan).not.toBeNull();
    expect(tersimpan?.rate).toBe(saatSimpan);
  });

  it('26. "restart" tidak menghitung ulang — rate tetap bit-per-bit sama', async () => {
    const id = await cairkan({ tanggal: '2026-03-02' });
    const awal = (await bacaRate(id)) as number;

    for (let i = 0; i < 5; i += 1) {
      const lagi = await getEirTersimpan(testDb as never, id);
      expect(lagi?.rate).toBe(awal);
    }
    // Nilainya berasal dari kolom, bukan dari solver yang dijalankan ulang.
    expect(await bacaRate(id)).toBe(awal);
  });

  it('20. cashflow IDENTIK menghasilkan EIR identik pada 10 pemanggilan', async () => {
    const cf: EirCashFlow[] = [
      { hari: 0, jumlah: -11_760_000 },
      { hari: 31, jumlah: 1_120_000 },
      { hari: 59, jumlah: 1_120_000 },
      { hari: 90, jumlah: 1_120_000 },
      { hari: 120, jumlah: 1_120_000 },
      { hari: 151, jumlah: 1_120_000 },
      { hari: 181, jumlah: 1_120_000 },
      { hari: 212, jumlah: 1_120_000 },
      { hari: 243, jumlah: 1_120_000 },
      { hari: 273, jumlah: 1_120_000 },
      { hari: 304, jumlah: 1_120_000 },
      { hari: 334, jumlah: 1_120_000 },
      { hari: 365, jumlah: 1_120_000 },
    ];
    const hasil = Array.from({ length: 10 }, () => solveEffectiveInterestRate(cf).rateTahunan);
    for (const r of hasil) expect(r).toBe(hasil[0]);
    expect(Math.abs(npv(hasil[0], cf))).toBeLessThanOrEqual(0.5);
  });

  it('dua pinjaman dengan parameter sama menghasilkan rate sama', async () => {
    const a = await cairkan({ tanggal: '2026-03-02' });
    const b = await cairkan({ tanggal: '2026-03-02' });
    expect(await bacaRate(b)).toBe(await bacaRate(a));
  });
});

// ===========================================================================
// NUMERICAL — tanpa fallback palsu
// ===========================================================================

describe('§AA NUMERICAL — tidak ada fallback palsu', () => {
  it('29. cashflow tanpa akar melempar EirSolverError, bukan mengembalikan rate', async () => {
    // Cashflow LOLOS validasi (ada arus keluar & masuk, terurut), tetapi
    // akarnya berada di bawah rateMin = -0.99: pengembalian 1 rupiah
    // atas pencairan 1 juta menuntut r kira-kira -0,999999.
    const cf: EirCashFlow[] = [
      { hari: 0, jumlah: -1_000_000 },
      { hari: 365, jumlah: 1 },
    ];
    let dilempar: unknown = null;
    try {
      solveEffectiveInterestRate(cf);
    } catch (e) {
      dilempar = e;
    }
    expect(dilempar).toBeInstanceOf(EirSolverError);
    expect((dilempar as EirSolverError).code).toBe('EIR_NO_ROOT_IN_SEARCH_DOMAIN');
  });

  it('30. rate ekstrem yang SAH tetap ditemukan, bukan dipangkas', async () => {
    // Pinjaman 10 hari: annualized rate memang sangat besar.
    const cf: EirCashFlow[] = [
      { hari: 0, jumlah: -1_000_000 },
      { hari: 10, jumlah: 1_084_340 },
    ];
    const r = solveEffectiveInterestRate(cf).rateTahunan;
    expect(r).toBeGreaterThan(10);
    expect(Number.isFinite(r)).toBe(true);
    expect(Math.abs(npv(r, cf))).toBeLessThanOrEqual(0.5);
  });

  it('rate NEGATIF yang sah tidak ditolak', async () => {
    const cf: EirCashFlow[] = [
      { hari: 0, jumlah: -1_000_000 },
      { hari: 365, jumlah: 950_000 },
    ];
    const r = solveEffectiveInterestRate(cf).rateTahunan;
    expect(r).toBeLessThan(0);
    expect(r).toBeGreaterThan(-1);
    expect(Math.abs(npv(r, cf))).toBeLessThanOrEqual(0.5);
  });

  it('service TIDAK menyimpan rate apa pun ketika solver gagal', async () => {
    // Bukti bahwa kegagalan merambat menjadi rollback, bukan menjadi
    // rate karangan. Jadwal dihapus sehingga cashflow tidak terbentuk.
    const p = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-03-02',
      jumlahPinjaman: 12_000_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 12,
      biayaAdminTipe: 'NOMINAL',
      biayaAdminNilai: 240_000,
      biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
      dendaAktif: false,
      createdBy: 'user-1',
    } as never);
    const id = (p as { id: string }).id;
    await testDb.runAsync(`DELETE FROM angsuran_jadwal WHERE pinjaman_id = ?`, id);

    await expect(
      cairkanPinjaman({
        pinjamanId: id,
        sumberDana: 'KAS',
        approvedBy: 'user-1',
        tanggalPencairan: '2026-03-02',
      } as never)
    ).rejects.toThrow();

    expect(await bacaRate(id)).toBeNull();
    const st = await statusEir(id);
    expect(st).not.toBe('MEASURED');
  });
});

// ===========================================================================
// ACCOUNTING INVARIANT pada saat pencairan ber-EIR
// ===========================================================================

describe('§AA ACCOUNTING — invarian saat initial recognition', () => {
  it('jurnal pencairan BALANCED dan fee integral masuk 2-1300', async () => {
    const id = await cairkan({ tanggal: '2026-03-02' });

    const perJurnal = await testDb.getAllAsync<{ journal_id: string; d: number; k: number }>(
      `SELECT je.journal_id, SUM(je.debit) d, SUM(je.kredit) k
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE j.sumber_transaksi = 'PENCAIRAN_PINJAMAN'
        GROUP BY je.journal_id`
    );
    expect(perJurnal.length).toBeGreaterThan(0);
    for (const p of perJurnal) expect(p.d).toBe(p.k);

    const dimuka = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(je.kredit - je.debit),0) s
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
      ACC.pendapatanDimuka
    );
    expect((dimuka?.s ?? 0)).toBeGreaterThan(0);
    expect(await statusEir(id)).toBe('MEASURED');
  });

  it('EIR tersimpan benar-benar AKAR dari arus kas kontraktual', async () => {
    const id = await cairkan({ tanggal: '2026-03-02' });
    const rate = (await bacaRate(id)) as number;
    const cf = await cashflowKontraktual(id, '2026-03-02', 12_000_000 - 240_000);

    // Verifikasi INDEPENDEN: NPV dihitung ulang di test, bukan dibaca
    // dari hasil solver.
    expect(Math.abs(npv(rate, cf))).toBeLessThanOrEqual(0.5);
  });

  it('remaining_term tersimpan = jumlah angsuran kontraktual', async () => {
    const id = await cairkan({ tanggal: '2026-03-02', tenor: 12 });
    const row = await testDb.getFirstAsync<{ remaining_term_bulan: number }>(
      `SELECT remaining_term_bulan FROM pinjaman_akuntansi_jasa
        WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
      id
    );
    const jml = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM angsuran_jadwal WHERE pinjaman_id = ?`,
      id
    );
    expect(row?.remaining_term_bulan).toBe(jml?.n);
  });
});
