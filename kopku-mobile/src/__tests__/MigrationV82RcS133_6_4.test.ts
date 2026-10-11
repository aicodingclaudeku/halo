import { createTestDb, TestDb } from './testDb';
import { CREATE_TABLES_SQL_V81 } from './schemaV81Fixture';
import { cadangkanSebelumMigrasi, migrasiV82, runMigrations, KOLOM_PENYELESAIAN_V82 } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * RC-S133.6.4 — MIGRASI v81 -> v82 di atas snapshot skema v81 (RC-S133.6.3)
 * yang sudah berisi pinjaman. Membuktikan: aditif (hanya menambah enam kolom
 * `pinjaman.penyelesaian_*`), idempoten, data lama utuh dan kolom baru NULL,
 * struktur sama dengan instalasi baru, CHECK jalur ditegakkan, dan migrasi
 * TIDAK berjalan bila salinan pengaman sebelum migrasi gagal dibuat.
 *
 * Semua `runMigrations` memakai pembungkus `denganBerkas` supaya salinan
 * pengaman (VACUUM INTO) diamati/digagalkan secara terkendali dan nama
 * berkasnya tidak bertabrakan antar test pada detik yang sama.
 */
let db: TestDb;
const now = new Date().toISOString();

async function isiV81(d: TestDb) {
  await d.execAsync(CREATE_TABLES_SQL_V81);
  await d.execAsync(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  await d.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 81)`);
  await d.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('a1','A00001','Siti','2026-01-05','AKTIF',?,?)`, now, now
  );
  await d.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, persentase_jasa,
       tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
     VALUES ('pj1','PJ-2026-000001','a1','2026-02-01',5000000,6,'BULAN','FLAT',1,'2026-08-01','AKTIF','u',?,?)`, now, now
  );
}

/** Bungkus TestDb: database seolah berbasis berkas; VACUUM INTO dicatat (atau digagalkan). */
function denganBerkas(d: TestDb, opsi: { gagal?: boolean; berkas?: string | null }) {
  const urutan: string[] = [];
  const w: any = {
    ...d,
    getFirstAsync: d.getFirstAsync.bind(d),
    getAllAsync: async (sql: string, ...p: any[]) => {
      if (/^PRAGMA database_list/i.test(sql.trim())) {
        const file = opsi.berkas === undefined ? '/data/user/0/kopku/files/SQLite/koperasi.db' : opsi.berkas ?? '';
        return [{ seq: 0, name: 'main', file }];
      }
      return d.getAllAsync(sql, ...p);
    },
    runAsync: d.runAsync.bind(d),
    withTransactionAsync: d.withTransactionAsync.bind(d),
    execAsync: async (sql: string) => {
      if (/^VACUUM INTO/i.test(sql.trim())) {
        urutan.push(sql.trim());
        if (opsi.gagal) throw new Error('disk I/O error');
        return;
      }
      if (/ALTER TABLE pinjaman ADD COLUMN penyelesaian_jalur/.test(sql)) urutan.push('DDL v82');
      return d.execAsync(sql);
    },
  };
  return { w, urutan };
}

beforeEach(async () => {
  db = await createTestDb({ applySchema: false });
  await isiV81(db);
});

test('v81 -> v82 lewat runMigrations: enam kolom baru ada & NULL, data lama utuh, versi naik ke SCHEMA_VERSION (82)', async () => {
  expect(SCHEMA_VERSION).toBe(82);
  const { w } = denganBerkas(db, { berkas: null });
  await runMigrations(w);
  expect((await db.getFirstAsync<any>(`SELECT version FROM schema_meta`)).version).toBe(82);
  const kolom = (await db.getAllAsync<any>(`PRAGMA table_info(pinjaman)`)).map((c: any) => c.name);
  for (const k of KOLOM_PENYELESAIAN_V82) expect(kolom).toContain(k.nama);
  expect(KOLOM_PENYELESAIAN_V82.map((k) => k.nama)).toEqual([
    'penyelesaian_jalur', 'penyelesaian_tanggal', 'penyelesaian_nomor', 'penyelesaian_dokumen', 'penyelesaian_alasan', 'penyelesaian_oleh',
  ]);
  const p = await db.getFirstAsync<any>(`SELECT * FROM pinjaman WHERE id = 'pj1'`);
  expect(p).toMatchObject({ nomor_pinjaman: 'PJ-2026-000001', jumlah_pinjaman: 5000000, status: 'AKTIF', tanggal: '2026-02-01' });
  for (const k of KOLOM_PENYELESAIAN_V82) expect(p[k.nama]).toBeNull();
  expect(await db.getAllAsync(`PRAGMA foreign_key_check`)).toEqual([]);
});

test('migrasi aditif: jumlah tabel & baris lain tidak berubah, hanya kolom pinjaman bertambah', async () => {
  const tabelSebelum = (await db.getAllAsync<any>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)).map((t: any) => t.name);
  const kolomSebelum = (await db.getAllAsync<any>(`PRAGMA table_info(pinjaman)`)).length;
  const { w } = denganBerkas(db, { berkas: null });
  await runMigrations(w);
  const tabelSesudah = (await db.getAllAsync<any>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)).map((t: any) => t.name);
  // runMigrations juga memastikan tabel referensi lain (self-heal) — tidak boleh ada tabel yang HILANG.
  for (const t of tabelSebelum) expect(tabelSesudah).toContain(t);
  expect((await db.getAllAsync<any>(`PRAGMA table_info(pinjaman)`)).length).toBe(kolomSebelum + 6);
  expect((await db.getFirstAsync<any>(`SELECT COUNT(*) n FROM pinjaman`)).n).toBe(1);
  expect((await db.getFirstAsync<any>(`SELECT COUNT(*) n FROM anggota`)).n).toBe(1);
});

test('migrasiV82 idempoten: dijalankan dua kali tanpa galat dan tanpa mengubah data yang sudah dicatat', async () => {
  const tambah = async (t: string, k: string, tipe: string) => {
    try {
      await db.execAsync(`ALTER TABLE ${t} ADD COLUMN ${k} ${tipe};`);
    } catch {
      /* sudah ada */
    }
  };
  await migrasiV82(db as any, tambah);
  await db.runAsync(
    `UPDATE pinjaman SET penyelesaian_jalur='PENGADILAN', penyelesaian_tanggal='2026-09-01', penyelesaian_nomor='1/Pdt.G/2026',
       penyelesaian_dokumen='Gugatan', penyelesaian_oleh='u' WHERE id='pj1'`
  );
  const sebelum = JSON.stringify(await db.getAllAsync(`SELECT * FROM pinjaman`));
  await migrasiV82(db as any, tambah);
  expect(JSON.stringify(await db.getAllAsync(`SELECT * FROM pinjaman`))).toBe(sebelum);
});

test('migrasiV82 gagal keras bila kolom tidak berhasil ditambahkan (versi tidak boleh naik diam-diam)', async () => {
  const tambahRusak = async () => {
    /* menelan galat seperti tambahKolomJikaBelumAda, tetapi tidak menambah apa pun */
  };
  await expect(migrasiV82(db as any, tambahRusak)).rejects.toThrow(/\[migrasi v82\] kolom pinjaman belum lengkap: penyelesaian_jalur/);
});

test('struktur pinjaman hasil migrasi sama dengan instalasi baru', async () => {
  const { w } = denganBerkas(db, { berkas: null });
  await runMigrations(w);
  const baru = await createTestDb();
  const bentuk = async (d: TestDb) =>
    (await d.getAllAsync<any>(`PRAGMA table_info(pinjaman)`)).map((c: any) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`).sort();
  expect(await bentuk(db)).toEqual(await bentuk(baru));
});

