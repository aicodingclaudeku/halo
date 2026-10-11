import * as fs from 'fs';
import * as path from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S82 — AKAD ULANG DETAIL PINJAMAN + DOKUMEN EXPORT.
 *
 * Sebagian besar test memakai SQLite nyata (sql.js) dan alur service
 * produksi (`ajukanPinjaman` → `cairkanPinjaman` → `bayarAngsuran` →
 * `akadUlangPinjaman`). Nilai pembanding dibaca LANGSUNG dari tabel,
 * bukan dari objek yang dikembalikan helper yang sedang diuji.
 *
 * Renderer React Native tidak tersedia di Jest repo ini, jadi layar diuji
 * lewat helper murni yang dipakainya + audit struktural source.
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

// Modul native export — di-mock minimal (pola ExportService.test.ts).
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/mock/',
  getInfoAsync: jest.fn(async () => ({ exists: true })),
  makeDirectoryAsync: jest.fn(async () => {}),
  writeAsStringAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
}));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn(async () => ({ uri: '/tmp/print.pdf' })) }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => false), shareAsync: jest.fn() }));
// DIPERBARUI RC-S106: penulis Excel pindah dari `xlsx` ke
// `xlsx-js-style` (fork SheetJS 0.18.5 yang benar-benar menulis gaya sel).
// Mock ini HARUS ikut pindah — mock ke modul yang tidak lagi terpasang
// membuat seluruh suite gagal dimuat, bukan sekadar tidak terpakai.
jest.mock('xlsx-js-style', () => ({
  utils: { book_new: jest.fn(), aoa_to_sheet: jest.fn(), book_append_sheet: jest.fn() },
  write: jest.fn(() => ''),
}));

import * as Print from 'expo-print';
import {
  ajukanPinjaman,
  cairkanPinjaman,
  bayarAngsuran,
  akadUlangPinjaman,
  getJadwalAngsuran,
  getRiwayatAkadUlang,
  getAkadUlangDocumentData,
  getAkadAwalDocumentData,
} from '@/services/PinjamanService';
import {
  ringkasPosisiAkadUlang,
  preflightAkadUlang,
  parseTenorInput,
  parsePersentaseInput,
  validasiFormAkadUlang,
  hitungPeriodeRelatifAkadUlang,
  tentukanStatusEventAkadUlang,
  buatNomorDokumenAkadUlang,
  nomorUrutEventAkadUlang,
  labelMetodeJasa,
  labelSatuanTenor,
  formatTanggalPanjang,
  BarisJadwalPresentasi,
} from '@/services/AkadUlangPresentasi';
import { buildDokumenAkadUlang, CATATAN_PIUTANG_JASA } from '@/export/AkadUlangDocumentBuilder';
import { buildAkadUlangHtml } from '@/export/AkadUlangHtmlBuilder';
import { buildDokumenAkadAwal } from '@/export/AkadAwalDocumentBuilder';
import { buildAkadAwalHtml } from '@/export/AkadAwalHtmlBuilder';
import { exportDokumenAkadUlangPdf, exportDokumenAkadAwalPdf, exportLaporan, UKURAN_A4_PORTRAIT } from '@/services/ExportService';
import { labelBiayaAdmin, buatNomorDokumenAkadAwal, statusDokumenAkadAwal } from '@/services/AkadUlangPresentasi';
import { buatPersonel, perbaruiPersonel, setStatusPersonel, getSusunanPengurusInti, getPersonel } from '@/services/KoperasiMasterService';
import { kenaliJabatanPengurusInti, pilihSusunanPengurusInti, masaJabatanTumpangTindih } from '@/services/PengurusInti';
import { terbilang, terbilangRupiah, namaHari } from '@/utils/terbilang';
import { DASAR_HUKUM_PERJANJIAN_PINJAMAN } from '@/export/DasarHukumAkad';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import { isCurrentRepaymentSchedule } from '@/accounting/ScheduleLifecycle';
import { formatRupiah } from '@/utils/money';

const ANGGOTA_ID = 'anggota-1';
const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanDenda: 'acc-pendapatan-denda',
  penyisihan: 'acc-penyisihan',
  bebanPenyisihan: 'acc-beban-penyisihan',
  modal: 'acc-modal',
};

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`, transactionType, role, accountId
  );
}

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan Pinjaman', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan);
  await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('period-2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO koperasi (id, nama, alamat, tahun_buku_aktif, standar_akuntansi, setup_selesai, created_at, updated_at)
     VALUES ('kop-1','KSP Sejahtera Uji','Jl. Merdeka No. 1, Makassar',2026,'SAK_EP',1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, alamat, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'A001', '7371010101010001', 'Budi Santoso', 'Jl. Kenanga 5', '2020-01-01', now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-petugas','Petugas Uji','petugas-uji','PETUGAS','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-d','journal-modal-awal',?,100000000,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-k','journal-modal-awal',?,0,100000000)`,
    ACC.modal
  );
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

/** Pinjaman 12.000.000 FLAT 1%/bulan tenor 12, cair 2026-01-01, angsuran #1 lunas. */
async function buatPinjamanAktif(): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman: 12_000_000,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA',
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
  const j = await getJadwalAngsuran(id);
  await bayarAngsuran({ pinjamanId: id, jadwalId: j[0].id, tanggal: '2026-02-01', nominal: j[0].total, sumberDana: 'KAS', createdBy: 'user-1' });
  return id;
}

async function tandaiTerlambat(pinjamanId: string, nomor: number[]): Promise<void> {
  // Status TERLAMBAT sah menurut CHECK constraint (data legacy/import) —
  // pola yang sama dengan RestrukturisasiSingleSourceOfTruth.test.ts.
  await testDb.runAsync(
    `UPDATE angsuran_jadwal SET status = 'TERLAMBAT' WHERE pinjaman_id = ? AND nomor_angsuran IN (${nomor.join(',')})`,
    pinjamanId
  );
}

/** Snapshot SELURUH isi database (semua tabel, semua baris) untuk membuktikan tidak ada mutasi. */
async function snapshotDatabase(): Promise<string> {
  const tabel = await testDb.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );
  const isi: Record<string, unknown[]> = {};
  for (const t of tabel) {
    isi[t.name] = await testDb.getAllAsync(`SELECT * FROM "${t.name}" ORDER BY rowid`);
  }
  return JSON.stringify(isi);
}

function baris(over: Partial<BarisJadwalPresentasi> & { id: string }): BarisJadwalPresentasi {
  return {
    nomorAngsuran: 1,
    tanggalJatuhTempo: '2026-03-01',
    pokok: 1_000_000,
    jasa: 120_000,
    total: 1_120_000,
    pokokTerbayar: 0,
    jasaTerbayar: 0,
    status: 'BELUM_BAYAR',
    dibuatDariAkadUlangId: null,
    digantikanOlehAkadUlangId: null,
    ...over,
  };
}

// ======================================================================
// N1–N3 — RINGKASAN AKAD ULANG (bug fix §A)
// ======================================================================

