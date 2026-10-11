/** Shim desktop `expo-document-picker` — dialog Buka berkas sistem; berkas disalin ke cache aplikasi. */
import { b } from './_bridge';
const MIME = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-excel': ['xls'],
  'text/csv': ['csv'],
  'application/pdf': ['pdf'],
  'application/json': ['json'],
  'application/x-sqlite3': ['db', 'sqlite', 'kdb'],
  'application/octet-stream': ['kdb', 'db', 'sqlite'],
  'image/*': ['png', 'jpg', 'jpeg', 'webp', 'gif'],
};
function tebakMime(nama) {
  const e = (nama.split('.').pop() || '').toLowerCase();
  return { xlsx: MIME_XLSX, xls: 'application/vnd.ms-excel', csv: 'text/csv', pdf: 'application/pdf', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[e] || 'application/octet-stream';
}
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export async function getDocumentAsync(options = {}) {
  const types = [].concat(options.type || '*/*');
  const ext = types.flatMap((t) => MIME[t] || []);
  const filters = ext.length && !types.includes('*/*') ? [{ name: 'Berkas yang didukung', extensions: ext }, { name: 'Semua berkas', extensions: ['*'] }] : undefined;
  const uris = await b().dialog.openFiles({ title: 'Pilih berkas', filters, multiple: !!options.multiple });
  if (!uris) return { canceled: true, assets: null };
  const assets = [];
  for (const uri of uris) {
    const s = await b().fs.info(uri);
    const name = decodeURI(uri.split('/').pop() || 'berkas');
    assets.push({ uri, name, size: s.size, mimeType: tebakMime(name), lastModified: Math.round(s.modificationTime * 1000) });
  }
  return { canceled: false, assets };
}
export default { getDocumentAsync };
