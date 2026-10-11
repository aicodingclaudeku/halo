import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LABEL_STATUS_ANGGOTA,
  NADA_STATUS_ANGGOTA,
  labelStatusAnggota,
  nadaStatusAnggota,
  inisialNama,
  ringkasDaftarAnggota,
  JUDUL_MODUL_ANGGOTA,
  SUBJUDUL_MODUL_ANGGOTA,
  LABEL_JENIS_SIMPANAN,
  LABEL_TIPE_SIMPANAN,
  labelJenisSimpanan,
  labelTipeSimpanan,
  tandaTipeSimpanan,
  nadaTipeSimpanan,
  ikonTipeSimpanan,
  type StatusAnggotaTampil,
} from '@/reports/TampilanAnggotaPlan';

/**
 * ============================================================
 * RC-S111 — UI/UX ANGGOTA & SIMPANAN
 * ============================================================
 *
 * BATAS YANG DIJAGA SUITE INI.
 *
 * Perubahan RC-S111 seluruhnya PRESENTASI: lencana status, avatar
 * inisial, pengelompokan field form, kartu. Risikonya bukan tampilan
 * yang jelek — itu terlihat dalam sepuluh detik — melainkan presentasi
 * yang MERAMBAT ke data atau ke aturan:
 *
 *   a. anggota dengan status di luar keempat nilai yang dikenal (data
 *      lama hasil migrasi) TIDAK BOLEH hilang dari daftar;
 *   b. tanda '+'/'-' di depan nominal tidak boleh dikarang — KOREKSI
 *      bisa menambah maupun mengurangi saldo;
 *   c. modul ini tidak boleh dipakai memutuskan boleh-tidaknya sebuah
 *      transaksi; itu tugas service, dan kalau keduanya memutuskan,
 *      cepat atau lambat keduanya akan berbeda.
 */

const BERKAS_MODUL = join(__dirname, '..', 'reports', 'TampilanAnggotaPlan.ts');
const LAYAR_DAFTAR = join(__dirname, '..', 'screens', 'Anggota', 'AnggotaListScreen.tsx');
const LAYAR_FORM = join(__dirname, '..', 'screens', 'Anggota', 'AnggotaFormScreen.tsx');
const LAYAR_HISTORI = join(__dirname, '..', 'screens', 'Simpanan', 'SimpananHistoriScreen.tsx');
const LAYAR_DETAIL_SIMPANAN = join(__dirname, '..', 'screens', 'Simpanan', 'SimpananDetailScreen.tsx');

