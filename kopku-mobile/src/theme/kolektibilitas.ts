import { colors } from './colors';
import type { KolektibilitasSom } from '@/services/KolektibilitasSomService';

/**
 * WARNA KATEGORI KOLEKTIBILITAS — SATU SUMBER untuk seluruh aplikasi.
 *
 * Sebelum berkas ini, layar Kolektibilitas Piutang dan layar Detail
 * Anggota masing-masing punya peta warna kategorinya sendiri, dengan hex
 * yang mirip tapi tidak sama (mis. Diragukan '#B71C1C' di satu layar dan
 * '#E65100' di layar lain) — sehingga kategori yang SAMA tampil dengan
 * warna BERBEDA tergantung dari mana pengguna membukanya.
 *
 * Tipenya `Record<KolektibilitasSom, ...>` DENGAN SENGAJA: kalau daftar
 * kategori SOM berubah, TypeScript akan menolak kompilasi sampai warna
 * kategori barunya ditentukan — tidak ada kategori yang diam-diam jatuh
 * ke warna default.
 *
 * Skala warnanya gradual (hijau -> jingga -> merah tua -> merah) supaya
 * tingkat risiko terbaca sekilas tanpa membaca labelnya. Dua jingga/merah
 * di bawah adalah nilai yang SUDAH dipakai layar-layar tersebut, hanya
 * dipindahkan ke satu tempat — bukan palet baru.
 */
export const kolektibilitasColor: Record<KolektibilitasSom, string> = {
  LANCAR: colors.primary,
  KURANG_LANCAR: '#E65100',
  DIRAGUKAN: '#B71C1C',
  MACET: colors.danger,
};

/** Pasangan latar/teks untuk badge kategori — diturunkan dari `kolektibilitasColor`. */
export const kolektibilitasBadge: Record<KolektibilitasSom, { bg: string; fg: string }> = {
  LANCAR: { bg: colors.primaryLight, fg: colors.primary },
  KURANG_LANCAR: { bg: '#FFF3E0', fg: '#E65100' },
  DIRAGUKAN: { bg: colors.dangerBg, fg: '#B71C1C' },
  MACET: { bg: colors.dangerBg, fg: colors.danger },
};

/** Badge netral untuk keadaan "tidak ada kategori" (mis. anggota tanpa piutang). */
export const kolektibilitasBadgeKosong = { bg: colors.background, fg: colors.textMuted };

/**
 * `hex` -> `rgba()` dengan opasitas, supaya tint lembut per kategori bisa
 * diturunkan langsung dari `kolektibilitasColor` tanpa menambah token
 * warna baru satu per satu untuk tiap kombinasi kategori x opasitas.
 */
export function tintKolektibilitas(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16);
  const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16);
  const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
