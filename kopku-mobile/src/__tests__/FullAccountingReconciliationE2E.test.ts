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

import { jalankanRekonsiliasiLengkap } from '@/accounting/FullReconciliation';
import {
  ajukanPinjaman,
  cairkanPinjaman,
  bayarAngsuran,
  akadUlangPinjaman,
  lunasiPinjaman,
  getJadwalAngsuran,
} from '@/services/PinjamanService';
import { setorSimpanan } from '@/services/SimpananService';
import { catatPemasukan, catatPengeluaran } from '@/services/KasBankService';
import { beliAset } from '@/services/AsetService';
import { terimaUtang, bayarUtang, akruiBungaUtang } from '@/services/UtangService';
import { prosesPenyusutanAset } from '@/services/PenyusutanService';
import { jalankanAkrualJasaPeriode } from '@/services/AkrualJasaPinjamanService';
import { getKlasifikasiPinjamanAktif } from '@/services/LoanImpairmentService';
import { getTotalOutstanding } from '@/services/LoanEligibilityService';
import { getPosisiKeuangan, getLabaRugi, getArusKas } from '@/reports/FinancialReports';
import { isCurrentRepaymentSchedule, isObsoleteRepaymentSchedule } from '@/accounting/ScheduleLifecycle';

/**
 * E2E LINTAS MODUL — SATU DATASET, SATU KEBENARAN AKUNTANSI.
 * ==========================================================
 *
 * Test ini menjalankan alur hidup koperasi dari awal sampai laporan,
 * dan setelah SETIAP langkah besar memeriksa ulang seluruh invarian:
 *
 *   debit = kredit
 *   Aset = Liabilitas + Ekuitas
 *   subledger = GL untuk setiap domain
 *
 * WHY diperiksa di setiap checkpoint, bukan hanya di akhir:
 * kalau hanya keadaan akhir yang diperiksa, satu kesalahan bisa
 * tertutup oleh kesalahan berlawanan di langkah lain, dan kalaupun
 * ketahuan kita tidak tahu langkah MANA yang merusaknya. Memeriksa per
 * langkah membuat divergensi PERTAMA langsung menunjuk penyebabnya.
 */

const ANGGOTA_ID = 'anggota-1';
const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  penyisihan: 'acc-penyisihan',
  asetTetap: 'acc-aset-tetap',
  akumulasi: 'acc-akumulasi',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanLain: 'acc-pendapatan-lain',
  bebanPenyisihan: 'acc-beban-penyisihan',
  bebanPenyusutan: 'acc-beban-penyusutan',
  bebanLain: 'acc-beban-lain',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  simpananPokok: 'acc-simpanan-pokok',
  simpananWajib: 'acc-simpanan-wajib',
  simpananSukarela: 'acc-simpanan-sukarela',
  modal: 'acc-modal',
  utangBank: 'acc-utang-bank',
  utangBunga: 'acc-utang-bunga',
  bebanBunga: 'acc-beban-bunga',
};
const BANK_ID = 'bank-1';

async function seedAccount(
  db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}

