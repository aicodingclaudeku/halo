import { createTestDb, TestDb } from './testDb';

/**
 * PinjamanService.ts memakai getDb()/withTransaction() dari database/db.ts
 * secara internal. Teknik mock di sini SAMA PERSIS dengan ShuService.test.ts/
 * KasBankService.test.ts — lihat komentar di sana untuk penjelasan lengkap.
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
  ajukanPinjaman,
  simpanJadwalAngsuranCustom,
  cairkanPinjaman,
  editPencairanPinjaman,
  hapusPencairanPinjaman,
  bayarAngsuran,
  hitungTotalPelunasan,
  lunasiPinjaman,
  getJadwalAngsuran,
  getPinjamanDetail,
  listPinjaman,
  listAnggotaDenganPiutangAktif,
  hapusPiutangPinjaman,
  akadUlangPinjaman,
  getRiwayatAkadUlang,
  getAgunanPinjaman,
  getTujuanPinjaman,
  validasiTujuanPinjaman,
  wajibkanTujuanPinjaman,
  validasiAgunan,
  editPinjaman,
} from '@/services/PinjamanService';
import { readFileSync } from 'fs';
import { join } from 'path';

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
  piutang: 'acc-piutang',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDenda: 'acc-pendapatan-denda',
  // FIXTURE FIX: akun 1-1205 Piutang Jasa Pinjaman & 2-1300 Pendapatan
  // Diterima Dimuka MEMANG ada di COA produksi (dipakai akrual jasa &
  // pelunasan jasa future) — fixture ini yang belum menyeed-nya.
  piutangJasa: 'acc-piutang-jasa',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  modal: 'acc-modal',
};

const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutang);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

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

  // Fase 8: requirePermission() butuh baris app_user nyata untuk resolusi role.
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );

  // Phase 4 (AUDIT_INTERNAL.md): cairkanPinjaman sekarang mengecek
  // saldo kas/bank sungguhan sebelum pencairan — beri modal awal kas
  // yang cukup untuk semua skenario pencairan di file test ini
  // (maksimum jumlah pinjaman yang dites 1.000.000), supaya test-test
  // di bawah tetap menguji LOGIKA PENCAIRAN/PEMBAYARAN aslinya, bukan
  // tersandung validasi liquidity yang memang baru ditambahkan.
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
    'je-modal-awal-debit',
    'journal-modal-awal',
    ACC.kas,
    50_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
    'je-modal-awal-kredit',
    'journal-modal-awal',
    ACC.modal,
    50_000_000
  );

  // Bagian D (permintaan pengguna): ajukanPinjaman() sekarang WAJIB
  // menolak anggota tanpa Simpanan Pokok/Wajib (lihat
  // checkKepemilikanSimpananPokokWajib). Fixture bersama file ini
  // dipakai LUSINAN test lain yang mengasumsikan ANGGOTA_ID memang
  // anggota yang lolos syarat pengajuan pinjaman — jadi diberi
  // Simpanan Pokok & Wajib di sini (default anggota "sehat"), supaya
  // test-test LAIN (limit, tunggakan, pencairan, pembayaran, dst.)
  // tetap menguji logika aslinya, bukan tersandung rule baru ini.
  // Skenario "anggota TANPA pokok/wajib" diuji khusus di describe
  // block terpisah, pakai anggota lain yang SENGAJA tidak diberi
  // simpanan ini.
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'simpanan-pokok-fixture',
    ANGGOTA_ID,
    'POKOK',
    'SETOR',
    '2020-01-01',
    100_000,
    'KAS',
    'SP-FIXTURE',
    'user-1',
    now
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'simpanan-wajib-fixture',
    ANGGOTA_ID,
    'WAJIB',
    'SETOR',
    '2020-01-01',
    50_000,
    'KAS',
    'SW-FIXTURE',
    'user-1',
    now
  );
}

/** Ajukan pinjaman dengan metode CUSTOM, dipakai berulang di beberapa test. */
async function ajukanPinjamanCustom(jumlahPinjaman = 1_000_000) {
  return ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman,
    tenor: 2,
    satuanTenor: 'BULAN',
    metodeJasa: 'CUSTOM',
    persentaseJasa: 0,
    biayaAdminTipe: 'TIDAK_ADA',
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  });
}

describe('PinjamanService — metode angsuran CUSTOM (fase 9)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('ajukanPinjaman dengan metode CUSTOM tidak membuat jadwal otomatis (kosong, diisi manual)', async () => {
    const { id } = await ajukanPinjamanCustom();
    const jadwal = await getJadwalAngsuran(id);
    expect(jadwal).toEqual([]);
  });

  test('simpanJadwalAngsuranCustom: total pokok tepat sama dengan pokok pinjaman -> tersimpan', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);

    const hasil = await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [
        { nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 600000, jasa: 30000 },
        { nomorAngsuran: 2, tanggalJatuhTempo: '2026-03-01', pokok: 400000, jasa: 20000 },
      ],
      createdBy: 'user-1',
    });

    expect(hasil.totalPokok).toBe(1_000_000);
    expect(hasil.totalJasa).toBe(50000);
    expect(hasil.totalAngsuran).toBe(1_050_000);

    const jadwal = await getJadwalAngsuran(id);
    expect(jadwal.length).toBe(2);
    expect(jadwal[0].total).toBe(630000); // total dihitung otomatis (fase 9 §6)
    expect(jadwal[1].total).toBe(420000);
  });

  test('simpanJadwalAngsuranCustom menolak jika total pokok TIDAK SAMA dengan pokok pinjaman (fase 9 §7)', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);

    await expect(
      simpanJadwalAngsuranCustom({
        pinjamanId: id,
        baris: [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 900000, jasa: 0 }],
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/PERSIS SAMA/);
  });

  test('simpanJadwalAngsuranCustom menolak nominal negatif (fase 9 §8)', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);

    await expect(
      simpanJadwalAngsuranCustom({
        pinjamanId: id,
        baris: [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: -1_000_000, jasa: 0 }],
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/negatif/);
  });

  test('simpanJadwalAngsuranCustom BOLEH dipanggil ulang (ganti jadwal) sebelum ada pembayaran', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);

    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 1_000_000, jasa: 0 }],
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [
        { nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 500000, jasa: 10000 },
        { nomorAngsuran: 2, tanggalJatuhTempo: '2026-03-01', pokok: 500000, jasa: 10000 },
      ],
      createdBy: 'user-1',
    });

    const jadwal = await getJadwalAngsuran(id);
    expect(jadwal.length).toBe(2); // jadwal lama tergantikan, bukan menumpuk
  });

  test('simpanJadwalAngsuranCustom menolak untuk pinjaman yang metode-nya BUKAN CUSTOM', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 2,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 2,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });

    await expect(
      simpanJadwalAngsuranCustom({
        pinjamanId: id,
        baris: [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 1_000_000, jasa: 0 }],
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/hanya berlaku untuk pinjaman dengan metode jasa CUSTOM/);
  });
});

