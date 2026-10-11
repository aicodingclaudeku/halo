'use strict';
/**
 * Normalisasi & validasi nomor WhatsApp Indonesia (seluler).
 *   081234567890   → 6281234567890
 *   +62 812-3456-7890 → 6281234567890
 *   0062812...     → 62812...
 *   81234567890    → 6281234567890
 * Sah bila: 62 8 + 8–11 digit (total 11–14 digit), tanpa karakter lain.
 * Nomor tidak sah → TIDAK dikirim (status skipped), tidak pernah ditebak.
 */
function normalisasiNomor(input) {
  if (input == null) return { valid: false, alasan: 'KOSONG', nomor: null };
  let s = String(input).trim();
  if (!s) return { valid: false, alasan: 'KOSONG', nomor: null };
  if (!/^[0-9+()\-.\s]+$/.test(s)) return { valid: false, alasan: 'KARAKTER_TIDAK_SAH', nomor: null };
  const plus = s.startsWith('+');
  s = s.replace(/[^0-9]/g, '');
  if (plus && !s.startsWith('62')) return { valid: false, alasan: 'BUKAN_INDONESIA', nomor: null };
  if (s.startsWith('0062')) s = s.slice(2);
  else if (s.startsWith('0')) s = '62' + s.slice(1);
  else if (s.startsWith('8')) s = '62' + s;
  if (!s.startsWith('62')) return { valid: false, alasan: 'BUKAN_INDONESIA', nomor: null };
  if (!/^628[1-9][0-9]{7,10}$/.test(s)) return { valid: false, alasan: 'FORMAT_TIDAK_SAH', nomor: null };
  return { valid: true, alasan: null, nomor: s };
}

/** 6281234567890 → 62812****7890 */
function samarkanNomor(n) {
  const s = String(n || '');
  if (s.length < 9) return s ? '****' : '';
  return s.slice(0, 5) + '*'.repeat(Math.max(3, s.length - 9)) + s.slice(-4);
}

module.exports = { normalisasiNomor, samarkanNomor };
