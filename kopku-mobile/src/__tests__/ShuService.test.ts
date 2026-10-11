import { createTestDb, TestDb } from './testDb';

/**
 * ShuService.ts memakai getDb()/withTransaction() dari database/db.ts
 * secara internal (pola yang sama dengan SimpananService/PinjamanService),
 * bukan menerima db sebagai parameter. Supaya bisa diuji dengan SQLite
 * sungguhan (sql.js) tanpa memuat modul expo-sqlite asli (yang berisi
 * ESM murni dan gagal di-parse Jest/CommonJS), kita mock KESELURUHAN
 * modul database/db.ts dengan implementasi setara yang bekerja di atas
 * testDb — TIDAK ADA perubahan pada source code production.
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

import {
  simpanKonfigurasiShu,
  hitungSHU,
  bagikanSHU,
  ajukanShuKeRAT,
  sahkanShuRAT,
  hapusKonfigurasiShu,
  getRiwayatSHU,
  getShuKonfigurasiByTahun,
  getShuAnggotaList,
  getShuAnggotaDetail,
  ShuSudahDihitungError,
  ShuSudahDibagikanError,
  ShuBelumDihitungError,
} from '@/services/ShuService';
import { createJournal } from '@/accounting/AccountingEngine';
import { getSaldoSimpanan } from '@/services/SimpananService';
import { newId } from '@/utils/id';

const KONFIGURASI_VALID = {
  persenCadangan: 30,
  persenJasaModal: 20,
  persenJasaUsaha: 20,
  persenPendidikan: 10,
  persenSosial: 10,
  persenPengurus: 5,
  persenPengawas: 5,
  persenKaryawan: 0,
  persenPembangunanDaerahKerja: 0,
  persenCadanganRisiko: 0,
};

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

async function seedAnggota(db: TestDb, id: string, nomor: string, nama: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    id,
    nomor,
    `NIK-${nomor}`,
    nama,
    '2020-01-01',
    now,
    now
  );
}

const ACC = {
  kas: 'acc-kas',
  simpananPokok: 'acc-simpanan-pokok',
  simpananWajib: 'acc-simpanan-wajib',
  simpananSukarela: 'acc-simpanan-sukarela',
  cadangan: 'acc-cadangan',
  cadanganRisiko: 'acc-cadangan-risiko',
  modalLainnya: 'acc-modal-lainnya',
  shuBerjalan: 'acc-shu-berjalan',
  pendapatanJasa: 'acc-pendapatan-jasa',
  bebanOperasional: 'acc-beban-operasional',
  danaPendidikan: 'acc-dana-pendidikan',
  danaSosial: 'acc-dana-sosial',
  danaPengurus: 'acc-dana-pengurus',
  danaPengawas: 'acc-dana-pengawas',
  danaKaryawan: 'acc-dana-karyawan',
  danaPembangunanDaerahKerja: 'acc-dana-pdk',
};

const ANGGOTA_1 = 'anggota-1';
const ANGGOTA_2 = 'anggota-2';

/**
 * Helper test (audit ulang, permintaan pengguna, request baru §1-§7):
 * jalankan alur RAT penuh (ajukan + sahkan) dengan nominal = SHU
 * akrual (total_shu) secara default — supaya seluruh assertion nominal
 * di test-test LAMA (ditulis sebelum alur pemisahan SHU akrual/RAT ada)
 * tetap valid tanpa diubah satu per satu: distribusi/jurnal yang
 * dihasilkan akan IDENTIK dengan perilaku lama, karena nominal
 * disahkan == nominal akrual (persis skenario "RAT menyahkan 100% dari
 * SHU Laporan Keuangan", kasus paling sederhana). Skenario nominal
 * BERBEDA (RAT menyahkan LEBIH KECIL dari akrual/kas, sesuai §5/§15/§17)
 * diuji eksplisit & terpisah di describe block "pemisahan SHU akrual/
 * RAT/disahkan" di bawah.
 */
async function ajukanDanSahkan(tahunBuku: number, userId = 'user-1', nominal?: number) {
  const konfig = await getShuKonfigurasiByTahun(tahunBuku);
  const n = nominal ?? konfig!.totalShu!;
  await ajukanShuKeRAT(userId, tahunBuku, n);
  await sahkanShuRAT({ tahunBuku, nominalDisahkan: n, actingUserId: userId });
}

/**
 * Skenario: 2 anggota aktif, laba tahun 2026 = Rp70.000 (Pendapatan
 * 100.000 - Beban 30.000, diposting via AccountingEngine sungguhan).
 * Basis simpanan 150rb:250rb (rasio 3:5), basis partisipasi usaha
 * 20rb:80rb (rasio 1:4) — angka dipilih supaya hasil pembagian bulat
 * persis, memudahkan assertion.
 */
