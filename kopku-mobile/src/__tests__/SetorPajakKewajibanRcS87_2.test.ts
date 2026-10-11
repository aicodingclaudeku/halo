/**
 * RC-S87.2 — Pembayaran pajak lewat menu Kewajiban + desain ulang Setor Pajak.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { isiInfoPajak } from '@/screens/Pajak/infoPajak';
import { KODE_UTANG_PAJAK_SETORAN } from '@/config/pajakPolicy';

const baca = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const BAYAR = baca('screens/Transaksi/BayarUtangFormScreen.tsx');
const SETOR = baca('screens/Pajak/SetorPajakFormScreen.tsx');

describe('RC-S87.2 — Bayar Kewajiban mengarahkan pembayaran pajak', () => {
  it('kartu ketiga "Setor Pajak" membuka alur Setor Pajak', () => {
    expect(BAYAR).toMatch(/icon="receipt-outline"\s+title="Setor Pajak"/);
    expect(BAYAR).toMatch(/onPress=\{\(\) => navigation\.navigate\('SetorPajakForm'\)\}/);
  });

  it('utang pajak yang dipilih di "Kewajiban Lainnya" diarahkan ke Setor Pajak (masa & NTPN), bukan dibayar di form umum', () => {
    expect(BAYAR).toMatch(/KODE_UTANG_PAJAK_SETORAN\.includes\(akun\.kode\)/);
    expect(BAYAR).toMatch(/navigation\.navigate\('SetorPajakForm', \{ kodeAkun: akun\.kode \}\)/);
    expect(BAYAR).toMatch(/jenis === 'LAINNYA' && akun && !akunPajak/);
    expect(KODE_UTANG_PAJAK_SETORAN).toEqual(expect.arrayContaining(['2-1904', '2-1905', '2-1901']));
  });

  it('dua kartu lama dan mesin pembayaran tidak berubah', () => {
    expect(BAYAR).toMatch(/title="Utang Koperasi"/);
    expect(BAYAR).toMatch(/title="Kewajiban Lainnya"/);
    expect(BAYAR).toMatch(/await bayarKewajibanCoa\(/);
  });
});

describe('RC-S87.2 — Setor Pajak (UI)', () => {
  it('alur 3 langkah bernomor dengan penjelasan', () => {
    for (const n of [1, 2, 3]) expect(SETOR).toMatch(new RegExp(`<JudulSeksi nomor=\\{${n}\\}`));
    for (const k of ['jenisUtangPajak', 'masaSetor', 'setorSebagian', 'ntpn']) {
      expect(SETOR).toContain(`info('${k}')`);
      expect(isiInfoPajak(k as any, 2026).ringkas.length).toBeGreaterThan(20);
    }
  });

  it('memakai setorPajak() existing; tidak menulis DB langsung; tanpa warna hex', () => {
    expect(SETOR).toMatch(/await setorPajak\(/);
    expect(SETOR).not.toMatch(/getDb|runAsync|createJournal/);
    expect(SETOR).not.toMatch(/'#[0-9A-Fa-f]{3,6}'/);
  });

  it('tombol simpan terkunci bila melebihi saldo / belum lengkap; ringkasan sebelum simpan', () => {
    expect(SETOR).toMatch(/const siapRingkasan = !!akun && nominalAngka > 0 && !melebihi && !!rekening;/);
    expect(SETOR).toMatch(/nonaktif=\{!siapRingkasan\}/);
    expect(SETOR).toContain('Ringkasan setoran');
    expect(SETOR).toContain('Sisa utang');
  });

  it('PPh 4(2) bunga simpanan ditandai sebagai pajak yang dipotong dari anggota', () => {
    expect(SETOR).toMatch(/KODE_UTANG_PPH_BUNGA_SIMPANAN\) return \{ label: 'Dipotong dari anggota'/);
  });
});
