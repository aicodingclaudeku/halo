/**
 * Tahap B — penarikan sebagian/seluruhnya, bunga deposito satu transaksi,
 * jatuh tempo deposito, migrasi v72. Aturan (keputusan pengguna):
 *  - SEBAGIAN: nilai tercatat berkurang sebesar dana ditarik, tanpa untung/rugi.
 *  - SELURUHNYA: untung/rugi = dana diterima − sisa nilai tercatat.
 */
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

import { SCHEMA_VERSION } from '@/database/schema';
import { migrasiV72 } from '@/database/db';
import { catatInvestasi, batalkanInvestasi, getInvestasiDetail } from '@/services/InvestasiService';
import { getNilaiTercatatInvestasi, catatImpairmentInvestasi } from '@/services/InvestasiImpairmentService';
import { lepaskanInvestasi, PelepasanInvestasiDitolakError } from '@/services/PelepasanInvestasiService';
import {
  catatPenarikanInvestasi,
  getStatusPenarikanInvestasi,
  pratinjauPenarikanInvestasi,
  PenarikanInvestasiDitolakError,
  type PenarikanInvestasiInput,
} from '@/services/PenarikanInvestasiService';
import { getDetailPenarikanInvestasi, listRiwayatPenarikanInvestasi } from '@/services/PenarikanInvestasiQuery';
import { statusInvestasiUi } from '@/utils/penarikanInvestasiUi';

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

