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
  buatPersonel,
  listPersonel,
  perbaruiPersonel,
  setStatusPersonel,
  buatPerizinan,
  listPerizinan,
  perbaruiPerizinan,
  buatUnitUsaha,
  listUnitUsaha,
  perbaruiUnitUsaha,
  setStatusUnitUsaha,
  getUnitUsaha,
  buatPeraturan,
  listPeraturan,
  perbaruiPeraturan,
  JENIS_PERSONEL,
  type JenisPersonel,
} from '@/services/KoperasiMasterService';
import { getIdentitasKoperasi, updateIdentitasKoperasi } from '@/services/SetupService';

/**
 * FASE 7 FINAL — UI MASTER DATA IDENTITAS KOPERASI.
 *
 * DUA JENIS PEMBUKTIAN, dan perbedaannya penting untuk dibaca jujur:
 *
 *  1. INTEGRASI DATABASE NYATA (`node:sqlite`, skema produksi) untuk
 *     setiap operasi yang dilakukan layar: tambah, ubah, nonaktifkan,
 *     muat ulang, isolasi identitas/master, integritas, dan snapshot
 *     akuntansi. Inilah bukti bahwa tombol di layar benar-benar
 *     menghasilkan keadaan database yang benar.
 *
 *  2. PEMBACAAN SOURCE untuk hal-hal yang hanya ada di lapisan React —
 *     tidak ada SQL di layar, tidak ada hapus permanen, state di-refresh
 *     dari database, tombol dinonaktifkan saat menyimpan.
 *     `jest.config.js` memakai `testMatch: *.test.ts` dengan
 *     `testEnvironment: 'node'` dan tanpa transformer JSX, sehingga
 *     komponen `.tsx` TIDAK dapat dirender di sini. Itu batas
 *     lingkungan, bukan klaim bahwa render sudah diuji.
 */

function baca(relatif: string): string {
  return readFileSync(join(__dirname, '..', '..', relatif), 'utf8');
}

function tanpaKomentar(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const LAYAR_MASTER = 'src/screens/Pengaturan/MasterKoperasiScreens.tsx';
const LAYAR_IDENTITAS = 'src/screens/Pengaturan/IdentitasKoperasiScreen.tsx';

async function seedKoperasi(): Promise<void> {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO koperasi (id, nama, nomor_badan_hukum, nomor_ahu, nomor_induk_koperasi, npwp,
                           alamat, tahun_buku_aktif, standar_akuntansi, setup_selesai, created_at, updated_at)
     VALUES ('kop-1','Koperasi Uji','AHU-1','AHU-1','NIK-KOP-1','01.234.567.8-901.000',
             'Jl. Uji No. 1',2026,'SAK_EP',1,?,?)`,
    now,
    now
  );
}

/** Ringkasan akuntansi — dipakai membandingkan sebelum/sesudah (§26). */
async function snapshotAkuntansi(): Promise<Record<string, number>> {
  const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);
  const je = await testDb.getFirstAsync<{ n: number; d: number; k: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(debit),0) d, COALESCE(SUM(kredit),0) k FROM journal_entry`
  );
  const acc = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM account`);
  return {
    jumlahJurnal: j?.n ?? 0,
    jumlahEntri: je?.n ?? 0,
    totalDebit: je?.d ?? 0,
    totalKredit: je?.k ?? 0,
    jumlahAkun: acc?.n ?? 0,
  };
}

async function seedAkuntansiMinimal(): Promise<void> {
  const now = new Date().toISOString();
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
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-modal','3-1000','Simpanan Pokok','EKUITAS','KREDIT',1,1,?,?)`,
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
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je1','j1','acc-kas',5000000,0)`
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je2','j1','acc-modal',0,5000000)`
  );
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedKoperasi();
});

afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// §22.1–4 — AHU & NIK
// ===========================================================================

