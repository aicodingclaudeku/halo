import { readFileSync, readdirSync, statSync } from 'fs';
import { teksPdf } from '@/export/TeksPdf';
import { join } from 'path';
import { ACCOUNTING_POLICY, STANDAR_AKUNTANSI_DEFAULT } from '@/config/defaultCOA';

/**
 * INVARIAN: SAK EP ADALAH SATU-SATUNYA STANDAR AKUNTANSI AKTIF.
 *
 * Suite ini tidak menguji perhitungan — perhitungan sudah dijaga suite
 * akuntansi yang ada dan TIDAK diubah oleh migrasi ini. Yang dijaga di
 * sini adalah sifat yang mudah bocor kembali tanpa disadari: satu
 * `if (standar === 'SAK_EMKM')` yang diselipkan orang lain suatu saat
 * akan menghidupkan kembali mode yang seharusnya sudah tidak ada.
 *
 * Audit RC-S37 membuktikan tidak ada satu pun PERHITUNGAN yang bercabang
 * berdasarkan standar; yang berbeda hanya label judul laporan. Karena
 * itu penghapusan ini tidak mengubah angka apa pun.
 */

const ROOT = join(__dirname, '..', '..');

function berkasSumber(dir: string, hasil: string[] = []): string[] {
  for (const entri of readdirSync(dir)) {
    if (entri === 'node_modules' || entri === '.harness' || entri === '__tests__') continue;
    const penuh = join(dir, entri);
    if (statSync(penuh).isDirectory()) berkasSumber(penuh, hasil);
    else if (/\.(ts|tsx)$/.test(entri)) hasil.push(penuh);
  }
  return hasil;
}