const saldoAkun = async (kode: string) =>
  (await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit - je.kredit), 0) s FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status = 'POSTED'`,
    accId(kode)
  ))!.s;

async function penyertaan(jumlah = 50_000_000) {
  return catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP Maju', jumlah, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: USER });
}
async function deposito(jumlah = 20_000_000, tanggalJatuhTempo?: string) {
  return catatInvestasi({ jenisInvestasi: 'DEPOSITO_BANK_UMUM', namaTujuan: 'Bank Sulselbar', jumlah, tanggal: '2026-03-01', sumberDana: 'KAS', nomorRekeningInvestasi: 'DEP-001', tanggalJatuhTempo, createdBy: USER });
}
const tarik = (o: Partial<PenarikanInvestasiInput> & { investasiId: string }): PenarikanInvestasiInput => ({
  tanggal: '2026-09-10', mode: 'SEBAGIAN', danaPokok: 0, sumberDana: 'KAS', createdBy: USER, ...o,
});

async function akunInvestasi(invId: string) {
  const inv = await getInvestasiDetail(invId);
  return (await testDb.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit > 0`, inv!.journalId))!.account_id;
}
const saldoAkunId = async (id: string) =>
  (await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit - je.kredit), 0) s FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE je.account_id = ? AND j.status='POSTED'`, id
  ))!.s;

describe('penarikan SEBAGIAN', () => {
  it('Dr Kas / Cr Investasi sebesar dana ditarik, tanpa untung/rugi; status Sebagian Ditarik', async () => {
    const inv = await penyertaan(50_000_000);
    const akun = await akunInvestasi(inv.id);
    const p = await pratinjauPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 20_000_000 }));
    const kasAwal = await saldoAkunId(p.rekeningAccountId!);
    expect(p).toMatchObject({ nilaiSebelum: 50_000_000, nilaiDikembalikan: 20_000_000, selisih: 0, nilaiSesudah: 30_000_000, statusSesudah: 'SEBAGIAN_DITARIK' });
    expect(p.barisPokok.map((b) => [b.debit, b.kredit])).toEqual([[20_000_000, 0], [0, 20_000_000]]);

    await catatPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 20_000_000 }));
    expect(await saldoAkunId(akun)).toBe(30_000_000);
    expect((await saldoAkunId(p.rekeningAccountId!)) - kasAwal).toBe(20_000_000);
    expect((await getNilaiTercatatInvestasi(testDb as never, inv.id)).nilaiTercatat).toBe(30_000_000);

    const st = await getStatusPenarikanInvestasi(inv.id);
    expect(st).toMatchObject({ totalDitarik: 20_000_000, jumlahPenarikan: 1, status: 'SEBAGIAN_DITARIK' });
    expect((await getInvestasiDetail(inv.id))!.status).toBe('AKTIF');
    expect(statusInvestasiUi('AKTIF', st.jumlahPenarikan).label).toBe('Sebagian Ditarik');
  });

  it('tidak boleh melebihi/menyamai saldo, nol, pecahan, atau tanggal sebelum penarikan terakhir', async () => {
    const inv = await penyertaan(10_000_000);
    const kode = async (i: PenarikanInvestasiInput) => {
      try {
        await pratinjauPenarikanInvestasi(i);
        return null;
      } catch (e) {
        return (e as PenarikanInvestasiDitolakError).kode;
      }
    };
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 10_000_000 }))).toBe('MELEBIHI_SALDO');
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 12_000_000 }))).toBe('MELEBIHI_SALDO');
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 0 }))).toBe('NOMINAL_TIDAK_VALID');
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 10.5 }))).toBe('NOMINAL_TIDAK_VALID');
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 1000, sumberDana: undefined }))).toBe('REKENING_WAJIB');
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 1000, tanggal: '2026-10-01' }))).toBe('TANGGAL_MASA_DEPAN');
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 1000, tanggal: '2026-01-01' }))).toBe('TANGGAL_SEBELUM_PEROLEHAN');
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 1000, bungaDeposito: 5 }))).toBe('BUNGA_HANYA_DEPOSITO');
    await catatPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 1000, tanggal: '2026-09-10' }));
    expect(await kode(tarik({ investasiId: inv.id, danaPokok: 1000, tanggal: '2026-09-01' }))).toBe('TANGGAL_SEBELUM_PENARIKAN_TERAKHIR');
  });

  it('kunci submit yang sama tidak membuat transaksi kedua', async () => {
    const inv = await penyertaan(10_000_000);
    const a = await catatPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 1_000_000, idempotencyKey: 'K1' }));
    const b = await catatPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 1_000_000, idempotencyKey: 'K1' }));
    expect(b.duplikat).toBe(true);
    expect(b.journalId).toBe(a.journalId);
    expect((await getStatusPenarikanInvestasi(inv.id)).jumlahPenarikan).toBe(1);
  });
});

describe('penarikan SELURUHNYA (terakhir)', () => {
  it('untung/rugi atas SISA nilai tercatat; akun investasi nol; status Selesai; tidak dapat ditarik lagi', async () => {
    const inv = await penyertaan(50_000_000);
    const akun = await akunInvestasi(inv.id);
    await catatPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 20_000_000, tanggal: '2026-06-01' }));

    const p = await pratinjauPenarikanInvestasi(tarik({ investasiId: inv.id, mode: 'SELURUHNYA', danaPokok: 32_000_000 }));
    expect(p).toMatchObject({ nilaiSebelum: 30_000_000, nilaiDikembalikan: 30_000_000, selisih: 2_000_000, jenisSelisih: 'LABA', nilaiSesudah: 0, statusSesudah: 'SELESAI' });
    const debit = p.barisPokok.reduce((a, b) => a + b.debit, 0);
    const kredit = p.barisPokok.reduce((a, b) => a + b.kredit, 0);
    expect(debit).toBe(kredit);

    await catatPenarikanInvestasi(tarik({ investasiId: inv.id, mode: 'SELURUHNYA', danaPokok: 32_000_000 }));
    expect(await saldoAkunId(akun)).toBe(0);
    expect((await getInvestasiDetail(inv.id))!.status).toBe('DILEPAS');
    expect((await getStatusPenarikanInvestasi(inv.id)).status).toBe('SELESAI');
    await expect(pratinjauPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 1 }))).rejects.toMatchObject({ kode: 'SUDAH_SELESAI' });
  });

  it('tanpa penarikan sebelumnya, jurnalnya identik dengan pelepasan existing', async () => {
    const a = await penyertaan(40_000_000);
    const b = await penyertaan(40_000_000);
    const pa = await pratinjauPenarikanInvestasi(tarik({ investasiId: a.id, mode: 'SELURUHNYA', danaPokok: 37_000_000 }));
    const { pratinjau: pb } = await lepaskanInvestasi({ investasiId: b.id, tanggalPelepasan: '2026-09-10', hasilPelepasan: 37_000_000, sumberDana: 'KAS', createdBy: USER });
    const bentuk = (xs: { accountId: string; debit: number; kredit: number }[]) => xs.map((x) => [x.accountId, x.debit, x.kredit]).sort();
    expect(bentuk(pa.barisPokok)).toEqual(bentuk(pb.baris));
  });

  it('dengan penurunan nilai: impairment ikut dihentikan, untung/rugi atas nilai tercatat sisa', async () => {
    const inv = await penyertaan(30_000_000);
    await catatPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 10_000_000, tanggal: '2026-04-01' }));
    await catatImpairmentInvestasi({ investasiId: inv.id, tanggal: '2026-05-01', indikasiTerpilih: ['Kesulitan keuangan signifikan pada unit usaha/koperasi tujuan investasi'], dasarPenilaian: 'LK', nilaiImpairment: 5_000_000, alasan: 'uji', createdBy: USER });
    const n = await getNilaiTercatatInvestasi(testDb as never, inv.id);
    // Batas impairment memakai nilai tercatat SESUDAH penarikan sebagian (20jt).
    expect(n).toMatchObject({ totalDitarik: 10_000_000, akumulasiImpairment: 5_000_000, nilaiTercatat: 15_000_000 });
    const p = await pratinjauPenarikanInvestasi(tarik({ investasiId: inv.id, mode: 'SELURUHNYA', danaPokok: 14_000_000 }));
    expect(p.nilaiSebelum).toBe(n.nilaiTercatat);
    expect(p.selisih).toBe(14_000_000 - n.nilaiTercatat);
    await catatPenarikanInvestasi(tarik({ investasiId: inv.id, mode: 'SELURUHNYA', danaPokok: 14_000_000 }));
    expect(await saldoAkunId(await akunInvestasi(inv.id))).toBe(0);
  });
});

describe('bunga deposito — satu transaksi DB', () => {
  it('pokok & bunga diposting atomik; bunga ke 4-1510 lewat jalur pendapatan existing', async () => {
    const dep = await deposito(20_000_000, '2026-09-01');
    expect((await getInvestasiDetail(dep.id))!.tanggalJatuhTempo).toBe('2026-09-01');
    const pendapatanAwal = await saldoAkun('4-1510');

    const p = await pratinjauPenarikanInvestasi(tarik({ investasiId: dep.id, mode: 'SELURUHNYA', danaPokok: 20_000_000, bungaDeposito: 450_000 }));
    expect(p.totalDiterima).toBe(20_450_000);
    expect(p.barisBunga.map((b) => [b.kode, b.debit, b.kredit])).toEqual([[expect.any(String), 450_000, 0], ['4-1510', 0, 450_000]]);

    const r = await catatPenarikanInvestasi(tarik({ investasiId: dep.id, mode: 'SELURUHNYA', danaPokok: 20_000_000, bungaDeposito: 450_000 }));
    expect(r.journalBungaId).toBeTruthy();
    expect(pendapatanAwal - (await saldoAkun('4-1510'))).toBe(450_000);
    // Bunga tercatat juga di riwayat pendapatan (baris kas_transaksi).
    const kas = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM kas_transaksi WHERE journal_id = ?`, r.journalBungaId);
    expect(kas!.n).toBe(1);

    const d = (await getDetailPenarikanInvestasi(r.journalId))!;
    expect(d).toMatchObject({ jenisPenarikan: 'SELURUHNYA', danaDiterima: 20_000_000, bungaDiterima: 450_000, totalDiterima: 20_450_000 });
    expect(d.barisBunga).toHaveLength(2);
  });

  it('gagal di tengah = tidak ada yang tersimpan (atomik)', async () => {
    const dep = await deposito(20_000_000);
    await testDb.runAsync(`UPDATE account SET is_active = 0 WHERE kode = '4-1510'`);
    const jurnalAwal = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n;
    await expect(
      catatPenarikanInvestasi(tarik({ investasiId: dep.id, mode: 'SELURUHNYA', danaPokok: 20_000_000, bungaDeposito: 1_000 }))
    ).rejects.toMatchObject({ kode: 'AKUN_BUNGA_TIDAK_TERSEDIA' });
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n).toBe(jurnalAwal);
    expect((await getInvestasiDetail(dep.id))!.status).toBe('AKTIF');
  });

  it('jatuh tempo divalidasi', async () => {
    await expect(deposito(1_000_000, '2026-02-01')).rejects.toThrow(/jatuh tempo tidak boleh sebelum/);
  });
});

