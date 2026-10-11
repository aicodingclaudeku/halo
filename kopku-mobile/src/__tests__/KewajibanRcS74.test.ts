import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S74 — KEWAJIBAN UI/UX & PAYMENT SAFETY.
 *
 * Service (DB SQLite sungguhan + AccountingEngine asli):
 *   - "Kewajiban Lainnya" (listAkunKewajibanUmum) mengecualikan akun berbasis
 *     MAPPING: Simpanan Sukarela, 2-1210, 2-1300, 2-1710, Utang Bank/Pihak
 *     Lain/Usaha (tracked), Utang Bunga — dan hanya saldo > 0.
 *   - bayarKewajibanCoa menolak akun-akun tersebut dan pembayaran > saldo.
 *   - Jurnal generic tetap Dr kewajiban / Cr Kas; bayarUtang existing tidak berubah.
 * UI (dibaca dari sumber — Jest di repo ini tidak punya transformer JSX):
 *   - alur "Apa yang akan dibayar?", Utang Koperasi langsung ke UtangPicker,
 *     label, tombol, filter Daftar Utang Koperasi, tanpa menu akrual.
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
  terimaUtang,
  bayarUtang,
  akruiBungaUtang,
  listAkunKewajiban,
  listAkunKewajibanUmum,
  bayarKewajibanCoa,
  PESAN_UTANG_BUNGA_LEWAT_BAYAR_UTANG,
  PESAN_SIMPANAN_BERJANGKA_BUKAN_KEWAJIBAN_UMUM,
  PESAN_PENDAPATAN_DIMUKA_BUKAN_KEWAJIBAN_UMUM,
} from '@/services/UtangService';
import { createJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { jalankanTugasStartup, tungguTugasStartupSelesai, _resetTugasStartupUntukTest } from '@/services/StartupTasks';
import { getStatusBungaSemuaUtang, _resetGerbangAkrualUntukTest, LABEL_STATUS_BUNGA_UTANG } from '@/services/UtangBungaAccrualService';
import { tambahBulan, toPeriode } from '@/accounting/PeriodeUtil';
import {
  infoBungaUntuk,
  bungaSiapUntukBayar,
  InfoBunga,
  infoDariDetail,
  teksNilaiBunga,
  teksMemuatBunga,
  TEKS_MEMUAT_AWAL,
  TEKS_ESTIMASI_TANPA_RIWAYAT,
  TEKS_MELEWATI_ESTIMASI,
  TEKS_PENJELASAN_PROSES,
} from '@/screens/Transaksi/bayarUtangGate';
import { hitungDetikBerjalan, mulaiPenghitungDetik } from '@/hooks/useDetikMemuat';
import { useAppStore } from '@/store/useAppStore';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ACC = {
  kas: 'acc-kas',
  beban: 'acc-beban',
  bebanBunga: 'acc-beban-bunga',
  utangBank: 'acc-utang-bank',
  utangPihakLain: 'acc-utang-pihak-lain',
  utangUsaha: 'acc-utang-usaha',
  utangBunga: 'acc-utang-bunga',
  sukarela: 'acc-sukarela',
  berjangka: 'acc-2-1210',
  dimuka: 'acc-2-1300',
  bungaBerjangka: 'acc-2-1710',
  pajak: 'acc-utang-pajak',
  dana: 'acc-dana-pendidikan',
  kosong: 'acc-kewajiban-kosong',
  negatif: 'acc-kewajiban-negatif',
};

async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${tt}-${role}`, tt, role, accountId);
}
/** Pengakuan kewajiban (Dr beban / Cr kewajiban). */
async function akui(accountId: string, nominal: number, tanggal = '2026-01-10') {
  await createJournal(testDb as any, {
    tanggal, sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'Pengakuan kewajiban', createdBy: 'user-1',
    lines: [
      { accountId: ACC.beban, debit: nominal, kredit: 0 },
      { accountId, debit: 0, kredit: nominal },
    ],
  });
}
async function jumlahJurnal(): Promise<number> {
  return (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
}

beforeEach(async () => {
  _resetTugasStartupUntukTest();
  _resetGerbangAkrualUntukTest();
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.beban, '5-1000', 'Beban Umum', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.utangBank, '2-1400', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.utangPihakLain, '2-1500', 'Utang Pihak Lain', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.utangUsaha, '2-1000', 'Utang Usaha', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.sukarela, '2-1200', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.berjangka, '2-1210', 'Simpanan Anggota (Berjangka)', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.dimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.bungaBerjangka, '2-1710', 'Utang Bunga Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.pajak, '2-1650', 'Utang Pajak', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.dana, '2-1800', 'Dana Pendidikan', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.kosong, '2-1900', 'Kewajiban Tanpa Saldo', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.negatif, '2-1950', 'Kewajiban Saldo Negatif', 'LIABILITAS', 'KREDIT');

  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping('UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', ACC.utangPihakLain);
  await seedMapping('UTANG_USAHA', 'KREDIT_DEFAULT', ACC.utangUsaha);
  await seedMapping('UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping('UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);
  await seedMapping('SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);
  await seedMapping('SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', ACC.berjangka);
  await seedMapping('SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', ACC.bungaBerjangka);
  await seedMapping('PENDAPATAN_DITERIMA_DIMUKA', 'KREDIT_DEFAULT', ACC.dimuka);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`, now, now
  );

  // Kas cukup untuk seluruh skenario (penerimaan utang bank 50jt).
  await terimaUtang({ namaPemberi: 'Bank XYZ', jenisPemberi: 'BANK', pokokPinjaman: 50_000_000, persenBunga: 0, jenisBunga: 'FLAT', tanggal: '2026-01-02', sumberDana: 'KAS', createdBy: 'user-1' });
  // Setiap akun yang dikecualikan diberi saldo > 0 — pengecualian TIDAK boleh bergantung pada saldo.
  for (const id of [ACC.sukarela, ACC.berjangka, ACC.dimuka, ACC.bungaBerjangka, ACC.utangPihakLain, ACC.utangUsaha, ACC.utangBunga]) await akui(id, 1_000_000);
  await akui(ACC.pajak, 5_000_000);
  await akui(ACC.dana, 10_000_000);
  // Saldo negatif historis (koreksi langsung, bukan pembayaran normal).
  await createJournal(testDb as any, {
    tanggal: '2026-01-11', sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'Koreksi historis', createdBy: 'user-1',
    lines: [
      { accountId: ACC.negatif, debit: 400_000, kredit: 0 },
      { accountId: ACC.kas, debit: 0, kredit: 400_000 },
    ],
  });
});

afterEach(() => testDb.closeSync());

// ===========================================================================
// Kewajiban Lainnya — pengecualian berbasis mapping & filter saldo
// ===========================================================================

