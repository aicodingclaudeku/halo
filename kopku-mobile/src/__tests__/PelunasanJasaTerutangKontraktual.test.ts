import { createTestDb, TestDb } from './testDb';

/**
 * REQUIREMENT 9 (permintaan pengguna) — pelunasan pinjaman dengan dua
 * metode perhitungan jasa:
 *
 *   JASA TERUTANG    — hanya jasa yang periodenya SUDAH jatuh tempo
 *                      (earned) per tanggal pelunasan yang ditagih.
 *   JASA KONTRAKTUAL — seluruh sisa jasa sesuai kontrak ditagih.
 *
 * Yang dibuktikan:
 *   1) TOTAL PELUNASAN benar-benar BERUBAH mengikuti pilihan (bukan
 *      sekadar label UI yang berbeda);
 *   2) JASA_KONTRAKTUAL menghasilkan angka IDENTIK dengan perilaku
 *      sebelum requirement ini (default, tidak ada regresi);
 *   3) jurnalnya SELALU BALANCE di kedua metode;
 *   4) JASA_TERUTANG TIDAK membuat baris Pendapatan Diterima Dimuka
 *      (tidak ada kas yang diterima untuk jasa masa depan);
 *   5) rabat tercatat sebagai jejak audit & invarian
 *      jasaDitagih + rabatJasa === jasaTerutang selalu terpenuhi;
 *   6) `porsi_jasa` pada bukti pembayaran = uang yang BENAR-BENAR
 *      diterima, sehingga pokok+jasa+denda === nominal;
 *   7) metode dari UI TIDAK dipercaya mentah — backend menghitung ulang;
 *   8) pinjaman berakhir LUNAS pada kedua metode.
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
  cairkanPinjaman,
  lunasiPinjaman,
  hitungTotalPelunasan,
  terapkanBiayaTambahanPelunasan,
} from '@/services/PinjamanService';

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
     VALUES (?,?,?,?,?,1,1,?,?)`,
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
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanPenalti: 'acc-pendapatan-penalti',
  pendapatanAdministrasi: 'acc-pendapatan-administrasi',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  modal: 'acc-modal',
};

const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanPenalti, '4-1150', 'Pendapatan Penalti Pelunasan', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdministrasi, '4-1160', 'Pendapatan Administrasi Pelunasan', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN', ACC.pendapatanPenalti);
  await seedMapping(testDb, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN', ACC.pendapatanAdministrasi);
  await seedMapping(testDb, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);

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
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );

  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal (fixture)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
    'je-modal-debit',
    'journal-modal-awal',
    ACC.kas,
    50_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
    'je-modal-kredit',
    'journal-modal-awal',
    ACC.modal,
    50_000_000
  );

  for (const [id, jenis, nominal] of [
    ['sp-fixture', 'POKOK', 100000],
    ['sw-fixture', 'WAJIB', 50000],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,'SETOR','2020-01-01',?,'KAS',?, 'user-1',?)`,
      id,
      ANGGOTA_ID,
      jenis,
      nominal,
      id.toUpperCase(),
      now
    );
  }
}

/** Pinjaman FLAT 12 bulan, jasa 12.000/bulan, cair 2026-01-01, jatuh tempo pertama 2026-02-01. */
async function pinjamanAktif12Bulan(): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
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
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });
  return id;
}