describe('RC-S82 §A — ringkasan akad ulang memakai definisi CURRENT', () => {
  beforeEach(setupFixture);

  test('N1: jadwal TERLAMBAT ikut dihitung sebagai current (bukti bug daftar status lama)', async () => {
    const pinjamanId = await buatPinjamanAktif();
    await tandaiTerlambat(pinjamanId, [2, 3]);
    const jadwal = await getJadwalAngsuran(pinjamanId);

    const ringkasan = ringkasPosisiAkadUlang(jadwal);
    expect(ringkasan.jumlahJadwalCurrent).toBe(11);
    expect(ringkasan.sisaPokok).toBe(11_000_000);

    // Rumus UI LAMA (daftar status diketik ulang) — MELEWATKAN TERLAMBAT.
    const lama = jadwal.filter((j) => j.status === 'BELUM_BAYAR' || j.status === 'SEBAGIAN');
    expect(lama.length).toBe(9);
    expect(lama.reduce((a, j) => a + (j.pokok - j.pokokTerbayar), 0)).toBe(9_000_000);
  });

  test('N2: sisa pokok ringkasan UI === sisa pokok yang dipakai service (snapshot DB)', async () => {
    const pinjamanId = await buatPinjamanAktif();
    await tandaiTerlambat(pinjamanId, [2]);
    const ringkasan = ringkasPosisiAkadUlang(await getJadwalAngsuran(pinjamanId));

    const hasil = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });
    const row = await testDb.getFirstAsync<{ sisa_pokok: number }>(
      `SELECT sisa_pokok FROM pinjaman_akad_ulang WHERE id = ?`,
      hasil.akadUlangId
    );
    expect(ringkasan.sisaPokok).toBe(hasil.sisaPokok);
    expect(ringkasan.sisaPokok).toBe(row!.sisa_pokok);

    // Basis current dihitung langsung dari tabel (bukan helper).
    const ringkasanSesudah = ringkasPosisiAkadUlang(await getJadwalAngsuran(pinjamanId));
    const langsung = await testDb.getFirstAsync<{ s: number; n: number }>(
      `SELECT COALESCE(SUM(MAX(0, pokok - pokok_terbayar)),0) AS s, COUNT(*) AS n
       FROM angsuran_jadwal WHERE pinjaman_id = ? AND status IN ('BELUM_BAYAR','SEBAGIAN','TERLAMBAT')`,
      pinjamanId
    );
    expect(ringkasanSesudah.sisaPokok).toBe(langsung!.s);
    expect(ringkasanSesudah.jumlahJadwalCurrent).toBe(langsung!.n);
  });

  test('N3: jadwal obsolete (DIRESTRUKTURISASI) & LUNAS tidak ikut ringkasan', async () => {
    const pinjamanId = await buatPinjamanAktif();
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });
    const jadwal = await getJadwalAngsuran(pinjamanId);
    expect(jadwal.filter((j) => j.status === 'DIRESTRUKTURISASI').length).toBe(11);
    const r = ringkasPosisiAkadUlang(jadwal);
    expect(r.jumlahJadwalCurrent).toBe(6);
    expect(r.sisaPokok).toBe(11_000_000); // bukan 22.000.000 (tanpa double count)
  });

  test('helper murni: hanya status CURRENT dari ScheduleLifecycle yang dihitung', () => {
    const data = [
      baris({ id: 'a', status: 'BELUM_BAYAR' }),
      baris({ id: 'b', status: 'TERLAMBAT' }),
      baris({ id: 'c', status: 'SEBAGIAN', pokokTerbayar: 400_000 }),
      baris({ id: 'd', status: 'LUNAS', pokokTerbayar: 1_000_000 }),
      baris({ id: 'e', status: 'DIRESTRUKTURISASI' }),
      baris({ id: 'f', status: 'DIHAPUSBUKU' }),
      baris({ id: 'g', status: 'SEBAGIAN', pokokTerbayar: 1_500_000 }), // lebih bayar -> max(0, ...)
    ];
    const r = ringkasPosisiAkadUlang(data);
    expect(r.jumlahJadwalCurrent).toBe(data.filter((j) => isCurrentRepaymentSchedule(j.status)).length);
    expect(r.jumlahJadwalCurrent).toBe(4);
    expect(r.sisaPokok).toBe(1_000_000 + 1_000_000 + 600_000 + 0);
    expect(r.jumlahJadwalCurrentTerbayar).toBe(2);
  });
});

// ======================================================================
// §B — PREFLIGHT
// ======================================================================

describe('RC-S82 §B — preflight akad ulang', () => {
  beforeEach(setupFixture);

  test('TERLAMBAT tanpa pembayaran TIDAK diblokir preflight, dan service menerimanya', async () => {
    const pinjamanId = await buatPinjamanAktif();
    await tandaiTerlambat(pinjamanId, [2, 3, 4]);
    const pre = preflightAkadUlang(await getJadwalAngsuran(pinjamanId));
    expect(pre.boleh).toBe(true);
    await expect(
      akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-03-01',
        tenorBaru: 6,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        actingUserId: 'user-1',
      })
    ).resolves.toBeDefined();
  });

  test('pembayaran parsial pada jadwal current -> preflight menolak jelas, service TETAP menolak (second layer)', async () => {
    const pinjamanId = await buatPinjamanAktif();
    const j = await getJadwalAngsuran(pinjamanId);
    await bayarAngsuran({ pinjamanId, jadwalId: j[1].id, tanggal: '2026-02-15', nominal: 300_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const pre = preflightAkadUlang(await getJadwalAngsuran(pinjamanId));
    expect(pre.boleh).toBe(false);
    if (pre.boleh === false) {
      expect(pre.judul).toBe('Akad Ulang Tidak Dapat Dilakukan');
      expect(pre.pesan).toMatch(/pembayaran/i);
    }
    await expect(
      akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-03-01',
        tenorBaru: 6,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        actingUserId: 'user-1',
      })
    ).rejects.toThrow(/terbayar sebagian/);
  });

  test('preflight murni: jasaTerbayar > 0 saja juga diblokir; tidak ada jadwal current -> diblokir', () => {
    expect(preflightAkadUlang([baris({ id: 'x', jasaTerbayar: 1 })]).boleh).toBe(false);
    expect(preflightAkadUlang([baris({ id: 'x', status: 'LUNAS', pokokTerbayar: 1_000_000 })]).boleh).toBe(false);
    expect(preflightAkadUlang([baris({ id: 'x', status: 'TERLAMBAT' })]).boleh).toBe(true);
  });
});

// ======================================================================
// §E — VALIDASI INPUT KETAT
// ======================================================================

describe('RC-S82 §E — parsing input ketat', () => {
  test('tenor: hanya bilangan bulat positif', () => {
    expect(parseTenorInput('12')).toBe(12);
    expect(parseTenorInput(' 6 ')).toBe(6);
    for (const buruk of ['12abc', '1.5', '1,5', '0', '-3', '', 'abc', '1e2', '12 3']) {
      expect(parseTenorInput(buruk)).toBeNull();
    }
  });

  test('persentase: angka non-negatif, satu pemisah desimal titik/koma', () => {
    expect(parsePersentaseInput('1.5')).toBe(1.5);
    expect(parsePersentaseInput('1,5')).toBe(1.5);
    expect(parsePersentaseInput('0')).toBe(0);
    expect(parsePersentaseInput('2')).toBe(2);
    for (const buruk of ['1.5abc', '12abc', '-1', '1.2.3', '1,2,3', '', '.5', '5.', 'abc', '1e2']) {
      expect(parsePersentaseInput(buruk)).toBeNull();
    }
  });

  test('validasiFormAkadUlang menghasilkan draft yang SAMA yang dikirim ke service', () => {
    const hasil = validasiFormAkadUlang({
      tanggal: '2026-03-01',
      tenorText: '6',
      satuanTenor: 'BULAN',
      metodeJasa: 'MENURUN',
      persentaseText: '1,25',
      keterangan: '  berita acara  ',
    });
    expect(hasil).toEqual({
      ok: true,
      draft: { tanggal: '2026-03-01', tenor: 6, satuanTenor: 'BULAN', metodeJasa: 'MENURUN', persentaseJasa: 1.25, keterangan: 'berita acara' },
    });
    expect(validasiFormAkadUlang({ tanggal: '2026-03-01', tenorText: '12abc', satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseText: '1', keterangan: '' }).ok).toBe(false);
    expect(validasiFormAkadUlang({ tanggal: '2026-03-01', tenorText: '12', satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseText: '1.5abc', keterangan: '' }).ok).toBe(false);
    expect(validasiFormAkadUlang({ tanggal: '', tenorText: '12', satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseText: '1', keterangan: '' }).ok).toBe(false);
  });

  test('label manusiawi — bukan enum mentah uppercase', () => {
    expect(labelSatuanTenor('BULAN')).toBe('Bulan');
    expect(labelSatuanTenor('MINGGU')).toBe('Minggu');
    expect(labelSatuanTenor('HARI')).toBe('Hari');
    expect(labelMetodeJasa('FLAT')).toBe('Flat');
    expect(labelMetodeJasa('MENURUN')).toBe('Menurun');
    expect(labelMetodeJasa('EFEKTIF')).toBe('Efektif');
    expect(formatTanggalPanjang('2026-09-24')).toBe('24 September 2026');
    expect(formatTanggalPanjang(null)).toBe('-');
  });
});

