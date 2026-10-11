import { readFileSync } from 'fs';
import { join } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, snapshotTabel, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

/**
 * RC-S67.7.3 — FINAL HARDENING PEMBELIAN ASET (TEST A–J).
 * DATABASE: SQLite nyata + COA lengkap; AsetService/PenyusutanService ASLI.
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
import { prosesPenyusutanAset } from '@/services/PenyusutanService';
import { buatPenjagaSubmit, pratinjauNilaiDisusutkan } from '@/utils/pembelianAsetForm';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TABEL = ['aset_tetap', 'journal', 'journal_entry', 'utang'];

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

const dasar = {
  namaAset: 'Kendaraan Operasional', jenisAset: 'TETAP' as const, nilaiPerolehan: 100_000_000, nilaiResidu: 0, masaManfaatBulan: 60,
  tanggal: '2025-01-01', metodePembayaran: 'TUNAI' as const, sumberDana: 'KAS' as const, createdBy: USER,
};
const hitung = async (sql: string, ...p: unknown[]) => (await testDb.getFirstAsync<{ n: number }>(sql, ...(p as any[])))?.n ?? 0;
async function entri(journalId: string) {
  return testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
    `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id WHERE je.journal_id = ? ORDER BY je.debit DESC`, journalId
  );
}
const jurnalAset = () => hitung(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi IN ('ASET_TETAP','ASET_TAK_BERWUJUD')`);

describe('RC-S67.7.3 — accounting & nilai residu (DATABASE)', () => {
  it('TEST A — tunai, residu 0: 1 aset, 1 jurnal, Dr Aset 100 jt / Cr Kas 100 jt', async () => {
    const r = await beliAset(dasar);
    expect(await hitung(`SELECT COUNT(*) AS n FROM aset_tetap`)).toBe(1);
    expect(await jurnalAset()).toBe(1);
    expect(await entri(r.journalId)).toEqual([
      { kode: '1-1500', debit: 100_000_000, kredit: 0 },
      { kode: '1-1000', debit: 0, kredit: 100_000_000 },
    ]);
  });

  it('TEST B — tunai + residu 10 jt: residu tersimpan, dasar 90 jt, penyusutan tahunan 18 jt; jurnal perolehan tetap 100 jt PENUH', async () => {
    const r = await beliAset({ ...dasar, nilaiResidu: 10_000_000 });
    expect((await getAsetById(r.id))?.nilaiResidu).toBe(10_000_000);
    expect(pratinjauNilaiDisusutkan(100_000_000, 10_000_000)).toBe(90_000_000);
    // Jurnal perolehan memakai NILAI PEROLEHAN, bukan perolehan - residu.
    expect(await entri(r.journalId)).toEqual([
      { kode: '1-1500', debit: 100_000_000, kredit: 0 },
      { kode: '1-1000', debit: 0, kredit: 100_000_000 },
    ]);
    for (let m = 1; m <= 12; m++) {
      await prosesPenyusutanAset({ asetId: r.id, periode: `2025-${String(m).padStart(2, '0')}`, createdBy: USER });
    }
    expect(await hitung(`SELECT SUM(nilai_penyusutan) AS n FROM aset_penyusutan WHERE aset_id = ?`, r.id)).toBe(18_000_000);
    const it = (await listAsetDenganNilaiBuku()).find((a) => a.id === r.id)!;
    expect(it.nilaiBuku).toBe(82_000_000);
  });

  it('TEST C — kredit: Dr Aset / Cr Utang Usaha 2-1000; utang terbentuk; tanpa arus kas', async () => {
    const r = await beliAset({ ...dasar, metodePembayaran: 'KREDIT', sumberDana: undefined, namaPemasok: 'PT Pemasok', nilaiResidu: 10_000_000 });
    const e = await entri(r.journalId);
    expect(e).toEqual([
      { kode: '1-1500', debit: 100_000_000, kredit: 0 },
      { kode: '2-1000', debit: 0, kredit: 100_000_000 },
    ]);
    expect(e.some((x) => x.kode === '1-1000' || x.kode === '1-1100')).toBe(false);
    expect(await hitung(`SELECT COUNT(*) AS n FROM utang WHERE jenis_pemberi = 'UTANG_USAHA'`)).toBe(1);
  });

  it('TEST D — residu negatif: REJECT tanpa aset/jurnal/utang/kas', async () => {
    const awal = await snapshotTabel(testDb, TABEL);
    await expect_reject(() => beliAset({ ...dasar, nilaiResidu: -1 }), /tidak boleh negatif/);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
  });

  it('TEST E — residu > perolehan: REJECT; residu = perolehan juga REJECT (kebijakan service existing, Kondisi B)', async () => {
    const awal = await snapshotTabel(testDb, TABEL);
    await expect_reject(() => beliAset({ ...dasar, nilaiResidu: 150_000_000 }), /harus lebih kecil/);
    await expect_reject(() => beliAset({ ...dasar, nilaiResidu: 100_000_000 }), /harus lebih kecil/);
    await expect_reject(() => beliAset({ ...dasar, metodePembayaran: 'KREDIT', sumberDana: undefined, namaPemasok: 'X', nilaiResidu: 150_000_000 }), /harus lebih kecil/);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
    // Kondisi B dibuktikan dari source: service menolak residu >= perolehan secara eksplisit.
    expect(baca('src/services/AsetService.ts')).toContain('if (nilaiResidu >= nilaiPerolehan) {');
  });

  it('TEST J — aset lama tanpa nilai residu: terbaca (0), tanpa crash di detail & daftar nilai buku', async () => {
    await testDb.runAsync(
      `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, nilai_perolehan, masa_manfaat_bulan, tanggal_perolehan, metode_pembayaran, sumber, created_by, created_at)
       VALUES ('lama','AST-LAMA','Meja Lama',6000000,12,'2025-01-01','TUNAI','PEMBELIAN',?,?)`,
      USER, new Date().toISOString()
    );
    expect((await getAsetById('lama'))?.nilaiResidu).toBe(0);
    expect((await listAsetDenganNilaiBuku()).find((a) => a.id === 'lama')?.nilaiResidu).toBe(0);
  });
});

async function expect_reject(fn: () => Promise<unknown>, pesan: RegExp) {
  let err: any;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(String(err?.message)).toMatch(pesan);
}

describe('RC-S67.7.3 — dobel submit & retry (penjaga + service nyata)', () => {
  it('TEST F — Simpan x3 cepat: 1 panggilan beliAset → 1 aset, 1 jurnal; dua lainnya DIABAIKAN', async () => {
    const penjaga = buatPenjagaSubmit();
    let panggilan = 0;
    const kirim = () => penjaga.jalankan(() => { panggilan++; return beliAset(dasar); });
    const hasil = await Promise.all([kirim(), kirim(), kirim()]);
    expect(panggilan).toBe(1);
    expect(hasil.filter((h) => h.status === 'OK')).toHaveLength(1);
    expect(hasil.filter((h) => h.status === 'DIABAIKAN')).toHaveLength(2);
    expect(await hitung(`SELECT COUNT(*) AS n FROM aset_tetap`)).toBe(1);
    expect(await jurnalAset()).toBe(1);
  });

  it('TEST I — setelah berhasil penjaga terkunci permanen: submit berikutnya (mis. setelah back/tap lagi) DIABAIKAN', async () => {
    const penjaga = buatPenjagaSubmit();
    await penjaga.jalankan(() => beliAset(dasar));
    expect(penjaga.terkunci).toBe(true);
    expect((await penjaga.jalankan(() => beliAset(dasar))).status).toBe('DIABAIKAN');
    expect(await hitung(`SELECT COUNT(*) AS n FROM aset_tetap`)).toBe(1);
    expect(await jurnalAset()).toBe(1);
  });

  it('gagal → kunci dilepas → retry berhasil; kegagalan tidak meninggalkan data parsial', async () => {
    const penjaga = buatPenjagaSubmit();
    let err: unknown;
    try {
      await penjaga.jalankan(() => beliAset({ ...dasar, nilaiResidu: -5 }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(penjaga.terkunci).toBe(false);
    expect(await hitung(`SELECT COUNT(*) AS n FROM aset_tetap`)).toBe(0);
    expect((await penjaga.jalankan(() => beliAset(dasar))).status).toBe('OK');
    expect(await hitung(`SELECT COUNT(*) AS n FROM aset_tetap`)).toBe(1);
    expect(await jurnalAset()).toBe(1);
  });
});

describe('RC-S67.7.3 — layar (struktural)', () => {
  const layar = strip(baca('src/screens/Transaksi/PembelianAsetFormScreen.tsx'));
  const edit = strip(baca('src/screens/Transaksi/AsetEditFormScreen.tsx'));

  it('urutan form: Informasi Aset → Nilai Aset → Penyusutan (+Metode, Ringkasan) → Pembayaran → Transaksi', () => {
    const urut = ['>Informasi Aset<', '>Jenis Aset *<', '>Nama Aset *<', '>Kelompok Aset<', '>Nilai Aset<', '>Nilai Perolehan *<', '>Nilai Residu<',
      '>Penyusutan<', 'Masa Manfaat (bulan', '>Metode Penyusutan<', '>Ringkasan Penyusutan<', 'label="Dasar Penyusutan"', 'label="Masa Manfaat"',
      '>Pembayaran<', '>Metode Pembayaran<', '>Transaksi<', '>Tanggal Transaksi *<', 'Simpan Pembelian'];
    let pos = -1;
    for (const u of urut) {
      const i = layar.indexOf(u, pos + 1);
      expect(i).toBeGreaterThan(pos);
      pos = i;
    }
  });

  it('TEST G — setelah berhasil: panel ringkasan, TIDAK ada navigasi otomatis ke form aset', () => {
    expect(layar).toContain('Pembelian Aset Berhasil');
    expect(layar).toContain('if (berhasil) {');
    const sukses = layar.slice(layar.indexOf("if (hasilSubmit.status === 'DIABAIKAN') return;"), layar.indexOf('} catch (e) {'));
    // Di jalur sukses hanya ada notify dengan tombol; tidak ada navigate/replace yang langsung dieksekusi.
    expect(sukses.replace(/onPress: \(\) => navigation\.[a-zA-Z]+\([^)]*\)/g, '')).not.toMatch(/navigation\./);
    expect(layar).not.toMatch(/useFocusEffect|addListener\(/);
    for (const k of ['label="Nama Aset"', 'label="Nomor Aset"', 'label="Nilai Perolehan"', 'label="Nilai Residu"', 'label="Masa Manfaat"', 'label="Metode Pembayaran"', "'Sumber Dana' : 'Pemasok'"]) {
      expect(layar).toContain(k);
    }
    expect(layar).toContain('>Kembali ke Pengeluaran<');
    // RC-S67.7.6: aksi "Lihat Aset" dihapus (satu form).
    expect(layar).not.toContain('Lihat Aset');
  });

  // RC-S67.7.6: jalur "Lihat Aset" dihapus; TEST H kini menjamin tidak ada
  // navigasi ke layar aset dari Pembelian Aset, dan layar edit aset (dipakai
  // modul Aset Tetap sendiri) tetap mode EDIT tanpa create.
  it('TEST H — tidak ada navigasi ke AsetEditForm dari Pembelian Aset; layar edit aset tetap EDIT tanpa create', () => {
    expect(layar).not.toContain('AsetEditForm');
    expect(edit).toContain('const { asetId } = route.params ?? {};');
    expect(edit).toMatch(/if \(!asetId\) \{\s*setNotFound\(true\);/);
    expect(edit).toContain('getAsetById(asetId)');
    expect(edit).toContain('await updateAset({');
    expect(edit).not.toMatch(/beliAset\(|catatAsetTetapDariModalBarang\(|INSERT INTO aset_tetap/);
  });

  it('satu-satunya pemanggil beliAset di aplikasi adalah form Pembelian Aset (tidak ada pembuatan aset kedua)', () => {
    const fs = require('fs');
    const path = require('path');
    const hasil: string[] = [];
    const telusur = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) telusur(p);
        else if (/\.tsx?$/.test(f) && strip(fs.readFileSync(p, 'utf8')).includes('beliAset(')) hasil.push(path.relative(ROOT, p));
      }
    };
    telusur(join(ROOT, 'src', 'screens'));
    expect(hasil.map((x) => x.replace(/\\/g, '/'))).toEqual(['src/screens/Transaksi/PembelianAsetFormScreen.tsx']);
  });

  it('keyboard & loading: KeyboardAvoidingView (pola project), ScrollView persistTaps, ruang bawah, tombol disabled saat submit', () => {
    // RC-S110: pola lama `behavior={Platform.OS === 'ios' ? 'padding'
    // : undefined}` DIHAPUS dari seluruh aplikasi karena `behavior`
    // undefined membuat KeyboardAvoidingView tidak melakukan apa-apa di
    // Android — satu-satunya platform yang dibangun. Perlindungannya
    // sekarang lewat <AreaAmanKeyboard varian="...">, yang memberi
    // Android behavior 'height' untuk dialog. Assertion ini diperbarui
    // ke komponen barunya; yang dijaga tetap sama — layar ini WAJIB
    // punya perlindungan papan ketik, bukan sekadar mengimpornya.
    expect(layar).toMatch(/<AreaAmanKeyboard varian="layar" style=\{styles\.container\}>/);
    expect(layar).toContain('contentContainerStyle={styles.scrollContent}');
    expect(layar).toContain('paddingBottom: spacing.xl * 4');
    expect(layar).toContain('disabled={submitting}');
    expect(layar).toContain('<ActivityIndicator color={colors.white} />');
  });
});
