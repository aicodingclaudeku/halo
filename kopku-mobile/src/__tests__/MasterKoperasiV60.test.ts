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
import { migrasiV60 } from '../database/db';
import {
  buatPersonel,
  getPersonel,
  listPersonel,
  perbaruiPersonel,
  setStatusPersonel,
  buatPerizinan,
  getPerizinan,
  listPerizinan,
  perbaruiPerizinan,
  buatUnitUsaha,
  getUnitUsaha,
  listUnitUsaha,
  perbaruiUnitUsaha,
  setStatusUnitUsaha,
  buatPeraturan,
  getPeraturan,
  listPeraturan,
  perbaruiPeraturan,
  JENIS_PERSONEL,
} from '@/services/KoperasiMasterService';
import {
  getIdentitasKoperasi,
  updateIdentitasKoperasi,
} from '@/services/SetupService';

/**
 * FASE 7 — MIGRASI v60 & MASTER DATA IDENTITAS KOPERASI.
 *
 * Seluruh suite berjalan di atas SQLite sungguhan (`node:sqlite`)
 * dengan skema produksi.
 *
 * Bagian migrasi TIDAK memeriksa source: ia MEMBANGUN database yang
 * berbentuk v59 (tabel v60 dijatuhkan, kolom v60 dilepas), lalu
 * menjalankan `migrasiV60()` YANG SAMA dengan yang dipanggil runner
 * produksi, lalu memeriksa hasilnya. Itulah satu-satunya cara membuktikan
 * upgrade benar-benar bekerja, bukan sekadar terlihat benar.
 */

const HELPER_TAMBAH_KOLOM = async (tabel: string, kolom: string, tipe: string) => {
  try {
    await testDb.execAsync(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${tipe};`);
  } catch {
    // Kolom sudah ada — sama persis dengan helper di runner produksi.
  }
};

/** Bangun database yang bentuknya PERSIS RC-S53 (v59). */
async function buatDbV59(): Promise<void> {
  testDb = await createTestDb();
  for (const t of [
    'koperasi_personel',
    'koperasi_perizinan',
    'koperasi_unit_usaha',
    'koperasi_peraturan_internal',
  ]) {
    await testDb.execAsync(`DROP TABLE IF EXISTS ${t}`);
  }
  await testDb.execAsync(`ALTER TABLE koperasi DROP COLUMN nomor_ahu`);
  await testDb.execAsync(`ALTER TABLE koperasi DROP COLUMN nomor_induk_koperasi`);
  await testDb.runAsync(`UPDATE schema_meta SET version = 59`).catch(async () => {
    await testDb.execAsync(
      `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`
    );
    await testDb.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 59)`);
  });
}

async function seedKoperasiLama(nomorBadanHukum: string | null): Promise<void> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO koperasi (id, nama, nomor_badan_hukum, npwp, alamat, tahun_buku_aktif,
                           standar_akuntansi, setup_selesai, created_at, updated_at)
     VALUES ('kop-1','Koperasi Lama',?,'01.234.567.8-901.000','Jl. Lama No. 1',2026,'SAK_EP',1,?,?)`,
    nomorBadanHukum,
    now,
    now
  );
}

async function adaTabel(nama: string): Promise<boolean> {
  const r = await testDb.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?`,
    nama
  );
  return (r?.n ?? 0) === 1;
}

async function adaKolom(tabel: string, kolom: string): Promise<boolean> {
  const rows = await testDb.getAllAsync<{ name: string }>(
    `SELECT name FROM pragma_table_info(?)`,
    tabel
  );
  return rows.some((r) => r.name === kolom);
}

// ===========================================================================
// MIGRASI
// ===========================================================================

