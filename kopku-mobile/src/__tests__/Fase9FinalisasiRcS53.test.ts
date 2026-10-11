// DIPERBARUI RC-S78 §11: catatan pemeriksaan kini WAJIB untuk setiap
// penyebab (baris SELESAI tanpa penjelasan tidak berguna bagi pemeriksa
// berikutnya). Nilai accounting yang diuji TIDAK diubah.
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
  catatRekonsiliasi,
  selesaikanRekonsiliasi,
  listRekonsiliasiDetail,
  getRekonsiliasiDetail,
} from '@/services/CashReconciliationService';
import { getRekening, listRekening } from '@/services/KasBankService';
import { catatRAK } from '@/services/RAKService';
import { buatUnitUsaha, setStatusUnitUsaha, listUnitUsaha } from '@/services/KoperasiMasterService';

/**
 * FASE 9 FINALISASI — integrasi UI Rekonsiliasi & RAKU.
 *
 * DATABASE VERIFIED untuk setiap operasi yang dipicu layar (dijalankan
 * lewat service yang SAMA yang dipanggil layar, di atas SQLite nyata).
 * STATIC/UI VERIFIED untuk hal yang hanya hidup di lapisan React.
 * RENDER VERIFIED = NOT VERIFIED — runner tidak dapat memount `.tsx`.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  bebanAdmin: 'acc-beban-admin',
  rak: 'acc-rak',
  modal: 'acc-modal',
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
  await seedAccount(ACC.bank, '1-1100', 'Bank BRI', 'ASET', 'DEBIT');
  await seedAccount(ACC.rak, '1-1800', 'Rekening Antar Kantor', 'ASET', 'DEBIT');
  await seedAccount(ACC.bebanAdmin, '5-2000', 'Beban Administrasi Bank', 'BEBAN', 'DEBIT');
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
     VALUES ('bank-1','Bank BRI','123456789','Koperasi',?,1,?)`,
    ACC.bank, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-modal','JRN-MODAL','2025-01-01','p2025','MODAL_AWAL','Modal awal','POSTED','user-1',?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm1','j-modal',?,5000000,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,15000000,0)`,
    ACC.bank
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm3','j-modal',?,0,20000000)`,
    ACC.modal
  );
}

async function snapshot(): Promise<Record<string, number>> {
  const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);
  const je = await testDb.getFirstAsync<{ n: number; d: number; k: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(debit),0) d, COALESCE(SUM(kredit),0) k FROM journal_entry`
  );
  return { jurnal: j?.n ?? 0, entri: je?.n ?? 0, debit: je?.d ?? 0, kredit: je?.k ?? 0 };
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

beforeEach(async () => {
  await seedFixture();
});
afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// §27 — REKONSILIASI UI
// ===========================================================================

describe('§27 Rekonsiliasi UI — DATABASE VERIFIED', () => {
  const dasar = { accountId: ACC.bank, namaRekening: 'Bank BRI', tanggal: '2026-03-10', createdBy: 'user-1' };

  it('1-2. picker memuat rekening beserta SALDO BUKU dari ledger', async () => {
    const daftar = await listRekening();
    const bri = daftar.find((r) => r.id === 'bank-1');
    expect(bri).toBeDefined();
    // Nilai yang ditampilkan picker HARUS sama dengan saldo ledger.
    expect(bri?.saldo).toBe(await saldoDebit(ACC.bank));
    expect(bri?.saldo).toBe(15_000_000);
    expect(bri?.nomorRekening).toBe('123456789');

    const kas = daftar.find((r) => r.jenis !== 'BANK');
    expect(kas?.saldo).toBe(5_000_000);
  });

  // RC-S72 — `getRekening` berkontrak `RekeningItem | null`; guard eksplisit
  // (bukan non-null assertion) supaya rekening yang hilang gagal dengan pesan jelas.
  async function saldoRekeningBank(id: string): Promise<number> {
    const rekening = await getRekening('BANK', id);
    if (!rekening) throw new Error(`Rekening bank ${id} tidak ditemukan.`);
    return rekening.saldo;
  }

  it('12. saldo dibaca ULANG setelah transaksi mengubah ledger', async () => {
    const sebelum = await saldoRekeningBank('bank-1');
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 14_800_000 });
    await selesaikanRekonsiliasi({
      rekonsiliasiId: r.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'BIAYA_ADMIN_BANK',
      perlakuan: 'PERLU_JURNAL',
      akunLawanId: ACC.bebanAdmin,
      createdBy: 'user-1',
    });
    const sesudah = await saldoRekeningBank('bank-1');
    expect(sebelum).toBe(15_000_000);
    expect(sesudah).toBe(14_800_000);
  });

  it('3-4. saldo buku dari ledger; selisih otomatis', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 14_800_000 });
    expect(r.saldoBuku).toBe(15_000_000);
    expect(r.selisih).toBe(-200_000);
  });

  it('5-6. timing difference selesai TANPA jurnal — snapshot identik', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 15_400_000 });
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
    expect(await snapshot()).toEqual(sebelum);
  });

  it('7-9. jalur jurnal: journal_id tersimpan, status SELESAI, penyelesai tercatat', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 14_800_000 });
    const hasil = await selesaikanRekonsiliasi({
      rekonsiliasiId: r.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'BIAYA_ADMIN_BANK',
      perlakuan: 'PERLU_JURNAL',
      akunLawanId: ACC.bebanAdmin,
      createdBy: 'user-1',
    });

    expect(hasil.statusPenyelesaian).toBe('SELESAI');
    expect(hasil.journalId).not.toBeNull();
    expect(hasil.diselesaikanOleh).toBe('user-1');
    expect(hasil.diselesaikanAt).not.toBeNull();

    // 13. dibaca ULANG dari database, bukan dari hasil di memori.
    const segar = await getRekonsiliasiDetail(r.id);
    expect(segar?.journalId).toBe(hasil.journalId);
    expect(segar?.penyebab).toBe('BIAYA_ADMIN_BANK');
  });

  it('10. penyelesaian kedua DITOLAK — satu jurnal', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 14_800_000 });
    const arg = {
      rekonsiliasiId: r.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'BIAYA_ADMIN_BANK' as const,
      perlakuan: 'PERLU_JURNAL' as const,
      akunLawanId: ACC.bebanAdmin,
      createdBy: 'user-1',
    };
    await selesaikanRekonsiliasi(arg);
    await expect(selesaikanRekonsiliasi(arg)).rejects.toThrow(/sudah diselesaikan/);

    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`
    );
    expect(n?.n).toBe(1);
  });

  it('11. rollback — akun lawan tidak sah, tidak ada jejak', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 14_800_000 });
    const sebelum = await snapshot();
    await expect(
      selesaikanRekonsiliasi({
        rekonsiliasiId: r.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'LAINNYA',
        perlakuan: 'PERLU_JURNAL',
        akunLawanId: 'tidak-ada',
        createdBy: 'user-1',
      })
    ).rejects.toThrow();
    expect((await getRekonsiliasiDetail(r.id))?.statusPenyelesaian).toBe('DRAFT');
    expect(await snapshot()).toEqual(sebelum);
  });

  it('12. periode CLOSED ditolak; periode tidak dibuka sendiri', async () => {
    const r = await catatRekonsiliasi({ ...dasar, saldoFisik: 14_800_000 });
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);
    await expect(
      selesaikanRekonsiliasi({
        rekonsiliasiId: r.id,
        catatan: 'pemeriksaan RC-S78', penyebab: 'BIAYA_ADMIN_BANK',
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

  it('13. daftar per rekening menyaring di SQL', async () => {
    await catatRekonsiliasi({ ...dasar, saldoFisik: 14_800_000 });
    await catatRekonsiliasi({
      accountId: ACC.kas,
      namaRekening: 'Kas',
      tanggal: '2026-03-10',
      saldoFisik: 5_000_000,
      createdBy: 'user-1',
    });
    expect(await listRekonsiliasiDetail({ accountId: ACC.bank })).toHaveLength(1);
    expect(await listRekonsiliasiDetail()).toHaveLength(2);
  });
});

// ===========================================================================
// §28 — RAKU UI
// ===========================================================================

describe('§28 RAKU UI — DATABASE VERIFIED', () => {
  const dasar = {
    jenisRak: 'PENYALURAN_DANA' as const,
    namaUnit: 'Unit Toko',
    jumlah: 1_000_000,
    tanggal: '2026-03-10',
    sumberDana: 'KAS' as const,
    createdBy: 'user-1',
  };

  it('1-3. picker memuat unit AKTIF saja', async () => {
    const aktif = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    const tutup = await buatUnitUsaha({ namaUsaha: 'Unit Tutup' });
    await setStatusUnitUsaha(tutup, 'NONAKTIF');

    const kandidat = await listUnitUsaha(true);
    expect(kandidat.map((u) => u.id)).toContain(aktif);
    expect(kandidat.map((u) => u.id)).not.toContain(tutup);
    // Histori tetap terbaca lewat daftar lengkap.
    expect((await listUnitUsaha()).map((u) => u.id)).toContain(tutup);
  });

  it('4. unit_usaha_id STABIL walau nama unit berubah', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Awal' });
    const hasil = await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' });
    const row = await testDb.getFirstAsync<{ unit_usaha_id: string; nama_unit: string }>(
      `SELECT unit_usaha_id, nama_unit FROM rak_transaksi WHERE id = ?`,
      hasil.id
    );
    expect(row?.unit_usaha_id).toBe(unitId);
    // DIPERBARUI RC-S72 (LEGACY EXPECTATION): sejak RC-S64 §10 `nama_unit`
    // DITURUNKAN dari master unit usaha, bukan dari teks `namaUnit` pemanggil
    // (`dasar.namaUnit = 'Unit Toko'`). Kontrak aktual dikunci
    // ModalTetapUnitUsahaRcS64. Test ini tertutup TS2531 sejak RC-S64 sehingga
    // ekspektasi lamanya tidak pernah dievaluasi.
    expect(row?.nama_unit).toBe('Unit Awal');
    // Inti test ini — id STABIL walau nama master berubah sesudahnya.
    await testDb.runAsync(`UPDATE koperasi_unit_usaha SET nama_usaha = 'Unit Baru' WHERE id = ?`, unitId);
    const sesudah = await testDb.getFirstAsync<{ unit_usaha_id: string }>(
      `SELECT unit_usaha_id FROM rak_transaksi WHERE id = ?`,
      hasil.id
    );
    expect(sesudah?.unit_usaha_id).toBe(unitId);
  });

  it('5-6/12. jenis transaksi & alokasi tersimpan; jurnal balanced', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    const hasil = await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'OPERASIONAL' });
    const row = await testDb.getFirstAsync<{ jenis_rak: string; jenis_alokasi: string; journal_id: string }>(
      `SELECT jenis_rak, jenis_alokasi, journal_id FROM rak_transaksi WHERE id = ?`,
      hasil.id
    );
    expect(row?.jenis_rak).toBe('PENYALURAN_DANA');
    expect(row?.jenis_alokasi).toBe('OPERASIONAL');

    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      row?.journal_id as string
    );
    expect(baris.reduce((t, b) => t + b.debit, 0)).toBe(baris.reduce((t, b) => t + b.kredit, 0));
    // OPERASIONAL tetap ASET internal, bukan beban.
    expect(baris.filter((b) => b.debit > 0).map((b) => b.account_id)).toContain(ACC.rak);
  });

  it('9-10. sumber KAS & BANK keduanya didukung', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    const kas = await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' });
    const bank = await catatRAK({
      ...dasar,
      unitUsahaId: unitId,
      jenisAlokasi: 'MODAL_TAMBAHAN',
      sumberDana: 'BANK',
      bankAccountId: 'bank-1',
    });
    const rows = await testDb.getAllAsync<{ id: string; sumber_dana: string; bank_account_id: string | null }>(
      `SELECT id, sumber_dana, bank_account_id FROM rak_transaksi`
    );
    expect(rows.find((r) => r.id === kas.id)?.sumber_dana).toBe('KAS');
    expect(rows.find((r) => r.id === bank.id)?.sumber_dana).toBe('BANK');
    expect(rows.find((r) => r.id === bank.id)?.bank_account_id).toBe('bank-1');
  });

  it('3b. unit NONAKTIF ditolak untuk transaksi BARU', async () => {
    const tutup = await buatUnitUsaha({ namaUsaha: 'Unit Tutup' });
    await setStatusUnitUsaha(tutup, 'NONAKTIF');
    await expect(
      catatRAK({ ...dasar, unitUsahaId: tutup, jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow(/NONAKTIF/);
  });

  it('7. nominal nol & negatif ditolak', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    for (const jumlah of [0, -1_000]) {
      await expect(
        catatRAK({ ...dasar, jumlah, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' })
      ).rejects.toThrow();
    }
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM rak_transaksi`);
    expect(n?.n).toBe(0);
  });

  it('11. nomor RAKU unik pada dua transaksi berturut-turut', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    // DIPERBARUI RC-S72 (FIXTURE): RC-S64 membatasi 1 Modal Tetap aktif per unit,
    // sehingga fixture lama (dua MODAL_TETAP) kini ditolak by design. Yang diuji
    // tetap sama — penomoran unik dua transaksi berturut-turut.
    await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' });
    await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'OPERASIONAL' });
    const nomor = await testDb.getAllAsync<{ nomor_rak: string }>(`SELECT nomor_rak FROM rak_transaksi`);
    expect(nomor).toHaveLength(2);
    expect(new Set(nomor.map((n) => n.nomor_rak)).size).toBe(2);
  });

  it('13. rollback — mapping RAK hilang, tidak ada baris tersimpan', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type='RAK'`);
    await expect(
      catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow();
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM rak_transaksi`);
    expect(n?.n).toBe(0);
  });

  it('14. periode CLOSED ditolak', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);
    await expect(
      catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' })
    ).rejects.toThrow(/ditutup|CLOSED/i);
  });

  it('15. bertahan setelah pembacaan ulang', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    const hasil = await catatRAK({ ...dasar, unitUsahaId: unitId, jenisAlokasi: 'MODAL_TETAP' });
    for (let i = 0; i < 3; i += 1) {
      const row = await testDb.getFirstAsync<{ unit_usaha_id: string }>(
        `SELECT unit_usaha_id FROM rak_transaksi WHERE id = ?`,
        hasil.id
      );
      expect(row?.unit_usaha_id).toBe(unitId);
    }
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });
});

// ===========================================================================
// §29 — STATIC/UI VERIFIED
// ===========================================================================

describe('§29 STATIC/UI VERIFIED', () => {
  const rekon = tanpaKomentar(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'));
  const raku = tanpaKomentar(baca('src/screens/Transaksi/RAKFormScreen.tsx'));
  const picker = tanpaKomentar(baca('src/components/RekeningPicker.tsx'));

  // RC-S67.9: layar Rekonsiliasi disederhanakan (satu layar, bahasa pengguna).
  // Assertion UI §29 di bawah DISELARASKAN dengan perilaku baru — tidak
  // dihapus: jaminan intinya (tanpa logika akuntansi di layar, saldo buku &
  // selisih read-only, baca ulang DB, galat diteruskan) tetap diuji.
  it('RekonsiliasiScreen memakai service (catat + penyelesaian existing, atomik), bukan logika sendiri', () => {
    expect(rekon).toMatch(/catatRekonsiliasiDanTindakLanjut\(\{/);
    expect(rekon).not.toMatch(/SELESAIKAN REKONSILIASI|Selesaikan Rekonsiliasi/);
    const svc = tanpaKomentar(baca('src/services/CashReconciliationService.ts'));
    expect(svc).toMatch(/return selesaikanDalamTransaksi\(db, \{/);
  });

  it('RekonsiliasiScreen tidak menyentuh AccountingEngine, SQL, maupun ledger', () => {
    for (const t of ['AccountingEngine', 'createJournal', 'INSERT INTO', 'SELECT ', 'UPDATE ', 'getDb(']) {
      expect(rekon).not.toContain(t);
    }
  });

  it('saldo buku (per tanggal, dari ledger) & selisih READ-ONLY di layar rekonsiliasi', () => {
    expect(rekon).toContain('SALDO MENURUT BUKU');
    expect(rekon).toContain('getSaldoBukuPerTanggal(rekening.accountId, tanggal)');
    expect(rekon).toContain('hitungSelisih(saldoBukuPerTanggal, saldoAktual)');
    // Satu-satunya input angka adalah saldo aktual.
    expect((rekon.match(/<CurrencyInput/g) ?? []).length).toBe(1);
    expect(rekon).toContain('<CurrencyInput value={saldoAktual} onChangeValue={setSaldoAktual} />');
    expect(rekon).not.toMatch(/setSelisih/);
  });

  it('picker rekening diberi label saldo tanpa mengubah picker lain', () => {
    expect(rekon).toMatch(/labelSaldo="Saldo saat ini"/);
    expect(picker).toMatch(/labelSaldo\?: string;/);
    // Prop OPSIONAL — tanpa nilai, tampilan picker lain tidak berubah.
    expect(picker).toMatch(/\{labelSaldo \? <Text style=\{styles\.rowSaldoLabel\}>\{labelSaldo\}<\/Text> : null\}/);
    expect(picker).toMatch(/formatRupiah\(item\.saldo\)/);
  });

  it('perilaku hanyaBank TIDAK diubah', () => {
    expect(picker).toMatch(/hanyaBank \? aktifSaja\.filter\(\(r\) => r\.jenis === 'BANK'\)/);
  });

  it('saldo COCOK tidak menawarkan penyesuaian; pilihan penyebab hanya saat ada selisih', () => {
    expect(rekon).toMatch(/status === 'KURANG' \|\| status === 'LEBIH' \?/);
    expect(rekon).toContain('Tidak diperlukan penyesuaian.');
    // RC-S67.9.1: satu CTA utama per kondisi.
    expect(rekon).toMatch(/disabled=\{!cta\.aktif \|\| submitting\}/);
  });

  it('rekonsiliasi membaca ulang database setelah simpan; bukan optimistic', () => {
    expect(rekon).toMatch(/catatRekonsiliasiDanTindakLanjut\([\s\S]{0,2500}await Promise\.all\(\[loadHistori\(\), muatSaldo\(\)\]\);/);
    expect(rekon).not.toMatch(/setHistori\(\[\.\.\.histori/);
  });

  it('pesan error service diteruskan, tidak ditelan', () => {
    expect(rekon).toMatch(/Rekonsiliasi gagal disimpan/);
    expect(rekon).not.toMatch(/catch \([^)]*\) \{\s*\}/);
  });

  it('RAKU memakai master unit usaha, hanya yang AKTIF', () => {
    expect(raku).toMatch(/from '@\/services\/KoperasiMasterService'/);
    expect(raku).toMatch(/listUnitUsaha\(true\)/);
    expect(raku).toMatch(/setUnitUsahaId\(u\.id\)/);
  });

  it('RAKU mengirim unit_usaha_id dan jenis alokasi ke service', () => {
    expect(raku).toMatch(/unitUsahaId: unitUsahaId \?\? undefined/);
    expect(raku).toMatch(/jenisAlokasi,/);
    expect(raku).toMatch(/JENIS_ALOKASI_RAKU\.map/);
  });

  it('RAKU memakai vocabulary service, bukan enum kedua', () => {
    expect(raku).toMatch(/JENIS_ALOKASI_RAKU/);
    expect(raku).toMatch(/JENIS_RAK_LABEL/);
    expect(raku).not.toMatch(/const JENIS_ALOKASI[^_]/);
  });

  it('RAKU tidak menyentuh SQL maupun jurnal langsung', () => {
    for (const t of ['createJournal', 'INSERT INTO', 'SELECT ', 'getDb(']) {
      expect(raku).not.toContain(t);
    }
    expect(raku).toMatch(/await catatRAK\(/);
  });

  it('kedua layar punya loading, error, dan disabled-while-saving', () => {
    for (const src of [rekon, raku]) {
      expect(src).toMatch(/ActivityIndicator/);
      expect(src).toMatch(/disabled=\{/);
      expect(src).toMatch(/getTanggalLokalHariIni\(\)/);
    }
    expect(raku).toMatch(/galatUnit/);
    expect(raku).toContain('Belum ada unit usaha aktif.');
  });

  // DIPERBARUI RC-S53 — v63 dibuat untuk register bagian SHU
  // (KEPUTUSAN 04-A), bukan untuk Fase 9. Yang dijaga di sini: Fase 9
  // sendiri tetap tidak membawa migrasi, dan tidak ada versi di luar v63.
  it('§34 — Fase 9 tidak menambah migrasi; skema minimal v62 dan tidak lebih dari v63', () => {
    const schema = baca('src/database/schema.ts');
    const cocok = schema.match(/export const SCHEMA_VERSION = (\d+);/);
    expect(Number(cocok![1])).toBeGreaterThanOrEqual(62);
    // DIPERBARUI RC-S72: batas atas 68 -> 69. v69 milik RC-S55 (lihat komentar
    // baris berikut); guard literal tidak ikut diperbarui saat itu.
    expect(Number(cocok![1])).toBeLessThanOrEqual(81); // DIPERBARUI v81 (RC-S133.6.2: sidik import & koreksi_transaksi, aditif; migrasi milik RC-S133.6.2). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128, migrasi milik kebijakan produk simpanan berjangka). DIPERBARUI v78. DIPERBARUI v77 (Poin 5/6/10): blok v77 milik patch 19 poin (kolom unit_usaha_id + klasifikasi/label akun), bukan tahap ini; ambang digeser ke 78.  DIPERBARUI RC-S88: v73 = nilai wajar/revaluasi (milik RC-S88) · DIPERBARUI v72 = penarikan dana investasi · DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN), aditif murni lewat ADD COLUMN. Migrasi itu MILIK RC-S114 — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    expect(baca('src/database/db.ts')).not.toMatch(/currentVersion < 82/); // DIPERBARUI v81 (blok v81 milik RC-S133.6.2, bukan tahap ini; ambang digeser ke 82). DIPERBARUI v80 (blok v80 milik RC-S132, bukan tahap ini; ambang digeser ke 81). DIPERBARUI v79 (blok v79 milik RC-S128, bukan tahap ini; ambang digeser ke 80). DIPERBARUI v78 (blok v78 milik fitur bunga harian sukarela, bukan tahap ini; ambang digeser ke 79). DIPERBARUI v77 (Poin 5/6/10): blok v77 milik patch 19 poin (kolom unit_usaha_id + klasifikasi/label akun), bukan tahap ini; ambang digeser ke 78.  DIPERBARUI RC-S88: blok v73 MILIK RC-S88 (nilai wajar/revaluasi); ambang digeser ke 74. // DIPERBARUI v72 = penarikan dana investasi (milik modul itu, bukan tahap ini) · DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: blok v70 (asal personel) kini ADA dan MILIK restrukturisasi Data/Personel; ambang digeser ke 71 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: blok v74 MILIK RC-S100 (riwayat import data awal, dua tabel BARU aditif); ambang digeser ke 75 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji.
  });

  // DIPERBARUI RC-S88 (keputusan pengguna — rekomendasi SAK EP): §35 dulu mengunci
  // "nilai wajar tidak pernah diposting". Kebijakan itu DIGANTI: properti investasi
  // model nilai wajar (laba rugi) & aset tetap model revaluasi (OCI). Yang tetap
  // dijaga: jurnal HANYA lewat createJournal + mapping resmi, tanpa kode akun hard-code.
  it('§35 (RC-S88) — Fair Value diposting lewat mapping resmi; tanpa kode akun hard-code', () => {
    const svc = tanpaKomentar(baca('src/services/PenyesuaianNilaiWajarService.ts'));
    expect(svc).toMatch(/createJournal\(db, \{/);
    for (const k of ['4-2100', '5-5000', '1-1665']) expect(svc).not.toContain(k);
    // DIPERBARUI RC-S72 (LEGACY EXPECTATION): akun 4-2100/5-5000 DITAMBAHKAN atas
    // keputusan pengguna di RC-S54 POST-CLOSURE #14 sebagai DEFINED / NOT ACTIVELY
    // POSTED (gated POLICY 03). Invarian yang sesungguhnya dijaga §35 — nilai wajar
    // tidak pernah diposting — dikunci langsung: tidak ada mapping default ke dua
    // akun itu dan gerbang mapping tetap mati.
    const coa = baca('src/config/defaultCOA.ts');
    const barisMapping = coa.split('\n').filter((b) => /transactionType|transaction_type/.test(b));
    expect(barisMapping.filter((b) => b.includes("'4-2100'") || b.includes("'5-5000'"))).toHaveLength(2);
    expect(barisMapping.every((b) => !(b.includes("'4-2100'") || b.includes("'5-5000'")) || b.includes('NILAI_WAJAR_PROPERTI_INVESTASI'))).toBe(true);
    expect(baca('src/services/PenyesuaianNilaiWajarService.ts')).toMatch(/export const MAPPING_NILAI_WAJAR_AKTIF = true;/);
  });
});
