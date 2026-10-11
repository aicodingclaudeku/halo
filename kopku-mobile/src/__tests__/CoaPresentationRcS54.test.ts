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

describe('RC-S54 T16 #14-C — pembuktian opsi penyajian 2-1300 (fixture EIR FLAT VERIFIED)', () => {
  it('kredit -> debit -> jatuh tempo akhir: pengukuran identik di A/B/C; A/B asimetris & memutus Neraca Saldo; C diungkapkan CALK', async () => {
    const id = await pinjaman('FLAT');
    const jadwal = await getJadwalAngsuran(id);
    const titik: Titik[] = [];
    for (let k = 0; k < jadwal.length; k++) {
      const due = jadwal[k].tanggalJatuhTempo;
      await prosesEirBulanan({ pinjamanId: id, periode: due.slice(0, 7), createdBy: 'user-1', tanggalLaporan: due });
      await bayarAngsuran({ pinjamanId: id, jadwalId: jadwal[k].id, tanggal: due, nominal: jadwal[k].total, sumberDana: 'KAS', createdBy: 'user-1' });

      const pengukuranSebelum = await snapshotPengukuran();
      const inv = (await hitungInvarianFeeEir(await getDb(), id))!;
      const posisi = await getPosisiKeuangan(testDb as never, due);
      const tb = await getTrialBalance(testDb as never, due);
      const lhu = await getLHU(testDb as never, '2026-01-01', due);
      const arus = await getArusKas(testDb as never, '2026-01-01', due);
      const calk = await generateCALK(testDb as never, '2026-01-01', due);
      const diag = await diagnosaPenyajianCoaItem14(testDb as never, due);
      // Laporan & diagnostik read-only: jurnal, entri, subledger EIR tidak berubah.
      expect(await snapshotPengukuran()).toEqual(pengukuranSebelum);
      expect((await rekonsiliasiDeferredIncome(await getDb())).variance).toBe(0);

      const baris = tb.rows.find((r) => r.kode === '2-1300');
      const tb2_1300 = baris ? baris.kredit - baris.debit : 0;

      titik.push({
        due, D: inv.saldoKomponenEir, P: saldo(posisi.aset, '1-1200'), L: saldo(posisi.liabilitas, '2-1300'),
        TA: posisi.totalAset, TL: posisi.totalLiabilitas, TE: posisi.totalEkuitas, tb2_1300,
        lhu: JSON.stringify(lhu), arus: JSON.stringify(arus), calkPiutang: calk.sections.find((s) => s.sectionKey === 'piutang')!.konten,
        diag: diag.filter((t) => t.kode === 'SALDO_DEBIT_2_1300').map((t) => `${t.saldo}:${t.koreksiDeterministik}`),
      });
    }

    // Model terkunci: GL 2-1300 = komponen EIR (fixture tanpa deferral kontraktual), Neraca Saldo = Posisi Keuangan.
    for (const t of titik) {
      expect(t.L).toBe(t.D);
      expect(t.tb2_1300).toBe(t.L);
    }
    const kredit = titik.filter((t) => t.D > 0);
    const debit = titik.filter((t) => t.D < 0);
    const akhir = titik[titik.length - 1];
    expect(kredit.length).toBeGreaterThan(0);
    expect(debit.length).toBeGreaterThan(0);
    expect(akhir.D).toBe(0);

    for (const t of titik) {
      const porsiDebit = Math.max(0, -t.D);
      const opsi = {
        C: { TA: t.TA, TL: t.TL, piutang: t.P, dimuka: t.L, asetEir: 0 },
        A: { TA: t.TA + porsiDebit, TL: t.TL + porsiDebit, piutang: t.P + porsiDebit, dimuka: t.L + porsiDebit, asetEir: 0 },
        B: { TA: t.TA + porsiDebit, TL: t.TL + porsiDebit, piutang: t.P, dimuka: t.L + porsiDebit, asetEir: porsiDebit },
      };
      for (const o of Object.values(opsi)) {
        // Ekuitas identik; neraca tetap seimbang.
        expect(o.TA - o.TL).toBe(t.TA - t.TL);
        // Amortized cost identik: (piutang + aset EIR) − komponen EIR tersisa di 2-1300.
        expect(o.piutang + o.asetEir - o.dimuka).toBe(t.P - t.D);
      }
      // A/B: baris 2-1300 di Posisi Keuangan ≠ Neraca Saldo selama komponen debit.
      expect(opsi.A.dimuka === t.tb2_1300).toBe(porsiDebit === 0);
      expect(opsi.B.dimuka === t.tb2_1300).toBe(porsiDebit === 0);
    }
    // Asimetri A/B: komponen kredit (fee belum diamortisasi) TETAP di liabilitas, komponen debit dipindah —
    // instrumen yang sama disajikan dengan dua cara berbeda antar periode.
    expect(kredit.every((t) => t.L > 0)).toBe(true);

    // LHU & Arus Kas (metode langsung) tidak bergantung opsi: EIR non-kas; laporan dihitung dari ledger yang sama.
    for (const t of titik) expect(JSON.parse(t.arus).operasi).toBeDefined();

    // Opsi C: pengungkapan CALK tepat saat 2-1300 debit; tidak ada saat kredit & jatuh tempo akhir.
    for (const t of debit) {
      expect(t.calkPiutang).toContain(`bersaldo debit Rp${(-t.D).toLocaleString('id-ID')}`);
      expect(t.diag).toEqual([`${t.D}:true`]);
    }
    for (const t of [...kredit, akhir]) {
      expect(t.calkPiutang).not.toContain('bersaldo debit');
      expect(t.diag).toEqual([]);
    }
  });

  it('blocker A/B: komponen EIR subledger tidak dapat dibaca per tanggal; GL 2-1300 dapat', async () => {
    const id = await pinjaman('FLAT');
    const jadwal = await getJadwalAngsuran(id);
    for (const j of jadwal) {
      await prosesEirBulanan({ pinjamanId: id, periode: j.tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: j.tanggalJatuhTempo });
      await bayarAngsuran({ pinjamanId: id, jadwalId: j.id, tanggal: j.tanggalJatuhTempo, nominal: j.total, sumberDana: 'KAS', createdBy: 'user-1' });
    }
    const tengah = jadwal[5].tanggalJatuhTempo;
    const posisiTengah = await getPosisiKeuangan(testDb as never, tengah);
    expect(saldo(posisiTengah.liabilitas, '2-1300')).toBeLessThan(0);
    // Satu-satunya sumber komponen EIR tidak menerima tanggal: selalu keadaan TERKINI (0 setelah lunas).
    expect(totalKomponenEirDi2_1300.length).toBe(1);
    expect(await totalKomponenEirDi2_1300(await getDb())).toBe(0);
    // Penyajian ulang A/B untuk Posisi Keuangan historis akan memakai angka yang salah (0), atau menuntut
    // pembacaan komponen per tanggal di modul EIR (#12) — di luar batas presentation layer.
    const calkTengah = (await generateCALK(testDb as never, '2026-01-01', tengah)).sections.find((s) => s.sectionKey === 'piutang')!.konten;
    expect(calkTengah).toContain(`bersaldo debit Rp${(-saldo(posisiTengah.liabilitas, '2-1300')).toLocaleString('id-ID')}`);
  });

  it('STATIC: opsi C tidak menyentuh journal engine, modul EIR, mapping, atau skema', () => {
    const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fr = strip(baca('src/reports/FinancialReports.ts'));
    expect(fr).not.toMatch(/2-1300|totalKomponenEirDi2_1300|hitungInvarianFeeEir/);
    expect(fr).toMatch(/resolveAccountId\(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA'\)/);
    for (const f of ['src/accounting/AccountingEngine.ts', 'src/services/EirAccountingService.ts', 'src/accounting/EirFeeInvariant.ts']) {
      expect(baca(f)).not.toMatch(/RC-S54 TAHAP 16/);
    }
  });
});
