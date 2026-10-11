import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RESTRUKTURISASI DATA + ASAL PERSONEL (Anggota Koperasi / Pihak Luar).
 *
 * Tiga lapis:
 *  1. NAVIGASI (audit sumber) — struktur hub Data, kepindahan enam master
 *     dari Identitas Koperasi, hilangnya menu Data Klasifikasi Aset,
 *     dan tidak adanya rute ganda.
 *  2. MIGRASI v69 -> v70 (SQLite sungguhan) — kolom baru additive,
 *     baris lama utuh, `personel_id` transaksi historis tetap valid.
 *  3. PERILAKU PERSONEL (SQLite sungguhan) — mode ANGGOTA/LUAR,
 *     snapshot identitas, perpindahan mode, dan bukti tidak ada jurnal
 *     yang tersentuh.
 */

let testDb: TestDb;

jest.mock('@/database/db', () => {
  const asli = jest.requireActual('@/database/db');
  return {
    ...asli,
    getDb: jest.fn(async () => testDb),
    withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
      let result: unknown;
      await testDb.withTransactionAsync(async () => {
        result = await fn(testDb);
      });
      return result;
    }),
  };
});

import { runMigrations } from '@/database/db';
import {
  buatPersonel,
  perbaruiPersonel,
  getPersonel,
  listPersonel,
  setStatusPersonel,
  LABEL_SUMBER_DATA,
  SUMBER_DATA_PERSONEL,
} from '@/services/KoperasiMasterService';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ANGGOTA_ID = 'anggota-1';

async function seedAnggota(db: TestDb, id: string, nomor: string, nama: string, opts: Partial<{ nik: string; jk: string; hp: string; alamat: string; status: string }> = {}) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, jenis_kelamin, alamat, nomor_hp, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, nomor, opts.nik ?? null, nama, opts.jk ?? null, opts.alamat ?? null, opts.hp ?? null,
    '2020-01-01', opts.status ?? 'AKTIF', now, now
  );
}

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAnggota(db, ANGGOTA_ID, 'AGT-0001', 'Budi Santoso', {
    nik: '3201010101010001', jk: 'LAKI_LAKI', hp: '081234567890', alamat: 'Jl. Melati No. 1',
  });
  return db;
}

// ===========================================================================
// 1. NAVIGASI — struktur hub Data & kepindahan menu
// ===========================================================================

