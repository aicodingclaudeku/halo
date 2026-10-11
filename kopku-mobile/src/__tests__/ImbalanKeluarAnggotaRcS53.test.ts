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

import { migrasiV61 } from '../database/db';
import { buatPersonel, setStatusPersonel } from '@/services/KoperasiMasterService';
import {
  catatImbalanKerja,
  bayarImbalanKerja,
  getImbalanKerja,
  listImbalanKerja,
  periodKeyDariTanggalImbalan,
  JENIS_IMBALAN,
} from '@/services/ImbalanKerjaService';
import {
  ajukanKeluarAnggota,
  setujuiKeluarAnggota,
  tolakKeluarAnggota,
  bayarKeluarAnggota,
  getKeluarAnggota,
  previewKeluarAnggota,
  ALASAN_KELUAR,
} from '@/services/KeluarAnggotaService';

/**
 * FASE 8 — IMBALAN KERJA & KELUAR ANGGOTA.
 *
 * Seluruh suite berjalan di atas SQLite sungguhan (`node:sqlite`)
 * dengan skema produksi dan jurnal dari AccountingEngine asli. Tidak ada
 * mock akuntansi: angka yang diperiksa adalah angka yang benar-benar
 * duduk di `journal_entry`.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  piutang: 'acc-piutang',
  simpananPokok: 'acc-pokok',
  simpananWajib: 'acc-wajib',
  simpananSukarela: 'acc-sukarela',
  utangImbalan: 'acc-2-1600',
  bebanImbalan: 'acc-5-1050',
  modal: 'acc-modal',
};

async function seedAccount(
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id,
    kode,
    nama,
    kategori,
    nb,
    now,
    now
  );
}

async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`,
    tt,
    role,
    accountId
  );
}

async function seedFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(ACC.simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.simpananWajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.simpananSukarela, '2-1200', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.utangImbalan, '2-1600', 'Utang Imbalan Kerja', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.bebanImbalan, '5-1050', 'Beban Imbalan Kerja', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');

  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('UTANG_IMBALAN_KERJA', 'DEBIT_BEBAN', ACC.bebanImbalan);
  await seedMapping('UTANG_IMBALAN_KERJA', 'KREDIT_DEFAULT', ACC.utangImbalan);
  await seedMapping('SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.simpananPokok);
  await seedMapping('SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.simpananWajib);
  await seedMapping('SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.simpananSukarela);
  await seedMapping('PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutang);

  for (const th of [2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`,
      th,
      `${th}-01-01`,
      `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank A','123','Koperasi',?,1,?)`,
    ACC.bank,
    now
  );
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-A','A001','1111111111111111','Anggota A','2020-01-01','AKTIF',?,?)`,
    now,
    now
  );

  // Modal awal supaya kas benar-benar punya saldo.
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-modal','JRN-MODAL','2025-01-01','p2025','MODAL_AWAL','Modal awal','POSTED','user-1',?,?)`,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm1','j-modal',?,500000000,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,100000000,0)`,
    ACC.bank
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm3','j-modal',?,0,600000000)`,
    ACC.modal
  );
}

async function saldo(accountId: string, normalDebit: boolean): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit) - SUM(je.kredit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    accountId
  );
  const v = r?.s ?? 0;
  // `-0` dan `0` berbeda bagi Object.is; normalkan supaya assertion
  // saldo nol tidak gagal karena tanda.
  const hasil = normalDebit ? v : -v;
  return hasil === 0 ? 0 : hasil;
}

async function jumlahJurnal(sumber: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = ?`,
    sumber
  );
  return r?.n ?? 0;
}

/** Setiap jurnal harus seimbang. */
async function semuaJurnalBalanced(): Promise<boolean> {
  const rows = await testDb.getAllAsync<{ d: number; k: number }>(
    `SELECT SUM(debit) d, SUM(kredit) k FROM journal_entry GROUP BY journal_id`
  );
  return rows.every((r) => r.d === r.k);
}