async function seedMapping(db: TestDb, tipe: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tipe}-${role}`, tipe, role, accountId
  );
}

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.bank, '1-1100', 'Bank BRI', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedAccount(testDb, ACC.asetTetap, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.akumulasi, '1-1510', 'Akumulasi Penyusutan', 'ASET', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.simpananWajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.simpananSukarela, '2-1100', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.utangBank, '2-1400', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.utangBunga, '2-1700', 'Utang Bunga Akrual', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanLain, '4-2000', 'Pendapatan Lain-lain', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.bebanPenyusutan, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.bebanLain, '5-2000', 'Beban Lainnya', 'BEBAN', 'DEBIT');

  const mappings: [string, string, string][] = [
    ['KAS_UMUM', 'DEFAULT', ACC.kas],
    ['PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok],
    ['ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa],
    ['ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka],
    ['ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda],
    ['BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin],
    ['BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka],
    ['PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka],
    ['AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa],
    ['AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka],
    ['AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa],
    ['PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa],
    ['EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka],
    ['EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa],
    ['PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan],
    ['PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan],
    ['SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.simpananPokok],
    ['SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.simpananWajib],
    ['SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.simpananSukarela],
    ['ASET_TETAP', 'DEBIT_ASET', ACC.asetTetap],
    ['PENYUSUTAN_ASET', 'DEBIT_BEBAN', ACC.bebanPenyusutan],
    ['PENYUSUTAN_ASET', 'KREDIT_AKUMULASI', ACC.akumulasi],
    ['UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank],
    ['UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga],
    ['UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga],
  ];
  for (const [t, r, a] of mappings) await seedMapping(testDb, t, r, a);

  for (const [id, tahun] of [['p2026', 2026], ['p2027', 2027]] as const) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      id, tahun, `${tahun}-01-01`, `${tahun}-12-31`
    );
  }

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'A001', '1234567890123456', 'Budi', '2020-01-01', now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at)
     VALUES (?,?,?,?,?,0,1,?)`,
    BANK_ID, 'Bank BRI', '123456', 'Koperasi Uji', ACC.bank, now
  );
  await testDb.runAsync(
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
    now, now
  );

  // Modal awal tunai — satu-satunya jurnal yang disuntik langsung.
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-MODAL','2026-01-01','p2026','MODAL_UANG','Modal awal koperasi','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-m1','j-modal',?,?,0)`,
    ACC.kas, 200_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-m2','j-modal',?,0,?)`,
    ACC.modal, 200_000_000
  );
}

/** Hasil pemeriksaan invarian pada satu checkpoint. */
interface Checkpoint {
  nama: string;
  jurnal: number;
  totalDebit: number;
  totalKredit: number;
  seluruhnyaSeimbang: boolean;
  selisih: string[];
}

/**
 * Periksa SELURUH invarian pada satu titik waktu. Mengembalikan
 * ringkasan supaya divergensi PERTAMA bisa ditunjuk namanya, bukan cuma
 * dilaporkan sebagai kegagalan di akhir.
 */
