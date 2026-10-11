import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * SETIAP RUTE HARUS PUNYA JALAN MASUK.
 *
 * KENAPA SUITE INI ADA.
 * `SimpananBerjangkaHistori` terdaftar dengan benar di RootNavigator,
 * layarnya benar, servicenya jalan, dan seluruh testnya hijau — tetapi
 * TIDAK ADA satu pun layar yang menavigasi ke sana. Nol pemanggil.
 * Dari sisi pengguna, fitur simpanan berjangka seolah tidak ada.
 *
 * Ini kelas bug yang tidak akan pernah ditangkap compiler maupun test
 * unit: tidak ada yang salah dengan kodenya — yang hilang adalah
 * JALAN MASUKNYA. Satu-satunya cara menangkapnya secara otomatis
 * adalah memeriksa keterjangkauan rute sebagai sifat struktural.
 *
 * Suite ini TIDAK menuntut semua rute terjangkau: empat rute memang
 * sudah yatim sebelum RC-S45 dan masing-masing punya riwayatnya
 * sendiri. Keempatnya didaftarkan eksplisit di bawah supaya
 * keberadaannya menjadi keputusan sadar, bukan kelalaian yang
 * terlupakan — dan supaya rute YATIM BARU tetap gagal.
 */

const ROOT = join(__dirname, '..', '..');

/**
 * Rute yang saat ini tidak punya pemanggil navigasi.
 *
 * DAFTAR INI HANYA BOLEH MENGECIL. Menambah entri baru berarti
 * mengapalkan fitur yang tidak dapat dijangkau pengguna — kalau itu
 * memang disengaja, tulis alasannya di sini.
 */
const YATIM_DIKETAHUI: readonly string[] = [
  // Terdaftar di dua stack; entry menunya belum pernah dibuat.
  'InputDataHub',
  // RC-S70.2 — 'PinjamanKoperasiList' dan 'PemberianPinjamanKoperasiForm'
  // DIHAPUS dari daftar ini karena kedua rutenya memang sudah tidak
  // terdaftar lagi di RootNavigator (fitur legacy "Pemberian Pinjaman
  // untuk Koperasi" dihapus bersama layar & service-nya). Jangan
  // dimasukkan kembali: rute yang tidak ada bukan rute yatim.
  // Layar form saldo awal; hub Saldo Awal memakai SaldoAwalAkunList.
  'SaldoAwalForm',
];

/**
 * RC-S70.2 — rute fitur legacy yang HARUS sudah hilang dari navigator.
 * Kalau salah satunya muncul lagi, fitur yang sudah dihapus terdaftar
 * ulang tanpa disengaja.
 */
const RUTE_DIHAPUS: readonly string[] = ['PinjamanKoperasiList', 'PemberianPinjamanKoperasiForm'];

function berkasSumber(dir: string, hasil: string[] = []): string[] {
  for (const entri of readdirSync(dir)) {
    if (entri === 'node_modules' || entri === '.harness' || entri === '__tests__') continue;
    const penuh = join(dir, entri);
    if (statSync(penuh).isDirectory()) berkasSumber(penuh, hasil);
    else if (/\.(ts|tsx)$/.test(entri)) hasil.push(penuh);
  }
  return hasil;
}

const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const navSumber = readFileSync(join(ROOT, 'src', 'navigation', 'RootNavigator.tsx'), 'utf8');

/** Seluruh rute yang terdaftar. */
function semuaRute(): string[] {
  return [...navSumber.matchAll(/<\w+Stack\.Screen name="(\w+)"/g)].map((m) => m[1]);
}

/** Layar PERTAMA tiap stack = titik masuk tab, tidak perlu pemanggil. */
function titikMasukTab(): string[] {
  const hasil: string[] = [];
  for (const stack of ['Anggota', 'Transaksi', 'Laporan', 'Pengaturan']) {
    const m = new RegExp(`<${stack}Stack\\.Screen name="(\\w+)"`).exec(navSumber);
    if (m) hasil.push(m[1]);
  }
  return hasil;
}

