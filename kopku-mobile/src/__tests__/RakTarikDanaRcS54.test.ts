import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

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

import { catatRAK, editRAK, batalkanRAK, listRAK, getRAKDetail } from '@/services/RAKService';
import { getHistoryDetail, batalkanTransaksiHistory } from '@/services/HistoryTransaksiService';
import { diagnosaHistoriRAK } from '@/services/RAKDiagnosticService';
import { getPosisiKeuangan } from '@/reports/FinancialReports';

/**
 * RC-S54 TAHAP 13 — ITEM #19 RAK / TARIK DANA RAK.
 *
 * SQLite nyata (sql.js). Tanggal "hari ini" dikunci lewat fake timer Date
 * saja, supaya jurnal pembalik (bertanggal hari ini) deterministik.
 * DATABASE VERIFIED · RENDER/DEVICE NOT VERIFIED.
 */

const HARI_INI = '2026-09-17';
const ACC = { kas: 'acc-kas', bank: 'acc-bank', rak: 'acc-rak', modal: 'acc-modal' };

function kunciHariIni(iso = `${HARI_INI}T10:00:00`) {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
}

async function seedFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();
  const akun: [string, string, string, string, string][] = [
    [ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT'],
    [ACC.bank, '1-1101', 'Bank Uji', 'ASET', 'DEBIT'],
    [ACC.rak, '1-1800', 'Rekening Antar Kantor (RAK)', 'ASET', 'DEBIT'],
    [ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT'],
  ];
  for (const [id, kode, nama, kat, nb] of akun) {
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, nama, kat, nb, now, now
    );
  }
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m1','KAS_UMUM','DEFAULT',?)`, ACC.kas);
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m2','RAK','DEBIT_ASET',?)`, ACC.rak);
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at) VALUES ('bank-1','Bank Uji','123','Kop',0,?,1,?)`,
    ACC.bank, now
  );
  for (const th of [2025, 2026]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `period-${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at) VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO koperasi_unit_usaha (id, nama_usaha, status, created_at, updated_at) VALUES ('unit-a','Unit Simpan Pinjam A','AKTIF',?,?)`,
    now, now
  );
  // Modal awal ke kas & bank (tahun 2025 agar transaksi 2025 punya dana).
  await jurnalMentah('j-modal', '2025-01-02', 'MODAL_AWAL', null, [[ACC.kas, 100_000_000, 0], [ACC.bank, 50_000_000, 0], [ACC.modal, 0, 150_000_000]]);
}

async function jurnalMentah(
  id: string, tanggal: string, sumber: string, reversalOf: string | null, lines: [string, number, number][], status = 'POSTED'
) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, reversal_of_id, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?,?,?,?,?,?,'user-1',?,?,?)`,
    id, `JRN-${id}`, tanggal, `period-${tanggal.slice(0, 4)}`, sumber, 'fixture', status, reversalOf, now, now, now
  );
  let n = 0;
  for (const [acc, d, k] of lines) {
    n += 1;
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,?)`, `${id}-${n}`, id, acc, d, k);
  }
}

async function saldo(accountId: string, sampai?: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit - je.kredit),0) s FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') ${sampai ? 'AND j.tanggal <= ?' : ''}`,
    ...(sampai ? [accountId, sampai] : [accountId])
  );
  return r?.s ?? 0;
}

async function snapshotJurnal(id: string) {
  const j = await testDb.getFirstAsync<any>(`SELECT id, nomor_jurnal, tanggal, sumber_transaksi, deskripsi, period_id, created_at FROM journal WHERE id = ?`, id);
  const e = await testDb.getAllAsync<any>(`SELECT id, account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY id`, id);
  return { j, e };
}

const dasar = {
  jenisRak: 'PENYALURAN_DANA' as const,
  namaUnit: 'Kantor Cabang Makassar',
  jumlah: 10_000_000,
  tanggal: '2026-03-10',
  sumberDana: 'KAS' as const,
  createdBy: 'user-1',
};

