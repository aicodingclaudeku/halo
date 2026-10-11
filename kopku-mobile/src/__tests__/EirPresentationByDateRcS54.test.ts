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

import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran } from '@/services/PinjamanService';
import { prosesEirBulanan } from '@/services/EirAccountingService';
import { hitungInvarianFeeEir, totalKomponenEirDi2_1300 } from '@/accounting/EirFeeInvariant';
import { rekonsiliasiDeferredIncome } from '@/accounting/DeferredIncomeReconciliation';
import { getPosisiKeuangan, getLHU, getArusKas, generateCALK } from '@/reports/FinancialReports';
import { getTrialBalance } from '@/accounting/Ledger';
import { diagnosaPenyajianCoaItem14 } from '@/services/CoaResolutionService';
import { getKomponenEirPerTanggal, getPenyajianAmortizedCostPerTanggal } from '@/accounting/EirPresentationReadModel';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { getDb } from '@/database/db';

/**
 * RC-S54 TAHAP 16 — ITEM #14-C: KEPUTUSAN PENYAJIAN SALDO DEBIT 2-1300.
 *
 * Fixture EIR VERIFIED (EirAmortizedCostRcS54): FLAT 12 jt / 12 bulan / fee
 * integral 240.000, alur produksi cair -> prosesEirBulanan -> bayarAngsuran.
 * Pada setiap jatuh tempo laporan NYATA dibaca, lalu opsi A/B dihitung
 * sebagai penyajian ulang di atas angka yang sama:
 *   C  : apa adanya (implementasi);
 *   A  : porsi debit komponen EIR dinetto ke Piutang Pinjaman;
 *   B  : porsi debit komponen EIR direklasifikasi ke baris aset tersendiri.
 * Dibuktikan: pengukuran (amortized cost, ekuitas, LHU, arus kas) identik di
 * ketiga opsi; A/B memutus Posisi Keuangan = Neraca Saldo dan bersifat
 * asimetris; komponen EIR tidak tersedia per tanggal (blocker A/B).
 */

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}
async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${transactionType}-${role}`, transactionType, role, accountId);
}

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanAdmin: 'acc-pendapatan-admin',
  penyisihan: 'acc-penyisihan',
  bebanPenyisihan: 'acc-beban-penyisihan',
  modal: 'acc-modal',
};
const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan Pinjaman', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  // FIXTURE FIX: lunasiPinjaman() memakai mapping ini untuk jasa
  // kontraktual yang BELUM jatuh tempo saat pelunasan dipercepat
  // (Pendapatan Diterima Dimuka 2-1300 existing) — mapping produksi
  // sudah benar, fixture-nya yang belum menyeed.
  await seedMapping(db, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(db, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  // FINAL FIX AKRUAL (BUG 4/5/7): jasa yang kasnya diterima SEBELUM jatuh tempo
  // -> Pendapatan Diterima Dimuka (2-1300 existing), dilepas saat periode jatuh tempo.
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan);
  await seedMapping(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID,
    'A001',
    '1234567890123456',
    'Budi',
    '2020-01-01',
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);
  await db.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sp-fixture',?,'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  await db.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sw-fixture',?,'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  return db;
}


type Metode = 'EFEKTIF' | 'MENURUN' | 'FLAT';
const POKOK = 12_000_000;
const FEE = 240_000;
const CAIR = '2026-01-15';

async function tambahPeriode(): Promise<void> {
  for (const th of [2027, 2028]) {
    await testDb.runAsync(
      `INSERT OR IGNORE INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `period-${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
}

let urutPinjaman = 0;
async function pinjaman(metode: Metode, fee = FEE, opsi: { anggotaId?: string; pokok?: number } = {}): Promise<string> {
  await tambahPeriode();
  const { id } = await ajukanPinjaman({
    anggotaId: opsi.anggotaId ?? ANGGOTA_ID,
    tanggal: CAIR,
    jumlahPinjaman: opsi.pokok ?? POKOK,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: metode,
    persentaseJasa: 1.5,
    biayaAdminTipe: fee > 0 ? 'NOMINAL' : 'TIDAK_ADA',
    biayaAdminNilai: fee,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  urutPinjaman++;
  await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: CAIR });
  return id;
}


async function snapshotPengukuran() {
  return JSON.parse(JSON.stringify({
    jurnal: await testDb.getAllAsync(`SELECT * FROM journal ORDER BY id`),
    entri: await testDb.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`),
    subledger: await testDb.getAllAsync(`SELECT * FROM pinjaman_akuntansi_jasa ORDER BY rowid`),
  }));
}

