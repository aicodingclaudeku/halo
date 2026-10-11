/**
 * RC-S84 — MENU PAJAK.
 *
 * Mengunci: (1) aturan murni pajakPolicy (tarif, pembulatan, batas
 * fasilitas PP 20/2026, lebih bayar), (2) jurnal yang dibuat PajakService
 * lewat mesin yang sudah ada, (3) keterhubungan dengan Bayar Kewajiban,
 * (4) tidak ada migrasi skema / perubahan COA default.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
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

import { createJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { classifyTransactionSource } from '@/accounting/CashFlowClassification';
import { listAkunKewajibanUmum } from '@/services/UtangService';
import { koreksiTransaksiKasBank } from '@/services/KasBankService';
import {
  batalkanPengakuanPajak,
  catatAngsuranPph25,
  catatPphBadan,
  catatPphFinal,
  getInfoPphFinal,
  getOmzetMasa,
  getRingkasanPajak,
  listRiwayatPajak,
  pastikanAkunPajak,
  setorPajak,
  simpanPengaturanPajak,
} from '@/services/PajakService';
import {
  AKUN_PAJAK_BARU,
  cekKelayakanFinal,
  daftarMasa,
  hitungPphBadan,
  hitungPphFinal,
  labelMasa,
  susunKeteranganSetoran,
  tahunAkhirFasilitasFinal,
  validasiNtpn,
  validasiPengaturanPajak,
} from '@/config/pajakPolicy';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const U = 'user-1';
const NTPN = 'AB12CD34EF56GH78';

const ACC = {
  kas: 'acc-kas',
  jasa: 'acc-jasa',
  bungaBank: 'acc-bunga-bank',
  bebanPajak: 'acc-beban-pajak',
  utangPajak: 'acc-utang-pajak',
  dana: 'acc-dana',
};

async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}
async function pendapatan(accountId: string, nominal: number, tanggal: string) {
  await createJournal(testDb as any, {
    tanggal, sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'Pendapatan', createdBy: U,
    lines: [
      { accountId: ACC.kas, debit: nominal, kredit: 0 },
      { accountId, debit: 0, kredit: nominal },
    ],
  });
}
async function idKode(kode: string): Promise<string> {
  return (await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, kode))!.id;
}
async function saldoKode(kode: string): Promise<number> {
  return getAccountBalance(testDb as any, await idKode(kode));
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.jasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.bungaBank, '4-1510', 'Pendapatan Bunga Deposito', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.bebanPajak, '5-2200', 'Beban Pajak Penghasilan', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.utangPajak, '2-1900', 'Utang Pajak', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.dana, '2-1800', 'Dana Pendidikan', 'LIABILITAS', 'KREDIT');
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m1','KAS_UMUM','DEFAULT',?)`, ACC.kas);
  for (const t of [2025, 2026]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${t}`, t, `${t}-01-01`, `${t}-12-31`
    );
  }
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`, now, now
  );
  await pendapatan(ACC.jasa, 50_000_000, '2025-01-05'); // modal kas awal
  await pendapatan(ACC.jasa, 20_000_000, '2026-08-10');
  await pendapatan(ACC.bungaBank, 1_000_000, '2026-08-31');
  await pendapatan(ACC.jasa, 7_000_000, '2026-09-02'); // masa lain — tidak boleh ikut Agustus
});

afterEach(() => testDb.closeSync());

// ===========================================================================
// Aturan murni
// ===========================================================================

describe('RC-S84 — pajakPolicy (murni)', () => {
  it.each([
    [2015, 2021], // PP 23/2018: hitungan dimulai 2018
    [2019, 2022],
    [2020, 2023],
    [2021, 2029], // jangka dasar berakhir 2024 -> peralihan PP 20/2026
    [2024, 2029],
    [2026, 2029],
    [2027, 2030],
    [2030, 2033],
  ])('terdaftar %i -> fasilitas final sampai %i', (daftar, akhir) => {
    expect(tahunAkhirFasilitasFinal(daftar)).toBe(akhir);
  });

  it('kelayakan: belum diatur, skema umum, dan lewat batas ditolak; dalam batas diterima', () => {
    expect(cekKelayakanFinal(null, 2026).layak).toBe(false);
    expect(cekKelayakanFinal({ skema: 'UMUM', tahunTerdaftar: 2022 }, 2026).layak).toBe(false);
    const lewat = cekKelayakanFinal({ skema: 'FINAL_UMKM', tahunTerdaftar: 2019 }, 2026);
    expect(lewat.layak).toBe(false);
    if (!lewat.layak) expect(lewat.alasan).toMatch(/berakhir pada tahun pajak 2022/);
    expect(cekKelayakanFinal({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022 }, 2026)).toEqual({ layak: true, tahunAkhir: 2029 });
    expect(cekKelayakanFinal({ skema: 'FINAL_UMKM', tahunTerdaftar: 2026 }, 2025).layak).toBe(false);
  });

  it('PPh Final 0,5% integer, dibulatkan ke bawah', () => {
    expect(hitungPphFinal(20_000_000)).toBe(100_000);
    expect(hitungPphFinal(1_234_567)).toBe(6_172);
    expect(hitungPphFinal(199)).toBe(0);
    expect(() => hitungPphFinal(-1)).toThrow();
    expect(() => hitungPphFinal(10.5)).toThrow();
  });

  it('PPh Badan: kurang bayar dihitung, lebih bayar ditolak', () => {
    expect(hitungPphBadan(500_000, 300_000)).toEqual({ terutang: 500_000, kreditPph25: 300_000, kurangBayar: 200_000 });
    expect(hitungPphBadan(500_000, 0)).toEqual({ terutang: 500_000, kreditPph25: 0, kurangBayar: 500_000 });
    expect(() => hitungPphBadan(500_000, 600_000)).toThrow(/lebih bayar/);
  });

  it('NTPN, masa, keterangan, pengaturan', () => {
    expect(validasiNtpn('')).toBeNull();
    expect(validasiNtpn('ab12 cd34 ef56 gh78')).toBeNull();
    expect(validasiNtpn('123')).toMatch(/16/);
    expect(daftarMasa('2026-02', 3)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(labelMasa('2026-08')).toBe('Agustus 2026');
    expect(susunKeteranganSetoran('PPh Final 0,5%', '2026-08', 'ab12cd34ef56gh78')).toBe('Setor PPh Final 0,5% · Masa Agustus 2026 · NTPN AB12CD34EF56GH78');
    expect(validasiPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2030 }, 2026)).toMatch(/antara/);
    expect(validasiPengaturanPajak({ skema: 'X', tahunTerdaftar: 2020 }, 2026)).toMatch(/skema/);
  });
});

// ===========================================================================
// PPh Final
// ===========================================================================

describe('RC-S84 — PPh Final 0,5%', () => {
  it('ditolak sebelum pengaturan pajak diisi', async () => {
    await expect(catatPphFinal({ masa: '2026-08', akunDikecualikan: [], createdBy: U })).rejects.toThrow(/Pengaturan pajak belum diisi/);
  });

  it('omzet masa diambil dari ledger per akun pendapatan, hanya masa itu', async () => {
    const o = await getOmzetMasa('2026-08');
    expect(o.map((x) => [x.kode, x.nilai])).toEqual([['4-1000', 20_000_000], ['4-1510', 1_000_000]]);
  });

  it('mencatat Dr 5-2200 / Kr 2-1904 non-kas; akun pengecualian dihormati; akun baru dibuat sebagai akun sistem', async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    const kasSebelum = await getAccountBalance(testDb as any, ACC.kas);
    const h = await catatPphFinal({ masa: '2026-08', akunDikecualikan: [ACC.bungaBank], createdBy: U });
    expect(h.nominal).toBe(100_000); // 0,5% x 20.000.000 (bunga bank dikecualikan)
    expect(await saldoKode('5-2200')).toBe(100_000);
    expect(await saldoKode('2-1904')).toBe(100_000);
    expect(await getAccountBalance(testDb as any, ACC.kas)).toBe(kasSebelum);
    const j = await testDb.getFirstAsync<{ tanggal: string; sumber_transaksi: string; sumber_id: string }>(`SELECT tanggal, sumber_transaksi, sumber_id FROM journal WHERE id = ?`, h.journalId);
    expect(j).toEqual({ tanggal: '2026-08-31', sumber_transaksi: 'PAJAK_PENGAKUAN', sumber_id: 'PPH_FINAL:2026-08' });
    const akun = await testDb.getFirstAsync<{ is_system: number; kategori: string }>(`SELECT is_system, kategori FROM account WHERE kode = '2-1904'`);
    expect(akun).toEqual({ is_system: 1, kategori: 'LIABILITAS' });
    expect(classifyTransactionSource('PAJAK_PENGAKUAN')).toBe('NON_KAS');
  });

  it('satu pengakuan per masa; setelah dibatalkan boleh dicatat ulang', async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    const h = await catatPphFinal({ masa: '2026-08', akunDikecualikan: [], createdBy: U });
    expect(h.nominal).toBe(105_000);
    await expect(catatPphFinal({ masa: '2026-08', akunDikecualikan: [], createdBy: U })).rejects.toThrow(/sudah dicatat/);
    expect((await getInfoPphFinal('2026-08')).sudahDicatat?.nomorJurnal).toBe(h.nomorJurnal);

    await batalkanPengakuanPajak({ journalId: h.journalId, alasan: 'salah akun', userId: U });
    expect(await saldoKode('2-1904')).toBe(0);
    expect((await getInfoPphFinal('2026-08')).sudahDicatat).toBeNull();
    const ulang = await catatPphFinal({ masa: '2026-08', akunDikecualikan: [ACC.bungaBank], createdBy: U });
    expect(ulang.nominal).toBe(100_000);
    expect(await saldoKode('5-2200')).toBe(100_000);
  });

  it('pembatalan ditolak bila utangnya sudah disetor', async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    const h = await catatPphFinal({ masa: '2026-08', akunDikecualikan: [], createdBy: U });
    await setorPajak({ accountId: await idKode('2-1904'), masa: '2026-08', nominal: 50_000, sumberDana: 'KAS', tanggal: '2026-09-10', ntpn: NTPN, createdBy: U });
    await expect(batalkanPengakuanPajak({ journalId: h.journalId, alasan: 'x', userId: U })).rejects.toThrow(/sudah disetor/);
    await expect(batalkanPengakuanPajak({ journalId: h.journalId, alasan: ' ', userId: U })).rejects.toThrow(/Alasan/);
  });

  it('skema umum atau fasilitas yang sudah berakhir ditolak keras', async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2019, updatedBy: U });
    await expect(catatPphFinal({ masa: '2026-08', akunDikecualikan: [], createdBy: U })).rejects.toThrow(/berakhir/);
    await simpanPengaturanPajak({ skema: 'UMUM', tahunTerdaftar: 2019, updatedBy: U });
    await expect(catatPphFinal({ masa: '2026-08', akunDikecualikan: [], createdBy: U })).rejects.toThrow(/tarif umum/);
  });
});

// ===========================================================================
// Setor Pajak <-> Bayar Kewajiban
// ===========================================================================

describe('RC-S84 — Setor Pajak memakai mesin Bayar Kewajiban', () => {
  beforeEach(async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    await catatPphFinal({ masa: '2026-08', akunDikecualikan: [ACC.bungaBank], createdBy: U });
  });

  it('utang PPh Final langsung tampil di daftar Kewajiban Lainnya', async () => {
    const daftar = await listAkunKewajibanUmum();
    expect(daftar.find((a) => a.kode === '2-1904')?.saldo).toBe(100_000);
  });

  it('setoran: Dr 2-1904 / Kr Kas, keterangan memuat masa & NTPN', async () => {
    const kas = await getAccountBalance(testDb as any, ACC.kas);
    const r = await setorPajak({ accountId: await idKode('2-1904'), masa: '2026-08', nominal: 100_000, sumberDana: 'KAS', tanggal: '2026-09-10', ntpn: 'ab12cd34ef56gh78', createdBy: U });
    expect(await saldoKode('2-1904')).toBe(0);
    expect(await getAccountBalance(testDb as any, ACC.kas)).toBe(kas - 100_000);
    const j = await testDb.getFirstAsync<{ deskripsi: string; sumber_transaksi: string }>(`SELECT deskripsi, sumber_transaksi FROM journal WHERE id = ?`, r.journalId);
    expect(j?.deskripsi).toBe('Setor PPh Final 0,5% · Masa Agustus 2026 · NTPN AB12CD34EF56GH78');
    expect(j?.sumber_transaksi).toBe('KAS_PENGELUARAN_LAIN');
    expect((await getRingkasanPajak()).totalUtang).toBe(0);
  });

  it('setoran melebihi saldo, akun non-pajak, dan NTPN salah ditolak', async () => {
    const id = await idKode('2-1904');
    await expect(setorPajak({ accountId: id, masa: '2026-08', nominal: 100_001, sumberDana: 'KAS', tanggal: '2026-09-10', ntpn: '', createdBy: U })).rejects.toThrow(/melebihi saldo/);
    await expect(setorPajak({ accountId: ACC.dana, masa: '2026-08', nominal: 1, sumberDana: 'KAS', tanggal: '2026-09-10', ntpn: '', createdBy: U })).rejects.toThrow(/bukan akun utang pajak/);
    await expect(setorPajak({ accountId: id, masa: '2026-08', nominal: 1, sumberDana: 'KAS', tanggal: '2026-09-10', ntpn: '12', createdBy: U })).rejects.toThrow(/16/);
  });

  it('riwayat pajak diturunkan dari ledger', async () => {
    await setorPajak({ accountId: await idKode('2-1904'), masa: '2026-08', nominal: 40_000, sumberDana: 'KAS', tanggal: '2026-09-10', ntpn: '', createdBy: U });
    const r = await listRiwayatPajak(2026);
    expect(r.map((i) => [i.jenis, i.nominal])).toEqual([['SETORAN', 40_000], ['PENGAKUAN', 100_000]]);
    expect(r[1].bisaDibatalkan).toBe(true);
    expect(r[0].bisaDibatalkan).toBe(false);
  });
});

// ===========================================================================
// Skema umum: PPh 25 & PPh Badan
// ===========================================================================

describe('RC-S84 — PPh 25 & PPh Badan (tarif umum)', () => {
  beforeEach(async () => {
    await simpanPengaturanPajak({ skema: 'UMUM', tahunTerdaftar: 2015, updatedBy: U });
  });

  it('angsuran PPh 25: Dr 1-1410 / Kr Kas, satu per masa', async () => {
    await catatAngsuranPph25({ masa: '2025-01', nominal: 150_000, jenisRekening: 'KAS', tanggal: '2025-02-10', ntpn: NTPN, createdBy: U });
    expect(await saldoKode('1-1410')).toBe(150_000);
    await expect(
      catatAngsuranPph25({ masa: '2025-01', nominal: 150_000, jenisRekening: 'KAS', tanggal: '2025-02-11', ntpn: '', createdBy: U })
    ).rejects.toThrow(/sudah dicatat/);
    expect(await saldoKode('1-1410')).toBe(150_000);
  });

  it('angsuran yang dibatalkan lewat History (koreksi kas) boleh dicatat ulang untuk masa yang sama', async () => {
    const a = await catatAngsuranPph25({ masa: '2025-03', nominal: 150_000, jenisRekening: 'KAS', tanggal: '2025-04-10', ntpn: '', createdBy: U });
    await koreksiTransaksiKasBank('KAS', a.id, U, 'nominal salah');
    expect(await saldoKode('1-1410')).toBe(0);
    const b = await catatAngsuranPph25({ masa: '2025-03', nominal: 175_000, jenisRekening: 'KAS', tanggal: '2025-04-11', ntpn: '', createdBy: U });
    expect(b.journalId).not.toBe(a.journalId);
    expect(await saldoKode('1-1410')).toBe(175_000);
    await expect(
      catatAngsuranPph25({ masa: '2025-03', nominal: 1, jenisRekening: 'KAS', tanggal: '2025-04-12', ntpn: '', createdBy: U })
    ).rejects.toThrow(/sudah dicatat/);
  });

  it('PPh Badan: kredit PPh 25 dikurangkan, kurang bayar ke 2-1905', async () => {
    await catatAngsuranPph25({ masa: '2025-01', nominal: 150_000, jenisRekening: 'KAS', tanggal: '2025-02-10', ntpn: '', createdBy: U });
    await catatAngsuranPph25({ masa: '2025-02', nominal: 150_000, jenisRekening: 'KAS', tanggal: '2025-03-10', ntpn: '', createdBy: U });
    const h = await catatPphBadan({ tahun: 2025, pphTerutang: 500_000, tanggal: '2025-12-31', createdBy: U });
    expect(h.kurangBayar).toBe(200_000);
    expect(await saldoKode('5-2200')).toBe(500_000);
    expect(await saldoKode('1-1410')).toBe(0);
    expect(await saldoKode('2-1905')).toBe(200_000);
    await expect(catatPphBadan({ tahun: 2025, pphTerutang: 500_000, tanggal: '2025-12-31', createdBy: U })).rejects.toThrow(/sudah dicatat/);
  });

  it('PPh Badan lebih bayar ditolak tanpa menulis jurnal', async () => {
    await catatAngsuranPph25({ masa: '2025-01', nominal: 600_000, jenisRekening: 'KAS', tanggal: '2025-02-10', ntpn: '', createdBy: U });
    const sebelum = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
    await expect(catatPphBadan({ tahun: 2025, pphTerutang: 500_000, tanggal: '2025-12-31', createdBy: U })).rejects.toThrow(/lebih bayar/);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n).toBe(sebelum);
  });

  it('skema final menolak PPh 25', async () => {
    await simpanPengaturanPajak({ skema: 'FINAL_UMKM', tahunTerdaftar: 2022, updatedBy: U });
    await expect(
      catatAngsuranPph25({ masa: '2026-01', nominal: 1, jenisRekening: 'KAS', tanggal: '2026-02-10', ntpn: '', createdBy: U })
    ).rejects.toThrow(/PPh Final/);
  });
});

// ===========================================================================
// Akun & batas perubahan
// ===========================================================================

describe('RC-S84 — batas perubahan', () => {
  it('pastikanAkunPajak idempoten dan tidak menimpa nama akun yang diubah admin', async () => {
    await pastikanAkunPajak(testDb as any);
    await testDb.runAsync(`UPDATE account SET nama = 'Utang PPh Final (UMKM)' WHERE kode = '2-1904'`);
    await pastikanAkunPajak(testDb as any);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM account WHERE kode IN ('1-1410','2-1904','2-1905')`);
    expect(n!.n).toBe(3);
    expect((await testDb.getFirstAsync<{ nama: string }>(`SELECT nama FROM account WHERE kode = '2-1904'`))!.nama).toBe('Utang PPh Final (UMKM)');
  });

  it('tanpa migrasi skema dan tanpa perubahan COA default', () => {
    expect(baca('src/database/schema.ts')).toMatch(/export const SCHEMA_VERSION = 81;/); // DIPERBARUI v81 (RC-S133.6.2: sidik import & koreksi_transaksi, aditif; migrasi milik RC-S133.6.2). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel /export const SCHEMA_VERSION = 78;/); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 — migrasi milik fitur bunga harian sukarela. DIPERBARUI v77 (Poin 5/6/10) — migrasi milik patch 19 poin, bukan fitur ini. // DIPERBARUI RC-S88: v73 milik RC-S88 (nilai wajar/revaluasi), bukan RC-S84. // DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal, aditif murni. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga (RC-S84 tidak menambah migrasi sendiri) TIDAK berubah.
    for (const a of AKUN_PAJAK_BARU) expect(DEFAULT_ACCOUNTS.some((d) => d.kode === a.kode)).toBe(false);
    expect(baca('src/database/db.ts')).not.toMatch(/RC-S84/);
  });

  it('kartu Pajak ada di grup Kewajiban dan semua rute Pajak terdaftar', () => {
    const menu = baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx');
    expect(menu).toMatch(/grup: 'KEWAJIBAN',\s*icon: 'calculator-outline',\s*title: 'Pajak',[\s\S]*?nav\.navigate\('PajakMenu'\)/);
    const nav = baca('src/navigation/RootNavigator.tsx');
    for (const r of ['PajakMenu', 'PengaturanPajak', 'PphFinalForm', 'AngsuranPph25Form', 'PphBadanForm', 'SetorPajakForm', 'RiwayatPajak']) {
      expect((nav.match(new RegExp(`<TransaksiStack\\.Screen name="${r}"`, 'g')) ?? []).length).toBe(1);
    }
  });

  it('layar Pajak tidak menulis ke database langsung dan tidak membuat warna hex baru', () => {
    for (const f of ['PajakMenuScreen', 'PengaturanPajakScreen', 'PphFinalFormScreen', 'AngsuranPph25FormScreen', 'PphBadanFormScreen', 'SetorPajakFormScreen', 'RiwayatPajakScreen', 'PajakUi']) {
      const s = baca(`src/screens/Pajak/${f}.tsx`);
      expect(s).not.toMatch(/getDb|runAsync|createJournal/);
      expect(s).not.toMatch(/'#[0-9A-Fa-f]{3,6}'/);
    }
  });
});
