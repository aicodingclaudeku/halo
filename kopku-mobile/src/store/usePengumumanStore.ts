import { create } from 'zustand';
import {
  muatPengumuman,
  tandaiSudahDibaca,
  type CachePengumuman,
  type Pengumuman,
  type RilisTerbaru,
} from '@/services/PengumumanService';

/**
 * RC-S125 — state lonceng notifikasi. Tipis: semua aturan (jeda, ETag,
 * antrian, sanitasi) ada di PengumumanService.
 */
interface PengumumanState {
  items: readonly Pengumuman[];
  rilis: Readonly<Record<string, RilisTerbaru>>;
  dibaca: readonly string[];
  memuat: boolean;
  muat: (paksa?: boolean) => Promise<void>;
  tandai: (kunci: readonly string[]) => Promise<void>;
}

function terapkan(c: CachePengumuman) {
  return { items: c.items, rilis: c.rilis, dibaca: c.dibaca };
}

export const usePengumumanStore = create<PengumumanState>((set) => ({
  items: [],
  rilis: {},
  dibaca: [],
  memuat: false,
  muat: async (paksa = false) => {
    set({ memuat: true });
    try {
      set(terapkan(await muatPengumuman(paksa)));
    } finally {
      set({ memuat: false });
    }
  },
  tandai: async (kunci) => {
    if (kunci.length === 0) return;
    set(terapkan(await tandaiSudahDibaca(kunci)));
  },
}));
