/**
 * RC-S118.1 — PICKER ANGGOTA TANPA BATAS, KELAYAKAN TETAP.
 *
 * Laporan pengguna: Setor Simpanan hanya menampilkan 30 anggota, begitu
 * pula Penempatan Simpanan Berjangka dan form Pengurus / Pengawas /
 * Pengelola. Permintaannya: "jangan kasih limit, tampilkan sesuai jumlah
 * anggota asli", sementara Tarik Simpanan tetap hanya anggota bersaldo
 * sukarela dan pencairan berjangka tetap hanya anggota berkontrak.
 *
 * Satu bug tampak di banyak layar karena semua layar itu memakai SATU
 * komponen: `AnggotaPicker`.
 *
 * Bagian tersulit dari perubahan ini bukan menghapus LIMIT, melainkan
 * menghapusnya TANPA ikut menghapus syarat kelayakan. `semuaData` yang
 * kebablasan akan membuat Tarik Simpanan menampilkan anggota yang tidak
 * punya saldo sukarela sama sekali — bug yang jauh lebih berbahaya
 * daripada bug aslinya, karena berujung pada penarikan yang tidak
 * seharusnya bisa dimulai. Karena itu §3 menguji SQL-nya, bukan cuma
 * pemanggilannya.
 */
import fs from 'fs';
import path from 'path';
import { keteranganJumlahPicker } from '@/components/hasilPicker';

const baca = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const picker = () => baca('components', 'AnggotaPicker.tsx');

/** Potongan sumber sebuah fungsi, dari tanda tangannya sampai kurung tutup di kolom 0. */
function badanFungsi(sumber: string, namaFungsi: string): string {
  const mulai = sumber.indexOf(`export async function ${namaFungsi}`);
  expect(mulai).toBeGreaterThan(-1);
  const akhir = sumber.indexOf('\n}\n', mulai);
  expect(akhir).toBeGreaterThan(mulai);
  return sumber.slice(mulai, akhir);
}

describe('RC-S118.1 §1 — picker tidak lagi membatasi jumlah baris', () => {
  it('tidak ada limit angka tetap yang tersisa', () => {
    expect(picker()).not.toMatch(/limit:\s*\d+/);
  });

  it('tidak ada batas tampil apa pun — 200 pun tidak', () => {
    // Perbaikan sebelumnya menaikkan batas ke 200; permintaan pengguna
    // adalah TANPA batas, jadi sisa mekanisme pemotongan harus hilang.
    const sumber = picker();
    expect(sumber).not.toContain('BATAS_AMBIL_PICKER');
    expect(sumber).not.toContain('potongHasilPicker');
    expect(sumber).not.toContain('terpotong');
  });

  it('KETIGA jalur pencarian meminta semuaData', () => {
    const pakai = picker().match(/semuaData:\s*true/g) ?? [];
    // Tiga: berjangka, saldo sukarela, anggota aktif biasa. Memperbaiki
    // sebagian saja persis seperti bug aslinya.
    expect(pakai).toHaveLength(3);
  });
});

