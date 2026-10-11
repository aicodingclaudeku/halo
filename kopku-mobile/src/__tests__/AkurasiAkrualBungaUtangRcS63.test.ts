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

import {
  prosesAkrualBungaUtangOtomatis,
  _resetGerbangAkrualUntukTest,
} from '@/services/UtangBungaAccrualService';
import {
  terimaUtang,
  bayarUtang,
  penyesuaianManualBungaUtang,
  getKontrolGapUtangBungaAsOf,
} from '@/services/UtangService';
import { reverseJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { jalankanGerbangAkrualBungaUtang } from '@/services/PeriodCloseService';
import { _resetTugasStartupUntukTest } from '@/services/StartupTasks';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * ============================================================
 * RC-S63 — AKURASI AKRUAL BUNGA UTANG & VALIDASI AKUNTANSI
 * ============================================================
 *
 * ATURAN §22 — EXPECTED DIHITUNG INDEPENDEN.
 * Tidak satu pun angka harapan di berkas ini berasal dari pemanggilan
 * fungsi produksi. Seluruhnya konstanta yang dihitung tangan dari
 * kontrak, dan diturunkan di komentar supaya dapat diperiksa ulang:
 *
 *   rate bulan = persen / 100, dan untuk basis TAHUNAN dibagi 12
 *   nominal    = dasar x rate bulan
 *
 *   100.000.000 x 1% BULANAN  -> 0,01        -> 1.000.000 / bulan
 *   120.000.000 x 12% TAHUNAN -> 0,12/12=0,01 -> 1.200.000 / bulan
 *   100.000.000 x 12% TAHUNAN -> 0,01         -> 1.000.000 / bulan
 *   200.000.000 x 2% BULANAN  -> 0,02         -> 4.000.000 / bulan
 *
 * Satuan: seluruh nominal RUPIAH BULAT (integer). `persen_bunga`
 * disimpan sebagai PERSEN (12 berarti 12%), bukan pecahan.
 */

const ACC = {
  kas: 'acc-kas',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
  modal: 'acc-3-1000',
};
const T0 = '2020-01-01T00:00:00.000Z';

async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: string) {
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, T0, T0
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

beforeEach(async () => {
  _resetGerbangAkrualUntukTest();
  _resetTugasStartupUntukTest();
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping('UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping('UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping('UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);
  for (const th of [2024, 2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    T0, T0
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES ('j-awal','JRN-SEED','2024-12-31','p2024','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    T0, T0, T0
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,900000000,0,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,900000000,1)`,
    ACC.modal
  );
});
afterEach(() => testDb.closeSync());

interface OpsiUtang {
  pokok: number;
  persen: number;
  jenis?: 'FLAT' | 'EFEKTIF' | 'LAINNYA';
  basis?: 'TAHUNAN' | 'BULANAN' | null;
  tanggal: string;
  nama?: string;
}
async function buatUtang(o: OpsiUtang): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: o.nama ?? 'Bank Uji',
    jenisPemberi: 'BANK',
    pokokPinjaman: o.pokok,
    persenBunga: o.persen,
    jenisBunga: (o.jenis ?? 'FLAT') as any,
    basisBunga: (o.basis === undefined ? 'BULANAN' : o.basis) as any,
    tanggal: o.tanggal,
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return r.id;
}

/** Utang yang jalur service-nya menolak (basis NULL / LAINNYA) disisipkan langsung. */
async function sisipkanUtangMentah(id: string, o: {
  pokok: number; persen: number; jenis: string; basis: string | null; tanggal: string; nomor: string;
}) {
  await testDb.runAsync(
    `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga,
                        jenis_bunga, basis_bunga, tanggal, sumber_dana, sumber, status, created_by, created_at, updated_at)
     VALUES (?,?,?,'BANK',?,?,?,?,?,'KAS','LANGSUNG','AKTIF','user-1',?,?)`,
    id, o.nomor, `Pemberi ${o.nomor}`, o.pokok, o.persen, o.jenis, o.basis, o.tanggal, T0, T0
  );
}

const proses = (tanggalSekarang: string) =>
  prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang });

async function subledger(utangId: string) {
  return testDb.getAllAsync<{ periode: string; tipe_akrual: string; nominal_target: number; nominal_dibukukan: number; journal_id: string | null; dasar_perhitungan: number }>(
    `SELECT periode, tipe_akrual, nominal_target, nominal_dibukukan, journal_id, dasar_perhitungan
       FROM utang_bunga_akrual WHERE utang_id = ? ORDER BY periode`,
    utangId
  );
}
async function jurnalAkrual(utangId: string) {
  return testDb.getAllAsync<{ id: string; tanggal: string; status: string; sumber_transaksi: string; sumber_id: string }>(
    `SELECT id, tanggal, status, sumber_transaksi, sumber_id FROM journal
      WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND reversal_of_id IS NULL ORDER BY tanggal`,
    utangId
  );
}
const saldo = (acc: string, asOf?: string) => getAccountBalance(testDb as any, acc, asOf);

// ============================================================
describe('RC-S63 §2/§3/§6 — basis bunga, jenis bunga, nominal', () => {
  it('A. 100.000.000 x 1% BULANAN -> 1.000.000 per bulan', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-03-31');
    const sl = await subledger(u);
    // Jan, Feb, Mar = 3 periode penuh. 100.000.000 x 0,01 = 1.000.000.
    expect(sl.map((r) => r.periode)).toEqual(['2026-01', '2026-02', '2026-03']);
    for (const r of sl) {
      expect(r.nominal_target).toBe(1_000_000);
      expect(r.dasar_perhitungan).toBe(100_000_000);
    }
    expect(await saldo(ACC.bebanBunga)).toBe(3_000_000);
  });

  it('B. 120.000.000 x 12% TAHUNAN -> 1.200.000 per bulan (rate /12)', async () => {
    const u = await buatUtang({ pokok: 120_000_000, persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await proses('2026-02-28');
    const sl = await subledger(u);
    // 0,12 / 12 = 0,01 -> 120.000.000 x 0,01 = 1.200.000.
    expect(sl.map((r) => r.nominal_target)).toEqual([1_200_000, 1_200_000]);
    expect(await saldo(ACC.bebanBunga)).toBe(2_400_000);
  });

  it('B2. 100.000.000 x 12% TAHUNAN -> 1.000.000 per bulan (angka spesifikasi §2)', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    await proses('2026-01-31');
    expect((await subledger(u))[0].nominal_target).toBe(1_000_000);
  });

  it('C. FLAT multi-periode: dasar tetap pokok kontraktual meski pokok dibayar', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, jenis: 'FLAT', basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-01-31');
    await bayarUtang({ utangId: u, tanggal: '2026-01-20', pokok: 20_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });
    await proses('2026-03-31');
    const sl = await subledger(u);
    // FLAT: dasar = 100.000.000 pada SEMUA periode. 3 x 1.000.000.
    expect(sl.map((r) => r.dasar_perhitungan)).toEqual([100_000_000, 100_000_000, 100_000_000]);
    expect(sl.map((r) => r.nominal_target)).toEqual([1_000_000, 1_000_000, 1_000_000]);
  });

  it('D/§7. EFEKTIF multi-periode: pokok dibayar mengurangi dasar periode BERIKUTNYA, sekali saja', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, jenis: 'EFEKTIF', basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-01-31');
    await bayarUtang({ utangId: u, tanggal: '2026-01-20', pokok: 20_000_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' });
    await proses('2026-03-31');
    const sl = await subledger(u);
    // Jan: dasar 100.000.000 (bayar 20/01 ada DI TENGAH periode, tidak memotong periode berjalan) -> 1.000.000
    // Feb: dasar 80.000.000 -> 800.000
    // Mar: dasar 80.000.000 -> 800.000 (pokok tidak dikurangi dua kali)
    expect(sl.map((r) => r.dasar_perhitungan)).toEqual([100_000_000, 80_000_000, 80_000_000]);
    expect(sl.map((r) => r.nominal_target)).toEqual([1_000_000, 800_000, 800_000]);
    expect(await saldo(ACC.bebanBunga)).toBe(2_600_000);
  });

  it('E. rate nol -> tidak ada akrual', async () => {
    await sisipkanUtangMentah('u-zero', { pokok: 100_000_000, persen: 0, jenis: 'FLAT', basis: 'BULANAN', tanggal: '2026-01-01', nomor: 'UTG-ZERO' });
    await proses('2026-03-31');
    expect(await subledger('u-zero')).toHaveLength(0);
    expect(await saldo(ACC.bebanBunga)).toBe(0);
  });

  it('F. basis bunga NULL -> MANUAL_REVIEW_REQUIRED, tanpa akrual', async () => {
    await sisipkanUtangMentah('u-null', { pokok: 100_000_000, persen: 12, jenis: 'FLAT', basis: null, tanggal: '2026-01-01', nomor: 'UTG-NULL' });
    const h = await proses('2026-03-31');
    expect(await subledger('u-null')).toHaveLength(0);
    expect(h.exception.some((e) => e.utangId === 'u-null' && e.kode === 'BASIS_BUNGA_BELUM_DITENTUKAN')).toBe(true);
  });

  it('G. jenis LAINNYA -> MANUAL_REVIEW_REQUIRED, formula tidak dikarang', async () => {
    await sisipkanUtangMentah('u-lain', { pokok: 100_000_000, persen: 12, jenis: 'LAINNYA', basis: 'BULANAN', tanggal: '2026-01-01', nomor: 'UTG-LAIN' });
    const h = await proses('2026-03-31');
    expect(await subledger('u-lain')).toHaveLength(0);
    expect(h.exception.some((e) => e.utangId === 'u-lain' && e.kode === 'JENIS_BUNGA_LAINNYA')).toBe(true);
  });
});

// ============================================================
describe('RC-S63 §4/§5 — WHOLE_MONTH POST-AT-END & catch-up', () => {
  it('§4. 19 Sep belum, 30 Sep boleh, 1 Okt tetap satu kali', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-09-01' });
    await proses('2026-09-19');
    expect((await subledger(u)).map((r) => r.periode)).toEqual([]);
    await proses('2026-09-30');
    expect((await subledger(u)).map((r) => r.periode)).toEqual(['2026-09']);
    await proses('2026-10-01');
    expect((await subledger(u)).map((r) => r.periode)).toEqual(['2026-09']);
    expect(await jurnalAkrual(u)).toHaveLength(1);
  });

  it('§4. utang mulai 2026-09-15 -> September TIDAK diprorata, periode pertama Oktober', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-09-15' });
    await proses('2026-09-30');
    expect(await subledger(u)).toHaveLength(0);
    await proses('2026-10-31');
    const sl = await subledger(u);
    expect(sl.map((r) => r.periode)).toEqual(['2026-10']);
    expect(sl[0].nominal_target).toBe(1_000_000); // bulan penuh, bukan 16/30 hari
  });

  it('§5. catch-up dari 2026-05-01 diproses 2026-09-19 -> Mei..Agustus, September tidak', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-05-01' });
    await proses('2026-09-19');
    expect((await subledger(u)).map((r) => r.periode)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
    expect(await saldo(ACC.bebanBunga)).toBe(4_000_000);
  });
});

// ============================================================
describe('RC-S63 §8/§9/§10/§11 — pembayaran, reversal, penyesuaian', () => {
  it('§8. full payment: beban 1.000.000, utang bunga 0 (bukan 2.000.000)', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-01-31');
    await bayarUtang({ utangId: u, tanggal: '2026-02-05', pokok: 0, bunga: 1_000_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.bebanBunga)).toBe(1_000_000);
    expect(await saldo(ACC.utangBunga)).toBe(0);
  });

  it('§8. partial payment: beban 1.000.000, utang bunga 600.000', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-01-31');
    await bayarUtang({ utangId: u, tanggal: '2026-02-05', pokok: 0, bunga: 400_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.bebanBunga)).toBe(1_000_000);
    expect(await saldo(ACC.utangBunga)).toBe(600_000);
  });

  it('§9. direct payment tanpa akrual: Dr Beban, Cr Kas, Utang Bunga 0 dan tanpa double expense', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    const kasAwal = await saldo(ACC.kas);
    await bayarUtang({ utangId: u, tanggal: '2026-01-10', pokok: 0, bunga: 1_000_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.bebanBunga)).toBe(1_000_000);
    expect(await saldo(ACC.utangBunga)).toBe(0);
    expect(await saldo(ACC.kas)).toBe(kasAwal - 1_000_000);
    // Mesin dijalankan SESUDAHNYA untuk periode yang sama.
    await proses('2026-01-31');
    expect(await saldo(ACC.bebanBunga)).toBe(1_000_000);
  });

  it('§10. reversal: net beban 0, utang bunga 0, tidak repost otomatis', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-01-31');
    const j = (await jurnalAkrual(u))[0];
    await reverseJournal(testDb as any, j.id, 'user-1', 'Koreksi');
    expect(await saldo(ACC.bebanBunga)).toBe(0);
    expect(await saldo(ACC.utangBunga)).toBe(0);
    // Dijalankan ulang berkali-kali: tidak boleh memposting ulang.
    // RC-S56 mewajibkan periode yang akrualnya DIREVERSAL dilaporkan sebagai
    // EXCEPTION eksplisit, bukan didiamkan dan bukan dibukukan ulang.
    //
    // Assertion ini ditambahkan setelah mutation test §23 nomor 6: dua mutasi
    // berbeda pada guard DIREVERSAL (mengubah label hasil, dan mem-bypass
    // guard sepenuhnya) TIDAK terdeteksi oleh assertion saldo/jumlah baris
    // saja, karena kunci idempotensi (utang+periode) sudah menahan posting
    // kedua. Guard itu lapis kedua, jadi ia butuh assertion sendiri.
    const hasilUlang = await proses('2026-02-28');
    expect(
      hasilUlang.exception.some((e) => e.utangId === u && e.periode === '2026-01' && e.kode === 'AKRUAL_DIREVERSAL')
    ).toBe(true);
    expect(hasilUlang.periodeDiproses.some((h) => h.utangId === u && h.periode === '2026-01' && h.hasil === 'DIBUKUKAN')).toBe(false);
    await proses('2026-02-28');
    const jan = (await subledger(u)).filter((r) => r.periode === '2026-01');
    expect(jan).toHaveLength(1);
    const jurnalJan = await testDb.getAllAsync(
      `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND tanggal LIKE '2026-01%' AND reversal_of_id IS NULL`,
      u
    );
    expect(jurnalJan).toHaveLength(1);
  });

  it('§11. AUTO 1.000.000 + penyesuaian +200.000 -> beban 1.200.000, bukan 2.200.000', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-01-31');
    await penyesuaianManualBungaUtang({
      utangId: u,
      tanggal: '2026-01-31',
      nominalTarget: 1_200_000,
      createdBy: 'user-1',
      alasan: 'Tagihan bank 1.200.000',
    });
    expect(await saldo(ACC.bebanBunga)).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga)).toBe(1_200_000);
  });

  it('§11. AUTO -> REVERSAL -> ADJUSTMENT -> PAYMENT', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-01-31');
    const j = (await jurnalAkrual(u))[0];
    await reverseJournal(testDb as any, j.id, 'user-1', 'Koreksi');
    await penyesuaianManualBungaUtang({
      utangId: u, tanggal: '2026-01-31', nominalTarget: 1_200_000, createdBy: 'user-1', alasan: 'Tagihan resmi',
    });
    expect(await saldo(ACC.bebanBunga)).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga)).toBe(1_200_000);
    await bayarUtang({ utangId: u, tanggal: '2026-02-10', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.bebanBunga)).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga)).toBe(0);
  });
});

// ============================================================
describe('RC-S63 §12 — cross-period', () => {
  it('akrual 2025-12-31 + pembayaran 2026-01-15', async () => {
    const u = await buatUtang({ pokok: 120_000_000, persen: 12, basis: 'TAHUNAN', tanggal: '2025-12-01' });
    await proses('2025-12-31');
    await bayarUtang({ utangId: u, tanggal: '2026-01-15', pokok: 0, bunga: 1_200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.utangBunga, '2025-12-31')).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga, '2026-01-31')).toBe(0);
    const k2025 = await getKontrolGapUtangBungaAsOf('2025-12-31', testDb as any);
    expect(k2025.expected).toBe(1_200_000);
    expect(k2025.actual).toBe(1_200_000);
    expect(k2025.gap).toBe(0);
    const k2026 = await getKontrolGapUtangBungaAsOf('2026-01-31', testDb as any);
    expect(k2026.expected).toBe(0);
    expect(k2026.gap).toBe(0);
  });

  it('akrual 2025-12-31 + reversal bertanggal 2026-02-10', async () => {
    const u = await buatUtang({ pokok: 120_000_000, persen: 12, basis: 'TAHUNAN', tanggal: '2025-12-01' });
    await proses('2025-12-31');
    const j = (await jurnalAkrual(u))[0];
    const r = await reverseJournal(testDb as any, j.id, 'user-1', 'Koreksi');
    await testDb.runAsync(`UPDATE journal SET tanggal = ? WHERE id = ?`, '2026-02-10', r.journalId);
    // Posisi historis 2025 TIDAK berubah oleh reversal 2026.
    expect(await saldo(ACC.utangBunga, '2025-12-31')).toBe(1_200_000);
    expect(await saldo(ACC.bebanBunga, '2025-12-31')).toBe(1_200_000);
    expect(await saldo(ACC.utangBunga, '2026-02-28')).toBe(0);
    expect((await getKontrolGapUtangBungaAsOf('2025-12-31', testDb as any)).gap).toBe(0);
  });
});

// ============================================================
describe('RC-S63 §13/§14/§18 — jurnal, rekonsiliasi 4 lapis, laporan', () => {
  it('jurnal akrual: Dr Beban / Cr Utang Bunga, kas & bank tidak berubah, source benar', async () => {
    const kasAwal = await saldo(ACC.kas);
    const u = await buatUtang({ pokok: 120_000_000, persen: 12, basis: 'TAHUNAN', tanggal: '2026-01-01' });
    const kasSetelahTerima = await saldo(ACC.kas);
    await proses('2026-02-28');

    const jurnal = await jurnalAkrual(u);
    expect(jurnal).toHaveLength(2);
    for (const j of jurnal) {
      expect(j.sumber_transaksi).toBe('UTANG_BUNGA');
      expect(j.sumber_id).toBe(u);
      const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
        `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
        j.id
      );
      const totalDebit = baris.reduce((t, b) => t + b.debit, 0);
      const totalKredit = baris.reduce((t, b) => t + b.kredit, 0);
      expect(totalDebit).toBe(totalKredit);            // §21-A
      expect(totalDebit).toBe(1_200_000);
      expect(baris.find((b) => b.account_id === ACC.bebanBunga)!.debit).toBe(1_200_000);
      expect(baris.find((b) => b.account_id === ACC.utangBunga)!.kredit).toBe(1_200_000);
      // §21-B: akrual tidak menyentuh kas/bank sama sekali.
      expect(baris.some((b) => b.account_id === ACC.kas)).toBe(false);
    }
    expect(await saldo(ACC.kas)).toBe(kasSetelahTerima);
    expect(kasSetelahTerima).toBe(kasAwal + 120_000_000); // hanya dari penerimaan utang
  });

  it('rekonsiliasi 4 lapis: expected = subledger = jurnal = GL', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-03-31');

    const expectedHitungTangan = 3 * 1_000_000; // 3 bulan x 100.000.000 x 0,01

    const sl = await subledger(u);
    const lapisSubledger = sl.reduce((t, r) => t + r.nominal_target, 0);

    const lapisJurnal = (await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.kredit - je.debit),0) total
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND j.sumber_transaksi='UTANG_BUNGA' AND j.sumber_id = ?
          AND j.status IN ('POSTED','REVERSED')`,
      ACC.utangBunga, u
    ))!.total;

    const lapisGL = await saldo(ACC.utangBunga);

    expect(lapisSubledger).toBe(expectedHitungTangan);
    expect(lapisJurnal).toBe(expectedHitungTangan);
    expect(lapisGL).toBe(expectedHitungTangan);
    expect(lapisGL - lapisSubledger).toBe(0);
    expect(lapisJurnal - lapisSubledger).toBe(0);
    // Beban bunga masuk periode yang benar (kumulatif s/d akhir Maret).
    expect(await saldo(ACC.bebanBunga, '2026-03-31')).toBe(expectedHitungTangan);
    expect(await saldo(ACC.bebanBunga, '2026-01-31')).toBe(1_000_000);
    // Setiap baris subledger menunjuk jurnal yang benar-benar ada (§20).
    for (const r of sl) {
      expect(r.journal_id).toBeTruthy();
      const ada = await testDb.getFirstAsync(`SELECT id FROM journal WHERE id = ?`, r.journal_id);
      expect(ada).toBeTruthy();
    }
  });
});

// ============================================================
describe('RC-S63 §15/§16/§21 — multi utang, idempotensi, invarian', () => {
  it('§15. tiga utang berbeda tidak saling mencemari', async () => {
    const a = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01', nama: 'Bank A' });
    const b = await buatUtang({ pokok: 200_000_000, persen: 2, basis: 'BULANAN', tanggal: '2026-01-01', nama: 'Bank B' });
    await sisipkanUtangMentah('u-c', { pokok: 150_000_000, persen: 5, jenis: 'FLAT', basis: null, tanggal: '2026-01-01', nomor: 'UTG-C' });

    const h = await proses('2026-01-31');
    expect((await subledger(a))[0].nominal_target).toBe(1_000_000); // 100jt x 0,01
    expect((await subledger(b))[0].nominal_target).toBe(4_000_000); // 200jt x 0,02
    expect(await subledger('u-c')).toHaveLength(0);
    expect(h.exception.some((e) => e.utangId === 'u-c' && e.kode === 'BASIS_BUNGA_BELUM_DITENTUKAN')).toBe(true);
    expect(await saldo(ACC.bebanBunga)).toBe(5_000_000);
  });

  it('§16. 1x, 5x, 10x, dan konkuren -> tepat satu akrual per utang/periode/tipe', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-02-28');
    const setelahSatu = await subledger(u);
    expect(setelahSatu).toHaveLength(2);

    for (let i = 0; i < 5; i++) await proses('2026-02-28');
    for (let i = 0; i < 10; i++) await proses('2026-02-28');
    await Promise.allSettled(Array.from({ length: 10 }, () => proses('2026-02-28')));

    const akhir = await subledger(u);
    expect(akhir).toHaveLength(2);
    expect(akhir.map((r) => r.periode)).toEqual(['2026-01', '2026-02']);
    expect(akhir.map((r) => r.nominal_target)).toEqual([1_000_000, 1_000_000]);
    expect(akhir.map((r) => r.tipe_akrual)).toEqual(['BUNGA_BULANAN', 'BUNGA_BULANAN']);
    expect(akhir.map((r) => r.journal_id)).toEqual(setelahSatu.map((r) => r.journal_id));
    expect(await jurnalAkrual(u)).toHaveLength(2);
    expect(await saldo(ACC.bebanBunga)).toBe(2_000_000);
    expect(await saldo(ACC.utangBunga)).toBe(2_000_000);

    // Kunci idempotensi unik per utang+periode.
    const kunci = await testDb.getAllAsync<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM utang_bunga_akrual WHERE utang_id = ?`, u
    );
    expect(new Set(kunci.map((k) => k.idempotency_key)).size).toBe(2);
  });

  it('§20. tidak ada subledger yatim & tidak ada jurnal akrual tanpa subledger', async () => {
    await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01', nama: 'Bank A' });
    await buatUtang({ pokok: 200_000_000, persen: 2, basis: 'BULANAN', tanggal: '2026-01-01', nama: 'Bank B' });
    await proses('2026-03-31');

    const yatimSubledger = await testDb.getAllAsync(
      `SELECT a.id FROM utang_bunga_akrual a
         LEFT JOIN journal j ON j.id = a.journal_id
        WHERE a.nominal_dibukukan <> 0 AND (a.journal_id IS NULL OR j.id IS NULL)`
    );
    expect(yatimSubledger).toHaveLength(0);

    const yatimJurnal = await testDb.getAllAsync(
      `SELECT j.id FROM journal j
        WHERE j.sumber_transaksi='UTANG_BUNGA' AND j.reversal_of_id IS NULL
          AND j.id NOT IN (SELECT journal_id FROM utang_bunga_akrual WHERE journal_id IS NOT NULL)`
    );
    expect(yatimJurnal).toHaveLength(0);

    const sumberValid = await testDb.getAllAsync(
      `SELECT j.id FROM journal j
        WHERE j.sumber_transaksi='UTANG_BUNGA'
          AND (j.sumber_id IS NULL OR j.sumber_id NOT IN (SELECT id FROM utang))`
    );
    expect(sumberValid).toHaveLength(0);
  });

  it('§21-E. periode masa depan tidak pernah diposting', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-03-15');
    const periode = (await subledger(u)).map((r) => r.periode);
    expect(periode).toEqual(['2026-01', '2026-02']);
    expect(periode.some((p) => p >= '2026-03')).toBe(false);
  });
});

