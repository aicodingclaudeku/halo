import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * HOTFIX — snapshot "Simpanan Sukarela sebagai Basis Jasa Modal SHU" pada
 * migrasi v78 TIDAK mengunci tahun buku DRAFT yang belum pernah dihitung.
 *
 * Urutan yang dijamin:
 *  (1) DRAFT belum pernah dihitung -> belum tersnapshot, kebijakan masih
 *      bisa ditentukan/diubah untuk tahun itu;
 *  (2) SHU pertama kali dihitung -> kebijakan saat itu disimpan sebagai
 *      snapshot tahun buku;
 *  (3) proses berikutnya tahun yang sama -> selalu snapshot, bukan setting
 *      global;
 *  (4) tahun yang sudah diproses sebelum v78 -> tetap ON (kompatibel).
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

import { migrasiV78 } from '@/database/db';
import {
  getSukarelaIkutJasaModalTahun,
  simpanVersiBasisJasaModal,
  tahunMinimumVersiBaru,
  tentukanSnapshotBasisJasaModal,
} from '@/services/KebijakanBasisJasaModalService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const now = () => new Date().toISOString();
const TAHUN_INI = Number(getTanggalLokalHariIni().slice(0, 4));
const tambahKolom = async () => undefined;

async function siapkan() {
  testDb = await createTestDb();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now(),
    now()
  );
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('ang-1','A-001','NIK-1','Andi','2020-01-01','AKTIF',?,?)`,
    now(),
    now()
  );
}

/** Baris SHU "lama" (seperti sebelum v78): snapshot NULL. */
async function shu(id: string, tahun: number, kolom: Record<string, unknown> = {}) {
  const k = { status: 'DRAFT', ...kolom };
  const nama = Object.keys(k);
  await testDb.runAsync(
    `INSERT INTO shu_konfigurasi (id, tahun_buku, ${nama.join(', ')}, created_at, updated_at)
     VALUES (?, ?, ${nama.map(() => '?').join(', ')}, ?, ?)`,
    id,
    tahun,
    ...nama.map((n) => k[n as keyof typeof k]),
    now(),
    now()
  );
}

const snapshot = async (id: string) =>
  (await testDb.getFirstAsync<{ s: number | null }>(`SELECT sukarela_basis_jasa_modal AS s FROM shu_konfigurasi WHERE id = ?`, id))?.s ?? null;
const baris = async (id: string) => testDb.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE id = ?`, id);

describe('migrasi v78 — deteksi tahun buku yang sudah pernah dihitung', () => {
  beforeEach(siapkan);

  it('DRAFT lama yang belum pernah dihitung TETAP belum tersnapshot (NULL)', async () => {
    await shu('draft', TAHUN_INI);
    await migrasiV78(testDb as never, tambahKolom);
    expect(await snapshot('draft')).toBeNull();
  });

  it('tahun lama yang sudah dihitung/diproses tetap ON (setiap jenis bukti)', async () => {
    await shu('dihitung', 2019, { status: 'DIHITUNG', total_shu: 1_000 });
    await shu('diajukan', 2020, { status: 'DIAJUKAN_RAT', shu_diajukan_rat: 1_000 });
    await shu('disahkan', 2021, { status: 'DISAHKAN_RAT', shu_disahkan_rat: 1_000 });
    await shu('dibagikan', 2022, { status: 'DIBAGIKAN' });
    // Pernah dihitung lalu konfigurasinya disimpan ulang -> status DRAFT,
    // total_shu & shu_anggota terhapus, tetapi shu_informasi_rat tetap ada.
    await shu('draft-pernah-dihitung', 2023, { shu_informasi_rat: 900 });
    // DRAFT dengan hasil per anggota yang masih ada.
    await shu('draft-ada-anggota', 2024);
    await testDb.runAsync(
      `INSERT INTO shu_anggota (id, shu_konfigurasi_id, anggota_id, basis_simpanan, basis_partisipasi_usaha, jasa_modal, jasa_usaha, total_shu_anggota)
       VALUES ('sa-1','draft-ada-anggota','ang-1',0,0,0,0,0)`
    );
    await migrasiV78(testDb as never, tambahKolom);
    for (const id of ['dihitung', 'diajukan', 'disahkan', 'dibagikan', 'draft-pernah-dihitung', 'draft-ada-anggota']) {
      expect([id, await snapshot(id)]).toEqual([id, 1]);
    }
  });

  it('idempoten dan tidak mengubah kolom/histori lain', async () => {
    await shu('dihitung', 2019, { status: 'DIHITUNG', total_shu: 1_000 });
    await shu('draft', TAHUN_INI);
    const sebelum = { a: await baris('dihitung'), b: await baris('draft') };
    await migrasiV78(testDb as never, tambahKolom);
    await migrasiV78(testDb as never, tambahKolom);
    const sesudah = { a: await baris('dihitung'), b: await baris('draft') };
    expect({ ...sesudah.a, sukarela_basis_jasa_modal: null }).toEqual({ ...sebelum.a, sukarela_basis_jasa_modal: null });
    expect(sesudah.b).toEqual(sebelum.b);
    expect(await snapshot('dihitung')).toBe(1);
    expect(await snapshot('draft')).toBeNull();
  });
});

