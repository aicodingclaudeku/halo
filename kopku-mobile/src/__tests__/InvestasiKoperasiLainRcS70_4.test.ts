import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S70.4 — PENYERTAAN PADA KOPERASI LAIN: filter & validasi Bagian SHU
 * dan Imbal Hasil Tetap.
 *
 * DATABASE: SQLite sungguhan (skema produksi), AccountingEngine asli,
 * `listInvestasi` asli.
 *
 * Matriks filter picker: harness tidak dapat merender komponen React Native,
 * jadi predikat filter DIAMBIL dari source `InvestasiPicker.tsx` (teks yang
 * benar-benar dikapalkan, bukan salinan) lalu dievaluasi terhadap data
 * yang dibaca `listInvestasi` dari database. Bila predikat di komponen
 * berubah bentuk, pengambilan gagal dan test gagal — tidak diam-diam lolos.
 *
 * Nama jenis di instruksi dipetakan ke enum skema yang sebenarnya:
 *   DEPOSITO_BERJANGKA   -> DEPOSITO_BANK_UMUM
 *   INVESTASI_USAHA_LAIN -> USAHA_LAIN
 *   "nonaktif"           -> status DIBATALKAN / DILEPAS (status aktif = AKTIF)
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

import { catatBagianShuInvestasi, catatPenerimaanBagianShu } from '@/services/BagianShuService';
import {
  tambahPendapatanInvestasi,
  koreksiTransaksiPendapatan,
  PendapatanInvestasiDitolakError,
} from '@/services/PendapatanLainnyaService';
import { listInvestasi, type InvestasiListItem } from '@/services/InvestasiService';
import { JENIS_INVESTASI_BAGIAN_SHU, KEBIJAKAN_PENDAPATAN_INVESTASI } from '@/config/pendapatanKoperasiPolicy';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/**
 * Predikat filter persis seperti tertulis di InvestasiPicker.tsx:
 *   (i) => i.status === 'AKTIF' && (!onlyJenisInvestasi || i.jenisInvestasi === onlyJenisInvestasi)
 */
function predikatDariPicker(): (i: InvestasiListItem, onlyJenisInvestasi?: string) => boolean {
  const src = readFileSync(join(__dirname, '..', '..', 'src/components/InvestasiPicker.tsx'), 'utf8');
  const awal = src.search(/all\.filter\(\s*\(i\)\s*=>/);
  if (awal < 0) throw new Error('Predikat filter InvestasiPicker tidak ditemukan — bentuk source berubah.');
  const mulai = src.indexOf('=>', awal) + 2;
  // Ambil badan arrow function dengan menghitung kurung: berhenti tepat
  // sebelum ')' yang menutup pemanggilan `all.filter(`.
  let kedalaman = 0;
  let akhir = mulai;
  for (; akhir < src.length; akhir++) {
    const c = src[akhir];
    if (c === '(') kedalaman++;
    else if (c === ')') {
      if (kedalaman === 0) break;
      kedalaman--;
    }
  }
  const badan = src.slice(mulai, akhir).replace(/\s+/g, ' ').trim();
  if (!/i\.status === 'AKTIF'/.test(badan)) throw new Error(`Predikat tak terduga: ${badan}`);
  return new Function('i', 'onlyJenisInvestasi', `return (${badan});`) as any;
}

function saringSepertiPicker(semua: InvestasiListItem[], only?: string): InvestasiListItem[] {
  const p = predikatDariPicker();
  return semua.filter((i) => p(i, only));
}

const AKUN = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  piutang: 'acc-1-1220',
  hasilInvestasi: 'acc-4-1300',
  imbalTetap: 'acc-4-1700',
  rak: 'acc-1-1800',
  unitUsaha: 'acc-4-1400',
  penyertaan: 'acc-1-1610',
};

const INV = {
  kopAktif: 'inv-A-kop-aktif',
  usahaLain: 'inv-B-usaha-lain',
  deposito: 'inv-C-deposito',
  kopBatal: 'inv-D-kop-batal',
  properti: 'inv-E-properti',
  kopDilepas: 'inv-F-kop-dilepas',
};

async function seedAkun(id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT', lhu: string | null = null) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?,?)`,
    id, kode, nama, kat, nb, lhu, now, now
  );
}

