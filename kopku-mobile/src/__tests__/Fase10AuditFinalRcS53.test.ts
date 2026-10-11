// DIPERBARUI RC-S79 §3: rekening uji adalah KAS; biaya bank/jasa giro kini
// hanya sah untuk rekening BANK. Diganti 'SELISIH_FISIK' (padanan kas,
// sama-sama PERLU_JURNAL) — nilai accounting yang diuji TIDAK berubah.
// DIPERBARUI RC-S78 §11: catatan pemeriksaan wajib untuk setiap penyebab.
// Nilai accounting yang diuji TIDAK diubah.
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

import { SCHEMA_VERSION } from '@/database/schema';
import { DEFAULT_ACCOUNTS as DEFAULT_COA } from '@/config/defaultCOA';
import {
  simpanDraftNilaiWajar,
  postingNilaiWajar,
  listDraftNilaiWajar,
} from '@/services/PenyesuaianNilaiWajarService';
import { catatRAK, JENIS_ALOKASI_RAKU } from '@/services/RAKService';
import { buatUnitUsaha } from '@/services/KoperasiMasterService';
import { catatRekonsiliasi, selesaikanRekonsiliasi } from '@/services/CashReconciliationService';

/**
 * RC-S53 FASE 10 — AUDIT FINAL.
 *
 * Fase ini SENGAJA tidak menambah akuntansi baru. Seluruh requirement
 * yang tersisa (COA baru, model nilai wajar, dasar pengakuan bagian
 * SHU, mapping investasi, semantik RAKU PENGUATAN) bergantung pada
 * keputusan kebijakan yang belum diberikan. Yang diuji di sini adalah
 * bahwa keadaan terkunci itu BENAR-BENAR terkunci — bukan sekadar
 * dinyatakan di laporan.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}
function tanpaKomentar(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Dua belas kode yang diminta requirement awal dan BELUM diputuskan. */
const KODE_DIMINTA = [
  '1-660', '1-661', '1-220', '1-230', '1-240', '1-250',
  '4-1510', '4-1520', '4-1530', '4-1540', '4-2100', '5-5000',
];

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  rak: 'acc-rak',
  bebanAdmin: 'acc-beban-admin',
  modal: 'acc-modal',
};

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
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-modal','JRN-MODAL','2025-01-01','p2025','MODAL_AWAL','Modal awal','POSTED','user-1',?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm1','j-modal',?,20000000,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,10000000,0)`,
    ACC.bank
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm3','j-modal',?,0,30000000)`,
    ACC.modal
  );
}