describe('perlindungan jalur lama setelah penarikan sebagian', () => {
  it('pelepasan penuh existing & koreksi/pembatalan ditolak; riwayat mencatat semuanya', async () => {
    const inv = await penyertaan(10_000_000);
    await catatPenarikanInvestasi(tarik({ investasiId: inv.id, danaPokok: 1_000_000 }));
    await expect(
      lepaskanInvestasi({ investasiId: inv.id, tanggalPelepasan: '2026-09-11', hasilPelepasan: 9_000_000, sumberDana: 'KAS', createdBy: USER })
    ).rejects.toBeInstanceOf(PelepasanInvestasiDitolakError);
    await expect(batalkanInvestasi(inv.id, USER, 'uji')).rejects.toThrow(/ditarik sebagian/);

    const riwayat = await listRiwayatPenarikanInvestasi();
    expect(riwayat.map((r) => r.jenisPenarikan)).toEqual(['SEBAGIAN']);
    const audit = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM audit_log WHERE entity='investasi' AND entity_id=? AND action='WITHDRAW'`, inv.id);
    expect(audit!.n).toBe(1);
  });
});

describe('migrasi v72', () => {
  it('versi 72; aditif & idempoten', async () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    const tambah = async (t: string, k: string, tipe: string) => {
      try {
        await testDb.execAsync(`ALTER TABLE ${t} ADD COLUMN ${k} ${tipe};`);
      } catch {
        /* sudah ada */
      }
    };
    await migrasiV72(testDb as never, tambah);
    await migrasiV72(testDb as never, tambah);
    const kolom = await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(investasi)`);
    expect(kolom.some((c) => c.name === 'tanggal_jatuh_tempo')).toBe(true);
    const tabel = await testDb.getFirstAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='investasi_penarikan'`);
    expect(tabel?.name).toBe('investasi_penarikan');
  });
});

describe('kontrak layar Tahap B (statis)', () => {
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const path = jest.requireActual<typeof import('path')>('path');
  const baca = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const form = baca('screens/Transaksi/PenarikanInvestasiFormScreen.tsx');
  const invForm = baca('screens/Transaksi/InvestasiFormScreen.tsx');
  it('form: mode sebagian/seluruhnya, bunga deposito, jatuh tempo, kunci submit', () => {
    expect(form).toContain("'Tarik Sebagian'");
    expect(form).toContain("'Tarik Seluruhnya'");
    expect(form).toMatch(/deposito \? \(\s*<>\s*<Text[^>]*>Bunga deposito diterima<\/Text>/);
    expect(form).toContain("label=\"Jatuh tempo\"");
    expect(form).toMatch(/idempotencyKey: kunciSubmit\.current/);
    expect(form).toMatch(/TabelJurnal judul="Jurnal bunga deposito"/);
  });
  it('penempatan deposito: isian nomor deposito & jatuh tempo', () => {
    expect(invForm).toMatch(/isBankUmum && \(\s*<>[\s\S]{0,400}Nomor Deposito \(opsional\)/);
    expect(invForm).toMatch(/tanggalJatuhTempo: isBankUmum \? tanggalJatuhTempo \|\| undefined : undefined/);
  });
});
