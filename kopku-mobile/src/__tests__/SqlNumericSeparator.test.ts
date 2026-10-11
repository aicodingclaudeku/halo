import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scanSource, scanDirectories } = require('../../tools/audit-sql-numeric-separator.js');

/**
 * REGRESSION GUARD — numeric separator di dalam string SQL.
 *
 * Kenapa aturan ini ada:
 * SQLite baru mendukung separator underscore pada literal numerik sejak
 * versi 3.46.0. Lingkungan test memakai sql.js yang membundel SQLite
 * 3.45.2, sehingga SQL seperti `VALUES (..., 2_000_000, ...)` ditolak
 * dengan "unrecognized token" — persis empat kegagalan test yang
 * ditemukan pada sesi sebelumnya (RAKService x2, PeriodCloseService x2).
 *
 * PENTING — aturan ini SENGAJA SEMPIT:
 *   - separator di dalam string SQL  -> DILARANG (masalah kompatibilitas)
 *   - separator pada literal TypeScript -> SEPENUHNYA SAH, tidak diusik
 *
 * Basis kode ini memakai ~1950 separator TypeScript yang meningkatkan
 * keterbacaan nominal Rupiah (`debit: 1_000_000`). Melarangnya secara
 * menyeluruh akan merugikan tanpa alasan. Yang dijaga hanyalah teks yang
 * benar-benar dikirim ke mesin SQLite.
 */

const ROOT = path.resolve(__dirname, '..', '..');

test('tidak ada numeric separator di dalam string SQL mana pun (src/ & app/)', () => {
  const pelanggaran = scanDirectories([path.join(ROOT, 'src'), path.join(ROOT, 'app')]);
  const ringkasan = pelanggaran
    .map((p: any) => `${path.relative(ROOT, p.file)}:${p.line} -> ${p.literal}`)
    .join('\n');
  expect(ringkasan).toBe('');
});

describe('pemindai membedakan SQL dari TypeScript dengan benar', () => {
  test('separator DI DALAM SQL terdeteksi sebagai pelanggaran', () => {
    const kode = `
      await db.runAsync(\`INSERT INTO rak_transaksi (jumlah) VALUES (2_000_000)\`);
    `;
    const hasil = scanSource(kode, 'contoh.ts');
    expect(hasil).toHaveLength(1);
    expect(hasil[0].literal).toBe('2_000_000');
  });

  test('separator pada literal TypeScript TIDAK dianggap pelanggaran', () => {
    const kode = `
      const nominal = 2_000_000;
      const baris = { accountId: ACC.kas, debit: 1_000_000, kredit: 0 };
    `;
    expect(scanSource(kode, 'contoh.ts')).toHaveLength(0);
  });

  test('nominal SQL sebagai parameter terikat (bukan literal SQL) tetap sah', () => {
    // Pola yang BENAR: nominal dikirim sebagai parameter, bukan
    // ditanam ke dalam teks SQL. Separator TypeScript-nya tetap boleh.
    const kode = `
      await db.runAsync(\`INSERT INTO rak_transaksi (jumlah) VALUES (?)\`, 2_000_000);
    `;
    expect(scanSource(kode, 'contoh.ts')).toHaveLength(0);
  });

  test('SQL tanpa separator dinyatakan bersih', () => {
    const kode = `
      await db.runAsync(\`INSERT INTO rak_transaksi (jumlah) VALUES (2000000)\`);
    `;
    expect(scanSource(kode, 'contoh.ts')).toHaveLength(0);
  });

  test('contoh SQL di dalam komentar tidak menghasilkan false positive', () => {
    const kode = `
      // INSERT INTO contoh VALUES (2_000_000)
      /* INSERT INTO contoh VALUES (3_000_000) */
      const nominal = 4_000_000;
    `;
    expect(scanSource(kode, 'contoh.ts')).toHaveLength(0);
  });

  test('string non-SQL yang kebetulan berisi separator tidak ditandai', () => {
    const kode = `
      const pesan = 'Nominal maksimal 5_000_000 rupiah';
    `;
    expect(scanSource(kode, 'contoh.ts')).toHaveLength(0);
  });
});
