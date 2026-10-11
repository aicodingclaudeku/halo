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

import { ajukanPinjaman, simpanJadwalAngsuranCustom, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran } from '@/services/PinjamanService';
import { setorSimpanan, keluarAnggota } from '@/services/SimpananService';
import {
  listBuktiBayarPiutang,
  getBuktiBayarPiutangById,
  listBuktiBayarSimpanan,
  getBuktiBayarSimpananById,
  listBuktiTarikSimpanan,
  getBuktiTarikSimpananById,
  listBuktiKeluarAnggota,
  getBuktiKeluarAnggotaById,
} from '@/services/BuktiTransaksiService';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
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
  piutang: 'acc-piutang',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pokok: 'acc-pokok',
  wajib: 'acc-wajib',
  sukarela: 'acc-sukarela',
  modal: 'acc-modal',
};

const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.wajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.sukarela, '2-1200', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutang);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.pokok);
  await seedMapping(testDb, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.wajib);
  await seedMapping(testDb, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026', 2026, '2026-01-01', '2026-12-31'
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'A001', '1234567890123456', 'Budi', '2020-01-01', now, now
  );

  // Modal awal kas — supaya pencairan pinjaman & pengembalian simpanan (keluar anggota) tidak tersandung liquidity check.
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-1', 'journal-modal-awal', ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-2', 'journal-modal-awal', ACC.modal, 50_000_000);

  // Simpanan pokok+wajib supaya anggota lolos syarat pengajuan pinjaman.
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'sp-fixture', ANGGOTA_ID, 'POKOK', 'SETOR', '2020-01-01', 100_000, 'KAS', 'SP-FIXTURE', 'user-1', now
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'sw-fixture', ANGGOTA_ID, 'WAJIB', 'SETOR', '2020-01-01', 50_000, 'KAS', 'SW-FIXTURE', 'user-1', now
  );
}

describe('BuktiTransaksiService — Bukti Bayar Piutang (Phase 17 §W)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('listBuktiBayarPiutang & getBuktiBayarPiutangById mengambil nomor bukti dari transaksi asli (journal.nomor_referensi), bukan bikin baru', async () => {
    const { id: pinjamanId } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 2,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId,
      baris: [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 1_000_000, jasa: 50_000 }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId, sumberDana: 'KAS', approvedBy: 'user-1' });
    const jadwal = await getJadwalAngsuran(pinjamanId);

    const { id: pembayaranId } = await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: 1_050_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listBuktiBayarPiutang();
    expect(daftar).toHaveLength(1);
    expect(daftar[0].namaAnggota).toBe('Budi');
    expect(daftar[0].nomorAnggota).toBe('A001');
    expect(daftar[0].jumlahPembayaran).toBe(1_050_000);
    expect(daftar[0].nomorBukti).not.toBe('-'); // benar-benar diambil dari journal.nomor_referensi

    const detail = await getBuktiBayarPiutangById(pembayaranId);
    expect(detail?.nomorBukti).toBe(daftar[0].nomorBukti);
    expect((detail?.porsiPokok ?? 0) + (detail?.porsiJasa ?? 0) + (detail?.porsiDenda ?? 0)).toBe(1_050_000);
  });

  test('listBuktiBayarPiutang search memfilter berdasarkan nama anggota', async () => {
    expect(await listBuktiBayarPiutang({ search: 'Nama Tidak Ada' })).toHaveLength(0);
  });
});

describe('BuktiTransaksiService — Bukti Bayar Simpanan (Phase 17 §X)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('listBuktiBayarSimpanan hanya menampilkan transaksi SETOR (bukan TARIK), diambil dari simpanan_transaksi asli', async () => {
    const { nomorTransaksi } = await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-01-10',
      nominal: 300_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listBuktiBayarSimpanan();
    // 2 dari fixture (pokok+wajib) + 1 setoran baru = 3, semuanya SETOR
    expect(daftar.length).toBe(3);
    const baru = daftar.find((d) => d.nomorBukti === nomorTransaksi);
    expect(baru).toBeDefined();
    expect(baru?.jumlah).toBe(300_000);
    expect(baru?.jenisSimpanan).toBe('SUKARELA');

    const detail = await getBuktiBayarSimpananById(baru!.id);
    expect(detail?.namaAnggota).toBe('Budi');
  });
});