describe('Fase 7 — MIGRASI v60 dari database RC-S53', () => {
  afterEach(() => {
    // Sebagian test di blok ini murni konstanta dan tidak membuka
    // database; menutup koneksi yang tidak pernah dibuka akan gagal.
    testDb?.closeSync();
  });

  it('SCHEMA_VERSION sudah melewati v60 (migrasi master data terpasang)', () => {
    // Bentuk semula memaku angkanya pada 60, sehingga migrasi SAH
    // berikutnya (v61 Imbalan Kerja & Keluar Anggota) memutus test ini
    // padahal Fase 7 tetap utuh. Yang dijaga assertion ini sebenarnya
    // adalah "v60 sudah ada", bukan "tidak boleh ada versi setelahnya".
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(60);
  });

  it('database v59 memang belum punya tabel & kolom v60', async () => {
    await buatDbV59();
    expect(await adaTabel('koperasi_personel')).toBe(false);
    expect(await adaKolom('koperasi', 'nomor_ahu')).toBe(false);
    expect(await adaKolom('koperasi', 'nomor_induk_koperasi')).toBe(false);
  });

  it('§22 — nomor_badan_hukum BH-OLD-001 termigrasi ke nomor_ahu', async () => {
    await buatDbV59();
    await seedKoperasiLama('BH-OLD-001');

    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);

    const row = await testDb.getFirstAsync<{ nomor_ahu: string; nomor_badan_hukum: string }>(
      `SELECT nomor_ahu, nomor_badan_hukum FROM koperasi WHERE id = 'kop-1'`
    );
    expect(row?.nomor_ahu).toBe('BH-OLD-001');
    // Kolom warisan TIDAK dikosongkan — kode lama masih membacanya.
    expect(row?.nomor_badan_hukum).toBe('BH-OLD-001');
  });

  it('keempat tabel master dan indeksnya terbentuk', async () => {
    await buatDbV59();
    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);

    for (const t of [
      'koperasi_personel',
      'koperasi_perizinan',
      'koperasi_unit_usaha',
      'koperasi_peraturan_internal',
    ]) {
      expect(await adaTabel(t)).toBe(true);
    }
    const idx = await testDb.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`
    );
    const nama = idx.map((i) => i.name);
    expect(nama).toContain('idx_personel_jenis');
    expect(nama).toContain('idx_unit_usaha_status');
  });

  it('IDEMPOTEN — dijalankan dua kali tidak gagal dan tidak menduplikasi', async () => {
    await buatDbV59();
    await seedKoperasiLama('BH-OLD-001');

    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);
    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);

    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM koperasi`);
    expect(n?.n).toBe(1);
    const row = await testDb.getFirstAsync<{ nomor_ahu: string }>(
      `SELECT nomor_ahu FROM koperasi WHERE id = 'kop-1'`
    );
    expect(row?.nomor_ahu).toBe('BH-OLD-001');
  });

  it('backfill TIDAK menimpa AHU yang sudah diisi pengguna', async () => {
    await buatDbV59();
    await seedKoperasiLama('BH-OLD-001');
    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);

    await testDb.runAsync(`UPDATE koperasi SET nomor_ahu = 'AHU-BARU-999' WHERE id='kop-1'`);
    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);

    const row = await testDb.getFirstAsync<{ nomor_ahu: string }>(
      `SELECT nomor_ahu FROM koperasi WHERE id='kop-1'`
    );
    expect(row?.nomor_ahu).toBe('AHU-BARU-999');
  });

  it('nomor_badan_hukum kosong/NULL tidak menghasilkan AHU string kosong', async () => {
    await buatDbV59();
    await seedKoperasiLama(null);
    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);
    const row = await testDb.getFirstAsync<{ nomor_ahu: string | null }>(
      `SELECT nomor_ahu FROM koperasi WHERE id='kop-1'`
    );
    expect(row?.nomor_ahu).toBeNull();

    await testDb.runAsync(`UPDATE koperasi SET nomor_badan_hukum = '   ' WHERE id='kop-1'`);
    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);
    const row2 = await testDb.getFirstAsync<{ nomor_ahu: string | null }>(
      `SELECT nomor_ahu FROM koperasi WHERE id='kop-1'`
    );
    expect(row2?.nomor_ahu).toBeNull();
  });

  it('§23/§35 — data lama tetap terbaca setelah upgrade', async () => {
    await buatDbV59();
    await seedKoperasiLama('BH-OLD-001');
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a1','A001','1111111111111111','Anggota Lama','2020-01-01','AKTIF',?,?)`,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
    );
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-kas','1-1000','Kas','ASET','DEBIT',1,1,?,?)`,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
       VALUES ('j1','JRN-1','2026-01-05','p2026','MODAL_AWAL','Saldo awal','POSTED','user-1',?,?)`,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je1','j1','acc-kas',1000000,0)`
    );

    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);

    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM anggota`))?.n).toBe(1);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`))?.n).toBe(1);
    const je = await testDb.getFirstAsync<{ debit: number }>(
      `SELECT debit FROM journal_entry WHERE id='je1'`
    );
    // §37 — tidak ada angka akuntansi yang bergerak karena migrasi ini.
    expect(je?.debit).toBe(1_000_000);
  });

  it('§24 — foreign key tetap aktif setelah migrasi', async () => {
    await buatDbV59();
    await migrasiV60(testDb as never, HELPER_TAMBAH_KOLOM);
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk?.foreign_keys).toBe(1);
    const cek = await testDb.getAllAsync(`PRAGMA foreign_key_check`);
    expect(cek).toHaveLength(0);
  });
});

