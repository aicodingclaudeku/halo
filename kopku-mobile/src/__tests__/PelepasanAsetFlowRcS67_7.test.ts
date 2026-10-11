import { readFileSync } from 'fs';
import { join } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, accId, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

/**
 * RC-S67.7 — FLOW TRANSAKSI "Penjualan / Pelepasan Aset".
 *
 * Pendapatan Koperasi › Penjualan / Pelepasan Aset → FORM TRANSAKSI
 * (PelepasanAsetForm) → pilih aset AKTIF → detail read-only → hasil
 * pelepasan → pratinjau laba/rugi (service) → PelepasanAsetTetapService.
 * Master "Daftar Aset Tetap & Penyusutan" tetap di menu Laporan.
 *
 * DATABASE: SQLite nyata + COA lengkap (fixture RC-S54 T16), AsetService,
 * PenyusutanService, PelepasanAsetTetapService ASLI (tidak diubah RC ini).
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

import { beliAset, listAsetDenganNilaiBuku } from '@/services/AsetService';
import { prosesPenyusutanAset } from '@/services/PenyusutanService';
import { pratinjauPelepasanAsetTetap, lepaskanAsetTetap } from '@/services/PelepasanAsetTetapService';
import {
  asetDapatDilepas,
  validasiIsianPelepasan,
  susunInputPelepasan,
  labelSelisihPelepasan,
  daftarKekuranganPelepasan,
  sinkronAsetTerpilih,
  pesanOperatorPelepasan,
  IsianPelepasan,
} from '@/utils/pelepasanAsetForm';
import { listHistoryTransaksi } from '@/services/HistoryTransaksiService';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

async function asetDisusutkan(nama = 'Mobil Operasional'): Promise<string> {
  const r = (await beliAset({
    namaAset: nama, nilaiPerolehan: 120_000_000, nilaiResidu: 0, masaManfaatBulan: 12,
    tanggal: '2026-01-05', tanggalPerolehan: '2026-01-05', metodePembayaran: 'TUNAI', sumberDana: 'KAS', createdBy: USER, jenisAset: 'TETAP',
  } as never)) as { id: string };
  for (const p of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']) {
    await prosesPenyusutanAset({ asetId: r.id, periode: p, createdBy: USER });
  }
  return r.id;
}

async function itemAset(id: string) {
  const it = (await listAsetDenganNilaiBuku()).find((a) => a.id === id);
  if (!it) throw new Error('aset tidak ada');
  return it;
}

const KAS = { id: 'kas', jenis: 'KAS' as const };
const isi = (aset: { id: string; status: string } | null, hasil: number | '', extra: Partial<IsianPelepasan> = {}): IsianPelepasan => ({
  aset, tanggal: '2026-08-31', nomorDokumen: 'BA-001', hasil, rekening: hasil !== '' && hasil > 0 ? KAS : null, ...extra,
});

function harusMemuat(e: { kode: string; debit: number; kredit: number }[], rows: { kode: string; debit: number; kredit: number }[]) {
  for (const r of rows) {
    expect(e.filter((x) => x.kode === r.kode && x.debit === r.debit && x.kredit === r.kredit)).toHaveLength(1);
  }
}

async function entri(journalId: string) {
  return testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
    `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id WHERE je.journal_id = ? ORDER BY a.kode`, journalId
  );
}

// ============================================================
describe('RC-S67.7 — navigasi', () => {
  const menu = strip(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));
  const nav = baca('src/navigation/RootNavigator.tsx');
  const layar = strip(baca('src/screens/Transaksi/PelepasanAsetFormScreen.tsx'));

  it('Pendapatan Koperasi → "Penjualan / Pelepasan Aset" → FORM TRANSAKSI (bukan Daftar Aset Tetap & Penyusutan)', () => {
    const i = menu.indexOf("judul: 'Penjualan / Pelepasan Aset'");
    expect(i).toBeGreaterThan(-1);
    const blok = menu.slice(i, menu.indexOf("kode: 'D'"));
    expect(blok).toContain("title: 'Penjualan / Pelepasan Aset'");
    expect(blok).toContain("aksi: { route: 'PelepasanAsetForm' }");
    expect(menu).not.toContain('DaftarAsetTetap');
    expect(menu).not.toContain("judul: 'Pendapatan Penjualan Aset'");
  });

  it('rute PelepasanAsetForm terdaftar tepat sekali di TransaksiStack, judul "Penjualan / Pelepasan Aset"', () => {
    expect((nav.match(/name="PelepasanAsetForm"/g) ?? []).length).toBe(1);
    expect(nav).toMatch(/<TransaksiStack\.Screen name="PelepasanAsetForm" component=\{PelepasanAsetFormScreen\} options=\{\{ title: 'Penjualan \/ Pelepasan Aset' \}\}/);
    // Master aset tetap terpisah & tetap ada (menu Laporan).
    expect((nav.match(/name="DaftarAsetTetap"/g) ?? []).length).toBe(1);
  });

  it('setelah berhasil: "Pelepasan aset berhasil dicatat." lalu kembali (goBack) — TIDAK ke Daftar Aset', () => {
    expect(layar).toContain("'Pelepasan aset berhasil dicatat.'");
    expect(layar).toContain('navigation.goBack()');
    expect(layar).not.toMatch(/navigate\([^)]*DaftarAsetTetap/);
  });

  it('layar memakai service existing (list nilai buku, pratinjau, lepaskan) — tanpa DB/rumus sendiri', () => {
    expect(layar).toContain('listAsetDenganNilaiBuku()');
    expect(layar).toContain('asetDapatDilepas(');
    expect(layar).toContain('pratinjauPelepasanAsetTetap(input)');
    expect(layar).toContain('await lepaskanAsetTetap(input)');
    expect(layar).not.toMatch(/getDb|runAsync|INSERT|UPDATE |createJournal/);
    expect(layar).not.toMatch(/nilaiPerolehan\s*-\s*|akumulasiPenyusutan\s*-/); // tidak menghitung nilai buku
    expect(layar).toContain("'Konfirmasi Pelepasan Aset'");
    expect(layar).toContain('if (sedangMengirim.current');
  });

  it('tidak ada service pelepasan kedua', () => {
    const fs = require('fs');
    const berkas = fs.readdirSync(join(__dirname, '..', 'services')) as string[];
    // Hanya dua service pelepasan existing (aset tetap & investasi) + diagnostik investasi.
    expect(berkas.filter((f) => /^(Pelepasan|Penjualan).*\.ts$/i.test(f)).sort()).toEqual([
      'PelepasanAsetTetapService.ts', 'PelepasanInvestasiDiagnostic.ts', 'PelepasanInvestasiService.ts',
    ]);
  });
});

// ============================================================
describe('RC-S67.7 — form: pilih aset & detail', () => {
  it('daftar pilihan hanya aset AKTIF; aset DIHAPUS (sudah dilepas) tidak muncul', async () => {
    const a = await asetDisusutkan('Mobil A');
    const b = await asetDisusutkan('Mobil B');
    await lepaskanAsetTetap(susunInputPelepasan(isi(await itemAset(b), 50_000_000), USER)!);
    const pilihan = asetDapatDilepas(await listAsetDenganNilaiBuku());
    expect(pilihan.map((x) => x.id)).toEqual([a]);
    expect((await listAsetDenganNilaiBuku()).find((x) => x.id === b)?.status).toBe('DIHAPUS');
  });

  it('detail aset dari data existing: nama, kode, tanggal, harga perolehan, akumulasi, nilai buku, status', async () => {
    const it = await itemAset(await asetDisusutkan());
    expect(it).toMatchObject({ namaAset: 'Mobil Operasional', tanggalPerolehan: '2026-01-05', nilaiPerolehan: 120_000_000, akumulasiPenyusutan: 70_000_000, nilaiBuku: 50_000_000, status: 'AKTIF' });
    expect(it.nomorAset).toBeTruthy();
  });
});

// ============================================================
describe('RC-S67.7 — form: validasi', () => {
  const A = { id: 'x', status: 'AKTIF' };
  it('aset wajib; aset DIHAPUS ditolak', () => {
    expect(validasiIsianPelepasan(isi(null, 1)).aset).toBeDefined();
    expect(validasiIsianPelepasan(isi({ id: 'x', status: 'DIHAPUS' }, 1)).aset).toBeDefined();
  });
  it('nomor dokumen wajib', () => {
    expect(validasiIsianPelepasan(isi(A, 1, { nomorDokumen: '  ' })).nomorDokumen).toBeDefined();
  });
  it('tanggal wajib', () => {
    expect(validasiIsianPelepasan(isi(A, 1, { tanggal: '' })).tanggal).toBeDefined();
  });
  it('nominal: kosong / negatif / pecahan ditolak; 0 sah', () => {
    expect(validasiIsianPelepasan(isi(A, '')).hasil).toBeDefined();
    expect(validasiIsianPelepasan(isi(A, -1, { rekening: KAS })).hasil).toBeDefined();
    expect(validasiIsianPelepasan(isi(A, 10.5, { rekening: KAS })).hasil).toBeDefined();
    expect(validasiIsianPelepasan(isi(A, 0))).toEqual({});
  });
  it('Kas/Bank wajib bila hasil > 0, tidak wajib bila hasil 0', () => {
    expect(validasiIsianPelepasan(isi(A, 5, { rekening: null })).rekening).toBeDefined();
    expect(validasiIsianPelepasan(isi(A, 0, { rekening: null })).rekening).toBeUndefined();
  });
  it('input service: sumber dana & rekening bank mengikuti pola existing; nomor dokumen dibawa di keterangan', () => {
    const bank = susunInputPelepasan(isi(A, 7, { rekening: { id: 'bank-1', jenis: 'BANK' } }), USER, 'catatan')!;
    expect(bank).toMatchObject({ asetId: 'x', hasilPelepasan: 7, sumberDana: 'BANK', bankAccountId: 'bank-1', keterangan: 'Dok BA-001 · catatan' });
    const nol = susunInputPelepasan(isi(A, 0), USER)!;
    expect(nol.sumberDana).toBeUndefined();
    expect(nol.bankAccountId).toBeUndefined();
    expect(susunInputPelepasan(isi(null, 1), USER)).toBeNull();
  });
});

// ============================================================
describe('RC-S67.7 — pratinjau laba / rugi / impas (dari service)', () => {
  it('LABA: nilai buku 50 jt, hasil 60 jt → Laba Pelepasan 10 jt', async () => {
    const it = await itemAset(await asetDisusutkan());
    const p = await pratinjauPelepasanAsetTetap(susunInputPelepasan(isi(it, 60_000_000), USER)!);
    expect(p.nilaiBuku).toBe(50_000_000);
    expect(labelSelisihPelepasan(p)).toEqual({ label: 'Laba Pelepasan', nilai: 10_000_000 });
  });
  it('RUGI: hasil 40 jt → Rugi Pelepasan 10 jt', async () => {
    const it = await itemAset(await asetDisusutkan());
    const p = await pratinjauPelepasanAsetTetap(susunInputPelepasan(isi(it, 40_000_000), USER)!);
    expect(labelSelisihPelepasan(p)).toEqual({ label: 'Rugi Pelepasan', nilai: 10_000_000 });
  });
  it('IMPAS: hasil = nilai buku → Laba/Rugi Rp 0', async () => {
    const it = await itemAset(await asetDisusutkan());
    const p = await pratinjauPelepasanAsetTetap(susunInputPelepasan(isi(it, 50_000_000), USER)!);
    expect(labelSelisihPelepasan(p)).toEqual({ label: 'Laba/Rugi', nilai: 0 });
  });
  it('nilai buku pratinjau = nilai buku daftar aset (satu sumber, tanpa rumus baru)', async () => {
    const it = await itemAset(await asetDisusutkan());
    const p = await pratinjauPelepasanAsetTetap(susunInputPelepasan(isi(it, 1), USER)!);
    expect(p.nilaiBuku).toBe(it.nilaiBuku);
    expect(p.akumulasiPenyusutan).toBe(it.akumulasiPenyusutan);
  });
});

// ============================================================
describe('RC-S67.7 — accounting (service existing, jurnal identik dengan jalur Daftar Aset)', () => {
  it('LABA: Dr Kas + Dr Akumulasi / Cr Aset + Cr 4-1800; seimbang; aset DIHAPUS', async () => {
    const it = await itemAset(await asetDisusutkan());
    const { journalId } = await lepaskanAsetTetap(susunInputPelepasan(isi(it, 60_000_000), USER)!);
    const e = await entri(journalId);
    const d = e.reduce((s, x) => s + x.debit, 0);
    const k = e.reduce((s, x) => s + x.kredit, 0);
    expect(d).toBe(k);
    harusMemuat(e, [
      { kode: '1-1000', debit: 60_000_000, kredit: 0 },
      { kode: '1-1510', debit: 70_000_000, kredit: 0 },
      { kode: '1-1500', debit: 0, kredit: 120_000_000 },
      { kode: '4-1800', debit: 0, kredit: 10_000_000 },
    ]);
    expect((await itemAset(it.id)).status).toBe('DIHAPUS');
    const j = await testDb.getFirstAsync<{ status: string; sumber_transaksi: string }>(`SELECT status, sumber_transaksi FROM journal WHERE id = ?`, journalId);
    expect(j).toEqual({ status: 'POSTED', sumber_transaksi: 'PELEPASAN_ASET_TETAP' });
  });

  it('RUGI: Dr Kas + Dr Akumulasi + Dr 5-2170 / Cr Aset; tidak ada akun pendapatan selain laba', async () => {
    const it = await itemAset(await asetDisusutkan());
    const { journalId } = await lepaskanAsetTetap(susunInputPelepasan(isi(it, 40_000_000), USER)!);
    const e = await entri(journalId);
    harusMemuat(e, [
      { kode: '1-1000', debit: 40_000_000, kredit: 0 },
      { kode: '1-1510', debit: 70_000_000, kredit: 0 },
      { kode: '5-2170', debit: 10_000_000, kredit: 0 },
      { kode: '1-1500', debit: 0, kredit: 120_000_000 },
    ]);
    expect(e.some((x) => x.kode.startsWith('4-'))).toBe(false);
  });

  it('jurnal dari form = jurnal dari input gaya Daftar Aset (service sama, baris sama)', async () => {
    const a = await itemAset(await asetDisusutkan('Aset Form'));
    const b = await itemAset(await asetDisusutkan('Aset Daftar'));
    const dariForm = await lepaskanAsetTetap(susunInputPelepasan(isi(a, 60_000_000), USER)!);
    // Pola input DaftarAsetTetapScreen (tanpa keterangan).
    const dariDaftar = await lepaskanAsetTetap({ asetId: b.id, tanggalPelepasan: '2026-08-31', hasilPelepasan: 60_000_000, sumberDana: 'KAS', createdBy: USER });
    expect(await entri(dariForm.journalId)).toEqual(await entri(dariDaftar.journalId));
  });

  it('aset yang sudah dilepas tidak dapat dilepas lagi (service menolak SUDAH_DILEPAS)', async () => {
    const it = await itemAset(await asetDisusutkan());
    await lepaskanAsetTetap(susunInputPelepasan(isi(it, 1), USER)!);
    let err: any;
    try {
      await lepaskanAsetTetap(susunInputPelepasan(isi(it, 1), USER)!);
    } catch (e) {
      err = e;
    }
    expect(err?.kode).toBe('SUDAH_DILEPAS');
    expect(accId('1-1500')).toBeTruthy();
  });
});

// ============================================================
// RC-S67.7.1 — FINAL HARDENING
// ============================================================
describe('RC-S67.7.1 — logika form (helper murni)', () => {
  const A = { id: 'x', status: 'AKTIF' };

  it('daftar kekurangan: urut & lengkap saat kosong; kosong saat isian valid', () => {
    expect(daftarKekuranganPelepasan({ aset: null, tanggal: '', nomorDokumen: '', hasil: '', rekening: null })).toEqual([
      'Aset tetap wajib dipilih.', 'Tanggal pelepasan wajib diisi.', 'Nomor dokumen wajib diisi.', 'Hasil pelepasan wajib diisi (boleh 0).',
    ]);
    expect(daftarKekuranganPelepasan(isi(A, 5))).toEqual([]);
  });

  it('hasil > 0 → pilih Kas/Bank → hasil diubah ke 0: Kas/Bank TIDAK menggagalkan transaksi 0 dan tidak ikut dikirim', () => {
    const i = isi(A, 0, { rekening: { id: 'bank-1', jenis: 'BANK' } });
    expect(daftarKekuranganPelepasan(i)).toEqual([]);
    const input = susunInputPelepasan(i, USER)!;
    expect(input.sumberDana).toBeUndefined();
    expect(input.bankAccountId).toBeUndefined();
  });

  it('hasil > 0 tanpa Kas/Bank → kekurangan Kas/Bank; tombol harus nonaktif', () => {
    expect(daftarKekuranganPelepasan(isi(A, 5, { rekening: null }))).toEqual(['Kas/Bank wajib dipilih bila hasil pelepasan lebih dari 0.']);
  });

  it('ganti aset / muat ulang: aset terpilih diganti data terbaru, dikosongkan bila tidak eligible lagi', () => {
    const lama = { id: 'a1', nilaiBuku: 10 };
    const baru = [{ id: 'a1', nilaiBuku: 7 }, { id: 'a2', nilaiBuku: 3 }];
    expect(sinkronAsetTerpilih(lama, baru)).toEqual({ id: 'a1', nilaiBuku: 7 });
    expect(sinkronAsetTerpilih(lama, [{ id: 'a2', nilaiBuku: 3 }])).toBeNull();
    expect(sinkronAsetTerpilih(null, baru)).toBeNull();
  });

  it('pesan galat ramah operator; galat teknis tidak pernah tampil', () => {
    const svc = (kode: string) => Object.assign(new Error(`${kode}: x`), { kode });
    expect(pesanOperatorPelepasan(svc('SUDAH_DILEPAS'), 'c')).toBe('Aset sudah dilepas; transaksi ganda ditolak.');
    expect(pesanOperatorPelepasan(svc('ASET_TIDAK_DITEMUKAN'), 'c')).toBe('Aset tidak ditemukan.');
    expect(pesanOperatorPelepasan(svc('PERIODE_CLOSED'), 'c')).toBe('Periode akuntansi untuk tanggal pelepasan sudah ditutup.');
    expect(pesanOperatorPelepasan(Object.assign(new Error('Periode p-123 CLOSED'), { name: 'ClosedPeriodError' }), 'c')).toBe('Periode akuntansi untuk tanggal pelepasan sudah ditutup.');
    expect(pesanOperatorPelepasan(svc('HASIL_TIDAK_VALID'), 'c')).toBe('Nilai pelepasan tidak valid.');
    expect(pesanOperatorPelepasan(svc('REKENING_WAJIB'), 'c')).toBe('Kas/Bank wajib dipilih bila hasil pelepasan lebih dari 0.');
    expect(pesanOperatorPelepasan(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: journal.id'), 'Gagal menyimpan transaksi.')).toBe('Gagal menyimpan transaksi.');
    expect(pesanOperatorPelepasan(new Error("TypeError: Cannot read properties of undefined"), 'Gagal')).toBe('Gagal');
    expect(pesanOperatorPelepasan('bukan error', 'Gagal')).toBe('Gagal');
    expect(pesanOperatorPelepasan(new Error('TANGGAL_SEBELUM_PEROLEHAN: Tanggal pelepasan sebelum perolehan.'), 'c')).toBe('Tanggal pelepasan sebelum perolehan.');
  });
});

describe('RC-S67.7.1 — hasil 0, periode tertutup, dobel submit, history (service existing)', () => {
  it('HASIL 0: tanpa baris Kas/Bank; Dr Akumulasi + Dr Rugi (= nilai buku) / Cr Aset; pratinjau "Rugi Pelepasan"', async () => {
    const it = await itemAset(await asetDisusutkan());
    const input = susunInputPelepasan(isi(it, 0), USER)!;
    expect(labelSelisihPelepasan(await pratinjauPelepasanAsetTetap(input))).toEqual({ label: 'Rugi Pelepasan', nilai: 50_000_000 });
    const { journalId } = await lepaskanAsetTetap(input);
    const e = await entri(journalId);
    expect(e.some((x) => x.kode === '1-1000' || x.kode === '1-1100')).toBe(false);
    harusMemuat(e, [
      { kode: '1-1510', debit: 70_000_000, kredit: 0 },
      { kode: '5-2170', debit: 50_000_000, kredit: 0 },
      { kode: '1-1500', debit: 0, kredit: 120_000_000 },
    ]);
    expect(e.some((x) => x.debit === 0 && x.kredit === 0)).toBe(false);
  });

  it('IMPAS: tidak ada baris laba maupun rugi', async () => {
    const it = await itemAset(await asetDisusutkan());
    const { journalId } = await lepaskanAsetTetap(susunInputPelepasan(isi(it, 50_000_000), USER)!);
    const e = await entri(journalId);
    expect(e.some((x) => x.kode === '4-1800' || x.kode === '5-2170')).toBe(false);
    expect(e.reduce((s, x) => s + x.debit, 0)).toBe(e.reduce((s, x) => s + x.kredit, 0));
  });

  it('PERIODE CLOSED: pratinjau & simpan ditolak; tidak ada jurnal baru; aset tetap AKTIF', async () => {
    const it = await itemAset(await asetDisusutkan());
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE periode_mulai <= '2026-08-31' AND periode_selesai >= '2026-08-31'`);
    const jurnal = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`);
    const input = susunInputPelepasan(isi(it, 60_000_000), USER)!;
    for (const fn of [() => pratinjauPelepasanAsetTetap(input), () => lepaskanAsetTetap(input)]) {
      let err: unknown;
      try {
        await fn();
      } catch (e) {
        err = e;
      }
      expect(pesanOperatorPelepasan(err, 'x')).toBe('Periode akuntansi untuk tanggal pelepasan sudah ditutup.');
    }
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal`))?.n).toBe(jurnal?.n);
    expect((await itemAset(it.id)).status).toBe('AKTIF');
  });

  it('DOBEL SUBMIT bersamaan: tepat satu jurnal pelepasan; yang lain ditolak service', async () => {
    const it = await itemAset(await asetDisusutkan());
    const input = susunInputPelepasan(isi(it, 60_000_000), USER)!;
    const hasil = await Promise.allSettled([lepaskanAsetTetap(input), lepaskanAsetTetap(input)]);
    expect(hasil.filter((h) => h.status === 'fulfilled')).toHaveLength(1);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'PELEPASAN_ASET_TETAP' AND sumber_id = ?`, it.id);
    expect(n?.n).toBe(1);
  });

  it('HISTORY: transaksi tercatat sebagai "Pelepasan Aset Tetap"; reversal tidak didukung service (tanpa rute koreksi)', async () => {
    const it = await itemAset(await asetDisusutkan());
    const { journalId } = await lepaskanAsetTetap(susunInputPelepasan(isi(it, 60_000_000), USER)!);
    const row = (await listHistoryTransaksi()).find((r) => r.journalId === journalId);
    expect(row).toBeDefined();
    expect(row!.jenisLabel).toBe('Pelepasan Aset Tetap');
    expect(row!.operasiAsetTetap).toBe('PELEPASAN_ASET_TETAP');
    expect(row!.status).toBe('POSTED');
    const hist = baca('src/services/HistoryTransaksiService.ts');
    const routable = hist.slice(hist.indexOf('const ROUTABLE_SOURCE_TABLE'), hist.indexOf('};', hist.indexOf('const ROUTABLE_SOURCE_TABLE')));
    expect(routable).not.toContain('PELEPASAN_ASET_TETAP'); // NOT SUPPORTED BY EXISTING SERVICE
  });
});

describe('RC-S67.7.1 — hardening layar (struktural)', () => {
  const layar = strip(baca('src/screens/Transaksi/PelepasanAsetFormScreen.tsx'));

  it('keyboard: KeyboardAvoidingView (pola project) + ScrollView keyboardShouldPersistTaps + ruang bawah', () => {
    // RC-S110: pola lama `behavior={Platform.OS === 'ios' ? 'padding'
    // : undefined}` DIHAPUS dari seluruh aplikasi karena `behavior`
    // undefined membuat KeyboardAvoidingView tidak melakukan apa-apa di
    // Android — satu-satunya platform yang dibangun. Perlindungannya
    // sekarang lewat <AreaAmanKeyboard varian="...">, yang memberi
    // Android behavior 'height' untuk dialog. Assertion ini diperbarui
    // ke komponen barunya; yang dijaga tetap sama — layar ini WAJIB
    // punya perlindungan papan ketik, bukan sekadar mengimpornya.
    expect(layar).toMatch(/<AreaAmanKeyboard varian="layar" style=\{styles\.container\}>/);
    expect(layar).toMatch(/<ScrollView keyboardShouldPersistTaps="handled"/);
    expect(layar).toContain('paddingBottom: spacing.xl * 4');
  });

  it('modal picker: Modal + SafeAreaView edges top/bottom + FlatList (virtualized) + tombol tutup; tanpa statusBarTranslucent', () => {
    expect(layar).toMatch(/<Modal visible=\{pickerOpen\} animationType="slide" onRequestClose=\{\(\) => setPickerOpen\(false\)\}>/);
    expect(layar).toContain("edges={['top', 'bottom']}");
    expect(layar).toMatch(/<FlatList\s+keyboardShouldPersistTaps="handled"/);
    expect(layar).toContain('accessibilityLabel="Tutup"');
    expect(layar).not.toContain('statusBarTranslucent');
  });

  it('loading: status menghitung direset di awal efek & cleanup; guard unmount untuk load & submit', () => {
    expect(layar).toMatch(/setPratinjauError\(null\);\s*setMenghitung\(false\);/);
    expect(layar).toMatch(/batal = true;\s*setMenghitung\(false\);/);
    expect(layar).toContain('masihTerpasang.current = false');
    expect(layar).toContain('if (!masihTerpasang.current) return;');
    expect(layar).toContain('if (masihTerpasang.current) setSubmitting(false);');
  });

  it('tombol Simpan: nonaktif bila isian kurang / pratinjau belum valid / menghitung / submit', () => {
    expect(layar).toContain('const bisaSimpan = kekurangan.length === 0 && !!pratinjau && !pratinjauError && !submitting && !menghitung;');
    expect(layar).toContain('disabled={!bisaSimpan}');
    expect(layar).toContain('if (sedangMengirim.current || !currentUser) return;');
    expect(layar).toContain('setPratinjau(null); // tombol langsung nonaktif');
  });

  it('galat: semua lewat pesanOperatorPelepasan; tidak ada pesan mentah', () => {
    expect(layar).toContain("pesanOperatorPelepasan(e, 'Gagal menyimpan transaksi. Silakan coba lagi.')");
    expect(layar).toContain("pesanOperatorPelepasan(e, 'Pratinjau belum dapat dihitung.')");
    expect(layar).not.toMatch(/e\.message|String\(e\)/);
  });

  it('state: aset terpilih disinkronkan setelah muat ulang; daftar kekurangan ditampilkan saat belum lengkap', () => {
    expect(layar).toContain('setAset((lama) => sinkronAsetTerpilih(lama, baru));');
    expect(layar).toContain('kekurangan.map((k) =>');
  });
});
