import { create } from 'zustand';
import type { BarisKonflik } from './SyncEngine';

export type StatusSinkron =
  | 'BELUM_DIPASANGKAN'
  | 'PERLU_DATA_AWAL'
  | 'SIAP'
  | 'MENYINKRONKAN'
  | 'TIDAK_TERHUBUNG'
  | 'KONFLIK'
  | 'PERLU_SINKRON_ULANG'
  | 'MENUNGGU_KONFIRMASI'
  | 'GALAT';

export interface PermintaanKonfirmasi {
  id: string;
  judul: string;
  pesan: string;
  setujui: () => Promise<void>;
  tolak: () => Promise<void>;
}

interface SyncState {
  status: StatusSinkron;
  pesan: string | null;
  terakhirSinkron: string | null;
  tertunda: number;
  konflik: BarisKonflik[];
  progres: string | null;
  /** Aliran transfer yang sedang berjalan (untuk animasi). */
  aliran: 'HP_KE_DESKTOP' | 'DESKTOP_KE_HP' | null;
  /** Kemajuan transfer 0..1, bila diketahui. */
  persen: number | null;
  setAliran: (a: 'HP_KE_DESKTOP' | 'DESKTOP_KE_HP' | null) => void;
  setPersen: (p: number | null) => void;
  konfirmasi: PermintaanKonfirmasi | null;
  /** Desktop: ada HP yang baru saja menghubungi (untuk indikator sidebar). */
  hpTerakhirTerlihat: string | null;
  /** Naik setiap kali perubahan dari pasangan diterapkan (untuk memuat ulang tampilan). */
  versiData: number;
  /** Desktop: sidebar aplikasi sedang tampil (pengguna sudah di dalam aplikasi). */
  sidebarAktif: boolean;
  /**
   * RC-S133.5 — Desktop: layar penuh tanpa bingkai masuk (Portal Anggota).
   * Portal tampil di luar RootNavigator sehingga sidebarAktif tetap false.
   */
  layarPenuh: boolean;
  setLayarPenuh: (v: boolean) => void;
  /** Desktop: hasil percobaan terakhir lisensi otomatis dari HP. */
  lisensiOtomatis: { ok: boolean; pesan: string; waktu: string } | null;
  setLisensiOtomatis: (v: { ok: boolean; pesan: string; waktu: string } | null) => void;
  setSidebarAktif: (v: boolean) => void;
  naikkanVersiData: () => void;
  setStatus: (status: StatusSinkron, pesan?: string | null) => void;
  setKonflik: (k: BarisKonflik[]) => void;
  setProgres: (p: string | null) => void;
  setTertunda: (n: number) => void;
  setTerakhir: (t: string | null) => void;
  setKonfirmasi: (k: PermintaanKonfirmasi | null) => void;
  setHpTerlihat: (t: string | null) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  status: 'BELUM_DIPASANGKAN',
  pesan: null,
  terakhirSinkron: null,
  tertunda: 0,
  konflik: [],
  progres: null,
  aliran: null,
  persen: null,
  setAliran: (aliran) => set(aliran ? { aliran } : { aliran: null, persen: null }),
  setPersen: (persen) => set({ persen }),
  konfirmasi: null,
  hpTerakhirTerlihat: null,
  versiData: 0,
  sidebarAktif: false,
  layarPenuh: false,
  setLayarPenuh: (layarPenuh) => set({ layarPenuh }),
  lisensiOtomatis: null,
  setLisensiOtomatis: (lisensiOtomatis) => set({ lisensiOtomatis }),
  setSidebarAktif: (sidebarAktif) => set({ sidebarAktif }),
  naikkanVersiData: () => set((s) => ({ versiData: s.versiData + 1 })),
  setStatus: (status, pesan = null) => set({ status, pesan }),
  setKonflik: (konflik) => set({ konflik }),
  setProgres: (progres) => set({ progres }),
  setTertunda: (tertunda) => set({ tertunda }),
  setTerakhir: (terakhirSinkron) => set({ terakhirSinkron }),
  setKonfirmasi: (konfirmasi) => set({ konfirmasi }),
  setHpTerlihat: (hpTerakhirTerlihat) => set({ hpTerakhirTerlihat }),
}));
