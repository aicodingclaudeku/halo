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

import { getPosisiKeuangan, getLHU } from '@/reports/FinancialReports';
import { catatBagianShuInvestasi, catatPenerimaanBagianShu } from '@/services/BagianShuService';
import {
  simpanKonfigurasiPenyusutanProperti,
  prosesPenyusutanPropertiInvestasi,
} from '@/services/PenyusutanPropertiInvestasiService';

/**
 * RC-S53 — REKONSILIASI LAPORAN UNTUK AKUN BARU.
 *
 * Suite sebelumnya membuktikan arah jurnal dan saldo ledger. Yang BELUM
 * pernah dibuktikan lewat perilaku: bahwa fungsi laporan PRODUKSI
 * memperlakukan akun-akun RC-S53 dengan benar — khususnya `1-1670`,
 * satu-satunya kontra-aset baru.
 *
 * Titik rawannya nyata: kalau `getPosisiKeuangan()` memakai daftar
 * kontra-akun yang dikodekan keras, `1-1670` akan MENAMBAH aset alih-alih
 * menguranginya. Di sini itu diuji, bukan dibaca dari kode.
 *
 * Jenis test: REAL SQLITE ACCOUNTING TEST — memanggil service produksi
 * dan fungsi laporan produksi di atas database sungguhan.
 */

const AKUN = {
  kas: 'acc-kas',
  piutangShu: 'acc-piutang-shu',
  properti: 'acc-properti',
  akumProperti: 'acc-akum-properti',
  pendapatan: 'acc-pendapatan',
  bebanSusut: 'acc-beban-susut',
  modal: 'acc-modal',
};

const INV_KOPERASI = 'inv-koperasi';
const INV_PROPERTI = 'inv-properti';

