import * as fs from 'fs';
import * as path from 'path';
import { TestDb } from './testDb';

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

import { buatFixtureHistoris, ACC, ANGGOTA_ID, USER_ID, saldoGl, totalDebitKredit } from './historicalFixture';
import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  prosesAkrualBungaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  cairkanSimpananBerjangka,
  getRingkasanPencairan,
  PESAN_BELUM_JATUH_TEMPO,
} from '@/services/SimpananBerjangkaLifecycleService';
import {
  KEBIJAKAN_PENARIKAN_DINI_TERSEDIA,
  PESAN_PENARIKAN_DINI_TANPA_KEBIJAKAN,
  evaluasiKelayakanPencairan,
} from '@/accounting/SimpananBerjangkaKebijakanPencairan';
import { hitungTotalBungaKontrak } from '@/accounting/SimpananBerjangkaBunga';

/**
 * ============================================================
 * §K–§T — AUDIT PENARIKAN SEBELUM JATUH TEMPO (EARLY WITHDRAWAL)
 * ============================================================
 *
 * Suite ini TIDAK mengimplementasikan kebijakan apa pun. Ia MEMBUKTIKAN
 * bahwa kebijakannya memang tidak ada, bahwa aplikasi menolak alih-alih
 * mengarang, dan bahwa penolakannya tidak meninggalkan jejak akuntansi
 * separuh jalan. Lima dimensi §L diperiksa TERPISAH, tidak digabung
 * menjadi satu "penalty".
 */

const POKOK = 24_000_000;
const RATE = 6; // % per tahun
const TENOR = 6; // bulan (3/6/12 sesuai SimpananBerjangkaTenor.ts)
const TANGGAL_PLACEMENT = '2026-06-12';
const TANGGAL_JATUH_TEMPO = '2026-12-12';

async function snapshotBuku(db: TestDb) {
  return {
    jurnal: (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))!.n,
    entry: (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal_entry`))!.n,
    kontrak: await db.getAllAsync<Record<string, unknown>>(
      `SELECT id, status, nominal, suku_bunga, bunga_terakru, bunga_dibayar,
              tanggal_pencairan, journal_pencairan_id, idempotency_key_pencairan
       FROM simpanan_berjangka ORDER BY id`
    ),
    bungaEvent: (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM simpanan_berjangka_bunga`))!.n,
    kas: await saldoGl(db, ACC.kas),
    berjangka: await saldoGl(db, ACC.berjangka),
    utangBunga: await saldoGl(db, ACC.utangBungaBerjangka),
    beban: await saldoGl(db, ACC.bebanBungaBerjangka),
    periode: await db.getAllAsync<Record<string, unknown>>(
      `SELECT id, status FROM accounting_period ORDER BY id`
    ),
  };
}

async function buatKontrak(): Promise<string> {
  const hasil = await setorSimpananBerjangka({
    anggotaId: ANGGOTA_ID,
    nominal: POKOK,
    tanggal: TANGGAL_PLACEMENT,
    tenorBulan: TENOR,
    sukuBungaPerTahun: RATE,
    sumberDana: 'KAS',
    createdBy: USER_ID,
  });
  return hasil.id;
}

// ============================================================
// §K — POLICY DISCOVERY
// ============================================================
describe('§K — penemuan kebijakan penarikan dini', () => {
  it('konstanta kebijakan menyatakan TIDAK ADA kebijakan penarikan dini', () => {
    expect(KEBIJAKAN_PENARIKAN_DINI_TERSEDIA).toBe(false);
  });

  it('ATURAN_BISNIS.md menyatakan hal yang sama — dokumen & kode tidak berbeda pendapat', () => {
    const teks = fs.readFileSync(path.join(__dirname, '..', 'ATURAN_BISNIS.md'), 'utf8');
    expect(teks).toContain('Tidak ada kebijakan penarikan dini dan tidak ada penalti');
  });

  it('tidak ada akun/mapping penalti, forfeiture, atau biaya admin untuk simpanan berjangka', async () => {
    testDb = await buatFixtureHistoris();
    // Yang ada di COA HANYA tiga akun untuk domain ini: pokok (2-1210),
    // utang bunga (2-1710), beban bunga (5-1955).
    const mapping = await testDb.getAllAsync<{ transaction_type: string; role: string }>(
      `SELECT transaction_type, role FROM account_mapping
       WHERE transaction_type LIKE 'SIMPANAN_BERJANGKA%' ORDER BY transaction_type, role`
    );
    expect(mapping.map((m) => `${m.transaction_type}/${m.role}`)).toEqual([
      'SIMPANAN_BERJANGKA/KREDIT_DEFAULT',
      'SIMPANAN_BERJANGKA_BUNGA_AKRUAL/DEBIT_BEBAN',
      'SIMPANAN_BERJANGKA_BUNGA_AKRUAL/KREDIT_UTANG_BUNGA',
      'SIMPANAN_BERJANGKA_PENCAIRAN/DEBIT_POKOK',
      'SIMPANAN_BERJANGKA_PENCAIRAN/DEBIT_UTANG_BUNGA',
    ]);
    // Tidak ada satu pun role penalti/forfeiture/admin.
    expect(mapping.some((m) => /PENALTI|PENALTY|FORFEIT|ADMIN|DENDA/i.test(m.role))).toBe(false);
  });

  it('evaluasi kelayakan memisahkan tiga keadaan dengan tegas', () => {
    expect(evaluasiKelayakanPencairan('JATUH_TEMPO')).toBe('BOLEH_NORMAL');
    expect(evaluasiKelayakanPencairan('AKTIF')).toBe('DINI_TANPA_KEBIJAKAN');
    expect(evaluasiKelayakanPencairan('DICAIRKAN')).toBe('TIDAK_BERLAKU');
    expect(evaluasiKelayakanPencairan('DIBATALKAN')).toBe('TIDAK_BERLAKU');
  });
});

