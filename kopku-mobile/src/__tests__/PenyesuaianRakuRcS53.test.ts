// DIPERBARUI RC-S79 §3: rekening uji di berkas ini adalah KAS, sedangkan
// 'BIAYA_ADMIN_BANK'/'JASA_GIRO' kini hanya sah untuk rekening BANK
// (service yang menolak, bukan hanya UI). Diganti 'SELISIH_FISIK' —
// padanan kas yang juga PERLU_JURNAL dan dua arah, sehingga jurnal,
// arah debit/kredit, dan seluruh nilai accounting yang diuji TIDAK berubah.
// DIPERBARUI RC-S78 §11: catatan pemeriksaan kini WAJIB untuk setiap
// penyebab (baris SELESAI tanpa penjelasan tidak berguna bagi pemeriksa
// berikutnya). Nilai accounting yang diuji TIDAK diubah.
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

let testDb: TestDb;

// RC-S54 TAHAP 7 (harness): factory ini dulu HANYA berisi getDb &
// withTransaction, sehingga `migrasiV6x` yang diimpor suite ini tidak ada
// di modul hasil mock (`db_1.migrasiV6x is not a function`). Runner
// fallback `.harness/dbShim.js` menutupinya dengan jatuh ke modul asli.
// Sekarang ekspor asli dipertahankan lewat requireActual; yang di-override
// tetap hanya koneksi DB. Migrasi yang diuji adalah implementasi produksi.
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
import { migrasiV62 } from '../database/db';
import {
  catatRekonsiliasi,
  selesaikanRekonsiliasi,
  getRekonsiliasiDetail,
  listRekonsiliasiDetail,
  PENYEBAB_SELISIH,
} from '@/services/CashReconciliationService';
import {
  simpanDraftNilaiWajar,
  perbaruiDraftNilaiWajar,
  listDraftNilaiWajar,
  previewNilaiWajar,
  postingNilaiWajar,
  arahDariSelisih,
  getNilaiTercatatInvestasi,
} from '@/services/PenyesuaianNilaiWajarService';
import { buatUnitUsaha, setStatusUnitUsaha } from '@/services/KoperasiMasterService';
import { catatRAK, JENIS_ALOKASI_RAKU } from '@/services/RAKService';