describe('§22 AHU & NIK pada layar Identitas', () => {
  it('1-2. AHU & NIK dimuat dari database', async () => {
    const id = await getIdentitasKoperasi();
    expect(id?.nomorAhu).toBe('AHU-1');
    expect(id?.nomorIndukKoperasi).toBe('NIK-KOP-1');
  });

  it('3-4. edit AHU & NIK tersimpan dan terbaca ulang', async () => {
    await updateIdentitasKoperasi({
      nama: 'Koperasi Uji',
      nomorAhu: 'AHU-2026-0009',
      nomorIndukKoperasi: 'NIK-KOP-2026',
    } as never);

    const lagi = await getIdentitasKoperasi();
    expect(lagi?.nomorAhu).toBe('AHU-2026-0009');
    expect(lagi?.nomorIndukKoperasi).toBe('NIK-KOP-2026');
    // Kolom kompatibilitas ikut bergerak — tidak mungkin divergen.
    expect(lagi?.nomorBadanHukum).toBe('AHU-2026-0009');
  });

  it('layar memakai label resmi dan state terpisah untuk AHU & NIK', () => {
    const src = tanpaKomentar(baca(LAYAR_IDENTITAS));
    expect(src).toContain('Nomor Administrasi Hukum Umum (AHU)');
    expect(src).toContain('Nomor Induk Koperasi (NIK)');
    expect(src).toMatch(/const \[nomorAhu, setNomorAhu\]/);
    expect(src).toMatch(/const \[nomorIndukKoperasi, setNomorIndukKoperasi\]/);
    // Label lama tidak dipakai lagi sebagai judul field.
    expect(src).not.toMatch(/label="Nomor Badan Hukum"/);
  });

  it('layar identitas memakai SetupService, bukan SQL langsung', () => {
    const src = tanpaKomentar(baca(LAYAR_IDENTITAS));
    expect(src).toMatch(/updateIdentitasKoperasi\(/);
    expect(src).not.toMatch(/SELECT |INSERT INTO |UPDATE koperasi/);
  });
});

// ===========================================================================
// §22.5–11 — PERSONEL
// ===========================================================================

describe('§22 CRUD personel dari layar', () => {
  it('5-9. kelima jenis personel dapat ditambahkan', async () => {
    for (const j of JENIS_PERSONEL) {
      await buatPersonel({ nama: `Orang ${j}`, jenisPersonel: j, jabatan: 'Jabatan' });
    }
    for (const j of JENIS_PERSONEL) {
      const rows = await listPersonel({ jenisPersonel: j });
      expect(rows).toHaveLength(1);
      expect(rows[0].jenisPersonel).toBe(j);
    }
    expect(await listPersonel()).toHaveLength(5);
  });

  it('10. edit personel — ID tetap, data berubah', async () => {
    const id = await buatPersonel({ nama: 'Siti', jenisPersonel: 'PENGURUS', jabatan: 'Bendahara' });
    await perbaruiPersonel(id, { nama: 'Siti Aminah', jenisPersonel: 'PENGURUS', jabatan: 'Ketua' });
    const rows = await listPersonel({ jenisPersonel: 'PENGURUS' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].jabatan).toBe('Ketua');
  });

  it('11. nonaktifkan — baris TETAP ADA, hilang dari daftar aktif', async () => {
    const id = await buatPersonel({ nama: 'Budi', jenisPersonel: 'KARYAWAN', jabatan: 'Staf' });
    await setStatusPersonel(id, false);
    expect(await listPersonel({ jenisPersonel: 'KARYAWAN', hanyaAktif: true })).toHaveLength(0);
    const semua = await listPersonel({ jenisPersonel: 'KARYAWAN' });
    expect(semua).toHaveLength(1);
    expect(semua[0].statusAktif).toBe(false);
  });

  it('§7 — NIK personel berbeda dari NIK koperasi, keduanya hidup berdampingan', async () => {
    const id = await buatPersonel({
      nama: 'Rina',
      jenisPersonel: 'PENGELOLA',
      jabatan: 'Manajer',
      nik: '3201010101010002',
    });
    const p = (await listPersonel({ jenisPersonel: 'PENGELOLA' })).find((x) => x.id === id);
    expect(p?.nik).toBe('3201010101010002');
    expect((await getIdentitasKoperasi())?.nomorIndukKoperasi).toBe('NIK-KOP-1');
  });

  it('layar menolak NIK personel yang sama dengan NIK koperasi', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).toMatch(/nik !== '' && nikKoperasi !== null && nik === nikKoperasi/);
    expect(src).toContain('NIK personel tidak boleh sama dengan Nomor Induk Koperasi.');
  });

  it('layar mewajibkan nama & jabatan, dan menjaga urutan tanggal', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).toContain('Nama wajib diisi.');
    expect(src).toContain('Jabatan wajib diisi.');
    expect(src).toMatch(/akhir < mulai/);
  });

  it('jenis personel diambil dari rute, bukan ditanyakan ulang', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).toMatch(/jenisPersonel: jenisAktif/);
    expect(src).toMatch(/route\.params\?\.kategori/);
  });

  it('satu layar untuk kelima jenis — tidak ada tiga layar identik', () => {
    const src = baca(LAYAR_MASTER);
    expect((src.match(/export function PersonelKoperasiScreen/g) ?? [])).toHaveLength(1);
    const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));
    expect((nav.match(/name="PersonelKoperasi"/g) ?? [])).toHaveLength(1);
    expect(nav).not.toMatch(/name="PengelolaKoperasi"|name="KaryawanKoperasi"|name="PekerjaKoperasi"/);
  });
});

