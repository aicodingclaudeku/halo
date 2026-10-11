import { createTestDb, TestDb } from './testDb';
import { seedKebijakanProdukUji } from './kebijakanProdukBerjangkaUji';

/**
 * RC-S127 — BATAS Rp240.000 AGREGAT PER ANGGOTA PER BULAN, LINTAS PRODUK.
 *
 * Keputusan pengurus: batas diuji terhadap TOTAL bunga simpanan (Sukarela +
 * Berjangka) yang dibayarkan koperasi kepada satu anggota untuk satu bulan
 * masa. Bila total melewati batas, PPh 10% atas SELURUH bruto bulan itu —
 * termasuk bagian yang sebelumnya sudah dibayar dengan potongan 0%
 * (dipotong susulan pada peristiwa yang membuat total melewati batas).
 */
let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { reverseJournal } from '@/accounting/AccountingEngine';
import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  cairkanSimpananBerjangka,
  prosesAkrualBungaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  prosesTransferBungaKeSukarela,
} from '@/services/SimpananBerjangkaLifecycleService';
import { prosesAkrualBungaSukarela } from '@/services/BungaSukarelaService';
import { getSaldoSimpanan } from '@/services/SimpananService';
import { hitungPphBungaSimpanan, hitungPphBungaSimpananAgregat, KODE_UTANG_PPH_BUNGA_SIMPANAN } from '@/config/pajakPolicy';
import { getPosisiPphBungaBulananPadaDb, listBuktiPotongPphBungaSimpanan } from '@/services/PphPotongService';

