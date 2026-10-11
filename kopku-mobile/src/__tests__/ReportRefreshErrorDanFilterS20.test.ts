import * as fs from 'fs';
import * as path from 'path';

/**
 * ============================================================
 * S20/§S–§T — KETAHANAN ERROR & PERSISTENSI FILTER 6 LAYAR LAPORAN
 * ============================================================
 *
 * MELENGKAPI, BUKAN MENGGANTI `ReportFocusRefresh.test.ts` (S18/S19),
 * yang sudah menguji §B (satu lifecycle `useFocusRefresh`, penjaga
 * balapan terpasang, handler periode tidak memuat data) dan §C (lapis
 * data benar-benar mutakhir). Tidak ada satu pun test lama yang
 * dihapus atau dilonggarkan.
 *
 * BATAS KEJUJURAN (§AH/§AL):
 * Berkas ini TETAP source-level. Verifikasi RENDER tidak mungkin
 * dilakukan di lingkungan ini — `react-test-renderer`,
 * `@testing-library/react-native`, `react-native`, dan
 * `@react-navigation/native` TIDAK terpasang, dan registry npm
 * diblokir (403). Peristiwa focus/blur navigator karena itu tidak
 * dapat disimulasikan. Status yang dilaporkan:
 * NOT VERIFIED BY RENDER — perlu verifikasi perangkat (§U).
 */

const LAYAR: { nama: string; berkas: string }[] = [
  { nama: 'Laba Rugi (LHU)', berkas: 'LabaRugiScreen.tsx' },
  { nama: 'Arus Kas', berkas: 'ArusKasScreen.tsx' },
  { nama: 'Perubahan Ekuitas', berkas: 'PerubahanEkuitasScreen.tsx' },
  { nama: 'Buku Besar', berkas: 'BukuBesarScreen.tsx' },
  { nama: 'Kolektibilitas Piutang', berkas: 'KolektibilitasPiutangScreen.tsx' },
  { nama: 'CALK', berkas: 'CalkScreen.tsx' },
];

function sumber(berkas: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'screens', 'Laporan', berkas), 'utf8');
}

/**
 * Buang komentar tetapi PERTAHANKAN panjang berkas (diganti spasi),
 * supaya indeks posisi tetap sebanding dengan sumber aslinya.
 * Tanpa ini, kata seperti "await" di dalam komentar penjelas ikut
 * terhitung sebagai kode dan membuat analisis urutan salah.
 */