async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

async function seedInvestasi(id: string, nomor: string, jenis: string, nama: string, status = 'AKTIF') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
    id, nomor, jenis, nama, 10_000_000, '2026-01-05', 'KAS', status, 'user-1', now
  );
}

async function seedFixture(opts: { periode2026?: 'OPEN' | 'CLOSED' } = {}) {
  testDb = await createTestDb();
  const now = new Date().toISOString();
  await seedAkun(AKUN.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAkun(AKUN.bank, '1-1100', 'Bank BCA', 'ASET', 'DEBIT');
  await seedAkun(AKUN.piutang, '1-1220', 'Piutang Pendapatan Investasi', 'ASET', 'DEBIT');
  await seedAkun(AKUN.penyertaan, '1-1610', 'Penyertaan pada Koperasi Lain', 'ASET', 'DEBIT');
  await seedAkun(AKUN.rak, '1-1800', 'Rekening Antar Kantor/Unit (RAKU)', 'ASET', 'DEBIT');
  await seedAkun(AKUN.hasilInvestasi, '4-1300', 'Pendapatan Hasil Investasi', 'PENDAPATAN', 'KREDIT', 'HASIL_INVESTASI');
  await seedAkun(AKUN.unitUsaha, '4-1400', 'Pendapatan Unit Usaha', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_USAHA_LAIN');
  await seedAkun(AKUN.imbalTetap, '4-1700', 'Pendapatan Bagi Hasil', 'PENDAPATAN', 'KREDIT', 'HASIL_INVESTASI');

  await seedMapping('KAS_UMUM', 'DEFAULT', AKUN.kas);
  await seedMapping('BAGIAN_SHU_INVESTASI', 'DEBIT_PIUTANG', AKUN.piutang);
  await seedMapping('BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN', AKUN.hasilInvestasi);
  await seedMapping('BAGIAN_SHU_PENERIMAAN', 'KREDIT_PIUTANG', AKUN.piutang);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2025',2025,'2025-01-01','2025-12-31','CLOSED')`
  );
  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2026',2026,'2026-01-01','2026-12-31',?)`,
    opts.periode2026 ?? 'OPEN'
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES ('bank-1','BCA','123','Koperasi',0,?,1,?)`,
    AKUN.bank, now
  );

  await seedInvestasi(INV.kopAktif, 'INV-2026-000001', 'KOPERASI_LAIN', 'Koperasi Mitra Sejahtera');
  await seedInvestasi(INV.usahaLain, 'INV-2026-000002', 'USAHA_LAIN', 'CV Koperasi Nama Mirip'); // nama memuat "Koperasi" — sengaja
  await seedInvestasi(INV.deposito, 'INV-2026-000003', 'DEPOSITO_BANK_UMUM', 'Deposito Bank Contoh');
  await seedInvestasi(INV.kopBatal, 'INV-2026-000004', 'KOPERASI_LAIN', 'Koperasi Lama', 'DIBATALKAN');
  await seedInvestasi(INV.properti, 'INV-2026-000005', 'PROPERTI_INVESTASI', 'Ruko Contoh');
  await seedInvestasi(INV.kopDilepas, 'INV-2026-000006', 'KOPERASI_LAIN', 'Koperasi Sudah Dilepas', 'DILEPAS');
}

async function n(sql: string, ...p: unknown[]): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(sql, ...(p as any[]));
  return Number(r?.n ?? 0);
}

async function jumlahTulisan() {
  return {
    jurnal: await n(`SELECT COUNT(*) AS n FROM journal`),
    baris: await n(`SELECT COUNT(*) AS n FROM journal_entry`),
    shu: await n(`SELECT COUNT(*) AS n FROM investasi_bagian_shu`),
    kas: await n(`SELECT COUNT(*) AS n FROM kas_transaksi`),
    bank: await n(`SELECT COUNT(*) AS n FROM bank_transaksi`),
  };
}

async function barisJurnal(journalId: string) {
  return testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
    `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, journalId
  );
}

async function gagal(p: Promise<unknown>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as Error;
  }
}

