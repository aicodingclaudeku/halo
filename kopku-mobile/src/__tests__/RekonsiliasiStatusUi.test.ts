/**
 * Perbaikan UI Rekonsiliasi Kas/Bank (pasca RC-S81) — pemetaan status
 * & label per penyebab. Helper murni; tidak menyentuh database.
 */
import {
  OPSI_PENYEBAB,
  akibatPenyebab,
  ctaRekonsiliasi,
  jenisHasilSimpan,
  labelStatusRiwayat,
  statusRiwayat,
  type KodePenyebabUI,
} from '@/utils/rekonsiliasiForm';
import { PERLAKUAN_SAH, penyebabTetapDraft } from '@/services/CashReconciliationService';
import * as fs from 'fs';
import * as path from 'path';

const opsi = (k: KodePenyebabUI) => OPSI_PENYEBAB.find((o) => o.kode === k)!;

const HARAPAN: Record<KodePenyebabUI, { status: string; cta: string }> = {
  BELUM_TERCATAT: { status: 'Belum Ditindaklanjuti', cta: 'Simpan Temuan' },
  SALAH_PENCATATAN: { status: 'Belum Ditindaklanjuti', cta: 'Simpan Temuan' },
  KESALAHAN_BANK: { status: 'Belum Ditindaklanjuti', cta: 'Simpan Temuan' },
  LAINNYA: { status: 'Belum Ditindaklanjuti', cta: 'Simpan Temuan' },
  PERBEDAAN_WAKTU: { status: 'Selisih Dijelaskan', cta: 'Tandai Sebagai Perbedaan Waktu' },
  BIAYA_BANK: { status: 'Penyesuaian Tercatat', cta: 'Catat Penyesuaian' },
  JASA_GIRO: { status: 'Penyesuaian Tercatat', cta: 'Catat Penyesuaian' },
  SELISIH_KAS_FISIK: { status: 'Penyesuaian Tercatat', cta: 'Catat Penyesuaian' },
};

describe('taksonomi UI konsisten dengan semantics service', () => {
  test.each(OPSI_PENYEBAB.map((o) => [o.kode, o] as const))('%s', (_k, o) => {
    // Penyesuaian (jurnal) HANYA bila service menyatakan PERLU_JURNAL.
    expect(o.tindakan === 'PENYESUAIAN').toBe(PERLAKUAN_SAH[o.penyebabService] === 'PERLU_JURNAL');
    // "selesai seketika" di UI == bukan DRAFT di service.
    expect(o.selesai).toBe(!penyebabTetapDraft(o.penyebabService));
    // Status yang dijanjikan UI & label tombol.
    expect(akibatPenyebab(o).statusSetelahSimpan).toBe(HARAPAN[o.kode].status);
    expect(o.ctaLabel).toBe(HARAPAN[o.kode].cta);
  });

  test('temuan: Tindak Lanjut menjelaskan masih harus ditindaklanjuti, CTA hanya menyimpan', () => {
    for (const k of ['BELUM_TERCATAT', 'SALAH_PENCATATAN', 'KESALAHAN_BANK', 'LAINNYA'] as const) {
      expect(opsi(k).tindakLanjut).toContain('Belum Ditindaklanjuti');
      expect(opsi(k).tindakLanjut).not.toMatch(/Penyesuaian Tercatat/);
      const c = ctaRekonsiliasi({ siap: true, selisih: -1000, opsi: opsi(k), akun: null, catatan: 'x' });
      expect(c).toEqual({ label: 'Simpan Temuan', aktif: true, aksi: 'SIMPAN' });
    }
  });

  test('temuan tanpa catatan: CTA nonaktif dengan pesan (kolom catatan wajib untuk semua penyebab)', () => {
    const c = ctaRekonsiliasi({ siap: true, selisih: -1000, opsi: opsi('LAINNYA'), akun: null, catatan: '  ' });
    expect(c.aktif).toBe(false);
    expect(c.pesan).toBe('Jelaskan penyebab selisih pada catatan.');
  });
});