// ======================================================================
// N4–N10 — DOKUMEN AKAD ULANG (dua event)
// ======================================================================

describe('RC-S82 — riwayat & dokumen akad ulang (dua event)', () => {
  let pinjamanId: string;
  let akad1: string;
  let akad2: string;

  beforeEach(async () => {
    await setupFixture();
    pinjamanId = await buatPinjamanAktif();
    akad1 = (
      await akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-03-01',
        tenorBaru: 6,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        keterangan: 'Akad ulang pertama',
        actingUserId: 'user-1',
      })
    ).akadUlangId;
    // Bayar periode 1 akad ulang #1 penuh, lalu akad ulang #2.
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const p1 = jadwal.filter((j) => j.dibuatDariAkadUlangId === akad1).sort((a, b) => a.nomorAngsuran - b.nomorAngsuran)[0];
    await bayarAngsuran({ pinjamanId, jadwalId: p1.id, tanggal: '2026-04-01', nominal: p1.total, sumberDana: 'KAS', createdBy: 'user-1' });
    akad2 = (
      await akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-05-01',
        tenorBaru: 4,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'MENURUN',
        persentaseJasaBaru: 1.5,
        actingUserId: 'user-1',
      })
    ).akadUlangId;
  });

  test('N4: jadwal hasil akad ulang diambil berdasarkan dibuat_dari_akad_ulang_id', async () => {
    const data = await getAkadUlangDocumentData(pinjamanId, akad2);
    const idsDb = await testDb.getAllAsync<{ id: string }>(
      `SELECT id FROM angsuran_jadwal WHERE dibuat_dari_akad_ulang_id = ? ORDER BY nomor_angsuran`,
      akad2
    );
    expect(data.jadwal.map((j) => j.id)).toEqual(idsDb.map((r) => r.id));
    expect(data.jadwal.length).toBe(4);
    expect(data.jadwal.every((j) => j.dibuatDariAkadUlangId === akad2)).toBe(true);
  });

  test('N5: dua akad ulang menghasilkan dua dokumen berbeda (nomor, isi, jadwal)', async () => {
    const d1 = buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akad1), { tanggalCetak: 'X' });
    const d2 = buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akad2), { tanggalCetak: 'X' });
    const p = await testDb.getFirstAsync<{ nomor_pinjaman: string }>(`SELECT nomor_pinjaman FROM pinjaman WHERE id = ?`, pinjamanId);

    expect(d1.nomorDokumen).toBe(`AU/${p!.nomor_pinjaman}/20260301/001`);
    expect(d2.nomorDokumen).toBe(`AU/${p!.nomor_pinjaman}/20260501/002`);
    expect(d1.nomorDokumen).not.toBe(d2.nomorDokumen);
    expect(d1.namaFileDasar).not.toBe(d2.namaFileDasar);
    expect(d1.jadwal.length).toBe(6);
    expect(d2.jadwal.length).toBe(4);
    expect(buildAkadUlangHtml(d1)).not.toBe(buildAkadUlangHtml(d2));
  });

  test('N6: dokumen HISTORIS tetap memakai jadwal milik event historis (bukan jadwal current)', async () => {
    const data1 = await getAkadUlangDocumentData(pinjamanId, akad1);
    const data2 = await getAkadUlangDocumentData(pinjamanId, akad2);
    const ids1 = new Set(data1.jadwal.map((j) => j.id));
    expect(data2.jadwal.some((j) => ids1.has(j.id))).toBe(false);
    expect(data1.jadwal.every((j) => j.dibuatDariAkadUlangId === akad1)).toBe(true);
    // Jadwal event #1: 1 LUNAS + 5 DIRESTRUKTURISASI (digantikan event #2).
    expect(data1.jadwal.filter((j) => j.status === 'LUNAS').length).toBe(1);
    expect(data1.jadwal.filter((j) => j.digantikanOlehAkadUlangId === akad2).length).toBe(5);

    const doc1 = buildDokumenAkadUlang(data1, { tanggalCetak: 'X' });
    expect(doc1.statusEventLabel).toBe('HISTORIS — DIGANTIKAN');
    expect(buildDokumenAkadUlang(data2, { tanggalCetak: 'X' }).statusEventLabel).toBe('BERLAKU');
    // Syarat sebelum event #2 = syarat hasil event #1.
    expect(data2.event.tenorLama).toBe(6);
    expect(data2.eventSebelumnya?.id).toBe(akad1);
    // Referensi akad awal SELALU akad asli, untuk event mana pun.
    expect(data2.akadAwal).toMatchObject({ tanggal: '2026-01-01', jumlahPinjaman: 12_000_000, tenor: 12, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1 });
    expect(data1.akadAwal).toEqual(data2.akadAwal);
  });

  test('status event ditentukan dari jadwal, BUKAN dari kolom status event (selalu SELESAI)', async () => {
    const statusDb = await testDb.getAllAsync<{ status: string }>(`SELECT status FROM pinjaman_akad_ulang WHERE pinjaman_id = ?`, pinjamanId);
    expect(statusDb.map((r) => r.status)).toEqual(['SELESAI', 'SELESAI']);
    const jadwal = await getJadwalAngsuran(pinjamanId);
    expect(tentukanStatusEventAkadUlang(akad1, jadwal)).toBe('DIGANTIKAN');
    expect(tentukanStatusEventAkadUlang(akad2, jadwal)).toBe('BERLAKU');

    const riwayat = await getRiwayatAkadUlang(pinjamanId);
    const urut = nomorUrutEventAkadUlang(riwayat);
    expect(urut.get(akad1)).toBe(1);
    expect(urut.get(akad2)).toBe(2);
  });

  test('N7: periode dokumen relatif 1/N, 2/N, ... — nomor internal bukan nomor utama', async () => {
    const data = await getAkadUlangDocumentData(pinjamanId, akad2);
    const doc = buildDokumenAkadUlang(data, { tanggalCetak: 'X' });
    expect(doc.jadwal.map((j) => j.periode)).toEqual(['1/4', '2/4', '3/4', '4/4']);
    // Nomor internal meneruskan histori (12 akad asli + 6 akad #1 -> 19..22) dan TIDAK diubah.
    expect(doc.jadwal.map((j) => j.nomorInternal)).toEqual([19, 20, 21, 22]);
    const nomorDb = await testDb.getAllAsync<{ n: number }>(
      `SELECT nomor_angsuran AS n FROM angsuran_jadwal WHERE dibuat_dari_akad_ulang_id = ? ORDER BY nomor_angsuran`,
      akad2
    );
    expect(nomorDb.map((r) => r.n)).toEqual([19, 20, 21, 22]);

    const html = buildAkadUlangHtml(doc);
    expect(html).toContain('>1/4<');
    expect(html).toContain('>4/4<');
    expect(html).not.toMatch(/>19\/|>Angsuran ke-19/);
  });

  test('N8: sisa pokok dokumen berasal dari SNAPSHOT pinjaman_akad_ulang.sisa_pokok', async () => {
    const snap = await testDb.getFirstAsync<{ sisa_pokok: number }>(`SELECT sisa_pokok FROM pinjaman_akad_ulang WHERE id = ?`, akad1);
    const doc = buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akad1), { tanggalCetak: 'X' });
    expect(doc.sisaPokok).toBe(snap!.sisa_pokok);
    expect(doc.sisaPokok).toBe(11_000_000);

    // Bukti provenance: ubah snapshot di fixture -> dokumen mengikuti snapshot,
    // BUKAN menghitung ulang dari jadwal.
    await testDb.runAsync(`UPDATE pinjaman_akad_ulang SET sisa_pokok = 7777777 WHERE id = ?`, akad1);
    const docUbah = buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akad1), { tanggalCetak: 'X' });
    expect(docUbah.sisaPokok).toBe(7_777_777);
    expect(buildAkadUlangHtml(docUbah)).toContain(formatRupiah(7_777_777));
  });

  test('N9: outstanding_piutang_jasa hanya informasi historis/audit — TIDAK ditambahkan ke pokok', async () => {
    await testDb.runAsync(`UPDATE pinjaman_akad_ulang SET outstanding_piutang_jasa = 250000 WHERE id = ?`, akad2);
    const snap = await testDb.getFirstAsync<{ sisa_pokok: number }>(`SELECT sisa_pokok FROM pinjaman_akad_ulang WHERE id = ?`, akad2);
    const doc = buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akad2), { tanggalCetak: 'X' });

    expect(doc.piutangJasaDiakui).toBe(250_000);
    expect(doc.sisaPokok).toBe(snap!.sisa_pokok);
    expect(doc.totalJadwal.pokok).toBe(snap!.sisa_pokok);
    expect(doc.perubahan.find((p) => p.komponen === 'Dasar Pokok')?.sesudah).toBe(formatRupiah(snap!.sisa_pokok));
    const html = buildAkadUlangHtml(doc);
    expect(html).toContain(CATATAN_PIUTANG_JASA);
    expect(html).not.toContain(formatRupiah(snap!.sisa_pokok + 250_000));
  });

  test('N10: export dokumen TIDAK mengubah database (seluruh tabel byte-identik)', async () => {
    // Matriks permission sudah di-seed oleh akadUlangPinjaman() di beforeEach.
    const sebelum = await snapshotDatabase();
    const data = await getAkadUlangDocumentData(pinjamanId, akad1);
    const doc = buildDokumenAkadUlang(data, { tanggalCetak: '24 September 2026, 10.00' });
    const file = await exportDokumenAkadUlangPdf('user-1', doc);
    await getAkadUlangDocumentData(pinjamanId, akad2);
    const sesudah = await snapshotDatabase();

    expect(sesudah).toBe(sebelum);
    expect(file.format).toBe('PDF');
    expect(file.fileName).toMatch(/^dokumen-akad-ulang-.*-001_\d{4}-\d{2}-\d{2}_\d{6}\.pdf$/);
    const panggilan = (Print.printToFileAsync as jest.Mock).mock.calls.at(-1)![0];
    expect(panggilan.html).toBe(buildAkadUlangHtml(doc));
    expect(panggilan.width).toBe(UKURAN_A4_PORTRAIT.width);
    expect(panggilan.height).toBe(UKURAN_A4_PORTRAIT.height);
  });

  test('export dokumen memakai requirePermission existing — role tanpa izin export DITOLAK sebelum file dibuat', async () => {
    const doc = buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akad1), { tanggalCetak: 'X' });
    (Print.printToFileAsync as jest.Mock).mockClear();
    await expect(exportDokumenAkadUlangPdf('user-petugas', doc)).rejects.toThrow();
    expect(Print.printToFileAsync).not.toHaveBeenCalled();
  });

  test('loader menolak event yang bukan milik pinjaman ini', async () => {
    await expect(getAkadUlangDocumentData(pinjamanId, 'akad-tidak-ada')).rejects.toThrow(/tidak ditemukan/);
  });
});