// ===========================================================================
// AHU / NIK lewat service
// ===========================================================================

describe('Fase 7 — AHU & NIK', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedKoperasiLama('BH-OLD-001');
    await testDb.runAsync(`UPDATE koperasi SET nomor_ahu = 'BH-OLD-001' WHERE id='kop-1'`);
  });
  afterEach(() => testDb.closeSync());

  it('identitas membaca AHU dan NIK', async () => {
    const id = await getIdentitasKoperasi();
    expect(id?.nomorAhu).toBe('BH-OLD-001');
    expect(id?.nomorIndukKoperasi).toBeNull();
  });

  it('menyimpan AHU menulis KEDUA kolom — mustahil divergen', async () => {
    await updateIdentitasKoperasi({
      nama: 'Koperasi Lama',
      nomorAhu: 'AHU-2026-0001',
      nomorIndukKoperasi: 'NIK-KOP-123',
    } as never);

    const row = await testDb.getFirstAsync<{
      nomor_ahu: string;
      nomor_badan_hukum: string;
      nomor_induk_koperasi: string;
    }>(`SELECT nomor_ahu, nomor_badan_hukum, nomor_induk_koperasi FROM koperasi WHERE id='kop-1'`);

    expect(row?.nomor_ahu).toBe('AHU-2026-0001');
    expect(row?.nomor_badan_hukum).toBe('AHU-2026-0001');
    expect(row?.nomor_induk_koperasi).toBe('NIK-KOP-123');
  });

  it('alias lama nomorBadanHukum tetap diterima', async () => {
    await updateIdentitasKoperasi({
      nama: 'Koperasi Lama',
      nomorBadanHukum: 'AHU-LEGACY-7',
    } as never);
    const id = await getIdentitasKoperasi();
    expect(id?.nomorAhu).toBe('AHU-LEGACY-7');
    expect(id?.nomorBadanHukum).toBe('AHU-LEGACY-7');
  });

  it('NIK di-trim; string kosong menjadi NULL', async () => {
    await updateIdentitasKoperasi({
      nama: 'Koperasi Lama',
      nomorIndukKoperasi: '  NIK-9  ',
    } as never);
    expect((await getIdentitasKoperasi())?.nomorIndukKoperasi).toBe('NIK-9');

    await updateIdentitasKoperasi({ nama: 'Koperasi Lama', nomorIndukKoperasi: '   ' } as never);
    expect((await getIdentitasKoperasi())?.nomorIndukKoperasi).toBeNull();
  });
});

// ===========================================================================
// CRUD MASTER
// ===========================================================================

