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

import {
  terimaUtang,
  bayarUtang,
  akruiBungaUtang,
  replayBungaUtang,
  bandingkanKejadianBungaUtang,
  KejadianBungaUtang,
} from '@/services/UtangService';
import { diagnosaUrutanKejadianBungaUtang } from '@/services/UtangBungaOrderingDiagnostic';

/**
 * RC-S54 TAHAP 16 — ITEM #13-A: URUTAN KEJADIAN BUNGA UTANG DETERMINISTIK.
 *
 * Kejadian (jurnal akrual & utang_pembayaran) di-seed LANGSUNG dengan
 * `created_at` dan nomor jurnal terkendali, sehingga setiap test menguji
 * aturan urut secara deterministik — tidak bergantung jam mesin.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
  modal: 'acc-3-1000',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    nb,
    now,
    now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`,
    tt,
    role,
    accountId
  );
}

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_PIHAK_LAIN', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);

  for (const th of [2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`,
      th,
      `${th}-01-01`,
      `${th}-12-31`
    );
  }
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank A','123','Koperasi',?,1,?)`,
    ACC.bank,
    now
  );
  return db;
}


async function buatUtang(): Promise<string> {
  const h = await terimaUtang({
    namaPemberi: 'Bank Mitra', jenisPemberi: 'BANK', pokokPinjaman: 100_000_000, persenBunga: 12, basisBunga: 'BULANAN',
    jenisBunga: 'FLAT', tanggal: '2026-01-05', sumberDana: 'KAS', createdBy: 'user-1',
  });
  return h.id;
}

let seqId = 0;
const T = (ms: number) => `2026-12-02T10:00:00.${String(ms).padStart(3, '0')}Z`;

async function seedJurnal(nomor: string, tanggal: string, createdAt: string, sumber: string, sumberId: string | null, lines: [string, number, number][]): Promise<string> {
  seqId += 1;
  const id = `j-${nomor}`;
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, sumber_id, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?,?,?,?,'uji','POSTED','user-1',?,?,?)`,
    id, nomor, tanggal, `p${tanggal.slice(0, 4)}`, sumber, sumberId, createdAt, createdAt, createdAt
  );
  let n = 0;
  for (const [acc, d, k] of lines) {
    n += 1;
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,?)`, `${id}-${n}`, id, acc, d, k);
  }
  return id;
}

async function akrual(utangId: string, nilai: number, tanggal: string, createdAt: string, nomor: string): Promise<string> {
  return seedJurnal(nomor, tanggal, createdAt, 'UTANG_BUNGA', utangId, [[ACC.bebanBunga, nilai, 0], [ACC.utangBunga, 0, nilai]]);
}

async function bayar(utangId: string, id: string, bunga: number, tanggal: string, createdAt: string, nomor: string | null): Promise<void> {
  let journalId: string | null = null;
  if (nomor) journalId = await seedJurnal(nomor, tanggal, createdAt, 'UTANG_BANK', null, [[ACC.utangBunga, bunga, 0], [ACC.kas, 0, bunga]]);
  await testDb.runAsync(
    `INSERT INTO utang_pembayaran (id, utang_id, tanggal, pokok, bunga, sumber_dana, nomor_transaksi, journal_id, created_by, created_at)
     VALUES (?,?,?,0,?,'KAS',?,?,'user-1',?)`,
    id, utangId, tanggal, bunga, `KWJ-${id}`, journalId, createdAt
  );
}

const ringkas = (r: Awaited<ReturnType<typeof replayBungaUtang>>) =>
  r.pembayaran.map((p) => `${p.id}:${p.keUtangBunga}/${p.keBeban}`).concat([`outstanding:${r.outstanding}`]);

beforeEach(async () => {
  testDb = await seedFixture();
  seqId = 0;
});
afterEach(() => {
  jest.useRealTimers();
  (testDb as unknown as { closeSync?: () => void }).closeSync?.();
});

describe('RC-S54 T16 #13-A — urutan kejadian replayBungaUtang', () => {
  it('1. created_at berbeda: urutan pencatatan dipakai apa adanya', async () => {
    const u = await buatUtang();
    await akrual(u, 300_000, '2026-09-30', T(1), 'JRN-2026-900001');
    await bayar(u, 'b1', 350_000, '2026-10-02', T(2), 'JRN-2026-900002');
    await akrual(u, 100_000, '2026-11-30', T(3), 'JRN-2026-900003');
    await bayar(u, 'b2', 100_000, '2026-12-02', T(4), 'JRN-2026-900004');
    expect(ringkas(await replayBungaUtang(testDb as never, u))).toEqual(['b1:300000/50000', 'b2:100000/0', 'outstanding:0']);
  });

  it('2. created_at sama: nomor urut jurnal menentukan (pembayaran lebih dulu dicatat daripada akrual berikutnya)', async () => {
    const u = await buatUtang();
    await akrual(u, 300_000, '2026-09-30', T(1), 'JRN-2026-900001');
    await bayar(u, 'b1', 350_000, '2026-10-02', T(5), 'JRN-2026-900002');
    await akrual(u, 100_000, '2026-11-30', T(5), 'JRN-2026-900003');
    await bayar(u, 'b2', 100_000, '2026-12-02', T(5), 'JRN-2026-900004');
    expect(ringkas(await replayBungaUtang(testDb as never, u))).toEqual(['b1:300000/50000', 'b2:100000/0', 'outstanding:0']);
    const d = await diagnosaUrutanKejadianBungaUtang(testDb as never);
    expect(d.temuan).toEqual([expect.objectContaining({ utangId: u, kode: 'TIMESTAMP_DUPLIKAT', createdAt: T(5) })]);
    expect(d.temuan[0].kejadian.map((k) => k.nomorJurnal)).toEqual(['JRN-2026-900002', 'JRN-2026-900003', 'JRN-2026-900004']);
    // Aturan lama (akrual dulu pada created_at sama) membaca b1 berbeda — dilaporkan, tidak dikoreksi.
    expect(d.hasilBerbedaDenganUrutanLama).toEqual([u]);
  });

  it('3. created_at sama + tanpa nomor jurnal (pembayaran warisan): tanggal lalu id; urutan insert tidak berpengaruh', async () => {
    const hasil: string[][] = [];
    for (const urutan of [['bA', 'bB'], ['bB', 'bA']]) {
      testDb = await seedFixture();
      const u = await buatUtang();
      await akrual(u, 120_000, '2026-09-30', T(1), 'JRN-2026-900001');
      for (const id of urutan) await bayar(u, id, 100_000, '2026-10-05', T(7), null);
      const r = await replayBungaUtang(testDb as never, u);
      hasil.push(ringkas(r));
      const d = await diagnosaUrutanKejadianBungaUtang(testDb as never);
      expect(d.temuan.map((t) => t.kode)).toEqual(['URUTAN_AMBIGU']);
    }
    expect(hasil[0]).toEqual(['bA:100000/0', 'bB:20000/80000', 'outstanding:0']);
    expect(hasil[1]).toEqual(hasil[0]);
  });

  it('4. dua pembayaran pada created_at sama: nomor jurnal lebih kecil diterapkan lebih dulu', async () => {
    const u = await buatUtang();
    await akrual(u, 150_000, '2026-09-30', T(1), 'JRN-2026-900001');
    await bayar(u, 'bZ', 100_000, '2026-10-05', T(9), 'JRN-2026-900002');
    await bayar(u, 'bA', 100_000, '2026-10-05', T(9), 'JRN-2026-900003');
    expect(ringkas(await replayBungaUtang(testDb as never, u))).toEqual(['bZ:100000/0', 'bA:50000/50000', 'outstanding:0']);
  });

  it('5. dua akrual pada created_at sama: total akrual & outstanding identik, tanpa temuan hasil berbeda', async () => {
    const u = await buatUtang();
    await akrual(u, 100_000, '2026-09-30', T(3), 'JRN-2026-900002');
    await akrual(u, 200_000, '2026-10-31', T(3), 'JRN-2026-900001');
    await bayar(u, 'b1', 250_000, '2026-11-05', T(4), 'JRN-2026-900003');
    const r = await replayBungaUtang(testDb as never, u);
    expect(r.totalAkrual).toBe(300_000);
    expect(ringkas(r)).toEqual(['b1:250000/0', 'outstanding:50000']);
    expect((await diagnosaUrutanKejadianBungaUtang(testDb as never)).hasilBerbedaDenganUrutanLama).toEqual([]);
  });

  it('6. akrual dan pembayaran pada created_at sama, akrual dicatat lebih dulu: akrual ikut menutup pembayaran', async () => {
    const u = await buatUtang();
    await akrual(u, 80_000, '2026-10-31', T(2), 'JRN-2026-900001');
    await bayar(u, 'b1', 80_000, '2026-11-02', T(2), 'JRN-2026-900002');
    expect(ringkas(await replayBungaUtang(testDb as never, u))).toEqual(['b1:80000/0', 'outstanding:0']);
    // Kebalikannya: pembayaran dicatat lebih dulu -> seluruhnya beban, akrual tetap outstanding.
    testDb = await seedFixture();
    const v = await buatUtang();
    await bayar(v, 'b1', 80_000, '2026-11-02', T(2), 'JRN-2026-900001');
    await akrual(v, 80_000, '2026-10-31', T(2), 'JRN-2026-900002');
    expect(ringkas(await replayBungaUtang(testDb as never, v))).toEqual(['b1:0/80000', 'outstanding:80000']);
  });

  it('7. periode (counter) berbeda pada created_at sama: counter tahun lebih awal lebih dulu, ditandai URUTAN_AMBIGU', async () => {
    const u = await buatUtang();
    await akrual(u, 90_000, '2026-12-31', T(8), 'JRN-2026-900009');
    await bayar(u, 'b1', 90_000, '2027-01-02', T(8), 'JRN-2027-000001');
    expect(ringkas(await replayBungaUtang(testDb as never, u))).toEqual(['b1:90000/0', 'outstanding:0']);
    expect((await diagnosaUrutanKejadianBungaUtang(testDb as never)).temuan.map((t) => t.kode)).toEqual(['URUTAN_AMBIGU']);
  });

  it('8. replay diulang & urutan insert dipermutasi: hasil selalu identik', async () => {
    const hasil = new Set<string>();
    let u = '';
    const skenario = [
      () => akrual(u, 300_000, '2026-09-30', T(1), 'JRN-2026-900001'),
      () => bayar(u, 'b1', 350_000, '2026-10-02', T(5), 'JRN-2026-900002'),
      () => akrual(u, 100_000, '2026-11-30', T(5), 'JRN-2026-900003'),
      () => bayar(u, 'b2', 100_000, '2026-12-02', T(5), 'JRN-2026-900004'),
    ];
    for (const perm of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1]]) {
      testDb = await seedFixture();
      u = await buatUtang();
      for (const i of perm) await skenario[i]();
      for (let k = 0; k < 10; k++) hasil.add(JSON.stringify(await replayBungaUtang(testDb as never, u)));
    }
    expect(hasil.size).toBe(1);
  });

  it('pembanding adalah total order: antisimetris & transitif pada kejadian acak berkunci sama', () => {
    const ev: KejadianBungaUtang[] = [];
    const nomor = [null, 'JRN-2026-000002', 'JRN-2026-000010', 'JRN-2027-000001'];
    for (const n of nomor) for (const tgl of ['2026-01-01', '2026-02-01']) for (const jenis of ['AKRUAL', 'PEMBAYARAN'] as const) {
      ev.push({ jenis, id: `${jenis}-${n}-${tgl}`, createdAt: T(1), tanggal: tgl, nomorJurnal: n });
    }
    for (const a of ev) for (const b of ev) {
      expect(Math.sign(bandingkanKejadianBungaUtang(a, b))).toBe(-Math.sign(bandingkanKejadianBungaUtang(b, a)) || 0);
      for (const c of ev) {
        if (bandingkanKejadianBungaUtang(a, b) < 0 && bandingkanKejadianBungaUtang(b, c) < 0) expect(bandingkanKejadianBungaUtang(a, c)).toBeLessThan(0);
      }
    }
    // Pada kunci selain jenis identik (tanpa nomor jurnal, tanggal sama): akrual sebelum pembayaran (aturan lama).
    const tanpaNomor = ev.filter((e) => e.nomorJurnal === null && e.tanggal === '2026-01-01');
    const ak = tanpaNomor.find((e) => e.jenis === 'AKRUAL')!;
    const by = tanpaNomor.find((e) => e.jenis === 'PEMBAYARAN')!;
    expect(bandingkanKejadianBungaUtang(ak, by)).toBeLessThan(0);
    // Nomor urut numerik, bukan string: 000010 setelah 000002.
    const a = ev.find((e) => e.nomorJurnal === 'JRN-2026-000002')!;
    const b = ev.find((e) => e.nomorJurnal === 'JRN-2026-000010')!;
    expect(bandingkanKejadianBungaUtang(a, b)).toBeLessThan(0);
  });

  it('end-to-end service asli dengan jam dibekukan (seluruh created_at identik): hasil 7b deterministik', async () => {
    jest.useFakeTimers({ now: new Date('2026-12-02T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    const id = await buatUtang();
    await akruiBungaUtang({ utangId: id, tanggal: '2026-09-30', nominal: 300_000, createdBy: 'user-1' });
    await bayarUtang({ utangId: id, tanggal: '2026-10-02', pokok: 0, bunga: 350_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await akruiBungaUtang({ utangId: id, tanggal: '2026-11-30', nominal: 100_000, createdBy: 'user-1' });
    const b = await bayarUtang({ utangId: id, tanggal: '2026-12-02', pokok: 0, bunga: 100_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const e = await testDb.getAllAsync<{ account_id: string; debit: number }>(`SELECT account_id, debit FROM journal_entry WHERE journal_id = ?`, b.journalId);
    expect(e.find((x) => x.account_id === ACC.utangBunga)?.debit).toBe(100_000);
    expect(e.find((x) => x.account_id === ACC.bebanBunga)).toBeUndefined();
    const r = await replayBungaUtang(testDb as never, id);
    expect(r.pembayaran.map((p) => [p.keUtangBunga, p.keBeban])).toEqual([[300_000, 50_000], [100_000, 0]]);
  });

  it('STATIC: diagnostik tanpa tulis DB; replay tetap satu sumber (hitungReplayDariKejadian)', () => {
    const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(strip(baca('src/services/UtangBungaOrderingDiagnostic.ts'))).not.toMatch(/INSERT INTO|UPDATE \w+ SET|DELETE FROM|createJournal|runAsync|withTransaction/);
    expect(strip(baca('src/services/UtangService.ts'))).toMatch(/return hitungReplayDariKejadian\(await muatKejadianBungaUtang\(db, utangId\)\);/);
  });
});