// ======================================================================
// HTML dokumen — struktur, escape, layout A4
// ======================================================================

describe('RC-S82 §K — HTML dokumen akad ulang', () => {
  beforeEach(setupFixture);

  test('struktur bab lengkap, A4 portrait, header tabel diulang, angka rata kanan, ruang tanda tangan', async () => {
    const pinjamanId = await buatPinjamanAktif();
    const { akadUlangId } = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'EFEKTIF',
      persentaseJasaBaru: 1.5,
      actingUserId: 'user-1',
    });
    const html = buildAkadUlangHtml(buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akadUlangId), { tanggalCetak: 'X' }));
    for (const bab of [
      'DOKUMEN AKAD ULANG PINJAMAN',
      'I. IDENTITAS ANGGOTA',
      'II. REFERENSI AKAD AWAL',
      'III. PERUBAHAN AKAD',
      'IV. NILAI AKAD ULANG',
      'V. JADWAL ANGSURAN AKAD ULANG',
      'VI. KETERANGAN',
      'VII. PENGESAHAN',
      'ANGGOTA / PEMINJAM',
      'KOPERASI',
      'Sisa Pokok sebagai Dasar Akad',
      'Piutang Jasa Telah Diakui Sebelum Akad Ulang',
      'KSP Sejahtera Uji',
      'Jl. Merdeka No. 1, Makassar',
      '7371010101010001',
    ]) {
      expect(html).toContain(bab);
    }
    expect(html).toMatch(/@page\s*\{\s*size:\s*A4 portrait/);
    expect(html).toMatch(/thead\s*\{\s*display:\s*table-header-group/);
    // Tabel jadwal TIDAK bersarang di tabel layout (header repeat andal di mesin cetak).
    expect(html).not.toContain('class="halaman"');
    // Footer: nomor pinjaman, nomor akad ulang, tanggal cetak, catatan histori.
    expect(html).toMatch(/class="footer"[\s\S]*No\. Pinjaman[\s\S]*No\. Akad Ulang[\s\S]*tetap tersimpan sebagai histori[\s\S]*Dicetak X/);
    expect(html).toContain('class="num"');
    expect(html).toContain('Efektif');
    expect(html).toContain('1,5% per periode');
    expect(html).not.toMatch(/>EFEKTIF<|>BULAN</);
    expect(html).not.toContain('position: fixed');
    // Tidak ada tanda tangan digital palsu (tidak ada gambar/teks "ttd" otomatis).
    expect(html).not.toMatch(/<img|signature|ditandatangani secara elektronik/i);
  });

  test('teks bebas di-escape; nama/keterangan panjang & nominal besar tetap dirender', async () => {
    const pinjamanId = await buatPinjamanAktif();
    const panjang = 'Nama Sangat Panjang '.repeat(12).trim();
    await testDb.runAsync(`UPDATE anggota SET nama_lengkap = ? WHERE id = ?`, `${panjang} <script>alert(1)</script>`, ANGGOTA_ID);
    const ket = 'Baris pertama & "kutipan"\n' + 'Keterangan panjang. '.repeat(60);
    const { akadUlangId } = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-01',
      tenorBaru: 60,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      keterangan: ket,
      actingUserId: 'user-1',
    });
    const doc = buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akadUlangId), { tanggalCetak: 'X' });
    const html = buildAkadUlangHtml(doc);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Baris pertama &amp; &quot;kutipan&quot;<br />');
    expect(doc.jadwal.length).toBe(60);
    expect(doc.jadwal[59].periode).toBe('60/60');
    expect((html.match(/<tr>\s*<td class="ctr">/g) ?? []).length).toBe(60);
  });

  test('nomor dokumen deterministik & stabil', () => {
    expect(buatNomorDokumenAkadUlang('PJ-000123', '2026-09-24', 2)).toBe('AU/PJ-000123/20260924/002');
    expect(buatNomorDokumenAkadUlang('PJ-000123', '2026-09-24', 2)).toBe(buatNomorDokumenAkadUlang('PJ-000123', '2026-09-24', 2));
  });

  test('urutan event: created_at identik -> tanggal -> id (deterministik)', () => {
    const r = [
      { id: 'b', tanggal: '2026-05-01', createdAt: '2026-05-01T00:00:00.000Z' },
      { id: 'a', tanggal: '2026-03-01', createdAt: '2026-05-01T00:00:00.000Z' },
      { id: 'c', tanggal: '2026-01-01', createdAt: '2026-01-02T00:00:00.000Z' },
    ];
    const u = nomorUrutEventAkadUlang(r);
    expect([u.get('c'), u.get('a'), u.get('b')]).toEqual([1, 2, 3]);
  });

  test('periode relatif murni: dikelompokkan per event, urut nomor internal', () => {
    const m = hitungPeriodeRelatifAkadUlang([
      baris({ id: 'asli', nomorAngsuran: 1 }),
      baris({ id: 'x2', nomorAngsuran: 14, dibuatDariAkadUlangId: 'E1' }),
      baris({ id: 'x1', nomorAngsuran: 13, dibuatDariAkadUlangId: 'E1' }),
      baris({ id: 'y1', nomorAngsuran: 15, dibuatDariAkadUlangId: 'E2' }),
    ]);
    expect(m.has('asli')).toBe(false);
    expect(m.get('x1')).toEqual({ periode: 1, jumlah: 2 });
    expect(m.get('x2')).toEqual({ periode: 2, jumlah: 2 });
    expect(m.get('y1')).toEqual({ periode: 1, jumlah: 1 });
  });
});