async function setorSimpanan(jenis: string, nominal: number, id: string): Promise<void> {
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?, 'anggota-A', ?, 'SETOR', '2026-01-10', ?, 'KAS', ?, 'user-1', ?)`,
    id,
    jenis,
    nominal,
    id.toUpperCase(),
    new Date().toISOString()
  );
}

async function buatPinjamanOutstanding(pokok: number, terbayar: number): Promise<void> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor,
                           metode_jasa, persentase_jasa, status, created_by, created_at, updated_at)
     VALUES ('pinj-1','PJM-1','anggota-A','2026-01-05',?,12,'BULAN','FLAT',12,'AKTIF','user-1',?,?)`,
    pokok,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, total, pokok_terbayar)
     VALUES ('ang-1','pinj-1',1,'2026-02-05',?,0,?,?)`,
    pokok,
    pokok,
    terbayar
  );
}

beforeEach(async () => {
  await seedFixture();
});

afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// MIGRASI v61
// ===========================================================================

describe('Fase 8 — migrasi v61', () => {
  it('tabel imbalan_kerja & keluar_anggota terbentuk beserta indeks uniknya', async () => {
    const t = await testDb.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('imbalan_kerja','keluar_anggota')`
    );
    expect(t).toHaveLength(2);
    const idx = await testDb.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'uq_%'`
    );
    const nama = idx.map((i) => i.name);
    expect(nama).toContain('uq_imbalan_identitas');
    expect(nama).toContain('uq_keluar_anggota_hidup');
  });

  it('IDEMPOTEN — dijalankan ulang tidak gagal', async () => {
    await migrasiV61(testDb as never);
    await migrasiV61(testDb as never);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });

  it('tidak ada COA baru — 2-1600 & 5-1050 memang sudah ada di COA bawaan', () => {
    const fs = require('fs');
    const path = require('path');
    const coa = fs.readFileSync(path.join(__dirname, '..', 'config', 'defaultCOA.ts'), 'utf8') as string;
    expect(coa).toContain("'2-1600'");
    expect(coa).toContain("'5-1050'");
  });
});

// ===========================================================================
// IMBALAN KERJA
// ===========================================================================

describe('Fase 8 — Imbalan Kerja', () => {
  async function buatPengurus(): Promise<string> {
    return buatPersonel({
      nama: 'Siti',
      jenisPersonel: 'PENGURUS',
      jabatan: 'Bendahara',
    });
  }

  const INPUT_DASAR = {
    periodKey: '2026-09',
    jenisImbalan: 'HONORARIUM' as const,
    dasarPerhitungan: 5_000_000,
    nilaiImbalan: 1_000_000,
    tanggalPengakuan: '2026-09-30',
    tanggalJatuhTempo: '2026-10-05',
    createdBy: 'user-1',
  };

  it('1-3. penerima dari master; jenis personel & jabatan otomatis', async () => {
    const personelId = await buatPengurus();
    const hasil = await catatImbalanKerja({ ...INPUT_DASAR, personelId });

    expect(hasil.namaPenerima).toBe('Siti');
    expect(hasil.jenisPersonel).toBe('PENGURUS');
    expect(hasil.jabatan).toBe('Bendahara');
    expect(hasil.periodKey).toBe('2026-09');
    expect(hasil.status).toBe('POSTED');
  });

  it('§7 — dasar perhitungan dan nilai imbalan disimpan TERPISAH', async () => {
    const personelId = await buatPengurus();
    const hasil = await catatImbalanKerja({ ...INPUT_DASAR, personelId });
    expect(hasil.dasarPerhitungan).toBe(5_000_000);
    expect(hasil.nilaiImbalan).toBe(1_000_000);
    expect(hasil.dasarPerhitungan).not.toBe(hasil.nilaiImbalan);
  });

  it('4-5. jurnal pengakuan Dr 5-1050 / Cr 2-1600 dan balanced', async () => {
    const personelId = await buatPengurus();
    await catatImbalanKerja({ ...INPUT_DASAR, personelId });

    expect(await saldo(ACC.bebanImbalan, true)).toBe(1_000_000);
    expect(await saldo(ACC.utangImbalan, false)).toBe(1_000_000);
    expect(await semuaJurnalBalanced()).toBe(true);
  });

  it('6/12. submit kedua untuk periode & jenis yang sama DITOLAK — satu jurnal saja', async () => {
    const personelId = await buatPengurus();
    await catatImbalanKerja({ ...INPUT_DASAR, personelId });

    await expect(catatImbalanKerja({ ...INPUT_DASAR, personelId })).rejects.toThrow(
      /sudah pernah dibukukan/
    );
    expect(await jumlahJurnal('UTANG_IMBALAN_KERJA')).toBe(1);
    expect(await saldo(ACC.bebanImbalan, true)).toBe(1_000_000);
  });

  it('periode BERBEDA untuk orang yang sama tetap boleh', async () => {
    const personelId = await buatPengurus();
    await catatImbalanKerja({ ...INPUT_DASAR, personelId });
    await catatImbalanKerja({
      ...INPUT_DASAR,
      personelId,
      periodKey: '2026-10',
      tanggalPengakuan: '2026-10-31',
      tanggalJatuhTempo: '2026-11-05',
    });
    expect(await listImbalanKerja()).toHaveLength(2);
    expect(await saldo(ACC.utangImbalan, false)).toBe(2_000_000);
  });

  it('7. pembayaran Dr 2-1600 / Cr Kas — beban TIDAK bertambah', async () => {
    const personelId = await buatPengurus();
    const imb = await catatImbalanKerja({ ...INPUT_DASAR, personelId });
    const bebanSebelum = await saldo(ACC.bebanImbalan, true);

    await bayarImbalanKerja({
      imbalanId: imb.id,
      tanggal: '2026-10-05',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(await saldo(ACC.utangImbalan, false)).toBe(0);
    expect(await saldo(ACC.bebanImbalan, true)).toBe(bebanSebelum);
    expect((await getImbalanKerja(imb.id))?.status).toBe('PAID');
    expect(await semuaJurnalBalanced()).toBe(true);
  });

  it('8/13. pembayaran kedua DITOLAK — liabilitas tidak menjadi negatif', async () => {
    const personelId = await buatPengurus();
    const imb = await catatImbalanKerja({ ...INPUT_DASAR, personelId });
    await bayarImbalanKerja({
      imbalanId: imb.id,
      tanggal: '2026-10-05',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      bayarImbalanKerja({
        imbalanId: imb.id,
        tanggal: '2026-10-06',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/sudah dibayar/);

    expect(await jumlahJurnal('UTANG_IMBALAN_KERJA_BAYAR')).toBe(1);
    expect(await saldo(ACC.utangImbalan, false)).toBe(0);
    expect(await saldo(ACC.utangImbalan, false)).toBeGreaterThan(-1);
  });

  it('10. tanggal jatuh tempo mendahului pengakuan DITOLAK sebelum menulis', async () => {
    const personelId = await buatPengurus();
    await expect(
      catatImbalanKerja({
        ...INPUT_DASAR,
        personelId,
        tanggalPengakuan: '2026-09-30',
        tanggalJatuhTempo: '2026-09-01',
      })
    ).rejects.toThrow(/tidak boleh mendahului/);
    expect(await listImbalanKerja()).toHaveLength(0);
    expect(await jumlahJurnal('UTANG_IMBALAN_KERJA')).toBe(0);
  });

  it('§5 — period_key wajib YYYY-MM, bukan string tampilan', async () => {
    const personelId = await buatPengurus();
    await expect(
      catatImbalanKerja({ ...INPUT_DASAR, personelId, periodKey: 'September 2026' })
    ).rejects.toThrow(/YYYY-MM/);
    expect(periodKeyDariTanggalImbalan('2026-09-30')).toBe('2026-09');
  });

  it('11. personel NONAKTIF tidak dapat menerima imbalan baru', async () => {
    const personelId = await buatPengurus();
    await setStatusPersonel(personelId, false);
    await expect(catatImbalanKerja({ ...INPUT_DASAR, personelId })).rejects.toThrow(/nonaktif/);
    expect(await jumlahJurnal('UTANG_IMBALAN_KERJA')).toBe(0);
  });

  it('12. personel tidak ditemukan DITOLAK — tidak ada orphan', async () => {
    await expect(
      catatImbalanKerja({ ...INPUT_DASAR, personelId: 'tidak-ada' })
    ).rejects.toThrow(/tidak ditemukan/);
    expect(await listImbalanKerja()).toHaveLength(0);
  });

  it('13. periode akuntansi CLOSED ditolak; periode tidak dibuka sendiri', async () => {
    const personelId = await buatPengurus();
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);

    await expect(catatImbalanKerja({ ...INPUT_DASAR, personelId })).rejects.toThrow(
      /ditutup|CLOSED/i
    );
    expect(await listImbalanKerja()).toHaveLength(0);
    const p = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM accounting_period WHERE id='p2026'`
    );
    expect(p?.status).toBe('CLOSED');
  });

  it('14-15. bertahan setelah pembacaan ulang; referensi jurnal benar', async () => {
    const personelId = await buatPengurus();
    const imb = await catatImbalanKerja({ ...INPUT_DASAR, personelId });

    const lagi = await getImbalanKerja(imb.id);
    expect(lagi?.journalId).toBe(imb.journalId);
    const j = await testDb.getFirstAsync<{ sumber_id: string; sumber_transaksi: string }>(
      `SELECT sumber_id, sumber_transaksi FROM journal WHERE id = ?`,
      imb.journalId
    );
    expect(j?.sumber_id).toBe(imb.id);
    expect(j?.sumber_transaksi).toBe('UTANG_IMBALAN_KERJA');
  });

  it('vokabular jenis imbalan tetap pendek dan mencakup HONORARIUM', () => {
    expect(JENIS_IMBALAN).toContain('HONORARIUM');
    expect(JENIS_IMBALAN.length).toBeLessThanOrEqual(6);
  });
});