/**
 * FASE 9 — PENYESUAIAN, REKONSILIASI, NILAI WAJAR (DRAFT), RAKU.
 *
 * DATABASE VERIFIED untuk seluruh operasi accounting; STATIC/UI
 * VERIFIED untuk navigasi dan layar. RENDER VERIFIED = NOT VERIFIED
 * (runner tidak dapat memount komponen `.tsx`).
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  bebanAdmin: 'acc-beban-admin',
  // RC-S79: selisih LEBIH kini wajib ke akun PENDAPATAN (service guard).
  pendapatanLain: 'acc-pendapatan-lain',
  rak: 'acc-rak',
  modal: 'acc-modal',
  properti: 'acc-properti',
};

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}
function tanpaKomentar(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function seedAccount(id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kat, nb, now, now
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

async function seedFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(ACC.rak, '1-1800', 'Rekening Antar Kantor', 'ASET', 'DEBIT');
  await seedAccount(ACC.properti, '1-1660', 'Properti Investasi', 'ASET', 'DEBIT');
  await seedAccount(ACC.bebanAdmin, '5-2000', 'Beban Administrasi Bank', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.pendapatanLain, '4-2000', 'Pendapatan Lain-lain', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');

  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('RAK', 'DEBIT_ASET', ACC.rak);
  await seedMapping('RAK', 'KREDIT_ASET', ACC.rak);

  for (const th of [2025, 2026]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank A','123','Koperasi',?,1,?)`,
    ACC.bank, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-modal','JRN-MODAL','2025-01-01','p2025','MODAL_AWAL','Modal awal','POSTED','user-1',?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm1','j-modal',?,10000000,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,0,10000000)`,
    ACC.modal
  );
}

async function saldoDebit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit) - SUM(je.kredit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  return r?.s ?? 0;
}

async function snapshot(): Promise<Record<string, number>> {
  const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);
  const je = await testDb.getFirstAsync<{ n: number; d: number; k: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(debit),0) d, COALESCE(SUM(kredit),0) k FROM journal_entry`
  );
  return { jurnal: j?.n ?? 0, entri: je?.n ?? 0, debit: je?.d ?? 0, kredit: je?.k ?? 0 };
}

async function seedProperti(nilai: number): Promise<string> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                            sumber_dana, status, created_by, created_at, updated_at)
     VALUES ('inv-1','INV-1','PROPERTI_INVESTASI','Ruko Jl. Melati',?,'2026-01-05','KAS','AKTIF','user-1',?,?)`,
    nilai, now, now
  );
  return 'inv-1';
}

beforeEach(async () => {
  await seedFixture();
});
afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// MIGRASI v62
// ===========================================================================

describe('Fase 9 — migrasi v62', () => {
  it('SCHEMA_VERSION = 62', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });

  it('kolom & tabel baru terbentuk', async () => {
    const kolomRek = (await testDb.getAllAsync<{ name: string }>(
      `SELECT name FROM pragma_table_info('rekonsiliasi_kas_bank')`
    )).map((k) => k.name);
    for (const k of ['status_penyelesaian', 'penyebab', 'perlakuan', 'journal_id']) {
      expect(kolomRek).toContain(k);
    }
    const kolomRak = (await testDb.getAllAsync<{ name: string }>(
      `SELECT name FROM pragma_table_info('rak_transaksi')`
    )).map((k) => k.name);
    expect(kolomRak).toContain('unit_usaha_id');
    expect(kolomRak).toContain('jenis_alokasi');

    const t = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='penyesuaian_nilai_wajar'`
    );
    expect(t?.n).toBe(1);
  });

  it('IDEMPOTEN — dijalankan ulang tidak gagal', async () => {
    const helper = async (tabel: string, kolom: string, tipe: string) => {
      try {
        await testDb.execAsync(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${tipe};`);
      } catch {
        /* kolom sudah ada */
      }
    };
    await migrasiV62(testDb as never, helper);
    await migrasiV62(testDb as never, helper);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });

  it('CHECK lama pada status rekonsiliasi TIDAK dibongkar', () => {
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(/status TEXT NOT NULL CHECK \(status IN \('COCOK','SELISIH'\)\)/);
  });
});

// ===========================================================================
// REKONSILIASI
// ===========================================================================