describe('RC-S118.1 §2 — syarat kelayakan tiap jalur tidak berubah', () => {
  it('jalur berjangka tetap memanggil listAnggotaDenganBerjangkaEligible', () => {
    expect(picker()).toMatch(
      /if \(onlyWithBerjangkaEligible\)[\s\S]{0,400}listAnggotaDenganBerjangkaEligible\(/
    );
  });

  it('jalur sukarela tetap memanggil listAnggotaSaldoSukarelaTersedia', () => {
    expect(picker()).toMatch(
      /onlyWithSaldoSukarela\)[\s\S]{0,400}listAnggotaSaldoSukarelaTersedia\(/
    );
  });

  it('jalur biasa tetap menyaring status AKTIF', () => {
    expect(picker()).toMatch(/listAnggota\(\{[^}]*status:\s*'AKTIF'/);
  });
});

describe('RC-S118.1 §3 — semuaData hanya melepas paginasi, bukan penyaringan', () => {
  it('query saldo sukarela tetap menuntut saldo > 0 walau tanpa LIMIT', () => {
    const fn = badanFungsi(baca('services', 'SimpananService.ts'), 'listAnggotaSaldoSukarelaTersedia');
    expect(fn).toContain('HAVING saldo_sukarela > 0');
    expect(fn).toContain("a.status = 'AKTIF'");
    // LIMIT hanya boleh muncul lewat variabel paginasi yang dapat kosong.
    expect(fn).toContain("opts.semuaData ? '' : 'LIMIT ? OFFSET ?'");
  });

  it('query berjangka tetap INNER JOIN kontrak yang dapat diproses', () => {
    const fn = badanFungsi(
      baca('services', 'SimpananBerjangkaService.ts'),
      'listAnggotaDenganBerjangkaEligible'
    );
    expect(fn).toContain('INNER JOIN simpanan_berjangka');
    expect(fn).toContain('STATUS_BERJANGKA_DAPAT_DIPROSES');
    expect(fn).toContain("opts.semuaData ? '' : 'LIMIT ? OFFSET ?'");
  });

  it('parameter paginasi ikut kosong ketika semuaData — jumlah "?" harus cocok', () => {
    // Melepas klausa tetapi tetap mengirim dua parameter akan membuat
    // SQLite menolak query. Keduanya wajib dikendalikan satu syarat yang
    // sama.
    for (const [berkas, fn] of [
      ['SimpananService.ts', 'listAnggotaSaldoSukarelaTersedia'],
      ['SimpananBerjangkaService.ts', 'listAnggotaDenganBerjangkaEligible'],
    ] as const) {
      const badan = badanFungsi(baca('services', berkas), fn);
      expect(badan).toContain('opts.semuaData ? [] : [opts.limit ?? 30, opts.offset ?? 0]');
      expect(badan).toContain('...paramPaginasi');
    }
  });

  it('pemanggil lain yang tidak mengisi semuaData tetap ber-pagination', () => {
    for (const [berkas, fn] of [
      ['SimpananService.ts', 'listAnggotaSaldoSukarelaTersedia'],
      ['SimpananBerjangkaService.ts', 'listAnggotaDenganBerjangkaEligible'],
    ] as const) {
      expect(badanFungsi(baca('services', berkas), fn)).toContain('opts.limit ?? 30');
    }
  });
});

describe('RC-S118.1 §4 — keterangan jumlah', () => {
  it('menyebut jumlah apa adanya dan menegaskan daftarnya utuh', () => {
    const teks = keteranganJumlahPicker(103, false);
    expect(teks).toContain('103');
    expect(teks.toLowerCase()).toContain('seluruh');
  });

  it('saat mencari, menyebut jumlah yang cocok tanpa klaim "seluruh"', () => {
    const teks = keteranganJumlahPicker(12, true);
    expect(teks).toContain('12');
    expect(teks.toLowerCase()).toContain('cocok');
    expect(teks.toLowerCase()).not.toContain('seluruh');
  });

  it('membedakan "tidak ada yang cocok" dari "belum ada yang memenuhi syarat"', () => {
    const dicari = keteranganJumlahPicker(0, true);
    const belumAda = keteranganJumlahPicker(0, false);
    expect(dicari).not.toBe(belumAda);
    expect(dicari.toLowerCase()).toContain('cocok');
    expect(belumAda.toLowerCase()).toContain('syarat');
  });

  it('nol tidak pernah dilaporkan sebagai jumlah', () => {
    expect(keteranganJumlahPicker(0, false)).not.toContain('0');
    expect(keteranganJumlahPicker(Number.NaN, false)).not.toContain('NaN');
  });

  it('keterangan benar-benar dirender oleh picker', () => {
    expect(picker()).toContain('keteranganJumlahPicker(results.length');
  });
});

/**
 * RC-S118.2 — SENSUS LAYAR PEMAKAI PICKER ANGGOTA.
 *
 * Pengguna melaporkan batas 30 layar demi layar: Setor Simpanan, lalu
 * Penempatan Berjangka, lalu Pengurus/Pengawas/Pengelola, lalu Keluar
 * Anggota. Semuanya satu sebab yang sama — `AnggotaPicker` — sehingga
 * satu perbaikan menutup semuanya sekaligus.
 *
 * Sensus ini menjadikan hal itu DAPAT DIPERIKSA, bukan sekadar diyakini:
 * bila kelak ada layar yang menyalin picker-nya sendiri atau memasang
 * batas lagi, test ini yang memberi tahu.
 *
 * Catatan: Bayar Angsuran SENGAJA tidak ada di daftar ini. Ia memakai
 * `AnggotaPiutangPicker` yang terpisah, dengan sumber data
 * `listAnggotaDenganPiutangAktif()` yang memang tidak pernah
 * ber-LIMIT. Menganggapnya pemakai `AnggotaPicker` — seperti kesalahan
 * sensus pertama saya — membuat jaminan di sini mengklaim sesuatu yang
 * tidak dijaganya.
 */
describe('RC-S118.2 §5 — seluruh layar pemakai picker ikut tanpa batas', () => {
  const LAYAR_PEMAKAI = [
    ['Pengurus / Pengawas / Pengelola', 'Pengaturan/MasterKoperasiScreens.tsx'],
    ['Pemberian Pinjaman', 'Pinjaman/PinjamanFormScreen.tsx'],
    ['Setor Simpanan & Penempatan Berjangka', 'Simpanan/SimpananFormScreen.tsx'],
    ['Keluar Anggota', 'Transaksi/KeluarAnggotaFormScreen.tsx'],
    ['Pendapatan Diterima Dimuka', 'Transaksi/PendapatanDimukaFormScreen.tsx'],
    ['Tarik Simpanan', 'Transaksi/TarikSimpananFormScreen.tsx'],
    // DIPERBARUI RC-S132: form user ber-role Anggota memilih anggota lewat picker bersama (permintaan pengguna: "Nama Lengkap" diganti "Pilih Anggota"). Picker polos, tanpa batas, tanpa penyempit.
    ['Akun User ber-role Anggota', 'Pengaturan/UserFormScreen.tsx'],
  ] as const;

  const tagPicker = (berkas: string) =>
    baca('screens', ...berkas.split('/')).match(/<AnggotaPicker[\s\S]*?\/>/g) ?? [];

  it('daftar sensus mencakup SELURUH layar yang merender AnggotaPicker', () => {
    // Tanpa ini, layar baru bisa lolos begitu saja dengan tidak
    // didaftarkan — dan sensus yang tidak lengkap tidak menjamin apa pun.
    const semua = fs
      .readdirSync(path.join(__dirname, '..', 'screens'), { recursive: true } as any)
      .filter((f: unknown): f is string => typeof f === 'string' && f.endsWith('.tsx'))
      .filter((f: string) => /<AnggotaPicker[\s>]/.test(baca('screens', ...f.split(/[\\/]/))))
      .map((f: string) => f.split(/[\\/]/).join('/'))
      .sort();
    expect(semua).toEqual(LAYAR_PEMAKAI.map(([, b]) => b).slice().sort());
  });

  it.each(LAYAR_PEMAKAI)('%s merender AnggotaPicker bersama', (_nama, berkas) => {
    expect(tagPicker(berkas).length).toBeGreaterThan(0);
  });

  it('tidak ada layar yang memasang batas sendiri lewat prop', () => {
    for (const [, berkas] of LAYAR_PEMAKAI) {
      for (const t of tagPicker(berkas)) expect(t).not.toMatch(/limit/i);
    }
  });

  it('HANYA Tarik Simpanan yang mempersempit kandidat', () => {
    // Keluar Anggota, Setor, Penempatan Berjangka, dan form personel
    // memakai picker polos -> seluruh anggota AKTIF. Kalau kelak ada
    // layar lain yang menyaring, itu keputusan yang harus disengaja.
    const penyempit = LAYAR_PEMAKAI.filter(([, berkas]) =>
      tagPicker(berkas).join('').includes('onlyWith')
    ).map(([nama]) => nama);
    expect(penyempit).toEqual(['Tarik Simpanan']);
  });

  it('Keluar Anggota memakai picker polos — seluruh anggota AKTIF', () => {
    const tag = tagPicker('Transaksi/KeluarAnggotaFormScreen.tsx').join('');
    expect(tag).not.toContain('onlyWith');
    expect(tag).not.toMatch(/limit/i);
  });

  it('Bayar Angsuran memakai picker piutang, yang juga tanpa LIMIT', () => {
    expect(baca('components', 'AnggotaPiutangPicker.tsx')).toContain('listAnggotaDenganPiutangAktif');
    const fn = badanFungsi(baca('services', 'PinjamanService.ts'), 'listAnggotaDenganPiutangAktif');
    expect(fn).not.toMatch(/\bLIMIT\b/);
  });
});
