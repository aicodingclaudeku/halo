import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * RC-S53 — UI BAGIAN SHU (STATIC/UI VERIFIED).
 *
 * RENDER TIDAK DAPAT DIVERIFIKASI di lingkungan ini: jest berjalan pada
 * `testEnvironment: 'node'`, dan `react-test-renderer` maupun
 * `@testing-library/react-native` tidak terpasang (registry npm
 * diblokir) — keterbatasan yang sama sudah didokumentasikan suite lain
 * di repo ini. Karena itu yang diverifikasi di sini adalah hal-hal yang
 * BISA dibuktikan tanpa mount: batas akuntansi, kelengkapan field,
 * validasi, pemanggilan service, dan keterjangkauan rute.
 *
 * Yang paling penting dijaga: layar TIDAK boleh menyentuh SQL atau
 * AccountingEngine sendiri. Seluruh penjurnalan wajib lewat
 * `BagianShuService`.
 */

const SCREEN_PATH = 'src/screens/Transaksi/BagianShuFormScreen.tsx';

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}
function tanpaKomentar(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('UI Bagian SHU — batas akuntansi', () => {
  it('layar ada di lokasi yang konsisten dengan form transaksi lain', () => {
    const berkas = readdirSync(join(__dirname, '..', 'screens', 'Transaksi'));
    expect(berkas).toContain('BagianShuFormScreen.tsx');
  });

  it('NOL SQL akuntansi di layar', () => {
    const src = tanpaKomentar(baca(SCREEN_PATH));
    for (const dilarang of [
      'runAsync', 'execAsync', 'getAllAsync', 'getFirstAsync',
      'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'SELECT ',
    ]) {
      expect(src).not.toContain(dilarang);
    }
  });

  it('NOL pemanggilan AccountingEngine langsung dari layar', () => {
    const src = tanpaKomentar(baca(SCREEN_PATH));
    expect(src).not.toContain('createJournal');
    expect(src).not.toContain('AccountingEngine');
    expect(src).not.toContain('resolveAccountId');
    expect(src).not.toContain('withTransaction');
  });

  it('seluruh aksi akuntansi memanggil BagianShuService', () => {
    const src = tanpaKomentar(baca(SCREEN_PATH));
    expect(src).toMatch(/from '@\/services\/BagianShuService'/);
    expect(src).toContain('catatBagianShuInvestasi(');
    expect(src).toContain('catatPenerimaanBagianShu(');
    expect(src).toContain('listBagianShuInvestasi(');
  });

  it('layar tidak menghitung atau menulis status sendiri', () => {
    const src = tanpaKomentar(baca(SCREEN_PATH));
    // Status hanya dibaca dari baris yang dikembalikan service.
    expect(src).not.toMatch(/status:\s*'LUNAS'/);
    expect(src).not.toMatch(/jumlah_diterima/);
  });
});

describe('UI Bagian SHU — kelengkapan field', () => {
  const src = tanpaKomentar(baca(SCREEN_PATH));

  it('data investasi: picker investasi dan jenis investasi ditampilkan', () => {
    expect(src).toContain('InvestasiPicker');
    expect(src).toContain('LABEL_JENIS_INVESTASI');
  });

  it('event hak: tanggal hak, jenis/nomor/tanggal dokumen, dan nominal ada', () => {
    for (const state of ['tanggalHak', 'jenisDokumen', 'nomorDokumen', 'tanggalDokumen', 'jumlah']) {
      expect(src).toContain(state);
    }
    expect(src).toContain('CurrencyInput');
    expect(src).toContain('DatePicker');
  });

  it('penerimaan: rekening kas/bank, tanggal, nominal, dan nomor referensi ada', () => {
    expect(src).toContain('RekeningPicker');
    expect(src).toContain('tanggalTerima');
    expect(src).toContain('jumlahTerima');
    expect(src).toContain('nomorReferensi');
  });

  it('kedua aksi utama tersedia dengan label yang jelas', () => {
    expect(src).toContain('Akui Bagian SHU');
    expect(src).toContain('Terima Pembayaran');
  });

  it('riwayat menampilkan tanggal, investasi, jenis hasil, nominal, status, journal ID, dan dokumen', () => {
    expect(src).toContain('row.tanggalHak');
    expect(src).toContain('row.namaTujuan');
    expect(src).toContain('Bagian SHU');
    expect(src).toContain('row.jumlah');
    expect(src).toContain('row.sisaPiutang');
    expect(src).toContain('row.journalId');
    expect(src).toContain('row.nomorDokumen');
    expect(src).toContain('labelStatus');
  });

  it('lifecycle status memakai istilah yang konsisten', () => {
    expect(src).toContain("'DITERIMA'");
    expect(src).toContain("'SEBAGIAN'");
    expect(src).toContain("'DIAKUI'");
  });
});

describe('UI Bagian SHU — validasi', () => {
  const src = tanpaKomentar(baca(SCREEN_PATH));

  it('menolak investasi kosong, nominal <= 0, dan dokumen kosong sebelum memanggil service', () => {
    expect(src).toMatch(/if \(!investasi\) e\.investasi =/);
    expect(src).toMatch(/jumlah === '' \|\| jumlah <= 0/);
    expect(src).toMatch(/!jenisDokumen\.trim\(\)/);
    expect(src).toMatch(/!nomorDokumen\.trim\(\)/);
    expect(src).toMatch(/!tanggalDokumen/);
    // Validasi dipanggil lebih dulu, dan gagal = berhenti.
    expect(src).toMatch(/if \(!validate\(\)\) return;/);
  });

  it('penerimaan menolak rekening kosong, nominal <= 0, referensi kosong, dan pelampauan sisa', () => {
    expect(src).toMatch(/if \(!rekening\) e\.rekening =/);
    expect(src).toMatch(/jumlahTerima === '' \|\| jumlahTerima <= 0/);
    expect(src).toMatch(/!nomorReferensi\.trim\(\)/);
    expect(src).toMatch(/jumlahTerima > terimaUntuk\.sisaPiutang/);
    expect(src).toMatch(/if \(!validateTerima\(\)\) return;/);
  });

  it('duplikat & periode tertutup ditolak service, dan pesannya ditampilkan apa adanya', () => {
    // Layar TIDAK menduplikasi aturan ini — ia meneruskan pesan service.
    expect(src).toMatch(/catch \(e\)[\s\S]{0,200}notify\('Gagal'/);
    expect(src).toContain("e instanceof Error ? e.message");
  });

  it('tombol dinonaktifkan selama submit berjalan', () => {
    expect(src).toContain('disabled={submitting}');
    expect(src).toContain('disabled={submittingTerima}');
    expect(src).toContain('ActivityIndicator');
  });

  it('service dipanggil dengan seluruh field yang diminta kebijakan', () => {
    for (const field of [
      'investasiId:', 'tanggalHak,', 'jumlah,', 'jenisDokumen:', 'nomorDokumen:',
      'tanggalDokumen,', 'createdBy:',
    ]) {
      expect(src).toContain(field);
    }
    for (const field of ['bagianShuId:', 'sumberDana:', 'bankAccountId:', 'nomorReferensi:']) {
      expect(src).toContain(field);
    }
  });
});

describe('UI Bagian SHU — navigasi', () => {
  it('rute terdaftar sekali di TransaksiStack, dengan import dan judul', () => {
    const nav = baca('src/navigation/RootNavigator.tsx');
    expect(nav).toContain("import BagianShuFormScreen from '@/screens/Transaksi/BagianShuFormScreen';");
    const kemunculan = nav.match(/name="BagianShuForm"/g) ?? [];
    expect(kemunculan).toHaveLength(1);
    expect(nav).toMatch(
      /<TransaksiStack\.Screen name="BagianShuForm" component=\{BagianShuFormScreen\} options=\{\{ title: 'Bagian SHU Investasi' \}\} \/>/
    );
  });

  // RC-S67.8: entri langsung di menu Penerimaan dihapus (duplikat). Titik
  // masuk tunggal kini Pendapatan Koperasi › Bagian SHU; tetap tanpa duplikasi.
  it('dapat dijangkau dari Pendapatan Koperasi (satu titik masuk), bukan langsung dari menu Penerimaan', () => {
    const hub = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));
    expect(hub).not.toContain('BagianShuForm');
    expect(hub).not.toContain('Bagian SHU Investasi');
    expect(hub).toContain("nav.navigate('PendapatanLainnyaMenu')");
    const menu = tanpaKomentar(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));
    expect((menu.match(/route: 'BagianShuForm'/g) ?? []).length).toBe(1);
    expect(menu).toContain("title: 'Bagian SHU'");
  });

  it('back navigation memakai navigator, bukan state sendiri', () => {
    const src = tanpaKomentar(baca(SCREEN_PATH));
    expect(src).toContain("useNavigation");
    // Modal penerimaan punya jalan keluar eksplisit.
    expect(src).toContain('onRequestClose');
    expect(src).toContain('Batal');
  });
});