// ======================================================================
// N11 — generic export existing tidak berubah
// ======================================================================

describe('RC-S82 — pipeline export laporan existing TIDAK berubah', () => {
  beforeEach(setupFixture);

  test('exportLaporan PDF tetap memakai buildReportHtml generik tanpa opsi A4 baru', async () => {
    const data = {
      judulLaporan: 'Uji',
      namaFileDasar: 'uji',
      namaKoperasi: 'KOP',
      periodeLabel: 'P',
      kolom: ['A', 'B'],
      baris: [['x', 1000]],
      kolomAngka: [1],
    };
    (Print.printToFileAsync as jest.Mock).mockClear();
    await exportLaporan('user-1', data, 'PDF');
    const arg = (Print.printToFileAsync as jest.Mock).mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(['base64', 'html']);
    // Tanggal cetak di buildReportHtml berbasis waktu — bandingkan tanpa baris footer.
    const tanpaFooter = (h: string) => h.replace(/<div class="footer">.*?<\/div>/, '');
    expect(tanpaFooter(arg.html)).toBe(tanpaFooter(buildReportHtml(data)));
  });
});

// ======================================================================
// Audit struktural — layar & tombol
// ======================================================================

describe('RC-S82 — audit struktural source', () => {
  const root = path.resolve(__dirname, '..');
  const screen = fs.readFileSync(path.join(root, 'screens/Pinjaman/PinjamanDetailScreen.tsx'), 'utf8');
  const tombol = fs.readFileSync(path.join(root, 'components/DokumenAkadExportButton.tsx'), 'utf8');

  test('modal tidak lagi mengetik ulang daftar status; memakai helper lifecycle', () => {
    expect(screen).not.toMatch(/j\.status === 'BELUM_BAYAR' \|\| j\.status === 'SEBAGIAN'/);
    expect(screen).toContain('ringkasPosisiAkadUlang(jadwal)');
    expect(screen).toContain('preflightAkadUlang(jadwal)');
  });

  test('wording aksi & konfirmasi sesuai spesifikasi', () => {
    for (const t of [
      'Simpan Akad Ulang',
      'Ya, Simpan Akad Ulang',
      'Kembali',
      'Konfirmasi Akad Ulang',
      'Sisa Pokok Akad Ulang',
      'Piutang Jasa Telah Diakui',
      'Informasi historis/audit — bukan tambahan pokok akad baru.',
      'Jadwal lama tetap tersimpan sebagai histori dan tidak menjadi kewajiban berjalan.',
    ]) {
      expect(screen).toContain(t);
    }
    expect(screen).not.toMatch(/>Lanjutkan</);
    expect(screen).not.toContain('parseInt(akadTenor');
    expect(screen).not.toContain('parseFloat(akadPersentaseJasa');
  });

  test('payload service berasal dari draft tervalidasi yang sama dengan preview/konfirmasi', () => {
    const submit = screen.slice(screen.indexOf('const submitAkadUlang'), screen.indexOf('const openPay'));
    expect(submit).toContain('tenorBaru: akadDraft.tenor');
    expect(submit).toContain('persentaseJasaBaru: akadDraft.persentaseJasa');
    expect(submit).toContain('tanggal: akadDraft.tanggal');
  });

  test('tombol dokumen hanya PDF, generic ExportButton tetap dipakai untuk jadwal', () => {
    // Tidak ada opsi format selain PDF (cek nilai/kode, bukan kata di komentar).
    expect(tombol).not.toMatch(/'EXCEL'|'CSV'|FORMAT_OPTIONS|exportLaporan|exportToExcel|exportToCsv/);
    expect(tombol).toContain('exportDokumenAkadUlangPdf');
    expect(tombol).toContain('exportDokumenAkadAwalPdf');
    expect(tombol).toContain('Dokumen Akad Ulang berhasil dibuat.');
    expect(tombol).toContain('Perjanjian Pinjaman berhasil dibuat.');
    expect(tombol).toContain("'Bagikan'");
    expect(screen).toContain('<ExportButton');
    expect(screen).toContain("dokumen={{ jenis: 'ULANG', akadUlangId: r.id }}");
  });
});

// ======================================================================
// RC-S82 revisi UX — layout sheet Akad Ulang & posisi export
// ======================================================================

describe('RC-S82 revisi UX — sheet Akad Ulang & seksi export', () => {
  const root = path.resolve(__dirname, '..');
  const screen = fs.readFileSync(path.join(root, 'screens/Pinjaman/PinjamanDetailScreen.tsx'), 'utf8');
  const tombol = fs.readFileSync(path.join(root, 'components/DokumenAkadExportButton.tsx'), 'utf8');

  const blokSheet = screen.slice(screen.indexOf('function AkadSheet('), screen.indexOf('/** RC-S82 — baris label/nilai'));
  const render = screen.slice(screen.indexOf('KARTU "AKAD & DOKUMEN"'), screen.indexOf('function AkadSheet('));

  test('bug overflow: formulir akad TIDAK lagi di dalam modalUi.card yang dibungkus ScrollView luar', () => {
    const modalAkad = render.slice(render.indexOf('<AkadSheet'), render.lastIndexOf('</AkadSheet>'));
    expect(modalAkad.length).toBeGreaterThan(0);
    expect(modalAkad).not.toContain('styles.modalCard');
    expect(modalAkad).not.toContain('styles.modalScrollContent');
    expect((render.match(/<AkadSheet\b/g) ?? []).length).toBe(2); // formulir + konfirmasi
  });

  test('sheet: header TETAP -> body SCROLL -> footer TETAP (footer di luar ScrollView)', () => {
    const iHeader = blokSheet.indexOf('styles.sheetHeader');
    const iScroll = blokSheet.indexOf('<ScrollView');
    const iScrollEnd = blokSheet.indexOf('</ScrollView>');
    const iFooter = blokSheet.indexOf('styles.sheetFooter');
    expect(iHeader).toBeGreaterThan(-1);
    expect(iHeader).toBeLessThan(iScroll);
    expect(iScrollEnd).toBeLessThan(iFooter);
    expect(blokSheet).toContain('keyboardShouldPersistTaps="handled"');
    // Tombol aksi disuplai lewat prop footer, bukan di dalam body.
    const modalForm = render.slice(render.indexOf('<AkadSheet'), render.indexOf('</AkadSheet>'));
    const bodyForm = modalForm.slice(modalForm.indexOf('>\n', modalForm.indexOf('footer={')));
    expect(modalForm.indexOf('Simpan Akad Ulang')).toBeLessThan(modalForm.indexOf('Posisi Saat Ini'));
    expect(bodyForm).toContain('Posisi Saat Ini');
  });

  test('tinggi sheet dibatasi di SATU tempat, body yang menyusut (bukan kartu yang terpotong)', () => {
    expect(screen).toMatch(/sheetWrap: \{ width: '100%', maxHeight: '92%' \}/);
    expect(screen).toMatch(/sheet: \{ \.\.\.modalUi\.sheet, maxHeight: '100%', padding: 0, overflow: 'hidden' \}/);
    expect(screen).toMatch(/sheetBody: \{ flexGrow: 0, flexShrink: 1 \}/);
  });

  test('tombol memakai token modalUi (tinggi sentuh seragam), bukan gaya ad-hoc', () => {
    expect(screen).toContain('sheetPrimary: { ...modalUi.primaryButton');
    expect(screen).toContain('sheetSecondary: { ...modalUi.secondaryButton');
    expect(screen).toContain('akadPrimaryButton: { ...modalUi.primaryButton');
  });

  test('export dokumen TEPAT di bawah aksi Akad Ulang, sebelum riwayat', () => {
    const iAksi = render.indexOf('onPress={bukaAkadUlang}');
    const iExport = render.indexOf("dokumen={{ jenis: 'ULANG', akadUlangId: riwayatAkad[0]?.id ?? null }}");
    const iRiwayat = render.indexOf('Riwayat Akad Ulang (');
    expect(iAksi).toBeGreaterThan(-1);
    expect(iAksi).toBeLessThan(iExport);
    expect(iExport).toBeLessThan(iRiwayat);
    // Selalu terlihat; nonaktif + keterangan bila belum ada akad ulang.
    expect(render).toContain('Tersedia setelah akad ulang pertama disimpan.');
    expect(tombol).toMatch(/const tersedia = dokumen\.jenis === 'AWAL' \|\| !!dokumen\.akadUlangId;/);
    expect(tombol).toMatch(/const disabled = !currentUser \|\| memproses \|\| !tersedia;/);
  });

  test('label pilihan tenor/metode manusiawi & dapat diakses sebagai radio', () => {
    expect(render).toContain('labelSatuanTenor(sat)');
    expect(render).toContain('labelMetodeJasa(m)');
    expect((render.match(/accessibilityRole="radio"/g) ?? []).length).toBe(2);
    expect(render).not.toMatch(/>\{sat\}<|>\{m\}</);
  });
});

