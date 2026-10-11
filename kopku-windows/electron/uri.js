'use strict';
/**
 * Konversi URI aplikasi <-> path disk.
 * documentDirectory desktop = "kopkufs://local/<path ter-encode>/" (bukan file://)
 * supaya <Image> dan fetch di renderer (origin app://) dapat memuat berkas
 * lokal lewat protokol khusus yang dibatasi ke folder data aplikasi.
 * Logika identik juga ditulis di preload.js (preload sandbox tidak boleh require berkas lokal).
 */
function toPath(u) {
  let s = String(u);
  if (s.startsWith('kopkufs://local')) s = s.slice('kopkufs://local'.length);
  else if (s.startsWith('file://')) s = s.slice('file://'.length);
  else return s;
  s = decodeURI(s);
  if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1); // Windows: /C:/... -> C:/...
  return s;
}
function pathToUri(p) {
  let s = String(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return 'kopkufs://local' + encodeURI(s);
}
function dirToUri(p) {
  const u = pathToUri(p);
  return u.endsWith('/') ? u : u + '/';
}
module.exports = { toPath, pathToUri, dirToUri };
