import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ============================================================
 * RC-S47 — SATU PINTU MASUK PER DOMAIN SIMPANAN
 * ============================================================
 *
 * MASALAH YANG DIKUNCI SUITE INI.
 *
 * Sejak RC-S46 ada DUA jalan untuk membuat kontrak simpanan berjangka:
 *
 *   (a) Penerimaan › Simpanan Berjangka › FAB   (jalur dedicated)
 *   (b) Penerimaan › Setor Simpanan › FAB › chip "Berjangka"
 *
 * Jalur (b) keliru secara domain: "Setor Simpanan" adalah setoran
 * Pokok/Wajib/Sukarela ke saldo anggota, sementara simpanan berjangka
 * adalah PEMBUKAAN KONTRAK dengan tenor, jatuh tempo, akrual bunga, dan
 * subledger sendiri. Dua pintu untuk satu transaksi berarti dua tempat
 * yang harus diperbaiki setiap kali aturannya berubah — dan satu di
 * antaranya pasti terlewat.
 *
 * KENAPA STRUKTURAL (regex), BUKAN RENDER TEST.
 * Suite proyek ini berjalan di Node tanpa renderer React Native
 * (`testEnvironment: 'node'`, tidak ada @testing-library/react-native
 * di package.json). Sifat "chip Berjangka tidak ada di jalur reguler"
 * tidak dapat dibuktikan dengan memanggil fungsi; yang bisa diperiksa
 * adalah bentuk sumbernya. Perlindungan compiler-nya terpisah:
 * `tsconfig.screen-check.json` benar-benar meng-compile layar-layar ini.
 *
 * Keputusan kelayakan pencairan dini TIDAK diuji di sini — ia diuji
 * secara fungsional terhadap service sungguhan di
 * BerjangkaAksiDiniRcS47.test.ts.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const nav = tanpaKomentar(read('src/navigation/RootNavigator.tsx'));