describe('PinjamanService — pencairan & pembayaran pinjaman CUSTOM (fase 9 §12-15, integrasi accounting engine)', () => {
  let pinjamanId: string;

  beforeEach(async () => {
    await setupFixture();
    const { id } = await ajukanPinjamanCustom(1_000_000);
    pinjamanId = id;
    await simpanJadwalAngsuranCustom({
      pinjamanId,
      baris: [
        { nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 600000, jasa: 30000 },
        { nomorAngsuran: 2, tanggalJatuhTempo: '2026-03-01', pokok: 400000, jasa: 20000 },
      ],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId, sumberDana: 'KAS', approvedBy: 'user-1' });
  });

  test('simpanJadwalAngsuranCustom DITOLAK setelah pinjaman dicairkan (jadwal terkunci)', async () => {
    await expect(
      simpanJadwalAngsuranCustom({
        pinjamanId,
        baris: [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 1_000_000, jasa: 0 }],
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/sudah cair/);
  });

  test('pencairan memposting jurnal balance dan menambah piutang pinjaman (integrasi accounting engine, fase 9 §14)', async () => {
    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('AKTIF');

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT je.debit, je.kredit FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       WHERE j.sumber_transaksi = 'PENCAIRAN_PINJAMAN' AND j.sumber_id = ?`,
      pinjamanId
    );
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(1_000_000);
  });

  test('Phase 7: bayarAngsuran DITOLAK kalau nominal melebihi outstanding, bukan dipotong diam-diam (AUDIT_INTERNAL.md §7 temuan #3)', async () => {
    const jadwalAwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwalAwal[0]; // total 630.000 (pokok 600rb + jasa 30rb)

    await expect(
      bayarAngsuran({
        pinjamanId,
        jadwalId: periode1.id,
        tanggal: '2026-02-01',
        nominal: 1_000_000, // jauh melebihi outstanding 630.000
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/melebihi sisa tagihan/);

    // Penolakan harus UTUH: tidak ada jurnal, tidak ada baris
    // angsuran_pembayaran, dan jadwal TIDAK berubah sama sekali —
    // dulu sebagian uang "hilang" dan status bisa berubah walau
    // ditolak; sekarang harus benar-benar tidak ada efek apa pun.
    const jadwalSetelah = await getJadwalAngsuran(pinjamanId);
    const periode1Setelah = jadwalSetelah.find((j) => j.id === periode1.id)!;
    expect(periode1Setelah.status).toBe('BELUM_BAYAR');
    expect(periode1Setelah.pokokTerbayar).toBe(0);

    const jumlahPembayaran = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM angsuran_pembayaran WHERE jadwal_id = ?`,
      periode1.id
    );
    expect(jumlahPembayaran?.cnt).toBe(0);
  });

  test('Phase 7: pembayaran PERSIS SAMA dengan outstanding tetap berhasil & nominal tersimpan konsisten dengan jurnal', async () => {
    const jadwalAwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwalAwal[0]; // total 630.000

    const hasil = await bayarAngsuran({
      pinjamanId,
      jadwalId: periode1.id,
      tanggal: '2026-02-01',
      nominal: 630_000, // persis sama dengan outstanding
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(hasil.porsiPokok + hasil.porsiJasa + hasil.porsiDenda).toBe(630_000);

    // Kolom `nominal` di angsuran_pembayaran HARUS persis sama dengan
    // total yang benar-benar dijurnal (porsiPokok+porsiJasa+porsiDenda)
    // — sebelum fix, dua-duanya bisa berbeda kalau user overpay.
    const row = await testDb.getFirstAsync<{ nominal: number }>(
      `SELECT nominal FROM angsuran_pembayaran WHERE id = ?`,
      hasil.id
    );
    expect(row?.nominal).toBe(630_000);

    const jadwalSetelah = await getJadwalAngsuran(pinjamanId);
    expect(jadwalSetelah.find((j) => j.id === periode1.id)?.status).toBe('LUNAS');
  });

  test('pembayaran SEBAGIAN: outstanding berkurang tapi status belum LUNAS (fase 9 §13)', async () => {
    const jadwalAwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwalAwal[0]; // total 630.000

    await bayarAngsuran({
      pinjamanId,
      jadwalId: periode1.id,
      tanggal: '2026-02-01',
      nominal: 300000, // kurang dari total 630.000 -> sebagian
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const jadwalSetelah = await getJadwalAngsuran(pinjamanId);
    const periode1Setelah = jadwalSetelah.find((j) => j.id === periode1.id)!;
    expect(periode1Setelah.status).toBe('SEBAGIAN');

    const outstanding = periode1Setelah.total - periode1Setelah.pokokTerbayar - periode1Setelah.jasaTerbayar;
    expect(outstanding).toBe(330000); // 630.000 - 300.000

    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('AKTIF'); // pinjaman belum lunas keseluruhan
  });

  test('pembayaran LUNAS satu periode: status jadi LUNAS, outstanding periode itu jadi 0 (fase 9 §13)', async () => {
    const jadwalAwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwalAwal[0]; // total 630.000

    await bayarAngsuran({
      pinjamanId,
      jadwalId: periode1.id,
      tanggal: '2026-02-01',
      nominal: 630000, // pas lunas
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const jadwalSetelah = await getJadwalAngsuran(pinjamanId);
    const periode1Setelah = jadwalSetelah.find((j) => j.id === periode1.id)!;
    expect(periode1Setelah.status).toBe('LUNAS');
    expect(periode1Setelah.total - periode1Setelah.pokokTerbayar - periode1Setelah.jasaTerbayar).toBe(0);

    // Periode 2 belum dibayar sama sekali -> pinjaman keseluruhan masih AKTIF.
    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('AKTIF');
  });

  test('pembayaran LUNAS seluruh periode: status PINJAMAN keseluruhan jadi LUNAS (fase 9 §13)', async () => {
    const jadwal = await getJadwalAngsuran(pinjamanId);

    await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: 630000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[1].id,
      tanggal: '2026-03-01',
      nominal: 420000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('LUNAS');

    const jadwalAkhir = await getJadwalAngsuran(pinjamanId);
    expect(jadwalAkhir.every((j) => j.status === 'LUNAS')).toBe(true);
  });

  test('pembayaran BERTAHAP (dua kali cicilan sampai lunas) menghasilkan outstanding yang benar di tiap tahap', async () => {
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwal[0]; // total 630.000

    await bayarAngsuran({
      pinjamanId,
      jadwalId: periode1.id,
      tanggal: '2026-02-01',
      nominal: 400000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    let updated = (await getJadwalAngsuran(pinjamanId)).find((j) => j.id === periode1.id)!;
    expect(updated.status).toBe('SEBAGIAN');
    expect(updated.total - updated.pokokTerbayar - updated.jasaTerbayar).toBe(230000);

    await bayarAngsuran({
      pinjamanId,
      jadwalId: periode1.id,
      tanggal: '2026-02-15',
      nominal: 230000, // pelunasan sisa
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    updated = (await getJadwalAngsuran(pinjamanId)).find((j) => j.id === periode1.id)!;
    expect(updated.status).toBe('LUNAS');
    expect(updated.total - updated.pokokTerbayar - updated.jasaTerbayar).toBe(0);
  });

  test('setiap pembayaran memposting jurnal balance (integrasi accounting engine, fase 9 §14)', async () => {
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const { journalId } = await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: 630000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(630000);
  });

  test('data pinjaman CUSTOM terbaca lewat listPinjaman/getJadwalAngsuran generik yang sama dipakai laporan/export (fase 9 §15)', async () => {
    const daftar = await listPinjaman({ anggotaId: ANGGOTA_ID });
    expect(daftar.some((p) => p.id === pinjamanId)).toBe(true);

    const jadwal = await getJadwalAngsuran(pinjamanId);
    expect(jadwal.length).toBe(2);
    // Struktur data sama persis dengan metode FLAT/EFEKTIF/MENURUN — tidak
    // ada percabangan khusus "jika CUSTOM" di layer baca (laporan/export
    // Fase 3/6 memakai fungsi generik ini tanpa perubahan).
    expect(jadwal[0]).toHaveProperty('pokok');
    expect(jadwal[0]).toHaveProperty('jasa');
    expect(jadwal[0]).toHaveProperty('total');
  });
});

describe('PinjamanService — Phase 4: liquidity check sebelum pencairan (AUDIT_INTERNAL.md §7 temuan #2)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('pencairan DITOLAK kalau kas koperasi tidak cukup', async () => {
    // Kosongkan kas fixture (yang tadinya diisi modal awal 50jt) dengan
    // "mengeluarkan" hampir semua lewat jurnal manual, supaya sisa kas
    // jauh di bawah nominal pinjaman yang mau dicairkan.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-kuras-kas','JRN-KURAS-KAS','2026-01-02','period-2026','TEST_KURAS','Kuras kas (fixture test)','POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
      'je-kuras-debit',
      'journal-kuras-kas',
      ACC.kas,
      49_500_000 // sisa kas jadi 500.000
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
      'je-kuras-kredit',
      'journal-kuras-kas',
      ACC.modal,
      49_500_000
    );

    const { id } = await ajukanPinjamanCustom(1_000_000); // lebih besar dari sisa kas 500.000
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });

    await expect(cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' })).rejects.toThrow(
      /[Ll]ikuiditas tidak cukup|[Ss]aldo.*tidak cukup/
    );

    // Status pinjaman TIDAK berubah jadi AKTIF — penolakan harus utuh,
    // tidak ada perubahan status parsial.
    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('DIAJUKAN');
  });

  test('pencairan BERHASIL kalau kas mencukupi (bukti liquidity check tidak menghalangi kasus normal)', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000); // kas fixture 50jt, jauh cukup
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });

    await expect(
      cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' })
    ).resolves.toHaveProperty('journalId');
  });
});

describe('PinjamanService — re-check status anggota di cairkanPinjaman/bayarAngsuran (FORM_TRANSACTION_AUDIT.md §4.1, HIGH)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('cairkanPinjaman DITOLAK kalau anggota sudah berstatus KELUAR sejak pengajuan disetujui — TIDAK ADA jurnal/perubahan status', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });

    // Anggota berubah status SETELAH pengajuan (mis. mengundurkan diri
    // di antara pengajuan & pencairan) — ajukanPinjaman tadinya lolos
    // karena anggota masih AKTIF saat itu.
    await testDb.runAsync(`UPDATE anggota SET status = 'KELUAR' WHERE id = ?`, ANGGOTA_ID);

    await expect(
      cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' })
    ).rejects.toThrow(/KELUAR/);

    // Status pinjaman TIDAK berubah — masih DIAJUKAN, tidak ada jurnal
    // pencairan yang dibuat, tidak ada perubahan saldo kas.
    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('DIAJUKAN');
    const jurnalCount = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'PENCAIRAN_PINJAMAN' AND sumber_id = ?`,
      id
    );
    expect(jurnalCount?.cnt ?? 0).toBe(0);
    const saldoKas = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(saldoKas?.total).toBe(50_000_000); // persis modal awal fixture, tidak berkurang sama sekali
  });

  test('cairkanPinjaman DITOLAK kalau anggota sudah berstatus MENINGGAL', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await testDb.runAsync(`UPDATE anggota SET status = 'MENINGGAL' WHERE id = ?`, ANGGOTA_ID);

    await expect(
      cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' })
    ).rejects.toThrow(/MENINGGAL/);

    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('DIAJUKAN');
  });

  test('cairkanPinjaman TETAP BERHASIL kalau anggota masih AKTIF (rule lain terpenuhi)', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });

    await expect(
      cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' })
    ).resolves.toHaveProperty('journalId');
    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('AKTIF');
  });

  test('bayarAngsuran DITOLAK kalau anggota sudah berstatus KELUAR sejak pinjaman aktif — TIDAK ADA jurnal/perubahan jadwal', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    // Anggota keluar SETELAH pinjaman cair (mis. beberapa bulan
    // kemudian), sebelum angsuran berikutnya dibayar.
    await testDb.runAsync(`UPDATE anggota SET status = 'KELUAR' WHERE id = ?`, ANGGOTA_ID);

    const jadwal = await getJadwalAngsuran(id);
    await expect(
      bayarAngsuran({
        pinjamanId: id,
        jadwalId: jadwal[0].id,
        tanggal: '2026-02-01',
        nominal: 1_000_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/KELUAR/);

    const jadwalSetelah = await getJadwalAngsuran(id);
    expect(jadwalSetelah[0].pokokTerbayar).toBe(0);
    expect(jadwalSetelah[0].status).toBe('BELUM_BAYAR');
    const jumlahPembayaran = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM angsuran_pembayaran WHERE jadwal_id = ?`,
      jadwal[0].id
    );
    expect(jumlahPembayaran?.cnt ?? 0).toBe(0);
  });

  test('bayarAngsuran TETAP BERHASIL kalau anggota masih AKTIF (rule lain terpenuhi)', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    const jadwal = await getJadwalAngsuran(id);
    await expect(
      bayarAngsuran({
        pinjamanId: id,
        jadwalId: jadwal[0].id,
        tanggal: '2026-02-01',
        nominal: 1_000_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).resolves.toHaveProperty('journalId');
  });
});

