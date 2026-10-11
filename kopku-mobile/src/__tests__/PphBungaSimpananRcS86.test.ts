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

import { newId } from '@/utils/id';
import { reverseJournal, createJournal } from '@/accounting/AccountingEngine';
import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  prosesAkrualBungaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  cairkanSimpananBerjangka,
  prosesTransferBungaKeSukarela,
  getStatusTransferBunga,
} from '@/services/SimpananBerjangkaLifecycleService';
import { hitungPphBungaSimpanan, hitungPphBungaSimpananPeriode, KODE_UTANG_PPH_BUNGA_SIMPANAN } from '@/config/pajakPolicy';
import { listBuktiPotongPphBungaSimpanan } from '@/services/PphPotongService';

/**
 * RC-S86 — PPh Pasal 4(2) atas Bunga Simpanan (engine pemotongan otomatis).
 *
 * Bagian A: fungsi murni di pajakPolicy.ts (tanpa DB).
 * Bagian B: integrasi penuh di atas SQLite sungguhan, skema produksi,
 * jurnal dibuat AccountingEngine asli — sama seperti suite §B/pencairan
 * yang sudah ada (TransferBungaBerjangkaRcS53 / SimpananBerjangkaLifecycle).
 */

// ---------------------------------------------------------------------------
// Bagian A — perhitungan murni
// ---------------------------------------------------------------------------