describe('Fase 9 — Rekonsiliasi Kas/Bank', () => {
  const dasar = { accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-03-10', createdBy: 'user-1' };

  it('1. saldo sama -> COCOK, selisih nol', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 10_000_000 });
    expect(r.saldoBuku).toBe(10_000_000);
    expect(r.selisih).toBe(0);
    expect(r.status).toBe('COCOK');
  });

  it('7. saldo buku BERASAL DARI LEDGER, bukan input', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 1 });
    expect(r.saldoBuku).toBe(await saldoDebit(ACC.kas));
  });

  it('4-5. selisih otomatis = eksternal - buku (dua arah)', async () => {
    const lebih = await catatRekonsiliasi({ ...dasar, saldoFisik: 10_500_000 });
    expect(lebih.selisih).toBe(500_000);
    const kurang = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_800_000 });
    expect(kurang.selisih).toBe(-200_000);
  });

  it('2/11. TIMING DIFFERENCE selesai TANPA jurnal', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 10_500_000 });
    const sebelum = await snapshot();

    const hasil = await selesaikanRekonsiliasi({
      rekonsiliasiId: r.id,
      penyebab: 'TIMING_DIFFERENCE',
      perlakuan: 'TIDAK_PERLU_JURNAL',
      catatan: 'Setoran dalam perjalanan',
      createdBy: 'user-1',
    });

    expect(hasil.statusPenyelesaian).toBe('SELESAI');
    expect(hasil.journalId).toBeNull();
    expect(hasil.penyebab).toBe('TIMING_DIFFERENCE');
    expect(hasil.diselesaikanOleh).toBe('user-1');
    expect(await snapshot()).toEqual(sebelum);
  });

  it('3/12/16. PERLU JURNAL -> jurnal lewat AccountingEngine, journal_id tersimpan', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_800_000 });
    const hasil = await selesaikanRekonsiliasi({
      rekonsiliasiId: r.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
      perlakuan: 'PERLU_JURNAL',
      akunLawanId: ACC.bebanAdmin,
      createdBy: 'user-1',
    });

    expect(hasil.journalId).not.toBeNull();
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      hasil.journalId as string
    );
    // Saldo eksternal LEBIH KECIL -> kas dikreditkan, beban didebit.
    expect(baris.find((b) => b.account_id === ACC.bebanAdmin)?.debit).toBe(200_000);
    expect(baris.find((b) => b.account_id === ACC.kas)?.kredit).toBe(200_000);
    expect(baris.reduce((t, b) => t + b.debit, 0)).toBe(baris.reduce((t, b) => t + b.kredit, 0));
  });

  it('17. saldo buku setelah adjustment sama dengan saldo eksternal', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_800_000 });
    await selesaikanRekonsiliasi({
      rekonsiliasiId: r.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
      perlakuan: 'PERLU_JURNAL',
      akunLawanId: ACC.bebanAdmin,
      createdBy: 'user-1',
    });
    expect(await saldoDebit(ACC.kas)).toBe(9_800_000);
  });

  it('arah sebaliknya: eksternal LEBIH BESAR -> kas didebit', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 10_300_000 });
    const hasil = await selesaikanRekonsiliasi({
      rekonsiliasiId: r.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
      perlakuan: 'PERLU_JURNAL',
      akunLawanId: ACC.pendapatanLain, // RC-S79: arah LEBIH -> akun Pendapatan
      createdBy: 'user-1',
    });
    const kas = await testDb.getFirstAsync<{ debit: number }>(
      `SELECT debit FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      hasil.journalId as string,
      ACC.kas
    );
    expect(kas?.debit).toBe(300_000);
    expect(await saldoDebit(ACC.kas)).toBe(10_300_000);
  });

  it('10/11. penyelesaian kedua DITOLAK — satu jurnal saja', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_800_000 });
    await selesaikanRekonsiliasi({
      rekonsiliasiId: r.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
      perlakuan: 'PERLU_JURNAL',
      akunLawanId: ACC.bebanAdmin,
      createdBy: 'user-1',
    });
    await expect(
      selesaikanRekonsiliasi({
        rekonsiliasiId: r.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
        perlakuan: 'PERLU_JURNAL',
        akunLawanId: ACC.bebanAdmin,
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/sudah diselesaikan/);

    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`
    );
    expect(n?.n).toBe(1);
  });

  it('12. dua penyelesai bersamaan -> satu jurnal', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_800_000 });
    const req = () =>
      selesaikanRekonsiliasi({
        rekonsiliasiId: r.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
        perlakuan: 'PERLU_JURNAL',
        akunLawanId: ACC.bebanAdmin,
        createdBy: 'user-1',
      });
    const hasil = await Promise.allSettled([req(), req()]);
    expect(hasil.filter((h) => h.status === 'fulfilled')).toHaveLength(1);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`
    );
    expect(n?.n).toBe(1);
  });

  it('13. rollback — akun lawan hilang, tidak ada jejak', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_800_000 });
    await expect(
      selesaikanRekonsiliasi({
        rekonsiliasiId: r.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
        perlakuan: 'PERLU_JURNAL',
        akunLawanId: 'akun-tidak-ada',
        createdBy: 'user-1',
      })
    ).rejects.toThrow();
    expect((await getRekonsiliasiDetail(r.id))?.statusPenyelesaian).toBe('DRAFT');
    expect(await snapshot()).toEqual({ jurnal: 1, entri: 2, debit: 10_000_000, kredit: 10_000_000 });
  });

  it('14. periode CLOSED ditolak; periode tidak dibuka sendiri', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_800_000 });
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);
    await expect(
      selesaikanRekonsiliasi({
        rekonsiliasiId: r.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
        perlakuan: 'PERLU_JURNAL',
        akunLawanId: ACC.bebanAdmin,
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/ditutup|CLOSED/i);
    const p = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM accounting_period WHERE id='p2026'`
    );
    expect(p?.status).toBe('CLOSED');
  });

  it('PERLU_JURNAL tanpa selisih & tanpa akun lawan DITOLAK', async () => {
    const cocok = await catatRekonsiliasi({ ...dasar, saldoFisik: 10_000_000 });
    await expect(
      selesaikanRekonsiliasi({
        rekonsiliasiId: cocok.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
        perlakuan: 'PERLU_JURNAL',
        akunLawanId: ACC.bebanAdmin,
        createdBy: 'user-1',
      })
    // DIPERBARUI RC-S78 §7H: 'LAINNYA' kini ditolak LEBIH DULU karena
    // tidak pernah boleh menghasilkan jurnal, sehingga penjaga
    // "tidak ada selisih" tidak lagi tercapai lewat penyebab itu.
    // Diganti BIAYA_ADMIN_BANK — penyebab yang memang memerlukan jurnal —
    // supaya penjaga yang diuji test ini tetap yang diuji.
    ).rejects.toThrow(/selisih kurang|tidak ada selisih/i);

    const selisih = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_900_000 });
    await expect(
      selesaikanRekonsiliasi({
        rekonsiliasiId: selisih.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
        perlakuan: 'PERLU_JURNAL',
        createdBy: 'user-1',
      })
    // Sama seperti di atas: penyebab diganti ke yang memang memerlukan
    // jurnal, supaya penjaga "akun lawan wajib" tetap yang tercapai.
    ).rejects.toThrow(/Akun lawan wajib/);
  });

  it('penyebab tidak dikenali DITOLAK', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_900_000 });
    await expect(
      selesaikanRekonsiliasi({
        rekonsiliasiId: r.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'ENTAH' as never,
        perlakuan: 'TIDAK_PERLU_JURNAL',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/tidak dikenali/);
    expect(PENYEBAB_SELISIH).toContain('TIMING_DIFFERENCE');
  });

  it('15/18. daftar belum selesai dapat dibedakan & berkurang setelah diselesaikan', async () => {
    const a = await catatRekonsiliasi({ ...dasar, saldoFisik: 9_900_000 });
    await catatRekonsiliasi({ ...dasar, saldoFisik: 10_000_000 });
    expect((await listRekonsiliasiDetail({ hanyaBelumSelesai: true })).length).toBeGreaterThan(0);

    await selesaikanRekonsiliasi({
      rekonsiliasiId: a.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'TIMING_DIFFERENCE',
      perlakuan: 'TIDAK_PERLU_JURNAL',
      createdBy: 'user-1',
    });
    const sisa = await listRekonsiliasiDetail({ hanyaBelumSelesai: true });
    expect(sisa.map((s) => s.id)).not.toContain(a.id);
  });

  it('8. rekonsiliasi akun KAS didukung — bukan hanya bank', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 10_000_000 });
    expect(r.accountId).toBe(ACC.kas);
    expect(r.status).toBe('COCOK');
  });
});