/** Total debit & kredit satu jurnal — untuk membuktikan balance. */
async function totalJurnal(journalId: string) {
  const row = await testDb.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(kredit),0) as k FROM journal_entry WHERE journal_id = ?`,
    journalId
  );
  return { debit: row?.d ?? 0, kredit: row?.k ?? 0 };
}

/** Tanggal pelunasan 2026-04-15: periode 2026-02-01 s.d. 2026-04-01 sudah jatuh tempo (3 periode). */
const TANGGAL_PELUNASAN = '2026-04-15';

describe('REQ 9 — pelunasan Jasa Terutang vs Jasa Kontraktual', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('DEFAULT tanpa metode = JASA_KONTRAKTUAL (tidak ada regresi perilaku lama)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    const tanpaMetode = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN);
    const eksplisit = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
      metodeJasaPelunasan: 'JASA_KONTRAKTUAL',
    });

    expect(tanpaMetode.metodeJasaPelunasan).toBe('JASA_KONTRAKTUAL');
    expect(tanpaMetode.totalPelunasan).toBe(eksplisit.totalPelunasan);
    expect(tanpaMetode.rabatJasa).toBe(0);
    expect(tanpaMetode.jasaDitagih).toBe(tanpaMetode.jasaTerutang);
  });

  test('TOTAL PELUNASAN benar-benar berubah mengikuti metode', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    const kontraktual = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
      metodeJasaPelunasan: 'JASA_KONTRAKTUAL',
    });
    const terutang = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });

    // Pokok & denda identik; yang berbeda HANYA komponen jasa.
    expect(terutang.pokokTersisa).toBe(kontraktual.pokokTersisa);
    expect(terutang.denda).toBe(kontraktual.denda);

    expect(terutang.jasaDitagih).toBe(kontraktual.jasaSudahJatuhTempo);
    expect(kontraktual.jasaDitagih).toBe(kontraktual.jasaTerutang);
    expect(terutang.totalPelunasan).toBeLessThan(kontraktual.totalPelunasan);
    expect(kontraktual.totalPelunasan - terutang.totalPelunasan).toBe(kontraktual.jasaFuture);
  });

  test('INVARIAN: jasaDitagih + rabatJasa === jasaTerutang, pada kedua metode', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    for (const metode of ['JASA_KONTRAKTUAL', 'JASA_TERUTANG'] as const) {
      const r = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
        metodeJasaPelunasan: metode,
      });
      expect(r.jasaDitagih + r.rabatJasa).toBe(r.jasaTerutang);
    }
  });

  test('JASA_KONTRAKTUAL: jurnal balance & ADA baris Pendapatan Diterima Dimuka untuk jasa masa depan', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
      metodeJasaPelunasan: 'JASA_KONTRAKTUAL',
    });

    const hasil = await lunasiPinjaman({
      pinjamanId,
      tanggal: TANGGAL_PELUNASAN,
      sumberDana: 'KAS',
      createdBy: 'user-1',
      metodeJasaPelunasan: 'JASA_KONTRAKTUAL',
    });

    const total = await totalJurnal(hasil.journalId);
    expect(total.debit).toBe(total.kredit);
    expect(total.debit).toBe(rincian.totalPelunasan);

    const dimuka = await testDb.getFirstAsync<{ k: number }>(
      `SELECT COALESCE(SUM(kredit),0) as k FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      hasil.journalId,
      ACC.pendapatanDimuka
    );
    expect(dimuka?.k).toBe(rincian.jasaFuture);
    expect(hasil.rabatJasa).toBe(0);
  });

  test('JASA_TERUTANG: jurnal balance & TIDAK ADA baris Pendapatan Diterima Dimuka', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });

    const hasil = await lunasiPinjaman({
      pinjamanId,
      tanggal: TANGGAL_PELUNASAN,
      sumberDana: 'KAS',
      createdBy: 'user-1',
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });

    const total = await totalJurnal(hasil.journalId);
    expect(total.debit).toBe(total.kredit);
    expect(total.debit).toBe(rincian.totalPelunasan);

    // Tidak ada kas yang diterima untuk jasa masa depan -> tidak boleh
    // ada liabilitas Pendapatan Diterima Dimuka yang dikarang.
    const dimuka = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      hasil.journalId,
      ACC.pendapatanDimuka
    );
    expect(dimuka?.cnt).toBe(0);
    expect(hasil.jasaFuturePendingEirAccounting).toBe(0);
    expect(hasil.rabatJasa).toBe(rincian.jasaFuture);
    expect(hasil.rabatJasa).toBeGreaterThan(0);
  });

  test('bukti pembayaran: porsi_pokok + porsi_jasa + porsi_denda === nominal (uang yang benar-benar diterima)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    const hasil = await lunasiPinjaman({
      pinjamanId,
      tanggal: TANGGAL_PELUNASAN,
      sumberDana: 'KAS',
      createdBy: 'user-1',
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });

    const bayar = await testDb.getFirstAsync<{
      nominal: number;
      porsi_pokok: number;
      porsi_jasa: number;
      porsi_denda: number;
      metode_jasa_pelunasan: string | null;
      rabat_jasa_pelunasan: number;
    }>(
      `SELECT nominal, porsi_pokok, porsi_jasa, porsi_denda, metode_jasa_pelunasan, rabat_jasa_pelunasan
       FROM angsuran_pembayaran WHERE pinjaman_id = ? AND jadwal_id IS NULL`,
      pinjamanId
    );

    expect((bayar?.porsi_pokok ?? 0) + (bayar?.porsi_jasa ?? 0) + (bayar?.porsi_denda ?? 0)).toBe(bayar?.nominal);
    // Jejak audit metode & rabat tersimpan.
    expect(bayar?.metode_jasa_pelunasan).toBe('JASA_TERUTANG');
    expect(bayar?.rabat_jasa_pelunasan).toBe(hasil.rabatJasa);
  });

  test('pinjaman berakhir LUNAS pada KEDUA metode', async () => {
    for (const metode of ['JASA_KONTRAKTUAL', 'JASA_TERUTANG'] as const) {
      await setupFixture();
      const pinjamanId = await pinjamanAktif12Bulan();
      await lunasiPinjaman({
        pinjamanId,
        tanggal: TANGGAL_PELUNASAN,
        sumberDana: 'KAS',
        createdBy: 'user-1',
        metodeJasaPelunasan: metode,
      });
      const p = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM pinjaman WHERE id = ?`, pinjamanId);
      expect(p?.status).toBe('LUNAS');

      const belumLunas = await testDb.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM angsuran_jadwal WHERE pinjaman_id = ? AND status NOT IN ('LUNAS','DIHAPUSBUKU','DIRESTRUKTURISASI')`,
        pinjamanId
      );
      expect(belumLunas?.cnt).toBe(0);
    }
  });

  test('JASA_TERUTANG tidak menulis ulang kolom `jasa` kontraktual pada jadwal (histori tidak diubah)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const sebelum = await testDb.getAllAsync<{ id: string; jasa: number }>(
      `SELECT id, jasa FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran`,
      pinjamanId
    );

    await lunasiPinjaman({
      pinjamanId,
      tanggal: TANGGAL_PELUNASAN,
      sumberDana: 'KAS',
      createdBy: 'user-1',
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });

    const sesudah = await testDb.getAllAsync<{ id: string; jasa: number }>(
      `SELECT id, jasa FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran`,
      pinjamanId
    );
    expect(sesudah.map((r) => r.jasa)).toEqual(sebelum.map((r) => r.jasa));
    // Jumlah baris juga tidak berubah — tidak ada jadwal yang dihapus.
    expect(sesudah.length).toBe(sebelum.length);
  });

  test('metode tidak valid dari UI DITOLAK backend (tidak dipercaya mentah)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await expect(
      hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
        metodeJasaPelunasan: 'JASA_GRATIS' as any,
      })
    ).rejects.toThrow(/Metode pelunasan jasa tidak valid/i);
  });

  test('REQ 8 — terapkanBiayaTambahanPelunasan memberi total IDENTIK dengan hitungTotalPelunasan (satu formula)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    // Jalur backend penuh (biaya dikirim ke service).
    const viaService = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
      penaltiPelunasan: 25_000,
      administrasiPelunasan: 10_000,
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });

    // Jalur layar (rincian dasar + komposisi sinkron saat mengetik).
    const base = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN, {
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });
    const viaUi = terapkanBiayaTambahanPelunasan(base, 25_000, 10_000);

    expect(viaUi.totalPelunasan).toBe(viaService.totalPelunasan);
    expect(viaUi.penaltiPelunasan).toBe(25_000);
    expect(viaUi.administrasiPelunasan).toBe(10_000);
    expect(viaUi.jasaDitagih).toBe(viaService.jasaDitagih);
  });

  test('REQ 8 — nilai biaya tidak valid ditolak fungsi komposisi (validasi bukan hanya di UI)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const base = await hitungTotalPelunasan(testDb as any, pinjamanId, TANGGAL_PELUNASAN);

    expect(() => terapkanBiayaTambahanPelunasan(base, -1, 0)).toThrow(/tidak boleh negatif/i);
    expect(() => terapkanBiayaTambahanPelunasan(base, 1000.5, 0)).toThrow(/bulat/i);
    expect(() => terapkanBiayaTambahanPelunasan(base, NaN, 0)).toThrow(/tidak valid/i);
  });
});
