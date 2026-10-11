import { create } from 'zustand';

export interface NotifyButton {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
}

export type NotifyType = 'success' | 'error' | 'warning' | 'info';

interface NotifyState {
  visible: boolean;
  type: NotifyType;
  title: string;
  message?: string;
  buttons: NotifyButton[];
  show: (title: string, message?: string, buttons?: NotifyButton[], type?: NotifyType) => void;
  hide: () => void;
}

/** Tebak jenis notifikasi dari judulnya, supaya pemanggilan lama gaya
 * `Alert.alert('Berhasil', ...)` / `Alert.alert('Gagal', ...)` otomatis
 * dapat warna & ikon yang sesuai tanpa perlu diubah satu-satu. */
function guessType(title: string): NotifyType {
  const t = title.toLowerCase();
  if (t.includes('gagal') || t.includes('error') || t.includes('salah') || t.includes('tidak cukup') || t.includes('tidak valid')) {
    return 'error';
  }
  if (t.includes('berhasil') || t.includes('sukses') || t.includes('selesai')) {
    return 'success';
  }
  if (t.includes('peringatan') || t.includes('perhatian') || t.includes('konfirmasi') || t.includes('yakin') || t.includes('hapus')) {
    return 'warning';
  }
  return 'info';
}

export const useNotifyStore = create<NotifyState>((set) => ({
  visible: false,
  type: 'info',
  title: '',
  message: undefined,
  buttons: [],
  show: (title, message, buttons, type) =>
    set({
      visible: true,
      title,
      message,
      buttons: buttons && buttons.length > 0 ? buttons : [{ text: 'OK', style: 'default' }],
      type: type ?? guessType(title),
    }),
  hide: () => set({ visible: false }),
}));

/**
 * Pengganti drop-in untuk `Alert.alert(title, message?, buttons?)` bawaan
 * React Native — signature sengaja dibuat identik supaya tinggal ganti
 * import di layar yang sudah ada, tapi tampilannya pop-up kustom yang
 * konsisten dengan desain aplikasi (ikon & warna sesuai jenis, rounded
 * card) alih-alih dialog native polos bawaan OS.
 */
export function notify(title: string, message?: string, buttons?: NotifyButton[], type?: NotifyType) {
  useNotifyStore.getState().show(title, message, buttons, type);
}
