import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S121 — UI SIMPLIFICATION (struktural).
 *
 *  1. Menu/rute input MANUAL "Pendapatan Diterima Dimuka" dilepas dari UI,
 *     karena pendapatan diterima dimuka dibentuk OTOMATIS oleh sistem
 *     (fee integral & jasa dimuka pinjaman -> akun 2-1300). Mekanisme
 *     otomatis, akun COA, mapping, dan register monitoring TETAP ada.
 *  2. Splash: atribusi "by Kopku" -> "by Alqizani".
 *  3. Pengaturan > Keamanan: PIN & biometric dipindah ke layar sendiri.
 *
 * Render perangkat tidak tersedia di lingkungan ini; yang dikunci adalah
 * kontrak struktural dari source.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));
const rute = [...nav.matchAll(/<(\w+)Stack\.Screen\s+name="(\w+)"/g)].map((m) => ({ stack: m[1], rute: m[2] }));

describe('RC-S121 §1 — input manual Pendapatan Diterima Dimuka dilepas dari UI', () => {
  it('rute PendapatanDimukaForm tidak terdaftar & layarnya tidak diimpor navigator', () => {
    expect(rute.map((r) => r.rute)).not.toContain('PendapatanDimukaForm');
    expect(nav).not.toMatch(/PendapatanDimukaFormScreen/);
  });

  it('tidak ada satu pun layar/komponen yang menavigasi ke PendapatanDimukaForm', () => {
    const fs = require('fs');
    const pemanggil: string[] = [];
    const telusur = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        if (f === '__tests__') continue;
        const p = join(d, f);
        if (fs.statSync(p).isDirectory()) telusur(p);
        else if (/\.(ts|tsx)$/.test(f) && /['"]PendapatanDimukaForm['"]/.test(tanpaKomentar(fs.readFileSync(p, 'utf8')))) {
          pemanggil.push(p);
        }
      }
    };
    telusur(join(ROOT, 'src'));
    telusur(join(ROOT, 'app'));
    expect(pemanggil).toEqual([]);
  });

  it('menu Penerimaan tidak lagi menampilkan Pendapatan Diterima Dimuka; grup Pendapatan tetap ada', () => {
    const terima = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));
    expect(terima).not.toMatch(/title: 'Pendapatan Diterima Dimuka'/);
    expect(terima).toMatch(/grup: 'PENDAPATAN',\s*icon: 'trending-up-outline',\s*title: 'Pendapatan Koperasi'/);
  });

  it('chip kategori manual disembunyikan di form Kas & Bank, konstanta service tidak diubah', () => {
    const form = tanpaKomentar(baca('src/screens/KasBank/KasBankTransaksiFormScreen.tsx'));
    expect(form).toMatch(/\.filter\(\s*\(k\) => k !== 'Pendapatan Diterima Dimuka'\s*\)/);
    // Konstanta tetap memuatnya, supaya transaksi lama berkategori ini tetap terbaca/terfilter.
    expect(baca('src/services/KasBankService.ts')).toMatch(/KATEGORI_PENERIMAAN = \[[\s\S]*?'Pendapatan Diterima Dimuka',/);
  });

  it('register monitoring (Daftar Pendapatan Dimuka) tetap terdaftar & terjangkau, tanpa aksi tambah', () => {
    expect(rute).toContainEqual({ stack: 'Laporan', rute: 'PendapatanDimukaList' });
    expect(tanpaKomentar(baca('src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx'))).toContain("route: 'PendapatanDimukaList'");
    const daftar = tanpaKomentar(baca('src/screens/Akuntansi/PendapatanDimukaListScreen.tsx'));
    expect(daftar).not.toMatch(/navigate\(/);
    expect(daftar).not.toMatch(/Transaksi &gt; Penerimaan &gt; Pendapatan Diterima Dimuka/);
  });

  it('mekanisme otomatis & akun COA tetap utuh', () => {
    const coa = baca('src/config/defaultCOA.ts');
    expect(coa).toMatch(/kode: '2-1300', nama: 'Pendapatan Diterima Dimuka'/);
    for (const m of [
      "transactionType: 'PENDAPATAN_DITERIMA_DIMUKA', role: 'KREDIT_DEFAULT', accountKode: '2-1300'",
      "transactionType: 'PENGAKUAN_PENDAPATAN_DIMUKA', role: 'DEBIT_DIMUKA', accountKode: '2-1300'",
      "transactionType: 'BIAYA_ADMIN_PINJAMAN', role: 'KREDIT_DIMUKA', accountKode: '2-1300'",
      "transactionType: 'EIR_FEE_AMORTIZATION', role: 'DEBIT_DIMUKA', accountKode: '2-1300'",
      "transactionType: 'PELUNASAN_JASA_FUTURE', role: 'KREDIT_DIMUKA', accountKode: '2-1300'",
      "transactionType: 'ANGSURAN_JASA', role: 'KREDIT_DIMUKA', accountKode: '2-1300'",
      "transactionType: 'AKRUAL_JASA_PINJAMAN', role: 'DEBIT_DIMUKA', accountKode: '2-1300'",
    ]) {
      expect(coa).toContain(m);
    }
    const svc = baca('src/services/PendapatanDimukaService.ts');
    for (const fn of ['terimaPendapatanDimuka', 'listPendapatanDimuka', 'getStatusPengakuanPeriode', 'prosesPengakuanPendapatanDimuka', 'jalankanPengakuanPeriode']) {
      expect(svc).toContain(`export async function ${fn}`);
    }
    // Pengakuan bertahap atas register lama tetap dapat dijalankan dari Status Periode.
    expect(tanpaKomentar(baca('src/screens/Akuntansi/StatusPeriodeScreen.tsx'))).toMatch(/await jalankanPengakuanPeriode\(periode, currentUser\.id\)/);
  });
});