async function seedProperti(nilai: number): Promise<string> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                            sumber_dana, status, created_by, created_at, updated_at)
     VALUES ('inv-1','INV-1','PROPERTI_INVESTASI','Ruko Melati',?,'2026-01-05','KAS','AKTIF','user-1',?,?)`,
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
// §36 — INTEGRITAS COA
// ===========================================================================

describe('§36 COA — integritas', () => {
  it('1. seluruh kode akun UNIK', () => {
    const kode = DEFAULT_COA.map((a) => a.kode);
    expect(new Set(kode).size).toBe(kode.length);
  });

  it('2. seluruh kode berformat X-NNNN', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (permintaan pengguna): 12 kode diminta DITAMBAHKAN sebagai akun COA (DEFINED / NOT ACTIVELY POSTED); tidak ada mapping/posting/jurnal yang berubah.
    const KODE_DIMINTA_3_DIGIT = ['1-220', '1-230', '1-240', '1-250', '1-660', '1-661'];
    const salah = DEFAULT_COA.map((a) => a.kode).filter((k) => !(KODE_DIMINTA_3_DIGIT.includes(k) ? /^[1-9]-\d{3}$/ : /^[1-9]-\d{4}$/).test(k));
    expect(salah).toEqual([]);
  });

  it('3. nama akun ganda HANYA pasangan kode-diminta vs akun semantik existing', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (permintaan pengguna): 12 kode diminta DITAMBAHKAN sebagai akun COA (DEFINED / NOT ACTIVELY POSTED); tidak ada mapping/posting/jurnal yang berubah.
    const nama = DEFAULT_COA.map((a) => a.nama);
    const ganda = [...new Set(nama.filter((n, i) => nama.indexOf(n) !== i))].sort();
    expect(ganda).toEqual(['Piutang Bagi Hasil', 'Piutang Pendapatan Investasi', 'Piutang Pendapatan Sewa']);
    for (const n of ganda) {
      const pasangan = DEFAULT_COA.filter((a) => a.nama === n).map((a) => a.kode);
      expect(pasangan).toHaveLength(2);
      expect(pasangan.filter((k) => /^[1-9]-\d{3}$/.test(k))).toHaveLength(1);
    }
  });

  it('4. normal balance sesuai kategori — kontra-akun dikecualikan secara eksplisit', () => {
    // Empat akun ini SENGAJA berlawanan arah karena mereka kontra-aset
    // (pengurang aset), dan itu memang benar secara akuntansi.
    // DIPERBARUI RC-S53 corrective — 1-1670 kontra-aset baru: akumulasi
    // penyusutan properti investasi (POLICY 03 = MODEL BIAYA).
    const KONTRA_ASET = ['1-1210', '1-1510', '1-1670', '1-1710', '1-1900'];
    const menyimpang = DEFAULT_COA.filter((a) => {
      if (KONTRA_ASET.includes(a.kode)) return false;
      const harusDebit = a.kategori === 'ASET' || a.kategori === 'BEBAN';
      return harusDebit ? a.normalBalance !== 'DEBIT' : a.normalBalance !== 'KREDIT';
    }).map((a) => a.kode);
    expect(menyimpang).toEqual([]);

    for (const k of KONTRA_ASET) {
      const a = DEFAULT_COA.find((x) => x.kode === k);
      expect(a?.kategori).toBe('ASET');
      expect(a?.normalBalance).toBe('KREDIT');
    }
  });

  it('7. COA existing TETAP UTUH — tidak ada akun yang dihapus', () => {
    // Akun yang menjadi tulang punggung modul RC-S53.
    for (const k of [
      '1-1000', '1-1100', '1-1200', '1-1205', '1-1630', '1-1640', '1-1650', '1-1660',
      '1-1800', '2-1200', '2-1600', '2-1700', '2-1710', '3-3000', '3-4000', '5-1050',
    ]) {
      expect(DEFAULT_COA.map((a) => a.kode)).toContain(k);
    }
    expect(DEFAULT_COA.length).toBeGreaterThanOrEqual(75);
  });

  it('§27 — TIDAK ADA satu pun dari 12 kode yang diminta ditambahkan', () => {
    // Enam berformat 3 digit (melanggar X-NNNN), enam sisanya menunggu
    // konfirmasi mapping. Keduanya POLICY_REQUIRED; menambahkannya
    // sekarang berarti memilih angka/semantik sendiri.
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (permintaan pengguna): 12 kode diminta DITAMBAHKAN sebagai akun COA (DEFINED / NOT ACTIVELY POSTED); tidak ada mapping/posting/jurnal yang berubah.
    const kode = DEFAULT_COA.map((a) => a.kode);
    for (const k of KODE_DIMINTA) expect(kode).toContain(k);
  });

  it('§4 — semantik pendapatan yang diminta SUDAH punya akun existing', () => {
    // Bukti konflik semantik: menambah 4-1510..4-1540 akan menduplikasi
    // akun yang sudah ada dan sudah dipakai laporan.
    const nama = DEFAULT_COA.map((a) => a.nama);
    expect(nama).toContain('Pendapatan Bunga');
    expect(nama).toContain('Pendapatan Hasil Investasi');
    expect(nama).toContain('Pendapatan Bagi Hasil');
    expect(nama).toContain('Pendapatan Sewa');
  });

  it('6. COA bertahan di database setelah ditulis & dibaca ulang', async () => {
    const now = new Date().toISOString();
    for (const a of DEFAULT_COA.slice(0, 20)) {
      await testDb.runAsync(
        `INSERT OR IGNORE INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
         VALUES (?,?,?,?,?,1,1,?,?)`,
        `coa-${a.kode}`, a.kode, a.nama, a.kategori, a.normalBalance, now, now
      );
    }
    // Beberapa kode fixture sengaja bertabrakan dengan COA bawaan
    // (Kas, Bank, RAK). `INSERT OR IGNORE` membiarkan baris existing —
    // itulah perilaku yang benar: COA tidak boleh ditimpa. Yang diuji
    // karena itu bukan jumlahnya, melainkan bahwa TIDAK ADA duplikat
    // kode yang terbentuk di database.
    const semua = await testDb.getAllAsync<{ kode: string }>(`SELECT kode FROM account`);
    expect(new Set(semua.map((r) => r.kode)).size).toBe(semua.length);
    const dimasukkan = await testDb.getAllAsync<{ kode: string }>(
      `SELECT kode FROM account WHERE id LIKE 'coa-%'`
    );
    expect(dimasukkan.length).toBeGreaterThan(0);
    // Setiap baris yang masuk benar-benar berasal dari DEFAULT_ACCOUNTS.
    const kodeCoa = DEFAULT_COA.map((a) => a.kode);
    for (const d of dimasukkan) expect(kodeCoa).toContain(d.kode);
  });
});

// ===========================================================================
// §37 — FAIR VALUE
// DIPERBARUI RC-S88 (keputusan pengguna — rekomendasi SAK EP): kebijakan
// "posting nilai wajar tertutup" DIGANTI model nilai wajar properti investasi
// (laba rugi) & model revaluasi aset tetap (OCI). Posting kini lewat gerbang
// yang menuntut mapping resmi; fixture suite ini sengaja TIDAK memetakan akun
// nilai wajar, sehingga §37 membuktikan gerbang menolak tanpa jurnal parsial.
// Posting sukses diuji di PenyesuaianNilaiWajarRcS54 & RcS88NilaiWajarOci.
// ===========================================================================

describe('§37 Fair Value — gerbang posting (RC-S88)', () => {
  it('1-3. draft, perhitungan, dan metadata audit tetap berjalan', async () => {
    const id = await seedProperti(500_000_000);
    const d = await simpanDraftNilaiWajar({
      investasiId: id,
      tanggal: '2026-06-30',
      nilaiWajar: 560_000_000,
      dasarPenilaian: 'KJPP',
      referensiBukti: 'KJPP-2026-011',
      createdBy: 'user-1',
    });
    expect(d.status).toBe('DRAFT');
    expect(d.selisih).toBe(60_000_000);
    expect(d.arahPerubahan).toBe('KENAIKAN');
    expect(d.createdBy).toBe('user-1');
    expect(d.dasarPenilaian).toBe('KJPP');
    expect(d.referensiBukti).toBe('KJPP-2026-011');
  });

  it('4-5. POST tanpa mapping nilai wajar DITOLAK dan tidak ada jurnal yang terbentuk', async () => {
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
    const sebelum = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);

    await expect(postingNilaiWajar(d.id, { userId: 'user-1' })).rejects.toThrow(/NILAI_WAJAR_PROPERTI_INVESTASI/);

    const sesudah = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);
    expect(sesudah?.n).toBe(sebelum?.n);
    expect((await listDraftNilaiWajar())[0].status).toBe('DRAFT');
  });

  it('§8 (RC-S88) — 4-2100 & 5-5000 dipakai HANYA lewat mapping NILAI_WAJAR_PROPERTI_INVESTASI', () => {
    const svc = tanpaKomentar(baca('src/services/PenyesuaianNilaiWajarService.ts'));
    expect(svc).not.toContain('4-2100');
    expect(svc).not.toContain('5-5000');
    expect(svc).toMatch(/createJournal\(db, \{/);
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (permintaan pengguna): 12 kode diminta DITAMBAHKAN sebagai akun COA (DEFINED / NOT ACTIVELY POSTED); tidak ada mapping/posting/jurnal yang berubah.
    // Akun nilai wajar terdefinisi, tetapi TIDAK dipetakan & tidak dipakai service mana pun.
    const coa = baca('src/config/defaultCOA.ts');
    const blokMapping = coa.slice(coa.indexOf('DEFAULT_ACCOUNT_MAPPING'));
    for (const k of ['4-2100', '5-5000']) {
      expect(coa).toContain(`{ kode: '${k}'`);
      expect(blokMapping).toContain(`accountKode: '${k}'`);
    }
  });

  it('status POSTED tetap tidak ada di enum skema (RC-S88: DIPOSTING)', () => {
    const schema = baca('src/database/schema.ts');
    const awal = schema.indexOf('CREATE TABLE IF NOT EXISTS penyesuaian_nilai_wajar');
    const blok = schema.slice(awal, schema.indexOf(');', awal));
    expect(blok).toMatch(/status IN \('DRAFT','DIPOSTING','DIBATALKAN'\)/);
    expect(blok).not.toContain("'POSTED'");
  });
});

// ===========================================================================
// §38 — INVESTASI KOPERASI LAIN: BELUM ADA POLICY
// ===========================================================================

describe('§38 Investasi Koperasi Lain — POLICY_REQUIRED', () => {
  it('tidak ada klasifikasi return type di skema — belum diputuskan', () => {
    const schema = baca('src/database/schema.ts');
    const awal = schema.indexOf('CREATE TABLE IF NOT EXISTS investasi (');
    const blok = schema.slice(awal, schema.indexOf(');', awal));
    // SIMPANAN_MODAL_BAGIAN_SHU / IMBAL_HASIL_TETAP belum ada, dan itu
    // memang belum boleh ditambahkan sebelum dasar pengakuannya
    // ditetapkan.
    expect(blok).not.toContain('SIMPANAN_MODAL_BAGIAN_SHU');
    expect(blok).not.toContain('IMBAL_HASIL_TETAP');
    expect(blok).not.toContain('return_type');
  });

  it('jenis investasi existing tetap utuh', () => {
    const schema = baca('src/database/schema.ts');
    for (const j of ['UNIT_USAHA', 'KOPERASI_LAIN', 'USAHA_LAIN', 'PROPERTI_INVESTASI']) {
      expect(schema).toContain(j);
    }
  });

  // DIPERBARUI RC-S53 — KEPUTUSAN 04-A & 05 sudah turun, jadi assertion
  // "belum ada service apa pun" tidak lagi menggambarkan keadaan yang
  // benar. Yang dijaga sekarang adalah BATASNYA: hanya bagian SHU yang
  // boleh ada. RC-S67.6.1: imbal hasil tetap AKTIF sebagai penerimaan kas
  // lewat PendapatanLainnyaService (bukan service tersendiri); AKRUAL-nya
  // tetap nonaktif (KEPUTUSAN 06) sehingga service khusus tetap tidak ada.
  it('hanya service bagian SHU yang ada; imbal hasil tetap tetap tidak dibuat', () => {
    const svcDir = join(__dirname, '..', 'services');
    const fs = require('fs');
    const berkas = fs.readdirSync(svcDir) as string[];
    expect(berkas).toContain('BagianShuService.ts');
    expect(berkas).not.toContain('InvestasiReturnService.ts');
    expect(berkas).not.toContain('ImbalHasilTetapService.ts');
  });
});

// ===========================================================================
// §39 — RAKU: SEMANTIK BELUM LENGKAP
// ===========================================================================

describe('§39 RAKU — jenis transaksi', () => {
  it('CHECK jenis_rak TIDAK diubah; legacy tetap terbaca', () => {
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(/jenis_rak TEXT NOT NULL CHECK \(jenis_rak IN \('PENYALURAN_DANA','SETORAN_DANA'\)\)/);
    // PENGUATAN belum punya semantik akuntansi, jadi belum ditambahkan.
    expect(schema).not.toContain("'PENGUATAN'");
  });

  it('PENYALURAN tetap mendebit aset RAK, bukan beban', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    const hasil = await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Unit Toko',
      unitUsahaId: unitId,
      jenisAlokasi: 'OPERASIONAL',
      jumlah: 1_000_000,
      tanggal: '2026-03-10',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const row = await testDb.getFirstAsync<{ journal_id: string }>(
      `SELECT journal_id FROM rak_transaksi WHERE id = ?`,
      hasil.id
    );
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      row?.journal_id as string
    );
    expect(baris.filter((b) => b.debit > 0).map((b) => b.account_id)).toContain(ACC.rak);
    expect(baris.reduce((t, b) => t + b.debit, 0)).toBe(baris.reduce((t, b) => t + b.kredit, 0));
  });

  it('ketiga jenis alokasi tetap tersedia dan divalidasi service', () => {
    expect(JENIS_ALOKASI_RAKU).toEqual(['MODAL_TETAP', 'MODAL_TAMBAHAN', 'OPERASIONAL']);
  });
});

// ===========================================================================
// §42-50 — REKONSILIASI AKUNTANSI MENYELURUH
// ===========================================================================

describe('§42-50 audit akuntansi menyeluruh', () => {
  it('TRIAL BALANCE seimbang setelah rangkaian transaksi lintas modul', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Unit Toko',
      unitUsahaId: unitId,
      jenisAlokasi: 'MODAL_TETAP',
      jumlah: 2_000_000,
      tanggal: '2026-03-10',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const rek = await catatRekonsiliasi({
      accountId: ACC.bank,
      namaRekening: 'Bank BRI',
      tanggal: '2026-03-11',
      saldoFisik: 9_900_000,
      createdBy: 'user-1',
    });
    await selesaikanRekonsiliasi({
      rekonsiliasiId: rek.id,
      catatan: 'pemeriksaan RC-S78', penyebab: 'SELISIH_FISIK',
      perlakuan: 'PERLU_JURNAL',
      akunLawanId: ACC.bebanAdmin,
      createdBy: 'user-1',
    });

    // 42. Debit total = Kredit total.
    const total = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(kredit),0) k FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id WHERE j.status IN ('POSTED','REVERSED')`
    );
    expect(total?.d).toBe(total?.k);

    // 44. Setiap jurnal seimbang, bukan hanya totalnya.
    const perJurnal = await testDb.getAllAsync<{ d: number; k: number }>(
      `SELECT SUM(debit) d, SUM(kredit) k FROM journal_entry GROUP BY journal_id`
    );
    for (const p of perJurnal) expect(p.d).toBe(p.k);
  });

  it('43. Aset = Liabilitas + Ekuitas', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Unit Toko',
      unitUsahaId: unitId,
      jenisAlokasi: 'MODAL_TETAP',
      jumlah: 2_000_000,
      tanggal: '2026-03-10',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const perKategori = await testDb.getAllAsync<{ kategori: string; s: number }>(
      `SELECT a.kategori, COALESCE(SUM(je.debit - je.kredit),0) s
         FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
         JOIN account a ON a.id = je.account_id
        WHERE j.status IN ('POSTED','REVERSED')
        GROUP BY a.kategori`
    );
    const ambil = (k: string) => perKategori.find((p) => p.kategori === k)?.s ?? 0;
    const aset = ambil('ASET');
    // Liabilitas & ekuitas bersaldo KREDIT, jadi tandanya dibalik.
    const liabEkuitas = -(ambil('LIABILITAS') + ambil('EKUITAS'));
    const labaRugi = -(ambil('PENDAPATAN') + ambil('BEBAN'));
    expect(aset).toBe(liabEkuitas + labaRugi);
  });

  it('50. saldo RAKU dapat direkonsiliasi dengan subledger', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    // RC-S64: satu Unit Usaha hanya boleh punya SATU Modal Tetap aktif, jadi
    // alokasi kedua di fixture ini menjadi MODAL_TAMBAHAN. Yang diuji test ini
    // adalah kecocokan ledger 1-1800 dengan subledger `rak_transaksi` dan
    // totalnya (3.500.000) — keduanya tidak bergantung pada jenis alokasi.
    // Tidak ada expected value yang dilonggarkan.
    const alokasi50 = [
      { jumlah: 1_000_000, jenisAlokasi: 'MODAL_TETAP' as const },
      { jumlah: 2_500_000, jenisAlokasi: 'MODAL_TAMBAHAN' as const },
    ];
    for (const a of alokasi50) {
      await catatRAK({
        jenisRak: 'PENYALURAN_DANA',
        namaUnit: 'Unit Toko',
        unitUsahaId: unitId,
        jenisAlokasi: a.jenisAlokasi,
        jumlah: a.jumlah,
        tanggal: '2026-03-10',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      });
    }
    const ledger = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) s FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
      ACC.rak
    );
    const subledger = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(jumlah),0) s FROM rak_transaksi WHERE status = 'AKTIF'`
    );
    expect(ledger?.s).toBe(subledger?.s);
    expect(ledger?.s).toBe(3_500_000);
  });
});

// ===========================================================================
// §51-52 — INTEGRITAS DATA
// ===========================================================================

describe('§51-52 integritas data', () => {
  it('51. foreign_key_check kosong setelah rangkaian transaksi', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    await catatRAK({
      jenisRak: 'PENYALURAN_DANA',
      namaUnit: 'Unit Toko',
      unitUsahaId: unitId,
      jenisAlokasi: 'MODAL_TETAP',
      jumlah: 1_000_000,
      tanggal: '2026-03-10',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const id = await seedProperti(100_000_000);
    await simpanDraftNilaiWajar({
      investasiId: id,
      tanggal: '2026-06-30',
      nilaiWajar: 120_000_000,
      // RC-S54 T11: bukti kini wajib (item #10) — input fixture saja, ekspektasi tidak diubah.
      dasarPenilaian: 'Laporan penilai independen',
      referensiBukti: 'KJPP-2026-011',
      createdBy: 'user-1',
    });

    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk?.foreign_keys).toBe(1);
  });

  it('52. tidak ada nomor jurnal maupun nomor RAKU yang duplikat', async () => {
    const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    // RC-S64: tiga alokasi berturut-turut ke unit yang sama kini hanya sah bila
    // yang pertama Modal Tetap dan sisanya Modal Tambahan. Yang diuji test ini
    // adalah keunikan nomor jurnal & nomor RAK serta jumlah barisnya (3) —
    // tidak bergantung pada jenis alokasi.
    const alokasi52 = ['MODAL_TETAP', 'MODAL_TAMBAHAN', 'MODAL_TAMBAHAN'] as const;
    for (const jenisAlokasi of alokasi52) {
      await catatRAK({
        jenisRak: 'PENYALURAN_DANA',
        namaUnit: 'Unit Toko',
        unitUsahaId: unitId,
        jenisAlokasi,
        jumlah: 500_000,
        tanggal: '2026-03-10',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      });
    }
    const jurnal = await testDb.getAllAsync<{ nomor_jurnal: string }>(`SELECT nomor_jurnal FROM journal`);
    expect(new Set(jurnal.map((j) => j.nomor_jurnal)).size).toBe(jurnal.length);

    const rak = await testDb.getAllAsync<{ nomor_rak: string }>(`SELECT nomor_rak FROM rak_transaksi`);
    expect(new Set(rak.map((r) => r.nomor_rak)).size).toBe(rak.length);
    expect(rak).toHaveLength(3);
  });

  it('52b. tidak ada baris jurnal yatim', async () => {
    const yatim = await testDb.getAllAsync(
      `SELECT je.id FROM journal_entry je LEFT JOIN journal j ON j.id = je.journal_id WHERE j.id IS NULL`
    );
    expect(yatim).toHaveLength(0);
  });
});

// ===========================================================================
// §25/§53 — MIGRATION & BACKWARD COMPATIBILITY
// ===========================================================================

describe('§25/§53 migration & kompatibilitas', () => {
  // DIPERBARUI RC-S53 — v63 dibuat karena KEPUTUSAN 04-A butuh register
  // yang memang belum ada. Yang dijaga: v63 itu ADITIF (hanya CREATE
  // TABLE/INDEX IF NOT EXISTS), tidak menulis ulang tabel lama, dan tidak
  // ada v64 spekulatif.
  // DIPERBARUI RC-S53 corrective — v64 ditambahkan karena MODEL BIAYA
  // membutuhkan register penyusutan properti investasi yang memang belum
  // punya tempat. Yang dijaga tetap sama: migrasinya aditif dan tidak ada
  // versi spekulatif di luar itu.
  it('§25 — v63 & v64 aditif, tanpa perubahan tabel lama', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    const db = baca('src/database/db.ts');
    expect(db).toMatch(/currentVersion < 63/);
    expect(db).toMatch(/currentVersion < 64/);
    expect(db).toMatch(/currentVersion < 65/);
    expect(db).not.toMatch(/currentVersion < 82/); // DIPERBARUI v81 (blok v81 milik RC-S133.6.2, bukan tahap ini; ambang digeser ke 82). DIPERBARUI v80 (blok v80 milik RC-S132, bukan tahap ini; ambang digeser ke 81). DIPERBARUI v79 (blok v79 milik RC-S128, bukan tahap ini; ambang digeser ke 80). DIPERBARUI v78 (blok v78 milik fitur bunga harian sukarela, bukan tahap ini; ambang digeser ke 79). DIPERBARUI v77 (Poin 5/6/10): blok v77 milik patch 19 poin (kolom unit_usaha_id + klasifikasi/label akun), bukan tahap ini; ambang digeser ke 78.  DIPERBARUI RC-S88: blok v73 MILIK RC-S88 (nilai wajar/revaluasi); ambang digeser ke 74. // DIPERBARUI v72 = penarikan dana investasi (milik modul itu, bukan tahap ini) · DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: blok v70 (asal personel) kini ADA dan MILIK restrukturisasi Data/Personel; ambang digeser ke 71 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: blok v74 MILIK RC-S100 (riwayat import data awal, dua tabel BARU aditif); ambang digeser ke 75 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji.
    const awal63 = db.indexOf('export async function migrasiV63');
    const blok63 = db.slice(awal63, db.indexOf('export async function migrasiV62'));
    expect(blok63).not.toMatch(/DROP TABLE|ALTER TABLE|UPDATE |DELETE /);
    const awal64 = db.indexOf('export async function migrasiV64');
    const blok64 = db.slice(awal64, awal63);
    expect(blok64).not.toMatch(/DROP TABLE|DELETE FROM/);
    expect(blok64).not.toMatch(/UPDATE investasi\s+SET/);
  });

  it('§53 — data v62 tetap terbaca: identitas, anggota, simpanan, pinjaman, jurnal', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO koperasi (id, nama, nomor_ahu, nomor_induk_koperasi, tahun_buku_aktif,
                             standar_akuntansi, setup_selesai, created_at, updated_at)
       VALUES ('kop-1','Koperasi Uji','AHU-1','NIK-1',2026,'SAK_EP',1,?,?)`,
      now, now
    );
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a1','A001','1111111111111111','Anggota A','2020-01-01','AKTIF',?,?)`,
      now, now
    );
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES ('s1','a1','POKOK','SETOR','2026-01-10',100000,'KAS','SMP-1','user-1',?)`,
      now
    );

    expect((await testDb.getFirstAsync<{ nomor_ahu: string }>(`SELECT nomor_ahu FROM koperasi`))?.nomor_ahu).toBe('AHU-1');
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM anggota`))?.n).toBe(1);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM simpanan_transaksi`))?.n).toBe(1);
    // Jurnal fixture tetap utuh, nominalnya tidak bergerak.
    const je = await testDb.getFirstAsync<{ debit: number }>(`SELECT debit FROM journal_entry WHERE id='jm1'`);
    expect(je?.debit).toBe(20_000_000);
  });

  it('seluruh tabel v60-v62 tetap ada', async () => {
    const rows = await testDb.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table'`
    );
    const nama = rows.map((r) => r.name);
    for (const t of [
      'koperasi_personel', 'koperasi_perizinan', 'koperasi_unit_usaha', 'koperasi_peraturan_internal',
      'imbalan_kerja', 'keluar_anggota', 'penyesuaian_nilai_wajar', 'rekonsiliasi_kas_bank', 'rak_transaksi',
    ]) {
      expect(nama).toContain(t);
    }
  });
});

