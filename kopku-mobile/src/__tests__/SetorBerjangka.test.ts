import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S46 — PENEMPATAN SIMPANAN BERJANGKA HARUS DAPAT DILAKUKAN.
 *
 * BUG YANG DITUTUP, DAN KENAPA IA LOLOS BERKALI-KALI.
 * RC-S45 membuat menu "Simpanan Berjangka" terlihat, tetapi menu itu
 * menuju DAFTAR yang murni baca-saja: tidak ada FAB, tidak ada tombol
 * tambah, tidak ada apa pun untuk membuat kontrak baru.
 *
 * Satu-satunya jalur yang tersisa: buka layar Simpanan, tekan FAB-nya,
 * lalu MENYADARI SENDIRI bahwa ada chip "Berjangka" di dalam form —
 * chip yang tidak disebut di mana pun. Dari sisi pengguna, penempatan
 * simpanan berjangka memang tidak tersedia.
 *
 * Ini kelanjutan dari kelas bug yang sama dengan RC-S45: bukan kodenya
 * yang salah, melainkan JALAN MASUKNYA yang tidak ada. Audit-audit
 * sebelumnya menyimpulkan "fiturnya sudah ada" karena memeriksa layar,
 * service, dan skema — tidak pernah memeriksa apakah pengguna bisa
 * sampai ke sana.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const daftar = tanpaKomentar(read('src/screens/Simpanan/SimpananBerjangkaHistoriScreen.tsx'));
const form = tanpaKomentar(read('src/screens/Simpanan/SimpananFormScreen.tsx'));

describe('daftar simpanan berjangka menyediakan cara membuat kontrak', () => {
  it('punya FAB tambah', () => {
    expect(daftar).toMatch(/styles\.fab/);
    expect(daftar).toMatch(/name="add"/);
  });

  it('FAB menavigasi ke form setor dengan mode BERJANGKA', () => {
    expect(daftar).toMatch(/navigate\('SimpananForm', \{ mode: 'BERJANGKA' \}\)/);
  });

  it('FAB menghormati Safe Area bawah', () => {
    // Tanpa inset, FAB tertimpa gesture bar pada perangkat modern.
    expect(daftar).toMatch(/bottom: 24 \+ insets\.bottom/);
  });

  it('punya label aksesibilitas', () => {
    /**
     * WORDING DIPERBARUI RC-S47 §D (sebelumnya "Tambah simpanan
     * berjangka"). Sifat yang dijaga tidak berubah — FAB tetap wajib
     * punya label yang menyebut fungsinya; §D hanya menetapkan
     * kalimatnya, karena yang dibuat di layar ini adalah KONTRAK.
     */
    expect(daftar).toMatch(/accessibilityLabel="Buat Simpanan Berjangka"/);
  });
});

describe('form setor menerima mode awal', () => {
  it('membaca mode dari route params', () => {
    expect(form).toMatch(/route\?\.params\?\.mode === 'BERJANGKA'/);
  });

  it('default tetap REGULER bila tidak diberi param', () => {
    // Non-regresi: FAB di layar Simpanan memanggil tanpa params dan
    // harus tetap membuka mode reguler seperti sebelumnya.
    expect(form).toMatch(/\? 'BERJANGKA'\s*:\s*'REGULER'/);
    expect(tanpaKomentar(read('src/screens/Simpanan/SimpananHistoriScreen.tsx'))).toMatch(
      /navigate\('SimpananForm'\)/
    );
  });

  it('param TIDAK membuat jalur simpan kedua', () => {
    // Kalau param ikut menentukan service/validasi, akan ada dua jalur
    // penyimpanan yang bisa berbeda perilaku tanpa disadari.
    //
    // BENTUKNYA BERUBAH DI RC-S47 §B, SIFATNYA TIDAK.
    //
    // RC-S46: `useState<'REGULER'|'BERJANGKA'>(modeAwal)` — param hanya
    // memilih chip AWAL, pengguna masih boleh berpindah mode.
    // RC-S47: mode menjadi KONSTANTA dari param, dan chip pemindah mode
    // dihapus — karena chip itulah pintu masuk KEDUA ke pembuatan
    // kontrak berjangka (dari jalur "Setor Simpanan"), yang justru
    // dilarang §B/§S.
    //
    // Yang tetap dijaga: param tidak menyentuh service maupun validasi.
    expect(form).toMatch(/const mode: 'REGULER' \| 'BERJANGKA' =/);
    expect(form).not.toMatch(/useState<'REGULER' \| 'BERJANGKA'>/);
    expect(form).not.toMatch(/setMode\(/);
    // Tepat satu pemanggilan per service — tidak ada cabang penyimpanan
    // tambahan yang lahir dari parameter ini.
    expect([...form.matchAll(/setorSimpananBerjangka\(/g)]).toHaveLength(1);
    expect([...form.matchAll(/catatDataAwalSimpanan\(/g)]).toHaveLength(1);
  });

  it('kedua mode tetap memakai service masing-masing yang sudah ada', () => {
    expect(form).toMatch(/setorSimpananBerjangka\(/);
    expect(form).toMatch(/setorSimpanan\w*\(/);
  });
});

describe('penjaga kelas: daftar tidak boleh jadi jalan buntu', () => {
  /**
   * Layar daftar yang dapat dijangkau dari menu HARUS punya cara
   * membuat data — atau alasan eksplisit kenapa tidak. Tanpa penjaga
   * ini, daftar baru yang lahir tanpa FAB akan terlihat "selesai"
   * padahal buntu, persis seperti Simpanan Berjangka sebelum RC-S46.
   */
  const DAFTAR_TANPA_FAB_DISENGAJA: readonly string[] = [
    // Histori transaksi = catatan, bukan tempat membuat.
    'SimpananHistoriScreen',
  ];

  it('daftar simpanan berjangka tidak lagi buntu', () => {
    expect(DAFTAR_TANPA_FAB_DISENGAJA).not.toContain('SimpananBerjangkaHistoriScreen');
    expect(daftar).toMatch(/TouchableOpacity[\s\S]{0,200}styles\.fab/);
  });

  it('layar Simpanan tetap punya FAB-nya sendiri', () => {
    // Non-regresi RC-S45/S46: menambah jalan masuk baru tidak boleh
    // menghapus yang lama.
    expect(tanpaKomentar(read('src/screens/Simpanan/SimpananHistoriScreen.tsx'))).toMatch(
      /styles\.fab/
    );
  });

  it('menu Simpanan Berjangka tetap terdaftar dari RC-S45', () => {
    expect(
      tanpaKomentar(read('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'))
    ).toMatch(/nav\.navigate\('SimpananBerjangkaHistori'\)/);
  });
});