describe('riwayat & hasil simpan dibaca dari nilai database apa adanya', () => {
  const baris = (o: Partial<Parameters<typeof statusRiwayat>[0]>) =>
    ({ status: 'SELISIH', statusPenyelesaian: 'DRAFT', journalId: null, penyebab: null, ...o }) as Parameters<typeof statusRiwayat>[0];

  test.each([
    ['TRANSAKSI_BELUM_TERCATAT', 'Transaksi Belum Tercatat'],
    ['SELISIH_PENCATATAN', 'Salah Pencatatan'],
    ['KESALAHAN_BANK', 'Kesalahan Bank'],
    ['LAINNYA', 'Penyebab Lain'],
  ] as const)('DRAFT %s -> Belum Ditindaklanjuti (bukan Penyesuaian Tercatat)', (penyebab, label) => {
    const r = baris({ penyebab });
    expect(statusRiwayat(r)).toEqual({ penyebab: label, status: 'Belum Ditindaklanjuti', nada: 'WARN' });
    expect(jenisHasilSimpan(r)).toBe('TEMUAN');
  });

  test('perbedaan waktu SELESAI tanpa jurnal -> Selisih Dijelaskan', () => {
    const r = baris({ penyebab: 'TIMING_DIFFERENCE', statusPenyelesaian: 'SELESAI' });
    expect(statusRiwayat(r)).toEqual({ penyebab: 'Perbedaan Waktu', status: 'Selisih Dijelaskan', nada: 'INFO' });
    expect(jenisHasilSimpan(r)).toBe('DIJELASKAN');
  });

  test.each(['BIAYA_ADMIN_BANK', 'JASA_GIRO', 'SELISIH_FISIK'] as const)('%s SELESAI + jurnal -> Penyesuaian Tercatat', (penyebab) => {
    const r = baris({ penyebab, statusPenyelesaian: 'SELESAI', journalId: 'j1' });
    expect(labelStatusRiwayat(r)).toBe('Penyesuaian Tercatat');
    expect(jenisHasilSimpan(r)).toBe('PENYESUAIAN');
  });

  test('"Penyesuaian Tercatat" hanya bila jurnal benar-benar ada', () => {
    const r = baris({ penyebab: 'BIAYA_ADMIN_BANK', statusPenyelesaian: 'SELESAI', journalId: null });
    expect(labelStatusRiwayat(r)).toBe('Selisih Dijelaskan');
  });

  test('COCOK & selisih tanpa penyebab tetap punya Penyebab + Status', () => {
    expect(statusRiwayat(baris({ status: 'COCOK', statusPenyelesaian: 'SELESAI' }))).toEqual({ penyebab: 'Tidak ada selisih', status: 'Cocok', nada: 'OK' });
    expect(statusRiwayat(baris({}))).toEqual({ penyebab: 'Belum ditentukan', status: 'Belum Ditindaklanjuti', nada: 'WARN' });
    expect(jenisHasilSimpan(baris({ status: 'COCOK', statusPenyelesaian: 'SELESAI' }))).toBe('COCOK');
  });

  test('helper tidak memodifikasi baris yang dibaca', () => {
    const r = Object.freeze(baris({ penyebab: 'LAINNYA' }));
    expect(() => statusRiwayat(r)).not.toThrow();
    expect(r.statusPenyelesaian).toBe('DRAFT');
  });
});

describe('layar (struktural)', () => {
  const layar = fs
    .readFileSync(path.join(__dirname, '../screens/Akuntansi/RekonsiliasiScreen.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('riwayat menampilkan label Penyebab dan Status Penyelesaian', () => {
    expect(layar).toContain('Penyebab: ');
    expect(layar).toContain('Status Penyelesaian: ');
    expect(layar).toContain('const st = statusRiwayat(r);');
  });

  test('kartu hasil memakai jenis dari service; temuan tampil sebagai "Temuan Tersimpan"', () => {
    expect(layar).toContain('const jenis = jenisHasilSimpan(h);');
    expect(layar).toContain("'Temuan Tersimpan'");
    expect(layar).not.toContain('Hasil Pemeriksaan Tersimpan');
    expect(layar).not.toContain('Simpan hasil pemeriksaan saja');
  });

  test('tidak ada wording user-facing "Saldo Aktual"', () => {
    for (const rel of ['../screens/Akuntansi/RekonsiliasiScreen.tsx', '../utils/rekonsiliasiForm.ts', '../services/CashReconciliationService.ts']) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(src).not.toMatch(/[Ss]aldo [Aa]ktual/);
    }
  });
});
