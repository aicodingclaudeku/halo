/**
 * Modul "Penerimaan Penarikan Dana Investasi" (Tahap A):
 * UI di atas PelepasanInvestasiService existing + kueri baca-saja.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, accId, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual<typeof import('@/database/db')>('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { catatInvestasi, listInvestasi } from '@/services/InvestasiService';
import { lepaskanInvestasi, pratinjauPelepasanInvestasi, PelepasanInvestasiDitolakError } from '@/services/PelepasanInvestasiService';
import {
  getDetailPenarikanInvestasi,
  getNilaiInvestasiTampilan,
  listRiwayatPenarikanInvestasi,
} from '@/services/PenarikanInvestasiQuery';
import {
  dapatDitarik,
  JENIS_PENARIKAN,
  labelSelisih,
  pesanPenolakan,
  statusInvestasiUi,
  validasiFormPenarikan,
} from '@/utils/penarikanInvestasiUi';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

async function penyertaan(jumlah = 50_000_000) {
  return catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP Maju', jumlah, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: USER });
}

describe('alur end-to-end di atas service existing', () => {
  it('hanya investasi AKTIF yang ditawarkan; setelah penarikan status Selesai dan tidak dapat ditarik lagi', async () => {
    const inv = await penyertaan();
    let daftar = (await listInvestasi()).filter((i) => i.jenisInvestasi === 'KOPERASI_LAIN' && dapatDitarik(i.status));
    expect(daftar.map((i) => i.id)).toEqual([inv.id]);

    const input = { investasiId: inv.id, tanggalPelepasan: '2026-09-10', hasilPelepasan: 55_000_000, sumberDana: 'KAS' as const, keterangan: 'Pengembalian penyertaan', createdBy: USER };
    const p = await pratinjauPelepasanInvestasi(input);
    expect(p.nilaiTercatat).toBe(50_000_000);
    expect(p.selisih).toBe(5_000_000);
    expect(labelSelisih(p.jenisSelisih)).toBe('Keuntungan penarikan investasi');

    const r = await lepaskanInvestasi(input);
    // Jurnal yang diposting identik dengan pratinjau.
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`, r.journalId
    );
    expect(baris.map((b) => [b.account_id, b.debit, b.kredit]).sort()).toEqual(p.baris.map((b) => [b.accountId, b.debit, b.kredit]).sort());

    daftar = (await listInvestasi()).filter((i) => i.jenisInvestasi === 'KOPERASI_LAIN' && dapatDitarik(i.status));
    expect(daftar).toHaveLength(0);
    const setelah = (await listInvestasi()).find((i) => i.id === inv.id)!;
    expect(statusInvestasiUi(setelah.status).label).toBe('Selesai');

    // Duplikat / sudah selesai ditolak service.
    await expect(lepaskanInvestasi(input)).rejects.toBeInstanceOf(PelepasanInvestasiDitolakError);
    try {
      await lepaskanInvestasi(input);
    } catch (e) {
      expect(pesanPenolakan(e)).toBe('Investasi ini sudah ditarik seluruhnya. Penarikan kedua tidak diizinkan.');
    }
  });

  it('riwayat & detail baca-saja memuat nilai, rekening, jurnal, dan jejak audit', async () => {
    const inv = await penyertaan(40_000_000);
    const { journalId } = await lepaskanInvestasi({ investasiId: inv.id, tanggalPelepasan: '2026-09-10', hasilPelepasan: 38_000_000, sumberDana: 'KAS', createdBy: USER });

    const riwayat = await listRiwayatPenarikanInvestasi();
    expect(riwayat).toHaveLength(1);
    expect(riwayat[0]).toMatchObject({ journalId, investasiId: inv.id, danaDiterima: 38_000_000, statusJurnal: 'POSTED' });

    const d = (await getDetailPenarikanInvestasi(journalId))!;
    expect(d.nilaiTercatat).toBe(40_000_000);
    expect(d.labaRugi).toBe(-2_000_000);
    expect(d.rekening).toContain('1-1');
    const debit = d.baris.reduce((a, b) => a + b.debit, 0);
    const kredit = d.baris.reduce((a, b) => a + b.kredit, 0);
    expect(debit).toBe(kredit);
    expect(d.dicatatOleh).not.toBeUndefined();

    // Membaca tidak mengubah apa pun.
    const sebelum = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);
    await listRiwayatPenarikanInvestasi();
    await getDetailPenarikanInvestasi(journalId);
    const sesudah = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);
    expect(sesudah!.n).toBe(sebelum!.n);
  });

  it('nilai tampilan memakai fungsi nilai tercatat existing', async () => {
    const inv = await penyertaan(10_000_000);
    // DIPERBARUI RC-S88: nilai tercatat resmi kini juga memuat akumulasi penyesuaian nilai wajar (0 untuk non-properti).
    expect(await getNilaiInvestasiTampilan(inv.id)).toEqual({ nilaiAwal: 10_000_000, akumulasiPenyusutan: 0, akumulasiImpairment: 0, totalDitarik: 0, akumulasiPenyesuaianNilaiWajar: 0, nilaiTercatat: 10_000_000 });
  });

  it('detail jurnal non-penarikan tidak dibuka sebagai penarikan', async () => {
    const inv = await penyertaan();
    expect(await getDetailPenarikanInvestasi(inv.journalId!)).toBeNull();
    expect(accId('1-1100')).toBeTruthy();
  });
});

describe('validasi layar mencerminkan guard service', () => {
  const dasar = { tanggal: '2026-09-10', hariIni: '2026-09-17', tanggalPerolehan: '2026-02-01', danaDiterima: 1000 as number | '', sumberDana: 'KAS' as 'KAS' | 'BANK' | null, adaRekeningBank: false };
  it.each([
    [{ tanggal: '2026-13-40x' }, 'tanggal'],
    [{ tanggal: '2026-09-20' }, 'tanggal'],
    [{ tanggal: '2026-01-01' }, 'tanggal'],
    [{ danaDiterima: '' }, 'danaDiterima'],
    [{ danaDiterima: 10.5 }, 'danaDiterima'],
    [{ danaDiterima: -1 }, 'danaDiterima'],
    [{ sumberDana: null }, 'sumberDana'],
    [{ sumberDana: 'BANK' }, 'sumberDana'],
  ] as const)('%j -> galat %s', (ubah, field) => {
    expect(validasiFormPenarikan({ ...dasar, ...(ubah as object) })).toHaveProperty(field);
  });
  it('input sah tanpa galat; dana 0 tidak mewajibkan rekening (sama dengan service)', () => {
    expect(validasiFormPenarikan(dasar)).toEqual({});
    expect(validasiFormPenarikan({ ...dasar, danaDiterima: 0, sumberDana: null })).toEqual({});
  });
});

describe('kontrak layar (statis)', () => {
  const hub = baca('src/screens/Transaksi/PenarikanInvestasiScreen.tsx');
  const form = baca('src/screens/Transaksi/PenarikanInvestasiFormScreen.tsx');
  const detail = baca('src/screens/Transaksi/DetailPenarikanInvestasiScreen.tsx');
  const nav = baca('src/navigation/RootNavigator.tsx');
  const menu = baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx');

  it('tiga jenis kartu sesuai permintaan', () => {
    expect(JENIS_PENARIKAN.map((j) => j.judul)).toEqual(['Penyertaan pada Koperasi Lain', 'Penyertaan pada Usaha Lain', 'Deposito Berjangka']);
    expect(hub).toMatch(/JENIS_PENARIKAN\.map/);
    expect(hub).toMatch(/dapatDitarik\(i\.status\)/);
  });
  it('tinjau & posting memakai satu service (pratinjau == eksekusi); posting wajib konfirmasi', () => {
    // DIPERBARUI Tahap B: layar memakai PenarikanInvestasiService (sebagian/seluruhnya).
    expect(form).toMatch(/await pratinjauPenarikanInvestasi\(input\)/);
    expect(form).toMatch(/await catatPenarikanInvestasi\(input\)/);
    expect(form).toMatch(/if \(!input \|\| !setuju \|\| memposting\) return;/);
    expect(form).toMatch(/disabled=\{!setuju \|\| memposting\}/);
    expect(form).not.toMatch(/createJournal|INSERT INTO|UPDATE investasi/);
  });
  it('layar tidak menghitung laba/rugi atau nilai tercatat sendiri', () => {
    expect(form).toMatch(/pratinjau\.selisih/);
    expect(form).not.toMatch(/hasilPelepasan\s*-\s*|danaDiterima\s*-\s*nilai|nilaiTercatat\s*-\s*danaDiterima/);
  });
  it('detail transaksi baca-saja', () => {
    expect(detail).not.toMatch(/TouchableOpacity|reverseJournal|batalkan|onPress/);
  });
  it('rute terdaftar & menu Penerimaan', () => {
    for (const r of ['PenarikanInvestasi', 'PenarikanInvestasiForm', 'RiwayatPenarikanInvestasi', 'DetailPenarikanInvestasi']) {
      expect(nav).toMatch(new RegExp(`<TransaksiStack\\.Screen name="${r}"`));
    }
    expect(menu).toMatch(/title: 'Penarikan Dana Investasi'[\s\S]{0,200}nav\.navigate\('PenarikanInvestasi'\)/);
  });
});