describe('Fase 7 — CRUD personel', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });
  afterEach(() => testDb.closeSync());

  it('1-3. create, read, update', async () => {
    const id = await buatPersonel({
      nama: 'Siti',
      jenisPersonel: 'PENGURUS',
      jabatan: 'Bendahara',
      jenisKelamin: 'P',
      tanggalMulaiJabatan: '2026-01-01',
      nik: '3201010101010001',
    });
    const p = await getPersonel(id);
    expect(p?.nama).toBe('Siti');
    expect(p?.jenisPersonel).toBe('PENGURUS');
    expect(p?.statusAktif).toBe(true);

    await perbaruiPersonel(id, { nama: 'Siti Aminah', jenisPersonel: 'PENGURUS', jabatan: 'Ketua' });
    const p2 = await getPersonel(id);
    expect(p2?.nama).toBe('Siti Aminah');
    expect(p2?.jabatan).toBe('Ketua');
    // 8. ID STABIL walau nama berubah.
    expect(p2?.id).toBe(id);
  });

  it('4. deactivate — baris TIDAK dihapus', async () => {
    const id = await buatPersonel({ nama: 'Budi', jenisPersonel: 'KARYAWAN' });
    await setStatusPersonel(id, false);
    const p = await getPersonel(id);
    expect(p).not.toBeNull();
    expect(p?.statusAktif).toBe(false);
    expect((await listPersonel({ hanyaAktif: true })).map((x) => x.id)).not.toContain(id);
  });

  it('5. list per jenis', async () => {
    await buatPersonel({ nama: 'A', jenisPersonel: 'PENGURUS' });
    await buatPersonel({ nama: 'B', jenisPersonel: 'PENGAWAS' });
    await buatPersonel({ nama: 'C', jenisPersonel: 'PENGAWAS' });
    expect(await listPersonel({ jenisPersonel: 'PENGAWAS' })).toHaveLength(2);
    expect(await listPersonel({ jenisPersonel: 'PENGURUS' })).toHaveLength(1);
    expect(await listPersonel()).toHaveLength(3);
  });

  it('kelima jenis personel diterima database', async () => {
    for (const j of JENIS_PERSONEL) {
      await buatPersonel({ nama: `Orang ${j}`, jenisPersonel: j });
    }
    expect(await listPersonel()).toHaveLength(JENIS_PERSONEL.length);
  });

  it('6. tanggal berakhir mendahului tanggal mulai DITOLAK', async () => {
    await expect(
      buatPersonel({
        nama: 'X',
        jenisPersonel: 'PENGURUS',
        tanggalMulaiJabatan: '2026-06-01',
        tanggalBerakhirJabatan: '2026-01-01',
      })
    ).rejects.toThrow(/tidak boleh mendahului/);
  });

  it('tanggal berakhir NULL sah — jabatan masih berjalan', async () => {
    const id = await buatPersonel({
      nama: 'Y',
      jenisPersonel: 'PENGURUS',
      tanggalMulaiJabatan: '2026-01-01',
    });
    expect((await getPersonel(id))?.tanggalBerakhirJabatan).toBeNull();
  });

  it('7. nama kosong & jenis tidak dikenali DITOLAK; tidak ada baris tersimpan', async () => {
    await expect(buatPersonel({ nama: '   ', jenisPersonel: 'PENGURUS' })).rejects.toThrow(
      /wajib diisi/
    );
    await expect(
      buatPersonel({ nama: 'Z', jenisPersonel: 'DIREKTUR' as never })
    ).rejects.toThrow(/tidak dikenali/);
    expect(await listPersonel()).toHaveLength(0);
  });

  it('NIK personel TIDAK bercampur dengan NIK koperasi', async () => {
    await seedKoperasiLama('BH-1');
    await testDb.runAsync(`UPDATE koperasi SET nomor_induk_koperasi = 'NIK-KOP-1' WHERE id='kop-1'`);
    const id = await buatPersonel({
      nama: 'Rina',
      jenisPersonel: 'PENGELOLA',
      nik: '3201010101010002',
    });
    expect((await getPersonel(id))?.nik).toBe('3201010101010002');
    const kop = await testDb.getFirstAsync<{ nomor_induk_koperasi: string }>(
      `SELECT nomor_induk_koperasi FROM koperasi WHERE id='kop-1'`
    );
    expect(kop?.nomor_induk_koperasi).toBe('NIK-KOP-1');
  });

  it('20. update pada id yang tidak ada DITOLAK, bukan membuat baris baru', async () => {
    await expect(
      perbaruiPersonel('tidak-ada', { nama: 'Q', jenisPersonel: 'PEKERJA' })
    ).rejects.toThrow(/tidak ditemukan/);
    expect(await listPersonel()).toHaveLength(0);
  });
});

