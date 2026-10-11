import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S44 — UI PENETAPAN KEBIJAKAN PENARIKAN DINI.
 *
 * KENAPA LAYAR INI DIBUTUHKAN.
 * Seluruh mesin penarikan dini sudah ada sejak RC-S21. Yang menghalangi
 * eksekusi bukan kode, melainkan tidak adanya baris kebijakan di
 * database. Selama ini satu-satunya cara mengisinya adalah menulis
 * langsung ke tabel — tanpa validasi, tanpa audit trail, tanpa
 * versioning.
 *
 * SIFAT PALING PENTING YANG DIKUNCI DI SINI: layar ini TIDAK BOLEH
 * mengisi angka kebijakan apa pun. Field kosong berarti "pengurus belum
 * memutuskan", dan itu berbeda dari `0` yang berarti "diputuskan tidak
 * ada". Aplikasi yang mengisi 0 sebagai default sedang mengarang
 * kebijakan koperasi.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const layarSumber = read('src/screens/Simpanan/KebijakanPenarikanDiniScreen.tsx');
const layar = tanpaKomentar(layarSumber);

describe('D. tidak ada angka kebijakan yang dikarang', () => {
  it('seluruh field numerik dimulai KOSONG, bukan nol', () => {
    // Regex literal, bukan `new RegExp` dengan string: escaping ganda di
    // dalam string mudah rusak dan menghasilkan pola yang tidak pernah
    // cocok — test yang gagal karena polanya salah, bukan karena kodenya.
    expect(layar).toMatch(/const \[nilaiPenalti, setNilaiPenalti\] = useState\(''\)/);
    expect(layar).toMatch(/const \[nilaiBiayaAdmin, setNilaiBiayaAdmin\] = useState\(''\)/);
    // DIPERBARUI (penyederhanaan kebijakan, instruksi pengguna): nilai bunga
    // hangus & rate penarikan dini TIDAK lagi diisi di formulir. Keduanya
    // dikirim null (bukan 0) oleh pemetaan murni — lihat helper.
    const { keParameterKebijakan } = require('@/utils/kebijakanDiniSederhana');
    const t = keParameterKebijakan({ penalti: 'TIDAK_ADA', bunga: 'DIBAYAR', biaya: 'TIDAK_ADA' });
    expect(t.nilaiForfeiture).toBeNull();
    expect(t.rateDini).toBeNull();
    // Tiga keputusan dimulai belum terpilih.
    expect(layar).toMatch(/const \[pilihanPenalti, setPilihanPenalti\] = useState<PilihanPenalti \| null>\(null\)/);
    expect(layar).toMatch(/const \[pilihanBunga, setPilihanBunga\] = useState<PilihanBunga \| null>\(null\)/);
    expect(layar).toMatch(/const \[pilihanBiaya, setPilihanBiaya\] = useState<PilihanBiaya \| null>\(null\)/);
  });

  it('field kosong dikirim sebagai null, tidak dikonversi menjadi 0', () => {
    // `Number('') === 0` — itu jebakannya. Konversi harus memeriksa
    // string kosong LEBIH DULU.
    expect(layar).toMatch(/if \(bersih === ''\) return null;/);
    // DIPERBARUI: nilai hanya dikirim bila komponennya dipilih; selain itu null.
    expect(layar).toMatch(/nilaiPenalti: adaPenalti \? keAngka\(nilaiPenalti\) : null/);
    expect(layar).toMatch(/nilaiBiayaAdmin: adaBiaya \? keAngka\(nilaiBiayaAdmin\) : null/);
  });

  it('tidak ada literal persentase atau nominal sebagai default', () => {
    const pengaturanState = layar.slice(0, layar.indexOf('const muat'));
    expect(pengaturanState).not.toMatch(/useState\((?:0|1|2|5|10)\)/);
    expect(pengaturanState).not.toMatch(/useState\('(?:0|1|2|5|10)'\)/);
  });

  it('pilihan kebijakan dimulai belum terpilih (null)', () => {
    // Termasuk `diizinkan`: pengurus harus memutuskannya secara sadar.
    expect(layar).toMatch(/const \[diizinkan, setDiizinkan\] = useState<boolean \| null>\(null\)/);
    expect(layar).toMatch(/if \(diizinkan === null\)/);
  });
});

