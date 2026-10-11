import { createTestDb, TestDb } from './testDb';

/**
 * AUDIT DATE-ONLY EIR (permintaan pengguna) — mengunci invariant
 * perhitungan selisih hari di `EirAccountingService.ts`.
 *
 * KESIMPULAN AUDIT: pola
 *
 *     Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000)
 *
 * pada `bangunCashFlowKontraktual()` (arus kas EIR) dan pada
 * perhitungan `hariPeriode` (amortisasi bulanan) AMAN untuk KOPKU, dan
 * TIDAK diubah. Alasannya:
 *
 *  1. Kedua operan SELALU calendar date 'YYYY-MM-DD'. `pinjaman.tanggal`
 *     ditulis lewat date-fns `format(..., 'yyyy-MM-dd')`, dan SELURUH
 *     `angsuran_jadwal.tanggal_jatuh_tempo` juga ditulis lewat
 *     `format(tanggalAngsuran, 'yyyy-MM-dd')` (PinjamanService —
 *     ajukanPinjaman/editPinjaman/simpanJadwalAngsuranCustom). Tidak ada
 *     jalur yang menyimpan timestamp berjam ke kolom itu.
 *  2. Menurut spesifikasi ECMAScript, string date-only ISO
 *     ('YYYY-MM-DD') di-parse sebagai UTC midnight — TIDAK bergantung
 *     zona waktu runtime. (String date-TIME tanpa 'Z' yang di-parse
 *     sebagai waktu lokal; itu kasus yang berbeda dan tidak terjadi di
 *     sini.)
 *  3. UTC tidak mengenal DST, jadi selisih dua UTC-midnight SELALU
 *     kelipatan persis 86.400.000 ms. `Math.round` di sana efektif
 *     no-op, bukan penambal pembulatan.
 *
 * Karena itu TIDAK ADA off-by-one dan TIDAK ADA pergeseran jadwal EIR.
 * Test di bawah mengunci kesimpulan ini supaya tidak diam-diam rusak
 * kalau suatu saat ada yang mengganti parsing atau format penyimpanan
 * tanggal.
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

import { solveEffectiveInterestRate, EirCashFlow } from '@/accounting/EffectiveInterestRateService';
import { getEirTersimpan } from '@/services/EirAccountingService';
import { ajukanPinjaman, cairkanPinjaman, getJadwalAngsuran } from '@/services/PinjamanService';

/** Rumus PERSIS yang dipakai EirAccountingService untuk selisih hari. */
function selisihHariEir(dari: string, sampai: string): number {
  return Math.round((new Date(sampai).getTime() - new Date(dari).getTime()) / 86400000);
}

/**
 * Jalankan `fn` dengan zona waktu LOKAL yang disimulasikan (offset jam
 * terhadap UTC). Dipakai untuk membuktikan bahwa hasil perhitungan
 * date-only TIDAK berubah di WIB/WITA/WIT — offset TIDAK di-hardcode di
 * kode aplikasi, ini murni alat uji.
 */
function denganOffsetLokal<T>(offsetJam: number, fn: () => T): T {
  const RealDate = Date;
  const offsetMs = offsetJam * 3600_000;
  class FakeDate extends RealDate {
    getFullYear() {
      return new RealDate(this.getTime() + offsetMs).getUTCFullYear();
    }
    getMonth() {
      return new RealDate(this.getTime() + offsetMs).getUTCMonth();
    }
    getDate() {
      return new RealDate(this.getTime() + offsetMs).getUTCDate();
    }
    getHours() {
      return new RealDate(this.getTime() + offsetMs).getUTCHours();
    }
    getTimezoneOffset() {
      return -offsetJam * 60;
    }
  }
  (global as any).Date = FakeDate;
  try {
    return fn();
  } finally {
    (global as any).Date = RealDate;
  }
}