// ============================================================
// §L — LIMA DIMENSI, DIPERIKSA TERPISAH
// ============================================================
describe('§L — lima dimensi penarikan dini diperiksa satu per satu', () => {
  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
  });

  const kolomKontrak = async () =>
    (await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(simpanan_berjangka)`)).map((c) => c.name);

  it('1. FORFEITURE BUNGA — tidak ada policy, kolom, maupun jurnal', async () => {
    const kolom = await kolomKontrak();
    expect(kolom.some((k) => /forfeit|hangus|bunga_batal/i.test(k))).toBe(false);
    // Kolom bunga yang ADA hanya dua: terakru & dibayar.
    expect(kolom.filter((k) => k.startsWith('bunga_')).sort()).toEqual(['bunga_dibayar', 'bunga_terakru']);
  });

  it('2. BIAYA ADMIN — tidak ada policy, kolom, maupun akun pendapatan admin untuk simpanan', async () => {
    const kolom = await kolomKontrak();
    expect(kolom.some((k) => /admin|fee|biaya/i.test(k))).toBe(false);
  });

  it('3. PERUBAHAN RATE — kontrak hanya menyimpan SATU rate, tidak ada rate pencairan dini', async () => {
    const kolom = await kolomKontrak();
    // RC-S128: kolom snapshot kebijakan produk (policy_*) memuat rate PASCA
    // JATUH TEMPO — bukan rate pencairan dini. Invarian yang dijaga tetap:
    // tidak ada rate pencairan dini pada kontrak.
    expect(kolom.filter((k) => /suku_bunga|rate/i.test(k) && !k.startsWith('policy_'))).toEqual(['suku_bunga']);
    expect(kolom.some((k) => /dini/i.test(k))).toBe(false);
  });

  it('4. PERLAKUAN POKOK KHUSUS — tidak ada kolom potongan/penalti pokok', async () => {
    const kolom = await kolomKontrak();
    expect(kolom.some((k) => /penalti|penalty|potongan|pinalti/i.test(k))).toBe(false);
    expect(kolom).toContain('nominal'); // pokok tetap satu angka utuh
  });

  it('5. PERLAKUAN BUNGA KHUSUS — tidak ada jalur pembatalan bunga terakru', async () => {
    // Tabel event bunga hanya menyimpan pengakuan per periode; tidak ada
    // kolom/status pembatalan.
    const kolom = (
      await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(simpanan_berjangka_bunga)`)
    ).map((c) => c.name);
    expect(kolom.some((k) => /batal|reversal|forfeit/i.test(k))).toBe(false);
  });
});