describe('BuktiTransaksiService — Bukti Tarik Simpanan (update pasca-Phase 18/19 §G)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('listBuktiTarikSimpanan hanya menampilkan transaksi TARIK jenis SUKARELA, diambil dari simpanan_transaksi asli', async () => {
    const { tarikSimpananSukarela, setorSimpanan: setor } = await import('@/services/SimpananService');
    await setor({ anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-05', nominal: 500_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const { nomorTransaksi } = await tarikSimpananSukarela({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      nominal: 200_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listBuktiTarikSimpanan();
    expect(daftar).toHaveLength(1);
    expect(daftar[0].nomorBukti).toBe(nomorTransaksi);
    expect(daftar[0].jumlah).toBe(200_000);
    expect(daftar[0].jenisSimpanan).toBe('SUKARELA');

    // Transaksi SETOR (bukan TARIK) tidak ikut muncul di sini.
    const semuaBayar = await listBuktiBayarSimpanan();
    expect(semuaBayar.find((d) => d.nomorBukti === nomorTransaksi)).toBeUndefined();

    const detail = await getBuktiTarikSimpananById(daftar[0].id);
    expect(detail?.namaAnggota).toBe('Budi');
    expect(detail?.jumlah).toBe(200_000);
  });

  test('listBuktiTarikSimpanan: search memfilter berdasarkan nama anggota', async () => {
    expect(await listBuktiTarikSimpanan({ search: 'Nama Tidak Ada' })).toHaveLength(0);
  });

  test('getBuktiTarikSimpananById: null kalau id merujuk transaksi SETOR (bukan TARIK)', async () => {
    const { nomorTransaksi } = await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-01-10',
      nominal: 300_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const daftarSetor = await listBuktiBayarSimpanan();
    const idSetor = daftarSetor.find((d) => d.nomorBukti === nomorTransaksi)!.id;

    expect(await getBuktiTarikSimpananById(idSetor)).toBeNull();
  });
});

describe('BuktiTransaksiService — Bukti Keluar Anggota (Phase 17 §Y)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('listBuktiKeluarAnggota menggabungkan pokok+wajib+sukarela jadi satu baris per kejadian keluar', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-10', nominal: 200_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const { nomorTransaksi, totalSimpanan } = await keluarAnggota({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listBuktiKeluarAnggota();
    expect(daftar).toHaveLength(1); // satu baris, bukan 3 (pokok/wajib/sukarela tergabung)
    expect(daftar[0].nomorBukti).toBe(nomorTransaksi);
    expect(daftar[0].totalDikembalikan).toBe(totalSimpanan);
    expect(daftar[0].totalDikembalikan).toBe(100_000 + 50_000 + 200_000);

    const detail = await getBuktiKeluarAnggotaById(daftar[0].journalId);
    expect(detail?.namaAnggota).toBe('Budi');
    expect(detail?.totalDikembalikan).toBe(350_000);
  });
});

