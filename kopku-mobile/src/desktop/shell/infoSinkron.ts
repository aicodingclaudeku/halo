import type { Ionicons } from '@expo/vector-icons';
import type { StatusSinkron } from '@/sync/SyncStore';

export const STATUS_SINKRON: Record<StatusSinkron, { label: string; warna: string; ikon: keyof typeof Ionicons.glyphMap }> = {
  // RC-S133.5 — sinkron manual: "terhubung" + kirim data atas perintah.
  BELUM_DIPASANGKAN: { label: 'HP belum terhubung', warna: '#8B97A8', ikon: 'phone-portrait-outline' },
  PERLU_DATA_AWAL: { label: 'HP terhubung', warna: '#1F8A4F', ikon: 'link' },
  SIAP: { label: 'HP terhubung', warna: '#1F8A4F', ikon: 'checkmark-circle' },
  MENYINKRONKAN: { label: 'Mengirim data…', warna: '#2563EB', ikon: 'sync' },
  TIDAK_TERHUBUNG: { label: 'HP tidak terhubung', warna: '#8B97A8', ikon: 'cloud-offline-outline' },
  KONFLIK: { label: 'Konflik perlu diputuskan', warna: '#C2312E', ikon: 'alert-circle' },
  PERLU_SINKRON_ULANG: { label: 'Perlu sinkron ulang', warna: '#C2312E', ikon: 'refresh-circle' },
  MENUNGGU_KONFIRMASI: { label: 'Menunggu persetujuan', warna: '#B7791F', ikon: 'hourglass-outline' },
  GALAT: { label: 'Pengiriman gagal', warna: '#C2312E', ikon: 'warning' },
};

export function waktuRelatif(iso: string | null): string {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'baru saja';
  if (d < 3600) return `${Math.floor(d / 60)} menit lalu`;
  if (d < 86400) return `${Math.floor(d / 3600)} jam lalu`;
  return new Date(iso).toLocaleDateString('id-ID');
}

export const LABEL_ROLE: Record<string, string> = {
  ADMIN: 'Administrator',
  PENGURUS: 'Pengurus',
  BENDAHARA: 'Bendahara',
  PETUGAS: 'Petugas',
  ANGGOTA: 'Anggota',
};

export function inisial(nama: string | null | undefined): string {
  const k = (nama ?? '').trim().split(/\s+/).filter(Boolean);
  if (k.length === 0) return '?';
  return ((k[0][0] ?? '') + (k.length > 1 ? k[k.length - 1][0] ?? '' : '')).toUpperCase();
}

/** Nama rute terdalam yang sedang fokus pada sebuah route (tab/stack). */
export function ruteTerdalam(route: any): { name: string; params?: Record<string, unknown> } | null {
  let r = route;
  while (r?.state && Array.isArray(r.state.routes) && r.state.routes.length > 0) {
    r = r.state.routes[r.state.index ?? r.state.routes.length - 1];
  }
  return r ? { name: r.name, params: r.params } : null;
}