function tanpaKomentar(sumber: string): string {
  return sumber.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('konfigurasi standar akuntansi', () => {
  it('default aplikasi adalah SAK_EP', () => {
    expect(STANDAR_AKUNTANSI_DEFAULT).toBe('SAK_EP');
  });

  it('ACCOUNTING_POLICY hanya punya SAK_EP', () => {
    expect(Object.keys(ACCOUNTING_POLICY)).toEqual(['SAK_EP']);
  });

  it('tidak ada kunci SAK_EMKM di ACCOUNTING_POLICY', () => {
    expect((ACCOUNTING_POLICY as Record<string, unknown>).SAK_EMKM).toBeUndefined();
  });

  it('label laporan laba rugi memakai istilah SAK EP', () => {
    expect(ACCOUNTING_POLICY.SAK_EP.labelLabaRugi).toBe('Laporan Perhitungan Hasil Usaha'); // DIPERBARUI Poin 17
  });

  it('field mati wajibArusKas/wajibCALK sudah dihapus', () => {
    // Keduanya tidak pernah dibaca di mana pun. Field mati berbahaya
    // justru karena terlihat berarti: `wajibArusKas: false` tampak
    // seperti "arus kas dimatikan", padahal tidak ada yang membacanya.
    const policy = ACCOUNTING_POLICY.SAK_EP as Record<string, unknown>;
    expect(policy.wajibArusKas).toBeUndefined();
    expect(policy.wajibCALK).toBeUndefined();
  });
});

describe('tidak ada logic SAK EMKM yang masih dapat dieksekusi', () => {
  const sumber = berkasSumber(join(ROOT, 'src')).concat(berkasSumber(join(ROOT, 'app')));

  it('tidak ada percabangan berdasarkan SAK_EMKM di seluruh source produksi', () => {
    const pelanggaran: string[] = [];
    for (const berkas of sumber) {
      const kode = tanpaKomentar(readFileSync(berkas, 'utf8'));
      // Yang dicari: SAK_EMKM sebagai NILAI yang dibandingkan atau
      // dipilih — bukan penyebutannya di dalam komentar.
      if (/['"`]SAK_EMKM['"`]/.test(kode)) {
        pelanggaran.push(berkas.replace(ROOT + '/', ''));
      }
    }
    // Satu pengecualian sah: normalisasi nilai legacy saat MEMBACA
    // database lama. Ia mengubah SAK_EMKM menjadi SAK_EP, bukan
    // memilihnya.
    const diizinkan = ['src/database/db.ts'];
    expect(pelanggaran.filter((f) => !diizinkan.includes(f))).toEqual([]);
  });

  it('tipe StandarAkuntansi hanya punya satu anggota', () => {
    const config = readFileSync(join(ROOT, 'src', 'config', 'defaultCOA.ts'), 'utf8');
    expect(config).toMatch(/export type StandarAkuntansi = 'SAK_EP';/);
    expect(tanpaKomentar(config)).not.toMatch(/StandarAkuntansi\s*=\s*'SAK_EP'\s*\|/);
  });

  it('setupKoperasi tidak lagi menerima pilihan standar', () => {
    const setup = tanpaKomentar(readFileSync(join(ROOT, 'src', 'services', 'SetupService.ts'), 'utf8'));
    expect(setup).not.toMatch(/standarAkuntansi\?: StandarAkuntansi/);
    expect(setup).toMatch(/const standarAkuntansiEfektif: StandarAkuntansi = STANDAR_AKUNTANSI_DEFAULT;/);
  });

  it('laporan laba rugi tidak bercabang berdasarkan standar koperasi', () => {
    const layar = tanpaKomentar(
      readFileSync(join(ROOT, 'src', 'screens', 'Laporan', 'LabaRugiScreen.tsx'), 'utf8')
    );
    expect(layar).not.toMatch(/ACCOUNTING_POLICY\[koperasi\.standarAkuntansi\]/);
    expect(layar).toMatch(/ACCOUNTING_POLICY\.SAK_EP\.labelLabaRugi/);
  });

  // DIPERBARUI Poin 2 (permintaan pengguna): label/branding "SAK EP" TIDAK
  // lagi dicetak di PDF. Logika SAK EP (satu-satunya standar) tetap utuh —
  // yang berubah hanya teks keluaran PDF. Invarian lama yang tetap dijaga:
  // nilai standar dari database tidak pernah dicetak.
  it('header PDF tidak lagi mencetak label SAK EP, dan tidak pernah mencetak nilai standar dari data', () => {
    const html = tanpaKomentar(readFileSync(join(ROOT, 'src', 'export', 'HtmlReportBuilder.ts'), 'utf8'));
    expect(html).not.toMatch(/SAK Entitas Privat \(SAK EP\)/);
    expect(html).not.toMatch(/escapeHtml\(data\.standarAkuntansi\)/);
    expect(html).toMatch(/teksPdf\(/);
  });

  it('teks PDF dibersihkan dari label SAK EP & tanggal ISO dicetak format Indonesia', () => {
    expect(teksPdf('Laporan keuangan disusun berdasarkan SAK Entitas Privat (SAK EP) dengan basis akrual')).toBe(
      'Laporan keuangan disusun berdasarkan standar akuntansi keuangan yang berlaku dengan basis akrual'
    );
    expect(teksPdf('model revaluasi (SAK EP Bab 17): nilai')).toBe('model revaluasi: nilai');
    expect(teksPdf('Per 2026-10-04')).toBe('Per 4 Oktober 2026');
    expect(teksPdf('2026-01-01 s.d. 2026-12-31')).toBe('1 Januari 2026 s.d. 31 Desember 2026');
    // Tanggal yang menempel pada nomor dokumen tidak diubah.
    expect(teksPdf('PJM-2026-01-15-001')).toBe('PJM-2026-01-15-001');
  });
});

describe('keluaran laporan tidak pernah mencetak nilai standar dari database', () => {
  /**
   * KELOLOSAN YANG DITUTUP TEST INI.
   *
   * Scan invarian RC-S39 mencari `SAK_EMKM` sebagai literal dan
   * menyatakan "ACTIVE PRODUCTION REFERENCE = 0". Scan itu BENAR tetapi
   * TIDAK CUKUP: narasi CALK dibangun dengan
   *
   *     `${namaStandar.replace('_', ' ')}`
   *
   * atas nilai yang dibaca langsung dari `koperasi.standar_akuntansi`.
   * Tidak ada literal 'SAK_EMKM' di kode itu — tetapi instalasi lama
   * tetap mencetak "disusun berdasarkan SAK EMKM" di laporan aktif.
   *
   * Pelajarannya: mencari literal tidak menemukan string yang DIBANGUN
   * saat runtime. Yang dikunci sekarang adalah sifatnya — nama standar
   * di laporan tidak boleh berasal dari data.
   */
  it('narasi kebijakan tidak menerima nama standar dari pemanggil', () => {
    const policy = tanpaKomentar(
      readFileSync(join(ROOT, 'src', 'services', 'AccountingPolicyService.ts'), 'utf8')
    );
    expect(policy).toMatch(/export function getKebijakanAkuntansiNarasi\(\): KebijakanAkuntansiItem\[\]/);
    expect(policy).toMatch(/NAMA_STANDAR_AKUNTANSI/);
    expect(policy).not.toMatch(/namaStandar/);
  });

  it('nama standar di laporan adalah konstanta kanonik', () => {
    const config = readFileSync(join(ROOT, 'src', 'config', 'defaultCOA.ts'), 'utf8');
    expect(config).toMatch(/NAMA_STANDAR_AKUNTANSI = 'SAK Entitas Privat \(SAK EP\)'/);
  });

  it('CALK tidak lagi membaca standar dari baris koperasi', () => {
    const laporan = tanpaKomentar(
      readFileSync(join(ROOT, 'src', 'reports', 'FinancialReports.ts'), 'utf8')
    );
    expect(laporan).not.toMatch(/namaStandar/);
    expect(laporan).toMatch(/getKebijakanAkuntansiNarasi\(\)/);
  });

  it('tidak ada .replace(\'_\', \' \') atas nilai standar di mana pun', () => {
    // Pola inilah yang mengubah 'SAK_EMKM' menjadi 'SAK EMKM' tanpa
    // pernah menuliskan literalnya.
    for (const berkas of berkasSumber(join(ROOT, 'src'))) {
      const kode = tanpaKomentar(readFileSync(berkas, 'utf8'));
      expect(kode).not.toMatch(/namaStandar\.replace/);
    }
  });
});

describe('skema database', () => {
  const schema = readFileSync(join(ROOT, 'src', 'database', 'schema.ts'), 'utf8');

  it('CHECK constraint hanya menerima SAK_EP', () => {
    expect(schema).toMatch(/standar_akuntansi TEXT NOT NULL CHECK \(standar_akuntansi IN \('SAK_EP'\)\)/);
    expect(schema).not.toMatch(/IN \('SAK_EP','SAK_EMKM'\)/);
  });

  it('versi skema minimal 56 (versi migrasi SAK EP)', () => {
    /**
     * Diuji sebagai AMBANG MINIMUM, bukan angka persis.
     *
     * Versi pertama mengunci `= 56` dan langsung usang begitu RC-S44b
     * menaikkannya ke 57 untuk keperluan yang sama sekali berbeda.
     * Test yang gagal setiap kali skema bertambah — tanpa ada yang
     * salah dengan SAK EP — melatih orang mengabaikan kegagalannya.
     *
     * Yang benar-benar penting adalah CHECK constraint-nya, dan itu
     * diuji terpisah di atas.
     */
    const versi = Number(/export const SCHEMA_VERSION = (\d+);/.exec(schema)?.[1]);
    expect(Number.isFinite(versi)).toBe(true);
    expect(versi).toBeGreaterThan(55);
  });

  it('migrasi menormalisasi data SEBELUM mempersempit CHECK', () => {
    // Urutan terbalik akan menggagalkan rebuild pada instalasi lama:
    // baris SAK_EMKM melanggar CHECK baru saat disalin, dan seluruh
    // migrasi batal — pengguna terjebak database yang tak dapat dibuka.
    const db = readFileSync(join(ROOT, 'src', 'database', 'db.ts'), 'utf8');
    const normalisasi = db.indexOf("UPDATE koperasi SET standar_akuntansi = 'SAK_EP'");
    const verifikasi = db.indexOf('Migrasi v56 dibatalkan');
    const rebuild = db.indexOf('CREATE TABLE koperasi_v56');
    expect(normalisasi).toBeGreaterThan(-1);
    expect(verifikasi).toBeGreaterThan(normalisasi);
    expect(rebuild).toBeGreaterThan(verifikasi);
  });

  it('migrasi tidak memuat operasi destruktif terhadap data bisnis', () => {
    const db = readFileSync(join(ROOT, 'src', 'database', 'db.ts'), 'utf8');
    // DIPERBARUI RC-S51. Potongan sebelumnya memakai JENDELA TETAP
    // 4.000 karakter dari `CREATE TABLE koperasi_v56`, sehingga
    // penambahan komentar apa pun di dalam blok v56 menggeser jendela
    // itu sampai ikut memuat blok migrasi v57 — dan `DROP TABLE`
    // miliknya yang sah lalu ditandai sebagai pelanggaran. Sekarang
    // potongan dibatasi pada blok v56 SUNGGUHAN (sampai awal blok
    // versi berikutnya), dan komentar dibuang supaya penjelasan yang
    // MENYEBUT `DROP TABLE` tidak lagi salah dianggap sebagai kode.
    //
    // Sifat yang dijaga tidak berubah: satu-satunya operasi destruktif
    // pada blok ini adalah `DROP TABLE koperasi` sebagai bagian
    // prosedur rebuild resmi SQLite.
    const awal = db.indexOf('if (currentVersion < 56)');
    const blok = db
      .slice(awal, db.indexOf('if (currentVersion < 57)', awal))
      .replace(/^\s*\/\/.*$/gm, '');
    expect(blok).not.toMatch(/DELETE FROM (?!.*koperasi_v56)/);
    expect(blok).not.toMatch(/TRUNCATE/);
    expect(blok).not.toMatch(/DROP TABLE (?!koperasi;)/);
  });
});