describe('RC-S74 — daftar Kewajiban Lainnya', () => {
  it('hanya kewajiban umum bersaldo > 0 (Utang Pajak, Dana Pendidikan)', async () => {
    const daftar = await listAkunKewajibanUmum();
    expect(daftar.map((a) => a.kode).sort()).toEqual(['2-1650', '2-1800']);
    expect(daftar.find((a) => a.kode === '2-1650')?.saldo).toBe(5_000_000);
    expect(daftar.every((a) => a.jenisPemberiTerkait === null)).toBe(true);
  });

  it('mengecualikan Simpanan Sukarela, 2-1210, 2-1300, 2-1710, Utang Bank/Pihak Lain/Usaha tracked, Utang Bunga', async () => {
    const ids = (await listAkunKewajibanUmum()).map((a) => a.accountId);
    for (const id of [ACC.sukarela, ACC.berjangka, ACC.dimuka, ACC.bungaBerjangka, ACC.utangBank, ACC.utangPihakLain, ACC.utangUsaha, ACC.utangBunga]) {
      expect(ids).not.toContain(id);
    }
  });

  it('pengecualian berbasis MAPPING, bukan kode/nama: akun berkode lain yang dipetakan ke Berjangka tetap dikecualikan', async () => {
    await seedAccount('acc-berjangka-baru', '2-1299', 'Nama Bebas', 'LIABILITAS', 'KREDIT');
    await testDb.runAsync(`UPDATE account_mapping SET account_id = 'acc-berjangka-baru' WHERE transaction_type = 'SIMPANAN_BERJANGKA'`);
    await akui('acc-berjangka-baru', 2_000_000);
    const ids = (await listAkunKewajibanUmum()).map((a) => a.accountId);
    expect(ids).not.toContain('acc-berjangka-baru');
    await expect(bayarKewajibanCoa({ accountId: 'acc-berjangka-baru', tanggal: '2026-02-01', nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1' }))
      .rejects.toThrow(PESAN_SIMPANAN_BERJANGKA_BUKAN_KEWAJIBAN_UMUM);
  });

  it('saldo 0 dan saldo negatif tidak ditawarkan — tetapi TIDAK dihapus dan saldonya tidak diubah', async () => {
    const umum = (await listAkunKewajibanUmum()).map((a) => a.accountId);
    expect(umum).not.toContain(ACC.kosong);
    expect(umum).not.toContain(ACC.negatif);
    const semua = await listAkunKewajiban();
    expect(semua.find((a) => a.accountId === ACC.kosong)?.saldo).toBe(0);
    expect(semua.find((a) => a.accountId === ACC.negatif)?.saldo).toBe(-400_000);
  });
});

// ===========================================================================
// bayarKewajibanCoa — pengecualian di service & validasi overpayment
// ===========================================================================

describe('RC-S74 — bayarKewajibanCoa: akun yang dilindungi', () => {
  const bayar = (accountId: string) => bayarKewajibanCoa({ accountId, tanggal: '2026-02-01', nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1' });

  it.each([
    ['Simpanan Sukarela', ACC.sukarela, /Simpanan Sukarela memiliki alur transaksi tersendiri/],
    ['2-1210 Simpanan Berjangka', ACC.berjangka, PESAN_SIMPANAN_BERJANGKA_BUKAN_KEWAJIBAN_UMUM],
    ['2-1710 Bunga Simpanan Berjangka', ACC.bungaBerjangka, PESAN_SIMPANAN_BERJANGKA_BUKAN_KEWAJIBAN_UMUM],
    ['2-1300 Pendapatan Diterima Dimuka', ACC.dimuka, PESAN_PENDAPATAN_DIMUKA_BUKAN_KEWAJIBAN_UMUM],
    ['Utang Bank (tracked)', ACC.utangBank, /dikelola lewat pencatatan Utang Koperasi/],
    ['Utang Pihak Lain (tracked)', ACC.utangPihakLain, /dikelola lewat pencatatan Utang Koperasi/],
    ['Utang Usaha (tracked)', ACC.utangUsaha, /dikelola lewat pencatatan Utang Koperasi/],
    ['Utang Bunga', ACC.utangBunga, PESAN_UTANG_BUNGA_LEWAT_BAYAR_UTANG],
  ])('%s -> DITOLAK walau saldonya > 0, tanpa jurnal', async (_n, id, pesan) => {
    const sebelum = await jumlahJurnal();
    await expect(bayar(id)).rejects.toThrow(pesan as any);
    expect(await jumlahJurnal()).toBe(sebelum);
  });
});

describe('RC-S74 — validasi overpayment kewajiban umum (saldo 10jt)', () => {
  const bayar = (nominal: number, accountId = ACC.dana) => bayarKewajibanCoa({ accountId, tanggal: '2026-02-01', nominal, sumberDana: 'KAS', createdBy: 'user-1' });

  it('bayar 3jt -> PASS (sebagian), sisa 7jt', async () => {
    await bayar(3_000_000);
    expect(await getAccountBalance(testDb as any, ACC.dana)).toBe(7_000_000);
  });

  it('bayar 10jt -> PASS (lunas), sisa 0', async () => {
    await bayar(10_000_000);
    expect(await getAccountBalance(testDb as any, ACC.dana)).toBe(0);
  });

  it('bayar 11jt -> DITOLAK dengan pesan & saldo tersedia; tanpa jurnal; saldo tidak berubah', async () => {
    const sebelum = await jumlahJurnal();
    await expect(bayar(11_000_000)).rejects.toThrow('Pembayaran melebihi saldo kewajiban.\nSaldo yang tersedia: Rp10.000.000.');
    expect(await jumlahJurnal()).toBe(sebelum);
    expect(await getAccountBalance(testDb as any, ACC.dana)).toBe(10_000_000);
  });

  it('pembayaran bertahap tidak dapat melewati saldo: 6jt lalu 5jt -> yang kedua DITOLAK', async () => {
    await bayar(6_000_000);
    await expect(bayar(5_000_000)).rejects.toThrow(/Saldo yang tersedia: Rp4\.000\.000/);
    expect(await getAccountBalance(testDb as any, ACC.dana)).toBe(4_000_000);
  });

  it('saldo 0 -> DITOLAK', async () => {
    await expect(bayar(1, ACC.kosong)).rejects.toThrow(/Pembayaran melebihi saldo kewajiban\.\nSaldo yang tersedia: Rp0\./);
    expect(await getAccountBalance(testDb as any, ACC.kosong)).toBe(0);
  });

  it('saldo negatif -> DITOLAK dan tidak menjadi lebih negatif', async () => {
    await expect(bayar(100_000, ACC.negatif)).rejects.toThrow(/Pembayaran melebihi saldo kewajiban/);
    expect(await getAccountBalance(testDb as any, ACC.negatif)).toBe(-400_000);
  });

  it('nominal 0 -> DITOLAK', async () => {
    await expect(bayar(0)).rejects.toThrow(/harus lebih dari 0/);
  });
});

describe('RC-S74 — jurnal pembayaran kewajiban umum tidak berubah', () => {
  it('bayar 3jt -> tepat Dr kewajiban 3jt / Cr Kas 3jt, seimbang', async () => {
    const { journalId } = await bayarKewajibanCoa({ accountId: ACC.dana, tanggal: '2026-02-01', nominal: 3_000_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, journalId
    );
    expect(baris).toEqual([
      { account_id: ACC.dana, debit: 3_000_000, kredit: 0 },
      { account_id: ACC.kas, debit: 0, kredit: 3_000_000 },
    ]);
  });
});

// ===========================================================================
// bayarUtang existing — tidak berubah
// ===========================================================================

describe('RC-S74 — bayarUtang existing tetap', () => {
  async function utangBerbunga(): Promise<string> {
    const r = await terimaUtang({ namaPemberi: 'Bank ABC', jenisPemberi: 'BANK', pokokPinjaman: 12_000_000, persenBunga: 12, basisBunga: 'TAHUNAN', jenisBunga: 'FLAT', tanggal: '2026-01-01', sumberDana: 'KAS', createdBy: 'user-1' });
    return r.id;
  }

  it('pokok melebihi sisa pokok -> DITOLAK', async () => {
    const id = await utangBerbunga();
    await expect(bayarUtang({ utangId: id, tanggal: '2026-02-05', pokok: 12_000_001, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' })).rejects.toThrow(/melebihi sisa pokok/);
  });

  it('bunga tetap dibagi: yang sudah diakru -> Dr Utang Bunga, sisanya -> Dr Beban Bunga', async () => {
    const id = await utangBerbunga();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-01-31', nominal: 120_000, createdBy: 'user-1' });
    const r = await bayarUtang({ utangId: id, tanggal: '2026-02-05', pokok: 0, bunga: 200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const jid = (await testDb.getFirstAsync<{ journal_id: string }>(`SELECT journal_id FROM utang_pembayaran WHERE utang_id = ?`, id))!.journal_id;
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY account_id`, jid
    );
    expect(r).toBeTruthy();
    expect(baris.find((b) => b.account_id === ACC.utangBunga)?.debit).toBe(120_000);
    expect(baris.find((b) => b.account_id === ACC.bebanBunga)?.debit).toBe(80_000);
    expect(baris.find((b) => b.account_id === ACC.kas)?.kredit).toBe(200_000);
  });

  it('utang usaha tidak dapat diberi bunga', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga, jenis_bunga, tanggal, sumber_dana, sumber, status, created_by, created_at, updated_at)
       VALUES ('utg-usaha','UTG-US','Pemasok','UTANG_USAHA',1000000,0,'FLAT','2026-01-01','KAS','LANGSUNG','AKTIF','user-1',?,?)`, now, now
    );
    await expect(bayarUtang({ utangId: 'utg-usaha', tanggal: '2026-02-05', pokok: 100_000, bunga: 10_000, sumberDana: 'KAS', createdBy: 'user-1' })).rejects.toThrow(/tidak memiliki komponen bunga/);
  });

  it('saldo rekening sumber tetap diverifikasi', async () => {
    const id = await utangBerbunga();
    const kas = await getAccountBalance(testDb as any, ACC.kas);
    await expect(bayarUtang({ utangId: id, tanggal: '2026-02-05', pokok: 0, bunga: kas + 1, sumberDana: 'KAS', createdBy: 'user-1' })).rejects.toThrow();
  });
});

// ===========================================================================
// UI — alur & label (dibaca dari sumber)
// ===========================================================================

describe('RC-S74 — alur Bayar Kewajiban (UI)', () => {
  const layar = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));

  it('dimulai dari "Apa yang akan dibayar?" dengan dua kartu dan ikonnya', () => {
    expect(layar).toContain('Apa yang akan dibayar?');
    expect(layar).toMatch(/icon="card-outline"\s+title="Utang Koperasi"\s+sub="Bank, pihak lain, atau utang usaha"/);
    expect(layar).toMatch(/icon="document-text-outline"\s+title="Kewajiban Lainnya"\s+sub="Pajak, dana, dan kewajiban lain yang tercatat"/);
    expect(layar).not.toMatch(/Akun Liabilitas/);
  });

  it('Utang Koperasi -> LANGSUNG ke UtangPicker (tanpa memilih akun COA / filter jenis akun)', () => {
    const blokUtang = layar.slice(layar.indexOf("{jenis === 'UTANG' && ("), layar.indexOf("{jenis === 'LAINNYA' && ("));
    expect(blokUtang).toMatch(/<UtangPicker value=\{utang\} onChange=\{setUtang\} \/>/);
    expect(blokUtang).not.toContain('KewajibanAkunPicker');
    for (const f of ['Pemberi', 'Jenis', 'Nomor Utang', 'Sisa Pokok', 'Utang Bunga', 'Jumlah Pokok', 'Jumlah Bunga']) expect(blokUtang).toContain(f);
    expect(layar).toMatch(/await bayarUtang\(/);
  });

  it('Kewajiban Lainnya -> KewajibanAkunPicker lalu bayarKewajibanCoa', () => {
    const blokLain = layar.slice(layar.indexOf("{jenis === 'LAINNYA' && ("));
    expect(blokLain).toContain('<KewajibanAkunPicker value={akun} onChange={setAkun} />');
    expect(layar).toMatch(/await bayarKewajibanCoa\(/);
  });

  it('ringkasan sebelum simpan (dua versi) dan label tombol sesuai jenis', () => {
    for (const t of ['Pembayaran Kewajiban', 'Yang dibayar', 'Saldo sebelum', 'Dibayar', 'Sisa', 'Sumber dana', 'Pembayaran Utang', 'Pokok dibayar', 'Bunga dibayar']) {
      expect(layar).toContain(t);
    }
    // DIPERBARUI RC-S74 final hardening: label utang kini dapat berupa "Menunggu
    // perhitungan bunga…" saat memuat; maksud tetap — Utang -> "Bayar Utang", lainnya -> "Bayar Kewajiban".
    expect(layar).toMatch(/jenis === 'UTANG'\s*\?\s*bungaTampil\?\.tahap === 'MEMUAT'\s*\?\s*'Menunggu perhitungan bunga…'\s*:\s*'Bayar Utang'\s*:\s*'Bayar Kewajiban'/);
  });

  it('tombol dinonaktifkan bila belum lengkap/tidak valid/saldo kurang/sedang menyimpan', () => {
    expect(layar).toMatch(/disabled=\{!siap \|\| submitting\}/);
    expect(layar).toMatch(/const siap = lengkap && pesan\.length === 0;/);
    expect(layar).toMatch(/nominalNum > akun\.saldo/);
    expect(layar).toMatch(/totalBayar > rekening\.saldo/);
  });

  it('istilah internal tidak pernah ditampilkan ke pengguna', () => {
    expect(layar).toMatch(/POLA_PESAN_INTERNAL/);
    const tampil = layar.replace(/const POLA_PESAN_INTERNAL = .*$/m, '');
    for (const k of ['KREDIT_DEFAULT', 'KREDIT_AKRUAL', 'transaction_type', 'jenisPemberiTerkait']) expect(tampil).not.toContain(k);
  });

  it('judul & menu: "Bayar Kewajiban" dengan subjudul', () => {
    expect(layar).toContain("title: 'Bayar Kewajiban'");
    const menu = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
    expect(menu).toContain("title: 'Bayar Kewajiban'");
    expect(menu).toContain("sub: 'Bayar utang dan kewajiban yang sudah tercatat.'");
    expect(menu).not.toContain("title: 'Kewajiban Koperasi'");
  });
});

describe('RC-S74 — KewajibanAkunPicker', () => {
  const picker = tanpaKomentar(baca('src/components/KewajibanAkunPicker.tsx'));
  it('memakai daftar kewajiban umum (mapping-based, saldo > 0)', () => {
    expect(picker).toMatch(/listAkunKewajibanUmum\(\)/);
  });
  it('"Total Akun Terpilih" dihapus; saldo tetap per baris', () => {
    expect(picker).not.toContain('Total Akun Terpilih');
    expect(picker).toContain('Kewajiban umum');
    expect(picker).toMatch(/Saldo: <Text style=\{styles\.rowSaldo\}>\{formatRupiah\(item\.saldo\)\}<\/Text>/);
  });
});

describe('RC-S74 — Daftar Utang Koperasi', () => {
  const layar = tanpaKomentar(baca('src/screens/Akuntansi/DaftarUtangScreen.tsx'));
  it('judul & ringkasan jujur (bukan total seluruh liabilitas)', () => {
    expect(layar).toContain("title: 'Daftar Utang Koperasi'");
    expect(layar).toContain('Total Sisa Utang Koperasi');
    expect(layar).toContain('Utang bank, pihak lain, dan utang usaha yang masih tercatat');
    expect(layar).not.toContain('Total Sisa Kewajiban (Aktif)');
  });
  it('filter status & jenis hanya memengaruhi tampilan', () => {
    for (const l of ["label: 'Semua'", "label: 'Aktif'", "label: 'Lunas'", "label: 'Bank'", "label: 'Pihak Lain'", "label: 'Utang Usaha'"]) expect(layar).toContain(l);
    expect(layar).toMatch(/filterStatus !== 'SEMUA' && d\.status !== filterStatus/);
    expect(layar).toMatch(/filterJenis !== 'SEMUA' && d\.jenisPemberi !== filterJenis/);
  });
  it('tetap read-only: tanpa transaksi, tanpa menu/tombol akrual; status bunga tetap', () => {
    expect(layar).not.toMatch(/bayarUtang|bayarKewajibanCoa|createJournal|akruiBungaUtang/);
    expect(layar).not.toMatch(/Akrual Bunga Utang|Akrual Sekarang/);
    expect(layar).toContain('LABEL_STATUS_BUNGA_UTANG[detail.status]');
    expect(layar).toContain('lengkapiBasisBungaUtang');
  });
});

// ===========================================================================
// RC-S74 (update) — "Utang Bunga" tidak pernah tampil Rp0 sementara
// ===========================================================================

describe('RC-S74 (update) — gate tugas startup sebelum membaca utang bunga', () => {
  it('perilaku: saat catch-up startup berjalan, pembacaan SETELAH gate = nilai final (3 × 1.200.000)', async () => {
    const tanggal = `${tambahBulan(toPeriode(getTanggalLokalHariIni()), -3)}-01`;
    const { id } = await terimaUtang({ namaPemberi: 'Bank Catch-up', jenisPemberi: 'BANK', pokokPinjaman: 120_000_000, persenBunga: 12, basisBunga: 'TAHUNAN', jenisBunga: 'FLAT', tanggal, sumberDana: 'KAS', createdBy: 'user-1' });
    let selesai = false;
    const tugas = jalankanTugasStartup('user-1'); // pekerjaan latar yang SUDAH berjalan (tidak di-await)
    tugas.then(() => { selesai = true; });
    // Urutan yang dipakai layar: tunggu gate, baru baca monitor.
    await tungguTugasStartupSelesai();
    expect(selesai).toBe(true); // gate benar-benar menunggu penyelesaian nyata
    const detail = (await getStatusBungaSemuaUtang()).get(id);
    expect(detail?.outstandingBunga).toBe(3_600_000);
  });

  it('gate tanpa pekerjaan berjalan langsung lolos (tidak menambah tunda)', async () => {
    await expect(tungguTugasStartupSelesai()).resolves.toBeUndefined();
  });

  const layar = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));

  it('layar menunggu `tungguTugasStartupSelesai()` SEBELUM `getStatusBungaSemuaUtang()`', () => {
    // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): impor yang sama kini juga membawa `getStatusTugasStartup` (metadata tampilan).
    expect(layar).toContain("import { tungguTugasStartupSelesai, getStatusTugasStartup } from '@/services/StartupTasks';");
    const iGate = layar.indexOf('await tungguTugasStartupSelesai();');
    const iBaca = layar.indexOf('await getStatusBungaSemuaUtang()');
    expect(iGate).toBeGreaterThan(0);
    expect(iBaca).toBeGreaterThan(iGate);
  });

  it('tidak ada Rp0 sementara: tanpa fallback `?? 0`; ada tahap memuat / tidak tersedia / tidak berbunga', () => {
    expect(layar).not.toMatch(/outstandingBunga \?\? 0/);
    // DIPERBARUI RC-S74 FINAL INTEREST CALCULATION LOADING UX (§3): teks loading kini
    // bertahap dari helper murni `teksMemuatBunga` ("Menghitung bunga otomatis…" dst.),
    // bukan literal "Menghitung bunga terbaru…". Maksud tetap: ada tahap memuat eksplisit.
    // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): helper kini menerima potret proses latar + waktu berjalan (ms).
    expect(layar).toContain('const memuat = teksMemuatBunga(prosesBunga, detikMemuat * 1000);');
    expect(layar).toContain('{memuat.judul}');
    // DIPERBARUI RC-S74 FINAL (interest status hardening): teks nilai kini dari satu fungsi
    // murni `teksNilaiBunga` (TIDAK_TERSEDIA/null -> "—", 0% -> "Tidak berbunga", SIAP -> RpX).
    expect(layar).toContain('<Baris label="Utang Bunga" nilai={teksNilaiBunga(bungaTampil)} />');
    expect(layar).not.toMatch(/formatRupiah\(bungaTampil\.nilai\)|formatRupiah\(infoBunga/);
  });

  it('tombol Bayar Utang menunggu perhitungan bunga selesai', () => {
    // DIPERBARUI RC-S74 final hardening: ekspresi lama `infoBunga?.tahap !== 'MEMUAT'`
    // terlalu longgar (null / TIDAK_TERSEDIA / info basi lolos) — diganti helper murni.
    expect(layar).toContain('const bungaSiap = bungaSiapUntukBayar(utang, infoBunga);');
    expect(layar).not.toMatch(/infoBunga\?\.tahap !== 'MEMUAT'/);
    expect(layar).toMatch(/jenis === 'UTANG' && !!utang && totalBayar > 0 && bungaSiap/);
  });

  it('layar TIDAK menjalankan mesin/tugas startup dan tanpa polling/timer', () => {
    expect(layar).not.toMatch(/jalankanTugasStartup|jalankanAkrualBungaUtangJikaPerlu|prosesAkrualBungaUtangOtomatis|akruiBungaUtang/);
    expect(layar).not.toMatch(/setInterval|setTimeout/);
  });

  it('Daftar Utang Koperasi tetap memakai gate yang sama sebelum membaca status bunga', () => {
    const daftar = tanpaKomentar(baca('src/screens/Akuntansi/DaftarUtangScreen.tsx'));
    const iGate = daftar.indexOf('await tungguTugasStartupSelesai();');
    expect(iGate).toBeGreaterThan(0);
    expect(daftar.indexOf('await getStatusBungaSemuaUtang()')).toBeGreaterThan(iGate);
  });
});

// ===========================================================================
// RC-S74 final hardening — tabel kebenaran gerbang bunga (perilaku, helper murni)
// ===========================================================================

describe('RC-S74 final hardening — tombol terkunci bila info bunga belum final', () => {
  const A = { id: 'utg-A', jenisPemberi: 'BANK', persenBunga: 12 };
  const B = { id: 'utg-B', jenisPemberi: 'PIHAK_LAIN', persenBunga: 12 };
  const usaha = { id: 'utg-U', jenisPemberi: 'UTANG_USAHA', persenBunga: 0 };
  const nol = { id: 'utg-0', jenisPemberi: 'BANK', persenBunga: 0 };
  // DIPERBARUI RC-S74 FINAL: SIAP kini membawa status accounting (statusBunga) terpisah dari readiness.
  const siap = (utangId: string, nilai: number): InfoBunga => ({ utangId, tahap: 'SIAP', nilai, statusBunga: 'TERKENDALI', pesanBunga: null });

  it.each<[string, typeof A | null, InfoBunga | null, boolean]>([
    ['belum ada utang', null, null, false],
    ['info bunga belum ada (render pertama setelah memilih)', A, null, false],
    ['MEMUAT', A, { utangId: A.id, tahap: 'MEMUAT' }, false],
    ['TIDAK_TERSEDIA', A, { utangId: A.id, tahap: 'TIDAK_TERSEDIA' }, false],
    ['info BASI milik utang lain (A SIAP, terpilih B)', B, siap(A.id, 3_600_000), false],
    ['SIAP (nilai > 0)', A, siap(A.id, 3_600_000), true],
    ['SIAP (nilai benar-benar 0)', A, siap(A.id, 0), true],
    ['kontrak 0% (tidak berbunga)', nol, null, true],
    ['utang usaha (tanpa komponen bunga)', usaha, null, true],
  ])('%s -> tombol %s', (_n, utang, info, harap) => {
    expect(bungaSiapUntukBayar(utang, info)).toBe(harap);
  });

  // DIPERBARUI RC-S74 FINAL (§10/§17): null/basi kini "belum ada" -> "—" (dulu ditampilkan memuat).
  it('info basi / belum ada TIDAK pernah ditampilkan sebagai nilai — tampil "—"', () => {
    expect(infoBungaUntuk(B, siap(A.id, 3_600_000))).toEqual({ utangId: B.id, tahap: 'BELUM_ADA' });
    expect(infoBungaUntuk(A, null)).toEqual({ utangId: A.id, tahap: 'BELUM_ADA' });
    expect(teksNilaiBunga(infoBungaUntuk(A, null)!)).toBe('—');
  });

  it('"Rp0" hanya dapat berasal dari tahap SIAP untuk utang yang SAMA', () => {
    const semuaInfo: (InfoBunga | null)[] = [null, { utangId: A.id, tahap: 'MEMUAT' }, { utangId: A.id, tahap: 'TIDAK_TERSEDIA' }, siap(A.id, 0), siap(B.id, 0)];
    for (const utang of [A, B, nol, usaha]) {
      for (const info of semuaInfo) {
        const tampil = infoBungaUntuk(utang, info);
        if (tampil?.tahap === 'SIAP') {
          expect(info).toEqual(tampil); // nilai ditampilkan persis dari hasil SIAP
          expect(tampil.utangId).toBe(utang.id); // tidak pernah milik utang lain
        }
      }
    }
    expect(infoBungaUntuk(nol, siap(nol.id, 0))).toEqual({ utangId: nol.id, tahap: 'TIDAK_BERBUNGA' });
    expect(infoBungaUntuk(usaha, null)).toBeNull();
  });

  const layar = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));

  it('layar memakai satu sumber (helper) untuk tampilan & tombol; tanpa akses tahap langsung', () => {
    expect(layar).toContain('const bungaTampil = infoBungaUntuk(utang, infoBunga);');
    expect(layar).not.toMatch(/infoBunga\?\.tahap|infoBunga\.tahap/);
    expect(layar).toMatch(/setInfoBunga\(\{ utangId, tahap: 'MEMUAT' \}\)/);
  });

  it('TIDAK_TERSEDIA: pesan jelas + "Coba lagi" manual (bukan polling/timer)', () => {
    expect(layar).toContain('Pembayaran utang ini dinonaktifkan sampai informasi bunga berhasil dimuat.');
    expect(layar).toContain('onPress={() => setMuatUlangBunga((n) => n + 1)}');
    expect(layar).toMatch(/\}, \[utang\?\.id, muatUlangBunga\]\);/);
    expect(layar).not.toMatch(/setInterval|setTimeout/);
  });

  it('label tombol menjelaskan penguncian saat memuat', () => {
    expect(layar).toContain("'Menunggu perhitungan bunga…'");
  });
});

// ===========================================================================
// RC-S74 FINAL INTEREST STATUS HARDENING — readiness ≠ accounting status (§20)
// ===========================================================================

describe('RC-S74 FINAL — readiness (MEMUAT/SIAP/TIDAK_TERSEDIA) terpisah dari status accounting', () => {
  const A = { id: 'utg-A', jenisPemberi: 'BANK', persenBunga: 12 };
  const B = { id: 'utg-B', jenisPemberi: 'BANK', persenBunga: 12 };
  const detail = (status: any, outstandingBunga: number, pesan: string | null = null) => ({ status, outstandingBunga, pesan });
  const dari = (status: string, nilai: number, pesan: string | null = null) => infoDariDetail(A.id, detail(status, nilai, pesan));

  it.each([
    ['TEST 1 TERKENDALI', 'TERKENDALI', 3_600_000],
    ['TEST 2 MENUNGGU_PERIODE', 'MENUNGGU_PERIODE', 1_200_000],
    ['TEST 3 KONTRAK_BELUM_LENGKAP + 0', 'KONTRAK_BELUM_LENGKAP', 0],
    ['TEST 4 KONTRAK_BELUM_LENGKAP + outstanding', 'KONTRAK_BELUM_LENGKAP', 500_000],
    ['TEST 5 PERLU_PERHATIAN + outstanding', 'PERLU_PERHATIAN', 500_000],
  ])('%s -> tahap SIAP, statusBunga tetap, nilai apa adanya', (_n, status, nilai) => {
    expect(dari(status, nilai)).toEqual({ utangId: A.id, tahap: 'SIAP', nilai, statusBunga: status, pesanBunga: null });
  });

  it('status accounting tidak pernah menjadi tahap, dan pesan resmi service dibawa apa adanya', () => {
    const i = dari('KONTRAK_BELUM_LENGKAP', 0, 'Kontrak bunga belum lengkap. Lengkapi basis bunga untuk mengaktifkan perhitungan otomatis.');
    expect(i.tahap).toBe('SIAP');
    expect(i.tahap === 'SIAP' && i.statusBunga).toBe('KONTRAK_BELUM_LENGKAP');
    expect(i.tahap === 'SIAP' && i.pesanBunga).toBe('Kontrak bunga belum lengkap. Lengkapi basis bunga untuk mengaktifkan perhitungan otomatis.');
  });

  it('TEST 6 MEMUAT -> tombol terkunci, tampil memuat (bukan Rp0)', () => {
    const info: InfoBunga = { utangId: A.id, tahap: 'MEMUAT' };
    expect(bungaSiapUntukBayar(A, info)).toBe(false);
    // DIPERBARUI RC-S74 FINAL INTEREST CALCULATION LOADING UX (§3), lalu RC-S74 FINAL UTANG BUNGA
    // LOADING UX (§2/§7): teks memuat mengikuti spesifikasi terbaru ("Menghitung otomatis…").
    expect(teksNilaiBunga(infoBungaUntuk(A, info)!)).toBe('Menghitung otomatis…');
  });

  it('TEST 7 TIDAK_TERSEDIA -> tombol terkunci, nilai "—"', () => {
    const info = infoDariDetail(A.id, undefined);
    expect(info.tahap).toBe('TIDAK_TERSEDIA');
    expect(bungaSiapUntukBayar(A, info)).toBe(false);
    expect(teksNilaiBunga(infoBungaUntuk(A, info)!)).toBe('—');
  });

  it('TEST 8 null / undefined -> tombol terkunci, tidak dianggap bunga nol', () => {
    for (const info of [null, undefined]) {
      expect(bungaSiapUntukBayar(A, info)).toBe(false);
      expect(teksNilaiBunga(infoBungaUntuk(A, info)!)).toBe('—');
      expect(teksNilaiBunga(infoBungaUntuk(A, info)!)).not.toMatch(/Rp/);
    }
  });

  it('TEST 9 SIAP + 0 -> "Rp0" (nilai final yang sah, bukan error)', () => {
    const t = infoBungaUntuk(A, dari('TERKENDALI', 0))!;
    expect(teksNilaiBunga(t)).toBe('Rp0');
    expect(bungaSiapUntukBayar(A, dari('TERKENDALI', 0))).toBe(true);
  });

  it('TEST 10 MENUNGGU_PERIODE + outstanding > 0 -> pembayaran TIDAK diblokir karena status', () => {
    expect(bungaSiapUntukBayar(A, dari('MENUNGGU_PERIODE', 1_200_000))).toBe(true);
  });

  it.each([
    ['TEST 11 PERLU_PERHATIAN', 'PERLU_PERHATIAN'],
    ['TEST 12 KONTRAK_BELUM_LENGKAP', 'KONTRAK_BELUM_LENGKAP'],
  ])('%s + outstanding > 0 -> outstanding tetap tampil & tombol tidak diblokir', (_n, status) => {
    const info = dari(status, 500_000);
    expect(teksNilaiBunga(infoBungaUntuk(A, info)!)).toBe('Rp500.000');
    expect(bungaSiapUntukBayar(A, info)).toBe(true);
  });

  it('matriks: SIAP dengan status accounting APA PUN -> validasi normal; readiness lain -> terkunci', () => {
    for (const st of ['TERKENDALI', 'MENUNGGU_PERIODE', 'KONTRAK_BELUM_LENGKAP', 'PERLU_PERHATIAN']) expect(bungaSiapUntukBayar(A, dari(st, 100))).toBe(true);
    expect(bungaSiapUntukBayar({ ...A, persenBunga: 0 }, null)).toBe(true); // tidak berbunga
    expect(bungaSiapUntukBayar({ id: 'u', jenisPemberi: 'UTANG_USAHA', persenBunga: 0 }, null)).toBe(true);
  });

  it('TEST 13 race: A dipilih, lalu B; hasil A datang terlambat -> state/tampilan tetap B', () => {
    const hasilATerlambat = infoDariDetail(A.id, detail('TERKENDALI', 3_600_000));
    const tampilB = infoBungaUntuk(B, hasilATerlambat);
    expect(tampilB).toEqual({ utangId: B.id, tahap: 'BELUM_ADA' });
    expect(bungaSiapUntukBayar(B, hasilATerlambat)).toBe(false);
    const layar = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));
    expect(layar).toMatch(/if \(!aktif\) return;\s*setInfoBunga\(infoDariDetail\(utangId, detail, akrualGagal\)\);/); // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): arg ke-3 = kegagalan mesin (§13)
    expect(layar).toMatch(/return \(\) => \{\s*aktif = false;\s*\};/);
  });

  const layar = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));

  it('TEST 14 layar tidak memanggil mesin akrual / tugas startup', () => {
    expect(layar).not.toMatch(/jalankanAkrualBungaUtangJikaPerlu|jalankanTugasStartup|prosesAkrualBungaUtangOtomatis/);
  });

  it('TEST 15 layar menunggu tungguTugasStartupSelesai() sebelum getStatusBungaSemuaUtang()', () => {
    const iGate = layar.indexOf('await tungguTugasStartupSelesai();');
    expect(iGate).toBeGreaterThan(0);
    expect(layar.indexOf('await getStatusBungaSemuaUtang()')).toBeGreaterThan(iGate);
  });

  it('layar tidak mereduksi status: tidak ada `detail ? { ... tahap: \'SIAP\'` manual; status tampil dengan label resmi', () => {
    expect(layar).not.toMatch(/tahap: 'SIAP'/);
    // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): argumen ketiga = kegagalan mesin akrual (§13); maksud test tetap.
    expect(layar).toContain('setInfoBunga(infoDariDetail(utangId, detail, akrualGagal));');
    expect(layar).toContain('LABEL_STATUS_BUNGA_UTANG[bungaTampil.statusBunga]');
    expect(layar).toContain('bungaTampil.pesanBunga');
  });

  it('tidak ada perhitungan bunga di UI maupun helper; tanpa fallback nol', () => {
    const helper = tanpaKomentar(baca('src/screens/Transaksi/bayarUtangGate.ts'));
    for (const src of [layar, helper]) {
      expect(src).not.toMatch(/persenBunga\s*\*|\/\s*12\b|\/\s*365|pokokPinjaman\s*\*/);
      expect(src).not.toMatch(/\?\?\s*0\b|\|\|\s*0\b|Number\([^)]*\)\s*\|\|/);
    }
    // Helper hanya boleh mengimpor TIPE dari service (tanpa I/O runtime).
    expect(helper).toMatch(/^import type \{[^}]*\} from '@\/services\/UtangBungaAccrualService';$/m);
    expect(helper).not.toMatch(/^import \{[^}]*\} from '@\/services\//m);
  });
});