test('CHECK jalur ditegakkan pada hasil migrasi maupun instalasi baru; NULL diizinkan', async () => {
  const { w } = denganBerkas(db, { berkas: null });
  await runMigrations(w);
  await expect(db.runAsync(`UPDATE pinjaman SET penyelesaian_jalur = 'LAINNYA' WHERE id = 'pj1'`)).rejects.toThrow(/CHECK/);
  await db.runAsync(`UPDATE pinjaman SET penyelesaian_jalur = 'ASURANSI' WHERE id = 'pj1'`);
  await db.runAsync(`UPDATE pinjaman SET penyelesaian_jalur = NULL WHERE id = 'pj1'`);

  const baru = await createTestDb();
  const now2 = new Date().toISOString();
  await baru.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at) VALUES ('a','A1','X','2026-01-01','AKTIF',?,?)`, now2, now2
  );
  await baru.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, created_by, created_at, updated_at)
     VALUES ('p','PJ-1','a','2026-01-01',1000,1,'BULAN','FLAT','u',?,?)`, now2, now2
  );
  await expect(baru.runAsync(`UPDATE pinjaman SET penyelesaian_jalur = 'X' WHERE id = 'p'`)).rejects.toThrow(/CHECK/);
});

test('salinan pengaman dibuat SEBELUM DDL v82, di folder database, bernama pra-migrasi-v81-ke-v82-*', async () => {
  const { w, urutan } = denganBerkas(db, {});
  await runMigrations(w);
  expect(urutan[0]).toMatch(/^VACUUM INTO '\/data\/user\/0\/kopku\/files\/SQLite\/pra-migrasi-v81-ke-v82-\d{8}T\d{6}Z\.db'$/);
  expect(urutan.indexOf('DDL v82')).toBeGreaterThan(0);
});

test('salinan GAGAL -> migrasi dihentikan: versi tetap 81, kolom tidak ditambahkan, pesan jelas; percobaan berikutnya berhasil', async () => {
  const { w } = denganBerkas(db, { gagal: true });
  await expect(runMigrations(w)).rejects.toThrow(/v81 ke v82 dihentikan: salinan pengaman .* Data tidak diubah/);
  expect((await db.getFirstAsync<any>(`SELECT version FROM schema_meta`)).version).toBe(81);
  expect((await db.getAllAsync<any>(`PRAGMA table_info(pinjaman)`)).map((c: any) => c.name)).not.toContain('penyelesaian_jalur');
  const { w: w2 } = denganBerkas(db, {});
  await runMigrations(w2);
  expect((await db.getFirstAsync<any>(`SELECT version FROM schema_meta`)).version).toBe(82);
});

test('database di memori: tanpa salinan (tidak ada berkas)', async () => {
  const { w } = denganBerkas(db, { berkas: null });
  expect(await cadangkanSebelumMigrasi(w, 81, 82)).toBe(null);
});
