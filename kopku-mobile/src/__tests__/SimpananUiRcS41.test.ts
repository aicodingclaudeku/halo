import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S41 — PERUBAHAN PRESENTASI: EXPORT HEADER & NOMOR URUT ANGGOTA.
 *
 * Keduanya murni lapisan tampilan, jadi yang diuji adalah SIFAT
 * strukturalnya. Test render tetap perlu dilakukan di perangkat; suite
 * ini menjaga agar sifat-sifat yang mudah bocor kembali tidak hilang
 * tanpa disadari.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('PART M — Export sejajar judul "Simpanan"', () => {
  const layar = read('src/screens/Simpanan/SimpananHistoriScreen.tsx');
  const kode = tanpaKomentar(layar);

  it('layar target adalah yang berjudul "Simpanan" di navigator', () => {
    // §D1 melarang menebak. Judulnya ditetapkan navigator, bukan teks
    // di dalam layar — itulah sebabnya tombol di body layar tidak akan
    // pernah sejajar dengannya.
    const nav = read('src/navigation/RootNavigator.tsx');
    expect(nav).toMatch(
      /name="SimpananHistori"[^\n]*component=\{SimpananHistoriScreen\}[^\n]*title: 'Simpanan'/
    );
  });

  it('Export dipasang lewat headerRight, bukan di body layar', () => {
    expect(kode).toMatch(/headerRight: \(\) => \(/);
  });

  it('memakai useLayoutEffect agar header tidak berkedip', () => {
    // useEffect membuat header ter-render sekali tanpa tombol lebih dulu.
    expect(kode).toMatch(/useLayoutEffect\(\(\) => \{\s*navigation\.setOptions/);
  });

  it('tidak ada tombol Export tersisa di dalam headerRow', () => {
    const headerRow = kode.slice(kode.indexOf('styles.headerRow'), kode.indexOf('</View>', kode.indexOf('styles.headerRow')) + 500);
    expect(headerRow).not.toMatch(/styles\.exportButton/);
  });

  it('tidak memakai posisi absolut untuk menempatkan Export', () => {
    // §D: gunakan Flexbox, hindari absolute positioning.
    //
    // Catatan: potongan diambil dari DEFINISI style (`headerExportButton: {`),
    // bukan dari penggunaannya di JSX (`styles.headerExportButton`).
    // Versi pertama test ini memakai `indexOf('headerExportText')` sebagai
    // batas akhir — dan itu justru menemukan pemakaian di JSX yang letaknya
    // LEBIH AWAL daripada definisi style, sehingga slice-nya terbalik dan
    // mengembalikan string kosong. String kosong lolos `not.toMatch` dan
    // gagal `toMatch`, jadi kegagalannya justru menyelamatkan test ini dari
    // menjadi hijau palsu.
    const awal = kode.indexOf('headerExportButton: {');
    expect(awal).toBeGreaterThan(-1);
    const gaya = kode.slice(awal, awal + 300);
    expect(gaya).not.toMatch(/position:\s*'absolute'/);
    expect(gaya).toMatch(/flexDirection: 'row'/);
    expect(gaya).toMatch(/alignItems: 'center'/);
  });

  it('area sentuh diperlebar untuk layar kecil', () => {
    // Ikon 18px sendiri berada di bawah ambang sentuh yang nyaman.
    expect(kode).toMatch(/hitSlop=\{\{/);
  });

  it('handler export TIDAK berubah — tombol hanya membuka modal', () => {
    expect(kode).toMatch(/onPress=\{\(\) => setExportOpen\(true\)\}/);
    expect(kode).toMatch(/const jalankanExport = async \(format: FormatExport\)/);
    expect(kode).toMatch(/buildSimpananExport/);
    expect(kode).toMatch(/exportLaporan\(/);
  });

  it('punya label aksesibilitas', () => {
    expect(kode).toMatch(/accessibilityLabel="Export data simpanan"/);
  });
});

describe('PART L — nomor urut daftar anggota', () => {
  const layar = read('src/screens/Anggota/AnggotaListScreen.tsx');
  const kode = tanpaKomentar(layar);

  it('nomor berasal dari index tampilan, bukan ID database', () => {
    expect(kode).toMatch(/renderItem=\{\(\{ item, index \}\)/);
    expect(kode).toMatch(/\{index \+ 1\}/);
  });

  it('TIDAK memakai id atau nomorAnggota sebagai nomor urut', () => {
    // Keduanya identitas anggota, bukan posisi. Memakainya akan
    // membuat daftar terlihat melompat setelah difilter.
    const barisNomor = kode.slice(kode.indexOf('styles.nomorUrut'), kode.indexOf('styles.rowIsi'));
    expect(barisNomor).not.toMatch(/item\.id|item\.nomorAnggota/);
  });

  it('nomor urut mengikuti hasil pencarian/filter yang sedang tampil', () => {
    // `data` adalah hasil query yang sudah difilter, dan index dihitung
    // dari sana — jadi penomoran otomatis menyesuaikan.
    expect(kode).toMatch(/data=\{data\}/);
    expect(kode).toMatch(/listAnggota\(\{ search, status/);
  });

  it('tidak ada kolom penomoran baru di skema anggota', () => {
    // §L6: penomoran murni presentasi.
    const schema = read('src/database/schema.ts');
    const tabel = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS anggota ('));
    const blok = tabel.slice(0, tabel.indexOf(');'));
    expect(blok).not.toMatch(/nomor_urut|urutan|display_index/);
  });

  it('nomor urut memakai lebar tetap agar kolom sejajar', () => {
    // Tanpa lebar tetap, "1" dan "10" menggeser nama di sebelahnya.
    expect(kode).toMatch(/nomorUrut: \{[\s\S]{0,200}minWidth: 28/);
    expect(kode).toMatch(/nomorUrut: \{[\s\S]{0,200}textAlign: 'center'/);
  });

  it('nama panjang dipotong, tidak meluber', () => {
    expect(kode).toMatch(/numberOfLines=\{1\}/);
    expect(kode).toMatch(/rowIsi: \{ flex: 1, minWidth: 0 \}/);
  });
});


describe('PART C — nomor urut pada pemilih anggota (Pemberian Pinjaman)', () => {
  const picker = tanpaKomentar(read('src/components/AnggotaPicker.tsx'));

  it('layar Pemberian Pinjaman memakai AnggotaPicker bersama', () => {
    // Menambah nomor di komponen bersama memenuhi permintaan tanpa
    // menduplikasi pemilih anggota untuk satu layar saja.
    const form = read('src/screens/Pinjaman/PinjamanFormScreen.tsx');
    expect(form).toMatch(/import AnggotaPicker from '@\/components\/AnggotaPicker'/);
    expect(form).toMatch(/<AnggotaPicker/);
  });

  it('nomor berasal dari index tampilan', () => {
    expect(picker).toMatch(/renderItem=\{\(\{ item, index \}\)/);
    expect(picker).toMatch(/\{index \+ 1\}/);
  });

  it('TIDAK memakai id atau nomorAnggota sebagai nomor urut', () => {
    const blok = picker.slice(picker.indexOf('styles.rowNomor'), picker.indexOf('styles.rowIsi'));
    expect(blok).not.toMatch(/item\.id|item\.nomorAnggota/);
  });

  it('nomor mengikuti hasil pencarian yang sedang tampil', () => {
    expect(picker).toMatch(/data=\{results\}/);
  });

  it('kolom nomor sejajar dan nama panjang tidak meluber', () => {
    expect(picker).toMatch(/rowNomor: \{[\s\S]{0,200}minWidth: 24/);
    expect(picker).toMatch(/rowIsi: \{ flex: 1, minWidth: 0 \}/);
    expect(picker).toMatch(/numberOfLines=\{1\}/);
  });
});
