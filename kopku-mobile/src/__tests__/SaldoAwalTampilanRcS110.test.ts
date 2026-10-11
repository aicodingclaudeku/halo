import { readFileSync } from 'fs';
import { join } from 'path';
import {
  JUDUL_MODUL_SALDO_AWAL,
  SUBJUDUL_MODUL_SALDO_AWAL,
  LABEL_STATUS_SALDO_AWAL,
  KETERANGAN_STATUS_SALDO_AWAL,
  NADA_STATUS_SALDO_AWAL,
  IKON_STATUS_SALDO_AWAL,
  URUTAN_FILTER_PENGISIAN,
  LABEL_FILTER_PENGISIAN,
  hitungKemajuanPengisian,
  bolehDiedit,
  bolehDikoreksi,
  bolehKunciPermanen,
  CATATAN_BUKAN_PEMERIKSAAN_KESEIMBANGAN,
  JUDUL_PERINGATAN_KLIRING,
  PENJELASAN_PERINGATAN_KLIRING,
  KODE_AKUN_KLIRING_SALDO_AWAL,
  perluPeringatanKliring,
  type StatusSaldoAwal,
} from '@/reports/StatusSaldoAwalPlan';

/**
 * ============================================================
 * RC-S110 — UI/UX LAYAR SALDO AWAL
 * ============================================================
 *
 * BATAS YANG DIJAGA SUITE INI.
 *
 * Perubahan RC-S110 pada layar ini hampir seluruhnya PRESENTASI: kop
 * modul, bar kemajuan, kartu per akun, satu footer menggantikan dua
 * panel absolut bertumpuk. Risikonya bukan tampilan yang jelek — itu
 * terlihat dalam sepuluh detik — melainkan presentasi yang MERAMBAT ke
 * aturan yang sudah disepakati:
 *
 *   a. layar ini TIDAK BOLEH memeriksa keseimbangan saldo (§8 FINAL:
 *      Total Aset/Liabilitas/Ekuitas dan badge "Seimbang" dihapus
 *      total; itu tugas laporan Posisi Keuangan §9);
 *   b. akun yang SUDAH punya saldo awal WAJIB read-only di layar ini —
 *      perubahan hanya lewat Koreksi (reversal + jurnal baru, §16),
 *      bukan diketik ulang di kotak yang sama;
 *   c. daftar akun tetap SATU daftar datar, tidak dipecah jadi section
 *      kategori (§2/§34).
 *
 * Karena itu setiap assertion di bawah dipasangkan dengan assertion
 * kebalikannya: bukan cuma "bar kemajuan muncul", tetapi juga "tidak
 * ada nominal yang pernah dijumlahkan untuk menghasilkannya".
 */

const BERKAS_MODUL = join(__dirname, '..', 'reports', 'StatusSaldoAwalPlan.ts');
const BERKAS_LAYAR = join(__dirname, '..', 'screens', 'Pengaturan', 'SaldoAwalAkunListScreen.tsx');

