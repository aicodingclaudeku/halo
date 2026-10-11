/**
 * Imbalan Kerja — jenis GAJI (sebelum Honorarium) & helper tampilan.
 */
import * as fs from 'fs';
import * as path from 'path';
import { JENIS_IMBALAN, LABEL_JENIS_IMBALAN } from '@/services/ImbalanKerjaService';
import {
  labelJenisImbalan,
  labelJenisPersonel,
  labelStatusImbalan,
  ringkasanDaftarImbalan,
  saringImbalan,
  tanggalPendek,
} from '@/utils/imbalanKerjaUi';

const row = (o: any) => ({
  id: 'x', personelId: 'p', namaPenerima: 'A', jenisPersonel: 'PENGURUS', jabatan: null, periodKey: '2026-09',
  jenisImbalan: 'GAJI', dasarPerhitungan: 0, nilaiImbalan: 1000, tanggalPengakuan: '2026-09-01',
  tanggalJatuhTempo: '2026-09-30', status: 'POSTED', journalId: 'j', journalBayarId: null, tanggalPembayaran: null,
  keterangan: null, ...o,
});

describe('jenis imbalan', () => {
  test('GAJI ada dan berada tepat sebelum HONORARIUM', () => {
    expect(JENIS_IMBALAN).toContain('GAJI');
    expect(JENIS_IMBALAN.indexOf('GAJI')).toBe(JENIS_IMBALAN.indexOf('HONORARIUM') - 1);
    expect(JENIS_IMBALAN[0]).toBe('GAJI');
  });

  test('setiap jenis punya label manusia', () => {
    for (const j of JENIS_IMBALAN) {
      expect(LABEL_JENIS_IMBALAN[j]).toBeTruthy();
      expect(labelJenisImbalan(j)).not.toMatch(/^[A-Z_]+$/);
    }
    expect(labelJenisImbalan('GAJI')).toBe('Gaji');
  });

  test('schema: kolom jenis_imbalan tanpa CHECK — GAJI tidak butuh migration', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../database/schema.ts'), 'utf8');
    const baris = schema.split('\n').find((l) => l.includes('jenis_imbalan TEXT'))!;
    expect(baris).not.toMatch(/CHECK/);
  });
});

describe('helper tampilan', () => {
  test('label status & personel', () => {
    expect(labelStatusImbalan('POSTED')).toBe('Belum Dibayar');
    expect(labelStatusImbalan('PAID')).toBe('Sudah Dibayar');
    expect(labelJenisPersonel('PENGURUS')).toBe('Pengurus');
    expect(tanggalPendek('2026-09-05')).toBe('5 Sep 2026');
  });

  test('saring & ringkas daftar', () => {
    const d = [row({ id: '1', nilaiImbalan: 500 }), row({ id: '2', nilaiImbalan: 700 }), row({ id: '3', status: 'PAID' })] as any;
    expect(saringImbalan(d, 'BELUM').map((r) => r.id)).toEqual(['1', '2']);
    expect(saringImbalan(d, 'SUDAH').map((r) => r.id)).toEqual(['3']);
    expect(saringImbalan(d, 'SEMUA')).toHaveLength(3);
    expect(ringkasanDaftarImbalan(d)).toEqual({ jumlahBelum: 2, nilaiBelum: 1200, jumlahSudah: 1 });
  });

  test('layar tidak menampilkan enum/UUID mentah', () => {
    const src = fs.readFileSync(path.join(__dirname, '../screens/Transaksi/ImbalanKerjaFormScreen.tsx'), 'utf8');
    expect(src).toContain('labelJenisImbalan(j)');
    expect(src).toContain('labelStatusImbalan(row.status)');
    expect(src).not.toMatch(/\{row\.status\}/);
    expect(src).not.toMatch(/\{row\.jenisImbalan\}/);
    expect(src).not.toMatch(/Jurnal: \{row\.journalId\}/);
  });
});