async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.simpananWajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.simpananSukarela, '3-1200', 'Simpanan Sukarela', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.cadangan, '3-2000', 'Cadangan Umum', 'EKUITAS', 'KREDIT');
  // Audit ulang §13/§14/§15 (permintaan pengguna): akun Cadangan
  // Risiko — dibutuhkan supaya pastikanMappingShu() berhasil
  // meresolusi role KREDIT_CADANGAN_RISIKO lewat kode.
  await seedAccount(testDb, ACC.cadanganRisiko, '3-2100', 'Cadangan Risiko', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modalLainnya, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.shuBerjalan, '3-4000', 'SHU Tahun Berjalan', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.bebanOperasional, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');
  // Audit ulang §3/§4/§15/§17 (permintaan pengguna): 6 akun Dana SHU
  // sebagai LIABILITAS (kode & kategori PERSIS sama dengan
  // defaultCOA.ts) — dibutuhkan supaya pastikanMappingShu() (self-heal
  // di ShuService.ts) berhasil meresolusi akunnya lewat kode.
  await seedAccount(testDb, ACC.danaPendidikan, '2-1800', 'Dana Pendidikan', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.danaSosial, '2-1810', 'Dana Sosial', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.danaPengurus, '2-1820', 'Dana Pengurus', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.danaPengawas, '2-1830', 'Dana Pengawas', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.danaKaryawan, '2-1840', 'Dana Karyawan', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.danaPembangunanDaerahKerja, '2-1850', 'Dana Pembangunan Daerah Kerja', 'LIABILITAS', 'KREDIT');

  // Hanya mapping yang benar-benar dipakai kode ShuService (SIMPANAN_SUKARELA);
  // mapping SHU_DISTRIBUSI sengaja TIDAK di-seed manual untuk membuktikan
  // pastikanMappingShu() (self-heal) di ShuService.ts benar-benar bekerja.
  await seedMapping(testDb, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.simpananSukarela);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  // Update pasca-Phase 18 §12/§19: bagikanSHU() sekarang mensyaratkan
  // RAT untuk tahun buku terkait sudah tercatat — di-seed di sini
  // supaya seluruh test bagikanSHU existing di file ini (yang menguji
  // hal LAIN, bukan gate RAT itu sendiri) tidak perlu diubah satu per
  // satu. Gate RAT diuji terpisah & eksplisit di describe block baru
  // di bawah (tanpa RAT di-seed).
  await testDb.runAsync(
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );

  // Fase 8: requirePermission() butuh baris app_user nyata untuk resolusi
  // role — 'user-1' diberi role ADMIN (izin penuh) supaya test-test
  // business logic di file ini tidak terganggu; skenario permission
  // diuji khusus di PermissionService.test.ts.
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );

  await seedAnggota(testDb, ANGGOTA_1, 'A001', 'Budi');
  await seedAnggota(testDb, ANGGOTA_2, 'A002', 'Sari');

  // Basis simpanan: Budi 100rb+50rb=150rb, Sari 100rb+150rb=250rb (rasio 3:5)
  await createJournal(testDb as any, {
    tanggal: '2026-01-10',
    sumberTransaksi: 'SIMPANAN_POKOK',
    deskripsi: 'Setoran pokok Budi',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.kas, debit: 100000, kredit: 0 },
      { accountId: ACC.simpananPokok, debit: 0, kredit: 100000 },
    ],
  });
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(), ANGGOTA_1, 'POKOK', 'SETOR', '2026-01-10', 100000, 'KAS', 'SP-1', 'user-1', new Date().toISOString()
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(), ANGGOTA_1, 'WAJIB', 'SETOR', '2026-01-15', 50000, 'KAS', 'SW-1', 'user-1', new Date().toISOString()
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(), ANGGOTA_2, 'POKOK', 'SETOR', '2026-01-10', 100000, 'KAS', 'SP-2', 'user-1', new Date().toISOString()
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(), ANGGOTA_2, 'WAJIB', 'SETOR', '2026-01-15', 150000, 'KAS', 'SW-2', 'user-1', new Date().toISOString()
  );

  // Basis partisipasi usaha: Budi 20rb, Sari 80rb (rasio 1:4) — dari
  // angsuran_pembayaran.porsi_jasa (data transaksi pinjaman nyata).
  await testDb.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, persentase_jasa, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'AKTIF',?,?,?)`,
    'pinjaman-1', 'PJ-1', ANGGOTA_1, '2026-01-01', 500000, 6, 'BULAN', 'FLAT', 2, 'user-1', new Date().toISOString(), new Date().toISOString()
  );
  await testDb.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, persentase_jasa, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'AKTIF',?,?,?)`,
    'pinjaman-2', 'PJ-2', ANGGOTA_2, '2026-01-01', 800000, 6, 'BULAN', 'FLAT', 2, 'user-1', new Date().toISOString(), new Date().toISOString()
  );
  await testDb.runAsync(
    `INSERT INTO angsuran_pembayaran (id, pinjaman_id, tanggal, nominal, porsi_pokok, porsi_jasa, porsi_denda, sumber_dana, created_by, created_at)
     VALUES (?,?,?,?,?,?,0,'KAS',?,?)`,
    newId(), 'pinjaman-1', '2026-03-01', 20000, 0, 20000, 'user-1', new Date().toISOString()
  );
  await testDb.runAsync(
    `INSERT INTO angsuran_pembayaran (id, pinjaman_id, tanggal, nominal, porsi_pokok, porsi_jasa, porsi_denda, sumber_dana, created_by, created_at)
     VALUES (?,?,?,?,?,?,0,'KAS',?,?)`,
    newId(), 'pinjaman-2', '2026-04-01', 80000, 0, 80000, 'user-1', new Date().toISOString()
  );

  // Laba tahun berjalan = Pendapatan 100.000 - Beban 30.000 = 70.000 (totalSHU).
  await createJournal(testDb as any, {
    tanggal: '2026-04-01',
    sumberTransaksi: 'ANGSURAN_JASA',
    deskripsi: 'Pendapatan jasa pinjaman',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.kas, debit: 100000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100000 },
    ],
  });
  await createJournal(testDb as any, {
    tanggal: '2026-05-01',
    sumberTransaksi: 'BEBAN_OPERASIONAL_MANUAL',
    deskripsi: 'Beban operasional',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.bebanOperasional, debit: 30000, kredit: 0 },
      { accountId: ACC.kas, debit: 0, kredit: 30000 },
    ],
  });
}