// ===========================================================================
// RC-S74 — FINAL INTEREST CALCULATION LOADING UX (§13 TEST 1–8)
// ===========================================================================

/**
 * Harness hook minimal (tanpa renderer RN — Jest repo ini tidak punya transformer JSX).
 * Meniru semantik React yang dipakai `useDetikMemuat`: useState (bailout bila nilai sama)
 * dan useLayoutEffect (jalan setelah render bila deps berubah; cleanup sebelum efek
 * berikutnya & saat unmount). Dimuat lewat `jest.isolateModules` + `jest.doMock('react')`
 * supaya tidak memengaruhi test lain di berkas ini.
 */
function renderHookDetik(awal: { aktif: boolean; kunci: string }) {
  const st = {
    states: [] as unknown[],
    effects: [] as ({ deps: unknown[]; cleanup?: () => void } | undefined)[],
    si: 0,
    ei: 0,
    pending: [] as (() => void)[],
    sibuk: false,
    kotor: false,
    terpasang: true,
  };
  let props = awal;
  let hasil = -1;
  let jumlahRender = 0;
  const render = () => {
    if (!st.terpasang) return;
    if (st.sibuk) {
      st.kotor = true;
      return;
    }
    st.sibuk = true;
    do {
      st.kotor = false;
      st.si = 0;
      st.ei = 0;
      jumlahRender++;
      hasil = useDetikMemuat(props.aktif, props.kunci);
      for (const f of st.pending.splice(0)) f();
    } while (st.kotor);
    st.sibuk = false;
  };
  const reactPalsu = {
    useState(init: unknown) {
      const i = st.si++;
      if (!(i in st.states)) st.states[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        const n = typeof v === 'function' ? (v as (x: unknown) => unknown)(st.states[i]) : v;
        if (Object.is(n, st.states[i])) return;
        st.states[i] = n;
        render();
      };
      return [st.states[i], set];
    },
    useLayoutEffect(fn: () => void | (() => void), deps: unknown[]) {
      const i = st.ei++;
      const prev = st.effects[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        st.pending.push(() => {
          prev?.cleanup?.();
          const c = fn();
          st.effects[i] = { deps, cleanup: typeof c === 'function' ? c : undefined };
        });
      }
    },
  };
  let useDetikMemuat!: (aktif: boolean, kunci: string) => number;
  jest.isolateModules(() => {
    jest.doMock('react', () => reactPalsu);
    useDetikMemuat = require('@/hooks/useDetikMemuat').useDetikMemuat;
  });
  render();
  return {
    get detik() {
      return hasil;
    },
    get jumlahRender() {
      return jumlahRender;
    },
    rerender(p: { aktif: boolean; kunci: string }) {
      props = p;
      render();
    },
    unmount() {
      for (const e of st.effects) e?.cleanup?.();
      st.effects = [];
      st.terpasang = false;
    },
  };
}