// ======================================================================
// RC-S82 (lanjutan) — DOKUMEN AKAD AWAL (tanpa akad ulang)
// ======================================================================

describe('RC-S82 — dokumen akad awal', () => {
  beforeEach(setupFixture);

  test('dapat diekspor TANPA akad ulang: syarat, jadwal 1/N, total pokok = jumlah pinjaman', async () => {
    const pinjamanId = await buatPinjamanAktif();
    expect(await getRiwayatAkadUlang(pinjamanId)).toEqual([]);
    const data = await getAkadAwalDocumentData(pinjamanId);
    const doc = buildDokumenAkadAwal(data, { tanggalCetak: 'X' });
    const p = await testDb.getFirstAsync<{ nomor_pinjaman: string; jumlah_pinjaman: number }>(
      `SELECT nomor_pinjaman, jumlah_pinjaman FROM pinjaman WHERE id = ?`,
      pinjamanId
    );

    expect(doc.nomorDokumen).toBe(`AK/${p!.nomor_pinjaman}/20260101`);
    expect(doc.sifat).toBe('FINAL');
    expect(doc.statusAkadLabel).toBe('BERLAKU');
    expect(doc.pemberitahuanPenggantian).toBeNull();
    expect(doc.jadwal.map((j) => j.periode)).toEqual(Array.from({ length: 12 }, (_, i) => `${i + 1}/12`));
    expect(doc.totalJadwal.pokok).toBe(p!.jumlah_pinjaman);
    const sumDb = await testDb.getFirstAsync<{ j: number; t: number }>(
      `SELECT SUM(jasa) AS j, SUM(total) AS t FROM angsuran_jadwal WHERE pinjaman_id = ? AND dibuat_dari_akad_ulang_id IS NULL`,
      pinjamanId
    );
    expect(doc.totalJadwal.jasa).toBe(sumDb!.j);
    expect(doc.totalJadwal.total).toBe(sumDb!.t);
    expect(doc.ketentuan).toEqual(
      expect.arrayContaining([
        { label: 'Tenor', nilai: '12 Bulan' },
        { label: 'Metode Jasa', nilai: 'Flat' },
        { label: 'Persentase Jasa', nilai: '1% per periode' },
        { label: 'Biaya Administrasi', nilai: 'Tidak ada' },
        { label: 'Denda Keterlambatan', nilai: 'Tidak diberlakukan' },
      ])
    );

    const html = buildAkadAwalHtml(doc);
    for (const t of [
      'PERJANJIAN PINJAMAN',
      'PIHAK PERTAMA',
      'PIHAK KEDUA',
      'Pasal 1',
      'Pasal 10',
      'LAMPIRAN — JADWAL ANGSURAN',
      'Ringkasan Ketentuan Pinjaman',
      'KSP Sejahtera Uji',
      '7371010101010001',
      '>12/12<',
    ]) {
      expect(html).toContain(t);
    }
    expect(html).not.toContain('class="draf"');
    expect(html).not.toContain('class="info"');
    expect(html).toMatch(/thead\s*\{\s*display:\s*table-header-group/);
  });

  test('setelah akad ulang: dokumen akad awal tetap memakai syarat & jadwal ASLI (bukan syarat terbaru)', async () => {
    const pinjamanId = await buatPinjamanAktif();
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'MENURUN',
      persentaseJasaBaru: 1.5,
      actingUserId: 'user-1',
    });
    const baris = await testDb.getFirstAsync<{ tenor: number; metode_jasa: string }>(`SELECT tenor, metode_jasa FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(baris).toEqual({ tenor: 6, metode_jasa: 'MENURUN' }); // baris pinjaman = syarat TERBARU

    const doc = buildDokumenAkadAwal(await getAkadAwalDocumentData(pinjamanId), { tanggalCetak: 'X' });
    expect(doc.ketentuan.find((k) => k.label === 'Tenor')?.nilai).toBe('12 Bulan');
    expect(doc.ketentuan.find((k) => k.label === 'Metode Jasa')?.nilai).toBe('Flat');
    expect(doc.jadwal.length).toBe(12); // jadwal asli, termasuk yang sudah digantikan
    expect(doc.totalJadwal.pokok).toBe(12_000_000);
    expect(doc.statusAkadLabel).toBe('HISTORIS — DIGANTIKAN AKAD ULANG');
    expect(doc.pemberitahuanPenggantian).toMatch(/diubah melalui Akad Ulang tanggal 1 Maret 2026/);
    expect(buildAkadAwalHtml(doc)).toContain('class="info"');
  });

  test('pinjaman belum dicairkan -> perjanjian utuh siap ditandatangani (tanpa DRAF); pinjaman ditolak -> tidak ada dokumen', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-02-01',
      jumlahPinjaman: 5_000_000,
      tenor: 5,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'PERSENTASE',
      biayaAdminNilai: 1,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    const doc = buildDokumenAkadAwal(await getAkadAwalDocumentData(id), { tanggalCetak: 'X' });
    expect(doc.sifat).toBe('BELUM_DICAIRKAN');
    expect(doc.statusAkadLabel).toBe('AKAD AWAL');
    expect(doc.ketentuan.find((k) => k.label === 'Biaya Administrasi')?.nilai).toBe('1% dari jumlah pinjaman');
    // Akad ditandatangani SEBELUM pencairan -> tidak boleh ada tanda DRAF.
    expect(buildAkadAwalHtml(doc)).not.toMatch(/DRAF|belum berlaku sebagai perjanjian/);

    await testDb.runAsync(`UPDATE pinjaman SET status = 'DITOLAK' WHERE id = ?`, id);
    await expect(getAkadAwalDocumentData(id)).rejects.toThrow(/ditolak/);
  });

  test('export akad awal: DB tidak berubah, A4, izin existing (PETUGAS ditolak sebelum file dibuat)', async () => {
    const pinjamanId = await buatPinjamanAktif();
    const sebelum = await snapshotDatabase();
    const doc = buildDokumenAkadAwal(await getAkadAwalDocumentData(pinjamanId), { tanggalCetak: 'X' });
    const file = await exportDokumenAkadAwalPdf('user-1', doc);
    expect(await snapshotDatabase()).toBe(sebelum);
    expect(file.fileName).toMatch(/^perjanjian-pinjaman-.*_\d{4}-\d{2}-\d{2}_\d{6}\.pdf$/);
    const arg = (Print.printToFileAsync as jest.Mock).mock.calls.at(-1)![0];
    expect(arg.html).toBe(buildAkadAwalHtml(doc));
    expect([arg.width, arg.height]).toEqual([UKURAN_A4_PORTRAIT.width, UKURAN_A4_PORTRAIT.height]);

    (Print.printToFileAsync as jest.Mock).mockClear();
    await expect(exportDokumenAkadAwalPdf('user-petugas', doc)).rejects.toThrow();
    expect(Print.printToFileAsync).not.toHaveBeenCalled();
  });

  test('helper murni: biaya admin tersimpan, nomor dokumen, sifat dokumen', () => {
    expect(labelBiayaAdmin('NOMINAL', 50000, formatRupiah)).toBe(formatRupiah(50000));
    expect(labelBiayaAdmin('PERSENTASE', 2, formatRupiah)).toBe('2% dari jumlah pinjaman');
    expect(labelBiayaAdmin('TIDAK_ADA', 0, formatRupiah)).toBe('Tidak ada');
    expect(buatNomorDokumenAkadAwal('PJ-1', '2026-01-05')).toBe('AK/PJ-1/20260105');
    expect(statusDokumenAkadAwal('AKTIF')).toBe('FINAL');
    expect(statusDokumenAkadAwal('LUNAS')).toBe('FINAL');
    expect(statusDokumenAkadAwal('DIAJUKAN')).toBe('BELUM_DICAIRKAN');
    expect(statusDokumenAkadAwal('DISETUJUI')).toBe('BELUM_DICAIRKAN');
    expect(statusDokumenAkadAwal('DITOLAK')).toBe('TIDAK_TERSEDIA');
  });

  test('template bersama: kedua dokumen punya nomor halaman, baris tempat/tanggal, dan struktur identik', async () => {
    const pinjamanId = await buatPinjamanAktif();
    const { akadUlangId } = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });
    const awal = buildAkadAwalHtml(buildDokumenAkadAwal(await getAkadAwalDocumentData(pinjamanId), { tanggalCetak: 'X' }));
    const ulang = buildAkadUlangHtml(buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akadUlangId), { tanggalCetak: 'X' }));
    for (const html of [awal, ulang]) {
      expect(html).toContain('counter(page) " dari " counter(pages)');
      expect(html).toContain('Ditandatangani di');
      expect(html).toContain('class="kop"');
      expect(html).toContain('class="footer"');
      expect(html).not.toContain('position: fixed');
    }
  });

  test('layar: export dokumen akad awal TIDAK bergantung pada riwayat akad ulang, dan tampil sebelum blok akad ulang', () => {
    const screen = fs.readFileSync(path.resolve(__dirname, '..', 'screens/Pinjaman/PinjamanDetailScreen.tsx'), 'utf8');
    const kartu = screen.slice(screen.indexOf('KARTU "AKAD & DOKUMEN"'), screen.indexOf('function AkadSheet('));
    const iAwal = kartu.indexOf("dokumen={{ jenis: 'AWAL' }}");
    const iBlokUlang = kartu.indexOf('{/* B. AKAD ULANG */}');
    expect(iAwal).toBeGreaterThan(-1);
    expect(iAwal).toBeLessThan(iBlokUlang);
    // Satu-satunya syarat kartu: dokumen akad awal tersedia (bukan DITOLAK).
    expect(kartu).toContain("{akadAwal && akadAwal.sifat !== 'TIDAK_TERSEDIA' && (");
    expect(kartu.slice(0, iAwal)).not.toContain('riwayatAkad.length > 0 &&');
  });
});

// ======================================================================
// RC-S82 (lanjutan) — PENGURUS INTI + PERJANJIAN PINJAMAN BERDASAR HUKUM
// ======================================================================

describe('RC-S82 — pengurus inti (murni)', () => {
  test('pengenalan jabatan KETAT: Wakil Ketua / Ketua Pengawas BUKAN Ketua; ejaan "Sekertaris" diterima', () => {
    expect(kenaliJabatanPengurusInti('Ketua')).toBe('KETUA');
    expect(kenaliJabatanPengurusInti('  ketua   pengurus ')).toBe('KETUA');
    expect(kenaliJabatanPengurusInti('Sekertaris')).toBe('SEKRETARIS');
    expect(kenaliJabatanPengurusInti('Bendahara Koperasi')).toBe('BENDAHARA');
    for (const bukan of ['Wakil Ketua', 'Ketua Pengawas', 'Wakil Bendahara', 'Anggota', '', null]) {
      expect(kenaliJabatanPengurusInti(bukan)).toBeNull();
    }
  });

  test('pemilihan per tanggal: pejabat lama pada tanggal lama, pejabat baru setelah pergantian', () => {
    const base = { jenisPersonel: 'PENGURUS', statusAktif: true, updatedAt: '2026-01-01T00:00:00Z' };
    const k = [
      { ...base, id: 'a', nama: 'Lama', jabatan: 'Ketua', tanggalMulaiJabatan: '2023-01-01', tanggalBerakhirJabatan: '2026-03-31' },
      { ...base, id: 'b', nama: 'Baru', jabatan: 'Ketua', tanggalMulaiJabatan: '2026-04-01', tanggalBerakhirJabatan: null },
      { ...base, id: 'c', nama: 'Nonaktif', jabatan: 'Bendahara', tanggalMulaiJabatan: null, tanggalBerakhirJabatan: null, statusAktif: false },
      { ...base, id: 'd', nama: 'Pengawas', jabatan: 'Ketua', tanggalMulaiJabatan: null, tanggalBerakhirJabatan: null, jenisPersonel: 'PENGAWAS' },
    ];
    expect(pilihSusunanPengurusInti(k, '2026-01-15').KETUA?.nama).toBe('Lama');
    expect(pilihSusunanPengurusInti(k, '2026-05-01').KETUA?.nama).toBe('Baru');
    expect(pilihSusunanPengurusInti(k, '2026-05-01').BENDAHARA).toBeNull();
    expect(masaJabatanTumpangTindih(k[0], k[1])).toBe(false);
    expect(masaJabatanTumpangTindih(k[0], { tanggalMulaiJabatan: '2026-03-31', tanggalBerakhirJabatan: null })).toBe(true);
  });
});

describe('RC-S82 — pengurus inti (service, SQLite nyata)', () => {
  beforeEach(setupFixture);

  test('jabatan inti dikanonikkan; satu jabatan inti satu orang; pergantian via tanggal berakhir; Wakil Ketua boleh banyak', async () => {
    const lama = await buatPersonel({ nama: 'Ahmad', jenisPersonel: 'PENGURUS', jabatan: 'ketua pengurus', tanggalMulaiJabatan: '2024-01-01' });
    expect((await getPersonel(lama))!.jabatan).toBe('Ketua');

    await expect(
      buatPersonel({ nama: 'Bambang', jenisPersonel: 'PENGURUS', jabatan: 'Ketua', tanggalMulaiJabatan: '2026-06-01' })
    ).rejects.toThrow(/sudah dipegang oleh Ahmad/);

    await perbaruiPersonel(lama, { nama: 'Ahmad', jenisPersonel: 'PENGURUS', jabatan: 'Ketua', tanggalMulaiJabatan: '2024-01-01', tanggalBerakhirJabatan: '2026-05-31' });
    const baru = await buatPersonel({ nama: 'Bambang', jenisPersonel: 'PENGURUS', jabatan: 'Ketua', tanggalMulaiJabatan: '2026-06-01' });
    expect((await getSusunanPengurusInti('2026-01-01')).KETUA?.nama).toBe('Ahmad');
    expect((await getSusunanPengurusInti('2026-07-01')).KETUA?.nama).toBe('Bambang');

    await buatPersonel({ nama: 'W1', jenisPersonel: 'PENGURUS', jabatan: 'Wakil Ketua' });
    await buatPersonel({ nama: 'W2', jenisPersonel: 'PENGURUS', jabatan: 'Wakil Ketua' });
    // Ketua Pengawas bukan Ketua Pengurus — tidak bentrok.
    await buatPersonel({ nama: 'P1', jenisPersonel: 'PENGAWAS', jabatan: 'Ketua' });

    // Mengaktifkan kembali tidak boleh menghasilkan dua Ketua bersamaan.
    await setStatusPersonel(baru, false);
    const tiga = await buatPersonel({ nama: 'Citra', jenisPersonel: 'PENGURUS', jabatan: 'Ketua', tanggalMulaiJabatan: '2026-06-01' });
    await expect(setStatusPersonel(baru, true)).rejects.toThrow(/sudah dipegang oleh Citra/);
    expect(tiga).toBeTruthy();
  });
});

describe('RC-S82 — terbilang & nama hari', () => {
  test('terbilang rupiah', () => {
    const kasus: Array<[number, string]> = [
      [0, 'nol'], [1, 'satu'], [11, 'sebelas'], [12, 'dua belas'], [19, 'sembilan belas'], [20, 'dua puluh'],
      [100, 'seratus'], [101, 'seratus satu'], [115, 'seratus lima belas'], [1000, 'seribu'], [1001, 'seribu satu'],
      [2500, 'dua ribu lima ratus'], [12_000_000, 'dua belas juta'], [1_440_000, 'satu juta empat ratus empat puluh ribu'],
      [13_440_000, 'tiga belas juta empat ratus empat puluh ribu'], [2_500_750, 'dua juta lima ratus ribu tujuh ratus lima puluh'],
      [1_000_000_000, 'satu miliar'], [987_654_321_000, 'sembilan ratus delapan puluh tujuh miliar enam ratus lima puluh empat juta tiga ratus dua puluh satu ribu'],
    ];
    for (const [n, k] of kasus) expect(terbilang(n)).toBe(k);
    expect(terbilangRupiah(12_000_000)).toBe('dua belas juta rupiah');
    expect(() => terbilang(-1)).toThrow();
    expect(() => terbilang(1.5)).toThrow();
  });

  test('nama hari tidak bergantung zona waktu', () => {
    expect(namaHari('2026-01-01')).toBe('Kamis');
    expect(namaHari('2026-09-24')).toBe('Kamis');
    expect(namaHari('2026-03-01')).toBe('Minggu');
  });
});

describe('RC-S82 — Perjanjian Pinjaman merujuk peraturan & pengurus', () => {
  beforeEach(setupFixture);

  async function isiPengurus() {
    await testDb.runAsync(`UPDATE koperasi SET nomor_badan_hukum = '123/BH/XX/2020'`);
    await buatPersonel({ nama: 'Hj. Ketua Lama', jenisPersonel: 'PENGURUS', jabatan: 'Ketua', tanggalMulaiJabatan: '2020-01-01', tanggalBerakhirJabatan: '2026-02-28' });
    await buatPersonel({ nama: 'Ketua Baru', jenisPersonel: 'PENGURUS', jabatan: 'Ketua', tanggalMulaiJabatan: '2026-03-01' });
    await buatPersonel({ nama: 'Sri Sekretaris', jenisPersonel: 'PENGURUS', jabatan: 'Sekretaris', tanggalMulaiJabatan: '2020-01-01' });
    await buatPersonel({ nama: 'Bayu Bendahara', jenisPersonel: 'PENGURUS', jabatan: 'Bendahara', tanggalMulaiJabatan: '2020-01-01' });
  }

  test('isi perjanjian: kepala, PARA PIHAK, dasar hukum, pasal 1-10, terbilang, pengurus pada TANGGAL AKAD, meterai, lampiran', async () => {
    await isiPengurus();
    const pinjamanId = await buatPinjamanAktif(); // akad 2026-01-01 -> Ketua LAMA yang menjabat
    const doc = buildDokumenAkadAwal(await getAkadAwalDocumentData(pinjamanId), { tanggalCetak: 'X' });
    const html = buildAkadAwalHtml(doc);

    expect(doc.kalimatPembukaan).toBe('Pada hari ini, Kamis, tanggal 1 Januari 2026, yang bertanda tangan di bawah ini:');
    expect(doc.pihakPertama.rincian[0]).toEqual({ label: 'Nama', nilai: 'Hj. Ketua Lama' });
    expect(doc.pihakPertama.peran).toContain('badan hukum koperasi Nomor 123/BH/XX/2020');
    expect(doc.pihakPertama.peran).toContain('Pasal 30 ayat (2) huruf a Undang-Undang Nomor 25 Tahun 1992 tentang Perkoperasian');
    expect(doc.pasal.map((p) => p.nomor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(doc.pasal[0].ayat[0]).toContain('Rp12.000.000 (dua belas juta rupiah)'.replace('Rp12.000.000', formatRupiah(12_000_000)));
    expect(doc.pasal[1].ayat[0]).toContain('12 (dua belas) Bulan');
    expect(doc.pasal[4].ayat[0]).toMatch(/tidak dikenakan denda/); // denda_aktif = 0 pada fixture

    for (const d of DASAR_HUKUM_PERJANJIAN_PINJAMAN) expect(html).toContain(d.replace(/&/g, '&amp;'));
    for (const t of [
      'Undang-Undang Nomor 25 Tahun 1992 tentang Perkoperasian beserta perubahannya',
      'Peraturan Menteri Koperasi dan Usaha Kecil dan Menengah Nomor 8 Tahun 2023',
      'Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi',
      'Undang-Undang Nomor 10 Tahun 2020 tentang Bea Meterai',
      'Meterai Rp10.000',
      'Hj. Ketua Lama',
      'LAMPIRAN — JADWAL ANGSURAN',
    ]) {
      expect(html).toContain(t);
    }
    // Sekretaris & Bendahara TIDAK dicetak di dokumen (hanya Ketua yang menandatangani).
    for (const t of ['Sri Sekretaris', 'Bayu Bendahara', 'SEKRETARIS', 'BENDAHARA', 'Mengetahui,']) {
      expect(html).not.toContain(t);
    }
    expect(html).not.toContain('Ketua Baru'); // pejabat SETELAH tanggal akad tidak dipakai
    expect(html).toMatch(/\.lampiran-judul \{ page-break-before: always/);
  });

  test('pengurus belum ditetapkan -> garis titik-titik, BUKAN nama karangan', async () => {
    const pinjamanId = await buatPinjamanAktif();
    const doc = buildDokumenAkadAwal(await getAkadAwalDocumentData(pinjamanId), { tanggalCetak: 'X' });
    const html = buildAkadAwalHtml(doc);
    expect(doc.pihakPertama.rincian[0].nilai).toMatch(/^\.+$/);
    expect((html.match(/\(\.{20,}\)/g) ?? []).length).toBe(1); // hanya Ketua
  });

  test('dokumen akad ulang: pengurus pada tanggal akad ulang + merujuk nomor perjanjian awal', async () => {
    await isiPengurus();
    const pinjamanId = await buatPinjamanAktif();
    const { akadUlangId } = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-15',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });
    const doc = buildDokumenAkadUlang(await getAkadUlangDocumentData(pinjamanId, akadUlangId), { tanggalCetak: 'X' });
    const html = buildAkadUlangHtml(doc);
    const p = await testDb.getFirstAsync<{ nomor_pinjaman: string }>(`SELECT nomor_pinjaman FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(doc.nomorAkadAwal).toBe(`AK/${p!.nomor_pinjaman}/20260101`);
    expect(html).toContain(`perubahan atas Perjanjian Pinjaman Nomor AK/${p!.nomor_pinjaman}/20260101`);
    expect(html).toContain('Ketua Baru'); // menjabat pada 2026-03-15
    expect(html).not.toContain('Hj. Ketua Lama');
    expect(html).toContain('Meterai Rp10.000');
    expect(html).not.toContain('Sri Sekretaris');
    expect(html).not.toContain('Bayu Bendahara');
  });

  test('perjanjian tetap read-only: export tidak mengubah database', async () => {
    await isiPengurus();
    const pinjamanId = await buatPinjamanAktif();
    const sebelum = await snapshotDatabase();
    await exportDokumenAkadAwalPdf('user-1', buildDokumenAkadAwal(await getAkadAwalDocumentData(pinjamanId), { tanggalCetak: 'X' }));
    expect(await snapshotDatabase()).toBe(sebelum);
  });

  test('layar: kartu Susunan Pengurus + pilihan jabatan inti di menu Pengurus; peringatan di Detail Pinjaman', () => {
    const root = path.resolve(__dirname, '..');
    const master = fs.readFileSync(path.join(root, 'screens/Pengaturan/MasterKoperasiScreens.tsx'), 'utf8');
    const detail = fs.readFileSync(path.join(root, 'screens/Pinjaman/PinjamanDetailScreen.tsx'), 'utf8');
    expect(master).toContain('Susunan Pengurus');
    expect(master).toContain("jenisAktif === 'PENGURUS' && susunan");
    expect(master).toContain("([...JABATAN_PENGURUS_INTI, 'LAINNYA'] as const)");
    expect(master).toContain('getSusunanPengurusInti(getTanggalLokalHariIni())');
    expect(master).not.toMatch(/SELECT|INSERT|UPDATE /); // tetap tanpa SQL di layar
    expect(detail).toContain('getSusunanPengurusInti(detail.tanggal)');
    expect(detail).toContain('Export Perjanjian Pinjaman');
  });
});