const penerimaan = tanpaKomentar(read('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));
const form = tanpaKomentar(read('src/screens/Simpanan/SimpananFormScreen.tsx'));
const histori = tanpaKomentar(read('src/screens/Simpanan/SimpananHistoriScreen.tsx'));
const berjangka = tanpaKomentar(read('src/screens/Simpanan/SimpananBerjangkaHistoriScreen.tsx'));
const detail = tanpaKomentar(read('src/screens/Simpanan/SimpananBerjangkaDetailScreen.tsx'));
const tarik = tanpaKomentar(read('src/screens/Transaksi/TarikSimpananFormScreen.tsx'));
const identitas = tanpaKomentar(read('src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'));
const dashboard = tanpaKomentar(read('src/screens/Dashboard/DashboardScreen.tsx'));

/** Seluruh rute yang terdaftar di navigator. */
const semuaRute = [...nav.matchAll(/<\w+Stack\.Screen\s+name="(\w+)"/g)].map((m) => m[1]);

// ============================================================
// §B/§S — REGULER dan BERJANGKA tidak pernah bercampur
// ============================================================
describe('§B/§S — Setor Simpanan hanya Pokok/Wajib/Sukarela', () => {
  it('form TIDAK punya chip pemindah mode ke Berjangka', () => {
    // Inilah pintu kedua yang dihapus RC-S47.
    expect(form).not.toMatch(/label="Berjangka"/);
    expect(form).not.toMatch(/setMode\(/);
  });

  it('mode adalah KONSTANTA dari parameter rute, bukan state', () => {
    expect(form).toMatch(
      /const mode: 'REGULER' \| 'BERJANGKA' =\s*route\?\.params\?\.mode === 'BERJANGKA' \? 'BERJANGKA' : 'REGULER';/
    );
    expect(form).not.toMatch(/useState<'REGULER' \| 'BERJANGKA'>/);
  });

  it('FAB jalur reguler membuka form TANPA mode -> REGULER', () => {
    expect(histori).toMatch(/navigate\('SimpananForm'\)/);
    expect(histori).not.toMatch(/navigate\('SimpananForm',/);
  });

  it('layar Setor Simpanan reguler tidak menyinggung kontrak berjangka', () => {
    expect(histori).not.toMatch(/BERJANGKA/);
    expect(histori).not.toMatch(/setorSimpananBerjangka/);
  });

  it('tab jenis di layar reguler tetap hanya tiga jenis', () => {
    const blok = histori.slice(histori.indexOf('const JENIS_TAB'), histori.indexOf('const FORMAT_OPTIONS'));
    expect(blok).toMatch(/'POKOK'/);
    expect(blok).toMatch(/'WAJIB'/);
    expect(blok).toMatch(/'SUKARELA'/);
    expect(blok).not.toMatch(/BERJANGKA/);
  });
});

describe('§S — layar dedicated Berjangka tidak menawarkan jenis reguler', () => {
  it.each([['Pokok'], ['Wajib'], ['Sukarela']])(
    'chip/label "%s" tidak ada di layar Simpanan Berjangka',
    (jenis) => {
      expect(berjangka).not.toMatch(new RegExp(`label="${jenis}"`));
      expect(berjangka).not.toMatch(new RegExp(`'${jenis.toUpperCase()}'`));
    }
  );

  it('detail kontrak juga tidak menawarkan jenis reguler', () => {
    for (const jenis of ['POKOK', 'WAJIB', 'SUKARELA']) {
      expect(detail).not.toMatch(new RegExp(jenis));
    }
  });
});

// ============================================================
// §D — jalur dedicated tetap dapat membuat kontrak
// ============================================================
describe('§D — Simpanan Berjangka adalah halaman utama kontrak', () => {
  it('entry menu Penerimaan menuju rute yang terdaftar', () => {
    expect(penerimaan).toMatch(/title: 'Simpanan Berjangka'/);
    expect(penerimaan).toMatch(/nav\.navigate\('SimpananBerjangkaHistori'\)/);
    expect(semuaRute).toContain('SimpananBerjangkaHistori');
  });

  it('FAB dedicated membuka form dengan mode BERJANGKA', () => {
    expect(berjangka).toMatch(/navigate\('SimpananForm', \{ mode: 'BERJANGKA' \}\)/);
  });

  it('FAB punya label aksesibilitas sesuai §D', () => {
    expect(berjangka).toMatch(/accessibilityLabel="Buat Simpanan Berjangka"/);
  });

  it('ada ringkasan di kepala daftar', () => {
    expect(berjangka).toMatch(/ListHeaderComponent=/);
    expect(berjangka).toMatch(/Ringkasan Kontrak/);
  });

  it('ringkasan TIDAK menjumlahkan uang sendiri', () => {
    // §E: angka keuangan agregat sudah punya sumbernya sendiri
    // (getRingkasanSimpananBerjangka / FullReconciliation). Layar tidak
    // boleh membuat sumber kedua.
    const blok = berjangka.slice(
      berjangka.indexOf('ListHeaderComponent='),
      berjangka.indexOf('renderItem=')
    );
    expect(blok).not.toMatch(/reduce\(/);
    expect(blok).not.toMatch(/formatRupiah/);
  });
});

// ============================================================
// §C — form membedakan entry point secara kasat mata
// ============================================================
describe('§C — wording form mengikuti jalurnya', () => {
  it('jalur berjangka memakai wording penempatan, bukan "Setor Simpanan"', () => {
    expect(form).toMatch(/Penempatan Simpanan Berjangka/);
    expect(form).toMatch(
      /Atur nominal, tenor, tanggal mulai, tanggal jatuh tempo, dan ketentuan bunga sesuai kebijakan koperasi\./
    );
  });

  it('judul header navigasi juga mengikuti mode', () => {
    expect(nav).toMatch(
      /name="SimpananForm"[\s\S]{0,320}mode === 'BERJANGKA'[\s\S]{0,120}Penempatan Simpanan Berjangka/
    );
    expect(nav).toMatch(/name="SimpananForm"[\s\S]{0,400}'Setor Simpanan'/);
  });

  it('service yang dipanggil TIDAK berubah — tidak ada service kedua', () => {
    expect(form).toMatch(/setorSimpananBerjangka\(/);
    expect(form).toMatch(/catatDataAwalSimpanan\(/);
  });
});

// ============================================================
// §E/§M — detail kontrak & back
// ============================================================
describe('§E — kartu kontrak membuka detail', () => {
  it('rute detail terdaftar', () => {
    expect(semuaRute).toContain('SimpananBerjangkaDetail');
  });

  it('kartu kontrak menavigasi ke detail dengan kontrakId', () => {
    expect(berjangka).toMatch(
      /navigate\('SimpananBerjangkaDetail', \{ kontrakId: item\.id \}\)/
    );
  });

  it('kartu benar-benar dapat disentuh, bukan <View> mati', () => {
    // Elemen PERTAMA yang dirender tiap baris harus TouchableOpacity.
    // Inilah yang dulu membuat daftar menjadi jalan buntu: kartunya
    // <View>, jadi menyentuhnya tidak melakukan apa pun.
    expect(berjangka).toMatch(/renderItem=\{\(\{ item \}\) => \(\s*<TouchableOpacity/);
    expect(berjangka).toMatch(/<\/TouchableOpacity>\s*\)\}/);
  });

  it('detail memakai service existing, tanpa data model baru', () => {
    expect(detail).toMatch(/getSimpananBerjangka\(/);
    expect(detail).toMatch(/previewPencairanDini\(/);
    expect(detail).toMatch(/getPencairanDiniKontrak\(/);
    expect(detail).toMatch(/getAnggotaById\(/);
  });

  it('detail tidak menghitung angka keuangan sendiri', () => {
    // Tidak ada aritmetika atas nilai rupiah di layar.
    expect(detail).not.toMatch(/reduce\(/);
    expect(detail).not.toMatch(/nominal\s*[-+*/]\s*/);
    expect(detail).not.toMatch(/bungaTerakru\s*[-+*/]\s*/);
  });

  it.each([
    ['Nomor kontrak', /nomorTransaksi/],
    ['Nama anggota', /Nama Anggota/],
    ['Pokok', /label="Pokok"/],
    ['Tenor', /label="Tenor"/],
    ['Satuan tenor', /label="Satuan Tenor"/],
    ['Tanggal mulai', /label="Tanggal Mulai"/],
    ['Tanggal jatuh tempo', /label="Tanggal Jatuh Tempo"/],
    ['Suku bunga kontrak', /label="Suku Bunga Kontrak"/],
    ['Sisa pokok', /label="Sisa Pokok"/],
    ['Bunga terakru', /label="Bunga Terakru"/],
    ['Tanggal pencairan', /label="Tanggal Pencairan"/],
    ['Versi kebijakan dini', /label="Versi Kebijakan Dini"/],
  ])('detail menampilkan %s', (_nama, pola) => {
    expect(detail).toMatch(pola);
  });
});

describe('§M/§O — back ditangani native stack, tidak dioverride', () => {
  it('detail TIDAK membuat tombol back lokal', () => {
    expect(detail).not.toMatch(/headerLeft/);
    expect(detail).not.toMatch(/name="arrow-back"/);
    expect(detail).not.toMatch(/goBack\(\)/);
  });

  it('tidak ada BackHandler global di seluruh source', () => {
    // §O: BackHandler global mengacaukan seluruh navigator.
    //
    // IdentitasKoperasiScreen TIDAK ada di daftar ini sejak RC-S48:
    // layar itu memasang handler yang TERIKAT FOKUS dan terbatas pada
    // dirinya sendiri (lihat IdentitasNavigasiRcS48.test.ts, yang
    // menguji sifat pembatasannya secara eksplisit). Yang dilarang di
    // sini adalah handler global, bukan handler ber-scope.
    for (const berkas of [
      'src/navigation/RootNavigator.tsx',
      'src/screens/Simpanan/SimpananBerjangkaDetailScreen.tsx',
      'src/screens/Simpanan/SimpananBerjangkaHistoriScreen.tsx',
      'src/screens/Simpanan/SimpananFormScreen.tsx',
      'src/screens/Transaksi/TarikSimpananFormScreen.tsx',
    ]) {
      expect(tanpaKomentar(read(berkas))).not.toMatch(/BackHandler/);
    }
  });

  it('layar terkait tidak memakai replace() yang membuang riwayat', () => {
    // §N: replace() membuat pengguna kehilangan route sebelumnya.
    for (const kode of [detail, berjangka, form, identitas]) {
      expect(kode).not.toMatch(/navigation\.replace\(/);
    }
  });
});

describe('§Q — safe area tanpa angka hardcode', () => {
  it('detail memakai useSafeAreaInsets, bukan paddingTop tetap', () => {
    expect(detail).toMatch(/useSafeAreaInsets\(\)/);
    expect(detail).not.toMatch(/paddingTop:\s*\d/);
  });

  it('FAB berjangka tetap menghormati inset bawah', () => {
    expect(berjangka).toMatch(/bottom: 24 \+ insets\.bottom/);
  });
});

// ============================================================
// §F/§H/§I — aksi pencairan dini pada layar
// ============================================================
describe('§F — CTA memakai flow eksekusi existing, bukan calculator baru', () => {
  it('CTA detail membuka TarikSimpananForm dengan kontrak terpilih', () => {
    expect(detail).toMatch(/navigate\('TarikSimpananForm', \{/);
    expect(detail).toMatch(/jenis: 'BERJANGKA'/);
    expect(detail).toMatch(/kontrakId: kontrak\.id/);
    expect(semuaRute).toContain('TarikSimpananForm');
  });

  it('detail TIDAK memanggil eksekusi pencairan sendiri', () => {
    expect(detail).not.toMatch(/cairkanSimpananBerjangkaDini\(/);
    expect(detail).not.toMatch(/cairkanSimpananBerjangka\(/);
  });

  it('layar Tarik menerima parameter prefill dan tetap memakai service lama', () => {
    expect(tarik).toMatch(/route\?\.params\?\.kontrakId/);
    expect(tarik).toMatch(/cairkanSimpananBerjangkaDini\(/);
    expect(tarik).toMatch(/previewPencairanDini\(/);
  });

  it('prefill hanya sekali — pengguna tetap bisa berpindah kontrak', () => {
    expect(tarik).toMatch(/paramKontrakDipakai\.current/);
  });
});

describe('§H — kebijakan dibaca ulang saat layar difokuskan', () => {
  it('layar Tarik memakai useFocusRefresh, bukan useEffect kosong', () => {
    expect(tarik).toMatch(/useFocusRefresh\(/);
    expect(tarik).toMatch(/getStatusKebijakanDini\(\)/);
    // Pola lama yang menjadi akar masalah tidak boleh kembali.
    expect(tarik).not.toMatch(/useEffect\(\(\) => \{[\s\S]{0,400}getStatusKebijakanDini/);
  });

  it('detail kontrak juga memuat lewat fokus', () => {
    expect(detail).toMatch(/useFocusRefresh\(/);
    expect(detail).not.toMatch(/useEffect\(/);
  });

  it('konvensi hook yang dipakai adalah milik proyek', () => {
    expect(read('src/hooks/useFocusRefresh.ts')).toMatch(/export function useFocusRefresh/);
  });
});

describe('§I/§U — status memakai evaluasi domain, bukan "policy != null"', () => {
  it('kedua layar memakai fungsi keputusan yang SAMA', () => {
    expect(detail).toMatch(/tentukanAksiPencairanDini\(/);
    expect(tarik).toMatch(/tentukanAksiPencairanDini\(/);
  });

  it('tidak ada layar yang menyimpulkan kelayakan dari keberadaan objek', () => {
    for (const kode of [detail, tarik]) {
      expect(kode).not.toMatch(/kebijakan !== null|kebijakan != null|!!kebijakan\s*&&\s*bolehSubmit/);
    }
  });

  it('guard submit lama tetap utuh — tidak dilonggarkan', () => {
    expect(tarik).toMatch(
      /bolehSubmitDini =\s*modeDini && !!previewDini && !previewDini\.alasanTidakBoleh && !!previewDini\.settlement/
    );
    expect(tarik).toMatch(
      /if \(!kontrakDipilih \|\| !currentUser \|\| !previewDini\?\.settlement\) return;/
    );
  });

  it('badge §I ada di layar detail', () => {
    expect(detail).toMatch(/aksi\.badge/);
    expect(detail).toMatch(/disabled=\{!aksi\.ctaAktif\}/);
  });
});

describe('§J — kontrak matur tidak ditawari pencairan dini', () => {
  it('detail memisahkan seksi Jatuh Tempo', () => {
    expect(detail).toMatch(/judul="Jatuh Tempo"/);
    expect(detail).toMatch(/aksi\.tampilkanSeksi/);
  });
});

// ============================================================
// §K — simpan identitas tidak boleh stuck
// ============================================================
describe('§K — Simpan identitas selalu meninggalkan form', () => {
  it('ada fungsi kembali yang dipanggil setelah simpan berhasil', () => {
    // RC-S48 memberi fungsi ini nama `kembali` karena ia kini juga
    // dipakai tombol Back — bukan hanya jalur Simpan. Sifat yang
    // dijaga di sini tidak berubah: Simpan yang sukses meninggalkan
    // form lewat SATU tujuan kembali yang sama.
    expect(identitas).toMatch(/const kembali = useCallback\(\(\) => \{/);
    expect(identitas).toMatch(/const kembaliSetelahSimpan = kembali;/);
    const blokSimpan = identitas.slice(identitas.indexOf('const simpan = async'));
    expect(blokSimpan).toMatch(/kembaliSetelahSimpan\(\)/);
  });

  it('RC-S49b — kembali ke layar pemanggil lewat goBack bawaan', () => {
    // DIPERBARUI RC-S49b. Assertion lama menuntut parameter `asal` dan
    // cabang `navigate('Dashboard')`. Keduanya ada HANYA karena layar
    // ini dulu bersarang di PengaturanStack, sehingga back bawaan
    // mendarat di menu Pengaturan. Rutenya kini independen di
    // RootStack, jadi goBack() bawaan SUDAH mengembalikan pengguna ke
    // Dashboard — tambalan itu dihapus, bukan diganti tambalan lain.
    //
    // Sifat yang dijaga TIDAK berubah: Simpan yang sukses meninggalkan
    // form, dan tujuannya ditentukan asal navigasi (tumpukan), bukan
    // ditebak dari isi data.
    expect(identitas).not.toMatch(/route\?\.params\?\.asal/);
    expect(identitas).not.toMatch(/dariDashboard/);
    expect(identitas).toMatch(/navigation\.navigate\('Tabs', \{ screen: 'Dashboard' \}\)/);
  });

  it('edit dari stack Pengaturan -> goBack ke parent yang benar', () => {
    expect(identitas).toMatch(/navigation\.canGoBack\(\)/);
    expect(identitas).toMatch(/navigation\.goBack\(\);/);
  });

  it('goBack TIDAK pernah dipanggil pada stack kosong (§N)', () => {
    const blok = identitas.slice(
      identitas.indexOf('const kembali = useCallback'),
      identitas.indexOf('const kembaliSetelahSimpan')
    );
    // goBack selalu berada di dalam pemeriksaan canGoBack().
    expect(blok.indexOf('canGoBack()')).toBeGreaterThan(-1);
    expect(blok.indexOf('canGoBack()')).toBeLessThan(blok.indexOf('goBack()'));
  });

  it('RC-S49b — Dashboard membuka rute independen, bukan tab Pengaturan', () => {
    expect(dashboard).toMatch(/navigation\.navigate\('IdentitasKoperasi'\)/);
    expect(dashboard).not.toMatch(/screen: 'IdentitasKoperasi'/);
    expect(dashboard).not.toMatch(/asal: 'DASHBOARD'/);
  });

  it('tidak ada duplikasi menu Identitas Koperasi', () => {
    // Layar ini tetap terdaftar di SATU stack saja.
    expect(semuaRute.filter((r) => r === 'IdentitasKoperasi')).toHaveLength(1);
  });
});

// ============================================================
// §L — first run tetap tertutup dari deep link
// ============================================================
describe('§L — FIRST_RUN tidak dapat dilewati', () => {
  const gate = tanpaKomentar(read('src/components/LicenseGate.tsx'));
  const firstRun = tanpaKomentar(read('src/components/FirstRunSetup.tsx'));

  it('gate merender FirstRunSetup, bukan pohon rute', () => {
    expect(gate).toMatch(/FirstRunSetup/);
  });

  it('FirstRunSetup menyerahkan penyelesaian ke SetupWizard', () => {
    expect(firstRun).toMatch(/SetupWizardScreen/);
    expect(firstRun).toMatch(/onComplete/);
  });
});

// ============================================================
// §X/§Y/§AA — tidak ada jalan pintas
// ============================================================
describe('§AA — tidak ada default kebijakan yang dibuat diam-diam', () => {
  it('tidak ada fallback `??` atas keputusan kebijakan di layar', () => {
    for (const kode of [detail, tarik, tanpaKomentar(read('src/screens/Simpanan/KebijakanPenarikanDiniScreen.tsx'))]) {
      expect(kode).not.toMatch(/jenisPenalti \?\?/);
      expect(kode).not.toMatch(/jenisForfeiture \?\?/);
      expect(kode).not.toMatch(/jenisBiayaAdmin \?\?/);
      expect(kode).not.toMatch(/perlakuanPokok \?\?/);
      expect(kode).not.toMatch(/perlakuanBunga \?\?/);
      expect(kode).not.toMatch(/diizinkan \?\?/);
    }
  });

  it('tidak ada angka penalti/rate yang dikarang di layar', () => {
    for (const kode of [detail, tarik, form]) {
      expect(kode).not.toMatch(/nilaiPenalti\s*=\s*\d/);
      expect(kode).not.toMatch(/rateDini\s*=\s*\d/);
    }
  });
});

describe('§Y — perubahan UI tidak menaikkan versi skema', () => {
  it('SCHEMA_VERSION tetap 58', () => {
    // RC-S47 murni navigasi/UI. Menaikkan versi skema tanpa perubahan
    // skema memaksa migrasi kosong pada setiap perangkat.
    // DIPERBARUI RC-S50. Assertion ini semula MEMATOK angka
    // `SCHEMA_VERSION = 58`, dan itu keliru sebagai penjaga: yang ingin
    // dijamin adalah "pekerjaan RC INI tidak mengubah skema", bukan
    // "skema tidak akan pernah naik lagi". Begitu RC berikutnya
    // melakukan perubahan database yang memang sah (RC-S50 §4:
    // rename nama akun 1-1210, UPDATE data di migrasi v59), assertion
    // versi mutlak gagal tanpa ada yang benar-benar rusak.
    //
    // Sekarang yang diperiksa adalah sifatnya: versinya TIDAK PERNAH
    // TURUN, dan tidak ada satu pun migrasi yang menyebut RC ini —
    // artinya RC ini memang tidak membawa perubahan database.
    const versi = Number(
      /export const SCHEMA_VERSION = (\d+);/.exec(read('src/database/schema.ts'))?.[1]
    );
    expect(versi).toBeGreaterThanOrEqual(58);
    expect(read('src/database/db.ts')).not.toMatch(new RegExp('RC-S47'));
  });
});

describe('§X — berkas yang diubah masuk scope compiler', () => {
  const cfg = read('tsconfig.screen-check.json');

  it.each([
    ['src/screens/Simpanan/SimpananBerjangkaDetailScreen.tsx'],
    ['src/screens/Simpanan/aksiPencairanDini.ts'],
    ['src/screens/Simpanan/SimpananBerjangkaHistoriScreen.tsx'],
    ['src/screens/Simpanan/SimpananFormScreen.tsx'],
    ['src/screens/Transaksi/TarikSimpananFormScreen.tsx'],
    ['src/screens/Simpanan/KebijakanPenarikanDiniScreen.tsx'],
    ['src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'],
  ])('%s ada di tsconfig.screen-check.json', (berkas) => {
    expect(cfg).toContain(berkas);
  });
});
