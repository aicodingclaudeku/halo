import * as fs from 'fs';
import * as path from 'path';
import { CASH_FLOW_CLASSIFICATION } from '@/accounting/CashFlowClassification';

/**
 * RC-S17 — EKSHAUSTIVITAS YANG BENAR-BENAR EKSHAUSTIF.
 *
 * CashFlowExhaustiveClassification.test.ts sudah memindai source untuk
 * mencari sumber transaksi yang belum terklasifikasi — dan itu ide yang
 * benar. Masalahnya pemindai di sana hanya mengenali BENTUK LITERAL
 * (properti sumber transaksi yang langsung diisi string). Nilai yang
 * diisi lewat konstanta, `Record`, atau ternary lolos tanpa terlihat.
 *
 * Akibatnya nyata, bukan teoretis: `InvestasiService` memilih sumber
 * transaksinya lewat `JENIS_TRANSACTION_TYPE[input.jenisInvestasi]`,
 * sebuah Record berisi ENAM nilai. Peta klasifikasi hanya punya DUA.
 * Lima sisanya tidak pernah terpetakan, tidak pernah tertangkap test,
 * dan akan menjatuhkan `getArusKas()` begitu koperasi mencatat
 * investasi selain KOPERASI_LAIN.
 *
 * Pemindai di berkas ini MENYELESAIKAN indireksi tersebut. Prinsip
 * pentingnya: kalau ia bertemu bentuk yang TIDAK bisa ia selesaikan, ia
 * GAGAL dan menyebut berkas/barisnya — bukan melewatinya diam-diam.
 * Melewati diam-diam persis cara bug ini lahir dua kali.
 */

const AKAR_SRC = path.resolve(__dirname, '..');

/**
 * Ekspresi yang sengaja diizinkan TIDAK menghasilkan nilai baru.
 * `reverseJournal` menyalin `sumber_transaksi` jurnal asli, jadi ia
 * tidak pernah memperkenalkan nilai yang belum ada.
 */
const PROPAGASI_DIIZINKAN = [/^\w+\.sumber_transaksi$/];

function kumpulkanFileProduksi(dir: string, hasil: string[] = []): string[] {
  for (const nama of fs.readdirSync(dir)) {
    const penuh = path.join(dir, nama);
    if (fs.statSync(penuh).isDirectory()) {
      if (nama === '__tests__' || nama === 'test-utils' || nama === 'node_modules') continue;
      kumpulkanFileProduksi(penuh, hasil);
    } else if (/\.tsx?$/.test(nama)) {
      hasil.push(penuh);
    }
  }
  return hasil;
}

/** Membuang komentar baris supaya contoh di dalam komentar tidak ikut terpindai. */
function tanpaKomentar(baris: string): string {
  const t = baris.trimStart();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  return baris.replace(/\/\/.*$/, '');
}

/**
 * String literal yang muncul sebagai PEMBANDING (`x === 'BANK'`) atau
 * nilai default (`x ?? 'TETAP'`) adalah bagian dari KONDISI, bukan
 * nilai sumber transaksi yang dihasilkan. Kalau tidak dibuang, pemindai
 * akan melaporkan 'BANK'/'TETAP' sebagai sumber transaksi yang belum
 * terklasifikasi — kebisingan yang membuat orang melonggarkan test.
 */
function tanpaLiteralKondisi(teks: string): string {
  return teks.replace(/[=!]==?\s*'[^']*'/g, '').replace(/\?\?\s*'[^']*'/g, '');
}

