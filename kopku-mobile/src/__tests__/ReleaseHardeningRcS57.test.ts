import { createTestDb, TestDb } from './testDb';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

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
  KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG,
  periodePertamaEligible,
  rateBulanan,
  daftarPeriodeKandidat,
  _resetGerbangAkrualUntukTest,
} from '@/services/UtangBungaAccrualService';
import {
  terimaUtang,
  bayarUtang,
  penyesuaianManualBungaUtang,
  getKontrolGapUtangBunga,
  replayBungaUtang,
} from '@/services/UtangService';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { getTrialBalance } from '@/accounting/Ledger';
import { getLabaRugi, getArusKas, getPosisiKeuangan } from '@/reports/FinancialReports';
import { getKebijakanAkuntansiNarasi } from '@/services/AccountingPolicyService';
import { CASH_FLOW_CLASSIFICATION } from '@/accounting/CashFlowClassification';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * RC-S57 — FINAL RELEASE HARDENING.
 *
 * Suite ini TIDAK membangun ulang mesin dan TIDAK menguji ulang yang sudah
 * dikunci RC-S55/RC-S56. Ia mengunci tiga hal yang baru di RC-S57:
 *   1. konsistensi kebijakan (narasi CALK <-> kode) — tidak ada lagi area yang
 *      menyatakan bunga "diakrual manual" sebagai perlakuan normal;
 *   2. batas arsitektur statis — posting otomatis hanya lewat mesin, jalur
 *      manual tidak pernah menjadi pemicu otomatis, tanpa timer;
 *   3. siklus akuntansi ujung-ke-ujung sampai LAPORAN (neraca saldo, LHU,
 *      posisi keuangan, arus kas), bukan hanya saldo akun.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function semuaSumberProduksi(): string[] {
  const hasil: string[] = [];
  const telusur = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (f === '__tests__' || f === 'test-utils' || f === 'node_modules') continue;
        telusur(p);
      } else if (/\.(ts|tsx)$/.test(f)) hasil.push(p);
    }
  };
  telusur(join(ROOT, 'src'));
  telusur(join(ROOT, 'app'));
  return hasil;
}
const rel = (p: string) => p.slice(ROOT.length + 1);
function pemakai(pola: RegExp, kecuali: string[] = []): string[] {
  return semuaSumberProduksi()
    .filter((p) => pola.test(tanpaKomentar(readFileSync(p, 'utf8'))))
    .map(rel)
    .filter((r) => !kecuali.includes(r))
    .sort();
}

// ---------------------------------------------------------------------------
// Fixture (pola sama dengan UtangBungaLifecycleRcS56)
// ---------------------------------------------------------------------------

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  utangBank: 'acc-2-2100',
  utangBunga: 'acc-2-1700',
  bebanBunga: 'acc-5-1950',
  modal: 'acc-3-1000',
};

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

