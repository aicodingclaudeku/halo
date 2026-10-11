import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * RC-S54 TAHAP 16 — GAP 1: KONTRAK UI (statis).
 *
 * Renderer React Native TIDAK tersedia (jest `testEnvironment: node`, tanpa
 * react-test-renderer / @testing-library/react-native) — ini BUKAN verifikasi runtime.
 * Test ini mengunci kontrak sumber layar agar alur yang benar tidak hilang diam-diam.
 */

const root = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(root, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

describe('RC-S54 T16 GAP 1 — lingkungan', () => {
  it('renderer RN tidak tersedia -> kontrak statis, bukan runtime VERIFIED', () => {
    const pkg = JSON.parse(baca('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const semua = { ...pkg.dependencies, ...pkg.devDependencies };
    const adaRenderer = 'react-test-renderer' in semua || '@testing-library/react-native' in semua || existsSync(join(root, 'node_modules', 'react-test-renderer'));
    expect(adaRenderer).toBe(false);
  });
});

describe('RC-S54 T16 GAP 1 — Daftar Investasi & form pelepasan', () => {
  const ui = strip(baca('src/screens/Akuntansi/DaftarInvestasiScreen.tsx'));

  it('Jual Kembali/Cairkan membuka alur pelepasan; Koreksi memakai alur terpisah; aksi hanya untuk AKTIF', () => {
    expect(ui).toMatch(/onPress=\{\(\) => bukaPelepasan\(item\)\}/);
    expect(ui).toMatch(/await batalkanInvestasi\(modalTarget\.id/);
    expect(ui).not.toMatch(/bukaPelepasan[\s\S]{0,200}batalkanInvestasi/);
    expect(ui).toMatch(/canEdit && item\.status === 'AKTIF' && \(/);
    const aksi = ui.slice(ui.indexOf("canEdit && item.status === 'AKTIF'"));
    expect(aksi.indexOf('bukaPelepasan(item)')).toBeGreaterThan(-1);
    expect(ui).toMatch(/item\.status === 'DILEPAS' &&/);
  });

  it('hasil awal kosong, tidak pernah dari biaya; rekening hanya bila hasil > 0 dan dikosongkan saat hasil 0', () => {
    expect(ui).toMatch(/setLepasHasil\(''\)/);
    expect(ui).not.toMatch(/setLepasHasil\((String\()?[^)'"]*jumlah/);
    expect(ui).toMatch(/\{hasilPositif && \(\s*<RekeningPicker/);
    expect(ui).toMatch(/if \(!\(Number\(t\.replace\(\/\[\^0-9\]\/g, ''\)\) > 0\)\) setLepasRekening\(null\)/);
    expect(ui).toMatch(/hasil > 0 && lepasRekening/);
  });

  it('pratinjau wajib sebelum konfirmasi; setiap perubahan input membatalkan pratinjau', () => {
    expect(ui).toMatch(/disabled=\{!pratinjau \|\| processing\}/);
    expect(ui).toMatch(/if \(!input \|\| !pratinjau\) return;/);
    const onChange = ui.match(/setLepas(Hasil|Tanggal|Rekening)\([^)]*\);[\s\S]{0,60}setPratinjau\(null\)/g) ?? [];
    expect(onChange.length).toBeGreaterThanOrEqual(3);
    expect(ui).toMatch(/await pratinjauPelepasanInvestasi\(input\)/);
    expect(ui).toMatch(/await lepaskanInvestasi\(input\)/);
  });

  it('laba/rugi & nilai tercatat berasal dari pratinjau service (tanpa hitungan client)', () => {
    expect(ui).toMatch(/pratinjau\.nilaiTercatat/);
    expect(ui).toMatch(/pratinjau\.jenisSelisih === 'RUGI'/);
    expect(ui).not.toMatch(/jumlah\s*-\s*|nilaiTercatat\s*=/);
  });

  it('form menampilkan seluruh field wajib dan status validasi; pesan error tanpa kode teknis', () => {
    for (const label of ['Nomor Investasi', 'Nilai Perolehan', 'Akumulasi Penyusutan', 'Penurunan Nilai', 'Nilai Tercatat', 'Hasil Pelepasan', 'Rekening Penerima', 'Tanggal Pelepasan', 'Laba/Rugi Pelepasan', 'Status validasi', 'Konfirmasi Pelepasan']) {
      expect(ui).toContain(label);
    }
    expect(ui).toContain('lepasTarget?.namaTujuan');
    expect(ui).toMatch(/m\.replace\(\/\^\[A-Z\]\[A-Z0-9_\]\+:\\s\*\/, ''\)/);
    expect(ui.match(/pesanPengguna\(e,/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('RC-S54 T16 GAP 1 — History, CALK, Cash Flow (kontrak)', () => {
  it('History: pelepasan & koreksi dikenali, dapat ditelusuri (sumberId), bukan reversal generik', () => {
    const h = strip(baca('src/services/HistoryTransaksiService.ts'));
    expect(h).toContain("PELEPASAN_INVESTASI: 'Pelepasan Investasi'");
    expect(h).toMatch(/Koreksi Salah Input — \$\{labelJenisTransaksi/);
    expect(h).toMatch(/sumberId: r\.sumber_id \?\? null/);
  });

  it('CALK: pengungkapan 2-1300 hanya saat saldo debit', () => {
    const fr = strip(baca('src/reports/FinancialReports.ts'));
    expect(fr).toMatch(/saldoDimukaDebit = saldoDimuka < 0 \? -saldoDimuka : 0/);
    expect(fr).toMatch(/saldoDimukaDebit > 0\s*\?/);
  });

  it('Cash Flow: penerimaan Bagian SHU = OPERASI', () => {
    expect(baca('src/accounting/CashFlowClassification.ts')).toMatch(/^\s*BAGIAN_SHU_PENERIMAAN: 'OPERASI',/m);
  });
});

describe('RC-S54 T16 GAP 6 — Daftar Aset Tetap: Pelepasan & Koreksi Salah Input (kontrak statis)', () => {
  const ui = strip(baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx'));

  it('aksi Pelepasan membuka alur pelepasan (lepaskanAsetTetap); Koreksi Salah Input memakai hapusAset; hanya aset AKTIF', () => {
    expect(ui).toMatch(/onPress=\{\(\) => bukaPelepasan\(item\)\}/);
    expect(ui).toMatch(/>Pelepasan<\/Text>/);
    expect(ui).toMatch(/>Koreksi Salah Input<\/Text>/);
    expect(ui).toMatch(/await lepaskanAsetTetap\(input\)/);
    expect(ui).toMatch(/await pratinjauPelepasanAsetTetap\(input\)/);
    expect(ui).toMatch(/await hapusAset\(\{ id: hapusTarget\.id/);
    expect(ui).toMatch(/canEdit && item\.status === 'AKTIF' && \(/);
  });

  it('default hasil & rekening kosong (tidak dari biaya); rekening hanya bila hasil > 0; preview disabled bila input belum valid; konfirmasi hanya dengan pratinjau', () => {
    expect(ui).toMatch(/setLepasHasil\(''\);\s*setLepasRekening\(null\);/);
    expect(ui).not.toMatch(/setLepasHasil\((String\()?[^)'"]*(nilaiPerolehan|nilaiBuku)/);
    expect(ui).toMatch(/\{hasilPositif && \(\s*<RekeningPicker/);
    expect(ui).toMatch(/\(!hasilPositif \|\| !!lepasRekening\)/);
    expect(ui).toMatch(/onPress=\{hitungPratinjau\}\s*disabled=\{!inputLepasValid\}/);
    expect(ui).toMatch(/disabled=\{!pratinjau \|\| processing\}/);
    expect(ui).toMatch(/if \(!input \|\| !pratinjau\) return;/);
    expect((ui.match(/batalkanPratinjau\(\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('modal menampilkan seluruh field wajib; nilai buku & laba/rugi dari pratinjau service; pesan tanpa kode teknis', () => {
    for (const label of ['Nama Aset', 'Nomor Aset', 'Tanggal Perolehan', 'Biaya Perolehan', 'Akumulasi Penyusutan', 'Nilai Buku', 'Tanggal Pelepasan', 'Hasil Pelepasan', 'Rekening Kas/Bank', 'Laba/Rugi Pelepasan', 'Status validasi', 'Konfirmasi Pelepasan']) {
      expect(ui).toContain(label);
    }
    expect(ui).toMatch(/pratinjau\.nilaiBuku/);
    expect(ui).toMatch(/pratinjau\.jenisSelisih === 'RUGI'/);
    expect(ui).toMatch(/replace\(\/\^\[A-Z\]\[A-Z0-9_\]\+:\\s\*\/, ''\)/);
    expect(ui).toContain('gunakan tombol "Pelepasan"');
  });
});