/** Rute yang benar-benar dinavigasikan dari suatu layar. */
function ruteDipanggil(): Set<string> {
  const hasil = new Set<string>();
  const berkas = berkasSumber(join(ROOT, 'src')).filter(
    (f) => !f.endsWith('RootNavigator.tsx')
  );
  const pola = [
    /navigate\(\s*['"](\w+)['"]/g,
    /replace\(\s*['"](\w+)['"]/g,
    /push\(\s*['"](\w+)['"]/g,
    // Menu berbasis data: { route: 'X', ... }
    /route:\s*['"](\w+)['"]/g,
    // Navigasi bersarang: navigate('Tab', { screen: 'X' })
    /screen:\s*['"](\w+)['"]/g,
  ];
  for (const f of berkas) {
    const kode = tanpaKomentar(readFileSync(f, 'utf8'));
    for (const p of pola) {
      for (const m of kode.matchAll(p)) hasil.add(m[1]);
    }
  }
  return hasil;
}

describe('keterjangkauan rute', () => {
  it('menemukan rute untuk diperiksa', () => {
    expect(semuaRute().length).toBeGreaterThan(50);
  });

  it('tidak ada rute yatim BARU di luar daftar yang diketahui', () => {
    const dipanggil = ruteDipanggil();
    const masuk = new Set(titikMasukTab());
    const yatim = semuaRute().filter(
      (r) => !dipanggil.has(r) && !masuk.has(r) && !YATIM_DIKETAHUI.includes(r)
    );
    expect(yatim).toEqual([]);
  });

  it('daftar yatim yang diketahui tidak bertambah', () => {
    // Kalau daftar ini membesar, ada fitur baru yang dikapalkan tanpa
    // jalan masuk. Ia hanya boleh mengecil. RC-S70.2: 4 -> 2 setelah
    // kedua rute "Pemberian Pinjaman untuk Koperasi" benar-benar dihapus
    // dari navigator (bukan sekadar dicoret dari daftar ini).
    expect(YATIM_DIKETAHUI).toHaveLength(2);
  });

  it('RC-S70.2 — rute fitur legacy yang dihapus tidak terdaftar lagi', () => {
    const terdaftar = semuaRute();
    for (const r of RUTE_DIHAPUS) {
      expect(terdaftar).not.toContain(r);
      expect(YATIM_DIKETAHUI).not.toContain(r);
    }
  });

  it('pendeteksinya benar-benar bekerja', () => {
    // Tanpa ini, regex yang rusak akan membuat SEMUA rute tampak
    // terpanggil dan test di atas hijau tanpa memeriksa apa pun.
    const dipanggil = ruteDipanggil();
    expect(dipanggil.has('SimpananHistori')).toBe(true);
    expect(dipanggil.has('BayarAngsuranForm')).toBe(true);
    expect(dipanggil.has('RuteYangTidakPernahAda')).toBe(false);
  });
});

describe('Simpanan Berjangka dapat dijangkau dari menu', () => {
  const penerimaan = tanpaKomentar(
    readFileSync(join(ROOT, 'src', 'screens', 'Transaksi', 'TransaksiPenerimaanScreen.tsx'), 'utf8')
  );

  it('ada entri menu "Simpanan Berjangka"', () => {
    expect(penerimaan).toMatch(/title: 'Simpanan Berjangka'/);
  });

  it('entri itu menavigasi ke rute yang terdaftar', () => {
    expect(penerimaan).toMatch(/nav\.navigate\('SimpananBerjangkaHistori'\)/);
    expect(semuaRute()).toContain('SimpananBerjangkaHistori');
  });

  it('rutenya berjudul "Simpanan Berjangka" di navigator', () => {
    expect(navSumber).toMatch(
      /name="SimpananBerjangkaHistori"[^\n]*title: 'Simpanan Berjangka'/
    );
  });

  it('menu Setor Simpanan tetap ada dan tidak tergeser', () => {
    // Non-regresi: entri baru TIDAK boleh menggantikan yang lama.
    expect(penerimaan).toMatch(/title: 'Setor Simpanan'/);
    expect(penerimaan).toMatch(/nav\.navigate\('SimpananHistori'\)/);
  });

  it('penarikan simpanan berjangka tetap lewat Tarik Simpanan', () => {
    const pengeluaran = tanpaKomentar(
      readFileSync(
        join(ROOT, 'src', 'screens', 'Transaksi', 'TransaksiPengeluaranScreen.tsx'),
        'utf8'
      )
    );
    expect(pengeluaran).toMatch(/TarikSimpananForm/);
  });
});
