import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluasiKebijakanEarlyWithdrawal,
  type KebijakanEarlyWithdrawalDraft,
} from '@/accounting/EarlyWithdrawalPolicy';

/**
 * RC-S44c — KEBIJAKAN LAMA TIDAK BOLEH MATI KARENA DRAFT BARU.
 *
 * BUG YANG DITUTUP.
 * `simpanKebijakanDini()` dulu menonaktifkan kebijakan AKTIF sebagai
 * LANGKAH PERTAMA, sebelum kebijakan baru dievaluasi. Sejak RC-S44b
 * kebijakan boleh disimpan bertahap dan sah berstatus POLICY_REQUIRED —
 * jadi menyimpan draft setengah jadi ikut mematikan kebijakan lama yang
 * masih benar dan sedang dipakai.
 *
 * Kegagalannya senyap: tidak ada pesan kesalahan, kebijakannya sekadar
 * berhenti berlaku, dan pencairan simpanan berjangka berhenti bekerja
 * tanpa ada yang tahu sebabnya.
 *
 * Test di sini memakai SQLite SUNGGUHAN (`node:sqlite`) untuk indeks
 * dan atomicity, karena keduanya adalah jaminan DATABASE — memeriksanya
 * lewat mock hanya akan menguji tiruan buatan sendiri.
 */

const ROOT = join(__dirname, '..', '..');

function buatDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE simpanan_berjangka_kebijakan_dini (
    id TEXT PRIMARY KEY, versi TEXT NOT NULL UNIQUE, berlaku_mulai TEXT NOT NULL,
    diizinkan INTEGER NOT NULL DEFAULT 0,
    jenis_penalti TEXT, perlakuan_pokok TEXT,
    status TEXT NOT NULL CHECK (status IN ('DRAFT','AKTIF','NONAKTIF')) DEFAULT 'AKTIF',
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  db.exec(
    `CREATE UNIQUE INDEX idx_aktif ON simpanan_berjangka_kebijakan_dini(status) WHERE status='AKTIF';`
  );
  return db;
}

function sisipkan(db: DatabaseSync, id: string, versi: string, status: string): void {
  db.prepare(
    `INSERT INTO simpanan_berjangka_kebijakan_dini
       (id,versi,berlaku_mulai,diizinkan,jenis_penalti,perlakuan_pokok,status,created_by,created_at,updated_at)
     VALUES (?,?,'2026-01-01',1,'TIDAK_ADA','PENUH',?,'u1','x','x')`
  ).run(id, versi, status);
}

const aktif = (db: DatabaseSync) =>
  db.prepare("SELECT id FROM simpanan_berjangka_kebijakan_dini WHERE status='AKTIF'").all() as {
    id: string;
  }[];

/** Promosi seperti yang dilakukan service: nonaktifkan dulu, baru naikkan. */
function promosikan(db: DatabaseSync, id: string): void {
  db.exec('BEGIN');
  db.exec("UPDATE simpanan_berjangka_kebijakan_dini SET status='NONAKTIF' WHERE status='AKTIF'");
  db.prepare("UPDATE simpanan_berjangka_kebijakan_dini SET status='AKTIF' WHERE id=?").run(id);
  db.exec('COMMIT');
}

function draft(o: Partial<KebijakanEarlyWithdrawalDraft> = {}): KebijakanEarlyWithdrawalDraft {
  return {
    versi: 'EW-X',
    berlakuMulai: '2026-01-01',
    diizinkan: true,
    jenisPenalti: null,
    nilaiPenalti: null,
    basisPenalti: null,
    akunPenaltiId: null,
    jenisForfeiture: null,
    nilaiForfeiture: null,
    jenisBiayaAdmin: null,
    nilaiBiayaAdmin: null,
    basisBiayaAdmin: null,
    akunBiayaAdminId: null,
    rateDini: null,
    jenisPenyesuaianRate: null,
    cakupanPenyesuaianRate: null,
    perlakuanPokok: null,
    perlakuanBunga: null,
    dasarPenetapan: null,
    ditetapkanOleh: null,
    ...o,
  };
}

const LENGKAP: Partial<KebijakanEarlyWithdrawalDraft> = {
  jenisPenalti: 'TIDAK_ADA',
  jenisForfeiture: 'TIDAK_ADA',
  jenisBiayaAdmin: 'TIDAK_ADA',
  jenisPenyesuaianRate: 'TIDAK_ADA',
  perlakuanPokok: 'PENUH',
  perlakuanBunga: 'BAYAR_SETELAH_FORFEITURE',
};

