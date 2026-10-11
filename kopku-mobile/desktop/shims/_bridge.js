export function b() {
  const x = globalThis.kopkuDesktop;
  if (!x) throw new Error('KOPKU Desktop: jembatan sistem tidak tersedia (jalankan lewat aplikasi desktop).');
  return x;
}
