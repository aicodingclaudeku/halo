import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

/**
 * RC-S67.7.6 — PEMBELIAN ASET SATU FORM (tanpa jalur kedua ke form aset).
 * DATABASE: SQLite nyata + AsetService asli (tidak diubah).
 */

let testDb: TestDb;

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

import { beliAset } from '@/services/AsetService';
import { buatPenjagaSubmit } from '@/utils/pembelianAsetForm';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const BERKAS = 'src/screens/Transaksi/PembelianAsetFormScreen.tsx';

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

const dasar = {
  namaAset: 'Laptop Kantor', jenisAset: 'TETAP' as const, nilaiPerolehan: 12_000_000, nilaiResidu: 2_000_000, masaManfaatBulan: 48,
  tanggal: '2026-02-01', metodePembayaran: 'TUNAI' as const, sumberDana: 'KAS' as const, createdBy: USER,
};
const hitung = async (sql: string) => (await testDb.getFirstAsync<{ n: number }>(sql))?.n ?? 0;
const jurnalAset = () => hitung(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi IN ('ASET_TETAP','ASET_TAK_BERWUJUD')`);

describe('RC-S67.7.6 — satu form, alur pasca-simpan bersih (struktural)', () => {
  const mentah = baca(BERKAS);
  const layar = strip(mentah);
  const panel = layar.slice(layar.indexOf('if (berhasil) {'), layar.indexOf('  return (\n    <AreaAmanKeyboard'));

  it('TEST 1 — setelah beliAset() berhasil: state berhasil → Success Summary (bukan form create aset)', () => {
    expect(layar).toContain('setBerhasil(ringkasan);');
    expect(panel).toContain('Pembelian Aset Berhasil');
    for (const k of ['Nama Aset', 'Nomor Aset', 'Nilai Perolehan', 'Nilai Residu', 'Masa Manfaat', 'Metode Pembayaran', "'Sumber Dana' : 'Pemasok'", 'Jurnal']) {
      expect(panel).toContain(k);
    }
  });

  it('TEST 2 — Success Summary: "Kembali ke Pengeluaran" ada dan merupakan SATU-SATUNYA aksi', () => {
    expect(panel).toContain('>Kembali ke Pengeluaran<');
    expect((panel.match(/<TouchableOpacity/g) ?? []).length).toBe(1);
    expect(panel).toContain('onPress={() => navigation.goBack()}');
    // Notifikasi sukses juga hanya satu tombol.
    expect(layar).toMatch(/notify\('Berhasil', 'Pembelian aset berhasil dicatat\.', \[\s*\{ text: 'Kembali ke Pengeluaran', onPress: \(\) => navigation\.goBack\(\) \},\s*\]\);/);
  });

  it('TEST 3 — tidak ada "Lihat Aset" / "Edit Aset" / "Masuk ke Aset Tetap" / "Buka Register Aset" (termasuk komentar)', () => {
    for (const t of ['Lihat Aset', 'Edit Aset', 'Masuk ke Aset Tetap', 'Buka Register Aset']) {
      expect(mentah).not.toContain(t);
    }
  });

  it('TEST 4 — referensi AsetEditForm di berkas Pembelian Aset = NONE (termasuk komentar)', () => {
    expect(mentah).not.toContain('AsetEditForm');
    expect(mentah).not.toMatch(/['"](AssetCreate|AsetForm|AssetDetail|AsetTetapForm)['"]/);
  });

  it('TEST 5 — seluruh project: tidak ada navigasi ke AsetEditForm yang berasal dari PembelianAsetFormScreen', () => {
    const pemanggil: string[] = [];
    const telusur = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) telusur(p);
        else if (/\.tsx?$/.test(f) && /(navigate|replace|push)\(\s*'AsetEditForm'/.test(strip(readFileSync(p, 'utf8')))) {
          pemanggil.push(relative(ROOT, p).replace(/\\/g, '/'));
        }
      }
    };
    telusur(join(ROOT, 'src', 'screens'));
    expect(pemanggil).not.toContain(BERKAS);
    // Modul Aset Tetap sendiri TETAP boleh membuka layar edit aset (tidak dihapus).
    expect(pemanggil).toContain('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx');
  });

  it('satu-satunya navigasi di layar Pembelian Aset adalah goBack; tanpa efek/listener navigasi', () => {
    expect(layar).not.toMatch(/navigation\.(navigate|replace|push|reset)\(/);
    expect(layar).not.toMatch(/useFocusEffect|addListener\(/);
    expect((layar.match(/beliAset\(/g) ?? []).length).toBe(1);
  });
});

describe('RC-S67.7.6 — transaksi (DATABASE, AsetService asli)', () => {
  it('TEST 6 — simpan sekali: 1 aset, 1 jurnal (Dr Aset 12 jt / Cr Kas 12 jt, perolehan penuh), residu tersimpan', async () => {
    const r = await beliAset(dasar);
    expect(await hitung(`SELECT COUNT(*) AS n FROM aset_tetap`)).toBe(1);
    expect(await jurnalAset()).toBe(1);
    const e = await testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
      `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id WHERE je.journal_id = ? ORDER BY je.debit DESC`, r.journalId
    );
    expect(e).toEqual([
      { kode: '1-1500', debit: 12_000_000, kredit: 0 },
      { kode: '1-1000', debit: 0, kredit: 12_000_000 },
    ]);
    expect(await hitung(`SELECT nilai_residu AS n FROM aset_tetap`)).toBe(2_000_000);
  });

  it('TEST 7 — Simpan x3 cepat lewat penjaga form: 1 aset, 1 jurnal', async () => {
    const penjaga = buatPenjagaSubmit();
    const kirim = () => penjaga.jalankan(() => beliAset(dasar));
    const hasil = await Promise.all([kirim(), kirim(), kirim()]);
    expect(hasil.filter((h) => h.status === 'OK')).toHaveLength(1);
    expect(await hitung(`SELECT COUNT(*) AS n FROM aset_tetap`)).toBe(1);
    expect(await jurnalAset()).toBe(1);
  });
});
