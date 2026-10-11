import { createTestDb, TestDb } from './testDb';
import { CREATE_TABLES_SQL_V78 } from './schemaV78Fixture';
import { migrasiV79 } from '@/database/db';

/**
 * RC-S128 — MIGRASI v79 di atas database v78 (schema baseline RC-S127)
 * yang sudah berisi kontrak & periode bunga. Membuktikan: aditif,
 * idempoten, data historis tidak berubah, kontrak lama menjadi LEGACY
 * tanpa rate karangan, dan trigger baru aktif.
 */
let db: TestDb;
const now = new Date().toISOString();

beforeEach(async () => {
  db = await createTestDb({ applySchema: false });
  await db.execAsync(CREATE_TABLES_SQL_V78);
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('u','A','a','ADMIN','x','x',0,1,?,?)`, now, now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('a','A1','N','Ang','2020-01-01','AKTIF',?,?)`, now, now
  );
  await db.runAsync(
    `INSERT INTO simpanan_berjangka (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal, tenor_bulan,
       suku_bunga, status, sumber_dana, bunga_terakru, created_by, created_at, updated_at)
     VALUES ('k1','a','SPB-1','2026-01-10','2026-04-10',10000000,3,6,'JATUH_TEMPO','KAS',150000,'u',?,?)`, now, now
  );
  for (const n of [1, 2, 3]) {
    await db.runAsync(
      `INSERT INTO simpanan_berjangka_bunga (id, simpanan_berjangka_id, nomor_periode, tanggal_akhir_periode, bunga, created_by, created_at)
       VALUES (?,?,?,?,50000,'u',?)`, `b${n}`, 'k1', n, `2026-0${n + 1}-10`, now
    );
  }
});

test('v78 -> v79: kolom & tabel baru ada, data lama utuh, kontrak lama LEGACY tanpa rate pasca', async () => {
  await migrasiV79(db as any);
  const k = await db.getFirstAsync<any>(`SELECT * FROM simpanan_berjangka WHERE id = 'k1'`);
  expect(k).toMatchObject({
    nominal: 10000000, suku_bunga: 6, bunga_terakru: 150000, status: 'JATUH_TEMPO',
    status_policy: 'LEGACY_POLICY_REVIEW_REQUIRED', policy_id: null, policy_rate_pasca_jatuh_tempo: null,
  });
  const b = await db.getAllAsync<any>(`SELECT nomor_periode, bunga, jenis_periode, rate_persen FROM simpanan_berjangka_bunga ORDER BY nomor_periode`);
  expect(b).toEqual([1, 2, 3].map((n) => ({ nomor_periode: n, bunga: 50000, jenis_periode: 'KONTRAK', rate_persen: 6 })));
  expect((await db.getFirstAsync<any>(`SELECT COUNT(*) n FROM simpanan_berjangka_kebijakan_produk`)).n).toBe(0);
  expect((await db.getFirstAsync<any>(`SELECT COUNT(*) n FROM simpanan_berjangka_penerapan_kebijakan`)).n).toBe(0);
});

test('idempoten: dijalankan dua kali tanpa error dan tanpa perubahan', async () => {
  await migrasiV79(db as any);
  const sebelum = JSON.stringify(await db.getAllAsync(`SELECT * FROM simpanan_berjangka`));
  await migrasiV79(db as any);
  expect(JSON.stringify(await db.getAllAsync(`SELECT * FROM simpanan_berjangka`))).toBe(sebelum);
  const trig = await db.getAllAsync<any>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_sb_%' ORDER BY name`);
  expect(trig.map((t: any) => t.name)).toEqual([
    'trg_sb_kebijakan_produk_cabut', 'trg_sb_kebijakan_produk_tanpa_edit', 'trg_sb_kebijakan_produk_tanpa_hapus',
    'trg_sb_kontrak_policy_aktif_insert', 'trg_sb_kontrak_policy_aktif_update',
    'trg_sb_penerapan_tanpa_ubah', 'trg_sb_pokok_tetap', 'trg_sb_snapshot_kebijakan_tetap',
  ]);
});

test('trigger aktif setelah migrasi: pokok kontrak lama terkunci', async () => {
  await migrasiV79(db as any);
  await expect(db.runAsync(`UPDATE simpanan_berjangka SET nominal = 1 WHERE id = 'k1'`)).rejects.toThrow(/Pokok/);
});

test('struktur hasil migrasi sama dengan instalasi baru (kolom kontrak & bunga)', async () => {
  await migrasiV79(db as any);
  const baru = await createTestDb();
  for (const t of ['simpanan_berjangka', 'simpanan_berjangka_bunga', 'simpanan_berjangka_kebijakan_produk', 'simpanan_berjangka_penerapan_kebijakan']) {
    const a = (await db.getAllAsync<any>(`PRAGMA table_info(${t})`)).map((c: any) => c.name).sort();
    const b = (await baru.getAllAsync<any>(`PRAGMA table_info(${t})`)).map((c: any) => c.name).sort();
    expect(a).toEqual(b);
  }
});
