'use strict';
/**
 * KOPKU Desktop — Asisten AI · PENYARING KELUARAN (1.0.28).
 *
 * Semua yang dikirim ke AI (Claude/ChatGPT) melewati penyaring ini:
 *   - data pribadi: NIK, alamat, kontak, tanggal/tempat lahir, rekening, kredensial (kunci dibuang);
 *   - struktur internal: ID teknis (UUID, kunci *Id/*_id), jalur berkas, URI internal, jejak stack,
 *     nama tabel/kolom & pesan SQL — tidak pernah dikirim. Rujukan untuk AI cukup nomor yang
 *     terlihat di aplikasi (nomor anggota, nomor pinjaman, nomor transaksi, kode akun).
 */

const KUNCI_PRIBADI = /^(nik|no_?ktp|ktp|alamat\w*|nomor_?hp|no_?hp|hp|telepon\w*|nomor_?telepon|phone\w*|email|tempat_?lahir|tanggal_?lahir|tgl_?lahir|nama_?ibu\w*|foto\w*|nomor_?rekening|no_?rekening|nama_?pemilik|npwp\w*|password\w*|pin|pin_?hash|pin_?salt|hash\w*|password_?salt|salt|token\w*|secret\w*|api_?key|versi|versi_?jadwal)$/i;
/** Kunci teknis yang membuka struktur internal aplikasi. */
const KUNCI_INTERNAL = /^(id|uuid|[a-z0-9]+Id|[a-z0-9_]+_id|uri|url|path|jalur|folder|filePath|fileUri|dbPath|sumberId|reversalOfId|createdBy|updatedBy|approvedBy|operasiInvestasi|operasiAsetTetap|sql|stack|query)$/;

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_JALUR_WIN = /\b[A-Za-z]:\\(?:[^\s"'<>|*?\\]+\\)*[^\s"'<>|*?\\]*/g;
const RE_JALUR_POSIX = /(?:^|[\s("'=])(\/(?:home|Users|tmp|var|opt|usr|private|Applications|root|mnt|etc)\/[^\s"')]*)/g;
const RE_URI_INTERNAL = /\b(?:kopkufs|app|file):\/\/[^\s"')]*/gi;
const RE_STACK = /\n?\s*at [^\n]*\([^)]*:\d+:\d+\)/g;
const RE_SQL = /\b(SQLITE_\w+|no such (?:table|column)|syntax error|UNIQUE constraint failed[^.]*|FOREIGN KEY constraint failed)\b/gi;

/** Samarkan isi teks bebas (pesan galat, deskripsi transaksi, dsb.). */
function samarkanTeks(s) {
  if (typeof s !== 'string' || !s) return s;
  return s
    .replace(RE_STACK, '')
    .replace(RE_URI_INTERNAL, '[internal]')
    .replace(RE_JALUR_WIN, '[jalur]')
    .replace(RE_JALUR_POSIX, (m, p) => m.replace(p, '[jalur]'))
    .replace(RE_UUID, '[id]')
    .replace(RE_SQL, 'galat penyimpanan');
}

/** Saring nilai apa pun secara rekursif sebelum dikirim ke AI. */
function saring(nilai, kedalaman = 0) {
  if (kedalaman > 14 || nilai == null) return nilai;
  if (Array.isArray(nilai)) return nilai.map((v) => saring(v, kedalaman + 1));
  if (typeof nilai === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(nilai)) {
      if (KUNCI_PRIBADI.test(k) || KUNCI_INTERNAL.test(k)) continue;
      out[k] = saring(v, kedalaman + 1);
    }
    return out;
  }
  if (typeof nilai === 'number' && !Number.isFinite(nilai)) return null;
  if (typeof nilai === 'string') return samarkanTeks(nilai);
  return nilai;
}

/** Kebijakan untuk AI — teksnya di katalog.js (ikut dikirim server stdio). */
const { KEBIJAKAN } = require('./katalog');

module.exports = { saring, samarkanTeks, KEBIJAKAN, KUNCI_PRIBADI, KUNCI_INTERNAL };
