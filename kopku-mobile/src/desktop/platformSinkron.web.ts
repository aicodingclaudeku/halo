import { bridge } from './bridge';

/** Versi desktop (Electron) — lihat platformSinkron.ts. */
export function infoPlatformSinkron(): { jenis: 'DESKTOP' | 'HP'; nama: string } {
  const b = bridge();
  return { jenis: 'DESKTOP', nama: b ? `${b.info.platformLabel} — ${b.info.hostname}` : 'Desktop KOPKU' };
}

export function uriKePath(uri: string): string {
  const b = bridge();
  if (!b) throw new Error('Jembatan desktop tidak tersedia.');
  return b.fs.uriToPath(uri);
}

export function apakahDesktop(): boolean {
  return !!bridge();
}