function tanpaKomentar(kode: string): string {
  return kode
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Isi blok catch pertama pada fungsi pemuat layar. */
function blokCatch(kode: string): string {
  const i = kode.indexOf('} catch');
  expect(i).toBeGreaterThan(-1);
  const sisa = kode.slice(i);
  const akhir = sisa.indexOf('} finally');
  return akhir > -1 ? sisa.slice(0, akhir) : sisa.slice(0, sisa.indexOf('\n    }'));
}

// ============================================================
// §S — REFRESH GAGAL TIDAK MENGOSONGKAN DATA VALID
// ============================================================
describe('§S — kegagalan refresh tidak menimpa data lama dengan kosong', () => {
  it.each(LAYAR)('$nama: blok catch TIDAK mereset data ke null/kosong', ({ berkas }) => {
    const c = blokCatch(sumber(berkas));
    // Yang dilarang: menghapus hasil valid hanya karena refresh gagal.
    // Untuk laporan keuangan, layar yang tiba-tiba menampilkan nol
    // lebih berbahaya daripada layar yang menampilkan angka lama
    // disertai pesan error.
    expect(c).not.toMatch(/setData\(\s*(null|\[\]|\{\})\s*\)/);
    expect(c).not.toMatch(/setRows\(\s*\[\]\s*\)/);
    expect(c).not.toMatch(/setBaris\(\s*\[\]\s*\)/);
  });

  it.each(LAYAR)('$nama: kegagalan DILAPORKAN, tidak ditelan diam-diam', ({ berkas }) => {
    const c = blokCatch(sumber(berkas));
    expect(c).toMatch(/setError\(/);
  });

  it.each(LAYAR)('$nama: penjaga balapan juga berlaku di jalur error', ({ berkas }) => {
    const c = blokCatch(sumber(berkas));
    // Tanpa ini, error dari permintaan BASI akan menimpa hasil
    // permintaan yang lebih baru dan sudah berhasil.
    expect(c).toContain('permintaan.masihTerbaru(token)');
  });

  it.each(LAYAR)('$nama: loading dimatikan hanya oleh permintaan terbaru', ({ berkas }) => {
    const kode = sumber(berkas);
    const i = kode.indexOf('} finally');
    expect(i).toBeGreaterThan(-1);
    const f = kode.slice(i, i + 400);
    expect(f).toContain('permintaan.masihTerbaru(token)');
    expect(f).toContain('setLoading(false)');
  });
});

// ============================================================
// §R — TOKEN BALAPAN DIAMBIL SEBELUM await PERTAMA
// ============================================================
describe('§R — urutan pengambilan token penjaga balapan', () => {
  it.each(LAYAR)('$nama: permintaan.mulai() dipanggil SEBELUM await mana pun', ({ berkas }) => {
    const kode = tanpaKomentar(sumber(berkas));
    const iToken = kode.indexOf('permintaan.mulai()');
    expect(iToken).toBeGreaterThan(-1);

    // Cari `await` pertama SETELAH awal fungsi pemuat, bandingkan
    // posisinya. Kalau token diambil sesudah await, dua pemuatan bisa
    // memperoleh token yang sama dan penjaganya tidak berfungsi.
    const awalFungsi = Math.max(
      kode.lastIndexOf('const load = useCallback', iToken),
      kode.lastIndexOf('const muat = useCallback', iToken)
    );
    expect(awalFungsi).toBeGreaterThan(-1);
    const iAwait = kode.indexOf('await', awalFungsi);
    expect(iAwait).toBeGreaterThan(iToken);
  });

  it.each(LAYAR)('$nama: setiap penulisan state hasil dijaga masihTerbaru', ({ berkas }) => {
    const kode = sumber(berkas);
    // Jumlah penjaga minimal sebanyak titik keluar yang menulis state:
    // sukses, error, dan finally.
    const penjaga = kode.match(/permintaan\.masihTerbaru\(token\)/g) ?? [];
    expect(penjaga.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
// §T — PERSISTENSI FILTER / PERIODE
// ============================================================
describe('§T — periode & filter bertahan melintasi refresh fokus', () => {
  it.each(LAYAR)('$nama: pemuatan tidak menyetel ulang periode', ({ berkas }) => {
    const kode = sumber(berkas);
    const awal = Math.max(
      kode.indexOf('const load = useCallback'),
      kode.indexOf('const muat = useCallback')
    );
    const fungsi = kode.slice(awal, kode.indexOf('[permintaan]', awal) + 20);
    // Kalau pemuat menyetel periode, refresh saat fokus akan
    // melemparkan pengguna kembali ke periode default — persis keluhan
    // yang diperbaiki S18.
    expect(fungsi).not.toMatch(/setPeriode\(/);
  });

  it('Buku Besar: tombol "Tampilkan" tetap ada dan penanda tetap ref (regresi S18/S19)', () => {
    const kode = sumber('BukuBesarScreen.tsx');
    expect(kode).toContain('onPress={load}');
    expect(kode).toContain('const pernahDitampilkan = useRef(false)');
  });

  it('CALK: state penyuntingan tidak direset oleh pemuatan ulang', () => {
    const kode = sumber('CalkScreen.tsx');
    const awal = Math.max(
      kode.indexOf('const load = useCallback'),
      kode.indexOf('const muat = useCallback')
    );
    const fungsi = kode.slice(awal, kode.indexOf('[permintaan]', awal) + 20);
    // Refresh yang membuang teks catatan yang sedang diketik pengguna
    // adalah kehilangan data, bukan sekadar gangguan tampilan.
    expect(fungsi).not.toMatch(/setEditing\(|setSedangEdit\(|setDraft\(\s*(null|'')\s*\)/);
  });

  it.each(LAYAR.filter((l) => l.berkas !== 'BukuBesarScreen.tsx'))(
    '$nama: mode komparatif (bila ada) menjadi dependensi pemuat, bukan direset',
    ({ berkas }) => {
      const kode = sumber(berkas);
      if (!/komparatif/i.test(kode)) return; // layar ini memang tidak punya mode komparatif
      const awal = Math.max(
        kode.indexOf('const load = useCallback'),
        kode.indexOf('const muat = useCallback')
      );
      const fungsi = kode.slice(awal, kode.indexOf('[permintaan]', awal) + 20);
      expect(fungsi).not.toMatch(/setKomparatif\(\s*false\s*\)/);
    }
  );
});

// ============================================================
// §P — CATATAN LINGKUNGAN (dieksekusi, bukan sekadar klaim)
// ============================================================
describe('§P — ketersediaan dependensi render test', () => {
  it('react-test-renderer & @testing-library/react-native TIDAK terpasang -> render test mustahil', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    );
    const semua = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(semua['react-test-renderer']).toBeUndefined();
    expect(semua['@testing-library/react-native']).toBeUndefined();

    // Test ini SENGAJA mengunci fakta lingkungan. Kalau suatu saat
    // dependensinya dipasang, test ini GAGAL — dan itulah sinyal bahwa
    // §Q (render test per layar) akhirnya bisa dikerjakan.
  });
});