describe('Fase 7 — CRUD perizinan', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });
  afterEach(() => testDb.closeSync());

  it('create, read, update, ubah status', async () => {
    const id = await buatPerizinan({
      namaIzin: 'Izin Usaha Simpan Pinjam',
      nomorIzin: 'IUSP-001',
      tanggalTerbit: '2024-01-10',
      berlakuSampai: '2029-01-10',
      instansiPenerbit: 'Kementerian Koperasi',
    });
    const p = await getPerizinan(id);
    expect(p?.namaIzin).toBe('Izin Usaha Simpan Pinjam');
    expect(p?.status).toBe('AKTIF');
    expect(p?.berlakuSampai).toBe('2029-01-10');

    await perbaruiPerizinan(id, { namaIzin: 'IUSP', status: 'KEDALUWARSA' });
    expect((await getPerizinan(id))?.status).toBe('KEDALUWARSA');
    expect(await listPerizinan()).toHaveLength(1);
  });

  it('masa berlaku mendahului tanggal terbit DITOLAK', async () => {
    await expect(
      buatPerizinan({ namaIzin: 'X', tanggalTerbit: '2026-05-01', berlakuSampai: '2026-01-01' })
    ).rejects.toThrow(/tidak boleh mendahului/);
  });

  it('nama izin kosong DITOLAK', async () => {
    await expect(buatPerizinan({ namaIzin: '' })).rejects.toThrow(/wajib diisi/);
    expect(await listPerizinan()).toHaveLength(0);
  });

  it('8. bertahan setelah "restart" — dibaca ulang dari database', async () => {
    const id = await buatPerizinan({ namaIzin: 'Izin A', berlakuSampai: '2030-01-01' });
    const lagi = await getPerizinan(id);
    expect(lagi?.namaIzin).toBe('Izin A');
    expect(lagi?.id).toBe(id);
  });
});

describe('Fase 7 — CRUD unit usaha', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });
  afterEach(() => testDb.closeSync());

  it('create, read, update, deactivate', async () => {
    const id = await buatUnitUsaha({ namaUsaha: 'Unit Toko', jenisUsaha: 'Ritel', alamat: 'Jl. A' });
    expect((await getUnitUsaha(id))?.namaUsaha).toBe('Unit Toko');
    expect((await getUnitUsaha(id))?.status).toBe('AKTIF');

    await perbaruiUnitUsaha(id, { namaUsaha: 'Unit Toko Sejahtera', jenisUsaha: 'Ritel' });
    expect((await getUnitUsaha(id))?.namaUsaha).toBe('Unit Toko Sejahtera');

    await setStatusUnitUsaha(id, 'NONAKTIF');
    // §10 — baris TETAP ADA supaya transaksi yang menunjuknya tidak yatim.
    expect(await getUnitUsaha(id)).not.toBeNull();
    expect((await getUnitUsaha(id))?.status).toBe('NONAKTIF');
    expect(await listUnitUsaha(true)).toHaveLength(0);
    expect(await listUnitUsaha()).toHaveLength(1);
  });

  it('5/§31 — id_unit_usaha STABIL & dapat dipakai sebagai foreign key', async () => {
    const id = await buatUnitUsaha({ namaUsaha: 'Unit Simpan Pinjam' });

    // Simulasi tabel fase berikutnya (RAKU) yang menunjuk unit usaha.
    // RAKU-nya sendiri TIDAK diimplementasikan di sini — yang dibuktikan
    // hanya bahwa `id` layak menjadi foreign key.
    await testDb.execAsync(
      `CREATE TABLE uji_raku (
         id TEXT PRIMARY KEY,
         unit_usaha_id TEXT NOT NULL REFERENCES koperasi_unit_usaha(id)
       )`
    );
    await testDb.runAsync(`INSERT INTO uji_raku (id, unit_usaha_id) VALUES ('r1', ?)`, id);

    // Nama berubah, id tidak — referensinya tetap sah.
    await perbaruiUnitUsaha(id, { namaUsaha: 'Nama Berubah Total' });
    const r = await testDb.getFirstAsync<{ unit_usaha_id: string }>(
      `SELECT unit_usaha_id FROM uji_raku WHERE id='r1'`
    );
    expect(r?.unit_usaha_id).toBe(id);

    // 6. referensi tidak sah DITOLAK database.
    await expect(
      testDb.runAsync(`INSERT INTO uji_raku (id, unit_usaha_id) VALUES ('r2','unit-tidak-ada')`)
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('nama usaha kosong DITOLAK', async () => {
    await expect(buatUnitUsaha({ namaUsaha: '  ' })).rejects.toThrow(/wajib diisi/);
    expect(await listUnitUsaha()).toHaveLength(0);
  });
});

describe('Fase 7 — CRUD peraturan internal', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });
  afterEach(() => testDb.closeSync());

  it('create, read, update, status, histori tetap ada', async () => {
    const id = await buatPeraturan({
      namaDokumen: 'Anggaran Dasar',
      jenisDokumen: 'AD',
      nomor: 'AD-01',
      yangMenetapkan: 'RAT 2024',
    });
    expect((await getPeraturan(id))?.status).toBe('BERLAKU');

    await perbaruiPeraturan(id, { namaDokumen: 'Anggaran Dasar', status: 'DIGANTI' });
    expect((await getPeraturan(id))?.status).toBe('DIGANTI');

    // Dokumen pengganti ditambahkan; yang lama TIDAK dihapus.
    await buatPeraturan({ namaDokumen: 'Anggaran Dasar 2026', jenisDokumen: 'AD' });
    expect(await listPeraturan()).toHaveLength(2);
  });

  it('nama dokumen kosong DITOLAK', async () => {
    await expect(buatPeraturan({ namaDokumen: '' })).rejects.toThrow(/wajib diisi/);
  });
});