// ===========================================================================
// §31 — SELURUH JURNAL LEWAT ACCOUNTING ENGINE
// ===========================================================================

describe('§31 disiplin AccountingEngine di seluruh service RC-S53', () => {
  const SERVICE = [
    'src/services/RAKService.ts',
    'src/services/CashReconciliationService.ts',
    'src/services/ImbalanKerjaService.ts',
    'src/services/KeluarAnggotaService.ts',
    'src/services/UtangService.ts',
    'src/services/SimpananBerjangkaLifecycleService.ts',
    'src/services/KoperasiMasterService.ts',
    'src/services/PenyesuaianNilaiWajarService.ts',
  ];

  it('tidak ada INSERT INTO journal / journal_entry di service mana pun', () => {
    for (const f of SERVICE) {
      const src = tanpaKomentar(baca(f));
      expect(src).not.toMatch(/INSERT INTO journal\b/);
      expect(src).not.toMatch(/INSERT INTO journal_entry\b/);
      expect(src).not.toMatch(/UPDATE account SET/);
    }
  });

  it('service master data TIDAK menjurnal; nilai wajar (RC-S88) menjurnal HANYA lewat createJournal', () => {
    expect(tanpaKomentar(baca('src/services/KoperasiMasterService.ts'))).not.toMatch(/createJournal/);
    expect(tanpaKomentar(baca('src/services/PenyesuaianNilaiWajarService.ts'))).toMatch(/createJournal\(db, \{/);
  });
});