function stringUpperSnake(teks: string): string[] {
  return [...tanpaLiteralKondisi(teks).matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
}

/**
 * Mencari definisi sebuah identifier dan mengembalikan SELURUH string
 * UPPER_SNAKE di dalam inisialisasinya. Menangani bentuk yang
 * benar-benar dipakai codebase ini: konstanta string, Record literal,
 * ternary berantai, dan konstanta yang isinya sendiri merupakan lookup
 * ke Record lain (`const x = PETA[input.jenis];` — bentuk inilah yang
 * menyembunyikan lima jenis investasi selama ini).
 *
 * Berkas asal dicari LEBIH DULU: nama seperti `sumberTransaksi` dipakai
 * di beberapa modul, dan definisi dari modul lain akan salah.
 */
function resolusiIdentifier(
  nama: string,
  berkasAsal: string,
  berkasSemua: string[],
  kedalaman = 0
): string[] | null {
  if (kedalaman > 3) return null;
  const polaAwal = new RegExp(`(?:export\\s+)?const\\s+${nama}\\b[^=]*=`);
  const urutan = [berkasAsal, ...berkasSemua.filter((b) => b !== berkasAsal)];

  for (const berkas of urutan) {
    // SELURUH definisi di dalam satu berkas digabung, bukan yang
    // pertama saja: `KasBankService` mendefinisikan `sumberTransaksi`
    // dua kali (penerimaan & pengeluaran) dan `UtangService`
    // mendefinisikan `utangTransactionType` dua kali. Mengambil yang
    // pertama saja akan menyembunyikan separuh nilainya.
    const terkumpul = new Set<string>();
    const barisSemua = fs.readFileSync(berkas, 'utf8').split('\n');
    for (let i = 0; i < barisSemua.length; i++) {
      const baris = tanpaKomentar(barisSemua[i]);
      if (!polaAwal.test(baris)) continue;

      let blok = baris;
      if (!/;\s*$/.test(baris)) {
        for (let j = i + 1; j < barisSemua.length && j < i + 80; j++) {
          const lanjut = tanpaKomentar(barisSemua[j]);
          blok += '\n' + lanjut;
          if (/^\s*\};?\s*$/.test(lanjut) || /;\s*$/.test(lanjut)) break;
        }
      }

      const inisialisasi = blok.slice(blok.indexOf('=') + 1);
      const nilai = stringUpperSnake(inisialisasi);
      if (nilai.length > 0) {
        nilai.forEach((v) => terkumpul.add(v));
        continue;
      }

      // Inisialisasinya sendiri sebuah identifier / lookup Record —
      // telusuri satu tingkat lebih dalam.
      const lanjutan = /^\s*([A-Za-z_$][\w$]*)\s*(?:\[|;|$)/.exec(inisialisasi);
      if (lanjutan && lanjutan[1] !== nama) {
        const dalam = resolusiIdentifier(lanjutan[1], berkas, berkasSemua, kedalaman + 1);
        if (dalam) dalam.forEach((v) => terkumpul.add(v));
      }
    }
    if (terkumpul.size > 0) return [...terkumpul];
  }
  return null;
}

interface HasilPindai {
  nilai: Set<string>;
  takTerselesaikan: string[];
}

function pindaiSumberTransaksi(): HasilPindai {
  const berkasSemua = kumpulkanFileProduksi(AKAR_SRC);
  const nilai = new Set<string>();
  const takTerselesaikan: string[] = [];

  for (const berkas of berkasSemua) {
    const barisSemua = fs.readFileSync(berkas, 'utf8').split('\n');
    for (let i = 0; i < barisSemua.length; i++) {
      const baris = tanpaKomentar(barisSemua[i]);

      // Bentuk properti objek: `sumberTransaksi: <ekspresi>,`
      // dan bentuk shorthand: `sumberTransaksi,`
      const cocok = /(?:^|[\s{(,])sumberTransaksi\s*(?::\s*(.+?))?\s*,\s*$/.exec(baris);
      if (!cocok) continue;

      const ekspresi = (cocok[1] ?? 'sumberTransaksi').trim();

      // Anotasi tipe pada parameter/interface — bukan nilai.
      if (/^string\b/.test(ekspresi)) continue;

      const lokasi = `${path.relative(AKAR_SRC, berkas)}:${i + 1}`;

      // 1. Literal langsung.
      const literal = /^'([A-Z][A-Z0-9_]*)'$/.exec(ekspresi);
      if (literal) {
        nilai.add(literal[1]);
        continue;
      }

      // 2. Propagasi dari jurnal asli (reverseJournal) — tidak
      //    memperkenalkan nilai baru.
      if (PROPAGASI_DIIZINKAN.some((p) => p.test(ekspresi))) continue;

      // 3. Ternary inline yang seluruh cabangnya string literal.
      const inline = stringUpperSnake(ekspresi);
      if (inline.length > 0 && ekspresi.includes('?')) {
        inline.forEach((v) => nilai.add(v));
        continue;
      }

      // 4. Identifier atau lookup Record — resolusikan definisinya.
      const identifier = /^([A-Za-z_$][\w$]*)\s*(?:\[|$)/.exec(ekspresi);
      if (identifier) {
        const hasil = resolusiIdentifier(identifier[1], berkas, berkasSemua);
        if (hasil && hasil.length > 0) {
          hasil.forEach((v) => nilai.add(v));
          continue;
        }
      }

      takTerselesaikan.push(`${lokasi} -> ${ekspresi}`);
    }
  }

  return { nilai, takTerselesaikan };
}

describe('RC-S17 — pemindai sumber transaksi menyelesaikan indireksi, bukan melewatinya', () => {
  test('setiap ekspresi sumber transaksi di source produksi berhasil diselesaikan', () => {
    const { takTerselesaikan } = pindaiSumberTransaksi();
    // Kalau ini gagal, ADA bentuk penulisan baru yang belum dikenali
    // pemindai. Perbaiki pemindainya — jangan longgarkan assertion-nya,
    // karena bentuk yang tak terpindai persis yang menyembunyikan bug
    // klasifikasi selama ini.
    expect(takTerselesaikan).toEqual([]);
  });

  test('pemindai benar-benar menembus Record konstanta (bukan lolos karena hasilnya kosong)', () => {
    const { nilai } = pindaiSumberTransaksi();
    // Nilai-nilai ini HANYA bisa ditemukan dengan meresolusi
    // JENIS_TRANSACTION_TYPE di InvestasiService & MAPPING_BY_JENIS di
    // SimpananService — pemindai lama tidak pernah melihatnya.
    for (const s of [
      'INVESTASI_USAHA_LAIN',
      'INVESTASI_TABUNGAN_BANK_UMUM',
      'INVESTASI_GIRO_BANK_UMUM',
      'INVESTASI_DEPOSITO_BANK_UMUM',
      'INVESTASI_PROPERTI_INVESTASI',
      'SIMPANAN_POKOK',
      'SIMPANAN_WAJIB',
    ]) {
      expect([...nilai]).toContain(s);
    }
  });

  test('pemindai menembus ternary & konstanta modul (KasBank, Utang, Aset, Penyusutan, Berjangka)', () => {
    const { nilai } = pindaiSumberTransaksi();
    for (const s of [
      'KAS_PENERIMAAN_LAIN',
      'BANK_PENGELUARAN_LAIN',
      'UTANG_BANK',
      'UTANG_USAHA',
      'ASET_TAK_BERWUJUD',
      'AMORTISASI_ASET_TAK_BERWUJUD',
      'SIMPANAN_BERJANGKA',
      'SIMPANAN_BERJANGKA_PENCAIRAN',
    ]) {
      expect([...nilai]).toContain(s);
    }
  });

  test('TIDAK ADA sumber transaksi produksi yang belum punya klasifikasi arus kas', () => {
    const { nilai } = pindaiSumberTransaksi();
    const belumTerpetakan = [...nilai].filter((s) => !CASH_FLOW_CLASSIFICATION[s]).sort();
    expect(belumTerpetakan).toEqual([]);
  });

  test('jumlah sumber produksi yang terdeteksi melampaui hasil pemindai literal-saja', () => {
    const { nilai } = pindaiSumberTransaksi();
    // Pemindai literal-saja menemukan 25 nilai; resolusi indireksi
    // menaikkannya secara signifikan. Ambang ini menjaga agar pemindai
    // tidak diam-diam melemah menjadi setara pemindai lama.
    expect(nilai.size).toBeGreaterThanOrEqual(40);
  });
});