describe('PinjamanService — Phase 6: LoanEligibilityService di ajukanPinjaman (AUDIT_INTERNAL.md §3.2 & §7 temuan #5)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('pengajuan DITOLAK untuk anggota TIDAK_AKTIF', async () => {
    await testDb.runAsync(`UPDATE anggota SET status = 'TIDAK_AKTIF' WHERE id = ?`, ANGGOTA_ID);
    await expect(ajukanPinjamanCustom(1_000_000)).rejects.toThrow(/AKTIF/);
  });

  test('pengajuan DITOLAK kalau melebihi MAX_PINJAMAN_PER_ANGGOTA', async () => {
    const { setPolicyValue } = await import('@/services/AccountingPolicyService');
    await setPolicyValue('MAX_PINJAMAN_PER_ANGGOTA', 500_000);

    await expect(ajukanPinjamanCustom(1_000_000)).rejects.toThrow(/plafon maksimum/);
  });

  test('pengajuan DITOLAK kalau saldo simpanan di bawah syarat minimum', async () => {
    const { setPolicyValue } = await import('@/services/AccountingPolicyService');
    // Fixture memberi ANGGOTA_ID pokok 100rb + wajib 50rb = total 150rb
    // (lihat setupFixture) — pakai syarat minimum di ATAS itu supaya
    // tetap menguji rule INI (bukan tersandung rule pokok/wajib Bagian D).
    await setPolicyValue('MINIMUM_SALDO_SIMPANAN_PINJAMAN', 200_000);

    await expect(ajukanPinjamanCustom(1_000_000)).rejects.toThrow(/syarat minimum/);
  });

  test('pengajuan tetap BERHASIL kalau semua kebijakan masih default 0 (tidak membatasi)', async () => {
    await expect(ajukanPinjamanCustom(1_000_000)).resolves.toHaveProperty('id');
  });

  test('pengajuan DITOLAK kalau anggota punya tunggakan aktif melebihi MAX_TUNGGAKAN_AKTIF', async () => {
    // Buat & cairkan satu pinjaman lain yang jatuh tempo di masa lalu
    // (supaya jadi tunggakan aktif), lalu coba ajukan pinjaman baru.
    const { id: pinjamanLama } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2025-01-01',
      jumlahPinjaman: 200_000,
      tenor: 1,
      satuanTenor: 'HARI', // jatuh tempo besok dari 2025-01-01, sudah lama lewat
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: pinjamanLama,
      baris: [{ nomorAngsuran: 1, tanggalJatuhTempo: '2025-01-02', pokok: 200_000, jasa: 0 }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: pinjamanLama, sumberDana: 'KAS', approvedBy: 'user-1' });

    const { setPolicyValue } = await import('@/services/AccountingPolicyService');
    await setPolicyValue('MAX_TUNGGAKAN_AKTIF', 1);

    await expect(ajukanPinjamanCustom(1_000_000)).rejects.toThrow(/tunggakan aktif/);
  });
});