describe('Restrukturisasi Data — navigasi', () => {
  const hub = tanpaKomentar(baca('src/screens/Pengaturan/InputDataHubScreen.tsx'));
  const identitas = tanpaKomentar(baca('src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'));
  const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));

  it('TEST 1 — hub Data punya tiga section dengan urutan yang ditentukan', () => {
    for (const judul of ['Keanggotaan & Personel', 'Kelembagaan Koperasi', 'Referensi & Akuntansi']) {
      expect(hub).toContain(`judul: '${judul}'`);
    }
    const iA = hub.indexOf("judul: 'Keanggotaan & Personel'");
    const iB = hub.indexOf("judul: 'Kelembagaan Koperasi'");
    const iC = hub.indexOf("judul: 'Referensi & Akuntansi'");
    expect(iA).toBeLessThan(iB);
    expect(iB).toBeLessThan(iC);
    // Section di-render sebagai header, bukan sekadar data yang tidak dipakai.
    expect(hub).toContain('<Text style={styles.sectionHeader}>{seksi.judul}</Text>');
  });

  it('TEST 40 — isi tiap section persis seperti acceptance criteria', () => {
    const seksi = (mulai: string, akhir: string | null) =>
      hub.slice(hub.indexOf(mulai), akhir ? hub.indexOf(akhir) : hub.length);

    const keanggotaan = seksi("judul: 'Keanggotaan & Personel'", "judul: 'Kelembagaan Koperasi'");
    for (const t of ['Anggota', 'Pengurus', 'Pengawas', 'Pengelola / Karyawan / Pekerja']) {
      expect(keanggotaan).toContain(`title: '${t}'`);
    }

    const kelembagaan = seksi("judul: 'Kelembagaan Koperasi'", "judul: 'Referensi & Akuntansi'");
    for (const t of ['Perizinan yang Dimiliki', 'Unit Usaha', 'Peraturan Internal', 'Pelaksanaan RAT']) {
      expect(kelembagaan).toContain(`title: '${t}'`);
    }

    const referensi = seksi("judul: 'Referensi & Akuntansi'", null);
    for (const t of ['Akun', 'Saldo Awal', 'Data Bank', 'Data Pemasok', 'Data Pemberi Pinjaman', 'Data Bank Pemberi Pinjaman', 'Data Beban Lain']) {
      expect(referensi).toContain(`title: '${t}'`);
    }
  });

  it('TEST 2 — "Data Klasifikasi Aset" tidak lagi menjadi entry menu, dan rutenya tidak lagi terdaftar', () => {
    expect(hub).not.toContain('Data Klasifikasi Aset');
    expect(hub).not.toContain('DataKlasifikasiAset');
    // Rute dihapus dari KEDUA stack -> tidak ada dead route.
    expect(nav).not.toMatch(/name="DataKlasifikasiAset"/);
    expect(nav).not.toContain("import DataKlasifikasiAsetScreen");
  });

  it('TEST 31 — HAPUS MENU != HAPUS FITUR: service & default klasifikasi aset tetap ada dan tetap dipakai form aset', () => {
    // File service & konfigurasinya tidak boleh ikut terhapus.
    expect(() => baca('src/services/AsetKlasifikasiService.ts')).not.toThrow();
    expect(() => baca('src/config/defaultAsetKlasifikasi.ts')).not.toThrow();
    // Ketiga form yang memakainya sebagai picker masih memanggilnya.
    for (const layar of [
      'src/screens/Transaksi/PembelianAsetFormScreen.tsx',
      'src/screens/Transaksi/ModalFormScreen.tsx',
      'src/screens/Transaksi/AsetEditFormScreen.tsx',
    ]) {
      expect(baca(layar)).toContain('AsetKlasifikasiService');
    }
  });

  it('TEST 3-9 — keenam master + RAT dibuka LANGSUNG dari hub Data (satu tap, tanpa lewat Identitas)', () => {
    expect(hub).toContain("nav.navigate('PersonelKoperasi', { kategori: ['PENGURUS'], judul: 'Pengurus' })");
    expect(hub).toContain("nav.navigate('PersonelKoperasi', { kategori: ['PENGAWAS'], judul: 'Pengawas' })");
    expect(hub).toMatch(/kategori: \['PENGELOLA', 'KARYAWAN', 'PEKERJA'\]/);
    expect(hub).toContain("nav.navigate('PerizinanKoperasi')");
    expect(hub).toContain("nav.navigate('UnitUsahaKoperasi')");
    expect(hub).toContain("nav.navigate('PeraturanInternal')");
    expect(hub).toContain("nav.navigate('PelaksanaanRAT')");
    expect(hub).toContain("nav.navigate('AnggotaList')");
  });

  it('TEST 11 — IdentitasKoperasiScreen tidak lagi punya keenam pintasan, tapi form identitasnya utuh', () => {
    for (const rute of ['PersonelKoperasi', 'PerizinanKoperasi', 'UnitUsahaKoperasi', 'PeraturanInternal']) {
      expect(identitas).not.toContain(`navigate('${rute}'`);
    }
    expect(identitas).not.toContain('MenuAdministrasi');
    // Identitas koperasi sendiri TIDAK dihapus.
    for (const bagian of ['Informasi Dasar', 'Alamat', 'Kontak', 'Administratif', 'Branding']) {
      expect(identitas).toContain(bagian);
    }
  });

  it('TEST 10/17 — tidak ada rute ganda: tiap master terdaftar TEPAT SEKALI, di AnggotaStack (tab Data)', () => {
    for (const rute of ['PersonelKoperasi', 'PerizinanKoperasi', 'UnitUsahaKoperasi', 'PeraturanInternal']) {
      const semua = nav.match(new RegExp(`name="${rute}"`, 'g')) ?? [];
      expect(semua).toHaveLength(1);
      // Terdaftar di AnggotaStack — stack yang sama dengan hub pemanggilnya,
      // sehingga Back kembali ke Data, bukan ke Identitas Koperasi.
      expect(nav).toMatch(new RegExp(`<AnggotaStack\\.Screen[\\s\\S]{0,120}name="${rute}"`));
    }
  });

  it('TEST 10 — tidak ada entry menu duplikat di dalam hub', () => {
    const judul = Array.from(hub.matchAll(/title: '([^']+)'/g)).map((m) => m[1]);
    expect(new Set(judul).size).toBe(judul.length);
  });

  it('TEST 8 (judul) — istilah "Data" konsisten antara tab bar dan header hub', () => {
    expect(nav).toContain("tabBarLabel: 'Data'");
    expect(nav).toMatch(/name="InputDataHub"[^/]*options=\{\{ title: 'Data' \}\}/);
    expect(nav).not.toContain("title: 'Input Data'");
  });

  it('TEST 37 — setiap item menu accessible sebagai tombol dengan label bermakna', () => {
    expect(hub).toContain('accessibilityRole="button"');
    expect(hub).toContain('accessibilityLabel={`${f.title}. ${f.sub}`}');
  });
});