const shuInput = (investasiId: string, nomorDokumen = 'BA-RAT-2026-01') => ({
  investasiId,
  tanggalHak: '2026-03-20',
  jumlah: 4_000_000,
  jenisDokumen: 'Berita Acara RAT',
  nomorDokumen,
  tanggalDokumen: '2026-03-20',
  createdBy: 'user-1',
});

const imbalInput = (investasiId: string, nomorDokumen = 'IHT-001', extra: Record<string, unknown> = {}) => ({
  kategori: 'IMBAL_HASIL_TETAP' as const,
  investasiId,
  tanggal: '2026-04-10',
  nominal: 1_500_000,
  jenis: 'KAS' as const,
  createdBy: 'user-1',
  nomorDokumen,
  ...extra,
});

const AKUN_TERLARANG = [AKUN.rak, AKUN.unitUsaha, AKUN.penyertaan];

// ============================================================
describe('RC-S70.4 — filter picker (data nyata dari listInvestasi)', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it('Bagian SHU: hanya KOPERASI_LAIN berstatus AKTIF (Case 1 tampil; Case 2/3/4 tersembunyi)', async () => {
    const semua = await listInvestasi();
    const ids = saringSepertiPicker(semua, JENIS_INVESTASI_BAGIAN_SHU).map((i) => i.id);
    expect(ids).toEqual([INV.kopAktif]);
    for (const tersembunyi of [INV.usahaLain, INV.deposito, INV.kopBatal, INV.properti, INV.kopDilepas]) {
      expect(ids).not.toContain(tersembunyi);
    }
  });

  it('Imbal Hasil Tetap: matriks yang sama', async () => {
    const semua = await listInvestasi();
    const jenis = KEBIJAKAN_PENDAPATAN_INVESTASI.IMBAL_HASIL_TETAP.jenisInvestasi;
    expect(jenis).toBe('KOPERASI_LAIN');
    expect(saringSepertiPicker(semua, jenis).map((i) => i.id)).toEqual([INV.kopAktif]);
  });

  it('filter memakai field jenisInvestasi, bukan nama: USAHA_LAIN bernama "Koperasi…" tetap tersembunyi', async () => {
    const semua = await listInvestasi();
    const mirip = semua.find((i) => i.id === INV.usahaLain);
    expect(mirip?.namaTujuan).toMatch(/Koperasi/);
    expect(saringSepertiPicker(semua, 'KOPERASI_LAIN').map((i) => i.id)).not.toContain(INV.usahaLain);
  });

  it('tanpa onlyJenisInvestasi perilaku picker tidak berubah: semua investasi AKTIF (pemakai lain tidak terdampak)', async () => {
    const semua = await listInvestasi();
    const ids = saringSepertiPicker(semua).map((i) => i.id).sort();
    expect(ids).toEqual([INV.kopAktif, INV.usahaLain, INV.deposito, INV.properti].sort());
  });

  it('tidak ada KOPERASI_LAIN aktif -> daftar kosong, tidak jatuh ke jenis lain', async () => {
    await testDb.runAsync(`UPDATE investasi SET status = 'DIBATALKAN' WHERE id = ?`, INV.kopAktif);
    const semua = await listInvestasi();
    expect(saringSepertiPicker(semua, 'KOPERASI_LAIN')).toEqual([]);
  });
});