// ===========================================================================
// ISOLASI IDENTITAS vs MASTER
// ===========================================================================

describe('Fase 7 — §30 isolasi identitas vs master data', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedKoperasiLama('BH-OLD-001');
  });
  afterEach(() => testDb.closeSync());

  it('menyimpan identitas TIDAK menyentuh personel/perizinan/unit/peraturan', async () => {
    const idPersonel = await buatPersonel({ nama: 'Siti', jenisPersonel: 'PENGURUS' });
    const idUnit = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    const idIzin = await buatPerizinan({ namaIzin: 'Izin A' });
    const idAturan = await buatPeraturan({ namaDokumen: 'AD' });

    await updateIdentitasKoperasi({
      nama: 'Koperasi Baru',
      nomorAhu: 'AHU-9',
      nomorIndukKoperasi: 'NIK-9',
      alamat: 'Jl. Baru',
    } as never);

    expect((await getPersonel(idPersonel))?.nama).toBe('Siti');
    expect((await getUnitUsaha(idUnit))?.namaUsaha).toBe('Unit Toko');
    expect((await getPerizinan(idIzin))?.namaIzin).toBe('Izin A');
    expect((await getPeraturan(idAturan))?.namaDokumen).toBe('AD');
  });

  it('menyimpan master data TIDAK menimpa identitas koperasi', async () => {
    await updateIdentitasKoperasi({
      nama: 'Koperasi Tetap',
      nomorAhu: 'AHU-TETAP',
      nomorIndukKoperasi: 'NIK-TETAP',
      alamat: 'Jl. Tetap',
    } as never);

    await buatPersonel({ nama: 'Budi', jenisPersonel: 'KARYAWAN' });
    await buatUnitUsaha({ namaUsaha: 'Unit B' });
    await buatPerizinan({ namaIzin: 'Izin B' });
    await buatPeraturan({ namaDokumen: 'ART' });

    const id = await getIdentitasKoperasi();
    expect(id?.nama).toBe('Koperasi Tetap');
    expect(id?.nomorAhu).toBe('AHU-TETAP');
    expect(id?.nomorIndukKoperasi).toBe('NIK-TETAP');
    expect(id?.alamat).toBe('Jl. Tetap');
  });

  it('master service TIDAK pernah menulis ke tabel koperasi', async () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'KoperasiMasterService.ts'),
      'utf8'
    ) as string;
    expect(src).not.toMatch(/UPDATE koperasi\b/);
    expect(src).not.toMatch(/INSERT INTO koperasi\b/);
    // Dan tidak menyentuh akuntansi sama sekali (§37).
    expect(src).not.toMatch(/journal|account_mapping|createJournal/);
  });
});