// RC-S67.6.1: imbal hasil tetap AKTIF, tetapi di layar PendapatanInvestasiForm —
// layar Bagian SHU tetap khusus Bagian SHU (tidak dicampur).
describe('UI Bagian SHU — fitur lain tidak bocor ke layar Bagian SHU', () => {
  const src = tanpaKomentar(baca(SCREEN_PATH));

  it('nol imbal hasil tetap, nol nilai wajar, nol PENGUATAN di layar ini', () => {
    expect(src).not.toMatch(/imbal ?hasil/i);
    expect(src).not.toMatch(/nilai ?wajar/i);
    expect(src).not.toContain('PENGUATAN');
  });

  it('nol pemilihan akun manual — akun berasal dari mapping yang sudah dikunci', () => {
    expect(src).not.toContain('AccountPicker');
    expect(src).not.toContain("'1-1220'");
    expect(src).not.toContain("'4-1300'");
  });
});

describe('Hardening UI — pilihan sumber dana dibatasi di layar', () => {
  const src = tanpaKomentar(baca(SCREEN_PATH));

  it('layar hanya menawarkan Kas Umum dan bank — Kas Kecil tidak ditawarkan', () => {
    expect(src).toMatch(/jenisDiizinkan=\{\['KAS', 'BANK'\]\}/);
    expect(src).not.toContain('KAS_KECIL');
  });

  it('RekeningPicker benar-benar menerapkan filter itu, bukan sekadar menerima prop', () => {
    const picker = tanpaKomentar(baca('src/components/RekeningPicker.tsx'));
    expect(picker).toContain('jenisDiizinkan?: RekeningItem[\'jenis\'][]');
    expect(picker).toMatch(/hasil = hasil\.filter\(\(r\) => jenisDiizinkan\.includes\(r\.jenis\)\)/);
    // Prop opsional: pemanggil lama tidak berubah perilakunya.
    expect(picker).toMatch(/if \(jenisDiizinkan && jenisDiizinkan\.length > 0\)/);
  });

  it('penjagaan service TIDAK dihapus — dua lapis, bukan satu', () => {
    // Filter UI mencegah kesalahan; service yang mencegah misposting.
    expect(src).toMatch(/rekening\.jenis !== 'BANK' && rekening\.jenis !== 'KAS'/);
    const svc = tanpaKomentar(baca('src/services/BagianShuService.ts'));
    expect(svc).toMatch(/sumberDana !== 'KAS' && sumberDana !== 'BANK'/);
  });
});
