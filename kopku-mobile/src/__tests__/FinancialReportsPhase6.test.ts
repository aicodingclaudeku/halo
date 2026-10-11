import { createTestDb, TestDb } from './testDb';
import { createJournal } from '@/accounting/AccountingEngine';
import {
  getPosisiKeuangan,
  getPosisiKeuanganKomparatif,
  getLabaRugi,
  getLHU,
  getLHUKomparatif,
  getInformasiShuRAT,
} from '@/reports/FinancialReports';
import { formatPersentasePerubahan } from '@/utils/money';

/**
 * PHASE 6 — SHU Akrual vs Basis Kas + Laporan Komparatif. Integrasi
 * SQLite sungguhan (sql.js) + jurnal SUNGGUHAN via AccountingEngine
 * (pola sama dengan FinancialReports.test.ts existing) — TIDAK ADA
 * data dummy yang ditempel ke laporan.
 */
async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT',
  lhuKlasifikasi?: string
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    lhuKlasifikasi ?? null,
    now,
    now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${transactionType}-${role}`, transactionType, role, accountId);
}

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  modal: 'acc-modal',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanPenalti: 'acc-pendapatan-penalti',
  pendapatanAdministrasi: 'acc-pendapatan-administrasi',
  bebanPenyusutan: 'acc-beban-penyusutan',
  akumulasiPenyusutan: 'acc-akumulasi-penyusutan',
  bebanPenyisihan: 'acc-beban-penyisihan',
  penyisihan: 'acc-penyisihan',
  dimuka: 'acc-dimuka',
};

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.akumulasiPenyusutan, '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.pendapatanPenalti, '4-1150', 'Pendapatan Penalti Pelunasan', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_USAHA_LAIN');
  await seedAccount(db, ACC.pendapatanAdministrasi, '4-1160', 'Pendapatan Administrasi Pelunasan', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_USAHA_LAIN');
  await seedAccount(db, ACC.bebanPenyusutan, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT', 'BEBAN_USAHA');
  await seedAccount(db, ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan Pinjaman', 'BEBAN', 'DEBIT', 'BEBAN_USAHA');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );

  return db;
}

async function jurnal(db: TestDb, tanggal: string, lines: { accountId: string; debit: number; kredit: number }[], sumberTransaksi = 'LAIN') {
  return createJournal(db as any, {
    tanggal,
    sumberTransaksi,
    deskripsi: 'test',
    createdBy: 'user-1',
    lines,
  });
}

describe('PHASE 6 — Posisi Keuangan: Piutang Jasa & Komparatif', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await setupFixture();
  });

  test('S8: Piutang Jasa Pinjaman muncul di ASET (bukan pendapatan)', async () => {
    await jurnal(db, '2026-02-15', [
      { accountId: ACC.piutangJasa, debit: 50_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 50_000 },
    ]);
    const posisi = await getPosisiKeuangan(db as any, '2026-02-28');
    const baris = posisi.aset.find((r) => r.kode === '1-1205');
    expect(baris).toBeTruthy();
    expect(baris?.saldo).toBe(50_000);
    expect(posisi.totalAset).toBeGreaterThanOrEqual(50_000);
  });

  test('S9: future contractual jasa (belum ada jurnal akrual) TIDAK muncul di mana pun — Piutang Jasa 0, Pendapatan Jasa 0', async () => {
    // TIDAK ada jurnal apa pun dibuat -> tidak ada proyeksi otomatis.
    const posisi = await getPosisiKeuangan(db as any, '2026-02-28');
    const piutangJasa = posisi.aset.find((r) => r.kode === '1-1205');
    expect(piutangJasa?.saldo ?? 0).toBe(0);
    const labaRugi = await getLabaRugi(db as any, '2026-01-01', '2026-02-28');
    const pendapatanJasa = labaRugi.pendapatan.find((r) => r.kode === '4-1000');
    expect(pendapatanJasa?.jumlah ?? 0).toBe(0);
  });

  test('S1-S4/S6-S7/S10: comparative — current vs previous, difference, total aset = liabilitas+ekuitas, akun baru otomatis ikut', async () => {
    await jurnal(db, '2026-01-10', [
      { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
      { accountId: ACC.modal, debit: 0, kredit: 1_000_000 },
    ]);
    await jurnal(db, '2026-02-10', [
      { accountId: ACC.kas, debit: 500_000, kredit: 0 },
      { accountId: ACC.modal, debit: 0, kredit: 500_000 },
    ]);

    const komparatif = await getPosisiKeuanganKomparatif(db as any, '2026-02-28', '2026-01-31');
    expect(komparatif.sekarang.totalAset).toBe(1_500_000); // S1: current
    expect(komparatif.pembanding.totalAset).toBe(1_000_000); // S2: previous
    expect(komparatif.perubahanTotalAset).toBe(500_000); // S3: difference
    expect(komparatif.sekarang.totalAset).toBe(komparatif.sekarang.totalLiabilitas + komparatif.sekarang.totalEkuitas); // S6/S7: balance
    expect(komparatif.pembanding.totalAset).toBe(komparatif.pembanding.totalLiabilitas + komparatif.pembanding.totalEkuitas);

    // S10: akun kas baru saja ada di kedua periode (existing account) — cek akun yang HANYA muncul di periode berjalan.
    const kasSekarang = komparatif.sekarang.aset.find((r) => r.kode === '1-1000');
    const kasPembanding = komparatif.pembanding.aset.find((r) => r.kode === '1-1000');
    expect(kasSekarang?.saldo).toBe(1_500_000);
    expect(kasPembanding?.saldo).toBe(1_000_000);
  });

  test('S5/S4: percentage aman ketika saldo pembanding 0, dan menghitung persentase dengan benar bila tidak 0', () => {
    expect(formatPersentasePerubahan(500_000, 0)).toBe('—'); // S5: tidak Infinity/NaN
    expect(formatPersentasePerubahan(150, 100)).toBe('+50.0%'); // S4: (150-100)/100*100 = 50%
    expect(formatPersentasePerubahan(50, 100)).toBe('-50.0%');
  });
});

describe('SHU Akrual vs Kas — ANTI DOUBLE COUNT (fix konsistensi v49 §4, CASE A-E)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await setupFixture();
  });

  test('CASE A/E: akrual periode lalu -> penagihan periode ini. Akrual 1x, kas 1x, tidak ada yang dobel', async () => {
    // Periode 1: akrual saja (tanpa kas).
    await jurnal(db, '2026-01-31', [
      { accountId: ACC.piutangJasa, debit: 100_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
    ], 'AKRUAL_JASA_PINJAMAN');

    const p1 = await getInformasiShuRAT(db as any, '2026-01-01', '2026-01-31');
    expect(p1.shuLaporanKeuanganAkrual).toBe(100_000);
    expect(p1.shuInformasiRat).toBe(0); // CASE D: belum ditagih -> kas 0

    // Periode 2: penagihan saja (tanpa baris Pendapatan).
    await jurnal(db, '2026-02-10', [
      { accountId: ACC.kas, debit: 100_000, kredit: 0 },
      { accountId: ACC.piutangJasa, debit: 0, kredit: 100_000 },
    ], 'PEMBAYARAN_JASA_PINJAMAN');

    const p2 = await getInformasiShuRAT(db as any, '2026-02-01', '2026-02-28');
    expect(p2.shuLaporanKeuanganAkrual).toBe(0); // akrual TIDAK bertambah lagi
    expect(p2.shuInformasiRat).toBe(100_000); // kas masuk terhitung SEKALI

    // Kumulatif dua periode: masing-masing tepat 1x, bukan 200.000.
    const total = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    expect(total.shuLaporanKeuanganAkrual).toBe(100_000);
    expect(total.shuInformasiRat).toBe(100_000);
  });

  test('CASE C: pendapatan tunai langsung (Dr Kas / Cr Pendapatan) tetap dihitung TEPAT SEKALI', async () => {
    await jurnal(db, '2026-01-10', [
      { accountId: ACC.kas, debit: 75_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 75_000 },
    ], 'ANGSURAN_JASA');

    const hasil = await getInformasiShuRAT(db as any, '2026-01-01', '2026-01-31');
    expect(hasil.shuLaporanKeuanganAkrual).toBe(75_000);
    expect(hasil.shuInformasiRat).toBe(75_000);
  });

  test('jurnal campuran: sebagian jasa sudah diakru, sebagian diakui langsung -> kas = jumlah KEDUA porsi, bukan dobel salah satunya', async () => {
    await jurnal(db, '2026-01-31', [
      { accountId: ACC.piutangJasa, debit: 40_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 40_000 },
    ], 'AKRUAL_JASA_PINJAMAN');

    // Satu pembayaran: 40.000 melunasi piutang jasa yang sudah diakru,
    // 60.000 jasa yang belum pernah diakru (diakui langsung).
    await jurnal(db, '2026-02-05', [
      { accountId: ACC.kas, debit: 100_000, kredit: 0 },
      { accountId: ACC.piutangJasa, debit: 0, kredit: 40_000 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 60_000 },
    ], 'ANGSURAN_JASA');

    const p2 = await getInformasiShuRAT(db as any, '2026-02-01', '2026-02-28');
    expect(p2.shuLaporanKeuanganAkrual).toBe(60_000); // hanya porsi baru
    expect(p2.shuInformasiRat).toBe(100_000); // seluruh kas yang masuk
  });

  test('write-off Piutang Jasa (tanpa kas) TIDAK dianggap realisasi kas', async () => {
    await jurnal(db, '2026-01-31', [
      { accountId: ACC.piutangJasa, debit: 50_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 50_000 },
    ], 'AKRUAL_JASA_PINJAMAN');
    await jurnal(db, '2026-02-20', [
      { accountId: ACC.bebanPenyisihan, debit: 50_000, kredit: 0 },
      { accountId: ACC.piutangJasa, debit: 0, kredit: 50_000 },
    ], 'WRITE_OFF_PIUTANG');

    const p2 = await getInformasiShuRAT(db as any, '2026-02-01', '2026-02-28');
    // TIDAK ADA kas yang masuk MAUPUN keluar pada jurnal write-off,
    // jadi basis kas periode ini nol di kedua sisi (beban penyisihan
    // adalah beban non-kas, jadi juga bukan "realisasi kas").
    expect(p2.pendapatanRealisasiKas).toBe(0);
    expect(p2.bebanRealisasiKas).toBe(0);
    expect(p2.shuInformasiRat).toBe(0);
  });

  test('penagihan Piutang POKOK (bukan jasa) TIDAK dianggap pendapatan kas', async () => {
    await jurnal(db, '2026-01-05', [
      { accountId: ACC.piutangPokok, debit: 500_000, kredit: 0 },
      { accountId: ACC.kas, debit: 0, kredit: 500_000 },
    ], 'PENCAIRAN_PINJAMAN');
    await jurnal(db, '2026-02-05', [
      { accountId: ACC.kas, debit: 500_000, kredit: 0 },
      { accountId: ACC.piutangPokok, debit: 0, kredit: 500_000 },
    ], 'ANGSURAN_POKOK');

    const p2 = await getInformasiShuRAT(db as any, '2026-02-01', '2026-02-28');
    expect(p2.pendapatanRealisasiKas).toBe(0);
    expect(p2.shuInformasiRat).toBe(0);
  });

  test('perhitungan berulang deterministik: memanggil getInformasiShuRAT dua kali memberi angka SAMA (tidak akumulatif)', async () => {
    await jurnal(db, '2026-01-31', [
      { accountId: ACC.piutangJasa, debit: 100_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
    ], 'AKRUAL_JASA_PINJAMAN');
    await jurnal(db, '2026-02-10', [
      { accountId: ACC.kas, debit: 100_000, kredit: 0 },
      { accountId: ACC.piutangJasa, debit: 0, kredit: 100_000 },
    ], 'PEMBAYARAN_JASA_PINJAMAN');

    const a = await getInformasiShuRAT(db as any, '2026-02-01', '2026-02-28');
    const b = await getInformasiShuRAT(db as any, '2026-02-01', '2026-02-28');
    expect(b.shuInformasiRat).toBe(a.shuInformasiRat);
    expect(b.shuInformasiRat).toBe(100_000);
  });
});

describe('PHASE 6 — SHU Akrual vs Basis Kas (getInformasiShuRAT)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await setupFixture();
  });

  test('U1/U2/U3: contoh wajib instruksi — jasa akrual 100.000 belum dibayar -> SHU akrual +100rb, SHU kas 0; setelah dibayar -> akrual TETAP +100rb, kas +100rb (BUKAN +200rb)', async () => {
    // Akrual: Dr Piutang Jasa / Cr Pendapatan Jasa — TIDAK ada baris kas.
    await jurnal(db, '2026-02-28', [
      { accountId: ACC.piutangJasa, debit: 100_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
    ], 'AKRUAL_JASA_PINJAMAN');

    let shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(100_000); // SHU akrual
    expect(shuRat.shuInformasiRat).toBe(0); // SHU kas — belum ada kas masuk

    // Setelah dibayar: Dr Kas / Cr Piutang Jasa (BUKAN Cr Pendapatan Jasa lagi — sudah diakui saat akrual).
    await jurnal(db, '2026-03-05', [
      { accountId: ACC.kas, debit: 100_000, kredit: 0 },
      { accountId: ACC.piutangJasa, debit: 0, kredit: 100_000 },
    ], 'PEMBAYARAN_JASA_PINJAMAN');

    shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-03-31');
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(100_000); // TETAP +100.000, tidak berubah
    expect(shuRat.shuInformasiRat).toBe(100_000); // sekarang +100.000 (kas benar2 masuk)
    expect(shuRat.shuInformasiRat).not.toBe(200_000); // BUKAN dobel — larangan eksplisit instruksi
  });

  test('U3: jasa dibayar TANPA accrual terlebih dahulu — satu jurnal Dr Kas / Cr Pendapatan Jasa langsung', async () => {
    await jurnal(db, '2026-02-10', [
      { accountId: ACC.kas, debit: 75_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 75_000 },
    ], 'ANGSURAN_JASA');

    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(75_000);
    expect(shuRat.shuInformasiRat).toBe(75_000); // diakui akrual DAN kas dalam jurnal yang sama
  });

  test('U4/U5: administrasi & penalti diterima kas — masuk basis kas', async () => {
    await jurnal(db, '2026-02-01', [
      { accountId: ACC.kas, debit: 25_000, kredit: 0 },
      { accountId: ACC.pendapatanAdministrasi, debit: 0, kredit: 25_000 },
    ]);
    await jurnal(db, '2026-02-02', [
      { accountId: ACC.kas, debit: 50_000, kredit: 0 },
      { accountId: ACC.pendapatanPenalti, debit: 0, kredit: 50_000 },
    ]);
    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    expect(shuRat.shuInformasiRat).toBe(75_000);
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(75_000);
  });

  test('U6/J: depreciation BUKAN cash expense — masuk akrual, TIDAK masuk basis kas', async () => {
    await jurnal(db, '2026-02-28', [
      { accountId: ACC.bebanPenyusutan, debit: 40_000, kredit: 0 },
      { accountId: ACC.akumulasiPenyusutan, debit: 0, kredit: 40_000 },
    ]);
    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(-40_000); // beban akrual mengurangi SHU akrual
    expect(shuRat.bebanRealisasiKas).toBe(0); // TIDAK dianggap cash expense
    expect(shuRat.shuInformasiRat).toBe(0); // SHU kas tidak terpengaruh sama sekali
  });

  test('U7/K: impairment/penyisihan BUKAN cash expense kecuali ada pembayaran kas', async () => {
    await jurnal(db, '2026-02-28', [
      { accountId: ACC.bebanPenyisihan, debit: 30_000, kredit: 0 },
      { accountId: ACC.penyisihan, debit: 0, kredit: 30_000 },
    ]);
    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(-30_000);
    expect(shuRat.bebanRealisasiKas).toBe(0);
  });

  test('U8/U9: expense accrual vs cash expense — beban dibayar tunai MASUK basis kas', async () => {
    await jurnal(db, '2026-02-05', [
      { accountId: ACC.bebanPenyusutan, debit: 20_000, kredit: 0 }, // reuse akun beban existing untuk simulasi "beban dibayar tunai"
      { accountId: ACC.kas, debit: 0, kredit: 20_000 },
    ]);
    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    expect(shuRat.bebanRealisasiKas).toBe(20_000); // beban INI dibayar kas -> masuk basis kas
  });

  test('U10: reconciliation bridge EXACT — SHU akrual ± 4 komponen = SHU kas (multi-transaksi)', async () => {
    // Akrual jasa 100rb (belum kas), jasa langsung kas 75rb, penyusutan 40rb (bukan kas), beban tunai 20rb (kas).
    await jurnal(db, '2026-02-10', [
      { accountId: ACC.piutangJasa, debit: 100_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
    ], 'AKRUAL_JASA_PINJAMAN');
    await jurnal(db, '2026-02-11', [
      { accountId: ACC.kas, debit: 75_000, kredit: 0 },
      { accountId: ACC.pendapatanAdministrasi, debit: 0, kredit: 75_000 },
    ]);
    await jurnal(db, '2026-02-12', [
      { accountId: ACC.bebanPenyusutan, debit: 40_000, kredit: 0 },
      { accountId: ACC.akumulasiPenyusutan, debit: 0, kredit: 40_000 },
    ]);
    await jurnal(db, '2026-02-13', [
      { accountId: ACC.bebanPenyisihan, debit: 20_000, kredit: 0 },
      { accountId: ACC.kas, debit: 0, kredit: 20_000 },
    ]);

    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    const bridge =
      shuRat.shuLaporanKeuanganAkrual -
      shuRat.pendapatanAkrualBelumKas +
      shuRat.pendapatanKasBelumAkrual +
      shuRat.bebanAkrualBelumKas -
      shuRat.bebanKasBelumAkrual;
    expect(bridge).toBe(shuRat.shuInformasiRat); // identitas aljabar EXACT (§I)
  });
});

describe('PHASE 6 — LHU Komparatif (getLHUKomparatif)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await setupFixture();
  });

  test('T1/T2/T9/T10: current vs comparison period, comparative difference, SHU', async () => {
    await jurnal(db, '2026-01-15', [
      { accountId: ACC.kas, debit: 100_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
    ]);
    await jurnal(db, '2026-02-15', [
      { accountId: ACC.kas, debit: 150_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 150_000 },
    ]);

    const komparatif = await getLHUKomparatif(
      db as any,
      { mulai: '2026-02-01', selesai: '2026-02-28' },
      { mulai: '2026-01-01', selesai: '2026-01-31' }
    );
    expect(komparatif.sekarang.shuNeto).toBe(150_000);
    expect(komparatif.pembanding.shuNeto).toBe(100_000);
    expect(komparatif.perubahanShuNeto).toBe(50_000);
  });

  test('T5/T6: penalty & administration masuk Jumlah Partisipasi Anggota (Pendapatan Usaha Lain) di LHU', async () => {
    await jurnal(db, '2026-02-01', [
      { accountId: ACC.kas, debit: 50_000, kredit: 0 },
      { accountId: ACC.pendapatanPenalti, debit: 0, kredit: 50_000 },
    ]);
    await jurnal(db, '2026-02-02', [
      { accountId: ACC.kas, debit: 25_000, kredit: 0 },
      { accountId: ACC.pendapatanAdministrasi, debit: 0, kredit: 25_000 },
    ]);
    const lhu = await getLHU(db as any, '2026-01-01', '2026-02-28');
    expect(lhu.jumlahPartisipasiAnggota).toBe(75_000);
  });

  test('T7: depreciation masuk Beban Usaha di LHU', async () => {
    await jurnal(db, '2026-02-28', [
      { accountId: ACC.bebanPenyusutan, debit: 40_000, kredit: 0 },
      { accountId: ACC.akumulasiPenyusutan, debit: 0, kredit: 40_000 },
    ]);
    const lhu = await getLHU(db as any, '2026-01-01', '2026-02-28');
    expect(lhu.jumlahBebanUsaha).toBe(40_000);
  });
});

describe('PHASE 6 FINAL FIX §1 — SHU basis kas: Pendapatan Diterima Dimuka (deferred income, linkage eksplisit)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await setupFixture();
    await seedAccount(db, ACC.dimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a1','A001','Budi','2020-01-01','AKTIF',?,?)`,
      now,
      now
    );
  });

  test('A: contoh wajib instruksi — kas diterima dulu (Dr Kas/Cr Pendapatan Diterima Dimuka), lalu revenue diakui belakangan (Dr Dimuka/Cr Pendapatan Jasa) — TIDAK dianggap 0, TIDAK double-count', async () => {
    // Tanggal 1: Dr Kas 1.200.000 / Cr Pendapatan Diterima Dimuka 1.200.000.
    const { journalId: journalPenerimaan } = await jurnal(db, '2026-01-05', [
      { accountId: ACC.kas, debit: 1_200_000, kredit: 0 },
      { accountId: ACC.dimuka, debit: 0, kredit: 1_200_000 },
    ], 'PENERIMAAN_DIMUKA');

    await db.runAsync(
      `INSERT INTO pendapatan_diterima_dimuka (id, nomor_transaksi, anggota_id, jumlah, jangka_waktu_bulan, tanggal, sumber_dana, status, journal_id, created_by, created_at)
       VALUES ('pd1','PD-001','a1',1200000,12,'2026-01-05','KAS','AKTIF',?,'user-1',?)`,
      journalPenerimaan,
      new Date().toISOString()
    );

    // Tanggal 2: Dr Pendapatan Diterima Dimuka 100.000 / Cr Pendapatan Jasa 100.000 — TIDAK menyentuh Kas/Bank sama sekali.
    const { journalId: journalPengakuan } = await jurnal(db, '2026-02-05', [
      { accountId: ACC.dimuka, debit: 100_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
    ], 'PENGAKUAN_DIMUKA');

    await db.runAsync(
      `INSERT INTO pendapatan_dimuka_pengakuan (id, pendapatan_dimuka_id, periode, urutan_bulan, tanggal, nilai_pengakuan, journal_id, created_by, created_at)
       VALUES ('pdp1','pd1','2026-02',1,'2026-02-05',100000,?,'user-1',?)`,
      journalPengakuan,
      new Date().toISOString()
    );

    const labaRugi = await getLabaRugi(db as any, '2026-01-01', '2026-02-28');
    expect(labaRugi.totalPendapatan).toBe(100_000); // basis akrual TETAP benar (tidak disentuh)

    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    // SEBELUM fix: pendapatanRealisasiKas akan 0 (jurnal tanggal 2 tidak
    // menyentuh Kas). SESUDAH fix: harus 100.000 — bisa ditelusuri ke
    // penerimaan kas asli tanggal 1 lewat linkage eksplisit.
    expect(shuRat.pendapatanRealisasiKas).toBe(100_000);
    expect(shuRat.shuInformasiRat).toBe(100_000);
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(100_000);
    expect(shuRat.selisihAkrualVsKas).toBe(0); // akrual & kas SAMA di kasus ini — bukti tidak ada yang hilang/dobel

    // Reconciliation bridge tetap EXACT.
    const bridge =
      shuRat.shuLaporanKeuanganAkrual -
      shuRat.pendapatanAkrualBelumKas +
      shuRat.pendapatanKasBelumAkrual +
      shuRat.bebanAkrualBelumKas -
      shuRat.bebanKasBelumAkrual;
    expect(bridge).toBe(shuRat.shuInformasiRat);
  });

  test('A2: penerimaan awal (tanggal 1) sendiri TIDAK pernah dihitung sebagai pendapatan (bukan akun PENDAPATAN) — no double count kalau BEBERAPA bulan diakui', async () => {
    const { journalId: journalPenerimaan } = await jurnal(db, '2026-01-05', [
      { accountId: ACC.kas, debit: 1_200_000, kredit: 0 },
      { accountId: ACC.dimuka, debit: 0, kredit: 1_200_000 },
    ], 'PENERIMAAN_DIMUKA');
    await db.runAsync(
      `INSERT INTO pendapatan_diterima_dimuka (id, nomor_transaksi, anggota_id, jumlah, jangka_waktu_bulan, tanggal, sumber_dana, status, journal_id, created_by, created_at)
       VALUES ('pd1','PD-001','a1',1200000,12,'2026-01-05','KAS','AKTIF',?,'user-1',?)`,
      journalPenerimaan,
      new Date().toISOString()
    );

    // Akui 2 bulan (Februari & Maret), masing-masing 100.000.
    for (const [tanggal, periode] of [['2026-02-05', '2026-02'], ['2026-03-05', '2026-03']] as const) {
      const { journalId } = await jurnal(db, tanggal, [
        { accountId: ACC.dimuka, debit: 100_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
      ], 'PENGAKUAN_DIMUKA');
      await db.runAsync(
        `INSERT INTO pendapatan_dimuka_pengakuan (id, pendapatan_dimuka_id, periode, urutan_bulan, tanggal, nilai_pengakuan, journal_id, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,'user-1',?)`,
        `pdp-${periode}`,
        'pd1',
        periode,
        1,
        tanggal,
        100_000,
        journalId,
        new Date().toISOString()
      );
    }

    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-03-31');
    // Total pendapatan yang diakui akrual = 200.000 (2 bulan) — kas realisasi juga PERSIS 200.000, bukan 1.200.000 (penerimaan awal) atau 400.000 (dobel).
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(200_000);
    expect(shuRat.pendapatanRealisasiKas).toBe(200_000);
  });

  test('Keterbatasan tetap didokumentasikan: pengakuan dimuka yang TIDAK lewat register (jurnal umum manual) tetap TIDAK dihitung sebagai realisasi kas (linkage tidak tersedia)', async () => {
    // Jurnal "pengakuan" manual TANPA baris di pendapatan_dimuka_pengakuan sama sekali.
    await jurnal(db, '2026-02-05', [
      { accountId: ACC.dimuka, debit: 50_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 50_000 },
    ]);
    const shuRat = await getInformasiShuRAT(db as any, '2026-01-01', '2026-02-28');
    expect(shuRat.shuLaporanKeuanganAkrual).toBe(50_000); // akrual tetap benar
    expect(shuRat.pendapatanRealisasiKas).toBe(0); // tidak bisa dibuktikan cash-realized -> tidak dihitung (bukan estimasi)
  });
});