// ===========================================================================
// PENYESUAIAN NILAI WAJAR — DRAFT
// ===========================================================================

describe('Fase 9 — Penyesuaian Nilai Wajar (draft, policy-gated)', () => {
  it('2-4. nilai tercatat otomatis; selisih & arah dihitung', async () => {
    const id = await seedProperti(500_000_000);
    expect(await getNilaiTercatatInvestasi(id)).toBe(500_000_000);

    const naik = await previewNilaiWajar(id, 560_000_000);
    expect(naik.nilaiTercatatSebelum).toBe(500_000_000);
    expect(naik.selisih).toBe(60_000_000);
    expect(naik.arahPerubahan).toBe('KENAIKAN');

    const turun = await previewNilaiWajar(id, 450_000_000);
    expect(turun.selisih).toBe(-50_000_000);
    expect(turun.arahPerubahan).toBe('PENURUNAN');
  });

  it('8. selisih nol -> TIDAK_BERUBAH', async () => {
    const id = await seedProperti(500_000_000);
    const p = await previewNilaiWajar(id, 500_000_000);
    expect(p.selisih).toBe(0);
    expect(p.arahPerubahan).toBe('TIDAK_BERUBAH');
    expect(arahDariSelisih(0)).toBe('TIDAK_BERUBAH');
  });

  it('5/10. draft tersimpan dengan metadata audit, TANPA jurnal', async () => {
    const id = await seedProperti(500_000_000);
    const sebelum = await snapshot();

    const d = await simpanDraftNilaiWajar({
      investasiId: id,
      tanggal: '2026-06-30',
      nilaiWajar: 560_000_000,
      dasarPenilaian: 'Laporan penilai independen',
      referensiBukti: 'KJPP-2026-011',
      createdBy: 'user-1',
    });

    expect(d.status).toBe('DRAFT');
    expect(d.selisih).toBe(60_000_000);
    expect(d.arahPerubahan).toBe('KENAIKAN');
    expect(d.createdBy).toBe('user-1');
    expect(d.createdAt).not.toBeNull();
    // BUKU TIDAK BERGERAK SAMA SEKALI.
    expect(await snapshot()).toEqual(sebelum);
  });

  it('6. draft dapat diubah; selisih & arah ikut dihitung ulang', async () => {
    const id = await seedProperti(500_000_000);
    const d = await simpanDraftNilaiWajar({
      investasiId: id,
      tanggal: '2026-06-30',
      nilaiWajar: 560_000_000,
      // RC-S54 T11: bukti kini wajib (item #10) — input fixture saja, ekspektasi tidak diubah.
      dasarPenilaian: 'Laporan penilai independen',
      referensiBukti: 'KJPP-2026-011',
      createdBy: 'user-1',
    });
    const ubah = await perbaruiDraftNilaiWajar(d.id, {
      tanggal: '2026-07-01',
      nilaiWajar: 480_000_000,
      // RC-S54 T11: bukti kini wajib (item #10) — input fixture saja, ekspektasi tidak diubah.
      dasarPenilaian: 'Laporan penilai independen',
      referensiBukti: 'KJPP-2026-011',
      createdBy: 'user-1',
    });
    expect(ubah.nilaiWajar).toBe(480_000_000);
    expect(ubah.selisih).toBe(-20_000_000);
    expect(ubah.arahPerubahan).toBe('PENURUNAN');
    expect((await listDraftNilaiWajar())).toHaveLength(1);
  });

  it('7. nilai wajar negatif & investasi tidak dikenal DITOLAK', async () => {
    const id = await seedProperti(500_000_000);
    await expect(
      simpanDraftNilaiWajar({ investasiId: id, tanggal: '2026-06-30', nilaiWajar: -1, createdBy: 'user-1' })
    ).rejects.toThrow(/tidak boleh negatif/);
    await expect(
      simpanDraftNilaiWajar({ investasiId: 'tidak-ada', tanggal: '2026-06-30', nilaiWajar: 1, createdBy: 'user-1' })
    ).rejects.toThrow(/tidak ditemukan/);
    expect(await listDraftNilaiWajar()).toHaveLength(0);
  });

  // DIPERBARUI RC-S88: posting kini diizinkan (model nilai wajar SAK EP) TETAPI
  // hanya lewat mapping resmi. Fixture ini tidak memetakan akun nilai wajar ->
  // gerbang menolak dengan pesan eksplisit, bukan sukses palsu, dan nol jurnal.
  it('9. POSTING tanpa mapping DITOLAK eksplisit, bukan sukses palsu', async () => {
    const id = await seedProperti(500_000_000);
    const d = await simpanDraftNilaiWajar({
      investasiId: id,
      tanggal: '2026-06-30',
      nilaiWajar: 560_000_000,
      // RC-S54 T11: bukti kini wajib (item #10) — input fixture saja, ekspektasi tidak diubah.
      dasarPenilaian: 'Laporan penilai independen',
      referensiBukti: 'KJPP-2026-011',
      createdBy: 'user-1',
    });
    await expect(postingNilaiWajar(d.id, { userId: 'user-1' })).rejects.toThrow(/NILAI_WAJAR_PROPERTI_INVESTASI/);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi LIKE '%NILAI_WAJAR%'`
    );
    expect(n?.n).toBe(0);
  });

  // DIPERBARUI RC-S88: service menjurnal HANYA lewat createJournal + mapping.
  it('service nilai wajar menjurnal HANYA lewat createJournal (tanpa INSERT mentah / kode akun hard-code)', () => {
    const src = tanpaKomentar(baca('src/services/PenyesuaianNilaiWajarService.ts'));
    expect(src).toMatch(/createJournal\(db, \{/);
    expect(src).not.toMatch(/INSERT INTO journal\b/);
    expect(src).not.toMatch(/'4-2100'|'5-5000'/);
  });

  it('status POSTED tidak ada di enum skema (RC-S88: DIPOSTING via gerbang)', () => {
    const schema = baca('src/database/schema.ts');
    const awal = schema.indexOf('CREATE TABLE IF NOT EXISTS penyesuaian_nilai_wajar');
    const blok = schema.slice(awal, schema.indexOf(');', awal));
    expect(blok).toMatch(/status IN \('DRAFT','DIPOSTING','DIBATALKAN'\)/);
    expect(blok).not.toContain("'POSTED'");
  });
});

// ===========================================================================
// RAKU
// ===========================================================================

describe('Fase 9 — RAKU', () => {
  const dasar = {
    jenisRak: 'PENYALURAN_DANA' as const,
    namaUnit: 'Unit Toko',
    jumlah: 5_000_000,
    tanggal: '2026-03-10',
    sumberDana: 'KAS' as const,
    createdBy: 'user-1',
  };

  it('10/1. unit usaha AKTIF dari master diterima & tersimpan', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    const hasil = await catatRAK({
      ...dasar,
      unitUsahaId: unitId,
      jenisAlokasi: 'MODAL_TETAP',
    });
    const row = await testDb.getFirstAsync<{ unit_usaha_id: string; jenis_alokasi: string; nomor_rak: string }>(
      `SELECT unit_usaha_id, jenis_alokasi, nomor_rak FROM rak_transaksi WHERE id = ?`,
      hasil.id
    );
    expect(row?.unit_usaha_id).toBe(unitId);
    expect(row?.jenis_alokasi).toBe('MODAL_TETAP');
    expect(row?.nomor_rak).not.toBeNull();
  });

  it('11. unit usaha NONAKTIF ditolak untuk transaksi BARU', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Tutup' });
    await setStatusUnitUsaha(unitId, 'NONAKTIF');
    await expect(
      catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'OPERASIONAL' })
    ).rejects.toThrow(/NONAKTIF/);
  });

  it('11b. histori RAKU ke unit yang kemudian dinonaktifkan TETAP terbaca', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Lama' });
    const hasil = await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' });
    await setStatusUnitUsaha(unitId, 'NONAKTIF');

    const row = await testDb.getFirstAsync<{ unit_usaha_id: string }>(
      `SELECT unit_usaha_id FROM rak_transaksi WHERE id = ?`,
      hasil.id
    );
    expect(row?.unit_usaha_id).toBe(unitId);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });

  it('12. unit usaha tidak dikenal DITOLAK — tidak ada orphan', async () => {
    await expect(
      catatRAK({ ...dasar, unitUsahaId: 'tidak-ada', jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow(/tidak ditemukan/);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM rak_transaksi`);
    expect(n?.n).toBe(0);
  });

  it('4-6/33. ketiga jenis alokasi diterima; nilai asing DITOLAK di SERVICE', async () => {
    // Nominal kecil: tiga penyaluran berturut-turut menguras kas
    // fixture kalau memakai nominal dasar.
    for (const alokasi of JENIS_ALOKASI_RAKU) {
      const unitId = await buatUnitUsaha({ namaUsaha: `Unit ${alokasi}` });
      await catatRAK({ ...dasar, jumlah: 1_000_000, unitUsahaId: unitId, jenisAlokasi: alokasi });
    }
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM rak_transaksi`);
    expect(n?.n).toBe(JENIS_ALOKASI_RAKU.length);

    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit X' });
    await expect(
      catatRAK({ ...dasar, jumlah: 1_000_000, unitUsahaId: unitId, jenisAlokasi: 'MODAL_SILUMAN' as never })
    ).rejects.toThrow(/tidak dikenali/);
  });

  it('16/18. nomor RAKU unik & jurnal balanced', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    const a = await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' });
    const b = await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'OPERASIONAL' });

    const nomor = await testDb.getAllAsync<{ nomor_rak: string }>(`SELECT nomor_rak FROM rak_transaksi`);
    expect(new Set(nomor.map((n) => n.nomor_rak)).size).toBe(2);
    expect(a.id).not.toBe(b.id);

    const perJurnal = await testDb.getAllAsync<{ d: number; k: number }>(
      `SELECT SUM(je.debit) d, SUM(je.kredit) k FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
        WHERE j.sumber_transaksi = 'RAK' GROUP BY j.id`
    );
    expect(perJurnal.length).toBeGreaterThan(0);
    for (const p of perJurnal) expect(p.d).toBe(p.k);
  });

  it('34. OPERASIONAL tetap ASET internal, bukan beban', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Ops' });
    const hasil = await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'OPERASIONAL' });
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number }>(
      `SELECT je.account_id, je.debit FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
        WHERE j.sumber_id = ? OR j.nomor_referensi = ?`,
      hasil.id,
      hasil.nomorRak
    );
    const didebit = baris.filter((b) => b.debit > 0).map((b) => b.account_id);
    expect(didebit).toContain(ACC.rak);
  });
});

// ===========================================================================
// STATIC/UI VERIFIED — navigasi & layar
// ===========================================================================

describe('Fase 9 — STATIC/UI VERIFIED', () => {
  const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));
  const pengeluaran = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
  const hub = tanpaKomentar(baca('src/screens/Transaksi/PenyesuaianScreen.tsx'));
  const nilaiWajar = tanpaKomentar(baca('src/screens/Transaksi/PenyesuaianNilaiWajarScreen.tsx'));

  it('hub memuat tiga menu dalam urutan yang diminta', () => {
    const iRek = hub.indexOf("'Rekonsiliasi'");
    const iNw = hub.indexOf("'PenyesuaianNilaiWajar'");
    const iImp = hub.indexOf("'ImpairmentInvestasiForm'");
    expect(iRek).toBeGreaterThan(-1);
    expect(iRek).toBeLessThan(iNw);
    expect(iNw).toBeLessThan(iImp);
  });

  it('hub tidak memegang logika akuntansi', () => {
    for (const t of ['createJournal', 'INSERT INTO', 'SELECT ', 'getDb(', 'Service']) {
      expect(hub).not.toContain(t);
    }
  });

  // RC-S68: hub Penyesuaian dijangkau dari root Transaksi, bukan Pengeluaran.
  it('Impairment & Rekonsiliasi TIDAK berdiri sendiri di menu Pengeluaran; hub Penyesuaian dari root Transaksi', () => {
    expect(pengeluaran).not.toMatch(/title: 'Impairment Investasi'/);
    expect(pengeluaran).not.toMatch(/title: 'Rekonsiliasi Kas\/Bank'/);
    expect(pengeluaran).not.toMatch(/nav\.navigate\('Penyesuaian'\)/);
    expect(tanpaKomentar(baca('src/screens/Transaksi/TransaksiScreen.tsx'))).toMatch(/navigate\('Penyesuaian'\)/);
  });

  it('tidak ada rute duplikat', () => {
    for (const r of ['Penyesuaian', 'PenyesuaianNilaiWajar', 'Rekonsiliasi', 'ImpairmentInvestasiForm']) {
      expect((nav.match(new RegExp(`name="${r}"`, 'g')) ?? [])).toHaveLength(1);
    }
  });

  // DIPERBARUI RC-S88 (keputusan pengguna): layar kini PUNYA aksi posting, tetapi
  // hanya lewat lembar konfirmasi yang menampilkan pratinjau jurnal dari service
  // (penyusun yang sama dengan eksekusi). Layar tetap tidak menjurnal sendiri dan
  // tidak mengenal status POSTED.
  it('layar nilai wajar: posting hanya lewat lembar konfirmasi berbasis pratinjau service', () => {
    expect(nilaiWajar).not.toMatch(/'POSTED'|createJournal/);
    expect(nilaiWajar).toMatch(/previewPostingNilaiWajar\(row\.id\)/);
    expect(nilaiWajar).toMatch(/onPress=\{\(\) => void bukaPosting\(d\)\}/);
    expect(nilaiWajar).toMatch(/onPress=\{\(\) => void konfirmasiPosting\(\)\}/);
    expect(nilaiWajar).toMatch(/disabled=\{memposting \|\| lembarPosting\.rencana\.hambatan\.length > 0\}/);
    expect(nilaiWajar).toMatch(/Simpan Draft/);
  });

  // DIPERBARUI RC-S88 (redesain UI): nilai tercatat, selisih, dan arah kini
  // tampil di panel hasil perhitungan service (PanelPerhitungan) — tetap
  // READ-ONLY: tidak ada state/setter untuk ketiganya di layar.
  it('nilai tercatat, selisih, dan arah READ-ONLY di layar (panel hasil service)', () => {
    expect(nilaiWajar).toMatch(/<BarisAngka label="Nilai tercatat" nilai=\{formatRupiah\(rencana\.nilaiTercatatSebelum\)\} \/>/);
    expect(nilaiWajar).toMatch(/label=\{`Selisih · \$\{LABEL_ARAH\[rencana\.arahPerubahan\]\}`\}/);
    expect(nilaiWajar).not.toMatch(/setSelisih|setArah|setNilaiTercatat/);
  });

  it('layar nilai wajar punya loading, empty, dan error state', () => {
    expect(nilaiWajar).toMatch(/ActivityIndicator/);
    expect(nilaiWajar).toContain('Belum ada penilaian pada filter ini.'); // DIPERBARUI RC-S88: riwayat berfilter status
    expect(nilaiWajar).toContain('Data penyesuaian nilai wajar gagal dimuat.');
    expect(nilaiWajar).toMatch(/disabled=\{menyimpan\}/);
    expect(nilaiWajar).toMatch(/await muat\(\);/);
  });

  it('§38/§39 — "Tarik Dana RAK" BUKAN entry menu Rincian Laporan Lainnya', () => {
    const menu = tanpaKomentar(baca('src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx'));
    expect(menu).not.toContain('Tarik Dana RAK');
    // Yang ada hanyalah daftar RAKU, dan itu memang diminta tetap ada.
    expect(menu).toContain('Daftar Rekening Antar Kantor/Unit (RAKU)');
  });

  it('§38 — tabel, service, dan histori RAK TIDAK dihapus', () => {
    expect(baca('src/database/schema.ts')).toContain('CREATE TABLE IF NOT EXISTS rak_transaksi');
    expect(baca('src/services/RAKService.ts')).toMatch(/export async function catatRAK/);
    expect(nav).toMatch(/name="RAKList"/);
  });
});
