/** Shim desktop `expo-file-system/legacy`. */
import { b } from './_bridge';

const info = (() => { try { return b().info; } catch { return { documentUri: 'kopkufs://local/tmp/', cacheUri: 'kopkufs://local/tmp/' }; } })();
export const documentDirectory = info.documentUri;
export const cacheDirectory = info.cacheUri;
export const bundleDirectory = null;
export const EncodingType = { UTF8: 'utf8', Base64: 'base64' };

export async function getInfoAsync(uri) {
  const s = await b().fs.info(uri);
  return s.exists ? { exists: true, uri, isDirectory: s.isDirectory, size: s.size, modificationTime: s.modificationTime } : { exists: false, uri, isDirectory: false };
}
export function readAsStringAsync(uri, options) { return b().fs.readString(uri, options && options.encoding === 'base64' ? 'base64' : 'utf8'); }
export function writeAsStringAsync(uri, contents, options) { return b().fs.writeString(uri, contents, options && options.encoding === 'base64' ? 'base64' : 'utf8', !!(options && options.append)); }
export async function deleteAsync(uri, options) {
  const s = await b().fs.info(uri);
  if (!s.exists) { if (options && options.idempotent) return; throw new Error(`Berkas tidak ada: ${uri}`); }
  return b().fs.remove(uri);
}
export function moveAsync({ from, to }) { return b().fs.move(from, to); }
export function copyAsync({ from, to }) { return b().fs.copy(from, to); }
export function makeDirectoryAsync(uri) { return b().fs.mkdir(uri); }
export function readDirectoryAsync(uri) { return b().fs.readDir(uri); }
export async function getFreeDiskStorageAsync() { return Number.MAX_SAFE_INTEGER; }
export default { documentDirectory, cacheDirectory, EncodingType, getInfoAsync, readAsStringAsync, writeAsStringAsync, deleteAsync, moveAsync, copyAsync, makeDirectoryAsync, readDirectoryAsync };