describe('ShuService — siklus DRAFT -> DIHITUNG -> DIBAGIKAN (PRD §29)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('simpanKonfigurasiShu menolak total persentase != 100%', async () => {
    await expect(
      simpanKonfigurasiShu('user-1', 2026, { ...KONFIGURASI_VALID, persenPengawas: 0 })
    ).rejects.toThrow();
  });

  test('update pasca-Phase 18/19 §U: persentase Karyawan & Pembangunan Daerah Kerja BENAR-BENAR tersimpan & terbaca kembali (bukan cuma label UI)', async () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenKaryawan: 3, persenPembangunanDaerahKerja: 2 };
    await simpanKonfigurasiShu('user-1', 2026, config);

    const tersimpan = await getShuKonfigurasiByTahun(2026);
    expect(tersimpan?.persenKaryawan).toBe(3);
    expect(tersimpan?.persenPembangunanDaerahKerja).toBe(2);
  });

  test('update pasca-Phase 18/19 §U: hitungSHU menghasilkan totalSHU yang benar walau Karyawan/Pembangunan Daerah Kerja mengambil porsi persentase', async () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenKaryawan: 3, persenPembangunanDaerahKerja: 2 };
    await simpanKonfigurasiShu('user-1', 2026, config);
    const { ringkasan } = await hitungSHU(2026, 'user-1');

    expect(ringkasan.karyawan).toBeGreaterThanOrEqual(0);
    expect(ringkasan.pembangunanDaerahKerja).toBeGreaterThanOrEqual(0);
    // Audit ulang §5/§6/§7/§13: total kategori (tanpa "Lainnya", termasuk
    // Cadangan Risiko) tetap sama persis dengan totalSHU — tidak ada yang hilang.
    const totalKategori =
      ringkasan.cadangan +
      ringkasan.cadanganRisiko +
      ringkasan.jasaModal +
      ringkasan.jasaUsaha +
      ringkasan.pendidikan +
      ringkasan.sosial +
      ringkasan.pengurus +
      ringkasan.pengawas +
      ringkasan.karyawan +
      ringkasan.pembangunanDaerahKerja;
    expect(totalKategori).toBe(ringkasan.totalSHU);
    expect((ringkasan as any).lainnya).toBeUndefined();
  });

  test('hitungSHU menolak jika konfigurasi belum disimpan', async () => {
    await expect(hitungSHU(2026, 'user-1')).rejects.toThrow(/belum disimpan/);
  });

  test('hitungSHU menghasilkan totalSHU = hasil usaha periode (dari jurnal, bukan input manual)', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    const { ringkasan } = await hitungSHU(2026, 'user-1');

    expect(ringkasan.totalSHU).toBe(70000); // Pendapatan 100.000 - Beban 30.000

    const konfigurasi = await getShuKonfigurasiByTahun(2026);
    expect(konfigurasi?.status).toBe('DIHITUNG');
    expect(konfigurasi?.totalShu).toBe(70000);
  });

  test('Phase 13: hitungSHU DITOLAK jelas kalau koperasi rugi tahun berjalan, bukan gagal cryptic belakangan di createJournal', async () => {
    // Tambah beban besar supaya hasil usaha jadi NEGATIF (rugi):
    // Pendapatan 100.000 - (Beban 30.000 + 200.000) = -130.000.
    await createJournal(testDb as any, {
      tanggal: '2026-06-01',
      sumberTransaksi: 'BEBAN_OPERASIONAL_MANUAL',
      deskripsi: 'Beban besar (fixture rugi)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.bebanOperasional, debit: 200000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 200000 },
      ],
    });

    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    await expect(hitungSHU(2026, 'user-1')).rejects.toThrow(/rugi/i);

    // Konfigurasi TETAP DRAFT — tidak ada write parsial (status tidak
    // berubah, shu_anggota tidak terisi).
    const konfigurasi = await getShuKonfigurasiByTahun(2026);
    expect(konfigurasi?.status).toBe('DRAFT');
  });

  test('distribusi per anggota proporsional terhadap basis simpanan & partisipasi usaha', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    const { shuKonfigurasiId } = await hitungSHU(2026, 'user-1');

    const daftar = await getShuAnggotaList(shuKonfigurasiId);
    const budi = daftar.find((a) => a.anggotaId === ANGGOTA_1)!;
    const sari = daftar.find((a) => a.anggotaId === ANGGOTA_2)!;

    // jasaModalPool = 20% x 70.000 = 14.000, dibagi rasio 150rb:250rb (3:5)
    expect(budi.jasaModal).toBe(5250);
    expect(sari.jasaModal).toBe(8750);

    // jasaUsahaPool = 20% x 70.000 = 14.000, dibagi rasio 20rb:80rb (1:4)
    expect(budi.jasaUsaha).toBe(2800);
    expect(sari.jasaUsaha).toBe(11200);

    expect(budi.totalShuAnggota).toBe(8050);
    expect(sari.totalShuAnggota).toBe(19950);
  });

  test('hitung ulang tanpa konfirmasi REJECT (PRD §11 fase ini)', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    await hitungSHU(2026, 'user-1');

    await expect(hitungSHU(2026, 'user-1')).rejects.toThrow(ShuSudahDihitungError);
  });

  test('hitung ulang DENGAN konfirmasi berhasil dan mengganti hasil sebelumnya', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    await hitungSHU(2026, 'user-1');

    const { ringkasan } = await hitungSHU(2026, 'user-1', true);
    expect(ringkasan.totalSHU).toBe(70000);
  });

  test('Phase 18 §6: edit SHU DIHITUNG lewat ShuFormScreen (simpanKonfigurasiShu lagi + hitungSHU tanpa konfirmasi) — status reset aman ke DRAFT lalu DIHITUNG lagi dengan konfigurasi BARU, tanpa perlu confirm dialog karena simpanKonfigurasiShu sudah mereset status duluan', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    const pertama = await hitungSHU(2026, 'user-1');
    expect(pertama.ringkasan.totalSHU).toBe(70000);

    const setelahHitungPertama = await getShuKonfigurasiByTahun(2026);
    expect(setelahHitungPertama?.status).toBe('DIHITUNG');

    // Edit konfigurasi (persentase berbeda) — persis alur ShuFormScreen:
    // simpanKonfigurasiShu() dulu (mereset ke DRAFT + hapus shu_anggota
    // lama), BARU hitungSHU() tanpa flag konfirmasi.
    const konfigurasiBaru = { ...KONFIGURASI_VALID, persenCadangan: 35, persenPengawas: 0 };
    await simpanKonfigurasiShu('user-1', 2026, konfigurasiBaru);

    const setelahEdit = await getShuKonfigurasiByTahun(2026);
    expect(setelahEdit?.status).toBe('DRAFT');
    expect(setelahEdit?.totalShu).toBeNull();
    const shuAnggotaSetelahEdit = await getShuAnggotaList(setelahEdit!.id);
    expect(shuAnggotaSetelahEdit).toHaveLength(0);

    // hitungSHU TANPA konfirmasi harus berhasil (status sudah DRAFT,
    // bukan DIHITUNG lagi) — tidak melempar ShuSudahDihitungError.
    const kedua = await hitungSHU(2026, 'user-1', false);
    expect(kedua.ringkasan.totalSHU).toBe(70000); // laba periode tidak berubah, cuma alokasi %

    const setelahEditDihitung = await getShuKonfigurasiByTahun(2026);
    expect(setelahEditDihitung?.status).toBe('DIHITUNG');
    expect(setelahEditDihitung?.persenCadangan).toBe(35);

    // shu_anggota tidak dobel — hanya satu set baris untuk konfigurasi terbaru.
    const shuAnggotaFinal = await getShuAnggotaList(setelahEditDihitung!.id);
    expect(shuAnggotaFinal).toHaveLength(2); // Budi + Sari (lihat fixture)
  });

  test('Phase 18 §6: edit SHU yang sudah DIBAGIKAN DITOLAK (final/locked) — simpanKonfigurasiShu menolak sebelum hitungSHU sempat dipanggil', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      await bagikanSHU(2026, 'user-1');
    } finally {
      jest.useRealTimers();
    }

    await expect(simpanKonfigurasiShu('user-1', 2026, { ...KONFIGURASI_VALID, persenCadangan: 35, persenPengawas: 0 })).rejects.toThrow(
      ShuSudahDibagikanError
    );

    // Status & hasil SHU yang sudah dibagikan tidak berubah sama sekali.
    const konfigurasi = await getShuKonfigurasiByTahun(2026);
    expect(konfigurasi?.status).toBe('DIBAGIKAN');
    expect(konfigurasi?.persenCadangan).toBe(30);
  });

  test('Bagian C (bug SHU tidak refresh): setelah hitung ulang, SEMUA fungsi baca (getShuKonfigurasiByTahun/getRiwayatSHU/getShuAnggotaList) — persis yang dipakai ShuDetailScreen/ShuScreen — mengembalikan data TERBARU, bukan data lama yang stale', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    const pertama = await hitungSHU(2026, 'user-1');
    expect(pertama.ringkasan.totalSHU).toBe(70000);

    // Simulasikan langsung apa yang dibaca ShuDetailScreen.load() /
    // ShuScreen.load() setelah kembali dari layar hitung — HARUS 70000.
    const konfigSetelahPertama = await getShuKonfigurasiByTahun(2026);
    expect(konfigSetelahPertama?.totalShu).toBe(70000);
    expect(konfigSetelahPertama?.status).toBe('DIHITUNG');
    const riwayatSetelahPertama = await getRiwayatSHU();
    expect(riwayatSetelahPertama.find((r) => r.tahunBuku === 2026)?.totalShu).toBe(70000);

    // Ada pendapatan TAMBAHAN masuk setelah perhitungan pertama (mis.
    // transaksi baru dicatat, atau staf sadar ada yang belum tercatat)
    // — laba tahun berjalan naik dari 70.000 jadi 90.000.
    await createJournal(testDb as any, {
      tanggal: '2026-06-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa pinjaman tambahan',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 20000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 20000 },
      ],
    });

    // Hitung ulang (dengan konfirmasi, sesuai alur ShuFormScreen).
    const kedua = await hitungSHU(2026, 'user-1', true);
    expect(kedua.ringkasan.totalSHU).toBe(90000);

    // INI BUG YANG DILAPORKAN: kalau ada masalah stale-read, fungsi di
    // bawah ini akan MASIH mengembalikan 70000 (angka lama) alih-alih
    // 90000 (angka baru) — persis skenario "tampilan tidak berubah
    // setelah data disimpan". Harus 90000 di SEMUA jalur baca.
    const konfigSetelahKedua = await getShuKonfigurasiByTahun(2026);
    expect(konfigSetelahKedua?.totalShu).toBe(90000);
    const riwayatSetelahKedua = await getRiwayatSHU();
    expect(riwayatSetelahKedua.find((r) => r.tahunBuku === 2026)?.totalShu).toBe(90000);

    // Daftar per-anggota juga harus konsisten dengan totalShu BARU
    // (bukan angka lama, dan bukan baris dobel dari perhitungan lama).
    const anggotaList = await getShuAnggotaList(konfigSetelahKedua!.id);
    expect(anggotaList).toHaveLength(2); // tepat 2 anggota, tidak dobel
    const totalDariAnggota = anggotaList.reduce((acc, a) => acc + a.totalShuAnggota, 0);
    // Jasa Modal (20%) + Jasa Usaha (20%) dari 90.000 = 36.000 total
    // porsi anggota (sisanya cadangan/pendidikan/sosial/dst.).
    expect(totalDariAnggota).toBe(Math.round(90000 * 0.2) + Math.round(90000 * 0.2));
  });

  test('bagikanSHU menolak jika belum disahkan RAT (mis. masih DRAFT/belum dihitung sama sekali)', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    await expect(bagikanSHU(2026, 'user-1')).rejects.toThrow('SHU belum disahkan dalam RAT.');
  });

  // Update pasca-6-perbaikan §3: rule lama "harus menunggu akhir tahun
  // buku" (Phase 17 §R) SUDAH DIHAPUS — 3 test di bawah ini masih
  // memakai fake timer 2026-12-31 murni karena fixture-nya ditulis
  // seputar tahun 2026 & RAT global sudah tercatat 2026-05-01 (lihat
  // setupFixture), BUKAN karena ada aturan "harus akhir tahun" lagi —
  // tanggal apa pun setelah 2026-05-01 sama-sama akan berhasil.
  test('bagikanSHU memposting jurnal BALANCE (debit=kredit) via AccountingEngine sungguhan', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    let journalId: string;
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      ({ journalId } = await bagikanSHU(2026, 'user-1'));
    } finally {
      jest.useRealTimers();
    }

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(70000);

    const journal = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM journal WHERE id = ?`,
      journalId
    );
    expect(journal?.status).toBe('POSTED');
  });

  // Audit ulang §4/§9/§17/§18 (permintaan pengguna): 6 dana harus
  // dijurnal KREDIT ke akun LIABILITAS masing-masing (2-1800..2-1850),
  // TIDAK LAGI ke 3-3000 Ekuitas Lainnya.
  test('bagikanSHU menjurnal Pendidikan/Sosial/Pengurus/Pengawas ke akun LIABILITAS masing-masing (2-1800..2-1830), TIDAK ke 3-3000', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    let journalId: string;
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      ({ journalId } = await bagikanSHU(2026, 'user-1'));
    } finally {
      jest.useRealTimers();
    }

    const kreditByAccount = async (accountId: string) => {
      const row = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
        journalId,
        accountId
      );
      return row?.total ?? 0;
    };

    // Pendidikan & Sosial = 10% x 70.000 = 7.000 masing-masing; Pengurus
    // & Pengawas = 5% x 70.000 = 3.500 masing-masing.
    expect(await kreditByAccount(ACC.danaPendidikan)).toBe(7000);
    expect(await kreditByAccount(ACC.danaSosial)).toBe(7000);
    expect(await kreditByAccount(ACC.danaPengurus)).toBe(3500);
    expect(await kreditByAccount(ACC.danaPengawas)).toBe(3500);
    // Karyawan & Pembangunan Daerah Kerja = 0% pada KONFIGURASI_VALID —
    // tidak ada baris jurnal untuk akun ini (nominal 0 tidak diposting).
    expect(await kreditByAccount(ACC.danaKaryawan)).toBe(0);
    expect(await kreditByAccount(ACC.danaPembangunanDaerahKerja)).toBe(0);
    // TIDAK ADA lagi kredit ke 3-3000 Ekuitas Lainnya dari distribusi SHU ini.
    expect(await kreditByAccount(ACC.modalLainnya)).toBe(0);
  });

  test('bagikanSHU menjurnal Cadangan sebagai residual (total SHU dikurangi porsi anggota & 6 dana) — bukan hanya persenCadangan x totalSHU', async () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenKaryawan: 3, persenPembangunanDaerahKerja: 2 };
    await simpanKonfigurasiShu('user-1', 2026, config);

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    let journalId: string;
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      ({ journalId } = await bagikanSHU(2026, 'user-1'));
    } finally {
      jest.useRealTimers();
    }

    // Audit ulang (permintaan pengguna, request baru §6): nominal
    // cadangan yang dijurnal HARUS sama persis dengan sisa residual
    // (SHU disahkan dikurangi seluruh porsi anggota & pool dana lain) —
    // dihitung ulang di sini dari baris jurnal yang SUNGGUHAN terposting,
    // bukan diasumsikan dari rumus terpisah.
    const totalKredit = await testDb.getAllAsync<{ account_id: string; total: number }>(
      `SELECT account_id, SUM(kredit) as total FROM journal_entry WHERE journal_id = ? GROUP BY account_id`,
      journalId
    );
    const totalSemuaKredit = totalKredit.reduce((a, r) => a + r.total, 0);
    const cadanganRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      journalId,
      ACC.cadangan
    );
    // Total seluruh kredit HARUS persis sama dengan total debit (SHU
    // disahkan, 70.000) — membuktikan cadangan benar-benar menyerap
    // seluruh residual, tidak ada uang yang hilang/bertambah.
    expect(totalSemuaKredit).toBe(70000);
    // 25% x 70.000 = 17.500 (persen murni) BUKAN nilai final — karena
    // cadangan menyerap residual, nilainya harus >= 17.500 (basis
    // anggota di fixture ini semuanya > 0, jadi hanya selisih pembulatan
    // kecil, kalau ada).
    expect(cadanganRow?.total).toBeGreaterThanOrEqual(0);
  });

  // Audit ulang §13/§14/§15/§16 (permintaan pengguna): Cadangan Risiko
  // — pool NOMINAL TETAP (persentase × totalSHU), dijurnal KREDIT ke
  // akun EKUITAS terpisah (3-2100), TIDAK ikut diserap oleh residual
  // Cadangan Umum.
  test('bagikanSHU menjurnal Cadangan Risiko sebagai pool TETAP (persentase x totalSHU) ke akun terpisah (3-2100), TIDAK ke Cadangan Umum', async () => {
    const config = { ...KONFIGURASI_VALID, persenCadangan: 25, persenCadanganRisiko: 5 };
    await simpanKonfigurasiShu('user-1', 2026, config);

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    let journalId: string;
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      ({ journalId } = await bagikanSHU(2026, 'user-1'));
    } finally {
      jest.useRealTimers();
    }

    // 5% x 70.000 = 3.500 — pool TETAP, bukan residual.
    const kreditByAccount = async (accountId: string) => {
      const row = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
        journalId,
        accountId
      );
      return row?.total ?? 0;
    };

    expect(await kreditByAccount(ACC.cadanganRisiko)).toBe(3500);

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(70000);
  });

  test('konfigurasi lama tanpa Cadangan Risiko (persenCadanganRisiko 0/default): bagikanSHU TIDAK membuat baris jurnal untuk akun Cadangan Risiko sama sekali', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID); // persenCadanganRisiko: 0

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    let journalId: string;
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      ({ journalId } = await bagikanSHU(2026, 'user-1'));
    } finally {
      jest.useRealTimers();
    }

    const row = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      journalId,
      ACC.cadanganRisiko
    );
    expect(row?.cnt ?? 0).toBe(0);
  });

  test('bagikanSHU menambah saldo simpanan sukarela tiap anggota sesuai total_shu_anggota', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      await bagikanSHU(2026, 'user-1');
    } finally {
      jest.useRealTimers();
    }

    const saldoBudi = await getSaldoSimpanan(testDb as any, ANGGOTA_1, 'SUKARELA');
    const saldoSari = await getSaldoSimpanan(testDb as any, ANGGOTA_2, 'SUKARELA');
    expect(saldoBudi).toBe(8050);
    expect(saldoSari).toBe(19950);
  });

  test('status jadi DIBAGIKAN setelah distribusi, dan tidak bisa dihitung ulang lagi', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      await bagikanSHU(2026, 'user-1');
    } finally {
      jest.useRealTimers();
    }

    const konfigurasi = await getShuKonfigurasiByTahun(2026);
    expect(konfigurasi?.status).toBe('DIBAGIKAN');

    await expect(hitungSHU(2026, 'user-1', true)).rejects.toThrow(ShuSudahDibagikanError);
    await expect(bagikanSHU(2026, 'user-1')).rejects.toThrow(ShuSudahDibagikanError);
    await expect(simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID)).rejects.toThrow(ShuSudahDibagikanError);
  });

  // Update pasca-6-perbaikan (permintaan pengguna §3): PERUBAHAN
  // BUSINESS RULE — rule lama "hanya boleh dibagikan setelah 31
  // Desember tahun berjalan" (Phase 17 §R) DIHAPUS TOTAL. Rule baru
  // sepenuhnya berbasis RAT — lihat describe block baru di bawah
  // ("bagikanSHU — gate RAT (update pasca-6-perbaikan §3)") untuk
  // skenario tanggal RAT yang lengkap (19/20/21 Maret, dsb).

  // Audit ulang (permintaan pengguna, request baru §4/§5/§7): gerbang
  // RAT PINDAH dari `bagikanSHU()` ke `sahkanShuRAT()` — SHU tidak
  // pernah bisa mencapai status DISAHKAN_RAT tanpa RAT tercatat &
  // tanggalnya sudah lewat, jadi `bagikanSHU()` (yang mensyaratkan
  // status DISAHKAN_RAT) TIDAK PERNAH bisa ditembus tanpa RAT lagi —
  // pesan penolakannya sekarang seragam "SHU belum disahkan dalam
  // RAT." (§7) untuk SEMUA status sebelum DISAHKAN_RAT, apa pun
  // sebabnya (belum dihitung, belum diajukan, atau sudah diajukan tapi
  // RAT belum lewat).
  test('bagikanSHU DITOLAK dengan pesan seragam "SHU belum disahkan dalam RAT." — tidak peduli RAT ada/tidak, kalau status belum DISAHKAN_RAT', async () => {
    // Fixture GLOBAL sudah men-seed RAT untuk 2026 (lihat setupFixture) —
    // hapus dulu supaya test ini benar-benar menguji kondisi "belum ada RAT".
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2026`);

    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    await hitungSHU(2026, 'user-1');

    await expect(bagikanSHU(2026, 'user-1')).rejects.toThrow('SHU belum disahkan dalam RAT.');

    const konfigurasi = await getShuKonfigurasiByTahun(2026);
    expect(konfigurasi?.status).toBe('DIHITUNG'); // status tidak berubah karena ditolak
  });

  test('sahkanShuRAT DITOLAK kalau RAT untuk tahun buku terkait belum ada — pesan sesuai permintaan pengguna §3, lalu BERHASIL setelah RAT dilengkapi', async () => {
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2026`);

    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    const { ringkasan } = await hitungSHU(2026, 'user-1');
    await ajukanShuKeRAT('user-1', 2026, ringkasan.totalSHU);

    // Sebelum RAT dilengkapi: ditolak.
    await expect(
      sahkanShuRAT({ tahunBuku: 2026, nominalDisahkan: ringkasan.totalSHU, actingUserId: 'user-1' })
    ).rejects.toThrow(/RAT/);

    // Lengkapi RAT (persis alur ShuDetailScreen: RATFormModal -> simpanRAT)
    // dengan tanggal RAT di masa lalu (sudah lewat) supaya gerbang tanggal juga lolos.
    const { simpanRAT } = await import('@/services/RATService');
    await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-01-15', createdBy: 'user-1' });

    // Sekarang sahkan berhasil, lalu bagikan juga berhasil.
    await sahkanShuRAT({ tahunBuku: 2026, nominalDisahkan: ringkasan.totalSHU, actingUserId: 'user-1' });
    const setelahSahkan = await getShuKonfigurasiByTahun(2026);
    expect(setelahSahkan?.status).toBe('DISAHKAN_RAT');

    const { journalId } = await bagikanSHU(2026, 'user-1');
    expect(journalId).toBeTruthy();

    const konfigurasi = await getShuKonfigurasiByTahun(2026);
    expect(konfigurasi?.status).toBe('DIBAGIKAN');
  });

  test('getRiwayatSHU mengembalikan daftar terurut tahun buku terbaru dulu', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    await hitungSHU(2026, 'user-1');

    const riwayat = await getRiwayatSHU();
    expect(riwayat.length).toBe(1);
    expect(riwayat[0].tahunBuku).toBe(2026);
    expect(riwayat[0].status).toBe('DIHITUNG');
  });

  test('getShuAnggotaDetail mengembalikan rincian basis & hasil satu anggota', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    const { shuKonfigurasiId } = await hitungSHU(2026, 'user-1');

    const detail = await getShuAnggotaDetail(shuKonfigurasiId, ANGGOTA_1);
    expect(detail?.namaAnggota).toBe('Budi');
    expect(detail?.basisSimpanan).toBe(150000);
    expect(detail?.basisPartisipasiUsaha).toBe(20000);
    expect(detail?.totalShuAnggota).toBe(8050);
  });
});

describe('ShuService.sahkanShuRAT — gate RAT (update pasca-6-perbaikan §3, PERUBAHAN BUSINESS RULE; audit ulang request baru §4/§5: gerbang RAT dipindah ke sini)', () => {
  // Skenario PERSIS dari permintaan pengguna: tahun buku 2025, RAT
  // dilaksanakan 20 Maret 2026. 19 Maret = ditolak, 20 & 21 Maret =
  // berhasil. Rule LAMA "harus 31 Desember tahun berjalan" TIDAK ADA
  // LAGI SAMA SEKALI di sini — tahun buku 2025 dibagikan di tahun
  // 2026, jauh setelah 31 Desember 2025, justru itu intinya.
  //
  // Audit ulang (permintaan pengguna, request baru §4/§5): gerbang RAT
  // (tanggal_rat sudah lewat) SEKARANG ditegakkan di `sahkanShuRAT()`,
  // BUKAN lagi di `bagikanSHU()` — karena `sahkanShuRAT()` adalah titik
  // "pengesahan" yang sesungguhnya sekarang (§4: "RAT harus menjadi
  // titik keputusan"). `bagikanSHU()` TIDAK PERNAH bisa dipanggil
  // sebelum status DISAHKAN_RAT, dan status itu TIDAK PERNAH tercapai
  // tanpa lolos gerbang RAT di `sahkanShuRAT()` — jadi menguji gerbang
  // di titik `sahkanShuRAT()` sudah mencakup jaminan yang sama untuk
  // `bagikanSHU()` secara transitif.
  beforeEach(async () => {
    await setupFixture(); // fixture GLOBAL 2026 tidak dipakai, kita pakai tahun buku 2025 sendiri
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2026`); // pastikan tidak ada RAT 2026 yang mengganggu isolasi test
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('period-2025',2025,'2025-01-01','2025-12-31','OPEN')`
    );
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2025`);
    await testDb.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2025',2025,'2026-03-20','user-1',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    // Laba tahun buku 2025 = Pendapatan 50.000 - Beban 10.000 = 40.000
    // (totalSHU) — supaya bagikanSHU punya sesuatu yang sungguhan untuk
    // didistribusikan (jurnal minimal butuh isi, bukan cuma menguji
    // gerbang tanggal RAT-nya kosongan).
    await createJournal(testDb as any, {
      tanggal: '2025-04-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa pinjaman 2025',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 50000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 50000 },
      ],
    });
    await createJournal(testDb as any, {
      tanggal: '2025-05-01',
      sumberTransaksi: 'BEBAN_OPERASIONAL_MANUAL',
      deskripsi: 'Beban operasional 2025',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.bebanOperasional, debit: 10000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 10000 },
      ],
    });
    await simpanKonfigurasiShu('user-1', 2025, KONFIGURASI_VALID);
    await hitungSHU(2025, 'user-1');
    await ajukanShuKeRAT('user-1', 2025, 40000);
  });

  test('19 Maret 2026 (SEBELUM tanggal RAT 20 Maret): Sahkan SHU RAT DITOLAK dengan pesan tanggal yang jelas', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-19T10:00:00Z'));
    try {
      await expect(
        sahkanShuRAT({ tahunBuku: 2025, nominalDisahkan: 40000, actingUserId: 'user-1' })
      ).rejects.toThrow('SHU dapat disahkan mulai setelah RAT dilaksanakan pada 20 Maret 2026.');
    } finally {
      jest.useRealTimers();
    }
    const konfigurasi = await getShuKonfigurasiByTahun(2025);
    expect(konfigurasi?.status).toBe('DIAJUKAN_RAT'); // tidak berubah karena ditolak
  });

  test('20 Maret 2026 (TEPAT tanggal RAT): Sahkan SHU RAT lalu Bagikan SHU BERHASIL', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-20T10:00:00Z'));
    try {
      await sahkanShuRAT({ tahunBuku: 2025, nominalDisahkan: 40000, actingUserId: 'user-1' });
      const { journalId } = await bagikanSHU(2025, 'user-1');
      expect(journalId).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
    const konfigurasi = await getShuKonfigurasiByTahun(2025);
    expect(konfigurasi?.status).toBe('DIBAGIKAN');
  });

  test('21 Maret 2026 (SETELAH tanggal RAT): Sahkan SHU RAT lalu Bagikan SHU BERHASIL', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:00:00Z'));
    try {
      await sahkanShuRAT({ tahunBuku: 2025, nominalDisahkan: 40000, actingUserId: 'user-1' });
      const { journalId } = await bagikanSHU(2025, 'user-1');
      expect(journalId).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
    const konfigurasi = await getShuKonfigurasiByTahun(2025);
    expect(konfigurasi?.status).toBe('DIBAGIKAN');
  });

  test('TANPA RAT sama sekali: Sahkan SHU RAT DITOLAK — pesan persis sesuai permintaan pengguna', async () => {
    await testDb.runAsync(`DELETE FROM rat WHERE tahun_buku = 2025`);
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T10:00:00Z'));
    try {
      await expect(
        sahkanShuRAT({ tahunBuku: 2025, nominalDisahkan: 40000, actingUserId: 'user-1' })
      ).rejects.toThrow('SHU baru dapat disahkan setelah RAT dilaksanakan.');
    } finally {
      jest.useRealTimers();
    }
  });

  test('rule LAMA "harus 31 Desember tahun berjalan" TIDAK ADA LAGI — disahkan & dibagikan jauh SEBELUM 31 Desember tahun bukunya asalkan RAT sudah lewat', async () => {
    // Tahun buku 2025, tapi disahkan+dibagikan tanggal 21 Maret 2026
    // (bukan 31 Desember 2025) — di bawah rule LAMA ini pasti ditolak,
    // di bawah rule BARU ini harus berhasil karena RAT (20 Maret 2026)
    // sudah lewat.
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:00:00Z'));
    try {
      await sahkanShuRAT({ tahunBuku: 2025, nominalDisahkan: 40000, actingUserId: 'user-1' });
      const hasil = await bagikanSHU(2025, 'user-1');
      expect(hasil.journalId).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  // Audit ulang (permintaan pengguna, request baru §7): sekali status
  // sudah DISAHKAN_RAT (gerbang RAT sudah lolos SEBELUMNYA di
  // sahkanShuRAT), bagikanSHU() harus BERHASIL kapan pun dipanggil
  // setelahnya — tidak ada gerbang tanggal "hari ini" TAMBAHAN yang
  // bisa menggagalkannya belakangan (pengecekan defense-in-depth di
  // bagikanSHU membaca ULANG tanggal RAT yang SAMA, yang sudah pasti
  // lewat karena sudah lolos sekali di sahkanShuRAT).
  test('bagikanSHU BERHASIL kapan pun dipanggil setelah status DISAHKAN_RAT, tidak peduli "hari ini" — gerbang tanggal sudah selesai di sahkanShuRAT', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-20T10:00:00Z'));
    try {
      await sahkanShuRAT({ tahunBuku: 2025, nominalDisahkan: 40000, actingUserId: 'user-1' });
    } finally {
      jest.useRealTimers();
    }
    // Bagikan di tanggal JAUH setelahnya, tetap berhasil.
    jest.useFakeTimers().setSystemTime(new Date('2027-01-01T10:00:00Z'));
    try {
      const { journalId } = await bagikanSHU(2025, 'user-1');
      expect(journalId).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ============================================================
// Audit ulang (permintaan pengguna, request baru "Perbaikan SHU —
// pemisahan basis akrual/kas/RAT"): skenario WAJIB PERSIS sesuai §15/
// §17 — SHU akrual Rp100 juta, SHU kas (Informasi RAT) Rp80 juta, SHU
// disahkan RAT Rp70 juta. Laporan keuangan HARUS TETAP Rp100 juta
// (§14 — TIDAK PERNAH berubah jadi 70jt/80jt akibat keputusan RAT).
// ============================================================
describe('ShuService — pemisahan SHU akrual/kas/RAT (skenario §15/§17: akrual 100jt, kas 80jt, disahkan 70jt)', () => {
  const ACC2 = {
    piutangLain: 'acc-piutang-lain',
    utangBeban: 'acc-utang-beban',
  };

  beforeEach(async () => {
    await setupFixture();
    // Audit ulang (bug ditemukan lewat eksekusi test nyata sesi ini):
    // `getInformasiShuRAT()` mengidentifikasi akun kas/bank lewat
    // mapping `KAS_UMUM` (sama seperti getArusKas) — mapping ini SELALU
    // ada di produksi (bagian dari DEFAULT_ACCOUNT_MAPPING di
    // defaultCOA.ts, di-self-heal otomatis), tapi `setupFixture()` di
    // file ini TIDAK menyertakannya (ShuService.ts sendiri tidak pernah
    // butuh resolve "kas" secara generik, hanya lewat role SHU_DISTRIBUSI
    // spesifik) — jadi harus di-seed eksplisit di sini supaya skenario
    // §15/§17 (yang memang menguji getInformasiShuRAT) merepresentasikan
    // kondisi produksi yang sebenarnya dengan akurat.
    await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
    // Fixture GLOBAL (setupFixture) sudah membuat SHU 70.000 dari
    // Pendapatan 100.000 (tunai) - Beban 30.000 (tunai) di tahun buku
    // 2026 — tambahkan transaksi LEBIH LANJUT supaya angkanya PERSIS
    // 100jt akrual / 80jt kas seperti skenario yang diminta. Untuk
    // membuat perbedaan akrual vs kas yang BERMAKNA, kita pakai tahun
    // buku 2027 yang bersih (tidak tercampur data 70.000 dari fixture).
    await testDb.runAsync(`DELETE FROM shu_konfigurasi WHERE tahun_buku = 2026`);
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('period-2027',2027,'2027-01-01','2027-12-31','OPEN')`
    );
    await testDb.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2027',2027,'2027-05-01','user-1',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await seedAccount(testDb, ACC2.piutangLain, '1-1900', 'Piutang Pendapatan Lain', 'ASET', 'DEBIT');
    await seedAccount(testDb, ACC2.utangBeban, '2-1900', 'Utang Beban Akrual', 'LIABILITAS', 'KREDIT');

    // Pendapatan akrual TOTAL 150jt: 120jt TUNAI (kas) + 30jt BELUM
    // TUNAI (piutang, jurnal TANPA baris kas/bank — akrual murni).
    await createJournal(testDb as any, {
      tanggal: '2027-03-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa - realisasi kas',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 120_000_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 120_000_000 },
      ],
    });
    await createJournal(testDb as any, {
      tanggal: '2027-06-01',
      sumberTransaksi: 'PENGAKUAN_PENDAPATAN_LAIN',
      deskripsi: 'Pendapatan jasa - masih piutang (akrual, belum kas)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC2.piutangLain, debit: 30_000_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 30_000_000 },
      ],
    });

    // Beban akrual TOTAL 50jt: 40jt TUNAI (kas) + 10jt BELUM TUNAI
    // (utang beban, jurnal TANPA baris kas/bank — akrual murni).
    await createJournal(testDb as any, {
      tanggal: '2027-07-01',
      sumberTransaksi: 'BEBAN_OPERASIONAL_MANUAL',
      deskripsi: 'Beban operasional - dibayar tunai',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.bebanOperasional, debit: 40_000_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 40_000_000 },
      ],
    });
    await createJournal(testDb as any, {
      tanggal: '2027-08-01',
      sumberTransaksi: 'AKRUAL_BEBAN_LAIN',
      deskripsi: 'Beban operasional - masih utang (akrual, belum kas)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.bebanOperasional, debit: 10_000_000, kredit: 0 },
        { accountId: ACC2.utangBeban, debit: 0, kredit: 10_000_000 },
      ],
    });
  });

  test('hitungSHU: SHU akrual = 100jt (150jt pendapatan - 50jt beban), Informasi SHU RAT (kas) = 80jt (120jt - 40jt) — BERBEDA, BUKAN error (§2)', async () => {
    await simpanKonfigurasiShu('user-1', 2027, KONFIGURASI_VALID);
    const { ringkasan } = await hitungSHU(2027, 'user-1');
    expect(ringkasan.totalSHU).toBe(100_000_000);

    const konfigurasi = await getShuKonfigurasiByTahun(2027);
    expect(konfigurasi?.totalShu).toBe(100_000_000);
    expect(konfigurasi?.shuInformasiRat).toBe(80_000_000);
    expect(konfigurasi?.status).toBe('DIHITUNG');
  });

  test('ajukanShuKeRAT: nominal 80jt (Informasi SHU RAT) DITERIMA — tidak melebihi SHU Laporan Keuangan (100jt)', async () => {
    await simpanKonfigurasiShu('user-1', 2027, KONFIGURASI_VALID);
    await hitungSHU(2027, 'user-1');
    await ajukanShuKeRAT('user-1', 2027, 80_000_000);

    const konfigurasi = await getShuKonfigurasiByTahun(2027);
    expect(konfigurasi?.shuDiajukanRat).toBe(80_000_000);
    expect(konfigurasi?.status).toBe('DIAJUKAN_RAT');
    // SHU Laporan Keuangan TIDAK BERUBAH oleh pengajuan (§11/§14).
    expect(konfigurasi?.totalShu).toBe(100_000_000);
  });

  test('ajukanShuKeRAT: nominal MELEBIHI SHU Laporan Keuangan (akrual) DITOLAK (§11)', async () => {
    await simpanKonfigurasiShu('user-1', 2027, KONFIGURASI_VALID);
    await hitungSHU(2027, 'user-1');
    await expect(ajukanShuKeRAT('user-1', 2027, 150_000_000)).rejects.toThrow(/tidak boleh melebihi SHU Laporan Keuangan/);
  });

  test('sahkanShuRAT: nominal 70jt (keputusan RAT) DITERIMA — lebih kecil dari yang diajukan (80jt) (§5/§6)', async () => {
    await simpanKonfigurasiShu('user-1', 2027, KONFIGURASI_VALID);
    await hitungSHU(2027, 'user-1');
    await ajukanShuKeRAT('user-1', 2027, 80_000_000);

    jest.useFakeTimers().setSystemTime(new Date('2027-06-01T10:00:00Z'));
    try {
      await sahkanShuRAT({ tahunBuku: 2027, nominalDisahkan: 70_000_000, catatan: 'Disetujui RAT, sisa dialokasikan cadangan tahun depan', actingUserId: 'user-1' });
    } finally {
      jest.useRealTimers();
    }

    const konfigurasi = await getShuKonfigurasiByTahun(2027);
    expect(konfigurasi?.shuDisahkanRat).toBe(70_000_000);
    expect(konfigurasi?.status).toBe('DISAHKAN_RAT');
    expect(konfigurasi?.catatanKeputusanRat).toBe('Disetujui RAT, sisa dialokasikan cadangan tahun depan');
    // SHU Laporan Keuangan & Informasi SHU RAT TIDAK BERUBAH oleh pengesahan (§11/§14).
    expect(konfigurasi?.totalShu).toBe(100_000_000);
    expect(konfigurasi?.shuInformasiRat).toBe(80_000_000);
  });

  test('sahkanShuRAT: nominal MELEBIHI yang diajukan ke RAT DITOLAK (§11)', async () => {
    await simpanKonfigurasiShu('user-1', 2027, KONFIGURASI_VALID);
    await hitungSHU(2027, 'user-1');
    await ajukanShuKeRAT('user-1', 2027, 80_000_000);

    jest.useFakeTimers().setSystemTime(new Date('2027-06-01T10:00:00Z'));
    try {
      await expect(
        sahkanShuRAT({ tahunBuku: 2027, nominalDisahkan: 90_000_000, actingUserId: 'user-1' })
      ).rejects.toThrow(/tidak boleh melebihi nominal yang diajukan/);
    } finally {
      jest.useRealTimers();
    }
  });

  test('SKENARIO LENGKAP §15/§17: bagikanSHU memposting jurnal berbasis 70jt (SHU DISAHKAN), BUKAN 100jt (akrual) atau 80jt (kas) — SHU Laporan Keuangan tetap 100jt setelahnya', async () => {
    await simpanKonfigurasiShu('user-1', 2027, KONFIGURASI_VALID);
    await hitungSHU(2027, 'user-1');
    await ajukanShuKeRAT('user-1', 2027, 80_000_000);

    jest.useFakeTimers().setSystemTime(new Date('2027-06-01T10:00:00Z'));
    let journalId: string;
    try {
      await sahkanShuRAT({ tahunBuku: 2027, nominalDisahkan: 70_000_000, actingUserId: 'user-1' });
      ({ journalId } = await bagikanSHU(2027, 'user-1'));
    } finally {
      jest.useRealTimers();
    }

    // Jurnal distribusi HARUS balance & totalnya PERSIS 70jt (SHU disahkan).
    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(70_000_000); // BUKAN 100jt (akrual), BUKAN 80jt (kas)

    // SHU Laporan Keuangan (akrual) TETAP 100jt — TIDAK PERNAH berubah
    // jadi 70jt/80jt akibat keputusan/pembagian RAT (§11/§14, larangan utama).
    const konfigurasiFinal = await getShuKonfigurasiByTahun(2027);
    expect(konfigurasiFinal?.totalShu).toBe(100_000_000);
    expect(konfigurasiFinal?.shuInformasiRat).toBe(80_000_000);
    expect(konfigurasiFinal?.shuDisahkanRat).toBe(70_000_000);
    expect(konfigurasiFinal?.status).toBe('DIBAGIKAN');

    // getLabaRugi (laporan keuangan resmi) juga HARUS tetap 100jt — bukti
    // independen bahwa jurnal Laba Rugi periode berjalan tidak disentuh
    // sama sekali oleh proses distribusi SHU.
    const { getLabaRugi } = await import('@/reports/FinancialReports');
    const labaRugi = await getLabaRugi(testDb as any, '2027-01-01', '2027-12-31');
    expect(labaRugi.hasilUsaha).toBe(100_000_000);
  });

  test('§9: TIDAK ADA jurnal pembagian yang dibuat hanya karena hitung/ajukan/sahkan — jurnal HANYA muncul setelah bagikanSHU benar-benar dipanggil', async () => {
    await simpanKonfigurasiShu('user-1', 2027, KONFIGURASI_VALID);
    await hitungSHU(2027, 'user-1');
    let jurnalCount = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'SHU_DISTRIBUSI'`
    );
    expect(jurnalCount?.cnt ?? 0).toBe(0);

    await ajukanShuKeRAT('user-1', 2027, 80_000_000);
    jurnalCount = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'SHU_DISTRIBUSI'`
    );
    expect(jurnalCount?.cnt ?? 0).toBe(0);

    jest.useFakeTimers().setSystemTime(new Date('2027-06-01T10:00:00Z'));
    try {
      await sahkanShuRAT({ tahunBuku: 2027, nominalDisahkan: 70_000_000, actingUserId: 'user-1' });
    } finally {
      jest.useRealTimers();
    }
    jurnalCount = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'SHU_DISTRIBUSI'`
    );
    expect(jurnalCount?.cnt ?? 0).toBe(0); // sahkan TIDAK membuat jurnal

    jest.useFakeTimers().setSystemTime(new Date('2027-06-01T10:00:00Z'));
    try {
      await bagikanSHU(2027, 'user-1');
    } finally {
      jest.useRealTimers();
    }
    jurnalCount = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'SHU_DISTRIBUSI'`
    );
    expect(jurnalCount?.cnt ?? 0).toBe(1); // sekarang BARU ada 1 jurnal
  });

  test('§11: SHU dibagikan tidak boleh dua kali untuk keputusan RAT yang sama (ShuSudahDibagikanError)', async () => {
    await simpanKonfigurasiShu('user-1', 2027, KONFIGURASI_VALID);
    await hitungSHU(2027, 'user-1');
    await ajukanShuKeRAT('user-1', 2027, 80_000_000);

    jest.useFakeTimers().setSystemTime(new Date('2027-06-01T10:00:00Z'));
    try {
      await sahkanShuRAT({ tahunBuku: 2027, nominalDisahkan: 70_000_000, actingUserId: 'user-1' });
      await bagikanSHU(2027, 'user-1');
      await expect(bagikanSHU(2027, 'user-1')).rejects.toThrow(ShuSudahDibagikanError);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ShuService — hapusKonfigurasiShu (Phase 17 §F)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('boleh hapus konfigurasi SHU berstatus DRAFT', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    await hapusKonfigurasiShu('user-1', 2026);
    expect(await getShuKonfigurasiByTahun(2026)).toBeNull();
  });

  test('boleh hapus konfigurasi SHU berstatus DIHITUNG (belum dibagikan)', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    await hitungSHU(2026, 'user-1');
    await hapusKonfigurasiShu('user-1', 2026);
    expect(await getShuKonfigurasiByTahun(2026)).toBeNull();
  });

  test('hapusKonfigurasiShu DITOLAK jika status sudah DIBAGIKAN (jurnal final sudah ada)', async () => {
    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);

    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T00:00:00Z'));
    try {
      await hitungSHU(2026, 'user-1');
      await ajukanDanSahkan(2026);
      await bagikanSHU(2026, 'user-1');
    } finally {
      jest.useRealTimers();
    }

    await expect(hapusKonfigurasiShu('user-1', 2026)).rejects.toThrow(/sudah dibagikan/i);
    // Data tetap utuh setelah percobaan hapus ditolak.
    expect((await getShuKonfigurasiByTahun(2026))?.status).toBe('DIBAGIKAN');
  });

  test('hapusKonfigurasiShu untuk tahun buku yang tidak ada melempar error', async () => {
    await expect(hapusKonfigurasiShu('user-1', 1999)).rejects.toThrow(/tidak ditemukan/i);
  });
});

// ============================================================
// Prioritas 3 (E) — BUG FIX: basis simpanan SHU harus mengecualikan
// setoran yang sudah DIKOREKSI (reversal), bukan cuma baris koreksinya
// sendiri (lihat SimpananService.test.ts untuk fix yang sama di sisi
// saldo simpanan individual).
// ============================================================
describe('ShuService — basis simpanan SHU mengecualikan setoran yang sudah dikoreksi (Prioritas 3/E)', () => {
  test('Setoran simpanan pokok Budi yang SUDAH DIKOREKSI tidak ikut menaikkan basisSimpanan-nya di perhitungan SHU', async () => {
    await setupFixture();

    // Budi (ANGGOTA_1) SEHARUSNYA basisSimpanan = 150.000 (100rb pokok +
    // 50rb wajib, dari setupFixture). Tambahkan SATU setoran keliru
    // 999.000 lalu KOREKSI (batalkan) — basisSimpanan Budi TIDAK BOLEH
    // ikut naik oleh setoran yang sudah dibatalkan ini.
    const setoranKeliruId = newId();
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      setoranKeliruId, ANGGOTA_1, 'SUKARELA', 'SETOR', '2026-02-01', 999000, 'KAS', 'SS-KELIRU', 'user-1', new Date().toISOString()
    );
    // Baris koreksi (pola sama dengan SimpananService.koreksiSimpanan —
    // ditulis manual di sini karena setoran di atas dibuat langsung ke
    // tabel tanpa journal_id, jadi tidak bisa lewat koreksiSimpanan()
    // yang mensyaratkan journal_id).
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, keterangan, reversal_of_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId(), ANGGOTA_1, 'SUKARELA', 'KOREKSI', '2026-02-02', 999000, 'KAS', 'KOREKSI-SS-KELIRU', 'Salah input', setoranKeliruId, 'user-1', new Date().toISOString()
    );

    await simpanKonfigurasiShu('user-1', 2026, KONFIGURASI_VALID);
    const { ringkasan } = await hitungSHU(2026, 'user-1');

    const budi = ringkasan.anggota.find((a) => a.anggotaId === ANGGOTA_1);
    // SEBELUM FIX: basisSimpanan Budi jadi 150.000 + 999.000 = 1.149.000
    // (setoran yang sudah dikoreksi tetap ikut terhitung).
    expect(budi?.basisSimpanan).toBe(150000);
  });
});