describe('PinjamanService — checkKepemilikanSimpananPokokWajib di ajukanPinjaman (Bagian D permintaan pengguna)', () => {
  const ANGGOTA_TANPA_SIMPANAN = 'anggota-tanpa-simpanan';

  beforeEach(async () => {
    await setupFixture();
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES (?,?,?,?,?,'AKTIF',?,?)`,
      ANGGOTA_TANPA_SIMPANAN,
      'A999',
      '0000000000000000',
      'Anggota Baru Tanpa Simpanan',
      '2026-01-01',
      now,
      now
    );
  });

  async function ajukanUntukAnggota(anggotaId: string) {
    return ajukanPinjaman({
      anggotaId,
      tanggal: '2026-01-01',
      jumlahPinjaman: 500_000,
      tenor: 2,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
  }

  test('anggota TIDAK punya Simpanan Pokok maupun Wajib -> DITOLAK, pesan menyebut KEDUA alasan', async () => {
    await expect(ajukanUntukAnggota(ANGGOTA_TANPA_SIMPANAN)).rejects.toThrow(/Simpanan Pokok/);
    await expect(ajukanUntukAnggota(ANGGOTA_TANPA_SIMPANAN)).rejects.toThrow(/Simpanan Wajib/);
  });

  test('anggota punya Wajib tapi TIDAK punya Pokok -> DITOLAK, pesan menyebut Simpanan Pokok', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      'simpanan-wajib-saja',
      ANGGOTA_TANPA_SIMPANAN,
      'WAJIB',
      'SETOR',
      '2026-01-01',
      50_000,
      'KAS',
      'SW-999',
      'user-1',
      now
    );
    await expect(ajukanUntukAnggota(ANGGOTA_TANPA_SIMPANAN)).rejects.toThrow(/Simpanan Pokok/);
  });

  test('anggota punya Pokok tapi TIDAK punya Wajib -> DITOLAK, pesan menyebut Simpanan Wajib', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      'simpanan-pokok-saja',
      ANGGOTA_TANPA_SIMPANAN,
      'POKOK',
      'SETOR',
      '2026-01-01',
      100_000,
      'KAS',
      'SP-999',
      'user-1',
      now
    );
    await expect(ajukanUntukAnggota(ANGGOTA_TANPA_SIMPANAN)).rejects.toThrow(/Simpanan Wajib/);
  });

  test('anggota punya Pokok DAN Wajib -> lolos validasi ini (pengajuan berhasil)', async () => {
    // ANGGOTA_ID (bukan ANGGOTA_TANPA_SIMPANAN) sudah diberi pokok+wajib di setupFixture.
    await expect(ajukanUntukAnggota(ANGGOTA_ID)).resolves.toHaveProperty('id');
  });

  test('anggota TIDAK_AKTIF tetap ditolak oleh checkAnggotaAktif yang SUDAH ADA (bukan status baru) — walau seandainya punya pokok+wajib', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      'simpanan-pokok-nonaktif',
      ANGGOTA_TANPA_SIMPANAN,
      'POKOK',
      'SETOR',
      '2026-01-01',
      100_000,
      'KAS',
      'SP-998',
      'user-1',
      now
    );
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      'simpanan-wajib-nonaktif',
      ANGGOTA_TANPA_SIMPANAN,
      'WAJIB',
      'SETOR',
      '2026-01-01',
      50_000,
      'KAS',
      'SW-998',
      'user-1',
      now
    );
    await testDb.runAsync(`UPDATE anggota SET status = 'TIDAK_AKTIF' WHERE id = ?`, ANGGOTA_TANPA_SIMPANAN);

    await expect(ajukanUntukAnggota(ANGGOTA_TANPA_SIMPANAN)).rejects.toThrow(/AKTIF/);
  });
});

describe('PinjamanService — metode existing (FLAT/EFEKTIF/MENURUN) TIDAK rusak oleh fase 9', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('metode FLAT tetap menghasilkan jadwal otomatis seperti sebelumnya (fase 9 §16)', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_200_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 2,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });

    const jadwal = await getJadwalAngsuran(id);
    expect(jadwal.length).toBe(12);
    const totalPokok = jadwal.reduce((a, j) => a + j.pokok, 0);
    expect(totalPokok).toBe(1_200_000);
  });
});

describe('PinjamanService — listPinjaman().sisaPiutang (bug fix: penghapusan piutang/picker sebelumnya selalu menampilkan plafon awal, tidak berkurang meski sudah diangsur)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('sisaPiutang == jumlahPinjaman sebelum ada angsuran, lalu berkurang persis sebesar porsi pokok+jasa yang sudah dibayar', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 2,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    const sebelum = await listPinjaman({ anggotaId: ANGGOTA_ID });
    const itemSebelum = sebelum.find((p) => p.id === id)!;
    // Sebelum ada angsuran sama sekali: sisaPiutang == plafon+jasa total
    // seluruh jadwal (bukan cuma pokok — kolom `total` per baris jadwal
    // sudah termasuk jasa), jadi >= jumlahPinjaman.
    expect(itemSebelum.jumlahPinjaman).toBe(1_000_000);
    expect(itemSebelum.sisaPiutang).toBeGreaterThan(0);

    const jadwal = await getJadwalAngsuran(id);
    const angsuranPertama = jadwal[0];
    await bayarAngsuran({
      pinjamanId: id,
      jadwalId: angsuranPertama.id,
      tanggal: '2026-02-01',
      nominal: angsuranPertama.total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const sesudah = await listPinjaman({ anggotaId: ANGGOTA_ID });
    const itemSesudah = sesudah.find((p) => p.id === id)!;

    // INI BUG YANG DILAPORKAN: sebelum fix, listPinjaman/PinjamanPicker
    // hanya mengekspos jumlahPinjaman (plafon awal, TIDAK PERNAH
    // berkurang meski sudah diangsur) — sehingga staf yang memilih
    // pinjaman ini di layar Penghapusan Piutang tetap melihat angka
    // penuh walau sebagian sudah lunas. jumlahPinjaman memang tetap
    // (plafon historis), TAPI sisaPiutang WAJIB berkurang persis
    // sebesar total angsuran pertama yang baru dibayar.
    expect(itemSesudah.jumlahPinjaman).toBe(1_000_000); // plafon historis tidak berubah
    expect(itemSesudah.sisaPiutang).toBe(itemSebelum.sisaPiutang - angsuranPertama.total);
    expect(itemSesudah.sisaPiutang).toBeLessThan(itemSebelum.jumlahPinjaman);
  });
});

describe('PinjamanService — listAnggotaDenganPiutangAktif (Bagian B permintaan pengguna: picker "Bayar Piutang Anggota" hanya menampilkan anggota dengan piutang outstanding)', () => {
  beforeEach(async () => {
    await setupFixture();
    // Anggota kedua TANPA pinjaman sama sekali.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('anggota-2','A002','9999999999999999','Sari','2021-01-01','AKTIF',?,?)`,
      now,
      now
    );
  });

  test('anggota TANPA pinjaman sama sekali -> TIDAK muncul', async () => {
    const daftar = await listAnggotaDenganPiutangAktif();
    expect(daftar.find((d) => d.anggotaId === 'anggota-2')).toBeUndefined();
  });

  test('anggota dengan pinjaman yang SUDAH LUNAS -> TIDAK muncul', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });
    const jadwal = await getJadwalAngsuran(id);
    await bayarAngsuran({
      pinjamanId: id,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: 1_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('LUNAS');

    const daftar = await listAnggotaDenganPiutangAktif();
    expect(daftar.find((d) => d.anggotaId === ANGGOTA_ID)).toBeUndefined();
  });

  test('anggota dengan pinjaman AKTIF & outstanding > 0 -> MUNCUL, dengan total sisa piutang yang benar', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    const daftar = await listAnggotaDenganPiutangAktif();
    const item = daftar.find((d) => d.anggotaId === ANGGOTA_ID);
    expect(item).toBeDefined();
    expect(item?.jumlahPinjamanAktif).toBe(1);
    expect(item?.totalSisaPiutang).toBe(1_000_000);
  });

  test('anggota dengan BEBERAPA pinjaman aktif -> jumlah & total sisa piutang gabungan benar', async () => {
    const { id: pinjaman1 } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: pinjaman1,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: pinjaman1, sumberDana: 'KAS', approvedBy: 'user-1' });

    const { id: pinjaman2 } = await ajukanPinjamanCustom(500_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: pinjaman2,
      baris: [{ nomorAngsuran: 1, pokok: 500_000, jasa: 0, tanggalJatuhTempo: '2026-03-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: pinjaman2, sumberDana: 'KAS', approvedBy: 'user-1' });

    const daftar = await listAnggotaDenganPiutangAktif();
    const item = daftar.find((d) => d.anggotaId === ANGGOTA_ID);
    expect(item?.jumlahPinjamanAktif).toBe(2);
    expect(item?.totalSisaPiutang).toBe(1_500_000);
  });

  test('setelah pembayaran melunasi SEMUA pinjaman anggota (outstanding jadi 0) -> anggota tidak lagi muncul', async () => {
    const { id } = await ajukanPinjamanCustom(1_000_000);
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    // Sebelum lunas: muncul.
    expect((await listAnggotaDenganPiutangAktif()).find((d) => d.anggotaId === ANGGOTA_ID)).toBeDefined();

    const jadwal = await getJadwalAngsuran(id);
    await bayarAngsuran({
      pinjamanId: id,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: 1_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // Setelah lunas: tidak muncul lagi.
    expect((await listAnggotaDenganPiutangAktif()).find((d) => d.anggotaId === ANGGOTA_ID)).toBeUndefined();
  });
});

describe('PinjamanService — hapusPiutangPinjaman (update pasca-Phase 18 §14/§18/§19: gate kolektibilitas MACET, akun otomatis, gate RAT)', () => {
  const ACC_PENYISIHAN = { beban: 'acc-beban-penyisihan', penyisihan: 'acc-penyisihan-piutang' };

  async function setupFixtureDenganPenyisihan(): Promise<void> {
    await setupFixture();
    await seedAccount(testDb, ACC_PENYISIHAN.beban, '5-2100', 'Beban Penyisihan Piutang', 'BEBAN', 'DEBIT');
    await seedAccount(testDb, ACC_PENYISIHAN.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
    await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC_PENYISIHAN.beban);
    await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC_PENYISIHAN.penyisihan);
  }

  /** Sisipkan satu pinjaman AKTIF langsung ke DB dengan satu baris angsuran jatuh tempo N hari yang lalu (untuk uji cepat tanpa lewat alur ajukan/cair penuh). */
  // Bug fix (test): sebelumnya "N hari terlambat" SELALU dihitung
  // relatif terhadap `Date.now()` (wall-clock SUNGGUHAN saat test
  // dijalankan), padahal skenario di describe block ini mengevaluasi
  // kolektibilitas relatif terhadap tanggal TETAP '2026-06-01' (lewat
  // parameter `tanggal` di `hapusPiutangPinjaman`). Kalau tanggal
  // sungguhan bergeser jauh dari '2026-06-01' (mis. dijalankan di
  // bulan/tahun lain), jumlah hari tunggakan efektif ikut bergeser dan
  // pinjaman bisa jatuh ke kategori kolektibilitas yang salah (bukan
  // lagi MACET seperti yang dimaksud test). `tanggalLaporan` opsional
  // (default tetap `Date.now()` untuk kompatibilitas mundur) mengunci
  // titik acuan "N hari yang lalu" ke tanggal evaluasi yang benar.
  //
  // PHASE 3 (permintaan pengguna): hapusPiutangPinjaman() SEKARANG
  // mengambil saldo Piutang Pokok dari GL SUNGGUHAN (journal_entry),
  // bukan dari kolom angsuran_jadwal langsung (itu justru bug lama
  // yang diperbaiki) — fixture ini SEKARANG juga membuat jurnal
  // pencairan (Dr Piutang Pokok / Cr Kas) untuk pinjaman seed supaya
  // saldo GL cocok dengan `sisaPokok`, konsisten dengan bagaimana
  // cairkanPinjaman() sungguhan menjurnal.
  async function seedPinjamanTunggak(id: string, sisaPokok: number, hariTerlambat: number, tanggalLaporan?: string): Promise<void> {
    const now = new Date().toISOString();
    const acuan = tanggalLaporan ? new Date(tanggalLaporan).getTime() : Date.now();
    const tanggalJatuhTempo = new Date(acuan - hariTerlambat * 86400 * 1000).toISOString().slice(0, 10);
    await testDb.runAsync(
      `INSERT INTO pinjaman
        (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
         persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
         tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      `PJ-${id}`,
      ANGGOTA_ID,
      '2025-01-01',
      sisaPokok,
      1,
      'BULAN',
      'FLAT',
      0,
      'TIDAK_ADA',
      0,
      0,
      0,
      tanggalJatuhTempo,
      'AKTIF',
      'user-1',
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      `jadwal-${id}`,
      id,
      1,
      tanggalJatuhTempo,
      sisaPokok,
      0,
      0,
      sisaPokok,
      'BELUM_BAYAR'
    );
    // PHASE 3: jurnal pencairan sintetis supaya saldo GL Piutang Pokok
    // (dibaca hapusPiutangPinjaman via hitungSaldoPiutangPokokGL) cocok
    // dengan sisaPokok — TANPA ini, write-off yang diuji di bawah akan
    // (secara BENAR) menemukan saldo GL 0 dan menolak transaksi, karena
    // fixture ini tidak pernah lewat cairkanPinjaman() sungguhan.
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, sumber_id, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      `journal-disb-${id}`,
      `JRN-DISB-${id}`,
      '2025-01-01',
      'period-2026',
      'PENCAIRAN_PINJAMAN',
      id,
      `Pencairan sintetis fixture ${id}`,
      'POSTED',
      'user-1',
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
      `je-disb-${id}-1`,
      `journal-disb-${id}`,
      ACC.piutang,
      sisaPokok
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
      `je-disb-${id}-2`,
      `journal-disb-${id}`,
      ACC.kas,
      sisaPokok
    );
  }

  beforeEach(async () => {
    await setupFixtureDenganPenyisihan();
  });

  test('DITOLAK kalau belum ada RAT untuk tahun buku terkait — pesan sesuai permintaan pengguna §19', async () => {
    await seedPinjamanTunggak('p1', 5_000_000, 200, '2026-06-01'); // MACET

    await expect(
      hapusPiutangPinjaman({ pinjamanId: 'p1', tanggal: '2026-06-01', alasan: 'Anggota tidak dapat dilacak', createdBy: 'user-1' })
    ).rejects.toThrow(/persetujuan Rapat Anggota Tahunan \(RAT\)/);

    // Pinjaman TIDAK berubah status — ditolak sebelum ada efek apa pun.
    const detail = await getPinjamanDetail('p1');
    expect(detail?.status).toBe('AKTIF');
  });

  test('DITOLAK kalau pinjaman BELUM Macet (kolektibilitas Lancar/Dalam Perhatian/Kurang Lancar) — §14, walau RAT sudah ada', async () => {
    await testDb.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await seedPinjamanTunggak('p1', 5_000_000, 45, '2026-06-01'); // Dalam Perhatian, BUKAN Macet

    await expect(
      hapusPiutangPinjaman({ pinjamanId: 'p1', tanggal: '2026-06-01', alasan: 'Coba hapus', createdBy: 'user-1' })
    ).rejects.toThrow(/kolektibilitas Macet/);
  });

  test('BERHASIL untuk pinjaman Macet SETELAH RAT ada — akun ditentukan OTOMATIS (Penyisihan Piutang didebit, Piutang dikredit), tidak ada parameter akun', async () => {
    await testDb.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await seedPinjamanTunggak('p1', 5_000_000, 200, '2026-06-01'); // Macet

    const { writeOffPrincipal, writeOffTotal, journalId } = await hapusPiutangPinjaman({
      pinjamanId: 'p1',
      tanggal: '2026-06-01',
      alasan: 'Anggota meninggal tanpa ahli waris',
      createdBy: 'user-1',
      // PHASE 3: fixture ini tidak pernah mengisi saldo Penyisihan
      // Piutang lebih dulu — izinkan top-up otomatis (jurnal TERPISAH,
      // Dr Beban Penyisihan / Cr Penyisihan, mapping existing) supaya
      // write-off tetap bisa diuji tanpa fixture tambahan yang tidak
      // relevan dengan skenario ini.
      topUpPenyisihanJikaKurang: true,
    });
    expect(writeOffPrincipal).toBe(5_000_000);
    expect(writeOffTotal).toBe(5_000_000); // tidak ada Piutang Jasa yang diakru pada fixture ini

    const entries = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    // DEBIT Penyisihan Piutang (bukan akun Beban baru — mengonsumsi cadangan, tidak dobel-catat kerugian).
    expect(entries.find((e) => e.account_id === ACC_PENYISIHAN.penyisihan)?.debit).toBe(5_000_000);
    // KREDIT Piutang Pinjaman Anggota (piutang benar-benar dikeluarkan).
    expect(entries.find((e) => e.account_id === ACC.piutang)?.kredit).toBe(5_000_000);
    // Akun Beban Penyisihan TIDAK tersentuh sama sekali oleh write-off ini.
    expect(entries.find((e) => e.account_id === ACC_PENYISIHAN.beban)).toBeUndefined();

    const detail = await getPinjamanDetail('p1');
    expect(detail?.status).toBe('MACET');
  });

  test('DITOLAK kalau pinjaman sudah pernah dihapusbukukan sebelumnya', async () => {
    await testDb.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await seedPinjamanTunggak('p1', 5_000_000, 200, '2026-06-01');
    await hapusPiutangPinjaman({
      pinjamanId: 'p1',
      tanggal: '2026-06-01',
      alasan: 'Alasan pertama',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    await expect(
      hapusPiutangPinjaman({ pinjamanId: 'p1', tanggal: '2026-06-02', alasan: 'Coba lagi', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah pernah dihapusbukukan/);
  });
});

describe('PinjamanService — editPencairanPinjaman & hapusPencairanPinjaman (§8 lama, DIPERKETAT Phase 4 §G permintaan pengguna)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  async function ajukanDanCairkanFlat(sumberDana: 'KAS' | 'BANK' = 'KAS') {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 2,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana, approvedBy: 'user-1' });
    return id;
  }

  // PHASE 4 §G: SEBELUMNYA edit/batalkan pencairan masih diizinkan
  // selama belum ada angsuran dibayarkan (Fase 8). Permintaan pengguna
  // MENEGASKAN ULANG (untuk ketiga kalinya lintas seluruh pekerjaan
  // ini) bahwa begitu pinjaman berstatus AKTIF, KEDUA fungsi ini harus
  // SELALU ditolak, TANPA pengecualian — koreksi transaksi posted
  // harus lewat reversal/correction Akuntansi, bukan tombol ini.
  test('editPencairanPinjaman: SELALU ditolak begitu pinjaman berstatus AKTIF (walau belum ada angsuran sama sekali)', async () => {
    const id = await ajukanDanCairkanFlat('KAS');
    await expect(
      editPencairanPinjaman({ pinjamanId: id, sumberDana: 'KAS', alasan: 'Coba edit', actingUserId: 'user-1' })
    ).rejects.toThrow(/tidak lagi didukung setelah pinjaman dicairkan/);

    // Status & saldo TIDAK berubah sama sekali — ditolak sebelum ada efek apa pun.
    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('AKTIF');
    const saldoPiutang = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.piutang
    );
    expect(saldoPiutang?.total).toBe(1_000_000); // tidak dobel, tidak berubah
  });

  test('editPencairanPinjaman: DITOLAK kalau pinjaman belum pernah dicairkan (pesan berbeda dari kasus sudah dicairkan)', async () => {
    const { id } = await ajukanPinjamanCustom();
    await expect(
      editPencairanPinjaman({ pinjamanId: id, sumberDana: 'KAS', alasan: 'Coba edit', actingUserId: 'user-1' })
    ).rejects.toThrow(/belum pernah dicairkan/);
  });

  test('editPencairanPinjaman: DITOLAK kalau alasan kosong (dicek SEBELUM gate status, jadi pesan tetap soal alasan)', async () => {
    const id = await ajukanDanCairkanFlat('KAS');
    await expect(
      editPencairanPinjaman({ pinjamanId: id, sumberDana: 'KAS', alasan: '   ', actingUserId: 'user-1' })
    ).rejects.toThrow(/[Aa]lasan/);
  });

  test('hapusPencairanPinjaman: SELALU ditolak begitu pinjaman berstatus AKTIF (walau belum ada angsuran sama sekali)', async () => {
    const id = await ajukanDanCairkanFlat('KAS');
    await expect(
      hapusPencairanPinjaman({ pinjamanId: id, alasan: 'Salah input, batalkan dulu', actingUserId: 'user-1' })
    ).rejects.toThrow(/tidak lagi didukung setelah pinjaman dicairkan/);

    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('AKTIF'); // TIDAK kembali ke DISETUJUI — ditolak
  });

  test('hapusPencairanPinjaman: DITOLAK kalau sudah ada angsuran dibayarkan (gate status AKTIF sudah menolak lebih dulu, tetap konsisten)', async () => {
    const id = await ajukanDanCairkanFlat('KAS');
    const jadwal = await getJadwalAngsuran(id);
    await bayarAngsuran({
      pinjamanId: id,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: jadwal[0].total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      hapusPencairanPinjaman({ pinjamanId: id, alasan: 'Coba batalkan', actingUserId: 'user-1' })
    ).rejects.toThrow(/tidak lagi didukung setelah pinjaman dicairkan/);

    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('AKTIF');
  });

  test('hapusPencairanPinjaman: DITOLAK kalau alasan kosong (dicek SEBELUM gate status)', async () => {
    const id = await ajukanDanCairkanFlat('KAS');
    await expect(
      hapusPencairanPinjaman({ pinjamanId: id, alasan: '', actingUserId: 'user-1' })
    ).rejects.toThrow(/[Aa]lasan/);
  });
});

describe('PinjamanService — Pelunasan Piutang Anggota (update pasca-6-perbaikan §6, fitur baru)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('TEST F1 (persis instruksi): pokok 10.000.000, jasa terutang 500.000, denda 0 -> total pelunasan 10.500.000; setelah transaksi: pokok outstanding 0, status LUNAS', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 10_000_000,
      tenor: 1,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 10_000_000, jasa: 500_000, tanggalJatuhTempo: '2026-06-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    // Belum jatuh tempo -> tidak ada denda.
    const rincian = await hitungTotalPelunasan(testDb as any, id, '2026-02-01');
    expect(rincian.pokokTersisa).toBe(10_000_000);
    expect(rincian.jasaTerutang).toBe(500_000);
    expect(rincian.denda).toBe(0);
    expect(rincian.totalPelunasan).toBe(10_500_000);

    const hasil = await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });
    expect(hasil.totalPelunasan).toBe(10_500_000);
    expect(hasil.journalId).toBeTruthy();

    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('LUNAS');

    const jadwalSetelah = await getJadwalAngsuran(id);
    expect(jadwalSetelah[0].pokokTerbayar).toBe(10_000_000); // pokok outstanding = pokok - pokokTerbayar = 0
    expect(jadwalSetelah[0].status).toBe('LUNAS');
  });

  test('TEST F2: pokok 10jt, jasa 500rb, denda 100rb (denda aktif & terlambat) -> total mengikuti business rule existing (denda_aktif=NOMINAL 100rb flat)', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 10_000_000,
      tenor: 1,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: true,
      dendaTipe: 'NOMINAL',
      dendaNilai: 100_000,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 10_000_000, jasa: 500_000, tanggalJatuhTempo: '2026-01-10' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    // Sudah lewat jatuh tempo (2026-01-10) di tanggal pelunasan 2026-02-01 -> denda NOMINAL 100rb kena.
    const rincian = await hitungTotalPelunasan(testDb as any, id, '2026-02-01');
    expect(rincian.pokokTersisa).toBe(10_000_000);
    expect(rincian.jasaTerutang).toBe(500_000);
    expect(rincian.denda).toBe(100_000);
    expect(rincian.totalPelunasan).toBe(10_600_000);

    const hasil = await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });
    expect(hasil.totalPelunasan).toBe(10_600_000);
  });

  test('lunasiPinjaman: menjumlahkan LEBIH DARI SATU angsuran yang masih outstanding dalam satu transaksi', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 6_000_000,
      tenor: 3,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [
        { nomorAngsuran: 1, pokok: 2_000_000, jasa: 100_000, tanggalJatuhTempo: '2026-02-01' },
        { nomorAngsuran: 2, pokok: 2_000_000, jasa: 100_000, tanggalJatuhTempo: '2026-03-01' },
        { nomorAngsuran: 3, pokok: 2_000_000, jasa: 100_000, tanggalJatuhTempo: '2026-04-01' },
      ],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    // Bayar angsuran ke-1 dulu secara normal (bukan pelunasan) — sisa yang harus dilunasi hanya ke-2 & ke-3.
    const jadwalAwal = await getJadwalAngsuran(id);
    await bayarAngsuran({ pinjamanId: id, jadwalId: jadwalAwal[0].id, tanggal: '2026-02-01', nominal: 2_100_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const rincian = await hitungTotalPelunasan(testDb as any, id, '2026-03-01');
    expect(rincian.jumlahAngsuranTersisa).toBe(2);
    expect(rincian.pokokTersisa).toBe(4_000_000); // 2 angsuran × 2jt
    expect(rincian.jasaTerutang).toBe(200_000); // 2 angsuran × 100rb

    const hasil = await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-03-01', sumberDana: 'KAS', createdBy: 'user-1' });
    expect(hasil.totalPelunasan).toBe(4_200_000);

    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('LUNAS');
    const jadwalAkhir = await getJadwalAngsuran(id);
    expect(jadwalAkhir.every((j) => j.status === 'LUNAS')).toBe(true);
  });

  test('lunasiPinjaman: DITOLAK kalau pinjaman sudah LUNAS — tidak membuat transaksi kedua', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 1,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });

    // Klik "Lunasi" kedua kalinya (simulasi klik ganda / double submit).
    await expect(
      lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow('Pinjaman ini sudah lunas.');

    const jumlahPembayaran = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM angsuran_pembayaran WHERE pinjaman_id = ?`,
      id
    );
    expect(jumlahPembayaran?.cnt).toBe(1); // HANYA SATU transaksi tersimpan, bukan dua
  });

  test('lunasiPinjaman: pelunasan GAGAL di tengah proses (saldo kas tidak cukup) -> SELURUH transaksi rollback, tidak ada perubahan setengah jalan', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 1,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 50_000, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    // Kuras kas sampai di bawah nominal pelunasan supaya createJournal
    // (via checkSaldoAkunCukup di jalur lain) TIDAK relevan di sini —
    // lunasiPinjaman sendiri tidak mem-validasi saldo kas secara
    // eksplisit (kas MENERIMA uang masuk, bukan keluar — SAMA seperti
    // bayarAngsuran, sengaja tidak butuh cek likuiditas). Untuk menguji
    // rollback sungguhan, picu error lewat mapping akun jasa yang
    // sengaja dihapus di tengah (jadwal ini punya jasa > 0, jadi
    // resolveAccountId('ANGSURAN_JASA', ...) PASTI dipanggil & gagal).
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'ANGSURAN_JASA'`);

    await expect(
      lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow();

    // TIDAK ADA perubahan sama sekali — rollback penuh.
    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('AKTIF'); // BUKAN LUNAS
    const jadwalSetelah = await getJadwalAngsuran(id);
    expect(jadwalSetelah[0].status).toBe('BELUM_BAYAR');
    expect(jadwalSetelah[0].pokokTerbayar).toBe(0);
    const jumlahPembayaran = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM angsuran_pembayaran WHERE pinjaman_id = ?`,
      id
    );
    expect(jumlahPembayaran?.cnt).toBe(0); // tidak ada baris "setengah jalan"
  });

  test('lunasiPinjaman: menghasilkan TEPAT SATU baris Bukti Bayar Piutang (bukan satu per angsuran) — mekanisme bukti existing dipakai ulang', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 4_000_000,
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
      pinjamanId: id,
      baris: [
        { nomorAngsuran: 1, pokok: 2_000_000, jasa: 50_000, tanggalJatuhTempo: '2026-02-01' },
        { nomorAngsuran: 2, pokok: 2_000_000, jasa: 50_000, tanggalJatuhTempo: '2026-03-01' },
      ],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });

    const { listBuktiBayarPiutang } = await import('@/services/BuktiTransaksiService');
    const daftar = await listBuktiBayarPiutang();
    const pinjamanDetail = await getPinjamanDetail(id);
    const bukti = daftar.filter((d) => d.nomorPinjaman === pinjamanDetail?.nomorPinjaman);
    expect(bukti).toHaveLength(1); // TEPAT SATU bukti, bukan 2 (satu per angsuran)
    expect(bukti[0].porsiPokok).toBe(4_000_000);
    expect(bukti[0].porsiJasa).toBe(100_000);
    expect(bukti[0].jumlahPembayaran).toBe(4_100_000);
  });

  test('lunasiPinjaman: integrasi kolektibilitas — pinjaman yang sudah lunas TIDAK LAGI muncul sebagai piutang outstanding', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 1,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 0, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    const { getKlasifikasiPinjamanAktif } = await import('@/services/LoanImpairmentService');
    const sebelumLunas = await getKlasifikasiPinjamanAktif(testDb as any);
    expect(sebelumLunas.find((k) => k.pinjamanId === id)).toBeTruthy();

    await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });

    const setelahLunas = await getKlasifikasiPinjamanAktif(testDb as any);
    expect(setelahLunas.find((k) => k.pinjamanId === id)).toBeUndefined(); // tidak ada lagi (saldo piutang 0)
  });

  test('hitungTotalPelunasan: MURNI perhitungan, TIDAK menulis apa pun ke database (dipanggil berkali-kali, hasil konsisten & tidak ada efek samping)', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 1,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId: id,
      baris: [{ nomorAngsuran: 1, pokok: 1_000_000, jasa: 50_000, tanggalJatuhTempo: '2026-02-01' }],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    const r1 = await hitungTotalPelunasan(testDb as any, id, '2026-02-01');
    const r2 = await hitungTotalPelunasan(testDb as any, id, '2026-02-01');
    expect(r1).toEqual(r2);

    const jumlahPembayaran = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM angsuran_pembayaran WHERE pinjaman_id = ?`,
      id
    );
    expect(jumlahPembayaran?.cnt).toBe(0); // belum ada transaksi apa pun tercatat
    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('AKTIF'); // status tidak berubah cuma karena dihitung
  });
});

async function ajukanPinjamanFlat(jumlahPinjaman = 1_200_000, tenor = 12) {
  return ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman,
    tenor,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA',
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  });
}

describe('PinjamanService — akadUlangPinjaman (Target §9 permintaan pengguna: "Fungsi Akad Ulang")', () => {
  let pinjamanId: string;

  beforeEach(async () => {
    await setupFixture();
    const { id } = await ajukanPinjamanFlat(1_200_000, 12);
    pinjamanId = id;
    await cairkanPinjaman({ pinjamanId, sumberDana: 'KAS', approvedBy: 'user-1' });
  });

  test('akad ulang BERHASIL: jadwal disusun ulang atas SISA POKOK, pinjaman.tenor/metode/persentase diperbarui, riwayat tercatat', async () => {
    const jadwalAwal = await getJadwalAngsuran(pinjamanId);
    const sisaPokokAwal = jadwalAwal.reduce((a, j) => a + j.pokok, 0);
    expect(sisaPokokAwal).toBe(1_200_000);

    const hasil = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 18,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'MENURUN',
      persentaseJasaBaru: 1.5,
      keterangan: 'Restrukturisasi permintaan anggota',
      actingUserId: 'user-1',
    });
    expect(hasil.sisaPokok).toBe(1_200_000);
    expect(hasil.jumlahPeriodeBaru).toBe(18);
    expect(hasil.akadUlangId).toBeTruthy();

    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.tenor).toBe(18);
    expect(detail?.metodeJasa).toBe('MENURUN');
    expect(detail?.persentaseJasa).toBe(1.5);
    expect(detail?.status).toBe('AKTIF'); // status pinjaman tidak berubah oleh akad ulang

    // PHASE 3: getJadwalAngsuran() mengembalikan SELURUH histori (lama +
    // baru), TIDAK ADA yang dihapus — 12 baris lama (sekarang
    // DIRESTRUKTURISASI) + 18 baris baru = 30 baris total.
    const seluruhJadwal = await getJadwalAngsuran(pinjamanId);
    expect(seluruhJadwal.length).toBe(30);

    const jadwalLama = seluruhJadwal.filter((j) => j.status === 'DIRESTRUKTURISASI');
    expect(jadwalLama.length).toBe(12); // TIDAK DIHAPUS, hanya ditandai
    const totalPokokLama = jadwalLama.reduce((a, j) => a + j.pokok, 0);
    expect(totalPokokLama).toBe(1_200_000); // nilai kontraktual lama tetap utuh untuk audit

    const jadwalBaru = seluruhJadwal.filter((j) => j.status === 'BELUM_BAYAR');
    expect(jadwalBaru.length).toBe(18);
    const totalPokokBaru = jadwalBaru.reduce((a, j) => a + j.pokok, 0);
    expect(totalPokokBaru).toBe(1_200_000); // sisa pokok tidak berubah, cuma disusun ulang

    const riwayat = await getRiwayatAkadUlang(pinjamanId);
    expect(riwayat.length).toBe(1);
    expect(riwayat[0].tenorLama).toBe(12);
    expect(riwayat[0].tenorBaru).toBe(18);
    expect(riwayat[0].metodeJasaLama).toBe('FLAT');
    expect(riwayat[0].metodeJasaBaru).toBe('MENURUN');
    expect(riwayat[0].sisaPokok).toBe(1_200_000);
    expect(riwayat[0].keterangan).toBe('Restrukturisasi permintaan anggota');
    expect(riwayat[0].status).toBe('SELESAI');
    expect(riwayat[0].outstandingPiutangJasa).toBe(0); // tidak ada akrual jasa pada fixture ini

    // PHASE 3 §L/§M: traceability bidirectional old <-> restructuring <-> new.
    for (const lama of jadwalLama) {
      expect(lama.status).toBe('DIRESTRUKTURISASI');
    }
    const bukti = await testDb.getAllAsync<{ id: string; digantikan_oleh_akad_ulang_id: string | null }>(
      `SELECT id, digantikan_oleh_akad_ulang_id FROM angsuran_jadwal WHERE pinjaman_id = ? AND status = 'DIRESTRUKTURISASI'`,
      pinjamanId
    );
    expect(bukti.every((b) => b.digantikan_oleh_akad_ulang_id === riwayat[0].id)).toBe(true);
    const buktiBaru = await testDb.getAllAsync<{ id: string; dibuat_dari_akad_ulang_id: string | null }>(
      `SELECT id, dibuat_dari_akad_ulang_id FROM angsuran_jadwal WHERE pinjaman_id = ? AND status = 'BELUM_BAYAR'`,
      pinjamanId
    );
    expect(buktiBaru.every((b) => b.dibuat_dari_akad_ulang_id === riwayat[0].id)).toBe(true);

    const auditRows = await testDb.getAllAsync<{ action: string; entity: string; entity_id: string }>(
      `SELECT action, entity, entity_id FROM audit_log WHERE entity = 'pinjaman' AND action = 'AKAD_ULANG' AND entity_id = ?`,
      pinjamanId
    );
    expect(auditRows.length).toBe(1);
  });

  test('akad ulang TIDAK membuat jurnal baru apa pun (tidak ada perpindahan dana)', async () => {
    const jurnalSebelum = await testDb.getAllAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });
    const jurnalSesudah = await testDb.getAllAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jurnalSesudah[0].cnt).toBe(jurnalSebelum[0].cnt);
  });

  test('DITOLAK kalau pinjaman belum AKTIF (mis. masih DISETUJUI/belum cair)', async () => {
    const { id } = await ajukanPinjamanFlat(500_000, 6);
    await expect(
      akadUlangPinjaman({
        pinjamanId: id,
        tanggal: '2026-06-01',
        tenorBaru: 12,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        actingUserId: 'user-1',
      })
    ).rejects.toThrow(/AKTIF/);
  });

  test('DITOLAK kalau ada angsuran yang sudah terbayar SEBAGIAN — tidak memecah pembayaran parsial yang sudah tercatat', async () => {
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwal[0];
    await bayarAngsuran({
      pinjamanId,
      jadwalId: periode1.id,
      tanggal: '2026-02-01',
      nominal: 10_000, // pembayaran sebagian, jauh di bawah total periode 1
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-06-01',
        tenorBaru: 12,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        actingUserId: 'user-1',
      })
    ).rejects.toThrow(/sebagian/);
  });

  test('DITOLAK kalau pinjaman sudah LUNAS seluruhnya — tidak ada sisa pokok', async () => {
    const { id } = await ajukanPinjamanFlat(100_000, 1);
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });
    const jadwal = await getJadwalAngsuran(id);
    await bayarAngsuran({
      pinjamanId: id,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: jadwal[0].total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      akadUlangPinjaman({
        pinjamanId: id,
        tanggal: '2026-06-01',
        tenorBaru: 6,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        actingUserId: 'user-1',
      })
    ).rejects.toThrow(/lunas/i);
  });

  test('DITOLAK kalau metode jasa baru CUSTOM (akad ulang tidak mendukung CUSTOM langsung)', async () => {
    await expect(
      akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-06-01',
        tenorBaru: 6,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'CUSTOM',
        persentaseJasaBaru: 0,
        actingUserId: 'user-1',
      })
    ).rejects.toThrow(/CUSTOM/);
  });

  test('DITOLAK kalau tenor baru <= 0', async () => {
    await expect(
      akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-06-01',
        tenorBaru: 0,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        actingUserId: 'user-1',
      })
    ).rejects.toThrow(/Tenor/);
  });

  test('angsuran yang SUDAH LUNAS tidak disentuh oleh akad ulang, sisanya ditandai historis (bukan dihapus)', async () => {
    const jadwalAwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwalAwal[0];
    await bayarAngsuran({
      pinjamanId,
      jadwalId: periode1.id,
      tanggal: '2026-02-01',
      nominal: periode1.total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 10,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    const jadwalSesudah = await getJadwalAngsuran(pinjamanId);
    const periode1Sesudah = jadwalSesudah.find((j) => j.id === periode1.id);
    expect(periode1Sesudah?.status).toBe('LUNAS');
    expect(periode1Sesudah?.pokok).toBe(periode1.pokok);

    // PHASE 3: 1 baris LUNAS (tidak disentuh) + 11 baris lama yang
    // BELUM_BAYAR (ditandai DIRESTRUKTURISASI, TIDAK dihapus) + 10
    // baris baru = 22 baris total, bukan 11 (perilaku lama yang
    // menghapus baris lama).
    expect(jadwalSesudah.length).toBe(22);
    const historis = jadwalSesudah.filter((j) => j.status === 'DIRESTRUKTURISASI');
    expect(historis.length).toBe(11);
    const baru = jadwalSesudah.filter((j) => j.status === 'BELUM_BAYAR');
    expect(baru.length).toBe(10);
  });
});


// ===========================================================================
// RC-S54 item 24 & 25 — TUJUAN PINJAMAN & AGUNAN
// ===========================================================================

describe('RC-S54 item 24 — tujuan pinjaman', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  const dasar = {
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-02-10',
    jumlahPinjaman: 5_000_000,
    tenor: 10,
    satuanTenor: 'BULAN' as const,
    metodeJasa: 'FLAT' as const,
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA' as const,
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  };

  for (const tujuan of ['MODAL_KERJA', 'INVESTASI', 'KONSUMTIF'] as const) {
    it(`${tujuan} tersimpan dan terbaca kembali, tanpa detail`, async () => {
      const hasil = await ajukanPinjaman({ ...dasar, tujuanPinjaman: tujuan });
      const tersimpan = await getTujuanPinjaman(testDb as never, hasil.id);
      expect(tersimpan.tujuanPinjaman).toBe(tujuan);
      expect(tersimpan.tujuanDetail).toBeNull();
    });
  }

  it('LAINNYA + detail tersimpan lengkap', async () => {
    const hasil = await ajukanPinjaman({
      ...dasar, tujuanPinjaman: 'LAINNYA', tujuanDetail: '  Biaya pendidikan anak  ',
    });
    const tersimpan = await getTujuanPinjaman(testDb as never, hasil.id);
    expect(tersimpan.tujuanPinjaman).toBe('LAINNYA');
    expect(tersimpan.tujuanDetail).toBe('Biaya pendidikan anak');
  });

  it('LAINNYA tanpa detail DITOLAK', () => {
    expect(() => validasiTujuanPinjaman({ tujuanPinjaman: 'LAINNYA' })).toThrow(/Detail tujuan wajib/);
    expect(() => validasiTujuanPinjaman({ tujuanPinjaman: 'LAINNYA', tujuanDetail: '   ' })).toThrow(
      /Detail tujuan wajib/
    );
  });

  it('detail dibuang untuk tujuan selain LAINNYA', () => {
    const hasil = validasiTujuanPinjaman({ tujuanPinjaman: 'KONSUMTIF', tujuanDetail: 'teks nyasar' });
    expect(hasil.tujuanDetail).toBeNull();
  });

  it('FORM mewajibkan tujuan; service tetap menerima pemanggil lama', async () => {
    expect(() => wajibkanTujuanPinjaman({})).toThrow(/wajib dipilih/);
    // Pinjaman "lama" (tanpa tujuan) tetap dapat dibuat & dibaca.
    const hasil = await ajukanPinjaman(dasar);
    const tersimpan = await getTujuanPinjaman(testDb as never, hasil.id);
    expect(tersimpan.tujuanPinjaman).toBeNull();
  });

  it('nilai tujuan yang tidak dikenal ditolak', () => {
    expect(() =>
      validasiTujuanPinjaman({ tujuanPinjaman: 'RENOVASI' as never })
    ).toThrow(/tidak dikenal/);
  });
});

describe('RC-S54 item 25 — agunan/jaminan', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  const dasar = {
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-02-10',
    jumlahPinjaman: 5_000_000,
    tenor: 10,
    satuanTenor: 'BULAN' as const,
    metodeJasa: 'FLAT' as const,
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA' as const,
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
    tujuanPinjaman: 'MODAL_KERJA' as const,
  };

  it('TIDAK ADA — nol baris agunan dibuat, bukan baris kosong', async () => {
    const hasil = await ajukanPinjaman(dasar);
    expect(await getAgunanPinjaman(testDb as never, hasil.id)).toHaveLength(0);
    const total = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pinjaman_agunan`
    );
    expect(total!.n).toBe(0);
  });

  it('ADA — tersimpan lengkap dan terbaca kembali', async () => {
    const hasil = await ajukanPinjaman({
      ...dasar,
      agunan: {
        jenisAgunan: 'TANAH_DAN_BANGUNAN',
        pemilik: '  Budi Santoso ',
        nomorDokumen: ' SHM-1234 ',
        nilaiAgunan: 250_000_000,
      },
    });
    const rows = await getAgunanPinjaman(testDb as never, hasil.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].jenisAgunan).toBe('TANAH_DAN_BANGUNAN');
    expect(rows[0].pemilik).toBe('Budi Santoso');
    expect(rows[0].nomorDokumen).toBe('SHM-1234');
    expect(rows[0].nilaiAgunan).toBe(250_000_000);
    expect(rows[0].pinjamanId).toBe(hasil.id);
  });

  it('field wajib ditegakkan saat ADA', () => {
    const dasarAgunan = {
      jenisAgunan: 'KENDARAAN' as const,
      pemilik: 'Budi',
      nomorDokumen: 'BPKB-1',
      nilaiAgunan: 50_000_000,
    };
    expect(() => validasiAgunan({ ...dasarAgunan, pemilik: '  ' })).toThrow(/Pemilik agunan wajib/);
    expect(() => validasiAgunan({ ...dasarAgunan, nomorDokumen: '' })).toThrow(/Nomor dokumen agunan wajib/);
    expect(() => validasiAgunan({ ...dasarAgunan, nilaiAgunan: -1 })).toThrow(/tidak boleh negatif/);
    expect(() => validasiAgunan({ ...dasarAgunan, nilaiAgunan: 1.5 })).toThrow(/bilangan bulat/);
    expect(() => validasiAgunan({ ...dasarAgunan, jenisAgunan: 'RUMAH' as never })).toThrow(
      /Jenis agunan wajib/
    );
  });

  it('nilai agunan 0 diterima — nol bukan berarti tidak ada', () => {
    const hasil = validasiAgunan({
      jenisAgunan: 'TABUNGAN', pemilik: 'Budi', nomorDokumen: 'TAB-1', nilaiAgunan: 0,
    });
    expect(hasil!.nilaiAgunan).toBe(0);
  });

  it('TIDAK ADA = undefined, dan itu sah', () => {
    expect(validasiAgunan(undefined)).toBeNull();
  });

  it('pencairan tetap berjalan normal dengan agunan terpasang', async () => {
    const hasil = await ajukanPinjaman({
      ...dasar,
      agunan: {
        jenisAgunan: 'DEPOSITO', pemilik: 'Budi', nomorDokumen: 'BILYET-9', nilaiAgunan: 10_000_000,
      },
    });
    await cairkanPinjaman({
      pinjamanId: hasil.id,
      tanggalPencairan: '2026-02-11',
      sumberDana: 'KAS',
      approvedBy: 'user-1',
    });
    const detail = await getPinjamanDetail(hasil.id);
    expect(detail!.status).toBe('AKTIF');
    // Agunan tidak ikut terhapus atau berubah oleh pencairan.
    expect(await getAgunanPinjaman(testDb as never, hasil.id)).toHaveLength(1);
    // Nol jurnal tambahan akibat agunan.
    const jurnal = await testDb.getAllAsync<{ sumber_transaksi: string }>(
      `SELECT DISTINCT sumber_transaksi FROM journal`
    );
    expect(jurnal.map((j) => j.sumber_transaksi)).not.toContain('AGUNAN');
  });
});

