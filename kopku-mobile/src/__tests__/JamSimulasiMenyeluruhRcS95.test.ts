import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * RC-S95 — SELURUH "hari ini" bisnis mengikuti jam aplikasi (Mode
 * Pengujian Waktu), atas permintaan pengguna ("buat semua mengikuti jam
 * waktu simulasi").
 *
 * YANG TETAP JAM ASLI — sengaja, bukan kelalaian:
 *   - cap waktu audit (`created_at`, `updated_at`, `audit_log.tanggal/waktu`,
 *     `posted_at`): jejak forensik "kapan sesuatu BENAR-BENAR terjadi";
 *   - lisensi (jam tahan-rollback) & hitung mundurnya di Dashboard: jam
 *     simulasi di masa depan akan mengunci "jam tertinggi" lisensi dan
 *     membuat aplikasi terkunci begitu kembali ke waktu asli;
 *   - kunci otomatis PIN & pengukuran durasi (StartupTasks, progres bayar
 *     utang, self-test kriptografi): mengukur waktu yang BENAR-BENAR berlalu;
 *   - nama file backup: pengurut titik restore;
 *   - jam pembanding "waktu asli" di layar Developer & tahun hak cipta.
 */

/*
 * Catatan: `PinjamanService.editPencairanPinjaman` (tanggal jurnal koreksi
 * sumber dana) ikut diubah ke jam aplikasi, tetapi TIDAK diuji perilakunya:
 * `cekPencairanAmanDiubah` saat ini SELALU menolak edit pencairan, sehingga
 * jurnal itu tidak pernah terbentuk. Perubahannya dijaga oleh penjaga pola
 * `format(new Date(), ...)` di bawah — kalau jalur itu diaktifkan lagi,
 * tanggalnya sudah benar.
 */

// ---------------------------------------------------------------------------
// PENJAGA POLA — jam asli tidak boleh menyusup lagi ke tanggal BISNIS.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '..', '..');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function berkasProduksi(dir: string): string[] {
  const hasil: string[] = [];
  for (const nama of readdirSync(dir)) {
    const p = join(dir, nama);
    if (statSync(p).isDirectory()) {
      if (nama === '__tests__' || nama === 'test-utils') continue;
      hasil.push(...berkasProduksi(p));
    } else if (/\.(ts|tsx)$/.test(nama)) {
      hasil.push(p);
    }
  }
  return hasil;
}

const BERKAS = [...berkasProduksi(join(ROOT, 'src')), ...berkasProduksi(join(ROOT, 'app'))].map((p) => ({
  rel: relative(ROOT, p),
  src: tanpaKomentar(readFileSync(p, 'utf8')),
}));

function pelanggaran(pola: RegExp, izin: string[] = []): string[] {
  return BERKAS.filter((b) => !izin.includes(b.rel) && pola.test(b.src)).map((b) => b.rel);
}

describe('RC-S95 — penjaga pola jam asli pada tanggal bisnis', () => {
  it('kalender tidak dibatasi jam asli (maximumDate/minimumDate={new Date()})', () => {
    expect(pelanggaran(/(maximumDate|minimumDate)=\{new Date\(\)\}/)).toEqual([]);
  });

  it('tidak ada format(new Date(), ...) — tanggal transaksi dari jam asli', () => {
    expect(pelanggaran(/format\(new Date\(\),/)).toEqual([]);
  });

  it('tidak ada new Date().toISOString() yang dipotong jadi tanggal/masa (jam asli + UTC)', () => {
    expect(pelanggaran(/new Date\(\)\.toISOString\(\)\.(slice|substring|substr|split)\(/)).toEqual([]);
  });

  it('tidak ada new Date().getFullYear() — kecuali tahun hak cipta di layar pembuka', () => {
    expect(pelanggaran(/new Date\(\)\.getFullYear\(\)/, ['src/components/SplashIntro.tsx'])).toEqual([]);
  });

  it('tidak ada parameter default "= new Date()" — default harus jam aplikasi', () => {
    expect(pelanggaran(/:\s*Date\s*=\s*new Date\(\)/)).toEqual([]);
  });

  it('penjaga benar-benar memindai kode produksi (bukan daftar kosong)', () => {
    expect(BERKAS.length).toBeGreaterThan(300);
    expect(BERKAS.some((b) => b.rel === 'src/services/PinjamanService.ts')).toBe(true);
  });
});

describe('RC-S95 — DatePicker', () => {
  const src = tanpaKomentar(readFileSync(join(ROOT, 'src/components/DatePicker.tsx'), 'utf8'));

  it('field kosong membuka kalender di "hari ini" jam aplikasi', () => {
    expect(src).toMatch(/return getWaktuSekarang\(\);/);
  });

  it('batas tanggal dinormalkan per hari & di-memo, maksimum inklusif sampai akhir hari', () => {
    expect(src).toMatch(/const batasMaks = useMemo\(\(\) => \(kunciMaks \? akhirHari\(kunciMaks\) : undefined\), \[kunciMaks\]\)/);
    expect(src).toMatch(/d\.setHours\(23, 59, 59, 999\)/);
    expect(src).toMatch(/maximumDate=\{batasMaks\}/);
    expect(src).toMatch(/minimumDate=\{batasMin\}/);
  });
});