describe('BuktiTransaksiService — Bukti Bayar Utang (update pasca-6-perbaikan §2)', () => {
  const ACC_UTANG = { utangBank: 'acc-utang-bank', bebanBunga: 'acc-beban-bunga-utang', utangBunga: 'acc-utang-bunga' };

  async function setupFixtureUtang(): Promise<void> {
    await setupFixture();
    await seedAccount(testDb, ACC_UTANG.utangBank, '2-1000', 'Utang Bank', 'LIABILITAS', 'KREDIT');
    await seedAccount(testDb, ACC_UTANG.bebanBunga, '5-1500', 'Beban Bunga', 'BEBAN', 'DEBIT');
    await seedMapping(testDb, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC_UTANG.utangBank);
    await seedMapping(testDb, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC_UTANG.bebanBunga);
    // DIPERBARUI RC-S72 (FIXTURE BUG, register #7): sejak RC-S53 §Z `bayarUtang()`
    // membaca outstanding Utang Bunga (akun KREDIT_AKRUAL) untuk membagi pembayaran
    // bunga. COA default produksi memetakannya ke 2-1700 (defaultCOA.ts); fixture
    // lama tidak. Tidak ada akrual di skenario ini, sehingga seluruh bunga tetap
    // dibebankan — expected value test tidak berubah.
    await seedAccount(testDb, ACC_UTANG.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
    await seedMapping(testDb, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC_UTANG.utangBunga);
  }

  beforeEach(async () => {
    await setupFixtureUtang();
  });

  test('listBuktiBayarUtang: menampilkan pembayaran utang dari utang_pembayaran asli (bukan transaksi baru)', async () => {
    const { terimaUtang, bayarUtang } = await import('@/services/UtangService');
    const { id: utangId } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 10_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const { nomorTransaksi } = await bayarUtang({
      utangId,
      tanggal: '2026-02-01',
      pokok: 2_000_000,
      bunga: 100_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const { listBuktiBayarUtang, getBuktiBayarUtangById } = await import('@/services/BuktiTransaksiService');
    const daftar = await listBuktiBayarUtang();
    expect(daftar).toHaveLength(1);
    expect(daftar[0].nomorBukti).toBe(nomorTransaksi);
    expect(daftar[0].namaPemberi).toBe('Bank BRI');
    expect(daftar[0].porsiPokok).toBe(2_000_000);
    expect(daftar[0].porsiBunga).toBe(100_000);
    expect(daftar[0].jumlahPembayaran).toBe(2_100_000);
    expect(daftar[0].dibuatOleh).toBe('User Admin Uji');

    const detail = await getBuktiBayarUtangById(daftar[0].id);
    expect(detail?.namaPemberi).toBe('Bank BRI');
    expect(detail?.jumlahPembayaran).toBe(2_100_000);
  });

  test('listBuktiBayarUtang: search memfilter berdasarkan nama pemberi/nomor utang', async () => {
    const { terimaUtang, bayarUtang } = await import('@/services/UtangService');
    const { id: utangId } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 5_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await bayarUtang({ utangId, tanggal: '2026-02-01', pokok: 1_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });

    const { listBuktiBayarUtang } = await import('@/services/BuktiTransaksiService');
    expect(await listBuktiBayarUtang({ search: 'BRI' })).toHaveLength(1);
    expect(await listBuktiBayarUtang({ search: 'Nama Tidak Ada' })).toHaveLength(0);
  });

  test('getBuktiBayarUtangById: null kalau id tidak ditemukan', async () => {
    const { getBuktiBayarUtangById } = await import('@/services/BuktiTransaksiService');
    expect(await getBuktiBayarUtangById('id-tidak-ada')).toBeNull();
  });
});

// ============================================================
// BUG FIX (gap yang didisclose di laporan akhir Phase 16, pola sama
// dengan Prioritas 3/E): listBuktiBayarSimpanan/listBuktiTarikSimpanan
// sebelumnya tetap menampilkan setoran/tarikan yang SUDAH DIKOREKSI
// sebagai kandidat cetak bukti — mengecualikan baris koreksinya saja,
// bukan baris ASLI yang dikoreksi.
// ============================================================
describe('BuktiTransaksiService — setoran/tarikan yang sudah dikoreksi TIDAK muncul sebagai kandidat cetak bukti (gap Phase 16)', () => {
  test('listBuktiBayarSimpanan: setoran yang sudah dikoreksi tidak lagi muncul', async () => {
    await setupFixture();
    const { setorSimpanan, koreksiSimpanan } = await import('@/services/SimpananService');
    const { id: setoranId } = await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-02-01',
      nominal: 200_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    let daftar = await listBuktiBayarSimpanan();
    expect(daftar.some((d) => d.id === setoranId)).toBe(true);

    await koreksiSimpanan(setoranId, 'user-1', 'Salah nominal');

    daftar = await listBuktiBayarSimpanan();
    expect(daftar.some((d) => d.id === setoranId)).toBe(false);
  });

  test('listBuktiTarikSimpanan: penarikan yang sudah dikoreksi tidak lagi muncul', async () => {
    await setupFixture();
    const { setorSimpanan, tarikSimpananSukarela, koreksiSimpanan } = await import('@/services/SimpananService');
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-02-01',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const { id: tarikId } = await tarikSimpananSukarela({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-02-10',
      nominal: 100_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    let daftar = await listBuktiTarikSimpanan();
    expect(daftar.some((d) => d.id === tarikId)).toBe(true);

    await koreksiSimpanan(tarikId, 'user-1', 'Salah nominal penarikan');

    daftar = await listBuktiTarikSimpanan();
    expect(daftar.some((d) => d.id === tarikId)).toBe(false);
  });
});