// ===========================================================================
// 2. MIGRASI v69 -> v70
// ===========================================================================

describe('Restrukturisasi Data — migrasi v70 (asal personel)', () => {
  const NOW = '2026-01-01T00:00:00.000Z';

  /** Instalasi v69: `koperasi_personel` BENTUK LAMA, tanpa sumber_data/anggota_id. */
  async function siapkanInstalasiV69(db: TestDb) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
    );
    await db.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 69)`);
    await db.execAsync(`
      DROP TABLE IF EXISTS koperasi_personel;
      CREATE TABLE koperasi_personel (
        id TEXT PRIMARY KEY,
        nama TEXT NOT NULL,
        jenis_kelamin TEXT CHECK (jenis_kelamin IN ('L','P')),
        jabatan TEXT,
        tanggal_mulai_jabatan TEXT,
        tanggal_berakhir_jabatan TEXT,
        nik TEXT,
        nomor_telepon TEXT,
        alamat TEXT,
        jenis_personel TEXT NOT NULL CHECK (jenis_personel IN
          ('PENGURUS','PENGAWAS','PENGELOLA','KARYAWAN','PEKERJA')),
        status_aktif INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    await db.runAsync(
      `INSERT INTO koperasi_personel
        (id, nama, jenis_kelamin, jabatan, tanggal_mulai_jabatan, tanggal_berakhir_jabatan,
         nik, nomor_telepon, alamat, jenis_personel, status_aktif, created_at, updated_at)
       VALUES ('personel-lama','Siti Aminah','P','Ketua','2024-01-01','2026-12-31',
               '3201020202020002','08987654321','Jl. Mawar No. 2','PENGURUS',1,?,?)`,
      NOW, NOW
    );
  }

  beforeEach(async () => {
    testDb = await createTestDb();
    await siapkanInstalasiV69(testDb);
  });

  it('TEST 28/32 — kolom baru ditambahkan tanpa mengubah SATU PUN nilai baris lama', async () => {
    const sebelum = await testDb.getFirstAsync<any>(`SELECT * FROM koperasi_personel WHERE id = 'personel-lama'`);
    await runMigrations(testDb as any);
    const sesudah = await testDb.getFirstAsync<any>(`SELECT * FROM koperasi_personel WHERE id = 'personel-lama'`);

    // id dan seluruh field existing identik — tidak ada rebuild yang menggeser data.
    for (const k of ['id', 'nama', 'jenis_kelamin', 'jabatan', 'tanggal_mulai_jabatan',
      'tanggal_berakhir_jabatan', 'nik', 'nomor_telepon', 'alamat', 'jenis_personel',
      'status_aktif', 'created_at', 'updated_at']) {
      expect(sesudah[k]).toEqual(sebelum[k]);
    }
    // Kolom baru hadir dengan nilai yang JUJUR.
    expect(sesudah.sumber_data).toBe('LUAR');
    expect(sesudah.anggota_id).toBeNull();
  });

  it('TEST 10 (migration safety) — personel lama TIDAK diklaim sebagai anggota walau ada anggota dengan NIK/nama serupa', async () => {
    // Anggota yang "mirip" sengaja dibuat: migrasi tidak boleh menebak.
    await seedAnggota(testDb, 'anggota-mirip', 'AGT-0009', 'Siti Aminah', { nik: '3201020202020002' });
    await runMigrations(testDb as any);
    const r = await testDb.getFirstAsync<any>(`SELECT sumber_data, anggota_id FROM koperasi_personel WHERE id = 'personel-lama'`);
    expect(r.sumber_data).toBe('LUAR');
    expect(r.anggota_id).toBeNull(); // kemiripan BUKAN bukti identitas
  });

  it('idempoten — dijalankan dua kali tidak menduplikasi baris atau mengubah nilai', async () => {
    await runMigrations(testDb as any);
    const pertama = await testDb.getAllAsync<any>(`SELECT * FROM koperasi_personel ORDER BY id`);
    await runMigrations(testDb as any);
    const kedua = await testDb.getAllAsync<any>(`SELECT * FROM koperasi_personel ORDER BY id`);
    expect(kedua).toEqual(pertama);
    expect(kedua).toHaveLength(1);
  });

  it('index idx_personel_anggota dibuat, dan versi schema naik ke 70', async () => {
    await runMigrations(testDb as any);
    const idx = await testDb.getFirstAsync<any>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_personel_anggota'`
    );
    expect(idx?.name).toBe('idx_personel_anggota');
    const v = await testDb.getFirstAsync<any>(`SELECT version FROM schema_meta WHERE id = 1`);
    expect(v.version).toBeGreaterThanOrEqual(70);
  });

  it('TEST 29 — migrasi tidak menyentuh jurnal sama sekali', async () => {
    const jSebelum = await testDb.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`);
    const eSebelum = await testDb.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`);
    await runMigrations(testDb as any);
    expect(await testDb.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`)).toEqual(jSebelum);
    expect(await testDb.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`)).toEqual(eSebelum);
  });

  it('integritas FK tetap bersih setelah migrasi', async () => {
    await runMigrations(testDb as any);
    const pelanggaran = await testDb.getAllAsync<any>(`PRAGMA foreign_key_check`);
    expect(pelanggaran).toEqual([]);
  });
});