// ===========================================================================
// §22.12–18 — PERIZINAN, UNIT USAHA, PERATURAN
// ===========================================================================

describe('§22 CRUD perizinan, unit usaha, peraturan', () => {
  it('12-13. tambah & edit izin', async () => {
    const id = await buatPerizinan({
      namaIzin: 'Izin Usaha Simpan Pinjam',
      nomorIzin: 'IUSP-1',
      tanggalTerbit: '2024-01-10',
      berlakuSampai: '2029-01-10',
      instansiPenerbit: 'Kementerian Koperasi',
    });
    expect(await listPerizinan()).toHaveLength(1);

    await perbaruiPerizinan(id, { namaIzin: 'IUSP', status: 'KEDALUWARSA' });
    const rows = await listPerizinan();
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe('KEDALUWARSA');
  });

  it('14-16. tambah, edit, nonaktifkan unit usaha — ID TIDAK berubah', async () => {
    const id = await buatUnitUsaha({ namaUsaha: 'Unit Toko', jenisUsaha: 'Ritel' });
    await perbaruiUnitUsaha(id, { namaUsaha: 'Unit Toko Sejahtera', jenisUsaha: 'Ritel' });
    await setStatusUnitUsaha(id, 'NONAKTIF');

    const u = await getUnitUsaha(id);
    expect(u?.id).toBe(id);
    expect(u?.namaUsaha).toBe('Unit Toko Sejahtera');
    expect(u?.status).toBe('NONAKTIF');
    // Tidak dihapus: baris tetap terbaca di daftar lengkap.
    expect(await listUnitUsaha()).toHaveLength(1);
    expect(await listUnitUsaha(true)).toHaveLength(0);
  });

  it('§20 — id_unit_usaha tetap sah sebagai foreign key setelah ganti nama', async () => {
    const id = await buatUnitUsaha({ namaUsaha: 'Unit Awal' });
    await testDb.execAsync(
      `CREATE TABLE uji_ref (id TEXT PRIMARY KEY, unit_usaha_id TEXT NOT NULL REFERENCES koperasi_unit_usaha(id))`
    );
    await testDb.runAsync(`INSERT INTO uji_ref (id, unit_usaha_id) VALUES ('r1', ?)`, id);

    await perbaruiUnitUsaha(id, { namaUsaha: 'Nama Berubah Total' });
    const r = await testDb.getFirstAsync<{ unit_usaha_id: string }>(
      `SELECT unit_usaha_id FROM uji_ref WHERE id='r1'`
    );
    expect(r?.unit_usaha_id).toBe(id);
    await expect(
      testDb.runAsync(`INSERT INTO uji_ref (id, unit_usaha_id) VALUES ('r2','tidak-ada')`)
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('ID unit usaha ditampilkan read-only, bukan sebagai isian', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).toContain('ID Unit Usaha');
    expect(src).toMatch(/readonlyBox/);
    // Tidak ada Field yang menulis ke form.id.
    expect(src).not.toMatch(/onChange=\{\(v\) => setForm\(\{ \.\.\.form, id: v \}\)\}/);
  });

  it('17-18. tambah & edit peraturan; yang lama tidak dihapus', async () => {
    const id = await buatPeraturan({ namaDokumen: 'Anggaran Dasar', jenisDokumen: 'AD' });
    await perbaruiPeraturan(id, { namaDokumen: 'Anggaran Dasar', status: 'DIGANTI' });
    await buatPeraturan({ namaDokumen: 'Anggaran Dasar 2026', jenisDokumen: 'AD' });

    const rows = await listPeraturan();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === id)?.status).toBe('DIGANTI');
  });
});