describe('AUDIT date-only EIR — selisih hari calendar date', () => {
  test('string date-only di-parse sebagai UTC midnight (dasar keamanan seluruh perhitungan ini)', () => {
    expect(new Date('2026-09-01').toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(new Date('2026-02-01').toISOString()).toBe('2026-02-01T00:00:00.000Z');
    // Selisihnya kelipatan PERSIS satu hari — Math.round tidak menambal apa pun.
    const deltaMs = new Date('2026-10-01').getTime() - new Date('2026-09-01').getTime();
    expect(deltaMs % 86400000).toBe(0);
  });

  test('TEST 1: 2026-09-01 -> 2026-10-01 = 30 hari (bukan 29, bukan 31)', () => {
    expect(selisihHariEir('2026-09-01', '2026-10-01')).toBe(30);
  });

  test('TEST 2: 2026-01-01 -> 2026-02-01 = 31 hari', () => {
    expect(selisihHariEir('2026-01-01', '2026-02-01')).toBe(31);
  });

  test('TEST 3: 2026-02-01 -> 2026-03-01 = 28 hari (2026 bukan tahun kabisat)', () => {
    expect(selisihHariEir('2026-02-01', '2026-03-01')).toBe(28);
    // Pembanding tahun kabisat, memastikan bukan angka 28 yang di-hardcode.
    expect(selisihHariEir('2028-02-01', '2028-03-01')).toBe(29);
  });

  test('TEST 4: batas bulan & batas tahun — tidak ada off-by-one', () => {
    expect(selisihHariEir('2026-02-28', '2026-03-01')).toBe(1);
    expect(selisihHariEir('2026-01-31', '2026-02-01')).toBe(1);
    expect(selisihHariEir('2026-04-30', '2026-05-01')).toBe(1);
    expect(selisihHariEir('2026-12-31', '2027-01-01')).toBe(1);
    expect(selisihHariEir('2026-01-01', '2027-01-01')).toBe(365);
    expect(selisihHariEir('2028-01-01', '2029-01-01')).toBe(366);
    // Tanggal yang sama -> 0, bukan -1 atau 1.
    expect(selisihHariEir('2026-09-25', '2026-09-25')).toBe(0);
  });

  test('TEST 5: hasil IDENTIK di WIB (+7), WITA (+8), dan WIT (+9)', () => {
    const kasus: [string, string, number][] = [
      ['2026-09-01', '2026-10-01', 30],
      ['2026-01-01', '2026-02-01', 31],
      ['2026-02-01', '2026-03-01', 28],
      ['2026-12-31', '2027-01-01', 1],
    ];
    for (const offset of [0, 7, 8, 9]) {
      for (const [dari, sampai, harapan] of kasus) {
        const hasil = denganOffsetLokal(offset, () => selisihHariEir(dari, sampai));
        expect(hasil).toBe(harapan);
      }
    }
  });

  test('seluruh jadwal 12 bulan menghasilkan offset hari yang persis sama dengan kalender', () => {
    // Pencairan 2026-01-01, jatuh tempo bulanan 2026-02-01 dst.
    const jatuhTempo = [
      '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01',
      '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01',
    ];
    const harapan = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
    expect(jatuhTempo.map((t) => selisihHariEir('2026-01-01', t))).toEqual(harapan);
    // Menaik ketat — validasiCashFlows di solver tidak akan menolaknya.
    const hari = jatuhTempo.map((t) => selisihHariEir('2026-01-01', t));
    expect(hari.every((h, i) => i === 0 || h > hari[i - 1])).toBe(true);
  });
});

// ---- Verifikasi END-TO-END lewat service sungguhan ----

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`, transactionType, role, accountId
  );
}

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanJasa: 'acc-pendapatan-jasa',
  modal: 'acc-modal',
};
const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-now', new Date().getFullYear(), `${new Date().getFullYear()}-01-01`, `${new Date().getFullYear() + 2}-12-31`
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'A001', '1234567890123456', 'Budi', '2020-01-01', now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-now','MODAL_AWAL','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sp-fixture',?,'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID, now
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sw-fixture',?,'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID, now
  );
}

describe('AUDIT date-only EIR — verifikasi end-to-end lewat inisiasiEirPinjaman()', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('rate EIR yang DISIMPAN service identik dengan rate hasil solver atas offset hari kalender yang dihitung manual', async () => {
    // cairkanPinjaman memakai tanggal hari ini sebagai tanggal
    // pencairan, jadi jadwal dibangun relatif hari ini supaya arus kas
    // valid — TIDAK mengubah service apa pun.
    const hariIni = new Date();
    const tanggalPencairan = `${hariIni.getFullYear()}-${String(hariIni.getMonth() + 1).padStart(2, '0')}-${String(hariIni.getDate()).padStart(2, '0')}`;

    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: tanggalPencairan,
      jumlahPinjaman: 1_200_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'NOMINAL',
      biayaAdminNilai: 12_000,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    const tersimpan = await getEirTersimpan(testDb as any, id);
    expect(tersimpan).toBeTruthy();

    // Bangun ULANG arus kas secara manual dari calendar date, memakai
    // rumus selisih hari yang sama, lalu selesaikan dengan solver yang
    // sama. Kalau service salah hitung hari, rate-nya akan berbeda.
    const jadwal = await getJadwalAngsuran(id);
    const cashflows: EirCashFlow[] = [{ hari: 0, jumlah: -(1_200_000 - 12_000) }];
    for (const j of jadwal) {
      cashflows.push({
        hari: selisihHariEir(tanggalPencairan, j.tanggalJatuhTempo),
        jumlah: j.pokok + j.jasa,
      });
    }
    const manual = solveEffectiveInterestRate(cashflows);

    expect(tersimpan!.rate).toBeCloseTo(manual.rateTahunan, 10);

    // Offset hari pertama memang selisih kalender sesungguhnya, bukan
    // asumsi interval seragam 30 hari.
    const hariAngsuranPertama = selisihHariEir(tanggalPencairan, jadwal[0].tanggalJatuhTempo);
    expect(hariAngsuranPertama).toBeGreaterThanOrEqual(28);
    expect(hariAngsuranPertama).toBeLessThanOrEqual(31);
  });

  test('seluruh tanggal_jatuh_tempo tersimpan sebagai calendar date murni YYYY-MM-DD (prasyarat keamanan audit ini)', async () => {
    const hariIni = new Date();
    const tanggalPencairan = `${hariIni.getFullYear()}-${String(hariIni.getMonth() + 1).padStart(2, '0')}-${String(hariIni.getDate()).padStart(2, '0')}`;
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: tanggalPencairan,
      jumlahPinjaman: 1_200_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });

    const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string }>(
      `SELECT tanggal_jatuh_tempo FROM angsuran_jadwal WHERE pinjaman_id = ?`,
      id
    );
    expect(rows.length).toBe(12);
    for (const r of rows) {
      expect(r.tanggal_jatuh_tempo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const pinjaman = await testDb.getFirstAsync<{ tanggal: string }>(`SELECT tanggal FROM pinjaman WHERE id = ?`, id);
    expect(pinjaman!.tanggal).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