describe('RC-S74 FINAL INTEREST CALCULATION LOADING UX', () => {
  const A = { id: 'utg-A', jenisPemberi: 'BANK', persenBunga: 12 };
  const B = { id: 'utg-B', jenisPemberi: 'BANK', persenBunga: 12 };
  const siap = (utangId: string, nilai: number): InfoBunga => ({ utangId, tahap: 'SIAP', nilai, statusBunga: 'TERKENDALI', pesanBunga: null });
  const layar = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));
  const hook = tanpaKomentar(baca('src/hooks/useDetikMemuat.ts'));
  const helper = tanpaKomentar(baca('src/screens/Transaksi/bayarUtangGate.ts'));
  const blokMemuat = layar.slice(layar.indexOf("{bungaTampil?.tahap === 'MEMUAT' ? ("), layar.indexOf(') : bungaTampil ? ('));

  // ---------------------------------------------------------------- TEST 1
  describe('TEST 1 — MEMUAT: loading terlihat, bukan Rp0, pembayaran terkunci', () => {
    const info: InfoBunga = { utangId: A.id, tahap: 'MEMUAT' };

    // DIPERBARUI RC-S74 FINAL UTANG BUNGA LOADING UX (§2/§7): judul awal kini "Menghitung otomatis…".
    // DIPERBARUI HOTFIX RC-S74 (estimasi real-time) §6: tanpa riwayat durasi -> "Estimasi beberapa detik" (dulu "Perkiraan beberapa detik").
    it('teks awal: "Menghitung otomatis…" + "Estimasi beberapa detik"; tanpa Rp', () => {
      expect(teksMemuatBunga({ estimasiMs: null }, 0)).toEqual({ judul: 'Menghitung otomatis…', estimasi: 'Estimasi beberapa detik', penjelasan: TEKS_PENJELASAN_PROSES });
      expect(teksNilaiBunga(infoBungaUntuk(A, info)!)).toBe(TEKS_MEMUAT_AWAL);
      expect(teksNilaiBunga(infoBungaUntuk(A, info)!)).not.toMatch(/Rp/);
    });

    // DIPERBARUI HOTFIX RC-S74 (estimasi real-time) §5/§7: tiket baru MEMINTA countdown, tetapi dari durasi runtime NYATA.
    // Spesifikasi lama ("tanpa countdown/ETA angka", ambang 3/8 dtk, "Waktu berjalan") diganti.
    // Maksud yang dipertahankan: tidak ada angka palsu/tetap, tidak pernah negatif, tanpa Rp.
    it('estimasi jujur: angka HANYA dari durasi aktual; tanpa riwayat -> kualitatif; lewat estimasi -> tanpa angka', () => {
      expect(teksMemuatBunga({ estimasiMs: 8_900 }, 0).estimasi).toBe('Estimasi selesai dalam ±9 detik');
      expect(teksMemuatBunga({ estimasiMs: 8_900 }, 8_000).estimasi).toBe('Estimasi selesai dalam ±1 detik');
      expect(teksMemuatBunga({ estimasiMs: 8_900 }, 9_000).estimasi).toBe(TEKS_MELEWATI_ESTIMASI);
      for (let d = 0; d <= 60; d++) {
        const tanpaRiwayat = teksMemuatBunga({ estimasiMs: null }, d * 1000);
        expect(tanpaRiwayat.estimasi).toBe(TEKS_ESTIMASI_TANPA_RIWAYAT); // tanpa riwayat: tidak pernah angka
        const t = teksMemuatBunga({ estimasiMs: 5_000 }, d * 1000);
        const semua = [t.judul, t.estimasi ?? '', t.penjelasan ?? ''].join(' ');
        expect(semua).not.toMatch(/Rp|-\d/);
        if (d >= 5) expect(t.estimasi).toBe(TEKS_MELEWATI_ESTIMASI);
      }
      // Masukan tidak valid tidak menghasilkan angka palsu.
      for (const x of [NaN, -5, Infinity]) expect(teksMemuatBunga({ estimasiMs: null }, x)).toEqual(teksMemuatBunga({ estimasiMs: null }, 0));
    });

    it('tidak memakai istilah teknis internal pada teks loading', () => {
      for (let d = 0; d <= 10; d++) {
        // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): bentuk teks baru (estimasi/penjelasan), larangan istilah internal tetap.
        for (const p of [null, { estimasiMs: null }, { estimasiMs: 4_000 }]) {
          const t = teksMemuatBunga(p, d * 1000);
          expect([t.judul, t.estimasi, t.penjelasan].join(' ')).not.toMatch(/StartupTasks|subledger|engine|trigger|replay|idempoten/i);
        }
      }
    });

    it('pembayaran terkunci & label tombol menjelaskan penantian', () => {
      expect(bungaSiapUntukBayar(A, info)).toBe(false);
      expect(layar).toMatch(/bungaTampil\?\.tahap === 'MEMUAT'\s*\?\s*'Menunggu perhitungan bunga…'/);
      expect(layar).toMatch(/disabled=\{!siap \|\| submitting\}/);
    });

    it('layar: blok MEMUAT = spinner + teks bertahap; tidak ada nilai rupiah di blok itu', () => {
      expect(blokMemuat).toContain('<ActivityIndicator size="small"');
      expect(blokMemuat).toContain('{memuat.judul}');
      // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): baris estimasi & penjelasan menggantikan perkiraan kualitatif & waktu berjalan.
      expect(blokMemuat).toContain('{memuat.estimasi ?');
      expect(blokMemuat).toContain('{memuat.penjelasan ?');
      expect(blokMemuat).not.toMatch(/formatRupiah|teksNilaiBunga|Rp0|nilai=/);
    });

    it('frame pertama setelah memilih utang langsung MEMUAT (efek baca = useLayoutEffect, sebelum paint)', () => {
      const iEfek = layar.lastIndexOf('useLayoutEffect(() => {', layar.indexOf("setInfoBunga({ utangId, tahap: 'MEMUAT' })"));
      const blokEfek = layar.slice(iEfek, layar.indexOf('}, [utang?.id, muatUlangBunga]);'));
      expect(iEfek).toBeGreaterThan(0);
      expect(blokEfek).toContain("setInfoBunga({ utangId, tahap: 'MEMUAT' });");
      expect(blokEfek).not.toMatch(/useEffect\(/);
    });
  });

  // ---------------------------------------------------------------- TEST 2
  it('TEST 2 — SIAP + 0: tampil "Rp0" dan dianggap nilai final yang sah', () => {
    const t = infoBungaUntuk(A, siap(A.id, 0))!;
    expect(t.tahap).toBe('SIAP');
    expect(teksNilaiBunga(t)).toBe('Rp0');
    expect(bungaSiapUntukBayar(A, siap(A.id, 0))).toBe(true);
  });

  // ---------------------------------------------------------------- TEST 3
  describe('TEST 3 — SIAP + >0: nominal sebenarnya', () => {
    it('nilai dari service ditampilkan apa adanya (mis. Rp1.041.667)', () => {
      expect(teksNilaiBunga(infoBungaUntuk(A, siap(A.id, 1_041_667))!)).toBe('Rp1.041.667');
      expect(teksNilaiBunga(infoBungaUntuk(A, siap(A.id, 1_041_667))!)).toBe(formatRupiah(1_041_667));
    });

    it('alur nyata (catch-up berjalan): urutan tampilan MEMUAT -> nominal, TANPA Rp0 perantara', async () => {
      const tanggal = `${tambahBulan(toPeriode(getTanggalLokalHariIni()), -3)}-01`;
      const { id } = await terimaUtang({ namaPemberi: 'Bank Historis', jenisPemberi: 'BANK', pokokPinjaman: 120_000_000, persenBunga: 12, basisBunga: 'TAHUNAN', jenisBunga: 'FLAT', tanggal, sumberDana: 'KAS', createdBy: 'user-1' });
      const utang = { id, jenisPemberi: 'BANK', persenBunga: 12 };
      const riwayat: string[] = [];
      const tampilkan = (info: InfoBunga | null) => riwayat.push(teksNilaiBunga(infoBungaUntuk(utang, info)!));

      void jalankanTugasStartup('user-1'); // pekerjaan latar yang SUDAH berjalan (dimulai aplikasi, bukan layar)
      // Urutan layar: MEMUAT dipasang lebih dulu, lalu gate, lalu baca read-model.
      tampilkan({ utangId: id, tahap: 'MEMUAT' });
      await tungguTugasStartupSelesai();
      tampilkan(infoDariDetail(id, (await getStatusBungaSemuaUtang()).get(id)));

      expect(riwayat).toEqual([TEKS_MEMUAT_AWAL, 'Rp3.600.000']);
      expect(riwayat).not.toContain('Rp0');
    });
  });

  // ---------------------------------------------------------------- TEST 4
  it('TEST 4 — TIDAK_TERSEDIA: tampil "—", pesan "Perhitungan bunga belum tersedia.", pembayaran terkunci, refresh manual', () => {
    const info = infoDariDetail(A.id, undefined);
    expect(info.tahap).toBe('TIDAK_TERSEDIA');
    expect(teksNilaiBunga(infoBungaUntuk(A, info)!)).toBe('—');
    expect(bungaSiapUntukBayar(A, info)).toBe(false);
    expect(layar).toContain('Perhitungan bunga belum tersedia.');
    expect(layar).toContain('onPress={() => setMuatUlangBunga((n) => n + 1)}'); // mekanisme refresh existing
    expect(layar).not.toMatch(/setInterval|setTimeout/); // tanpa retry loop otomatis di layar
  });

  // ---------------------------------------------------------------- TEST 5
  describe('TEST 5 — elapsed time: hanya UI, mulai saat MEMUAT, berhenti saat selesai, cleanup saat unmount', () => {
    beforeEach(() => jest.useFakeTimers({ now: new Date('2026-09-22T09:00:00Z') }));
    afterEach(() => jest.useRealTimers());

    it('hitungDetikBerjalan: detik penuh aktual, tidak negatif', () => {
      expect(hitungDetikBerjalan(1_000, 1_000)).toBe(0);
      expect(hitungDetikBerjalan(1_000, 4_999)).toBe(3);
      expect(hitungDetikBerjalan(5_000, 1_000)).toBe(0);
    });

    it('penghitung: 0 segera, lalu elapsed nyata; berhenti() membersihkan interval (idempoten)', () => {
      const nilai: number[] = [];
      const p = mulaiPenghitungDetik((d) => nilai.push(d));
      expect(nilai).toEqual([0]);
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(4_000);
      expect(nilai).toEqual([0, 1, 2, 3, 4]);
      p.berhenti();
      p.berhenti();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(5_000);
      expect(nilai).toEqual([0, 1, 2, 3, 4]); // tidak berjalan lagi setelah selesai
    });

    it('angka = waktu nyata, bukan jumlah tik (tik tertunda tidak menggeser angka)', () => {
      let jam = 10_000;
      const nilai: number[] = [];
      const p = mulaiPenghitungDetik((d) => nilai.push(d), () => jam);
      jam += 6_500; // JS thread sempat sibuk 6,5 dtk
      jest.advanceTimersByTime(1_000); // hanya satu tik yang sempat jalan
      expect(nilai).toEqual([0, 6]);
      p.berhenti();
    });

    it('hook: mulai saat MEMUAT, reset & berhenti saat SIAP, hitungan baru untuk utang lain', () => {
      const h = renderHookDetik({ aktif: true, kunci: 'utg-A:0' });
      expect(h.detik).toBe(0);
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(3_000);
      expect(h.detik).toBe(3);

      h.rerender({ aktif: false, kunci: 'utg-A:0' }); // selesai (SIAP / TIDAK_TERSEDIA)
      expect(h.detik).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      const renderSetelahSelesai = h.jumlahRender;
      jest.advanceTimersByTime(10_000);
      expect(h.jumlahRender).toBe(renderSetelahSelesai); // timer benar-benar mati

      h.rerender({ aktif: true, kunci: 'utg-A:0' });
      jest.advanceTimersByTime(2_000);
      expect(h.detik).toBe(2);
      h.rerender({ aktif: true, kunci: 'utg-B:0' }); // ganti utang saat masih memuat
      expect(h.detik).toBe(0); // hitungan baru, bukan lanjutan milik A
      expect(jest.getTimerCount()).toBe(1); // tidak pernah dua interval bersamaan
      h.unmount();
    });

    it('hook: unmount saat MEMUAT membersihkan interval', () => {
      const h = renderHookDetik({ aktif: true, kunci: 'utg-A:0' });
      jest.advanceTimersByTime(1_000);
      expect(jest.getTimerCount()).toBe(1);
      h.unmount();
      expect(jest.getTimerCount()).toBe(0);
      const n = h.jumlahRender;
      jest.advanceTimersByTime(5_000);
      expect(h.jumlahRender).toBe(n);
    });

    it('hook: tidak aktif sejak awal -> tidak ada timer sama sekali', () => {
      const h = renderHookDetik({ aktif: false, kunci: 'utg-A:0' });
      expect(h.detik).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      h.unmount();
    });

    it('timer hanya untuk tampilan: hook hanya mengimpor react; tidak menyentuh service/DB/akuntansi', () => {
      const imports = hook.match(/^import .* from '[^']+';$/gm) ?? [];
      expect(imports).toEqual(["import { useLayoutEffect, useState } from 'react';"]);
      expect(hook).not.toMatch(/@\/(services|database|accounting)|tungguTugasStartupSelesai|getStatusBungaSemuaUtang|jalankan|setTimeout/);
      expect(hook).toMatch(/return \(\) => penghitung\.berhenti\(\);/); // cleanup
      // Layar: timer diikat ke tahap MEMUAT & kunci (utang + muat ulang manual).
      // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): argumen ke-3 = titik mulai batch StartupTasks yang sebenarnya.
      expect(layar).toContain("const detikMemuat = useDetikMemuat(bungaTampil?.tahap === 'MEMUAT', `${utang?.id ?? ''}:${muatUlangBunga}`, prosesBunga?.mulaiMs ?? null);");
    });
  });

  // ---------------------------------------------------------------- TEST 6
  it('TEST 6 — tidak ada direct call jalankanAkrualBungaUtangJikaPerlu() dari layar/hook/helper', () => {
    for (const src of [layar, hook, helper]) {
      expect(src).not.toMatch(/jalankanAkrualBungaUtangJikaPerlu|prosesAkrualBungaUtangOtomatis|jalankanTugasStartup|akruiBungaUtang/);
    }
  });

  // ---------------------------------------------------------------- TEST 7
  it('TEST 7 — layar tetap menunggu tungguTugasStartupSelesai() sebelum membaca hasil', () => {
    const iGate = layar.indexOf('await tungguTugasStartupSelesai();');
    expect(iGate).toBeGreaterThan(0);
    expect(layar.indexOf('await getStatusBungaSemuaUtang()')).toBeGreaterThan(iGate);
    expect(layar.indexOf("setInfoBunga({ utangId, tahap: 'MEMUAT' });")).toBeLessThan(iGate);
  });

  // ---------------------------------------------------------------- TEST 8
  it('TEST 8 — race A/B: hasil A yang terlambat tidak pernah tampil pada B', () => {
    const hasilA = siap(A.id, 3_600_000);
    expect(infoBungaUntuk(B, hasilA)).toEqual({ utangId: B.id, tahap: 'BELUM_ADA' });
    expect(bungaSiapUntukBayar(B, hasilA)).toBe(false);
    expect(teksNilaiBunga(infoBungaUntuk(B, hasilA)!)).not.toMatch(/Rp/);
    // Guard efek tetap: hasil diterapkan hanya bila efek utang itu masih aktif.
    expect(layar).toMatch(/if \(!aktif\) return;\s*setInfoBunga\(infoDariDetail\(utangId, detail, akrualGagal\)\);/); // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): arg ke-3 = kegagalan mesin (§13)
    expect(layar).toMatch(/return \(\) => \{\s*aktif = false;\s*\};/);
    expect(layar).toMatch(/\}, \[utang\?\.id, muatUlangBunga\]\);/);
  });
});