const saldo = (rows: { kode: string; saldo: number }[], kode: string) => rows.find((r) => r.kode === kode)?.saldo ?? 0;

interface Titik {
  due: string; D: number; P: number; L: number; TA: number; TL: number; TE: number; tb2_1300: number;
  lhu: string; arus: string; calkPiutang: string; diag: string[];
}

beforeEach(async () => {
  testDb = await setupFixture();
  // Fixture EIR memakai sumber 'MODAL_AWAL' (tidak dikenal Arus Kas) untuk modal awal di dalam periode laporan.
  // Laporan Arus Kas dibaca di test ini, jadi sumbernya diganti MODAL_UANG (PENDANAAN) — nominal & akun sama.
  await testDb.runAsync(`UPDATE journal SET sumber_transaksi = 'MODAL_UANG' WHERE id = 'journal-modal-awal'`);
});


/**
 * RC-S54 TAHAP 16 — GAP 7: komponen EIR & amortized cost PER TANGGAL (read model).
 * Fixture EIR VERIFIED (FLAT 12 bulan, fee integral 240.000). Setiap tanggal dibandingkan
 * dengan GL pada tanggal yang sama — dihitung ulang SETELAH seluruh tenor selesai, sehingga
 * pembacaan "keadaan terkini" pasti gagal.
 */
describe('RC-S54 T16 GAP 7 — getKomponenEirPerTanggal', () => {
  it('sebelum EIR, kredit, debit, jatuh tempo, setelah lunas: D_tanggal = GL 2-1300 pada tanggal yang sama', async () => {
    const id = await pinjaman('FLAT');
    const jadwal = await getJadwalAngsuran(id);
    const cairTgl = (await testDb.getFirstAsync<{ t: string }>(`SELECT substr(j.tanggal,1,10) AS t FROM pinjaman_akuntansi_jasa p JOIN journal j ON j.id = p.journal_id WHERE p.pinjaman_id = ? AND p.tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`, id))!.t;
    const Dterkini: Record<string, number> = {};
    for (const j of jadwal) {
      await prosesEirBulanan({ pinjamanId: id, periode: j.tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: j.tanggalJatuhTempo });
      await bayarAngsuran({ pinjamanId: id, jadwalId: j.id, tanggal: j.tanggalJatuhTempo, nominal: j.total, sumberDana: 'KAS', createdBy: 'user-1' });
      Dterkini[j.tanggalJatuhTempo] = (await hitungInvarianFeeEir(await getDb(), id))!.saldoKomponenEir;
    }
    // Setelah lunas, sumber lama tanpa tanggal selalu 0.
    expect(await totalKomponenEirDi2_1300(await getDb())).toBe(0);

    const sebelum = new Date(Date.parse(cairTgl) - 86400000).toISOString().slice(0, 10);
    expect(await getKomponenEirPerTanggal(testDb as never, id, sebelum)).toMatchObject({ feeAwal: 0, komponenEir: 0, komponenEirGl: 0 });
    expect(await getKomponenEirPerTanggal(testDb as never, id, cairTgl)).toMatchObject({ feeAwal: 240_000, komponenEir: 240_000, selisihGl: 0 });

    let kredit = 0, debit = 0;
    for (const j of jadwal) {
      const t = j.tanggalJatuhTempo;
      const k = (await getKomponenEirPerTanggal(testDb as never, id, t))!;
      const posisi = await getPosisiKeuangan(testDb as never, t);
      const gl = posisi.liabilitas.find((r) => r.kode === '2-1300')?.saldo ?? 0;
      expect(k.komponenEir).toBe(Dterkini[t]);
      expect(k.komponenEir).toBe(gl);
      expect(k.komponenEirGl).toBe(gl);
      if (k.komponenEir > 0) kredit += 1;
      if (k.komponenEir < 0) debit += 1;
    }
    expect(kredit).toBeGreaterThan(0);
    expect(debit).toBeGreaterThan(0);
    const akhir = jadwal[jadwal.length - 1].tanggalJatuhTempo;
    expect((await getKomponenEirPerTanggal(testDb as never, id, akhir))!.komponenEir).toBe(0);
    expect((await getKomponenEirPerTanggal(testDb as never, id, '2030-12-31'))!.komponenEir).toBe(0);
    // Tengah bulan: memakai jurnal sampai tanggal itu saja.
    const tengah = jadwal[4].tanggalJatuhTempo;
    const hariSebelumTengah = new Date(Date.parse(tengah) - 86400000).toISOString().slice(0, 10);
    expect((await getKomponenEirPerTanggal(testDb as never, id, hariSebelumTengah))!.komponenEir).toBe(Dterkini[jadwal[3].tanggalJatuhTempo]);
  });

  it('jurnal EIR yang dibalik: kontribusi hilang sejak tanggal pembalik, tidak sebelumnya', async () => {
    const id = await pinjaman('FLAT');
    const jadwal = await getJadwalAngsuran(id);
    await prosesEirBulanan({ pinjamanId: id, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: jadwal[0].tanggalJatuhTempo });
    const baris = await testDb.getFirstAsync<{ journal_id: string; pendapatan_akuntansi: number }>(`SELECT journal_id, pendapatan_akuntansi FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY'`, id);
    const t0 = jadwal[0].tanggalJatuhTempo;
    const sebelumBalik = (await getKomponenEirPerTanggal(testDb as never, id, t0))!;
    await testDb.withTransactionAsync(async () => { await reverseJournal(testDb as never, baris!.journal_id, 'user-1', 'uji'); });
    const tglBalik = (await testDb.getFirstAsync<{ t: string }>(`SELECT substr(tanggal,1,10) AS t FROM journal WHERE reversal_of_id = ?`, baris!.journal_id))!.t;
    expect((await getKomponenEirPerTanggal(testDb as never, id, t0))).toEqual(sebelumBalik);
    const sesudah = (await getKomponenEirPerTanggal(testDb as never, id, tglBalik))!;
    expect(sesudah.komponenEir).toBe(240_000);
    expect(sesudah.komponenEirGl).toBe(240_000);
  });
});