describe('RC-S121 §2 — splash "by Alqizani"', () => {
  it('teks atribusi diganti, merek & logo tetap', () => {
    const kode = tanpaKomentar(baca('src/components/SplashIntro.tsx'));
    expect(kode).toContain('>by Alqizani</Text>');
    expect(kode).not.toContain('by Kopku');
    expect(kode).toContain('accessibilityLabel="Kopku Finance"');
  });
});

describe('RC-S121 §3 — Pengaturan > Keamanan', () => {
  const pengaturan = tanpaKomentar(baca('src/screens/Pengaturan/PengaturanScreen.tsx'));
  const keamanan = tanpaKomentar(baca('src/screens/Pengaturan/KeamananScreen.tsx'));

  it('rute Keamanan terdaftar di PengaturanStack dan kartunya ada di Pengaturan', () => {
    expect(existsSync(join(ROOT, 'src/screens/Pengaturan/KeamananScreen.tsx'))).toBe(true);
    expect(rute).toContainEqual({ stack: 'Pengaturan', rute: 'Keamanan' });
    expect(pengaturan).toContain("navigation.navigate('Keamanan')");
    expect(pengaturan).toContain('>Keamanan</Text>');
  });

  it('kartu Keamanan tidak digerbangi permission (di luar array MENU)', () => {
    const blokMenu = pengaturan.slice(pengaturan.indexOf('const MENU'), pengaturan.indexOf('export default function'));
    expect(blokMenu).not.toMatch(/route: 'Keamanan'/);
  });

  it('PIN & biometric TIDAK lagi ada di layar Pengaturan', () => {
    expect(pengaturan).not.toMatch(/<PinInput\b/);
    expect(pengaturan).not.toMatch(/<Switch\b/);
    expect(pengaturan).not.toMatch(/LocalAuthentication|setBiometricEnabled|aturPinKunciAplikasi|setPinEnabled/);
  });

  it('logika PIN & biometric dipindah apa adanya ke KeamananScreen', () => {
    for (const t of [
      "await setPinEnabled(nilaiBaru);",
      "await aturPinKunciAplikasi(currentUser.id, currentUser.id, pinBaru);",
      "await tandaiPinSudahDitetapkan();",
      "resolvePinState({ sesiTerkunci: false })",
      "pinState === 'PIN_ENABLED_SETUP_REQUIRED'",
      "LocalAuthentication.authenticateAsync({",
      "await setBiometricEnabled(currentUser.id, nilaiBaru);",
      "disabled={!biometricTersedia}",
    ]) {
      expect(keamanan).toContain(t);
    }
    expect(keamanan).toMatch(/<AreaAmanKeyboard varian="layar" style=\{\{ flex: 1 \}\}>\s*<ScrollView \{\.\.\.PROP_SCROLL_FORM\}/);
  });
});
