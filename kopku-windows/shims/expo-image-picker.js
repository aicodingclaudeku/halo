/** Shim desktop `expo-image-picker` — pilih gambar dari disk (logo koperasi). */
import { b } from './_bridge';
export const MediaTypeOptions = { Images: 'Images', All: 'All', Videos: 'Videos' };
export const PermissionStatus = { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' };
const izin = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' };
export async function requestMediaLibraryPermissionsAsync() { return izin; }
export async function getMediaLibraryPermissionsAsync() { return izin; }
export async function requestCameraPermissionsAsync() { return { ...izin, granted: false, status: 'denied' }; }
export async function launchImageLibraryAsync() {
  const uris = await b().dialog.openFiles({ title: 'Pilih gambar logo', filters: [{ name: 'Gambar', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (!uris) return { canceled: true, assets: null };
  const uri = uris[0];
  const s = await b().fs.info(uri);
  const fileName = decodeURI(uri.split('/').pop() || 'logo.png');
  const ext = (fileName.split('.').pop() || 'png').toLowerCase();
  return { canceled: false, assets: [{ uri, fileName, fileSize: s.size, width: 0, height: 0, type: 'image', mimeType: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}` }] };
}
export async function launchCameraAsync() { return { canceled: true, assets: null }; }
export default { launchImageLibraryAsync, requestMediaLibraryPermissionsAsync, MediaTypeOptions };