beforeEach(async () => {
  _resetGerbangAkrualUntukTest();
  testDb = await createTestDb();
  const now = new Date().toISOString();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.utangBank, '2-2100', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.utangBunga, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BANK', 'DEBIT_DEFAULT', ACC.utangBank);
  await seedMapping(testDb, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(testDb, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga);

  for (const th of [2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  // Modal awal kas 500.000.000 (tahun sebelumnya) supaya pembayaran tidak ditolak saldo.
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES ('j-awal','JRN-SEED','2025-12-31','p2025','SALDO_AWAL','Saldo awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je1','j-awal',?,500000000,0,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je2','j-awal',?,0,500000000,1)`,
    ACC.modal
  );
});

afterEach(() => testDb.closeSync());

/** 120.000.000 × 12%/tahun FLAT = 1.200.000 per bulan (WHOLE_MONTH). */
async function buatUtang(): Promise<string> {
  const r = await terimaUtang({
    namaPemberi: 'Bank ABC',
    jenisPemberi: 'BANK',
    pokokPinjaman: 120_000_000,
    persenBunga: 12,
    jenisBunga: 'FLAT',
    basisBunga: 'TAHUNAN',
    tanggal: '2026-01-01',
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return r.id;
}

async function saldo(accountId: string, sisi: 'debit' | 'kredit', sampai = '9999-12-31'): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.${sisi} - je.${sisi === 'debit' ? 'kredit' : 'debit'}),0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') AND j.tanggal <= ?`,
    accountId,
    sampai
  );
  return r?.s ?? 0;
}

async function jumlahJurnalBungaUtang(): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE sumber_transaksi='UTANG_BUNGA'`);
  return r?.n ?? 0;
}

async function laporanKonsisten(akhir: string) {
  const tb = await getTrialBalance(testDb as any, akhir);
  expect(tb.isBalanced).toBe(true);
  expect(tb.totalDebit).toBe(tb.totalKredit);
  const pk = await getPosisiKeuangan(testDb as any, akhir);
  expect(pk.selisih).toBe(0);
  return { tb, pk };
}

// ===========================================================================
// 1. KONSISTENSI KEBIJAKAN — narasi CALK <-> kode
// ===========================================================================

describe('RC-S57 §1/§5 KONSISTENSI KEBIJAKAN', () => {
  const narasi = () => {
    const semua = getKebijakanAkuntansiNarasi();
    const cari = (area: string) => {
      const x = semua.find((n) => n.area === area);
      if (!x) throw new Error(`area ${area} tidak ada`);
      return x;
    };
    return { semua, cari };
  };

  it('tidak ada area yang menyatakan bunga utang "diakrual (secara) manual" atau diakui "pada saat dibayar" sebagai perlakuan normal', () => {
    const { semua } = narasi();
    // Cakupan: narasi yang membahas bunga/utang. Area lain (mis. imbalan_kerja)
    // sah memakai akrual manual untuk topiknya sendiri dan tidak diuji di sini.
    const terkait = semua.filter((n) => /bunga|biaya pinjaman|\butang\b/i.test(`${n.judul} ${n.narasi}`));
    for (const a of ['bunga_utang', 'utang', 'biaya_pinjaman']) expect(terkait.map((n) => n.area)).toContain(a);
    for (const n of terkait) {
      expect(`${n.area}: ${n.narasi}`).not.toMatch(/diakrual (secara )?manual/i);
      expect(`${n.area}: ${n.narasi}`).not.toMatch(/[Bb]eban bunga diakui pada saat dibayar/);
    }
  });

  it('area utang & biaya_pinjaman merujuk kebijakan tunggal "Akrual Bunga Utang Koperasi" (bunga_utang)', () => {
    const { cari } = narasi();
    expect(cari('bunga_utang').judul).toBe('Akrual Bunga Utang Koperasi');
    expect(cari('utang').narasi).toMatch(/Akrual Bunga Utang Koperasi/);
    expect(cari('biaya_pinjaman').narasi).toMatch(/Akrual Bunga Utang Koperasi/);
  });

  it('area utang membedakan akrual otomatis, pelunasan Utang Bunga, beban saat bayar, dan manual sebagai pengecualian', () => {
    const t = narasi().cari('utang').narasi;
    expect(t).toMatch(/akrual otomatis/);
    expect(t).toMatch(/pelunasan Utang Bunga dan tidak diakui lagi sebagai beban/);
    expect(t).toMatch(/belum pernah diakrual diakui sebagai beban pada saat pembayaran/);
    expect(t).toMatch(/pengecualian dan pengendalian/);
  });

  it('sumberKode tidak lagi menunjuk akruiBungaUtang sebagai sumber perlakuan normal', () => {
    const { semua } = narasi();
    for (const n of semua) expect(`${n.area}: ${n.sumberKode}`).not.toMatch(/UtangService\.akruiBungaUtang/);
  });

  it('WHOLE_MONTH: konstanta kode == narasi CALK', () => {
    expect(KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG).toBe('WHOLE_MONTH');
    const t = narasi().cari('bunga_utang').narasi;
    expect(t).toMatch(/WHOLE_MONTH/);
    expect(t).toMatch(/tidak ada prorata harian/);
    expect(t).toMatch(/sejak tanggal 1/);
    expect(t).toMatch(/pelunasan di tengah bulan tidak mengurangi akrual bulan berjalan/);
    expect(t).toMatch(/pembagi 12/);
  });

  it('WHOLE_MONTH: perilaku kode sama dengan narasi (tanggal 1, bulan berikutnya, pembagi 12, tanpa day-count)', () => {
    expect(periodePertamaEligible('2026-01-01')).toBe('2026-01');
    expect(periodePertamaEligible('2026-01-02')).toBe('2026-02');
    expect(periodePertamaEligible('2026-01-31')).toBe('2026-02');
    // Pembandingan eksak lewat nominal Rupiah (hitungan float dibulatkan ke 1e-9).
    expect(Math.round(rateBulanan(12, 'TAHUNAN') * 1e9)).toBe(10_000_000);
    expect(Math.round(rateBulanan(1.5, 'BULANAN') * 1e9)).toBe(15_000_000);
    expect(daftarPeriodeKandidat('2026-01-15', '2026-04')).toEqual(['2026-02', '2026-03', '2026-04']);
    // Tidak ada konvensi hitung hari di kode mesin.
    const kode = tanpaKomentar(baca('src/services/UtangBungaAccrualService.ts'));
    expect(kode).not.toMatch(/\b365\b|\b360\b|ACT_365|30_360|30E|getDate\(\)|hariDalamBulan|dayCount/i);
  });

  it('dokumen arsitektur memisahkan IMPLEMENTED POLICY dari GOVERNANCE APPROVAL STATUS', () => {
    const f = 'RC-S57_AKRUAL_BUNGA_UTANG_ARCHITECTURE.md';
    expect(existsSync(join(ROOT, f))).toBe(true);
    const d = baca(f);
    expect(d).toMatch(/IMPLEMENTED POLICY/);
    expect(d).toMatch(/GOVERNANCE APPROVAL STATUS/);
    expect(d).toMatch(/PENDING FORMAL APPROVAL/);
    expect(d).toMatch(/WHOLE_MONTH/);
    expect(d).toMatch(/MANUAL_REVIEW_REQUIRED/);
    expect(d).toMatch(/derived|turunan/i);
    for (const doc of ['RC-S57_RELEASE_GATE.md', 'KNOWN_BASELINE_FAILURES.md', 'RC-S57_DEVICE_QA_CHECKLIST.md']) {
      expect(existsSync(join(ROOT, doc))).toBe(true);
    }
  });
});

// ===========================================================================
// 2. BATAS ARSITEKTUR STATIS
// ===========================================================================

describe('RC-S57 §10/§15 BATAS ARSITEKTUR STATIS', () => {
  const MESIN = 'src/services/UtangBungaAccrualService.ts';
  const LAYAR = 'src/screens/Transaksi/AkruiBungaUtangFormScreen.tsx';

  it('pemicu mesin otomatis hanya StartupTasks dan gerbang tutup periode', () => {
    // DIPERBARUI RC-S58: PeriodCloseService menjadi pemicu sah ketiga (gerbang tutup periode).
    // DIPERBARUI RC-S71: layar kontrol dihapus — pemicu tinggal StartupTasks & PeriodClose.
    expect(pemakai(/\bjalankanAkrualBungaUtangJikaPerlu\s*\(/, [MESIN])).toEqual(
      ['src/services/StartupTasks.ts', 'src/services/PeriodCloseService.ts'].sort()
    );
    // Fungsi inti tanpa gerbang tidak dipanggil langsung oleh siapa pun di produksi.
    expect(pemakai(/\bprosesAkrualBungaUtangOtomatis\s*\(/, [MESIN])).toEqual([]);
  });

  // DIPERBARUI RC-S71 (instruksi eksplisit pengguna): semula mengunci dua titik
  // pemanggilan di layar kontrol. Layar itu kini DIHAPUS dari runtime.
  it('layar kontrol akrual tidak ada lagi (RC-S71)', () => {
    expect(existsSync(join(ROOT, LAYAR))).toBe(false);
  });

  it('jalur manual tidak pernah menjadi pemicu otomatis dan tidak dipanggil UI', () => {
    for (const fn of ['akruiBungaUtang', 'penyesuaianManualBungaUtang']) {
      const pola = new RegExp(`\\b${fn}\\s*\\(`);
      // Hanya UtangService (definisi + penyesuaianManual -> akruiBungaUtang).
      expect(pemakai(pola)).toEqual(['src/services/UtangService.ts']);
    }
    const mesin = tanpaKomentar(baca(MESIN));
    expect(mesin).not.toMatch(/akruiBungaUtang|penyesuaianManualBungaUtang/);
    expect(tanpaKomentar(baca('src/services/StartupTasks.ts'))).not.toMatch(/akruiBungaUtang|penyesuaianManualBungaUtang/);
  });

  it('jurnal UTANG_BUNGA hanya dibuat oleh mesin dan UtangService, keduanya lewat createJournal', () => {
    expect(pemakai(/sumberTransaksi:\s*'UTANG_BUNGA'/)).toEqual([MESIN, 'src/services/UtangService.ts'].sort());
    for (const f of [MESIN, 'src/services/UtangService.ts']) {
      const s = tanpaKomentar(baca(f));
      expect(s).toMatch(/await createJournal\(/);
      expect(s).not.toMatch(/INSERT INTO journal\b|INSERT INTO journal_entry|UPDATE journal_entry|DELETE FROM journal/);
      expect(s).not.toMatch(/INSERT INTO kas_transaksi|INSERT INTO bank_transaksi|UPDATE account SET/);
    }
  });

  it('register utang_bunga_akrual hanya ditulis mesin (selain skema/migrasi)', () => {
    const penulis = pemakai(/(INSERT INTO|UPDATE|DELETE FROM)\s+utang_bunga_akrual/, ['src/database/db.ts', 'src/database/schema.ts']);
    expect(penulis).toEqual([MESIN]);
  });

  // DIPERBARUI RC-S71: layar kontrol dihapus; layar status (Daftar Utang) ikut diperiksa.
  it('tidak ada timer/penjadwal di mesin, layar status, maupun StartupTasks', () => {
    for (const f of [MESIN, 'src/screens/Akuntansi/DaftarUtangScreen.tsx', 'src/services/StartupTasks.ts']) {
      expect(tanpaKomentar(baca(f))).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|BackgroundFetch|TaskManager\.defineTask/);
    }
    // Satu-satunya penjadwal OS di repo tetap milik simpanan berjangka, tidak ada yang baru untuk bunga utang.
    expect(pemakai(/defineTask\s*\(/)).toEqual(['src/services/SimpananBerjangkaBackgroundTask.ts']);
  });

  it('klasifikasi arus kas tidak berubah: akrual NON_KAS, pembayaran utang PENDANAAN', () => {
    expect(CASH_FLOW_CLASSIFICATION.UTANG_BUNGA).toBe('NON_KAS');
    expect(CASH_FLOW_CLASSIFICATION.UTANG_BANK).toBe('PENDANAAN');
  });

  it('tidak ada kenaikan versi skema di RC-S57', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    expect(baca('src/database/db.ts')).not.toMatch(/currentVersion < 82/); // DIPERBARUI v81 (blok v81 milik RC-S133.6.2, bukan tahap ini; ambang digeser ke 82). DIPERBARUI v80 (blok v80 milik RC-S132, bukan tahap ini; ambang digeser ke 81). DIPERBARUI v79 (blok v79 milik RC-S128, bukan tahap ini; ambang digeser ke 80). DIPERBARUI v78 (blok v78 milik fitur bunga harian sukarela, bukan tahap ini; ambang digeser ke 79). DIPERBARUI v77 (Poin 5/6/10): blok v77 milik patch 19 poin (kolom unit_usaha_id + klasifikasi/label akun), bukan tahap ini; ambang digeser ke 78.  DIPERBARUI RC-S88: blok v73 MILIK RC-S88 (nilai wajar/revaluasi); ambang digeser ke 74. // DIPERBARUI v72 = penarikan dana investasi (milik modul itu, bukan tahap ini) · · DIPERBARUI RESTRUKTURISASI DATA: blok v70 (asal personel) kini ADA dan MILIK restrukturisasi Data/Personel; ambang digeser ke 71 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: blok v74 MILIK RC-S100 (riwayat import data awal, dua tabel BARU aditif); ambang digeser ke 75 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji.
  });
});

// ===========================================================================
// 3. SIKLUS AKUNTANSI SAMPAI LAPORAN
// ===========================================================================

describe('RC-S57 §13/§14 SIKLUS AKUNTANSI & ARUS KAS', () => {
  it('UTANG -> AUTO ACCRUAL -> PAYMENT -> REPORT', async () => {
    const id = await buatUtang();
    const kasSetelahTerima = await saldo(ACC.kas, 'debit');
    expect(kasSetelahTerima).toBe(620_000_000);

    const h = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-31' });
    expect(h.jumlahJurnalBaru).toBe(3); // Jan, Feb, Mar — DIPERBARUI RC-S58: diproses 31 Mar (Maret selesai), bukan 15 Mar
    expect(h.totalDibukukan).toBe(3_600_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(3_600_000);
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(3_600_000);
    expect(await saldo(ACC.kas, 'debit')).toBe(kasSetelahTerima); // akrual tidak menyentuh kas

    // Arus kas periode yang HANYA berisi akrual: tidak ada kas yang bergerak.
    const akrualSaja = await getArusKas(testDb as any, '2026-02-01', '2026-03-31');
    expect(akrualSaja.perubahanKas).toBe(0);
    expect(akrualSaja.operasi + akrualSaja.investasi + akrualSaja.pendanaan).toBe(0);
    expect(akrualSaja.terekonsiliasi).toBe(true);

    await bayarUtang({ utangId: id, tanggal: '2026-04-10', pokok: 0, bunga: 3_600_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(3_600_000); // tidak ada beban kedua
    expect(await saldo(ACC.kas, 'debit')).toBe(kasSetelahTerima - 3_600_000);
    expect((await replayBungaUtang(testDb as any, id)).outstanding).toBe(0);

    // Arus kas periode pembayaran: keluar sebesar pembayaran aktual.
    const bayar = await getArusKas(testDb as any, '2026-04-01', '2026-04-30');
    expect(bayar.perubahanKas).toBe(-3_600_000);
    expect(bayar.operasi + bayar.investasi + bayar.pendanaan).toBe(-3_600_000);
    expect(bayar.terekonsiliasi).toBe(true);

    const lhu = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    expect(lhu.totalBeban).toBe(3_600_000);
    await laporanKonsisten('2026-12-31');
    expect((await getKontrolGapUtangBunga()).status).toBe('BALANCED');
  });

  it('UTANG -> AUTO ACCRUAL -> REVERSAL -> MANUAL ADJUSTMENT -> PAYMENT -> REPORT', async () => {
    const id = await buatUtang();
    const kasAwal = await saldo(ACC.kas, 'debit');
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-31' });

    const feb = await testDb.getFirstAsync<{ id: string }>(
      `SELECT id FROM journal WHERE sumber_transaksi='UTANG_BUNGA' AND sumber_id=? AND tanggal='2026-02-28' AND reversal_of_id IS NULL`,
      id
    );
    await reverseJournal(testDb as any, feb!.id, 'user-1', 'Koreksi kontrak Februari');
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(2_400_000);

    // Reversal FINAL bagi mesin: rerun tidak memposting ulang, melainkan melapor.
    const jurnalSebelum = await jumlahJurnalBungaUtang();
    const rerun = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-20' });
    expect(rerun.jumlahJurnalBaru).toBe(0);
    expect(await jumlahJurnalBungaUtang()).toBe(jurnalSebelum);
    const exc = rerun.exception.find((e) => e.kode === 'AKRUAL_DIREVERSAL');
    expect(exc?.periode).toBe('2026-02');
    expect(exc?.pesan).toMatch(/dibalik/);
    expect(exc?.pesan).toMatch(/penyesuaian manual/);

    // Penyesuaian manual teraudit menggantikan bunga Februari.
    const adj = await penyesuaianManualBungaUtang({
      utangId: id,
      tanggal: '2026-02-28',
      nominalTarget: 1_200_000,
      alasan: 'Pengganti akrual Februari setelah koreksi kontrak',
      createdBy: 'user-1',
    });
    expect(adj.dibukukanSekarang).toBe(1_200_000);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(3_600_000);
    const desk = await testDb.getFirstAsync<{ deskripsi: string }>(`SELECT deskripsi FROM journal WHERE id = ?`, adj.journalId);
    expect(desk!.deskripsi).toMatch(/Penyesuaian manual: Pengganti akrual Februari/);

    // Mesin tetap tidak menambah apa pun setelah penyesuaian.
    const lagi = await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-03-25' });
    expect(lagi.jumlahJurnalBaru).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(3_600_000);

    await bayarUtang({ utangId: id, tanggal: '2026-04-10', pokok: 10_000_000, bunga: 3_600_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect(await saldo(ACC.utangBunga, 'kredit')).toBe(0);
    expect(await saldo(ACC.bebanBunga, 'debit')).toBe(3_600_000);
    expect(await saldo(ACC.kas, 'debit')).toBe(kasAwal - 13_600_000);
    expect(await saldo(ACC.utangBank, 'kredit')).toBe(110_000_000);
    expect((await replayBungaUtang(testDb as any, id)).outstanding).toBe(0);

    const kas = await getArusKas(testDb as any, '2026-02-01', '2026-12-31');
    expect(kas.perubahanKas).toBe(-13_600_000); // reversal & penyesuaian tidak menggerakkan kas
    expect(kas.terekonsiliasi).toBe(true);
    const lhu = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    expect(lhu.totalBeban).toBe(3_600_000);
    await laporanKonsisten('2026-12-31');
    expect((await getKontrolGapUtangBunga()).status).toBe('BALANCED');
  });

  it('jurnal akrual otomatis tidak memuat satu baris pun pada akun kas/bank', async () => {
    await buatUtang();
    await prosesAkrualBungaUtangOtomatis({ createdBy: 'user-1', tanggalSekarang: '2026-06-30' }); // DIPERBARUI RC-S58: Juni selesai hari ini
    const baris = await testDb.getAllAsync<{ account_id: string }>(
      `SELECT je.account_id FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.sumber_transaksi = 'UTANG_BUNGA'`
    );
    expect(baris.length).toBe(12); // 6 bulan × 2 kaki
    expect(new Set(baris.map((b) => b.account_id))).toEqual(new Set([ACC.bebanBunga, ACC.utangBunga]));
  });
});