describe('alur snapshot setelah migrasi', () => {
  beforeEach(async () => {
    await siapkan();
    // Instalasi lama: tahun lalu sudah dihitung, tahun berjalan masih DRAFT.
    await shu('lama', TAHUN_INI - 1, { status: 'DIHITUNG', total_shu: 1_000 });
    await shu('draft', TAHUN_INI);
    await migrasiV78(testDb as never, tambahKolom);
  });

  it('instalasi lama yang pernah menjalankan SHU lama: kebijakan global ON', async () => {
    expect(await getSukarelaIkutJasaModalTahun(TAHUN_INI)).toBe(true);
  });

  it('tahun DRAFT tidak terkunci: kebijakan untuk tahun berjalan masih dapat diubah', async () => {
    expect(await tahunMinimumVersiBaru()).toBe(TAHUN_INI);
    await simpanVersiBasisJasaModal('user-1', false, TAHUN_INI);
    expect(await getSukarelaIkutJasaModalTahun(TAHUN_INI)).toBe(false);
  });

  it('DRAFT yang kemudian dihitung dengan policy OFF -> snapshot OFF; toggle global ON sesudahnya tidak mengubahnya', async () => {
    await simpanVersiBasisJasaModal('user-1', false, TAHUN_INI);
    // Titik inisialisasi ShuService pada perhitungan pertama.
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await baris('draft'))).toBe(false);
    expect(await snapshot('draft')).toBe(0);
    // Tahun berjalan kini terkunci: versi baru paling awal tahun depan.
    expect(await tahunMinimumVersiBaru()).toBe(TAHUN_INI + 1);
    await expect(simpanVersiBasisJasaModal('user-1', true, TAHUN_INI)).rejects.toThrow(/ke depan/);
    // Bahkan bila kebijakan global dipaksa ON untuk tahun itu, snapshot tetap dipakai.
    await testDb.runAsync(
      `INSERT INTO kebijakan_basis_jasa_modal (id, berlaku_mulai_tahun, sukarela_ikut, created_by, created_at) VALUES ('paksa', ?, 1, 'x', ?)`,
      TAHUN_INI,
      now()
    );
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await baris('draft'))).toBe(false);
    expect(await snapshot('draft')).toBe(0);
  });

  it('tahun buku lain yang belum dihitung memakai kebijakan barunya', async () => {
    await simpanVersiBasisJasaModal('user-1', false, TAHUN_INI);
    await tentukanSnapshotBasisJasaModal(testDb as never, await baris('draft'));
    await simpanVersiBasisJasaModal('user-1', true, TAHUN_INI + 1);
    await shu('depan', TAHUN_INI + 1);
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await baris('depan'))).toBe(true);
    expect(await snapshot('depan')).toBe(1);
    expect(await snapshot('draft')).toBe(0);
  });

  it('tahun lama yang sudah dihitung tetap ON walau kebijakan global berubah', async () => {
    await simpanVersiBasisJasaModal('user-1', false, TAHUN_INI);
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await baris('lama'))).toBe(true);
  });
});

describe('instalasi baru & titik integrasi', () => {
  it('instalasi baru (tanpa migrasi) default OFF; DRAFT pertama dihitung -> snapshot OFF', async () => {
    await siapkan();
    await shu('baru', TAHUN_INI);
    expect(await getSukarelaIkutJasaModalTahun(TAHUN_INI)).toBe(false);
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await baris('baru'))).toBe(false);
    expect(await snapshot('baru')).toBe(0);
  });

  it('ShuService: snapshot ditentukan saat dihitung & disahkan; simpan konfigurasi tidak menyentuh snapshot', () => {
    const svc = baca('src/services/ShuService.ts');
    expect((svc.match(/await tentukanSnapshotBasisJasaModal\(db, konfigurasi\)/g) ?? []).length).toBe(2);
    const simpan = svc.slice(svc.indexOf('export async function simpanKonfigurasiShu'), svc.indexOf('export async function getBasisAnggotaSHU'));
    expect(simpan).not.toContain('sukarela_basis_jasa_modal');
  });

  it('migrasi tidak lagi mengunci semua baris tanpa syarat', () => {
    const db = baca('src/database/db.ts');
    expect(db).not.toContain('UPDATE shu_konfigurasi SET sukarela_basis_jasa_modal = 1 WHERE sukarela_basis_jasa_modal IS NULL`');
    expect(db).toMatch(/WHERE sukarela_basis_jasa_modal IS NULL\s+AND \(status <> 'DRAFT'/);
  });
});