// ===========================================================================
// RC-S72 — REGRESSION: editPinjaman tidak lagi membuang tujuan & agunan
// ===========================================================================
//
// Bug produksi (ditemukan lewat TS2353 di PinjamanFormScreen:271): form Edit
// Pinjaman mengirim `tujuanPinjaman`, `tujuanDetail`, dan `agunan`, tetapi
// `EditPinjamanInput` tidak memuatnya dan `editPinjaman()` tidak menyimpannya.
// Pilihan pengguna hilang diam-diam. Test di bawah mengunci ketiganya.

describe('RC-S72 — editPinjaman: tujuan & agunan', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  const dasar = {
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-02-10',
    jumlahPinjaman: 5_000_000,
    tenor: 10,
    satuanTenor: 'BULAN' as const,
    metodeJasa: 'FLAT' as const,
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA' as const,
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  };
  const editDasar = (pinjamanId: string) => ({
    pinjamanId,
    tanggal: '2026-02-10',
    jumlahPinjaman: 6_000_000,
    tenor: 10,
    satuanTenor: 'BULAN' as const,
    metodeJasa: 'FLAT' as const,
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA' as const,
    biayaAdminNilai: 0,
    dendaAktif: false,
    actingUserId: 'user-1',
  });
  const AGUNAN = { jenisAgunan: 'KENDARAAN' as const, pemilik: 'Budi', nomorDokumen: 'BPKB-1', nilaiAgunan: 50_000_000 };

  it('tujuan yang diubah lewat edit TERSIMPAN (sebelumnya dibuang diam-diam)', async () => {
    const h = await ajukanPinjaman({ ...dasar, tujuanPinjaman: 'MODAL_KERJA' });
    await editPinjaman({ ...editDasar(h.id), tujuanPinjaman: 'LAINNYA', tujuanDetail: '  Renovasi kios  ' });
    const d = await getPinjamanDetail(h.id);
    expect(d!.tujuanPinjaman).toBe('LAINNYA');
    expect(d!.tujuanDetail).toBe('Renovasi kios');
    expect(d!.jumlahPinjaman).toBe(6_000_000);
  });

  it('aturan validasi tujuan pada edit SAMA dengan pengajuan (LAINNYA tanpa detail ditolak, tidak ada perubahan parsial)', async () => {
    const h = await ajukanPinjaman({ ...dasar, tujuanPinjaman: 'MODAL_KERJA' });
    await expect(editPinjaman({ ...editDasar(h.id), tujuanPinjaman: 'LAINNYA' })).rejects.toThrow(/Detail tujuan wajib/);
    const d = await getPinjamanDetail(h.id);
    expect(d!.tujuanPinjaman).toBe('MODAL_KERJA');
    expect(d!.jumlahPinjaman).toBe(5_000_000); // transaksi dibatalkan utuh
  });

  it('pemanggil lama tanpa tujuan/agunan: keduanya TIDAK berubah (backward compatible)', async () => {
    const h = await ajukanPinjaman({ ...dasar, tujuanPinjaman: 'INVESTASI', agunan: AGUNAN });
    await editPinjaman(editDasar(h.id));
    const d = await getPinjamanDetail(h.id);
    expect(d!.tujuanPinjaman).toBe('INVESTASI');
    expect(d!.agunan).toHaveLength(1);
    expect(d!.agunan[0].nomorDokumen).toBe('BPKB-1');
  });

  it('agunan: tambah, ganti, lalu hapus ("Tidak Ada" = null) lewat edit', async () => {
    const h = await ajukanPinjaman({ ...dasar, tujuanPinjaman: 'KONSUMTIF' });
    await editPinjaman({ ...editDasar(h.id), agunan: AGUNAN });
    expect((await getPinjamanDetail(h.id))!.agunan.map((a) => a.nomorDokumen)).toEqual(['BPKB-1']);

    await editPinjaman({ ...editDasar(h.id), agunan: { ...AGUNAN, jenisAgunan: 'TANAH', nomorDokumen: ' SHM-9 ', nilaiAgunan: 90_000_000 } });
    const ganti = (await getPinjamanDetail(h.id))!.agunan;
    expect(ganti).toHaveLength(1);
    expect(ganti[0]).toMatchObject({ jenisAgunan: 'TANAH', nomorDokumen: 'SHM-9', nilaiAgunan: 90_000_000 });

    await editPinjaman({ ...editDasar(h.id), agunan: null });
    expect((await getPinjamanDetail(h.id))!.agunan).toEqual([]);
  });

  it('agunan tidak valid pada edit ditolak dengan aturan yang sama', async () => {
    const h = await ajukanPinjaman({ ...dasar, tujuanPinjaman: 'KONSUMTIF' });
    await expect(editPinjaman({ ...editDasar(h.id), agunan: { ...AGUNAN, pemilik: ' ' } })).rejects.toThrow(/Pemilik agunan wajib/);
  });

  it('lebih dari satu agunan (tidak dapat dibuat lewat UI) tidak dihapus diam-diam oleh edit', async () => {
    const h = await ajukanPinjaman({ ...dasar, tujuanPinjaman: 'KONSUMTIF', agunan: AGUNAN });
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO pinjaman_agunan (id, pinjaman_id, jenis_agunan, pemilik, nomor_dokumen, nilai_agunan, keterangan, created_by, created_at, updated_at)
       VALUES ('agn-2',?,'TABUNGAN','Budi','TAB-2',1000,NULL,'user-1',?,?)`,
      h.id, now, now
    );
    await expect(editPinjaman({ ...editDasar(h.id), agunan: null })).rejects.toThrow(/lebih dari satu agunan/);
    expect((await getPinjamanDetail(h.id))!.agunan).toHaveLength(2);
  });

  it('edit tidak membuat jurnal apa pun (pinjaman belum cair)', async () => {
    const h = await ajukanPinjaman({ ...dasar, tujuanPinjaman: 'KONSUMTIF' });
    const sebelum = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    await editPinjaman({ ...editDasar(h.id), tujuanPinjaman: 'MODAL_KERJA', agunan: AGUNAN });
    const sesudah = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    expect(sesudah!.n).toBe(sebelum!.n);
  });

  it('FORM Edit Pinjaman mem-prefill tujuan & agunan dan mengirim null untuk "Tidak Ada"', () => {
    const src = readFileSync(join(__dirname, '..', 'screens', 'Pinjaman', 'PinjamanFormScreen.tsx'), 'utf8');
    expect(src).toMatch(/setTujuanPinjaman\(detail\.tujuanPinjaman\)/);
    expect(src).toMatch(/setTujuanDetail\(detail\.tujuanDetail/);
    expect(src).toMatch(/detail\.agunan\[0\]/);
    expect(src).toMatch(/setNilaiAgunan\(agunanAda\.nilaiAgunan\)/);
    const payloadEdit = src.slice(src.indexOf('await editPinjaman({'), src.indexOf('id = editPinjamanId'));
    expect(payloadEdit).toMatch(/tujuanPinjaman:/);
    expect(payloadEdit).toMatch(/tujuanDetail:/);
    expect(payloadEdit).toMatch(/: null,/);
  });
});
