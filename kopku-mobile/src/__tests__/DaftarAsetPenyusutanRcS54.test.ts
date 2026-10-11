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

import { listAsetDenganNilaiBuku } from '@/services/AsetService';
import { hitungPenyusutanBulanan } from '@/services/PenyusutanService';

/**
 * RC-S54 item 7 — Daftar Aset Tetap menyajikan informasi penyusutan.
 *
 * Yang dijaga: angkanya berasal dari MESIN YANG SAMA dengan penjurnalan,
 * dan layar tidak menghitung apa pun sendiri.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

const NOW = new Date().toISOString();

async function seed(): Promise<void> {
  testDb = await createTestDb();
  await testDb.runAsync(
    `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, jenis_aset, tanggal_perolehan,
                             nilai_perolehan, nilai_residu, masa_manfaat_bulan, status,
                             metode_pembayaran, sumber, created_by, created_at, updated_at)
     VALUES ('a1','AST-001','Kendaraan Operasional','TETAP','2026-01-05',
             120000000, 20000000, 100, 'AKTIF','TUNAI','PEMBELIAN','user-1',?,?)`,
    NOW, NOW
  );
  await testDb.runAsync(
    `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, jenis_aset, tanggal_perolehan,
                             nilai_perolehan, nilai_residu, masa_manfaat_bulan, status,
                             metode_pembayaran, sumber, created_by, created_at, updated_at)
     VALUES ('a2','AST-002','Lisensi Perangkat Lunak','TAK_BERWUJUD','2026-01-05',
             24000000, 0, 24, 'AKTIF','TUNAI','PEMBELIAN','user-1',?,?)`,
    NOW, NOW
  );
}

async function seedPenyusutan(asetId: string, periode: string, nilai: number, n: string) {
  const tahun = Number(periode.slice(0, 4));
  await testDb.runAsync(
    `INSERT OR IGNORE INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES (?, ?, ?, ?, 'OPEN')`,
    `p${tahun}`, tahun, `${tahun}-01-01`, `${tahun}-12-31`
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, nomor_jurnal)
     VALUES (?, ?, ?, 'PENYUSUTAN_ASET','Penyusutan','POSTED','user-1',?,?,?)`,
    `j-${n}`, `${periode}-28`, `p${tahun}`, NOW, NOW, `JRN-${n}`
  );
  await testDb.runAsync(
    `INSERT INTO aset_penyusutan (id, aset_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
     VALUES (?,?,?,?,?,?,'user-1',?)`,
    `ap-${n}`, asetId, periode, `${periode}-28`, nilai, `j-${n}`, NOW
  );
}

describe('RC-S54 item 7 — informasi penyusutan pada Daftar Aset Tetap', () => {
  beforeEach(async () => {
    await seed();
  });

  it('TEST C — nilai perolehan & residu benar', async () => {
    const rows = await listAsetDenganNilaiBuku();
    const a1 = rows.find((r) => r.nomorAset === 'AST-001')!;
    expect(a1.nilaiPerolehan).toBe(120_000_000);
    expect(a1.nilaiResidu).toBe(20_000_000);
    expect(a1.masaManfaatBulan).toBe(100);
    expect(a1.tanggalPerolehan).toBe('2026-01-05');
  });

  it('TEST B — penyusutan per bulan tersedia & sama dengan mesin penjurnalan', async () => {
    const rows = await listAsetDenganNilaiBuku();
    const a1 = rows.find((r) => r.nomorAset === 'AST-001')!;
    // (120jt - 20jt) / 100 = 1jt
    expect(a1.penyusutanPerBulan).toBe(1_000_000);
    // Nilainya IDENTIK dengan kalkulator yang dipakai prosesPenyusutanAset.
    expect(a1.penyusutanPerBulan).toBe(
      hitungPenyusutanBulanan(a1.nilaiPerolehan, a1.nilaiResidu ?? 0, a1.masaManfaatBulan)
    );
  });

  it('TEST D & E — akumulasi dan nilai buku benar setelah tiga periode', async () => {
    await seedPenyusutan('a1', '2026-01', 1_000_000, '1');
    await seedPenyusutan('a1', '2026-02', 1_000_000, '2');
    await seedPenyusutan('a1', '2026-03', 1_000_000, '3');
    const rows = await listAsetDenganNilaiBuku();
    const a1 = rows.find((r) => r.nomorAset === 'AST-001')!;
    expect(a1.akumulasiPenyusutan).toBe(3_000_000);
    expect(a1.nilaiBuku).toBe(117_000_000);
  });

  it('TEST E — nilai buku tidak pernah turun di bawah nilai residu', async () => {
    for (let i = 1; i <= 100; i += 1) {
      await seedPenyusutan('a1', `20${26 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 1_000_000, `x${i}`);
    }
    const rows = await listAsetDenganNilaiBuku();
    const a1 = rows.find((r) => r.nomorAset === 'AST-001')!;
    expect(a1.nilaiBuku).toBeGreaterThanOrEqual(a1.nilaiResidu ?? 0);
  });

  it('TEST G — aset tak berwujud tetap AMORTISASI, bukan penyusutan', async () => {
    const rows = await listAsetDenganNilaiBuku();
    const a2 = rows.find((r) => r.nomorAset === 'AST-002')!;
    expect(a2.jenisAset).toBe('TAK_BERWUJUD');
    expect(a2.penyusutanPerBulan).toBe(1_000_000); // 24jt / 24
    const layar = baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx');
    expect(layar).toContain("'Amortisasi per Bulan'");
    expect(layar).toContain("'Akumulasi Amortisasi'");
  });

  it('TEST I — properti investasi TIDAK ikut ke daftar aset tetap', async () => {
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
      NOW, NOW
    );
    await testDb.runAsync(
      `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                              sumber_dana, status, created_by, created_at, updated_at)
       VALUES ('inv-1','INV-1','PROPERTI_INVESTASI','Ruko Mawar',500000000,'2026-01-05',
               'KAS','AKTIF','user-1',?,?)`,
      NOW, NOW
    );
    const rows = await listAsetDenganNilaiBuku();
    expect(rows.map((r) => r.nomorAset)).toEqual(['AST-001', 'AST-002']);
    expect(rows.some((r) => r.namaAset === 'Ruko Mawar')).toBe(false);
  });
});

describe('RC-S54 item 7 — layar tidak menghitung sendiri', () => {
  const layar = baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('TEST J — nol rumus penyusutan di UI', () => {
    expect(layar).not.toContain('hitungPenyusutanBulanan');
    expect(layar).not.toMatch(/nilaiPerolehan\s*-\s*nilaiResidu/);
    expect(layar).not.toMatch(/\/\s*masaManfaatBulan/);
    expect(layar).not.toContain('calculateDepreciation');
  });

  it('memakai formatter uang existing, bukan formatter kedua', () => {
    expect(layar).toContain("import { formatRupiah } from '@/utils/money';");
  });

  it('menampilkan seluruh informasi minimal yang diminta', () => {
    for (const label of [
      'Tanggal Perolehan', 'Nilai Perolehan', 'Masa Manfaat',
      'Nilai Residu', 'Nilai Buku',
    ]) {
      expect(layar).toContain(label);
    }
    expect(layar).toContain('per Bulan');
    expect(layar).toContain('item.nomorAset');
    expect(layar).toContain('item.namaAset');
  });

  it('TEST H — rute existing tidak rusak; Daftar Aset Tetap tetap entri aktif', () => {
    const menu = baca('src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx');
    expect((menu.match(/route: 'DaftarAsetTetap'/g) ?? [])).toHaveLength(1);
    const nav = baca('src/navigation/RootNavigator.tsx');
    expect((nav.match(/name="DaftarAsetTetap"/g) ?? [])).toHaveLength(1);
    expect((nav.match(/name="StatusPeriode"/g) ?? [])).toHaveLength(1);
  });
});