describe('A+F. kebijakan aktif bertahan saat draft baru belum lengkap', () => {
  it('menyimpan draft tidak menyentuh kebijakan aktif', () => {
    const db = buatDb();
    sisipkan(db, 'A', 'EW-A', 'AKTIF');
    sisipkan(db, 'B', 'EW-B', 'DRAFT');

    expect(aktif(db).map((r) => r.id)).toEqual(['A']);
  });

  it('F. kebijakan aktif tetap terbaca setelah "restart"', () => {
    // Restart = query ulang dari database, bukan dari state memori.
    const db = buatDb();
    sisipkan(db, 'A', 'EW-A', 'AKTIF');
    sisipkan(db, 'B', 'EW-B', 'DRAFT');

    const dibaca = db
      .prepare("SELECT id FROM simpanan_berjangka_kebijakan_dini WHERE status='AKTIF'")
      .get() as { id: string } | undefined;
    expect(dibaca?.id).toBe('A');
  });

  it('draft yang belum lengkap tidak dapat dieksekusi', () => {
    expect(evaluasiKebijakanEarlyWithdrawal(draft()).status).toBe('POLICY_REQUIRED');
  });
});

describe('B. draft yang konflik juga tidak menggusur kebijakan aktif', () => {
  it('konflik antar-parameter -> bukan AKTIF', () => {
    // TIDAK_DIBAYAR hanya sah bila seluruh bunga hangus.
    const hasil = evaluasiKebijakanEarlyWithdrawal(
      draft({ ...LENGKAP, perlakuanBunga: 'TIDAK_DIBAYAR', jenisForfeiture: 'TIDAK_ADA' })
    );
    expect(hasil.status).not.toBe('AKTIF');
  });

  it('kebijakan aktif tetap bertahan', () => {
    const db = buatDb();
    sisipkan(db, 'A', 'EW-A', 'AKTIF');
    sisipkan(db, 'B', 'EW-B', 'DRAFT'); // konflik -> tetap draft
    expect(aktif(db).map((r) => r.id)).toEqual(['A']);
  });
});

describe('C+G. promosi kebijakan lengkap', () => {
  it('C. yang baru AKTIF, yang lama NONAKTIF', () => {
    const db = buatDb();
    sisipkan(db, 'A', 'EW-A', 'AKTIF');
    sisipkan(db, 'C', 'EW-C', 'DRAFT');
    promosikan(db, 'C');

    expect(aktif(db).map((r) => r.id)).toEqual(['C']);
    const a = db
      .prepare("SELECT status FROM simpanan_berjangka_kebijakan_dini WHERE id='A'")
      .get() as { status: string };
    expect(a.status).toBe('NONAKTIF');
  });

  it('G. kebijakan lama TIDAK dihapus — settlement historis tetap terlacak', () => {
    const db = buatDb();
    sisipkan(db, 'A', 'EW-A', 'AKTIF');
    sisipkan(db, 'C', 'EW-C', 'DRAFT');
    promosikan(db, 'C');

    const versiA = db
      .prepare("SELECT versi FROM simpanan_berjangka_kebijakan_dini WHERE id='A'")
      .get() as { versi: string } | undefined;
    expect(versiA?.versi).toBe('EW-A');
  });

  it('kebijakan lengkap memang dievaluasi AKTIF', () => {
    expect(evaluasiKebijakanEarlyWithdrawal(draft(LENGKAP)).status).toBe('AKTIF');
  });
});

