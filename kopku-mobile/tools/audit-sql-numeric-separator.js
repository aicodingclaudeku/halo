/**
 * Pemindai kompatibilitas SQL: menemukan numeric separator (`1_000`)
 * yang berada DI DALAM string SQL.
 *
 * Latar belakang: SQLite baru mendukung separator underscore pada
 * literal numerik sejak versi 3.46.0. Lingkungan test (sql.js) memakai
 * 3.45.2, sehingga `VALUES (..., 2_000_000, ...)` ditolak dengan
 * "unrecognized token". Separator pada literal TypeScript sendiri
 * sepenuhnya sah dan TIDAK boleh diusik.
 *
 * Dipakai oleh:
 *  - audit sesi (dijalankan manual lewat node)
 *  - regression test `SqlNumericSeparator.test.ts`
 */

const fs = require('fs');
const path = require('path');

const SQL_KEYWORDS = /\b(INSERT\s+INTO|INSERT\s+OR|UPDATE\s+|SELECT\s+|DELETE\s+FROM|CREATE\s+TABLE|CREATE\s+INDEX|CREATE\s+UNIQUE|ALTER\s+TABLE|VALUES\s*\(|PRAGMA\s+|DROP\s+TABLE)/i;
const SEPARATOR = /[0-9]_[0-9]/;

/**
 * Mengumpulkan seluruh literal string (backtick, kutip tunggal, kutip
 * ganda) beserta nomor barisnya. Pemindai karakter sederhana yang cukup
 * untuk basis kode ini: menangani escape (`\'`) dan mengabaikan komentar
 * baris/blok supaya contoh SQL di dalam komentar tidak ikut terdeteksi.
 */
function collectStringLiterals(source) {
  const literals = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    // Komentar baris
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // Komentar blok
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (ch === '`' || ch === "'" || ch === '"') {
      const quote = ch;
      const startLine = line;
      let content = '';
      i++;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          content += c + (source[i + 1] ?? '');
          if (source[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        if (c === '\n') {
          if (quote !== '`') break; // string biasa tidak boleh multi-baris
          line++;
        }
        content += c;
        i++;
      }
      literals.push({ content, line: startLine });
      continue;
    }

    i++;
  }

  return literals;
}

/** Mengembalikan daftar pelanggaran untuk satu berkas. */
function scanSource(source, filePath) {
  const pelanggaran = [];
  for (const literal of collectStringLiterals(source)) {
    if (!SQL_KEYWORDS.test(literal.content)) continue;
    if (!SEPARATOR.test(literal.content)) continue;
    const cocok = literal.content.match(/[0-9][0-9_]*_[0-9][0-9_]*/g) || [];
    for (const angka of new Set(cocok)) {
      pelanggaran.push({ file: filePath, line: literal.line, literal: angka });
    }
  }
  return pelanggaran;
}

function walk(dir, hasil = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, hasil);
    else if (/\.tsx?$/.test(entry.name)) hasil.push(full);
  }
  return hasil;
}

/**
 * Berkas yang SENGAJA dikecualikan: berkas test pemindai ini sendiri
 * berisi contoh SQL bermasalah sebagai FIXTURE NEGATIF (untuk
 * membuktikan pemindai memang mendeteksinya). Fixture itu tidak pernah
 * dikirim ke mesin SQLite mana pun — ia hanya string di dalam assertion.
 * Tanpa pengecualian ini, pemindai akan melaporkan contoh-contoh
 * pengujiannya sendiri sebagai pelanggaran.
 */
const DIKECUALIKAN = ['SqlNumericSeparator.test.ts'];

function scanDirectories(dirs) {
  const pelanggaran = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      if (DIKECUALIKAN.some((nama) => file.endsWith(nama))) continue;
      pelanggaran.push(...scanSource(fs.readFileSync(file, 'utf8'), file));
    }
  }
  return pelanggaran;
}

module.exports = { scanSource, scanDirectories, collectStringLiterals };

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  const hasil = scanDirectories([path.join(root, 'src'), path.join(root, 'app')]);
  if (hasil.length === 0) {
    console.log('OK — tidak ada numeric separator di dalam string SQL.');
    process.exit(0);
  }
  console.log(`DITEMUKAN ${hasil.length} numeric separator di dalam string SQL:`);
  for (const p of hasil) console.log(`  ${p.file}:${p.line}  ${p.literal}`);
  process.exit(1);
}