describe('B+F. memakai service & versioning existing', () => {
  it('memanggil simpanKebijakanDini, bukan menulis tabel sendiri', () => {
    expect(layar).toMatch(/await simpanKebijakanDini\(\{/);
    expect(layar).not.toMatch(/INSERT INTO|UPDATE simpanan_berjangka_kebijakan_dini/);
  });

  it('membaca status lewat service existing', () => {
    expect(layar).toMatch(/getStatusKebijakanDini\(\)/);
    expect(layar).toMatch(/getKebijakanDiniAktif\(\)/);
  });

  it('tidak membuat tabel atau service kedua', () => {
    expect(layarSumber).toMatch(
      /from '@\/services\/SimpananBerjangkaEarlyWithdrawalService'/
    );
    expect(layar).not.toMatch(/withTransaction|db\.runAsync/);
  });

  it('versi kebijakan wajib diisi sebelum menyimpan', () => {
    expect(layar).toMatch(/if \(versi\.trim\(\) === ''\)/);
  });

  it('menjelaskan bahwa kebijakan lama dinonaktifkan, bukan dihapus', () => {
    expect(layarSumber).toMatch(/Kebijakan lama tidak\s*\n?\s*dihapus/);
  });
});

describe('N. otorisasi memakai permission existing', () => {
  it('service menuntut izin pengaturan:edit', () => {
    const service = read('src/services/SimpananBerjangkaEarlyWithdrawalService.ts');
    expect(service).toMatch(/requirePermission\(db, input\.createdBy, 'pengaturan', 'edit'\)/);
  });

  it('menu memakai resource yang SAMA dengan yang dituntut service', () => {
    // Kalau berbeda, menu bisa terlihat oleh orang yang aksinya akan
    // ditolak — atau sebaliknya, tersembunyi dari orang yang berhak.
    // DIPERBARUI (sentralisasi Tarik Simpanan Anggota — instruksi eksplisit pengguna: Kebijakan Penarikan Dini tidak lagi di Pengaturan).
    // Pintu masuk kini dari Tarik Simpanan Anggota, digerbang resource yang
    // SAMA ('pengaturan') — menu dan aksi di baliknya tetap tidak bisa berbeda.
    const menu = read('src/screens/Pengaturan/PengaturanScreen.tsx');
    expect(menu).not.toMatch(/KebijakanPenarikanDini/);
    const tarik = read('src/screens/Transaksi/TarikSimpananFormScreen.tsx');
    expect(tarik).toMatch(/const bolehBukaKebijakan = can\('pengaturan', 'view'\);/);
    expect(tarik).toMatch(/bolehBukaKebijakan \? \([\s\S]{0,300}navigation\.navigate\('KebijakanPenarikanDini'\)/);
  });

  it("'pengaturan' adalah resource yang sah", () => {
    expect(read('src/config/defaultPermissions.ts')).toMatch(/'pengaturan',/);
  });

  it('menyediakan dasar penetapan & penetap untuk audit trail', () => {
    expect(layar).toMatch(/dasarPenetapan: dasarPenetapan\.trim\(\) \|\| null/);
    expect(layar).toMatch(/ditetapkanOleh: ditetapkanOleh\.trim\(\) \|\| null/);
  });
});

describe('rute terdaftar dan dapat dijangkau', () => {
  const nav = read('src/navigation/RootNavigator.tsx');

  // DIPERBARUI: kini terdaftar di stack Transaksi (bersama Tarik Simpanan).
  it('terdaftar di stack Transaksi', () => {
    expect(nav).toMatch(/<TransaksiStack\.Screen\s+name="KebijakanPenarikanDini"/);
    expect(nav).not.toMatch(/<PengaturanStack\.Screen\s+name="KebijakanPenarikanDini"/);
    expect(nav).toMatch(/component=\{KebijakanPenarikanDiniScreen\}/);
    expect(nav).toMatch(/title: 'Kebijakan Penarikan Dini'/);
  });

  it('layar TIDAK menghitung angka pencairan apa pun', () => {
    // Perhitungan hanya milik EarlyWithdrawalCalculation.
    expect(layar).not.toMatch(/calculateEarlyWithdrawalSettlement|bungaEarnedKontrak/);
  });
});
