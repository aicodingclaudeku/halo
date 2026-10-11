import { readFileSync } from 'fs';
import { join } from 'path';
import * as m from '@/reports/UrutanPenyajianPosisiKeuangan';

/**
 * RC-S53 — TRANCHE 1: PENYAJIAN & FILTER PICKER.
 *
 * Suite ini HANYA menjaga perubahan yang tidak menyentuh akuntansi:
 * urutan baris di layar dan daftar yang boleh muncul di picker. Tidak
 * ada satu pun assertion di sini yang berhak lolos kalau saldo, jurnal,
 * atau klasifikasi akun ikut berubah — karena itu §X juga menguji bahwa
 * helper penyajiannya TIDAK menyaring dan TIDAK menjumlahkan.
 *
 * Dibaca dari source (bukan render): berkasnya `.tsx`, sementara
 * `testMatch` di jest.config.js hanya `*.test.ts` dan
 * `testEnvironment: 'node'` tidak punya transformer JSX. Mengimpornya
 * akan menggagalkan SUITE, bukan assertion-nya.
 */

function read(relatif: string): string {
  return readFileSync(join(__dirname, '..', '..', relatif), 'utf8');
}

function tanpaKomentar(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Ambil isi sebuah array konstanta `readonly string[]` dari source. */
function bacaDaftar(source: string, nama: string): string[] {
  const awal = source.indexOf(`${nama}: readonly string[] =`);
  if (awal < 0) throw new Error(`${nama} tidak ditemukan`);
  const blok = source.slice(awal, source.indexOf('];', awal));
  return [...blok.matchAll(/'([\d-]+)'/g)].map((m) => m[1]);
}

const posisi = read('src/screens/Laporan/PosisiKeuanganScreen.tsx');
const posisiBersih = tanpaKomentar(posisi);
// DIPERBARUI Poin 9/11: daftar urutan & helper penyajian dipindah ke modul
// bersama supaya layar DAN export memakai urutan yang sama. Invarian yang
// dijaga suite ini tidak berubah — hanya berkas tempatnya diperiksa.
const urutan = read('src/reports/UrutanPenyajianPosisiKeuangan.ts');
const urutanBersih = tanpaKomentar(urutan);

// ---------------------------------------------------------------------------
// §X — urutan penyajian aset
// ---------------------------------------------------------------------------

describe('§X urutan penyajian ASET', () => {
  const aset = bacaDaftar(urutanBersih, 'URUTAN_PENYAJIAN_ASET');
  const pos = (kode: string): number => {
    const i = aset.indexOf(kode);
    if (i < 0) throw new Error(`${kode} tidak terdaftar di URUTAN_PENYAJIAN_ASET`);
    return i;
  };

  it('1-1650 Deposito Berjangka berada DI BAWAH 1-1205 Piutang Jasa Pinjaman', () => {
    expect(pos('1-1650')).toBeGreaterThan(pos('1-1205'));
  });

  it('1-1630 & 1-1640 TETAP di atas 1-1200 Piutang Pinjaman Anggota (§A.1)', () => {
    expect(pos('1-1630')).toBeLessThan(pos('1-1200'));
    expect(pos('1-1640')).toBeLessThan(pos('1-1200'));
  });

  it('Kas & Bank tetap paling atas', () => {
    expect(pos('1-1000')).toBe(0);
    expect(pos('1-1100')).toBe(1);
  });

  it('Poin 11 — RAKU 1-1800 TEPAT di bawah 1-1205 Piutang Jasa Pinjaman', () => {
    expect(pos('1-1800')).toBe(pos('1-1205') + 1);
  });

  it('RAK 1-1800 TETAP di atas Aset Tetap 1-1500 (§A.2)', () => {
    expect(pos('1-1800')).toBeLessThan(pos('1-1500'));
  });

  it('tidak ada kode ganda di daftar urutan', () => {
    expect(new Set(aset).size).toBe(aset.length);
  });
});

// ---------------------------------------------------------------------------
// §X — urutan penyajian ekuitas
// ---------------------------------------------------------------------------

describe('§X urutan penyajian EKUITAS', () => {
  const ekuitas = bacaDaftar(urutanBersih, 'URUTAN_PENYAJIAN_EKUITAS');

  it('3-4000 SHU Tahun Berjalan mendahului 3-3000 Ekuitas Lainnya', () => {
    expect(ekuitas.indexOf('3-4000')).toBeGreaterThan(-1);
    expect(ekuitas.indexOf('3-3000')).toBeGreaterThan(-1);
    expect(ekuitas.indexOf('3-4000')).toBeLessThan(ekuitas.indexOf('3-3000'));
  });

  it('daftar ekuitas benar-benar dipakai untuk menyusun baris', () => {
    expect(posisiBersih).toMatch(
      /ekuitas: urutkanUntukPenyajian\(ekuitas, URUTAN_PENYAJIAN_EKUITAS\)/
    );
  });

  it('memakai helper penyajian yang SAMA dengan aset — bukan penyortir kedua', () => {
    const definisi = urutanBersih.match(/function urutkanUntukPenyajian/g) ?? [];
    expect(definisi.length).toBe(1);
    // Layar tidak mendefinisikan penyortir sendiri.
    expect(posisiBersih).not.toMatch(/function urutkanUntukPenyajian/);
  });

  it('tidak ada kode ganda di daftar urutan', () => {
    expect(new Set(ekuitas).size).toBe(ekuitas.length);
  });
});

// ---------------------------------------------------------------------------
// §X — penyajian TIDAK boleh mengubah angka
// ---------------------------------------------------------------------------

describe('§X penyajian murni posisi baris', () => {
  it('helper tidak menyaring baris (tanpa .filter di dalamnya)', () => {
    const awal = urutanBersih.indexOf('function urutkanUntukPenyajian');
    const badan = urutanBersih.slice(awal, urutanBersih.indexOf('\n}', awal));
    expect(badan).not.toContain('.filter(');
  });

  it('helper tidak menjumlahkan apa pun (tanpa reduce/+= saldo)', () => {
    const awal = urutanBersih.indexOf('function urutkanUntukPenyajian');
    const badan = urutanBersih.slice(awal, urutanBersih.indexOf('\n}', awal));
    expect(badan).not.toContain('.reduce(');
    expect(badan).not.toContain('saldo');
  });

  it('total aset tetap dibaca dari service, bukan dijumlahkan dari baris layar', () => {
    expect(posisiBersih).toMatch(/data\.totalAset/);
  });
});

// ---------------------------------------------------------------------------
// §C — Modal Koperasi, metode TRANSFER hanya rekening BANK
// ---------------------------------------------------------------------------

describe('§C Modal Koperasi — TRANSFER hanya BANK', () => {
  const modal = tanpaKomentar(read('src/screens/Transaksi/ModalFormScreen.tsx'));
  const picker = tanpaKomentar(read('src/components/RekeningPicker.tsx'));

  it('RekeningPicker dipanggil dengan hanyaBank', () => {
    expect(modal).toMatch(/<RekeningPicker[\s\S]{0,200}hanyaBank[\s\S]{0,80}\/>/);
  });

  it('memakai RekeningPicker yang SUDAH ADA — tidak ada picker baru', () => {
    expect(modal).toMatch(/import RekeningPicker from '@\/components\/RekeningPicker'/);
    expect(modal).not.toMatch(/RekeningBankPicker|BankPicker/);
  });

  it('prop hanyaBank benar-benar menyaring jenis BANK', () => {
    expect(picker).toMatch(/hanyaBank \? aktifSaja\.filter\(\(r\) => r\.jenis === 'BANK'\)/);
  });

  it('rekening nonaktif tetap tersaring lebih dulu', () => {
    expect(picker).toContain('aktifSaja');
  });
});

// ---------------------------------------------------------------------------
// §D — 2-1710 disembunyikan dari picker kewajiban
// ---------------------------------------------------------------------------

describe('§D picker kewajiban menyembunyikan 2-1710', () => {
  const pickerSrc = read('src/components/KewajibanAkunPicker.tsx');
  const daftar = bacaDaftar(tanpaKomentar(pickerSrc), 'KODE_AKUN_DISEMBUNYIKAN_PICKER');

  it('2-1710 masuk daftar yang disembunyikan', () => {
    expect(daftar).toContain('2-1710');
  });

  it('2-1210 & 2-1300 TETAP disembunyikan — tidak ada proteksi lama yang hilang', () => {
    expect(daftar).toContain('2-1210');
    expect(daftar).toContain('2-1300');
  });

  it('akun 2-1710 TIDAK dihapus dari COA', () => {
    expect(read('src/config/defaultCOA.ts')).toContain("'2-1710'");
  });

  it('service listAkunKewajiban tidak ikut menyaring — penyaringan murni di layar', () => {
    expect(tanpaKomentar(pickerSrc)).toMatch(
      /daftar\.filter\(\(a\) => !KODE_AKUN_DISEMBUNYIKAN_PICKER\.includes\(a\.kode\)\)/
    );
  });
});

// ---------------------------------------------------------------------------
// §T/§U — istilah RAKU di UI
// ---------------------------------------------------------------------------

describe('§T/§U istilah RAKU', () => {
  const pengeluaran = tanpaKomentar(read('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
  const menuLaporan = tanpaKomentar(
    read('src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx')
  );

  it('menu Pengeluaran memakai label RAKU', () => {
    expect(pengeluaran).toContain('Rekening Antar Kantor/Unit (RAKU)');
  });

  it('deskripsi RAKU mencakup modal tetap, modal tambahan, dan operasional', () => {
    expect(pengeluaran).toMatch(
      /Alokasi internal untuk modal tetap, modal tambahan atau operasional ke unit atau cabang/
    );
  });

  it('deskripsi lama yang hanya menyebut penyaluran sudah tidak dipakai', () => {
    expect(pengeluaran).not.toContain('Penyaluran Dana ke Unit dan Kantor Cabang');
  });

  it('menu Rincian Laporan Lainnya ikut memakai RAKU', () => {
    expect(menuLaporan).toContain('Rekening Antar Kantor/Unit (RAKU)');
  });

  it('rute & tabel RAK di database TIDAK ikut di-rename', () => {
    // Rename skema akan memutus histori tanpa menambah kejelasan.
    expect(pengeluaran).toMatch(/nav\.navigate\('RAKForm'/);
    expect(menuLaporan).toMatch(/route: 'RAKList'/);
  });
});


// ---------------------------------------------------------------------------
// Poin 9/11 — urutan penyajian dipakai layar DAN export, tunggal & komparatif
// ---------------------------------------------------------------------------
describe('Poin 9/11 — satu urutan untuk layar & export', () => {

  it('baris SHU tahun berjalan tampil TEPAT di bawah Cadangan Risiko', () => {
    const rows = [
      { kode: '3-1000', nama: 'Simpanan Pokok' },
      { kode: '3-3000', nama: 'Ekuitas Lainnya' },
      { kode: m.KODE_BARIS_SHU_BERJALAN, nama: 'SHU Tahun Berjalan' },
      { kode: '3-2100', nama: 'Cadangan Risiko' },
      { kode: '3-2000', nama: 'Cadangan Umum' },
    ];
    const kode = m.urutkanUntukPenyajian(rows, m.URUTAN_PENYAJIAN_EKUITAS).map((r) => r.kode);
    expect(kode.indexOf(m.KODE_BARIS_SHU_BERJALAN)).toBe(kode.indexOf('3-2100') + 1);
    expect(kode).toHaveLength(rows.length);
  });

  it('layar memakai kode penanda SHU dan helper dari modul bersama', () => {
    expect(posisiBersih).toMatch(/kode: KODE_BARIS_SHU_BERJALAN/);
    expect(posisiBersih).toMatch(/from '@\/reports\/UrutanPenyajianPosisiKeuangan'/);
  });

  it('export tunggal & komparatif memakai urutan yang sama', () => {
    const builder = tanpaKomentar(read('src/export/ReportTableBuilders.ts'));
    expect(builder).toMatch(/urutkanUntukPenyajian\(data\.aset, URUTAN_PENYAJIAN_ASET\)/);
    expect(builder).toMatch(/urutkanUntukPenyajian\(ekuitasDisajikan, URUTAN_PENYAJIAN_EKUITAS\)/);
    expect(builder).toMatch(/urutkanUntukPenyajian\(gabungSeksi\(data\.sekarang\.aset, data\.pembanding\.aset\), URUTAN_PENYAJIAN_ASET\)/);
    expect(builder).toMatch(/urutkanUntukPenyajian\(ekuitasGabung, URUTAN_PENYAJIAN_EKUITAS\)/);
  });
});