async function periksaCheckpoint(nama: string): Promise<Checkpoint> {
  const rekon = await jalankanRekonsiliasiLengkap(testDb as any);
  const jurnal =
    (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal`))?.n ?? 0;

  const selisih = rekon.baris
    .filter((b) => b.status === 'SELISIH')
    .map((b) => `${b.domain}: subledger=${b.subledger} gl=${b.gl} variance=${b.variance}`);

  return {
    nama,
    jurnal,
    totalDebit: rekon.totalDebit,
    totalKredit: rekon.totalKredit,
    seluruhnyaSeimbang: rekon.seluruhnyaSeimbang,
    selisih,
  };
}

function assertCheckpoint(cp: Checkpoint) {
  // Pesan kegagalan sengaja memuat nama checkpoint & rincian domain,
  // supaya kegagalan langsung menunjuk langkah dan domain penyebabnya.
  expect({ checkpoint: cp.nama, selisih: cp.selisih }).toEqual({
    checkpoint: cp.nama,
    selisih: [],
  });
  expect(cp.totalDebit).toBe(cp.totalKredit);
  expect(cp.seluruhnyaSeimbang).toBe(true);
}

/** Posisi Keuangan harus selalu seimbang: Aset = Liabilitas + Ekuitas. */
async function assertPosisiSeimbang(tanggal: string) {
  const posisi = await getPosisiKeuangan(testDb as any, tanggal);
  expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);
}

describe('E2E lintas modul — invarian terjaga di SETIAP checkpoint', () => {
  jest.setTimeout(120_000);

  test('alur penuh koperasi: simpanan -> pinjaman -> restrukturisasi -> pelunasan -> aset -> laporan', async () => {
    await setupFixture();
    const checkpoints: Checkpoint[] = [];

    const catat = async (nama: string) => {
      const cp = await periksaCheckpoint(nama);
      checkpoints.push(cp);
      assertCheckpoint(cp);
      return cp;
    };

    // ---------- 1. Kondisi awal ----------
    await catat('01-modal-awal');
    await assertPosisiSeimbang('2026-01-01');

    // ---------- 2. Simpanan anggota ----------
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-02',
      nominal: 500_000, sumberDana: 'KAS', createdBy: 'user-1',
    });
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-01-02',
      nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1',
    });
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-03',
      nominal: 250_000, sumberDana: 'KAS', createdBy: 'user-1',
    });
    await catat('02-simpanan');

    // ---------- 3. Pinjaman + pencairan ----------
    const { id: pinjamanId } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID, tanggal: '2026-01-05', jumlahPinjaman: 12_000_000,
      tenor: 12, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false,
      createdBy: 'user-1',
    });
    await cairkanPinjaman({
      pinjamanId, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-05',
    });
    await catat('03-pencairan-pinjaman');

    // ---------- 4. Pembayaran angsuran pertama ----------
    const jadwalAwal = await getJadwalAngsuran(pinjamanId);
    await bayarAngsuran({
      pinjamanId, jadwalId: jadwalAwal[0].id, tanggal: jadwalAwal[0].tanggalJatuhTempo,
      nominal: jadwalAwal[0].total, sumberDana: 'KAS', createdBy: 'user-1',
    });
    await catat('04-angsuran-1');

    // ---------- 5. Akrual jasa periode berjalan ----------
    const periodeAkrual = jadwalAwal[1].tanggalJatuhTempo.slice(0, 7);
    await jalankanAkrualJasaPeriode(periodeAkrual, 'user-1', {
      tanggalLaporan: `${periodeAkrual}-28`,
    });
    await catat('05-akrual-jasa');

    // ---------- 6. Tunggakan & batas non-accrual ----------
    // Angsuran ke-2 dst dibiarkan menunggak; aging dinilai per tanggal
    // laporan, bukan lewat mutasi data.
    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any, {
      tanggalLaporan: '2026-06-30',
    });
    const barisKlasifikasi = klasifikasi.find((k) => k.pinjamanId === pinjamanId);
    expect(barisKlasifikasi).toBeDefined();
    expect(barisKlasifikasi!.hariTunggakan).toBeGreaterThan(90);
    await catat('06-tunggakan');

    // ---------- 7. Restrukturisasi ----------
    await akadUlangPinjaman({
      pinjamanId, tanggal: '2026-07-01', tenorBaru: 12, satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT', persentaseJasaBaru: 1, actingUserId: 'user-1',
    });
    const jadwalSetelah = await getJadwalAngsuran(pinjamanId);
    const current = jadwalSetelah.filter((j) => isCurrentRepaymentSchedule(j.status));
    const obsolete = jadwalSetelah.filter((j) => isObsoleteRepaymentSchedule(j.status));
    // Histori lama TETAP ADA tetapi tidak lagi dihitung.
    expect(obsolete.length).toBeGreaterThan(0);
    expect(current.length).toBe(12);
    await catat('07-restrukturisasi');

    // ---------- 8. Pembayaran setelah restrukturisasi ----------
    const barisBaru = current.sort((a, b) =>
      a.tanggalJatuhTempo.localeCompare(b.tanggalJatuhTempo)
    )[0];
    await bayarAngsuran({
      pinjamanId, jadwalId: barisBaru.id, tanggal: barisBaru.tanggalJatuhTempo,
      nominal: barisBaru.total, sumberDana: 'KAS', createdBy: 'user-1',
    });
    await catat('08-angsuran-setelah-restrukturisasi');

    // Outstanding hanya dari jadwal current — bukan lama + baru.
    const outstanding = await getTotalOutstanding(testDb as any, ANGGOTA_ID);
    const outstandingCurrent = current
      .filter((j) => j.id !== barisBaru.id)
      .reduce((a, j) => a + j.total, 0);
    expect(outstanding).toBe(outstandingCurrent);

    // ---------- 9. Pelunasan dipercepat + deferred income ----------
    const hasilLunas = await lunasiPinjaman({
      pinjamanId, tanggal: '2026-09-01', sumberDana: 'KAS', createdBy: 'user-1',
      metodeJasaPelunasan: 'JASA_KONTRAKTUAL',
    });
    expect(hasilLunas.jasaFuturePendingEirAccounting).toBeGreaterThan(0);
    await catat('09-pelunasan-deferred');

    // ---------- 10. Pelepasan deferred income periode demi periode ----------
    const periodeDeferred = await testDb.getAllAsync<{ periode: string }>(
      `SELECT DISTINCT substr(tanggal_jatuh_tempo,1,7) as periode FROM angsuran_jadwal
       WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY periode ASC`,
      pinjamanId
    );
    expect(periodeDeferred.length).toBeGreaterThan(0);
    for (const { periode } of periodeDeferred) {
      await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: `${periode}-28` });
      await catat(`10-lepas-deferred-${periode}`);
    }
    const sisaDeferred = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COALESCE(SUM(jasa_dimuka),0) as n FROM angsuran_jadwal`
    );
    expect(sisaDeferred!.n).toBe(0);

    // ---------- 11. Pembelian aset + penyusutan ----------
    await beliAset({
      namaAset: 'Laptop Kantor', nilaiPerolehan: 12_000_000, nilaiResidu: 0,
      masaManfaatBulan: 12, tanggal: '2026-02-01', metodePembayaran: 'TUNAI',
      sumberDana: 'KAS', createdBy: 'user-1',
    });
    await catat('11-pembelian-aset');

    const aset = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM aset_tetap LIMIT 1`);
    await prosesPenyusutanAset({
      asetId: aset!.id, periode: '2026-03', createdBy: 'user-1', tanggalLaporan: '2026-09-03',
    });
    await catat('12-penyusutan');

    // ---------- 12. Transaksi kas & bank ----------
    await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-03-10', nominal: 750_000,
      akunLawanId: ACC.pendapatanLain, createdBy: 'user-1', idempotencyKey: 'e2e-masuk-1',
    });
    // Bank harus punya saldo lebih dulu — pengeluaran dari rekening
    // kosong memang ditolak service (validasi saldo, bukan bug).
    await catatPemasukan({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-10', nominal: 1_000_000,
      akunLawanId: ACC.pendapatanLain, createdBy: 'user-1', idempotencyKey: 'e2e-bank-masuk',
    });
    await catatPengeluaran({
      jenis: 'BANK', bankAccountId: BANK_ID, tanggal: '2026-03-11', nominal: 200_000,
      akunLawanId: ACC.bebanLain, createdBy: 'user-1', idempotencyKey: 'e2e-keluar-1',
    });
    await catat('13-kas-bank');

    // Idempotensi: pengulangan tidak menambah efek akuntansi.
    const sebelumUlang = await periksaCheckpoint('sebelum-ulang');
    await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-03-10', nominal: 750_000,
      akunLawanId: ACC.pendapatanLain, createdBy: 'user-1', idempotencyKey: 'e2e-masuk-1',
    });
    const sesudahUlang = await periksaCheckpoint('sesudah-ulang');
    expect(sesudahUlang.jurnal).toBe(sebelumUlang.jurnal);
    expect(sesudahUlang.totalDebit).toBe(sebelumUlang.totalDebit);

    // ---------- 13. Nonaktifkan bank, laporan historis tetap utuh ----------
    const arusSebelum = await getArusKas(testDb as any, '2026-01-01', '2026-12-31');
    await testDb.runAsync(`UPDATE bank_account SET aktif = 0 WHERE id = ?`, BANK_ID);
    const arusSesudah = await getArusKas(testDb as any, '2026-01-01', '2026-12-31');
    expect(arusSesudah.kasAwal).toBe(arusSebelum.kasAwal);
    expect(arusSesudah.kasAkhirAktual).toBe(arusSebelum.kasAkhirAktual);
    expect(arusSesudah.rincian.length).toBe(arusSebelum.rincian.length);
    await catat('14-bank-nonaktif');

    // ---------- 14. Laporan keuangan ----------
    await assertPosisiSeimbang('2026-12-31');

    const labaRugi = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    // Pokok pinjaman BUKAN pendapatan: pendapatan tidak boleh sebesar
    // pokok yang disalurkan/diterima kembali.
    expect(labaRugi.totalPendapatan).toBeLessThan(12_000_000);
    // Pembelian aset BUKAN beban penuh: beban jauh di bawah 12 juta
    // (hanya penyusutan sebulan yang diakui).
    expect(labaRugi.totalBeban).toBeLessThan(12_000_000);

    const arus = await getArusKas(testDb as any, '2026-01-01', '2026-12-31');
    expect(arus.kasAwal + arus.perubahanKas).toBe(arus.kasAkhirDihitung);
    expect(arus.terekonsiliasi).toBe(true);

    // ---------- 14b. Utang koperasi: terima -> akrual bunga -> bayar ----------
    const utang = await terimaUtang({
      namaPemberi: 'Bank Mitra', jenisPemberi: 'BANK', pokokPinjaman: 20_000_000,
      persenBunga: 12, basisBunga: 'BULANAN', jenisBunga: 'FLAT', tanggal: '2026-04-01',
      sumberDana: 'KAS', createdBy: 'user-1',
    });
    await catat('15-terima-utang');

    await akruiBungaUtang({
      utangId: (utang as any).id, tanggal: '2026-05-01', nominal: 200_000, createdBy: 'user-1',
    } as any);
    await catat('16-akrual-bunga-utang');

    await bayarUtang({
      utangId: (utang as any).id, tanggal: '2026-06-01', pokok: 5_000_000, bunga: 200_000,
      sumberDana: 'KAS', createdBy: 'user-1',
    } as any);
    await catat('17-bayar-utang');

    // ---------- 15. Integritas database (§25) ----------
    // Dijalankan pada dataset yang SUDAH melewati seluruh alur di atas,
    // bukan pada database kosong — orphan biasanya lahir dari operasi
    // gabungan (restrukturisasi, write-off, pelunasan), bukan dari
    // insert tunggal.
    const orphanChecks: [string, string][] = [
      ['jurnal tanpa baris', `SELECT COUNT(*) as n FROM journal j WHERE NOT EXISTS (SELECT 1 FROM journal_entry e WHERE e.journal_id = j.id)`],
      ['baris tanpa jurnal', `SELECT COUNT(*) as n FROM journal_entry e WHERE NOT EXISTS (SELECT 1 FROM journal j WHERE j.id = e.journal_id)`],
      ['baris tanpa akun', `SELECT COUNT(*) as n FROM journal_entry e WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.id = e.account_id)`],
      ['jadwal tanpa pinjaman', `SELECT COUNT(*) as n FROM angsuran_jadwal aj WHERE NOT EXISTS (SELECT 1 FROM pinjaman p WHERE p.id = aj.pinjaman_id)`],
      ['pembayaran tanpa pinjaman', `SELECT COUNT(*) as n FROM angsuran_pembayaran ap WHERE NOT EXISTS (SELECT 1 FROM pinjaman p WHERE p.id = ap.pinjaman_id)`],
      ['penyusutan tanpa aset', `SELECT COUNT(*) as n FROM aset_penyusutan d WHERE NOT EXISTS (SELECT 1 FROM aset_tetap a WHERE a.id = d.aset_id)`],
      ['mapping tanpa akun', `SELECT COUNT(*) as n FROM account_mapping m WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.id = m.account_id)`],
      ['simpanan tanpa anggota', `SELECT COUNT(*) as n FROM simpanan_transaksi s WHERE NOT EXISTS (SELECT 1 FROM anggota a WHERE a.id = s.anggota_id)`],
    ];
    const orphan: Record<string, number> = {};
    for (const [nama, sql] of orphanChecks) {
      orphan[nama] = (await testDb.getFirstAsync<{ n: number }>(sql))?.n ?? 0;
    }
    expect(orphan).toEqual({
      'jurnal tanpa baris': 0,
      'baris tanpa jurnal': 0,
      'baris tanpa akun': 0,
      'jadwal tanpa pinjaman': 0,
      'pembayaran tanpa pinjaman': 0,
      'penyusutan tanpa aset': 0,
      'mapping tanpa akun': 0,
      'simpanan tanpa anggota': 0,
    });

    // PRAGMA foreign_key_check pada dataset akhir — struktur boleh
    // valid tetapi referensinya rusak, dua hal yang berbeda.
    const pelanggaranFk = await testDb.getAllAsync(`PRAGMA foreign_key_check`);
    expect(pelanggaranFk).toEqual([]);

    // ---------- 16. Ringkasan seluruh checkpoint ----------
    expect(checkpoints.length).toBeGreaterThanOrEqual(14);
    for (const cp of checkpoints) {
      expect(cp.selisih).toEqual([]);
      expect(cp.totalDebit).toBe(cp.totalKredit);
    }
  });
});