// ===========================================================================
// 3. PERILAKU PERSONEL — Anggota Koperasi / Pihak Luar
// ===========================================================================

describe('Personel — sumber data Anggota Koperasi', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  it('TEST 25 — pilih anggota: identitas DISALIN sebagai snapshot ke baris personel', async () => {
    const id = await buatPersonel({
      nama: 'diabaikan — diambil dari anggota',
      jenisPersonel: 'PENGURUS',
      sumberData: 'ANGGOTA',
      anggotaId: ANGGOTA_ID,
      jabatan: 'Ketua',
      tanggalMulaiJabatan: '2026-01-01',
      tanggalBerakhirJabatan: '2028-12-31',
    });

    const r = await getPersonel(id);
    expect(r).toMatchObject({
      sumberData: 'ANGGOTA',
      anggotaId: ANGGOTA_ID,
      nama: 'Budi Santoso',
      nik: '3201010101010001',
      nomorTelepon: '081234567890',
      alamat: 'Jl. Melati No. 1',
      jabatan: 'Ketua',
      jenisPersonel: 'PENGURUS',
    });
    // Domain jenis kelamin diterjemahkan, bukan disalin mentah.
    expect(r!.jenisKelamin).toBe('L'); // anggota: 'LAKI_LAKI'

    // Snapshot benar-benar TERSIMPAN di baris personel (bukan hasil JOIN saat baca).
    const mentah = await testDb.getFirstAsync<any>(`SELECT nama, nik FROM koperasi_personel WHERE id = ?`, id);
    expect(mentah.nama).toBe('Budi Santoso');
    expect(mentah.nik).toBe('3201010101010001');
  });

  it('TEST 11 (snapshot) — memperbarui master Anggota TIDAK menulis ulang histori personel', async () => {
    const id = await buatPersonel({
      nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua',
    });

    // Anggota pindah alamat & ganti nomor setelah jabatan tercatat.
    await testDb.runAsync(
      `UPDATE anggota SET alamat = 'Jl. Kenanga No. 9', nomor_hp = '080000000000' WHERE id = ?`, ANGGOTA_ID
    );

    const r = await getPersonel(id);
    // Catatan jabatan tetap menunjukkan data sebagaimana tercatat saat itu.
    expect(r!.alamat).toBe('Jl. Melati No. 1');
    expect(r!.nomorTelepon).toBe('081234567890');
    expect(r!.anggotaId).toBe(ANGGOTA_ID); // tautannya sendiri tetap ada
  });

  it('menautkan ulang secara EKSPLISIT memperbarui snapshot', async () => {
    const id = await buatPersonel({
      nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua',
    });
    await testDb.runAsync(`UPDATE anggota SET alamat = 'Jl. Kenanga No. 9' WHERE id = ?`, ANGGOTA_ID);

    await perbaruiPersonel(id, {
      nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua',
    });
    expect((await getPersonel(id))!.alamat).toBe('Jl. Kenanga No. 9');
  });

  it('TEST 16 — anggota wajib dipilih, dan anggota yang tidak ada ditolak', async () => {
    await expect(
      buatPersonel({ nama: 'X', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: null, jabatan: 'Ketua' })
    ).rejects.toThrow(/Anggota wajib dipilih/);

    await expect(
      buatPersonel({ nama: 'X', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: 'tidak-ada', jabatan: 'Ketua' })
    ).rejects.toThrow(/Anggota yang dipilih tidak ditemukan/);
  });

  // KEPUTUSAN VALIDASI (butuh sign-off): "nama wajib" kini berlaku HANYA
  // pada mode LUAR. Pada mode ANGGOTA nama selalu ditimpa snapshot dari
  // baris anggota, jadi mewajibkannya berarti menuntut data yang dijamin
  // dibuang. Identitas mode ANGGOTA tetap dijaga dua lapis: `anggotaId`
  // wajib, dan `ambilSnapshotAnggota()` melempar bila anggotanya tidak ada
  // — sehingga tidak ada jalur yang menghasilkan personel tanpa nama.
  it('mode ANGGOTA: nama kosong DITERIMA (diisi snapshot), mode LUAR tetap mewajibkan nama', async () => {
    const id = await buatPersonel({
      nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua',
    });
    expect((await getPersonel(id))!.nama).toBe('Budi Santoso'); // tidak pernah kosong di database

    await expect(
      buatPersonel({ nama: '   ', jenisPersonel: 'PENGAWAS', sumberData: 'LUAR', jabatan: 'Ketua' })
    ).rejects.toThrow(/Nama personel wajib diisi/);
  });
});