// ---------------------------------------------------------------------------
// A. Rumus kebijakan (murni)
// ---------------------------------------------------------------------------
describe('RC-S127 §A — hitungPphBungaSimpananAgregat', () => {
  test('contoh pengurus: Sukarela 200rb + Berjangka 200rb = 400rb -> PPh 40rb atas seluruh bruto', () => {
    const p1 = hitungPphBungaSimpananAgregat({ brutoSudah: 0, pajakSudah: 0 }, 200_000);
    expect(p1).toBe(0);
    const p2 = hitungPphBungaSimpananAgregat({ brutoSudah: 200_000, pajakSudah: p1 }, 200_000);
    expect(p2).toBe(40_000); // susulan: 10% x 400.000, bukan 10% x 200.000
    expect(p1 + p2).toBe(hitungPphBungaSimpanan(400_000));
  });

  test('total tetap <= batas -> 0%; tepat batas -> 0%', () => {
    expect(hitungPphBungaSimpananAgregat({ brutoSudah: 120_000, pajakSudah: 0 }, 120_000)).toBe(0);
  });

  test('sudah di atas batas: peristiwa berikut cukup 10% dari bruto-nya sendiri (bulat ke bawah atas total)', () => {
    const pajakSudah = hitungPphBungaSimpanan(300_005); // 30.000
    expect(hitungPphBungaSimpananAgregat({ brutoSudah: 300_005, pajakSudah }, 100_005)).toBe(hitungPphBungaSimpanan(400_010) - pajakSudah);
  });

  test('koreksi turun yang membuat total kembali <= batas -> PPh negatif (pengembalian potongan)', () => {
    expect(hitungPphBungaSimpananAgregat({ brutoSudah: 260_000, pajakSudah: 26_000 }, -30_000)).toBe(-26_000);
  });

  test('menolak pecahan rupiah', () => {
    expect(() => hitungPphBungaSimpananAgregat({ brutoSudah: 0, pajakSudah: 0 }, 1.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// B. Integrasi: Sukarela + Berjangka pada anggota & bulan yang sama
// ---------------------------------------------------------------------------
const now = () => new Date().toISOString();

async function akun(id: string, kode: string, nama: string, kat: string, nb: string) {
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kat, nb, now(), now()
  );
}
async function map(tt: string, role: string, acc: string) {
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `m-${tt}-${role}`, tt, role, acc);
}

/** Saldo sukarela awal yang menghasilkan bunga Februari 2026 (28 hari, 10%) TEPAT Rp239.400. */
const SALDO_SUKARELA_239_400 = 31_207_500;

async function siapkan(saldoSukarela: number) {
  testDb = await createTestDb();
  await seedKebijakanProdukUji(testDb); // RC-S128: penempatan berjangka mewajibkan kebijakan produk
  await akun('acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT');
  await akun('acc-2-1210', '2-1210', 'Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await akun('acc-2-1200', '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');
  await akun('acc-2-1710', '2-1710', 'Utang Bunga Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await akun('acc-5-1955', '5-1955', 'Beban Bunga Simpanan Berjangka', 'BEBAN', 'DEBIT');
  await akun('acc-5-1956', '5-1956', 'Beban Bunga Simpanan Sukarela', 'BEBAN', 'DEBIT');
  await map('KAS_UMUM', 'DEFAULT', 'acc-kas');
  await map('SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', 'acc-2-1210');
  await map('SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', 'acc-2-1200');
  await map('SIMPANAN_SUKARELA_BUNGA', 'DEBIT_BEBAN', 'acc-5-1956');
  await map('SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN', 'acc-5-1955');
  await map('SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', 'acc-2-1710');
  await map('SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_POKOK', 'acc-2-1210');
  await map('SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_UTANG_BUNGA', 'acc-2-1710');
  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now(), now()
  );
  for (const [id, no] of [['ang-A', 'A001'], ['ang-B', 'A002']]) {
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES (?,?,?,?,'2020-01-01','AKTIF',?,?)`,
      id, no, `NIK-${no}`, `Anggota ${no}`, now(), now()
    );
  }
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('skr-awal','ang-A','SUKARELA','SETOR','2025-12-01',?,'KAS','N-1','user-1',?)`,
    saldoSukarela, now()
  );
  await testDb.runAsync(
    `INSERT INTO bunga_sukarela_kebijakan (id, berlaku_mulai, aktif, tarif_persen, created_by, created_at) VALUES ('kb','2026-02',1,10,'user-1',?)`,
    now()
  );
}

/** Kontrak mulai 15 Jan 2026 tenor 3: periode berakhir 15 Feb / 15 Mar / 15 Apr. */
async function kontrak(anggotaId: string, nominal: number, bunga: number): Promise<string> {
  return (await setorSimpananBerjangka({ anggotaId, nominal, tenorBulan: 3, sukuBungaPerTahun: bunga, tanggal: '2026-01-15', sumberDana: 'KAS', createdBy: 'user-1' })).id;
}

const bukti = () => listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
async function saldoUtangPph(): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit),0) s FROM journal_entry je JOIN account a ON a.id = je.account_id WHERE a.kode = ?`,
    KODE_UTANG_PPH_BUNGA_SIMPANAN
  );
  return r?.s ?? 0;
}
/** Invarian: total PPh satu anggota satu bulan = 10% x total bruto bulan itu (atau 0 bila <= batas). */
async function cekInvarianBulan(anggotaId: string, masa: string) {
  const pos = await getPosisiPphBungaBulananPadaDb(testDb as any, anggotaId, masa);
  expect(pos.pajakSudah).toBe(hitungPphBungaSimpanan(pos.brutoSudah));
  return pos;
}

describe('RC-S127 §B1 — Berjangka dulu (0%), Sukarela akhir bulan melewati batas -> susulan', () => {
  test('Berjangka 120rb (0%) + Sukarela ~140rb -> PPh 10% atas seluruh ~260rb, dipotong di akrual Sukarela', async () => {
    await siapkan(18_250_000); // bunga sukarela Feb ~140rb
    const id = await kontrak('ang-A', 12_000_000, 12); // 120.000 per periode
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    let b = await bukti();
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ produk: 'BERJANGKA', masaPajak: '2026-02', bruto: 120_000, pajak: 0 });

    const p = await prosesAkrualBungaSukarela('user-1', '2026-02');
    b = await bukti();
    const skr = b.find((x) => x.produk === 'SUKARELA')!;
    expect(skr.bruto).toBe(p.totalBruto);
    expect(120_000 + skr.bruto).toBeGreaterThan(240_000);
    expect(skr.pajak).toBe(Math.floor(((120_000 + skr.bruto) * 10) / 100)); // susulan atas 120rb ikut di sini
    expect(skr.netto).toBe(skr.bruto - skr.pajak);

    const pos = await cekInvarianBulan('ang-A', '2026-02');
    expect(pos.brutoSudah).toBe(120_000 + skr.bruto);
    expect(await saldoUtangPph()).toBe(pos.pajakSudah);
  });

  test('sebelum RC-S127 kasus ini kena 0% di kedua produk — sekarang tidak', async () => {
    await siapkan(18_250_000);
    const id = await kontrak('ang-A', 12_000_000, 12);
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    await prosesAkrualBungaSukarela('user-1', '2026-02');
    const skr = (await bukti()).find((x) => x.produk === 'SUKARELA')!;
    expect(hitungPphBungaSimpanan(skr.bruto)).toBe(0); // per-produk: bebas
    expect(skr.pajak).toBeGreaterThan(0); // agregat: kena
  });
});

describe('RC-S127 §B2 — Sukarela dulu (0%), Berjangka menyusul melewati batas', () => {
  test('susulan lebih besar dari bunga periode itu: neto negatif ditarik dari Sukarela, jurnal seimbang', async () => {
    await siapkan(SALDO_SUKARELA_239_400);
    const p = await prosesAkrualBungaSukarela('user-1', '2026-02');
    expect(p).toMatchObject({ totalBruto: 239_400, totalPajak: 0 });
    const saldoSesudahBunga = await getSaldoSimpanan(testDb as never, 'ang-A', 'SUKARELA');

    const id = await kontrak('ang-A', 200_000, 6); // 1.000 per periode
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const bj = (await bukti()).find((x) => x.produk === 'BERJANGKA')!;
    expect(bj).toMatchObject({ masaPajak: '2026-02', bruto: 1_000, pajak: 24_040, netto: -23_040 }); // 10% x 240.400
    expect(await getSaldoSimpanan(testDb as never, 'ang-A', 'SUKARELA')).toBe(saldoSesudahBunga - 23_040);

    const j = await testDb.getAllAsync<{ debit: number; kredit: number }>(`SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`, bj.journalId);
    expect(j.reduce((t, x) => t + x.debit, 0)).toBe(j.reduce((t, x) => t + x.kredit, 0));
    const trx = await testDb.getFirstAsync<{ tipe: string; nominal: number }>(`SELECT tipe, nominal FROM simpanan_transaksi WHERE journal_id = ?`, bj.journalId);
    expect(trx).toEqual({ tipe: 'TARIK', nominal: 23_040 });

    await cekInvarianBulan('ang-A', '2026-02');
    expect(await saldoUtangPph()).toBe(24_040);
  });

  test('transfer §B idempoten: dijalankan ulang tidak memotong lagi', async () => {
    await siapkan(SALDO_SUKARELA_239_400);
    await prosesAkrualBungaSukarela('user-1', '2026-02');
    const id = await kontrak('ang-A', 200_000, 6);
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    expect((await bukti()).filter((x) => x.produk === 'BERJANGKA')).toHaveLength(1);
    expect(await saldoUtangPph()).toBe(24_040);
  });
});

describe('RC-S127 §B3 — pencairan ikut agregat; bulan lain & anggota lain tidak tercampur', () => {
  test('pencairan: masa Feb digabung dengan bunga Sukarela Feb; masa Mar & Apr berdiri sendiri', async () => {
    await siapkan(SALDO_SUKARELA_239_400);
    await prosesAkrualBungaSukarela('user-1', '2026-02');
    const id = await kontrak('ang-A', 200_000, 6);
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');
    await prosesJatuhTempoSimpananBerjangka('2026-04-20', 'user-1');
    const h = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });

    // RC-S128 — bunga ketiga periode dipindahkan ke Simpanan Sukarela di
    // dalam pencairan (bukan tunai); agregasi PPh per masa tetap sama.
    expect(h.bunga).toBe(0);
    expect(h.bungaDipindahkanSaatPencairan).toBe(3_000);
    expect(h.totalDibayarBersih).toBe(200_000);
    const bj = (await bukti()).filter((x) => x.produk === 'BERJANGKA').sort((a, b) => a.masaPajak.localeCompare(b.masaPajak));
    expect(bj.map((x) => [x.masaPajak, x.pajak])).toEqual([
      ['2026-02', 24_040],
      ['2026-03', 0],
      ['2026-04', 0],
    ]);
    await cekInvarianBulan('ang-A', '2026-02');
  });

  test('anggota lain pada bulan yang sama tidak ikut dijumlah', async () => {
    await siapkan(SALDO_SUKARELA_239_400); // ang-A: 239.400
    const id = await kontrak('ang-B', 200_000, 6);
    await prosesAkrualBungaSukarela('user-1', '2026-02');
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    const b = await bukti();
    expect(b.every((x) => x.pajak === 0)).toBe(true);
    expect(await saldoUtangPph()).toBe(0);
  });
});

describe('RC-S127 §B4 — pembatalan peristiwa: posisi bulan hanya dari bukti potong yang berlaku', () => {
  test('transfer Berjangka dibatalkan lalu Sukarela diakru: hanya bunga Sukarela yang diuji', async () => {
    await siapkan(18_250_000); // ~140rb
    const id = await kontrak('ang-A', 12_000_000, 12);
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    const bj = (await bukti())[0];
    await testDb.withTransactionAsync(async () => {
      await reverseJournal(testDb as any, bj.journalId, 'user-1', 'uji pembatalan');
    });

    await prosesAkrualBungaSukarela('user-1', '2026-02');
    const skr = (await bukti()).find((x) => x.produk === 'SUKARELA')!;
    expect(skr.bruto).toBeLessThanOrEqual(240_000);
    expect(skr.pajak).toBe(0);
    await cekInvarianBulan('ang-A', '2026-02');
  });
});