beforeEach(async () => {
  kunciHariIni();
  await seedFixture();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

describe('RC-S54 T13 #19 — Tarik Dana RAK (DATABASE VERIFIED)', () => {
  it('A — RAK normal: Dr RAK / Cr Kas seimbang, baris AKTIF, diagnostik BALANCED', async () => {
    const { id, journalId } = await catatRAK({ ...dasar, keterangan: 'Modal kerja cabang' });
    const { e } = await snapshotJurnal(journalId);
    expect(e.reduce((s: number, x: any) => s + x.debit, 0)).toBe(e.reduce((s: number, x: any) => s + x.kredit, 0));
    expect(e.find((x: any) => x.account_id === ACC.rak)).toMatchObject({ debit: 10_000_000, kredit: 0 });
    expect(e.find((x: any) => x.account_id === ACC.kas)).toMatchObject({ debit: 0, kredit: 10_000_000 });
    expect(await saldo(ACC.rak)).toBe(10_000_000);
    const d = await getRAKDetail(id);
    expect(d).toMatchObject({ status: 'AKTIF', reversalJournalId: null, alasanTarikDana: null, keterangan: 'Modal kerja cabang' });
    const diag = await diagnosaHistoriRAK(testDb as any);
    expect(diag.baris[0].kode).toEqual(['BALANCED']);
    expect(diag.saldo.selisihTidakTerjelaskan).toBe(0);
  });

  it('B — Tarik Dana satu kali: jurnal pembalik cerminan tepat, tanggal hari ini, saldo kembali, keterangan asal tetap', async () => {
    const { id, journalId } = await catatRAK({ ...dasar, keterangan: 'Modal kerja cabang' });
    const kasSebelumRak = 100_000_000;
    const hasil = await batalkanRAK(id, 'user-1', 'Dana ditarik kembali ke kas pusat');

    expect(hasil.status).toBe('DIBATALKAN');
    expect(hasil.keterangan).toBe('Modal kerja cabang');
    expect(hasil.alasanTarikDana).toBe('Dana ditarik kembali ke kas pusat');
    expect(hasil.reversalJournalId).toEqual(expect.any(String));

    const rev = await testDb.getFirstAsync<any>(`SELECT * FROM journal WHERE id = ?`, hasil.reversalJournalId);
    expect(rev).toMatchObject({ tanggal: HARI_INI, status: 'POSTED', reversal_of_id: journalId, sumber_transaksi: 'RAK' });
    const eAsal = (await snapshotJurnal(journalId)).e;
    const eRev = (await snapshotJurnal(rev.id)).e;
    for (const a of eAsal) {
      const cermin = eRev.find((x: any) => x.account_id === a.account_id);
      expect([cermin.debit, cermin.kredit]).toEqual([a.kredit, a.debit]);
    }
    expect(eRev.reduce((s: number, x: any) => s + x.debit, 0)).toBe(eRev.reduce((s: number, x: any) => s + x.kredit, 0));
    expect(await saldo(ACC.rak)).toBe(0);
    expect(await saldo(ACC.kas)).toBe(kasSebelumRak);
  });

  it('C — Tarik Dana dua kali (berurutan & bersamaan) ditolak; tepat satu pembalik', async () => {
    const a = await catatRAK(dasar);
    await batalkanRAK(a.id, 'user-1', 'pertama');
    await expect(batalkanRAK(a.id, 'user-1', 'kedua')).rejects.toThrow(/sudah dibatalkan/);

    const b = await catatRAK({ ...dasar, namaUnit: 'Cabang B' });
    const hasil = await Promise.allSettled([batalkanRAK(b.id, 'user-1', 'x'), batalkanRAK(b.id, 'user-1', 'y')]);
    expect(hasil.map((h) => h.status).sort()).toEqual(['fulfilled', 'rejected']);

    for (const r of [a, b]) {
      const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE reversal_of_id = ?`, r.journalId);
      expect(n?.n).toBe(1);
    }
    const lewatHistory = await getHistoryDetail(a.journalId);
    expect(lewatHistory?.canDelete).toBe(false);
    expect(await saldo(ACC.rak)).toBe(0);
  });

  it('D — jurnal asal TIDAK dihapus/diubah (baris & entri identik; hanya status → REVERSED & tautan)', async () => {
    const { id, journalId } = await catatRAK(dasar);
    const sebelum = await snapshotJurnal(journalId);
    const barisSebelum = await testDb.getFirstAsync<any>(`SELECT id, nomor_rak, jumlah, tanggal, journal_id, keterangan, unit_usaha_id, jenis_alokasi FROM rak_transaksi WHERE id = ?`, id);
    const hasil = await batalkanRAK(id, 'user-1', 'tarik');
    expect(await snapshotJurnal(journalId)).toEqual(sebelum);
    const j = await testDb.getFirstAsync<any>(`SELECT status, reversed_by_id FROM journal WHERE id = ?`, journalId);
    expect(j).toEqual({ status: 'REVERSED', reversed_by_id: hasil.reversalJournalId });
    expect(await testDb.getFirstAsync<any>(`SELECT id, nomor_rak, jumlah, tanggal, journal_id, keterangan, unit_usaha_id, jenis_alokasi FROM rak_transaksi WHERE id = ?`, id)).toEqual(barisSebelum);
    expect(await listRAK()).toHaveLength(1);
  });

  it('E — saldo RAK/kas/bank & Posisi Keuangan konsisten; transaksi lain tidak terganggu', async () => {
    const posisiAwal = await getPosisiKeuangan(testDb as any, '2026-12-31');
    const x = await catatRAK(dasar);
    const y = await catatRAK({ ...dasar, namaUnit: 'Cabang Bank', jumlah: 4_000_000, sumberDana: 'BANK', bankAccountId: 'bank-1' });
    await batalkanRAK(y.id, 'user-1', 'tarik bank');
    expect(await saldo(ACC.rak)).toBe(10_000_000);
    expect(await saldo(ACC.bank)).toBe(50_000_000);
    expect(await saldo(ACC.kas)).toBe(90_000_000);
    await batalkanRAK(x.id, 'user-1', 'tarik kas');
    expect(await saldo(ACC.rak)).toBe(0);
    const posisiAkhir = await getPosisiKeuangan(testDb as any, '2026-12-31');
    expect(JSON.parse(JSON.stringify(posisiAkhir))).toEqual(JSON.parse(JSON.stringify(posisiAwal)));
    const diag = await diagnosaHistoriRAK(testDb as any);
    expect(diag.saldo).toMatchObject({ saldoGl: 0, outstandingSubledger: 0, selisihTidakTerjelaskan: 0 });
  });

  it('F — POLICY-A: asal di periode CLOSED → Tarik Dana BOLEH lewat RAKList & History; pembalik di periode berjalan; periode & laporan asal tidak berubah', async () => {
    const lewatList = await catatRAK({ ...dasar, tanggal: '2025-06-01' });
    const lewatHistory = await catatRAK({ ...dasar, namaUnit: 'Cabang B', jumlah: 2_000_000, tanggal: '2025-07-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2025'`);
    const asalSebelum = [await snapshotJurnal(lewatList.journalId), await snapshotJurnal(lewatHistory.journalId)];
    const posisi2025Sebelum = JSON.parse(JSON.stringify(await getPosisiKeuangan(testDb as any, '2025-12-31')));

    // Jalur RAKList: kelayakan dari listRAK lalu batalkanRAK.
    const barisList = (await listRAK()).find((r) => r.id === lewatList.id)!;
    expect(barisList.tarikDana).toEqual({ kode: 'BOLEH', alasan: null });
    const hList = await batalkanRAK(lewatList.id, 'user-1', 'tarik lintas tahun');

    // Jalur History: detail periode CLOSED tetap boleh untuk RAK.
    const detail = await getHistoryDetail(lewatHistory.journalId);
    expect(detail?.periodeStatus).toBe('CLOSED');
    expect(detail).toMatchObject({ canDelete: true, canEdit: true, aksiTidakTersediaAlasan: null });
    await batalkanTransaksiHistory(detail!.sumberRute!, 'user-1', 'tarik lintas tahun');
    const hHistory = (await getRAKDetail(lewatHistory.id))!;

    for (const h of [hList, hHistory]) {
      const rev = await testDb.getFirstAsync<any>(`SELECT tanggal, period_id FROM journal WHERE id = ?`, h.reversalJournalId);
      expect(rev).toEqual({ tanggal: HARI_INI, period_id: 'period-2026' });
    }
    expect([await snapshotJurnal(lewatList.journalId), await snapshotJurnal(lewatHistory.journalId)]).toEqual(asalSebelum);
    expect((await testDb.getFirstAsync<any>(`SELECT status FROM accounting_period WHERE id = 'period-2025'`)).status).toBe('CLOSED');
    expect(JSON.parse(JSON.stringify(await getPosisiKeuangan(testDb as any, '2025-12-31')))).toEqual(posisi2025Sebelum);
    expect(await saldo(ACC.rak, '2025-12-31')).toBe(12_000_000);
    expect(await saldo(ACC.rak)).toBe(0);
  });

  it('F2 — periode pembalik (hari ini) CLOSED → DITOLAK di RAKList, History, dan service; atomik, tanpa jejak', async () => {
    const r = await catatRAK({ ...dasar, tanggal: '2026-02-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2026'`);
    const hitung = () => testDb.getFirstAsync<any>(`SELECT (SELECT COUNT(*) FROM journal) j, (SELECT COUNT(*) FROM audit_log) a, (SELECT status FROM rak_transaksi WHERE id = '${r.id}') s`);
    const sebelum = await hitung();

    const baris = (await listRAK()).find((x) => x.id === r.id)!;
    expect(baris.tarikDana.kode).toBe('PERIODE_PEMBALIK_CLOSED');
    const detail = await getHistoryDetail(r.journalId);
    expect(detail).toMatchObject({ canDelete: false, canEdit: false });
    expect(detail?.aksiTidakTersediaAlasan).toBe(baris.tarikDana.alasan);
    await expect(batalkanRAK(r.id, 'user-1', 'tarik')).rejects.toThrow(baris.tarikDana.alasan!);
    await expect(batalkanTransaksiHistory({ table: 'rak_transaksi', id: r.id }, 'user-1', 'tarik')).rejects.toThrow(/CLOSED/);
    await expect(editRAK(r.id, 'user-1', { ...dasar, tanggal: '2026-02-01', jumlah: 1 })).rejects.toThrow(/CLOSED/);
    expect(await hitung()).toEqual(sebelum);
    expect(await saldo(ACC.rak)).toBe(10_000_000);
  });

  it('G — POLICY-B: catatRAK bertanggal setelah hari ini DITOLAK; atomik (tanpa jurnal, baris, audit, nomor urut, perubahan saldo)', async () => {
    const hitung = () => testDb.getFirstAsync<any>(
      `SELECT (SELECT COUNT(*) FROM journal) j, (SELECT COUNT(*) FROM rak_transaksi) r, (SELECT COUNT(*) FROM audit_log) a`
    );
    const sebelum = await hitung();
    const kasSebelum = await saldo(ACC.kas);
    await expect(catatRAK({ ...dasar, tanggal: '2026-09-18' })).rejects.toThrow(
      'Tanggal RAK 2026-09-18 setelah hari ini (2026-09-17). RAK tidak dapat dicatat bertanggal masa depan.'
    );
    await expect(catatRAK({ ...dasar, tanggal: '2027-01-02', sumberDana: 'BANK', bankAccountId: 'bank-1' })).rejects.toThrow(/setelah hari ini/);
    expect(await hitung()).toEqual(sebelum);
    expect(await saldo(ACC.kas)).toBe(kasSebelum);
    // Hari ini sendiri boleh; nomor urut pertama tetap dipakai (tidak terbakar oleh percobaan gagal).
    const ok = await catatRAK({ ...dasar, tanggal: HARI_INI });
    expect(ok.nomorRak).toBe('RAK-2026-000001');
  });

  it('H — POLICY-B: edit/Tarik Dana atas RAK asal masa depan DITOLAK di semua jalur; edit ke tanggal masa depan DITOLAK', async () => {
    // Baris masa depan warisan (dibuat saat jam perangkat di depan, sebelum T14).
    jest.setSystemTime(new Date('2026-12-25T10:00:00'));
    const masaDepan = await catatRAK({ ...dasar, tanggal: '2026-12-20' });
    jest.setSystemTime(new Date(`${HARI_INI}T10:00:00`));
    const normal = await catatRAK(dasar);

    const baris = (await listRAK()).find((x) => x.id === masaDepan.id)!;
    expect(baris.tarikDana.kode).toBe('TANGGAL_MASA_DEPAN');
    const detail = await getHistoryDetail(masaDepan.journalId);
    expect(detail).toMatchObject({ canDelete: false, canEdit: false, aksiTidakTersediaAlasan: baris.tarikDana.alasan });
    await expect(batalkanRAK(masaDepan.id, 'user-1', 'tarik')).rejects.toThrow(/setelah hari ini/);
    await expect(editRAK(masaDepan.id, 'user-1', { ...dasar, tanggal: HARI_INI })).rejects.toThrow(/setelah hari ini/);
    await expect(editRAK(normal.id, 'user-1', { ...dasar, tanggal: '2026-10-01' })).rejects.toThrow(/RAK tidak dapat dicatat bertanggal masa depan/);
    expect((await getRAKDetail(normal.id))?.status).toBe('AKTIF');
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE reversal_of_id IS NOT NULL`))?.n).toBe(0);
    expect(await saldo(ACC.rak, '2026-11-30')).toBe(10_000_000); // tidak ada saldo negatif temporal

    jest.setSystemTime(new Date('2026-12-20T09:00:00'));
    const h = await batalkanRAK(masaDepan.id, 'user-1', 'tarik');
    const rev = await testDb.getFirstAsync<any>(`SELECT tanggal FROM journal WHERE id = ?`, h.reversalJournalId);
    expect(rev.tanggal >= '2026-12-20').toBe(true);
  });

  it('G0 — transaksi RAK tanpa pasangan valid: tanpa jurnal / jurnal sudah REVERSED ditolak eksplisit, tanpa jurnal baru', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO rak_transaksi (id, nomor_rak, jenis_rak, nama_unit, jumlah, tanggal, sumber_dana, status, journal_id, created_by, created_at, updated_at)
       VALUES ('rak-tanpa-jurnal','RAK-LAMA-1','PENYALURAN_DANA','Cabang Lama',5000000,'2026-01-05','KAS','AKTIF',NULL,'user-1',?,?)`,
      now, now
    );
    await expect(batalkanRAK('rak-tanpa-jurnal', 'user-1', 'tarik')).rejects.toThrow(/tidak mempunyai jurnal/);

    const { id, journalId } = await catatRAK(dasar);
    await testDb.runAsync(`UPDATE journal SET status = 'REVERSED' WHERE id = ?`, journalId); // legacy tidak konsisten
    const jumlahJurnal = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))?.n;
    await expect(batalkanRAK(id, 'user-1', 'tarik')).rejects.toThrow(/POSTED/);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))?.n).toBe(jumlahJurnal);
    expect((await getRAKDetail(id))?.status).toBe('AKTIF');
    await expect(batalkanRAK('tidak-ada', 'user-1', 'tarik')).rejects.toThrow(/tidak ditemukan/);
  });

  it('H2 — dua transaksi RAK berbeda tidak tertukar (nominal, rekening, tautan)', async () => {
    const kas = await catatRAK({ ...dasar, jumlah: 7_000_000 });
    const bank = await catatRAK({ ...dasar, namaUnit: 'Cabang Bank', jumlah: 3_000_000, sumberDana: 'BANK', bankAccountId: 'bank-1' });
    const h = await batalkanRAK(bank.id, 'user-1', 'tarik bank');

    expect((await getRAKDetail(kas.id))).toMatchObject({ status: 'AKTIF', reversalJournalId: null });
    const rev = await testDb.getFirstAsync<any>(`SELECT reversal_of_id FROM journal WHERE id = ?`, h.reversalJournalId);
    expect(rev.reversal_of_id).toBe(bank.journalId);
    const eRev = (await snapshotJurnal(h.reversalJournalId!)).e;
    expect(eRev.find((x: any) => x.account_id === ACC.bank)).toMatchObject({ debit: 3_000_000 });
    expect(eRev.some((x: any) => x.account_id === ACC.kas)).toBe(false);
    expect(await saldo(ACC.rak)).toBe(7_000_000);
    expect(await saldo(ACC.kas)).toBe(93_000_000);
    expect(await saldo(ACC.bank)).toBe(50_000_000);
  });

  it('I — History dan RAKList konsisten untuk setiap keadaan (BOLEH / asal CLOSED / masa depan / dibatalkan / hari ini CLOSED)', async () => {
    jest.setSystemTime(new Date('2026-12-25T10:00:00'));
    const masaDepan = await catatRAK({ ...dasar, namaUnit: 'Masa depan', tanggal: '2026-12-20' });
    jest.setSystemTime(new Date(`${HARI_INI}T10:00:00`));
    const boleh = await catatRAK({ ...dasar, namaUnit: 'Boleh' });
    const asalTutup = await catatRAK({ ...dasar, namaUnit: 'Asal tutup', tanggal: '2025-05-05' });
    const batal = await catatRAK({ ...dasar, namaUnit: 'Batal' });
    await batalkanRAK(batal.id, 'user-1', 'tarik');
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2025'`);

    const bandingkan = async () => {
      const list = await listRAK();
      for (const r of [boleh, asalTutup, masaDepan, batal]) {
        const item = list.find((x) => x.id === r.id)!;
        const d = await getHistoryDetail(r.journalId);
        const bolehList = item.tarikDana.kode === 'BOLEH';
        expect({ id: item.namaUnit, boleh: d!.canDelete }).toEqual({ id: item.namaUnit, boleh: bolehList });
        if (!bolehList && item.tarikDana.kode !== 'SUDAH_DIBATALKAN') {
          expect(d!.aksiTidakTersediaAlasan).toBe(item.tarikDana.alasan);
        }
      }
      return list.map((x) => [x.namaUnit, x.tarikDana.kode]).sort();
    };
    expect(await bandingkan()).toEqual([
      ['Asal tutup', 'BOLEH'], ['Batal', 'SUDAH_DIBATALKAN'], ['Boleh', 'BOLEH'], ['Masa depan', 'TANGGAL_MASA_DEPAN'],
    ]);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2026'`);
    expect(await bandingkan()).toEqual([
      ['Asal tutup', 'PERIODE_PEMBALIK_CLOSED'], ['Batal', 'SUDAH_DIBATALKAN'], ['Boleh', 'PERIODE_PEMBALIK_CLOSED'], ['Masa depan', 'TANGGAL_MASA_DEPAN'],
    ]);
  });

  it('I2 — pembalik mempunyai referensi transaksi asal (dua arah) & terlihat benar di History', async () => {
    const { id, journalId, nomorRak } = await catatRAK(dasar);
    const h = await batalkanRAK(id, 'user-1', 'tarik');
    const asal = await testDb.getFirstAsync<any>(`SELECT reversed_by_id FROM journal WHERE id = ?`, journalId);
    const rev = await testDb.getFirstAsync<any>(`SELECT reversal_of_id, nomor_referensi, deskripsi FROM journal WHERE id = ?`, h.reversalJournalId);
    expect(asal.reversed_by_id).toBe(h.reversalJournalId);
    expect(rev).toMatchObject({ reversal_of_id: journalId, nomor_referensi: journalId });
    expect(rev.deskripsi).toMatch(/^REVERSAL: tarik/);
    expect((await getRAKDetail(id))?.journalId).toBe(journalId);
    expect(nomorRak).toMatch(/^RAK-/);

    const detailRev = await getHistoryDetail(h.reversalJournalId!);
    expect(detailRev?.canDelete).toBe(false);
    expect(detailRev?.aksiTidakTersediaAlasan).toMatch(/pembalik \(Tarik Dana RAKU\)/); // DIPERBARUI Poin 10 — label RAKU
    expect(detailRev?.aksiTidakTersediaAlasan).not.toMatch(/tidak ditemukan/);
  });

  it('J — audit trail: CREATE + REVERSE membawa alasan, jurnal asal/pembalik, keterangan asal, status', async () => {
    const { id, journalId } = await catatRAK({ ...dasar, keterangan: 'Modal kerja' });
    const h = await batalkanRAK(id, 'user-1', 'Dana dikembalikan');
    const log = await testDb.getAllAsync<any>(`SELECT action, user_id, data_sesudah FROM audit_log WHERE entity = 'rak_transaksi' AND entity_id = ? ORDER BY created_at, rowid`, id);
    expect(log.map((l: any) => l.action)).toEqual(['CREATE', 'REVERSE']);
    expect(JSON.parse(log[1].data_sesudah)).toMatchObject({
      alasan: 'Dana dikembalikan', journalAsalId: journalId, reversalJournalId: h.reversalJournalId,
      statusSebelum: 'AKTIF', statusSesudah: 'DIBATALKAN', keteranganAsal: 'Modal kerja', tanggalReversal: HARI_INI, jumlah: 10_000_000,
    });
    const jlog = await testDb.getFirstAsync<any>(`SELECT action FROM audit_log WHERE entity = 'journal' AND entity_id = ? AND action = 'REVERSE'`, journalId);
    expect(jlog?.action).toBe('REVERSE');
  });

  it('J2 — full reversal hanya satu kali lintas jalur (RAKList lalu History, dan sebaliknya); nominal pembalik = nominal penuh', async () => {
    const a = await catatRAK({ ...dasar, jumlah: 6_000_000 });
    await batalkanRAK(a.id, 'user-1', 'lewat list');
    await expect(batalkanTransaksiHistory({ table: 'rak_transaksi', id: a.id }, 'user-1', 'lewat history')).rejects.toThrow(/sudah dibatalkan/);

    const b = await catatRAK({ ...dasar, jumlah: 4_000_000 });
    const d = await getHistoryDetail(b.journalId);
    await batalkanTransaksiHistory(d!.sumberRute!, 'user-1', 'tarik via history');
    await expect(batalkanRAK(b.id, 'user-1', 'lewat list')).rejects.toThrow(/sudah dibatalkan/);
    expect((await getRAKDetail(b.id))?.alasanTarikDana).toBe('tarik via history');

    for (const r of [a, b]) {
      const revs = await testDb.getAllAsync<any>(`SELECT id FROM journal WHERE reversal_of_id = ?`, r.journalId);
      expect(revs).toHaveLength(1);
      const kreditRak = await testDb.getFirstAsync<{ k: number }>(`SELECT SUM(kredit) k FROM journal_entry WHERE journal_id = ? AND account_id = ?`, revs[0].id, ACC.rak);
      expect(kreditRak?.k).toBe(r === a ? 6_000_000 : 4_000_000);
    }
  });

  it('POLICY-D — status tetap AKTIF/DIBATALKAN; Tarik Dana vs koreksi-edit dibedakan tanpa status baru', async () => {
    const tarik = await catatRAK(dasar);
    await batalkanRAK(tarik.id, 'user-1', 'Dana kembali ke pusat');
    const lama = await catatRAK({ ...dasar, namaUnit: 'Salah input' });
    const baru = await editRAK(lama.id, 'user-1', { ...dasar, namaUnit: 'Benar' });
    const byId = new Map((await listRAK()).map((x) => [x.id, x]));
    expect(byId.get(tarik.id)).toMatchObject({ status: 'DIBATALKAN', jenisPenutupan: 'TARIK_DANA', digantikanOlehId: null, alasanTarikDana: 'Dana kembali ke pusat' });
    expect(byId.get(lama.id)).toMatchObject({ status: 'DIBATALKAN', jenisPenutupan: 'KOREKSI_EDIT', digantikanOlehId: baru.id });
    expect(byId.get(baru.id)).toMatchObject({ status: 'AKTIF', jenisPenutupan: null, reversalOfId: lama.id });
    const statusDiDb = await testDb.getAllAsync<{ status: string }>(`SELECT DISTINCT status FROM rak_transaksi ORDER BY status`);
    expect(statusDiDb.map((x) => x.status)).toEqual(['AKTIF', 'DIBATALKAN']);
  });

  it('EDIT — kolom RAKU dipertahankan & divalidasi; baris lama dibalik, keterangan lama tidak ditimpa', async () => {
    const lama = await catatRAK({ ...dasar, unitUsahaId: 'unit-a', jenisAlokasi: 'MODAL_TETAP', keterangan: 'awal' });
    const baru = await editRAK(lama.id, 'user-1', { ...dasar, jumlah: 8_000_000, unitUsahaId: 'unit-a', jenisAlokasi: 'OPERASIONAL', keterangan: 'koreksi' });
    const dBaru = await getRAKDetail(baru.id);
    expect(dBaru).toMatchObject({ unitUsahaId: 'unit-a', jenisAlokasi: 'OPERASIONAL', reversalOfId: lama.id, jumlah: 8_000_000 });
    const dLama = await getRAKDetail(lama.id);
    expect(dLama).toMatchObject({ status: 'DIBATALKAN', keterangan: 'awal', unitUsahaId: 'unit-a', jenisAlokasi: 'MODAL_TETAP' });
    expect(dLama?.alasanTarikDana).toMatch(/Dikoreksi/);
    await expect(editRAK(baru.id, 'user-1', { ...dasar, jenisAlokasi: 'NGAWUR' as any })).rejects.toThrow(/Jenis alokasi RAKU tidak dikenali/);
    await expect(editRAK(baru.id, 'user-1', { ...dasar, unitUsahaId: 'unit-tidak-ada' })).rejects.toThrow(/Unit usaha tidak ditemukan/);
    expect((await getRAKDetail(baru.id))?.status).toBe('AKTIF'); // edit gagal di-rollback penuh
    expect(await saldo(ACC.rak)).toBe(8_000_000);
  });
});

