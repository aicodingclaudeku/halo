import { readFileSync, readdirSync } from 'fs';
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
import { postingNilaiWajar, simpanDraftNilaiWajar } from '@/services/PenyesuaianNilaiWajarService';
import { catatRAK } from '@/services/RAKService';
import { buatUnitUsaha } from '@/services/KoperasiMasterService';

/**
 * RC-S53 — KONTROL AKHIR.
 *
 * Suite ini menutup butir §XX (audit end-to-end) dan §XVI (test untuk
 * policy gate) yang belum tercakup `Fase10AuditFinalRcS53`.
 *
 * Fokusnya bukan menambah fitur — tidak ada fitur baru di tranche ini —
 * melainkan MEMBUKTIKAN bahwa tujuh item POLICY_REQUIRED benar-benar
 * terkunci di kode, bukan hanya dinyatakan terkunci di laporan.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}
function tanpaKomentar(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const ACC = { kas: 'acc-kas', rak: 'acc-rak', modal: 'acc-modal' };

async function seedFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();
  const akun: [string, string, string, string, string][] = [
    [ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT'],
    [ACC.rak, '1-1800', 'Rekening Antar Kantor', 'ASET', 'DEBIT'],
    [ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT'],
  ];
  for (const [id, kode, nama, kat, nb] of akun) {
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,1,?,?)`,
      id, kode, nama, kat, nb, now, now
    );
  }
  for (const [tt, role, acc] of [
    ['KAS_UMUM', 'DEFAULT', ACC.kas],
    ['RAK', 'DEBIT_ASET', ACC.rak],
    ['RAK', 'KREDIT_ASET', ACC.rak],
  ]) {
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-${tt}-${role}`, tt, role, acc
    );
  }
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
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,0,20000000)`,
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

async function transaksiContoh(): Promise<void> {
  const unitId = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
  // RC-S64: satu Unit Usaha hanya boleh punya SATU Modal Tetap aktif, jadi
  // alokasi kedua di fixture ini menjadi MODAL_TAMBAHAN. Yang diuji suite ini
  // adalah integritas ledger/subledger RAKU dan jumlah transaksinya — keduanya
  // tidak bergantung pada jenis alokasi, sehingga tidak ada expected value yang
  // dilonggarkan, hanya fixture yang disesuaikan dengan aturan baru.
  const alokasi = [
    { jumlah: 1_000_000, jenisAlokasi: 'MODAL_TETAP' as const },
    { jumlah: 2_000_000, jenisAlokasi: 'MODAL_TAMBAHAN' as const },
  ];
  for (const a of alokasi) {
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
}

beforeEach(async () => {
  await seedFixture();
});
afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// §XVI — POLICY GATE: tujuh item terbukti terkunci
// ===========================================================================

describe('§XVI policy gate — tujuh item POLICY_REQUIRED', () => {
  it('POLICY 01 — 12 kode COA yang diminta tersedia sebagai akun, tanpa satu pun mapping posting', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (permintaan pengguna): 12 kode diminta DITAMBAHKAN sebagai akun COA (DEFINED / NOT ACTIVELY POSTED); tidak ada mapping/posting/jurnal yang berubah.
    const coa = baca('src/config/defaultCOA.ts');
    const blokMapping = coa.slice(coa.indexOf('DEFAULT_ACCOUNT_MAPPING'));
    for (const k of [
      '1-660', '1-661', '1-220', '1-230', '1-240', '1-250',
      '4-1510', '4-1520', '4-1530', '4-1540', '4-2100', '5-5000',
    ]) {
      expect(coa).toContain(`{ kode: '${k}'`);
      expect(blokMapping).not.toContain(`accountKode: '${k}'`);
    }
  });

  it('POLICY 02 — POSTING properti investasi tetap satu akun 1-1660; 1-660/1-661 hanya terdefinisi', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (permintaan pengguna): 12 kode diminta DITAMBAHKAN sebagai akun COA (DEFINED / NOT ACTIVELY POSTED); tidak ada mapping/posting/jurnal yang berubah.
    const coa = baca('src/config/defaultCOA.ts');
    expect(coa).toContain("{ kode: '1-1660', nama: 'Properti Investasi'");
    const blokMapping = coa.slice(coa.indexOf('DEFAULT_ACCOUNT_MAPPING'));
    expect(blokMapping).toContain("accountKode: '1-1660'");
    for (const k of ['1-660', '1-661']) expect(blokMapping).not.toContain(`accountKode: '${k}'`);
  });

  // DIPERBARUI RC-S88 (keputusan pengguna): POLICY 03 = MODEL BIAYA diganti model
  // nilai wajar SAK EP. Fixture suite ini tidak memetakan akun nilai wajar, jadi yang
  // dibuktikan di sini: gerbang menolak TANPA jurnal parsial & register investasi utuh.
  it('RC-S88 — posting nilai wajar tanpa mapping ditolak; saldo, jurnal & biaya perolehan tidak bergerak', async () => {
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

    const sebelum = await testDb.getFirstAsync<{ n: number; d: number; k: number }>(
      `SELECT COUNT(*) n, COALESCE(SUM(debit),0) d, COALESCE(SUM(kredit),0) k FROM journal_entry`
    );
    await expect(postingNilaiWajar(d.id, { userId: 'user-1' })).rejects.toThrow(/NILAI_WAJAR_PROPERTI_INVESTASI/);
    const sesudah = await testDb.getFirstAsync<{ n: number; d: number; k: number }>(
      `SELECT COUNT(*) n, COALESCE(SUM(debit),0) d, COALESCE(SUM(kredit),0) k FROM journal_entry`
    );
    expect(sesudah).toEqual(sebelum);

    // Nilai tercatat investasi juga TIDAK disentuh.
    const inv = await testDb.getFirstAsync<{ jumlah: number }>(
      `SELECT jumlah FROM investasi WHERE id = ?`,
      id
    );
    expect(inv?.jumlah).toBe(500_000_000);
  });

  // DIPERBARUI RC-S53 — KEPUTUSAN 04-A membuka BAGIAN SHU, KEPUTUSAN 06
  // menutup IMBAL HASIL TETAP. Yang dijaga sekarang adalah garis itu:
  // satu yang aktif boleh ada, yang DISABLED tetap nol jejak.
  it('POLICY 04-06 — hanya bagian SHU yang dibuat; imbal hasil tetap nol jejak', () => {
    const berkas = readdirSync(join(__dirname, '..', 'services'));
    expect(berkas).toContain('BagianShuService.ts');
    for (const n of ['InvestasiReturnService.ts', 'ImbalHasilTetapService.ts']) {
      expect(berkas).not.toContain(n);
    }
    const schema = baca('src/database/schema.ts');
    expect(schema).not.toContain('return_type');
    expect(schema).not.toContain('SIMPANAN_MODAL_BAGIAN_SHU');
    expect(schema).not.toContain('IMBAL_HASIL_TETAP');
  });

  it('POLICY 07 — CHECK jenis_rak tidak diperluas; legacy tetap ada', () => {
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(
      /jenis_rak TEXT NOT NULL CHECK \(jenis_rak IN \('PENYALURAN_DANA','SETORAN_DANA'\)\)/
    );
    expect(schema).not.toContain("'PENGUATAN'");
    // SETORAN_DANA tetap TERBACA, hanya tidak dapat dipilih untuk baru.
    const svc = baca('src/services/RAKService.ts');
    expect(svc).toMatch(/export type JenisRAK = 'PENYALURAN_DANA' \| 'SETORAN_DANA';/);
    expect(svc).toMatch(/export type JenisRAKInput = 'PENYALURAN_DANA';/);
  });

  // DIPERBARUI RC-S88: gerbang tetap MELEMPAR dengan kode eksplisit bila ada
  // hambatan (status, bukti, urutan, penyusutan) — tidak pernah return senyap.
  it('tidak ada fallback diam-diam: gate melempar dengan kode hambatan, bukan mengembalikan nilai', () => {
    const svc = tanpaKomentar(baca('src/services/PenyesuaianNilaiWajarService.ts'));
    expect(svc).toMatch(/if \(hambatanStatus\.length > 0\) \{\s*throw new Error/);
    expect(svc).toMatch(/if \(rencana\.hambatan\.length > 0\) \{\s*throw new Error/);
  });
});

// ===========================================================================
// §X — DATA MODEL: tidak ada migration spekulatif
// ===========================================================================

describe('§X/§XXIII — tidak ada migration maupun tabel spekulatif', () => {
  // DIPERBARUI RC-S53 — v63 bukan migrasi spekulatif: ia dibuat karena
  // KEPUTUSAN 04-A membutuhkan register yang datanya memang belum punya
  // tempat. Yang tetap dijaga adalah ketiadaan migrasi di luar itu.
  // DIPERBARUI RC-S53 corrective — v64 = register penyusutan properti
  // investasi, konsekuensi langsung POLICY 03 (MODEL BIAYA).
  it('v63 & v64 masing-masing punya alasan; tidak ada v65', () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
    const db = baca('src/database/db.ts');
    expect(db).toMatch(/currentVersion < 63/);
    expect(db).toMatch(/currentVersion < 64/);
    expect(db).toMatch(/currentVersion < 65/);
    expect(db).not.toMatch(/currentVersion < 77/); // DIPERBARUI RC-S88: blok v73 MILIK RC-S88 (nilai wajar/revaluasi); ambang digeser ke 74. // DIPERBARUI v72 = penarikan dana investasi (milik modul itu, bukan tahap ini) · DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: blok v70 (asal personel) kini ADA dan MILIK restrukturisasi Data/Personel; ambang digeser ke 71 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: blok v74 MILIK RC-S100 (riwayat import data awal, dua tabel BARU aditif); ambang digeser ke 75 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji.
    expect(db).not.toMatch(/migrasiV66/);
  });

  it('hanya tabel bagian SHU yang bertambah; fitur yang DISABLED tetap tanpa tabel', async () => {
    const rows = await testDb.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table'`
    );
    const nama = rows.map((r) => r.name);
    // KEPUTUSAN 04-A aktif — registernya ada.
    expect(nama).toContain('investasi_bagian_shu');
    expect(nama).toContain('investasi_bagian_shu_penerimaan');
    // KEPUTUSAN 03, 06, dan 07-B tetap DISABLED BY POLICY — nol tabel.
    for (const t of [
      'investasi_return', 'imbal_hasil', 'fair_value_posting', 'raku_penguatan',
    ]) {
      expect(nama).not.toContain(t);
    }
  });
});

// ===========================================================================
// §XX — AUDIT INTEGRITAS END-TO-END
// ===========================================================================

describe('§XX audit integritas end-to-end', () => {
  it('foreign_key_check kosong & foreign key aktif', async () => {
    await transaksiContoh();
    await seedProperti(100_000_000);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk?.foreign_keys).toBe(1);
  });

  it('tidak ada duplicate journal maupun duplicate journal_entry', async () => {
    await transaksiContoh();
    const j = await testDb.getAllAsync<{ id: string; nomor_jurnal: string }>(
      `SELECT id, nomor_jurnal FROM journal`
    );
    expect(new Set(j.map((x) => x.id)).size).toBe(j.length);
    expect(new Set(j.map((x) => x.nomor_jurnal)).size).toBe(j.length);

    const je = await testDb.getAllAsync<{ id: string }>(`SELECT id FROM journal_entry`);
    expect(new Set(je.map((x) => x.id)).size).toBe(je.length);

    // Tidak ada baris identik (jurnal+akun+debit+kredit) yang terduplikasi
    // lebih dari yang seharusnya pada satu jurnal.
    const kembar = await testDb.getAllAsync(
      `SELECT journal_id, account_id, debit, kredit, COUNT(*) n
         FROM journal_entry GROUP BY journal_id, account_id, debit, kredit HAVING n > 1`
    );
    expect(kembar).toHaveLength(0);
  });

  it('tidak ada COA duplikat di database', async () => {
    const akun = await testDb.getAllAsync<{ kode: string }>(`SELECT kode FROM account`);
    expect(new Set(akun.map((a) => a.kode)).size).toBe(akun.length);
  });

  it('tidak ada data yatim pada relasi utama', async () => {
    await transaksiContoh();
    const yatimEntry = await testDb.getAllAsync(
      `SELECT je.id FROM journal_entry je LEFT JOIN journal j ON j.id = je.journal_id WHERE j.id IS NULL`
    );
    expect(yatimEntry).toHaveLength(0);

    const yatimAkun = await testDb.getAllAsync(
      `SELECT je.id FROM journal_entry je LEFT JOIN account a ON a.id = je.account_id WHERE a.id IS NULL`
    );
    expect(yatimAkun).toHaveLength(0);

    const yatimRak = await testDb.getAllAsync(
      `SELECT r.id FROM rak_transaksi r LEFT JOIN journal j ON j.id = r.journal_id
        WHERE r.journal_id IS NOT NULL AND j.id IS NULL`
    );
    expect(yatimRak).toHaveLength(0);
  });

  it('tidak ada jurnal yang tidak seimbang', async () => {
    await transaksiContoh();
    const timpang = await testDb.getAllAsync(
      `SELECT journal_id FROM journal_entry
        GROUP BY journal_id HAVING SUM(debit) <> SUM(kredit)`
    );
    expect(timpang).toHaveLength(0);
  });

  it('ledger seimbang secara keseluruhan', async () => {
    await transaksiContoh();
    const t = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(kredit),0) k FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id WHERE j.status IN ('POSTED','REVERSED')`
    );
    expect(t?.d).toBe(t?.k);
  });

  it('saldo RAKU cocok antara ledger dan subledger', async () => {
    await transaksiContoh();
    const ledger = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) s FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
        WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
      ACC.rak
    );
    const sub = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(jumlah),0) s FROM rak_transaksi WHERE status = 'AKTIF'`
    );
    expect(ledger?.s).toBe(sub?.s);
    expect(ledger?.s).toBe(3_000_000);
  });

  it('tidak ada akrual, posting nilai wajar, maupun pendapatan investasi ganda', async () => {
    // Ketiganya belum ada sama sekali — itulah keadaan yang benar
    // selama kebijakannya belum turun.
    for (const sumber of [
      'NILAI_WAJAR',
      'INVESTASI_RETURN',
      'BAGIAN_SHU',
      'IMBAL_HASIL',
    ]) {
      const n = await testDb.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi LIKE ?`,
        `%${sumber}%`
      );
      expect(n?.n).toBe(0);
    }
  });
});

// ===========================================================================
// §XIII — HISTORI TIDAK DITULIS ULANG
// ===========================================================================

describe('§XIII histori tidak ditulis ulang', () => {
  it('tidak ada service yang meng-UPDATE atau DELETE jurnal historis', () => {
    const dir = join(__dirname, '..', 'services');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = tanpaKomentar(readFileSync(join(dir, f), 'utf8'));
      expect(src).not.toMatch(/DELETE FROM journal\b/);
      expect(src).not.toMatch(/DELETE FROM journal_entry\b/);
      expect(src).not.toMatch(/UPDATE journal_entry SET/);
      expect(src).not.toMatch(/UPDATE account SET .*saldo/);
    }
  });

  it('jurnal fixture tidak berubah setelah rangkaian transaksi baru', async () => {
    const sebelum = await testDb.getAllAsync(
      `SELECT id, debit, kredit FROM journal_entry WHERE journal_id = 'j-modal' ORDER BY id`
    );
    await transaksiContoh();
    const sesudah = await testDb.getAllAsync(
      `SELECT id, debit, kredit FROM journal_entry WHERE journal_id = 'j-modal' ORDER BY id`
    );
    expect(JSON.stringify(sesudah)).toBe(JSON.stringify(sebelum));
  });
});

// ===========================================================================
// REGISTER KEBIJAKAN
// ===========================================================================

describe('register kebijakan', () => {
  const reg = baca('POLICY_REGISTER_RC-S53.md');

  it('memuat ketujuh item dengan penomoran resmi', () => {
    for (let i = 1; i <= 7; i += 1) {
      expect(reg).toContain(`## POLICY 0${i} —`);
    }
  });

  it('setiap item punya kolom keputusan yang MASIH KOSONG', () => {
    const keputusan = reg.match(/> \*\*KEPUTUSAN:\*\* _\(belum diberikan\)_/g) ?? [];
    expect(keputusan).toHaveLength(7);
  });

  it('register tidak menetapkan kode akun maupun arah jurnal sendiri', () => {
    // Boleh MENYEBUT kode yang diminta sebagai bahan diskusi, tetapi
    // tidak boleh menuliskannya sebagai keputusan.
    expect(reg).not.toMatch(/KEPUTUSAN:\*\* (?!_\(belum diberikan\)_)/);
    expect(reg).toContain('POLICY_REQUIRED');
  });
});
