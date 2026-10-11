import { readFileSync } from 'fs';
import { join } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, snapshotTabel, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

/**
 * RC-S67.7.2 — PEMBELIAN ASET: Nilai Residu + alur setelah simpan.
 * DATABASE: SQLite nyata + COA lengkap; AsetService/PenyusutanService ASLI
 * (tidak diubah RC ini — sudah mendukung & memvalidasi nilai residu).
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

import { beliAset, getAsetById, listAsetDenganNilaiBuku } from '@/services/AsetService';
import { hitungPenyusutanBulanan, prosesPenyusutanAset } from '@/services/PenyusutanService';
import { validasiNilaiResidu, pratinjauNilaiDisusutkan, nilaiResiduUntukDisimpan, labelMasaManfaat, efekJurnalPembelian } from '@/utils/pembelianAsetForm';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TABEL = ['aset_tetap', 'journal', 'journal_entry', 'utang', 'audit_log'];

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

const dasar = {
  namaAset: 'Mesin Fotokopi', jenisAset: 'TETAP' as const, nilaiPerolehan: 100_000_000, masaManfaatBulan: 60,
  tanggal: '2026-03-01', metodePembayaran: 'TUNAI' as const, sumberDana: 'KAS' as const, createdBy: USER,
};

async function entri(journalId: string) {
  return testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
    `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id WHERE je.journal_id = ? ORDER BY je.debit DESC`, journalId
  );
}

async function ditolak(input: Record<string, unknown>, pesan: RegExp) {
  const awal = await snapshotTabel(testDb, TABEL);
  let err: any;
  try {
    await beliAset(input as never);
  } catch (e) {
    err = e;
  }
  expect(String(err?.message)).toMatch(pesan);
  expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
}

describe('RC-S67.7.2 — pembelian aset (DATABASE)', () => {
  it('TEST 1 — tunai tanpa residu: Dr Aset / Cr Kas; nilai_residu = 0', async () => {
    const r = await beliAset({ ...dasar, nilaiResidu: nilaiResiduUntukDisimpan('') });
    expect(await entri(r.journalId)).toEqual([
      { kode: '1-1500', debit: 100_000_000, kredit: 0 },
      { kode: '1-1000', debit: 0, kredit: 100_000_000 },
    ]);
    expect((await getAsetById(r.id))?.nilaiResidu).toBe(0);
  });

  it('TEST 2 — tunai dengan residu 10 jt: tersimpan persis; dasar penyusutan 90 jt; penyusutan bulanan 1,5 jt', async () => {
    const r = await beliAset({ ...dasar, nilaiResidu: 10_000_000 });
    const row = await testDb.getFirstAsync<{ nilai_residu: number; nilai_perolehan: number }>(`SELECT nilai_residu, nilai_perolehan FROM aset_tetap WHERE id = ?`, r.id);
    expect(row).toEqual({ nilai_residu: 10_000_000, nilai_perolehan: 100_000_000 });
    expect(hitungPenyusutanBulanan(100_000_000, 10_000_000, 60)).toBe(1_500_000);
    expect(pratinjauNilaiDisusutkan(100_000_000, 10_000_000)).toBe(90_000_000);
    await prosesPenyusutanAset({ asetId: r.id, periode: '2026-03', createdBy: USER });
    const susut = await testDb.getFirstAsync<{ n: number }>(`SELECT SUM(nilai_penyusutan) AS n FROM aset_penyusutan WHERE aset_id = ?`, r.id);
    expect(susut?.n).toBe(1_500_000);
    const it = (await listAsetDenganNilaiBuku()).find((a) => a.id === r.id)!;
    expect(it.penyusutanPerBulan).toBe(1_500_000);
  });

  it('TEST 3 — kredit dengan residu: Dr Aset / Cr Utang Usaha; utang terbentuk; tidak ada kas keluar', async () => {
    const r = await beliAset({ ...dasar, metodePembayaran: 'KREDIT', sumberDana: undefined, namaPemasok: 'CV Pemasok', nilaiResidu: 5_000_000 });
    const e = await entri(r.journalId);
    expect(e).toEqual([
      { kode: '1-1500', debit: 100_000_000, kredit: 0 },
      { kode: '2-1000', debit: 0, kredit: 100_000_000 },
    ]);
    expect(e.some((x) => x.kode === '1-1000' || x.kode === '1-1100')).toBe(false);
    const u = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM utang WHERE jenis_pemberi = 'UTANG_USAHA' AND pokok_pinjaman = 100000000`);
    expect(u?.n).toBe(1);
    expect((await getAsetById(r.id))?.nilaiResidu).toBe(5_000_000);
  });

  it('TEST 4 — residu > perolehan DITOLAK: tanpa jurnal, aset, utang', async () => {
    await ditolak({ ...dasar, nilaiPerolehan: 10_000_000, nilaiResidu: 15_000_000 }, /Nilai residu harus lebih kecil/);
    await ditolak({ ...dasar, metodePembayaran: 'KREDIT', sumberDana: undefined, namaPemasok: 'CV X', nilaiPerolehan: 10_000_000, nilaiResidu: 15_000_000 }, /Nilai residu/);
  });

  it('TEST 5 — residu negatif DITOLAK; residu = perolehan DITOLAK (aturan service existing)', async () => {
    await ditolak({ ...dasar, nilaiResidu: -1 }, /Nilai residu tidak boleh negatif/);
    await ditolak({ ...dasar, nilaiResidu: 100_000_000 }, /Nilai residu harus lebih kecil/);
  });

  it('TEST 8 — hasil pembelian mengembalikan assetId valid (aset terdaftar, satu baris, satu jurnal)', async () => {
    const r = await beliAset({ ...dasar, nilaiResidu: 0 });
    expect(typeof r.id).toBe('string');
    expect((await getAsetById(r.id))?.namaAset).toBe('Mesin Fotokopi');
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM aset_tetap`))?.n).toBe(1);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE id = ?`, r.journalId))?.n).toBe(1);
  });

  it('TEST 10 — aset lama tanpa nilai residu: fallback 0 (kolom NOT NULL DEFAULT 0)', async () => {
    const r = await beliAset({ ...dasar });
    await testDb.runAsync(
      `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, nilai_perolehan, masa_manfaat_bulan, tanggal_perolehan, metode_pembayaran, sumber, created_by, created_at)
       VALUES ('aset-lama','AST-LAMA','Aset Lama',5000000,12,'2026-01-01','TUNAI','PEMBELIAN',?,?)`,
      USER, new Date().toISOString()
    );
    expect((await getAsetById('aset-lama'))?.nilaiResidu).toBe(0);
    expect((await getAsetById(r.id))?.nilaiResidu).toBe(0);
  });
});

describe('RC-S67.7.2 — validasi & ringkasan (helper UX)', () => {
  it('pesan validasi nilai residu', () => {
    expect(validasiNilaiResidu(100, '')).toBeUndefined();
    expect(validasiNilaiResidu(100, 10)).toBeUndefined();
    expect(validasiNilaiResidu(100, -1)).toBe('Nilai residu tidak boleh negatif.');
    expect(validasiNilaiResidu(100, 150)).toBe('Nilai residu tidak boleh lebih besar dari nilai perolehan.');
    expect(validasiNilaiResidu(100, 100)).toMatch(/harus lebih kecil dari nilai perolehan/);
    expect(validasiNilaiResidu(100, 10.5)).toBe('Nilai residu harus berupa angka rupiah.');
  });
  it('kosong = 0 (tidak pernah undefined/null); pratinjau nilai disusutkan', () => {
    expect(nilaiResiduUntukDisimpan('')).toBe(0);
    expect(pratinjauNilaiDisusutkan(100_000_000, 10_000_000)).toBe(90_000_000);
    expect(pratinjauNilaiDisusutkan('', 10)).toBeNull();
    expect(pratinjauNilaiDisusutkan(100, 150)).toBeNull();
  });
  it('ringkasan: masa manfaat & efek jurnal mengikuti semantik existing', () => {
    expect(labelMasaManfaat(60)).toBe('60 bulan (5 tahun)');
    expect(labelMasaManfaat(18)).toBe('18 bulan (1 tahun 6 bulan)');
    expect(efekJurnalPembelian('TUNAI')).toBe('Aset bertambah · Kas/Bank berkurang');
    expect(efekJurnalPembelian('KREDIT')).toBe('Aset bertambah · Utang Usaha bertambah');
  });
});

describe('RC-S67.7.2 — layar & alur setelah simpan (struktural)', () => {
  const layar = strip(baca('src/screens/Transaksi/PembelianAsetFormScreen.tsx'));
  const edit = strip(baca('src/screens/Transaksi/AsetEditFormScreen.tsx'));

  it('field Nilai Residu ada, placeholder, dikirim ke service (kosong = 0)', () => {
    expect(layar).toContain('>Nilai Residu</Text>');
    expect(layar).toContain('placeholder="Masukkan nilai residu"');
    expect(layar).toContain('nilaiResidu: residu,');
    expect(layar).toContain('const residu = nilaiResiduUntukDisimpan(nilaiResidu);');
    // RC-S67.7.3: label ringkasan menjadi "Dasar Penyusutan".
    expect(layar).toContain('label="Dasar Penyusutan"');
  });

  // RC-S67.7.3: logika kunci dipindah ke helper `buatPenjagaSubmit` (diuji
  // perilakunya di PembelianAsetRcS67_7_3); di sini hanya pemakaiannya.
  it('TEST 6 — dobel submit: penjaga sinkron + kunci permanen setelah berhasil; gagal → boleh coba lagi', () => {
    expect(layar).toContain('const submitInFlightRef = useRef(buatPenjagaSubmit());');
    expect(layar).toContain('if (submitInFlightRef.current.terkunci || berhasil) return;');
    expect(layar).toContain('await submitInFlightRef.current.jalankan(() => beliAset({');
    expect(layar).toContain("if (hasilSubmit.status === 'DIABAIKAN') return;");
    expect(layar).toContain('if (berhasil) {');
  });

  // RC-S67.7.6: aksi "Lihat Aset" DIHAPUS dari alur Pembelian Aset (satu form).
  // TEST 7 & 9 diselaraskan — kini menjamin TIDAK ada jalur ke form aset.
  it('TEST 7 — setelah berhasil TIDAK membuka form Aset Tetap; hanya "Kembali ke Pengeluaran"', () => {
    expect(layar).not.toContain('AsetEditForm');
    expect(layar).not.toContain('Lihat Aset');
    expect(layar).toMatch(/text: 'Kembali ke Pengeluaran', onPress: \(\) => navigation\.goBack\(\)/);
    expect(layar).not.toMatch(/navigate\(|replace\(/);
    expect(layar).not.toMatch(/useFocusEffect|addListener\(/);
  });

  it('TEST 9 — layar edit aset (modul Aset Tetap) tetap mode EDIT & tidak membuat aset; tidak dipanggil dari Pembelian Aset', () => {
    expect(edit).toContain('const { asetId } = route.params ?? {};');
    expect(edit).toContain('getAsetById(asetId)');
    expect(edit).not.toMatch(/beliAset\(|catatAsetTetapDariModalBarang\(/);
    expect(layar).not.toContain('AsetEditForm');
  });

  it('ganti jenis aset mereset klasifikasi & masa manfaat otomatis; klasifikasi kosong tidak crash', () => {
    expect(layar).toMatch(/const gantiJenisAset = [\s\S]*?setKelompokAset\(''\);\s*setSubKelompokAset\(''\);/);
    expect(layar).toContain("onPress={() => gantiJenisAset('TAK_BERWUJUD')}");
    expect(layar).toContain('Klasifikasi aset belum tersedia.');
  });
});