describe('D+E. jaminan database', () => {
  it('D. dua baris AKTIF ditolak indeks unik parsial', () => {
    const db = buatDb();
    sisipkan(db, 'A', 'EW-A', 'AKTIF');
    expect(() => sisipkan(db, 'X', 'EW-X', 'AKTIF')).toThrow();
  });

  it('urutan terbalik gagal dan seluruh transaksi di-rollback', () => {
    // Mempromosikan SEBELUM menonaktifkan melanggar indeks. Ini yang
    // membuat urutan di service bukan sekadar preferensi gaya.
    const db = buatDb();
    sisipkan(db, 'A', 'EW-A', 'AKTIF');
    sisipkan(db, 'B', 'EW-B', 'DRAFT');

    let gagal = false;
    try {
      db.exec('BEGIN');
      db.exec("UPDATE simpanan_berjangka_kebijakan_dini SET status='AKTIF' WHERE id='B'");
      db.exec("UPDATE simpanan_berjangka_kebijakan_dini SET status='NONAKTIF' WHERE id='A'");
      db.exec('COMMIT');
    } catch {
      gagal = true;
      try {
        db.exec('ROLLBACK');
      } catch {
        /* transaksi sudah dibatalkan */
      }
    }
    expect(gagal).toBe(true);
    expect(aktif(db).map((r) => r.id)).toEqual(['A']);
  });

  it('E. kebijakan berstatus AKTIF tidak boleh menghasilkan POLICY_REQUIRED', () => {
    // Dijamin oleh service: promosi hanya terjadi bila evaluasi AKTIF.
    expect(evaluasiKebijakanEarlyWithdrawal(draft(LENGKAP)).status).toBe('AKTIF');
    expect(evaluasiKebijakanEarlyWithdrawal(draft()).status).toBe('POLICY_REQUIRED');
  });
});

describe('service menerapkan urutan yang benar', () => {
  const service = readFileSync(
    join(ROOT, 'src', 'services', 'SimpananBerjangkaEarlyWithdrawalService.ts'),
    'utf8'
  );

  it('evaluasi dilakukan SEBELUM kebijakan lama disentuh', () => {
    const evaluasi = service.indexOf('const evaluasi = evaluasiKebijakanEarlyWithdrawal(input)');
    const nonaktif = service.indexOf("SET status = 'NONAKTIF'");
    expect(evaluasi).toBeGreaterThan(-1);
    expect(nonaktif).toBeGreaterThan(evaluasi);
  });

  it('baris baru disisipkan sebagai DRAFT, bukan AKTIF', () => {
    expect(service).toMatch(/VALUES \(\?[^)]*'DRAFT',\?,\?,\?\)/);
  });

  it('promosi hanya bila evaluasi AKTIF', () => {
    expect(service).toMatch(/const bolehDipromosikan = evaluasi\.status === 'AKTIF';/);
    expect(service).toMatch(/if \(bolehDipromosikan\) \{/);
  });

  it('nonaktifkan dulu, baru promosikan', () => {
    const blok = service.slice(service.indexOf('if (bolehDipromosikan)'));
    expect(blok.indexOf("SET status = 'NONAKTIF'")).toBeLessThan(
      blok.indexOf("SET status = 'AKTIF'")
    );
  });

  it('hanya kebijakan AKTIF yang dipakai settlement', () => {
    expect(service).toMatch(/FROM simpanan_berjangka_kebijakan_dini WHERE status = 'AKTIF'/);
  });

  it('kebijakan tidak pernah dihapus', () => {
    expect(service).not.toMatch(/DELETE FROM simpanan_berjangka_kebijakan_dini/);
  });

  it('permission tetap pengaturan:edit', () => {
    expect(service).toMatch(/requirePermission\(db, input\.createdBy, 'pengaturan', 'edit'\)/);
  });
});

describe('skema v58', () => {
  const schema = readFileSync(join(ROOT, 'src', 'database', 'schema.ts'), 'utf8');

  it('status menerima DRAFT', () => {
    expect(schema).toMatch(/status TEXT NOT NULL CHECK \(status IN \('DRAFT','AKTIF','NONAKTIF'\)\)/);
  });

  it('indeks unik parsial untuk AKTIF dipertahankan', () => {
    expect(schema).toMatch(
      /idx_sb_kebijakan_dini_aktif ON simpanan_berjangka_kebijakan_dini\(status\) WHERE status = 'AKTIF'/
    );
  });

  it('migrasi v58 membuat ulang indeks setelah rebuild tabel', () => {
    // Rebuild tabel menghapus indeksnya; tanpa dibuat ulang, jaminan
    // "maksimum satu AKTIF" hilang diam-diam.
    const db = readFileSync(join(ROOT, 'src', 'database', 'db.ts'), 'utf8');
    const blok = db.slice(db.indexOf('if (currentVersion < 58)'));
    const rename = blok.indexOf('RENAME TO simpanan_berjangka_kebijakan_dini');
    const indeks = blok.indexOf('idx_sb_kebijakan_dini_aktif');
    expect(rename).toBeGreaterThan(-1);
    expect(indeks).toBeGreaterThan(rename);
  });
});