function tanpaKomentar(teks: string): string {
  return teks.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const SEMUA_STATUS: StatusSaldoAwal[] = ['DRAFT', 'POSTED', 'LOCKED'];

describe('RC-S110 — kemajuan pengisian adalah hitungan akun, bukan keseimbangan', () => {
  test('menghitung persen dari jumlah akun', () => {
    expect(hitungKemajuanPengisian(10, 4)).toMatchObject({ diisi: 4, total: 10, persen: 40, lengkap: false });
    expect(hitungKemajuanPengisian(8, 8)).toMatchObject({ persen: 100, lengkap: true });
    expect(hitungKemajuanPengisian(3, 1).persen).toBe(33);
  });

  test('total 0 menghasilkan 0%, bukan NaN dan bukan 100%', () => {
    // NaN membuat lebar bar menjadi "NaN%" dan barnya hilang tanpa
    // pesan; 100% lebih buruk lagi karena memberi tahu pengguna bahwa
    // pekerjaan selesai padahal belum satu akun pun diisi.
    const k = hitungKemajuanPengisian(0, 0);
    expect(k.persen).toBe(0);
    expect(Number.isNaN(k.persen)).toBe(false);
    expect(k.lengkap).toBe(false);
    expect(k.teks).toBe('Belum ada akun untuk diisi');
  });

  test('nilai tidak masuk akal dijepit, tidak diteruskan apa adanya', () => {
    expect(hitungKemajuanPengisian(5, 99)).toMatchObject({ diisi: 5, persen: 100, lengkap: true });
    expect(hitungKemajuanPengisian(5, -3)).toMatchObject({ diisi: 0, persen: 0 });
    expect(hitungKemajuanPengisian(Number.NaN, 2)).toMatchObject({ total: 0, diisi: 0, persen: 0 });
    expect(hitungKemajuanPengisian(-7, 2)).toMatchObject({ total: 0, persen: 0 });
  });

  test('modul murni TIDAK PERNAH menyentuh nominal atau keseimbangan', () => {
    // Batas §8 dijaga oleh BENTUK fungsi: `hitungKemajuanPengisian`
    // hanya menerima dua angka hitungan. Kalau suatu saat ia menerima
    // saldo/rupiah, itu tanda layar input mulai berubah jadi dashboard
    // keseimbangan — yang memang dihapus dari sini.
    expect(hitungKemajuanPengisian.length).toBe(2);
    const kode = tanpaKomentar(readFileSync(BERKAS_MODUL, 'utf8'));
    // Kata "saldo"/"seimbang" SENDIRI tidak dilarang — keduanya muncul
    // sah di label dan di catatan yang justru mengarahkan pengguna ke
    // Posisi Keuangan. Yang dilarang adalah PERKAKAS UANG: begitu modul
    // ini mengimpor tipe/format rupiah atau menyebut debit/kredit, ia
    // sudah berhenti menjadi modul tampilan dan mulai menghitung.
    expect(kode).not.toMatch(/from '@\/utils\/money'/);
    for (const dilarang of ['Rupiah', 'formatRupiah', 'debit', 'kredit', 'normal_balance', 'totalAset', 'totalEkuitas']) {
      expect(kode).not.toContain(dilarang);
    }
    // Sisi kebalikannya: catatan yang MENGARAHKAN pengguna ke tempat
    // pemeriksaan yang benar harus tetap ada.
    expect(CATATAN_BUKAN_PEMERIKSAAN_KESEIMBANGAN).toContain('Posisi Keuangan');
  });
});

describe('RC-S110 — hak edit per baris tetap seperti aturan lama', () => {
  test('hanya akun yang belum diisi & belum terkunci yang bisa diketik', () => {
    expect(bolehDiedit(false, false)).toBe(true);
    expect(bolehDiedit(true, false)).toBe(false); // sudah aktif -> lewat Koreksi
    expect(bolehDiedit(false, true)).toBe(false); // terkunci permanen
    expect(bolehDiedit(true, true)).toBe(false);
  });

  test('Koreksi/Hapus justru kebalikannya: hanya untuk baris yang sudah aktif', () => {
    expect(bolehDikoreksi(true, false)).toBe(true);
    expect(bolehDikoreksi(false, false)).toBe(false);
    expect(bolehDikoreksi(true, true)).toBe(false);
  });

  test('tidak ada keadaan yang membolehkan ketik ulang DAN koreksi sekaligus', () => {
    // Kalau keduanya pernah true bersamaan, ada dua jalan mengubah
    // saldo yang sama — satu berjejak audit (Koreksi), satu tidak.
    for (const diisi of [true, false]) {
      for (const terkunci of [true, false]) {
        expect(bolehDiedit(diisi, terkunci) && bolehDikoreksi(diisi, terkunci)).toBe(false);
      }
    }
  });

  test('Simpan Permanen hanya saat ada yang bisa dikunci', () => {
    expect(bolehKunciPermanen('POSTED', 3, false)).toBe(true);
    expect(bolehKunciPermanen('DRAFT', 3, false)).toBe(false);
    expect(bolehKunciPermanen('POSTED', 0, false)).toBe(false);
    expect(bolehKunciPermanen('POSTED', 3, true)).toBe(false);
    expect(bolehKunciPermanen('LOCKED', 3, true)).toBe(false);
  });
});

describe('RC-S110 — label status lengkap dan konsisten', () => {
  test('ketiga status punya label, keterangan, nada, dan ikon', () => {
    for (const s of SEMUA_STATUS) {
      expect(LABEL_STATUS_SALDO_AWAL[s]).toBeTruthy();
      expect(KETERANGAN_STATUS_SALDO_AWAL[s]).toBeTruthy();
      expect(NADA_STATUS_SALDO_AWAL[s]).toBeTruthy();
      expect(IKON_STATUS_SALDO_AWAL[s]).toBeTruthy();
    }
    expect(Object.keys(LABEL_STATUS_SALDO_AWAL).sort()).toEqual(['DRAFT', 'LOCKED', 'POSTED']);
  });

  test('label memakai bahasa pengguna, bukan istilah jurnal', () => {
    // "POSTED"/"DRAFT" adalah istilah internal; yang dibaca pengurus
    // koperasi harus kata keadaan yang bisa dipahami langsung.
    for (const s of SEMUA_STATUS) {
      expect(LABEL_STATUS_SALDO_AWAL[s]).not.toMatch(/POSTED|DRAFT|LOCKED/);
    }
    expect(LABEL_STATUS_SALDO_AWAL.POSTED).toContain('AKTIF');
    expect(LABEL_STATUS_SALDO_AWAL.LOCKED).toContain('TERKUNCI');
  });

  test('tiap nada dipakai tepat sekali — tidak ada dua status seragam', () => {
    const nada = SEMUA_STATUS.map((s) => NADA_STATUS_SALDO_AWAL[s]);
    expect(new Set(nada).size).toBe(3);
  });

  test('filter "Semua" selalu pertama supaya jalan pulang jelas', () => {
    expect(URUTAN_FILTER_PENGISIAN[0]).toBe('SEMUA');
    expect(URUTAN_FILTER_PENGISIAN).toHaveLength(3);
    for (const f of URUTAN_FILTER_PENGISIAN) expect(LABEL_FILTER_PENGISIAN[f]).toBeTruthy();
  });

  test('judul & subjudul modul terisi', () => {
    expect(JUDUL_MODUL_SALDO_AWAL).toBe('SALDO AWAL');
    expect(SUBJUDUL_MODUL_SALDO_AWAL).toContain('COA');
  });
});

describe('RC-S110 — layar memakai modul murni, dan batas lama tetap utuh', () => {
  const layar = tanpaKomentar(readFileSync(BERKAS_LAYAR, 'utf8'));

  test('keputusan hak edit diambil dari modul, tidak ditulis ulang di layar', () => {
    expect(layar).toContain('bolehDiedit(sudahDiisi, terkunciPermanen)');
    expect(layar).toContain('bolehDikoreksi(sudahDiisi, terkunciPermanen)');
    expect(layar).toContain('bolehKunciPermanen(');
    // Pola lama yang digandakan di layar tidak boleh kembali.
    expect(layar).not.toContain('!sudahDiisi && !terkunciPermanen');
  });

  test('tidak ada dashboard keseimbangan yang kembali ke layar ini', () => {
    for (const dilarang of ['Total Aset', 'Total Liabilitas', 'Total Ekuitas', 'SALDO SEIMBANG', 'TIDAK SEIMBANG']) {
      expect(layar).not.toContain(dilarang);
    }
  });

  test('daftar akun tetap satu daftar datar, bukan section kategori', () => {
    // Satu `.map` atas daftar tersaring; tidak ada pengelompokan
    // berdasarkan kategori di layar input ini (§2/§34).
    expect(layar).toContain('daftarTampil.map(');
    expect(layar).not.toMatch(/group(By)?Kategori|sectionKategori|SectionList/);
  });

  test('footer tunggal menggantikan dua panel absolut bertumpuk', () => {
    // Offset ajaib `bottom: 74` dulu harus ditebak ulang setiap kali
    // tinggi tombol berubah; sekarang tidak ada lagi.
    expect(layar).not.toContain('bottom: 74');
    expect((layar.match(/style=\{styles\.footer\}/g) ?? []).length).toBe(1);
  });

  test('kemajuan dihitung dari seluruh COA, bukan dari daftar tersaring', () => {
    // Kalau ikut saringan, mengetik satu kata di pencarian membuat bar
    // melompat ke 100% dan memberi kesan pekerjaan sudah selesai.
    expect(layar).toContain('hitungKemajuanPengisian(akunList.length, ringkasan.rows.length)');
    expect(layar).not.toContain('hitungKemajuanPengisian(daftarTampil.length');
  });

  test('pencarian baris aktif memakai Map, bukan find() di dalam render', () => {
    // Dengan COA penuh, `rows.find()` per baris membuat setiap ketikan
    // di kotak nominal terasa tersendat.
    expect(layar).toContain('barisAktif.get(akun.id)');
    expect(layar).not.toMatch(/ringkasan\.rows\.find\(/);
  });
});

describe('RC-S112 — footer tidak boleh menutupi kartu mana pun', () => {
  const layar = tanpaKomentar(readFileSync(BERKAS_LAYAR, 'utf8'));

  test('footer BUKAN panel melayang; daftar mengambil sisa tinggi', () => {
    // Keluhan pengguna, dua putaran berturut-turut. Menambah ruang
    // bawah pada daftar hanya menyelesaikan SEBAGIAN masalah: kartu
    // TERAKHIR jadi bisa digulir naik, tetapi kartu yang sedang
    // DIKETIK di tengah daftar tetap tertutup — karena bagi ScrollView
    // tepi bawah viewport-nya ada DI BAWAH footer melayang, jadi
    // Android menggulirkan input yang difokuskan tepat ke belakang
    // tombol SIMPAN.
    //
    // Satu-satunya perbaikan yang menutup SELURUH kasus: footer
    // menjadi saudara biasa dalam kolom flex, sehingga tepi bawah
    // viewport daftar benar-benar berada di atas footer.
    const gaya = layar.slice(layar.indexOf('const styles = StyleSheet.create({'));
    const blokFooter = gaya.slice(gaya.indexOf('  footer: {'), gaya.indexOf('},', gaya.indexOf('  footer: {')));
    expect(blokFooter).not.toContain("position: 'absolute'");
    expect(blokFooter).not.toContain('bottom: 0');
    expect(gaya).toContain('daftarGulir: { flex: 1 }');
    expect(layar).toContain('style={styles.daftarGulir}');
  });

  test('pengukuran tinggi footer dihapus, tidak disisakan menganggur', () => {
    // Dengan footer di aliran normal, ruang bawah sebesar tinggi
    // footer justru menyisakan area kosong sia-sia di ujung daftar.
    expect(layar).not.toContain('tinggiFooter');
    expect(layar).not.toMatch(/onLayout=\{\(e\) => setTinggiFooter/);
  });

  test('tidak ada footer kedua yang kembali melayang', () => {
    expect(layar).not.toContain('bottom: 74');
    expect((layar.match(/style=\{styles\.footer\}/g) ?? []).length).toBe(1);
  });
});

describe('RC-S110 lanjutan — pemberitahuan Saldo Awal Belum Sesuai', () => {
  const layar = tanpaKomentar(readFileSync(BERKAS_LAYAR, 'utf8'));

  test('tampil hanya saat akun kliring bersaldo, dua arah', () => {
    expect(perluPeringatanKliring(0)).toBe(false);
    expect(perluPeringatanKliring(250_000)).toBe(true);
    // Selisih bisa jatuh ke sisi kredit; saldo negatif sama perlunya
    // diberitahu, jadi syaratnya `!== 0`, bukan `> 0`.
    expect(perluPeringatanKliring(-250_000)).toBe(true);
    expect(perluPeringatanKliring(Number.NaN)).toBe(false);
  });

  test('teksnya menyebut akun, sebabnya, dan cara hilangnya', () => {
    expect(JUDUL_PERINGATAN_KLIRING).toBe('Saldo Awal Belum Sesuai');
    expect(KODE_AKUN_KLIRING_SALDO_AWAL).toBe('3-5000');
    expect(PENJELASAN_PERINGATAN_KLIRING).toContain('3-5000');
    expect(PENJELASAN_PERINGATAN_KLIRING).toContain('belum diisi atau belum dikoreksi');
    // Penting: jangan membuat pengguna mengira ini kesalahan aplikasi.
    expect(PENJELASAN_PERINGATAN_KLIRING).toContain('bukan kesalahan');
    expect(PENJELASAN_PERINGATAN_KLIRING).toContain('Rp0');
  });

  test('ditempatkan di kop, bukan sebagai banner yang ikut tergulir', () => {
    // Kalau kembali ke dalam ScrollView, pemberitahuan ini hilang dari
    // pandangan begitu pengguna menggulir ke akun ke-40 — justru saat
    // ia paling dibutuhkan.
    const kop = layar.slice(layar.indexOf('<View style={styles.kop}>'), layar.indexOf('<ScrollView'));
    expect(kop).toContain('perluPeringatanKliring(ringkasan.saldoKliringKoreksi)');
    expect(kop).toContain('formatRupiah(ringkasan.saldoKliringKoreksi)');
    const isiGulir = layar.slice(layar.indexOf('<ScrollView'));
    expect(isiGulir).not.toContain('saldoKliringKoreksi');
  });

  test('modul murni tetap tidak menyentuh perkakas uang', () => {
    // Nominalnya dirakit layar (yang punya formatRupiah); modul ini
    // hanya memilih kata dan membandingkan dengan nol.
    const kode = tanpaKomentar(readFileSync(BERKAS_MODUL, 'utf8'));
    expect(kode).not.toContain('formatRupiah');
    expect(perluPeringatanKliring.length).toBe(1);
  });
});

describe('RC-S111 lanjutan — kop harus ringkas, daftar yang dapat ruang', () => {
  const layar = tanpaKomentar(readFileSync(BERKAS_LAYAR, 'utf8'));
  const kop = layar.slice(layar.indexOf('<View style={styles.kop}>'), layar.indexOf('<ScrollView'));

  test('kop hanya memuat yang harus terlihat setiap saat', () => {
    // Keluhan pengguna: kop setinggi dua pertiga layar membuat daftar
    // akun — satu-satunya hal yang perlu dikerjakan di sini — tinggal
    // satu kartu terpotong di antara kop dan footer. Yang boleh
    // menetap di kop: status, kemajuan, dan ADA-TIDAKNYA selisih.
    expect(kop).toContain('JUDUL_MODUL_SALDO_AWAL');
    expect(kop).toContain('LABEL_STATUS_SALDO_AWAL[status]');
    expect(kop).toContain('kemajuan.persen');
    expect(kop).toContain('perluPeringatanKliring(ringkasan.saldoKliringKoreksi)');
  });

  test('subjudul dan keterangan status turun ke dalam daftar', () => {
    // Keduanya bacaan sekali, bukan informasi yang perlu terlihat
    // setiap saat — jadi ia ikut tergulir seperti isi lainnya.
    expect(kop).not.toContain('SUBJUDUL_MODUL_SALDO_AWAL');
    expect(kop).not.toContain('KETERANGAN_STATUS_SALDO_AWAL');
    const isiGulir = layar.slice(layar.indexOf('<ScrollView'));
    expect(isiGulir).toContain('SUBJUDUL_MODUL_SALDO_AWAL');
    expect(isiGulir).toContain('KETERANGAN_STATUS_SALDO_AWAL[status]');
  });

  test('penjelasan akun kliring tertutup secara bawaan, dibuka dengan ketukan', () => {
    // Nominalnya tetap terlihat terus — itu yang perlu dipantau.
    // Paragraf penjelasannya cukup dibaca sekali.
    expect(layar).toContain('useState(false)');
    expect(kop).toContain('setPeringatanTerbuka((v) => !v)');
    expect(kop).toContain('{peringatanTerbuka && <Text style={styles.peringatanTeks}>');
    // Nominal TIDAK ikut disembunyikan.
    const barisSelalu = kop.slice(kop.indexOf('styles.peringatanBaris'), kop.indexOf('peringatanTerbuka && <Text'));
    expect(barisSelalu).toContain('formatRupiah(ringkasan.saldoKliringKoreksi)');
    expect(barisSelalu).toContain('JUDUL_PERINGATAN_KLIRING');
  });

  test('keadaan buka/tutup diumumkan ke screen reader', () => {
    expect(kop).toContain('accessibilityState={{ expanded: peringatanTerbuka }}');
  });
});
