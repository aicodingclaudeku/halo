import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S43 — PENCAIRAN AWAL HARUS TERLIHAT, TETAPI TETAP TERTAHAN.
 *
 * ROOT CAUSE yang diperbaiki.
 * `TarikSimpananFormScreen` dulu hanya menjadikan kontrak AKTIF
 * selectable bila kebijakan penarikan dini sudah berlaku:
 *
 *     const selectable =
 *       k.status === 'JATUH_TEMPO' ||
 *       (k.status === 'AKTIF' && statusKebijakanDini?.status === 'AKTIF');
 *
 * Tanpa kebijakan, kartunya kelabu dan tidak dapat disentuh, labelnya
 * hanya "Belum jatuh tempo", dan panel POLICY_REQUIRED di bawahnya
 * TIDAK PERNAH tercapai — karena panel itu membutuhkan kontrak terpilih.
 * Hasilnya pengguna menyimpulkan fitur ini tidak ada.
 *
 * Suite ini mengunci dua sifat SEKALIGUS, dan keduanya harus benar:
 *   1. fitur TERLIHAT walau kebijakan belum ada;
 *   2. transaksi tetap TIDAK DAPAT dieksekusi tanpa kebijakan.
 *
 * Mengunci hanya (1) akan membuka jalan bagi pencairan tanpa aturan.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const layarSumber = read('src/screens/Transaksi/TarikSimpananFormScreen.tsx');
const layar = tanpaKomentar(layarSumber);

describe('Q. Pencairan Awal terlihat', () => {
  it('kontrak AKTIF dapat dipilih tanpa bergantung status kebijakan', () => {
    expect(layar).toMatch(
      /const selectable = k\.status === 'JATUH_TEMPO' \|\| k\.status === 'AKTIF';/
    );
  });

  it('selectable TIDAK lagi mensyaratkan kebijakan aktif', () => {
    const baris = layar.slice(layar.indexOf('const selectable'), layar.indexOf('const selectable') + 200);
    expect(baris).not.toMatch(/statusKebijakanDini/);
  });

  it('label menyebut "Pencairan Awal" walau kebijakan belum ditetapkan', () => {
    // DIPERBARUI (redesign Tarik Simpanan Anggota): label status kontrak kini
    // badge "Penarikan Dini" + keterangan "Kebijakan belum ditetapkan", dari
    // helper tampilan murni. Maksud test sama: fitur tetap disebut walau
    // kebijakan belum ada.
    const { badgeKontrak } = require('@/utils/tarikSimpananUi');
    expect(badgeKontrak('AKTIF', false)).toEqual({ label: 'Penarikan Dini', keterangan: 'Kebijakan belum ditetapkan', nada: 'WARN' });
    expect(layar).toMatch(/badgeKontrak\(k\.status, kebijakanDiniAktif\)/);
  });

  it('ada selector jenis Simpanan Berjangka', () => {
    expect(layar).toMatch(/label="Simpanan Berjangka"/);
  });

  it('ada penjelasan Simpanan Berjangka tanpa menjanjikan angka', () => {
    const penjelasan = layar.slice(layar.indexOf('jenisKeterangan'), layar.indexOf('jenisKeterangan') + 400);
    expect(layarSumber).toMatch(/jangka waktu dan tanggal jatuh tempo sesuai ketentuan koperasi/);
    expect(layarSumber).toMatch(/mengikuti kebijakan penarikan dini koperasi/);
    // §L: tidak boleh menjanjikan apa pun yang belum ditetapkan.
    expect(penjelasan).not.toMatch(/bebas penalti|tanpa penalti|bunga tetap|dijamin/i);
  });
});

describe('E+G. transaksi TETAP tertahan tanpa kebijakan', () => {
  it('bolehSubmitDini menuntut settlement ada DAN tidak ada alasan penolakan', () => {
    expect(layar).toMatch(
      /bolehSubmitDini =\s*modeDini && !!previewDini && !previewDini\.alasanTidakBoleh && !!previewDini\.settlement/
    );
  });

  it('submitPencairanDini memeriksa ulang sebelum mengeksekusi', () => {
    // Lapis kedua: walau tombol entah bagaimana tertekan, handler
    // menolak sendiri.
    expect(layar).toMatch(/if \(!kontrakDipilih \|\| !currentUser \|\| !previewDini\?\.settlement\) return;/);
    expect(layar).toMatch(/if \(previewDini\.alasanTidakBoleh\) \{[\s\S]{0,160}return;/);
  });

  it('panel POLICY_REQUIRED dirender saat kebijakan belum aktif', () => {
    expect(layar).toMatch(
      /modeDini && statusKebijakanDini && statusKebijakanDini\.status !== 'AKTIF'/
    );
  });

  it('layar TIDAK menghitung sendiri angka pencairan', () => {
    // §F: seluruh angka berasal dari previewDini.settlement.
    expect(layar).not.toMatch(/penalti\s*=\s*\d|rate\s*=\s*0\.\d|\*\s*0\.0\d/);
    expect(layar).toMatch(/previewDini\.settlement/);
  });

  it('layar memakai service existing, bukan service kedua', () => {
    expect(layarSumber).toMatch(
      /from '@\/services\/SimpananBerjangkaEarlyWithdrawalService'/
    );
    expect(layar).toMatch(/cairkanSimpananBerjangkaDini\(/);
    expect(layar).toMatch(/cairkanSimpananBerjangka\(/);
  });

  it('tidak ada pembaruan saldo atau jurnal langsung dari layar', () => {
    // §G: UI hanya memanggil service.
    expect(layar).not.toMatch(/UPDATE\s+simpanan|INSERT INTO jurnal|postJurnal\(|Ledger\./);
  });
});

describe('C. jatuh tempo memisahkan dua alur', () => {
  it('modeDini ditentukan status kontrak, bukan hitungan tanggal di UI', () => {
    expect(layar).toMatch(/const modeDini = !!kontrakDipilih && kontrakDipilih\.status === 'AKTIF';/);
  });

  it('kontrak jatuh tempo memakai pencairan normal', () => {
    expect(layar).toMatch(/cairkanSimpananBerjangka\(\{/);
  });

  it('kontrak DICAIRKAN/DIBATALKAN tidak dapat dipilih', () => {
    // §I/§J: kontrak selesai tidak boleh dicairkan ulang.
    const baris = layar.slice(layar.indexOf('const selectable'), layar.indexOf('const selectable') + 200);
    expect(baris).not.toMatch(/DICAIRKAN|DIBATALKAN/);
    // DIPERBARUI (redesign): label dipindah ke helper tampilan.
    const { badgeKontrak } = require('@/utils/tarikSimpananUi');
    expect(badgeKontrak('DICAIRKAN', true).label).toBe('Sudah dicairkan');
  });
});

describe('R. Early Withdrawal tetap SAK EP', () => {
  it('tidak ada referensi EMKM di jalur penarikan dini', () => {
    for (const berkas of [
      'src/screens/Transaksi/TarikSimpananFormScreen.tsx',
      'src/services/SimpananBerjangkaEarlyWithdrawalService.ts',
      'src/accounting/EarlyWithdrawalPolicy.ts',
      'src/accounting/EarlyWithdrawalCalculation.ts',
    ]) {
      expect(tanpaKomentar(read(berkas))).not.toMatch(/EMKM/);
    }
  });
});