function tanpaKomentar(teks: string): string {
  return teks
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const SEMUA_STATUS: StatusAnggotaTampil[] = ['AKTIF', 'TIDAK_AKTIF', 'KELUAR', 'MENINGGAL'];

describe('RC-S111 — status anggota dibaca manusia, bukan enum mentah', () => {
  test('keempat status punya label dan nada', () => {
    for (const s of SEMUA_STATUS) {
      expect(LABEL_STATUS_ANGGOTA[s]).toBeTruthy();
      expect(NADA_STATUS_ANGGOTA[s]).toBeTruthy();
    }
    expect(labelStatusAnggota('TIDAK_AKTIF')).toBe('Tidak Aktif');
  });

  test('label tidak pernah memakai garis bawah gaya basis data', () => {
    for (const s of SEMUA_STATUS) expect(LABEL_STATUS_ANGGOTA[s]).not.toContain('_');
  });

  test('status tak dikenal tetap tampil apa adanya, TIDAK hilang', () => {
    // Anggota yang "hilang dari daftar" jauh lebih berbahaya daripada
    // anggota berlencana aneh. Data lama hasil migrasi bisa membawa
    // nilai di luar keempat status ini.
    expect(labelStatusAnggota('ARSIP')).toBe('ARSIP');
    expect(labelStatusAnggota('')).toBe('');
    expect(nadaStatusAnggota('ARSIP')).toBe('netral');
  });

  test('AKTIF dan MENINGGAL tidak pernah sewarna', () => {
    expect(nadaStatusAnggota('AKTIF')).not.toBe(nadaStatusAnggota('MENINGGAL'));
    expect(new Set(SEMUA_STATUS.map((s) => NADA_STATUS_ANGGOTA[s])).size).toBe(4);
  });
});

describe('RC-S111 — inisial avatar', () => {
  test('dua huruf dari kata pertama dan terakhir', () => {
    expect(inisialNama('Ahmad Subekti')).toBe('AS');
    expect(inisialNama('Siti Nur Halimah')).toBe('SH');
  });

  test('gelar dan sapaan tidak mencuri huruf pertama', () => {
    // "H. Ahmad Subekti" berinisial "HA" akan salah: huruf pertamanya
    // milik gelar, bukan orangnya.
    expect(inisialNama('H. Ahmad Subekti')).toBe('AS');
    expect(inisialNama('Ir. Budi Santoso')).toBe('BS');
    expect(inisialNama('Ibu Rina')).toBe('RI');
  });

  test('satu kata, kosong, dan spasi berlebih tidak membuatnya rusak', () => {
    expect(inisialNama('Sukarno')).toBe('SU');
    expect(inisialNama('   Rina   Wati  ')).toBe('RW');
    expect(inisialNama('')).toBe('?');
    expect(inisialNama('H.')).toBe('?');
  });

  test('selalu maksimal dua huruf', () => {
    for (const n of ['Ahmad Subekti', 'Siti Nur Halimah Zahra', 'X', '', 'Ir. Prof. Dr. Budi']) {
      expect(inisialNama(n).length).toBeLessThanOrEqual(2);
    }
  });
});

describe('RC-S111 — ringkasan daftar adalah hitungan orang', () => {
  test('menghitung total dan yang aktif', () => {
    const r = ringkasDaftarAnggota(['AKTIF', 'AKTIF', 'KELUAR']);
    expect(r).toMatchObject({ total: 3, aktif: 2 });
    expect(r.teks).toBe('3 anggota ditampilkan · 2 aktif');
  });

  test('daftar kosong tidak menghasilkan "0 anggota ditampilkan · 0 aktif"', () => {
    expect(ringkasDaftarAnggota([]).teks).toBe('Belum ada anggota');
  });

  test('tidak pernah menerima nominal', () => {
    // Batasnya dijaga bentuk fungsi: satu larik status, tidak ada saldo.
    expect(ringkasDaftarAnggota.length).toBe(1);
    const kode = tanpaKomentar(readFileSync(BERKAS_MODUL, 'utf8'));
    expect(kode).not.toContain('formatRupiah');
    expect(kode).not.toMatch(/from '@\/utils\/money'/);
  });
});

describe('RC-S111 — tanda nominal simpanan tidak boleh dikarang', () => {
  test('SETOR menambah, TARIK mengurangi', () => {
    expect(tandaTipeSimpanan('SETOR')).toBe('+');
    expect(tandaTipeSimpanan('TARIK')).toBe('-');
  });

  test('KOREKSI TIDAK diberi tanda', () => {
    // Rumus lama di layar histori (`tipe === 'TARIK' ? '-' : '+'`)
    // memberi '+' pada koreksi yang sebenarnya bisa MENGURANGI saldo —
    // tanda yang salah tapi terlihat meyakinkan. Lebih baik tanpa
    // tanda daripada tanda yang salah.
    expect(tandaTipeSimpanan('KOREKSI')).toBe('');
    expect(nadaTipeSimpanan('KOREKSI')).toBe('netral');
  });

  test('tipe tak dikenal juga tidak diberi tanda', () => {
    expect(tandaTipeSimpanan('ENTAH')).toBe('');
    expect(nadaTipeSimpanan('ENTAH')).toBe('netral');
    expect(labelTipeSimpanan('ENTAH')).toBe('ENTAH');
  });

  test('label jenis & tipe lengkap dan manusiawi', () => {
    expect(labelJenisSimpanan('SUKARELA')).toBe('Sukarela');
    expect(Object.keys(LABEL_JENIS_SIMPANAN).sort()).toEqual(['POKOK', 'SUKARELA', 'WAJIB']);
    expect(Object.keys(LABEL_TIPE_SIMPANAN).sort()).toEqual(['KOREKSI', 'SETOR', 'TARIK']);
    expect(ikonTipeSimpanan('SETOR')).not.toBe(ikonTipeSimpanan('TARIK'));
  });
});

describe('RC-S111 — layar memakai modul bersama, tidak menyalinnya', () => {
  const daftar = tanpaKomentar(readFileSync(LAYAR_DAFTAR, 'utf8'));
  const form = tanpaKomentar(readFileSync(LAYAR_FORM, 'utf8'));
  const histori = tanpaKomentar(readFileSync(LAYAR_HISTORI, 'utf8'));
  const detail = tanpaKomentar(readFileSync(LAYAR_DETAIL_SIMPANAN, 'utf8'));

  test('daftar anggota memakai lencana, avatar, dan ringkasan dari modul', () => {
    expect(daftar).toContain('labelStatusAnggota(item.status)');
    expect(daftar).toContain('inisialNama(item.namaLengkap)');
    expect(daftar).toContain('ringkasDaftarAnggota(');
    // Sisi kebalikannya: nilai enum mentah tidak boleh kembali
    // dirender sebagai teks baris.
    expect(daftar).not.toContain('{item.status}');
  });

  test('form anggota memakai label status bersama, bukan replace manual', () => {
    expect(form).toContain('labelStatusAnggota(opt)');
    // `opt.replace('_', ' ')` menghasilkan "TIDAK AKTIF" — huruf besar
    // semua dan hanya mengganti SATU garis bawah.
    expect(form).not.toContain("opt.replace('_', ' ')");
  });

  test('histori simpanan memakai tanda & label dari modul', () => {
    expect(histori).toContain('tandaTipeSimpanan(item.tipe)');
    expect(histori).toContain('labelJenisSimpanan(item.jenis)');
    expect(histori).toContain('labelTipeSimpanan(item.tipe)');
    expect(histori).not.toContain("item.tipe === 'TARIK' ? '-' : '+'");
    expect(histori).not.toContain('{item.jenis} · {item.tipe}');
  });

  test('detail simpanan tidak lagi menyalin pemetaan tipe', () => {
    expect(detail).toContain('LABEL_TIPE_SIMPANAN');
    expect(detail).not.toMatch(/SETOR: 'Setoran',\s*\n\s*TARIK: 'Penarikan'/);
  });

  test('judul modul anggota terisi', () => {
    expect(JUDUL_MODUL_ANGGOTA).toBe('DAFTAR ANGGOTA');
    expect(SUBJUDUL_MODUL_ANGGOTA.length).toBeGreaterThan(20);
    expect(daftar).toContain('JUDUL_MODUL_ANGGOTA');
  });
});

describe('RC-S111 — modul tetap presentasi, bukan pengambil keputusan', () => {
  test('tidak mengimpor service, repository, atau basis data', () => {
    const kode = readFileSync(BERKAS_MODUL, 'utf8');
    for (const dilarang of ["@/services/", "@/repositories/", "@/database/", "expo-"]) {
      expect(kode).not.toContain(`from '${dilarang}`);
    }
  });

  test('tidak ada fungsi yang menjawab "boleh atau tidak"', () => {
    // Kalau modul tampilan ikut memutuskan kelayakan transaksi,
    // pemeriksaan itu jadi ADA DI DUA TEMPAT (di sini dan di service)
    // dan cepat atau lambat keduanya akan berbeda.
    const kode = tanpaKomentar(readFileSync(BERKAS_MODUL, 'utf8'));
    expect(kode).not.toMatch(/export function boleh/);
    expect(kode).not.toMatch(/export function validasi/);
  });
});

describe('RC-S111 lanjutan — alat daftar anggota', () => {
  const daftar = tanpaKomentar(readFileSync(LAYAR_DAFTAR, 'utf8'));

  test('Export dipasang di header navigasi, sejajar judul layar', () => {
    // Permintaan pengguna. Di dalam body layar, tombol ini selalu
    // berada dua baris di bawah judul dan ikut memakan tinggi yang
    // seharusnya milik daftar.
    expect(daftar).toContain('navigation.setOptions({');
    expect(daftar).toContain('headerRight: () => (');
    expect(daftar).toContain('variant="header"');
    // useLayoutEffect, bukan useEffect: dengan useEffect header sempat
    // ter-render sekali tanpa tombol dan terlihat berkedip.
    expect(daftar).toMatch(/useLayoutEffect\(\(\) => \{\s*navigation\.setOptions/);
  });

  test('Export tidak ditinggal ganda di body layar', () => {
    // Kalau tertinggal, tombolnya muncul dua kali dan modal formatnya
    // ada dua salinan yang bisa terbuka bersamaan.
    expect((daftar.match(/<ExportButton/g) ?? []).length).toBe(1);
  });

  test('lima penyaring tetap satu baris yang bisa digeser', () => {
    // Membungkus jadi dua baris membuat tinggi area alat berubah-ubah
    // tergantung lebar layar, dan daftar di bawahnya ikut bergeser.
    const alat = daftar.slice(daftar.indexOf('styles.alatBaris'), daftar.indexOf('{loading &&'));
    expect(alat).toContain('horizontal');
    expect(alat).toContain('showsHorizontalScrollIndicator={false}');
    expect(daftar).not.toContain("flexWrap: 'wrap'");
    // Kelima pilihannya sendiri tidak berkurang.
    expect(daftar).toContain('FILTER_STATUS.map((f) =>');
    // Dihitung dari ISI larik, bukan dari pola `{ value: ` yang juga
    // cocok dengan anotasi tipe di barisnya sendiri.
    const larik = daftar.slice(daftar.indexOf('const FILTER_STATUS'), daftar.indexOf('];', daftar.indexOf('const FILTER_STATUS')));
    expect((larik.match(/label: '/g) ?? []).length).toBe(5);
    for (const l of ['Semua', 'Aktif', 'Tidak Aktif', 'Keluar', 'Meninggal']) {
      expect(larik).toContain(`label: '${l}'`);
    }
  });
});