describe('RC-S54 T16 GAP 7 — read model amortized cost & OPSI C', () => {
  it('piutang kontraktual − komponen EIR = amortized cost; deferred non-EIR terpisah; posisi 2-1300; read-only', async () => {
    const id = await pinjaman('FLAT');
    const jadwal = await getJadwalAngsuran(id);
    for (const j of jadwal.slice(0, 5)) {
      await prosesEirBulanan({ pinjamanId: id, periode: j.tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: j.tanggalJatuhTempo });
      await bayarAngsuran({ pinjamanId: id, jadwalId: j.id, tanggal: j.tanggalJatuhTempo, nominal: j.total, sumberDana: 'KAS', createdBy: 'user-1' });
    }
    const t = jadwal[4].tanggalJatuhTempo;
    const awal = await snapshotPengukuran();
    const rm = await getPenyajianAmortizedCostPerTanggal(testDb as never, t);
    expect(await snapshotPengukuran()).toEqual(awal);
    const posisi = await getPosisiKeuangan(testDb as never, t);
    expect(rm.piutangKontraktual).toBe(saldo(posisi.aset, '1-1200'));
    expect(rm.saldoPendapatanDiterimaDimuka).toBe(saldo(posisi.liabilitas, '2-1300'));
    expect(rm.amortizedCost).toBe(rm.piutangKontraktual - rm.komponenEir);
    expect(rm.deferredIncomeNonEir).toBe(0);
    expect(rm.posisiPendapatanDiterimaDimuka).toBe('DEBIT');
    expect(rm.perPinjaman.map((p) => p.pinjamanId)).toEqual([id]);
    // OPSI C dipertahankan: Posisi Keuangan = Neraca Saldo; read model hanya dipakai pengungkapan CALK.
    const calk = await generateCALK(testDb as never, '2026-01-01', t);
    const lima = calk.sections.find((s) => s.sectionKey === 'piutang')!.konten;
    expect(lima).toContain(`nilai tercatat piutang pinjaman (biaya perolehan diamortisasi) Rp${rm.amortizedCost.toLocaleString('id-ID')}`);
    expect(lima).toContain(`komponen penyesuaian EIR debit Rp${Math.abs(rm.komponenEir).toLocaleString('id-ID')}`);
  });

  it('STATIC: read model tanpa tulis DB; modul EIR/solver/invarian/posting tidak berubah olehnya', () => {
    const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(strip(baca('src/accounting/EirPresentationReadModel.ts'))).not.toMatch(/INSERT INTO|UPDATE \w+ SET|DELETE FROM|createJournal|runAsync|withTransaction|totalKomponenEirDi2_1300|hitungInvarianFeeEir/);
    for (const f of ['src/services/EirAccountingService.ts', 'src/accounting/EirFeeInvariant.ts', 'src/accounting/AccountingEngine.ts']) {
      expect(baca(f)).not.toMatch(/EirPresentationReadModel|RC-S54 TAHAP 16/);
    }
  });
});