describe('RC-S86 §A — hitungPphBungaSimpanan (murni)', () => {
  test('bunga Rp240.000 (tepat batas) -> PPh Rp0', () => {
    expect(hitungPphBungaSimpanan(240_000)).toBe(0);
  });
  test('bunga Rp240.001 -> PPh Rp24.000 (10% dari bruto, dibulatkan ke bawah)', () => {
    expect(hitungPphBungaSimpanan(240_001)).toBe(24_000);
  });
  test('bunga Rp300.000 -> PPh Rp30.000', () => {
    expect(hitungPphBungaSimpanan(300_000)).toBe(30_000);
  });
  test('bunga Rp0 -> PPh Rp0', () => {
    expect(hitungPphBungaSimpanan(0)).toBe(0);
  });
  test('nilai negatif atau bukan bilangan bulat ditolak', () => {
    expect(() => hitungPphBungaSimpanan(-1)).toThrow();
    expect(() => hitungPphBungaSimpanan(1.5)).toThrow();
  });

  test('multi-bulan: Jan 250rb + Feb 150rb + Mar 100rb dibayar sekaligus -> PPh HANYA dari Januari (Rp25.000), bukan 10% x total', () => {
    const hasil = hitungPphBungaSimpananPeriode([
      { bungaPeriodeId: 'p1', nomorPeriode: 1, tanggalAkhirPeriode: '2026-01-31', bruto: 250_000 },
      { bungaPeriodeId: 'p2', nomorPeriode: 2, tanggalAkhirPeriode: '2026-02-28', bruto: 150_000 },
      { bungaPeriodeId: 'p3', nomorPeriode: 3, tanggalAkhirPeriode: '2026-03-31', bruto: 100_000 },
    ]);
    expect(hasil.perPeriode.map((p) => p.pajak)).toEqual([25_000, 0, 0]);
    expect(hasil.totalPajak).toBe(25_000);
    expect(hasil.totalPajak).not.toBe(Math.floor(500_000 * 0.1)); // BUKAN 50.000
    expect(hasil.totalBruto).toBe(500_000);
    expect(hasil.totalNetto).toBe(475_000);
    // masa pajak diambil dari BULAN periode, bukan tanggal pembayaran
    expect(hasil.perPeriode.map((p) => p.masaPajak)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

// ---------------------------------------------------------------------------
// Bagian B — integrasi (SQLite sungguhan)
// ---------------------------------------------------------------------------

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  berjangka: 'acc-2-1210',
  sukarela: 'acc-2-1200',
  utangBunga: 'acc-2-1710',
  bebanBunga: 'acc-5-1955',
  modal: 'acc-3-1000',
};

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
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
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${tt}-${role}`, tt, role, accountId);
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
  return db;
}

async function saldoAkun(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ debit: number; kredit: number }>(
    `SELECT COALESCE(SUM(debit),0) debit, COALESCE(SUM(kredit),0) kredit
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return (r?.kredit ?? 0) - (r?.debit ?? 0);
}

async function idAkunPphBungaSimpanan(): Promise<string | null> {
  const r = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, KODE_UTANG_PPH_BUNGA_SIMPANAN);
  return r?.id ?? null;
}

/**
 * Kontrak yang PER PERIODENYA melewati batas Rp240.000: 25.000.000 @ 12%
 * tenor 3 bulan -> bunga per periode = 25.000.000 x 12% / 12 = 250.000.
 * PPh per periode = 10% x 250.000 = 25.000; netto = 225.000.
 */
async function buatKontrakKenaPajak(mulai = '2026-01-15'): Promise<string> {
  const hasil = await setorSimpananBerjangka({
    anggotaId: 'anggota-A',
    nominal: 25_000_000,
    tenorBulan: 3,
    sukuBungaPerTahun: 12,
    tanggal: mulai,
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return hasil.id;
}

/** Kontrak di bawah batas (existing behaviour): 12jt @ 12% tenor 3 = 120.000/periode. */
async function buatKontrakBebasPajak(mulai = '2026-01-15'): Promise<string> {
  const hasil = await setorSimpananBerjangka({
    anggotaId: 'anggota-A',
    nominal: 12_000_000,
    tenorBulan: 3,
    sukuBungaPerTahun: 12,
    tanggal: mulai,
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return hasil.id;
}

beforeEach(async () => {
  testDb = await seedFixture();
});

describe('RC-S86 §B1 — transfer ke Sukarela DI ATAS batas (kena pajak)', () => {
  test('Dr 2-1710 bruto / Cr 2-1901 pajak / Cr 2-1200 netto; jurnal balanced', async () => {
    const id = await buatKontrakKenaPajak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const pphId = await idAkunPphBungaSimpanan();
    expect(pphId).not.toBeNull();

    expect(await saldoAkun(ACC.utangBunga)).toBe(0); // 250.000 didebit habis
    expect(await saldoAkun(pphId as string)).toBe(25_000);
    expect(await saldoAkun(ACC.sukarela)).toBe(225_000);

    const subledger = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(nominal),0) s FROM simpanan_transaksi WHERE anggota_id = 'anggota-A' AND jenis = 'SUKARELA'`
    );
    // Subledger Sukarela = NETTO, bukan bruto — itulah saldo yang benar-benar bisa dipakai anggota.
    expect(subledger?.s).toBe(225_000);
  });

  test('bukti potong tercatat: bruto 250.000, pajak 25.000, netto 225.000, masa = bulan periode', async () => {
    const id = await buatKontrakKenaPajak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(bukti).toHaveLength(1);
    expect(bukti[0]).toMatchObject({
      bruto: 250_000,
      pajak: 25_000,
      netto: 225_000,
      masaPajak: '2026-02',
      peristiwa: 'TRANSFER_SUKARELA',
      anggotaId: 'anggota-A',
      statusJurnal: 'POSTED',
    });
    expect(bukti[0].nomorBuktiPotong).toBeTruthy();
  });
});

describe('RC-S86 §B2 — transfer ke Sukarela DI BAWAH/PAS batas (bebas pajak, bukti potong tetap terbit)', () => {
  test('tidak ada baris 2-1901 di jurnal; Sukarela = bruto penuh (existing behaviour tidak berubah)', async () => {
    const id = await buatKontrakBebasPajak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    expect(await idAkunPphBungaSimpanan()).toBeNull(); // akun 2-1901 TIDAK dibuat sama sekali — tidak pernah dipakai
    expect(await saldoAkun(ACC.sukarela)).toBe(120_000);
  });

  test('bukti potong TETAP terbit walau pajak Rp0 (persyaratan bunga simpanan: 0% tetap wajib bukti potong)', async () => {
    const id = await buatKontrakBebasPajak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(bukti).toHaveLength(1);
    expect(bukti[0].pajak).toBe(0);
    expect(bukti[0].bruto).toBe(120_000);
    expect(bukti[0].nomorBuktiPotong).toBeTruthy();
  });
});

describe('RC-S86 §B3 — akrual SAJA (belum dibayar) tidak pernah kena pajak', () => {
  test('akrual tanpa transfer/pencairan -> nol bukti potong', async () => {
    const id = await buatKontrakKenaPajak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');

    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(bukti).toHaveLength(0);
    expect(await idAkunPphBungaSimpanan()).toBeNull();
  });
});

describe('RC-S86 §B4 — pencairan: hanya bunga yang BELUM dibayar/dipotong', () => {
  test('periode yang sudah ditransfer §B (dan sudah dipotong) TIDAK dipotong lagi saat pencairan', async () => {
    const id = await buatKontrakKenaPajak();
    // Periode 1 (Jan, 250.000) ditransfer & dipotong lewat §B lebih dulu.
    await prosesAkrualBungaKontrak(id, '2026-02-16', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-16', 'user-1');
    const buktiSetelahTransfer = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(buktiSetelahTransfer).toHaveLength(1);
    expect(buktiSetelahTransfer[0].pajak).toBe(25_000);

    // Jatuh tempo & cairkan — periode 2 & 3 (masing-masing 250.000) belum pernah dibayar.
    await prosesJatuhTempoSimpananBerjangka('2026-04-20', 'user-1');
    const hasil = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });

    // Total bunga kontraktual kontrak = 750.000 (3 x 250.000). Bruto yang
    // diselesaikan PENCAIRAN = 500.000 (periode 2+3) — periode 1 SUDAH selesai lewat §B.
    // RC-S128 — periode 2 & 3 dipindahkan ke Simpanan Sukarela DI DALAM
    // pencairan (bukan dibayar tunai). PPh-nya tetap 25.000 + 25.000,
    // dipotong pada pemindahan itu; kas hanya membayar pokok.
    expect(hasil.bunga).toBe(0);
    expect(hasil.bungaDipindahkanSaatPencairan).toBe(500_000);
    expect(hasil.pajakDipotong).toBe(0);
    expect(hasil.totalDibayarBersih).toBe(hasil.pokok);

    const buktiSetelahCair = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(buktiSetelahCair).toHaveLength(3); // 1 (transfer) + 2 (pencairan) — periode 1 TIDAK dobel
    const periode1Entries = buktiSetelahCair.filter((b) => b.nomorPeriode === 1);
    expect(periode1Entries).toHaveLength(1); // tidak pernah dua kali untuk periode yang sama

    const totalPajakSemua = buktiSetelahCair.reduce((s, b) => s + b.pajak, 0);
    expect(totalPajakSemua).toBe(75_000); // 25.000 x 3 periode, dihitung terpisah masing-masing
  });

  test('kontrak bebas pajak: pencairan tanpa transfer sebelumnya -> pajakDipotong 0, tidak ada baris 2-1901', async () => {
    const id = await buatKontrakBebasPajak();
    await prosesAkrualBungaKontrak(id, '2026-02-16', 'user-1');
    await prosesJatuhTempoSimpananBerjangka('2026-04-20', 'user-1');
    const hasil = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });

    expect(hasil.pajakDipotong).toBe(0);
    expect(hasil.totalDibayarBersih).toBe(hasil.total);
    expect(await idAkunPphBungaSimpanan()).toBeNull();

    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(bukti.every((b) => b.pajak === 0)).toBe(true);
    expect(bukti).toHaveLength(3); // 3 periode, masing-masing bukti potong 0% (belum pernah ditransfer §B)
  });
});

describe('RC-S86 §B5 — multi-bulan tertunggak dibayar sekaligus (uneven, sesuai contoh PP 15/2009)', () => {
  test('Jan 250rb + Feb 150rb + Mar 100rb dibayar sekaligus saat pencairan -> PPh hanya dari Januari', async () => {
    // Kontrak 10jt @ 20% tenor 3 -> total bunga kontraktual = 500.000
    // (10.000.000 x 20% x 3/12), TAPI distribusi per periodenya dibuat
    // TIDAK RATA secara sengaja (250rb/150rb/100rb) untuk menguji bahwa
    // threshold dihitung PER PERIODE, bukan hasil bagi rata otomatis.
    const { id } = await setorSimpananBerjangka({
      anggotaId: 'anggota-A',
      nominal: 10_000_000,
      tenorBulan: 3,
      sukuBungaPerTahun: 20,
      tanggal: '2026-01-15',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // Seed manual 3 periode TIDAK RATA (bypass akrual otomatis yang
    // membagi rata) — total tetap 500.000 supaya invarian
    // `bunga_terakru === hitungTotalBungaKontrak(...)` di cairkanSimpananBerjangka tetap terpenuhi.
    const now = new Date().toISOString();
    const periods = [
      { n: 1, tgl: '2026-02-15', bunga: 250_000 },
      { n: 2, tgl: '2026-03-15', bunga: 150_000 },
      { n: 3, tgl: '2026-04-15', bunga: 100_000 },
    ];
    for (const p of periods) {
      await testDb.runAsync(
        `INSERT INTO simpanan_berjangka_bunga (id, simpanan_berjangka_id, nomor_periode, tanggal_akhir_periode, bunga, journal_id, created_by, created_at)
         VALUES (?,?,?,?,?,NULL,?,?)`,
        newId(),
        id,
        p.n,
        p.tgl,
        p.bunga,
        'user-1',
        now
      );
    }
    await testDb.runAsync(`UPDATE simpanan_berjangka SET bunga_terakru = 500000, updated_at = ? WHERE id = ?`, now, id);

    await prosesJatuhTempoSimpananBerjangka('2026-05-01', 'user-1');
    const hasil = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-05-01', sumberDana: 'KAS', createdBy: 'user-1' });

    // RC-S128 — bunga dipindahkan ke Simpanan Sukarela di dalam pencairan;
    // PPh per bulan masa tetap HANYA dari Januari (lihat bukti potong).
    expect(hasil.bunga).toBe(0);
    expect(hasil.bungaDipindahkanSaatPencairan).toBe(500_000);

    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(bukti).toHaveLength(3);
    const pajakByPeriode = new Map(bukti.map((b) => [b.nomorPeriode, b.pajak]));
    expect(pajakByPeriode.get(1)).toBe(25_000);
    expect(pajakByPeriode.get(2)).toBe(0);
    expect(pajakByPeriode.get(3)).toBe(0);
  });
});

describe('RC-S86 §B6 — reversal pembayaran bunga membalik pajak & utang pajak', () => {
  test('reverseJournal atas jurnal transfer §B membalik 2-1901 & 2-1200 sekaligus; tidak pernah dipotong dua kali', async () => {
    const id = await buatKontrakKenaPajak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const pphId = (await idAkunPphBungaSimpanan()) as string;
    expect(await saldoAkun(pphId)).toBe(25_000);
    expect(await saldoAkun(ACC.sukarela)).toBe(225_000);

    const jurnal = await testDb.getFirstAsync<{ id: string }>(
      `SELECT id FROM journal WHERE sumber_transaksi = 'SIMPANAN_BERJANGKA_BUNGA_TRANSFER' AND status = 'POSTED'`
    );
    await testDb.withTransactionAsync(async () => {
      await reverseJournal(testDb as any, jurnal!.id, 'user-1', 'Uji reversal RC-S86');
    });

    // Reversal SATU jurnal membalik SELURUH baris (bunga & pajak) sekaligus — tidak ada jurnal pajak terpisah yang tertinggal.
    expect(await saldoAkun(pphId)).toBe(0);
    expect(await saldoAkun(ACC.sukarela)).toBe(0);
    expect(await saldoAkun(ACC.utangBunga)).toBe(250_000); // kembali terutang (bruto, sebelum dipindahkan)

    // Perilaku existing §B (TIDAK diubah RC-S86): jurnal reversal mewarisi
    // sumber_transaksi/sumber_id yang SAMA dan berstatus POSTED, jadi
    // `sudahDitransfer` TETAP true — periode yang sudah dibalik TIDAK
    // diproses ulang OTOMATIS (butuh transfer baru yang disengaja, bukan
    // catch-up diam-diam). Memanggil ulang karena itu TIDAK membuat
    // jurnal maupun bukti potong baru — pajak tidak pernah dipotong dua
    // kali walau dipanggil berkali-kali setelah reversal.
    const status = await getStatusTransferBunga(id, '2026-02-20');
    expect(status[0].sudahDitransfer).toBe(true);

    const hasil2 = await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    expect(hasil2.periodeDipindahkan).toEqual([]);
    expect(await saldoAkun(pphId)).toBe(0);
    expect(await saldoAkun(ACC.sukarela)).toBe(0);

    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    // Tepat 1 baris bukti potong (dari transfer yang dibalik) — panggilan
    // ulang setelah reversal TIDAK menambah baris baru.
    expect(bukti).toHaveLength(1);
    expect(bukti[0].statusJurnal).toBe('REVERSED');
    expect(bukti[0].pajak).toBe(25_000);
  });
});

describe('RC-S86 §B7 — panggilan berulang tidak pernah menghasilkan dua kewajiban PPh', () => {
  test('prosesTransferBungaKeSukarela dipanggil 3x berturut-turut untuk periode yang sama -> tetap 1 bukti potong', async () => {
    const id = await buatKontrakKenaPajak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(bukti).toHaveLength(1);

    const pphId = (await idAkunPphBungaSimpanan()) as string;
    expect(await saldoAkun(pphId)).toBe(25_000); // tidak berlipat
  });
});

describe('RC-S86 §B8 — bunga bagian SHU tidak pernah masuk engine ini', () => {
  test('jurnal SHU_DISTRIBUSI yang menyentuh Simpanan Sukarela TIDAK menghasilkan baris pajak_potong_bunga_simpanan', async () => {
    // SHU tidak lewat SimpananBerjangkaLifecycleService sama sekali — PphPotongService
    // hanya dipanggil dari §B & pencairan. Jurnal SHU dibuat langsung di sini untuk
    // membuktikan tidak ada baris pajak yang muncul akibat jurnal semacam ini.
    await testDb.withTransactionAsync(async () => {
      await createJournal(testDb as any, {
        tanggal: '2026-03-01',
        sumberTransaksi: 'SHU_DISTRIBUSI',
        deskripsi: 'Distribusi SHU ke Simpanan Sukarela (uji isolasi RC-S86)',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.modal, debit: 500_000, kredit: 0 },
          { accountId: ACC.sukarela, debit: 0, kredit: 500_000 },
        ],
      });
    });

    const bukti = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(bukti).toHaveLength(0);
    expect(await idAkunPphBungaSimpanan()).toBeNull();
  });
});