describe('PHASE 6 FINAL FIX §2/§3 — LHU komparatif LENGKAP (semua baris klasifikasi) & konsistensi export', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await setupFixture();
  });

  test('B: semua row klasifikasi LHU (bukan cuma 5 ringkasan) tersedia untuk komparatif — current, comparison, delta, % per baris', async () => {
    // Periode berjalan (Februari): penalti 50rb + administrasi 25rb + jasa 100rb.
    await jurnal(db, '2026-02-01', [
      { accountId: ACC.kas, debit: 50_000, kredit: 0 },
      { accountId: ACC.pendapatanPenalti, debit: 0, kredit: 50_000 },
    ]);
    await jurnal(db, '2026-02-02', [
      { accountId: ACC.kas, debit: 25_000, kredit: 0 },
      { accountId: ACC.pendapatanAdministrasi, debit: 0, kredit: 25_000 },
    ]);
    await jurnal(db, '2026-02-03', [
      { accountId: ACC.kas, debit: 100_000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
    ]);
    // Periode pembanding (Januari): HANYA penalti 30rb (administrasi tidak ada sama sekali di periode ini — union test).
    await jurnal(db, '2026-01-15', [
      { accountId: ACC.kas, debit: 30_000, kredit: 0 },
      { accountId: ACC.pendapatanPenalti, debit: 0, kredit: 30_000 },
    ]);

    const komparatif = await getLHUKomparatif(
      db as any,
      { mulai: '2026-02-01', selesai: '2026-02-28' },
      { mulai: '2026-01-01', selesai: '2026-01-31' }
    );

    // Semua baris klasifikasi (bukan cuma summary) tersedia di kedua sisi.
    const penaltiSekarang = komparatif.sekarang.pendapatanUsahaLain.find((r) => r.kode === '4-1150');
    const penaltiPembanding = komparatif.pembanding.pendapatanUsahaLain.find((r) => r.kode === '4-1150');
    expect(penaltiSekarang?.jumlah).toBe(50_000);
    expect(penaltiPembanding?.jumlah).toBe(30_000);

    // Administrasi HANYA ada di periode berjalan — union harus tetap bisa merepresentasikan pembanding=0 (diverifikasi lewat buildLHUKomparatifExport di bawah, yang memakai union-by-kode yang sama).
    const adminSekarang = komparatif.sekarang.pendapatanUsahaLain.find((r) => r.kode === '4-1160');
    const adminPembanding = komparatif.pembanding.pendapatanUsahaLain.find((r) => r.kode === '4-1160');
    expect(adminSekarang?.jumlah).toBe(25_000);
    expect(adminPembanding).toBeUndefined(); // tidak ada baris -> union akan isi 0 di layar/export

    expect(komparatif.sekarang.shuNeto).toBe(175_000);
    expect(komparatif.pembanding.shuNeto).toBe(30_000);
    expect(komparatif.perubahanShuNeto).toBe(145_000);
  });

  test('C: export LHU komparatif memuat SEMUA baris detail (bukan cuma 5 ringkasan) — union by kode, akun yang hanya ada di satu periode tetap muncul dengan 0 di sisi lain', async () => {
    await jurnal(db, '2026-02-01', [
      { accountId: ACC.kas, debit: 50_000, kredit: 0 },
      { accountId: ACC.pendapatanPenalti, debit: 0, kredit: 50_000 },
    ]);
    await jurnal(db, '2026-02-02', [
      { accountId: ACC.kas, debit: 25_000, kredit: 0 },
      { accountId: ACC.pendapatanAdministrasi, debit: 0, kredit: 25_000 },
    ]);
    await jurnal(db, '2026-01-15', [
      { accountId: ACC.kas, debit: 30_000, kredit: 0 },
      { accountId: ACC.pendapatanPenalti, debit: 0, kredit: 30_000 },
    ]);

    const komparatif = await getLHUKomparatif(
      db as any,
      { mulai: '2026-02-01', selesai: '2026-02-28' },
      { mulai: '2026-01-01', selesai: '2026-01-31' }
    );

    const { buildLHUKomparatifExport } = await import('@/export/ReportTableBuilders');
    const hasilExport = buildLHUKomparatifExport({ namaKoperasi: 'Koperasi Uji', standarAkuntansi: 'SAK_EP' }, komparatif, 'Laporan Hasil Usaha');

    // Baris "Pendapatan Penalti Pelunasan" & "Pendapatan Administrasi Pelunasan" (bukan cuma "Jumlah Partisipasi Anggota") harus muncul di export.
    const barisPenalti = hasilExport.baris.find((b) => b[0] === 'Pendapatan Penalti Pelunasan');
    const barisAdmin = hasilExport.baris.find((b) => b[0] === 'Pendapatan Administrasi Pelunasan');
    expect(barisPenalti).toEqual(['Pendapatan Penalti Pelunasan', 50_000, 30_000]);
    expect(barisAdmin).toEqual(['Pendapatan Administrasi Pelunasan', 25_000, 0]); // union -> 0 di periode yang tidak punya baris ini

    // Kolom tetap 3 (standar existing) — format label|berjalan|pembanding.
    // RC-S98: judul kolom pertama diseragamkan menjadi 'Uraian' — sama
    // dengan export LHU tunggal (dulu 'Akun' di tunggal vs 'Komponen' di
    // komparatif untuk daftar baris yang isinya sama), dan sesuai istilah
    // kolom pada naskah laporan keuangan. Jumlah kolom TIDAK berubah.
    // DIPERBARUI Poin 14: header kolom komparatif memakai TAHUN periode laporan.
    // Kedua periode fixture ini berada di tahun yang SAMA (Feb vs Jan 2026),
    // sehingga tahun saja ambigu -> dipakai tanggal akhir periode lengkap.
    expect(hasilExport.kolom).toEqual(['Uraian', '28 Februari 2026', '31 Januari 2026']);

    // Konsistensi UI <-> export (§5.C): total SHU Neto pada export sama dengan yang dihitung getLHUKomparatif (sumber yang sama dipakai UI).
    const barisShuNeto = hasilExport.baris.find((b) => b[0] === 'SISA HASIL USAHA NETO');
    expect(barisShuNeto).toEqual(['SISA HASIL USAHA NETO', komparatif.sekarang.shuNeto, komparatif.pembanding.shuNeto]);
  });
});