describe('RC-S54 T13 #19 — K. Diagnostik historis (read-only)', () => {
  async function rakMentah(id: string, nomor: string, status: string, jumlah: number, tanggal: string, journalId: string | null, extra: Record<string, string | null> = {}) {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO rak_transaksi (id, nomor_rak, jenis_rak, nama_unit, unit_usaha_id, jenis_alokasi, jumlah, tanggal, sumber_dana, keterangan, status, journal_id, reversal_of_id, created_by, created_at, updated_at)
       VALUES (?,?, 'PENYALURAN_DANA','Cabang',?,?,?,?,'KAS',?,?,?,?,'user-1',?,?)`,
      id, nomor, extra.unit ?? null, extra.alokasi ?? null, jumlah, tanggal, extra.keterangan ?? null, status, journalId, extra.reversalOf ?? null, now, now
    );
  }

  it('K — membedakan BALANCED, GAP, DUPLICATE_REVERSAL, MISSING_SOURCE, ORPHAN_REVERSAL, OUTSTANDING_MISMATCH, JOURNAL_MISMATCH, PERIOD_MISMATCH, HISTORICAL_GAP', async () => {
    // BALANCED (lewat service, pasca-T13)
    const ok = await catatRAK({ ...dasar, tanggal: '2026-01-10' });
    const okTarik = await catatRAK({ ...dasar, tanggal: '2026-01-11' });
    await batalkanRAK(okTarik.id, 'user-1', 'tarik');

    // GAP: DIBATALKAN tanpa pembalik
    await jurnalMentah('j-gap', '2026-02-01', 'RAK', null, [[ACC.rak, 1_000_000, 0], [ACC.kas, 0, 1_000_000]]);
    await rakMentah('r-gap', 'RAK-GAP', 'DIBATALKAN', 1_000_000, '2026-02-01', 'j-gap');

    // DUPLICATE_REVERSAL + PERIOD_MISMATCH (pembalik mendahului asal) + HISTORICAL_GAP (tanpa audit T13)
    await jurnalMentah('j-dup', '2026-03-01', 'RAK', null, [[ACC.rak, 2_000_000, 0], [ACC.kas, 0, 2_000_000]], 'REVERSED');
    await jurnalMentah('j-dup-r1', '2026-03-05', 'RAK', 'j-dup', [[ACC.rak, 0, 2_000_000], [ACC.kas, 2_000_000, 0]]);
    await jurnalMentah('j-dup-r2', '2026-02-20', 'RAK', 'j-dup', [[ACC.rak, 0, 2_000_000], [ACC.kas, 2_000_000, 0]]);
    await testDb.runAsync(`UPDATE journal SET reversed_by_id = 'j-dup-r1' WHERE id = 'j-dup'`);
    await rakMentah('r-dup', 'RAK-DUP', 'DIBATALKAN', 2_000_000, '2026-03-01', 'j-dup', { keterangan: 'alasan lama' });

    // OUTSTANDING_MISMATCH: AKTIF padahal jurnal REVERSED + pembalik
    await jurnalMentah('j-out', '2026-04-01', 'RAK', null, [[ACC.rak, 3_000_000, 0], [ACC.kas, 0, 3_000_000]], 'REVERSED');
    await jurnalMentah('j-out-r', '2026-04-02', 'RAK', 'j-out', [[ACC.rak, 0, 3_000_000], [ACC.kas, 3_000_000, 0]]);
    await rakMentah('r-out', 'RAK-OUT', 'AKTIF', 3_000_000, '2026-04-01', 'j-out');

    // JOURNAL_MISMATCH: nominal jurnal ≠ jumlah baris
    await jurnalMentah('j-mis', '2026-05-01', 'RAK', null, [[ACC.rak, 900_000, 0], [ACC.kas, 0, 900_000]]);
    await rakMentah('r-mis', 'RAK-MIS', 'AKTIF', 1_000_000, '2026-05-01', 'j-mis');

    // MISSING_SOURCE: jurnal RAK tanpa baris
    await jurnalMentah('j-yatim', '2026-06-01', 'RAK', null, [[ACC.rak, 500_000, 0], [ACC.kas, 0, 500_000]]);
    // ORPHAN_REVERSAL: pembalik RAK yang menunjuk jurnal bukan milik baris RAK
    await jurnalMentah('j-bukan-rak', '2026-06-02', 'MODAL_AWAL', null, [[ACC.kas, 100, 0], [ACC.modal, 0, 100]], 'REVERSED');
    await jurnalMentah('j-orphan', '2026-06-03', 'RAK', 'j-bukan-rak', [[ACC.kas, 0, 100], [ACC.modal, 100, 0]]);

    // HISTORICAL_GAP (edit lama kehilangan RAKU)
    await jurnalMentah('j-ed-old', '2026-07-01', 'RAK', null, [[ACC.rak, 400_000, 0], [ACC.kas, 0, 400_000]], 'REVERSED');
    await jurnalMentah('j-ed-old-r', '2026-07-02', 'RAK', 'j-ed-old', [[ACC.rak, 0, 400_000], [ACC.kas, 400_000, 0]]);
    await testDb.runAsync(`UPDATE journal SET reversed_by_id = 'j-ed-old-r' WHERE id = 'j-ed-old'`);
    await rakMentah('r-ed-old', 'RAK-ED-OLD', 'DIBATALKAN', 400_000, '2026-07-01', 'j-ed-old', { unit: 'unit-a', alokasi: 'MODAL_TETAP' });
    await jurnalMentah('j-ed-new', '2026-07-02', 'RAK', null, [[ACC.rak, 400_000, 0], [ACC.kas, 0, 400_000]]);
    await rakMentah('r-ed-new', 'RAK-ED-NEW', 'AKTIF', 400_000, '2026-07-02', 'j-ed-new', { reversalOf: 'r-ed-old' });

    const hitungTulis = async () => testDb.getFirstAsync<any>(
      `SELECT (SELECT COUNT(*) FROM journal) j, (SELECT COUNT(*) FROM journal_entry) e, (SELECT COUNT(*) FROM rak_transaksi) r,
              (SELECT COUNT(*) FROM audit_log) a, (SELECT group_concat(status) FROM (SELECT status FROM rak_transaksi ORDER BY id)) s`
    );
    const sebelum = await hitungTulis();
    const diag = await diagnosaHistoriRAK(testDb as any);
    expect(await hitungTulis()).toEqual(sebelum); // read-only

    const kode = (id: string) => diag.baris.find((b) => b.rakId === id)!.kode;
    expect(kode(ok.id)).toEqual(['BALANCED']);
    expect(kode(okTarik.id)).toEqual(['BALANCED']);
    // Baris DIBATALKAN tanpa audit T13 juga HISTORICAL_GAP (keterangan asal tak terjamin) — dua temuan terpisah.
    expect(kode('r-gap')).toEqual(['GAP', 'HISTORICAL_GAP']);
    expect(kode('r-dup')).toEqual(expect.arrayContaining(['DUPLICATE_REVERSAL', 'PERIOD_MISMATCH', 'HISTORICAL_GAP']));
    expect(kode('r-out')).toEqual(['OUTSTANDING_MISMATCH']);
    expect(kode('r-mis')).toEqual(['JOURNAL_MISMATCH']);
    expect(kode('r-ed-new')).toEqual(['HISTORICAL_GAP']);
    const tj = diag.temuanJurnal.map((t) => `${t.kode}:${t.journalId}`);
    expect(tj).toEqual(expect.arrayContaining(['MISSING_SOURCE:j-yatim', 'ORPHAN_REVERSAL:j-orphan']));
    expect(diag.temuanJurnal.some((t) => t.kode === 'OUTSTANDING_MISMATCH')).toBe(true);

    const hg = diag.baris.flatMap((b) => b.temuan).filter((t) => t.kode === 'HISTORICAL_GAP');
    expect(hg.every((t) => t.deterministik === false)).toBe(true);
    expect(diag.koreksiOtomatis).toBe(false);
  });

  it('K2 — saldo kumulatif negatif akibat pembalik mendahului asal terdeteksi (PERIOD_MISMATCH tingkat buku besar)', async () => {
    await jurnalMentah('j-fut', '2026-12-20', 'RAK', null, [[ACC.rak, 1_000_000, 0], [ACC.kas, 0, 1_000_000]], 'REVERSED');
    await jurnalMentah('j-fut-r', '2026-09-17', 'RAK', 'j-fut', [[ACC.rak, 0, 1_000_000], [ACC.kas, 1_000_000, 0]]);
    await testDb.runAsync(`UPDATE journal SET reversed_by_id = 'j-fut-r' WHERE id = 'j-fut'`);
    await rakMentah('r-fut', 'RAK-FUT', 'DIBATALKAN', 1_000_000, '2026-12-20', 'j-fut');
    const diag = await diagnosaHistoriRAK(testDb as any);
    expect(diag.saldo.saldoRakTerendah).toEqual({ tanggal: '2026-09-17', saldo: -1_000_000 });
    expect(diag.temuanJurnal.some((t) => t.kode === 'PERIOD_MISMATCH')).toBe(true);
    expect(diag.baris[0].kode).toEqual(expect.arrayContaining(['PERIOD_MISMATCH']));
  });
});

describe('RC-S54 T14 #19 — K3. JOURNAL_MISMATCH: pembalik bukan cerminan', () => {
  it.each([
    ['nominal berbeda', [[ 'acc-rak', 0, 900_000 ], [ 'acc-kas', 900_000, 0 ]]],
    ['arah berbeda', [[ 'acc-rak', 1_000_000, 0 ], [ 'acc-kas', 0, 1_000_000 ]]],
    ['akun berbeda', [[ 'acc-rak', 0, 1_000_000 ], [ 'acc-bank', 1_000_000, 0 ]]],
  ] as [string, [string, number, number][]][])('K3 — %s → JOURNAL_MISMATCH; database tidak berubah', async (_label, lines) => {
    const now = new Date().toISOString();
    await jurnalMentah('j-asal', '2026-03-01', 'RAK', null, [[ACC.rak, 1_000_000, 0], [ACC.kas, 0, 1_000_000]], 'REVERSED');
    await jurnalMentah('j-rev', '2026-03-05', 'RAK', 'j-asal', lines);
    await testDb.runAsync(`UPDATE journal SET reversed_by_id = 'j-rev' WHERE id = 'j-asal'`);
    await testDb.runAsync(
      `INSERT INTO rak_transaksi (id, nomor_rak, jenis_rak, nama_unit, jumlah, tanggal, sumber_dana, status, journal_id, created_by, created_at, updated_at)
       VALUES ('r-k3','RAK-K3','PENYALURAN_DANA','Cabang',1000000,'2026-03-01','KAS','DIBATALKAN','j-asal','user-1',?,?)`,
      now, now
    );
    const dump = async () => JSON.stringify([
      await testDb.getAllAsync(`SELECT * FROM journal ORDER BY id`),
      await testDb.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`),
      await testDb.getAllAsync(`SELECT * FROM rak_transaksi ORDER BY id`),
      await testDb.getAllAsync(`SELECT * FROM audit_log ORDER BY id`),
    ]);
    const sebelum = await dump();
    const diag = await diagnosaHistoriRAK(testDb as any);
    expect(await dump()).toBe(sebelum);
    const t = diag.baris[0].temuan.filter((x) => x.kode === 'JOURNAL_MISMATCH');
    expect(t.map((x) => x.detail)).toContain('Jurnal pembalik bukan cerminan tepat jurnal asal (nilai/akun/arah berbeda).');
    expect(t.find((x) => /cerminan/.test(x.detail))?.journalId).toBe('j-rev');
    expect(diag.koreksiOtomatis).toBe(false);
  });

  it('K3 kontrol — pembalik cerminan tepat tidak menghasilkan JOURNAL_MISMATCH', async () => {
    await jurnalMentah('j-asal', '2026-03-01', 'RAK', null, [[ACC.rak, 1_000_000, 0], [ACC.kas, 0, 1_000_000]], 'REVERSED');
    await jurnalMentah('j-rev', '2026-03-05', 'RAK', 'j-asal', [[ACC.rak, 0, 1_000_000], [ACC.kas, 1_000_000, 0]]);
    await testDb.runAsync(`UPDATE journal SET reversed_by_id = 'j-rev' WHERE id = 'j-asal'`);
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO rak_transaksi (id, nomor_rak, jenis_rak, nama_unit, jumlah, tanggal, sumber_dana, status, journal_id, created_by, created_at, updated_at)
       VALUES ('r-k3','RAK-K3','PENYALURAN_DANA','Cabang',1000000,'2026-03-01','KAS','DIBATALKAN','j-asal','user-1',?,?)`,
      now, now
    );
    const diag = await diagnosaHistoriRAK(testDb as any);
    expect(diag.baris[0].kode).not.toContain('JOURNAL_MISMATCH');
  });
});

describe('RC-S54 T14 #19 — POLICY-A tidak memengaruhi transaksi non-RAK', () => {
  it.each(['KAS_PENERIMAAN_LAIN', 'BANK_PENGELUARAN_LAIN', 'SIMPANAN_SUKARELA'])('%s di periode CLOSED tetap tidak dapat dikoreksi dari History', async (sumber) => {
    await jurnalMentah('j-non-rak', '2025-08-01', sumber, null, [[ACC.kas, 500_000, 0], [ACC.modal, 0, 500_000]]);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2025'`);
    const d = await getHistoryDetail('j-non-rak');
    expect(d).toMatchObject({ canDelete: false, canEdit: false, aksiTidakTersediaAlasan: 'Transaksi ini berada pada periode akuntansi yang sudah ditutup (CLOSED).' });
  });
});

describe('RC-S54 T13 #19 — STATIC', () => {
  const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('diagnostik tidak menulis database; RAKService tidak menghapus/menimpa jurnal', () => {
    expect(strip(baca('src/services/RAKDiagnosticService.ts'))).not.toMatch(/INSERT INTO|UPDATE \w+ SET|DELETE FROM|createJournal|reverseJournal|withTransaction/);
    const svc = strip(baca('src/services/RAKService.ts'));
    expect(svc).not.toMatch(/DELETE FROM|UPDATE journal|UPDATE journal_entry/);
    expect(svc).not.toMatch(/SET status = 'DIBATALKAN', keterangan/);
  });

  it('POLICY-C — hanya pembalikan penuh: tidak ada API/argumen nominal parsial pada Tarik Dana', () => {
    const svc = strip(baca('src/services/RAKService.ts'));
    expect(svc).toMatch(/export async function batalkanRAK\(id: string, userId: string, alasan: string\)/);
    expect(svc).not.toMatch(/sebagian|parsial|partial/i);
    expect(svc).toMatch(/reverseJournal\(db, original\.journal_id, userId, alasan\)/);
  });
});