// ===========================================================================
// KELUAR ANGGOTA
// ===========================================================================

describe('Fase 8 — Keluar Anggota: perhitungan', () => {
  it('3-5/9. saldo pokok, wajib, sukarela dan total hak otomatis', async () => {
    await setorSimpanan('POKOK', 100_000, 'sp1');
    await setorSimpanan('WAJIB', 600_000, 'sw1');
    await setorSimpanan('SUKARELA', 300_000, 'ss1');

    const p = await previewKeluarAnggota('anggota-A');
    expect(p.saldoSimpananPokok).toBe(100_000);
    expect(p.saldoSimpananWajib).toBe(600_000);
    expect(p.saldoSimpananSukarela).toBe(300_000);
    expect(p.totalHak).toBe(1_000_000);
  });

  it('6/§23 — SHU yang SUDAH DIBAGIKAN tidak dihitung ulang', async () => {
    await setorSimpanan('SUKARELA', 300_000, 'ss1');
    await testDb.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, status, created_at, updated_at)
       VALUES ('shu-2025',2025,'DIBAGIKAN',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await testDb.runAsync(
      `INSERT INTO shu_anggota (id, shu_konfigurasi_id, anggota_id, total_shu_anggota)
       VALUES ('sa1','shu-2025','anggota-A',250000)`
    );

    // SHU DIBAGIKAN sudah masuk simpanan sukarela lewat
    // simpanan_transaksi; menghitungnya lagi akan membayar dua kali.
    const p = await previewKeluarAnggota('anggota-A');
    expect(p.shuHakAnggota).toBe(0);
    expect(p.totalHak).toBe(300_000);
  });

  it('6. SHU DISAHKAN_RAT tetapi BELUM dibagikan memang menjadi hak', async () => {
    await testDb.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, status, created_at, updated_at)
       VALUES ('shu-2026',2026,'DISAHKAN_RAT',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await testDb.runAsync(
      `INSERT INTO shu_anggota (id, shu_konfigurasi_id, anggota_id, total_shu_anggota)
       VALUES ('sa2','shu-2026','anggota-A',150000)`
    );
    const p = await previewKeluarAnggota('anggota-A');
    expect(p.shuHakAnggota).toBe(150_000);
  });

  it('SHU DRAFT/DIHITUNG belum menjadi hak siapa pun', async () => {
    await testDb.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, status, created_at, updated_at)
       VALUES ('shu-d',2026,'DIHITUNG',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await testDb.runAsync(
      `INSERT INTO shu_anggota (id, shu_konfigurasi_id, anggota_id, total_shu_anggota)
       VALUES ('sa3','shu-d','anggota-A',999999)`
    );
    expect((await previewKeluarAnggota('anggota-A')).shuHakAnggota).toBe(0);
  });

  it('7/§24 — pinjaman memakai OUTSTANDING, bukan pokok kontrak', async () => {
    await buatPinjamanOutstanding(5_000_000, 2_000_000);
    const p = await previewKeluarAnggota('anggota-A');
    expect(p.saldoPinjaman).toBe(3_000_000);
    expect(p.totalPengurang).toBe(3_000_000);
  });

  it('11/§22 — nilai pengembalian = hak - pengurang, tidak pernah negatif', async () => {
    await setorSimpanan('POKOK', 1_000_000, 'sp1');
    await buatPinjamanOutstanding(5_000_000, 0);

    const p = await previewKeluarAnggota('anggota-A');
    expect(p.totalHak).toBe(1_000_000);
    expect(p.totalPengurang).toBe(5_000_000);
    expect(p.nilaiPengembalian).toBe(0);
    expect(p.tidakAdaPengembalian).toBe(true);
  });

  it('§35E — total hak = total pengurang menghasilkan pengembalian 0', async () => {
    await setorSimpanan('POKOK', 3_000_000, 'sp1');
    await buatPinjamanOutstanding(3_000_000, 0);
    const p = await previewKeluarAnggota('anggota-A');
    expect(p.nilaiPengembalian).toBe(0);
    expect(p.tidakAdaPengembalian).toBe(true);
  });

  it('§35A — punya pinjaman tanpa simpanan', async () => {
    await buatPinjamanOutstanding(2_000_000, 0);
    const p = await previewKeluarAnggota('anggota-A');
    expect(p.totalHak).toBe(0);
    expect(p.nilaiPengembalian).toBe(0);
  });

  it('§35C/D — SHU 0 dan kewajiban lain 0 tidak merusak perhitungan', async () => {
    await setorSimpanan('WAJIB', 500_000, 'sw1');
    const p = await previewKeluarAnggota('anggota-A');
    expect(p.shuHakAnggota).toBe(0);
    expect(p.kewajibanLain).toBe(0);
    expect(p.nilaiPengembalian).toBe(500_000);
  });
});

