import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S46b — LAYAR HISTORI SIMPANAN BERJANGKA HARUS UTUH.
 *
 * KERUSAKAN YANG DITUTUP.
 * Patch RC-S46 yang menambahkan FAB memotong berkas ini dari penutup
 * `FlatList` sampai AKHIR FILE. Yang hilang: `RincianPencairanDini`,
 * `Baris`, dan seluruh blok `StyleSheet.create` — 37 baris. Berkasnya
 * tetap memanggil ketiganya, jadi ia tidak akan pernah bisa di-bundle.
 *
 * Kenapa lolos: berkas `.tsx` berada DI LUAR jangkauan compiler, dan
 * seluruh test lain hanya membaca sumber dengan regex. Regex tidak
 * peduli apakah identifier yang dipanggil benar-benar terdefinisi.
 *
 * Karena itu perlindungan sesungguhnya BUKAN suite ini, melainkan
 * `tsconfig.screen-check.json` yang benar-benar meng-compile berkas
 * ini. Suite ini melengkapi dengan mengunci ISI yang secara domain
 * harus ada — hal yang compiler tidak tahu, mis. bahwa rincian
 * pencairan dini wajib menampilkan versi kebijakan.
 */

const ROOT = join(__dirname, '..', '..');
const layar = readFileSync(
  join(ROOT, 'src', 'screens', 'Simpanan', 'SimpananBerjangkaHistoriScreen.tsx'),
  'utf8'
);

describe('helper dan style tidak boleh hilang', () => {
  it.each([
    ['function RincianPencairanDini'],
    ['function Baris'],
    ['const styles = StyleSheet.create'],
  ])('%s masih terdefinisi', (identifier) => {
    expect(layar).toContain(identifier);
  });

  it('setiap style yang dipakai benar-benar didefinisikan', () => {
    // Inilah yang membuat kerusakan RC-S46 fatal: berkas memakai 17
    // style sementara objeknya sudah tidak ada sama sekali.
    const dipakai = new Set(
      [...layar.matchAll(/styles\.(\w+)/g)].map((m) => m[1])
    );
    const blok = layar.slice(layar.indexOf('const styles = StyleSheet.create'));
    const kurang = [...dipakai].filter((n) => !new RegExp(`\\b${n}:`).test(blok));
    expect(kurang).toEqual([]);
  });

  it('memakai lebih dari sepuluh style — bukan berkas kosong', () => {
    const dipakai = new Set([...layar.matchAll(/styles\.(\w+)/g)].map((m) => m[1]));
    expect(dipakai.size).toBeGreaterThan(10);
  });
});

describe('rincian pencairan dini tetap lengkap', () => {
  it.each([
    ['Versi Kebijakan'],
    ['Pokok Bruto'],
    ['Bunga Terakru (Rate Kontrak)'],
    ['Penyesuaian Rate'],
    ['Bunga Bruto'],
    ['Bunga Hangus'],
    ['Penalti'],
    ['Biaya Administrasi'],
    ['Potongan atas Pokok'],
    ['Potongan atas Bunga'],
    ['Pokok Dibayar'],
    ['Bunga Dibayar'],
    ['Total Diterima'],
    ['Rate Efektif'],
  ])('menampilkan baris "%s"', (label) => {
    // Label-label ini adalah bagaimana settlement historis dibaca
    // manusia. Kehilangan salah satunya berarti angka yang sudah
    // terposting tidak lagi dapat direkonstruksi dari layar.
    expect(layar).toContain(`label="${label}"`);
  });

  it('versi kebijakan tetap ditampilkan untuk audit', () => {
    expect(layar).toMatch(/nilai=\{d\.policyVersi\}/);
  });

  it('Baris dipakai oleh RincianPencairanDini', () => {
    const blok = layar.slice(
      layar.indexOf('function RincianPencairanDini'),
      layar.indexOf('function Baris')
    );
    expect(blok).toMatch(/<Baris label=/);
  });
});

describe('perubahan RC-S46 tetap ada', () => {
  it('FAB dipertahankan', () => {
    expect(layar).toMatch(/styles\.fab/);
    /**
     * WORDING DIUBAH OLEH RC-S47 §D — sebelumnya "Tambah simpanan
     * berjangka".
     *
     * Assertion-nya diperbarui, BUKAN dihapus: sifat yang dijaga suite
     * ini tetap sama (FAB punya label aksesibilitas yang menyebut
     * fungsinya). Yang berubah hanya kalimatnya, dan §D menetapkannya
     * secara eksplisit karena yang dibuat di layar ini adalah KONTRAK,
     * bukan penambahan baris ke sebuah daftar.
     */
    expect(layar).toMatch(/accessibilityLabel="Buat Simpanan Berjangka"/);
  });

  it('navigasi ke form dengan mode BERJANGKA dipertahankan', () => {
    expect(layar).toMatch(/navigate\('SimpananForm', \{ mode: 'BERJANGKA' \}\)/);
  });

  it('Safe Area bawah dipertahankan', () => {
    expect(layar).toMatch(/bottom: 24 \+ insets\.bottom/);
  });

  it('hanya SATU deklarasi navigation', () => {
    // Kesalahan RC-S41 terulang mudah saat berkas dipatch berkali-kali.
    expect((layar.match(/const navigation = useNavigation/g) ?? [])).toHaveLength(1);
  });
});

describe('impor yang dipakai benar-benar ada', () => {
  it('notify diimpor dari store, bukan dari komponen host', () => {
    // Ditemukan compiler: `AppNotificationHost` hanya punya default
    // export. Impor bernama darinya gagal saat bundling.
    const kebijakan = readFileSync(
      join(ROOT, 'src', 'screens', 'Simpanan', 'KebijakanPenarikanDiniScreen.tsx' /* DIPERBARUI: layar dipindah dari Pengaturan */),
      'utf8'
    );
    expect(kebijakan).toMatch(/import \{ notify \} from '@\/store\/useNotifyStore'/);
    expect(kebijakan).not.toMatch(/import \{ notify \} from '@\/components\/AppNotificationHost'/);
  });

  it('konfigurasi typecheck layar mencakup berkas ini', () => {
    // Perlindungan sesungguhnya. Kalau berkas ini keluar dari scope,
    // kerusakan seperti RC-S46 bisa terulang tanpa terdeteksi.
    const cfg = readFileSync(join(ROOT, 'tsconfig.screen-check.json'), 'utf8');
    expect(cfg).toContain('src/screens/Simpanan/SimpananBerjangkaHistoriScreen.tsx');
  });
});