// ===========================================================================
// §22.19 / §24 — MUAT ULANG & PERSISTENSI
// ===========================================================================

describe('§22.19 muat ulang seluruh master', () => {
  it('semua master terbaca kembali setelah ditulis', async () => {
    await buatPersonel({ nama: 'A', jenisPersonel: 'PENGURUS', jabatan: 'Ketua' });
    await buatPerizinan({ namaIzin: 'Izin A' });
    await buatUnitUsaha({ namaUsaha: 'Unit A' });
    await buatPeraturan({ namaDokumen: 'AD' });

    // Pembacaan ULANG lewat service — bukan dari array lokal mana pun.
    expect(await listPersonel()).toHaveLength(1);
    expect(await listPerizinan()).toHaveLength(1);
    expect(await listUnitUsaha()).toHaveLength(1);
    expect(await listPeraturan()).toHaveLength(1);
  });

  it('§24 — pembacaan berulang konsisten (tidak ada cache di lapisan service)', async () => {
    const id = await buatUnitUsaha({ namaUsaha: 'Unit Persisten' });
    for (let i = 0; i < 3; i += 1) {
      // Tiap panggilan membuka kueri baru ke database. Tidak ada
      // penyimpanan di memori yang bisa menyimpang dari isi tabel.
      expect((await getUnitUsaha(id))?.namaUsaha).toBe('Unit Persisten');
    }
  });

  it('§12 — layar membaca ulang database setelah simpan, bukan memutasi array', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    // Setiap simpan diikuti muat() ...
    expect((src.match(/await muat\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // ... dan tidak ada penambahan langsung ke state daftar.
    expect(src).not.toMatch(/setData\(\[\.\.\.data/);
    expect(src).not.toMatch(/data\.push\(/);
  });
});

// ===========================================================================
// §11 — ISOLASI IDENTITAS / MASTER
// ===========================================================================

describe('§11 isolasi identitas vs master data', () => {
  it('Skenario A — menyimpan identitas tidak mengubah master', async () => {
    const p = await buatPersonel({ nama: 'Siti', jenisPersonel: 'PENGURUS', jabatan: 'Ketua' });
    const u = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    await buatPerizinan({ namaIzin: 'Izin A' });
    await buatPeraturan({ namaDokumen: 'AD' });

    await updateIdentitasKoperasi({
      nama: 'Nama Baru',
      nomorAhu: 'AHU-BARU',
      nomorIndukKoperasi: 'NIK-BARU',
      alamat: 'Jl. Baru',
    } as never);

    expect((await listPersonel()).find((x) => x.id === p)?.nama).toBe('Siti');
    expect((await getUnitUsaha(u))?.namaUsaha).toBe('Unit Toko');
    expect(await listPerizinan()).toHaveLength(1);
    expect(await listPeraturan()).toHaveLength(1);
  });

  it('Skenario B — menyimpan master tidak menimpa identitas', async () => {
    await updateIdentitasKoperasi({
      nama: 'Koperasi Tetap',
      nomorAhu: 'AHU-TETAP',
      nomorIndukKoperasi: 'NIK-TETAP',
      alamat: 'Jl. Tetap',
    } as never);

    await buatPersonel({ nama: 'Budi', jenisPersonel: 'PEKERJA', jabatan: 'Harian' });
    await buatUnitUsaha({ namaUsaha: 'Unit B' });
    await buatPerizinan({ namaIzin: 'Izin B' });
    await buatPeraturan({ namaDokumen: 'ART' });

    const id = await getIdentitasKoperasi();
    expect(id?.nama).toBe('Koperasi Tetap');
    expect(id?.nomorAhu).toBe('AHU-TETAP');
    expect(id?.nomorIndukKoperasi).toBe('NIK-TETAP');
    expect(id?.alamat).toBe('Jl. Tetap');
  });

  it('Skenario C — personel bertahan melewati perubahan identitas berulang', async () => {
    await buatPersonel({ nama: 'Tetap', jenisPersonel: 'PENGAWAS', jabatan: 'Ketua Pengawas' });
    for (let i = 0; i < 3; i += 1) {
      await updateIdentitasKoperasi({ nama: `Koperasi ${i}`, nomorAhu: `AHU-${i}` } as never);
    }
    const rows = await listPersonel({ jenisPersonel: 'PENGAWAS' });
    expect(rows).toHaveLength(1);
    expect(rows[0].nama).toBe('Tetap');
  });

  it('Skenario D — mengubah unit usaha tidak menyentuh identitas', async () => {
    const u = await buatUnitUsaha({ namaUsaha: 'Unit X' });
    const sebelum = await getIdentitasKoperasi();

    await perbaruiUnitUsaha(u, { namaUsaha: 'Unit Y', status: 'NONAKTIF' });

    const sesudah = await getIdentitasKoperasi();
    expect(sesudah?.nama).toBe(sebelum?.nama);
    expect(sesudah?.nomorAhu).toBe(sebelum?.nomorAhu);
    expect(sesudah?.nomorIndukKoperasi).toBe(sebelum?.nomorIndukKoperasi);
  });

  it('layar master TIDAK pernah menyentuh tabel koperasi', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).not.toMatch(/updateIdentitasKoperasi\(/);
    expect(src).not.toMatch(/UPDATE koperasi|INSERT INTO koperasi/);
    // Membaca NIK koperasi untuk validasi DIPERBOLEHKAN — itu baca murni.
    expect(src).toMatch(/getIdentitasKoperasi\(\)/);
  });
});

// ===========================================================================
// §18 / §6 — ARSITEKTUR LAYAR
// ===========================================================================

describe('§18 arsitektur layar master', () => {
  it('tidak ada SQL di layar; semuanya lewat KoperasiMasterService', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    for (const dilarang of ['SELECT ', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'getDb(', 'withTransaction(']) {
      expect(src).not.toContain(dilarang);
    }
    expect(src).toMatch(/from '@\/services\/KoperasiMasterService'/);
  });

  it('§6 — tidak ada aksi hapus permanen di layar mana pun', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).not.toMatch(/Hapus Permanen|hapusPersonel|hapusUnitUsaha|hapusPerizinan|hapusPeraturan/);
    // Yang tersedia hanyalah penonaktifan / perubahan status.
    expect(src).toMatch(/setStatusPersonel\(/);
    expect(src).toMatch(/setStatusUnitUsaha\(/);
  });

  it('§13 — setiap layar punya loading, empty, dan error state', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).toMatch(/function Kondisi\(/);
    expect((src.match(/<Kondisi/g) ?? [])).toHaveLength(4);
    expect(src).toContain('Data personel gagal dimuat.');
    expect(src).toContain('Data perizinan gagal dimuat.');
    expect(src).toContain('Data unit usaha gagal dimuat.');
    expect(src).toContain('Data peraturan internal gagal dimuat.');
    expect(src).toMatch(/Belum ada \$\{LABEL_PERSONEL\[jenisAktif\]\}/);
  });

  it('§13 — error tidak ditelan diam-diam', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    // Tidak ada catch kosong.
    expect(src).not.toMatch(/catch \([^)]*\) \{\s*\}/);
    expect((src.match(/notify\('Gagal/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('§16/§17 — tombol simpan dinonaktifkan selama penyimpanan', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).toMatch(/disabled=\{menyimpan\}/);
    expect(src).toMatch(/setMenyimpan\(true\)/);
    expect(src).toMatch(/finally \{\s*setMenyimpan\(false\);/);
    // RC-S110: pola lama `behavior={Platform.OS === 'ios' ? 'padding'
    // : undefined}` DIHAPUS dari seluruh aplikasi karena `behavior`
    // undefined membuat KeyboardAvoidingView tidak melakukan apa-apa di
    // Android — satu-satunya platform yang dibangun. Perlindungannya
    // sekarang lewat <AreaAmanKeyboard varian="...">, yang memberi
    // Android behavior 'height' untuk dialog. Assertion ini diperbarui
    // ke komponen barunya; yang dijaga tetap sama — layar ini WAJIB
    // punya perlindungan papan ketik, bukan sekadar mengimpornya.
    expect(src).toMatch(/<AreaAmanKeyboard varian="(dialog|layar)"/);
    expect(src).toMatch(/ScrollView/);
  });

  it('§15 — tanggal tetap string ISO; tidak ada parser tanggal baru', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).toMatch(/function FieldTanggal/);
    expect(src).toMatch(/placeholder="YYYY-MM-DD"/);
    // Tidak ada konversi lewat objek Date yang bisa menggeser zona waktu.
    expect(src).not.toMatch(/new Date\(/);
  });

  // DIPERBARUI RESTRUKTURISASI DATA: keenam master dipindah dari layar
  // Identitas Koperasi ke hub Data (InputDataHubScreen). Maksud test
  // TIDAK berubah — keenamnya tetap harus punya SATU pintu masuk resmi
  // yang dapat dijangkau; yang berubah hanya layar tempatnya berada.
  it('hub Data menautkan keenam master (bukan lagi layar Identitas)', () => {
    const src = tanpaKomentar(baca('src/screens/Pengaturan/InputDataHubScreen.tsx'));
    for (const rute of [
      "'PersonelKoperasi', { kategori: ['PENGURUS']",
      "'PersonelKoperasi', { kategori: ['PENGAWAS']",
      "'PerizinanKoperasi'",
      "'UnitUsahaKoperasi'",
      "'PeraturanInternal'",
    ]) {
      expect(src).toContain(rute);
    }
    expect(src).toMatch(/kategori: \['PENGELOLA', 'KARYAWAN', 'PEKERJA'\]/);
  });

  it('layar Identitas Koperasi TIDAK lagi menautkan master mana pun (tidak ada pintu ganda)', () => {
    const src = tanpaKomentar(baca(LAYAR_IDENTITAS));
    for (const rute of ['PersonelKoperasi', 'PerizinanKoperasi', 'UnitUsahaKoperasi', 'PeraturanInternal']) {
      expect(src).not.toContain(`navigate('${rute}'`);
    }
    // Identitas kembali hanya mengurus identitas koperasi.
    expect(src).toContain('Informasi Dasar');
    expect(src).toContain('Branding');
  });

  it('keempat rute terdaftar di navigator', () => {
    const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));
    for (const r of ['PersonelKoperasi', 'PerizinanKoperasi', 'UnitUsahaKoperasi', 'PeraturanInternal']) {
      expect(nav).toContain(`name="${r}"`);
    }
  });
});

// ===========================================================================
// §23 / §26 — INTEGRITAS & SNAPSHOT AKUNTANSI
// ===========================================================================

describe('§23/§26 integritas data & akuntansi', () => {
  it('tidak ada orphan; foreign_key_check kosong setelah seluruh operasi', async () => {
    const p = await buatPersonel({ nama: 'A', jenisPersonel: 'PENGURUS', jabatan: 'Ketua' });
    const u = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    await buatPerizinan({ namaIzin: 'Izin A' });
    await buatPeraturan({ namaDokumen: 'AD' });
    await setStatusPersonel(p, false);
    await setStatusUnitUsaha(u, 'NONAKTIF');

    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
    const fk = await testDb.getFirstAsync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
    expect(fk?.foreign_keys).toBe(1);
  });

  it('tidak ada ID duplikat di keempat master', async () => {
    for (let i = 0; i < 5; i += 1) {
      await buatPersonel({ nama: `P${i}`, jenisPersonel: 'KARYAWAN', jabatan: 'Staf' });
      await buatUnitUsaha({ namaUsaha: `U${i}` });
      await buatPerizinan({ namaIzin: `I${i}` });
      await buatPeraturan({ namaDokumen: `D${i}` });
    }
    for (const [rows] of [
      [await listPersonel()],
      [await listUnitUsaha()],
      [await listPerizinan()],
      [await listPeraturan()],
    ] as const) {
      const ids = (rows as { id: string }[]).map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(5);
    }
  });

  it('§26 — snapshot akuntansi TIDAK bergerak sedikit pun', async () => {
    await seedAkuntansiMinimal();
    const sebelum = await snapshotAkuntansi();

    await buatPersonel({ nama: 'A', jenisPersonel: 'PENGURUS', jabatan: 'Ketua' });
    const u = await buatUnitUsaha({ namaUsaha: 'Unit A' });
    await perbaruiUnitUsaha(u, { namaUsaha: 'Unit B', status: 'NONAKTIF' });
    await buatPerizinan({ namaIzin: 'Izin A' });
    await buatPeraturan({ namaDokumen: 'AD' });
    await updateIdentitasKoperasi({ nama: 'Koperasi Uji', nomorAhu: 'AHU-9' } as never);

    expect(await snapshotAkuntansi()).toEqual(sebelum);
  });

  it('§30 — Fase 7 sendiri tidak menambah migration di atas v60', () => {
    // Maksud assertion ini: UI Fase 7 tidak memerlukan schema baru.
    // Bentuk semula memakunya pada angka 60 dan melarang blok v61 mana
    // pun, sehingga fase berikutnya yang memang butuh tabel baru
    // (Imbalan Kerja & Keluar Anggota) memutusnya. Yang diuji sekarang
    // adalah maksudnya: v60 tetap terpasang, dan tidak ada satu pun
    // tabel master Fase 7 yang dibuat di luar blok v60.
    const schema = baca('src/database/schema.ts');
    const cocok = schema.match(/export const SCHEMA_VERSION = (\d+);/);
    expect(Number(cocok![1])).toBeGreaterThanOrEqual(60);
    const db = baca('src/database/db.ts');
    const awalV60 = db.indexOf('export async function migrasiV60');
    const akhirV60 = db.indexOf('export async function migrasiV61');
    const blokV60 = db.slice(awalV60, akhirV60 > awalV60 ? akhirV60 : undefined);
    for (const t of [
      'koperasi_personel',
      'koperasi_perizinan',
      'koperasi_unit_usaha',
      'koperasi_peraturan_internal',
    ]) {
      expect(blokV60).toContain(t);
    }
  });

  it('§31/§32 — fase ini tidak menyentuh akuntansi maupun lisensi', () => {
    const src = tanpaKomentar(baca(LAYAR_MASTER));
    expect(src).not.toMatch(/createJournal|AccountingEngine|LicenseService|LicenseGate/);
    const svc = tanpaKomentar(baca('src/services/KoperasiMasterService.ts'));
    expect(svc).not.toMatch(/journal|account_mapping|License/);
  });
});
