import { readFileSync } from 'fs';
import { execSync } from 'child_process';
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

import { listAsetDenganNilaiBuku, AsetDenganNilaiBukuItem } from '@/services/AsetService';
import { prosesPenyusutanAset, jalankanPenyusutanPeriode } from '@/services/PenyusutanService';

/**
 * RC-S54 TAHAP 6 — ITEM #7 — FINALISASI
 * =========================================================================
 *
 * Suite Tahap 5 (`DaftarAsetPenyusutanRcS54`) membuktikan angka daftar
 * sama dengan FUNGSI `hitungPenyusutanBulanan()`, tetapi akumulasinya
 * diisi dengan INSERT manual ke `aset_penyusutan`. Suite ini menutup dua
 * celah §23 yang tersisa:
 *
 *   (5) hasil identik dengan ENGINE POSTING — jurnal dibuat oleh
 *       `prosesPenyusutanAset()` / `jalankanPenyusutanPeriode()` produksi,
 *       lalu daftar dibandingkan dengan `journal_entry` di database;
 *   (8) entri operasional "Penyusutan Aset" tetap ada dan tetap
 *       menjalankan `jalankanPenyusutanPeriode()`;
 *   (9) tidak ada mesin penyusutan kedua di jalur daftar aset.
 *
 * Tidak ada perubahan kode produksi untuk item ini.
 */

const ACC = {
  bebanPenyusutan: 'acc-beban-penyusutan',
  akumulasi: 'acc-akumulasi-penyusutan',
  bebanAmortisasi: 'acc-beban-amortisasi',
  akumulasiAmortisasi: 'acc-akumulasi-amortisasi',
};