describe('Personel — sumber data Pihak Luar', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  it('TEST 26 — pihak luar tersimpan manual dengan anggota_id NULL, dan tetap dapat dibaca/diedit', async () => {
    const id = await buatPersonel({
      nama: 'Ahmad Yani',
      jenisPersonel: 'PENGAWAS',
      sumberData: 'LUAR',
      jabatan: 'Ketua Pengawas',
      jenisKelamin: 'L',
      nik: '3201030303030003',
      nomorTelepon: '081111111111',
      alamat: 'Jl. Anggrek No. 3',
    });

    const r = await getPersonel(id);
    expect(r).toMatchObject({
      sumberData: 'LUAR', anggotaId: null, nama: 'Ahmad Yani',
      jabatan: 'Ketua Pengawas', nik: '3201030303030003',
    });

    await perbaruiPersonel(id, {
      nama: 'Ahmad Yani', jenisPersonel: 'PENGAWAS', sumberData: 'LUAR',
      jabatan: 'Anggota Pengawas', nik: '3201030303030003',
    });
    const sesudah = await getPersonel(id);
    expect(sesudah!.jabatan).toBe('Anggota Pengawas');
    expect(sesudah!.anggotaId).toBeNull();
  });

  it('TEST 14 — tidak ada anggota dummy yang dibuat untuk pihak luar', async () => {
    const sebelum = await testDb.getAllAsync<any>(`SELECT id FROM anggota`);
    await buatPersonel({ nama: 'Ahmad', jenisPersonel: 'PENGAWAS', sumberData: 'LUAR', jabatan: 'Ketua' });
    const sesudah = await testDb.getAllAsync<any>(`SELECT id FROM anggota`);
    expect(sesudah).toEqual(sebelum);
  });

  it('TEST 16 — pihak luar yang membawa anggotaId DITOLAK (tidak ada tautan basi yang diam-diam lolos)', async () => {
    await expect(
      buatPersonel({ nama: 'Ahmad', jenisPersonel: 'PENGAWAS', sumberData: 'LUAR', anggotaId: ANGGOTA_ID, jabatan: 'Ketua' })
    ).rejects.toThrow(/Pihak Luar tidak boleh terhubung/);
  });

  it('default tanpa sumberData = LUAR — pemanggil lama tetap bekerja tanpa perubahan', async () => {
    const id = await buatPersonel({ nama: 'Tanpa Sumber', jenisPersonel: 'KARYAWAN', jabatan: 'Staf' });
    const r = await getPersonel(id);
    expect(r).toMatchObject({ sumberData: 'LUAR', anggotaId: null, nama: 'Tanpa Sumber' });
  });
});

