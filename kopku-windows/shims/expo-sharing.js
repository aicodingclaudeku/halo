/**
 * Shim desktop `expo-sharing`. Di HP "Bagikan" membuka share sheet; di
 * desktop padanannya adalah lembar aksi berkas: Simpan Sebagai, Buka,
 * Tampilkan di Folder, dan Cetak (dirender oleh DesktopHost). Bila host
 * belum terpasang, langsung membuka dialog Simpan Sebagai.
 */
import { b } from './_bridge';
export async function isAvailableAsync() { return true; }
export async function shareAsync(url, options = {}) {
  const host = globalThis.__kopkuLembarBerkas;
  if (typeof host === 'function') return host(url, options);
  const nama = decodeURI(String(url).split('/').pop() || 'berkas');
  await b().dialog.saveFile(url, nama);
}
export default { isAvailableAsync, shareAsync };