// ============================================================
// §M–§Q + §R/§S/§T — PERILAKU RUNTIME
// ============================================================
describe('§M–§T — perilaku pencairan simpanan berjangka', () => {
  let kontrakId: string;

  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    kontrakId = await buatKontrak();
  });

  it('§M/§N/§O/§P/§Q — penarikan SEBELUM jatuh tempo DITOLAK; buku tidak berubah sedikit pun', async () => {
    // Akrual sebagian dulu supaya ada bunga terakru yang "menggoda"
    // untuk dipotong — justru di keadaan inilah kebijakan dibutuhkan.
    await prosesAkrualBungaKontrak(kontrakId, '2026-09-30', USER_ID);
    const sebelum = await snapshotBuku(testDb);
    expect(sebelum.utangBunga).toBeLessThan(0); // liabilitas bunga sudah ada (saldo kredit)

    await expect(
      cairkanSimpananBerjangka({
        kontrakId, tanggal: '2026-10-01', sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow(PESAN_BELUM_JATUH_TEMPO);

    const sesudah = await snapshotBuku(testDb);
    expect(sesudah).toEqual(sebelum); // POKOK, bunga, kas, GL, status: identik
  });

  it('§K/§L — ringkasan pencairan menjelaskan POLICY GAP, bukan menawarkan angka penalti', async () => {
    const ringkasan = await getRingkasanPencairan(kontrakId);
    expect(ringkasan.status).toBe('AKTIF');
    expect(ringkasan.alasanTidakBolehCair).toBe(PESAN_BELUM_JATUH_TEMPO);
    expect(ringkasan.catatanKebijakanPenarikanDini).toBe(PESAN_PENARIKAN_DINI_TANPA_KEBIJAKAN);
    // Tidak ada field penalti/admin fee/forfeiture yang diisi angka.
    expect(Object.keys(ringkasan).some((k) => /penalti|admin|forfeit/i.test(k))).toBe(false);
    expect(ringkasan.totalPencairan).toBe(ringkasan.pokok + ringkasan.bungaTerakru);
  });

  it('§Q — pencairan normal saat jatuh tempo: pokok penuh, bunga penuh, tidak ada liabilitas bunga tersisa', async () => {
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_JATUH_TEMPO, USER_ID);
    await prosesJatuhTempoSimpananBerjangka(TANGGAL_JATUH_TEMPO, USER_ID);
    const totalBunga = hitungTotalBungaKontrak(POKOK, RATE, TENOR);

    const hasil = await cairkanSimpananBerjangka({
      kontrakId, tanggal: TANGGAL_JATUH_TEMPO, sumberDana: 'KAS', createdBy: USER_ID,
    });

    expect(hasil.pokok).toBe(POKOK); // pokok TIDAK berkurang diam-diam
    // RC-S128 — bunga penuh tetap menjadi hak anggota, tetapi dikreditkan
    // ke Simpanan Sukarela di dalam pencairan; kas hanya membayar pokok.
    expect(hasil.bunga).toBe(0);
    expect(hasil.bungaDipindahkanSaatPencairan).toBe(totalBunga);
    expect(hasil.total).toBe(POKOK);
    // Liabilitas nol setelah dilunasi — tidak ada phantom liability.
    expect(await saldoGl(testDb, ACC.berjangka)).toBe(0);
    expect(await saldoGl(testDb, ACC.utangBungaBerjangka)).toBe(0);
    // Beban bunga diakui SATU KALI (saat akrual), bukan dua kali.
    expect(await saldoGl(testDb, ACC.bebanBungaBerjangka)).toBe(totalBunga);
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  it('§R — atomicity: kegagalan di tengah pencairan me-rollback SELURUHNYA', async () => {
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_JATUH_TEMPO, USER_ID);
    await prosesJatuhTempoSimpananBerjangka(TANGGAL_JATUH_TEMPO, USER_ID);
    const sebelum = await snapshotBuku(testDb);

    // Injeksi kegagalan SETELAH validasi & akrual, tepat pada saat
    // jurnal dibentuk: mapping akun pokok dihapus sehingga
    // `resolveAccountId` melempar di tengah transaksi.
    await testDb.runAsync(
      `DELETE FROM account_mapping WHERE transaction_type = 'SIMPANAN_BERJANGKA_PENCAIRAN' AND role = 'DEBIT_POKOK'`
    );
    await expect(
      cairkanSimpananBerjangka({
        kontrakId, tanggal: TANGGAL_JATUH_TEMPO, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow();

    const sesudah = await snapshotBuku(testDb);
    expect(sesudah.jurnal).toBe(sebelum.jurnal);
    expect(sesudah.entry).toBe(sebelum.entry);
    expect(sesudah.kontrak).toEqual(sebelum.kontrak); // status masih JATUH_TEMPO
    expect(sesudah.kas).toBe(sebelum.kas); // kas tidak bergerak
    expect(sesudah.berjangka).toBe(sebelum.berjangka);
    expect(sesudah.utangBunga).toBe(sebelum.utangBunga); // bunga tidak hilang tanpa jurnal
  });

  it('§S — idempotensi: event pencairan yang sama dijalankan dua kali hanya menghasilkan SATU payout', async () => {
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_JATUH_TEMPO, USER_ID);
    await prosesJatuhTempoSimpananBerjangka(TANGGAL_JATUH_TEMPO, USER_ID);

    const kunci = 'idem-cair-1';
    const pertama = await cairkanSimpananBerjangka({
      kontrakId, tanggal: TANGGAL_JATUH_TEMPO, sumberDana: 'KAS',
      idempotencyKey: kunci, createdBy: USER_ID,
    });
    const setelahSatu = await snapshotBuku(testDb);

    const kedua = await cairkanSimpananBerjangka({
      kontrakId, tanggal: TANGGAL_JATUH_TEMPO, sumberDana: 'KAS',
      idempotencyKey: kunci, createdBy: USER_ID,
    });

    expect(kedua.duplikat).toBe(true);
    expect(kedua.journalId).toBe(pertama.journalId);
    const setelahDua = await snapshotBuku(testDb);
    expect(setelahDua).toEqual(setelahSatu); // tidak ada jurnal, kas, atau bunga kedua
  });

  it('§T — periode TERTUTUP: pencairan bertanggal historis di periode CLOSED ditolak total', async () => {
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_JATUH_TEMPO, USER_ID);
    await prosesJatuhTempoSimpananBerjangka(TANGGAL_JATUH_TEMPO, USER_ID);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    const sebelum = await snapshotBuku(testDb);

    await expect(
      cairkanSimpananBerjangka({
        kontrakId, tanggal: TANGGAL_JATUH_TEMPO, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow();

    const sesudah = await snapshotBuku(testDb);
    expect(sesudah).toEqual(sebelum); // jurnal, entry, kontrak, bunga, kas, GL, periode identik
  });
});
