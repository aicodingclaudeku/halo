import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S68 — TRANSAKSI RESTRUCTURE: Penyesuaian menjadi kategori utama.
 * Struktural (navigasi & label). Tidak ada logika akuntansi yang diuji
 * ulang di sini karena tidak ada yang diubah.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const hub = strip(baca('src/screens/Transaksi/TransaksiScreen.tsx'));
const pengeluaran = strip(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
const penerimaan = strip(baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));
const penyesuaian = strip(baca('src/screens/Transaksi/PenyesuaianScreen.tsx'));
const nav = strip(baca('src/navigation/RootNavigator.tsx'));
const pendapatan = strip(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));

describe('RC-S68 — navigasi', () => {
  it('TEST A/B/C — Transaksi → Penerimaan, Pengeluaran, Penyesuaian (urut, setara)', () => {
    const a = hub.indexOf("navigate('TransaksiPenerimaan')");
    const b = hub.indexOf("navigate('TransaksiPengeluaran')");
    const c = hub.indexOf("navigate('Penyesuaian')");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect((hub.match(/style=\{styles\.mainCard\}/g) ?? []).length).toBe(3);
    expect(hub).toContain('>Penyesuaian</Text>');
    expect(hub).toContain('>Koreksi dan penyesuaian transaksi</Text>');
    expect(hub).toContain('Kelola aktivitas transaksi koperasi.'); // RC-S68.1 microcopy
  });

  it('TEST D — Pengeluaran → Penyesuaian TIDAK ADA (tanpa sisa entri)', () => {
    expect(pengeluaran).not.toMatch(/Penyesuaian/);
    expect(pengeluaran).not.toMatch(/navigate\('Penyesuaian'\)/);
  });

  it('TEST E/F/G — Penyesuaian → Rekonsiliasi, Nilai Wajar, Impairment (urut) dengan subjudul sederhana', () => {
    const iR = penyesuaian.indexOf("route: 'Rekonsiliasi'");
    const iN = penyesuaian.indexOf("route: 'PenyesuaianNilaiWajar'");
    const iI = penyesuaian.indexOf("route: 'ImpairmentInvestasiForm'");
    expect(iR).toBeGreaterThan(-1);
    expect(iN).toBeGreaterThan(iR);
    expect(iI).toBeGreaterThan(iN);
    // DIPERBARUI RC-S88: subjudul Nilai Wajar mencakup revaluasi aset tetap.
    for (const t of ["'Cocokkan saldo buku dengan saldo eksternal'", "'Nilai wajar properti investasi & revaluasi aset tetap'", "'Catat penurunan nilai investasi'"]) { // DIPERBARUI RC-S81 §7: wording user-facing "saldo aktual" diganti "saldo eksternal".
      expect(penyesuaian).toContain(t);
    }
    expect(penyesuaian).toContain('Kelola koreksi dan penyesuaian transaksi koperasi.');
  });

  it('TEST H — Pengeluaran → Pembelian Aset tetap; Penerimaan → Pendapatan Koperasi → Bagian SHU tetap', () => {
    expect(pengeluaran).toMatch(/title: 'Pembelian Aset'[\s\S]*?nav\.navigate\('PembelianAsetForm'\)/);
    expect(penerimaan).toMatch(/nav\.navigate\('PendapatanLainnyaMenu'\)/);
    expect(pendapatan).toContain("aksi: { route: 'BagianShuForm' }");
  });

  it('TEST I — hierarki kembali natural: semua layar di TransaksiStack yang sama (Rekonsiliasi → Penyesuaian → Transaksi)', () => {
    for (const r of ['TransaksiHub', 'Penyesuaian', 'Rekonsiliasi', 'PenyesuaianNilaiWajar', 'ImpairmentInvestasiForm']) {
      expect((nav.match(new RegExp(`<TransaksiStack\\.Screen name="${r}"`, 'g')) ?? []).length).toBe(1);
    }
    // Hub memakai navigate (push) — bukan replace/reset — sehingga Back kembali ke hub sebelumnya.
    expect(penyesuaian).toContain('onPress={() => navigation.navigate(m.route)}');
    expect(penyesuaian + hub).not.toMatch(/navigation\.(replace|reset)\(/);
  });

  it('satu pintu kanonis: layar penyesuaian hanya dibuka dari hub Penyesuaian', () => {
    const fs = require('fs');
    const pemanggil: string[] = [];
    const telusur = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const p = join(d, f);
        if (fs.statSync(p).isDirectory()) telusur(p);
        else if (/\.tsx$/.test(f)) {
          const s = strip(fs.readFileSync(p, 'utf8'));
          if (/navigate\('(Rekonsiliasi|PenyesuaianNilaiWajar|ImpairmentInvestasiForm|Penyesuaian)'/.test(s) || /route: '(Rekonsiliasi|PenyesuaianNilaiWajar|ImpairmentInvestasiForm)'/.test(s)) {
            pemanggil.push(p.replace(ROOT + '/', ''));
          }
        }
      }
    };
    telusur(join(ROOT, 'src', 'screens'));
    expect(pemanggil.sort()).toEqual(['src/screens/Transaksi/PenyesuaianScreen.tsx', 'src/screens/Transaksi/TransaksiScreen.tsx']);
  });
});