async function seedAkun(
  id: string, kode: string, nama: string, kat: string,
  nb: 'DEBIT' | 'KREDIT', lhu?: string
) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?,?)`,
    id, kode, nama, kat, nb, lhu ?? null, now, now
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

async function seedFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAkun(AKUN.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAkun(AKUN.piutangShu, '1-1220', 'Piutang Pendapatan Investasi', 'ASET', 'DEBIT');
  await seedAkun(AKUN.properti, '1-1660', 'Properti Investasi', 'ASET', 'DEBIT');
  await seedAkun(AKUN.akumProperti, '1-1670', 'Akumulasi Penyusutan Properti Investasi', 'ASET', 'KREDIT');
  await seedAkun(AKUN.pendapatan, '4-1300', 'Pendapatan Hasil Investasi', 'PENDAPATAN', 'KREDIT', 'HASIL_INVESTASI');
  await seedAkun(AKUN.bebanSusut, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT', 'BEBAN_USAHA');
  await seedAkun(AKUN.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');

  await seedMapping('KAS_UMUM', 'DEFAULT', AKUN.kas);
  await seedMapping('BAGIAN_SHU_INVESTASI', 'DEBIT_PIUTANG', AKUN.piutangShu);
  await seedMapping('BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN', AKUN.pendapatan);
  await seedMapping('BAGIAN_SHU_PENERIMAAN', 'KREDIT_PIUTANG', AKUN.piutangShu);
  await seedMapping('PENYUSUTAN_PROPERTI_INVESTASI', 'DEBIT_BEBAN', AKUN.bebanSusut);
  await seedMapping('PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI', AKUN.akumProperti);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026', 2026, '2026-01-01', '2026-12-31', 'OPEN')`
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  for (const [id, nomor, jenis, nama, jumlah] of [
    [INV_KOPERASI, 'INV-2026-001', 'KOPERASI_LAIN', 'Koperasi Mitra', 50_000_000],
    [INV_PROPERTI, 'INV-2026-009', 'PROPERTI_INVESTASI', 'Ruko Jl. Mawar', 500_000_000],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                              sumber_dana, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?, '2026-01-05','KAS','AKTIF','user-1',?,?)`,
      id, nomor, jenis, nama, jumlah, now, now
    );
  }

  // Jurnal perolehan properti (Dr 1-1660 / Cr Kas) — supaya laporan
  // punya nilai perolehan yang nyata untuk dinetralkan akumulasi.
  await testDb.runAsync(
    `INSERT INTO journal (id, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, nomor_jurnal)
     VALUES ('j-beli','2026-01-05','p2026','INVESTASI_PROPERTI_INVESTASI','Perolehan properti','POSTED','user-1',?,?,'JRN-2026-0001')`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('eb1','j-beli',?,500000000,0,1)`, AKUN.properti
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('eb2','j-beli',?,0,500000000,2)`, AKUN.modal
  );
}

function cari(rows: { kode: string; saldo: number }[], kode: string) {
  return rows.find((r) => r.kode === kode);
}

describe('Rekonsiliasi laporan — akun RC-S53 di Posisi Keuangan', () => {
  beforeEach(async () => {
    await seedFixture();

    // Bagian SHU: diakui 5.000.000, diterima 2.000.000 -> piutang 3.000.000.
    const akrual = await catatBagianShuInvestasi({
      investasiId: INV_KOPERASI, tanggalHak: '2026-03-20', jumlah: 5_000_000,
      jenisDokumen: 'Berita Acara RAT', nomorDokumen: 'BA-RAT-2026-014',
      tanggalDokumen: '2026-03-20', createdBy: 'user-1',
    });
    await catatPenerimaanBagianShu({
      bagianShuId: akrual.id, tanggal: '2026-04-05', jumlah: 2_000_000,
      sumberDana: 'KAS', nomorReferensi: 'TRM-001', createdBy: 'user-1',
    });

    // Penyusutan properti: 240.000.000 / 120 bulan = 2.000.000, tiga periode.
    await simpanKonfigurasiPenyusutanProperti({
      investasiId: INV_PROPERTI, jenisObjek: 'TANAH_DAN_BANGUNAN',
      nilaiDapatDisusutkan: 240_000_000, nilaiResidu: 0, masaManfaatBulan: 120,
      tanggalMulaiPenyusutan: '2026-01-05', createdBy: 'user-1',
    });
    for (const p of ['2026-01', '2026-02', '2026-03']) {
      await prosesPenyusutanPropertiInvestasi({
        investasiId: INV_PROPERTI, periode: p, createdBy: 'user-1', tanggalLaporan: '2026-06-30',
      });
    }
  });

  it('1-1220 muncul sebagai piutang dengan saldo = sisa piutang', async () => {
    const pk = await getPosisiKeuangan(testDb as never, '2026-06-30');
    const piutang = cari(pk.aset as never, '1-1220');
    expect(piutang).toBeDefined();
    expect(piutang!.saldo).toBe(3_000_000);
  });

  it('1-1660 tetap sebesar biaya perolehan — tidak dikurangi penyusutan', async () => {
    const pk = await getPosisiKeuangan(testDb as never, '2026-06-30');
    expect(cari(pk.aset as never, '1-1660')!.saldo).toBe(500_000_000);
  });

  it('1-1670 MENGURANGI aset, bukan menambah — nilainya negatif di sisi aset', async () => {
    // Inilah titik rawannya: kalau laporan memakai daftar kontra-akun
    // yang dikodekan keras, akun baru ini akan menambah aset.
    const pk = await getPosisiKeuangan(testDb as never, '2026-06-30');
    const akum = cari(pk.aset as never, '1-1670');
    expect(akum).toBeDefined();
    expect(akum!.saldo).toBe(-6_000_000);
  });

  it('nilai tercatat properti di laporan = perolehan - akumulasi penyusutan', async () => {
    const pk = await getPosisiKeuangan(testDb as never, '2026-06-30');
    const cost = cari(pk.aset as never, '1-1660')!.saldo;
    const akum = cari(pk.aset as never, '1-1670')!.saldo;
    expect(cost + akum).toBe(494_000_000);
  });

  it('total aset memperhitungkan akumulasi sebagai pengurang', async () => {
    const pk = await getPosisiKeuangan(testDb as never, '2026-06-30');
    const jumlahBaris = (pk.aset as { saldo: number }[]).reduce((t, r) => t + r.saldo, 0);
    expect(pk.totalAset).toBe(jumlahBaris);
    // Kas 2.000.000 + piutang 3.000.000 + properti 500.000.000
    // - akumulasi 6.000.000 = 499.000.000.
    expect(pk.totalAset).toBe(499_000_000);
  });

  it('neraca tetap seimbang setelah kedua fitur RC-S53 berjalan', async () => {
    const pk = await getPosisiKeuangan(testDb as never, '2026-06-30');
    expect(pk.totalAset).toBe(pk.totalLiabilitas + pk.totalEkuitas);
  });
});

describe('Rekonsiliasi laporan — akun RC-S53 di LHU', () => {
  beforeEach(async () => {
    await seedFixture();
    await catatBagianShuInvestasi({
      investasiId: INV_KOPERASI, tanggalHak: '2026-03-20', jumlah: 5_000_000,
      jenisDokumen: 'Berita Acara RAT', nomorDokumen: 'BA-RAT-2026-014',
      tanggalDokumen: '2026-03-20', createdBy: 'user-1',
    });
    await simpanKonfigurasiPenyusutanProperti({
      investasiId: INV_PROPERTI, jenisObjek: 'BANGUNAN',
      nilaiDapatDisusutkan: 240_000_000, nilaiResidu: 0, masaManfaatBulan: 120,
      tanggalMulaiPenyusutan: '2026-01-05', createdBy: 'user-1',
    });
    await prosesPenyusutanPropertiInvestasi({
      investasiId: INV_PROPERTI, periode: '2026-01', createdBy: 'user-1',
      tanggalLaporan: '2026-06-30',
    });
  });

  it('4-1300 masuk LHU sebagai hasil investasi, sebesar yang diakui', async () => {
    const lhu = await getLHU(testDb as never, '2026-01-01', '2026-06-30');
    const teks = JSON.stringify(lhu);
    expect(teks).toContain('4-1300');
    expect(teks).toContain('5000000');
  });

  it('5-1300 masuk LHU sebagai beban usaha, sebesar penyusutan yang dijurnal', async () => {
    const lhu = await getLHU(testDb as never, '2026-01-01', '2026-06-30');
    const teks = JSON.stringify(lhu);
    expect(teks).toContain('5-1300');
    expect(teks).toContain('2000000');
  });

  it('1-1670 TIDAK muncul di LHU — ia akun aset, bukan beban', async () => {
    const lhu = await getLHU(testDb as never, '2026-01-01', '2026-06-30');
    expect(JSON.stringify(lhu)).not.toContain('1-1670');
  });

  it('penerimaan kas TIDAK menambah pendapatan di LHU', async () => {
    const sebelum = JSON.stringify(await getLHU(testDb as never, '2026-01-01', '2026-06-30'));
    const rows = await testDb.getAllAsync<{ id: string }>(
      `SELECT id FROM investasi_bagian_shu LIMIT 1`
    );
    await catatPenerimaanBagianShu({
      bagianShuId: rows[0].id, tanggal: '2026-04-05', jumlah: 5_000_000,
      sumberDana: 'KAS', nomorReferensi: 'TRM-LUNAS', createdBy: 'user-1',
    });
    const sesudah = await getLHU(testDb as never, '2026-01-01', '2026-06-30');
    // Pendapatan tidak bergerak; yang berubah hanya sisi aset.
    expect(JSON.stringify(sesudah).includes('5000000')).toBe(
      sebelum.includes('5000000')
    );
    const pendapatan = await testDb.getFirstAsync<{ k: number }>(
      `SELECT COALESCE(SUM(kredit),0) AS k FROM journal_entry WHERE account_id = ?`,
      AKUN.pendapatan
    );
    expect(pendapatan!.k).toBe(5_000_000);
  });
});

describe('Integritas data setelah kedua fitur berjalan', () => {
  it('FK aktif, foreign_key_check kosong, nol duplikat', async () => {
    await seedFixture();
    await catatBagianShuInvestasi({
      investasiId: INV_KOPERASI, tanggalHak: '2026-03-20', jumlah: 5_000_000,
      jenisDokumen: 'Berita Acara RAT', nomorDokumen: 'BA-RAT-2026-014',
      tanggalDokumen: '2026-03-20', createdBy: 'user-1',
    });
    await simpanKonfigurasiPenyusutanProperti({
      investasiId: INV_PROPERTI, jenisObjek: 'BANGUNAN',
      nilaiDapatDisusutkan: 240_000_000, nilaiResidu: 0, masaManfaatBulan: 120,
      tanggalMulaiPenyusutan: '2026-01-05', createdBy: 'user-1',
    });
    await prosesPenyusutanPropertiInvestasi({
      investasiId: INV_PROPERTI, periode: '2026-01', createdBy: 'user-1',
      tanggalLaporan: '2026-06-30',
    });

    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk!.foreign_keys).toBe(1);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);

    for (const q of [
      `SELECT nomor_jurnal FROM journal GROUP BY nomor_jurnal HAVING COUNT(*) > 1`,
      `SELECT kode FROM account GROUP BY kode HAVING COUNT(*) > 1`,
      `SELECT investasi_id FROM investasi_penyusutan GROUP BY investasi_id, periode HAVING COUNT(*) > 1`,
      `SELECT investasi_id FROM investasi_bagian_shu
        GROUP BY investasi_id, tanggal_hak, jenis_hasil, nomor_dokumen HAVING COUNT(*) > 1`,
      `SELECT je.id FROM journal_entry je LEFT JOIN journal j ON j.id = je.journal_id WHERE j.id IS NULL`,
    ]) {
      expect(await testDb.getAllAsync(q)).toHaveLength(0);
    }
  });
});