describe('Fase 8 — Keluar Anggota: alur persetujuan', () => {
  async function ajukan() {
    await setorSimpanan('POKOK', 100_000, 'sp1');
    await setorSimpanan('WAJIB', 600_000, 'sw1');
    await setorSimpanan('SUKARELA', 300_000, 'ss1');
    return ajukanKeluarAnggota({
      anggotaId: 'anggota-A',
      alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-06-01',
      tanggalEfektifKeluar: '2026-06-30',
      createdBy: 'user-1',
    });
  }

  it('12. DIAJUKAN — saldo tersimpan sebagai snapshot; status anggota BELUM berubah', async () => {
    const p = await ajukan();
    expect(p.statusPengajuan).toBe('DIAJUKAN');
    expect(p.totalHak).toBe(1_000_000);
    expect(p.nilaiPengembalian).toBe(1_000_000);

    const a = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM anggota WHERE id='anggota-A'`
    );
    expect(a?.status).toBe('AKTIF');
  });

  it('19. pembayaran SEBELUM persetujuan DITOLAK', async () => {
    const p = await ajukan();
    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/DISETUJUI/);
    expect(await jumlahJurnal('KELUAR_ANGGOTA')).toBe(0);
  });

  it('13. DISETUJUI mencatat penyetuju dan tanggalnya', async () => {
    const p = await ajukan();
    const s = await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    expect(s.statusPengajuan).toBe('DISETUJUI');
    expect(s.disetujuiOleh).toBe('user-1');
    expect(s.tanggalPersetujuan).toBe('2026-06-10');
  });

  it('14. DITOLAK tidak dapat dibayar', async () => {
    const p = await ajukan();
    const t = await tolakKeluarAnggota(p.id, 'user-1', 'Dokumen belum lengkap');
    expect(t.statusPengajuan).toBe('DITOLAK');
    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/DISETUJUI/);
  });

  it('§35G — pengajuan kedua saat masih ada yang hidup DITOLAK', async () => {
    await ajukan();
    await expect(
      ajukanKeluarAnggota({
        anggotaId: 'anggota-A',
        alasanKeluar: 'LAINNYA',
        tanggalPengajuan: '2026-06-02',
        tanggalEfektifKeluar: '2026-06-30',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/sudah memiliki pengajuan/);
  });

  it('§35J — anggota tidak ditemukan DITOLAK', async () => {
    await expect(
      ajukanKeluarAnggota({
        anggotaId: 'tidak-ada',
        alasanKeluar: 'LAINNYA',
        tanggalPengajuan: '2026-06-01',
        tanggalEfektifKeluar: '2026-06-30',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/tidak ditemukan/);
  });

  it('tanggal efektif mendahului pengajuan DITOLAK', async () => {
    await expect(
      ajukanKeluarAnggota({
        anggotaId: 'anggota-A',
        alasanKeluar: 'LAINNYA',
        tanggalPengajuan: '2026-06-10',
        tanggalEfektifKeluar: '2026-06-01',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/tidak boleh mendahului/);
  });

  it('alasan keluar mencakup keempat pilihan', () => {
    expect(ALASAN_KELUAR).toEqual(['MENGUNDURKAN_DIRI', 'DIBERHENTIKAN', 'MENINGGAL', 'LAINNYA']);
  });
});

describe('Fase 8 — Keluar Anggota: pembayaran & jurnal', () => {
  async function siapDibayar(opts: { pinjaman?: number } = {}) {
    await setorSimpanan('POKOK', 100_000, 'sp1');
    await setorSimpanan('WAJIB', 600_000, 'sw1');
    await setorSimpanan('SUKARELA', 300_000, 'ss1');
    if (opts.pinjaman) await buatPinjamanOutstanding(opts.pinjaman, 0);

    const p = await ajukanKeluarAnggota({
      anggotaId: 'anggota-A',
      alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-06-01',
      tanggalEfektifKeluar: '2026-06-30',
      createdBy: 'user-1',
    });
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    return p;
  }

  it('15-16/25. pembayaran KAS — jurnal rinci per akun & terekonsiliasi', async () => {
    const p = await siapDibayar();
    const hasil = await bayarKeluarAnggota({
      id: p.id,
      tanggal: '2026-06-30',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(hasil.nilaiPengembalian).toBe(1_000_000);
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      hasil.journalId
    );
    const cari = (acc: string) => baris.find((b) => b.account_id === acc);
    expect(cari(ACC.simpananPokok)?.debit).toBe(100_000);
    expect(cari(ACC.simpananWajib)?.debit).toBe(600_000);
    expect(cari(ACC.simpananSukarela)?.debit).toBe(300_000);
    expect(cari(ACC.kas)?.kredit).toBe(1_000_000);
    expect(baris.reduce((t, b) => t + b.debit, 0)).toBe(baris.reduce((t, b) => t + b.kredit, 0));
    expect(await semuaJurnalBalanced()).toBe(true);
  });

  it('17. pembayaran BANK memakai akun bank, bukan kas', async () => {
    const p = await siapDibayar();
    const hasil = await bayarKeluarAnggota({
      id: p.id,
      tanggal: '2026-06-30',
      sumberDana: 'BANK',
      bankAccountId: 'bank-1',
      createdBy: 'user-1',
    });
    const baris = await testDb.getAllAsync<{ account_id: string; kredit: number }>(
      `SELECT account_id, kredit FROM journal_entry WHERE journal_id = ? AND kredit > 0`,
      hasil.journalId
    );
    expect(baris.map((b) => b.account_id)).toContain(ACC.bank);
    expect(baris.map((b) => b.account_id)).not.toContain(ACC.kas);
  });

  it('pinjaman dikompensasi lewat KREDIT piutang, bukan dihapus diam-diam', async () => {
    const p = await siapDibayar({ pinjaman: 400_000 });
    const hasil = await bayarKeluarAnggota({
      id: p.id,
      tanggal: '2026-06-30',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const piutang = await testDb.getFirstAsync<{ kredit: number }>(
      `SELECT kredit FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      hasil.journalId,
      ACC.piutang
    );
    expect(piutang?.kredit).toBe(400_000);
    expect(hasil.nilaiPengembalian).toBe(600_000);
  });

  it('15/§25. status anggota berubah KELUAR HANYA setelah dibayar', async () => {
    const p = await siapDibayar();
    let a = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM anggota WHERE id='anggota-A'`
    );
    expect(a?.status).toBe('AKTIF'); // masih DISETUJUI

    await bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' });
    a = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM anggota WHERE id='anggota-A'`
    );
    expect(a?.status).toBe('KELUAR');
    expect((await getKeluarAnggota(p.id))?.statusPengajuan).toBe('DIBAYAR');
  });

  it('18/20/§29. pembayaran kedua DITOLAK — satu jurnal saja', async () => {
    const p = await siapDibayar();
    await bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' });

    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-07-01', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah dibayar/);

    expect(await jumlahJurnal('KELUAR_ANGGOTA')).toBe(1);
  });

  it('22/§30. kegagalan menggulung seluruhnya — status & anggota tidak berubah', async () => {
    const p = await siapDibayar();
    // Mapping kas dihapus: jurnal gagal di tengah proses.
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type='KAS_UMUM'`);

    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow();

    expect(await jumlahJurnal('KELUAR_ANGGOTA')).toBe(0);
    expect((await getKeluarAnggota(p.id))?.statusPengajuan).toBe('DISETUJUI');
    const a = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM anggota WHERE id='anggota-A'`
    );
    expect(a?.status).toBe('AKTIF');
  });

  it('saldo berubah setelah persetujuan -> pembayaran DITOLAK', async () => {
    const p = await siapDibayar();
    // Anggota menyetor lagi setelah disetujui.
    await setorSimpanan('SUKARELA', 500_000, 'ss2');

    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/berubah setelah pengajuan disetujui/);
    expect(await jumlahJurnal('KELUAR_ANGGOTA')).toBe(0);
  });

  it('24/§32. histori anggota TETAP TERBACA setelah keluar', async () => {
    const p = await siapDibayar();
    await bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' });

    const anggota = await testDb.getFirstAsync<{ id: string }>(
      `SELECT id FROM anggota WHERE id='anggota-A'`
    );
    expect(anggota).not.toBeNull(); // tidak dihapus
    const simpanan = await testDb.getAllAsync(
      `SELECT id FROM simpanan_transaksi WHERE anggota_id='anggota-A'`
    );
    expect(simpanan.length).toBeGreaterThan(0);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });

  it('36. journal_id menunjuk jurnal yang benar; tidak ada orphan', async () => {
    const p = await siapDibayar();
    const hasil = await bayarKeluarAnggota({
      id: p.id,
      tanggal: '2026-06-30',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const row = await getKeluarAnggota(p.id);
    expect(row?.journalId).toBe(hasil.journalId);
    const j = await testDb.getFirstAsync<{ sumber_id: string }>(
      `SELECT sumber_id FROM journal WHERE id = ?`,
      hasil.journalId
    );
    expect(j?.sumber_id).toBe(p.id);
  });

  it('kompensasi pinjaman DIBATASI hak; sisa piutang TIDAK dihapus', async () => {
    await setorSimpanan('POKOK', 500_000, 'sp1');
    await buatPinjamanOutstanding(2_000_000, 0);
    const p = await ajukanKeluarAnggota({
      anggotaId: 'anggota-A',
      alasanKeluar: 'DIBERHENTIKAN',
      tanggalPengajuan: '2026-06-01',
      tanggalEfektifKeluar: '2026-06-30',
      createdBy: 'user-1',
    });
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    const hasil = await bayarKeluarAnggota({
      id: p.id,
      tanggal: '2026-06-30',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const piutang = await testDb.getFirstAsync<{ kredit: number }>(
      `SELECT kredit FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      hasil.journalId,
      ACC.piutang
    );
    // Hanya 500.000 yang dikompensasi — sisa 1.500.000 tetap piutang.
    expect(piutang?.kredit).toBe(500_000);
    expect(await saldo(ACC.piutang, true)).toBe(-500_000);
    expect(await semuaJurnalBalanced()).toBe(true);
  });

  it('SHU disahkan tetapi belum dibagikan MENOLAK pembayaran, bukan mengarang akun', async () => {
    await setorSimpanan('POKOK', 500_000, 'sp1');
    await testDb.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, status, created_at, updated_at)
       VALUES ('shu-x',2026,'DISAHKAN_RAT',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await testDb.runAsync(
      `INSERT INTO shu_anggota (id, shu_konfigurasi_id, anggota_id, total_shu_anggota)
       VALUES ('sax','shu-x','anggota-A',200000)`
    );

    const p = await ajukanKeluarAnggota({
      anggotaId: 'anggota-A',
      alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-06-01',
      tanggalEfektifKeluar: '2026-06-30',
      createdBy: 'user-1',
    });
    expect(p.shuHakAnggota).toBe(200_000);
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');

    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/belum dibagikan/);
    expect(await jumlahJurnal('KELUAR_ANGGOTA')).toBe(0);
  });

  it('§35F/H — pengurang melebihi hak: tidak ada kas keluar, tetap DIBAYAR', async () => {
    await setorSimpanan('POKOK', 500_000, 'sp1');
    await buatPinjamanOutstanding(2_000_000, 0);
    const p = await ajukanKeluarAnggota({
      anggotaId: 'anggota-A',
      alasanKeluar: 'DIBERHENTIKAN',
      tanggalPengajuan: '2026-06-01',
      tanggalEfektifKeluar: '2026-06-30',
      createdBy: 'user-1',
    });
    expect(p.nilaiPengembalian).toBe(0);
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');

    const kasSebelum = await saldo(ACC.kas, true);
    const hasil = await bayarKeluarAnggota({
      id: p.id,
      tanggal: '2026-06-30',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(hasil.nilaiPengembalian).toBe(0);
    expect(await saldo(ACC.kas, true)).toBe(kasSebelum);
    expect(await semuaJurnalBalanced()).toBe(true);
  });
});

// ===========================================================================
// ARSITEKTUR
// ===========================================================================

describe('Fase 8 — arsitektur & integritas', () => {
  const fs = require('fs');
  const path = require('path');
  const baca = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8') as string;

  it('§10/§43 — seluruh jurnal lewat AccountingEngine, tidak ada INSERT manual', () => {
    for (const f of [
      'src/services/ImbalanKerjaService.ts',
      'src/services/KeluarAnggotaService.ts',
    ]) {
      const src = baca(f);
      expect(src).toMatch(/await createJournal\(db, \{/);
      expect(src).not.toMatch(/INSERT INTO journal\b/);
      expect(src).not.toMatch(/INSERT INTO journal_entry\b/);
      expect(src).not.toMatch(/UPDATE account SET/);
    }
  });

  it('§17 — alur lama SimpananService.keluarAnggota TIDAK diduplikasi', () => {
    const src = baca('src/services/KeluarAnggotaService.ts');
    expect(src).not.toMatch(/export async function keluarAnggota\b/);
    // Keduanya saling menutup lewat status anggota.
    expect(src).toMatch(/status === 'KELUAR'/);
  });

  it('§3 — penerima imbalan hanya dari master personel', () => {
    const src = baca('src/services/ImbalanKerjaService.ts');
    expect(src).toMatch(/FROM koperasi_personel WHERE id = \?/);
    expect(src).not.toMatch(/namaPenerimaManual|penerimaText/);
  });

  it('§19 — tidak ada nominal saldo yang diketik pengguna', () => {
    const src = baca('src/services/KeluarAnggotaService.ts');
    // Input pengajuan tidak memuat satu pun field nominal.
    const blok = src.slice(src.indexOf('export interface AjukanKeluarInput'), src.indexOf('export async function ajukanKeluarAnggota'));
    expect(blok).not.toMatch(/saldo|total|nilai|shu/i);
  });
});