// ============================================================
describe('RC-S63 §17/§19 — periode tertutup & PeriodClose', () => {
  it('§17. periode CLOSED tidak diposting otomatis', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);
    const h = await proses('2026-03-31');
    expect(await subledger(u)).toHaveLength(0);
    expect(await saldo(ACC.bebanBunga)).toBe(0);
    expect(h.jumlahJurnalBaru).toBe(0);
  });

  it('§19. GAP 2026 tidak memblokir penutupan 2025; GAP 2025 memblokirnya', async () => {
    const u = await buatUtang({ pokok: 120_000_000, persen: 12, basis: 'TAHUNAN', tanggal: '2025-12-01' });
    await proses('2025-12-31');

    // GAP hanya di 2026: mutasi 2-1700 tanpa atribusi, bertanggal 2026.
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
       VALUES ('j-gap26','GAP-2026','2026-03-01','p2026','KAS_UMUM','Gap 2026','POSTED','user-1',?,?,?)`,
      T0, T0, T0
    );
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('g1','j-gap26',?,300000,0,0)`, ACC.utangBunga);
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('g2','j-gap26',?,0,300000,1)`, ACC.kas);

    const kontrol2025 = await getKontrolGapUtangBungaAsOf('2025-12-31', testDb as any);
    expect(kontrol2025.status).toBe('BALANCED');
    expect(kontrol2025.gap).toBe(0);
    const kontrol2026 = await getKontrolGapUtangBungaAsOf('2026-12-31', testDb as any);
    expect(kontrol2026.status).toBe('GAP');

    // Kebalikannya: GAP bertanggal 2025 HARUS terlihat pada as-of 2025.
    await testDb.runAsync(`UPDATE journal SET tanggal='2025-06-01', period_id='p2025' WHERE id='j-gap26'`);
    const kontrol2025b = await getKontrolGapUtangBungaAsOf('2025-12-31', testDb as any);
    expect(kontrol2025b.status).toBe('GAP');
    expect(kontrol2025b.temuan.some((t) => t.kode === 'JURNAL_TANPA_SUBLEDGER')).toBe(true);
    expect(u).toBeTruthy();
  });

  it('§19. gerbang PeriodClose memakai jalur akrual yang sama & tidak menggandakan', async () => {
    const u = await buatUtang({ pokok: 100_000_000, persen: 1, basis: 'BULANAN', tanggal: '2026-01-01' });
    await proses('2026-12-31');
    const sebelum = await subledger(u);
    await jalankanGerbangAkrualBungaUtang({
      periodeMulai: '2026-01-01', periodeSelesai: '2026-12-31', createdBy: 'user-1', tanggalSekarang: '2027-01-15',
    });
    const sesudah = await subledger(u);
    expect(sesudah).toHaveLength(12);
    expect(sesudah.map((r) => r.nominal_target)).toEqual(sebelum.map((r) => r.nominal_target));
    expect(await saldo(ACC.bebanBunga)).toBe(12_000_000);
  });
});

// ============================================================
describe('RC-S63 — schema', () => {
  it('SCHEMA_VERSION tetap 69', () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });
});