describe('Personel — TEST 27: perpindahan mode', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  it('ANGGOTA -> LUAR: anggota_id menjadi NULL, snapshot tetap sebagai data manual', async () => {
    const id = await buatPersonel({
      nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua',
    });
    expect((await getPersonel(id))!.anggotaId).toBe(ANGGOTA_ID);

    await perbaruiPersonel(id, {
      nama: 'Budi Santoso', jenisPersonel: 'PENGURUS', sumberData: 'LUAR', jabatan: 'Ketua',
      nik: '3201010101010001', nomorTelepon: '081234567890', alamat: 'Jl. Melati No. 1',
    });

    const r = await getPersonel(id);
    expect(r!.sumberData).toBe('LUAR');
    expect(r!.anggotaId).toBeNull(); // TIDAK ada anggota_id stale
    expect(r!.nama).toBe('Budi Santoso'); // identitas tidak hilang
  });

  it('LUAR -> ANGGOTA: wajib memilih anggota; setelah dipilih snapshot diperbarui dari anggota itu', async () => {
    const id = await buatPersonel({
      nama: 'Ahmad Yani', jenisPersonel: 'PENGAWAS', sumberData: 'LUAR', jabatan: 'Ketua Pengawas', nik: '999',
    });

    // Tanpa memilih anggota -> ditolak.
    await expect(
      perbaruiPersonel(id, { nama: 'Ahmad Yani', jenisPersonel: 'PENGAWAS', sumberData: 'ANGGOTA', jabatan: 'Ketua Pengawas' })
    ).rejects.toThrow(/Anggota wajib dipilih/);

    await perbaruiPersonel(id, {
      nama: 'Ahmad Yani', jenisPersonel: 'PENGAWAS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua Pengawas',
    });
    const r = await getPersonel(id);
    expect(r).toMatchObject({ sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, nama: 'Budi Santoso', nik: '3201010101010001' });
    expect(r!.jabatan).toBe('Ketua Pengawas'); // jabatan milik peran, tidak ikut ditimpa
  });

  it('id personel TIDAK PERNAH berubah saat mode diganti (personel_id transaksi tetap valid)', async () => {
    const id = await buatPersonel({
      nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua',
    });
    await perbaruiPersonel(id, { nama: 'Budi Santoso', jenisPersonel: 'PENGURUS', sumberData: 'LUAR', jabatan: 'Ketua' });
    await perbaruiPersonel(id, { nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua' });
    const semua = await testDb.getAllAsync<any>(`SELECT id FROM koperasi_personel`);
    expect(semua).toEqual([{ id }]);
  });
});

describe('Personel — TEST 29/30: keamanan akuntansi & Imbalan Kerja', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  it('TEST 29 — membuat/mengedit master personel TIDAK membuat jurnal apa pun', async () => {
    const potret = async () =>
      JSON.stringify({
        j: await testDb.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`),
        e: await testDb.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`),
      });

    const sebelum = await potret();
    const id = await buatPersonel({
      nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua',
    });
    await perbaruiPersonel(id, { nama: 'Ahmad', jenisPersonel: 'PENGURUS', sumberData: 'LUAR', jabatan: 'Ketua' });
    await setStatusPersonel(id, false);
    await listPersonel({ jenisPersonel: 'PENGURUS' });

    expect(await potret()).toBe(sebelum); // byte-identik
  });

  it('TEST 30 — personel yang berasal dari anggota tetap dapat dipakai workflow berbasis personel_id', async () => {
    const id = await buatPersonel({
      nama: '', jenisPersonel: 'KARYAWAN', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Staf Administrasi',
    });
    // Lookup lewat id — persis cara ImbalanKerjaService menunjuk penerima.
    const r = await getPersonel(id);
    expect(r).not.toBeNull();
    expect(r!.id).toBe(id);
    expect(r!.statusAktif).toBe(true);
    // Muncul di daftar aktif per jenis, sama seperti personel pihak luar.
    const aktif = await listPersonel({ jenisPersonel: 'KARYAWAN', hanyaAktif: true });
    expect(aktif.map((x) => x.id)).toContain(id);
  });

  it('TEST 18 — jenis personel tidak berubah otomatis; satu orang bisa punya baris di jenis berbeda', async () => {
    const a = await buatPersonel({ nama: '', jenisPersonel: 'PENGURUS', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Ketua' });
    const b = await buatPersonel({ nama: '', jenisPersonel: 'PENGELOLA', sumberData: 'ANGGOTA', anggotaId: ANGGOTA_ID, jabatan: 'Manajer' });
    expect(a).not.toBe(b);
    expect((await getPersonel(a))!.jenisPersonel).toBe('PENGURUS');
    expect((await getPersonel(b))!.jenisPersonel).toBe('PENGELOLA');
  });
});

// ===========================================================================
// 4. UI FORM PERSONEL (audit sumber)
// ===========================================================================

describe('Personel — struktur form & daftar', () => {
  const layar = tanpaKomentar(baca('src/screens/Pengaturan/MasterKoperasiScreens.tsx'));

  it('TEST 36 — istilah dikunci: "Anggota Koperasi" / "Pihak Luar", bukan varian lain', () => {
    expect(LABEL_SUMBER_DATA.ANGGOTA).toBe('Anggota Koperasi');
    expect(LABEL_SUMBER_DATA.LUAR).toBe('Pihak Luar');
    expect(SUMBER_DATA_PERSONEL).toEqual(['ANGGOTA', 'LUAR']);
    expect(layar).not.toMatch(/'Eksternal'|'Non Member'|'Non-Member'/);
    // Judul gabungan dipertahankan apa adanya.
    expect(tanpaKomentar(baca('src/screens/Pengaturan/InputDataHubScreen.tsx')))
      .toContain('Pengelola / Karyawan / Pekerja');
  });

  it('TEST 13 — memakai AnggotaPicker yang SUDAH ADA, tidak membuat picker kedua', () => {
    expect(layar).toContain("import AnggotaPicker from '@/components/AnggotaPicker';");
    expect(layar).toContain('<AnggotaPicker value={form.anggota} onChange={pilihAnggota} />');
    expect(layar).not.toMatch(/function AnggotaPicker|const AnggotaPicker =/);
  });

  it('TEST 15 — perpindahan mode di form memutus tautan / meminta pilih ulang', () => {
    expect(layar).toContain("setForm({ ...form, sumberData: 'LUAR', anggota: null });");
    expect(layar).toMatch(/setForm\(\{ \.\.\.form, sumberData: 'ANGGOTA', anggota: null, nama: '', nik: '', telepon: '', alamat: '' \}\)/);
  });

  it('TEST 17 — form TIDAK mencocokkan personel lama ke anggota secara otomatis', () => {
    // Satu-satunya cara anggota terisi saat edit: membaca anggotaId yang
    // memang TERSIMPAN. Tidak ada pencarian berbasis nama/NIK/telepon.
    expect(layar).toContain("if (r.sumberData === 'ANGGOTA' && r.anggotaId)");
    expect(layar).toContain('getAnggotaById(r.anggotaId)');
    expect(layar).not.toMatch(/cariAnggotaBerdasarkanNik|matchAnggota|findAnggotaByNama/);
  });

  it('TEST 13 — mode ANGGOTA: identitas read-only; jabatan & tanggal tetap dapat diedit', () => {
    expect(layar).toContain('<BarisIdentitas label="NIK"');
    expect(layar).toContain('<BarisIdentitas label="Alamat"');
    // Jabatan & tanggal berada di luar percabangan mode -> selalu editable.
    const iJabatan = layar.indexOf('<Field label="Jabatan" wajib');
    const iTanggal = layar.indexOf('label="Tanggal Mulai Jabatan"');
    expect(iJabatan).toBeGreaterThan(0);
    expect(iTanggal).toBeGreaterThan(iJabatan);
  });

  it('TEST 35/37 — daftar menampilkan asal personel sebagai teks, dan selector-nya accessible', () => {
    expect(layar).toContain('LABEL_SUMBER_DATA[r.sumberData]');
    expect(layar).toContain('accessibilityLabel={`Sumber data: ${LABEL_SUMBER_DATA[sd]}`}');
    expect(layar).toContain('accessibilityState={{ selected: aktif }}');
  });

  it('TEST 12 — default form baru adalah Anggota Koperasi', () => {
    expect(layar).toMatch(/const FORM_PERSONEL_KOSONG[\s\S]{0,300}sumberData: 'ANGGOTA'/);
  });
});