// ============================================================
describe('RC-S70.4 — Bagian SHU: validasi service (penjaga akhir)', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it('KOPERASI_LAIN aktif -> ACCEPT; akuntansi existing: Dr Piutang 1-1220 / Cr Pendapatan Hasil Investasi 4-1300, seimbang', async () => {
    const r = await catatBagianShuInvestasi(shuInput(INV.kopAktif));
    expect(await barisJurnal(r.journalId)).toEqual([
      { account_id: AKUN.piutang, debit: 4_000_000, kredit: 0 },
      { account_id: AKUN.hasilInvestasi, debit: 0, kredit: 4_000_000 },
    ]);
  });

  it('penerimaan kas: Dr Kas / Cr Piutang 1-1220 — tidak menyentuh pendapatan lagi', async () => {
    const hak = await catatBagianShuInvestasi(shuInput(INV.kopAktif));
    const terima = await catatPenerimaanBagianShu({
      bagianShuId: hak.id, tanggal: '2026-04-02', jumlah: 4_000_000, sumberDana: 'KAS', createdBy: 'user-1',
      nomorReferensi: 'TRF-01',
    });
    expect(await barisJurnal(terima.journalId)).toEqual([
      { account_id: AKUN.kas, debit: 4_000_000, kredit: 0 },
      { account_id: AKUN.piutang, debit: 0, kredit: 4_000_000 },
    ]);
    expect(terima.status).toBe('LUNAS');
    const s = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry`);
    expect(s?.d).toBe(s?.k);
  });

  it('bypass UI: investasiId jenis lain (USAHA_LAIN / DEPOSITO / PROPERTI) -> REJECT tanpa tulisan', async () => {
    const sebelum = await jumlahTulisan();
    for (const id of [INV.usahaLain, INV.deposito, INV.properti]) {
      const e = await gagal(catatBagianShuInvestasi(shuInput(id, `BA-${id}`)));
      expect(e?.message).toBe('Bagian SHU hanya dapat dicatat untuk Penyertaan pada Koperasi Lain.');
    }
    expect(await jumlahTulisan()).toEqual(sebelum);
    // Jenis investasi TIDAK diubah otomatis.
    const jenis = await testDb.getAllAsync<{ id: string; jenis_investasi: string }>(
      `SELECT id, jenis_investasi FROM investasi WHERE id IN (?,?,?) ORDER BY id`, INV.usahaLain, INV.deposito, INV.properti
    );
    expect(jenis.map((j) => j.jenis_investasi).sort()).toEqual(['DEPOSITO_BANK_UMUM', 'PROPERTI_INVESTASI', 'USAHA_LAIN']);
  });

  it('KOPERASI_LAIN tidak aktif (DIBATALKAN / DILEPAS) -> REJECT; investasi tidak ada -> REJECT', async () => {
    const sebelum = await jumlahTulisan();
    for (const id of [INV.kopBatal, INV.kopDilepas]) {
      const e = await gagal(catatBagianShuInvestasi(shuInput(id, `BA-${id}`)));
      expect(e?.message).toBe('Investasi ini sudah tidak aktif — tidak bisa dicatat bagian SHU-nya.');
    }
    const eHilang = await gagal(catatBagianShuInvestasi(shuInput('inv-tidak-ada')));
    expect(eHilang?.message).toBe('Investasi tidak ditemukan.');
    expect(await jumlahTulisan()).toEqual(sebelum);
  });

  it('tidak memposting ke 1-1800 / 4-1400 / 1-1610', async () => {
    const r = await catatBagianShuInvestasi(shuInput(INV.kopAktif));
    for (const acc of AKUN_TERLARANG) {
      expect(await n(`SELECT COUNT(*) AS n FROM journal_entry WHERE journal_id = ? AND account_id = ?`, r.journalId, acc)).toBe(0);
    }
  });

  it('identitas existing: dokumen sama untuk hak yang sama -> ditolak, tetap satu jurnal', async () => {
    await catatBagianShuInvestasi(shuInput(INV.kopAktif));
    const sebelum = await jumlahTulisan();
    const e = await gagal(catatBagianShuInvestasi(shuInput(INV.kopAktif)));
    expect(e).not.toBeNull();
    expect(await jumlahTulisan()).toEqual(sebelum);
  });

  it('periode CLOSED -> REJECT tanpa tulisan', async () => {
    await seedFixture({ periode2026: 'CLOSED' });
    const sebelum = await jumlahTulisan();
    const e = await gagal(catatBagianShuInvestasi(shuInput(INV.kopAktif)));
    expect(e?.name).toBe('ClosedPeriodError');
    expect(await jumlahTulisan()).toEqual(sebelum);
  });
});

// ============================================================
describe('RC-S70.4 — Imbal Hasil Tetap: validasi service (penjaga akhir)', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it('KOPERASI_LAIN aktif + nomor dokumen -> ACCEPT; Dr Kas / Cr 4-1700, seimbang', async () => {
    const r = await tambahPendapatanInvestasi(imbalInput(INV.kopAktif));
    expect(r.akunKode).toBe('4-1700');
    expect(await barisJurnal(r.journalId)).toEqual([
      { account_id: AKUN.kas, debit: 1_500_000, kredit: 0 },
      { account_id: AKUN.imbalTetap, debit: 0, kredit: 1_500_000 },
    ]);
    for (const acc of AKUN_TERLARANG) {
      expect(await n(`SELECT COUNT(*) AS n FROM journal_entry WHERE journal_id = ? AND account_id = ?`, r.journalId, acc)).toBe(0);
    }
  });

  it('bypass UI: jenis lain -> REJECT JENIS_INVESTASI_TIDAK_SESUAI tanpa tulisan', async () => {
    const sebelum = await jumlahTulisan();
    for (const id of [INV.usahaLain, INV.deposito, INV.properti]) {
      const e = await gagal(tambahPendapatanInvestasi(imbalInput(id, `IHT-${id}`)));
      expect(e).toBeInstanceOf(PendapatanInvestasiDitolakError);
      expect((e as PendapatanInvestasiDitolakError).kode).toBe('JENIS_INVESTASI_TIDAK_SESUAI');
    }
    expect(await jumlahTulisan()).toEqual(sebelum);
  });

  it('tidak aktif -> REJECT INVESTASI_TIDAK_AKTIF; tidak ada -> INVESTASI_TIDAK_DITEMUKAN; tanpa investasi -> INVESTASI_WAJIB', async () => {
    const sebelum = await jumlahTulisan();
    for (const id of [INV.kopBatal, INV.kopDilepas]) {
      expect(((await gagal(tambahPendapatanInvestasi(imbalInput(id, `IHT-${id}`)))) as any).kode).toBe('INVESTASI_TIDAK_AKTIF');
    }
    expect(((await gagal(tambahPendapatanInvestasi(imbalInput('inv-tidak-ada')))) as any).kode).toBe('INVESTASI_TIDAK_DITEMUKAN');
    expect(((await gagal(tambahPendapatanInvestasi(imbalInput('')))) as any).kode).toBe('INVESTASI_WAJIB');
    expect(await jumlahTulisan()).toEqual(sebelum);
  });

  it('identitas existing (jenis + investasi + nomor dokumen): duplikat ditolak, satu jurnal', async () => {
    await tambahPendapatanInvestasi(imbalInput(INV.kopAktif));
    const sebelum = await jumlahTulisan();
    expect(((await gagal(tambahPendapatanInvestasi(imbalInput(INV.kopAktif, ' iht-001 ')))) as any).kode).toBe('DUPLIKAT_DOKUMEN');
    expect(await jumlahTulisan()).toEqual(sebelum);
  });

  it('periode CLOSED -> REJECT', async () => {
    await seedFixture({ periode2026: 'CLOSED' });
    const sebelum = await jumlahTulisan();
    const e = await gagal(tambahPendapatanInvestasi(imbalInput(INV.kopAktif)));
    expect(e?.name).toBe('ClosedPeriodError');
    expect(await jumlahTulisan()).toEqual(sebelum);
  });

  it('reversal existing: jurnal REVERSED, baris asli tidak dihapus', async () => {
    const r = await tambahPendapatanInvestasi(imbalInput(INV.kopAktif));
    await koreksiTransaksiPendapatan('KAS', r.id, 'user-1', 'salah nominal');
    const j = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, r.journalId);
    expect(j?.status).toBe('REVERSED');
    expect(await n(`SELECT COUNT(*) AS n FROM kas_transaksi WHERE id = ?`, r.id)).toBe(1);
  });
});

// ============================================================
describe('RC-S70.4 — struktural: UI, rute, dan pemisahan akun', () => {
  const shuForm = tanpaKomentar(baca('src/screens/Transaksi/BagianShuFormScreen.tsx'));
  const invForm = tanpaKomentar(baca('src/screens/Transaksi/PendapatanInvestasiFormScreen.tsx'));
  const picker = tanpaKomentar(baca('src/components/InvestasiPicker.tsx'));
  const menu = tanpaKomentar(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));
  const shuSvc = tanpaKomentar(baca('src/services/BagianShuService.ts'));
  const policy = tanpaKomentar(baca('src/config/pendapatanKoperasiPolicy.ts'));

  it('Bagian SHU memakai InvestasiPicker existing dengan onlyJenisInvestasi = KOPERASI_LAIN + empty state khusus', () => {
    expect(policy).toContain("export const JENIS_INVESTASI_BAGIAN_SHU: JenisInvestasiInput = 'KOPERASI_LAIN';");
    expect(shuForm).toContain('onlyJenisInvestasi={JENIS_INVESTASI_BAGIAN_SHU}');
    expect(shuForm).toContain('emptyTitle="Belum Ada Penyertaan pada Koperasi Lain"');
    // RC-S70.5 (instruksi eksplisit pengguna): teks empty state diperbarui.
    expect(shuForm).toContain('emptyMessage="Tidak ada investasi aktif yang memenuhi syarat untuk pencatatan Bagian SHU."');
    expect(shuForm).toContain('LABEL_JENIS_INVESTASI[investasi.jenisInvestasi]');
  });

  it('Imbal Hasil Tetap: picker diikat ke jenis kebijakan (KOPERASI_LAIN) + empty state khusus + jenis ditampilkan', () => {
    expect(invForm).toContain("onlyJenisInvestasi={info.jenisInvestasi as InvestasiListItem['jenisInvestasi']}");
    expect(invForm).toContain("'Belum Ada Investasi Koperasi Lain'");
    // RC-S70.5: model belum punya eligibility formal -> teks netral, tanpa kesan fixed-return.
    expect(invForm).toContain("'Tidak ada investasi aktif yang tersedia untuk workflow ini.'");
    expect(invForm).toContain('LABEL_JENIS_INVESTASI[investasi.jenisInvestasi]');
    expect(policy).toMatch(/IMBAL_HASIL_TETAP: \{[\s\S]*?jenisInvestasi: 'KOPERASI_LAIN',[\s\S]*?akunKode: '4-1700'/);
  });

  it('picker: filter berbasis field status & jenisInvestasi — tanpa pencocokan nama, tanpa fallback "Semua Investasi"', () => {
    expect(picker).toMatch(/i\.status === 'AKTIF' &&\s*\(!onlyJenisInvestasi \|\| i\.jenisInvestasi === onlyJenisInvestasi\)/);
    expect(picker).not.toMatch(/\.includes\(\s*['"`]koperasi/i);
    expect(picker).not.toMatch(/Semua Investasi/);
    expect(picker).toContain('Tidak ada investasi aktif.'); // default pemakai lain tetap
  });

  it('service Bagian SHU menolak jenis selain KOPERASI_LAIN; akun dari mapping existing (tanpa kode literal)', () => {
    expect(shuSvc).toContain('if (investasi.jenis_investasi !== JENIS_INVESTASI_BAGIAN_SHU)');
    expect(shuSvc).toContain("resolveAccountId(db, 'BAGIAN_SHU_INVESTASI', 'DEBIT_PIUTANG')");
    expect(shuSvc).toContain("resolveAccountId(db, 'BAGIAN_SHU_INVESTASI', 'KREDIT_PENDAPATAN')");
    expect(shuSvc).not.toMatch(/1-1800|4-1400|1-1610|'RAK'|PENDAPATAN_UNIT_USAHA/);
  });

  it('menu: dua opsi di bawah "Penyertaan pada Koperasi Lain", copy final, rute benar', () => {
    const i = menu.indexOf("judul: 'Penyertaan pada Koperasi Lain'");
    expect(i).toBeGreaterThan(-1);
    const blok = menu.slice(i, menu.indexOf("judul: 'Usaha Lain'"));
    expect(blok).toContain("title: 'Bagian SHU'");
    expect(blok).toContain("sub: 'Catat hak atau penerimaan bagian SHU dari penyertaan pada koperasi lain.'");
    expect(blok).toContain("aksi: { route: 'BagianShuForm' }");
    expect(blok).toContain("title: 'Imbal Hasil Tetap'");
    // RC-S70.5: copy final Imbal Hasil Tetap.
    expect(blok).toContain("sub: 'Catat imbal hasil tetap berdasarkan ketentuan atau hak kontraktual investasi.'");
    expect(blok).toContain("aksi: { route: 'PendapatanInvestasiForm', params: { kategori: 'IMBAL_HASIL_TETAP' } }");
    expect(blok).not.toMatch(/PengembalianRAKForm|PendapatanUnitUsahaForm|Pendapatan RAKU|Pengembalian RAKU|Pendapatan Unit Usaha/);
  });
});