const NOW = new Date().toISOString();

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  const akun: [string, string, string, string, 'DEBIT' | 'KREDIT'][] = [
    [ACC.bebanPenyusutan, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT'],
    [ACC.akumulasi, '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT'],
    [ACC.bebanAmortisasi, '5-1310', 'Beban Amortisasi', 'BEBAN', 'DEBIT'],
    [ACC.akumulasiAmortisasi, '1-1610', 'Akumulasi Amortisasi', 'ASET', 'KREDIT'],
  ];
  for (const [id, kode, nama, kategori, nb] of akun) {
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, nama, kategori, nb, NOW, NOW
    );
  }
  const mapping: [string, string, string][] = [
    ['PENYUSUTAN_ASET', 'DEBIT_BEBAN', ACC.bebanPenyusutan],
    ['PENYUSUTAN_ASET', 'KREDIT_AKUMULASI', ACC.akumulasi],
    ['AMORTISASI_ASET_TAK_BERWUJUD', 'DEBIT_BEBAN', ACC.bebanAmortisasi],
    ['AMORTISASI_ASET_TAK_BERWUJUD', 'KREDIT_AKUMULASI', ACC.akumulasiAmortisasi],
  ];
  for (const [t, r, a] of mapping) {
    await db.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-${t}-${r}`, t, r, a
    );
  }
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    NOW, NOW
  );
  return db;
}

async function seedAset(
  id: string,
  nama: string,
  perolehan: number,
  residu: number,
  masa: number,
  jenis: 'TETAP' | 'TAK_BERWUJUD' = 'TETAP'
): Promise<void> {
  await testDb.runAsync(
    `INSERT INTO aset_tetap
      (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan,
       metode_pembayaran, sumber, created_by, created_at, jenis_aset)
     VALUES (?,?,?,?,?,?,'2026-01-05','TUNAI','PEMBELIAN','user-1',?,?)`,
    id, `AST-${id}`, nama, perolehan, residu, masa, NOW, jenis
  );
}

/** Kredit akumulasi yang BENAR-BENAR dijurnal untuk satu aset. */
async function kreditAkumulasiGl(asetId: string, akunAkumulasi: string): Promise<number[]> {
  const rows = await testDb.getAllAsync<{ kredit: number }>(
    `SELECT je.kredit
       FROM aset_penyusutan ap
       JOIN journal j ON j.id = ap.journal_id
       JOIN journal_entry je ON je.journal_id = j.id AND je.account_id = ?
      WHERE ap.aset_id = ? AND j.status = 'POSTED'
      ORDER BY ap.periode`,
    akunAkumulasi,
    asetId
  );
  return rows.map((r) => r.kredit);
}

async function barisDaftar(asetId: string): Promise<AsetDenganNilaiBukuItem> {
  const rows = await listAsetDenganNilaiBuku();
  const r = rows.find((x) => x.id === asetId);
  if (!r) throw new Error(`aset ${asetId} tidak ada di daftar`);
  return r;
}

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

function tanpaKomentar(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('ITEM #7 (5) — daftar aset IDENTIK dengan engine posting (jurnal nyata)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  it('penyusutan/bulan = nominal jurnal; akumulasi = total kredit GL; nilai buku = perolehan - GL', async () => {
    await seedAset('k1', 'Kendaraan', 120_000_000, 20_000_000, 100);
    for (const periode of ['2026-01', '2026-02', '2026-03']) {
      const h = await prosesPenyusutanAset({ asetId: 'k1', periode, createdBy: 'user-1' });
      expect(h.dibuat).toBe(true);
    }

    const kredit = await kreditAkumulasiGl('k1', ACC.akumulasi);
    expect(kredit).toHaveLength(3);
    const r = await barisDaftar('k1');

    for (const k of kredit) expect(r.penyusutanPerBulan).toBe(k);
    const totalGl = kredit.reduce((t, x) => t + x, 0);
    expect(r.akumulasiPenyusutan).toBe(totalGl);
    expect(r.nilaiBuku).toBe(r.nilaiPerolehan - totalGl);
    expect(r.nilaiResidu).toBe(20_000_000);
    expect(r.nilaiBuku).toBe(117_000_000);
  });

  it('jalur operasional jalankanPenyusutanPeriode() menghasilkan angka yang sama dengan daftar', async () => {
    await seedAset('k2', 'Mesin Fotokopi', 36_000_000, 0, 36);
    const batch = await jalankanPenyusutanPeriode('2026-02', 'user-1');
    expect(batch.diproses.map((x) => x.asetId)).toEqual(['k2']);

    const r = await barisDaftar('k2');
    expect(r.penyusutanPerBulan).toBe(batch.diproses[0].nilaiPenyusutan);
    expect(r.akumulasiPenyusutan).toBe(batch.diproses[0].nilaiPenyusutan);
    expect(r.nilaiBuku).toBe(36_000_000 - 1_000_000);
  });

  it('pembulatan: bulan terakhir di-cap engine; nilai buku dari GL tepat = residu, bukan hasil clamp tampilan', async () => {
    // dasar 200 / 3 bulan -> 67 per bulan; engine membatasi bulan ke-3 menjadi 66.
    await seedAset('k3', 'Aset Kecil', 1_200, 1_000, 3);
    for (const periode of ['2026-01', '2026-02', '2026-03']) {
      await prosesPenyusutanAset({ asetId: 'k3', periode, createdBy: 'user-1' });
    }
    const kredit = await kreditAkumulasiGl('k3', ACC.akumulasi);
    expect(kredit).toEqual([67, 67, 66]);

    const r = await barisDaftar('k3');
    // Tarif bulanan yang ditampilkan = tarif reguler engine.
    expect(r.penyusutanPerBulan).toBe(67);
    // Nilai buku mentah dari GL SUDAH sama dengan residu — tidak
    // bergantung pada Math.max() di service.
    expect(r.nilaiPerolehan - r.akumulasiPenyusutan).toBe(r.nilaiResidu);
    expect(r.nilaiBuku).toBe(1_000);
  });

  it('aset tak berwujud: dijurnal ke akun AMORTISASI, daftar menandainya TAK_BERWUJUD dengan angka yang sama', async () => {
    await seedAset('t1', 'Lisensi Perangkat Lunak', 24_000_000, 0, 24, 'TAK_BERWUJUD');
    await prosesPenyusutanAset({ asetId: 't1', periode: '2026-01', createdBy: 'user-1' });

    expect(await kreditAkumulasiGl('t1', ACC.akumulasiAmortisasi)).toEqual([1_000_000]);
    expect(await kreditAkumulasiGl('t1', ACC.akumulasi)).toEqual([]);

    const r = await barisDaftar('t1');
    expect(r.jenisAset).toBe('TAK_BERWUJUD');
    expect(r.penyusutanPerBulan).toBe(1_000_000);
    expect(r.akumulasiPenyusutan).toBe(1_000_000);
    expect(r.nilaiBuku).toBe(23_000_000);
  });

  it('properti investasi (tabel investasi) tidak pernah muncul walau ada data penyusutannya', async () => {
    await seedAset('k4', 'Gedung Kantor', 60_000_000, 0, 60);
    await testDb.runAsync(
      `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal,
                              sumber_dana, status, created_by, created_at, updated_at)
       VALUES ('inv-1','INV-1','PROPERTI_INVESTASI','Ruko Mawar',500000000,'2026-01-05',
               'KAS','AKTIF','user-1',?,?)`,
      NOW, NOW
    );
    const rows = await listAsetDenganNilaiBuku();
    expect(rows.map((x) => x.id)).toEqual(['k4']);
    expect(rows.some((x) => x.namaAset === 'Ruko Mawar' || x.id === 'inv-1')).toBe(false);
  });
});

describe('ITEM #7 (1) — sembilan field requirement tampil di layar', () => {
  const layar = tanpaKomentar(baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx'));

  it.each([
    ['Nama Aset', 'item.namaAset'],
    ['Nomor Aset', 'item.nomorAset'],
    ['Tanggal Perolehan', 'item.tanggalPerolehan'],
    ['Nilai Perolehan', 'item.nilaiPerolehan'],
    ['Masa Manfaat', 'item.masaManfaatBulan'],
    ['Nilai Residu', 'item.nilaiResidu'],
    ['Penyusutan per Bulan', 'item.penyusutanPerBulan'],
    ['Akumulasi Penyusutan', 'item.akumulasiPenyusutan'],
    ['Nilai Buku', 'item.nilaiBuku'],
  ])('%s dirender dari %s', (_label, binding) => {
    expect(layar).toContain(binding);
  });

  it('label teks penyusutan & amortisasi keduanya ada, dipilih oleh jenisAset', () => {
    expect(layar).toContain("'Penyusutan per Bulan'");
    expect(layar).toContain("'Amortisasi per Bulan'");
    expect(layar).toContain("'Akumulasi Penyusutan'");
    expect(layar).toContain("'Akumulasi Amortisasi'");
    expect(layar).toMatch(/item\.jenisAset === 'TAK_BERWUJUD' \? 'Amortisasi per Bulan' : 'Penyusutan per Bulan'/);
  });
});

describe('ITEM #7 (8) — entri operasional "Penyusutan Aset" dipertahankan', () => {
  it('satu entri gabungan aset tetap + penyusutan; fungsi penyusutan tetap dijangkau', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #7 (permintaan pengguna): entri "Daftar Aset Tetap" + "Penyusutan Aset" DIGABUNG jadi satu entri; rute StatusPeriode tetap ada & dijangkau dari layar gabungan.
    const menu = tanpaKomentar(baca('src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx'));
    const layar = tanpaKomentar(baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx'));
    expect((menu.match(/title: 'Penyusutan Aset',/g) ?? [])).toHaveLength(0);
    expect((menu.match(/title: 'Daftar Aset Tetap & Penyusutan',/g) ?? [])).toHaveLength(1);
    expect(layar).toMatch(/navigation\.navigate\('StatusPeriode'\)/);
    expect((menu.match(/route: 'DaftarAsetTetap'/g) ?? [])).toHaveLength(1);
    // DIPERBARUI Poin 7: entri Penyusutan Properti Investasi pindah ke Transaksi > Penyesuaian (tetap tepat satu pintu masuk).
    expect((menu.match(/route: 'PenyusutanPropertiInvestasi'/g) ?? [])).toHaveLength(0);
    const penyesuaian = tanpaKomentar(baca('src/screens/Transaksi/PenyesuaianScreen.tsx'));
    expect((penyesuaian.match(/route: 'PenyusutanPropertiInvestasi'/g) ?? [])).toHaveLength(1);
  });

  it('layar tujuan benar-benar menjalankan jalankanPenyusutanPeriode() dan setModePenyusutan()', () => {
    const layar = tanpaKomentar(baca('src/screens/Akuntansi/StatusPeriodeScreen.tsx'));
    expect(layar).toMatch(/await jalankanPenyusutanPeriode\(periode, currentUser\.id\)/);
    expect(layar).toMatch(/await setModePenyusutan\(/);
    const nav = baca('src/navigation/RootNavigator.tsx');
    expect((nav.match(/name="StatusPeriode" component=\{StatusPeriodeScreen\}/g) ?? [])).toHaveLength(1);
  });
});

describe('ITEM #7 (9) — tidak ada mesin penyusutan kedua', () => {
  it('AsetService mengambil tarif dari PenyusutanService dan tidak menulis rumusnya sendiri', () => {
    const svc = tanpaKomentar(baca('src/services/AsetService.ts'));
    // DIPERBARUI RC-S88: AsetService juga mengambil dasar penyusutan setelah revaluasi
    // dari PenyusutanService (mesin yang SAMA), bukan rumus sendiri.
    expect(svc).toMatch(/import \{ hitungPenyusutanBulanan[^}]*\} from '@\/services\/PenyusutanService';/);
    expect(svc).toContain('getDasarPenyusutanAsetPadaDb(db, r)');
    expect(svc).not.toMatch(/export function hitungPenyusutanBulanan/);
    expect(svc).not.toMatch(/\/\s*r\.masa_manfaat_bulan/);
    expect(svc).not.toMatch(/\/\s*masaManfaatBulan/);
  });

  it('definisi hitungPenyusutanBulanan hanya ada SATU di seluruh src/', () => {
    const root = join(__dirname, '..');
    const hasil = execSync(
      `grep -rlE "function hitungPenyusutanBulanan" --include=*.ts --include=*.tsx ${root} | grep -v __tests__ || true`,
      { encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean)
      .map((p) => p.slice(root.length + 1));
    expect(hasil).toEqual(['services/PenyusutanService.ts']);
  });
});