// ===========================================================================
// RC-S74 — FINAL UTANG BUNGA LOADING UX (§16 TEST 1–10)
// Skenario device: utang 25 jt, 10%/thn, mulai bulan lalu -> 1 periode (Rp208.333).
// ===========================================================================

describe('RC-S74 FINAL UTANG BUNGA LOADING UX', () => {
  const layar = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));
  const hook = tanpaKomentar(baca('src/hooks/useDetikMemuat.ts'));
  const blokMemuat = layar.slice(layar.indexOf("{bungaTampil?.tahap === 'MEMUAT' ? ("), layar.indexOf(') : bungaTampil ? ('));
  const blokStatus = layar.slice(layar.indexOf("{bungaTampil?.tahap === 'SIAP' ? ("), layar.indexOf("{bungaTampil?.tahap === 'TIDAK_TERSEDIA' ? ("));
  const U = { id: 'utg-U1', jenisPemberi: 'BANK', persenBunga: 10 };
  const siapDari = (status: string, nilai: number, pesan: string | null) =>
    infoDariDetail(U.id, { status: status as any, outstandingBunga: nilai, pesan });

  /** Utang persis seperti skenario device: tanggal awal bulan lalu. */
  async function utangBulanLalu(): Promise<string> {
    const tanggal = `${tambahBulan(toPeriode(getTanggalLokalHariIni()), -1)}-01`;
    const r = await terimaUtang({ namaPemberi: 'Bank Device', jenisPemberi: 'BANK', pokokPinjaman: 25_000_000, persenBunga: 10, basisBunga: 'TAHUNAN', jenisBunga: 'FLAT', tanggal, sumberDana: 'KAS', createdBy: 'user-1' });
    return r.id;
  }

  /** Semua teks yang akan terlihat di kartu "Utang Bunga" untuk suatu state (nilai + status + pesan). */
  function teksTerlihat(info: InfoBunga | null): string {
    const t = infoBungaUntuk(U, info)!;
    if (t.tahap === 'MEMUAT') {
      // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): proses latar berjalan tanpa riwayat durasi (aplikasi baru dibuka).
      const m = teksMemuatBunga({ estimasiMs: null }, 0);
      return [m.judul, m.estimasi].join(' ');
    }
    const bagian = [teksNilaiBunga(t)];
    if (t.tahap === 'SIAP') bagian.push(LABEL_STATUS_BUNGA_UTANG[t.statusBunga], t.pesanBunga ?? '');
    return bagian.join(' ');
  }

  // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): "Perkiraan beberapa detik" -> "Estimasi beberapa detik" (§6).
  it('TEST 1 — MEMUAT: "Menghitung otomatis…" + "Estimasi beberapa detik"; tanpa Rp0, tanpa Perlu Perhatian; tombol terkunci', () => {
    const info: InfoBunga = { utangId: U.id, tahap: 'MEMUAT' };
    expect(teksTerlihat(info)).toBe('Menghitung otomatis… Estimasi beberapa detik');
    expect(teksTerlihat(info)).not.toMatch(/Rp|Perlu Perhatian/);
    expect(bungaSiapUntukBayar(U, info)).toBe(false);
    // Di layar: blok MEMUAT tanpa nilai/status; baris Status HANYA di cabang SIAP.
    expect(blokMemuat).not.toMatch(/LABEL_STATUS_BUNGA_UTANG|statusBunga|pesanBunga|formatRupiah/);
    expect(blokStatus).toContain('LABEL_STATUS_BUNGA_UTANG[bungaTampil.statusBunga]');
    expect(layar.match(/LABEL_STATUS_BUNGA_UTANG\[/g)).toHaveLength(1);
  });

  it('TEST 2 — SIAP + 0: "Rp0" tampil', () => {
    expect(teksNilaiBunga(infoBungaUntuk(U, siapDari('TERKENDALI', 0, null))!)).toBe('Rp0');
  });

  it('TEST 3 — SIAP + >0: nominal aktual (Rp208.333)', () => {
    expect(teksNilaiBunga(infoBungaUntuk(U, siapDari('TERKENDALI', 208_333, null))!)).toBe('Rp208.333');
  });

  it('TEST 4 — PERLU_PERHATIAN FINAL: status & pesan periode tampil apa adanya (tidak disembunyikan)', async () => {
    const id = await utangBulanLalu();
    // Tidak ada tugas latar yang berjalan -> gate lolos; ini kondisi FINAL saat dibaca.
    await tungguTugasStartupSelesai();
    const info = infoDariDetail(id, (await getStatusBungaSemuaUtang()).get(id));
    expect(info.tahap).toBe('SIAP');
    if (info.tahap !== 'SIAP') return;
    expect(info.statusBunga).toBe('PERLU_PERHATIAN');
    expect(info.pesanBunga).toMatch(/^Bunga periode \d{4}-\d{2} belum tercatat\.$/);
    expect(LABEL_STATUS_BUNGA_UTANG[info.statusBunga]).toBe('Perlu Perhatian');
    expect(bungaSiapUntukBayar({ ...U, id }, info)).toBe(true); // status tidak mengunci pembayaran
  });

  it('TEST 5 — proses masih berjalan: snapshot sementara (Rp0 + Perlu Perhatian) TIDAK PERNAH ditampilkan', async () => {
    const id = await utangBulanLalu();
    const u = { ...U, id };
    const tampil: string[] = [];
    const render = (info: InfoBunga) => {
      const t = infoBungaUntuk(u, info)!;
      tampil.push(t.tahap === 'SIAP' ? `${teksNilaiBunga(t)} | ${LABEL_STATUS_BUNGA_UTANG[t.statusBunga]}` : teksNilaiBunga(t));
    };

    const tugas = jalankanTugasStartup('user-1'); // proses otomatis existing SEDANG berjalan
    // Bukti bahwa snapshot sementara memang ada: pembacaan langsung TANPA gate.
    const snapshot = (await getStatusBungaSemuaUtang()).get(id);
    expect(snapshot?.status).toBe('PERLU_PERHATIAN');
    expect(snapshot?.outstandingBunga).toBe(0);

    // Urutan layar: MEMUAT -> gate -> baca -> terapkan.
    render({ utangId: id, tahap: 'MEMUAT' });
    await tungguTugasStartupSelesai();
    render(infoDariDetail(id, (await getStatusBungaSemuaUtang()).get(id)));
    await tugas;

    expect(tampil).toEqual(['Menghitung otomatis…', 'Rp208.333 | Terkendali']);
    expect(tampil.join(' ')).not.toMatch(/Rp0|Perlu Perhatian/);
  });

  it('TEST 6 — setelah tugas selesai, baca ulang (Coba lagi/pilih ulang) memberi nominal & status aktual', async () => {
    const id = await utangBulanLalu();
    await tungguTugasStartupSelesai();
    const sebelum = infoDariDetail(id, (await getStatusBungaSemuaUtang()).get(id));
    expect(sebelum.tahap === 'SIAP' && sebelum.statusBunga).toBe('PERLU_PERHATIAN');
    await jalankanTugasStartup('user-1'); // dipicu mekanisme existing (mis. aplikasi kembali aktif)
    await tungguTugasStartupSelesai();
    const sesudah = infoDariDetail(id, (await getStatusBungaSemuaUtang()).get(id));
    expect(sesudah).toEqual({ utangId: id, tahap: 'SIAP', nilai: 208_333, statusBunga: 'TERKENDALI', pesanBunga: null });
    expect(teksNilaiBunga(infoBungaUntuk({ ...U, id }, sesudah)!)).toBe('Rp208.333');
  });

  it('TEST 7 — race A/B: hasil A tidak pernah tampil pada B', () => {
    const B = { ...U, id: 'utg-U2' };
    const hasilA = siapDari('PERLU_PERHATIAN', 0, 'Bunga periode 2026-08 belum tercatat.');
    expect(infoBungaUntuk(B, hasilA)).toEqual({ utangId: B.id, tahap: 'BELUM_ADA' });
    expect(bungaSiapUntukBayar(B, hasilA)).toBe(false);
    expect(layar).toMatch(/if \(!aktif\) return;\s*setInfoBunga\(infoDariDetail\(utangId, detail, akrualGagal\)\);/); // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): arg ke-3 = kegagalan mesin (§13)
  });

  it('TEST 8 — timer cleanup: berhenti setelah READY/ERROR dan saat unmount', () => {
    jest.useFakeTimers();
    try {
      const h = renderHookDetik({ aktif: true, kunci: 'utg-U1:0' });
      jest.advanceTimersByTime(4_000);
      expect(h.detik).toBe(4);
      // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): dari detik hook -> sisa estimasi (riwayat 6 dtk): ±2 detik.
      expect(teksMemuatBunga({ estimasiMs: 6_000 }, h.detik * 1000)).toEqual({ judul: 'Menghitung otomatis…', estimasi: 'Estimasi selesai dalam ±2 detik', penjelasan: TEKS_PENJELASAN_PROSES });
      h.rerender({ aktif: false, kunci: 'utg-U1:0' }); // READY atau ERROR: tahap bukan MEMUAT
      expect(jest.getTimerCount()).toBe(0);
      h.rerender({ aktif: true, kunci: 'utg-U1:1' }); // "Coba lagi"
      jest.advanceTimersByTime(9_000);
      // DIPERBARUI HOTFIX RC-S74 (estimasi real-time): lewat estimasi -> "Proses masih berjalan…" (bukan angka negatif, bukan status bermasalah).
      expect(teksMemuatBunga({ estimasiMs: 6_000 }, h.detik * 1000).estimasi).toBe(TEKS_MELEWATI_ESTIMASI);
      expect(Object.values(teksMemuatBunga({ estimasiMs: 6_000 }, h.detik * 1000)).join(' ')).not.toMatch(/Perlu Perhatian/); // lama != bermasalah
      h.unmount();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('TEST 9 — layar tidak memanggil jalankanAkrualBungaUtangJikaPerlu() (atau pemicu lain) secara langsung', () => {
    expect(layar).not.toMatch(/jalankanAkrualBungaUtangJikaPerlu|prosesAkrualBungaUtangOtomatis|jalankanTugasStartup|akruiBungaUtang/);
  });

  it('TEST 10 — tanpa setInterval/polling/scheduler untuk accounting', () => {
    expect(layar).not.toMatch(/setInterval|setTimeout|AppState|defineTask|registerTaskAsync/);
    // Satu-satunya interval ada di hook tampilan, yang tidak menyentuh accounting.
    expect(hook).not.toMatch(/@\/(services|database|accounting)|tungguTugasStartupSelesai|getStatusBungaSemuaUtang/);
    for (const f of ['src/services/StartupTasks.ts', 'src/services/UtangBungaAccrualService.ts']) {
      expect(tanpaKomentar(baca(f))).not.toMatch(/setInterval|setTimeout/);
    }
  });
});

// ===========================================================================
// RC-S74 — FINAL FIX DELAY AKRUAL BUNGA SETELAH INPUT UTANG (one-shot startup
// task request: UtangFormScreen menandai -> GLOBAL APPLICATION COORDINATOR
// (app/index.tsx) mengonsumsi, TERLEPAS layar mana yang difokuskan)
// ===========================================================================
//
// HOTFIX RC-S74 (final) — DIPERBARUI: bug aktual (Rp0 + Perlu Perhatian
// setelah simpan utang TANPA membuka Dashboard) membuktikan bahwa
// mengandalkan Dashboard sebagai satu-satunya konsumen request itu salah.
// Konsumsi dipindah ke `app/index.tsx`, lifecycle root yang tetap mounted
// selama `phase === 'READY'` terlepas layar mana yang difokuskan. Dashboard
// tidak lagi menjadi syarat.

describe('HOTFIX RC-S74 (final) — one-shot startup task request via GLOBAL COORDINATOR', () => {
  const utangForm = tanpaKomentar(baca('src/screens/Transaksi/UtangFormScreen.tsx'));
  const dashboard = tanpaKomentar(baca('src/screens/Dashboard/DashboardScreen.tsx'));
  const appIndex = tanpaKomentar(baca('app/index.tsx'));
  const store = tanpaKomentar(baca('src/store/useAppStore.ts'));

  beforeEach(() => {
    useAppStore.setState({ startupTaskRequested: false });
  });

  describe('store: bendera one-shot', () => {
    it('awalnya false; requestStartupTask menyalakannya', () => {
      expect(useAppStore.getState().startupTaskRequested).toBe(false);
      useAppStore.getState().requestStartupTask();
      expect(useAppStore.getState().startupTaskRequested).toBe(true);
    });

    it('idempoten: menandai berulang kali sebelum dikonsumsi tetap satu request', () => {
      const { requestStartupTask, consumeStartupTaskRequest } = useAppStore.getState();
      requestStartupTask();
      requestStartupTask();
      requestStartupTask();
      expect(consumeStartupTaskRequest()).toBe(true);
      expect(consumeStartupTaskRequest()).toBe(false); // sudah dikonsumsi -> tidak dua kali
    });

    it('consumeStartupTaskRequest mematikan bendera dalam operasi yang sama (baca sekali habis)', () => {
      useAppStore.getState().requestStartupTask();
      expect(useAppStore.getState().startupTaskRequested).toBe(true);
      const hasil = useAppStore.getState().consumeStartupTaskRequest();
      expect(hasil).toBe(true);
      expect(useAppStore.getState().startupTaskRequested).toBe(false);
    });

    it('tanpa request tertunda -> consume mengembalikan false, tidak mengubah apa pun', () => {
      expect(useAppStore.getState().consumeStartupTaskRequest()).toBe(false);
      expect(useAppStore.getState().startupTaskRequested).toBe(false);
    });

    it('reset() ikut mematikan bendera', () => {
      useAppStore.getState().requestStartupTask();
      useAppStore.getState().reset();
      expect(useAppStore.getState().startupTaskRequested).toBe(false);
    });
  });

  describe('UtangFormScreen: menandai request, TIDAK memanggil StartupTasks langsung', () => {
    it('requestStartupTask() dipanggil setelah terimaUtang() berhasil, sebelum notify sukses', () => {
      const iTerima = utangForm.indexOf('await terimaUtang({');
      const iSelesaiTerima = utangForm.indexOf('});', iTerima);
      const iRequest = utangForm.indexOf('requestStartupTask();', iSelesaiTerima);
      const iNotify = utangForm.indexOf("notify('Berhasil'", iSelesaiTerima);
      expect(iRequest).toBeGreaterThan(iSelesaiTerima);
      expect(iNotify).toBeGreaterThan(iRequest); // ditandai SEBELUM notify sukses, bukan sesudah
    });

    it('tidak memanggil StartupTasks atau mesin akrual secara langsung dari layar ini', () => {
      expect(utangForm).not.toMatch(/jalankanTugasStartup|tungguTugasStartupSelesai|jalankanAkrualBungaUtangJikaPerlu/);
    });

    it('requestStartupTask diambil dari useAppStore (bukan dikarang lokal)', () => {
      expect(utangForm).toMatch(/const requestStartupTask = useAppStore\(\(s\) => s\.requestStartupTask\);/);
    });
  });

  describe('DashboardScreen: TIDAK LAGI mengonsumsi request — hanya pekerjaan Dashboard', () => {
    it('tidak mengimpor jalankanTugasStartup, tidak membaca/consume bendera one-shot', () => {
      expect(dashboard).not.toMatch(/jalankanTugasStartup|consumeStartupTaskRequest|startupTaskRequested/);
      expect(dashboard).not.toMatch(/from '@\/services\/StartupTasks'/);
    });

    it('useFocusRefresh Dashboard hanya berisi load/status identitas/status lisensi', () => {
      const iEfek = dashboard.indexOf('useFocusRefresh(() => {');
      const iTutup = dashboard.indexOf('}, [', iEfek);
      const isiEfek = dashboard.slice(iEfek, iTutup);
      expect(isiEfek).toContain('load()');
      expect(isiEfek).toContain('muatStatusIdentitas()');
      expect(isiEfek).toContain('muatStatusLisensi()');
      expect(isiEfek).not.toMatch(/jalankanTugasStartup|consumeStartupTaskRequest/);
    });
  });

  describe('GLOBAL APPLICATION COORDINATOR (app/index.tsx): mengonsumsi request terlepas layar yang difokuskan', () => {
    it('membaca startupTaskRequested & currentUser dari useAppStore (reactive terhadap perubahan state, bukan polling)', () => {
      expect(appIndex).toMatch(/const startupTaskRequested = useAppStore\(\(s\) => s\.startupTaskRequested\);/);
      expect(appIndex).toMatch(/const currentUser = useAppStore\(\(s\) => s\.currentUser\);/);
      expect(appIndex).toMatch(/const consumeStartupTaskRequest = useAppStore\(\(s\) => s\.consumeStartupTaskRequest\);/);
    });

    it('efek fallback berpagar phase READY + request + user, consume di dalam guard sebelum memanggil koordinator', () => {
      const iEfek = appIndex.indexOf("if (phase !== 'READY' || !startupTaskRequested || !currentUser) return;");
      expect(iEfek).toBeGreaterThan(0);
      const iConsume = appIndex.indexOf('if (!consumeStartupTaskRequest()) return;', iEfek);
      const iPanggil = appIndex.indexOf('jalankanTugasStartup(currentUser.id)', iEfek);
      expect(iConsume).toBeGreaterThan(iEfek);
      expect(iPanggil).toBeGreaterThan(iConsume); // consume DULU, baru panggil koordinator
      // HARDENING RC-S74 (final): tiga pemanggilan jalankanTugasStartup total
      // di file ini — transisi READY (login/unlock/restore, existing),
      // listener SINKRON (subscription, menutup race window), dan efek
      // fallback ini (kasus request datang sebelum READY). Tidak ada yang
      // lain, dan tidak ada duplikasi tak sengaja.
      expect(appIndex.match(/jalankanTugasStartup\(/g)).toHaveLength(3);
    });

    it('HARDENING (final) — listener SINKRON ke store Zustand (bukan lewat hook React) menutup race window', () => {
      // `useAppStore.subscribe(...)` adalah API vanilla Zustand: listener-nya
      // dipanggil SINKRON di dalam `setState` (lihat node_modules/zustand),
      // BUKAN lewat siklus render/effect React yang asinkron.
      const iSub = appIndex.indexOf('const unsub = useAppStore.subscribe((state, prevState) => {');
      expect(iSub).toBeGreaterThan(0);
      const iTutupSub = appIndex.indexOf('return unsub;', iSub);
      const blokSub = appIndex.slice(iSub, iTutupSub);
      // Rising-edge (§5): hanya bertindak saat false -> true.
      expect(blokSub).toContain('if (!state.startupTaskRequested || prevState.startupTaskRequested) return;');
      // Readiness (§4/§7): phase dari REF (bukan closure React basi), user dari getState() (selalu terbaru).
      expect(blokSub).toContain("if (phaseRef.current !== 'READY' || !state.currentUser) return;");
      expect(blokSub).toContain('if (!useAppStore.getState().consumeStartupTaskRequest()) return;');
      expect(blokSub).toContain('jalankanTugasStartup(state.currentUser.id).catch(() => {});');
      // Didaftarkan SEKALI, bukan per-render — deps kosong.
      const iEfekAwal = appIndex.lastIndexOf('useEffect(() => {', iSub);
      const iTutupEfek = appIndex.indexOf('}, []);', iSub);
      expect(iTutupEfek).toBeGreaterThan(iSub);
      expect(appIndex.slice(iEfekAwal, iTutupEfek)).not.toMatch(/setInterval|setTimeout|AppState\.addEventListener|getStatusBungaSemuaUtang/);
    });

    it('HARDENING (final) — phaseRef diperbarui setiap render (bukan di dalam efek), mencegah stale closure', () => {
      const iRef = appIndex.indexOf('const phaseRef = useRef(phase);');
      expect(iRef).toBeGreaterThan(0);
      expect(appIndex.slice(iRef, iRef + 120)).toContain('phaseRef.current = phase;');
      // Baris ini di BADAN komponen (setiap render), bukan di dalam useEffect manapun.
      const iEfekPertama = appIndex.indexOf('useEffect(');
      expect(iRef).toBeLessThan(iEfekPertama);
    });

    it('memakai koordinator StartupTasks existing yang SAMA dipakai transisi READY (login/unlock) — bukan engine baru', () => {
      expect(appIndex).toMatch(/import \{ jalankanTugasStartup \} from '@\/services\/StartupTasks';/);
      expect((appIndex.match(/import \{ jalankanTugasStartup \}/g) ?? [])).toHaveLength(1); // satu impor, dipakai dua tempat
    });

    it('pemanggilan tidak di-`await` (aplikasi tidak boleh menunggu akrual) dan errornya ditelan', () => {
      expect(appIndex).toMatch(/jalankanTugasStartup\(currentUser\.id\)\.catch\(\(\) => \{\}\);\s*\}, \[phase, startupTaskRequested, currentUser, consumeStartupTaskRequest\]\);/);
    });

    it('efek TERPISAH dari transisi phase (evaluatePhase) — reactive murni terhadap perubahan bendera, bukan dipanggil dari useEffect getDb/evaluatePhase', () => {
      const iEfekCoordinator = appIndex.indexOf("if (phase !== 'READY' || !startupTaskRequested || !currentUser) return;");
      const iUseEffectAwal = appIndex.lastIndexOf('useEffect(() => {', iEfekCoordinator);
      const blokEfek = appIndex.slice(iUseEffectAwal, appIndex.indexOf('}, [phase, startupTaskRequested, currentUser, consumeStartupTaskRequest]);', iEfekCoordinator));
      expect(blokEfek).not.toMatch(/evaluatePhase\(\)|getDb\(\)/); // bukan bagian dari efek startup/restore/auto-lock lain
    });

    it('tidak ada polling/scheduler baru (tanpa setInterval/setTimeout/AppState di efek coordinator)', () => {
      const iEfek = appIndex.indexOf("if (phase !== 'READY' || !startupTaskRequested || !currentUser) return;");
      const iUseEffectAwal = appIndex.lastIndexOf('useEffect(() => {', iEfek);
      const iTutup = appIndex.indexOf('}, [phase, startupTaskRequested, currentUser, consumeStartupTaskRequest]);', iEfek);
      const blokEfek = appIndex.slice(iUseEffectAwal, iTutup);
      expect(blokEfek).not.toMatch(/setInterval|setTimeout|AppState\.addEventListener/);
    });

    it('TEST 14 — alur startup existing (login/unlock/restore) TIDAK diubah: transisi READY tetap memanggil jalankanTugasStartup apa adanya', () => {
      // Kode transisi ke READY (login/unlock/kembali dari background/restore)
      // yang SUDAH ADA sebelum hotfix tetap utuh — hotfix ini HANYA menambah
      // efek coordinator baru di atas, tidak mengubah baris existing.
      expect(appIndex).toMatch(/jalankanTugasStartup\(user\.id\)\.catch\(\(\) => \{\}\);\s*\}\s*setPhase\('READY'\);/);
      // Dua pemanggilan total di file: satu dari transisi READY existing,
      // satu dari efek coordinator baru (dihitung di test sebelumnya).
      expect(appIndex).toMatch(/const evaluatePhase = useCallback\(async \(\) => \{[\s\S]*jalankanTugasStartup\(user\.id\)/);
    });
  });

  describe('Store: bukan sumber kebenaran accounting, murni sinyal UI', () => {
    it('tidak mengimpor service/database apa pun', () => {
      const imports = store.match(/^import .* from '[^']+';$/gm) ?? [];
      for (const imp of imports) expect(imp).not.toMatch(/@\/(services|database|accounting)/);
    });
  });

  describe('Skenario device end-to-end (§ awal ticket, dijalankan nyata — bukan hanya dibaca sumbernya)', () => {
    beforeEach(() => {
      _resetTugasStartupUntukTest();
      _resetGerbangAkrualUntukTest();
      useAppStore.setState({ startupTaskRequested: false, currentUser: { id: 'user-1', nama: 'A', role: 'ADMIN' } });
    });

    it('Penerimaan -> Utang Koperasi -> simpan -> StartupTasks SEBELUMNYA sudah selesai (tidak ada task berjalan) -> tungguTugasStartupSelesai() SAJA tidak cukup', async () => {
      // Simulasikan StartupTasks lama sudah pernah selesai sebelum utang baru dibuat.
      await jalankanTugasStartup('user-1');
      await tungguTugasStartupSelesai();

      // Simulasi UtangFormScreen: terimaUtang() lalu requestStartupTask() (bukan panggilan mesin langsung).
      const tanggal = `${tambahBulan(toPeriode(getTanggalLokalHariIni()), -1)}-01`;
      const { id } = await terimaUtang({ namaPemberi: 'Bank Device', jenisPemberi: 'BANK', pokokPinjaman: 25_000_000, persenBunga: 10, basisBunga: 'TAHUNAN', jenisBunga: 'FLAT', tanggal, sumberDana: 'KAS', createdBy: 'user-1' });
      useAppStore.getState().requestStartupTask();

      // Bukti masalah nyata yang dilaporkan: tungguTugasStartupSelesai() SAJA (tanpa
      // memulai batch baru) tidak menjalankan akrual untuk utang yang baru dibuat.
      await tungguTugasStartupSelesai();
      const sebelumDashboard = (await getStatusBungaSemuaUtang()).get(id);
      expect(sebelumDashboard?.status).toBe('PERLU_PERHATIAN');
      expect(sebelumDashboard?.outstandingBunga).toBe(0);

      // Simulasikan coordinator global (app/index.tsx) bereaksi terhadap perubahan bendera: konsumsi request lalu jalankan koordinator.
      const ada = useAppStore.getState().consumeStartupTaskRequest();
      expect(ada).toBe(true);
      await jalankanTugasStartup(useAppStore.getState().currentUser!.id);

      // Sekarang BayarUtangFormScreen (gate tungguTugasStartupSelesai() miliknya sendiri) melihat hasil benar.
      await tungguTugasStartupSelesai();
      const detail = infoDariDetail(id, (await getStatusBungaSemuaUtang()).get(id));
      expect(detail).toEqual({ utangId: id, tahap: 'SIAP', nilai: 208_333, statusBunga: 'TERKENDALI', pesanBunga: null });
      expect(teksNilaiBunga(infoBungaUntuk({ id, jenisPemberi: 'BANK', persenBunga: 10 }, detail)!)).toBe('Rp208.333');

      // Request one-shot sudah habis — efek coordinator berikutnya (mis. perubahan state lain) TIDAK memicu batch lagi.
      expect(useAppStore.getState().consumeStartupTaskRequest()).toBe(false);
    });

    it('TANPA request tertunda, coordinator tidak pernah memicu StartupTasks (bukan setiap perubahan state)', () => {
      expect(useAppStore.getState().startupTaskRequested).toBe(false);
      const ada = useAppStore.getState().consumeStartupTaskRequest();
      expect(ada).toBe(false); // -> di app/index.tsx sungguhan, ini berarti jalankanTugasStartup TIDAK dipanggil
    });

    it('BUG AKTUAL YANG DIPERBAIKI: request tanpa Dashboard PERNAH dibuka -> coordinator TETAP mengonsumsi (bukan Dashboard-dependent)', () => {
      // Simulasi persis skenario yang dilaporkan: DashboardScreen TIDAK PERNAH
      // di-mount/focus dalam test ini sama sekali — hanya store + StartupTasks +
      // app/index.tsx yang diverifikasi (struktur di atas membuktikan app/index.tsx
      // yang menjalankan efek ini, terlepas Dashboard).
      useAppStore.getState().requestStartupTask();
      const ada = useAppStore.getState().consumeStartupTaskRequest();
      expect(ada).toBe(true); // coordinator global tetap bisa mengonsumsi tanpa Dashboard
    });
  });
});
