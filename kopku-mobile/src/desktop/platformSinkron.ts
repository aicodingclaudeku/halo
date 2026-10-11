/**
 * Info platform untuk modul sinkron — versi HP (Android). Metro memilih
 * `platformSinkron.web.ts` untuk build desktop (Electron).
 */
export function infoPlatformSinkron(): { jenis: 'DESKTOP' | 'HP'; nama: string } {
  return { jenis: 'HP', nama: 'HP KOPKU' };
}

/** Ubah URI berkas aplikasi menjadi path sistem berkas (untuk VACUUM INTO). */
export function uriKePath(uri: string): string {
  return decodeURI(uri.replace(/^file:\/\//, ''));
}

export function apakahDesktop(): boolean {
  return false;
}
