import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S122 — UI/UX FORM: Modal Koperasi, Penarikan dari Bank, Penghapusan
 * Piutang, Pemindahan Saldo Rekening, User Management (struktural).
 *
 * Render perangkat tidak tersedia di lingkungan ini; yang dikunci adalah
 * kontraknya: komponen bersama dipakai, komponen itu bebas logika bisnis,
 * pemanggilan service tidak berubah, dan perbaikan perilaku UI yang
 * disengaja (filter rekening, konfirmasi, akun sendiri) tetap ada.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const KOMPONEN = ['AlurDana', 'KartuLangkah', 'KotakInfo', 'PilihanOpsi', 'RingkasanTransaksi', 'TombolUtama'];
const MODAL = strip(baca('src/screens/Transaksi/ModalFormScreen.tsx'));
const TARIK = strip(baca('src/screens/Transaksi/PenarikanBankFormScreen.tsx'));
const HAPUS = strip(baca('src/screens/Pinjaman/PenghapusanPiutangFormScreen.tsx'));
const KASBANK = strip(baca('src/screens/KasBank/KasBankTransaksiFormScreen.tsx'));
const USER = strip(baca('src/screens/Pengaturan/UserManagementScreen.tsx'));
const USER_FORM = strip(baca('src/screens/Pengaturan/UserFormScreen.tsx'));

describe('RC-S122 — komponen form bersama', () => {
  it.each(KOMPONEN.map((k) => [k]))('%s murni presentasi: tanpa service/store/utils/effect', (k) => {
    const s = baca(`src/components/form/${k}.tsx`);
    expect(s).not.toMatch(/from '@\/(services|database|accounting|repositories|store|utils|hooks|security|validators|config)\//);
    expect(s).not.toMatch(/useEffect|useState|fetch\(|await /);
    // Warna hanya dari token tema.
    expect(strip(s)).not.toMatch(/'#[0-9A-Fa-f]{3,8}'/);
  });

  it('pilihan opsi memberi penanda selain warna (ikon centang) dan role radio', () => {
    const s = strip(baca('src/components/form/PilihanOpsi.tsx'));
    expect(s).toContain("name={aktif ? 'checkmark-circle' : 'ellipse-outline'}");
    expect(s).toContain('accessibilityRole="radio"');
  });

  it('tombol utama mengunci dirinya saat memuat atau nonaktif', () => {
    const s = strip(baca('src/components/form/TombolUtama.tsx'));
    expect(s).toContain('const tidakAktif = memuat || nonaktif;');
    expect(s).toContain('disabled={tidakAktif}');
  });

  it.each([
    ['Modal Koperasi', MODAL],
    ['Penarikan dari Bank', TARIK],
    ['Penghapusan Piutang', HAPUS],
    ['Kas & Bank / Pemindahan Saldo', KASBANK],
  ])('%s memakai langkah bernomor, ringkasan, dan tombol utama bersama', (_n, s) => {
    expect(s).toMatch(/<KartuLangkah nomor=\{/);
    expect(s).toMatch(/<RingkasanTransaksi\b/);
    expect(s).toMatch(/<TombolUtama\b/);
  });
});

describe('RC-S122 — logika transaksi tidak berubah', () => {
  it('Modal Koperasi tetap memanggil terimaModalUang/terimaModalBarang dengan parameter yang sama', () => {
    expect(MODAL).toMatch(/await terimaModalUang\(\{\s*nilai: nilaiUang,\s*metodePembayaran,/);
    expect(MODAL).toMatch(/await terimaModalBarang\(\{\s*jenisAset: jenisBarang,/);
  });

  it('Penarikan dari Bank tetap transfer BANK -> kas lewat transferAntarRekening', () => {
    expect(TARIK).toMatch(/await transferAntarRekening\(\{\s*sumberJenis: 'BANK',/);
  });

  it('Penghapusan Piutang tetap memakai hapusPiutangPinjaman dan pesan sukses writeOffTotal', () => {
    expect(HAPUS).toMatch(/await hapusPiutangPinjaman\(\{/);
    expect(HAPUS).toContain('formatRupiah(writeOffTotal)');
  });

  it('Kas & Bank tetap memakai tiga jalur service yang sama', () => {
    for (const f of ['await catatPemasukan(', 'await catatPengeluaran(', 'await transferAntarRekening(']) {
      expect(KASBANK).toContain(f);
    }
  });
});

describe('RC-S122 — perbaikan perilaku UI yang disengaja', () => {
  it('Penarikan dari Bank: sumber hanya bank, tujuan hanya kas, keterangan dapat diisi', () => {
    expect(TARIK).toMatch(/<RekeningPicker label="Bank asal dana"[^>]*hanyaBank \/>/);
    expect(TARIK).toContain("jenisDiizinkan={['KAS', 'KAS_KECIL']}");
    expect(TARIK).toMatch(/<AppTextInput\s+value=\{keterangan\}\s+onChangeText=\{setKeterangan\}/);
    expect(TARIK).toContain('nonaktif={saldoTidakCukup}');
  });

  it('Pemindahan Saldo: alur dana, tukar rekening, dan tab riwayat PEMINDAHAN_SALDO', () => {
    expect(KASBANK).toMatch(/<AlurDana[\s\S]*?onTukar=/);
    expect(KASBANK).toMatch(/<TabTransaksi value=\{tabMenu\} onChange=\{setTabMenu\} menu="PEMINDAHAN_SALDO" \/>/);
    expect(KASBANK).toMatch(/tabMenu === 'RIWAYAT' \? <RiwayatTransaksiMenu menu="PEMINDAHAN_SALDO" \/>/);
  });

  it('Penghapusan Piutang: konfirmasi sebelum simpan dan jalan langsung ke Pelaksanaan RAT', () => {
    expect(HAPUS).toMatch(/onPress=\{konfirmasi\}/);
    expect(HAPUS).toMatch(/\{ text: 'Hapus Buku', style: 'destructive', onPress: submit \}/);
    expect(HAPUS).toContain("navigation.navigate('PelaksanaanRAT')");
    expect(HAPUS).not.toMatch(/lewat menu SHU/);
    expect(baca('src/navigation/RootNavigator.tsx')).toMatch(/<TransaksiStack\.Screen name="PelaksanaanRAT"/);
  });

  it('User Management: akun sendiri tidak dapat dinonaktifkan dari daftar', () => {
    expect(USER).toContain('const akunSaya = item.id === currentUser?.id;');
    expect(USER).toMatch(/\{akunSaya \? \([\s\S]*?Akun yang sedang dipakai[\s\S]*?\) : \([\s\S]*?toggleAktif\(item\)/);
  });

  it('User Management: tanpa hex lepas, tanpa dialog Ubah Role mati, tombol tambah berlabel', () => {
    expect(USER).not.toMatch(/'#[0-9A-Fa-f]{3,8}'/);
    expect(USER).not.toContain('gantiRoleUser');
    expect(USER).toContain('accessibilityLabel="Tambah user"');
  });

  it('Form user tetap memakai kontrak RC-S117', () => {
    expect(USER_FORM).toContain("const mode: 'TAMBAH' | 'SUNTING' = userId ? 'SUNTING' : 'TAMBAH'");
    expect(USER_FORM).toContain('await createUser(');
    expect(USER_FORM).toContain('await updateUser(');
    expect(USER_FORM).toMatch(/accessibilityRole="radio"/);
  });
});
