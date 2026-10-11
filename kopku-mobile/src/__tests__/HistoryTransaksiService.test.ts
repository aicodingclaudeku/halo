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

import {
  listHistoryTransaksi,
  listJenisTransaksiTersedia,
  getHistoryDetail,
  batalkanTransaksiHistory,
} from '@/services/HistoryTransaksiService';
import { catatPemasukan, catatPengeluaran } from '@/services/KasBankService';
import { catatRAK } from '@/services/RAKService';
import { setorSimpanan } from '@/services/SimpananService';

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`,
    transactionType,
    role,
    accountId
  );
}

const ACC = {
  kas: 'acc-kas',
  rak: 'acc-rak',
  modal: 'acc-modal',
  simpananSukarela: 'acc-simpanan-sukarela',
  pendapatanLain: 'acc-pendapatan-lain',
  bebanLain: 'acc-beban-lain',
};

async function isiKas(db: TestDb, nominal: number) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'journal-isi-kas',
    'JRN-ISI-KAS',
    '2026-01-01',
    'period-2026',
    'MODAL_AWAL',
    'Isi kas (fixture test)',
    'POSTED',
    'user-1',
    now,
    now,
    now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-isi-debit', 'journal-isi-kas', ACC.kas, nominal);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-isi-kredit', 'journal-isi-kas', ACC.modal, nominal);
}

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.rak, '1-1800', 'Rekening Antar Kantor (RAK)', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.simpananSukarela, '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatanLain, '4-3000', 'Pendapatan Lainnya', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.bebanLain, '5-2000', 'Beban Lainnya', 'BEBAN', 'DEBIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'RAK', 'DEBIT_ASET', ACC.rak);
  await seedMapping(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.simpananSukarela);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-1','A001','Budi Santoso','2020-01-01','AKTIF',?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );

  return db;
}

describe('HistoryTransaksiService', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('listHistoryTransaksi: menyatukan transaksi dari BEBERAPA domain berbeda (kas/bank, RAK, simpanan) lewat journal — tanpa duplikasi, terbaru dulu', async () => {
    await isiKas(testDb, 50_000_000);

    await catatPemasukan({
      jenis: 'KAS',
      tanggal: '2026-02-01',
      nominal: 1_000_000,
      akunLawanId: ACC.pendapatanLain,
      keterangan: 'Penerimaan lain-lain kas',
      createdBy: 'user-1',
    });
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang Makassar',
      jumlah: 5_000_000,
      tanggal: '2026-02-05',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await setorSimpanan({
      anggotaId: 'anggota-1',
      jenis: 'SUKARELA',
      tanggal: '2026-02-10',
      nominal: 2_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listHistoryTransaksi();
    // 1 (isi kas manual) + 3 = 4 baris, masing-masing SEKALI (tidak dobel).
    expect(daftar).toHaveLength(4);

    // Terbaru dulu (2026-02-10 di atas, 2026-01-01 di bawah).
    expect(daftar[0].tanggal).toBe('2026-02-10');
    expect(daftar[daftar.length - 1].tanggal).toBe('2026-01-01');

    const rak = daftar.find((d) => d.jenisTransaksi === 'RAK');
    expect(rak?.nominal).toBe(5_000_000);
    expect(rak?.jenisLabel).toBe('Rekening Antar Kantor/Unit (RAKU)'); // DIPERBARUI Poin 10

    const simpanan = daftar.find((d) => d.jenisTransaksi === 'SIMPANAN_SUKARELA');
    expect(simpanan?.nominal).toBe(2_000_000);
  });

  test('listHistoryTransaksi: search cocok dengan deskripsi ATAU nomor transaksi', async () => {
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Kantor Cabang Unik123',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasil = await listHistoryTransaksi({ search: 'Unik123' });
    expect(hasil).toHaveLength(1);
    expect(hasil[0].deskripsi).toContain('Unik123');

    const kosong = await listHistoryTransaksi({ search: 'kata-yang-tidak-ada-sama-sekali' });
    expect(kosong).toHaveLength(0);
  });

  test('listHistoryTransaksi: filter tanggal (mulai/selesai) mempersempit hasil', async () => {
    await isiKas(testDb, 10_000_000); // 2026-01-01
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-06-15',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasil = await listHistoryTransaksi({ tanggalMulai: '2026-06-01', tanggalSelesai: '2026-06-30' });
    expect(hasil).toHaveLength(1);
    expect(hasil[0].tanggal).toBe('2026-06-15');
  });

  test('listHistoryTransaksi: filter jenis (sumber_transaksi) hanya mengembalikan jenis yang dipilih', async () => {
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await setorSimpanan({
      anggotaId: 'anggota-1',
      jenis: 'SUKARELA',
      tanggal: '2026-02-02',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasil = await listHistoryTransaksi({ jenis: ['RAK'] });
    expect(hasil).toHaveLength(1);
    expect(hasil[0].jenisTransaksi).toBe('RAK');
  });

  test('listHistoryTransaksi: filter akun hanya mengembalikan transaksi yang menyentuh akun tsb', async () => {
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasilRak = await listHistoryTransaksi({ accountId: ACC.rak });
    expect(hasilRak).toHaveLength(1);
    expect(hasilRak[0].jenisTransaksi).toBe('RAK');

    const hasilSimpanan = await listHistoryTransaksi({ accountId: ACC.simpananSukarela });
    expect(hasilSimpanan).toHaveLength(0); // belum ada transaksi simpanan
  });

  test('listHistoryTransaksi: filter status hanya mengembalikan status yang dipilih', async () => {
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const row = (await listHistoryTransaksi({ jenis: ['RAK'] }))[0];
    const detail = await getHistoryDetail(row.journalId);
    await batalkanTransaksiHistory(detail!.sumberRute!, 'user-1', 'Salah input');

    // Setelah dibatalkan: baris jurnal ASLI berstatus REVERSED, dan
    // ADA baris jurnal BARU (hasil reverseJournal) berstatus POSTED —
    // dua baris berbeda, bukan satu baris yang "berubah status".
    const semuaRak = await listHistoryTransaksi({ jenis: ['RAK'] });
    expect(semuaRak).toHaveLength(2);
    expect(semuaRak.filter((d) => d.status === 'REVERSED')).toHaveLength(1);
    expect(semuaRak.filter((d) => d.status === 'POSTED')).toHaveLength(1);

    const hanyaReversed = await listHistoryTransaksi({ jenis: ['RAK'], status: ['REVERSED'] });
    expect(hanyaReversed).toHaveLength(1);
    expect(hanyaReversed[0].status).toBe('REVERSED');

    const hanyaPosted = await listHistoryTransaksi({ jenis: ['RAK'], status: ['POSTED'] });
    expect(hanyaPosted).toHaveLength(1);
    expect(hanyaPosted[0].status).toBe('POSTED');
  });

  test('listJenisTransaksiTersedia: mengembalikan daftar jenis yang BENAR-BENAR ada di data, dengan label yang benar', async () => {
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const jenis = await listJenisTransaksiTersedia();
    const rak = jenis.find((j) => j.jenis === 'RAK');
    expect(rak?.label).toBe('Rekening Antar Kantor/Unit (RAKU)'); // DIPERBARUI Poin 10
    expect(jenis.some((j) => j.jenis === 'MODAL_AWAL')).toBe(true); // dari fixture isiKas
  });

  test('getHistoryDetail: rincian baris jurnal debit/kredit lengkap & seimbang', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const row = (await listHistoryTransaksi({ jenis: ['RAK'] }))[0];
    const detail = await getHistoryDetail(row.journalId);

    expect(detail).not.toBeNull();
    expect(detail!.lines).toHaveLength(2);
    const totalDebit = detail!.lines.reduce((a, l) => a + l.debit, 0);
    const totalKredit = detail!.lines.reduce((a, l) => a + l.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(1_000_000);
    expect(detail!.lines.find((l) => l.kodeAkun === '1-1800')?.debit).toBe(1_000_000);
    expect(detail!.lines.find((l) => l.kodeAkun === '1-1000')?.kredit).toBe(1_000_000);
  });

  test('getHistoryDetail: transaksi RAK routable — canDelete true, sumberRute mengarah ke rak_transaksi', async () => {
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const row = (await listHistoryTransaksi({ jenis: ['RAK'] }))[0];
    const detail = await getHistoryDetail(row.journalId);

    expect(detail!.canDelete).toBe(true);
    expect(detail!.aksiTidakTersediaAlasan).toBeNull();
    expect(detail!.sumberRute?.table).toBe('rak_transaksi');
  });

  test('getHistoryDetail: transaksi tanpa jalur koreksi (mis. MODAL_AWAL fixture) — canDelete false DENGAN alasan jelas', async () => {
    await isiKas(testDb, 10_000_000);
    const row = (await listHistoryTransaksi({ jenis: ['MODAL_AWAL'] }))[0];
    const detail = await getHistoryDetail(row.journalId);

    expect(detail!.canDelete).toBe(false);
    expect(detail!.aksiTidakTersediaAlasan).toMatch(/belum ada jalur koreksi/i);
  });

  test('getHistoryDetail: transaksi yang sudah REVERSED tidak bisa dikoreksi lagi (canDelete false, alasan jelas)', async () => {
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const row = (await listHistoryTransaksi({ jenis: ['RAK'] }))[0];
    const detailAwal = await getHistoryDetail(row.journalId);
    await batalkanTransaksiHistory(detailAwal!.sumberRute!, 'user-1', 'Koreksi via history');

    const detailSetelah = await getHistoryDetail(row.journalId);
    expect(detailSetelah!.status).toBe('REVERSED');
    expect(detailSetelah!.canDelete).toBe(false);
    expect(detailSetelah!.aksiTidakTersediaAlasan).toMatch(/sudah pernah dikoreksi/i);
  });

  test('getHistoryDetail: transaksi pada periode CLOSED tidak bisa dikoreksi', async () => {
    // RC-S54 T14 (POLICY-A #19): untuk RAK, yang menentukan adalah periode
    // TANGGAL PEMBALIK (hari ini). Skenario test ini — transaksi & hari ini
    // sama-sama di periode 2026 yang CLOSED — dikunci ke tanggal 2026 agar
    // tidak bergantung pada jam mesin (setelah 2026 hari ini jatuh ke periode
    // lain). Input lingkungan saja; ekspektasi tidak diubah.
    jest.useFakeTimers({
      now: new Date('2026-09-17T10:00:00'),
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2026'`);

    const row = (await listHistoryTransaksi({ jenis: ['RAK'] }))[0];
    const detail = await getHistoryDetail(row.journalId);
    expect(detail!.canDelete).toBe(false);
    expect(detail!.aksiTidakTersediaAlasan).toMatch(/periode.*ditutup|CLOSED/i);
    jest.useRealTimers();
  });

  test('batalkanTransaksiHistory: ROUTER ke koreksiTransaksiKasBank untuk transaksi kas — saldo & status konsisten dengan koreksi lewat menu asal', async () => {
    await isiKas(testDb, 10_000_000);
    await catatPengeluaran({
      jenis: 'KAS',
      tanggal: '2026-02-01',
      nominal: 500_000,
      akunLawanId: ACC.bebanLain,
      keterangan: 'Beban lain-lain',
      createdBy: 'user-1',
    });

    const row = (await listHistoryTransaksi({ jenis: ['KAS_PENGELUARAN_LAIN'] }))[0];
    const detail = await getHistoryDetail(row.journalId);
    expect(detail!.canDelete).toBe(true);
    expect(detail!.sumberRute?.table).toBe('kas_transaksi');

    await batalkanTransaksiHistory(detail!.sumberRute!, 'user-1', 'Salah kategori beban');

    const saldoKas = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    // 10jt isi - 500rb keluar + 500rb dikoreksi kembali = 10jt lagi.
    expect(saldoKas?.total).toBe(10_000_000);

    // kas_transaksi ikut punya baris KOREKSI baru (bukan cuma jurnal yang berubah).
    const kasTransaksiRows = await testDb.getAllAsync<{ tipe: string }>(`SELECT tipe FROM kas_transaksi`);
    expect(kasTransaksiRows.some((r) => r.tipe === 'KOREKSI')).toBe(true);
  });

  test('batalkanTransaksiHistory: ROUTER ke koreksiSimpanan untuk transaksi simpanan', async () => {
    await isiKas(testDb, 10_000_000);
    await setorSimpanan({
      anggotaId: 'anggota-1',
      jenis: 'SUKARELA',
      tanggal: '2026-02-01',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const row = (await listHistoryTransaksi({ jenis: ['SIMPANAN_SUKARELA'] }))[0];
    const detail = await getHistoryDetail(row.journalId);
    expect(detail!.sumberRute?.table).toBe('simpanan_transaksi');

    await batalkanTransaksiHistory(detail!.sumberRute!, 'user-1', 'Salah input nominal');

    const saldoSimpanan = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) - COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.simpananSukarela
    );
    expect(saldoSimpanan?.total).toBe(0); // dikembalikan ke 0 setelah dikoreksi
  });

  test('batalkanTransaksiHistory: DITOLAK kalau alasan kosong', async () => {
    await isiKas(testDb, 10_000_000);
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Cabang A',
      jumlah: 1_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const row = (await listHistoryTransaksi({ jenis: ['RAK'] }))[0];
    const detail = await getHistoryDetail(row.journalId);
    await expect(batalkanTransaksiHistory(detail!.sumberRute!, 'user-1', '   ')).rejects.toThrow(/[Aa]lasan/);
  });
});
